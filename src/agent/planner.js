import * as llmClient from '../llm/client.js';
import logger from '../utils/logger.js';

/**
 * Task planner: decomposes complex tasks into numbered steps.
 */

const PLANNING_PROMPT = `You are a meticulous task planner for an AI agent that has access to filesystem, shell, browser, HTTP, databases, git, and code execution tools. Decompose the following task into clear, actionable numbered steps. Each step should map to one or a few tool calls. Be specific — include file paths, commands, URLs, or search queries where you can infer them. Only output the numbered list, nothing else.`;

const COMPLEX_TRIGGERS = [
  'create', 'build', 'set up', 'setup', 'deploy', 'update and', 'install',
  'configure', 'migrate', 'refactor', 'implement', 'analyze', 'debug',
  'review', 'optimize', 'benchmark', 'compare', 'research', 'find all',
  'write a', 'generate', 'scan', 'audit', 'fix all', 'convert',
  'restructure', 'automate', 'scrape', 'monitor', 'test'
];

/**
 * Determine if a task should be planned.
 */
function shouldPlan(taskInput) {
  if (taskInput.length > 200) return true;
  const lower = taskInput.toLowerCase();
  return COMPLEX_TRIGGERS.some(trigger => lower.includes(trigger));
}

/**
 * Generate a plan for a complex task.
 * @returns {{ steps: string[], raw: string } | null}
 */
export async function plan(taskInput) {
  if (!shouldPlan(taskInput)) {
    logger.debug('Planner: task is simple, skipping planning.');
    return null;
  }

  logger.info('Planner: decomposing complex task into steps...');

  try {
    const messages = [
      { role: 'system', content: PLANNING_PROMPT },
      { role: 'user', content: `Task: ${taskInput}` }
    ];

    let raw = '';
    const gen = llmClient.chat(messages, [], { temperature: 0.3 });

    for await (const event of gen) {
      if (event.type === 'token') {
        raw += event.content;
      }
    }

    // Parse numbered steps
    const steps = raw
      .split('\n')
      .map(line => line.trim())
      .filter(line => /^\d+[\.\)]\s/.test(line))
      .map(line => line.replace(/^\d+[\.\)]\s*/, ''));

    if (steps.length === 0) {
      logger.debug('Planner: could not parse steps from LLM response.');
      return null;
    }

    logger.info(`Planner: generated ${steps.length} steps.`);
    return { steps, raw };
  } catch (err) {
    logger.warn(`Planner failed: ${err.message}. Proceeding without plan.`);
    return null;
  }
}

export default { plan };
