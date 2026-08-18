# Code Review: @nathapp/nax

**Date:** 2026-08-17
**Reviewer:** Claude (AI)
**Version:** 0.80.0
**Commit:** 268339f3
**Scope:** `src/execution/`, `src/agents/acp/`, `src/worktree/`, `src/queue/`, `src/config/`, `src/routing/`, `src/pipeline/stages/`, `src/review/`, `src/plugins/`, `src/runtime/`, `src/verification/`, `src/logger/`, `src/prd/`
**Depth:** Standard (targeted, checklist-driven — not an exhaustive line-by-line of every file in the repo)

---

## Overall Grade: B+ (83/100)

The codebase is disciplined about the things that are hardest to get right by convention alone: process/subprocess lifecycle, shutdown ordering, lock reclamation, and shell-argument quoting are all correct and, in several places, explicitly documented as fixes for prior bugs (`crash-signals.ts`, `pid-registry.ts`, `lock.ts`). Security posture is strong — no hardcoded secrets, no command injection, no unsafe `eval`, prototype-pollution guards in the config merger, and centralized log redaction. The main gap is in the review-orchestration subsystem (`src/review/`), where several functions have grown to 450–570 lines, concentrating retry logic, telemetry, and control flow in a way that makes them hard to test in isolation and increases regression risk on future changes. One redaction gap (prompt/response audit logs) and a couple of narrow, currently-unexploited path/fail-open gaps round out the findings.

| Dimension | Score | Notes |
|:---|:---:|:---|
| Security | 17/20 | Strong fundamentals; one MEDIUM redaction gap, two LOW defense-in-depth gaps |
| Reliability | 19/20 | Cleanup, cancellation, and shutdown ordering all verified sound |
| API Design | 16/20 | Minor type duplication; otherwise consistent |
| Code Quality | 15/20 | Several oversized functions in `src/review/` drag this down |
| Best Practices | 16/20 | One unguarded `JSON.parse` on a plugin read path |
| **Total** | **83/100** | |

---

## Findings

### 🟠 HIGH

#### TYPE-1: `runSemanticReview` is a 461-line monolith
**Severity:** HIGH | **Category:** Code Quality
**File:** `src/review/semantic.ts:99-559`

The entire semantic-review flow — session setup, retry/parse loop, finding normalization, telemetry — lives in one function, ~15x the project's own ≤30-line function guideline.

**Risk:** Hard to unit test individual phases (prompt build vs. dispatch vs. post-processing) in isolation; any future change risks touching unrelated control flow.
**Fix:** Extract prompt-build, dispatch, and post-processing into named helpers in the same file or a sibling, mirroring the decomposition already used elsewhere (e.g. `recordSemanticAudit`).

#### TYPE-2: `runReview` orchestrator is a 248-line function mixing mechanical and LLM check dispatch
**Severity:** HIGH | **Category:** Code Quality
**File:** `src/review/runner.ts:250-497`

**Risk:** Same testability/regression concern as TYPE-1; the mechanical-check loop and LLM-check dispatch are independent concerns bundled together.
**Fix:** Split into `runMechanicalChecks()` and `runLlmChecks()` (or similar), called from a thin `runReview` orchestrator.

---

### 🔴 CRITICAL

#### TYPE-0: `runAdversarialReview` is a 507-line function
**Severity:** CRITICAL | **Category:** Code Quality
**File:** `src/review/adversarial.ts:66-572`

The entire body of the file after imports/types is one function covering retry, telemetry, recurrence-demotion, and fix-target routing — ~17x the project's ≤30-line guideline. This is the largest and most control-flow-dense function found in the reviewed scope, and it sits on the critical path for every adversarial review cycle (a subsystem already flagged in prior harness-audit memory as a major source of rectification spend).

**Risk:** The size and branching density make this function disproportionately likely to accumulate subtle bugs under future edits (e.g. the kind of `outcome`/telemetry mismatches already recorded in project memory for this subsystem), and disproportionately hard to unit test without full end-to-end review runs.
**Fix:** Extract cohesive sub-steps (session setup, retry/parse loop, finding normalization, telemetry recording) into named helpers, following the pattern already used in `semantic.ts`'s `recordSemanticAudit`. Prioritize this over TYPE-1/TYPE-2 since it's both the largest function and the one with the most documented historical fragility.

---

### 🟡 MEDIUM

#### SEC-1: Prompt/response audit artifacts written to disk unredacted
**Severity:** MEDIUM | **Category:** Security
**File:** `src/runtime/prompt-auditor.ts:252,261`

