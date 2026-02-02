/**
 * Snippet parser - wraps @terrazul/package-core with Node.js adapters.
 *
 * This module re-exports the pure parsing functions from the shared package
 * and provides a backward-compatible generateSnippetId wrapper that uses
 * the Node.js crypto and file system adapters.
 */

import {
  parseSnippets as coreParseSnippets,
  generateSnippetId as coreGenerateSnippetId,
  SnippetParseError,
} from '@terrazul/package-core';
import { nodeCrypto, nodeFs } from '@terrazul/package-core/adapters/node';

import { ErrorCode, TerrazulError } from '../core/errors.js';

import type { ParsedSnippet } from '../types/snippet.js';

/**
 * Parse a Handlebars template and extract askUser/askAgent snippet calls.
 *
 * @param template - The Handlebars template string
 * @returns Array of parsed snippets
 * @throws TerrazulError if the template contains invalid snippets
 */
export function parseSnippets(template: string): ParsedSnippet[] {
  try {
    return coreParseSnippets(template);
  } catch (error) {
    if (error instanceof SnippetParseError) {
      throw new TerrazulError(ErrorCode.INVALID_ARGUMENT, error.message);
    }
    throw error;
  }
}

/**
 * Generate a stable content-based ID for a snippet.
 * The ID is based on the snippet content (prompt + options), not the variable name.
 * For file-based prompts, includes hash of file contents to detect changes.
 *
 * This is a backward-compatible wrapper that uses the Node.js crypto and
 * file system adapters.
 *
 * @param snippet - The parsed snippet
 * @param packageDir - Optional package directory for resolving file paths
 */
export async function generateSnippetId(
  snippet: ParsedSnippet,
  packageDir?: string,
): Promise<string> {
  return await coreGenerateSnippetId(snippet, nodeCrypto, nodeFs, packageDir);
}
