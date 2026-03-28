# nax Roadmap

> **Authoritative source** for planned and shipped versions.
> Specs in `memory/` are detailed references. GitLab issues are supplementary.
> Full release notes → `docs/releases/`

---

## v0.49.6 ✅ Released 2026-03-19

**Theme:** Test reliability + webhook fix

- **fix(test):** Eliminated 38 cross-file test failures caused by `mock.module()` contamination — replaced with injectable `_deps` pattern across all TDD modules (`_rectificationGateDeps`, extended `_sessionRunnerDeps`)
- **fix(webhook):** `receive()` polling loop replaced with event-driven Promise — eliminates race condition in slow Docker/VM environments (4218ms → 65ms)
- **fix:** `getChangedFiles` / `getPgid` stdout read — concurrent read via `Bun.readableStreamToText()` prevents deadlock on large output
- **fix:** Circular import `prompts-tdd` ↔ `prompts-main` broken via `prompts-shared.ts`
- **fix:** `quality.commands` bridges correctly into `review.commands` during per-package merge
- **fix:** Agent adapter session options standardized across all adapters
- **docs:** Injectable deps pattern and `mock.module()` prohibition documented in ARCHITECTURE.md + `.claude/rules/`

---

## v0.49.0 — Per-Package Config Override (Monorepo) ✅ Released

**Theme:** Complete the per-package config override system — expand what's mergeable and wire effective config into all pipeline stages.
**Spec:** [`docs/specs/SPEC-per-package-config.md`](specs/SPEC-per-package-config.md)

- **feat(config):** Expanded `mergePackageConfig` — `execution.smartTestRunner`, `execution.regressionGate`, `review.enabled`, `review.checks`, `acceptance.enabled`, and more now mergeable from per-package `nax/config.json`
- **feat(pipeline):** `effectiveConfig: NaxConfig` added to `PipelineContext` — resolved once per story at pipeline entry; all stages read from `ctx.effectiveConfig`
- **fix(acceptance):** Strip markdown fences from `generateFromPRD` output
- **fix(verify):** `TEST_FAILURE` hands off to rectify stage instead of escalating; `TIMEOUT`/`CRASH` still escalate
- **fix(autofix):** Review hands off to autofix stage instead of escalating; uses per-package `lintFix`/`formatFix` command

---

## v0.46.2 — Review Rectification (Agent-Driven Lint/Typecheck Fix) ✅ Released

**Theme:** When lint or typecheck fails in the review stage and mechanical autofix can't resolve it, spawn an agent rectification session with the error output as context.
**Spec:** [`docs/specs/SPEC-v046-2-review-rectification.md`](specs/SPEC-v046-2-review-rectification.md)

- **fix(autofix):** Agent rectification fallback for lint/typecheck failures — spawns agent session with exact error output, re-runs review to verify, up to `maxAttempts`. Reuses `quality.autofix.enabled` and `quality.autofix.maxAttempts` config (AUTOFIX-001–004)

---

## v0.46.1 — Runtime File Gitignore Audit + Precheck Allowlist ✅ Released

**Theme:** Full audit of nax runtime files — `working-tree-clean` precheck now allows nax's own runtime files; `nax init` adds complete `.gitignore` entries; warning check covers all runtime paths.

- **fix:** `working-tree-clean` precheck now uses an allowlist — runtime files written by nax itself (lock, metrics, runs, sessions, etc.) no longer falsely block re-runs
- **fix:** `nax init` generates a complete `.gitignore` covering all nax runtime files
- **fix:** Precheck warning now detects incomplete `.gitignore` coverage

---

## v0.48.0 — Test Health + Monorepo Plan Improvements ✅ Released 2026-03-18

**Theme:** Test suite hardening, monorepo planning fixes, and developer experience improvements.

### Test Suite Health

| Change | Detail |
|:-------|:-------|
| Descriptive test names | Replaced opaque `BUG-xx`/`AC-xx` identifiers with behavior-based names + `// BUG-xxx` comments |
| Test structure | 40 loose `test/unit/` files moved into correct subdirectories |
| Trivial test cleanup | ~80 low-value type-check and empty-assertion tests deleted (-515 lines) |
| Parallel collision fix | 29 test files with hardcoded `/tmp/nax-*` paths → unique `mkdtempSync`/`randomUUID` paths |
| stdin leak fix | `createInteractionBridge` exposed via `_deps` — plan-interactive tests no longer block on real stdin |

### Monorepo Planning (`nax plan`)

| Change | Detail |
|:-------|:-------|
| Workspace discovery | `discoverWorkspacePackages()` reads `turbo.json`, `package.json` workspaces, `pnpm-workspace.yaml` as fallback when no `nax/context.md` exists — `prd.json` now gets `workdir` fields on first run |
| Per-package tech stacks | Planning prompt includes `## Package Tech Stacks` table (framework, test runner, key deps per package) for better LLM routing |

