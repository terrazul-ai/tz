<!-- terrazul:begin -->
<!-- Terrazul package context - auto-managed, do not edit -->
@agent_modules/@terrazul/tdd-engineer/CLAUDE.md
@agent_modules/@terrazul/tdd-engineer/AGENTS.md
<!-- terrazul:end -->

# Terrazul CLI — `agents.md`

> A living guide to the repo, its goals, architecture, libraries, testing strategy, and how to build and ship high‑quality code for the Terrazul CLI.

---

## 0) What is this repo?

**Terrazul CLI (`tz`)** is a Node.js + TypeScript command‑line tool that manages **AI agent configuration packages** (non‑executable content like markdown/JSON). It is akin to npm/yarn but tailored for AI config management:

- **Fast**: CDN-first tarballs (\~15KB), content‑addressable cache, parallel downloads
- **Safe**: no executable code in packages, strict hashing, path‑traversal protections
- **Deterministic**: SAT-based dependency resolution + lockfile for reproducible installs
- **Tool‑agnostic**: integration layer (e.g., Claude Code MCP) via symlinks and settings merge
- **Offline‑first**: local cache and lockfile enable repeatable operations without the network

V0 ships against a **dummy registry API** to exercise the full path end‑to‑end.

---

## 1) Goals & Non‑Goals

### Goals (v0)

- Clean, modular architecture with well‑isolated layers
- Strict TypeScript types and `zod` validation at all boundaries
- Cross‑platform behavior (Linux/macOS/Windows)
- Deterministic I/O (reliable installs, reproducible lockfile)
- End‑to‑end flow using a local **dummy registry**
- Comprehensive tests: unit, integration, E2E (+ basic perf sanity)
- Single bundled binary (`dist/tz.mjs`, ESM w/ shebang + require shim) for easy global install

### Non‑Goals (v0)

- Real production registry integration (use dummy now)
- Plugin system (design for later, stub interfaces only)
- Telemetry (flag present, default off)
- UI beyond CLI (web platform handled separately)

---

## 2) Design Principles

- **Developer‑first UX**: Commands feel familiar (npm/yarn‑like)
- **Security by design**: No executable payloads, strict hashing, HTTPS‑only (except localhost)
- **Functional Core / Imperative Shell**:
  Thin **`commands/`** for I/O; business logic in **`core/`**; pure helpers in **`utils/`**
- **Dependency Injection**: `createCLIContext()` wires logger, config, registry, storage, resolver
- **Offline‑first**: content‑addressable cache, lockfile integrity hashes, local metadata
- **Performance**: small packages, parallel downloads (cap 5), cache TTLs, CDN redirects
- **Portability**: TypeScript/ESM source → **bundled ESM** output for modern Node (22+)

---

## 3) Repository Layout

```
cli/
├─ package.json
├─ tsconfig.json
├─ build.config.mjs                # esbuild -> dist/tz.mjs (ESM + shebang)
├─ vitest.config.ts
├─ .github/workflows/ci.yml
├─ src/
│  ├─ index.ts                     # command wiring (commander)
│  ├─ commands/                    # Imperative shell only
│  │  ├─ init.ts
│  │  ├─ add.ts
│  │  ├─ update.ts
│  │  ├─ publish.ts
│  │  ├─ auth.ts
│  │  ├─ run.ts
│  │  └─ yank.ts
│  ├─ core/                        # Business logic (testable)
│  │  ├─ package-manager.ts
│  │  ├─ dependency-resolver.ts
│  │  ├─ lock-file.ts
│  │  ├─ registry-client.ts
│  │  ├─ storage.ts
│  │  └─ errors.ts
│  ├─ integrations/                # Tool-specific adapters
│  │  ├─ base.ts
│  │  ├─ claude-code.ts
│  │  └─ detector.ts
│  ├─ utils/                       # Pure helpers; no side effects
│  │  ├─ config.ts
│  │  ├─ auth.ts
│  │  ├─ fs.ts
│  │  ├─ hash.ts
│  │  ├─ logger.ts
│  │  └─ terrazul-md.ts
│  └─ types/
│     ├─ package.ts
│     ├─ config.ts
│     └─ api.ts
├─ tests/
│  ├─ setup/
│  │  ├─ env.ts
│  │  ├─ tmp.ts
│  │  └─ server.ts                 # in-process dummy registry
│  ├─ unit/
│  ├─ integration/
│  ├─ e2e/
│  └─ perf/
├─ tools/
│  ├─ dummy-registry.ts            # manual runs
│  └─ make-fixtures.ts             # build tarball fixtures
└─ fixtures/
   ├─ packages/@terrazul/starter/1.0.0.tgz
   └─ work/@terrazul/starter/**    # source for fixtures
```

---

## 4) Technology Stack & Libraries

### Runtime & Language

- **Node.js 18+** (native fetch, fs/promises)
- **TypeScript 5+** (strict mode)
- **ESM source → ESM bundle** with require shim for compatibility

### Core Dependencies

- `commander` – CLI framework
- `chalk` – colored output
- `ink` – React-based terminal UI framework for interactive components and loading indicators
- `@iarna/toml` – lockfile & manifest
- `semver` – version ranges/comparison
- `tar` – compression/extraction
- `minisat` – SAT solver for dependency resolution
- `inquirer` – interactive prompts (init, auth)
- `zod` – runtime validation (config, API responses)

