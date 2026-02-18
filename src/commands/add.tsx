import path from 'node:path';

import { valid as isExactSemver } from 'semver';

import { createSnippetEventHandler } from './add-event-handlers.js';
import {
  validatePackageVersion,
  resolvePackageDependencies,
  buildLockfileUpdates,
  updateAndWriteLockfile,
  handleProfileUpdate,
  renderPackageTemplates,
  executePostRenderTasks as executePostRenderTasksHelper,
} from './add-helpers.js';
import { DependencyResolver } from '../core/dependency-resolver.js';
import { TerrazulError } from '../core/errors.js';
import { LockfileManager } from '../core/lock-file.js';
import { PackageManager } from '../core/package-manager.js';
import { createSpinnerManager } from '../ui/apply/spinner-manager.js';
import { addOrUpdateDependency } from '../utils/manifest.js';
import { parsePackageSpec } from '../utils/package-spec.js';

import type { CLIContext } from '../utils/context.js';
import type { Command } from 'commander';

export function registerAddCommand(
  program: Command,
  createCtx: (opts: { verbose?: boolean }) => CLIContext,
): void {
  program
    .command('add')
    .argument('[spec]', 'Package spec like @scope/name@1.0.0 or with range')
    .description('Resolve, download, verify, extract, and link packages')
    .option('--no-apply', 'Do not render templates after add')
    .option('--apply-force', 'Overwrite existing files when applying templates', false)
    .option('--profile <profile>', 'Assign the added package to the given profile in agents.toml')
    .action(async (_spec: string | undefined, raw: Record<string, unknown>) => {
      const opts = program.opts<{ verbose?: boolean }>();
      const ctx = createCtx({ verbose: opts.verbose });
      const projectDir = process.cwd();

      const parsed = parsePackageSpec(_spec);
      if (!parsed) {
        ctx.logger.error('Please provide a package spec like @scope/name or @scope/name@1.0.0');
        process.exitCode = 1;
        return;
      }

      const profileName = typeof raw['profile'] === 'string' ? raw['profile'].trim() : undefined;

      const existingLock = LockfileManager.read(projectDir);
      const resolver = new DependencyResolver(ctx.registry, {
        lockfile: existingLock,
        logger: ctx.logger,
      });

      try {
        await validatePackageVersion(ctx, parsed.name, parsed.range);

        const resolved = await resolvePackageDependencies(resolver, parsed, ctx);

        const packageManager = new PackageManager(ctx);
        const { updates, addedNames } = await buildLockfileUpdates(
          ctx,
          resolved,
          projectDir,
          packageManager,
        );

        updateAndWriteLockfile(existingLock, updates, projectDir);

        // Record dependency in agents.toml using a caret range
        let manifestRange = parsed.range;
        if (manifestRange === '*') {
          const resolvedVersion = resolved.get(parsed.name)?.version;
          if (resolvedVersion) manifestRange = `^${resolvedVersion}`;
        } else if (isExactSemver(manifestRange)) {
          manifestRange = `^${manifestRange}`;
        }
        await addOrUpdateDependency(projectDir, parsed.name, manifestRange);

        ctx.logger.info('Add complete');

        await handleProfileUpdate(projectDir, profileName, parsed.name, ctx.logger);

        const applyEnabled = raw['apply'] !== false;
        if (applyEnabled) {
          const isTTY = process.stdout.isTTY ?? false;
          const { activeTasks, renderSpinner, cleanup } = createSpinnerManager(isTTY);

          const onSnippetEvent = createSnippetEventHandler(
            activeTasks,
            renderSpinner,
            isTTY,
            ctx.logger,
          );

          const agentModulesRoot = path.join(projectDir, 'agent_modules');
          const { allPackageFiles, allRenderedFiles } = await renderPackageTemplates(
            ctx,
            addedNames,
            projectDir,
            agentModulesRoot,
            Boolean(raw['applyForce']),
            onSnippetEvent,
          );

          await executePostRenderTasksHelper(
            projectDir,
            allPackageFiles,
            allRenderedFiles,
            ctx.logger,
          );

          cleanup();
        }
      } catch (error) {
        const err = error as TerrazulError | Error;
        ctx.logger.error(
          err instanceof TerrazulError ? err.toUserMessage() : String(err.message || err),
        );
        process.exitCode = err instanceof TerrazulError ? err.getExitCode() : 1;
      }
    });
}
