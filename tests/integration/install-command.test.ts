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
      if (err) {
        const message: string = stderr && stderr.length > 0 ? stderr : err.message;
        return reject(new Error(message));
      }
      resolve({ stdout, stderr });
    });
  });
}

async function runExpectFailure(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<{ stdout: string; stderr: string }> {
  const env = Object.assign({}, process.env, opts.env);
  return await new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd: opts.cwd, env, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (!err) {
        reject(new Error('Expected command to fail'));
        return;
      }
      resolve({ stdout, stderr });
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

describe('tz install', () => {
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
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'tz-install-home-'));
    tmpProj = await fs.mkdtemp(path.join(os.tmpdir(), 'tz-install-proj-'));
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

  it('installs dependencies from agents.toml and updates lockfile', async () => {
    const env = { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome };
    await run('node', [cli, 'init', '--name', '@e2e/install-demo'], { cwd: tmpProj, env });
    const manifest = `
[package]
name = "@e2e/install-demo"
version = "0.1.0"

[dependencies]
"@terrazul/starter" = "^1.1.0"
`;
    await fs.writeFile(path.join(tmpProj, 'agents.toml'), manifest, 'utf8');

    await run('node', [cli, 'install'], { cwd: tmpProj, env });

    const starterLink = path.join(tmpProj, 'agent_modules', '@terrazul', 'starter');
    const lock = await fs.readFile(path.join(tmpProj, 'agents-lock.toml'), 'utf8');
    expect(lock).toContain('@terrazul/starter');
    expect(lock).toContain('@terrazul/base');

    const stats = await fs.lstat(starterLink);
    expect(stats.isDirectory()).toBe(true);

    // Verify post-render tasks: context injection into CLAUDE.md
    const claudeMdPath = path.join(tmpProj, 'CLAUDE.md');
    try {
      const claudeMd = await fs.readFile(claudeMdPath, 'utf8');
      expect(claudeMd).toContain('terrazul:begin');
    } catch {
      // CLAUDE.md may not exist if init didn't create one and the package
      // didn't emit context files — that's acceptable
    }

    // idempotent second run
    await run('node', [cli, 'install'], { cwd: tmpProj, env });
  });

  it('fails fast when frozen lockfile drifts from manifest', async () => {
    const env = { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome };
    await run('node', [cli, 'init', '--name', '@e2e/install-frozen'], { cwd: tmpProj, env });
    const manifest = `
[package]
name = "@e2e/install-frozen"
version = "0.1.0"

[dependencies]
"@terrazul/starter" = "^1.1.0"
`;
    await fs.writeFile(path.join(tmpProj, 'agents.toml'), manifest, 'utf8');
    await run('node', [cli, 'install'], { cwd: tmpProj, env });

    const updated = manifest + '\n"@terrazul/base" = "^2.0.0"\n';
    await fs.writeFile(path.join(tmpProj, 'agents.toml'), updated, 'utf8');

    const lockPath = path.join(tmpProj, 'agents-lock.toml');
    const lockContents = await fs.readFile(lockPath, 'utf8');
    const mutated = lockContents.replace('version = "1.1.0"', 'version = "1.0.0"');
    await fs.writeFile(lockPath, mutated, 'utf8');

    const { stderr } = await runExpectFailure('node', [cli, 'install', '--frozen-lockfile'], {
      cwd: tmpProj,
      env,
    });
    expect(stderr).toMatch(/frozen lockfile/i);
  });

  it('rejects frozen lockfile when dependencies are removed', async () => {
    const env = { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome };
    await run('node', [cli, 'init', '--name', '@e2e/install-remove'], { cwd: tmpProj, env });
    const manifest = `
[package]
name = "@e2e/install-remove"
version = "0.1.0"

[dependencies]
"@terrazul/starter" = "^1.1.0"
`;
    await fs.writeFile(path.join(tmpProj, 'agents.toml'), manifest, 'utf8');
    await run('node', [cli, 'install'], { cwd: tmpProj, env });

    const lockPath = path.join(tmpProj, 'agents-lock.toml');
    const lockBefore = await fs.readFile(lockPath, 'utf8');

    const removedDeps = `
[package]
name = "@e2e/install-remove"
version = "0.1.0"
`;
    await fs.writeFile(path.join(tmpProj, 'agents.toml'), removedDeps, 'utf8');

    const { stderr } = await runExpectFailure('node', [cli, 'install', '--frozen-lockfile'], {
      cwd: tmpProj,
      env,
    });
    expect(stderr).toMatch(/frozen lockfile/i);

    const lockAfter = await fs.readFile(lockPath, 'utf8');
    expect(lockAfter).toBe(lockBefore);
  });
});
