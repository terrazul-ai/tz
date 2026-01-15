import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import YAML from 'yaml';

import { safeResolveWithin } from '../core/destinations.js';
import { ErrorCode, TerrazulError } from '../core/errors.js';
import {
  type AskAgentOptions,
  type AskUserOptions,
  type ParsedSnippet,
  type SnippetPrompt,
} from '../types/snippet.js';

import type { ToolType } from '../types/context.js';

const VAR_ASSIGNMENT = /^var\s+(\w+)\s*=\s*(.+)$/s;
const CALL_PATTERN = /^(askUser|askAgent)\s*\(([\S\s]*)\)$/s;
const VALID_VAR_NAME = /^\w+$/;

/**
 * Generate a stable content-based ID for a snippet
 * The ID is based on the snippet content (prompt + options), not the variable name
 * For file-based prompts, includes hash of file contents to detect changes
 */
export async function generateSnippetId(
  snippet: ParsedSnippet,
  packageDir?: string,
): Promise<string> {
  // Build a source string from the snippet content
  let source: string;

  if (snippet.type === 'askUser') {
    // For askUser: hash question + options (excluding varName)
    source = `askUser:${snippet.question}:${JSON.stringify(snippet.options)}`;
  } else {
    // For askAgent: hash prompt kind + value + options (excluding varName)
    let promptPart: string;

    if (snippet.prompt.kind === 'file' && packageDir) {
      // Read file contents and hash them to detect changes
      try {
        const target = safeResolveWithin(packageDir, snippet.prompt.value);
        const contents = await readFile(target, 'utf8');
        const contentHash = createHash('sha256').update(contents).digest('hex').slice(0, 16);
        promptPart = `file:${snippet.prompt.value}:${contentHash}`;
      } catch {
        // Fallback to path-only if file read fails (shouldn't happen in practice)
        promptPart = `file:${snippet.prompt.value}`;
      }
    } else {
      // For text prompts or when packageDir is not available
      promptPart = `${snippet.prompt.kind}:${snippet.prompt.value}`;
    }

    source = `askAgent:${promptPart}:${JSON.stringify(snippet.options)}`;
  }

  // Generate SHA-256 hash and take first 8 hex characters
  const hash = createHash('sha256').update(source).digest('hex');
  return `snippet_${hash.slice(0, 8)}`;
}

type LiteralKind = 'single' | 'triple';

interface StringLiteral {
  value: string;
  endIndex: number;
  literalKind: LiteralKind;
}

interface ParsedArguments {
  prompt: SnippetPrompt | string;
  optionsMap: Record<string, unknown>;
  literalKind: LiteralKind;
}

