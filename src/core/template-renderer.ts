import { promises as fs, readdirSync, realpathSync, type Stats } from 'node:fs';
import path from 'node:path';

import { safeResolveWithin } from './destinations.js';
import { ErrorCode, TerrazulError } from './errors.js';
import { LockfileManager } from './lock-file.js';
import { SnippetCacheManager } from './snippet-cache.js';
import { StorageManager } from './storage.js';
import { loadConfig, getProfileTools, selectPrimaryTool } from '../utils/config.js';
import { ensureDir } from '../utils/fs.js';
import { readManifest, type ExportEntry } from '../utils/manifest.js';
import { renderTemplateWithSnippets, copyLiteralFile } from '../utils/template.js';

import type { ToolType, ToolSpec } from '../types/context.js';
import type { PreprocessResult, SnippetEvent } from '../types/snippet.js';

export interface RenderContext {
  [key: string]: unknown;
  project: {
    root: string;
    name?: string;
    version?: string;
  };
  pkg: {
    name?: string;
    version?: string;
  };
  env: Record<string, string | undefined>;
  now: string;
  // passthrough from user config to allow destination selection and user vars later
  files: { claude: string; codex: string; cursor: string; copilot: string };
}

export interface RenderItem {
  pkgName: string;
  source: string; // absolute path to template
  rel: string; // relative to package root
  dest: string; // absolute path to output
}

type SkipReasonCode =
  | 'exists'
  | 'symlink-ancestor-outside'
  | 'dest-symlink-outside'
  | 'dest-symlink-broken'
  | 'unlink-failed'
  | 'unsafe-symlink';

export interface RenderedFileMetadata {
  pkgName: string;
  source: string;
  dest: string;
  tool: ToolType;
  isMcpConfig: boolean;
}

export interface RenderResult {
  written: string[];
  skipped: Array<{ dest: string; reason: string; code: SkipReasonCode }>;
  backedUp: string[];
  snippets: Array<{ source: string; dest: string; output: string; preprocess: PreprocessResult }>;
  // Mapping of package name to array of rendered file paths
  packageFiles?: Map<string, string[]>;
  // Metadata about rendered files (for symlink manager)
  renderedFiles: RenderedFileMetadata[];
}

export interface TemplateProgress {
  templateRel: string;
  dest: string;
  pkgName: string | undefined;
}

export interface SnippetProgress {
  event: SnippetEvent;
  templateRel: string;
  dest: string;
  pkgName: string | undefined;
}

interface SnippetFailureDetail {
  pkgName?: string;
  dest: string;
  templateRel: string;
  snippetId: string;
  snippetType: 'askUser' | 'askAgent';
  message: string;
}

const SKIP_REASON_MESSAGES: Record<SkipReasonCode, string> = {
  exists: 'destination exists (use --force to overwrite)',
  'symlink-ancestor-outside': 'unsafe symlink ancestor resolves outside project root',
  'dest-symlink-outside': 'destination symlink resolves outside project root',
  'dest-symlink-broken': 'destination symlink is broken and cannot be replaced safely',
  'unlink-failed': 'failed to unlink destination symlink before writing',
  'unsafe-symlink': 'unsafe symlink detected at destination',
};

function formatSkipReason(code: SkipReasonCode): string {
  return SKIP_REASON_MESSAGES[code] ?? 'unsafe symlink detected at destination';
}

function makeSkip(
  dest: string,
  code: SkipReasonCode,
): { dest: string; reason: string; code: SkipReasonCode } {
  return { dest, code, reason: formatSkipReason(code) };
}

