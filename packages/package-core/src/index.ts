/**
 * @terrazul/package-core
 *
 * Shared package parsing utilities for Terrazul CLI and Desktop.
 * Provides pure parsing functions and platform adapters for Node.js and Bun.
 *
 * @example
 * ```typescript
 * // Node.js usage
 * import { parseSnippets, generateSnippetId } from '@terrazul/package-core';
 * import { nodeCrypto, nodeFs } from '@terrazul/package-core/adapters/node';
 *
 * const snippets = parseSnippets(template);
 * const id = await generateSnippetId(snippet, nodeCrypto, nodeFs, packageDir);
 * ```
 *
 * @example
 * ```typescript
 * // Bun usage
 * import { parseSnippets, generateSnippetId } from '@terrazul/package-core';
 * import { bunCrypto, bunFs } from '@terrazul/package-core/adapters/bun';
 *
 * const snippets = parseSnippets(template);
 * const id = await generateSnippetId(snippet, bunCrypto, bunFs, packageDir);
 * ```
 */

// Re-export types
export type {
  SnippetType,
  PromptSourceKind,
  SnippetPrompt,
  AskUserOptions,
  AskAgentOptions,
  ToolType,
  ParsedSnippetBase,
  ParsedAskUserSnippet,
  ParsedAskAgentSnippet,
  ParsedSnippet,
} from './types.js';

export { SnippetParseError } from './types.js';

// Re-export adapter types
export type { CryptoAdapter, FileAdapter, PlatformAdapter } from './adapters/types.js';

// Re-export parsing functions
export { parseSnippets, generateSnippetId, safeResolveWithin } from './snippet-parser.js';
