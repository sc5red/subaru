import logger from '../utils/logger.js';

let provider = null;
let activeConfig = null;

/**
 * Initialize the LLM client with the given config.
 */
export async function init(config) {
  activeConfig = config;
  const providerName = config.llm.provider || 'ollama';

  logger.info(`Initializing LLM provider: ${providerName}`);

  switch (providerName.toLowerCase()) {
    case 'openai':
      provider = await import('./providers/openai.js');
      break;
    case 'ollama':
      provider = await import('./providers/ollama.js');
      break;
    case 'anthropic':
      provider = await import('./providers/anthropic.js');
      break;
    default:
      throw new Error(`Unknown LLM provider: ${providerName}`);
  }

  logger.info(`LLM provider loaded: ${providerName}, model: ${config.llm.model}`);
}

/**
 * Stream chat completion.
 * Returns an async generator yielding { type: "token"|"tool_call"|"done", ... }
 */
export async function* chat(messages, tools, options = {}) {
  if (!provider) throw new Error('LLM client not initialized. Call init() first.');

  const mergedOptions = { ...options, config: activeConfig };
  let retries = 0;
  const maxRetries = 3;

  while (retries <= maxRetries) {
    try {
      const gen = provider.chat(messages, tools, mergedOptions);
      for await (const event of gen) {
        yield event;
      }
      return; // Success, exit retry loop
    } catch (err) {
      retries++;
      if (retries > maxRetries) {
        logger.error(`LLM chat failed after ${maxRetries} retries: ${err.message}`);
        throw err;
      }
      const delay = Math.pow(2, retries) * 1000;
      logger.warn(`LLM chat error (attempt ${retries}/${maxRetries}), retrying in ${delay}ms: ${err.message}`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

/**
 * Generate an embedding for text.
 * Returns a float array.
 */
let embedWarned = false;
export async function embed(text) {
  if (!provider) throw new Error('LLM client not initialized. Call init() first.');

  try {
    return await provider.embed(text, activeConfig);
  } catch (err) {
    if (!embedWarned) {
      embedWarned = true;
      logger.warn(`Embedding unavailable: ${err.message}. Long-term memory will use fallback similarity.`);
    }
    throw err;
  }
}

/**
 * Get the active provider name.
 */
export function getProviderName() {
  return activeConfig?.llm?.provider || 'unknown';
}

/**
 * Get the active model name.
 */
export function getModelName() {
  return activeConfig?.llm?.model || 'unknown';
}

export default { init, chat, embed, getProviderName, getModelName };
