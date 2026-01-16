import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { setPackageTool, getPackageTool, readManifest } from '../../../src/utils/manifest.js';

async function createTempDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'tz-manifest-tool-'));
}

describe('setPackageTool', () => {
  it('sets tool field in existing manifest', async () => {
    const dir = await createTempDir();
    const manifest = `
[package]
name = "@demo/app"
version = "0.1.0"
`;
    await fs.writeFile(path.join(dir, 'agents.toml'), manifest, 'utf8');

    const changed = await setPackageTool(dir, 'claude');
    expect(changed).toBe(true);

    const after = await fs.readFile(path.join(dir, 'agents.toml'), 'utf8');
    expect(after).toContain('tool = "claude"');
  });

  it('updates existing tool field', async () => {
    const dir = await createTempDir();
    const manifest = `
[package]
name = "@demo/app"
version = "0.1.0"
tool = "claude"
`;
    await fs.writeFile(path.join(dir, 'agents.toml'), manifest, 'utf8');

    const changed = await setPackageTool(dir, 'codex');
    expect(changed).toBe(true);

    const after = await fs.readFile(path.join(dir, 'agents.toml'), 'utf8');
    expect(after).toContain('tool = "codex"');
    expect(after).not.toContain('tool = "claude"');
  });

  it('sets gemini as tool', async () => {
    const dir = await createTempDir();
    const manifest = `
[package]
name = "@demo/app"
version = "0.1.0"
`;
    await fs.writeFile(path.join(dir, 'agents.toml'), manifest, 'utf8');

    const changed = await setPackageTool(dir, 'gemini');
    expect(changed).toBe(true);

    const after = await fs.readFile(path.join(dir, 'agents.toml'), 'utf8');
    expect(after).toContain('tool = "gemini"');
  });

  it('returns false when tool already matches', async () => {
    const dir = await createTempDir();
    const manifest = `
[package]
name = "@demo/app"
version = "0.1.0"
tool = "claude"
`;
    await fs.writeFile(path.join(dir, 'agents.toml'), manifest, 'utf8');

    const changed = await setPackageTool(dir, 'claude');
    expect(changed).toBe(false);
  });

  it('removes tool field when null is passed', async () => {
    const dir = await createTempDir();
    const manifest = `
[package]
name = "@demo/app"
version = "0.1.0"
tool = "claude"
`;
    await fs.writeFile(path.join(dir, 'agents.toml'), manifest, 'utf8');

    const changed = await setPackageTool(dir, null);
    expect(changed).toBe(true);

    const after = await fs.readFile(path.join(dir, 'agents.toml'), 'utf8');
    expect(after).not.toContain('tool');
  });

  it('returns false when removing non-existent tool', async () => {
    const dir = await createTempDir();
    const manifest = `
[package]
name = "@demo/app"
version = "0.1.0"
`;
    await fs.writeFile(path.join(dir, 'agents.toml'), manifest, 'utf8');

    const changed = await setPackageTool(dir, null);
    expect(changed).toBe(false);
  });

  it('returns false when manifest does not exist', async () => {
    const dir = await createTempDir();

    const changed = await setPackageTool(dir, 'claude');
    expect(changed).toBe(false);
  });

  it('preserves other sections when updating', async () => {
    const dir = await createTempDir();
    const manifest = `
[package]
name = "@demo/app"
version = "0.1.0"

[dependencies]
"@acme/foo" = "^1.0.0"

[compatibility]
claude = "*"
`;
    await fs.writeFile(path.join(dir, 'agents.toml'), manifest, 'utf8');

    await setPackageTool(dir, 'codex');

    const after = await fs.readFile(path.join(dir, 'agents.toml'), 'utf8');
    expect(after).toContain('tool = "codex"');
    expect(after).toContain('@acme/foo');
    expect(after).toContain('[compatibility]');
  });

  it('creates package section if missing', async () => {
    const dir = await createTempDir();
    const manifest = `
[dependencies]
"@acme/foo" = "^1.0.0"
`;
    await fs.writeFile(path.join(dir, 'agents.toml'), manifest, 'utf8');

    const changed = await setPackageTool(dir, 'claude');
    expect(changed).toBe(true);

    const after = await fs.readFile(path.join(dir, 'agents.toml'), 'utf8');
    expect(after).toContain('[package]');
    expect(after).toContain('tool = "claude"');
  });
});

describe('getPackageTool', () => {
  it('returns tool when set', async () => {
    const dir = await createTempDir();
    const manifest = `
[package]
name = "@demo/app"
version = "0.1.0"
tool = "claude"
`;
    await fs.writeFile(path.join(dir, 'agents.toml'), manifest, 'utf8');

    const tool = await getPackageTool(dir);
    expect(tool).toBe('claude');
  });

  it('returns null when tool not set', async () => {
    const dir = await createTempDir();
    const manifest = `
[package]
name = "@demo/app"
version = "0.1.0"
`;
    await fs.writeFile(path.join(dir, 'agents.toml'), manifest, 'utf8');

    const tool = await getPackageTool(dir);
    expect(tool).toBe(null);
  });

  it('returns undefined when manifest does not exist', async () => {
    const dir = await createTempDir();

    const tool = await getPackageTool(dir);
    expect(tool).toBe(undefined);
  });

  it('returns gemini when set', async () => {
    const dir = await createTempDir();
    const manifest = `
[package]
name = "@demo/app"
version = "0.1.0"
tool = "gemini"
`;
    await fs.writeFile(path.join(dir, 'agents.toml'), manifest, 'utf8');

    const tool = await getPackageTool(dir);
    expect(tool).toBe('gemini');
  });
});

describe('readManifest with tool field', () => {
  it('parses claude tool', async () => {
    const dir = await createTempDir();
    const manifest = `
[package]
name = "@demo/app"
version = "0.1.0"
tool = "claude"
`;
    await fs.writeFile(path.join(dir, 'agents.toml'), manifest, 'utf8');

    const parsed = await readManifest(dir);
    expect(parsed?.package?.tool).toBe('claude');
  });

  it('parses codex tool', async () => {
    const dir = await createTempDir();
    const manifest = `
[package]
name = "@demo/app"
version = "0.1.0"
tool = "codex"
`;
    await fs.writeFile(path.join(dir, 'agents.toml'), manifest, 'utf8');

    const parsed = await readManifest(dir);
    expect(parsed?.package?.tool).toBe('codex');
  });

  it('parses gemini tool', async () => {
    const dir = await createTempDir();
    const manifest = `
[package]
name = "@demo/app"
version = "0.1.0"
tool = "gemini"
`;
    await fs.writeFile(path.join(dir, 'agents.toml'), manifest, 'utf8');

    const parsed = await readManifest(dir);
    expect(parsed?.package?.tool).toBe('gemini');
  });

  it('ignores invalid tool values', async () => {
    const dir = await createTempDir();
    const manifest = `
[package]
name = "@demo/app"
version = "0.1.0"
tool = "invalid"
`;
    await fs.writeFile(path.join(dir, 'agents.toml'), manifest, 'utf8');

    const parsed = await readManifest(dir);
    expect(parsed?.package?.tool).toBeUndefined();
  });
});
