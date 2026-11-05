import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { openStore } from '../server/store.js';
import {
  capture, propose, decide, addRelation, duplicateCandidates, mergeTasks, undoMerge, recordExecution, reminders,
} from '../server/domain.js';

function workspace(t) {
  const store = openStore(':memory:');
  t.after(() => store.db.close());
  return store;
}

function task(data, title, result, steps = []) {
  const user = capture(data, { text: title, requestId: randomUUID() });
  const draft = propose(data, { type: 'plan', target: user.itemId, title, result, steps });
  return decide(data, draft.id, true).taskId;
}

test('a new step requires consent and the project closes with its own outcome', (t) => {
  const store = workspace(t);
  const parent = store.change((data) => task(data, 'ОС', 'Запустилась в эмуляторе', [
    { title: 'Настроить эмулятор', result: 'Стартует тестовый образ' },
  ]));
  const step = store.change((data) => propose(data, {
    type: 'step', target: parent, title: 'Написать загрузчик', result: 'Появился вывод',
  }));
  assert.equal(store.read().tasks.length, 2);
  const approved = store.change((data) => decide(data, step.id, true));
  assert.equal(store.read().relations.filter((edge) => edge.to === parent).length, 2);
  assert.throws(() => store.change((data) => addRelation(data, {
    type: 'blocked_by', from: approved.taskId, to: parent,
  })), /цикл/);
  assert.throws(() => store.change((data) => recordExecution(data, parent, {
    action: 'result', status: 'done', outcome: 'Готово',
  })), /оставшихся шагов/);
  store.change((data) => {
    for (const edge of data.relations) recordExecution(data, edge.from, { action: 'result', status: 'done' });
  });
  assert.throws(() => store.change((data) => recordExecution(data, parent, { action: 'result', status: 'done' })), /Итог проекта/);
  store.change((data) => recordExecution(data, parent, { action: 'result', status: 'done', outcome: 'Проверил запуск ОС' }));
  assert.equal(store.read().tasks.find((entry) => entry.id === parent).status, 'done');
});

test('equivalent work retains both parent links and merge restores exact originals', (t) => {
  const store = workspace(t);
  const ids = store.change((data) => {
    const a = task(data, 'Учёба', 'Закрыть курс');
    const b = task(data, 'ОС', 'Получить рабочий образ');
    const first = task(data, 'Установить QEMU', 'Эмулятор запускается');
    const second = task(data, 'Установить QEMU', 'Эмулятор запускается');
    task(data, 'Установить QEMU', 'Настроена сборка');
    addRelation(data, { type: 'part_of', from: first, to: a });
    addRelation(data, { type: 'part_of', from: second, to: b });
    return { from: second, to: first };
  });
  const before = store.read();
  assert.deepEqual(duplicateCandidates(before), [ids]);
  store.change((data) => mergeTasks(data, ids));
  const merged = store.read();
  assert.equal(merged.tasks.find((entry) => entry.id === ids.from).status, 'merged');
  assert.equal(merged.relations.filter((edge) => edge.from === ids.to).length, 2);
  assert.deepEqual(merged.inbox, before.inbox);
  store.change((data) => undoMerge(data, ids.from));
  assert.deepEqual(store.read().relations, before.relations);
  assert.deepEqual(store.read().tasks, before.tasks);
});

test('an old intention is surfaced without changing or completing it', (t) => {
  const store = workspace(t);
  store.change((data) => capture(data, { text: 'Идея на потом', requestId: randomUUID() }));
  const data = store.read();
  assert.equal(reminders(data, '2090-11-06T09:00:00.000Z').length, 1);
  assert.equal(data.inbox[0].status, 'new');
  assert.equal(data.tasks.length, 0);
});
