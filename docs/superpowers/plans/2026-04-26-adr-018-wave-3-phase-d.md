# ADR-018 Wave 3 Phase D — keepOpen Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace all `keepOpen: true` + `sessionHandle: string` patterns in `src/review/dialogue.ts` and `src/debate/session-stateful.ts` (and callers) with the ADR-019 §4 caller-managed session pattern (`sessionManager.openSession` / `agentManager.runAsSession` / `sessionManager.closeSession`).

**Architecture:** `createReviewerSession` gains a `sessionManager: ISessionManager` parameter and manages one `SessionHandle` internally (closed on compaction and destroy). The debate stateful layer (`runStatefulTurn`) drops `keepOpen`/`roleKey` params; callers pre-open `SessionHandle`s and close them in `finally`. The `runRebuttalLoop` function gains optional internal session opening for the plan-mode case where proposals carry no handle.

**Tech Stack:** Bun 1.3.7+, TypeScript strict, `bun:test`, `ISessionManager` / `IAgentManager` / `SessionHandle` / `TurnResult` from existing ADR-019 surface.

---

## File Map

| File | Action | Responsibility |
|:-----|:-------|:---------------|
| `src/debate/session-helpers.ts` | Modify | Add `handle?: SessionHandle` to `SuccessfulProposal`; add `sessionManager?: ISessionManager` to `DebateSessionOptions` |
| `src/debate/session-stateful.ts` | Modify | Remove `keepOpen`/`roleKey` from `runStatefulTurn`; add `handle: SessionHandle`; delete `closeStatefulSession`; add session lifecycle to `runStateful` |
| `src/debate/session-hybrid.ts` | Modify | Remove `closeStatefulSession`; add `sessionManager` to `HybridCtx`; open/close sessions in `runHybrid`; update `runRebuttalLoop` to use handles or open fresh ones |
| `src/debate/session.ts` | Modify | Store `sessionManager` from opts; pass it in all ctx objects |
| `src/debate/session-plan.ts` | Modify | Add `sessionManager` to `PlanCtx`; thread it into `HybridCtx` |
| `src/review/dialogue.ts` | Modify | Add `sessionManager` param; manage `SessionHandle` via `getOrOpenHandle`; replace 5 `agentManager.run({keepOpen})` calls with `agentManager.runAsSession`; close handle on compaction/destroy |
| `src/pipeline/stages/review.ts` | Modify | Pass `ctx.sessionManager` as 2nd arg to `createReviewerSession` |
| `test/unit/review/dialogue.test.ts` | Modify | Update all `createReviewerSession` calls; replace keepOpen assertions with `openSession`/`runAsSession`/`closeSession` assertions |
| `test/unit/debate/session-stateful.test.ts` | Modify | Replace keepOpen/closeSession assertions with handle-based assertions |
| `test/unit/debate/session-hybrid.test.ts` | Modify | Replace keepOpen assertions with openSession/runAsSession assertions |
| `test/unit/debate/session-hybrid-rebuttal.test.ts` | Modify | Replace rebuttal keepOpen assertions with handle/runAsSession assertions |

---

## Task 1: Update `session-helpers.ts` — add handle to SuccessfulProposal

**Files:**
- Modify: `src/debate/session-helpers.ts`

- [ ] **Step 1: Write the failing test**

Add to `test/unit/debate/session-stateful.test.ts` inside the `describe("DebateSession.run() — stateful mode")` block, after existing tests:

```typescript
test("SuccessfulProposal type carries optional handle field (compile-time check)", () => {
  // Import-level type check — if SuccessfulProposal lacks handle, this file fails tsc
  const proposal: import("../../../src/debate/session-helpers").SuccessfulProposal = {
    debater: { agent: "claude", model: "fast" },
    agentName: "claude",
    output: "test",
    cost: 0,
    handle: { id: "sess-001", agentName: "claude" },
  };
  expect(proposal.handle?.id).toBe("sess-001");
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
timeout 15 bun test test/unit/debate/session-stateful.test.ts --timeout=5000
```

Expected: type error — `handle` does not exist on `SuccessfulProposal`.

- [ ] **Step 3: Add `handle` to `SuccessfulProposal` and `sessionManager` to `DebateSessionOptions`**

In `src/debate/session-helpers.ts`, find the `SuccessfulProposal` interface (line ~26):

```typescript
// BEFORE
export interface SuccessfulProposal {
  debater: Debater;
  agentName: string;
  output: string;
  /** Cost for this complete() call in USD. */
  cost: number;
  roleKey?: string;
}
```

Replace with:

```typescript
// AFTER
export interface SuccessfulProposal {
  debater: Debater;
  agentName: string;
  output: string;
  /** Cost for this complete() call in USD. */
  cost: number;
  roleKey?: string;
  /** Caller-managed session handle for stateful turns (ADR-019 §4). */
  handle?: import("../agents/types").SessionHandle;
}
```

Then find `DebateSessionOptions` (near the bottom of session-helpers.ts). Add `sessionManager`:

```typescript
export interface DebateSessionOptions {
  storyId: string;
  stage: string;
  stageConfig: DebateStageConfig;
  config?: NaxConfig;
  workdir?: string;
  featureName?: string;
  timeoutSeconds?: number;
  agentManager?: IAgentManager;
  reviewerSession?: import("../review/dialogue").ReviewerSession;
  resolverContextInput?: ResolverContextInput;
  /** Session manager for caller-managed session lifecycle (ADR-019 §4). */
  sessionManager?: import("../session/types").ISessionManager;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
timeout 15 bun test test/unit/debate/session-stateful.test.ts --timeout=5000
```

Expected: PASS — type check succeeds.

- [ ] **Step 5: Run typecheck**

```bash
bun run typecheck
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/debate/session-helpers.ts test/unit/debate/session-stateful.test.ts
git commit -m "refactor(adr-018): add handle to SuccessfulProposal, sessionManager to DebateSessionOptions"
```

---

## Task 2: Migrate `session-stateful.ts` — remove keepOpen, delete closeStatefulSession

**Files:**
- Modify: `src/debate/session-stateful.ts`
- Modify: `test/unit/debate/session-stateful.test.ts`

### 2a: Update test expectations for runStatefulTurn

- [ ] **Step 1: Write failing tests for new runStatefulTurn signature**

In `test/unit/debate/session-stateful.test.ts`, find the test `"rounds > 1 keeps proposal session open and reuses same role in critique"` and ADD a new describe block after all existing describes:

```typescript
describe("DebateSession.run() stateful — ADR-019 runAsSession pattern", () => {
  test("proposal round (rounds=1) calls runAsSession not run", async () => {
    const runAsSessionCalls: Array<{ agentName: string; prompt: string }> = [];
    const openCalls: string[] = [];
    const closeCalls: string[] = [];

    const mockSM = makeSessionManager({
      openSession: mock(async (_name: string) => {
        openCalls.push(_name);
        return { id: "h-" + openCalls.length, agentName: "claude" };
      }),
      closeSession: mock(async (handle) => {
        closeCalls.push(handle.id);
      }),
    });

    _debateSessionDeps.agentManager = makeMockAgentManager({
      runAsSessionFn: async (agentName, _handle, prompt) => {
        runAsSessionCalls.push({ agentName, prompt });
        return { output: `proposal-${agentName}`, tokenUsage: { inputTokens: 0, outputTokens: 0 }, internalRoundTrips: 0 };
      },
    });

    const session = new DebateSession({
      storyId: "US-RAS-001",
      stage: "plan",
      stageConfig: makeStageConfig({ rounds: 1 }),
      workdir: "/tmp/work",
      featureName: "feat-a",
      timeoutSeconds: 120,
      sessionManager: mockSM,
    });

    await session.run("test prompt");

    expect(runAsSessionCalls.length).toBe(2); // one per debater
    expect(openCalls.length).toBe(2);         // one session per debater
    expect(closeCalls.length).toBe(2);        // all closed in finally
  });

  test("rounds > 1: proposal + critique both use runAsSession on same handle per debater", async () => {
    const callsByHandle: Record<string, string[]> = {};
    const closedHandles: string[] = [];

    const handlesByDebater: Record<string, string> = {};

    const mockSM = makeSessionManager({
      openSession: mock(async (name: string) => {
        const id = "h-" + name;
        handlesByDebater[name] = id;
        return { id, agentName: "claude" };
      }),
      closeSession: mock(async (handle) => { closedHandles.push(handle.id); }),
    });

    _debateSessionDeps.agentManager = makeMockAgentManager({
      runAsSessionFn: async (_agentName, handle, prompt) => {
        callsByHandle[handle.id] = callsByHandle[handle.id] ?? [];
        callsByHandle[handle.id].push(prompt.includes("Critique") ? "critique" : "proposal");
        return { output: "ok", tokenUsage: { inputTokens: 0, outputTokens: 0 }, internalRoundTrips: 0 };
      },
    });

    const session = new DebateSession({
      storyId: "US-RAS-002",
      stage: "review",
      stageConfig: makeStageConfig({ rounds: 2 }),
      workdir: "/tmp/work",
      featureName: "feat-b",
      timeoutSeconds: 120,
      sessionManager: mockSM,
    });

    await session.run("review prompt");

    // Each of 2 debaters has 1 proposal + 1 critique = 2 calls per handle
    for (const calls of Object.values(callsByHandle)) {
      expect(calls.length).toBe(2);
      expect(calls[0]).toBe("proposal");
      expect(calls[1]).toBe("critique");
    }
    expect(closedHandles.length).toBe(2); // both sessions closed in finally
  });
});
```

