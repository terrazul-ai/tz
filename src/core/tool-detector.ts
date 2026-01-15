import { exec as execCallback } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execCallback);

/**
 * Tool types that can be detected and used as answer tools.
 * This is a subset of ToolType focused on tools that can run interactively.
 */
export type DetectableToolType = 'claude' | 'codex' | 'gemini';

/**
 * All detectable tool types in display order
 */
export const DETECTABLE_TOOLS: DetectableToolType[] = ['claude', 'codex', 'gemini'];

/**
 * Tool detection configuration
 */
interface ToolConfig {
  command: string;
  versionArg: string;
  displayName: string;
}

const TOOL_CONFIGS: Record<DetectableToolType, ToolConfig> = {
  claude: {
    command: 'claude',
    versionArg: '--version',
    displayName: 'Claude Code',
  },
  codex: {
    command: 'codex',
    versionArg: '--version',
    displayName: 'OpenAI Codex',
  },
  gemini: {
    command: 'gemini',
    versionArg: '--version',
    displayName: 'Google Gemini',
  },
};

/**
 * Result of detecting a single tool
 */
export interface ToolDetectionResult {
  type: DetectableToolType;
  installed: boolean;
  version?: string;
  command: string;
  displayName: string;
  error?: string;
}

/**
 * Result of detecting all tools
 */
export interface AllToolsDetectionResult {
  tools: ToolDetectionResult[];
  installedCount: number;
}

/**
 * Parse version string from command output.
 * Handles various formats like "claude 1.2.3", "v1.2.3", "1.2.3", etc.
 */
function parseVersion(output: string): string | undefined {
  // Try common version patterns
  const patterns = [
    /v?(\d+\.\d+\.\d+(?:-[\w.]+)?)/i, // Semver with optional prerelease
    /version\s+v?(\d+\.\d+\.\d+)/i, // "version X.Y.Z"
    /(\d+\.\d+\.\d+)/i, // Plain semver
  ];

  const trimmed = output.trim();
  for (const pattern of patterns) {
    const match = trimmed.match(pattern);
    if (match?.[1]) {
      return match[1];
    }
  }

  // Fallback: return first line if it looks like a version
  const firstLine = trimmed.split('\n')[0].trim();
  if (firstLine && firstLine.length < 100) {
    return firstLine;
  }

  return undefined;
}

/**
 * Detect if a specific tool is installed
 */
export async function detectTool(type: DetectableToolType): Promise<ToolDetectionResult> {
  const config = TOOL_CONFIGS[type];
  const result: ToolDetectionResult = {
    type,
    installed: false,
    command: config.command,
    displayName: config.displayName,
  };

  try {
    const { stdout } = await exec(`${config.command} ${config.versionArg}`);
    result.installed = true;
    result.version = parseVersion(stdout);
  } catch (error) {
    result.installed = false;
    if (error instanceof Error) {
      // Extract meaningful error message
      const errMsg = error.message;
      if (errMsg.includes('ENOENT') || errMsg.includes('not found')) {
        result.error = 'not installed';
      } else if (errMsg.includes('EACCES')) {
        result.error = 'permission denied';
      } else {
        result.error = 'detection failed';
      }
    }
  }

  return result;
}

/**
 * Detect all supported tools in parallel
 */
export async function detectAllTools(): Promise<AllToolsDetectionResult> {
  const results = await Promise.all(DETECTABLE_TOOLS.map((type) => detectTool(type)));

  return {
    tools: results,
    installedCount: results.filter((r) => r.installed).length,
  };
}

/**
 * Get list of installed tool types
 */
export async function getInstalledTools(): Promise<DetectableToolType[]> {
  const { tools } = await detectAllTools();
  return tools.filter((t) => t.installed).map((t) => t.type);
}

/**
 * Check if a specific tool type is valid/detectable
 */
export function isDetectableToolType(value: string): value is DetectableToolType {
  return DETECTABLE_TOOLS.includes(value as DetectableToolType);
}
