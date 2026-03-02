import { describe, it, expect, beforeEach } from 'vitest';
import {
  getHistory,
  addMessage,
  clearHistory,
  getAllSessions,
  addToolResult,
  addAssistantToolCalls
} from '../../src/memory/shortTerm.js';

describe('shortTerm memory', () => {
  const SESSION = 'test_session';

  beforeEach(() => {
    clearHistory(SESSION);
  });

  it('should return empty history for new session', () => {
    expect(getHistory('new_session')).toEqual([]);
  });

  it('should add and retrieve messages', () => {
    addMessage(SESSION, 'user', 'Hello');
    addMessage(SESSION, 'assistant', 'Hi there');

    const history = getHistory(SESSION);
    expect(history).toHaveLength(2);
    expect(history[0].role).toBe('user');
    expect(history[0].content).toBe('Hello');
    expect(history[1].role).toBe('assistant');
  });

  it('should enforce max messages limit', () => {
    for (let i = 0; i < 10; i++) {
      addMessage(SESSION, 'user', `Message ${i}`, 5);
    }

    const history = getHistory(SESSION);
    expect(history.length).toBeLessThanOrEqual(5);
  });

  it('should add tool results', () => {
    addToolResult(SESSION, 'tc_1', 'test_tool', '{"success":true}');

    const history = getHistory(SESSION);
    expect(history).toHaveLength(1);
    expect(history[0].role).toBe('tool');
    expect(history[0].tool_call_id).toBe('tc_1');
    expect(history[0].name).toBe('test_tool');
  });

  it('should add assistant messages with tool calls', () => {
    const toolCalls = [{ id: 'tc_1', type: 'function', function: { name: 'test', arguments: '{}' } }];
    addAssistantToolCalls(SESSION, 'Let me check that', toolCalls);

    const history = getHistory(SESSION);
    expect(history).toHaveLength(1);
    expect(history[0].role).toBe('assistant');
    expect(history[0].tool_calls).toEqual(toolCalls);
  });

  it('should clear session history', () => {
    addMessage(SESSION, 'user', 'Test');
    expect(getHistory(SESSION)).toHaveLength(1);

    clearHistory(SESSION);
    expect(getHistory(SESSION)).toEqual([]);
  });

  it('should track all sessions', () => {
    addMessage('session_a', 'user', 'A');
    addMessage('session_b', 'user', 'B');

    const sessions = getAllSessions();
    expect(sessions).toContain('session_a');
    expect(sessions).toContain('session_b');

    clearHistory('session_a');
    clearHistory('session_b');
  });

  it('should include timestamps in messages', () => {
    addMessage(SESSION, 'user', 'Timestamped');
    const history = getHistory(SESSION);
    expect(history[0].timestamp).toBeDefined();
    expect(typeof history[0].timestamp).toBe('number');
  });
});
