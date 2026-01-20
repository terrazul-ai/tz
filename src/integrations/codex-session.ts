/**
 * Codex Session Management
 *
 * Manages Codex sessions with:
 * - Temporary CODEX_HOME for user-level files (prompts)
 * - Trust persistence across sessions
 * - Config merging from user config
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as TOML from '@iarna/toml';

import type { MCPServerConfig } from './claude-code.js';

/**
 * Codex session configuration
 */
export interface CodexSessionConfig {
  /** Temporary CODEX_HOME path (e.g., .terrazul/codex-home/) */
  tempCodexHome: string;
  /** Path to the merged config file */
  configPath: string;
  /** Cleanup function to call when session ends */
  cleanup: () => Promise<void>;
}

/**
 * Trust level for a project
 */
export type TrustLevel = 'trusted' | 'untrusted' | 'ask';

/**
 * Trust entry for a project
 */
export interface TrustEntry {
  trust_level: TrustLevel;
}

/**
 * Structure of the trust file (~/.terrazul/codex-trust.toml)
 */
export interface CodexTrustData {
  projects: Record<string, TrustEntry>;
}

/**
 * Codex config.toml structure (simplified)
 */
export interface CodexConfigData {
  model?: string;
  approval_mode?: string;
  mcp_servers?: Record<string, MCPServerConfig>;
  projects?: Record<string, TrustEntry>;
  [key: string]: unknown;
}

const TRUST_FILE_NAME = 'codex-trust.toml';
const CODEX_CONFIG_FILE = 'config.toml';
const CODEX_AUTH_FILE = 'auth.json';
const TEMP_CODEX_HOME_NAME = 'codex-home';

/**
 * Get the default Codex home directory
 */
function getDefaultCodexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

/**
 * Get the Terrazul config directory
 */
function getTerrazulConfigDir(): string {
  return path.join(os.homedir(), '.terrazul');
}

/**
 * Get the trust file path
 */
export function getTrustFilePath(): string {
  return path.join(getTerrazulConfigDir(), TRUST_FILE_NAME);
}

/**
 * Read the Codex trust file
 */
export async function readTrustFile(): Promise<CodexTrustData> {
  const trustPath = getTrustFilePath();

  try {
    const content = await fs.readFile(trustPath, 'utf8');
    const parsed = TOML.parse(content) as unknown as CodexTrustData;

    return {
      projects: parsed.projects ?? {},
    };
  } catch {
    // File doesn't exist or is invalid, return empty
    return { projects: {} };
  }
}

/**
 * Write the Codex trust file
 */
export async function writeTrustFile(data: CodexTrustData): Promise<void> {
  const trustPath = getTrustFilePath();
  const dir = path.dirname(trustPath);

  // Ensure directory exists
  await fs.mkdir(dir, { recursive: true });

  // Sort projects alphabetically for determinism
  const sortedProjects: Record<string, TrustEntry> = {};
  const projectPaths = Object.keys(data.projects).sort();

  for (const projectPath of projectPaths) {
    sortedProjects[projectPath] = data.projects[projectPath];
  }

  const tomlData = {
    projects: sortedProjects,
  };

  const tomlString = TOML.stringify(tomlData as unknown as TOML.JsonMap);
  await fs.writeFile(trustPath, tomlString, 'utf8');
}

/**
 * Read the user's Codex config.toml
 */
export async function readCodexConfig(codexHome?: string): Promise<CodexConfigData> {
  const home = codexHome || getDefaultCodexHome();
  const configPath = path.join(home, CODEX_CONFIG_FILE);

  try {
    const content = await fs.readFile(configPath, 'utf8');
    return TOML.parse(content) as unknown as CodexConfigData;
  } catch {
    // File doesn't exist or is invalid, return empty config
    return {};
  }
}

/**
 * Write a Codex config.toml file
 */
export async function writeCodexConfig(configPath: string, config: CodexConfigData): Promise<void> {
  const dir = path.dirname(configPath);
  await fs.mkdir(dir, { recursive: true });

  const tomlString = TOML.stringify(config as unknown as TOML.JsonMap);
  await fs.writeFile(configPath, tomlString, 'utf8');
}

/**
 * Extract project trust settings from a Codex config
 */
function extractProjectTrust(config: CodexConfigData): Record<string, TrustEntry> {
  const projects: Record<string, TrustEntry> = {};

  // Codex stores trust in the projects table
  if (config.projects) {
    for (const [projectPath, entry] of Object.entries(config.projects)) {
      if (entry && typeof entry.trust_level === 'string') {
        projects[projectPath] = { trust_level: entry.trust_level };
      }
    }
  }

  return projects;
}

/**
 * Merge MCP servers into Codex config format
 */
function mergeMCPServers(
  baseConfig: CodexConfigData,
  mcpServers: Record<string, MCPServerConfig>,
): CodexConfigData {
  return {
    ...baseConfig,
    mcp_servers: {
      ...baseConfig.mcp_servers,
      ...mcpServers,
    },
  };
}

/**
 * Copy auth.json from user's CODEX_HOME to temp directory
 * This ensures Codex can authenticate when using our temp CODEX_HOME
 */
async function copyAuthFile(tempCodexHome: string): Promise<void> {
  const sourceCodexHome = getDefaultCodexHome();
  const sourceAuthPath = path.join(sourceCodexHome, CODEX_AUTH_FILE);
  const destAuthPath = path.join(tempCodexHome, CODEX_AUTH_FILE);

  try {
    await fs.copyFile(sourceAuthPath, destAuthPath);
    // Set restrictive permissions on auth file (contains sensitive tokens)
    await fs.chmod(destAuthPath, 0o600);
  } catch {
    // auth.json might not exist if user hasn't authenticated yet, that's OK
  }
}

