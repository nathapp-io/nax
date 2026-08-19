# Native `nax finish` — Wiring and Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `src/finish/` the implementation that actually runs — wire it into the post-run phase sequence, migrate its config off the flow-shaped block, and delete `flows/nax-finish/` and the nax-finish plugin.

**Architecture:** `src/finish/` is complete and 100% dead code today: every consumer of the `@/finish` barrel is a test file. This plan adds the one missing module (`src/finish/phase.ts`, exporting `runFinishPhase`), calls it from `src/execution/runner-completion.ts` before `runtime.close()`, moves the two things the plugin owned that the native module lacks (Telegram delivery and config reading), then removes the subprocess path entirely. Nothing in `src/finish/machine.ts`, `route.ts`, `gates/`, `pr/` or `operations/` changes.

**Tech Stack:** Bun (runtime and test runner), TypeScript, Zod (config schemas), Biome (lint/format).

**Spec:** `docs/superpowers/specs/2026-08-18-native-nax-finish-design.md` — sections 4.1 (placement and lifecycle), 4.6 (config), 4.7 (budgets), 4.8 (cost), 6 (cutover steps 3 and 4).

## Plan numbering — read this first

The arc was scoped as four plans in `docs/superpowers/plans/2026-08-18-forge-shared-module.md:897` ("This is **plan 1 of 4**"), where wiring was plan 4. Plan 3's author split the PR/forge half out into its own plan, so wiring slid to plan 5. **This is that plan.** Plan 4's document (`2026-08-19-finish-pr-escalate.md`) refers to it as "plan 5" throughout, including at `:1324`; plan 2's document (`2026-08-18-finish-core.md:74, :629`) refers to the same work as "plan 4". Both mean this file.

Merged predecessors: #1626 (forge), #1627 (finish core), #1628 (review ops), #1629 (PR/escalate).

## Global Constraints

- **`SRC_LIMIT` is 600 lines, `TEST_LIMIT` is 800.** Enforced by `bun run check:file-sizes` with a baseline of 10 grandfathered files. Run `wc -l` on every file you touch before adding to it. Do not add to the baseline.
- **No emoji, no astral-plane characters** anywhere in `src/`, `flows/` or `.nax/rules/`. `bun run check:no-control-bytes` enforces the control-byte half.
- **`src/` must never import from `flows/`.** The `@flows/*` tsconfig alias exists for tests only. Task 8 deletes both.
- **Deep relative imports are baselined at 2844** (`bun run check:deep-relatives`). Cross-module imports use the `@/` aliases and stop at the module barrel — `scripts/check-alias-internals.ts` rejects `@/finish/machine`, so import from `@/finish`.
- **Every new `NaxError` needs a code.** `bun run check:nax-error` has a baseline of 110 violations, currently at 104; do not raise it.
- **`src/finish/review/prompts.gen.ts` is generated.** Edit `src/finish/review/references/*.md` and run `bun run gen:review-prompts`. `bun run check:review-prompts` fails on drift. No task here touches it.
- **Quality gate for every task:** `bun run typecheck && bun run lint && bun test test/unit/<area>`. Full `bun run test` before the final commit of each task.
- **Commit style:** conventional commits (`feat:`, `fix:`, `test:`, `refactor:`, `chore:`), no attribution trailer.

---

## File Structure

**Created:**

| File | Responsibility |
| --- | --- |
| `src/finish/notify.ts` | Telegram message composition and delivery, lifted from the plugin. The only network call finish makes outside the forge. |
| `src/finish/config.ts` | Reads the flattened `finish.*` config slice into the `FinishOpsDeps` / phase-level shapes. One place that knows config key names. |
| `src/finish/phase.ts` | `runFinishPhase(ctx)` — the entry point. Gating, context load, forge detection, ops assembly, machine drive, cost delta, event emission, notification. |
| `test/unit/finish/notify.test.ts` | Message bounding and delivery. |
| `test/unit/finish/config.test.ts` | Config reading, including the compat shim's output shape. |
| `test/unit/finish/phase.test.ts` | Gating, event emission, cost delta, fail-open. |
| `test/integration/finish/pr-diffstat.test.ts` | Ported from `test/integration/flows/pr-diffstat.test.ts` — the real-git pathspec test. |

**Modified:**

| File | Change |
| --- | --- |
| `src/pipeline/event-bus.ts:174` | `PostRunPhase` gains `"finish"`. |
| `src/execution/status-file.ts:54-57` | `PostRunStatus` gains `finish`; new `FinishPhaseStatus` interface. |
| `src/execution/status-writer.ts:117-140` | `setPostRunPhase` overload and body gain `"finish"`. |
| `src/tui/hooks/usePipelineBusEvents.ts:67-72` | `postRunPhases` gains `finish`. |
| `src/config/schemas.ts:402-520` | `finish.autoFlow.*` flattened to `finish.*`. |
| `src/config/runtime-types-finish.ts` | Interfaces follow the schema. |
| `src/config/compat-shims.ts` | New `_applyFinishAutoFlowShim`, added to the chain. |
| `src/operations/types.ts:15` | `CallContext` gains `readonly signal?: AbortSignal`. |
| `src/operations/call.ts` | Prefers `ctx.signal` over `ctx.runtime.signal` at 8 sites. |
| `src/finish/index.ts` | Barrel exports the three new modules. |
| `src/execution/runner-completion.ts` | Calls `runFinishPhase` before `runtime.close()`. |
| `src/plugins/index.ts`, `src/plugins/loader.ts` | Drop `naxFinishPlugin`. |
| `package.json` | Drop `"flows/"` from `files`, drop `check:flows-no-bun` from `lint`. |
| `tsconfig.json` | Drop the `@flows/*` alias and `flows/**/*.ts` from `include`. |

**Deleted (Task 8 only):** `flows/` (28 files), `src/plugins/builtin/nax-finish/` (4 files), `scripts/check-flows-no-bun.ts`, `test/unit/flows/` (28 files), `test/unit/plugins/builtin/nax-finish/` (5 files), `test/integration/flows/` (1 file, ported first in Task 7), `docs/guides/nax-finish-autoflow.md`.

---

## A correction to carry into Task 4

An earlier reading of design §4.7 concluded that finish's LLM ops were entirely un-abortable. That is wrong and the plan must not be written against it. `src/operations/call.ts` consults `ctx.runtime.signal` at `:120`, `:139`, `:331`, `:350`, `:415` and threads it into the run hop at `:404`. Finish therefore already inherits the **run's** abort signal for free.

What genuinely does not exist is a way for a *caller* to supply a narrower deadline: `callOp(ctx, op, input)` takes no signal parameter and `CallContext` has no signal field, so `finish.timeouts.flowMs` cannot reach an in-flight op. Task 4 adds exactly that and nothing more.

Design §4.7's phrase "threaded into `callOp` (which already accepts one)" is inaccurate as written. Task 4 Step 7 corrects the design doc.

---

## Task 1: `"finish"` becomes a post-run phase

**Files:**
- Modify: `src/pipeline/event-bus.ts:174`
- Modify: `src/execution/status-file.ts:38-57`
- Modify: `src/execution/status-writer.ts:113-140`
- Modify: `src/tui/hooks/usePipelineBusEvents.ts:66-72`
- Test: `test/unit/execution/status-writer.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `PostRunPhase` including `"finish"`; `FinishPhaseStatus { status: PostRunPhaseStatus; lastRunAt?: string; result?: "opened" | "promoted" | "already-ready" | "escalated" | "nothing-to-finish"; url?: string; escalationReason?: string }`; `statusWriter.setPostRunPhase("finish", update)`.

This is a pure type-widening task with no behaviour. It ships first so Task 5 has somewhere to write.

- [ ] **Step 1: Write the failing test**

Append to `test/unit/execution/status-writer.test.ts`:

```ts
test("setPostRunPhase('finish') merges into postRun and survives crash recovery", () => {
  const writer = new StatusWriter(/* same construction as the sibling tests in this file */);
  writer.setPostRunPhase("finish", { status: "running" });
  expect(writer.getPostRunStatus().finish).toEqual({ status: "not-run" });

  writer.setPostRunPhase("finish", {
    status: "passed",
    lastRunAt: "2026-08-19T00:00:00.000Z",
    result: "opened",
    url: "https://github.com/o/r/pull/1",
  });
  expect(writer.getPostRunStatus().finish).toEqual({
    status: "passed",
    lastRunAt: "2026-08-19T00:00:00.000Z",
    result: "opened",
    url: "https://github.com/o/r/pull/1",
  });
});
```

The first assertion pins crash recovery: `getPostRunStatus()` already rewrites a `"running"` phase to `"not-run"`, and the finish phase must be covered by that same rewrite rather than reporting a phase that died mid-run as still running.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/execution/status-writer.test.ts -t "finish"`
Expected: FAIL — TypeScript rejects `"finish"` as the first argument to `setPostRunPhase`, and `getPostRunStatus().finish` is not a property.

- [ ] **Step 3: Widen `PostRunPhase`**

`src/pipeline/event-bus.ts:174`:

```ts
export type PostRunPhase = "regression" | "acceptance" | "review" | "acceptance-setup" | "finish";
```

- [ ] **Step 4: Add the status shape**

`src/execution/status-file.ts`, after `RegressionPhaseStatus`:

