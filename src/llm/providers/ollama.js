import logger from '../../utils/logger.js';

/**
 * Ollama local provider using fetch against the Ollama REST API.
 */

/**
 * Stream chat completion with tool support.
 * Yields { type: "token", content } or { type: "tool_call", id, name, input } or { type: "done", usage }
 */
export async function* chat(messages, tools, options = {}) {
  const config = options.config;
  const baseURL = (config.llm.baseURL || 'http://localhost:11434').replace(/\/+$/, '');
  const model = config.llm.model || 'qwen3.5:397b-cloud';

  // Pre-process messages for Ollama compatibility:
  // 1. Ollama expects tool_calls arguments as an object, not a JSON string (OpenAI format)
  // 2. Tool result content must not look like a raw JSON object (Ollama tries to parse it)
  // 3. Strip curly braces from tool content to prevent Ollama's parser from choking
  const cleanMessages = messages.map(msg => {
    // Convert assistant tool_calls arguments from JSON string to object
    if (msg.role === 'assistant' && msg.tool_calls) {
      return {
        ...msg,
        content: msg.content || '',
        tool_calls: msg.tool_calls.map(tc => ({
          ...tc,
          function: {
            name: tc.function.name,
            arguments: typeof tc.function.arguments === 'string'
              ? (() => { try { return JSON.parse(tc.function.arguments); } catch { return {}; } })()
              : tc.function.arguments
          }
        }))
      };
    }
    // Sanitize tool result content — replace curly braces to prevent Ollama's JSON parser issues
    if (msg.role === 'tool') {
      const safeContent = String(msg.content || '')
        .replace(/\{/g, '(')
        .replace(/\}/g, ')');
      return { ...msg, content: safeContent };
    }
    // Handle vision messages — Ollama uses an `images` field with base64 arrays
    if (msg.role === 'user' && msg.images && Array.isArray(msg.images)) {
      return {
        role: 'user',
        content: msg.content || '',
        images: msg.images
      };
    }
    return msg;
  });

  // When tools are available, use non-streaming mode to get complete tool_call data.
  // Ollama's streaming mode often splits tool_calls across chunks, causing empty names.
  const useStreaming = !(tools && tools.length > 0);

  const body = {
    model,
    messages: cleanMessages,
    stream: useStreaming
  };

  if (tools && tools.length > 0) {
    // Convert OpenAI-format tools to Ollama format
    body.tools = tools.map(t => ({
      type: 'function',
      function: {
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters
      }
    }));
  }

  if (options.temperature !== undefined) body.options = { ...body.options, temperature: options.temperature };

  // Set generous context window for large models
  body.options = { ...body.options, num_ctx: body.options?.num_ctx || 32768 };

  logger.debug(`Ollama chat request: model=${model}, messages=${cleanMessages.length}, tools=${tools?.length || 0}`);

  // Log message roles for debugging
  for (const m of cleanMessages) {
    const preview = typeof m.content === 'string' ? m.content.substring(0, 80) : '(no content)';
    logger.debug(`  msg[${m.role}]: ${preview}${m.tool_calls ? ` +${m.tool_calls.length} tool_calls` : ''}`);
  }

  try {
    const response = await fetch(`${baseURL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const errText = await response.text();
      const isCloud = model.includes('cloud') || model.includes(':cloud');
      const hint = response.status === 500 && isCloud
        ? ' (remote cloud model — this may be a transient server error, retry may help)'
        : response.status === 404
          ? ` (model "${model}" not found — run: ollama pull ${model})`
          : '';
      throw new Error(`Ollama API error ${response.status}${hint}: ${errText}`);
    }

    // --- Non-streaming mode (when tools are present) ---
    if (!useStreaming) {
      const data = await response.json();
      const msg = data.message || {};

      // Yield text content
      if (msg.content) {
        yield { type: 'token', content: msg.content };
      }

      // Yield tool calls
      if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          const fnName = tc.function?.name?.trim();
          const fnArgs = tc.function?.arguments || {};
          logger.debug(`Ollama tool_call: name="${fnName}", args=${JSON.stringify(fnArgs).substring(0, 200)}`);
          if (!fnName) {
            logger.debug('Ollama returned tool_call with empty name, skipping.');
            continue;
          }
          yield {
            type: 'tool_call',
            id: `ollama_tc_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
            name: fnName,
            input: fnArgs
          };
        }
      }

      yield {
        type: 'done',
        content: msg.content || '',
        usage: {
          prompt_tokens: data.prompt_eval_count,
          completion_tokens: data.eval_count,
          total_tokens: (data.prompt_eval_count || 0) + (data.eval_count || 0)
        }
      };
      return;
    }

    // --- Streaming mode (plain text, no tools) ---
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullContent = '';
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;

        let parsed;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }

        if (parsed.message?.content) {
          fullContent += parsed.message.content;
          yield { type: 'token', content: parsed.message.content };
        }

        if (parsed.done) {
          yield {
            type: 'done',
            content: fullContent,
            usage: {
              prompt_tokens: parsed.prompt_eval_count,
              completion_tokens: parsed.eval_count,
              total_tokens: (parsed.prompt_eval_count || 0) + (parsed.eval_count || 0)
            }
          };
        }
      }
    }

    // Process remaining buffer
    if (buffer.trim()) {
      try {
        const parsed = JSON.parse(buffer);
        if (parsed.message?.content) {
          fullContent += parsed.message.content;
          yield { type: 'token', content: parsed.message.content };
        }
        if (parsed.done) {
          yield { type: 'done', content: fullContent, usage: null };
        }
      } catch { /* ignore incomplete JSON */ }
    }
  } catch (err) {
    logger.error(`Ollama chat error: ${err.message}`);
    throw err;
  }
}

/**
 * Generate embeddings for text using Ollama's embedding endpoint.
 */
const EMBED_MODELS = ['nomic-embed-text', 'all-minilm', 'mxbai-embed-large'];
let resolvedEmbedModel = null;

export async function embed(text, config) {
  const baseURL = (config.llm.baseURL || 'http://localhost:11434').replace(/\/+$/, '');
  const configEmbedModel = config.llm?.embedModel;

  // If we already know which model works, use it
  const modelsToTry = resolvedEmbedModel
    ? [resolvedEmbedModel]
    : configEmbedModel
      ? [configEmbedModel, ...EMBED_MODELS]
      : EMBED_MODELS;

  let lastError = null;

  for (const model of modelsToTry) {
    try {
      const response = await fetch(`${baseURL}/api/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, prompt: text })
      });

      if (!response.ok) {
        const errText = await response.text();
        lastError = new Error(`Ollama embed error ${response.status} (model=${model}): ${errText}`);
        logger.debug(`Embed model '${model}' not available, trying next...`);
        continue;
      }

      const data = await response.json();
      if (data.embedding && data.embedding.length > 0) {
        if (!resolvedEmbedModel) {
          resolvedEmbedModel = model;
          logger.info(`Embedding model resolved: ${model} (dim=${data.embedding.length})`);
        }
        return data.embedding;
      }
    } catch (err) {
      lastError = err;
      logger.debug(`Embed model '${model}' failed: ${err.message}`);
    }
  }

  throw lastError || new Error('No embedding model available. Pull one with: ollama pull nomic-embed-text');
}

export default { chat, embed };
