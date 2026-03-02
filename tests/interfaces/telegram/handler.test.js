import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

// --- Mocks ---

vi.mock('../../../src/utils/logger.js', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

vi.mock('../../../src/memory/shortTerm.js', () => ({
  clearHistory: vi.fn(),
  getHistory: vi.fn(() => []),
  addMessage: vi.fn()
}));

const botMocks = {
  sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
  sendPhoto: vi.fn().mockResolvedValue({}),
  sendDocument: vi.fn().mockResolvedValue({}),
  sendTyping: vi.fn().mockResolvedValue({}),
  downloadFile: vi.fn().mockResolvedValue('/tmp/test_file.png'),
  sendConfirmation: vi.fn().mockResolvedValue({}),
  editMessage: vi.fn().mockResolvedValue({}),
  setReaction: vi.fn().mockResolvedValue({}),
  toolIcon: vi.fn((name) => '🔧'),
  randomThink: vi.fn(() => '🧠'),
};

vi.mock('../../../src/interfaces/telegram/bot.js', () => botMocks);

vi.mock('../../../src/llm/stt.js', () => ({
  transcribe: vi.fn().mockResolvedValue('transcribed voice text')
}));

// Mock agent.run to simulate the emitter lifecycle
const agentRunMock = vi.fn();
vi.mock('../../../src/agent/agent.js', () => ({
  run: (...args) => agentRunMock(...args)
}));

// Mock fs functions used in handler
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    existsSync: vi.fn(() => true),
    readFileSync: vi.fn((p, enc) => {
      if (enc === 'utf-8') return 'file content here';
      return Buffer.from('fake-image-data');
    }),
    mkdirSync: vi.fn(),
    renameSync: vi.fn(),
    statSync: vi.fn(() => ({ isFile: () => true, size: 1024 }))
  };
});

// --- Import handler after mocks ---
const handler = (await import('../../../src/interfaces/telegram/handler.js')).default;

// --- Helpers ---

function makeTextMsg(text, chatId = 12345) {
  return { chat: { id: chatId }, message_id: 100, text };
}

function makeVoiceMsg(chatId = 12345) {
  return { chat: { id: chatId }, message_id: 101, voice: { file_id: 'voice_file_123' } };
}

function makePhotoMsg(caption, chatId = 12345) {
  return {
    chat: { id: chatId },
    message_id: 102,
    caption: caption || undefined,
    photo: [
      { file_id: 'small_photo', width: 90, height: 90 },
      { file_id: 'medium_photo', width: 320, height: 320 },
      { file_id: 'large_photo', width: 800, height: 800 }
    ]
  };
}

function makeDocMsg(fileName, caption, chatId = 12345) {
  return {
    chat: { id: chatId },
    message_id: 103,
    document: { file_id: 'doc_file_456', file_name: fileName, mime_type: 'text/plain' },
    caption: caption || undefined
  };
}

function makeReplyMsg(text, replyText, chatId = 12345) {
  return {
    chat: { id: chatId },
    message_id: 104,
    text,
    reply_to_message: { message_id: 50, text: replyText }
  };
}

// Helper: configure agentRunMock to simulate token emission
function setupAgentRun(responseText, toolEvents = []) {
  agentRunMock.mockImplementation(async (text, sessionId, emitter, opts) => {
    // Emit tool events first
    for (const te of toolEvents) {
      if (te.type === 'tool_call') {
        emitter.emit('tool_call', { tool: te.tool, input: te.input || {} });
      } else if (te.type === 'tool_result') {
        emitter.emit('tool_result', { tool: te.tool, output: te.output, success: te.success ?? true });
      }
    }
    // Emit tokens
    if (responseText) {
      for (const char of responseText) {
        emitter.emit('token', { content: char });
      }
    }
    emitter.emit('done', {});
  });
}

// --- Tests ---

