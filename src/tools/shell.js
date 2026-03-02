import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { checkCommand } from '../safety/permissions.js';
import { sandboxedExec } from '../safety/sandbox.js';
import logger from '../utils/logger.js';

const execAsync = promisify(exec);

const tools = [
  {
    name: 'run_command',
    description: 'Execute a shell command in a given working directory. Returns stdout and stderr. Use for any system command, file operations, installations, etc.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to execute' },
        cwd: { type: 'string', description: 'Working directory for the command (optional)' },
        timeout: { type: 'number', description: 'Timeout in milliseconds (default: 30000)' }
      },
      required: ['command']
    },
    async execute(input, context) {
      const { command, cwd, timeout } = input;
      const config = context.config;
      const timeoutMs = timeout || config.tools?.shell?.timeout || 30000;

      // Safety check
      const safety = checkCommand(command, config);
      if (!safety.allowed) {
        return { success: false, output: '', error: `Blocked: ${safety.reason}` };
      }

      // Confirmation check
      if (config.tools?.shell?.requireConfirmation && config.safety?.confirmDangerousCommands && context.confirmationFn) {
        try {
          const approved = await context.confirmationFn(`Run command: ${command}`);
          if (!approved) {
            return { success: false, output: '', error: 'Command execution denied by user.' };
          }
        } catch (err) {
          logger.warn(`Confirmation error: ${err.message}. Proceeding without confirmation.`);
        }
      }

      try {
        let result;
        if (config.safety?.sandboxShell) {
          result = await sandboxedExec(command, cwd, timeoutMs);
        } else {
          result = await execAsync(command, {
            cwd: cwd || process.cwd(),
            timeout: timeoutMs,
            maxBuffer: 1024 * 1024 * 5, // 5MB
            shell: process.platform === 'win32' ? 'powershell.exe' : '/bin/sh'
          });
        }

        const output = [
          result.stdout ? `stdout:\n${result.stdout.trim()}` : '',
          result.stderr ? `stderr:\n${result.stderr.trim()}` : ''
        ].filter(Boolean).join('\n\n');

        return { success: true, output: output || '(no output)' };
      } catch (err) {
        const output = [
          err.stdout ? `stdout:\n${err.stdout.trim()}` : '',
          err.stderr ? `stderr:\n${err.stderr.trim()}` : ''
        ].filter(Boolean).join('\n\n');

        return {
          success: false,
          output: output || '',
          error: err.message
        };
      }
    }
  },
  {
    name: 'run_script',
    description: 'Write a temporary script file and execute it with the specified interpreter (bash, node, python, etc.).',
    parameters: {
      type: 'object',
      properties: {
        script: { type: 'string', description: 'The script content to execute' },
        interpreter: { type: 'string', description: 'The interpreter to use (e.g., "node", "bash", "python3"). Default: "node"' }
      },
      required: ['script']
    },
    async execute(input, context) {
      const { script, interpreter = 'node' } = input;
      const config = context.config;
      const timeoutMs = config.tools?.shell?.timeout || 30000;

      // Safety check on the script content
      const safety = checkCommand(script, config);
      if (!safety.allowed) {
        return { success: false, output: '', error: `Blocked: ${safety.reason}` };
      }

      const ext = interpreter.includes('node') ? '.js' :
                   interpreter.includes('python') ? '.py' :
                   interpreter.includes('bash') || interpreter.includes('sh') ? '.sh' : '.tmp';

      const tmpFile = path.join(os.tmpdir(), `subaru_script_${Date.now()}${ext}`);

      try {
        fs.writeFileSync(tmpFile, script, 'utf-8');

        let result;
        const cmd = `${interpreter} "${tmpFile}"`;

        if (config.safety?.sandboxShell) {
          result = await sandboxedExec(cmd, undefined, timeoutMs);
        } else {
          result = await execAsync(cmd, {
            timeout: timeoutMs,
            maxBuffer: 1024 * 1024 * 5
          });
        }

        const output = [
          result.stdout ? `stdout:\n${result.stdout.trim()}` : '',
          result.stderr ? `stderr:\n${result.stderr.trim()}` : ''
        ].filter(Boolean).join('\n\n');

        return { success: true, output: output || '(no output)' };
      } catch (err) {
        const output = [
          err.stdout ? `stdout:\n${err.stdout.trim()}` : '',
          err.stderr ? `stderr:\n${err.stderr.trim()}` : ''
        ].filter(Boolean).join('\n\n');

        return { success: false, output: output || '', error: err.message };
      } finally {
        try { fs.unlinkSync(tmpFile); } catch { /* ignore cleanup errors */ }
      }
    }
  }
];

export default tools;
