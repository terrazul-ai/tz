import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDir, '../../..');

const GH_STUB_BASE = `#!/usr/bin/env bash
set -euo pipefail
output_dir=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir)
      shift
      output_dir="$1"
      ;;
  esac
  if [[ $# -gt 0 ]]; then
    shift
  else
    break
  fi
done
if [[ -z "$output_dir" ]]; then
  echo "gh stub missing --dir" >&2
  exit 1
fi
`;

function runStageRelease(args: string[]) {
  return spawnSync('python3', ['scripts/stage_release.py', ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}

function createExecutable(tmpDir: string, name: string, content: string) {
  const scriptPath = path.join(tmpDir, name);
  fs.writeFileSync(scriptPath, content, { mode: 0o755 });
  return scriptPath;
}

describe('stage_release.py CLI usage', () => {
  it('requires --release-version to be provided', () => {
    const result = runStageRelease([]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('--release-version');
  });

  it('produces an ESM launcher and Node 20 engines metadata when staging', () => {
    const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-release-test-'));
    const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-release-gh-'));
    const ghStubPath = createExecutable(
      stubDir,
      'gh',
      `${GH_STUB_BASE}mkdir -p "$output_dir/stub-artifact"
`,
    );

    const env = {
      ...process.env,
      GH_CLI: ghStubPath,
    };

    const manifestPath = path.join(repoRoot, 'dist', 'manifest.json');
    let originalManifest: string | undefined;
    if (fs.existsSync(manifestPath)) {
      originalManifest = fs.readFileSync(manifestPath, 'utf8');
    } else {
      fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    }
    fs.writeFileSync(manifestPath, JSON.stringify({ schemaVersion: 1, targets: {} }), 'utf8');

    const result = spawnSync(
      'bash',
      [
        'scripts/stage_release.sh',
        '--release-version',
        '1.2.3',
        '--tmp',
        stagingRoot,
        '--run-id',
        '123',
        '--run-url',
        'https://example.com/run/123',
      ],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        env,
      },
    );

    expect(result.status).toBe(0);

    if (originalManifest) {
      fs.writeFileSync(manifestPath, originalManifest, 'utf8');
    } else {
      fs.rmSync(manifestPath, { force: true });
    }

    const packageJsonPath = path.join(stagingRoot, 'package', 'package.json');
    expect(fs.existsSync(packageJsonPath)).toBe(true);
    const stagedPackage = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    expect(stagedPackage.bin?.tz).toBe('bin/app.mjs');
    expect(stagedPackage.engines?.node).toBe('>=20.0.0');
    expect(stagedPackage.files).toContain('dist');

    expect(stagedPackage.dependencies).toEqual({});
    expect(stagedPackage.devDependencies).toBeUndefined();
    const rawJson = fs.readFileSync(packageJsonPath, 'utf8');
    expect(rawJson).not.toContain('workspace:');

    const launcherPath = path.join(stagingRoot, 'package', 'bin', 'app.mjs');
    expect(fs.existsSync(launcherPath)).toBe(true);
  });

  it('stages the manifest without bundling SEA binaries', () => {
    const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-release-artifacts-'));
    const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-release-stubs-'));

    const ghStubPath = createExecutable(
      stubDir,
      'gh',
      `${GH_STUB_BASE}mkdir -p "$output_dir/linux/dist/linux-x64"
printf 'stub-binary-contents' > "$output_dir/linux/dist/linux-x64/tz-linux-x64.zst"
printf 'tarball' > "$output_dir/linux/dist/linux-x64/tz-linux-x64.tar.gz"
printf 'zip' > "$output_dir/linux/dist/linux-x64/tz-linux-x64.zip"
`,
    );

    const env = {
      ...process.env,
      GH_CLI: ghStubPath,
      PATH: `${stubDir}:${process.env.PATH ?? ''}`,
    };

    const manifestPath = path.join(repoRoot, 'dist', 'manifest.json');
    let originalManifest: string | undefined;
    if (fs.existsSync(manifestPath)) {
      originalManifest = fs.readFileSync(manifestPath, 'utf8');
    } else {
      fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    }
    fs.writeFileSync(manifestPath, JSON.stringify({ schemaVersion: 1, targets: {} }), 'utf8');

    const result = spawnSync(
      'bash',
      [
        'scripts/stage_release.sh',
        '--release-version',
        '2.0.0',
        '--tmp',
        stagingRoot,
        '--run-id',
        'run-456',
        '--run-url',
        'https://example.com/run/456',
      ],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        env,
      },
    );

    expect(result.status).toBe(0);

    const distSeaDir = path.join(stagingRoot, 'package', 'dist', 'sea');
    expect(fs.existsSync(distSeaDir)).toBe(false);

    const manifestCopy = path.join(stagingRoot, 'package', 'dist', 'manifest.json');
    expect(fs.existsSync(manifestCopy)).toBe(true);

    const binContents = fs.readdirSync(path.join(stagingRoot, 'package', 'bin'));
    expect(binContents).toEqual(['app.mjs']);

    if (originalManifest) {
      fs.writeFileSync(manifestPath, originalManifest, 'utf8');
    } else {
      fs.rmSync(manifestPath, { force: true });
    }
  });

  it('includes the manifest but no SEA binaries in npm pack tarball output', () => {
    const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-release-pack-'));
    const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-release-pack-stubs-'));
    const ghStubPath = createExecutable(
      stubDir,
      'gh',
      `${GH_STUB_BASE}mkdir -p "$output_dir/linux/dist/linux-x64"
printf 'binary' > "$output_dir/linux/dist/linux-x64/tz-linux-x64"
cp "$output_dir/linux/dist/linux-x64/tz-linux-x64" "$output_dir/linux/dist/linux-x64/tz-linux-x64.zst"
cp "$output_dir/linux/dist/linux-x64/tz-linux-x64" "$output_dir/linux/dist/linux-x64/tz-linux-x64.tar.gz"
cp "$output_dir/linux/dist/linux-x64/tz-linux-x64" "$output_dir/linux/dist/linux-x64/tz-linux-x64.zip"
`,
    );

    const env = {
      ...process.env,
      GH_CLI: ghStubPath,
      PATH: `${stubDir}:${process.env.PATH ?? ''}`,
    };

    const manifestPath = path.join(repoRoot, 'dist', 'manifest.json');
    let originalManifest: string | undefined;
    if (fs.existsSync(manifestPath)) {
      originalManifest = fs.readFileSync(manifestPath, 'utf8');
    } else {
      fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    }
    fs.writeFileSync(manifestPath, JSON.stringify({ schemaVersion: 1, targets: {} }), 'utf8');

    const stageResult = spawnSync(
      'bash',
      [
        'scripts/stage_release.sh',
        '--release-version',
        '4.5.6',
        '--tmp',
        stagingRoot,
        '--run-id',
        'run-pack',
        '--run-url',
        'https://example.com/run/pack',
      ],
      { cwd: repoRoot, env, encoding: 'utf8' },
    );
    expect(stageResult.status).toBe(0);

    const packageDir = path.join(stagingRoot, 'package');
    const packDir = path.join(stagingRoot, 'pack');
    fs.mkdirSync(packDir, { recursive: true });
    const packResult = spawnSync('npm', ['pack', '--pack-destination', packDir], {
      cwd: packageDir,
      encoding: 'utf8',
    });
    expect(packResult.status).toBe(0);

    const tarball = fs
      .readdirSync(packDir)
      .filter((name) => name.endsWith('.tgz'))
      .map((name) => path.join(packDir, name))[0];
    expect(tarball).toBeTruthy();

    const tarList = spawnSync('tar', ['-tzf', tarball], { encoding: 'utf8' });
    expect(tarList.status).toBe(0);
    expect(tarList.stdout).toMatch(/package\/dist\/manifest\.json/);
    expect(tarList.stdout).not.toMatch(/package\/dist\/sea\//);

    if (originalManifest) {
      fs.writeFileSync(manifestPath, originalManifest, 'utf8');
    } else {
      fs.rmSync(manifestPath, { force: true });
    }
  });
});
