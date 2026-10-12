# Finish A: Honest Stop and Reporting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish stops when a time limit fires, never commits a stopped session's edits, sets them aside with a handoff for the next attempt, and reports every finding's state, every stop, and real coverage in the draft PR and `result.json`.

**Architecture:**
- **Stop signal.** It now reaches the agent turn: `buildRunDispatchOptions` threads the call's `abortSignal` (Task 1), and a hop's `send` can take a per-turn signal override, so a 2-minute handoff turn can run after the fix turn is cut (Task 2).
- **Step limits.** Finish builds them as `AbortSignal.any([phaseSignal, AbortSignal.timeout(ms)])` (Tasks 3–4).
- **Fix sessions.** One wrapper, `runFixStep` (Task 7), runs every fix session. It owns the commit guard, the set-aside on a stop (Task 6), and re-applying the previous handoff (Task 8).
- **Ledger.** A per-finding ledger (Task 9) replaces the two disagreeing paths (round cap vs deadline). Facts, reasons, checkpoints and the PR body read from it (Tasks 10–12).

**Tech Stack:** TypeScript (strict), Bun 1.4 (`bun:test`), Biome. The nax monorepo package `packages/nax`.

**Spec:** `docs/superpowers/specs/2026-10-12-finish-a-honest-stop-and-reporting-design.md` (commit `d78f12457`).

## Global Constraints

- **Branch:** work on the local branch `feat/finish-honest-stop` (no upstream). Never push to `main`.
- **Where to run:** all commands run from `packages/nax` unless a step says otherwise.
- **Targeted tests:** `bun test <path> --timeout=30000`. Never bare `bun test`, never `bun run nax`.
- **Before declaring done:** `bun run test`, `bun run check:all`, `bun run typecheck` and `bun run test:coverage` must be green. The repo root `bun run check:all` must be green too.
- **Time limits:** `reviewMs` default `900_000` (15 min), `fixMs` default `1_200_000` (20 min), `flowMs` default `10_800_000` (3 h). `acceptanceMs` (`600_000`) and `gateMs` (`900_000`) are unchanged. `stepMs` is deprecated.
- **Handoff turn cap:** `HANDOFF_TURN_MS = 120_000`.
- **Stop latency:** a running review or fix session must end within 30 s of its step limit or of `flowMs`.
- **Never `git clean`.** Delete only the untracked paths a stopped fix session created.
- **Unchanged rules:** the ready/draft decision (`isClean`, `approvalFacts`, `resolve`), advisor callers, menus and ledger schemas.
- **`FinishState.version`** becomes `3`. `deserializeFinishState` rejects any other version.
- **Repo rules** (`.claude/rules/`):
  - no `console.log`;
  - `NaxError` with `stage` in context;
  - the `_deps` injection pattern for I/O, never `mock.module()`;
  - every `logger.*` call in finish carries `storyId: "_run"` as its first key;
  - prompt text is built only in `src/prompts/builders/`;
  - LLM JSON is parsed only with `parseLLMJson` / `tryParseLLMJson`;
  - source files stay under 600 lines, test files under 800;
  - barrel imports in `src/`.
