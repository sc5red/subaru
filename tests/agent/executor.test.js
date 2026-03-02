import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execute } from '../../src/agent/executor.js';

// Mock registry
vi.mock('../../src/tools/registry.js', () => {
  const mockTools = new Map();
  return {
    getTool: (name) => mockTools.get(name),
    getAllTools: () => Array.from(mockTools.values()),
    _mockTools: mockTools
  };
});

vi.mock('../../src/utils/logger.js', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

const { _mockTools: mockTools } = await import('../../src/tools/registry.js');

const baseContext = {
  config: { tools: { filesystem: { allowedPaths: [], blockedPaths: [] } } },
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  confirmationFn: async () => true,
  sessionId: 'test_session'
};

describe('executor.execute', () => {
  beforeEach(() => {
    mockTools.clear();
  });

  it('should return error when tool is not found', async () => {
    const result = await execute(
      { id: 'tc_1', name: 'nonexistent_tool', input: {} },
      baseContext
    );
    expect(result.content).toContain('Tool not found');
    expect(result.name).toBe('nonexistent_tool');
  });

  it('should execute a registered tool successfully', async () => {
    mockTools.set('test_tool', {
      name: 'test_tool',
      description: 'A test tool',
      parameters: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value']
      },
      execute: async (input) => ({ success: true, output: `Got: ${input.value}` })
    });

    const result = await execute(
      { id: 'tc_2', name: 'test_tool', input: { value: 'hello' } },
      baseContext
    );
    const parsed = JSON.parse(result.content);
    expect(parsed.success).toBe(true);
    expect(parsed.output).toBe('Got: hello');
  });

  it('should validate tool input with AJV and reject invalid input', async () => {
    mockTools.set('strict_tool', {
      name: 'strict_tool',
      description: 'A tool with strict params',
      parameters: {
        type: 'object',
        properties: {
          count: { type: 'number' }
        },
        required: ['count']
      },
      execute: async (input) => ({ success: true, output: 'ok' })
    });

    // AJV with coerceTypes will convert string "not_a_number" to NaN for type number
    // but the required field "count" must be present — let's test with missing field
    const result = await execute(
      { id: 'tc_3', name: 'strict_tool', input: {} },
      baseContext
    );
    const parsed = JSON.parse(result.content);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('Validation error');
  });

  it('should catch and return tool execution errors', async () => {
    mockTools.set('error_tool', {
      name: 'error_tool',
      description: 'A tool that throws',
      execute: async () => { throw new Error('Tool exploded'); }
    });

    const result = await execute(
      { id: 'tc_4', name: 'error_tool', input: {} },
      baseContext
    );
    const parsed = JSON.parse(result.content);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toBe('Tool exploded');
  });

  it('should return string content as-is when tool returns a string', async () => {
    mockTools.set('string_tool', {
      name: 'string_tool',
      description: 'Returns a string',
      execute: async () => 'raw string result'
    });

    const result = await execute(
      { id: 'tc_5', name: 'string_tool', input: {} },
      baseContext
    );
    expect(result.content).toBe('raw string result');
  });
});
