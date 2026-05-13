# SPEC: Plan Refine Mode

**Branch:** `feat/plan-refine-mode`  
**Scope:** `src/plan/strategies/refine.ts`, `src/operations/plan-refine.ts`, `src/prompts/builders/plan-builder.ts`, `src/config/`  
**Depends on:** `SPEC-plan-strategy-refactor.md` (strategy pattern must land first)

---

## Summary

Add a new `refine` plan mode that runs a 2-turn single session: turn 1 produces a full PRD draft (same prompt as `single` mode), turn 2 sends an adversarial self-audit continuation that asks the model to find and fix flaws in its own draft. The mode is opt-in via `config.plan.mode: "refine"` or `--mode refine`. It is designed for cheap models that benefit from a second pass focused entirely on AC quality, failure-mode coverage, and description-AC consistency — areas where cheap one-shot drafts predictably fall short.

---

## Motivation

After the prompt-quality improvements in PR #1023, cheap-model single mode scores ~8.4 on the eval harness. The 2-turn refine approach targets the residual gap by forcing a second focused pass:

- **ac-testable**: cheap models often emit vague or non-observable ACs; a dedicated refine prompt can catch and rewrite them
- **failure-modes-considered**: negative-path ACs are frequently missing from initial drafts
- **description-ac-contradiction**: descriptions sometimes contradict ACs written in the same story

Pipeline mode already addresses this via a separate critic op, but it costs 3 LLM calls and requires a separate grounding phase. Refine mode achieves a comparable quality improvement at 2 LLM calls within a single session — the model has full context of its own draft when it performs the audit.

---

## Design

### Approach

Two turns within a single `planInteractiveOp`-style session using `hopBody`. Turn 1 sends the same draft prompt as `single` mode via `ctx.sendWithParseRetry` — parse failures trigger repair prompts via `op.retry`. Turn 2 sends an adversarial continuation prompt via plain `ctx.send` — it asks the model to rewrite the PRD file in place and reply with a brief text confirmation. Turn 2 does NOT use `ctx.sendWithParseRetry` because the confirmation text is not JSON and must not be parse-retried. `callOp`'s `fileOutput` mechanism reads the output file after every `send` call (including plain `ctx.send`) and substitutes its content as `TurnResult.output`, so `op.parse()` always sees the revised PRD JSON rather than the model's text confirmation.

### Turn 2 prompt design

Turn 2 is adversarial framing, not confirmatory. The key principle: "assume the draft has flaws, find them". Three checklist items are injected explicitly:

- **`ac-testable`** — for each AC, is the assertion observable (return value, exception, log, file content, state)? If not, rewrite it.
- **`failure-modes-considered`** — does each story have at least one negative-path AC? If not, add one.
- **`description-ac-contradiction`** — does any sentence in any description contradict an AC in the same story? If so, fix the description.

Turn 2 directs the model to write the revised PRD to the same output file path and respond with a brief text confirmation. `callOp`'s `fileOutput` substitution ensures `op.parse()` sees the written JSON, not the confirmation text. `failure-table-enumerated` (present in the pipeline critic) is intentionally omitted — turn 2 does not re-receive the original spec, so row-by-row table enumeration cannot be performed reliably.

### New operation: `planRefineOp`

