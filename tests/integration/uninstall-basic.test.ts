import { execFile, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';

function run(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const env = Object.assign({}, process.env, opts.env);
    execFile(cmd, args, { cwd: opts.cwd, env, encoding: 'utf8' }, (err, stdout, stderr) => {
      const out = stdout;
      const errOut = stderr;
      if (err) {
        const message: string = errOut && errOut.length > 0 ? errOut : err.message;
        return reject(new Error(message));
      }
      resolve({ stdout: out, stderr: errOut });
    });
  });
}

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const address = srv.address();
      if (address && typeof address === 'object') {
        const p = address.port;
        srv.close(() => resolve(p));
      } else {
        srv.close(() => reject(new Error('no-address')));
      }
    });
    srv.on('error', reject);
  });
}

function startDummyRegistry(port: number): Promise<ChildProcessByStdio<null, Readable, Readable>> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ['node_modules/tsx/dist/cli.mjs', 'tools/dummy-registry.ts'],
      { env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let resolved = false;
    const onData = (b: Buffer) => {
      if (b.toString('utf8').includes('Dummy registry server running')) {
        cleanup();
        resolved = true;
        resolve(child);
      }
    };
    function cleanup() {
      child.stdout.off('data', onData);
      child.stderr.off('data', onData);
    }
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    setTimeout(() => {
      if (!resolved) {
        cleanup();
        resolve(child);
      }
    }, 1000).unref();
  });
}

async function waitForHealth(base: string, timeoutMs = 10_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) return;
    } catch {
      void 0;
    }
    if (Date.now() > end) throw new Error(`Registry health check timed out at ${base}`);
    await delay(100);
  }
}

async function ensureBuilt(): Promise<string> {
  const cli = path.join(process.cwd(), 'dist', 'tz.mjs');
  try {
    await fs.stat(cli);
  } catch {
    await run('node', ['build.config.mjs']);
  }
  return cli;
}