### Dev Dependencies

- `esbuild` – fast bundling to single ESM file
- `vitest` – tests (unit/integration/e2e)
- `tsx` – local execution of TS tools

> Avoid adding runtime deps without an ADR. Keep the surface small and testable.

### Linting & Formatting

- **Linter**: ESLint (TypeScript‑aware; Node 18+, Import, Promise, Unicorn, eslint‑comments).
- **Formatter**: Prettier; ESLint defers styling via `eslint-config-prettier`.
- **Type‑aware config**: `tsconfig.eslint.json` includes `src`, `tests`, `tools`, and config files.
- **Scripts**: `lint`, `lint:fix`, `format`, `format:check`.
- **Policy**: Zero warnings (`--max-warnings 0`); CI runs lint and format check before build/test.
- **Notes**: `security/detect-object-injection` disabled initially; tests relax unsafe rules and `no-undef` for Vitest globals.

---

## 5) Core Domains

### `commands/` (imperative shell)

- Parse CLI args (commander), show loading indicators (Ink), call core services, render user messages
- **No business logic**: orchestration only
- Must accept a **context** (`createCLIContext()`) for DI and testability
- Commands that involve `askAgent` operations (apply, run, add) use `AskAgentSpinner` component for live progress feedback

### `core/` (business logic)

- `package-manager.ts` – install/update orchestration, atomic swaps
- `dependency-resolver.ts` – minisat CNF build; yanked handling; prefer latest
- `registry-client.ts` – fetch JSON, follow CDN redirects for tarballs, auth headers
- `storage.ts` – CAS cache, SHA‑256, safe tar extraction (no path traversal/symlinks)
- `lock-file.ts` – read/write deterministic TOML (`sha256-<base64>` integrity)
- `errors.ts` – `TerrazulError` taxonomy mapping

### `integrations/`

- `claude-code.ts` – merge MCP servers into `.claude/settings.local.json`, idempotent
- `detector.ts` – detect tool presence (`.claude/`)
- `symlink-manager.ts` – create/remove namespaced symlinks for agents/, commands/, hooks/, skills/ files from agent_modules to .claude/ directories; tracks ownership in registry file

### `utils/`

- `config.ts` – `~/.terrazul/config.json` with 0600 perms (Unix); `zod` schema
- `auth.ts` – login/logout stubs; localhost callback + manual paste fallback; token refresh shape
- `fs.ts` – `exists()`, symlink/junction fallback for Windows
- `hash.ts` – hex/base64 helpers
- `logger.ts` – info/warn/error/debug with `--verbose`
- `context-file-injector.ts` – inject/remove package context @-mentions in CLAUDE.md/AGENTS.md

### `types/`

- `api.ts` – API envelope types (`APISuccessResponse`, `APIErrorResponse`)
- `package.ts` – `PackageMetadata`, `VersionInfo` etc.
- `config.ts` – `UserConfig` schema typings

### `ui/` (terminal UI components)

- `ui/apply/AskAgentSpinner.tsx` – Ink-based loading indicator for askAgent operations
  - Shows animated Braille spinner for running tasks
  - Displays AI-generated summary of what askAgent is doing (via Claude Haiku 4.5)
  - Supports multiple concurrent operations with status tracking (running/complete/error)
  - Automatically shows in TTY, falls back to simple logs in non-TTY environments
- `ui/extract/ExtractWizard.tsx` – Full-screen interactive extraction wizard
- `ui/extract/components.tsx` – Reusable Ink components (WizardFrame, SelectableList, etc.)
- `ui/create/CreateWizard.tsx` – Interactive package scaffolding wizard
- `ui/logger-adapter.ts` – Adapts logger for Ink rendering

**AskAgent Loading Pattern**:
Commands that call `planAndRender` (`apply`, `run`, `add`) show an Ink spinner during askAgent execution:

1. Spinner appears immediately with generic "Processing..." title
2. Background task calls `generateAskAgentSummary()` using Claude Haiku 4.5
3. Title updates asynchronously when summary is ready (typically 1-2 seconds)
4. Falls back to truncated original prompt if summary generation fails
5. Shows completion (✓) or error (✗) status when done
6. Automatically cleans up after brief delay to show final state

---

## 6) Build & Distribution

- **esbuild** bundles to `dist/tz.mjs` (ESM) with shebang:

  ```js
  banner: {
    js: '#!/usr/bin/env node';
  }
  ```

- `pnpm publish` with `files: ["dist", "README.md"]`
- Users install with:

  ```bash
  pnpm i -g terrazul
  ```

- (Later) Optional Homebrew/Scoop/AUR manifests

- Self‑contained binaries (SEA):
  - GitHub Releases attach platform builds created via Node SEA for Linux/macOS/Windows.
  - Artifacts are named `tz-<os>-<arch>` (e.g., `tz-linux-x64`, `tz-macos-arm64`, `tz-windows-x64.exe`).
  - Release workflow builds `dist/tz.mjs`, generates a SEA blob, injects into the Node runtime, and uploads binaries + SHA‑256 checksums.

---

## 7) Configuration & Auth

