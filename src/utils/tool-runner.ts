import { expandEnvVars } from './config.js';
import { runCommand, type RunResult } from './proc.js';
import { ErrorCode, TerrazulError } from '../core/errors.js';

import type { ToolSpec, ToolType } from '../types/context.js';

export interface InvokeToolOptions {
  tool: ToolSpec;
  prompt: string;
  cwd: string;
  safeMode?: boolean;
  timeoutMs?: number;
  env?: Record<string, string>;
  systemPrompt?: string;
}

export interface ToolExecution {
  command: string;
  args: string[];
  stdout: string;
  stderr: string;
}

const SAFE_ARGS: Record<ToolType, string[]> = {
  claude: ['-p', '--output-format', 'json', '--permission-mode', 'plan', '--max-turns', '100'],
  codex: ['--sandbox', 'read-only'],
  gemini: [],
};

const REQUIRED_ARGS: Record<ToolType, string[]> = {
  claude: ['-p', '--output-format', 'json'],
  codex: [],
  gemini: [],
};

const SAFE_MODE_FLAG_OVERRIDES: Record<
  ToolType,
  Array<{ flag: string; consumesValue: boolean }>
> = {
  claude: [
    { flag: '-p', consumesValue: false },
    { flag: '--output-format', consumesValue: true },
    { flag: '--permission-mode', consumesValue: true },
    { flag: '--max-turns', consumesValue: true },
  ],
  codex: [{ flag: '--sandbox', consumesValue: true }],
  gemini: [],
};

function removeFlag(args: string[], flag: string, consumesValue: boolean): string[] {
  const result: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const current = args[i];
    if (current !== flag) {
      result.push(current);
      continue;
    }
    if (consumesValue && i + 1 < args.length && !args[i + 1].startsWith('-')) {
      i += 1;
    }
  }
  return result;
}

function applySafeModeOverrides(tool: ToolType, baseArgs: string[]): string[] {
  const overrides = SAFE_MODE_FLAG_OVERRIDES[tool];
  if (!overrides || overrides.length === 0) return baseArgs;
  return overrides.reduce(
    (current, entry) => removeFlag(current, entry.flag, entry.consumesValue),
    baseArgs,
  );
}

function mergeEnv(
  toolEnv?: Record<string, string | undefined>,
  override?: Record<string, string>,
): Record<string, string> {
  const merged: Record<string, string> = {};
  if (toolEnv) {
    for (const [key, value] of Object.entries(toolEnv)) {
      if (value !== undefined) merged[key] = value;
    }
  }
  if (override) {
    for (const [key, value] of Object.entries(override)) {
      merged[key] = value;
    }
  }
  return merged;
}

function appendArgs(target: string[], additions?: string[]): void {
  if (!additions || additions.length === 0) return;
  for (let i = 0; i < additions.length; i += 1) {
    const arg = additions[i];
    if (!arg) continue;
    const next = additions[i + 1];
    const isFlag = arg.startsWith('-');
    if (isFlag) {
      if (target.includes(arg)) {
        if (next && !next.startsWith('-')) {
          i += 1;
        }
        continue;
      }
      target.push(arg);
      if (next && !next.startsWith('-')) {
        target.push(next);
        i += 1;
      }
      continue;
    }
    if (!target.includes(arg)) {
      target.push(arg);
    }
  }
}