```ts
/** Status of the native finish phase during post-run */
export interface FinishPhaseStatus {
  status: PostRunPhaseStatus;
  /** ISO 8601 timestamp of the last finish run */
  lastRunAt?: string;
  /** Terminal status the finish machine reached */
  result?: "opened" | "promoted" | "already-ready" | "escalated" | "nothing-to-finish";
  /** PR/MR the phase opened, promoted or commented on */
  url?: string;
  /** Why finish stopped, when `result` is "escalated" */
  escalationReason?: string;
}

/** Aggregate post-run phase statuses */
export interface PostRunStatus {
  acceptance: AcceptancePhaseStatus;
  regression: RegressionPhaseStatus;
  /**
   * Optional because a status file written before the native finish phase
   * existed has no such key, and `buildStatusSnapshot` copies `postRun`
   * through verbatim. A required field would make every pre-existing
   * status.json fail to type-check on read.
   */
  finish?: FinishPhaseStatus;
}
```

- [ ] **Step 5: Widen the writer**

`src/execution/status-writer.ts` — add the overload and the branch. Keep the existing `if/else` shape rather than a lookup table; the three branches have different `Partial<>` types and a table erases them:

```ts
  setPostRunPhase(phase: "acceptance", update: Partial<AcceptancePhaseStatus>): void;
  setPostRunPhase(phase: "regression", update: Partial<RegressionPhaseStatus>): void;
  setPostRunPhase(phase: "finish", update: Partial<FinishPhaseStatus>): void;
  setPostRunPhase(
    phase: "acceptance" | "regression" | "finish",
    update: Partial<AcceptancePhaseStatus> | Partial<RegressionPhaseStatus> | Partial<FinishPhaseStatus>,
  ): void {
    if (!this._postRun) {
      this._postRun = {
        acceptance: { status: "not-run" },
        regression: { status: "not-run" },
      };
    }
    if (phase === "acceptance") {
      this._postRun = {
        ...this._postRun,
        acceptance: { ...this._postRun.acceptance, ...(update as Partial<AcceptancePhaseStatus>) },
      };
    } else if (phase === "regression") {
      this._postRun = {
        ...this._postRun,
        regression: { ...this._postRun.regression, ...(update as Partial<RegressionPhaseStatus>) },
      };
    } else {
      this._postRun = {
        ...this._postRun,
        finish: { ...(this._postRun.finish ?? { status: "not-run" }), ...(update as Partial<FinishPhaseStatus>) },
      };
    }
  }
```

Import `FinishPhaseStatus` from `./status-file` alongside the two existing phase-status types.

- [ ] **Step 6: Extend crash recovery to the new phase**

In `getPostRunStatus()`, the existing body rewrites `"running"` to `"not-run"` for acceptance and regression. Add the same for `finish`, and only when the key is present — an absent `finish` must stay absent rather than materialise as `{ status: "not-run" }` in every status file:

```ts
    return {
      acceptance: base.acceptance.status === "running" ? { ...base.acceptance, status: "not-run" } : base.acceptance,
      regression: base.regression.status === "running" ? { ...base.regression, status: "not-run" } : base.regression,
      ...(base.finish
        ? { finish: base.finish.status === "running" ? { ...base.finish, status: "not-run" } : base.finish }
        : {}),
    };
```

Match the surrounding code's existing expression shape if it differs; the requirement is the `"running"` → `"not-run"` rewrite and the absent-key preservation, not this exact literal.

- [ ] **Step 7: Widen the TUI phase map**

`src/tui/hooks/usePipelineBusEvents.ts:66-72`:

```ts
  /** Post-run phase statuses (acceptance, acceptance-setup, regression, review, finish) */
  postRunPhases: {
    acceptance?: PostRunPhaseState;
    "acceptance-setup"?: PostRunPhaseState;
    regression?: PostRunPhaseState;
    review?: PostRunPhaseState;
    finish?: PostRunPhaseState;
  };
```

No handler change is needed: both `postrun:phase:started` and `postrun:phase:completed` already index by `event.phase` generically (`:243`, `:252`). Do not add a switch.

- [ ] **Step 8: Run the tests**

Run: `bun test test/unit/execution/ test/unit/tui/ test/unit/pipeline/`
Expected: PASS.

- [ ] **Step 9: Typecheck and lint**

Run: `bun run typecheck && bun run lint`
Expected: clean. If `tsc` names a site that switches exhaustively on `PostRunPhase`, fix it — design §4.1 warns the union is not the only site, and an exhaustive switch is exactly the kind it means.

- [ ] **Step 10: Commit**

```bash
git add src/pipeline/event-bus.ts src/execution/status-file.ts src/execution/status-writer.ts src/tui/hooks/usePipelineBusEvents.ts test/unit/execution/status-writer.test.ts
git commit -m "feat(execution): add finish as a post-run phase"
```

---

## Task 2: Flatten `finish.autoFlow.*` to `finish.*`

**Files:**
- Modify: `src/config/schemas.ts:402-520`
- Modify: `src/config/runtime-types-finish.ts`
- Modify: `src/config/compat-shims.ts`
- Test: `test/unit/config/compat-shims.test.ts`, `test/unit/config/schemas.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: the `finish` schema block below, and `_applyFinishAutoFlowShim(conf, warn)`.

Design §4.6's table drives this. `flowPath` and `defaultAgent` are removed outright; `model` is removed because its "floor not override" semantics were a property of the acpx fork (§2.4); `reviewers.*` reshape from acpx profile-name strings to `ConfiguredModel`.

- [ ] **Step 1: Write the failing shim test**

Append to `test/unit/config/compat-shims.test.ts`:

```ts
describe("_applyFinishAutoFlowShim", () => {
  test("lifts finish.autoFlow.* onto finish.* and drops the removed keys", () => {
    const warnings: string[] = [];
    const out = _applyFinishAutoFlowShim(
      {
        finish: {
          autoFlow: {
            enabled: true,
            flowPath: "flows/nax-finish/nax-finish.flow.ts",
            defaultAgent: "claude",
            model: "sonnet",
            narrative: false,
            timeouts: { acceptanceMs: 1, gateMs: 2, flowMs: 3, stepMs: 4 },
          },
        },
      },
      (m) => warnings.push(m),
    );
    expect(out.finish).toEqual({
      enabled: true,
      narrative: false,
      timeouts: { acceptanceMs: 1, gateMs: 2, flowMs: 3, stepMs: 4 },
    });
    expect(warnings.join(" ")).toContain("finish.autoFlow");
  });

  test("maps a reviewer profile string to null and warns, rather than failing validation", () => {
    const warnings: string[] = [];
    const out = _applyFinishAutoFlowShim(
      { finish: { autoFlow: { enabled: true, reviewers: { spec: "nax-finish-spec", quality: null, narrative: null } } } },
      (m) => warnings.push(m),
    );
    expect((out.finish as { reviewers: Record<string, unknown> }).reviewers).toEqual({
      spec: null,
      quality: null,
      narrative: null,
    });
    expect(warnings.join(" ")).toContain("reviewers.spec");
  });

  test("an explicit finish.* alongside finish.autoFlow wins", () => {
    const out = _applyFinishAutoFlowShim(
      { finish: { enabled: false, autoFlow: { enabled: true } } },
      () => {},
    );
    expect((out.finish as { enabled: boolean }).enabled).toBe(false);
  });

  test("a config with no finish block is returned unchanged, same reference", () => {
    const conf = { review: {} };
    expect(_applyFinishAutoFlowShim(conf, () => {})).toBe(conf);
  });
});
```

The third case matters because a user mid-migration will have both. The fourth pins the immutability contract every sibling shim holds — returning a fresh object on every load would defeat the identity checks the loader makes.

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/unit/config/compat-shims.test.ts -t "_applyFinishAutoFlowShim"`
Expected: FAIL — `_applyFinishAutoFlowShim` is not exported.

- [ ] **Step 3: Write the shim**

Add to `src/config/compat-shims.ts`, modelled on `_applyRemovedWorktreeInheritShim` (`:137`), which is the repo's template for a removed key:

```ts
/** @internal Keys that existed only to marshal across the acpx process boundary. */
const REMOVED_FINISH_KEYS = ["flowPath", "defaultAgent", "model"] as const;

/**
 * @internal Lift `finish.autoFlow.*` onto `finish.*`.
 *
 * The `autoFlow` segment was named after a flow that no longer exists — finish
 * is an in-process post-run phase, not a subprocess. `flowPath`, `defaultAgent`
 * and `model` go with it: the first pointed at a deleted file, and the other two
 * were acpx argv that has no in-process equivalent (`model`'s "floor, not
 * override" behaviour was a property of the personal acpx fork, design 2.4).
 *
 * `reviewers.{spec,quality,narrative}` were acpx profile names; the schema now
 * takes a `ConfiguredModel`. A leftover string is mapped to null with a warning
 * rather than rejected, so an unmigrated config keeps loading and simply falls
 * back to the default model selection.
 *
 * An explicit `finish.<key>` alongside `finish.autoFlow.<key>` wins — the user
 * migrated that key and the stale one must not clobber it.
 *
 * Returns a new object (immutable -- does not mutate the input).
 */
export function _applyFinishAutoFlowShim(
  conf: Record<string, unknown>,
  warn: (msg: string) => void = defaultConfigWarn,
): Record<string, unknown> {
  const finish = conf.finish as Record<string, unknown> | undefined;
  const autoFlow = finish?.autoFlow as Record<string, unknown> | undefined;
  if (!autoFlow) return conf;

  warn(
    "finish.autoFlow.* has moved to finish.* — nax-finish is an in-process post-run phase, not an acpx flow. " +
      "Move your keys up one level; finish.autoFlow will stop being read in a future release.",
  );

  const { autoFlow: _dropped, ...explicitFinish } = finish ?? {};
  const lifted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(autoFlow)) {
    if ((REMOVED_FINISH_KEYS as readonly string[]).includes(key)) {
      warn(`finish.autoFlow.${key} was removed with the acpx flow and has no effect. Remove it from your config.`);
      continue;
    }
    if (key === "reviewers" && value && typeof value === "object") {
      const reviewers: Record<string, unknown> = {};
      for (const [slot, profile] of Object.entries(value as Record<string, unknown>)) {
        if (typeof profile === "string" && profile.length > 0) {
          warn(
            `finish.autoFlow.reviewers.${slot} was an acpx profile name ("${profile}"). ` +
              'finish.reviewers.' +
              slot +
              ' now takes a model tier or { agent, model } object; the profile name is ignored. ' +
              "Set it explicitly to keep pinning that reviewer.",
          );
          reviewers[slot] = null;
          continue;
        }
        reviewers[slot] = profile ?? null;
      }
      lifted.reviewers = reviewers;
      continue;
    }
    lifted[key] = value;
  }

  // Explicit finish.* wins over anything lifted from autoFlow.
  return { ...conf, finish: { ...lifted, ...explicitFinish } };
}
```