- Config path: `~/.terrazul/config.json` (0600 perms on Unix)
- Fields:

  ```ts
  {
    registry: string;         // default https://staging.api.terrazul.com during active development
    token?: string;           // tz_eM94WWtBUtF1DbuojEOvRko1TU088vIK during active development
    refreshToken?: string;    // tz_refresh_...
    tokenExpiry?: number;     // epoch seconds
    username?: string;
    cache: { ttl: 3600, maxSize: 500 };
    telemetry: false;         // opt-in
  }
  ```

- **Env override**: `TERRAZUL_TOKEN` for CI (read-only; not persisted)
- **Staging token**: `tz_eM94WWtBUtF1DbuojEOvRko1TU088vIK` (staging-only; valid for 365 days; never commit it outside private Terrazul repos)
- **Auth flow** (v0 stub):
  - Start local callback server and open browser OR manual paste
  - Validate prefixes `tz_token_`, `tz_refresh_`
  - Save tokens securely; refresh stubbed in dummy mode

---

## 8) Package Format & Lockfile

### `agents.toml` (manifest)

- Includes `[package]`, `[dependencies]`, `[compatibility]`, `[scripts]`
- Example:

  ```toml
  [package]
  name = "@username/package-name"
  version = "1.0.0"

  [dependencies]
  "@terrazul/base" = "^2.0.0"

  [compatibility]
  claude-code = ">=0.2.0"

  [profiles]
  focus = ["@username/package-name"]
  ```

- `[profiles]` is optional and maps profile names to the packages that should render when the
  profile is active. Profiles are mutually exclusive at runtime; `tz apply --profile focus` and
  `tz run --profile focus` only render packages listed under `focus`. When a package is installed
  with `tz add --profile focus @scope/name@1.0.0`, the CLI automatically appends it to the
  specified profile in `agents.toml`.

- `[exports.<tool>]` sections define template files and directories to render for each tool:
  - `template` - Main template file path (e.g., `"templates/CLAUDE.md.hbs"`)
  - `subagentsDir` - Directory containing agent files (e.g., `"templates/agents"`)
  - `commandsDir` - Directory containing command files (e.g., `"templates/commands"`)
  - `skillsDir` - Directory containing skill files (e.g., `"templates/skills"`)
  - `promptsDir` - Directory containing prompt files for askAgent snippets (e.g., `"templates/prompts"`)
  - `settings`, `settingsLocal` - Tool-specific configuration files
  - `mcpServers` - MCP server configuration file

### `agents-lock.toml`

- Deterministic, includes:
  - `version` (lock format, currently 1)
  - `packages[name] = { version, resolved, integrity, dependencies, yanked?, yanked_reason? }`
  - `metadata = { generated_at, cli_version }`

- `integrity` uses **`sha256-<base64>`**

---

## 9) Storage Manager

- CAS layout under `~/.terrazul/cache/sha256/<prefix>/<rest>`
- Extraction to `~/.terrazul/store/_scope_pkg/version` and symlinks into project `agent_modules/`
- **Security**:
  - Reject tar entries with absolute paths, `..` traversal, or symlink members
  - Normalize paths cross‑platform
  - Clear exec bits on extract unless explicitly allowed policy

---

## 10) Dependency Resolver (SAT + Semver)

- **CNF encoding**:
  - Var per (package, version)
  - **AtMostOne** per package: pairwise `(!a ∨ !b)`
  - Dependency implications: `select X@v -> (Y@v1 ∨ Y@v2 …)` based on semver ranges
  - Roots must have at least one version selected

- **Prefer latest**: minisat decision order sorted by semver desc per package
- **Yanked policy**:
  - Skip yanked by default
  - Allow yanked only when pinned by lock (`allowYankedFromLock = true`), emit warning

---

## 11) Registry Client & API Conventions

- **Base URL**: `config.registry` (dummy server for automated tests)
- **Staging registry**: During day-to-day development we run integration smoke tests against `https://staging.api.terrazul.com` (Swagger reference: `https://staging.api.terrazul.com/swagger/index.html#/packages/get_packages_v1`) to mirror production traffic patterns before shipping.
- **Endpoints** (dummy):
  - `GET /packages/v1/:name` → package info
  - `GET /packages/v1/:name/versions` → version list
  - `GET /packages/v1/:name/tarball/:version` → `{ url }` redirect to CDN path
  - `POST /packages/v1/:name/publish`, `POST /yank/:version`, `POST /unyank/:version`

- **Auth**: Bearer `Authorization: Bearer tz_token_...`
- **Error envelope**: standard `success/data/error/meta`; map to `TerrazulError`
- **HTTPS‑only** (except `http://localhost:*` during tests)

---

## 12) Commands

