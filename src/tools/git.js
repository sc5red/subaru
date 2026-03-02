import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { checkCommand } from '../safety/permissions.js';
import logger from '../utils/logger.js';

const execAsync = promisify(exec);

async function runGit(args, cwd, context) {
  const command = `git ${args}`;

  // Safety check
  const safety = checkCommand(command, context.config);
  if (!safety.allowed) {
    return { success: false, output: '', error: `Blocked: ${safety.reason}` };
  }

  try {
    const result = await execAsync(command, {
      cwd: cwd || process.cwd(),
      timeout: 30000,
      maxBuffer: 1024 * 1024 * 5
    });

    const output = [
      result.stdout ? result.stdout.trim() : '',
      result.stderr ? result.stderr.trim() : ''
    ].filter(Boolean).join('\n');

    return { success: true, output: output || '(no output)' };
  } catch (err) {
    const output = [
      err.stdout ? err.stdout.trim() : '',
      err.stderr ? err.stderr.trim() : ''
    ].filter(Boolean).join('\n');

    return { success: false, output: output || '', error: err.message };
  }
}

const tools = [
  {
    name: 'git_status',
    description: 'Run git status --short in a directory. Returns a summary of changed files.',
    parameters: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Working directory (must be a git repo)' }
      },
      required: ['cwd']
    },
    async execute(input, context) {
      return runGit('status --short', input.cwd, context);
    }
  },
  {
    name: 'git_diff',
    description: 'Run git diff, optionally for a specific file. Shows uncommitted changes.',
    parameters: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Working directory (must be a git repo)' },
        file: { type: 'string', description: 'Optional specific file to diff' }
      },
      required: ['cwd']
    },
    async execute(input, context) {
      const args = input.file ? `diff -- "${input.file}"` : 'diff';
      return runGit(args, input.cwd, context);
    }
  },
  {
    name: 'git_log',
    description: 'Return the last N commits as a structured list with hash, author, date, and message.',
    parameters: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Working directory (must be a git repo)' },
        n: { type: 'number', description: 'Number of commits to show (default: 10)' }
      },
      required: ['cwd']
    },
    async execute(input, context) {
      const n = input.n || 10;
      const result = await runGit(`log --oneline --format="%H|||%an|||%ai|||%s" -${n}`, input.cwd, context);

      if (!result.success) return result;

      try {
        const commits = result.output.split('\n').filter(Boolean).map(line => {
          const parts = line.split('|||');
          return {
            hash: parts[0]?.trim(),
            author: parts[1]?.trim(),
            date: parts[2]?.trim(),
            message: parts[3]?.trim()
          };
        });
        return { success: true, output: JSON.stringify(commits, null, 2) };
      } catch {
        return result; // Return raw output on parse failure
      }
    }
  },
  {
    name: 'git_pull',
    description: 'Run git pull in a directory to fetch and merge remote changes.',
    parameters: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Working directory (must be a git repo)' }
      },
      required: ['cwd']
    },
    async execute(input, context) {
      return runGit('pull', input.cwd, context);
    }
  },
  {
    name: 'git_push',
    description: 'Run git push to upload local commits to a remote repository.',
    parameters: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Working directory (must be a git repo)' },
        remote: { type: 'string', description: 'Remote name (default: "origin")' },
        branch: { type: 'string', description: 'Branch name (default: current branch)' }
      },
      required: ['cwd']
    },
    async execute(input, context) {
      const remote = input.remote || 'origin';
      const branch = input.branch ? ` ${input.branch}` : '';
      return runGit(`push ${remote}${branch}`, input.cwd, context);
    }
  },
  {
    name: 'git_commit',
    description: 'Stage all changes and commit with the given message.',
    parameters: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Working directory (must be a git repo)' },
        message: { type: 'string', description: 'Commit message' }
      },
      required: ['cwd', 'message']
    },
    async execute(input, context) {
      // Stage all changes first
      const addResult = await runGit('add -A', input.cwd, context);
      if (!addResult.success) return addResult;

      const escapedMsg = input.message.replace(/"/g, '\\"');
      return runGit(`commit -m "${escapedMsg}"`, input.cwd, context);
    }
  },
  {
    name: 'git_checkout',
    description: 'Checkout a git branch.',
    parameters: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Working directory (must be a git repo)' },
        branch: { type: 'string', description: 'Branch name to checkout' }
      },
      required: ['cwd', 'branch']
    },
    async execute(input, context) {
      return runGit(`checkout ${input.branch}`, input.cwd, context);
    }
  },
  {
    name: 'git_clone',
    description: 'Clone a git repository to a destination path.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Repository URL to clone' },
        dest: { type: 'string', description: 'Destination directory path' }
      },
      required: ['url', 'dest']
    },
    async execute(input, context) {
      return runGit(`clone "${input.url}" "${input.dest}"`, undefined, context);
    }
  }
];

export default tools;
