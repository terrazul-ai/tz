/**
 * Symlink Manager
 * Handles creating and tracking symlinks from agent_modules to tool-specific directories
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { createSymlink, exists } from '../utils/fs.js';

import type { ToolType } from '../types/context.js';

/**
 * Root directories for each tool type where operational files are symlinked
 */
export const TOOL_ROOT_DIRECTORIES: Record<ToolType, string> = {
  claude: '.claude',
  codex: '.codex',
  gemini: '.gemini',
};

/**
 * Operational directories supported by each tool type.
 * - Claude: agents, commands, skills
 * - Codex: skills only (Codex uses AGENTS.md for context, skills for slash commands)
 */
export const TOOL_OPERATIONAL_DIRS: Record<ToolType, string[]> = {
  claude: ['agents', 'commands', 'skills'],
  codex: ['skills'],
  gemini: [],
};

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
 * @param tool - Tool type for this file
 * @param projectRoot - Project root directory
 * @param registry - Symlink registry
 * @returns true if should skip, false if should create
 */
function shouldSkipSymlink(
  symlinkPath: string,
  sourceDir: string,
  tool: ToolType,
  projectRoot: string,
  registry: SymlinkRegistry,
): boolean {
  const relSymlinkPath = path.relative(projectRoot, symlinkPath);
  const registryEntry = registry.symlinks[relSymlinkPath];

  return (
    registryEntry !== undefined &&
    registryEntry.source === sourceDir &&
    registryEntry.tool === tool &&
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
  toolRoot: string;
  projectRoot: string;
  registry: SymlinkRegistry;
  tool: ToolType;
  dryRun: boolean;
}): Promise<{
  created?: string;
  skipped?: string;
  error?: { path: string; error: string };
}> {
  const { pkgName, skillDir, skillName, toolRoot, projectRoot, registry, tool, dryRun } = options;

  // Generate namespaced symlink path for the directory
  const namespacedName = generateNamespacedPath(pkgName, skillName, true);
  const symlinkPath = path.join(toolRoot, 'skills', namespacedName);

  // Check if symlink already exists and points to same source
  if (shouldSkipSymlink(symlinkPath, skillDir, tool, projectRoot, registry)) {
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
      tool,
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
 * Removes symlinks across all tool directories (multi-tool aware)
 *
 * @param projectRoot - Project root directory
 * @param registry - Symlink registry (will be mutated)
 * @param targetPackages - Packages to keep symlinks for
 * @returns List of removed symlink paths
 */
async function removeNonTargetSymlinks(
  projectRoot: string,
  registry: SymlinkRegistry,
  targetPackages: string[],
): Promise<string[]> {
  const removed: string[] = [];

  // Find symlinks to remove: those from packages NOT in target list (across all tools)
  const toRemove: string[] = [];
  for (const [symlinkPath, info] of Object.entries(registry.symlinks)) {
    if (!targetPackages.includes(info.package)) {
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
 * Create namespaced symlinks from agent_modules to tool-specific directories
 * Routes each file to its correct tool directory based on file.tool property
 * Filters out CLAUDE.md/AGENTS.md (those are @-mentioned) and MCP configs
 */
export async function createSymlinks(options: CreateSymlinksOptions): Promise<{
  created: string[];
  skipped: string[];
  removed: string[];
  errors: Array<{ path: string; error: string }>;
}> {
  const { projectRoot, packages, dryRun = false, renderedFiles = [], exclusive = false } = options;
  const registryPath = options.registryPath ?? path.join(projectRoot, '.terrazul', 'symlinks.json');

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

  // In exclusive mode, remove symlinks from non-target packages first (across all tools)
  if (exclusive && packages && packages.length > 0 && !dryRun) {
    removed = await removeNonTargetSymlinks(projectRoot, registry, packages);
  }

  // Filter rendered files by specified packages (if provided)
  // Each file goes to its own tool directory based on file.tool property
  let filesToProcess = renderedFiles;
  if (packages && packages.length > 0) {
    filesToProcess = filesToProcess.filter((f) => packages.includes(f.pkgName));
  }

  // Track skill directories we've already processed to avoid duplicates
  // Key: skillDir absolute path, Value: true (processed)
  const processedSkillDirs = new Map<string, boolean>();

  for (const file of filesToProcess) {
    const { pkgName, source, tool, isMcpConfig } = file;

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

    // Get tool-specific root and operational dirs for this file
    const toolRootName = TOOL_ROOT_DIRECTORIES[tool] ?? '.claude';
    const toolRoot = path.join(projectRoot, toolRootName);
    const operationalDirs = TOOL_OPERATIONAL_DIRS[tool] ?? [];

    // Skip files for tools with no operational directories
    if (operationalDirs.length === 0) {
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
        toolRoot,
        projectRoot,
        registry,
        tool,
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
    const symlinkPath = path.join(toolRoot, targetDirName, namespacedName);

    // Check if symlink already exists and points to same source
    const relSymlinkPath = path.relative(projectRoot, symlinkPath);
    if (
      registry.symlinks[relSymlinkPath]?.source === source &&
      registry.symlinks[relSymlinkPath]?.tool === tool && // Verify symlink actually exists on disk before skipping
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
          tool,
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
