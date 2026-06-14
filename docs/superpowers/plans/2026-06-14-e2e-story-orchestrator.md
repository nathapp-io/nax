# E2E Story Orchestrator Test Suite — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a deterministic, independent E2E suite under `test/e2e/` that drives the real Story Orchestrator (`buildPlanForStrategy(...).run()`) through three-session, single-session, and the review→fix→revalidation cycle — excluded from `bun run test`.

**Architecture:** A scripted `AgentAdapter` (canned per-role outputs) + a single harness that wires a fake-agent runtime, injects attempt-aware gate `_deps`, drives the **real** config-assembled fix strategies, and records an ordered phase-execution log by wrapping the one chokepoint every phase passes through: `_storyOrchestratorDeps.callOp`. Tests assert on the phase log, `result.{success,phaseOutputs,rectificationExhausted}`, and the exported pure `phasesToRevalidate()`.

**Tech Stack:** Bun + `bun:test`, TypeScript strict, existing `@test/helpers` factories (`makeRuntimeWithFakeAgent`, `makeMockCallContext`, `makeMockPlanInputs`, `makeNaxConfig`, `makeStory`, `makeAgentAdapter`, `makeTempDir`).

---

## Spec

`docs/superpowers/specs/2026-06-14-e2e-story-orchestrator-design.md`

## Verified facts (baked into this plan)

| Fact | Source |
|:---|:---|
| `bun run test` scans only `test/unit|integration|ui/` (PHASES) | `scripts/run-tests.ts` |
| Entry: `buildPlanForStrategy(ctx, story, config, strategy, inputs)` → `.run()` | `src/execution/build-plan-for-strategy.ts:87` |
| `run()` result: `{ success: boolean; phaseOutputs: Record<string,unknown>; rectificationExhausted?: boolean }` — **no `exitReason`** | `src/execution/story-orchestrator.ts:176-181` |
| Every phase + revalidation re-run goes through `_storyOrchestratorDeps.callOp(ctx, slot.op, input)` | `src/execution/story-orchestrator.ts:741` |
| `_storyOrchestratorDeps` exported from `@/execution` barrel | `src/execution/index.ts:43` |
| Gate injection points | `_lintCheckDeps.runQualityCommand`, `_typecheckCheckDeps.runQualityCommand`, `_fullSuiteGateDeps.runTests` |
| Fix strategies assembled from **config** inside `buildPlanForStrategy` | `src/execution/build-plan-for-strategy.ts:146-229` |
| `PlanInputs` declares all slots incl. `rectification`, `semanticReview`, `adversarialReview` | `src/execution/plan-inputs.ts:40-56` |
| Scripted agent recovers role via `handle.role` (fallback: parse `handle.id`) | `src/agents/types.ts:369` |
| `phasesToRevalidate(strategiesRun, allPhases)` exported pure fn | `src/execution/story-orchestrator.ts:525` |
| `TurnResult`: `{ output, tokenUsage, estimatedCostUsd, internalRoundTrips }` (min) | `src/agents/types.ts:446-474` |

## File structure

| File | Responsibility |
|:---|:---|
| `test/helpers/e2e/scripted-agent.ts` | Role-keyed, attempt-aware `AgentAdapter` factory |
| `test/helpers/e2e/orchestrator-harness.ts` | Runtime wiring, gate `_deps` injection, `callOp` instrumentation, plan build+run, cleanup |
| `test/helpers/e2e/index.ts` | Barrel for the two helpers |
| `test/helpers/index.ts` | Re-export the e2e barrel (modify) |
| `test/e2e/_smoke.e2e.test.ts` | Proves `test/e2e/` runs and is excluded from `bun run test` |
| `test/e2e/happy-path.e2e.test.ts` | 3-session + single-session happy paths |
| `test/e2e/mechanical-fix.e2e.test.ts` | lint-fix → only lint-check re-runs; gate NOT re-run |
| `test/e2e/agent-fix.e2e.test.ts` | autofix-implementer + autofix-test-writer revalidation sets |
| `test/e2e/exhaustion-edge.e2e.test.ts` | exhaustion, greenfield pause, staleness guard |
| `package.json` | add `test:e2e` script (modify) |
| `.claude/rules/test-architecture.md` | sanction `test/e2e/` (modify) |
| `.claude/rules/forbidden-patterns.md` | sanction `test/e2e/` (modify) |

---

## Task 1: Scaffolding — script, rule docs, and exclusion-proving smoke test

**Files:**
- Modify: `package.json` (scripts block)
- Modify: `.claude/rules/test-architecture.md`
- Modify: `.claude/rules/forbidden-patterns.md`
- Create: `test/e2e/_smoke.e2e.test.ts`

- [ ] **Step 1: Add the `test:e2e` script**

In `package.json`, add after the `"test:ui"` line:

```json
    "test:e2e": "timeout -k 5s 180s bun test test/e2e/ --timeout=60000",
```

