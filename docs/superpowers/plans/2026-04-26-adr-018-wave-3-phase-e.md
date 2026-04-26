# ADR-018 Wave 3 Phase E — DebateRunner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create `DebateRunner` as the sole debate orchestration entry point, replacing `DebateSession` and the scattered mode-specific session files, wiring the one-shot panel mode through `callOp` with new complete ops, and migrating the deprecated `planAs()` call in the plan debate path to `SessionManager.runInSession()`.

**Architecture:** `DebateRunner` accepts a `CallContext` (for `callOp` routing of complete() calls) plus debate-specific options; the one-shot panel mode routes debater calls through `debateProposeOp` / `debateRebutOp` / `debateRankOp` via per-debater `CallContext` copies; stateful and hybrid modes continue using `openSession`/`runAsSession`/`closeSession` directly on `ctx.runtime.sessionManager`; the plan debate mode replaces deprecated `planAs()` with `ctx.runtime.sessionManager.runInSession()`.

**Tech Stack:** Bun + TypeScript strict, `bun:test`, existing `src/operations/call.ts` (`callOp`), `src/session/types.ts` (`ISessionManager`), `src/debate/session-helpers.ts` (stays as-is).

---

## File Map

### Create

| File | Purpose |
|:-----|:--------|
| `src/operations/debate-propose.ts` | `debateProposeOp` — `kind: "complete"` — one debater's proposal turn |
| `src/operations/debate-rebut.ts` | `debateRebutOp` — `kind: "complete"` — one debater's critique/rebuttal turn |
| `src/operations/debate-rank.ts` | `debateRankOp` — `kind: "complete"` — resolver synthesis/judge turn |
| `src/debate/runner.ts` | `DebateRunner` class — sole debate orchestration entry point |
| `test/unit/operations/debate-propose.test.ts` | Unit tests for `debateProposeOp` |
| `test/unit/operations/debate-rebut.test.ts` | Unit tests for `debateRebutOp` |
| `test/unit/operations/debate-rank.test.ts` | Unit tests for `debateRankOp` |
| `test/unit/debate/runner.test.ts` | Core `DebateRunner` tests — one-shot mode |
| `test/unit/debate/runner-stateful.test.ts` | `DebateRunner` stateful + hybrid mode tests |
| `test/unit/debate/runner-plan.test.ts` | `DebateRunner` plan mode + `planAs` migration tests |
| `test/unit/debate/runner-mode-routing.test.ts` | Mode routing dispatch tests |

### Modify

| File | Change |
|:-----|:-------|
| `src/prompts/builders/debate-builder.ts` | Add slot methods returning `ComposeInput` for op `build()` functions |
| `src/operations/index.ts` | Export new debate ops |
| `src/cli/plan.ts` | Replace `DebateSession` with `DebateRunner`; thread `CallContext` |
| `src/review/semantic.ts` | Replace `DebateSession` with `DebateRunner`; thread `CallContext` from caller |
| `src/debate/index.ts` | Export `DebateRunner` instead of `DebateSession` |

### Delete (after all tests pass)

| File | Reason |
|:-----|:-------|
| `src/debate/session.ts` | Replaced by `runner.ts` |
| `src/debate/session-one-shot.ts` | Collapsed into `DebateRunner` |
| `src/debate/session-stateful.ts` | Collapsed into `DebateRunner` |
| `src/debate/session-hybrid.ts` | Collapsed into `DebateRunner` |
| `src/debate/session-plan.ts` | Collapsed into `DebateRunner` |

### Test files to rename (imports only)

| Old | New | Notes |
|:----|:----|:------|
| `test/unit/debate/session-mode-routing.test.ts` | `test/unit/debate/runner-mode-routing.test.ts` | Already targeted above |
| `test/unit/debate/session-stateful.test.ts` | `test/unit/debate/runner-stateful.test.ts` | Already targeted above |
| `test/unit/debate/session-hybrid.test.ts` | Merge into `runner-stateful.test.ts` | |
| `test/unit/debate/session-hybrid-rebuttal.test.ts` | Merge into `runner-stateful.test.ts` | |
| `test/unit/debate/session-one-shot-roles.test.ts` | Merge into `runner.test.ts` | |
| `test/unit/debate/session-plan.test.ts` | `test/unit/debate/runner-plan.test.ts` | Already targeted above |
| `test/unit/debate/session-rounds-and-cost.test.ts` | Merge into `runner.test.ts` | |
| `test/unit/debate/session-events.test.ts` | Merge into `runner.test.ts` | |
| `test/unit/debate/session-agent-resolution.test.ts` | Merge into `runner.test.ts` | |

---

## Background and Key Constraints

- `DebateSession` is the current entry point (`src/debate/session.ts`). Phase E replaces it with `DebateRunner`.
- `session-stateful.ts` was migrated in Phase D to use `openSession`/`runAsSession`/`closeSession` — that pattern is preserved in `DebateRunner`.
- `session-plan.ts` still calls `agentManager.planAs()` which was deprecated in Phase C (now throws `ADAPTER_METHOD_DEPRECATED`). Phase E must fix this.
- The new `DebateRunner` does **not** implement `ISessionRunner` (deleted in ADR-019 Phase C).
- `_debateSessionDeps` lives in `session-helpers.ts` (stays — not deleted). Tests continue to inject via `_debateSessionDeps`.
- All prompt building stays in `src/prompts/builders/debate-builder.ts` (Prompt Builder Convention).
- Import from barrels only: `src/debate` not `src/debate/session-helpers`.
- Tests use `makeMockAgentManager`, `makeSessionManager` from `test/helpers/`.

---

## Task 1: Add `ComposeInput`-returning slot methods to `DebatePromptBuilder`

**Files:** `src/prompts/builders/debate-builder.ts`

The op `build()` functions must return `ComposeInput`. Add slot methods that wrap the existing string-returning methods.

- [ ] **Step 1.1: Write failing test first**

Add to `test/unit/debate/prompt-builder.test.ts` (before the existing tests at top of describe block):

```typescript
import type { ComposeInput } from "../../../src/prompts/compose";

describe("DebatePromptBuilder slot methods", () => {
  test("proposeSlot returns ComposeInput with task section", () => {
    const builder = new DebatePromptBuilder(
      { taskContext: "task", outputFormat: "json", stage: "review" },
      { debaters: [{ agent: "claude" }, { agent: "opencode" }], sessionMode: "one-shot" },
    );
    const result: ComposeInput = builder.proposeSlot(0);
    expect(result.task.content).toContain("task");
    expect(result.task.id).toBe("task");
    expect(result.role.id).toBe("role");
  });

  test("rebutSlot returns ComposeInput wrapping buildCritiquePrompt output", () => {
    const builder = new DebatePromptBuilder(
      { taskContext: "task", outputFormat: "", stage: "review" },
      { debaters: [{ agent: "claude" }, { agent: "opencode" }], sessionMode: "one-shot" },
    );
    const proposals = [
      { debater: { agent: "claude" }, output: "prop-a" },
      { debater: { agent: "opencode" }, output: "prop-b" },
    ];
    const result: ComposeInput = builder.rebutSlot(0, proposals);
    expect(result.task.content).toContain("prop-b"); // other proposal
    expect(result.task.id).toBe("task");
  });

  test("rankSlot returns ComposeInput for synthesis resolver", () => {
    const builder = new DebatePromptBuilder(
      { taskContext: "task", outputFormat: "json", stage: "review" },
      { debaters: [{ agent: "claude" }, { agent: "opencode" }], sessionMode: "one-shot" },
    );
    const proposals = [
      { debater: { agent: "claude" }, output: "prop-a" },
      { debater: { agent: "opencode" }, output: "prop-b" },
    ];
    const result: ComposeInput = builder.rankSlot(proposals, []);
    expect(result.task.content).toContain("prop-a");
    expect(result.task.content).toContain("prop-b");
    expect(result.task.id).toBe("task");
  });
});
```

- [ ] **Step 1.2: Run test to confirm failure**

```bash
timeout 30 bun test test/unit/debate/prompt-builder.test.ts --timeout=5000
```

Expected: FAIL — `proposeSlot`, `rebutSlot`, `rankSlot` not defined

- [ ] **Step 1.3: Add slot methods to `DebatePromptBuilder`**

In `src/prompts/builders/debate-builder.ts`, add these three public methods after `buildClosePrompt()`:

```typescript
import type { ComposeInput } from "../compose";

// ─── Op slot methods (return ComposeInput for use in op build() functions) ──────

/**
 * Slot for debateProposeOp.build() — wraps buildProposalPrompt.
 */
proposeSlot(debaterIndex: number): ComposeInput {
  return {
    role: { id: "role", content: "", overridable: false },
    task: { id: "task", content: this.buildProposalPrompt(debaterIndex), overridable: false },
  };
}

/**
 * Slot for debateRebutOp.build() — wraps buildCritiquePrompt.
 */
rebutSlot(debaterIndex: number, proposals: import("../../debate/types").Proposal[]): ComposeInput {
  return {
    role: { id: "role", content: "", overridable: false },
    task: { id: "task", content: this.buildCritiquePrompt(debaterIndex, proposals), overridable: false },
  };
}

/**
 * Slot for debateRankOp.build() — wraps buildSynthesisPrompt.
 */
rankSlot(
  proposals: import("../../debate/types").Proposal[],
  critiques: import("../../debate/types").Rebuttal[],
  promptSuffix?: string,
): ComposeInput {
  return {
    role: { id: "role", content: "", overridable: false },
    task: { id: "task", content: this.buildSynthesisPrompt(proposals, critiques, promptSuffix), overridable: false },
  };
}
```