Add the import for `makeSessionManager` at the top of the test file:

```typescript
import { makeSessionManager } from "../../helpers";
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
timeout 15 bun test test/unit/debate/session-stateful.test.ts --timeout=5000
```

Expected: FAIL — `DebateSession` does not accept `sessionManager` yet; `runAsSession` not called.

### 2b: Update `runStatefulTurn` — remove keepOpen, add handle

- [ ] **Step 3: Rewrite `runStatefulTurn` in `session-stateful.ts`**

Replace lines 41–82 (the `runStatefulTurn` function):

```typescript
export async function runStatefulTurn(
  ctx: StatefulCtx,
  agentManager: IAgentManager,
  agentName: string,
  debater: Debater,
  prompt: string,
  handle: import("../agents/types").SessionHandle,
): Promise<SuccessfulProposal> {
  const pipelineStage = pipelineStageForDebate(ctx.stage);

  const turnResult = await agentManager.runAsSession(agentName, handle, prompt, {
    storyId: ctx.storyId,
    pipelineStage,
  });

  return {
    debater,
    agentName,
    output: turnResult.output,
    cost: turnResult.cost?.total ?? 0,
    handle,
  };
}
```

### 2c: Delete `closeStatefulSession`

- [ ] **Step 4: Delete `closeStatefulSession` from `session-stateful.ts`**

Remove lines 84–113 (the entire `closeStatefulSession` function). Do not replace with anything.

### 2d: Update `StatefulCtx` to include `sessionManager`

- [ ] **Step 5: Add `sessionManager` to `StatefulCtx` interface**

In `session-stateful.ts`, update the `StatefulCtx` interface:

```typescript
interface StatefulCtx {
  readonly storyId: string;
  readonly stage: string;
  readonly stageConfig: DebateStageConfig;
  readonly config: NaxConfig;
  readonly workdir: string;
  readonly featureName: string;
  readonly timeoutSeconds: number;
  readonly agentManager?: IAgentManager;
  readonly sessionManager?: import("../session/types").ISessionManager;
  readonly reviewerSession?: import("../review/dialogue").ReviewerSession;
  readonly resolverContextInput?: ResolverContextInput;
}
```

### 2e: Rewrite `runStateful` to manage session lifecycle

- [ ] **Step 6: Rewrite `runStateful` in `session-stateful.ts`**

The new `runStateful` pre-opens sessions for all resolved debaters, stores handles, passes them to `runStatefulTurn`, and closes all in `finally`. Replace the existing `runStateful` function body (lines 115–343) with:

```typescript
export async function runStateful(ctx: StatefulCtx, prompt: string): Promise<DebateResult> {
  const logger = _debateSessionDeps.getSafeLogger();
  const config = ctx.stageConfig;
  const personaStage: "plan" | "review" = ctx.stage === "plan" ? "plan" : "review";
  const rawDebaters = config.debaters ?? [];
  const debaters = resolvePersonas(rawDebaters, personaStage, config.autoPersona ?? false);
  let totalCostUsd = 0;
  const agentManager = ctx.agentManager ?? _debateSessionDeps.agentManager;
  if (!agentManager) {
    return buildFailedResult(ctx.storyId, ctx.stage, config, 0);
  }

  const resolved: ResolvedDebater[] = [];
  for (const debater of debaters) {
    if (!agentManager.getAgent(debater.agent)) {
      logger?.warn("debate", `Agent '${debater.agent}' not found — skipping debater`);
      continue;
    }
    resolved.push({ debater, agentName: debater.agent });
  }

  logger?.info("debate", "debate:start", {
    storyId: ctx.storyId,
    stage: ctx.stage,
    debaters: resolved.map((r) => r.debater.agent),
  });

  const debate = ctx.config?.debate;
  const concurrencyLimit = debate?.maxConcurrentDebaters ?? 2;
  const proposalBuilder = new DebatePromptBuilder(
    { taskContext: prompt, outputFormat: "", stage: ctx.stage },
    { debaters: resolved.map((r) => r.debater), sessionMode: "stateful" },
  );

  // Pre-open one session per resolved debater
  const openHandles: Array<import("../agents/types").SessionHandle | null> = [];
  const sessionManager = ctx.sessionManager;

  try {
    for (let i = 0; i < resolved.length; i++) {
      const { debater, agentName } = resolved[i];
      const roleKey = `debate-${ctx.stage}-${i}`;
      if (sessionManager) {
        const modelTier = modelTierFromDebater(debater);
        const modelDef: ModelDef = resolveModelDefForDebater(debater, modelTier, ctx.config);
        const name = sessionManager.nameFor({
          workdir: ctx.workdir,
          featureName: ctx.featureName,
          storyId: ctx.storyId,
          role: roleKey,
        });
        const handle = await sessionManager.openSession(name, {
          agentName,
          role: roleKey,
          workdir: ctx.workdir,
          pipelineStage: pipelineStageForDebate(ctx.stage),
          modelDef,
          timeoutSeconds: ctx.timeoutSeconds,
          featureName: ctx.featureName,
          storyId: ctx.storyId,
        });
        openHandles.push(handle);
      } else {
        openHandles.push(null);
      }
    }

    // Proposal round
    const proposalSettled = await allSettledBounded(
      resolved.map(
        ({ debater, agentName }, debaterIdx) =>
          () => {
            const handle = openHandles[debaterIdx];
            if (!handle) {
              return Promise.reject(new Error(`No session handle for debater ${debaterIdx}`));
            }
            return runStatefulTurn(
              ctx,
              agentManager,
              agentName,
              debater,
              proposalBuilder.buildProposalPrompt(debaterIdx),
              handle,
            );
          },
      ),
      concurrencyLimit,
    );

    const successfulProposals: SuccessfulProposal[] = proposalSettled
      .filter((r): r is PromiseFulfilledResult<SuccessfulProposal> => r.status === "fulfilled")
      .map((r) => r.value);

    for (const r of proposalSettled) {
      if (r.status === "fulfilled") {
        totalCostUsd += r.value.cost;
      }
    }

    // Fewer than 2 succeeded — single-agent fallback
    if (successfulProposals.length < 2) {
      if (successfulProposals.length === 1) {
        const solo = successfulProposals[0];
        logger?.warn("debate", "debate:fallback", {
          storyId: ctx.storyId,
          stage: ctx.stage,
          reason: "only 1 debater succeeded",
        });
        logger?.info("debate", "debate:result", {
          storyId: ctx.storyId,
          stage: ctx.stage,
          outcome: "passed",
        });
        return {
          storyId: ctx.storyId,
          stage: ctx.stage,
          outcome: "passed",
          rounds: 1,
          debaters: [solo.debater.agent],
          resolverType: config.resolver.type,
          proposals: [{ debater: solo.debater, output: solo.output }],
          totalCostUsd,
        };
      }

      // 0 succeeded — retry with first adapter (one-shot, no keepOpen)
      if (resolved.length > 0) {
        const { agentName: fallbackAgentName, debater: fallbackDebater } = resolved[0];
        logger?.warn("debate", "debate:fallback", {
          storyId: ctx.storyId,
          stage: ctx.stage,
          reason: "all debaters failed — retrying with first adapter",
        });
        const fallbackRoleKey = `debate-${ctx.stage}-fallback`;
        let fallbackHandle = openHandles[0];
        if (!fallbackHandle && sessionManager) {
          const modelTier = modelTierFromDebater(fallbackDebater);
          const modelDef: ModelDef = resolveModelDefForDebater(fallbackDebater, modelTier, ctx.config);
          const name = sessionManager.nameFor({
            workdir: ctx.workdir,
            featureName: ctx.featureName,
            storyId: ctx.storyId,
            role: fallbackRoleKey,
          });
          fallbackHandle = await sessionManager.openSession(name, {
            agentName: fallbackAgentName,
            role: fallbackRoleKey,
            workdir: ctx.workdir,
            pipelineStage: pipelineStageForDebate(ctx.stage),
            modelDef,
            timeoutSeconds: ctx.timeoutSeconds,
            featureName: ctx.featureName,
            storyId: ctx.storyId,
          });
          openHandles.push(fallbackHandle);
        }
        try {
          if (fallbackHandle) {
            const fallbackResult = await runStatefulTurn(
              ctx,
              agentManager,
              fallbackAgentName,
              fallbackDebater,
              prompt,
              fallbackHandle,
            );
            totalCostUsd += fallbackResult.cost;
            logger?.info("debate", "debate:result", {
              storyId: ctx.storyId,
              stage: ctx.stage,
              outcome: "passed",
            });
            return {
              storyId: ctx.storyId,
              stage: ctx.stage,
              outcome: "passed",
              rounds: 1,
              debaters: [fallbackDebater.agent],
              resolverType: config.resolver.type,
              proposals: [{ debater: fallbackDebater, output: fallbackResult.output }],
              totalCostUsd,
            };
          }
        } catch {
          // Retry also failed — fall through to failed result.
        }
      }

      logger?.warn("debate", "debate:fallback", {
        storyId: ctx.storyId,
        stage: ctx.stage,
        reason: "fewer than 2 proposal rounds succeeded",
      });
      return buildFailedResult(ctx.storyId, ctx.stage, config, totalCostUsd);
    }

    for (let i = 0; i < successfulProposals.length; i++) {
      const s = successfulProposals[i];
      logger?.info("debate", "debate:proposal", {
        storyId: ctx.storyId,
        stage: ctx.stage,
        debaterIndex: i,
        agent: s.debater.agent,
      });
    }

    // Critique round (when rounds > 1)
    let critiqueOutputs: string[] = [];
    if (config.rounds > 1) {
      const proposals = successfulProposals.map((s) => ({ debater: s.debater, output: s.output }));
      const critiqueBuilder = new DebatePromptBuilder(
        { taskContext: prompt, outputFormat: "", stage: ctx.stage },
        { debaters: proposals.map((p) => p.debater), sessionMode: ctx.stageConfig.sessionMode ?? "one-shot" },
      );
      const critiqueSettled = await allSettledBounded(
        successfulProposals.map(
          (proposal, successfulIdx) => () => {
            if (!proposal.handle) {
              return Promise.reject(new Error("No handle on successful proposal for critique round"));
            }
            return runStatefulTurn(
              ctx,
              agentManager,
              proposal.agentName,
              proposal.debater,
              critiqueBuilder.buildCritiquePrompt(successfulIdx, proposals),
              proposal.handle,
            );
          },
        ),
        concurrencyLimit,
      );

      for (const r of critiqueSettled) {
        if (r.status === "fulfilled") {
          totalCostUsd += r.value.cost;
        }
      }

      critiqueOutputs = critiqueSettled
        .filter((r): r is PromiseFulfilledResult<SuccessfulProposal> => r.status === "fulfilled")
        .map((r) => r.value.output);
    }

    // Resolve outcome
    const proposalOutputs = successfulProposals.map((s) => s.output);
    const fullResolverContext = ctx.resolverContextInput
      ? {
          ...ctx.resolverContextInput,
          labeledProposals: successfulProposals.map((s) => ({ debater: buildDebaterLabel(s.debater), output: s.output })),
        }
      : undefined;
    const outcome: ResolveOutcome = await resolveOutcome(
      proposalOutputs,
      critiqueOutputs,
      ctx.stageConfig,
      ctx.config,
      ctx.storyId,
      ctx.timeoutSeconds * 1000,
      ctx.workdir,
      ctx.featureName,
      ctx.reviewerSession,
      fullResolverContext,
      /* promptSuffix */ undefined,
      successfulProposals.map((s) => s.debater),
      agentManager,
    );
    totalCostUsd += outcome.resolverCostUsd;

    const proposals = successfulProposals.map((s) => ({
      debater: s.debater,
      output: s.output,
    }));

    logger?.info("debate", "debate:result", {
      storyId: ctx.storyId,
      stage: ctx.stage,
      outcome: outcome.outcome,
    });
    return {
      storyId: ctx.storyId,
      stage: ctx.stage,
      outcome: outcome.outcome,
      rounds: config.rounds,
      debaters: successfulProposals.map((s) => s.debater.agent),
      resolverType: config.resolver.type,
      proposals,
      totalCostUsd,
    };
  } finally {
    // Close all opened handles
    for (const handle of openHandles) {
      if (handle && sessionManager) {
        try {
          await sessionManager.closeSession(handle);
        } catch {
          // Ignore close errors
        }
      }
    }
  }
}
```