/**
 * Persist auth.json from temp CODEX_HOME back to user's ~/.codex/
 * This ensures authentication during a session is saved for future use
 */
async function persistAuthFile(tempCodexHome: string): Promise<void> {
  const destCodexHome = getDefaultCodexHome();
  const sourceAuthPath = path.join(tempCodexHome, CODEX_AUTH_FILE);
  const destAuthPath = path.join(destCodexHome, CODEX_AUTH_FILE);

  try {
    // Check if auth.json exists in temp
    await fs.access(sourceAuthPath);

    // Ensure destination directory exists
    await fs.mkdir(destCodexHome, { recursive: true });

    // Copy back to user's CODEX_HOME
    await fs.copyFile(sourceAuthPath, destAuthPath);
    // Set restrictive permissions on auth file (contains sensitive tokens)
    await fs.chmod(destAuthPath, 0o600);
  } catch {
    // auth.json might not exist in temp (user didn't authenticate), that's OK
  }
}

/**
 * Create a Codex session with merged config
 *
 * This creates a temporary CODEX_HOME directory with:
 * 1. User's auth.json from ~/.codex/ (copied)
 * 2. User's base config from ~/.codex/config.toml
 * 3. Persisted trust settings from ~/.terrazul/codex-trust.toml
 * 4. MCP servers from TZ packages
 *
 * @param projectRoot - The project root directory (for trust settings)
 * @param mcpServers - MCP servers to include in the config
 * @returns Session config with temp CODEX_HOME path and cleanup function
 */
export async function createCodexSession(
  projectRoot: string,
  mcpServers: Record<string, MCPServerConfig>,
): Promise<CodexSessionConfig> {
  // Create temp CODEX_HOME in .terrazul/codex-home/
  const tempCodexHome = path.join(projectRoot, '.terrazul', TEMP_CODEX_HOME_NAME);
  await fs.mkdir(tempCodexHome, { recursive: true });

  // Also create prompts directory for symlinks
  const promptsDir = path.join(tempCodexHome, 'prompts');
  await fs.mkdir(promptsDir, { recursive: true });

  // Copy auth.json from user's CODEX_HOME for authentication
  await copyAuthFile(tempCodexHome);

  // Read user's base config
  const userConfig = await readCodexConfig();

  // Read persisted trust settings
  const trustData = await readTrustFile();

  // Start with user config
  let mergedConfig = { ...userConfig };

  // Add persisted trust settings (projects table)
  mergedConfig.projects = {
    ...mergedConfig.projects,
    ...trustData.projects,
  };

  // Add MCP servers
  mergedConfig = mergeMCPServers(mergedConfig, mcpServers);

  // Write merged config to temp CODEX_HOME
  const configPath = path.join(tempCodexHome, CODEX_CONFIG_FILE);
  await writeCodexConfig(configPath, mergedConfig);

  // Create cleanup function
  const cleanup = async (): Promise<void> => {
    await cleanupCodexSession({
      tempCodexHome,
      configPath,
      cleanup: async () => {},
    });
  };

  return {
    tempCodexHome,
    configPath,
    cleanup,
  };
}

/**
 * Clean up Codex session and persist trust + auth
 *
 * This:
 * 1. Reads the temp config for any new project trust settings
 * 2. Merges them into ~/.terrazul/codex-trust.toml
 * 3. Persists auth.json back to ~/.codex/ (in case user authenticated during session)
 * 4. Deletes the temp CODEX_HOME directory
 *
 * @param session - The session config from createCodexSession
 */
export async function cleanupCodexSession(session: CodexSessionConfig): Promise<void> {
  try {
    // Read the temp config to check for new trust settings
    const tempConfig = await readCodexConfig(session.tempCodexHome);
    const newTrust = extractProjectTrust(tempConfig);

    // If there are trust settings, persist them
    if (Object.keys(newTrust).length > 0) {
      const existingTrust = await readTrustFile();

      // Merge new trust into existing (new takes precedence)
      const mergedTrust: CodexTrustData = {
        projects: {
          ...existingTrust.projects,
          ...newTrust,
        },
      };

      await writeTrustFile(mergedTrust);
    }
  } catch {
    // Ignore errors during cleanup - best effort
  }

  try {
    // Persist auth.json back to user's ~/.codex/ in case they authenticated during session
    await persistAuthFile(session.tempCodexHome);
  } catch {
    // Ignore errors during cleanup - best effort
  }

  try {
    // Delete temp CODEX_HOME directory
    await fs.rm(session.tempCodexHome, { recursive: true, force: true });
  } catch {
    // Ignore errors during cleanup - best effort
  }
}

/**
 * Get the trust level for a project
 *
 * @param projectRoot - The project root directory
 * @returns The trust level, or undefined if not set
 */
export async function getProjectTrust(projectRoot: string): Promise<TrustLevel | undefined> {
  const trustData = await readTrustFile();
  return trustData.projects[projectRoot]?.trust_level;
}

/**
 * Set the trust level for a project
 *
 * @param projectRoot - The project root directory
 * @param trustLevel - The trust level to set
 */
export async function setProjectTrust(projectRoot: string, trustLevel: TrustLevel): Promise<void> {
  const trustData = await readTrustFile();
  trustData.projects[projectRoot] = { trust_level: trustLevel };
  await writeTrustFile(trustData);
}