// Determine whether writing to dest could escape via symlinked ancestors.
// - If any existing ancestor of dest is a symlink that resolves outside root, return false.
// - If dest exists and is a symlink: allow unlink-and-write only when the symlink resolves within root.
async function evaluateDestinationSafety(
  projectRoot: string,
  dest: string,
): Promise<{ safe: true; unlinkDestSymlink: boolean } | { safe: false; reason: SkipReasonCode }> {
  const { lstat, realpath } = fs;
  const rootResolved = path.resolve(projectRoot);
  let rootCanonical: string | null = null;
  try {
    rootCanonical = await realpath(rootResolved);
  } catch {
    rootCanonical = null;
  }
  const isWin = process.platform === 'win32';
  const norm = (s: string) => (isWin ? s.toLowerCase() : s);
  const withSep = (s: string) => (s.endsWith(path.sep) ? s : s + path.sep);
  const baseCandidates = new Set<string>();
  baseCandidates.add(withSep(norm(rootResolved)));
  if (rootCanonical) {
    baseCandidates.add(withSep(norm(rootCanonical)));
  }

  const isWithin = (p: string): boolean => {
    const resolved = path.resolve(p);
    const candidates = [resolved];
    try {
      const canonical = realpathSync(resolved);
      if (canonical && canonical !== resolved) candidates.push(canonical);
    } catch {
      // realpathSync may fail for non-existent paths; ignore.
    }
    return candidates.some((candidate) => {
      const normalized = withSep(norm(candidate));
      for (const base of baseCandidates) {
        if (normalized.startsWith(base)) return true;
      }
      return false;
    });
  };

  // 1) Check existing ancestors of dest directory, but only within the project root boundary.
  let cur = path.dirname(dest);
  const stop = path.parse(cur).root;
  while (isWithin(cur)) {
    try {
      const st = await lstat(cur);
      if (st.isSymbolicLink()) {
        try {
          const real = await realpath(cur);
          if (!isWithin(real)) {
            return { safe: false, reason: 'symlink-ancestor-outside' };
          }
        } catch {
          // Broken symlink ancestor — treat as unsafe
          return { safe: false, reason: 'symlink-ancestor-outside' };
        }
      }
    } catch {
      // cur does not exist; continue upward
    }
    if (cur === stop || path.resolve(cur) === rootResolved) break;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }

  // 2) If dest exists and is a symlink, decide if we can unlink it
  try {
    const stDest = await lstat(dest);
    if (stDest.isSymbolicLink()) {
      try {
        const real = await realpath(dest);
        if (!isWithin(real)) {
          return { safe: false, reason: 'dest-symlink-outside' };
        }
        return { safe: true, unlinkDestSymlink: true };
      } catch {
        return { safe: false, reason: 'dest-symlink-broken' };
      }
    }
  } catch {
    // dest does not exist — no special handling
  }

  return { safe: true, unlinkDestSymlink: false };
}

function computeDestForRel(packageRoot: string, relUnderTemplates: string): string {
  const rel = relUnderTemplates.replaceAll('\\', '/');
  // Always render to package directory following the package's directory structure
  const cleaned = rel.endsWith('.hbs') ? rel.slice(0, -4) : rel;
  return safeResolveWithin(packageRoot, String(cleaned));
}