Also add the missing import for `buildDebaterLabel` — check if it's already imported; if not add to existing import from `./personas`.

- [ ] **Step 7: Run tests to verify they pass**

```bash
timeout 30 bun test test/unit/debate/session-stateful.test.ts --timeout=5000
```

Expected: New ADR-019 tests PASS. Old keepOpen tests may still fail (will be fixed next).

- [ ] **Step 8: Update old tests that still check keepOpen**

In `test/unit/debate/session-stateful.test.ts`, the test `"rounds > 1 keeps proposal session open and reuses same role in critique"` currently asserts:

```typescript
expect(runCalls[0].keepOpen).toBe(true);
```

These old tests used `agentManager.run()`. Now the code uses `agentManager.runAsSession()`. Update the test to use the new pattern (using `runAsSessionFn` and `makeSessionManager`):

Replace the test `"rounds > 1 keeps proposal session open and reuses same role in critique"` entirely:

```typescript
test("rounds > 1: critique runs on same session handle as proposal (legacy check removed)", async () => {
  // This test verifies handle reuse — migrated from keepOpen checks.
  const handleCallMap: Record<string, string[]> = {};
  const mockSM = makeSessionManager({
    openSession: mock(async (name: string) => ({ id: name, agentName: "claude" })),
    closeSession: mock(async () => {}),
  });
  _debateSessionDeps.agentManager = makeMockAgentManager({
    runAsSessionFn: async (_agentName, handle, prompt) => {
      handleCallMap[handle.id] = handleCallMap[handle.id] ?? [];
      handleCallMap[handle.id].push(prompt.includes("Critique") ? "critique" : "proposal");
      return { output: "ok", tokenUsage: { inputTokens: 0, outputTokens: 0 }, internalRoundTrips: 0 };
    },
  });
  const session = new DebateSession({
    storyId: "US-004",
    stage: "review",
    stageConfig: makeStageConfig({ rounds: 2 }),
    workdir: "/tmp/work",
    featureName: "feat-b",
    timeoutSeconds: 120,
    sessionManager: mockSM,
  });
  await session.run("review prompt");
  // Each debater's handle should have both a proposal and a critique
  for (const calls of Object.values(handleCallMap)) {
    expect(calls).toContain("proposal");
    expect(calls).toContain("critique");
  }
});
```

Also remove the test that checks `"Close this debate session."` prompt — that prompt no longer exists:

```typescript
// DELETE this test entirely — closeStatefulSession is gone:
// test("falls back to single-agent passed when only one proposal run succeeds", ...)
// (or update it to not reference "Close this debate session.")
```

Update the single-debater fallback test to use `runAsSessionFn` pattern and `makeSessionManager`:

```typescript
test("falls back to single-agent passed when only one proposal run succeeds", async () => {
  const mockSM = makeSessionManager({
    openSession: mock(async (name: string) => ({ id: name, agentName: name.includes("opencode") ? "opencode" : "claude" })),
    closeSession: mock(async () => {}),
  });
  _debateSessionDeps.agentManager = makeMockAgentManager({
    runAsSessionFn: async (agentName, _handle, _prompt) => {
      if (agentName === "opencode") throw new Error("opencode failed");
      return { output: `proposal-${agentName}`, tokenUsage: { inputTokens: 0, outputTokens: 0 }, internalRoundTrips: 0 };
    },
  });
  const session = new DebateSession({
    storyId: "US-005",
    stage: "review",
    stageConfig: makeStageConfig({ rounds: 2 }),
    workdir: "/tmp/work",
    featureName: "feat-c",
    sessionManager: mockSM,
  });
  const result = await session.run("review prompt");
  expect(result.outcome).toBe("passed");
  expect(result.debaters).toEqual(["claude"]);
});
```

- [ ] **Step 9: Run all stateful tests**

