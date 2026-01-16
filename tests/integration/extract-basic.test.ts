import { promises as fs } from 'node:fs';
import path from 'node:path';

import { describe, it, expect } from 'vitest';

import { ensureBuilt, run } from '../helpers/cli';
import { createTempProject } from '../helpers/project';

describe('tz extract (basic)', () => {
  it('creates a scaffold with templates and manifest', async () => {
    const cli = await ensureBuilt();
    const proj = await createTempProject();
    const out = await fs.mkdtemp(path.join(process.env.TMPDIR || '/tmp', 'tz-ex-basic-'));
    const pr = proj.root;
    await proj.addCodexAgents(`Project path: ${pr}/docs`);
    await proj.addClaudeReadme('Hello Claude');
    await proj.setClaudeSettings({
      env: { ANTHROPIC_API_KEY: 'secret' },
      permissions: { additionalDirectories: [path.join(pr, 'docs'), '/var/tmp'] },
    });
    await proj.setClaudeMcp({ foo: { command: '/bin/echo', args: [path.join(pr, 'data')] } });
    await proj.addClaudeAgent('reviewer.md', `See ${pr}/README.md`);

    await run('node', [
      cli,
      'extract',
      '--from',
      proj.root,
      '--out',
      out,
      '--name',
      '@you/my-ctx',
      '--pkg-version',
      '1.0.0',
    ]);

    // Check outputs exist
    const manifestPath = path.join(out, 'agents.toml');
    const agentsToml = await fs.readFile(manifestPath, 'utf8');
    expect(agentsToml).toMatch(/\[package]/);
    expect(agentsToml).toMatch(/name = "@you\/my-ctx"/);
    expect(agentsToml).toMatch(/version = "1.0.0"/);
    expect(agentsToml).toMatch(/codex/);
    expect(agentsToml).toMatch(/claude/);
    expect(agentsToml).not.toMatch(/cursor/);
    expect(agentsToml).not.toMatch(/copilot/);

    const files = [
      path.join(out, 'templates', 'AGENTS.md.hbs'),
      path.join(out, 'templates', 'CLAUDE.md.hbs'),
      path.join(out, 'templates', 'claude', 'settings.json.hbs'),
      path.join(out, 'templates', 'claude', 'mcp_servers.json.hbs'),
      path.join(out, 'templates', 'claude', 'agents', 'reviewer.md.hbs'),
    ];
    for (const f of files) {
      await fs.stat(f);
    }

    const templ = await fs.readFile(
      path.join(out, 'templates', 'claude', 'settings.json.hbs'),
      'utf8',
    );
    expect(templ).toContain('{{ env.ANTHROPIC_API_KEY }}');
    expect(templ).toContain('{{ PROJECT_ROOT }}');
  });
});
