import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import webPush from 'web-push';
import { openStore } from '../server/store.js';
import { createApp } from '../server/http.js';
import { createPush } from '../server/push.js';

const contact = 'mailto:test@example.org';
const subscription = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/test-only',
  keys: {
    p256dh: webPush.generateVAPIDKeys().publicKey,
    auth: Buffer.alloc(16).toString('base64url'),
  },
};

function setup(t, options = {}) {
  const store = openStore(':memory:');
  t.after(() => store.db.close());
  let time = Date.parse('2090-11-06T12:00:00.000Z');
  const config = { store, subject: contact, timeZone: 'Europe/Moscow', now: () => time, ...options };
  store.change((data) => {
    for (const id of ['intent-a', 'intent-b']) {
      data.inbox.push({ id, status: 'deferred', revisitAt: '2090-11-06T00:00:00.000Z', original: 'Личная мысль' });
    }
  });
  return { store, config, push: createPush(config), setTime: (value) => { time = Date.parse(value); } };
}

test('quiet hours, grouped delivery, persistent deduplication and idempotent registration', async (t) => {
  const sent = [];
  const { config, push, setTime } = setup(t, {
    send(device, payload, options) {
      sent.push({ device, payload, options });
    },
  });
  assert.deepEqual(push.subscription({ ...subscription, action: 'add' }), { subscribed: true });
  push.subscription({ ...subscription, action: 'add' });
  setTime('2090-11-06T00:30:00.000Z');
  await push.tick();
  assert.equal(sent.length, 0);
  setTime('2090-11-06T05:00:00.000Z');
  await Promise.all([push.tick(), push.tick()]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload, null);
  assert.equal(sent[0].options.topic, 'self-reminders');
  const request = webPush.generateRequestDetails(sent[0].device, sent[0].payload, sent[0].options);
  assert.equal(request.endpoint, subscription.endpoint);
  assert.equal(request.headers.Topic, 'self-reminders');

  const reopened = createPush(config);
  assert.equal(reopened.publicKey, push.publicKey);
  await reopened.tick();
  assert.equal(sent.length, 1);
  assert.deepEqual(reopened.subscription({ action: 'remove', endpoint: subscription.endpoint }), { subscribed: false });
  assert.deepEqual(reopened.subscription({ action: 'status', endpoint: subscription.endpoint }), { subscribed: false });
});

test('push retries temporary failures and removes expired endpoints', async (t) => {
  let calls = 0;
  const { push, setTime } = setup(t, {
    send() {
      calls++;
      throw Object.assign(new Error('Synthetic failure'), { statusCode: calls === 1 ? 503 : 410 });
    },
  });
  push.subscription({ ...subscription, action: 'add' });
  await push.tick();
  await push.tick();
  assert.equal(calls, 1);
  setTime('2090-11-06T12:01:00.000Z');
  await push.tick();
  assert.equal(calls, 2);
  assert.equal(push.subscription({ action: 'status', endpoint: subscription.endpoint }).subscribed, false);
});

test('risk of missing a fixed event raises push urgency without sending event details', async (t) => {
  const sent = [];
  const { store, push, setTime } = setup(t, { send: (...request) => sent.push(request) });
  store.change((data) => data.windows.push({
    id: 'window', title: 'Частное событие', start: '2090-11-06T12:20:00.000Z',
    journey: {
      prepareAt: '2090-11-06T11:40:00.000Z', leaveAt: '2090-11-06T11:50:00.000Z',
      lastSafeAt: '2090-11-06T12:00:00.000Z', bufferMinutes: 10,
    },
  }));
  setTime('2090-11-06T11:57:00.000Z');
  push.subscription({ ...subscription, action: 'add' });
  await push.tick();
  assert.equal(sent.length, 1);
  assert.equal(sent[0][1], null);
  assert.equal(sent[0][2].urgency, 'high');
});

test('API exposes only the public key and rejects push endpoints outside browser providers', async (t) => {
  const { store, push } = setup(t);
  const app = createApp({ store, push, timeZone: 'Europe/Moscow' });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  const base = 'http://127.0.0.1:' + app.address().port;
  try {
    const response = await fetch(base + '/api/state');
    const raw = await response.text();
    assert.equal(JSON.parse(raw).pushKey, push.publicKey);
    assert.ok(!raw.includes(store.read().push.keys.privateKey));
    const post = (body) => fetch(base + '/api/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const invalid = await post({ ...subscription, endpoint: 'https://fcm.googleapis.com.evil.example/push', action: 'add' });
    assert.equal(invalid.status, 400);
    assert.equal((await post({ ...subscription, action: 'add' })).status, 200);
    assert.ok(!(await (await fetch(base + '/api/state')).text()).includes(subscription.endpoint));
  } finally {
    app.close();
    await once(app, 'close');
  }
});