```bash
timeout 30 bun test test/unit/debate/session-stateful.test.ts --timeout=5000
```

Expected: All tests PASS.

- [ ] **Step 10: Run typecheck**

```bash
bun run typecheck
```

Expected: no errors.

- [ ] **Step 11: Commit**

```bash
git add src/debate/session-stateful.ts test/unit/debate/session-stateful.test.ts
git commit -m "refactor(adr-018): Wave 3 Phase D — session-stateful runAsSession migration, delete closeStatefulSession"
```

---

## Task 3: Migrate `session-hybrid.ts` — open/close sessions in runHybrid, update runRebuttalLoop

**Files:**
- Modify: `src/debate/session-hybrid.ts`
- Modify: `test/unit/debate/session-hybrid.test.ts`
- Modify: `test/unit/debate/session-hybrid-rebuttal.test.ts`

### 3a: Update HybridCtx and runRebuttalLoop

- [ ] **Step 1: Add `sessionManager` to `HybridCtx` and update `runRebuttalLoop`**

In `src/debate/session-hybrid.ts`:

1. Remove `closeStatefulSession` from the import of `session-stateful`:
```typescript
// BEFORE
import { closeStatefulSession, runStatefulTurn } from "./session-stateful";
// AFTER
import { runStatefulTurn } from "./session-stateful";
```

2. Add `sessionManager` to `HybridCtx`:
```typescript
export interface HybridCtx {
  readonly storyId: string;
  readonly stage: string;
  readonly stageConfig: DebateStageConfig;
  readonly config: NaxConfig;
  readonly workdir: string;
  readonly featureName: string;
  readonly timeoutSeconds: number;
  readonly agentManager?: IAgentManager;
  readonly sessionManager?: import("../session/types").ISessionManager;
  readonly reviewerSession?: import("../review/dialogue").ReviewerSession;
  readonly resolverContextInput?: ResolverContextInput;
}
```

3. Rewrite `runRebuttalLoop` — replace the existing function body. The function now:
   - Uses `proposal.handle` if present (set by `runHybrid` pre-open)
   - Opens fresh sessions if `proposal.handle` is absent (plan-mode case)
   - Closes only internally-opened sessions in `finally`

```typescript
export async function runRebuttalLoop(
  ctx: HybridCtx,
  proposals: SuccessfulProposal[],
  builder: DebatePromptBuilder,
  sessionRolePrefix: string,
): Promise<RebuttalLoopResult> {
  const logger = _debateSessionDeps.getSafeLogger();
  const config = ctx.stageConfig;
  const rebuttals: Rebuttal[] = [];
  let costUsd = 0;
  const agentManager = ctx.agentManager ?? _debateSessionDeps.agentManager;
  if (!agentManager) {
    return { rebuttals: [], costUsd: 0 };
  }

  const proposalList = proposals.map((s) => ({ debater: s.debater, output: s.output }));
  const sessionManager = ctx.sessionManager;

  // Resolve effective handles — use caller-supplied handles when present (hybrid mode),
  // open fresh sessions otherwise (plan-mode rebuttals where proposals came from planAs).
  const internalHandles: Array<import("../agents/types").SessionHandle | null> = [];
  for (let i = 0; i < proposals.length; i++) {
    const proposal = proposals[i];
    const sessionRole = `${sessionRolePrefix}-${i}`;
    if (proposal.handle) {
      internalHandles.push(null); // Caller owns this handle; we do not close it
    } else if (sessionManager) {
      const modelTier = modelTierFromDebater(proposal.debater);
      const modelDef = resolveModelDefForDebater(proposal.debater, modelTier, ctx.config);
      const name = sessionManager.nameFor({
        workdir: ctx.workdir,
        featureName: ctx.featureName,
        storyId: ctx.storyId,
        role: sessionRole,
      });
      const handle = await sessionManager.openSession(name, {
        agentName: proposal.agentName,
        role: sessionRole,
        workdir: ctx.workdir,
        pipelineStage: pipelineStageForDebate(ctx.stage),
        modelDef,
        timeoutSeconds: ctx.timeoutSeconds,
        featureName: ctx.featureName,
        storyId: ctx.storyId,
      });
      internalHandles.push(handle);
    } else {
      internalHandles.push(null);
    }
  }

  try {
    for (let round = 1; round <= config.rounds; round++) {
      const priorRebuttals = rebuttals.filter((r) => r.round < round);

      for (let debaterIdx = 0; debaterIdx < proposals.length; debaterIdx++) {
        const proposal = proposals[debaterIdx];
        const effectiveHandle = proposal.handle ?? internalHandles[debaterIdx];
        if (!effectiveHandle) continue;

        logger?.info("debate:rebuttal-start", "debate:rebuttal-start", {
          storyId: ctx.storyId,
          round,
          debaterIndex: debaterIdx,
        });

        const rebuttalPrompt = builder.buildRebuttalPrompt(debaterIdx, proposalList, priorRebuttals);

        try {
          const turnResult = await agentManager.runAsSession(
            proposal.agentName,
            effectiveHandle,
            rebuttalPrompt,
            { storyId: ctx.storyId, pipelineStage: pipelineStageForDebate(ctx.stage) },
          );
          costUsd += turnResult.cost?.total ?? 0;
          rebuttals.push({ debater: proposal.debater, round, output: turnResult.output });
        } catch (err) {
          logger?.warn("debate", "debate:rebuttal-failed", {
            storyId: ctx.storyId,
            round,
            debaterIndex: debaterIdx,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  } finally {
    // Close only internally-opened handles (caller-supplied handles are closed by the caller)
    for (const handle of internalHandles) {
      if (handle && sessionManager) {
        try {
          await sessionManager.closeSession(handle);
        } catch {
          // Ignore close errors
        }
      }
    }
  }

  return { rebuttals, costUsd };
}
```

Add missing imports at the top of `session-hybrid.ts`:
```typescript
import { modelTierFromDebater, resolveModelDefForDebater, pipelineStageForDebate } from "./session-helpers";
```

(Check which of these are already imported; only add the missing ones.)

### 3b: Rewrite `runHybrid` — pre-open sessions, pass handles

- [ ] **Step 2: Rewrite `runHybrid` to pre-open sessions before proposal round**

Replace the proposal round section in `runHybrid`. The function now:
- Pre-opens one session per resolved debater in `try/finally`
- Passes each handle to `runStatefulTurn`
- The fulfilled `SuccessfulProposal` carries the handle (set by `runStatefulTurn` return value)
- Passes proposals (with handles) to `runRebuttalLoop` — which uses `proposal.handle` directly
- Closes all pre-opened handles in the outer `finally`

