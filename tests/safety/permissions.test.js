import { describe, it, expect } from 'vitest';
import { checkPath, checkCommand } from '../../src/safety/permissions.js';
import path from 'node:path';
import os from 'node:os';

describe('checkPath', () => {
  const config = {
    tools: {
      filesystem: {
        allowedPaths: ['~/autonome-workspace', '/tmp/allowed'],
        blockedPaths: ['/etc', '/sys', '~/.ssh']
      }
    }
  };

  it('should allow paths within allowedPaths', () => {
    const home = os.homedir();
    const result = checkPath(path.join(home, 'autonome-workspace', 'test.txt'), config);
    expect(result.allowed).toBe(true);
  });

  it('should allow the exact allowed path', () => {
    const result = checkPath('/tmp/allowed', config);
    expect(result.allowed).toBe(true);
  });

  it('should block paths within blockedPaths', () => {
    const result = checkPath('/etc/passwd', config);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('blocked');
  });

  it('should block the exact blocked path', () => {
    const result = checkPath('/sys', config);
    expect(result.allowed).toBe(false);
  });

  it('should block paths in ~/.ssh', () => {
    const home = os.homedir();
    const result = checkPath(path.join(home, '.ssh', 'id_rsa'), config);
    expect(result.allowed).toBe(false);
  });

  it('should reject paths outside allowed directories', () => {
    const result = checkPath('/usr/local/bin/test', config);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('not within any allowed directory');
  });

  it('should allow all paths when allowedPaths is empty', () => {
    const configNoRestriction = {
      tools: {
        filesystem: {
          allowedPaths: [],
          blockedPaths: []
        }
      }
    };
    const result = checkPath('/any/random/path', configNoRestriction);
    expect(result.allowed).toBe(true);
  });

  it('should block even if allowedPaths is empty but path is in blockedPaths', () => {
    const configBlocked = {
      tools: {
        filesystem: {
          allowedPaths: [],
          blockedPaths: ['/etc']
        }
      }
    };
    const result = checkPath('/etc/hosts', configBlocked);
    expect(result.allowed).toBe(false);
  });
});

describe('checkCommand', () => {
  const config = {
    tools: {
      shell: {
        blockedCommands: ['rm -rf /', 'mkfs', 'dd if=']
      }
    }
  };

  it('should allow safe commands', () => {
    const result = checkCommand('ls -la', config);
    expect(result.allowed).toBe(true);
  });

  it('should allow npm commands', () => {
    const result = checkCommand('npm install express', config);
    expect(result.allowed).toBe(true);
  });

  it('should block rm -rf /', () => {
    const result = checkCommand('rm -rf /', config);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('rm -rf /');
  });

  it('should block mkfs commands', () => {
    const result = checkCommand('mkfs.ext4 /dev/sda1', config);
    expect(result.allowed).toBe(false);
  });

  it('should block dd if= commands', () => {
    const result = checkCommand('dd if=/dev/zero of=/dev/sda', config);
    expect(result.allowed).toBe(false);
  });

  it('should allow commands when no blockedCommands configured', () => {
    const configEmpty = { tools: { shell: { blockedCommands: [] } } };
    const result = checkCommand('rm -rf /', configEmpty);
    expect(result.allowed).toBe(true);
  });

  it('should handle missing config gracefully', () => {
    const result = checkCommand('echo test', {});
    expect(result.allowed).toBe(true);
  });
});