```typescript
// src/operations/plan-refine.ts

// Mirrors PlanInteractiveInput exactly — mutable arrays to match PlanPromptBuilder.build() signature
export interface PlanRefineInput {
  specContent: string;
  codebaseContext: string;
  featureName: string;
  branchName: string;
  outputPath: string;
  packages?: string[];
  packageDetails?: PackageSummary[];
  projectProfile?: ProjectProfile;
}

export const planRefineOp: RunOperation<PlanRefineInput, PRD, PlanConfig> = {
  kind: "run",
  name: "plan-refine",
  stage: "plan",
  session: { role: "plan-refine", lifetime: "fresh" },
  config: planConfigSelector,
  model: (_input, ctx) => ctx.config.plan.model,
  timeoutMs: (_input, ctx) => (ctx.config.plan.timeoutSeconds ?? 600) * 1000,

  // retry applies to turn 1 via ctx.sendWithParseRetry in hopBody.
  // turn 2 uses ctx.send() — no retry loop on the text confirmation.
  retry: makeParseRetryStrategy({
    validate: (parsed) => {
      if (parsed === null || typeof parsed !== "object") return false;
      const obj = parsed as Record<string, unknown>;
      return "userStories" in obj && Array.isArray(obj.userStories) && obj.userStories.length > 0;
    },
    reviewerKind: "plan",
    maxAttempts: 3,
    prompts: {
      invalid: () => PlanPromptBuilder.jsonRepair(0, "Invalid JSON — response was not parseable"),
      truncated: () => PlanPromptBuilder.jsonRepair(0, "JSON appears truncated — please rewrite completely"),
    },
    // No exhaustedFallback: disk recovery is handled by op.recover (same as planInteractiveOp).
  }),

  // fileOutput: callOp reads this file after every send (including plain ctx.send)
  // and substitutes its content as TurnResult.output — so op.parse() always sees
  // the written PRD JSON, not the model's text confirmation.
  fileOutput: (input) => input.outputPath,

  build(input, _ctx) {
    // Mirrors planInteractiveOp.build() exactly — PlanPromptBuilder.build() returns
    // PlanningPromptParts; assemble into ComposeInput here.
    const { taskContext, outputFormat } = new PlanPromptBuilder().build(
      input.specContent,
      input.codebaseContext,
      input.outputPath,
      input.packages,
      input.packageDetails,
      input.projectProfile,
    );
    return {
      role: { id: "role", content: "", overridable: false },
      task: { id: "task", content: `${taskContext}\n\n${outputFormat}`, overridable: false },
    };
  },

  async hopBody(initialPrompt, ctx) {
    // Turn 1: draft — sendWithParseRetry applies op.retry; fileOutput substitution
    // ensures the probe validates the written JSON, not the text confirmation.
    const turn1 = await ctx.sendWithParseRetry(initialPrompt);

    // Turn 2: adversarial self-audit — plain ctx.send(), no parse retry.
    // fileOutput substitution runs after ctx.send too, so turn2.output will
    // already contain the revised file content when returned.
    const refinePrompt = new PlanPromptBuilder().buildRefineContinuation(ctx.input.outputPath);
    const turn2 = await ctx.send(refinePrompt);

    return {
      ...turn2,
      estimatedCostUsd: (turn1.estimatedCostUsd ?? 0) + (turn2.estimatedCostUsd ?? 0),
    };
  },

  parse(output, input) {
    return validatePlanOutput(output, input.featureName, input.branchName);
  },

  verify: async (parsed, _input, _ctx) => {
    if (!parsed.userStories || parsed.userStories.length === 0) return null;
    return parsed;
  },

  recover: async (input, ctx) => {
    const content = await ctx.readFile(input.outputPath);
    if (!content) return null;
    try {
      return validatePlanOutput(content, input.featureName, input.branchName);
    } catch {
      return null;
    }
  },
};
```

### New prompt method: `PlanPromptBuilder.buildRefineContinuation()`

```typescript
// src/prompts/builders/plan-builder.ts

buildRefineContinuation(outputFilePath: string): string {
  // Adversarial self-audit continuation — injected as turn 2
}
```

The method must:
- Open with adversarial framing ("assume this draft has flaws")
- Include the three checklist sections with their `#### <id>` headings matching the critic checklist item identifiers: `ac-testable`, `failure-modes-considered`, `description-ac-contradiction`
- Instruct the model to write the revised PRD to `outputFilePath` (not output to conversation)
- Instruct the model to reply with a brief text confirmation only after writing the file
- NOT include a JSON output schema (turn 2 output is plain text confirmation; the file is the real output)

### New strategy: `RefinePlanStrategy`

```typescript
// src/plan/strategies/refine.ts

export class RefinePlanStrategy implements IPlanStrategy {
  readonly mode = "refine" as const;

  async execute(ctx: PlanModeContext): Promise<string> {
    // Nearly identical to SinglePlanStrategy but uses planRefineOp.
    // ctx.runtime is built once in buildPlanModeContext and closed by
    // planCommand()'s finally block — this strategy does not close it.
    const callCtx = buildCallCtx(ctx.runtime, ctx);
    try {
      const prd = await callOp(callCtx, planRefineOp, {
        specContent: ctx.specContent,
        codebaseContext: ctx.codebaseContext,
        featureName: ctx.options.feature,
        branchName: ctx.branchName,
        outputPath: ctx.outputPath,
        packages: ctx.relativePackages,
        packageDetails: ctx.packageDetails,
        projectProfile: ctx.config.plan.projectProfile,
      });
      return writeOrRecoverPrd(ctx, prd);
    } catch (err) {
      return writeOrRecoverPrd(ctx, null, err);
    }
  }
}
```

### Config schema changes

```typescript
// src/config/schemas-infra.ts — mode enum extended
mode: z.enum(["single", "debate", "pipeline", "refine"]).optional(),

// src/config/runtime-types.ts — PlanConfig type extended
mode?: "single" | "debate" | "pipeline" | "refine";
```

`resolvePlanMode()` return type extended to include `"refine"`. Refine is only returned when explicitly configured — it is never auto-selected:

