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

describe('tz run @owner/package', () => {
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
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'tz-run-pkg-home-'));
    tmpProj = await fs.mkdtemp(path.join(os.tmpdir(), 'tz-run-pkg-proj-'));
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

  it('auto-installs package if not present', async () => {
    const env = { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome, TZ_SKIP_SPAWN: 'true' };
    await run('node', [cli, 'init', '--name', '@e2e/run-auto-install'], { cwd: tmpProj, env });

    // Run specific package without installing first
    await run('node', [cli, 'run', '@terrazul/starter@^1.1.0'], { cwd: tmpProj, env });

    // Verify package was installed
    const starterLink = path.join(tmpProj, 'agent_modules', '@terrazul', 'starter');
    const stats = await fs.lstat(starterLink);
    expect(stats.isDirectory()).toBe(true);

    // Verify lockfile was created
    const lock = await fs.readFile(path.join(tmpProj, 'agents-lock.toml'), 'utf8');
    expect(lock).toContain('@terrazul/starter');
  });

  it('strips query params from resolved URLs in lockfile during auto-install', async () => {
    const env = { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome, TZ_SKIP_SPAWN: 'true' };
    await run('node', [cli, 'init', '--name', '@e2e/run-strip-query'], { cwd: tmpProj, env });

    // Run specific package (auto-install will fetch tarball info with signed URL)
    await run('node', [cli, 'run', '@terrazul/starter@^1.1.0'], { cwd: tmpProj, env });

    // Verify lockfile was created and resolved URLs have no query params
    const lock = await fs.readFile(path.join(tmpProj, 'agents-lock.toml'), 'utf8');

    // Check that lockfile contains the package
    expect(lock).toContain('@terrazul/starter');

    // The dummy registry returns S3-style signed URLs with X-Amz-* query params
    // Verify these are stripped from the lockfile
    expect(lock).not.toContain('X-Amz-Algorithm');
    expect(lock).not.toContain('X-Amz-Credential');
    expect(lock).not.toContain('X-Amz-Signature');

    // Verify the resolved URL ends with .tgz (no query string)
    const resolvedMatch = lock.match(/resolved\s*=\s*"([^"]+)"/);
    expect(resolvedMatch).toBeTruthy();
    expect(resolvedMatch![1]).toMatch(/\.tgz$/);
    expect(resolvedMatch![1]).not.toContain('?');
  });

  it('skips rendering if files already exist', async () => {
    const env = { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome, TZ_SKIP_SPAWN: 'true' };
    await run('node', [cli, 'init', '--name', '@e2e/run-skip-render'], { cwd: tmpProj, env });

    // Install and render first time
    const manifest = `
[package]
name = "@e2e/run-skip-render"
version = "0.1.0"

[dependencies]
"@terrazul/starter" = "^1.1.0"
`;
    await fs.writeFile(path.join(tmpProj, 'agents.toml'), manifest, 'utf8');
    await run('node', [cli, 'install'], { cwd: tmpProj, env });

    // Verify rendered file was created in agent_modules
    const renderedClaudeMd = path.join(
      tmpProj,
      'agent_modules',
      '@terrazul',
      'starter',
      'CLAUDE.md',
    );
    const firstRender = await fs.readFile(renderedClaudeMd, 'utf8');
    const firstStat = await fs.stat(renderedClaudeMd);
    const firstMtime = firstStat.mtimeMs;

    // Wait a bit to ensure different mtime if file is rewritten
    await delay(100);

    // Run again - should skip rendering
    await run('node', [cli, 'run', '@terrazul/starter'], { cwd: tmpProj, env });

    // Verify rendered file was NOT rewritten
    const secondStat = await fs.stat(renderedClaudeMd);
    const secondMtime = secondStat.mtimeMs;
    expect(secondMtime).toBe(firstMtime);

    const secondRender = await fs.readFile(renderedClaudeMd, 'utf8');
    expect(secondRender).toBe(firstRender);
  });

  it('re-renders with --force flag', async () => {
    const env = { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome, TZ_SKIP_SPAWN: 'true' };
    await run('node', [cli, 'init', '--name', '@e2e/run-force-render'], { cwd: tmpProj, env });

    const manifest = `
[package]
name = "@e2e/run-force-render"
version = "0.1.0"

[dependencies]
"@terrazul/starter" = "^1.1.0"
`;
    await fs.writeFile(path.join(tmpProj, 'agents.toml'), manifest, 'utf8');
    await run('node', [cli, 'install'], { cwd: tmpProj, env });

    // Verify rendered file was created in agent_modules
    const renderedClaudeMd = path.join(
      tmpProj,
      'agent_modules',
      '@terrazul',
      'starter',
      'CLAUDE.md',
    );
    const firstStatResult = await fs.stat(renderedClaudeMd);
    const firstMtime = firstStatResult.mtimeMs;

    // Wait to ensure different mtime
    await delay(100);

    // Run with --force - should re-render
    await run('node', [cli, 'run', '@terrazul/starter', '--force'], { cwd: tmpProj, env });

    // Verify rendered file WAS rewritten
    const secondStatResult = await fs.stat(renderedClaudeMd);
    const secondMtime = secondStatResult.mtimeMs;
    expect(secondMtime).toBeGreaterThan(firstMtime);
  });

  it('runs only specified package, not others', async () => {
    const env = { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome, TZ_SKIP_SPAWN: 'true' };
    await run('node', [cli, 'init', '--name', '@e2e/run-specific'], { cwd: tmpProj, env });

    // Install multiple packages
    const manifest = `
[package]
name = "@e2e/run-specific"
version = "0.1.0"

[dependencies]
"@terrazul/starter" = "^1.1.0"
"@terrazul/base" = "^2.0.0"
`;
    await fs.writeFile(path.join(tmpProj, 'agents.toml'), manifest, 'utf8');
    await run('node', [cli, 'install', '--no-apply'], { cwd: tmpProj, env });

    // Run only @terrazul/starter
    await run('node', [cli, 'run', '@terrazul/starter'], { cwd: tmpProj, env });

    // Verify only starter was rendered in agent_modules
    const starterClaudeMd = path.join(
      tmpProj,
      'agent_modules',
      '@terrazul',
      'starter',
      'CLAUDE.md',
    );
    const starterExists = await fs
      .access(starterClaudeMd)
      .then(() => true)
      .catch(() => false);
    expect(starterExists).toBe(true);

    // Verify it contains expected content from starter
    const starterContent = await fs.readFile(starterClaudeMd, 'utf8');
    expect(starterContent).toContain('Hello');

    // Verify @terrazul/base was NOT rendered (no specific check needed, just that starter was rendered)
    const baseClaudeMd = path.join(tmpProj, 'agent_modules', '@terrazul', 'base', 'CLAUDE.md');
    const baseExists = await fs
      .access(baseClaudeMd)
      .then(() => true)
      .catch(() => false);
    // base should not be rendered since we only ran starter
    expect(baseExists).toBe(false);
  });

  it('runs all packages when no package specified', async () => {
    const env = { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome, TZ_SKIP_SPAWN: 'true' };
    await run('node', [cli, 'init', '--name', '@e2e/run-all'], { cwd: tmpProj, env });

    const manifest = `
[package]
name = "@e2e/run-all"
version = "0.1.0"

[dependencies]
"@terrazul/starter" = "^1.1.0"
`;
    await fs.writeFile(path.join(tmpProj, 'agents.toml'), manifest, 'utf8');
    await run('node', [cli, 'install', '--no-apply'], { cwd: tmpProj, env });

    // Run without package argument
    await run('node', [cli, 'run'], { cwd: tmpProj, env });

    // Verify files were rendered
    const claudeMdPath = path.join(tmpProj, 'CLAUDE.md');
    const exists = await fs
      .access(claudeMdPath)
      .then(() => true)
      .catch(() => false);

    expect(exists).toBe(true);
  });

  it('handles package not in registry gracefully', async () => {
    const env = { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome, TZ_SKIP_SPAWN: 'true' };
    await run('node', [cli, 'init', '--name', '@e2e/run-not-found'], { cwd: tmpProj, env });

    // Try to run a package that doesn't exist
    try {
      await run('node', [cli, 'run', '@nonexistent/package@1.0.0'], { cwd: tmpProj, env });
      expect.fail('Should have thrown an error');
    } catch (error) {
      expect(error).toBeDefined();
      expect((error as Error).message).toMatch(/not found|failed/i);
    }
  });
});
