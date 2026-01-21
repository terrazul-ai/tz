import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ensureDir } from '../../utils/fs.js';
import { resolveWithin } from '../../utils/path.js';
import { ErrorCode, TerrazulError } from '../errors.js';
import { buildAgentsToml, type ExportMap } from './build-manifest.js';
import {
  parseCodexMcpServers,
  renderCodexConfig,
  renderCodexMcpServers,
} from './mcp/codex-config.js';
import { parseProjectMcpServers } from './mcp/project-config.js';
import {
  resolveProjectRoot,
  sanitizeEnv,
  sanitizeMcpServers,
  sanitizeSettingsJson,
  sanitizeText,
} from './sanitize.js';

import type {
  ExecuteOptions,
  ExtractOptions,
  ExtractPlan,
  ExtractResult,
  LoggerLike,
  ManifestPatch,
  MCPServerPlan,
  PlannedOutput,
} from './types.js';

export type {
  ExecuteOptions,
  ExtractOptions,
  ExtractPlan,
  ExtractResult,
  LoggerLike,
  MCPServerPlan,
  PlannedOutput,
} from './types.js';

const CLAUDE_SUBAGENT_ARTIFACT_ID = 'claude.subagents';
const CODEX_CONFIG_ARTIFACT_ID = 'codex.config';
const CLAUDE_TEMPLATE_PREFIX = 'templates/claude/agents/';
const TEMPLATE_SUFFIX = '.hbs';

export function getSubagentIdFromTemplatePath(relativePath: string): string | null {
  if (!relativePath.startsWith(CLAUDE_TEMPLATE_PREFIX)) return null;
  const trimmed = relativePath.slice(CLAUDE_TEMPLATE_PREFIX.length);
  if (trimmed.endsWith(TEMPLATE_SUFFIX)) {
    return trimmed.slice(0, -TEMPLATE_SUFFIX.length);
  }
  return trimmed;
}

export function getSubagentIdFromSourcePath(absPath: string): string {
  const segments = absPath.split(path.sep);
  const claudeIndex = segments.indexOf('.claude');
  if (claudeIndex >= 0 && segments[claudeIndex + 1] === 'agents') {
    return segments.slice(claudeIndex + 2).join('/');
  }
  return segments.slice(-1).join('/');
}

