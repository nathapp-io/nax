# nax Roadmap

> **Authoritative source** for planned and shipped versions.
> Specs in `memory/` are detailed references. GitLab issues are supplementary.
> Full release notes → `docs/releases/`

---


## v0.35.0 — Agent Abstraction Layer (Planned)

**Theme:** Decouple nax from Anthropic/Claude — make all LLM calls agent-agnostic
**Status:** 🔲 Planned

### Motivation

nax currently hardcodes `claude` CLI and `@anthropic-ai/sdk` in several places, locking users to Anthropic. For public release, developers must be able to use any supported agent (Claude Code, Codex, OpenCode, Gemini CLI, Aider).

### Priority 1 — Drop `@anthropic-ai/sdk` dependency

- [ ] **AA-001:** Add `complete(prompt, options)` method to `AgentAdapter` interface — one-shot LLM call that returns text. Options: `{ maxTokens?, jsonMode?, model? }`. Implement in `ClaudeAdapter` using `claude -p` CLI
- [ ] **AA-002:** Refactor `src/analyze/classifier.ts` to use `adapter.complete()` instead of `new Anthropic()`. Remove `@anthropic-ai/sdk` from `package.json` dependencies

### Priority 2 — Agent-agnostic CLI calls

- [ ] **AA-003:** Refactor `src/routing/strategies/llm.ts` to use `adapter.complete()` instead of hardcoded `Bun.spawn(["claude", ...])`. Resolve binary from configured agent
- [ ] **AA-004:** Refactor `src/interaction/plugins/auto.ts` to use `adapter.complete()` instead of hardcoded `Bun.spawn(["claude", ...])`
- [ ] **AA-005:** Refactor `src/precheck/checks-blockers.ts` to check configured agent binary (not just `claude`). Support `codex`, `opencode`, `gemini`, `aider` version checks

### Priority 3 — Model name portability

- [ ] **AA-006:** Remove hardcoded `"claude-sonnet-4-5"` fallbacks from `src/agents/claude.ts`, `claude-plan.ts`, and `src/acceptance/` — resolve model from config `models.balanced` instead
- [ ] **AA-007:** Add adapter scaffolding for at least one non-Claude agent (Codex or OpenCode) — implement `AgentAdapter` interface with `execute()`, `complete()`, and binary detection

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

## v0.34.0 — Run Lifecycle Hooks & Smart Regression (Planned)

**Theme:** Fix run lifecycle ordering (BUG-060), add missing hooks, skip redundant deferred regression
**Status:** 🔲 Planned

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

## v0.32.2 — BUG-059 Fix ✅ Shipped (2026-03-09)

**Theme:** Fix silent full-suite gate pass on crash/OOM
**Status:** ✅ Shipped (2026-03-09)

### Fixes
- **BUG-059:** `rectification-gate.ts` silently returned `true` when `parseBunTestOutput` found 0 failures from truncated output. Now checks `passed > 0` to distinguish environmental noise from crash/OOM

---

## v0.31.0 — Prompt Template Export ✅ Shipped (2026-03-08)

**Theme:** Export default prompt templates for user customization
**Status:** ✅ Shipped (2026-03-08)

### Stories
- [x] **PE-001:** `nax prompts --init` — export 4 default role-body templates to `nax/templates/` with header comments
- [x] **PE-002:** Auto-configure `prompts.overrides` in `nax.config.json` when templates exist

### Fixes
- **Verifier context:** Injected missing `.context(contextMarkdown)` into verifier prompt builder calls

---

## v0.32.1 — Portable Hooks + Docs ✅ Shipped (2026-03-09)

**Theme:** Hook portability (tilde expansion) and README documentation
**Status:** ✅ Shipped (2026-03-09)

### Changes
- [x] **GH-001:** Tilde (`~/`) expansion in hook command parser — allows portable `hooks.json` across nodes (VPS/Mac01)
- [x] **DOC-001:** Document hooks env vars, interaction triggers & plugins in README