- [ ] **Step 2: Write the smoke test**

`test/e2e/_smoke.e2e.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";

describe("E2E: smoke", () => {
  test("test/e2e suite executes", () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 3: Verify the e2e suite runs via its own script**

Run: `bun run test:e2e`
Expected: PASS, 1 test in `test/e2e/_smoke.e2e.test.ts`.

- [ ] **Step 4: Verify `bun run test` EXCLUDES test/e2e**

Run: `bun run test 2>&1 | grep -c "_smoke.e2e"`
Expected: `0` (the smoke test is not picked up by the unit/integration/ui phases).

- [ ] **Step 5: Sanction the directory in the rule docs**

In `.claude/rules/test-architecture.md`, add a row to the placement table (after the `UI` row):

```markdown
| E2E | `test/e2e/*.e2e.test.ts` | Independent end-to-end suite. **Excluded from `bun run test`** — run via `bun run test:e2e`. For full-flow orchestration tests with scripted agents. |
```

In `.claude/rules/forbidden-patterns.md`, under the **Test Files** table, add a clarifying row:

```markdown
| Test files in `test/` root | `test/unit/`, `test/integration/`, `test/ui/`, or `test/e2e/` (sanctioned independent suite, run via `bun run test:e2e`) | Orphaned files with no clear ownership |
```

(Replace the existing "Test files in `test/` root" row with this expanded version.)

- [ ] **Step 6: Verify lint + size gates accept the new directory**

Run: `bun run lint && bun run scripts/check-test-sizes.ts`
Expected: PASS (no new violations).

- [ ] **Step 7: Commit**

```bash
git add package.json .claude/rules/test-architecture.md .claude/rules/forbidden-patterns.md test/e2e/_smoke.e2e.test.ts
git commit -m "test(e2e): scaffold test/e2e suite excluded from bun run test"
```

---

## Task 2: Scripted agent helper

**Files:**
- Create: `test/helpers/e2e/scripted-agent.ts`
- Create: `test/helpers/e2e/index.ts`
- Test: `test/e2e/scripted-agent.e2e.test.ts` (co-located in e2e to avoid polluting `bun run test`)

- [ ] **Step 1: Write the failing test**

`test/e2e/scripted-agent.e2e.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { makeScriptedAgent } from "@test/helpers";
import type { SessionHandle, SendTurnOpts } from "@/agents/types";

function fakeHandle(role: string): SessionHandle {
  return { id: `nax-abcd1234-feat-US-001-${role}`, agentName: "claude", role: role as never };
}
const noopOpts = { interactionHandler: {} as never } satisfies SendTurnOpts;

