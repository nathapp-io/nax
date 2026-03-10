# nax Roadmap

> **Authoritative source** for planned and shipped versions.
> Specs in `memory/` are detailed references. GitLab issues are supplementary.
> Full release notes → `docs/releases/`

---


## v0.38.0 — Test Health Audit (Planned)

**Theme:** Audit and slim down the test suite — remove redundant coverage, consolidate copy-paste tests, delete dead feature tests
**Status:** 🔲 Planned
**Depends on:** None (can run anytime)

### Context

- **226 test files**, 3,014 tests, 67K lines of test code
- 10 files exceed 600 lines (largest: `context.test.ts` at 1,734 lines)
- Integration tests likely duplicate unit test coverage in several areas
- Copy-paste test patterns (same logic, one param changed) inflate line count

### Stories

- [ ] **TH-001:** Automated coverage overlap report — script that cross-references integration tests against unit tests, flags tests covering identical code paths. Output: markdown report with recommended deletions
- [ ] **TH-002:** Dead test detection — identify test files importing functions/modules that no longer exist in `src/`, or testing removed features (pre-v0.22.1 verification paths, old routing, etc.)
- [ ] **TH-003:** Copy-paste consolidation — convert repeated test patterns to `test.each()` / table-driven style. Target: files with 3+ similar `describe` blocks differing by 1-2 params
- [ ] **TH-004:** Execute cleanup — delete confirmed redundant tests, apply `test.each()` conversions, verify full suite still passes with same or higher coverage
- [ ] **TH-005:** Test file size enforcement — add a precheck/lint rule that warns on test files exceeding 500 lines (soft limit) or 800 lines (hard limit)

### Success Criteria

- Test count reduced by ≥15% without losing meaningful coverage
- No test file exceeds 800 lines
- Full suite runtime unchanged or faster
- CI still passes on 8GB runner

---

## v0.37.0 — Prompt Template Export (Planned)

**Theme:** Complete the prompt override system — ship default templates, add CLI export, enable full user customization
**Status:** 🔲 Planned
**Depends on:** v0.36.2 (Prompt Optimization)

### Context

The override system exists (`config.prompts.overrides`, `loadOverride()`, `PromptBuilder.withLoader()`) but users can't easily customize prompts because:
- No default templates shipped as files
- No CLI command to export defaults as starting points
- `tdd-simple` role missing from override schema

### Stories

- [ ] **PT-001:** Add `tdd-simple` to `PromptsConfigSchema` override enum
- [ ] **PT-002:** Ship default `.md` templates for all 5 roles in `nax/prompts/` scaffold
- [ ] **PT-003:** `nax prompts export` CLI command — dumps default prompt for a given role to stdout or file
- [ ] **PT-004:** Update `nax init` to scaffold `nax/prompts/` directory with default templates
- [ ] **PT-005:** Documentation — prompt customization guide

---

## v0.36.2 — Parallel Metrics & Rectification (Planned)

**Theme:** Fix metrics aggregation for parallel runs (BUG-064–071) and implement sequential rectification for merge conflicts
**Status:** 📋 Planned (nax self-dev run, post v0.36.1 release)
**Depends on:** v0.36.1 (Prompt Optimization)

### Stories

- [ ] **MFX-001:** Parallel batch metrics aggregation (BUG-064/065/066)
- [ ] **MFX-002:** Escalation metrics preservation (BUG-067)
- [ ] **MFX-003:** Parallel executor cleanup (BUG-068/069/071)
- [ ] **MFX-004:** Runtime crash vs test failure classification (BUG-070)
- [ ] **MFX-005:** Merge conflict rectification — sequential re-run of conflicted stories on updated base

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

## v0.34.0 — Run Lifecycle Hooks & Smart Regression ✅ Shipped (2026-03-09)

**Theme:** Fix run lifecycle ordering (BUG-060), add missing hooks, skip redundant deferred regression
**Status:** ✅ Shipped (2026-03-09)

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

*Last updated: 2026-03-10 (v0.36.1 shipped — Prompt Optimization + BUG-072/073)*
