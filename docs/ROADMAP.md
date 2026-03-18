# nax Roadmap

> **Authoritative source** for planned and shipped versions.
> Specs in `memory/` are detailed references. GitLab issues are supplementary.
> Full release notes → `docs/releases/`

---

## v0.46.2 — Review Rectification (Agent-Driven Lint/Typecheck Fix) 📋 Planned

**Theme:** When lint or typecheck fails in the review stage and mechanical autofix can't resolve it, spawn an agent rectification session with the error output as context.
**Depends on:** v0.46.1
**Spec:** `docs/specs/SPEC-v046-2-review-rectification.md`

### AUTOFIX-001: Agent rectification fallback in autofix stage

Extend `src/pipeline/stages/autofix.ts`:
1. After mechanical `lintFix`/`formatFix` fails or isn't configured, spawn agent session with review error output
2. Agent gets exact lint/typecheck errors in prompt — fixes code, commits
3. Re-run review to verify; repeat up to `maxAttempts`
4. Reuses existing config: `quality.autofix.enabled`, `quality.autofix.maxAttempts`

**Sub-tasks:**
- AUTOFIX-001: Agent rectification loop in autofix stage
- AUTOFIX-002: Review rectification prompt builder
- AUTOFIX-003: Thread review check results (already available via `ctx.reviewResult.checks`)
- AUTOFIX-004: Tests for all agent rectification paths

**Complexity:** Simple-Medium

---

## v0.46.1 — Runtime File Gitignore Audit + Precheck Allowlist ✅ Released

**Theme:** Full audit of nax runtime files — `working-tree-clean` precheck blocks on files nax itself writes; `nax init` adds an incomplete `.gitignore`; warning check covers only 2 of 12 runtime paths. Fix all three layers consistently.
**Depends on:** v0.46.0

### BUG-074: working-tree-clean blocks on nax runtime files

**Root cause:** `checkWorkingTreeClean` uses plain `git status --porcelain` with zero exceptions. nax writes runtime files during execution — if any aren't gitignored (e.g. user didn't run `nax init`, or init entries were incomplete), the precheck fires as a blocker on re-run.

**Complete runtime file inventory:**

| File | Written by | Missing from init | Missing from allowlist |
|:-----|:-----------|:-----------------:|:----------------------:|
| `nax.lock` | `lock.ts` | — | — |
| `nax/metrics.json` | `metrics/tracker.ts` | — | — |
| `nax/features/*/status.json` | `status-writer.ts` | ✗ | — |
| `nax/features/*/runs/` | `registry.ts`, logger | — | ✗ |
| `nax/features/*/plan/` | plan stage | ✗ | — |
| `.nax-verifier-verdict.json` | `tdd/verdict.ts` | — | — |
| `.nax-pids` | `pid-registry.ts` | ✗ | ✗ |
| `.nax-wt/` | `parallel-executor.ts` | ✗ | ✗ |
| `nax/features/*/acp-sessions.json` | `acp/adapter.ts` | ✗ | ✗ |
| `nax/features/*/interactions/` | `interaction/state.ts` | ✗ | ✗ |
| `nax/features/*/progress.txt` | `execution/progress.ts` | ✗ | ✗ |
| `acceptance-refined.json` | `acceptance/generator.ts` | ✗ | ✗ |

- [ ] **BUG-074-1:** `src/precheck/checks-git.ts` — parse `--porcelain` output line-by-line, filter allowlisted paths before evaluating `passed`. Full allowlist:
  ```
  nax.lock
  nax/metrics.json
  nax/features/*/status.json
  nax/features/*/runs/
  nax/features/*/plan/
  nax/features/*/acp-sessions.json
  nax/features/*/interactions/
  nax/features/*/progress.txt
  acceptance-refined.json
  .nax-verifier-verdict.json
  .nax-pids
  .nax-wt/
  ```
- [ ] **BUG-074-2:** `src/cli/init.ts` — complete `NAX_GITIGNORE_ENTRIES`. Add all missing entries:
  `nax/features/*/status.json`, `nax/features/*/plan/`, `.nax-pids`, `.nax-wt/`,
  `nax/features/*/acp-sessions.json`, `nax/features/*/interactions/`,
  `nax/features/*/progress.txt`, `acceptance-refined.json`
- [ ] **BUG-074-3:** `src/precheck/checks-warnings.ts` — expand `checkGitignoreCoversNax` patterns to cover the full set (currently only checks `nax.lock`, `runs/`, `test/tmp/`)

