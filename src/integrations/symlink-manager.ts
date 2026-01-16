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
  /**
   * When true, remove symlinks from packages NOT in the target list.
   * Use this for exclusive package runs (e.g., tz run @scope/pkg).
   */
  exclusive?: boolean;
}

/**
 * Find the skill root directory from a source file path.
 * Skills are always immediate children of the skills/ directory.
 * Handles nested subdirectories (resources/, templates/, etc.)
 *
 * @param sourcePath - Path to a file within a skill directory
 * @returns Skill info { skillDir, skillName } or null if invalid
 *
 * @example
 * // Direct file in skill root
 * findSkillRootDirectory('agent_modules/@pkg/claude/skills/my-skill/SKILL.md')
 * // => { skillDir: 'agent_modules/@pkg/claude/skills/my-skill', skillName: 'my-skill' }
 *
 * // Nested file in subdirectory
 * findSkillRootDirectory('agent_modules/@pkg/claude/skills/my-skill/resources/ref.md')
 * // => { skillDir: 'agent_modules/@pkg/claude/skills/my-skill', skillName: 'my-skill' }
 */
function findSkillRootDirectory(
  sourcePath: string,
): { skillDir: string; skillName: string } | null {
  const pathParts = sourcePath.split(path.sep);
  const skillsIndex = pathParts.indexOf('skills');

  // Invalid: 'skills' not found, or no directory after 'skills'
  if (skillsIndex === -1 || skillsIndex >= pathParts.length - 1) {
    return null;
  }

  // Skill root is the immediate child of skills/
  const skillName = pathParts[skillsIndex + 1];
  const skillDir = pathParts.slice(0, skillsIndex + 2).join(path.sep);

  return { skillDir, skillName };
}

/**
 * Check if a symlink should be skipped (already exists and points to correct source)
 *
 * @param symlinkPath - Absolute path to the symlink
 * @param sourceDir - Absolute path to the source directory/file
 * @param activeTool - Current active tool
 * @param projectRoot - Project root directory
 * @param registry - Symlink registry
 * @returns true if should skip, false if should create
 */
function shouldSkipSymlink(
  symlinkPath: string,
  sourceDir: string,
  activeTool: ToolType,
  projectRoot: string,
  registry: SymlinkRegistry,
): boolean {
  const relSymlinkPath = path.relative(projectRoot, symlinkPath);
  const registryEntry = registry.symlinks[relSymlinkPath];

  return (
    registryEntry !== undefined &&
    registryEntry.source === sourceDir &&
    registryEntry.tool === activeTool &&
    exists(symlinkPath)
  );
}

/**
 * Create a skill directory symlink and update registry
 *
 * @returns Result object with created, skipped, or error
 */
