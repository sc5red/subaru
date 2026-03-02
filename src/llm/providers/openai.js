import OpenAI from 'openai';
import logger from '../../utils/logger.js';

/**
 * OpenAI-compatible provider (works with OpenAI, Azure OpenAI, local proxies, etc.)
 */

let client = null;

function getClient(config) {
  if (!client) {
    client = new OpenAI({
      apiKey: config.llm.apiKey || 'sk-placeholder',
      baseURL: config.llm.baseURL || 'https://api.openai.com/v1'
    });
  }
  return client;
}

/**
 * Stream chat completion with tool support.
 * Yields { type: "token", content } or { type: "tool_call", id, name, input } or { type: "done", usage }
 */
export async function* chat(messages, tools, options = {}) {
  const config = options.config;
  const openai = getClient(config);

  const params = {
    model: config.llm.model || 'gpt-4',
    messages: messages.map(msg => {
      // Convert user messages with images to OpenAI vision format
      if (msg.role === 'user' && msg.images && Array.isArray(msg.images) && msg.images.length > 0) {
        const content = [];
        if (msg.content) content.push({ type: 'text', text: msg.content });
        for (const img of msg.images) {
          content.push({
            type: 'image_url',
            image_url: { url: `data:${img.mimeType};base64,${img.data}` }
          });
        }
        return { role: 'user', content };
      }
      return msg;
    }),
    stream: true
  };

  if (tools && tools.length > 0) {
    params.tools = tools;
    params.tool_choice = 'auto';
  }

  if (options.temperature !== undefined) params.temperature = options.temperature;
  if (options.maxTokens) params.max_tokens = options.maxTokens;

  logger.debug(`OpenAI chat request: model=${params.model}, messages=${messages.length}, tools=${tools?.length || 0}`);

  try {
    const stream = await openai.chat.completions.create(params);

    let fullContent = '';
    const toolCalls = {};
    let finishReason = null;

    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta;
      finishReason = chunk.choices?.[0]?.finish_reason || finishReason;

      if (!delta) continue;

      // Text content
      if (delta.content) {
        fullContent += delta.content;
        yield { type: 'token', content: delta.content };
      }

      // Tool calls (accumulated from streaming deltas)
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index;
          if (!toolCalls[idx]) {
            toolCalls[idx] = { id: tc.id || '', name: '', input: '' };
          }
          if (tc.id) toolCalls[idx].id = tc.id;
          if (tc.function?.name) toolCalls[idx].name = tc.function.name;
          if (tc.function?.arguments) toolCalls[idx].input += tc.function.arguments;
        }
      }
    }

    // Emit completed tool calls
    for (const idx of Object.keys(toolCalls).sort((a, b) => a - b)) {
      const tc = toolCalls[idx];
      let parsedInput = {};
      try {
        parsedInput = JSON.parse(tc.input);
      } catch {
        parsedInput = { raw: tc.input };
      }
      yield { type: 'tool_call', id: tc.id, name: tc.name, input: parsedInput };
    }

    yield { type: 'done', content: fullContent, usage: chunk?.usage || null };
  } catch (err) {
    logger.error(`OpenAI chat error: ${err.message}`);
    throw err;
  }
}

/**
 * Generate embeddings for text.
 */
export async function embed(text, config) {
  const openai = getClient(config);

  try {
    const response = await openai.embeddings.create({
      model: 'text-embedding-ada-002',
      input: text
    });
    return response.data[0].embedding;
  } catch (err) {
    logger.error(`OpenAI embed error: ${err.message}`);
    throw err;
  }
}

export default { chat, embed };
