# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.46.1] - 2026-03-17

### Fixed
- **BUG-074:** `working-tree-clean` precheck now allows 12 nax runtime files to be dirty without blocking. Includes fix for `--porcelain` trim bug that corrupted leading status chars.
- **BUG-074:** `nax init` now adds complete gitignore entries for all nax runtime files (was missing: status.json, plan/, acp-sessions.json, interactions/, progress.txt, acceptance-refined.json, .nax-pids, .nax-wt/, ~/).
- **BUG-074:** `checkGitignoreCoversNax` warning now checks 6 critical patterns (was only 3).
- **BUG-075:** `acceptance-refined.json` now written to featureDir instead of workdir root.
- **BUG-076:** HOME env is now validated before passing to spawned agents — if not an absolute path (e.g. unexpanded "~"), falls back to `os.homedir()` with a warning log. Prevents literal "~/" directory creation in repo.
- **BUG-076:** New `checkHomeEnvValid()` precheck warning fires when HOME is unset or not absolute.

### Tests
- New tests in `test/unit/precheck/checks-git.test.ts` (188 lines) for working-tree-clean allowlist.
- New tests in `test/unit/agents/claude/execution.test.ts` (79 lines) for HOME sanitization.

## [0.46.0] - 2026-03-16

### Fixed
- **ACP cost metric:** Cost was always `$0` for ACP sessions. `parseAcpxJsonOutput` now handles JSON-RPC envelope format (acpx v0.3+): extracts text from `agent_message_chunk`, captures exact USD cost from `usage_update` (`cost.amount`), and reads camelCase token breakdown (`inputTokens`, `outputTokens`, `cachedReadTokens`, `cachedWriteTokens`) from `result.usage`.
- **ACP `complete()` cost:** Now logs exact cost via `getSafeLogger()` — previously had zero cost tracking.
- **`run()` cost:** Prefers exact `cost.amount` from acpx over token-based estimation; falls back to `estimateCostFromTokenUsage` when unavailable.

### Refactored
- **`src/agents/` folder restructure:** Each adapter now lives in its own subfolder for consistency.
  - `claude/` — Claude Code adapter (adapter, execution, complete, interactive, plan, cost)
  - `acp/` — ACP protocol adapter (unchanged internals)
  - `aider/`, `codex/`, `gemini/`, `opencode/` — per-adapter subfolders
  - `shared/` — cross-adapter utilities: `decompose` (extracted from both claude + acp), `model-resolution`, `validation`, `version-detection`, `types-extended`
- **Dead code removal:** `streamJsonRpcEvents` (exported but never called), stale `estimateCostFromTokenUsage` re-export from `acp/index.ts`.

### Docs
- **ARCHITECTURE.md §1:** Updated `src/agents/` tree.
- **ARCHITECTURE.md §16:** New section — agent adapter folder conventions, `shared/` rules, ACP cost alignment.

## [0.43.0] - 2026-03-16

### Added
- **PERM-001:** `src/config/permissions.ts` — `resolvePermissions(config, stage)` as the single source of truth for all permission decisions across CLI and ACP adapters.
- **New types:** `PermissionProfile` (`"unrestricted" | "safe" | "scoped"`), `PipelineStage`, `ResolvedPermissions` interface.
- **Schema:** `execution.permissionProfile` config field — takes precedence over legacy `dangerouslySkipPermissions` boolean. `"scoped"` is a Phase 2 stub.
- **`pipelineStage?`** added to `AgentRunOptions` — each call site sets the appropriate stage (`"plan"`, `"run"`, `"rectification"`, etc.).
- **`config?`** added to `CompleteOptions` — all `complete()` call sites now thread config so permissions are resolved correctly.

### Fixed
- **Hardcoded `--dangerously-skip-permissions`** in `claude-plan.ts` — now resolved from config.
- **`?? false` fallback** in `plan.ts` — removed; replaced with `resolvePermissions()`.
- **`?? true` fallback** in `claude-execution.ts` — removed; replaced with `resolvePermissions()`.
- **`resolvePermissions(undefined, ...)` in ACP `complete()`** — now passes `_options?.config`.
- All ACP adapter permission ternaries replaced with `resolvePermissions()`.

### Changed
- `nax/config.json` — explicit `"permissionProfile": "unrestricted"` (was implicit via schema default).

## [0.30.0] - 2026-03-08

### Fixed
- **Global install crash:** `bin/nax.ts`, `headless-formatter.ts`, and `cli/analyze.ts` were reading `package.json` at runtime via `import.meta.dir`-relative paths. In a global bun install, these paths resolve incorrectly, causing an ENOENT crash on launch. All three now use the static `NAX_VERSION` constant (baked in at build time).

