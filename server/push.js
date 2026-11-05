import { randomUUID } from 'node:crypto';
import webPush from 'web-push';
import { InputError, reminders } from './domain.js';

const intervalMs = 15_000;
const quietDefault = '22:00-08:00';
const retryMs = [60_000, 300_000];

function endpointFor(value) {
  if (typeof value !== 'string' || value.length > 2048) throw new InputError('Некорректный адрес уведомлений.');
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new InputError('Некорректный адрес уведомлений.');
  }
  const host = url.hostname;
  const provider = ['fcm.googleapis.com', 'android.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com']
    .includes(host) || host.endsWith('.push.apple.com') || host.endsWith('.notify.windows.com');
  if (!provider || url.protocol !== 'https:' || url.port || url.username || url.password || url.hash) {
    throw new InputError('Этот сервис уведомлений пока не поддерживается.');
  }
  return url.href;
}

function subscriptionFor(body, endpoint) {
  const { p256dh, auth } = body.keys ?? {};
  const key = typeof p256dh === 'string' && /^[\w-]{87}$/.test(p256dh) && Buffer.from(p256dh, 'base64url');
  if (!key || key.length !== 65 || key[0] !== 4 || typeof auth !== 'string' || !/^[\w-]{22}$/.test(auth)) {
    throw new InputError('У браузера некорректные ключи уведомлений.');
  }
  return { endpoint, keys: { p256dh, auth } };
}

function quietCheck(zone, hours) {
  const pattern = /^(?:[01]\d|2[0-3]):[0-5]\d-(?:[01]\d|2[0-3]):[0-5]\d$/;
  if (hours === 'off') return () => false;
  if (!pattern.test(hours)) throw new Error('SELF_QUIET_HOURS: ожидается HH:MM-HH:MM или off.');
  const [from, until] = hours.split('-');
  if (from === until) throw new Error('Время начала и окончания тихих часов должно различаться.');
  const local = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return (now) => {
    const time = local.format(now);
    return from < until ? time >= from && time < until : time >= from || time < until;
  };
}

function dueDeliveries(device, current, now) {
  return current.filter(({ id }) => {
    const delivery = device.deliveries[id];
    return !delivery || (!delivery.done && delivery.next <= now);
  });
}

export function createPush({
  store, timeZone, quietHours = quietDefault, subject,
  send = webPush.sendNotification, keys = webPush.generateVAPIDKeys, now = Date.now,
}) {
  const quiet = quietCheck(timeZone, quietHours);
  const existingKeys = store.read().push?.keys;
  const vapid = existingKeys ?? store.change((data) => {
    data.push ??= { keys: keys(), devices: [] };
    return data.push.keys;
  });
  const options = { TTL: 90, timeout: 8000, vapidDetails: { ...vapid, subject } };

  function subscription(body) {
    const endpoint = endpointFor(body.endpoint);
    if (body.action === 'status') {
      return { subscribed: store.read().push.devices.some((device) => device.subscription.endpoint === endpoint) };
    }
    return store.change((data) => {
      const devices = data.push.devices;
      const index = devices.findIndex((device) => device.subscription.endpoint === endpoint);
      if (body.action === 'remove') {
        if (index !== -1) devices.splice(index, 1);
        return { subscribed: false };
      }
      if (body.action !== 'add') throw new InputError('Неизвестное действие для уведомлений.');
      const registered = subscriptionFor(body, endpoint);
      if (index === -1) {
        if (devices.length >= 20) throw new InputError('Достигнут предел подключённых устройств.', 409);
        devices.push({ id: randomUUID(), subscription: registered, deliveries: {} });
      } else if (JSON.stringify(devices[index].subscription) !== JSON.stringify(registered)) {
        devices[index] = { id: randomUUID(), subscription: registered, deliveries: devices[index].deliveries };
      }
      return { subscribed: true };
    });
  }

  function claim() {
    const time = now();
    if (quiet(time)) return [];
    const snapshot = store.read();
    const current = reminders(snapshot, new Date(time).toISOString());
    if (!snapshot.push.devices.some((device) => dueDeliveries(device, current, time).length)) return [];
    return store.change((data) => {
      const latest = reminders(data, new Date(time).toISOString());
      const active = new Set(latest.map((item) => item.id));
      const jobs = [];
      for (const device of data.push.devices) {
        for (const key of Object.keys(device.deliveries)) {
          if (!active.has(key)) delete device.deliveries[key];
        }
        const items = dueDeliveries(device, latest, time);
        if (!items.length) continue;
        const claimId = randomUUID();
        for (const item of items) {
          const attempt = (device.deliveries[item.id]?.attempt ?? 0) + 1;
          device.deliveries[item.id] = { attempt, next: time + 30_000, claimId };
        }
        jobs.push({ deviceId: device.id, subscription: device.subscription, reminderIds: items.map((item) => item.id), claimId });
      }
      return jobs;
    });
  }

  async function deliver(job) {
    let status = 200;
    try {
      await send(job.subscription, null, { ...options, topic: 'self-reminders' });
    } catch (error) {
      status = error?.statusCode ?? 0;
    }
    store.change((data) => {
      const devices = data.push.devices;
      const index = devices.findIndex((device) => device.id === job.deviceId);
      if (index === -1) return;
      if (status === 404 || status === 410) {
        devices.splice(index, 1);
        return;
      }
      for (const id of job.reminderIds) {
        const delivery = devices[index].deliveries[id];
        if (delivery?.claimId !== job.claimId) continue;
        const backoff = retryMs[delivery.attempt - 1];
        const retry = backoff && (status === 0 || status === 429 || status >= 500);
        devices[index].deliveries[id] = retry ? { attempt: delivery.attempt, next: now() + backoff } : { done: true };
      }
    });
  }

  let running;
  let timer;
  function tick() {
    running ??= Promise.resolve().then(() => Promise.allSettled(claim().map(deliver)))
      .then((results) => {
        const error = results.find((result) => result.status === 'rejected');
        if (error) throw error.reason;
      }).finally(() => { running = undefined; });
    return running;
  }

  return {
    publicKey: vapid.publicKey,
    subscription, tick,
    start() {
      timer ??= setInterval(() => {
        tick().catch((error) => console.error('Ошибка очереди уведомлений:', error.name));
      }, intervalMs);
      timer.unref();
    },
    async stop() {
      clearInterval(timer);
      timer = undefined;
      await running?.catch(() => {});
    },
  };
}