```typescript
export function resolvePlanMode(
  config: NaxConfig
): "single" | "debate" | "pipeline" | "refine" {
  const explicit = config?.plan?.mode;
  if (explicit) return explicit;
  if (config?.debate?.enabled && config?.debate?.stages?.plan?.enabled) return "debate";
  return "single";
}
```

### Session role registry

`adapter-wiring.md` role registry table — add `plan-refine` to the `callOp` run-kind row alongside `plan`, `plan-draft`, `plan-revise`, `plan-critic`.

### Failure handling

- Turn 1 parse failure → `sendWithParseRetry` fires `prompts.invalid` / `prompts.truncated` repair continuations (up to `maxAttempts`)
- Turn 2 failure → `ctx.send` does not retry; if the file is missing or malformed after turn 2, `op.parse()` fails and `op.recover()` attempts to read the last good file from disk (which turn 1 may have written)
- If both turns produce no valid PRD on disk → `callOp` throws; `writeOrRecoverPrd` re-throws; `RefinePlanStrategy.execute` propagates
- Fail-closed: no PRD means no output file; caller receives the error

---

## Stories

### US-001: Config schema and mode resolution

Extend the config schema to accept `"refine"` as a valid `plan.mode` value and update `resolvePlanMode()`.

**No dependencies.**

#### Context Files
- `src/config/schemas-infra.ts` — `mode` enum (line ~17)
- `src/config/runtime-types.ts` — `PlanConfig.mode` type (line ~285)
- `src/cli/plan.ts` — `resolvePlanMode()` function
- `test/unit/cli/plan-mode.test.ts` — existing mode resolution tests

### US-002: Refine continuation prompt

Add `buildRefineContinuation(outputFilePath)` to `PlanPromptBuilder`.

**No dependencies.**

#### Context Files
- `src/prompts/builders/plan-builder.ts` — `PlanPromptBuilder` class
- `src/prompts/builders/critic-builder.ts` — checklist item identifiers to match (`ac-testable`, `failure-modes-considered`, `description-ac-contradiction`)
- `test/unit/prompts/builders/plan-builder.test.ts` — existing prompt builder tests

### US-003: `planRefineOp` operation

Create `src/operations/plan-refine.ts` implementing the 2-turn `hopBody` flow.

**Depends on US-002.**

#### Context Files
- `src/operations/plan.ts` — `planInteractiveOp` to mirror for `build`, `parse`, `verify`, `recover`
- `src/operations/types.ts` — `RunOperation` interface
- `src/prompts/builders/plan-builder.ts` — `PlanPromptBuilder.buildRefineContinuation`
- `src/operations/index.ts` — barrel to add export to
- `test/unit/operations/plan.test.ts` — existing op tests (pattern to follow)

### US-004: `RefinePlanStrategy` and factory wiring

Create `RefinePlanStrategy`, add `"refine"` to `createPlanStrategy` factory, register `plan-refine` session role.

**Depends on US-001, US-003, and `SPEC-plan-strategy-refactor.md` US-003.**

#### Context Files
- `src/plan/strategies/single.ts` — `SinglePlanStrategy` to mirror
- `src/plan/strategies/write-prd.ts` — `writeOrRecoverPrd` shared helper
- `src/plan/strategies/index.ts` — factory to extend
- `.claude/rules/adapter-wiring.md` — session role registry to update
- `test/unit/plan/strategies/single.test.ts` — test patterns to mirror

---

## Acceptance Criteria

### US-001: Config schema and mode resolution

**AC1:** `NaxConfigSchema.safeParse({ plan: { mode: "refine" } })` returns `success: true`.

**AC2:** `NaxConfigSchema.safeParse({ plan: { mode: "unknown-mode" } })` returns `success: false`.

**AC3:** `resolvePlanMode({ plan: { mode: "refine" } })` returns `"refine"`.

**AC4:** `resolvePlanMode({})` returns `"single"` (refine is never auto-selected).

**AC5:** `resolvePlanMode({ debate: { enabled: true, stages: { plan: { enabled: true } } } })` returns `"debate"` — debate auto-selection takes priority over default, but not over an explicit `plan.mode`.

**AC6:** `resolvePlanMode({ plan: { mode: "refine" }, debate: { enabled: true, stages: { plan: { enabled: true } } } })` returns `"refine"` — explicit mode wins over debate auto-selection.

**AC7:** `createPlanStrategy("refine")` in `src/plan/strategies/index.ts` returns a `RefinePlanStrategy` instance without a TypeScript exhaustiveness error — the `switch` in `createPlanStrategy` handles all four modes.

### US-002: Refine continuation prompt

**AC1:** `new PlanPromptBuilder().buildRefineContinuation("/path/to/prd.json")` returns a string with length greater than 200 characters.