### Other Fixes

| Change | Detail |
|:-------|:-------|
| `config.generate.agents` | New config field to restrict `nax generate` to specific agents instead of all 7 |
| PERM-001 | Permission resolver shipped (single `resolvePermissions()` source of truth) |

---

## v0.47.0 — Monorepo Workdir Support ✅ Released 2026-03-17

**Theme:** Per-story working directory, per-package context.md/config.json, and package-aware test commands — enabling nax to orchestrate monorepo projects where each package has a different stack.
**Spec:** [`docs/specs/SPEC-monorepo-workdir.md`](specs/SPEC-monorepo-workdir.md)

### Phase 1 — Per-Story Workdir + Package Context

- `UserStory.workdir` field with schema validation and runtime existence check
- Execution stage uses per-story workdir as agent `cwd`
- Context stage resolves package-level `context.md` for each story's package
- `nax generate --package` and `--all-packages` for generating agent context files
- `nax init --package` scaffold for per-package setup
- Verify stage runs tests scoped to the story's workdir
- `nax plan` / `nax analyze` emits correct `workdir` fields in monorepos

### Phase 2 — Per-Package Config + Test Commands

- Per-package `nax/config.json` overrides (deep merge of all config fields)
- Verify stage reads per-package test command from resolved config
- Review stage runs scoped file checks per package

### Design Decisions

- Per-package `nax/config.json` is the right layer for per-package settings — not story-level fields
- Test command fallback chain: package `config.json` → root `testScoped` → root `test`
- Per-package `CLAUDE.md` supplements root `CLAUDE.md` — Claude Code natively merges both

---

## v0.45.0 — ACP Adapter Threading + Batch Routing Fixes ✅ Released 2026-03-16

**Theme:** Fix ACP adapter not used for fix stories and parallel batch execution, add diagnostic logging for batch routing anomalies, and unify test strategy definitions into a single source of truth.

### ACP Adapter Threading
- **fix:** `agentGetFn` now threaded through fix stories and parallel execution — previously fell back to CLI adapter, ignoring `config.agent.protocol = "acp"`
- **fix:** Debug logging added to batch routing to track story count anomalies

### Test Strategy SSOT
- Single source of truth for test strategies — `src/config/test-strategy.ts` with `resolveTestStrategy()`, `COMPLEXITY_GUIDE` (security override: auth/crypto/tokens → minimum "medium"), and `GROUPING_RULES`
- `plan.ts` and `claude-decompose.ts` now share the same strategy definitions

---

## v0.44.0 — ACP Session Lifecycle + Plan/Precheck/Status Fixes ✅ Shipped (2026-03-16)

**Theme:** Keep ACP sessions alive on failure (enables rectification to resume with context), sweep stale sessions on run-end, fix critical plan flow bugs.

### Plan/Precheck/Guard/Status fixes
- [x] `nax run --plan` logger initialized before plan (was silently dropping all logs)
- [x] Precheck runs before plan — blocks on environment issues before any LLM calls
- [x] `--force` flag guards prd.json overwrite on `nax run --plan`
- [x] `nax status` no longer crashes when prd.json is missing

### ACP Session Lifecycle
- [x] `adapter.ts` — close session on story pass, keep open on failure
- [x] `runner.ts` — run-end sweep closes all remaining feature sessions in `finally` block
- [x] `run-setup.ts` — startup stale sweep prunes sidecar entries >2h old
- [x] `rectification-loop.ts` — pass `featureName`, `storyId`, `sessionRole: "implementer"` for named session resumption

---

## v0.43.1 — Permission Resolution + Plan Logger ✅ Shipped (2026-03-16)

**Theme:** Single source of truth for permissions (`resolvePermissions()`), fix plan logger missing in `nax run --plan` flow, document permission system in architecture.

- [x] PERM-001: `src/config/permissions.ts` — `resolvePermissions(config, stage)` single source of truth
- [x] `PermissionProfile` (`unrestricted | safe | scoped`), `PipelineStage`, `ResolvedPermissions` types
- [x] `execution.permissionProfile` config field (takes precedence over legacy boolean)
- [x] `config?` threaded to all 11 `complete()` call sites; `pipelineStage?` added to `AgentRunOptions`
- [x] Removed all local `?? true` / `?? false` permission fallbacks
- [x] Fixed hardcoded `--dangerously-skip-permissions` in `claude-plan.ts`
- [x] Plan logger initialized in `nax run --plan` flow (was silently dropped)
- [x] ARCHITECTURE.md §14 Permission Resolution + §15 Test Strategy Resolution
- [x] `nax/context.md` updated with permission rules; all 7 agent configs regenerated

