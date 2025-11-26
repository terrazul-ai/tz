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
          activeTool: 'claude',
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
          activeTool: 'claude',
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
          activeTool: 'claude',
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
          activeTool: 'claude',
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
          activeTool: 'claude',
        });

        // Only the agent file should be symlinked
        expect(result.created).toHaveLength(1);
        expect(result.skipped).toHaveLength(1);

        const agentsSymlinks = await fs.readdir(path.join(claudeDir, 'agents'));
        expect(agentsSymlinks).toContain('@terrazul-general-coder-agent.md');
      });
    });

    describe('tool filtering', () => {
      it('should only create symlinks for active tool files', async () => {
        const pkgRoot = path.join(agentModulesDir, '@user', 'multi-tool');
        const claudeAgentsDir = path.join(pkgRoot, 'claude', 'agents');
        const codexAgentsDir = path.join(pkgRoot, 'codex', 'agents');
        await fs.mkdir(claudeAgentsDir, { recursive: true });
        await fs.mkdir(codexAgentsDir, { recursive: true });

        await fs.writeFile(path.join(claudeAgentsDir, 'claude-agent.md'), '# Claude');
        await fs.writeFile(path.join(codexAgentsDir, 'codex-agent.md'), '# Codex');

        const renderedFiles = [
          {
            pkgName: '@user/multi-tool',
            source: path.join(claudeAgentsDir, 'claude-agent.md'),
            tool: 'claude' as const,
            isMcpConfig: false,
          },
          {
            pkgName: '@user/multi-tool',
            source: path.join(codexAgentsDir, 'codex-agent.md'),
            tool: 'codex' as const,
            isMcpConfig: false,
          },
        ];

        // Only create symlinks for Claude tool
        const result = await createSymlinks({
          projectRoot: tmpDir,
          packages: ['@user/multi-tool'],
          renderedFiles,
          activeTool: 'claude',
        });

        // Only Claude file should be symlinked
        expect(result.created).toHaveLength(1);

        const agentsSymlinks = await fs.readdir(path.join(claudeDir, 'agents'));
        expect(agentsSymlinks).toContain('@user-multi-tool-claude-agent.md');
        expect(agentsSymlinks).not.toContain('@user-multi-tool-codex-agent.md');
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
          activeTool: 'claude',
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
          activeTool: 'claude',
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
      it('should create symlinks for agents/, commands/, hooks/, skills/', async () => {
        const pkgRoot = path.join(agentModulesDir, '@user', 'pkg');
        const claudeSubdir = path.join(pkgRoot, 'claude');

        // Create all operational directories
        const agentsDir = path.join(claudeSubdir, 'agents');
        const commandsDir = path.join(claudeSubdir, 'commands');
        const hooksDir = path.join(claudeSubdir, 'hooks');
        const skillsDir = path.join(claudeSubdir, 'skills');

        await fs.mkdir(agentsDir, { recursive: true });
        await fs.mkdir(commandsDir, { recursive: true });
        await fs.mkdir(hooksDir, { recursive: true });
        await fs.mkdir(skillsDir, { recursive: true });

        await fs.writeFile(path.join(agentsDir, 'agent.md'), '# Agent');
        await fs.writeFile(path.join(commandsDir, 'cmd.md'), '# Command');
        await fs.writeFile(path.join(hooksDir, 'hook.md'), '# Hook');
        await fs.writeFile(path.join(skillsDir, 'skill.md'), '# Skill');

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
          {
            pkgName: '@user/pkg',
            source: path.join(hooksDir, 'hook.md'),
            tool: 'claude' as const,
            isMcpConfig: false,
          },
          {
            pkgName: '@user/pkg',
            source: path.join(skillsDir, 'skill.md'),
            tool: 'claude' as const,
            isMcpConfig: false,
          },
        ];

        const result = await createSymlinks({
          projectRoot: tmpDir,
          packages: ['@user/pkg'],
          renderedFiles,
          activeTool: 'claude',
        });

        expect(result.created).toHaveLength(4);

        // Verify symlinks in each directory
        const agentsSymlinks = await fs.readdir(path.join(claudeDir, 'agents'));
        const commandsSymlinks = await fs.readdir(path.join(claudeDir, 'commands'));
        const hooksSymlinks = await fs.readdir(path.join(claudeDir, 'hooks'));
        const skillsSymlinks = await fs.readdir(path.join(claudeDir, 'skills'));

        expect(agentsSymlinks).toContain('@user-pkg-agent.md');
        expect(commandsSymlinks).toContain('@user-pkg-cmd.md');
        expect(hooksSymlinks).toContain('@user-pkg-hook.md');
        expect(skillsSymlinks).toContain('@user-pkg-skill.md');
      });
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
        activeTool: 'claude',
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
        activeTool: 'claude',
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
        activeTool: 'claude',
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
});