- `tz init` – Create `agents.toml`, detect `.claude/`, update `.gitignore`
- `tz add [@scope/name@range]` – Resolve, download (CDN), verify SHA‑256, extract to `agent_modules/`, render templates to package directory, inject @-mentions into CLAUDE.md/AGENTS.md, write lockfile. Use `--profile <name>` to append the added package to a manifest profile.
- `tz uninstall [package]` – Remove package from `agent_modules/`, clean up integration symlinks from .claude/ directories, remove @-mentions from CLAUDE.md/AGENTS.md, update manifests and lockfile; also prunes the package from any manifest profiles.
- `tz update [package] [--dry-run]` – Highest compatible non‑yanked versions; atomic replacement; regenerate lockfile and update @-mentions
- `tz publish` – Validate structure; build tarball; POST to registry
- `tz yank @pkg@version` / `tz unyank @pkg@version` – Hide/restore package versions from new installs
- `tz extract --from .claude --out ../pkg --name @user/pkg --pkg-version 0.1.0` – Extract AI configs into publishable package scaffold
- `tz create [name]` – Interactive wizard to scaffold a new AI agent package (supports `--dry-run` and `TZ_CREATE_AUTOFILL` automation)
- `tz link [@user/package]` – Register local package for development (like `npm link`)
- `tz unlink [package]` – Remove local development link, restore to published version
- `tz validate [--offline]` – Validate package structure, manifest, and dependencies
- `tz run [@owner/package@version] [--force] [--profile <name>]` – Auto-install package if needed, render templates (skip if files exist unless --force), and launch Claude Code with aggregated MCP config. Use `--profile <name>` to limit rendering to a single manifest profile.
- `tz auth login|logout` – Store/clear tokens, 0600 perms
- `tz login` / `tz logout` – Top-level aliases for auth commands

### `tz uninstall [package]`

**Purpose**: Remove a package from `agent_modules/` and clean up all references.

**Behavior**

1. Removes directory `./agent_modules/<pkg>/` (or scoped path).
2. Removes namespaced symlinks created for integrations (e.g., `.claude/agents/@scope-pkg-*.md`, `.claude/commands/@scope-pkg-*.md`).
3. Removes @-mentions from `CLAUDE.md` and `AGENTS.md` (if present).
4. Updates `agents.toml` (remove from `[dependencies]` if present).
5. Updates `agents-lock.toml` (remove entry and its transitive deps **only if no other package requires them**; otherwise keep).
6. Leaves cache intact in `~/.terrazul/` so reinstalls are fast.

**Acceptance Criteria**

- Package directory and integration symlinks are removed.
- @-mentions removed from `CLAUDE.md` and `AGENTS.md`.
- `agents.toml` and `agents-lock.toml` are updated consistently.
- No orphaned symlinks remain.
- Command is idempotent (running twice is a no‑op).

---

### `tz extract`

**Purpose**: Extract AI configurations from a project into a publishable package.

**Syntax**

```
tz extract --from .claude --out ../my-package --name @user/pkg --pkg-version 0.1.0
```

**Behavior**

1. Reads a source root (default `.claude`) and copies recognized subtrees to a **new** package scaffold:
   - `configurations/`, `agents/`, `commands/`, `hooks/`, `mcp/`, `README.md`.

2. Generates `agents.toml` with `[package]`, optional `[compatibility]`, and empty `[dependencies]`.
3. Preserves directory structure; ignores binary/build artifacts.
4. Validates result with `tz validate`.

**Acceptance Criteria**

- Complete scaffold created under `--out` with correct layout.
- `agents.toml` generated and valid.
- Selected directories fully copied; relative paths preserved.
- `tz validate` passes on the result.

---

### `tz create`

**Purpose**: Scaffold a new Terrazul package via an interactive wizard or scripted automation.

**Behavior**

1. Wizard presents four steps: metadata → tool compatibility → options → review.
2. Defaults package name to `@{username}/{cwd-basename}` (or `@local/{cwd-basename}` when no username is configured).
3. Generates `agents.toml`, `README.md`, `.gitignore`, and empty directories (`agents/`, `commands/`, `configurations/`, `mcp/`; optionally `hooks/`).
4. Adds selected tools (claude, codex, cursor, copilot) to `[compatibility]` with wildcard ranges.
5. Supports `--dry-run` to preview the scaffold without writing files.
6. Accepts `TZ_CREATE_AUTOFILL` JSON for non-interactive runs (fields: `description`, `license`, `tools`, `includeExamples`, `includeHooks`, `dryRun`, `submit`, `cancel`).

**Acceptance Criteria**

- Wizard navigation mirrors `tz extract` (Tab/Shift+Tab, Space, Enter, Esc, double Ctrl+C to cancel).
- Generated manifests include `[compatibility]` when tools are selected; dry-run mode only logs planned outputs.
- Non-empty target directories throw a `FILE_EXISTS` error with guidance.
- Automation payloads can create or preview scaffolds without a TTY.
- Success output lists created files and recommended next steps (cd, link, validate, publish).

---

### `tz link`

**Purpose**: Develop locally like `npm link`.

**Behavior**

- **In a package directory** (the local package): `tz link` registers the package in a global link registry `~/.terrazul/links.json` mapping `@user/package` → absolute path.
- **In a project directory**: `tz link @user/package`
  - Reads link registry; creates symlink in `./agent_modules/@user/package` to the local source directory.
  - Marks package as “linked” in `agents.toml` (e.g., `[linked]` table or a `linked = true` flag per dep).

**Acceptance Criteria**

- `~/.terrazul/links.json` updated.
- Symlink exists in `agent_modules/` (junction/copy fallback on Windows).
- `agents.toml` records that the dependency is linked.
- Idempotent: re‑running does not duplicate or break links.

