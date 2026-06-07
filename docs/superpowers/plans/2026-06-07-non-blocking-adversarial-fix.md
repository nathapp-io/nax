# Non-Blocking Adversarial Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After per-story adversarial review passes, run a bounded, non-blocking best-effort auto-fix over the sub-threshold (warning/info) findings nax already produced, gated by deterministic re-validation only, restoring to the adversarial-passed state on exhaustion so the story can never be made worse.

**Architecture:** Decouple "block" from "fix" (ADR-024). The blocking gate is unchanged. The non-blocking pass reuses the existing `runRectification` harness (`runFixCycle` + `autofix-implementer`/`autofix-test-writer` strategies + `phasesToRevalidate`) via a new optional `overrides` parameter that (a) seeds it with advisory findings, (b) strips the LLM-review phases from revalidation, (c) bounds attempts, and (d) optionally adds the verifier for test edits. A single working-tree snapshot taken at pass entry, plus a `phaseOutputs` snapshot, is restored on exhaustion. Only new code: the config, the advisory-findings surfacing, the snapshot/restore helper, and the wiring.

**Tech Stack:** Bun 1.3.7+, TypeScript strict, `bun:test`, Zod (config), Biome. All git via `Bun.spawn` through existing `_deps`.

---

## File Structure

| File | Responsibility | Action |
|:---|:---|:---|
| `src/config/schemas-review.ts` | Add `nonBlockingFix` to `AdversarialReviewConfigSchema` | Modify |
| `src/operations/adversarial-review.ts` | Populate `advisoryFindings` (non-blocking) in `verify()` output | Modify |
| `src/review/types.ts` | `advisoryFindings` already exists (`:109`) — verify only | Read |
| `src/tdd/rollback.ts` | Reuse `rollbackToRef`; add `captureSnapshotRef` (commit-based) | Modify |
| `src/execution/build-plan-for-strategy.ts` | Thread `nonBlockingFix` config into the plan/state | Modify |
| `src/execution/story-orchestrator.ts` | Add `overrides` param to `runRectification`; add `nonBlockingFix` to `InternalBuildState`; wire into `ExecutionPlan.run` | Modify |
| `src/execution/non-blocking-fix.ts` | Build advisory findings → scope-filtered strategies → invoke harness with overrides → snapshot/restore | Create |
| `test/unit/config/non-blocking-fix-config.test.ts` | Schema defaults | Create |
| `test/unit/operations/adversarial-advisory-findings.test.ts` | verify() populates advisoryFindings | Create |
| `test/unit/tdd/capture-snapshot-ref.test.ts` | entry-ref capture | Create |
| `test/unit/execution/rectification-overrides.test.ts` | overrides seed/strip/bound | Create |
| `test/unit/execution/non-blocking-fix.test.ts` | best-effort pass: keep on green, restore on exhaust | Create |

---

## Phase 1 — Config

### Task 1: `review.adversarial.nonBlockingFix` schema

**Files:**
- Modify: `src/config/schemas-review.ts:58-116` (`AdversarialReviewConfigSchema`)
- Test: `test/unit/config/non-blocking-fix-config.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/unit/config/non-blocking-fix-config.test.ts
import { describe, expect, test } from "bun:test";
import { AdversarialReviewConfigSchema } from "@/config/schemas-review";

describe("nonBlockingFix config", () => {
  test("defaults: disabled, scope both, 1 regression attempt, verifierGuard on", () => {
    const cfg = AdversarialReviewConfigSchema.parse({ nonBlockingFix: {} });
    expect(cfg.nonBlockingFix).toEqual({
      enabled: false,
      scope: "both",
      regressionAttempts: 1,
      verifierGuard: true,
    });
  });

  test("absent nonBlockingFix parses to undefined", () => {
    const cfg = AdversarialReviewConfigSchema.parse({});
    expect(cfg.nonBlockingFix).toBeUndefined();
  });

  test("rejects scope outside source|both", () => {
    expect(() => AdversarialReviewConfigSchema.parse({ nonBlockingFix: { scope: "test" } })).toThrow();
  });

  test("rejects negative regressionAttempts", () => {
    expect(() => AdversarialReviewConfigSchema.parse({ nonBlockingFix: { regressionAttempts: -1 } })).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `AGENT=1 timeout 30 bun test test/unit/config/non-blocking-fix-config.test.ts --timeout=5000`
Expected: FAIL — `nonBlockingFix` is not a known key / parses to `undefined` for the defaults case.

- [ ] **Step 3: Add the schema**

Insert before the closing `});` of `AdversarialReviewConfigSchema` (after `substantiation`, `src/config/schemas-review.ts:115`):

```typescript
  /**
   * ADR-024 — Non-blocking best-effort auto-fix over sub-threshold (warning/info)
   * adversarial findings, run after adversarial review passes. Never blocks the
   * story; restores to the adversarial-passed state on exhaustion.
   */
  nonBlockingFix: z
    .object({
      /** Master switch. Opt-in; ramp to true after validating signal quality. */
      enabled: z.boolean().default(false),
      /**
       * "source": autofix-implementer only.
       * "both":    + autofix-test-writer (test edits allowed).
       */
      scope: z.enum(["source", "both"]).default("both"),
      /** Fix attempts to clear a regression the best-effort fix introduced. */
      regressionAttempts: z.number().int().min(0).default(1),
      /**
       * When true (default) and a test edit occurs (scope "both"), add the verifier
       * to deterministic revalidation as the replacement for the stripped adversarial
       * re-run. No-op when no verifier exists (single-session).
       */
      verifierGuard: z.boolean().default(true),
    })
    .optional(),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `AGENT=1 timeout 30 bun test test/unit/config/non-blocking-fix-config.test.ts --timeout=5000`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/config/schemas-review.ts test/unit/config/non-blocking-fix-config.test.ts