### BUG-076: Literal `~` directory created in repo root when HOME is unexpanded

**Root cause:** `buildAllowedEnv()` in both CLI and ACP adapters blindly passes `process.env.HOME` to spawned agents without validation. If `HOME` is set to the literal string `~` (not shell-expanded — e.g. from a misconfigured launch script), Claude Code resolves `~/.claude` relative to cwd, creating a literal `~/` directory inside the repo.

**Affected files:** `src/agents/claude/execution.ts`, `src/agents/acp/spawn-client.ts` (both have their own `buildAllowedEnv`)

- [ ] **BUG-076-1:** `src/agents/claude/execution.ts` — in `buildAllowedEnv`, validate `HOME` is an absolute path (starts with `/` on Unix or drive letter on Windows) before passing. If invalid, fall back to `os.homedir()` and emit a `logger.warn`
- [ ] **BUG-076-2:** `src/agents/acp/spawn-client.ts` — same fix in its local `buildAllowedEnv`
- [ ] **BUG-076-3:** `src/precheck/checks-warnings.ts` — add `checkHomeEnvValid()` warning: if `process.env.HOME` is missing, relative, or contains unexpanded `~`, emit warning before agent launch
- [ ] **BUG-076-4:** `src/cli/init.ts` — add `~/` to `NAX_GITIGNORE_ENTRIES` as a safety net (prevents accidental `~` dir commits if the bug recurs)

**Fix pattern for BUG-076-1/2:**
```typescript
import { homedir } from "node:os";
import { isAbsolute } from "node:path";

// Sanitize HOME — must be absolute. Unexpanded ~ causes literal ~/dir in cwd.
const rawHome = process.env.HOME ?? "";
const safeHome = rawHome && isAbsolute(rawHome) ? rawHome : homedir();
if (rawHome !== safeHome) {
  logger.warn("env", `HOME env invalid ("${rawHome}"), falling back to os.homedir(): ${safeHome}`);
}
allowed.HOME = safeHome;
```

### BUG-075: acceptance-refined.json written to workdir root instead of feature dir

**Root cause:** `src/acceptance/generator.ts` writes to `join(options.workdir, "acceptance-refined.json")` — repo root instead of `nax/features/<feature>/`. This pollutes the project root and makes gitignore patterns harder to scope.

- [ ] **BUG-075-1:** `src/acceptance/generator.ts` — change output path to `join(options.featureDir, "acceptance-refined.json")`
- [ ] **BUG-075-2:** Ensure `featureDir` is threaded into `generateFromPRD()` options (currently only `workdir` is passed)

---

## v0.47.0 — Monorepo Workdir Support ✅ Released 2026-03-17

**Theme:** Per-story working directory, per-package context.md/config.json, and package-aware test commands — enabling nax to orchestrate monorepo projects where each package has a different stack.
**Depends on:** v0.46.3
**Spec:** [`docs/specs/SPEC-monorepo-workdir.md`](specs/SPEC-monorepo-workdir.md)

### Phase 1 — Per-Story Workdir + Package Context

| ID | Title | Complexity | Status |
|:---|:------|:-----------|:-------|
| MW-001 | `UserStory.workdir` field + schema validation + runtime existence check | Simple | [x] |
| MW-002 | Execution stage — workdir override (agent cwd) | Simple | [x] |
| MW-003 | Context stage — package-level `context.md` resolution | Medium | [x] |
| MW-004 | `nax generate --package` + `--all-packages` | Medium | [x] |
| MW-005 | `nax init --package` scaffold | Simple | [x] |
| MW-006 | Verify stage — workdir-scoped test execution | Medium | [x] |
| MW-007 | `nax plan` / `nax analyze` — monorepo-aware `workdir` emission | Medium | [x] |

### Phase 2 — Per-Package Config + Test Commands

| ID | Title | Complexity | Status |
|:---|:------|:-----------|:-------|
| MW-008 | Per-package `nax/config.json` overrides (deep merge) | Medium | [x] |
| MW-009 | Verify stage — per-package test command from config | Simple | [x] |
| MW-010 | Review stage — package-scoped file checks | Simple | [x] |

### Design Decisions