---

## v0.38.0 — Test Health Audit ✅ Shipped (2026-03-10)

**Theme:** Audit and slim down the test suite — remove redundant coverage, consolidate copy-paste tests, delete dead feature tests
**Status:** ✅ Shipped (2026-03-10)

### Context

- **226 test files**, 3,014 tests, 67K lines of test code
- 10 files exceed 600 lines (largest: `context.test.ts` at 1,734 lines)
- Integration tests likely duplicate unit test coverage in several areas
- Copy-paste test patterns (same logic, one param changed) inflate line count

### Stories

- [x] Automated coverage overlap report — script that cross-references integration tests against unit tests, flags tests covering identical code paths. Output: markdown report with recommended deletions
- [x] Dead test detection — identify test files importing functions/modules that no longer exist in `src/`, or testing removed features (pre-v0.22.1 verification paths, old routing, etc.)
- [x] Copy-paste consolidation — convert repeated test patterns to `test.each()` / table-driven style. Target: files with 3+ similar `describe` blocks differing by 1-2 params
- [x] Execute cleanup — delete confirmed redundant tests, apply `test.each()` conversions, verify full suite still passes with same or higher coverage
- [x] Test file size enforcement — add a precheck/lint rule that warns on test files exceeding 500 lines (soft limit) or 800 lines (hard limit)

### Outcome

- Test files reduced: 226 → 183 files (−43 files via MRs !31/!32/!33)
- File size tiers documented in `docs/ARCHITECTURE.md`: src/ 400-line, test/ 800-line, type-only 600-line
- CI passes on 8GB runner; 0 regressions

### Success Criteria

- Test count reduced by ≥15% without losing meaningful coverage
- No test file exceeds 800 lines
- Full suite runtime unchanged or faster
- CI still passes on 8GB runner

---

## v0.38.1 — Code Audit Refactor ✅ Shipped (2026-03-11)

**Theme:** Code audit review fixes — 10-fix campaign addressing bugs, architecture, and quality findings from the comprehensive src/ code review
**Status:** ✅ Shipped (2026-03-11)

### Context

Comprehensive code review (graded B+) identified 10 real findings across bug, architecture, and quality categories. All fixes implemented on `feat/review-fixes-v039` branch via Claude Code session on Mac01, then merged to master.

### Stories

- [x] PID registry race — read-then-write in `register()` loses PIDs under concurrent parallel execution
- [x] ReDoS in hook validation — greedy regex `/\$\(.*\)/` hangs on pathological input
- [x] Timer leaks in `claude.ts` decompose/plan — same pattern fixed in v0.38.0 for `executeOnce` not applied here
- [x] Timeout handler utility — extracted `withProcessTimeout()` from `executeOnce` into reusable module
- [x] `runner.ts` split — 307-line function broken into modular sub-files
- [x] `config-display.ts` split — exceeded 400-line source file limit
- [x] `lifecycle.test.ts` split — exceeded 800-line test file limit
- [x] Story ID validation — IDs sanitized before flowing into git branch names
- [x] `errorMessage` utility — centralized error-to-string conversion
- [x] PID registry Map cleanup — proper cleanup on process exit

### Hotfix (included)

- `killFn` injectable param added to `withProcessTimeout()` — restores `_runOnceDeps.killProc` injection path broken by FIX-004 refactor

### Lesson

When extracting logic into a reusable utility, always check if the original call site had injectable deps — pass them through as optional params.

---

## v0.39.0 — Init Enhancement ✅ Shipped (2026-03-12)

**Theme:** Enhance `nax init` with auto-detection, context.md generation, and guided onboarding
**Status:** ✅ Shipped (2026-03-12)

### Context

Users faced a gap between `nax init` and first run — manual steps for context.md, constitution.md, and config.json. This release closes that gap with smart defaults.

### Stories

- [x] **INIT-001:** Auto-detect project stack (bun/node/python/rust/go) and pre-fill `quality.commands` in `nax/config.json`
- [x] **INIT-002:** Context.md generation — template from filesystem scan (default, zero cost) or LLM-powered with `--ai` flag
- [x] **INIT-003:** Post-init checklist + unified flow + stack-aware constitution.md + enhanced .gitignore entries

### Usage

```bash
nax init           # detect stack, generate template context.md
nax init --ai     # use LLM to generate richer context.md
```

### Outcome

- New files: `src/cli/init-detect.ts`, `src/cli/init-context.ts`
- Stack detection: bun, node, python, rust, go, turborepo
- Linter detection: biome, eslint
- Typecheck/lint/test commands auto-populated based on detected stack

---

## v0.39.3 — Prompt Optimization ✅ Shipped (2026-03-12)

