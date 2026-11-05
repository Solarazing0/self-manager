import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { backup } from 'node:sqlite';
import { test } from 'node:test';
import { createApp } from '../server/http.js';
import { openStore } from '../server/store.js';
import { reminders } from '../server/domain.js';
import { cloudLegion } from '../server/legion.js';

async function start(t, options = {}) {
  const store = openStore(options.path || ':memory:');
  const app = createApp({ store, respond: options.respond, timeZone: 'Europe/Moscow' });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  const base = 'http://127.0.0.1:' + app.address().port;
  t.after(async () => {
    app.close();
    await once(app, 'close');
    store.db.close();
  });
  async function request(path, data, expected = 200, extraHeaders) {
    const response = await fetch(base + path, data === undefined ? undefined : {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...extraHeaders },
      body: JSON.stringify(data),
    });
    const type = response.headers.get('content-type');
    const result = type.includes('json') ? await response.json() : await response.text();
    assert.equal(response.status, expected, JSON.stringify(result));
    return result.result ?? result;
  }
  return { request, store };
}

const at = (time) => '2090-11-06T' + time + ':00.000Z';
const slot = (start, end) => ({ start: at(start), end: at(end) });
const capture = (request, text) => request('/api/messages', { text, requestId: randomUUID() });
const draft = (target, time = {}) => ({ type: 'plan', target, title: 'Оплатить интернет', result: 'Платёж принят', ...time });

async function taskFrom(request, text = 'Оплатить интернет', time) {
  const user = await capture(request, text);
  const proposal = await request('/api/proposals', { ...draft(user.itemId, time), title: text });
  const accepted = await request('/api/decisions', { id: proposal.id, accepted: true });
  return accepted.taskId;
}

