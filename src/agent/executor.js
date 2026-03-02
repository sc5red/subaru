import Ajv from 'ajv';
import * as registry from '../tools/registry.js';
import { checkPath } from '../safety/permissions.js';
import { checkCommand } from '../safety/permissions.js';
import logger from '../utils/logger.js';

const ajv = new Ajv({ allErrors: true, coerceTypes: true });

/**
 * Execute a tool call.
 * @param {Object} toolCall - { id, name, input }
 * @param {Object} context - { config, logger, confirmationFn, sessionId }
 * @returns {Object} - Tool result in OpenAI format
 */
export async function execute(toolCall, context) {
  const { id, name, input } = toolCall;

  logger.debug(`Executor: executing tool ${name}`, input);

  // Look up tool
  const tool = registry.getTool(name);
  if (!tool) {
    logger.warn(`Tool not found: ${name}`);
    return {
      tool_call_id: id,
      role: 'tool',
      name,
      content: JSON.stringify({ success: false, error: `Tool not found: ${name}` })
    };
  }

  // Validate input against schema
  if (tool.parameters) {
    const validate = ajv.compile(tool.parameters);
    const valid = validate(input);
    if (!valid) {
      const errors = validate.errors?.map(e => `${e.instancePath || '/'}: ${e.message}`).join(', ');
      logger.warn(`Tool ${name} input validation failed: ${errors}`);
      return {
        tool_call_id: id,
        role: 'tool',
        name,
        content: JSON.stringify({ success: false, error: `Validation error: ${errors}` })
      };
    }
  }

  // Execute the tool
  try {
    const result = await tool.execute(input, context);

    logger.debug(`Tool ${name} result: success=${result.success}`);

    return {
      tool_call_id: id,
      role: 'tool',
      name,
      content: typeof result === 'string' ? result : JSON.stringify(result)
    };
  } catch (err) {
    logger.error(`Tool ${name} threw an exception: ${err.message}`);
    return {
      tool_call_id: id,
      role: 'tool',
      name,
      content: JSON.stringify({ success: false, error: err.message })
    };
  }
}

export default { execute };
