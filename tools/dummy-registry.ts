#!/usr/bin/env node
/**
 * Dummy registry server for local development and testing.
 * Mirrors the staging API surface (owner/name paths, multipart publish).
 */

import { createServer, IncomingMessage, ServerResponse } from 'http';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import os from 'os';
import crypto from 'crypto';
import * as tar from 'tar';
import busboy from 'busboy';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = Number(process.env.PORT || 8787);
const FIXTURES_DIR = join(__dirname, '../fixtures/packages');
const PUBLISHED_DIR = join(os.tmpdir(), 'tz-dummy-published');

mkdirSync(PUBLISHED_DIR, { recursive: true });

interface DummyVersion {
  version: string;
  dependencies: Record<string, string>;
  compatibility?: Record<string, string>;
  publishedAt: string;
  yanked: boolean;
  yankedReason?: string;
  integrity?: string;
}

interface DummyPackage {
  owner: string;
  name: string;
  fullName: string;
  description?: string;
  latest: string;
  versions: Record<string, DummyVersion>;
}

const packages = new Map<string, DummyPackage>();

function addPackage(pkg: DummyPackage) {
  packages.set(`${pkg.owner}/${pkg.name}`, pkg);
}

addPackage({
  owner: 'terrazul',
  name: 'starter',
  fullName: '@terrazul/starter',
  description: 'Starter package for Terrazul CLI testing',
  latest: '1.1.0',
  versions: {
    '1.0.0': {
      version: '1.0.0',
      dependencies: {},
      compatibility: { 'claude-code': '>=0.2.0' },
      publishedAt: new Date('2024-01-01T00:00:00Z').toISOString(),
      yanked: false,
    },
    '1.1.0': {
      version: '1.1.0',
      dependencies: { '@terrazul/base': '^2.0.0' },
      compatibility: { 'claude-code': '>=0.2.0' },
      publishedAt: new Date('2024-01-15T00:00:00Z').toISOString(),
      yanked: false,
    },
  },
});

addPackage({
  owner: 'terrazul',
  name: 'base',
  fullName: '@terrazul/base',
  description: 'Base package for Terrazul',
  latest: '2.0.0',
  versions: {
    '2.0.0': {
      version: '2.0.0',
      dependencies: {},
      publishedAt: new Date('2024-01-01T00:00:00Z').toISOString(),
      yanked: false,
    },
    '2.1.0': {
      version: '2.1.0',
      dependencies: {},
      publishedAt: new Date('2024-01-10T00:00:00Z').toISOString(),
      yanked: true,
      yankedReason: 'Critical bug in command parsing',
    },
  },
});

function respondJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  });
  res.end(JSON.stringify(body));
}

function requireAuth(req: IncomingMessage): boolean {
  const auth = req.headers.authorization || '';
  return /^Bearer\s+tz_[\dA-Za-z]+/.test(auth);
}

function parseOwnerAndName(ownerSegment: string, nameSegment: string) {
  const owner = decodeURIComponent(ownerSegment).replace(/^@/, '');
  const slug = decodeURIComponent(nameSegment);
  const prefix = `${owner}-`;
  const pkgName = slug.startsWith(prefix) ? slug.slice(prefix.length) : slug;
  const key = `${owner}/${pkgName}`;
  const fullName = `@${owner}/${pkgName}`;
  return { owner, pkgName, key, fullName, slug };
}

function collectBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      chunks.push(Buffer.from(chunk));
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', (err) => reject(err));
  });
}