export function getPlanSubagentIds(plan: ExtractPlan): string[] {
  const raw = plan.detected[CLAUDE_SUBAGENT_ARTIFACT_ID];
  if (!Array.isArray(raw)) return [];
  return raw.map((abs) => getSubagentIdFromSourcePath(abs)).filter((id) => id.length > 0);
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function isNonEmptyDir(p: string): Promise<boolean> {
  try {
    const st = await fs.stat(p);
    if (!st.isDirectory()) return false;
    const entries = await fs.readdir(p);
    return entries.length > 0;
  } catch {
    return false;
  }
}

async function readJsonMaybe(p: string): Promise<unknown> {
  try {
    const txt = await fs.readFile(p, 'utf8');
    const parsed: unknown = JSON.parse(txt);
    return parsed;
  } catch {
    return null;
  }
}

function stableSort<T>(arr: T[], map: (v: T) => string): T[] {
  return [...arr].sort((a, b) => map(a).localeCompare(map(b)));
}

// Defensive join to ensure writes never escape the intended output directory.
function safeJoinWithin(baseDirAbs: string, ...parts: string[]): string {
  try {
    return resolveWithin(baseDirAbs, ...parts);
  } catch {
    throw new TerrazulError(
      ErrorCode.SECURITY_VIOLATION,
      'Refusing to write outside of --out directory',
    );
  }
}

function mergeManifestEntry(target: ExportMap, patch?: ManifestPatch): void {
  if (!patch) return;
  const existing = target[patch.tool] ?? {};
  target[patch.tool] = { ...existing, ...patch.properties };
}

function buildManifestFromOutputs(outputs: PlannedOutput[]): ExportMap {
  const manifest: ExportMap = {};
  for (const output of outputs) {
    mergeManifestEntry(manifest, output.manifestPatch);
  }
  return manifest;
}

function dedupeMcpServers(servers: MCPServerPlan[]): MCPServerPlan[] {
  const map = new Map<string, MCPServerPlan>();
  for (const server of servers) {
    if (!map.has(server.id)) {
      map.set(server.id, server);
    }
  }
  return [...map.values()];
}

function buildMcpServersObject(servers: MCPServerPlan[]): Record<string, unknown> {
  const entries = servers.map((server) => {
    const config = server.config ?? {
      command: server.definition.command,
      ...(server.definition.args.length > 0 ? { args: server.definition.args } : {}),
      ...(Object.keys(server.definition.env).length > 0 ? { env: server.definition.env } : {}),
    };
    return [server.name, structuredClone(config)] as const;
  });
  entries.sort(([a], [b]) => a.localeCompare(b));
  const out: Record<string, unknown> = {};
  for (const [name, def] of entries) {
    out[name] = def;
  }
  return out;
}

function normalizeProjectMcpObject(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (obj.mcpServers && typeof obj.mcpServers === 'object') {
    return obj.mcpServers as Record<string, unknown>;
  }
  return obj;
}

function createClaudeMcpPlans(
  sanitized: unknown,
  projectRootAbs: string,
  origin: string,
): MCPServerPlan[] {
  const section = normalizeProjectMcpObject(sanitized);
  if (!section) return [];
  const plans: MCPServerPlan[] = [];
  for (const [name, value] of Object.entries(section)) {
    if (!value || typeof value !== 'object') continue;
    const record = value as Record<string, unknown>;
    const commandRaw = record.command;
    if (typeof commandRaw !== 'string' || commandRaw.trim() === '') continue;
    const argsRaw = Array.isArray(record.args) ? record.args : [];
    const envRaw = record.env && typeof record.env === 'object' ? record.env : undefined;
    const sanitizedArgs = argsRaw
      .filter((arg): arg is string => typeof arg === 'string')
      .map((arg) => sanitizeText(String(arg), projectRootAbs));
    const envEntries = envRaw
      ? Object.entries(envRaw as Record<string, unknown>).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        )
      : [];
    const sanitizedEnv = sanitizeEnv(Object.fromEntries(envEntries));
    const sanitizedCommand = sanitizeText(String(commandRaw), projectRootAbs);
    const config = structuredClone(record);
    config.command = sanitizedCommand;
    config.args = sanitizedArgs;
    if (sanitizedEnv) config.env = sanitizedEnv;
    else if ('env' in config) delete config.env;
    plans.push({
      id: `claude:${name}`,
      source: 'claude',
      name,
      origin,
      definition: {
        command: sanitizedCommand,
        args: sanitizedArgs,
        env: sanitizedEnv ?? {},
      },
      config,
    });
  }
  plans.sort((a, b) => a.id.localeCompare(b.id));
  return plans;
}

function createGeminiMcpPlans(
  mcpServers: unknown,
  projectRootAbs: string,
  origin: string,
): MCPServerPlan[] {
  if (!mcpServers || typeof mcpServers !== 'object') return [];
  const plans: MCPServerPlan[] = [];
  for (const [name, value] of Object.entries(mcpServers as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const record = value as Record<string, unknown>;
    // Gemini supports multiple transports: stdio (command), sse (url), http (httpUrl)
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
      .map((arg) => sanitizeText(String(arg), projectRootAbs));
    const envEntries = envRaw
      ? Object.entries(envRaw as Record<string, unknown>).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        )
      : [];
    const sanitizedEnv = sanitizeEnv(Object.fromEntries(envEntries));
    const sanitizedCommand =
      typeof commandRaw === 'string' ? sanitizeText(String(commandRaw), projectRootAbs) : '';
    const config = structuredClone(record);
    if (sanitizedCommand) config.command = sanitizedCommand;
    config.args = sanitizedArgs;
    if (sanitizedEnv) config.env = sanitizedEnv;
    else if ('env' in config) delete config.env;
    plans.push({
      id: `gemini:${name}`,
      source: 'gemini',
      name,
      origin,
      definition: {
        command: sanitizedCommand,
        args: sanitizedArgs,
        env: sanitizedEnv ?? {},
      },
      config,
    });
  }
  plans.sort((a, b) => a.id.localeCompare(b.id));
  return plans;
}

