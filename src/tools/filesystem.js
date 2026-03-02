import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { checkPath } from '../safety/permissions.js';
import logger from '../utils/logger.js';

function resolveTilde(p) {
  if (p.startsWith('~')) {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

function safeResolve(p) {
  return path.resolve(resolveTilde(p));
}

function checkPathSafety(filePath, context) {
  const result = checkPath(filePath, context.config);
  if (!result.allowed) {
    return { success: false, output: '', error: result.reason };
  }
  return null;
}

const tools = [
  {
    name: 'read_file',
    description: 'Read the contents of a file at the given path. Returns the file content as a string.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The file path to read' }
      },
      required: ['path']
    },
    async execute(input, context) {
      const filePath = safeResolve(input.path);
      const blocked = checkPathSafety(filePath, context);
      if (blocked) return blocked;

      try {
        // Check if binary
        const buffer = fs.readFileSync(filePath);
        const isBinary = buffer.some(byte => byte === 0);
        if (isBinary) {
          return { success: true, output: `[Binary file: ${filePath}, size: ${buffer.length} bytes]` };
        }
        const content = buffer.toString('utf-8');
        return { success: true, output: content };
      } catch (err) {
        return { success: false, output: '', error: err.message };
      }
    }
  },
  {
    name: 'write_file',
    description: 'Write string content to a file. Creates directories if needed. Overwrites existing content.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The file path to write to' },
        content: { type: 'string', description: 'The content to write' }
      },
      required: ['path', 'content']
    },
    async execute(input, context) {
      const filePath = safeResolve(input.path);
      const blocked = checkPathSafety(filePath, context);
      if (blocked) return blocked;

      try {
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(filePath, input.content, 'utf-8');
        return { success: true, output: `File written: ${filePath}` };
      } catch (err) {
        return { success: false, output: '', error: err.message };
      }
    }
  },
  {
    name: 'append_file',
    description: 'Append content to the end of a file.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The file path to append to' },
        content: { type: 'string', description: 'The content to append' }
      },
      required: ['path', 'content']
    },
    async execute(input, context) {
      const filePath = safeResolve(input.path);
      const blocked = checkPathSafety(filePath, context);
      if (blocked) return blocked;

      try {
        fs.appendFileSync(filePath, input.content, 'utf-8');
        return { success: true, output: `Content appended to: ${filePath}` };
      } catch (err) {
        return { success: false, output: '', error: err.message };
      }
    }
  },
  {
    name: 'list_directory',
    description: 'List files and folders in a directory with type and size info.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The directory path to list' }
      },
      required: ['path']
    },
    async execute(input, context) {
      const dirPath = safeResolve(input.path);
      const blocked = checkPathSafety(dirPath, context);
      if (blocked) return blocked;

      try {
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        const items = entries.map(entry => {
          const fullPath = path.join(dirPath, entry.name);
          const type = entry.isDirectory() ? 'directory' : 'file';
          let size = '';
          if (entry.isFile()) {
            try {
              const stats = fs.statSync(fullPath);
              size = ` (${stats.size} bytes)`;
            } catch { /* ignore */ }
          }
          return `${type === 'directory' ? '📁' : '📄'} ${entry.name}${size}`;
        });
        return { success: true, output: items.join('\n') || '(empty directory)' };
      } catch (err) {
        return { success: false, output: '', error: err.message };
      }
    }
  },
  {
    name: 'delete_file',
    description: 'Delete a file or empty directory.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The file or directory path to delete' }
      },
      required: ['path']
    },
    async execute(input, context) {
      const filePath = safeResolve(input.path);
      const blocked = checkPathSafety(filePath, context);
      if (blocked) return blocked;

      try {
        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) {
          fs.rmdirSync(filePath);
        } else {
          fs.unlinkSync(filePath);
        }
        return { success: true, output: `Deleted: ${filePath}` };
      } catch (err) {
        return { success: false, output: '', error: err.message };
      }
    }
  },
  {
    name: 'create_directory',
    description: 'Create a directory recursively (including parent directories).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The directory path to create' }
      },
      required: ['path']
    },
    async execute(input, context) {
      const dirPath = safeResolve(input.path);
      const blocked = checkPathSafety(dirPath, context);
      if (blocked) return blocked;

      try {
        fs.mkdirSync(dirPath, { recursive: true });
        return { success: true, output: `Directory created: ${dirPath}` };
      } catch (err) {
        return { success: false, output: '', error: err.message };
      }
    }
  },
  {
    name: 'move_file',
    description: 'Move or rename a file or directory.',
    parameters: {
      type: 'object',
      properties: {
        src: { type: 'string', description: 'Source path' },
        dest: { type: 'string', description: 'Destination path' }
      },
      required: ['src', 'dest']
    },
    async execute(input, context) {
      const srcPath = safeResolve(input.src);
      const destPath = safeResolve(input.dest);
      const blockedSrc = checkPathSafety(srcPath, context);
      if (blockedSrc) return blockedSrc;
      const blockedDest = checkPathSafety(destPath, context);
      if (blockedDest) return blockedDest;

      try {
        fs.renameSync(srcPath, destPath);
        return { success: true, output: `Moved: ${srcPath} → ${destPath}` };
      } catch (err) {
        return { success: false, output: '', error: err.message };
      }
    }
  },
  {
    name: 'file_exists',
    description: 'Check if a path exists and return metadata (type, size, modified date).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The path to check' }
      },
      required: ['path']
    },
    async execute(input, context) {
      const filePath = safeResolve(input.path);
      const blocked = checkPathSafety(filePath, context);
      if (blocked) return blocked;

      try {
        if (!fs.existsSync(filePath)) {
          return { success: true, output: `Path does not exist: ${filePath}` };
        }
        const stat = fs.statSync(filePath);
        return {
          success: true,
          output: JSON.stringify({
            exists: true,
            type: stat.isDirectory() ? 'directory' : 'file',
            size: stat.size,
            modified: stat.mtime.toISOString(),
            created: stat.birthtime.toISOString()
          }, null, 2)
        };
      } catch (err) {
        return { success: false, output: '', error: err.message };
      }
    }
  },
  {
    name: 'search_files',
    description: 'Search for files matching a glob-like pattern in a directory. Uses simple pattern matching with * wildcard.',
    parameters: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: 'The directory to search in' },
        pattern: { type: 'string', description: 'Glob pattern (e.g., "*.js", "*.txt")' }
      },
      required: ['directory', 'pattern']
    },
    async execute(input, context) {
      const dirPath = safeResolve(input.directory);
      const blocked = checkPathSafety(dirPath, context);
      if (blocked) return blocked;

      try {
        const results = [];
        const regex = new RegExp('^' + input.pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');

        function walk(dir) {
          try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
              const fullPath = path.join(dir, entry.name);
              if (entry.isDirectory()) {
                walk(fullPath);
              } else if (regex.test(entry.name)) {
                results.push(path.relative(dirPath, fullPath));
              }
            }
          } catch { /* skip inaccessible dirs */ }
        }

        walk(dirPath);
        return { success: true, output: results.length ? results.join('\n') : 'No files found matching pattern.' };
      } catch (err) {
        return { success: false, output: '', error: err.message };
      }
    }
  }
];

export default tools;
