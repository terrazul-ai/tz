import { promises as fs } from 'node:fs';
import path from 'node:path';

import inquirer from 'inquirer';

import { DIRECTORY_DEFAULT_FILENAMES, safeResolveWithin } from './destinations.js';
import { ErrorCode, TerrazulError } from './errors.js';
import { interpolate } from '../utils/handlebars-runtime.js';
import { generateSnippetId } from '../utils/snippet-parser.js';
import { defaultToolSpec, invokeTool, parseToolOutput, stripAnsi } from '../utils/tool-runner.js';

import type { ToolSpec, ToolType } from '../types/context.js';
import type {
  ExecuteSnippetsOptions,
  ParsedSnippet,
  ParsedAskAgentSnippet,
  ParsedAskUserSnippet,
  SnippetExecutionContext,
  SnippetValue,
} from '../types/snippet.js';
import type { TemplateContext } from '../utils/handlebars-runtime.js';
import type { InputQuestion } from 'inquirer';

interface CacheEntry {
  value: SnippetValue;
}

type CacheKey = string;

const DEFAULT_CONTEXT_EXTRACTION_SYSTEM_PROMPT =
  'You are a context extraction agent. Your job is to understand, synthesize and extract context from existing projects. Your responses should only include what is asked, and should not include any dialog such as "I\'m now ready to..", "Looking at", etc. Instead, you should ONLY respond with the answers to the questions asked based on your research';

export async function executeSnippets(
  snippets: ParsedSnippet[],
  options: ExecuteSnippetsOptions,
): Promise<SnippetExecutionContext> {
  const context: SnippetExecutionContext = { snippets: {}, vars: {} };
  // Create new in-memory caches for within-command deduplication
  const cache = new Map<CacheKey, CacheEntry>();
  const promptCache = new Map<string, string>();
  let analysisMessageLogged = false;

  const logAnalysisMessage = () => {
    if (analysisMessageLogged) return;
    analysisMessageLogged = true;
    console.log('\nAnalyzing your codebase, this may take a couple minutes. Hang tight!\n');
  };

  // Dry runs (e.g. tz apply --dry-run) still execute snippets so previews remain accurate, so
  // we purposefully do not short-circuit on options.dryRun here.

  // PASS 1: Execute all askUser snippets first to gather user input upfront
  const askUserSnippets = snippets.filter((s) => s.type === 'askUser');
  for (const snippet of askUserSnippets) {
    const result = await runAskUser(snippet, options).catch((error) => ({
      value: null,
      error: toSnippetError(error),
    }));
    context.snippets[snippet.id] = result;
    if (!result.error && snippet.varName) {
      context.vars[snippet.varName] = result.value;
    }
  }

  // PASS 2: Execute all askAgent snippets (can reference askUser variables)
  const askAgentSnippets = snippets.filter((s) => s.type === 'askAgent');
  for (const snippet of askAgentSnippets) {
    const result = await runAskAgent(
      snippet,
      options,
      cache,
      promptCache,
      context,
      logAnalysisMessage,
    ).catch((error) => ({
      value: null,
      error: toSnippetError(error),
    }));
    context.snippets[snippet.id] = result;
    if (!result.error && snippet.varName) {
      context.vars[snippet.varName] = result.value;
    }
  }

  return context;
}

async function runAskUser(
  snippet: ParsedAskUserSnippet,
  options: ExecuteSnippetsOptions,
): Promise<SnippetValue> {
  // Check persistent cache first (unless --no-cache)
  if (!options.noCache && options.cacheManager && options.packageName && options.packageVersion) {
    const cacheKey = await generateSnippetId(snippet);
    const cached = options.cacheManager.getSnippet(
      options.packageName,
      options.packageVersion,
      cacheKey,
    );
    if (cached) {
      if (options.verbose) {
        console.log(`Using cached value for askUser snippet ${snippet.id}`);
      }
      const value = JSON.parse(cached.value);
      options.report?.({ type: 'askUser:end', snippet, answer: value as string });
      return { value };
    }
  }

  const placeholder = snippet.options.placeholder;
  const hasPlaceholder = typeof placeholder === 'string' && placeholder.trim().length > 0;
  const promptConfig: InputQuestion<{ value: string }> = {
    type: 'input',
    name: 'value',
    message: snippet.question,
    default: snippet.options.default,
  };
  if (hasPlaceholder && placeholder) {
    const placeholderText = placeholder;
    promptConfig.transformer = (input, _answers, flags) => {
      if (!input && !flags.isFinal) {
        return placeholderText;
      }
      return input;
    };
  }
  options.report?.({ type: 'askUser:start', snippet });
  const answers = await inquirer.prompt<{ value: string }>([promptConfig]);
  options.report?.({ type: 'askUser:end', snippet, answer: answers.value });

  // Store to persistent cache
  if (options.cacheManager && options.packageName && options.packageVersion) {
    const cacheKey = await generateSnippetId(snippet);
    await options.cacheManager.setSnippet(options.packageName, options.packageVersion, {
      id: cacheKey,
      type: 'askUser',
      promptExcerpt: truncatePrompt(snippet.question, 100),
      value: JSON.stringify(answers.value),
      timestamp: new Date().toISOString(),
    });
  }

  return { value: answers.value };
}

