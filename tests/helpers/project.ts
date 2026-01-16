import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export async function createTempProject(prefix = 'tz-proj'): Promise<ProjectBuilder> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
  return new ProjectBuilder(root);
}

export class ProjectBuilder {
  constructor(public readonly root: string) {}

  private async ensureDir(p: string): Promise<void> {
    await fs.mkdir(p, { recursive: true });
  }

  async addCodexAgents(content = '# Codex Agents'): Promise<this> {
    await fs.writeFile(path.join(this.root, 'AGENTS.md'), content, 'utf8');
    return this;
  }

  async addCodexAgentsUnderCodex(content = '# Codex Agents'): Promise<this> {
    await this.ensureDir(path.join(this.root, '.codex'));
    await fs.writeFile(path.join(this.root, '.codex', 'AGENTS.md'), content, 'utf8');
    return this;
  }

  async addClaudeReadme(content = '# Claude'): Promise<this> {
    await this.ensureDir(path.join(this.root, '.claude'));
    await fs.writeFile(path.join(this.root, '.claude', 'CLAUDE.md'), content, 'utf8');
    return this;
  }

  async setClaudeSettings(obj: unknown): Promise<this> {
    await this.ensureDir(path.join(this.root, '.claude'));
    await fs.writeFile(
      path.join(this.root, '.claude', 'settings.json'),
      JSON.stringify(obj, null, 2),
      'utf8',
    );
    return this;
  }

  async setClaudeSettingsRaw(raw: string): Promise<this> {
    await this.ensureDir(path.join(this.root, '.claude'));
    await fs.writeFile(path.join(this.root, '.claude', 'settings.json'), raw, 'utf8');
    return this;
  }

  async setClaudeMcp(obj: unknown): Promise<this> {
    await this.ensureDir(path.join(this.root, '.claude'));
    await fs.writeFile(
      path.join(this.root, '.claude', 'mcp_servers.json'),
      JSON.stringify(obj, null, 2),
      'utf8',
    );
    return this;
  }

  async setClaudeMcpRaw(raw: string): Promise<this> {
    await this.ensureDir(path.join(this.root, '.claude'));
    await fs.writeFile(path.join(this.root, '.claude', 'mcp_servers.json'), raw, 'utf8');
    return this;
  }

  async addClaudeAgent(relPath: string, content = 'agent'): Promise<this> {
    const abs = path.join(this.root, '.claude', 'agents', relPath);
    await this.ensureDir(path.dirname(abs));
    await fs.writeFile(abs, content, 'utf8');
    return this;
  }

  async addGeminiReadme(content = '# Gemini'): Promise<this> {
    await this.ensureDir(path.join(this.root, '.gemini'));
    await fs.writeFile(path.join(this.root, '.gemini', 'GEMINI.md'), content, 'utf8');
    return this;
  }
}
