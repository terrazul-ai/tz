import process from 'node:process';

import { render } from 'ink';

import { wrapError } from '../core/errors.js';
import {
  detectAllTools,
  isDetectableToolType,
  type DetectableToolType,
  DETECTABLE_TOOLS,
} from '../core/tool-detector.js';
import { createInkLogger } from '../ui/logger-adapter.js';
import { ToolWizard, type ToolScope } from '../ui/tool/ToolWizard.js';
import { loadConfig, updateConfig, getProfileTools } from '../utils/config.js';
import { readManifest, setPackageTool, getPackageTool } from '../utils/manifest.js';

import type { ToolSpec } from '../types/context.js';
import type { CLIContext } from '../utils/context.js';
import type { Command } from 'commander';

interface ToolSetOptions {
  scope: string;
}

/**
 * Get the first answer tool from profile.tools (the user's default)
 */
function getUserDefaultTool(tools: ToolSpec[]): DetectableToolType | null {
  for (const spec of tools) {
    if (isDetectableToolType(spec.type)) {
      return spec.type;
    }
  }
  return null;
}

/**
 * Update user config to make the specified tool the first in profile.tools
 */
async function setUserDefaultTool(tool: DetectableToolType): Promise<void> {
  const config = await loadConfig();
  const tools = getProfileTools(config);

  // Find existing spec for this tool or create a minimal one
  const existingIdx = tools.findIndex((t) => t.type === tool);
  const toolSpec: ToolSpec = existingIdx >= 0 ? tools.splice(existingIdx, 1)[0] : { type: tool };

  // Put it at the front
  const reordered = [toolSpec, ...tools.filter((t) => t.type !== tool)];

  await updateConfig({
    profile: { tools: reordered },
  });
}