export function parseSnippets(template: string): ParsedSnippet[] {
  const snippets: ParsedSnippet[] = [];
  const usedVars = new Set<string>();
  let cursor = 0;
  let snippetIndex = 0;

  while (cursor < template.length) {
    const start = template.indexOf('{{', cursor);
    if (start === -1) break;

    const openCount = countOpeningBraces(template, start);
    const innerStart = start + openCount;
    const innerEnd = findSnippetEnd(template, innerStart, openCount);
    if (innerEnd === -1) {
      throw new TerrazulError(
        ErrorCode.INVALID_ARGUMENT,
        'Unclosed snippet "{{" without matching "}}"',
      );
    }

    const closingCount = openCount === 3 ? 3 : 2;
    const raw = template.slice(start, innerEnd + closingCount);
    const expressionRaw = template.slice(innerStart, innerEnd);
    const expression = stripWhitespaceControl(expressionRaw).trim();

    if (expression.length === 0) {
      cursor = innerEnd + closingCount;
      continue;
    }

    // Skip Handlebars control flow helpers, comments, etc.
    if (expression.startsWith('#') || expression.startsWith('/') || expression.startsWith('!')) {
      cursor = innerEnd + closingCount;
      continue;
    }

    let varName: string | undefined;
    let body = expression;
    const assignMatch = expression.match(VAR_ASSIGNMENT);
    if (assignMatch) {
      varName = assignMatch[1];
      if (!VALID_VAR_NAME.test(varName)) {
        throw new TerrazulError(
          ErrorCode.INVALID_ARGUMENT,
          `Invalid variable name '${varName}'. Use alphanumeric plus underscore.`,
        );
      }
      if (usedVars.has(varName)) {
        throw new TerrazulError(
          ErrorCode.INVALID_ARGUMENT,
          `Variable '${varName}' already defined in template.`,
        );
      }
      usedVars.add(varName);
      body = assignMatch[2]?.trim() ?? '';
    }

    if (!assignMatch && expression.startsWith('var ')) {
      const varToken = expression.slice(3).split('=')[0]?.trim() ?? '';
      const candidate = varToken.split(/\s+/)[0] ?? '';
      if (!VALID_VAR_NAME.test(candidate)) {
        throw new TerrazulError(
          ErrorCode.INVALID_ARGUMENT,
          `Invalid variable name '${candidate}'. Use alphanumeric plus underscore.`,
        );
      }
    }

    const callMatch = body.match(CALL_PATTERN);
    if (!callMatch) {
      const trimmed = body.trimStart();
      if (/^(askUser|askAgent)\b/.test(trimmed)) {
        throw new TerrazulError(ErrorCode.INVALID_ARGUMENT, `Malformed snippet: "${body}"`);
      }
      const askCallPattern = /(?<!["'])\bask(User|Agent)\s*\(/;
      if (askCallPattern.test(body)) {
        throw new TerrazulError(ErrorCode.INVALID_ARGUMENT, `Malformed snippet: "${body}"`);
      }
      cursor = innerEnd + closingCount;
      continue;
    }

    const fn = callMatch[1] as 'askUser' | 'askAgent';
    const argsSegment = callMatch[2]?.trim() ?? '';
    if (argsSegment.length === 0) {
      throw new TerrazulError(ErrorCode.INVALID_ARGUMENT, `${fn} requires at least one argument`);
    }

    const args = parseArguments(argsSegment, fn);

    if (fn === 'askUser') {
      const question = typeof args.prompt === 'string' ? args.prompt : args.prompt.value;
      const options = normalizeAskUserOptions(args.optionsMap);
      const snippet: ParsedSnippet = {
        id: `snippet_${snippetIndex}`,
        type: 'askUser',
        raw,
        startIndex: start,
        endIndex: innerEnd + closingCount,
        question,
        options,
        varName,
      };
      snippets.push(snippet);
      snippetIndex += 1;
    } else {
      const prompt = typeof args.prompt === 'string' ? args.prompt : args.prompt;
      const options = normalizeAskAgentOptions(args.optionsMap);
      const snippetPrompt =
        typeof prompt === 'string' ? toPrompt(prompt, args.literalKind) : prompt;
      const snippet: ParsedSnippet = {
        id: `snippet_${snippetIndex}`,
        type: 'askAgent',
        raw,
        startIndex: start,
        endIndex: innerEnd + closingCount,
        prompt: snippetPrompt,
        options,
        varName,
      };
      snippets.push(snippet);
      snippetIndex += 1;
    }

    cursor = innerEnd + closingCount;
  }

  return snippets;
}

function findSnippetEnd(template: string, start: number, openCount: number): number {
  let i = start;
  let inSingle = false;
  let inDouble = false;
  let inTriple = false;
  let inBacktick = false;
  while (i < template.length - 1) {
    const ahead3 = template.slice(i, i + 3);
    if (!inSingle && !inDouble && !inBacktick && ahead3 === '"""') {
      inTriple = !inTriple;
      i += 3;
      continue;
    }
    if (inTriple) {
      i += 1;
      continue;
    }
    const ch = template[i];
    if (ch === "'" && !inDouble && !inBacktick) {
      if (i === start || template[i - 1] !== '\\') {
        inSingle = !inSingle;
      }
      i += 1;
      continue;
    }
    if (ch === '"' && !inSingle && !inBacktick) {
      if (i === start || template[i - 1] !== '\\') {
        inDouble = !inDouble;
      }
      i += 1;
      continue;
    }
    if (ch === '`' && !inSingle && !inDouble) {
      if (i === start || template[i - 1] !== '\\') {
        inBacktick = !inBacktick;
      }
      i += 1;
      continue;
    }
    if (inSingle || inDouble || inBacktick) {
      if (ch === '\\') {
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (template[i] === '}' && template[i + 1] === '}') {
      if (openCount === 3 && template[i + 2] !== '}') {
        i += 1;
        continue;
      }
      return i;
    }
    i += 1;
  }
  return -1;
}

function parseArguments(segment: string, fn: 'askUser' | 'askAgent'): ParsedArguments {
  const trimmed = segment.trim();
  const first = parseStringLiteral(trimmed, 0);
  let cursor = first.endIndex;
  cursor = skipWhitespace(trimmed, cursor);

  let optionsText = '';
  if (cursor < trimmed.length) {
    if (trimmed[cursor] !== ',') {
      throw new TerrazulError(
        ErrorCode.INVALID_ARGUMENT,
        `${fn} accepts at most two arguments (string, options object)`,
      );
    }
    cursor += 1;
    cursor = skipWhitespace(trimmed, cursor);
    if (cursor >= trimmed.length) {
      throw new TerrazulError(
        ErrorCode.INVALID_ARGUMENT,
        `Missing options object after comma in ${fn} call`,
      );
    }
    if (trimmed[cursor] !== '{') {
      throw new TerrazulError(
        ErrorCode.INVALID_ARGUMENT,
        `Options for ${fn} must be an object literal`,
      );
    }
    const { objectText, endIndex } = extractObjectLiteral(trimmed, cursor);
    optionsText = objectText;
    cursor = skipWhitespace(trimmed, endIndex);
  }

  if (cursor < trimmed.length) {
    throw new TerrazulError(ErrorCode.INVALID_ARGUMENT, `Unexpected tokens in ${fn} arguments`);
  }

  const optionsMap = optionsText.length > 0 ? parseOptions(optionsText) : {};

  return {
    prompt: first.value,
    optionsMap,
    literalKind: first.literalKind,
  };
}

function parseStringLiteral(source: string, start: number): StringLiteral {
  if (source.startsWith('"""', start)) {
    const close = source.indexOf('"""', start + 3);
    if (close === -1) {
      throw new TerrazulError(
        ErrorCode.INVALID_ARGUMENT,
        'Triple-quoted string missing closing """',
      );
    }
    const content = source.slice(start + 3, close);
    const dedented = dedentTripleQuoted(content);
    return { value: dedented, endIndex: close + 3, literalKind: 'triple' };
  }
  // Handle backtick strings (template literals)
  if (source[start] === '`') {
    let i = start + 1;
    let out = '';
    while (i < source.length) {
      const ch = source[i];
      if (ch === '\\') {
        if (i + 1 >= source.length) {
          throw new TerrazulError(ErrorCode.INVALID_ARGUMENT, 'Invalid escape sequence in string');
        }
        const next = source[i + 1];
        switch (next) {
          case '`':
          case '\\': {
            out += next;
            break;
          }
          case 'n': {
            out += '\n';
            break;
          }
          case 't': {
            out += '\t';
            break;
          }
          case 'r': {
            out += '\r';
            break;
          }
          default: {
            out += next;
            break;
          }
        }
        i += 2;
        continue;
      }
      if (ch === '`') {
        return { value: out, endIndex: i + 1, literalKind: 'single' };
      }
      // Unlike single quotes, backticks can span multiple lines
      out += ch;
      i += 1;
    }
    throw new TerrazulError(ErrorCode.INVALID_ARGUMENT, 'Unterminated backtick string in snippet');
  }
  if (source[start] !== "'") {
    throw new TerrazulError(ErrorCode.INVALID_ARGUMENT, 'Snippet arguments must be quoted strings');
  }
  let i = start + 1;
  let out = '';
  while (i < source.length) {
    const ch = source[i];
    if (ch === '\\') {
      if (i + 1 >= source.length) {
        throw new TerrazulError(ErrorCode.INVALID_ARGUMENT, 'Invalid escape sequence in string');
      }
      const next = source[i + 1];
      switch (next) {
        case "'":
        case '\\': {
          out += next;
          break;
        }
        case 'n': {
          out += '\n';
          break;
        }
        case 't': {
          out += '\t';
          break;
        }
        case 'r': {
          out += '\r';
          break;
        }
        default: {
          out += next;
          break;
        }
      }
      i += 2;
      continue;
    }
    if (ch === "'") {
      return { value: out, endIndex: i + 1, literalKind: 'single' };
    }
    if (ch === '\n') {
      throw new TerrazulError(
        ErrorCode.INVALID_ARGUMENT,
        'Single-quoted strings cannot span multiple lines (use triple quotes)',
      );
    }
    out += ch;
    i += 1;
  }
  throw new TerrazulError(ErrorCode.INVALID_ARGUMENT, 'Unterminated string literal in snippet');
}

function dedentTripleQuoted(content: string): string {
  const normalized = content.replaceAll('\r\n', '\n');
  const lines = normalized.split('\n');
  const startIndex = lines[0]?.trim().length === 0 ? 1 : 0;
  const endIndex =
    lines.length > 1 && lines.at(-1)?.trim().length === 0 ? lines.length - 1 : lines.length;
  const relevant = lines.slice(startIndex, endIndex);
  let commonIndent: number | undefined;
  for (const line of relevant) {
    if (line.trim().length === 0) continue;
    const count = line.match(/^\s*/)?.[0].length ?? 0;
    commonIndent = commonIndent === undefined ? count : Math.min(commonIndent, count);
  }
  const indent = commonIndent ?? 0;
  const dedented = relevant.map((line) => (indent > 0 ? line.slice(indent) : line));
  return dedented.join('\n');
}

function skipWhitespace(text: string, index: number): number {
  let i = index;
  while (i < text.length && /\s/.test(text[i] ?? '')) {
    i += 1;
  }
  return i;
}

function extractObjectLiteral(
  text: string,
  start: number,
): { objectText: string; endIndex: number } {
  let depth = 0;
  let i = start;
  let inSingle = false;
  let inDouble = false;
  let inTriple = false;
  while (i < text.length) {
    const ahead3 = text.slice(i, i + 3);
    if (!inSingle && !inDouble && ahead3 === '"""') {
      inTriple = !inTriple;
      i += 3;
      continue;
    }
    if (inTriple) {
      i += 1;
      continue;
    }
    const ch = text[i];
    if (ch === "'" && !inDouble) {
      if (i === start || text[i - 1] !== '\\') {
        inSingle = !inSingle;
      }
      i += 1;
      continue;
    }
    if (ch === '"' && !inSingle) {
      if (i === start || text[i - 1] !== '\\') {
        inDouble = !inDouble;
      }
      i += 1;
      continue;
    }
    if (inSingle || inDouble) {
      if (ch === '\\') {
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        const objectText = text.slice(start, i + 1);
        const rest = text.slice(i + 1);
        const trimmed = rest.trim();
        return { objectText, endIndex: rest.length - trimmed.length + i + 1 };
      }
    }
    i += 1;
  }
  throw new TerrazulError(ErrorCode.INVALID_ARGUMENT, 'Options object missing closing brace');
}

function parseOptions(text: string): Record<string, unknown> {
  try {
    const parsed = YAML.parse(text);
    if (parsed == null) return {};
    if (typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new TerrazulError(
        ErrorCode.INVALID_ARGUMENT,
        'Snippet options must be an object mapping',
      );
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new TerrazulError(ErrorCode.INVALID_ARGUMENT, `Invalid snippet options: ${message}`);
  }
}

function normalizeAskUserOptions(raw: Record<string, unknown>): AskUserOptions {
  const options: AskUserOptions = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined || value === null) continue;
    if (key === 'default' || key === 'placeholder') {
      options[key] = String(value);
      continue;
    }
    throw new TerrazulError(
      ErrorCode.INVALID_ARGUMENT,
      `Unsupported askUser option '${key}'. Allowed keys: default, placeholder.`,
    );
  }
  return options;
}

function normalizeAskAgentOptions(raw: Record<string, unknown>): AskAgentOptions {
  const options: AskAgentOptions = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'json') {
      if (typeof value !== 'boolean') {
        throw new TerrazulError(ErrorCode.INVALID_ARGUMENT, 'askAgent json option must be boolean');
      }
      options.json = value;
      continue;
    }
    if (key === 'tool') {
      if (typeof value !== 'string' || !isKnownTool(value)) {
        throw new TerrazulError(
          ErrorCode.INVALID_ARGUMENT,
          "askAgent tool option must be one of 'claude', 'codex', 'gemini'",
        );
      }
      options.tool = value;
      continue;
    }
    if (key === 'safeMode') {
      if (typeof value !== 'boolean') {
        throw new TerrazulError(
          ErrorCode.INVALID_ARGUMENT,
          'askAgent safeMode option must be boolean',
        );
      }
      options.safeMode = value;
      continue;
    }
    if (key === 'timeoutMs') {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        throw new TerrazulError(
          ErrorCode.INVALID_ARGUMENT,
          'askAgent timeoutMs must be a positive number',
        );
      }
      options.timeoutMs = value;
      continue;
    }
    if (key === 'systemPrompt') {
      if (typeof value !== 'string') {
        throw new TerrazulError(
          ErrorCode.INVALID_ARGUMENT,
          'askAgent systemPrompt option must be a string',
        );
      }
      options.systemPrompt = value;
      continue;
    }
    throw new TerrazulError(ErrorCode.INVALID_ARGUMENT, `Unsupported askAgent option '${key}'.`);
  }
  return options;
}