`_writeEntry` writes full prompts and responses to `<auditDir>/<feature>/*.jsonl` and `.txt` with no redaction, even though the project already has `redactEntry`/`redactSecrets` (`src/logger/redact.ts`) — currently applied at exactly one site (`src/logger/logger.ts:136`). Prompts carry injected repo context (file contents, git history, config), which is exactly where a `DATABASE_URL` or PAT would end up. `.nax/prompt-audit/` is gitignored, so this is on-disk exposure rather than a commit risk, but still a real gap given prompt-audit files are read back by tooling (per project memory: "prompt-audit join for older rows").

**Fix:**
```ts
await _promptAuditorDeps.appendLine(this._jsonlPath, `${JSON.stringify(redactSecrets(entry))}\n`);
// txt path: route through redactSecrets or export redactString from redact.ts
```

#### TYPE-3: `loadConfig` mixes four concerns in one 185-line function
**Severity:** MEDIUM | **Category:** Code Quality
**File:** `src/config/loader.ts:103-287`

Env-var resolution, global/project/CLI layering, migration shims, and validation are all inline in one function.

**Fix:** Split per layering step, matching the documented "Layering Order" in `config-patterns.md` — that order is itself already a natural decomposition boundary.

#### TYPE-4: `Severity`-shaped types redeclared independently in 6+ files instead of a shared alias
**Severity:** MEDIUM | **Category:** Type Safety / DRY
**Files:** `src/review/ac-quote-validator.ts:24`, `src/review/adversarial-helpers.ts:17-18`, `src/review/review-audit.ts:123`, `src/review/semantic-helpers.ts:16`, `src/review/semantic-evidence.ts:40`, `src/review/ac-structural-counterfactual.ts:71,84`

`src/review/severity.ts` already centralizes `SEVERITY_RANK: Record<string, number>` as the stated SSOT rank table but exports no reusable `Severity` type alias, so each consuming file redeclares its own `severity: string` shape.

**Fix:** Add `export type Severity = keyof typeof SEVERITY_RANK | (string & {})` (or a plain string-literal union) to `severity.ts` and import it at each site.

---

### 🟢 LOW

#### SEC-2: Plugin loader's module-path validation fails open when `allowedRoots` is empty
**Severity:** LOW | **Category:** Security (defense-in-depth)
**File:** `src/plugins/loader.ts:410,419`

`allowedRoots: string[] = []` defaults to empty, and an empty array skips traversal validation entirely before `await import(modulePath)` at line 434. All three production call sites (lines 237, 257, 278) currently pass non-empty roots, so this is not exploitable today, but the default is fail-open on a code-execution path.

**Fix:** Make `allowedRoots` required (no default), and reject rather than skip when empty.

#### SEC-3: `featureId` isn't validated before path construction, unlike `storyId`
**Severity:** LOW | **Category:** Security
**File:** `src/config/paths.ts:73-75`

`featureDir(root, featureId)` does a plain `join` with no traversal/charset check, in contrast to `validateStoryId` (`src/prd/validate.ts:24-44`), which rejects `..`, leading `--`, and enforces `^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$`. `featureDir` anchors ~38 call sites including `mkdir(recursive)` and artifact writes. `featureId` originates from the CLI `--feature` flag, so exploitation is self-inflicted today, but the asymmetry with the story-ID path is a real gap that would matter if `featureId` ever came from a less-trusted source (e.g. a webhook payload).

**Fix:** Extract `validateStoryId`'s pattern into a shared `validateIdSegment(id, kind)` and call it at the top of `featureDir`.

#### BUG-1: Unguarded `JSON.parse` on a plugin result-read path
**Severity:** LOW | **Category:** Error Handling
**File:** `src/plugins/builtin/nax-finish/index.ts:129`

```ts
return JSON.parse(await f.text()) as FinishResult;
```
`defaultReadResult` guards `f.exists()` but not malformed content — a truncated `result.json` (flow killed mid-write, disk full) throws out of the post-run action. The sibling curator code handles this correctly (`src/plugins/builtin/curator/collect.ts:68-72`, catches and returns null).

**Fix:** Wrap in try/catch, return `null` on parse failure, matching the not-found contract.

#### STYLE-1: `unified-executor.ts`'s `executeUnified` is a 637-line orchestrator
**Severity:** LOW | **Category:** Code Quality
**File:** `src/execution/unified-executor.ts:91-728`

Mixes cost-limit checks, PRD persistence, deferred review, batch reconciliation, and iteration bookkeeping in one function.