- **No story-level test command** — per-package `nax/config.json` handles this (config is the right layer, not PRD data)
- **Test command fallback chain:** package `config.json` → root `testScoped` → root `test`
- **Claude Code hierarchy:** per-package `CLAUDE.md` contains only package-specific content; Claude Code natively merges root + subdirectory
- **Builds on MONO-001** (monorepo detection from `fea2573`) — adds execution support on top of existing init/detect

---

## v0.45.0 — Bug Fixes: ACP Adapter Threading + Batch Routing Diagnostics 🚀 Releasing (2026-03-16)

**Theme:** Fix ACP adapter not used for fix stories and parallel batch execution (BUG-067), add diagnostic logging for batch routing story count anomaly (BUG-068), and unify test strategy definitions into a single source of truth.

### BUG-067: agentGetFn not threaded through fix story and parallel pipeline contexts
- [x] `src/execution/lifecycle/acceptance-loop.ts` — add `agentGetFn: ctx.agentGetFn` to `fixContext` and `acceptanceContext`
- [x] `src/execution/parallel-coordinator.ts` — add `agentGetFn?` param to `executeParallel()`, thread into `baseContext`
- [x] `src/execution/parallel-executor.ts` — pass `options.agentGetFn` to `executeParallel()` call
- [x] Tests: verify `agentGetFn` forwarded in parallel executor and acceptance loop type contract

**Root cause:** `executeFixStory()` and `executeParallel()` built `PipelineContext` without `agentGetFn`. The execution stage fell back to the module-level `getAgent()` which always returns the CLI adapter, ignoring `config.agent.protocol = "acp"`. Fix stories and all parallel stories silently used CLI adapter.

### BUG-068: Debug logging for batch routing storyCount anomaly (root cause unknown)
- [x] `src/execution/runner-execution.ts` — single `readyStories` var + `debug` log before batch routing (readyCount, readyIds, full story state snapshot)
- [x] `src/execution/story-context.ts` — log `completedIds` set inside `getAllReadyStories()`

### Test Strategy SSOT (MR !49)
- [x] `src/config/test-strategy.ts` — new single source of truth for test strategies
- [x] `resolveTestStrategy()` — normalizer with legacy mappings
- [x] `COMPLEXITY_GUIDE` with security override rule (auth/crypto/tokens → minimum "medium")
- [x] `GROUPING_RULES` with anti-standalone-test-story rule
- [x] `plan.ts` + `claude-decompose.ts` import shared fragments (was diverged: 4 vs 2 strategies)
- [x] `prd/schema.ts` uses `resolveTestStrategy()` on load

### Specs
- `docs/specs/bug-067-068-agentgetfn-batchrouting.md`
- `docs/specs/test-strategy-ssot.md`
- `docs/bugs/BUG-067-fix-story-cli-adapter.md`
- `docs/bugs/BUG-068-batch-routing-story-count.md`

---

## v0.44.0 — ACP Session Lifecycle + Plan/Precheck/Status Fixes ✅ Shipped (2026-03-16)

**Theme:** Keep ACP sessions alive on failure (enables rectification to resume with context), sweep stale sessions on run-end, fix critical plan flow bugs.

### MR !47 — Plan/Precheck/Guard/Status fixes
- [x] `nax run --plan` logger initialized before plan (was silently dropping all logs)
- [x] Precheck runs before plan — blocks on environment issues before any LLM calls
- [x] `--force` flag guards prd.json overwrite on `nax run --plan`
- [x] `nax status` no longer crashes when prd.json is missing

### MR !48 — ACP Session Lifecycle
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
**Depends on:** None (can run anytime)

### Context

- **226 test files**, 3,014 tests, 67K lines of test code
- 10 files exceed 600 lines (largest: `context.test.ts` at 1,734 lines)
- Integration tests likely duplicate unit test coverage in several areas
- Copy-paste test patterns (same logic, one param changed) inflate line count

### Stories

- [x] **TH-001:** Automated coverage overlap report — script that cross-references integration tests against unit tests, flags tests covering identical code paths. Output: markdown report with recommended deletions
- [x] **TH-002:** Dead test detection — identify test files importing functions/modules that no longer exist in `src/`, or testing removed features (pre-v0.22.1 verification paths, old routing, etc.)
- [x] **TH-003:** Copy-paste consolidation — convert repeated test patterns to `test.each()` / table-driven style. Target: files with 3+ similar `describe` blocks differing by 1-2 params
- [x] **TH-004:** Execute cleanup — delete confirmed redundant tests, apply `test.each()` conversions, verify full suite still passes with same or higher coverage
- [x] **TH-005:** Test file size enforcement — add a precheck/lint rule that warns on test files exceeding 500 lines (soft limit) or 800 lines (hard limit)

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
**Status:** ✅ Shipped (2026-03-11) — commit `8a59f16`, [run-release] triggered
**Depends on:** v0.38.0

