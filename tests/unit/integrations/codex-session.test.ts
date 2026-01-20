import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock os.homedir to return our temp directory
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    default: {
      ...actual,
      homedir: vi.fn(),
    },
    homedir: vi.fn(),
  };
});

import {
  cleanupCodexSession,
  createCodexSession,
  getProjectTrust,
  getTrustFilePath,
  readCodexConfig,
  readTrustFile,
  setProjectTrust,
  writeTrustFile,
} from '../../../src/integrations/codex-session.js';

describe('codex-session', () => {
  let tmpDir: string;
  let originalCodexHome: string | undefined;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tz-codex-session-test-'));

    // Mock os.homedir to return tmpDir
    vi.mocked(os.homedir).mockReturnValue(tmpDir);

    // Save original env
    originalCodexHome = process.env.CODEX_HOME;

    // Clear CODEX_HOME to use default
    delete process.env.CODEX_HOME;
  });

  afterEach(async () => {
    // Restore original env
    if (originalCodexHome) {
      process.env.CODEX_HOME = originalCodexHome;
    } else {
      delete process.env.CODEX_HOME;
    }

    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      void 0;
    }
    vi.resetAllMocks();
  });

  describe('readTrustFile', () => {
    it('returns empty trust data when file does not exist', async () => {
      const trustData = await readTrustFile();
      expect(trustData).toEqual({ projects: {} });
    });

    it('reads trust data from file', async () => {
      const trustDir = path.join(tmpDir, '.terrazul');
      await fs.mkdir(trustDir, { recursive: true });
      await fs.writeFile(
        path.join(trustDir, 'codex-trust.toml'),
        '[projects."/path/to/project"]\ntrust_level = "trusted"\n',
      );

      const trustData = await readTrustFile();
      expect(trustData.projects['/path/to/project']).toEqual({ trust_level: 'trusted' });
    });
  });

  describe('writeTrustFile', () => {
    it('creates trust file with sorted projects', async () => {
      await writeTrustFile({
        projects: {
          '/z/project': { trust_level: 'trusted' },
          '/a/project': { trust_level: 'untrusted' },
        },
      });

      const content = await fs.readFile(getTrustFilePath(), 'utf8');
      // Projects should be alphabetically sorted
      const aIndex = content.indexOf('/a/project');
      const zIndex = content.indexOf('/z/project');
      expect(aIndex).toBeLessThan(zIndex);
    });

    it('creates directory if it does not exist', async () => {
      await writeTrustFile({
        projects: {
          '/test/project': { trust_level: 'trusted' },
        },
      });

      const exists = await fs
        .access(getTrustFilePath())
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(true);
    });
  });

  describe('readCodexConfig', () => {
    it('returns empty config when file does not exist', async () => {
      const config = await readCodexConfig();
      expect(config).toEqual({});
    });

    it('reads config from default CODEX_HOME', async () => {
      const codexHome = path.join(tmpDir, '.codex');
      await fs.mkdir(codexHome, { recursive: true });
      await fs.writeFile(
        path.join(codexHome, 'config.toml'),
        'model = "gpt-4"\napproval_mode = "suggest"\n',
      );

      const config = await readCodexConfig();
      expect(config.model).toBe('gpt-4');
      expect(config.approval_mode).toBe('suggest');
    });

    it('reads config from custom CODEX_HOME', async () => {
      const customHome = path.join(tmpDir, 'custom-codex');
      await fs.mkdir(customHome, { recursive: true });
      await fs.writeFile(path.join(customHome, 'config.toml'), 'model = "o3"\n');

      const config = await readCodexConfig(customHome);
      expect(config.model).toBe('o3');
    });
  });

  describe('createCodexSession', () => {
    it('creates temp CODEX_HOME directory', async () => {
      const projectRoot = path.join(tmpDir, 'project');
      await fs.mkdir(projectRoot, { recursive: true });

      const session = await createCodexSession(projectRoot, {});

      expect(session.tempCodexHome).toBe(path.join(projectRoot, '.terrazul', 'codex-home'));
      const exists = await fs
        .access(session.tempCodexHome)
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(true);

      await session.cleanup();
    });

    it('creates prompts directory inside temp CODEX_HOME', async () => {
      const projectRoot = path.join(tmpDir, 'project');
      await fs.mkdir(projectRoot, { recursive: true });

      const session = await createCodexSession(projectRoot, {});

      const promptsDir = path.join(session.tempCodexHome, 'prompts');
      const exists = await fs
        .access(promptsDir)
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(true);

      await session.cleanup();
    });

    it('copies auth.json from user CODEX_HOME', async () => {
      const projectRoot = path.join(tmpDir, 'project');
      await fs.mkdir(projectRoot, { recursive: true });

      // Create auth.json in user's CODEX_HOME
      const codexHome = path.join(tmpDir, '.codex');
      await fs.mkdir(codexHome, { recursive: true });
      const authData = { token: 'test-token', refresh_token: 'test-refresh' };
      await fs.writeFile(path.join(codexHome, 'auth.json'), JSON.stringify(authData));

      const session = await createCodexSession(projectRoot, {});

      // Verify auth.json was copied
      const copiedAuthPath = path.join(session.tempCodexHome, 'auth.json');
      const copiedContent = await fs.readFile(copiedAuthPath, 'utf8');
      expect(JSON.parse(copiedContent)).toEqual(authData);

      await session.cleanup();
    });

    it('handles missing auth.json gracefully', async () => {
      const projectRoot = path.join(tmpDir, 'project');
      await fs.mkdir(projectRoot, { recursive: true });

      // No auth.json in user's CODEX_HOME
      const session = await createCodexSession(projectRoot, {});

      // Should not throw, and auth.json should not exist in temp
      const copiedAuthPath = path.join(session.tempCodexHome, 'auth.json');
      const exists = await fs
        .access(copiedAuthPath)
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(false);

      await session.cleanup();
    });

    it('persists auth.json back to user CODEX_HOME on cleanup', async () => {
      const projectRoot = path.join(tmpDir, 'project');
      await fs.mkdir(projectRoot, { recursive: true });

      // User's CODEX_HOME without auth.json (not authenticated yet)
      const codexHome = path.join(tmpDir, '.codex');
      await fs.mkdir(codexHome, { recursive: true });

      const session = await createCodexSession(projectRoot, {});

      // Simulate user authenticating during session by creating auth.json in temp
      const newAuthData = { token: 'new-session-token', refresh_token: 'new-refresh' };
      await fs.writeFile(
        path.join(session.tempCodexHome, 'auth.json'),
        JSON.stringify(newAuthData),
      );

      await cleanupCodexSession(session);

      // Verify auth.json was persisted to user's CODEX_HOME
      const persistedAuthPath = path.join(codexHome, 'auth.json');
      const persistedContent = await fs.readFile(persistedAuthPath, 'utf8');
      expect(JSON.parse(persistedContent)).toEqual(newAuthData);
    });

    it('updates existing auth.json in user CODEX_HOME on cleanup', async () => {
      const projectRoot = path.join(tmpDir, 'project');
      await fs.mkdir(projectRoot, { recursive: true });

      // User's CODEX_HOME with existing auth.json
      const codexHome = path.join(tmpDir, '.codex');
      await fs.mkdir(codexHome, { recursive: true });
      const oldAuthData = { token: 'old-token', refresh_token: 'old-refresh' };
      await fs.writeFile(path.join(codexHome, 'auth.json'), JSON.stringify(oldAuthData));

      const session = await createCodexSession(projectRoot, {});

      // Simulate token refresh during session
      const refreshedAuthData = { token: 'refreshed-token', refresh_token: 'refreshed-refresh' };
      await fs.writeFile(
        path.join(session.tempCodexHome, 'auth.json'),
        JSON.stringify(refreshedAuthData),
      );

      await cleanupCodexSession(session);

      // Verify auth.json was updated in user's CODEX_HOME
      const persistedContent = await fs.readFile(path.join(codexHome, 'auth.json'), 'utf8');
      expect(JSON.parse(persistedContent)).toEqual(refreshedAuthData);
    });

    it('merges user config into temp config', async () => {
      const projectRoot = path.join(tmpDir, 'project');
      await fs.mkdir(projectRoot, { recursive: true });

      // Create user config
      const codexHome = path.join(tmpDir, '.codex');
      await fs.mkdir(codexHome, { recursive: true });
      await fs.writeFile(path.join(codexHome, 'config.toml'), 'model = "gpt-4"\n');

      const session = await createCodexSession(projectRoot, {});

      // Read the merged config
      const configContent = await fs.readFile(session.configPath, 'utf8');
      expect(configContent).toContain('model = "gpt-4"');

      await session.cleanup();
    });

    it('merges persisted trust settings into temp config', async () => {
      const projectRoot = path.join(tmpDir, 'project');
      await fs.mkdir(projectRoot, { recursive: true });

      // Create persisted trust
      await writeTrustFile({
        projects: {
          '/trusted/project': { trust_level: 'trusted' },
        },
      });

      const session = await createCodexSession(projectRoot, {});

      // Read the merged config
      const configContent = await fs.readFile(session.configPath, 'utf8');
      expect(configContent).toContain('/trusted/project');
      expect(configContent).toContain('trust_level = "trusted"');

      await session.cleanup();
    });

    it('merges MCP servers into temp config', async () => {
      const projectRoot = path.join(tmpDir, 'project');
      await fs.mkdir(projectRoot, { recursive: true });

      const mcpServers = {
        'test-server': {
          command: 'npx',
          args: ['-y', '@test/mcp'],
        },
      };

      const session = await createCodexSession(projectRoot, mcpServers);

      // Read the merged config
      const configContent = await fs.readFile(session.configPath, 'utf8');
      expect(configContent).toContain('test-server');
      expect(configContent).toContain('command = "npx"');

      await session.cleanup();
    });
  });

  describe('cleanupCodexSession', () => {
    it('deletes temp CODEX_HOME directory', async () => {
      const projectRoot = path.join(tmpDir, 'project');
      await fs.mkdir(projectRoot, { recursive: true });

      const session = await createCodexSession(projectRoot, {});

      // Verify temp dir exists
      let exists = await fs
        .access(session.tempCodexHome)
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(true);

      await cleanupCodexSession(session);

      // Verify temp dir is deleted
      exists = await fs
        .access(session.tempCodexHome)
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(false);
    });

    it('persists new trust settings from temp config', async () => {
      const projectRoot = path.join(tmpDir, 'project');
      await fs.mkdir(projectRoot, { recursive: true });

      const session = await createCodexSession(projectRoot, {});

      // Add trust setting to temp config (simulating user trusting a project)
      // Read the config, parse it, modify it, and write it back properly
      const configContent = await fs.readFile(session.configPath, 'utf8');
      const TOML = await import('@iarna/toml');
      const config = TOML.parse(configContent) as Record<string, unknown>;

      // Add new project trust
      if (!config.projects) {
        config.projects = {};
      }
      (config.projects as Record<string, unknown>)['/new/trusted/project'] = {
        trust_level: 'trusted',
      };

      // Write back
      await fs.writeFile(session.configPath, TOML.stringify(config as TOML.JsonMap), 'utf8');

      await cleanupCodexSession(session);

      // Verify trust was persisted
      const trustData = await readTrustFile();
      expect(trustData.projects['/new/trusted/project']).toEqual({ trust_level: 'trusted' });
    });

    it('merges new trust with existing trust settings', async () => {
      const projectRoot = path.join(tmpDir, 'project');
      await fs.mkdir(projectRoot, { recursive: true });

      // Create initial trust
      await writeTrustFile({
        projects: {
          '/existing/project': { trust_level: 'trusted' },
        },
      });

      const session = await createCodexSession(projectRoot, {});

      // Add new trust using proper TOML parsing
      const configContent = await fs.readFile(session.configPath, 'utf8');
      const TOML = await import('@iarna/toml');
      const config = TOML.parse(configContent) as Record<string, unknown>;

      if (!config.projects) {
        config.projects = {};
      }
      (config.projects as Record<string, unknown>)['/new/project'] = { trust_level: 'trusted' };

      await fs.writeFile(session.configPath, TOML.stringify(config as TOML.JsonMap), 'utf8');

      await cleanupCodexSession(session);

      // Verify both trusts exist
      const trustData = await readTrustFile();
      expect(trustData.projects['/existing/project']).toEqual({ trust_level: 'trusted' });
      expect(trustData.projects['/new/project']).toEqual({ trust_level: 'trusted' });
    });
  });

  describe('getProjectTrust', () => {
    it('returns undefined for unknown project', async () => {
      const trust = await getProjectTrust('/unknown/project');
      expect(trust).toBeUndefined();
    });

    it('returns trust level for known project', async () => {
      await writeTrustFile({
        projects: {
          '/known/project': { trust_level: 'trusted' },
        },
      });

      const trust = await getProjectTrust('/known/project');
      expect(trust).toBe('trusted');
    });
  });

  describe('setProjectTrust', () => {
    it('sets trust level for project', async () => {
      await setProjectTrust('/my/project', 'trusted');

      const trustData = await readTrustFile();
      expect(trustData.projects['/my/project']).toEqual({ trust_level: 'trusted' });
    });

    it('updates existing trust level', async () => {
      await setProjectTrust('/my/project', 'trusted');
      await setProjectTrust('/my/project', 'untrusted');

      const trustData = await readTrustFile();
      expect(trustData.projects['/my/project']).toEqual({ trust_level: 'untrusted' });
    });
  });
});
