import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import inquirer from 'inquirer';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { ErrorCode } from '../../../src/core/errors';
import { SnippetCacheManager } from '../../../src/core/snippet-cache';
import { planAndRender } from '../../../src/core/template-renderer';
import * as toolRunner from '../../../src/utils/tool-runner';

type ToolRunnerModule = typeof toolRunner;

vi.mock('inquirer', () => {
  const prompt = vi.fn();
  return {
    default: {
      prompt,
    },
  };
});

vi.mock('../../../src/utils/tool-runner', async () => {
  const actual = await vi.importActual<ToolRunnerModule>('../../../src/utils/tool-runner');
  return {
    ...actual,
    invokeTool: vi.fn(),
  };
});

const promptMock = vi.mocked(inquirer.prompt);
const invokeToolMock = vi.mocked(toolRunner.invokeTool);

describe('template renderer snippets integration', () => {
  let projectRoot = '';
  let agentModules = '';
  let pkgRoot = '';
  let fakeHomeDir = '';
  let storeRoot = '';
  let originalHome: string | undefined;
  let originalUserProfile: string | undefined;

  beforeAll(async () => {
    // Setup fake home directory
    originalHome = process.env.HOME;
    originalUserProfile = process.env.USERPROFILE;
    fakeHomeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tz-snippets-home-'));
    process.env.HOME = fakeHomeDir;
    process.env.USERPROFILE = fakeHomeDir;

    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tz-snippets-'));
    agentModules = path.join(projectRoot, 'agent_modules');
    pkgRoot = path.join(agentModules, '@test', 'demo');
    await fs.mkdir(pkgRoot, { recursive: true });

    await fs.writeFile(
      path.join(projectRoot, 'agents.toml'),
      `\n[package]\nname = "@test/project"\nversion = "0.1.0"\n`,
      'utf8',
    );

    // Create store structure with templates
    storeRoot = path.join(fakeHomeDir, '.terrazul', 'store');
    const pkgStoreRoot = path.join(storeRoot, '@test', 'demo', '1.0.0');
    await fs.mkdir(path.join(pkgStoreRoot, 'templates'), { recursive: true });

    await fs.writeFile(
      path.join(pkgStoreRoot, 'agents.toml'),
      `\n[package]\nname = "@test/demo"\nversion = "1.0.0"\n\n[exports.codex]\ntemplate = "templates/AGENTS.md.hbs"\n`,
      'utf8',
    );

    const templateBody = `# Preview

User: {{ askUser('Your name?', { placeholder: 'Jane Doe' }) }}
{{ var summary = askAgent('Provide summary', { json: true }) }}
Summary: {{ vars.summary.result }}`;
    await fs.writeFile(path.join(pkgStoreRoot, 'templates', 'AGENTS.md.hbs'), templateBody, 'utf8');

    // Create lockfile
    const lockfile = `
version = 1

[packages."@test/demo"]
version = "1.0.0"
resolved = "http://localhost/demo"
integrity = "sha256-test"
dependencies = { }

[metadata]
generated_at = "2025-01-01T00:00:00.000Z"
cli_version = "0.1.0"
`;
    await fs.writeFile(path.join(projectRoot, 'agents-lock.toml'), lockfile.trim(), 'utf8');
  });

  afterAll(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
    if (fakeHomeDir) {
      await fs.rm(fakeHomeDir, { recursive: true, force: true }).catch(() => {});
    }
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
  });
  beforeEach(async () => {
    vi.clearAllMocks();
    promptMock.mockResolvedValue({ value: 'Alice' });
    invokeToolMock.mockResolvedValue({
      command: 'claude',
      args: [],
      stdout: '{"result":"All good"}',
      stderr: '',
    });
    await fs.rm(path.join(projectRoot, 'AGENTS.md'), { force: true });
  });

  it('renders templates with snippet inputs', async () => {
    const res = await planAndRender(projectRoot, agentModules, {
      force: true,
      packageName: '@test/demo',
      tool: 'claude',
      noCache: true,
      storeDir: storeRoot,
    });

    expect(res.written).toHaveLength(1);
    const outputPath = res.written[0];
    const contents = await fs.readFile(outputPath, 'utf8');
    expect(contents).toContain('User: Alice');
    expect(contents).toContain('Summary: All good');
    expect(invokeToolMock).toHaveBeenCalledTimes(1);
    expect(promptMock).toHaveBeenCalledTimes(1);
  });

  it('propagates snippet execution failures as errors', async () => {
    invokeToolMock.mockRejectedValueOnce(new Error('tool crashed'));

    await expect(
      planAndRender(projectRoot, agentModules, {
        force: true,
        packageName: '@test/demo',
        tool: 'claude',
        noCache: true,
        storeDir: storeRoot,
      }),
    ).rejects.toMatchObject({
      code: ErrorCode.TOOL_EXECUTION_FAILED,
      message: expect.stringContaining('tool crashed'),
    });

    await expect(fs.readFile(path.join(projectRoot, 'AGENTS.md'), 'utf8')).rejects.toThrow();
  });

  it('forwards askUser placeholder hints to prompts', async () => {
    await planAndRender(projectRoot, agentModules, {
      force: true,
      packageName: '@test/demo',
      tool: 'claude',
      noCache: true,
      storeDir: storeRoot,
    });

    expect(promptMock).toHaveBeenCalledTimes(1);
    const [questions] = promptMock.mock.calls[0];
    const question = Array.isArray(questions) ? questions[0] : questions;
    expect(question).toBeDefined();
    expect(typeof question.transformer).toBe('function');
    const transformed = question.transformer?.('', { value: '' }, { isFinal: false });
    expect(transformed).toContain('Jane Doe');
  });

  it('preserves cache entries for other packages during render', async () => {
    // Setup: Create a cache file with entries for a different package
    const cacheFilePath = path.join(projectRoot, 'agents-cache.toml');
    const cacheManager = new SnippetCacheManager(cacheFilePath);
    await cacheManager.read();

    // Add cache entry for a package that is NOT being rendered
    await cacheManager.setSnippet('@other/package', '2.0.0', {
      id: 'other_snippet_1',
      type: 'askUser',
      promptExcerpt: 'Some question',
      value: 'Some answer',
      timestamp: new Date().toISOString(),
    });

    // Verify the cache entry exists
    const beforeCache = await cacheManager.read();
    expect(beforeCache.packages['@other/package']).toBeDefined();
    expect(beforeCache.packages['@other/package'].snippets).toHaveLength(1);

    // Render the @test/demo package
    await planAndRender(projectRoot, agentModules, {
      force: true,
      packageName: '@test/demo',
      tool: 'claude',
      cacheFilePath,
      storeDir: storeRoot,
    });

    // Verify the @other/package cache entry is PRESERVED (not pruned)
    const afterCacheManager = new SnippetCacheManager(cacheFilePath);
    const afterCache = await afterCacheManager.read();
    expect(afterCache.packages['@other/package']).toBeDefined();
    expect(afterCache.packages['@other/package'].snippets).toHaveLength(1);
    expect(afterCache.packages['@other/package'].snippets[0].id).toBe('other_snippet_1');
    expect(afterCache.packages['@other/package'].snippets[0].value).toBe('Some answer');
  });

  it('uses cached snippet values on re-render after rendered files are deleted', async () => {
    const cacheFilePath = path.join(projectRoot, 'test-rerender-cache.toml');

    // First render: populates the cache (with force to ensure rendering)
    await planAndRender(projectRoot, agentModules, {
      force: true,
      packageName: '@test/demo',
      tool: 'claude',
      cacheFilePath,
      storeDir: storeRoot,
    });

    // Verify first render executed snippets
    expect(promptMock).toHaveBeenCalledTimes(1);
    expect(invokeToolMock).toHaveBeenCalledTimes(1);

    // Delete the rendered output file to force re-render
    const outputPath = path.join(agentModules, '@test', 'demo', 'AGENTS.md');
    await fs.rm(outputPath, { force: true });

    // Reset mocks to track second render
    vi.clearAllMocks();
    promptMock.mockResolvedValue({ value: 'Should not be called' });
    invokeToolMock.mockResolvedValue({
      command: 'claude',
      args: [],
      stdout: '{"result":"Should not be called"}',
      stderr: '',
    });

    // Second render: should use cached values (no prompts or tool invocations)
    const res = await planAndRender(projectRoot, agentModules, {
      force: true,
      packageName: '@test/demo',
      tool: 'claude',
      cacheFilePath,
      storeDir: storeRoot,
    });

    expect(res.written).toHaveLength(1);
    const contents = await fs.readFile(res.written[0], 'utf8');
    // Should contain the values from the FIRST render (cached), not the mock overrides
    expect(contents).toContain('User: Alice');
    expect(contents).toContain('Summary: All good');
    // No new prompts or tool invocations should have fired
    expect(promptMock).not.toHaveBeenCalled();
    expect(invokeToolMock).not.toHaveBeenCalled();
  });

  it('persists earlier snippet cache writes when a later snippet fails', async () => {
    const cacheFilePath = path.join(projectRoot, 'test-partial-cache.toml');

    // Make askAgent (second pass) fail, but askUser (first pass) should succeed
    invokeToolMock.mockRejectedValueOnce(new Error('agent timed out'));

    await expect(
      planAndRender(projectRoot, agentModules, {
        force: true,
        packageName: '@test/demo',
        tool: 'claude',
        cacheFilePath,
        storeDir: storeRoot,
      }),
    ).rejects.toMatchObject({
      code: ErrorCode.TOOL_EXECUTION_FAILED,
      message: expect.stringContaining('agent timed out'),
    });

    // Verify the askUser cache entry was persisted despite the askAgent failure
    const cacheManager = new SnippetCacheManager(cacheFilePath);
    const cache = await cacheManager.read();
    const pkgCache = cache.packages['@test/demo'];
    expect(pkgCache).toBeDefined();
    expect(pkgCache.version).toBe('1.0.0');
    // Should have at least the askUser snippet cached
    const askUserSnippets = pkgCache.snippets.filter((s: { type: string }) => s.type === 'askUser');
    expect(askUserSnippets.length).toBeGreaterThanOrEqual(1);
    // Should NOT have any askAgent snippets (since it failed)
    const askAgentSnippets = pkgCache.snippets.filter((s: { type: string }) => s.type === 'askAgent');
    expect(askAgentSnippets).toHaveLength(0);
  });
});
