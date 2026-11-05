import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const databasePath = () => resolve(process.env.SELF_DB || 'data/self.sqlite');

const initial = {
  inbox: [], messages: [], tasks: [], proposals: [], memory: [], history: [],
  relations: [], windows: [], dismissed: [],
};

export function openStore(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path, { timeout: 5000 });
  try {
    db.exec('PRAGMA journal_mode = WAL');
    const { user_version: version } = db.prepare('PRAGMA user_version').get();
    if (version > 1) throw new Error('База создана более новой версией Self-Manager.');
    db.exec(
      'BEGIN IMMEDIATE; ' +
      'CREATE TABLE IF NOT EXISTS workspace (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL); ' +
      'PRAGMA user_version = 1; COMMIT;',
    );
    db.prepare('INSERT OR IGNORE INTO workspace VALUES (1, ?)').run(JSON.stringify(initial));
  } catch (error) {
    db.close();
    throw error;
  }
  const select = db.prepare('SELECT data FROM workspace WHERE id = 1');
  const update = db.prepare('UPDATE workspace SET data = ? WHERE id = 1');
  const read = () => JSON.parse(select.get().data);
  return {
    db, read,
    change(operation) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const data = read();
        const result = operation(data);
        update.run(JSON.stringify(data));
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  };
}
