import { promises as fs } from 'node:fs';
import path from 'node:path';

import { ErrorCode, TerrazulError } from './errors.js';
import { deriveTargetDirFromName, resolveProfileScope, slugifySegment } from '../utils/profile.js';

import type { CLIContext } from '../utils/context.js';
import type { Logger } from '../utils/logger.js';
import type { ToolName } from '../utils/manifest.js';

export interface CreateOptions {
  name: string;
  description: string;
  license: string;
  version: string;
  targetDir: string;
  tools: ToolName[];
  includeExamples: boolean;
  includeHooks: boolean;
  dryRun: boolean;
}

export interface CreateResult {
  created: string[];
  targetDir: string;
  summary: {
    packageName: string;
    version: string;
    toolCount: number;
    fileCount: number;
  };
}

const DEFAULT_VERSION = '0.0.0';
const DEFAULT_LICENSE = 'MIT';
const DEFAULT_SCOPE = 'local';
const TOOL_ORDER: ToolName[] = ['claude', 'codex', 'cursor', 'copilot'];

const GITIGNORE_CONTENT = `node_modules/
agent_modules/
.DS_Store
*.tgz
dist/
`;

const TOOL_EXPORT_TEMPLATES: Record<ToolName, { template: string; contents: string }> = {
  claude: {
    template: 'templates/CLAUDE.md.hbs',
    contents: `# CLAUDE.md

<!-- Add Claude-specific configuration and instructions here. -->
`,
  },
  codex: {
    template: 'templates/AGENTS.md.hbs',
    contents: `# AGENTS.md

<!-- Provide shared agent prompts or workflows for Codex-compatible tools. -->
`,
  },
  cursor: {
    template: 'templates/cursor.rules.mdc.hbs',
    contents: `# Cursor Rules

<!-- Define Cursor-specific rules or instructions. -->
`,
  },
  copilot: {
    template: 'templates/COPILOT.md.hbs',
    contents: `# GitHub Copilot Instructions

<!-- Provide Copilot overrides or instructions. -->
`,
  },
  gemini: {
    template: 'templates/GEMINI.md.hbs',
    contents: `# GEMINI.md

<!-- Add Gemini-specific configuration and instructions here. -->
`,
  },
};

function formatPath(baseDir: string, targetPath: string): string {
  const relative = path.relative(baseDir, targetPath);
  return relative.length === 0 ? './' : `./${relative.replaceAll('\\', '/')}`;
}

async function ensureWritableDirectory(targetDir: string): Promise<boolean> {
  try {
    const stat = await fs.stat(targetDir);
    if (!stat.isDirectory()) {
      throw new TerrazulError(
        ErrorCode.FILE_EXISTS,
        `Path '${formatPath(path.dirname(targetDir), targetDir)}' already exists and is not a directory.`,
      );
    }
    const entries = await fs.readdir(targetDir);
    if (entries.length > 0) {
      throw new TerrazulError(
        ErrorCode.FILE_EXISTS,
        `Directory '${formatPath(path.dirname(targetDir), targetDir)}' already exists and is not empty.`,
      );
    }
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      await fs.mkdir(targetDir, { recursive: true });
      return true;
    }
    throw error;
  }
}

/**
 * Extracts a safe directory name from a package name.
 * This function is tolerant and never throws - it's designed for UI contexts
 * where the user may be typing an incomplete package name.
 *
 * @param packageName - The package name to extract from (may be incomplete)
 * @returns A safe directory name segment, or 'package' as fallback
 *
 * @example
 * getPackageDirName('@owner/my-pkg') // => 'my-pkg'
 * getPackageDirName('@owner') // => 'owner' (partial input)
 * getPackageDirName('owner/pkg') // => 'pkg' (slash extraction)
 * getPackageDirName('@') // => 'package' (fallback)
 */
export function getPackageDirName(packageName: string): string {
  // Try to extract from properly scoped format @owner/name
  const scopedMatch = packageName.match(/^@[^/]+\/(.+)$/);
  if (scopedMatch && scopedMatch[1]?.trim()) {
    return scopedMatch[1];
  }

  // If there's a trailing slash with nothing after it, return default
  if (packageName.endsWith('/')) {
    return 'package';
  }

  // Fallback: if there's a slash, take what's after it
  const slashIndex = packageName.indexOf('/');
  if (slashIndex !== -1 && slashIndex < packageName.length - 1) {
    const segment = packageName.slice(slashIndex + 1).trim();
    if (segment) return segment;
  }

  // Final fallback: slugify the input or return default
  const trimmed = packageName.trim();
  return trimmed ? slugifySegment(trimmed.replace(/^@/, '')) : 'package';
}

export function generateManifest(options: CreateOptions): string {
  const baseSection: string[] = [
    '[package]',
    `name = ${JSON.stringify(options.name)}`,
    `version = ${JSON.stringify(options.version || DEFAULT_VERSION)}`,
    ...(options.description.trim().length > 0
      ? [`description = ${JSON.stringify(options.description)}`]
      : []),
    `license = ${JSON.stringify(options.license || DEFAULT_LICENSE)}`,
    '',
    '[dependencies]',
    '# Add package dependencies here',
    '# "@terrazul/base" = "^1.0.0"',
    '',
  ];

  const sortedTools = [...options.tools].sort(
    (a, b) => TOOL_ORDER.indexOf(a) - TOOL_ORDER.indexOf(b),
  );

  const compatibilitySection: string[] =
    sortedTools.length > 0
      ? ['[compatibility]', ...sortedTools.map((tool) => `${tool} = "*"`), '']
      : [];

  const exportsSection: string[] =
    sortedTools.length > 0
      ? sortedTools.flatMap((tool) => [
          `[exports.${tool}]`,
          `template = "${TOOL_EXPORT_TEMPLATES[tool].template}"`,
          '',
        ])
      : [];

  const examplesSection: string[] =
    options.includeExamples || sortedTools.length === 0
      ? [
          '# [exports]',
          '# uncomment to define additional rendered outputs',
          '# agents = ["agents/*.md"]',
          '# commands = ["commands/*.sh"]',
          '',
          '# [profiles]',
          '# Uncomment to define installation profiles',
          `# default = ["${options.name}"]`,
          '',
        ]
      : [];

  return `${[...baseSection, ...compatibilitySection, ...exportsSection, ...examplesSection].join(
    '\n',
  )}\n`;
}

