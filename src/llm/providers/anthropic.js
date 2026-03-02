import Anthropic from '@anthropic-ai/sdk';
import logger from '../../utils/logger.js';

/**
 * Anthropic provider using the official SDK with streaming.
 */

let client = null;

function getClient(config) {
  if (!client) {
    client = new Anthropic({
      apiKey: config.llm.apiKey || ''
    });
  }
  return client;
}

/**
 * Convert OpenAI-format tools to Anthropic tool format.
 */
function convertTools(tools) {
  if (!tools || tools.length === 0) return undefined;
  return tools.map(t => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters
  }));
}

/**
 * Convert OpenAI-format messages to Anthropic format.
 * Anthropic requires separate system prompt and alternating user/assistant messages.
 */
function convertMessages(messages) {
  let system = '';
  const converted = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      system += (system ? '\n\n' : '') + msg.content;
    } else if (msg.role === 'tool') {
      // Anthropic expects tool results as user messages with tool_result content blocks
      converted.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: msg.tool_call_id,
          content: msg.content
        }]
      });
    } else if (msg.role === 'assistant' && msg.tool_calls) {
      // Convert assistant tool call messages
      const content = [];
      if (msg.content) {
        content.push({ type: 'text', text: msg.content });
      }
      for (const tc of msg.tool_calls) {
        content.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input: typeof tc.function.arguments === 'string'
            ? JSON.parse(tc.function.arguments)
            : tc.function.arguments
        });
      }
      converted.push({ role: 'assistant', content });
    } else if (msg.role === 'user' && msg.images && Array.isArray(msg.images) && msg.images.length > 0) {
      // Convert user messages with images to Anthropic vision format
      const content = [];
      for (const img of msg.images) {
        content.push({
          type: 'image',
          source: { type: 'base64', media_type: img.mimeType, data: img.data }
        });
      }
      if (msg.content) content.push({ type: 'text', text: msg.content });
      converted.push({ role: 'user', content });
    } else {
      converted.push({
        role: msg.role === 'user' ? 'user' : 'assistant',
        content: msg.content || ''
      });
    }
  }

  return { system, messages: converted };
}

/**
 * Stream chat completion with tool support.
 * Yields { type: "token", content } or { type: "tool_call", id, name, input } or { type: "done", usage }
 */
export async function* chat(messages, tools, options = {}) {
  const config = options.config;
  const anthropic = getClient(config);
  const model = config.llm.model || 'claude-sonnet-4-20250514';

  const { system, messages: convertedMessages } = convertMessages(messages);
  const anthropicTools = convertTools(tools);

  const params = {
    model,
    max_tokens: options.maxTokens || 4096,
    messages: convertedMessages,
    stream: true
  };

  if (system) params.system = system;
  if (anthropicTools) params.tools = anthropicTools;
  if (options.temperature !== undefined) params.temperature = options.temperature;

  logger.debug(`Anthropic chat request: model=${model}, messages=${convertedMessages.length}, tools=${anthropicTools?.length || 0}`);

  try {
    const stream = await anthropic.messages.stream(params);

    let fullContent = '';
    const toolCalls = {};
    let currentToolUse = null;

    for await (const event of stream) {
      if (event.type === 'content_block_start') {
        if (event.content_block?.type === 'tool_use') {
          currentToolUse = {
            id: event.content_block.id,
            name: event.content_block.name,
            input: ''
          };
        }
      } else if (event.type === 'content_block_delta') {
        if (event.delta?.type === 'text_delta') {
          fullContent += event.delta.text;
          yield { type: 'token', content: event.delta.text };
        } else if (event.delta?.type === 'input_json_delta' && currentToolUse) {
          currentToolUse.input += event.delta.partial_json;
        }
      } else if (event.type === 'content_block_stop') {
        if (currentToolUse) {
          let parsedInput = {};
          try {
            parsedInput = JSON.parse(currentToolUse.input);
          } catch {
            parsedInput = { raw: currentToolUse.input };
          }
          yield {
            type: 'tool_call',
            id: currentToolUse.id,
            name: currentToolUse.name,
            input: parsedInput
          };
          currentToolUse = null;
        }
      } else if (event.type === 'message_stop' || event.type === 'message_delta') {
        if (event.usage) {
          yield {
            type: 'done',
            content: fullContent,
            usage: {
              prompt_tokens: event.usage.input_tokens,
              completion_tokens: event.usage.output_tokens,
              total_tokens: (event.usage.input_tokens || 0) + (event.usage.output_tokens || 0)
            }
          };
        }
      }
    }

    // Ensure done is emitted
    const finalMessage = await stream.finalMessage();
    if (finalMessage) {
      yield {
        type: 'done',
        content: fullContent,
        usage: {
          prompt_tokens: finalMessage.usage?.input_tokens,
          completion_tokens: finalMessage.usage?.output_tokens,
          total_tokens: (finalMessage.usage?.input_tokens || 0) + (finalMessage.usage?.output_tokens || 0)
        }
      };
    }
  } catch (err) {
    logger.error(`Anthropic chat error: ${err.message}`);
    throw err;
  }
}

/**
 * Anthropic doesn't have a native embedding API, so throw an error.
 * The LLM client will fall back to keyword-based similarity.
 */
export async function embed(text, config) {
  throw new Error('Anthropic does not support embeddings. Using fallback keyword similarity.');
}

export default { chat, embed };