- [ ] **Step 4: Add it to the chain**

`applyConfigCompatShims` at `src/config/compat-shims.ts:382`. Wrap the outermost call so the finish shim runs last; order does not matter here because no other shim touches `finish`, but keeping new shims outermost is the file's established pattern:

```ts
  return _applyFinishAutoFlowShim(
    _applyRemovedWorktreeInheritShim(
      // ... existing chain unchanged
    ),
    warn,
  );
```

- [ ] **Step 5: Run the shim test**

Run: `bun test test/unit/config/compat-shims.test.ts -t "_applyFinishAutoFlowShim"`
Expected: PASS.

- [ ] **Step 6: Reshape the schema**

Replace the whole `finish:` block in `src/config/schemas.ts` (currently `:402-520`) with the flattened form. Every field keeps its current default and its current doc comment where the comment is still true; the comments about acpx argv go.

```ts
    finish: z
      .object({
        enabled: z.boolean().default(false),
        /**
         * Whether the phase spends an agent turn writing the PR body's
         * "What changed" section. Disabled -> the body carries the
         * mechanical fallback (spec Summary) or no such section at all.
         */
        narrative: z.boolean().default(true),
        /**
         * How the repo's own PR/MR template is honoured.
         *
         * `merge` (default) treats the template as shape: headings the body
         * can fill keep their wording, headings it cannot are dropped, and
         * content with no matching heading is appended under nax's own.
         * `strict` keeps the unfillable headings, empty, for repos whose CI
         * asserts a set of headings exists. `ignore` skips the template.
         *
         * Never appends the template verbatim -- that shipped an unfilled
         * form below a filled one (#1504).
         */
        prBody: z
          .object({
            template: z.enum(["merge", "strict", "ignore"]).default("merge"),
            /**
             * Template heading -> body-section key, layered over the defaults
             * in `src/forge/template-merge.ts`. Matched case- and
             * punctuation-insensitively; an empty value suppresses a default
             * alias. Known keys: `narrative`, `stories`, `verification`,
             * `rounds`, `outOfScope`.
             */
            sectionMap: z.record(z.string(), z.string()).default({}),
          })
          .default({ template: "merge", sectionMap: {} }),
        /**
         * Per-step model selection, resolved by `resolveConfiguredModel` the
         * same way every other operation's is. null falls through to
         * `callOp`'s own default ("balanced").
         */
        reviewers: z
          .object({
            spec: ConfiguredModelSchema.nullable().default(null),
            quality: ConfiguredModelSchema.nullable().default(null),
            narrative: ConfiguredModelSchema.nullable().default(null),
            fix: ConfiguredModelSchema.nullable().default(null),
          })
          .default({ spec: null, quality: null, narrative: null, fix: null }),
        escalate: z.object({ telegram: z.boolean().default(true) }).default({ telegram: true }),
        notify: z
          .object({ mode: z.enum(["escalation", "always", "off"]).default("escalation") })
          .default({ mode: "escalation" }),
        // Wall-clock caps. Every one bounds work the phase awaits; without
        // them a hung gate stalls the run's completion phase, which has no
        // timeout of its own.
        timeouts: z
          .object({
            /** Per acceptance-test group. */
            acceptanceMs: z.number().int().positive().default(600_000),
            /** Per quality gate (build / typecheck / lint / test). */
            gateMs: z.number().int().positive().default(900_000),
            /** Whole-phase deadline, enforced as an AbortSignal (design 4.7). */
            flowMs: z.number().int().positive().default(5_400_000),
            /** Per LLM op (one review, fix or narrative turn). null keeps callOp's own default. */
            stepMs: z.number().int().positive().nullable().default(null),
          })
          .default({ acceptanceMs: 600_000, gateMs: 900_000, flowMs: 5_400_000, stepMs: null }),
      })
      .default({
        enabled: false,
        narrative: true,
        prBody: { template: "merge", sectionMap: {} },
        reviewers: { spec: null, quality: null, narrative: null, fix: null },
        escalate: { telegram: true },
        notify: { mode: "escalation" },
        timeouts: { acceptanceMs: 600_000, gateMs: 900_000, flowMs: 5_400_000, stepMs: null },
      }),
```

`reviewers.fix` is new — plan 4's `FinishOpsDeps.models` already has a `fix` slot (`src/finish/ops-impl.ts`, `models?: { reviewSpec, reviewQuality, fix, narrative }`) with nothing to fill it. `ConfiguredModelSchema` is the existing schema for `ModelTier | { agent, model }`; if `src/config/` does not already export one under that name, locate the schema `models` uses and reuse it rather than declaring a second.

- [ ] **Step 7: Follow the runtime types**

`src/config/runtime-types-finish.ts` — replace `FinishAutoFlowConfig` and `FinishConfig`:

```ts
/** Wall-clock budgets for the native finish phase (ms) */
export interface FinishTimeoutsConfig {
  acceptanceMs: number;
  gateMs: number;
  flowMs: number;
  /** Per LLM op; null keeps callOp's own default */
  stepMs: number | null;
}

/** `finish` config block — the in-process post-run finish phase (opt-in, off by default) */
export interface FinishConfig {
  enabled: boolean;
  /** Whether the phase writes the PR body's "What changed" narrative */
  narrative: boolean;
  prBody: { template: "merge" | "strict" | "ignore"; sectionMap: Record<string, string> };
  /** Per-step model selection; null falls through to callOp's default */
  reviewers: {
    spec: ConfiguredModel | null;
    quality: ConfiguredModel | null;
    narrative: ConfiguredModel | null;
    fix: ConfiguredModel | null;
  };
  escalate: { telegram: boolean };
  notify: { mode: "escalation" | "always" | "off" };
  timeouts: FinishTimeoutsConfig;
}
```

**Name collision warning:** `src/config/selectors.ts:169` also exports a `FinishConfig` (the selected slice, `ReturnType<typeof finishConfigSelector.select>`). Both already coexist; do not rename either, and import the one you mean explicitly. Task 3's and Task 5's modules want the selector's.

- [ ] **Step 8: Run the config suite**

Run: `bun test test/unit/config/`
Expected: PASS. Tests asserting the old `finish.autoFlow` defaults will fail — update them to the flattened shape. A test that asserts `flowPath` defaults to the flow file should be deleted, not rewritten.

- [ ] **Step 9: Typecheck**

Run: `bun run typecheck`
Expected: errors in `src/plugins/builtin/nax-finish/config.ts`, which reads `finish.autoFlow`. **Do not fix them by reshaping the plugin** — it is deleted in Task 8. Instead pin its reader to the compat shape locally so it keeps compiling until then:

```ts
function selectFinish(config: unknown): { autoFlow?: Partial<FinishAutoFlowSettings> } | undefined {
  if (!config || typeof config !== "object") return undefined;
  // The `finish` slice is now flat (finish.*); this plugin still reads the
  // pre-flatten `finish.autoFlow` shape and is deleted in the cutover. The
  // cast keeps the dead path compiling without reshaping it.
  return (finishConfigSelector.select(config as NaxConfig)?.finish as unknown) as
    | { autoFlow?: Partial<FinishAutoFlowSettings> }
    | undefined;
}
```

Because the shim lifts `autoFlow` away, the plugin now reads `undefined` and falls back to `DEFAULT_FINISH_AUTO_FLOW_CONFIG`, whose `enabled` is `false`. **The old flow stops running the moment this task lands.** That is intended and is why Tasks 3-6 must follow before release: between Task 2 and Task 6, finish does nothing at all. State this in the commit message.

- [ ] **Step 10: Commit**

```bash
git add src/config/ test/unit/config/ src/plugins/builtin/nax-finish/config.ts
git commit -m "feat(config): flatten finish.autoFlow.* to finish.* with a compat shim

The autoFlow segment is named after a flow that the native finish phase
replaces. flowPath/defaultAgent/model are removed (acpx argv with no
in-process equivalent) and reviewers.* reshape from acpx profile names to
ConfiguredModel, with a new fix slot for the fixer.

Interim state: the shim lifts autoFlow away, so the acpx plugin now reads
its defaults and is inert. Finish does nothing until the phase is wired."
```

---

## Task 3: Telegram delivery moves into `src/finish/`

**Files:**
- Create: `src/finish/notify.ts`
- Create: `test/unit/finish/notify.test.ts`
- Modify: `src/finish/index.ts`

**Interfaces:**
- Consumes: `FinishResult`, `Finding` from `./types`.
- Produces: `sendTelegramNotify(cfg, text)`, `buildEscalationMessage(feature, reason, findings)`, `buildTerminalMessage(opts)`, `telegramCreds(config)`, `isTelegramConfigured(config)`, `_notifyDeps`, `TELEGRAM_MAX_MESSAGE_CHARS`.

Design §4.1 says "Telegram escalation moves to `src/finish/escalate.ts`". It did not — `src/finish/escalate.ts` only *routes* to `channel: "telegram"` and returns; the sender still lives in `src/plugins/builtin/nax-finish/telegram.ts`, which Task 8 deletes. Wiring the phase without this task silently drops every Telegram escalation.

