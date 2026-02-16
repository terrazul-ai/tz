import os from 'node:os';
import path from 'node:path';

import { describe, it, expect } from 'vitest';

import {
  sanitizeSettingsJson,
  sanitizeMcpServers,
  sanitizeText,
  rewritePath,
} from '../../../src/core/extract/sanitize';

describe('sanitize utilities', () => {
  const projectRoot = path.join(os.homedir(), 'projects', 'demo');

  describe('sanitizeSettingsJson', () => {
    it('sanitizes env and risky fields in settings.json', () => {
      const settings = {
        env: { ANTHROPIC_API_KEY: 'secret', FOO: 'bar' },
        apiKeyHelper: 'node helpers/key.js',
        permissions: { additionalDirectories: [path.join(projectRoot, 'docs'), '/var/tmp'] },
      };
      const out = sanitizeSettingsJson(settings, projectRoot) as {
        env: Record<string, string>;
        apiKeyHelper?: string;
        permissions: { additionalDirectories: string[] };
      };
      expect(out.env['ANTHROPIC_API_KEY']).toBe('{{ env.ANTHROPIC_API_KEY }}');
      expect(out.env['FOO']).toBe('{{ env.FOO }}');
      expect(out.apiKeyHelper).toBe('{{ replace_me }}');
      expect(out.permissions.additionalDirectories[0]).toContain('{{ PROJECT_ROOT }}');
      expect(out.permissions.additionalDirectories[1]).toBe('{{ replace_me }}');
    });

    it('replaces additional risky helper fields', () => {
      const raw = {
        apiKeyHelper: 'scripts/key.js',
        awsAuthRefresh: 'scripts/aws-refresh.sh',
        awsCredentialExport: 'scripts/aws-export.sh',
      };
      const out = sanitizeSettingsJson(raw, projectRoot) as Record<string, unknown>;
      expect(out.apiKeyHelper as string).toBe('{{ replace_me }}');
      expect(out.awsAuthRefresh as string).toBe('{{ replace_me }}');
      expect(out.awsCredentialExport as string).toBe('{{ replace_me }}');
    });

    it('sanitizes env block templates', () => {
      const raw = { env: { A: 'a', B: 'b' } };
      const out = sanitizeSettingsJson(raw, projectRoot) as {
        env: Record<string, string>;
      };
      expect(out.env.A).toBe('{{ env.A }}');
      expect(out.env.B).toBe('{{ env.B }}');
    });

    it('sanitizes UNC and forward-slash Windows paths in additionalDirectories', () => {
      const raw = {
        permissions: {
          additionalDirectories: [
            String.raw`\\server\share\docs`,
            'C:/Temp',
            path.join(projectRoot, 'docs'),
          ],
        },
      };
      const out = sanitizeSettingsJson(raw, projectRoot) as {
        permissions: { additionalDirectories: string[] };
      };
      const dirs = out.permissions.additionalDirectories;
      expect(dirs[0]).toBe('{{ replace_me }}');
      expect(dirs[1]).toBe('{{ replace_me }}');
      expect(dirs[2]).toContain('{{ PROJECT_ROOT }}');
    });
  });

  describe('sanitizeMcpServers', () => {
    it('rewrites absolute paths in mcp servers', () => {
      const servers = {
        foo: { command: '/usr/bin/foo', args: ['--data', path.join(projectRoot, 'data')] },
      };
      const out = sanitizeMcpServers(servers, projectRoot) as {
        foo: { command: string; args: string[] };
      };
      expect(out.foo.command).toBe('{{ replace_me }}');
      expect(out.foo.args[1]).toContain('{{ PROJECT_ROOT }}');
    });
  });

  describe('rewritePath', () => {
    it('handles windows and posix styles', () => {
      const p = rewritePath(String.raw`C:\\tmp\\foo`, projectRoot);
      expect(p).toBe('{{ replace_me }}');
    });
  });

  describe('sanitizeText', () => {
    it('sanitizes text by replacing project and home paths', () => {
      const raw = `See ${projectRoot}/README.md and ${os.homedir()}/.config`;
      const out = sanitizeText(raw, projectRoot);
      expect(out).toContain('{{ PROJECT_ROOT }}/README.md');
      expect(out).toContain('{{ HOME }}/.config');
    });

    describe('URL and path heuristics', () => {
      it('does not replace protocol-relative (//) paths and masks absolute paths', () => {
        const raw = `link https://example.com/a/b and //cdn.example.com/x but path /var/tmp should be masked`;
        const out = sanitizeText(raw, projectRoot);
        expect(out).toContain('//cdn.example.com/x');
        expect(out).toContain('{{ replace_me }}');
      });

      it('masks UNC forward-slash form (//server/share)', () => {
        const raw = 'see //server/share/docs and https://example.com okay';
        const out = sanitizeText(raw, projectRoot);
        expect(out).toContain('{{ replace_me }}');
        expect(out).toContain('https://example.com');
      });

      it('does not alter placeholders already present', () => {
        const raw = 'See {{ PROJECT_ROOT }}/README and {{ HOME }}/dotfiles';
        const out = sanitizeText(raw, projectRoot);
        expect(out).toContain('{{ PROJECT_ROOT }}/README');
        expect(out).toContain('{{ HOME }}/dotfiles');
      });

      it('replaces Windows absolute paths with replace_me', () => {
        const raw = String.raw`cmd C:\Tools\bin\tool.exe run`;
        const out = sanitizeText(raw, projectRoot);
        expect(out).toContain('{{ replace_me }}');
      });

      it('leaves relative paths untouched', () => {
        const raw = 'relative ./foo/bar and nested docs/readme.md';
        const out = sanitizeText(raw, projectRoot);
        expect(out).toContain('./foo/bar');
        expect(out).toContain('docs/readme.md');
      });
    });

    describe('punctuation edges', () => {
      it('does not mask POSIX path when followed by punctuation (current heuristic)', () => {
        const raw = 'see (/var/tmp).';
        const out = sanitizeText(raw, projectRoot);
        expect(out).toContain('(/var/tmp).');
      });

      it('masks POSIX paths at word boundary and with trailing comma', () => {
        const raw = 'first /var/tmp, then /var/tmp';
        const out = sanitizeText(raw, projectRoot);
        const maskedCount = (out.match(/{{ replace_me }}/g) || []).length;
        expect(maskedCount).toBeGreaterThanOrEqual(2);
      });

      it('keeps quoted POSIX path as-is; masks quoted Windows absolute path', () => {
        const raw = String.raw`posix "/var/tmp" and windows "C:\Tools\bin\tool.exe"`;
        const out = sanitizeText(raw, projectRoot);
        expect(out).toContain('"/var/tmp"');
        expect(out).toContain('"{{ replace_me }}"');
      });

      it('preserves protocol-relative URL with trailing punctuation', () => {
        const raw = 'see //cdn.example.com/x.';
        const out = sanitizeText(raw, projectRoot);
        expect(out).toContain('//cdn.example.com/x.');
      });
    });
  });
});
