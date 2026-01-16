import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensureBuilt, run, runReject } from '../helpers/cli';

async function makeTempDir(prefix: string): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function rimraf(target: string): Promise<void> {
  await fs.rm(target, { recursive: true, force: true }).catch(() => {});
}

describe('tz create command (automated)', () => {
  let cli: string;
  let tmpDir: string;

  beforeEach(async () => {
    cli = await ensureBuilt();
    tmpDir = await makeTempDir('tz-create-int-');
  });

  afterEach(async () => {
    await rimraf(tmpDir);
  });

  it('creates a new scaffold when automation payload is provided', async () => {
    const automation = {
      description: 'Integration-created package',
      license: 'Apache-2.0',
      tools: ['claude', 'codex', 'gemini'],
      includeExamples: true,
      includeHooks: true,
      version: '0.0.0',
    };

    const { stdout } = await run('node', [cli, 'create', '@integration/demo-agents'], {
      cwd: tmpDir,
      env: {
        TZ_CREATE_AUTOFILL: JSON.stringify(automation),
        FORCE_COLOR: '0',
      },
    });

    const createdDir = path.join(tmpDir, 'demo-agents');
    const manifestPath = path.join(createdDir, 'agents.toml');
    const readmePath = path.join(createdDir, 'README.md');
    const gitignorePath = path.join(createdDir, '.gitignore');

    const manifest = await fs.readFile(manifestPath, 'utf8');
    const readme = await fs.readFile(readmePath, 'utf8');
    const gitignore = await fs.readFile(gitignorePath, 'utf8');

    expect(stdout).toContain('Package created at');
    expect(manifest).toContain('name = "@integration/demo-agents"');
    expect(manifest).toContain('[compatibility]');
    expect(manifest).toMatch(/claude\s*=\s*"\*"/);
    expect(manifest).toMatch(/gemini\s*=\s*"\*"/);
    expect(manifest).toContain('[exports.claude]');
    expect(manifest).toContain('template = "templates/CLAUDE.md.hbs"');
    expect(manifest).toContain('[exports.codex]');
    expect(readme).toContain('Integration-created package');
    expect(gitignore).toContain('agent_modules/');
    await expect(
      fs.stat(path.join(createdDir, 'templates', 'CLAUDE.md.hbs')),
    ).resolves.toBeTruthy();
    await expect(
      fs.stat(path.join(createdDir, 'templates', 'AGENTS.md.hbs')),
    ).resolves.toBeTruthy();
    await expect(
      fs.stat(path.join(createdDir, 'templates', 'GEMINI.md.hbs')),
    ).resolves.toBeTruthy();
    await expect(fs.stat(path.join(createdDir, 'templates'))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(createdDir, 'hooks'))).resolves.toBeTruthy();
  });

  it('honors dry-run automation without writing files', async () => {
    const automation = {
      description: 'Dry run package',
      license: 'MIT',
      tools: ['gemini'],
      includeExamples: false,
      includeHooks: false,
      dryRun: true,
    };

    const { stdout } = await run('node', [cli, 'create', '@integration/dry-run', '--dry-run'], {
      cwd: tmpDir,
      env: {
        TZ_CREATE_AUTOFILL: JSON.stringify(automation),
        FORCE_COLOR: '0',
      },
    });

    const createdDir = path.join(tmpDir, 'dry-run');
    await expect(fs.stat(createdDir)).rejects.toThrow();
    expect(stdout).toContain('DRY RUN: Would create package at');
  });

  it('fails when directory already exists without overwrite', async () => {
    const existingDir = path.join(tmpDir, 'demo-agents');
    await fs.mkdir(existingDir, { recursive: true });
    await fs.writeFile(path.join(existingDir, 'placeholder.txt'), 'exists', 'utf8');

    const automation = {
      description: 'Collision package',
      license: 'MIT',
      tools: [],
      includeExamples: false,
      includeHooks: false,
    };

    const { stderr, error } = await runReject('node', [cli, 'create', '@integration/demo-agents'], {
      cwd: tmpDir,
      env: {
        TZ_CREATE_AUTOFILL: JSON.stringify(automation),
        FORCE_COLOR: '0',
      },
    });

    expect(error).toBeTruthy();
    expect(stderr).toContain("Directory './demo-agents' already exists");
  });
});
