import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LockfileManager } from '../../../src/core/lock-file.js';
import { PackageManager } from '../../../src/core/package-manager.js';

import type { LockfileData } from '../../../src/core/lock-file.js';
import type { RegistryClient } from '../../../src/core/registry-client.js';
import type { StorageManager } from '../../../src/core/storage.js';
import type { ProjectConfigData } from '../../../src/utils/config.js';
import type { CLIContext } from '../../../src/utils/context.js';
import type { Logger } from '../../../src/utils/logger.js';

function createMockLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    isVerbose: vi.fn(() => false),
    setVerbose: vi.fn(),
    child: vi.fn(() => createMockLogger()),
    newline: vi.fn(),
    group: vi.fn(),
    groupEnd: vi.fn(),
  } as unknown as Logger;
}

function createMockRegistry(
  overrides: Partial<RegistryClient> = {},
  pkgVersions: Record<string, { version: string; yanked?: boolean }[]> = {},
): RegistryClient {
  return {
    getPackageInfo: vi.fn(),
    getPackageVersions: vi.fn().mockImplementation((name: string) => {
      const versions = pkgVersions[name] || [];
      const versionsMap: Record<
        string,
        {
          version: string;
          dependencies: Record<string, string>;
          compatibility: Record<string, string>;
          publishedAt: string;
          yanked: boolean;
        }
      > = {};
      for (const v of versions) {
        versionsMap[v.version] = {
          version: v.version,
          dependencies: {},
          compatibility: {},
          publishedAt: new Date().toISOString(),
          yanked: v.yanked ?? false,
        };
      }
      return Promise.resolve({ versions: versionsMap });
    }),
    getTarballInfo: vi.fn().mockResolvedValue({
      url: 'https://cdn.example.com/pkg.tgz?token=fresh-signed-token',
    }),
    downloadTarball: vi.fn().mockResolvedValue(Buffer.from('mock-tarball')),
    ...overrides,
  } as unknown as RegistryClient;
}

function createMockStorage(overrides: Partial<StorageManager> = {}): StorageManager {
  return {
    getPackagePath: vi.fn((name: string, version: string) => `/mock/store/${name}/${version}`),
    store: vi.fn(),
    extractTarball: vi.fn(),
    ...overrides,
  } as unknown as StorageManager;
}

function createMockContext(
  overrides: {
    registry?: Partial<RegistryClient>;
    storage?: Partial<StorageManager>;
    logger?: Logger;
    pkgVersions?: Record<string, { version: string; yanked?: boolean }[]>;
  } = {},
): CLIContext {
  return {
    logger: overrides.logger ?? createMockLogger(),
    registry: createMockRegistry(overrides.registry, overrides.pkgVersions),
    storage: createMockStorage(overrides.storage),
    config: {
      load: vi.fn(),
      save: vi.fn(),
      update: vi.fn(),
      path: vi.fn(() => '/mock/config.json'),
      getToken: vi.fn(),
    },
    resolver: { resolve: vi.fn() },
    telemetry: {
      track: vi.fn(),
      flush: vi.fn(),
    },
  } as unknown as CLIContext;
}

function createProjectConfig(dependencies: Record<string, string>): ProjectConfigData {
  return {
    manifest: {
      package: {
        name: '@test/project',
        version: '0.1.0',
      },
      dependencies,
    },
    dependencies,
  };
}