function collectFromExports(
  pkgRoot: string,
  tool: ToolType,
  exp: ExportEntry | undefined,
): Array<{ abs: string; relUnderTemplates: string; tool: ToolType; isMcpConfig: boolean }> {
  if (!exp) return [];
  const out: Array<{
    abs: string;
    relUnderTemplates: string;
    tool: ToolType;
    isMcpConfig: boolean;
  }> = [];
  const tplRoot = path.join(pkgRoot, 'templates');

  function ensureWithinTemplates(rel: string): string {
    const base = path.resolve(tplRoot);
    const abs = path.resolve(tplRoot, rel);
    const normBase = base.endsWith(path.sep) ? base : base + path.sep;
    const normAbs = abs.endsWith(path.sep) ? abs : abs + path.sep;
    if (!normAbs.startsWith(normBase)) {
      throw new TerrazulError(
        ErrorCode.SECURITY_VIOLATION,
        `Export path escapes package templates directory: ${rel}`,
      );
    }
    return abs;
  }

  if (typeof exp.template === 'string') {
    const rel = exp.template.startsWith('templates/')
      ? exp.template.slice('templates/'.length)
      : exp.template;
    const abs = ensureWithinTemplates(rel);
    out.push({ abs, relUnderTemplates: rel, tool, isMcpConfig: false });
  }

  // Track which keys represent MCP configs
  const extraKeys: Array<keyof ExportEntry> = ['settings', 'settingsLocal', 'mcpServers'] as never;
  for (const k of extraKeys) {
    const v = (exp as Record<string, unknown>)[k];
    if (typeof v === 'string') {
      const rel = v.startsWith('templates/') ? v.slice('templates/'.length) : v;
      const abs = ensureWithinTemplates(rel);
      // Mark mcpServers files as MCP configs
      const isMcpConfig = k === 'mcpServers';
      out.push({ abs, relUnderTemplates: rel, tool, isMcpConfig });
    }
  }

  // Helper to collect files from directory exports
  const collectDirectoryExport = (dirKey: string) => {
    const dirValue = (exp as Record<string, unknown>)[dirKey];
    if (typeof dirValue === 'string') {
      const relDir = dirValue.startsWith('templates/')
        ? dirValue.slice('templates/'.length)
        : dirValue;
      const absDir = ensureWithinTemplates(relDir);
      out.push(
        ...collectFilesRecursively(absDir).map((f) => ({
          abs: f,
          relUnderTemplates: path.join(relDir, path.relative(absDir, f)),
          tool,
          isMcpConfig: false,
        })),
      );
    }
  };

  // Collect files from all directory-based exports
  const dirExports = ['subagentsDir', 'commandsDir', 'skillsDir', 'promptsDir'];
  for (const dirKey of dirExports) {
    collectDirectoryExport(dirKey);
  }

  return out;
}

function collectFilesRecursively(root: string): string[] {
  try {
    const stack: string[] = [root];
    const files: string[] = [];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      const dirents = readdirSync(cur, { withFileTypes: true });
      for (const d of dirents) {
        const abs = path.join(cur, d.name);
        if (d.isDirectory()) stack.push(abs);
        else if (d.isFile()) files.push(abs);
      }
    }
    return files;
  } catch {
    return [];
  }
}

function collectSnippetFailures(
  preprocess: PreprocessResult,
  dest: string,
  templateRel: string,
  pkgName: string | undefined,
): SnippetFailureDetail[] {
  const failures: SnippetFailureDetail[] = [];
  for (const snippet of preprocess.parsed) {
    const execution = preprocess.execution.snippets[snippet.id];
    if (!execution || !execution.error) continue;
    failures.push({
      pkgName,
      dest,
      templateRel,
      snippetId: snippet.id,
      snippetType: snippet.type,
      message: execution.error.message,
    });
  }
  return failures;
}

function formatSnippetFailureMessage(
  projectRoot: string,
  failures: SnippetFailureDetail[],
): string {
  const count = failures.length;
  const header =
    count === 1
      ? 'Snippet execution failed while rendering templates.'
      : `${count} snippets failed while rendering templates.`;
  const lines = failures.map((failure) => {
    const destLabel = path.relative(projectRoot, failure.dest) || failure.dest;
    const locationParts = [];
    if (failure.pkgName) locationParts.push(failure.pkgName);
    locationParts.push(failure.templateRel);
    const location = locationParts.join(':');
    return `- ${destLabel} :: ${failure.snippetId} (${failure.snippetType}) from ${location} — ${failure.message}`;
  });
  return [header, ...lines].join('\n');
}

export interface ApplyOptions {
  force?: boolean; // overwrite if exists
  dryRun?: boolean;
  // package filter: only render this package (name exactly as in agent_modules)
  packageName?: string;
  profileName?: string;
  tool?: ToolType;
  toolSafeMode?: boolean;
  verbose?: boolean;
  onTemplateStart?: (info: TemplateProgress) => void;
  onSnippetEvent?: (progress: SnippetProgress) => void;
  // Snippet caching options
  noCache?: boolean;
  cacheFilePath?: string;
  // Custom store directory (for testing)
  storeDir?: string;
  // Map of package names to custom store paths (for local packages)
  localPackagePaths?: Map<string, string>;
}

