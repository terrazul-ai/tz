import { promises as fs } from 'node:fs';
import path from 'node:path';

import * as TOML from '@iarna/toml';
import { z } from 'zod';

import { PackageNameSchema } from '../types/package.js';

export type ToolName = 'claude' | 'codex' | 'cursor' | 'copilot';

export interface ExportEntry {
  template?: string;
  /** Directory containing agent subfiles (e.g., templates/agents) */
  subagentsDir?: string;
  /** Directory containing command files (e.g., templates/commands) */
  commandsDir?: string;
  /** Directory containing skill files (e.g., templates/skills) */
  skillsDir?: string;
  /** Directory containing prompt files for askAgent snippets (e.g., templates/prompts) */
  promptsDir?: string;
  // Keep unknown keys to allow forward-compat while warning
  [key: string]: unknown;
}

/** Tool types that support spawning/running (answer tools) */
export type AnswerToolName = 'claude' | 'codex';

export interface ProjectManifest {
  package?: {
    name?: string;
    version?: string;
    description?: string;
    homepage?: string;
    repository?: string;
    documentation?: string;
    license?: string;
    keywords?: string[];
    authors?: string[];
    is_private?: boolean;
    /** Default tool to use when running this package (overrides user config) */
    tool?: AnswerToolName;
  };
  dependencies?: Record<string, string>;
  compatibility?: Record<string, string>;
  tasks?: Record<string, string>;
  exports?: Partial<Record<string, ExportEntry>>;
  profiles?: Record<string, string[]>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((k) => typeof k === 'string');
}

const ExportEntrySchema = z
  .object({
    template: z.string().min(1).optional(),
  })
  .catchall(z.any());

const AnswerToolSchema = z.enum(['claude', 'codex']);

const ManifestSchema = z.object({
  package: z
    .object({
      name: PackageNameSchema.optional(),
      version: z.string().min(1).optional(),
      description: z.string().optional(),
      homepage: z.string().optional(),
      repository: z.string().optional(),
      documentation: z.string().optional(),
      license: z.string().optional(),
      keywords: z.array(z.string()).optional(),
      authors: z.array(z.string()).optional(),
      is_private: z.boolean().optional(),
      tool: AnswerToolSchema.optional(),
    })
    .partial()
    .optional(),
  dependencies: z.record(z.string()).optional(),
  compatibility: z.record(z.string()).optional(),
  tasks: z.record(z.string()).optional(),
  // Allow unknown tools as keys; we will warn on them later during validation
  exports: z.record(ExportEntrySchema).optional(),
  profiles: z.record(z.array(z.string())).optional(),
});