---

### `tz unlink [package]`

**Purpose**: Remove a local development link.

**Behavior**

- Removes symlink from `agent_modules/`.
- Removes entry from `~/.terrazul/links.json` (only when run inside the linked package directory, unless `--global`).
- Removes “linked” marker in `agents.toml`.
- Leaves lockfile state otherwise unchanged; user may run `tz add` to reinstall the published version.

**Acceptance Criteria**

- Symlink removed; link registry updated.
- `agents.toml` no longer marks the package as linked.
- Reinstall of published version succeeds.

---

### `tz validate`

**Purpose**: Validate a package’s structure, manifest, and references.

**Behavior**

1. Validates `agents.toml` with `zod`:
   - `[package]` fields present (`name`, `version`, `license`, etc.).
   - Semver is valid; scoped name format enforced.
   - `[dependencies]` versions use valid semver/ranges.
   - `[compatibility]` keys/values are strings.

2. Validates filesystem layout:
   - Allowed dirs: `configurations/`, `agents/`, `commands/`, `hooks/`, `mcp/`, `README.md`.
   - All content under `templates/` is allowed.
   - No disallowed executables outside `commands/`.

3. Optional (online): resolve dependencies exist in registry (skippable with `--offline`).
4. Prints actionable **errors** and **warnings**; exit non‑zero on errors.

**Acceptance Criteria**

- Reports syntax/structure errors and warnings clearly.
- Exit code 0 when valid; non‑zero when invalid.

---

### `tz unyank [package@version]`

**Purpose**: Reverse a yank operation to re‑enable new installs.

**Behavior**

- Requires authentication and ownership.
- Calls registry `POST /packages/v1/{name}/unyank/{version}`.
- Version becomes visible to new resolutions immediately.

**Acceptance Criteria**

- API call succeeds, version visible to `install/update`.
- Clear confirmation message shown.

---

### `tz login` / `tz logout`

**Purpose**: Top‑level aliases of auth flows for convenience.

**Behavior**

- `tz login` ≡ `tz auth login` (browser + manual fallback).
- `tz logout` ≡ `tz auth logout` (server‑side invalidation + local token removal).
- Respect `~/.terrazul/config.json` (0600) and default registry URL if absent.

**Acceptance Criteria**

- Commands appear in `tz --help`.
- Functionally equivalent to `auth` subcommands.
- Tokens handled securely; success messages show username.

---

### `tz run [@owner/package@version | <path>]`

**Purpose**: Install (if needed), render templates, and execute with Claude Code integration.

**Syntax**

```bash
# Run from registry (auto-install if needed)
tz run [@owner/package@version] [--force] [--profile <name>] [--tool <tool>] [--no-tool-safe-mode]

# Run from local filesystem path
tz run <path> [--force] [--tool <tool>] [--no-tool-safe-mode]
tz run ~/my-package
tz run ./local-dev-package
tz run /absolute/path/to/package
```

**Behavior**

1. **Registry packages**: Auto-installs from registry if not present, then renders templates
   - Resolves dependencies using SAT solver
   - Downloads tarballs from registry
   - Extracts to store and creates symlinks
   - Updates lockfile and manifest

2. **Local filesystem paths**: Runs packages directly from local directories (perfect for development)
   - Detects absolute paths, relative paths (`./`, `../`), or tilde paths (`~/`)
   - Validates package has valid `agents.toml` with `name` and `version`
   - Uses local path as template source (read-only)
   - Creates directory in `agent_modules/` for rendered output
   - **Does NOT update lockfile** (local packages are ephemeral)
   - **Always uses latest local content** (automatically forces re-rendering)
   - Mutually exclusive with `--profile` option

3. **Smart rendering**: Renders templates from the specified package (or all packages if no spec provided):
   - **Skip mode** (default for registry packages): Skips rendering if output files already exist
   - **Force mode** (automatic for local paths, or use `--force`): Re-renders all templates even if files exist
   - All files render to `agent_modules/<scope>/<package>/` following package directory structure
   - Respects snippet cache to avoid re-prompting for askUser/askAgent
   - Uses Ink spinner for live askAgent progress feedback

4. **Context injection**: After rendering, injects @-mentions into project CLAUDE.md/AGENTS.md:
   - Only includes CLAUDE.md and AGENTS.md files from packages (filtered to avoid context pollution)
   - Uses HTML comment markers for idempotent injection
   - Paths are relative to project root (e.g., `@agent_modules/@scope/pkg/CLAUDE.md`)

5. **Symlink creation**: Creates namespaced symlinks for operational files:
   - Scans rendered agents/, commands/, hooks/, skills/ directories in agent_modules
   - Creates symlinks in .claude/ directories with pattern `@scope-pkg-filename.md`
   - Tracks ownership in `.terrazul/symlinks.json` registry for cleanup
   - Excludes CLAUDE.md, AGENTS.md, and MCP config files (handled separately)

6. **Profile support**: Use `--profile <name>` to limit rendering to packages in a specific manifest profile (registry packages only)

7. **Claude Code integration** (planned): After rendering completes:
   - Aggregates MCP server configs from rendered packages
   - Generates temporary MCP config file
   - Spawns Claude Code with `--mcp-config` flag
   - Forwards additional args after `--`