**Theme:** Security hardening, test command injection, prompt unification, and full prompt audit
**Status:** ✅ Shipped (2026-03-12)

### Security Hardening

- `stripEnvVars` expanded from 3 to 22 variables (source control tokens, NPM tokens, LLM API keys, cloud credentials, CI secrets)
- Story context, constitution, and context.md wrapped with `<!-- USER-SUPPLIED DATA -->` boundary tags
- Security section added to conventions: forbids exfiltration via curl/webhooks

### Prompt Optimization

- **Test command injection:** All prompts now use `quality.commands.test` from config (no more hardcoded `bun test`)
- **Unified prompts:** `test-after` and `tdd-simple` now use the same TDD prompt role
- **Session context:** All TDD roles now know their position in the workflow (session 1/2/3)
- **Implementer-lite rewrite:** No longer says "write tests AND implement" — acknowledges tests already exist from session 1
- **LLM routing prompt:** Removed dead test strategy section (~80 tokens saved per call)
- **Classifier fix:** Removed hardcoded `ANTHROPIC_API_KEY` check (leftover from pre-v0.35.0)

### Prompts Shipped

- `prompts/roles/` — implementer, implementer-lite, test-writer, verifier, single-session, tdd-simple
- `prompts/sections/` — isolation, conventions
- README with export commands

### Tests

- 3,577 pass, 0 fail

### Roadmapped

- Deprecate `single-session` prompt role
- Migrate batch prompt to PromptBuilder

---

## v0.40.0 — Acceptance Test Pipeline ✅ Shipped (2026-03-12)

**Theme:** Feature-level TDD — verify built features match original requirements via acceptance tests generated from PRD acceptanceCriteria[]
**Status:** ✅ Shipped (2026-03-12)

### Context

nax verifies implementation tests (agent-written) but never independently verifies features match original requirements. The existing acceptance system (`src/acceptance/`) was unused because it depended on `spec.md` AC-N lines that don't exist in the Method 1 (direct PRD) workflow.

### Feature: Acceptance Test Pipeline

- **AC refinement:** LLM converts vague criteria (e.g., "Batch role uses TDD language") to concrete testable assertions (e.g., `output.includes("RED phase")`)
- **PRD-based generation:** `generateFromPRD()` creates `acceptance.test.ts` directly from PRD `acceptanceCriteria[]` — no spec.md needed
- **RED gate:** Acceptance tests run BEFORE stories execute. If they fail → RED (expected), stories implement until GREEN
- **GREEN gate:** Acceptance tests run AFTER all stories pass. Must pass for feature to be complete
- **Config:** `acceptance.refinement`, `acceptance.redGate`, `acceptance.model` added to config schema

### Key Files

- `src/acceptance/refinement.ts` — `refineAcceptanceCriteria()` LLM call wrapper
- `src/acceptance/generator.ts:generateFromPRD()` — PRD-to-acceptance.test.ts
- `src/pipeline/stages/acceptance-setup.ts` — pre-story RED gate stage
- `src/pipeline/stages/index.ts:preRunPipeline` — runs before per-story loop

### Test

- Toy project end-to-end validation: 2 stories, 100% pass, $0.096, 2m51s

### Stats

- +3,088 lines across 21 files
- 4/4 stories delivered via nax self-dev

---

## v0.41.0 — Slow Test Optimizations ✅ Shipped (2026-03-14)

**Theme:** Eliminate artificial test delays — make the full suite run in ~2.5 minutes instead of ~4+ minutes
**Status:** ✅ Shipped (2026-03-14), 

### Context

Profiling via `bun test --reporter junit` revealed the top-30 slowest tests accounted for 105s of wall time, almost entirely due to real `Bun.sleep()` calls in test paths. No CPU-bound work — just artificial waiting.

### Changes

- **Injectable sleep deps** — replaced `Bun.sleep` in execution runner, webhook backoff, retry logic, precheck, and iterationDelay paths with injectable `_runOnceDeps.sleep`, `_completeDeps.sleep`, etc. Tests pass `mock(async () => {})` to skip waits.
- **Shared `beforeAll` for file scanning** — `scanCodebase` was re-running `readdirSync` per test (10s per file × N tests). Fixed with a shared `beforeAll` cache.
- **Fixed acceptance pipeline tests** — imports were using `defaultConfig` (wrong) instead of `DEFAULT_CONFIG` (correct export name).
- **Fixed ACP adapter tests** — updated to check `src/agents/acp/spawn-client.ts` source path (not npm package), and verify "intentionally omitted" comment for default protocol.
- **Fixed flaky CI test** — `autoCommitIfDirty` test was mocking `_gitDeps.spawn` internally, which was fragile in CI (silent try/catch inside the function). Replaced with `_sessionRunnerDeps = { autoCommitIfDirty }` injectable — mock at the call site, not inside the callee.

