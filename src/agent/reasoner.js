import * as llmClient from '../llm/client.js';
import logger from '../utils/logger.js';

/**
 * Reasoner: wraps the LLM client for the agent loop.
 * Accepts messages + tool definitions, returns an async generator of events.
 */

/**
 * Call the LLM with messages and tool definitions.
 * Returns an async generator yielding { type: "token"|"tool_call"|"done", ... }
 */
export async function* think(messages, tools, options = {}) {
  logger.debug(`Reasoner: thinking with ${messages.length} messages and ${tools?.length || 0} tools`);

  try {
    const gen = llmClient.chat(messages, tools, options);
    for await (const event of gen) {
      yield event;
    }
  } catch (err) {
    logger.error(`Reasoner error: ${err.message}`);
    yield { type: 'error', error: err.message };
  }
}

export default { think };