**Examples**

```bash
# Run all installed packages (render and execute)
tz run

# Run specific registry package (auto-install if needed, then render and execute)
tz run @terrazul/starter@^1.1.0

# Run specific package with force re-rendering
tz run @terrazul/starter --force

# Run only packages in "focus" profile
tz run --profile focus

# Run local package for development (always re-renders)
tz run ~/projects/my-agent-package

# Run relative local package
tz run ../shared-configs

# Run absolute path local package
tz run /Users/username/dev/custom-agent
```

**Acceptance Criteria**

- Auto-installs package if spec provided and not present in `agent_modules/`
- Detects filesystem paths vs. package specs correctly
- Validates local package structure (agents.toml required)
- Templates read from local path, rendered to `agent_modules/<scope>/<package>/`
- Injects @-mentions for CLAUDE.md/AGENTS.md into project files (filtered, no MCP configs)
- Creates namespaced symlinks for agents/, commands/, hooks/, skills/ in .claude/ directories
- Tracks symlink ownership in registry for cleanup
- No lockfile pollution for local packages
- Local packages automatically force re-rendering to reflect latest changes
- Errors clearly if path doesn't exist or lacks valid manifest
- Cannot combine path argument with `--profile`
- Skips rendering by default if output files exist (registry packages only); re-renders with `--force`
- Updates lockfile and manifest when auto-installing
- Shows Ink spinner for askAgent operations with live summaries
- Respects snippet cache for askUser/askAgent responses
- Profile support limits rendering to specified manifest profile
- (Future) Claude Code integration aggregates MCP configs and spawns process

---

## 13) Security Considerations

- **Package validation**: block executable code or strip exec bits by policy
- **Tar safety**: reject absolute/parent paths; disallow symlink/file devices; normalize separators
- **Token security**: 0600 on Unix; never echo secrets; refresh via secure path (future)
- **Network**: HTTPS only (except local dummy); honor proxy envs
- **Yanked versions**: never used for new resolutions; allowed only from existing locks with warning

---

## 14) Testing Strategy

We aim for **high coverage** on core logic and **deterministic** integration/e2e runs.

### Test Types

- **Unit**: pure modules in `utils/` and `core/` (hashing, lockfile, resolver, storage validation)
- **Integration**: real command invocations in temp dirs against **in‑process dummy registry**
- **E2E**: `init → install → update` and `publish → install → run`
- **Perf (sanity)**: 10 small fixtures install under a threshold (skippable)

### Test Utilities

- `tests/setup/server.ts` – starts/stops dummy registry (random port)
- `tests/setup/tmp.ts` – temp dir helpers, cross‑platform safe cleanup
- Command runner that spawns `node dist/tz.mjs` with env/cwd overrides

### Test Catalog (condensed)

- **Config**: defaults, read/write, 0600 perms (Unix), env override
- **Logger**: verbosity gating
- **Hash/FS**: sha256 hex/base64; `exists()`, symlink/junction fallback (stub)
- **Storage**: CAS store/retrieve, verify; safe extract; reject traversal/symlink; duplicate entries policy
- **Lockfile**: TOML round‑trip, merge without loss; `sha256-<base64>`; deterministic order
- **Registry client**: auth header; redirect to CDN; 401 handling; error mapping
- **Resolver**: basic, multiple, transitive, conflicts, prefer‑latest, yanked rules, no candidates
- **Commands/init**: manifest + `.gitignore`; compatibility when `.claude/` exists
- **Commands/install**: explicit spec & manifest; integrity mismatch abort; idempotency; parallel cap
- **Commands/update**: dry‑run plan; atomic swap; respect semver/yanked
- **Commands/run**: auto-install if missing; skip rendering if files exist; force re-render with --force; profile support; specific package vs all packages
- **Publish**: structure validation; executable policy enforcement
- **Yank/Unyank**: visibility flip; lock allows old version with warning
- **Integrations/Claude**: MCP config aggregation; duplicate server detection; malformed config handling
- **Security**: HTTPS‑only (except localhost), tarbomb prevention
- **Perf**: parallel installs within target (skippable on CI if flaky)

CI matrix runs on **Linux/macOS/Windows** with **Node 18+**, sourced from `.nvmrc` via `actions/setup-node`.

---

## 15) Local Development Quickstart

```bash
# Install deps
pnpm ci

# Build CLI
pnpm run build

# Start dummy registry (terminal 1)
node tools/dummy-registry.ts

# Point CLI to dummy registry (edit ~/.terrazul/config.json)
# { "registry": "http://localhost:8787", "cache": { "ttl": 3600, "maxSize": 500 }, "telemetry": false }

# Initialize a project (terminal 2, test dir)
mkdir /tmp/tz-demo && cd /tmp/tz-demo
node ../../dist/tz.mjs init
node ../../dist/tz.mjs install @terrazul/starter@^1.0.0
```

Run tests:

```bash
pnpm test
```

---

## 16) CI & Quality Gates

