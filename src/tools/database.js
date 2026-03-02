import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import logger from '../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..', '..');

let db = null;

function getDb(context) {
  if (db) return db;
  const dbPath = path.resolve(projectRoot, context.config?.tools?.database?.path || './data/memory.db');
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  return db;
}

const tools = [
  {
    name: 'db_query',
    description: 'Execute a parameterized SQL SELECT query against the SQLite database. Returns results as a JSON array.',
    parameters: {
      type: 'object',
      properties: {
        sql: { type: 'string', description: 'SQL query to execute (SELECT only)' },
        params: { type: 'array', description: 'Query parameters for prepared statement', items: {} }
      },
      required: ['sql']
    },
    async execute(input, context) {
      const { sql, params = [] } = input;

      // Only allow SELECT statements
      const trimmed = sql.trim().toUpperCase();
      if (!trimmed.startsWith('SELECT') && !trimmed.startsWith('PRAGMA') && !trimmed.startsWith('EXPLAIN')) {
        return { success: false, output: '', error: 'Only SELECT, PRAGMA, and EXPLAIN queries are allowed with db_query. Use db_execute for write operations.' };
      }

      try {
        const database = getDb(context);
        const rows = database.prepare(sql).all(...params);
        return { success: true, output: JSON.stringify(rows, null, 2) };
      } catch (err) {
        return { success: false, output: '', error: err.message };
      }
    }
  },
  {
    name: 'db_execute',
    description: 'Execute an INSERT, UPDATE, DELETE, or CREATE SQL statement against the SQLite database. Returns the number of affected rows.',
    parameters: {
      type: 'object',
      properties: {
        sql: { type: 'string', description: 'SQL statement to execute (INSERT/UPDATE/DELETE/CREATE)' },
        params: { type: 'array', description: 'Statement parameters for prepared statement', items: {} }
      },
      required: ['sql']
    },
    async execute(input, context) {
      const { sql, params = [] } = input;

      try {
        const database = getDb(context);
        const result = database.prepare(sql).run(...params);
        return {
          success: true,
          output: JSON.stringify({
            changes: result.changes,
            lastInsertRowid: result.lastInsertRowid?.toString()
          }, null, 2)
        };
      } catch (err) {
        return { success: false, output: '', error: err.message };
      }
    }
  },
  {
    name: 'db_schema',
    description: 'Return the current database schema (table names and column definitions).',
    parameters: {
      type: 'object',
      properties: {},
      required: []
    },
    async execute(input, context) {
      try {
        const database = getDb(context);
        const tables = database.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();

        const schema = {};
        for (const table of tables) {
          const columns = database.prepare(`PRAGMA table_info("${table.name}")`).all();
          schema[table.name] = columns.map(col => ({
            name: col.name,
            type: col.type,
            nullable: !col.notnull,
            default: col.dflt_value,
            primaryKey: !!col.pk
          }));
        }

        return { success: true, output: JSON.stringify(schema, null, 2) };
      } catch (err) {
        return { success: false, output: '', error: err.message };
      }
    }
  }
];

export default tools;