export async function readManifest(projectDir: string): Promise<ProjectManifest | null> {
  const manifestPath = path.join(projectDir, 'agents.toml');
  try {
    const content = await fs.readFile(manifestPath, 'utf8');
    const parsedUnknown = TOML.parse(content);

    const parsed: Record<string, unknown> = isRecord(parsedUnknown) ? parsedUnknown : {};

    const rawDeps = parsed['dependencies'] ?? {};
    const rawPkg = parsed['package'] ?? {};
    const rawCompat = parsed['compatibility'] ?? {};
    const rawTasks = parsed['tasks'] ?? {};
    const rawExports = parsed['exports'] ?? {};
    const rawProfiles = parsed['profiles'] ?? {};

    const deps: Record<string, string> = {};
    if (isRecord(rawDeps)) {
      for (const [key, value] of Object.entries(rawDeps)) {
        if (typeof key === 'string' && typeof value === 'string') {
          deps[key] = value;
        }
      }
    }

    const pkgObj: Record<string, unknown> = isRecord(rawPkg) ? rawPkg : {};

    const compat: Record<string, string> = {};
    if (isRecord(rawCompat)) {
      for (const [key, value] of Object.entries(rawCompat)) {
        if (typeof key === 'string' && typeof value === 'string') {
          compat[key] = value;
        }
      }
    }

    const tasks: Record<string, string> = {};
    if (isRecord(rawTasks)) {
      for (const [key, value] of Object.entries(rawTasks)) {
        if (typeof key === 'string' && typeof value === 'string') {
          tasks[key] = value;
        }
      }
    }

    // Export entries may be nested tables (e.g., exports.codex.template)
    const exp: Record<string, ExportEntry> = {};
    if (isRecord(rawExports)) {
      for (const [toolKey, sub] of Object.entries(rawExports)) {
        if (isRecord(sub)) {
          const entry: ExportEntry = {};
          if (typeof sub['template'] === 'string') entry.template = sub['template'];
          // Preserve any extra keys for forward-compatibility
          for (const [k, v] of Object.entries(sub)) {
            if (k !== 'template') entry[k] = v;
          }
          exp[toolKey] = entry;
        }
      }
    }

    const profiles: Record<string, string[]> = {};
    if (isRecord(rawProfiles)) {
      for (const [profileName, value] of Object.entries(rawProfiles)) {
        if (Array.isArray(value)) {
          const deduped = [
            ...new Set(value.filter((entry): entry is string => typeof entry === 'string')),
          ];
          if (deduped.length > 0) {
            deduped.sort();
            profiles[profileName] = deduped;
          }
        }
      }
    }

    // Parse tool field - must be 'claude' or 'codex'
    const rawTool = pkgObj.tool;
    const parsedTool: AnswerToolName | undefined =
      rawTool === 'claude' || rawTool === 'codex' ? rawTool : undefined;

    const manifest: ProjectManifest = {
      package: {
        name: typeof pkgObj.name === 'string' ? pkgObj.name : undefined,
        version: typeof pkgObj.version === 'string' ? pkgObj.version : undefined,
        description: typeof pkgObj.description === 'string' ? pkgObj.description : undefined,
        homepage: typeof pkgObj.homepage === 'string' ? pkgObj.homepage : undefined,
        repository: typeof pkgObj.repository === 'string' ? pkgObj.repository : undefined,
        documentation: typeof pkgObj.documentation === 'string' ? pkgObj.documentation : undefined,
        license: typeof pkgObj.license === 'string' ? pkgObj.license : undefined,
        keywords: isStringArray(pkgObj.keywords) ? pkgObj.keywords : undefined,
        authors: isStringArray(pkgObj.authors) ? pkgObj.authors : undefined,
        is_private: typeof pkgObj.is_private === 'boolean' ? pkgObj.is_private : undefined,
        tool: parsedTool,
      },
      dependencies: Object.keys(deps).length > 0 ? deps : undefined,
      compatibility: Object.keys(compat).length > 0 ? compat : undefined,
      tasks: Object.keys(tasks).length > 0 ? tasks : undefined,
      exports: Object.keys(exp).length > 0 ? exp : undefined,
      profiles: Object.keys(profiles).length > 0 ? profiles : undefined,
    };

    // Run a light structural validation using Zod to ensure shapes are correct
    ManifestSchema.parse(manifest);
    return manifest;
  } catch {
    return null;
  }
}

/**
 * Validate manifest for ctx-gen specific concerns.
 * - Unknown keys under [exports] -> warnings
 * - Missing files referenced by [tasks]/[exports] -> errors
 */
