# Diagnosis — per-role model tiers ignored & empty quality gates false-pass

**Date:** 2026-06-08
**Source run:** `logs/2026-06-08T07-51-57.jsonl` (feature `agent-date-context-caching`, repo `rs-stock`)
**Profile:** `opencode-go.json` (`fast → minimax/MiniMax-M2.7`, `balanced → opencode-go/deepseek-v4-pro`, `powerful → minimax/MiniMax-M3`)
**Status:** Diagnosis only. Issue 1 fix design agreed; Issue 2 fix pending discussion.

---

## Summary

| # | Defect | Severity | Root cause |
|---|---|---|---|
| 1 | Per-story run-ops (implementer / test-writer / verifier) ignore their configured model tier and always dispatch `balanced` | High (cost + correctness) | Ops declare no `model` field → `callOp` falls through to hardcoded `?? "balanced"` |
| 2 | Unconfigured `lint` / `typecheck` gate runs an empty command and reports **"Phase passed"** | High (false-green quality gate) | Deterministic ops read `ctx.config`, which is `undefined` in production; skip-guard is dead code → `/bin/sh -c ""` exits 0 |

**Not a bug (confirmed):** `storyMetrics.modelUsed` derived from `routing.modelTier` (`src/metrics/tracker.ts:117`) is correct by design — the implementer is supposed to track `routing.modelTier`, so once Issue 1 is fixed the metric and the actual dispatch agree.

---

## Issue 1 — per-role model tiers never reach dispatch

### Evidence (US-001, `routing.modelTier: "fast"`, `attempts: 1`, no escalation)

| Phase | Dispatched model (`acpx --model`) | Expected tier |
|---|---|---|
| `acceptance-gen` (L101), `diagnose` (L876) | `minimax/MiniMax-M2.7` | fast ✓ |
| **`implementer` (L184/186)** | **`opencode-go/deepseek-v4-pro`** | **fast ✗ (got balanced)** |
| `reviewer-semantic` / `-adversarial` | `sonnet` (claude balanced) | correct per profile `review.*.model` |

`acceptance-gen` / `diagnose` were correct only because those ops declare `model: (_i, ctx) => ctx.config.acceptance.model`. US-003 looked correct only by coincidence (`complex` → balanced, matching the hardcoded fallback).

### Root cause

The three per-story run-ops declare **no `model` field**:

- `src/operations/implement.ts:36` (`implementerOp`, role `implementer`)
- `src/operations/write-test.ts:43` (`testWriterOp`, role `test-writer`)
- `src/operations/verify.ts:149` (`verifierOp`, role `verifier`)

So in `callOp`:

```ts
// src/operations/call.ts:140
const opModel = resolveOpModel(op, input, buildCtx) ?? "balanced";   // op.model absent → "balanced"
// src/operations/call.ts:147
const effectiveTier = resolved.modelTier ?? "balanced";
```

`effectiveTier` is then handed to `buildHopCallback` → `resolveModelForAgent(config.models, agent, effectiveTier, …)`. The story's `routing.modelTier` and the `tdd.sessionTiers` config are **never consulted**.

### Dead config: `tdd.sessionTiers`

`tdd.sessionTiers` (`src/config/schemas-execution.ts:251`) declares `testWriter` / `implementer` / `verifier` but has **zero runtime consumers** — only CLI descriptions reference it (`src/cli/config-descriptions.ts:123-126`). It is currently inert.

### Correct per-role behavior (agreed)

| Role | Tier source |
|---|---|
| **implementer** | story's **initial `routing.modelTier`**, then the **escalation ladder** |
| **test-writer** (3-session-tdd / lite only) | `tdd.sessionTiers.testWriter` |
| **verifier** (3-session-tdd / lite only) | `tdd.sessionTiers.verifier` |

`tdd.sessionTiers.implementer` is **vestigial** — decision: implementer is **routing-only**; do not read `sessionTiers.implementer`. (Remove it from the schema in a separate change, or leave it unread.)

### Escalation interaction (answered)

Escalation (`src/execution/escalation/tier-escalation.ts:155-179`) **writes the escalated tier back onto `story.routing.modelTier`** in the PRD and resets the attempt counter before the orchestrator re-dispatches. Therefore a resolver of the form:

