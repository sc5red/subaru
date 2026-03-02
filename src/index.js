import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __projectRoot = resolve(dirname(__filename), '..');
dotenv.config({ path: resolve(__projectRoot, '.env') });

import chalk from 'chalk';
import config from './config/config.js';
import logger from './utils/logger.js';
import * as shortTerm from './memory/shortTerm.js';
import * as longTerm from './memory/longTerm.js';
import * as preferences from './memory/preferences.js';
import * as registry from './tools/registry.js';
import * as llmClient from './llm/client.js';

const BANNER = `
${chalk.cyan.bold('  ███████╗██╗   ██╗██████╗  █████╗ ██████╗ ██╗   ██╗')}
${chalk.cyan.bold('  ██╔════╝██║   ██║██╔══██╗██╔══██╗██╔══██╗██║   ██║')}
${chalk.cyan.bold('  ███████╗██║   ██║██████╔╝███████║██████╔╝██║   ██║')}
${chalk.cyan.bold('  ╚════██║██║   ██║██╔══██╗██╔══██║██╔══██╗██║   ██║')}
${chalk.cyan.bold('  ███████║╚██████╔╝██████╔╝██║  ██║██║  ██║╚██████╔╝')}
${chalk.cyan.bold('  ╚══════╝ ╚═════╝ ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝ ╚═════╝')}
${chalk.gray('  Local AI Assistant Agent')}
`;