async function createSkillDirectorySymlink(options: {
  pkgName: string;
  skillDir: string;
  skillName: string;
  claudeRoot: string;
  projectRoot: string;
  registry: SymlinkRegistry;
  activeTool: ToolType;
  dryRun: boolean;
}): Promise<{
  created?: string;
  skipped?: string;
  error?: { path: string; error: string };
}> {
  const { pkgName, skillDir, skillName, claudeRoot, projectRoot, registry, activeTool, dryRun } =
    options;

  // Generate namespaced symlink path for the directory
  const namespacedName = generateNamespacedPath(pkgName, skillName, true);
  const symlinkPath = path.join(claudeRoot, 'skills', namespacedName);

  // Check if symlink already exists and points to same source
  if (shouldSkipSymlink(symlinkPath, skillDir, activeTool, projectRoot, registry)) {
    return { skipped: symlinkPath };
  }

  // Create directory symlink
  if (dryRun) {
    return { created: symlinkPath };
  }

  try {
    await createSymlink(skillDir, symlinkPath);

    // Update registry with skill directory as source
    const relSymlinkPath = path.relative(projectRoot, symlinkPath);
    registry.symlinks[relSymlinkPath] = {
      package: pkgName,
      source: skillDir,
      tool: activeTool,
      created: new Date().toISOString(),
    };

    return { created: symlinkPath };
  } catch (error) {
    return {
      error: {
        path: symlinkPath,
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/**
 * Remove symlinks from packages NOT in the target list
 * Only removes symlinks for the active tool
 *
 * @param projectRoot - Project root directory
 * @param registry - Symlink registry (will be mutated)
 * @param targetPackages - Packages to keep symlinks for
 * @param activeTool - Current active tool
 * @returns List of removed symlink paths
 */
async function removeNonTargetSymlinks(
  projectRoot: string,
  registry: SymlinkRegistry,
  targetPackages: string[],
  activeTool: ToolType,
): Promise<string[]> {
  const removed: string[] = [];

  // Find symlinks to remove: those from packages NOT in target list AND for active tool
  const toRemove: string[] = [];
  for (const [symlinkPath, info] of Object.entries(registry.symlinks)) {
    if (!targetPackages.includes(info.package) && info.tool === activeTool) {
      toRemove.push(symlinkPath);
    }
  }

  // Remove each symlink
  for (const relPath of toRemove) {
    const absPath = path.join(projectRoot, relPath);

    try {
      if (exists(absPath)) {
        await fs.rm(absPath, { recursive: true, force: true });
        removed.push(absPath);
      }

      // Remove from registry
      delete registry.symlinks[relPath];
    } catch {
      // Continue on error - we'll try to remove what we can
    }
  }

  return removed;
}

/**
 * Create namespaced symlinks from agent_modules to .claude/ directories
 * Uses rendered files metadata to determine which files to symlink
 * Filters out CLAUDE.md/AGENTS.md (those are @-mentioned) and MCP configs
 */
export async function createSymlinks(options: CreateSymlinksOptions): Promise<{
  created: string[];
  skipped: string[];
  removed: string[];
  errors: Array<{ path: string; error: string }>;
}> {
  const {
    projectRoot,
    packages,
    dryRun = false,
    renderedFiles = [],
    activeTool = 'claude',
    exclusive = false,
  } = options;
  const registryPath = options.registryPath ?? path.join(projectRoot, '.terrazul', 'symlinks.json');

  const claudeRoot = path.join(projectRoot, '.claude');

  const created: string[] = [];
  const skipped: string[] = [];
  const errors: Array<{ path: string; error: string }> = [];
  let removed: string[] = [];

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

  // In exclusive mode, remove symlinks from non-target packages first
  if (exclusive && packages && packages.length > 0 && !dryRun) {
    removed = await removeNonTargetSymlinks(projectRoot, registry, packages, activeTool);
  }

  // Filter rendered files by:
  // 1. Active tool only
  // 2. Specified packages (if provided)
  // 3. Not MCP configs
  let filesToProcess = renderedFiles.filter((f) => f.tool === activeTool);

  if (packages && packages.length > 0) {
    filesToProcess = filesToProcess.filter((f) => packages.includes(f.pkgName));
  }

  // Directories to check for symlinkable files (hooks excluded - not supported by Claude)
  const operationalDirs = ['agents', 'commands', 'skills'];

  // Track skill directories we've already processed to avoid duplicates
  // Key: skillDir absolute path, Value: true (processed)
  const processedSkillDirs = new Map<string, boolean>();

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

    // Special handling for skills: symlink the skill directory, not individual files
    if (targetDirName === 'skills') {
      // Find the skill root directory (handles nested subdirectories)
      const skillInfo = findSkillRootDirectory(source);
      if (!skillInfo) {
        continue;
      }

      const { skillDir, skillName } = skillInfo;

      // Skip if we've already processed this skill directory
      if (processedSkillDirs.has(skillDir)) {
        continue;
      }
      processedSkillDirs.set(skillDir, true);

      // Create skill directory symlink
      const result = await createSkillDirectorySymlink({
        pkgName,
        skillDir,
        skillName,
        claudeRoot,
        projectRoot,
        registry,
        activeTool,
        dryRun,
      });

      if (result.created) created.push(result.created);
      if (result.skipped) skipped.push(result.skipped);
      if (result.error) errors.push(result.error);

      continue;
    }

    // For non-skill files (agents, commands): create file symlinks as before
    // Generate namespaced symlink path
    const namespacedName = generateNamespacedPath(pkgName, basename, false);
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
  if (
    !dryRun &&
    (created.length > 0 || removed.length > 0 || Object.keys(registry.symlinks).length > 0)
  ) {
    await fs.mkdir(path.dirname(registryPath), { recursive: true });
    await fs.writeFile(registryPath, JSON.stringify(registry, null, 2), 'utf8');
  }

  return { created, skipped, removed, errors };
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
 * Generate a namespaced path for a file or directory from a package
 * Example for files: @scope/pkg + "foo.md" => "@scope-pkg-foo.md"
 * Example for skill dirs: @scope/pkg + "analyze-logs" => "@scope-pkg-analyze-logs"
 */
function generateNamespacedPath(
  pkgName: string,
  nameOrPath: string,
  isSkillDir: boolean = false,
): string {
  // Normalize package name: @scope/pkg => @scope-pkg
  const normalizedPkg = pkgName.replaceAll('/', '-');

  if (isSkillDir) {
    // For skill directories, use the directory name without extension
    return `${normalizedPkg}-${nameOrPath}`;
  }

  // For files, get the basename and preserve the extension
  const basename = path.basename(nameOrPath);

  // Combine: @scope-pkg-filename.ext
  return `${normalizedPkg}-${basename}`;
}