### Stats

- Top-30 test time: 105s → ~23s (78% reduction)
- Full suite: ~4min → ~2.5min on Mac01 (4,114 tests, 0 fail)
- Commits: `cd3d7ac` through `e41e076`

---

## v0.40.1 — Acceptance UI Test Strategies ✅ Shipped (2026-03-14)

**Theme:** Extend acceptance pipeline to support UI projects (TUI, web, CLI) — not just backend/library code
**Status:** ✅ Shipped (2026-03-14)

### Problem

v0.40.0 generates acceptance tests that `import` a function and assert on return values. This doesn't work for:
- **TUI apps** (Ink) — need `render()` + `lastFrame()` assertions
- **Web apps** (React/Vue) — need `@testing-library` or Playwright
- **CLI tools** — need `Bun.spawn` + stdout assertions
- **Visual output** — need snapshot matching

### Feature: Test Strategy Selection

- **5 strategies:** `unit` (default), `component`, `cli`, `e2e`, `snapshot`
- **Auto-detection:** Extends `init-detect.ts` to detect UI frameworks (ink, react, vue, svelte)
- **Per-criterion override:** Mix strategies in the same feature (e.g., API logic = unit, dashboard = component)
- **Strategy-aware refinement:** LLM receives strategy context to produce appropriate assertions
- **Backward compatible:** Omitting `testStrategy` defaults to `unit`

### Stories

| ID | Title | Complexity |
|:---|:------|:-----------|
| ACS-001 | Test strategy types + config schema extension | Simple |
| ACS-002 | Stack detection for UI frameworks | Simple |
| ACS-003 | Generator templates — strategy-aware test generation | Medium |
| ACS-004 | Refinement prompt — strategy-aware LLM context | Simple |
| ACS-005 | Integration test — component strategy E2E (Ink project) | Medium |

**Spec:** [`docs/specs/acceptance-ui-strategies.md`](specs/acceptance-ui-strategies.md)

---

## v0.37.0 — Prompt Template Export ✅ Shipped (2026-03-10)

**Theme:** Complete the prompt override system — ship default templates, add CLI export, enable full user customization
**Status:** ✅ Shipped

### Context

The override system exists (`config.prompts.overrides`, `loadOverride()`, `PromptBuilder.withLoader()`) but users can't easily customize prompts because:
- No default templates shipped as files
- No CLI command to export defaults as starting points
- `tdd-simple` role missing from override schema

### Stories

- [x] **PT-001:** Add `tdd-simple` to `PromptsConfigSchema` override enum
- [x] **PT-002:** Ship default `.md` templates for all 5 roles in `nax/prompts/` scaffold
- [x] **PT-003:** `nax prompts export` CLI command — dumps default prompt for a given role to stdout or file
- [x] **PT-004:** Update `nax init` to scaffold `nax/prompts/` directory with default templates
- [x] **PT-005:** Documentation — prompt customization guide

---

## v0.36.2 — Parallel Metrics & Rectification ✅ Shipped (2026-03-10)

**Theme:** Fix metrics aggregation for parallel runs (BUG-064–071) and implement sequential rectification for merge conflicts
**Status:** ✅ Shipped

### Stories

- [x] - **fix:** Parallel batch metrics aggregation
- [x] - **fix:** Escalation metrics preservation across parallel execution
- [x] - **fix:** Parallel executor cleanup — field renames, dedup log
- [x] - **fix:** Runtime crash vs test failure classification
- [x] - **fix:** Merge conflict rectification — sequential re-run of conflicted stories on updated base

---

## v0.36.1 — Prompt Optimization ✅ Shipped (2026-03-10)

**Theme:** Wire constitution into TDD sessions, deduplicate prompt sections, clean dead prompt code, fix verdict coercion
**Status:** ✅ Shipped (2026-03-10)

### Context

Analysis revealed TDD 3-session agents don't receive the project constitution (only pipeline single-session/tdd-simple do). Test filter warning is duplicated across 3 sections. Dead standalone prompt functions in `tdd/prompts.ts` duplicate what PromptBuilder handles. Verdict section exists but isn't wired into PromptBuilder for verifier role.

### Agent Constitution Analysis

| Role | Needs Constitution? | Reasoning |
|:-----|:-------------------|:----------|
| implementer | ✅ Full | Core code-writing role — needs all architectural rules |
| rectification | ✅ Full | Fixing source code — same needs as implementer |
| single-session | ✅ Full | Already wired via pipeline prompt stage |
| tdd-simple | ✅ Full | Already wired via pipeline prompt stage |
| test-writer | ❌ Skip | Writes test code only — doesn't need `_deps`, async, error patterns |
| verifier | ❌ Skip | Reviews code, doesn't architect — constitution wastes ~950 tokens |

