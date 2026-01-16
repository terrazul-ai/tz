import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os, { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { readUserConfigFrom, loadConfig } from '../../src/utils/config';

import type { MockInstance } from 'vitest';

function setTempHome(tmp: string): void {
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp; // windows
}

describe('config: profile.tools + files', () => {
  const envBackup = { ...process.env };
  let tmpDir = '';
  let homeSpy: MockInstance<[], string> | undefined;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), 'tz-test-'));
    setTempHome(tmpDir);
    delete process.env.TERRAZUL_TOKEN;
    homeSpy = vi.spyOn(os, 'homedir').mockReturnValue(tmpDir);
  });

  afterEach(async () => {
    process.env = { ...envBackup };
    homeSpy?.mockRestore();
    // Cleanup temp dir best-effort
    try {
      await rm(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });
  it('parses profile tools and merges default files', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'tz-cfg-'));
    const file = path.join(dir, 'config.json');
    await writeFile(
      file,
      JSON.stringify({
        profile: {
          tools: [{ type: 'codex', command: 'codex', args: ['exec'] }, { type: 'gemini' }],
        },
        context: { files: { claude: 'C.md' } },
      }),
      'utf8',
    );
    const cfg = await readUserConfigFrom(file);
    expect(cfg.profile?.tools?.[0]?.type).toBe('codex');
    // @ts-expect-error runtime assertion for defaults merge
    expect(cfg.context.files.claude).toBe('C.md');
    // @ts-expect-error runtime assertion for defaults merge
    expect(cfg.context.files.codex).toBe('AGENTS.md');
    // @ts-expect-error runtime assertion for defaults merge
    expect(cfg.context.files.gemini).toBe('GEMINI.md');
  });

  it('defaults Claude tool to Sonnet 4.5 model', async () => {
    const cfg = await loadConfig();
    const claudeTool = cfg.profile?.tools?.find((t) => t.type === 'claude');
    expect(claudeTool).toBeDefined();
    expect(claudeTool?.model).toBe('claude-sonnet-4-5-20250929');
  });
});
