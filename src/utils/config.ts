import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as TOML from '@iarna/toml';

import { readManifest, type ProjectManifest } from './manifest.js';
import { ErrorCode, TerrazulError } from '../core/errors.js';
import {
  DEFAULT_ENVIRONMENTS,
  UserConfigSchema,
  type EnvironmentConfig,
  type UserConfig,
} from '../types/config.js';

import type { Logger } from './logger.js';
import type { ToolSpec, ToolType } from '../types/context.js';

const CONFIG_DIRNAME = '.terrazul';
const CONFIG_FILENAME = 'config.json';

function toEpochSeconds(iso?: string): number | undefined {
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return undefined;
  return Math.floor(ms / 1000);
}

const DEFAULT_COMMANDS: Record<ToolType, string> = {
  claude: 'claude',
  codex: 'codex',
  gemini: 'gemini',
};

const DEFAULT_PROFILE_TOOLS: ToolSpec[] = [
  { type: 'claude', command: 'claude', model: 'claude-sonnet-4-5-20250929' },
  { type: 'codex', command: 'codex', args: ['exec'] },
  { type: 'gemini', command: 'gemini' },
];

function cloneToolSpec(spec: ToolSpec): ToolSpec {
  const clone: ToolSpec = {
    ...spec,
    command: spec.command,
    model: spec.model,
  };
  if (spec.args) clone.args = [...spec.args];
  if (spec.env) clone.env = { ...spec.env };
  return clone;
}

function defaultCommandFor(tool: ToolType): string {
  return DEFAULT_COMMANDS[tool];
}

function normalizeToolSpec(spec: ToolSpec): ToolSpec {
  const normalized = cloneToolSpec(spec);
  normalized.command = normalized.command ?? defaultCommandFor(normalized.type);
  if (normalized.type === 'claude' && !normalized.model) {
    normalized.model = 'claude-sonnet-4-5-20250929';
  }
  if (!normalized.args && normalized.type === 'codex') {
    normalized.args = ['exec'];
  } else if (normalized.args) {
    normalized.args = [...normalized.args];
  }
  if (normalized.env) {
    normalized.env = { ...normalized.env };
  }
  return normalized;
}

function dedupeTools(list: ToolSpec[]): ToolSpec[] {
  const seen = new Set<ToolType>();
  const out: ToolSpec[] = [];
  for (const spec of list) {
    if (seen.has(spec.type)) continue;
    seen.add(spec.type);
    out.push(normalizeToolSpec(spec));
  }
  return out;
}

export function getConfigDir(): string {
  return path.join(os.homedir(), CONFIG_DIRNAME);
}

export function getConfigPath(): string {
  return path.join(getConfigDir(), CONFIG_FILENAME);
}

async function ensureDirExists(dir: string): Promise<void> {
  try {
    await fs.mkdir(dir, {
      recursive: true,
      mode: process.platform === 'win32' ? undefined : 0o700,
    });
  } catch {
    // ignore
  }
}

export class ConfigPermissionError extends Error {
  exitCode = 5;
  constructor(message: string) {
    super(message);
    this.name = 'ConfigPermissionError';
  }
}

export interface SaveConfigOptions {
  logger?: Logger;
}

function formatDisplayPath(target: string): string {
  const home = os.homedir();
  if (target.startsWith(home)) {
    return `~${target.slice(home.length)}`;
  }
  return target;
}