### Stories

- [x] **enhancement:** Wire constitution into TDD `session-runner.ts` for implementer + rectification sessions only (skip test-writer and verifier)
- [x] **enhancement:** Wire verdict section into PromptBuilder for verifier role — move from hardcoded `tdd/prompts.ts` to composable section
- [x] **enhancement:** Deduplicate test filter warning (keep only in isolation section) + convert string concatenation → template literals in all section builders
- [x] **enhancement:** Delete dead standalone prompt functions in `tdd/prompts.ts`, clean barrel exports
- [x] **fix:** coerceVerdict recognizes VERIFIED keyword (free-form verdict handling)
- [x] **fix:** Headless human-review sends Telegram notification via interaction.send()

### Token Budget (per TDD story)

| Section | Tokens | Included in |
|:--------|:-------|:------------|
| Global constitution | ~259 | implementer, rectification |
| Project constitution | ~949 | implementer, rectification |
| Role body | ~150-200 | all roles |
| Story context | variable | all roles |
| Isolation rules | ~100-150 | all roles |
| Conventions footer | ~80 | all roles |
| Verdict JSON schema | ~500 | verifier only |

---



---

## v0.36.0 — Multi-Agent Adapters ✅ Shipped (2026-03-10)

**Theme:** Scaffold adapters for Codex, OpenCode, Gemini CLI, and Aider — enabling nax to orchestrate any major coding agent
**Status:** ✅ Shipped (2026-03-10)

### Key Improvements
- **Multi-Agent Adapters:** Codex, OpenCode, Gemini CLI, Aider scaffolds.
- **Enterprise Standards:** Added `docs/ARCHITECTURE.md` and wired into all agent configurations (`CLAUDE.md`, `AGENTS.md`, etc.).
- **Parallel Execution:** Support for `--parallel N` with worktree isolation and merge-back.
- **Verdict Coercion:** Tolerant parsing of agent pass/fail outputs.

### Stories — Adapters
- [x] **MA-001:** Codex adapter
- [x] **MA-002:** OpenCode adapter
- [x] **MA-003:** Gemini CLI adapter
- [x] **MA-004:** Aider adapter
- [x] **MA-005:** Codex context generator
- [x] **MA-006:** Gemini CLI context generator
- [x] **MA-007:** Update `nax generate`
- [x] **MA-008:** Unit tests for all adapters
- [x] **MA-009:** Integration test suite
- [x] **MA-010:** Precheck updates
- [x] **MA-011:** Documentation for agents config
- [x] **MA-012:** `nax agents` CLI command

---

## v0.35.0 — Agent Abstraction Layer ✅ Shipped (2026-03-09)

**Theme:** Decouple nax from Anthropic/Claude — make all LLM calls agent-agnostic
**Status:** ✅ Shipped (2026-03-09)

### Motivation

nax currently hardcodes `claude` CLI and `@anthropic-ai/sdk` in several places, locking users to Anthropic. For public release, developers must be able to use any supported agent (Claude Code, Codex, OpenCode, Gemini CLI, Aider).

### Priority 1 — Drop `@anthropic-ai/sdk` dependency

- [x] Add `complete(prompt, options)` method to `AgentAdapter` interface — one-shot LLM call that returns text. Options: `{ maxTokens?, jsonMode?, model? }`. Implement in `ClaudeAdapter` using `claude -p` CLI
- [x] Refactor `src/analyze/classifier.ts` to use `adapter.complete()` instead of `new Anthropic()`. Remove `@anthropic-ai/sdk` from `package.json` dependencies

### Priority 2 — Agent-agnostic CLI calls

- [x] Refactor `src/routing/strategies/llm.ts` to use `adapter.complete()` instead of hardcoded `Bun.spawn(["claude", ...])`. Resolve binary from configured agent
- [x] Refactor `src/interaction/plugins/auto.ts` to use `adapter.complete()` instead of hardcoded `Bun.spawn(["claude", ...])`
- [x] **AA-005:** Refactor `src/precheck/checks-blockers.ts` to check configured agent binary (not just `claude`). Support `codex`, `opencode`, `gemini`, `aider` version checks

### Priority 3 — Model name portability

- [x] **AA-006:** Remove hardcoded `"claude-sonnet-4-5"` fallbacks from `src/agents/claude.ts`, `claude-plan.ts`, and `src/acceptance/` — resolve model from config `models.balanced` instead
- [x] **AA-007:** Add adapter scaffolding for at least one non-Claude agent (Codex or OpenCode) — implement `AgentAdapter` interface with `execute()`, `complete()`, and binary detection