describe('tz uninstall', () => {
  let PORT = 0;
  let BASE = '';
  let child: ChildProcessByStdio<null, Readable, Readable> | null = null;
  let tmpHome = '';
  let tmpProj = '';
  let cli = '';

  beforeAll(async () => {
    PORT = await getFreePort();
    BASE = `http://localhost:${PORT}`;
    child = await startDummyRegistry(PORT);
    await waitForHealth(BASE);
    cli = await ensureBuilt();
  });

  afterAll(() => {
    if (child) child.kill('SIGINT');
  });

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'tz-uninstall-home-'));
    tmpProj = await fs.mkdtemp(path.join(os.tmpdir(), 'tz-uninstall-proj-'));
    const cfgDir = path.join(tmpHome, '.terrazul');
    await fs.mkdir(cfgDir, { recursive: true });
    const cfg = { registry: BASE, cache: { ttl: 3600, maxSize: 500 }, telemetry: false };
    await fs.writeFile(path.join(cfgDir, 'config.json'), JSON.stringify(cfg, null, 2));
  });

  afterEach(async () => {
    try {
      await fs.rm(tmpProj, { recursive: true, force: true });
    } catch {
      void 0;
    }
    try {
      await fs.rm(tmpHome, { recursive: true, force: true });
    } catch {
      void 0;
    }
  });

  it('removes package, transitive deps, and manifest entry', async () => {
    const env = { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome };
    await run('node', [cli, 'init', '--name', '@e2e/uninstall-demo'], { cwd: tmpProj, env });

    const manifest = `
[package]
name = "@e2e/uninstall-demo"
version = "0.1.0"

[dependencies]
"@terrazul/starter" = "^1.1.0"
`;
    await fs.writeFile(path.join(tmpProj, 'agents.toml'), manifest, 'utf8');

    await run('node', [cli, 'add', '@terrazul/starter@1.1.0'], { cwd: tmpProj, env });

    const starterPath = path.join(tmpProj, 'agent_modules', '@terrazul', 'starter');
    const basePath = path.join(tmpProj, 'agent_modules', '@terrazul', 'base');
    expect(await fs.lstat(starterPath).then(() => true)).toBe(true);
    expect(await fs.lstat(basePath).then(() => true)).toBe(true);

    await run('node', [cli, 'uninstall', '@terrazul/starter'], { cwd: tmpProj, env });

    const starterExists = await fs
      .lstat(starterPath)
      .then(() => true)
      .catch(() => false);
    const baseExists = await fs
      .lstat(basePath)
      .then(() => true)
      .catch(() => false);
    expect(starterExists).toBe(false);
    expect(baseExists).toBe(false);

    const lock = await fs.readFile(path.join(tmpProj, 'agents-lock.toml'), 'utf8');
    expect(lock).not.toContain('@terrazul/starter');
    expect(lock).not.toContain('@terrazul/base');

    const manifestAfter = await fs.readFile(path.join(tmpProj, 'agents.toml'), 'utf8');
    expect(manifestAfter).not.toContain('@terrazul/starter');

    // idempotent
    await run('node', [cli, 'uninstall', '@terrazul/starter'], { cwd: tmpProj, env });
  });

  it('refuses to uninstall packages still required by other installed packages', async () => {
    const env = { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome };
    await run('node', [cli, 'init', '--name', '@e2e/uninstall-dep-check'], { cwd: tmpProj, env });

    const manifest = `
[package]
name = "@e2e/uninstall-dep-check"
version = "0.1.0"

[dependencies]
"@terrazul/starter" = "^1.1.0"
`;
    await fs.writeFile(path.join(tmpProj, 'agents.toml'), manifest, 'utf8');

    await run('node', [cli, 'add', '@terrazul/starter@1.1.0'], { cwd: tmpProj, env });

    const basePath = path.join(tmpProj, 'agent_modules', '@terrazul', 'base');
    expect(await fs.lstat(basePath).then(() => true)).toBe(true);

    await expect(
      run('node', [cli, 'uninstall', '@terrazul/base'], { cwd: tmpProj, env }),
    ).rejects.toThrow(/required by/i);

    const baseStillExists = await fs
      .lstat(basePath)
      .then(() => true)
      .catch(() => false);
    expect(baseStillExists).toBe(true);

    const lock = await fs.readFile(path.join(tmpProj, 'agents-lock.toml'), 'utf8');
    expect(lock).toContain('@terrazul/base');
  });

  it('clears snippet cache entries for uninstalled package and pruned deps', async () => {
    const env = { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome };
    await run('node', [cli, 'init', '--name', '@e2e/uninstall-cache-test'], { cwd: tmpProj, env });

    const manifest = `
[package]
name = "@e2e/uninstall-cache-test"
version = "0.1.0"

[dependencies]
"@terrazul/starter" = "^1.1.0"
`;
    await fs.writeFile(path.join(tmpProj, 'agents.toml'), manifest, 'utf8');

    await run('node', [cli, 'add', '@terrazul/starter@1.1.0'], { cwd: tmpProj, env });

    // Create a cache file with entries for the installed packages and one other package
    const cacheContent = `
version = 1

[packages."@terrazul/starter"]
version = "1.1.0"
snippets = [
  { id = "starter_snippet", type = "askUser", prompt_excerpt = "Question?", value = "Answer", timestamp = "2025-01-01T00:00:00.000Z" }
]

[packages."@terrazul/base"]
version = "1.0.0"
snippets = [
  { id = "base_snippet", type = "askAgent", prompt_excerpt = "Agent question", value = "Agent answer", timestamp = "2025-01-01T00:00:00.000Z" }
]

[packages."@other/package"]
version = "2.0.0"
snippets = [
  { id = "other_snippet", type = "askUser", prompt_excerpt = "Other question", value = "Other answer", timestamp = "2025-01-01T00:00:00.000Z" }
]

[metadata]
generated_at = "2025-01-01T00:00:00.000Z"
cli_version = "0.1.0"
`;
    const cachePath = path.join(tmpProj, 'agents-cache.toml');
    await fs.writeFile(cachePath, cacheContent.trim(), 'utf8');

    // Uninstall the starter package (which should also prune @terrazul/base)
    await run('node', [cli, 'uninstall', '@terrazul/starter'], { cwd: tmpProj, env });

    // Verify the cache file was updated
    const cacheAfter = await fs.readFile(cachePath, 'utf8');

    // Cache entries for @terrazul/starter and @terrazul/base should be removed
    expect(cacheAfter).not.toContain('@terrazul/starter');
    expect(cacheAfter).not.toContain('@terrazul/base');

    // Cache entries for @other/package should be PRESERVED
    expect(cacheAfter).toContain('@other/package');
    expect(cacheAfter).toContain('other_snippet');
  });
});
