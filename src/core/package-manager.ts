import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { satisfies } from 'semver';

import { DependencyResolver, type ResolvedDependencies } from './dependency-resolver.js';
import { ErrorCode, TerrazulError } from './errors.js';
import { LockfileManager, type LockfileData, type LockfilePackage } from './lock-file.js';
import { SnippetCacheManager } from './snippet-cache.js';
import { agentModulesPath } from '../utils/path.js';
import { stripQueryParams } from '../utils/url.js';

import type { ProjectConfigData } from '../utils/config.js';
import type { CLIContext } from '../utils/context.js';

export interface InstallOptions {
  offline?: boolean;
  frozenLockfile?: boolean;
  force?: boolean;
}

export type InstallSource = 'remote' | 'cache' | 'offline';

export interface InstallSummaryEntry {
  name: string;
  version: string;
  source: InstallSource;
}

export interface InstallResult {
  lockfile: LockfileData;
  summary: InstallSummaryEntry[];
  resolvedPackages: Map<string, { version: string }>;
  warnings: string[];
}

async function pathExists(target: string): Promise<boolean> {
  try {
    const st = await fs.stat(target);
    return st.isDirectory();
  } catch {
    return false;
  }
}

async function writeTempTarball(buffer: Buffer): Promise<string> {
  const tmpFile = path.join(
    os.tmpdir(),
    `tz-install-${Date.now()}-${Math.random().toString(16).slice(2)}.tgz`,
  );
  await fs.writeFile(tmpFile, buffer);
  return tmpFile;
}

function safeAgentModulesPath(projectDir: string, pkgName: string): string {
  try {
    return agentModulesPath(projectDir, pkgName);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new TerrazulError(ErrorCode.SECURITY_VIOLATION, msg);
  }
}

function resolvedFromLock(
  lock: LockfileData,
  rootDeps: Record<string, string>,
): ResolvedDependencies {
  const resolved: ResolvedDependencies = new Map();
  const queue = [...Object.entries(rootDeps)];
  while (queue.length > 0) {
    const [name, range] = queue.shift()!;
    if (resolved.has(name)) continue;
    const entry = lock.packages[name];
    if (!entry) {
      throw new TerrazulError(
        ErrorCode.CONFIG_INVALID,
        `Lockfile is missing required package '${name}' for offline install`,
      );
    }
    if (range && range.trim().length > 0 && !satisfies(entry.version, range)) {
      throw new TerrazulError(
        ErrorCode.VERSION_CONFLICT,
        `Lockfile pins ${name}@${entry.version} which does not satisfy ${range}`,
      );
    }
    resolved.set(name, {
      version: entry.version,
      dependencies: entry.dependencies ?? {},
    });
    const deps = entry.dependencies ?? {};
    for (const dep of Object.entries(deps)) {
      queue.push(dep);
    }
  }
  return resolved;
}

export class PackageManager {
  constructor(private readonly ctx: CLIContext) {}