It lands in a new `notify.ts` rather than inside `escalate.ts` because `escalate.ts` is the forge-comment path and takes `ForgeDeps`; the notifier takes a `fetch` and no forge. Two responsibilities, two files.

- [ ] **Step 1: Copy the tests first**

Copy `test/unit/plugins/builtin/nax-finish/telegram-notify.test.ts` to `test/unit/finish/notify.test.ts` and repoint every import at `@/finish`. Then append the credential cases, which the plugin's suite covers in `config.test.ts` and which must not be lost:

```ts
test("telegramCreds reads interaction.config when the plugin is telegram", () => {
  expect(telegramCreds({ interaction: { plugin: "telegram", config: { botToken: "t", chatId: "c" } } })).toEqual({
    token: "t",
    chatId: "c",
  });
});

test("telegramCreds ignores interaction.config when another plugin is selected", () => {
  const prev = { ...process.env };
  process.env.NAX_TELEGRAM_TOKEN = undefined as unknown as string;
  try {
    delete process.env.NAX_TELEGRAM_TOKEN;
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.NAX_TELEGRAM_CHAT_ID;
    expect(telegramCreds({ interaction: { plugin: "cli", config: { botToken: "t", chatId: "c" } } })).toBeNull();
  } finally {
    process.env = prev;
  }
});

test("telegramCreds needs both halves", () => {
  expect(telegramCreds({ interaction: { plugin: "telegram", config: { botToken: "t" } } })).toBeNull();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test test/unit/finish/notify.test.ts`
Expected: FAIL — `@/finish` exports none of these names.

- [ ] **Step 3: Create the module**

`src/finish/notify.ts` is a straight lift of `src/plugins/builtin/nax-finish/telegram.ts` plus `telegramCreds` / `isTelegramConfigured` from that directory's `config.ts`. Copy the bodies verbatim — including the `parse_mode` doc comment, which records why plain text is load-bearing, and the 5s `NOTIFY_FETCH_TIMEOUT_MS` cap (SEC-4). Rename the seam `_telegramDeps` to `_notifyDeps` so the barrel name says which module it belongs to, and open the file with:

```ts
/**
 * Telegram notification for the finish phase.
 *
 * Lifted from `src/plugins/builtin/nax-finish/telegram.ts` and that
 * directory's `config.ts`, both deleted in the cutover. Independent of
 * `src/interaction/plugins/telegram.ts`: this is a fire-and-forget
 * notification, not an interactive request/response.
 *
 * Separate from `./escalate` deliberately. That module posts a comment
 * through the forge and takes `ForgeDeps`; this one takes a `fetch` and
 * knows nothing about a forge. `postEscalation`'s `preferTelegram` branch
 * returns `channel: "telegram"` without sending anything — this module is
 * what actually sends, called by the phase after it reads the result.
 */
```

Do not add a `NaxError`: every function here is fail-soft by contract (`sendTelegramNotify` returns `false` and swallows), and adding a throw would put a network failure on the one path whose job is to say a human is needed.

- [ ] **Step 4: Export from the barrel**

`src/finish/index.ts`:

```ts
export {
  _notifyDeps,
  buildEscalationMessage,
  buildTerminalMessage,
  isTelegramConfigured,
  sendTelegramNotify,
  TELEGRAM_MAX_MESSAGE_CHARS,
  telegramCreds,
} from "./notify";
```

- [ ] **Step 5: Run the tests**

Run: `bun test test/unit/finish/notify.test.ts`
Expected: PASS.

- [ ] **Step 6: Confirm the duplicate is intentional**

Run: `bun test test/unit/plugins/builtin/nax-finish/`
Expected: still PASS. Both copies exist until Task 8. Do not delete the plugin's tests here — they guard code that is still in the tree.

- [ ] **Step 7: Commit**

```bash
git add src/finish/notify.ts src/finish/index.ts test/unit/finish/notify.test.ts
git commit -m "feat(finish): move Telegram escalation delivery into src/finish"
```

---

## Task 4: A caller-supplied abort signal for `callOp`

**Files:**
- Modify: `src/operations/types.ts:15-50`
- Modify: `src/operations/call.ts:120,139,331,350,404,415`
- Modify: `docs/superpowers/specs/2026-08-18-native-nax-finish-design.md` (§4.7)
- Test: `test/unit/operations/call.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `CallContext.signal?: AbortSignal`, honoured in preference to `ctx.runtime.signal`.

Read "A correction to carry into Task 4" above before starting. `callOp` already honours `ctx.runtime.signal`; what is missing is a *narrower* signal, which is what `finish.timeouts.flowMs` needs.

- [ ] **Step 1: Write the failing test**

Append to `test/unit/operations/call.test.ts`:

```ts
test("ctx.signal aborts a retry even when runtime.signal is live", async () => {
  const controller = new AbortController();
  const runtime = makeFakeRuntime({ signal: new AbortController().signal }); // never aborted
  let attempts = 0;
  const op: RunOperation<{ x: number }, string, unknown> = {
    kind: "run",
    name: "test-abort",
    stage: "review",
    config: passthroughSelector,
    session: { role: "finish-review-spec", lifetime: "fresh" },
    build: () => ({ task: { id: "task", content: "go", overridable: false } }),
    parse: (out) => out,
    retry: {
      shouldRetry: () => {
        attempts += 1;
        controller.abort();
        return { retry: true, delayMs: 0 };
      },
    },
  };

  await expect(
    callOp({ ...baseCtx, runtime, signal: controller.signal }, op, { x: 1 }),
  ).rejects.toThrow(/aborted/);
  expect(attempts).toBe(1);
});

test("ctx.signal absent falls back to runtime.signal", async () => {
  const runtimeController = new AbortController();
  const runtime = makeFakeRuntime({ signal: runtimeController.signal });
  let attempts = 0;
  const op: RunOperation<{ x: number }, string, unknown> = {
    kind: "run",
    name: "test-abort-fallback",
    stage: "review",
    config: passthroughSelector,
    session: { role: "finish-review-spec", lifetime: "fresh" },
    build: () => ({ task: { id: "task", content: "go", overridable: false } }),
    parse: (out) => out,
    retry: {
      shouldRetry: () => {
        attempts += 1;
        runtimeController.abort();
        return { retry: true, delayMs: 0 };
      },
    },
  };

  await expect(callOp({ ...baseCtx, runtime }, op, { x: 1 })).rejects.toThrow(/aborted/);
  expect(attempts).toBe(1);
});
```

Use whatever fake-runtime and base-context helpers this file already has rather than inventing new ones; the two assertions that matter are "the caller's signal wins" and "no caller signal means the runtime's signal still works".

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/unit/operations/call.test.ts -t "ctx.signal"`
Expected: FAIL — `signal` is not a property of `CallContext`.

- [ ] **Step 3: Add the field**

`src/operations/types.ts`, inside `CallContext`:

```ts
  /**
   * A deadline narrower than the run's own, honoured in preference to
   * `runtime.signal`. The post-run finish phase supplies one built from
   * `finish.timeouts.flowMs` so a whole-phase budget can interrupt an
   * in-flight op; `runtime.signal` alone only fires when the run ends,
   * which is too late to bound a phase.
   *
   * Absent means "use the run's signal" — the behaviour every existing
   * caller has today.
   */
  readonly signal?: AbortSignal;
```

- [ ] **Step 4: Honour it in `call.ts`**

Add one resolution near the top of `callOp`, right after `const callId = ...`:

```ts
  // The caller's deadline wins over the run's; see CallContext.signal.
  const abortSignal = ctx.signal ?? ctx.runtime.signal;
```

Then replace every `ctx.runtime.signal` in the function body with `abortSignal` — six read sites (`:120`, `:139`, `:331`, `:350`, `:415`) and one pass-through (`:404`, `signal: ctx.runtime.signal`). Verify none remain:

```bash
grep -n "runtime.signal" src/operations/call.ts
```

Expected: only the single `const abortSignal = ctx.signal ?? ctx.runtime.signal;` line.

- [ ] **Step 5: Run the tests**

Run: `bun test test/unit/operations/`
Expected: PASS.

- [ ] **Step 6: Confirm nothing else regressed**

Run: `bun run typecheck && bun test test/unit/`
Expected: PASS. The field is optional and the fallback is the previous behaviour, so no existing caller changes.

- [ ] **Step 7: Correct the design doc**

`docs/superpowers/specs/2026-08-18-native-nax-finish-design.md` §4.7 says `flowMs` is "threaded into `callOp` (which already accepts one)". Replace that parenthetical:

```markdown
`flowMs` becomes an `AbortSignal` deadline on the phase, passed to `callOp` via
`CallContext.signal` and used by the phase's own loop guard. An earlier draft of
this design said `callOp` already accepted a signal. It did not: it consulted
`ctx.runtime.signal`, which fires only when the whole run ends. The optional
`CallContext.signal` field added by the wiring plan is what makes a phase-scoped
deadline reachable; absent it, the run's signal is still used.
```

- [ ] **Step 8: Commit**

```bash
git add src/operations/types.ts src/operations/call.ts test/unit/operations/call.test.ts docs/superpowers/specs/2026-08-18-native-nax-finish-design.md
git commit -m "feat(operations): let a caller supply an abort signal narrower than the run's"
```

---

## Task 5: `runFinishPhase` — config reader and phase entry point

**Files:**
- Create: `src/finish/config.ts`
- Create: `src/finish/phase.ts`
- Create: `test/unit/finish/config.test.ts`
- Create: `test/unit/finish/phase.test.ts`
- Modify: `src/finish/index.ts`