- [ ] **Step 1.4: Run test to confirm pass**

```bash
timeout 30 bun test test/unit/debate/prompt-builder.test.ts --timeout=5000
```

Expected: PASS

- [ ] **Step 1.5: Typecheck**

```bash
bun run typecheck 2>&1 | head -40
```

Expected: clean

- [ ] **Step 1.6: Commit**

```bash
git add src/prompts/builders/debate-builder.ts test/unit/debate/prompt-builder.test.ts
git commit -m "feat(adr-018): add proposeSlot/rebutSlot/rankSlot to DebatePromptBuilder"
```

---

## Task 2: Create `debateProposeOp` (kind: "complete")

**Files:**
- Create: `src/operations/debate-propose.ts`
- Create: `test/unit/operations/debate-propose.test.ts`

One debater's proposal turn in panel/one-shot mode. The op `build()` function calls `DebatePromptBuilder.proposeSlot()`.

- [ ] **Step 2.1: Write failing test**

```typescript
// test/unit/operations/debate-propose.test.ts
import { describe, expect, test } from "bun:test";
import type { Debater } from "../../../src/debate/types";
import type { BuildContext } from "../../../src/operations/types";
import { DEFAULT_CONFIG } from "../../../src/config";
import { debateProposeOp } from "../../../src/operations/debate-propose";

function makeBuildCtx(): BuildContext<ReturnType<typeof import("../../../src/config").debateConfigSelector.select>> {
  return {
    packageView: { config: DEFAULT_CONFIG, select: (_sel: unknown) => DEFAULT_CONFIG.debate } as any,
    config: DEFAULT_CONFIG.debate,
  };
}

const debaters: Debater[] = [{ agent: "claude", model: "fast" }, { agent: "opencode", model: "fast" }];

describe("debateProposeOp", () => {
  test("kind is complete", () => {
    expect(debateProposeOp.kind).toBe("complete");
  });

  test("name matches op identity", () => {
    expect(debateProposeOp.name).toBe("debate-propose");
  });

  test("build returns ComposeInput with proposal prompt", () => {
    const input = { taskContext: "implement X", outputFormat: "json", stage: "review", debaterIndex: 0, debaters };
    const ctx = makeBuildCtx();
    const result = debateProposeOp.build(input, ctx);
    expect(result.task.content).toContain("implement X");
    expect(result.task.id).toBe("task");
  });

  test("parse returns the raw output string unchanged", () => {
    const parsed = debateProposeOp.parse("some proposal text", {} as any, makeBuildCtx());
    expect(parsed).toBe("some proposal text");
  });

  test("debaterIndex 1 includes second debater persona if present", () => {
    const debatersWithPersona: Debater[] = [
      { agent: "claude", model: "fast", persona: "challenger" },
      { agent: "opencode", model: "fast", persona: "pragmatist" },
    ];
    const input = {
      taskContext: "task",
      outputFormat: "json",
      stage: "review",
      debaterIndex: 1,
      debaters: debatersWithPersona,
    };
    const result = debateProposeOp.build(input, makeBuildCtx());
    expect(result.task.content).toContain("pragmatist");
  });
});
```

- [ ] **Step 2.2: Run test to confirm failure**

```bash
timeout 30 bun test test/unit/operations/debate-propose.test.ts --timeout=5000
```

Expected: FAIL — module not found

- [ ] **Step 2.3: Implement `debateProposeOp`**

```typescript
// src/operations/debate-propose.ts
import { debateConfigSelector } from "../config";
import { DebatePromptBuilder } from "../prompts";
import type { Debater } from "../debate/types";
import type { CompleteOperation } from "./types";

export interface DebateProposeInput {
  readonly taskContext: string;
  readonly outputFormat: string;
  readonly stage: string;
  readonly debaterIndex: number;
  readonly debaters: Debater[];
}

type DebateConfig = ReturnType<typeof debateConfigSelector.select>;

export const debateProposeOp: CompleteOperation<DebateProposeInput, string, DebateConfig> = {
  kind: "complete",
  name: "debate-propose",
  stage: "review",
  jsonMode: false,
  config: debateConfigSelector,
  build(input, _ctx) {
    const builder = new DebatePromptBuilder(
      { taskContext: input.taskContext, outputFormat: input.outputFormat, stage: input.stage },
      { debaters: input.debaters, sessionMode: "one-shot" },
    );
    return builder.proposeSlot(input.debaterIndex);
  },
  parse(output, _input, _ctx) {
    return output;
  },
};
```

- [ ] **Step 2.4: Run test to confirm pass**

```bash
timeout 30 bun test test/unit/operations/debate-propose.test.ts --timeout=5000
```

Expected: PASS

- [ ] **Step 2.5: Commit**

```bash
git add src/operations/debate-propose.ts test/unit/operations/debate-propose.test.ts
git commit -m "feat(adr-018): add debateProposeOp (kind: complete)"
```

---

## Task 3: Create `debateRebutOp` (kind: "complete")

**Files:**
- Create: `src/operations/debate-rebut.ts`
- Create: `test/unit/operations/debate-rebut.test.ts`

One debater's critique/rebuttal turn in panel/one-shot mode. Uses `DebatePromptBuilder.rebutSlot()`.

- [ ] **Step 3.1: Write failing test**

```typescript
// test/unit/operations/debate-rebut.test.ts
import { describe, expect, test } from "bun:test";
import type { Debater, Proposal } from "../../../src/debate/types";
import type { BuildContext } from "../../../src/operations/types";
import { DEFAULT_CONFIG } from "../../../src/config";
import { debateRebutOp } from "../../../src/operations/debate-rebut";

function makeBuildCtx(): BuildContext<ReturnType<typeof import("../../../src/config").debateConfigSelector.select>> {
  return {
    packageView: { config: DEFAULT_CONFIG, select: (_sel: unknown) => DEFAULT_CONFIG.debate } as any,
    config: DEFAULT_CONFIG.debate,
  };
}

const debaters: Debater[] = [{ agent: "claude", model: "fast" }, { agent: "opencode", model: "fast" }];
const proposals: Proposal[] = [
  { debater: debaters[0], output: "proposal-a" },
  { debater: debaters[1], output: "proposal-b" },
];

describe("debateRebutOp", () => {
  test("kind is complete", () => {
    expect(debateRebutOp.kind).toBe("complete");
  });

  test("name matches op identity", () => {
    expect(debateRebutOp.name).toBe("debate-rebut");
  });

  test("build excludes the calling debater's own proposal", () => {
    const input = {
      taskContext: "task",
      stage: "review",
      debaterIndex: 0,
      proposals,
      debaters,
    };
    const result = debateRebutOp.build(input, makeBuildCtx());
    // Debater 0 should NOT see proposal-a (own proposal)
    expect(result.task.content).not.toContain("proposal-a");
    expect(result.task.content).toContain("proposal-b");
  });

  test("parse returns the raw output string unchanged", () => {
    const parsed = debateRebutOp.parse("critique text", {} as any, makeBuildCtx());
    expect(parsed).toBe("critique text");
  });
});
```

- [ ] **Step 3.2: Run test to confirm failure**

```bash
timeout 30 bun test test/unit/operations/debate-rebut.test.ts --timeout=5000
```

Expected: FAIL — module not found

- [ ] **Step 3.3: Implement `debateRebutOp`**

```typescript
// src/operations/debate-rebut.ts
import { debateConfigSelector } from "../config";
import { DebatePromptBuilder } from "../prompts";
import type { Debater, Proposal } from "../debate/types";
import type { CompleteOperation } from "./types";

export interface DebateRebutInput {
  readonly taskContext: string;
  readonly stage: string;
  readonly debaterIndex: number;
  readonly proposals: Proposal[];
  readonly debaters: Debater[];
}

type DebateConfig = ReturnType<typeof debateConfigSelector.select>;

export const debateRebutOp: CompleteOperation<DebateRebutInput, string, DebateConfig> = {
  kind: "complete",
  name: "debate-rebut",
  stage: "review",
  jsonMode: false,
  config: debateConfigSelector,
  build(input, _ctx) {
    const builder = new DebatePromptBuilder(
      { taskContext: input.taskContext, outputFormat: "", stage: input.stage },
      { debaters: input.debaters, sessionMode: "one-shot" },
    );
    return builder.rebutSlot(input.debaterIndex, input.proposals);
  },
  parse(output, _input, _ctx) {
    return output;
  },
};
```

- [ ] **Step 3.4: Run test to confirm pass**

```bash
timeout 30 bun test test/unit/operations/debate-rebut.test.ts --timeout=5000
```

Expected: PASS

- [ ] **Step 3.5: Commit**

```bash
git add src/operations/debate-rebut.ts test/unit/operations/debate-rebut.test.ts
git commit -m "feat(adr-018): add debateRebutOp (kind: complete)"
```

---

## Task 4: Create `debateRankOp` (kind: "complete")

**Files:**
- Create: `src/operations/debate-rank.ts`
- Create: `test/unit/operations/debate-rank.test.ts`

