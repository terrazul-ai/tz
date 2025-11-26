import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import inquirer from 'inquirer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { executeSnippets } from '../../../src/core/snippet-executor';
import { parseSnippets } from '../../../src/utils/snippet-parser';
import * as toolRunner from '../../../src/utils/tool-runner';

import type { ToolSpec } from '../../../src/types/context';
import type {
  CachedSnippet,
  ExecuteSnippetsOptions,
  SnippetCacheManager,
  SnippetEvent,
} from '../../../src/types/snippet';

type ToolRunnerModule = typeof toolRunner;

vi.mock('inquirer', () => ({
  default: {
    prompt: vi.fn(),
  },
}));

vi.mock('../../../src/utils/tool-runner', async () => {
  const actual = await vi.importActual<ToolRunnerModule>('../../../src/utils/tool-runner');
  return {
    ...actual,
    invokeTool: vi.fn(),
  };
});

const promptMock = vi.mocked(inquirer.prompt);
const invokeToolMock = vi.mocked(toolRunner.invokeTool);

describe('snippet executor', () => {
  let projectDir = '';
  let packageDir = '';
  const defaultTool: ToolSpec = { type: 'claude', command: 'claude' };

  function makeOptions(overrides: Partial<ExecuteSnippetsOptions> = {}): ExecuteSnippetsOptions {
    return {
      projectDir,
      packageDir,
      currentTool: defaultTool,
      availableTools: [],
      toolSafeMode: true,
      verbose: false,
      noCache: true,
      ...overrides,
    };
  }

  beforeEach(async () => {
    projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tz-snippet-exec-'));
    packageDir = path.join(projectDir, 'agent_modules', 'pkg');
    await fs.mkdir(packageDir, { recursive: true });
    promptMock.mockReset();
    invokeToolMock.mockReset();
  });

  afterEach(async () => {
    await fs.rm(projectDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('resolves askUser prompts via inquirer', async () => {
    promptMock.mockResolvedValueOnce({ value: 'Alice' });
    const snippets = parseSnippets("{{ askUser('Name?') }}");
    const context = await executeSnippets(snippets, makeOptions());
    expect(promptMock).toHaveBeenCalledTimes(1);
    expect(context.snippets.snippet_0.value).toBe('Alice');
  });

  it('calls invokeTool for askAgent snippets with inline prompt', async () => {
    invokeToolMock.mockResolvedValueOnce({
      command: 'claude',
      args: [],
      stdout: 'Completed result',
      stderr: '',
    });
    const snippets = parseSnippets("{{ askAgent('Summarize this repo') }}");
    const context = await executeSnippets(snippets, makeOptions());
    expect(invokeToolMock).toHaveBeenCalledTimes(1);
    expect(invokeToolMock.mock.calls[0]?.[0]?.prompt).toContain('Summarize this repo');
    expect(invokeToolMock.mock.calls[0]?.[0]?.prompt).toContain(
      'Respond with your best possible answer',
    );
    expect(context.snippets.snippet_0.value).toBe('Completed result');
  });

  it('detects file-based prompts relative to package directory', async () => {
    const promptPath = path.join(packageDir, 'prompts', 'summary.txt');
    await fs.mkdir(path.dirname(promptPath), { recursive: true });
    await fs.writeFile(promptPath, 'File based prompt', 'utf8');
    invokeToolMock.mockResolvedValueOnce({
      command: 'claude',
      args: [],
      stdout: 'ok',
      stderr: '',
    });
    const snippets = parseSnippets("{{ askAgent('prompts/summary.txt') }}");
    await executeSnippets(snippets, makeOptions());
    const call = invokeToolMock.mock.calls[0]?.[0];
    expect(call?.prompt).toContain('File based prompt');
  });

  it('caches repeated askAgent snippets by prompt and options', async () => {
    invokeToolMock.mockResolvedValue({
      command: 'claude',
      args: [],
      stdout: 'cached',
      stderr: '',
    });
    const snippets = parseSnippets(`
      {{ askAgent('Summarize this repo') }}
      {{ askAgent('Summarize this repo') }}
    `);
    const context = await executeSnippets(snippets, makeOptions());
    expect(invokeToolMock).toHaveBeenCalledTimes(1);
    expect(context.snippets.snippet_0.value).toBe('cached');
    expect(context.snippets.snippet_1.value).toBe('cached');
  });

  it('logs analysis message once when invoking the first uncached askAgent snippet', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    invokeToolMock.mockResolvedValue({
      command: 'claude',
      args: [],
      stdout: 'computed',
      stderr: '',
    });

    try {
      const snippets = parseSnippets(`
        {{ askAgent('Summarize this repo') }}
        {{ askAgent('Summarize this repo') }}
      `);
      await executeSnippets(snippets, makeOptions());

      expect(logSpy).toHaveBeenCalledTimes(1);
      expect(logSpy.mock.calls[0]?.[0]).toContain('Analyzing your codebase');
    } finally {
      logSpy.mockRestore();
    }
  });

  it('does not log analysis message when askAgent result comes from persistent cache', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const cachedSnippet: CachedSnippet = {
      id: 'snippet-cache-id',
      type: 'askAgent',
      promptExcerpt: 'Summarize',
      value: JSON.stringify('cached-value'),
      timestamp: new Date().toISOString(),
      tool: 'claude',
    };
    const cacheManager: SnippetCacheManager = {
      getSnippet: vi.fn(() => cachedSnippet),
      setSnippet: vi.fn(async () => {}),
    };

    try {
      const snippets = parseSnippets("{{ askAgent('Summarize this repo') }}");
      const context = await executeSnippets(
        snippets,
        makeOptions({
          noCache: false,
          cacheManager,
          packageName: 'pkg',
          packageVersion: '1.0.0',
        }),
      );

      expect(invokeToolMock).not.toHaveBeenCalled();
      expect(logSpy).not.toHaveBeenCalled();
      expect(context.snippets.snippet_0.value).toBe('cached-value');
    } finally {
      logSpy.mockRestore();
    }
  });

  it('parses JSON output when json flag is true', async () => {
    invokeToolMock.mockResolvedValueOnce({
      command: 'claude',
      args: [],
      stdout: '{"result":"ok"}',
      stderr: '',
    });
    const snippets = parseSnippets("{{ askAgent('Prompt', { json: true }) }}");
    const context = await executeSnippets(snippets, makeOptions());
    expect(context.snippets.snippet_0.value).toEqual({ result: 'ok' });
  });

  it('interpolates askAgent prompts with base template context', async () => {
    invokeToolMock.mockResolvedValueOnce({
      command: 'claude',
      args: [],
      stdout: 'ok',
      stderr: '',
    });
    const snippets = parseSnippets("{{ askAgent('Summarize {{ project.name }}') }}");
    await executeSnippets(
      snippets,
      makeOptions({ baseContext: { project: { name: 'Demo Project' } } }),
    );
    const prompt = invokeToolMock.mock.calls[0]?.[0]?.prompt;
    expect(prompt).toContain('Summarize Demo Project');
  });

  it('uses overridden tool specification when provided', async () => {
    invokeToolMock.mockResolvedValueOnce({
      command: 'codex',
      args: [],
      stdout: 'ok',
      stderr: '',
    });
    const codexSpec: ToolSpec = { type: 'codex', command: 'codex', args: ['exec'] };
    const snippets = parseSnippets("{{ askAgent('Prompt', { tool: 'codex' }) }}");
    await executeSnippets(snippets, makeOptions({ availableTools: [codexSpec] }));
    const call = invokeToolMock.mock.calls[0]?.[0];
    expect(call?.tool.type).toBe('codex');
    expect(call?.tool.args).toEqual(['exec']);
  });

  it('emits askAgent:end for cached prompts', async () => {
    invokeToolMock.mockResolvedValueOnce({
      command: 'claude',
      args: [],
      stdout: 'Completed',
      stderr: '',
    });
    const snippets = parseSnippets(`
      {{ askAgent('Repeated prompt') }}
      {{ askAgent('Repeated prompt') }}
    `);
    const reports: SnippetEvent[] = [];
    const context = await executeSnippets(
      snippets,
      makeOptions({
        report: (event) => {
          reports.push(event);
        },
      }),
    );
    expect(invokeToolMock).toHaveBeenCalledTimes(1);
    expect(context.snippets.snippet_0.value).toBe('Completed');
    expect(context.snippets.snippet_1.value).toBe('Completed');
    const startEvents = reports.filter((event) => event.type === 'askAgent:start');
    const endEvents = reports.filter((event) => event.type === 'askAgent:end');
    expect(startEvents).toHaveLength(2);
    expect(endEvents).toHaveLength(2);
  });

  it('interpolates askAgent prompts with current vars and snippets', async () => {
    promptMock.mockResolvedValueOnce({ value: 'Delta' });
    invokeToolMock
      .mockResolvedValueOnce({
        command: 'claude',
        args: [],
        stdout: 'First result',
        stderr: '',
      })
      .mockResolvedValueOnce({
        command: 'claude',
        args: [],
        stdout: 'Second',
        stderr: '',
      });

    const snippets = parseSnippets(`
      {{ var answer = askUser('Name?') }}
      {{ var analysis = askAgent('Initial prompt') }}
      {{ askAgent('Follow up with {{ vars.answer }} and {{ snippets.snippet_1 }}') }}
    `);
    await executeSnippets(snippets, makeOptions());
    expect(invokeToolMock).toHaveBeenCalledTimes(2);
    const secondCall = invokeToolMock.mock.calls[1]?.[0];
    expect(secondCall?.prompt).toContain('Delta');
    expect(secondCall?.prompt).toContain('First result');
  });

  it('interpolates file-based askAgent prompts with current context', async () => {
    promptMock.mockResolvedValueOnce({ value: 'Echo' });
    invokeToolMock
      .mockResolvedValueOnce({
        command: 'claude',
        args: [],
        stdout: 'Primary answer',
        stderr: '',
      })
      .mockResolvedValueOnce({
        command: 'claude',
        args: [],
        stdout: 'Follow up',
        stderr: '',
      });

    const promptPath = path.join(packageDir, 'prompts', 'follow-up.txt');
    await fs.mkdir(path.dirname(promptPath), { recursive: true });
    await fs.writeFile(
      promptPath,
      'Respond using {{ vars.answer }} and {{ snippets.snippet_1 }}',
      'utf8',
    );

    const snippets = parseSnippets(`
      {{ var answer = askUser('Name?') }}
      {{ var analysis = askAgent('Initial prompt') }}
      {{ askAgent('prompts/follow-up.txt') }}
    `);
    await executeSnippets(snippets, makeOptions());

    expect(invokeToolMock).toHaveBeenCalledTimes(2);
    const followUpCall = invokeToolMock.mock.calls[1]?.[0];
    expect(followUpCall?.prompt).toContain('Echo');
    expect(followUpCall?.prompt).toContain('Primary answer');
  });

  it('prefers parsed result payload when json option is false', async () => {
    invokeToolMock.mockResolvedValueOnce({
      command: 'claude',
      args: [],
      stdout: JSON.stringify({
        type: 'result',
        result: 'Plain summary',
        duration_ms: 100,
      }),
      stderr: '',
    });
    const snippets = parseSnippets("{{ askAgent('Prompt without json flag') }}");
    const context = await executeSnippets(snippets, makeOptions());
    expect(context.snippets.snippet_0.value).toBe('Plain summary');
  });

  it('falls back to result_parsed when available', async () => {
    invokeToolMock.mockResolvedValueOnce({
      command: 'claude',
      args: [],
      stdout: JSON.stringify({
        type: 'result',
        result_parsed: { summary: 'Structured' },
      }),
      stderr: '',
    });
    const snippets = parseSnippets("{{ askAgent('Prompt again') }}");
    const context = await executeSnippets(snippets, makeOptions());
    expect(context.snippets.snippet_0.value).toEqual({ summary: 'Structured' });
  });

  describe('system prompt support', () => {
    it('passes default context extraction system prompt when not specified', async () => {
      invokeToolMock.mockResolvedValueOnce({
        command: 'claude',
        args: [],
        stdout: 'Result',
        stderr: '',
      });
      const snippets = parseSnippets("{{ askAgent('Summarize') }}");
      await executeSnippets(snippets, makeOptions());
      const call = invokeToolMock.mock.calls[0]?.[0];
      expect(call?.systemPrompt).toContain('You are a context extraction agent');
      expect(call?.systemPrompt).toContain('synthesize and extract context');
      expect(call?.systemPrompt).toContain('should not include any dialog');
    });

    it('uses custom system prompt when provided in snippet options', async () => {
      invokeToolMock.mockResolvedValueOnce({
        command: 'claude',
        args: [],
        stdout: 'Result',
        stderr: '',
      });
      const snippets = parseSnippets(
        "{{ askAgent('Summarize', { systemPrompt: 'You are a helpful assistant.' }) }}",
      );
      await executeSnippets(snippets, makeOptions());
      const call = invokeToolMock.mock.calls[0]?.[0];
      expect(call?.systemPrompt).toBe('You are a helpful assistant.');
    });

    it('allows empty string system prompt to disable default', async () => {
      invokeToolMock.mockResolvedValueOnce({
        command: 'claude',
        args: [],
        stdout: 'Result',
        stderr: '',
      });
      const snippets = parseSnippets("{{ askAgent('Summarize', { systemPrompt: '' }) }}");
      await executeSnippets(snippets, makeOptions());
      const call = invokeToolMock.mock.calls[0]?.[0];
      expect(call?.systemPrompt).toBe('');
    });

    it('includes system prompt in cache key for askAgent snippets', async () => {
      invokeToolMock
        .mockResolvedValueOnce({
          command: 'claude',
          args: [],
          stdout: 'First',
          stderr: '',
        })
        .mockResolvedValueOnce({
          command: 'claude',
          args: [],
          stdout: 'Second',
          stderr: '',
        });

      const snippets = parseSnippets(`
        {{ askAgent('Same prompt', { systemPrompt: 'First system prompt' }) }}
        {{ askAgent('Same prompt', { systemPrompt: 'Second system prompt' }) }}
      `);
      const context = await executeSnippets(snippets, makeOptions());

      // Different system prompts should result in different cache keys, so invokeTool is called twice
      expect(invokeToolMock).toHaveBeenCalledTimes(2);
      expect(context.snippets.snippet_0.value).toBe('First');
      expect(context.snippets.snippet_1.value).toBe('Second');
    });
  });

  describe('two-pass execution', () => {
    it('executes all askUser snippets before any askAgent snippets', async () => {
      const executionOrder: string[] = [];

      promptMock.mockImplementation(async () => {
        executionOrder.push('askUser');
        return { value: 'User response' };
      });

      invokeToolMock.mockImplementation(async () => {
        executionOrder.push('askAgent');
        return {
          command: 'claude',
          args: [],
          stdout: 'Agent response',
          stderr: '',
        };
      });

      const snippets = parseSnippets(`
        {{ askAgent('First agent prompt') }}
        {{ askUser('First user question?') }}
        {{ askAgent('Second agent prompt') }}
        {{ askUser('Second user question?') }}
      `);

      await executeSnippets(snippets, makeOptions());

      // Verify all askUser calls happened before any askAgent calls
      expect(executionOrder).toEqual(['askUser', 'askUser', 'askAgent', 'askAgent']);
    });

    it('allows askAgent snippets to reference askUser variables', async () => {
      promptMock.mockResolvedValueOnce({ value: 'ProjectName' });
      invokeToolMock.mockResolvedValueOnce({
        command: 'claude',
        args: [],
        stdout: 'Analysis result',
        stderr: '',
      });

      const snippets = parseSnippets(`
        {{ var projectName = askUser('What is your project name?') }}
        {{ askAgent('Analyze the project called {{ vars.projectName }}') }}
      `);

      await executeSnippets(snippets, makeOptions());

      expect(invokeToolMock).toHaveBeenCalledTimes(1);
      const call = invokeToolMock.mock.calls[0]?.[0];
      expect(call?.prompt).toContain('Analyze the project called ProjectName');
    });

    it('handles multiple askUser variables referenced by multiple askAgent snippets', async () => {
      promptMock
        .mockResolvedValueOnce({ value: 'Alice' })
        .mockResolvedValueOnce({ value: 'Beta' })
        .mockResolvedValueOnce({ value: 'Production' });

      invokeToolMock
        .mockResolvedValueOnce({
          command: 'claude',
          args: [],
          stdout: 'First result',
          stderr: '',
        })
        .mockResolvedValueOnce({
          command: 'claude',
          args: [],
          stdout: 'Second result',
          stderr: '',
        });

      const snippets = parseSnippets(`
        {{ var userName = askUser('Your name?') }}
        {{ var version = askUser('Version?') }}
        {{ var environment = askUser('Environment?') }}
        {{ askAgent('Deploy {{ vars.version }} to {{ vars.environment }} by {{ vars.userName }}') }}
        {{ askAgent('Notify {{ vars.userName }} about deployment') }}
      `);

      await executeSnippets(snippets, makeOptions());

      expect(promptMock).toHaveBeenCalledTimes(3);
      expect(invokeToolMock).toHaveBeenCalledTimes(2);

      const firstAgentCall = invokeToolMock.mock.calls[0]?.[0];
      expect(firstAgentCall?.prompt).toContain('Deploy Beta to Production by Alice');

      const secondAgentCall = invokeToolMock.mock.calls[1]?.[0];
      expect(secondAgentCall?.prompt).toContain('Notify Alice about deployment');
    });

    it('emits events in two-pass order (askUser:*, then askAgent:*)', async () => {
      promptMock.mockResolvedValueOnce({ value: 'Response' });
      invokeToolMock.mockResolvedValueOnce({
        command: 'claude',
        args: [],
        stdout: 'Result',
        stderr: '',
      });

      const snippets = parseSnippets(`
        {{ askAgent('Agent prompt') }}
        {{ askUser('User question?') }}
      `);

      const events: SnippetEvent[] = [];
      await executeSnippets(
        snippets,
        makeOptions({
          report: (event) => {
            events.push(event);
          },
        }),
      );

      // Events should be: askUser:start, askUser:end, askAgent:start, askAgent:end
      expect(events).toHaveLength(4);
      expect(events[0]?.type).toBe('askUser:start');
      expect(events[1]?.type).toBe('askUser:end');
      expect(events[2]?.type).toBe('askAgent:start');
      expect(events[3]?.type).toBe('askAgent:end');
    });

    it('maintains snippet IDs regardless of execution order', async () => {
      promptMock.mockResolvedValueOnce({ value: 'User input' });
      invokeToolMock.mockResolvedValueOnce({
        command: 'claude',
        args: [],
        stdout: 'Agent output',
        stderr: '',
      });

      const snippets = parseSnippets(`
        {{ askAgent('Agent first') }}
        {{ askUser('User second?') }}
      `);

      const context = await executeSnippets(snippets, makeOptions());

      // Snippet IDs are assigned in document order, not execution order
      expect(context.snippets.snippet_0.value).toBe('Agent output');
      expect(context.snippets.snippet_1.value).toBe('User input');
    });
  });
});