```typescript
export async function runHybrid(ctx: HybridCtx, prompt: string): Promise<DebateResult> {
  const logger = _debateSessionDeps.getSafeLogger();
  const config = ctx.stageConfig;
  const personaStage: "plan" | "review" = ctx.stage === "plan" ? "plan" : "review";
  const rawDebaters = config.debaters ?? [];
  const debaters = resolvePersonas(rawDebaters, personaStage, config.autoPersona ?? false);
  let totalCostUsd = 0;
  const sessionManager = ctx.sessionManager;

  const agentManager = ctx.agentManager ?? _debateSessionDeps.agentManager;
  if (!agentManager) {
    return buildFailedResult(ctx.storyId, ctx.stage, config, 0);
  }

  const resolved: ResolvedDebater[] = [];
  for (const debater of debaters) {
    if (!agentManager.getAgent(debater.agent)) {
      logger?.warn("debate", `Agent '${debater.agent}' not found — skipping debater`);
      continue;
    }
    resolved.push({ debater, agentName: debater.agent });
  }

  const debate = ctx.config?.debate;
  const concurrencyLimit = debate?.maxConcurrentDebaters ?? 2;

  // Pre-open one session per resolved debater
  const openHandles: Array<import("../agents/types").SessionHandle | null> = [];

  try {
    for (let i = 0; i < resolved.length; i++) {
      const { debater, agentName } = resolved[i];
      const sessionRole = `debate-hybrid-${i}`;
      if (sessionManager) {
        const modelTier = modelTierFromDebater(debater);
        const modelDef = resolveModelDefForDebater(debater, modelTier, ctx.config);
        const name = sessionManager.nameFor({
          workdir: ctx.workdir,
          featureName: ctx.featureName,
          storyId: ctx.storyId,
          role: sessionRole,
        });
        const handle = await sessionManager.openSession(name, {
          agentName,
          role: sessionRole,
          workdir: ctx.workdir,
          pipelineStage: pipelineStageForDebate(ctx.stage),
          modelDef,
          timeoutSeconds: ctx.timeoutSeconds,
          featureName: ctx.featureName,
          storyId: ctx.storyId,
        });
        openHandles.push(handle);
      } else {
        openHandles.push(null);
      }
    }

    const proposalSettled = await allSettledBounded(
      resolved.map(
        ({ debater, agentName }, debaterIdx) =>
          () => {
            const handle = openHandles[debaterIdx];
            if (!handle) {
              return Promise.reject(new Error(`No session handle for hybrid debater ${debaterIdx}`));
            }
            return runStatefulTurn(ctx, agentManager, agentName, debater, prompt, handle);
          },
      ),
      concurrencyLimit,
    );

    const successfulProposals: SuccessfulProposal[] = proposalSettled
      .filter((r): r is PromiseFulfilledResult<SuccessfulProposal> => r.status === "fulfilled")
      .map((r) => r.value);

    for (const r of proposalSettled) {
      if (r.status === "fulfilled") {
        totalCostUsd += r.value.cost;
      }
    }

    // Fewer than 2 succeeded — single-agent fallback
    if (successfulProposals.length < 2) {
      if (successfulProposals.length === 1) {
        const solo = successfulProposals[0];
        logger?.warn("debate", "debate:fallback", {
          storyId: ctx.storyId,
          stage: ctx.stage,
          reason: "only 1 debater succeeded",
        });
        return {
          storyId: ctx.storyId,
          stage: ctx.stage,
          outcome: "passed",
          rounds: 1,
          debaters: [solo.debater.agent],
          resolverType: config.resolver.type,
          proposals: [{ debater: solo.debater, output: solo.output }],
          totalCostUsd,
        };
      }

      // 0 succeeded — retry with first resolved agent (use existing open handle)
      if (resolved.length > 0) {
        const { agentName: fallbackAgentName, debater: fallbackDebater } = resolved[0];
        const fallbackHandle = openHandles[0];
        logger?.warn("debate", "debate:fallback", {
          storyId: ctx.storyId,
          stage: ctx.stage,
          reason: "all debaters failed — retrying with first adapter",
        });
        try {
          if (fallbackHandle) {
            const fallbackResult = await runStatefulTurn(
              ctx,
              agentManager,
              fallbackAgentName,
              fallbackDebater,
              prompt,
              fallbackHandle,
            );
            totalCostUsd += fallbackResult.cost;
            return {
              storyId: ctx.storyId,
              stage: ctx.stage,
              outcome: "passed",
              rounds: 1,
              debaters: [fallbackDebater.agent],
              resolverType: config.resolver.type,
              proposals: [{ debater: fallbackDebater, output: fallbackResult.output }],
              totalCostUsd,
            };
          }
        } catch {
          // Retry also failed — fall through to failed result
        }
      }

      return buildFailedResult(ctx.storyId, ctx.stage, config, totalCostUsd);
    }

    // Collect proposal outputs
    const proposalOutputs = successfulProposals.map((s) => s.output);
    const proposalList = successfulProposals.map((s) => ({ debater: s.debater, output: s.output }));

    // Rebuttal loop — successfulProposals carry handles, so runRebuttalLoop uses them directly
    const rebuttalBuilder = new DebatePromptBuilder(
      { taskContext: prompt, outputFormat: "", stage: ctx.stage },
      { debaters: successfulProposals.map((s) => s.debater), sessionMode: "stateful" },
    );
    const { rebuttals, costUsd: rebuttalCost } = await runRebuttalLoop(
      ctx,
      successfulProposals,
      rebuttalBuilder,
      "debate-hybrid",
    );
    totalCostUsd += rebuttalCost;

    const critiqueOutputs = rebuttals.map((r) => r.output);

    const fullResolverContext = ctx.resolverContextInput
      ? {
          ...ctx.resolverContextInput,
          labeledProposals: successfulProposals.map((s) => ({ debater: buildDebaterLabel(s.debater), output: s.output })),
        }
      : undefined;
    const resolveResult: ResolveOutcome = await resolveOutcome(
      proposalOutputs,
      critiqueOutputs,
      ctx.stageConfig,
      ctx.config,
      ctx.storyId,
      ctx.timeoutSeconds * 1000,
      ctx.workdir,
      ctx.featureName,
      ctx.reviewerSession,
      fullResolverContext,
      /* promptSuffix */ undefined,
      successfulProposals.map((s) => s.debater),
      agentManager,
    );
    totalCostUsd += resolveResult.resolverCostUsd;

    return {
      storyId: ctx.storyId,
      stage: ctx.stage,
      outcome: "passed",
      rounds: config.rounds,
      debaters: successfulProposals.map((s) => s.debater.agent),
      resolverType: config.resolver.type,
      proposals: proposalList,
      rebuttals,
      totalCostUsd,
    };
  } finally {
    // Close all pre-opened handles
    for (const handle of openHandles) {
      if (handle && sessionManager) {
        try {
          await sessionManager.closeSession(handle);
        } catch {
          // Ignore close errors
        }
      }
    }
  }
}
```

- [ ] **Step 3: Write failing tests for session-hybrid**

In `test/unit/debate/session-hybrid.test.ts`, find AC3 tests that check `keepOpen: true` on proposal calls (lines ~126–159). Replace those keepOpen tests with runAsSession-based tests:

```typescript
describe("AC3 — hybrid proposal round uses runAsSession with pre-opened handles", () => {
  test("opens one session per debater before proposal round", async () => {
    const openCalls: string[] = [];
    const runAsSessionCalls: number[] = [];
    const closeCalls: number[] = [];

    const mockSM = makeSessionManager({
      openSession: mock(async (name: string) => {
        openCalls.push(name);
        return { id: "h-" + openCalls.length, agentName: "claude" };
      }),
      closeSession: mock(async () => { closeCalls.push(1); }),
    });

    const manager = makeMockAgentManager({
      runAsSessionFn: async () => {
        runAsSessionCalls.push(1);
        return { output: "proposal", tokenUsage: { inputTokens: 0, outputTokens: 0 }, internalRoundTrips: 0 };
      },
    });

    // Use HybridCtx directly
    const { runHybrid } = await import("../../../src/debate/session-hybrid");
    const ctx = makeHybridCtx({ agentManager: manager, sessionManager: mockSM });
    await runHybrid(ctx, "prompt");

    expect(openCalls.length).toBe(2); // one per debater
    expect(runAsSessionCalls.length).toBe(2);
    expect(closeCalls.length).toBe(2); // closed in finally
  });
});
```

(Add `import { makeSessionManager } from "../../helpers";` to the test file if not already present.)

- [ ] **Step 4: Run session-hybrid tests**

```bash
timeout 30 bun test test/unit/debate/session-hybrid.test.ts --timeout=5000
```

Expected: New tests PASS, old keepOpen tests may need updating.

- [ ] **Step 5: Update session-hybrid-rebuttal tests**

In `test/unit/debate/session-hybrid-rebuttal.test.ts`, find the AC6 tests checking `keepOpen: true` for rebuttal turns (lines ~397–430). Replace with:

```typescript
describe("AC6 — rebuttal loop uses runAsSession with proposal handles", () => {
  test("each rebuttal turn calls runAsSession on the proposal's handle", async () => {
    const handleCallCount: Record<string, number> = {};
    const closedHandles: string[] = [];
    let openCount = 0;

    const mockSM = makeSessionManager({
      openSession: mock(async () => {
        openCount++;
        return { id: `h-${openCount}`, agentName: "claude" };
      }),
      closeSession: mock(async (h) => { closedHandles.push(h.id); }),
    });

    const manager = makeMockAgentManager({
      runAsSessionFn: async (_agentName, handle, prompt) => {
        handleCallCount[handle.id] = (handleCallCount[handle.id] ?? 0) + 1;
        const isPlan = !prompt.includes("Rebuttal");
        return {
          output: isPlan ? `proposal-${handle.id}` : `rebuttal-${handle.id}`,
          tokenUsage: { inputTokens: 0, outputTokens: 0 },
          internalRoundTrips: 0,
        };
      },
    });

    // Run hybrid with rounds > 1 so rebuttal loop fires
    const { runHybrid } = await import("../../../src/debate/session-hybrid");
    const ctx = makeHybridCtx({
      agentManager: manager,
      sessionManager: mockSM,
      stageConfig: makeStageConfig({ rounds: 2 }),
    });
    await runHybrid(ctx, "hybrid prompt");

    // Each handle should have been called for proposal (1) + rebuttal (1) = 2 calls
    for (const count of Object.values(handleCallCount)) {
      expect(count).toBe(2);
    }
    // All handles closed in finally
    expect(closedHandles.length).toBe(Object.keys(handleCallCount).length);
  });
});
```

