import path from 'node:path';

import { DependencyResolver } from '../core/dependency-resolver.js';
import { TerrazulError, ErrorCode } from '../core/errors.js';
import { LockfileManager } from '../core/lock-file.js';
import { PackageManager } from '../core/package-manager.js';
import { planAndRender, type RenderedFileMetadata } from '../core/template-renderer.js';
import { handleCommandError } from '../utils/command-errors.js';
import { readManifest } from '../utils/manifest.js';
import { collectPackageFilesFromAgentModules } from '../utils/package-collection.js';
import { stripQueryParams } from '../utils/url.js';

import type { CLIContext } from '../utils/context.js';
import type { Command } from 'commander';

/**
 * Infer which packages should be updated as roots
 */
async function inferUpdateRoots(
  projectDir: string,
  pkg: string | undefined,
  lockfile: ReturnType<typeof LockfileManager.read>,
): Promise<Record<string, string>> {
  const roots: Record<string, string> = {};

  if (pkg) {
    // Update specific package - constrain to current major version
    const locked = lockfile!.packages[pkg];
    if (!locked) {
      throw new TerrazulError(ErrorCode.PACKAGE_NOT_FOUND, `Package ${pkg} not found in lockfile`);
    }
    roots[pkg] = `^${locked.version}`;
  } else {
    // Update all packages - prefer manifest dependencies as roots
    const manifest = await readManifest(projectDir);
    if (manifest?.dependencies && Object.keys(manifest.dependencies).length > 0) {
      for (const [name, range] of Object.entries(manifest.dependencies)) {
        roots[name] = range;
      }
    } else {
      // Fallback: infer roots as packages not depended upon by others
      const all = lockfile!.packages;
      const dependedUpon = new Set<string>();
      for (const info of Object.values(all)) {
        for (const depName of Object.keys(info.dependencies || {})) {
          dependedUpon.add(depName);
        }
      }
      for (const name of Object.keys(all)) {
        if (!dependedUpon.has(name)) {
          roots[name] = `^${all[name].version}`;
        }
      }
    }
  }

  return roots;
}

/**
 * Build update plan by comparing resolved versions to lockfile
 */
function buildUpdatePlan(
  resolved: Map<string, { version: string; dependencies?: Record<string, string> }>,
  lockfile: ReturnType<typeof LockfileManager.read>,
): Array<{ name: string; from?: string; to: string }> {
  const plan: Array<{ name: string; from?: string; to: string }> = [];

  for (const [name, info] of resolved) {
    const current = lockfile!.packages[name]?.version;
    if (current !== info.version) {
      plan.push({ name, from: current, to: info.version });
    }
  }

  return plan;
}

/**
 * Apply updates by installing packages and updating lockfile
 */
async function applyUpdates(
  projectDir: string,
  resolved: Map<string, { version: string; dependencies?: Record<string, string> }>,
  lockfile: ReturnType<typeof LockfileManager.read>,
  ctx: CLIContext,
): Promise<string[]> {
  const updates: Record<string, ReturnType<typeof LockfileManager.merge>['packages'][string]> = {};
  const changed: string[] = [];
  const packageManager = new PackageManager(ctx);

  for (const [pkgName, info] of resolved) {
    const current = lockfile!.packages[pkgName]?.version;
    if (current === info.version) continue; // skip unchanged

    ctx.logger.info(`Updating ${pkgName} to ${info.version}`);

    const { integrity } = await packageManager.installSinglePackage(
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
    changed.push(pkgName);
  }

  const updated = LockfileManager.merge(lockfile, updates);
  LockfileManager.write(updated, projectDir);

  return changed;
}

/**
 * Render templates for updated packages
 */
async function renderUpdatedPackages(
  projectDir: string,
  changed: string[],
  applyForce: boolean,
  ctx: CLIContext,
): Promise<void> {
  const agentModulesRoot = path.join(projectDir, 'agent_modules');
  const allRenderedFiles: RenderedFileMetadata[] = [];

  for (const name of changed) {
    const res = await planAndRender(projectDir, agentModulesRoot, {
      packageName: name,
      force: applyForce,
      dryRun: false,
    });
    ctx.logger.info(`apply: wrote ${res.written.length} files for ${name}`);
    for (const s of res.skipped) ctx.logger.warn(`skipped: ${s.dest} (${s.reason})`);
    allRenderedFiles.push(...res.renderedFiles);
  }

  // Inject package context and create symlinks
  const { packageFiles, packageInfos } = await collectPackageFilesFromAgentModules(projectDir);
  const { executePostRenderTasks } = await import('../utils/post-render-tasks.js');
  await executePostRenderTasks(
    projectDir,
    packageFiles,
    ctx.logger,
    allRenderedFiles,
    packageInfos,
  );
}

export function registerUpdateCommand(
  program: Command,
  createCtx: (opts: { verbose?: boolean }) => CLIContext,
): void {
  program
    .command('update')
    .argument('[pkg]', 'Optional package to update')
    .option('--dry-run', 'Preview updates without applying')
    .option('--no-apply', 'Do not render templates after update')
    .option('--apply-force', 'Overwrite existing files when applying templates', false)
    .description('Update to highest compatible non-yanked versions')
    .action(
      async (
        pkg: string | undefined,
        opts: { dryRun?: boolean; apply?: boolean; applyForce?: boolean },
      ) => {
        const progOpts = program.opts<{ verbose?: boolean }>();
        const ctx = createCtx({ verbose: progOpts.verbose });
        const projectDir = process.cwd();

        // Validate lockfile exists
        const lockfile = LockfileManager.read(projectDir);
        if (!lockfile) {
          ctx.logger.error('No lockfile found');
          process.exitCode = 1;
          return;
        }

        try {
          // Infer which packages to update
          const roots = await inferUpdateRoots(projectDir, pkg, lockfile);

          // Resolve dependencies (ignore existing lockfile to get latest versions)
          const resolver = new DependencyResolver(ctx.registry, {
            lockfile: undefined,
            logger: ctx.logger,
            preferLatest: true,
          });

          const { resolved, warnings } = await resolver.resolve(roots);
          for (const w of warnings) {
            ctx.logger.warn(w);
          }

          // Build update plan
          const plan = buildUpdatePlan(resolved, lockfile);

          // Handle dry-run
          if (opts.dryRun) {
            if (plan.length === 0) ctx.logger.info('All packages up to date');
            for (const p of plan) {
              ctx.logger.info(`${p.name}: ${p.from ?? 'none'} -> ${p.to}`);
            }
            return;
          }

          // Apply updates
          const changed = await applyUpdates(projectDir, resolved, lockfile, ctx);
          ctx.logger.info('Update complete');

          // Optionally render templates for changed packages
          const applyEnabled = opts.apply !== false; // --no-apply sets false
          if (applyEnabled && changed.length > 0) {
            await renderUpdatedPackages(projectDir, changed, Boolean(opts.applyForce), ctx);
          }
        } catch (error) {
          handleCommandError(error, ctx.logger);
        }
      },
    );
}
