import { describe, expect, it } from 'vitest';

import {
  parseGeminiSettings,
  renderGeminiMcpServers,
  renderGeminiSettings,
} from '../../../../../src/core/extract/mcp/gemini-config.js';

describe('gemini-config', () => {
  describe('parseGeminiSettings', () => {
    it('returns empty servers for invalid JSON', () => {
      const result = parseGeminiSettings('not valid json', '/project', 'test.json');
      expect(result.servers).toEqual([]);
      expect(result.base).toBeNull();
    });

    it('returns empty servers for empty object', () => {
      const result = parseGeminiSettings('{}', '/project', 'test.json');
      expect(result.servers).toEqual([]);
      expect(result.base).toBeNull();
    });

    it('parses stdio transport MCP servers', () => {
      const json = JSON.stringify({
        mcpServers: {
          myServer: {
            command: 'node',
            args: ['server.js', '--port', '3000'],
            env: { NODE_ENV: 'production' },
          },
        },
      });

      const result = parseGeminiSettings(json, '/project', '.gemini/settings.json');

      expect(result.servers).toHaveLength(1);
      expect(result.servers[0].id).toBe('gemini:myServer');
      expect(result.servers[0].source).toBe('gemini');
      expect(result.servers[0].name).toBe('myServer');
      expect(result.servers[0].definition.command).toBe('node');
      expect(result.servers[0].definition.args).toEqual(['server.js', '--port', '3000']);
    });

    it('parses SSE transport MCP servers (url)', () => {
      const json = JSON.stringify({
        mcpServers: {
          sseServer: {
            url: 'http://localhost:3001/sse',
          },
        },
      });

      const result = parseGeminiSettings(json, '/project', 'test.json');

      expect(result.servers).toHaveLength(1);
      expect(result.servers[0].name).toBe('sseServer');
      expect(result.servers[0].config?.url).toBe('http://localhost:3001/sse');
    });

    it('parses HTTP transport MCP servers (httpUrl)', () => {
      const json = JSON.stringify({
        mcpServers: {
          httpServer: {
            httpUrl: 'http://localhost:3002/mcp',
            headers: { Authorization: 'Bearer token' },
          },
        },
      });

      const result = parseGeminiSettings(json, '/project', 'test.json');

      expect(result.servers).toHaveLength(1);
      expect(result.servers[0].name).toBe('httpServer');
      expect(result.servers[0].config?.httpUrl).toBe('http://localhost:3002/mcp');
    });

    it('skips servers without any transport defined', () => {
      const json = JSON.stringify({
        mcpServers: {
          invalidServer: {
            args: ['ignored'],
          },
        },
      });

      const result = parseGeminiSettings(json, '/project', 'test.json');
      expect(result.servers).toHaveLength(0);
    });

    it('preserves base config (non-MCP settings)', () => {
      const json = JSON.stringify({
        theme: 'dark',
        apiKey: 'secret',
        mcpServers: {
          server: { command: 'node' },
        },
      });

      const result = parseGeminiSettings(json, '/project', 'test.json');

      expect(result.base).toEqual({
        theme: 'dark',
        apiKey: 'secret',
      });
    });

    it('sanitizes absolute paths in command', () => {
      const json = JSON.stringify({
        mcpServers: {
          server: {
            command: '/project/bin/server',
            args: ['/project/config.json'],
          },
        },
      });

      const result = parseGeminiSettings(json, '/project', 'test.json');

      expect(result.servers[0].definition.command).toBe('{{ PROJECT_ROOT }}/bin/server');
      expect(result.servers[0].definition.args).toContain('{{ PROJECT_ROOT }}/config.json');
    });

    it('sorts servers by ID', () => {
      const json = JSON.stringify({
        mcpServers: {
          zServer: { command: 'z' },
          aServer: { command: 'a' },
          mServer: { command: 'm' },
        },
      });

      const result = parseGeminiSettings(json, '/project', 'test.json');

      expect(result.servers.map((s) => s.name)).toEqual(['aServer', 'mServer', 'zServer']);
    });
  });

  describe('renderGeminiSettings', () => {
    it('renders empty settings with no base and no servers', () => {
      const output = renderGeminiSettings(null, []);
      expect(JSON.parse(output)).toEqual({});
    });

    it('restores base config', () => {
      const base = { theme: 'dark', someFlag: true };
      const output = renderGeminiSettings(base, []);

      const parsed = JSON.parse(output);
      expect(parsed.theme).toBe('dark');
      expect(parsed.someFlag).toBe(true);
    });

    it('renders MCP servers from gemini source only', () => {
      const servers = [
        {
          id: 'gemini:server1',
          source: 'gemini' as const,
          name: 'server1',
          origin: 'test',
          definition: { command: 'node', args: ['s1.js'], env: {} },
          config: { command: 'node', args: ['s1.js'] },
        },
        {
          id: 'claude:server2',
          source: 'claude' as const,
          name: 'server2',
          origin: 'test',
          definition: { command: 'python', args: [], env: {} },
          config: { command: 'python' },
        },
      ];

      const output = renderGeminiSettings(null, servers);
      const parsed = JSON.parse(output);

      expect(parsed.mcpServers?.server1).toBeDefined();
      expect(parsed.mcpServers?.server2).toBeUndefined();
    });

    it('uses config object when available', () => {
      const servers = [
        {
          id: 'gemini:server1',
          source: 'gemini' as const,
          name: 'server1',
          origin: 'test',
          definition: { command: 'node', args: [], env: {} },
          config: {
            command: 'node',
            args: ['custom.js'],
            timeout: 30_000,
            trust: true,
          },
        },
      ];

      const output = renderGeminiSettings(null, servers);
      const parsed = JSON.parse(output);

      expect(parsed.mcpServers.server1.timeout).toBe(30_000);
      expect(parsed.mcpServers.server1.trust).toBe(true);
    });
  });

  describe('renderGeminiMcpServers', () => {
    it('renders empty mcpServers for no servers', () => {
      const output = renderGeminiMcpServers([]);
      const parsed = JSON.parse(output);

      expect(parsed).toEqual({ mcpServers: {} });
    });

    it('renders only gemini source servers', () => {
      const servers = [
        {
          id: 'gemini:server1',
          source: 'gemini' as const,
          name: 'server1',
          origin: 'test',
          definition: { command: 'node', args: ['s1.js'], env: { KEY: 'value' } },
          config: { command: 'node', args: ['s1.js'], env: { KEY: 'value' } },
        },
        {
          id: 'codex:server2',
          source: 'codex' as const,
          name: 'server2',
          origin: 'test',
          definition: { command: 'python', args: [], env: {} },
          config: { command: 'python' },
        },
      ];

      const output = renderGeminiMcpServers(servers);
      const parsed = JSON.parse(output);

      expect(Object.keys(parsed.mcpServers)).toHaveLength(1);
      expect(parsed.mcpServers.server1).toBeDefined();
      expect(parsed.mcpServers.server1.command).toBe('node');
      expect(parsed.mcpServers.server1.args).toEqual(['s1.js']);
      expect(parsed.mcpServers.server1.env).toEqual({ KEY: 'value' });
    });
  });
});
