import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as TOML from '@iarna/toml';
import { describe, it, expect } from 'vitest';

import { ensureBuilt, run } from '../helpers/cli';
import { createTempProject } from '../helpers/project';

async function mkdtemp(prefix: string): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
}

describe('manifest snapshot (exports layout)', () => {
  it('matches expected TOML for common inputs', async () => {
    const cli = await ensureBuilt();
    const proj = await createTempProject();
    await proj.addCodexAgents('# Codex');
    await proj.addClaudeReadme('# Claude');
    await proj.setClaudeSettings({ env: { KEY: 'X' } });
    await proj.setClaudeMcp({ tool: { command: '/bin/echo', args: [] } });
    await proj.addClaudeAgent('agent.md', 'hello');
    const out = await mkdtemp('tz-extract-out');

    const fakeHome = await mkdtemp('tz-extract-home');

    await run(
      'node',
      [
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
      ],
      {
        env: {
          HOME: fakeHome,
          USERPROFILE: fakeHome,
        },
      },
    );
    const toml = await fs.readFile(path.join(out, 'agents.toml'), 'utf8');
    const doc = TOML.parse(toml) as Record<string, unknown>;

    const pkg = doc.package as Record<string, unknown> | undefined;
    expect(pkg?.name).toBe('@you/ctx');
    expect(pkg?.version).toBe('1.0.0');

    const exportsSection = doc.exports as Record<string, unknown> | undefined;
    const codexSection = (exportsSection?.codex ?? {}) as Record<string, unknown>;
    expect(codexSection.template).toBe('templates/AGENTS.md.hbs');
    expect(codexSection).not.toHaveProperty('mcpServers');

    const claudeSection = (exportsSection?.claude ?? {}) as Record<string, unknown>;
    expect(claudeSection.template).toBe('templates/CLAUDE.md.hbs');
    expect(claudeSection.mcpServers).toBe('templates/claude/mcp_servers.json.hbs');

    const metadata = doc.metadata as Record<string, unknown> | undefined;
    expect(metadata?.tz_spec_version).toBe(1);
  });
});
