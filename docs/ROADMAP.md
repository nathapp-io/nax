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

## Shipped

> Detailed specs for v0.19.0–v0.32.2 → [releases/v0.19.0-v0.32.2.md](releases/v0.19.0-v0.32.2.md)
> Earlier versions → [releases/v0.11.0-and-earlier.md](releases/v0.11.0-and-earlier.md)

| Version | Theme | Date |
|:--------|:------|:-----|
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

*Last updated: 2026-03-09 (v0.35.0 spec added — Agent Abstraction Layer)*
