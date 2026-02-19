import { ErrorCode, TerrazulError } from '../core/errors.js';
import { LockfileManager } from '../core/lock-file.js';
import { planAndRender } from '../core/template-renderer.js';
import { addPackageToProfile } from '../utils/manifest.js';
import { stripQueryParams } from '../utils/url.js';

import type { DependencyResolver } from '../core/dependency-resolver.js';
import type { PackageManager } from '../core/package-manager.js';
import type { SnippetProgress, RenderedFileMetadata } from '../core/template-renderer.js';
import type { CLIContext } from '../utils/context.js';
import type { Logger } from '../utils/logger.js';
import type { ParsedPackageSpec } from '../utils/package-spec.js';

/**
 * Validate that a package version is not yanked.
 * Throws TerrazulError if the exact version is yanked.
 */
export async function validatePackageVersion(
  ctx: CLIContext,
  name: string,
  range: string,
): Promise<void> {
  const versionsInfo = await ctx.registry.getPackageVersions(name);
  const exact = versionsInfo.versions[range];

  if (exact && exact.yanked) {
    throw new TerrazulError(ErrorCode.VERSION_YANKED, `Version ${range} of ${name} is yanked`);
  }
}

interface ResolvedPackageInfo {
  version: string;
  dependencies?: Record<string, string>;
}

/**
 * Resolve dependencies using the SAT resolver and return resolved packages.
 */
export async function resolvePackageDependencies(
  resolver: DependencyResolver,
  parsed: ParsedPackageSpec,
  ctx: CLIContext,
): Promise<Map<string, ResolvedPackageInfo>> {
  const { resolved, warnings } = await resolver.resolve({ [parsed.name]: parsed.range });

  for (const warning of warnings) {
    ctx.logger.warn(warning);
  }

  return resolved;
}

interface InstallResult {
  integrity: string;
  tarballBuffer: Buffer;
}

/**
 * Install a single package and return its integrity hash.
 */
export async function installPackage(
  ctx: CLIContext,
  packageManager: PackageManager,
  projectDir: string,
  pkgName: string,
  version: string,
): Promise<InstallResult> {
  ctx.logger.info(`Adding ${pkgName}@${version} ...`);

  return await packageManager.installSinglePackage(projectDir, pkgName, version);
}

interface LockfilePackageEntry {
  version: string;
  resolved: string;
  integrity: string;
  dependencies?: Record<string, string>;
  yanked: boolean;
}

/**
 * Build lockfile updates from resolved packages.
 */
export async function buildLockfileUpdates(
  ctx: CLIContext,
  resolved: Map<string, ResolvedPackageInfo>,
  projectDir: string,
  packageManager: PackageManager,
): Promise<{ updates: Record<string, LockfilePackageEntry>; addedNames: string[] }> {
  const updates: Record<string, LockfilePackageEntry> = {};
  const addedNames: string[] = [];

  for (const [pkgName, info] of resolved) {
    const { integrity } = await installPackage(
      ctx,
      packageManager,
      projectDir,
      pkgName,
      info.version,
    );

    const tarInfo = await ctx.registry.getTarballInfo(pkgName, info.version);
    updates[pkgName] = {
      version: info.version,
      resolved: stripQueryParams(tarInfo.url),
      integrity,
      dependencies: info.dependencies,
      yanked: false,
    };
    addedNames.push(pkgName);
  }

  return { updates, addedNames };
}

/**
 * Update and write the lockfile with new package entries.
 */
export function updateAndWriteLockfile(
  existingLock: ReturnType<typeof LockfileManager.read>,
  updates: Record<string, LockfilePackageEntry>,
  projectDir: string,
): void {
  const updated = LockfileManager.merge(existingLock, updates);
  LockfileManager.write(updated, projectDir);
}

/**
 * Add a package to a profile in agents.toml and log the result.
 */
export async function handleProfileUpdate(
  projectDir: string,
  profileName: string | undefined,
  packageName: string,
  logger: Logger,
): Promise<void> {
  if (!profileName) {
    return;
  }

  const added = await addPackageToProfile(projectDir, profileName, packageName);
  if (added) {
    logger.info(`Added ${packageName} to profile '${profileName}' in agents.toml`);
  } else {
    logger.warn(
      `Profile update skipped: unable to add ${packageName} under profile '${profileName}'`,
    );
  }
}

interface TemplateRenderResult {
  allPackageFiles: Map<string, string[]>;
  allRenderedFiles: RenderedFileMetadata[];
}

/**
 * Render templates for all added packages and collect file metadata.
 */
export async function renderPackageTemplates(
  ctx: CLIContext,
  addedNames: string[],
  projectDir: string,
  agentModulesRoot: string,
  force: boolean,
  onSnippetEvent: (progress: SnippetProgress) => void,
): Promise<TemplateRenderResult> {
  const allPackageFiles = new Map<string, string[]>();
  const allRenderedFiles: RenderedFileMetadata[] = [];

  for (const name of addedNames) {
    const res = await planAndRender(projectDir, agentModulesRoot, {
      packageName: name,
      force,
      dryRun: false,
      onSnippetEvent,
    });

    ctx.logger.info(`apply: wrote ${res.written.length} files for ${name}`);

    if (res.backedUp.length > 0) {
      for (const b of res.backedUp) {
        ctx.logger.info(`backup: ${b}`);
      }
    }

    for (const s of res.skipped) {
      ctx.logger.warn(`skipped: ${s.dest} (${s.reason})`);
    }

    if (res.packageFiles) {
      for (const [pkgName, files] of res.packageFiles) {
        allPackageFiles.set(pkgName, files);
      }
    }

    allRenderedFiles.push(...res.renderedFiles);
  }

  return { allPackageFiles, allRenderedFiles };
}

/**
 * Execute post-render tasks (inject @-mentions and create symlinks).
 * Collects ALL installed packages (not just newly-added) to avoid overwriting
 * previously-injected @-mentions in CLAUDE.md/AGENTS.md.
 */
export async function executePostRenderTasks(
  projectDir: string,
  _allPackageFiles: Map<string, string[]>,
  allRenderedFiles: RenderedFileMetadata[],
  logger: Logger,
): Promise<void> {
  // Collect ALL installed packages (not just newly-added)
  const { collectPackageFilesFromAgentModules } = await import('../utils/package-collection.js');
  const { packageFiles, packageInfos } = await collectPackageFilesFromAgentModules(projectDir);

  if (packageFiles.size === 0) return;

  const { executePostRenderTasks } = await import('../utils/post-render-tasks.js');
  await executePostRenderTasks(projectDir, packageFiles, logger, allRenderedFiles, packageInfos);
}
