import TelegramBot from 'node-telegram-bot-api';
import config from '../../config/config.js';
import { saveConfig } from '../../config/config.js';
import { getAllTools } from '../../tools/registry.js';
import logger from '../../utils/logger.js';

let bot = null;

// ── Emoji sets for random activity flair ──
const THINKING_EMOJI = ['🧠', '💭', '🤔', '⚙️', '🔮'];
const TOOL_EMOJI = {
  shell: '🖥️', filesystem: '📁', read_file: '📖', write_file: '✏️', list_directory: '📂',
  http: '🌐', http_request: '🌐', code: '💻', run_code: '💻', database: '🗃️',
  git: '🔀', browser: '🌍', screenshot: '📸', display_image: '🖼️',
  search_files: '🔍', delete_file: '🗑️',
};

function toolIcon(toolName) {
  for (const [key, icon] of Object.entries(TOOL_EMOJI)) {
    if (toolName.toLowerCase().includes(key)) return icon;
  }
  return '🔧';
}

function randomThink() {
  return THINKING_EMOJI[Math.floor(Math.random() * THINKING_EMOJI.length)];
}

/**
 * Initialize the Telegram bot.
 */
export function init(messageHandler) {
  const token = config.interfaces?.telegram?.botToken;

  if (!token) {
    logger.warn('Telegram bot token not configured. Telegram interface disabled.');
    return null;
  }

  try {
    bot = new TelegramBot(token, { polling: true });

    // ── /start ──────────────────────────────────────────
    bot.onText(/\/start/, (msg) => {
      const chatId = msg.chat.id;
      logger.info(`Telegram /start from chat ${chatId}`);
      bot.sendMessage(chatId,
        '🚗 *Welcome to Subaru!*\n\n' +
        'I\'m your local AI assistant agent. I can:\n\n' +
        '• 📁 Read and write files\n' +
        '• 🖥️ Execute shell commands\n' +
        '• 🌐 Make HTTP requests\n' +
        '• 💻 Run JavaScript code\n' +
        '• 🗃️ Query databases\n' +
        '• 🔀 Perform git operations\n' +
        '• 🌍 Browse the web and take screenshots\n' +
        '• 🖼️ Analyze images you send me\n' +
        '• 🎤 Understand voice messages\n\n' +
        'Send me text, a photo, or a voice message!\n\n' +
        '*Commands:*\n' +
        '/help — Full command list\n' +
        '/status — Show current status\n' +
        '/model — View or switch LLM model\n' +
        '/tools — List available tools\n' +
        '/clear — Clear conversation history',
        { parse_mode: 'Markdown' }
      );
    });

    // ── /help ───────────────────────────────────────────
    bot.onText(/\/help/, (msg) => {
      const chatId = msg.chat.id;
      logger.info(`Telegram /help from chat ${chatId}`);
      bot.sendMessage(chatId,
        '📖 <b>Subaru — Command Reference</b>\n\n' +
        '<b>General</b>\n' +
        '/start — Welcome message\n' +
        '/help — This help text\n' +
        '/status — System status &amp; config summary\n' +
        '/clear — Wipe conversation memory\n\n' +
        '<b>LLM</b>\n' +
        '/model — Current model info\n' +
        '/model <code>name</code> — Switch model (e.g. <code>/model gpt-4o</code>)\n\n' +
        '<b>Tools</b>\n' +
        '/tools — List all registered tools &amp; plugins\n\n' +
        '<b>Tips</b>\n' +
        '• Reply to any of my messages to add that context to your next prompt\n' +
        '• Send a photo with a caption to ask about it\n' +
        '• Send a voice note and I\'ll transcribe &amp; answer\n' +
        '• Files generated during tasks are sent back as documents',
        { parse_mode: 'HTML' }
      );
    });

    // ── /status ─────────────────────────────────────────
    bot.onText(/\/status/, (msg) => {
      const chatId = msg.chat.id;
      logger.info(`Telegram /status from chat ${chatId}`);

      const uptime = process.uptime();
      const hrs = Math.floor(uptime / 3600);
      const mins = Math.floor((uptime % 3600) / 60);
      const mem = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1);

      const statusText =
        `🚗 <b>Subaru Status</b>\n\n` +
        `<b>LLM:</b> ${config.llm?.provider || 'unknown'} / <code>${config.llm?.model || 'unknown'}</code>\n` +
        `<b>CLI:</b> ${config.interfaces?.cli?.enabled ? '✅' : '❌'}  ` +
        `<b>Web:</b> ${config.interfaces?.web?.enabled ? '✅ :' + (config.interfaces?.web?.port || 3131) : '❌'}  ` +
        `<b>Telegram:</b> ✅\n` +
        `<b>Uptime:</b> ${hrs}h ${mins}m\n` +
        `<b>Memory:</b> ${mem} MB\n` +
        `<b>Tools:</b> ${getAllTools().length} registered`;

      bot.sendMessage(chatId, statusText, { parse_mode: 'HTML' });
    });

    // ── /model [name] ───────────────────────────────────
    bot.onText(/\/model(?:\s+(.+))?/, (msg, match) => {
      const chatId = msg.chat.id;
      const newModel = match[1]?.trim();

      if (!newModel) {
        // Just show current model
        bot.sendMessage(chatId,
          `🤖 <b>Current model:</b> <code>${config.llm?.model || 'unknown'}</code>\n` +
          `<b>Provider:</b> ${config.llm?.provider || 'unknown'}\n\n` +
          `To switch: <code>/model model-name</code>`,
          { parse_mode: 'HTML' }
        );
        return;
      }

      const oldModel = config.llm?.model;
      try {
        saveConfig({ llm: { model: newModel } });
        // Update the live (frozen) config object's underlying data — we need to mutate
        // through the config module since config is frozen. The change is persisted to disk:
        // next restart will load it. For the current session, log a note.
        logger.info(`Telegram: model switch requested ${oldModel} → ${newModel}`);
        bot.sendMessage(chatId,
          `✅ Model updated: <code>${oldModel}</code> → <code>${newModel}</code>\n\n` +
          `<i>Note: active sessions keep the old model until restart.</i>`,
          { parse_mode: 'HTML' }
        );
      } catch (err) {
        bot.sendMessage(chatId, `❌ Failed to switch model: ${err.message}`);
      }
    });

    // ── /tools ──────────────────────────────────────────
    bot.onText(/\/tools/, (msg) => {
      const chatId = msg.chat.id;
      logger.info(`Telegram /tools from chat ${chatId}`);

      const tools = getAllTools();
      if (tools.length === 0) {
        bot.sendMessage(chatId, '🔧 No tools registered yet.');
        return;
      }

      const grouped = {};
      for (const t of tools) {
        const category = t.category || 'other';
        if (!grouped[category]) grouped[category] = [];
        grouped[category].push(t);
      }

      let text = `🧰 <b>Tools</b> (${tools.length} registered)\n\n`;
      for (const [cat, catTools] of Object.entries(grouped).sort()) {
        text += `<b>${cat.charAt(0).toUpperCase() + cat.slice(1)}</b>\n`;
        for (const t of catTools) {
          const icon = toolIcon(t.name);
          text += `  ${icon} <code>${t.name}</code>`;
          if (t.description) text += ` — ${t.description.substring(0, 60)}`;
          text += '\n';
        }
        text += '\n';
      }

      bot.sendMessage(chatId, text.trim(), { parse_mode: 'HTML' });
    });

    // ── /clear ──────────────────────────────────────────
    bot.onText(/\/clear/, (msg) => {
      const chatId = msg.chat.id;
      if (messageHandler && messageHandler.clearSession) {
        messageHandler.clearSession(`tg_${chatId}`);
      }
      bot.sendMessage(chatId, '🗑️ Conversation history cleared.');
      logger.info(`Telegram /clear from chat ${chatId}`);
    });

    // ── General messages (text / voice / photo) ─────────
    bot.on('message', (msg) => {
      // Skip commands already handled
      if (msg.text && msg.text.startsWith('/')) return;

      // Accept: text messages, voice/audio messages, photo messages, documents
      const hasContent = msg.text || msg.voice || msg.audio || msg.photo || msg.document;
      if (!hasContent) return;

      if (msg.text) {
        logger.debug(`Telegram text from ${msg.chat.id}: ${msg.text.substring(0, 100)}`);
      } else if (msg.voice || msg.audio) {
        logger.debug(`Telegram voice/audio from ${msg.chat.id}`);
      } else if (msg.photo) {
        logger.debug(`Telegram photo from ${msg.chat.id}${msg.caption ? ': ' + msg.caption.substring(0, 80) : ''}`);
      } else if (msg.document) {
        logger.debug(`Telegram document from ${msg.chat.id}: ${msg.document.file_name}`);
      }

      if (messageHandler && messageHandler.handleMessage) {
        messageHandler.handleMessage(msg).catch((err) => {
          logger.error(`Telegram handleMessage error: ${err.message}`);
          bot.sendMessage(msg.chat.id, `❌ An error occurred: ${err.message}`).catch(() => {});
        });
      }
    });

    // ── Callback queries (confirmations) ────────────────
    bot.on('callback_query', (query) => {
      const data = query.data;
      if (data && data.startsWith('confirm:')) {
        const parts = data.split(':');
        const confId = parts[1];
        const approved = parts[2] === 'yes';

        if (messageHandler && messageHandler.resolveConfirmation) {
          messageHandler.resolveConfirmation(confId, approved);
        }

        bot.answerCallbackQuery(query.id, {
          text: approved ? 'Approved ✅' : 'Denied ❌'
        }).catch(() => {});

        // Edit the message to reflect the decision
        const originalText = query.message?.text || '';
        const desc = originalText.replace('⚠️ Confirmation required:\n\n', '');
        bot.editMessageText(
          (approved ? '✅ Approved: ' : '❌ Denied: ') + desc,
          { chat_id: query.message.chat.id, message_id: query.message.message_id }
        ).catch(() => {});
      }
    });

    // Handle polling errors gracefully
    bot.on('polling_error', (err) => {
      logger.error(`Telegram polling error: ${err.message}`);
    });

    bot.on('error', (err) => {
      logger.error(`Telegram bot error: ${err.message}`);
    });

    logger.info('Telegram bot initialized in polling mode.');
    return bot;
  } catch (err) {
    logger.error(`Failed to initialize Telegram bot: ${err.message}`);
    return null;
  }
}