**Interfaces:**
- Consumes: Task 2's flattened `finish.*` schema; Task 3's `telegramCreds` / `isTelegramConfigured` / `buildEscalationMessage` / `buildTerminalMessage` / `sendTelegramNotify`; Task 4's `CallContext.signal`; from the existing barrel — `createFinishState`, `loadFinishContext`, `createFinishOps`, `runFinishMachine`, `AuditTarget`.
- Produces: `readFinishConfig(config): FinishSettings`, `shouldRunFinish(args): boolean`, `runFinishPhase(ctx: FinishPhaseContext): Promise<FinishResult | null>`, `_finishPhaseDeps`.

Two files because config reading is pure and heavily case-driven while the phase is all I/O; one file would exceed what a reader holds at once and approach `SRC_LIMIT`.

- [ ] **Step 1: Write the config-reader test**

`test/unit/finish/config.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { readFinishConfig } from "@/finish";

describe("readFinishConfig", () => {
  test("an absent finish block is disabled with schema defaults", () => {
    const s = readFinishConfig({});
    expect(s.enabled).toBe(false);
    expect(s.narrative).toBe(true);
    expect(s.timeouts).toEqual({ acceptanceMs: 600_000, gateMs: 900_000, flowMs: 5_400_000, stepMs: null });
    expect(s.prBody).toEqual({ template: "merge", sectionMap: {} });
    expect(s.models).toEqual({});
  });

  test("reviewer selections become the FinishOpsDeps.models shape", () => {
    const s = readFinishConfig({
      finish: {
        enabled: true,
        reviewers: { spec: "powerful", quality: { agent: "claude", model: "opus" }, narrative: null, fix: "fast" },
      },
    });
    expect(s.models).toEqual({
      reviewSpec: "powerful",
      reviewQuality: { agent: "claude", model: "opus" },
      fix: "fast",
    });
  });

  test("a null reviewer is omitted, not passed as null", () => {
    const s = readFinishConfig({ finish: { enabled: true, reviewers: { spec: null, quality: null, narrative: null, fix: null } } });
    expect("reviewSpec" in s.models).toBe(false);
  });

  test("narrative: false disables the narrative op", () => {
    expect(readFinishConfig({ finish: { enabled: true, narrative: false } }).narrative).toBe(false);
  });
});
```

The third case is the one that bites: `FinishOpsDeps.models` fields are `ConfiguredModel | undefined`, and passing an explicit `null` would type-error while a passed-through `undefined` correctly falls through to `callOp`'s default.

- [ ] **Step 2: Run to verify it fails**

Run: `bun test test/unit/finish/config.test.ts`
Expected: FAIL — `readFinishConfig` is not exported.

- [ ] **Step 3: Write `src/finish/config.ts`**

```ts
/**
 * Reading the `finish.*` config slice into the shapes the phase and
 * `createFinishOps` take.
 *
 * The one module that knows config key names. `createFinishOps` deliberately
 * reads no config (plan 4, D4.8) so it stays drivable from a literal in tests;
 * this is where the literal comes from in production.
 *
 * Reads through `finishConfigSelector` rather than indexing `config.finish`
 * directly, so the dependency stays declared in `src/config/selectors.ts`.
 */
import { finishConfigSelector } from "@/config";
import type { ConfiguredModel, NaxConfig } from "@/config";
import type { FinishPrBodySettings } from "./types";

export interface FinishSettings {
  enabled: boolean;
  narrative: boolean;
  prBody: FinishPrBodySettings;
  /** Exactly `FinishOpsDeps["models"]`: an absent key means "callOp's default". */
  models: {
    reviewSpec?: ConfiguredModel;
    reviewQuality?: ConfiguredModel;
    fix?: ConfiguredModel;
    narrative?: ConfiguredModel;
  };
  escalate: { telegram: boolean };
  notify: { mode: "escalation" | "always" | "off" };
  timeouts: { acceptanceMs: number; gateMs: number; flowMs: number; stepMs: number | null };
}

const DEFAULTS: Omit<FinishSettings, "models"> = {
  enabled: false,
  narrative: true,
  prBody: { template: "merge", sectionMap: {} },
  escalate: { telegram: true },
  notify: { mode: "escalation" },
  timeouts: { acceptanceMs: 600_000, gateMs: 900_000, flowMs: 5_400_000, stepMs: null },
};

/** Drop null/undefined slots so an absent selection reaches callOp as `undefined`, not `null`. */
function modelsOf(reviewers: Record<string, ConfiguredModel | null | undefined> | undefined): FinishSettings["models"] {
  const map: Array<[keyof FinishSettings["models"], string]> = [
    ["reviewSpec", "spec"],
    ["reviewQuality", "quality"],
    ["fix", "fix"],
    ["narrative", "narrative"],
  ];
  const out: FinishSettings["models"] = {};
  for (const [target, source] of map) {
    const value = reviewers?.[source];
    if (value !== null && value !== undefined) out[target] = value;
  }
  return out;
}

export function readFinishConfig(config: unknown): FinishSettings {
  const finish =
    config && typeof config === "object"
      ? (finishConfigSelector.select(config as NaxConfig)?.finish as Partial<FinishSettings> & {
          reviewers?: Record<string, ConfiguredModel | null>;
        } | undefined)
      : undefined;
  if (!finish) return { ...DEFAULTS, models: {} };
  return {
    enabled: finish.enabled === true,
    // `!== false` so an older config with no key still narrates, matching the
    // schema default rather than silently opting out.
    narrative: finish.narrative !== false,
    prBody: {
      template: finish.prBody?.template ?? DEFAULTS.prBody.template,
      sectionMap: finish.prBody?.sectionMap ?? DEFAULTS.prBody.sectionMap,
    },
    models: modelsOf(finish.reviewers),
    escalate: { telegram: finish.escalate?.telegram !== false },
    notify: { mode: finish.notify?.mode ?? DEFAULTS.notify.mode },
    timeouts: {
      acceptanceMs: finish.timeouts?.acceptanceMs ?? DEFAULTS.timeouts.acceptanceMs,
      gateMs: finish.timeouts?.gateMs ?? DEFAULTS.timeouts.gateMs,
      flowMs: finish.timeouts?.flowMs ?? DEFAULTS.timeouts.flowMs,
      stepMs: finish.timeouts?.stepMs ?? DEFAULTS.timeouts.stepMs,
    },
  };
}
```

- [ ] **Step 4: Run the config test**

Run: `bun test test/unit/finish/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the phase test**

`test/unit/finish/phase.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { _finishPhaseDeps, runFinishPhase, shouldRunFinish } from "@/finish";

describe("shouldRunFinish", () => {
  const base = { enabled: true, branch: "feat/x", storySummary: { completed: 2, failed: 0, paused: 0 } };

  test("runs on a feature branch with a clean summary", () => {
    expect(shouldRunFinish(base)).toBe(true);
  });
  test("disabled config never runs", () => {
    expect(shouldRunFinish({ ...base, enabled: false })).toBe(false);
  });
  test("a failed story blocks it", () => {
    expect(shouldRunFinish({ ...base, storySummary: { completed: 2, failed: 1, paused: 0 } })).toBe(false);
  });
  test("a paused story blocks it", () => {
    expect(shouldRunFinish({ ...base, storySummary: { completed: 2, failed: 0, paused: 1 } })).toBe(false);
  });
  test("zero completed stories blocks it", () => {
    expect(shouldRunFinish({ ...base, storySummary: { completed: 0, failed: 0, paused: 0 } })).toBe(false);
  });
  test("main and master are not feature branches", () => {
    expect(shouldRunFinish({ ...base, branch: "main" })).toBe(false);
    expect(shouldRunFinish({ ...base, branch: "master" })).toBe(false);
    expect(shouldRunFinish({ ...base, branch: "" })).toBe(false);
  });
});