Resolver synthesis/judge turn — wraps the synthesis prompt via `DebatePromptBuilder.rankSlot()`.

- [ ] **Step 4.1: Write failing test**

```typescript
// test/unit/operations/debate-rank.test.ts
import { describe, expect, test } from "bun:test";
import type { Debater, Proposal, Rebuttal } from "../../../src/debate/types";
import type { BuildContext } from "../../../src/operations/types";
import { DEFAULT_CONFIG } from "../../../src/config";
import { debateRankOp } from "../../../src/operations/debate-rank";

function makeBuildCtx(): BuildContext<ReturnType<typeof import("../../../src/config").debateConfigSelector.select>> {
  return {
    packageView: { config: DEFAULT_CONFIG, select: (_sel: unknown) => DEFAULT_CONFIG.debate } as any,
    config: DEFAULT_CONFIG.debate,
  };
}

const debaters: Debater[] = [{ agent: "claude" }, { agent: "opencode" }];
const proposals: Proposal[] = [
  { debater: debaters[0], output: "prop-alpha" },
  { debater: debaters[1], output: "prop-beta" },
];
const critiques: Rebuttal[] = [];

describe("debateRankOp", () => {
  test("kind is complete", () => {
    expect(debateRankOp.kind).toBe("complete");
  });

  test("name matches op identity", () => {
    expect(debateRankOp.name).toBe("debate-rank");
  });

  test("build includes all proposals", () => {
    const input = {
      taskContext: "task",
      outputFormat: "json",
      stage: "review",
      proposals,
      critiques,
      debaters,
    };
    const result = debateRankOp.build(input, makeBuildCtx());
    expect(result.task.content).toContain("prop-alpha");
    expect(result.task.content).toContain("prop-beta");
  });

  test("build includes promptSuffix when provided", () => {
    const input = {
      taskContext: "task",
      outputFormat: "json",
      stage: "plan",
      proposals,
      critiques,
      debaters,
      promptSuffix: "Output raw JSON only.",
    };
    const result = debateRankOp.build(input, makeBuildCtx());
    expect(result.task.content).toContain("Output raw JSON only.");
  });

  test("parse returns the raw output string unchanged", () => {
    const parsed = debateRankOp.parse("synthesized output", {} as any, makeBuildCtx());
    expect(parsed).toBe("synthesized output");
  });
});
```

- [ ] **Step 4.2: Run test to confirm failure**

```bash
timeout 30 bun test test/unit/operations/debate-rank.test.ts --timeout=5000
```

Expected: FAIL — module not found

- [ ] **Step 4.3: Implement `debateRankOp`**

```typescript
// src/operations/debate-rank.ts
import { debateConfigSelector } from "../config";
import { DebatePromptBuilder } from "../prompts";
import type { Debater, Proposal, Rebuttal } from "../debate/types";
import type { CompleteOperation } from "./types";

export interface DebateRankInput {
  readonly taskContext: string;
  readonly outputFormat: string;
  readonly stage: string;
  readonly proposals: Proposal[];
  readonly critiques: Rebuttal[];
  readonly debaters: Debater[];
  readonly promptSuffix?: string;
}

type DebateConfig = ReturnType<typeof debateConfigSelector.select>;

export const debateRankOp: CompleteOperation<DebateRankInput, string, DebateConfig> = {
  kind: "complete",
  name: "debate-rank",
  stage: "review",
  jsonMode: false,
  config: debateConfigSelector,
  build(input, _ctx) {
    const builder = new DebatePromptBuilder(
      { taskContext: input.taskContext, outputFormat: input.outputFormat, stage: input.stage },
      { debaters: input.debaters, sessionMode: "one-shot" },
    );
    return builder.rankSlot(input.proposals, input.critiques, input.promptSuffix);
  },
  parse(output, _input, _ctx) {
    return output;
  },
};
```

- [ ] **Step 4.4: Run test to confirm pass**

```bash
timeout 30 bun test test/unit/operations/debate-rank.test.ts --timeout=5000
```

Expected: PASS

- [ ] **Step 4.5: Export new ops from `src/operations/index.ts`**

Add to `src/operations/index.ts`:

```typescript
export { debateProposeOp } from "./debate-propose";
export type { DebateProposeInput } from "./debate-propose";
export { debateRebutOp } from "./debate-rebut";
export type { DebateRebutInput } from "./debate-rebut";
export { debateRankOp } from "./debate-rank";
export type { DebateRankInput } from "./debate-rank";
```

- [ ] **Step 4.6: Run typecheck**

```bash
bun run typecheck 2>&1 | head -40
```

Expected: clean

- [ ] **Step 4.7: Commit**

```bash
git add src/operations/debate-rank.ts test/unit/operations/debate-rank.test.ts src/operations/index.ts
git commit -m "feat(adr-018): add debateRankOp and export all debate ops from operations barrel"
```

---

## Task 5: Create `DebateRunner` — core structure + one-shot panel mode

**Files:**
- Create: `src/debate/runner.ts`
- Create: `test/unit/debate/runner.test.ts`

`DebateRunner` is the new entry point. Start with the constructor and one-shot panel mode (the simplest mode). The one-shot mode replaces `runOneShot()` from `session-one-shot.ts`.

**Design of `DebateRunner`:**
- Constructor takes `DebateRunnerOptions` which includes a `CallContext` for routing complete() calls
- `run(prompt)` routes by `mode` + `sessionMode` (same logic as `DebateSession.run()`)
- For one-shot: creates per-debater `CallContext` copies (same runtime, different `agentName`) and calls `callOp`
- For stateful/hybrid: uses `ctx.runtime.sessionManager` directly (ADR-019 pattern from Phase D)
- For plan: uses `ctx.runtime.sessionManager.runInSession()` instead of deprecated `planAs()`

```typescript
// src/debate/runner.ts — full file

import { callOp } from "../operations/call";
import type { CallContext } from "../operations/types";
import { debateProposeOp } from "../operations/debate-propose";
import { debateRebutOp } from "../operations/debate-rebut";
import { DEFAULT_CONFIG, type NaxConfig } from "../config";
import { allSettledBounded } from "./concurrency";
import { buildDebaterLabel, resolvePersonas } from "./personas";
import {
  type ResolveOutcome,
  type ResolvedDebater,
  type ResolverContextInput,
  type SuccessfulProposal,
  _debateSessionDeps,
  buildFailedResult,
  modelTierFromDebater,
  pipelineStageForDebate,
  resolveModelDefForDebater,
  resolveOutcome,
} from "./session-helpers";
import { runHybrid } from "./session-hybrid";
import { runPlan } from "./session-plan";
import { runStateful } from "./session-stateful";
import type { DebateResult, DebateStageConfig, Debater, Proposal } from "./types";
import type { ISessionManager } from "../session/types";

// ... (see below for full implementation)
```

Wait — we cannot import from the mode files we're deleting. The plan is incremental:
1. **Task 5 (this task)**: Create `runner.ts` that still imports from mode files (which still exist at this point). Implement one-shot mode **inline** in runner.ts. Keep importing `runStateful`, `runHybrid`, `runPlan` from their current files.
2. **Task 6**: Add stateful + hybrid inline.
3. **Task 7**: Add plan inline.
4. **Task 8**: Delete mode files.

This way each task is independent and the build stays green throughout.

- [ ] **Step 5.1: Write failing tests for `DebateRunner` one-shot mode**