describe('telegram handler — handleMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupAgentRun('Hello from Subaru!');
  });

  // ========== Text messages ==========

  describe('text messages', () => {
    it('should process a basic text message and send a response', async () => {
      const msg = makeTextMsg('Hello');
      await handler.handleMessage(msg);

      // Should have called agent.run with correct params
      expect(agentRunMock).toHaveBeenCalledTimes(1);
      expect(agentRunMock.mock.calls[0][0]).toBe('Hello');
      expect(agentRunMock.mock.calls[0][1]).toBe('tg_12345');
      expect(agentRunMock.mock.calls[0][2]).toBeInstanceOf(EventEmitter);

      // Should have sent the response
      expect(botMocks.sendMessage).toHaveBeenCalled();
      const sentText = botMocks.sendMessage.mock.calls.find(
        c => c[1].includes('Hello from Subaru')
      );
      expect(sentText).toBeTruthy();
    });

    it('should send typing indicator before processing', async () => {
      await handler.handleMessage(makeTextMsg('Test'));
      expect(botMocks.sendTyping).toHaveBeenCalledWith(12345);
    });

    it('should ignore empty text messages', async () => {
      const msg = { chat: { id: 12345 }, text: '' };
      await handler.handleMessage(msg);
      expect(agentRunMock).not.toHaveBeenCalled();
    });

    it('should ignore messages with only whitespace', async () => {
      const msg = { chat: { id: 12345 }, text: '   ' };
      await handler.handleMessage(msg);
      expect(agentRunMock).not.toHaveBeenCalled();
    });

    it('should use the correct session ID based on chat ID', async () => {
      await handler.handleMessage(makeTextMsg('Test', 99999));
      expect(agentRunMock.mock.calls[0][1]).toBe('tg_99999');
    });
  });

  // ========== Voice messages ==========

  describe('voice messages', () => {
    it('should download, transcribe, and process a voice message', async () => {
      const { transcribe } = await import('../../../src/llm/stt.js');
      const msg = makeVoiceMsg();
      await handler.handleMessage(msg);

      // Should have downloaded the file
      expect(botMocks.downloadFile).toHaveBeenCalledWith('voice_file_123', expect.any(String));

      // Should have transcribed
      expect(transcribe).toHaveBeenCalled();

      // Should have sent the transcription back to user
      const transcripMsg = botMocks.sendMessage.mock.calls.find(
        c => typeof c[1] === 'string' && c[1].includes('transcribed voice text')
      );
      expect(transcripMsg).toBeTruthy();

      // Should have called agent.run with transcribed text
      expect(agentRunMock.mock.calls[0][0]).toBe('transcribed voice text');
    });

    it('should handle voice download errors gracefully', async () => {
      botMocks.downloadFile.mockRejectedValueOnce(new Error('Download failed'));

      const msg = makeVoiceMsg();
      await handler.handleMessage(msg);

      // Should send error message to user
      const errorMsg = botMocks.sendMessage.mock.calls.find(
        c => typeof c[1] === 'string' && c[1].includes("couldn't process")
      );
      expect(errorMsg).toBeTruthy();

      // Should NOT have called agent.run
      expect(agentRunMock).not.toHaveBeenCalled();
    });

    it('should handle transcription errors gracefully', async () => {
      const { transcribe } = await import('../../../src/llm/stt.js');
      transcribe.mockRejectedValueOnce(new Error('STT not configured'));

      const msg = makeVoiceMsg();
      await handler.handleMessage(msg);

      const errorMsg = botMocks.sendMessage.mock.calls.find(
        c => typeof c[1] === 'string' && c[1].includes("couldn't process")
      );
      expect(errorMsg).toBeTruthy();
      expect(agentRunMock).not.toHaveBeenCalled();
    });

    it('should handle audio messages (not just voice)', async () => {
      const msg = { chat: { id: 12345 }, audio: { file_id: 'audio_file_456' } };
      await handler.handleMessage(msg);

      expect(botMocks.downloadFile).toHaveBeenCalledWith('audio_file_456', expect.any(String));
    });
  });

  // ========== Photo messages ==========

  describe('photo messages', () => {
    it('should download the largest photo and send to agent with vision', async () => {
      const msg = makePhotoMsg('What is this?');
      await handler.handleMessage(msg);

      // Should download the largest photo (last in array)
      expect(botMocks.downloadFile).toHaveBeenCalledWith('large_photo', expect.any(String));

      // Should call agent with the caption text
      expect(agentRunMock.mock.calls[0][0]).toBe('What is this?');

      // Should include images in options
      const opts = agentRunMock.mock.calls[0][3];
      expect(opts.images).toBeDefined();
      expect(opts.images.length).toBe(1);
    });

    it('should use default prompt when no caption provided', async () => {
      const msg = makePhotoMsg(null);
      await handler.handleMessage(msg);

      expect(agentRunMock.mock.calls[0][0]).toContain('What do you see');
    });

    it('should handle photo download errors gracefully', async () => {
      botMocks.downloadFile.mockRejectedValueOnce(new Error('Network error'));

      const msg = makePhotoMsg('test');
      await handler.handleMessage(msg);

      const errorMsg = botMocks.sendMessage.mock.calls.find(
        c => typeof c[1] === 'string' && c[1].includes("couldn't process")
      );
      expect(errorMsg).toBeTruthy();
      expect(agentRunMock).not.toHaveBeenCalled();
    });
  });

  // ========== Agent error handling ==========

  describe('agent errors', () => {
    it('should send error message when agent.run throws', async () => {
      agentRunMock.mockRejectedValueOnce(new Error('LLM API timeout'));

      await handler.handleMessage(makeTextMsg('Do something'));

      const errorMsg = botMocks.sendMessage.mock.calls.find(
        c => typeof c[1] === 'string' && c[1].includes('LLM API timeout')
      );
      expect(errorMsg).toBeTruthy();
    });

    it('should send fallback when agent produces no response and no images', async () => {
      setupAgentRun(''); // empty response

      await handler.handleMessage(makeTextMsg('Hello'));

      const fallback = botMocks.sendMessage.mock.calls.find(
        c => typeof c[1] === 'string' && c[1].includes('No response generated')
      );
      expect(fallback).toBeTruthy();
    });

    it('should catch top-level errors and send error to user', async () => {
      // Force a crash before agent.run by making sendTyping throw on second call
      // and the inner code to fail
      agentRunMock.mockImplementation(() => { throw new Error('Unexpected crash'); });

      await handler.handleMessage(makeTextMsg('Crash test'));

      const errorMsg = botMocks.sendMessage.mock.calls.find(
        c => typeof c[1] === 'string' && c[1].includes('Unexpected crash')
      );
      expect(errorMsg).toBeTruthy();
    });
  });

  // ========== Tool result handling ==========

  describe('tool results with images', () => {
    it('should collect display_image tool results and send as photos', async () => {
      setupAgentRun('Here is the screenshot.', [
        { type: 'tool_call', tool: 'display_image' },
        {
          type: 'tool_result',
          tool: 'display_image',
          output: '__DISPLAY_IMAGE__:/path/to/screenshot.png:Screenshot',
          success: true
        }
      ]);

      await handler.handleMessage(makeTextMsg('Take a screenshot'));

      expect(botMocks.sendPhoto).toHaveBeenCalledWith(
        12345,
        '/path/to/screenshot.png',
        expect.objectContaining({ caption: 'Screenshot' })
      );
    });

    it('should detect image paths in other tool outputs', async () => {
      setupAgentRun('Done!', [
        { type: 'tool_call', tool: 'shell' },
        {
          type: 'tool_result',
          tool: 'shell',
          output: 'Saved file to C:\\Users\\test\\output.png and finished.',
          success: true
        }
      ]);

      await handler.handleMessage(makeTextMsg('Generate image'));

      // Should have attempted to send the detected image as a photo
      expect(botMocks.sendPhoto).toHaveBeenCalled();
    });

    it('should handle photo send failures gracefully', async () => {
      botMocks.sendPhoto.mockRejectedValueOnce(new Error('File too large'));

      setupAgentRun('Screenshot taken.', [
        { type: 'tool_call', tool: 'display_image' },
        {
          type: 'tool_result',
          tool: 'display_image',
          output: '__DISPLAY_IMAGE__:/path/to/big.png:Big image',
          success: true
        }
      ]);

      await handler.handleMessage(makeTextMsg('Screenshot'));

      // Should send an error message instead of crashing
      const errorFallback = botMocks.sendMessage.mock.calls.find(
        c => typeof c[1] === 'string' && c[1].includes("couldn't be sent")
      );
      expect(errorFallback).toBeTruthy();
    });
  });

  // ========== Long message splitting ==========

  describe('long message splitting', () => {
    it('should split long responses into chunks', async () => {
      const longText = 'A'.repeat(5000); // over 4000 char limit
      setupAgentRun(longText);

      await handler.handleMessage(makeTextMsg('Write something long'));

      // Should have been called more than once for the response
      const responseCalls = botMocks.sendMessage.mock.calls.filter(
        c => c[0] === 12345 && typeof c[1] === 'string' && c[1].length > 0
      );
      expect(responseCalls.length).toBeGreaterThanOrEqual(2);
    });

    it('should fall back to plain text when HTML parse fails', async () => {
      // First call fails, second succeeds (use Once variants to avoid polluting other tests)
      botMocks.sendMessage
        .mockRejectedValueOnce(new Error('Bad Request: can\'t parse entities'))
        .mockResolvedValueOnce({});

      setupAgentRun('Some <invalid> html & stuff');

      await handler.handleMessage(makeTextMsg('Test'));

      // Should have retried
      expect(botMocks.sendMessage.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ========== Typing indicator ==========

  describe('typing indicators', () => {
    it('should keep sending typing during tool calls', async () => {
      setupAgentRun('Done', [
        { type: 'tool_call', tool: 'shell', input: { command: 'ls' } }
      ]);

      await handler.handleMessage(makeTextMsg('List files'));

      // sendTyping should have been called at least for the initial indication
      expect(botMocks.sendTyping).toHaveBeenCalled();
    });

    it('should not crash if sendTyping fails', async () => {
      botMocks.sendTyping.mockRejectedValue(new Error('Network error'));

      await handler.handleMessage(makeTextMsg('Test'));

      // Should still complete without throwing
      expect(agentRunMock).toHaveBeenCalled();
    });
  });
});

// ========== clearSession ==========

describe('telegram handler — clearSession', () => {
  it('should call shortTerm.clearHistory with the session ID', async () => {
    const { clearHistory } = await import('../../../src/memory/shortTerm.js');
    handler.clearSession('tg_12345');
    expect(clearHistory).toHaveBeenCalledWith('tg_12345');
  });
});

// ========== resolveConfirmation ==========

describe('telegram handler — confirmation flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should send inline keyboard for tool confirmation and resolve on approve', async () => {
    let capturedConfirmationFn;
    agentRunMock.mockImplementation(async (text, sessionId, emitter, opts) => {
      capturedConfirmationFn = opts.confirmationFn;
      // Simulate a tool needing confirmation
      const approved = await opts.confirmationFn('Run dangerous command: rm -rf /tmp/test');
      if (approved) {
        emitter.emit('token', { content: 'Command executed.' });
      }
      emitter.emit('done', {});
    });

    // Start handling in the background
    const handlePromise = handler.handleMessage(makeTextMsg('Do something dangerous'));

    // Wait a tick for the confirmation to be sent
    await new Promise(r => setTimeout(r, 50));

    // sendConfirmation should have been called with an inline keyboard
    expect(botMocks.sendConfirmation).toHaveBeenCalledWith(
      12345,
      'Run dangerous command: rm -rf /tmp/test',
      expect.stringContaining('tgconf_')
    );

    // Extract the confirmationId from the call
    const confId = botMocks.sendConfirmation.mock.calls[0][2];

    // Simulate user clicking "Approve"
    handler.resolveConfirmation(confId, true);

    await handlePromise;

    // Agent should have continued and sent the response
    const response = botMocks.sendMessage.mock.calls.find(
      c => typeof c[1] === 'string' && c[1].includes('Command executed')
    );
    expect(response).toBeTruthy();
  });

  it('should deny tool execution when user clicks deny', async () => {
    agentRunMock.mockImplementation(async (text, sessionId, emitter, opts) => {
      const approved = await opts.confirmationFn('Delete files');
      emitter.emit('token', { content: approved ? 'Deleted.' : 'Cancelled.' });
      emitter.emit('done', {});
    });

    const handlePromise = handler.handleMessage(makeTextMsg('Delete stuff'));
    await new Promise(r => setTimeout(r, 50));

    const confId = botMocks.sendConfirmation.mock.calls[0][2];
    handler.resolveConfirmation(confId, false);

    await handlePromise;

    const response = botMocks.sendMessage.mock.calls.find(
      c => typeof c[1] === 'string' && c[1].includes('Cancelled')
    );
    expect(response).toBeTruthy();
  });

  it('should return false for unknown confirmation IDs', () => {
    const result = handler.resolveConfirmation('nonexistent_id', true);
    expect(result).toBe(false);
  });
});

// ========== markdownToTelegramHtml (tested indirectly) ==========

describe('telegram handler — markdown conversion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should convert bold markdown to HTML bold tags', async () => {
    setupAgentRun('This is **bold** text');

    await handler.handleMessage(makeTextMsg('test'));

    const sent = botMocks.sendMessage.mock.calls.find(
      c => typeof c[1] === 'string' && c[1].includes('<b>bold</b>')
    );
    expect(sent).toBeTruthy();
  });

  it('should convert italic markdown to HTML italic tags', async () => {
    setupAgentRun('This is *italic* text');

    await handler.handleMessage(makeTextMsg('test'));

    const sent = botMocks.sendMessage.mock.calls.find(
      c => typeof c[1] === 'string' && c[1].includes('<i>italic</i>')
    );
    expect(sent).toBeTruthy();
  });

  it('should convert code blocks to <pre> tags', async () => {
    setupAgentRun('Here:\n```js\nconsole.log("hi")\n```');

    await handler.handleMessage(makeTextMsg('test'));

    const sent = botMocks.sendMessage.mock.calls.find(
      c => typeof c[1] === 'string' && c[1].includes('<pre>')
    );
    expect(sent).toBeTruthy();
  });

  it('should convert inline code to <code> tags', async () => {
    setupAgentRun('Run `npm install` to install');

    await handler.handleMessage(makeTextMsg('test'));

    const sent = botMocks.sendMessage.mock.calls.find(
      c => typeof c[1] === 'string' && c[1].includes('<code>npm install</code>')
    );
    expect(sent).toBeTruthy();
  });

  it('should escape HTML entities in response', async () => {
    setupAgentRun('Use <div> & "quotes"');

    await handler.handleMessage(makeTextMsg('test'));

    const sent = botMocks.sendMessage.mock.calls.find(
      c => typeof c[1] === 'string' && c[1].includes('&lt;div&gt;') && c[1].includes('&amp;')
    );
    expect(sent).toBeTruthy();
  });

  it('should convert markdown links to HTML anchor tags', async () => {
    setupAgentRun('Visit [Google](https://google.com) now');

    await handler.handleMessage(makeTextMsg('test'));

    const sent = botMocks.sendMessage.mock.calls.find(
      c => typeof c[1] === 'string' && c[1].includes('<a href="https://google.com">Google</a>')
    );
    expect(sent).toBeTruthy();
  });

  it('should convert headings to bold text', async () => {
    setupAgentRun('## Section Title');

    await handler.handleMessage(makeTextMsg('test'));

    const sent = botMocks.sendMessage.mock.calls.find(
      c => typeof c[1] === 'string' && c[1].includes('<b>Section Title</b>')
    );
    expect(sent).toBeTruthy();
  });

  it('should convert strikethrough to <s> tags', async () => {
    setupAgentRun('This is ~~deleted~~ text');

    await handler.handleMessage(makeTextMsg('test'));

    const sent = botMocks.sendMessage.mock.calls.find(
      c => typeof c[1] === 'string' && c[1].includes('<s>deleted</s>')
    );
    expect(sent).toBeTruthy();
  });
});