function handlePublish(
  req: IncomingMessage,
  res: ServerResponse,
  pkg: DummyPackage,
  owner: string,
  pkgName: string,
): void {
  if (!requireAuth(req)) {
    respondJson(res, 401, { error: 'Authentication required' });
    return;
  }

  const contentType = req.headers['content-type'] || '';
  if (!contentType.includes('multipart/form-data')) {
    respondJson(res, 415, { error: 'Expected multipart/form-data body' });
    return;
  }
  const boundaryMatch = /boundary=([^;]+)/.exec(contentType);
  if (!boundaryMatch) {
    respondJson(res, 400, { error: 'Missing multipart boundary' });
    return;
  }

  // Use busboy to parse multipart form data
  const bb = busboy({ headers: req.headers });
  let metadataJson: string | null = null;
  let tarballData: Buffer | null = null;

  bb.on('field', (name: string, value: string) => {
    if (name === 'metadata') {
      metadataJson = value;
    }
  });

  bb.on('file', (name: string, file: NodeJS.ReadableStream, _info: busboy.FileInfo) => {
    if (name === 'tarball') {
      const chunks: Buffer[] = [];
      file.on('data', (chunk: Buffer) => chunks.push(chunk));
      file.on('end', () => {
        tarballData = Buffer.concat(chunks);
      });
    } else {
      file.resume(); // Drain unneeded files
    }
  });

  bb.on('finish', () => {
    if (!metadataJson || !tarballData) {
      respondJson(res, 400, { error: 'Missing metadata or tarball part' });
      return;
    }

    const metadata = JSON.parse(metadataJson);
    const version = metadata.version;

    if (!version) {
      respondJson(res, 400, { error: 'Missing version in metadata' });
      return;
    }

    const integrity = `sha256-${crypto.createHash('sha256').update(tarballData).digest('base64url')}`;
    const publishedVersion: DummyVersion = {
      version,
      dependencies: metadata?.dependencies ?? {},
      compatibility: metadata?.compatibility ?? {},
      publishedAt: new Date().toISOString(),
      yanked: false,
      integrity,
    };

    pkg.versions[version] = publishedVersion;
    pkg.latest = version;

    const slug = `${owner}-${pkgName}`;
    const filename = `${slug.replaceAll(/[^\w.-]/g, '_')}-${version}.tgz`;
    const outPath = join(PUBLISHED_DIR, filename);
    writeFileSync(outPath, tarballData);

    respondJson(res, 200, {
      message: `Package ${pkg.fullName}@${version} published`,
      version,
      name: pkg.fullName,
      url: `http://localhost:${PORT}/cdn/${encodeURIComponent(owner)}/${encodeURIComponent(`${owner}-${pkgName}`)}/${version}.tgz`,
    });
  });

  bb.on('error', (err: Error) => {
    respondJson(res, 400, { error: `Multipart parsing error: ${err.message}` });
  });

  req.pipe(bb);
}