```typescript
// test/unit/debate/runner.test.ts
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { DebateRunner, _debateRunnerDeps } from "../../../src/debate/runner";
import { _debateSessionDeps } from "../../../src/debate/session-helpers";
import type { DebateStageConfig } from "../../../src/debate/types";
import type { CallContext } from "../../../src/operations/types";
import { DEFAULT_CONFIG } from "../../../src/config";
import { makeMockAgentManager, makeSessionManager } from "../../helpers";

function makeCallCtx(overrides: Partial<CallContext> = {}): CallContext {
  const agentManager = makeMockAgentManager({
    completeFn: async (_name, _p, _o) => ({ output: '{"passed":true}', costUsd: 0, source: "primary" as const }),
  });
  return {
    runtime: {
      agentManager,
      sessionManager: makeSessionManager(),
      configLoader: { current: () => DEFAULT_CONFIG, select: (_sel: unknown) => DEFAULT_CONFIG } as any,
      packages: { resolve: () => ({ config: DEFAULT_CONFIG, select: (_sel: unknown) => DEFAULT_CONFIG }) } as any,
      signal: undefined,
    } as any,
    packageView: { config: DEFAULT_CONFIG, select: (_sel: unknown) => DEFAULT_CONFIG } as any,
    packageDir: "/tmp/work",
    agentName: "claude",
    storyId: "US-001",
    featureName: "feat-a",
    ...overrides,
  };
}

function makeStageConfig(overrides: Partial<DebateStageConfig> = {}): DebateStageConfig {
  return {
    enabled: true,
    resolver: { type: "majority-fail-closed" },
    sessionMode: "one-shot",
    mode: "panel",
    rounds: 1,
    debaters: [
      { agent: "claude", model: "fast" },
      { agent: "opencode", model: "fast" },
    ],
    ...overrides,
  };
}

let origGetSafeLogger: typeof _debateSessionDeps.getSafeLogger;

beforeEach(() => {
  origGetSafeLogger = _debateSessionDeps.getSafeLogger;
  _debateSessionDeps.getSafeLogger = mock(() => ({
    info: mock(() => {}),
    debug: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
  }));
});

afterEach(() => {
  _debateSessionDeps.getSafeLogger = origGetSafeLogger;
  mock.restore();
});

describe("DebateRunner — one-shot panel mode", () => {
  test("run() returns passed result when both debaters succeed", async () => {
    const ctx = makeCallCtx();
    const runner = new DebateRunner({
      ctx,
      stage: "review",
      stageConfig: makeStageConfig(),
      config: DEFAULT_CONFIG,
      workdir: "/tmp/work",
    });
    const result = await runner.run("test prompt");
    expect(result.outcome).toBe("passed");
    expect(result.stage).toBe("review");
    expect(result.storyId).toBe("US-001");
  });

  test("run() returns passed with single debater when second fails", async () => {
    let callCount = 0;
    const agentManager = makeMockAgentManager({
      completeFn: async (_name: string, _p: string, _o: unknown) => {
        callCount++;
        if (callCount === 2) throw new Error("second debater failed");
        return { output: '{"passed":true}', costUsd: 0, source: "primary" as const };
      },
    });
    const ctx = makeCallCtx({ runtime: { agentManager, sessionManager: makeSessionManager(), configLoader: { current: () => DEFAULT_CONFIG } as any, packages: { resolve: () => ({ config: DEFAULT_CONFIG, select: () => DEFAULT_CONFIG }) } as any, signal: undefined } as any });
    const runner = new DebateRunner({ ctx, stage: "review", stageConfig: makeStageConfig(), config: DEFAULT_CONFIG, workdir: "/tmp/work" });
    const result = await runner.run("prompt");
    expect(result.outcome).toBe("passed");
    expect(result.debaters).toHaveLength(1);
  });

  test("run() returns failed when all debaters fail", async () => {
    const agentManager = makeMockAgentManager({
      completeFn: async () => { throw new Error("all fail"); },
    });
    const ctx = makeCallCtx({ runtime: { agentManager, sessionManager: makeSessionManager(), configLoader: { current: () => DEFAULT_CONFIG } as any, packages: { resolve: () => ({ config: DEFAULT_CONFIG, select: () => DEFAULT_CONFIG }) } as any, signal: undefined } as any });
    const runner = new DebateRunner({ ctx, stage: "review", stageConfig: makeStageConfig(), config: DEFAULT_CONFIG, workdir: "/tmp/work" });
    const result = await runner.run("prompt");
    expect(result.outcome).toBe("failed");
  });

  test("run() respects concurrency limit from config", async () => {
    const callTimestamps: number[] = [];
    const agentManager = makeMockAgentManager({
      completeFn: async () => {
        callTimestamps.push(Date.now());
        await Bun.sleep(10);
        return { output: '{"passed":true}', costUsd: 0, source: "primary" as const };
      },
    });
    const stageConfig = makeStageConfig({
      debaters: [
        { agent: "claude", model: "fast" },
        { agent: "opencode", model: "fast" },
        { agent: "codex", model: "fast" },
      ],
    });
    const ctx = makeCallCtx({ runtime: { agentManager, sessionManager: makeSessionManager(), configLoader: { current: () => DEFAULT_CONFIG } as any, packages: { resolve: () => ({ config: DEFAULT_CONFIG, select: () => DEFAULT_CONFIG }) } as any, signal: undefined } as any });
    const runner = new DebateRunner({ ctx, stage: "review", stageConfig, config: DEFAULT_CONFIG, workdir: "/tmp/work" });
    await runner.run("prompt");
    expect(callTimestamps.length).toBe(3);
  });
});
```

- [ ] **Step 5.2: Run test to confirm failure**

```bash
timeout 30 bun test test/unit/debate/runner.test.ts --timeout=5000
```

Expected: FAIL — `DebateRunner` not found

- [ ] **Step 5.3: Implement `DebateRunner` class with one-shot panel mode inline**

The key difference from `DebateSession`: instead of calling `agentManager.completeAs()` directly, `DebateRunner.runPanelOneShot()` calls `callOp(perDebaterCtx, debateProposeOp, input)` and `callOp(perDebaterCtx, debateRebutOp, input)`.

Per-debater context is constructed by spreading the base `ctx` with `agentName: debater.agent`:
```typescript
const debaterCtx: CallContext = { ...ctx, agentName: debater.agent };
```