export function registerToolCommand(
  program: Command,
  createCtx: (opts: { verbose?: boolean }) => CLIContext,
): void {
  const tool = program.command('tool').description('Configure default AI tool preferences');

  // Default action: interactive wizard
  tool.action(async () => {
    const opts = program.opts<{ verbose?: boolean }>();
    const ctx = createCtx({ verbose: opts.verbose });

    try {
      // Check for TTY
      if (!process.stdout.isTTY) {
        ctx.logger.info('Interactive mode requires a TTY.');
        ctx.logger.info('');
        ctx.logger.info('Available commands:');
        ctx.logger.info('  tz tool list      List tools and detection status');
        ctx.logger.info('  tz tool current   Show current default tool');
        ctx.logger.info('  tz tool set <tool> --scope <project|user|both>');
        return;
      }

      const cwd = process.cwd();
      const manifest = await readManifest(cwd);
      const hasManifest = manifest !== null;
      const projectTool = await getPackageTool(cwd);
      const config = await loadConfig();
      const userTool = getUserDefaultTool(getProfileTools(config));

      const inkLogger = createInkLogger({ baseLogger: ctx.logger });
      const ink = render(
        <ToolWizard
          detectTools={async () => {
            const result = await detectAllTools();
            return result.tools;
          }}
          currentProjectTool={projectTool}
          currentUserTool={userTool}
          hasProjectManifest={hasManifest}
          saveSelection={async (selectedTool: DetectableToolType, scope: ToolScope) => {
            if (scope === 'project' || scope === 'both') {
              await setPackageTool(cwd, selectedTool);
            }
            if (scope === 'user' || scope === 'both') {
              await setUserDefaultTool(selectedTool);
            }
          }}
          logger={inkLogger}
          onComplete={(selectedTool, scope) => {
            ctx.logger.info(`Default tool set to ${selectedTool} (scope: ${scope})`);
          }}
          onCancel={() => {
            process.exitCode = 1;
          }}
        />,
        { exitOnCtrlC: false },
      );

      await ink.waitUntilExit();
    } catch (error) {
      const wrapped = wrapError(error);
      ctx.logger.error(wrapped.toUserMessage());
      process.exitCode = wrapped.getExitCode();
    }
  });

  // Subcommand: list
  tool
    .command('list')
    .description('List available tools and their installation status')
    .action(async () => {
      const opts = program.opts<{ verbose?: boolean }>();
      const ctx = createCtx({ verbose: opts.verbose });

      try {
        ctx.logger.info('Detecting installed tools...');
        const { tools, installedCount } = await detectAllTools();

        ctx.logger.info('');
        for (const t of tools) {
          const statusIcon = t.installed ? '\u2713' : '\u2717';
          const statusText = t.installed
            ? t.version
              ? `installed (v${t.version})`
              : 'installed'
            : (t.error ?? 'not found');
          ctx.logger.info(`  ${statusIcon} ${t.type.padEnd(10)} ${statusText}`);
        }
        ctx.logger.info('');
        ctx.logger.info(`${installedCount} of ${tools.length} tools installed`);
      } catch (error) {
        const wrapped = wrapError(error);
        ctx.logger.error(wrapped.toUserMessage());
        process.exitCode = wrapped.getExitCode();
      }
    });

  // Subcommand: current
  tool
    .command('current')
    .description('Show current default tool settings')
    .action(async () => {
      const opts = program.opts<{ verbose?: boolean }>();
      const ctx = createCtx({ verbose: opts.verbose });

      try {
        const cwd = process.cwd();
        const projectTool = await getPackageTool(cwd);
        const config = await loadConfig();
        const userTool = getUserDefaultTool(getProfileTools(config));

        ctx.logger.info('Current default tool settings:');
        ctx.logger.info('');

        if (projectTool === undefined) {
          ctx.logger.info('  Project: (no agents.toml)');
        } else if (projectTool === null) {
          ctx.logger.info('  Project: not set');
        } else {
          ctx.logger.info(`  Project: ${projectTool}`);
        }

        ctx.logger.info(`  User:    ${userTool ?? 'not set'}`);
        ctx.logger.info('');

        const effective = projectTool ?? userTool ?? 'claude';
        ctx.logger.info(`Effective default: ${effective}`);
      } catch (error) {
        const wrapped = wrapError(error);
        ctx.logger.error(wrapped.toUserMessage());
        process.exitCode = wrapped.getExitCode();
      }
    });

  // Subcommand: set
  tool
    .command('set')
    .argument('<tool>', `Tool to set as default (${DETECTABLE_TOOLS.join(', ')})`)
    .option('--scope <scope>', 'Where to save: project, user, or both', 'project')
    .description('Set the default tool (non-interactive)')
    .action(async (toolArg: string, options: ToolSetOptions) => {
      const opts = program.opts<{ verbose?: boolean }>();
      const ctx = createCtx({ verbose: opts.verbose });

      try {
        const toolName = toolArg.toLowerCase().trim();
        if (!isDetectableToolType(toolName)) {
          ctx.logger.error(`Invalid tool: ${toolArg}`);
          ctx.logger.error(`Valid tools: ${DETECTABLE_TOOLS.join(', ')}`);
          process.exitCode = 1;
          return;
        }

        const scope = options.scope.toLowerCase().trim();
        if (!['project', 'user', 'both'].includes(scope)) {
          ctx.logger.error(`Invalid scope: ${options.scope}`);
          ctx.logger.error('Valid scopes: project, user, both');
          process.exitCode = 1;
          return;
        }

        const cwd = process.cwd();

        if (scope === 'project' || scope === 'both') {
          const manifest = await readManifest(cwd);
          if (!manifest) {
            ctx.logger.error('No agents.toml found in current directory');
            ctx.logger.error('Run "tz init" first or use --scope user');
            process.exitCode = 1;
            return;
          }
          const changed = await setPackageTool(cwd, toolName);
          if (changed) {
            ctx.logger.info(`Updated agents.toml: tool = "${toolName}"`);
          } else {
            ctx.logger.info(`agents.toml already has tool = "${toolName}"`);
          }
        }

        if (scope === 'user' || scope === 'both') {
          await setUserDefaultTool(toolName);
          ctx.logger.info(`Updated ~/.terrazul/config.json: default tool = "${toolName}"`);
        }

        ctx.logger.info(`Default tool set to ${toolName} (scope: ${scope})`);
      } catch (error) {
        const wrapped = wrapError(error);
        ctx.logger.error(wrapped.toUserMessage());
        process.exitCode = wrapped.getExitCode();
      }
    });
}
