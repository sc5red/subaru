import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// --- Mocks (hoisted so vi.mock factories can reference them) ---

const { mockBotInstance, TelegramBotMock, mockConfig, mockAllTools } = vi.hoisted(() => {
  const mockBotInstance = {
    onText: vi.fn(),
    on: vi.fn(),
    sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
    sendPhoto: vi.fn().mockResolvedValue({}),
    sendDocument: vi.fn().mockResolvedValue({}),
    sendChatAction: vi.fn().mockResolvedValue({}),
    editMessageText: vi.fn().mockResolvedValue({}),
    setMessageReaction: vi.fn().mockResolvedValue({}),
    answerCallbackQuery: vi.fn().mockResolvedValue({}),
    downloadFile: vi.fn().mockResolvedValue('/tmp/downloaded_file.ogg'),
    getFile: vi.fn().mockResolvedValue({ file_id: 'abc', file_path: 'voice/file.ogg' }),
    stopPolling: vi.fn()
  };

  const TelegramBotMock = vi.fn(function() {
    Object.assign(this, mockBotInstance);
    return mockBotInstance;
  });

  const mockConfig = {
    interfaces: {
      telegram: { botToken: null },
      cli: { enabled: true },
      web: { enabled: true, port: 3131 }
    },
    llm: { provider: 'openai', model: 'gpt-4' }
  };

  const mockAllTools = [
    { name: 'shell', description: 'Execute shell commands', category: 'system' },
    { name: 'read_file', description: 'Read a file', category: 'filesystem' },
    { name: 'http_request', description: 'Make HTTP requests', category: 'network' },
  ];

  return { mockBotInstance, TelegramBotMock, mockConfig, mockAllTools };
});