```typescript
// src/debate/runner.ts
import { callOp } from "../operations/call";
import { debateProposeOp } from "../operations/debate-propose";
import { debateRebutOp } from "../operations/debate-rebut";
import type { CallContext } from "../operations/types";
import type { NaxConfig } from "../config";
import { DEFAULT_CONFIG } from "../config";
import { allSettledBounded } from "./concurrency";
import { buildDebaterLabel, resolvePersonas } from "./personas";
import {
  type ResolveOutcome,
  type ResolvedDebater,
  type ResolverContextInput,
  type SuccessfulProposal,
  _debateSessionDeps,
  buildFailedResult,
  pipelineStageForDebate,
  resolveOutcome,
} from "./session-helpers";
import { runHybrid } from "./session-hybrid";
import { runPlan } from "./session-plan";
import { runStateful } from "./session-stateful";
import type { DebateResult, DebateStageConfig, Proposal } from "./types";
import type { ISessionManager } from "../session/types";

const DEFAULT_TIMEOUT_SECONDS = 600;

export interface DebateRunnerOptions {
  readonly ctx: CallContext;
  readonly stage: string;
  readonly stageConfig: DebateStageConfig;
  readonly config?: NaxConfig;
  readonly workdir?: string;
  readonly featureName?: string;
  readonly timeoutSeconds?: number;
  readonly sessionManager?: ISessionManager;
  readonly reviewerSession?: import("../review/dialogue").ReviewerSession;
  readonly resolverContextInput?: ResolverContextInput;
}

export class DebateRunner {
  private readonly ctx: CallContext;
  private readonly stage: string;
  private readonly stageConfig: DebateStageConfig;
  private readonly config: NaxConfig;
  private readonly workdir: string;
  private readonly featureName: string;
  private readonly timeoutSeconds: number;
  private readonly sessionManager: ISessionManager | undefined;
  private readonly reviewerSession: DebateRunnerOptions["reviewerSession"];
  private readonly resolverContextInput: DebateRunnerOptions["resolverContextInput"];

  constructor(opts: DebateRunnerOptions) {
    this.ctx = opts.ctx;
    this.stage = opts.stage;
    this.stageConfig = opts.stageConfig;
    this.config = opts.config ?? DEFAULT_CONFIG;
    this.workdir = opts.workdir ?? opts.ctx.packageDir;
    this.featureName = opts.featureName ?? opts.stage;
    this.timeoutSeconds = opts.timeoutSeconds ?? opts.stageConfig.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
    this.sessionManager = opts.sessionManager ?? opts.ctx.runtime?.sessionManager;
    this.reviewerSession = opts.reviewerSession;
    this.resolverContextInput = opts.resolverContextInput;
  }

  async run(prompt: string): Promise<DebateResult> {
    const sessionMode = this.stageConfig.sessionMode ?? "one-shot";
    const mode = this.stageConfig.mode ?? "panel";

    if (mode === "hybrid") {
      if (sessionMode === "stateful") {
        return runHybrid(this.toStatefulCtx(), prompt);
      }
      const logger = _debateSessionDeps.getSafeLogger();
      logger?.warn(
        "debate",
        `hybrid mode requires sessionMode: stateful, but got '${sessionMode}' — falling back to one-shot`,
      );
      return this.runPanelOneShot(prompt);
    }

    if (sessionMode === "stateful") {
      return runStateful(this.toStatefulCtx(), prompt);
    }

    return this.runPanelOneShot(prompt);
  }

  async runPlan(
    taskContext: string,
    outputFormat: string,
    opts: {
      workdir: string;
      feature: string;
      outputDir: string;
      timeoutSeconds?: number;
      maxInteractionTurns?: number;
      specContent?: string;
    },
  ): Promise<DebateResult> {
    return runPlan(this.toPlanCtx(), taskContext, outputFormat, opts);
  }

  private async runPanelOneShot(prompt: string): Promise<DebateResult> {
    const logger = _debateSessionDeps.getSafeLogger();
    const config = this.stageConfig;
    const personaStage: "plan" | "review" = this.stage === "plan" ? "plan" : "review";
    const rawDebaters = config.debaters ?? [];
    const debaters = resolvePersonas(rawDebaters, personaStage, config.autoPersona ?? false);
    let totalCostUsd = 0;

    const agentManager = this.ctx.runtime.agentManager;

    const resolved: ResolvedDebater[] = [];
    for (const debater of debaters) {
      if (!agentManager.getAgent(debater.agent)) {
        logger?.warn("debate", `Agent '${debater.agent}' not found — skipping debater`);
        continue;
      }
      resolved.push({ debater, agentName: debater.agent });
    }

    logger?.info("debate", "debate:start", {
      storyId: this.ctx.storyId,
      stage: this.stage,
      debaters: resolved.map((r) => r.debater.agent),
    });

    const debateGlobalConfig = this.config?.debate;
    const concurrencyLimit = debateGlobalConfig?.maxConcurrentDebaters ?? 2;

    const proposalSettled = await allSettledBounded(
      resolved.map(({ debater, agentName }, i) => () => {
        const debaterCtx: CallContext = { ...this.ctx, agentName };
        return callOp(debaterCtx, debateProposeOp, {
          taskContext: prompt,
          outputFormat: "",
          stage: this.stage,
          debaterIndex: i,
          debaters: resolved.map((r) => r.debater),
        }).then((output) => ({ debater, agentName, output, cost: 0 } as SuccessfulProposal));
      }),
      concurrencyLimit,
    );

    const successful: SuccessfulProposal[] = proposalSettled
      .filter((r): r is PromiseFulfilledResult<SuccessfulProposal> => r.status === "fulfilled")
      .map((r) => r.value);

    for (let i = 0; i < successful.length; i++) {
      logger?.info("debate", "debate:proposal", {
        storyId: this.ctx.storyId,
        stage: this.stage,
        debaterIndex: i,
        agent: successful[i].debater.agent,
      });
    }

    if (successful.length < 2) {
      if (successful.length === 1) {
        logger?.warn("debate", "debate:fallback", {
          storyId: this.ctx.storyId,
          stage: this.stage,
          reason: "only 1 debater succeeded",
        });
        const solo = successful[0];
        logger?.info("debate", "debate:result", { storyId: this.ctx.storyId, stage: this.stage, outcome: "passed" });
        return {
          storyId: this.ctx.storyId ?? "",
          stage: this.stage,
          outcome: "passed",
          rounds: 1,
          debaters: [solo.debater.agent],
          resolverType: config.resolver.type,
          proposals: [{ debater: solo.debater, output: solo.output }],
          totalCostUsd,
        };
      }

      if (resolved.length > 0) {
        const { debater: fallbackDebater, agentName: fallbackAgentName } = resolved[0];
        logger?.warn("debate", "debate:fallback", {
          storyId: this.ctx.storyId,
          stage: this.stage,
          reason: "all debaters failed — retrying with first adapter",
        });
        try {
          const fallbackCtx: CallContext = { ...this.ctx, agentName: fallbackAgentName };
          const fallbackOutput = await callOp(fallbackCtx, debateProposeOp, {
            taskContext: prompt,
            outputFormat: "",
            stage: this.stage,
            debaterIndex: 0,
            debaters: [fallbackDebater],
          });
          totalCostUsd += 0;
          logger?.info("debate", "debate:result", { storyId: this.ctx.storyId, stage: this.stage, outcome: "passed" });
          return {
            storyId: this.ctx.storyId ?? "",
            stage: this.stage,
            outcome: "passed",
            rounds: 1,
            debaters: [fallbackDebater.agent],
            resolverType: config.resolver.type,
            proposals: [{ debater: fallbackDebater, output: fallbackOutput }],
            totalCostUsd,
          };
        } catch {
          // Retry also failed — fall through
        }
      }

      return buildFailedResult(this.ctx.storyId ?? "", this.stage, config, totalCostUsd);
    }

    // Critique rounds (when rounds > 1)
    let critiqueOutputs: string[] = [];
    if (config.rounds > 1) {
      const proposals = successful.map((p) => ({ debater: p.debater, output: p.output }));
      const critiqueSettled = await allSettledBounded(
        successful.map(({ debater, agentName }, i) => () => {
          const debaterCtx: CallContext = { ...this.ctx, agentName };
          return callOp(debaterCtx, debateRebutOp, {
            taskContext: prompt,
            stage: this.stage,
            debaterIndex: i,
            proposals,
            debaters: successful.map((s) => s.debater),
          });
        }),
        concurrencyLimit,
      );
      for (const r of critiqueSettled) {
        if (r.status === "fulfilled") {
          totalCostUsd += 0; // complete() cost not exposed by callOp currently
        }
      }
      critiqueOutputs = critiqueSettled
        .filter((r): r is PromiseFulfilledResult<string> => r.status === "fulfilled")
        .map((r) => r.value);
    }

    // Resolve outcome
    const proposalOutputs = successful.map((p) => p.output);
    const fullResolverContext = this.resolverContextInput
      ? {
          ...this.resolverContextInput,
          labeledProposals: successful.map((s) => ({
            debater: buildDebaterLabel(s.debater),
            output: s.output,
          })),
        }
      : undefined;
    const outcome: ResolveOutcome = await resolveOutcome(
      proposalOutputs,
      critiqueOutputs,
      this.stageConfig,
      this.config,
      this.ctx.storyId ?? "",
      this.timeoutSeconds * 1000,
      this.workdir,
      this.featureName,
      this.reviewerSession,
      fullResolverContext,
      undefined,
      successful.map((s) => s.debater),
      agentManager,
    );
    totalCostUsd += outcome.resolverCostUsd;

    const proposals = successful.map((p) => ({ debater: p.debater, output: p.output }));
    logger?.info("debate", "debate:result", { storyId: this.ctx.storyId, stage: this.stage, outcome: outcome.outcome });
    return {
      storyId: this.ctx.storyId ?? "",
      stage: this.stage,
      outcome: outcome.outcome,
      rounds: config.rounds,
      debaters: successful.map((s) => s.debater.agent),
      resolverType: config.resolver.type,
      proposals,
      totalCostUsd,
    };
  }

  private toStatefulCtx(): import("./session-stateful").StatefulCtx {
    return {
      storyId: this.ctx.storyId ?? "",
      stage: this.stage,
      stageConfig: this.stageConfig,
      config: this.config,
      workdir: this.workdir,
      featureName: this.featureName,
      timeoutSeconds: this.timeoutSeconds,
      agentManager: this.ctx.runtime.agentManager,
      sessionManager: this.sessionManager,
      reviewerSession: this.reviewerSession,
      resolverContextInput: this.resolverContextInput,
    };
  }

  private toPlanCtx(): import("./session-plan").PlanCtx {
    return {
      storyId: this.ctx.storyId ?? "",
      stage: this.stage,
      stageConfig: this.stageConfig,
      config: this.config,
      agentManager: this.ctx.runtime.agentManager,
      sessionManager: this.sessionManager,
    };
  }
}
```

Note: `StatefulCtx` and `PlanCtx` are currently internal types in the mode files. When we delete those files (Task 8), `toStatefulCtx()` / `toPlanCtx()` will be replaced by inline implementations. For now they delegate to the existing mode functions.

- [ ] **Step 5.4: Run tests to confirm pass**

```bash
timeout 30 bun test test/unit/debate/runner.test.ts --timeout=5000
```

Expected: PASS

- [ ] **Step 5.5: Full suite check**

```bash
bun run typecheck 2>&1 | head -20
timeout 30 bun test test/unit/debate/ --timeout=5000
```

Expected: typecheck clean; debate tests pass

- [ ] **Step 5.6: Commit**

```bash
git add src/debate/runner.ts test/unit/debate/runner.test.ts
git commit -m "feat(adr-018): add DebateRunner class with one-shot panel mode via callOp"
```

---

## Task 6: Add `DebateRunner` to barrel, update callers

**Files:**
- Modify: `src/debate/index.ts`
- Modify: `src/cli/plan.ts`
- Modify: `src/review/semantic.ts`

Make `DebateRunner` available to callers while `DebateSession` still exists. This is a non-breaking step.

- [ ] **Step 6.1: Export `DebateRunner` from `src/debate/index.ts`**

Add to `src/debate/index.ts`:

```typescript
export { DebateRunner } from "./runner";
export type { DebateRunnerOptions } from "./runner";
```

- [ ] **Step 6.2: Update `src/review/semantic.ts`**

Find the block at line 36 and the `createDebateSession` usage around line 302.

The `runSemanticReview()` function receives a `ctx: PipelineContext` which has `ctx.runtime`. Thread this through.

In `src/review/semantic.ts`:

1. Change the import:
```typescript
// Before:
import { DebateSession } from "../debate";
import type { DebateSessionOptions } from "../debate";
// After:
import { DebateRunner } from "../debate";
import type { DebateRunnerOptions } from "../debate";
```

2. Change the `_semanticDeps` factory:
```typescript
// Before:
createDebateSession: (opts: DebateSessionOptions): DebateSession => new DebateSession(opts),
// After:
createDebateRunner: (opts: DebateRunnerOptions): DebateRunner => new DebateRunner(opts),
```

3. At the call site (around line 302), replace:
```typescript
// Before:
const debateSession = _semanticDeps.createDebateSession({
  storyId: ctx.story.id,
  stage: "review",
  stageConfig: semanticConfig.debate,
  config,
  workdir: ctx.workdir,
  featureName: ctx.feature,
  agentManager: ctx.agentManager,
  sessionManager: ctx.runtime?.sessionManager,
  reviewerSession,
  resolverContextInput,
});
const debateResult = await debateSession.run(prompt);

// After:
const callCtx: import("../operations/types").CallContext = {
  runtime: ctx.runtime,
  packageView: ctx.packageView ?? ctx.runtime.packages.resolve(),
  packageDir: ctx.workdir,
  agentName: ctx.agentManager?.getDefault() ?? "claude",
  storyId: ctx.story.id,
  featureName: ctx.feature,
};
const debateRunner = _semanticDeps.createDebateRunner({
  ctx: callCtx,
  stage: "review",
  stageConfig: semanticConfig.debate,
  config,
  workdir: ctx.workdir,
  featureName: ctx.feature,
  sessionManager: ctx.runtime?.sessionManager,
  reviewerSession,
  resolverContextInput,
});
const debateResult = await debateRunner.run(prompt);
```

