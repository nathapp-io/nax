# SPEC: Plan Interactive Path — callOp Migration + JSON Parse Retry

## Summary

Migrate `nax plan --from <spec>` from a bare `agentManager.runAs()` call to `callOp` with a `RunOperation`, and thread `interactionBridge` through the operations layer so interactive plan sessions retain Q&A capability. Add same-session JSON parse retry so a malformed PRD response triggers an in-session repair turn rather than a hard failure.

## Motivation

Three problems exist today:

1. **`RunOperation` / `callOp` do not support `interactionBridge`.** The `CallContext`, `call.ts`, and `build-hop-callback.ts` have zero references to `interactionBridge`, so any `RunOperation` that needs interactive Q&A (e.g. plan's mid-session clarification) cannot use the `callOp` dispatch path without losing that capability.

2. **The interactive plan path bypasses `callOp` entirely.** `src/cli/plan.ts` calls `agentManager.runAs(agentName, {...})` directly — skipping all `callOp` middleware: hop-level retry, `op.verify`/`op.recover`, abort propagation, and any future op-level instrumentation. It also has a parallel `--auto` one-shot code path (`callOp + planOp`, kind:`"complete"`) that is a separate implementation of the same behavior.

3. **JSON parse failure is a hard crash.** When the agent produces invalid JSON for the PRD, `validatePlanOutput()` throws `[schema] Failed to parse JSON` and the entire plan fails. There is no in-session repair — the user has to restart from scratch. The semantic/adversarial review ops already handle this with `makeParseRetryStrategy` + `sendWithParseRetry`; plan should use the same pattern.

## Design

### Implementation approach

Use a `RunOperation` (`kind:"run"`) with `hopBody` + `op.retry` — the same pattern as `semanticReviewOp` and `adversarialReviewOp`. This gives same-session JSON parse retry via `ctx.sendWithParseRetry` inside the hop body. Remove the `--auto` code path; the interactive `callOp` path covers all cases.

### Existing types to extend

- **`CallContext`** (`src/operations/types.ts`) — add optional `interactionBridge` and `maxInteractionTurns` fields.
- **`BuildHopCallbackContext`** (`src/operations/build-hop-callback.ts`) — add optional `interactionBridge` and `maxInteractionTurns`; forward both into `agentManager.runAsSession(...)` as `interactionHandler` (via `buildRunInteractionHandler`) and `maxTurns`.
- **`call.ts`** — thread `ctx.interactionBridge` and `ctx.maxInteractionTurns` into the `runOptions` object built for `kind:"run"` ops.

### New operation: `planInteractiveOp`

Replace `planOp` (`kind:"complete"`) with `planInteractiveOp` (`kind:"run"`) in `src/operations/plan.ts`:

```typescript
export interface PlanInteractiveInput {
  specContent: string;
  codebaseContext: string;
  featureName: string;
  branchName: string;
  outputPath: string;       // file path agent writes PRD to
  packages?: string[];
  packageDetails?: PackageSummary[];
  projectProfile?: ProjectProfile;
}

export const planInteractiveOp: RunOperation<PlanInteractiveInput, PRD, PlanConfig> = {
  kind: "run",
  name: "plan-interactive",
  stage: "plan",
  session: { role: "plan", lifetime: "fresh" },
  config: planConfigSelector,
  model: (_input, ctx) => ctx.config.plan.model,
  timeoutMs: (_input, ctx) => (ctx.config.plan.timeoutSeconds ?? 600) * 1000,
  retry: makeParseRetryStrategy({ ... }),  // JSON parse retry, max 2 attempts
  hopBody: async (initialPrompt, ctx) => {
    return ctx.sendWithParseRetry(initialPrompt);
  },
  build(input, _ctx) { ... },   // PlanPromptBuilder.build() → outputPath variant
  parse(output, input, _ctx) {
    // read file written by agent; fall back to output string
    return validatePlanOutput(output, input.featureName, input.branchName);
  },
  recover: async (input, ctx) => { ... },  // read outputPath from disk if parse misses
};
```

### `PlanPromptBuilder.jsonRepair()` static method

Add a static method to `PlanPromptBuilder` that returns the repair prompt sent on parse-retry turns:

```typescript
static jsonRepair(attempt: number, parseError: string): string
```

Returns a prompt telling the agent the previous response was not valid JSON, includes the parse error, and asks it to re-write the PRD JSON to `outputPath`.

### Removal of `planOp` and `--auto` path

`planOp` (`kind:"complete"`) is only used by the `--auto` branch in `src/cli/plan.ts`. Both are removed. The debate path does not use `planOp` — it calls `runInteractivePlan()` directly, which is also replaced.

### `src/cli/plan.ts` refactor

- Remove the `options.auto` branch.
- Remove `runInteractivePlan()` inner function.
- Replace with `callOp(ctx, planInteractiveOp, input)` where `ctx` includes `interactionBridge` and `maxInteractionTurns`.
- The debate fallback path also calls `callOp + planInteractiveOp` instead of `runInteractivePlan()`.

### Failure handling

- **JSON parse failure** → `op.retry` fires `sendWithParseRetry`, sends `PlanPromptBuilder.jsonRepair()` prompt in the same session, max 2 repair attempts.
- **Repair exhausted** → `exhaustedFallback` attempts to read `outputPath` from disk (the agent may have written a valid file even if the turn output was truncated). If the file exists and parses, return it. Otherwise throw.
- **Session failure (abort/timeout)** → `op.recover` reads `outputPath` from disk as a last resort — same behaviour as the current `runInteractivePlan()` logic.
- **Debate fallback** stays: if all debaters fail, falls back to `callOp + planInteractiveOp` (was `runInteractivePlan()`).

## Stories

1. **US-001: Thread `interactionBridge` through the operations layer** — no dependencies
2. **US-002: Add `PlanPromptBuilder.jsonRepair()` and `planInteractiveOp`** — depends on US-001
3. **US-003: Migrate `plan.ts` to `callOp + planInteractiveOp`; remove `--auto` and `runAs`** — depends on US-002

### Context Files

**US-001:**
- `src/operations/types.ts` — `CallContext` and `RunOperation` interfaces to extend
- `src/operations/call.ts` — `runOptions` assembly for `kind:"run"` ops (lines 200–212)
- `src/operations/build-hop-callback.ts` — `BuildHopCallbackContext` + `openSession` + `runAsSession` calls
- `src/agents/types.ts` — `AgentRunOptions.interactionBridge` definition (lines 103–107)
- `src/agents/acp/adapter-output.ts` — `buildRunInteractionHandler(options)` converts `interactionBridge` → `InteractionHandler`; must be called in the `send` closure
- `src/agents/manager-types.ts` — `RunAsSessionOpts` shape (`interactionHandler`, `maxTurns` fields)
- `src/runtime/session-run-hop.ts` — reference: how `interactionBridge` → `interactionHandler` → `sendPrompt` wiring works today
- `src/operations/semantic-review.ts` — reference `RunOperation` that uses `hopBody` + `op.retry`

**US-002:**
- `src/prompts/builders/plan-builder.ts` — `PlanPromptBuilder` class; add `jsonRepair()` static method
- `src/operations/plan.ts` — existing `planOp`; replace with `planInteractiveOp`
- `src/agents/retry/parse-retry.ts` — `makeParseRetryStrategy` API
- `src/operations/semantic-review.ts` — reference pattern for `retry` + `hopBody` composition
- `src/prd/schema.ts` — `validatePlanOutput()` and `parseRawString()` — what throws on bad JSON

**US-003:**
- `src/cli/plan.ts` — full file; `runInteractivePlan()` inner function and `--auto` branch to remove
- `src/cli/plan-runtime.ts` — `createPlanRuntime()` still needed to build the `NaxRuntime` for `callOp`; `resolvePlanModelSelection()` is no longer needed in `plan.ts` after the migration (model resolution moves into `planInteractiveOp.model`)
- `src/operations/call.ts` — `callOp` signature; `CallContext` usage
- `src/operations/index.ts` — barrel to update (export `planInteractiveOp`, remove `planOp`)

## Acceptance Criteria

### US-001: Thread `interactionBridge` through the operations layer

- `CallContext` in `src/operations/types.ts` has an optional `interactionBridge` field with the same shape as `AgentRunOptions.interactionBridge` (`{ detectQuestion, onQuestionDetected }`).
- `CallContext` in `src/operations/types.ts` has an optional `maxInteractionTurns?: number` field.
- When `callOp` dispatches a `kind:"run"` op and `ctx.interactionBridge` is set, then `runOptions` passed to `runWithFallback` includes the `interactionBridge` value.
- When `callOp` dispatches a `kind:"run"` op and `ctx.maxInteractionTurns` is set, then `runOptions` includes the `maxInteractionTurns` value.
- `BuildHopCallbackContext` in `build-hop-callback.ts` has optional `interactionBridge` and `maxInteractionTurns` fields.
- When `buildHopCallback` dispatches a turn via `agentManager.runAsSession(...)` and `ctx.interactionBridge` is set, then the `RunAsSessionOpts` passed to `runAsSession` includes a non-null `interactionHandler` produced by `buildRunInteractionHandler`.
- When `buildHopCallback` dispatches a turn via `agentManager.runAsSession(...)` and `ctx.maxInteractionTurns` is set, then the `RunAsSessionOpts` passed to `runAsSession` includes the `maxTurns` value.
- When `ctx.interactionBridge` is absent from `CallContext`, then the compiled `runOptions` does not include an `interactionBridge` key (no `undefined` spreading).

### US-002: Add `PlanPromptBuilder.jsonRepair()` and `planInteractiveOp`

- `PlanPromptBuilder` has a static method `jsonRepair(attempt: number, parseError: string): string` that returns a non-empty string containing the word "JSON".
- `PlanPromptBuilder.jsonRepair()` output includes the `parseError` string passed as argument.
- `planInteractiveOp` is a `RunOperation` exported from `src/operations/plan.ts` with `kind: "run"`, `name: "plan-interactive"`, and `session.role: "plan"`.
- `planInteractiveOp.retry` is set and resolves to a `RetryStrategy` (not `null`) when invoked with any `PlanInteractiveInput`.
- When `planInteractiveOp.parse()` receives output that is valid PRD JSON, then it returns a `PRD` object without throwing.
- When `planInteractiveOp.parse()` receives output that is not valid JSON, then it throws (triggering the retry strategy).
- `planInteractiveOp.hopBody` calls `ctx.sendWithParseRetry` with the initial prompt (not `ctx.send`).
- `planInteractiveOp.recover` is defined and, when `outputPath` file exists on disk and contains valid PRD JSON, returns the parsed `PRD` without throwing.
- When `planInteractiveOp.recover` is called and the `outputPath` file does not exist, it returns `null`.
- `planOp` (`kind:"complete"`) is removed from `src/operations/plan.ts` and `src/operations/index.ts`.

### US-003: Migrate `plan.ts` to `callOp + planInteractiveOp`; remove `--auto` and `runAs`

- `src/cli/plan.ts` does not contain any call to `agentManager.runAs(...)`.
- `src/cli/plan.ts` does not contain an `options.auto` branch or the `--auto` flag handling.
- `src/cli/plan.ts` does not contain the `runInteractivePlan` inner function.
- When `planCommand()` is called (non-debate path), then it calls `callOp(ctx, planInteractiveOp, input)` where `ctx.interactionBridge` is set from the resolved interaction chain.
- When `planCommand()` is called and `interactionChain` is `null`, then `ctx.interactionBridge` is set from `_planDeps.createInteractionBridge()` (the stdin fallback).
- When `planCommand()` calls `callOp` for the interactive path, then `ctx.maxInteractionTurns` is set from `config?.agent?.maxInteractionTurns`.
- When the debate fallback fires (all debaters fail), then the fallback calls `callOp(ctx, planInteractiveOp, input)` instead of `runInteractivePlan()`.
- When `callOp + planInteractiveOp` succeeds and the agent has written a valid PRD to `outputPath`, then `planCommand()` returns the `outputPath` string.
- When `callOp + planInteractiveOp` throws and `outputPath` does not exist on disk, then `planCommand()` propagates the error.
- `import { planOp }` is removed from `src/cli/plan.ts`; `planInteractiveOp` is imported instead.
