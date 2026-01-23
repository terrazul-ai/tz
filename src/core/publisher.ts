import { promises as fs } from 'node:fs';
import path from 'node:path';

import * as tar from 'tar';

import { TerrazulError, ErrorCode } from './errors.js';
import { readManifest, validateManifest } from '../utils/manifest.js';
import { resolveWithin } from '../utils/path.js';

import type { Stats } from 'node:fs';

// removed: use resolveWithin instead

async function safeStat(p: string): Promise<Stats | null> {
  try {
    return await fs.lstat(p);
  } catch {
    return null;
  }
}

export interface PublishPlan {
  name: string;
  version: string;
  files: string[]; // relative paths from root
  sizeEstimate: number; // sum of file sizes (pre-gzip)
}

/**
 * Recursively add all files from a directory to the allowed list.
 * Skips symlinks for security.
 */
async function addDirectoryRecursively(
  root: string,
  dirRel: string,
  allowed: string[],
): Promise<void> {
  const dirAbs = path.join(root, dirRel);
  const stat = await safeStat(dirAbs);
  if (!stat || !stat.isDirectory()) return;

  const stack: string[] = [dirRel];
  while (stack.length > 0) {
    const rel = stack.pop()!;
    const abs = path.join(root, rel);
    const entries = await fs.readdir(abs, { withFileTypes: true });
    for (const ent of entries) {
      const relChild = path.join(rel, ent.name);
      const absChild = path.join(abs, ent.name);
      const lst = await fs.lstat(absChild);
      if (lst.isSymbolicLink()) continue; // skip symlinks for safety
      if (lst.isDirectory()) stack.push(relChild);
      else if (lst.isFile()) allowed.push(relChild);
    }
  }
}

/**
 * Check if a path is already under templates/ directory.
 */
function isUnderTemplates(relPath: string): boolean {
  const normalized = relPath.replaceAll('\\', '/');
  return normalized === 'templates' || normalized.startsWith('templates/');
}

export async function collectPackageFiles(root: string): Promise<string[]> {
  // Allowlist: agents.toml, README.md, templates/**, and directories from exports
  const allowed: string[] = [];

  const addIfFile = async (rel: string): Promise<void> => {
    const abs = path.join(root, rel);
    const st = await safeStat(abs);
    if (st && st.isFile()) allowed.push(rel);
  };

  await addIfFile('agents.toml');
  await addIfFile('README.md');

  // templates/** recursively
  await addDirectoryRecursively(root, 'templates', allowed);

  // Include directories from manifest exports that are NOT under templates/
  const manifest = await readManifest(root);
  if (manifest?.exports) {
    const dirExportKeys = ['subagentsDir', 'commandsDir', 'skillsDir', 'promptsDir'];
    const addedDirs = new Set<string>();

    for (const toolExports of Object.values(manifest.exports)) {
      if (!toolExports) continue;
      for (const key of dirExportKeys) {
        const dir = toolExports[key];
        if (typeof dir === 'string' && dir.trim() !== '') {
          // Normalize the directory path
          const normalizedDir = dir.replaceAll('\\', '/').replace(/\/+$/, '');
          // Skip if already under templates/ or already processed
          if (!isUnderTemplates(normalizedDir) && !addedDirs.has(normalizedDir)) {
            addedDirs.add(normalizedDir);
            await addDirectoryRecursively(root, normalizedDir, allowed);
          }
        }
      }
    }
  }

  // Deterministic order, deduplicated
  const unique = [...new Set(allowed)];
  return unique.sort((a, b) => a.localeCompare(b));
}

export async function createTarball(root: string, files: string[]): Promise<Buffer> {
  // Validate all files under root and no traversal
  for (const rel of files) {
    if (path.isAbsolute(rel) || rel.includes('..')) {
      throw new TerrazulError(ErrorCode.INVALID_PACKAGE, `Invalid file path in package: ${rel}`);
    }
    let abs: string;
    try {
      abs = resolveWithin(root, rel);
    } catch {
      throw new TerrazulError(ErrorCode.INVALID_PACKAGE, `Path escapes root: ${rel}`);
    }
    const st = await safeStat(abs);
    if (!st || !st.isFile()) {
      throw new TerrazulError(ErrorCode.FILE_NOT_FOUND, `Missing file: ${rel}`);
    }
  }

  // Use tar portable/noMtime for determinism. Do not apply a filter here since
  // we already provide the explicit file list; filtering can accidentally drop
  // entries due to path normalization differences.
  return await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const stream = tar.create(
      {
        cwd: root,
        gzip: true,
        portable: true,
        noMtime: true,
      },
      files,
    );
    stream.on('data', (b: Buffer) => chunks.push(b));
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

export async function validateForPublish(
  root: string,
): Promise<{ name: string; version: string; warnings: string[] }> {
  const manifest = await readManifest(root);
  if (!manifest || !manifest.package?.name || !manifest.package?.version) {
    throw new TerrazulError(
      ErrorCode.INVALID_PACKAGE,
      'agents.toml must include [package] name and version',
    );
  }
  const { warnings, errors } = await validateManifest(root, manifest);
  if (errors.length > 0) {
    throw new TerrazulError(
      ErrorCode.INVALID_PACKAGE,
      `Manifest validation failed:\n- ${errors.join('\n- ')}`,
    );
  }
  return { name: manifest.package.name, version: manifest.package.version, warnings };
}

export async function buildPublishPlan(root: string): Promise<PublishPlan> {
  const { name, version } = await validateForPublish(root);
  const files = await collectPackageFiles(root);
  if (files.length === 0) {
    throw new TerrazulError(ErrorCode.INVALID_PACKAGE, 'No files to publish');
  }
  let size = 0;
  for (const rel of files) {
    const st = await fs.stat(path.join(root, rel));
    size += st.size;
  }
  return { name, version, files, sizeEstimate: size };
}
