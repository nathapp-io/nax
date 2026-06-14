# Design: E2E Test Suite for the Story Orchestrator Flow

**Date:** 2026-06-14
**Branch:** `test/e2e-story-orchestrator`
**Status:** Approved design — ready for implementation plan
**Related:** [`docs/architecture/story-orchestrator-flow.md`](../../architecture/story-orchestrator-flow.md)

---

## 1. Goal

Create an **independent E2E test suite** that exercises the whole Story Orchestrator
flow — three-session and single-session modes plus the review → fix → revalidation
cycle — as the executable counterpart to `docs/architecture/story-orchestrator-flow.md`.

The suite must:

- Drive the **real** orchestrator code path (`buildPlanForStrategy(...).run()`),
  rectification loop, and `STRATEGY_TO_REVALIDATION_PHASES` map.
- Be **deterministic and reproducible** — no real agent calls, no API key, no cost.
- Run **independently** and be **excluded from `bun run test`**.

## 2. Decisions (locked)

| Axis | Decision |
|:---|:---|
| Agent fidelity | **Scripted / deterministic** — canned per-role agent responses |
| Entry point | **Orchestrator level** — `buildPlanForStrategy(ctx, story, config, strategy, inputs).run()` |
| Gate control | **Inject gate `_deps`** (attempt-aware) — real orchestrator, faked leaf execution |
| Scenarios | **All four groups** — happy paths, mechanical fix + soundness, agent-fix cycles, exhaustion/edge |

## 3. Out of scope (YAGNI)

- Real agent calls (claude/acpx) and the runner-level `run()` entry (escalation,
  crash recovery, acceptance).
- Real toolchain binaries (biome / tsc / bun test) — leaf execution is injected.
- Parallel / worktree execution and cross-package monorepo runs.

---

## 4. Placement & exclusion

- New directory: **`test/e2e/`**. Every suite uses a `describe("E2E: …")` prefix.
- **Exclusion is by construction:** `scripts/run-tests.ts` defines `PHASES` as
  `test/unit/`, `test/integration/`, `test/ui/` only. `test/e2e/` is never scanned by
  `bun run test`. **No change to `run-tests.ts`.**
- New `package.json` script (mandatory `timeout` wrapper per `testing-commands.md`):

  ```json
  "test:e2e": "timeout -k 5s 180s bun test test/e2e/ --timeout=60000"
  ```

- **Lint-gate scripts** (verified): `check-test-sizes.ts` and `check-dead-tests.ts`
  scan `join(cwd, "test")` recursively — they will include `test/e2e/` and enforce the
  800-line size limit + dead-import checks (desirable, no change needed).
  `check-test-overlap.ts` iterates a fixed type list (`unit`/`integration`/`ui`) and
  simply ignores `test/e2e/` (no change needed).
- **Advisory rule docs** need a small sanctioning edit so contributors / the nax agent
  don't flag the new directory:
  - `.claude/rules/test-architecture.md` — add an **E2E** row to the placement table
    describing `test/e2e/` as an independent, `bun run test`-excluded suite.
  - `.claude/rules/forbidden-patterns.md` — add a one-line allowance noting `test/e2e/`
    is sanctioned (it is otherwise implicitly covered by "no test files in `test/` root",
    not the subdirectory).

---

## 5. Test harness (new helpers)

All new helpers live under `test/helpers/e2e/` and are re-exported from the
`@test/helpers` barrel.

### 5.1 `scripted-agent.ts`

A programmable `AgentAdapter` factory keyed by **session role** and **attempt count**.

```typescript
type ScriptedRole =
  | "test-writer" | "implementer" | "verifier"
  | "reviewer-semantic" | "reviewer-adversarial";

interface ScriptedTurn {
  /** Raw output string the op will parse (JSON for structured ops). */
  output: string;
  filesChanged?: string[];
  estimatedCostUsd?: number;
}

interface ScriptedAgentSpec {
  /** Per-role response; receives the 0-based attempt index for this role. */
  [role: string]: (attempt: number) => ScriptedTurn;
}

/** Wraps makeAgentAdapter; dispatches by resolved session role + per-role attempt. */
export function makeScriptedAgent(spec: ScriptedAgentSpec): AgentAdapter;
```

