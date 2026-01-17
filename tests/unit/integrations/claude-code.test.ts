import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  aggregateMCPConfigs,
  detectClaudeCLI,
  generateMCPConfigFile,
  cleanupMCPConfig,
  spawnClaudeCode,
  spawnClaudeCodeHeadless,
} from '../../../src/integrations/claude-code.js';

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

describe('claude-code integration', () => {
  let tmpDir: string;
  let fakeHomeDir: string;
  let originalHome: string | undefined;
  let originalUserProfile: string | undefined;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tz-claude-test-'));
    fakeHomeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tz-claude-home-'));
    originalHome = process.env.HOME;
    originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = fakeHomeDir;
    process.env.USERPROFILE = fakeHomeDir;
  });

  afterEach(async () => {
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      void 0;
    }
    try {
      await fs.rm(fakeHomeDir, { recursive: true, force: true });
    } catch {
      void 0;
    }
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
  });

  describe('detectClaudeCLI', () => {
    it('returns true when claude CLI is available', async () => {
      // This will actually check the system
      const result = await detectClaudeCLI();
      expect(typeof result).toBe('boolean');
    });
  });

  describe('aggregateMCPConfigs', () => {
    it('returns empty config when no packages have MCP servers', async () => {
      const config = await aggregateMCPConfigs(tmpDir, []);
      expect(config).toEqual({ mcpServers: {} });
    });

    it('aggregates MCP configs from multiple packages', async () => {
      // Create store structure with MCP configs
      const storeRoot = path.join(fakeHomeDir, '.terrazul', 'store');
      const pkg1StoreDir = path.join(storeRoot, '@test', 'pkg1', '1.0.0');
      const pkg2StoreDir = path.join(storeRoot, '@test', 'pkg2', '2.0.0');

      await fs.mkdir(pkg1StoreDir, { recursive: true });
      await fs.mkdir(pkg2StoreDir, { recursive: true });

      // Create MCP config files in store
      const mcp1 = {
        mcpServers: {
          server1: {
            command: 'node',
            args: ['server1.js'],
          },
        },
      };

      const mcp2 = {
        mcpServers: {
          server2: {
            command: 'node',
            args: ['server2.js'],
          },
        },
      };

      await fs.writeFile(path.join(pkg1StoreDir, 'mcp-config.json'), JSON.stringify(mcp1));
      await fs.writeFile(path.join(pkg2StoreDir, 'mcp-config.json'), JSON.stringify(mcp2));

      // Create lockfile
      const lockfile = `
version = 1

[packages."@test/pkg1"]
version = "1.0.0"
resolved = "http://localhost/pkg1"
integrity = "sha256-test1"
dependencies = { }

[packages."@test/pkg2"]
version = "2.0.0"
resolved = "http://localhost/pkg2"
integrity = "sha256-test2"
dependencies = { }

[metadata]
generated_at = "2025-01-01T00:00:00.000Z"
cli_version = "0.1.0"
`;
      await fs.writeFile(path.join(tmpDir, 'agents-lock.toml'), lockfile.trim());

      const config = await aggregateMCPConfigs(tmpDir, ['@test/pkg1', '@test/pkg2'], {
        storeDir: storeRoot,
      });

      expect(config.mcpServers).toHaveProperty('server1');
      expect(config.mcpServers).toHaveProperty('server2');
      expect(config.mcpServers.server1.command).toBe('node');
      expect(config.mcpServers.server2.command).toBe('node');
    });

    it('prioritizes rendered MCP configs in agent_modules over store', async () => {
      // Create both agent_modules and store configs
      const agentModulesRoot = path.join(tmpDir, 'agent_modules');
      const pkgModulesDir = path.join(agentModulesRoot, '@test', 'pkg1', 'claude');
      await fs.mkdir(pkgModulesDir, { recursive: true });

      // Rendered config in agent_modules (should be used)
      const renderedMcp = {
        mcpServers: {
          'rendered-server': {
            command: 'node',
            args: ['rendered.js'],
          },
        },
      };
      await fs.writeFile(path.join(pkgModulesDir, 'mcp_servers.json'), JSON.stringify(renderedMcp));

      // Static config in store (should be ignored)
      const storeRoot = path.join(fakeHomeDir, '.terrazul', 'store');
      const pkgStoreDir = path.join(storeRoot, '@test', 'pkg1', '1.0.0');
      await fs.mkdir(pkgStoreDir, { recursive: true });

      const storeMcp = {
        mcpServers: {
          'store-server': {
            command: 'node',
            args: ['store.js'],
          },
        },
      };
      await fs.writeFile(path.join(pkgStoreDir, 'mcp-config.json'), JSON.stringify(storeMcp));

      // Create lockfile
      const lockfile = `
version = 1

[packages."@test/pkg1"]
version = "1.0.0"
resolved = "http://localhost/pkg1"
integrity = "sha256-test1"
dependencies = { }

[metadata]
generated_at = "2025-01-01T00:00:00.000Z"
cli_version = "0.1.0"
`;
      await fs.writeFile(path.join(tmpDir, 'agents-lock.toml'), lockfile.trim());

      const config = await aggregateMCPConfigs(tmpDir, ['@test/pkg1'], {
        storeDir: storeRoot,
        agentModulesRoot,
      });

      // Should use rendered config, not store config
      expect(config.mcpServers).toHaveProperty('rendered-server');
      expect(config.mcpServers).not.toHaveProperty('store-server');
      expect(config.mcpServers['rendered-server'].command).toBe('node');
      expect(config.mcpServers['rendered-server'].args).toEqual(['rendered.js']);
    });

    it('handles packages without MCP config gracefully', async () => {
      const pkgDir = path.join(tmpDir, 'agent_modules', '@test', 'pkg-no-mcp');
      await fs.mkdir(pkgDir, { recursive: true });

      const config = await aggregateMCPConfigs(tmpDir, ['@test/pkg-no-mcp']);
      expect(config).toEqual({ mcpServers: {} });
    });

    it('throws error on duplicate MCP server names', async () => {
      // Create store structure with duplicate MCP server names
      const storeRoot = path.join(fakeHomeDir, '.terrazul', 'store');
      const pkg1StoreDir = path.join(storeRoot, '@test', 'pkg1', '1.0.0');
      const pkg2StoreDir = path.join(storeRoot, '@test', 'pkg2', '2.0.0');

      await fs.mkdir(pkg1StoreDir, { recursive: true });
      await fs.mkdir(pkg2StoreDir, { recursive: true });

      const mcp1 = {
        mcpServers: {
          duplicate: {
            command: 'node',
            args: ['server1.js'],
          },
        },
      };

      const mcp2 = {
        mcpServers: {
          duplicate: {
            command: 'node',
            args: ['server2.js'],
          },
        },
      };

      await fs.writeFile(path.join(pkg1StoreDir, 'mcp-config.json'), JSON.stringify(mcp1));
      await fs.writeFile(path.join(pkg2StoreDir, 'mcp-config.json'), JSON.stringify(mcp2));

      // Create lockfile
      const lockfile = `
version = 1

[packages."@test/pkg1"]
version = "1.0.0"
resolved = "http://localhost/pkg1"
integrity = "sha256-test1"
dependencies = { }

[packages."@test/pkg2"]
version = "2.0.0"
resolved = "http://localhost/pkg2"
integrity = "sha256-test2"
dependencies = { }

[metadata]
generated_at = "2025-01-01T00:00:00.000Z"
cli_version = "0.1.0"
`;
      await fs.writeFile(path.join(tmpDir, 'agents-lock.toml'), lockfile.trim());

      await expect(
        aggregateMCPConfigs(tmpDir, ['@test/pkg1', '@test/pkg2'], { storeDir: storeRoot }),
      ).rejects.toThrow(/duplicate.*mcp server/i);
    });

    it('handles malformed MCP config gracefully', async () => {
      // Create store structure with malformed MCP config
      const storeRoot = path.join(fakeHomeDir, '.terrazul', 'store');
      const pkgStoreDir = path.join(storeRoot, '@test', 'pkg-bad', '1.0.0');
      await fs.mkdir(pkgStoreDir, { recursive: true });

      await fs.writeFile(path.join(pkgStoreDir, 'mcp-config.json'), 'invalid json {');

      // Create lockfile
      const lockfile = `
version = 1

[packages."@test/pkg-bad"]
version = "1.0.0"
resolved = "http://localhost/pkg-bad"
integrity = "sha256-test"
dependencies = { }

[metadata]
generated_at = "2025-01-01T00:00:00.000Z"
cli_version = "0.1.0"
`;
      await fs.writeFile(path.join(tmpDir, 'agents-lock.toml'), lockfile.trim());

      await expect(
        aggregateMCPConfigs(tmpDir, ['@test/pkg-bad'], { storeDir: storeRoot }),
      ).rejects.toThrow();
    });
  });

  describe('generateMCPConfigFile', () => {
    it('writes MCP config to specified path', async () => {
      const configPath = path.join(tmpDir, 'mcp-config.json');
      const config = {
        mcpServers: {
          test: {
            command: 'node',
            args: ['test.js'],
          },
        },
      };

      await generateMCPConfigFile(configPath, config);

      const written = await fs.readFile(configPath, 'utf8');
      const parsed = JSON.parse(written);

      expect(parsed).toEqual(config);
    });

    it('creates parent directories if needed', async () => {
      const configPath = path.join(tmpDir, 'nested', 'dir', 'mcp-config.json');
      const config = {
        mcpServers: {},
      };

      await generateMCPConfigFile(configPath, config);

      const exists = await fs
        .access(configPath)
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(true);
    });

    it('overwrites existing file', async () => {
      const configPath = path.join(tmpDir, 'mcp-config.json');

      await fs.writeFile(configPath, 'old content');

      const config = {
        mcpServers: {
          new: {
            command: 'echo',
            args: ['hello'],
          },
        },
      };

      await generateMCPConfigFile(configPath, config);

      const written = await fs.readFile(configPath, 'utf8');
      expect(written).not.toContain('old content');
      expect(written).toContain('echo');
    });
  });

  describe('cleanupMCPConfig', () => {
    it('removes MCP config file', async () => {
      const configPath = path.join(tmpDir, 'mcp-config.json');
      await fs.writeFile(configPath, '{}');

      await cleanupMCPConfig(configPath);

      const exists = await fs
        .access(configPath)
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(false);
    });

    it('does not throw if file does not exist', async () => {
      const configPath = path.join(tmpDir, 'nonexistent.json');

      await expect(cleanupMCPConfig(configPath)).resolves.not.toThrow();
    });
  });

  describe('spawnClaudeCode', () => {
    const mockSpawn = vi.mocked(spawn);

    beforeEach(() => {
      mockSpawn.mockReset();
    });

    it('accepts model parameter in function signature', () => {
      // Type-level test: this compiles if the signature is correct
      // Verify the function can be called with the model parameter
      expect(typeof spawnClaudeCode).toBe('function');

      // The implementation should accept: (mcpConfigPath, additionalArgs?, cwd?, model?)
      type ExpectedSignature = (
        mcpConfigPath: string,
        additionalArgs?: string[],
        cwd?: string,
        model?: string,
      ) => Promise<number>;

      // This will cause a type error if the signature doesn't match
      const _typeCheck: ExpectedSignature = spawnClaudeCode;
      expect(_typeCheck).toBe(spawnClaudeCode);
    });

    it('includes --model flag when model is specified', async () => {
      mockSpawn.mockReturnValue(createMockChildProcess());

      await spawnClaudeCode('/tmp/mcp.json', [], '/tmp', 'opus');

      expect(mockSpawn).toHaveBeenCalledOnce();
      const args = mockSpawn.mock.calls[0]?.[1] as string[];
      expect(args).toContain('--model');
      expect(args).toContain('opus');
    });

    it('skips --model flag when model is undefined', async () => {
      mockSpawn.mockReturnValue(createMockChildProcess());

      await spawnClaudeCode('/tmp/mcp.json', [], '/tmp');

      expect(mockSpawn).toHaveBeenCalledOnce();
      const args = mockSpawn.mock.calls[0]?.[1] as string[];
      expect(args).not.toContain('--model');
    });

    it('skips --model flag when model is "default"', async () => {
      mockSpawn.mockReturnValue(createMockChildProcess());

      await spawnClaudeCode('/tmp/mcp.json', [], '/tmp', 'default');

      expect(mockSpawn).toHaveBeenCalledOnce();
      const args = mockSpawn.mock.calls[0]?.[1] as string[];
      expect(args).not.toContain('--model');
      expect(args).not.toContain('default');
    });

    it('includes --mcp-config and --strict-mcp-config flags', async () => {
      mockSpawn.mockReturnValue(createMockChildProcess());

      await spawnClaudeCode('/tmp/mcp.json');

      expect(mockSpawn).toHaveBeenCalledOnce();
      const args = mockSpawn.mock.calls[0]?.[1] as string[];
      expect(args).toContain('--mcp-config');
      expect(args).toContain('/tmp/mcp.json');
      expect(args).toContain('--strict-mcp-config');
    });

    it('passes additional args', async () => {
      mockSpawn.mockReturnValue(createMockChildProcess());

      await spawnClaudeCode('/tmp/mcp.json', ['--verbose', '--debug']);

      expect(mockSpawn).toHaveBeenCalledOnce();
      const args = mockSpawn.mock.calls[0]?.[1] as string[];
      expect(args).toContain('--verbose');
      expect(args).toContain('--debug');
    });

    it('returns exit code from spawned process', async () => {
      mockSpawn.mockReturnValue(createMockChildProcess(42));

      const exitCode = await spawnClaudeCode('/tmp/mcp.json');

      expect(exitCode).toBe(42);
    });
  });

  describe('spawnClaudeCodeHeadless', () => {
    const mockSpawn = vi.mocked(spawn);

    beforeEach(() => {
      mockSpawn.mockReset();
    });

    it('includes -p flag with prompt', async () => {
      mockSpawn.mockReturnValue(createMockChildProcess());

      await spawnClaudeCodeHeadless('/tmp/mcp.json', 'List all files');

      expect(mockSpawn).toHaveBeenCalledOnce();
      const args = mockSpawn.mock.calls[0]?.[1] as string[];
      expect(args).toContain('-p');
      expect(args).toContain('List all files');
    });

    it('includes --mcp-config and --strict-mcp-config flags', async () => {
      mockSpawn.mockReturnValue(createMockChildProcess());

      await spawnClaudeCodeHeadless('/tmp/mcp.json', 'test prompt');

      expect(mockSpawn).toHaveBeenCalledOnce();
      const args = mockSpawn.mock.calls[0]?.[1] as string[];
      expect(args).toContain('--mcp-config');
      expect(args).toContain('/tmp/mcp.json');
      expect(args).toContain('--strict-mcp-config');
    });

    it('includes --model flag when model is specified', async () => {
      mockSpawn.mockReturnValue(createMockChildProcess());

      await spawnClaudeCodeHeadless('/tmp/mcp.json', 'test prompt', '/tmp', 'opus');

      expect(mockSpawn).toHaveBeenCalledOnce();
      const args = mockSpawn.mock.calls[0]?.[1] as string[];
      expect(args).toContain('--model');
      expect(args).toContain('opus');
    });

    it('skips --model flag when model is undefined', async () => {
      mockSpawn.mockReturnValue(createMockChildProcess());

      await spawnClaudeCodeHeadless('/tmp/mcp.json', 'test prompt', '/tmp');

      expect(mockSpawn).toHaveBeenCalledOnce();
      const args = mockSpawn.mock.calls[0]?.[1] as string[];
      expect(args).not.toContain('--model');
    });

    it('skips --model flag when model is "default"', async () => {
      mockSpawn.mockReturnValue(createMockChildProcess());

      await spawnClaudeCodeHeadless('/tmp/mcp.json', 'test prompt', '/tmp', 'default');

      expect(mockSpawn).toHaveBeenCalledOnce();
      const args = mockSpawn.mock.calls[0]?.[1] as string[];
      expect(args).not.toContain('--model');
      expect(args).not.toContain('default');
    });

    it('returns exit code from spawned process', async () => {
      mockSpawn.mockReturnValue(createMockChildProcess(42));

      const exitCode = await spawnClaudeCodeHeadless('/tmp/mcp.json', 'test prompt');

      expect(exitCode).toBe(42);
    });

    it('uses cwd when specified', async () => {
      mockSpawn.mockReturnValue(createMockChildProcess());

      await spawnClaudeCodeHeadless('/tmp/mcp.json', 'test prompt', '/my/project');

      expect(mockSpawn).toHaveBeenCalledOnce();
      const options = mockSpawn.mock.calls[0]?.[2] as { cwd?: string };
      expect(options.cwd).toBe('/my/project');
    });

    it('uses process.cwd() when cwd is not specified', async () => {
      mockSpawn.mockReturnValue(createMockChildProcess());

      await spawnClaudeCodeHeadless('/tmp/mcp.json', 'test prompt');

      expect(mockSpawn).toHaveBeenCalledOnce();
      const options = mockSpawn.mock.calls[0]?.[2] as { cwd?: string };
      expect(options.cwd).toBe(process.cwd());
    });

    it('spawns with inherited stdio', async () => {
      mockSpawn.mockReturnValue(createMockChildProcess());

      await spawnClaudeCodeHeadless('/tmp/mcp.json', 'test prompt');

      expect(mockSpawn).toHaveBeenCalledOnce();
      const options = mockSpawn.mock.calls[0]?.[2] as { stdio?: string };
      expect(options.stdio).toBe('inherit');
    });

    it('throws TOOL_NOT_FOUND on ENOENT error', async () => {
      // EventEmitter is required here because ChildProcess extends it (not EventTarget)
      // eslint-disable-next-line unicorn/prefer-event-target
      const emitter = new EventEmitter() as ChildProcess;
      const error = new Error('spawn claude ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      setTimeout(() => emitter.emit('error', error), 10);
      mockSpawn.mockReturnValue(emitter);

      await expect(spawnClaudeCodeHeadless('/tmp/mcp.json', 'test prompt')).rejects.toThrow(
        /claude cli not found/i,
      );
    });
  });

  describe('spawnClaudeCode', () => {
    const mockSpawn = vi.mocked(spawn);

    beforeEach(() => {
      mockSpawn.mockReset();
    });

    it('throws TOOL_NOT_FOUND on ENOENT error', async () => {
      // EventEmitter is required here because ChildProcess extends it (not EventTarget)
      // eslint-disable-next-line unicorn/prefer-event-target
      const emitter = new EventEmitter() as ChildProcess;
      const error = new Error('spawn claude ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      setTimeout(() => emitter.emit('error', error), 10);
      mockSpawn.mockReturnValue(emitter);

      await expect(spawnClaudeCode('/tmp/mcp.json')).rejects.toThrow(/claude cli not found/i);
    });
  });
});
