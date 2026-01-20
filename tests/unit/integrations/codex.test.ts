import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  aggregateCodexMCPConfigs,
  cleanupCodexSession,
  createCodexSession,
  detectCodexCLI,
  generateCodexConfigFile,
  getCodexHome,
  getCodexOperationalDirs,
  getCodexTargetDir,
  getTzCodexTrustPath,
  readTzCodexTrust,
  spawnCodex,
  writeTzCodexTrust,
} from '../../../src/integrations/codex.js';

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

describe('codex integration', () => {
  let tmpDir: string;
  let fakeHomeDir: string;
  let originalHome: string | undefined;
  let originalUserProfile: string | undefined;
  let originalCodexHome: string | undefined;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tz-codex-test-'));
    fakeHomeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tz-codex-home-'));
    originalHome = process.env.HOME;
    originalUserProfile = process.env.USERPROFILE;
    originalCodexHome = process.env.CODEX_HOME;
    process.env.HOME = fakeHomeDir;
    process.env.USERPROFILE = fakeHomeDir;
    delete process.env.CODEX_HOME;
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
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
  });

  describe('detectCodexCLI', () => {
    it('returns a boolean indicating CLI availability', async () => {
      const result = await detectCodexCLI();
      expect(typeof result).toBe('boolean');
    });
  });

  describe('getCodexHome', () => {
    it('returns CODEX_HOME env var when set', () => {
      process.env.CODEX_HOME = '/custom/codex/home';
      expect(getCodexHome()).toBe('/custom/codex/home');
    });

    it('returns default ~/.codex when env var not set', () => {
      delete process.env.CODEX_HOME;
      // getCodexHome uses os.homedir() which returns the actual home dir
      // Just verify it returns a path ending in .codex
      const result = getCodexHome();
      expect(result.endsWith('.codex')).toBe(true);
    });
  });

  describe('getTzCodexTrustPath', () => {
    it('returns path to codex-trust.toml in .terrazul directory', () => {
      const result = getTzCodexTrustPath();
      expect(result).toContain('.terrazul');
      expect(result.endsWith('codex-trust.toml')).toBe(true);
    });
  });

  describe('readTzCodexTrust', () => {
    it('returns empty object when trust file does not exist', async () => {
      const result = await readTzCodexTrust();
      expect(result).toEqual({});
    });

    it('reads and parses trust file correctly', async () => {
      const terrazulDir = path.join(fakeHomeDir, '.terrazul');
      await fs.mkdir(terrazulDir, { recursive: true });

      const trustContent = `[projects."/path/to/project"]
trust_level = "trusted"

[projects."/path/to/another"]
trust_level = "untrusted"
`;
      await fs.writeFile(path.join(terrazulDir, 'codex-trust.toml'), trustContent);

      const result = await readTzCodexTrust();
      expect(result['/path/to/project']).toEqual({ trust_level: 'trusted' });
      expect(result['/path/to/another']).toEqual({ trust_level: 'untrusted' });
    });

    it('returns empty object when trust file is malformed', async () => {
      const terrazulDir = path.join(fakeHomeDir, '.terrazul');
      await fs.mkdir(terrazulDir, { recursive: true });

      await fs.writeFile(path.join(terrazulDir, 'codex-trust.toml'), 'invalid toml {{{');

      const result = await readTzCodexTrust();
      expect(result).toEqual({});
    });
  });

  describe('writeTzCodexTrust', () => {
    it('creates trust file with project settings', async () => {
      const projects = {
        '/path/to/project': { trust_level: 'trusted' },
        '/path/to/another': { trust_level: 'untrusted' },
      };

      await writeTzCodexTrust(projects);

      const trustPath = path.join(fakeHomeDir, '.terrazul', 'codex-trust.toml');
      const content = await fs.readFile(trustPath, 'utf8');
      expect(content).toContain('[projects."/path/to/project"]');
      expect(content).toContain('trust_level = "trusted"');
      expect(content).toContain('[projects."/path/to/another"]');
      expect(content).toContain('trust_level = "untrusted"');
    });

    it('creates .terrazul directory if it does not exist', async () => {
      const projects = {
        '/test/path': { trust_level: 'trusted' },
      };

      await writeTzCodexTrust(projects);

      const terrazulDir = path.join(fakeHomeDir, '.terrazul');
      const dirExists = await fs
        .access(terrazulDir)
        .then(() => true)
        .catch(() => false);
      expect(dirExists).toBe(true);
    });

    it('overwrites existing trust file', async () => {
      const terrazulDir = path.join(fakeHomeDir, '.terrazul');
      await fs.mkdir(terrazulDir, { recursive: true });
      await fs.writeFile(
        path.join(terrazulDir, 'codex-trust.toml'),
        '[projects."/old/path"]\ntrust_level = "old"',
      );

      await writeTzCodexTrust({ '/new/path': { trust_level: 'trusted' } });

      const content = await fs.readFile(path.join(terrazulDir, 'codex-trust.toml'), 'utf8');
      expect(content).not.toContain('/old/path');
      expect(content).toContain('/new/path');
    });
  });

  describe('aggregateCodexMCPConfigs', () => {
    it('returns empty config when no packages have MCP servers', async () => {
      const config = await aggregateCodexMCPConfigs(tmpDir, []);
      expect(config).toEqual({ mcp_servers: {} });
    });

    it('aggregates MCP configs from multiple packages', async () => {
      // Create agent_modules structure with TOML MCP configs
      const agentModulesRoot = path.join(tmpDir, 'agent_modules');
      const pkg1Dir = path.join(agentModulesRoot, '@test', 'pkg1', 'codex');
      const pkg2Dir = path.join(agentModulesRoot, '@test', 'pkg2', 'codex');

      await fs.mkdir(pkg1Dir, { recursive: true });
      await fs.mkdir(pkg2Dir, { recursive: true });

      // Create TOML MCP config files
      const mcp1 = `[mcp_servers.server1]
command = "node"
args = ["server1.js"]
`;

      const mcp2 = `[mcp_servers.server2]
command = "node"
args = ["server2.js"]
`;

      await fs.writeFile(path.join(pkg1Dir, 'mcp_servers.toml'), mcp1);
      await fs.writeFile(path.join(pkg2Dir, 'mcp_servers.toml'), mcp2);

      const config = await aggregateCodexMCPConfigs(tmpDir, ['@test/pkg1', '@test/pkg2'], {
        agentModulesRoot,
      });

      expect(config.mcp_servers).toHaveProperty('server1');
      expect(config.mcp_servers).toHaveProperty('server2');
      expect(config.mcp_servers.server1.command).toBe('node');
      expect(config.mcp_servers.server2.command).toBe('node');
    });

    it('handles packages without MCP config gracefully', async () => {
      const agentModulesRoot = path.join(tmpDir, 'agent_modules');
      const pkgDir = path.join(agentModulesRoot, '@test', 'pkg-no-mcp');
      await fs.mkdir(pkgDir, { recursive: true });

      const config = await aggregateCodexMCPConfigs(tmpDir, ['@test/pkg-no-mcp'], {
        agentModulesRoot,
      });
      expect(config).toEqual({ mcp_servers: {} });
    });

    it('throws error on duplicate MCP server names', async () => {
      const agentModulesRoot = path.join(tmpDir, 'agent_modules');
      const pkg1Dir = path.join(agentModulesRoot, '@test', 'pkg1', 'codex');
      const pkg2Dir = path.join(agentModulesRoot, '@test', 'pkg2', 'codex');

      await fs.mkdir(pkg1Dir, { recursive: true });
      await fs.mkdir(pkg2Dir, { recursive: true });

      const mcp1 = `[mcp_servers.duplicate]
command = "node"
args = ["server1.js"]
`;

      const mcp2 = `[mcp_servers.duplicate]
command = "node"
args = ["server2.js"]
`;

      await fs.writeFile(path.join(pkg1Dir, 'mcp_servers.toml'), mcp1);
      await fs.writeFile(path.join(pkg2Dir, 'mcp_servers.toml'), mcp2);

      await expect(
        aggregateCodexMCPConfigs(tmpDir, ['@test/pkg1', '@test/pkg2'], { agentModulesRoot }),
      ).rejects.toThrow(/duplicate.*mcp server/i);
    });

    it('handles malformed TOML config gracefully', async () => {
      const agentModulesRoot = path.join(tmpDir, 'agent_modules');
      const pkgDir = path.join(agentModulesRoot, '@test', 'pkg-bad', 'codex');
      await fs.mkdir(pkgDir, { recursive: true });

      await fs.writeFile(path.join(pkgDir, 'mcp_servers.toml'), 'invalid toml {{{');

      await expect(
        aggregateCodexMCPConfigs(tmpDir, ['@test/pkg-bad'], { agentModulesRoot }),
      ).rejects.toThrow();
    });
  });

  describe('generateCodexConfigFile', () => {
    it('writes MCP config as TOML to specified path', async () => {
      const configPath = path.join(tmpDir, 'config.toml');
      const config = {
        mcp_servers: {
          test: {
            command: 'node',
            args: ['test.js'],
          },
        },
      };

      await generateCodexConfigFile(configPath, config);

      const written = await fs.readFile(configPath, 'utf8');

      // Verify it's valid TOML with expected content
      expect(written).toContain('[mcp_servers.test]');
      expect(written).toContain('command = "node"');
      expect(written).toContain('args = [ "test.js" ]');
    });

    it('creates parent directories if needed', async () => {
      const configPath = path.join(tmpDir, 'nested', 'dir', 'config.toml');
      const config = {
        mcp_servers: {},
      };

      await generateCodexConfigFile(configPath, config);

      const exists = await fs
        .access(configPath)
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(true);
    });

    it('overwrites existing file', async () => {
      const configPath = path.join(tmpDir, 'config.toml');

      await fs.writeFile(configPath, 'old content');

      const config = {
        mcp_servers: {
          new: {
            command: 'echo',
            args: ['hello'],
          },
        },
      };

      await generateCodexConfigFile(configPath, config);

      const written = await fs.readFile(configPath, 'utf8');
      expect(written).not.toContain('old content');
      expect(written).toContain('echo');
    });
  });

  describe('createCodexSession', () => {
    it('creates isolated CODEX_HOME with config, prompts, and skills directories', async () => {
      const agentModulesRoot = path.join(tmpDir, 'agent_modules');
      await fs.mkdir(agentModulesRoot, { recursive: true });

      const session = await createCodexSession(tmpDir, [], agentModulesRoot);

      try {
        // Verify session structure
        expect(session.tempCodexHome).toContain('tz-codex-');
        expect(session.configPath).toBe(path.join(session.tempCodexHome, 'config.toml'));
        expect(session.promptsDir).toBe(path.join(session.tempCodexHome, 'prompts'));
        expect(session.skillsDir).toBe(path.join(session.tempCodexHome, 'skills'));

        // Verify directories exist
        const configExists = await fs
          .access(session.configPath)
          .then(() => true)
          .catch(() => false);
        const promptsDirExists = await fs
          .access(session.promptsDir)
          .then(() => true)
          .catch(() => false);
        const skillsDirExists = await fs
          .access(session.skillsDir)
          .then(() => true)
          .catch(() => false);

        expect(configExists).toBe(true);
        expect(promptsDirExists).toBe(true);
        expect(skillsDirExists).toBe(true);
      } finally {
        await cleanupCodexSession(session);
      }
    });

    it('symlinks prompts from packages to session prompts directory', async () => {
      const agentModulesRoot = path.join(tmpDir, 'agent_modules');
      const pkgPromptsDir = path.join(agentModulesRoot, '@test', 'pkg1', 'codex', 'prompts');
      await fs.mkdir(pkgPromptsDir, { recursive: true });
      await fs.writeFile(path.join(pkgPromptsDir, 'my-prompt.md'), '# My Prompt\nContent here');

      const session = await createCodexSession(tmpDir, ['@test/pkg1'], agentModulesRoot);

      try {
        // Verify prompt symlink exists with namespaced name
        const symlinkPath = path.join(session.promptsDir, '@test-pkg1-my-prompt.md');
        const symlinkExists = await fs
          .access(symlinkPath)
          .then(() => true)
          .catch(() => false);
        expect(symlinkExists).toBe(true);

        // Verify content is accessible via symlink
        const content = await fs.readFile(symlinkPath, 'utf8');
        expect(content).toContain('# My Prompt');
      } finally {
        await cleanupCodexSession(session);
      }
    });

    it('symlinks skills from packages to session skills directory', async () => {
      const agentModulesRoot = path.join(tmpDir, 'agent_modules');
      const pkgSkillsDir = path.join(agentModulesRoot, '@test', 'pkg1', 'codex', 'skills');
      const skillDir = path.join(pkgSkillsDir, 'my-skill');
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(path.join(skillDir, 'SKILL.md'), '# My Skill\nDescription');

      const session = await createCodexSession(tmpDir, ['@test/pkg1'], agentModulesRoot);

      try {
        // Verify skill directory symlink exists with namespaced name
        const symlinkPath = path.join(session.skillsDir, '@test-pkg1-my-skill');
        const symlinkExists = await fs
          .access(symlinkPath)
          .then(() => true)
          .catch(() => false);
        expect(symlinkExists).toBe(true);

        // Verify content is accessible via symlink
        const content = await fs.readFile(path.join(symlinkPath, 'SKILL.md'), 'utf8');
        expect(content).toContain('# My Skill');
      } finally {
        await cleanupCodexSession(session);
      }
    });

    it('copies auth.json from user CODEX_HOME to session directory', async () => {
      const agentModulesRoot = path.join(tmpDir, 'agent_modules');
      await fs.mkdir(agentModulesRoot, { recursive: true });

      // Create a fake user CODEX_HOME with auth.json
      const userCodexHome = path.join(fakeHomeDir, '.codex');
      await fs.mkdir(userCodexHome, { recursive: true });
      const authContent = JSON.stringify({ token: 'test-token', user: 'testuser' });
      await fs.writeFile(path.join(userCodexHome, 'auth.json'), authContent);

      // Set CODEX_HOME explicitly to use our fake directory
      process.env.CODEX_HOME = userCodexHome;

      const session = await createCodexSession(tmpDir, [], agentModulesRoot);

      try {
        // Verify auth.json was copied to session directory
        const sessionAuthPath = path.join(session.tempCodexHome, 'auth.json');
        const sessionAuthExists = await fs
          .access(sessionAuthPath)
          .then(() => true)
          .catch(() => false);
        expect(sessionAuthExists).toBe(true);

        // Verify content matches
        const copiedContent = await fs.readFile(sessionAuthPath, 'utf8');
        expect(copiedContent).toBe(authContent);
      } finally {
        await cleanupCodexSession(session);
      }
    });

    it('handles missing auth.json gracefully', async () => {
      const agentModulesRoot = path.join(tmpDir, 'agent_modules');
      await fs.mkdir(agentModulesRoot, { recursive: true });

      // Set CODEX_HOME to a directory without auth.json
      const emptyCodexHome = path.join(fakeHomeDir, '.codex-empty');
      await fs.mkdir(emptyCodexHome, { recursive: true });
      process.env.CODEX_HOME = emptyCodexHome;

      const session = await createCodexSession(tmpDir, [], agentModulesRoot);

      try {
        // Should still create session successfully
        expect(session.tempCodexHome).toContain('tz-codex-');

        // auth.json should not exist in session
        const sessionAuthPath = path.join(session.tempCodexHome, 'auth.json');
        const sessionAuthExists = await fs
          .access(sessionAuthPath)
          .then(() => true)
          .catch(() => false);
        expect(sessionAuthExists).toBe(false);
      } finally {
        await cleanupCodexSession(session);
      }
    });

    it('aggregates MCP configs from packages into config.toml', async () => {
      const agentModulesRoot = path.join(tmpDir, 'agent_modules');
      const pkgDir = path.join(agentModulesRoot, '@test', 'pkg1', 'codex');
      await fs.mkdir(pkgDir, { recursive: true });

      const mcpConfig = `[mcp_servers.context7]
command = "npx"
args = ["-y", "@upstash/context7-mcp"]
`;
      await fs.writeFile(path.join(pkgDir, 'mcp_servers.toml'), mcpConfig);

      const session = await createCodexSession(tmpDir, ['@test/pkg1'], agentModulesRoot);

      try {
        const configContent = await fs.readFile(session.configPath, 'utf8');
        expect(configContent).toContain('[mcp_servers.context7]');
        expect(configContent).toContain('npx');
      } finally {
        await cleanupCodexSession(session);
      }
    });

    it('merges user config.toml settings into session config', async () => {
      const agentModulesRoot = path.join(tmpDir, 'agent_modules');
      await fs.mkdir(agentModulesRoot, { recursive: true });

      // Create user's existing config.toml with model preferences and MCP servers
      const userCodexHome = path.join(fakeHomeDir, '.codex');
      await fs.mkdir(userCodexHome, { recursive: true });
      const userConfig = `model = "gpt-4"
temperature = 0.7

[mcp_servers.global-server]
command = "node"
args = ["global.js"]
`;
      await fs.writeFile(path.join(userCodexHome, 'config.toml'), userConfig);

      process.env.CODEX_HOME = userCodexHome;

      const session = await createCodexSession(tmpDir, [], agentModulesRoot);

      try {
        const configContent = await fs.readFile(session.configPath, 'utf8');
        // User's model preferences should be preserved
        expect(configContent).toContain('model = "gpt-4"');
        expect(configContent).toContain('temperature = 0.7');
        // User's global MCP servers should be preserved
        expect(configContent).toContain('[mcp_servers.global-server]');
        expect(configContent).toContain('global.js');
      } finally {
        await cleanupCodexSession(session);
      }
    });

    it('merges tz trust settings into session config', async () => {
      const agentModulesRoot = path.join(tmpDir, 'agent_modules');
      await fs.mkdir(agentModulesRoot, { recursive: true });

      // Create tz trust file with project trust settings
      const terrazulDir = path.join(fakeHomeDir, '.terrazul');
      await fs.mkdir(terrazulDir, { recursive: true });
      const trustContent = `[projects."/trusted/project"]
trust_level = "trusted"
`;
      await fs.writeFile(path.join(terrazulDir, 'codex-trust.toml'), trustContent);

      const session = await createCodexSession(tmpDir, [], agentModulesRoot);

      try {
        const configContent = await fs.readFile(session.configPath, 'utf8');
        // TZ trust settings should be included
        expect(configContent).toContain('[projects."/trusted/project"]');
        expect(configContent).toContain('trust_level = "trusted"');
      } finally {
        await cleanupCodexSession(session);
      }
    });

    it('tz trust takes precedence over user trust for same project', async () => {
      const agentModulesRoot = path.join(tmpDir, 'agent_modules');
      await fs.mkdir(agentModulesRoot, { recursive: true });

      // Create user config with project trust
      const userCodexHome = path.join(fakeHomeDir, '.codex');
      await fs.mkdir(userCodexHome, { recursive: true });
      const userConfig = `[projects."/same/project"]
trust_level = "untrusted"
`;
      await fs.writeFile(path.join(userCodexHome, 'config.toml'), userConfig);
      process.env.CODEX_HOME = userCodexHome;

      // Create tz trust with different trust level for same project
      const terrazulDir = path.join(fakeHomeDir, '.terrazul');
      await fs.mkdir(terrazulDir, { recursive: true });
      const trustContent = `[projects."/same/project"]
trust_level = "trusted"
`;
      await fs.writeFile(path.join(terrazulDir, 'codex-trust.toml'), trustContent);

      const session = await createCodexSession(tmpDir, [], agentModulesRoot);

      try {
        const configContent = await fs.readFile(session.configPath, 'utf8');
        // TZ trust should take precedence (trusted, not untrusted)
        expect(configContent).toContain('[projects."/same/project"]');
        expect(configContent).toContain('trust_level = "trusted"');
        expect(configContent).not.toContain('trust_level = "untrusted"');
      } finally {
        await cleanupCodexSession(session);
      }
    });

    it('package MCP servers override user MCP servers with same name', async () => {
      const agentModulesRoot = path.join(tmpDir, 'agent_modules');
      const pkgDir = path.join(agentModulesRoot, '@test', 'pkg1', 'codex');
      await fs.mkdir(pkgDir, { recursive: true });

      // Create user config with MCP server
      const userCodexHome = path.join(fakeHomeDir, '.codex');
      await fs.mkdir(userCodexHome, { recursive: true });
      const userConfig = `[mcp_servers.shared-server]
command = "user-cmd"
args = ["user.js"]
`;
      await fs.writeFile(path.join(userCodexHome, 'config.toml'), userConfig);
      process.env.CODEX_HOME = userCodexHome;

      // Create package MCP config with same server name
      const mcpConfig = `[mcp_servers.shared-server]
command = "pkg-cmd"
args = ["package.js"]
`;
      await fs.writeFile(path.join(pkgDir, 'mcp_servers.toml'), mcpConfig);

      const session = await createCodexSession(tmpDir, ['@test/pkg1'], agentModulesRoot);

      try {
        const configContent = await fs.readFile(session.configPath, 'utf8');
        // Package MCP server should take precedence
        expect(configContent).toContain('[mcp_servers.shared-server]');
        expect(configContent).toContain('pkg-cmd');
        expect(configContent).toContain('package.js');
        expect(configContent).not.toContain('user-cmd');
      } finally {
        await cleanupCodexSession(session);
      }
    });
  });

  describe('cleanupCodexSession', () => {
    it('removes temporary CODEX_HOME directory', async () => {
      const agentModulesRoot = path.join(tmpDir, 'agent_modules');
      await fs.mkdir(agentModulesRoot, { recursive: true });

      const session = await createCodexSession(tmpDir, [], agentModulesRoot);

      // Verify it exists
      const existsBefore = await fs
        .access(session.tempCodexHome)
        .then(() => true)
        .catch(() => false);
      expect(existsBefore).toBe(true);

      // Clean up
      await cleanupCodexSession(session);

      // Verify it's gone
      const existsAfter = await fs
        .access(session.tempCodexHome)
        .then(() => true)
        .catch(() => false);
      expect(existsAfter).toBe(false);
    });

    it('does not throw if directory does not exist', async () => {
      const fakeSession = {
        tempCodexHome: path.join(tmpDir, 'nonexistent'),
        configPath: path.join(tmpDir, 'nonexistent', 'config.toml'),
        promptsDir: path.join(tmpDir, 'nonexistent', 'prompts'),
        skillsDir: path.join(tmpDir, 'nonexistent', 'skills'),
      };

      await expect(cleanupCodexSession(fakeSession)).resolves.not.toThrow();
    });

    it('persists new project trust settings to tz trust file', async () => {
      const agentModulesRoot = path.join(tmpDir, 'agent_modules');
      await fs.mkdir(agentModulesRoot, { recursive: true });

      const session = await createCodexSession(tmpDir, [], agentModulesRoot);

      // Simulate Codex adding trust for a project during session
      const sessionConfigPath = path.join(session.tempCodexHome, 'config.toml');
      const configWithTrust = `[projects."/new/trusted/project"]
trust_level = "trusted"
`;
      await fs.writeFile(sessionConfigPath, configWithTrust);

      // Clean up - should persist trust
      await cleanupCodexSession(session);

      // Verify trust was persisted to tz trust file
      const trustPath = path.join(fakeHomeDir, '.terrazul', 'codex-trust.toml');
      const trustContent = await fs.readFile(trustPath, 'utf8');
      expect(trustContent).toContain('[projects."/new/trusted/project"]');
      expect(trustContent).toContain('trust_level = "trusted"');
    });

    it('merges new trust with existing tz trust file', async () => {
      const agentModulesRoot = path.join(tmpDir, 'agent_modules');
      await fs.mkdir(agentModulesRoot, { recursive: true });

      // Create existing tz trust file
      const terrazulDir = path.join(fakeHomeDir, '.terrazul');
      await fs.mkdir(terrazulDir, { recursive: true });
      const existingTrust = `[projects."/existing/project"]
trust_level = "trusted"
`;
      await fs.writeFile(path.join(terrazulDir, 'codex-trust.toml'), existingTrust);

      const session = await createCodexSession(tmpDir, [], agentModulesRoot);

      // Simulate Codex adding trust for a new project during session
      const sessionConfigPath = path.join(session.tempCodexHome, 'config.toml');
      const configWithTrust = `[projects."/existing/project"]
trust_level = "trusted"

[projects."/new/project"]
trust_level = "trusted"
`;
      await fs.writeFile(sessionConfigPath, configWithTrust);

      // Clean up - should merge trust
      await cleanupCodexSession(session);

      // Verify both trusts are in the file
      const trustPath = path.join(fakeHomeDir, '.terrazul', 'codex-trust.toml');
      const trustContent = await fs.readFile(trustPath, 'utf8');
      expect(trustContent).toContain('[projects."/existing/project"]');
      expect(trustContent).toContain('[projects."/new/project"]');
    });

    it('session trust overrides existing tz trust for same project', async () => {
      const agentModulesRoot = path.join(tmpDir, 'agent_modules');
      await fs.mkdir(agentModulesRoot, { recursive: true });

      // Create existing tz trust file with untrusted project
      const terrazulDir = path.join(fakeHomeDir, '.terrazul');
      await fs.mkdir(terrazulDir, { recursive: true });
      const existingTrust = `[projects."/project"]
trust_level = "untrusted"
`;
      await fs.writeFile(path.join(terrazulDir, 'codex-trust.toml'), existingTrust);

      const session = await createCodexSession(tmpDir, [], agentModulesRoot);

      // Simulate Codex changing trust during session
      const sessionConfigPath = path.join(session.tempCodexHome, 'config.toml');
      const configWithTrust = `[projects."/project"]
trust_level = "trusted"
`;
      await fs.writeFile(sessionConfigPath, configWithTrust);

      // Clean up - should update trust
      await cleanupCodexSession(session);

      // Verify trust was updated
      const trustPath = path.join(fakeHomeDir, '.terrazul', 'codex-trust.toml');
      const trustContent = await fs.readFile(trustPath, 'utf8');
      expect(trustContent).toContain('trust_level = "trusted"');
      expect(trustContent).not.toContain('trust_level = "untrusted"');
    });

    it('handles missing config.toml during cleanup gracefully', async () => {
      const agentModulesRoot = path.join(tmpDir, 'agent_modules');
      await fs.mkdir(agentModulesRoot, { recursive: true });

      const session = await createCodexSession(tmpDir, [], agentModulesRoot);

      // Remove config.toml to simulate edge case
      await fs.rm(session.configPath);

      // Should not throw
      await expect(cleanupCodexSession(session)).resolves.not.toThrow();
    });

    it('does not persist trust when config has no projects', async () => {
      const agentModulesRoot = path.join(tmpDir, 'agent_modules');
      await fs.mkdir(agentModulesRoot, { recursive: true });

      const session = await createCodexSession(tmpDir, [], agentModulesRoot);

      // Config has no projects section
      await fs.writeFile(session.configPath, '[mcp_servers]\n');

      // Clean up
      await cleanupCodexSession(session);

      // Trust file should not be created
      const trustPath = path.join(fakeHomeDir, '.terrazul', 'codex-trust.toml');
      const trustExists = await fs
        .access(trustPath)
        .then(() => true)
        .catch(() => false);
      expect(trustExists).toBe(false);
    });
  });

  describe('spawnCodex', () => {
    const mockSpawn = vi.mocked(spawn);

    beforeEach(() => {
      mockSpawn.mockReset();
    });

    it('spawns codex with CODEX_HOME environment variable', async () => {
      mockSpawn.mockReturnValue(createMockChildProcess());

      const session = {
        tempCodexHome: '/tmp/tz-codex-test',
        configPath: '/tmp/tz-codex-test/config.toml',
        promptsDir: '/tmp/tz-codex-test/prompts',
        skillsDir: '/tmp/tz-codex-test/skills',
      };

      await spawnCodex(session, [], '/tmp');

      expect(mockSpawn).toHaveBeenCalledOnce();
      expect(mockSpawn).toHaveBeenCalledWith('codex', [], {
        cwd: '/tmp',
        stdio: 'inherit',
        shell: false,
        env: expect.objectContaining({
          CODEX_HOME: '/tmp/tz-codex-test',
        }),
      });
    });

    it('passes additional args to codex', async () => {
      mockSpawn.mockReturnValue(createMockChildProcess());

      const session = {
        tempCodexHome: '/tmp/tz-codex-test',
        configPath: '/tmp/tz-codex-test/config.toml',
        promptsDir: '/tmp/tz-codex-test/prompts',
        skillsDir: '/tmp/tz-codex-test/skills',
      };

      await spawnCodex(session, ['--verbose', '--debug'], '/tmp');

      expect(mockSpawn).toHaveBeenCalledOnce();
      const args = mockSpawn.mock.calls[0]?.[1] as string[];
      expect(args).toContain('--verbose');
      expect(args).toContain('--debug');
    });

    it('returns exit code from spawned process', async () => {
      mockSpawn.mockReturnValue(createMockChildProcess(42));

      const session = {
        tempCodexHome: '/tmp/tz-codex-test',
        configPath: '/tmp/tz-codex-test/config.toml',
        promptsDir: '/tmp/tz-codex-test/prompts',
        skillsDir: '/tmp/tz-codex-test/skills',
      };

      const exitCode = await spawnCodex(session);

      expect(exitCode).toBe(42);
    });
  });

  describe('getCodexOperationalDirs', () => {
    it('returns skills and prompts directories', () => {
      const dirs = getCodexOperationalDirs();
      expect(dirs).toEqual(['skills', 'prompts']);
    });
  });

  describe('getCodexTargetDir', () => {
    it('returns the temp CODEX_HOME directory', () => {
      const result = getCodexTargetDir('/tmp/tz-codex-123');
      expect(result).toBe('/tmp/tz-codex-123');
    });
  });
});
