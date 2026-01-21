import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  aggregateGeminiMCPConfigs,
  cleanupGeminiMCPConfig,
  readGeminiSettings,
  writeGeminiMCPConfig,
} from '../../../src/integrations/gemini-mcp.js';

describe('gemini-mcp integration', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tz-gemini-test-'));
  });

  afterEach(async () => {
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      void 0;
    }
  });

  describe('readGeminiSettings', () => {
    it('returns empty object when settings file does not exist', async () => {
      const settings = await readGeminiSettings(tmpDir);
      expect(settings).toEqual({});
    });

    it('reads existing settings from .gemini/settings.json', async () => {
      const geminiDir = path.join(tmpDir, '.gemini');
      await fs.mkdir(geminiDir, { recursive: true });
      await fs.writeFile(
        path.join(geminiDir, 'settings.json'),
        JSON.stringify({
          mcpServers: {
            testServer: { command: 'node', args: ['server.js'] },
          },
          otherSetting: 'value',
        }),
      );

      const settings = await readGeminiSettings(tmpDir);
      expect(settings.mcpServers).toEqual({
        testServer: { command: 'node', args: ['server.js'] },
      });
      expect(settings.otherSetting).toBe('value');
    });

    it('returns empty object for invalid JSON', async () => {
      const geminiDir = path.join(tmpDir, '.gemini');
      await fs.mkdir(geminiDir, { recursive: true });
      await fs.writeFile(path.join(geminiDir, 'settings.json'), 'not valid json');

      const settings = await readGeminiSettings(tmpDir);
      expect(settings).toEqual({});
    });
  });

  describe('writeGeminiMCPConfig', () => {
    it('creates .gemini directory and settings.json if they do not exist', async () => {
      const mcpServers = {
        myServer: { command: 'npx', args: ['-y', 'my-mcp-server'] },
      };

      const settingsPath = await writeGeminiMCPConfig(tmpDir, mcpServers);

      expect(settingsPath).toBe(path.join(tmpDir, '.gemini', 'settings.json'));
      const content = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
      expect(content.mcpServers).toEqual(mcpServers);
    });

    it('merges MCP servers with existing settings', async () => {
      // Create existing settings
      const geminiDir = path.join(tmpDir, '.gemini');
      await fs.mkdir(geminiDir, { recursive: true });
      await fs.writeFile(
        path.join(geminiDir, 'settings.json'),
        JSON.stringify({
          existingSetting: 'preserved',
          mcpServers: {
            existingServer: { command: 'existing' },
          },
        }),
      );

      // Write new MCP servers
      const newServers = {
        newServer: { command: 'new', args: ['arg1'] },
      };
      await writeGeminiMCPConfig(tmpDir, newServers);

      const content = JSON.parse(await fs.readFile(path.join(geminiDir, 'settings.json'), 'utf8'));
      expect(content.existingSetting).toBe('preserved');
      expect(content.mcpServers.existingServer).toEqual({ command: 'existing' });
      expect(content.mcpServers.newServer).toEqual({ command: 'new', args: ['arg1'] });
    });

    it('overwrites existing MCP server with same name', async () => {
      const geminiDir = path.join(tmpDir, '.gemini');
      await fs.mkdir(geminiDir, { recursive: true });
      await fs.writeFile(
        path.join(geminiDir, 'settings.json'),
        JSON.stringify({
          mcpServers: {
            myServer: { command: 'old' },
          },
        }),
      );

      await writeGeminiMCPConfig(tmpDir, {
        myServer: { command: 'new', args: ['updated'] },
      });

      const content = JSON.parse(await fs.readFile(path.join(geminiDir, 'settings.json'), 'utf8'));
      expect(content.mcpServers.myServer).toEqual({ command: 'new', args: ['updated'] });
    });
  });

  describe('aggregateGeminiMCPConfigs', () => {
    it('returns empty config when no packages provided', async () => {
      const config = await aggregateGeminiMCPConfigs(tmpDir, []);
      expect(config).toEqual({ mcpServers: {} });
    });

    it('aggregates MCP configs from agent_modules packages', async () => {
      // Create agent_modules with MCP configs
      const pkg1Dir = path.join(tmpDir, 'agent_modules', '@test', 'pkg1', 'gemini');
      const pkg2Dir = path.join(tmpDir, 'agent_modules', '@test', 'pkg2', 'gemini');

      await fs.mkdir(pkg1Dir, { recursive: true });
      await fs.mkdir(pkg2Dir, { recursive: true });

      await fs.writeFile(
        path.join(pkg1Dir, 'mcp_servers.json'),
        JSON.stringify({
          mcpServers: {
            server1: { command: 'node', args: ['s1.js'] },
          },
        }),
      );

      await fs.writeFile(
        path.join(pkg2Dir, 'mcp_servers.json'),
        JSON.stringify({
          mcpServers: {
            server2: { command: 'python', args: ['s2.py'] },
          },
        }),
      );

      const config = await aggregateGeminiMCPConfigs(tmpDir, ['@test/pkg1', '@test/pkg2']);

      expect(config.mcpServers.server1).toEqual({ command: 'node', args: ['s1.js'] });
      expect(config.mcpServers.server2).toEqual({ command: 'python', args: ['s2.py'] });
    });

    it('skips packages without MCP config', async () => {
      const pkg1Dir = path.join(tmpDir, 'agent_modules', '@test', 'pkg1', 'gemini');
      await fs.mkdir(pkg1Dir, { recursive: true });
      await fs.writeFile(
        path.join(pkg1Dir, 'mcp_servers.json'),
        JSON.stringify({
          mcpServers: {
            server1: { command: 'node' },
          },
        }),
      );

      // pkg2 has no MCP config
      const pkg2Dir = path.join(tmpDir, 'agent_modules', '@test', 'pkg2');
      await fs.mkdir(pkg2Dir, { recursive: true });

      const config = await aggregateGeminiMCPConfigs(tmpDir, ['@test/pkg1', '@test/pkg2']);

      expect(Object.keys(config.mcpServers)).toHaveLength(1);
      expect(config.mcpServers.server1).toBeDefined();
    });

    it('first server wins on duplicate names', async () => {
      const pkg1Dir = path.join(tmpDir, 'agent_modules', '@test', 'pkg1', 'gemini');
      const pkg2Dir = path.join(tmpDir, 'agent_modules', '@test', 'pkg2', 'gemini');

      await fs.mkdir(pkg1Dir, { recursive: true });
      await fs.mkdir(pkg2Dir, { recursive: true });

      await fs.writeFile(
        path.join(pkg1Dir, 'mcp_servers.json'),
        JSON.stringify({
          mcpServers: {
            duplicate: { command: 'first' },
          },
        }),
      );

      await fs.writeFile(
        path.join(pkg2Dir, 'mcp_servers.json'),
        JSON.stringify({
          mcpServers: {
            duplicate: { command: 'second' },
          },
        }),
      );

      const config = await aggregateGeminiMCPConfigs(tmpDir, ['@test/pkg1', '@test/pkg2']);

      expect(config.mcpServers.duplicate).toEqual({ command: 'first' });
    });
  });

  describe('cleanupGeminiMCPConfig', () => {
    it('removes specified servers from settings', async () => {
      const geminiDir = path.join(tmpDir, '.gemini');
      await fs.mkdir(geminiDir, { recursive: true });
      await fs.writeFile(
        path.join(geminiDir, 'settings.json'),
        JSON.stringify({
          otherSetting: 'keep',
          mcpServers: {
            server1: { command: 'a' },
            server2: { command: 'b' },
            server3: { command: 'c' },
          },
        }),
      );

      await cleanupGeminiMCPConfig(tmpDir, ['server1', 'server3']);

      const content = JSON.parse(await fs.readFile(path.join(geminiDir, 'settings.json'), 'utf8'));
      expect(content.otherSetting).toBe('keep');
      expect(content.mcpServers).toEqual({ server2: { command: 'b' } });
    });

    it('removes mcpServers key when all servers removed', async () => {
      const geminiDir = path.join(tmpDir, '.gemini');
      await fs.mkdir(geminiDir, { recursive: true });
      await fs.writeFile(
        path.join(geminiDir, 'settings.json'),
        JSON.stringify({
          otherSetting: 'keep',
          mcpServers: {
            server1: { command: 'a' },
          },
        }),
      );

      await cleanupGeminiMCPConfig(tmpDir, ['server1']);

      const content = JSON.parse(await fs.readFile(path.join(geminiDir, 'settings.json'), 'utf8'));
      expect(content.otherSetting).toBe('keep');
      expect(content.mcpServers).toBeUndefined();
    });

    it('does nothing if settings file does not exist', async () => {
      // Should not throw
      await cleanupGeminiMCPConfig(tmpDir, ['server1']);

      // Verify file still doesn't exist
      const exists = await fs
        .access(path.join(tmpDir, '.gemini', 'settings.json'))
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(false);
    });
  });
});
