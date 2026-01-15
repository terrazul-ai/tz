import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, it, expect } from 'vitest';

import { ensureBuilt, run } from '../helpers/cli';
import { createTempProject } from '../helpers/project';

async function trySymlink(
  target: string,
  linkPath: string,
  type: 'file' | 'dir' = 'file',
): Promise<boolean> {
  try {
    await fs.symlink(target, linkPath, type);
    return true;
  } catch (error: unknown) {
    // On Windows or restricted envs, symlink may fail with EPERM or EINVAL; skip in that case
    const msg = String((error as { message?: string } | undefined)?.message || error);
    if (/(eperm|einval|operation not permitted|a required privilege is not held)/i.test(msg))
      return false;
    throw error;
  }
}

describe('tz extract skips symlinks in inputs', () => {
  it('does not copy symlinked agent files', async () => {
    const cli = await ensureBuilt();
    const proj = await createTempProject();
    const out = await fs.mkdtemp(path.join(os.tmpdir(), 'tz-ex-out-'));

    // Ensure base artifacts so extract runs
    await proj.addCodexAgents('# enable');

    // .claude/agents with a real file and a symlink to it
    const agentsDir = path.join(proj.root, '.claude', 'agents');
    await fs.mkdir(agentsDir, { recursive: true });
    const realAgent = path.join(agentsDir, 'real.md');
    const linkAgent = path.join(agentsDir, 'link.md');
    await fs.writeFile(realAgent, '# real', 'utf8');
    const canLinkAgents = await trySymlink('real.md', linkAgent, 'file');

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

    // Real agent should exist; symlinked agent should NOT be copied
    await fs.stat(path.join(out, 'templates', 'claude', 'agents', 'real.md.hbs'));
    if (canLinkAgents) {
      await expect(
        fs.stat(path.join(out, 'templates', 'claude', 'agents', 'link.md.hbs')),
      ).rejects.toBeTruthy();
    }
  });
});