describe("E2E: makeScriptedAgent", () => {
  test("dispatches sendTurn by role and attempt", async () => {
    const seen: string[] = [];
    const agent = makeScriptedAgent({
      "test-writer": (attempt) => ({ output: `tw-${attempt}` }),
      implementer: (attempt) => ({ output: `impl-${attempt}` }),
    });

    const h1 = await agent.openSession({ sessionName: fakeHandle("test-writer").id } as never);
    const r1 = await agent.sendTurn(fakeHandle("test-writer"), "p", noopOpts);
    const r2 = await agent.sendTurn(fakeHandle("test-writer"), "p", noopOpts);
    const r3 = await agent.sendTurn(fakeHandle("implementer"), "p", noopOpts);
    seen.push(r1.output, r2.output, r3.output);

    expect(seen).toEqual(["tw-0", "tw-1", "impl-0"]);
  });

  test("unknown role returns benign success turn", async () => {
    const agent = makeScriptedAgent({});
    const r = await agent.sendTurn(fakeHandle("verifier"), "p", noopOpts);
    expect(r.output).toBe("{}");
    expect(r.estimatedCostUsd).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `timeout 30 bun test test/e2e/scripted-agent.e2e.test.ts --timeout=5000`
Expected: FAIL — `makeScriptedAgent` not exported.

- [ ] **Step 3: Implement `scripted-agent.ts`**

`test/helpers/e2e/scripted-agent.ts`:

```typescript
/**
 * E2E-only: a programmable AgentAdapter keyed by session role + per-role attempt.
 * Wraps makeAgentAdapter; recovers the role from `handle.role` (fallback: last
 * segment of the session id `nax-<hash>-<feat>-<story>-<role>`).
 */
import type { AgentAdapter, SessionHandle, TurnResult } from "@/agents/types";
import { makeAgentAdapter } from "../mock-agent-adapter";

export interface ScriptedTurn {
  output: string;
  estimatedCostUsd?: number;
}

export type ScriptedAgentSpec = Record<string, (attempt: number) => ScriptedTurn>;

function roleOf(handle: SessionHandle): string {
  if (handle.role) return handle.role;
  const parts = handle.id.split("-");
  return parts[parts.length - 1] ?? "main";
}

function toTurnResult(t: ScriptedTurn): TurnResult {
  return {
    output: t.output,
    tokenUsage: { inputTokens: 1, outputTokens: 1 },
    estimatedCostUsd: t.estimatedCostUsd ?? 0,
    internalRoundTrips: 1,
  };
}

const BENIGN: ScriptedTurn = { output: "{}", estimatedCostUsd: 0 };

export function makeScriptedAgent(spec: ScriptedAgentSpec): AgentAdapter {
  const attempts = new Map<string, number>();
  return makeAgentAdapter({
    sendTurn: async (handle, _prompt, _opts) => {
      const role = roleOf(handle);
      const n = attempts.get(role) ?? 0;
      attempts.set(role, n + 1);
      const fn = spec[role];
      return toTurnResult(fn ? fn(n) : BENIGN);
    },
  });
}
```

- [ ] **Step 4: Create the e2e helper barrel**

`test/helpers/e2e/index.ts`:

```typescript
export { makeScriptedAgent } from "./scripted-agent";
export type { ScriptedAgentSpec, ScriptedTurn } from "./scripted-agent";
```

- [ ] **Step 5: Re-export from the main helper barrel**

In `test/helpers/index.ts`, add:

```typescript
export { makeScriptedAgent } from "./e2e";
export type { ScriptedAgentSpec, ScriptedTurn } from "./e2e";
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `timeout 30 bun test test/e2e/scripted-agent.e2e.test.ts --timeout=5000`
Expected: PASS.

> If `makeAgentAdapter`'s default `openSession` does not return a handle whose `id`
> equals the provided `sessionName`, the role-from-id fallback may break. The test above
> passes `handle.role` directly, so this is not load-bearing — but confirm `makeAgentAdapter`
> accepts a `sendTurn` override (it does, per `test/helpers/mock-agent-adapter.ts`).

- [ ] **Step 7: Commit**

```bash
git add test/helpers/e2e/ test/helpers/index.ts test/e2e/scripted-agent.e2e.test.ts
git commit -m "test(e2e): add scripted agent helper"
```

---

## Task 3: Orchestrator harness

**Files:**
- Create: `test/helpers/e2e/orchestrator-harness.ts`
- Modify: `test/helpers/e2e/index.ts`, `test/helpers/index.ts`
- Test: `test/e2e/harness.e2e.test.ts`

- [ ] **Step 1: Discovery — confirm rectification config gating**

Read `shouldRunRectification` (grep `src/execution/build-plan-for-strategy.ts`) and the default `config.execution.rectification` / `config.quality.autofix` shape in `src/config/schemas.ts`. Note the exact keys needed so `buildPlanForStrategy` assembles strategies:
- `config.quality.commands.lintFix` set (string) → enables `mechanical-lintfix`
- `config.quality.autofix.enabled !== false` → enables autofix-implementer/test-writer
- whatever `shouldRunRectification(config)` checks (likely `config.execution.rectification.enabled`/`maxAttemptsTotal > 0`)

Write the confirmed keys into a `makeE2EConfig()` helper in the harness (Step 3).

- [ ] **Step 2: Write the failing test**

`test/e2e/harness.e2e.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { runOrchestratorE2E } from "@test/helpers";

describe("E2E: harness", () => {
  test("runs a three-session happy path and records an ordered phase log", async () => {
    const { result, phaseLog } = await runOrchestratorE2E({
      strategy: "three-session-tdd",
      agent: {
        "test-writer": () => ({ output: JSON.stringify({ filesChanged: ["test/a.test.ts"] }) }),
        implementer: () => ({ output: JSON.stringify({ filesChanged: ["src/a.ts"] }) }),
        verifier: () => ({ output: JSON.stringify({ passed: true, findings: [] }) }),
        "reviewer-semantic": () => ({ output: JSON.stringify({ passed: true, findings: [] }) }),
        "reviewer-adversarial": () => ({ output: JSON.stringify({ passed: true, findings: [] }) }),
      },
    });

    expect(result.success).toBe(true);
    expect(phaseLog).toContain("implementer");
    expect(phaseLog.indexOf("implementer")).toBeLessThan(phaseLog.indexOf("verifier"));
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `timeout 60 bun test test/e2e/harness.e2e.test.ts --timeout=30000`
Expected: FAIL — `runOrchestratorE2E` not exported.

- [ ] **Step 4: Implement the harness**

`test/helpers/e2e/orchestrator-harness.ts`:

```typescript
/**
 * E2E-only: drives the REAL Story Orchestrator end-to-end with scripted agents +
 * attempt-aware gate _deps. Records an ordered phase log by wrapping the single
 * chokepoint every phase passes through: _storyOrchestratorDeps.callOp.
 */
import { afterEach } from "bun:test";
import { _storyOrchestratorDeps, buildPlanForStrategy } from "@/execution";
import { _lintCheckDeps } from "@/operations/lint-check";
import { _typecheckCheckDeps } from "@/operations/typecheck-check";
import { _fullSuiteGateDeps } from "@/operations/full-suite-gate";
import type { NaxConfig } from "@/config/runtime-types";
import type { TestStrategy } from "@/config/test-strategy";
import type { UserStory } from "@/prd/types";
import type { QualityCommandResult } from "@/quality/runner";
import {
  makeMockCallContext,
  makeMockPlanInputs,
  makeNaxConfig,
  makeRuntimeWithFakeAgent,
  makeStory,
  makeTempDir,
  cleanupTempDir,
} from "../index";
import { makeScriptedAgent, type ScriptedAgentSpec } from "./scripted-agent";

type GateFn<T> = (attempt: number) => T;
const PASS_QC = (name: string): QualityCommandResult => ({
  commandName: name, command: `${name}-cmd`, success: true, exitCode: 0,
  output: "", durationMs: 1, timedOut: false,
});
const FAIL_QC = (name: string): QualityCommandResult => ({
  commandName: name, command: `${name}-cmd`, success: false, exitCode: 1,
  output: `${name} failed`, durationMs: 1, timedOut: false,
});

export interface E2EGates {
  lint?: GateFn<QualityCommandResult>;
  typecheck?: GateFn<QualityCommandResult>;
  fullSuite?: GateFn<{ passed: boolean; failed: number; output?: string }>;
}

export interface E2EOptions {
  strategy: TestStrategy;
  agent: ScriptedAgentSpec;
  gates?: E2EGates;
  story?: Partial<UserStory>;
  config?: Partial<NaxConfig>;
}

export interface E2EResult {
  result: { success: boolean; phaseOutputs: Record<string, unknown>; rectificationExhausted?: boolean };
  phaseLog: string[];
  strategiesFired: string[];
}

/** Config that turns on the real rectification strategy assembly. Confirm keys in Step 1. */
function makeE2EConfig(overrides?: Partial<NaxConfig>): NaxConfig {
  return makeNaxConfig({
    quality: { commands: { lint: "lint", typecheck: "tc", test: "t", lintFix: "lint --fix" }, autofix: { enabled: true } },
    ...overrides,
  } as Partial<NaxConfig>);
}

export async function runOrchestratorE2E(opts: E2EOptions): Promise<E2EResult> {
  const workdir = makeTempDir("nax-e2e-");
  const config = makeE2EConfig(opts.config);
  const story = makeStory({ id: "US-001", ...opts.story });

  const { runtime } = makeRuntimeWithFakeAgent(makeScriptedAgent(opts.agent), { config, workdir });

  // --- save originals ---
  const orig = {
    callOp: _storyOrchestratorDeps.callOp,
    lint: _lintCheckDeps.runQualityCommand,
    tc: _typecheckCheckDeps.runQualityCommand,
    fullSuite: _fullSuiteGateDeps.runTests,
  };

  const phaseLog: string[] = [];
  const PHASE_NAMES = new Set([
    "test-writer", "greenfield-gate", "implementer", "full-suite-gate", "verifier",
    "verify-scoped", "lint-check", "typecheck-check", "semantic-review", "adversarial-review",
  ]);
  const strategiesFired: string[] = [];

  _storyOrchestratorDeps.callOp = async (ctx, op, input) => {
    if (PHASE_NAMES.has(op.name)) phaseLog.push(op.name);
    else strategiesFired.push(op.name);
    return orig.callOp(ctx, op, input);
  };

  const lintAttempts = { n: 0 }, tcAttempts = { n: 0 }, fsAttempts = { n: 0 };
  _lintCheckDeps.runQualityCommand = async () =>
    (opts.gates?.lint?.(lintAttempts.n++) ?? PASS_QC("lint"));
  _typecheckCheckDeps.runQualityCommand = async () =>
    (opts.gates?.typecheck?.(tcAttempts.n++) ?? PASS_QC("typecheck"));
  _fullSuiteGateDeps.runTests = async (input, gateCtx) => {
    const g = opts.gates?.fullSuite?.(fsAttempts.n++) ?? { passed: true, failed: 0 };
    return { passed: g.passed, failed: g.failed, output: g.output ?? "", parsedSummary: { passed: g.passed ? 1 : 0, failed: g.failed, skipped: 0 } as never, timedOut: false };
  };

  // --- inputs: all slots populated; buildPlanForStrategy assembles real strategies from config ---
  const inputs = makeMockPlanInputs({
    story, config,
    testWriter: { story } as never,
    greenfieldGate: { story, workdir } as never,
    implementer: { story } as never,
    fullSuiteGate: { story, workdir } as never,
    verifier: { story } as never,
    verifyScoped: { story, workdir } as never,
    lintCheck: { workdir, storyId: story.id } as never,
    typecheckCheck: { workdir, storyId: story.id } as never,
    semanticReview: { story } as never,
    adversarialReview: { story } as never,
    rectification: { maxAttempts: 3, strategies: [], abortOnIncreasingFailures: false },
  });

  const ctx = makeMockCallContext({ runtime, packageDir: workdir });

  try {
    const plan = await buildPlanForStrategy(ctx, story, config, opts.strategy, inputs);
    const result = await plan.run();
    return { result, phaseLog, strategiesFired };
  } finally {
    _storyOrchestratorDeps.callOp = orig.callOp;
    _lintCheckDeps.runQualityCommand = orig.lint;
    _typecheckCheckDeps.runQualityCommand = orig.tc;
    _fullSuiteGateDeps.runTests = orig.fullSuite;
    await runtime.close();
    cleanupTempDir(workdir);
  }
}

afterEach(() => {
  // Defensive: restore happens in finally; this guards against a throw before finally.
});
```

- [ ] **Step 5: Resolve real input slot shapes**

The `{ story } as never` casts above are placeholders for the real op-input types. For each slot, read the input type referenced in `src/execution/plan-inputs.ts:40-56` (e.g. `TestWriterInput`, `ImplementerInput`, `FullSuiteGateInput`, `LintCheckInput`) and replace the cast with the correctly-shaped object. Mirror what `assemblePlanInputs` builds in `src/execution/plan-inputs.ts`. Remove every `as never` cast — strict mode must pass.

- [ ] **Step 6: Export from barrels**

Add to `test/helpers/e2e/index.ts`:

```typescript
export { runOrchestratorE2E } from "./orchestrator-harness";
export type { E2EOptions, E2EResult, E2EGates } from "./orchestrator-harness";
```

Add to `test/helpers/index.ts`:

```typescript
export { runOrchestratorE2E } from "./e2e";
export type { E2EOptions, E2EResult, E2EGates } from "./e2e";
```

- [ ] **Step 7: Run the harness test**

Run: `timeout 60 bun test test/e2e/harness.e2e.test.ts --timeout=30000`
Expected: PASS — `result.success === true`, `implementer` before `verifier` in `phaseLog`.

- [ ] **Step 8: Typecheck**

Run: `bun run typecheck`
Expected: PASS (no `as never` left, all slot shapes correct).

- [ ] **Step 9: Commit**

```bash
git add test/helpers/e2e/ test/helpers/index.ts test/e2e/harness.e2e.test.ts
git commit -m "test(e2e): add orchestrator harness with callOp phase instrumentation"
```

---

## Task 4: Happy-path suite

**Files:**
- Create: `test/e2e/happy-path.e2e.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, expect, test } from "bun:test";
import { runOrchestratorE2E } from "@test/helpers";

const PASS_REVIEW = () => ({ output: JSON.stringify({ passed: true, findings: [] }) });
const tw = () => ({ output: JSON.stringify({ filesChanged: ["test/a.test.ts"] }) });
const impl = () => ({ output: JSON.stringify({ filesChanged: ["src/a.ts"] }) });
const verifier = () => ({ output: JSON.stringify({ passed: true, findings: [] }) });

describe("E2E: happy path", () => {
  test("three-session runs all phases in canonical order", async () => {
    const { result, phaseLog } = await runOrchestratorE2E({
      strategy: "three-session-tdd",
      agent: { "test-writer": tw, implementer: impl, verifier,
        "reviewer-semantic": PASS_REVIEW, "reviewer-adversarial": PASS_REVIEW },
    });
    expect(result.success).toBe(true);
    expect(phaseLog).toEqual([
      "test-writer", "greenfield-gate", "implementer", "full-suite-gate",
      "verifier", "lint-check", "typecheck-check", "semantic-review", "adversarial-review",
    ]);
  });

  test("single-session excludes test-writer/greenfield/verifier and includes verify-scoped", async () => {
    const { result, phaseLog } = await runOrchestratorE2E({
      strategy: "test-after",
      agent: { implementer: impl, "reviewer-semantic": PASS_REVIEW, "reviewer-adversarial": PASS_REVIEW },
    });
    expect(result.success).toBe(true);
    expect(phaseLog).not.toContain("test-writer");
    expect(phaseLog).not.toContain("greenfield-gate");
    expect(phaseLog).not.toContain("verifier");
    expect(phaseLog).toContain("verify-scoped");
  });
});
```

- [ ] **Step 2: Run**

Run: `timeout 90 bun test test/e2e/happy-path.e2e.test.ts --timeout=30000`
Expected: Initially may FAIL if the exact canonical `phaseLog` differs (e.g. greenfield-gate pauses). Adjust the expected array to the observed order — **the observed order IS the assertion**; document any deviation from `story-orchestrator-flow.md` §2 in a code comment. Re-run to PASS.

- [ ] **Step 3: Commit**

```bash
git add test/e2e/happy-path.e2e.test.ts
git commit -m "test(e2e): three-session and single-session happy paths"
```

---

## Task 5: Mechanical lint-fix + soundness assertion

**Files:**
- Create: `test/e2e/mechanical-fix.e2e.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, test } from "bun:test";
import { runOrchestratorE2E } from "@test/helpers";

const PASS_REVIEW = () => ({ output: JSON.stringify({ passed: true, findings: [] }) });
const impl = () => ({ output: JSON.stringify({ filesChanged: ["src/a.ts"] }) });

describe("E2E: mechanical lint-fix", () => {
  test("lint fails then passes; only lint-check re-runs; gate NOT re-run", async () => {
    let lintCalls = 0;
    const { result, phaseLog, strategiesFired } = await runOrchestratorE2E({
      strategy: "test-after",
      agent: { implementer: impl, "reviewer-semantic": PASS_REVIEW, "reviewer-adversarial": PASS_REVIEW },
      gates: {
        lint: (attempt) => {
          lintCalls++;
          return attempt === 0
            ? { commandName: "lint", command: "lint", success: false, exitCode: 1, output: "lint error", durationMs: 1, timedOut: false }
            : { commandName: "lint", command: "lint", success: true, exitCode: 0, output: "", durationMs: 1, timedOut: false };
        },
      },
    });

    expect(result.success).toBe(true);
    expect(strategiesFired).toContain("mechanical-lintfix");
    // lint-check ran twice (initial fail + revalidation pass)
    expect(phaseLog.filter((p) => p === "lint-check").length).toBe(2);
    // SOUNDNESS (flow-doc §5): full-suite-gate is NOT re-run after lint-fix.
    // verify-scoped is the single-session gate; it ran once, before the lint-fix.
    const verifyScopedRuns = phaseLog.filter((p) => p === "verify-scoped").length;
    expect(verifyScopedRuns).toBe(1);
  });
});
```

- [ ] **Step 2: Run, observe, lock**

Run: `timeout 90 bun test test/e2e/mechanical-fix.e2e.test.ts --timeout=30000`
Expected: PASS. If `mechanical-lintfix` does not fire, confirm `config.quality.commands.lintFix` is set in `makeE2EConfig` (Task 3 Step 1) and that lint findings carry `source: "lint"`. The key soundness assertion is that the test gate does not re-run a second time after the lint-fix.

- [ ] **Step 3: Commit**

```bash
git add test/e2e/mechanical-fix.e2e.test.ts
git commit -m "test(e2e): lint-fix revalidation + gate-not-rerun soundness guard"
```

---

## Task 6: Agent-fix cycles

**Files:**
- Create: `test/e2e/agent-fix.e2e.test.ts`

- [ ] **Step 1: Implementer-fix via typecheck (no review JSON needed)**

A `typecheck` failure produces `source: "typecheck"`, which `autofix-implementer` claims — the simplest deterministic trigger.

```typescript
import { describe, expect, test } from "bun:test";
import { runOrchestratorE2E } from "@test/helpers";

const PASS_REVIEW = () => ({ output: JSON.stringify({ passed: true, findings: [] }) });
const impl = () => ({ output: JSON.stringify({ filesChanged: ["src/a.ts"] }) });

describe("E2E: agent-fix", () => {
  test("typecheck fail -> autofix-implementer -> full revalidation chain", async () => {
    const { result, phaseLog, strategiesFired } = await runOrchestratorE2E({
      strategy: "test-after",
      agent: { implementer: impl, "reviewer-semantic": PASS_REVIEW, "reviewer-adversarial": PASS_REVIEW },
      gates: {
        typecheck: (attempt) =>
          attempt === 0
            ? { commandName: "typecheck", command: "tc", success: false, exitCode: 1, output: "TS2304", durationMs: 1, timedOut: false }
            : { commandName: "typecheck", command: "tc", success: true, exitCode: 0, output: "", durationMs: 1, timedOut: false },
      },
    });

    expect(result.success).toBe(true);
    expect(strategiesFired).toContain("autofix-implementer");
    // Full chain re-runs: lint, typecheck, gate, semantic, adversarial all appear >1x
    expect(phaseLog.filter((p) => p === "typecheck-check").length).toBeGreaterThanOrEqual(2);
    expect(phaseLog.filter((p) => p === "semantic-review").length).toBeGreaterThanOrEqual(2);
  });
});
```

- [ ] **Step 2: Run**

Run: `timeout 90 bun test test/e2e/agent-fix.e2e.test.ts --timeout=30000`
Expected: PASS — `autofix-implementer` fired, full chain re-ran.

- [ ] **Step 3: Discovery for the adversarial-test-writer path**

To trigger `autofix-test-writer` you need an `adversarial-review` finding with `fixTarget: "test"`. Read:
- `validateAdversarialShape` and the `verify()`/`toAdversarialReviewFindings` in `src/operations/adversarial-review.ts` — determine the exact JSON the scripted `reviewer-adversarial` agent must output so it parses to a finding with `source: "adversarial-review"`, `fixTarget: "test"` (adversarial "test-gap" findings are always `test`).
- Note: adversarial parse THROWS `ParseValidationError` on bad shape, so the JSON must be exact.

Write down the confirmed JSON shape, e.g. (verify the field names):

```json
{ "passed": false, "findings": [
  { "severity": "error", "category": "test-gap", "message": "missing edge-case test",
    "file": "test/a.test.ts", "fixTarget": "test" } ] }
```

- [ ] **Step 4: Write the test-writer-fix test (three-session)**

`autofix-test-writer` is only assembled in three-session mode (build-plan-for-strategy.ts:205). Use `strategy: "three-session-tdd"`. The adversarial agent returns the confirmed failing JSON on attempt 0, passing JSON on attempt 1.

```typescript
test("adversarial(test) -> autofix-test-writer -> revalidation excludes semantic + verifier", async () => {
  const tw = () => ({ output: JSON.stringify({ filesChanged: ["test/a.test.ts"] }) });
  const impl2 = () => ({ output: JSON.stringify({ filesChanged: ["src/a.ts"] }) });
  const verifier = () => ({ output: JSON.stringify({ passed: true, findings: [] }) });
  let advCall = 0;
  const adversarial = () => {
    const failing = JSON.stringify({ passed: false, findings: [
      { severity: "error", category: "test-gap", message: "missing test", file: "test/a.test.ts", fixTarget: "test" }] });
    const passing = JSON.stringify({ passed: true, findings: [] });
    return { output: advCall++ === 0 ? failing : passing };
  };

  const { result, phaseLog, strategiesFired } = await runOrchestratorE2E({
    strategy: "three-session-tdd",
    agent: { "test-writer": tw, implementer: impl2, verifier,
      "reviewer-semantic": () => ({ output: JSON.stringify({ passed: true, findings: [] }) }),
      "reviewer-adversarial": adversarial },
  });

  expect(result.success).toBe(true);
  expect(strategiesFired).toContain("autofix-test-writer");
  // Revalidation re-runs adversarial-review but NOT semantic-review or verifier.
  const reruns = (p: string) => phaseLog.filter((x) => x === p).length;
  expect(reruns("adversarial-review")).toBeGreaterThanOrEqual(2);
  expect(reruns("verifier")).toBe(1);          // verifier is once-per-story
  expect(reruns("semantic-review")).toBe(1);   // excluded from test-writer revalidation
});
```

- [ ] **Step 5: Run + reconcile**

Run: `timeout 120 bun test test/e2e/agent-fix.e2e.test.ts --timeout=60000`
Expected: PASS. If the adversarial JSON shape is rejected (ParseValidationError → `looksLikeFail` path with no findings → no `fixTarget:test`), revisit Step 3 and correct the JSON to match `validateAdversarialShape`. Cross-check the revalidation expectations against `STRATEGY_TO_REVALIDATION_PHASES["autofix-test-writer"]` (`story-orchestrator.ts:498`).

- [ ] **Step 6: Commit**

```bash
git add test/e2e/agent-fix.e2e.test.ts
git commit -m "test(e2e): autofix-implementer and autofix-test-writer revalidation sets"
```

---

## Task 7: Exhaustion + edge cases

**Files:**
- Create: `test/e2e/exhaustion-edge.e2e.test.ts`

- [ ] **Step 1: Exhaustion test (typecheck never recovers)**

```typescript
import { describe, expect, test } from "bun:test";
import { runOrchestratorE2E } from "@test/helpers";

const PASS_REVIEW = () => ({ output: JSON.stringify({ passed: true, findings: [] }) });
const impl = () => ({ output: JSON.stringify({ filesChanged: ["src/a.ts"] }) });

describe("E2E: exhaustion + edge", () => {
  test("persistent typecheck failure exhausts rectification and fails the story", async () => {
    const { result } = await runOrchestratorE2E({
      strategy: "test-after",
      agent: { implementer: impl, "reviewer-semantic": PASS_REVIEW, "reviewer-adversarial": PASS_REVIEW },
      gates: {
        typecheck: () => ({ commandName: "typecheck", command: "tc", success: false, exitCode: 1, output: "TS2304", durationMs: 1, timedOut: false }),
      },
    });
    expect(result.success).toBe(false);
    expect(result.rectificationExhausted).toBe(true);
  });
});
```

- [ ] **Step 2: Run**

Run: `timeout 120 bun test test/e2e/exhaustion-edge.e2e.test.ts --timeout=60000`
Expected: PASS — story fails, `rectificationExhausted === true`.

- [ ] **Step 3: Greenfield-pause test**

```typescript
test("greenfield (no tests) pauses and skips test-writer", async () => {
  const impl2 = () => ({ output: JSON.stringify({ filesChanged: ["src/a.ts"] }) });
  const { phaseLog } = await runOrchestratorE2E({
    strategy: "three-session-tdd",
    story: { /* fresh story; greenfield-gate detects no existing test files in the empty temp repo */ },
    agent: { "test-writer": () => ({ output: "{}" }), implementer: impl2, verifier: () => ({ output: JSON.stringify({ passed: true, findings: [] }) }),
      "reviewer-semantic": PASS_REVIEW, "reviewer-adversarial": PASS_REVIEW },
  });
  // greenfield-gate runs; observe whether test-writer was skipped. Lock to observed behavior.
  expect(phaseLog).toContain("greenfield-gate");
});
```

> The temp repo is empty (no test files), so greenfield-gate should pause. Run, observe the
> actual `phaseLog` (whether `test-writer` appears), and tighten the assertion to match —
> document the observed behavior against flow-doc §2 in a comment.

- [ ] **Step 4: Staleness-guard test**

Drive: verifier passes, but a fix introduces a NEW full-suite-gate failure during rectification (use `fullSuite` gate returning pass initially, then fail after a fix is triggered by a separate lint/typecheck finding). Assert `result.success === false` due to the staleness guard (`story-orchestrator.ts:1297`).

```typescript
test("verifier passes but gate regresses during rectification -> story re-fails", async () => {
  const tw = () => ({ output: JSON.stringify({ filesChanged: ["test/a.test.ts"] }) });
  const impl2 = () => ({ output: JSON.stringify({ filesChanged: ["src/a.ts"] }) });
  const verifier = () => ({ output: JSON.stringify({ passed: true, findings: [] }) });
  let fsCall = 0, tcCall = 0;
  const { result } = await runOrchestratorE2E({
    strategy: "three-session-tdd",
    agent: { "test-writer": tw, implementer: impl2, verifier,
      "reviewer-semantic": PASS_REVIEW, "reviewer-adversarial": PASS_REVIEW },
    gates: {
      // typecheck fails once to trigger a fix cycle
      typecheck: () => (tcCall++ === 0
        ? { commandName: "typecheck", command: "tc", success: false, exitCode: 1, output: "TS2304", durationMs: 1, timedOut: false }
        : { commandName: "typecheck", command: "tc", success: true, exitCode: 0, output: "", durationMs: 1, timedOut: false }),
      // gate passes pre-rectification, regresses during revalidation
      fullSuite: () => (fsCall++ === 0 ? { passed: true, failed: 0 } : { passed: false, failed: 1, output: "new failure" }),
    },
  });
  expect(result.success).toBe(false);
});
```

- [ ] **Step 5: Run all edge tests + reconcile**

Run: `timeout 150 bun test test/e2e/exhaustion-edge.e2e.test.ts --timeout=60000`
Expected: PASS. These exercise complex control flow — observe actual results and reconcile assertions against `story-orchestrator.ts` (`rectificationExhausted`, the staleness guard at `:1297`, greenfield pause). Tighten each assertion to observed-and-documented behavior; do not assert behavior the code does not exhibit.

- [ ] **Step 6: Commit**

```bash
git add test/e2e/exhaustion-edge.e2e.test.ts
git commit -m "test(e2e): exhaustion, greenfield pause, and staleness-guard scenarios"
```

---

## Task 8: Final verification

- [ ] **Step 1: Full e2e suite green**

Run: `bun run test:e2e`
Expected: all suites PASS.

- [ ] **Step 2: Confirm exclusion from `bun run test`**

Run: `bun run test 2>&1 | grep -cE "\.e2e\.test"`
Expected: `0`.

- [ ] **Step 3: Lint + typecheck**

Run: `bun run lint && bun run typecheck`
Expected: PASS.

- [ ] **Step 4: Remove the scaffolding smoke test (superseded)**

Delete `test/e2e/_smoke.e2e.test.ts` (the real suites now prove the directory works). Re-run Steps 1–2.

```bash
git rm test/e2e/_smoke.e2e.test.ts
git commit -m "test(e2e): drop scaffolding smoke test (superseded by real suites)"
```

- [ ] **Step 5: Final commit / push**

```bash
git push -u origin test/e2e-story-orchestrator
```

---

## Open items resolved during planning

- **Role resolution:** `handle.role` (fallback parse `handle.id`). ✓
- **PlanInputs slots:** all present incl. `rectification`/`semanticReview`/`adversarialReview` — no helper extension. ✓
- **Phase observation:** wrap `_storyOrchestratorDeps.callOp` (one chokepoint, ordered, captures revalidation repeats + strategy names). ✓
- **Strategy assembly:** done by `buildPlanForStrategy` from config — harness sets `config.quality.commands.lintFix` + `config.quality.autofix.enabled` + `inputs.rectification`, never hand-builds strategies. ✓

## Residual discovery (flagged inline, not blockers)

1. **Slot input shapes** (Task 3 Step 5) — replace `as never` casts with real op-input objects mirroring `assemblePlanInputs`.
2. **Rectification config gating** (Task 3 Step 1) — confirm `shouldRunRectification` keys.
3. **Adversarial review JSON schema** (Task 6 Step 3) — confirm `validateAdversarialShape` shape for a `fixTarget:"test"` finding.
4. **Observed-order reconciliation** — happy-path/edge assertions lock to observed phase order; document any deviation from `story-orchestrator-flow.md` §2 in comments.