interface DiscoveredPackage {
  name: string;
  root: string;
  storePath: string;
}

interface RenderConfiguration {
  primaryTool: ToolSpec;
  toolSafeMode: boolean;
  filesMap: RenderContext['files'];
  profileTools: ToolSpec[];
}

/**
 * Manages file backups during template rendering.
 * Creates timestamped backup directories and tracks backed up files.
 */
class BackupManager {
  private backupRoot: string | undefined;
  private backedUpTargets = new Set<string>();
  private backedUpPaths: string[] = [];

  constructor(
    private projectRoot: string,
    private dryRun: boolean = false,
  ) {}

  /**
   * Backup a file before overwriting it.
   * Idempotent - won't backup the same file twice.
   */
  async backupFile(target: string): Promise<void> {
    if (this.dryRun) return;

    try {
      // Skip if already backed up
      if (this.backedUpTargets.has(target)) return;

      const stat = await fs.lstat(target);
      if (!stat.isFile() && !stat.isSymbolicLink()) return;

      // Create backup root on first backup
      if (!this.backupRoot) {
        const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
        this.backupRoot = path.join(this.projectRoot, '.tz-backup', stamp);
      }

      const relativeTarget = path.relative(this.projectRoot, target);
      const backupPath = path.join(this.backupRoot, relativeTarget);
      await fs.mkdir(path.dirname(backupPath), { recursive: true });
      await fs.copyFile(target, backupPath);

      this.backedUpPaths.push(path.relative(this.projectRoot, backupPath));
      this.backedUpTargets.add(target);
    } catch {
      // Ignore backup errors - don't block rendering
    }
  }

  /**
   * Get list of backed up file paths (relative to project root).
   */
  getBackedUpPaths(): string[] {
    return [...this.backedUpPaths];
  }
}

/**
 * Setup rendering configuration from user config and options.
 */
export async function setupRenderConfiguration(
  projectRoot: string,
  opts: Pick<ApplyOptions, 'tool' | 'toolSafeMode'>,
): Promise<RenderConfiguration> {
  const cfg = await loadConfig();
  const profileTools = getProfileTools(cfg);
  const primaryTool = selectPrimaryTool(cfg, opts.tool);
  const toolSafeMode = opts.toolSafeMode ?? true;
  const contextFilesRaw = cfg.context?.files as Partial<RenderContext['files']> | undefined;
  const filesMap: RenderContext['files'] = {
    claude: contextFilesRaw?.claude ?? 'CLAUDE.md',
    codex: contextFilesRaw?.codex ?? 'AGENTS.md',
    cursor: contextFilesRaw?.cursor ?? '.cursor/rules.mdc',
    copilot: contextFilesRaw?.copilot ?? '.github/copilot-instructions.md',
  };

  return { primaryTool, toolSafeMode, filesMap, profileTools };
}

/**
 * Discover installed packages from agent_modules directory.
 * Reads lockfile to get version info and storage manager to resolve paths.
 */
