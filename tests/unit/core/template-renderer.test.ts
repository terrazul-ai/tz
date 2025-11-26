import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { planAndRender } from '../../../src/core/template-renderer';

async function mkdtemp(prefix: string): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
}

async function write(file: string, data: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, data, 'utf8');
}

describe('core/template-renderer', () => {
  let projectRoot = '';
  let agentModules = '';
  let pkgRoot = '';
  let originalHome: string | undefined;
  let originalUserProfile: string | undefined;
  let fakeHomeDir = '';

  beforeAll(async () => {
    originalHome = process.env.HOME;
    originalUserProfile = process.env.USERPROFILE;
    fakeHomeDir = await mkdtemp('tz-tr-home');
    process.env.HOME = fakeHomeDir;
    process.env.USERPROFILE = fakeHomeDir;

    projectRoot = await mkdtemp('tz-tr-proj');
    agentModules = path.join(projectRoot, 'agent_modules');
    await fs.mkdir(agentModules, { recursive: true });
    // minimal agents.toml in project to provide project name/version context
    await write(
      path.join(projectRoot, 'agents.toml'),
      `\n[package]\nname = "@test/project"\nversion = "0.1.0"\n`,
    );

    // Create store structure with templates
    const storeRoot = path.join(fakeHomeDir, '.terrazul', 'store');
    const pkgStoreRoot = path.join(storeRoot, '@test', 'demo', '1.2.3');
    await write(
      path.join(pkgStoreRoot, 'agents.toml'),
      `\n[package]\nname = "@test/demo"\nversion = "1.2.3"\n\n[exports.codex]\ntemplate = "templates/AGENTS.md.hbs"\n\n[exports.claude]\ntemplate = "templates/CLAUDE.md.hbs"\nsettingsLocal = "templates/claude/settings.local.json.hbs"\nsubagentsDir = "templates/claude/agents"\n\n[exports.copilot]\ntemplate = "templates/COPILOT.md.hbs"\n\n[exports.cursor]\ntemplate = "templates/cursor.rules.mdc.hbs"\n`,
    );
    await write(
      path.join(pkgStoreRoot, 'templates', 'AGENTS.md.hbs'),
      '# Codex for {{project.name}}',
    );
    await write(path.join(pkgStoreRoot, 'templates', 'CLAUDE.md.hbs'), '# Claude {{pkg.name}}');
    await write(
      path.join(pkgStoreRoot, 'templates', 'claude', 'settings.local.json.hbs'),
      '{ "pkg": "{{pkg.name}}", "when": "{{now}}" }',
    );
    await write(
      path.join(pkgStoreRoot, 'templates', 'claude', 'agents', 'reviewer.md.hbs'),
      'agent for {{project.version}}',
    );
    await write(path.join(pkgStoreRoot, 'templates', 'COPILOT.md.hbs'), 'copilot: {{pkg.version}}');
    await write(path.join(pkgStoreRoot, 'templates', 'cursor.rules.mdc.hbs'), 'rule: {{env.USER}}');

    // Create empty directory in agent_modules (will contain rendered files when isolated=true)
    pkgRoot = path.join(agentModules, '@test', 'demo');
    await fs.mkdir(pkgRoot, { recursive: true });

    // Create lockfile
    const lockfile = `
version = 1

[packages."@test/demo"]
version = "1.2.3"
resolved = "http://localhost/demo"
integrity = "sha256-test"
dependencies = { }

[metadata]
generated_at = "2025-01-01T00:00:00.000Z"
cli_version = "0.1.0"
`;
    const lockfilePath = path.join(projectRoot, 'agents-lock.toml');
    await write(lockfilePath, lockfile.trim());

    // Ensure lockfile is fully written to disk (prevents CI race conditions)
    const fd = await fs.open(lockfilePath, 'r');
    await fd.sync();
    await fd.close();

    // Verify test setup completed successfully
    const requiredPaths = [
      pkgStoreRoot,
      path.join(pkgStoreRoot, 'agents.toml'),
      path.join(pkgStoreRoot, 'templates', 'AGENTS.md.hbs'),
      path.join(pkgStoreRoot, 'templates', 'CLAUDE.md.hbs'),
      lockfilePath,
      path.join(agentModules, '@test', 'demo'),
    ];
    for (const p of requiredPaths) {
      const exists = await fs.stat(p).catch(() => null);
      if (!exists) {
        throw new Error(`Test setup failed: required path does not exist: ${p}`);
      }
    }
  });

  afterAll(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
    if (fakeHomeDir) {
      await fs.rm(fakeHomeDir, { recursive: true, force: true }).catch(() => {});
    }
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
  });

  it('renders templates to expected destinations', async () => {
    const storeRoot = path.join(fakeHomeDir, '.terrazul', 'store');
    const res = await planAndRender(projectRoot, agentModules, {
      packageName: '@test/demo',
      noCache: true,
      storeDir: storeRoot,
    });
    // With isolated rendering (now default), all files render to agent_modules/@test/demo/
    const packageRoot = path.join(agentModules, '@test', 'demo');
    const expected = [
      path.join(packageRoot, 'CLAUDE.md'),
      path.join(packageRoot, 'AGENTS.md'),
      path.join(packageRoot, 'claude', 'settings.local.json'),
      path.join(packageRoot, 'claude', 'agents', 'reviewer.md'),
      path.join(packageRoot, 'cursor.rules.mdc'),
      path.join(packageRoot, 'COPILOT.md'), // Template is COPILOT.md.hbs, so output is COPILOT.md
    ];
    for (const f of expected) {
      const st = await fs.stat(f).catch(() => null);
      if (!st || !st.isFile()) {
        // Enhanced error reporting for CI debugging
        const diagnostics = [
          `\nFile does not exist: ${f}`,
          `Written files (${res.written.length}): ${res.written.join(', ')}`,
          `Skipped files (${res.skipped.length}): ${res.skipped.map((s) => `${s.dest} (${s.code})`).join(', ')}`,
        ];
        throw new Error(diagnostics.join('\n'));
      }
      expect(st && st.isFile()).toBe(true);
    }
    expect(res.written.length).toBeGreaterThanOrEqual(5);
  });

  it('skips existing files unless forced', async () => {
    const storeRoot = path.join(fakeHomeDir, '.terrazul', 'store');
    const before = await planAndRender(projectRoot, agentModules, {
      packageName: '@test/demo',
      force: false,
      storeDir: storeRoot,
    });
    expect(before.skipped.length).toBeGreaterThan(0);
    expect(before.backedUp.length).toBe(0);
    const after = await planAndRender(projectRoot, agentModules, {
      packageName: '@test/demo',
      force: true,
      storeDir: storeRoot,
    });
    expect(after.written.length).toBeGreaterThan(0);
    expect(after.backedUp.length).toBeGreaterThan(0);
  });

  it('copies literal files without rendering template syntax', async () => {
    // Create a package with a literal (non-.hbs) file containing template syntax
    const storeRoot = path.join(fakeHomeDir, '.terrazul', 'store');
    const literalPkgRoot = path.join(storeRoot, '@test', 'literal', '1.0.0');

    await write(
      path.join(literalPkgRoot, 'agents.toml'),
      `\n[package]\nname = "@test/literal"\nversion = "1.0.0"\n\n[exports.claude]\ntemplate = "templates/EXAMPLES.md"\n`,
    );

    const exampleContent = `# Template Examples

Use {{ askUser('prompt') }} to ask questions.
Use {{ askAgent('task') }} to delegate to AI.
Access variables with {{ project.name }} and {{ pkg.version }}.`;

    await write(path.join(literalPkgRoot, 'templates', 'EXAMPLES.md'), exampleContent);

    // Create lockfile entry for literal package
    const lockfileContent = await fs.readFile(path.join(projectRoot, 'agents-lock.toml'), 'utf8');
    const updatedLockfile =
      lockfileContent +
      `\n[packages."@test/literal"]\nversion = "1.0.0"\nresolved = "http://localhost/literal"\nintegrity = "sha256-test"\ndependencies = { }\n`;
    await fs.writeFile(path.join(projectRoot, 'agents-lock.toml'), updatedLockfile, 'utf8');

    // Create package directory in agent_modules
    const literalOutputDir = path.join(agentModules, '@test', 'literal');
    await fs.mkdir(literalOutputDir, { recursive: true });

    // Render the literal file
    await planAndRender(projectRoot, agentModules, {
      packageName: '@test/literal',
      noCache: true,
      storeDir: storeRoot,
    });

    // Verify the file was copied literally without rendering
    const outputPath = path.join(literalOutputDir, 'EXAMPLES.md');
    const outputContent = await fs.readFile(outputPath, 'utf8');
    expect(outputContent).toBe(exampleContent);
    expect(outputContent).toContain('{{ askUser(');
    expect(outputContent).toContain('{{ askAgent(');
    expect(outputContent).toContain('{{ project.name }}');
  });

  it('renders .hbs files as templates', async () => {
    // Create a package with a .hbs file
    const storeRoot = path.join(fakeHomeDir, '.terrazul', 'store');
    const hbsPkgRoot = path.join(storeRoot, '@test', 'hbs', '1.0.0');

    await write(
      path.join(hbsPkgRoot, 'agents.toml'),
      `\n[package]\nname = "@test/hbs"\nversion = "1.0.0"\n\n[exports.claude]\ntemplate = "templates/README.md.hbs"\n`,
    );

    const templateContent = `# {{project.name}}

Version: {{pkg.version}}`;

    await write(path.join(hbsPkgRoot, 'templates', 'README.md.hbs'), templateContent);

    // Create lockfile entry
    const lockfileContent = await fs.readFile(path.join(projectRoot, 'agents-lock.toml'), 'utf8');
    const updatedLockfile =
      lockfileContent +
      `\n[packages."@test/hbs"]\nversion = "1.0.0"\nresolved = "http://localhost/hbs"\nintegrity = "sha256-test"\ndependencies = { }\n`;
    await fs.writeFile(path.join(projectRoot, 'agents-lock.toml'), updatedLockfile, 'utf8');

    // Create package directory
    const hbsOutputDir = path.join(agentModules, '@test', 'hbs');
    await fs.mkdir(hbsOutputDir, { recursive: true });

    // Render the template
    await planAndRender(projectRoot, agentModules, {
      packageName: '@test/hbs',
      noCache: true,
      storeDir: storeRoot,
    });

    // Verify the template was rendered
    const outputPath = path.join(hbsOutputDir, 'README.md');
    const outputContent = await fs.readFile(outputPath, 'utf8');
    expect(outputContent).toContain('# @test/project'); // project.name rendered
    expect(outputContent).toContain('Version: 1.0.0'); // pkg.version rendered
    expect(outputContent).not.toContain('{{'); // no template syntax left
  });

  it('handles mixed literal and template files correctly', async () => {
    // Create a package with both .hbs and non-.hbs files
    const storeRoot = path.join(fakeHomeDir, '.terrazul', 'store');
    const mixedPkgRoot = path.join(storeRoot, '@test', 'mixed', '1.0.0');

    await write(
      path.join(mixedPkgRoot, 'agents.toml'),
      `\n[package]\nname = "@test/mixed"\nversion = "1.0.0"\n\n[exports.claude]\nsubagentsDir = "templates/agents"\n`,
    );

    // Literal file with examples
    const literalContent = 'Example: {{ askUser("question") }}';
    await write(path.join(mixedPkgRoot, 'templates', 'agents', 'examples.md'), literalContent);

    // Template file to render
    const templateContent = 'Project: {{project.name}}';
    await write(path.join(mixedPkgRoot, 'templates', 'agents', 'agent.md.hbs'), templateContent);

    // Create lockfile entry
    const lockfileContent = await fs.readFile(path.join(projectRoot, 'agents-lock.toml'), 'utf8');
    const updatedLockfile =
      lockfileContent +
      `\n[packages."@test/mixed"]\nversion = "1.0.0"\nresolved = "http://localhost/mixed"\nintegrity = "sha256-test"\ndependencies = { }\n`;
    await fs.writeFile(path.join(projectRoot, 'agents-lock.toml'), updatedLockfile, 'utf8');

    // Create package directory
    const mixedOutputDir = path.join(agentModules, '@test', 'mixed');
    await fs.mkdir(mixedOutputDir, { recursive: true });

    // Render
    await planAndRender(projectRoot, agentModules, {
      packageName: '@test/mixed',
      noCache: true,
      storeDir: storeRoot,
    });

    // Verify literal file was copied
    const literalOutputPath = path.join(mixedOutputDir, 'agents', 'examples.md');
    const literalOutput = await fs.readFile(literalOutputPath, 'utf8');
    expect(literalOutput).toBe(literalContent);
    expect(literalOutput).toContain('{{ askUser(');

    // Verify template file was rendered
    const templateOutputPath = path.join(mixedOutputDir, 'agents', 'agent.md');
    const templateOutput = await fs.readFile(templateOutputPath, 'utf8');
    expect(templateOutput).toContain('Project: @test/project');
    expect(templateOutput).not.toContain('{{');
  });

  it('copies promptsDir files for askAgent snippets', async () => {
    // Create a package with prompts directory
    const storeRoot = path.join(fakeHomeDir, '.terrazul', 'store');
    const promptsPkgRoot = path.join(storeRoot, '@test', 'prompts', '1.0.0');

    await write(
      path.join(promptsPkgRoot, 'agents.toml'),
      `\n[package]\nname = "@test/prompts"\nversion = "1.0.0"\n\n[exports.claude]\ntemplate = "templates/CLAUDE.md.hbs"\npromptsDir = "templates/prompts"\n`,
    );

    // Create a template that references a prompt file
    // Note: The path is relative to the rendered package root (agent_modules/@test/prompts/)
    const templateContent = `# {{project.name}}\n\nPrompts directory contains supporting files.`;
    await write(path.join(promptsPkgRoot, 'templates', 'CLAUDE.md.hbs'), templateContent);

    // Create prompt files
    const promptContent = 'Analyze the tech stack of this project';
    await write(
      path.join(promptsPkgRoot, 'templates', 'prompts', 'detect-tech-stack.txt'),
      promptContent,
    );

    // Create lockfile entry
    const lockfileContent = await fs.readFile(path.join(projectRoot, 'agents-lock.toml'), 'utf8');
    const updatedLockfile =
      lockfileContent +
      `\n[packages."@test/prompts"]\nversion = "1.0.0"\nresolved = "http://localhost/prompts"\nintegrity = "sha256-test"\ndependencies = { }\n`;
    await fs.writeFile(path.join(projectRoot, 'agents-lock.toml'), updatedLockfile, 'utf8');

    // Create package directory
    const promptsOutputDir = path.join(agentModules, '@test', 'prompts');
    await fs.mkdir(promptsOutputDir, { recursive: true });

    // Render
    await planAndRender(projectRoot, agentModules, {
      packageName: '@test/prompts',
      noCache: true,
      storeDir: storeRoot,
    });

    // Verify prompt file was copied
    const promptOutputPath = path.join(promptsOutputDir, 'prompts', 'detect-tech-stack.txt');
    const promptOutput = await fs.readFile(promptOutputPath, 'utf8');
    expect(promptOutput).toBe(promptContent);

    // Verify template was rendered (will be mocked askAgent result in real scenario)
    const templateOutputPath = path.join(promptsOutputDir, 'CLAUDE.md');
    const templateOutputExists = await fs.stat(templateOutputPath).catch(() => null);
    expect(templateOutputExists).toBeTruthy();
  });

  it('includes skipped files in renderedFiles for symlink recreation', async () => {
    // This test verifies that when files are skipped (already exist),
    // they are still included in renderedFiles so symlinks can be recreated
    const storeRoot = path.join(fakeHomeDir, '.terrazul', 'store');

    // Create a new package for this test
    const skipPkgRoot = path.join(storeRoot, '@test', 'skip', '1.0.0');
    await write(
      path.join(skipPkgRoot, 'agents.toml'),
      `\n[package]\nname = "@test/skip"\nversion = "1.0.0"\n\n[exports.claude]\nsubagentsDir = "templates/agents"\n`,
    );
    await write(
      path.join(skipPkgRoot, 'templates', 'agents', 'myagent.md.hbs'),
      '# Agent {{pkg.name}}',
    );

    // Create lockfile entry
    const lockfileContent = await fs.readFile(path.join(projectRoot, 'agents-lock.toml'), 'utf8');
    const updatedLockfile =
      lockfileContent +
      `\n[packages."@test/skip"]\nversion = "1.0.0"\nresolved = "http://localhost/skip"\nintegrity = "sha256-test"\ndependencies = { }\n`;
    await fs.writeFile(path.join(projectRoot, 'agents-lock.toml'), updatedLockfile, 'utf8');

    // Create package directory
    const skipOutputDir = path.join(agentModules, '@test', 'skip');
    await fs.mkdir(skipOutputDir, { recursive: true });

    // First render - should write the file and include it in renderedFiles
    const firstResult = await planAndRender(projectRoot, agentModules, {
      packageName: '@test/skip',
      noCache: true,
      storeDir: storeRoot,
      force: false,
    });

    expect(firstResult.written.length).toBeGreaterThan(0);
    expect(firstResult.renderedFiles.length).toBeGreaterThan(0);

    // Find the agent file in renderedFiles
    const agentFile = firstResult.renderedFiles.find(
      (f) => f.source.includes('agents') && f.source.includes('myagent'),
    );
    expect(agentFile).toBeDefined();

    // Second render (without force) - files should be skipped but STILL in renderedFiles
    const secondResult = await planAndRender(projectRoot, agentModules, {
      packageName: '@test/skip',
      noCache: true,
      storeDir: storeRoot,
      force: false,
    });

    // Verify files were skipped (not written)
    expect(secondResult.skipped.length).toBeGreaterThan(0);
    expect(secondResult.written.length).toBe(0);

    // CRITICAL: Verify skipped files are STILL in renderedFiles
    // This is necessary for symlink recreation to work
    expect(secondResult.renderedFiles.length).toBeGreaterThan(0);

    const skippedAgentFile = secondResult.renderedFiles.find(
      (f) => f.source.includes('agents') && f.source.includes('myagent'),
    );
    expect(skippedAgentFile).toBeDefined();
    expect(skippedAgentFile?.tool).toBe('claude');
    expect(skippedAgentFile?.pkgName).toBe('@test/skip');
  });
});
