import readline from 'node:readline';
import { EventEmitter } from 'node:events';
import chalk from 'chalk';
import * as agent from '../agent/agent.js';
import * as shortTerm from '../memory/shortTerm.js';
import * as registry from '../tools/registry.js';
import { sanitizeConfig } from '../config/config.js';
import { createConfirmationHandler } from '../safety/confirmation.js';
import config from '../config/config.js';
import logger from '../utils/logger.js';

const SESSION_ID = 'cli_session';
let rl = null;
let isProcessing = false;
let spinnerInterval = null;

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
let spinnerIdx = 0;

function startSpinner(message = 'Thinking') {
  if (spinnerInterval) return;
  spinnerIdx = 0;
  spinnerInterval = setInterval(() => {
    process.stdout.write(`\r${chalk.cyan(SPINNER_FRAMES[spinnerIdx % SPINNER_FRAMES.length])} ${chalk.gray(message)}   `);
    spinnerIdx++;
  }, 80);
}

function stopSpinner() {
  if (spinnerInterval) {
    clearInterval(spinnerInterval);
    spinnerInterval = null;
    process.stdout.write('\r' + ' '.repeat(60) + '\r');
  }
}

const WELCOME = `
${chalk.cyan.bold('╔══════════════════════════════════════════════════╗')}
${chalk.cyan.bold('║')}  ${chalk.white.bold('S U B A R U')}  ${chalk.gray('— Local AI Assistant Agent')}     ${chalk.cyan.bold('║')}
${chalk.cyan.bold('╚══════════════════════════════════════════════════╝')}
${chalk.gray('Type a message to start. Use /help for commands.')}
`;

const HELP_TEXT = `
${chalk.cyan.bold('Available Commands:')}
  ${chalk.yellow('/clear')}    — Clear conversation memory
  ${chalk.yellow('/history')}  — Show recent conversation turns
  ${chalk.yellow('/config')}   — Show current config summary
  ${chalk.yellow('/tools')}    — List all loaded tools
  ${chalk.yellow('/help')}     — Show this help message
  ${chalk.yellow('/exit')}     — Gracefully shutdown
  ${chalk.yellow('/quit')}     — Gracefully shutdown
`;

function handleSlashCommand(input) {
  const cmd = input.trim().toLowerCase();

  switch (cmd) {
    case '/clear':
      shortTerm.clearHistory(SESSION_ID);
      console.log(chalk.green('✓ Conversation memory cleared.'));
      return true;

    case '/history': {
      const history = shortTerm.getHistory(SESSION_ID);
      if (history.length === 0) {
        console.log(chalk.gray('No conversation history.'));
      } else {
        console.log(chalk.cyan.bold('\nConversation History:'));
        for (const msg of history.slice(-20)) {
          const role = msg.role === 'user' ? chalk.yellow('You') :
                       msg.role === 'assistant' ? chalk.cyan('Subaru') :
                       chalk.gray(msg.role);
          const content = typeof msg.content === 'string' ? msg.content.substring(0, 200) : '(tool call)';
          console.log(`  ${role}: ${chalk.white(content)}`);
        }
      }
      return true;
    }

    case '/config': {
      const safe = sanitizeConfig(config);
      console.log(chalk.cyan.bold('\nCurrent Configuration:'));
      console.log(chalk.white(JSON.stringify(safe, null, 2)));
      return true;
    }

    case '/tools': {
      const tools = registry.getAllTools();
      console.log(chalk.cyan.bold('\nLoaded Tools:'));
      for (const tool of tools) {
        console.log(`  ${chalk.green('●')} ${chalk.yellow(tool.name)} — ${chalk.gray(tool.description.substring(0, 80))}`);
      }
      if (tools.length === 0) {
        console.log(chalk.gray('  No tools loaded.'));
      }
      return true;
    }

    case '/help':
      console.log(HELP_TEXT);
      return true;

    case '/exit':
    case '/quit':
      console.log(chalk.gray('\nGoodbye! Shutting down Subaru...\n'));
      if (rl) rl.close();
      process.exit(0);
      return true;

    default:
      return false;
  }
}

/**
 * Start the CLI interface.
 */
export function start() {
  console.log(WELCOME);

  const confirmationFn = createConfirmationHandler('cli');

  rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: chalk.cyan.bold('autonome> ')
  });

  rl.prompt();

  rl.on('line', async (line) => {
    const input = line.trim();
    if (!input) {
      rl.prompt();
      return;
    }

    // Handle slash commands
    if (input.startsWith('/')) {
      const handled = handleSlashCommand(input);
      if (handled) {
        rl.prompt();
        return;
      }
      console.log(chalk.red(`Unknown command: ${input}. Type /help for available commands.`));
      rl.prompt();
      return;
    }

    if (isProcessing) {
      console.log(chalk.yellow('Please wait — Subaru is still working...'));
      return;
    }

    isProcessing = true;
    startSpinner('Thinking');

    const emitter = new EventEmitter();
    let firstToken = true;

    emitter.on('token', ({ content }) => {
      if (firstToken) {
        stopSpinner();
        process.stdout.write('\n' + chalk.cyan('Subaru: '));
        firstToken = false;
      }
      process.stdout.write(chalk.white(content));
    });

    emitter.on('tool_call', ({ tool, input: toolInput }) => {
      stopSpinner();
      const inputStr = typeof toolInput === 'object' ? JSON.stringify(toolInput) : String(toolInput);
      console.log(`\n${chalk.yellow(`[tool: ${tool}]`)} ${chalk.gray('Running:')} ${chalk.white(inputStr.substring(0, 200))}`);
      startSpinner(`Executing ${tool}`);
    });

    emitter.on('tool_result', ({ tool, output, success }) => {
      stopSpinner();
      const status = success ? chalk.green('✓') : chalk.red('✗');
      const preview = typeof output === 'string' ? output.substring(0, 200) : '';
      console.log(`${chalk.yellow(`[tool: ${tool}]`)} ${status} ${chalk.gray(preview)}`);
      startSpinner('Thinking');
    });

    emitter.on('error', ({ message }) => {
      stopSpinner();
      console.log(`\n${chalk.red('Error:')} ${message}`);
    });

    emitter.on('done', () => {
      stopSpinner();
      if (!firstToken) {
        console.log('\n');
      }
    });

    try {
      await agent.run(input, SESSION_ID, emitter, { confirmationFn });
    } catch (err) {
      stopSpinner();
      console.log(`\n${chalk.red('Error:')} ${err.message}\n`);
    }

    isProcessing = false;
    rl.prompt();
  });

  rl.on('close', () => {
    stopSpinner();
    console.log(chalk.gray('\nSubaru CLI closed.'));
  });
}

export function stop() {
  if (rl) {
    rl.close();
    rl = null;
  }
  stopSpinner();
}

export default { start, stop };
