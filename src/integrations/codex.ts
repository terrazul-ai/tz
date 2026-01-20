/**
 * Codex Integration
 *
 * Provides integration with OpenAI Codex CLI, including:
 * - CLI detection
 * - CODEX_HOME isolation for session-specific config
 * - MCP config aggregation and TOML generation
 * - Prompts and skills symlinking
 * - Session management
 */

import { exec as execCallback, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import TOML from '@iarna/toml';

import { ErrorCode, TerrazulError } from '../core/errors.js';
import { LockfileManager } from '../core/lock-file.js';
import { StorageManager } from '../core/storage.js';
import { createSymlink } from '../utils/fs.js';

import type { CLIContext } from '../utils/context.js';

const exec = promisify(execCallback);

/**
 * Filename for tz-specific Codex trust settings
 */
const TZ_CODEX_TRUST_FILE = 'codex-trust.toml';

/**
 * Get the user's home directory, respecting HOME env variable
 * os.homedir() caches the result and doesn't update when HOME changes,
 * so we check the env variable directly for testability.
 */
function getHomedir(): string {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

/**
 * Project trust configuration structure
 */
interface CodexProjectTrust {
  trust_level: string;
}

/**
 * Full Codex config structure (subset we care about)
 */
interface CodexConfig {
  projects?: Record<string, CodexProjectTrust>;
  mcp_servers?: Record<string, CodexMCPServerConfig>;
  [key: string]: unknown;
}

/**
 * MCP server configuration for Codex (TOML format)
 */
export interface CodexMCPServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/**
 * Codex MCP configuration structure
 */
export interface CodexMCPConfig {
  mcp_servers: Record<string, CodexMCPServerConfig>;
}

/**
 * Session configuration for isolated CODEX_HOME
 */
export interface CodexSessionConfig {
  tempCodexHome: string;
  configPath: string;
  promptsDir: string;
  skillsDir: string;
}

/**
 * Detect if Codex CLI is available in the system PATH
 */
export async function detectCodexCLI(): Promise<boolean> {
  try {
    await exec('codex --version');
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the default CODEX_HOME directory
 * Respects CODEX_HOME environment variable, defaults to ~/.codex/
 */
export function getCodexHome(): string {
  if (process.env.CODEX_HOME) {
    return process.env.CODEX_HOME;
  }
  return path.join(getHomedir(), '.codex');
}

/**
 * Get path to tz-specific Codex trust file
 * Stored in ~/.terrazul/codex-trust.toml
 */
export function getTzCodexTrustPath(): string {
  return path.join(getHomedir(), '.terrazul', TZ_CODEX_TRUST_FILE);
}

/**
 * Read tz-specific Codex trust settings
 * Returns empty object if file doesn't exist or can't be parsed
 */
export async function readTzCodexTrust(): Promise<Record<string, CodexProjectTrust>> {
  const trustPath = getTzCodexTrustPath();
  try {
    const content = await fs.readFile(trustPath, 'utf8');
    const parsed = TOML.parse(content) as { projects?: Record<string, CodexProjectTrust> };
    return parsed.projects || {};
  } catch {
    return {};
  }
}

/**
 * Write tz-specific Codex trust settings
 * Creates parent directory if needed
 */
export async function writeTzCodexTrust(
  projects: Record<string, CodexProjectTrust>,
): Promise<void> {
  const trustPath = getTzCodexTrustPath();
  await fs.mkdir(path.dirname(trustPath), { recursive: true });
  const content = TOML.stringify({ projects } as unknown as TOML.JsonMap);
  await fs.writeFile(trustPath, content, 'utf8');
}

/**
 * Read user's existing Codex config.toml
 * Returns empty object if file doesn't exist or can't be parsed
 */
async function readUserCodexConfig(): Promise<CodexConfig> {
  const userCodexHome = getCodexHome();
  const userConfigPath = path.join(userCodexHome, 'config.toml');
  try {
    const content = await fs.readFile(userConfigPath, 'utf8');
    return TOML.parse(content) as CodexConfig;
  } catch {
    return {};
  }
}

/**
 * Aggregate MCP server configs from multiple packages for Codex
 * Reads TOML configs from packages and merges them
 *
 * Checks multiple locations in priority order:
 * 1. agent_modules/<pkg>/codex/mcp_servers.toml (rendered template)
 * 2. <storePath>/codex/mcp_servers.toml (static from tarball)
 */
export async function aggregateCodexMCPConfigs(
  projectRoot: string,
  packageNames: string[],
  options?: { storeDir?: string; agentModulesRoot?: string; ctx?: CLIContext },
): Promise<CodexMCPConfig> {
  const aggregated: CodexMCPConfig = {
    mcp_servers: {},
  };

  const lockfile = LockfileManager.read(projectRoot);
  const storage = new StorageManager(options?.storeDir ? { storeDir: options.storeDir } : {});
  const agentModulesRoot = options?.agentModulesRoot ?? path.join(projectRoot, 'agent_modules');
  const ctx = options?.ctx;

  for (const pkgName of packageNames) {
    try {
      // Try multiple config locations in priority order
      const configPaths = [
        // 1. Rendered template in codex/ subdirectory
        path.join(agentModulesRoot, pkgName, 'codex', 'mcp_servers.toml'),
      ];

      // 2. Static config in store (fallback)
      const lockEntry = lockfile?.packages[pkgName];
      if (lockEntry) {
        const storePath = storage.getPackagePath(pkgName, lockEntry.version);
        configPaths.push(path.join(storePath, 'codex', 'mcp_servers.toml'));
      }

      // Find first existing config
      let mcpConfigPath: string | null = null;
      for (const configPath of configPaths) {
        try {
          await fs.access(configPath);
          mcpConfigPath = configPath;
          break;
        } catch {
          continue;
        }
      }

      // No MCP config for this package, skip
      if (!mcpConfigPath) {
        if (ctx?.logger.isVerbose()) {
          ctx.logger.debug(`No Codex MCP config found for ${pkgName}`);
        }
        continue;
      }

      // Read and parse TOML config
      const content = await fs.readFile(mcpConfigPath, 'utf8');
      const config = TOML.parse(content) as unknown as CodexMCPConfig;

      if (!config.mcp_servers || typeof config.mcp_servers !== 'object') {
        const relPath = path.relative(projectRoot, mcpConfigPath);
        ctx?.logger.warn(
          `Package ${pkgName} has Codex MCP config at ${relPath} but it's missing the 'mcp_servers' table.\n` +
            `Expected format: [mcp_servers.server-name]\\ncommand = "..."\\nargs = [...]`,
        );
        continue;
      }

      // Merge servers, checking for duplicates
      const serverCount = Object.keys(config.mcp_servers).length;
      if (ctx?.logger.isVerbose()) {
        ctx.logger.debug(`Found ${serverCount} Codex MCP server(s) in ${pkgName}`);
      }

      for (const [serverName, serverConfig] of Object.entries(config.mcp_servers)) {
        if (aggregated.mcp_servers[serverName]) {
          throw new TerrazulError(
            ErrorCode.CONFIG_INVALID,
            `Duplicate MCP server name '${serverName}' found in package ${pkgName}`,
          );
        }
        aggregated.mcp_servers[serverName] = serverConfig;
      }
    } catch (error) {
      if (error instanceof TerrazulError) {
        throw error;
      }
      // Re-throw TOML parse errors or other issues
      throw new TerrazulError(
        ErrorCode.CONFIG_INVALID,
        `Failed to read Codex MCP config from ${pkgName}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return aggregated;
}

/**
 * Generate Codex config.toml file at specified path
 */
export async function generateCodexConfigFile(
  configPath: string,
  config: CodexMCPConfig,
): Promise<void> {
  // Ensure parent directory exists
  const dir = path.dirname(configPath);
  await fs.mkdir(dir, { recursive: true });

  // Write config as TOML
  const tomlContent = TOML.stringify(config as unknown as TOML.JsonMap);
  await fs.writeFile(configPath, tomlContent, 'utf8');
}

/**
 * Clean up temporary Codex session directory
 * Before cleanup, extracts and persists any new project trust settings to ~/.terrazul/codex-trust.toml
 */
export async function cleanupCodexSession(session: CodexSessionConfig): Promise<void> {
  try {
    // Before cleanup, extract and persist any new project trust settings
    const tempConfigPath = path.join(session.tempCodexHome, 'config.toml');

    try {
      const content = await fs.readFile(tempConfigPath, 'utf8');
      const tempConfig = TOML.parse(content) as CodexConfig;

      if (tempConfig.projects && Object.keys(tempConfig.projects).length > 0) {
        // Merge with existing tz trust (session trust takes precedence)
        const existingTrust = await readTzCodexTrust();
        const mergedTrust: Record<string, CodexProjectTrust> = {
          ...existingTrust,
          ...tempConfig.projects,
        };
        await writeTzCodexTrust(mergedTrust);
      }
    } catch {
      // Config doesn't exist or can't be read, skip trust persistence
    }

    // Clean up temp directory
    await fs.rm(session.tempCodexHome, { recursive: true, force: true });
  } catch {
    // Ignore errors if directory doesn't exist
  }
}

/**
 * Symlink prompts from packages to temp CODEX_HOME/prompts/
 */
async function symlinkCodexPrompts(
  packages: string[],
  agentModulesRoot: string,
  targetPromptsDir: string,
): Promise<void> {
  for (const pkgName of packages) {
    // Check multiple source locations
    const sourcePaths = [
      path.join(agentModulesRoot, pkgName, 'codex', 'prompts'),
      path.join(agentModulesRoot, pkgName, 'prompts'),
    ];

    for (const sourcePath of sourcePaths) {
      try {
        const stats = await fs.stat(sourcePath);
        if (stats.isDirectory()) {
          // Read prompt files and symlink each one with namespaced name
          const entries = await fs.readdir(sourcePath, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.isFile() && entry.name.endsWith('.md')) {
              const normalizedPkg = pkgName.replaceAll('/', '-');
              const namespacedName = `${normalizedPkg}-${entry.name}`;
              const sourceFull = path.join(sourcePath, entry.name);
              const targetFull = path.join(targetPromptsDir, namespacedName);

              try {
                await createSymlink(sourceFull, targetFull);
              } catch {
                // Symlink may already exist, ignore
              }
            }
          }
          break; // Found prompts, stop searching
        }
      } catch {
        // Source doesn't exist, try next location
        continue;
      }
    }
  }
}

/**
 * Symlink skills from packages to temp CODEX_HOME/skills/
 */
async function symlinkCodexSkills(
  packages: string[],
  agentModulesRoot: string,
  targetSkillsDir: string,
): Promise<void> {
  for (const pkgName of packages) {
    // Check multiple source locations
    const sourcePaths = [
      path.join(agentModulesRoot, pkgName, 'codex', 'skills'),
      path.join(agentModulesRoot, pkgName, 'skills'),
    ];

    for (const sourcePath of sourcePaths) {
      try {
        const stats = await fs.stat(sourcePath);
        if (stats.isDirectory()) {
          // Read skill directories and symlink each one with namespaced name
          const entries = await fs.readdir(sourcePath, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.isDirectory()) {
              const normalizedPkg = pkgName.replaceAll('/', '-');
              const namespacedName = `${normalizedPkg}-${entry.name}`;
              const sourceFull = path.join(sourcePath, entry.name);
              const targetFull = path.join(targetSkillsDir, namespacedName);

              try {
                await createSymlink(sourceFull, targetFull);
              } catch {
                // Symlink may already exist, ignore
              }
            }
          }
          break; // Found skills, stop searching
        }
      } catch {
        // Source doesn't exist, try next location
        continue;
      }
    }
  }
}

/**
 * Create an isolated Codex session with temporary CODEX_HOME
 * Contains MCP config, prompts, and skills for the session
 *
 * Merges configs in priority order (lowest to highest):
 * 1. User's ~/.codex/config.toml (base settings)
 * 2. TZ trust file ~/.terrazul/codex-trust.toml (persisted tz trust)
 * 3. Package MCP servers (current session packages)
 */
export async function createCodexSession(
  projectRoot: string,
  packages: string[],
  agentModulesRoot: string,
  options?: { ctx?: CLIContext },
): Promise<CodexSessionConfig> {
  // Create isolated CODEX_HOME
  const tempCodexHome = path.join(os.tmpdir(), `tz-codex-${Date.now()}`);
  await fs.mkdir(tempCodexHome, { recursive: true });

  const ctx = options?.ctx;

  try {
    // 0. Copy auth.json from user's actual CODEX_HOME to preserve credentials
    const userCodexHome = getCodexHome();
    const userAuthPath = path.join(userCodexHome, 'auth.json');
    const tempAuthPath = path.join(tempCodexHome, 'auth.json');

    try {
      await fs.access(userAuthPath);
      await fs.copyFile(userAuthPath, tempAuthPath);
      if (ctx?.logger.isVerbose()) {
        ctx.logger.debug(`Copied auth credentials from ${userAuthPath}`);
      }
    } catch {
      // No auth.json exists, user will need to authenticate
      if (ctx?.logger.isVerbose()) {
        ctx.logger.debug('No existing Codex auth.json found, authentication may be required');
      }
    }

    // 1. Read user's existing config.toml (preserves model preferences, global MCP servers, etc.)
    const userConfig = await readUserCodexConfig();
    if (ctx?.logger.isVerbose() && Object.keys(userConfig).length > 0) {
      ctx.logger.debug(`Loaded user Codex config with keys: ${Object.keys(userConfig).join(', ')}`);
    }

    // 2. Read tz-specific trust settings (persisted from previous tz sessions)
    const tzTrust = await readTzCodexTrust();
    if (ctx?.logger.isVerbose() && Object.keys(tzTrust).length > 0) {
      ctx.logger.debug(
        `Loaded ${Object.keys(tzTrust).length} project trust setting(s) from tz trust file`,
      );
    }

    // 3. Aggregate package MCP configs
    const packageMcpConfig = await aggregateCodexMCPConfigs(projectRoot, packages, {
      agentModulesRoot,
      ctx,
    });

    // 4. Merge all configs (priority: user < tz trust < package MCP servers)
    const userProjects = userConfig.projects || {};
    const userMcpServers = userConfig.mcp_servers || {};

    const mergedConfig: CodexConfig = {
      ...userConfig,
      projects: {
        ...userProjects,
        ...tzTrust, // tz trust overrides user (more recent)
      },
      mcp_servers: {
        ...userMcpServers,
        ...packageMcpConfig.mcp_servers, // package servers added/override
      },
    };

    // 5. Write merged config
    const configPath = path.join(tempCodexHome, 'config.toml');
    const tomlContent = TOML.stringify(mergedConfig as TOML.JsonMap);
    await fs.writeFile(configPath, tomlContent, 'utf8');

    if (ctx?.logger.isVerbose()) {
      ctx.logger.debug(`Created merged Codex config at ${configPath}`);
    }

    // 6. Symlink prompts from packages to temp prompts/
    const promptsDir = path.join(tempCodexHome, 'prompts');
    await fs.mkdir(promptsDir, { recursive: true });
    await symlinkCodexPrompts(packages, agentModulesRoot, promptsDir);

    if (ctx?.logger.isVerbose()) {
      ctx.logger.debug(`Created prompts directory at ${promptsDir}`);
    }

    // 7. Symlink skills from packages to temp skills/
    const skillsDir = path.join(tempCodexHome, 'skills');
    await fs.mkdir(skillsDir, { recursive: true });
    await symlinkCodexSkills(packages, agentModulesRoot, skillsDir);

    if (ctx?.logger.isVerbose()) {
      ctx.logger.debug(`Created skills directory at ${skillsDir}`);
    }

    return { tempCodexHome, configPath, promptsDir, skillsDir };
  } catch (error) {
    // Clean up on error
    try {
      await fs.rm(tempCodexHome, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
    throw error;
  }
}

/**
 * Spawn Codex CLI with isolated CODEX_HOME
 */
export async function spawnCodex(
  session: CodexSessionConfig,
  additionalArgs: string[] = [],
  cwd?: string,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const args = [...additionalArgs];
    const workingDir = cwd || process.cwd();

    // Log the full command for debugging
    console.log(`Executing: codex ${args.join(' ')}`);
    console.log(`Working directory: ${workingDir}`);
    console.log(`CODEX_HOME: ${session.tempCodexHome}`);

    const child = spawn('codex', args, {
      cwd: workingDir,
      stdio: 'inherit',
      shell: false,
      env: {
        ...process.env,
        CODEX_HOME: session.tempCodexHome,
      },
    });

    child.on('error', (error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(
          new TerrazulError(
            ErrorCode.TOOL_NOT_FOUND,
            'Codex CLI not found. Install it from https://github.com/openai/codex',
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
 * Get tool-specific operational directories
 */
export function getCodexOperationalDirs(): string[] {
  return ['skills', 'prompts'];
}

/**
 * Get tool-specific target directory for symlinks
 * For Codex, this returns the temp CODEX_HOME directory
 */
export function getCodexTargetDir(tempCodexHome: string): string {
  return tempCodexHome;
}