### Context

Comprehensive code review (graded B+) identified 10 real findings across bug, architecture, and quality categories. All fixes implemented on `feat/review-fixes-v039` branch via Claude Code session on Mac01, then merged to master.

### Stories

- [x] **FIX-001:** PID registry race — read-then-write in `register()` loses PIDs under concurrent parallel execution
- [x] **FIX-002:** ReDoS in hook validation — greedy regex `/\$\(.*\)/` hangs on pathological input
- [x] **FIX-003:** Timer leaks in `claude.ts` decompose/plan — same pattern fixed in v0.38.0 for `executeOnce` not applied here
- [x] **FIX-004:** Timeout handler utility — extracted `withProcessTimeout()` from `executeOnce` into reusable module
- [x] **FIX-005:** `runner.ts` split — 307-line function broken into modular sub-files
- [x] **FIX-006:** `config-display.ts` split — exceeded 400-line source file limit
- [x] **FIX-007:** `lifecycle.test.ts` split — exceeded 800-line test file limit
- [x] **FIX-008:** Story ID validation — IDs sanitized before flowing into git branch names
- [x] **FIX-009:** `errorMessage` utility — centralized error-to-string conversion
- [x] **FIX-010:** PID registry Map cleanup — proper cleanup on process exit

### Hotfix (included)

- `killFn` injectable param added to `withProcessTimeout()` — restores `_runOnceDeps.killProc` injection path broken by FIX-004 refactor

### Lesson

When extracting logic into a reusable utility, always check if the original call site had injectable deps — pass them through as optional params.

---

## v0.39.0 — Init Enhancement ✅ Shipped (2026-03-12)

**Theme:** Enhance `nax init` with auto-detection, context.md generation, and guided onboarding
**Status:** ✅ Shipped (2026-03-12) — commit `e6f293e`, [run-release] triggered
**Depends on:** v0.38.1

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
**Status:** ✅ Shipped (2026-03-12) — commit `8cab535`, [run-release] triggered
**Depends on:** v0.39.2

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
**Status:** ✅ Shipped (2026-03-12) — commit `9915529`, [run-release] triggered
**Depends on:** v0.39.3

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
**Status:** ✅ Shipped (2026-03-14) — commit `e41e076`, merged MR !44

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
**Depends on:** v0.40.0

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
**Status:** ✅ Shipped — commit `0a7a065`, [run-release] triggered
**Depends on:** v0.36.2 (Prompt Optimization)

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
**Status:** ✅ Shipped — commit `eb77e7d`, [run-release] triggered
**Depends on:** v0.36.1 (Prompt Optimization)

### Stories

- [x] **MFX-001:** Parallel batch metrics aggregation (BUG-064/065/066)
- [x] **MFX-002:** Escalation metrics preservation (BUG-067)
- [x] **MFX-003:** Parallel executor cleanup — field renames, dedup log (BUG-068/069/071)
- [x] **MFX-004:** Runtime crash vs test failure classification (BUG-070)
- [x] **MFX-005:** Merge conflict rectification — sequential re-run of conflicted stories on updated base

---

## v0.36.1 — Prompt Optimization ✅ Shipped (2026-03-10)

**Theme:** Wire constitution into TDD sessions, deduplicate prompt sections, clean dead prompt code, fix verdict coercion
**Status:** ✅ Shipped (2026-03-10)
**Depends on:** v0.36.0 (Multi-Agent Adapters)

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

- [x] **PO-001:** Wire constitution into TDD `session-runner.ts` for implementer + rectification sessions only (skip test-writer and verifier)
- [x] **PO-002:** Wire verdict section into PromptBuilder for verifier role — move from hardcoded `tdd/prompts.ts` to composable section
- [x] **PO-003:** Deduplicate test filter warning (keep only in isolation section) + convert string concatenation → template literals in all section builders
- [x] **PO-004:** Delete dead standalone prompt functions in `tdd/prompts.ts`, clean barrel exports
- [x] **BUG-072:** coerceVerdict recognizes VERIFIED keyword (free-form verdict handling)
- [x] **BUG-073:** Headless human-review sends Telegram notification via interaction.send()

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
**Depends on:** v0.35.0 (Agent Abstraction Layer)

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