```ts
model: (input) => input.story.routing?.modelTier
```

reads the **mutated** tier fresh on every attempt — escalation is handled automatically with no special-casing. Attempt 1 reads the initial tier (`fast`); after escalation the same field already holds `balanced`, then `powerful`.

### Proposed fix (Issue 1)

1. **Widen + default `tdd.sessionTiers` in the schema** (`schemas-execution.ts`) so each field accepts a full `ConfiguredModel` (tier string *or* `{ agent, model }`) and carries a Zod default — mirroring the existing pattern `criticModel: ConfiguredModelSchema.default("fast")` (`schemas-infra.ts:21`):

   ```ts
   import { ConfiguredModelSchema } from "./schemas-model";

   sessionTiers: z
     .object({
       testWriter: ConfiguredModelSchema.default("fast"),
       verifier: ConfiguredModelSchema.default("fast"),
       // implementer intentionally omitted — implementer is routing-driven
     })
     .default({}),   // so the defaults materialize even when the block is absent
   ```

   This satisfies "cap it and default if not specified, and support ConfiguredModel": when a user omits `sessionTiers`, test-writer/verifier resolve to the Zod-defaulted tier rather than the accidental `"balanced"` fallback.

2. **Add `model` resolvers to the three ops** (no `callOp` change):

   ```ts
   // implement.ts — routing-only, escalation-aware via the mutated story
   model: (input) => input.story.routing?.modelTier,

   // write-test.ts
   model: (_input, ctx) => ctx.config.tdd?.sessionTiers?.testWriter,

   // verify.ts
   model: (_input, ctx) => ctx.config.tdd?.sessionTiers?.verifier,
   ```

   With the Zod default in place, `ctx.config.tdd.sessionTiers.testWriter` is always populated, so no inline `?? …` fallback is needed. (If the default-materialization via `.default({})` is not wired, fall back explicitly to `input.story.routing?.modelTier`.)

   `ConfiguredModel` flows straight through `resolveConfiguredModel` (`call.ts:145`), which already handles both the tier-string and `{ agent, model }` forms — so a `{ agent, model }` value cross-routes the test-writer/verifier to a different agent, consistent with how `review.*.model` already works.

3. **Tests (TDD):** assert that for a `fast` story the implementer dispatches the profile's `fast` model; that test-writer/verifier follow `sessionTiers` (and the Zod default when unset); and that after a forced escalation the implementer dispatches the escalated tier.

4. **No metrics change** — `modelUsed` from `routing.modelTier` stays.

---

## Issue 2 — empty quality command reports "Phase passed" (NEEDS DISCUSSION)

### Evidence (US-001, package `packages/agent`)

```
quality  Running lint       { command: "", workdir: ".../packages/agent" }
quality  lint completed     { command: "", exitCode: 0, durationMs: 6 }
story-orchestrator  Phase passed: lint-check    { findingsCount: 0 }
quality  Running typecheck  { command: "", … }   → exitCode 0 → Phase passed: typecheck-check
```

**The config is NOT missing.** It is fully defined on disk:

| Source | `quality.commands.lint` | `quality.commands.typecheck` |
|---|---|---|
| Root `.nax/config.json` | `uv run ruff check .` | `uv run mypy packages/*/src/* apps/api/src/*` |
| `.nax/mono/packages/agent/config.json` | `uv run ruff check packages/agent` | `uv run mypy packages/agent/src/stock_agent` |

So `command: ""` proves **neither** the per-package nor the root config reached the op. There are **two layered defects**.

### Defect 2a — ops read a phantom `ctx.config` (the proximate cause of `command: ""`)

`src/operations/lint-check.ts:42-56` (and `typecheck-check.ts` mirror):

```ts
const ctxConfig = (ctx as unknown as { config?: QualityConfig }).config;  // phantom field
const command = ctxConfig?.quality?.commands?.lint;
if (ctxConfig !== undefined && !command) {                                // dead guard
  return { success: true, findings: [], durationMs: 0 };
}
const result = await deps.runQualityCommand({ command: command ?? "", … });  // runs ""
```

