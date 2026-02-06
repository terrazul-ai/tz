/**
 * Shared type definitions for Terrazul package parsing.
 * These types are used by both tz-cli (Node.js) and desktop (Bun).
 */

export type SnippetType = 'askUser' | 'askAgent';

export type PromptSourceKind = 'file' | 'text';

export interface SnippetPrompt {
  kind: PromptSourceKind;
  value: string;
}

export interface AskUserOptions {
  default?: string;
  placeholder?: string;
}

export type ToolType = 'claude' | 'codex' | 'gemini';

export interface AskAgentOptions {
  json?: boolean;
  tool?: ToolType;
  safeMode?: boolean;
  timeoutMs?: number;
  systemPrompt?: string;
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

/**
 * Error class for snippet parsing errors.
 * Provides a simple, runtime-agnostic error type.
 */
export class SnippetParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnippetParseError';
  }
}
