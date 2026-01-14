import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { type LockfileData } from '../../../src/core/lock-file.js';
import { StorageManager } from '../../../src/core/storage.js';
import {
  discoverInstalledPackages,
  filterPackagesByOptions,
  setupRenderConfiguration,
} from '../../../src/core/template-renderer.js';

async function mkdtemp(prefix: string): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
}

async function write(file: string, data: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, data, 'utf8');
}

function createLockfile(): LockfileData {
  return {
    version: 1,
    packages: {},
    metadata: {
      generatedAt: new Date().toISOString(),
      cliVersion: '0.14.0',
    },
  };
}

describe('template-renderer helpers', () => {
  describe('discoverInstalledPackages', () => {
    let tmpRoot: string;
    let agentModules: string;
    let fakeHome: string;
    let originalHome: string | undefined;
    let originalUserProfile: string | undefined;

    beforeEach(async () => {
      // Setup fake home for storage manager
      originalHome = process.env.HOME;
      originalUserProfile = process.env.USERPROFILE;
      fakeHome = await mkdtemp('tz-helpers-home');
      process.env.HOME = fakeHome;
      process.env.USERPROFILE = fakeHome;

      tmpRoot = await mkdtemp('tz-helpers-test');
      agentModules = path.join(tmpRoot, 'agent_modules');
      await fs.mkdir(agentModules, { recursive: true });
    });

    afterEach(async () => {
      process.env.HOME = originalHome;
      process.env.USERPROFILE = originalUserProfile;
      await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
      await fs.rm(fakeHome, { recursive: true, force: true }).catch(() => {});
    });

    it('should discover non-scoped packages', async () => {
      // Setup
      const pkgDir = path.join(agentModules, 'simple-pkg');
      await fs.mkdir(pkgDir, { recursive: true });

      const lockfile = createLockfile();
      lockfile.packages['simple-pkg'] = {
        version: '1.0.0',
        resolved: 'http://test/simple-pkg',
        integrity: 'sha256-test',
        dependencies: {},
      };

      const storage = new StorageManager({ storeDir: path.join(fakeHome, '.terrazul', 'store') });
      const storePath = storage.getPackagePath('simple-pkg', '1.0.0');
      await fs.mkdir(storePath, { recursive: true });

      // Execute
      const result = await discoverInstalledPackages(agentModules, lockfile, storage, {});

      // Verify
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        name: 'simple-pkg',
        root: pkgDir,
        storePath,
      });
    });

    it('should discover scoped packages', async () => {
      // Setup
      const scopeDir = path.join(agentModules, '@test');
      const pkgDir = path.join(scopeDir, 'scoped-pkg');
      await fs.mkdir(pkgDir, { recursive: true });

      const lockfile = createLockfile();
      lockfile.packages['@test/scoped-pkg'] = {
        version: '2.0.0',
        resolved: 'http://test/scoped-pkg',
        integrity: 'sha256-test2',
        dependencies: {},
      };

      const storage = new StorageManager({ storeDir: path.join(fakeHome, '.terrazul', 'store') });
      const storePath = storage.getPackagePath('@test/scoped-pkg', '2.0.0');
      await fs.mkdir(storePath, { recursive: true });

      // Execute
      const result = await discoverInstalledPackages(agentModules, lockfile, storage, {});

      // Verify
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        name: '@test/scoped-pkg',
        root: pkgDir,
        storePath,
      });
    });

    it('should discover multiple packages and sort alphabetically', async () => {
      // Setup packages
      const packages = [
        { name: 'zebra', version: '1.0.0' },
        { name: '@scope/apple', version: '1.0.0' },
        { name: 'banana', version: '1.0.0' },
      ];

      const lockfile = createLockfile();
      const storage = new StorageManager({ storeDir: path.join(fakeHome, '.terrazul', 'store') });

      for (const pkg of packages) {
        const pkgDir = pkg.name.includes('/')
          ? path.join(agentModules, ...pkg.name.split('/'))
          : path.join(agentModules, pkg.name);
        await fs.mkdir(pkgDir, { recursive: true });

        lockfile.packages[pkg.name] = {
          version: pkg.version,
          resolved: `http://test/${pkg.name}`,
          integrity: 'sha256-test',
          dependencies: {},
        };

        const storePath = storage.getPackagePath(pkg.name, pkg.version);
        await fs.mkdir(storePath, { recursive: true });
      }

      // Execute
      const result = await discoverInstalledPackages(agentModules, lockfile, storage, {});

      // Verify sorted order
      expect(result.map((p) => p.name)).toEqual(['@scope/apple', 'banana', 'zebra']);
    });

    it('should skip packages not in lockfile', async () => {
      // Setup: directory exists but not in lockfile
      const pkgDir = path.join(agentModules, 'orphan-pkg');
      await fs.mkdir(pkgDir, { recursive: true });

      const lockfile = createLockfile();
      const storage = new StorageManager({ storeDir: path.join(fakeHome, '.terrazul', 'store') });

      // Execute
      const result = await discoverInstalledPackages(agentModules, lockfile, storage, {});

      // Verify: orphan package not discovered
      expect(result).toHaveLength(0);
    });

    it('should use local package path when provided', async () => {
      // Setup
      const pkgDir = path.join(agentModules, '@test', 'local-pkg');
      await fs.mkdir(pkgDir, { recursive: true });

      const localPath = path.join(tmpRoot, 'local-source');
      await fs.mkdir(localPath, { recursive: true });

      const lockfile = createLockfile();
      lockfile.packages['@test/local-pkg'] = {
        version: '1.0.0',
        resolved: 'http://test/local-pkg',
        integrity: 'sha256-test',
        dependencies: {},
      };

      const storage = new StorageManager({ storeDir: path.join(fakeHome, '.terrazul', 'store') });
      const localPackagePaths = new Map([['@test/local-pkg', localPath]]);

      // Execute
      const result = await discoverInstalledPackages(agentModules, lockfile, storage, {
        localPackagePaths,
      });

      // Verify: uses local path instead of store path
      expect(result).toHaveLength(1);
      expect(result[0].storePath).toBe(localPath);
    });

    it('should handle empty agent_modules directory', async () => {
      // Execute
      const lockfile = createLockfile();
      const storage = new StorageManager({ storeDir: path.join(fakeHome, '.terrazul', 'store') });
      const result = await discoverInstalledPackages(agentModules, lockfile, storage, {});

      // Verify
      expect(result).toHaveLength(0);
    });

    it('should skip non-directory entries', async () => {
      // Setup: create a file instead of directory
      const filePath = path.join(agentModules, 'not-a-package.txt');
      await write(filePath, 'just a file');

      const lockfile = createLockfile();
      const storage = new StorageManager({ storeDir: path.join(fakeHome, '.terrazul', 'store') });

      // Execute
      const result = await discoverInstalledPackages(agentModules, lockfile, storage, {});

      // Verify: file is skipped
      expect(result).toHaveLength(0);
    });
  });

  describe('filterPackagesByOptions', () => {
    const mockPackages = [
      { name: '@terrazul/base', root: '/root/@terrazul/base', storePath: '/store/base' },
      {
        name: '@terrazul/extended',
        root: '/root/@terrazul/extended',
        storePath: '/store/extended',
      },
      { name: 'simple-pkg', root: '/root/simple-pkg', storePath: '/store/simple' },
    ];

    it('should return all packages when no filter specified', () => {
      const result = filterPackagesByOptions(mockPackages, undefined, {});
      expect(result).toEqual(mockPackages);
    });

    it('should filter by package name', () => {
      const result = filterPackagesByOptions(mockPackages, undefined, {
        packageName: '@terrazul/base',
      });

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('@terrazul/base');
    });

    it('should return empty array when package name not found', () => {
      const result = filterPackagesByOptions(mockPackages, undefined, {
        packageName: 'nonexistent',
      });

      expect(result).toHaveLength(0);
    });

    it('should filter by profile', () => {
      const manifest = {
        package: { name: 'test-project', version: '1.0.0' },
        profiles: {
          focus: ['@terrazul/base', 'simple-pkg'],
        },
      };

      const result = filterPackagesByOptions(mockPackages, manifest, {
        profileName: 'focus',
      });

      expect(result).toHaveLength(2);
      expect(result.map((p) => p.name)).toEqual(['@terrazul/base', 'simple-pkg']);
    });

    it('should throw error when profile not found in manifest', () => {
      const manifest = {
        package: { name: 'test-project', version: '1.0.0' },
        profiles: {},
      };

      expect(() =>
        filterPackagesByOptions(mockPackages, manifest, { profileName: 'nonexistent' }),
      ).toThrow(/Profile 'nonexistent' is not defined/);
    });

    it('should throw error when using profile without manifest', () => {
      expect(() =>
        filterPackagesByOptions(mockPackages, undefined, { profileName: 'focus' }),
      ).toThrow(/agents\.toml is required when using --profile/);
    });

    it('should throw error when profile references non-installed packages', () => {
      const manifest = {
        package: { name: 'test-project', version: '1.0.0' },
        profiles: {
          broken: ['@terrazul/base', 'not-installed-pkg'],
        },
      };

      expect(() =>
        filterPackagesByOptions(mockPackages, manifest, { profileName: 'broken' }),
      ).toThrow(/references packages that are not installed: not-installed-pkg/);
    });

    it('should prefer packageName over profileName when both specified', () => {
      const manifest = {
        package: { name: 'test-project', version: '1.0.0' },
        profiles: {
          focus: ['@terrazul/base', 'simple-pkg'],
        },
      };

      // packageName takes precedence
      const result = filterPackagesByOptions(mockPackages, manifest, {
        packageName: '@terrazul/extended',
        profileName: 'focus',
      });

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('@terrazul/extended');
    });
  });

  describe('setupRenderConfiguration', () => {
    let tmpRoot: string;
    let fakeHome: string;
    let originalHome: string | undefined;
    let originalUserProfile: string | undefined;

    beforeEach(async () => {
      originalHome = process.env.HOME;
      originalUserProfile = process.env.USERPROFILE;
      fakeHome = await mkdtemp('tz-config-home');
      process.env.HOME = fakeHome;
      process.env.USERPROFILE = fakeHome;
      // Mock os.homedir() to ensure test isolation
      vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);

      tmpRoot = await mkdtemp('tz-config-test');
    });

    afterEach(async () => {
      process.env.HOME = originalHome;
      process.env.USERPROFILE = originalUserProfile;
      vi.restoreAllMocks();
      await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
      await fs.rm(fakeHome, { recursive: true, force: true }).catch(() => {});
    });

    it('should return default configuration', async () => {
      const result = await setupRenderConfiguration(tmpRoot, {});

      expect(result.primaryTool.type).toBe('claude');
      expect(result.toolSafeMode).toBe(true);
      expect(result.filesMap).toEqual({
        claude: 'CLAUDE.md',
        codex: 'AGENTS.md',
        cursor: '.cursor/rules.mdc',
        copilot: '.github/copilot-instructions.md',
      });
      expect(result.profileTools).toBeInstanceOf(Array);
    });

    it('should use tool from options', async () => {
      const result = await setupRenderConfiguration(tmpRoot, { tool: 'codex' });

      expect(result.primaryTool.type).toBe('codex');
    });

    it('should use toolSafeMode from options', async () => {
      const result = await setupRenderConfiguration(tmpRoot, { toolSafeMode: false });

      expect(result.toolSafeMode).toBe(false);
    });

    it.skip('should use custom file paths from config', async () => {
      // Create custom config
      const configDir = path.join(fakeHome, '.terrazul');
      const configPath = path.join(configDir, 'config.json');
      await fs.mkdir(configDir, { recursive: true });
      await write(
        configPath,
        JSON.stringify({
          registry: 'https://test.api.terrazul.com',
          context: {
            files: {
              claude: 'CUSTOM_CLAUDE.md',
              codex: 'CUSTOM_AGENTS.md',
            },
          },
        }),
      );

      // Ensure file is written
      const fd = await fs.open(configPath, 'r');
      await fd.sync();
      await fd.close();

      const result = await setupRenderConfiguration(tmpRoot, {});

      expect(result.filesMap.claude).toBe('CUSTOM_CLAUDE.md');
      expect(result.filesMap.codex).toBe('CUSTOM_AGENTS.md');
      // Other tools should still have defaults
      expect(result.filesMap.cursor).toBe('.cursor/rules.mdc');
    });
  });
});
