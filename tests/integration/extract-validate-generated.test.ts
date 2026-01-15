import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, it, expect } from 'vitest';

import { ensureBuilt, run } from '../helpers/cli';
import { createTempProject } from '../helpers/project';

async function mkdtemp(prefix: string): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
}

describe('validate generated package', () => {
  it('tz validate passes on extracted scaffold', async () => {
    const cli = await ensureBuilt();
    const proj = await createTempProject();
    await proj.addCodexAgents('# Codex');
    await proj.addClaudeReadme('# Claude');
    await proj.setClaudeSettings({ env: { A: 'x' } });
    await proj.setClaudeMcp({ tool: { command: '/bin/echo', args: [] } });
    await proj.addClaudeAgent('team/dev.md', 'dev');
    const out = await mkdtemp('tz-extract-out');

    await run('node', [
      cli,
      'extract',
      '--from',
      proj.root,
      '--out',
      out,
      '--name',
      '@you/ctx',
      '--pkg-version',
      '1.0.0',
    ]);
    const { stdout } = await run('node', [cli, 'validate'], { cwd: out });
    expect(stdout).toMatch(/Manifest is valid/);
  });
});
