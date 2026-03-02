/**
 * Short-term memory: in-session conversation context.
 * Stores message history per session in memory with optional SQLite persistence.
 */

import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..', '..');

const sessions = new Map();
let db = null;
let stmtInsert = null;
let stmtLoad = null;
let stmtDelete = null;
let stmtLoadSessions = null;

/**
 * Initialize persistence (optional — call at startup).
 * If not called, short-term memory is purely in-memory (backwards compatible).
 */
export function initPersistence(dbPath) {
  try {
    const resolvedPath = path.resolve(projectRoot, dbPath || './data/memory.db');
    const dir = path.dirname(resolvedPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    db = new Database(resolvedPath);
    db.pragma('journal_mode = WAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_conv_session ON conversation_history(session_id)`);

    stmtInsert = db.prepare('INSERT INTO conversation_history (session_id, message, created_at) VALUES (?, ?, ?)');
    stmtLoad = db.prepare('SELECT message FROM conversation_history WHERE session_id = ? ORDER BY id ASC');
    stmtDelete = db.prepare('DELETE FROM conversation_history WHERE session_id = ?');
    stmtLoadSessions = db.prepare('SELECT DISTINCT session_id FROM conversation_history');
  } catch (err) {
    // Persistence init failed — silently fall back to in-memory only
    db = null;
  }
}

function persistMessage(sessionId, msg) {
  if (!db || !stmtInsert) return;
  try {
    stmtInsert.run(sessionId, JSON.stringify(msg), Date.now());
  } catch { /* ignore persistence errors */ }
}

function loadFromDb(sessionId) {
  if (!db || !stmtLoad) return null;
  try {
    const rows = stmtLoad.all(sessionId);
    return rows.map(r => JSON.parse(r.message));
  } catch {
    return null;
  }
}

/**
 * Get the message history for a session.
 */
export function getHistory(sessionId) {
  if (sessions.has(sessionId)) {
    return sessions.get(sessionId);
  }
  // Try loading from persistence
  const persisted = loadFromDb(sessionId);
  if (persisted && persisted.length > 0) {
    sessions.set(sessionId, persisted);
    return persisted;
  }
  return [];
}

/**
 * Add a message to a session's history.
 */
export function addMessage(sessionId, role, content, maxMessages = 50) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, getHistory(sessionId));
  }
  const history = sessions.get(sessionId);
  const msg = { role, content, timestamp: Date.now() };
  history.push(msg);
  persistMessage(sessionId, msg);

  // Cap at maxMessages, drop oldest non-system messages
  while (history.length > maxMessages) {
    const idx = history.findIndex(m => m.role !== 'system');
    if (idx >= 0) {
      history.splice(idx, 1);
    } else {
      history.shift();
    }
  }
}

/**
 * Clear a session's history.
 */
export function clearHistory(sessionId) {
  sessions.delete(sessionId);
  if (db && stmtDelete) {
    try { stmtDelete.run(sessionId); } catch { /* ignore */ }
  }
}

/**
 * Get all active session IDs.
 */
export function getAllSessions() {
  const memSessions = Array.from(sessions.keys());
  if (db && stmtLoadSessions) {
    try {
      const dbSessions = stmtLoadSessions.all().map(r => r.session_id);
      const all = new Set([...memSessions, ...dbSessions]);
      return Array.from(all);
    } catch { /* ignore */ }
  }
  return memSessions;
}

/**
 * Add a tool result message to history (for agent loop).
 */
export function addToolResult(sessionId, toolCallId, toolName, content, maxMessages = 50) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, getHistory(sessionId));
  }
  const history = sessions.get(sessionId);
  const msg = {
    role: 'tool',
    tool_call_id: toolCallId,
    name: toolName,
    content: typeof content === 'string' ? content : JSON.stringify(content),
    timestamp: Date.now()
  };
  history.push(msg);
  persistMessage(sessionId, msg);

  while (history.length > maxMessages) {
    const idx = history.findIndex(m => m.role !== 'system');
    if (idx >= 0) {
      history.splice(idx, 1);
    } else {
      history.shift();
    }
  }
}

/**
 * Add an assistant message with tool calls.
 */
export function addAssistantToolCalls(sessionId, content, toolCalls, maxMessages = 50) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, getHistory(sessionId));
  }
  const history = sessions.get(sessionId);
  const msg = {
    role: 'assistant',
    content: content || '',
    timestamp: Date.now()
  };
  if (toolCalls && toolCalls.length > 0) {
    msg.tool_calls = toolCalls;
  }
  history.push(msg);
  persistMessage(sessionId, msg);

  while (history.length > maxMessages) {
    const idx = history.findIndex(m => m.role !== 'system');
    if (idx >= 0) {
      history.splice(idx, 1);
    } else {
      history.shift();
    }
  }
}

export default {
  initPersistence,
  getHistory,
  addMessage,
  clearHistory,
  getAllSessions,
  addToolResult,
  addAssistantToolCalls
};
