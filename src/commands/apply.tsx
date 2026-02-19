import path from 'node:path';

import { render } from 'ink';
import React from 'react';

import { planAndRender } from '../core/template-renderer.js';
import { AskAgentSpinner, type AskAgentTask } from '../ui/apply/AskAgentSpinner.js';
import { generateAskAgentSummary } from '../utils/ask-agent-summary.js';
import { reportSnippetExecutions } from '../utils/snippet-log.js';
import { normalizeToolOption } from '../utils/tool-options.js';

import type { SnippetProgress, TemplateProgress } from '../core/template-renderer.js';
import type { CLIContext } from '../utils/context.js';
import type { Command } from 'commander';
import type { Instance } from 'ink';

export function registerApplyCommand(
  program: Command,
  createCtx: (opts: { verbose?: boolean }) => CLIContext,
): void {
  program
    .command('apply')
    .argument('[package]', 'Optional package name to apply only that package')
    .description('Render installed templates into actual config files (CLAUDE.md, .claude, etc.)')
    .option('--force', 'Overwrite existing destination files', false)
    .option('--dry-run', 'Plan without writing any files', false)
    .option('--profile <profile>', 'Apply only the packages associated with the given profile')
    .option('--tool <tool>', 'Use a specific answer tool (claude or codex)')
    .option('--no-tool-safe-mode', 'Disable safe mode for tool execution')
    .option('--no-cache', 'Skip snippet cache (re-execute all askAgent/askUser prompts)', false)
    .action(
      async (
        _pkg: string | undefined,
        opts: {
          force?: boolean;
          dryRun?: boolean;
          profile?: string;
          tool?: string;
          toolSafeMode?: boolean;
          noCache?: boolean;
        },
      ) => {
        const g = program.opts<{ verbose?: boolean }>();
        const ctx = createCtx({ verbose: g.verbose });
        const projectRoot = process.cwd();
        const agentModulesRoot = path.join(projectRoot, 'agent_modules');
        const profileName = typeof opts.profile === 'string' ? opts.profile.trim() : undefined;

        try {
          if (_pkg && profileName) {
            ctx.logger.error('Cannot combine package argument with --profile');
            process.exitCode = 1;
            return;
          }

          const toolOverride = normalizeToolOption(opts.tool);
          const toolSafeMode = opts.toolSafeMode ?? true;

          const templateStarts = new Set<string>();

          const onTemplateStart = ({ dest }: TemplateProgress): void => {
            const destLabel = path.relative(projectRoot, dest) || dest;
            if (templateStarts.has(destLabel)) return;
            templateStarts.add(destLabel);
            ctx.logger.info(`Building ${destLabel}`);
          };

          // Task management for Ink spinner
          const activeTasks = new Map<string, AskAgentTask>();
          let inkInstance: Instance | null = null;
          const isTTY = process.stdout.isTTY ?? false;

          const renderSpinner = (): void => {
            if (!isTTY) return;

            const tasks = [...activeTasks.values()];
            if (tasks.length === 0) {
              if (inkInstance !== null) {
                const instance: Instance = inkInstance;
                instance.unmount();
                inkInstance = null;
              }
              return;
            }

            if (inkInstance === null) {
              inkInstance = render(<AskAgentSpinner tasks={tasks} />, {
                stdout: process.stdout,
                stdin: process.stdin,
                exitOnCtrlC: false,
              });
            } else {
              inkInstance.rerender(<AskAgentSpinner tasks={tasks} />);
            }
          };

          const onSnippetEvent = ({ event, dest }: SnippetProgress): void => {
            switch (event.type) {
              case 'askAgent:start': {
                // Use stable task ID based on destination + snippet ID to prevent duplicates
                const taskId = `${dest}:${event.snippet.id}`;

                // If this task already exists, skip creating a duplicate
                if (activeTasks.has(taskId)) {
                  if (ctx.logger.isVerbose()) {
                    ctx.logger.info(`[apply] Skipping duplicate askAgent task: ${taskId}`);
                  }
                  return;
                }

                const task: AskAgentTask = {
                  id: taskId,
                  title: 'Processing...',
                  status: 'running',
                };

                activeTasks.set(taskId, task);

                if (isTTY) {
                  renderSpinner();

                  // Generate summary asynchronously and update when ready
                  void generateAskAgentSummary(event.prompt)
                    .then((summary) => {
                      const existingTask = activeTasks.get(taskId);
                      if (existingTask && existingTask.status === 'running') {
                        existingTask.title = summary;
                        renderSpinner();
                      }
                      return;
                    })
                    .catch(() => {
                      // Silently ignore summary generation errors
                      return;
                    });
                } else {
                  // Non-TTY: just log the start
                  ctx.logger.info('Running askAgent snippet...');
                }
                break;
              }
              case 'askAgent:end': {
                // Use same stable task ID to find the exact task
                const taskId = `${dest}:${event.snippet.id}`;
                const task = activeTasks.get(taskId);

                if (task) {
                  task.status = 'complete';
                  if (isTTY) {
                    renderSpinner();
                    // Keep completed task visible to show progress
                  } else {
                    ctx.logger.info('askAgent complete.');
                  }
                } else if (!isTTY) {
                  ctx.logger.info('askAgent complete.');
                }
                break;
              }
              case 'askAgent:error': {
                // Use same stable task ID to find the exact task
                const taskId = `${dest}:${event.snippet.id}`;
                const task = activeTasks.get(taskId);

                if (task) {
                  task.status = 'error';
                  task.error = event.error.message;
                  if (isTTY) {
                    renderSpinner();
                    // Keep error visible to show what failed
                  } else {
                    ctx.logger.warn(`askAgent failed: ${event.error.message}`);
                  }
                } else if (!isTTY) {
                  ctx.logger.warn(`askAgent failed: ${event.error.message}`);
                }
                break;
              }
              default: {
                break;
              }
            }
          };

          const res = await planAndRender(projectRoot, agentModulesRoot, {
            force: opts.force,
            dryRun: opts.dryRun,
            packageName: _pkg,
            profileName,
            tool: toolOverride,
            toolSafeMode,
            noCache: opts.noCache,
            verbose: ctx.logger.isVerbose(),
            onTemplateStart,
            onSnippetEvent,
          });

          // Inject @-mentions and create symlinks (unless dry-run)
          if (!opts.dryRun && res.packageFiles) {
            // Collect ALL installed packages (not just the rendered subset) to avoid
            // overwriting previously-injected @-mentions in CLAUDE.md/AGENTS.md
            const { collectPackageFilesFromAgentModules } = await import(
              '../utils/package-collection.js'
            );
            const { packageFiles, packageInfos } =
              await collectPackageFilesFromAgentModules(projectRoot);

            const { executePostRenderTasks } = await import('../utils/post-render-tasks.js');
            await executePostRenderTasks(
              projectRoot,
              packageFiles,
              ctx.logger,
              res.renderedFiles,
              packageInfos,
            );
          }

          // Clean up Ink instance
          if (inkInstance !== null) {
            const instance: Instance = inkInstance;
            instance.unmount();
            inkInstance = null;
          }

          if (opts.dryRun) {
            ctx.logger.info(`apply (dry-run): would write ${res.written.length} files`);
          } else {
            ctx.logger.info(`apply: wrote ${res.written.length} files`);
          }
          if (res.backedUp.length > 0) {
            for (const b of res.backedUp) ctx.logger.info(`backup: ${b}`);
          }
          if (res.skipped.length > 0) {
            for (const s of res.skipped) ctx.logger.warn(`skipped: ${s.dest} (${s.reason})`);
          }
          if (res.snippets.length > 0) {
            reportSnippetExecutions(res.snippets, ctx.logger);
          }
        } catch (error) {
          ctx.logger.error(
            error instanceof Error ? error.message : `apply failed: ${String(error)}`,
          );
          process.exitCode = 1;
        }
      },
    );
}