async function main() {
  console.log(BANNER);

  // 1. Config already loaded via import
  logger.info('Configuration loaded.');

  // 2. Logger already initialized via import
  logger.info('Logger initialized.');

  // 3. Initialize memory systems
  logger.info('Initializing memory systems...');

  try {
    preferences.init(config.tools?.database?.path || './data/memory.db');
  } catch (err) {
    logger.error(`Failed to initialize preferences: ${err.message}`);
  }

  // Initialize persistent conversation sessions
  try {
    shortTerm.initPersistence(config.tools?.database?.path || './data/memory.db');
    logger.info('Conversation persistence initialized.');
  } catch (err) {
    logger.warn(`Conversation persistence unavailable: ${err.message}`);
  }

  // 4. Initialize LLM client
  logger.info('Initializing LLM client...');
  try {
    await llmClient.init(config);
  } catch (err) {
    logger.error(`Failed to initialize LLM client: ${err.message}`);
    logger.warn('The agent will not work without an LLM provider. Check your configuration.');
  }

  // Initialize long-term memory with embed function
  try {
    await longTerm.init(async (text) => llmClient.embed(text));
    logger.info('Long-term memory initialized.');
  } catch (err) {
    logger.warn(`Long-term memory init issue: ${err.message}`);
    await longTerm.init(null);
  }

  // 5. Initialize tool registry
  logger.info('Loading tools...');
  await registry.loadTools(config);

  // 6. Print startup summary
  const tools = registry.getAllTools();
  const toolNames = tools.map(t => t.name).join(', ');

  console.log('');
  console.log(chalk.cyan('  ┌─────────────────────────────────────────────────┐'));
  console.log(chalk.cyan('  │') + chalk.white.bold('  Startup Summary                                 ') + chalk.cyan('│'));
  console.log(chalk.cyan('  ├─────────────────────────────────────────────────┤'));
  console.log(chalk.cyan('  │') + `  LLM Provider: ${chalk.white(config.llm.provider)} / ${chalk.white(config.llm.model)}`.padEnd(58) + chalk.cyan('│'));
  console.log(chalk.cyan('  │') + `  CLI: ${config.interfaces?.cli?.enabled ? chalk.green('enabled ✓') : chalk.red('disabled')}`.padEnd(58) + chalk.cyan('│'));
  console.log(chalk.cyan('  │') + `  Web Dashboard: ${config.interfaces?.web?.enabled ? chalk.green(`http://localhost:${config.interfaces.web.port} ✓`) : chalk.red('disabled')}`.padEnd(58) + chalk.cyan('│'));
  console.log(chalk.cyan('  │') + `  Telegram: ${config.interfaces?.telegram?.enabled ? chalk.green('enabled ✓') : chalk.yellow('disabled')}`.padEnd(58) + chalk.cyan('│'));
  console.log(chalk.cyan('  │') + `  Tools: ${chalk.white(tools.length)} loaded`.padEnd(49) + chalk.cyan('│'));
  console.log(chalk.cyan('  │') + `  Memory: ${chalk.white('short-term (in-memory), long-term (local vectors)')}`.padEnd(49) + chalk.cyan('│'));
  console.log(chalk.cyan('  └─────────────────────────────────────────────────┘'));
  console.log('');

  if (toolNames) {
    logger.info(`Tools: ${toolNames}`);
  }

  // 7. Start all enabled interfaces concurrently
  const startupPromises = [];

  // Web dashboard
  let webServer = null;
  if (config.interfaces?.web?.enabled) {
    startupPromises.push(
      import('./interfaces/web/server.js')
        .then(mod => mod.start(config.interfaces.web.port))
        .then(server => { webServer = server; })
        .catch(err => logger.error(`Web server failed: ${err.message}`))
    );
  }

  // Telegram
  let telegramBot = null;
  if (config.interfaces?.telegram?.enabled) {
    if (!config.interfaces.telegram.botToken) {
      logger.warn('Telegram is enabled but no bot token is configured. Set TELEGRAM_BOT_TOKEN in .env or botToken in subaru.config.json.');
    } else {
      startupPromises.push(
        import('./interfaces/telegram/bot.js')
          .then(async (botMod) => {
            telegramBot = botMod;
            const handlerMod = await import('./interfaces/telegram/handler.js');
            botMod.init(handlerMod.default);
          })
          .catch(err => logger.error(`Telegram bot failed: ${err.message}`))
      );
    }
  }

  // Wait for web and telegram to start
  await Promise.allSettled(startupPromises);

  // Register graceful shutdown
  registerShutdown({ webServer, telegramBot });

  // CLI (start last, it blocks on readline)
  if (config.interfaces?.cli?.enabled) {
    const cliMod = await import('./interfaces/cli.js');
    cliMod.start();
  } else {
    logger.info('CLI interface disabled. Subaru is running in background mode.');
    logger.info('Press Ctrl+C to stop.');
  }
}

// Graceful shutdown
let isShuttingDown = false;

function registerShutdown({ webServer, telegramBot }) {
  async function shutdown(signal) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(chalk.gray(`\n\nShutting down Subaru (${signal})...`));

    const tasks = [];

    // Stop CLI
    tasks.push(
      import('./interfaces/cli.js')
        .then(mod => mod.stop())
        .catch(() => {})
    );

    // Close web server
    if (webServer) {
      tasks.push(new Promise((resolve) => {
        webServer.close(() => {
          logger.info('Web server closed.');
          resolve();
        });
        setTimeout(resolve, 3000);
      }));
    }

    // Stop Telegram bot
    if (telegramBot?.stop) {
      tasks.push(
        Promise.resolve().then(() => telegramBot.stop())
          .then(() => logger.info('Telegram bot stopped.'))
          .catch(() => {})
      );
    }

    // Close browser
    tasks.push(
      import('./tools/browser.js')
        .then(mod => {
          const tools = mod.default || [];
          const closeTool = tools.find(t => t.name === 'browser_close');
          if (closeTool) return closeTool.execute({}, {});
        })
        .then(() => logger.info('Browser closed.'))
        .catch(() => {})
    );

    // Close preferences DB
    tasks.push(
      Promise.resolve().then(() => {
        const db = preferences.getDb();
        if (db) {
          db.close();
          logger.info('Database closed.');
        }
      }).catch(() => {})
    );

    await Promise.allSettled(tasks);
    console.log(chalk.gray('Goodbye.\n'));
    process.exit(0);
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// Handle unhandled rejections
process.on('unhandledRejection', (reason, promise) => {
  logger.error(`Unhandled rejection: ${reason?.message || reason}`);
});

process.on('uncaughtException', (err) => {
  logger.error(`Uncaught exception: ${err.message}`);
  logger.error(err.stack);
  process.exit(1);
});

main().catch((err) => {
  logger.error(`Fatal startup error: ${err.message}`);
  logger.error(err.stack);
  process.exit(1);
});
