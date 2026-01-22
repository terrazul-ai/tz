import { rewritePath, sanitizeEnv, sanitizeMcpServers } from '../sanitize.js';

import type { MCPServerPlan } from '../types.js';

export interface GeminiMCPServerConfig {
  command?: string; // stdio transport
  url?: string; // SSE transport
  httpUrl?: string; // HTTP transport
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  timeout?: number;
  trust?: boolean;
  headers?: Record<string, string>;
  includeTools?: string[];
  excludeTools?: string[];
}

export interface GeminiSettingsConfig {
  mcpServers?: Record<string, GeminiMCPServerConfig>;
  [key: string]: unknown;
}

export interface GeminiBaseConfig {
  [key: string]: unknown;
}

export interface GeminiConfigExtraction {
  servers: MCPServerPlan[];
  base: GeminiBaseConfig | null;
}

export function parseGeminiSettings(
  input: string | Record<string, unknown>,
  projectRootAbs: string,
  origin = '.gemini/settings.json',
): GeminiConfigExtraction {
  let doc: Record<string, unknown>;

  if (typeof input === 'string') {
    try {
      const parsed: unknown = JSON.parse(input ?? '');
      doc = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    } catch {
      return { servers: [], base: null };
    }
  } else {
    doc = input ?? {};
  }

  // Extract base config (non-MCP settings)
  const base: GeminiBaseConfig = {};
  for (const [key, value] of Object.entries(doc)) {
    if (key !== 'mcpServers') {
      base[key] = value;
    }
  }

  const section = doc.mcpServers && typeof doc.mcpServers === 'object' ? doc.mcpServers : undefined;
  if (!section || typeof section !== 'object') {
    return { servers: [], base: Object.keys(base).length > 0 ? base : null };
  }

  const servers: MCPServerPlan[] = [];

  for (const [name, value] of Object.entries(section as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const record = value as Record<string, unknown>;

    // Gemini supports multiple transport types: stdio (command), sse (url), http (httpUrl)
    const commandRaw = record.command;
    const urlRaw = record.url;
    const httpUrlRaw = record.httpUrl;

    // Skip if no transport is defined
    if (
      (typeof commandRaw !== 'string' || commandRaw.trim() === '') &&
      (typeof urlRaw !== 'string' || urlRaw.trim() === '') &&
      (typeof httpUrlRaw !== 'string' || httpUrlRaw.trim() === '')
    ) {
      continue;
    }

    const argsRaw = Array.isArray(record.args) ? record.args : [];
    const envRaw = record.env && typeof record.env === 'object' ? record.env : undefined;

    const sanitizedArgs = argsRaw
      .filter((arg): arg is string => typeof arg === 'string')
      .map((arg) => rewritePath(arg, projectRootAbs));
    const sanitizedEnv = sanitizeEnv(
      envRaw
        ? Object.fromEntries(
            Object.entries(envRaw as Record<string, unknown>).filter(
              (entry): entry is [string, string] => typeof entry[1] === 'string',
            ),
          )
        : undefined,
    );

    // Sanitize command/url paths
    const sanitizedCommand =
      typeof commandRaw === 'string' ? rewritePath(commandRaw, projectRootAbs) : undefined;

    // Build config preserving all original properties
    const config: Record<string, unknown> = sanitizeMcpServers(record, projectRootAbs) as Record<
      string,
      unknown
    >;
    if (sanitizedCommand) config.command = sanitizedCommand;
    if (sanitizedArgs.length > 0) config.args = sanitizedArgs;
    if (sanitizedEnv && Object.keys(sanitizedEnv).length > 0) config.env = sanitizedEnv;

    servers.push({
      id: `gemini:${name}`,
      source: 'gemini',
      name,
      origin,
      definition: {
        command: sanitizedCommand ?? '',
        args: sanitizedArgs,
        env: sanitizedEnv ?? {},
      },
      config,
    });
  }

  return {
    servers: servers.sort((a, b) => a.id.localeCompare(b.id)),
    base: Object.keys(base).length > 0 ? base : null,
  };
}

export function renderGeminiSettings(
  base: GeminiBaseConfig | null,
  servers: MCPServerPlan[],
): string {
  const doc: Record<string, unknown> = {};

  // Restore base config
  if (base) {
    for (const [key, value] of Object.entries(base)) {
      doc[key] = value;
    }
  }

  // Add MCP servers
  const geminiServers = servers.filter((server) => server.source === 'gemini');
  if (geminiServers.length > 0) {
    const map: Record<string, unknown> = {};
    for (const server of geminiServers) {
      const def = server.config ?? {
        command: server.definition.command,
        ...(server.definition.args.length > 0 ? { args: server.definition.args } : {}),
        ...(Object.keys(server.definition.env).length > 0 ? { env: server.definition.env } : {}),
      };
      map[server.name] = structuredClone(def);
    }
    doc.mcpServers = map;
  }

  const serialized = JSON.stringify(doc, null, 2);
  return serialized.endsWith('\n') ? serialized : `${serialized}\n`;
}

export function renderGeminiMcpServers(servers: MCPServerPlan[]): string {
  const geminiServers = servers.filter((server) => server.source === 'gemini');
  if (geminiServers.length === 0) {
    return JSON.stringify({ mcpServers: {} }, null, 2) + '\n';
  }

  const map: Record<string, unknown> = {};
  for (const server of geminiServers) {
    const def = server.config ?? {
      command: server.definition.command,
      ...(server.definition.args.length > 0 ? { args: server.definition.args } : {}),
      ...(Object.keys(server.definition.env).length > 0 ? { env: server.definition.env } : {}),
    };
    map[server.name] = structuredClone(def);
  }

  const serialized = JSON.stringify({ mcpServers: map }, null, 2);
  return serialized.endsWith('\n') ? serialized : `${serialized}\n`;
}