export async function discoverInstalledPackages(
  agentModulesRoot: string,
  lockfile: ReturnType<typeof LockfileManager.read>,
  storage: StorageManager,
  opts: Pick<ApplyOptions, 'localPackagePaths'>,
): Promise<DiscoveredPackage[]> {
  const pkgs: DiscoveredPackage[] = [];
  const level1 = await fs.readdir(agentModulesRoot).catch(() => [] as string[]);

  for (const d1 of level1) {
    const abs = path.join(agentModulesRoot, d1);
    const st = await fs.stat(abs).catch(() => null);
    if (!st || !st.isDirectory()) continue;

    if (d1.startsWith('@')) {
      // Scoped package: @scope/name
      const nested = await fs.readdir(abs).catch(() => [] as string[]);
      for (const d2 of nested) {
        const abs2 = path.join(abs, d2);
        const st2 = await fs.stat(abs2).catch(() => null);
        if (st2 && st2.isDirectory()) {
          const pkgName = `${d1}/${d2}`;

          // Check for local package path override
          const localPath = opts.localPackagePaths?.get(pkgName);
          if (localPath) {
            pkgs.push({ name: pkgName, root: abs2, storePath: localPath });
          } else {
            const lockEntry = lockfile?.packages[pkgName];
            if (lockEntry) {
              const storePath = storage.getPackagePath(pkgName, lockEntry.version);
              pkgs.push({ name: pkgName, root: abs2, storePath });
            }
          }
        }
      }
    } else {
      // Non-scoped package
      const localPath = opts.localPackagePaths?.get(d1);
      if (localPath) {
        pkgs.push({ name: d1, root: abs, storePath: localPath });
      } else {
        const lockEntry = lockfile?.packages[d1];
        if (lockEntry) {
          const storePath = storage.getPackagePath(d1, lockEntry.version);
          pkgs.push({ name: d1, root: abs, storePath });
        }
      }
    }
  }

  // Sort alphabetically for deterministic order
  pkgs.sort((a, b) => a.name.localeCompare(b.name));
  return pkgs;
}

/**
 * Filter packages by name or profile options.
 */
export function filterPackagesByOptions(
  packages: DiscoveredPackage[],
  projectManifest: Awaited<ReturnType<typeof readManifest>> | undefined,
  opts: Pick<ApplyOptions, 'packageName' | 'profileName'>,
): DiscoveredPackage[] {
  // Filter by specific package name
  if (opts.packageName) {
    return packages.filter((p) => p.name === opts.packageName);
  }

  // Filter by profile
  if (opts.profileName) {
    if (!projectManifest) {
      throw new TerrazulError(
        ErrorCode.CONFIG_NOT_FOUND,
        'agents.toml is required when using --profile',
      );
    }
    const profiles = projectManifest.profiles ?? {};
    const memberships = profiles[opts.profileName];
    if (!memberships || memberships.length === 0) {
      throw new TerrazulError(
        ErrorCode.INVALID_ARGUMENT,
        `Profile '${opts.profileName}' is not defined or has no packages`,
      );
    }
    const allowed = new Set(memberships);
    const missing = memberships.filter((name) => !packages.some((pkg) => pkg.name === name));
    if (missing.length > 0) {
      throw new TerrazulError(
        ErrorCode.INVALID_ARGUMENT,
        `Profile '${opts.profileName}' references packages that are not installed: ${missing.join(
          ', ',
        )}`,
      );
    }
    return packages.filter((pkg) => allowed.has(pkg.name));
  }

  // No filter: return all packages
  return packages;
}

