import { EventEmitter } from 'node:events';
import * as shortTerm from '../memory/shortTerm.js';
import * as longTerm from '../memory/longTerm.js';
import { buildSystemPrompt } from '../llm/prompts/system.js';
import { getToolDefinitions } from '../llm/prompts/toolDefs.js';
import * as registry from '../tools/registry.js';
import * as reasoner from '../agent/reasoner.js';
import * as executor from '../agent/executor.js';
import * as planner from '../agent/planner.js';
import eventBus from '../utils/events.js';
import logger from '../utils/logger.js';
import config from '../config/config.js';

const MAX_LOOPS = 25;
const MAX_TOOL_RESULT_LENGTH = 12000;

/**
 * Truncate tool result content to avoid oversized messages breaking the LLM API.
 */
function truncateToolResult(content, maxLen = MAX_TOOL_RESULT_LENGTH) {
  if (typeof content !== 'string') content = String(content);
  if (content.length <= maxLen) return content;
  return content.substring(0, maxLen) + '\n... [truncated, ' + content.length + ' chars total]';
}

/**
 * Run the agent for a given task.
 * @param {string} taskInput - The user's message
 * @param {string} sessionId - The session identifier
 * @param {EventEmitter} emitter - Emitter for streaming events back to interface
 * @param {Object} options - { confirmationFn }
 */
