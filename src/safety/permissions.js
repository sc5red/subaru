import path from 'node:path';
import os from 'node:os';

/**
 * Resolve ~ to the user's home directory and normalize the path.
 */
function resolvePath(p) {
  if (p.startsWith('~')) {
    p = path.join(os.homedir(), p.slice(1));
  }
  return path.resolve(p);
}

/**
 * Check if a file path is allowed by the config.
 * Must be inside at least one allowedPath and not inside any blockedPath.
 */
export function checkPath(filePath, config) {
  const resolved = resolvePath(filePath);
  const toolConfig = config.tools?.filesystem || {};
  const allowedPaths = (toolConfig.allowedPaths || []).map(resolvePath);
  const blockedPaths = (toolConfig.blockedPaths || []).map(resolvePath);

  // Check blocked paths first
  for (const blocked of blockedPaths) {
    if (resolved === blocked || resolved.startsWith(blocked + path.sep)) {
      return { allowed: false, reason: `Path is blocked: ${filePath} matches blocked path ${blocked}` };
    }
  }

  // Check allowed paths
  if (allowedPaths.length === 0) {
    return { allowed: true, reason: 'No path restrictions configured.' };
  }

  for (const allowed of allowedPaths) {
    if (resolved === allowed || resolved.startsWith(allowed + path.sep)) {
      return { allowed: true, reason: `Path is within allowed directory: ${allowed}` };
    }
  }

  return { allowed: false, reason: `Path ${filePath} is not within any allowed directory. Allowed: ${allowedPaths.join(', ')}` };
}

/**
 * Check if a shell command is allowed by the config.
 */
export function checkCommand(command, config) {
  const toolConfig = config.tools?.shell || {};
  const blockedCommands = toolConfig.blockedCommands || [];

  for (const blocked of blockedCommands) {
    if (command.includes(blocked)) {
      return { allowed: false, reason: `Command contains blocked pattern: "${blocked}"` };
    }
  }

  return { allowed: true, reason: 'Command passed safety check.' };
}
