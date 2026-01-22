import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as TOML from '@iarna/toml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  analyzeExtractSources,
  executeExtract,
  performExtract,
} from '../../../src/core/extract/orchestrator';
import { createLogger } from '../../../src/utils/logger';

interface TempPaths {
  project: string;
  out: string;
  codexConfig: string;
  projectMcp: string;
}

async function mkdtemp(prefix: string): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function setupProject(): Promise<TempPaths> {
  const project = await mkdtemp('tz-plan-proj-');
  const out = await mkdtemp('tz-plan-out-');
  await fs.writeFile(path.join(project, 'AGENTS.md'), `Docs at ${project}/docs`, 'utf8');
  await fs.mkdir(path.join(project, '.claude'), { recursive: true });
  await fs.writeFile(path.join(project, '.claude', 'CLAUDE.md'), `See ${project}/notes`, 'utf8');
  await fs.writeFile(
    path.join(project, '.claude', 'settings.json'),
    JSON.stringify(
      {
        env: { ANTHROPIC_API_KEY: 'secret' },
        permissions: { additionalDirectories: [path.join(project, 'assets')] },
      },
      null,
      2,
    ),
    'utf8',
  );
  await fs.writeFile(
    path.join(project, '.claude', 'mcp_servers.json'),
    JSON.stringify(
      {
        coder: {
          command: path.join(project, 'bin', 'coder'),
          args: ['--workspace', path.join(project, 'workspace')],
          transport: { type: 'stdio' },
          metadata: { keep: 'yes' },
        },
      },
      null,
      2,
    ),
    'utf8',
  );
  await fs.mkdir(path.join(project, '.claude', 'agents'), { recursive: true });
  await fs.writeFile(
    path.join(project, '.claude', 'agents', 'writer.md'),
    `Workspace: ${project}/workspace`,
    'utf8',
  );
  await fs.mkdir(path.join(project, '.cursor', 'rules'), { recursive: true });
  await fs.writeFile(path.join(project, '.cursor', 'rules', 'main.md'), 'rule A', 'utf8');
  await fs.mkdir(path.join(project, '.github'), { recursive: true });
  await fs.writeFile(
    path.join(project, '.github', 'copilot-instructions.md'),
    'help others',
    'utf8',
  );

  const codexConfig = path.join(project, 'codex-config.toml');
  await fs.writeFile(
    codexConfig,
    `
model = "gpt-5-codex"
model_reasoning_effort = "high"
[projects."${project}"]
trust_level = "trusted"
[mcp_servers.embeddings]
command = "${path.join(project, 'bin', 'embeddings')}"
args = ["--model", "${path.join(project, 'models', 'tiny')}"
]
`,
    'utf8',
  );

  const projectMcp = path.join(project, 'project.mcp.json');
  await fs.writeFile(
    projectMcp,
    JSON.stringify(
      {
        mcpServers: {
          search: {
            command: './scripts/search.sh',
            args: ['--index', path.join(project, 'index')],
            env: { SEARCH_KEY: 'abc123' },
          },
        },
      },
      null,
      2,
    ),
    'utf8',
  );

  return { project, out, codexConfig, projectMcp };
}

let paths: TempPaths;

beforeEach(async () => {
  paths = await setupProject();
});