export async function run(taskInput, sessionId, emitter, options = {}) {
  const { confirmationFn, images } = options;

  emitter = emitter || new EventEmitter();
  eventBus.emit('agent:start', { sessionId, taskInput });

  try {
    // 1. Load short-term memory
    const history = shortTerm.getHistory(sessionId);

    // 2. Recall long-term memories
    let recalledMemories = [];
    if (config.memory?.longTermEnabled) {
      try {
        recalledMemories = await longTerm.recall(taskInput, 3, config.memory?.vectorSimilarityThreshold || 0.75);
      } catch (err) {
        logger.debug(`Long-term recall skipped: ${err.message}`);
      }
    }

    // 3. Plan if task is complex
    let planResult = null;
    try {
      planResult = await planner.plan(taskInput);
    } catch (err) {
      logger.debug(`Planning skipped: ${err.message}`);
    }

    // 4. Build system prompt
    const tools = registry.getAllTools();
    let systemPrompt = buildSystemPrompt(tools);

    // Inject remembered context
    if (recalledMemories.length > 0) {
      const memContext = recalledMemories.map(m => `[Memory, similarity=${m.similarity.toFixed(2)}] ${m.text}`).join('\n');
      systemPrompt += `\n\nRelevant memories from past conversations:\n${memContext}`;
    }

    // Inject plan if generated
    if (planResult) {
      const planText = planResult.steps.map((s, i) => `${i + 1}. ${s}`).join('\n');
      systemPrompt += `\n\nPlan for this task:\n${planText}\n\nFollow these steps in order.`;
    }

    // 5. Build messages array
    const messages = [
      { role: 'system', content: systemPrompt }
    ];

    // Add conversation history
    for (const msg of history) {
      const msgCopy = { role: msg.role, content: msg.content };
      if (msg.tool_call_id) msgCopy.tool_call_id = msg.tool_call_id;
      if (msg.name) msgCopy.name = msg.name;
      if (msg.tool_calls) msgCopy.tool_calls = msg.tool_calls;
      messages.push(msgCopy);
    }

    // Add new user message (with optional images for vision)
    const userMessage = { role: 'user', content: taskInput };
    if (images && images.length > 0) {
      userMessage.images = images;
    }
    messages.push(userMessage);
    shortTerm.addMessage(sessionId, 'user', taskInput, config.memory?.shortTermMaxMessages);

    // 6. Get tool definitions
    const toolDefs = getToolDefinitions(registry);

    // 7. Agent loop
    let loopCount = 0;
    let fullResponse = '';
    const context = {
      config,
      logger,
      confirmationFn: confirmationFn || (async () => true),
      sessionId
    };

    while (loopCount < MAX_LOOPS) {
      loopCount++;
      logger.debug(`Agent loop iteration ${loopCount}`);

      // Call reasoner
      const gen = reasoner.think(messages, toolDefs);

      let assistantContent = '';
      const toolCallsInThisTurn = [];
      let hadError = false;

      for await (const event of gen) {
        switch (event.type) {
          case 'token':
            assistantContent += event.content;
            fullResponse += event.content;
            emitter.emit('token', { content: event.content });
            eventBus.emit('agent:token', { sessionId, content: event.content });
            break;

          case 'tool_call':
            toolCallsInThisTurn.push(event);
            emitter.emit('tool_call', { tool: event.name, input: event.input });
            eventBus.emit('agent:tool_call', { sessionId, tool: event.name, input: event.input });
            break;

          case 'done':
            logger.debug(`Reasoner done. Usage: ${JSON.stringify(event.usage)}`);
            break;

          case 'error':
            hadError = true;
            emitter.emit('error', { message: event.error });
            eventBus.emit('agent:error', { sessionId, error: event.error });
            break;
        }
      }

      if (hadError && toolCallsInThisTurn.length === 0) {
        break;
      }

      // If no tool calls, we're done
      if (toolCallsInThisTurn.length === 0) {
        // Save assistant response to history
        shortTerm.addMessage(sessionId, 'assistant', assistantContent, config.memory?.shortTermMaxMessages);
        break;
      }

      // Filter out tool calls with empty or missing names
      const validToolCalls = toolCallsInThisTurn.filter(tc => {
        if (!tc.name || !tc.name.trim()) {
          logger.debug(`Skipping tool call with empty name. Input: ${JSON.stringify(tc.input).substring(0, 100)}`);
          return false;
        }
        return true;
      });

      if (validToolCalls.length === 0) {
        // All tool calls were invalid, treat as if no tool calls
        shortTerm.addMessage(sessionId, 'assistant', assistantContent, config.memory?.shortTermMaxMessages);
        break;
      }

      // Execute tool calls
      // Add assistant message with tool calls to messages
      const assistantMsg = {
        role: 'assistant',
        content: assistantContent || null,
        tool_calls: validToolCalls.map(tc => ({
          id: tc.id,
          type: 'function',
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.input)
          }
        }))
      };
      messages.push(assistantMsg);
      shortTerm.addAssistantToolCalls(
        sessionId,
        assistantContent,
        assistantMsg.tool_calls,
        config.memory?.shortTermMaxMessages
      );

      // Execute each tool call
      for (const tc of validToolCalls) {
        logger.info(`Executing tool: ${tc.name}`);

        const result = await executor.execute(tc, context);

        emitter.emit('tool_result', {
          tool: tc.name,
          output: result.content,
          success: !result.content?.includes('"success":false')
        });
        eventBus.emit('agent:tool_result', {
          sessionId,
          tool: tc.name,
          output: result.content
        });

        // Add tool result to messages (truncated to avoid LLM API errors)
        const truncatedContent = truncateToolResult(result.content);
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          name: tc.name,
          content: truncatedContent
        });
        shortTerm.addToolResult(
          sessionId,
          tc.id,
          tc.name,
          result.content,
          config.memory?.shortTermMaxMessages
        );
      }

      // Loop back to let the model continue reasoning with tool results
    }

    if (loopCount >= MAX_LOOPS) {
      const warning = '\n\n[Agent reached maximum loop iterations. Returning partial result.]';
      fullResponse += warning;
      emitter.emit('token', { content: warning });
      logger.warn('Agent reached maximum loop iterations.');
    }

    // 8. Emit done
    emitter.emit('done', { response: fullResponse });
    eventBus.emit('agent:done', { sessionId, response: fullResponse });

    // 9. Save to long-term memory
    if (config.memory?.longTermEnabled && fullResponse.trim()) {
      try {
        await longTerm.store(
          `User: ${taskInput}\nAssistant: ${fullResponse.substring(0, 500)}`,
          { sessionId, type: 'conversation' }
        );
      } catch (err) {
        logger.debug(`Long-term storage skipped: ${err.message}`);
      }
    }

    return fullResponse;
  } catch (err) {
    logger.error(`Agent error: ${err.message}`);
    emitter.emit('error', { message: err.message });
    eventBus.emit('agent:error', { sessionId, error: err.message });
    throw err;
  }
}

export default { run };