- [ ] **Step 6.3: Update `src/cli/plan.ts` — plan debate path (lines 187-234)**

Thread a `CallContext` through the plan debate path:

```typescript
// Before (around lines 201-211):
const debateAgentManager = _planDeps.createManager(config);
const debateSession = _planDeps.createDebateSession({
  storyId: options.feature,
  stage: "plan",
  stageConfig: planStageConfig,
  config,
  workdir,
  featureName: options.feature,
  timeoutSeconds,
  agentManager: debateAgentManager,
});
const debateResult = await debateSession.runPlan(planTaskContext, planOutputFormat, { ... });

// After:
const debateAgentManager = _planDeps.createManager(config);
const debateRt = createRuntime(config, workdir, { agentManager: debateAgentManager });
const debateCallCtx: import("../operations/types").CallContext = {
  runtime: debateRt,
  packageView: debateRt.packages.resolve(),
  packageDir: workdir,
  agentName: debateAgentManager.getDefault(),
  storyId: options.feature,
  featureName: options.feature,
};
const debateRunner = _planDeps.createDebateRunner({
  ctx: debateCallCtx,
  stage: "plan",
  stageConfig: planStageConfig,
  config,
  workdir,
  featureName: options.feature,
  timeoutSeconds,
  sessionManager: debateRt.sessionManager,
});
const debateResult = await debateRunner.runPlan(planTaskContext, planOutputFormat, { ... });
```

Also update the `_planDeps` factory:
```typescript
// Before:
createDebateSession: (opts: DebateSessionOptions): DebateSession => new DebateSession(opts),
// After:
createDebateRunner: (opts: DebateRunnerOptions): DebateRunner => new DebateRunner(opts),
```

And update the decompose debate path (around lines 608-621) similarly:
```typescript
// Before:
const debateSession = _planDeps.createDebateSession({ ... });
const debateResult = await debateSession.run(prompt);

// After:
const debateRunnerCtx: import("../operations/types").CallContext = {
  runtime: rt,
  packageView: rt.packages.resolve(),
  packageDir: workdir,
  agentName: agentManager.getDefault(),
  storyId: options.storyId,
  featureName: options.feature,
};
const debateRunner2 = _planDeps.createDebateRunner({
  ctx: debateRunnerCtx,
  stage: "decompose",
  stageConfig: decomposeStageConfig,
  config,
  workdir,
  featureName: options.feature,
  timeoutSeconds,
  sessionManager: rt.sessionManager,
});
const debateResult = await debateRunner2.run(prompt);
```

- [ ] **Step 6.4: Run typecheck and affected tests**

```bash
bun run typecheck 2>&1 | head -40
timeout 30 bun test test/unit/cli/plan-debate.test.ts --timeout=5000
timeout 30 bun test test/unit/review/semantic-debate.test.ts --timeout=5000
```

Expected: typecheck clean; tests pass (or update mocks if `createDebateSession` → `createDebateRunner`)

Note: test files for `cli/plan.ts` and `review/semantic.ts` will need their `_planDeps.createDebateSession` mocks renamed to `_planDeps.createDebateRunner` and their factory functions updated.

- [ ] **Step 6.5: Fix test mocks**

In `test/unit/cli/plan-debate.test.ts`: change all occurrences of `createDebateSession` → `createDebateRunner` and update the mock factory type annotation.

In `test/unit/review/semantic-debate.test.ts`: similarly update to `createDebateRunner`.

- [ ] **Step 6.6: Run full debate test suite**

```bash
timeout 60 bun test test/unit/debate/ test/unit/cli/plan-debate.test.ts test/unit/review/semantic-debate.test.ts --timeout=10000
```

Expected: all pass

- [ ] **Step 6.7: Commit**

```bash
git add src/debate/index.ts src/debate/runner.ts src/cli/plan.ts src/review/semantic.ts \
  test/unit/cli/plan-debate.test.ts test/unit/review/semantic-debate.test.ts
git commit -m "feat(adr-018): wire DebateRunner into callers (cli/plan, review/semantic)"
```

---

## Task 7: Inline stateful + hybrid mode into `DebateRunner`; migrate `planAs` to `runInSession`

**Files:**
- Modify: `src/debate/runner.ts`
- Create: `test/unit/debate/runner-stateful.test.ts`
- Create: `test/unit/debate/runner-plan.test.ts`

Replace the delegating calls to `runStateful`, `runHybrid`, `runPlan` with inline implementations. This unblocks deletion of the mode files in Task 8.

The `planAs` migration is the key correctness fix: `session-plan.ts:93` calls `agentManager.planAs()` which now throws `ADAPTER_METHOD_DEPRECATED`. Replace with `ctx.runtime.sessionManager.runInSession()`.

- [ ] **Step 7.1: Write failing tests for stateful mode**

```typescript
// test/unit/debate/runner-stateful.test.ts
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { DebateRunner } from "../../../src/debate/runner";
import { _debateSessionDeps } from "../../../src/debate/session-helpers";
import type { DebateStageConfig } from "../../../src/debate/types";
import type { CallContext } from "../../../src/operations/types";
import { DEFAULT_CONFIG } from "../../../src/config";
import { makeMockAgentManager, makeSessionManager } from "../../helpers";

function makeCallCtx(overrides: Partial<CallContext> = {}): CallContext {
  const agentManager = makeMockAgentManager();
  return {
    runtime: {
      agentManager,
      sessionManager: makeSessionManager(),
      configLoader: { current: () => DEFAULT_CONFIG } as any,
      packages: { resolve: () => ({ config: DEFAULT_CONFIG, select: () => DEFAULT_CONFIG }) } as any,
      signal: undefined,
    } as any,
    packageView: { config: DEFAULT_CONFIG, select: () => DEFAULT_CONFIG } as any,
    packageDir: "/tmp/work",
    agentName: "claude",
    storyId: "US-002",
    featureName: "feat-b",
    ...overrides,
  };
}

function makeStatefulConfig(): DebateStageConfig {
  return {
    enabled: true,
    resolver: { type: "majority-fail-closed" },
    sessionMode: "stateful",
    mode: "panel",
    rounds: 1,
    debaters: [{ agent: "claude", model: "fast" }, { agent: "opencode", model: "fast" }],
  };
}

let origGetSafeLogger: typeof _debateSessionDeps.getSafeLogger;

beforeEach(() => {
  origGetSafeLogger = _debateSessionDeps.getSafeLogger;
  _debateSessionDeps.getSafeLogger = mock(() => ({
    info: mock(() => {}), debug: mock(() => {}), warn: mock(() => {}), error: mock(() => {}),
  }));
});

afterEach(() => {
  _debateSessionDeps.getSafeLogger = origGetSafeLogger;
  mock.restore();
});

describe("DebateRunner — stateful panel mode", () => {
  test("opens a session per debater and calls runAsSession", async () => {
    const openedSessions: string[] = [];
    const runAsSessionCalls: string[] = [];

    const sm = makeSessionManager({
      openSession: mock(async (name: string) => { openedSessions.push(name); return { id: name, agentName: "claude" }; }),
      closeSession: mock(async () => {}),
    });
    const am = makeMockAgentManager({
      runAsSessionFn: async (_agentName: string, handle: import("../../../src/agents/types").SessionHandle, prompt: string) => {
        runAsSessionCalls.push(handle.id);
        return { output: `output-${handle.id}`, tokenUsage: { inputTokens: 0, outputTokens: 0 }, internalRoundTrips: 0 };
      },
    });

    const ctx = makeCallCtx({
      runtime: { agentManager: am, sessionManager: sm, configLoader: { current: () => DEFAULT_CONFIG } as any, packages: { resolve: () => ({ config: DEFAULT_CONFIG, select: () => DEFAULT_CONFIG }) } as any, signal: undefined } as any,
    });
    const runner = new DebateRunner({ ctx, stage: "review", stageConfig: makeStatefulConfig(), config: DEFAULT_CONFIG, workdir: "/tmp", sessionManager: sm });
    const result = await runner.run("test prompt");

    expect(result.outcome).not.toBe("failed");
    expect(openedSessions.length).toBe(2);
    expect(runAsSessionCalls.length).toBe(2);
  });

  test("closes sessions in finally even when a turn throws", async () => {
    const closedSessions: string[] = [];
    let callCount = 0;

    const sm = makeSessionManager({
      openSession: mock(async (name: string) => ({ id: name, agentName: "claude" })),
      closeSession: mock(async (handle: import("../../../src/agents/types").SessionHandle) => { closedSessions.push(handle.id); }),
    });
    const am = makeMockAgentManager({
      runAsSessionFn: async (_name: string, handle: import("../../../src/agents/types").SessionHandle) => {
        callCount++;
        if (callCount === 2) throw new Error("turn 2 failed");
        return { output: "ok", tokenUsage: { inputTokens: 0, outputTokens: 0 }, internalRoundTrips: 0 };
      },
    });

    const ctx = makeCallCtx({
      runtime: { agentManager: am, sessionManager: sm, configLoader: { current: () => DEFAULT_CONFIG } as any, packages: { resolve: () => ({ config: DEFAULT_CONFIG, select: () => DEFAULT_CONFIG }) } as any, signal: undefined } as any,
    });
    const runner = new DebateRunner({ ctx, stage: "review", stageConfig: makeStatefulConfig(), config: DEFAULT_CONFIG, workdir: "/tmp", sessionManager: sm });
    await runner.run("test prompt");

    expect(closedSessions.length).toBe(2);
  });
});
```