async function ensurePermission(target: string, mode: number, logger?: Logger): Promise<void> {
  if (process.platform === 'win32') return;
  try {
    const stat = await fs.stat(target);
    const current = stat.mode & 0o777;
    if (current === mode) return;
    await fs.chmod(target, mode);
    const message = `Fixed insecure permissions on ${formatDisplayPath(target)}`;
    if (logger) logger.warn(message);
    else console.warn(message);
  } catch (error) {
    throw new ConfigPermissionError(
      `Failed to secure permissions on ${formatDisplayPath(target)}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function withContextFileDefaults(cfg: UserConfig): UserConfig {
  // Ensure context and files map exist and include defaults; preserve user-provided values
  const defaults = {
    claude: 'CLAUDE.md',
    codex: 'AGENTS.md',
    gemini: 'GEMINI.md',
  } as const;
  const files = (cfg.context?.files ?? {}) as Record<string, string>;
  const mergedFiles: {
    claude: string;
    codex: string;
    gemini: string;
  } = {
    claude: files.claude ?? defaults.claude,
    codex: files.codex ?? defaults.codex,
    gemini: files.gemini ?? defaults.gemini,
  };
  cfg.context = cfg.context ? { ...cfg.context, files: mergedFiles } : { files: mergedFiles };
  return cfg;
}

function withProfileDefaults(cfg: UserConfig): UserConfig {
  const existing = cfg.profile?.tools;
  const baseList: ToolSpec[] =
    existing && existing.length > 0
      ? existing.map((spec) => cloneToolSpec(spec))
      : DEFAULT_PROFILE_TOOLS.map((spec) => cloneToolSpec(spec));
  const normalized = dedupeTools(baseList);
  cfg.profile = cfg.profile ? { ...cfg.profile, tools: normalized } : { tools: normalized };
  return cfg;
}

function withAccessibilityDefaults(cfg: UserConfig): UserConfig {
  const defaults = { largeText: false, audioFeedback: false } as const;
  const current = cfg.accessibility ?? defaults;
  cfg.accessibility = {
    largeText: current.largeText ?? defaults.largeText,
    audioFeedback: current.audioFeedback ?? defaults.audioFeedback,
  };
  return cfg;
}

type RawConfigInput = Partial<UserConfig> & {
  environments?: Record<string, Partial<EnvironmentConfig>>;
};

function normalizeEnvironmentConfig(cfg: UserConfig, raw?: RawConfigInput): UserConfig {
  const environmentName =
    cfg.environment && cfg.environment.length > 0 ? cfg.environment : 'production';
  const mergedEnvironments: Record<string, EnvironmentConfig> = {
    ...DEFAULT_ENVIRONMENTS,
    ...cfg.environments,
  };

  const rawRegistry = raw?.registry;
  const activeSource = mergedEnvironments[environmentName] ?? { registry: cfg.registry };
  const resolvedRegistry =
    rawRegistry ??
    activeSource.registry ??
    raw?.environments?.[environmentName]?.registry ??
    cfg.registry ??
    DEFAULT_ENVIRONMENTS.production.registry;
  const expirySeconds =
    activeSource.tokenExpiry ??
    cfg.tokenExpiry ??
    toEpochSeconds(activeSource.tokenExpiresAt) ??
    toEpochSeconds(cfg.tokenExpiresAt);
  const activeEnv: EnvironmentConfig = {
    registry: resolvedRegistry,
    token: activeSource.token ?? cfg.token,
    tokenId: activeSource.tokenId ?? cfg.tokenId,
    tokenExpiry: expirySeconds,
    username: activeSource.username ?? cfg.username,
    tokenCreatedAt: activeSource.tokenCreatedAt ?? cfg.tokenCreatedAt,
    tokenExpiresAt: activeSource.tokenExpiresAt ?? cfg.tokenExpiresAt,
    user: activeSource.user ?? cfg.user,
  };

  mergedEnvironments[environmentName] = { ...activeEnv };

  const normalized: UserConfig = {
    ...cfg,
    environment: environmentName,
    environments: mergedEnvironments,
    registry: activeEnv.registry,
    token: activeEnv.token,
    tokenExpiry: activeEnv.tokenExpiry,
    tokenCreatedAt: activeEnv.tokenCreatedAt,
    tokenExpiresAt: activeEnv.tokenExpiresAt,
    username: activeEnv.username,
    user: activeEnv.user,
  };
  return normalized;
}

export function normalizeConfig(raw: unknown): UserConfig {
  const rawObj: RawConfigInput | undefined =
    raw && typeof raw === 'object' ? (raw as RawConfigInput) : undefined;
  const parsed = UserConfigSchema.parse(raw ?? {});
  const withEnv = normalizeEnvironmentConfig(parsed, rawObj);
  const withProfile = withProfileDefaults(withEnv);
  const withAccessibility = withAccessibilityDefaults(withProfile);
  return withContextFileDefaults(withAccessibility);
}

export async function readUserConfigFrom(file: string): Promise<UserConfig> {
  try {
    const data = await fs.readFile(file, 'utf8');
    const parsed: unknown = JSON.parse(data);
    return normalizeConfig(parsed);
  } catch {
    // If file missing or invalid, fall back to defaults
    return normalizeConfig({});
  }
}

export async function loadConfig(): Promise<UserConfig> {
  return readUserConfigFrom(getConfigPath());
}

export async function saveConfig(config: UserConfig, opts: SaveConfigOptions = {}): Promise<void> {
  const file = getConfigPath();
  const dir = path.dirname(file);
  await ensureDirExists(dir);
  const normalized = normalizeConfig(config);
  const json = JSON.stringify(normalized, null, 2) + '\n';
  const tempName = `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const tempPath = path.join(dir, tempName);
  const writeOptions =
    process.platform === 'win32'
      ? { encoding: 'utf8' as const }
      : { encoding: 'utf8' as const, mode: 0o600 };

  await fs.writeFile(tempPath, json, writeOptions);
  try {
    if (process.platform === 'win32') {
      await fs.rename(tempPath, file);
    } else {
      try {
        await fs.rename(tempPath, file);
      } catch {
        await fs.rm(file, { force: true });
        await fs.rename(tempPath, file);
      }
    }
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }

  if (process.platform !== 'win32') {
    await ensurePermission(dir, 0o700, opts.logger);
    await ensurePermission(file, 0o600, opts.logger);
  }
}

export async function updateConfig(
  patch: Partial<UserConfig>,
  opts?: SaveConfigOptions,
): Promise<UserConfig> {
  const current = await loadConfig();
  const merged = { ...current, ...patch } as UserConfig;
  // Validate before save
  const valid = normalizeConfig(merged);
  await saveConfig(valid, opts);
  return valid;
}

export function getEffectiveToken(config?: UserConfig): string | undefined {
  const envToken = process.env.TERRAZUL_TOKEN;
  if (envToken && envToken.length > 0) return envToken;
  if (!config) return undefined;
  const activeEnv = config.environments?.[config.environment];
  if (activeEnv?.token) return activeEnv.token;
  return config.token;
}

// Resolve "env:NAME" indirection for tool env specs at spawn time.
export function expandEnvVars(
  envSpec?: Record<string, string>,
): Record<string, string | undefined> | undefined {
  if (!envSpec) return undefined;
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(envSpec)) {
    out[k] = v.startsWith('env:') ? process.env[v.slice(4)] : v;
  }
  return out;
}

interface DestinationMap {
  claude: string;
  codex: string;
  gemini: string;
}

export function getProfileTools(cfg: UserConfig): ToolSpec[] {
  const tools = cfg.profile?.tools;
  if (tools && tools.length > 0) {
    return dedupeTools(tools.map((spec) => cloneToolSpec(spec)));
  }
  return dedupeTools(DEFAULT_PROFILE_TOOLS.map((spec) => cloneToolSpec(spec)));
}

function getDestinationMap(cfg: UserConfig): DestinationMap {
  const files = cfg.context?.files as DestinationMap | undefined;
  if (files) return files;
  const defaults: DestinationMap = {
    claude: 'CLAUDE.md',
    codex: 'AGENTS.md',
    gemini: 'GEMINI.md',
  };
  return defaults;
}

export interface OutputTargetOptions {
  onlyTool?: ToolType;
  overrides?: Partial<Record<ToolType, string>>;
}

export interface OutputTarget {
  tool: ToolType;
  destination: string;
}

export function computeOutputTargets(
  cfg: UserConfig,
  options: OutputTargetOptions = {},
): OutputTarget[] {
  const destinations = getDestinationMap(cfg);
  const baseTools = getProfileTools(cfg).map((spec) => spec.type);
  const order = options.onlyTool ? [options.onlyTool] : baseTools;
  const seen = new Set<ToolType>();
  const targets: OutputTarget[] = [];
  for (const tool of order) {
    if (seen.has(tool)) continue;
    seen.add(tool);
    const dest = options.overrides?.[tool] ?? destinations[tool];
    if (!dest) continue;
    targets.push({ tool, destination: dest });
  }
  if (options.onlyTool && !seen.has(options.onlyTool)) {
    const fallbackDest = options.overrides?.[options.onlyTool] ?? destinations[options.onlyTool];
    if (fallbackDest) {
      targets.push({ tool: options.onlyTool, destination: fallbackDest });
    }
  }
  return targets;
}

const ANSWER_TOOLS: ReadonlySet<ToolType> = new Set(['claude', 'codex']);

export function selectPrimaryTool(cfg: UserConfig, override?: ToolType): ToolSpec {
  const normalized = getProfileTools(cfg);
  const map = new Map<ToolType, ToolSpec>();
  for (const spec of normalized) {
    map.set(spec.type, spec);
  }

  const toSpec = (tool: ToolType): ToolSpec => {
    const existing = map.get(tool);
    if (existing) return normalizeToolSpec(existing);
    const fallback = DEFAULT_PROFILE_TOOLS.find((entry) => entry.type === tool);
    if (fallback) return normalizeToolSpec(fallback);
    return normalizeToolSpec({ type: tool });
  };

  if (override) {
    if (!ANSWER_TOOLS.has(override)) {
      throw new TerrazulError(
        ErrorCode.INVALID_ARGUMENT,
        `Unsupported answer tool override: '${override}'.`,
      );
    }
    return toSpec(override);
  }

  for (const spec of normalized) {
    if (ANSWER_TOOLS.has(spec.type)) {
      return normalizeToolSpec(spec);
    }
  }

  throw new TerrazulError(
    ErrorCode.INVALID_ARGUMENT,
    'No answer tool configured in profile.tools (expected claude or codex).',
  );
}

export interface ProjectConfigData {
  manifest: ProjectManifest;
  dependencies: Record<string, string>;
}

function assertDependencyTable(value: unknown): void {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TerrazulError(
      ErrorCode.CONFIG_INVALID,
      'Invalid [dependencies] table in agents.toml',
    );
  }
  for (const [dep, range] of Object.entries(value as Record<string, unknown>)) {
    if (typeof dep !== 'string' || dep.trim().length === 0) {
      throw new TerrazulError(ErrorCode.CONFIG_INVALID, 'Dependency names must be strings');
    }
    if (typeof range !== 'string' || range.trim().length === 0) {
      throw new TerrazulError(
        ErrorCode.CONFIG_INVALID,
        `Dependency '${dep}' must declare a version range string`,
      );
    }
  }
}

export async function loadProjectConfig(projectRoot: string): Promise<ProjectConfigData> {
  const manifestPath = path.join(projectRoot, 'agents.toml');
  let raw: string;
  try {
    raw = await fs.readFile(manifestPath, 'utf8');
  } catch {
    throw new TerrazulError(
      ErrorCode.CONFIG_NOT_FOUND,
      'agents.toml not found. Run `tz init` to create one.',
    );
  }

  let parsed: unknown;
  try {
    parsed = TOML.parse(raw);
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Invalid agents.toml';
    throw new TerrazulError(ErrorCode.CONFIG_INVALID, msg, { cause: error });
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new TerrazulError(ErrorCode.CONFIG_INVALID, 'agents.toml must be a table');
  }

  assertDependencyTable((parsed as Record<string, unknown>)['dependencies']);

  const manifest = await readManifest(projectRoot);
  if (!manifest) {
    throw new TerrazulError(ErrorCode.CONFIG_INVALID, 'Failed to parse agents.toml');
  }

  return {
    manifest,
    dependencies: manifest.dependencies ?? {},
  };
}