// ========== Reply context ==========

describe('telegram handler — reply context', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupAgentRun('Sure, here is context-aware reply.');
  });

  it('should prepend quoted context when replying to a bot message', async () => {
    const msg = makeReplyMsg('Follow up on this', 'Previous bot answer about file systems');
    await handler.handleMessage(msg);

    const agentInput = agentRunMock.mock.calls[0][0];
    expect(agentInput).toContain('Replying to previous message');
    expect(agentInput).toContain('Previous bot answer about file systems');
    expect(agentInput).toContain('Follow up on this');
  });

  it('should truncate very long quoted messages', async () => {
    const longText = 'X'.repeat(600);
    const msg = makeReplyMsg('Summary?', longText);
    await handler.handleMessage(msg);

    const agentInput = agentRunMock.mock.calls[0][0];
    expect(agentInput).toContain('Replying to previous message');
    // Should be truncated with ellipsis
    expect(agentInput.length).toBeLessThan(longText.length + 200);
  });

  it('should work normally when not replying to a message', async () => {
    const msg = makeTextMsg('Plain question');
    await handler.handleMessage(msg);

    const agentInput = agentRunMock.mock.calls[0][0];
    expect(agentInput).toBe('Plain question');
    expect(agentInput).not.toContain('Replying to');
  });
});

