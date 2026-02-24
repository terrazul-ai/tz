import type { ToolSpec, ToolType } from './context.js';
import type { TemplateContext } from '../utils/handlebars-runtime.js';

export type SnippetType = 'askUser' | 'askAgent';

export interface AskUserOptions {
  default?: string;
  placeholder?: string;
}

export interface AskAgentOptions {
  json?: boolean;
  tool?: ToolType;
  safeMode?: boolean;
  timeoutMs?: number;
  systemPrompt?: string;
}

export type PromptSourceKind = 'file' | 'text';

export interface SnippetPrompt {
  kind: PromptSourceKind;
  value: string;
}

export interface ParsedSnippetBase {
  id: string;
  raw: string;
  startIndex: number;
  endIndex: number;
  varName?: string;
}

export interface ParsedAskUserSnippet extends ParsedSnippetBase {
  type: 'askUser';
  question: string;
  options: AskUserOptions;
}

export interface ParsedAskAgentSnippet extends ParsedSnippetBase {
  type: 'askAgent';
  prompt: SnippetPrompt;
  options: AskAgentOptions;
}

export type ParsedSnippet = ParsedAskUserSnippet | ParsedAskAgentSnippet;

export interface SnippetExecutionError {
  message: string;
  code?: string;
}

export interface SnippetValue {
  value: unknown;
  error?: SnippetExecutionError;
}

export interface SnippetExecutionContext {
  snippets: Record<string, SnippetValue>;
  vars: Record<string, unknown>;
}

export type SnippetEvent =
  | { type: 'askUser:start'; snippet: ParsedAskUserSnippet }
  | { type: 'askUser:end'; snippet: ParsedAskUserSnippet; answer: string }
  | { type: 'askAgent:start'; snippet: ParsedAskAgentSnippet; prompt: string }
  | { type: 'askAgent:end'; snippet: ParsedAskAgentSnippet; prompt: string; value: unknown }
  | {
      type: 'askAgent:error';
      snippet: ParsedAskAgentSnippet;
      prompt: string;
      error: SnippetExecutionError;
    };

export interface SnippetCacheEntry {
  value: SnippetValue;
}

export interface ExecuteSnippetsOptions {
  projectDir: string;
  packageDir: string;
  currentTool: ToolSpec;
  availableTools: ToolSpec[];
  toolSafeMode?: boolean;
  verbose?: boolean;
  dryRun?: boolean;
  report?: (event: SnippetEvent) => void;
  baseContext?: TemplateContext;
  // Snippet caching options
  cacheManager?: SnippetCacheManager;
  packageName?: string;
  packageVersion?: string;
  noCache?: boolean;
}

// Forward declaration to avoid circular dependency
export interface SnippetCacheManager {
  getSnippet(
    packageName: string,
    version: string,
    snippetId: string,
    diagnostics?: { missReason?: string },
  ): CachedSnippet | null;
  setSnippet(packageName: string, version: string, snippet: CachedSnippet): Promise<void>;
}

export interface PreprocessOptions extends ExecuteSnippetsOptions {}

export interface RenderableSnippetContext {
  snippets: Record<string, unknown>;
  vars: Record<string, unknown>;
}

export interface PreprocessResult {
  template: string;
  parsed: ParsedSnippet[];
  execution: SnippetExecutionContext;
  renderContext: RenderableSnippetContext;
}

// Snippet caching types
export interface CachedSnippet {
  id: string;
  type: SnippetType;
  promptExcerpt: string;
  value: string; // JSON stringified
  timestamp: string; // ISO 8601
  tool?: ToolType; // For askAgent snippets
}

export interface PackageSnippetCache {
  version: string;
  snippets: CachedSnippet[];
}

export interface SnippetCacheMetadata {
  generatedAt: string;
  cliVersion: string;
}

export interface SnippetCache {
  version: number;
  packages: Record<string, PackageSnippetCache>;
  metadata: SnippetCacheMetadata;
}
