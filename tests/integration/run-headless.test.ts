import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<{ stdout: string; stderr: string }> {
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

async function ensureBuilt(): Promise<string> {
  const cli = path.join(process.cwd(), 'dist', 'tz.mjs');
  try {
    await fs.stat(cli);
  } catch {
    await run('node', ['build.config.mjs']);
  }
  return cli;
}

describe('tz run -p (headless mode)', () => {
  let tmpHome = '';
  let tmpProj = '';
  let tmpBin = '';
  let cli = '';
  let invocationLog = '';

  beforeAll(async () => {
    cli = await ensureBuilt();
  });

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'tz-headless-home-'));
    tmpProj = await fs.mkdtemp(path.join(os.tmpdir(), 'tz-headless-proj-'));
    tmpBin = await fs.mkdtemp(path.join(os.tmpdir(), 'tz-headless-bin-'));
    invocationLog = path.join(tmpBin, 'claude-invocation.log');

    // Create config without registry (we won't need it for these tests)
    const cfgDir = path.join(tmpHome, '.terrazul');
    await fs.mkdir(cfgDir, { recursive: true });
    const cfg = {
      registry: 'http://localhost:9999', // dummy, won't be used
      cache: { ttl: 3600, maxSize: 500 },
      telemetry: false,
    };
    await fs.writeFile(path.join(cfgDir, 'config.json'), JSON.stringify(cfg, null, 2));

    // Create stub claude script that logs its invocation
    const stubScript =
      process.platform === 'win32'
        ? `@echo off
echo %* > "${invocationLog}"
exit /b 0`
        : `#!/bin/bash
echo "$@" > "${invocationLog}"
exit 0`;

    const stubPath = path.join(tmpBin, process.platform === 'win32' ? 'claude.cmd' : 'claude');
    await fs.writeFile(stubPath, stubScript, { mode: 0o755 });

    // Create basic project structure
    await fs.mkdir(path.join(tmpProj, 'agent_modules'), { recursive: true });
    await fs.mkdir(path.join(tmpProj, '.terrazul'), { recursive: true });

    // Create minimal agents.toml
    const manifest = `
[package]
name = "@test/headless-test"
version = "0.1.0"
`;
    await fs.writeFile(path.join(tmpProj, 'agents.toml'), manifest, 'utf8');
  });

  afterEach(async () => {
    for (const dir of [tmpProj, tmpHome, tmpBin]) {
      try {
        await fs.rm(dir, { recursive: true, force: true });
      } catch {
        void 0;
      }
    }
  });

  it('passes -p flag and prompt to claude CLI', async () => {
    const testPrompt = 'List all TypeScript files';
    const env = {
      ...process.env,
      HOME: tmpHome,
      USERPROFILE: tmpHome,
      PATH: `${tmpBin}${path.delimiter}${process.env.PATH}`,
    };

    await run('node', [cli, 'run', '-p', testPrompt], { cwd: tmpProj, env });

    // Read the invocation log to verify arguments
    const invocation = await fs.readFile(invocationLog, 'utf8');

    // Verify -p flag and prompt are present
    expect(invocation).toContain('-p');
    expect(invocation).toContain(testPrompt);
  });

  it('includes --mcp-config and --strict-mcp-config flags', async () => {
    const env = {
      ...process.env,
      HOME: tmpHome,
      USERPROFILE: tmpHome,
      PATH: `${tmpBin}${path.delimiter}${process.env.PATH}`,
    };

    await run('node', [cli, 'run', '-p', 'test prompt'], { cwd: tmpProj, env });

    const invocation = await fs.readFile(invocationLog, 'utf8');

    expect(invocation).toContain('--mcp-config');
    expect(invocation).toContain('--strict-mcp-config');
  });

  it('errors when using headless mode with non-claude tool', async () => {
    const env = {
      ...process.env,
      HOME: tmpHome,
      USERPROFILE: tmpHome,
      TZ_SKIP_SPAWN: 'true',
    };

    try {
      await run('node', [cli, 'run', '--tool', 'codex', '-p', 'test prompt'], {
        cwd: tmpProj,
        env,
      });
      expect.fail('Should have thrown an error');
    } catch (error) {
      expect(error).toBeDefined();
      expect((error as Error).message).toMatch(/headless.*only supported.*claude/i);
    }
  });

  it('works with --verbose flag for debug logging', async () => {
    const env = {
      ...process.env,
      HOME: tmpHome,
      USERPROFILE: tmpHome,
      PATH: `${tmpBin}${path.delimiter}${process.env.PATH}`,
    };

    const { stdout, stderr } = await run('node', [cli, 'run', '-p', 'test prompt', '--verbose'], {
      cwd: tmpProj,
      env,
    });

    // When verbose, should include debug output about spawning
    const output = stdout + stderr;
    expect(output).toContain('Running Claude Code in headless mode');
  });

  it('can combine headless mode with --force flag', async () => {
    const env = {
      ...process.env,
      HOME: tmpHome,
      USERPROFILE: tmpHome,
      PATH: `${tmpBin}${path.delimiter}${process.env.PATH}`,
    };

    // Should not error when combining -p with --force
    await run('node', [cli, 'run', '-p', 'test prompt', '--force'], { cwd: tmpProj, env });

    // Verify the command was invoked
    const invocation = await fs.readFile(invocationLog, 'utf8');
    expect(invocation).toContain('-p');
  });
});
