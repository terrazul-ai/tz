/**
 * Symlink Manager
 * Handles creating and tracking symlinks from agent_modules to .claude/
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { createSymlink, exists } from '../utils/fs.js';

import type { ToolType } from '../types/context.js';

export interface RenderedFile {
  pkgName: string;
  source: string;
  tool: ToolType;
  isMcpConfig: boolean;
}

export interface SymlinkRegistry {
  // Map of symlink path to source package and file
  symlinks: Record<
    string,
    {
      package: string;
      source: string;
      tool: ToolType;
      created: string; // ISO timestamp
    }
  >;
}

export interface CreateSymlinksOptions {
  /**
   * Only create symlinks for packages in this list
   */
  packages?: string[];
  /**
   * Dry run mode - don't actually create symlinks
   */
  dryRun?: boolean;
  /**
   * Project root directory
   */
  projectRoot: string;
  /**
   * Path to symlink registry file
   */
  registryPath?: string;
  /**
   * Rendered files metadata (contains tool, isMcpConfig info)
   */
  renderedFiles?: RenderedFile[];
  /**
   * Active tool to create symlinks for (default: 'claude')
   */
  activeTool?: ToolType;
}

/**
 * Create namespaced symlinks from agent_modules to .claude/ directories
 * Uses rendered files metadata to determine which files to symlink
 * Filters out CLAUDE.md/AGENTS.md (those are @-mentioned) and MCP configs
 */
export async function createSymlinks(options: CreateSymlinksOptions): Promise<{
  created: string[];
  skipped: string[];
  errors: Array<{ path: string; error: string }>;
}> {
  const {
    projectRoot,
    packages,
    dryRun = false,
    renderedFiles = [],
    activeTool = 'claude',
  } = options;
  const registryPath = options.registryPath ?? path.join(projectRoot, '.terrazul', 'symlinks.json');

  const claudeRoot = path.join(projectRoot, '.claude');

  const created: string[] = [];
  const skipped: string[] = [];
  const errors: Array<{ path: string; error: string }> = [];

  // Load existing registry
  let registry: SymlinkRegistry = { symlinks: {} };
  if (exists(registryPath)) {
    try {
      const content = await fs.readFile(registryPath, 'utf8');
      registry = JSON.parse(content) as SymlinkRegistry;
    } catch {
      // Invalid or missing registry, start fresh
      registry = { symlinks: {} };
    }
  }

  // Filter rendered files by:
  // 1. Active tool only
  // 2. Specified packages (if provided)
  // 3. Not MCP configs
  let filesToProcess = renderedFiles.filter((f) => f.tool === activeTool);

  if (packages && packages.length > 0) {
    filesToProcess = filesToProcess.filter((f) => packages.includes(f.pkgName));
  }

  // Directories to check for symlinkable files
  const operationalDirs = ['agents', 'commands', 'hooks', 'skills'];

  for (const file of filesToProcess) {
    const { pkgName, source, isMcpConfig } = file;

    // Skip MCP configs (passed via metadata)
    if (isMcpConfig) {
      skipped.push(source);
      continue;
    }

    // Skip CLAUDE.md, AGENTS.md (those are @-mentioned)
    const basename = path.basename(source);
    if (basename === 'CLAUDE.md' || basename === 'AGENTS.md') {
      skipped.push(source);
      continue;
    }

    // Find which operational directory this file belongs to
    // Support nested structures: e.g., claude/agents/, claude/deep/agents/, or flat agents/
    let targetDirName: string | null = null;
    for (const dirName of operationalDirs) {
      // Check if source path contains /{dirName}/ anywhere
      const pathParts = source.split(path.sep);
      if (pathParts.includes(dirName)) {
        targetDirName = dirName;
        break;
      }
    }

    // Skip files not in operational directories
    if (!targetDirName) {
      continue;
    }

    // Generate namespaced symlink path
    const namespacedName = generateNamespacedPath(pkgName, basename);
    const symlinkPath = path.join(claudeRoot, targetDirName, namespacedName);

    // Check if symlink already exists and points to same source
    const relSymlinkPath = path.relative(projectRoot, symlinkPath);
    if (
      registry.symlinks[relSymlinkPath]?.source === source &&
      registry.symlinks[relSymlinkPath]?.tool === activeTool && // Verify symlink actually exists on disk before skipping
      exists(symlinkPath)
    ) {
      skipped.push(symlinkPath);
      continue;
    }
    // Registry entry exists but symlink is missing - will recreate below

    // Create symlink
    if (dryRun) {
      created.push(symlinkPath);
    } else {
      try {
        await createSymlink(source, symlinkPath);

        // Update registry
        registry.symlinks[relSymlinkPath] = {
          package: pkgName,
          source,
          tool: activeTool,
          created: new Date().toISOString(),
        };

        created.push(symlinkPath);
      } catch (error) {
        errors.push({
          path: symlinkPath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  // Save registry
  if (!dryRun && (created.length > 0 || Object.keys(registry.symlinks).length > 0)) {
    await fs.mkdir(path.dirname(registryPath), { recursive: true });
    await fs.writeFile(registryPath, JSON.stringify(registry, null, 2), 'utf8');
  }

  return { created, skipped, errors };
}

/**
 * Remove symlinks for a specific package
 */
export async function removeSymlinks(
  projectRoot: string,
  packageName: string,
): Promise<{
  removed: string[];
  errors: Array<{ path: string; error: string }>;
}> {
  const registryPath = path.join(projectRoot, '.terrazul', 'symlinks.json');
  const removed: string[] = [];
  const errors: Array<{ path: string; error: string }> = [];

  // Load registry
  if (!exists(registryPath)) {
    return { removed, errors };
  }

  let registry: SymlinkRegistry;
  try {
    const content = await fs.readFile(registryPath, 'utf8');
    registry = JSON.parse(content) as SymlinkRegistry;
  } catch {
    return { removed, errors };
  }

  // Find and remove symlinks for this package
  const toRemove: string[] = [];
  for (const [symlinkPath, info] of Object.entries(registry.symlinks)) {
    if (info.package === packageName) {
      toRemove.push(symlinkPath);
    }
  }

  for (const relPath of toRemove) {
    const absPath = path.join(projectRoot, relPath);

    try {
      if (exists(absPath)) {
        await fs.rm(absPath, { recursive: true, force: true });
        removed.push(absPath);
      }

      // Remove from registry
      delete registry.symlinks[relPath];
    } catch (error) {
      errors.push({
        path: absPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Save updated registry
  await fs.writeFile(registryPath, JSON.stringify(registry, null, 2), 'utf8');

  return { removed, errors };
}

/**
 * Generate a namespaced path for a file from a package
 * Example: @scope/pkg + "agents/foo.md" => "@scope-pkg-foo.md"
 */
function generateNamespacedPath(pkgName: string, relativePath: string): string {
  // Normalize package name: @scope/pkg => @scope-pkg
  const normalizedPkg = pkgName.replaceAll('/', '-');

  // Get filename without extension
  const basename = path.basename(relativePath);

  // Combine: @scope-pkg-filename.ext
  return `${normalizedPkg}-${basename}`;
}