- [ ] **Step 6: Run rebuttal tests**

```bash
timeout 30 bun test test/unit/debate/session-hybrid-rebuttal.test.ts --timeout=5000
```

Expected: PASS.

- [ ] **Step 7: Run typecheck**

```bash
bun run typecheck
```

Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/debate/session-hybrid.ts test/unit/debate/session-hybrid.test.ts test/unit/debate/session-hybrid-rebuttal.test.ts
git commit -m "refactor(adr-018): Wave 3 Phase D — session-hybrid runRebuttalLoop/runHybrid runAsSession migration"
```

---

## Task 4: Thread `sessionManager` through `session.ts` and `session-plan.ts`

**Files:**
- Modify: `src/debate/session.ts`
- Modify: `src/debate/session-plan.ts`

- [ ] **Step 1: Update `session.ts` to store and forward `sessionManager`**

In `src/debate/session.ts`:

1. Add `private readonly sessionManager` field:
```typescript
private readonly sessionManager: import("./session-helpers").DebateSessionOptions["sessionManager"];
```

2. In the constructor, add:
```typescript
this.sessionManager = opts.sessionManager;
```

3. In the `run()` method, add `sessionManager` to all ctx objects passed to `runHybrid` and `runStateful`:

For the `runHybrid` call (mode === "hybrid" + sessionMode === "stateful"):
```typescript
return runHybrid(
  {
    storyId: this.storyId,
    stage: this.stage,
    stageConfig: this.stageConfig,
    config: this.config,
    workdir: this.workdir,
    featureName: this.featureName,
    timeoutSeconds: this.timeoutSeconds,
    agentManager: this.agentManager,
    sessionManager: this.sessionManager,  // ADD THIS
    reviewerSession: this.reviewerSession,
    resolverContextInput: this.resolverContextInput,
  },
  prompt,
);
```

For the `runStateful` call (panel + stateful):
```typescript
return runStateful(
  {
    storyId: this.storyId,
    stage: this.stage,
    stageConfig: this.stageConfig,
    config: this.config,
    workdir: this.workdir,
    featureName: this.featureName,
    timeoutSeconds: this.timeoutSeconds,
    agentManager: this.agentManager,
    sessionManager: this.sessionManager,  // ADD THIS
    reviewerSession: this.reviewerSession,
    resolverContextInput: this.resolverContextInput,
  },
  prompt,
);
```

- [ ] **Step 2: Update `session-plan.ts` to thread `sessionManager`**

In `src/debate/session-plan.ts`:

1. Add `sessionManager?: ISessionManager` to `PlanCtx`:
```typescript
interface PlanCtx {
  readonly storyId: string;
  readonly stage: string;
  readonly stageConfig: DebateStageConfig;
  readonly config: NaxConfig;
  readonly agentManager?: IAgentManager;
  readonly sessionManager?: import("../session/types").ISessionManager;
}
```

2. In `runPlan`, when constructing `HybridCtx` for `runRebuttalLoop`, add `sessionManager`:
```typescript
const hybridCtx: HybridCtx = {
  storyId: ctx.storyId,
  stage: ctx.stage,
  stageConfig: ctx.stageConfig,
  config: ctx.config,
  workdir: opts.workdir,
  featureName: opts.feature,
  timeoutSeconds: opts.timeoutSeconds ?? 600,
  sessionManager: ctx.sessionManager,  // ADD THIS
};
```

3. In `session.ts` `runPlan` delegation, add `sessionManager` to the `PlanCtx`:
```typescript
return runPlan(
  {
    storyId: this.storyId,
    stage: this.stage,
    stageConfig: this.stageConfig,
    config: this.config,
    agentManager: this.agentManager,
    sessionManager: this.sessionManager,  // ADD THIS
  },
  taskContext,
  outputFormat,
  opts,
);
```

- [ ] **Step 3: Run typecheck**

```bash
bun run typecheck
```

Expected: no errors.

- [ ] **Step 4: Run stateful + hybrid tests**

```bash
timeout 30 bun test test/unit/debate/ --timeout=5000
```

Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add src/debate/session.ts src/debate/session-plan.ts
git commit -m "refactor(adr-018): thread sessionManager through DebateSession and session-plan"
```

---

## Task 5: Migrate `dialogue.ts` — replace keepOpen with runAsSession

**Files:**
- Modify: `src/review/dialogue.ts`
- Modify: `test/unit/review/dialogue.test.ts`

### 5a: Write failing tests

- [ ] **Step 1: Write failing tests for the new dialogue.ts API**

Add a new describe block at the bottom of `test/unit/review/dialogue.test.ts`:

```typescript
// ---------------------------------------------------------------------------
// ADR-019 §4 — dialogue uses openSession / runAsSession / closeSession
// ---------------------------------------------------------------------------

describe("ReviewerSession ADR-019 — openSession + runAsSession pattern", () => {
  test("review() calls sessionManager.openSession then agentManager.runAsSession", async () => {
    let openCalled = 0;
    let runAsSessionCalled = 0;
    let closeCalled = 0;
    const stubHandle = { id: "sess-rev-001", agentName: "claude" };

    const sm = makeSessionManager({
      openSession: mock(async () => { openCalled++; return stubHandle; }),
      closeSession: mock(async () => { closeCalled++; }),
      nameFor: mock(() => "nax-00000000-reviewer"),
    });
    const am = makeMockAgentManager({
      runAsSessionFn: async () => {
        runAsSessionCalled++;
        return {
          output: PASSING_RUN_RESPONSE,
          tokenUsage: { inputTokens: 0, outputTokens: 0 },
          internalRoundTrips: 0,
        };
      },
    });

    const session = createReviewerSession(am, sm, "US-001", "/work", "feat", makeConfig());
    await session.review(SAMPLE_DIFF, STORY, SEMANTIC_CONFIG);

    expect(openCalled).toBe(1);
    expect(runAsSessionCalled).toBe(1);
    expect(closeCalled).toBe(0); // session stays open until destroy()
  });

  test("review() reuses same handle on second call (no re-open)", async () => {
    let openCalled = 0;
    const sm = makeSessionManager({
      openSession: mock(async () => { openCalled++; return { id: `sess-${openCalled}`, agentName: "claude" }; }),
    });
    const am = makeMockAgentManager({
      runAsSessionFn: async () => ({
        output: PASSING_RUN_RESPONSE,
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        internalRoundTrips: 0,
      }),
    });

    const session = createReviewerSession(am, sm, "US-001", "/work", "feat", makeConfig());
    await session.review(SAMPLE_DIFF, STORY, SEMANTIC_CONFIG);
    await session.review(SAMPLE_DIFF, STORY, SEMANTIC_CONFIG);

    expect(openCalled).toBe(1); // opened once, reused on second call
    await session.destroy();
  });

  test("destroy() calls sessionManager.closeSession", async () => {
    let closeCalled = 0;
    const sm = makeSessionManager({
      closeSession: mock(async () => { closeCalled++; }),
    });
    const am = makeMockAgentManager({
      runAsSessionFn: async () => ({
        output: PASSING_RUN_RESPONSE,
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        internalRoundTrips: 0,
      }),
    });

    const session = createReviewerSession(am, sm, "US-001", "/work", "feat", makeConfig());
    await session.review(SAMPLE_DIFF, STORY, SEMANTIC_CONFIG); // opens handle
    await session.destroy();

    expect(closeCalled).toBe(1);
  });

  test("compaction: closeSession called, new session opened on next review()", async () => {
    const openIds: string[] = [];
    let closeCalled = 0;
    let openCount = 0;

    const sm = makeSessionManager({
      openSession: mock(async () => { openCount++; const id = `sess-${openCount}`; openIds.push(id); return { id, agentName: "claude" }; }),
      closeSession: mock(async () => { closeCalled++; }),
    });

    // Config with maxDialogueMessages=5 so compaction triggers quickly
    const config = NaxConfigSchema.parse({ review: { dialogue: { maxDialogueMessages: 5 } } });
    const am = makeMockAgentManager({
      runAsSessionFn: async () => ({
        output: PASSING_RUN_RESPONSE,
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        internalRoundTrips: 0,
      }),
    });

    const session = createReviewerSession(am, sm, "US-001", "/work", "feat", config);
    await session.review(SAMPLE_DIFF, STORY, SEMANTIC_CONFIG); // history: 2 msgs, opens sess-1

    // Add enough history to trigger compaction on reReview
    // Each reReview adds 2 messages; maxDialogueMessages=5, so after 3 calls total we exceed 6 > 5
    await session.reReview(SAMPLE_DIFF); // history: 4 msgs
    await session.reReview(SAMPLE_DIFF); // history: 6 msgs > 5 → compaction + closeSession

    expect(closeCalled).toBeGreaterThanOrEqual(1); // old session closed
    await session.review(SAMPLE_DIFF, STORY, SEMANTIC_CONFIG); // opens new session
    expect(openIds.length).toBeGreaterThan(1); // second session opened
    await session.destroy();
  });
});
```

