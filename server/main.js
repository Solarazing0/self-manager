import { databasePath, openStore } from './store.js';
import { cloudLegion } from './legion.js';
import { createApp } from './http.js';

const port = Number(process.env.SELF_PORT || '4317');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Некорректный SELF_PORT.');
const timeZone = process.env.SELF_TIME_ZONE || 'Europe/Moscow';
new Intl.DateTimeFormat('ru-RU', { timeZone });
const store = openStore(databasePath());
const respond = cloudLegion({ key: process.env.OPENAI_API_KEY, model: process.env.LEGION_MODEL });
const app = createApp({ store, respond, timeZone, publicOrigin: process.env.SELF_PUBLIC_ORIGIN });
app.listen(port, '127.0.0.1', () => console.log('Self-Manager: http://127.0.0.1:' + port));
app.on('close', () => store.db.close());
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => app.close());
