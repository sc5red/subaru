import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as agent from '../../agent/agent.js';
import * as shortTerm from '../../memory/shortTerm.js';
import {
  sendMessage, sendPhoto, sendDocument, sendTyping, downloadFile,
  sendConfirmation, editMessage, setReaction, toolIcon, randomThink
} from './bot.js';
import { transcribe } from '../../llm/stt.js';
import logger from '../../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..', '..', '..');
const tmpDir = path.join(projectRoot, 'data', 'tmp');

// ── Max file size to send as document (10 MB) ──
const MAX_DOC_SIZE = 10 * 1024 * 1024;

// Document-worthy extensions
const DOC_EXTENSIONS = new Set([
  '.txt', '.json', '.csv', '.log', '.md', '.py', '.js', '.ts', '.html',
  '.css', '.xml', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.sh', '.bat',
  '.sql', '.rb', '.go', '.rs', '.java', '.c', '.cpp', '.h', '.hpp',
  '.env', '.dockerfile', '.gitignore', '.conf',
]);

// --- Telegram inline-keyboard confirmation system ---
const pendingConfirmations = new Map();

/**
 * Create a confirmation function scoped to a specific chat.
 * Sends an inline keyboard to the user and waits for their response.
 */
function createTelegramConfirmation(chatId) {
  return async (description) => {
    const confId = `tgconf_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        pendingConfirmations.delete(confId);
        logger.warn(`Telegram confirmation timed out (60s) for chat ${chatId}: ${description}`);
        resolve(false);
      }, 60000);

      pendingConfirmations.set(confId, {
        resolve: (approved) => {
          clearTimeout(timeout);
          pendingConfirmations.delete(confId);
          resolve(approved);
        },
        chatId
      });

      // Send the inline keyboard to the user
      sendConfirmation(chatId, description, confId).catch((err) => {
        logger.error(`Failed to send confirmation to Telegram: ${err.message}`);
        clearTimeout(timeout);
        pendingConfirmations.delete(confId);
        resolve(false);
      });
    });
  };
}

/**
 * Resolve a pending Telegram confirmation (called from bot.js callback_query handler).
 */
function resolveConfirmation(confId, approved) {
  const pending = pendingConfirmations.get(confId);
  if (!pending) return false;
  pending.resolve(approved);
  return true;
}

// Ensure tmp directory exists
if (!existsSync(tmpDir)) {
  mkdirSync(tmpDir, { recursive: true });
}

// ── Live activity message manager ───────────────────────
class ActivityMessage {
  constructor(chatId) {
    this.chatId = chatId;
    this.messageId = null;
    this.lines = [];
    this.phase = 'thinking'; // thinking | tool | done | error
    this.toolCount = 0;
    this.editQueue = Promise.resolve();
    this.lastEditText = '';
  }

  /** Send the initial "thinking" status message */
  async start() {
    const text = `${randomThink()} <i>Thinking…</i>`;
    try {
      const sent = await sendMessage(this.chatId, text);
      if (sent) this.messageId = sent.message_id;
      this.lastEditText = text;
    } catch { /* ignore */ }
  }

  /** Update the activity message with a new tool call line */
  addToolCall(toolName, input) {
    this.toolCount++;
    const icon = toolIcon(toolName);
    const shortInput = summariseInput(toolName, input);
    this.lines.push({ tool: toolName, icon, shortInput, status: 'running' });
    this._scheduleEdit();
  }

  /** Mark the last tool call as done */
  markToolDone(toolName, success) {
    const line = [...this.lines].reverse().find(l => l.tool === toolName && l.status === 'running');
    if (line) {
      line.status = success ? 'done' : 'failed';
      this._scheduleEdit();
    }
  }

  /** Finish the activity message */
  finish(success) {
    this.phase = success ? 'done' : 'error';
    this._scheduleEdit();
  }

  /** Remove the activity (delete the message) */
  async remove() {
    // Don't delete — just let it stay so user can see what happened
  }

  _scheduleEdit() {
    this.editQueue = this.editQueue.then(() => this._doEdit()).catch(() => {});
  }

  async _doEdit() {
    if (!this.messageId) return;

    let text = '';

    if (this.lines.length === 0) {
      text = `${randomThink()} <i>Thinking…</i>`;
    } else {
      const items = this.lines.map(l => {
        const statusIcon = l.status === 'running' ? '⏳' : l.status === 'done' ? '✅' : '❌';
        return `${l.icon} <code>${l.tool}</code>${l.shortInput ? ' — ' + l.shortInput : ''} ${statusIcon}`;
      });
      text = items.join('\n');
      if (this.phase === 'thinking' || this.lines.some(l => l.status === 'running')) {
        text += `\n\n${randomThink()} <i>Working…</i>`;
      }
    }

    if (this.phase === 'done') {
      text = this.lines.length > 0
        ? this.lines.map(l => {
            const statusIcon = l.status === 'done' ? '✅' : l.status === 'failed' ? '❌' : '⏳';
            return `${l.icon} <code>${l.tool}</code>${l.shortInput ? ' — ' + l.shortInput : ''} ${statusIcon}`;
          }).join('\n') + `\n\n✨ Done (${this.toolCount} tool${this.toolCount !== 1 ? 's' : ''} used)`
        : `✨ Done`;
    } else if (this.phase === 'error') {
      text += '\n\n❌ Error occurred';
    }

    // Avoid editing if text hasn't changed
    if (text === this.lastEditText) return;
    this.lastEditText = text;

    try {
      await editMessage(this.chatId, this.messageId, text);
    } catch {
      // Edit might fail if message is too old or identical — ignore
    }
  }
}

/** Summarise tool input for the activity line */
function summariseInput(toolName, input) {
  if (!input) return '';
  try {
    const parsed = typeof input === 'string' ? JSON.parse(input) : input;
    if (parsed.command) return escapeHtml(truncStr(parsed.command, 40));
    if (parsed.path) return escapeHtml(truncStr(parsed.path, 50));
    if (parsed.url) return escapeHtml(truncStr(parsed.url, 50));
    if (parsed.query) return escapeHtml(truncStr(parsed.query, 40));
    if (parsed.code) return escapeHtml(truncStr(parsed.code.split('\n')[0], 40));
    if (parsed.content) return escapeHtml(truncStr(parsed.content.split('\n')[0], 40));
  } catch { /* ignore */ }
  return '';
}

function truncStr(s, max) {
  if (!s) return '';
  return s.length > max ? s.substring(0, max) + '…' : s;
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Handle an incoming Telegram message (text, voice, or photo).
 */
async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const sessionId = `tg_${chatId}`;

  try {
    return await _handleMessageInner(msg, chatId, sessionId);
  } catch (err) {
    logger.error(`Telegram handler fatal error for chat ${chatId}: ${err.message}`);
    await sendMessage(chatId, `❌ Something went wrong: ${err.message}`).catch(() => {});
  }
}

async function _handleMessageInner(msg, chatId, sessionId) {
  // React with 👀 to acknowledge the message
  if (msg.message_id) {
    setReaction(chatId, msg.message_id, '👀');
  }

  // Send typing indicator
  try { await sendTyping(chatId); } catch { /* ignore */ }

  let text = '';
  let images = []; // base64 images for vision

  // ── Reply context ─────────────────────────────────────
  // If the user is replying to one of our messages, prepend that context
  let replyContext = '';
  if (msg.reply_to_message && msg.reply_to_message.text) {
    const quoted = msg.reply_to_message.text;
    replyContext = `[Replying to previous message: "${truncStr(quoted, 500)}"]\n\n`;
  }

  // --- Voice / Audio message ---
  if (msg.voice || msg.audio) {
    const fileId = msg.voice?.file_id || msg.audio?.file_id;
    try {
      logger.info(`Telegram: downloading voice message from ${chatId}`);
      let localPath = await downloadFile(fileId, tmpDir);
      logger.debug(`Voice file saved to: ${localPath}`);

      // Telegram saves voice as .oga — rename to .ogg for Whisper API compatibility
      const ext = path.extname(localPath).toLowerCase();
      if (ext === '.oga') {
        const newPath = localPath.replace(/\.oga$/i, '.ogg');
        renameSync(localPath, newPath);
        localPath = newPath;
      }

      text = await transcribe(localPath);
      logger.info(`Telegram: voice transcribed (${text.length} chars)`);

      // Let the user know what was heard
      await sendMessage(chatId, `🎤 <i>${markdownToTelegramHtml(text)}</i>`);
    } catch (err) {
      logger.error(`Telegram voice processing error: ${err.message}`);
      await sendMessage(chatId, `Sorry, I couldn't process that voice message: ${err.message}`);
      return;
    }
  }

  // --- Photo message ---
  else if (msg.photo && msg.photo.length > 0) {
    // Telegram sends multiple sizes — pick the largest
    const photo = msg.photo[msg.photo.length - 1];
    try {
      logger.info(`Telegram: downloading photo from ${chatId}`);
      const localPath = await downloadFile(photo.file_id, tmpDir);
      logger.debug(`Photo saved to: ${localPath}`);

      // Read and convert to base64
      const imageBuffer = readFileSync(localPath);
      const base64Image = imageBuffer.toString('base64');
      images.push(base64Image);

      text = msg.caption || 'What do you see in this image? Describe it in detail.';
      logger.info(`Telegram: photo received with caption: "${text.substring(0, 80)}"`);
    } catch (err) {
      logger.error(`Telegram photo processing error: ${err.message}`);
      await sendMessage(chatId, `Sorry, I couldn't process that image: ${err.message}`);
      return;
    }
  }

  // --- Document message ---
  else if (msg.document) {
    try {
      logger.info(`Telegram: downloading document ${msg.document.file_name} from ${chatId}`);
      const localPath = await downloadFile(msg.document.file_id, tmpDir);

      // Read document content for text-based files
      const ext = path.extname(msg.document.file_name || '').toLowerCase();
      if (DOC_EXTENSIONS.has(ext) || msg.document.mime_type?.startsWith('text/')) {
        const content = readFileSync(localPath, 'utf-8');
        text = (msg.caption || `Analyze this file (${msg.document.file_name})`) +
          `\n\n<file name="${msg.document.file_name}">\n${content}\n</file>`;
      } else {
        text = msg.caption || `I received a file: ${msg.document.file_name}. The file has been saved to ${localPath}.`;
      }
    } catch (err) {
      logger.error(`Telegram document processing error: ${err.message}`);
      await sendMessage(chatId, `Sorry, I couldn't process that file: ${err.message}`);
      return;
    }
  }

  // --- Text message ---
  else if (msg.text) {
    text = msg.text;
  }

  if (!text || text.trim() === '') return;

  // Prepend reply context
  if (replyContext) {
    text = replyContext + text;
  }

  logger.info(`Telegram handler: processing message from ${chatId}`);

  // ── Live activity message ─────────────────────────────
  const activity = new ActivityMessage(chatId);
  await activity.start();

  const emitter = new EventEmitter();
  let fullResponse = '';
  const imagesToSend = [];
  const docsToSend = [];

  // Collect events
  emitter.on('token', ({ content }) => {
    fullResponse += content;
  });

  emitter.on('tool_call', ({ tool, input }) => {
    activity.addToolCall(tool, input);
    sendTyping(chatId).catch(() => {});
  });

  emitter.on('tool_result', ({ tool, output, success }) => {
    activity.markToolDone(tool, success !== false);

    if (typeof output !== 'string') return;

    // 1. Explicit display_image tool — always send
    if (tool === 'display_image' && success !== false) {
      const match = output.match(/^__DISPLAY_IMAGE__:(.+?):(.*?)$/);
      if (match) {
        const imgPath = match[1];
        const caption = match[2] || '📸';
        if (existsSync(imgPath)) {
          imagesToSend.push({ path: imgPath, caption });
        }
      }
      return;
    }

    // 2. Auto-detect image file paths in any tool output
    const imgRegex = /(?:[A-Z]:\\|\/)(?:[^\s"'<>|]+[\\\/])*[^\s"'<>|]+\.(?:png|jpg|jpeg|gif|webp|bmp)/gi;
    let imgMatch;
    while ((imgMatch = imgRegex.exec(output)) !== null) {
      const p = imgMatch[0].trim();
      if (existsSync(p)) {
        imagesToSend.push({ path: p, caption: `📸 ${tool}` });
      }
    }

    // 3. Auto-detect document file paths to send
    const docRegex = /(?:[A-Z]:\\|\/)(?:[^\s"'<>|]+[\\\/])*[^\s"'<>|]+\.(?:txt|json|csv|log|md|py|js|ts|html|css|xml|yaml|yml|sql|sh|bat)/gi;
    let docMatch;
    while ((docMatch = docRegex.exec(output)) !== null) {
      const p = docMatch[0].trim();
      if (existsSync(p)) {
        try {
          const st = statSync(p);
          if (st.isFile() && st.size <= MAX_DOC_SIZE && st.size > 0) {
            docsToSend.push({ path: p, tool });
          }
        } catch { /* ignore */ }
      }
    }
  });

  emitter.on('error', ({ message: errMsg }) => {
    logger.error(`Telegram agent error event: ${errMsg}`);
  });

  // Keep sending typing indicators while processing
  const typingInterval = setInterval(() => {
    sendTyping(chatId).catch(() => {});
  }, 4000);

  // Create a per-chat confirmation function with inline keyboard support
  const confirmationFn = createTelegramConfirmation(chatId);

  let agentSuccess = true;
  try {
    await agent.run(text, sessionId, emitter, { confirmationFn, images: images.length > 0 ? images : undefined });
  } catch (err) {
    logger.error(`Telegram agent error: ${err.message}`);
    fullResponse = `Error: ${err.message}`;
    agentSuccess = false;
  }

  clearInterval(typingInterval);

  // Finalize the activity message and wait for all edits to flush
  activity.finish(agentSuccess);
  await activity.editQueue;

  // React to the original message with result
  if (msg.message_id) {
    setReaction(chatId, msg.message_id, agentSuccess ? '👍' : '👎');
  }

  // Send the LLM's natural language response (no tool JSON)
  const responseText = markdownToTelegramHtml(fullResponse);

  if (responseText.trim()) {
    await sendLongMessage(chatId, responseText.trim());
  } else if (imagesToSend.length === 0 && docsToSend.length === 0) {
    await sendMessage(chatId, '(No response generated)');
  }

  // Send collected images as photos
  for (const img of imagesToSend) {
    try {
      await sendPhoto(chatId, img.path, {
        caption: img.caption || '📸'
      });
      logger.info(`Sent image to Telegram: ${img.path}`);
    } catch (err) {
      logger.error(`Failed to send image to Telegram: ${err.message}`);
      await sendMessage(chatId, `(Image at ${img.path} couldn't be sent: ${err.message})`).catch(() => {});
    }
  }

  // Send collected documents as files
  const sentDocPaths = new Set();
  for (const doc of docsToSend) {
    if (sentDocPaths.has(doc.path)) continue; // de-dup
    sentDocPaths.add(doc.path);
    try {
      const basename = path.basename(doc.path);
      await sendDocument(chatId, doc.path, {
        caption: `📄 ${basename}`
      });
      logger.info(`Sent document to Telegram: ${doc.path}`);
    } catch (err) {
      logger.error(`Failed to send document to Telegram: ${err.message}`);
    }
  }
}

/**
 * Send a long message, splitting into chunks if needed.
 */
async function sendLongMessage(chatId, text) {
  const MAX_LEN = 4000;
  if (text.length <= MAX_LEN) {
    try {
      await sendMessage(chatId, text);
    } catch (err) {
      // If HTML parse fails, try plain text
      logger.warn(`Telegram HTML send failed, retrying as plain text: ${err.message}`);
      try {
        await sendMessage(chatId, stripHtml(text), { parse_mode: undefined });
      } catch (err2) {
        logger.error(`Telegram send failed: ${err2.message}`);
      }
    }
    return;
  }

  // Split into chunks
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= MAX_LEN) {
      chunks.push(remaining);
      break;
    }
    // Try to split at a newline
    let splitIdx = remaining.lastIndexOf('\n', MAX_LEN);
    if (splitIdx < MAX_LEN * 0.5) splitIdx = MAX_LEN;
    chunks.push(remaining.substring(0, splitIdx));
    remaining = remaining.substring(splitIdx);
  }

  for (const chunk of chunks) {
    try {
      await sendMessage(chatId, chunk);
    } catch (err) {
      try {
        await sendMessage(chatId, stripHtml(chunk), { parse_mode: undefined });
      } catch (err2) {
        logger.error(`Telegram chunk send failed: ${err2.message}`);
      }
    }
    // Small delay between chunks to avoid rate limits
    await new Promise(r => setTimeout(r, 500));
  }
}

/**
 * Convert common Markdown patterns in LLM output to Telegram-safe HTML.
 */
function markdownToTelegramHtml(text) {
  let out = text;

  // Escape HTML entities first
  out = out
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Code blocks: ```lang\n...\n``` → <pre>...</pre>
  out = out.replace(/```[\w]*\n([\s\S]*?)```/g, (_, code) => `<pre>${code.trim()}</pre>`);
  // Inline backtick code
  out = out.replace(/`([^`\n]+)`/g, '<code>$1</code>');

  // Headers: ## text → bold line
  out = out.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>');

  // Bold+italic: ***text*** or ___text___
  out = out.replace(/\*{3}(.+?)\*{3}/g, '<b><i>$1</i></b>');
  // Bold: **text** or __text__
  out = out.replace(/\*{2}(.+?)\*{2}/g, '<b>$1</b>');
  out = out.replace(/__(.+?)__/g, '<b>$1</b>');
  // Italic: *text* or _text_  (but not inside words like file_name)
  out = out.replace(/(?<!\w)\*([^*\n]+?)\*(?!\w)/g, '<i>$1</i>');
  out = out.replace(/(?<!\w)_([^_\n]+?)_(?!\w)/g, '<i>$1</i>');

  // Strikethrough: ~~text~~
  out = out.replace(/~~(.+?)~~/g, '<s>$1</s>');

  // Links: [text](url) → <a href="url">text</a>
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // Horizontal rules
  out = out.replace(/^[-*_]{3,}$/gm, '—');

  return out;
}

function stripHtml(str) {
  return str
    .replace(/<b>(.*?)<\/b>/g, '$1')
    .replace(/<i>(.*?)<\/i>/g, '$1')
    .replace(/<s>(.*?)<\/s>/g, '$1')
    .replace(/<code>(.*?)<\/code>/g, '$1')
    .replace(/<pre>([\s\S]*?)<\/pre>/g, '$1')
    .replace(/<a href="[^"]*">(.*?)<\/a>/g, '$1')
    .replace(/<[^>]+>/g, '');
}

/**
 * Clear a session's history.
 */
function clearSession(sessionId) {
  shortTerm.clearHistory(sessionId);
}

export default { handleMessage, clearSession, resolveConfirmation };
