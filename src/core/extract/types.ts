import type { ExportMap } from './build-manifest.js';
import type { Logger } from '../../utils/logger.js';

export type MCPSource = 'claude' | 'codex' | 'gemini' | 'project';

export interface ExtractOptions {
  from: string;
  out: string;
  name: string;
  version: string;
  includeClaudeLocal?: boolean;
  includeClaudeUser?: boolean;
  includeCodexConfig?: boolean;
  force?: boolean;
  dryRun?: boolean;
  codexConfigPath?: string;
  projectMcpConfigPath?: string;
}

export interface ExtractResult {
  summary: {
    projectRoot: string;
    detected: Record<string, string | string[]>;
    outputs: string[];
    manifest: ExportMap;
    skipped: string[];
  };
}

export interface ManifestPatch {
  tool: string;
  properties: Record<string, string>;
}

export type PlannedOutputFormat = 'text' | 'json' | 'toml';

export interface PlannedOutput {
  id: string;
  artifactId: string;
  relativePath: string;
  format: PlannedOutputFormat;
  data: unknown;
  manifestPatch?: ManifestPatch;
  alwaysInclude?: boolean;
}

export interface CodexBaseConfig {
  model?: string;
  model_reasoning_effort?: string;
  projects?: Record<string, Record<string, unknown>>;
}

export interface MCPServerPlan {
  id: string;
  source: MCPSource;
  name: string;
  origin: string;
  definition: {
    command: string;
    args: string[];
    env: Record<string, string>;
  };
  config: Record<string, unknown>;
}

export interface ExtractPlan {
  projectRoot: string;
  detected: Record<string, string | string[]>;
  skipped: string[];
  manifest: ExportMap;
  outputs: PlannedOutput[];
  mcpServers: MCPServerPlan[];
  codexConfigBase: CodexBaseConfig | null;
}

export interface ExecuteOptions extends ExtractOptions {
  includedArtifacts: string[];
  includedMcpServers: string[];
  includedSubagentFiles?: string[];
}

export type LoggerLike = Pick<Logger, 'info' | 'warn' | 'error' | 'debug' | 'isVerbose'>;
