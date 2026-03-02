import readline from 'node:readline';
import logger from '../utils/logger.js';

// In-memory map of pending confirmations for web/telegram
const pendingConfirmations = new Map();

/**
 * Create a confirmation handler for the given interface type.
 * Returns an async function that resolves to true (approved) or false (denied).
 */
export function createConfirmationHandler(interfaceType) {
  switch (interfaceType) {
    case 'cli':
      return createCLIConfirmation();
    case 'web':
      return createWebConfirmation();
    case 'telegram':
      return createTelegramConfirmation();
    default:
      return async () => false;
  }
}

function createCLIConfirmation() {
  return async (description) => {
    return new Promise((resolve) => {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
      });

      const timeout = setTimeout(() => {
        logger.warn('Confirmation timed out (30s) — auto-denied.');
        rl.close();
        resolve(false);
      }, 30000);

      rl.question(`\n[CONFIRM] ${description} (y/n): `, (answer) => {
        clearTimeout(timeout);
        rl.close();
        const approved = answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes';
        if (!approved) logger.info('User denied the operation.');
        resolve(approved);
      });
    });
  };
}

function createWebConfirmation() {
  return async (description) => {
    const confirmationId = `conf_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        pendingConfirmations.delete(confirmationId);
        logger.warn(`Web confirmation timed out (30s) for: ${description}`);
        resolve(false);
      }, 30000);

      pendingConfirmations.set(confirmationId, {
        description,
        resolve: (approved) => {
          clearTimeout(timeout);
          pendingConfirmations.delete(confirmationId);
          resolve(approved);
        },
        confirmationId
      });

      // The web route handler will emit a confirmation_required event
      // and the web client will POST to /api/confirm/:confirmationId
    });
  };
}

function createTelegramConfirmation() {
  return async (description) => {
    // For Telegram, confirmation is handled via inline keyboard in the handler.
    // This returns a promise that will be resolved externally.
    const confirmationId = `tg_conf_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        pendingConfirmations.delete(confirmationId);
        logger.warn(`Telegram confirmation timed out (30s) for: ${description}`);
        resolve(false);
      }, 30000);

      pendingConfirmations.set(confirmationId, {
        description,
        resolve: (approved) => {
          clearTimeout(timeout);
          pendingConfirmations.delete(confirmationId);
          resolve(approved);
        },
        confirmationId
      });
    });
  };
}

/**
 * Resolve a pending confirmation by ID.
 */
export function resolveConfirmation(confirmationId, approved) {
  const pending = pendingConfirmations.get(confirmationId);
  if (pending) {
    pending.resolve(approved);
    return true;
  }
  return false;
}

/**
 * Get all pending confirmations (for web UI).
 */
export function getPendingConfirmations() {
  return Array.from(pendingConfirmations.values()).map(c => ({
    confirmationId: c.confirmationId,
    description: c.description
  }));
}

export default { createConfirmationHandler, resolveConfirmation, getPendingConfirmations };
