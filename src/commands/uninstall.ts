import path from 'node:path';

import { LockfileManager } from '../core/lock-file.js';
import { SnippetCacheManager } from '../core/snippet-cache.js';
import { removeSymlinks } from '../integrations/symlink-manager.js';
import { injectPackageContext } from '../utils/context-file-injector.js';
import { exists, remove } from '../utils/fs.js';
import {
  readManifest,
  removeDependenciesFromManifest,
  removePackageFromProfiles,
} from '../utils/manifest.js';
import { collectPackageFilesFromAgentModules } from '../utils/package-collection.js';
import { agentModulesPath } from '../utils/path.js';
import { computeRemovalSet, listDependents } from '../utils/prune.js';

import type { CLIContext } from '../utils/context.js';
import type { Command } from 'commander';

/**
 * Validate package path and return it, or log error and exit
 */
function validatePackagePath(projectDir: string, pkg: string, ctx: CLIContext): string | null {
  try {
    return agentModulesPath(projectDir, pkg);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    ctx.logger.error(msg);
    process.exitCode = 1;
    return null;
  }
}

/**
 * Check if package has dependents that would prevent uninstall
 */
function checkDependents(
  lock: ReturnType<typeof LockfileManager.read>,
  pkg: string,
  ctx: CLIContext,
): boolean {
  if (!lock) return true;

  const targets = new Set<string>([pkg]);
  const dependents = listDependents(lock.packages, pkg).filter((name) => !targets.has(name));

  if (dependents.length > 0) {
    ctx.logger.error(
      `Cannot uninstall ${pkg}; it is still required by installed packages: ${dependents.join(', ')}`,
    );
    process.exitCode = 1;
    return false;
  }

  return true;
}

/**
 * Remove package and prune unused dependencies from lockfile
 */
async function removePackageAndPrune(
  projectDir: string,
  pkg: string,
  agentPath: string,
  dependencies: Set<string>,
  lock: ReturnType<typeof LockfileManager.read> | null,
): Promise<{
  linkExisted: boolean;
  lockUpdated: boolean;
  removedFromLock: string[];
}> {
  const linkExisted = exists(agentPath);
  await remove(agentPath);

  let lockUpdated = false;
  let removedFromLock: string[] = [];

  if (lock) {
    const targets = new Set<string>([pkg]);
    const removalSet = computeRemovalSet(lock.packages, targets, dependencies);

    if (removalSet.size > 0) {
      const removalList = [...removalSet];
      const hadEntries = removalList.some((name) =>
        Object.prototype.hasOwnProperty.call(lock.packages, name),
      );

      if (hadEntries) {
        removedFromLock = removalList;
        const updated = LockfileManager.remove(lock, removalList);
        LockfileManager.write(updated, projectDir);
        lockUpdated = true;

        // Remove pruned packages from agent_modules
        for (const name of removedFromLock) {
          try {
            const modPath = agentModulesPath(projectDir, name);
            if (exists(modPath)) {
              await remove(modPath);
            }
          } catch {
            // Ignore invalid package names from lockfile
          }
        }
      }
    }
  }

  return { linkExisted, lockUpdated, removedFromLock };
}

/**
 * Clean up symlinks and update context files for remaining packages
 */