---

## v0.32.0 — TDD Simple Strategy ✅ Shipped (2026-03-09)

**Theme:** Single-session TDD strategy for simple stories — TDD discipline without session isolation overhead
**Status:** ✅ Shipped (2026-03-09)

### Stories
- [x] **TS-001:** Add `tdd-simple` test strategy type and update routing (simple → tdd-simple default, test-after preserved for non-TDD work)
- [x] **TS-002:** Add `tdd-simple` prompt section — red-green-refactor instructions, no isolation, git commit instruction
- [x] **TS-003:** Wire `tdd-simple` execution path in session runner and pipeline (single session, reuse single-session path)

### Strategy Spectrum
| Strategy | Sessions | Use Case |
|:---------|:---------|:---------|
| `test-after` | 1 | Non-TDD: refactors, deletions, config, docs |
| `tdd-simple` | 1 | Simple stories: single agent, TDD discipline |
| `three-session-tdd-lite` | 3 | Medium stories: lite isolation |
| `three-session-tdd` | 3 | Complex stories: strict isolation |

---

## v0.31.1 — Bugfixes ✅ Shipped (2026-03-09)

**Theme:** Auto-commit safety net + precheck fixes
**Status:** ✅ Shipped (2026-03-09)

### Fixes
- [x] **BUG-058:** Auto-commit after each agent session to prevent review failures from uncommitted changes
- [x] **BUG-056:** Normalize `"open"` → `"pending"` and `"done"` → `"passed"` on PRD load
- [x] **BUG-057:** `checkOptionalCommands` checks `quality.commands` + `package.json` scripts


---
## v0.30.0 — Prompt Builder Completion ✅ Shipped (2026-03-08)

**Theme:** Wire PromptBuilder to sections, fix global install crash
**Status:** ✅ Shipped (2026-03-08)

### Stories
- [x] **PW-001:** Expand `role-task.ts` and `isolation.ts` sections to cover all 4 roles — including critical `git commit` instruction in implementer variants.
- [x] **PW-002:** Wire `PromptBuilder` to use `sections/` functions, remove 80+ lines of inline duplicates, delete all 4 empty template stubs.

### Fixes
- **Global install crash:** `bin/nax.ts`, `headless-formatter.ts`, `cli/analyze.ts` read `package.json` at runtime via relative paths — broken in global bun installs. All replaced with static `NAX_VERSION`.

---

## v0.29.0 — Context Simplification ✅ Shipped (2026-03-08)

**Theme:** Disable built-in keyword-based file injection; agents use MCP/tools for context on-demand
**Status:** ✅ Shipped (2026-03-08)

