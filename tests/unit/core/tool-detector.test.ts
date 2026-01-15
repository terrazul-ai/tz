import * as childProcess from 'node:child_process';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  detectTool,
  detectAllTools,
  getInstalledTools,
  isDetectableToolType,
  DETECTABLE_TOOLS,
} from '../../../src/core/tool-detector.js';

// Mock child_process.exec
vi.mock('node:child_process', () => ({
  exec: vi.fn(),
}));

const mockExec = childProcess.exec as unknown as ReturnType<typeof vi.fn>;

describe('tool-detector', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('detectTool', () => {
    it('returns installed: true when command succeeds', async () => {
      mockExec.mockImplementation(
        (
          _cmd: string,
          callback: (err: Error | null, result: { stdout: string; stderr: string } | null) => void,
        ) => {
          callback(null, { stdout: 'claude 1.2.3', stderr: '' });
        },
      );

      const result = await detectTool('claude');

      expect(result.installed).toBe(true);
      expect(result.type).toBe('claude');
      expect(result.command).toBe('claude');
      expect(result.displayName).toBe('Claude Code');
      expect(result.error).toBeUndefined();
    });

    it('parses version from stdout with semver format', async () => {
      mockExec.mockImplementation(
        (
          _cmd: string,
          callback: (err: Error | null, result: { stdout: string; stderr: string } | null) => void,
        ) => {
          callback(null, { stdout: 'claude version 1.2.3', stderr: '' });
        },
      );

      const result = await detectTool('claude');

      expect(result.version).toBe('1.2.3');
    });

    it('parses version with v prefix', async () => {
      mockExec.mockImplementation(
        (
          _cmd: string,
          callback: (err: Error | null, result: { stdout: string; stderr: string } | null) => void,
        ) => {
          callback(null, { stdout: 'v2.0.0-beta.1', stderr: '' });
        },
      );

      const result = await detectTool('codex');

      expect(result.version).toBe('2.0.0-beta.1');
    });

    it('parses version from first line when no semver found', async () => {
      mockExec.mockImplementation(
        (
          _cmd: string,
          callback: (err: Error | null, result: { stdout: string; stderr: string } | null) => void,
        ) => {
          callback(null, { stdout: 'gemini-cli\nsome other info', stderr: '' });
        },
      );

      const result = await detectTool('gemini');

      expect(result.version).toBe('gemini-cli');
    });

    it('returns installed: false when command fails with ENOENT', async () => {
      const error = new Error('spawn claude ENOENT');
      mockExec.mockImplementation(
        (
          _cmd: string,
          callback: (err: Error | null, result: { stdout: string; stderr: string } | null) => void,
        ) => {
          callback(error, null);
        },
      );

      const result = await detectTool('claude');

      expect(result.installed).toBe(false);
      expect(result.error).toBe('not installed');
      expect(result.version).toBeUndefined();
    });

    it('returns installed: false when command not found', async () => {
      const error = new Error('command not found: codex');
      mockExec.mockImplementation(
        (
          _cmd: string,
          callback: (err: Error | null, result: { stdout: string; stderr: string } | null) => void,
        ) => {
          callback(error, null);
        },
      );

      const result = await detectTool('codex');

      expect(result.installed).toBe(false);
      expect(result.error).toBe('not installed');
    });

    it('returns permission denied error for EACCES', async () => {
      const error = new Error('EACCES: permission denied');
      mockExec.mockImplementation(
        (
          _cmd: string,
          callback: (err: Error | null, result: { stdout: string; stderr: string } | null) => void,
        ) => {
          callback(error, null);
        },
      );

      const result = await detectTool('gemini');

      expect(result.installed).toBe(false);
      expect(result.error).toBe('permission denied');
    });

    it('returns generic error for other failures', async () => {
      const error = new Error('some other error');
      mockExec.mockImplementation(
        (
          _cmd: string,
          callback: (err: Error | null, result: { stdout: string; stderr: string } | null) => void,
        ) => {
          callback(error, null);
        },
      );

      const result = await detectTool('claude');

      expect(result.installed).toBe(false);
      expect(result.error).toBe('detection failed');
    });

    it('detects codex with correct command', async () => {
      mockExec.mockImplementation(
        (
          cmd: string,
          callback: (err: Error | null, result: { stdout: string; stderr: string } | null) => void,
        ) => {
          expect(cmd).toBe('codex --version');
          callback(null, { stdout: 'codex 0.1.0', stderr: '' });
        },
      );

      const result = await detectTool('codex');

      expect(result.type).toBe('codex');
      expect(result.displayName).toBe('OpenAI Codex');
    });

    it('detects gemini with correct command', async () => {
      mockExec.mockImplementation(
        (
          cmd: string,
          callback: (err: Error | null, result: { stdout: string; stderr: string } | null) => void,
        ) => {
          expect(cmd).toBe('gemini --version');
          callback(null, { stdout: 'gemini 1.0.0', stderr: '' });
        },
      );

      const result = await detectTool('gemini');

      expect(result.type).toBe('gemini');
      expect(result.displayName).toBe('Google Gemini');
    });
  });

  describe('detectAllTools', () => {
    it('detects all tools in parallel', async () => {
      mockExec.mockImplementation(
        (
          cmd: string,
          callback: (err: Error | null, result: { stdout: string; stderr: string } | null) => void,
        ) => {
          if (cmd.startsWith('claude')) {
            callback(null, { stdout: 'claude 1.0.0', stderr: '' });
          } else if (cmd.startsWith('codex')) {
            callback(null, { stdout: 'codex 2.0.0', stderr: '' });
          } else if (cmd.startsWith('gemini')) {
            callback(new Error('ENOENT'), null);
          } else {
            callback(new Error('unknown'), null);
          }
        },
      );

      const result = await detectAllTools();

      expect(result.tools).toHaveLength(3);
      expect(result.installedCount).toBe(2);

      const claude = result.tools.find((t) => t.type === 'claude');
      expect(claude?.installed).toBe(true);
      expect(claude?.version).toBe('1.0.0');

      const codex = result.tools.find((t) => t.type === 'codex');
      expect(codex?.installed).toBe(true);
      expect(codex?.version).toBe('2.0.0');

      const gemini = result.tools.find((t) => t.type === 'gemini');
      expect(gemini?.installed).toBe(false);
    });

    it('returns all tools with status when none installed', async () => {
      mockExec.mockImplementation(
        (
          _cmd: string,
          callback: (err: Error | null, result: { stdout: string; stderr: string } | null) => void,
        ) => {
          callback(new Error('ENOENT'), null);
        },
      );

      const result = await detectAllTools();

      expect(result.tools).toHaveLength(3);
      expect(result.installedCount).toBe(0);
      expect(result.tools.every((t) => !t.installed)).toBe(true);
    });

    it('returns all tools with status when all installed', async () => {
      mockExec.mockImplementation(
        (
          _cmd: string,
          callback: (err: Error | null, result: { stdout: string; stderr: string } | null) => void,
        ) => {
          callback(null, { stdout: '1.0.0', stderr: '' });
        },
      );

      const result = await detectAllTools();

      expect(result.tools).toHaveLength(3);
      expect(result.installedCount).toBe(3);
      expect(result.tools.every((t) => t.installed)).toBe(true);
    });
  });

  describe('getInstalledTools', () => {
    it('returns only installed tool types', async () => {
      mockExec.mockImplementation(
        (
          cmd: string,
          callback: (err: Error | null, result: { stdout: string; stderr: string } | null) => void,
        ) => {
          if (cmd.startsWith('claude')) {
            callback(null, { stdout: '1.0.0', stderr: '' });
          } else {
            callback(new Error('ENOENT'), null);
          }
        },
      );

      const installed = await getInstalledTools();

      expect(installed).toEqual(['claude']);
    });

    it('returns empty array when no tools installed', async () => {
      mockExec.mockImplementation(
        (
          _cmd: string,
          callback: (err: Error | null, result: { stdout: string; stderr: string } | null) => void,
        ) => {
          callback(new Error('ENOENT'), null);
        },
      );

      const installed = await getInstalledTools();

      expect(installed).toEqual([]);
    });

    it('returns all tools when all installed', async () => {
      mockExec.mockImplementation(
        (
          _cmd: string,
          callback: (err: Error | null, result: { stdout: string; stderr: string } | null) => void,
        ) => {
          callback(null, { stdout: '1.0.0', stderr: '' });
        },
      );

      const installed = await getInstalledTools();

      expect(installed).toEqual(['claude', 'codex', 'gemini']);
    });
  });

  describe('isDetectableToolType', () => {
    it('returns true for valid tool types', () => {
      expect(isDetectableToolType('claude')).toBe(true);
      expect(isDetectableToolType('codex')).toBe(true);
      expect(isDetectableToolType('gemini')).toBe(true);
    });

    it('returns false for invalid tool types', () => {
      expect(isDetectableToolType('cursor')).toBe(false);
      expect(isDetectableToolType('copilot')).toBe(false);
      expect(isDetectableToolType('invalid')).toBe(false);
      expect(isDetectableToolType('')).toBe(false);
    });
  });

  describe('DETECTABLE_TOOLS', () => {
    it('contains all expected tools', () => {
      expect(DETECTABLE_TOOLS).toContain('claude');
      expect(DETECTABLE_TOOLS).toContain('codex');
      expect(DETECTABLE_TOOLS).toContain('gemini');
      expect(DETECTABLE_TOOLS).toHaveLength(3);
    });
  });
});