// ── Messaging helpers ─────────────────────────────────────

/**
 * Send a message to a chat.
 */
export function sendMessage(chatId, text, options = {}) {
  if (!bot) return;
  return bot.sendMessage(chatId, text, {
    parse_mode: 'HTML',
    ...options
  });
}

/**
 * Edit an existing message in-place.
 */
export function editMessage(chatId, messageId, text, options = {}) {
  if (!bot) return;
  return bot.editMessageText(text, {
    chat_id: chatId,
    message_id: messageId,
    parse_mode: 'HTML',
    ...options
  });
}

/**
 * Send a photo to a chat.
 */
export function sendPhoto(chatId, photoPath, options = {}) {
  if (!bot) return;
  return bot.sendPhoto(chatId, photoPath, {
    parse_mode: 'HTML',
    ...options
  });
}

/**
 * Send a document/file to a chat.
 */
export function sendDocument(chatId, filePath, options = {}) {
  if (!bot) return;
  return bot.sendDocument(chatId, filePath, {
    parse_mode: 'HTML',
    ...options
  });
}

/**
 * Send typing indicator.
 */
export function sendTyping(chatId) {
  if (!bot) return;
  return bot.sendChatAction(chatId, 'typing');
}

/**
 * Set a reaction emoji on a message (Telegram Bot API 7.x+).
 */