// ========== Document messages ==========

describe('telegram handler — document messages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupAgentRun('Document analyzed!');
  });

  it('should download and include text-based document content in agent input', async () => {
    const msg = makeDocMsg('data.json', 'Parse this file');
    await handler.handleMessage(msg);

    expect(botMocks.downloadFile).toHaveBeenCalledWith('doc_file_456', expect.any(String));
    const agentInput = agentRunMock.mock.calls[0][0];
    expect(agentInput).toContain('data.json');
    expect(agentInput).toContain('file content here');
  });

  it('should use caption as prompt when provided', async () => {
    const msg = makeDocMsg('notes.txt', 'Summarize this');
    await handler.handleMessage(msg);

    const agentInput = agentRunMock.mock.calls[0][0];
    expect(agentInput).toContain('Summarize this');
  });

  it('should handle document download errors', async () => {
    botMocks.downloadFile.mockRejectedValueOnce(new Error('File too large'));

    const msg = makeDocMsg('big.csv');
    await handler.handleMessage(msg);

    const errorMsg = botMocks.sendMessage.mock.calls.find(
      c => typeof c[1] === 'string' && c[1].includes("couldn't process")
    );
    expect(errorMsg).toBeTruthy();
    expect(agentRunMock).not.toHaveBeenCalled();
  });
});