async function runAskAgent(
  snippet: ParsedAskAgentSnippet,
  options: ExecuteSnippetsOptions,
  cache: Map<CacheKey, CacheEntry>,
  promptCache: Map<string, string>,
  context: SnippetExecutionContext,
  onBeforeInvoke?: () => void,
): Promise<SnippetValue> {
  // Check persistent cache first (unless --no-cache)
  if (!options.noCache && options.cacheManager && options.packageName && options.packageVersion) {
    const persistentCacheKey = await generateSnippetId(snippet, options.packageDir);
    const persistentCached = options.cacheManager.getSnippet(
      options.packageName,
      options.packageVersion,
      persistentCacheKey,
    );
    if (persistentCached) {
      if (options.verbose) {
        console.log(`Using cached value for askAgent snippet ${snippet.id}`);
      }
      const value = JSON.parse(persistentCached.value);
      const basePrompt = await resolvePrompt(snippet, options.packageDir, promptCache);
      options.report?.({ type: 'askAgent:end', snippet, prompt: basePrompt, value });
      return { value };
    }
  }

  const basePrompt = await resolvePrompt(snippet, options.packageDir, promptCache);
  options.report?.({ type: 'askAgent:start', snippet, prompt: basePrompt });

  const promptContext = buildPromptContext(context, options.baseContext);
  const interpolatedPrompt = interpolate(basePrompt, promptContext);

  const finalPrompt = enforceSingleTurnDirective(interpolatedPrompt);
  const toolSpec = resolveToolSpec(snippet, options);
  const safeMode = snippet.options.safeMode ?? options.toolSafeMode ?? true;
  const timeoutMs = snippet.options.timeoutMs;

  // Determine system prompt: use snippet option if provided, otherwise use default
  const systemPrompt =
    snippet.options.systemPrompt === undefined
      ? DEFAULT_CONTEXT_EXTRACTION_SYSTEM_PROMPT
      : snippet.options.systemPrompt;

  const cacheKey = buildCacheKey(toolSpec, snippet, finalPrompt, safeMode, timeoutMs, systemPrompt);

  const cached = cache.get(cacheKey);
  if (cached) {
    if (options.verbose) {
      console.log(`[snippet-executor] Cache hit for snippet ${snippet.id}`);
    }
    options.report?.({
      type: 'askAgent:end',
      snippet,
      prompt: basePrompt,
      value: cached.value.value,
    });
    return cached.value;
  }

  onBeforeInvoke?.();

  let execution;
  try {
    execution = await invokeTool({
      tool: toolSpec,
      prompt: finalPrompt,
      cwd: options.projectDir,
      safeMode,
      timeoutMs,
      systemPrompt,
    });
  } catch (error) {
    const snippetError = toSnippetError(error);
    options.report?.({
      type: 'askAgent:error',
      snippet,
      prompt: basePrompt,
      error: snippetError,
    });
    throw error;
  }

  const cleaned = stripAnsi(execution.stdout);
  const parseMode = snippet.options.json ? 'json' : 'auto_json';
  let parsed: unknown;
  try {
    parsed = parseToolOutput(cleaned, parseMode);
  } catch (error) {
    throw toTerrazul(error);
  }

  let value: unknown;
  if (snippet.options.json) {
    if (parsed === undefined) {
      throw new TerrazulError(
        ErrorCode.TOOL_OUTPUT_PARSE_ERROR,
        'askAgent expected JSON but none was returned',
      );
    }
    value = parsed;
  } else {
    const preferred = extractPreferredResult(parsed);
    value = preferred === undefined ? cleaned.trim() : preferred;
  }

  const result: SnippetValue = { value };
  cache.set(cacheKey, { value: result });
  options.report?.({ type: 'askAgent:end', snippet, prompt: basePrompt, value });

  // Store to persistent cache
  if (options.cacheManager && options.packageName && options.packageVersion) {
    const persistentCacheKey = await generateSnippetId(snippet, options.packageDir);
    await options.cacheManager.setSnippet(options.packageName, options.packageVersion, {
      id: persistentCacheKey,
      type: 'askAgent',
      promptExcerpt: truncatePrompt(basePrompt, 100),
      value: JSON.stringify(value),
      timestamp: new Date().toISOString(),
      tool: toolSpec.type,
    });
  }

  return result;
}

