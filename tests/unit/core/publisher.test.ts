import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as tar from 'tar';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { buildPublishPlan, collectPackageFiles, createTarball } from '../../../src/core/publisher';

async function mkd(prefix: string): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
}

async function write(root: string, rel: string, data: string): Promise<void> {
  const abs = path.join(root, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, data, 'utf8');
}

describe('core/publisher', () => {
  let root = '';
  beforeAll(async () => {
    root = await mkd('tz-pub');
    await write(
      root,
      'agents.toml',
      `\n[package]\nname = "@u/demo"\nversion = "0.1.0"\n\n[exports.claude]\ntemplate = "templates/CLAUDE.md.hbs"\n`,
    );
    await write(root, 'README.md', '# Demo');
    await write(root, 'templates/CLAUDE.md.hbs', '# Hello');
  });
  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('collects allowed files', async () => {
    const files = await collectPackageFiles(root);
    expect(files).toContain('agents.toml');
    expect(files).toContain('README.md');
    expect(files).toContain('templates/CLAUDE.md.hbs');
  });

  it('builds a publish plan', async () => {
    const plan = await buildPublishPlan(root);
    expect(plan.name).toBe('@u/demo');
    expect(plan.version).toBe('0.1.0');
    expect(plan.files.length).toBeGreaterThanOrEqual(2);
  });

  it('creates a deterministic tarball', async () => {
    const files = await collectPackageFiles(root);
    const tgz = await createTarball(root, files);
    expect(tgz.length).toBeGreaterThan(0);
    // Write to temp and list to verify contents
    const tmpTgz = path.join(root, 'out.tgz');
    await fs.writeFile(tmpTgz, tgz);
    const listed: string[] = [];
    await tar.list({ file: tmpTgz, onentry: (e) => listed.push(e.path) });
    expect(listed).toContain('agents.toml');
    expect(listed).toContain('README.md');
    expect(listed).toContain('templates/CLAUDE.md.hbs');
  });
});

describe('core/publisher - export directories', () => {
  let root = '';

  afterAll(async () => {
    if (root) {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('includes promptsDir from exports', async () => {
    root = await mkd('tz-pub-prompts');
    await write(
      root,
      'agents.toml',
      `
[package]
name = "@u/web-qa"
version = "0.1.0"

[exports.claude]
template = "templates/CLAUDE.md.hbs"
promptsDir = "prompts"
`,
    );
    await write(root, 'README.md', '# Web QA');
    await write(root, 'templates/CLAUDE.md.hbs', '# Hello');
    await write(root, 'prompts/analyze-project.txt', 'Analyze the project');
    await write(root, 'prompts/nested/deep.txt', 'Deep prompt');

    const files = await collectPackageFiles(root);
    expect(files).toContain('agents.toml');
    expect(files).toContain('prompts/analyze-project.txt');
    expect(files).toContain('prompts/nested/deep.txt');
  });

  it('includes multiple export directories from multiple tools', async () => {
    root = await mkd('tz-pub-multi');
    await write(
      root,
      'agents.toml',
      `
[package]
name = "@u/multi"
version = "0.1.0"

[exports.claude]
template = "templates/CLAUDE.md.hbs"
promptsDir = "prompts"
commandsDir = "commands"

[exports.codex]
template = "templates/CODEX.md.hbs"
skillsDir = "skills"
`,
    );
    await write(root, 'README.md', '# Multi');
    await write(root, 'templates/CLAUDE.md.hbs', '# Claude');
    await write(root, 'templates/CODEX.md.hbs', '# Codex');
    await write(root, 'prompts/prompt1.txt', 'Prompt 1');
    await write(root, 'commands/cmd1.md', '# Command 1');
    await write(root, 'skills/skill1.md', '# Skill 1');

    const files = await collectPackageFiles(root);
    expect(files).toContain('prompts/prompt1.txt');
    expect(files).toContain('commands/cmd1.md');
    expect(files).toContain('skills/skill1.md');
  });

  it('does not duplicate files when dir is under templates/', async () => {
    root = await mkd('tz-pub-tpl-prompts');
    await write(
      root,
      'agents.toml',
      `
[package]
name = "@u/tpl-prompts"
version = "0.1.0"

[exports.claude]
template = "templates/CLAUDE.md.hbs"
promptsDir = "templates/prompts"
`,
    );
    await write(root, 'README.md', '# Test');
    await write(root, 'templates/CLAUDE.md.hbs', '# Hello');
    await write(root, 'templates/prompts/p1.txt', 'Prompt 1');

    const files = await collectPackageFiles(root);
    // Should only appear once even though templates/** is already included
    const promptCount = files.filter((f) => f === 'templates/prompts/p1.txt').length;
    expect(promptCount).toBe(1);
  });

  it('handles missing export directories gracefully', async () => {
    root = await mkd('tz-pub-missing');
    await write(
      root,
      'agents.toml',
      `
[package]
name = "@u/missing"
version = "0.1.0"

[exports.claude]
template = "templates/CLAUDE.md.hbs"
promptsDir = "nonexistent"
`,
    );
    await write(root, 'README.md', '# Test');
    await write(root, 'templates/CLAUDE.md.hbs', '# Hello');

    // Should not throw
    const files = await collectPackageFiles(root);
    expect(files).toContain('agents.toml');
    expect(files).not.toContain('nonexistent');
  });

  it('includes subagentsDir from exports', async () => {
    root = await mkd('tz-pub-subagents');
    await write(
      root,
      'agents.toml',
      `
[package]
name = "@u/subagents"
version = "0.1.0"

[exports.claude]
template = "templates/CLAUDE.md.hbs"
subagentsDir = "agents"
`,
    );
    await write(root, 'README.md', '# Test');
    await write(root, 'templates/CLAUDE.md.hbs', '# Hello');
    await write(root, 'agents/helper.md', '# Helper agent');

    const files = await collectPackageFiles(root);
    expect(files).toContain('agents/helper.md');
  });

  it('deduplicates directories referenced by multiple tools', async () => {
    root = await mkd('tz-pub-dedup');
    await write(
      root,
      'agents.toml',
      `
[package]
name = "@u/dedup"
version = "0.1.0"

[exports.claude]
template = "templates/CLAUDE.md.hbs"
promptsDir = "prompts"

[exports.codex]
template = "templates/CODEX.md.hbs"
promptsDir = "prompts"
`,
    );
    await write(root, 'README.md', '# Test');
    await write(root, 'templates/CLAUDE.md.hbs', '# Claude');
    await write(root, 'templates/CODEX.md.hbs', '# Codex');
    await write(root, 'prompts/shared.txt', 'Shared prompt');

    const files = await collectPackageFiles(root);
    // Should only appear once even though both tools reference it
    const promptCount = files.filter((f) => f === 'prompts/shared.txt').length;
    expect(promptCount).toBe(1);
  });
});
