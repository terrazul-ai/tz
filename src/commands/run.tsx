import { promises as fs } from 'node:fs';
import path from 'node:path';

import { render } from 'ink';
import React from 'react';

import { DependencyResolver } from '../core/dependency-resolver.js';
import { ErrorCode, TerrazulError } from '../core/errors.js';
import { LockfileManager } from '../core/lock-file.js';
import { PackageManager } from '../core/package-manager.js';
import { planAndRender } from '../core/template-renderer.js';
import {
  aggregateMCPConfigs,
  cleanupMCPConfig,
  generateMCPConfigFile,
  spawnClaudeCodeHeadless,
} from '../integrations/claude-code.js';
import {
  cleanupCodexSession,
  createCodexSession,
  type CodexSessionConfig,
} from '../integrations/codex-session.js';
import { createSymlinks } from '../integrations/symlink-manager.js';
import { loadMCPConfig, spawnTool } from '../integrations/tool-spawner.js';
import { AskAgentSpinner, type AskAgentTask } from '../ui/apply/AskAgentSpinner.js';
import { generateAskAgentSummary } from '../utils/ask-agent-summary.js';
import { injectPackageContext, type PackageInfo } from '../utils/context-file-injector.js';
import { ensureDir } from '../utils/fs.js';
import { addOrUpdateDependency, readManifest } from '../utils/manifest.js';
import { agentModulesPath, isFilesystemPath, resolvePathSpec } from '../utils/path.js';
import { resolveSpawnTool } from '../utils/spawn-tool-resolve.js';
import { normalizeToolOption } from '../utils/tool-options.js';
import { stripQueryParams } from '../utils/url.js';

import type { SnippetProgress } from '../core/template-renderer.js';
import type { ToolSpec } from '../types/context.js';
import type { CLIContext } from '../utils/context.js';
import type { Command } from 'commander';
import type { Instance } from 'ink';

/**
 * Parse package spec like @scope/name@1.0.0 or @scope/name@^1.0.0
 */
function parseSpec(spec?: string): { name: string; range: string } | null {
  if (!spec) return null;
  const m = spec.match(/^(@[^@]+?)@([^@]+)$/) || spec.match(/^([^@]+)@([^@]+)$/);
  if (!m) return null;
  return { name: m[1], range: m[2] };
}

/**
 * Check if a package is installed in agent_modules/ and optionally verify version
 */
