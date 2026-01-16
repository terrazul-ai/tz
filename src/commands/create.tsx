import path from 'node:path';
import process from 'node:process';

import { render } from 'ink';

import { ErrorCode, TerrazulError, wrapError } from '../core/errors.js';
import {
  buildCreateOptionsSkeleton,
  createPackageScaffold,
  deriveDefaultPackageName,
  type CreateOptions,
  type CreateResult,
} from '../core/package-creator.js';
import { CreateWizard } from '../ui/create/CreateWizard.js';
import { createInkLogger } from '../ui/logger-adapter.js';

import type { CLIContext } from '../utils/context.js';
import type { ToolName } from '../utils/manifest.js';
import type { Command } from 'commander';

interface CreateCommandOptions {
  dryRun?: boolean;
}

interface AutomationPayload {
  description?: string;
  license?: string;
  version?: string;
  tools?: string[];
  includeExamples?: boolean;
  includeHooks?: boolean;
  dryRun?: boolean;
}

const VALID_TOOLS = new Set<ToolName>(['claude', 'codex', 'gemini']);

function applyAutomation(base: CreateOptions, payload: AutomationPayload | null): CreateOptions {
  if (!payload) return base;
  const merged: CreateOptions = { ...base };

  if (typeof payload.description === 'string') merged.description = payload.description;
  if (typeof payload.license === 'string') merged.license = payload.license;
  if (typeof payload.version === 'string' && payload.version.trim().length > 0) {
    merged.version = payload.version.trim();
  }

  if (Array.isArray(payload.tools)) {
    const filtered = payload.tools
      .map((tool) => tool.trim())
      .filter((tool): tool is ToolName => VALID_TOOLS.has(tool as ToolName));
    merged.tools = filtered;
  }

  if (typeof payload.includeExamples === 'boolean') {
    merged.includeExamples = payload.includeExamples;
  }

  if (typeof payload.includeHooks === 'boolean') {
    merged.includeHooks = payload.includeHooks;
  }

  merged.dryRun = Boolean(base.dryRun || payload.dryRun);

  return merged;
}

async function runCreateWizard(
  baseOptions: CreateOptions,
  ctx: CLIContext,
): Promise<CreateResult | null> {
  const inkLogger = createInkLogger({ baseLogger: ctx.logger });

  let finalResult: CreateResult | null = null;
  let cancelled = false;

  const ink = render(
    <CreateWizard
      baseOptions={baseOptions}
      execute={async (options: CreateOptions) => createPackageScaffold(options, inkLogger)}
      logger={inkLogger}
      onComplete={(result: CreateResult) => {
        finalResult = result;
      }}
      onCancel={() => {
        cancelled = true;
      }}
    />,
    { exitOnCtrlC: false },
  );

  await ink.waitUntilExit();

  if (cancelled) {
    process.exitCode = 1;
    return null;
  }

  return finalResult;
}

function formatRelative(baseDir: string, target: string): string {
  const relative = path.relative(baseDir, target);
  return relative.length === 0 ? './' : `./${relative.replaceAll('\\', '/')}`;
}

async function buildCreateBaseOptions(
  nameArg: string | undefined,
  rawOptions: CreateCommandOptions | undefined,
  ctx: CLIContext,
): Promise<CreateOptions> {
  const cwd = process.cwd();
  let resolvedName = nameArg?.trim();
  if (!resolvedName || resolvedName.length === 0) {
    resolvedName = await deriveDefaultPackageName(ctx, cwd);
  } else if (!resolvedName.startsWith('@')) {
    const scopedDefault = await deriveDefaultPackageName(ctx, cwd);
    const scope = scopedDefault.split('/')[0]; // @scope
    resolvedName = `${scope}/${resolvedName}`;
  }

  const skeleton = buildCreateOptionsSkeleton(resolvedName, cwd);
  return {
    ...skeleton,
    dryRun: Boolean(rawOptions?.dryRun),
  };
}

function parseAutomation(envValue: string | undefined): AutomationPayload | null {
  if (!envValue || envValue.trim().length === 0) return null;
  try {
    const parsed = JSON.parse(envValue) as AutomationPayload;
    return parsed;
  } catch {
    throw new TerrazulError(
      ErrorCode.INVALID_ARGUMENT,
      'Failed to parse TZ_CREATE_AUTOFILL payload. Expected valid JSON object.',
    );
  }
}

async function runAutomation(
  options: CreateOptions,
  ctx: CLIContext,
  payload: AutomationPayload | null,
): Promise<CreateResult> {
  const merged = applyAutomation(options, payload);
  const result = await createPackageScaffold(merged, ctx.logger);
  if (merged.dryRun) {
    ctx.logger.info(`DRY RUN: Would create package at ${result.targetDir}`);
    for (const entry of result.created) {
      ctx.logger.info(`Would create: ${formatRelative(process.cwd(), entry)}`);
    }
  } else {
    ctx.logger.info(`Package created at ${result.targetDir}`);
  }
  return result;
}

export function registerCreateCommand(
  program: Command,
  createCtx: (opts: { verbose?: boolean }) => CLIContext,
): void {
  program
    .command('create')
    .argument('[name]', 'Optional package name (@scope/name or bare-package)')
    .description('Interactive wizard to scaffold a new Terrazul package')
    .option('--dry-run', 'Preview structure without writing files', false)
    .action(async (name: string | undefined, raw: CreateCommandOptions) => {
      const opts = program.opts<{ verbose?: boolean }>();
      const ctx = createCtx({ verbose: opts.verbose });

      try {
        const baseOptions = await buildCreateBaseOptions(name, raw, ctx);

        const automationPayload = parseAutomation(process.env.TZ_CREATE_AUTOFILL);
        if (automationPayload) {
          await runAutomation(baseOptions, ctx, automationPayload);
          return;
        }

        if (!process.stdout.isTTY) {
          throw new TerrazulError(
            ErrorCode.INVALID_ARGUMENT,
            'Interactive wizard requires a TTY. Set TZ_CREATE_AUTOFILL to automate this command.',
          );
        }

        const result = await runCreateWizard(baseOptions, ctx);
        if (result) {
          if (baseOptions.dryRun) {
            ctx.logger.info(`DRY RUN: Would create package at ${result.targetDir}`);
          } else {
            ctx.logger.info(`Package created at ${result.targetDir}`);
          }
        }
      } catch (error) {
        const wrapped = wrapError(error);
        ctx.logger.error(wrapped.toUserMessage());
        process.exitCode = wrapped.getExitCode();
      }
    });
}