  async installFromConfig(
    projectDir: string,
    project: ProjectConfigData,
    options: InstallOptions = {},
  ): Promise<InstallResult> {
    const dependencies = project.dependencies;
    const rootNames = Object.keys(dependencies);
    const existingLock = LockfileManager.read(projectDir);

    let resolved: ResolvedDependencies;
    let warnings: string[] = [];

    if (rootNames.length === 0) {
      resolved = new Map();
    } else if (options.offline) {
      if (!existingLock) {
        throw new TerrazulError(
          ErrorCode.CONFIG_INVALID,
          '--offline requires an existing agents-lock.toml',
        );
      }
      resolved = resolvedFromLock(existingLock, dependencies);
    } else {
      const resolver = new DependencyResolver(this.ctx.registry, {
        lockfile: existingLock,
        logger: this.ctx.logger,
      });
      const out = await resolver.resolve(dependencies);
      resolved = out.resolved;
      warnings = out.warnings;
    }

    if (options.frozenLockfile) {
      if (!existingLock) {
        throw new TerrazulError(
          ErrorCode.CONFIG_INVALID,
          '--frozen-lockfile requires an existing agents-lock.toml',
        );
      }
      const mismatches: string[] = [];
      for (const [name, info] of resolved) {
        const entry = existingLock.packages[name];
        if (!entry || entry.version !== info.version) {
          mismatches.push(`${name}@${info.version}`);
        }
      }
      const extras = Object.keys(existingLock.packages ?? {}).filter((name) => !resolved.has(name));
      for (const name of extras) {
        const version = existingLock.packages[name]?.version ?? 'unknown';
        mismatches.push(`${name}@${version}`);
      }
      if (mismatches.length > 0) {
        throw new TerrazulError(
          ErrorCode.CONFIG_INVALID,
          `Frozen lockfile mismatch for ${mismatches.join(', ')}`,
        );
      }
    }

    const updates: Record<string, LockfilePackage> = {};
    const summary: InstallSummaryEntry[] = [];
    const resolvedVersions = new Map<string, { version: string }>();

    for (const [name, info] of resolved) {
      resolvedVersions.set(name, { version: info.version });
      const lockEntry = existingLock?.packages[name];
      const storePath = this.ctx.storage.getPackagePath(name, info.version);
      const linkPath = safeAgentModulesPath(projectDir, name);
      let source: InstallSource = options.offline ? 'offline' : 'remote';

      const hasExtracted = await pathExists(storePath);
      let tarballBuffer: Buffer | null = null;
      let resolvedUrl = lockEntry?.resolved ?? '';
      let integrity = lockEntry?.integrity ?? '';
      const needsDownload =
        !options.offline &&
        (options.force || !lockEntry || lockEntry.version !== info.version || !hasExtracted);

      if (options.offline) {
        if (!lockEntry) {
          throw new TerrazulError(
            ErrorCode.CONFIG_INVALID,
            `Offline install requires ${name}@${info.version} in agents-lock.toml`,
          );
        }
        if (!hasExtracted) {
          throw new TerrazulError(
            ErrorCode.STORAGE_ERROR,
            `${name}@${info.version} not present in local store for offline install`,
          );
        }
        source = 'offline';
        if (!integrity || !resolvedUrl) {
          throw new TerrazulError(
            ErrorCode.CONFIG_INVALID,
            `agents-lock.toml entry for ${name} is missing resolved URL or integrity`,
          );
        }
      } else if (needsDownload) {
        const tarInfo = await this.ctx.registry.getTarballInfo(name, info.version);
        resolvedUrl = tarInfo.url;
        tarballBuffer = await this.ctx.registry.downloadTarball(tarInfo.url);
        this.ctx.storage.store(tarballBuffer);
        const tmp = await writeTempTarball(tarballBuffer);
        try {
          await this.ctx.storage.extractTarball(tmp, name, info.version);
        } finally {
          await fs.rm(tmp, { force: true }).catch(() => {});
        }
        integrity = LockfileManager.createIntegrityHash(tarballBuffer);
        source = 'remote';
      } else {
        source = 'cache';
      }

      if (!options.offline) {
        // Fetch fresh URL when missing OR when integrity is missing (stripped URLs in lockfile
        // won't work for signed CDN downloads without integrity verification)
        if (!resolvedUrl || !integrity) {
          const tarInfo = await this.ctx.registry.getTarballInfo(name, info.version);
          resolvedUrl = tarInfo.url;
        }
        if (!integrity) {
          const tarball = tarballBuffer ?? (await this.ctx.registry.downloadTarball(resolvedUrl));
          if (!tarballBuffer) {
            this.ctx.storage.store(tarball);
            const tmp = await writeTempTarball(tarball);
            try {
              await this.ctx.storage.extractTarball(tmp, name, info.version);
            } finally {
              await fs.rm(tmp, { force: true }).catch(() => {});
            }
          }
          integrity = LockfileManager.createIntegrityHash(tarball);
          source = 'remote';
        }
      }

      // Create real directory in agent_modules
      // The package directory will contain rendered files
      // Templates are read from the store
      await fs.mkdir(linkPath, { recursive: true });

      updates[name] = {
        version: info.version,
        resolved: stripQueryParams(resolvedUrl),
        integrity,
        dependencies: info.dependencies,
        yanked: false,
      };
      summary.push({ name, version: info.version, source });
    }

    const merged = LockfileManager.merge(existingLock, updates);
    const prunedPackages: Record<string, LockfilePackage> = {};
    for (const [name] of resolved) {
      const entry = merged.packages[name];
      if (entry) {
        prunedPackages[name] = entry;
      }
    }

    const lockfile: LockfileData = {
      ...merged,
      packages: prunedPackages,
    };

    // Invalidate snippet cache for packages with version changes
    const cacheFilePath = path.join(projectDir, 'agents-cache.toml');
    const cacheManager = new SnippetCacheManager(cacheFilePath);
    await cacheManager.read();

    for (const [name, info] of resolved) {
      const oldVersion = existingLock?.packages[name]?.version;
      if (oldVersion && oldVersion !== info.version) {
        // Version changed - clear cache for this package
        await cacheManager.clearPackage(name);
        this.ctx.logger.debug(
          `Cleared snippet cache for ${name} (${oldVersion} -> ${info.version})`,
        );
      }
    }

    summary.sort((a, b) => a.name.localeCompare(b.name));

    return { lockfile, summary, warnings, resolvedPackages: resolvedVersions };
  }

  /**
   * Install a single package version - used by add, update, and run commands
   * Downloads, caches, extracts to store, and creates agent_modules directory
   */
  async installSinglePackage(
    projectDir: string,
    name: string,
    version: string,
    options: { force?: boolean } = {},
  ): Promise<{
    storePath: string;
    linkPath: string;
    integrity: string;
    tarballBuffer: Buffer;
  }> {
    const storePath = this.ctx.storage.getPackagePath(name, version);
    const linkPath = safeAgentModulesPath(projectDir, name);
    const hasExtracted = await pathExists(storePath);

    let tarballBuffer: Buffer;

    // Download and extract if needed
    if (options.force || !hasExtracted) {
      const tarInfo = await this.ctx.registry.getTarballInfo(name, version);
      tarballBuffer = await this.ctx.registry.downloadTarball(tarInfo.url);
      this.ctx.storage.store(tarballBuffer);

      const tmpFile = await writeTempTarball(tarballBuffer);
      try {
        await this.ctx.storage.extractTarball(tmpFile, name, version);
      } finally {
        await fs.rm(tmpFile, { force: true }).catch(() => {});
      }
    } else {
      // Already extracted, download tarball only for integrity hash
      const tarInfo = await this.ctx.registry.getTarballInfo(name, version);
      tarballBuffer = await this.ctx.registry.downloadTarball(tarInfo.url);
    }

    // Create real directory in agent_modules
    // The package directory will contain rendered files
    // Templates are read from the store
    await fs.mkdir(path.dirname(linkPath), { recursive: true });
    await fs.mkdir(linkPath, { recursive: true });

    const integrity = LockfileManager.createIntegrityHash(tarballBuffer);

    return { storePath, linkPath, integrity, tarballBuffer };
  }
}
