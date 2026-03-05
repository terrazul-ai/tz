#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i];
    if (current === '--target') {
      args.target = argv[++i];
    } else if (current === '--skip-build') {
      args.skipBuild = true;
    } else if (current === '--node-binary') {
      args.nodeBinary = argv[++i];
    }
  }
  if (!args.target) {
    throw new Error('Missing required --target argument');
  }
  return args;
}

function binaryNameForTarget(target) {
  return target.startsWith('win32') ? `tz-${target}.exe` : `tz-${target}`;
}

function normalizePathSegment(segment, platform) {
  if (!segment) {
    return '';
  }
  if (platform === 'win32') {
    return segment.replace(/[\\/]+$/u, '').toLowerCase();
  }
  return segment;
}

export function createSpawnEnv({
  baseEnv = process.env,
  overrideEnv = {},
  platform = process.platform,
} = {}) {
  const env = { ...baseEnv, ...overrideEnv };
  const pnpmHome = overrideEnv.PNPM_HOME ?? baseEnv?.PNPM_HOME ?? process.env.PNPM_HOME;
  if (!pnpmHome) {
    return env;
  }

  const delimiter = platform === 'win32' ? ';' : ':';
  const existingPath = platform === 'win32' ? (env.Path ?? env.PATH ?? '') : (env.PATH ?? '');
  const segments = existingPath ? existingPath.split(delimiter) : [];
  const normalizedPnpm = normalizePathSegment(pnpmHome, platform);
  const hasPnpm = segments.some(
    (segment) => normalizePathSegment(segment, platform) === normalizedPnpm,
  );

  const filteredSegments = segments.filter((segment) => segment.length > 0);
  const finalSegments = hasPnpm ? filteredSegments : [pnpmHome, ...filteredSegments];
  const newPath = finalSegments.join(delimiter);

  env.PATH = newPath;
  if (platform === 'win32') {
    env.Path = newPath;
  }

  return env;
}

function getEnvValue(env, key) {
  const match = Object.keys(env ?? {}).find((name) => name.toLowerCase() === key.toLowerCase());
  return match ? env[match] : undefined;
}

export function resolveCommand(cmd, env = process.env, platform = process.platform) {
  if (cmd === 'pnpm') {
    const pnpmHome = getEnvValue(env, 'PNPM_HOME') ?? process.env.PNPM_HOME;
    if (platform === 'win32') {
      if (pnpmHome) {
        return path.join(pnpmHome, 'pnpm.cmd');
      }
      return 'pnpm.cmd';
    }
    if (pnpmHome) {
      return path.join(pnpmHome, 'pnpm');
    }
  }
  return cmd;
}

function shouldUseShell(command, platform) {
  if (platform !== 'win32') {
    return false;
  }
  const ext = path.extname(command).toLowerCase();
  return ext === '.cmd' || ext === '.bat';
}