export async function analyzeExtractSources(options: ExtractOptions): Promise<ExtractPlan> {
  const fromAbs = path.resolve(options.from);
  const projectRoot = resolveProjectRoot(fromAbs);

  const plan: ExtractPlan = {
    projectRoot,
    detected: {},
    skipped: [],
    manifest: {},
    outputs: [],
    mcpServers: [],
    codexConfigBase: null,
  };

  const addOutput = (output: PlannedOutput): void => {
    plan.outputs.push(output);
    mergeManifestEntry(plan.manifest, output.manifestPatch);
  };

  addOutput({
    id: 'scaffold:README.md',
    artifactId: '__base.readme',
    relativePath: 'README.md',
    format: 'text',
    data: `# ${options.name}\n\nThis package was generated via 'tz extract'.\n`,
    alwaysInclude: true,
  });

  const candidates = {
    codexAgents: [
      path.join(projectRoot, 'AGENTS.md'),
      path.join(projectRoot, '.codex', 'AGENTS.md'),
    ],
    claudeMd: [path.join(projectRoot, 'CLAUDE.md'), path.join(projectRoot, '.claude', 'CLAUDE.md')],
    claudeSettings: [path.join(projectRoot, '.claude', 'settings.json')],
    claudeSettingsLocal: [path.join(projectRoot, '.claude', 'settings.local.json')],
    claudeMcp: [
      path.join(projectRoot, '.claude', 'mcp_servers.json'),
      path.join(projectRoot, '.claude', 'mcp-servers.json'),
    ],
    claudeAgentsDir: [path.join(projectRoot, '.claude', 'agents')],
    // Gemini candidates
    geminiMd: [path.join(projectRoot, 'GEMINI.md'), path.join(projectRoot, '.gemini', 'GEMINI.md')],
    geminiSettings: [path.join(projectRoot, '.gemini', 'settings.json')],
    geminiCommandsDir: [path.join(projectRoot, '.gemini', 'commands')],
    geminiSkillsDir: [path.join(projectRoot, '.gemini', 'skills')],
  } as const;

  const exists: Record<keyof typeof candidates, string | null> = {
    codexAgents: null,
    claudeMd: null,
    claudeSettings: null,
    claudeSettingsLocal: null,
    claudeMcp: null,
    claudeAgentsDir: null,
    // Gemini
    geminiMd: null,
    geminiSettings: null,
    geminiCommandsDir: null,
    geminiSkillsDir: null,
  };

  for (const key of Object.keys(candidates) as (keyof typeof candidates)[]) {
    for (const candidatePath of candidates[key]) {
      if (await pathExists(candidatePath)) {
        exists[key] = candidatePath;
        break;
      }
    }
  }

  let agentFiles: string[] = [];
  if (exists.claudeAgentsDir) {
    const relRoot = exists.claudeAgentsDir;
    const rootLst = await fs.lstat(relRoot).catch(() => null);
    if (rootLst && rootLst.isSymbolicLink()) {
      plan.skipped.push('claude.agents (symlink dir ignored)');
    } else {
      const stack: string[] = [relRoot];
      const collected: string[] = [];
      while (stack.length > 0) {
        const cur = stack.pop()!;
        const entries = await fs.readdir(cur);
        for (const ent of entries) {
          const abs = path.join(cur, ent);
          const lst = await fs.lstat(abs);
          if (lst.isSymbolicLink()) continue;
          if (lst.isDirectory()) {
            stack.push(abs);
          } else if (lst.isFile() && /\.md$/i.test(ent)) {
            collected.push(abs);
          }
        }
      }
      agentFiles = stableSort(collected, (p) => p);
    }
  }

  if (exists.codexAgents) {
    const src = exists.codexAgents;
    const lst = await fs.lstat(src);
    if (lst.isSymbolicLink()) {
      plan.skipped.push('codex.Agents (symlink ignored)');
    } else {
      const sanitized = sanitizeText(await fs.readFile(src, 'utf8'), projectRoot);
      plan.detected['codex.Agents'] = src;
      addOutput({
        id: 'codex.Agents:templates/AGENTS.md.hbs',
        artifactId: 'codex.Agents',
        relativePath: 'templates/AGENTS.md.hbs',
        format: 'text',
        data: sanitized,
        manifestPatch: { tool: 'codex', properties: { template: 'templates/AGENTS.md.hbs' } },
      });
    }
  }

  if (exists.claudeMd) {
    const src = exists.claudeMd;
    const lst = await fs.lstat(src);
    if (lst.isSymbolicLink()) {
      plan.skipped.push('claude.Readme (symlink ignored)');
    } else {
      const sanitized = sanitizeText(await fs.readFile(src, 'utf8'), projectRoot);
      plan.detected['claude.Readme'] = src;
      addOutput({
        id: 'claude.Readme:templates/CLAUDE.md.hbs',
        artifactId: 'claude.Readme',
        relativePath: 'templates/CLAUDE.md.hbs',
        format: 'text',
        data: sanitized,
        manifestPatch: { tool: 'claude', properties: { template: 'templates/CLAUDE.md.hbs' } },
      });
    }
  }

  if (exists.claudeSettings) {
    const src = exists.claudeSettings;
    const lst = await fs.lstat(src);
    if (lst.isSymbolicLink()) {
      plan.skipped.push('claude.settings (symlink ignored)');
    } else {
      const raw = await readJsonMaybe(src);
      const sanitized = sanitizeSettingsJson(raw, projectRoot);
      plan.detected['claude.settings'] = src;
      addOutput({
        id: 'claude.settings:templates/claude/settings.json.hbs',
        artifactId: 'claude.settings',
        relativePath: 'templates/claude/settings.json.hbs',
        format: 'json',
        data: sanitized ?? {},
        manifestPatch: {
          tool: 'claude',
          properties: { settings: 'templates/claude/settings.json.hbs' },
        },
      });
    }
  }

  if (exists.claudeSettingsLocal) {
    const src = exists.claudeSettingsLocal;
    if (options.includeClaudeLocal) {
      const lst = await fs.lstat(src);
      if (lst.isSymbolicLink()) {
        plan.skipped.push('claude.settings.local (symlink ignored)');
      } else {
        const raw = await readJsonMaybe(src);
        const sanitized = sanitizeSettingsJson(raw, projectRoot);
        plan.detected['claude.settings.local'] = src;
        addOutput({
          id: 'claude.settings.local:templates/claude/settings.local.json.hbs',
          artifactId: 'claude.settings.local',
          relativePath: 'templates/claude/settings.local.json.hbs',
          format: 'json',
          data: sanitized ?? {},
          manifestPatch: {
            tool: 'claude',
            properties: { settingsLocal: 'templates/claude/settings.local.json.hbs' },
          },
        });
      }
    } else {
      plan.skipped.push('claude.settings.local (use --include-claude-local to include)');
    }
  }

  if (options.includeClaudeUser) {
    const userJson = path.join(os.homedir(), '.claude.json');
    if (await pathExists(userJson)) {
      const lst = await fs.lstat(userJson);
      if (lst.isSymbolicLink()) {
        plan.skipped.push('claude.user.settings (symlink ignored)');
      } else {
        const raw = await readJsonMaybe(userJson);
        const rawObj =
          raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : undefined;
        const projects =
          rawObj?.projects && typeof rawObj.projects === 'object'
            ? (rawObj.projects as Record<string, unknown>)
            : undefined;
        const projBlock = projects ? projects[projectRoot] : undefined;
        if (projBlock && typeof projBlock === 'object') {
          const sanitized = sanitizeSettingsJson(projBlock, projectRoot);
          plan.detected['claude.user.settings'] = userJson;
          addOutput({
            id: 'claude.user.settings:templates/claude/user.settings.json.hbs',
            artifactId: 'claude.user.settings',
            relativePath: 'templates/claude/user.settings.json.hbs',
            format: 'json',
            data: sanitized ?? {},
            manifestPatch: {
              tool: 'claude',
              properties: { userSettings: 'templates/claude/user.settings.json.hbs' },
            },
          });
        }
      }
    }
  }

  if (exists.claudeMcp) {
    const src = exists.claudeMcp;
    const lst = await fs.lstat(src);
    if (lst.isSymbolicLink()) {
      plan.skipped.push('claude.mcp_servers (symlink ignored)');
    } else {
      const raw = await readJsonMaybe(src);
      const sanitized = sanitizeMcpServers(raw, projectRoot) ?? {};
      plan.detected['claude.mcp_servers'] = src;
      addOutput({
        id: 'claude.mcp_servers:templates/claude/mcp_servers.json.hbs',
        artifactId: 'claude.mcp_servers',
        relativePath: 'templates/claude/mcp_servers.json.hbs',
        format: 'json',
        data: sanitized,
        manifestPatch: {
          tool: 'claude',
          properties: { mcpServers: 'templates/claude/mcp_servers.json.hbs' },
        },
      });
      plan.mcpServers.push(...createClaudeMcpPlans(sanitized, projectRoot, src));
    }
  }

  if (agentFiles.length > 0 && exists.claudeAgentsDir) {
    plan.detected['claude.subagents'] = agentFiles;
    let manifestApplied = false;
    for (const src of agentFiles) {
      const relUnderAgents = path.relative(exists.claudeAgentsDir, src);
      const normalized = relUnderAgents.split(path.sep).join('/');
      const sanitized = sanitizeText(await fs.readFile(src, 'utf8'), projectRoot);
      addOutput({
        id: `claude.subagents:templates/claude/agents/${normalized}.hbs`,
        artifactId: 'claude.subagents',
        relativePath: `templates/claude/agents/${normalized}.hbs`,
        format: 'text',
        data: sanitized,
        manifestPatch: manifestApplied
          ? undefined
          : {
              tool: 'claude',
              properties: { subagentsDir: 'templates/claude/agents' },
            },
      });
      manifestApplied = true;
    }
  }

  // Gemini: GEMINI.md context file
  if (exists.geminiMd) {
    const src = exists.geminiMd;
    const lst = await fs.lstat(src);
    if (lst.isSymbolicLink()) {
      plan.skipped.push('gemini.Readme (symlink ignored)');
    } else {
      const sanitized = sanitizeText(await fs.readFile(src, 'utf8'), projectRoot);
      plan.detected['gemini.Readme'] = src;
      addOutput({
        id: 'gemini.Readme:templates/GEMINI.md.hbs',
        artifactId: 'gemini.Readme',
        relativePath: 'templates/GEMINI.md.hbs',
        format: 'text',
        data: sanitized,
        manifestPatch: { tool: 'gemini', properties: { template: 'templates/GEMINI.md.hbs' } },
      });
    }
  }

  // Gemini: settings.json (MCP servers)
  if (exists.geminiSettings) {
    const src = exists.geminiSettings;
    const lst = await fs.lstat(src);
    if (lst.isSymbolicLink()) {
      plan.skipped.push('gemini.settings (symlink ignored)');
    } else {
      const raw = await readJsonMaybe(src);
      const sanitized = sanitizeMcpServers(raw, projectRoot) ?? {};
      plan.detected['gemini.settings'] = src;
      addOutput({
        id: 'gemini.settings:templates/gemini/settings.json.hbs',
        artifactId: 'gemini.settings',
        relativePath: 'templates/gemini/settings.json.hbs',
        format: 'json',
        data: sanitized,
        manifestPatch: {
          tool: 'gemini',
          properties: { mcpServers: 'templates/gemini/settings.json.hbs' },
        },
      });
      // Extract MCP servers from Gemini settings
      const settingsObj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
      if (settingsObj.mcpServers && typeof settingsObj.mcpServers === 'object') {
        plan.mcpServers.push(...createGeminiMcpPlans(settingsObj.mcpServers, projectRoot, src));
      }
    }
  }

  const codexConfigPath =
    options.codexConfigPath ?? path.join(os.homedir(), '.codex', 'config.toml');
  const codexConfigExists = await pathExists(codexConfigPath);
  if (codexConfigExists) {
    const toml = await fs.readFile(codexConfigPath, 'utf8');
    const codexExtraction = parseCodexMcpServers(toml, projectRoot, codexConfigPath);
    plan.mcpServers.push(...codexExtraction.servers);
    if (codexExtraction.base) {
      plan.codexConfigBase = codexExtraction.base;
    }
    if (options.includeCodexConfig) {
      if (!plan.detected[CODEX_CONFIG_ARTIFACT_ID]) {
        plan.detected[CODEX_CONFIG_ARTIFACT_ID] = codexConfigPath;
      }
      const existingConfig = plan.outputs.find(
        (output: PlannedOutput) => output.artifactId === CODEX_CONFIG_ARTIFACT_ID,
      );
      if (!existingConfig) {
        addOutput({
          id: `${CODEX_CONFIG_ARTIFACT_ID}:templates/codex/config.toml`,
          artifactId: CODEX_CONFIG_ARTIFACT_ID,
          relativePath: 'templates/codex/config.toml',
          format: 'toml',
          data: null,
          manifestPatch: {
            tool: 'codex',
            properties: { config: 'templates/codex/config.toml' },
          },
        });
      }
    } else {
      plan.skipped.push('codex.mcp_servers (enable include Codex config to bundle)');
    }
  }

  const projectMcpPath = options.projectMcpConfigPath ?? path.join(projectRoot, '.mcp.json');
  if (await pathExists(projectMcpPath)) {
    const json = await fs.readFile(projectMcpPath, 'utf8');
    plan.mcpServers.push(...parseProjectMcpServers(json, projectRoot, projectMcpPath));
  }

  plan.mcpServers = dedupeMcpServers(plan.mcpServers).sort((a, b) => a.id.localeCompare(b.id));

  if (plan.mcpServers.length > 0) {
    if (!plan.detected['claude.mcp_servers']) {
      plan.detected['claude.mcp_servers'] = 'aggregated from MCP sources';
    }
    let mcpOutput = plan.outputs.find(
      (output: PlannedOutput) => output.artifactId === 'claude.mcp_servers',
    );
    if (!mcpOutput) {
      addOutput({
        id: 'claude.mcp_servers:templates/claude/mcp_servers.json.hbs',
        artifactId: 'claude.mcp_servers',
        relativePath: 'templates/claude/mcp_servers.json.hbs',
        format: 'json',
        data: {},
        manifestPatch: {
          tool: 'claude',
          properties: { mcpServers: 'templates/claude/mcp_servers.json.hbs' },
        },
      });
      mcpOutput = plan.outputs.find(
        (output: PlannedOutput) => output.artifactId === 'claude.mcp_servers',
      );
    }
    if (mcpOutput) {
      mcpOutput.data = buildMcpServersObject(plan.mcpServers);
    }
  }

  const hasCodexServers = plan.mcpServers.some((server) => server.source === 'codex');
  if (hasCodexServers || plan.codexConfigBase) {
    if (!plan.detected['codex.mcp_servers']) {
      plan.detected['codex.mcp_servers'] = 'aggregated from MCP sources';
    }
    const existing = plan.outputs.find(
      (output: PlannedOutput) => output.artifactId === 'codex.mcp_servers',
    );
    if (!existing) {
      addOutput({
        id: 'codex.mcp_servers:templates/codex/agents.toml.hbs',
        artifactId: 'codex.mcp_servers',
        relativePath: 'templates/codex/agents.toml.hbs',
        format: 'toml',
        data: null,
        alwaysInclude: true,
        manifestPatch: {
          tool: 'codex',
          properties: { mcpServers: 'templates/codex/agents.toml.hbs' },
        },
      });
    }
  }

  if (Object.keys(plan.detected).length === 0) {
    throw new TerrazulError(
      ErrorCode.INVALID_ARGUMENT,
      `No recognized inputs found under ${projectRoot}. Ensure at least one exists: AGENTS.md, .codex/AGENTS.md, .claude/CLAUDE.md, .claude/settings.json, .claude/mcp_servers.json, .claude/agents/**/*.md`,
    );
  }

  plan.manifest = buildManifestFromOutputs(plan.outputs);
  return plan;
}