describe("runFinishPhase", () => {
  test("emits started and completed with the cost delta", async () => {
    const events: Array<{ type: string; phase?: string; costUsd?: number; passed?: boolean }> = [];
    const restore = { ...
      _finishPhaseDeps };
    _finishPhaseDeps.loadFinishContext = async () => ({
      base: "origin/main",
      specPath: "spec.md",
      acceptanceStatus: "disabled",
      groups: [],
      testFileRegex: [],
      commitsAhead: 3,
      route: "proceed",
    });
    _finishPhaseDeps.detectForge = async () => null;
    _finishPhaseDeps.runFinishMachine = async () => ({ feature: "f", status: "already-ready" });
    try {
      const result = await runFinishPhase(makeCtx({ emit: (e) => events.push(e), costUsd: [1.0, 1.25] }));
      expect(result?.status).toBe("already-ready");
      expect(events.map((e) => e.type)).toEqual(["postrun:phase:started", "postrun:phase:completed"]);
      expect(events[1].phase).toBe("finish");
      expect(events[1].costUsd).toBeCloseTo(0.25);
      expect(events[1].passed).toBe(true);
    } finally {
      Object.assign(_finishPhaseDeps, restore);
    }
  });

  test("a throw from the machine is swallowed and reported as a failed phase", async () => {
    const events: Array<{ type: string; passed?: boolean }> = [];
    const restore = { ..._finishPhaseDeps };
    _finishPhaseDeps.loadFinishContext = async () => proceedContext();
    _finishPhaseDeps.detectForge = async () => null;
    _finishPhaseDeps.runFinishMachine = async () => {
      throw new Error("boom");
    };
    try {
      const result = await runFinishPhase(makeCtx({ emit: (e) => events.push(e) }));
      expect(result).toBeNull();
      expect(events[1]).toMatchObject({ type: "postrun:phase:completed", passed: false });
    } finally {
      Object.assign(_finishPhaseDeps, restore);
    }
  });

  test("an escalated result with telegram configured sends the escalation message", async () => {
    const sent: string[] = [];
    const restore = { ..._finishPhaseDeps };
    _finishPhaseDeps.loadFinishContext = async () => proceedContext();
    _finishPhaseDeps.detectForge = async () => "github";
    _finishPhaseDeps.runFinishMachine = async () => ({
      feature: "f",
      status: "escalated",
      escalationReason: "needs a human",
      findings: [{ severity: "HIGH", title: "t", problem: "p", fix: "x" }],
    });
    _finishPhaseDeps.sendTelegramNotify = async (_creds, text) => {
      sent.push(text);
      return true;
    };
    try {
      await runFinishPhase(makeCtx({ telegram: true }));
      expect(sent).toHaveLength(1);
      expect(sent[0]).toContain("needs a human");
      expect(sent[0]).toContain("[HIGH] t");
    } finally {
      Object.assign(_finishPhaseDeps, restore);
    }
  });

  test("notify.mode 'off' sends nothing even on an escalation", async () => {
    const sent: string[] = [];
    const restore = { ..._finishPhaseDeps };
    _finishPhaseDeps.loadFinishContext = async () => proceedContext();
    _finishPhaseDeps.detectForge = async () => "github";
    _finishPhaseDeps.runFinishMachine = async () => ({
      feature: "f",
      status: "escalated",
      escalationReason: "r",
      findings: [],
    });
    _finishPhaseDeps.sendTelegramNotify = async (_c, t) => {
      sent.push(t);
      return true;
    };
    try {
      await runFinishPhase(makeCtx({ telegram: true, notifyMode: "off" }));
      expect(sent).toEqual([]);
    } finally {
      Object.assign(_finishPhaseDeps, restore);
    }
  });

  test("notify.mode 'always' notifies a non-escalated terminal outcome", async () => {
    const sent: string[] = [];
    const restore = { ..._finishPhaseDeps };
    _finishPhaseDeps.loadFinishContext = async () => proceedContext();
    _finishPhaseDeps.detectForge = async () => "github";
    _finishPhaseDeps.runFinishMachine = async () => ({
      feature: "f",
      status: "opened",
      url: "https://github.com/o/r/pull/9",
    });
    _finishPhaseDeps.sendTelegramNotify = async (_c, t) => {
      sent.push(t);
      return true;
    };
    try {
      await runFinishPhase(makeCtx({ telegram: true, notifyMode: "always" }));
      expect(sent).toHaveLength(1);
      expect(sent[0]).toContain("opened");
      expect(sent[0]).toContain("https://github.com/o/r/pull/9");
    } finally {
      Object.assign(_finishPhaseDeps, restore);
    }
  });

  test("telegram enabled but uncredentialed sends nothing and does not throw", async () => {
    const sent: string[] = [];
    const restore = { ..._finishPhaseDeps };
    _finishPhaseDeps.loadFinishContext = async () => proceedContext();
    _finishPhaseDeps.detectForge = async () => "github";
    _finishPhaseDeps.runFinishMachine = async () => ({ feature: "f", status: "escalated", findings: [] });
    _finishPhaseDeps.sendTelegramNotify = async (_c, t) => {
      sent.push(t);
      return true;
    };
    try {
      await runFinishPhase(makeCtx({ telegram: false }));
      expect(sent).toEqual([]);
    } finally {
      Object.assign(_finishPhaseDeps, restore);
    }
  });
});
```

`proceedContext()` is a local helper returning the `route: "proceed"` `FinishContext` used by the first test. The last case matters because `preferTelegram` is set from `escalate.telegram && telegramCreds(config) !== null`: enabled-but-uncredentialed must fall back to the PR comment, and the notifier must not be handed null credentials.

Write `makeCtx` as a local helper in this file building a `FinishPhaseContext` over fakes: a fake `NaxRuntime` exposing `outputDir`, `packages.resolve()`, `costAggregator.snapshot()` returning the two totals in sequence, and a fake `agentManager.getDefault()`. Do not reach for a shared helper that does not exist.

- [ ] **Step 6: Run to verify it fails**

Run: `bun test test/unit/finish/phase.test.ts`
Expected: FAIL — `runFinishPhase` is not exported.

- [ ] **Step 7: Write `src/finish/phase.ts`**

```ts
/**
 * `runFinishPhase` — the post-run phase that drives the finish machine.
 *
 * The module design section 4.1 calls for and the only thing in `src/finish/`
 * that knows about the runner. It assembles what the machine needs from the
 * live run context (audit target, forge kind, `CallContext`, config), drives
 * `runFinishMachine`, books the cost delta and notifies.
 *
 * Fail-open by contract. `runFinishMachine` already routes every internal
 * failure to `ops.escalate` (I7), so a throw reaching here means the phase
 * could not be *set up* — a context load that threw past its own catch, or a
 * runtime field that was not there. Neither is a reason to fail a run whose
 * stories all passed, so this returns null and emits a failed phase instead.
 */
import { detectForge, defaultForgeDeps } from "@/forge";
import type { CallContext } from "@/operations";
import { pipelineEventBus } from "@/pipeline";
import type { NaxRuntime } from "@/runtime";
import { errorMessage } from "../utils/errors";
import type { AuditTarget } from "./audit";
import { readFinishConfig } from "./config";
import type { FinishSettings } from "./config";
import { loadFinishContext } from "./context";
import { runFinishMachine } from "./machine";
import { buildEscalationMessage, buildTerminalMessage, sendTelegramNotify, telegramCreds } from "./notify";
import { createFinishOps } from "./ops-impl";
import { createFinishState } from "./state";
import type { FinishResult } from "./types";

export const _finishPhaseDeps = {
  loadFinishContext,
  detectForge,
  createFinishOps,
  runFinishMachine,
  sendTelegramNotify,
  now: () => new Date().toISOString(),
};

export interface FinishPhaseContext {
  runtime: NaxRuntime;
  config: unknown;
  feature: string;
  workdir: string;
  branch: string;
  runId: string;
  agentName: string;
  abortSignal: AbortSignal;
  storySummary: { completed: number; failed: number; paused: number };
  /** Merged into the phase's status.json entry; absent in tests. */
  statusWriter?: { setPostRunPhase(phase: "finish", update: Record<string, unknown>): void };
}

/** A branch nax may open a PR from. `main`/`master` are not feature branches. */
function isFeatureBranch(branch: string): boolean {
  return branch !== "main" && branch !== "master" && branch.length > 0;
}

export function shouldRunFinish(args: {
  enabled: boolean;
  branch: string;
  storySummary: { completed: number; failed: number; paused: number };
}): boolean {
  if (!args.enabled) return false;
  const s = args.storySummary;
  if (s.completed === 0 || s.failed > 0 || s.paused > 0) return false;
  return isFeatureBranch(args.branch);
}

/**
 * The phase's own deadline: `finish.timeouts.flowMs`, combined with the run's
 * signal so either can stop it.
 *
 * `AbortSignal.any` rather than a manual listener pair, so the returned signal
 * is already aborted when the run's signal was aborted before the phase
 * started — a listener would never fire in that case.
 */
function phaseSignal(runSignal: AbortSignal, flowMs: number): { signal: AbortSignal; dispose: () => void } {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), flowMs);
  return {
    signal: AbortSignal.any([runSignal, deadline.signal]),
    dispose: () => clearTimeout(timer),
  };
}

export async function runFinishPhase(ctx: FinishPhaseContext): Promise<FinishResult | null> {
  const settings = readFinishConfig(ctx.config);
  if (!shouldRunFinish({ enabled: settings.enabled, branch: ctx.branch, storySummary: ctx.storySummary })) {
    return null;
  }

  pipelineEventBus.emit({ type: "postrun:phase:started", phase: "finish" });
  ctx.statusWriter?.setPostRunPhase("finish", { status: "running" });
  const startedAt = Date.now();
  const costBefore = ctx.runtime.costAggregator.snapshot().totalCostUsd;
  const { signal, dispose } = phaseSignal(ctx.abortSignal, settings.timeouts.flowMs);

  let result: FinishResult | null = null;
  let failure: string | undefined;
  try {
    const context = await _finishPhaseDeps.loadFinishContext(ctx.feature, ctx.workdir);
    const audit: AuditTarget = {
      auditDir: `${ctx.runtime.outputDir}/finish-audit/${ctx.feature}`,
      runId: ctx.runId,
    };
    const state = createFinishState({
      feature: ctx.feature,
      workdir: ctx.workdir,
      branch: ctx.branch,
      runId: ctx.runId,
      base: context.base,
      specPath: context.specPath,
    });
    const forgeKind = await _finishPhaseDeps.detectForge(defaultForgeDeps, ctx.workdir);
    const callCtx: CallContext = {
      runtime: ctx.runtime,
      packageView: ctx.runtime.packages.resolve(ctx.workdir),
      packageDir: ctx.workdir,
      agentName: ctx.agentName,
      featureName: ctx.feature,
      signal,
    };
    const ops = _finishPhaseDeps.createFinishOps({
      callCtx,
      forge: defaultForgeDeps,
      forgeKind,
      audit,
      models: settings.models,
      timeouts: {
        reviewMs: settings.timeouts.stepMs ?? undefined,
        fixMs: settings.timeouts.stepMs ?? undefined,
        narrativeMs: settings.timeouts.stepMs ?? undefined,
      },
      prBody: settings.prBody,
      // Telegram is the sole escalation channel only when it is both enabled
      // and actually credentialed — enabled with no token would suppress the
      // PR comment and then send nothing at all.
      preferTelegram: settings.escalate.telegram && telegramCreds(ctx.config) !== null,
      narrative: settings.narrative,
    });
    result = await _finishPhaseDeps.runFinishMachine(state, {
      context,
      ops,
      audit,
      signal,
      now: _finishPhaseDeps.now,
      timeouts: { acceptanceMs: settings.timeouts.acceptanceMs, gateMs: settings.timeouts.gateMs },
    });
  } catch (err) {
    failure = errorMessage(err);
  } finally {
    dispose();
  }

  const costUsd = ctx.runtime.costAggregator.snapshot().totalCostUsd - costBefore;
  const passed = failure === undefined && result?.status !== "escalated";
  ctx.statusWriter?.setPostRunPhase("finish", {
    status: passed ? "passed" : "failed",
    lastRunAt: _finishPhaseDeps.now(),
    ...(result ? { result: result.status } : {}),
    ...(result?.url ? { url: result.url } : {}),
    ...(result?.escalationReason ? { escalationReason: result.escalationReason } : {}),
  });
  pipelineEventBus.emit({
    type: "postrun:phase:completed",
    phase: "finish",
    passed,
    durationMs: Date.now() - startedAt,
    costUsd,
    ...(failure ? { details: { error: failure } } : {}),
  });

  if (result) await notify(ctx, settings, result);
  return result;
}