async function cleanupSymlinksAndContext(
  projectDir: string,
  pkg: string,
  ctx: CLIContext,
): Promise<void> {
  // Remove symlinks for this package
  const symlinkResult = await removeSymlinks(projectDir, pkg);
  if (symlinkResult.removed.length > 0) {
    ctx.logger.info(`Removed ${symlinkResult.removed.length} symlink(s) from .claude/ directories`);
    if (ctx.logger.isVerbose()) {
      for (const link of symlinkResult.removed) {
        const relPath = path.relative(projectDir, link);
        ctx.logger.debug(`  ${relPath}`);
      }
    }
  }

  if (symlinkResult.errors.length > 0) {
    for (const err of symlinkResult.errors) {
      ctx.logger.warn(`Failed to remove symlink: ${err.path} - ${err.error}`);
    }
  }

  // Inject package context from remaining packages
  const { packageFiles, packageInfos } = await collectPackageFilesFromAgentModules(projectDir);

  const claudeMd = path.join(projectDir, 'CLAUDE.md');
  const agentsMd = path.join(projectDir, 'AGENTS.md');

  const claudeResult = await injectPackageContext(claudeMd, projectDir, packageFiles, packageInfos);
  if (claudeResult.modified) {
    ctx.logger.info('Injected package context into CLAUDE.md');
  }

  const agentsResult = await injectPackageContext(agentsMd, projectDir, packageFiles, packageInfos);
  if (agentsResult.modified) {
    ctx.logger.info('Injected package context into AGENTS.md');
  }
}

/**
 * Clear snippet cache entries for uninstalled packages
 */
async function clearSnippetCache(
  projectDir: string,
  packages: string[],
  ctx: CLIContext,
): Promise<void> {
  if (packages.length === 0) return;

  const cacheFilePath = path.join(projectDir, 'agents-cache.toml');
  const cacheManager = new SnippetCacheManager(cacheFilePath);
  await cacheManager.read();

  let clearedCount = 0;
  for (const pkg of packages) {
    await cacheManager.clearPackage(pkg);
    clearedCount++;
  }

  if (clearedCount > 0) {
    ctx.logger.info(`Cleared snippet cache for ${clearedCount} package(s)`);
    if (ctx.logger.isVerbose()) {
      for (const pkg of packages) {
        ctx.logger.debug(`  ${pkg}`);
      }
    }
  }
}

export function registerUninstallCommand(
  program: Command,
  createCtx: (opts: { verbose?: boolean }) => CLIContext,
): void {
  program
    .command('uninstall')
    .argument('<pkg>', 'Package to remove from agent_modules/')
    .description('Remove an installed package and update references')
    .action(async (pkg: string) => {
      const opts = program.opts<{ verbose?: boolean }>();
      const ctx = createCtx({ verbose: opts.verbose });
      const projectDir = process.cwd();

      // Validate package path
      const agentPath = validatePackagePath(projectDir, pkg, ctx);
      if (!agentPath) return;

      try {
        // Check dependencies and load lockfile
        const manifest = await readManifest(projectDir);
        const dependencies = new Set(Object.keys(manifest?.dependencies ?? {}));
        dependencies.delete(pkg);

        const lock = LockfileManager.read(projectDir);
        if (!checkDependents(lock, pkg, ctx)) return;

        // Update manifest files
        const manifestChanged = await removeDependenciesFromManifest(projectDir, [pkg]);
        const profilesChanged = await removePackageFromProfiles(projectDir, pkg);

        // Remove package and prune unused dependencies
        const { linkExisted, lockUpdated, removedFromLock } = await removePackageAndPrune(
          projectDir,
          pkg,
          agentPath,
          dependencies,
          lock,
        );

        // Report results
        if (linkExisted) {
          ctx.logger.info(`Removed agent_modules entry for ${pkg}`);
        }
        if (lockUpdated) {
          ctx.logger.info(
            `Updated agents-lock.toml (removed ${removedFromLock.sort().join(', ')})`,
          );
        }
        if (manifestChanged || profilesChanged) {
          ctx.logger.info('Updated agents.toml');
        }

        if (!linkExisted && removedFromLock.length === 0 && !manifestChanged) {
          ctx.logger.info(`${pkg} was not installed; nothing to do.`);
        } else {
          ctx.logger.info('Uninstall complete');
          await cleanupSymlinksAndContext(projectDir, pkg, ctx);

          // Clear snippet cache for uninstalled packages
          const packagesToClean = [pkg, ...removedFromLock];
          await clearSnippetCache(projectDir, packagesToClean, ctx);
        }
      } catch (error) {
        ctx.logger.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      }
    });
}