**Fix:** Extract cohesive phases (cost-limit enforcement, per-iteration bookkeeping, deferred-review kickoff) into named helpers, mirroring the pattern already used for `closeStoryIfTerminal`/`enforceCostLimit` at the top of the same file.

#### STYLE-2: Several files approach the repo's file-size ratchet
**Severity:** LOW | **Category:** Code Quality
**Files:** `src/config/runtime-types.ts` (581 lines), `src/config/schemas.ts` (574), `src/review/adversarial.ts` (572), `src/review/semantic.ts` (559), `src/review/runner.ts` (497), `src/pipeline/stages/acceptance-setup.ts` (528), `src/pipeline/stages/acceptance.ts` (468), `src/config/loader.ts` (477), `src/pipeline/stages/context.ts` (427), `src/pipeline/stages/completion.ts` (404)

None currently breach the repo's actual enforced 600-line ratchet (`.claude/rules/project-conventions.md`), but `runtime-types.ts` and `schemas.ts` are within ~20 lines of it, and the CLAUDE.md-documented "400-line typical, 800 max" guidance is already exceeded by 10 files in the reviewed scope.

**Fix:** No immediate action required; worth revisiting if `runtime-types.ts`/`schemas.ts` grow further. The `src/review/*` entries overlap with TYPE-0/TYPE-1/TYPE-2 above and will shrink naturally if those are addressed.

---

## What's Already Solid (no action needed)

Verified clean, not just assumed:
- **Subprocess safety:** every `Bun.spawn` outside the documented shell boundary uses argv arrays; shell interpolation goes through a correct POSIX-quoting helper (`shellQuoteArg`); no command injection found.
- **Shutdown/cleanup:** `crash-signals.ts`, `pid-registry.ts`, `crash-heartbeat.ts`, `lock.ts`, `worktree/manager.ts`, `worktree/merge.ts`, `parallel-worker.ts` all correctly clear timers, dedupe kill signals, verify process identity before signaling, and avoid TOCTOU races on lock reclamation — several with inline comments documenting the specific prior bug (BUG-07, BUG-11, BUG-34, MEM-3) each pattern fixes.
- **No hardcoded secrets, no `eval`/`new Function`**, config merger explicitly guards against prototype pollution, log redaction (`src/logger/redact.ts`) is applied at the logger boundary.
- **No `console.log`**, no dead/commented-out code, no untracked TODO/FIXME found in the reviewed directories.
- The one `any` usage found (`src/pipeline/stages/acceptance-setup.ts:149-158`) is explicitly justified with a `biome-ignore` comment per the project's own convention.

---

## Priority Fix Order

| Priority | ID | Effort | Description |
|:---|:---|:---|:---|
| P0 | TYPE-0 | L | Decompose `runAdversarialReview` (507 lines) — highest-risk, most control-flow-dense function on the review critical path |
| P1 | SEC-1 | S | Apply `redactSecrets` to prompt-auditor disk writes |
| P1 | TYPE-1 | M | Decompose `runSemanticReview` (461 lines) |
| P2 | TYPE-2 | M | Split `runReview`'s mechanical vs. LLM check dispatch |
| P2 | TYPE-3 | S | Split `loadConfig` by layering step |
| P2 | TYPE-4 | S | Add shared `Severity` type alias in `severity.ts`, adopt at 6 call sites |
| P3 | SEC-2 | S | Make `allowedRoots` required in plugin loader (fail-closed) |
| P3 | SEC-3 | S | Validate `featureId` the same way `storyId` is validated |
| P3 | BUG-1 | S | Guard `JSON.parse` in `nax-finish/index.ts:129` |
| P4 | STYLE-1 | M | Decompose `executeUnified` (637 lines) |
| P4 | STYLE-2 | — | Monitor; no action unless files grow further |

**Effort key:** S = <1hr, M = 1-4hrs, L = 4hrs+

---

## Scope Note

This review targeted `src/execution/`, `src/agents/acp/`, `src/worktree/`, `src/queue/`, `src/config/`, `src/routing/`, `src/pipeline/stages/`, `src/review/`, plus focused checks in `src/plugins/`, `src/runtime/`, `src/verification/`, `src/logger/`, and `src/prd/`. It did not cover `src/tui/`, `src/debate/`, `src/analyze/`, `src/hooks/`, `src/optimizer/`, `src/project/`, `src/constitution/`, `src/metrics/`, `src/acceptance/`, `src/tdd/`, `src/cli/`/`src/commands/`, or the `test/` suite itself. A follow-up pass on those directories, and a coverage check against `test:coverage`, would be needed for a full-repo grade.
