# ADR-022 Implementation Plan — Phases 1–8

**Date:** 2026-05-02
**Status:** Pre-implementation — settles per-phase scope before PR work begins
**Scope:** Detailed plan for `runFixCycle` + `FixStrategy` + `buildPriorIterationsBlock` and per-subsystem migrations
**ADRs:** [ADR-022](../adr/ADR-022-fix-strategy-and-cycle.md) (this plan); [ADR-021](../adr/ADR-021-findings-and-fix-strategy-ssot.md) (companion — wire format)
**Companion plan:** [docs/specs/2026-05-02-adr-021-implementation-plan.md](./2026-05-02-adr-021-implementation-plan.md)
**Tracking:** [#867](https://github.com/nathapp-io/nax/issues/867)

---

## 1. Overview

ADR-022 introduces unified fix orchestration on top of ADR-021's `Finding` wire format. Eight phases:

| Phase | Goal | Risk | Flag |
|:---|:---|:---|:---|
| 1 | Cycle types in `src/findings/cycle-types.ts` | zero | none |
| 2 | `runFixCycle` + `classifyOutcome` in `src/findings/cycle.ts` | low | none |
| 3 | `buildPriorIterationsBlock` shared prompt helper | zero | none |
| 4 | Acceptance migration (ships dogfood regression fix) | medium | `acceptance.fix.cycleV2` |
| 5 | Adversarial migration | low | none |
| 6 | Semantic migration | low | none |
| 7 | Autofix migration (lint + typecheck + adversarial + plugin + test-writer/implementer) | medium-high | `quality.autofix.cycleV2` (shadow mode 2 releases) |
| 8 | Cleanup (delete legacy carry-forward types; remove flags) | zero | n/a |

**Hard prerequisite:** ADR-021 phase 1 (`src/findings/types.ts` + `src/findings/index.ts`) must be merged (PR #868) before any phase of this plan begins. Every phase imports from `src/findings` — if the barrel doesn't exist, `bun run typecheck` will fail immediately.

**Migration model:** each phase is a single PR. Phases 1–3 are foundational and unblocked by anything outside ADR-022 phase 1. Phases 4–7 each consume `Finding[]` produced by the corresponding ADR-021 producer phase — see §2.4 for the cross-ADR sequencing.

## 2. Cross-phase concerns

### 2.1 ADR-021 / ADR-022 phase ordering

Each ADR-022 consumer migration depends on the corresponding ADR-021 producer migration:

| ADR-022 phase | Consumes Finding[] from | Blocked by |
|:---|:---|:---|
| Phase 4 — acceptance | acceptance-diagnose op | ADR-021 phase 8 (acceptance prompt schema) |
| Phase 5 — adversarial | adversarial-review op | ADR-021 phase 6 (adversarial migration) |
| Phase 6 — semantic | semantic-review op | ADR-021 phase 7 (semantic migration) |
| Phase 7 — autofix | lint, typecheck, plugin, tdd-verifier ops | ADR-021 phases 2–5 |

Phases 1–3 of ADR-022 only depend on ADR-021 phase 1 (already shipped on PR #868). They can land in parallel with any ADR-021 producer migration.

### 2.2 Feature flag policy

| Flag | Phase | Lifecycle |
|:---|:---|:---|
| `acceptance.fix.cycleV2` | 4 | Default off → flip default after 1 release green soak → delete in phase 8 |
| `quality.autofix.cycleV2` | 7 | Default off + shadow mode → flip default after 2 release green soak → delete in phase 8 |

Shadow mode for autofix runs **both** legacy `runAgentRectification` and new `runFixCycle` for the same input, compares routing decisions, and writes a divergence report to `.nax/cycle-shadow/<storyId>/<timestamp>.json` per ADR-022 "Audit logging" section. CI dogfood validates ≥95% routing agreement before flag flip.

### 2.3 Telemetry contract

Per ADR-022's "Telemetry" section — every cycle iteration emits:

```typescript
logger.info("findings.cycle", "iteration completed", {
  storyId,                                // first key
  packageDir,
  cycleName: "acceptance" | "autofix" | "semantic" | …,
  iterationNum,
  strategiesRan: string[],
  outcome: IterationOutcome,
  findingsBefore: number,
  findingsAfter: number,
  costUsd: number,
});
```

Bail events emit `"findings.cycle", "cycle exited"` with `reason` and (when applicable) `exhaustedStrategy` / `bailDetail`. Validator-retry events emit `"findings.cycle", "validator retry"` with the original error chained via `cause`.

This shape is **mandatory** at every cycle exit point in phases 4–7. Tests verify the log entries appear.

### 2.4 Helper imports

All phases import from the existing barrel:

```typescript
import type { Finding, FindingSeverity, FindingSource, FixTarget } from "src/findings";
import { compareSeverity, findingKey } from "src/findings";
// added in phase 1:
import type {
  Iteration, IterationOutcome, FixApplied,
  FixStrategy, FixCycleContext, FixCycleConfig, FixCycleResult, FixCycleBailReason,
} from "src/findings";
// added in phase 2:
import { runFixCycle, classifyOutcome } from "src/findings";
// added in phase 3:
import { buildPriorIterationsBlock } from "src/prompts";
```

No internal-path imports. Per [.claude/rules/project-conventions.md](../../.claude/rules/project-conventions.md).

---

## 3. Phase 1 — Cycle types

**Goal:** Add orchestration types (`Iteration`, `FixStrategy`, `FixCycleContext`, `FixCycleConfig`, `FixCycleResult`, `FixCycleBailReason`) without behaviour. Mirrors ADR-021 phase 1 in style.

### Files modified

| File | Change |
|:---|:---|
| `src/findings/cycle-types.ts` (new) | All cycle/strategy types including `FixCycle<F>` |
| `src/findings/index.ts` | Re-export new types (`Iteration`, `FixApplied`, `FixStrategy`, `FixCycle`, `FixCycleContext`, `FixCycleConfig`, `FixCycleResult`, `FixCycleBailReason`, `IterationOutcome`) |

### Type exports

```typescript
// src/findings/cycle-types.ts

import type { CallContext, Operation } from "../operations/types";
import type { Finding } from "./types";

export type IterationOutcome =
  | "resolved"
  | "partial"
  | "regressed"
  | "unchanged"
  | "regressed-different-source";

export interface FixApplied {
  strategyName: string;
  op: string;
  targetFiles: string[];
  summary: string;             // first ~500 chars of agent response or stdout
  costUsd?: number;
}

export interface Iteration<F extends Finding = Finding> {
  iterationNum: number;        // 1-indexed
  findingsBefore: F[];
  fixesApplied: FixApplied[];
  findingsAfter: F[];
  outcome: IterationOutcome;
  startedAt: string;           // ISO timestamps for forensic logs
  finishedAt: string;
}

export interface FixCycleContext {
  callCtx: CallContext;
  workdir: string;
}

export interface FixStrategy<F extends Finding = Finding, I = unknown, O = unknown, C = unknown> {
  name: string;
  appliesTo: (finding: F) => boolean;
  /** Optional fallback selector consulted only when findings.length === 0. */
  appliesToVerdict?: (verdict: string) => boolean;
  fixOp: Operation<I, O, C>;
  buildInput: (findings: F[], priorIterations: Iteration<F>[], ctx: FixCycleContext) => I;
  bailWhen?: (priorIterations: Iteration<F>[]) => string | null;
  maxAttempts: number;
  coRun?: "exclusive" | "co-run-sequential";   // default: "exclusive"
}

export interface FixCycleConfig {
  maxAttemptsTotal: number;    // default 10
  validatorRetries: number;    // default 1 — retry-once-then-terminal (ADR-022 §4)
}

export type FixCycleBailReason =
  | "no-strategy-matches"
  | "max-attempts-per-strategy"
  | "max-attempts-total"
  | "bailed-by-strategy"
  | "validator-error";

export interface FixCycleResult<F extends Finding = Finding> {
  resolved: boolean;
  reason?: FixCycleBailReason;
  bailDetail?: string;
  exhaustedStrategy?: string;
  iterations: Iteration<F>[];
  findings: F[];
}

/** Input shape for runFixCycle — callers construct this and pass it. */
export interface FixCycle<F extends Finding = Finding> {
  name: string;                                          // for telemetry: "acceptance", "autofix", …
  findings: F[];
  iterations: Iteration<F>[];
  strategies: FixStrategy<F, any, any, any>[];
  validate: (ctx: FixCycleContext) => Promise<F[]>;
  config: FixCycleConfig;
  /** Optional verdict for fast-path strategies when findings is empty. */
  verdict?: string;
}
```

### Tests

None — types only, no behaviour. Phase 2 unit tests will exercise these via the cycle implementation.

### Validation gate

- `bun run typecheck` passes
- Pre-commit hooks pass (process-cwd, adapter-wrap, dispatch-context)

### Rollback

`git revert`. New file in a new namespace; no consumers.

### PR commit message template

```
feat(findings): cycle and strategy types (ADR-022 phase 1)

Add Iteration, FixApplied, FixStrategy, FixCycleConfig, FixCycleResult,
FixCycleBailReason in src/findings/cycle-types.ts. Types only — no
behaviour, no consumers in this PR. Phase 2 brings runFixCycle and
classifyOutcome.

Refs: #867
```

---

## 4. Phase 2 — `runFixCycle` and `classifyOutcome`

**Goal:** Implement the cycle loop and outcome classifier. Pure logic; thoroughly unit-tested.

### Files modified

| File | Change |
|:---|:---|
| `src/findings/cycle.ts` (new) | `runFixCycle<F>(cycle, ctx)` — main loop |
| `src/findings/outcome.ts` (new) | `classifyOutcome(before, after)` + `classifySingleSource` helper |
| `src/findings/index.ts` | Re-export `runFixCycle`, `classifyOutcome` |
| `test/unit/findings/cycle.test.ts` (new) | All bail paths, all outcomes, co-run discipline |
| `test/unit/findings/outcome.test.ts` (new) | Per-source bucket + aggregate algorithm |

### `runFixCycle` skeleton

```typescript
// src/findings/cycle.ts
import { errorMessage } from "../utils/errors";
import { getSafeLogger } from "../logger";
import { callOp } from "../operations";
import { findingKey } from "./types";
import { classifyOutcome } from "./outcome";
// FixCycle is defined in cycle-types.ts and re-exported from the barrel — import from there, not redefined here
import type {
  FixApplied, FixCycle, FixCycleConfig, FixCycleContext, FixCycleResult, FixStrategy, Iteration,
} from "./cycle-types";
import type { Finding } from "./types";

export async function runFixCycle<F extends Finding = Finding>(
  cycle: FixCycle<F>,
  ctx: FixCycleContext,
): Promise<FixCycleResult<F>> {
  const logger = getSafeLogger();
  const storyId = ctx.callCtx.storyId ?? "unknown";

  while (true) {
    // 1. Resolved?
    if (cycle.findings.length === 0 && !cycle.verdict) {
      return { resolved: true, iterations: cycle.iterations, findings: [] };
    }

    // 2. Total budget
    if (cycle.iterations.length >= cycle.config.maxAttemptsTotal) {
      logger?.warn("findings.cycle", "cycle exited", {
        storyId, cycleName: cycle.name, reason: "max-attempts-total",
        totalIterations: cycle.iterations.length, maxAttemptsTotal: cycle.config.maxAttemptsTotal,
      });
      return { resolved: false, reason: "max-attempts-total", iterations: cycle.iterations, findings: cycle.findings };
    }

    // 3. Strategy selection
    const matching = selectStrategies(cycle);
    if (matching.length === 0) {
      logger?.warn("findings.cycle", "cycle exited", {
        storyId, cycleName: cycle.name, reason: "no-strategy-matches",
      });
      return { resolved: false, reason: "no-strategy-matches", iterations: cycle.iterations, findings: cycle.findings };
    }

    // 4. Per-strategy bail / attempt-cap checks
    for (const strategy of matching) {
      const used = cycle.iterations
        .flatMap((i) => i.fixesApplied)
        .filter((f) => f.strategyName === strategy.name).length;
      if (used >= strategy.maxAttempts) {
        return {
          resolved: false, reason: "max-attempts-per-strategy",
          exhaustedStrategy: strategy.name, iterations: cycle.iterations, findings: cycle.findings,
        };
      }
      const bail = strategy.bailWhen?.(cycle.iterations);
      if (bail) {
        return {
          resolved: false, reason: "bailed-by-strategy", bailDetail: bail,
          iterations: cycle.iterations, findings: cycle.findings,
        };
      }
    }

    // 5. Run strategies (sequential per coRun discipline)
    const startedAt = new Date().toISOString();
    const findingsBefore = cycle.findings;
    const fixesApplied: FixApplied[] = [];

    for (const strategy of matching) {
      const input = strategy.buildInput(cycle.findings, cycle.iterations, ctx);
      const output = await callOp(ctx.callCtx, strategy.fixOp, input as any);
      fixesApplied.push({
        strategyName: strategy.name,
        op: strategy.fixOp.name,
        targetFiles: extractTargetFiles(output),
        summary: extractSummary(output),
        costUsd: extractCost(output),
      });
    }

    // 6. Validate (with retry)
    const findingsAfter = await validateWithRetry(cycle.validate, ctx, cycle.config.validatorRetries, storyId, cycle.name);
    if (findingsAfter === null) {
      return { resolved: false, reason: "validator-error", iterations: cycle.iterations, findings: cycle.findings };
    }

    // 7. Classify and push iteration
    const outcome = classifyOutcome(findingsBefore, findingsAfter);
    const iteration: Iteration<F> = {
      iterationNum: cycle.iterations.length + 1,
      findingsBefore, fixesApplied, findingsAfter, outcome,
      startedAt, finishedAt: new Date().toISOString(),
    };
    cycle.iterations.push(iteration);
    cycle.findings = findingsAfter;
    cycle.verdict = undefined; // verdict is consumed once; subsequent iterations rely on findings

    logger?.info("findings.cycle", "iteration completed", {
      storyId, cycleName: cycle.name,
      iterationNum: iteration.iterationNum,
      strategiesRan: fixesApplied.map((f) => f.strategyName),
      outcome,
      findingsBefore: findingsBefore.length, findingsAfter: findingsAfter.length,
      costUsd: fixesApplied.reduce((sum, f) => sum + (f.costUsd ?? 0), 0),
    });
  }
}

function selectStrategies<F extends Finding>(cycle: FixCycle<F>): FixStrategy<F, any, any, any>[] {
  const all = cycle.strategies;
  const matchByFinding = (s: FixStrategy<F, any, any, any>) =>
    cycle.findings.some(s.appliesTo);
  const matchByVerdict = (s: FixStrategy<F, any, any, any>) =>
    cycle.verdict !== undefined && s.appliesToVerdict?.(cycle.verdict);

  const matching = cycle.findings.length === 0 && cycle.verdict
    ? all.filter(matchByVerdict)
    : all.filter(matchByFinding);

  if (matching.length === 0) return [];

  const exclusive = matching.find((s) => (s.coRun ?? "exclusive") === "exclusive");
  if (exclusive) return [exclusive];
  return matching.filter((s) => s.coRun === "co-run-sequential");
}

async function validateWithRetry<F extends Finding>(
  validate: (ctx: FixCycleContext) => Promise<F[]>,
  ctx: FixCycleContext,
  retries: number,
  storyId: string,
  cycleName: string,
): Promise<F[] | null> {
  const logger = getSafeLogger();
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await validate(ctx);
    } catch (err) {
      logger?.warn("findings.cycle", "validator retry", {
        storyId, cycleName, attempt, error: errorMessage(err), cause: err,
      });
      if (attempt === retries) return null;
    }
  }
  return null;
}

// extractTargetFiles / extractSummary / extractCost — operation-output-specific helpers;
// their shape depends on the fixOp's Output type. Implemented as duck-typing readers.
```

### `classifyOutcome` skeleton

```typescript
// src/findings/outcome.ts
import { findingKey } from "./types";
import type { Finding } from "./types";
import type { IterationOutcome } from "./cycle-types";

export function classifyOutcome(before: Finding[], after: Finding[]): IterationOutcome {
  if (after.length === 0) return "resolved";

  const sources = new Set([...before, ...after].map((f) => f.source));
  const perSource: IterationOutcome[] = [];
  for (const source of sources) {
    perSource.push(
      classifySingleSource(
        before.filter((f) => f.source === source),
        after.filter((f) => f.source === source),
      ),
    );
  }
  return aggregateOutcomes(perSource);
}

function classifySingleSource(before: Finding[], after: Finding[]): IterationOutcome {
  const beforeKeys = new Set(before.map(findingKey));
  const afterKeys = new Set(after.map(findingKey));
  if (afterKeys.size === 0) return "resolved";
  const sameSet = beforeKeys.size === afterKeys.size && [...beforeKeys].every((k) => afterKeys.has(k));
  if (sameSet) return "unchanged";
  const newOnes = [...afterKeys].some((k) => !beforeKeys.has(k));
  if (newOnes) return "regressed";
  return "partial";
}

function aggregateOutcomes(per: IterationOutcome[]): IterationOutcome {
  if (per.every((o) => o === "resolved")) return "resolved";
  if (per.some((o) => o === "regressed-different-source")) return "regressed-different-source";
  if (per.some((o) => o === "regressed")) return "regressed";
  if (per.every((o) => o === "unchanged")) return "unchanged";
  return "partial";
}
```

`regressed-different-source` is detected at the cycle level when the after-set introduces sources that weren't in before — handled in `classifyOutcome` (not shown above for brevity; tracked in phase 2 implementation).

### Tests

`test/unit/findings/cycle.test.ts`:

- Empty findings + no verdict → resolved
- Single strategy, single attempt, validator returns `[]` → resolved
- Per-strategy cap exceeded → reason `max-attempts-per-strategy`, `exhaustedStrategy` set
- Cycle-wide cap exceeded → reason `max-attempts-total`
- No strategy matches → reason `no-strategy-matches`
- `bailWhen` returns string → reason `bailed-by-strategy`, `bailDetail` set
- Validator throws once → retried; second attempt succeeds → continues
- Validator throws twice → reason `validator-error`
- Mixed-target findings → both strategies co-run; one iteration; both `FixApplied` recorded
- Empty findings + verdict → `appliesToVerdict` selects strategy
- Telemetry: log entry per iteration; bail event with reason; validator retry event

`test/unit/findings/outcome.test.ts`:

- All resolved → `resolved`
- Same set → `unchanged`
- Strict subset → `partial`
- New finding appears → `regressed`
- Cross-source regression → `regressed-different-source`
- Mixed sources, mixed outcomes → aggregated correctly

### Validation gate

- `bun run typecheck` passes
- `bun test test/unit/findings/` passes (target: 100% line coverage on cycle.ts and outcome.ts)
- `bun run lint` passes

### Risk mitigation

- All bail paths covered by tests before any consumer migrates.
- `findingKey` reused from ADR-021 phase 1 (already shipped) — no new equality logic.

### Rollback

`git revert`. Pure additions; no consumer changes yet.

---

## 5. Phase 3 — `buildPriorIterationsBlock`

**Goal:** Single shared helper that renders an `Iteration<F>[]` history as a verdict-first markdown table for prompt builders.

### Files modified

| File | Change |
|:---|:---|
| `src/prompts/builders/prior-iterations.ts` (new) | `buildPriorIterationsBlock<F>(iterations: Iteration<F>[]): string` |
| `src/prompts/index.ts` | Re-export |
| `test/unit/prompts/prior-iterations.test.ts` (new) | Snapshot tests for empty / single / multi-iteration / `unchanged` |

### Skeleton

```typescript
// src/prompts/builders/prior-iterations.ts
// Use the barrel — never internal-path imports (project-conventions.md)
import type { Finding, Iteration } from "../../findings";

const FALSIFIED_LINE =
  'When outcome is "unchanged", the prior hypothesis is FALSIFIED — the change did\n' +
  "not affect what was tested. Choose a different category before producing a new\n" +
  "verdict. Do NOT repeat fixes listed above.\n";

export function buildPriorIterationsBlock<F extends Finding = Finding>(
  iterations: Iteration<F>[],
): string {
  if (iterations.length === 0) return "";

  const rows = iterations.map((it) => {
    const strategies = it.fixesApplied.map((f) => f.strategyName).join(", ");
    const files = uniq(it.fixesApplied.flatMap((f) => f.targetFiles)).join(", ");
    const summary = summariseFindings(it.findingsBefore, it.findingsAfter);
    return `| ${it.iterationNum} | ${strategies} | ${files} | ${it.outcome} | ${summary} |`;
  });

  const hasUnchanged = iterations.some((i) => i.outcome === "unchanged");

  return [
    "## Prior Iterations — verdict required before new analysis",
    "",
    "| # | Strategies run | Files touched | Outcome | Findings before → after |",
    "|---|----------------|---------------|---------|------------------------|",
    ...rows,
    "",
    hasUnchanged ? FALSIFIED_LINE : "",
  ].filter(Boolean).join("\n");
}

function summariseFindings(before: Finding[], after: Finding[]): string {
  const fmt = (f: Finding[]) => {
    if (f.length === 0) return "0";
    const cats = uniq(f.map((x) => x.category));
    const head = cats.slice(0, 3).map((c) => `[${c}]`).join(" ");
    const more = cats.length > 3 ? ` +${cats.length - 3} more` : "";
    return `${f.length} ${head}${more}`;
  };
  return `${fmt(before)} → ${fmt(after)}`;
}

function uniq<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}
```

### Tests

- Empty iterations → `""`
- One iteration, outcome=`partial` → table with 1 row, no falsified line
- One iteration, outcome=`unchanged` → table with 1 row, falsified line present
- Three iterations → all rows in chronological order
- Multi-file `targetFiles` → comma-joined; deduped
- More than 3 categories in summary → first 3 + "+N more"

### Validation gate

- `bun run typecheck` passes
- `bun test test/unit/prompts/prior-iterations.test.ts` passes
- Snapshot stable across two runs

### Rollback

`git revert`. Helper has no consumers yet.

---

## 6. Phase 4 — Acceptance migration

**Goal:** Replace `applyFix` (acceptance) with `runFixCycle`. Ships the dogfood regression fix. Behind feature flag.

### Files modified

| File | Change |
|:---|:---|
| [src/execution/lifecycle/acceptance-fix.ts:153](../../src/execution/lifecycle/acceptance-fix.ts#L153) | `applyFix` becomes a thin adapter — constructs strategies, builds `FixCycle`, invokes `runFixCycle`. Behind `acceptance.fix.cycleV2` flag |
| [src/execution/lifecycle/acceptance-loop.ts:299](../../src/execution/lifecycle/acceptance-loop.ts#L299) | Replace `previousFailure: string` accumulator with `Iteration<Finding>[]` carry-forward |
| [src/operations/acceptance-fix.ts](../../src/operations/acceptance-fix.ts) | Fix ops gain `priorIterations: Iteration<Finding>[]` input field |
| [src/prompts/builders/acceptance-builder.ts:171-195](../../src/prompts/builders/acceptance-builder.ts#L171) | `buildDiagnosisPromptTemplate` consumes `priorIterations` via `buildPriorIterationsBlock` |
| [src/prompts/builders/acceptance-builder.ts:364-378](../../src/prompts/builders/acceptance-builder.ts#L364) | `buildTestFixPrompt` / `buildSourceFixPrompt` consume `priorIterations` |
| [src/config/schemas.ts](../../src/config/schemas.ts) | Add `acceptance.fix.cycleV2: z.boolean().default(false)` |
| [src/config/selectors.ts](../../src/config/selectors.ts) | Expose flag through `acceptanceConfigSelector` |
| `test/integration/acceptance/cycle-v2.test.ts` (new) | Flag on/off behaviour parity |

### Strategy declaration

```typescript
// inside applyFix() / runAcceptanceLoop() entry
function buildAcceptanceStrategies(
  ctx: AcceptanceLoopContext,
  failures: { failedACs: string[]; testOutput: string },
  testFileContent: string,
  acceptanceTestPath: string,
): FixStrategy<Finding, any, any, any>[] {
  return [
    {
      name: "acceptance-source-fix",
      appliesTo: (f) => f.fixTarget === "source",
      appliesToVerdict: (v) => v === "source_bug" || v === "both",
      fixOp: acceptanceFixSourceOp,
      buildInput: (findings, priorIterations, ctx) => ({
        testOutput: failures.testOutput,
        diagnosisReasoning: ctx.diagnosis?.reasoning ?? "",
        acceptanceTestPath,
        testFileContent,
        priorIterations,
      }),
      maxAttempts: 3,
      coRun: "co-run-sequential",
    },
    {
      name: "acceptance-test-fix",
      appliesTo: (f) => f.fixTarget === "test",
      appliesToVerdict: (v) => v === "test_bug" || v === "both",
      fixOp: acceptanceFixTestOp,
      buildInput: (findings, priorIterations, ctx) => ({
        testOutput: failures.testOutput,
        diagnosisReasoning: ctx.diagnosis?.reasoning ?? "",
        failedACs: failures.failedACs,
        acceptanceTestPath,
        testFileContent,
        priorIterations,
      }),
      maxAttempts: 3,
      coRun: "co-run-sequential",
    },
  ];
}
```

The strategies are constructed inline at the call site to capture closure context (`failures`, `testFileContent`, `acceptanceTestPath`) — per ADR-022 §3 "FixStrategy is a value, not a class."

### Cycle entry point

```typescript
async function applyFixV2(opts: ApplyFixOptions): Promise<ApplyFixResult> {
  const { ctx, failures, diagnosis, priorIterations } = opts;
  const findings = diagnosis.findings ?? acceptanceLegacyToFindings(diagnosis); // §6 fallback

  const strategies = buildAcceptanceStrategies(ctx, failures, testFileContent, acceptanceTestPath);
  const cycle: FixCycle<Finding> = {
    name: "acceptance",
    findings,
    iterations: priorIterations ?? [],
    strategies,
    validate: async (cycleCtx) => {
      // Re-run acceptance test stage; convert failures back to Finding[]
      const result = await acceptanceStage.execute(buildPipelineContext(ctx));
      return convertAcceptanceFailuresToFindings(result);
    },
    config: { maxAttemptsTotal: ctx.config.acceptance.maxRetries, validatorRetries: 1 },
    verdict: diagnosis.verdict,
  };

  const result = await runFixCycle(cycle, fixCallCtx(ctx));
  // Persist iterations into outer loop's priorIterations accumulator (replaces previousFailure: string)
  ctx.priorIterations = result.iterations;
  return { cost: 0 };
}
```

### Outer loop changes

[acceptance-loop.ts:299](../../src/execution/lifecycle/acceptance-loop.ts#L299) currently:

```typescript
previousFailure += `\n---\nAttempt ${acceptanceRetries}/${maxRetries}: verdict=${diagnosis.verdict}, …`;
```

Replaced with:

```typescript
// priorIterations is accumulated by applyFix's runFixCycle invocation
// and threaded to the next iteration's diagnosis call
const priorIterations = ctx.priorIterations ?? [];
```

The diagnosis prompt builder now receives `priorIterations: Iteration<Finding>[]` instead of `previousFailure: string`.

### Verdict fast-paths preserved

The fast-paths in [acceptance-fix.ts:78-116](../../src/execution/lifecycle/acceptance-fix.ts#L78) (`implement-only`, `semanticVerdicts.every(passed)`, `isTestLevelFailure`) **stay where they are** — they produce `DiagnosisResult` with `findings: []` and `verdict: "..."`. The cycle's `appliesToVerdict` selector picks up the right strategy.

### Flag interaction: `cycleV2` vs `findingsV2`

`cycleV2: true` with `findingsV2: false` is a **supported degraded mode**. When `findingsV2` is off the LLM still returns the old `testIssues/sourceIssues` schema; `applyFixV2` calls `acceptanceLegacyToFindings(diagnosis)` as fallback (since `diagnosis.findings` will be `undefined`). The cycle runs correctly on the resulting `Finding[]`. No config-schema validation is needed to enforce ordering between the two flags — the fallback path handles the gap transparently.

### Flag-gated implementation

```typescript
async function applyFix(opts: ApplyFixOptions): Promise<ApplyFixResult> {
  if (opts.ctx.config.acceptance.fix?.cycleV2 === true) {
    return applyFixV2(opts);
  }
  return applyFixLegacy(opts); // existing implementation, untouched
}
```

### Tests

`test/integration/acceptance/cycle-v2.test.ts`:

- Flag off: legacy `applyFix` runs unchanged; existing tests pass
- Flag on, verdict=source_bug + findings: source-fix strategy runs; one iteration; validator re-runs; outcome classified
- Flag on, verdict=both + mixed findings: both strategies co-run in one iteration; validator runs once at end
- Flag on, fast-path verdict (no findings): `appliesToVerdict` selects strategy
- Flag on, two iterations with identical post-fix findings: outcome=`unchanged`; falsified line in next prompt
- Diagnosis prompt contains `## Prior Iterations` table when `priorIterations.length > 0`
- Telemetry: `findings.cycle` log entry per iteration with correct fields

### Validation gate

- `bun run typecheck` passes
- All existing acceptance tests pass with flag default off
- New cycle tests pass with flag on
- Dogfood `nax-dogfood/fixtures/hello-lint`:
  - Flag off: existing failure mode reproduces (sanity check)
  - Flag on: attempt 2's diagnose prompt contains the verdict-first table from attempt 1; the LLM picks a different strategy (no longer the `2>&1` bogus fix)

### Risk mitigation

- Flag defaults off; production unaffected.
- Legacy `applyFix` stays in the codebase during phase 4; no behaviour change with flag off.
- Shadow-mode comparison: when flag is on, write `.nax/cycle-shadow/<storyId>/<timestamp>.json` showing both legacy and v2 routing decisions for offline diff.

### Rollback

Flag back to off — no code revert needed. After 1 release of green soak: change default to `true`. After 1 more release: phase 8 deletes the flag and the legacy path.

### PR commit message template

```
feat(acceptance): runFixCycle migration (ADR-022 phase 4)

Replace applyFix's hand-rolled diagnose-fix-validate flow with
runFixCycle driven by [acceptance-source-fix, acceptance-test-fix]
strategies. Ships the dogfood regression fix — verdict-first
prior-iterations table appears in the diagnose prompt when prior
attempts produced unchanged output.

Behind acceptance.fix.cycleV2 flag, default off.

Refs: #867
```

---

## 7. Phase 5 — Adversarial migration

**Goal:** Replace `AdversarialFindingsCache` carry-forward with `Iteration<Finding>[]`. `buildPriorFindingsBlock` delegates to `buildPriorIterationsBlock`.

### Files modified

| File | Change |
|:---|:---|
| [src/operations/adversarial-review.ts:28](../../src/operations/adversarial-review.ts#L28) | `priorAdversarialFindings?: AdversarialFindingsCache` → `priorIterations?: Iteration<Finding>[]` |
| [src/prompts/builders/adversarial-review-builder.ts:202-225](../../src/prompts/builders/adversarial-review-builder.ts#L202) | `buildPriorFindingsBlock(round, findings)` → `buildPriorIterationsBlock(iterations)` (one-line delegation) |
| [src/review/types.ts:171-182](../../src/review/types.ts#L171) | `AdversarialFindingsCache` deprecated; carry-forward becomes `Iteration<Finding>[]` directly |
| [src/review/runner.ts](../../src/review/runner.ts), [src/review/orchestrator.ts](../../src/review/orchestrator.ts), [src/review/adversarial.ts](../../src/review/adversarial.ts), [src/pipeline/types.ts](../../src/pipeline/types.ts) | Update references from `AdversarialFindingsCache` to `Iteration<Finding>[]` |
| `test/unit/operations/adversarial-review.test.ts` | Round-2 prompt assertion: contains prior-iterations block built from previous round |

### Migration shape

Adversarial review historically stored only the most recent round's findings. With cycles, a single review iteration is a full `Iteration<Finding>` record (findings before, fix applied, findings after, outcome). The carry-forward becomes:

```typescript
// before:
priorAdversarialFindings?: AdversarialFindingsCache;  // { round, findings[] }
// after:
priorIterations?: Iteration<Finding>[];               // full history
```

The prompt builder change is one line — `buildPriorFindingsBlock(...)` becomes `buildPriorIterationsBlock(priorIterations ?? [])`. Callers update.

### Tests

- Round 1 → no prior block in prompt
- Round 2 → prompt contains prior-iterations table from round 1
- Round 3 with outcome=`unchanged` from round 2 → falsified line present

### Validation gate

- All adversarial unit + integration tests pass
- Hand-run: trigger adversarial review on a fixture; observe round 2 prompt structure

### Risk mitigation

- No prompt schema change (the table format is the only change to prompt content; prompt instructions unaffected).
- `AdversarialFindingsCache` stays in `src/review/types.ts` as a **deprecated alias** (`type AdversarialFindingsCache = { round: number; findings: Finding[] }`) for one release before phase 8 deletes it. ADR-021 phase 9 must NOT independently delete or replace this type — phase 8 of this plan is the sole authority. Co-ordinate PRs so phase 8 lands first if both land in the same release window.

### Rollback

`git revert`. Cache lives in memory only — no persistence to migrate.

---

## 8. Phase 6 — Semantic migration

**Goal:** Replace `PriorFailure[]` with `Iteration<Finding>[]`. `buildAttemptContextBlock` delegates to `buildPriorIterationsBlock`.

### Files modified

| File | Change |
|:---|:---|
| [src/operations/semantic-review.ts](../../src/operations/semantic-review.ts) | Accept `priorIterations?: Iteration<Finding>[]` input |
| [src/prompts/builders/review-builder.ts:65-68](../../src/prompts/builders/review-builder.ts#L65) | `PriorFailure` interface deprecated; replaced by `Iteration<Finding>` |
| [src/prompts/builders/review-builder.ts:186-211](../../src/prompts/builders/review-builder.ts#L186) | `buildAttemptContextBlock` delegates to `buildPriorIterationsBlock` |
| [src/review/runner.ts](../../src/review/runner.ts) | Update semantic carry-forward path |
| `test/unit/operations/semantic-review.test.ts` | Round-2 prompt assertion |

### Migration shape

Same pattern as phase 5. `PriorFailure[]` (stage + tier only) was a thin reproduction of attempt context; `Iteration[]` is strictly richer. Migration is mechanical.

### Tests

Same as phase 5, scoped to semantic review.

### Validation gate

- All semantic unit + integration tests pass
- Round 2 prompt contains prior-iterations table

### Risk mitigation

`PriorFailure` is barely used (only carries `stage` and `modelTier`); migration loses no information.

### Rollback

`git revert`.

---

## 9. Phase 7 — Autofix migration

**Goal:** Replace `runAgentRectification`'s hand-rolled split-and-route with `runFixCycle` driving multiple strategies. Behind `quality.autofix.cycleV2` flag with shadow-mode comparison.

### Files modified

| File | Change |
|:---|:---|
| [src/pipeline/stages/autofix-agent.ts:89](../../src/pipeline/stages/autofix-agent.ts#L89) | `runAgentRectification` becomes a wrapper that constructs strategies and invokes `runFixCycle` |
| [src/pipeline/stages/autofix.ts](../../src/pipeline/stages/autofix.ts) | Same wrapper change |
| [src/pipeline/stages/autofix-scope-split.ts:158](../../src/pipeline/stages/autofix-scope-split.ts#L158) | `splitFindingsByScope` becomes purely a partition helper used by strategy `appliesTo` |
| [src/config/schemas.ts](../../src/config/schemas.ts) | Add `quality.autofix.cycleV2: z.boolean().default(false)` |
| [src/config/selectors.ts](../../src/config/selectors.ts) | Expose flag |
| `test/unit/pipeline/stages/autofix-cycle.test.ts` (new) | Cycle-driven autofix tests |
| `test/integration/autofix/cycle-shadow.test.ts` (new) | Shadow-mode divergence detection |
| [test/contract/autofix/fresh-failure-propagation.contract.test.ts](../../test/contract/autofix/fresh-failure-propagation.contract.test.ts) | **Un-skip the V2 assertion.** File added by [#808](https://github.com/nathapp-io/nax/issues/808) with the legacy assertion live and the V2 assertion `.skip`'d. Phase 7 PR enables the V2 branch — see §9.x "Strategy invariant" below. |

> **Helper carry-forward note — `hasWorkingTreeChange`:** `src/utils/git.ts` exposes `hasWorkingTreeChange(workdir, baseRef)` (added by [#808](https://github.com/nathapp-io/nax/issues/808) to fix the legacy `noOp` detection). V2 does **not** need it — `runFixCycle`'s `IterationOutcome` is derived from the validator's `Finding[]` diff, not from git state. Phase 7 author should NOT add new callers; once legacy is deleted, the helper becomes a phase 8 deletion candidate (covered in §10).

### Strategy set

ADR-022 §1b lists six logical finding sources for the autofix cycle (lint, typecheck, adversarial, plugin, test-writer, implementer). In the implementation, these map to **two strategies** — not six — because the existing `runAgentRectification` already dispatches all source-targeted findings (lint, typecheck, adversarial, plugin) to a single implementer agent, and test-targeted findings to a single test-writer agent. The discriminant is `fixTarget`, not source. Adding per-source strategies would require splitting a single agent invocation into 4+ separate ops with no benefit — the implementer already receives all source findings in one prompt.

The six-source framing in ADR-022 §1b describes logical groupings (what findings flow through the cycle), not distinct fix ops. This two-strategy set is the correct implementation.

Two strategies in the autofix cycle:

```typescript
const strategies: FixStrategy<Finding, any, any, any>[] = [
  // Source-targeted findings → implementer
  {
    name: "autofix-implementer",
    appliesTo: (f) => f.fixTarget === "source",
    fixOp: implementerRectifyOp,         // wraps existing runRetryLoop
    buildInput: (findings, prior, ctx) => ({
      findings, priorIterations: prior, /* …implementer-specific context… */
    }),
    maxAttempts: 5,
    coRun: "co-run-sequential",
  },
  // Test-targeted findings → test-writer
  {
    name: "autofix-test-writer",
    appliesTo: (f) => f.fixTarget === "test",
    fixOp: testWriterRectifyOp,          // wraps existing one-shot
    buildInput: (findings, prior, ctx) => ({
      findings, priorIterations: prior, /* … */
    }),
    maxAttempts: 1,                      // one-shot per cycle entry — natural dropout
    coRun: "co-run-sequential",
  },
];
```

The "test-writer one-shot" pattern is preserved by `maxAttempts: 1` AND selector-based dropout: once test-writer fixes test findings, the validator returns no `fixTarget === "test"` findings, so test-writer's `appliesTo` returns false in subsequent iterations. No special "runOnce" modifier needed.

### Strategy invariant — fresh validator output is the only truth

V2 must preserve the invariant established by [#808](https://github.com/nathapp-io/nax/issues/808):

> **Strategies' `appliesTo` and `buildInput` consume the latest `validate()` output, never a cycle-start snapshot. There is no fallback to `cycle.findings` once iterations have begun.**

Legacy `runAgentRectification` originally violated this by re-emitting `initialFailure` from its no-op return sites — the prompt would re-ask the implementer to fix already-fixed problems while ignoring the genuinely-failing finding set just produced by `recheckReview`. #808 corrected legacy by threading `collectFreshFailure()` through both no-op branches.

V2's `runFixCycle` is structurally aligned with this invariant — `validate()` returns `Finding[]` directly each iteration, `classifyOutcome` derives `IterationOutcome` from the pre/post diff, and `buildInput(findings, prior, ctx)` consumes the validator's latest output. Phase 7 author **must not** introduce a code path that falls back to `cycle.findings` (the cycle-start snapshot) for any iteration `n > 1`.

The contract test `test/contract/autofix/fresh-failure-propagation.contract.test.ts` enforces this for both legacy (live, post-#808) and V2 (un-skipped in this phase). Both branches assert: when validator output flips between iterations (e.g. `build:fail → adversarial:fail`), the next strategy invocation receives the post-validator findings.

### Cycle entry

```typescript
async function runAgentRectificationV2(ctx: PipelineContext, ...): Promise<...> {
  const failedChecks = collectFailedChecks(ctx);
  const findings = failedChecks.flatMap((c) => c.findings ?? []);  // already Finding[] post-ADR-021

  const strategies = buildAutofixStrategies(ctx, ...);
  const cycle: FixCycle<Finding> = {
    name: "autofix",
    findings,
    iterations: ctx.autofixPriorIterations ?? [],
    strategies,
    validate: async (cycleCtx) => {
      const review = await _autofixDeps.recheckReview(ctx);
      return review.findings ?? [];
    },
    config: {
      maxAttemptsTotal: ctx.config.quality.autofix?.maxTotalAttempts ?? 10,
      validatorRetries: 1,
    },
  };

  const result = await runFixCycle(cycle, fixCallCtx(ctx));
  ctx.autofixPriorIterations = result.iterations;
  return { succeeded: result.resolved, cost: aggregateCost(result.iterations) };
}
```

### Shadow-mode comparison

When flag is on:

1. Run `runAgentRectificationV2` (new cycle path).
2. **Also** run `runAgentRectificationLegacy` against the same input (read-only — no actual fixes; just record what strategies would have been chosen).
3. Write `.nax/cycle-shadow/<storyId>/<timestamp>.json`:

```json
{
  "phase": "quality.autofix.cycleV2",
  "input": { "findings": [...], "failedChecks": [...] },
  "legacyRouting": {
    "testWriterChecks": ["adversarial"],
    "implementerChecks": ["lint", "typecheck"]
  },
  "v2Routing": {
    "iteration1": { "strategiesRan": ["autofix-test-writer"], "outcome": "partial" },
    "iteration2": { "strategiesRan": ["autofix-implementer"], "outcome": "resolved" }
  },
  "agreement": "true | false",
  "divergenceDetail": "..."
}
```

CI dogfood validates ≥95% routing agreement before flag flip. Two release cycles of soak.

> **Gitignore:** `.nax/cycle-shadow/` must be covered by the `.nax/` gitignore pattern (same as `.nax/findings-shadow/` from ADR-021 phase 8). Verify the project `.gitignore` covers both before the phase 7 PR lands.

### Tests

- Flag off: legacy path runs; existing autofix tests pass.
- Flag on, single test-writer run: cycle exits after 1 iteration with outcome=`resolved` (or `partial`).
- Flag on, mixed findings: both strategies co-run in iteration 1; implementer iterates further if validator still returns findings.
- Cross-source drift: lint fix introduces typecheck error → next iteration's `Finding[]` contains typecheck finding → implementer strategy applies again with the new finding.
- Shadow comparison: divergence report written when v2 routing differs from legacy.

### Validation gate

- `bun run typecheck` passes
- All autofix unit + integration tests pass with flag off
- Cycle tests pass with flag on
- Shadow-mode integration test produces valid divergence reports for fixtures
- Two release cycles of dogfood ≥95% routing agreement before flag flip

### Risk mitigation

- Flag default off; production unaffected.
- Shadow mode catches divergence in CI before users see it.
- Two release soak (longer than acceptance phase 4) because autofix is on the hot path for every story.

### Rollback

Flag back to off. After 2 releases green: change default to `true`. After 1 more: phase 8 deletes flag and legacy path.

### PR commit message template

```
feat(autofix): runFixCycle migration (ADR-022 phase 7)

Replace runAgentRectification's hand-rolled split-and-route with
runFixCycle driven by [autofix-implementer, autofix-test-writer]
strategies (and any other source strategies that flow through the
same review-check validator).

Behind quality.autofix.cycleV2 flag, default off.
Shadow-mode comparison writes divergence reports to
.nax/cycle-shadow/ for two-release soak before flag flip.

Refs: #867
```

---

## 10. Phase 8 — Cleanup

**Goal:** Delete legacy carry-forward types and feature flags. All consumers now on the cycle.

### Prerequisites

- All ADR-022 phases 1–7 merged
- All ADR-021 producer migrations merged
- `acceptance.fix.cycleV2` flipped to default `true` and stable for 1 release
- `quality.autofix.cycleV2` flipped to default `true` and stable for 2 releases

### Files modified

| File | Change |
|:---|:---|
| [src/execution/lifecycle/acceptance-loop.ts](../../src/execution/lifecycle/acceptance-loop.ts) | Delete `previousFailure: string` accumulator and all writes |
| [src/execution/lifecycle/acceptance-fix.ts](../../src/execution/lifecycle/acceptance-fix.ts) | Delete `applyFixLegacy`; rename `applyFixV2` → `applyFix` |
| [src/operations/acceptance-diagnose.ts](../../src/operations/acceptance-diagnose.ts) | Remove `previousFailure?: string` from `AcceptanceDiagnoseInput` — the field becomes dead once `acceptance-loop.ts` stops passing it |
| [src/review/types.ts:171-182](../../src/review/types.ts#L171) | Delete `AdversarialFindingsCache` (already migrated to `Iteration<Finding>[]`) |
| [src/prompts/builders/adversarial-review-builder.ts:202-225](../../src/prompts/builders/adversarial-review-builder.ts#L202) | Delete `buildPriorFindingsBlock` — already replaced by one-line delegation in phase 5; now fully unused. Also remove the delegation shim added in phase 5. |
| [src/prompts/builders/review-builder.ts:65-68,186-211](../../src/prompts/builders/review-builder.ts#L65) | Delete `PriorFailure` and `buildAttemptContextBlock` |
| [src/pipeline/stages/autofix-agent.ts](../../src/pipeline/stages/autofix-agent.ts), [autofix.ts](../../src/pipeline/stages/autofix.ts) | Delete legacy `runAgentRectification`; rename V2 to canonical |
| [src/config/schemas.ts](../../src/config/schemas.ts) | Delete `acceptance.fix.cycleV2` and `quality.autofix.cycleV2` fields. **This is the sole authority for these deletions** — ADR-021 phase 9 must not delete them. |
| [src/utils/git.ts](../../src/utils/git.ts) | Delete `hasWorkingTreeChange` (added by [#808](https://github.com/nathapp-io/nax/issues/808) for legacy `noOp` detection) **if** `git grep "hasWorkingTreeChange" -- 'src/'` shows no remaining callers. V2 does not need it — `IterationOutcome` is derived from validator findings, not git state. |
| [test/contract/autofix/fresh-failure-propagation.contract.test.ts](../../test/contract/autofix/fresh-failure-propagation.contract.test.ts) | Drop the legacy assertion (the legacy code path is gone); keep the V2 assertion as the durable invariant guard. |
| Various tests | Delete tests asserting on legacy field shapes / flag-off behaviour |

### Validation gate

- `bun run typecheck` passes
- Full test suite passes
- `git grep "previousFailure\|AdversarialFindingsCache\|PriorFailure\|buildPriorFindingsBlock\|buildAttemptContextBlock\|cycleV2\|AcceptanceDiagnoseInput\|hasWorkingTreeChange" -- 'src/'` returns nothing (or only valid non-deprecated usages of `AcceptanceDiagnoseInput`)
- Feature flag config schema no longer mentions `cycleV2` fields
- For full end-to-end coverage, also run the ADR-021 phase 9 gate: `git grep "LlmReviewFinding\|testIssues\|sourceIssues\|parseLlmReviewShape\|acceptanceLegacyToFindings\|findingsV2" -- 'src/'` returns nothing

### Rollback

`git revert`. Cleanup is purely deletion + import cleanup — no semantic change.

---

## 11. Cross-cutting checklist

Before merging each PR:

- [ ] `bun run typecheck` passes
- [ ] `bun run lint` (Biome) passes
- [ ] Pre-commit hooks pass (process-cwd, adapter-wrap, dispatch-context)
- [ ] All new logger calls have `storyId` as first key in data object
- [ ] No `process.cwd()` outside CLI entry points
- [ ] No internal-path imports — barrel only
- [ ] `findingKey` (from ADR-021 phase 1) is the only finding-equality function used
- [ ] PR refs `#867`
- [ ] Telemetry contract (§2.3) emitted at every iteration completion + bail event
- [ ] Phase 4 / Phase 7: feature flag works in both states; legacy path unchanged when flag off

## 12. Tracking

| Phase | PR | Status | Notes |
|:---|:---|:---|:---|
| 1 — Cycle types | tbd | not started | ~120 line addition |
| 2 — `runFixCycle` + `classifyOutcome` | tbd | not started | ~250 lines + tests |
| 3 — `buildPriorIterationsBlock` | tbd | not started | ~50 lines + tests |
| 4 — Acceptance migration (flagged) | tbd | not started | ships dogfood regression fix |
| 5 — Adversarial migration | tbd | not started | mostly mechanical |
| 6 — Semantic migration | tbd | not started | mostly mechanical |
| 7 — Autofix migration (flagged + shadow) | tbd | not started | hot path; longest soak |
| 8 — Cleanup | tbd | not started | gated on all flags flipped |

## 13. References

- [ADR-021](../adr/ADR-021-findings-and-fix-strategy-ssot.md) — Finding type SSOT (companion ADR)
- [ADR-022](../adr/ADR-022-fix-strategy-and-cycle.md) — this plan's source ADR
- [ADR-021 implementation plan](./2026-05-02-adr-021-implementation-plan.md) — companion plan
- [Issue #867](https://github.com/nathapp-io/nax/issues/867) — umbrella tracker
- ADR-021 phase-1 PR [#868](https://github.com/nathapp-io/nax/pull/868) — wire-format types
- [src/findings/](../../src/findings/) — types module (extends with cycle-types in phase 1)
- [src/verification/shared-rectification-loop.ts](../../src/verification/shared-rectification-loop.ts) — `runRetryLoop` (preserved as inner primitive)
- [docs/findings/2026-04-30-context-curator-design.md](../findings/2026-04-30-context-curator-design.md) — referenced for cycle-history audit (deferred)
- [.claude/rules/project-conventions.md](../../.claude/rules/project-conventions.md) — logger/storyId, barrel imports
