import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { TerrazulError, ErrorCode } from '../../../src/core/errors';
import { collectPackageFiles, createTarball } from '../../../src/core/publisher';

async function mkd(prefix: string): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
}

async function write(root: string, rel: string, data: string): Promise<void> {
  const abs = path.join(root, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, data, 'utf8');
}

describe('core/publisher security', () => {
  let root = '';
  beforeAll(async () => {
    root = await mkd('tz-pub-sec');
    await write(
      root,
      'agents.toml',
      `\n[package]\nname = "@sec/demo"\nversion = "0.1.0"\n\n[exports.claude]\ntemplate = "templates/CLAUDE.md.hbs"\n`,
    );
    await write(root, 'templates/CLAUDE.md.hbs', '# ok');
  });
  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('includes internal symlinks that point within package root', async () => {
    const linkPath = path.join(root, 'templates', 'link.hbs');
    let symlinkCreated = false;
    try {
      await fs.symlink(path.join(root, 'templates', 'CLAUDE.md.hbs'), linkPath);
      symlinkCreated = true;
    } catch {
      // Windows or restricted environments may fail; skip assertion
    }
    const files = await collectPackageFiles(root);
    if (symlinkCreated) {
      expect(files).toContain('templates/link.hbs');
      await fs.unlink(linkPath);
    }
  });

  it('skips symlinks that point outside package root', async () => {
    const externalTarget = path.join(os.tmpdir(), 'tz-pub-sec-external-target.txt');
    const linkPath = path.join(root, 'templates', 'external-link.hbs');
    let symlinkCreated = false;
    try {
      await fs.writeFile(externalTarget, '# external', 'utf8');
      await fs.symlink(externalTarget, linkPath);
      symlinkCreated = true;
    } catch {
      // Windows or restricted environments may fail; skip assertion
    }
    const files = await collectPackageFiles(root);
    if (symlinkCreated) {
      expect(files).not.toContain('templates/external-link.hbs');
      await fs.unlink(linkPath);
      await fs.unlink(externalTarget);
    }
  });

  it('rejects path traversal in tarball input', async () => {
    await expect(createTarball(root, ['templates/../../evil.txt'])).rejects.toThrow(TerrazulError);
    await expect(createTarball(root, ['templates/../../evil.txt'])).rejects.toMatchObject({
      code: ErrorCode.INVALID_PACKAGE,
    });
  });
});
