import { backup, DatabaseSync } from 'node:sqlite';
import { closeSync, existsSync, openSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { databasePath } from './store.js';

const source = databasePath();
const target = process.argv[2] && resolve(process.argv[2]);
if (!target || !existsSync(source)) {
  throw new Error('Укажи путь для новой копии. Исходная база должна существовать.');
}
const db = new DatabaseSync(source, { readOnly: true });
try {
  closeSync(openSync(target, 'wx'));
  try {
    await backup(db, target);
  } catch (error) {
    unlinkSync(target);
    throw error;
  }
  console.log('Копия сохранена: ' + target);
} finally {
  db.close();
}
