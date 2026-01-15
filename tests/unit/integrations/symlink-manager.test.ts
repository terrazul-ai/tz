import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createSymlinks, removeSymlinks } from '../../../src/integrations/symlink-manager.js';

describe('symlink-manager', () => {
  let tmpDir: string;
  let agentModulesDir: string;
  let claudeDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tz-symlink-test-'));
    agentModulesDir = path.join(tmpDir, 'agent_modules');
    claudeDir = path.join(tmpDir, '.claude');

    // Create base directories
    await fs.mkdir(agentModulesDir, { recursive: true });
    await fs.mkdir(claudeDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      void 0;
    }
  });

  describe('createSymlinks', () => {
    describe('nested directory structure support', () => {
      it('should create symlinks for files in claude/agents/ subdirectory', async () => {
        // Setup: Create package with nested structure
        const pkgRoot = path.join(agentModulesDir, '@terrazul', 'general-coder');
        const agentsDir = path.join(pkgRoot, 'claude', 'agents');
        await fs.mkdir(agentsDir, { recursive: true });

        // Create test files
        await fs.writeFile(path.join(agentsDir, 'code-review.md'), '# Code Review');
        await fs.writeFile(path.join(agentsDir, 'go-api-engineer.md'), '# Go API');

        // Mock rendered files metadata (no MCP configs)
        const renderedFiles = [
          {
            pkgName: '@terrazul/general-coder',
            source: path.join(agentsDir, 'code-review.md'),
            tool: 'claude' as const,
            isMcpConfig: false,
          },
          {
            pkgName: '@terrazul/general-coder',
            source: path.join(agentsDir, 'go-api-engineer.md'),
            tool: 'claude' as const,
            isMcpConfig: false,
          },
        ];

        // Create symlinks
        const result = await createSymlinks({
          projectRoot: tmpDir,
          packages: ['@terrazul/general-coder'],
          renderedFiles,
        });

        // Verify symlinks were created
        expect(result.created).toHaveLength(2);
        expect(result.errors).toHaveLength(0);

        // Check symlinks exist in .claude/agents/
        const agentsSymlinks = await fs.readdir(path.join(claudeDir, 'agents'));
        expect(agentsSymlinks).toContain('@terrazul-general-coder-code-review.md');
        expect(agentsSymlinks).toContain('@terrazul-general-coder-go-api-engineer.md');
      });

      it('should handle multiple nesting levels (e.g., claude/deep/agents/)', async () => {
        // Setup: Create package with deeply nested structure
        const pkgRoot = path.join(agentModulesDir, '@user', 'pkg');
        const deepAgentsDir = path.join(pkgRoot, 'claude', 'deep', 'agents');
        await fs.mkdir(deepAgentsDir, { recursive: true });

        await fs.writeFile(path.join(deepAgentsDir, 'agent.md'), '# Agent');

        const renderedFiles = [
          {
            pkgName: '@user/pkg',
            source: path.join(deepAgentsDir, 'agent.md'),
            tool: 'claude' as const,
            isMcpConfig: false,
          },
        ];

        const result = await createSymlinks({
          projectRoot: tmpDir,
          packages: ['@user/pkg'],
          renderedFiles,
        });

        expect(result.created).toHaveLength(1);
        const agentsSymlinks = await fs.readdir(path.join(claudeDir, 'agents'));
        expect(agentsSymlinks).toContain('@user-pkg-agent.md');
      });

      it('should support flat structure (backward compatibility)', async () => {
        // Setup: Create package with flat structure (agents/ at root)
        const pkgRoot = path.join(agentModulesDir, '@user', 'pkg');
        const agentsDir = path.join(pkgRoot, 'agents');
        await fs.mkdir(agentsDir, { recursive: true });

        await fs.writeFile(path.join(agentsDir, 'agent.md'), '# Agent');

        const renderedFiles = [
          {
            pkgName: '@user/pkg',
            source: path.join(agentsDir, 'agent.md'),
            tool: 'claude' as const,
            isMcpConfig: false,
          },
        ];

        const result = await createSymlinks({
          projectRoot: tmpDir,
          packages: ['@user/pkg'],
          renderedFiles,
        });

        expect(result.created).toHaveLength(1);
        const agentsSymlinks = await fs.readdir(path.join(claudeDir, 'agents'));
        expect(agentsSymlinks).toContain('@user-pkg-agent.md');
      });
    });

    describe('MCP config exclusion', () => {
      it('should exclude files marked as MCP configs via metadata', async () => {
        const pkgRoot = path.join(agentModulesDir, '@terrazul', 'general-coder');
        const claudeSubdir = path.join(pkgRoot, 'claude');
        await fs.mkdir(claudeSubdir, { recursive: true });

        // Create MCP config file
        await fs.writeFile(path.join(claudeSubdir, 'mcp_servers.json'), '{}');

        const renderedFiles = [
          {
            pkgName: '@terrazul/general-coder',
            source: path.join(claudeSubdir, 'mcp_servers.json'),
            tool: 'claude' as const,
            isMcpConfig: true, // Marked as MCP config
          },
        ];

        const result = await createSymlinks({
          projectRoot: tmpDir,
          packages: ['@terrazul/general-coder'],
          renderedFiles,
        });

        // Should be skipped
        expect(result.created).toHaveLength(0);
        expect(result.skipped).toHaveLength(1);
      });

      it('should create symlinks for non-MCP files even when MCP configs present', async () => {
        const pkgRoot = path.join(agentModulesDir, '@terrazul', 'general-coder');
        const claudeSubdir = path.join(pkgRoot, 'claude');
        const agentsDir = path.join(claudeSubdir, 'agents');
        await fs.mkdir(agentsDir, { recursive: true });

        // Create both MCP config and agent file
        await fs.writeFile(path.join(claudeSubdir, 'mcp_servers.json'), '{}');
        await fs.writeFile(path.join(agentsDir, 'agent.md'), '# Agent');

        const renderedFiles = [
          {
            pkgName: '@terrazul/general-coder',
            source: path.join(claudeSubdir, 'mcp_servers.json'),
            tool: 'claude' as const,
            isMcpConfig: true,
          },
          {
            pkgName: '@terrazul/general-coder',
            source: path.join(agentsDir, 'agent.md'),
            tool: 'claude' as const,
            isMcpConfig: false,
          },
        ];

        const result = await createSymlinks({
          projectRoot: tmpDir,
          packages: ['@terrazul/general-coder'],
          renderedFiles,
        });

        // Only the agent file should be symlinked
        expect(result.created).toHaveLength(1);
        expect(result.skipped).toHaveLength(1);

        const agentsSymlinks = await fs.readdir(path.join(claudeDir, 'agents'));
        expect(agentsSymlinks).toContain('@terrazul-general-coder-agent.md');
      });
    });

    describe('multi-tool routing', () => {
      it('should route files to correct tool directories based on file.tool', async () => {
        const codexDir = path.join(tmpDir, '.codex');
        await fs.mkdir(codexDir, { recursive: true });

        const pkgRoot = path.join(agentModulesDir, '@user', 'multi-tool');
        const claudeAgentsDir = path.join(pkgRoot, 'claude', 'agents');
        const claudeSkillDir = path.join(pkgRoot, 'claude', 'skills', 'claude-skill');
        const codexSkillDir = path.join(pkgRoot, 'codex', 'skills', 'codex-skill');
        await fs.mkdir(claudeAgentsDir, { recursive: true });
        await fs.mkdir(claudeSkillDir, { recursive: true });
        await fs.mkdir(codexSkillDir, { recursive: true });

        await fs.writeFile(path.join(claudeAgentsDir, 'claude-agent.md'), '# Claude Agent');
        await fs.writeFile(path.join(claudeSkillDir, 'SKILL.md'), '# Claude Skill');
        await fs.writeFile(path.join(codexSkillDir, 'SKILL.md'), '# Codex Skill');

        const renderedFiles = [
          {
            pkgName: '@user/multi-tool',
            source: path.join(claudeAgentsDir, 'claude-agent.md'),
            tool: 'claude' as const,
            isMcpConfig: false,
          },
          {
            pkgName: '@user/multi-tool',
            source: path.join(claudeSkillDir, 'SKILL.md'),
            tool: 'claude' as const,
            isMcpConfig: false,
          },
          {
            pkgName: '@user/multi-tool',
            source: path.join(codexSkillDir, 'SKILL.md'),
            tool: 'codex' as const,
            isMcpConfig: false,
          },
        ];

        // Create symlinks for ALL files in a single call
        const result = await createSymlinks({
          projectRoot: tmpDir,
          packages: ['@user/multi-tool'],
          renderedFiles,
        });

        // All files should be symlinked: 1 claude agent + 1 claude skill + 1 codex skill
        expect(result.created).toHaveLength(3);

        // Claude agent goes to .claude/agents/
        const claudeAgentsSymlinks = await fs.readdir(path.join(claudeDir, 'agents'));
        expect(claudeAgentsSymlinks).toContain('@user-multi-tool-claude-agent.md');

        // Claude skill goes to .claude/skills/
        const claudeSkillsSymlinks = await fs.readdir(path.join(claudeDir, 'skills'));
        expect(claudeSkillsSymlinks).toContain('@user-multi-tool-claude-skill');

        // Codex skill goes to .codex/skills/
        const codexSkillsSymlinks = await fs.readdir(path.join(codexDir, 'skills'));
        expect(codexSkillsSymlinks).toContain('@user-multi-tool-codex-skill');
      });

      it('should skip files for tools with no operational directories', async () => {
        const pkgRoot = path.join(agentModulesDir, '@user', 'cursor-pkg');
        const cursorAgentsDir = path.join(pkgRoot, 'cursor', 'agents');
        await fs.mkdir(cursorAgentsDir, { recursive: true });

        await fs.writeFile(path.join(cursorAgentsDir, 'agent.md'), '# Cursor Agent');

        const renderedFiles = [
          {
            pkgName: '@user/cursor-pkg',
            source: path.join(cursorAgentsDir, 'agent.md'),
            tool: 'cursor' as const, // cursor has no operational dirs
            isMcpConfig: false,
          },
        ];

        const result = await createSymlinks({
          projectRoot: tmpDir,
          packages: ['@user/cursor-pkg'],
          renderedFiles,
        });

        // No symlinks created (cursor has empty operational dirs)
        expect(result.created).toHaveLength(0);
      });
    });

    describe('registry tracking', () => {
      it('should track tool type in symlink registry', async () => {
        const pkgRoot = path.join(agentModulesDir, '@user', 'pkg');
        const agentsDir = path.join(pkgRoot, 'claude', 'agents');
        await fs.mkdir(agentsDir, { recursive: true });

        await fs.writeFile(path.join(agentsDir, 'agent.md'), '# Agent');

        const renderedFiles = [
          {
            pkgName: '@user/pkg',
            source: path.join(agentsDir, 'agent.md'),
            tool: 'claude' as const,
            isMcpConfig: false,
          },
        ];

        await createSymlinks({
          projectRoot: tmpDir,
          packages: ['@user/pkg'],
          renderedFiles,
        });

        // Read registry
        const registryPath = path.join(tmpDir, '.terrazul', 'symlinks.json');
        const registryContent = await fs.readFile(registryPath, 'utf8');
        const registry = JSON.parse(registryContent);

        // Check tool field is present
        const symlinkKey = Object.keys(registry.symlinks)[0];
        expect(registry.symlinks[symlinkKey]).toHaveProperty('tool', 'claude');
      });
    });

    describe('context file exclusion', () => {
      it('should exclude CLAUDE.md and AGENTS.md from symlinks', async () => {
        const pkgRoot = path.join(agentModulesDir, '@user', 'pkg');
        const agentsDir = path.join(pkgRoot, 'claude', 'agents');
        await fs.mkdir(agentsDir, { recursive: true });

        // Create context files alongside agent file
        await fs.writeFile(path.join(agentsDir, 'CLAUDE.md'), '# Context');
        await fs.writeFile(path.join(agentsDir, 'AGENTS.md'), '# Agents');
        await fs.writeFile(path.join(agentsDir, 'agent.md'), '# Agent');

        const renderedFiles = [
          {
            pkgName: '@user/pkg',
            source: path.join(agentsDir, 'CLAUDE.md'),
            tool: 'claude' as const,
            isMcpConfig: false,
          },
          {
            pkgName: '@user/pkg',
            source: path.join(agentsDir, 'AGENTS.md'),
            tool: 'claude' as const,
            isMcpConfig: false,
          },
          {
            pkgName: '@user/pkg',
            source: path.join(agentsDir, 'agent.md'),
            tool: 'claude' as const,
            isMcpConfig: false,
          },
        ];

        const result = await createSymlinks({
          projectRoot: tmpDir,
          packages: ['@user/pkg'],
          renderedFiles,
        });

        // Only agent.md should be symlinked
        expect(result.created).toHaveLength(1);
        expect(result.skipped).toHaveLength(2);

        const agentsSymlinks = await fs.readdir(path.join(claudeDir, 'agents'));
        expect(agentsSymlinks).toContain('@user-pkg-agent.md');
        expect(agentsSymlinks).not.toContain('@user-pkg-CLAUDE.md');
        expect(agentsSymlinks).not.toContain('@user-pkg-AGENTS.md');
      });
    });

    describe('all operational directories', () => {
      it('should create symlinks for agents/, commands/, skills/ (not hooks)', async () => {
        const pkgRoot = path.join(agentModulesDir, '@user', 'pkg');
        const claudeSubdir = path.join(pkgRoot, 'claude');

        // Create operational directories (hooks excluded - not supported by Claude)
        const agentsDir = path.join(claudeSubdir, 'agents');
        const commandsDir = path.join(claudeSubdir, 'commands');
        const skillsDir = path.join(claudeSubdir, 'skills', 'my-skill');

        await fs.mkdir(agentsDir, { recursive: true });
        await fs.mkdir(commandsDir, { recursive: true });
        await fs.mkdir(skillsDir, { recursive: true });

        await fs.writeFile(path.join(agentsDir, 'agent.md'), '# Agent');
        await fs.writeFile(path.join(commandsDir, 'cmd.md'), '# Command');
        // Skills have directory structure with multiple files
        await fs.writeFile(path.join(skillsDir, 'SKILL.md'), '# Skill');
        await fs.writeFile(path.join(skillsDir, 'examples.md'), '# Examples');
        await fs.writeFile(path.join(skillsDir, 'reference.md'), '# Reference');

        const renderedFiles = [
          {
            pkgName: '@user/pkg',
            source: path.join(agentsDir, 'agent.md'),
            tool: 'claude' as const,
            isMcpConfig: false,
          },
          {
            pkgName: '@user/pkg',
            source: path.join(commandsDir, 'cmd.md'),
            tool: 'claude' as const,
            isMcpConfig: false,
          },
          // Skill files - all from same skill directory
          {
            pkgName: '@user/pkg',
            source: path.join(skillsDir, 'SKILL.md'),
            tool: 'claude' as const,
            isMcpConfig: false,
          },
          {
            pkgName: '@user/pkg',
            source: path.join(skillsDir, 'examples.md'),
            tool: 'claude' as const,
            isMcpConfig: false,
          },
          {
            pkgName: '@user/pkg',
            source: path.join(skillsDir, 'reference.md'),
            tool: 'claude' as const,
            isMcpConfig: false,
          },
        ];

        const result = await createSymlinks({
          projectRoot: tmpDir,
          packages: ['@user/pkg'],
          renderedFiles,
        });

        // 2 file symlinks (agent, command) + 1 directory symlink (skill)
        expect(result.created).toHaveLength(3);

        // Verify symlinks in each directory
        const agentsSymlinks = await fs.readdir(path.join(claudeDir, 'agents'));
        const commandsSymlinks = await fs.readdir(path.join(claudeDir, 'commands'));
        const skillsSymlinks = await fs.readdir(path.join(claudeDir, 'skills'));

        expect(agentsSymlinks).toContain('@user-pkg-agent.md');
        expect(commandsSymlinks).toContain('@user-pkg-cmd.md');
        // Skills should be directory symlinks, not individual files
        expect(skillsSymlinks).toContain('@user-pkg-my-skill');
        expect(skillsSymlinks).not.toContain('@user-pkg-SKILL.md');
        expect(skillsSymlinks).not.toContain('@user-pkg-examples.md');
        expect(skillsSymlinks).not.toContain('@user-pkg-reference.md');
      });

      it('should NOT create symlinks for hooks/ directory', async () => {
        const pkgRoot = path.join(agentModulesDir, '@user', 'pkg');
        const claudeSubdir = path.join(pkgRoot, 'claude');

        // Create hooks directory
        const hooksDir = path.join(claudeSubdir, 'hooks');
        await fs.mkdir(hooksDir, { recursive: true });
        await fs.writeFile(path.join(hooksDir, 'hook.md'), '# Hook');

        const renderedFiles = [
          {
            pkgName: '@user/pkg',
            source: path.join(hooksDir, 'hook.md'),
            tool: 'claude' as const,
            isMcpConfig: false,
          },
        ];

        const result = await createSymlinks({
          projectRoot: tmpDir,
          packages: ['@user/pkg'],
          renderedFiles,
        });

        // Hooks should not be symlinked
        expect(result.created).toHaveLength(0);
      });
    });

    describe('skill directory symlinks', () => {
      it('should create directory symlink for skill instead of individual files', async () => {
        const pkgRoot = path.join(agentModulesDir, '@leourbina', 'gcloud-log-analyzer');
        const skillDir = path.join(pkgRoot, 'claude', 'skills', 'analyze-log-patterns');
        await fs.mkdir(skillDir, { recursive: true });

        // Create skill files
        await fs.writeFile(path.join(skillDir, 'SKILL.md'), '# Skill');
        await fs.writeFile(path.join(skillDir, 'examples.md'), '# Examples');
        await fs.writeFile(path.join(skillDir, 'reference.md'), '# Reference');

        const renderedFiles = [
          {
            pkgName: '@leourbina/gcloud-log-analyzer',
            source: path.join(skillDir, 'SKILL.md'),
            tool: 'claude' as const,
            isMcpConfig: false,
          },
          {
            pkgName: '@leourbina/gcloud-log-analyzer',
            source: path.join(skillDir, 'examples.md'),
            tool: 'claude' as const,
            isMcpConfig: false,
          },
          {
            pkgName: '@leourbina/gcloud-log-analyzer',
            source: path.join(skillDir, 'reference.md'),
            tool: 'claude' as const,
            isMcpConfig: false,
          },
        ];

        const result = await createSymlinks({
          projectRoot: tmpDir,
          packages: ['@leourbina/gcloud-log-analyzer'],
          renderedFiles,
        });

        // Should create ONE directory symlink, not 3 file symlinks
        expect(result.created).toHaveLength(1);

        // Verify symlink is a directory
        const skillsSymlinks = await fs.readdir(path.join(claudeDir, 'skills'));
        expect(skillsSymlinks).toHaveLength(1);
        expect(skillsSymlinks[0]).toBe('@leourbina-gcloud-log-analyzer-analyze-log-patterns');

        // Verify symlink points to directory and contains all files
        const symlinkPath = path.join(
          claudeDir,
          'skills',
          '@leourbina-gcloud-log-analyzer-analyze-log-patterns',
        );
        const symlinkStat = await fs.lstat(symlinkPath);
        expect(symlinkStat.isSymbolicLink()).toBe(true);

        // Follow symlink and verify files
        const filesInSkill = await fs.readdir(symlinkPath);
        expect(filesInSkill).toContain('SKILL.md');
        expect(filesInSkill).toContain('examples.md');
        expect(filesInSkill).toContain('reference.md');
      });

      it('should create multiple directory symlinks for multiple skills', async () => {
        const pkgRoot = path.join(agentModulesDir, '@leourbina', 'gcloud-log-analyzer');
        const skillsBase = path.join(pkgRoot, 'claude', 'skills');

        // Create multiple skill directories
        const skill1Dir = path.join(skillsBase, 'analyze-log-patterns');
        const skill2Dir = path.join(skillsBase, 'fetch-gcp-logs');
        const skill3Dir = path.join(skillsBase, 'trace-request');

        await fs.mkdir(skill1Dir, { recursive: true });
        await fs.mkdir(skill2Dir, { recursive: true });
        await fs.mkdir(skill3Dir, { recursive: true });

        // Create files in each skill
        for (const dir of [skill1Dir, skill2Dir, skill3Dir]) {
          await fs.writeFile(path.join(dir, 'SKILL.md'), '# Skill');
          await fs.writeFile(path.join(dir, 'examples.md'), '# Examples');
        }

        const renderedFiles = [
          // Skill 1 files
          {
            pkgName: '@leourbina/gcloud-log-analyzer',
            source: path.join(skill1Dir, 'SKILL.md'),
            tool: 'claude' as const,
            isMcpConfig: false,
          },
          {
            pkgName: '@leourbina/gcloud-log-analyzer',
            source: path.join(skill1Dir, 'examples.md'),
            tool: 'claude' as const,
            isMcpConfig: false,
          },
          // Skill 2 files
          {
            pkgName: '@leourbina/gcloud-log-analyzer',
            source: path.join(skill2Dir, 'SKILL.md'),
            tool: 'claude' as const,
            isMcpConfig: false,
          },
          {
            pkgName: '@leourbina/gcloud-log-analyzer',
            source: path.join(skill2Dir, 'examples.md'),
            tool: 'claude' as const,
            isMcpConfig: false,
          },
          // Skill 3 files
          {
            pkgName: '@leourbina/gcloud-log-analyzer',
            source: path.join(skill3Dir, 'SKILL.md'),
            tool: 'claude' as const,
            isMcpConfig: false,
          },
          {
            pkgName: '@leourbina/gcloud-log-analyzer',
            source: path.join(skill3Dir, 'examples.md'),
            tool: 'claude' as const,
            isMcpConfig: false,
          },
        ];

        const result = await createSymlinks({
          projectRoot: tmpDir,
          packages: ['@leourbina/gcloud-log-analyzer'],
          renderedFiles,
        });

        // Should create 3 directory symlinks
        expect(result.created).toHaveLength(3);

        const skillsSymlinks = await fs.readdir(path.join(claudeDir, 'skills'));
        expect(skillsSymlinks).toHaveLength(3);
        expect(skillsSymlinks).toContain('@leourbina-gcloud-log-analyzer-analyze-log-patterns');
        expect(skillsSymlinks).toContain('@leourbina-gcloud-log-analyzer-fetch-gcp-logs');
        expect(skillsSymlinks).toContain('@leourbina-gcloud-log-analyzer-trace-request');
      });

      it('should track skill directory symlinks in registry', async () => {
        const pkgRoot = path.join(agentModulesDir, '@user', 'pkg');
        const skillDir = path.join(pkgRoot, 'claude', 'skills', 'my-skill');
        await fs.mkdir(skillDir, { recursive: true });

        await fs.writeFile(path.join(skillDir, 'SKILL.md'), '# Skill');

        const renderedFiles = [
          {
            pkgName: '@user/pkg',
            source: path.join(skillDir, 'SKILL.md'),
            tool: 'claude' as const,
            isMcpConfig: false,
          },
        ];

        await createSymlinks({
          projectRoot: tmpDir,
          packages: ['@user/pkg'],
          renderedFiles,
        });

        // Read registry
        const registryPath = path.join(tmpDir, '.terrazul', 'symlinks.json');
        const registryContent = await fs.readFile(registryPath, 'utf8');
        const registry = JSON.parse(registryContent);

        // Check registry entry for skill directory
        const symlinkKey = '.claude/skills/@user-pkg-my-skill';
        expect(registry.symlinks[symlinkKey]).toBeDefined();
        expect(registry.symlinks[symlinkKey].package).toBe('@user/pkg');
        expect(registry.symlinks[symlinkKey].tool).toBe('claude');
        // Source should be the skill directory, not individual file
        expect(registry.symlinks[symlinkKey].source).toBe(skillDir);
      });

      it('should remove skill directory symlinks correctly', async () => {
        const pkgRoot = path.join(agentModulesDir, '@user', 'pkg');
        const skillDir = path.join(pkgRoot, 'claude', 'skills', 'my-skill');
        await fs.mkdir(skillDir, { recursive: true });

        await fs.writeFile(path.join(skillDir, 'SKILL.md'), '# Skill');
        await fs.writeFile(path.join(skillDir, 'examples.md'), '# Examples');

        const renderedFiles = [
          {
            pkgName: '@user/pkg',
            source: path.join(skillDir, 'SKILL.md'),
            tool: 'claude' as const,
            isMcpConfig: false,
          },
          {
            pkgName: '@user/pkg',
            source: path.join(skillDir, 'examples.md'),
            tool: 'claude' as const,
            isMcpConfig: false,
          },
        ];

        // Create symlinks
        await createSymlinks({
          projectRoot: tmpDir,
          packages: ['@user/pkg'],
          renderedFiles,
        });

        // Verify symlink exists
        const symlinkPath = path.join(claudeDir, 'skills', '@user-pkg-my-skill');
        const existsBefore = await fs
          .access(symlinkPath)
          .then(() => true)
          .catch(() => false);
        expect(existsBefore).toBe(true);

        // Remove symlinks
        const result = await removeSymlinks(tmpDir, '@user/pkg');

        expect(result.removed).toHaveLength(1);
        expect(result.errors).toHaveLength(0);

        // Verify symlink is gone
        const existsAfter = await fs
          .access(symlinkPath)
          .then(() => true)
          .catch(() => false);
        expect(existsAfter).toBe(false);
      });

      it('should handle skills with nested subdirectories correctly', async () => {
        const pkgRoot = path.join(agentModulesDir, '@user', 'pkg');
        const skillDir = path.join(pkgRoot, 'claude', 'skills', 'my-skill');

        // Create nested subdirectories (resources/, templates/) as recommended by Claude docs
        const resourcesDir = path.join(skillDir, 'resources');
        const templatesDir = path.join(skillDir, 'templates');
        await fs.mkdir(resourcesDir, { recursive: true });
        await fs.mkdir(templatesDir, { recursive: true });

        // Create files in skill root and nested subdirectories
        await fs.writeFile(path.join(skillDir, 'SKILL.md'), '# Skill');
        await fs.writeFile(path.join(resourcesDir, 'reference.md'), '# Reference');
        await fs.writeFile(path.join(resourcesDir, 'examples.md'), '# Examples');
        await fs.writeFile(path.join(templatesDir, 'template.html'), '<html></html>');

        const renderedFiles = [
          {
            pkgName: '@user/pkg',
            source: path.join(skillDir, 'SKILL.md'),
            tool: 'claude' as const,
            isMcpConfig: false,
          },
          {
            pkgName: '@user/pkg',
            source: path.join(resourcesDir, 'reference.md'),
            tool: 'claude' as const,
            isMcpConfig: false,
          },
          {
            pkgName: '@user/pkg',
            source: path.join(resourcesDir, 'examples.md'),
            tool: 'claude' as const,
            isMcpConfig: false,
          },
          {
            pkgName: '@user/pkg',
            source: path.join(templatesDir, 'template.html'),
            tool: 'claude' as const,
            isMcpConfig: false,
          },
        ];

        const result = await createSymlinks({
          projectRoot: tmpDir,
          packages: ['@user/pkg'],
          renderedFiles,
        });

        // Should create ONE directory symlink (not 4 file symlinks)
        expect(result.created).toHaveLength(1);
        expect(result.errors).toHaveLength(0);

        // Verify symlink is at skill root level
        const skillsSymlinks = await fs.readdir(path.join(claudeDir, 'skills'));
        expect(skillsSymlinks).toHaveLength(1);
        expect(skillsSymlinks[0]).toBe('@user-pkg-my-skill');

        // Verify symlink is a directory and points to skill root
        const symlinkPath = path.join(claudeDir, 'skills', '@user-pkg-my-skill');
        const symlinkStat = await fs.lstat(symlinkPath);
        expect(symlinkStat.isSymbolicLink()).toBe(true);

        // Verify all nested files are accessible through the symlink
        const filesInSkill = await fs.readdir(symlinkPath, { recursive: true });
        expect(filesInSkill).toContain('SKILL.md');
        expect(filesInSkill).toContain(path.join('resources', 'reference.md'));
        expect(filesInSkill).toContain(path.join('resources', 'examples.md'));
        expect(filesInSkill).toContain(path.join('templates', 'template.html'));

        // Verify registry tracks skill directory (not individual files)
        const registryPath = path.join(tmpDir, '.terrazul', 'symlinks.json');
        const registryContent = await fs.readFile(registryPath, 'utf8');
        const registry = JSON.parse(registryContent);

        const symlinkKey = '.claude/skills/@user-pkg-my-skill';
        expect(registry.symlinks[symlinkKey]).toBeDefined();
        expect(registry.symlinks[symlinkKey].package).toBe('@user/pkg');
        expect(registry.symlinks[symlinkKey].source).toBe(skillDir);
        expect(registry.symlinks[symlinkKey].tool).toBe('claude');
      });
    });
  });

  describe('exclusive mode', () => {
    it('should remove non-target package symlinks when exclusive is true', async () => {
      // Setup: Create two packages with agents
      const pkgARoot = path.join(agentModulesDir, '@user', 'pkg-a');
      const pkgBRoot = path.join(agentModulesDir, '@user', 'pkg-b');
      const pkgAAgentsDir = path.join(pkgARoot, 'claude', 'agents');
      const pkgBAgentsDir = path.join(pkgBRoot, 'claude', 'agents');

      await fs.mkdir(pkgAAgentsDir, { recursive: true });
      await fs.mkdir(pkgBAgentsDir, { recursive: true });

      await fs.writeFile(path.join(pkgAAgentsDir, 'agent-a.md'), '# Agent A');
      await fs.writeFile(path.join(pkgBAgentsDir, 'agent-b.md'), '# Agent B');

      // Create symlinks for both packages (non-exclusive)
      const allRenderedFiles = [
        {
          pkgName: '@user/pkg-a',
          source: path.join(pkgAAgentsDir, 'agent-a.md'),
          tool: 'claude' as const,
          isMcpConfig: false,
        },
        {
          pkgName: '@user/pkg-b',
          source: path.join(pkgBAgentsDir, 'agent-b.md'),
          tool: 'claude' as const,
          isMcpConfig: false,
        },
      ];

      await createSymlinks({
        projectRoot: tmpDir,
        packages: ['@user/pkg-a', '@user/pkg-b'],
        renderedFiles: allRenderedFiles,
        activeTool: 'claude',
      });

      // Verify both symlinks exist
      let agentsSymlinks = await fs.readdir(path.join(claudeDir, 'agents'));
      expect(agentsSymlinks).toContain('@user-pkg-a-agent-a.md');
      expect(agentsSymlinks).toContain('@user-pkg-b-agent-b.md');

      // Now run exclusive for pkg-a only
      const pkgARenderedFiles = [
        {
          pkgName: '@user/pkg-a',
          source: path.join(pkgAAgentsDir, 'agent-a.md'),
          tool: 'claude' as const,
          isMcpConfig: false,
        },
      ];

      const result = await createSymlinks({
        projectRoot: tmpDir,
        packages: ['@user/pkg-a'],
        renderedFiles: pkgARenderedFiles,
        activeTool: 'claude',
        exclusive: true,
      });

      // pkg-b's symlink should be removed
      expect(result.removed).toHaveLength(1);
      expect(result.removed[0]).toContain('@user-pkg-b-agent-b.md');

      // Verify only pkg-a's symlink remains
      agentsSymlinks = await fs.readdir(path.join(claudeDir, 'agents'));
      expect(agentsSymlinks).toContain('@user-pkg-a-agent-a.md');
      expect(agentsSymlinks).not.toContain('@user-pkg-b-agent-b.md');
    });

    it('should preserve symlinks from all target packages when exclusive is true', async () => {
      // Setup: Create three packages
      const pkgARoot = path.join(agentModulesDir, '@user', 'pkg-a');
      const pkgBRoot = path.join(agentModulesDir, '@user', 'pkg-b');
      const pkgCRoot = path.join(agentModulesDir, '@user', 'pkg-c');
      const pkgAAgentsDir = path.join(pkgARoot, 'claude', 'agents');
      const pkgBAgentsDir = path.join(pkgBRoot, 'claude', 'agents');
      const pkgCAgentsDir = path.join(pkgCRoot, 'claude', 'agents');

      await fs.mkdir(pkgAAgentsDir, { recursive: true });
      await fs.mkdir(pkgBAgentsDir, { recursive: true });
      await fs.mkdir(pkgCAgentsDir, { recursive: true });

      await fs.writeFile(path.join(pkgAAgentsDir, 'agent-a.md'), '# Agent A');
      await fs.writeFile(path.join(pkgBAgentsDir, 'agent-b.md'), '# Agent B');
      await fs.writeFile(path.join(pkgCAgentsDir, 'agent-c.md'), '# Agent C');

      // Create symlinks for all three packages
      const allRenderedFiles = [
        {
          pkgName: '@user/pkg-a',
          source: path.join(pkgAAgentsDir, 'agent-a.md'),
          tool: 'claude' as const,
          isMcpConfig: false,
        },
        {
          pkgName: '@user/pkg-b',
          source: path.join(pkgBAgentsDir, 'agent-b.md'),
          tool: 'claude' as const,
          isMcpConfig: false,
        },
        {
          pkgName: '@user/pkg-c',
          source: path.join(pkgCAgentsDir, 'agent-c.md'),
          tool: 'claude' as const,
          isMcpConfig: false,
        },
      ];

      await createSymlinks({
        projectRoot: tmpDir,
        packages: ['@user/pkg-a', '@user/pkg-b', '@user/pkg-c'],
        renderedFiles: allRenderedFiles,
        activeTool: 'claude',
      });

      // Run exclusive for pkg-a and pkg-b
      const abRenderedFiles = [
        {
          pkgName: '@user/pkg-a',
          source: path.join(pkgAAgentsDir, 'agent-a.md'),
          tool: 'claude' as const,
          isMcpConfig: false,
        },
        {
          pkgName: '@user/pkg-b',
          source: path.join(pkgBAgentsDir, 'agent-b.md'),
          tool: 'claude' as const,
          isMcpConfig: false,
        },
      ];

      const result = await createSymlinks({
        projectRoot: tmpDir,
        packages: ['@user/pkg-a', '@user/pkg-b'],
        renderedFiles: abRenderedFiles,
        activeTool: 'claude',
        exclusive: true,
      });

      // pkg-c's symlink should be removed
      expect(result.removed).toHaveLength(1);
      expect(result.removed[0]).toContain('@user-pkg-c-agent-c.md');

      // Verify pkg-a and pkg-b's symlinks remain
      const agentsSymlinks = await fs.readdir(path.join(claudeDir, 'agents'));
      expect(agentsSymlinks).toContain('@user-pkg-a-agent-a.md');
      expect(agentsSymlinks).toContain('@user-pkg-b-agent-b.md');
      expect(agentsSymlinks).not.toContain('@user-pkg-c-agent-c.md');
    });

    it('should NOT remove symlinks when exclusive is false (default)', async () => {
      // Setup: Create package A's symlink
      const pkgARoot = path.join(agentModulesDir, '@user', 'pkg-a');
      const pkgAAgentsDir = path.join(pkgARoot, 'claude', 'agents');
      await fs.mkdir(pkgAAgentsDir, { recursive: true });
      await fs.writeFile(path.join(pkgAAgentsDir, 'agent-a.md'), '# Agent A');

      const pkgARenderedFiles = [
        {
          pkgName: '@user/pkg-a',
          source: path.join(pkgAAgentsDir, 'agent-a.md'),
          tool: 'claude' as const,
          isMcpConfig: false,
        },
      ];

      await createSymlinks({
        projectRoot: tmpDir,
        packages: ['@user/pkg-a'],
        renderedFiles: pkgARenderedFiles,
        activeTool: 'claude',
      });

      // Setup: Create package B
      const pkgBRoot = path.join(agentModulesDir, '@user', 'pkg-b');
      const pkgBAgentsDir = path.join(pkgBRoot, 'claude', 'agents');
      await fs.mkdir(pkgBAgentsDir, { recursive: true });
      await fs.writeFile(path.join(pkgBAgentsDir, 'agent-b.md'), '# Agent B');

      const pkgBRenderedFiles = [
        {
          pkgName: '@user/pkg-b',
          source: path.join(pkgBAgentsDir, 'agent-b.md'),
          tool: 'claude' as const,
          isMcpConfig: false,
        },
      ];

      // Add package B without exclusive (default)
      const result = await createSymlinks({
        projectRoot: tmpDir,
        packages: ['@user/pkg-b'],
        renderedFiles: pkgBRenderedFiles,
        activeTool: 'claude',
        // exclusive: false (default)
      });

      // No symlinks should be removed
      expect(result.removed).toHaveLength(0);

      // Both symlinks should exist
      const agentsSymlinks = await fs.readdir(path.join(claudeDir, 'agents'));
      expect(agentsSymlinks).toContain('@user-pkg-a-agent-a.md');
      expect(agentsSymlinks).toContain('@user-pkg-b-agent-b.md');
    });

    it('should only remove symlinks for current tool when exclusive is true', async () => {
      // Setup: Create packages for both Claude and Codex
      // Note: All symlinks go to .claude/ but are distinguished by tool in registry
      const claudePkgRoot = path.join(agentModulesDir, '@user', 'claude-pkg');
      const codexPkgRoot = path.join(agentModulesDir, '@user', 'codex-pkg');
      const claudeAgentsDir = path.join(claudePkgRoot, 'claude', 'agents');
      const codexAgentsDir = path.join(codexPkgRoot, 'codex', 'agents');

      await fs.mkdir(claudeAgentsDir, { recursive: true });
      await fs.mkdir(codexAgentsDir, { recursive: true });

      await fs.writeFile(path.join(claudeAgentsDir, 'claude-agent.md'), '# Claude Agent');
      await fs.writeFile(path.join(codexAgentsDir, 'codex-agent.md'), '# Codex Agent');

      // Create Claude symlinks (in .claude/)
      await createSymlinks({
        projectRoot: tmpDir,
        packages: ['@user/claude-pkg'],
        renderedFiles: [
          {
            pkgName: '@user/claude-pkg',
            source: path.join(claudeAgentsDir, 'claude-agent.md'),
            tool: 'claude' as const,
            isMcpConfig: false,
          },
        ],
        activeTool: 'claude',
      });

      // Create Codex symlinks (also in .claude/, but with tool: 'codex' in registry)
      await createSymlinks({
        projectRoot: tmpDir,
        packages: ['@user/codex-pkg'],
        renderedFiles: [
          {
            pkgName: '@user/codex-pkg',
            source: path.join(codexAgentsDir, 'codex-agent.md'),
            tool: 'codex' as const,
            isMcpConfig: false,
          },
        ],
        activeTool: 'codex',
      });

      // Verify both symlinks exist in .claude/agents/
      let agentsSymlinks = await fs.readdir(path.join(claudeDir, 'agents'));
      expect(agentsSymlinks).toContain('@user-claude-pkg-claude-agent.md');
      expect(agentsSymlinks).toContain('@user-codex-pkg-codex-agent.md');

      // Now create new Claude package with exclusive mode
      const newClaudePkgRoot = path.join(agentModulesDir, '@user', 'new-claude-pkg');
      const newClaudeAgentsDir = path.join(newClaudePkgRoot, 'claude', 'agents');
      await fs.mkdir(newClaudeAgentsDir, { recursive: true });
      await fs.writeFile(path.join(newClaudeAgentsDir, 'new-agent.md'), '# New Agent');

      const result = await createSymlinks({
        projectRoot: tmpDir,
        packages: ['@user/new-claude-pkg'],
        renderedFiles: [
          {
            pkgName: '@user/new-claude-pkg',
            source: path.join(newClaudeAgentsDir, 'new-agent.md'),
            tool: 'claude' as const,
            isMcpConfig: false,
          },
        ],
        activeTool: 'claude',
        exclusive: true,
      });

      // Old Claude symlink should be removed (it's for claude tool, not in target packages)
      expect(result.removed).toHaveLength(1);
      expect(result.removed[0]).toContain('@user-claude-pkg-claude-agent.md');

      // Check final state in .claude/agents/
      agentsSymlinks = await fs.readdir(path.join(claudeDir, 'agents'));

      // New Claude symlink should exist
      expect(agentsSymlinks).toContain('@user-new-claude-pkg-new-agent.md');

      // Old Claude symlink should be removed
      expect(agentsSymlinks).not.toContain('@user-claude-pkg-claude-agent.md');

      // Codex symlink should be unaffected (different tool in registry)
      expect(agentsSymlinks).toContain('@user-codex-pkg-codex-agent.md');
    });

    it('should update registry correctly when removing symlinks in exclusive mode', async () => {
      // Setup: Create two packages
      const pkgARoot = path.join(agentModulesDir, '@user', 'pkg-a');
      const pkgBRoot = path.join(agentModulesDir, '@user', 'pkg-b');
      const pkgAAgentsDir = path.join(pkgARoot, 'claude', 'agents');
      const pkgBAgentsDir = path.join(pkgBRoot, 'claude', 'agents');

      await fs.mkdir(pkgAAgentsDir, { recursive: true });
      await fs.mkdir(pkgBAgentsDir, { recursive: true });

      await fs.writeFile(path.join(pkgAAgentsDir, 'agent-a.md'), '# Agent A');
      await fs.writeFile(path.join(pkgBAgentsDir, 'agent-b.md'), '# Agent B');

      // Create symlinks for both packages
      await createSymlinks({
        projectRoot: tmpDir,
        packages: ['@user/pkg-a', '@user/pkg-b'],
        renderedFiles: [
          {
            pkgName: '@user/pkg-a',
            source: path.join(pkgAAgentsDir, 'agent-a.md'),
            tool: 'claude' as const,
            isMcpConfig: false,
          },
          {
            pkgName: '@user/pkg-b',
            source: path.join(pkgBAgentsDir, 'agent-b.md'),
            tool: 'claude' as const,
            isMcpConfig: false,
          },
        ],
        activeTool: 'claude',
      });

      // Run exclusive for pkg-a
      await createSymlinks({
        projectRoot: tmpDir,
        packages: ['@user/pkg-a'],
        renderedFiles: [
          {
            pkgName: '@user/pkg-a',
            source: path.join(pkgAAgentsDir, 'agent-a.md'),
            tool: 'claude' as const,
            isMcpConfig: false,
          },
        ],
        activeTool: 'claude',
        exclusive: true,
      });

      // Verify registry only contains pkg-a
      const registryPath = path.join(tmpDir, '.terrazul', 'symlinks.json');
      const registryContent = await fs.readFile(registryPath, 'utf8');
      const registry = JSON.parse(registryContent);

      const symlinkKeys = Object.keys(registry.symlinks);
      expect(symlinkKeys).toHaveLength(1);
      expect(symlinkKeys[0]).toContain('@user-pkg-a');
      expect(registry.symlinks[symlinkKeys[0]].package).toBe('@user/pkg-a');
    });

    it('should handle exclusive mode with skill directory symlinks', async () => {
      // Setup: Create two packages with skills
      const pkgARoot = path.join(agentModulesDir, '@user', 'pkg-a');
      const pkgBRoot = path.join(agentModulesDir, '@user', 'pkg-b');
      const pkgASkillDir = path.join(pkgARoot, 'claude', 'skills', 'skill-a');
      const pkgBSkillDir = path.join(pkgBRoot, 'claude', 'skills', 'skill-b');

      await fs.mkdir(pkgASkillDir, { recursive: true });
      await fs.mkdir(pkgBSkillDir, { recursive: true });

      await fs.writeFile(path.join(pkgASkillDir, 'SKILL.md'), '# Skill A');
      await fs.writeFile(path.join(pkgBSkillDir, 'SKILL.md'), '# Skill B');

      // Create symlinks for both packages
      await createSymlinks({
        projectRoot: tmpDir,
        packages: ['@user/pkg-a', '@user/pkg-b'],
        renderedFiles: [
          {
            pkgName: '@user/pkg-a',
            source: path.join(pkgASkillDir, 'SKILL.md'),
            tool: 'claude' as const,
            isMcpConfig: false,
          },
          {
            pkgName: '@user/pkg-b',
            source: path.join(pkgBSkillDir, 'SKILL.md'),
            tool: 'claude' as const,
            isMcpConfig: false,
          },
        ],
        activeTool: 'claude',
      });

      // Verify both skill symlinks exist
      let skillsSymlinks = await fs.readdir(path.join(claudeDir, 'skills'));
      expect(skillsSymlinks).toContain('@user-pkg-a-skill-a');
      expect(skillsSymlinks).toContain('@user-pkg-b-skill-b');

      // Run exclusive for pkg-a
      const result = await createSymlinks({
        projectRoot: tmpDir,
        packages: ['@user/pkg-a'],
        renderedFiles: [
          {
            pkgName: '@user/pkg-a',
            source: path.join(pkgASkillDir, 'SKILL.md'),
            tool: 'claude' as const,
            isMcpConfig: false,
          },
        ],
        activeTool: 'claude',
        exclusive: true,
      });

      // pkg-b's skill symlink should be removed
      expect(result.removed).toHaveLength(1);
      expect(result.removed[0]).toContain('@user-pkg-b-skill-b');

      // Verify only pkg-a's skill symlink remains
      skillsSymlinks = await fs.readdir(path.join(claudeDir, 'skills'));
      expect(skillsSymlinks).toContain('@user-pkg-a-skill-a');
      expect(skillsSymlinks).not.toContain('@user-pkg-b-skill-b');
    });
  });

  describe('symlink recreation', () => {
    it('should recreate symlink if deleted from disk but registry entry exists', async () => {
      // 1. Setup package with agent file
      const pkgRoot = path.join(agentModulesDir, '@user', 'pkg');
      const agentsDir = path.join(pkgRoot, 'claude', 'agents');
      await fs.mkdir(agentsDir, { recursive: true });
      await fs.writeFile(path.join(agentsDir, 'agent.md'), '# Agent');

      const renderedFiles = [
        {
          pkgName: '@user/pkg',
          source: path.join(agentsDir, 'agent.md'),
          tool: 'claude' as const,
          isMcpConfig: false,
        },
      ];

      // 2. Create symlink initially
      const result1 = await createSymlinks({
        projectRoot: tmpDir,
        packages: ['@user/pkg'],
        renderedFiles,
      });
      expect(result1.created).toHaveLength(1);

      // 3. Delete the symlink from disk (simulating manual deletion)
      const symlinkPath = path.join(claudeDir, 'agents', '@user-pkg-agent.md');
      await fs.rm(symlinkPath);

      // 4. Verify symlink is gone
      const existsBeforeRecreate = await fs
        .access(symlinkPath)
        .then(() => true)
        .catch(() => false);
      expect(existsBeforeRecreate).toBe(false);

      // 5. Run createSymlinks again - should recreate
      const result2 = await createSymlinks({
        projectRoot: tmpDir,
        packages: ['@user/pkg'],
        renderedFiles,
      });

      // 6. Verify symlink was recreated (not skipped)
      expect(result2.created).toHaveLength(1);
      expect(result2.skipped).toHaveLength(0);

      // 7. Verify symlink exists on disk
      const existsAfterRecreate = await fs
        .access(symlinkPath)
        .then(() => true)
        .catch(() => false);
      expect(existsAfterRecreate).toBe(true);
    });
  });

  describe('removeSymlinks', () => {
    it('should remove symlinks for a specific package', async () => {
      const pkgRoot = path.join(agentModulesDir, '@user', 'pkg');
      const agentsDir = path.join(pkgRoot, 'claude', 'agents');
      await fs.mkdir(agentsDir, { recursive: true });

      await fs.writeFile(path.join(agentsDir, 'agent.md'), '# Agent');

      const renderedFiles = [
        {
          pkgName: '@user/pkg',
          source: path.join(agentsDir, 'agent.md'),
          tool: 'claude' as const,
          isMcpConfig: false,
        },
      ];

      // Create symlink
      await createSymlinks({
        projectRoot: tmpDir,
        packages: ['@user/pkg'],
        renderedFiles,
      });

      // Remove symlinks
      const result = await removeSymlinks(tmpDir, '@user/pkg');

      expect(result.removed).toHaveLength(1);
      expect(result.errors).toHaveLength(0);

      // Verify symlink is gone
      const agentsDir_claude = path.join(claudeDir, 'agents');
      const exists = await fs
        .access(path.join(agentsDir_claude, '@user-pkg-agent.md'))
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(false);
    });
  });

  describe('codex tool support', () => {
    let codexDir: string;

    beforeEach(async () => {
      codexDir = path.join(tmpDir, '.codex');
      await fs.mkdir(codexDir, { recursive: true });
    });

    it('should create skill symlinks in .codex/skills for codex tool', async () => {
      const pkgRoot = path.join(agentModulesDir, '@user', 'qa-engineer');
      const skillDir = path.join(pkgRoot, 'codex', 'skills', 'api-validation');
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(path.join(skillDir, 'SKILL.md'), '# API Validation');

      const renderedFiles = [
        {
          pkgName: '@user/qa-engineer',
          source: path.join(skillDir, 'SKILL.md'),
          tool: 'codex' as const,
          isMcpConfig: false,
        },
      ];

      const result = await createSymlinks({
        projectRoot: tmpDir,
        packages: ['@user/qa-engineer'],
        renderedFiles,
      });

      expect(result.created).toHaveLength(1);

      // Verify symlink is in .codex/skills/, not .claude/skills/
      const codexSkillsDir = path.join(codexDir, 'skills');
      const codexSymlinks = await fs.readdir(codexSkillsDir);
      expect(codexSymlinks).toContain('@user-qa-engineer-api-validation');

      // Verify .claude/skills/ was NOT created
      const claudeSkillsDir = path.join(tmpDir, '.claude', 'skills');
      const claudeSkillsExists = await fs
        .access(claudeSkillsDir)
        .then(() => true)
        .catch(() => false);
      expect(claudeSkillsExists).toBe(false);
    });

    it('should NOT create agent/command symlinks for codex tool (only skills supported)', async () => {
      const pkgRoot = path.join(agentModulesDir, '@user', 'qa-engineer');
      const agentsDir = path.join(pkgRoot, 'codex', 'agents');
      const commandsDir = path.join(pkgRoot, 'codex', 'commands');
      const skillsDir = path.join(pkgRoot, 'codex', 'skills', 'test-skill');

      await fs.mkdir(agentsDir, { recursive: true });
      await fs.mkdir(commandsDir, { recursive: true });
      await fs.mkdir(skillsDir, { recursive: true });

      await fs.writeFile(path.join(agentsDir, 'agent.md'), '# Agent');
      await fs.writeFile(path.join(commandsDir, 'cmd.md'), '# Command');
      await fs.writeFile(path.join(skillsDir, 'SKILL.md'), '# Skill');

      const renderedFiles = [
        {
          pkgName: '@user/qa-engineer',
          source: path.join(agentsDir, 'agent.md'),
          tool: 'codex' as const,
          isMcpConfig: false,
        },
        {
          pkgName: '@user/qa-engineer',
          source: path.join(commandsDir, 'cmd.md'),
          tool: 'codex' as const,
          isMcpConfig: false,
        },
        {
          pkgName: '@user/qa-engineer',
          source: path.join(skillsDir, 'SKILL.md'),
          tool: 'codex' as const,
          isMcpConfig: false,
        },
      ];

      const result = await createSymlinks({
        projectRoot: tmpDir,
        packages: ['@user/qa-engineer'],
        renderedFiles,
      });

      // Only skill should be symlinked (codex only supports skills)
      expect(result.created).toHaveLength(1);

      // Verify only skills directory exists in .codex/
      const codexSkillsExists = await fs
        .access(path.join(codexDir, 'skills'))
        .then(() => true)
        .catch(() => false);
      const codexAgentsExists = await fs
        .access(path.join(codexDir, 'agents'))
        .then(() => true)
        .catch(() => false);
      const codexCommandsExists = await fs
        .access(path.join(codexDir, 'commands'))
        .then(() => true)
        .catch(() => false);

      expect(codexSkillsExists).toBe(true);
      expect(codexAgentsExists).toBe(false);
      expect(codexCommandsExists).toBe(false);
    });

    it('should create multiple skill directory symlinks for codex packages', async () => {
      const pkgRoot = path.join(agentModulesDir, '@user', 'qa-engineer');
      const skillsBase = path.join(pkgRoot, 'codex', 'skills');

      const skill1 = path.join(skillsBase, 'api-validation');
      const skill2 = path.join(skillsBase, 'e2e-test');
      const skill3 = path.join(skillsBase, 'regression-test');

      await fs.mkdir(skill1, { recursive: true });
      await fs.mkdir(skill2, { recursive: true });
      await fs.mkdir(skill3, { recursive: true });

      await fs.writeFile(path.join(skill1, 'SKILL.md'), '# API Validation');
      await fs.writeFile(path.join(skill2, 'SKILL.md'), '# E2E Test');
      await fs.writeFile(path.join(skill3, 'SKILL.md'), '# Regression Test');

      const renderedFiles = [
        {
          pkgName: '@user/qa-engineer',
          source: path.join(skill1, 'SKILL.md'),
          tool: 'codex' as const,
          isMcpConfig: false,
        },
        {
          pkgName: '@user/qa-engineer',
          source: path.join(skill2, 'SKILL.md'),
          tool: 'codex' as const,
          isMcpConfig: false,
        },
        {
          pkgName: '@user/qa-engineer',
          source: path.join(skill3, 'SKILL.md'),
          tool: 'codex' as const,
          isMcpConfig: false,
        },
      ];

      const result = await createSymlinks({
        projectRoot: tmpDir,
        packages: ['@user/qa-engineer'],
        renderedFiles,
      });

      expect(result.created).toHaveLength(3);

      const skillsSymlinks = await fs.readdir(path.join(codexDir, 'skills'));
      expect(skillsSymlinks).toContain('@user-qa-engineer-api-validation');
      expect(skillsSymlinks).toContain('@user-qa-engineer-e2e-test');
      expect(skillsSymlinks).toContain('@user-qa-engineer-regression-test');
    });

    it('should track codex symlinks in registry with correct tool type', async () => {
      const pkgRoot = path.join(agentModulesDir, '@user', 'pkg');
      const skillDir = path.join(pkgRoot, 'codex', 'skills', 'my-skill');
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(path.join(skillDir, 'SKILL.md'), '# Skill');

      const renderedFiles = [
        {
          pkgName: '@user/pkg',
          source: path.join(skillDir, 'SKILL.md'),
          tool: 'codex' as const,
          isMcpConfig: false,
        },
      ];

      await createSymlinks({
        projectRoot: tmpDir,
        packages: ['@user/pkg'],
        renderedFiles,
      });

      const registryPath = path.join(tmpDir, '.terrazul', 'symlinks.json');
      const registryContent = await fs.readFile(registryPath, 'utf8');
      const registry = JSON.parse(registryContent);

      // Registry key should be .codex/skills/..., not .claude/skills/...
      const symlinkKey = '.codex/skills/@user-pkg-my-skill';
      expect(registry.symlinks[symlinkKey]).toBeDefined();
      expect(registry.symlinks[symlinkKey].tool).toBe('codex');
    });
  });

  describe('multi-tool isolation', () => {
    it('should keep claude and codex symlinks separate', async () => {
      // Setup both .claude and .codex directories
      const codexDir = path.join(tmpDir, '.codex');
      await fs.mkdir(codexDir, { recursive: true });

      const pkgRoot = path.join(agentModulesDir, '@user', 'multi-tool');

      // Create skills for both tools
      const claudeSkillDir = path.join(pkgRoot, 'claude', 'skills', 'claude-skill');
      const codexSkillDir = path.join(pkgRoot, 'codex', 'skills', 'codex-skill');
      await fs.mkdir(claudeSkillDir, { recursive: true });
      await fs.mkdir(codexSkillDir, { recursive: true });

      await fs.writeFile(path.join(claudeSkillDir, 'SKILL.md'), '# Claude Skill');
      await fs.writeFile(path.join(codexSkillDir, 'SKILL.md'), '# Codex Skill');

      // Create symlinks for claude tool
      const claudeFiles = [
        {
          pkgName: '@user/multi-tool',
          source: path.join(claudeSkillDir, 'SKILL.md'),
          tool: 'claude' as const,
          isMcpConfig: false,
        },
      ];

      const claudeResult = await createSymlinks({
        projectRoot: tmpDir,
        packages: ['@user/multi-tool'],
        renderedFiles: claudeFiles,
      });

      // Create symlinks for codex tool
      const codexFiles = [
        {
          pkgName: '@user/multi-tool',
          source: path.join(codexSkillDir, 'SKILL.md'),
          tool: 'codex' as const,
          isMcpConfig: false,
        },
      ];

      const codexResult = await createSymlinks({
        projectRoot: tmpDir,
        packages: ['@user/multi-tool'],
        renderedFiles: codexFiles,
      });

      // Verify both created their respective symlinks
      expect(claudeResult.created).toHaveLength(1);
      expect(codexResult.created).toHaveLength(1);

      // Verify symlinks are in correct directories
      const claudeSkills = await fs.readdir(path.join(claudeDir, 'skills'));
      const codexSkills = await fs.readdir(path.join(codexDir, 'skills'));

      expect(claudeSkills).toContain('@user-multi-tool-claude-skill');
      expect(claudeSkills).not.toContain('@user-multi-tool-codex-skill');

      expect(codexSkills).toContain('@user-multi-tool-codex-skill');
      expect(codexSkills).not.toContain('@user-multi-tool-claude-skill');
    });
  });
});
