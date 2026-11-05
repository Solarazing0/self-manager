import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import {
  InputError, capture, changeIntent, propose, decide, addWindow, removeWindow,
  recordExecution, reviseMemory, addRelation, removeRelation, reminders, dismiss, suggestSlot,
  duplicateCandidates, mergeTasks, undoMerge,
} from './domain.js';
import { createAssistant } from './legion.js';

const files = new Map([
  ['/', ['../app/index.html', 'text/html']],
  ['/app.js', ['../app/app.js', 'text/javascript']],
  ['/styles.css', ['../prototype/styles.css', 'text/css']],
  ['/app.css', ['../app/app.css', 'text/css']],
  ['/manifest.webmanifest', ['../app/manifest.webmanifest', 'application/manifest+json']],
  ['/sw.js', ['../app/sw.js', 'text/javascript']],
  ['/icon.svg', ['../app/icon.svg', 'image/svg+xml']],
  ['/icon-192.png', ['../app/icon-192.png', 'image/png']],
  ['/icon-512.png', ['../app/icon-512.png', 'image/png']],
]);

const routes = new Map([
  ['/api/messages', capture],
  ['/api/intents', (data, body) => changeIntent(data, body.id, body)],
  ['/api/proposals', propose],
  ['/api/suggestions', suggestSlot],
  ['/api/decisions', (data, body) => decide(data, body.id, body.accepted)],
  ['/api/execution', (data, body) => recordExecution(data, body.id, body)],
  ['/api/commitments', (data, body) => body.remove ? removeWindow(data, body.id) : addWindow(data, body)],
  ['/api/memory', (data, body) => reviseMemory(data, body.id, body)],
  ['/api/relations', (data, body) => body.remove ? removeRelation(data, body.id) : addRelation(data, body)],
  ['/api/merge', (data, body) => body.undo ? undoMerge(data, body.id) : mergeTasks(data, body)],
  ['/api/reminders', (data, body) => dismiss(data, body.id)],
]);

function json(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(data));
}

async function readBody(request) {
  if (request.headers['content-type']?.split(';')[0] !== 'application/json') {
    throw new InputError('Ожидался JSON.', 415);
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > 65_536) {
      request.resume();
      throw new InputError('Запрос слишком большой.', 413);
    }
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || Array.isArray(body) || typeof body !== 'object') throw new Error();
    return body;
  } catch {
    throw new InputError('Некорректный JSON.');
  }
}

export function createApp({ store, respond = null, timeZone, publicOrigin = '', push = null }) {
  const assist = createAssistant(store, respond, timeZone);
  const external = publicOrigin ? new URL(publicOrigin) : null;
  if (external && (external.protocol !== 'https:' || publicOrigin !== external.origin)) {
    throw new Error('SELF_PUBLIC_ORIGIN должен содержать только HTTPS origin.');
  }
  return createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      const port = request.socket.localPort;
      const hosts = ['localhost:' + port, '127.0.0.1:' + port, '[::1]:' + port, external?.host].filter(Boolean);
      if (!hosts.includes(request.headers.host)) throw new InputError('Недопустимый адрес приложения.', 403);
      const path = new URL(request.url, 'http://localhost').pathname;
      if (request.method === 'GET' && files.has(path)) {
        const [file, mime] = files.get(path);
        const content = await readFile(new URL(file, import.meta.url));
        response.writeHead(200, { 'Content-Type': mime + (mime.startsWith('text/') ? '; charset=utf-8' : '') });
        response.end(content);
        return;
      }
      if (request.method === 'GET' && path === '/api/state') {
        const { dismissed, push: privatePush, ...state } = store.read();
        return json(response, 200, {
          ...state, reminders: reminders({ ...state, dismissed }), duplicates: duplicateCandidates(state),
          cloud: Boolean(respond), timeZone, pushKey: push?.publicKey,
        });
      }
      if (request.method === 'POST' && (routes.has(path) || path === '/api/assist' || path === '/api/push')) {
        const origin = request.headers.origin;
        const allowed = hosts.slice(0, 3).map((host) => 'http://' + host);
        if (external) allowed.push(external.origin);
        if (request.headers['sec-fetch-site'] === 'cross-site' || (origin && !allowed.includes(origin))) {
          throw new InputError('Запрос пришёл с другого сайта.', 403);
        }
        const body = await readBody(request);
        if (path === '/api/push') {
          if (!push) throw new InputError('Фоновые уведомления недоступны.', 503);
          return json(response, 200, { result: push.subscription(body) });
        }
        const result = path === '/api/assist' ? await assist(body.id) : store.change((data) => routes.get(path)(data, body));
        return json(response, 200, { result });
      }
      json(response, 404, { error: 'Страница не найдена.' });
    } catch (error) {
      if (error instanceof InputError) return json(response, error.status, { error: error.message });
      console.error(error);
      json(response, 500, { error: 'Не удалось выполнить операцию.' });
    }
  });
}