describe('core/package-manager', () => {
  let tmpDir: string;
  let projectDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tz-pm-test-'));
    projectDir = path.join(tmpDir, 'project');
    await fs.mkdir(projectDir, { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('installFromConfig - URL refresh when integrity missing', () => {
    it('fetches fresh URL when lockfile has stripped URL but missing integrity', async () => {
      // Setup: Create a lockfile with a stripped URL (no query params) but missing integrity
      const strippedUrl = 'https://cdn.example.com/packages/@test/pkg/1.0.0.tgz';
      const freshUrl = 'https://cdn.example.com/packages/@test/pkg/1.0.0.tgz?token=signed';
      const pkgName = '@test/pkg';
      const pkgVersion = '1.0.0';

      const lockfile: LockfileData = {
        version: 1,
        packages: {
          [pkgName]: {
            version: pkgVersion,
            resolved: strippedUrl, // Stripped URL from previous PR#84
            integrity: '', // Missing integrity - this is the bug scenario
            dependencies: {},
            yanked: false,
          },
        },
        metadata: {
          generatedAt: new Date().toISOString(),
          cliVersion: '0.1.0',
        },
      };

      // Write lockfile to project
      LockfileManager.write(lockfile, projectDir);

      // Mock registry to return fresh signed URL
      const getTarballInfoMock = vi.fn().mockResolvedValue({ url: freshUrl });
      const downloadTarballMock = vi.fn().mockResolvedValue(Buffer.from('mock-tarball-content'));

      // Mock storage to simulate package not in cache (needs download)
      const getPackagePathMock = vi
        .fn()
        .mockReturnValue(path.join(tmpDir, 'store', pkgName, pkgVersion));

      const ctx = createMockContext({
        registry: {
          getTarballInfo: getTarballInfoMock,
          downloadTarball: downloadTarballMock,
        },
        storage: {
          getPackagePath: getPackagePathMock,
          store: vi.fn(),
          extractTarball: vi.fn(),
        },
        pkgVersions: {
          [pkgName]: [{ version: pkgVersion }],
        },
      });

      const pm = new PackageManager(ctx);

      // Project config requesting the package
      const projectConfig = createProjectConfig({
        [pkgName]: '^1.0.0',
      });

      // Execute install
      await pm.installFromConfig(projectDir, projectConfig);

      // Verify: getTarballInfo should be called to get fresh URL
      // because integrity was missing even though resolved URL existed
      expect(getTarballInfoMock).toHaveBeenCalledWith(pkgName, pkgVersion);

      // Verify: downloadTarball should use the fresh URL, not the stripped one
      expect(downloadTarballMock).toHaveBeenCalledWith(freshUrl);
    });

    it('does not refetch URL when lockfile has both URL and integrity', async () => {
      const existingUrl = 'https://cdn.example.com/packages/@test/pkg/1.0.0.tgz';
      const pkgName = '@test/pkg';
      const pkgVersion = '1.0.0';
      const tarballContent = Buffer.from('mock-tarball-content');
      const integrity = LockfileManager.createIntegrityHash(tarballContent);

      const lockfile: LockfileData = {
        version: 1,
        packages: {
          [pkgName]: {
            version: pkgVersion,
            resolved: existingUrl,
            integrity, // Has integrity - no need to refetch
            dependencies: {},
            yanked: false,
          },
        },
        metadata: {
          generatedAt: new Date().toISOString(),
          cliVersion: '0.1.0',
        },
      };

      // Write lockfile to project
      LockfileManager.write(lockfile, projectDir);

      // Create the store path to simulate already extracted package
      const storePath = path.join(tmpDir, 'store', pkgName, pkgVersion);
      await fs.mkdir(storePath, { recursive: true });

      const getTarballInfoMock = vi.fn();
      const downloadTarballMock = vi.fn();

      const ctx = createMockContext({
        registry: {
          getTarballInfo: getTarballInfoMock,
          downloadTarball: downloadTarballMock,
        },
        storage: {
          getPackagePath: vi.fn().mockReturnValue(storePath),
          store: vi.fn(),
          extractTarball: vi.fn(),
        },
        pkgVersions: {
          [pkgName]: [{ version: pkgVersion }],
        },
      });

      const pm = new PackageManager(ctx);

      const projectConfig = createProjectConfig({
        [pkgName]: '^1.0.0',
      });

      await pm.installFromConfig(projectDir, projectConfig);

      // Neither getTarballInfo nor downloadTarball should be called
      // because package is already cached with valid integrity
      expect(getTarballInfoMock).not.toHaveBeenCalled();
      expect(downloadTarballMock).not.toHaveBeenCalled();
    });

    it('fetches fresh URL when lockfile has no resolved URL', async () => {
      const freshUrl = 'https://cdn.example.com/packages/@test/pkg/1.0.0.tgz?token=signed';
      const pkgName = '@test/pkg';
      const pkgVersion = '1.0.0';

      const lockfile: LockfileData = {
        version: 1,
        packages: {
          [pkgName]: {
            version: pkgVersion,
            resolved: '', // Empty URL
            integrity: '', // Missing integrity
            dependencies: {},
            yanked: false,
          },
        },
        metadata: {
          generatedAt: new Date().toISOString(),
          cliVersion: '0.1.0',
        },
      };

      LockfileManager.write(lockfile, projectDir);

      const getTarballInfoMock = vi.fn().mockResolvedValue({ url: freshUrl });
      const downloadTarballMock = vi.fn().mockResolvedValue(Buffer.from('mock-tarball'));

      const ctx = createMockContext({
        registry: {
          getTarballInfo: getTarballInfoMock,
          downloadTarball: downloadTarballMock,
        },
        storage: {
          getPackagePath: vi.fn().mockReturnValue(path.join(tmpDir, 'store', pkgName, pkgVersion)),
          store: vi.fn(),
          extractTarball: vi.fn(),
        },
        pkgVersions: {
          [pkgName]: [{ version: pkgVersion }],
        },
      });

      const pm = new PackageManager(ctx);

      const projectConfig = createProjectConfig({
        [pkgName]: '^1.0.0',
      });

      await pm.installFromConfig(projectDir, projectConfig);

      expect(getTarballInfoMock).toHaveBeenCalledWith(pkgName, pkgVersion);
      expect(downloadTarballMock).toHaveBeenCalledWith(freshUrl);
    });
  });
});