async function spawnOnce(command, args, options, spawnEnv, platform) {
  const useShell = shouldUseShell(command, platform);

  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      ...options,
      env: spawnEnv,
      shell: useShell,
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(' ')} exited with ${code}`));
      }
    });
  });
}

async function run(cmd, args, options = {}) {
  const { env: overrideEnv = {}, ...rest } = options;
  const baseEnv = { ...process.env, ...overrideEnv };
  const spawnEnv = createSpawnEnv({ baseEnv, overrideEnv, platform: process.platform });
  const resolvedCommand = resolveCommand(cmd, spawnEnv, process.platform);

  try {
    await spawnOnce(resolvedCommand, args, rest, spawnEnv, process.platform);
  } catch (error) {
    if ((error?.code === 'ENOENT' || error?.code === 'EINVAL') && resolvedCommand !== cmd) {
      await spawnOnce(cmd, args, rest, spawnEnv, process.platform);
      return;
    }
    throw error;
  }
}

async function fileExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function resolvePostject(repoRoot) {
  const isWindows = process.platform === 'win32';
  const localBin = path.join(
    repoRoot,
    'node_modules',
    '.bin',
    isWindows ? 'postject.cmd' : 'postject',
  );
  if (await fileExists(localBin)) {
    return { command: localBin, args: [] };
  }
  return { command: 'pnpm', args: ['dlx', 'postject@1.0.0-alpha.6'] };
}

async function main() {
  const { target, skipBuild, nodeBinary } = parseArgs(process.argv.slice(2));
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(scriptDir, '..', '..');
  const buildOutDir = path.join(repoRoot, 'build', 'out', target);
  const distDir = path.join(repoRoot, 'dist');
  const seaConfigPath = path.join(repoRoot, 'sea.config.json');
  const blobPath = path.join(distDir, 'sea-prep.blob');
  const binaryName = binaryNameForTarget(target);
  const binaryOutputPath = path.join(buildOutDir, binaryName);
  const normalizedNodeBinary =
    typeof nodeBinary === 'string'
      ? nodeBinary
          .trim()
          .replace(/^['"]+/, '')
          .replace(/['"]+$/, '')
      : undefined;
  const nodeBinarySource = (() => {
    if (!normalizedNodeBinary || normalizedNodeBinary.length === 0) {
      return process.execPath;
    }
    if (path.isAbsolute(normalizedNodeBinary)) {
      return normalizedNodeBinary;
    }
    return path.join(repoRoot, normalizedNodeBinary);
  })();

  await fs.mkdir(buildOutDir, { recursive: true });
  await fs.mkdir(distDir, { recursive: true });

  if (!skipBuild) {
    console.log('[build_sea] Building CLI bundle via pnpm run build');
    await run('pnpm', ['run', 'build'], { cwd: repoRoot });
  }

  console.log('[build_sea] Generating SEA preparation blob');
  await run(process.execPath, ['--experimental-sea-config', seaConfigPath], {
    cwd: repoRoot,
  });

  console.log('[build_sea] Preparing Node binary copy from', nodeBinarySource);
  await fs.copyFile(nodeBinarySource, binaryOutputPath);

  if (process.platform === 'darwin') {
    try {
      await run('codesign', ['--remove-signature', binaryOutputPath]);
    } catch (error) {
      console.warn('[build_sea] codesign removal failed:', error.message);
    }
  }

  const postject = await resolvePostject(repoRoot);
  const baseArgs = [
    binaryOutputPath,
    'NODE_SEA_BLOB',
    blobPath,
    '--sentinel-fuse',
    'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ];
  const injectArgs =
    process.platform === 'darwin' ? [...baseArgs, '--macho-segment-name', 'NODE_SEA'] : baseArgs;

  console.log('[build_sea] Injecting SEA blob into binary');
  await run(postject.command, [...postject.args, ...injectArgs], { cwd: repoRoot });

  if (process.platform !== 'win32') {
    await fs.chmod(binaryOutputPath, 0o755);
  }

  // Strip debug symbols before signing (strip modifies the binary and would invalidate signatures)
  if (process.platform === 'darwin') {
    try {
      console.log('[build_sea] Stripping debug symbols');
      await run('strip', ['-x', binaryOutputPath]);
      console.log('[build_sea] Binary stripped successfully');
    } catch (error) {
      console.warn('[build_sea] strip failed:', error.message);
    }
  }
  // NOTE: Do NOT strip on Linux. GNU strip corrupts the postject-injected
  // .note section containing the SEA blob, causing segfaults at runtime.

  // Sign the binary on macOS to prevent Gatekeeper from blocking it
  // This MUST happen after stripping since strip modifies the binary
  if (process.platform === 'darwin') {
    try {
      console.log('[build_sea] Signing binary with ad-hoc signature');
      await run('codesign', ['--sign', '-', '--force', binaryOutputPath]);
      console.log('[build_sea] Binary signed successfully');
    } catch (error) {
      console.warn('[build_sea] codesign failed:', error.message);
      console.warn('[build_sea] Binary may not run on macOS without manual signing');
    }
  }

  console.log(`[build_sea] SEA binary ready: ${binaryOutputPath}`);
}

const invokedPath = process.argv[1];
if (invokedPath && pathToFileURL(invokedPath).href === import.meta.url) {
  main().catch((error) => {
    console.error('[build_sea] error:', error);
    process.exit(1);
  });
}