- Role resolution mirrors production: read the session role from the turn options
  (the same field production uses — to be confirmed in the plan, `opts.interactionHandler?.role`
  or the session-name role segment).
- Review roles return canned `findings[]` carrying `source` and `fixTarget` so a specific
  fix strategy is triggered (e.g. `source: "semantic-review"`, or
  `source: "adversarial-review", fixTarget: "test"`).
- Default (unmatched role) returns a benign empty/success turn.

### 5.2 `orchestrator-harness.ts`

Single entry point that owns wiring, injection, observation, and cleanup.

```typescript
interface E2EHarnessOptions {
  strategy: TestStrategy;                 // e.g. "three-session-tdd" | "no-test"
  agent: ScriptedAgentSpec;
  gates?: {                               // attempt-aware gate results (default: pass)
    lint?: (attempt: number) => GateResult;
    typecheck?: (attempt: number) => GateResult;
    fullSuite?: (attempt: number) => GateResult;
  };
  story?: Partial<UserStory>;
  config?: Partial<NaxConfig>;
}

interface E2EHarnessResult {
  result: ExecutionPlanResult;            // { success, phaseOutputs, rectificationExhausted? }
                                          //   (verified story-orchestrator.ts:176–181 — NO top-level exitReason)
  phaseLog: PhaseRun[];                   // ordered phase executions incl. repeats (from slot instrumentation)
  strategiesFired: string[];              // which fix strategies ran
}

export async function runOrchestratorE2E(opts: E2EHarnessOptions): Promise<E2EHarnessResult>;
```

Responsibilities:

- Build runtime via `makeRuntimeWithFakeAgent(makeScriptedAgent(opts.agent), { config })`.
- Assemble `PlanInputs` via `makeMockPlanInputs` for the chosen strategy.
- Inject attempt-aware closures into `_lintCheckDeps.runQualityCommand`,
  `_typecheckCheckDeps.*`, `_fullSuiteGateDeps.runTests` — saving originals.
- Record a **phase-execution log**: **confirmed there is no phase-level dispatch event**,
  so the harness **instruments the phase slots** — wrap each slot op's `execute` to push
  `{ name, attempt }` onto an ordered log before delegating. This captures ordering and
  repeat counts. (Set-level revalidation assertions additionally use the exported pure
  function `phasesToRevalidate(strategiesRun, allPhases)` at `story-orchestrator.ts:525`,
  and `phaseOutputs` keys give the final which-phases-ran snapshot.)
- Restore all `_deps` and call `runtime.close()` in `afterEach` (per the runtime-cleanup
  forbidden-pattern rule).

### 5.3 Reused existing helpers

`makeTempDir` / `cleanupTempDir`, `makeStory`, `makeNaxConfig`, `makeMockCallContext`,
`makeMockPlanInputs`, `makeRuntimeWithFakeAgent`.

> **Open item for the plan:** `makeMockPlanInputs(overrides: Partial<PlanInputs>)`
> (verified) accepts arbitrary slot overrides, so no helper change is needed **provided
> the `PlanInputs` type already declares the `rectification` and review (`semanticReview`,
> `adversarialReview`) slots**. Confirm in the plan; only if a slot is absent from
> `PlanInputs` is a minimal test-only extension in scope.

---

## 6. Scenario matrix → file layout

Each file stays < 800 lines, split by concern.

### 6.1 `test/e2e/happy-path.e2e.test.ts`
- **3-session happy path:** strategy `three-session-tdd`, all gates pass, reviews return
  no findings. Assert phase log == `[test-writer, greenfield-gate, implementer,
  full-suite-gate, verifier, lint-check, typecheck-check, semantic-review,
  adversarial-review]` and `result.success === true`.