test('original capture, plan, confirmed recovery, execution and correction survive restart and backup', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'self-manager-'));
  try {
    const file = join(directory, 'live.sqlite');
    const copy = join(directory, 'copy.sqlite');
    const original = '  Завтра оплатить интернет  ';
    await t.test('work on original database', async (t) => {
      const { request, store } = await start(t, { path: file });
      const requestId = randomUUID();
      const user = await request('/api/messages', { requestId, text: original });
      assert.deepEqual(await request('/api/messages', { requestId, text: original }), user);
      assert.equal((await request('/api/state')).inbox[0].original, original);
      await request('/api/assist', { id: user.id }, 503);
      await request('/api/commitments', { title: 'Лекция', ...slot('08:30', '09:30') });
      await request('/api/proposals', draft(user.itemId, slot('09:00', '09:15')), 409);
      const plan = await request('/api/proposals', draft(user.itemId, slot('09:45', '10:00')));
      assert.equal((await request('/api/state')).tasks.length, 0);
      const accepted = await request('/api/decisions', { id: plan.id, accepted: true });
      const id = accepted.taskId;
      assert.deepEqual(await request('/api/decisions', { id: plan.id, accepted: true }), accepted);
      const move = await request('/api/proposals', { type: 'move', target: id, ...slot('10:30', '10:45') });
      assert.deepEqual((await request('/api/state')).tasks[0].slot, slot('09:45', '10:00'));
      await request('/api/decisions', { id: move.id, accepted: true });
      assert.deepEqual((await request('/api/state')).tasks[0].slot, slot('10:30', '10:45'));
      const before = store.read();
      assert.match(reminders(before, at('10:50'))[0].text, /уточни/i);
      assert.equal(before.tasks[0].status, 'ready');
      await request('/api/execution', { id, action: 'start', at: at('10:33') });
      await request('/api/execution', { id, action: 'result', status: 'partial', at: at('10:40'), outcome: 'Открыл личный кабинет' });
      await request('/api/execution', { id, action: 'correct', status: 'done', at: at('10:45'), outcome: 'Нашёл чек оплаты' });
      await backup(store.db, copy);
    });
    for (const path of [file, copy]) {
      await t.test('reopen ' + path, async (t) => {
        const { request } = await start(t, { path });
        const state = await request('/api/state');
        assert.equal(state.inbox[0].original, original);
        assert.equal(state.tasks[0].status, 'done');
        assert.equal(state.tasks[0].actualStart, at('10:33'));
        assert.equal(state.tasks[0].actualEnd, at('10:45'));
        assert.equal(state.history.find((entry) => entry.type === 'correct').before.status, 'partial');
      });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('long-term thought can wait and observation can become memory without tasks', async (t) => {
  const { request, store } = await start(t);
  const long = await capture(request, 'Когда-нибудь хочу создать ОС');
  await request('/api/intents', { id: long.itemId, action: 'defer', revisitAt: at('10:00') });
  const note = await capture(request, 'Я продуктивнее ночью');
  await request('/api/intents', { id: note.itemId, action: 'remember' });
  const state = await request('/api/state');
  assert.equal(state.inbox[0].status, 'deferred');
  assert.equal(state.inbox[1].status, 'memory');
  assert.equal(state.memory[0].text, 'Я продуктивнее ночью');
  assert.equal(state.tasks.length, 0);
  assert.equal(reminders(store.read(), at('10:01'))[0].itemId, long.itemId);
  await request('/api/memory', { id: state.memory[0].id, archive: true });
  await request('/api/intents', { id: long.itemId, action: 'reopen' });
  assert.equal((await request('/api/state')).inbox[0].status, 'new');
});

test('dependency cycles and schedule conflicts are enforced at the point of change', async (t) => {
  const { request } = await start(t);
  const first = await taskFrom(request, 'Первая задача', slot('08:00', '08:15'));
  const second = await taskFrom(request, 'Вторая задача', { due: at('09:30') });
  await request('/api/relations', { type: 'blocked_by', from: second, to: first });
  await request('/api/relations', { type: 'blocked_by', from: first, to: second }, 409);
  await request('/api/execution', { id: second, action: 'start' }, 409);
  await request('/api/commitments', { title: 'Лекция', ...slot('08:30', '09:00') });
  const suggested = await request('/api/suggestions', { target: second, minutes: 15, ...slot('08:45', '10:00') });
  assert.equal(suggested.payload.start, at('09:00'));
  assert.equal((await request('/api/state')).tasks[1].slot, null);
  await request('/api/commitments', { title: 'Сборы', ...slot('09:00', '09:20') });
  await request('/api/decisions', { id: suggested.id, accepted: true }, 409);
  await request('/api/suggestions', { target: second, minutes: 15, ...slot('08:45', '10:00') }, 409);
  await request('/api/execution', { id: first, action: 'result', status: 'done' });
  await request('/api/execution', { id: second, action: 'start' });
  assert.equal((await request('/api/state')).tasks[1].status, 'active');
});

test('a fixed event reserves preparation and travel and escalates before the last safe departure', async (t) => {
  const { request, store } = await start(t);
  const lecture = {
    title: 'Лекция', ...slot('09:00', '10:00'),
    preparationMinutes: 15, travelMinutes: 20, bufferMinutes: 10,
  };
  const event = await request('/api/commitments', lecture);
  assert.equal(event.journey.prepareAt, at('08:15'));
  assert.equal(event.journey.leaveAt, at('08:30'));
  assert.equal(event.journey.lastSafeAt, at('08:40'));
  const thought = await capture(request, 'Задача до лекции');
  await request('/api/proposals', draft(thought.itemId, slot('08:10', '08:20')), 409);
  const task = await taskFrom(request, 'Свободное дело');
  const suggested = await request('/api/suggestions', { target: task, minutes: 15, ...slot('08:05', '10:30') });
  assert.equal(suggested.payload.start, at('10:00'));

  const travel = (time) => reminders(store.read(), at(time)).filter((entry) => entry.windowId === event.id);
  assert.deepEqual(travel('08:14'), []);
  assert.match(travel('08:15')[0].text, /сборы/);
  assert.match(travel('08:30')[0].text, /выходить/);
  const risk = travel('08:35')[0];
  assert.equal(risk.urgency, 'high');
  assert.equal(risk.windowId, event.id);
  assert.match(travel('08:41')[0].text, /прошло/);
  assert.match(travel('09:05')[0].text, /уточни/i);
  assert.equal(store.read().windows[0].travelFact, null);

  await request('/api/travel', { id: event.id, version: event.version, status: 'departed', at: at('08:37') }, 400);
  const departed = await request('/api/travel', { id: event.id, version: event.version, status: 'departed' });
  assert.deepEqual(travel('08:39'), []);
  assert.match(travel('09:00')[0].text, /добраться/);
  await request('/api/commitments', { ...lecture, id: event.id, version: event.version }, 409);
  const arrived = await request('/api/travel', { id: event.id, version: departed.version, status: 'arrived' });
  assert.deepEqual(travel('09:05'), []);
  const renamed = await request('/api/commitments', { ...lecture, title: 'Семинар', id: event.id, version: arrived.version });
  assert.equal(renamed.travelFact.status, 'arrived');
  const rescheduled = await request('/api/commitments', { ...lecture, ...slot('11:00', '12:00'), id: event.id, version: renamed.version });
  assert.equal(rescheduled.travelFact, null);
  assert.equal(store.read().history.filter((entry) => entry.type === 'travel_fact').length, 2);
});

test('recovery leaves the goal and actual outcome intact and releases time only on acceptance', async (t) => {
  const { request, store } = await start(t);
  const item = await capture(request, 'Домашнее задание');
  const plan = await request('/api/proposals', {
    ...draft(item.itemId, slot('09:00', '09:45')), title: 'Домашнее задание', result: 'Решения отправлены', due: at('16:00'),
  });
  const { taskId: id } = await request('/api/decisions', { id: plan.id, accepted: true });
  await request('/api/execution', { id, action: 'start', at: at('09:00') });
  const simplify = {
    type: 'recover', target: id, strategy: 'simplify', nextAction: 'Проверить первый пример', reason: 'Устал',
  };
  await request('/api/proposals', simplify, 409);
  await request('/api/execution', { id, action: 'result', status: 'partial', at: at('09:20'), outcome: 'Прочитал условие' });
  const easier = await request('/api/proposals', simplify);
  assert.equal(store.read().tasks[0].recovery, undefined);
  await request('/api/decisions', { id: easier.id, accepted: true });
  assert.equal(store.read().tasks[0].recovery.nextAction, simplify.nextAction);
  assert.equal(store.read().tasks[0].result, 'Решения отправлены');
  const pause = {
    type: 'recover', target: id, strategy: 'pause', resumeAt: at('10:00'), reason: 'Нужен перерыв',
  };
  await request('/api/proposals', { ...pause, resumeAt: at('16:00') }, 400);
  const rejected = await request('/api/proposals', pause);
  await request('/api/decisions', { id: rejected.id, accepted: false });
  assert.deepEqual(store.read().tasks[0].slot, slot('09:00', '09:45'));
  const proposed = await request('/api/proposals', pause);
  assert.deepEqual(store.read().tasks[0].slot, slot('09:00', '09:45'));
  await request('/api/decisions', { id: proposed.id, accepted: true });
  const paused = store.read().tasks[0];
  assert.equal(paused.slot, null);
  assert.equal(paused.status, 'partial');
  assert.equal(paused.due, at('16:00'));
  assert.equal(paused.outcome, 'Прочитал условие');
  assert.deepEqual(proposed.payload.previous.slot, slot('09:00', '09:45'));
  assert.equal(reminders(store.read(), at('09:59')).length, 0);
  assert.match(reminders(store.read(), at('10:00'))[0].text, /пауза закончилась/i);
  const move = await request('/api/proposals', { type: 'move', target: id, ...slot('10:00', '10:30') });
  await request('/api/decisions', { id: move.id, accepted: true });
  assert.equal(store.read().tasks[0].recovery, null);
  assert.deepEqual(store.read().tasks[0].slot, slot('10:00', '10:30'));
});

test('cloud failure is retryable and a valid reply creates only a proposal', async (t) => {
  let calls = 0;
  const respond = cloudLegion({
    key: 'test-only',
    model: 'explicit-test-model',
    request: async (url, options) => {
      assert.equal(url, 'https://api.openai.com/v1/responses');
      const body = JSON.parse(options.body);
      assert.equal(body.model, 'explicit-test-model');
      assert.equal(body.store, false);
      assert.equal(body.text.format.strict, true);
      assert.equal(JSON.parse(body.input).original, 'Оплатить интернет');
      calls++;
      if (calls === 1) return { ok: false, status: 503 };
      return {
        ok: true, json: async () => ({
          status: 'completed',
          output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({
            reply: 'Предлагаю оплатить в свободное окно.',
            draft: { ...draft(null, slot('10:00', '10:15')), taskId: null, due: null, priority: 'normal', reason: 'Свободное окно', steps: [] },
          }) }] }],
        }),
      };
    },
  });
  const { request } = await start(t, { respond });
  const user = await capture(request, 'Оплатить интернет');
  await request('/api/assist', { id: user.id }, 502);
  const answer = await request('/api/assist', { id: user.id });
  assert.equal(answer.entry.role, 'legion');
  assert.ok(answer.entry.proposalId);
  assert.deepEqual((await request('/api/assist', { id: user.id })).entry, answer.entry);
  const state = await request('/api/state');
  assert.equal(state.messages.length, 2);
  assert.equal(state.proposals[0].status, 'pending');
  assert.equal(state.tasks.length, 0);
  assert.equal(calls, 2);
});

test('local HTTP serves the app and rejects cross-origin writes', async (t) => {
  const { request } = await start(t);
  assert.match(await request('/'), /Self — Сегодня/);
  assert.match(await request('/app.js'), /renderDay/);
  const manifest = await request('/manifest.webmanifest');
  assert.equal(manifest.display, 'standalone');
  await request('/api/messages', { requestId: randomUUID(), text: 'cross-origin' }, 403, { Origin: 'https://example.org' });
  assert.equal((await request('/api/state')).messages.length, 0);
});