### Also includes
- **BUG-062:** Routing cache hit overwrote fresh `testStrategy` with stale PRD value — routing cache fix applied in two passes
- **BUG-063:** Rectification agent sessions left uncommitted changes, causing false-positive review failures — added `autoCommitIfDirty()` to rectification gate
- **PluginLogger:** Structured write-only logger for nax plugins — `createPluginLogger(name)` wraps `getSafeLogger()` with `plugin:<name>` stage prefix
- **TDD Strategy `simple`:** New `TddStrategy` option; `nax/config.json` switched to `auto` for heuristic routing

### Hardcoded Claude References (audit)

| File | Line | Issue |
|:-----|:-----|:------|
| `src/analyze/classifier.ts:101` | `new Anthropic()` | Direct SDK — **only SDK usage** |
| `src/analyze/classifier.ts:108` | `"claude-haiku-4-20250514"` | Hardcoded model ID |
| `src/routing/strategies/llm.ts:88` | `spawn(["claude", ...])` | Hardcoded binary |
| `src/interaction/plugins/auto.ts:132` | `spawn(["claude", ...])` | Hardcoded binary |
| `src/precheck/checks-blockers.ts:168` | `spawn(["claude", "--version"])` | Hardcoded binary check |
| `src/agents/claude.ts:309,323` | `"claude-sonnet-4-5"` | Hardcoded model fallback |
| `src/agents/claude-plan.ts:71` | `"claude-sonnet-4-5"` | Hardcoded model fallback |
| `src/acceptance/fix-generator.ts:56,191` | `"claude-sonnet-4-5"` | Hardcoded model fallback |
| `src/acceptance/generator.ts:151` | `"claude-sonnet-4-5"` | Hardcoded model fallback |

---

## v0.34.0 — Run Lifecycle Hooks & Smart Regression ✅ Shipped (2026-03-14)

**Theme:** Fix run lifecycle ordering (BUG-060), add missing hooks, skip redundant deferred regression
**Status:** ✅ Shipped (2026-03-14)

### Hook Architecture

Current `on-complete` fires before deferred regression gate — if regression fails, the notification is a false positive.

**New hook lifecycle:**

```
All stories pass individually
  │
  ├─ 🔔 on-all-stories-complete  (NEW)
  │     "4/4 stories done — running regression gate…"
  │
  ├─ Deferred regression gate (with rectification if failures)
  │     │
  │     ├─ Passed → continue
  │     └─ Failed → 🔔 on-final-regression-fail (NEW)
  │                  "⚠️ Regression: 3 tests still failing after rectification"
  │
  └─ 🔔 on-complete  (MOVED — fires LAST, means "everything verified")
        "✅ story-decompose complete — $5.86"
```

### What was shipped

- `on-all-stories-complete` hook — fires when all stories pass, before deferred regression gate
- `on-final-regression-fail` hook — fires when deferred regression fails after rectification exhausted
- `on-complete` hook moved to fire AFTER deferred regression gate (represents "fully verified" state)
- Deferred regression skip when all sequential stories have passed full-suite gate
- Strategy matrix for regression gate behavior by TDD mode

### Bugfixes
- **fix:** Duplicate exit summary + premature heartbeat stop — `sequential-executor.ts` no longer calls `stopHeartbeat()` or `writeExitSummary()` before `runner.ts` completes deferred regression

---

## v0.33.0 — Story Decomposer ✅ Shipped (2026-03-09)

**Theme:** Auto-decompose oversized stories into manageable sub-stories
**Spec:** `nax/features/story-decompose/prd.json`

### What was shipped

- DecomposeBuilder fluent API and prompt sections
- Post-decompose validators (overlap, coverage, complexity, dependency)
- Config schema, PRD mutation, and story-oversized trigger
- Pipeline integration and CLI entry point (`nax analyse --decompose`)

### Trigger
Stories classified as complex/expert with >6 acceptance criteria.

### Also includes (on master)
- **BUG-059:** Full-suite gate silently passes on crash/OOM truncated output
- **Semgrep:** `.semgrepignore` + `// nosemgrep` suppressions for false-positive ReDoS
- **ReviewFinding:** Service-agnostic structured finding type for plugin reviewers (Semgrep, ESLint, Snyk, etc.)
- **Review escalation:** Thread structured findings through escalation to retry agent context


---

## Shipped

> Detailed specs for v0.19.0–v0.32.2 → [releases/v0.19.0-v0.32.2.md](releases/v0.19.0-v0.32.2.md)
> Earlier versions → [releases/v0.11.0-and-earlier.md](releases/v0.11.0-and-earlier.md)