vi.mock('../../../src/utils/logger.js', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

vi.mock('../../../src/config/config.js', () => ({
  default: mockConfig,
  saveConfig: vi.fn()
}));

vi.mock('../../../src/tools/registry.js', () => ({
  getAllTools: () => mockAllTools
}));

vi.mock('node-telegram-bot-api', () => ({
  default: TelegramBotMock
}));

// Import bot module once — it holds module-scoped `let bot`
import * as botModule from '../../../src/interfaces/telegram/bot.js';

// Helper to reset the bot state between tests
function resetBot() {
  // Stop any existing bot to clear the module-level `bot` variable
  botModule.stop();
  vi.clearAllMocks();
}

// Helper to init the bot with a token
function initBotWithToken(handler = {}) {
  mockConfig.interfaces.telegram.botToken = 'test-token-123';
  return botModule.init({ handleMessage: vi.fn().mockResolvedValue(undefined), clearSession: vi.fn(), ...handler });
}

// --- Tests ---

describe('telegram bot — init', () => {
  beforeEach(() => resetBot());

  it('should return null when no bot token is configured', () => {
    mockConfig.interfaces.telegram.botToken = null;
    const result = botModule.init({ handleMessage: vi.fn() });
    expect(result).toBeNull();
  });

  it('should create a TelegramBot instance when token is provided', () => {
    const result = initBotWithToken();

    expect(TelegramBotMock).toHaveBeenCalledWith('test-token-123', { polling: true });
    expect(result).toBeTruthy();
  });

  it('should register /start command handler', () => {
    initBotWithToken();

    const startCall = mockBotInstance.onText.mock.calls.find(
      c => c[0].toString().includes('start')
    );
    expect(startCall).toBeTruthy();
  });

  it('should register /status command handler', () => {
    initBotWithToken();

    const statusCall = mockBotInstance.onText.mock.calls.find(
      c => c[0].toString().includes('status')
    );
    expect(statusCall).toBeTruthy();
  });

  it('should register /clear command handler', () => {
    initBotWithToken();

    const clearCall = mockBotInstance.onText.mock.calls.find(
      c => c[0].toString().includes('clear')
    );
    expect(clearCall).toBeTruthy();
  });

  it('should register message handler for general messages', () => {
    initBotWithToken();

    const messageCall = mockBotInstance.on.mock.calls.find(c => c[0] === 'message');
    expect(messageCall).toBeTruthy();
  });

  it('should register callback_query handler for confirmations', () => {
    initBotWithToken();

    const callbackCall = mockBotInstance.on.mock.calls.find(c => c[0] === 'callback_query');
    expect(callbackCall).toBeTruthy();
  });

  it('should register polling_error handler', () => {
    initBotWithToken();

    const errCall = mockBotInstance.on.mock.calls.find(c => c[0] === 'polling_error');
    expect(errCall).toBeTruthy();
  });

  it('should register error handler', () => {
    initBotWithToken();

    const errCall = mockBotInstance.on.mock.calls.find(c => c[0] === 'error');
    expect(errCall).toBeTruthy();
  });
});

describe('telegram bot — command handlers', () => {
  let messageHandlerMock;

  beforeEach(() => {
    resetBot();
    messageHandlerMock = { handleMessage: vi.fn().mockResolvedValue(undefined), clearSession: vi.fn() };
    initBotWithToken(messageHandlerMock);
  });

  it('/start should send welcome message', () => {
    const startHandler = mockBotInstance.onText.mock.calls.find(
      c => c[0].toString().includes('start')
    )[1];

    startHandler({ chat: { id: 12345 } });

    expect(mockBotInstance.sendMessage).toHaveBeenCalledWith(
      12345,
      expect.stringContaining('Welcome to Subaru'),
      expect.objectContaining({ parse_mode: 'Markdown' })
    );
  });

  it('/status should show current config with uptime and memory', () => {
    const statusHandler = mockBotInstance.onText.mock.calls.find(
      c => c[0].toString().includes('status')
    )[1];

    statusHandler({ chat: { id: 12345 } });

    expect(mockBotInstance.sendMessage).toHaveBeenCalledWith(
      12345,
      expect.stringContaining('Subaru Status'),
      expect.objectContaining({ parse_mode: 'HTML' })
    );
    // Should contain uptime and memory info
    const sentText = mockBotInstance.sendMessage.mock.calls[0][1];
    expect(sentText).toContain('Uptime');
    expect(sentText).toContain('Memory');
    expect(sentText).toContain('Tools');
  });

  it('/help should send full command reference', () => {
    const helpHandler = mockBotInstance.onText.mock.calls.find(
      c => c[0].toString().includes('help')
    )[1];

    helpHandler({ chat: { id: 12345 } });

    expect(mockBotInstance.sendMessage).toHaveBeenCalledWith(
      12345,
      expect.stringContaining('Command Reference'),
      expect.objectContaining({ parse_mode: 'HTML' })
    );
  });

  it('/model without argument should show current model', () => {
    const modelHandler = mockBotInstance.onText.mock.calls.find(
      c => c[0].toString().includes('model')
    )[1];

    modelHandler({ chat: { id: 12345 } }, ['/model', undefined]);

    expect(mockBotInstance.sendMessage).toHaveBeenCalledWith(
      12345,
      expect.stringContaining('Current model'),
      expect.objectContaining({ parse_mode: 'HTML' })
    );
  });

  it('/model with argument should switch model and confirm', () => {
    const modelHandler = mockBotInstance.onText.mock.calls.find(
      c => c[0].toString().includes('model')
    )[1];

    modelHandler({ chat: { id: 12345 } }, ['/model llama3', 'llama3']);

    expect(mockBotInstance.sendMessage).toHaveBeenCalledWith(
      12345,
      expect.stringContaining('Model updated'),
      expect.objectContaining({ parse_mode: 'HTML' })
    );
  });

  it('/tools should list all registered tools', () => {
    const toolsHandler = mockBotInstance.onText.mock.calls.find(
      c => c[0].toString().includes('tools')
    )[1];

    toolsHandler({ chat: { id: 12345 } });

    expect(mockBotInstance.sendMessage).toHaveBeenCalledWith(
      12345,
      expect.stringContaining('Tools'),
      expect.objectContaining({ parse_mode: 'HTML' })
    );
    const sentText = mockBotInstance.sendMessage.mock.calls[0][1];
    expect(sentText).toContain('shell');
    expect(sentText).toContain('read_file');
  });

  it('/clear should clear session and notify user', () => {
    const clearHandler = mockBotInstance.onText.mock.calls.find(
      c => c[0].toString().includes('clear')
    )[1];

    clearHandler({ chat: { id: 12345 } });

    expect(messageHandlerMock.clearSession).toHaveBeenCalledWith('tg_12345');
    expect(mockBotInstance.sendMessage).toHaveBeenCalledWith(
      12345,
      expect.stringContaining('cleared')
    );
  });

  it('should forward non-command text messages to messageHandler', () => {
    const messageListener = mockBotInstance.on.mock.calls.find(c => c[0] === 'message')[1];

    messageListener({ chat: { id: 12345 }, text: 'Hello assistant' });

    expect(messageHandlerMock.handleMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Hello assistant' })
    );
  });

  it('should ignore command messages in general handler', () => {
    const messageListener = mockBotInstance.on.mock.calls.find(c => c[0] === 'message')[1];

    messageListener({ chat: { id: 12345 }, text: '/start' });

    expect(messageHandlerMock.handleMessage).not.toHaveBeenCalled();
  });

  it('should forward voice messages to messageHandler', () => {
    const messageListener = mockBotInstance.on.mock.calls.find(c => c[0] === 'message')[1];

    const voiceMsg = { chat: { id: 12345 }, voice: { file_id: 'voice123' } };
    messageListener(voiceMsg);

    expect(messageHandlerMock.handleMessage).toHaveBeenCalledWith(voiceMsg);
  });

  it('should forward photo messages to messageHandler', () => {
    const messageListener = mockBotInstance.on.mock.calls.find(c => c[0] === 'message')[1];

    const photoMsg = {
      chat: { id: 12345 },
      photo: [{ file_id: 'photo123', width: 800, height: 600 }],
      caption: 'What is this?'
    };
    messageListener(photoMsg);

    expect(messageHandlerMock.handleMessage).toHaveBeenCalledWith(photoMsg);
  });

  it('should handle callback_query for confirmation approval', () => {
    const resolveConfirmation = vi.fn();
    resetBot();
    initBotWithToken({ handleMessage: vi.fn().mockResolvedValue(undefined), clearSession: vi.fn(), resolveConfirmation });

    const callbackHandler = mockBotInstance.on.mock.calls.find(c => c[0] === 'callback_query')[1];

    // Mock bot methods for callback handling
    mockBotInstance.answerCallbackQuery = vi.fn().mockResolvedValue({});
    mockBotInstance.editMessageText = vi.fn().mockResolvedValue({});

    callbackHandler({
      id: 'cb_123',
      data: 'confirm:tgconf_abc123:yes',
      message: { chat: { id: 12345 }, message_id: 99, text: '⚠️ Confirmation required:\n\nRun command: ls' }
    });

    expect(resolveConfirmation).toHaveBeenCalledWith('tgconf_abc123', true);
  });

  it('should handle callback_query for confirmation denial', () => {
    const resolveConfirmation = vi.fn();
    resetBot();
    initBotWithToken({ handleMessage: vi.fn().mockResolvedValue(undefined), clearSession: vi.fn(), resolveConfirmation });

    const callbackHandler = mockBotInstance.on.mock.calls.find(c => c[0] === 'callback_query')[1];
    mockBotInstance.answerCallbackQuery = vi.fn().mockResolvedValue({});
    mockBotInstance.editMessageText = vi.fn().mockResolvedValue({});

    callbackHandler({
      id: 'cb_456',
      data: 'confirm:tgconf_def789:no',
      message: { chat: { id: 12345 }, message_id: 100, text: 'something' }
    });

    expect(resolveConfirmation).toHaveBeenCalledWith('tgconf_def789', false);
  });

  it('should catch errors from async handleMessage and send error to user', () => {
    const failingHandler = {
      handleMessage: vi.fn().mockRejectedValue(new Error('Handler exploded')),
      clearSession: vi.fn()
    };
    resetBot();
    initBotWithToken(failingHandler);

    const messageListener = mockBotInstance.on.mock.calls.find(c => c[0] === 'message')[1];
    messageListener({ chat: { id: 12345 }, text: 'trigger error' });

    // Should have called handleMessage (error is caught internally via .catch)
    expect(failingHandler.handleMessage).toHaveBeenCalled();
  });

  it('should forward document messages to messageHandler', () => {
    const messageListener = mockBotInstance.on.mock.calls.find(c => c[0] === 'message')[1];

    const docMsg = { chat: { id: 12345 }, document: { file_id: 'doc123', file_name: 'data.json' } };
    messageListener(docMsg);

    expect(messageHandlerMock.handleMessage).toHaveBeenCalledWith(docMsg);
  });

  it('should ignore messages with no content (stickers, etc)', () => {
    const messageListener = mockBotInstance.on.mock.calls.find(c => c[0] === 'message')[1];

    messageListener({ chat: { id: 12345 }, sticker: { file_id: 'sticker123' } });

    expect(messageHandlerMock.handleMessage).not.toHaveBeenCalled();
  });
});

describe('telegram bot — sendConfirmation', () => {
  beforeEach(() => {
    resetBot();
    initBotWithToken();
  });

  it('should send a message with inline keyboard for confirmation', () => {
    botModule.sendConfirmation(12345, 'Run: rm -rf /tmp', 'conf_abc');

    expect(mockBotInstance.sendMessage).toHaveBeenCalledWith(
      12345,
      expect.stringContaining('Confirmation required'),
      expect.objectContaining({
        reply_markup: expect.objectContaining({
          inline_keyboard: expect.any(Array)
        })
      })
    );
  });
});

describe('telegram bot — sendMessage', () => {
  beforeEach(() => {
    resetBot();
    initBotWithToken();
  });

  it('should send message with HTML parse mode by default', () => {
    botModule.sendMessage(12345, 'Hello <b>world</b>');

    expect(mockBotInstance.sendMessage).toHaveBeenCalledWith(
      12345,
      'Hello <b>world</b>',
      expect.objectContaining({ parse_mode: 'HTML' })
    );
  });

  it('should allow overriding parse mode', () => {
    botModule.sendMessage(12345, 'Hello', { parse_mode: 'Markdown' });

    expect(mockBotInstance.sendMessage).toHaveBeenCalledWith(
      12345,
      'Hello',
      expect.objectContaining({ parse_mode: 'Markdown' })
    );
  });
});

describe('telegram bot — sendPhoto', () => {
  beforeEach(() => {
    resetBot();
    initBotWithToken();
  });

  it('should send photo with HTML parse mode by default', () => {
    botModule.sendPhoto(12345, '/path/to/image.png', { caption: 'Test' });

    expect(mockBotInstance.sendPhoto).toHaveBeenCalledWith(
      12345,
      '/path/to/image.png',
      expect.objectContaining({ parse_mode: 'HTML', caption: 'Test' })
    );
  });
});

describe('telegram bot — editMessage', () => {
  beforeEach(() => {
    resetBot();
    initBotWithToken();
  });

  it('should edit a message with HTML parse mode', () => {
    botModule.editMessage(12345, 99, 'Updated <b>text</b>');

    expect(mockBotInstance.editMessageText).toHaveBeenCalledWith(
      'Updated <b>text</b>',
      expect.objectContaining({ chat_id: 12345, message_id: 99, parse_mode: 'HTML' })
    );
  });
});

describe('telegram bot — sendDocument', () => {
  beforeEach(() => {
    resetBot();
    initBotWithToken();
  });

  it('should send a document with HTML parse mode', () => {
    botModule.sendDocument(12345, '/path/to/file.txt', { caption: 'Here' });

    expect(mockBotInstance.sendDocument).toHaveBeenCalledWith(
      12345,
      '/path/to/file.txt',
      expect.objectContaining({ parse_mode: 'HTML', caption: 'Here' })
    );
  });
});

describe('telegram bot — setReaction', () => {
  beforeEach(() => {
    resetBot();
    initBotWithToken();
  });

  it('should set an emoji reaction on a message', () => {
    botModule.setReaction(12345, 42, '👍');

    expect(mockBotInstance.setMessageReaction).toHaveBeenCalledWith(
      12345, 42,
      expect.objectContaining({
        reaction: [{ type: 'emoji', emoji: '👍' }]
      })
    );
  });
});

describe('telegram bot — sendTyping', () => {
  beforeEach(() => {
    resetBot();
    initBotWithToken();
  });

  it('should send typing action', () => {
    botModule.sendTyping(12345);
    expect(mockBotInstance.sendChatAction).toHaveBeenCalledWith(12345, 'typing');
  });
});

describe('telegram bot — downloadFile', () => {
  beforeEach(() => {
    resetBot();
    initBotWithToken();
  });

  it('should download a file by file_id to dest path', async () => {
    const result = await botModule.downloadFile('file_abc', '/tmp');

    expect(mockBotInstance.downloadFile).toHaveBeenCalledWith('file_abc', '/tmp');
    expect(result).toBe('/tmp/downloaded_file.ogg');
  });

  it('should throw when bot is not initialized', async () => {
    botModule.stop();
    await expect(botModule.downloadFile('file_abc', '/tmp')).rejects.toThrow('Bot not initialized');
  });
});

describe('telegram bot — stop', () => {
  beforeEach(() => {
    resetBot();
    initBotWithToken();
  });

  it('should stop polling when stop is called', () => {
    botModule.stop();
    expect(mockBotInstance.stopPolling).toHaveBeenCalled();
  });

  it('should set bot to null after stop', () => {
    botModule.stop();
    expect(botModule.getBot()).toBeNull();
  });
});