export async function invokeTool(options: InvokeToolOptions): Promise<ToolExecution> {
  const command = options.tool.command ?? options.tool.type;
  const safeModeEnabled = options.safeMode !== false;
  const baseArgs = safeModeEnabled
    ? applySafeModeOverrides(options.tool.type, [...(options.tool.args ?? [])])
    : [...(options.tool.args ?? [])];
  const args = [...baseArgs];

  if (safeModeEnabled) {
    appendArgs(args, SAFE_ARGS[options.tool.type]);
  }
  appendArgs(args, REQUIRED_ARGS[options.tool.type]);
  if (options.tool.model && options.tool.model !== 'default') {
    appendArgs(args, ['--model', options.tool.model]);
  }

  // Add system prompt for Claude only
  if (
    options.tool.type === 'claude' &&
    options.systemPrompt !== undefined &&
    options.systemPrompt !== null
  ) {
    args.push('--append-system-prompt', options.systemPrompt);
  }

  const env = expandEnvVars(options.tool.env);
  const runEnv = mergeEnv(env, options.env);

  let result: RunResult;
  try {
    result = await runCommand(command, args, {
      cwd: options.cwd,
      input: options.prompt,
      timeoutMs: options.timeoutMs,
      env: runEnv,
    });
  } catch (error) {
    const isNodeError = error && typeof error === 'object' && 'code' in error;
    const errorCode = isNodeError ? (error as { code: string }).code : undefined;

    if (errorCode === 'ENOENT') {
      throw new TerrazulError(
        ErrorCode.TOOL_NOT_FOUND,
        `Command '${command}' not found in PATH. Please ensure '${options.tool.type}' CLI is installed and accessible.`,
        { command, PATH: process.env.PATH },
      );
    }

    throw new TerrazulError(
      ErrorCode.TOOL_EXECUTION_FAILED,
      `Failed to spawn command '${command}': ${error instanceof Error ? error.message : String(error)}`,
      { command, error },
    );
  }

  if (result.exitCode !== 0) {
    throw new TerrazulError(
      ErrorCode.TOOL_EXECUTION_FAILED,
      `Tool '${command}' exited with code ${result.exitCode ?? -1}`,
      { stderr: result.stderr, stdout: result.stdout },
    );
  }

  return {
    command,
    args,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

const ESCAPE_PREFIX = '\u001B';
const ANSI_PATTERN = new RegExp(`${ESCAPE_PREFIX}\\[[\\d;]*[A-Za-z]`, 'g');

export function stripAnsi(input: string): string {
  return input.replaceAll(ANSI_PATTERN, '');
}

export type ParseMode = 'auto_json' | 'json' | 'raw';

export function parseToolOutput(output: string, mode: ParseMode = 'auto_json'): unknown {
  if (mode === 'raw') return undefined;
  const cleaned = stripAnsi(output).trim();
  if (cleaned.length === 0) return undefined;
  const jsonCandidate = mode === 'json' ? cleaned : extractJson(cleaned);
  if (!jsonCandidate) {
    if (mode === 'json') {
      throw new TerrazulError(
        ErrorCode.TOOL_OUTPUT_PARSE_ERROR,
        'Expected JSON output but none found',
      );
    }
    return undefined;
  }
  try {
    const topLevel: unknown = JSON.parse(jsonCandidate);
    if (topLevel && typeof topLevel === 'object') {
      enrichEmbeddedResult(topLevel as Record<string, unknown>);
    }
    return topLevel;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new TerrazulError(
      ErrorCode.TOOL_OUTPUT_PARSE_ERROR,
      `Failed to parse tool output: ${message}`,
    );
  }
}

function extractJson(body: string): string | undefined {
  try {
    return JSON.stringify(JSON.parse(body));
  } catch {
    // continue
  }

  const fenced = body.match(/```json\s*([\S\s]+?)```/i);
  if (fenced && fenced[1]) {
    const snippet = fenced[1].trim();
    try {
      return JSON.stringify(JSON.parse(snippet));
    } catch {
      // ignore
    }
  }

  const inline = body.match(/{[\S\s]*}$/);
  if (inline) {
    const candidate = inline[0];
    try {
      return JSON.stringify(JSON.parse(candidate));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function enrichEmbeddedResult(target: Record<string, unknown>): void {
  const result = target['result'];
  if (typeof result !== 'string') return;
  const nestedCandidate = extractJson(result) ?? result;
  if (!nestedCandidate) return;
  try {
    const parsed = JSON.parse(nestedCandidate) as Record<string, unknown>;
    target['result_parsed'] = parsed;
    if (parsed && typeof parsed === 'object') {
      for (const [key, value] of Object.entries(parsed)) {
        if (target[key] === undefined) {
          target[key] = value;
        }
      }
    }
  } catch {
    // ignore nested parse failures
  }
}

export function defaultToolSpec(tool: ToolType): ToolSpec {
  switch (tool) {
    case 'codex': {
      return { type: 'codex', command: 'codex', args: ['exec'] };
    }
    case 'claude': {
      return { type: 'claude', command: 'claude', model: 'default' };
    }
    case 'gemini': {
      return { type: 'gemini', command: 'gemini' };
    }
    default: {
      return { type: tool } as ToolSpec;
    }
  }
}
