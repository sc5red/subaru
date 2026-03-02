import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import logger from '../utils/logger.js';

const execAsync = promisify(exec);

let firejailAvailable = null;

async function checkFirejail() {
  if (firejailAvailable !== null) return firejailAvailable;
  try {
    await execAsync('firejail --version');
    firejailAvailable = true;
  } catch {
    firejailAvailable = false;
  }
  return firejailAvailable;
}

/**
 * Execute a command in a sandboxed environment if possible.
 * Falls back to normal exec if sandbox is unavailable.
 */
export async function sandboxedExec(command, cwd, timeout = 30000) {
  const hasFj = await checkFirejail();

  if (hasFj) {
    logger.debug('Executing command in firejail sandbox');
    const sandboxedCmd = `firejail --quiet --noprofile --net=none -- ${command}`;
    return execAsync(sandboxedCmd, { cwd, timeout });
  }

  // Check for Docker as alternative
  try {
    await execAsync('docker --version');
    logger.debug('Executing command in Docker sandbox');
    const escapedCmd = command.replace(/"/g, '\\"');
    const cwdMount = cwd ? `-v "${cwd}:/workspace" -w /workspace` : '';
    const dockerCmd = `docker run --rm --network none ${cwdMount} node:20-alpine sh -c "${escapedCmd}"`;
    return execAsync(dockerCmd, { timeout: timeout + 10000 });
  } catch {
    // No docker either
  }

  logger.warn('Sandbox enabled but no sandbox runtime found (firejail or docker). Falling back to normal execution.');
  return execAsync(command, { cwd, timeout });
}

export default { sandboxedExec };