// ========== Activity message ==========

describe('telegram handler — activity message', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should send an initial activity message before processing', async () => {
    setupAgentRun('Done.');
    await handler.handleMessage(makeTextMsg('Hello'));

    // Should have sent at least one message containing thinking indicator
    const thinkMsg = botMocks.sendMessage.mock.calls.find(
      c => typeof c[1] === 'string' && c[1].includes('Thinking')
    );
    expect(thinkMsg).toBeTruthy();
  });

  it('should edit the activity message during tool calls', async () => {
    setupAgentRun('Result', [
      { type: 'tool_call', tool: 'shell', input: { command: 'ls -la' } },
      { type: 'tool_result', tool: 'shell', output: 'file1 file2', success: true }
    ]);

    await handler.handleMessage(makeTextMsg('List files'));

    // editMessage should have been called to update activity status
    expect(botMocks.editMessage).toHaveBeenCalled();
  });

  it('should show tool names in the activity message', async () => {
    setupAgentRun('Found files.', [
      { type: 'tool_call', tool: 'read_file', input: { path: '/tmp/notes.txt' } },
      { type: 'tool_result', tool: 'read_file', output: 'notes content', success: true }
    ]);

    await handler.handleMessage(makeTextMsg('Read notes'));

    const editCalls = botMocks.editMessage.mock.calls;
    const hasToolName = editCalls.some(
      c => typeof c[2] === 'string' && c[2].includes('read_file')
    );
    expect(hasToolName).toBe(true);
  });
});