/** Send the Telegram notification the configured mode calls for. Never throws. */
async function notify(ctx: FinishPhaseContext, settings: FinishSettings, result: FinishResult): Promise<void> {
  if (settings.notify.mode === "off") return;
  if (settings.notify.mode === "escalation" && result.status !== "escalated") return;
  const creds = telegramCreds(ctx.config);
  if (!creds) return;
  const text =
    result.status === "escalated"
      ? buildEscalationMessage(result.feature, result.escalationReason ?? "", result.findings ?? [])
      : buildTerminalMessage({ feature: result.feature, status: result.status, url: result.url });
  await _finishPhaseDeps.sendTelegramNotify(creds, text);
}
```

Check the emitted event objects against `PostRunPhaseStartedEvent` / `PostRunPhaseCompletedEvent` in `src/pipeline/event-bus.ts:176-190` and drop or rename any field those interfaces do not declare — `tsc` will say which.

- [ ] **Step 8: Export from the barrel**

```ts
export { readFinishConfig } from "./config";
export type { FinishSettings } from "./config";
export { _finishPhaseDeps, runFinishPhase, shouldRunFinish } from "./phase";
export type { FinishPhaseContext } from "./phase";
```

- [ ] **Step 9: Run the tests**

Run: `bun test test/unit/finish/`
Expected: PASS, 379 existing plus the new cases.

- [ ] **Step 10: Check the size limits**

Run: `wc -l src/finish/phase.ts src/finish/config.ts && bun run check:file-sizes`
Expected: both well under 600; the check reports the baseline of 10 unchanged.

- [ ] **Step 11: Commit**

```bash
git add src/finish/config.ts src/finish/phase.ts src/finish/index.ts test/unit/finish/config.test.ts test/unit/finish/phase.test.ts
git commit -m "feat(finish): add runFinishPhase, the post-run phase entry point"
```

---

## Task 6: Call the phase from the runner

**Files:**
- Modify: `src/execution/runner-completion.ts`
- Test: `test/unit/execution/runner-completion.test.ts`

**Interfaces:**
- Consumes: `runFinishPhase`, `FinishPhaseContext` from `@/finish` (Task 5); `setPostRunPhase("finish", …)` (Task 1).
- Produces: finish running in production. This is the task that makes the arc live.

Placement is constrained on both sides. It must run **after** `handleRunCompletion` (which writes the final story statuses the gating reads) and **before** `await options.runtime?.close()` at `:427`, whose own comment reads "flushes auditors, drains cost aggregator, aborts signal" — after that call the cost delta is lost and the abort signal has already fired (design §4.8).

- [ ] **Step 1: Write the failing test**

Append to `test/unit/execution/runner-completion.test.ts`:

```ts
test("runs the finish phase before closing the runtime", async () => {
  const order: string[] = [];
  const restore = { ..._runnerCompletionDeps };
  _runnerCompletionDeps.runFinishPhase = async () => {
    order.push("finish");
    return null;
  };
  const runtime = makeFakeRuntime({ close: async () => void order.push("close") });
  try {
    await runCompletionPhase(makeOptions({ runtime, feature: "f", prd: passingPrd() }));
    expect(order).toEqual(["finish", "close"]);
  } finally {
    Object.assign(_runnerCompletionDeps, restore);
  }
});

test("a throwing finish phase does not fail the run", async () => {
  const restore = { ..._runnerCompletionDeps };
  _runnerCompletionDeps.runFinishPhase = async () => {
    throw new Error("boom");
  };
  try {
    const result = await runCompletionPhase(makeOptions({ prd: passingPrd() }));
    expect(result.acceptancePassed).toBe(true);
  } finally {
    Object.assign(_runnerCompletionDeps, restore);
  }
});
```

The second test is not redundant with `runFinishPhase`'s own fail-open: that guards setup failures *inside* the phase, this guards the call site against anything the phase cannot catch (an import failure, a synchronous throw before its try). Both are cheap.

- [ ] **Step 2: Run to verify it fails**

Run: `bun test test/unit/execution/runner-completion.test.ts -t "finish phase"`
Expected: FAIL — `_runnerCompletionDeps.runFinishPhase` is not a property.

- [ ] **Step 3: Add the seam**

`src/execution/runner-completion.ts` — extend the existing `_runnerCompletionDeps` object (the one carrying `handleRunCompletion` at `:109`):

```ts
  async runFinishPhase(ctx: FinishPhaseContext) {
    const { runFinishPhase } = await import("@/finish");
    return runFinishPhase(ctx);
  },
```

Dynamic import, matching `handleRunCompletion`'s own pattern at `:110`. This also sidesteps the import-cycle risk plan 2 flagged (`2026-08-18-finish-core.md:622`): `src/finish` imports `@/cli`, and a static import here would make `@/execution` -> `@/finish` -> `@/cli` a load-time chain.

- [ ] **Step 4: Call it**

Immediately before `await options.runtime?.close();` at `:427`:

```ts
  // Native finish phase (design 4.1). Must precede runtime.close(), whose own
  // comment below says it drains the cost aggregator and aborts the signal —
  // after it, finish's spend never reaches totalCost and its deadline signal
  // is already fired. Fail-open: a finish that cannot run never fails a run
  // whose stories all passed.
  try {
    await _runnerCompletionDeps.runFinishPhase({
      runtime: options.runtime,
      config: options.config,
      feature: options.feature,
      workdir: options.workdir,
      branch: await currentBranch(options.workdir),
      runId: options.runId,
      agentName: options.agentManager.getDefault(),
      abortSignal: options.abortSignal,
      storySummary: finishStorySummary(options.prd),
      statusWriter: options.statusWriter,
    });
  } catch (err) {
    logger?.warn("finish", "Finish phase failed; the run is unaffected", {
      storyId: "_run",
      error: errorMessage(err),
    });
  }
```

Add the mapping helper near the bottom of the same file:

```ts
/**
 * The three counts `shouldRunFinish` gates on, from nax's own counter.
 *
 * `countStories` (`@/prd`) reports `passed`, not `completed` — reuse it rather
 * than writing a second counter, but map the name. The plugin this replaces
 * read `completed` off `PostRunContext.storySummary`, which the plugin host
 * built from the same `passed` count, so the two agree.
 *
 * `failed` from `countStories` already folds in `regression-failed`, matching
 * the classification the deferred regression gate uses.
 */
function finishStorySummary(prd: PRD): { completed: number; failed: number; paused: number } {
  const counts = countStories(prd);
  return { completed: counts.passed, failed: counts.failed, paused: counts.paused };
}
```

Import `countStories` from `@/prd` alongside the existing `isComplete` import at `:19`. `currentBranch` is the existing git helper in `@/utils/git` — confirm the exported name with `grep -n "export.*[Bb]ranch" src/utils/git.ts` and use it rather than shelling out here.

- [ ] **Step 5: Run the tests**

Run: `bun test test/unit/execution/`
Expected: PASS.

- [ ] **Step 6: Full suite and gates**

Run: `bun run typecheck && bun run lint && bun run test`
Expected: PASS.

- [ ] **Step 7: Verify the phase is no longer dead code**

```bash
grep -rn "@/finish" src --include="*.ts" | grep -v "^src/finish/"
```

Expected: one hit, the dynamic import in `runner-completion.ts`. This is the inverse of plan 2's handover check (`2026-08-18-finish-core.md:614`), which required this grep to return nothing.

- [ ] **Step 8: Commit**

```bash
git add src/execution/runner-completion.ts test/unit/execution/runner-completion.test.ts
git commit -m "feat(execution): run the native finish phase before closing the runtime