async function resolvePrompt(
  snippet: ParsedAskAgentSnippet,
  packageDir: string,
  promptCache: Map<string, string>,
): Promise<string> {
  if (snippet.prompt.kind === 'text') {
    return snippet.prompt.value;
  }
  const cacheKey = path.join(packageDir, snippet.prompt.value);
  const cached = promptCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const target = safeResolveWithin(packageDir, snippet.prompt.value);
  let contents: string;
  try {
    contents = await fs.readFile(target, 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new TerrazulError(
      ErrorCode.FILE_NOT_FOUND,
      `askAgent prompt file not found: ${snippet.prompt.value} (${message})`,
    );
  }
  promptCache.set(cacheKey, contents);
  return contents;
}

function resolveToolSpec(
  snippet: ParsedAskAgentSnippet,
  options: ExecuteSnippetsOptions,
): ToolSpec {
  const requested = snippet.options.tool ?? options.currentTool.type;
  const candidates: ToolSpec[] = [];
  candidates.push(options.currentTool, ...options.availableTools);
  const match = candidates.find((spec) => spec.type === requested);
  if (match) {
    return cloneToolSpec(match);
  }
  return defaultToolSpec(requested);
}

function cloneToolSpec(spec: ToolSpec): ToolSpec {
  const clone: ToolSpec = { ...spec };
  if (spec.args) clone.args = [...spec.args];
  if (spec.env) clone.env = { ...spec.env };
  return clone;
}

function buildCacheKey(
  tool: ToolSpec,
  snippet: ParsedAskAgentSnippet,
  prompt: string,
  safeMode: boolean,
  timeoutMs: number | undefined,
  systemPrompt: string,
): CacheKey {
  return JSON.stringify({
    tool: tool.type,
    command: tool.command,
    args: tool.args,
    model: tool.model,
    prompt,
    json: snippet.options.json ?? false,
    safeMode,
    timeoutMs: timeoutMs ?? null,
    systemPrompt,
  });
}

const SINGLE_TURN_DIRECTIVE =
  'Respond with your best possible answer immediately. Do not ask follow-up questions or request additional information.';

function enforceSingleTurnDirective(prompt: string): string {
  const normalized = prompt.toLowerCase();
  if (
    normalized.includes('do not ask for additional information') ||
    normalized.includes('do not ask follow-up questions')
  ) {
    return prompt;
  }
  const trimmed = prompt.trimEnd();
  return `${trimmed}\n\n---\n${SINGLE_TURN_DIRECTIVE}`;
}

function toSnippetError(error: unknown) {
  if (error instanceof TerrazulError) {
    return { message: error.message, code: error.code };
  }
  if (error instanceof Error) {
    return { message: error.message };
  }
  return { message: String(error) };
}

function toTerrazul(error: unknown): TerrazulError {
  if (error instanceof TerrazulError) return error;
  if (error instanceof Error) {
    return new TerrazulError(ErrorCode.UNKNOWN_ERROR, error.message);
  }
  return new TerrazulError(ErrorCode.UNKNOWN_ERROR, String(error));
}

export function defaultDestinationFilename(tool: ToolType): string {
  return DIRECTORY_DEFAULT_FILENAMES[tool] ?? 'output.md';
}

function buildPromptContext(
  context: SnippetExecutionContext,
  baseContext?: TemplateContext,
): TemplateContext {
  const promptContext: TemplateContext = baseContext ? { ...baseContext } : {};
  const baseVarsSource = baseContext ? baseContext['vars'] : undefined;
  const baseVars = isRecord(baseVarsSource) ? { ...baseVarsSource } : {};
  const baseSnippetsSource = baseContext ? baseContext['snippets'] : undefined;
  const baseSnippets = isRecord(baseSnippetsSource) ? { ...baseSnippetsSource } : {};

  const vars = { ...baseVars, ...context.vars };
  const snippets: Record<string, unknown> = { ...baseSnippets };

  for (const [id, entry] of Object.entries(context.snippets)) {
    if (!entry || entry.error) {
      snippets[id] = undefined;
      continue;
    }
    snippets[id] = entry.value;
  }

  promptContext.vars = vars;
  promptContext.snippets = snippets;
  return promptContext;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function extractPreferredResult(parsed: unknown): unknown {
  if (!parsed || typeof parsed !== 'object') {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  if (record.result !== undefined) {
    return record.result;
  }
  if (record.result_parsed !== undefined) {
    return record.result_parsed;
  }
  return undefined;
}

function truncatePrompt(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return text.slice(0, maxLength - 3) + '...';
}
