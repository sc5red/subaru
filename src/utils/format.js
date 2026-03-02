/**
 * Truncate a string to maxLen characters, appending '...' if truncated.
 */
export function truncate(str, maxLen = 500) {
  if (typeof str !== 'string') str = String(str);
  if (str.length <= maxLen) return str;
  return str.substring(0, maxLen - 3) + '...';
}

/**
 * Format a tool call for display.
 */
export function formatToolCall(name, input) {
  const inputStr = typeof input === 'object' ? JSON.stringify(input, null, 2) : String(input);
  return `[tool: ${name}] Input: ${truncate(inputStr, 300)}`;
}

/**
 * Format a tool result for display.
 */
export function formatToolResult(name, output, success) {
  const status = success ? '✓' : '✗';
  const outputStr = typeof output === 'object' ? JSON.stringify(output) : String(output);
  return `[tool: ${name}] ${status} Output: ${truncate(outputStr, 500)}`;
}

/**
 * Normalize an error to a string.
 */
export function formatError(error) {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  if (typeof error === 'object') return JSON.stringify(error);
  return String(error);
}
