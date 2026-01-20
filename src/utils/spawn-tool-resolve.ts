import { selectPrimaryTool } from './config.js';
import { readManifest } from './manifest.js';
import { ErrorCode, TerrazulError } from '../core/errors.js';

import type { UserConfig } from '../types/config.js';
import type { ToolSpec, ToolType } from '../types/context.js';

/**
 * Tools that support spawning (interactive CLI execution).
 * Claude, Codex, and Gemini have spawning support.
 */
const SPAWNABLE_TOOLS: ReadonlySet<ToolType> = new Set(['claude', 'codex', 'gemini']);

export interface ResolveSpawnToolOptions {
  /** CLI flag override (highest precedence) */
  flagOverride?: ToolType;
  /** Project root directory to read manifest from */
  projectRoot: string;
  /** User configuration */
  userConfig: UserConfig;
}

/**
 * Validate that a tool type supports spawning.
 * Throws a clear error for unsupported tools like cursor or copilot.
 */
function validateSpawnableTool(tool: ToolType, source: string): void {
  if (!SPAWNABLE_TOOLS.has(tool)) {
    throw new TerrazulError(
      ErrorCode.INVALID_ARGUMENT,
      `Tool '${tool}' does not support interactive spawning. ` +
        `Only 'claude', 'codex', or 'gemini' can be used with 'tz run'. ` +
        `(specified via ${source})`,
    );
  }
}

/**
 * Resolve which tool to spawn based on precedence:
 * 1. CLI flag (--tool) - highest
 * 2. Project manifest ([package].tool in agents.toml)
 * 3. User config (first answer tool in profile.tools)
 *
 * Uses selectPrimaryTool to get the ToolSpec with proper normalization.
 */
export async function resolveSpawnTool(options: ResolveSpawnToolOptions): Promise<ToolSpec> {
  const { flagOverride, projectRoot, userConfig } = options;

  // 1. CLI flag takes highest precedence
  if (flagOverride) {
    validateSpawnableTool(flagOverride, '--tool flag');
    return selectPrimaryTool(userConfig, flagOverride);
  }

  // 2. Project manifest tool preference
  const manifest = await readManifest(projectRoot);
  if (manifest?.package?.tool) {
    validateSpawnableTool(manifest.package.tool, 'agents.toml [package].tool');
    return selectPrimaryTool(userConfig, manifest.package.tool);
  }

  // 3. User config (first answer tool in profile.tools)
  // selectPrimaryTool already validates that the returned tool is an answer tool
  return selectPrimaryTool(userConfig);
}