**Why `ctx.config` is undefined in production:**
- `lintCheckOp` / `typecheckCheckOp` are `DeterministicOperation`s. `callOp`'s deterministic branch (`call.ts:125`) returns `op.execute(input, ctx)` **without** the config-slicing the other op kinds get at `call.ts:130-131`.
- `CallContext` (`src/operations/types.ts:15`) has **no `config` field** — config lives behind `ctx.packageView` (`ctx.packageView.select(selector)` or `ctx.packageView.config`).
- `(ctx as unknown as { config? }).config` therefore reads a field that simply does not exist on the real object → always `undefined`. It is only ever populated by **tests** that pass `{ config }` directly (see op comment `lint-check.ts:41`). The test injection masks the production wiring gap.
- Result: skip-guard `ctxConfig !== undefined && !command` never fires → `command ?? ""` → `/bin/sh -c ""` → exit 0 → `runner.ts:179 success = exitCode === 0` → **false green**.

**Fix 2a:** read `ctx.packageView.select(qualityConfigSelector)` (or `ctx.packageView.config.quality`) instead of the phantom `ctx.config`. Makes the existing skip-guard live and routes through the real config.

### Defect 2b — runtime package registry never merges per-package config (latent; wrong scope even after 2a)

`src/runtime/packages.ts:42-54`, `createPackageRegistry().resolve()`:

```ts
function resolve(packageDir?: string): PackageView {
  // Wave 1: no per-package config merging — root config only.
  // Wave 3 will call mergePackageConfig(root, loadPackageOverride(packageDir)).
  const config = loader.current();          // <-- ROOT config, packageDir ignored
  const view = createPackageView(config, key, repoRoot);
  ...
}
```

- This is a **Wave-1 stub**. `loadPackageOverride` **does not exist** anywhere in `src/`. `mergePackageConfig` (`config/merge.ts:33`, which merges `.nax/mono/<pkg>/config.json`) is only called by `loadConfigForWorkdir` (`loader.ts:501`), which in turn is only used by `acceptance-setup.ts:126` and CLI commands — **not** by the main story-execution pipeline.
- The runtime registry is built once with the root `configLoader` (`runtime/index.ts:244`), and every `packageView` in the main pipeline (`execution.ts:66`, `acceptance-setup.ts:164`) comes from this stub → **root config only**.
- Consequence: even after Fix 2a, `ctx.packageView.select(qualityConfig)` returns **root** commands (`uv run ruff check .` whole-repo, `uv run mypy packages/*/src/* apps/api/src/*` whole-repo) — **not** the package-scoped `uv run ruff check packages/agent`. Functional, but wrong scope: slower, and a failure in another package would be attributed to this story.
- **Broader implication:** this affects **every** packageView consumer in the main pipeline, not just quality — any per-package override in `.nax/mono/<pkg>/config.json` (test commands, test-file patterns, context tuning) is silently ignored during the main run. This warrants its own verification pass.

**Fix 2b:** implement the Wave-3 TODO — `resolve(packageDir)` must merge the per-package override: `mergePackageConfig(loader.current(), loadPackageOverride(repoRoot, packageDir))`, with memoization per `packageDir`. (Add the missing `loadPackageOverride` reader.)

### Candidate fixes summary

| Fix | What | Scope |
|---|---|---|
| **2a** | Ops read `ctx.packageView.select(qualityConfigSelector)`, not phantom `ctx.config` | Removes the empty-command false-green |
| **2b** | `packages.resolve()` merges `.nax/mono/<pkg>/config.json` (implement Wave-3) | Restores per-package scoping for ALL packageView consumers |
| **C** | Decide skip-with-warning vs hard-fail when a gate phase has no command | Quality-gate semantics |
| **D** | Guard `runQualityCommand` against empty/whitespace `command` (defense-in-depth) | Prevents `""` ever passing as exit-0, regardless of caller |

### Open discussion points

