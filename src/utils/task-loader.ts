import { promises as fs } from 'node:fs';
import path from 'node:path';

import { parse as parseYAML } from 'yaml';
import { z } from 'zod';

import { readManifest } from './manifest.js';
import { ErrorCode, TerrazulError, wrapError } from '../core/errors.js';

// Minimal v1 task spec; we keep steps opaque for now and validate structure only.
const TaskSpecV1Schema = z.object({
  version: z.literal('v1').optional(),
  pipeline: z.array(z.unknown()),
  resources: z.record(z.union([z.string(), z.record(z.unknown())])).optional(),
});

export type TaskSpecV1 = z.infer<typeof TaskSpecV1Schema>;

export interface InstalledTask {
  pkg: string;
  root: string;
  rel: string;
  spec: TaskSpecV1;
}

export interface InstalledAssets {
  pkg: string;
  root: string;
  templates: { claude?: string; codex?: string; gemini?: string };
}

async function readText(file: string): Promise<string> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (error) {
    throw new TerrazulError(ErrorCode.FILE_NOT_FOUND, `File not found: ${file}`, error);
  }
}

function ensureWithinRoot(pkgRoot: string, rel: string): string {
  // Always resolve from pkgRoot and verify final path is inside pkgRoot.
  const root = path.resolve(pkgRoot);
  const abs = path.resolve(root, rel);
  const normalizedRoot = root.endsWith(path.sep) ? root : root + path.sep;
  const normalizedAbs = abs.endsWith(path.sep) ? abs : abs + path.sep;
  if (!normalizedAbs.startsWith(normalizedRoot)) {
    throw new TerrazulError(ErrorCode.SECURITY_VIOLATION, `Task path escapes package root: ${rel}`);
  }
  return abs;
}

export async function loadTaskFile(pkgRoot: string, rel: string): Promise<TaskSpecV1> {
  // Reject absolute paths up front to avoid surprising behavior.
  if (path.isAbsolute(rel)) {
    throw new TerrazulError(
      ErrorCode.SECURITY_VIOLATION,
      `Task path must be relative to package root: ${rel}`,
    );
  }
  const abs = ensureWithinRoot(pkgRoot, rel);
  try {
    // If this path is a symlink, resolve and ensure the real path is also inside pkgRoot
    const lst = await fs.lstat(abs).catch(() => null);
    if (lst && lst.isSymbolicLink()) {
      const real = await fs.realpath(abs).catch(() => abs);
      const root = path.resolve(pkgRoot);
      const normalizedRoot = root.endsWith(path.sep) ? root : root + path.sep;
      const normalizedReal = real.endsWith(path.sep) ? real : real + path.sep;
      if (!normalizedReal.startsWith(normalizedRoot)) {
        throw new TerrazulError(
          ErrorCode.SECURITY_VIOLATION,
          `Task path resolves outside package root: ${rel}`,
        );
      }
    }

    const raw = await readText(abs);
    let data: unknown;
    if (/\.ya?ml$/i.test(abs)) {
      try {
        data = parseYAML(raw);
      } catch (error) {
        throw new TerrazulError(
          ErrorCode.CONFIG_INVALID,
          `Invalid YAML in task file: ${rel}`,
          error,
        );
      }
    } else if (/\.json$/i.test(abs)) {
      try {
        data = JSON.parse(raw);
      } catch (error) {
        throw new TerrazulError(
          ErrorCode.CONFIG_INVALID,
          `Invalid JSON in task file: ${rel}`,
          error,
        );
      }
    } else {
      // Try YAML first; if it fails, try JSON; otherwise report invalid ext
      try {
        data = parseYAML(raw);
      } catch {
        try {
          data = JSON.parse(raw);
        } catch (error) {
          throw new TerrazulError(
            ErrorCode.CONFIG_INVALID,
            `Unsupported or invalid task file format: ${rel}`,
            error,
          );
        }
      }
    }
    try {
      return TaskSpecV1Schema.parse(data);
    } catch (error) {
      throw new TerrazulError(
        ErrorCode.CONFIG_INVALID,
        `Invalid task spec in ${rel}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  } catch (error) {
    throw wrapError(error);
  }
}

function sortPackages(names: string[]): string[] {
  return [...names].sort((a, b) => a.localeCompare(b));
}

async function listInstalledPackageRoots(
  cwd: string,
): Promise<Array<{ name: string; root: string }>> {
  const agentModules = path.join(cwd, 'agent_modules');
  const out: Array<{ name: string; root: string }> = [];
  try {
    const level1 = await fs.readdir(agentModules, { withFileTypes: true });
    for (const d1 of level1) {
      if (!d1.isDirectory()) continue;
      if (d1.name.startsWith('@')) {
        // scoped packages
        const scopeDir = path.join(agentModules, d1.name);
        const scoped = await fs.readdir(scopeDir, { withFileTypes: true });
        for (const d2 of scoped) {
          if (!d2.isDirectory()) continue;
          const name = `${d1.name}/${d2.name}`;
          out.push({ name, root: path.join(scopeDir, d2.name) });
        }
      } else {
        const name = d1.name;
        out.push({ name, root: path.join(agentModules, d1.name) });
      }
    }
  } catch {
    // if agent_modules doesn't exist, return empty
  }
  // Deterministic order
  return sortPackages(out.map((x) => x.name)).map((name) => out.find((x) => x.name === name)!);
}

export async function findTask(cwd: string, id: string): Promise<InstalledTask | null> {
  const pkgs = await listInstalledPackageRoots(cwd);
  for (const p of pkgs) {
    const m = await readManifest(p.root);
    const rel = m?.tasks?.[id];
    if (!rel) continue;
    try {
      const spec = await loadTaskFile(p.root, rel);
      return { pkg: p.name, root: p.root, rel, spec };
    } catch (error) {
      // If task is declared but invalid/missing, propagate error to surface the issue
      throw wrapError(error);
    }
  }
  return null;
}

export async function findAssets(cwd: string): Promise<InstalledAssets[]> {
  const pkgs = await listInstalledPackageRoots(cwd);
  const out: InstalledAssets[] = [];
  for (const p of pkgs) {
    const m = await readManifest(p.root);
    const exp = m?.exports as
      | undefined
      | { [k: string]: { template?: string; [key: string]: unknown } };
    if (!exp) continue;
    const templates: InstalledAssets['templates'] = {};
    if (exp.codex?.template && typeof exp.codex.template === 'string')
      templates.codex = exp.codex.template;
    if (exp.claude?.template && typeof exp.claude.template === 'string')
      templates.claude = exp.claude.template;
    if (exp.gemini?.template && typeof exp.gemini.template === 'string')
      templates.gemini = exp.gemini.template;
    if (Object.keys(templates).length > 0) {
      out.push({ pkg: p.name, root: p.root, templates });
    }
  }
  return out;
}