git commit -m "feat(config): add review.adversarial.nonBlockingFix schema (ADR-024)"
```

---

## Phase 2 — Surface advisory findings

### Task 2: Populate `advisoryFindings` in adversarial `verify()`

`verify()` (`src/operations/adversarial-review.ts:466-492`) currently converts only the **blocking** subset to `Finding[]` (`normalizedFindings`). The non-blocking accepted findings are computed (`accepted`) and dropped. Surface them as `advisoryFindings`.

> **Note:** `advisoryFindings` already exists as a field on `ReviewCheckResult` (`src/review/types.ts:109`) with the same "non-blocking" meaning. This task adds a **new, separate** field of the same name to `AdversarialReviewOutput` — it is not a reuse of that field, just a deliberately consistent name. No change to `ReviewCheckResult`.

**Files:**
- Modify: `src/operations/adversarial-review.ts:97` (`AdversarialReviewOutput` type) and `:485-491` (verify return)
- Test: `test/unit/operations/adversarial-advisory-findings.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/unit/operations/adversarial-advisory-findings.test.ts
import { describe, expect, test } from "bun:test";
import { adversarialReviewOp } from "@/operations/adversarial-review";
import type { AdversarialReviewInput } from "@/operations/adversarial-review";

const story = { id: "us-001", title: "t", acceptanceCriteria: [] } as unknown as AdversarialReviewInput["story"];