afterEach(async () => {
  const all = [paths.project, paths.out];
  for (const dir of all) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

describe('analyzeExtractSources', () => {
  it('returns sanitized plan and aggregated MCP servers', async () => {
    const plan = await analyzeExtractSources({
      from: paths.project,
      out: paths.out,
      name: '@you/pkg',
      version: '1.0.0',
      includeCodexConfig: true,
      codexConfigPath: paths.codexConfig,
      projectMcpConfigPath: paths.projectMcp,
    });

    expect(plan.projectRoot).toBe(paths.project);
    expect(Object.keys(plan.detected)).toEqual(
      expect.arrayContaining([
        'codex.Agents',
        'claude.Readme',
        'claude.settings',
        'claude.mcp_servers',
        'codex.mcp_servers',
      ]),
    );
    expect(plan.manifest.claude?.template).toBe('templates/CLAUDE.md.hbs');
    expect(plan.outputs.some((o) => o.relativePath === 'README.md')).toBe(true);
    const claudeSettings = plan.outputs.find(
      (o) => o.artifactId === 'claude.settings' && o.relativePath.endsWith('settings.json.hbs'),
    );
    expect(claudeSettings).toBeTruthy();
    if (claudeSettings && claudeSettings.format === 'json') {
      const data = claudeSettings.data as Record<string, unknown>;
      expect(JSON.stringify(data)).not.toContain(paths.project);
    }
    expect(plan.mcpServers.map((s) => s.id)).toEqual(
      expect.arrayContaining(['claude:coder', 'codex:embeddings', 'project:search']),
    );
    expect(plan.codexConfigBase).not.toBeNull();
    expect(plan.codexConfigBase?.model).toBe('gpt-5-codex');
    const projectKeys = Object.keys(plan.codexConfigBase?.projects ?? {});
    expect(projectKeys.every((key) => !key.includes(paths.project))).toBe(true);
  });
});

describe('executeExtract', () => {
  it('writes selected artifacts and filters MCP servers', async () => {
    const plan = await analyzeExtractSources({
      from: paths.project,
      out: paths.out,
      name: '@you/pkg',
      version: '1.0.0',
      includeCodexConfig: true,
      codexConfigPath: paths.codexConfig,
      projectMcpConfigPath: paths.projectMcp,
    });

    const includedArtifacts = Object.keys(plan.detected);
    const includedMcpServers = plan.mcpServers.map((s) => s.id);
    const logger = createLogger();

    const result = await executeExtract(
      plan,
      {
        from: paths.project,
        out: paths.out,
        name: '@you/pkg',
        version: '1.0.0',
        includedArtifacts,
        includedMcpServers,
      },
      logger,
    );

    const manifest = await fs.readFile(path.join(paths.out, 'agents.toml'), 'utf8');
    expect(manifest).toMatch(/name = "@you\/pkg"/);
    const manifestDoc = TOML.parse(manifest) as Record<string, unknown>;
    const exportsSection = (manifestDoc.exports as Record<string, unknown>) ?? {};
    const codexSection = (exportsSection.codex as Record<string, unknown>) ?? {};
    expect(codexSection.template).toBe('templates/AGENTS.md.hbs');
    expect(codexSection.mcpServers).toBe('templates/codex/agents.toml.hbs');
    expect(codexSection.config).toBe('templates/codex/config.toml');
    const mcpRaw = JSON.parse(
      await fs.readFile(
        path.join(paths.out, 'templates', 'claude', 'mcp_servers.json.hbs'),
        'utf8',
      ),
    ) as unknown;
    const mcpJson = mcpRaw && typeof mcpRaw === 'object' ? (mcpRaw as Record<string, unknown>) : {};
    expect(Object.keys(mcpJson)).toEqual(['coder', 'embeddings', 'search']);
    expect(JSON.stringify(mcpJson)).not.toContain(paths.project);
    const coder =
      mcpJson.coder && typeof mcpJson.coder === 'object'
        ? (mcpJson.coder as Record<string, unknown>)
        : {};
    expect(coder.transport).toEqual({ type: 'stdio' });
    expect(coder.metadata).toEqual({ keep: 'yes' });
    expect(result.summary.outputs).toEqual(
      expect.arrayContaining([
        'templates/claude/mcp_servers.json.hbs',
        'templates/codex/agents.toml.hbs',
        'templates/codex/config.toml',
      ]),
    );

    const codexToml = await fs.readFile(
      path.join(paths.out, 'templates', 'codex', 'agents.toml.hbs'),
      'utf8',
    );
    const codexConfig = TOML.parse(codexToml ?? '') as Record<string, unknown>;
    expect(codexConfig).toHaveProperty('mcp_servers');
    const codexServers = codexConfig.mcp_servers as Record<string, unknown>;
    expect(Object.keys(codexServers)).toEqual(['embeddings']);
    const embeddings =
      codexServers.embeddings && typeof codexServers.embeddings === 'object'
        ? (codexServers.embeddings as Record<string, unknown>)
        : {};
    expect(JSON.stringify(embeddings)).not.toContain(paths.project);

    const codexFullConfig = await fs.readFile(
      path.join(paths.out, 'templates', 'codex', 'config.toml'),
      'utf8',
    );
    const codexFullDoc = TOML.parse(codexFullConfig ?? '') as Record<string, unknown>;
    expect(codexFullDoc.model).toBe('gpt-5-codex');
    const codexFullServers = (codexFullDoc.mcp_servers as Record<string, unknown>) ?? {};
    expect(Object.keys(codexFullServers)).toEqual(['embeddings']);

    // Legacy performExtract should still succeed and produce same manifest when everything included
    const legacy = await performExtract(
      {
        from: paths.project,
        out: paths.out,
        name: '@you/pkg',
        version: '1.0.0',
        force: true,
        includeCodexConfig: true,
        codexConfigPath: paths.codexConfig,
        projectMcpConfigPath: paths.projectMcp,
      },
      logger,
    );
    expect(legacy.summary.manifest).toEqual(result.summary.manifest);
  });
  it('filters MCP servers when subset selected', async () => {
    const plan = await analyzeExtractSources({
      from: paths.project,
      out: paths.out,
      name: '@you/pkg',
      version: '1.0.0',
      includeCodexConfig: true,
      codexConfigPath: paths.codexConfig,
      projectMcpConfigPath: paths.projectMcp,
    });

    const includedArtifacts = Object.keys(plan.detected);
    const includedMcpServers = ['claude:coder', 'project:search'];
    const logger = createLogger();

    await executeExtract(
      plan,
      {
        from: paths.project,
        out: paths.out,
        name: '@you/pkg',
        version: '1.0.0',
        includedArtifacts,
        includedMcpServers,
        force: true,
      },
      logger,
    );

    const mcpRaw = JSON.parse(
      await fs.readFile(
        path.join(paths.out, 'templates', 'claude', 'mcp_servers.json.hbs'),
        'utf8',
      ),
    ) as unknown;
    const mcpJson = mcpRaw && typeof mcpRaw === 'object' ? (mcpRaw as Record<string, unknown>) : {};
    expect(Object.keys(mcpJson)).toEqual(['coder', 'search']);
    const coder =
      mcpJson.coder && typeof mcpJson.coder === 'object'
        ? (mcpJson.coder as Record<string, unknown>)
        : {};
    expect(coder.transport).toEqual({ type: 'stdio' });
    expect(coder.metadata).toEqual({ keep: 'yes' });

    await expect(
      fs.stat(path.join(paths.out, 'templates', 'codex', 'agents.toml.hbs')),
    ).rejects.toThrow(/ENOENT/);

    const codexFullConfig = await fs.readFile(
      path.join(paths.out, 'templates', 'codex', 'config.toml'),
      'utf8',
    );
    const codexFullDoc = TOML.parse(codexFullConfig ?? '') as Record<string, unknown>;
    const codexFullServers = (codexFullDoc.mcp_servers as Record<string, unknown>) ?? {};
    expect(Object.keys(codexFullServers)).toEqual([]);
  });

  it('writes Codex MCP template even when config include is disabled', async () => {
    const plan = await analyzeExtractSources({
      from: paths.project,
      out: paths.out,
      name: '@you/pkg',
      version: '1.0.0',
      includeCodexConfig: false,
      codexConfigPath: paths.codexConfig,
      projectMcpConfigPath: paths.projectMcp,
    });

    const includedArtifacts = Object.keys(plan.detected);
    const includedMcpServers = plan.mcpServers
      .filter((server) => server.source === 'codex')
      .map((server) => server.id);
    const logger = createLogger();

    await executeExtract(
      plan,
      {
        from: paths.project,
        out: paths.out,
        name: '@you/pkg',
        version: '1.0.0',
        includedArtifacts,
        includedMcpServers,
        force: true,
      },
      logger,
    );

    const codexToml = await fs.readFile(
      path.join(paths.out, 'templates', 'codex', 'agents.toml.hbs'),
      'utf8',
    );
    const codexConfig = TOML.parse(codexToml ?? '') as Record<string, unknown>;
    const codexServers = codexConfig.mcp_servers as Record<string, unknown>;
    expect(Object.keys(codexServers)).toEqual(['embeddings']);
  });

  it('still surfaces Codex MCP servers when includeCodexConfig is false', async () => {
    const plan = await analyzeExtractSources({
      from: paths.project,
      out: paths.out,
      name: '@you/pkg',
      version: '1.0.0',
      includeCodexConfig: false,
      codexConfigPath: paths.codexConfig,
      projectMcpConfigPath: paths.projectMcp,
    });

    expect(plan.mcpServers.map((server) => server.id)).toContain('codex:embeddings');
    expect(plan.codexConfigBase).not.toBeNull();
    expect(plan.skipped).toContain('codex.mcp_servers (enable include Codex config to bundle)');
  });
});

describe('Gemini extraction', () => {
  let geminiPaths: TempPaths;

  beforeEach(async () => {
    const project = await mkdtemp('tz-gemini-proj-');
    const out = await mkdtemp('tz-gemini-out-');

    // Create .gemini directory structure
    await fs.mkdir(path.join(project, '.gemini'), { recursive: true });
    await fs.mkdir(path.join(project, '.gemini', 'commands'), { recursive: true });
    await fs.mkdir(path.join(project, '.gemini', 'skills'), { recursive: true });

    // Create GEMINI.md
    await fs.writeFile(path.join(project, '.gemini', 'GEMINI.md'), '# Gemini Context', 'utf8');

    // Create settings.json with MCP servers
    await fs.writeFile(
      path.join(project, '.gemini', 'settings.json'),
      JSON.stringify({
        mcpServers: {
          geminiServer: {
            command: 'node',
            args: ['server.js'],
          },
        },
      }),
      'utf8',
    );

    // Create command files
    await fs.writeFile(
      path.join(project, '.gemini', 'commands', 'deploy.md'),
      '# Deploy Command',
      'utf8',
    );
    await fs.writeFile(
      path.join(project, '.gemini', 'commands', 'test.md'),
      '# Test Command',
      'utf8',
    );

    // Create skill files
    await fs.writeFile(
      path.join(project, '.gemini', 'skills', 'coding.md'),
      '# Coding Skill',
      'utf8',
    );

    geminiPaths = {
      project,
      out,
      codexConfig: '',
      projectMcp: '',
    };
  });

  afterEach(async () => {
    await fs.rm(geminiPaths.project, { recursive: true, force: true }).catch(() => {});
    await fs.rm(geminiPaths.out, { recursive: true, force: true }).catch(() => {});
  });

  it('detects Gemini commands directory', async () => {
    const plan = await analyzeExtractSources({
      from: geminiPaths.project,
      out: geminiPaths.out,
      name: '@test/gemini-pkg',
      version: '1.0.0',
    });

    expect(plan.detected['gemini.commands']).toBeDefined();
    expect(Array.isArray(plan.detected['gemini.commands'])).toBe(true);
    const commandFiles = plan.detected['gemini.commands'] as string[];
    expect(commandFiles).toHaveLength(2);
    expect(commandFiles.some((f) => f.endsWith('deploy.md'))).toBe(true);
    expect(commandFiles.some((f) => f.endsWith('test.md'))).toBe(true);
  });

  it('detects Gemini skills directory', async () => {
    const plan = await analyzeExtractSources({
      from: geminiPaths.project,
      out: geminiPaths.out,
      name: '@test/gemini-pkg',
      version: '1.0.0',
    });

    expect(plan.detected['gemini.skills']).toBeDefined();
    expect(Array.isArray(plan.detected['gemini.skills'])).toBe(true);
    const skillFiles = plan.detected['gemini.skills'] as string[];
    expect(skillFiles).toHaveLength(1);
    expect(skillFiles[0]).toContain('coding.md');
  });

  it('generates outputs for Gemini commands with correct paths', async () => {
    const plan = await analyzeExtractSources({
      from: geminiPaths.project,
      out: geminiPaths.out,
      name: '@test/gemini-pkg',
      version: '1.0.0',
    });

    const commandOutputs = plan.outputs.filter((o) => o.artifactId === 'gemini.commands');
    expect(commandOutputs).toHaveLength(2);

    const paths = commandOutputs.map((o) => o.relativePath).sort();
    expect(paths).toEqual([
      'templates/gemini/commands/deploy.md.hbs',
      'templates/gemini/commands/test.md.hbs',
    ]);
  });

  it('generates outputs for Gemini skills with correct paths', async () => {
    const plan = await analyzeExtractSources({
      from: geminiPaths.project,
      out: geminiPaths.out,
      name: '@test/gemini-pkg',
      version: '1.0.0',
    });

    const skillOutputs = plan.outputs.filter((o) => o.artifactId === 'gemini.skills');
    expect(skillOutputs).toHaveLength(1);
    expect(skillOutputs[0].relativePath).toBe('templates/gemini/skills/coding.md.hbs');
  });

  it('adds manifest patch for Gemini commands directory', async () => {
    const plan = await analyzeExtractSources({
      from: geminiPaths.project,
      out: geminiPaths.out,
      name: '@test/gemini-pkg',
      version: '1.0.0',
    });

    expect(plan.manifest.gemini?.commandsDir).toBe('templates/gemini/commands');
  });

  it('adds manifest patch for Gemini skills directory', async () => {
    const plan = await analyzeExtractSources({
      from: geminiPaths.project,
      out: geminiPaths.out,
      name: '@test/gemini-pkg',
      version: '1.0.0',
    });

    expect(plan.manifest.gemini?.skillsDir).toBe('templates/gemini/skills');
  });

  it('extracts MCP servers from Gemini settings using parseGeminiSettings', async () => {
    const plan = await analyzeExtractSources({
      from: geminiPaths.project,
      out: geminiPaths.out,
      name: '@test/gemini-pkg',
      version: '1.0.0',
    });

    expect(plan.mcpServers.some((s) => s.id === 'gemini:geminiServer')).toBe(true);
    const geminiServer = plan.mcpServers.find((s) => s.id === 'gemini:geminiServer');
    expect(geminiServer?.definition.command).toBe('node');
  });

  it('handles nested directories in commands', async () => {
    // Create nested structure
    await fs.mkdir(path.join(geminiPaths.project, '.gemini', 'commands', 'docker'), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(geminiPaths.project, '.gemini', 'commands', 'docker', 'build.md'),
      '# Docker Build',
      'utf8',
    );

    const plan = await analyzeExtractSources({
      from: geminiPaths.project,
      out: geminiPaths.out,
      name: '@test/gemini-pkg',
      version: '1.0.0',
    });

    const commandOutputs = plan.outputs.filter((o) => o.artifactId === 'gemini.commands');
    const nestedOutput = commandOutputs.find((o) => o.relativePath.includes('docker/build'));
    expect(nestedOutput).toBeDefined();
    expect(nestedOutput?.relativePath).toBe('templates/gemini/commands/docker/build.md.hbs');
  });

  it('skips symlinked commands directory', async () => {
    // Remove existing commands dir and create symlink
    await fs.rm(path.join(geminiPaths.project, '.gemini', 'commands'), {
      recursive: true,
      force: true,
    });
    const targetDir = await mkdtemp('tz-symlink-target-');
    await fs.writeFile(path.join(targetDir, 'external.md'), '# External', 'utf8');
    await fs.symlink(targetDir, path.join(geminiPaths.project, '.gemini', 'commands'));

    const plan = await analyzeExtractSources({
      from: geminiPaths.project,
      out: geminiPaths.out,
      name: '@test/gemini-pkg',
      version: '1.0.0',
    });

    expect(plan.detected['gemini.commands']).toBeUndefined();
    expect(plan.skipped).toContain('gemini.commands (symlink dir ignored)');

    // Cleanup
    await fs.rm(targetDir, { recursive: true, force: true }).catch(() => {});
  });

  it('handles empty commands directory', async () => {
    // Clear all files from commands directory
    const commandsDir = path.join(geminiPaths.project, '.gemini', 'commands');
    const files = await fs.readdir(commandsDir);
    for (const file of files) {
      await fs.rm(path.join(commandsDir, file));
    }

    const plan = await analyzeExtractSources({
      from: geminiPaths.project,
      out: geminiPaths.out,
      name: '@test/gemini-pkg',
      version: '1.0.0',
    });

    // Empty directory should not be detected
    expect(plan.detected['gemini.commands']).toBeUndefined();
  });

  it('writes Gemini command and skill files on execute', async () => {
    const plan = await analyzeExtractSources({
      from: geminiPaths.project,
      out: geminiPaths.out,
      name: '@test/gemini-pkg',
      version: '1.0.0',
    });

    const logger = createLogger();
    await executeExtract(
      plan,
      {
        from: geminiPaths.project,
        out: geminiPaths.out,
        name: '@test/gemini-pkg',
        version: '1.0.0',
        includedArtifacts: Object.keys(plan.detected),
        includedMcpServers: plan.mcpServers.map((s) => s.id),
      },
      logger,
    );

    // Check command files are written
    const deployContent = await fs.readFile(
      path.join(geminiPaths.out, 'templates', 'gemini', 'commands', 'deploy.md.hbs'),
      'utf8',
    );
    expect(deployContent).toBe('# Deploy Command');

    // Check skill files are written
    const codingContent = await fs.readFile(
      path.join(geminiPaths.out, 'templates', 'gemini', 'skills', 'coding.md.hbs'),
      'utf8',
    );
    expect(codingContent).toBe('# Coding Skill');

    // Check manifest has correct entries
    const manifest = await fs.readFile(path.join(geminiPaths.out, 'agents.toml'), 'utf8');
    const manifestDoc = TOML.parse(manifest) as Record<string, unknown>;
    const exportsSection = (manifestDoc.exports as Record<string, unknown>) ?? {};
    const geminiSection = (exportsSection.gemini as Record<string, unknown>) ?? {};
    expect(geminiSection.commandsDir).toBe('templates/gemini/commands');
    expect(geminiSection.skillsDir).toBe('templates/gemini/skills');
  });
});