- [x] **AA-001:** Add `complete(prompt, options)` method to `AgentAdapter` interface — one-shot LLM call that returns text. Options: `{ maxTokens?, jsonMode?, model? }`. Implement in `ClaudeAdapter` using `claude -p` CLI
- [x] **AA-002:** Refactor `src/analyze/classifier.ts` to use `adapter.complete()` instead of `new Anthropic()`. Remove `@anthropic-ai/sdk` from `package.json` dependencies

### Priority 2 — Agent-agnostic CLI calls

- [x] **AA-003:** Refactor `src/routing/strategies/llm.ts` to use `adapter.complete()` instead of hardcoded `Bun.spawn(["claude", ...])`. Resolve binary from configured agent
- [x] **AA-004:** Refactor `src/interaction/plugins/auto.ts` to use `adapter.complete()` instead of hardcoded `Bun.spawn(["claude", ...])`
- [x] **AA-005:** Refactor `src/precheck/checks-blockers.ts` to check configured agent binary (not just `claude`). Support `codex`, `opencode`, `gemini`, `aider` version checks

### Priority 3 — Model name portability

- [x] **AA-006:** Remove hardcoded `"claude-sonnet-4-5"` fallbacks from `src/agents/claude.ts`, `claude-plan.ts`, and `src/acceptance/` — resolve model from config `models.balanced` instead
- [x] **AA-007:** Add adapter scaffolding for at least one non-Claude agent (Codex or OpenCode) — implement `AgentAdapter` interface with `execute()`, `complete()`, and binary detection

### Also includes
- **BUG-062:** Routing cache hit overwrote fresh `testStrategy` with stale PRD value — fixed in two passes (`945cc8d` + `4987d75`)
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

### Stories

- [ ] **RL-001:** Add `on-all-stories-complete` hook — fires when all stories pass, before deferred regression gate. Payload: `{ feature, storiesCompleted, totalCost }`
- [ ] **RL-002:** Move `on-complete` hook to fire AFTER deferred regression gate — represents "fully verified" state. Remove premature `run:completed` event from `sequential-executor.ts`
- [ ] **RL-003:** Add `on-final-regression-fail` hook — fires when deferred regression fails after rectification exhausted. Payload: `{ feature, failedTests, affectedStories[], rectificationAttempts }`
- [ ] **RL-004:** Handle deferred regression failure in `run-completion.ts` — mark affected stories as `regression-failed` status (new `StoryStatus`), fire hook, reflect in final run result

### Smart Regression Skip

- [ ] **RL-005:** Track `fullSuiteGatePassed` per story in run metrics. Only set `true` when rectification gate passes (three-session-tdd and tdd-lite only; NOT tdd-simple or test-after)
- [ ] **RL-006:** Skip deferred regression when ALL of: (a) sequential mode, (b) every story has `fullSuiteGatePassed === true`, (c) no test-after or tdd-simple stories in run. Log skip reason

### Strategy Matrix (reference)