export function generateReadme(options: CreateOptions): string {
  const description = options.description.trim();
  const body: string[] = [];
  body.push(`# ${options.name}`, '');
  if (description.length > 0) {
    body.push(description, '');
  }
  body.push(
    '## Installation',
    '',
    '```bash',
    `tz add ${options.name}`,
    '```',
    '',
    '## Usage',
    '',
    'Add usage instructions here.',
    '',
    '## Development',
    '',
    '```bash',
    '# Link for local development',
    'tz link',
    '',
    '# Validate package structure',
    'tz validate',
    '',
    '# Publish when ready',
    'tz publish',
    '```',
    '',
    '## License',
    '',
    options.license || DEFAULT_LICENSE,
    '',
  );
  return body.join('\n');
}

function plannedStructure(
  options: CreateOptions,
  includeHooks: boolean,
): {
  directories: string[];
  files: { path: string; contents: string }[];
} {
  const targetDir = path.resolve(options.targetDir);
  const dirs = [
    path.join(targetDir, 'agents'),
    path.join(targetDir, 'commands'),
    path.join(targetDir, 'configurations'),
    path.join(targetDir, 'mcp'),
  ];
  if (includeHooks) dirs.push(path.join(targetDir, 'hooks'));

  const sortedTools = [...options.tools].sort(
    (a, b) => TOOL_ORDER.indexOf(a) - TOOL_ORDER.indexOf(b),
  );

  const templateFiles = sortedTools.map((tool) => {
    const { template, contents } = TOOL_EXPORT_TEMPLATES[tool];
    return { path: path.join(targetDir, template), contents };
  });

  if (templateFiles.length > 0) {
    dirs.push(path.join(targetDir, 'templates'));
  }

  const files = [
    { path: path.join(targetDir, 'agents.toml'), contents: generateManifest(options) },
    { path: path.join(targetDir, 'README.md'), contents: generateReadme(options) },
    { path: path.join(targetDir, '.gitignore'), contents: GITIGNORE_CONTENT },
  ];

  return { directories: dirs, files: [...files, ...templateFiles] };
}

export async function createPackageScaffold(
  options: CreateOptions,
  logger: Logger,
): Promise<CreateResult> {
  const resolvedTarget = path.resolve(options.targetDir);
  const { directories, files } = plannedStructure(options, options.includeHooks);
  const createdPaths: string[] = [];

  if (options.dryRun) {
    const planned = [resolvedTarget, ...files.map((f) => f.path), ...directories];
    return {
      created: planned,
      targetDir: resolvedTarget,
      summary: {
        packageName: options.name,
        version: options.version,
        toolCount: options.tools.length,
        fileCount: files.length,
      },
    };
  }

  const createdBase = await ensureWritableDirectory(resolvedTarget);
  if (createdBase) {
    logger.info(`✓ Created ${formatPath(path.dirname(resolvedTarget), resolvedTarget)}`);
  }
  createdPaths.push(resolvedTarget);

  for (const dir of directories) {
    await fs.mkdir(dir, { recursive: true });
    createdPaths.push(dir);
    logger.info(`✓ Created ${formatPath(resolvedTarget, dir)}`);
  }

  for (const file of files) {
    await fs.writeFile(file.path, file.contents, 'utf8');
    createdPaths.push(file.path);
    logger.info(`✓ Created ${formatPath(resolvedTarget, file.path)}`);
  }

  return {
    created: createdPaths,
    targetDir: resolvedTarget,
    summary: {
      packageName: options.name,
      version: options.version,
      toolCount: options.tools.length,
      fileCount: files.length,
    },
  };
}

export async function deriveDefaultPackageName(
  ctx: Pick<CLIContext, 'config' | 'logger'>,
  cwd: string = process.cwd(),
): Promise<string> {
  const scope = (await resolveProfileScope(ctx)) ?? DEFAULT_SCOPE;
  const dirName = slugifySegment(path.basename(cwd) || 'package');
  return `@${scope}/${dirName}`;
}

export function buildCreateOptionsSkeleton(
  name: string,
  cwd: string,
): Pick<
  CreateOptions,
  | 'name'
  | 'description'
  | 'license'
  | 'version'
  | 'targetDir'
  | 'tools'
  | 'includeExamples'
  | 'includeHooks'
  | 'dryRun'
> {
  const normalizedName = name.trim().length > 0 ? name.trim() : `@${DEFAULT_SCOPE}/package`;
  const targetDir = deriveTargetDirFromName(normalizedName, cwd);

  return {
    name: normalizedName,
    description: '',
    license: DEFAULT_LICENSE,
    version: DEFAULT_VERSION,
    targetDir,
    tools: [],
    includeExamples: false,
    includeHooks: false,
    dryRun: false,
  };
}
