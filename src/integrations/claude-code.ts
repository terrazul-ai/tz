import { exec as execCallback, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { ErrorCode, TerrazulError } from '../core/errors.js';
import { LockfileManager } from '../core/lock-file.js';
import { StorageManager } from '../core/storage.js';

import type { CLIContext } from '../utils/context.js';
import type { Logger } from '../utils/logger.js';

const exec = promisify(execCallback);

export interface MCPServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  [key: string]: unknown;
}

export interface MCPConfig {
  mcpServers: Record<string, MCPServerConfig>;
}

/**
 * Detect if Claude CLI is available in the system PATH
 */
export async function detectClaudeCLI(): Promise<boolean> {
  try {
    await exec('claude --version');
    return true;
  } catch {
    return false;
  }
}

/**
 * Aggregate MCP server configs from multiple packages
 * Checks multiple locations in priority order:
 * 1. agent_modules/<pkg>/claude/mcp_servers.json (rendered template)
 * 2. agent_modules/<pkg>/mcp-config.json (legacy rendered)
 * 3. <storePath>/mcp-config.json (static from tarball)
 */
export async function aggregateMCPConfigs(
  projectRoot: string,
  packageNames: string[],
  options?: { storeDir?: string; agentModulesRoot?: string; ctx?: CLIContext },
): Promise<MCPConfig> {
  const aggregated: MCPConfig = {
    mcpServers: {},
  };

  // Read lockfile to get store paths
  const lockfile = LockfileManager.read(projectRoot);
  const storage = new StorageManager(options?.storeDir ? { storeDir: options.storeDir } : {});
  const agentModulesRoot = options?.agentModulesRoot ?? path.join(projectRoot, 'agent_modules');
  const ctx = options?.ctx;

  for (const pkgName of packageNames) {
    try {
      // Try multiple config locations in priority order
      const configPaths = [
        // 1. Rendered template in claude/ subdirectory (new format)
        path.join(agentModulesRoot, pkgName, 'claude', 'mcp_servers.json'),
        // 2. Rendered template at package root (legacy)
        path.join(agentModulesRoot, pkgName, 'mcp-config.json'),
      ];

      // 3. Static config in store (fallback)
      const lockEntry = lockfile?.packages[pkgName];
      if (lockEntry) {
        const storePath = storage.getPackagePath(pkgName, lockEntry.version);
        configPaths.push(path.join(storePath, 'mcp-config.json'));
      }

      // Find first existing config
      let mcpConfigPath: string | null = null;
      for (const configPath of configPaths) {
        try {
          await fs.access(configPath);
          mcpConfigPath = configPath;
          break;
        } catch {
          // Try next path
          continue;
        }
      }

      // No MCP config for this package, skip
      if (!mcpConfigPath) {
        if (ctx?.logger.isVerbose()) {
          ctx.logger.debug(`No MCP config found for ${pkgName}`);
        }
        continue;
      }

      // Read and parse MCP config
      const content = await fs.readFile(mcpConfigPath, 'utf8');
      const config = JSON.parse(content) as MCPConfig;

      if (!config.mcpServers || typeof config.mcpServers !== 'object') {
        const relPath = path.relative(projectRoot, mcpConfigPath);
        ctx?.logger.warn(
          `Package ${pkgName} has MCP config at ${relPath} but it's missing the 'mcpServers' wrapper.\n` +
            `Expected format: { "mcpServers": { "server-name": { "command": "...", "args": [...] } } }`,
        );
        continue;
      }

      // Merge servers, checking for duplicates
      const serverCount = Object.keys(config.mcpServers).length;
      if (ctx?.logger.isVerbose()) {
        ctx.logger.debug(`Found ${serverCount} MCP server(s) in ${pkgName}`);
      }

      for (const [serverName, serverConfig] of Object.entries(config.mcpServers)) {
        if (aggregated.mcpServers[serverName]) {
          ctx?.logger.warn(
            `Duplicate MCP server '${serverName}' in package ${pkgName} (skipped; using earlier definition)`,
          );
          continue;
        }
        aggregated.mcpServers[serverName] = serverConfig;
      }
    } catch (error) {
      if (error instanceof TerrazulError) {
        throw error;
      }
      // Re-throw JSON parse errors or other issues
      throw new TerrazulError(
        ErrorCode.CONFIG_INVALID,
        `Failed to read MCP config from ${pkgName}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return aggregated;
}

/**
 * Generate MCP config file at specified path
 */
export async function generateMCPConfigFile(configPath: string, config: MCPConfig): Promise<void> {
  // Ensure parent directory exists
  const dir = path.dirname(configPath);
  await fs.mkdir(dir, { recursive: true });

  // Write config as JSON
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');
}

/**
 * Clean up temporary MCP config file
 */
export async function cleanupMCPConfig(configPath: string): Promise<void> {
  try {
    await fs.unlink(configPath);
  } catch {
    // Ignore errors if file doesn't exist
  }
}

/**
 * Internal options for spawning Claude Code CLI.
 * Used by both interactive and headless spawn functions.
 */
interface SpawnClaudeOptions {
  /** Path to the MCP configuration file */
  mcpConfigPath: string;
  /** Working directory for the spawned process */
  cwd?: string;
  /** Claude model to use (e.g., 'opus', 'sonnet'). Skipped if 'default'. */
  model?: string;
  /** Additional CLI arguments to pass to claude */
  additionalArgs?: string[];
  /** Optional logger for debug output */
  logger?: Logger;
}

/**
 * Internal helper that spawns Claude Code CLI with the given options.
 * Handles argument building, process spawning, and error mapping.
 *
 * @internal
 */
function spawnClaudeCodeInternal(options: SpawnClaudeOptions): Promise<number> {
  const { mcpConfigPath, cwd, model, additionalArgs = [], logger } = options;

  return new Promise((resolve, reject) => {
    // Build base args: MCP config with strict mode
    const args = ['--mcp-config', mcpConfigPath, '--strict-mcp-config'];

    // Add model flag if specified (skip 'default' to use user's environment preference)
    if (model && model !== 'default') {
      args.push('--model', model);
    }

    // Append any additional arguments
    args.push(...additionalArgs);

    const workingDir = cwd || process.cwd();

    // Log command details at debug level
    logger?.debug(`Spawning claude with args: ${args.join(' ')}`);
    logger?.debug(`Working directory: ${workingDir}`);

    const child = spawn('claude', args, {
      cwd: workingDir,
      stdio: 'inherit',
      shell: false,
    });

    child.on('error', (error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(
          new TerrazulError(
            ErrorCode.TOOL_NOT_FOUND,
            'Claude CLI not found. Install it from https://claude.com/code',
          ),
        );
      } else {
        reject(error);
      }
    });

    child.on('exit', (code) => {
      resolve(code ?? 0);
    });
  });
}

/**
 * Spawn Claude Code CLI in interactive mode with MCP config.
 *
 * Launches the Claude CLI with the specified MCP configuration file,
 * allowing the user to interact with Claude in the terminal.
 *
 * @param mcpConfigPath - Absolute path to the MCP configuration JSON file
 * @param additionalArgs - Additional CLI arguments to pass to claude (e.g., ['--verbose'])
 * @param cwd - Working directory for the spawned process (defaults to process.cwd())
 * @param model - Claude model to use (e.g., 'opus', 'sonnet'). Pass 'default' or omit to use environment preference.
 * @param logger - Optional logger for debug output
 * @returns Promise resolving to the exit code of the claude process
 * @throws {TerrazulError} TOOL_NOT_FOUND if claude CLI is not installed
 *
 * @example
 * ```typescript
 * const exitCode = await spawnClaudeCode('/path/to/mcp-config.json');
 *
 * // With model and logger
 * const exitCode = await spawnClaudeCode(
 *   '/path/to/mcp-config.json',
 *   ['--verbose'],
 *   '/my/project',
 *   'opus',
 *   logger
 * );
 * ```
 */
export async function spawnClaudeCode(
  mcpConfigPath: string,
  additionalArgs: string[] = [],
  cwd?: string,
  model?: string,
  logger?: Logger,
): Promise<number> {
  return spawnClaudeCodeInternal({
    mcpConfigPath,
    cwd,
    model,
    additionalArgs,
    logger,
  });
}

/**
 * Spawn Claude Code CLI in headless mode with a prompt.
 *
 * Runs Claude non-interactively with the given prompt, useful for
 * automation, scripts, and CI/CD pipelines. The prompt is passed
 * via the `-p` flag.
 *
 * @param mcpConfigPath - Absolute path to the MCP configuration JSON file
 * @param prompt - The prompt to send to Claude (passed via -p flag)
 * @param cwd - Working directory for the spawned process (defaults to process.cwd())
 * @param model - Claude model to use (e.g., 'opus', 'sonnet'). Pass 'default' or omit to use environment preference.
 * @param logger - Optional logger for debug output
 * @returns Promise resolving to the exit code of the claude process
 * @throws {TerrazulError} TOOL_NOT_FOUND if claude CLI is not installed
 *
 * @example
 * ```typescript
 * // Basic headless execution
 * const exitCode = await spawnClaudeCodeHeadless(
 *   '/path/to/mcp-config.json',
 *   'List all TypeScript files in the src directory'
 * );
 *
 * // With all options
 * const exitCode = await spawnClaudeCodeHeadless(
 *   '/path/to/mcp-config.json',
 *   'Fix the failing tests',
 *   '/my/project',
 *   'opus',
 *   logger
 * );
 * ```
 */
export async function spawnClaudeCodeHeadless(
  mcpConfigPath: string,
  prompt: string,
  cwd?: string,
  model?: string,
  logger?: Logger,
): Promise<number> {
  return spawnClaudeCodeInternal({
    mcpConfigPath,
    cwd,
    model,
    additionalArgs: ['-p', prompt],
    logger,
  });
}