src/finish/ has been complete and unreachable since #1629; this is the
call site that makes it run. Placed before runtime.close() so the cost
delta is booked and the phase's abort deadline is still live."
```

---

## Task 7: Port the git-backed diffstat test

**Files:**
- Create: `test/integration/finish/pr-diffstat.test.ts`
- Reference (do not modify): `test/integration/flows/pr-diffstat.test.ts`

**Interfaces:**
- Consumes: `loadFinishPrContext` from `@/finish`.
- Produces: real-git coverage of the artifact pathspec, so Task 8's deletion drops nothing.

`test/integration/flows/pr-diffstat.test.ts` is the only integration test in the arc and Task 8 deletes it. Its header states exactly why the unit test cannot replace it: `pr-body.test.ts` asserts the pathspec *string*, and the bug it exists for was a string that was right in spirit and wrong in behaviour — a root-anchored `:!.nax/**` silently kept the per-package `<pkg>/.nax/` copy. `src/finish/pr/context.ts:156` carries the corrected `**/.nax/**` pathspec, but only a unit test guards it.

- [ ] **Step 1: Copy the file**

```bash
cp test/integration/flows/pr-diffstat.test.ts test/integration/finish/pr-diffstat.test.ts
```

Create the directory first if `test/integration/finish/` does not exist.

- [ ] **Step 2: Repoint the import**

Change:

```ts
import { loadFinishPrContext } from "@flows/nax-finish/steps/pr-body";
```

to:

```ts
import { loadFinishPrContext } from "@/finish";
```

- [ ] **Step 3: Adapt the call signature**

The flow's `loadFinishPrContext` and the native one take different arguments. The native signature is `loadFinishPrContext(args: LoadPrContextArgs)` where `LoadPrContextArgs` is `{ state, audit, forge, prBody?, narrative?, title? }`. Read `src/finish/pr/context.ts` and `test/unit/finish/pr-context.test.ts` for how the unit suite builds those, and construct a `FinishState` with `createFinishState` over the temp repo the test already creates. Keep every assertion about the diffstat unchanged — the assertions are the point of the port.

- [ ] **Step 4: Run it**

Run: `bun test test/integration/finish/pr-diffstat.test.ts`
Expected: PASS.

- [ ] **Step 5: Prove it still catches the bug**

Temporarily change `NAX_ARTIFACT_PATHSPEC` in `src/finish/pr/context.ts:156` from `"**/.nax/**"` to `".nax/**"` and re-run.
Expected: FAIL — the per-package artifact appears in the diffstat. Revert the change and re-run to confirm PASS.

A regression test written after the fix passes trivially unless you have seen it fail against the old behaviour. Do not skip this step.

- [ ] **Step 6: Commit**

```bash
git add test/integration/finish/pr-diffstat.test.ts
git commit -m "test(finish): port the git-backed PR diffstat test to the native loader"
```

---

## Task 8: Delete the flow and the plugin

**Files:**
- Delete: `flows/` (28 files), `src/plugins/builtin/nax-finish/` (4 files), `scripts/check-flows-no-bun.ts`, `test/unit/flows/` (28 files), `test/unit/plugins/builtin/nax-finish/` (5 files), `test/integration/flows/pr-diffstat.test.ts`, `docs/guides/nax-finish-autoflow.md`
- Modify: `package.json`, `tsconfig.json`, `src/plugins/index.ts`, `src/plugins/loader.ts:173-183`, `test/unit/forge/template-merge.test.ts`
- Modify: `docs/superpowers/specs/2026-08-18-native-nax-finish-design.md` (§6 checklist)

**Interfaces:**
- Consumes: a green Task 6 and Task 7. Do not start this task until finish has been observed running on a real feature.
- Produces: one implementation of finish in the tree.

**The `acpx` dependency stays.** Design §6 step 4 is explicit: acpx is the agent transport for every op in nax; only the `acpx/flows` import goes. Do not touch `package.json`'s acpx entry.

- [ ] **Step 1: Drop the equivalence test's flow half**

`test/unit/forge/template-merge.test.ts:3` imports `@flows/nax-finish/pr-template-merge` to prove the two copies agree (plan 4, D4.1). With the flow gone there is one copy, so delete that import and the equivalence case, keeping every other test in the file. Confirm what remains still covers `mergeTemplate` on its own:

```bash
grep -c "^test(\|^  test(" test/unit/forge/template-merge.test.ts
```

- [ ] **Step 2: Delete the trees**

```bash
git rm -r flows/ src/plugins/builtin/nax-finish/ test/unit/flows/ test/unit/plugins/builtin/nax-finish/ test/integration/flows/
git rm scripts/check-flows-no-bun.ts docs/guides/nax-finish-autoflow.md
```

- [ ] **Step 3: Unregister the plugin**

`src/plugins/loader.ts` — delete the `naxFinishPlugin` import at `:20` and the whole registration block at `:173-183`. `src/plugins/index.ts` — delete `naxFinishPlugin` from the export list at `:58` and the `getFinishAutoFlowConfig, isTelegramConfigured, telegramCreds` re-export at `:65`.

`isTelegramConfigured` and `telegramCreds` now live in `@/finish` (Task 3). If anything outside the deleted tree imported them from `@/plugins`, repoint it at `@/finish`:

```bash
grep -rn "isTelegramConfigured\|telegramCreds\|getFinishAutoFlowConfig" src/ test/ | grep -v "src/finish/\|test/unit/finish/"
```

Expected after the fix: no hits.

- [ ] **Step 4: Drop the packaging and tsconfig entries**

`package.json` — remove `"flows/"` from `files`, and remove `&& bun run check:flows-no-bun` from the `lint` script plus the `check:flows-no-bun` script entry itself.

`tsconfig.json` — remove the `"@flows/*": ["./flows/*"]` path at `:21` and `"flows/**/*.ts"` from `include` at `:26`. Check `tsconfig.contracts.json` and any biome config for the same references:

```bash
grep -rn "flows" package.json tsconfig*.json biome.json* 2>/dev/null
```

Expected: no hits.

- [ ] **Step 5: Sweep for stragglers**

```bash
grep -rn "flows/nax-finish\|@flows/\|nax-finish plugin\|naxFinishPlugin" src/ test/ scripts/ docs/ bin/ | grep -v "docs/superpowers/"
```

`docs/superpowers/` is excluded because the design and the four predecessor plans reference `flows/` as historical record and must not be rewritten. Everything else should return nothing — expect hits in `src/config/schemas.ts` comments and `src/forge/template-merge.ts:36`, which still name the flow copy. Update those comments to drop the "the `flows/` copy keeps its own" clauses.

- [ ] **Step 6: Run everything**

Run: `bun run typecheck && bun run lint && bun run test`
Expected: PASS. `lint` no longer runs `check:flows-no-bun`. If `check:file-sizes` or `check:nax-error` baselines now overshoot (fewer files scanned), lower them with their `--update-baseline` flags and commit the new baseline in this task.

- [ ] **Step 7: Confirm the build still bundles**

Run: `bun run build`
Expected: succeeds. `flows/` was a `files` entry, not a build input, so nothing should change — but the bundle is what ships and an unverified packaging change is the kind that surfaces on `npm publish`.

- [ ] **Step 8: Tick off the design's cutover**

In `docs/superpowers/specs/2026-08-18-native-nax-finish-design.md` §6, mark steps 1-4 done with their PR numbers and leave step 5 open with a note that it is a separate repo:

```markdown
Each step is independently revertable. Status: 1-4 **done** (#1626, #1627/#1628/#1629,
wiring PR, cutover PR); step 5 is open and lives in the `nax-spec-kit-skills` repo.
```

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "refactor(finish): delete the acpx flow and the nax-finish plugin

The native post-run phase has been driving finish since the wiring commit.
Removes flows/ (28 files), src/plugins/builtin/nax-finish/, their tests,
check-flows-no-bun, the @flows/* alias and the flows/ package entry.

The acpx dependency stays: it is the agent transport for every op in nax.
Only the acpx/flows import goes."
```

---

## Out of scope

Recorded so a reader does not mistake omission for oversight.

- **`nax finish [feature]` as a CLI command.** Design §7 defers it. `FinishState` is serializable and `runFinishPhase` takes a plain context object, so it stays cheap to add.
- **Resume from checkpoint.** Same, and `state.ts` already has `serializeFinishState` / `deserializeFinishState` with a version guard for it.
- **An abort signal on `runQualityCommand`.** Task 4 stops at `CallContext` deliberately. Gate commands are already wall-clock capped per command by `gateMs` / `acceptanceMs`, so the unbounded-hang case the phase deadline exists for is covered there; the LLM op was the only unbounded caller. Adding a signal parameter to `runQualityCommand` touches every acceptance and quality caller in the repo and belongs in its own change.
- **The nine `nax-finish-*.json` profiles** in `~/.nax/profiles/` and the `nax-global` repo. Design §4.6 says all nine need rewriting; they are outside this repository, as plan 1 already noted. The Task 2 compat shim keeps them loading with a warning in the meantime.
- **The `nax-toolkit-skills` sync** (cutover step 5). Separate public repo.
- **Converging `src/plugins/builtin/auto-pr`'s private `defaultRun` onto `defaultForgeDeps`.** Plan 4 D4.11 called this "a plan 5 opportunity, not this plan's scope". It is not required by any step here and would enlarge the cutover diff for no functional gain — leave it, or take it as its own commit.
- **Writing the result file before delivery in `doEscalate`.** The flow wrote its result *before* calling `postEscalation` (`nax-finish.flow.ts:452`, citing #1399); `machine.ts` writes it after. The try/catch covers the throw path that actually caused #1399 and `defaultForgeDeps` caps each subprocess at 30s, so this is narrow — but an external kill during delivery now leaves no result file where the flow's ordering survived it. It is a `src/finish/machine.ts` change, not a wiring change; raise it as its own issue.

---

## Verification, after Task 8

The design's §9 acceptance criteria, restated as things to actually run:

- **Config-level.** In a repo with `finish.enabled: true`, no root `quality.commands`, and per-package ones, confirm the gates run rather than escalating "nax-finish verified nothing". This exercises F2, which `resolveGateCommands` fixed but which no live run has ever taken.
- **Behaviour-level.** Run finish on the project that produced the three recorded runs and diff the new audit trail under `~/.nax/<project>/finish-audit/` against them: same phases, same round shape, monotonic `attempt` numbering, and **no `outcome: "unparseable"` on the quality reviewer's first attempt**. That last one is the measurable target the whole arc exists for.
- **Environment-level.** Confirm a finish completes with the local acpx working checkout off `PATH` and only the published acpx available. `acpx` on `PATH` is a personal fork; the port is not verified for reproducibility until a run succeeds without it.
- **Cost.** Confirm `postrun:phase:completed` for `phase: "finish"` carries a non-zero `costUsd` and that it is included in the run's reported total. No emitter in the codebase populated `costUsd` before this arc — it was a declared channel, not an automatic one — so this is new behaviour, not a regression check.