1. **2a + 2b are both required** for correct per-package quality gating. Do we fix them together, or land 2a first (stops the false-green) and 2b separately (it's a bigger, cross-cutting monorepo fix)?
2. **Skip vs fail (C):** when a gate phase runs with genuinely no command configured, skip-with-visible-warning or hard-fail? A silently-passing gate reads as "lint clean" when lint never ran — dangerous. Given this repo *does* configure commands, the realistic "no command" case is misconfiguration → leaning hard-fail (or at least a loud, aggregated run-summary warning), not silent skip.
3. **Blast radius of 2b:** audit every `packageView` / `ctx.config` consumer (`full-suite-gate`, `verify-scoped`, test-command resolver, context providers) — how many silently used root config during this run? `verify-scoped` showed `durationMs: 0` in the log, which is suspicious and worth checking.
4. **Defense-in-depth (D):** independent of 2a/2b, should `runQualityCommand` treat an empty/whitespace command as a hard error rather than spawning `/bin/sh -c ""`?

---

## Issue 2 — Blast-radius audit (2026-06-08)

**Decision:** fix 2a + 2b together; unconfigured-gate behavior = **skip with a visible warning**.

### Three config-access patterns in op code

The CallContext built for op dispatch (`pipeline/stages/execution.ts:77-84`, re-spread at `story-orchestrator.ts:827`) carries `packageView`, `packageDir`, `story` — but **no `config` field**. Ops read config three different ways:

| # | Pattern | Yields in prod | Defect |
|---|---|---|---|
| P1 | `(ctx as unknown as { config }).config` (phantom) | `undefined` | **2a** |
| P2 | `ctx.packageView.select(sel)` / `ctx.packageView.config` | **root** config (Wave-1 stub) | **2b** |
| P3 | `ctx.runtime.configLoader.current()` | **root** config (by definition) | **2b** |

P2 and P3 both ignore per-package overrides. P1 ignores config entirely.

### P1 — phantom `ctx.config` victims (all `DeterministicOperation`s)

| Op | Config read | Production effect | Severity | Log proof |
|---|---|---|---|---|
| `lint-check.ts:42` | `quality.commands.lint` | `command:""` → `/bin/sh -c ""` → false "passed" | **HIGH** | L199-201 (`command:""`) |
| `typecheck-check.ts:46` | `quality.commands.typecheck` | same false-green | **HIGH** | L202-204 (`command:""`) |
| `verify-scoped.ts:62` | `quality.commands.test` | `!ctxConfig` guard → **always no-op** (`durationMs:0`, status passed) — per-story scoped RED/GREEN never runs | **HIGH** | US-001 verify-scoped `durationMs:0` |
| `mechanical-lintfix-strategy.ts:60` | `quality.commands.lintFix` | autofix lint repair can't resolve command → no-op | MED | — |
| `mechanical-formatfix-strategy.ts:56` | `quality.commands.formatFix` | autofix format repair can't resolve command → no-op | MED | — |
| `full-suite-gate.ts:198` | `execution.regressionGate.{enabled,acceptOnTimeout}` (flags only) | flags default `?? true` → can't disable gate or honor `acceptOnTimeout:false`; **test command itself is fine** (resolved via P3) | LOW | L454 (gate ran) |

> **Safety net:** per-story `verify-scoped` being a no-op is partially masked by the **deferred run-end full-suite regression gate** (`run-regression` lifecycle, L1090-1122), which DID catch 3 failing tests and rectify US-005. So regressions are still caught at run-end — but per-story early feedback (the point of scoped verify) is lost, and the run log misleadingly shows scoped verify "passed."

`auto-approve.ts:26` and `setup-generate.ts:38` match the `.config` grep but are **false positives** — they read `.config` off a prompt-section object / parsed LLM output, not `CallContext`. Not affected.

### P2/P3 — per-package override ignored (2b), confirmed live

- `full-suite-gate.ts:111` (P3) ran `command:"uv run pytest"` (root) for US-003 in cwd `packages/agent` — the per-package `uv run pytest packages/agent/tests` (`.nax/mono/packages/agent/config.json`) was **ignored**. Direct on-disk proof of 2b. (Worked only because cwd was the package dir; in other layouts this would run the wrong suite.)
- Other P2/P3 sites silently on root config this run: `implement.ts:82` & `verify.ts:142` (`execution.smartTestRunner` per-package tuning), `classify-route.ts:53,93` (routing validation), and the **entire `callOp` slice path** `call.ts:130` — i.e. **every non-deterministic op** (LLM dispatch) used root config. Most don't carry per-package overrides that matter (model/routing config is typically root-level), but test-command / test-pattern / smartRunner / context tuning are real per-package keys that were dropped.

### Combined fix plan (2a + 2b)

1. **Standardize all op config access on `packageView`** — the SSOT. Migrate P1 phantom reads (6 ops) and P3 `configLoader.current()` reads (`full-suite-gate.ts:111`) to `ctx.packageView.select(qualityConfigSelector)` / `ctx.packageView.config`. After this, there is exactly one config source for ops.
2. **Make `packageView` actually merge per-package config** — implement the Wave-3 TODO in `runtime/packages.ts:48`: add `loadPackageOverride(repoRoot, packageDir)` and `resolve(packageDir)` → `createPackageView(mergePackageConfig(loader.current(), override), packageDir, repoRoot)`, memoized per `packageDir`. Reuse `mergePackageConfig` (`config/merge.ts:33`) — same merge already proven in `loadConfigForWorkdir`.
3. **Skip-with-warning semantics** — when a gate's resolved command is empty/absent: return `status:"skipped"` + `logger.warn("quality", "no <gate> command configured — skipping", { storyId, packageDir })`, and surface it in the run summary so a skipped gate never reads as a pass. (Distinct from `full-suite-gate`'s existing `TEST_COMMAND_MISSING` throw — reconcile: missing **test** command stays a hard error; missing **lint/typecheck/format** warns-and-skips.)
4. **Defense-in-depth (recommended)** — `runQualityCommand` rejects empty/whitespace `command` instead of spawning `/bin/sh -c ""`, so no caller can ever produce a false exit-0.
5. **Tests:** verify a per-package `.nax/mono/<pkg>/config.json` override reaches each migrated op (lint/typecheck/verify-scoped/full-suite-gate); verify unconfigured lint/typecheck warns-and-skips (not false-pass); verify full-suite-gate uses the **package** test command, not root.

