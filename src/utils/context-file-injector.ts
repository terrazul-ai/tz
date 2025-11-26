import { promises as fs } from 'node:fs';
import path from 'node:path';

const BEGIN_MARKER = '<!-- terrazul:begin -->';
const END_MARKER = '<!-- terrazul:end -->';

export interface PackageInfo {
  name: string;
  version?: string;
  root: string;
}

export interface InjectOptions {
  /**
   * Dry run mode - don't write, just return what would be written
   */
  dryRun?: boolean;
}

/**
 * Inject direct @-mentions of package context files (CLAUDE.md, AGENTS.md) into a context file.
 * Filters out non-context files (MCP configs, agents/, commands/, etc.)
 * Uses marker comments to ensure idempotent injection.
 *
 * @param filePath - Absolute path to the context file to inject into
 * @param projectRoot - Absolute path to project root
 * @param packageFiles - Map of package name to array of rendered file paths
 * @param packages - Array of package info (name, version, root)
 * @param options - Injection options
 * @returns Object indicating if file was modified and the new content
 */
export async function injectPackageContext(
  filePath: string,
  projectRoot: string,
  packageFiles: Map<string, string[]>,
  packages: PackageInfo[],
  options: InjectOptions = {},
): Promise<{ modified: boolean; content?: string }> {
  // Check if file exists
  let content = '';
  let fileExists = false;
  try {
    content = await fs.readFile(filePath, 'utf8');
    fileExists = true;
  } catch {
    // File doesn't exist, create with just the package context
    content = '';
    fileExists = false;
  }

  // Check if markers exist AT THE START of the file (not embedded in documentation)
  const hasBeginMarker = content.startsWith(BEGIN_MARKER);
  // Only look for end marker if begin marker is at start
  const endMarkerIndex = hasBeginMarker ? content.indexOf(END_MARKER) : -1;
  const hasEndMarker = endMarkerIndex !== -1;

  // Generate the new context block
  const expectedBlock = generateContextBlock(projectRoot, packageFiles, packages);

  // If both markers exist at the start, the injection is already present
  if (hasBeginMarker && hasEndMarker) {
    // Extract the existing block
    const existingBlock = content.slice(0, endMarkerIndex + END_MARKER.length);

    if (existingBlock === expectedBlock) {
      // Already injected and correct, no changes needed
      return { modified: false };
    }

    // Markers exist but content is wrong, replace the block at the start
    const afterBlock = content.slice(endMarkerIndex + END_MARKER.length);
    const newContent = expectedBlock + afterBlock;

    if (!options.dryRun) {
      await fs.writeFile(filePath, newContent, 'utf8');
    }

    return { modified: true, content: newContent };
  }

  // If begin marker is at start but no end marker, remove the orphan begin marker
  // (This should be rare - indicates corruption)
  if (hasBeginMarker && !hasEndMarker) {
    content = content.slice(BEGIN_MARKER.length);
  }

  // Inject the package context block
  const contextBlock = expectedBlock;

  // New file or empty file - just add the block; otherwise prepend at the beginning with proper spacing
  const newContent =
    !fileExists || content.trim() === ''
      ? contextBlock
      : contextBlock + '\n\n' + content.trimStart();

  if (!options.dryRun) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, newContent, 'utf8');
  }

  return { modified: true, content: newContent };
}

/**
 * Remove package context block from a context file.
 *
 * @param filePath - Absolute path to the context file
 * @param options - Injection options
 * @returns Object indicating if file was modified and the new content
 */
export async function removePackageContext(
  filePath: string,
  options: InjectOptions = {},
): Promise<{ modified: boolean; content?: string }> {
  let content = '';
  try {
    content = await fs.readFile(filePath, 'utf8');
  } catch {
    // File doesn't exist, nothing to remove
    return { modified: false };
  }

  // Check if markers exist AT THE START of the file (not embedded in documentation)
  const hasBeginMarker = content.startsWith(BEGIN_MARKER);
  const endMarkerIndex = hasBeginMarker ? content.indexOf(END_MARKER) : -1;
  const hasMarkers = hasBeginMarker && endMarkerIndex !== -1;

  if (!hasMarkers) {
    return { modified: false };
  }

  // Remove the entire block including markers from the start of the file
  const afterBlock = content.slice(endMarkerIndex + END_MARKER.length);
  const newContent = afterBlock.trim() + '\n';

  if (!options.dryRun) {
    await fs.writeFile(filePath, newContent, 'utf8');
  }

  return { modified: true, content: newContent };
}

/**
 * Check if a context file has the package context block injected at the start.
 * Returns false if markers appear elsewhere in the file (e.g., in documentation).
 */
export async function hasPackageContext(filePath: string): Promise<boolean> {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    // Only consider markers valid if BEGIN is at the start of the file
    const hasBeginMarker = content.startsWith(BEGIN_MARKER);
    const hasEndMarker = hasBeginMarker && content.includes(END_MARKER);
    return hasBeginMarker && hasEndMarker;
  } catch {
    return false;
  }
}

/**
 * Legacy function for backward compatibility.
 * @deprecated Use removePackageContext instead.
 */
export const removeTZMdReference = removePackageContext;

/**
 * Legacy function for backward compatibility.
 * @deprecated Use hasPackageContext instead.
 */
export const hasTZMdReference = hasPackageContext;

/**
 * Generate the package context block with direct @-mentions.
 * Filters to only include CLAUDE.md and AGENTS.md files (context files).
 * Excludes MCP configs, agents/, commands/, hooks/, skills/ files.
 */
function generateContextBlock(
  projectRoot: string,
  packageFiles: Map<string, string[]>,
  packages: PackageInfo[],
): string {
  const lines = [BEGIN_MARKER, '<!-- Terrazul package context - auto-managed, do not edit -->'];

  // Sort packages alphabetically by name
  const sortedPackages = [...packages].sort((a, b) => a.name.localeCompare(b.name));

  for (const pkg of sortedPackages) {
    const files = packageFiles.get(pkg.name);
    if (!files || files.length === 0) continue;

    // Filter to only include context files (CLAUDE.md, AGENTS.md)
    // Exclude MCP configs, agents/, commands/, hooks/, skills/ directories
    const contextFiles = files.filter((file) => {
      const basename = path.basename(file);

      // Only include CLAUDE.md and AGENTS.md
      if (basename === 'CLAUDE.md' || basename === 'AGENTS.md') {
        return true;
      }

      return false;
    });

    // Add @-mentions for each context file
    for (const file of contextFiles) {
      const relPath = path.relative(projectRoot, file);
      lines.push(`@${relPath}`);
    }
  }

  lines.push(END_MARKER);
  return lines.join('\n');
}