async function ensureTarball(owner: string, pkgName: string, version: string): Promise<Buffer> {
  const fixtureDir = join(FIXTURES_DIR, `${owner}_${pkgName}`);
  const fixturePath = join(fixtureDir, `${version}.tgz`);
  if (existsSync(fixturePath)) {
    return readFileSync(fixturePath);
  }

  const tmpDir = mkdtempSync(join(os.tmpdir(), 'tz-dummy-tar-'));
  const files: string[] = ['agents.toml', 'README.md'];
  mkdirSync(tmpDir, { recursive: true });
  let agentsToml = `[package]\nname = "@${owner}/${pkgName}"\nversion = "${version}"\n\n[dependencies]\n\n[compatibility]\n`;
  writeFileSync(join(tmpDir, 'README.md'), `# @${owner}/${pkgName} ${version}\n`, 'utf8');
  if (pkgName === 'starter') {
    const templateRoot = join(tmpDir, 'templates');
    mkdirSync(join(templateRoot, 'claude', 'agents'), { recursive: true });
    writeFileSync(join(templateRoot, 'CLAUDE.md.hbs'), '# Hello {{project.name}}', 'utf8');
    writeFileSync(
      join(templateRoot, 'claude', 'settings.local.json.hbs'),
      '{"greeting": "hi"}',
      'utf8',
    );
    writeFileSync(join(templateRoot, 'claude', 'agents', 'reviewer.md.hbs'), 'I review', 'utf8');
    agentsToml += '\n[exports.claude]\n';
    agentsToml += 'template = "templates/CLAUDE.md.hbs"\n';
    agentsToml += 'settingsLocal = "templates/claude/settings.local.json.hbs"\n';
    agentsToml += 'subagentsDir = "templates/claude/agents"\n';
    files.push(
      'templates/CLAUDE.md.hbs',
      'templates/claude/settings.local.json.hbs',
      'templates/claude/agents/reviewer.md.hbs',
    );
  }
  writeFileSync(join(tmpDir, 'agents.toml'), agentsToml, 'utf8');

  const output: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    const stream = tar.create({ gzip: true, cwd: tmpDir, portable: true }, files);
    stream.on('data', (chunk: Buffer) => output.push(Buffer.from(chunk)));
    stream.on('end', resolve);
    stream.on('error', reject);
  });

  try {
    return Buffer.concat(output);
  } finally {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

const server = createServer(async (req, res) => {
  const method = req.method || 'GET';
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);
  const path = url.pathname;

  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    });
    res.end();
    return;
  }

  // List packages
  if (method === 'GET' && path === '/packages/v1') {
    const pkgArray = [...packages.values()].map((pkg) => ({
      id: `${pkg.owner}/${pkg.name}`,
      owner_handle: pkg.owner,
      name: `${pkg.owner}-${pkg.name}`,
      full_name: pkg.fullName,
      latest: pkg.latest,
      description: pkg.description,
    }));
    respondJson(res, 200, { packages: pkgArray });
    return;
  }

  if (method === 'GET' && path === '/health') {
    respondJson(res, 200, { status: 'ok', time: new Date().toISOString() });
    return;
  }

  if (method === 'POST' && path === '/auth/v1/cli/initiate') {
    const state = crypto.randomBytes(16).toString('hex');
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    respondJson(res, 200, {
      state,
      expiresAt,
      browserUrl: 'https://login.terrazul.dev/cli/auth',
    });
    return;
  }

  if (method === 'POST' && path === '/auth/v1/cli/complete') {
    const body = await collectBody(req);
    let token = 'tz_cli_dummy_token';
    try {
      const parsed = JSON.parse(body.toString('utf8')) as { token?: string };
      if (parsed.token && typeof parsed.token === 'string') {
        token = parsed.token;
      }
    } catch {
      // ignore parse errors and use default token
    }
    respondJson(res, 200, {
      token,
      tokenId: `tok_${token.slice(-6)}`,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString(),
      user: {
        id: 'user_dummy',
        username: 'dummy-user',
        email: 'dummy@example.com',
      },
    });
    return;
  }

  if (method === 'POST' && path === '/auth/v1/cli/introspect') {
    const body = await collectBody(req);
    let token = 'tz_cli_dummy_token';
    try {
      const parsed = JSON.parse(body.toString('utf8')) as { token?: string };
      if (parsed.token && typeof parsed.token === 'string') {
        token = parsed.token;
      }
    } catch {
      // ignore parse errors
    }
    respondJson(res, 200, {
      token,
      tokenId: `tok_${token.slice(-6)}`,
      createdAt: new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString(),
      expiresAt: new Date(Date.now() + 60 * 24 * 3600 * 1000).toISOString(),
      user: {
        id: 'user_dummy',
        username: 'dummy-user',
        email: 'dummy@example.com',
      },
    });
    return;
  }

  if (method === 'DELETE' && path.startsWith('/auth/v1/tokens/')) {
    if (Math.random() < 0.9) {
      res.writeHead(204);
      res.end();
    } else {
      respondJson(res, 500, {
        code: 'SERVER_ERROR',
        message: 'Random failure',
      });
    }
    return;
  }

  // Package detail
  let match = path.match(/^\/packages\/v1\/([^/]+)\/([^/]+)$/);
  if (method === 'GET' && match) {
    const { owner, pkgName, key } = parseOwnerAndName(match[1], match[2]);
    const pkg = packages.get(key);
    if (!pkg) {
      respondJson(res, 404, { error: 'package not found' });
      return;
    }
    respondJson(res, 200, {
      name: pkg.fullName,
      owner,
      description: pkg.description,
      latest: pkg.latest,
      versions: pkg.versions,
    });
    return;
  }

  // Package versions
  match = path.match(/^\/packages\/v1\/([^/]+)\/([^/]+)\/versions$/);
  if (method === 'GET' && match) {
    const { owner, pkgName, key } = parseOwnerAndName(match[1], match[2]);
    const pkg = packages.get(key);
    if (!pkg) {
      respondJson(res, 404, { error: 'package not found' });
      return;
    }
    respondJson(res, 200, {
      name: pkg.fullName,
      owner,
      versions: pkg.versions,
    });
    return;
  }

  // Tarball info
  match = path.match(/^\/packages\/v1\/([^/]+)\/([^/]+)\/tarball\/([^/]+)$/);
  if (method === 'GET' && match) {
    const { owner, pkgName, key } = parseOwnerAndName(match[1], match[2]);
    const version = decodeURIComponent(match[3]);
    const pkg = packages.get(key);
    const versionInfo = pkg?.versions[version];
    if (!pkg || !versionInfo) {
      respondJson(res, 404, { error: 'version not found' });
      return;
    }
    const slug = `${owner}-${pkgName}`;
    // Simulate AWS S3 signed URLs with temporary credentials (like production CDN)
    const signedParams = `X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE&X-Amz-Date=${new Date().toISOString().replaceAll(/[:-]/g, '').slice(0, 15)}Z&X-Amz-Expires=3600&X-Amz-Signature=${crypto.randomBytes(32).toString('hex')}`;
    respondJson(res, 200, {
      url: `http://localhost:${PORT}/cdn/${encodeURIComponent(owner)}/${encodeURIComponent(slug)}/${version}.tgz?${signedParams}`,
      integrity: versionInfo.integrity ?? 'sha256-fake-integrity',
    });
    return;
  }

  // Publish package
  match = path.match(/^\/packages\/v1\/([^/]+)\/([^/]+)\/publish$/);
  if (method === 'POST' && match) {
    const { owner, pkgName, key, fullName } = parseOwnerAndName(match[1], match[2]);
    let pkg = packages.get(key);
    if (!pkg) {
      pkg = {
        owner,
        name: pkgName,
        fullName,
        latest: '0.0.0',
        versions: {},
      };
      addPackage(pkg);
    }
    handlePublish(req, res, pkg, owner, pkgName);
    return;
  }

  // Create package metadata
  if (method === 'POST' && path === '/packages/v1') {
    if (!requireAuth(req)) {
      respondJson(res, 401, { error: 'Authentication required' });
      return;
    }
    const body = await collectBody(req);
    const json = JSON.parse(body.toString('utf8') || '{}');
    const name: string | undefined = json.name;
    if (!name || !name.includes('/')) {
      respondJson(res, 400, { error: 'name must be @owner/name' });
      return;
    }
    const { owner, pkgName, key, fullName } = parseOwnerAndName(
      name.split('/')[0],
      name.split('/')[1],
    );
    if (!packages.has(key)) {
      addPackage({
        owner,
        name: pkgName,
        fullName,
        description: json.description,
        latest: '0.0.0',
        versions: {},
      });
    }
    respondJson(res, 201, {
      package: {
        owner_handle: owner,
        name: `${owner}-${pkgName}`,
        full_name: fullName,
        description: json.description,
      },
    });
    return;
  }

  // Serve tarball bytes
  match = path.match(/^\/cdn\/([^/]+)\/([^/]+)\/([^/]+)\.tgz$/);
  if (method === 'GET' && match) {
    const owner = decodeURIComponent(match[1]);
    const slug = decodeURIComponent(match[2]);
    const prefix = `${owner}-`;
    const pkgName = slug.startsWith(prefix) ? slug.slice(prefix.length) : slug;
    const version = decodeURIComponent(match[3]);
    const key = `${owner}/${pkgName}`;
    const pkg = packages.get(key);
    if (!pkg) {
      respondJson(res, 404, { error: 'package not found' });
      return;
    }

    const publishedSlug = `${owner}-${pkgName}`;
    const publishedPath = join(
      PUBLISHED_DIR,
      `${publishedSlug.replaceAll(/[^\w.-]/g, '_')}-${version}.tgz`,
    );
    if (existsSync(publishedPath)) {
      res.writeHead(200, {
        'Content-Type': 'application/gzip',
        'Access-Control-Allow-Origin': '*',
      });
      createReadStream(publishedPath).pipe(res);
      return;
    }

    const fixturePath = join(FIXTURES_DIR, `${owner}_${pkgName}`, `${version}.tgz`);
    if (existsSync(fixturePath)) {
      res.writeHead(200, {
        'Content-Type': 'application/gzip',
        'Access-Control-Allow-Origin': '*',
      });
      createReadStream(fixturePath).pipe(res);
      return;
    }

    const buf = await ensureTarball(owner, pkgName, version);
    res.writeHead(200, {
      'Content-Type': 'application/gzip',
      'Content-Length': buf.length,
      'Access-Control-Allow-Origin': '*',
    });
    res.end(buf);
    return;
  }

  respondJson(res, 404, { error: 'Not found' });
});

server.listen(PORT, () => {
  console.log(`Dummy registry server running on http://localhost:${PORT}`);
});