### Verification sequencing note

2a and 2b interact: fixing 2a (P1 → packageView) without 2b would route lint/typecheck through **root** commands (whole-repo `uv run ruff check .`) — runs, but wrong scope. Landing them together is required for correct per-package gating, per decision above.

---

## File reference index

| Concern | Location |
|---|---|
| Hardcoded `"balanced"` fallback | `src/operations/call.ts:140,147` |
| Implementer op (no model) | `src/operations/implement.ts:36` |
| Test-writer op (no model) | `src/operations/write-test.ts:43` |
| Verifier op (no model) | `src/operations/verify.ts:149` |
| `tdd.sessionTiers` schema (dead) | `src/config/schemas-execution.ts:251` |
| `ConfiguredModelSchema` (union + default pattern) | `src/config/schemas-model.ts:48`, `schemas-infra.ts:21` |
| Escalation writes story tier | `src/execution/escalation/tier-escalation.ts:155-179` |
| Metrics `modelUsed` (correct) | `src/metrics/tracker.ts:117` |
| Lint gate empty-command (P1) | `src/operations/lint-check.ts:42` |
| Typecheck gate empty-command (P1) | `src/operations/typecheck-check.ts:46` |
| Scoped verify always no-op (P1) | `src/operations/verify-scoped.ts:62-75` |
| Autofix lint/format strategies (P1) | `src/operations/mechanical-lintfix-strategy.ts:56`, `mechanical-formatfix-strategy.ts:60` |
| Full-suite-gate flag reads (P1) | `src/operations/full-suite-gate.ts:198` |
| Full-suite-gate test-cmd via root (P3) | `src/operations/full-suite-gate.ts:111` (`configLoader.current()`) |
| Quality runner (`/bin/sh -c command`) | `src/quality/runner.ts:101,179` |
| `CallContext` (no `config` field) | `src/operations/types.ts:15` |
| Deterministic branch (no slicing) | `src/operations/call.ts:125` |
| PackageRegistry Wave-1 stub (2b) | `src/runtime/packages.ts:48-51` |
| Per-package merge (proven, used elsewhere) | `src/config/merge.ts:33`, `src/config/loader.ts:501` |
| CallContext built for dispatch (no config) | `src/pipeline/stages/execution.ts:77-84` |
| False positives (not CallContext) | `src/operations/auto-approve.ts:26`, `setup-generate.ts:38` |