| Version | Theme | Date |
|:--------|:------|:-----|
| v0.49.0 | Per-Package Config Override (expand mergeable fields, effectiveConfig in PipelineContext) | 2026-03-xx |
| v0.46.2 | Review Rectification (agent-driven lint/typecheck fix fallback) | 2026-03-xx |
| v0.41.0 | Slow Test Optimizations (105s → 23s, full suite 4min → 2.5min) | 2026-03-14 |
| v0.40.1 | Acceptance UI Test Strategies (component/cli/e2e/snapshot) | 2026-03-14 |
| v0.40.0 | Acceptance Test Pipeline (RED→GREEN gates, PRD-based AC generation) | 2026-03-12 |
| ACP Adapter | Multi-Agent Support (acpx CLI spawn, session naming, env filtering) | 2026-03-14 |
| v0.39.3 | Prompt Optimization (security hardening, test command injection) | 2026-03-12 |
| v0.39.0 | Init Enhancement (auto-detect, context generation) | 2026-03-12 |
| v0.38.1 | Code Audit Refactor (10 fixes) | 2026-03-11 |
| v0.38.0 | Test Health Audit | 2026-03-10 |
| v0.37.0 | Prompt Template Export | 2026-03-10 |
| v0.36.2 | Parallel Metrics & Rectification | 2026-03-10 |
| v0.36.1 | Prompt Optimization | 2026-03-10 |
| v0.36.0 | Multi-Agent Adapters | 2026-03-10 |
| v0.35.0 | Agent Abstraction Layer | 2026-03-09 |
| v0.34.0 | Run Hooks + Smart Skip | 2026-03-09 |
| v0.33.0 | Story Decomposer | 2026-03-09 |
| v0.32.2 | Silent gate pass fix on crash/OOM | | 2026-03-09 |
| v0.32.1 | Portable Hooks + Docs | 2026-03-09 |
| v0.32.0 | TDD Simple Strategy | 2026-03-09 |
| v0.31.1 | Multiple bugfixes | | 2026-03-09 |
| v0.31.0 | Prompt Template Export | 2026-03-08 |
| v0.30.0 | Prompt Builder Completion | 2026-03-08 |
| v0.29.0 | Context Simplification | 2026-03-08 |
| v0.28.0 | Prompt Builder | 2026-03-08 |
| v0.27.1 | Pipeline Observability | 2026-03-08 |
| v0.27.0 | Review Quality | 2026-03-08 |
| v0.26.0 | Routing Persistence | 2026-03-08 |
| v0.25.0 | Trigger Completion | 2026-03-07 |
| v0.24.0 | Central Run Registry | 2026-03-07 |
| v0.23.0 | Status File Consolidation | 2026-03-07 |
| v0.22.2 | Routing Stability + SFC-001 | 2026-03-07 |
| v0.22.1 | Pipeline Re-Architecture | 2026-03-07 |
| v0.21.0 | Process Reliability & Observability | 2026-03-06 |
| v0.20.0 | Verification Architecture v2 | 2026-03-06 |
| v0.19.0 | Hardening & Compliance | 2026-03-04 |
| v0.18.5 | Bun PTY Migration | 2026-03-04 |
| v0.18.4 | Routing Stability | 2026-03-04 |
| v0.18.3 | Execution Reliability + Smart Runner | 2026-03-04 |
| v0.18.2 | Smart Test Runner + Routing Fix | 2026-03-03 |
| v0.18.1 | Type Safety + CI Pipeline | 2026-03-03 |
| v0.18.0 | Orchestration Quality | 2026-03-03 |
| v0.17.0 | Config Management | 2026-03-02 |

---

## Backlog

### In Progress
- **PERM-002:** Scoped Tool Allowlists — per-stage `allowedTools` with glob patterns (e.g., `Write(src/**)`), `inherit` chain between stages, backend mapping to `--allowedTools` (CLI) and `--allowed-tools` (ACP). **Spec:** [`docs/specs/scoped-permissions.md`](specs/scoped-permissions.md)

### Planned
- **CI Speed** — bun install cache + parallel jobs (checks/test run concurrently); target: 3-4 min → ~2.5 min
- **Cost tracking dashboard** — visualize spend across features and agents
- **Auto-decompose oversized stories** — when story size gate triggers, offer to auto-decompose via `nax analyse`
- **Fire plugin hooks on plan failure** — load plugins before plan phase and emit `onRunEnd` with failure status when `nax run --plan` fails

### Post-Launch
- VitePress documentation site — full CLI reference, hosted as standalone docs
- `nax diagnose --ai` flag — LLM-assisted diagnostics

---

## Versioning

Sequential canary → stable: `v0.12.0-canary.0` → `canary.N` → `v0.12.0`
Canary: `npm publish --tag canary`
Stable: `npm publish` (latest)