Add imports at the top of the test file:
```typescript
import { makeSessionManager } from "../../helpers";
import type { ISessionManager } from "../../../src/session/types";
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
timeout 30 bun test test/unit/review/dialogue.test.ts --timeout=5000
```

Expected: FAIL — `createReviewerSession` doesn't accept `sessionManager` yet.

### 5b: Update the production code

- [ ] **Step 3: Rewrite `createReviewerSession` in `dialogue.ts`**

Add `ISessionManager` to the imports at the top:
```typescript
import type { ISessionManager } from "../session/types";
import type { SessionHandle } from "../agents/types";
```

Change the function signature (line 212):
```typescript
export function createReviewerSession(
  agentManager: IAgentManager,
  sessionManager: ISessionManager,
  storyId: string,
  workdir: string,
  featureName: string,
  _config: NaxConfig,
): ReviewerSession {
```

Inside the function, after existing `const history` / `let active` declarations, add:
```typescript
let _handle: SessionHandle | null = null;
```

Replace `buildEffectiveRunArgs` with two separate helpers:

```typescript
function buildEffectivePrompt(prompt: string): string {
  if (sessionState.pendingCompactionContext !== null) {
    const context = sessionState.pendingCompactionContext;
    sessionState.pendingCompactionContext = null;
    return `${context}\n\n---\n\n${prompt}`;
  }
  return prompt;
}

async function getOrOpenHandle(semanticConfig: SemanticReviewConfig): Promise<SessionHandle> {
  if (_handle !== null) return _handle;
  const { modelDef, timeoutSeconds } = resolveRunParams(semanticConfig);
  const role = sessionState.generation > 1 ? `reviewer-gen${sessionState.generation}` : "reviewer";
  const name = sessionManager.nameFor({ workdir, featureName, storyId, role });
  _handle = await sessionManager.openSession(name, {
    agentName: agentManager.getDefault(),
    role,
    workdir,
    pipelineStage: "review",
    modelDef,
    timeoutSeconds,
    featureName,
    storyId,
  });
  return _handle;
}
```

Note: `resolveRunParams` returns `{ modelTier, modelDef, timeoutSeconds }` — only `modelDef` and `timeoutSeconds` needed for `openSession`.

Now replace each of the 5 `agentManager.run({ ..., keepOpen: true, ... })` calls with `agentManager.runAsSession`.

**review() method** (was line 302–317):
```typescript
const handle = await getOrOpenHandle(semanticConfig);
const { modelTier, modelDef, timeoutSeconds } = resolveRunParams(semanticConfig);
const effectivePrompt = buildEffectivePrompt(prompt);

const turnResult = await agentManager.runAsSession(
  agentManager.getDefault(),
  handle,
  effectivePrompt,
  { storyId, pipelineStage: "review" },
);

history.push({ role: "implementer", content: prompt });
history.push({ role: "reviewer", content: turnResult.output });

const parsed = parseReviewResponse(turnResult.output);
const reviewResult: ReviewDialogueResult = { ...parsed, cost: turnResult.cost?.total ?? 0 };
```

**reReview() method** (was line 350–365):
```typescript
const handle = await getOrOpenHandle(lastSemanticConfig);
const effectivePrompt = buildEffectivePrompt(prompt);

const turnResult = await agentManager.runAsSession(
  agentManager.getDefault(),
  handle,
  effectivePrompt,
  { storyId, pipelineStage: "review" },
);

history.push({ role: "implementer", content: prompt });
history.push({ role: "reviewer", content: turnResult.output });

const parsed = parseReviewResponse(turnResult.output);
const deltaSummary = extractDeltaSummary(turnResult.output, previousFindings, parsed.checkResult.findings);
const dialogueResult: ReviewDialogueResult = { ...parsed, deltaSummary, cost: turnResult.cost?.total ?? 0 };
lastCheckResult = dialogueResult;

const maxMessages = _config.review?.dialogue?.maxDialogueMessages ?? 20;
if (history.length > maxMessages) {
  const compactedSummary = compactHistory(history);
  sessionState.generation++;
  sessionState.pendingCompactionContext = compactedSummary;
  // Close the current session — next getOrOpenHandle opens a fresh one for the new generation
  if (_handle !== null) {
    try { await sessionManager.closeSession(_handle); } catch {}
    _handle = null;
  }
}
```

**clarify() method** (was line 412–427):
```typescript
const effectiveSemanticConfig = lastSemanticConfig ?? { ... }; // keep existing fallback
const handle = await getOrOpenHandle(effectiveSemanticConfig);
const effectivePrompt = buildEffectivePrompt(question);

const turnResult = await agentManager.runAsSession(
  agentManager.getDefault(),
  handle,
  effectivePrompt,
  { storyId, pipelineStage: "review" },
);

history.push({ role: "implementer", content: question });
history.push({ role: "reviewer", content: turnResult.output });

return turnResult.output;
```

**resolveDebate() method** (was line 454–469):
```typescript
const handle = await getOrOpenHandle(semanticConfig);
const effectivePrompt = buildEffectivePrompt(prompt);

const turnResult = await agentManager.runAsSession(
  agentManager.getDefault(),
  handle,
  effectivePrompt,
  { storyId, pipelineStage: "review" },
);

history.push({ role: "implementer", content: prompt });
history.push({ role: "reviewer", content: turnResult.output });

const parsed = parseReviewResponse(turnResult.output);
const reviewResult: ReviewDialogueResult = { ...parsed, cost: turnResult.cost?.total ?? 0 };
lastCheckResult = reviewResult;
lastStory = story;
lastSemanticConfig = semanticConfig;
lastWasDebateResolve = true;
return reviewResult;
```

**reReviewDebate() method** (was line 514–529):
```typescript
const handle = await getOrOpenHandle(lastSemanticConfig);
const effectivePrompt = buildEffectivePrompt(prompt);

const turnResult = await agentManager.runAsSession(
  agentManager.getDefault(),
  handle,
  effectivePrompt,
  { storyId, pipelineStage: "review" },
);

history.push({ role: "implementer", content: prompt });
history.push({ role: "reviewer", content: turnResult.output });

const parsed = parseReviewResponse(turnResult.output);
const deltaSummary = extractDeltaSummary(turnResult.output, previousFindings, parsed.checkResult.findings);
const dialogueResult: ReviewDialogueResult = { ...parsed, deltaSummary, cost: turnResult.cost?.total ?? 0 };
lastCheckResult = dialogueResult;

const maxMessages = _config.review?.dialogue?.maxDialogueMessages ?? 20;
if (history.length > maxMessages) {
  const compactedSummary = compactHistory(history);
  sessionState.generation++;
  sessionState.pendingCompactionContext = compactedSummary;
  if (_handle !== null) {
    try { await sessionManager.closeSession(_handle); } catch {}
    _handle = null;
  }
}

return dialogueResult;
```

**destroy() method** (was line 564–568):
```typescript
async destroy(): Promise<void> {
  if (!active) return;
  active = false;
  history.length = 0;
  if (_handle !== null) {
    try { await sessionManager.closeSession(_handle); } catch {}
    _handle = null;
  }
},
```

Also remove `buildEffectiveRunArgs` entirely — it's replaced by `buildEffectivePrompt` and `getOrOpenHandle`.

### 5c: Update existing test helpers in dialogue.test.ts

- [ ] **Step 4: Update `createReviewerSession` calls in dialogue.test.ts to pass sessionManager**

In all `createReviewerSession` calls in `test/unit/review/dialogue.test.ts`, insert `makeSessionManager()` as the second argument:

```typescript
// BEFORE
createReviewerSession(agentManager, "US-001", "/work", "my-feature", makeConfig())
// AFTER
createReviewerSession(agentManager, makeSessionManager(), "US-001", "/work", "my-feature", makeConfig())
```

Also update `makeAgentManager` to use `runAsSessionFn` instead of `runFn`, since the session calls now go through `runAsSession`:

```typescript
function makeAgentManager(runAsSessionResponse?: string): IAgentManager {
  const output = runAsSessionResponse ?? PASSING_RUN_RESPONSE;
  return makeMockAgentManager({
    getDefaultAgent: "claude",
    runAsSessionFn: async () => ({
      output,
      tokenUsage: { inputTokens: 0, outputTokens: 0 },
      internalRoundTrips: 0,
    }),
  });
}
```

