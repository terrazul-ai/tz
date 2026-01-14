import { selectPrimaryTool } from './config.js';
import { readManifest } from './manifest.js';

import type { UserConfig } from '../types/config.js';
import type { ToolSpec, ToolType } from '../types/context.js';

export interface ResolveSpawnToolOptions {
  /** CLI flag override (highest precedence) */
  flagOverride?: ToolType;
  /** Project root directory to read manifest from */
  projectRoot: string;
  /** User configuration */
  userConfig: UserConfig;
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
    return selectPrimaryTool(userConfig, flagOverride);
  }

  // 2. Project manifest tool preference
  const manifest = await readManifest(projectRoot);
  if (manifest?.package?.tool) {
    return selectPrimaryTool(userConfig, manifest.package.tool);
  }

  // 3. User config (first answer tool in profile.tools)
  return selectPrimaryTool(userConfig);
}
