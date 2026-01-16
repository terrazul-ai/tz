import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadMCPConfig, spawnTool } from '../../../src/integrations/tool-spawner.js';

import type { ToolSpec } from '../../../src/types/context.js';
import type { ChildProcess } from 'node:child_process';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    spawn: vi.fn(),
  };
});

/** Helper to create a mock ChildProcess for spawn tests */
function createMockChildProcess(exitCode = 0): ChildProcess {
  // EventEmitter is required here because ChildProcess extends it (not EventTarget)
  // eslint-disable-next-line unicorn/prefer-event-target
  const emitter = new EventEmitter() as ChildProcess;
  // Simulate async exit
  setTimeout(() => emitter.emit('exit', exitCode), 10);
  return emitter;
}

/** Helper to create a mock ChildProcess that emits an error */
function createErrorChildProcess(errorCode: string): ChildProcess {
  // eslint-disable-next-line unicorn/prefer-event-target
  const emitter = new EventEmitter() as ChildProcess;
  const error = new Error('spawn error') as NodeJS.ErrnoException;
  error.code = errorCode;
  setTimeout(() => emitter.emit('error', error), 10);
  return emitter;
}

describe('tool-spawner', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tz-tool-spawner-test-'));
  });

  afterEach(async () => {
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      void 0;
    }
    vi.resetAllMocks();
  });

  describe('spawnTool', () => {
    const mockSpawn = vi.mocked(spawn);

    beforeEach(() => {
      mockSpawn.mockReset();
    });

    describe('Claude spawning', () => {
      it('spawns claude with correct command', async () => {
        mockSpawn.mockReturnValue(createMockChildProcess());

        const tool: ToolSpec = { type: 'claude' };
        await spawnTool({ tool, cwd: tmpDir });

        expect(mockSpawn).toHaveBeenCalledOnce();
        expect(mockSpawn.mock.calls[0]?.[0]).toBe('claude');
      });

      it('includes --mcp-config flag when mcpConfigPath is provided', async () => {
        mockSpawn.mockReturnValue(createMockChildProcess());

        const tool: ToolSpec = { type: 'claude' };
        await spawnTool({ tool, cwd: tmpDir, mcpConfigPath: '/tmp/mcp.json' });

        const args = mockSpawn.mock.calls[0]?.[1] as string[];
        expect(args).toContain('--mcp-config');
        expect(args).toContain('/tmp/mcp.json');
        expect(args).toContain('--strict-mcp-config');
      });

      it('includes --model flag when model is specified', async () => {
        mockSpawn.mockReturnValue(createMockChildProcess());

        const tool: ToolSpec = { type: 'claude', model: 'opus' };
        await spawnTool({ tool, cwd: tmpDir });

        const args = mockSpawn.mock.calls[0]?.[1] as string[];
        expect(args).toContain('--model');
        expect(args).toContain('opus');
      });

      it('skips --model flag when model is "default"', async () => {
        mockSpawn.mockReturnValue(createMockChildProcess());

        const tool: ToolSpec = { type: 'claude', model: 'default' };
        await spawnTool({ tool, cwd: tmpDir });

        const args = mockSpawn.mock.calls[0]?.[1] as string[];
        expect(args).not.toContain('--model');
      });

      it('uses custom command when specified', async () => {
        mockSpawn.mockReturnValue(createMockChildProcess());

        const tool: ToolSpec = { type: 'claude', command: 'custom-claude' };
        await spawnTool({ tool, cwd: tmpDir });

        expect(mockSpawn.mock.calls[0]?.[0]).toBe('custom-claude');
      });

      it('throws TOOL_NOT_FOUND on ENOENT error', async () => {
        mockSpawn.mockReturnValue(createErrorChildProcess('ENOENT'));

        const tool: ToolSpec = { type: 'claude' };
        await expect(spawnTool({ tool, cwd: tmpDir })).rejects.toThrow(/claude cli not found/i);
      });

      it('returns exit code from spawned process', async () => {
        mockSpawn.mockReturnValue(createMockChildProcess(42));

        const tool: ToolSpec = { type: 'claude' };
        const exitCode = await spawnTool({ tool, cwd: tmpDir });

        expect(exitCode).toBe(42);
      });
    });

    describe('Codex spawning', () => {
      it('spawns codex with correct command', async () => {
        mockSpawn.mockReturnValue(createMockChildProcess());

        const tool: ToolSpec = { type: 'codex' };
        await spawnTool({ tool, cwd: tmpDir });

        expect(mockSpawn).toHaveBeenCalledOnce();
        expect(mockSpawn.mock.calls[0]?.[0]).toBe('codex');
      });

      it('does NOT include base args (exec is for askAgent, not interactive spawning)', async () => {
        mockSpawn.mockReturnValue(createMockChildProcess());

        // tool.args like 'exec' are for non-interactive askAgent execution
        // For interactive spawning, we just run 'codex' directly
        const tool: ToolSpec = { type: 'codex', args: ['exec'] };
        await spawnTool({ tool, cwd: tmpDir });

        const args = mockSpawn.mock.calls[0]?.[1] as string[];
        expect(args).not.toContain('exec');
      });

      it('includes --model flag when model is specified', async () => {
        mockSpawn.mockReturnValue(createMockChildProcess());

        const tool: ToolSpec = { type: 'codex', model: 'o3' };
        await spawnTool({ tool, cwd: tmpDir });

        const args = mockSpawn.mock.calls[0]?.[1] as string[];
        expect(args).toContain('--model');
        expect(args).toContain('o3');
      });

      it('skips --model flag when model is "default"', async () => {
        mockSpawn.mockReturnValue(createMockChildProcess());

        const tool: ToolSpec = { type: 'codex', model: 'default' };
        await spawnTool({ tool, cwd: tmpDir });

        const args = mockSpawn.mock.calls[0]?.[1] as string[];
        expect(args).not.toContain('--model');
      });

      it('passes MCP config via -c flags', async () => {
        mockSpawn.mockReturnValue(createMockChildProcess());

        const tool: ToolSpec = { type: 'codex' };
        const mcpConfig = {
          mcpServers: {
            'test-server': {
              command: 'npx',
              args: ['-y', '@anthropic-ai/mcp-test'],
              env: { FOO: 'bar' },
            },
          },
        };

        await spawnTool({ tool, cwd: tmpDir, mcpConfig });

        const args = mockSpawn.mock.calls[0]?.[1] as string[];
        expect(args).toContain('-c');
        expect(args.some((arg) => arg.includes('mcp_servers.test-server.command=npx'))).toBe(true);
        expect(args.some((arg) => arg.includes('mcp_servers.test-server.args='))).toBe(true);
        expect(args.some((arg) => arg.includes('mcp_servers.test-server.env='))).toBe(true);
      });

      it('throws TOOL_NOT_FOUND on ENOENT error', async () => {
        mockSpawn.mockReturnValue(createErrorChildProcess('ENOENT'));

        const tool: ToolSpec = { type: 'codex' };
        await expect(spawnTool({ tool, cwd: tmpDir })).rejects.toThrow(/codex cli not found/i);
      });

      it('returns exit code from spawned process', async () => {
        mockSpawn.mockReturnValue(createMockChildProcess(5));

        const tool: ToolSpec = { type: 'codex' };
        const exitCode = await spawnTool({ tool, cwd: tmpDir });

        expect(exitCode).toBe(5);
      });
    });

    describe('Unsupported tools', () => {
      it('throws error for cursor tool', async () => {
        const tool: ToolSpec = { type: 'cursor' };
        await expect(spawnTool({ tool, cwd: tmpDir })).rejects.toThrow(
          /does not support spawning.*use 'claude' or 'codex'/i,
        );
      });

      it('throws error for copilot tool', async () => {
        const tool: ToolSpec = { type: 'copilot' };
        await expect(spawnTool({ tool, cwd: tmpDir })).rejects.toThrow(
          /does not support spawning.*use 'claude' or 'codex'/i,
        );
      });
    });

    describe('Additional args', () => {
      it('passes additional args for claude', async () => {
        mockSpawn.mockReturnValue(createMockChildProcess());

        const tool: ToolSpec = { type: 'claude' };
        await spawnTool({ tool, cwd: tmpDir, additionalArgs: ['--verbose', '--debug'] });

        const args = mockSpawn.mock.calls[0]?.[1] as string[];
        expect(args).toContain('--verbose');
        expect(args).toContain('--debug');
      });

      it('passes additional args for codex', async () => {
        mockSpawn.mockReturnValue(createMockChildProcess());

        const tool: ToolSpec = { type: 'codex' };
        await spawnTool({ tool, cwd: tmpDir, additionalArgs: ['--quiet'] });

        const args = mockSpawn.mock.calls[0]?.[1] as string[];
        expect(args).toContain('--quiet');
      });
    });

    describe('Environment variables', () => {
      it('expands env:NAME variables from tool spec', async () => {
        mockSpawn.mockReturnValue(createMockChildProcess());
        process.env.TEST_VAR = 'test-value';

        const tool: ToolSpec = { type: 'claude', env: { MY_VAR: 'env:TEST_VAR' } };
        await spawnTool({ tool, cwd: tmpDir });

        const spawnOptions = mockSpawn.mock.calls[0]?.[2] as { env?: Record<string, string> };
        expect(spawnOptions.env?.MY_VAR).toBe('test-value');

        delete process.env.TEST_VAR;
      });

      it('passes literal env values from tool spec', async () => {
        mockSpawn.mockReturnValue(createMockChildProcess());

        const tool: ToolSpec = { type: 'claude', env: { MY_VAR: 'literal-value' } };
        await spawnTool({ tool, cwd: tmpDir });

        const spawnOptions = mockSpawn.mock.calls[0]?.[2] as { env?: Record<string, string> };
        expect(spawnOptions.env?.MY_VAR).toBe('literal-value');
      });
    });
  });

  describe('loadMCPConfig', () => {
    it('loads MCP config from JSON file', async () => {
      const configPath = path.join(tmpDir, 'mcp-config.json');
      const config = {
        mcpServers: {
          test: { command: 'echo', args: ['hello'] },
        },
      };
      await fs.writeFile(configPath, JSON.stringify(config));

      const loaded = await loadMCPConfig(configPath);
      expect(loaded).toEqual(config);
    });

    it('returns empty config if file does not exist', async () => {
      const configPath = path.join(tmpDir, 'nonexistent.json');
      const loaded = await loadMCPConfig(configPath);
      expect(loaded).toEqual({ mcpServers: {} });
    });

    it('returns empty config on invalid JSON', async () => {
      const configPath = path.join(tmpDir, 'invalid.json');
      await fs.writeFile(configPath, 'not json');

      const loaded = await loadMCPConfig(configPath);
      expect(loaded).toEqual({ mcpServers: {} });
    });
  });
});
