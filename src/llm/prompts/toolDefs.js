/**
 * Convert registered tools into the OpenAI function calling format.
 * This is the canonical format; providers normalize from this.
 */
export function getToolDefinitions(registry) {
  const tools = registry.getAllTools();

  return tools.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters || { type: 'object', properties: {}, required: [] }
    }
  }));
}

export default { getToolDefinitions };
