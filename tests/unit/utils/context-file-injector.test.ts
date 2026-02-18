import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  injectPackageContext,
  removePackageContext,
  hasPackageContext,
  type PackageInfo,
} from '../../../src/utils/context-file-injector';

async function mkdtemp(prefix: string): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
}

async function write(file: string, data: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, data, 'utf8');
}

describe('utils/context-file-injector', () => {
  let projectRoot = '';

  beforeEach(async () => {
    projectRoot = await mkdtemp('tz-injector');
  });

  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true }).catch(() => {});
  });

  describe('injectPackageContext', () => {
    it('injects package context into new file', async () => {
      const filePath = path.join(projectRoot, 'CLAUDE.md');
      const packageFiles = new Map([
        ['@test/pkg1', [path.join(projectRoot, 'agent_modules/@test/pkg1/CLAUDE.md')]],
      ]);
      const packages: PackageInfo[] = [
        {
          name: '@test/pkg1',
          version: '1.0.0',
          root: path.join(projectRoot, 'agent_modules/@test/pkg1'),
        },
      ];

      const result = await injectPackageContext(filePath, projectRoot, packageFiles, packages);

      expect(result.modified).toBe(true);
      const content = await fs.readFile(filePath, 'utf8');
      expect(content).toContain('<!-- terrazul:begin -->');
      expect(content).toContain('@agent_modules/@test/pkg1/CLAUDE.md');
      expect(content).toContain('<!-- terrazul:end -->');
    });

    it('injects package context at beginning of existing file', async () => {
      const filePath = path.join(projectRoot, 'CLAUDE.md');
      await write(filePath, '# Existing Content\n\nSome text here.');

      const packageFiles = new Map([
        ['@test/pkg1', [path.join(projectRoot, 'agent_modules/@test/pkg1/CLAUDE.md')]],
      ]);
      const packages: PackageInfo[] = [
        {
          name: '@test/pkg1',
          version: '1.0.0',
          root: path.join(projectRoot, 'agent_modules/@test/pkg1'),
        },
      ];

      const result = await injectPackageContext(filePath, projectRoot, packageFiles, packages);

      expect(result.modified).toBe(true);
      const content = await fs.readFile(filePath, 'utf8');
      expect(content).toContain('# Existing Content');
      expect(content).toContain('@agent_modules/@test/pkg1/CLAUDE.md');

      // Verify context block is at the BEGINNING
      expect(content.startsWith('<!-- terrazul:begin -->')).toBe(true);

      // Verify existing content comes AFTER the context block
      const beginIndex = content.indexOf('<!-- terrazul:begin -->');
      const endIndex = content.indexOf('<!-- terrazul:end -->');
      const existingIndex = content.indexOf('# Existing Content');
      expect(beginIndex).toBeLessThan(existingIndex);
      expect(endIndex).toBeLessThan(existingIndex);
    });

    it('is idempotent - does not modify if already injected', async () => {
      const filePath = path.join(projectRoot, 'CLAUDE.md');
      const packageFiles = new Map([
        ['@test/pkg1', [path.join(projectRoot, 'agent_modules/@test/pkg1/CLAUDE.md')]],
      ]);
      const packages: PackageInfo[] = [
        {
          name: '@test/pkg1',
          version: '1.0.0',
          root: path.join(projectRoot, 'agent_modules/@test/pkg1'),
        },
      ];

      // First injection
      const result1 = await injectPackageContext(filePath, projectRoot, packageFiles, packages);
      expect(result1.modified).toBe(true);
      const content1 = await fs.readFile(filePath, 'utf8');

      // Second injection with same data
      const result2 = await injectPackageContext(filePath, projectRoot, packageFiles, packages);
      expect(result2.modified).toBe(false);
      const content2 = await fs.readFile(filePath, 'utf8');

      expect(content1).toBe(content2);
    });

    it('filters out non-context files (agents/, commands/, MCP configs)', async () => {
      const filePath = path.join(projectRoot, 'CLAUDE.md');
      const packageFiles = new Map([
        [
          '@test/pkg1',
          [
            path.join(projectRoot, 'agent_modules/@test/pkg1/CLAUDE.md'),
            path.join(projectRoot, 'agent_modules/@test/pkg1/agents/foo.md'),
            path.join(projectRoot, 'agent_modules/@test/pkg1/commands/bar.md'),
            path.join(projectRoot, 'agent_modules/@test/pkg1/mcp-config.json'),
          ],
        ],
      ]);
      const packages: PackageInfo[] = [
        {
          name: '@test/pkg1',
          version: '1.0.0',
          root: path.join(projectRoot, 'agent_modules/@test/pkg1'),
        },
      ];

      const result = await injectPackageContext(filePath, projectRoot, packageFiles, packages);

      expect(result.modified).toBe(true);
      const content = await fs.readFile(filePath, 'utf8');

      // Should include CLAUDE.md
      expect(content).toContain('@agent_modules/@test/pkg1/CLAUDE.md');

      // Should NOT include other files
      expect(content).not.toContain('agents/foo.md');
      expect(content).not.toContain('commands/bar.md');
      expect(content).not.toContain('mcp-config.json');
    });

    it('supports dry run mode', async () => {
      const filePath = path.join(projectRoot, 'CLAUDE.md');
      const packageFiles = new Map([
        ['@test/pkg1', [path.join(projectRoot, 'agent_modules/@test/pkg1/CLAUDE.md')]],
      ]);
      const packages: PackageInfo[] = [
        {
          name: '@test/pkg1',
          version: '1.0.0',
          root: path.join(projectRoot, 'agent_modules/@test/pkg1'),
        },
      ];

      const result = await injectPackageContext(filePath, projectRoot, packageFiles, packages, {
        dryRun: true,
      });

      expect(result.modified).toBe(true);
      expect(result.content).toBeDefined();
      expect(result.content).toContain('@agent_modules/@test/pkg1/CLAUDE.md');

      // File should not exist (dry run)
      const exists = await fs
        .access(filePath)
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(false);
    });

    it('does not overwrite previous packages when injecting a subset', async () => {
      const filePath = path.join(projectRoot, 'CLAUDE.md');

      // First: inject both packages (simulating initial install state)
      const allPackageFiles = new Map([
        ['@test/pkg1', [path.join(projectRoot, 'agent_modules/@test/pkg1/CLAUDE.md')]],
        ['@test/pkg2', [path.join(projectRoot, 'agent_modules/@test/pkg2/CLAUDE.md')]],
      ]);
      const allPackages: PackageInfo[] = [
        {
          name: '@test/pkg1',
          version: '1.0.0',
          root: path.join(projectRoot, 'agent_modules/@test/pkg1'),
        },
        {
          name: '@test/pkg2',
          version: '1.0.0',
          root: path.join(projectRoot, 'agent_modules/@test/pkg2'),
        },
      ];

      await injectPackageContext(filePath, projectRoot, allPackageFiles, allPackages);
      const contentAfterBoth = await fs.readFile(filePath, 'utf8');
      expect(contentAfterBoth).toContain('@agent_modules/@test/pkg1/CLAUDE.md');
      expect(contentAfterBoth).toContain('@agent_modules/@test/pkg2/CLAUDE.md');

      // Second: re-inject with ALL packages again (the fix — commands should
      // always pass the full set, not just the newly-added package)
      const result = await injectPackageContext(
        filePath,
        projectRoot,
        allPackageFiles,
        allPackages,
      );

      // Should be idempotent — no changes
      expect(result.modified).toBe(false);

      const finalContent = await fs.readFile(filePath, 'utf8');
      expect(finalContent).toContain('@agent_modules/@test/pkg1/CLAUDE.md');
      expect(finalContent).toContain('@agent_modules/@test/pkg2/CLAUDE.md');
    });

    it('overwrites previous packages when injecting only a subset (the bug scenario)', async () => {
      const filePath = path.join(projectRoot, 'CLAUDE.md');

      // First: inject both packages
      const allPackageFiles = new Map([
        ['@test/pkg1', [path.join(projectRoot, 'agent_modules/@test/pkg1/CLAUDE.md')]],
        ['@test/pkg2', [path.join(projectRoot, 'agent_modules/@test/pkg2/CLAUDE.md')]],
      ]);
      const allPackages: PackageInfo[] = [
        {
          name: '@test/pkg1',
          version: '1.0.0',
          root: path.join(projectRoot, 'agent_modules/@test/pkg1'),
        },
        {
          name: '@test/pkg2',
          version: '1.0.0',
          root: path.join(projectRoot, 'agent_modules/@test/pkg2'),
        },
      ];

      await injectPackageContext(filePath, projectRoot, allPackageFiles, allPackages);

      // Second: inject only pkg2 (simulates what the old buggy code did)
      const subsetFiles = new Map([
        ['@test/pkg2', [path.join(projectRoot, 'agent_modules/@test/pkg2/CLAUDE.md')]],
      ]);
      const subsetPackages: PackageInfo[] = [
        {
          name: '@test/pkg2',
          version: '1.0.0',
          root: path.join(projectRoot, 'agent_modules/@test/pkg2'),
        },
      ];

      await injectPackageContext(filePath, projectRoot, subsetFiles, subsetPackages);

      const content = await fs.readFile(filePath, 'utf8');
      // With a subset, pkg1 is lost — this demonstrates the bug that the
      // command-level fix prevents by always passing the full set
      expect(content).not.toContain('@agent_modules/@test/pkg1/CLAUDE.md');
      expect(content).toContain('@agent_modules/@test/pkg2/CLAUDE.md');
    });

    it('handles multiple packages sorted alphabetically', async () => {
      const filePath = path.join(projectRoot, 'CLAUDE.md');
      const packageFiles = new Map([
        ['@test/zebra', [path.join(projectRoot, 'agent_modules/@test/zebra/CLAUDE.md')]],
        ['@test/apple', [path.join(projectRoot, 'agent_modules/@test/apple/CLAUDE.md')]],
        ['@test/middle', [path.join(projectRoot, 'agent_modules/@test/middle/CLAUDE.md')]],
      ]);
      const packages: PackageInfo[] = [
        {
          name: '@test/zebra',
          version: '1.0.0',
          root: path.join(projectRoot, 'agent_modules/@test/zebra'),
        },
        {
          name: '@test/apple',
          version: '1.0.0',
          root: path.join(projectRoot, 'agent_modules/@test/apple'),
        },
        {
          name: '@test/middle',
          version: '1.0.0',
          root: path.join(projectRoot, 'agent_modules/@test/middle'),
        },
      ];

      const result = await injectPackageContext(filePath, projectRoot, packageFiles, packages);

      expect(result.modified).toBe(true);
      const content = await fs.readFile(filePath, 'utf8');

      // Check order (should be alphabetical)
      const appleIndex = content.indexOf('@agent_modules/@test/apple/CLAUDE.md');
      const middleIndex = content.indexOf('@agent_modules/@test/middle/CLAUDE.md');
      const zebraIndex = content.indexOf('@agent_modules/@test/zebra/CLAUDE.md');

      expect(appleIndex).toBeLessThan(middleIndex);
      expect(middleIndex).toBeLessThan(zebraIndex);
    });
  });

  describe('removePackageContext', () => {
    it('removes package context from file', async () => {
      const filePath = path.join(projectRoot, 'CLAUDE.md');
      const packageFiles = new Map([
        ['@test/pkg1', [path.join(projectRoot, 'agent_modules/@test/pkg1/CLAUDE.md')]],
      ]);
      const packages: PackageInfo[] = [
        {
          name: '@test/pkg1',
          version: '1.0.0',
          root: path.join(projectRoot, 'agent_modules/@test/pkg1'),
        },
      ];

      await injectPackageContext(filePath, projectRoot, packageFiles, packages);

      const result = await removePackageContext(filePath);

      expect(result.modified).toBe(true);
      const content = await fs.readFile(filePath, 'utf8');
      expect(content).not.toContain('<!-- terrazul:begin -->');
      expect(content).not.toContain('@agent_modules/@test/pkg1/CLAUDE.md');
    });

    it('preserves existing content when removing context', async () => {
      const filePath = path.join(projectRoot, 'CLAUDE.md');
      await write(filePath, '# Existing Content\n\nSome text here.');

      const packageFiles = new Map([
        ['@test/pkg1', [path.join(projectRoot, 'agent_modules/@test/pkg1/CLAUDE.md')]],
      ]);
      const packages: PackageInfo[] = [
        {
          name: '@test/pkg1',
          version: '1.0.0',
          root: path.join(projectRoot, 'agent_modules/@test/pkg1'),
        },
      ];

      await injectPackageContext(filePath, projectRoot, packageFiles, packages);

      const result = await removePackageContext(filePath);

      expect(result.modified).toBe(true);
      const content = await fs.readFile(filePath, 'utf8');
      expect(content).toContain('# Existing Content');
      expect(content).toContain('Some text here');
      expect(content).not.toContain('terrazul:begin');
    });

    it('returns false if no context block is present', async () => {
      const filePath = path.join(projectRoot, 'CLAUDE.md');
      await write(filePath, '# Content without terrazul block');

      const result = await removePackageContext(filePath);

      expect(result.modified).toBe(false);
    });
  });

  describe('hasPackageContext', () => {
    it('returns true if context is present', async () => {
      const filePath = path.join(projectRoot, 'CLAUDE.md');
      const packageFiles = new Map([
        ['@test/pkg1', [path.join(projectRoot, 'agent_modules/@test/pkg1/CLAUDE.md')]],
      ]);
      const packages: PackageInfo[] = [
        {
          name: '@test/pkg1',
          version: '1.0.0',
          root: path.join(projectRoot, 'agent_modules/@test/pkg1'),
        },
      ];

      await injectPackageContext(filePath, projectRoot, packageFiles, packages);

      const result = await hasPackageContext(filePath);

      expect(result).toBe(true);
    });

    it('returns false if context is not present', async () => {
      const filePath = path.join(projectRoot, 'CLAUDE.md');
      await write(filePath, '# Content without terrazul block');

      const result = await hasPackageContext(filePath);

      expect(result).toBe(false);
    });

    it('returns false if file does not exist', async () => {
      const filePath = path.join(projectRoot, 'NONEXISTENT.md');

      const result = await hasPackageContext(filePath);

      expect(result).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('handles empty package files map', async () => {
      const filePath = path.join(projectRoot, 'CLAUDE.md');
      const packageFiles = new Map<string, string[]>();
      const packages: PackageInfo[] = [];

      const result = await injectPackageContext(filePath, projectRoot, packageFiles, packages);

      expect(result.modified).toBe(true);
      const content = await fs.readFile(filePath, 'utf8');
      expect(content).toContain('<!-- terrazul:begin -->');
      expect(content).toContain('<!-- terrazul:end -->');
      // Should have no @-mentions
      expect(content).not.toContain('@agent_modules');
    });

    it('handles package with no CLAUDE.md/AGENTS.md files', async () => {
      const filePath = path.join(projectRoot, 'CLAUDE.md');
      const packageFiles = new Map([
        [
          '@test/pkg1',
          [
            // Only non-context files
            path.join(projectRoot, 'agent_modules/@test/pkg1/agents/foo.md'),
            path.join(projectRoot, 'agent_modules/@test/pkg1/commands/bar.md'),
          ],
        ],
      ]);
      const packages: PackageInfo[] = [
        {
          name: '@test/pkg1',
          version: '1.0.0',
          root: path.join(projectRoot, 'agent_modules/@test/pkg1'),
        },
      ];

      const result = await injectPackageContext(filePath, projectRoot, packageFiles, packages);

      expect(result.modified).toBe(true);
      const content = await fs.readFile(filePath, 'utf8');
      // Should have markers but no @-mentions
      expect(content).toContain('<!-- terrazul:begin -->');
      expect(content).not.toContain('@agent_modules/@test/pkg1');
    });

    it('ignores markers embedded in documentation (not at file start)', async () => {
      const filePath = path.join(projectRoot, 'CLAUDE.md');
      // Create file with markers in documentation, not at the start
      const docContent = `# My Documentation

This is some documentation about context injection.

**Context Injection**:
- Uses HTML comment markers (\`<!-- terrazul:begin -->
<!-- Terrazul package context - auto-managed, do not edit -->
@agent_modules/@old/pkg/CLAUDE.md
<!-- terrazul:end -->\`) for idempotent injection

## More Content

Some more documentation here.`;
      await write(filePath, docContent);

      const packageFiles = new Map([
        ['@test/pkg1', [path.join(projectRoot, 'agent_modules/@test/pkg1/CLAUDE.md')]],
      ]);
      const packages: PackageInfo[] = [
        {
          name: '@test/pkg1',
          version: '1.0.0',
          root: path.join(projectRoot, 'agent_modules/@test/pkg1'),
        },
      ];

      const result = await injectPackageContext(filePath, projectRoot, packageFiles, packages);

      expect(result.modified).toBe(true);
      const content = await fs.readFile(filePath, 'utf8');

      // Should inject at the START of the file
      expect(content.startsWith('<!-- terrazul:begin -->')).toBe(true);

      // Should have our new package reference at the top
      const firstBeginIndex = content.indexOf('<!-- terrazul:begin -->');
      const firstEndIndex = content.indexOf('<!-- terrazul:end -->');
      const newPkgIndex = content.indexOf('@agent_modules/@test/pkg1/CLAUDE.md');

      expect(firstBeginIndex).toBe(0);
      expect(newPkgIndex).toBeGreaterThan(firstBeginIndex);
      expect(newPkgIndex).toBeLessThan(firstEndIndex);

      // Should preserve the documentation markers (they appear later in file)
      expect(content).toContain('Uses HTML comment markers');
      expect(content).toContain('@agent_modules/@old/pkg/CLAUDE.md');

      // The old example markers should be AFTER our injected block
      const docMarkersIndex = content.indexOf('Uses HTML comment markers');
      expect(docMarkersIndex).toBeGreaterThan(firstEndIndex);
    });

    it('hasPackageContext returns false when markers are not at file start', async () => {
      const filePath = path.join(projectRoot, 'CLAUDE.md');
      // Markers in middle of file, not at start
      const docContent = `# Documentation

Some docs here.

<!-- terrazul:begin -->
<!-- Terrazul package context - auto-managed, do not edit -->
@agent_modules/@old/pkg/CLAUDE.md
<!-- terrazul:end -->

More content.`;
      await write(filePath, docContent);

      const result = await hasPackageContext(filePath);

      // Should return false because markers are not at the start
      expect(result).toBe(false);
    });

    it('removePackageContext ignores markers not at file start', async () => {
      const filePath = path.join(projectRoot, 'CLAUDE.md');
      // Markers in middle of file, not at start
      const docContent = `# Documentation

Some docs here.

<!-- terrazul:begin -->
<!-- Terrazul package context - auto-managed, do not edit -->
@agent_modules/@old/pkg/CLAUDE.md
<!-- terrazul:end -->

More content.`;
      await write(filePath, docContent);

      const result = await removePackageContext(filePath);

      // Should return false - nothing to remove (markers not at start)
      expect(result.modified).toBe(false);

      // Content should be unchanged
      const content = await fs.readFile(filePath, 'utf8');
      expect(content).toBe(docContent);
    });
  });
});
