/**
 * Gemini MCP Configuration Manager
 * Handles reading and writing MCP server configs to .gemini/settings.json
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { MCPConfig, MCPServerConfig } from './claude-code.js';

export interface GeminiSettingsFile {
  mcpServers?: Record<string, MCPServerConfig>;
  [key: string]: unknown;
}

/**
 * Read Gemini settings from .gemini/settings.json
 * Returns existing settings or empty object if file doesn't exist
 */
export async function readGeminiSettings(projectRoot: string): Promise<GeminiSettingsFile> {
  const settingsPath = path.join(projectRoot, '.gemini', 'settings.json');

  try {
    const content = await fs.readFile(settingsPath, 'utf8');
    return JSON.parse(content) as GeminiSettingsFile;
  } catch {
    // File doesn't exist or is invalid JSON
    return {};
  }
}

/**
 * Write MCP config to .gemini/settings.json
 * Merges MCP servers with existing settings (preserving non-MCP config)
 *
 * @param projectRoot - Project root directory
 * @param mcpServers - MCP servers to write
 * @returns Path to the settings file
 */
export async function writeGeminiMCPConfig(
  projectRoot: string,
  mcpServers: Record<string, MCPServerConfig>,
): Promise<string> {
  const settingsPath = path.join(projectRoot, '.gemini', 'settings.json');

  // Read existing settings (preserve non-MCP config)
  const existing = await readGeminiSettings(projectRoot);

  // Merge MCP servers
  const merged: GeminiSettingsFile = {
    ...existing,
    mcpServers: {
      ...existing.mcpServers,
      ...mcpServers,
    },
  };

  // Ensure .gemini directory exists
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });

  // Write merged config
  await fs.writeFile(settingsPath, JSON.stringify(merged, null, 2) + '\n', 'utf8');

  return settingsPath;
}

/**
 * Aggregate MCP configs from multiple packages for Gemini
 * Similar to claude-code.ts aggregateMCPConfigs but for Gemini format
 *
 * @param projectRoot - Project root directory
 * @param packageNames - List of package names to aggregate from
 * @param options - Options including agentModulesRoot path
 * @returns Aggregated MCP config
 */
export async function aggregateGeminiMCPConfigs(
  projectRoot: string,
  packageNames: string[],
  options?: { agentModulesRoot?: string },
): Promise<MCPConfig> {
  const aggregated: MCPConfig = {
    mcpServers: {},
  };

  const agentModulesRoot = options?.agentModulesRoot ?? path.join(projectRoot, 'agent_modules');

  for (const pkgName of packageNames) {
    try {
      // Try multiple config locations in priority order
      const configPaths = [
        // 1. Rendered template in gemini/ subdirectory
        path.join(agentModulesRoot, pkgName, 'gemini', 'mcp_servers.json'),
        // 2. Rendered template at package root (legacy)
        path.join(agentModulesRoot, pkgName, 'mcp-config.json'),
      ];

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
        continue;
      }

      // Read and parse MCP config
      const content = await fs.readFile(mcpConfigPath, 'utf8');
      const config = JSON.parse(content) as MCPConfig;

      if (!config.mcpServers || typeof config.mcpServers !== 'object') {
        continue;
      }

      // Merge servers
      for (const [serverName, serverConfig] of Object.entries(config.mcpServers)) {
        if (!aggregated.mcpServers[serverName]) {
          aggregated.mcpServers[serverName] = serverConfig;
        }
        // Skip duplicates silently (first wins)
      }
    } catch {
      // Skip packages with invalid configs
      continue;
    }
  }

  return aggregated;
}

/**
 * Clean up Gemini MCP servers that were added by Terrazul
 * Note: This removes the mcpServers key entirely if it becomes empty
 *
 * @param projectRoot - Project root directory
 * @param serverNames - Server names to remove (if empty, removes all)
 */
export async function cleanupGeminiMCPConfig(
  projectRoot: string,
  serverNames?: string[],
): Promise<void> {
  const settingsPath = path.join(projectRoot, '.gemini', 'settings.json');

  try {
    const existing = await readGeminiSettings(projectRoot);

    if (!existing.mcpServers) {
      return;
    }

    if (!serverNames || serverNames.length === 0) {
      // Remove all MCP servers
      delete existing.mcpServers;
    } else {
      // Remove specific servers
      for (const name of serverNames) {
        delete existing.mcpServers[name];
      }
      // Remove mcpServers key if empty
      if (Object.keys(existing.mcpServers).length === 0) {
        delete existing.mcpServers;
      }
    }

    // Write back
    await fs.writeFile(settingsPath, JSON.stringify(existing, null, 2) + '\n', 'utf8');
  } catch {
    // Ignore errors if file doesn't exist
  }
}