- **Matrix**: Ubuntu, macOS, Windows × Node 18+ (read from `.nvmrc`)
- **Steps**: checkout → setup node → install → lint → format:check → build → test
- **Artifacts**: upload `dist/tz.mjs` for smoke verification
- **Smoke**: `node dist/tz.mjs --help`
- **SEA (main only)**: Separate job on pushes to `main`/`master` runs `pnpm run test:sea` to build the SEA blob, inject, and execute the binary. Uploads `dist/tz-sea*` and `dist/sea-prep.blob` as artifacts (named `tz-sea-${{ runner.os }}-${{ runner.arch }}`).
- **SEA (PRs)**: Lightweight job on pull requests runs `pnpm run test:sea -- --blob` (blob-only; no injection/signing) to catch regressions earlier with minimal runtime.
- **Coverage gates**: target ≥85% lines, ≥80% branches in `core`/`utils`

### Formatting & Linting

- To auto-fix formatting, run:

  ```bash
  pnpm run format
  ```

- To check formatting (CI uses this), run:

  ```bash
  pnpm run format:check
  ```

- To auto-fix ESLint issues, run:

  ```bash
  pnpm run lint:fix
  ```

Notes:

- Do not pass `--fix` to `pnpm run format:check`. `--fix` is an ESLint flag. Passing it to Prettier check causes: `No files matching the pattern were found: "--fix"`.
- If you see warnings like `Code style issues found in X files. Run Prettier with --write to fix.`, run `pnpm run format` locally, commit the changes, and re-run checks.

---

## 17) Contribution Workflow

- Small PRs per milestone/task
- Include:
  - Files-changed tree
  - Rationale and notes
  - Install missing type errors
  - Do not skip over linting issues
  - Tests (unit/integration/e2e as applicable)
  - Docs updates (README/this file)
  - ADRs for notable decisions or new deps (`/docs/adr/000x-*.md`)

- **Type/Lint/Format loop** (required before opening a PR):
  1. Run `pnpm tsc` and fix every reported error.
  2. Run `pnpm lint:fix` and address any remaining lint violations.
  3. Finish by running `pnpm format` to normalize formatting.

- Keep commands thin; put logic in `core`; write JSDoc for public functions

---

### Conventional Commits

- Enforced for PR titles via Semantic Pull Request workflow.
- Types: `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `build`, `ci`, `chore`.
- Optional scopes: `core`, `commands`, `utils`, `integrations`, `storage`, `resolver`, `registry`, `lockfile`, `release`, `ci`.
- Format: `<type>[!][(scope)]: <subject>`
- Breaking change: add `!` after type or include `BREAKING CHANGE:` in the body.
- Examples:
  - `feat(core): add SAT resolver`
  - `fix(storage): strip exec bits on extract`
  - `feat!: change lockfile format`

Release automation

- Release Please reads commit history and opens a release PR.
- Merging the release PR creates a SemVer tag and GitHub Release.
- Tag triggers the release workflow to attach `dist/tz.mjs` and SEA binaries.

---

### Conventional Commits

- Enforced for PR titles via Semantic Pull Request workflow.
- Types: `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `build`, `ci`, `chore`.
- Optional scopes: `core`, `commands`, `utils`, `integrations`, `storage`, `resolver`, `registry`, `lockfile`, `release`, `ci`.
- Format: `<type>[!][(scope)]: <subject>`
- Breaking change: add `!` after type or include `BREAKING CHANGE:` in the body.
- Examples:
  - `feat(core): add SAT resolver`
  - `fix(storage): strip exec bits on extract`
  - `feat!: change lockfile format`

Release automation

- Release Please reads commit history and opens a release PR.
- Merging the release PR creates a SemVer tag and GitHub Release.
- Tag triggers the release workflow to attach `dist/tz.mjs` and SEA binaries.

---

## 18) Roadmap (milestones)

- **M0** – Foundation (tooling, build, CI)
- **M1** – CLI skeleton, config, logging, auth shell
- **M2** – Storage, lockfile, install (dummy API E2E)
- **M3** – SAT resolver, yanked handling, update
- **M4** – Publish/yank/unyank, Claude integration, run
- **M5** – Hardening, perf, distribution polish

Each milestone lands with code + tests + docs; see test catalog for exit criteria.

---

## 19) Error Taxonomy (selected)

```ts
enum ErrorCode {
  NETWORK_ERROR = 'NETWORK_ERROR',
  AUTH_REQUIRED = 'AUTH_REQUIRED',
  PACKAGE_NOT_FOUND = 'PACKAGE_NOT_FOUND',
  VERSION_CONFLICT = 'VERSION_CONFLICT',
  VERSION_YANKED = 'VERSION_YANKED',
  PERMISSION_DENIED = 'PERMISSION_DENIED',
  INVALID_PACKAGE = 'INVALID_PACKAGE',
  TOKEN_EXPIRED = 'TOKEN_EXPIRED',
}
```

### Keep this file up to date

When adding features or changing behavior, update **`agents.md`**, the **test catalog**, and, if needed, add an **ADR**. Consistent documentation and tests keep the CLI maintainable and safe to evolve.

### Test-Driven Development Workflow

- Prefer fast, targeted unit tests during development:
  - Run a single test file: `pnpm test tests/unit/path/to_test.ts`
  - Filter by keyword: `pnpm test -- --reporter=verbose --grep="keyword"`
  - Watch mode for rapid iteration: `pnpm test -- --watch tests/unit/path/to_test.ts`