### Stories
- [x] **CTX-001:** Add `context.fileInjection: "keyword" | "disabled"` config flag — default `"disabled"`. Remove keyword-matching as the active default. Keep infrastructure for opt-in.
- [x] **CTX-002:** Update `nax config --explain` to document `context.fileInjection` with rationale (MCP-aware agents don't need pre-injected file contents).
- [x] **CTX-003:** Unit tests — disabled mode injects no file content; keyword mode still works when explicitly enabled.

### Fixes
- **Implementer Prompt:** Restored explicit `git commit` instruction (regression from v0.28.0).
- **Review Stage:** Exclude nax runtime files (`status.json`, `prd.json`, `.nax-verifier-verdict.json`) from the uncommitted-files check.
- **Version Display:** Corrected global binary versioning — `bin` now points to pre-built `dist/nax.js` with commit hash injected.
- **CI Stability:** Fixed mock leakage in review tests for Bun 1.3.9.

---

## v0.28.0 — Prompt Builder ✅ Shipped (2026-03-08)

**Theme:** Unified, user-overridable prompt architecture replacing 11 scattered functions
**Status:** ✅ Shipped (2026-03-08)
**Spec:** `nax/features/prompt-builder/prd.json`

### Stories
- [x] **PB-001:** PromptBuilder class with layered section architecture + fluent API
- [x] **PB-002:** Typed sections: isolation, role-task, story, verdict, conventions
- [x] **PB-003:** Default templates + user override loader + config schema (`prompts.overrides`)
- [x] **PB-004:** Migrate all 6 user-facing prompt call sites to PromptBuilder
- [x] **PB-005:** Document `prompts` config in `nax config --explain` + precheck validation

---

## v0.27.1 — Pipeline Observability ✅ Shipped (2026-03-08)

**Theme:** Fix redundant verify stage + improve pipeline skip log messages
**Status:** ✅ Shipped (2026-03-08)

### Bugfixes
- [x] **BUG-054:** Skip pipeline verify stage when TDD full-suite gate already passed — `runFullSuiteGate()` now returns `boolean`, propagated via `ThreeSessionTddResult` → `executionStage` → `ctx.fullSuiteGatePassed` → `verifyStage.enabled()` returns false with reason "not needed (full-suite gate already passed)"
- [x] **BUG-055:** Pipeline skip messages now differentiate "not needed" from "disabled". Added optional `skipReason(ctx)` to `PipelineStage` interface; `rectify`, `autofix`, `regression`, `verify` stages all provide context-aware reasons

## v0.27.0 — Review Quality ✅ Shipped (2026-03-08)

**Theme:** Fix review stage reliability — dirty working tree false-positive, stale precheck, dead config fields
**Status:** ✅ Shipped (2026-03-08)
**Spec:** `nax/features/review-quality/prd.json`

### Stories
- [x] **RQ-001:** Assert clean working tree before running review typecheck/lint (BUG-049)
- [x] **RQ-002:** Fix `checkOptionalCommands` precheck to use correct config resolution path (BUG-050)
- [x] **RQ-003:** Consolidate dead `quality.commands.typecheck/lint` into review resolution chain (BUG-051)

---

## v0.26.0 — Routing Persistence ✅ Shipped (2026-03-08)

- **RRP-001:** Persist initial routing classification to `prd.json` on first classification
- **RRP-002:** Add `initialComplexity` to `StoryRouting` and `StoryMetrics` for accurate reporting
- **RRP-003:** Add `contentHash` to `StoryRouting` for staleness detection — stale cached routing is re-classified
- **RRP-004:** Unit tests for routing persistence, idempotence, staleness, content hash, metrics
- **BUG-052:** Replace `console.warn` with structured JSONL logger in `review/runner.ts` and `optimizer/index.ts`

---

## v0.25.0 — Trigger Completion ✅ Shipped (2026-03-07)

**Theme:** Wire all 8 unwired interaction triggers, 3 missing hook events, and add plugin integration tests
**Status:** ✅ Shipped (2026-03-07)
**Spec:** [docs/specs/trigger-completion.md](specs/trigger-completion.md)

### Stories
- [x] **TC-001:** Wire `cost-exceeded` + `cost-warning` triggers — fire at 80%/100% of cost limit in sequential-executor.ts
- [x] **TC-002:** Wire `max-retries` trigger — fire on permanent story failure via `story:failed` event in wireInteraction
- [x] **TC-003:** Wire `security-review`, `merge-conflict`, `pre-merge` triggers — review rejection, git conflict detection, pre-completion gate
- [x] **TC-004:** Wire `story-ambiguity` + `review-gate` triggers — ambiguity keyword detection, per-story human checkpoint
- [x] **TC-005:** Wire missing hook events — `on-resume`, `on-session-end`, `on-error` to pipeline events
- [x] **TC-006:** Auto plugin + Telegram + Webhook integration tests — mock LLM/network, cover approve/reject/HMAC flows

---

## v0.24.0 — Central Run Registry ✅

**Theme:** Global run index across all projects — single source of truth for all nax run history
**Status:** ✅ Shipped (2026-03-07)
**Spec:** [docs/specs/central-run-registry.md](specs/central-run-registry.md)

### Stories
- [x] ~~**CRR-000:** `src/pipeline/subscribers/events-writer.ts` — `wireEventsWriter()`, writes lifecycle events to `~/.nax/events/<project>/events.jsonl` (machine-readable completion signal for watchdog/CI)~~
- [x] ~~**CRR-001:** `src/pipeline/subscribers/registry.ts` — `wireRegistry()` subscriber, listens to `run:started`, writes `~/.nax/runs/<project>-<feature>-<runId>/meta.json` (path pointers only — no data duplication, no symlinks)~~
- [x] ~~**CRR-002:** `src/commands/runs.ts` — `nax runs` CLI, reads `meta.json` → resolves live `status.json` from `statusPath`, displays table (project, feature, status, stories, duration, date). Filters: `--project`, `--last`, `--status`~~
- [x] ~~**CRR-003:** `nax logs --run <runId>` — resolve run from global registry via `eventsDir`, stream logs from any directory~~

---

## v0.23.0 — Status File Consolidation ✅

**Theme:** Auto-write status.json to well-known paths, align readers, remove dead options
**Status:** ✅ Shipped (2026-03-07)
**Spec:** [docs/specs/status-file-consolidation.md](specs/status-file-consolidation.md)
**Pre-requisite for:** v0.24.0 (Central Run Registry)

### Stories
- [x] ~~**SFC-001:** Auto-write project-level status — remove `--status-file` flag, always write to `<workdir>/nax/status.json`~~
- [x] ~~**BUG-043:** Fix scoped test command construction + add `testScoped` config with `{{files}}` template~~
- [x] ~~**BUG-044:** Log scoped and full-suite test commands at info level in verify stage~~
- [x] ~~**SFC-002:** Write feature-level status on run end — copy final snapshot to `<workdir>/nax/features/<feature>/status.json`~~
- [x] ~~**SFC-003:** Align status readers — `nax status` + `nax diagnose` read from correct paths~~
- [x] ~~**SFC-004:** Clean up dead code — remove `--status-file` option, `.nax-status.json` references~~

---

## v0.22.1 Pipeline Re-Architecture ✅ Shipped (2026-03-07)
**ADR:** [docs/adr/ADR-005-pipeline-re-architecture.md](adr/ADR-005-pipeline-re-architecture.md)
**Plan:** [docs/adr/ADR-005-implementation-plan.md](adr/ADR-005-implementation-plan.md)

**Theme:** Eliminate ad-hoc orchestration, consolidate 4 scattered verification paths into single orchestrator, add event-bus-driven hooks/plugins/interaction, new stages (rectify, autofix, regression), post-run pipeline SSOT.

- [x] **Phase 1:** VerificationOrchestrator + Pipeline Event Bus (additive, no behavior change)
- [x] **Phase 2:** New stages — `rectify`, `autofix`, `regression` + `retry` stage action
- [x] **Phase 3:** Event-bus subscribers for hooks, reporters, interaction (replace 20+ scattered call sites)
- [x] **Phase 5:** Post-run pipeline SSOT — `deferred-regression` stage, tier escalation into `iteration-runner`, `runAcceptanceLoop` → `runPipeline(postRunPipeline)`

**Resolved:**
- [x] **BUG-040:** Lint/typecheck auto-repair → `autofix` stage + `quality.commands.lintFix/formatFix`
- [x] **BUG-042:** Verifier failure capture → unified `VerifyResult` with `failures[]` always populated
- [x] **FEAT-014:** Heartbeat observability → Pipeline Event Bus with typed events
- [x] **BUG-026:** Regression gate triggers full retry → targeted `rectify` stage with `retry` action
- [x] **BUG-028:** Routing cache ignores escalation tier → cache key includes tier

---

## v0.21.0 — Process Reliability & Observability ✅

**Theme:** Kill orphan processes cleanly, smart-runner precision, test strategy quality
**Status:** ✅ Shipped (2026-03-06)

### Shipped
- [x] **BUG-039 (simple):** Timeouts for review/runner.ts lint/typecheck, git.ts, executor.ts timer leak
- [x] **BUG-039 (medium):** runOnce() SIGKILL follow-up + pidRegistry.unregister() in finally; LLM stream drain (stdout/stderr cancel) before proc.kill() on timeout
- [x] **FEAT-010:** baseRef tracking — capture HEAD per attempt, `git diff <baseRef>..HEAD` in smart-runner (precise, no cross-story pollution)
- [x] **FEAT-011:** Path-only context for oversized files (>10KB) — was silently dropped, now agent gets a path hint
- [x] **FEAT-013:** Deprecated `test-after` from auto routing — simple/medium stories now default to `three-session-tdd-lite`
- [x] ~~**BUG-041:**~~ Won't fix — superseded by FEAT-010
- [x] ~~**FEAT-012:**~~ Won't fix — balanced tier sufficient for test-writer

---

## v0.20.0 — Verification Architecture v2 ✅

**Theme:** Eliminate duplicate test runs, deferred regression gate, structured escalation context
**Status:** ✅ Shipped (2026-03-06)
**Spec:** [docs/specs/verification-architecture-v2.md](specs/verification-architecture-v2.md)

### Shipped
- [x] Pipeline verify stage is single test execution point (Smart Test Runner)
- [x] Removed scoped re-test in `post-verify.ts` (duplicate eliminated)
- [x] Review stage: typecheck + lint only — `checks: ["typecheck", "lint"]`
- [x] Deferred regression gate — `src/execution/lifecycle/run-regression.ts`
- [x] Reverse Smart Test Runner mapping: test → source → responsible story
- [x] Targeted rectification per story with full failure context
- [x] `regressionGate.mode: "deferred" | "per-story" | "disabled"` config
- [x] `maxRectificationAttempts` config (default: 2)
- [x] BUG-037: verify output shows last 20 lines (failures, not prechecks)

---

## v0.19.0 — Hardening & Compliance ✅

**Theme:** Security hardening, _deps injection pattern, Node.js API removal
**Status:** ✅ Shipped (2026-03-04)
**Spec:** [docs/specs/verification-architecture-v2.md](specs/verification-architecture-v2.md) (Phase 2)

### Shipped
- [x] Pipeline verify stage is the single test execution point (Smart Test Runner)
- [x] Remove scoped re-test in `post-verify.ts` (duplicate of pipeline verify)
- [x] Review stage runs typecheck + lint only — remove `review.commands.test` execution
- [x] `priorFailures` injected into escalated agent prompts via `context/builder.ts`
- [x] Reverse file mapping for regression attribution

---

## Shipped

| Version | Theme | Date | Details |
|:---|:---|:---|:---|
| v0.32.1 | Portable Hooks + Docs | 2026-03-09 | GH-001: tilde expansion in hook parser; DOC-001: hooks/triggers/plugins README docs |
| v0.32.0 | TDD Simple Strategy | 2026-03-09 | TS-001–003: `tdd-simple` strategy type, prompt section, execution wiring |
| v0.31.1 | Bugfixes | 2026-03-09 | BUG-056/057/058: PRD status normalization, precheck command detection, session auto-commit |
| v0.31.0 | Prompt Template Export | 2026-03-08 | PE-001/002: `nax prompts --init` + auto-configure overrides; verifier context fix |
| v0.30.0 | Prompt Builder Completion | 2026-03-08 | PW-001/002: sections wired, stubs deleted, git commit instruction live; global install crash fix |
| v0.29.0 | Context Simplification | 2026-03-08 | `context.fileInjection: "disabled"` default; prompt/review/version/CI fixes |
| v0.28.0 | Prompt Builder | 2026-03-08 | Unified, user-overridable prompt architecture; fluent API; default templates |
| v0.27.1 | Pipeline Observability | 2026-03-08 | BUG-054: skip redundant verify after full-suite gate; BUG-055: differentiate skip reasons |
| v0.27.0 | Review Quality | 2026-03-08 | RQ-001–003: clean working tree check, precheck fix, dead config consolidation |
| v0.26.0 | Routing Persistence | 2026-03-08 | RRP-001–004: persist initial routing, initialComplexity, contentHash staleness detection, unit tests; BUG-052: structured logger in review/optimizer |
| v0.25.0 | Trigger Completion | 2026-03-07 | TC-001–004: run.complete event, crash recovery, headless formatter, trigger completion |
| v0.24.0 | Central Run Registry | 2026-03-07 | CRR-000–003: events writer, registry, nax runs CLI, nax logs --run global resolution |
| v0.23.0 | Status File Consolidation | 2026-03-07 | SFC-001–004: auto-write status.json, feature-level status, align readers, remove dead code; BUG-043/044: testScoped config + command logging |
| v0.18.1 | Type Safety + CI Pipeline | 2026-03-03 | 60 TS errors + 12 lint errors fixed, GitLab CI green (1952/56/0) |
| v0.22.2 | Routing Stability + SFC-001 | 2026-03-07 | BUG-040 floating outputPromise crash on LLM timeout retry; SFC-001 auto-write status.json |
| v0.22.1 | Pipeline Re-Architecture | 2026-03-07 | VerificationOrchestrator, EventBus, new stages (rectify/autofix/regression/deferred-regression), post-run SSOT. 2264 pass |
| v0.20.0 | Verification Architecture v2 | 2026-03-06 | Deferred regression gate, remove duplicate tests, BUG-037 |
| v0.19.0 | Hardening & Compliance | 2026-03-04 | SEC-1 to SEC-5, BUG-1, Node.js API removal, _deps rollout |
| v0.18.5 | Bun PTY Migration | 2026-03-04 | BUN-001: node-pty → Bun.spawn, CI cleanup, flaky test fix |
| v0.18.4 | Routing Stability | 2026-03-04 | BUG-031 keyword drift, BUG-033 LLM retry, pre-commit hook |
| v0.18.3 | Execution Reliability + Smart Runner | 2026-03-04 | BUG-026/028/029/030/032 + SFC-001/002 + STR-007, all items complete |
| v0.18.2 | Smart Test Runner + Routing Fix | 2026-03-03 | FIX-001 + STR-001–006, 2038 pass/11 skip/0 fail |
| v0.18.0 | Orchestration Quality | 2026-03-03 | BUG-016/017/018/019/020/021/022/023/025 all fixed |
| v0.17.0 | Config Management | 2026-03-02 | CM-001 --explain, CM-002 --diff, CM-003 default view |

---

## Backlog

### Bugs
- [x] ~~BUG-015: fixed via `skipGlobal: true` in all unit tests~~
- [x] ~~BUG-054: skip redundant verify after full-suite gate passes. Fixed in v0.27.1.~~
- [x] ~~BUG-055: Pipeline skip messages conflate "not needed" with "disabled". Fixed in v0.27.1.~~

### Features
- [ ] **CI-001:** CI Memory Optimization — parallel test sharding to pass on 1GB runners (currently requires 8GB).
- [ ] Cost tracking dashboard
- [ ] npm publish setup
- [ ] `nax diagnose --ai` flag (LLM-assisted, future TBD)
- [ ] **Auto-decompose oversized stories** — When story size gate triggers, offer via interaction chain to auto-decompose using `nax analyse`.
- [ ] VitePress documentation site — full CLI reference, hosted as standalone docs (pre-publish requirement)

---

## Versioning

Sequential canary → stable: `v0.12.0-canary.0` → `canary.N` → `v0.12.0`
Canary: `npm publish --tag canary`
Stable: `npm publish` (latest)

*Last updated: 2026-03-08 (v0.30.0 shipped — Prompt Builder Completion)*