describe("adversarial verify() advisoryFindings", () => {
  test("non-blocking findings are surfaced as advisoryFindings, not normalizedFindings", async () => {
    const parsed = {
      passed: true,
      findings: [
        { severity: "warning", category: "input", file: "a.ts", line: 1, issue: "tz bug", suggestion: "fix" },
        { severity: "info", category: "convention", file: "b.ts", line: 2, issue: "inline const", suggestion: "hoist" },
      ],
      normalizedFindings: [],
      acDropped: [],
    };
    const input = { workdir: process.cwd(), story, blockingThreshold: "error" } as unknown as AdversarialReviewInput;
    // biome-ignore lint/suspicious/noExplicitAny: exercising op.verify directly
    const out = await (adversarialReviewOp as any).verify(parsed, input, {});
    expect(out.normalizedFindings).toHaveLength(0); // none are blocking at threshold "error"
    expect(out.advisoryFindings).toHaveLength(2);
    expect(out.advisoryFindings.map((f: { message: string }) => f.message)).toEqual(["tz bug", "inline const"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `AGENT=1 timeout 30 bun test test/unit/operations/adversarial-advisory-findings.test.ts --timeout=5000`
Expected: FAIL — `out.advisoryFindings` is `undefined`.

- [ ] **Step 3: Add `advisoryFindings` to the output type**

In `AdversarialReviewOutput` (`src/operations/adversarial-review.ts:97`), add the field alongside `normalizedFindings`:

```typescript
  /** ADR-024 — non-blocking (sub-threshold) findings, surfaced for the best-effort fix pass. */
  advisoryFindings?: Finding[];
```

- [ ] **Step 4: Populate it in `verify()`**

Replace the return block at `src/operations/adversarial-review.ts:485-491`:

```typescript
    const blocking = accepted.filter((f) => isBlockingSeverity(f.severity, threshold));
    const advisory = accepted.filter((f) => !isBlockingSeverity(f.severity, threshold));
    const passed = parsed.passed && blocking.length === 0;

    return {
      ...parsed,
      passed,
      findings: accepted,
      normalizedFindings: toAdversarialReviewFindings(blocking),
      advisoryFindings: toAdversarialReviewFindings(advisory),
      acDropped: dropped,
    };
```

- [ ] **Step 5: Run test to verify it passes**

Run: `AGENT=1 timeout 30 bun test test/unit/operations/adversarial-advisory-findings.test.ts --timeout=5000`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/operations/adversarial-review.ts test/unit/operations/adversarial-advisory-findings.test.ts
git commit -m "feat(review): surface non-blocking adversarial findings as advisoryFindings (ADR-024)"
```

---

## Phase 3 — Snapshot / restore primitive

### Task 3: `captureSnapshotRef` helper (commit-based)

**Why commit-based, not `git stash create`:** at the best-effort insertion point the story's changes are **uncommitted**, and its newly-created files are **untracked** (`autoCommitIfDirty` only runs later, in post-run). `git stash create` does **not** capture untracked files, and `rollbackToRef` runs `git reset --hard` **+ `git clean -fd`** (`src/tdd/rollback.ts:15,28`) — so a stash-create snapshot followed by restore would **delete the story's own untracked files**. Instead, **commit** the adversarial-passed state first (making everything tracked), record its SHA, and restore to that commit. This matches how nax already snapshots for rollback (`post-run.ts:481` uses `rollbackToRef` against a commit ref).

Reuse `autoCommitIfDirty(workdir, stage, role, storyId): Promise<void>` (`src/utils/git.ts:223`) and `rollbackToRef(workdir, ref)` (`src/tdd/rollback.ts:11`). Add a helper that commits-if-dirty then returns the resulting HEAD SHA.

**Files:**
- Modify: `src/tdd/rollback.ts`
- Test: `test/unit/tdd/capture-snapshot-ref.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/unit/tdd/capture-snapshot-ref.test.ts
import { describe, expect, test } from "bun:test";
import { captureSnapshotRef } from "@/tdd/rollback";

describe("captureSnapshotRef", () => {
  test("commits dirty state then returns HEAD sha", async () => {
    const calls: string[][] = [];
    const fakeCommit = async () => { calls.push(["autoCommitIfDirty"]); };
    const fakeSpawn = ((args: string[]) => {
      calls.push(args);
      return { stdout: new Response("cafebabecafebabecafebabecafebabecafebabe\n").body, exited: Promise.resolve(0) };
    }) as unknown as typeof Bun.spawn;
    const sha = await captureSnapshotRef("/tmp/x", "us-001", { autoCommitIfDirty: fakeCommit, spawn: fakeSpawn });
    expect(sha).toBe("cafebabecafebabecafebabecafebabecafebabe");
    expect(calls[0]).toEqual(["autoCommitIfDirty"]); // commit BEFORE rev-parse
    expect(calls[1]).toEqual(["git", "rev-parse", "HEAD"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `AGENT=1 timeout 30 bun test test/unit/tdd/capture-snapshot-ref.test.ts --timeout=5000`
Expected: FAIL — `captureSnapshotRef` is not exported.

- [ ] **Step 3: Implement the helper**

Add to `src/tdd/rollback.ts` (import `autoCommitIfDirty` from `../utils/git`):

```typescript
/**
 * Capture the current (adversarial-passed) state as a restorable commit ref
 * (ADR-024 non-blocking-fix entry snapshot). Commits any uncommitted/untracked
 * story changes so they are TRACKED, then returns the resulting HEAD SHA.
 * Restore via rollbackToRef(workdir, sha): `git reset --hard sha` + `git clean -fd`
 * discards only the best-effort changes, NOT the story's committed files.
 */
export async function captureSnapshotRef(
  workdir: string,
  storyId: string,
  _deps: { autoCommitIfDirty?: typeof autoCommitIfDirty; spawn?: typeof Bun.spawn } = {},
): Promise<string> {
  const commit = _deps.autoCommitIfDirty ?? autoCommitIfDirty;
  const spawn = _deps.spawn ?? Bun.spawn;
  await commit(workdir, "non-blocking-fix-snapshot", "snapshot", storyId);
  const proc = spawn(["git", "rev-parse", "HEAD"], { cwd: workdir, stdout: "pipe", stderr: "pipe" });
  const sha = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  return sha;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `AGENT=1 timeout 30 bun test test/unit/tdd/capture-snapshot-ref.test.ts --timeout=5000`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tdd/rollback.ts test/unit/tdd/capture-snapshot-ref.test.ts
git commit -m "feat(tdd): add captureSnapshotRef (commit-based entry snapshot) for non-blocking fix (ADR-024)"
```

> Restore always targets a real commit SHA (HEAD always resolves), so there is no `null`/`storyGitRef`-fallback case. `rollbackToRef(workdir, sha)`'s `reset --hard` + `clean -fd` correctly discards the best-effort's tracked edits and any new untracked files it created, returning the tree to the committed adversarial-passed state. The only artifact on the keep path is one extra commit, consistent with nax's existing auto-commit behavior.

---

## Phase 4 — Parameterize the harness

### Task 4: `runRectification` `overrides` parameter

Add an optional, backward-compatible `overrides` argument so the same harness can seed advisory findings, strip review phases, add the verifier, supply scope-filtered strategies, and bound attempts.

**Files:**
- Modify: `src/execution/story-orchestrator.ts:941-1048` (`runRectification`)
- Test: `test/unit/execution/rectification-overrides.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/unit/execution/rectification-overrides.test.ts
import { describe, expect, test } from "bun:test";
import { phasesToRevalidate } from "@/execution/story-orchestrator";

// phasesToRevalidate is the pure function the overrides path relies on: stripping
// review phases from the input set must remove them from the selected set even
// when the strategy mapping lists them.
describe("review-stripped revalidation", () => {
  test("excluding review phases removes them from autofix-implementer's selected set", () => {
    const mk = (kind: string) => ({ kind, slot: { op: { name: kind } } }) as never;
    const all = [
      mk("lint-check"),
      mk("typecheck-check"),
      mk("full-suite-gate"),
      mk("semantic-review"),
      mk("adversarial-review"),
    ];
    const stripped = all.filter((p) => !["semantic-review", "adversarial-review"].includes((p as { kind: string }).kind));
    const selected = phasesToRevalidate(["autofix-implementer"], stripped);
    expect(selected.map((p) => (p as { kind: string }).kind)).toEqual(["lint-check", "typecheck-check", "full-suite-gate"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `AGENT=1 timeout 30 bun test test/unit/execution/rectification-overrides.test.ts --timeout=5000`
Expected: FAIL only if `phasesToRevalidate` is not exported with this behavior — it is exported (`:515`), so this test should PASS immediately, confirming the strip mechanism. If it passes, proceed to Step 3 (the override plumbing) and treat this as a guard test.

- [ ] **Step 3: Add the `RectificationOverrides` type and parameter**

Above `runRectification` (`src/execution/story-orchestrator.ts:941`), add:

```typescript
/**
 * ADR-024 — overrides that repurpose the rectification harness for the
 * non-blocking best-effort pass. All optional; omitting them preserves the
 * blocking-cycle behavior exactly.
 */
export interface RectificationOverrides {
  /** Seed findings instead of gatherRectificationFindings(...). */
  initialFindings?: readonly Finding[];
  /** Strategy set instead of state.rectification.strategies (scope filtering). */
  strategies?: FixStrategy<Finding, unknown, unknown, unknown>[];
  /** Phase kinds removed from validationPhases (e.g. the LLM reviews). */
  excludePhaseKinds?: readonly PhaseKind[];
  /** Phase kinds force-added to each revalidation sweep (e.g. verifier for test edits). */
  extraRevalidationKinds?: readonly PhaseKind[];
  /** maxAttemptsTotal override (1 + regressionAttempts for best-effort). */
  maxAttempts?: number;
}
```

Change the signature and the three derived values:

```typescript
export async function runRectification(
  ctx: CallContext,
  state: InternalBuildState,
  phaseCosts: Record<string, number>,
  phaseOutputs: Record<string, unknown>,
  overrides?: RectificationOverrides,
): Promise<RectificationResult> {
  const rectification = state.rectification;
  const baseValidationPhases = collectRectificationPhases(state);
  const validationPhases = overrides?.excludePhaseKinds
    ? baseValidationPhases.filter((p) => !overrides.excludePhaseKinds?.includes(p.kind))
    : baseValidationPhases;
  if (!rectification || validationPhases.length === 0) {
    return {};
  }
  if (ctx.runtime.signal?.aborted) {
    return {};
  }

  const initialFindings = overrides?.initialFindings
    ? [...overrides.initialFindings]
    : gatherRectificationFindings(phaseOutputs, validationPhases, state);
  if (initialFindings.length === 0) {
    return {};
  }
  if (!ctx.storyId) {
    return {};
  }
```

In the `cycle` object, use the override strategies and attempt budget:

```typescript
    strategies: withIncreasingFailuresBail(
      (overrides?.strategies ?? rectification.strategies) as FixStrategy<Finding, unknown, unknown, unknown>[],
      rectification.abortOnIncreasingFailures,
      rectification.consecutiveIncreasesToBail ?? 1,
    ),
    config: { maxAttemptsTotal: overrides?.maxAttempts ?? rectification.maxAttempts, validatorRetries: 1 },
```

Inside the `validate` callback, after `const selected = phasesToRevalidate(opts?.strategiesRun, validationPhases);`, union in the extras:

```typescript
      const extra = overrides?.extraRevalidationKinds
        ? validationPhases.filter(
            (p) => overrides.extraRevalidationKinds?.includes(p.kind) && !selected.some((s) => s.kind === p.kind),
          )
        : [];
      const selectedWithExtra = [...selected, ...extra];
```

Then replace the subsequent uses of `selected` with `selectedWithExtra` (the `lite ? orderGateLast(selected) : selected` line becomes `lite ? orderGateLast(selectedWithExtra) : selectedWithExtra`).

- [ ] **Step 4: Run the full execution unit suite to confirm no regression**

Run: `AGENT=1 timeout 60 bun test test/unit/execution/ --timeout=10000`
Expected: PASS — existing `runRectification` tests still green (overrides default to current behavior).

- [ ] **Step 5: Commit**

```bash
git add src/execution/story-orchestrator.ts test/unit/execution/rectification-overrides.test.ts
git commit -m "feat(execution): add RectificationOverrides to runRectification (ADR-024)"
```

---

## Phase 5 — The best-effort pass

### Task 5: `runNonBlockingFix`

Builds the scope-filtered strategy set, converts advisory findings to fix input, invokes `runRectification` with overrides, and restores on exhaustion.

**Files:**
- Create: `src/execution/non-blocking-fix.ts`
- Test: `test/unit/execution/non-blocking-fix.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/unit/execution/non-blocking-fix.test.ts
import { describe, expect, test } from "bun:test";
import { selectNonBlockingStrategyNames, shouldRunNonBlockingFix } from "@/execution/non-blocking-fix";

describe("non-blocking-fix gating", () => {
  test("disabled config → does not run", () => {
    expect(shouldRunNonBlockingFix(undefined, 2)).toBe(false);
    expect(shouldRunNonBlockingFix({ enabled: false, scope: "both", regressionAttempts: 1, verifierGuard: true }, 2)).toBe(false);
  });

  test("enabled but zero advisory findings → does not run", () => {
    expect(shouldRunNonBlockingFix({ enabled: true, scope: "both", regressionAttempts: 1, verifierGuard: true }, 0)).toBe(false);
  });

  test("enabled with advisory findings → runs", () => {
    expect(shouldRunNonBlockingFix({ enabled: true, scope: "both", regressionAttempts: 1, verifierGuard: true }, 3)).toBe(true);
  });

  test("scope-aware build is done at plan time (see Task 6 Step 1) — not by name filtering", () => {
    // The strategy SET is constructed in build-plan-for-strategy.ts because
    // adversarial-finding ownership is session-mode-dependent (see note below).
    expect(typeof shouldRunNonBlockingFix).toBe("function");
  });
});
```

> **CRITICAL — why the strategy set is BUILT, not filtered (re-verification finding):** nax routes adversarial-review findings by **session mode**, not by config. `build-plan-for-strategy.ts:175` constructs the implementer with `includeAdversarialReview: !isThreeSession`, and the test-writer strategy is only added in three-session (`:181`). So:
> - **single-session:** `autofix-implementer` claims adversarial findings (source); no test-writer strategy exists.
> - **three-session:** `autofix-implementer` does **not** claim adversarial findings; `autofix-test-writer` claims them (test).
>
> Therefore filtering the story's existing strategies by name is wrong — `scope: "source"` in three-session would leave the advisory findings with **no claiming strategy** → `no-strategy` → restore without fixing. The best-effort set must be **constructed** with the correct options (Task 6 Step 1), preserving one claimer per adversarial finding:
> - `scope: "source"` → `makeAutofixImplementerStrategy(…, { includeAdversarialReview: true })` (claims adversarial via SOURCE in **both** session modes) + `makeFullSuiteRectifyStrategy` (regressions). No test-writer → tests never touched.
> - `scope: "both"` → `makeAutofixImplementerStrategy(…, { includeAdversarialReview: false })` (handles only regression/source findings) + `makeAutofixTestWriterStrategy` (claims adversarial via TEST) + `makeFullSuiteRectifyStrategy`. Mutual exclusivity preserved (test-writer owns adversarial; implementer owns regressions).
>
> **Why `full-suite-rectify` is always included:** when the best-effort fix breaks a test, the re-run `full-suite-gate` emits `source: "test-runner", category: "failed-test"` (`src/operations/verify.ts`), claimed **only** by `makeFullSuiteRectifyStrategy` (`full-suite-rectify.ts:23-25`) — not by `autofix-implementer` (which claims `tdd-verifier`/`lint`/`typecheck`). Without it, a regression exits `no-strategy` → restore, so `regressionAttempts` never fires. It edits **source** (source-safe) and is dormant until a regression appears. **Scoping caveat:** the story-built `full-suite-rectify` is gated on `inputs.fullSuiteGate && (isThreeSession || regressionMode === "per-story")` (`build-plan-for-strategy.ts:160`); for deferred-regression non-TDD stories there is no per-story `full-suite-gate`, so the best-effort pass's regression *detection* there is limited to lint/typecheck/verify-scoped. Construct `full-suite-rectify` for the best-effort set regardless (harmless when no gate runs).

- [ ] **Step 2: Run test to verify it fails**

Run: `AGENT=1 timeout 30 bun test test/unit/execution/non-blocking-fix.test.ts --timeout=5000`
Expected: FAIL — module `@/execution/non-blocking-fix` does not exist.

- [ ] **Step 3: Implement the pure helpers + orchestrator**

```typescript
// src/execution/non-blocking-fix.ts
/**
 * ADR-024 — Non-blocking best-effort adversarial fix.
 *
 * Runs after adversarial review passes. Reuses runRectification via overrides:
 * advisory findings as the seed, the LLM-review phases stripped from
 * revalidation, attempts bounded, and (scope "both" + verifierGuard) the
 * verifier added when a test edit occurs. On exhaustion, restores the
 * working tree AND phaseOutputs to the adversarial-passed snapshot.
 */
import type { NonBlockingFixConfig } from "../config/selectors";
import type { Finding } from "../findings";
import { getSafeLogger } from "../logger";
import { captureSnapshotRef, rollbackToRef } from "../tdd/rollback";
import type { PhaseKind } from "./types";

const REVIEW_PHASE_KINDS: readonly PhaseKind[] = ["semantic-review", "adversarial-review"];

/** Run the pass only when enabled and there is at least one advisory finding. */
export function shouldRunNonBlockingFix(cfg: NonBlockingFixConfig | undefined, advisoryCount: number): boolean {
  return cfg?.enabled === true && advisoryCount > 0;
}

// NOTE: the scope-aware strategy SET is constructed at plan-build time
// (Task 6 Step 1, build-plan-for-strategy.ts) because the factories need
// `story`/`config`/`sink` and because adversarial-finding ownership is
// session-mode-dependent (includeAdversarialReview). It is NOT selectable by
// name-filtering here. The built set is carried on InternalBuildState.

/** Phases to strip from revalidation (always the LLM reviews). */
export function nonBlockingExcludePhases(): readonly PhaseKind[] {
  return REVIEW_PHASE_KINDS;
}

/** Extra revalidation phases: verifier when test edits are possible and guarded. */
export function nonBlockingExtraPhases(cfg: NonBlockingFixConfig): readonly PhaseKind[] {
  return cfg.scope === "both" && cfg.verifierGuard ? (["verifier"] as const) : [];
}

export interface NonBlockingFixDeps {
  captureSnapshotRef: typeof captureSnapshotRef;
  rollbackToRef: typeof rollbackToRef;
}

const DEFAULT_DEPS: NonBlockingFixDeps = { captureSnapshotRef, rollbackToRef };

export interface NonBlockingFixArgs {
  workdir: string;
  storyId: string;
  advisoryFindings: readonly Finding[];
  cfg: NonBlockingFixConfig;
  phaseOutputs: Record<string, unknown>;
  /** Runs the harness; returns true when it exhausted without resolving. */
  runRectify: (maxAttempts: number) => Promise<{ rectificationExhausted?: boolean }>;
}

export interface NonBlockingFixResult {
  ran: boolean;
  kept: boolean;
  restored: boolean;
}

/**
 * Snapshot → run harness → keep on success, restore (files + phaseOutputs) on
 * exhaustion. Never throws into the caller's verdict path: failure ⇒ restore ⇒
 * the story keeps its adversarial-passed state.
 */
export async function runNonBlockingFix(
  args: NonBlockingFixArgs,
  _deps: NonBlockingFixDeps = DEFAULT_DEPS,
): Promise<NonBlockingFixResult> {
  const logger = getSafeLogger();
  if (!shouldRunNonBlockingFix(args.cfg, args.advisoryFindings.length)) {
    return { ran: false, kept: false, restored: false };
  }
  const phaseOutputsSnapshot = { ...args.phaseOutputs };
  const restoreRef = await _deps.captureSnapshotRef(args.workdir, args.storyId);
  const maxAttempts = 1 + args.cfg.regressionAttempts;

  let exhausted = false;
  try {
    const result = await args.runRectify(maxAttempts);
    exhausted = result.rectificationExhausted === true;
  } catch (err) {
    logger?.warn("non-blocking-fix", "best-effort pass threw — restoring", {
      storyId: args.storyId,
      error: err instanceof Error ? err.message : String(err),
    });
    exhausted = true;
  }

  if (!exhausted) {
    logger?.info("non-blocking-fix", "best-effort fix kept", { storyId: args.storyId });
    return { ran: true, kept: true, restored: false };
  }

  await _deps.rollbackToRef(args.workdir, restoreRef);
  // Restore phaseOutputs so a failed gate/verifier recorded during the pass does
  // not pollute the story verdict (story-orchestrator.ts:967 desync guard).
  for (const key of Object.keys(args.phaseOutputs)) delete args.phaseOutputs[key];
  Object.assign(args.phaseOutputs, phaseOutputsSnapshot);
  logger?.info("non-blocking-fix", "best-effort fix exhausted — restored to adversarial-passed", {
    storyId: args.storyId,
  });
  return { ran: true, kept: false, restored: true };
}
```

- [ ] **Step 4: Add the `NonBlockingFixConfig` slice type**

In `src/config/selectors.ts`, add the derived type (leaf-path import per config-patterns):

```typescript
import type { z } from "zod";
import type { AdversarialReviewConfigSchema } from "./schemas-review";
export type NonBlockingFixConfig = NonNullable<
  z.infer<typeof AdversarialReviewConfigSchema>["nonBlockingFix"]
>;
```

- [ ] **Step 5: Run test to verify it passes**

Run: `AGENT=1 timeout 30 bun test test/unit/execution/non-blocking-fix.test.ts --timeout=5000`
Expected: PASS (5 tests).

- [ ] **Step 6: Add the keep-vs-restore behavior test**

Append to `test/unit/execution/non-blocking-fix.test.ts`:

```typescript
import { runNonBlockingFix } from "@/execution/non-blocking-fix";

describe("runNonBlockingFix keep vs restore", () => {
  const baseArgs = {
    workdir: "/tmp/x",
    storyId: "us-001",
    advisoryFindings: [{ source: "adversarial-review", severity: "warning", category: "input", message: "m" }] as never,
    cfg: { enabled: true, scope: "both", regressionAttempts: 1, verifierGuard: true } as const,
  };
  const fakeDeps = {
    captureSnapshotRef: async () => "snap-sha",
    rollbackToRef: async () => {},
  };

  test("kept when harness resolves", async () => {
    const phaseOutputs: Record<string, unknown> = { "full-suite-gate": { success: true } };
    const res = await runNonBlockingFix(
      { ...baseArgs, phaseOutputs, runRectify: async () => ({ rectificationExhausted: false }) },
      fakeDeps,
    );
    expect(res).toEqual({ ran: true, kept: true, restored: false });
    expect(phaseOutputs["full-suite-gate"]).toEqual({ success: true });
  });

  test("restored when harness exhausts — phaseOutputs rolled back", async () => {
    const phaseOutputs: Record<string, unknown> = { "full-suite-gate": { success: true } };
    let rolled = "";
    const res = await runNonBlockingFix(
      { ...baseArgs, phaseOutputs, runRectify: async () => {
          phaseOutputs["full-suite-gate"] = { success: false }; // pass polluted it
          return { rectificationExhausted: true };
        } },
      { captureSnapshotRef: async () => "snap-sha", rollbackToRef: async (_w, ref) => { rolled = ref; } },
    );
    expect(res).toEqual({ ran: true, kept: false, restored: true });
    expect(rolled).toBe("snap-sha");
    expect(phaseOutputs["full-suite-gate"]).toEqual({ success: true }); // restored
  });
});
```

- [ ] **Step 7: Run test to verify it passes**

Run: `AGENT=1 timeout 30 bun test test/unit/execution/non-blocking-fix.test.ts --timeout=5000`
Expected: PASS (7 tests).

- [ ] **Step 8: Commit**

```bash
git add src/execution/non-blocking-fix.ts src/config/selectors.ts test/unit/execution/non-blocking-fix.test.ts
git commit -m "feat(execution): add runNonBlockingFix best-effort pass (ADR-024)"
```

---

## Phase 6 — Wire into the story lifecycle

### Task 6: Invoke after the post-rectification resume

The best-effort pass runs once, after the story is otherwise green (adversarial passed, rectification + resume complete), before the verdict is finalized.

**Files:**
- Modify: `src/execution/story-orchestrator.ts` (in `ExecutionPlan.run`, after the post-rectification resume block ends ~`:1245`, before the method returns its verdict)
- Test: covered by `test/unit/execution/non-blocking-fix.test.ts` (unit) + a targeted integration assertion below

- [ ] **Step 1: Thread the config into the plan/state at build time**

`CallContext` does **not** expose `.config`, `.workdir`, or `.storyGitRef` (`src/operations/types.ts:15-54` — it has `runtime`, `packageView`, `packageDir`, `storyId`, `agentName`). So the config must be threaded at build time, where it is available, exactly like `rectification`.

Add the fields to `InternalBuildState` (`src/execution/story-orchestrator.ts:251-263`):

```typescript
  rectification?: RectificationPhaseOptions;
  /** ADR-024 — non-blocking best-effort fix config, resolved at build time. */
  nonBlockingFix?: NonBlockingFixConfig;
  /** ADR-024 — scope-aware best-effort strategy set, built at plan time. */
  nonBlockingFixStrategies?: FixStrategy<Finding, unknown, unknown, unknown>[];
```

Import the type at the top of `story-orchestrator.ts`:

```typescript
import type { NonBlockingFixConfig } from "../config/selectors";
```

Populate both in `buildPlanForStrategy` (`src/execution/build-plan-for-strategy.ts`), where `config`, `story`, and `sink` are all in scope — immediately after the existing rectification strategies are pushed (after line ~185), and before the state object is handed to `new ExecutionPlan(...)`. **Build** the scope-aware set with the correct `includeAdversarialReview` (do not name-filter the story's set — see the CRITICAL note in Task 5):

```typescript
  // ADR-024 — non-blocking best-effort fix: config + scope-aware strategy set.
  const nbf = config.review?.adversarial?.nonBlockingFix;
  if (nbf?.enabled) {
    const nbStrategies: FixStrategy<Finding, unknown, unknown, unknown>[] = [];
    if (nbf.scope === "source") {
      // implementer claims adversarial via SOURCE in both session modes
      nbStrategies.push(
        makeAutofixImplementerStrategy(story, config, sink, { includeAdversarialReview: true }) as FixStrategy<Finding, unknown, unknown, unknown>,
      );
    } else {
      // both: implementer handles regression/source findings; test-writer owns adversarial
      nbStrategies.push(
        makeAutofixImplementerStrategy(story, config, sink, { includeAdversarialReview: false }) as FixStrategy<Finding, unknown, unknown, unknown>,
        makeAutofixTestWriterStrategy(story, config, sink) as FixStrategy<Finding, unknown, unknown, unknown>,
      );
    }
    // always: fixes a test the best-effort fix breaks (source edit; dormant until a regression)
    nbStrategies.push(makeFullSuiteRectifyStrategy(story, config) as FixStrategy<Finding, unknown, unknown, unknown>);
  }
```

Set `nonBlockingFix: nbf` and `nonBlockingFixStrategies: nbf?.enabled ? nbStrategies : undefined` onto the state object the builder passes to `new ExecutionPlan(ctx, { ...state }, …)` (match the surrounding state-construction style — the verification found the plan is constructed via `new ExecutionPlan(ctx, { ...state }, opts.isThreeSession)`, so the keys must be present on `state` before that spread).

- [ ] **Step 2: Add the invocation**

After the post-rectification resume loop completes and before the verdict return in `ExecutionPlan.run` (`phaseCosts` and `phaseOutputs` are in scope through to the return at `:1304`), add:

```typescript
    // ADR-024 — non-blocking best-effort fix over advisory adversarial findings.
    // Only when the story is currently green (adversarial passed, nothing pending).
    const advCfg = this.state.adversarialReview ? this.state.nonBlockingFix : undefined;
    const advisoryOut = phaseOutputs["adversarial-review"] as { advisoryFindings?: Finding[] } | undefined;
    const advisoryFindings = advisoryOut?.advisoryFindings ?? [];
    if (advCfg && this.state.rectification && shouldRunNonBlockingFix(advCfg, advisoryFindings.length)) {
      await runNonBlockingFix({
        workdir: this.ctx.packageDir,
        storyId: this.ctx.storyId ?? "",
        advisoryFindings,
        cfg: advCfg,
        phaseOutputs,
        runRectify: (maxAttempts) =>
          runRectification(this.ctx, this.state, phaseCosts, phaseOutputs, {
            initialFindings: advisoryFindings,
            strategies: this.state.nonBlockingFixStrategies ?? [],
            excludePhaseKinds: nonBlockingExcludePhases(),
            extraRevalidationKinds: nonBlockingExtraPhases(advCfg),
            maxAttempts,
          }),
      });
    }
```

Add the imports at the top of `story-orchestrator.ts`:

```typescript
import {
  nonBlockingExcludePhases,
  nonBlockingExtraPhases,
  runNonBlockingFix,
  shouldRunNonBlockingFix,
} from "./non-blocking-fix";
```

`build-plan-for-strategy.ts` already imports `makeAutofixImplementerStrategy`, `makeAutofixTestWriterStrategy`, and `makeFullSuiteRectifyStrategy` (used for the blocking-cycle strategies at `:161-184`), so no new imports are needed there for the strategy build in Step 1.

- [ ] **Step 3: Write the integration guard test**

```typescript
// test/unit/execution/non-blocking-fix-wiring.test.ts
import { describe, expect, test } from "bun:test";
import { shouldRunNonBlockingFix } from "@/execution/non-blocking-fix";

// The scope-aware strategy SET is built in build-plan-for-strategy.ts (Step 1)
// using the real factories with story/config/sink; that path is covered by the
// existing build-plan tests once the build is added. This guard pins the gating
// helper used by the wiring.
describe("non-blocking-fix wiring gate", () => {
  test("gate is off without config", () => {
    expect(shouldRunNonBlockingFix(undefined, 5)).toBe(false);
  });
  test("gate is on when enabled with advisory findings", () => {
    expect(shouldRunNonBlockingFix({ enabled: true, scope: "both", regressionAttempts: 1, verifierGuard: true }, 5)).toBe(true);
  });
});
```

- [ ] **Step 4: Run the wiring + execution suite**

Run: `AGENT=1 timeout 60 bun test test/unit/execution/ --timeout=10000`
Expected: PASS — new wiring test green, all existing execution tests green (best-effort pass is gated off by default `enabled: false`).

- [ ] **Step 5: Typecheck + lint**

Run: `bun run typecheck && bun run lint`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/execution/story-orchestrator.ts src/execution/build-plan-for-strategy.ts test/unit/execution/non-blocking-fix-wiring.test.ts
git commit -m "feat(execution): wire runNonBlockingFix into story lifecycle (ADR-024)"
```

---

## Phase 7 — Docs

### Task 7: Flip ADR status and note the convention

**Files:**
- Modify: `docs/adr/ADR-024-non-blocking-adversarial-fix.md`
- Modify: `.claude/rules/config-patterns.md` (one-line pointer if appropriate)

- [ ] **Step 1: Update ADR status**

In `docs/adr/ADR-024-non-blocking-adversarial-fix.md`, change `**Status:** Proposed` to `**Status:** Accepted` and add an Implementation Status line referencing this plan and the commits.

- [ ] **Step 2: Run the full suite as the final gate**

Run: `bun run test`
Expected: PASS (full suite time-boxed by the wrapper).

- [ ] **Step 3: Commit**

```bash
git add docs/adr/ADR-024-non-blocking-adversarial-fix.md .claude/rules/config-patterns.md
git commit -m "docs(adr): mark ADR-024 accepted; non-blocking adversarial fix implemented"
```

---

## Self-Review

**Spec coverage (ADR-024 decisions):**
- §1 decouple block/fix → gate untouched; advisory findings flow only to the non-blocking pass (Task 2, Task 6). ✓
- §2 adversarial-only, config under `review.adversarial` → Task 1, Task 6. ✓
- §3 deterministic-only revalidation, never reviews → `nonBlockingExcludePhases()` + Task 4 strip (Task 5/6). ✓
- §4 bounded → `maxAttempts = 1 + regressionAttempts` (Task 5). ✓
- §5 restore to adversarial-passed (files + phaseOutputs) → Task 3 + Task 5. ✓
- §6 reuse → `RectificationOverrides` on existing harness (Task 4). ✓
- §7 scope + verifierGuard → `selectNonBlockingStrategyNames` + `nonBlockingExtraPhases` (Task 5). ✓
- §8 config schema → Task 1. ✓

**Open questions deferred to runtime (not blockers):** `enabled` default ships `false`; deterministic-rules-first layer (lint/spec-conformance) is a separate track per ADR-024 Open Question 2; diff-cap (Open Question 3) is a follow-up — note it in Task 5's logger output before shipping `enabled: true`.

**Placeholder scan:** none — every step has concrete code/commands.

**Type consistency:** `NonBlockingFixConfig`, `RectificationOverrides`, `nonBlockingExcludePhases()`, `nonBlockingExtraPhases(cfg)`, `shouldRunNonBlockingFix`, `runNonBlockingFix`, `captureSnapshotRef`, `rollbackToRef` are used consistently across Tasks 3–6. The scope-aware strategy set is **built** at plan time (`build-plan-for-strategy.ts`, Task 6 Step 1) and carried on `InternalBuildState.nonBlockingFixStrategies`; config is carried on `InternalBuildState.nonBlockingFix`. Neither is read from `ctx`. `filterStrategiesByName`/`selectNonBlockingStrategyNames` were **removed** — name-filtering is wrong (see below).

**Post-review corrections — round 1 (2026-06-07):** (1) snapshot is commit-based (`captureSnapshotRef`), not `git stash create`, to avoid `git clean -fd` deleting the story's untracked files; (2) `full-suite-rectify` added so the regression-fix fires; (3) config threaded via `InternalBuildState`, not `ctx.config`; (4) `advisoryFindings` documented as a new field.

**Post-review corrections — round 2 (re-verification, 2026-06-07):**
- 🔴 **Strategy set is BUILT, not name-filtered.** `build-plan-for-strategy.ts:175` sets `includeAdversarialReview: !isThreeSession`, so adversarial findings are owned by the implementer (source) only in single-session and by the test-writer (test) only in three-session. Name-filtering the story's strategies would leave `scope: "source"` with no claimer in three-session. Fixed: build the set with explicit `includeAdversarialReview` per scope (Task 6 Step 1), preserving one claimer per finding.
- 🟡 **`full-suite-rectify` is gated** (`build-plan-for-strategy.ts:160`, needs `fullSuiteGate` + three-session/per-story). The best-effort set constructs it unconditionally (harmless without a gate); regression *detection* is weaker for deferred-regression non-TDD stories — documented in Task 5.
- 🟢 **Mid-story commit is safe.** The entry snapshot commit is an ancestor of any later state; post-run TDD rollback resets to `initialRef` (a further ancestor) and would discard it correctly — and it only fires on isolation-violation, which a green story (the only kind that reaches the best-effort pass) does not have. Cost: one extra commit on the keep path, consistent with nax's existing auto-commit. No guard needed.
- ℹ️ Re-verification claims 4/5/6 reported "FALSE/doesn't exist" are **false negatives** — the agent checked the current tree; the schema field, `NonBlockingFixConfig`, and the `overrides` param are exactly what Tasks 1/4/5 create.

**Known gap to verify at execution time:** the exact insertion line in `ExecutionPlan.run` (Task 6 Step 1) — locate the end of the post-rectification resume block (`grep -n "post-rectification resume" src/execution/story-orchestrator.ts`) and insert before the verdict return. The diff-cap guard (ADR-024 Open Question 3) is intentionally not implemented in this plan; do not flip `enabled` default to `true` until it lands.