export async function validateManifest(
  projectDir: string,
  manifest: ProjectManifest,
): Promise<{ warnings: string[]; errors: string[] }> {
  const warnings: string[] = [];
  const errors: string[] = [];

  const validTools: ToolName[] = ['claude', 'codex', 'cursor', 'copilot'];
  const validProps = new Set([
    'template',
    'subagentsDir',
    'commandsDir',
    'skillsDir',
    'promptsDir',
    'settings',
    'settingsLocal',
    'mcpServers',
  ]);

  // Exports: warn on unknown tool keys and unknown properties
  const exp = manifest.exports ?? {};
  for (const [tool, entry] of Object.entries(exp)) {
    if (!validTools.includes(tool as ToolName)) {
      warnings.push(`Unknown tool key under [exports]: '${tool}' (ignored)`);
      continue;
    }
    if (isRecord(entry)) {
      for (const k of Object.keys(entry)) {
        if (!validProps.has(k) && entry[k] !== undefined) {
          warnings.push(`Unknown property under [exports.${tool}]: '${k}'`);
        }
      }
    }
  }

  // Tasks: each referenced spec file must exist
  const tasks = manifest.tasks ?? {};
  for (const [taskId, rel] of Object.entries(tasks)) {
    // Enforce that task paths are relative and remain within the package root
    if (path.isAbsolute(rel)) {
      errors.push(`Task path must be relative to package root for '${taskId}': ${rel}`);
      continue;
    }
    const root = path.resolve(projectDir);
    const abs = path.resolve(root, rel);
    const normRoot = root.endsWith(path.sep) ? root : root + path.sep;
    const normAbs = abs.endsWith(path.sep) ? abs : abs + path.sep;
    if (!normAbs.startsWith(normRoot)) {
      errors.push(`Task path escapes package root for '${taskId}': ${rel}`);
      continue;
    }
    try {
      const lst = await fs.lstat(abs);
      // If a symlink, ensure it resolves within the package root as well
      if (lst.isSymbolicLink()) {
        try {
          const real = await fs.realpath(abs);
          const normReal = real.endsWith(path.sep) ? real : real + path.sep;
          if (!normReal.startsWith(normRoot)) {
            errors.push(`Task path resolves outside package root for '${taskId}': ${rel}`);
            continue;
          }
        } catch {
          // If realpath fails, treat as missing
          errors.push(`Missing task file for '${taskId}': ${rel}`);
          continue;
        }
      }
    } catch {
      errors.push(`Missing task file for '${taskId}': ${rel}`);
      continue;
    }
  }

  // Exports: each known tool with a template must resolve to a file and stay within package root
  for (const t of validTools) {
    const entry = exp[t];
    if (!entry || typeof entry.template !== 'string') continue;
    const rel = entry.template;
    if (path.isAbsolute(rel)) {
      errors.push(`Template path must be relative under [exports.${t}.template]: ${rel}`);
      continue;
    }
    const root = path.resolve(projectDir);
    const abs = path.resolve(root, rel);
    const normRoot = root.endsWith(path.sep) ? root : root + path.sep;
    const normAbs = abs.endsWith(path.sep) ? abs : abs + path.sep;
    if (!normAbs.startsWith(normRoot)) {
      errors.push(`Template path escapes package root under [exports.${t}.template]: ${rel}`);
      continue;
    }
    try {
      const lst = await fs.lstat(abs);
      if (lst.isSymbolicLink()) {
        const real = await fs.realpath(abs);
        const normReal = real.endsWith(path.sep) ? real : real + path.sep;
        if (!normReal.startsWith(normRoot)) {
          errors.push(
            `Template path resolves outside package root under [exports.${t}.template]: ${rel}`,
          );
          continue;
        }
      }
    } catch {
      // lstat failure or missing file will be reported as missing below
    }
    try {
      await fs.stat(abs);
    } catch {
      errors.push(`Missing template for [exports.${t}.template]: ${rel}`);
    }
  }

  return { warnings, errors };
}

/**
 * Add or update a dependency in the manifest (idempotent)
 * @returns true if the manifest was modified, false otherwise
 */
export async function addOrUpdateDependency(
  projectDir: string,
  packageName: string,
  versionRange: string,
): Promise<boolean> {
  const manifestPath = path.join(projectDir, 'agents.toml');

  let raw: string;
  try {
    raw = await fs.readFile(manifestPath, 'utf8');
  } catch {
    return false;
  }

  let parsed: unknown;
  try {
    parsed = TOML.parse(raw);
  } catch {
    return false;
  }

  if (!isRecord(parsed)) {
    return false;
  }

  // Initialize dependencies section if it doesn't exist
  if (!parsed['dependencies']) {
    parsed['dependencies'] = {};
  }

  const depsRaw = parsed['dependencies'];
  if (!isRecord(depsRaw)) {
    return false;
  }

  const deps: Record<string, string> = {};
  for (const [name, value] of Object.entries(depsRaw)) {
    if (typeof value === 'string') deps[name] = value;
  }

  // Check if we need to add/update
  const existing = deps[packageName];
  if (existing === versionRange) {
    return false; // No change needed
  }

  // Add or update the dependency
  deps[packageName] = versionRange;

  // Sort dependencies alphabetically for deterministic output
  const sortedDeps: Record<string, string> = {};
  for (const key of Object.keys(deps).sort()) {
    sortedDeps[key] = deps[key];
  }
  parsed['dependencies'] = sortedDeps;

  const tomlOut = TOML.stringify(parsed as unknown as TOML.JsonMap);
  await fs.writeFile(manifestPath, tomlOut, 'utf8');
  return true;
}

