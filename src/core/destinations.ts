import { promises as fs, type Stats } from 'node:fs';
import path from 'node:path';

import { ErrorCode, TerrazulError } from './errors.js';
import { resolveWithin } from '../utils/path.js';

import type { ToolType } from '../types/context.js';

export const DIRECTORY_DEFAULT_FILENAMES: Record<ToolType, string> = {
  claude: 'CLAUDE.md',
  codex: 'AGENTS.md',
  cursor: 'rules.mdc',
  copilot: 'instructions.md',
  gemini: 'GEMINI.md',
};

export function safeResolveWithin(base: string, rel: string): string {
  try {
    return resolveWithin(base, rel);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new TerrazulError(ErrorCode.SECURITY_VIOLATION, message);
  }
}

export interface ResolveWritePathOptions {
  projectDir: string;
  value: unknown;
  tool: ToolType;
  contextFiles: Record<string, string>;
}

export function resolveWritePath(options: ResolveWritePathOptions): {
  path: string;
  tool?: ToolType;
} {
  const { projectDir, value, tool, contextFiles } = options;
  if (typeof value === 'string' && value.length > 0) {
    return { path: safeResolveWithin(projectDir, value) };
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record[tool] === 'string' && record[tool].length > 0) {
      return { path: safeResolveWithin(projectDir, String(record[tool])), tool };
    }
    const candidate = record.default;
    if (typeof candidate === 'string' && candidate.length > 0) {
      return { path: safeResolveWithin(projectDir, candidate) };
    }
  }
  const fallback = contextFiles[tool];
  if (typeof fallback === 'string' && fallback.length > 0) {
    return { path: safeResolveWithin(projectDir, fallback), tool };
  }
  throw new TerrazulError(ErrorCode.INVALID_ARGUMENT, 'Destination path is required');
}

export async function ensureFileDestination(
  dest: string,
  tool: ToolType,
  projectDir: string,
): Promise<string> {
  const stats = await statMaybe(dest);
  if (!stats) return dest;

  let directoryPath: string | undefined;
  if (stats.isDirectory()) {
    directoryPath = dest;
  } else if (stats.isSymbolicLink()) {
    const real = await fs.realpath(dest).catch(() => null);
    if (!real) return dest;
    const realStats = await statMaybe(real);
    if (!realStats || !realStats.isDirectory()) return dest;
    directoryPath = real;
  } else {
    return dest;
  }

  const filename = DIRECTORY_DEFAULT_FILENAMES[tool] ?? 'output.md';
  let target: string;
  try {
    target = resolveWithin(directoryPath, filename);
  } catch {
    return dest;
  }
  try {
    return resolveWithin(projectDir, path.relative(projectDir, target));
  } catch {
    return dest;
  }
}

async function statMaybe(p: string): Promise<Stats | null> {
  try {
    return await fs.lstat(p);
  } catch {
    return null;
  }
}