export function setReaction(chatId, messageId, emoji) {
  if (!bot) return;
  return bot.setMessageReaction(chatId, messageId, {
    reaction: [{ type: 'emoji', emoji }],
    is_big: false
  }).catch(() => {
    // Reactions may not be supported in all chats or bot API versions
    logger.debug(`Could not set reaction ${emoji} — possibly unsupported`);
  });
}

/**
 * Get the bot instance.
 */
export function getBot() {
  return bot;
}

/**
 * Download a file from Telegram by file_id.
 */
export async function downloadFile(fileId, destPath) {
  if (!bot) throw new Error('Bot not initialized');
  return bot.downloadFile(fileId, destPath);
}

/**
 * Get file info (including file_path for download).
 */
export async function getFileInfo(fileId) {
  if (!bot) throw new Error('Bot not initialized');
  return bot.getFile(fileId);
}

/**
 * Send a confirmation prompt with inline keyboard (approve/deny buttons).
 */
export function sendConfirmation(chatId, description, confirmationId) {
  if (!bot) return Promise.resolve();
  return bot.sendMessage(chatId, `⚠️ Confirmation required:\n\n${description}`, {
    reply_markup: {
      inline_keyboard: [[
        { text: '✅ Approve', callback_data: `confirm:${confirmationId}:yes` },
        { text: '❌ Deny', callback_data: `confirm:${confirmationId}:no` }
      ]]
    }
  });
}

/**
 * Stop the bot.
 */
export function stop() {
  if (bot) {
    bot.stopPolling();
    bot = null;
  }
}

export { toolIcon, randomThink };

export default {
  init, sendMessage, editMessage, sendPhoto, sendDocument,
  sendTyping, setReaction, sendConfirmation, getBot, downloadFile, getFileInfo, stop
};