export async function removeDependenciesFromManifest(
  projectDir: string,
  packagesToRemove: Iterable<string>,
): Promise<boolean> {
  const manifestPath = path.join(projectDir, 'agents.toml');

  let raw: string;
  try {
    raw = await fs.readFile(manifestPath, 'utf8');
  } catch {
    return false;
  }

  let parsed: unknown;
  try {
    parsed = TOML.parse(raw);
  } catch {
    return false;
  }

  if (!isRecord(parsed)) {
    return false;
  }

  const depsRaw = parsed['dependencies'];
  if (!isRecord(depsRaw)) {
    return false;
  }

  const deps: Record<string, string> = {};
  for (const [name, value] of Object.entries(depsRaw)) {
    if (typeof value === 'string') deps[name] = value;
  }

  let changed = false;
  const removals = new Set(packagesToRemove);
  for (const name of removals) {
    if (name in deps) {
      delete deps[name];
      changed = true;
    }
  }

  if (!changed) {
    return false;
  }

  if (Object.keys(deps).length === 0) {
    delete parsed['dependencies'];
  } else {
    const sortedDeps: Record<string, string> = {};
    for (const key of Object.keys(deps).sort()) {
      sortedDeps[key] = deps[key];
    }
    parsed['dependencies'] = sortedDeps;
  }

  const tomlOut = TOML.stringify(parsed as unknown as TOML.JsonMap);
  await fs.writeFile(manifestPath, tomlOut, 'utf8');
  return true;
}

function normalizeProfileEntries(existing: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!isRecord(existing)) return out;
  for (const [key, value] of Object.entries(existing)) {
    if (!Array.isArray(value)) continue;
    const entries = value.filter((entry): entry is string => typeof entry === 'string');
    if (entries.length === 0) continue;
    const unique = [...new Set(entries)];
    unique.sort();
    out[key] = unique;
  }
  return out;
}

export async function addPackageToProfile(
  projectDir: string,
  profileName: string,
  packageName: string,
): Promise<boolean> {
  const manifestPath = path.join(projectDir, 'agents.toml');
  let raw: string;
  try {
    raw = await fs.readFile(manifestPath, 'utf8');
  } catch {
    return false;
  }

  let parsed: unknown;
  try {
    parsed = TOML.parse(raw);
  } catch {
    return false;
  }

  if (!isRecord(parsed)) {
    return false;
  }

  const normalized = normalizeProfileEntries(parsed['profiles']);
  const existing = normalized[profileName] ?? [];
  if (existing.includes(packageName)) {
    return false;
  }

  const next = new Set(existing);
  next.add(packageName);
  normalized[profileName] = [...next].sort();

  const sortedProfiles: Record<string, string[]> = {};
  for (const key of Object.keys(normalized).sort()) {
    sortedProfiles[key] = normalized[key];
  }

  parsed['profiles'] = sortedProfiles;
  const tomlOut = TOML.stringify(parsed as unknown as TOML.JsonMap);
  await fs.writeFile(manifestPath, tomlOut, 'utf8');
  return true;
}

export async function removePackageFromProfiles(
  projectDir: string,
  packageName: string,
): Promise<boolean> {
  const manifestPath = path.join(projectDir, 'agents.toml');
  let raw: string;
  try {
    raw = await fs.readFile(manifestPath, 'utf8');
  } catch {
    return false;
  }

  let parsed: unknown;
  try {
    parsed = TOML.parse(raw);
  } catch {
    return false;
  }

  if (!isRecord(parsed)) {
    return false;
  }

  const normalized = normalizeProfileEntries(parsed['profiles']);
  let changed = false;
  for (const key of Object.keys(normalized)) {
    const next = normalized[key].filter((entry) => entry !== packageName);
    if (next.length !== normalized[key].length) {
      changed = true;
      if (next.length === 0) {
        delete normalized[key];
      } else {
        normalized[key] = [...new Set(next)].sort();
      }
    }
  }

  if (!changed) {
    return false;
  }

  if (Object.keys(normalized).length === 0) {
    delete parsed['profiles'];
  } else {
    const sortedProfiles: Record<string, string[]> = {};
    for (const key of Object.keys(normalized).sort()) {
      sortedProfiles[key] = normalized[key];
    }
    parsed['profiles'] = sortedProfiles;
  }

  const tomlOut = TOML.stringify(parsed as unknown as TOML.JsonMap);
  await fs.writeFile(manifestPath, tomlOut, 'utf8');
  return true;
}