| Strategy | Sessions | Per-story full suite gate? | Deferred regression needed? |
|:---------|:---------|:--------------------------|:---------------------------|
| `test-after` | 1 | ❌ No | ✅ Yes |
| `tdd-simple` | 1 | ❌ No (single session, no rectification) | ✅ Yes |
| `three-session-tdd-lite` | 3 | ✅ Yes (rectification gate) | ❌ Skip if sequential |
| `three-session-tdd` | 3 | ✅ Yes (rectification gate) | ❌ Skip if sequential |
| Mixed strategies | varies | Partial | ✅ Yes |
| Parallel mode | any | Yes but isolated | ✅ Yes (stories don't see each other) |

### Bugfixes
- **BUG-060:** Duplicate exit summary + premature heartbeat stop — `sequential-executor.ts` called `stopHeartbeat()` + `writeExitSummary()` before `runner.ts` ran deferred regression

---

## v0.33.0 — Story Decomposer ✅ Shipped (2026-03-09)

**Theme:** Auto-decompose oversized stories into manageable sub-stories
**Status:** ✅ Shipped (2026-03-09)
**Spec:** `nax/features/story-decompose/prd.json`

### Stories
- [x] **SD-001:** DecomposeBuilder fluent API and prompt sections
- [x] **SD-002:** Post-decompose validators (overlap, coverage, complexity, dependency)
- [x] **SD-003:** Config schema, PRD mutation, and story-oversized trigger
- [x] **SD-004:** Pipeline integration and CLI entry point (`nax analyse --decompose`)

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
| v0.32.2 | BUG-059 Fix (silent gate pass on crash) | 2026-03-09 |
| v0.32.1 | Portable Hooks + Docs | 2026-03-09 |
| v0.32.0 | TDD Simple Strategy | 2026-03-09 |
| v0.31.1 | Bugfixes (BUG-056/057/058) | 2026-03-09 |
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

### Bugs
- [x] ~~BUG-015: fixed via `skipGlobal: true` in all unit tests~~
- [x] ~~BUG-054: skip redundant verify after full-suite gate passes. Fixed in v0.27.1.~~
- [x] ~~BUG-055: Pipeline skip messages conflate "not needed" with "disabled". Fixed in v0.27.1.~~
- [x] ~~**BUG-061:** `story.complete` and `progress` log entries reported `durationMs`/`elapsedMs` as cumulative time since run start. Fixed: added `storyDurationMs` (per-story wall clock) to both events. `cca4ff3`~~
- [x] ~~**BUG-062:** LLM routing cache returned stale `testStrategy` from pre-route phase — `simple` stories incorrectly used `three-session-tdd-lite` instead of `tdd-simple` (TS-001 rule not applied on cache hit). Fixed: cache hit now recomputes `testStrategy` via `determineTestStrategy()` from cached `complexity`; cache is authoritative on `complexity`/`modelTier` only. `945cc8d`~~

### Features
- [x] ~~**PERM-001:** Permission Resolver — remove all local `dangerouslySkipPermissions` fallbacks, add `resolvePermissions(config, stage)` as single source of truth, add `permissionProfile` config field (`unrestricted` | `safe` | `scoped`), thread `pipelineStage` through `AgentRunOptions`. No functional change for existing users. **Spec:** [`docs/specs/scoped-permissions.md`](specs/scoped-permissions.md) Phase 1~~
- [ ] **PERM-002:** Scoped Tool Allowlists — per-stage `allowedTools` with glob patterns (e.g., `Write(src/**)`), `inherit` chain between stages, backend mapping to `--allowedTools` (CLI) and `--allowed-tools` (ACP). Depends on PERM-001. **Spec:** [`docs/specs/scoped-permissions.md`](specs/scoped-permissions.md) Phase 2
- [ ] **HOOK-001:** Fire plugin hooks on plan failure — load plugins before plan phase and emit `onRunEnd` with failure status when `nax run --plan` fails, so Telegram/reporter plugins are notified.
- [x] ~~**ACC-001:** Acceptance Test Pipeline — shipped in v0.40.0~~
- [x] ~~**ACP Adapter:** Multi-agent support via acpx CLI — shipped 2026-03-14~~
- [x] ~~**MONO-001:** Monorepo Support (Phase 1) — delegate to monorepo orchestrators; detect turborepo/nx/pnpm-workspaces/bun-workspaces; generate correct init commands; bypass smart test runner for turbo/nx (they handle change-aware scoping natively). Shipped `fea2573`.~~ **Phase 2 → v0.47.0** (per-story workdir, per-package context/config)
- [ ] **CI-001:** CI Memory Optimization — parallel test sharding to pass on 1GB runners (currently requires 8GB).
- [ ] Cost tracking dashboard
- [ ] npm publish setup
- [ ] `nax diagnose --ai` flag (LLM-assisted, future TBD)
- [ ] **Auto-decompose oversized stories** — When story size gate triggers, offer via interaction chain to auto-decompose using `nax analyse`.
- [ ] VitePress documentation site — full CLI reference, hosted as standalone docs (pre-publish requirement)
- [x] ~~**Deprecate `single-session` prompt role** — no longer used by pipeline (unified into `tdd-simple`). Remove from `role-task.ts`, `isolation.ts`, `nax prompts --export`, and builder API.~~
- [x] ~~**Migrate batch prompt to PromptBuilder** — MR !40 merged. Batch prompts now go through PromptBuilder with security tags, test command injection, conventions, isolation rules.~~

---

## Versioning

Sequential canary → stable: `v0.12.0-canary.0` → `canary.N` → `v0.12.0`
Canary: `npm publish --tag canary`
Stable: `npm publish` (latest)

*Last updated: 2026-03-12 (v0.39.3 shipped — Prompt Optimization; v0.40.0 next)*
