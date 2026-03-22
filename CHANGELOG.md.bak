# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.51.0] - 2026-03-21

### Added

- **STRAT-001: `no-test` strategy** — New test strategy for stories with zero behavioral change (config, docs, CI/build files, dependency bumps, pure refactors). Requires `noTestJustification` field at every assignment point (plan prompt, LLM routing, batch routing) to prevent lazy test-skipping. `no-test` stories use an implement-only prompt (no RED/GREEN/REFACTOR), are exempt from greenfield override (BUG-010) and test-after escalation (S5), and batch separately from tested stories.
- **DIR-001: Rename `nax/` → `.nax/`** — Project-level config directory now uses hidden dot-prefix convention (like `.git/`, `.claude/`). `PROJECT_NAX_DIR = ".nax"` SSOT constant in `src/config/paths.ts`. Package configs moved from `<pkg>/nax/config.json` to `.nax/packages/<pkg>/config.json`. 93 files updated.
- **BUG-073: Acceptance fix story quality** — Fix stories now include acceptance test file path, truncated failure output, and "fix implementation not tests" instruction. Batched by related stories (cap 8) instead of 1-per-AC. Fix stories inherit `workdir` from related story. `>80%` AC failure triggers test regeneration instead of fix stories.
- **BUG-073: Acceptance staleness detection** — SHA-256 fingerprint of AC set stored in `acceptance-meta.json`. Acceptance test auto-regenerates (with `.bak` backup) when stories are added/removed/modified.

### Fixed

- **fix(acceptance):** Correct `__dirname` depth in generator prompt — test file is exactly 3 `../` levels from root, not 4.
- **fix(acceptance):** Acceptance tests always run from repo root — covers both single repo and monorepo. Test uses `__dirname`-based paths into packages.
- **fix(acceptance):** Fix stories use per-package config for review/verify stages when `story.workdir` is set.
- **fix(review):** Fallback to `quality.commands` when `review.commands` not configured — prevents routing failures in monorepo packages.
- **fix(review):** Use optional chaining for `quality?.commands` — avoids crash when config has no quality section.
- **fix(pkg):** Remove `src/` and `bin/` from npm `files` — only `dist/` published. 354 files / 4.7MB → 5 files / 3.1MB.

### Refactored

- **refactor(test):** Add `withDepsRestore` helper in `test/helpers/deps.ts` — eliminates save/restore boilerplate across 13 test files (−98 net lines).

### Migration

- Rename your project's `nax/` directory to `.nax/`
- For monorepo: move `<pkg>/nax/config.json` → `.nax/packages/<pkg>/config.json`
- Update `.gitignore` patterns: `nax/**/runs/` → `.nax/**/runs/`, etc.

---

## [0.50.0] - 2026-03-19

### Added

- **ENH-005: Context chaining** — Dependent stories automatically receive parent story's changed files as context. After a story passes, `outputFiles` are captured via `git diff storyGitRef..HEAD` (scoped to `story.workdir` in monorepos) and injected into dependent stories' context via `getParentOutputFiles()`.
- **ENH-006: Structured plan prompt** — `nax plan` now uses a 3-step prompt (understand → analyze → generate). Analysis stored in `prd.analysis` field and injected into all story contexts. `contextFiles` populated per-story by the plan LLM. Hard ban on analysis/test-only/validation stories.
- **ENH-007: Reconciliation review gate** — Reconciliation no longer blindly auto-passes stories that failed at review stage. Stores `failureStage` on failed stories; re-runs built-in review checks before reconciling `review`/`autofix` failures.
- **ENH-008: Monorepo workdir scoping** — Decomposed sub-stories now inherit `workdir` from parent. Agent rectification runs in `story.workdir` (not repo root) and prompt includes scope constraint for out-of-package prevention.
- `prd.analysis?: string` field — planning phase analysis available to all story contexts

### Fixed