- **Single-session happy path:** strategy `test-after` (single-session, test-owning — so
  `verify-scoped` is wired). Assert phase log includes `verify-scoped` and **excludes**
  `test-writer` / `greenfield-gate` / `verifier`.

### 6.2 `test/e2e/mechanical-fix.e2e.test.ts`
- lint fails on attempt 0, passes on attempt 1; `mechanical-lintfix` fires.
- Assert revalidation runs **`lint-check` only**.
- **Soundness guard (§5 of the flow doc):** assert `full-suite-gate` is **NOT** re-run
  after the lint-fix (its attempt-0 pass is trusted). This is the regression guard for the
  documented assumption.

### 6.3 `test/e2e/agent-fix.e2e.test.ts`
- **autofix-implementer:** a `semantic-review` finding (and a `typecheck` variant) →
  `autofix-implementer` fires → assert revalidation set ==
  `[lint-check, typecheck-check, full-suite-gate, semantic-review, adversarial-review]`.
- **autofix-test-writer:** an `adversarial-review` finding with `fixTarget: "test"` →
  `autofix-test-writer` fires → assert revalidation set ==
  `[lint-check, typecheck-check, full-suite-gate, adversarial-review]` and **excludes
  `semantic-review` and `verifier`**.

### 6.4 `test/e2e/exhaustion-edge.e2e.test.ts`
- **Exhaustion:** a gate/review keeps failing every attempt → cycle exits with an
  `EXHAUSTED_EXIT_REASONS` reason (e.g. `max-attempts-total`) and `result.success === false`.
- **Greenfield pause:** greenfield-gate detects no tests → test-writer is skipped
  (pause behavior).
- **Verifier-SSOT staleness:** verifier passes, then a fix introduces a **new**
  full-suite-gate failure during rectification → story re-fails (staleness guard fires).

---

## 7. Assertion strategy

Primary signal is the **observed phase-execution log** (ordered, with repeats), plus:

- `result.success`, `result.rectificationExhausted`, presence/shape of `result.phaseOutputs[…]`
  (no top-level `exitReason` — exhaustion is observed via `rectificationExhausted === true`).
- `strategiesFired` — which fix strategy claimed the findings.
- Set-level revalidation assertions may also call the exported `phasesToRevalidate()` pure
  function directly for a unit-precise check alongside the end-to-end log.

This validates the revalidation-map behavior end-to-end and ties each test back to a row
in `story-orchestrator-flow.md` §4.

---

## 8. Risks & mitigations

| Risk | Mitigation |
|:---|:---|
| Harness coupled to internal op `_deps` shapes | Centralize all injection in `orchestrator-harness.ts`; one file to update if shapes change |
| `makeMockPlanInputs` may not expose rectification / review slots | Confirm in the plan; extend the test-only helper minimally if needed |
| Phase-observation seam may not exist as an event | Prefer the dispatch event bus; fallback to wrapping phase slots in the harness |
| E2E files exceeding 800 lines | Four-file split by concern; shared setup in the harness keeps files thin |
| Real `_deps` not restored → cross-test poisoning | `afterEach` save/restore enforced inside the harness, not per test |

---

## 9. Deliverables

1. `test/helpers/e2e/scripted-agent.ts` + `test/helpers/e2e/orchestrator-harness.ts`
   (+ barrel re-export).
2. Four E2E suites under `test/e2e/`.
3. `package.json` `test:e2e` script.
4. Rule-doc sanctioning edits in `.claude/rules/test-architecture.md` and
   `.claude/rules/forbidden-patterns.md`.
5. (If needed) minimal test-only extension to `makeMockPlanInputs`.

## 10. Acceptance

- `bun run test:e2e` runs all four suites green.
- `bun run test` does **not** execute `test/e2e/` (verify suite count unchanged).
- `bun run lint` and the test-gate scripts pass with the new directory present.
- Each scenario in §6 has at least one passing assertion on the phase log.