- [ ] **Step 7.2: Write failing tests for plan mode (planAs migration)**

```typescript
// test/unit/debate/runner-plan.test.ts
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { DebateRunner } from "../../../src/debate/runner";
import { _debateSessionDeps } from "../../../src/debate/session-helpers";
import type { DebateStageConfig } from "../../../src/debate/types";
import type { CallContext } from "../../../src/operations/types";
import { DEFAULT_CONFIG } from "../../../src/config";
import { makeMockAgentManager, makeSessionManager } from "../../helpers";
import { withTempDir } from "../../helpers/temp";

function makeCallCtx(am = makeMockAgentManager(), sm = makeSessionManager()): CallContext {
  return {
    runtime: {
      agentManager: am,
      sessionManager: sm,
      configLoader: { current: () => DEFAULT_CONFIG } as any,
      packages: { resolve: () => ({ config: DEFAULT_CONFIG, select: () => DEFAULT_CONFIG }) } as any,
      signal: undefined,
    } as any,
    packageView: { config: DEFAULT_CONFIG, select: () => DEFAULT_CONFIG } as any,
    packageDir: "/tmp/work",
    agentName: "claude",
    storyId: "plan-debate",
    featureName: "feat-plan",
  };
}

function makePlanConfig(): DebateStageConfig {
  return {
    enabled: true,
    resolver: { type: "majority-fail-closed" },
    sessionMode: "one-shot",
    mode: "panel",
    rounds: 1,
    debaters: [{ agent: "claude", model: "fast" }, { agent: "opencode", model: "fast" }],
  };
}

let origGetSafeLogger: typeof _debateSessionDeps.getSafeLogger;

beforeEach(() => {
  origGetSafeLogger = _debateSessionDeps.getSafeLogger;
  _debateSessionDeps.getSafeLogger = mock(() => ({
    info: mock(() => {}), debug: mock(() => {}), warn: mock(() => {}), error: mock(() => {}),
  }));
});

afterEach(() => {
  _debateSessionDeps.getSafeLogger = origGetSafeLogger;
  mock.restore();
});

describe("DebateRunner — plan mode (planAs migration)", () => {
  test("runPlan uses runInSession instead of planAs", async () => {
    await withTempDir(async (dir) => {
      const runInSessionCalls: string[] = [];

      const sm = makeSessionManager({
        runInSession: mock(async (_name: string, prompt: string, _opts: unknown) => {
          runInSessionCalls.push(prompt.slice(0, 20));
          // Write a mock PRD file to the expected path
          const match = prompt.match(/Write the PRD JSON directly to this file path: (.+?)\n/);
          if (match) {
            await Bun.write(match[1], JSON.stringify({ project: "test", userStories: [] }));
          }
          return { output: "done", cost: { total: 0 } };
        }),
      });
      const am = makeMockAgentManager();
      const ctx = makeCallCtx(am, sm);
      const runner = new DebateRunner({ ctx, stage: "plan", stageConfig: makePlanConfig(), config: DEFAULT_CONFIG, workdir: dir, sessionManager: sm });

      await runner.runPlan("task context", "json format", {
        workdir: dir,
        feature: "my-feature",
        outputDir: dir,
        timeoutSeconds: 30,
      });

      expect(runInSessionCalls.length).toBeGreaterThanOrEqual(1);
    });
  });

  test("runPlan does NOT call planAs (which would throw ADAPTER_METHOD_DEPRECATED)", async () => {
    await withTempDir(async (dir) => {
      const planAsCalls: string[] = [];

      // planAs mock that would throw if called
      const am = makeMockAgentManager({
        planAsFn: async (agentName: string) => {
          planAsCalls.push(agentName);
          throw new Error("planAs called — should not happen");
        },
      });
      const sm = makeSessionManager({
        runInSession: mock(async (_name: string, prompt: string, _opts: unknown) => {
          const match = prompt.match(/Write the PRD JSON directly to this file path: (.+?)\n/);
          if (match) await Bun.write(match[1], JSON.stringify({ project: "test", userStories: [] }));
          return { output: "done", cost: { total: 0 } };
        }),
      });
      const ctx = makeCallCtx(am, sm);
      const runner = new DebateRunner({ ctx, stage: "plan", stageConfig: makePlanConfig(), config: DEFAULT_CONFIG, workdir: dir, sessionManager: sm });

      // Should not throw despite planAs mock throwing
      const result = await runner.runPlan("task", "format", { workdir: dir, feature: "f", outputDir: dir });
      expect(planAsCalls).toHaveLength(0);
      // Result may be failed if mocks don't write files correctly, but no planAs calls
    });
  });
});
```

- [ ] **Step 7.3: Run tests to confirm failure**

```bash
timeout 30 bun test test/unit/debate/runner-stateful.test.ts test/unit/debate/runner-plan.test.ts --timeout=10000
```

Expected: stateful test may pass (delegates to mode files that are ADR-019 compliant), plan test FAILS (calls planAs which now throws)

- [ ] **Step 7.4: Inline stateful + hybrid + plan modes into `runner.ts`**

Replace the delegating imports and calls with inlined implementations. This is the bulk of the task.

**7.4a — Inline `runStateful` (from `session-stateful.ts`)**

Remove:
```typescript
import { runStateful } from "./session-stateful";
```

Add private method `runStateful(prompt: string): Promise<DebateResult>` to `DebateRunner` class — copy the body of `runStateful()` from `session-stateful.ts`, replacing all `ctx.` references with `this.`.

Change in `run()`:
```typescript
// Before:
return runStateful(this.toStatefulCtx(), prompt);
// After:
return this.runStateful(prompt);
```

**7.4b — Inline `runHybrid` (from `session-hybrid.ts`)**

Remove:
```typescript
import { runHybrid } from "./session-hybrid";
```

Add private methods `runHybrid(prompt: string): Promise<DebateResult>` and `runRebuttalLoop(...)` from `session-hybrid.ts`.

Change in `run()`:
```typescript
// Before:
return runHybrid(this.toStatefulCtx(), prompt);
// After:
return this.runHybrid(prompt);
```

**7.4c — Inline `runPlan` with `planAs` → `runInSession` migration**

Remove:
```typescript
import { runPlan } from "./session-plan";
```

Add private method `runPlanInternal(...)` inlining `session-plan.ts`, with the critical fix:

```typescript
// Before (session-plan.ts:93):
const planResult = await agentManager.planAs(agentName, {
  prompt: debaterPrompt,
  workdir: opts.workdir,
  interactive: false,
  timeoutSeconds: opts.timeoutSeconds,
  config: ctx.config,
  modelTier,
  modelDef,
  maxInteractionTurns: opts.maxInteractionTurns,
  featureName: opts.feature,
  storyId: ctx.storyId,
  sessionRole: `plan-${i}`,
});
const output = await _debateSessionDeps.readFile(tempOutputPath);

// After — use sessionManager.runInSession():
const sessionName = this.sessionManager?.nameFor?.({
  workdir: opts.workdir,
  featureName: opts.feature,
  storyId: this.ctx.storyId ?? "",
  role: `plan-${i}`,
}) ?? `nax-plan-debate-${i}`;

const planResult = await this.ctx.runtime.sessionManager.runInSession(sessionName, debaterPrompt, {
  agentName,
  role: `plan-${i}`,
  workdir: opts.workdir,
  pipelineStage: "plan",
  modelDef,
  timeoutSeconds: opts.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
  storyId: this.ctx.storyId ?? "",
  featureName: opts.feature,
  signal: this.ctx.runtime.signal,
});
const output = await _debateSessionDeps.readFile(tempOutputPath);
```

Also remove `toStatefulCtx()` and `toPlanCtx()` private methods — they're no longer needed.

- [ ] **Step 7.5: Run tests to confirm pass**

```bash
timeout 60 bun test test/unit/debate/runner-stateful.test.ts test/unit/debate/runner-plan.test.ts test/unit/debate/runner.test.ts --timeout=10000
```

Expected: all pass

- [ ] **Step 7.6: Typecheck**

```bash
bun run typecheck 2>&1 | head -40
```

Expected: clean

- [ ] **Step 7.7: Commit**

```bash
git add src/debate/runner.ts test/unit/debate/runner-stateful.test.ts test/unit/debate/runner-plan.test.ts
git commit -m "feat(adr-018): inline stateful/hybrid/plan into DebateRunner; migrate planAs to runInSession"
```

---

## Task 8: Delete mode files + migrate existing tests

**Files to delete:** `src/debate/session.ts`, `session-one-shot.ts`, `session-stateful.ts`, `session-hybrid.ts`, `session-plan.ts`

**Test files to migrate:** 9 existing test files that import from the deleted source files.

Do this as two sub-steps: first fix all test imports, then delete the source files.

- [ ] **Step 8.1: Update `src/debate/index.ts`**

Replace:
```typescript
export { DebateSession } from "./session";
export { _debateSessionDeps, resolveDebaterModel } from "./session-helpers";
export type { DebateSessionOptions } from "./session-helpers";
```

With:
```typescript
export { DebateRunner } from "./runner";
export type { DebateRunnerOptions } from "./runner";
export { _debateSessionDeps, resolveDebaterModel } from "./session-helpers";
// DebateSessionOptions is removed — callers use DebateRunnerOptions
```

