import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';

import * as TOML from '@iarna/toml';

import { ErrorCode, TerrazulError } from '../core/errors.js';

import type { MCPConfig } from './claude-code.js';
import type { ToolSpec } from '../types/context.js';
import type { Logger } from '../utils/logger.js';

export interface SpawnToolOptions {
  tool: ToolSpec;
  cwd: string;
  mcpConfig?: MCPConfig;
  mcpConfigPath?: string;
  additionalArgs?: string[];
  /** Custom CODEX_HOME path for Codex sessions (user-level prompts, config) */
  codexHome?: string;
  /** Logger for debug output */
  logger?: Logger;
}

/**
 * Spawn a tool (Claude Code or Codex) with the given options.
 * Dispatches to tool-specific implementations based on tool.type.
 */
export async function spawnTool(options: SpawnToolOptions): Promise<number> {
  const { tool } = options;

  switch (tool.type) {
    case 'claude': {
      return spawnClaudeCodeInternal(options);
    }
    case 'codex': {
      return spawnCodexInternal(options);
    }
    case 'gemini': {
      return spawnGeminiInternal(options);
    }
    default: {
      throw new TerrazulError(
        ErrorCode.TOOL_NOT_FOUND,
        `Tool '${tool.type}' does not support spawning. Use 'claude', 'codex', or 'gemini'.`,
      );
    }
  }
}

/**
 * Spawn Claude Code CLI with MCP config
 */
async function spawnClaudeCodeInternal(options: SpawnToolOptions): Promise<number> {
  const { tool, cwd, mcpConfigPath, additionalArgs = [] } = options;

  return new Promise((resolve, reject) => {
    const command = tool.command ?? 'claude';
    const args: string[] = [];

    // Add MCP config if provided
    if (mcpConfigPath) {
      args.push('--mcp-config', mcpConfigPath, '--strict-mcp-config');
    }

    // Add model flag if specified (skip 'default' to use user's environment preference)
    if (tool.model && tool.model !== 'default') {
      args.push('--model', tool.model);
    }

    // Add any additional args
    args.push(...additionalArgs);

    const workingDir = cwd || process.cwd();

    const child = spawn(command, args, {
      cwd: workingDir,
      stdio: 'inherit',
      shell: false,
      env: { ...process.env, ...expandEnvVars(tool.env) },
    });

    child.on('error', (error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(
          new TerrazulError(
            ErrorCode.TOOL_NOT_FOUND,
            'Claude CLI not found. Install it from https://claude.ai/download',
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
 * Spawn Codex CLI with MCP config overrides.
 * Note: We intentionally do NOT include tool.args here because those args
 * (like 'exec') are for non-interactive prompt execution (askAgent).
 * For interactive spawning, we just run 'codex' directly.
 */
async function spawnCodexInternal(options: SpawnToolOptions): Promise<number> {
  const { tool, cwd, mcpConfig, additionalArgs = [], codexHome, logger } = options;

  return new Promise((resolve, reject) => {
    const command = tool.command ?? 'codex';
    const args: string[] = [];

    // Note: We don't include tool.args here because 'exec' is for non-interactive
    // prompt execution. For interactive spawning, just run 'codex' directly.

    // Add model if specified
    if (tool.model && tool.model !== 'default') {
      args.push('--model', tool.model);
    }

    // Add MCP config overrides if present
    if (mcpConfig && Object.keys(mcpConfig.mcpServers).length > 0) {
      for (const [name, server] of Object.entries(mcpConfig.mcpServers)) {
        args.push('-c', `mcp_servers.${name}.command=${server.command}`);
        if (server.args && server.args.length > 0) {
          args.push('-c', `mcp_servers.${name}.args=${JSON.stringify(server.args)}`);
        }
        if (server.env && Object.keys(server.env).length > 0) {
          // Use flat key syntax with properly quoted values for TOML compatibility
          // (e.g., mcp_servers.name.env.KEY="value")
          for (const [envKey, envValue] of Object.entries(server.env)) {
            args.push('-c', `mcp_servers.${name}.env.${envKey}=${tomlStringify(envValue)}`);
          }
        }
      }
    }

    // Add any additional args
    args.push(...additionalArgs);

    const workingDir = cwd || process.cwd();

    // Build environment with optional CODEX_HOME override
    const env: Record<string, string | undefined> = {
      ...process.env,
      ...expandEnvVars(tool.env),
    };
    if (codexHome) {
      env.CODEX_HOME = codexHome;
    }

    logger?.debug(`codex spawn: ${command} ${args.join(' ')}`);
    logger?.debug(`codex cwd: ${workingDir}`);
    logger?.debug(`CODEX_HOME: ${env.CODEX_HOME ?? '(not set)'}`);

    const child = spawn(command, args, {
      cwd: workingDir,
      stdio: 'inherit',
      shell: false,
      env,
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
 * Spawn Gemini CLI.
 * Note: Gemini reads MCP config from .gemini/settings.json (project-level),
 * so no need to pass via command-line args.
 */
async function spawnGeminiInternal(options: SpawnToolOptions): Promise<number> {
  const { tool, cwd, additionalArgs = [] } = options;

  return new Promise((resolve, reject) => {
    const command = tool.command ?? 'gemini';
    const args: string[] = [];

    // Note: We don't include tool.args here because those may be for non-interactive use.
    // For interactive spawning, just run 'gemini' directly.

    // Add model if specified
    if (tool.model && tool.model !== 'default') {
      args.push('--model', tool.model);
    }

    // Gemini reads MCP config from .gemini/settings.json (project-level)
    // No need to pass via command-line - it's already written there

    // Add any additional args
    args.push(...additionalArgs);

    const workingDir = cwd || process.cwd();

    // Build environment
    const env: Record<string, string | undefined> = {
      ...process.env,
      ...expandEnvVars(tool.env),
    };

    const child = spawn(command, args, {
      cwd: workingDir,
      stdio: 'inherit',
      shell: false,
      env,
    });

    child.on('error', (error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(
          new TerrazulError(
            ErrorCode.TOOL_NOT_FOUND,
            'Gemini CLI not found. Install it from https://github.com/google-gemini/gemini-cli',
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
 * Serialize a string value to TOML format (properly quoted and escaped).
 * Uses @iarna/toml for guaranteed correctness with special characters.
 */
function tomlStringify(value: string): string {
  // TOML.stringify wraps the result with "v = <value>\n", extract just the value
  const serialized = TOML.stringify({ v: value });
  // Output is "v = <value>\n", extract <value>
  return serialized.slice(4, -1);
}

/**
 * Expand environment variable references in tool env config.
 * Supports "env:NAME" syntax to resolve at spawn time.
 */
function expandEnvVars(env?: Record<string, string>): Record<string, string> {
  if (!env) return {};

  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value.startsWith('env:')) {
      const envName = value.slice(4);
      const envValue = process.env[envName];
      if (envValue !== undefined) {
        result[key] = envValue;
      }
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Load MCP config from a JSON file
 */
export async function loadMCPConfig(configPath: string): Promise<MCPConfig> {
  try {
    const content = await fs.readFile(configPath, 'utf8');
    return JSON.parse(content) as MCPConfig;
  } catch {
    return { mcpServers: {} };
  }
}