function isKnownTool(value: string): value is ToolType {
  return value === 'claude' || value === 'codex' || value === 'gemini';
}

function toPrompt(value: string, literalKind: LiteralKind): SnippetPrompt {
  if (literalKind === 'triple' || value.includes('\n')) {
    return { kind: 'text', value };
  }
  if (isLikelyFilePath(value)) {
    return { kind: 'file', value };
  }
  return { kind: 'text', value };
}

function isLikelyFilePath(value: string): boolean {
  if (value.includes('\n')) return false;
  if (value.includes('{{')) return false;
  const trimmed = value.trim();
  if (
    trimmed.startsWith('./') ||
    trimmed.startsWith('../') ||
    trimmed.startsWith('.\\') ||
    trimmed.startsWith('..\\')
  ) {
    return true;
  }
  if (/\s/.test(value)) {
    return false;
  }
  const normalized = value.replaceAll('\\', '/');
  if (normalized.includes('/')) return true;
  if (/\.(txt|md|prompt|json|hbs|yaml|yml)$/i.test(normalized)) return true;
  return false;
}

function stripWhitespaceControl(raw: string): string {
  let start = 0;
  let end = raw.length;

  while (start < end && isWhitespaceControl(raw.charAt(start))) {
    start += 1;
  }
  while (end > start && isWhitespaceControl(raw.charAt(end - 1))) {
    end -= 1;
  }
  return raw.slice(start, end);
}

function isWhitespaceControl(char: string): boolean {
  return char === '~' || char === '-';
}

function countOpeningBraces(template: string, start: number): number {
  let count = 0;
  while (start + count < template.length && template[start + count] === '{') {
    count += 1;
  }
  return count;
}