- **BUG-071**: `COMPLEXITY_GUIDE` and `TEST_STRATEGY_GUIDE` prompt constants had inverted mappings. Corrected: `simple→tdd-simple`, `medium→three-session-tdd-lite`, `expert→three-session-tdd`. `test-after` is explicit opt-out only, never auto-assigned.

## [0.49.3] - 2026-03-18

### Fixed
- **Autofix `recheckReview` bug:** `reviewStage.execute()` returns `action:"continue"` for both pass AND built-in-check-failure (to hand off to autofix). Using `result.action === "continue"` always returned `true`, causing "Mechanical autofix succeeded" to log every cycle and looping until `MAX_STAGE_RETRIES` with no real fix. Fix: check `ctx.reviewResult?.success` directly after execute.
- **Autofix selective mechanical fix:** `lintFix`/`formatFix` cannot fix typecheck errors. Phase 1 now only runs when the `lint` check actually failed. Typecheck-only failures skip straight to agent rectification (Phase 2).
- **Review command logging:** `runner.ts` now logs the resolved command and workdir for every check at info level, and full output on failure at warn level — eliminates phantom failure mystery.
- **Re-decompose on second run:** Batch-mode story selector was missing `"decomposed"` in its status skip list (single-story path already excluded it). Stories with `status: "decomposed"` were being picked up again, triggering unnecessary LLM decompose calls. Added `"decomposed"` to batch filter and a guard in routing SD-004 block.
- **totalCost always 0:** `handlePipelineFailure` returned no `costDelta`; `iteration-runner` hardcoded `costDelta: 0` for failures. Agent cost for failed stories was silently dropped. Fix: extract `agentResult?.estimatedCost` in failure path same as success path.

## [0.49.2] - 2026-03-18

### Fixed
- **Test strategy descriptions:** `TEST_STRATEGY_GUIDE` (used in plan and decompose prompts) had incorrect descriptions for `three-session-tdd` and `three-session-tdd-lite`. Both strategies use 3 sessions. Key distinction: `three-session-tdd` (strict) — test-writer makes no src/ changes, implementer makes no test changes; `three-session-tdd-lite` (lite) — test-writer may add minimal src/ stubs, implementer may expand coverage and replace stubs. Updated in `src/config/test-strategy.ts`, `docs/specs/test-strategy-ssot.md`, and `docs/architecture/ARCHITECTURE.md`.

## [0.49.1] - 2026-03-18

### Fixed
- **ACP zero cost:** `acpx prompt` was called without `--format json`, causing it to output plain text instead of JSON-RPC NDJSON. Cost and token usage were always 0. Fix: pass `--format json` as a global flag so the parser receives `usage_update` (exact cost in USD) and `result.usage` (token breakdown).
- **Decompose session name / model:** Decompose one-shots used an auto-generated timestamp session name and passed the tier string (`"balanced"`) as the model instead of the resolved model ID. Fix: session name is now `nax-decompose-<story-id>` and model tier is resolved via `resolveModel()` before the `complete()` call.
- **`autoCommitIfDirty` skipping monorepo subdirs:** The working-directory guard rejected any workdir that wasn't exactly the git root, silently skipping commits for monorepo package subdirs. Fix: allow subdirs (`startsWith(gitRoot + '/')`); use `git add .` for subdirs vs `git add -A` at root.
- **`complete()` missing model in `generateFromPRD()` and `plan` auto mode:** `generator.ts` ignored `options.modelDef.model`; `plan.ts` auto path didn't call `resolveModel()`. Both now pass the correct resolved model to `adapter.complete()`.

## [0.46.2] - 2026-03-17

### Fixed
- **Review rectification:** When lint or typecheck fails in the review stage and mechanical autofix (`lintFix`, `formatFix`) cannot resolve it, nax now spawns an agent rectification session with the exact error output as context. The agent fixes the issues, commits, and re-runs review to verify. Reuses `quality.autofix.maxAttempts` (default: 2) for agent attempts.

### Tests
- 12 new tests in `test/unit/pipeline/stages/autofix.test.ts` covering agent rectification paths.

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