**AC2:** The returned string contains the substring `"ac-testable"`.

**AC3:** The returned string contains the substring `"failure-modes-considered"`.

**AC4:** The returned string contains the substring `"description-ac-contradiction"`.

**AC5:** The returned string contains the literal path passed as `outputFilePath`.

**AC6:** The returned string contains the word `"flaws"` or `"adversarial"` (adversarial framing present).

**AC7:** The returned string does NOT contain `"```json"` (no JSON output schema — turn 2 output is plain text confirmation).

### US-003: `planRefineOp` operation

**AC1:** `planRefineOp.kind` is `"run"` and `planRefineOp.name` is `"plan-refine"`.

**AC2:** `planRefineOp.session.role` is `"plan-refine"` and `planRefineOp.session.lifetime` is `"fresh"`.

**AC3:** `planRefineOp.build(input, ctx)` returns a `ComposeInput` whose `task.content` contains `input.featureName`.

**AC4:** `planRefineOp.hopBody` calls `ctx.sendWithParseRetry` for turn 1 (draft) and `ctx.send` — not `ctx.sendWithParseRetry` — for turn 2 (refine), so the text confirmation from turn 2 is never parse-retried.

**AC5:** `planRefineOp.hopBody` calls `new PlanPromptBuilder().buildRefineContinuation(input.outputPath)` as the prompt for turn 2.

**AC6:** `planRefineOp.hopBody` returns the `TurnResult` from `ctx.send` with `estimatedCostUsd` overridden to the sum of turn 1 and turn 2 costs; it does NOT manually read the file (relying on `callOp`'s `fileOutput` substitution to populate `turn2.output`).

**AC7:** `planRefineOp.hopBody` returns a `TurnResult` whose `estimatedCostUsd` equals `turn1.estimatedCostUsd + turn2.estimatedCostUsd`.

**AC8:** `planRefineOp.recover(input, ctx)` returns a parsed PRD when `input.outputPath` exists on disk with valid PRD JSON; returns `null` when the file does not exist.

**AC9:** `planRefineOp` is exported from `src/operations/index.ts`.

### US-004: `RefinePlanStrategy` and factory wiring

**AC1:** `createPlanStrategy("refine")` returns an instance of `RefinePlanStrategy`.

**AC2:** `RefinePlanStrategy.mode` equals `"refine"`.

**AC3:** `RefinePlanStrategy.execute(ctx)` calls `callOp` with `planRefineOp` (not `planInteractiveOp`).

**AC4:** `RefinePlanStrategy.execute(ctx)` returns `ctx.outputPath` on success.

**AC5:** When `callOp` throws and `ctx.outputPath` exists on disk, `RefinePlanStrategy.execute` reads and returns the disk-recovered path via `writeOrRecoverPrd`.

**AC6:** `adapter-wiring.md` session role registry includes `plan-refine` in the `callOp` run-kind row.

---

## New Tests Required

### `test/unit/config/plan-mode-refine.test.ts`

- Schema accepts `"refine"` and rejects unknown values (AC1, AC2 of US-001)
- `resolvePlanMode` returns `"refine"` only when explicitly configured (AC3, AC4, AC5, AC6)
- `createPlanStrategy("refine")` returns a `RefinePlanStrategy` without TypeScript error (AC7)

### `test/unit/prompts/builders/plan-refine-prompt.test.ts`

- All AC1–AC7 of US-002 as individual `test()` cases
- Snapshot of the full continuation prompt for regression detection

### `test/unit/operations/plan-refine.test.ts`

- `planRefineOp.build` includes feature name in output (AC3)
- `hopBody` receives `initialPrompt` as first argument and passes it to `ctx.sendWithParseRetry` for turn 1; does NOT pass `ctx.input.outputPath` as the prompt (AC4)
- `hopBody` calls `ctx.send` (not `ctx.sendWithParseRetry`) for turn 2 — verify the mock `ctx` records one `sendWithParseRetry` call and one `send` call (AC4)
- `hopBody` uses `buildRefineContinuation(ctx.input.outputPath)` as the turn 2 prompt (AC5)
- `hopBody` returns `turn2` with `estimatedCostUsd` overridden to `turn1.cost + turn2.cost`; does NOT manually call `Bun.file()` or `ctx.readFile()` (AC6, AC7)
- `recover` returns PRD from disk when file exists; returns `null` when absent (AC8)
- `planRefineOp` is exported from the operations barrel (AC9)

### `test/unit/plan/strategies/refine.test.ts`

- `execute` calls `callOp` with `planRefineOp` and returns `ctx.outputPath` (AC3, AC4)
- Disk recovery when `callOp` throws (AC5)
- Does NOT call `rt.close()` — runtime lifecycle is `planCommand()`'s responsibility
