import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import logger from '../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..', '..');

let db = null;

/**
 * Initialize preferences database.
 */
export function init(dbPath) {
  const resolvedPath = path.resolve(projectRoot, dbPath || './data/memory.db');
  const dir = path.dirname(resolvedPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  db = new Database(resolvedPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS preferences (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at INTEGER
    )
  `);
  logger.info('Preferences database initialized.');
}

/**
 * Get a preference value by key.
 */
export function get(key) {
  if (!db) throw new Error('Preferences not initialized');
  const row = db.prepare('SELECT value FROM preferences WHERE key = ?').get(key);
  if (!row) return undefined;
  try {
    return JSON.parse(row.value);
  } catch {
    return row.value;
  }
}

/**
 * Set a preference value.
 */
export function set(key, value) {
  if (!db) throw new Error('Preferences not initialized');
  const serialized = JSON.stringify(value);
  db.prepare('INSERT OR REPLACE INTO preferences (key, value, updated_at) VALUES (?, ?, ?)').run(
    key,
    serialized,
    Date.now()
  );
}

/**
 * Get all preferences.
 */
export function getAll() {
  if (!db) throw new Error('Preferences not initialized');
  const rows = db.prepare('SELECT key, value, updated_at FROM preferences').all();
  const result = {};
  for (const row of rows) {
    try {
      result[row.key] = JSON.parse(row.value);
    } catch {
      result[row.key] = row.value;
    }
  }
  return result;
}

/**
 * Delete a preference by key.
 */
export function del(key) {
  if (!db) throw new Error('Preferences not initialized');
  db.prepare('DELETE FROM preferences WHERE key = ?').run(key);
}

/**
 * Get the underlying database instance (shared with database tool).
 */
export function getDb() {
  return db;
}

export default { init, get, set, getAll, del: del, getDb };