async function isPackageInstalled(
  projectRoot: string,
  packageName: string,
  requestedRange?: string,
): Promise<boolean> {
  try {
    const pkgPath = agentModulesPath(projectRoot, packageName);
    await fs.access(pkgPath);

    // If a specific version range is requested, check lockfile
    if (requestedRange) {
      const lock = LockfileManager.read(projectRoot);
      if (!lock?.packages) {
        return false;
      }

      const installedVersion = lock.packages[packageName]?.version;
      if (!installedVersion) {
        return false;
      }

      // Check if installed version satisfies the requested range
      const semver = await import('semver');
      return semver.satisfies(installedVersion, requestedRange);
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Update manifest file with a new dependency (idempotent)
 */
async function updateManifestWithDependency(
  projectRoot: string,
  packageName: string,
  versionRange: string,
): Promise<void> {
  await addOrUpdateDependency(projectRoot, packageName, versionRange);
}

/**
 * Auto-install a package if it's not already installed
 */
async function autoInstallPackage(
  ctx: CLIContext,
  projectRoot: string,
  packageName: string,
  versionRange: string,
): Promise<void> {
  ctx.logger.info(`Package ${packageName} not installed, installing...`);

  // Resolve dependencies
  const existingLock = LockfileManager.read(projectRoot);
  const resolver = new DependencyResolver(ctx.registry, {
    lockfile: existingLock,
    logger: ctx.logger,
  });

  // Check if yanked
  const versionsInfo = await ctx.registry.getPackageVersions(packageName);
  const exact = versionsInfo.versions[versionRange];
  if (exact && exact.yanked) {
    throw new TerrazulError(
      ErrorCode.VERSION_YANKED,
      `Version ${versionRange} of ${packageName} is yanked`,
    );
  }

  const { resolved, warnings } = await resolver.resolve({
    [packageName]: versionRange,
  });
  for (const w of warnings) ctx.logger.warn(w);

  // Install each resolved package
  const updates: Record<string, ReturnType<typeof LockfileManager.merge>['packages'][string]> = {};
  const packageManager = new PackageManager(ctx);

  for (const [pkgName, info] of resolved) {
    ctx.logger.info(`Installing ${pkgName}@${info.version} ...`);

    const { integrity } = await packageManager.installSinglePackage(
      projectRoot,
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
  }

  // Update lockfile
  const updated = LockfileManager.merge(existingLock, updates);
  LockfileManager.write(updated, projectRoot);

  // Update manifest
  await updateManifestWithDependency(projectRoot, packageName, versionRange);

  ctx.logger.info('Installation complete');
}

/**
 * Validate a local package directory
 */
async function validateLocalPackage(packagePath: string): Promise<{
  name: string;
  version: string;
}> {
  // Check directory exists
  try {
    const stats = await fs.stat(packagePath);
    if (!stats.isDirectory()) {
      throw new TerrazulError(ErrorCode.INVALID_PACKAGE, `Path is not a directory: ${packagePath}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new TerrazulError(
        ErrorCode.PACKAGE_NOT_FOUND,
        `Package directory not found: ${packagePath}`,
      );
    }
    throw error;
  }

  // Read and validate manifest
  const manifest = await readManifest(packagePath);
  if (!manifest || !manifest.package?.name || !manifest.package?.version) {
    throw new TerrazulError(
      ErrorCode.INVALID_PACKAGE,
      `Invalid package: agents.toml must contain [package] with name and version`,
    );
  }

  return {
    name: manifest.package.name,
    version: manifest.package.version,
  };
}

/**
 * Setup local package for rendering (create agent_modules entry)
 */
async function setupLocalPackage(
  ctx: CLIContext,
  projectRoot: string,
  localPath: string,
): Promise<{ packageName: string; version: string }> {
  const validated = await validateLocalPackage(localPath);
  const packageName = validated.name;

  ctx.logger.info(`Using local package ${packageName}@${validated.version} from ${localPath}`);

  // Create agent_modules directory for this package
  const linkPath = agentModulesPath(projectRoot, packageName);
  ensureDir(path.dirname(linkPath));
  ensureDir(linkPath);

  return { packageName, version: validated.version };
}

/**
 * Report rendering results to the logger
 */
function reportRenderResults(
  logger: CLIContext['logger'],
  result: Awaited<ReturnType<typeof planAndRender>>,
): void {
  logger.info(`run: wrote ${result.written.length} files`);

  // In verbose mode, show each written file
  if (logger.isVerbose() && result.written.length > 0) {
    for (const file of result.written) {
      logger.debug(`  rendered: ${file}`);
    }
  }

  if (result.skipped.length > 0) {
    logger.info(`run: skipped ${result.skipped.length} files (already exist)`);
  }
  if (result.backedUp.length > 0) {
    for (const b of result.backedUp) logger.info(`backup: ${b}`);
  }
}

/**
 * Resolved package information
 */
interface ResolvedPackage {
  packageName: string;
  source: 'filesystem' | 'registry';
  localPath?: string;
  versionRange?: string;
}

/**
 * Resolve package specification to determine source and metadata
 */
async function resolvePackageSpec(
  ctx: CLIContext,
  projectRoot: string,
  specArg: string | undefined,
): Promise<ResolvedPackage | null> {
  if (!specArg) {
    return null;
  }

  // Check if it's a filesystem path
  if (isFilesystemPath(specArg)) {
    const resolvedPath = resolvePathSpec(specArg);
    const result = await setupLocalPackage(ctx, projectRoot, resolvedPath);

    ctx.logger.info(`Running local package ${result.packageName} from ${resolvedPath}`);

    return {
      packageName: result.packageName,
      source: 'filesystem',
      localPath: resolvedPath,
    };
  }

  // Handle as package spec
  const parsed = parseSpec(specArg);

  if (!parsed) {
    // No version specified, treat as package name only
    return {
      packageName: specArg,
      source: 'registry',
    };
  }

  return {
    packageName: parsed.name,
    source: 'registry',
    versionRange: parsed.range,
  };
}

/**
 * Ensure package is installed, auto-installing if needed
 */
async function ensurePackageInstalled(
  ctx: CLIContext,
  projectRoot: string,
  resolved: ResolvedPackage,
): Promise<void> {
  // Skip if filesystem source (already setup)
  if (resolved.source === 'filesystem') {
    return;
  }

  // Check if package is installed
  const installed = await isPackageInstalled(
    projectRoot,
    resolved.packageName,
    resolved.versionRange,
  );

  // Auto-install if not present
  if (!installed) {
    await autoInstallPackage(ctx, projectRoot, resolved.packageName, resolved.versionRange ?? '*');
  }
}

/**
 * Options for template rendering
 */
interface RenderingOptions {
  /** Resolved tool type for rendering (from resolveSpawnTool) */
  resolvedTool: 'claude' | 'codex' | 'gemini';
  toolSafeMode: boolean;
  force: boolean;
  localPackagePaths?: Map<string, string>;
}

/**
 * Prepare rendering options from command options and resolved package.
 * NOTE: resolvedToolType should be obtained from resolveSpawnTool to ensure
 * consistent tool selection between rendering and spawning.
 */
function prepareRenderingOptions(
  opts: { toolSafeMode?: boolean; force?: boolean },
  resolved: ResolvedPackage | null,
  resolvedToolType: 'claude' | 'codex' | 'gemini',
): RenderingOptions {
  const toolSafeMode = opts.toolSafeMode ?? true;

  // Local packages should always force re-render to reflect latest changes
  const force = opts.force ?? (resolved?.source === 'filesystem' ? true : false);

  // Prepare local package paths map if we have a local package
  const localPackagePaths =
    resolved?.source === 'filesystem' && resolved.packageName
      ? new Map([[resolved.packageName, resolved.localPath!]])
      : undefined;

  return {
    resolvedTool: resolvedToolType,
    toolSafeMode,
    force,
    localPackagePaths,
  };
}

/**
 * Execute template rendering with progress tracking
 */
async function executeRendering(
  ctx: CLIContext,
  projectRoot: string,
  agentModulesRoot: string,
  packageName: string | undefined,
  profileName: string | undefined,
  renderOpts: RenderingOptions,
): Promise<Awaited<ReturnType<typeof planAndRender>>> {
  // Create spinner manager for askAgent progress
  const spinner = createSpinnerManager(ctx);

  try {
    // Render templates
    const result = await planAndRender(projectRoot, agentModulesRoot, {
      dryRun: false,
      force: renderOpts.force,
      packageName,
      profileName,
      tool: renderOpts.resolvedTool,
      toolSafeMode: renderOpts.toolSafeMode,
      verbose: ctx.logger.isVerbose(),
      onSnippetEvent: spinner.onSnippetEvent,
      localPackagePaths: renderOpts.localPackagePaths,
    });

    // Cleanup spinner and report results
    spinner.cleanup();
    reportRenderResults(ctx.logger, result);

    return result;
  } catch (error) {
    // Ensure spinner cleanup on error
    spinner.cleanup();
    throw error;
  }
}

/**
 * Inject @-mentions into CLAUDE.md and AGENTS.md
 */
async function handleContextInjection(
  ctx: CLIContext,
  projectRoot: string,
  renderResult: Awaited<ReturnType<typeof planAndRender>>,
): Promise<void> {
  // Skip if no package files to inject
  if (!renderResult.packageFiles || renderResult.packageFiles.size === 0) {
    return;
  }

  // Build PackageInfo array from packageFiles
  const packageInfos: PackageInfo[] = [];
  for (const [pkgName, files] of renderResult.packageFiles) {
    if (files.length > 0) {
      const pkgRoot = agentModulesPath(projectRoot, pkgName);
      const manifest = await readManifest(pkgRoot);
      packageInfos.push({
        name: pkgName,
        version: manifest?.package?.version,
        root: pkgRoot,
      });
    }
  }

  // Inject into CLAUDE.md
  const claudeMd = path.join(projectRoot, 'CLAUDE.md');
  const claudeResult = await injectPackageContext(
    claudeMd,
    projectRoot,
    renderResult.packageFiles,
    packageInfos,
  );

  if (claudeResult.modified) {
    ctx.logger.info('Injected package context into CLAUDE.md');
    if (ctx.logger.isVerbose() && claudeResult.content) {
      const lines = claudeResult.content.split('\n');
      const beginIdx = lines.findIndex((l) => l.includes('terrazul:begin'));
      if (beginIdx >= 0) {
        const endIdx = lines.findIndex((l) => l.includes('terrazul:end'));
        if (endIdx > beginIdx) {
          ctx.logger.debug('  Injected content:');
          for (let i = beginIdx; i <= endIdx && i < beginIdx + 10; i++) {
            ctx.logger.debug(`    ${lines[i]}`);
          }
        }
      }
    }
  }

  // Inject into AGENTS.md
  const agentsMd = path.join(projectRoot, 'AGENTS.md');
  const agentsResult = await injectPackageContext(
    agentsMd,
    projectRoot,
    renderResult.packageFiles,
    packageInfos,
  );

  if (agentsResult.modified) {
    ctx.logger.info('Injected package context into AGENTS.md');
    if (ctx.logger.isVerbose() && agentsResult.content) {
      const lines = agentsResult.content.split('\n');
      const beginIdx = lines.findIndex((l) => l.includes('terrazul:begin'));
      if (beginIdx >= 0) {
        const endIdx = lines.findIndex((l) => l.includes('terrazul:end'));
        if (endIdx > beginIdx) {
          ctx.logger.debug('  Injected content:');
          for (let i = beginIdx; i <= endIdx && i < beginIdx + 10; i++) {
            ctx.logger.debug(`    ${lines[i]}`);
          }
        }
      }
    }
  }

  // Log @-mentions in verbose mode
  if (ctx.logger.isVerbose()) {
    for (const [pkgName, files] of renderResult.packageFiles) {
      if (files.length > 0) {
        ctx.logger.debug(`  ${pkgName}: ${files.length} file(s) rendered`);
        for (const file of files) {
          const relPath = path.relative(projectRoot, file);
          ctx.logger.debug(`    ${relPath}`);
        }
      }
    }
  }
}

/**
 * Create symlinks for operational files (agents/, commands/, hooks/, skills/, prompts/)
 * Routes each file to its correct tool directory based on file.tool property
 *
 * @param exclusive - When true, removes symlinks from packages NOT in the target list.
 *                    Use this for specific package runs or profile runs.
 * @param codexHome - Optional custom CODEX_HOME for routing Codex prompts.
 */
async function handleSymlinkCreation(
  ctx: CLIContext,
  projectRoot: string,
  packages: string[],
  renderedFiles: Awaited<ReturnType<typeof planAndRender>>['renderedFiles'],
  exclusive: boolean = false,
  codexHome?: string,
): Promise<void> {
  // Skip if no packages
  if (packages.length === 0) {
    return;
  }

  const symlinkResult = await createSymlinks({
    projectRoot,
    packages,
    renderedFiles,
    exclusive,
    codexHome,
  });

  // Log removed symlinks (exclusive mode)
  if (symlinkResult.removed.length > 0) {
    ctx.logger.info(
      `Removed ${symlinkResult.removed.length} symlink(s) from other packages (exclusive mode)`,
    );
    if (ctx.logger.isVerbose()) {
      for (const link of symlinkResult.removed) {
        const relPath = path.relative(projectRoot, link);
        ctx.logger.debug(`  removed: ${relPath}`);
      }
    }
  }

  // Log created symlinks
  if (symlinkResult.created.length > 0) {
    ctx.logger.info(`Created ${symlinkResult.created.length} symlink(s)`);
    if (ctx.logger.isVerbose()) {
      for (const link of symlinkResult.created) {
        const relPath = path.relative(projectRoot, link);
        ctx.logger.debug(`  ${relPath}`);
      }
    }
  }

  // Log errors
  if (symlinkResult.errors.length > 0) {
    for (const err of symlinkResult.errors) {
      ctx.logger.warn(`Failed to create symlink: ${err.path} - ${err.error}`);
    }
  }
}

/**
 * Result of MCP config preparation
 */
interface MCPConfigResult {
  configPath: string;
  serverCount: number;
}

/**
 * Aggregate MCP configs and generate temporary config file
 */
async function prepareMCPConfig(
  ctx: CLIContext,
  projectRoot: string,
  agentModulesRoot: string,
  packages: string[],
): Promise<MCPConfigResult> {
  // Aggregate MCP configs from all rendered packages (may be empty)
  const mcpConfig =
    packages.length > 0
      ? await aggregateMCPConfigs(projectRoot, packages, { agentModulesRoot, ctx })
      : { mcpServers: {} };

  // Ensure .terrazul directory exists
  const terrazulDir = path.join(projectRoot, '.terrazul');
  ensureDir(terrazulDir);

  // Generate temporary MCP config file
  const mcpConfigPath = path.join(terrazulDir, 'mcp-config.json');
  await generateMCPConfigFile(mcpConfigPath, mcpConfig);

  return {
    configPath: mcpConfigPath,
    serverCount: Object.keys(mcpConfig.mcpServers).length,
  };
}

/**
 * Spawn the resolved tool with MCP config or skip in non-interactive mode.
 * The tool spec should be pre-resolved using resolveSpawnTool to ensure
 * consistent tool selection between rendering and spawning.
 *
 * @param prompt - If provided, runs in headless mode (Claude only)
 * @param codexHome - Optional CODEX_HOME path for Codex sessions
 */
async function spawnToolWithConfig(
  ctx: CLIContext,
  projectRoot: string,
  mcpResult: MCPConfigResult,
  tool: ToolSpec,
  prompt?: string,
  codexHome?: string,
): Promise<number> {
  const isHeadless = !!prompt;

  // Skip spawning tool in non-interactive environments (tests, CI)
  // unless running in headless mode
  const skipSpawn = !isHeadless && (process.env.TZ_SKIP_SPAWN === 'true' || !process.stdout.isTTY);

  if (skipSpawn) {
    ctx.logger.info(
      `Rendered templates with ${mcpResult.serverCount} MCP server(s). Skipping tool launch (non-interactive).`,
    );
    return 0;
  }

  // Get model from user config
  const userConfig = await ctx.config.load();
  const claudeTool = userConfig.profile?.tools?.find((t) => t.type === 'claude');
  const model = claudeTool?.model;

  // Handle headless mode (Claude only)
  if (isHeadless) {
    if (tool.type !== 'claude') {
      throw new TerrazulError(
        ErrorCode.CONFIG_INVALID,
        `Headless mode (-p/--prompt) is only supported for Claude, not ${tool.type}`,
      );
    }
    ctx.logger.info('Running Claude Code in headless mode...');
    return spawnClaudeCodeHeadless(mcpResult.configPath, prompt, projectRoot, model, ctx.logger);
  }

  // Log launch message
  if (mcpResult.serverCount > 0) {
    ctx.logger.info(`Launching ${tool.type} with ${mcpResult.serverCount} MCP server(s)...`);
  } else {
    ctx.logger.info(`Launching ${tool.type}...`);
  }

  // Load MCP config content for Codex (Claude uses file path)
  const mcpConfig = await loadMCPConfig(mcpResult.configPath);

  // Spawn the tool with MCP config (and CODEX_HOME for Codex)
  const exitCode = await spawnTool({
    tool,
    cwd: projectRoot,
    mcpConfig,
    mcpConfigPath: mcpResult.configPath,
    codexHome,
  });

  return exitCode;
}

/**
 * Discover packages to use for MCP config aggregation
 */
async function discoverPackagesForMCP(
  projectRoot: string,
  packageName?: string,
  profileName?: string,
): Promise<string[]> {
  const agentModulesRoot = path.join(projectRoot, 'agent_modules');

  // If specific package specified, use only that
  if (packageName) {
    return [packageName];
  }

  // If profile specified, get packages from manifest
  if (profileName) {
    const manifest = await readManifest(projectRoot);
    if (manifest?.profiles?.[profileName]) {
      return manifest.profiles[profileName];
    }
    return [];
  }

  // Otherwise, discover all installed packages
  try {
    const entries = await fs.readdir(agentModulesRoot, { withFileTypes: true });
    const packages: string[] = [];

    for (const entry of entries) {
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        if (entry.name.startsWith('@')) {
          // Scoped package, need to read subdirectories
          const scopedPath = path.join(agentModulesRoot, entry.name);
          const scopedEntries = await fs.readdir(scopedPath, { withFileTypes: true });
          for (const scopedEntry of scopedEntries) {
            if (scopedEntry.isDirectory() || scopedEntry.isSymbolicLink()) {
              packages.push(`${entry.name}/${scopedEntry.name}`);
            }
          }
        } else {
          packages.push(entry.name);
        }
      }
    }

    return packages;
  } catch {
    return [];
  }
}

/**
 * Create a spinner manager for askAgent progress tracking
 */
function createSpinnerManager(ctx: CLIContext) {
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

  const onSnippetEvent = ({ event }: SnippetProgress): void => {
    switch (event.type) {
      case 'askAgent:start': {
        const taskId = event.snippet.id;

        if (activeTasks.has(taskId)) {
          if (ctx.logger.isVerbose()) {
            ctx.logger.info(`[run] Skipping duplicate askAgent task: ${taskId}`);
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

          generateAskAgentSummary(event.prompt)
            .then((summary) => {
              const existingTask = activeTasks.get(taskId);
              if (existingTask && existingTask.status === 'running') {
                existingTask.title = summary;
                renderSpinner();
              }
              return summary;
            })
            .catch(() => {
              // Silently fail - keep generic "Processing..." title
            });
        } else {
          ctx.logger.info('Running askAgent snippet...');
        }
        break;
      }
      case 'askAgent:end': {
        const taskId = event.snippet.id;
        const task = activeTasks.get(taskId);

        if (task) {
          task.status = 'complete';
          if (isTTY) {
            renderSpinner();
          } else {
            ctx.logger.info('askAgent complete.');
          }
        } else if (!isTTY) {
          ctx.logger.info('askAgent complete.');
        }
        break;
      }
      case 'askAgent:error': {
        const taskId = event.snippet.id;
        const task = activeTasks.get(taskId);

        if (task) {
          task.status = 'error';
          task.error = event.error.message;
          if (isTTY) {
            renderSpinner();
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

  const cleanup = (): void => {
    if (inkInstance !== null) {
      const instance: Instance = inkInstance;
      instance.unmount();
      inkInstance = null;
    }
  };

  return { onSnippetEvent, cleanup };
}

export function registerRunCommand(
  program: Command,
  createCtx: (opts: { verbose?: boolean }) => CLIContext,
): void {
  program
    .command('run')
    .argument('[package]', 'Package spec like @scope/name@1.0.0 (will auto-install if needed)')
    .description('Install (if needed), render templates, and execute with Claude Code')
    .option('--profile <profile>', 'Limit execution to the packages under the given profile')
    .option('--tool <tool>', 'Use a specific answer tool (claude or codex)')
    .option('--no-tool-safe-mode', 'Disable safe mode for tool execution')
    .option('--force', 'Force re-rendering even if files already exist')
    .option('-p, --prompt <prompt>', 'Run in headless mode with the given prompt')
    .action(
      async (
        _pkg: string | undefined,
        opts: {
          profile?: string;
          tool?: string;
          toolSafeMode?: boolean;
          force?: boolean;
          prompt?: string;
        },
      ) => {
        const globalOpts = program.opts<{ verbose?: boolean }>();
        const ctx = createCtx({ verbose: globalOpts.verbose });
        const projectRoot = process.cwd();
        const agentModulesRoot = path.join(projectRoot, 'agent_modules');
        const profileName = typeof opts.profile === 'string' ? opts.profile.trim() : undefined;

        try {
          // Validate arguments
          if (_pkg && profileName) {
            ctx.logger.error('Cannot combine package argument with --profile');
            process.exitCode = 1;
            return;
          }

          // Resolve package spec (filesystem vs registry)
          const resolved = await resolvePackageSpec(ctx, projectRoot, _pkg);

          // Ensure package is installed (auto-install if needed)
          if (resolved) {
            await ensurePackageInstalled(ctx, projectRoot, resolved);
          }

          // Extract values for downstream use
          const packageName = resolved?.packageName;

          // Resolve tool ONCE using precedence: CLI flag > project manifest > user config
          // This ensures consistent tool selection between rendering and spawning
          const userConfig = await ctx.config.load();
          const toolSpec = await resolveSpawnTool({
            flagOverride: normalizeToolOption(opts.tool),
            projectRoot,
            userConfig,
          });

          // Prepare rendering options using the resolved tool
          const renderOpts = prepareRenderingOptions(opts, resolved, toolSpec.type);

          // Execute rendering with progress tracking
          const result = await executeRendering(
            ctx,
            projectRoot,
            agentModulesRoot,
            packageName,
            profileName,
            renderOpts,
          );

          // Inject package context into CLAUDE.md and AGENTS.md
          await handleContextInjection(ctx, projectRoot, result);

          // Discover packages for rendering, symlinks, and MCP config
          const packages = await discoverPackagesForMCP(projectRoot, packageName, profileName);

          // Determine exclusive mode: when a specific package or profile is specified,
          // only those package's symlinks should be present (remove others)
          const exclusiveMode = Boolean(packageName || profileName);

          // Prepare MCP config
          const mcpResult = await prepareMCPConfig(ctx, projectRoot, agentModulesRoot, packages);

          // Create Codex session for user-level files (prompts, config, trust)
          let codexSession: CodexSessionConfig | undefined;
          if (toolSpec.type === 'codex') {
            const mcpConfig = await loadMCPConfig(mcpResult.configPath);
            codexSession = await createCodexSession(projectRoot, mcpConfig.mcpServers);
          }

          try {
            // Create symlinks for operational files
            // Pass codexHome for Codex prompts routing
            await handleSymlinkCreation(
              ctx,
              projectRoot,
              packages,
              result.renderedFiles,
              exclusiveMode,
              codexSession?.tempCodexHome,
            );

            // Spawn tool (with cleanup) - uses the same resolved tool spec
            const exitCode = await spawnToolWithConfig(
              ctx,
              projectRoot,
              mcpResult,
              toolSpec,
              opts.prompt,
              codexSession?.tempCodexHome,
            );
            process.exitCode = exitCode;
          } finally {
            // Clean up MCP config
            await cleanupMCPConfig(mcpResult.configPath);
            // Clean up Codex session (persists trust settings)
            if (codexSession) {
              await cleanupCodexSession(codexSession);
            }
          }
        } catch (error) {
          const err = error as TerrazulError | Error;
          ctx.logger.error(
            err instanceof TerrazulError ? err.toUserMessage() : String(err.message || err),
          );
          process.exitCode = err instanceof TerrazulError ? err.getExitCode() : 1;
        }
      },
    );
}