export async function planAndRender(
  projectRoot: string,
  agentModulesRoot: string,
  opts: ApplyOptions = {},
): Promise<RenderResult> {
  // Setup configuration
  const { primaryTool, toolSafeMode, filesMap, profileTools } = await setupRenderConfiguration(
    projectRoot,
    opts,
  );

  // Discover installed packages from agent_modules and lockfile
  const lockfile = LockfileManager.read(projectRoot);
  const storage = new StorageManager(opts.storeDir ? { storeDir: opts.storeDir } : {});
  const pkgs = await discoverInstalledPackages(agentModulesRoot, lockfile, storage, opts);

  // Filter packages by name or profile
  const projectManifest = (await readManifest(projectRoot)) ?? undefined;
  const projectName = projectManifest?.package?.name;
  const projectVersion = projectManifest?.package?.version;
  const filtered = filterPackagesByOptions(pkgs, projectManifest, opts);

  // Initialize snippet cache manager (unless explicitly disabled)
  let cacheManager: SnippetCacheManager | undefined;
  if (opts.noCache !== true) {
    const cacheFilePath = opts.cacheFilePath ?? path.join(projectRoot, 'agents-cache.toml');
    cacheManager = new SnippetCacheManager(cacheFilePath);
    await cacheManager.read();

    // Prune stale cache entries (packages no longer installed)
    const installedPackageNames = pkgs.map((p) => p.name);
    await cacheManager.prune(installedPackageNames);
  }

  const written: string[] = [];
  const skipped: Array<{ dest: string; reason: string; code: SkipReasonCode }> = [];
  const renderedFiles: RenderedFileMetadata[] = [];
  const snippetExecutions: Array<{
    source: string;
    dest: string;
    output: string;
    preprocess: PreprocessResult;
  }> = [];
  const snippetFailures: SnippetFailureDetail[] = [];
  const packageFiles = new Map<string, string[]>();

  // Initialize backup manager
  const backupManager = new BackupManager(projectRoot, opts.dryRun ?? false);

  for (const p of filtered) {
    // Read manifest and templates from store path (read-only)
    const m = await readManifest(p.storePath);
    const exp = (m?.exports ?? {}) as Partial<
      Record<'claude' | 'codex' | 'cursor' | 'copilot', ExportEntry>
    >;
    const toRender: Array<{
      abs: string;
      relUnderTemplates: string;
      tool: ToolType;
      isMcpConfig: boolean;
    }> = [];
    if (exp?.claude) toRender.push(...collectFromExports(p.storePath, 'claude', exp.claude));
    if (exp?.codex) toRender.push(...collectFromExports(p.storePath, 'codex', exp.codex));
    if (exp?.cursor) toRender.push(...collectFromExports(p.storePath, 'cursor', exp.cursor));
    if (exp?.copilot) toRender.push(...collectFromExports(p.storePath, 'copilot', exp.copilot));

    // Deduplicate templates by absolute path to prevent rendering the same file multiple times
    const seen = new Map<
      string,
      { abs: string; relUnderTemplates: string; tool: ToolType; isMcpConfig: boolean }
    >();
    for (const item of toRender) {
      if (!seen.has(item.abs)) {
        seen.set(item.abs, item);
        if (opts.verbose) {
          console.log(`[template-renderer] Collecting template: ${item.abs} (${item.tool})`);
        }
      } else if (opts.verbose) {
        console.log(`[template-renderer] Skipping duplicate template: ${item.abs} (${item.tool})`);
      }
    }
    const uniqueToRender = [...seen.values()];

    // Build context once per package
    const ctx: RenderContext = {
      project: { root: projectRoot, name: projectName, version: projectVersion },
      pkg: { name: m?.package?.name, version: m?.package?.version },
      env: process.env,
      now: new Date().toISOString(),
      files: filesMap,
    };

    for (const item of uniqueToRender) {
      const rel = item.relUnderTemplates.replaceAll('\\', '/');
      // Always render to package directory (isolated rendering)
      const dest = computeDestForRel(p.root, rel);
      const destDir = path.dirname(dest);

      // Security: verify destination safety before any operations
      const safety = await evaluateDestinationSafety(projectRoot, dest);
      if (!('safe' in safety) || safety.safe !== true) {
        const code =
          typeof safety === 'object' && 'safe' in safety && !safety.safe
            ? safety.reason
            : 'unsafe-symlink';
        skipped.push(makeSkip(dest, code));
        continue;
      }

      if (opts.verbose) {
        console.log(`[template-renderer] Rendering template: ${item.abs} -> ${dest}`);
      }

      opts.onTemplateStart?.({ templateRel: rel, dest, pkgName: p.name });

      const reporter = opts.onSnippetEvent
        ? (event: SnippetEvent) =>
            opts.onSnippetEvent?.({
              event,
              templateRel: rel,
              dest,
              pkgName: p.name,
            })
        : undefined;

      let destStat: Stats | null = null;
      try {
        destStat = await fs.lstat(dest);
      } catch {
        destStat = null;
      }

      if (!opts.force && destStat?.isFile()) {
        skipped.push(makeSkip(dest, 'exists'));

        // Still track skipped file metadata for symlink manager
        // This ensures symlinks can be recreated even when templates are skipped
        renderedFiles.push({
          pkgName: p.name,
          source: dest,
          dest,
          tool: item.tool,
          isMcpConfig: item.isMcpConfig,
        });

        continue;
      }

      // Determine if this is a literal file (non-.hbs) or a template (.hbs)
      const isLiteralFile = !item.relUnderTemplates.endsWith('.hbs');

      if (isLiteralFile) {
        // Literal file: copy without any template processing
        if (!opts.dryRun) {
          if (destStat) {
            await backupManager.backupFile(dest);
          }
          if (safety.unlinkDestSymlink) {
            try {
              await fs.unlink(dest);
            } catch {
              skipped.push(makeSkip(dest, 'unlink-failed'));
              continue;
            }
          }
          ensureDir(destDir);
          await copyLiteralFile(item.abs, dest);
        }
        written.push(dest);

        // Track literal file metadata for symlink manager
        renderedFiles.push({
          pkgName: p.name,
          source: dest,
          dest,
          tool: item.tool,
          isMcpConfig: item.isMcpConfig,
        });

        // Track files per package for TZ.md generation
        if (!packageFiles.has(p.name)) {
          packageFiles.set(p.name, []);
        }
        packageFiles.get(p.name)!.push(dest);
      } else {
        // Template file: render with Handlebars and snippets
        // Get package version from already-loaded manifest (m is read from p.storePath)
        const pkgVersion = m?.package?.version ?? '0.0.0';

        const renderResult = await renderTemplateWithSnippets(item.abs, ctx, {
          preprocess: {
            projectDir: projectRoot,
            packageDir: p.storePath,
            currentTool: primaryTool,
            availableTools: profileTools,
            toolSafeMode,
            verbose: opts.verbose ?? false,
            dryRun: opts.dryRun ?? false,
            report: reporter,
            cacheManager,
            packageName: p.name,
            packageVersion: pkgVersion,
            noCache: opts.noCache ?? false,
          },
        });

        snippetExecutions.push({
          source: item.abs,
          dest,
          output: renderResult.output,
          preprocess: renderResult.preprocess,
        });

        const failures = collectSnippetFailures(renderResult.preprocess, dest, rel, p.name);
        if (failures.length > 0) {
          snippetFailures.push(...failures);
          continue;
        }

        if (!opts.dryRun) {
          if (destStat) {
            await backupManager.backupFile(dest);
          }
          if (safety.unlinkDestSymlink) {
            try {
              await fs.unlink(dest);
            } catch {
              skipped.push(makeSkip(dest, 'unlink-failed'));
              continue;
            }
          }
          ensureDir(destDir);
          await fs.writeFile(dest, renderResult.output, 'utf8');
        }
        written.push(dest);

        // Track rendered file metadata for symlink manager
        renderedFiles.push({
          pkgName: p.name,
          source: dest, // Use dest as source since files are rendered to package dir
          dest,
          tool: item.tool,
          isMcpConfig: item.isMcpConfig,
        });

        // Track files per package for TZ.md generation
        if (!packageFiles.has(p.name)) {
          packageFiles.set(p.name, []);
        }
        packageFiles.get(p.name)!.push(dest);
      }
    }
  }

  if (snippetFailures.length > 0) {
    throw new TerrazulError(
      ErrorCode.TOOL_EXECUTION_FAILED,
      formatSnippetFailureMessage(projectRoot, snippetFailures),
      { snippetFailures },
    );
  }

  return {
    written,
    skipped,
    backedUp: backupManager.getBackedUpPaths(),
    snippets: snippetExecutions,
    packageFiles,
    renderedFiles,
  };
}