Update the test `"calls agent.run() exactly once per review() call"` → `"calls runAsSession exactly once per review() call"`:

```typescript
test("calls runAsSession exactly once per review() call", async () => {
  let callCount = 0;
  const am = makeMockAgentManager({
    runAsSessionFn: async () => {
      callCount++;
      return { output: PASSING_RUN_RESPONSE, tokenUsage: { inputTokens: 0, outputTokens: 0 }, internalRoundTrips: 0 };
    },
  });
  const s = createReviewerSession(am, makeSessionManager(), "US-001", "/work", "my-feature", makeConfig());
  await s.review(SAMPLE_DIFF, STORY, SEMANTIC_CONFIG);
  expect(callCount).toBe(1);
  await s.destroy();
});
```

Delete or update the old AC5 tests that check `keepOpen: true` and `sessionHandle`:

```typescript
// DELETE these tests (keepOpen no longer used):
// "passes keepOpen: true to agent.run()"
// "passes sessionHandle to agent.run() when generation > 1"

// KEEP but UPDATE these tests (sessionRole, pipelineStage now checked on runAsSession opts):
// "passes pipelineStage: 'review' to agent.run()" → check on runAsSession opts (pipelineStage)
```

Since `runAsSession` opts are `RunAsSessionOpts` = `{ storyId?, pipelineStage?, signal?, ... }`, update the pipelineStage test:

```typescript
test("passes pipelineStage: 'review' to runAsSession", async () => {
  let capturedOpts: import("../../../src/agents/manager-types").RunAsSessionOpts | undefined;
  const am = makeMockAgentManager({
    runAsSessionFn: async (_agentName, _handle, _prompt, opts) => {
      capturedOpts = opts;
      return { output: PASSING_RUN_RESPONSE, tokenUsage: { inputTokens: 0, outputTokens: 0 }, internalRoundTrips: 0 };
    },
  });
  const s = createReviewerSession(am, makeSessionManager(), "US-001", "/work", "feat", makeConfig());
  await s.review(SAMPLE_DIFF, STORY, SEMANTIC_CONFIG);
  expect(capturedOpts?.pipelineStage).toBe("review");
  await s.destroy();
});
```

- [ ] **Step 5: Run all dialogue tests**

```bash
timeout 30 bun test test/unit/review/dialogue.test.ts --timeout=5000
```

Expected: All PASS.

- [ ] **Step 6: Run typecheck**

```bash
bun run typecheck
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/review/dialogue.ts test/unit/review/dialogue.test.ts
git commit -m "refactor(adr-018): Wave 3 Phase D — dialogue.ts runAsSession migration, remove keepOpen"
```

---

## Task 6: Update `review.ts` call site

**Files:**
- Modify: `src/pipeline/stages/review.ts`

- [ ] **Step 1: Pass `ctx.sessionManager` as second argument**

In `src/pipeline/stages/review.ts`, find the call to `createReviewerSession` (line ~75):

```typescript
// BEFORE
ctx.reviewerSession = _reviewDeps.createReviewerSession(
  ctx.agentManager,
  ctx.story.id,
  ctx.workdir,
  ctx.prd.feature ?? "",
  ctx.config,
);

// AFTER
ctx.reviewerSession = _reviewDeps.createReviewerSession(
  ctx.agentManager,
  ctx.sessionManager,
  ctx.story.id,
  ctx.workdir,
  ctx.prd.feature ?? "",
  ctx.config,
);
```

Note: `ctx.sessionManager` may be `undefined` when `ISessionManager` is not wired. The updated `createReviewerSession` signature accepts `ISessionManager` (not optional). Verify `ctx.sessionManager` is always defined in the pipeline when dialogue is enabled. If it can be undefined, use `ctx.sessionManager ?? noopSessionManager` or update the type to accept undefined.

Check the actual guard in `review.ts`:
```typescript
if (dialogueEnabled && !ctx.reviewerSession && ctx.agentManager) {
```

If `ctx.sessionManager` could be undefined here, add a guard:
```typescript
if (dialogueEnabled && !ctx.reviewerSession && ctx.agentManager && ctx.sessionManager) {
  ctx.reviewerSession = _reviewDeps.createReviewerSession(
    ctx.agentManager,
    ctx.sessionManager,
    ctx.story.id,
    ctx.workdir,
    ctx.prd.feature ?? "",
    ctx.config,
  );
```

- [ ] **Step 2: Run typecheck**

```bash
bun run typecheck
```

Expected: no errors.

- [ ] **Step 3: Check that `_reviewDeps` export of `createReviewerSession` still works in tests**

```bash
timeout 15 bun test test/unit/pipeline/stages/review.test.ts --timeout=5000
```

Expected: PASS (or no test file — skip if absent).

- [ ] **Step 4: Commit**

```bash
git add src/pipeline/stages/review.ts
git commit -m "refactor(adr-018): pass ctx.sessionManager to createReviewerSession in review stage"
```

---

## Task 7: Verify keepOpen elimination and full test pass

- [ ] **Step 1: Verify no `keepOpen: true` in migrated files**

```bash
grep -n "keepOpen" \
  src/review/dialogue.ts \
  src/debate/session-stateful.ts \
  src/debate/session-hybrid.ts \
  src/debate/session.ts \
  src/debate/session-plan.ts \
  src/pipeline/stages/review.ts
```

Expected: Zero matches. If any remain, fix before proceeding.

- [ ] **Step 2: Verify `closeStatefulSession` is fully deleted**

```bash
grep -rn "closeStatefulSession" src/
```

Expected: Zero matches.

- [ ] **Step 3: Verify `sessionHandle` string references are gone from migrated files**

```bash
grep -n "sessionHandle" \
  src/review/dialogue.ts \
  src/debate/session-stateful.ts \
  src/debate/session-hybrid.ts
```

Expected: Zero matches.

- [ ] **Step 4: Run targeted unit tests for all migrated modules**

```bash
timeout 60 bun test \
  test/unit/review/dialogue.test.ts \
  test/unit/debate/session-stateful.test.ts \
  test/unit/debate/session-hybrid.test.ts \
  test/unit/debate/session-hybrid-rebuttal.test.ts \
  --timeout=5000
```

Expected: All PASS.

- [ ] **Step 5: Run full test suite**

```bash
bun run test
```

Expected: All PASS, no regressions.

- [ ] **Step 6: Run lint**

```bash
bun run lint
```

Expected: No lint errors. Run `bun run lint:fix` if formatting issues.

- [ ] **Step 7: Final typecheck**

```bash
bun run typecheck
```

Expected: no errors.

- [ ] **Step 8: Final commit**

```bash
git add -p   # stage any unstaged formatting changes
git commit -m "chore(adr-018): apply biome formatting to Wave 3 Phase D changes"
```

---

## Self-Review

### Spec Coverage Check

| Requirement | Covered By |
|:---|:---|
| Remove `keepOpen: true` from `dialogue.ts` (5 call sites) | Task 5 |
| Remove `keepOpen: true` from `session-stateful.ts` | Task 2 |
| Add `sessionManager.openSession` + `agentManager.runAsSession` + `sessionManager.closeSession` | Tasks 2, 3, 5 |
| Close session on compaction in `reReview` and `reReviewDebate` | Task 5 |
| Close session in `destroy()` | Task 5 |
| Delete `closeStatefulSession` | Task 2 |
| Thread `sessionManager` through `DebateSession`, `StatefulCtx`, `HybridCtx`, `PlanCtx` | Tasks 1, 4 |
| Update `review.ts` call site | Task 6 |
| Update all 4 test files | Tasks 1, 2, 3, 5 |
| Zero `keepOpen: true` in migrated files | Task 7 |

### Type Consistency Check

- `runStatefulTurn(ctx, am, agentName, debater, prompt, handle: SessionHandle)` — handle comes from `openHandles[i]` in `runStateful` / `runHybrid`
- `SuccessfulProposal.handle?: SessionHandle` — set by `runStatefulTurn` return value
- `runAsSession(agentName: string, handle: SessionHandle, prompt: string, opts: RunAsSessionOpts): Promise<TurnResult>` — matches `IAgentManager.runAsSession` signature
- `TurnResult.cost?: { total: number }` — mapped as `turnResult.cost?.total ?? 0`
- `openSession(name: string, opts: OpenSessionRequest): Promise<SessionHandle>` — name from `sessionManager.nameFor()`
- `closeSession(handle: SessionHandle): Promise<void>` — always called in finally blocks

### Placeholder Scan

No placeholders present — all code blocks show complete implementations.
