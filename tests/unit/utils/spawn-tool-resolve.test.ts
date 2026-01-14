import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveSpawnTool } from '../../../src/utils/spawn-tool-resolve.js';

import type { UserConfig } from '../../../src/types/config.js';

// Helper to create minimal UserConfig
function createUserConfig(tools?: Array<{ type: 'claude' | 'codex' }>): UserConfig {
  return {
    registry: 'https://api.terrazul.com',
    environment: 'production',
    environments: {
      production: { registry: 'https://api.terrazul.com' },
    },
    cache: { ttl: 3600, maxSize: 500 },
    telemetry: false,
    accessibility: { largeText: false, audioFeedback: false },
    profile: {
      tools: tools?.map((t) => ({
        type: t.type,
        command: t.type,
        ...(t.type === 'codex' ? { args: ['exec'] } : {}),
      })),
    },
    context: {},
  } as UserConfig;
}

// Helper to create agents.toml with tool field
async function createManifest(projectDir: string, tool?: 'claude' | 'codex'): Promise<void> {
  const toml = `
[package]
name = "@test/pkg"
version = "1.0.0"
${tool ? `tool = "${tool}"` : ''}
`;
  await fs.writeFile(path.join(projectDir, 'agents.toml'), toml.trim());
}

describe('spawn-tool-resolve', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tz-spawn-resolve-test-'));
  });

  afterEach(async () => {
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      void 0;
    }
  });

  describe('resolveSpawnTool', () => {
    describe('precedence: flag > project > user', () => {
      it('uses flag override when provided (highest precedence)', async () => {
        // User config has claude as primary
        const userConfig = createUserConfig([{ type: 'claude' }]);
        // Project manifest has codex
        await createManifest(tmpDir, 'codex');

        // Flag override to claude should win
        const result = await resolveSpawnTool({
          flagOverride: 'claude',
          projectRoot: tmpDir,
          userConfig,
        });

        expect(result.type).toBe('claude');
      });

      it('uses project manifest tool when no flag provided', async () => {
        // User config has claude as primary
        const userConfig = createUserConfig([{ type: 'claude' }]);
        // Project manifest has codex
        await createManifest(tmpDir, 'codex');

        const result = await resolveSpawnTool({
          projectRoot: tmpDir,
          userConfig,
        });

        expect(result.type).toBe('codex');
      });

      it('uses user config when no flag and no project tool', async () => {
        // User config has codex as primary
        const userConfig = createUserConfig([{ type: 'codex' }, { type: 'claude' }]);
        // Project manifest has no tool specified
        await createManifest(tmpDir);

        const result = await resolveSpawnTool({
          projectRoot: tmpDir,
          userConfig,
        });

        expect(result.type).toBe('codex');
      });

      it('flag overrides both project and user settings', async () => {
        // User config has codex first
        const userConfig = createUserConfig([{ type: 'codex' }]);
        // Project manifest has codex
        await createManifest(tmpDir, 'codex');

        // Flag override to claude should win over both
        const result = await resolveSpawnTool({
          flagOverride: 'claude',
          projectRoot: tmpDir,
          userConfig,
        });

        expect(result.type).toBe('claude');
      });
    });

    describe('tool spec normalization', () => {
      it('returns normalized ToolSpec with command', async () => {
        const userConfig = createUserConfig([{ type: 'claude' }]);
        await createManifest(tmpDir);

        const result = await resolveSpawnTool({
          projectRoot: tmpDir,
          userConfig,
        });

        expect(result.type).toBe('claude');
        expect(result.command).toBe('claude');
      });

      it('includes args for codex tool', async () => {
        const userConfig = createUserConfig([{ type: 'codex' }]);
        await createManifest(tmpDir);

        const result = await resolveSpawnTool({
          projectRoot: tmpDir,
          userConfig,
        });

        expect(result.type).toBe('codex');
        expect(result.args).toEqual(['exec']);
      });

      it('preserves model from user config', async () => {
        const userConfig = createUserConfig([{ type: 'claude' }]);
        userConfig.profile.tools![0].model = 'opus';
        await createManifest(tmpDir);

        const result = await resolveSpawnTool({
          projectRoot: tmpDir,
          userConfig,
        });

        expect(result.model).toBe('opus');
      });
    });

    describe('edge cases', () => {
      it('handles missing manifest file', async () => {
        // No agents.toml created
        const userConfig = createUserConfig([{ type: 'claude' }]);

        const result = await resolveSpawnTool({
          projectRoot: tmpDir,
          userConfig,
        });

        // Falls back to user config
        expect(result.type).toBe('claude');
      });

      it('handles manifest without package section', async () => {
        const toml = `
[dependencies]
"@test/dep" = "^1.0.0"
`;
        await fs.writeFile(path.join(tmpDir, 'agents.toml'), toml.trim());
        const userConfig = createUserConfig([{ type: 'codex' }]);

        const result = await resolveSpawnTool({
          projectRoot: tmpDir,
          userConfig,
        });

        // Falls back to user config
        expect(result.type).toBe('codex');
      });

      it('handles invalid tool value in manifest (falls back to user config)', async () => {
        const toml = `
[package]
name = "@test/pkg"
version = "1.0.0"
tool = "invalid"
`;
        await fs.writeFile(path.join(tmpDir, 'agents.toml'), toml.trim());
        const userConfig = createUserConfig([{ type: 'claude' }]);

        const result = await resolveSpawnTool({
          projectRoot: tmpDir,
          userConfig,
        });

        // Falls back to user config since invalid tool is ignored
        expect(result.type).toBe('claude');
      });

      it('falls back to default tools when profile is empty', async () => {
        // User config with no tools specified - should use defaults
        const userConfig = createUserConfig([]);
        await createManifest(tmpDir);

        const result = await resolveSpawnTool({
          projectRoot: tmpDir,
          userConfig,
        });

        // Falls back to default tools (Claude is first in DEFAULT_PROFILE_TOOLS)
        expect(result.type).toBe('claude');
      });
    });
  });
});
