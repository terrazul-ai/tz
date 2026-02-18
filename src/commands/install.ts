import path from 'node:path';

import { TerrazulError } from '../core/errors.js';
import { LockfileManager } from '../core/lock-file.js';
import { PackageManager } from '../core/package-manager.js';
import { planAndRender } from '../core/template-renderer.js';
import { loadProjectConfig } from '../utils/config.js';
import { executePostRenderTasks } from '../utils/post-render-tasks.js';

import type { RenderedFileMetadata } from '../core/template-renderer.js';
import type { CLIContext } from '../utils/context.js';
import type { Command } from 'commander';

export function registerInstallCommand(
  program: Command,
  createCtx: (opts: { verbose?: boolean }) => CLIContext,
): void {
  program
    .command('install')
    .description('Install dependencies declared in agents.toml')
    .option('--offline', 'Use only the local cache and lockfile')
    .option('--frozen-lockfile', 'Fail if lockfile would change')
    .option('--force', 'Reinstall packages even if already present')
    .option('--no-apply', 'Do not render templates after install')
    .option('--apply-force', 'Overwrite files when applying templates', false)
    .action(async (raw: Record<string, unknown>) => {
      const opts = program.opts<{ verbose?: boolean }>();
      const ctx = createCtx({ verbose: opts.verbose });
      const projectDir = process.cwd();

      try {
        ctx.logger.debug(`config:load:start ${projectDir}`);
        const projectConfig = await loadProjectConfig(projectDir);
        ctx.logger.debug(
          `config:load:done dependencies=${Object.keys(projectConfig.dependencies).length}`,
        );

        const manager = new PackageManager(ctx);
        const result = await manager.installFromConfig(projectDir, projectConfig, {
          offline: Boolean(raw['offline']),
          frozenLockfile: Boolean(raw['frozenLockfile']),
          force: Boolean(raw['force']),
        });

        for (const warning of result.warnings) {
          ctx.logger.warn(warning);
        }

        LockfileManager.write(result.lockfile, projectDir);

        if (result.summary.length === 0) {
          ctx.logger.info('No dependencies declared in agents.toml');
        } else {
          ctx.logger.info('Install summary:');
          for (const entry of result.summary) {
            ctx.logger.info(`  ${entry.name}@${entry.version} (${entry.source})`);
          }
        }

        const applyEnabled = raw['apply'] !== false;
        if (applyEnabled) {
          const agentModulesRoot = path.join(projectDir, 'agent_modules');
          const allPackageFiles = new Map<string, string[]>();
          const allRenderedFiles: RenderedFileMetadata[] = [];

          for (const entry of result.summary) {
            const res = await planAndRender(projectDir, agentModulesRoot, {
              packageName: entry.name,
              force: Boolean(raw['applyForce']),
              dryRun: false,
            });
            ctx.logger.info(`apply: ${entry.name} wrote ${res.written.length} file(s)`);
            for (const skipped of res.skipped) {
              ctx.logger.warn(`apply: skipped ${skipped.dest} (${skipped.reason})`);
            }
            for (const backup of res.backedUp) {
              ctx.logger.info(`apply: backup created at ${backup}`);
            }

            if (res.packageFiles) {
              for (const [pkgName, files] of res.packageFiles) {
                allPackageFiles.set(pkgName, files);
              }
            }
            allRenderedFiles.push(...res.renderedFiles);
          }

          await executePostRenderTasks(projectDir, allPackageFiles, ctx.logger, allRenderedFiles);
        } else {
          ctx.logger.info('Skipping apply (--no-apply)');
        }
      } catch (error) {
        const err = error as TerrazulError | Error;
        if (err instanceof TerrazulError) {
          ctx.logger.error(err.toUserMessage());
          process.exitCode = err.getExitCode();
        } else {
          ctx.logger.error(err.message || String(err));
          process.exitCode = 1;
        }
      }
    });
}