// ========== Reactions ==========

describe('telegram handler — reactions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should react with 👀 when message is received', async () => {
    setupAgentRun('Hi');
    await handler.handleMessage(makeTextMsg('Hello'));

    expect(botMocks.setReaction).toHaveBeenCalledWith(12345, 100, '👀');
  });

  it('should react with 👍 on success', async () => {
    setupAgentRun('All done!');
    await handler.handleMessage(makeTextMsg('Do something'));

    // Last setReaction call should be thumbs up
    const lastCall = botMocks.setReaction.mock.calls[botMocks.setReaction.mock.calls.length - 1];
    expect(lastCall).toEqual([12345, 100, '👍']);
  });

  it('should react with 👎 on error', async () => {
    agentRunMock.mockRejectedValueOnce(new Error('LLM failed'));
    await handler.handleMessage(makeTextMsg('Fail'));

    const lastCall = botMocks.setReaction.mock.calls[botMocks.setReaction.mock.calls.length - 1];
    expect(lastCall).toEqual([12345, 100, '👎']);
  });
});

// ========== Document sending ==========

describe('telegram handler — document sending', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should send files as documents when tool output contains doc paths', async () => {
    setupAgentRun('Created the file.', [
      { type: 'tool_call', tool: 'write_file' },
      {
        type: 'tool_result',
        tool: 'write_file',
        output: 'Wrote 500 bytes to C:\\project\\output.json',
        success: true
      }
    ]);

    await handler.handleMessage(makeTextMsg('Create a JSON file'));

    expect(botMocks.sendDocument).toHaveBeenCalledWith(
      12345,
      'C:\\project\\output.json',
      expect.objectContaining({ caption: expect.stringContaining('output.json') })
    );
  });

  it('should deduplicate document paths', async () => {
    setupAgentRun('Done twice.', [
      { type: 'tool_call', tool: 'shell' },
      {
        type: 'tool_result',
        tool: 'shell',
        output: 'Saved to C:\\tmp\\report.txt and also C:\\tmp\\report.txt',
        success: true
      }
    ]);

    await handler.handleMessage(makeTextMsg('Generate report'));

    // Should only be sent once despite appearing twice
    const docCalls = botMocks.sendDocument.mock.calls.filter(
      c => c[1] === 'C:\\tmp\\report.txt'
    );
    expect(docCalls.length).toBe(1);
  });
});