### Refactored
- **Prompt Builder wired to sections:** `PromptBuilder` now calls `buildRoleTaskSection()`, `buildIsolationSection()`, `buildStorySection()`, and `buildConventionsSection()` from `src/prompts/sections/` instead of duplicated inline functions. Eliminates 80+ lines of dead code.
- **Sections expanded:** `role-task.ts` and `isolation.ts` now cover all 4 roles (`implementer`, `test-writer`, `verifier`, `single-session`). Previously only covered 1–2 roles each.
- **Template stubs removed:** `src/prompts/templates/` directory deleted — all 4 stub files (`implementer.ts`, `test-writer.ts`, `verifier.ts`, `single-session.ts`) were empty and unused.

## [0.29.0] - 2026-03-08

### Added
- **CTX-001:** `context.fileInjection` config flag (`"keyword" | "disabled"`, default `"disabled"`). MCP-aware agents pull context on-demand; file injection is now opt-in.
- **CTX-002:** `nax config --explain` documents `context.fileInjection` with rationale and examples.
- **CTX-003:** Unit tests covering all `fileInjection` modes (disabled, keyword, legacy compat).

### Fixed
- **Implementer prompt:** Agent sessions now include explicit `git commit` instruction — implementation changes were previously left uncommitted, blocking the review stage.
- **Review stage:** `nax/status.json`, `nax/features/*/prd.json`, and `.nax-verifier-verdict.json` are excluded from the working-tree-clean check (nax runtime files, not agent changes).
- **Version display:** Installed binary no longer shows `(dev)` — `bin` now points to pre-built `dist/nax.js` with `GIT_COMMIT` injected at publish time.


## [0.18.6] - 2026-03-04

### Fixed
- **BUG-2:** Infinite PTY respawn loop in `usePty` hook by destructuring object-identity dependencies.
- **MEM-1 & MEM-3:** Prevented child process hangs on full `stderr` pipes by switching to `stderr: "inherit"`.
- **BUG-21 & BUG-22:** Added missing error handling and `.catch()` chains to process `stdout` streaming and exit handlers.

## [0.18.5] - 2026-03-04

### Changed
- **BUN-001:** Replaced `node-pty` (native C++ addon) with `Bun.spawn` piped stdio in `src/agents/claude.ts` and `src/tui/hooks/usePty.ts`. No native build required.

### Removed
- `node-pty` dependency from `package.json`

### Fixed
- CI `before_script` no longer installs `python3 make g++` (not needed without native build)
- CI `bun install` no longer needs `--ignore-scripts`
- Flaky test `execution runner > completes when all stories are done` — skipped with root cause comment (acceptance loop iteration count non-deterministic)

## [0.18.4] - 2026-03-04

### Fixed
- **BUG-031:** Keyword classifier no longer drifts across retries — `description` excluded from complexity/strategy classification (only `title`, `acceptanceCriteria`, `tags` used). Prevents prior error context from upgrading story complexity mid-run.
- **BUG-033:** LLM routing now retries on timeout/transient failure. New config: `routing.llm.retries` (default: 1), `routing.llm.retryDelayMs` (default: 1000ms). Default timeout raised from 15s to 30s.

### Added
- Pre-commit hook (`.githooks/pre-commit`) — runs `typecheck` + `lint` before every commit. Install with: `git config core.hooksPath .githooks`

## [0.10.0] - 2026-02-23

### Added

#### Plugin System
- Introduced extensible plugin architecture supporting:
  - Prompt optimizers for context compression and token reduction
  - Custom routers for intelligent agent/model selection
  - Code reviewers for quality gates and automated checks
  - Context providers for dynamic context injection
  - Custom reporters for execution reporting and analytics
  - Agent launchers for custom agent implementations
- Plugin discovery from both global (`~/.nax/plugins`) and project-local (`nax/plugins`) directories
- Plugin validation and lifecycle management (setup/teardown hooks)
- Safe plugin loading with comprehensive error handling
- Plugin configuration via `nax/config.json` with per-plugin settings

#### Global Configuration Layering
- Implemented three-tier configuration system:
  - User-global config (`~/.nax/config.json`) for default preferences
  - Project config (`nax/config.json`) for project-specific settings
  - CLI overrides for runtime customization
- Deep merge strategy with array override semantics
- Layered constitution loading with optional global opt-out
- Project-level directory detection for automatic config discovery
- Validation and normalization at each layer

#### Prompt Optimizer
- Built-in prompt optimization system with modular optimizer plugins
- Token budget enforcement with configurable limits
- Multi-strategy optimization:
  - Redundancy elimination
  - Context summarization
  - Selective detail retention
- Optimization statistics tracking (original vs. optimized token counts, reduction percentage)
- Integration with execution pipeline for automatic prompt optimization
- Plugin API for custom optimization strategies

### Changed
- Refactored config loading to support global + project layering
- Updated constitution loader to support skipGlobal flag
- Enhanced plugin registry with proper lifecycle management
- Improved error handling across plugin loading and validation

### Fixed
- Path security test failures on macOS (handled `/private` symlink prefix)
- TypeScript compilation errors across 9 files (20 total errors resolved)
- Import organization and code formatting issues (96 files auto-formatted)

### Previous releases
- See git history for changes prior to v0.10.0