- [ ] **Step 8.2: Rename and update `session-mode-routing.test.ts` → `runner-mode-routing.test.ts`**

```bash
mv test/unit/debate/session-mode-routing.test.ts test/unit/debate/runner-mode-routing.test.ts
```

Update imports in `runner-mode-routing.test.ts`:
```typescript
// Before:
import { DebateSession, _debateSessionDeps } from "../../../src/debate/session";
// After:
import { DebateRunner } from "../../../src/debate/runner";
import { _debateSessionDeps } from "../../../src/debate/session-helpers";
```

Replace all `new DebateSession(...)` with `new DebateRunner(...)`, adding a `ctx:` field:
```typescript
// Before:
new DebateSession({
  storyId: "US-001",
  stage: "review",
  stageConfig: makeStageConfig({ mode: "panel", sessionMode: "one-shot" }),
  config: DEFAULT_CONFIG,
  workdir: "/tmp",
  featureName: "feat",
  agentManager: _debateSessionDeps.agentManager,
})
// After:
new DebateRunner({
  ctx: makeCallCtx(),  // define makeCallCtx() at top of file (see runner.test.ts)
  stage: "review",
  stageConfig: makeStageConfig({ mode: "panel", sessionMode: "one-shot" }),
  config: DEFAULT_CONFIG,
  workdir: "/tmp",
  featureName: "feat",
})
```

- [ ] **Step 8.3: Update remaining session-*.test.ts files to use DebateRunner imports**

For each file, the pattern is the same:
1. Replace `import { DebateSession, ... } from "../../../src/debate/session"` → `import { DebateRunner, ... } from "../../../src/debate/runner"` + `import { _debateSessionDeps } from "../../../src/debate/session-helpers"`
2. Replace `import type { HybridCtx } from "../../../src/debate/session-hybrid"` → remove (HybridCtx is now internal to runner.ts)
3. Replace `new DebateSession(opts)` → `new DebateRunner({ ctx: makeCallCtx(), ...opts })`

Files to update:
- `test/unit/debate/session-stateful.test.ts` → rename to `runner-stateful.test.ts` (but `runner-stateful.test.ts` already created in Task 7 — merge)
- `test/unit/debate/session-hybrid.test.ts` → rename to `runner-hybrid.test.ts`
- `test/unit/debate/session-hybrid-rebuttal.test.ts` → merge into `runner-hybrid.test.ts` (if < 400 lines total), otherwise keep as `runner-hybrid-rebuttal.test.ts`
- `test/unit/debate/session-one-shot-roles.test.ts` → rename to `runner-one-shot-roles.test.ts`
- `test/unit/debate/session-plan.test.ts` → merge with `runner-plan.test.ts` (already created in Task 7)
- `test/unit/debate/session-rounds-and-cost.test.ts` → rename to `runner-rounds-and-cost.test.ts`
- `test/unit/debate/session-events.test.ts` → rename to `runner-events.test.ts`
- `test/unit/debate/session-agent-resolution.test.ts` → rename to `runner-agent-resolution.test.ts`

For the files that test `HybridCtx` directly (session-hybrid.test.ts, session-hybrid-rebuttal.test.ts): since `HybridCtx` is now internal, those tests should test via `new DebateRunner({ ..., stageConfig: { mode: "hybrid", sessionMode: "stateful" } }).run(prompt)`.

- [ ] **Step 8.4: Run debate test suite after import updates (before deletion)**

```bash
timeout 90 bun test test/unit/debate/ --timeout=10000
```

Expected: all pass — source files still exist, imports updated

- [ ] **Step 8.5: Delete source files**

```bash
rm src/debate/session.ts
rm src/debate/session-one-shot.ts
rm src/debate/session-stateful.ts
rm src/debate/session-hybrid.ts
rm src/debate/session-plan.ts
```

Delete the old session-*.test.ts files that have been superseded:
```bash
rm test/unit/debate/session-stateful.test.ts
rm test/unit/debate/session-hybrid.test.ts
rm test/unit/debate/session-hybrid-rebuttal.test.ts
rm test/unit/debate/session-one-shot-roles.test.ts
rm test/unit/debate/session-plan.test.ts
rm test/unit/debate/session-rounds-and-cost.test.ts
rm test/unit/debate/session-events.test.ts
rm test/unit/debate/session-agent-resolution.test.ts
rm test/unit/debate/session-mode-routing.test.ts
```

- [ ] **Step 8.6: Typecheck after deletion**

```bash
bun run typecheck 2>&1 | head -40
```

If errors appear (references to deleted files), fix them. Most likely sources of errors:
- Any remaining `import from "./session-stateful"` style paths in `runner.ts` — should be gone after Task 7
- Any test helper files referencing the old session files

- [ ] **Step 8.7: Run full debate test suite**

```bash
timeout 90 bun test test/unit/debate/ --timeout=10000
```

Expected: all pass

- [ ] **Step 8.8: Run full test suite**

```bash
bun run test
```

Expected: green (0 failures)

- [ ] **Step 8.9: Commit**

```bash
git add -A
git commit -m "refactor(adr-018): delete session-*.ts mode files; collapse into DebateRunner"
```

---

## Task 9: Final verification and exit criteria check

- [ ] **Step 9.1: Verify exit criteria**

```bash
# No DebateSession references remain in src/
grep -rn "DebateSession" src/ --include="*.ts"
# Expected: 0 matches

# No keepOpen or sessionHandle references remain in src/
grep -rn "keepOpen\|sessionHandle" src/ --include="*.ts"
# Expected: 0 matches (were already 0 after Phase D)

# No planAs calls remain in src/ (other than the deprecated stub in manager.ts)
grep -rn "\.planAs(" src/ --include="*.ts" | grep -v "manager\.ts\|utils\.ts\|types"
# Expected: 0 matches

# session-* mode files are deleted
ls src/debate/session*.ts
# Expected: only session-helpers.ts remains

# debate-builder.ts has slot methods
grep -n "proposeSlot\|rebutSlot\|rankSlot" src/prompts/builders/debate-builder.ts
# Expected: 3 matches

# DebateRunner is the sole export
grep "DebateSession\|DebateRunner" src/debate/index.ts
# Expected: only DebateRunner
```

- [ ] **Step 9.2: Lint**

```bash
bun run lint
```

Expected: clean (or fix any warnings)

- [ ] **Step 9.3: Full test suite**

```bash
bun run test
```

Expected: green

- [ ] **Step 9.4: Update tracking document**

In `docs/superpowers/plans/2026-04-26-adr-018-wave-3.md`, change Phase E status from "Not started" to "Done" and fill in the PR number.

- [ ] **Step 9.5: Final commit + update tracking doc**

```bash
git add docs/superpowers/plans/2026-04-26-adr-018-wave-3.md
git commit -m "docs(adr-018): mark Phase E complete in tracking doc"
```

---

## Exit Criteria (from tracking doc)

- [x] `DebateRunner` is the sole debate orchestration entry point
- [x] Old mode-specific debate session files deleted (`session.ts`, `session-*.ts`)
- [x] `debate-builder.ts` exposes slot methods (`proposeSlot`, `rebutSlot`, `rankSlot`)
- [x] No `planAs()` calls remain in debate module (migrated to `runInSession`)
- [x] `bun run typecheck` clean
- [x] `bun run test` green

---

## Risk Notes

| Risk | Mitigation |
|:-----|:-----------|
| `runInSession` opts differ from `planAs` opts | `PlanOptions` mapped to `SessionOpenOptions` carefully; key field: `modelDef` must be passed |
| Per-debater `CallContext` copy shares the same `storyId` | All debaters get the same `storyId` — correct, they are within the same story |
| Test files importing `HybridCtx` (internal type) break after deletion | Update those tests to test behavior via `DebateRunner.run()` with hybrid config |
| `runner.ts` file size exceeds 400 lines | Split by extracting stateful helpers into `runner-helpers.ts` if needed |
| `session-helpers.ts` imports from mode files | Verify: it does NOT import from mode files (only mode files import from it) |

---

## Self-Review: Spec Coverage Check

**Tracking doc exit criteria:**
- [x] `DebateRunner` is the sole debate orchestration entry point — Task 5 creates it; Task 8 deletes the old entry points
- [x] Old mode-specific debate session files deleted — Task 8
- [x] `debate-builder.ts` exposes slot methods — Task 1
- [x] `bun run typecheck` clean — verified in each task
- [x] `bun run test` green — verified in Task 9

**Constraints:**
- [x] `DebateRunner` does NOT implement `ISessionRunner` — confirmed (it doesn't)
- [x] `debate-propose`, `debate-rebut`, `debate-rank` → `kind: "complete"` ops — Tasks 2, 3, 4
- [x] `debate-session` → not created as a separate op (inline stateful mode uses `openSession`/`runAsSession` directly — the "or direct SessionManager.runInSession callback form" alternative chosen for multi-prompt)

**planAs migration:**
- [x] `session-plan.ts:93` `planAs()` call migrated to `sessionManager.runInSession()` — Task 7.4c

**Naming conventions:**
- All new files in `src/operations/` follow the `<verb>-<noun>.ts` pattern
- All test files mirror source paths under `test/unit/`
- Barrel imports only (via `src/debate`, `src/operations`, `src/prompts`)