export async function executeExtract(
  plan: ExtractPlan,
  execOptions: ExecuteOptions,
  logger: LoggerLike,
): Promise<ExtractResult> {
  const outAbs = path.resolve(execOptions.out);
  const willWrite = !execOptions.dryRun;
  const selectedArtifacts = new Set(execOptions.includedArtifacts ?? []);
  const includedSubagentSet = new Set(execOptions.includedSubagentFiles ?? []);
  const canonicalSubagentPatch = plan.outputs.find(
    (output) => output.artifactId === CLAUDE_SUBAGENT_ARTIFACT_ID && output.manifestPatch,
  )?.manifestPatch;

  const selectedMcpIds = new Set(execOptions.includedMcpServers ?? []);
  const includeAllMcp = selectedMcpIds.size === 0;
  const selectedMcpServers = plan.mcpServers.filter((server: MCPServerPlan) =>
    includeAllMcp ? true : selectedMcpIds.has(server.id),
  );
  const mcpJson = buildMcpServersObject(selectedMcpServers);
  const selectedCodexServers = selectedMcpServers.filter((server) => server.source === 'codex');

  const outputsToWrite: PlannedOutput[] = [];
  const subagentIndexes: number[] = [];

  for (const output of plan.outputs) {
    if (output.artifactId === CLAUDE_SUBAGENT_ARTIFACT_ID) {
      if (!selectedArtifacts.has(CLAUDE_SUBAGENT_ARTIFACT_ID)) continue;
      const subagentId = getSubagentIdFromTemplatePath(output.relativePath);
      if (includedSubagentSet.size > 0 && (!subagentId || !includedSubagentSet.has(subagentId))) {
        continue;
      }
      outputsToWrite.push(output);
      subagentIndexes.push(outputsToWrite.length - 1);
      continue;
    }
    if (output.artifactId === 'codex.mcp_servers' && selectedCodexServers.length === 0) {
      continue;
    }
    if (output.alwaysInclude || selectedArtifacts.has(output.artifactId)) {
      outputsToWrite.push(output);
    }
  }

  if (subagentIndexes.length > 0 && canonicalSubagentPatch) {
    const hasPatch = subagentIndexes.some((idx) => outputsToWrite[idx].manifestPatch);
    if (!hasPatch) {
      const firstIdx = subagentIndexes[0];
      outputsToWrite[firstIdx] = {
        ...outputsToWrite[firstIdx],
        manifestPatch: canonicalSubagentPatch,
      };
    }
  }

  const detected: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(plan.detected)) {
    if (!selectedArtifacts.has(key)) continue;
    if (key === CLAUDE_SUBAGENT_ARTIFACT_ID && Array.isArray(value)) {
      if (includedSubagentSet.size === 0) {
        detected[key] = value;
      } else {
        const filtered = value.filter((abs) =>
          includedSubagentSet.has(getSubagentIdFromSourcePath(abs)),
        );
        if (filtered.length > 0) {
          detected[key] = filtered;
        }
      }
      continue;
    }
    detected[key] = value;
  }

  if (Object.keys(detected).length === 0) {
    throw new TerrazulError(
      ErrorCode.INVALID_ARGUMENT,
      'No recognized inputs selected. Include at least one artifact before executing extract.',
    );
  }

  if (willWrite) {
    if (await pathExists(outAbs)) {
      const lst = await fs.lstat(outAbs);
      if (lst.isSymbolicLink()) {
        throw new TerrazulError(
          ErrorCode.SECURITY_VIOLATION,
          `Output path is a symlink: ${outAbs}. Refusing to use --out that points elsewhere.`,
        );
      }
      if (lst.isDirectory()) {
        if (await isNonEmptyDir(outAbs)) {
          if (execOptions.force) {
            await fs.rm(outAbs, { recursive: true, force: true });
            ensureDir(outAbs);
          } else {
            throw new TerrazulError(
              ErrorCode.FILE_EXISTS,
              `Output directory not empty: ${outAbs}. Re-run with --force or choose an empty directory.`,
            );
          }
        }
      } else {
        throw new TerrazulError(
          ErrorCode.FILE_EXISTS,
          `Output path exists and is a file: ${outAbs}. Choose a directory path or remove the file.`,
        );
      }
    } else {
      ensureDir(outAbs);
    }
  }

  const outputsWritten: string[] = [];

  if (willWrite) {
    ensureDir(outAbs);
    for (const output of outputsToWrite) {
      const dest = safeJoinWithin(outAbs, ...output.relativePath.split('/'));
      ensureDir(path.dirname(dest));
      let content: string;
      switch (output.artifactId) {
        case 'claude.mcp_servers': {
          content = JSON.stringify(mcpJson, null, 2);

          break;
        }
        case CODEX_CONFIG_ARTIFACT_ID: {
          content = renderCodexConfig(plan.codexConfigBase, selectedCodexServers);

          break;
        }
        case 'codex.mcp_servers': {
          content = renderCodexMcpServers(selectedCodexServers);

          break;
        }
        default: {
          if (output.format === 'json') {
            content = JSON.stringify(output.data ?? {}, null, 2);
          } else if (output.format === 'toml') {
            content = String(output.data ?? '');
          } else {
            content = String(output.data ?? '');
          }
        }
      }
      await fs.writeFile(dest, content, 'utf8');
      try {
        await fs.chmod(dest, 0o644);
      } catch {
        // ignore chmod errors on non-POSIX filesystems
      }
      outputsWritten.push(output.relativePath);
    }
  }

  const manifestOut = buildManifestFromOutputs(outputsToWrite);

  if (willWrite) {
    const toml = buildAgentsToml(execOptions.name, execOptions.version, manifestOut);
    const manifestPath = safeJoinWithin(outAbs, 'agents.toml');
    await fs.writeFile(manifestPath, toml, 'utf8');
    try {
      await fs.chmod(manifestPath, 0o644);
    } catch {
      // ignore chmod errors on non-POSIX filesystems
    }
    outputsWritten.push('agents.toml');
  }

  logger.info(`extract: found ${Object.keys(detected).length} artifacts`);

  return {
    summary: {
      projectRoot: plan.projectRoot,
      detected,
      outputs: outputsWritten.sort(),
      manifest: manifestOut,
      skipped: plan.skipped,
    },
  };
}

export async function performExtract(
  options: ExtractOptions,
  logger: LoggerLike,
): Promise<ExtractResult> {
  const plan = await analyzeExtractSources(options);
  const execOptions: ExecuteOptions = {
    ...options,
    includedArtifacts: Object.keys(plan.detected),
    includedMcpServers: plan.mcpServers.map((server) => server.id),
    includedSubagentFiles: getPlanSubagentIds(plan),
  };
  return await executeExtract(plan, execOptions, logger);
}