- **Commits:** conventional (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`), one logical change each, no attribution lines.

## Review Focus

Most likely first. Each line names the owning task, whose tests pin it.

1. **A flow deadline while a fix session is running.** Expected: the handoff note is written, the set-aside restores the tree, the stop is recorded, and finish still ends as a draft with a PR. The handoff must not be lost to the later `FINISH_ABORTED` throw. Pinned in Task 7 ("flow stop sets aside, then throws FINISH_ABORTED").
2. **A user's untracked file (e.g. `.env`) that existed before the fix session.** Expected: it survives the set-aside, and only files the session created are deleted. Pinned in Task 6 ("keeps pre-existing untracked files").
3. **A fix session that returns normally a few seconds after the deadline.** Expected: no commit, set aside instead. This is the store-erp `68e7c21` case. Pinned in Task 7 ("commit guard").
4. **A handoff patch that no longer applies on the next attempt.** Expected: a fresh start, the handoff kept on disk, and the PR saying "not re-applied". Pinned in Task 8 ("conflicting patch").
5. **A fixer reply with no `## DISPOSITIONS` section** (`recover()` returns `[]`). Expected: those findings stay `open`, never `fixed-unreviewed`. Pinned in Task 9 ("missing disposition stays open").

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/operations/call-run-options.ts` | modify | thread `abortSignal` into `AgentRunOptions` |
| `src/operations/call-dispatch-run.ts` | modify | pass the prologue's `abortSignal` to `buildRunDispatchOptions`; thread per-send options through `createRunSenders` |
| `src/operations/types.ts` | modify | `HopBodyContext.send(prompt, opts?)` with `SendTurnOverrides` |
| `src/operations/build-hop-callback.ts` | modify | `hopBody` type takes the per-send options |
| `src/operations/build-hop-callback-dispatch.ts` | modify | `send` closure honours `opts.signal` |
| `src/config/finish-timeouts-shim.ts` | create | `stepMs` → `reviewMs` / `fixMs` migration shim |
| `src/config/compat-shims.ts` | modify | add the shim to the chain (+2 lines) |
| `src/config/schemas.ts` | modify | `reviewMs`, `fixMs`, new `flowMs` default, drop `stepMs` |
| `src/config/runtime-types-finish.ts` | modify | timeouts type |
| `src/config/selectors.ts` | modify | comment at ~L148 |
| `src/finish/config.ts` | modify | `FinishSettings.timeouts`, defaults, reader |
| `src/finish/step-signal.ts` | create | `stepSignal(base, ms)` |
| `src/finish/ops.ts` | modify | `FixRequest.signal` / `handoffPath` / `continuation`; review `stoppedAtLimit` |
| `src/finish/ops-impl.ts` | modify | per-call signals; `stoppedAtLimit`; `finalizeDraftPr` dirt rule |
| `src/finish/types.ts` | modify | `Stop`, `HandoffRecord`, `HandoffNote`, `GateFact.status` `not-run`, `FinishTimeouts`, `ResolutionFacts.findings` / `stops`, `FinishResult.handoffs`, `FinishReviewOutput.stoppedAtLimit` |
| `src/operations/finish-fix.ts` | modify | `hopBody` with the handoff turn; new input fields |
| `src/prompts/builders/finish-review-builder.ts` | modify | `buildFinishHandoffPrompt`, continuation section in `buildFinishFixPrompt` |
| `src/finish/set-aside.ts` | create | `captureFixBase`, `setAside`, `reapplyHandoff`, `markHandoffConsumed` |
| `src/finish/fix-step.ts` | create | `runFixStep`: signals, commit guard, set-aside, re-apply |
| `src/finish/acceptance-loop.ts`, `gates-loop.ts`, `review-loop.ts` | modify | use `runFixStep`; ledger events; review stops |
| `src/finish/ledger.ts` | create | `LedgerEntry`, `applyLedgerEvent`, `openFindings` |
| `src/finish/advise.ts` | modify | `JudgedResult.dropped` (waived / superseded per finding) |
| `src/finish/state.ts` | modify | version 3, `stops`, `handoffs`, `pendingHandoff`, `review.ledger` |
| `src/finish/checkpoint.ts` | create | `writeCheckpoint` (atomic) |
| `src/finish/resolve.ts` | modify | facts from the ledger; `draftReason` wording |
| `src/finish/machine.ts` | modify | not-run gate, changed files on recovery, stop reasons, checkpoints |
| `src/finish/pr/context.ts`, `src/finish/pr/body.ts` | modify | findings table, Set aside, Stops |
| `src/finish/phase.ts` | modify | pass `reviewMs`, `fixMs` and the phase signal into ops and machine deps |
| `docs/guides/configuration.md` | modify | document the new timeouts |
| `test/helpers/finish-machine.ts` | modify | git model handles `restore` / `diff` / `apply`; `fixMs` option |

`call-dispatch-run.ts` is 529 lines. Task 2 adds at most 6 lines. If `check:file-sizes` fails, move `createRunSenders` into a new `src/operations/call-run-senders.ts`, unchanged, in the same commit.

---

### Task 1: The call's abort signal reaches the agent turn

**Why:** `buildRunDispatchOptions` never sets `abortSignal`. Each hop sends its turn with `signal: resolvedRunOptions.abortSignal` (`build-hop-callback-dispatch.ts:143`), which is therefore `undefined`. Finish's deadline only takes effect after a hop returns (`call-dispatch-run.ts:191`). This matches the logs: lenses report "aborted" 7.5 min after the deadline.

**Files:**
- Modify: `src/operations/call-run-options.ts`
- Modify: `src/operations/call-dispatch-run.ts:112-124`
- Test: `test/unit/operations/call-run-options.test.ts`

**Interfaces:**
- Produces: `RunDispatchOptionsParams.abortSignal?: AbortSignal`. `buildRunDispatchOptions(...)` returns `{ ..., abortSignal }` when given.

- [ ] **Step 1: Write the failing test.** Append to `test/unit/operations/call-run-options.test.ts`:

```ts
describe("buildRunDispatchOptions — abort signal (finish A, #2462)", () => {
  test("threads the call's abort signal onto the run options so each hop's turn receives it", () => {
    const config = makeNaxConfig();
    const runtime = makeTestRuntime({ config, workdir: "/repo" });
    createdRuntimes.push(runtime);
    const ctx: CallContext = {
      runtime,
      packageView: runtime.packages.resolve("packages/api"),
      packageDir: "packages/api",
      config,
      agentName: "claude",
    };
    const controller = new AbortController();
    const result = buildRunDispatchOptions(ctx, {
      prompt: "hi",
      effectiveTier: "balanced",
      dispatchModelDef: { provider: "claude", model: "sonnet" },
      config,
      callId: "call-1",
      pipelineStage: "run",
      declaredTools: ["Read"],
      keepOpen: false,
      abortSignal: controller.signal,
    });
    expect(result.abortSignal).toBe(controller.signal);
  });

  test("omits abortSignal when none is given", () => {
    const config = makeNaxConfig();
    const runtime = makeTestRuntime({ config, workdir: "/repo" });
    createdRuntimes.push(runtime);
    const ctx: CallContext = {
      runtime,
      packageView: runtime.packages.resolve("packages/api"),
      packageDir: "packages/api",
      config,
      agentName: "claude",
    };
    const result = buildRunDispatchOptions(ctx, {
      prompt: "hi",
      effectiveTier: "balanced",
      dispatchModelDef: { provider: "claude", model: "sonnet" },
      config,
      callId: "call-1",
      pipelineStage: "run",
      declaredTools: ["Read"],
      keepOpen: false,
    });
    expect("abortSignal" in result).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails.**
Run: `bun test test/unit/operations/call-run-options.test.ts --timeout=30000`
Expected: FAIL. A typecheck-level error on the unknown `abortSignal` param, or `expected undefined to be AbortSignal`.

- [ ] **Step 3: Implement.** In `src/operations/call-run-options.ts`, add the field to `RunDispatchOptionsParams` after `keepOpen`:

```ts
  /**
   * The call's abort signal (`ctx.signal ?? ctx.runtime.signal`, resolved in the
   * dispatch prologue). Threaded onto the run options because every hop sends its
   * turn with `resolvedRunOptions.abortSignal`; without it a deadline only lands
   * after the hop returns (#2462).
   */
  readonly abortSignal?: AbortSignal;
```

Destructure it (`keepOpen,` → `keepOpen, abortSignal,`) and add this as the last entry of the returned object:

```ts
    ...(abortSignal !== undefined ? { abortSignal } : {}),
```

In `src/operations/call-dispatch-run.ts`, inside the `buildRunDispatchOptions(ctx, { ... })` call (~L112), add `abortSignal,` after `keepOpen,`. `abortSignal` is already destructured from `prologue` on L91.

- [ ] **Step 4: Run the test and the dispatch suites.**
Run: `bun test test/unit/operations/call-run-options.test.ts test/unit/operations/ --timeout=30000`
Expected: PASS. Fix any existing test that asserted the exact run-options shape by adding `abortSignal` where its context had a signal.

- [ ] **Step 5: Run the agent-manager and finish suites.** Every run-kind op now receives the run's signal in-turn, which is the intent documented on `CallContext.signal`.
Run: `bun test test/unit/agents/ test/unit/session/ test/unit/finish/ --timeout=30000`
Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git add src/operations/call-run-options.ts src/operations/call-dispatch-run.ts test/unit/operations/call-run-options.test.ts
git commit -m "fix(operations): thread the call's abort signal into each hop's turn (#2462)"
```

---

### Task 2: Per-turn signal override on a hop's `send`

**Why:** the handoff turn (Task 5) must run after the fix turn was aborted, on the same session, under its own 2-minute signal.

**Files:**
- Modify: `src/operations/types.ts` (`HopBodyContext`, ~L213)
- Modify: `src/operations/build-hop-callback.ts:112-115`
- Modify: `src/operations/build-hop-callback-dispatch.ts:129-143`
- Modify: `src/operations/call-dispatch-run.ts` (`createRunSenders`, L244-356)
- Test: `test/unit/operations/build-hop-callback-dispatch.test.ts` (create if absent; reuse that directory's existing hop-callback test helpers)

**Interfaces:**
- Produces:
  - `export interface SendTurnOverrides { readonly signal?: AbortSignal }` in `src/operations/types.ts`, exported from the `@/operations` barrel.
  - `HopBodyContext.send: (prompt: string, opts?: SendTurnOverrides) => Promise<TurnResult>`.
  - `sendWithParseRetry` is unchanged (no override).

- [ ] **Step 1: Write the failing test.** Find the existing test that drives `dispatchHopTurn` with a fake `agentManager.runAsSession`:
`grep -rln "dispatchHopTurn\|buildHopCallback" test/unit/operations`
Add a case to that file, reusing its fixture builder (named `makeHopInput` below; use whatever the file calls it):

```ts
test("send(prompt, { signal }) overrides the run options' abort signal for that turn only", async () => {
  const seen: (AbortSignal | undefined)[] = [];
  const runSignal = new AbortController().signal;
  const override = new AbortController().signal;
  const input = makeHopInput({
    resolvedRunOptions: { abortSignal: runSignal },
    runAsSession: async (_agent, _handle, _prompt, opts) => {
      seen.push(opts.signal);
      return makeTurnResult({ output: "ok" });
    },
    hopBody: async (initial, ctx) => {
      await ctx.send(initial);
      return ctx.send("second", { signal: override });
    },
  });
  await dispatchHopTurn(input);
  expect(seen).toEqual([runSignal, override]);
});
```

- [ ] **Step 2: Run it to verify it fails.**
Run: `bun test test/unit/operations/<that file> --timeout=30000`
Expected: FAIL (`seen[1]` is `runSignal`), or a type error on the second argument.

- [ ] **Step 3: Implement.**

In `src/operations/types.ts`, above `HopBodyContext`:

```ts
/** Per-turn overrides a hop body may pass to `send` (finish A: the handoff turn after a stopped fix turn). */
export interface SendTurnOverrides {
  /** Replaces the hop's abort signal for this one turn. */
  readonly signal?: AbortSignal;
}
```

Change the field in `HopBodyContext`:

```ts
  readonly send: (prompt: string, opts?: SendTurnOverrides) => Promise<TurnResult>;
```

In `src/operations/build-hop-callback.ts`, change the `hopBody` property type:

```ts
  hopBody?: <I = unknown>(
    initialPrompt: string,
    bodyCtx: { send: (prompt: string, opts?: SendTurnOverrides) => Promise<TurnResult>; input: I },
  ) => Promise<TurnResult>;
```

Import `SendTurnOverrides` with `import type { SendTurnOverrides } from "./types";`.

In `src/operations/build-hop-callback-dispatch.ts`, change the closure head and the signal line:

```ts
    const send = (turnPrompt: string, overrides?: SendTurnOverrides): Promise<TurnResult> =>
```

```ts
          signal: overrides?.signal ?? resolvedRunOptions.abortSignal,
```

Import the type the same way.

In `src/operations/call-dispatch-run.ts` (`createRunSenders`), widen every `bodyCtx` type from `{ send: (p: string) => Promise<TurnResult> ... }` to `{ send: (p: string, o?: SendTurnOverrides) => Promise<TurnResult> ... }`. Then thread the override through `sendWithFileOutput`:

```ts
  const sendWithFileOutput = (
    promptText: string,
    bodyCtx: { send: (p: string, o?: SendTurnOverrides) => Promise<TurnResult> },
    overrides?: SendTurnOverrides,
  ): Promise<TurnResult> =>
    normalizeHopOutput((p) => bodyCtx.send(p, overrides), promptText, {
      storyId: ctx.storyId,
      opName: op.name,
      dispatchAgent,
      fileOutputPath,
      readFileOutput: deps.readFileOutput,
    });
```

In `effectiveHopBody`, pass it on:

```ts
        send: (p, o) => sendWithFileOutput(p, bodyCtx, o),
```

- [ ] **Step 4: Run the tests.**
Run: `bun test test/unit/operations/ --timeout=30000 && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Check the file-size ratchet.**
Run: `bun run check:file-sizes`
Expected: PASS. If `call-dispatch-run.ts` exceeds 600 lines, move `createRunSenders` and its `RunSenderParams` type into `src/operations/call-run-senders.ts`, unchanged, and import it.

- [ ] **Step 6: Commit.**

```bash
git add src/operations test/unit/operations
git commit -m "feat(operations): per-turn signal override on a hop body's send"
```

---

### Task 3: Finish timeouts config (`reviewMs`, `fixMs`, `flowMs` 3 h, `stepMs` shim)

**Files:**
- Create: `src/config/finish-timeouts-shim.ts`
- Modify: `src/config/compat-shims.ts` (import + one line in `applyConfigCompatShims`)
- Modify: `src/config/schemas.ts:455-479`
- Modify: `src/config/runtime-types-finish.ts:15`
- Modify: `src/config/selectors.ts` (~L148 comment)
- Modify: `src/finish/config.ts:36,46,95-100`
- Modify: `src/operations/finish-fix.ts:41` (comment only)
- Modify: `docs/guides/configuration.md`
- Test: `test/unit/config/finish-timeouts-shim.test.ts` (create)
- Test: `test/unit/finish/config.test.ts`

**Interfaces:**
- Produces:
  - `FinishSettings["timeouts"] = { acceptanceMs: number; gateMs: number; flowMs: number; reviewMs: number; fixMs: number }`
  - `export function _applyFinishStepTimeoutShim(conf: Record<string, unknown>, warn: (msg: string) => void): Record<string, unknown>`

- [ ] **Step 1: Write the failing shim test.** Create `test/unit/config/finish-timeouts-shim.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { _applyFinishStepTimeoutShim } from "@/config/finish-timeouts-shim";

describe("_applyFinishStepTimeoutShim (finish A)", () => {
  test("copies a numeric stepMs into reviewMs and fixMs, drops stepMs and warns once", () => {
    const warnings: string[] = [];
    const out = _applyFinishStepTimeoutShim({ finish: { timeouts: { stepMs: 600_000, gateMs: 1 } } }, (m) =>
      warnings.push(m),
    );
    expect(out).toEqual({ finish: { timeouts: { gateMs: 1, reviewMs: 600_000, fixMs: 600_000 } } });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("finish.timeouts.stepMs");
  });

  test("an explicit reviewMs / fixMs wins over stepMs", () => {
    const out = _applyFinishStepTimeoutShim(
      { finish: { timeouts: { stepMs: 600_000, reviewMs: 1_000 } } },
      () => {},
    );
    expect(out).toEqual({ finish: { timeouts: { reviewMs: 1_000, fixMs: 600_000 } } });
  });

  test("a null stepMs is dropped silently", () => {
    const warnings: string[] = [];
    const out = _applyFinishStepTimeoutShim({ finish: { timeouts: { stepMs: null } } }, (m) => warnings.push(m));
    expect(out).toEqual({ finish: { timeouts: {} } });
    expect(warnings).toHaveLength(0);
  });

  test("returns the same object when there is no stepMs", () => {
    const conf = { finish: { timeouts: { gateMs: 1 } } };
    expect(_applyFinishStepTimeoutShim(conf, () => {})).toBe(conf);
  });

  test("does not mutate the input", () => {
    const conf = { finish: { timeouts: { stepMs: 5 } } };
    _applyFinishStepTimeoutShim(conf, () => {});
    expect(conf).toEqual({ finish: { timeouts: { stepMs: 5 } } });
  });
});
```

- [ ] **Step 2: Run it to verify it fails.**
Run: `bun test test/unit/config/finish-timeouts-shim.test.ts --timeout=30000`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the shim.** Create `src/config/finish-timeouts-shim.ts`:

```ts
/**
 * Finish A: `finish.timeouts.stepMs` became two keys, `reviewMs` and `fixMs`.
 *
 * A benign rename (config-patterns.md, "Migrating Deprecated Keys"): a numeric
 * `stepMs` fills whichever of the two is unset, then is removed. Runs per
 * config layer inside `applyConfigCompatShims`, so a global `stepMs` and a
 * project `reviewMs` combine as expected. Returns a new object; never mutates.
 */
export function _applyFinishStepTimeoutShim(
  conf: Record<string, unknown>,
  warn: (msg: string) => void,
): Record<string, unknown> {
  const finish = conf.finish as Record<string, unknown> | undefined;
  const timeouts = finish?.timeouts as Record<string, unknown> | undefined;
  if (!timeouts || !("stepMs" in timeouts)) return conf;
  const { stepMs, ...rest } = timeouts;
  if (typeof stepMs === "number") {
    warn(
      "finish.timeouts.stepMs is deprecated: it now sets finish.timeouts.reviewMs and finish.timeouts.fixMs " +
        "where those are unset. Set those two keys instead.",
    );
    return {
      ...conf,
      finish: {
        ...finish,
        timeouts: { ...rest, reviewMs: rest.reviewMs ?? stepMs, fixMs: rest.fixMs ?? stepMs },
      },
    };
  }
  return { ...conf, finish: { ...finish, timeouts: rest } };
}
```

In `src/config/compat-shims.ts`, import it and add one line after `_applyFinishAutoFlowShim` in `applyConfigCompatShims`:

```ts
import { _applyFinishStepTimeoutShim } from "./finish-timeouts-shim";
```

```ts
  out = _applyFinishStepTimeoutShim(out, warn);
```

- [ ] **Step 4: Run the shim test.**
Run: `bun test test/unit/config/finish-timeouts-shim.test.ts --timeout=30000`
Expected: PASS.

- [ ] **Step 5: Write the failing settings test.** Append to `test/unit/finish/config.test.ts`:

```ts
describe("readFinishConfig timeouts (finish A)", () => {
  test("defaults: review 15 min, fix 20 min, flow 3 h, acceptance and gate unchanged", () => {
    const s = readFinishConfig(NaxConfigSchema.parse({}));
    expect(s.timeouts).toEqual({
      acceptanceMs: 600_000,
      gateMs: 900_000,
      flowMs: 10_800_000,
      reviewMs: 900_000,
      fixMs: 1_200_000,
    });
  });

  test("explicit values win", () => {
    const s = readFinishConfig(
      NaxConfigSchema.parse({ finish: { timeouts: { reviewMs: 1_000, fixMs: 2_000, flowMs: 3_000 } } }),
    );
    expect(s.timeouts.reviewMs).toBe(1_000);
    expect(s.timeouts.fixMs).toBe(2_000);
    expect(s.timeouts.flowMs).toBe(3_000);
  });
});
```

Import `NaxConfigSchema` from `@/config` if the file does not already.

- [ ] **Step 6: Run it to verify it fails.**
Run: `bun test test/unit/finish/config.test.ts --timeout=30000`
Expected: FAIL (`flowMs` is `5_400_000`; no `reviewMs`).

- [ ] **Step 7: Implement the schema and reader.** In `src/config/schemas.ts`, replace the `timeouts` object and both default literals:

```ts
        timeouts: z
          .object({
            /** Per acceptance-test group. */
            acceptanceMs: z.number().int().positive().default(600_000),
            /** Per quality gate (build / typecheck / lint / test). */
            gateMs: z.number().int().positive().default(900_000),
            /** Whole-phase backstop, enforced as an AbortSignal (finish A: 3 h). */
            flowMs: z.number().int().positive().default(10_800_000),
            /** Per review lens call (finish A). */
            reviewMs: z.number().int().positive().default(900_000),
            /** Per fix session: acceptance, review or gate fix (finish A). */
            fixMs: z.number().int().positive().default(1_200_000),
          })
          .default({ acceptanceMs: 600_000, gateMs: 900_000, flowMs: 10_800_000, reviewMs: 900_000, fixMs: 1_200_000 }),
```

In the outer `.default({...})` of `finish`, set `timeouts: { acceptanceMs: 600_000, gateMs: 900_000, flowMs: 10_800_000, reviewMs: 900_000, fixMs: 1_200_000 }`.

In `src/config/runtime-types-finish.ts`, replace `stepMs: number | null;` with:

```ts
  reviewMs: number;
  fixMs: number;
```

In `src/finish/config.ts`:
- The type becomes `timeouts: { acceptanceMs: number; gateMs: number; flowMs: number; reviewMs: number; fixMs: number };`.
- `DEFAULTS.timeouts` becomes `{ acceptanceMs: 600_000, gateMs: 900_000, flowMs: 10_800_000, reviewMs: 900_000, fixMs: 1_200_000 }`.
- In the reader, replace the `stepMs` line with:

```ts
      reviewMs: finish.timeouts?.reviewMs ?? DEFAULTS.timeouts.reviewMs,
      fixMs: finish.timeouts?.fixMs ?? DEFAULTS.timeouts.fixMs,
```

In `src/config/selectors.ts` (~L148) and `src/operations/finish-fix.ts:41`, change the comment text `finish.timeouts.stepMs` to `finish.timeouts.reviewMs / fixMs`.

In `src/finish/phase.ts` (~L394-397), replace both `settings.timeouts.stepMs ?? undefined` with `settings.timeouts.reviewMs` and `settings.timeouts.fixMs`.

- [ ] **Step 8: Run the config, finish and phase suites.**
Run: `bun test test/unit/config/ test/unit/finish/ --timeout=30000 && bun run typecheck`
Expected: PASS. Update any test literal that used `stepMs: null` or `flowMs: 5_400_000` to the new shape.

- [ ] **Step 9: Update the docs.** In `docs/guides/configuration.md` (repo root), replace the `finish.timeouts` rows:

```markdown
| `finish.timeouts.acceptanceMs` | `600000` | Per acceptance-test group run. |
| `finish.timeouts.gateMs` | `900000` | Per quality gate command. |
| `finish.timeouts.reviewMs` | `900000` | Per review lens call. When it fires, that lens counts as missing for the round. |
| `finish.timeouts.fixMs` | `1200000` | Per fix session. When it fires, the session's edits are set aside with a handoff and the next attempt continues from it. |
| `finish.timeouts.flowMs` | `10800000` | Whole finish phase, a backstop. When it fires, the current step stops and finish ends as a draft PR. |
| `finish.timeouts.stepMs` | — | Deprecated: sets `reviewMs` and `fixMs` where unset. |
```

Match the table's existing column layout. If the file lists the keys in prose instead, follow that style.

- [ ] **Step 10: Commit.**

```bash
git add src/config src/finish/config.ts src/finish/phase.ts src/operations/finish-fix.ts test/unit/config test/unit/finish/config.test.ts ../../docs/guides/configuration.md
git commit -m "feat(finish): reviewMs / fixMs step limits, 3 h flow backstop, stepMs shim"
```

---

### Task 4: Review lenses stop at `reviewMs`

**Files:**
- Create: `src/finish/step-signal.ts`
- Modify: `src/finish/types.ts` (`FinishReviewOutput`, `FinishTimeouts`)
- Modify: `src/finish/ops-impl.ts` (`reviewSpec`, `reviewBranch`)
- Test: `test/unit/finish/step-signal.test.ts` (create)
- Test: `test/unit/finish/ops-impl-a4.test.ts`

**Interfaces:**
- Produces:
  - `stepSignal(base: AbortSignal | undefined, ms: number | undefined): { signal: AbortSignal | undefined; limit: AbortSignal | undefined }`. `limit` is the timeout part alone, so callers can tell a step stop from a phase stop.
  - `FinishReviewOutput.stoppedAtLimit?: true`.
  - `FinishTimeouts` gains `reviewMs?: number; fixMs?: number`.

- [ ] **Step 1: Write the failing test.** Create `test/unit/finish/step-signal.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { stepSignal } from "@/finish/step-signal";

describe("stepSignal (finish A)", () => {
  test("no base and no limit gives no signal", () => {
    expect(stepSignal(undefined, undefined)).toEqual({ signal: undefined, limit: undefined });
  });

  test("the base alone is returned as-is", () => {
    const base = new AbortController().signal;
    expect(stepSignal(base, undefined)).toEqual({ signal: base, limit: undefined });
  });

  test("the combined signal aborts when the base aborts, and the limit does not", () => {
    const base = new AbortController();
    const { signal, limit } = stepSignal(base.signal, 60_000);
    base.abort();
    expect(signal?.aborted).toBe(true);
    expect(limit?.aborted).toBe(false);
  });

  test("an already-aborted base gives an already-aborted signal", () => {
    const base = new AbortController();
    base.abort();
    expect(stepSignal(base.signal, 60_000).signal?.aborted).toBe(true);
  });
});
```

Add a case to `test/unit/finish/ops-impl-a4.test.ts`, using its existing `_finishOpsDeps.callOp` stub pattern:

```ts
test("a review lens that hits reviewMs returns a missing verdict flagged stoppedAtLimit", async () => {
  _finishOpsDeps.callOp = (async (ctx: { signal?: AbortSignal }) => {
    await new Promise<void>((resolve) => ctx.signal?.addEventListener("abort", () => resolve(), { once: true }));
    throw new Error("callOp[finish-spec-review]: aborted");
  }) as typeof _finishOpsDeps.callOp;
  const { deps } = baseDeps();
  const ops = createFinishOps({ ...deps, timeouts: { reviewMs: 5, fixMs: 5 } });
  const out = await ops.reviewSpec(freshState(), inputs);
  expect(out.missing).toBe(true);
  expect(out.stoppedAtLimit).toBe(true);
});

test("a phase stop during review is not a step limit: the error propagates", async () => {
  const phase = new AbortController();
  _finishOpsDeps.callOp = (async () => {
    phase.abort();
    throw new Error("callOp[finish-spec-review]: aborted");
  }) as typeof _finishOpsDeps.callOp;
  const { deps } = baseDeps();
  const ops = createFinishOps({ ...deps, callCtx: { ...deps.callCtx, signal: phase.signal }, timeouts: { reviewMs: 60_000 } });
  await expect(ops.reviewSpec(freshState(), inputs)).rejects.toThrow("aborted");
});
```

`baseDeps`, `freshState` and `inputs` are the file's existing helpers (top of `ops-impl-a4.test.ts`).

- [ ] **Step 2: Run them to verify they fail.**
Run: `bun test test/unit/finish/step-signal.test.ts test/unit/finish/ops-impl-a4.test.ts --timeout=30000`
Expected: FAIL (module not found; the review case throws).

- [ ] **Step 3: Implement.** Create `src/finish/step-signal.ts`:

```ts
/**
 * Finish A: a step's signal is the phase signal plus the step's own limit.
 * `limit` is returned separately so a caller can tell "this step hit its
 * limit" (continue the loop) from "the phase was stopped" (finalize a draft).
 * `AbortSignal.timeout` rather than `setTimeout`: nothing to clear, and an
 * already-aborted base stays aborted through `AbortSignal.any`.
 */
export function stepSignal(
  base: AbortSignal | undefined,
  ms: number | undefined,
): { signal: AbortSignal | undefined; limit: AbortSignal | undefined } {
  const limit = ms !== undefined ? AbortSignal.timeout(ms) : undefined;
  if (!limit) return { signal: base, limit: undefined };
  return { signal: base ? AbortSignal.any([base, limit]) : limit, limit };
}
```

In `src/finish/types.ts`, add to `FinishReviewOutput`:

```ts
  /** Finish A: the lens was stopped by `finish.timeouts.reviewMs`; always paired with `missing`. */
  stoppedAtLimit?: true;
```

and extend `FinishTimeouts`:

```ts
export interface FinishTimeouts {
  acceptanceMs?: number;
  gateMs?: number;
  reviewMs?: number;
  fixMs?: number;
}
```

In `src/finish/ops-impl.ts`, import `stepSignal` and `MISSING_REVIEW` (from `./review-json`), and add a helper above `createFinishOps`:

```ts
/** Runs one review call under its `reviewMs` limit; a stop at the limit reads as a missing verdict. */
async function underReviewLimit(
  callCtx: CallContext,
  reviewMs: number | undefined,
  run: (ctx: CallContext) => Promise<FinishReviewOutput>,
): Promise<FinishReviewOutput> {
  const { signal, limit } = stepSignal(callCtx.signal, reviewMs);
  try {
    return await run(signal ? { ...callCtx, signal } : callCtx);
  } catch (err) {
    if (limit?.aborted && !callCtx.signal?.aborted) return { ...MISSING_REVIEW, stoppedAtLimit: true };
    throw err;
  }
}
```

Wrap both review calls:

```ts
      return underReviewLimit(callCtx, timeouts?.reviewMs, (ctx) =>
        _finishOpsDeps.callOp({ ...ctx, sessionOverride: { role: "finish-review-spec" } }, finishSpecReviewOp, input),
      );
```

Do the same for `reviewBranch` with `finish-review-quality` and `finishBranchReviewOp`. Import `FinishReviewOutput` from `./types` and `CallContext` from `@/operations` as types.

- [ ] **Step 4: Run the tests.**
Run: `bun test test/unit/finish/ --timeout=30000`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/finish/step-signal.ts src/finish/types.ts src/finish/ops-impl.ts test/unit/finish/step-signal.test.ts test/unit/finish/ops-impl-a4.test.ts
git commit -m "feat(finish): review lenses stop at reviewMs and report stoppedAtLimit"
```

---

### Task 5: The handoff turn inside the fix op

**Files:**
- Modify: `src/prompts/builders/finish-review-builder.ts` (add `buildFinishHandoffPrompt`; continuation section)
- Modify: `src/prompts/index.ts` (export)
- Modify: `src/operations/finish-fix.ts` (input fields, `hopBody`, `_finishFixDeps`)
- Modify: `src/finish/types.ts` (`HandoffNote`, `FixContinuation`)
- Test: `test/unit/operations/finish-fix.test.ts` (create or extend)
- Test: `test/unit/prompts/finish-review-builder.test.ts` (extend the existing builder test, if any)

**Interfaces:**
- Consumes: `SendTurnOverrides` (Task 2).
- Produces:
  - `export const HANDOFF_TURN_MS = 120_000` (in `src/operations/finish-fix.ts`, exported via the barrel).
  - `FinishFixInput` gains `stopSignal?: AbortSignal; handoffPath?: string; continuation?: FixContinuation`.
  - `export interface FixContinuation { note?: HandoffNote; files: string[] }` in `src/finish/types.ts`.
  - `export interface HandoffNote { findings: { index: number; status: "done" | "partial" | "not-started"; files: string[]; remaining: string }[] }` in `src/finish/types.ts`.
  - `buildFinishHandoffPrompt(phase: "acceptance" | "gate" | "review", findings: Finding[] | undefined): string`.
  - `buildFinishFixPrompt(phase, args)`: `args` gains `continuation?: FixContinuation`.
  - `export const _finishFixDeps = { write: (path: string, text: string) => Promise<void> }`.

- [ ] **Step 1: Write the failing op test.** Create `test/unit/operations/finish-fix.test.ts`:

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { makeTurnResult } from "@test/helpers";
import { _finishFixDeps, finishFixOp, HANDOFF_TURN_MS } from "@/operations/finish-fix";

const originalWrite = _finishFixDeps.write;
afterEach(() => {
  _finishFixDeps.write = originalWrite;
});

function hopCtx(input: Record<string, unknown>, send: (p: string, o?: { signal?: AbortSignal }) => Promise<unknown>) {
  return { send, sendWithParseRetry: send, input } as never;
}

describe("finishFixOp hopBody (finish A handoff)", () => {
  test("a normal turn is returned unchanged and no handoff is written", async () => {
    const writes: string[] = [];
    _finishFixDeps.write = async (p) => void writes.push(p);
    const turn = makeTurnResult({ output: "## DISPOSITIONS\n1. fixed" });
    const out = await finishFixOp.hopBody?.("fix it", hopCtx({ phase: "review" }, async () => turn));
    expect(out).toBe(turn);
    expect(writes).toEqual([]);
  });

  test("a stopped turn sends one handoff prompt under its own 2-minute signal, writes the reply, then rethrows", async () => {
    const stop = new AbortController();
    const sent: { prompt: string; signal?: AbortSignal }[] = [];
    const written: { path: string; text: string }[] = [];
    _finishFixDeps.write = async (path, text) => void written.push({ path, text });
    const send = async (prompt: string, o?: { signal?: AbortSignal }) => {
      sent.push({ prompt, signal: o?.signal });
      if (sent.length === 1) {
        stop.abort();
        throw new DOMException("aborted", "AbortError");
      }
      return makeTurnResult({ output: '{"findings":[]}' });
    };
    const input = { phase: "review", stopSignal: stop.signal, handoffPath: "/a/note.raw.txt", findings: [] };
    await expect(finishFixOp.hopBody?.("fix it", hopCtx(input, send))).rejects.toThrow("aborted");
    expect(sent).toHaveLength(2);
    expect(sent[1].prompt).toContain("Stop working");
    expect(sent[1].signal?.aborted).toBe(false);
    expect(written).toEqual([{ path: "/a/note.raw.txt", text: '{"findings":[]}' }]);
    expect(HANDOFF_TURN_MS).toBe(120_000);
  });

  test("a failing handoff turn still rethrows the original abort and writes nothing", async () => {
    const stop = new AbortController();
    const written: string[] = [];
    _finishFixDeps.write = async (p) => void written.push(p);
    let calls = 0;
    const send = async () => {
      calls += 1;
      if (calls === 1) stop.abort();
      throw new DOMException(calls === 1 ? "aborted" : "handoff failed", "AbortError");
    };
    const input = { phase: "review", stopSignal: stop.signal, handoffPath: "/a/note.raw.txt" };
    await expect(finishFixOp.hopBody?.("fix it", hopCtx(input, send))).rejects.toThrow("aborted");
    expect(written).toEqual([]);
  });

  test("an error that is not a stop is rethrown without a handoff turn", async () => {
    let calls = 0;
    const send = async () => {
      calls += 1;
      throw new Error("model exploded");
    };
    const input = { phase: "review", stopSignal: new AbortController().signal, handoffPath: "/a/n" };
    await expect(finishFixOp.hopBody?.("fix it", hopCtx(input, send))).rejects.toThrow("model exploded");
    expect(calls).toBe(1);
  });
});
```

- [ ] **Step 2: Write the failing prompt test.** Add to the finish builder's test file (`grep -rln buildFinishFixPrompt test/unit/prompts`, or create `test/unit/prompts/finish-handoff-prompt.test.ts`):

```ts
import { describe, expect, test } from "bun:test";
import { buildFinishFixPrompt, buildFinishHandoffPrompt } from "@/prompts";

describe("finish handoff prompts (finish A)", () => {
  test("the handoff prompt forbids edits and asks for per-finding JSON", () => {
    const p = buildFinishHandoffPrompt("review", [
      { severity: "HIGH", title: "A", problem: "p", fix: "f", file: "src/a.ts" },
    ]);
    expect(p).toContain("Stop working");
    expect(p).toContain("Do not edit");
    expect(p).toContain('"status": "done" | "partial" | "not-started"');
    expect(p).toContain("1. [HIGH] A (src/a.ts)");
  });

  test("a continuation adds a section listing the earlier note and changed files", () => {
    const p = buildFinishFixPrompt("review", {
      findings: [{ severity: "LOW", title: "A", problem: "p", fix: "f" }],
      continuation: {
        files: ["src/a.ts"],
        note: { findings: [{ index: 1, status: "partial", files: ["src/a.ts"], remaining: "update the test" }] },
      },
    });
    expect(p).toContain("## Continuing earlier work");
    expect(p).toContain("src/a.ts");
    expect(p).toContain("1: partial — update the test");
  });

  test("a continuation without a note says so", () => {
    const p = buildFinishFixPrompt("gate", { gateOutput: "x", continuation: { files: ["b.ts"] } });
    expect(p).toContain("No handoff note was recorded");
  });
});
```

- [ ] **Step 3: Run them to verify they fail.**
Run: `bun test test/unit/operations/finish-fix.test.ts test/unit/prompts/ --timeout=30000`
Expected: FAIL (no `hopBody`, no `_finishFixDeps`, no `buildFinishHandoffPrompt`).

- [ ] **Step 4: Implement the types.** In `src/finish/types.ts`:

```ts
/** Finish A: what a stopped fix session reported in its handoff turn. */
export interface HandoffNote {
  findings: { index: number; status: "done" | "partial" | "not-started"; files: string[]; remaining: string }[];
}

/** Finish A: a fix attempt that continues a set-aside one. */
export interface FixContinuation {
  /** The earlier session's handoff note, when it gave one. */
  note?: HandoffNote;
  /** Files the re-applied patch already changed. */
  files: string[];
}
```

- [ ] **Step 5: Implement the prompts.** In `src/prompts/builders/finish-review-builder.ts`, add below `buildFinishFixPrompt` (use the module's existing `Finding` import):

```ts
function numberedFindings(findings: Finding[]): string {
  return findings
    .map((f, i) => `${i + 1}. [${f.severity}] ${f.title}${f.file ? ` (${f.file})` : ""}`)
    .join("\n");
}

/** Finish A: the one turn a stopped fix session gets to say what it did. */
export function buildFinishHandoffPrompt(
  phase: "acceptance" | "gate" | "review",
  findings: Finding[] | undefined,
): string {
  const scope =
    phase === "review" && findings && findings.length > 0
      ? `The findings you were given, by number:\n${numberedFindings(findings)}`
      : `You were fixing the failing ${phase === "gate" ? "repo checks" : "acceptance tests"}; report them as finding 1.`;
  return [
    "Stop working: your time limit was reached. Do not edit any file and do not run any command.",
    scope,
    "Reply with only this JSON:",
    '{ "findings": [ { "index": 1, "status": "done" | "partial" | "not-started", "files": ["path"], "remaining": "what is left" } ] }',
  ].join("\n\n");
}

function continuationSection(c: FixContinuation): string {
  const head = `## Continuing earlier work\nAn earlier attempt was stopped. Its edits are already applied to these files:\n${c.files.map((f) => `- ${f}`).join("\n")}`;
  if (!c.note) return `${head}\n\nNo handoff note was recorded. Check those files before changing them again.`;
  const lines = c.note.findings.map((n) => `- ${n.index}: ${n.status} — ${n.remaining}`);
  return `${head}\n\nIts handoff note, per finding:\n${lines.join("\n")}\n\nFinish what is left; do not redo what is done.`;
}
```

Then change `buildFinishFixPrompt` to append the section when present:

```ts
export function buildFinishFixPrompt(
  phase: "acceptance" | "gate" | "review",
  args: { findings?: Finding[]; gateOutput?: string; acceptanceOutput?: string; continuation?: FixContinuation },
): string {
  const base = phase === "review" ? buildReviewFixPrompt(args.findings ?? []) : buildPhaseFixPrompt(phase, args);
  return args.continuation ? `${base}\n\n${continuationSection(args.continuation)}` : base;
}

function buildPhaseFixPrompt(phase: "acceptance" | "gate", args: { gateOutput?: string; acceptanceOutput?: string }): string {
  const detail = phase === "gate" ? (args.gateOutput ?? "") : (args.acceptanceOutput ?? "");
  return [
    `Fix the failing ${phase === "gate" ? "repo checks" : "acceptance tests"} below, directly in the repo.`,
    NO_COMMIT,
    `Output:\n${detail}`,
    "After fixing, re-run them; stop when they pass.",
  ].join("\n\n");
}
```

Import `FixContinuation` as a type from `../../finish/types`, the same way the file already imports `Finding`. Export `buildFinishHandoffPrompt` from `src/prompts/index.ts` next to `buildFinishFixPrompt`.

- [ ] **Step 6: Implement the op.** In `src/operations/finish-fix.ts`:

```ts
import { writeFile } from "node:fs/promises";
import { buildFinishFixPrompt, buildFinishHandoffPrompt } from "@/prompts";
import type { FixContinuation } from "../finish/types";

/** Finish A: the handoff turn's own cap; independent of the stopped fix's signal. */
export const HANDOFF_TURN_MS = 120_000;

/** Injectable so tests never touch disk. */
export const _finishFixDeps = {
  write: async (path: string, text: string): Promise<void> => {
    await writeFile(path, text, "utf8");
  },
};
```

Extend `FinishFixInput`:

```ts
  /** Finish A: aborted when the step's `fixMs` limit or the phase deadline fires. */
  stopSignal?: AbortSignal;
  /** Finish A: where the handoff turn's raw reply is written. The directory must exist. */
  handoffPath?: string;
  /** Finish A: an earlier set-aside attempt this one continues. */
  continuation?: FixContinuation;
```

Pass the continuation in `build`:

```ts
    const content = buildFinishFixPrompt(input.phase, {
      findings: input.findings,
      gateOutput: input.gateOutput,
      acceptanceOutput: input.acceptanceOutput,
      ...(input.continuation ? { continuation: input.continuation } : {}),
    });
```

Add `hopBody` to the op object, below `recover`:

```ts
  /**
   * Finish A: one fix turn. When the step is stopped mid-turn, the same session
   * gets one more turn under its own 2-minute signal, asking what it finished;
   * the raw reply is written to `handoffPath` before the original abort is
   * rethrown. Written to disk rather than returned because `callOp` throws on
   * an aborted call signal after the hop, which would drop a returned value.
   */
  async hopBody(initialPrompt, ctx) {
    try {
      return await ctx.send(initialPrompt);
    } catch (err) {
      const { stopSignal, handoffPath, phase, findings } = ctx.input;
      if (!stopSignal?.aborted || !handoffPath) throw err;
      const handoff = await ctx
        .send(buildFinishHandoffPrompt(phase, findings), { signal: AbortSignal.timeout(HANDOFF_TURN_MS) })
        .catch(() => null);
      if (handoff?.output) await _finishFixDeps.write(handoffPath, handoff.output).catch(() => undefined);
      throw err;
    }
  },
```

Add `"hopBody"` to the op's `RunOperationWithHooks` hook list: `"verify" | "recover" | "hopBody"`. If the type does not accept `hopBody` as a hook name, check how `acceptance-generate.ts:64` declares it and copy that form. Export `HANDOFF_TURN_MS` and `_finishFixDeps` from `src/operations/index.ts` next to `finishFixOp`.

- [ ] **Step 7: Run the tests.**
Run: `bun test test/unit/operations/finish-fix.test.ts test/unit/prompts/ test/unit/finish/ --timeout=30000 && bun run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit.**

```bash
git add src/operations/finish-fix.ts src/operations/index.ts src/prompts src/finish/types.ts test/unit/operations/finish-fix.test.ts test/unit/prompts
git commit -m "feat(finish): handoff turn when a fix session is stopped"
```

---

### Task 6: Set-aside, restore and re-apply

**Files:**
- Create: `src/finish/set-aside.ts`
- Modify: `src/finish/types.ts` (`HandoffRecord`)
- Modify: `src/finish/index.ts` (export)
- Test: `test/integration/finish/set-aside.test.ts` (create; uses a real temporary git repo)

**Interfaces:**
- Consumes: `HandoffNote` (Task 5), `AuditTarget` (`./audit`), `_finishGitDeps` (`./commit`), `parseLLMJson` from `@/utils/llm-json`.
- Produces:

```ts
export interface FixBase { baseSha: string; untrackedBefore: string[] }
export interface HandoffRecord {
  n: number;
  dir: string;                      // absolute path of handoff-<n>/
  phase: "acceptance" | "gate" | "review";
  limit: "fix" | "flow";
  baseSha: string;
  findingIds: string[];
  newUntracked: string[];
  stoppedAt: string;
  hasNote: boolean;
  patchSaved: boolean;
  consumed: boolean;
  reapplied?: boolean;              // set by Task 8
}
export function handoffDir(audit: AuditTarget, n: number): string;
export async function captureFixBase(workdir: string): Promise<FixBase | null>;
export async function setAside(args: {
  workdir: string; audit: AuditTarget; n: number; base: FixBase;
  phase: HandoffRecord["phase"]; limit: HandoffRecord["limit"]; findingIds: string[]; now: () => string;
}): Promise<HandoffRecord>;
export async function readHandoffNote(record: HandoffRecord): Promise<HandoffNote | undefined>;
export async function reapplyHandoff(workdir: string, record: HandoffRecord): Promise<{ applied: boolean; files: string[] }>;
export async function markHandoffConsumed(record: HandoffRecord): Promise<HandoffRecord>;
export const _setAsideDeps: { remove: (path: string) => Promise<void> };
```

- [ ] **Step 1: Write the failing integration test.** Create `test/integration/finish/set-aside.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withTempDir } from "@test/helpers";
import { captureFixBase, handoffDir, markHandoffConsumed, reapplyHandoff, setAside } from "@/finish/set-aside";

async function git(cwd: string, ...args: string[]): Promise<string> {
  const p = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  await p.exited;
  return new Response(p.stdout).text();
}

async function repo(dir: string): Promise<void> {
  await git(dir, "init", "-q");
  await git(dir, "config", "user.email", "t@t");
  await git(dir, "config", "user.name", "t");
  await writeFile(join(dir, "a.ts"), "export const a = 1;\n");
  await git(dir, "add", ".");
  await git(dir, "commit", "-q", "-m", "init");
}

const audit = (dir: string) => ({ auditDir: join(dir, ".audit"), runId: "run-1" });
const now = () => "2026-10-12T00:00:00.000Z";

describe("set-aside (finish A)", () => {
  test("saves tracked and new untracked changes, restores the tree, keeps pre-existing untracked files", async () => {
    await withTempDir(async (dir) => {
      await repo(dir);
      await writeFile(join(dir, ".env"), "SECRET=1\n"); // untracked before the session
      const base = await captureFixBase(dir);
      expect(base?.untrackedBefore).toContain(".env");
      // the fix session edits a tracked file and creates a new one
      await writeFile(join(dir, "a.ts"), "export const a = 2;\n");
      await writeFile(join(dir, "b.ts"), "export const b = 1;\n");
      const record = await setAside({
        workdir: dir,
        audit: audit(dir),
        n: 1,
        base: base!,
        phase: "review",
        limit: "fix",
        findingIds: ["quality|x|a.ts"],
        now,
      });
      expect(record.patchSaved).toBe(true);
      expect(record.newUntracked).toEqual(["b.ts"]);
      expect(await readFile(join(dir, "a.ts"), "utf8")).toBe("export const a = 1;\n");
      expect(existsSync(join(dir, "b.ts"))).toBe(false);
      expect(await readFile(join(dir, ".env"), "utf8")).toBe("SECRET=1\n");
      const patch = await readFile(join(handoffDir(audit(dir), 1), "changes.patch"), "utf8");
      expect(patch).toContain("export const a = 2;");
      expect(patch).toContain("b.ts");
      const meta = JSON.parse(await readFile(join(handoffDir(audit(dir), 1), "meta.json"), "utf8"));
      expect(meta).toMatchObject({ phase: "review", limit: "fix", findingIds: ["quality|x|a.ts"], consumed: false });
    });
  });

  test("parses note.raw.txt into note.json when the handoff turn wrote one", async () => {
    await withTempDir(async (dir) => {
      await repo(dir);
      const base = await captureFixBase(dir);
      await writeFile(join(dir, "a.ts"), "x\n");
      const hdir = handoffDir(audit(dir), 1);
      await Bun.write(join(hdir, "note.raw.txt"), 'sure: {"findings":[{"index":1,"status":"partial","files":["a.ts"],"remaining":"tests"}]}');
      const record = await setAside({ workdir: dir, audit: audit(dir), n: 1, base: base!, phase: "review", limit: "flow", findingIds: [], now });
      expect(record.hasNote).toBe(true);
      const note = JSON.parse(await readFile(join(hdir, "note.json"), "utf8"));
      expect(note.findings[0]).toMatchObject({ index: 1, status: "partial" });
    });
  });

  test("a malformed note is skipped, not fatal", async () => {
    await withTempDir(async (dir) => {
      await repo(dir);
      const base = await captureFixBase(dir);
      await Bun.write(join(handoffDir(audit(dir), 1), "note.raw.txt"), "not json at all");
      const record = await setAside({ workdir: dir, audit: audit(dir), n: 1, base: base!, phase: "gate", limit: "fix", findingIds: [], now });
      expect(record.hasNote).toBe(false);
    });
  });

  test("reapply restores the set-aside edits on the next attempt and lists the files", async () => {
    await withTempDir(async (dir) => {
      await repo(dir);
      const base = await captureFixBase(dir);
      await writeFile(join(dir, "a.ts"), "export const a = 3;\n");
      await writeFile(join(dir, "c.ts"), "c\n");
      const record = await setAside({ workdir: dir, audit: audit(dir), n: 1, base: base!, phase: "review", limit: "fix", findingIds: [], now });
      const out = await reapplyHandoff(dir, record);
      expect(out.applied).toBe(true);
      expect(out.files.sort()).toEqual(["a.ts", "c.ts"]);
      expect(await readFile(join(dir, "a.ts"), "utf8")).toBe("export const a = 3;\n");
      expect((await markHandoffConsumed(record)).consumed).toBe(true);
    });
  });

  test("a conflicting patch is not applied and leaves the tree clean", async () => {
    await withTempDir(async (dir) => {
      await repo(dir);
      const base = await captureFixBase(dir);
      await writeFile(join(dir, "a.ts"), "export const a = 4;\n");
      const record = await setAside({ workdir: dir, audit: audit(dir), n: 1, base: base!, phase: "review", limit: "fix", findingIds: [], now });
      // someone commits a conflicting change in between
      await writeFile(join(dir, "a.ts"), "totally different\n");
      await git(dir, "commit", "-qam", "conflict");
      const out = await reapplyHandoff(dir, record);
      expect(out.applied).toBe(false);
      expect((await git(dir, "status", "--porcelain")).trim()).toBe("");
    });
  });
});
```

If `withTempDir`'s callback signature differs, check `test/helpers/temp.ts` and adapt the wrapper only.

- [ ] **Step 2: Run it to verify it fails.**
Run: `bun test test/integration/finish/set-aside.test.ts --timeout=60000`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement.** Add `HandoffRecord` (shape above) to `src/finish/types.ts`. Create `src/finish/set-aside.ts`:

```ts
/**
 * Finish A §4: a stopped fix session's edits are set aside, never committed.
 *
 * At session start `captureFixBase` records HEAD and the untracked files that
 * already exist. On a stop, `setAside` saves the session's changes as a
 * patch (tracked diff plus files it created), parses the handoff turn's raw
 * note, writes `meta.json`, then restores tracked files to the base and
 * deletes only the files the session created. `git clean` is never used: a
 * user's own untracked files (`.env`, notes) must survive. Every step after
 * the snapshot is best-effort: a failure is logged and recorded on the
 * record, and never stops finish.
 */
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { errorMessage } from "@nathapp/nax-agent/internal";
import { getSafeLogger } from "@/logger";
import { tryParseLLMJson } from "@/utils/llm-json";
import type { AuditTarget } from "./audit";
import { _finishGitDeps } from "./commit";
import type { HandoffNote, HandoffRecord } from "./types";

export interface FixBase {
  baseSha: string;
  untrackedBefore: string[];
}

export const _setAsideDeps = {
  remove: (path: string): Promise<void> => unlink(path),
};

const PATCH = "changes.patch";
const RAW_NOTE = "note.raw.txt";
const NOTE = "note.json";
const META = "meta.json";

export function handoffDir(audit: AuditTarget, n: number): string {
  return join(audit.auditDir, `${audit.runId}.handoff-${n}`);
}

async function git(args: string[], cwd: string) {
  return _finishGitDeps.git(args, cwd);
}

async function untracked(workdir: string): Promise<string[]> {
  const res = await git(["status", "--porcelain=v1", "-uall"], workdir);
  if (res.exitCode !== 0) return [];
  return res.stdout
    .split("\n")
    .filter((l) => l.startsWith("?? "))
    .map((l) => l.slice(3).trim());
}

export async function captureFixBase(workdir: string): Promise<FixBase | null> {
  const head = await git(["rev-parse", "HEAD"], workdir);
  if (head.exitCode !== 0) return null;
  return { baseSha: head.stdout.trim(), untrackedBefore: await untracked(workdir) };
}

function isNote(value: unknown): value is HandoffNote {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { findings?: unknown }).findings)
  );
}

async function saveNote(dir: string): Promise<boolean> {
  const raw = await readFile(join(dir, RAW_NOTE), "utf8").catch(() => null);
  if (raw === null) return false;
  const parsed = tryParseLLMJson<unknown>(raw);
  if (!isNote(parsed)) return false;
  await writeFile(join(dir, NOTE), `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  return true;
}

/** Tracked diff against the base plus the files this session created, as one binary patch. */
async function savePatch(workdir: string, dir: string, baseSha: string, created: string[]): Promise<boolean> {
  if (created.length > 0) await git(["add", "-N", "--", ...created], workdir);
  const diff = await git(["diff", "--binary", baseSha], workdir);
  if (created.length > 0) await git(["reset", "-q", "--", ...created], workdir);
  if (diff.exitCode !== 0) return false;
  await writeFile(join(dir, PATCH), diff.stdout, "utf8");
  return true;
}

async function restore(workdir: string, baseSha: string, created: string[]): Promise<void> {
  await git(["restore", `--source=${baseSha}`, "--staged", "--worktree", "--", "."], workdir);
  for (const path of created) await _setAsideDeps.remove(join(workdir, path)).catch(() => undefined);
}

async function writeMeta(record: HandoffRecord): Promise<void> {
  await writeFile(join(record.dir, META), `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

export async function setAside(args: {
  workdir: string;
  audit: AuditTarget;
  n: number;
  base: FixBase;
  phase: HandoffRecord["phase"];
  limit: HandoffRecord["limit"];
  findingIds: string[];
  now: () => string;
}): Promise<HandoffRecord> {
  const dir = handoffDir(args.audit, args.n);
  const before = new Set(args.base.untrackedBefore);
  const created = (await untracked(args.workdir)).filter((p) => !before.has(p));
  const record: HandoffRecord = {
    n: args.n,
    dir,
    phase: args.phase,
    limit: args.limit,
    baseSha: args.base.baseSha,
    findingIds: args.findingIds,
    newUntracked: created,
    stoppedAt: args.now(),
    hasNote: false,
    patchSaved: false,
    consumed: false,
  };
  try {
    await mkdir(dir, { recursive: true });
    record.hasNote = await saveNote(dir).catch(() => false);
    record.patchSaved = await savePatch(args.workdir, dir, args.base.baseSha, created);
  } catch (err) {
    getSafeLogger()?.warn("finish", "Set-aside could not save the stopped session's work", {
      storyId: "_run",
      error: errorMessage(err),
    });
  }
  await restore(args.workdir, args.base.baseSha, created).catch((err) =>
    getSafeLogger()?.warn("finish", "Set-aside could not restore the worktree", {
      storyId: "_run",
      error: errorMessage(err),
    }),
  );
  await writeMeta(record).catch(() => undefined);
  return record;
}

export async function readHandoffNote(record: HandoffRecord): Promise<HandoffNote | undefined> {
  if (!record.hasNote) return undefined;
  const text = await readFile(join(record.dir, NOTE), "utf8").catch(() => null);
  const parsed = text ? tryParseLLMJson<unknown>(text) : null;
  return isNote(parsed) ? parsed : undefined;
}

/** Applies the saved patch with a 3-way merge; on any conflict restores the tree and reports not applied. */
export async function reapplyHandoff(
  workdir: string,
  record: HandoffRecord,
): Promise<{ applied: boolean; files: string[] }> {
  if (!record.patchSaved) return { applied: false, files: [] };
  const patchPath = join(record.dir, PATCH);
  const res = await git(["apply", "--3way", "--whitespace=nowarn", patchPath], workdir);
  if (res.exitCode !== 0) {
    await git(["reset", "-q", "--hard"], workdir);
    for (const path of record.newUntracked) await _setAsideDeps.remove(join(workdir, path)).catch(() => undefined);
    return { applied: false, files: [] };
  }
  await git(["reset", "-q"], workdir); // `--3way` stages; leave the edits unstaged like a live session's
  const names = await git(["apply", "--numstat", patchPath], workdir);
  const files = names.stdout
    .split("\n")
    .map((l) => l.split("\t")[2]?.trim())
    .filter((f): f is string => Boolean(f));
  return { applied: true, files };
}

export async function markHandoffConsumed(record: HandoffRecord): Promise<HandoffRecord> {
  const next = { ...record, consumed: true };
  await writeMeta(next).catch(() => undefined);
  return next;
}
```

`git reset --hard` in `reapplyHandoff` runs only when the 3-way apply failed. At that point the tree is at HEAD plus the failed apply's partial edits. Fix sessions only start on a clean tree, because every earlier fix either committed or was set aside. Note that invariant in the code comment.

Export `captureFixBase`, `setAside`, `reapplyHandoff`, `readHandoffNote`, `markHandoffConsumed`, `handoffDir`, the `FixBase` type and `_setAsideDeps` from `src/finish/index.ts`.

- [ ] **Step 4: Run it.**
Run: `bun test test/integration/finish/set-aside.test.ts --timeout=60000`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/finish/set-aside.ts src/finish/types.ts src/finish/index.ts test/integration/finish/set-aside.test.ts
git commit -m "feat(finish): set a stopped fix session's edits aside with a patch and handoff note"
```

---

### Task 7: `runFixStep`: the commit guard and set-aside on a stop, in all three loops

**Files:**
- Create: `src/finish/fix-step.ts`
- Modify: `src/finish/ops.ts` (`FixRequest`)
- Modify: `src/finish/ops-impl.ts` (`fix` passes `signal`, `handoffPath`, `continuation`)
- Modify: `src/finish/state.ts` (`stops`, `handoffs`, `pendingHandoff`; version stays 2 until Task 9)
- Modify: `src/finish/types.ts` (`Stop`)
- Modify: `src/finish/machine-deps.ts` (`timeouts` now carries `fixMs`)
- Modify: `src/finish/acceptance-loop.ts`, `src/finish/gates-loop.ts`, `src/finish/review-loop.ts` (call `runFixStep`)
- Modify: `src/finish/phase.ts` (pass `fixMs`, `reviewMs` into machine `timeouts`)
- Modify: `test/helpers/finish-machine.ts` (git model: `restore`, `diff`, `apply`, `add -N`, `reset`)
- Test: `test/unit/finish/fix-step.test.ts` (create)
- Test: `test/unit/finish/machine-loops.test.ts` (extend)

**Interfaces:**
- Consumes: `stepSignal` (Task 4), `captureFixBase`, `setAside`, `handoffDir` (Task 6), `HANDOFF` input fields (Task 5).
- Produces:

```ts
// types.ts
export interface Stop {
  kind: "review" | "fix" | "flow";
  phase?: "acceptance" | "gate" | "review";
  lens?: ReviewLens;
  at: string;
  limitMs: number;
  handoff?: number;      // HandoffRecord.n
  findings?: number;     // review fix: how many findings it held
}
// ops.ts FixRequest gains:
  signal?: AbortSignal;
  handoffPath?: string;
  continuation?: FixContinuation;
// fix-step.ts
export type FixStepResult =
  | { kind: "done"; outcome: FixOutcome; continued?: HandoffRecord }
  | { kind: "failed"; error: unknown }
  | { kind: "stopped"; handoff: HandoffRecord };
export interface FixStepDeps {
  ops: FinishOps;
  audit: AuditTarget;
  now: () => string;
  /** The phase signal (`FinishMachineDeps.signal`). */
  signal?: AbortSignal;
  fixMs?: number;
  /** Total `flowMs`, recorded on a flow stop. */
  flowMs?: number;
}
export async function runFixStep(
  state: FinishState,
  deps: FixStepDeps,
  phase: FixPhase,
  req: Omit<FixRequest, "state" | "signal" | "handoffPath" | "continuation">,
): Promise<FixStepResult>;
// state.ts FinishState gains:
  stops: Stop[];
  handoffs: HandoffRecord[];
  /** HandoffRecord.n of the set-aside the next fix attempt of the same phase continues. */
  pendingHandoff?: number;
```

`FinishMachineDeps.timeouts` (type `FinishTimeouts`, extended in Task 4) now also carries `flowMs?: number`. Add it to `FinishTimeouts`.

- [ ] **Step 1: Extend the test git model.** In `test/helpers/finish-machine.ts` `installFinishGit`, before the final `return`, handle the extra commands (`model.dirty` already says whether the fixer edited):

```ts
    if (cmd === "restore") {
      trail?.push("restore");
      model.dirty = false;
    }
    if (cmd === "diff" && !args.includes("--cached")) return { exitCode: 0, stdout: model.dirty ? "diff --git a/a.ts b/a.ts\n" : "", stderr: "" };
    if (cmd === "apply") {
      trail?.push("apply");
      if (!args.includes("--numstat")) model.dirty = true;
      return { exitCode: model.applyFails ? 1 : 0, stdout: args.includes("--numstat") ? "1\t1\ta.ts\n" : "", stderr: "" };
    }
```

Add `applyFails?: boolean` to `FinishGitModel`. Add `fixMs?: number` to `MachineHarnessOpts`, and set `timeouts: { ...(opts.fixMs ? { fixMs: opts.fixMs } : {}) }` on `deps`.

- [ ] **Step 2: Write the failing unit tests.** Create `test/unit/finish/fix-step.test.ts`:

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installFinishGit, makeFinishOps, makeFinishState } from "@test/helpers";
import type { FinishOps } from "@/finish";
import { runFixStep } from "@/finish/fix-step";

const restores: (() => void)[] = [];
afterEach(() => {
  for (const r of restores.splice(0)) r();
});

async function deps(over: Partial<{ ops: FinishOps; signal: AbortSignal; fixMs: number }> = {}) {
  const auditDir = await mkdtemp(join(tmpdir(), "fixstep-"));
  return {
    ops: over.ops ?? makeFinishOps([]),
    audit: { auditDir, runId: "run-1" },
    now: () => "2026-10-12T00:00:00.000Z",
    ...(over.signal ? { signal: over.signal } : {}),
    ...(over.fixMs ? { fixMs: over.fixMs } : {}),
  };
}

/** A fixer that edits, then waits for its request signal to abort, then throws like callOp does. */
function hangingFix(model: { dirty: boolean }): FinishOps["fix"] {
  return async (_phase, req) => {
    model.dirty = true;
    await new Promise<void>((r) => req.signal?.addEventListener("abort", () => r(), { once: true }));
    throw new Error("callOp[finish-fix]: aborted");
  };
}

describe("runFixStep (finish A)", () => {
  test("a fix that finishes returns done and passes a handoff path and signal", async () => {
    const model = { dirty: false, head: 1 };
    restores.push(installFinishGit(model));
    let seen: { signal?: AbortSignal; handoffPath?: string } = {};
    const ops = makeFinishOps([], {}, {
      fix: async (_p, req) => {
        seen = req;
        model.dirty = true;
        return { dispositions: [] };
      },
    });
    const state = makeFinishState();
    const out = await runFixStep(state, await deps({ ops, fixMs: 60_000 }), "review", { findings: [] });
    expect(out.kind).toBe("done");
    expect(seen.signal).toBeDefined();
    expect(seen.handoffPath).toContain("run-1.handoff-1");
    expect(state.stops).toEqual([]);
  });

  test("fixMs stops the session: set aside, a fix stop recorded, the loop may continue", async () => {
    const model = { dirty: false, head: 1 };
    const trail: string[] = [];
    restores.push(installFinishGit(model, trail));
    const ops = makeFinishOps([], {}, { fix: hangingFix(model) });
    const state = makeFinishState();
    const out = await runFixStep(state, await deps({ ops, fixMs: 5 }), "review", {
      findings: [{ severity: "LOW", title: "t", problem: "p", fix: "f" }],
    });
    expect(out.kind).toBe("stopped");
    expect(trail).toContain("restore");
    expect(trail).not.toContain("commit");
    expect(model.dirty).toBe(false);
    expect(state.stops).toEqual([
      { kind: "fix", phase: "review", at: "2026-10-12T00:00:00.000Z", limitMs: 5, handoff: 1, findings: 1 },
    ]);
    expect(state.handoffs).toHaveLength(1);
    expect(state.pendingHandoff).toBe(1);
  });

  test("flow stop sets aside, then throws FINISH_ABORTED", async () => {
    const model = { dirty: false, head: 1 };
    const trail: string[] = [];
    restores.push(installFinishGit(model, trail));
    const phase = new AbortController();
    const ops = makeFinishOps([], {}, {
      fix: async (p, req) => {
        queueMicrotask(() => phase.abort());
        return hangingFix(model)(p, req);
      },
    });
    const state = makeFinishState();
    const d = { ...(await deps({ ops, signal: phase.signal, fixMs: 60_000 })), flowMs: 10_800_000 };
    await expect(runFixStep(state, d, "gate", { failing: ["test"] })).rejects.toThrow("Finish aborted");
    expect(trail).toContain("restore");
    expect(state.stops[0]).toMatchObject({ kind: "flow", phase: "gate", limitMs: 10_800_000, handoff: 1 });
  });

  test("commit guard: a fix that returns after the limit fired is set aside, not returned as done", async () => {
    const model = { dirty: false, head: 1 };
    restores.push(installFinishGit(model));
    const ops = makeFinishOps([], {}, {
      fix: async (_p, req) => {
        model.dirty = true;
        await new Promise<void>((r) => req.signal?.addEventListener("abort", () => r(), { once: true }));
        return { dispositions: [] }; // returned normally, but late
      },
    });
    const state = makeFinishState();
    const out = await runFixStep(state, await deps({ ops, fixMs: 5 }), "acceptance", { acceptanceOutput: "x" });
    expect(out.kind).toBe("stopped");
    expect(model.dirty).toBe(false);
  });

  test("a fixer error that is not a stop is reported as failed and nothing is set aside", async () => {
    const model = { dirty: false, head: 1 };
    restores.push(installFinishGit(model));
    const ops = makeFinishOps([], {}, {
      fix: async () => {
        throw new Error("model exploded");
      },
    });
    const state = makeFinishState();
    const out = await runFixStep(state, await deps({ ops, fixMs: 60_000 }), "review", { findings: [] });
    expect(out.kind).toBe("failed");
    expect(state.handoffs).toEqual([]);
  });
});
```

`installFinishGit`, `makeFinishOps` and `makeFinishState` must be exported from `@test/helpers`. They already are, or are re-exported from `test/helpers/index.ts`; add the export if missing.

- [ ] **Step 3: Run it to verify it fails.**
Run: `bun test test/unit/finish/fix-step.test.ts --timeout=30000`
Expected: FAIL (module not found).

- [ ] **Step 4: Implement the state, types and ops fields.**
- Add `Stop` (shape above) to `src/finish/types.ts`, and `flowMs?: number` to `FinishTimeouts`.
- In `src/finish/state.ts`, add `stops: Stop[]`, `handoffs: HandoffRecord[]` and `pendingHandoff?: number` to `FinishState`, and `stops: [], handoffs: []` to `createFinishState`.
- In `src/finish/ops.ts`, add to `FixRequest`:

```ts
  /** Finish A: the step's signal (phase + `fixMs`). */
  signal?: AbortSignal;
  /** Finish A: where the fix op writes the handoff turn's raw reply. */
  handoffPath?: string;
  /** Finish A: the set-aside attempt this one continues. */
  continuation?: FixContinuation;
```

In `src/finish/ops-impl.ts` `fix`, pass them on:

```ts
      const input: FinishFixInput = {
        phase,
        workdir: state.workdir,
        findings,
        failing,
        gateOutput,
        acceptanceOutput,
        model: models?.fix,
        timeoutMs: timeouts?.fixMs,
        ...(req.signal ? { stopSignal: req.signal } : {}),
        ...(req.handoffPath ? { handoffPath: req.handoffPath } : {}),
        ...(req.continuation ? { continuation: req.continuation } : {}),
      };
      const ctx = { ...callCtx, sessionOverride: undefined, ...(req.signal ? { signal: req.signal } : {}) };
      return _finishOpsDeps.callOp(ctx, finishFixOp, input);
```

- [ ] **Step 5: Implement `runFixStep`.** Create `src/finish/fix-step.ts`:

```ts
/**
 * Finish A §3.2–§4: every fix session (acceptance, review, gate) runs here.
 *
 * - The session's signal is the phase signal plus `fixMs` (`stepSignal`).
 * - Commit guard: a fixer that returns after either fired is treated as stopped.
 * - A stop sets the session's edits aside (`setAside`) and records a `Stop`.
 * - A `fixMs` stop returns `stopped` so the loop can continue; a phase stop
 *   re-throws `FINISH_ABORTED` after the set-aside, so the handoff survives the
 *   machine's deadline path.
 * - A fixer error that is not a stop returns `failed`, as before.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { getSafeLogger } from "@/logger";
import type { AuditTarget } from "./audit";
import { assertNotAborted } from "./machine-deps";
import type { FinishOps, FixOutcome, FixPhase, FixRequest } from "./ops";
import { captureFixBase, handoffDir, setAside } from "./set-aside";
import type { FinishState } from "./state";
import { stepSignal } from "./step-signal";
import type { HandoffRecord, Stop } from "./types";

export type FixStepResult =
  | { kind: "done"; outcome: FixOutcome; continued?: HandoffRecord }
  | { kind: "failed"; error: unknown }
  | { kind: "stopped"; handoff: HandoffRecord };

export interface FixStepDeps {
  ops: FinishOps;
  audit: AuditTarget;
  now: () => string;
  signal?: AbortSignal;
  fixMs?: number;
  flowMs?: number;
}

function findingIdsOf(req: Pick<FixRequest, "findings">): string[] {
  return (req.findings ?? []).map((f) => `${f.source ?? "quality"}|${f.title}|${f.file ?? ""}`.toLowerCase());
}

async function stop(
  state: FinishState,
  deps: FixStepDeps,
  phase: FixPhase,
  ctx: { base: NonNullable<Awaited<ReturnType<typeof captureFixBase>>>; n: number; req: Pick<FixRequest, "findings"> },
): Promise<HandoffRecord> {
  const flow = deps.signal?.aborted === true;
  const record = await setAside({
    workdir: state.workdir,
    audit: deps.audit,
    n: ctx.n,
    base: ctx.base,
    phase,
    limit: flow ? "flow" : "fix",
    findingIds: findingIdsOf(ctx.req),
    now: deps.now,
  });
  const entry: Stop = {
    kind: flow ? "flow" : "fix",
    phase,
    at: deps.now(),
    limitMs: (flow ? deps.flowMs : deps.fixMs) ?? 0,
    handoff: record.n,
    ...(phase === "review" ? { findings: ctx.req.findings?.length ?? 0 } : {}),
  };
  state.stops = [...state.stops, entry];
  state.handoffs = [...state.handoffs, record];
  state.pendingHandoff = record.n;
  getSafeLogger()?.warn("finish", "Fix session stopped; edits set aside", {
    storyId: "_run",
    phase,
    limit: record.limit,
    handoff: record.dir,
  });
  return record;
}

export async function runFixStep(
  state: FinishState,
  deps: FixStepDeps,
  phase: FixPhase,
  req: Omit<FixRequest, "state" | "signal" | "handoffPath" | "continuation">,
): Promise<FixStepResult> {
  assertNotAborted(deps);
  const base = await captureFixBase(state.workdir);
  const n = state.handoffs.length + 1;
  const dir = handoffDir(deps.audit, n);
  await mkdir(dir, { recursive: true }).catch(() => undefined);
  const { signal, limit } = stepSignal(deps.signal, deps.fixMs);
  const stopped = () => Boolean(signal?.aborted || limit?.aborted);
  let outcome: FixOutcome;
  try {
    outcome = await deps.ops.fix(phase, {
      ...req,
      state,
      ...(signal ? { signal } : {}),
      handoffPath: join(dir, "note.raw.txt"),
    });
  } catch (error) {
    if (!stopped() || !base) {
      assertNotAborted(deps);
      return { kind: "failed", error };
    }
    const handoff = await stop(state, deps, phase, { base, n, req });
    assertNotAborted(deps);
    return { kind: "stopped", handoff };
  }
  if (stopped() && base) {
    const handoff = await stop(state, deps, phase, { base, n, req });
    assertNotAborted(deps);
    return { kind: "stopped", handoff };
  }
  return { kind: "done", outcome };
}
```

The empty handoff dir is created up front so the op can write `note.raw.txt`. A step that never stopped leaves an empty dir; the next step reuses the same `n` because `state.handoffs.length` didn't change. If `captureFixBase` returned `null` (git failed), a stop cannot be set aside: it is treated as `failed`, as today.

- [ ] **Step 6: Run the unit test.**
Run: `bun test test/unit/finish/fix-step.test.ts --timeout=30000`
Expected: PASS.

- [ ] **Step 7: Wire the three loops.** In `src/finish/acceptance-loop.ts`, replace `fixOnce`'s `try { fixOutcome = await deps.ops.fix(...) } catch { ... }` block with:

```ts
  const step = await runFixStep(state, fixStepDeps(deps), "acceptance", { acceptanceOutput: output });
  if (step.kind !== "done") {
    if (step.kind === "failed") {
      getSafeLogger()?.warn("finish", "Acceptance fix session failed; counted as used", {
        storyId: "_run",
        error: errorMessage(step.error),
      });
    }
    state.phases.acceptance.fixAttempts += 1;
    return;
  }
  const fixOutcome = step.outcome;
```

Do the same in `gates-loop.ts` `fixOnce` (phase `"gate"`, `{ failing: gates.failing, gateOutput: gates.output }`, return `{ committed: false, changed: false }` when not done), and in `review-loop.ts` `fixRound` (phase `"review"`, `{ findings: fixList }`; when not done, `return`). Remove the now-unused local `try/catch` blocks.

Add `fixStepDeps` to `src/finish/machine-deps.ts`:

```ts
/** The `runFixStep` deps a loop passes, from the machine deps. */
export function fixStepDeps(deps: FinishMachineDeps) {
  return {
    ops: deps.ops,
    audit: deps.audit,
    now: deps.now,
    ...(deps.signal ? { signal: deps.signal } : {}),
    ...(deps.timeouts?.fixMs ? { fixMs: deps.timeouts.fixMs } : {}),
    ...(deps.timeouts?.flowMs ? { flowMs: deps.timeouts.flowMs } : {}),
  };
}
```

`ReviewLoopDeps` has no `signal`, `timeouts` or `fixMs` today. Add `fix: FixStepDeps` to `ReviewLoopDeps`, set it in `machine.ts` `reviewLoopDeps` as `fix: fixStepDeps(deps)`, and call `runFixStep(state, deps.fix, "review", { findings: fixList })` in `fixRound`.

In `test/unit/finish/review-loop.test.ts`, the local `deps(ops, auditDir, advise?)` builder now has to supply it. Add this to the returned object:

```ts
    fix: { ops, audit: { auditDir, runId: "run-1" }, now: () => "t" },
```

Make the same change in any other test file that builds a `ReviewLoopDeps` literal (`grep -rln "assertNotAborted: () =>" test/unit/finish`).

In `src/finish/phase.ts`, extend the machine `timeouts`:

```ts
      timeouts: {
        acceptanceMs: settings.timeouts.acceptanceMs,
        gateMs: settings.timeouts.gateMs,
        reviewMs: settings.timeouts.reviewMs,
        fixMs: settings.timeouts.fixMs,
        flowMs: settings.timeouts.flowMs,
      },
```

- [ ] **Step 8: Add the loop-level test.** In `test/unit/finish/machine-loops.test.ts`:

```ts
test("a review fix stopped at fixMs is set aside, never committed, and the loop reviews again", async () => {
  const h = makeMachineHarness({
    auditDir: await tempAuditDir(),
    script: { quality: [{ findings: [lowFinding("x")], covered: [] }] },
    fixMs: 5,
    ops: {
      fix: async (_p, req) => {
        await new Promise<void>((r) => req.signal?.addEventListener("abort", () => r(), { once: true }));
        throw new Error("callOp[finish-fix]: aborted");
      },
    },
  });
  await runFinishMachine(h.state, h.deps);
  expect(h.trail.filter((t) => t === "commit")).toHaveLength(0);
  expect(h.trail).toContain("restore");
  expect(h.state.stops[0]).toMatchObject({ kind: "fix", phase: "review" });
  expect(h.trail.filter((t) => t === "review:quality").length).toBeGreaterThan(1);
});
```

Use the file's existing helpers for the temp audit dir and a low finding. Add `lowFinding(title)` returning `{ severity: "LOW", title, problem: "p", fix: "f", source: "quality" }` if the file lacks one.

- [ ] **Step 9: Run all finish tests.**
Run: `bun test test/unit/finish/ test/integration/finish/ --timeout=30000 && bun run typecheck`
Expected: PASS.

- [ ] **Step 10: Commit.**

```bash
git add src/finish test/helpers/finish-machine.ts test/unit/finish
git commit -m "feat(finish): runFixStep - commit guard, set-aside on a stop, fixMs per session (#2462)"
```

---

### Task 8: The next attempt continues from the handoff

**Files:**
- Modify: `src/finish/fix-step.ts`
- Test: `test/unit/finish/fix-step.test.ts`

**Interfaces:**
- Consumes: `reapplyHandoff`, `readHandoffNote`, `markHandoffConsumed` (Task 6). `FixRequest.continuation` (Task 7).
- Produces:
  - A `done` result carries `continued?: HandoffRecord`.
  - `export async function consumeIfCommitted(state: FinishState, continued: HandoffRecord | undefined, committed: boolean): Promise<void>`, called by each loop after `commitFixes`.

- [ ] **Step 1: Write the failing tests.** Append to `test/unit/finish/fix-step.test.ts`:

```ts
describe("runFixStep continuation (finish A §4.3)", () => {
  test("re-applies the pending handoff of the same phase and passes a continuation", async () => {
    const model = { dirty: false, head: 1 };
    const trail: string[] = [];
    restores.push(installFinishGit(model, trail));
    let seen: FixRequest | undefined;
    const ops = makeFinishOps([], {}, {
      fix: async (_p, req) => {
        seen = req;
        return { dispositions: [] };
      },
    });
    const state = makeFinishState();
    const d = await deps({ ops, fixMs: 60_000 });
    state.handoffs = [handoffRecord(d.audit.auditDir, { n: 1, phase: "review", patchSaved: true })];
    state.pendingHandoff = 1;
    const out = await runFixStep(state, d, "review", { findings: [] });
    expect(trail).toContain("apply");
    expect(seen?.continuation).toEqual({ files: ["a.ts"] });
    expect(out.kind === "done" && out.continued?.n).toBe(1);
    expect(state.pendingHandoff).toBeUndefined();
  });

  test("conflicting patch: fresh start, handoff kept and marked not re-applied", async () => {
    const model = { dirty: false, head: 1, applyFails: true };
    restores.push(installFinishGit(model));
    let seen: FixRequest | undefined;
    const ops = makeFinishOps([], {}, {
      fix: async (_p, req) => {
        seen = req;
        return {};
      },
    });
    const state = makeFinishState();
    const d = await deps({ ops, fixMs: 60_000 });
    state.handoffs = [handoffRecord(d.audit.auditDir, { n: 1, phase: "review", patchSaved: true })];
    state.pendingHandoff = 1;
    await runFixStep(state, d, "review", { findings: [] });
    expect(seen?.continuation).toBeUndefined();
    expect(state.handoffs[0].reapplied).toBe(false);
    expect(state.pendingHandoff).toBeUndefined();
  });

  test("a pending handoff of another phase is left alone", async () => {
    const model = { dirty: false, head: 1 };
    const trail: string[] = [];
    restores.push(installFinishGit(model, trail));
    const state = makeFinishState();
    const d = await deps({ fixMs: 60_000 });
    state.handoffs = [handoffRecord(d.audit.auditDir, { n: 1, phase: "gate", patchSaved: true })];
    state.pendingHandoff = 1;
    await runFixStep(state, d, "review", { findings: [] });
    expect(trail).not.toContain("apply");
    expect(state.pendingHandoff).toBe(1);
  });

  test("consumeIfCommitted marks the continued handoff consumed only when the attempt committed", async () => {
    const state = makeFinishState();
    const d = await deps();
    const rec = handoffRecord(d.audit.auditDir, { n: 1, phase: "review", patchSaved: true });
    state.handoffs = [rec];
    await consumeIfCommitted(state, rec, false);
    expect(state.handoffs[0].consumed).toBe(false);
    await consumeIfCommitted(state, rec, true);
    expect(state.handoffs[0].consumed).toBe(true);
  });
});

function handoffRecord(auditDir: string, over: Partial<HandoffRecord>): HandoffRecord {
  return {
    n: 1,
    dir: join(auditDir, "run-1.handoff-1"),
    phase: "review",
    limit: "fix",
    baseSha: "sha1",
    findingIds: [],
    newUntracked: [],
    stoppedAt: "t",
    hasNote: false,
    patchSaved: true,
    consumed: false,
    ...over,
  };
}
```

Import `FixRequest` and `HandoffRecord` types from `@/finish`, and `consumeIfCommitted` from `@/finish/fix-step`.

- [ ] **Step 2: Run them to verify they fail.**
Run: `bun test test/unit/finish/fix-step.test.ts --timeout=30000`
Expected: FAIL.

- [ ] **Step 3: Implement.** In `src/finish/fix-step.ts`:

```ts
import { markHandoffConsumed, readHandoffNote, reapplyHandoff } from "./set-aside";
import type { FixContinuation } from "./types";

function replaceHandoff(state: FinishState, next: HandoffRecord): void {
  state.handoffs = state.handoffs.map((h) => (h.n === next.n ? next : h));
}

/** §4.3: the pending set-aside of this phase, re-applied; undefined when there is none or it conflicts. */
async function continueFrom(
  state: FinishState,
  phase: FixPhase,
): Promise<{ record: HandoffRecord; continuation: FixContinuation } | undefined> {
  const pending = state.handoffs.find((h) => h.n === state.pendingHandoff);
  if (!pending || pending.phase !== phase) return undefined;
  state.pendingHandoff = undefined;
  const { applied, files } = await reapplyHandoff(state.workdir, pending);
  const record = { ...pending, reapplied: applied };
  replaceHandoff(state, record);
  if (!applied) return undefined;
  const note = await readHandoffNote(record);
  return { record, continuation: { files, ...(note ? { note } : {}) } };
}

export async function consumeIfCommitted(
  state: FinishState,
  continued: HandoffRecord | undefined,
  committed: boolean,
): Promise<void> {
  if (!continued || !committed) return;
  replaceHandoff(state, await markHandoffConsumed(continued));
}
```

In `runFixStep`, after `assertNotAborted(deps)`:

```ts
  const cont = await continueFrom(state, phase);
```

Then capture the base. Important: capture it **before** the re-apply, so a stop of this attempt sets aside the re-applied edits too. Reorder: `const base = await captureFixBase(...)` first, then `const cont = await continueFrom(...)`. Pass `...(cont ? { continuation: cont.continuation } : {})` into `ops.fix`. Return `{ kind: "done", outcome, ...(cont ? { continued: cont.record } : {}) }`.

In each loop, right after `commitFixes`:

```ts
  await consumeIfCommitted(state, step.continued, commit.committed);
```

- [ ] **Step 4: Run.**
Run: `bun test test/unit/finish/ --timeout=30000`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/finish test/unit/finish/fix-step.test.ts
git commit -m "feat(finish): the next fix attempt re-applies the handoff and continues from its note"
```

---

### Task 9: One state per finding (ledger)

**Files:**
- Create: `src/finish/ledger.ts`
- Modify: `src/finish/state.ts` (`review.ledger`; `version: 3`; `deserializeFinishState` accepts 3 only)
- Modify: `src/finish/advise.ts` (`JudgedResult.dropped`)
- Modify: `src/finish/review-loop.ts` (emit ledger events; record review stops)
- Test: `test/unit/finish/ledger.test.ts` (create)
- Test: `test/unit/finish/state.test.ts`, `test/unit/finish/advise.test.ts`, `test/unit/finish/review-loop.test.ts`

**Interfaces:**
- Produces:

```ts
export type LedgerState =
  | "open" | "fixed-unreviewed" | "fixed-reviewed" | "rejected"
  | "set-aside" | "waived" | "superseded" | "unresolved" | "accepted";
export interface LedgerEntry { id: string; finding: Finding; state: LedgerState; ref?: string }
export type LedgerEvent =
  | { kind: "raised"; findings: Finding[] }
  | { kind: "fixed"; findings: Finding[]; dispositions: FindingDisposition[]; sha: string }
  | { kind: "set-aside"; findings: Finding[]; handoff: string }
  | { kind: "ruled"; finding: Finding; state: "waived" | "superseded" | "unresolved"; ref?: string }
  | { kind: "full-round"; raised: Finding[] }
  | { kind: "accepted"; findings: Finding[]; ref: string };
export const OPEN_STATES: ReadonlySet<LedgerState>;
export function findingId(f: Finding): string;
export function applyLedgerEvent(ledger: readonly LedgerEntry[], ev: LedgerEvent): LedgerEntry[];
export function openFindings(ledger: readonly LedgerEntry[]): Finding[];
// advise.ts JudgedResult gains:
  dropped: { finding: Finding; decisionId: string; action: "waive" | "supersede" }[];
// state.ts ReviewLoopState gains:
  ledger: LedgerEntry[];
```

`findingId` is the same lower-cased `source|title|file` string `runFixStep` uses (Task 7). Change `findingIdsOf` in `fix-step.ts` to call `findingId` from `./ledger`.

- [ ] **Step 1: Write the failing ledger tests.** Create `test/unit/finish/ledger.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { Finding } from "@/finish";
import { applyLedgerEvent, findingId, openFindings } from "@/finish/ledger";

const f = (title: string, source: "spec" | "quality" = "quality"): Finding => ({
  severity: "MEDIUM",
  title,
  problem: "p",
  fix: "x",
  file: "src/a.ts",
  source,
});

describe("finish ledger (finish A §5)", () => {
  test("raised findings are open", () => {
    const l = applyLedgerEvent([], { kind: "raised", findings: [f("A")] });
    expect(l).toEqual([{ id: findingId(f("A")), finding: f("A"), state: "open" }]);
  });

  test("a committed fix: fixed disposition -> fixed-unreviewed(sha), rejected -> rejected(evidence)", () => {
    let l = applyLedgerEvent([], { kind: "raised", findings: [f("A"), f("B")] });
    l = applyLedgerEvent(l, {
      kind: "fixed",
      findings: [f("A"), f("B")],
      dispositions: [
        { index: 1, disposition: "fixed" },
        { index: 2, disposition: "rejected", evidence: "src/a.ts:3" },
      ],
      sha: "abc123",
    });
    expect(l.map((e) => [e.finding.title, e.state, e.ref])).toEqual([
      ["A", "fixed-unreviewed", "abc123"],
      ["B", "rejected", "src/a.ts:3"],
    ]);
  });

  test("missing disposition stays open", () => {
    let l = applyLedgerEvent([], { kind: "raised", findings: [f("A")] });
    l = applyLedgerEvent(l, { kind: "fixed", findings: [f("A")], dispositions: [], sha: "abc" });
    expect(l[0].state).toBe("open");
  });

  test("a full round that does not re-raise a fixed finding marks it fixed-reviewed; re-raising reopens it", () => {
    let l = applyLedgerEvent([], { kind: "raised", findings: [f("A"), f("B")] });
    l = applyLedgerEvent(l, {
      kind: "fixed",
      findings: [f("A"), f("B")],
      dispositions: [
        { index: 1, disposition: "fixed" },
        { index: 2, disposition: "fixed" },
      ],
      sha: "s1",
    });
    l = applyLedgerEvent(l, { kind: "full-round", raised: [f("B")] });
    l = applyLedgerEvent(l, { kind: "raised", findings: [f("B")] });
    expect(l.map((e) => [e.finding.title, e.state])).toEqual([
      ["A", "fixed-reviewed"],
      ["B", "open"],
    ]);
  });

  test("waived stays waived when re-raised; set-aside and unresolved count as open", () => {
    let l = applyLedgerEvent([], { kind: "raised", findings: [f("A"), f("B"), f("C")] });
    l = applyLedgerEvent(l, { kind: "ruled", finding: f("A"), state: "waived", ref: "D-1" });
    l = applyLedgerEvent(l, { kind: "set-aside", findings: [f("B")], handoff: "handoff-1" });
    l = applyLedgerEvent(l, { kind: "ruled", finding: f("C"), state: "unresolved" });
    l = applyLedgerEvent(l, { kind: "raised", findings: [f("A")] });
    expect(l[0]).toMatchObject({ state: "waived", ref: "D-1" });
    expect(openFindings(l).map((x) => x.title)).toEqual(["B", "C"]);
  });

  test("the round-cap path and the deadline path give identical states for the same events", () => {
    const events = [
      { kind: "raised", findings: [f("A")] },
      { kind: "fixed", findings: [f("A")], dispositions: [{ index: 1, disposition: "fixed" }], sha: "s" },
    ] as const;
    const cap = events.reduce((acc, ev) => applyLedgerEvent(acc, ev), [] as ReturnType<typeof applyLedgerEvent>);
    const deadline = events.reduce((acc, ev) => applyLedgerEvent(acc, ev), [] as ReturnType<typeof applyLedgerEvent>);
    expect(cap).toEqual(deadline);
    expect(openFindings(cap)).toEqual([]);
  });

  test("accepted residue is recorded with its ref", () => {
    let l = applyLedgerEvent([], { kind: "raised", findings: [f("A")] });
    l = applyLedgerEvent(l, { kind: "accepted", findings: [f("A")], ref: "advisor" });
    expect(l[0]).toMatchObject({ state: "accepted", ref: "advisor" });
    expect(openFindings(l)).toEqual([]);
  });

  test("never mutates its input", () => {
    const l0 = applyLedgerEvent([], { kind: "raised", findings: [f("A")] });
    const copy = structuredClone(l0);
    applyLedgerEvent(l0, { kind: "ruled", finding: f("A"), state: "waived", ref: "D-1" });
    expect(l0).toEqual(copy);
  });
});
```

The "identical states" test pins the rule that both paths go through `applyLedgerEvent`. The machine-level version is in Task 10.

- [ ] **Step 2: Run it to verify it fails.**
Run: `bun test test/unit/finish/ledger.test.ts --timeout=30000`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement.** Create `src/finish/ledger.ts`:

```ts
/**
 * Finish A §5: one state per finding. Every transition goes through
 * `applyLedgerEvent`, so the round-cap path and the deadline path can no
 * longer report the same situation two ways. Pure and immutable. Identity is
 * `source|title|file`, case-folded; sub-project B replaces the matching.
 */
import type { Finding, FindingDisposition } from "./types";

export type LedgerState =
  | "open"
  | "fixed-unreviewed"
  | "fixed-reviewed"
  | "rejected"
  | "set-aside"
  | "waived"
  | "superseded"
  | "unresolved"
  | "accepted";

export interface LedgerEntry {
  id: string;
  finding: Finding;
  state: LedgerState;
  ref?: string;
}

export type LedgerEvent =
  | { kind: "raised"; findings: Finding[] }
  | { kind: "fixed"; findings: Finding[]; dispositions: FindingDisposition[]; sha: string }
  | { kind: "set-aside"; findings: Finding[]; handoff: string }
  | { kind: "ruled"; finding: Finding; state: "waived" | "superseded" | "unresolved"; ref?: string }
  | { kind: "full-round"; raised: Finding[] }
  | { kind: "accepted"; findings: Finding[]; ref: string };

export const OPEN_STATES: ReadonlySet<LedgerState> = new Set(["open", "rejected", "set-aside", "unresolved"]);
const STICKY: ReadonlySet<LedgerState> = new Set(["waived", "superseded", "accepted"]);

export function findingId(f: Finding): string {
  return `${f.source ?? "quality"}|${f.title}|${f.file ?? ""}`.toLowerCase();
}

function upsert(ledger: readonly LedgerEntry[], entry: LedgerEntry): LedgerEntry[] {
  const i = ledger.findIndex((e) => e.id === entry.id);
  if (i < 0) return [...ledger, entry];
  return ledger.map((e, j) => (j === i ? entry : e));
}

function set(ledger: readonly LedgerEntry[], f: Finding, state: LedgerState, ref?: string): LedgerEntry[] {
  return upsert(ledger, { id: findingId(f), finding: f, state, ...(ref !== undefined ? { ref } : {}) });
}

function raise(ledger: readonly LedgerEntry[], findings: Finding[]): LedgerEntry[] {
  return findings.reduce<LedgerEntry[]>((acc, f) => {
    const prior = acc.find((e) => e.id === findingId(f));
    return prior && STICKY.has(prior.state) ? acc : set(acc, f, "open");
  }, [...ledger]);
}

function fixed(ledger: readonly LedgerEntry[], ev: Extract<LedgerEvent, { kind: "fixed" }>): LedgerEntry[] {
  return ev.findings.reduce<LedgerEntry[]>((acc, f, i) => {
    const d = ev.dispositions.find((x) => x.index === i + 1);
    if (d?.disposition === "fixed") return set(acc, f, "fixed-unreviewed", ev.sha);
    if (d?.disposition === "rejected") return set(acc, f, "rejected", d.evidence);
    return set(acc, f, "open");
  }, [...ledger]);
}

function fullRound(ledger: readonly LedgerEntry[], raised: Finding[]): LedgerEntry[] {
  const again = new Set(raised.map(findingId));
  return ledger.map((e) => (e.state === "fixed-unreviewed" && !again.has(e.id) ? { ...e, state: "fixed-reviewed" } : e));
}

export function applyLedgerEvent(ledger: readonly LedgerEntry[], ev: LedgerEvent): LedgerEntry[] {
  switch (ev.kind) {
    case "raised":
      return raise(ledger, ev.findings);
    case "fixed":
      return fixed(ledger, ev);
    case "set-aside":
      return ev.findings.reduce<LedgerEntry[]>((acc, f) => set(acc, f, "set-aside", ev.handoff), [...ledger]);
    case "ruled":
      return set(ledger, ev.finding, ev.state, ev.ref);
    case "full-round":
      return fullRound(ledger, ev.raised);
    case "accepted":
      return ev.findings.reduce<LedgerEntry[]>((acc, f) => set(acc, f, "accepted", ev.ref), [...ledger]);
  }
}

export function openFindings(ledger: readonly LedgerEntry[]): Finding[] {
  return ledger.filter((e) => OPEN_STATES.has(e.state)).map((e) => e.finding);
}
```

Note the ordering inside `fixed`: dispositions index into the fix prompt's 1-based numbering, which is the order of `fixList`. `review-loop.ts` passes `fixList` itself as `findings`.

- [ ] **Step 4: Add `dropped` to the advisor's judged result.** In `src/finish/advise.ts`:
- Add `dropped: { finding: Finding; decisionId: string; action: "waive" | "supersede" }[];` to `JudgedResult`.
- `judgeWithoutAdvisor` returns `dropped: []`.
- `judgeOne` returns `dropped?: "waive" | "supersede"`:
  - for a reused prior: `dropped: prior.action.type === "supersede" ? "supersede" : "waive"`;
  - for a fresh decision whose action is `waive` or `supersede`: `dropped: action.type`.
- In `judged`, push `{ finding: f, decisionId: r.ref.decisionId, action: r.dropped }` when `r.dropped && r.ref`.
- In `judgeContradiction`, when the action is `waive` or `supersede`, return `dropped: [c.spec, c.quality]` with the action. The aggregator pushes both.
- `out` starts as `{ toFix: [], advice: [], unresolved: [], dropped: [] }`.

Add a case to `test/unit/finish/advise.test.ts`. It uses that file's existing `fakeAdvisor`, `decision`, `make`, `state` and `judged` helpers:

```ts
  test("waive and supersede are reported per finding in dropped (finish A)", async () => {
    await withTempDir(async (dir) => {
      for (const [action, kind] of [
        [{ type: "waive", reason: "spec allows it" }, "waive"],
        [{ type: "supersede", target: { kind: "spec", section: "Design" }, newText: "x" }, "supersede"],
      ] as const) {
        const { advisor } = fakeAdvisor(() => ({ decision: decision({ action, chosenOptionId: "B" }) }));
        const out = await make(dir, advisor).judged([judged], [], state(dir));
        expect(out.dropped).toEqual([{ finding: judged, decisionId: "D-1", action: kind }]);
      }
    });
  });
```

Update the existing `"advisor unavailable gives unresolved"` expectation to `{ toFix: [], advice: [], unresolved: [judged], dropped: [] }`. Update any other `toEqual` on a whole `JudgedResult` the same way.

- [ ] **Step 5: Emit ledger events in the review loop.** In `src/finish/review-loop.ts`:

```ts
import { applyLedgerEvent, type LedgerEvent } from "./ledger";

function ledgerEvent(state: FinishState, ev: LedgerEvent): void {
  patchReview(state, { ledger: applyLedgerEvent(state.review.ledger, ev) });
}
```

In `runOneRound`, after `const judged = await judgeRound(...)`:

```ts
  ledgerEvent(state, { kind: "raised", findings: [...merged.toFix, ...merged.judged, ...merged.contradictions.flatMap((c) => [c.spec, c.quality])] });
  if (round.missing.length === 0) ledgerEvent(state, { kind: "full-round", raised: [...merged.toFix, ...merged.judged] });
  for (const d of judged.dropped) {
    ledgerEvent(state, { kind: "ruled", finding: d.finding, state: d.action === "supersede" ? "superseded" : "waived", ref: d.decisionId });
  }
  for (const u of judged.unresolved) ledgerEvent(state, { kind: "ruled", finding: u, state: "unresolved" });
```

Order matters: `full-round` runs after `raised`, so a finding raised again this round is `open`, not `fixed-reviewed`. In `fullRound`, `raised` therefore already reflects this round. Confirm with the Step 1 test "re-raising reopens it" and the loop test below.

Use whatever field `MergedFindings` gives for the judged list (`merged.judged`, per `judgeRound`). Contradictions are `merged.contradictions`, each with `.spec` and `.quality`.

In `fixRound`, after a committed fix:

```ts
  if (commit.committed && commit.shaAfter) {
    ledgerEvent(state, { kind: "fixed", findings: fixList, dispositions: outcome.dispositions ?? [], sha: commit.shaAfter });
  }
```

When `runFixStep` returned `stopped`:

```ts
    if (step.kind === "stopped") ledgerEvent(state, { kind: "set-aside", findings: fixList, handoff: `handoff-${step.handoff.n}` });
```

Keep the at-cap `patchReview(state, { lastFindings: [] })` and the unreviewed-commit push as they are. `lastFindings` is now loop control only: reporting reads the ledger (Task 10), so the two paths agree no matter what `lastFindings` holds. Leaving it untouched keeps the existing `runReviewLoop cap` tests valid.

Record review-lens stops: in `runOneRound`, after `recordLensRounds`, for each lens where `round[lens].stoppedAtLimit`:

```ts
      state.stops = [...state.stops, { kind: "review", lens, at: deps.now(), limitMs: deps.reviewMs ?? 0 }];
```

Add `reviewMs?: number` to `ReviewLoopDeps`, set from `deps.timeouts?.reviewMs` in `machine.ts` `reviewLoopDeps`.

- [ ] **Step 6: Bump the state version.** In `src/finish/state.ts`:
- `version: 3` in the interface and in `createFinishState`;
- `ledger: []` in `zeroedReview`;
- `deserializeFinishState` rejects any `version !== 3`;
- update the doc comment ("is not `3`").

Update `test/unit/finish/state.test.ts`: the round-trip case uses version 3, and add:

```ts
test("rejects a version-2 state", () => {
  const v2 = JSON.stringify({ ...createFinishState(init), version: 2 });
  expect(() => deserializeFinishState(v2)).toThrow("unsupported version: 2");
});
```

Use the file's existing `init` fixture.

- [ ] **Step 7: Add the review-loop case.** In `test/unit/finish/review-loop.test.ts`:

This uses that file's existing `q`, `deps`, `stubGit` and `makeFinishOps` helpers:

```ts
describe("runReviewLoop ledger (finish A)", () => {
  test("a fixed finding not re-raised by the next full round becomes fixed-reviewed", async () => {
    await withTempDir(async (dir) => {
      const git = { dirty: false, head: 1 };
      stubGit(git);
      const trail: string[] = [];
      const ops = makeFinishOps(trail, { quality: [q("A")] }, {
        fix: async () => {
          git.dirty = true;
          return { dispositions: [{ index: 1, disposition: "fixed" as const }] };
        },
      });
      const state = makeFinishState();
      await runReviewLoop(state, deps(ops, dir));
      expect(state.review.ledger.map((e) => [e.finding.title, e.state, e.ref])).toEqual([["A", "fixed-reviewed", "sha2"]]);
    });
  });

  test("a fix with no disposition leaves the finding open after the cap", async () => {
    await withTempDir(async (dir) => {
      const git = { dirty: false, head: 1 };
      stubGit(git);
      const ops = makeFinishOps([], { quality: [q("A"), q("A"), q("A")] }, {
        fix: async () => {
          git.dirty = true;
          return {};
        },
      });
      const state = makeFinishState();
      await runReviewLoop(state, deps(ops, dir));
      expect(state.review.ledger[0].state).toBe("open");
    });
  });
});
```

`sha2` is the HEAD the test git model reports after the first commit (`installFinishGit` returns `sha${model.head}`).

- [ ] **Step 8: Run.**
Run: `bun test test/unit/finish/ --timeout=30000 && bun run typecheck`
Expected: PASS. Fix fixtures that build `ReviewLoopState` or `JudgedResult` literals by adding `ledger: []` / `dropped: []`.

- [ ] **Step 9: Commit.**

```bash
git add src/finish test/unit/finish
git commit -m "feat(finish): per-finding ledger; waived and superseded per finding; state v3"
```

---

### Task 10: Facts and reasons from the ledger; coverage on the deadline path; gates not run

**Files:**
- Modify: `src/finish/types.ts` (`GateFact.status`, `ResolutionFacts.findings` / `stops`)
- Modify: `src/finish/resolve.ts` (`computeFacts`, `draftReason`, `stopReason`)
- Modify: `src/finish/machine.ts` (`NOT_RUN_GATE`, `recoverAfterThrow`, accepted residue → ledger)
- Modify: `src/finish/gates-loop.ts` (crashed gates are named `gates could not run`)
- Test: `test/unit/finish/resolve.test.ts`, `test/unit/finish/machine-invariants.test.ts`, `test/unit/finish/machine-end-to-end.test.ts`

**Interfaces:**
- Consumes: `openFindings`, `LedgerEntry` (Task 9). `Stop` (Task 7).
- Produces:
  - `GateFact.status: "green" | "red" | "not-run"`.
  - `ResolutionFacts` gains `findings: LedgerEntry[]; stops: Stop[]`. `findingsOpen` stays, derived.
  - `computeFacts(args)`: `args` gains `ledger: LedgerEntry[]; stops: Stop[]`. `args.review.lastFindings` / `unresolved` are no longer read for `findingsOpen`.
  - `export function stopReason(stops: Stop[]): string | undefined`.

- [ ] **Step 1: Write the failing resolve tests.** Append to `test/unit/finish/resolve.test.ts`:

```ts
describe("facts and reasons (finish A §6)", () => {
  const entry = (title: string, state: LedgerEntry["state"], ref?: string): LedgerEntry => ({
    id: title,
    finding: { severity: "LOW", title, problem: "p", fix: "f" },
    state,
    ...(ref ? { ref } : {}),
  });

  test("draftReason counts findings by state and names the unreviewed commit", () => {
    const facts = baseFacts({
      findings: [entry("A", "open"), ...Array.from({ length: 11 }, (_, i) => entry(`F${i}`, "fixed-unreviewed", "68e7c2189abc"))],
    });
    expect(draftReason({ ...facts, findingsOpen: [facts.findings[0].finding] })).toContain(
      "1 open; 11 fixed in unreviewed commit 68e7c21",
    );
  });

  test("gates that never ran read 'gates not run' and still block ready", () => {
    const facts = baseFacts({ gates: [{ name: "gates", status: "not-run" }] });
    expect(draftReason(facts)).toContain("gates not run");
    expect(draftReason(facts)).not.toContain("gates red");
    expect(isClean(facts)).toBe(false);
  });

  test("stopReason describes the first stop and counts the rest", () => {
    expect(
      stopReason([
        { kind: "fix", phase: "review", at: "t", limitMs: 1_200_000, handoff: 1, findings: 13 },
        { kind: "flow", phase: "gate", at: "t", limitMs: 10_800_000, handoff: 2 },
      ]),
    ).toBe("fix session stopped at the 20 min limit (13 findings, handoff-1); +1 more stop");
    expect(stopReason([{ kind: "review", lens: "quality", at: "t", limitMs: 900_000 }])).toBe(
      "review (quality) stopped at the 15 min limit",
    );
    expect(stopReason([{ kind: "flow", phase: "review", at: "t", limitMs: 10_800_000 }])).toBe(
      "finish time limit (3 h) reached during review",
    );
    expect(stopReason([])).toBeUndefined();
  });

  test("set-aside findings are counted separately", () => {
    const facts = baseFacts({ findings: [entry("A", "set-aside", "handoff-1")] });
    expect(draftReason({ ...facts, findingsOpen: [facts.findings[0].finding] })).toContain("1 set aside (handoff-1)");
  });
});
```

Add a local `baseFacts(over)` that builds a green, clean `ResolutionFacts` (`findingsOpen: []`, `acceptance: "green"`, `gates: []`, `reviewsMissing: []`, `unreviewedFixCommits: []`, `coverage: { spec: 1, quality: 1 }`, `fixRounds: 1`, `findings: []`, `stops: []`) merged with `over`. Import `LedgerEntry` from `@/finish/ledger`, and `stopReason`, `isClean`, `draftReason` from `@/finish/resolve`.

- [ ] **Step 2: Run them to verify they fail.**
Run: `bun test test/unit/finish/resolve.test.ts --timeout=30000`
Expected: FAIL.

- [ ] **Step 3: Implement the types and resolve.** In `src/finish/types.ts`:
- `status: "green" | "red" | "not-run";` in `GateFact`.
- In `ResolutionFacts`, add `/** Finish A: every finding and its state. */ findings: import("./ledger").LedgerEntry[];` and `/** Finish A: every stop, in order. */ stops: Stop[];`.

In `src/finish/resolve.ts`:

```ts
import { type LedgerEntry, openFindings } from "./ledger";
import type { Stop } from "./types";

const SHORT_SHA = 7;

function minutes(ms: number): string {
  return ms >= 3_600_000 && ms % 3_600_000 === 0 ? `${ms / 3_600_000} h` : `${Math.round(ms / 60_000)} min`;
}

function describeStop(s: Stop): string {
  if (s.kind === "review") return `review (${s.lens ?? "?"}) stopped at the ${minutes(s.limitMs)} limit`;
  if (s.kind === "flow") return `finish time limit (${minutes(s.limitMs)}) reached during ${s.phase ?? "finish"}`;
  const held = s.findings !== undefined ? `${s.findings} findings, ` : "";
  return `fix session stopped at the ${minutes(s.limitMs)} limit (${held}handoff-${s.handoff})`;
}

export function stopReason(stops: Stop[]): string | undefined {
  if (stops.length === 0) return undefined;
  const more = stops.length > 1 ? `; +${stops.length - 1} more stop${stops.length > 2 ? "s" : ""}` : "";
  return `${describeStop(stops[0])}${more}`;
}

function findingParts(findings: LedgerEntry[], openCount: number): string[] {
  const parts: string[] = [];
  const plainOpen = findings.filter((e) => e.state === "open" || e.state === "rejected" || e.state === "unresolved");
  if (plainOpen.length > 0) parts.push(`${plainOpen.length} open`);
  else if (findings.length === 0 && openCount > 0) parts.push(`${openCount} open finding(s)`);
  const unreviewed = findings.filter((e) => e.state === "fixed-unreviewed");
  for (const sha of [...new Set(unreviewed.map((e) => e.ref ?? ""))]) {
    const n = unreviewed.filter((e) => (e.ref ?? "") === sha).length;
    parts.push(`${n} fixed in unreviewed commit ${sha.slice(0, SHORT_SHA)}`);
  }
  const aside = findings.filter((e) => e.state === "set-aside");
  for (const ref of [...new Set(aside.map((e) => e.ref ?? ""))]) {
    parts.push(`${aside.filter((e) => (e.ref ?? "") === ref).length} set aside (${ref})`);
  }
  return parts;
}
```

`draftReason` becomes:

```ts
export function draftReason(f: ResolutionFacts): string {
  const parts: string[] = [...findingParts(f.findings, f.findingsOpen.length)];
  if (!acceptanceOk(f.acceptance)) parts.push(`acceptance ${f.acceptance}`);
  if (f.gates.some((g) => g.status === "not-run")) parts.push("gates not run");
  const red = f.gates.filter((g) => g.status === "red").map((g) => g.name);
  if (red.length > 0) parts.push(`gates red: ${red.join(", ")}`);
  for (const lens of LENSES) if (f.reviewsMissing.includes(lens)) parts.push(`${lens} review missing`);
  if (f.unreviewedFixCommits.length > 0) parts.push(`${f.unreviewedFixCommits.length} unreviewed fix commit(s)`);
  return parts.join("; ");
}
```

The fallback `"N open finding(s)"` keeps the old wording only for facts built without a ledger (pre-v3 fixtures).

`computeFacts` takes `ledger` and `stops`, and sets:

```ts
    findingsOpen: openFindings(args.ledger),
    findings: [...args.ledger],
    stops: [...args.stops],
```

Delete the old `findingsOpen` line built from `lastFindings` + `unresolved`.

- [ ] **Step 4: Implement the machine changes.** In `src/finish/machine.ts`:
- `const NOT_RUN_GATE: GateFact[] = [{ name: "gates", status: "not-run", excerpt: "not run" }];`. Import `GateFact` as a type.
- `currentFacts` passes `ledger: state.review.ledger, stops: state.stops` to `computeFacts`.
- Store the review inputs on the closure, so the recovery path can reuse the changed list. Change `runFinishMachine` to keep `let inputs: ReviewInputs | undefined;` outside the `try`, assigned where it is loaded. Pass it to `recoverAfterThrow(state, deps, err, inputs)`.
- In `recoverAfterThrow`:

```ts
  const prefix = deps.signal?.aborted ? (stopReason(state.stops) ?? "deadline") : `finish error: ${message}`;
  try {
    const changed = inputs?.changed ?? (await changedFiles(state.workdir, state.base));
    if (changed.length === 0) {
      getSafeLogger()?.warn("finish", "No changed files for coverage on the recovery path", { storyId: "_run" });
    }
    const facts = currentFacts(state, changed);
```

  Import `changedFiles` from `./changed-files` and `stopReason` from `./resolve`.

- In `resolveAndFinalize`, the draft reason for a normal (non-throw) end with stops: prefix `stopReason(state.stops)` when present. Do it in `toDecision` callers by changing `finalizeResult`'s reason:

```ts
  const stopped = stopReason(state.stops);
  const reason = decision.outcome === "draft" ? (stopped && !decision.reason.startsWith(stopped) ? `${stopped}; ${decision.reason}` : decision.reason) : undefined;
```

- When `decision.outcome === "ready"` and `acceptedResidue.length > 0`, apply the event before writing the result:

```ts
  if (acceptedResidue.length > 0) {
    state.review = { ...state.review, ledger: applyLedgerEvent(state.review.ledger, { kind: "accepted", findings: acceptedResidue, ref: "advisor" }) };
  }
```

In `src/finish/gates-loop.ts` `runGatesOrCrash`, keep the crash fact but name it for humans:

```ts
    return { gates: { passed: false, ran: ["gates could not run"], failing: ["gates could not run"], output }, crashed: true };
```

- [ ] **Step 5: Add machine-level tests.** In `test/unit/finish/machine-invariants.test.ts`:

```ts
test("deadline after a completed review round reports non-null coverage (#2461)", async () => {
  const phase = new AbortController();
  const h = makeMachineHarness({
    auditDir: await tempAuditDir(),
    signal: phase.signal,
    script: { quality: [{ findings: [], covered: ["src/a.ts"] }], spec: [{ findings: [], covered: ["src/a.ts"] }] },
    qualityExit: () => {
      phase.abort();
      return 1;
    },
  });
  h.git.changedFiles = ["src/a.ts"];
  const result = await runFinishMachine(h.state, h.deps);
  expect(result.outcome).toBe("draft");
  expect(result.facts?.coverage).toEqual({ spec: 1, quality: 1 });
});

test("gates that never ran: the reason says 'gates not run' (#2463)", async () => {
  const phase = new AbortController();
  phase.abort();
  const h = makeMachineHarness({ auditDir: await tempAuditDir(), signal: phase.signal });
  const result = await runFinishMachine(h.state, h.deps);
  expect(result.reason).toContain("gates not run");
  expect(result.reason).not.toContain("gates red: gates");
});
```

Support it in `test/helpers/finish-machine.ts`:
- Add `changedFiles?: string[]` to `FinishGitModel`.
- In `installFinishGit`, before the other `diff` branches:

```ts
    if (cmd === "diff" && args.includes("--name-only")) {
      return { exitCode: 0, stdout: (model.changedFiles ?? []).join("\n"), stderr: "" };
    }
```

The harness loads review inputs after the stub is installed, so setting `h.git.changedFiles` before `runFinishMachine` is enough.

- [ ] **Step 6: Run.**
Run: `bun test test/unit/finish/ --timeout=30000 && bun run typecheck`
Expected: PASS. Update fixtures that construct `ResolutionFacts` literals by adding `findings: [], stops: []`.

- [ ] **Step 7: Commit.**

```bash
git add src/finish test/unit/finish test/helpers/finish-machine.ts
git commit -m "fix(finish): facts from the ledger, stop reasons, coverage on the deadline path, gates not run (#2461 #2463)"
```

---

### Task 11: Checkpoints after every step

**Files:**
- Create: `src/finish/checkpoint.ts`
- Modify: `src/finish/machine.ts` (call after each step)
- Test: `test/unit/finish/checkpoint.test.ts` (create)

**Interfaces:**
- Produces:
  - `export function checkpointPath(audit: AuditTarget): string`, i.e. `<auditDir>/<runId>.checkpoint.json`.
  - `export async function writeCheckpoint(audit: AuditTarget, state: FinishState): Promise<void>`. Atomic (temp file + rename), never throws.

- [ ] **Step 1: Write the failing test.** Create `test/unit/finish/checkpoint.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { withTempDir } from "@test/helpers";
import { checkpointPath, deserializeFinishState, writeCheckpoint } from "@/finish";
import { makeFinishState } from "@test/helpers";

describe("finish checkpoint (finish A §4.4)", () => {
  test("writes a version-3 state that round-trips, with no temp file left behind", async () => {
    await withTempDir(async (dir) => {
      const audit = { auditDir: dir, runId: "run-1" };
      const state = makeFinishState();
      await writeCheckpoint(audit, state);
      const parsed = deserializeFinishState(await readFile(checkpointPath(audit), "utf8"));
      expect(parsed.version).toBe(3);
      expect(parsed.feature).toBe(state.feature);
      expect((await readdir(dir)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    });
  });

  test("never throws when the directory cannot be written", async () => {
    await writeCheckpoint({ auditDir: "/dev/null/nope", runId: "r" }, makeFinishState());
  });
});
```

- [ ] **Step 2: Run it to verify it fails.**
Run: `bun test test/unit/finish/checkpoint.test.ts --timeout=30000`
Expected: FAIL.

- [ ] **Step 3: Implement.** Create `src/finish/checkpoint.ts`:

```ts
/**
 * Finish A §4.4: the serialized `FinishState` after every completed step, for
 * `nax finish --resume` (sub-project E). Nothing reads it in A. Atomic: a
 * temp file renamed over the target, so a reader never sees half a state.
 * Best-effort: a write failure is logged and never stops finish.
 */
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { errorMessage } from "@nathapp/nax-agent/internal";
import { getSafeLogger } from "@/logger";
import type { AuditTarget } from "./audit";
import { type FinishState, serializeFinishState } from "./state";

export function checkpointPath(audit: AuditTarget): string {
  return join(audit.auditDir, `${audit.runId}.checkpoint.json`);
}

export async function writeCheckpoint(audit: AuditTarget, state: FinishState): Promise<void> {
  const target = checkpointPath(audit);
  const tmp = `${target}.tmp`;
  try {
    await mkdir(audit.auditDir, { recursive: true });
    await writeFile(tmp, serializeFinishState(state), "utf8");
    await rename(tmp, target);
  } catch (err) {
    getSafeLogger()?.warn("finish", "Finish checkpoint could not be written", {
      storyId: "_run",
      error: errorMessage(err),
    });
  }
}
```

Export `checkpointPath` and `writeCheckpoint` from `src/finish/index.ts`.

In `src/finish/machine.ts` `runFinishMachine`, call `await writeCheckpoint(deps.audit, state);` after each of:
- `runAcceptanceLoop` (both calls);
- `runReviewLoop`;
- `runGatesLoop`;
- inside `finalizeResult`, after `state.status = out.status`.

In `recoverAfterThrow`, call it before `finalizeResult`.

- [ ] **Step 4: Add the machine check.** In `test/unit/finish/machine-end-to-end.test.ts`, add one assertion to an existing passing end-to-end case:

```ts
  expect(existsSync(join(h.deps.audit.auditDir, "run-1.checkpoint.json"))).toBe(true);
```

- [ ] **Step 5: Run.**
Run: `bun test test/unit/finish/ --timeout=30000`
Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git add src/finish test/unit/finish
git commit -m "feat(finish): atomic state checkpoint after every completed step"
```

---

### Task 12: PR body, `result.json`, and finalize no longer commits a stopped session's tree

**Files:**
- Modify: `src/finish/pr/context.ts` (`unresolved` carries `findings: LedgerEntry[]`, `stops`, `handoffs`)
- Modify: `src/finish/pr/body.ts` (findings table, Set aside, Stops, gates not run)
- Modify: `src/finish/types.ts` (`FinishResult.handoffs`)
- Modify: `src/finish/machine.ts` (`result.handoffs`)
- Modify: `src/finish/ops-impl.ts` (`finalizeDraftPr` and `fallbackBody`)
- Test: `test/unit/finish/pr-body.test.ts`, `test/unit/finish/pr-context.test.ts`, `test/unit/finish/ops-impl-a4.test.ts`

**Interfaces:**
- Consumes: `LedgerEntry`, `OPEN_STATES` (Task 9), `Stop`, `HandoffRecord`, `stopReason` (Tasks 7, 10).
- Produces:
  - `FinishPrContext.unresolved` gains `ledger: LedgerEntry[]; stops: Stop[]; handoffs: HandoffRecord[]`. Keep `findings` for the fallback renderer.
  - `FinishResult.handoffs?: { dir: string; limit: "fix" | "flow"; findingIds: string[]; consumed: boolean; reapplied?: boolean }[]`.

- [ ] **Step 1: Write the failing body tests.** Append to `test/unit/finish/pr-body.test.ts`, using its existing `makeCtx` (or equivalent) builder:

```ts
describe("findings table, Set aside and Stops (finish A §7)", () => {
  const e = (title: string, severity: Finding["severity"], state: LedgerEntry["state"], ref?: string): LedgerEntry => ({
    id: title,
    finding: { severity, title, problem: "p", fix: "f", file: "src/x|y.ts" },
    state,
    ...(ref ? { ref } : {}),
  });

  test("renders one table sorted by state then severity, with resolved rows collapsed", () => {
    const body = buildFinishBody(
      makeCtx({
        unresolved: {
          ...unresolvedBase,
          ledger: [
            e("fixed one", "HIGH", "fixed-unreviewed", "68e7c2189abc"),
            e("open low", "LOW", "open"),
            e("open high", "HIGH", "open"),
            e("waived", "MEDIUM", "waived", "D-2"),
          ],
        },
      }),
    );
    const table = body.slice(body.indexOf("| Severity |"));
    expect(table.indexOf("open high")).toBeLessThan(table.indexOf("open low"));
    expect(table.indexOf("open low")).toBeLessThan(table.indexOf("fixed one"));
    expect(body).toContain("`68e7c21`");
    expect(body).toContain("src/x\\|y.ts");
    expect(body).toMatch(/<details>[\s\S]*waived[\s\S]*D-2[\s\S]*<\/details>/);
  });

  test("lists set-aside handoffs and stops", () => {
    const body = buildFinishBody(
      makeCtx({
        unresolved: {
          ...unresolvedBase,
          stops: [{ kind: "fix", phase: "review", at: "t", limitMs: 1_200_000, handoff: 1, findings: 3 }],
          handoffs: [
            { n: 1, dir: "/o/finish-audit/feat/run-1.handoff-1", phase: "review", limit: "fix", baseSha: "s", findingIds: ["a", "b", "c"], newUntracked: [], stoppedAt: "t", hasNote: true, patchSaved: true, consumed: false, reapplied: false },
          ],
        },
      }),
    );
    expect(body).toContain("### Set aside");
    expect(body).toContain("run-1.handoff-1/changes.patch");
    expect(body).toContain("not re-applied");
    expect(body).toContain("### Stops");
    expect(body).toContain("fix session stopped at the 20 min limit (3 findings, handoff-1)");
  });

  test("a not-run gate renders as 'Gates did not run'", () => {
    const body = buildFinishBody(makeCtx({ unresolved: { ...unresolvedBase, gates: [{ name: "gates", status: "not-run" }] } }));
    expect(body).toContain("Gates did not run");
    expect(body).not.toContain("Gate `gates` is red");
  });
});
```

`unresolvedBase` is a local `{ reason: "r", findings: [], acceptance: "green", gates: [], missing: [], unreviewed: [], accepted: [], ledger: [], stops: [], handoffs: [] }`.

In `test/unit/finish/ops-impl-a4.test.ts`, add a case. It uses that file's `baseDeps` and `freshState`, and overrides the git stub so the tree is dirty until a `restore`:

```ts
describe("finalizeDraftPr after a stop (finish A §4.5)", () => {
  test("a tree still dirty after a stop is set aside, not committed", async () => {
    await withTempDir(async (dir) => {
      const { deps } = baseDeps();
      const gitCalls: string[][] = [];
      let dirty = true;
      _finishGitDeps.git = async (args: string[]) => {
        gitCalls.push(args);
        if (args[0] === "status") return { exitCode: 0, stdout: dirty ? " M a.ts\n" : "", stderr: "" };
        if (args[0] === "restore") dirty = false;
        if (args[0] === "rev-parse") return { exitCode: 0, stdout: "sha1\n", stderr: "" };
        if (args[0] === "diff" && args.includes("--cached")) return { exitCode: dirty ? 1 : 0, stdout: "", stderr: "" };
        return { exitCode: 0, stdout: "", stderr: "" };
      };
      const state = { ...freshState(), stops: [{ kind: "flow" as const, phase: "review" as const, at: "t", limitMs: 1 }] };
      const ops = createFinishOps({ ...deps, forgeKind: null, audit: { auditDir: dir, runId: "run-1" } });
      const out = await ops.finalizeDraftPr(state);
      expect(out.status).toBe("local-only");
      expect(gitCalls.some((a) => a[0] === "commit")).toBe(false);
      expect(gitCalls.some((a) => a[0] === "restore")).toBe(true);
      expect(state.handoffs).toHaveLength(1);
      expect(state.handoffs[0].limit).toBe("flow");
    });
  });

  test("without a stop, a dirty tree is committed as before", async () => {
    const { deps, gitCalls } = baseDeps();
    const base = _finishGitDeps.git;
    _finishGitDeps.git = async (args: string[]) => {
      if (args[0] === "status") return { exitCode: 0, stdout: " M a.ts\n", stderr: "" };
      if (args[0] === "diff" && args.includes("--cached")) return { exitCode: 1, stdout: "", stderr: "" };
      return base(args);
    };
    await createFinishOps({ ...deps, forgeKind: null }).finalizeDraftPr(freshState());
    expect(gitCalls.some((a) => a[0] === "commit")).toBe(true);
  });
});
```

Import `withTempDir` from `@test/helpers` if the file lacks it.

- [ ] **Step 2: Run them to verify they fail.**
Run: `bun test test/unit/finish/pr-body.test.ts test/unit/finish/ops-impl-a4.test.ts --timeout=30000`
Expected: FAIL.

- [ ] **Step 3: Implement the context.** In `src/finish/pr/context.ts` `fromResolution`, add to `unresolved` (the function needs `state`, not just `resolution`: change it to take `state` and read `state.resolution`, `state.stops`, `state.handoffs`):

```ts
            ledger: facts.findings ?? [],
            stops: state.stops ?? [],
            handoffs: state.handoffs ?? [],
```

Change `needsBlock` to `outcome === "draft" || acceptedResidue.length > 0 || (state.stops ?? []).length > 0`.

- [ ] **Step 4: Implement the body.** In `src/finish/pr/body.ts`:

```ts
const STATE_ORDER: Record<LedgerState, number> = {
  open: 0, rejected: 1, "set-aside": 2, unresolved: 3, "fixed-unreviewed": 4,
  accepted: 5, "fixed-reviewed": 6, waived: 7, superseded: 8,
};
const RESOLVED: ReadonlySet<LedgerState> = new Set(["fixed-reviewed", "waived", "superseded"]);

function refCell(e: LedgerEntry): string {
  if (!e.ref) return "";
  return e.state === "fixed-unreviewed" || e.state === "fixed-reviewed" ? `\`${e.ref.slice(0, SHORT_SHA_LEN)}\`` : escapeTableCell(e.ref);
}

function ledgerRow(e: LedgerEntry): string {
  const where = e.finding.file ? escapeTableCell(`${e.finding.file}${e.finding.line !== undefined ? `:${e.finding.line}` : ""}`) : "";
  return `| ${e.finding.severity} | ${escapeTableCell(e.finding.title)} | ${where} | ${e.state} | ${refCell(e)} |`;
}

function sortLedger(entries: LedgerEntry[]): LedgerEntry[] {
  return [...entries].sort(
    (a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || SEVERITY_ORDER[a.finding.severity] - SEVERITY_ORDER[b.finding.severity],
  );
}

function buildFindingsTable(ledger: LedgerEntry[]): string | null {
  if (ledger.length === 0) return null;
  const head = "| Severity | Finding | File | State | Ref |\n|---|---|---|---|---|";
  const live = sortLedger(ledger.filter((e) => !RESOLVED.has(e.state)));
  const done = sortLedger(ledger.filter((e) => RESOLVED.has(e.state)));
  const table = live.length > 0 ? `${head}\n${live.map(ledgerRow).join("\n")}` : "";
  const folded =
    done.length > 0
      ? `<details><summary>${done.length} resolved</summary>\n\n${head}\n${done.map(ledgerRow).join("\n")}\n\n</details>`
      : "";
  return [table, folded].filter(Boolean).join("\n\n");
}

function renderHandoff(h: HandoffRecord): string {
  const where = h.patchSaved ? `\`${h.dir}/changes.patch\`` : "_patch not saved, work lost_";
  const applied = h.consumed ? "re-applied and committed" : h.reapplied === false ? "not re-applied" : "pending";
  return `- handoff-${h.n} (${h.phase}, ${h.limit} limit, ${h.findingIds.length} finding(s)): ${where} — ${applied}`;
}
```

In `buildUnresolvedSection`:
- When `u.ledger.length > 0`, replace the "Open findings" block with `...(table ? [`### Findings\n${table}`] : [])`, where `table = buildFindingsTable(u.ledger)`. Keep the old block when the ledger is empty (pre-v3 results).
- Add `...block("Set aside", u.handoffs.map(renderHandoff))` and `...block("Stops", u.stops.map((s) => `- ${stopReason([s])}`))`.
- In `checks`, add `...(u.gates.some((g) => g.status === "not-run") ? ["- Gates did not run"] : [])`. `renderRedGate` stays filtered to `status === "red"`.

Import `LedgerEntry` / `LedgerState` from `../ledger`, `HandoffRecord` from `../types`, and `stopReason` from `../resolve`.

- [ ] **Step 5: Implement `result.json` and finalize.** In `src/finish/machine.ts` `finalizeResult`, add:

```ts
    ...(state.handoffs.length > 0
      ? {
          handoffs: state.handoffs.map((h) => ({
            dir: h.dir,
            limit: h.limit,
            findingIds: h.findingIds,
            consumed: h.consumed,
            ...(h.reapplied !== undefined ? { reapplied: h.reapplied } : {}),
          })),
        }
      : {}),
```

Add the `handoffs?` field (shape above) to `FinishResult` in `src/finish/types.ts`. Draft results keep `findings: finalFacts.findingsOpen`.

In `src/finish/ops-impl.ts` `finalizeDraftPr`, before `commitAndPush`:

```ts
      // Finish A §4.5: a stopped session's tree was restored by set-aside. If the
      // tree is still dirty after a stop (a failed restore), set that dirt aside
      // too instead of committing unreviewed half-edits.
      if (state.stops.length > 0 && (await treeDirty(state.workdir))) {
        const base = await captureFixBase(state.workdir);
        if (base) {
          const record = await setAside({
            workdir: state.workdir,
            audit,
            n: state.handoffs.length + 1,
            base: { ...base, untrackedBefore: [] },
            phase: "review",
            limit: "flow",
            findingIds: [],
            now: () => new Date().toISOString(),
          });
          state.handoffs = [...state.handoffs, record];
        }
      }
```

`untrackedBefore: []` is deliberate. At finalize after a failed restore, every untracked file is suspect, but `setAside` still never runs `git clean`: it deletes only paths it lists. Add `treeDirty(workdir)` next to the helper in `src/finish/commit.ts`, reusing the `git status --porcelain` check already used there (L52). Import `captureFixBase` and `setAside` from `./set-aside`.

In `fallbackBody`, list `state.handoffs` dirs and `stopReason(state.stops)` too.

- [ ] **Step 6: Run.**
Run: `bun test test/unit/finish/ --timeout=30000 && bun run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit.**

```bash
git add src/finish test/unit/finish
git commit -m "feat(finish): findings table, Set aside and Stops in the PR; handoffs in result.json (#2469)"
```

---

### Task 13: Outcome regression, full gates, and a live-check note

**Files:**
- Test: `test/unit/finish/resolve.test.ts`
- Modify: `../../docs/superpowers/specs/2026-10-12-finish-a-honest-stop-and-reporting-design.md` (deviation notes, if any)

- [ ] **Step 1: Write the unchanged-outcomes regression.** Append to `test/unit/finish/resolve.test.ts`:

```ts
describe("unchanged ready/draft rules on ledger-derived facts (finish A §2)", () => {
  const open = (state: LedgerEntry["state"]): LedgerEntry => ({
    id: "x",
    finding: { severity: "LOW", title: "x", problem: "p", fix: "f" },
    state,
  });
  const facts = (findings: LedgerEntry[], over: Partial<ResolutionFacts> = {}) =>
    baseFacts({ findings, findingsOpen: findings.filter((e) => OPEN_STATES.has(e.state)).map((e) => e.finding), ...over });

  test.each([
    ["clean", facts([]), true],
    ["fixed-reviewed only", facts([open("fixed-reviewed")]), true],
    ["waived only", facts([open("waived")]), true],
    ["one open", facts([open("open")]), false],
    ["set-aside", facts([open("set-aside")]), false],
    ["fixed-unreviewed + its commit", facts([open("fixed-unreviewed")], { unreviewedFixCommits: ["s"] }), false],
    ["acceptance red", facts([], { acceptance: "red" }), false],
    ["gate not run", facts([], { gates: [{ name: "gates", status: "not-run" }] }), false],
    ["lens missing", facts([], { reviewsMissing: ["spec"] }), false],
  ] as const)("%s -> clean=%s", (_name, f, clean) => {
    expect(isClean(f)).toBe(clean);
  });

  test("advisor off, not clean -> draft; clean -> ready (no advisor call)", async () => {
    expect((await resolve({ facts: facts([open("open")]), reReviewUsed: false })).outcome).toBe("draft");
    expect((await resolve({ facts: facts([]), reReviewUsed: false })).outcome).toBe("ready");
  });
});
```

- [ ] **Step 2: Run it.**
Run: `bun test test/unit/finish/resolve.test.ts --timeout=30000`
Expected: PASS. Every row should already pass; this pins it.

- [ ] **Step 3: Run the full gates.** From `packages/nax`:
Run: `bun run test && bun run check:all && bun run typecheck && bun run test:coverage`
Expected: all green. If `test:coverage` fails on a new file, add focused unit cases to that file's test until it meets the floor. Do not lower the baseline.

From the repo root:
Run: `bun run check:all`
Expected: green.

- [ ] **Step 4: Record deviations from the spec.** Append a short "Implementation notes" section to the spec, listing what the plan settled:
- The `stepMs` shim lives in `src/config/finish-timeouts-shim.ts`.
- The handoff note is written by the op's `hopBody` to `note.raw.txt`, because `callOp` throws after an aborted hop.
- The ledger function is named `applyLedgerEvent`.
- The 30-second stop latency is pinned per layer: `callOp` → run options (Task 1), run options → `runAsSession` (existing hop tests), `opts.signal` → native turn (nax-agent US-002 tests). It is confirmed end to end only by the live check.
- Crashed gates are named `gates could not run`.

Commit:

```bash
git add test/unit/finish/resolve.test.ts ../../docs/superpowers/specs/2026-10-12-finish-a-honest-stop-and-reporting-design.md
git commit -m "test(finish): pin unchanged ready/draft rules on ledger facts; spec implementation notes"
```

- [ ] **Step 5: Live check. Needs approval; do not launch.** Report to the user that the spec's §11 live check is still owed. It needs a real `nax run` with finish enabled, using the local build `repos/nax-run` fast-forwarded to this branch. A temporarily low `finish.timeouts.fixMs` (e.g. `120000`) forces a stop. Check that:
- the stop ends within 30 s;
- no commit lands from the stopped session;
- `finish-audit/<feature>/<runId>.handoff-1/` holds `changes.patch` and `meta.json`, plus `note.json` if the handoff turn answered;
- `<runId>.checkpoint.json` exists;
- the draft PR's reason, findings table, Set aside and Stops match `result.json`.

Do not launch it: `nax run` is billed and needs explicit approval at launch.
