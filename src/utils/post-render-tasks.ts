/**
 * Post-rendering tasks: context injection and symlink creation
 * Shared by add, update, and apply commands
 */

import path from 'node:path';

import { injectPackageContext, type PackageInfo } from './context-file-injector.js';
import { readManifest } from './manifest.js';
import { agentModulesPath } from './path.js';
import { createSymlinks, type RenderedFile } from '../integrations/symlink-manager.js';

import type { Logger } from './logger.js';

/**
 * Build package info list from rendered package files
 */
async function buildPackageInfoList(
  projectRoot: string,
  packageFiles: Map<string, string[]>,
): Promise<PackageInfo[]> {
  const packageInfos: PackageInfo[] = [];

  for (const [pkgName, files] of packageFiles) {
    if (files.length === 0) continue;

    const pkgRoot = agentModulesPath(projectRoot, pkgName);
    const manifest = await readManifest(pkgRoot);

    packageInfos.push({
      name: pkgName,
      version: manifest?.package?.version,
      root: pkgRoot,
    });
  }

  return packageInfos;
}

/**
 * Inject package context into CLAUDE.md and AGENTS.md
 */
async function injectContext(
  projectRoot: string,
  packageFiles: Map<string, string[]>,
  packageInfos: PackageInfo[],
  logger: Logger,
): Promise<void> {
  const claudeMd = path.join(projectRoot, 'CLAUDE.md');
  const agentsMd = path.join(projectRoot, 'AGENTS.md');

  const claudeResult = await injectPackageContext(
    claudeMd,
    projectRoot,
    packageFiles,
    packageInfos,
  );
  if (claudeResult.modified) {
    logger.info('Injected package context into CLAUDE.md');
  }

  const agentsResult = await injectPackageContext(
    agentsMd,
    projectRoot,
    packageFiles,
    packageInfos,
  );
  if (agentsResult.modified) {
    logger.info('Injected package context into AGENTS.md');
  }
}

/**
 * Create symlinks for operational files (agents/, commands/, skills/)
 */
async function createPackageSymlinks(
  projectRoot: string,
  packageInfos: PackageInfo[],
  renderedFiles: RenderedFile[],
  logger: Logger,
): Promise<void> {
  if (packageInfos.length === 0) return;

  const symlinkResult = await createSymlinks({
    projectRoot,
    packages: packageInfos.map((p) => p.name),
    renderedFiles,
  });

  if (symlinkResult.created.length > 0) {
    logger.info(`Created ${symlinkResult.created.length} symlink(s) in .claude/ directories`);
  }

  if (symlinkResult.errors.length > 0) {
    for (const { path: p, error } of symlinkResult.errors) {
      logger.warn(`Symlink error for ${p}: ${error}`);
    }
  }
}

/**
 * Execute all post-rendering tasks: context injection and symlink creation
 *
 * @param projectRoot - Project root directory
 * @param packageFiles - Map of package names to their rendered files
 * @param logger - Logger instance
 * @param renderedFiles - Rendered file metadata (for symlink creation)
 * @param packageInfos - Optional pre-built package info list (for update command)
 */
export async function executePostRenderTasks(
  projectRoot: string,
  packageFiles: Map<string, string[]>,
  logger: Logger,
  renderedFiles: RenderedFile[] = [],
  packageInfos?: PackageInfo[],
): Promise<void> {
  if (packageFiles.size === 0) return;

  // Build package info list if not provided
  const pkgInfos = packageInfos ?? (await buildPackageInfoList(projectRoot, packageFiles));

  // Inject @-mentions into CLAUDE.md and AGENTS.md
  await injectContext(projectRoot, packageFiles, pkgInfos, logger);

  // Create symlinks for operational files
  await createPackageSymlinks(projectRoot, pkgInfos, renderedFiles, logger);
}