- Run integration tests later, when changes stabilize:
  - Integration tests start a dummy registry via in-process server and are slower.
  - Command: `pnpm test tests/integration`
- Full suite before task completion (time permitting): `pnpm test`

### Test-First Workflow (Required)

- Plan tests before coding:
  - Identify scope (unit vs. integration vs. e2e), mocks/fixtures, and success/error cases.
  - Prefer unit tests for `core/` and `utils/`; reserve integration tests for command orchestration.
  - Use e2e tests only for full CLI workflows (`init → install → update`).
- Write tests first:
  - Add/modify tests under `tests/unit/...` (or `tests/integration/...` only if required).
  - Do not remove or weaken existing tests without justification.
  - Follow existing test patterns: use `describe/it` blocks, proper `beforeEach/afterEach` cleanup.
- Tight TDD loop on the target file(s):
  - Run a single file: `pnpm test tests/unit/path/test_*.ts`
  - Or with watch mode: `pnpm test -- --watch tests/unit/path/test_*.ts`
  - Or keyword filter: `pnpm test -- --reporter=verbose --grep="specific test name"`
  - Implement minimal code changes, rerun, repeat until green.
- Add integration tests later if needed, then verify with `pnpm test tests/integration`.

## IMPORTANT - Contributing Requirements

IMPORTANT IMPORTANT IMPORTANT

Before completing any task:

- **Test-First Development**: Follow the Test-First Workflow (Required) outlined in section 14
  - Plan and write tests before implementing features
  - Use tight TDD loops with `pnpm test -- --watch` for rapid iteration
  - Prefer unit tests for `core/` and `utils/`; integration tests for command orchestration

IMPORTANT IMPORTANT IMPORTANT, REQUIRED RUN AND FIX ANY ERRORS FROM

- **Build & Test & Lint**: Run the following commands to ensure your changes don't break the codebase:
  - `pnpm run build`
  - `pnpm run typecheck`
  - `pnpm run lint:fix`
  - `pnpm run format`
  - `pnpm test`

- **Zero Lint Errors**: Address all linting errors and warnings - the CI enforces `--max-warnings 0`
- **Format Code**: Run `pnpm run format` to ensure consistent code style
- (IMPORTANT) **Comprehensive Testing**: Include unit, integration, and e2e tests as appropriate for your changes
- (IMPORTANT) **Quality Focus**: Ensure your implementation meets the final deliverable requirements and user expectations

---

## Appendix: Template Rendering and Context Injection

**Template Rendering**:

- All templates render to `agent_modules/<scope>/<package>/` following the package's directory structure
- No files are written to project root (isolated rendering only)
- **File Type Detection**:
  - Files with `.hbs` extension → **rendered as templates** (processed through Handlebars + snippet preprocessing)
  - Files without `.hbs` extension → **copied literally** (no template processing, preserves example syntax)
- Handlebars templates use context `{ project, pkg, env, now, files }`
- Safe path handling ensures outputs stay within package directory

**Use Cases for Literal Files**:

- Documentation containing example template syntax (e.g., `templates/EXAMPLES.md`)
- Tutorial or reference files showing how to use `{{ askUser() }}` or `{{ askAgent() }}`
- Any file that should preserve template-like syntax without rendering

**Context Injection**:

- After rendering, CLAUDE.md/AGENTS.md files from packages are @-mentioned in project's CLAUDE.md/AGENTS.md
- Only context files (CLAUDE.md, AGENTS.md) are included to avoid pollution
- MCP configs, agents/, commands/, hooks/, skills/ are NOT @-mentioned
- Uses HTML comment markers (`<!-- terrazul:begin -->` / `<!-- terrazul:end -->`) for idempotent injection

**Symlink Management**:

- Operational files (agents/, commands/, hooks/, skills/) are symlinked from agent_modules to .claude/ directories
- Symlinks use namespaced pattern: `@scope-pkg-filename.md` to avoid conflicts
- Ownership tracked in `.terrazul/symlinks.json` registry for cleanup on uninstall
- Symlinks created on `tz run`, removed on `tz uninstall`

### AskAgent System Prompt Support

- All `askAgent` snippets support an optional `systemPrompt` option to customize Claude's behavior.
- **Default behavior**: When no `systemPrompt` is specified, askAgent uses a context extraction system prompt:
  ```
  You are a context extraction agent. Your job is to understand, synthesize and extract context from existing projects. Your responses should only include what is asked, and should not include any dialog such as "I'm now ready to..", "Looking at", etc. Instead, you should ONLY respond with the answers to the questions asked based on your research
  ```
- **Custom system prompts**: Override the default by passing `systemPrompt` in snippet options:
  ```handlebars
  {{ askAgent('Explain this code', { systemPrompt: 'You are a helpful coding assistant.' }) }}
  ```
- **Disable system prompt**: Pass an empty string to use Claude's default system prompt:
  ```handlebars
  {{ askAgent('Explain this code', { systemPrompt: '' }) }}
  ```
- **Implementation details**:
  - System prompt is passed via `--append-system-prompt` flag to Claude CLI (only for Claude tool type)
  - System prompt is included in the cache key, so different prompts result in separate cache entries
  - Single-turn directive continues to be appended to all askAgent prompts regardless of system prompt
