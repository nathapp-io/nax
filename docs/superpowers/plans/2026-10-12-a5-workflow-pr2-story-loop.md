# A5 Workflow Mode — PR2 Story Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In `execution.mode: "workflow"`, run each story through one implementer, deterministic gates, a story review, and a capped fix loop with scoped re-reviews. Write a ledger and `result.json` for the run. Advisor calls are stubbed to their deterministic defaults.

**Architecture:**
- A lazy `getWorkflowPipeline()` swaps the prompt, optimizer and execution stages for one `workflowStage`. `iteration-runner.ts` picks it when `isWorkflowMode(config)`.
- `workflowStage` builds a `StepContext`, wires real step functions into a pure state machine (`runStoryLoop`), sets `ctx.agentResult`, and always returns `continue`. `completionStage` still marks the story passed.
- Three new `RunOperation`s (`workflowImplementOp`, `workflowStoryReviewOp`, `workflowReReviewOp`). Their prompt text lives in `prompts/builders/workflow-*-builder.ts`. Gates reuse `lintCheckOp`, `typecheckCheckOp`, `verifyScopedOp` and `fullSuiteGateOp`.
- Every step function calls `callOp` through one seam (`_workflowDeps.callOp`), so the integration test fakes the agent in one place.

**Tech Stack:** TypeScript, Bun 1.4, bun:test.

**Spec:** `docs/superpowers/specs/2026-10-12-a5-workflow-mode-design.md` (rev 2). This plan covers §5.1, §5.2, §5.4 (story half), §5.5, §6, §9 (ledger, result, story artifacts), §10 (story resume, time limits, cost limit) and §12 PR2.

**Plan series:** PR1 foundations (merged, nax#2475) → **PR2 story loop (this plan)** → PR3 advisor kinds → PR4 feature workflow.

## Rulings on the spec (made while planning, against the merged code)

| # | Ruling | Why |
|---|---|---|
| P2-R1 | `workflowStage` sets **only** `ctx.agentResult`. It does not set `storyGitRef`, `storyStartTime` or `storyMetrics` | `iteration-runner.ts:114-120,198-199` already sets `storyStartTime` and `storyGitRef`. `storyGitRef` is the story's **start** ref, persisted in prd.json (BUG-114), and `completionStage` diffs from it. Spec §5.2 said "final HEAD", which would break that diff. `completionStage:80-86` computes `storyMetrics` itself. The stage reads `ctx.storyGitRef` as `BASE`, which also makes BASE survive a crash |
| P2-R2 | PR2 registers three roles: `wf-implementer`, `wf-story-review`, `wf-rereview`. PR4 registers `wf-branch-review` and `wf-branch-fix` | YAGNI: nothing in PR2 opens a branch session |
| P2-R3 | The `status.json` `workflow` block and per-role token totals in `result.json` move to PR4 | Both feed the feature report. PR2's `result.json` carries per-story state, rounds, gates and step timings |
| P2-R4 | Step time limits reuse finish's mechanism: implement/fix turns get a **soft interrupt** (`send(prompt, { interrupt })`, as `finish-fix.ts` does) and no handoff turn. Reviews get a step `signal`. `src/finish/step-signal.ts` moves to `src/utils/step-signal.ts` so both can import it | Finish already proved this: the agent's own timeout trails the step limit by `STEP_TIMEOUT_MARGIN_MS`, so a stale-retry never re-runs a stopped turn |
| P2-R5 | A fresh fix round **always** closes the live `wf-implementer` session first, whatever the model | One rule covers both spec cases: a stepped-up model, and the last rung or a pinned story, where the endpoint is the same |
| P2-R6 | The brief takes `rulings` and `redBaseDependencies` inputs. PR2 passes no rulings (pre-flight and carry are PR3/PR4). It computes red-base warnings from this run's `result.json` | The seam exists now, so PR3 only fills it |
| P2-R7 | Spec excerpts in the brief match sections that mention the **story id**. Bare `AC-n` ids are not matched | Every story has an `AC-1`, so matching bare ids would paste most of the spec. The brief always gives the spec path |
| P2-R9 | A prior record whose phase is still `implement` (a crash during the first turn) is **not** resumed: the story starts over, and the new session sees the uncommitted edits in the tree. Records past the first turn resume at the next round | §10 resumes "a story stopped mid-loop". Before the first turn ends there is no review state or finding list to resume into |
| P2-R8 | `parseImplementerReply`, `parseStoryReviewReply` and `parseReReviewReply` and the finding/reply types live in `src/operations/` | `src/workflow` imports `src/operations`. The ops can't import `src/workflow` back without a cycle |

## Global Constraints

- Work in `packages/nax`; run commands from there. Never run bare `bun test` with no path, and never `bun run nax`.
- Single test file: `bun test <path> --timeout=60000`. Gate before push: `bun run check:all` (package) **and** repo-root `bun run check:all`, plus `bun run typecheck` and `bun run test:coverage`.
- Source files ≤ 600 lines, test files ≤ 800 lines. `agents/manager.ts` and `session/manager.ts` must **not grow**.
- `execution.mode: "pipeline"` (the default) must behave byte-for-byte as before: `iteration-runner` still runs `defaultPipeline`.
- `workflowStage` always returns `{ action: "continue" }`. The only exception is abort: when the run signal is aborted, the error propagates.
- `workflow.maxFixRounds` default 5. Warm rounds = `min(3, maxFixRounds)`. Later rounds are fresh, one tier up per round past the warm cap (`escalateTier`). They stay on the same model at the last rung or with a profile pin.
- Timeouts come from `resolveWorkflowConfig(config).timeouts`: `implementMs` (first turn), `fixMs` (fix and answer turns), `reviewMs` (story review, re-review).
- Artifacts live under `join(runtime.outputDir, "workflow", feature, runtime.runId)`. Per story: `<storyId>/brief.md`, `report.md`, `review.json`, `rereview-<R>.json`, `package-<R>.diff`. Per run: `ledger.md`, `result.json`.
- Ledger line format: `<storyId>: <text>`. The first line is `# Workflow ledger — run: <runId> — feature: <feature>`.
- Prompt text only in `src/prompts/builders/`, exported from `src/prompts/index.ts`. Every log call in `src/workflow/` carries `storyId` as the **first** data key.
- `_deps` injection for every external call. No `mock.module()`. Bun-native file APIs (`Bun.file`, `Bun.write`), `node:fs/promises` only for `mkdir`, `appendFile`, `rename`, `readdir`, `stat`.
- `NaxError` for thrown errors. `errorMessage()` from `@nathapp/nax-agent/internal`.
- Immutability: never mutate a record, finding or config. Build new objects.
- Conventional commits (`feat:`, `test:`, `docs:`, `refactor:`). No emojis.

## Review Focus

1. **A story review that returns `"spec": "fail"` with no blocking spec finding.** It must still start a fix round: the parser appends a synthetic important spec finding. Pinned in Task 3.
2. **A gate command that errors with no parsed findings** (`execution-failed`, a thrown spawn error, lint `success: false` with an empty findings list). It must become a red gate finding, never a silent green. Pinned in Task 7.
3. **A re-review that leaves out the verdict for an open finding.** That finding stays open (`NOT_ADDRESSED`, note "(no verdict returned)"). Pinned in Task 3.
4. **`maxFixRounds: 1`.** One warm round, no fresh round, then residual. Pinned in Task 10, next to the 3 and 5 cases.
5. **A crash mid-loop, then a restart.** The prior run's story record has no end state. The new run must skip the first implement, resume at the next round in a fresh session on the **same** tier, and keep finding ids unique. Pinned in Task 2 (`loadPriorStoryRecord`) and Task 10 (resume).

---

### Task 1: Session roles, workflow config selector, shared step-signal and interrupt helpers

**Files:**
- Modify: `src/runtime/session-role.ts` (union + `KNOWN_SESSION_ROLES`)
- Modify: repo-root `.nax/rules/adapter-wiring.md` **and** repo-root `.claude/rules/adapter-wiring.md`: the Rule 2 role table, identically
- Modify: `src/config/selectors.ts` (new selector + slice type), `src/config/index.ts` (export)
- Move: `src/finish/step-signal.ts` → `src/utils/step-signal.ts`; `test/unit/finish/step-signal.test.ts` → `test/unit/utils/step-signal.test.ts`
- Modify: `src/finish/fix-step.ts`, `src/finish/ops-impl.ts`, `test/unit/finish/ops-impl.test.ts` (import path only)
- Create: `src/operations/_interrupt.ts`; Modify: `src/operations/finish-fix.ts` (import it, delete the local copy)
- Test: `test/unit/runtime/workflow-session-roles.test.ts`, `test/unit/config/workflow-selector.test.ts`, `test/unit/operations/interrupt.test.ts`

**Interfaces:**
- Produces:
  - `SessionRole` gains `"wf-implementer" | "wf-story-review" | "wf-rereview"`
  - `workflowConfigSelector` (value, from `@/config`); `WorkflowOpConfig` (type, from `@/config/selectors`), with keys `workflow`, `review`, `execution`, `autoMode`, `quality`, `agent`, `models`
  - `stepSignal(base, ms)` and `STEP_TIMEOUT_MARGIN_MS` from `@/utils/step-signal` (unchanged behaviour)
  - `isInterruptedStale(err: unknown): boolean` from `src/operations/_interrupt.ts`

- [ ] **Step 1: Write the failing tests**

`test/unit/runtime/workflow-session-roles.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { isSessionRole, KNOWN_SESSION_ROLES } from "@/runtime/session-role";

describe("workflow session roles", () => {
  test.each(["wf-implementer", "wf-story-review", "wf-rereview"])("%s is a known role", (role) => {
    expect(KNOWN_SESSION_ROLES).toContain(role as (typeof KNOWN_SESSION_ROLES)[number]);
    expect(isSessionRole(role)).toBe(true);
  });

  test("branch roles are not registered yet (PR4)", () => {
    expect(isSessionRole("wf-branch-review")).toBe(false);
  });
});
```

`test/unit/config/workflow-selector.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { makeNaxConfig } from "@test/helpers";
import { workflowConfigSelector } from "@/config";

describe("workflowConfigSelector", () => {
  test("slices the keys workflow ops read", () => {
    const slice = workflowConfigSelector.select(makeNaxConfig({}));
    expect(Object.keys(slice).sort()).toEqual(
      ["agent", "autoMode", "execution", "models", "quality", "review", "workflow"].sort(),
    );
    expect(slice.workflow.maxFixRounds).toBe(5);
  });
});
```

`test/unit/operations/interrupt.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { SessionFailureError } from "@/agents";
import { isInterruptedStale } from "@/operations/_interrupt";

describe("isInterruptedStale", () => {
  test("true only for fail-stale with reason interrupted", () => {
    const interrupted = new SessionFailureError({ outcome: "fail-stale", reason: "interrupted" } as never);
    const stalled = new SessionFailureError({ outcome: "fail-stale", reason: "idle" } as never);
    expect(isInterruptedStale(interrupted)).toBe(true);
    expect(isInterruptedStale(stalled)).toBe(false);
    expect(isInterruptedStale(new Error("x"))).toBe(false);
  });
});
```
Read `SessionFailureError`'s constructor in `src/agents` before running. If it takes more than the adapter failure, build the instance the way `test/unit/operations/finish-fix*.test.ts` does, and keep the assertions.

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test test/unit/runtime/workflow-session-roles.test.ts test/unit/config/workflow-selector.test.ts test/unit/operations/interrupt.test.ts --timeout=60000`
Expected: FAIL. The roles are unknown, `workflowConfigSelector` is undefined, and `@/operations/_interrupt` can't be resolved.

- [ ] **Step 3: Implement**

`src/runtime/session-role.ts`: add to the union after `"nbf-worth-check"`:
```ts
  /** A5 workflow mode — the story's one implementer (warm across fix rounds 1..min(3, max)). */
  | "wf-implementer"
  /** A5 — fresh, read-only story review. */
  | "wf-story-review"
  /** A5 — fresh, read-only re-review scoped to one fix diff. */
  | "wf-rereview";
```
Then append `"wf-implementer", "wf-story-review", "wf-rereview",` to `KNOWN_SESSION_ROLES` after `"nbf-worth-check",`.

`.nax/rules/adapter-wiring.md` and `.claude/rules/adapter-wiring.md` (repo root): in the Rule 2 table, the `callOp` run-kind row becomes:
```
| `main` *(default)*, `test-writer`, `verifier`, `implementer`, `diagnose`, `source-fix`, `test-fix`, `repo-scoped-test-fix`, `reviewer-semantic`, `reviewer-adversarial`, `acceptance-gen`, `plan`, `plan-refine`, `setup`, `finish-review-spec`, `finish-review-quality`, `finish-fix`, `finish-narrative`, `advisor`, `wf-implementer`, `wf-story-review`, `wf-rereview` | `callOp` run-kind |
```
Then run `bun run check:rules-drift` from the repo root. It must pass.

`src/config/selectors.ts`: after `finishConfigSelector`:
```ts
export const workflowConfigSelector = pickSelector(
  "workflow",
  "workflow",
  "review",
  "execution",
  "autoMode",
  "quality",
  "agent",
  "models",
);
```
and, next to `FinishConfig`:
```ts
export type WorkflowOpConfig = ReturnType<typeof workflowConfigSelector.select>;
```
`src/config/index.ts`: add `workflowConfigSelector,` to the selector export list (alphabetical, after `verifyConfigSelector`).

Run `git mv src/finish/step-signal.ts src/utils/step-signal.ts` and `git mv test/unit/finish/step-signal.test.ts test/unit/utils/step-signal.test.ts`. In `src/finish/fix-step.ts` and `src/finish/ops-impl.ts`, change `from "./step-signal"` to `from "@/utils/step-signal"`. Fix the import in the moved test and in `test/unit/finish/ops-impl.test.ts` if it imports the file. Keep the file's doc comment, but change its first word "Finish A:" to "Finish A / A5 workflow:".

`src/operations/_interrupt.ts`:
```ts
/** A turn ended by a soft interrupt (finish A, A5 step limits): the session is still warm. */
import { SessionFailureError } from "@/agents";

export function isInterruptedStale(err: unknown): boolean {
  return (
    err instanceof SessionFailureError &&
    err.adapterFailure.outcome === "fail-stale" &&
    err.adapterFailure.reason === "interrupted"
  );
}
```
In `src/operations/finish-fix.ts`, delete the local `isInterruptedStale` and add `import { isInterruptedStale } from "./_interrupt";`. Drop the `SessionFailureError` import if nothing else uses it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/unit/runtime/workflow-session-roles.test.ts test/unit/config/workflow-selector.test.ts test/unit/operations/interrupt.test.ts test/unit/utils/step-signal.test.ts test/unit/finish/ops-impl.test.ts test/unit/config/selectors.test.ts --timeout=60000`
Expected: PASS. If `selectors.test.ts` keeps a registry list, add `workflowConfigSelector` to it.

- [ ] **Step 5: Commit**

```bash
git add -A src/runtime/session-role.ts src/config/selectors.ts src/config/index.ts src/utils/step-signal.ts src/finish src/operations/_interrupt.ts src/operations/finish-fix.ts test/unit ../../.nax/rules/adapter-wiring.md ../../.claude/rules/adapter-wiring.md
git commit -m "feat(workflow): session roles, config selector, shared step-signal and interrupt helpers"
```

---

### Task 2: Workflow types, paths, ledger and `result.json`

**Files:**
- Create: `src/operations/workflow-types.ts` (finding and reply types, used by ops and workflow)
- Create: `src/workflow/types.ts`, `src/workflow/paths.ts`, `src/workflow/ledger.ts`, `src/workflow/result.ts`
- Test: `test/unit/workflow/ledger.test.ts`, `test/unit/workflow/result.test.ts`

**Interfaces:**
- Produces (`src/operations/workflow-types.ts`):
  ```ts
  export type WorkflowSeverity = "critical" | "important" | "minor";
  export type WorkflowFindingKind = "spec" | "quality" | "gate" | "session";
  export type GateName = "lint" | "typecheck" | "scoped" | "full-suite";
  export interface WorkflowFindingDraft {
    readonly kind: WorkflowFindingKind;
    readonly severity: WorkflowSeverity;
    readonly issue: string;
    readonly file?: string;
    readonly line?: number;
    readonly acId?: string;
    readonly suggestion?: string;
    readonly gate?: GateName;
  }
  export interface WorkflowFinding extends WorkflowFindingDraft { readonly id: string }
  export type ImplementerStatus = "DONE" | "DONE_WITH_CONCERNS" | "NEEDS_CONTEXT" | "BLOCKED";
  export interface ImplementerReply {
    readonly status: ImplementerStatus;
    readonly commits: readonly string[];
    readonly testSummary: string;
    readonly concerns?: string;
    readonly interrupted: boolean;
    /** Set when every agent hop failed ('Agent "x" failed: …'). */
    readonly failure?: string;
  }
  export interface StoryReviewVerdict {
    readonly spec: "pass" | "fail";
    readonly quality: "approved" | "changes";
    readonly findings: readonly WorkflowFindingDraft[];
    readonly cannotVerify: readonly string[];
  }
  export interface ReReviewVerdict {
    readonly verdicts: readonly { readonly id: string; readonly addressed: boolean; readonly note: string }[];
    readonly newFindings: readonly WorkflowFindingDraft[];
  }
  ```
- Produces (`src/workflow/types.ts`): re-exports all of the above, plus
  ```ts
  export type GateState = "green" | "red" | "skipped";
  export interface GateRunResult {
    readonly red: boolean;
    readonly states: Readonly<Partial<Record<GateName, GateState>>>;
    readonly findings: readonly WorkflowFindingDraft[];
  }
  export type WorkflowEndState = "complete" | "complete-with-rulings" | "complete-gate-open";
  export type WorkflowPhase = "implement" | "gates" | "review" | "fix" | "rereview" | "suite" | "residual" | "closed";
  export interface WorkflowRuling {
    readonly findingId?: string;
    readonly action: "hold" | "waive" | "defer" | "carry";
    readonly text: string;
    readonly why: string;
    readonly costIfWrong: string;
    readonly source: "advisor" | "default";
  }
  export interface WorkflowStoryRecord {
    readonly storyId: string;
    readonly state?: WorkflowEndState;
    readonly reason?: string;
    readonly round: number;
    readonly maxRounds: number;
    readonly phase: WorkflowPhase;
    readonly reviewed: boolean;
    readonly unreviewed: boolean;
    readonly openFindings: readonly WorkflowFinding[];
    readonly nextFindingId: number;
    readonly deferredMinors: number;
    readonly rulings: number;
    readonly gates: Readonly<Partial<Record<GateName, GateState>>>;
    readonly timings: Readonly<Record<string, number>>;
    readonly startedAt: string;
    readonly endedAt?: string;
  }
  export interface WorkflowResultFile {
    readonly schemaVersion: 1;
    readonly runId: string;
    readonly feature: string;
    readonly stories: Readonly<Record<string, WorkflowStoryRecord>>;
  }
  ```
- Produces (`paths.ts`): `workflowFeatureDir(outputDir, feature)`, `workflowRunDir(outputDir, feature, runId)`, `workflowStoryDir(runDir, storyId)`
- Produces (`ledger.ts`): `ensureLedger(runDir, runId, feature): Promise<void>`, `appendLedger(runDir, storyId, text): Promise<void>`, `ledgerFilePath(runDir): string`, and `ledgerText` with `fixRound`, `deferredMinor`, `ruling`, `end`, `reviewSkipped`
- Produces (`result.ts`): `newStoryRecord(storyId, maxRounds, now: string)`, `readResult(runDir)`, `upsertStoryRecord(runDir, header: { runId; feature }, record)`, `loadPriorStoryRecord(featureDir, currentRunId, storyId)`, `_resultDeps`

- [ ] **Step 1: Write the failing tests**

`test/unit/workflow/ledger.test.ts`:
```ts
import { afterEach, describe, expect, test } from "bun:test";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { appendLedger, ensureLedger, ledgerFilePath, ledgerText } from "@/workflow/ledger";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.map(cleanupTempDir));
  dirs.length = 0;
});

describe("workflow ledger", () => {
  test("header once, then storyId-prefixed lines", async () => {
    const dir = await makeTempDir("wf-ledger-");
    dirs.push(dir);
    await ensureLedger(dir, "run-1", "feat-a");
    await ensureLedger(dir, "run-1", "feat-a");
    await appendLedger(dir, "US-001", ledgerText.fixRound(2, 5, "2 open: F1, F2"));
    await appendLedger(dir, "US-001", ledgerText.end("complete", "1 round"));
    const text = await Bun.file(ledgerFilePath(dir)).text();
    expect(text).toBe(
      "# Workflow ledger — run: run-1 — feature: feat-a\n" +
        "US-001: fix round 2/5 (2 open: F1, F2)\n" +
        "US-001: complete (1 round)\n",
    );
  });

  test("ruling line uses the skill's three-part shape", () => {
    expect(
      ledgerText.ruling({ action: "hold", text: "hold F3", why: "no advisor", costIfWrong: "stays open", source: "default" }),
    ).toBe("Ruling: hold F3 — no advisor — stays open");
  });

  test("multi-line text is folded onto one line", () => {
    expect(ledgerText.deferredMinor("a\nb")).toBe("deferred-minor: a b");
  });
});
```

`test/unit/workflow/result.test.ts`:
```ts
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, utimes } from "node:fs/promises";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { loadPriorStoryRecord, newStoryRecord, readResult, upsertStoryRecord } from "@/workflow/result";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.map(cleanupTempDir));
  dirs.length = 0;
});
const header = (runId: string) => ({ runId, feature: "feat-a" });

describe("workflow result.json", () => {
  test("upsert creates, then replaces one story without touching others", async () => {
    const run = await makeTempDir("wf-result-");
    dirs.push(run);
    const a = newStoryRecord("US-001", 5, "2026-10-12T00:00:00.000Z");
    const b = newStoryRecord("US-002", 5, "2026-10-12T00:00:00.000Z");
    await upsertStoryRecord(run, header("run-1"), a);
    await upsertStoryRecord(run, header("run-1"), b);
    await upsertStoryRecord(run, header("run-1"), { ...a, round: 2, phase: "fix" });
    const file = await readResult(run);
    expect(file?.schemaVersion).toBe(1);
    expect(file?.stories["US-001"]?.round).toBe(2);
    expect(file?.stories["US-002"]?.phase).toBe("implement");
  });

  test("readResult returns null for a missing or corrupt file", async () => {
    const run = await makeTempDir("wf-result-");
    dirs.push(run);
    expect(await readResult(run)).toBeNull();
    await Bun.write(join(run, "result.json"), "{not json");
    expect(await readResult(run)).toBeNull();
  });

  test("loadPriorStoryRecord: newest other run, unfinished records only", async () => {
    const feature = await makeTempDir("wf-feature-");
    dirs.push(feature);
    const older = join(feature, "run-old");
    const newer = join(feature, "run-new");
    const current = join(feature, "run-now");
    await Promise.all([older, newer, current].map((d) => mkdir(d, { recursive: true })));
    const base = newStoryRecord("US-003", 5, "2026-10-12T00:00:00.000Z");
    await upsertStoryRecord(older, header("run-old"), { ...base, round: 1, phase: "fix" });
    await upsertStoryRecord(newer, header("run-new"), { ...base, round: 3, phase: "rereview" });
    await upsertStoryRecord(current, header("run-now"), base);
    await utimes(join(older, "result.json"), new Date(1000), new Date(1000));
    await utimes(join(newer, "result.json"), new Date(2000), new Date(2000));

    expect((await loadPriorStoryRecord(feature, "run-now", "US-003"))?.round).toBe(3);

    await upsertStoryRecord(newer, header("run-new"), { ...base, round: 3, state: "complete", phase: "closed" });
    // The newest prior run finished the story: nothing to resume, even though an older run did not.
    expect(await loadPriorStoryRecord(feature, "run-now", "US-003")).toBeNull();
    expect(await loadPriorStoryRecord(feature, "run-now", "US-999")).toBeNull();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test test/unit/workflow/ledger.test.ts test/unit/workflow/result.test.ts --timeout=60000`
Expected: FAIL (modules not found).

- [ ] **Step 3: Implement**

`src/operations/workflow-types.ts`: the exact types from **Interfaces** above, with a header comment:
```ts
/**
 * A5 workflow-mode finding and reply shapes. They live here, not in src/workflow,
 * because the workflow ops parse into them and src/workflow imports src/operations
 * (never the reverse).
 */
```
Export them from `src/operations/index.ts`: `export type * from "./workflow-types";`. If the barrel uses named type exports, follow its style instead.

`src/workflow/types.ts`:
```ts
/** A5 workflow mode — story-loop state and artifact shapes. */
export type {
  GateName,
  ImplementerReply,
  ImplementerStatus,
  ReReviewVerdict,
  StoryReviewVerdict,
  WorkflowFinding,
  WorkflowFindingDraft,
  WorkflowFindingKind,
  WorkflowSeverity,
} from "@/operations";
import type { GateName, WorkflowFinding, WorkflowFindingDraft } from "@/operations";

// ...GateState, GateRunResult, WorkflowEndState, WorkflowPhase, WorkflowRuling,
// WorkflowStoryRecord, WorkflowResultFile exactly as in Interfaces above.
```

`src/workflow/paths.ts`:
```ts
import { join } from "node:path";

/** `<outputDir>/<project>` is runtime.outputDir; the workflow tree sits under it. */
export function workflowFeatureDir(outputDir: string, feature: string): string {
  return join(outputDir, "workflow", feature);
}

export function workflowRunDir(outputDir: string, feature: string, runId: string): string {
  return join(workflowFeatureDir(outputDir, feature), runId);
}

export function workflowStoryDir(runDir: string, storyId: string): string {
  return join(runDir, storyId);
}
```

`src/workflow/ledger.ts`:
```ts
/**
 * The run's recovery map (spec §9). One line per event, `<storyId>: <text>`,
 * in the subagent-driven-development skill's line shapes.
 */
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { WorkflowEndState, WorkflowRuling } from "./types";

export const _ledgerDeps = { appendFile, mkdir };

export function ledgerFilePath(runDir: string): string {
  return join(runDir, "ledger.md");
}

/** One line: newlines and runs of whitespace collapse to single spaces. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export const ledgerText = {
  fixRound: (round: number, max: number, summary: string): string => `fix round ${round}/${max} (${oneLine(summary)})`,
  deferredMinor: (issue: string): string => `deferred-minor: ${oneLine(issue)}`,
  ruling: (r: WorkflowRuling): string => `Ruling: ${oneLine(r.text)} — ${oneLine(r.why)} — ${oneLine(r.costIfWrong)}`,
  end: (state: WorkflowEndState, summary: string): string => `${state} (${oneLine(summary)})`,
  reviewSkipped: (what: string): string => `review-skipped (${oneLine(what)})`,
  note: (text: string): string => oneLine(text),
};

export async function ensureLedger(runDir: string, runId: string, feature: string): Promise<void> {
  const path = ledgerFilePath(runDir);
  if (await Bun.file(path).exists()) return;
  await _ledgerDeps.mkdir(runDir, { recursive: true });
  await Bun.write(path, `# Workflow ledger — run: ${runId} — feature: ${feature}\n`);
}

export async function appendLedger(runDir: string, storyId: string, text: string): Promise<void> {
  await _ledgerDeps.appendFile(ledgerFilePath(runDir), `${storyId}: ${text}\n`);
}
```

`src/workflow/result.ts`:
```ts
/**
 * result.json (spec §9): per-story state for resume and the feature report.
 * Written atomically (tmp + rename) after every phase change.
 */
import { mkdir, readdir, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import type { WorkflowResultFile, WorkflowStoryRecord } from "./types";

export const _resultDeps = { mkdir, readdir, rename, stat };

const RESULT_FILE = "result.json";

export function newStoryRecord(storyId: string, maxRounds: number, now: string): WorkflowStoryRecord {
  return {
    storyId,
    round: 0,
    maxRounds,
    phase: "implement",
    reviewed: false,
    unreviewed: false,
    openFindings: [],
    nextFindingId: 1,
    deferredMinors: 0,
    rulings: 0,
    gates: {},
    timings: {},
    startedAt: now,
  };
}

export async function readResult(runDir: string): Promise<WorkflowResultFile | null> {
  const file = Bun.file(join(runDir, RESULT_FILE));
  if (!(await file.exists())) return null;
  try {
    const parsed = (await file.json()) as WorkflowResultFile;
    return parsed?.schemaVersion === 1 && typeof parsed.stories === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export async function upsertStoryRecord(
  runDir: string,
  header: { readonly runId: string; readonly feature: string },
  record: WorkflowStoryRecord,
): Promise<void> {
  const current = await readResult(runDir);
  const next: WorkflowResultFile = {
    schemaVersion: 1,
    runId: header.runId,
    feature: header.feature,
    stories: { ...(current?.stories ?? {}), [record.storyId]: record },
  };
  await _resultDeps.mkdir(runDir, { recursive: true });
  const tmp = join(runDir, `${RESULT_FILE}.tmp`);
  await Bun.write(tmp, `${JSON.stringify(next, null, 2)}\n`);
  await _resultDeps.rename(tmp, join(runDir, RESULT_FILE));
}

/**
 * The story's record from the most recent OTHER run of this feature, when that run
 * left it unfinished (no end state). Used to resume after a crash (spec §10).
 */
export async function loadPriorStoryRecord(
  featureDir: string,
  currentRunId: string,
  storyId: string,
): Promise<WorkflowStoryRecord | null> {
  let entries: string[];
  try {
    entries = await _resultDeps.readdir(featureDir);
  } catch {
    return null;
  }
  const dated: { runDir: string; mtimeMs: number }[] = [];
  for (const name of entries) {
    if (name === currentRunId) continue;
    const runDir = join(featureDir, name);
    try {
      const s = await _resultDeps.stat(join(runDir, RESULT_FILE));
      dated.push({ runDir, mtimeMs: s.mtimeMs });
    } catch {
      // not a run dir, or no result.json yet
    }
  }
  dated.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const { runDir } of dated) {
    const record = (await readResult(runDir))?.stories[storyId];
    if (!record) continue;
    return record.state === undefined ? record : null;
  }
  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/unit/workflow/ledger.test.ts test/unit/workflow/result.test.ts --timeout=60000`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/operations/workflow-types.ts src/operations/index.ts src/workflow test/unit/workflow
git commit -m "feat(workflow): finding/record types, ledger and result.json"
```

---

### Task 3: Reply parsers (implementer, story review, re-review)

**Files:**
- Create: `src/operations/workflow-replies.ts`
- Test: `test/unit/operations/workflow-replies.test.ts`

**Interfaces:**
- Consumes: the types from `src/operations/workflow-types.ts` (Task 2).
- Produces:
  - `WORKFLOW_INTERRUPT_MARKER = "<<nax-workflow-interrupted>>"`
  - `parseImplementerReply(output: string): ImplementerReply` (never throws, never null)
  - `parseStoryReviewReply(output: string): StoryReviewVerdict | null`
  - `parseReReviewReply(output: string, openIds: readonly string[]): ReReviewVerdict | null`

- [ ] **Step 1: Write the failing test**

`test/unit/operations/workflow-replies.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import {
  parseImplementerReply,
  parseReReviewReply,
  parseStoryReviewReply,
  WORKFLOW_INTERRUPT_MARKER,
} from "@/operations/workflow-replies";

const fence = (o: unknown) => `Done.\n\n\`\`\`json\n${JSON.stringify(o)}\n\`\`\``;

describe("parseImplementerReply", () => {
  test("reads the trailing status block", () => {
    const r = parseImplementerReply(
      fence({ status: "DONE", commits: ["abc123"], testSummary: "12 pass", concerns: "" }),
    );
    expect(r).toEqual({ status: "DONE", commits: ["abc123"], testSummary: "12 pass", interrupted: false });
  });

  test("NEEDS_CONTEXT keeps its concern", () => {
    const r = parseImplementerReply(fence({ status: "NEEDS_CONTEXT", commits: [], testSummary: "", concerns: "Which DB?" }));
    expect(r.status).toBe("NEEDS_CONTEXT");
    expect(r.concerns).toBe("Which DB?");
  });

  test("no status block -> DONE_WITH_CONCERNS (the work is the tree, not the reply)", () => {
    const r = parseImplementerReply("I changed some files.");
    expect(r.status).toBe("DONE_WITH_CONCERNS");
    expect(r.concerns).toContain("no status block");
  });

  test("unknown status -> DONE_WITH_CONCERNS", () => {
    expect(parseImplementerReply(fence({ status: "MAYBE" })).status).toBe("DONE_WITH_CONCERNS");
  });

  test("interrupt marker -> interrupted", () => {
    const r = parseImplementerReply(WORKFLOW_INTERRUPT_MARKER);
    expect(r.interrupted).toBe(true);
    expect(r.status).toBe("DONE_WITH_CONCERNS");
  });

  test("all-hops-failed text -> failure", () => {
    const r = parseImplementerReply('Agent "native" failed: 503 upstream');
    expect(r.failure).toBe('Agent "native" failed: 503 upstream');
  });
});

describe("parseStoryReviewReply", () => {
  test("normalises findings and drops ones without an issue", () => {
    const v = parseStoryReviewReply(
      JSON.stringify({
        spec: "pass",
        quality: "changes",
        findings: [
          { severity: "important", kind: "quality", file: "src/a.ts", line: 4, issue: "leaks handle", suggestion: "close it" },
          { severity: "bogus", kind: "bogus", issue: "odd" },
          { severity: "minor", kind: "quality" },
        ],
        cannotVerify: ["perf"],
      }),
    );
    expect(v?.findings).toEqual([
      { severity: "important", kind: "quality", file: "src/a.ts", line: 4, issue: "leaks handle", suggestion: "close it" },
      { severity: "important", kind: "quality", issue: "odd" },
    ]);
    expect(v?.cannotVerify).toEqual(["perf"]);
  });

  test("spec fail with no blocking spec finding gets a synthetic one (Review Focus 1)", () => {
    const v = parseStoryReviewReply(JSON.stringify({ spec: "fail", quality: "approved", findings: [], cannotVerify: [] }));
    expect(v?.findings).toHaveLength(1);
    expect(v?.findings[0]).toMatchObject({ kind: "spec", severity: "important" });
  });

  test("spec fail with only a minor spec finding still gets the synthetic one", () => {
    const v = parseStoryReviewReply(
      JSON.stringify({ spec: "fail", quality: "approved", findings: [{ severity: "minor", kind: "spec", issue: "naming" }] }),
    );
    expect(v?.findings.filter((f) => f.severity === "important")).toHaveLength(1);
  });

  test("bad verdict enums -> null", () => {
    expect(parseStoryReviewReply(JSON.stringify({ spec: "ok", quality: "approved", findings: [] }))).toBeNull();
    expect(parseStoryReviewReply("not json")).toBeNull();
  });
});

describe("parseReReviewReply", () => {
  test("missing verdict for an open id stays NOT_ADDRESSED (Review Focus 3)", () => {
    const v = parseReReviewReply(
      JSON.stringify({
        findings: [
          { id: "F1", verdict: "ADDRESSED", note: "fixed" },
          { id: "F9", verdict: "ADDRESSED", note: "unknown id, ignored" },
        ],
        newFindings: [{ severity: "critical", kind: "quality", issue: "broke parse" }],
      }),
      ["F1", "F2"],
    );
    expect(v?.verdicts).toEqual([
      { id: "F1", addressed: true, note: "fixed" },
      { id: "F2", addressed: false, note: "(no verdict returned)" },
    ]);
    expect(v?.newFindings).toEqual([{ severity: "critical", kind: "quality", issue: "broke parse" }]);
  });

  test("no findings array -> null", () => {
    expect(parseReReviewReply(JSON.stringify({ newFindings: [] }), ["F1"])).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test test/unit/operations/workflow-replies.test.ts --timeout=60000`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`src/operations/workflow-replies.ts`:
```ts
/** A5 workflow reply parsers. Pure; every LLM JSON read goes through tryParseLLMJson. */
import { tryParseLLMJson } from "../utils/llm-json";
import type {
  ImplementerReply,
  ImplementerStatus,
  ReReviewVerdict,
  StoryReviewVerdict,
  WorkflowFindingDraft,
  WorkflowFindingKind,
  WorkflowSeverity,
} from "./workflow-types";

export const WORKFLOW_INTERRUPT_MARKER = "<<nax-workflow-interrupted>>";

const STATUSES: readonly ImplementerStatus[] = ["DONE", "DONE_WITH_CONCERNS", "NEEDS_CONTEXT", "BLOCKED"];
const SEVERITIES: readonly WorkflowSeverity[] = ["critical", "important", "minor"];
const REVIEW_KINDS: readonly WorkflowFindingKind[] = ["spec", "quality"];
const NO_VERDICT_NOTE = "(no verdict returned)";
const SPEC_FAIL_ISSUE =
  "Story review returned spec: fail without a blocking spec finding. Re-read the brief's acceptance criteria and the TDD-evidence rule, and fix what is missing.";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];
}

export function parseImplementerReply(output: string): ImplementerReply {
  if (output.startsWith(WORKFLOW_INTERRUPT_MARKER)) {
    return { status: "DONE_WITH_CONCERNS", commits: [], testSummary: "", concerns: "step time limit reached", interrupted: true };
  }
  if (output.startsWith('Agent "')) {
    return { status: "DONE_WITH_CONCERNS", commits: [], testSummary: "", interrupted: false, failure: output.trim() };
  }
  const parsed = tryParseLLMJson<unknown>(output);
  const status = isRecord(parsed) ? parsed.status : undefined;
  if (!isRecord(parsed) || !STATUSES.includes(status as ImplementerStatus)) {
    return {
      status: "DONE_WITH_CONCERNS",
      commits: [],
      testSummary: "",
      concerns: "implementer reply carried no status block",
      interrupted: false,
    };
  }
  const concerns = str(parsed.concerns);
  return {
    status: status as ImplementerStatus,
    commits: strings(parsed.commits),
    testSummary: typeof parsed.testSummary === "string" ? parsed.testSummary : "",
    ...(concerns ? { concerns } : {}),
    interrupted: false,
  };
}

function toDraft(entry: unknown): WorkflowFindingDraft | null {
  if (!isRecord(entry)) return null;
  const issue = str(entry.issue);
  if (!issue) return null;
  const severity = SEVERITIES.includes(entry.severity as WorkflowSeverity) ? (entry.severity as WorkflowSeverity) : "important";
  const kind = REVIEW_KINDS.includes(entry.kind as WorkflowFindingKind) ? (entry.kind as WorkflowFindingKind) : "quality";
  const file = str(entry.file);
  const acId = str(entry.acId);
  const suggestion = str(entry.suggestion);
  const line = Number.isInteger(entry.line) && (entry.line as number) > 0 ? (entry.line as number) : undefined;
  return {
    severity,
    kind,
    ...(file ? { file } : {}),
    ...(line !== undefined ? { line } : {}),
    ...(acId ? { acId } : {}),
    issue,
    ...(suggestion ? { suggestion } : {}),
  };
}

function drafts(v: unknown): WorkflowFindingDraft[] {
  return Array.isArray(v) ? v.map(toDraft).filter((d): d is WorkflowFindingDraft => d !== null) : [];
}

export function parseStoryReviewReply(output: string): StoryReviewVerdict | null {
  const parsed = tryParseLLMJson<unknown>(output);
  if (!isRecord(parsed)) return null;
  if (parsed.spec !== "pass" && parsed.spec !== "fail") return null;
  if (parsed.quality !== "approved" && parsed.quality !== "changes") return null;
  const findings = drafts(parsed.findings);
  const hasBlockingSpec = findings.some((f) => f.kind === "spec" && f.severity !== "minor");
  const withSynthetic =
    parsed.spec === "fail" && !hasBlockingSpec
      ? [...findings, { kind: "spec" as const, severity: "important" as const, issue: SPEC_FAIL_ISSUE }]
      : findings;
  return { spec: parsed.spec, quality: parsed.quality, findings: withSynthetic, cannotVerify: strings(parsed.cannotVerify) };
}

export function parseReReviewReply(output: string, openIds: readonly string[]): ReReviewVerdict | null {
  const parsed = tryParseLLMJson<unknown>(output);
  if (!isRecord(parsed) || !Array.isArray(parsed.findings)) return null;
  const byId = new Map<string, Record<string, unknown>>();
  for (const entry of parsed.findings) {
    if (isRecord(entry) && typeof entry.id === "string" && !byId.has(entry.id)) byId.set(entry.id, entry);
  }
  const verdicts = openIds.map((id) => {
    const entry = byId.get(id);
    if (!entry) return { id, addressed: false, note: NO_VERDICT_NOTE };
    return { id, addressed: entry.verdict === "ADDRESSED", note: typeof entry.note === "string" ? entry.note : "" };
  });
  return { verdicts, newFindings: drafts(parsed.newFindings) };
}
```
Export from `src/operations/index.ts`: `export { parseImplementerReply, parseReReviewReply, parseStoryReviewReply, WORKFLOW_INTERRUPT_MARKER } from "./workflow-replies";`

- [ ] **Step 4: Run to verify it passes**

Run: `bun test test/unit/operations/workflow-replies.test.ts --timeout=60000`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/operations/workflow-replies.ts src/operations/index.ts test/unit/operations/workflow-replies.test.ts
git commit -m "feat(workflow): implementer, story-review and re-review reply parsers"
```

---

### Task 4: Prompt builders (brief, implementer, fix, answer, story review, re-review)

**Files:**
- Create: `src/prompts/builders/workflow-implementer-builder.ts`
- Create: `src/prompts/builders/workflow-story-review-builder.ts`
- Create: `src/prompts/builders/workflow-re-review-builder.ts`
- Modify: `src/prompts/index.ts` (exports)
- Test: `test/unit/prompts/workflow-builders.test.ts`

**Interfaces:**
- Produces (all pure `(input) => string`, structural input types declared in each builder file, so prompts never import `src/workflow`):
  ```ts
  export interface WorkflowPromptFinding {
    readonly id: string; readonly kind: string; readonly severity: string; readonly issue: string;
    readonly file?: string; readonly line?: number; readonly acId?: string; readonly suggestion?: string;
  }
  export interface WorkflowBriefInput {
    readonly storyId: string; readonly title: string; readonly description: string;
    readonly acceptanceCriteria: readonly string[]; readonly contextFiles: readonly string[];
    readonly expectedFiles: readonly string[]; readonly specPath?: string; readonly specExcerpts: readonly string[];
    readonly storyContext?: string; readonly featureContext?: string; readonly constitution?: string;
    readonly rulings: readonly string[];
    readonly redBaseDependencies: readonly { readonly storyId: string; readonly reason: string }[];
    readonly reportPath: string;
  }
  buildWorkflowBrief(input: WorkflowBriefInput): string
  buildWorkflowImplementPrompt(input: { storyId: string; briefPath: string; reportPath: string }): string
  buildWorkflowFixPrompt(input: { mode: "warm" | "fresh"; round: number; maxRounds: number; priorRounds: number;
    findings: readonly WorkflowPromptFinding[]; briefPath: string; reportPath: string; uncommittedFiles: readonly string[] }): string
  buildWorkflowAnswerPrompt(answer: string): string
  buildWorkflowStoryReviewPrompt(input: { briefPath: string; reportPath: string; packagePath: string; concerns: readonly string[] }): string
  buildWorkflowReReviewPrompt(input: { briefPath: string; reportPath: string; packagePath: string; findings: readonly WorkflowPromptFinding[] }): string
  buildWorkflowReviewJsonRetry(): string
  buildWorkflowReviewJsonRetryCondensed(): string
  ```

- [ ] **Step 1: Write the failing test**

`test/unit/prompts/workflow-builders.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import {
  buildWorkflowAnswerPrompt,
  buildWorkflowBrief,
  buildWorkflowFixPrompt,
  buildWorkflowImplementPrompt,
  buildWorkflowReReviewPrompt,
  buildWorkflowStoryReviewPrompt,
} from "@/prompts";

const brief = {
  storyId: "US-003",
  title: "Invoice totals",
  description: "Compute totals.",
  acceptanceCriteria: ["Totals include tax", "Rounds half-even"],
  contextFiles: ["src/invoice.ts"],
  expectedFiles: ["src/totals.ts"],
  specPath: ".nax/features/billing/spec.md",
  specExcerpts: ["## US-003 Totals\nTax applies."],
  storyContext: "STORY CONTEXT",
  rulings: ["US-003 Ruling: follow the spec on rounding"],
  redBaseDependencies: [{ storyId: "US-001", reason: "full-suite red" }],
  reportPath: "/out/US-003/report.md",
};

describe("workflow builders", () => {
  test("brief: ACs numbered verbatim, spec path, excerpts, rulings, red-base warning", () => {
    const text = buildWorkflowBrief(brief);
    expect(text).toContain("AC-1: Totals include tax");
    expect(text).toContain("AC-2: Rounds half-even");
    expect(text).toContain(".nax/features/billing/spec.md");
    expect(text).toContain("## US-003 Totals");
    expect(text).toContain("follow the spec on rounding");
    expect(text).toContain("building on a red base");
    expect(text).toContain("US-001");
    expect(text).toContain("/out/US-003/report.md");
  });

  test("brief: no red-base section when every dependency is green", () => {
    expect(buildWorkflowBrief({ ...brief, redBaseDependencies: [] })).not.toContain("red base");
  });

  test("implement prompt carries the contract sections (W-R2)", () => {
    const text = buildWorkflowImplementPrompt({ storyId: "US-003", briefPath: "/b.md", reportPath: "/r.md" });
    for (const needle of [
      "/b.md",
      "/r.md",
      "TDD evidence",
      "failing",
      "Decisions & assumptions",
      "Do not dispatch sub-agents",
      '"status"',
      "NEEDS_CONTEXT",
      "commit",
    ]) {
      expect(text).toContain(needle);
    }
  });

  test("fix prompt: warm lists findings verbatim; fresh frames ownership and uncommitted files", () => {
    const findings = [{ id: "F2", kind: "spec", severity: "important", issue: "AC-2 untested", acId: "AC-2" }];
    const warm = buildWorkflowFixPrompt({
      mode: "warm", round: 1, maxRounds: 5, priorRounds: 0, findings, briefPath: "/b.md", reportPath: "/r.md", uncommittedFiles: [],
    });
    expect(warm).toContain("[F2]");
    expect(warm).toContain("AC-2 untested");
    expect(warm).not.toContain("you own it now");
    const fresh = buildWorkflowFixPrompt({
      mode: "fresh", round: 4, maxRounds: 5, priorRounds: 3, findings, briefPath: "/b.md", reportPath: "/r.md",
      uncommittedFiles: ["src/totals.ts"],
    });
    expect(fresh).toContain("tried 3 times");
    expect(fresh).toContain("you own it now");
    expect(fresh).toContain("src/totals.ts");
  });

  test("answer prompt quotes the answer", () => {
    expect(buildWorkflowAnswerPrompt("Use Postgres.")).toContain("Use Postgres.");
  });

  test("story review asks for the JSON shape and reads the three files", () => {
    const text = buildWorkflowStoryReviewPrompt({ briefPath: "/b.md", reportPath: "/r.md", packagePath: "/p.diff", concerns: ["BLOCKED: no DB"] });
    for (const needle of ["/b.md", "/r.md", "/p.diff", '"spec"', '"quality"', '"cannotVerify"', "TDD evidence", "BLOCKED: no DB"]) {
      expect(text).toContain(needle);
    }
  });

  test("re-review lists open ids and scopes new breakage to the fix diff", () => {
    const text = buildWorkflowReReviewPrompt({
      briefPath: "/b.md", reportPath: "/r.md", packagePath: "/p-2.diff",
      findings: [{ id: "F1", kind: "quality", severity: "critical", issue: "leak" }],
    });
    expect(text).toContain("[F1]");
    expect(text).toContain("ADDRESSED");
    expect(text).toContain("NOT_ADDRESSED");
    expect(text).toContain("only in this fix diff");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test test/unit/prompts/workflow-builders.test.ts --timeout=60000`
Expected: FAIL (exports missing).

- [ ] **Step 3: Implement**

`src/prompts/builders/workflow-implementer-builder.ts`:
```ts
/** A5 workflow mode: the story brief and every implementer-session prompt (spec §6). */

export interface WorkflowPromptFinding {
  readonly id: string;
  readonly kind: string;
  readonly severity: string;
  readonly issue: string;
  readonly file?: string;
  readonly line?: number;
  readonly acId?: string;
  readonly suggestion?: string;
}

export interface WorkflowBriefInput {
  readonly storyId: string;
  readonly title: string;
  readonly description: string;
  readonly acceptanceCriteria: readonly string[];
  readonly contextFiles: readonly string[];
  readonly expectedFiles: readonly string[];
  readonly specPath?: string;
  readonly specExcerpts: readonly string[];
  readonly storyContext?: string;
  readonly featureContext?: string;
  readonly constitution?: string;
  readonly rulings: readonly string[];
  readonly redBaseDependencies: readonly { readonly storyId: string; readonly reason: string }[];
  readonly reportPath: string;
}

function list(items: readonly string[], empty: string): string {
  return items.length > 0 ? items.map((i) => `- ${i}`).join("\n") : empty;
}

function section(title: string, body: string | undefined): string {
  return body?.trim() ? `## ${title}\n\n${body.trim()}\n` : "";
}

export function renderWorkflowFindings(findings: readonly WorkflowPromptFinding[]): string {
  return findings
    .map((f) => {
      const where = f.file ? ` (${f.file}${f.line ? `:${f.line}` : ""})` : "";
      const ac = f.acId ? ` [${f.acId}]` : "";
      const fix = f.suggestion ? `\n  Suggestion: ${f.suggestion}` : "";
      return `[${f.id}] [${f.severity}/${f.kind}]${ac}${where} ${f.issue}${fix}`;
    })
    .join("\n");
}

export function buildWorkflowBrief(input: WorkflowBriefInput): string {
  const acs = input.acceptanceCriteria.map((ac, i) => `AC-${i + 1}: ${ac}`).join("\n");
  const redBase =
    input.redBaseDependencies.length > 0
      ? section(
          "Warning",
          `You are building on a red base: ${input.redBaseDependencies
            .map((d) => `${d.storyId} ended with a red gate (${d.reason})`)
            .join("; ")}. Expect failures that are not yours, and say so in your report.`,
        )
      : "";
  return [
    `# Brief: ${input.storyId} — ${input.title}\n`,
    section("Story", input.description),
    section("Acceptance criteria (verbatim)", acs),
    section("Files to read first", list(input.contextFiles, "(none listed)")),
    section("Files the plan expects you to change", list(input.expectedFiles, "(none listed)")),
    section(
      "Feature spec",
      `${input.specPath ? `Path: ${input.specPath}. Read the parts that apply to this story.` : "No spec file was found."}${
        input.specExcerpts.length > 0 ? `\n\nSections that name ${input.storyId}:\n\n${input.specExcerpts.join("\n\n")}` : ""
      }`,
    ),
    section("Rulings in force", list(input.rulings, "")),
    redBase,
    section("Story context", input.storyContext),
    section("Feature context", input.featureContext),
    section("Project rules", input.constitution),
    section("Report", `Write your report to ${input.reportPath}.`),
  ]
    .filter(Boolean)
    .join("\n");
}

const REPLY_CONTRACT = `End your reply with exactly one fenced json block:

\`\`\`json
{"status": "DONE" | "DONE_WITH_CONCERNS" | "NEEDS_CONTEXT" | "BLOCKED", "commits": ["<sha>"], "testSummary": "<one line>", "concerns": "<empty unless status is not DONE>"}
\`\`\`

Use NEEDS_CONTEXT when you need information the brief does not give you, and BLOCKED when you cannot proceed. Say what you need in "concerns".`;

export function buildWorkflowImplementPrompt(input: { storyId: string; briefPath: string; reportPath: string }): string {
  return `You are the implementer for story ${input.storyId}. Read the brief first: ${input.briefPath}. It is your requirements.

## How to work
1. TDD for every acceptance criterion: write the test first, run it and see it failing, then write the code and see it passing. Run focused tests while you iterate, not the whole suite.
2. Commit your work with a conventional commit message. Commit before you reply.
3. Self-review your diff before you reply: correctness, edge cases, and anything the brief asks for that you skipped.
4. Do not dispatch sub-agents, helpers or reviewers. A reviewer checks your work after you reply.

## Report
Write ${input.reportPath} with these sections:
- **What was built**
- **TDD evidence**: for each AC, the failing run and the passing run (command and the relevant output lines). Missing evidence, or a test that asserts nothing, fails review.
- **Files changed**
- **Decisions & assumptions**: every judgment call you made and why.

${REPLY_CONTRACT}`;
}

export function buildWorkflowFixPrompt(input: {
  mode: "warm" | "fresh";
  round: number;
  maxRounds: number;
  priorRounds: number;
  findings: readonly WorkflowPromptFinding[];
  briefPath: string;
  reportPath: string;
  uncommittedFiles: readonly string[];
}): string {
  const framing =
    input.mode === "fresh"
      ? `A prior implementer tried ${input.priorRounds} times to close these findings; you own it now. Read the brief (${input.briefPath}) and the report (${input.reportPath}) before you change anything.`
      : "The reviewer found these issues in your work.";
  const uncommitted =
    input.uncommittedFiles.length > 0
      ? `\n\nThese files have uncommitted edits from an interrupted turn. Continue from them, do not discard them:\n${input.uncommittedFiles
          .map((f) => `- ${f}`)
          .join("\n")}`
      : "";
  return `Fix round ${input.round} of ${input.maxRounds}. ${framing}

## Findings
${renderWorkflowFindings(input.findings)}${uncommitted}

## How to work
- Fix every finding above. Re-run the tests that cover what you changed, and add a test where a finding names a missing one (TDD: see it fail first).
- Commit, then append a "Fix round ${input.round}" section to ${input.reportPath}: what you changed for each finding id, the test evidence, and any new Decisions & assumptions.
- Do not dispatch sub-agents or reviewers.

${REPLY_CONTRACT}`;
}

export function buildWorkflowAnswerPrompt(answer: string): string {
  return `Answer to your question:

${answer}

Continue the work with this answer. Commit, update the report, and reply with the same json block as before.`;
}
```

`src/prompts/builders/workflow-story-review-builder.ts`:
```ts
/** A5 workflow mode: the story review prompt (spec §6 step 4) and the JSON retries shared with the re-review. */

export function buildWorkflowStoryReviewPrompt(input: {
  briefPath: string;
  reportPath: string;
  packagePath: string;
  concerns: readonly string[];
}): string {
  const concerns =
    input.concerns.length > 0
      ? `\n\nThe implementer raised these concerns. Judge them as part of the review:\n${input.concerns.map((c) => `- ${c}`).join("\n")}`
      : "";
  return `You are reviewing one story. Read three files:
- the brief (the requirements): ${input.briefPath}
- the implementer's report: ${input.reportPath}
- the review package (commits, --stat, full diff with context; truncated files are listed by name, read them yourself): ${input.packagePath}${concerns}

Give two verdicts:
- **spec**: "pass" only if every acceptance criterion is implemented and covered by a test that would fail without it. Check the report's TDD evidence: missing evidence for an AC, or a test that asserts nothing, is a spec failure.
- **quality**: "approved" or "changes" (correctness, error handling, edge cases, conventions of the surrounding code).

Severity: "critical" (wrong or unsafe behaviour), "important" (must fix before this story is done), "minor" (worth noting, not blocking). Put anything you could not check in "cannotVerify".

Reply with only this JSON object:
{"spec": "pass|fail", "quality": "approved|changes", "findings": [{"severity": "critical|important|minor", "kind": "spec|quality", "file": "path", "line": 0, "acId": "AC-3", "issue": "what is wrong", "suggestion": "how to fix"}], "cannotVerify": ["..."]}`;
}

export function buildWorkflowReviewJsonRetry(): string {
  return "Your reply was not the required JSON object. Re-send it now as only the JSON object, with no other text.";
}

export function buildWorkflowReviewJsonRetryCondensed(): string {
  return 'Your reply was cut off. Re-send a shorter version: keep every finding but shorten "issue" and "suggestion" to one sentence each. Only the JSON object.';
}
```

`src/prompts/builders/workflow-re-review-builder.ts`:
```ts
/** A5 workflow mode: the scoped re-review prompt (spec §6 step 5). */
import { renderWorkflowFindings, type WorkflowPromptFinding } from "./workflow-implementer-builder";

export function buildWorkflowReReviewPrompt(input: {
  briefPath: string;
  reportPath: string;
  packagePath: string;
  findings: readonly WorkflowPromptFinding[];
}): string {
  return `You are checking one fix round. Read the brief (${input.briefPath}), the report (${input.reportPath}, see its latest "Fix round" section) and the fix package (${input.packagePath}). The package holds only this fix diff.

## Findings the fix had to address
${renderWorkflowFindings(input.findings)}

For each finding id, answer ADDRESSED or NOT_ADDRESSED. Then list new problems introduced only in this fix diff. Do not re-review the rest of the story.

Reply with only this JSON object:
{"findings": [{"id": "F1", "verdict": "ADDRESSED|NOT_ADDRESSED", "note": "one sentence"}], "newFindings": [{"severity": "critical|important|minor", "kind": "spec|quality", "file": "path", "line": 0, "issue": "...", "suggestion": "..."}]}`;
}
```

`src/prompts/index.ts`, next to the nbf exports:
```ts
export type { WorkflowBriefInput, WorkflowPromptFinding } from "./builders/workflow-implementer-builder";
export {
  buildWorkflowAnswerPrompt,
  buildWorkflowBrief,
  buildWorkflowFixPrompt,
  buildWorkflowImplementPrompt,
} from "./builders/workflow-implementer-builder";
export { buildWorkflowReReviewPrompt } from "./builders/workflow-re-review-builder";
export {
  buildWorkflowReviewJsonRetry,
  buildWorkflowReviewJsonRetryCondensed,
  buildWorkflowStoryReviewPrompt,
} from "./builders/workflow-story-review-builder";
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test test/unit/prompts/workflow-builders.test.ts --timeout=60000`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/prompts test/unit/prompts/workflow-builders.test.ts
git commit -m "feat(workflow): brief, implementer, fix, story-review and re-review prompt builders"
```

---

### Task 5: The three workflow operations

**Files:**
- Create: `src/operations/workflow-implement.ts`, `src/operations/workflow-story-review.ts`, `src/operations/workflow-re-review.ts`
- Modify: `src/operations/index.ts`
- Test: `test/unit/operations/workflow-ops.test.ts`

**Interfaces:**
- Consumes: `workflowConfigSelector` / `WorkflowOpConfig` (Task 1), `isInterruptedStale` (Task 1), `STEP_TIMEOUT_MARGIN_MS` (Task 1), the parsers (Task 3), and the builders' JSON retries (Task 4).
- Produces:
  ```ts
  export interface WorkflowImplementInput {
    readonly story: UserStory;
    readonly prompt: string;
    /** Undefined: the story's routed model (storyRoutingModel). */
    readonly model?: ConfiguredModel;
    /** Step limit: the soft interrupt fires at this point. */
    readonly timeoutMs: number;
  }
  export const workflowImplementOp: RunOperationWithHooks<WorkflowImplementInput, ImplementerReply, WorkflowOpConfig, "hopBody" | "recover">
  export interface WorkflowReviewInput { readonly prompt: string; readonly model?: ConfiguredModel; readonly timeoutMs: number }
  export interface WorkflowReReviewInput extends WorkflowReviewInput { readonly openIds: readonly string[] }
  export const workflowStoryReviewOp: RunOperation<WorkflowReviewInput, StoryReviewVerdict | null, WorkflowOpConfig>
  export const workflowReReviewOp: RunOperation<WorkflowReReviewInput, ReReviewVerdict | null, WorkflowOpConfig>
  ```

- [ ] **Step 1: Write the failing test**

`test/unit/operations/workflow-ops.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { makeNaxConfig, makeStory, makeTestRuntime, opSelector } from "@test/helpers";
import { workflowConfigSelector } from "@/config";
import { workflowImplementOp, workflowReReviewOp, workflowStoryReviewOp, WORKFLOW_INTERRUPT_MARKER } from "@/operations";

function buildCtx(overrides: Record<string, unknown> = {}) {
  const config = makeNaxConfig(overrides);
  const packageView = makeTestRuntime({ config }).packages.repo();
  return { packageView, config: packageView.select(opSelector(workflowConfigSelector)) };
}

const story = makeStory({
  id: "US-001",
  title: "t",
  description: "d",
  acceptanceCriteria: ["a"],
  status: "in-progress",
  attempts: 1,
  routing: { complexity: "medium", modelTier: "balanced", testStrategy: "tdd-simple", reasoning: "" },
});

describe("workflowImplementOp", () => {
  test("shape: warm wf-implementer, stage run, write tools, kept open", () => {
    expect(workflowImplementOp.session).toEqual({ role: "wf-implementer", lifetime: "warm" });
    expect(workflowImplementOp.stage).toBe("run");
    expect(workflowImplementOp.tools).toContain("Write");
    expect(workflowImplementOp.tools).toContain("GitCommit");
    const ctx = buildCtx();
    expect(workflowImplementOp.keepOpen?.({ story, prompt: "p", timeoutMs: 1 }, ctx as never)).toBe(true);
  });

  test("model: explicit override wins, else the story's routed tier", () => {
    const ctx = buildCtx();
    const resolve = workflowImplementOp.model as (i: unknown, c: unknown) => unknown;
    expect(resolve({ story, prompt: "p", timeoutMs: 1 }, ctx)).toBe("balanced");
    expect(resolve({ story, prompt: "p", timeoutMs: 1, model: "powerful" }, ctx)).toBe("powerful");
  });

  test("agent timeout trails the step limit by the margin", () => {
    const ctx = buildCtx();
    const t = workflowImplementOp.timeoutMs as (i: unknown, c: unknown) => number;
    expect(t({ story, prompt: "p", timeoutMs: 1000 }, ctx)).toBe(61_000);
  });

  test("hopBody: an interrupted turn returns the marker instead of throwing", async () => {
    const { SessionFailureError } = await import("@/agents");
    // Throw only once the interrupt has really fired, like a soft-cancelled turn does.
    const send = async (_prompt: string, opts?: { interrupt?: AbortSignal }) => {
      await new Promise((resolve) => opts?.interrupt?.addEventListener("abort", resolve, { once: true }));
      throw new SessionFailureError({ outcome: "fail-stale", reason: "interrupted" } as never);
    };
    const out = await workflowImplementOp.hopBody("go", {
      send,
      sendWithParseRetry: send,
      input: { story, prompt: "go", timeoutMs: 1 },
    } as never);
    expect(out.output).toBe(WORKFLOW_INTERRUPT_MARKER);
  });

  test("hopBody: a non-interrupt failure is rethrown", async () => {
    const send = async () => {
      throw new Error("boom");
    };
    await expect(
      workflowImplementOp.hopBody("go", { send, sendWithParseRetry: send, input: { story, prompt: "go", timeoutMs: 60_000 } } as never),
    ).rejects.toThrow("boom");
  });
});

describe("workflow review ops", () => {
  test("story review: fresh wf-story-review, read tools + Git, no writes", () => {
    expect(workflowStoryReviewOp.session).toEqual({ role: "wf-story-review", lifetime: "fresh" });
    expect(workflowStoryReviewOp.stage).toBe("review");
    expect(workflowStoryReviewOp.tools).toEqual(["Read", "Glob", "Grep", "Git"]);
  });

  test("story review model: workflow.models.storyReview, else review.semantic.model", () => {
    const resolve = workflowStoryReviewOp.model as (i: unknown, c: unknown) => unknown;
    expect(resolve({ prompt: "p", timeoutMs: 1 }, buildCtx({ review: { semantic: { model: "fast" } } }))).toBe("fast");
    expect(
      resolve({ prompt: "p", timeoutMs: 1 }, buildCtx({ workflow: { models: { storyReview: "powerful" } } })),
    ).toBe("powerful");
  });

  test("re-review: fresh wf-rereview, parse uses the open ids", () => {
    expect(workflowReReviewOp.session).toEqual({ role: "wf-rereview", lifetime: "fresh" });
    const out = workflowReReviewOp.parse(JSON.stringify({ findings: [], newFindings: [] }), { prompt: "p", timeoutMs: 1, openIds: ["F1"] }, buildCtx() as never);
    expect(out?.verdicts).toEqual([{ id: "F1", addressed: false, note: "(no verdict returned)" }]);
  });
});
```
If `makeStory` rejects the `routing` literal, build the story with `makeTestStory` from `@test/helpers` instead, keeping the same routing.

- [ ] **Step 2: Run to verify it fails**

Run: `bun test test/unit/operations/workflow-ops.test.ts --timeout=60000`
Expected: FAIL (exports missing).

- [ ] **Step 3: Implement**

`src/operations/workflow-implement.ts`:
```ts
/**
 * A5 workflow mode: the story's one implementer (spec §6 steps 2 and 5).
 * The same op serves the first turn, fix rounds and advisor answers; the caller builds the prompt.
 * Warm across rounds 1..min(3, max): same role + same endpoint = the same session (§5.5).
 */
import type { ConfiguredModel } from "@/config";
import { workflowConfigSelector } from "@/config";
import type { WorkflowOpConfig } from "@/config/selectors";
import { STEP_TIMEOUT_MARGIN_MS } from "@/utils/step-signal";
import type { TurnResult } from "../agents/types";
import type { UserStory } from "../prd";
import { isInterruptedStale } from "./_interrupt";
import { storyRoutingModel } from "./story-routing-model";
import type { RunOperationWithHooks } from "./types";
import { parseImplementerReply, WORKFLOW_INTERRUPT_MARKER } from "./workflow-replies";
import type { ImplementerReply } from "./workflow-types";

export interface WorkflowImplementInput {
  readonly story: UserStory;
  readonly prompt: string;
  readonly model?: ConfiguredModel;
  readonly timeoutMs: number;
}

const EMPTY_TURN: TurnResult = {
  output: "",
  tokenUsage: { inputTokens: 0, outputTokens: 0 },
  estimatedCostUsd: 0,
  internalRoundTrips: 0,
};

export const workflowImplementOp: RunOperationWithHooks<
  WorkflowImplementInput,
  ImplementerReply,
  WorkflowOpConfig,
  "hopBody" | "recover"
> = {
  kind: "run",
  name: "workflow-implement",
  stage: "run",
  session: { role: "wf-implementer", lifetime: "warm" },
  config: workflowConfigSelector,
  tools: ["Read", "Glob", "Grep", "Write", "Edit", "Delete", "Git", "RunCommand", "GitCommit", "Exec", "Bash", "RequestCapability"],
  model: (input) => input.model ?? storyRoutingModel(input.story),
  keepOpen: () => true,
  // The agent's own timeout trails the step limit, so the soft interrupt always fires first.
  timeoutMs: (input) => input.timeoutMs + STEP_TIMEOUT_MARGIN_MS,
  build(input) {
    return {
      role: { id: "role", content: "", overridable: false },
      task: { id: "task", content: input.prompt, overridable: false },
    };
  },
  /**
   * One turn under a soft interrupt at the step limit. An interrupted turn leaves the
   * session warm and its edits in the tree (spec §6 failure table); it comes back as
   * the marker, never rethrown, so the stale-retry never re-runs a stopped turn.
   */
  async hopBody(initialPrompt, ctx) {
    const interrupt = AbortSignal.timeout(ctx.input.timeoutMs);
    try {
      return await ctx.send(initialPrompt, { interrupt });
    } catch (err) {
      if (!interrupt.aborted || !isInterruptedStale(err)) throw err;
      return { ...EMPTY_TURN, output: WORKFLOW_INTERRUPT_MARKER };
    }
  },
  parse: (output) => parseImplementerReply(output),
  /** An empty reply is not a failure: the implementer's real output is the working tree. */
  async recover() {
    return parseImplementerReply("");
  },
};
```

`src/operations/workflow-story-review.ts`:
```ts
/** A5 workflow mode: fresh, read-only story review (spec §6 step 4). One parse retry, then null (review-skipped). */
import { makeParseRetryStrategy } from "@/agents/retry";
import type { ConfiguredModel } from "@/config";
import { workflowConfigSelector } from "@/config";
import type { WorkflowOpConfig } from "@/config/selectors";
import { buildWorkflowReviewJsonRetry, buildWorkflowReviewJsonRetryCondensed } from "@/prompts";
import { STEP_TIMEOUT_MARGIN_MS } from "@/utils/step-signal";
import type { RunOperation } from "./types";
import { parseStoryReviewReply } from "./workflow-replies";
import type { StoryReviewVerdict } from "./workflow-types";

export interface WorkflowReviewInput {
  readonly prompt: string;
  readonly model?: ConfiguredModel;
  readonly timeoutMs: number;
}

export const WORKFLOW_REVIEW_TOOLS = ["Read", "Glob", "Grep", "Git"] as const;

export const workflowStoryReviewOp: RunOperation<WorkflowReviewInput, StoryReviewVerdict | null, WorkflowOpConfig> = {
  kind: "run",
  name: "workflow-story-review",
  stage: "review",
  session: { role: "wf-story-review", lifetime: "fresh" },
  config: workflowConfigSelector,
  tools: [...WORKFLOW_REVIEW_TOOLS],
  model: (input, ctx) => input.model ?? ctx.config.workflow?.models?.storyReview ?? ctx.config.review?.semantic?.model,
  timeoutMs: (input) => input.timeoutMs + STEP_TIMEOUT_MARGIN_MS,
  build(input) {
    return {
      role: { id: "role", content: "", overridable: false },
      task: { id: "task", content: input.prompt, overridable: false },
    };
  },
  parse: (output) => parseStoryReviewReply(output),
  retry: makeParseRetryStrategy({
    parse: (output) => parseStoryReviewReply(output),
    validate: (parsed) => parsed !== null,
    reviewerKind: "workflow-story-review",
    maxAttempts: 2,
    prompts: { invalid: buildWorkflowReviewJsonRetry, truncated: buildWorkflowReviewJsonRetryCondensed },
    exhaustedFallback: () => null,
  }),
};
```

`src/operations/workflow-re-review.ts`:
```ts
/** A5 workflow mode: fresh re-review scoped to one fix diff (spec §6 step 5). One parse retry, then null. */
import { makeParseRetryStrategy } from "@/agents/retry";
import { workflowConfigSelector } from "@/config";
import type { WorkflowOpConfig } from "@/config/selectors";
import { buildWorkflowReviewJsonRetry, buildWorkflowReviewJsonRetryCondensed } from "@/prompts";
import { STEP_TIMEOUT_MARGIN_MS } from "@/utils/step-signal";
import type { RunOperation } from "./types";
import { parseReReviewReply } from "./workflow-replies";
import { WORKFLOW_REVIEW_TOOLS, type WorkflowReviewInput } from "./workflow-story-review";
import type { ReReviewVerdict } from "./workflow-types";

export interface WorkflowReReviewInput extends WorkflowReviewInput {
  readonly openIds: readonly string[];
}

export const workflowReReviewOp: RunOperation<WorkflowReReviewInput, ReReviewVerdict | null, WorkflowOpConfig> = {
  kind: "run",
  name: "workflow-re-review",
  stage: "review",
  session: { role: "wf-rereview", lifetime: "fresh" },
  config: workflowConfigSelector,
  tools: [...WORKFLOW_REVIEW_TOOLS],
  model: (input, ctx) => input.model ?? ctx.config.workflow?.models?.storyReview ?? ctx.config.review?.semantic?.model,
  timeoutMs: (input) => input.timeoutMs + STEP_TIMEOUT_MARGIN_MS,
  build(input) {
    return {
      role: { id: "role", content: "", overridable: false },
      task: { id: "task", content: input.prompt, overridable: false },
    };
  },
  parse: (output, input) => parseReReviewReply(output, input.openIds),
  retry: (input) =>
    makeParseRetryStrategy({
      parse: (output) => parseReReviewReply(output, input.openIds),
      validate: (parsed) => parsed !== null,
      reviewerKind: "workflow-re-review",
      maxAttempts: 2,
      prompts: { invalid: buildWorkflowReviewJsonRetry, truncated: buildWorkflowReviewJsonRetryCondensed },
      exhaustedFallback: () => null,
    }),
};
```
`src/operations/index.ts`: export the three ops, their input types, and `WORKFLOW_REVIEW_TOOLS`.

If `check-op-tool-capability`, `inert-bash-stages` or an op-registry test lists every op, add the three there the way `finishFixOp` / `nbfWorthCheckOp` appear. `bun run check:all` in Step 4 tells you.

- [ ] **Step 4: Run to verify it passes**

Run: `bun test test/unit/operations/workflow-ops.test.ts --timeout=60000 && bun run check:all`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/operations test/unit/operations/workflow-ops.test.ts
git commit -m "feat(workflow): implement, story-review and re-review operations"
```

---

### Task 6: Step context, git helpers, review package and the brief writer

**Files:**
- Create: `src/workflow/step-context.ts` (the `StepContext` type + `_workflowDeps` seam)
- Create: `src/workflow/git.ts`
- Create: `src/workflow/brief.ts`
- Test: `test/unit/workflow/git.test.ts`, `test/unit/workflow/brief.test.ts`

**Interfaces:**
- Consumes: Task 2 (`readResult`, `workflowStoryDir`), Task 4 (`buildWorkflowBrief`).
- Produces (`step-context.ts`):
  ```ts
  export interface StepContext {
    readonly callCtx: CallContext;
    readonly story: UserStory;
    readonly config: NaxConfig;            // per-story effective config
    readonly workflow: WorkflowConfig;     // resolveWorkflowConfig(rootConfig)
    readonly tierOrder: readonly TierConfig[];
    readonly feature: string;
    readonly projectDir: string;           // repo root (git cwd)
    readonly workdir: string;              // story package dir
    readonly runDir: string;
    readonly storyDir: string;
    readonly briefPath: string;
    readonly reportPath: string;
    readonly base: string;                 // BASE (ctx.storyGitRef)
    readonly runSignal?: AbortSignal;
    readonly sessionManager?: ISessionManager;
    readonly dryRun: boolean;
    readonly sessionScratchDir?: string;
    readonly naxIgnoreIndex?: NaxIgnoreIndex;
    readonly resolvedTestPatterns?: ResolvedTestPatterns;
    readonly contextMarkdown?: string;
    readonly featureContextMarkdown?: string;
    readonly constitution?: string;
  }
  export const _workflowDeps: {
    callOp: <I, O, C>(ctx: CallContext, op: Operation<I, O, C>, input: I) => Promise<O>;
    git: (args: string[], cwd: string) => Promise<{ stdout: string; exitCode: number }>;
    autoCommitIfDirty: typeof autoCommitIfDirty;
    resolveFeatureSpec: (feature: string, workdir: string) => Promise<{ specSource?: { path: string } }>;
    now: () => number;
  };
  ```
- Produces (`git.ts`): `readHead(projectDir): Promise<string>`, `listUncommitted(projectDir): Promise<string[]>`, `writeReviewPackage(projectDir, from, path): Promise<void>`
- Produces (`brief.ts`): `writeBrief(sc: StepContext): Promise<void>`, `specExcerpts(specText: string, storyId: string): string[]`

- [ ] **Step 1: Write the failing tests**

`test/unit/workflow/git.test.ts`:
```ts
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { listUncommitted, readHead, writeReviewPackage } from "@/workflow/git";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.map(cleanupTempDir));
  dirs.length = 0;
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const p = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  await p.exited;
  return out.trim();
}

async function repo(): Promise<string> {
  const dir = await makeTempDir("wf-git-");
  dirs.push(dir);
  await git(dir, "init", "-q");
  await git(dir, "config", "user.email", "t@t");
  await git(dir, "config", "user.name", "t");
  await Bun.write(join(dir, "a.txt"), "one\n");
  await git(dir, "add", ".");
  await git(dir, "commit", "-qm", "seed");
  return dir;
}

describe("workflow git helpers", () => {
  test("package: commit list, stat and a -U10 diff; .nax excluded", async () => {
    const dir = await repo();
    const base = await readHead(dir);
    await Bun.write(join(dir, "a.txt"), "one\ntwo\n");
    await Bun.write(join(dir, ".nax", "x.json"), "{}");
    await git(dir, "add", "-A");
    await git(dir, "commit", "-qm", "feat: two");
    const path = join(dir, "out", "package-0.diff");
    await writeReviewPackage(dir, base, path);
    const text = await Bun.file(path).text();
    expect(text).toContain("## Commits");
    expect(text).toContain("feat: two");
    expect(text).toContain("## Stat");
    expect(text).toContain("a.txt");
    expect(text).toContain("+two");
    expect(text).not.toContain(".nax/x.json");
  });

  test("listUncommitted names modified and untracked files, not .nax", async () => {
    const dir = await repo();
    await Bun.write(join(dir, "a.txt"), "changed\n");
    await Bun.write(join(dir, "b.txt"), "new\n");
    await Bun.write(join(dir, ".nax", "y.json"), "{}");
    expect((await listUncommitted(dir)).sort()).toEqual(["a.txt", "b.txt"]);
  });
});
```

`test/unit/workflow/brief.test.ts`:
```ts
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir, makeTestStory } from "@test/helpers";
import { upsertStoryRecord, newStoryRecord } from "@/workflow/result";
import { specExcerpts, writeBrief } from "@/workflow/brief";
import { _workflowDeps, type StepContext } from "@/workflow/step-context";

const dirs: string[] = [];
const original = { ..._workflowDeps };
afterEach(async () => {
  Object.assign(_workflowDeps, original);
  await Promise.all(dirs.map(cleanupTempDir));
  dirs.length = 0;
});

describe("specExcerpts", () => {
  test("keeps only sections that name the story id", () => {
    const spec = "# Spec\nintro\n## US-001 Login\nA\n## US-002 Logout\nB mentions US-001 too\n## Other\nC\n";
    expect(specExcerpts(spec, "US-001")).toEqual(["## US-001 Login\nA", "## US-002 Logout\nB mentions US-001 too"]);
    expect(specExcerpts(spec, "US-009")).toEqual([]);
  });
});

describe("writeBrief", () => {
  test("writes brief.md with spec excerpts and a red-base warning from this run's result.json", async () => {
    const root = await makeTempDir("wf-brief-");
    dirs.push(root);
    const runDir = join(root, "run");
    const specPath = join(root, "spec.md");
    await Bun.write(specPath, "## US-002 Pay\nDo it.\n");
    _workflowDeps.resolveFeatureSpec = async () => ({ specSource: { path: specPath } });
    await upsertStoryRecord(runDir, { runId: "r", feature: "f" }, {
      ...newStoryRecord("US-001", 5, "t"),
      state: "complete-gate-open",
      reason: "full-suite red",
    });
    const story = makeTestStory({ id: "US-002", dependencies: ["US-001"], acceptanceCriteria: ["pays"] });
    const sc = {
      story,
      feature: "f",
      projectDir: root,
      runDir,
      storyDir: join(runDir, "US-002"),
      briefPath: join(runDir, "US-002", "brief.md"),
      reportPath: join(runDir, "US-002", "report.md"),
      contextMarkdown: "CTX",
    } as unknown as StepContext;
    await writeBrief(sc);
    const text = await Bun.file(sc.briefPath).text();
    expect(text).toContain("AC-1: pays");
    expect(text).toContain("## US-002 Pay");
    expect(text).toContain("red base");
    expect(text).toContain("full-suite red");
    expect(text).toContain("CTX");
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test test/unit/workflow/git.test.ts test/unit/workflow/brief.test.ts --timeout=60000`
Expected: FAIL (modules not found).

- [ ] **Step 3: Implement**

`src/workflow/step-context.ts`:
```ts
/**
 * What every workflow step needs, built once per story by the stage (Task 11).
 * `_workflowDeps` is the single test seam: every agent call goes through
 * `_workflowDeps.callOp`, so a test fakes the agent in one place.
 */
import { resolveFeatureSpec } from "@/cli";
import type { NaxConfig, TierConfig, WorkflowConfig } from "@/config";
import { callOp } from "@/operations";
import type { CallContext, Operation } from "@/operations/types";
import type { UserStory } from "@/prd";
import type { ISessionManager } from "@/session/types";
import type { ResolvedTestPatterns } from "@/test-runners";
import { autoCommitIfDirty, gitWithTimeout } from "@/utils/git";
import type { NaxIgnoreIndex } from "@/utils/path-filters";

export interface StepContext {
  // ...exactly the fields listed in Interfaces above
}

export const _workflowDeps = {
  callOp: callOp as <I, O, C>(ctx: CallContext, op: Operation<I, O, C>, input: I) => Promise<O>,
  git: async (args: string[], cwd: string): Promise<{ stdout: string; exitCode: number }> => {
    const { stdout, exitCode } = await gitWithTimeout(args, cwd);
    return { stdout, exitCode };
  },
  autoCommitIfDirty,
  resolveFeatureSpec: (feature: string, workdir: string): Promise<{ specSource?: { path: string } }> =>
    resolveFeatureSpec(feature, workdir),
  now: (): number => Date.now(),
};
```
Use each import path the codebase already uses for these types (the `@/session/types`, `@/test-runners` and `@/utils/path-filters` type imports are type-only, so leaf paths are fine). If `bun run check:import-cycles` flags the `@/cli` import, replace it with a lazy `(await import("@/cli")).resolveFeatureSpec(feature, workdir)` inside the arrow function.

`src/workflow/git.ts`:
```ts
/** Git reads the story loop needs. cwd is always the repo root (repo-rooted paths). */
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { ALWAYS_EXCLUDED, truncateDiff } from "@/review";
import { _workflowDeps } from "./step-context";

const DIFF_CONTEXT_LINES = 10;

export async function readHead(projectDir: string): Promise<string> {
  const { stdout } = await _workflowDeps.git(["rev-parse", "HEAD"], projectDir);
  return stdout.trim();
}

/** Paths with uncommitted edits (modified, staged, untracked), minus nax-owned paths. */
export async function listUncommitted(projectDir: string): Promise<string[]> {
  const { stdout, exitCode } = await _workflowDeps.git(["status", "--porcelain", "--untracked-files=all"], projectDir);
  if (exitCode !== 0) return [];
  return stdout
    .split("\n")
    .filter((line) => line.length > 3)
    .map((line) => line.slice(3).replace(/^"|"$/g, "").split(" -> ").pop() ?? "")
    .filter((path) => path !== "" && !path.startsWith(".nax/") && !path.startsWith(".nax-"));
}

/** One file: commit list, --stat, and the full -U10 diff for from..HEAD (truncated past the review cap). */
export async function writeReviewPackage(projectDir: string, from: string, path: string): Promise<void> {
  const range = `${from}..HEAD`;
  const pathspec = ["--", ".", ...ALWAYS_EXCLUDED];
  const [log, stat, diff] = await Promise.all([
    _workflowDeps.git(["log", "--oneline", range], projectDir),
    _workflowDeps.git(["diff", "--stat", range, ...pathspec], projectDir),
    _workflowDeps.git(["diff", `--unified=${DIFF_CONTEXT_LINES}`, range, ...pathspec], projectDir),
  ]);
  const body = truncateDiff(diff.stdout, stat.stdout);
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(
    path,
    `## Commits (${range})\n${log.stdout.trim() || "(none)"}\n\n## Stat\n${stat.stdout.trim() || "(no changes)"}\n\n## Diff\n${body}\n`,
  );
}
```
If importing `@/review` from `src/workflow` trips `check:import-cycles`, import `ALWAYS_EXCLUDED` and `truncateDiff` from `../review/diff-utils` instead, as `src/execution/nbf-worth-check.ts:9` does.

`src/workflow/brief.ts`:
```ts
/** Story brief (spec §6 step 1): requirements, spec excerpts, rulings, red-base warnings. */
import { mkdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { buildWorkflowBrief } from "@/prompts";
import { readResult } from "./result";
import { _workflowDeps, type StepContext } from "./step-context";

const MAX_EXCERPT_CHARS = 12_000;

/** Markdown sections (any heading level) whose text names the story id. */
export function specExcerpts(specText: string, storyId: string): string[] {
  const sections = specText.split(/^(?=#{1,6} )/m).map((s) => s.trim()).filter(Boolean);
  const hits = sections.filter((s) => s.includes(storyId));
  const kept: string[] = [];
  let used = 0;
  for (const hit of hits) {
    if (used + hit.length > MAX_EXCERPT_CHARS) break;
    kept.push(hit);
    used += hit.length;
  }
  return kept;
}

async function loadSpec(sc: StepContext): Promise<{ path?: string; excerpts: string[] }> {
  try {
    const resolved = await _workflowDeps.resolveFeatureSpec(sc.feature, sc.projectDir);
    const rel = resolved.specSource?.path;
    if (!rel) return { excerpts: [] };
    const abs = isAbsolute(rel) ? rel : join(sc.projectDir, rel);
    const file = Bun.file(abs);
    return { path: rel, excerpts: (await file.exists()) ? specExcerpts(await file.text(), sc.story.id) : [] };
  } catch {
    return { excerpts: [] };
  }
}

async function redBaseDependencies(sc: StepContext): Promise<{ storyId: string; reason: string }[]> {
  const result = await readResult(sc.runDir);
  return (sc.story.dependencies ?? [])
    .map((id) => result?.stories[id])
    .filter((r) => r?.state === "complete-gate-open")
    .map((r) => ({ storyId: r?.storyId ?? "", reason: r?.reason ?? "gate red" }));
}

function contextFilePaths(sc: StepContext): string[] {
  return (sc.story.contextFiles ?? []).map((entry) => (typeof entry === "string" ? entry : entry.path));
}

export async function writeBrief(sc: StepContext): Promise<void> {
  const [spec, redBase] = await Promise.all([loadSpec(sc), redBaseDependencies(sc)]);
  const text = buildWorkflowBrief({
    storyId: sc.story.id,
    title: sc.story.title,
    description: sc.story.description,
    acceptanceCriteria: sc.story.acceptanceCriteria,
    contextFiles: contextFilePaths(sc),
    expectedFiles: sc.story.expectedFiles ?? [],
    ...(spec.path ? { specPath: spec.path } : {}),
    specExcerpts: spec.excerpts,
    ...(sc.contextMarkdown ? { storyContext: sc.contextMarkdown } : {}),
    ...(sc.featureContextMarkdown ? { featureContext: sc.featureContextMarkdown } : {}),
    ...(sc.constitution ? { constitution: sc.constitution } : {}),
    rulings: [],
    redBaseDependencies: redBase,
    reportPath: sc.reportPath,
  });
  await mkdir(sc.storyDir, { recursive: true });
  await Bun.write(sc.briefPath, text);
}
```
Check `ContextFileEntry`'s field name in `src/prd/types.ts`. If it isn't `path`, use the real one.

- [ ] **Step 4: Run them to verify they pass**

Run: `bun test test/unit/workflow/git.test.ts test/unit/workflow/brief.test.ts --timeout=60000`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/workflow test/unit/workflow
git commit -m "feat(workflow): step context, git helpers, review package and brief writer"
```

---

### Task 7: Gates (lint, typecheck, scoped tests, full suite)

**Files:**
- Create: `src/workflow/gates.ts`
- Test: `test/unit/workflow/gates.test.ts`

**Interfaces:**
- Consumes: `StepContext`, `_workflowDeps.callOp` (Task 6), `lintCheckOp`, `typecheckCheckOp`, `verifyScopedOp`, `fullSuiteGateOp` (`@/operations`).
- Produces:
  ```ts
  export const MAX_GATE_FINDINGS = 25;
  export async function runStoryGates(sc: StepContext): Promise<GateRunResult>;   // lint, typecheck, scoped
  export async function runFullSuiteGate(sc: StepContext): Promise<GateRunResult>;
  ```

- [ ] **Step 1: Write the failing test**

`test/unit/workflow/gates.test.ts`:
```ts
import { afterEach, describe, expect, test } from "bun:test";
import { makeNaxConfig, makeTestStory } from "@test/helpers";
import { fullSuiteGateOp, lintCheckOp, typecheckCheckOp, verifyScopedOp } from "@/operations";
import { MAX_GATE_FINDINGS, runFullSuiteGate, runStoryGates } from "@/workflow/gates";
import { _workflowDeps, type StepContext } from "@/workflow/step-context";

const original = { ..._workflowDeps };
afterEach(() => Object.assign(_workflowDeps, original));

function sc(commands: Record<string, string> = { lint: "lint", typecheck: "tc" }): StepContext {
  return {
    story: makeTestStory({ id: "US-001" }),
    config: makeNaxConfig({ quality: { commands } }),
    workdir: "/repo",
    projectDir: "/repo",
    feature: "f",
    base: "abc",
    callCtx: {} as never,
  } as unknown as StepContext;
}

function fake(byOp: Record<string, unknown | (() => never)>) {
  _workflowDeps.callOp = (async (_ctx: unknown, op: { name: string }) => {
    const v = byOp[op.name];
    if (typeof v === "function") return (v as () => never)();
    return v;
  }) as typeof _workflowDeps.callOp;
}

const green = {
  [lintCheckOp.name]: { success: true, findings: [], durationMs: 1 },
  [typecheckCheckOp.name]: { success: true, findings: [], durationMs: 1 },
  [verifyScopedOp.name]: { success: true, status: "passed", findings: [], durationMs: 1, passCount: 3, isFullSuite: false },
};

describe("runStoryGates", () => {
  test("all green", async () => {
    fake(green);
    const r = await runStoryGates(sc());
    expect(r).toEqual({ red: false, states: { lint: "green", typecheck: "green", scoped: "green" }, findings: [] });
  });

  test("no lint/typecheck command -> skipped, not run", async () => {
    fake(green);
    const r = await runStoryGates(sc({}));
    expect(r.states).toEqual({ lint: "skipped", typecheck: "skipped", scoped: "green" });
  });

  test("lint findings become important gate findings", async () => {
    fake({
      ...green,
      [lintCheckOp.name]: { success: false, findings: [{ source: "lint", severity: "error", category: "style", file: "a.ts", line: 3, message: "no-var" }], durationMs: 1 },
    });
    const r = await runStoryGates(sc());
    expect(r.red).toBe(true);
    expect(r.findings).toEqual([{ kind: "gate", gate: "lint", severity: "important", file: "a.ts", line: 3, issue: "no-var" }]);
  });

  test("Review Focus 2: failure with no parsed findings, or a thrown gate, is still red", async () => {
    fake({
      ...green,
      [typecheckCheckOp.name]: { success: false, findings: [], durationMs: 1 },
      [verifyScopedOp.name]: () => {
        throw new Error("spawn ENOENT");
      },
    });
    const r = await runStoryGates(sc());
    expect(r.red).toBe(true);
    expect(r.states).toMatchObject({ typecheck: "red", scoped: "red" });
    expect(r.findings.map((f) => f.issue)).toEqual([
      "typecheck gate failed with no parsed findings",
      "scoped gate errored: spawn ENOENT",
    ]);
  });

  test("findings are capped with a summary line", async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ source: "lint", severity: "error", category: "x", message: `m${i}` }));
    fake({ ...green, [lintCheckOp.name]: { success: false, findings: many, durationMs: 1 } });
    const r = await runStoryGates(sc());
    expect(r.findings).toHaveLength(MAX_GATE_FINDINGS + 1);
    expect(r.findings.at(-1)?.issue).toBe("lint: 5 more findings not shown");
  });
});

describe("runFullSuiteGate", () => {
  test.each([
    ["passed", false, "green"],
    ["passed-on-timeout", false, "green"],
    ["skipped", false, "skipped"],
    ["failed", true, "red"],
    ["execution-failed", true, "red"],
    ["timeout", true, "red"],
    ["inconclusive", true, "red"],
  ])("status %s -> red=%s state=%s", async (status, red, state) => {
    fake({ [fullSuiteGateOp.name]: { success: !red, passed: !red, status, estimatedCostUsd: 0, findings: [], rawOutput: "" } });
    const r = await runFullSuiteGate(sc());
    expect(r.red).toBe(red as boolean);
    expect(r.states["full-suite"]).toBe(state as never);
    if (red) expect(r.findings.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test test/unit/workflow/gates.test.ts --timeout=60000`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`src/workflow/gates.ts`:
```ts
/**
 * Deterministic gates (spec §6 steps 3 and 6). A red gate, or a gate command that
 * errors, becomes a finding; nothing here judges code. W-R11: lint/typecheck/scoped
 * after each turn, the full suite once the loop closes.
 */
import { errorMessage } from "@nathapp/nax-agent/internal";
import type { Finding } from "@/findings";
import {
  type FullSuiteGateOutput,
  fullSuiteGateOp,
  lintCheckOp,
  type LintCheckOutput,
  typecheckCheckOp,
  verifyScopedOp,
  type VerifyScopedOutput,
} from "@/operations";
import { packageDirRelative } from "@/utils/paths";
import { _workflowDeps, type StepContext } from "./step-context";
import type { GateName, GateRunResult, GateState, WorkflowFindingDraft } from "./types";

export const MAX_GATE_FINDINGS = 25;

const SUITE_RED = new Set(["failed", "execution-failed", "timeout", "inconclusive"]);
const SUITE_SKIPPED = new Set(["skipped"]);

interface OneGate {
  readonly state: GateState;
  readonly findings: readonly WorkflowFindingDraft[];
}

function toDrafts(gate: GateName, findings: readonly Finding[]): WorkflowFindingDraft[] {
  const drafts = findings.slice(0, MAX_GATE_FINDINGS).map(
    (f): WorkflowFindingDraft => ({
      kind: "gate",
      gate,
      severity: "important",
      ...(f.file ? { file: f.file } : {}),
      ...(f.line !== undefined ? { line: f.line } : {}),
      issue: f.message,
    }),
  );
  const hidden = findings.length - drafts.length;
  return hidden > 0
    ? [...drafts, { kind: "gate", gate, severity: "important", issue: `${gate}: ${hidden} more findings not shown` }]
    : drafts;
}

function redWithoutDetail(gate: GateName, issue: string): OneGate {
  return { state: "red", findings: [{ kind: "gate", gate, severity: "important", issue }] };
}

async function guarded(gate: GateName, run: () => Promise<OneGate>): Promise<OneGate> {
  try {
    return await run();
  } catch (err) {
    return redWithoutDetail(gate, `${gate} gate errored: ${errorMessage(err)}`);
  }
}

function fromCheck(gate: GateName, out: LintCheckOutput): OneGate {
  if (out.success) return { state: out.status === "skipped" ? "skipped" : "green", findings: [] };
  return out.findings.length > 0
    ? { state: "red", findings: toDrafts(gate, out.findings) }
    : redWithoutDetail(gate, `${gate} gate failed with no parsed findings`);
}

function combine(entries: readonly (readonly [GateName, OneGate])[]): GateRunResult {
  const states: Partial<Record<GateName, GateState>> = {};
  for (const [name, g] of entries) states[name] = g.state;
  return {
    red: entries.some(([, g]) => g.state === "red"),
    states,
    findings: entries.flatMap(([, g]) => g.findings),
  };
}

export async function runStoryGates(sc: StepContext): Promise<GateRunResult> {
  const commands = sc.config.quality?.commands ?? {};
  const checkInput = { workdir: sc.workdir, storyId: sc.story.id, sessionScratchDir: sc.sessionScratchDir };
  const lint: OneGate = commands.lint
    ? await guarded("lint", async () => fromCheck("lint", await _workflowDeps.callOp(sc.callCtx, lintCheckOp, checkInput)))
    : { state: "skipped", findings: [] };
  const typecheck: OneGate = commands.typecheck
    ? await guarded("typecheck", async () =>
        fromCheck("typecheck", await _workflowDeps.callOp(sc.callCtx, typecheckCheckOp, checkInput)),
      )
    : { state: "skipped", findings: [] };
  const scoped = await guarded("scoped", async () => {
    const out: VerifyScopedOutput = await _workflowDeps.callOp(sc.callCtx, verifyScopedOp, {
      workdir: sc.workdir,
      storyId: sc.story.id,
      storyGitRef: sc.base,
      naxIgnoreIndex: sc.naxIgnoreIndex,
      regressionMode: "deferred",
      repoRoot: sc.projectDir,
      packagePrefix: packageDirRelative(sc.projectDir, sc.workdir),
      resolvedTestPatterns: sc.resolvedTestPatterns,
      sessionScratchDir: sc.sessionScratchDir,
    });
    if (out.status === "passed") return { state: "green", findings: [] };
    if (out.status === "skipped") return { state: "skipped", findings: [] };
    return out.findings.length > 0
      ? { state: "red", findings: toDrafts("scoped", out.findings) }
      : redWithoutDetail("scoped", `scoped gate ${out.status} with no parsed findings`);
  });
  return combine([
    ["lint", lint],
    ["typecheck", typecheck],
    ["scoped", scoped],
  ]);
}

export async function runFullSuiteGate(sc: StepContext): Promise<GateRunResult> {
  const suite = await guarded("full-suite", async () => {
    const out: FullSuiteGateOutput = await _workflowDeps.callOp(sc.callCtx, fullSuiteGateOp, {
      story: sc.story,
      workdir: sc.workdir,
      featureName: sc.feature,
      projectDir: sc.projectDir,
      executionMode: "sequential",
      resolvedTestPatterns: sc.resolvedTestPatterns,
    });
    if (SUITE_SKIPPED.has(out.status)) return { state: "skipped", findings: [] };
    if (!SUITE_RED.has(out.status)) return { state: "green", findings: [] };
    return out.findings.length > 0
      ? { state: "red", findings: toDrafts("full-suite", out.findings) }
      : redWithoutDetail("full-suite", `full suite ${out.status} with no parsed failures`);
  });
  return combine([["full-suite", suite]]);
}
```
Confirm that `LintCheckOutput`, `VerifyScopedOutput`, `FullSuiteGateOutput` and `packageDirRelative` are exported where imported. Add the type exports to `src/operations/index.ts` if they're missing. The typecheck output has the same shape as lint, so `fromCheck` takes it (widen the parameter to `LintCheckOutput | TypecheckCheckOutput` if the types don't unify).

- [ ] **Step 4: Run to verify it passes**

Run: `bun test test/unit/workflow/gates.test.ts --timeout=60000`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/workflow/gates.ts src/operations/index.ts test/unit/workflow/gates.test.ts
git commit -m "feat(workflow): story gates and full-suite gate as findings"
```

---

### Task 8: Step functions — implement, fix round, story review, re-review

**Files:**
- Create: `src/workflow/sessions.ts`, `src/workflow/implement.ts`, `src/workflow/fix-round.ts`, `src/workflow/story-review.ts`, `src/workflow/re-review.ts`
- Test: `test/unit/workflow/implement.test.ts`, `test/unit/workflow/reviews.test.ts`

**Interfaces:**
- Consumes: Tasks 2–7.
- Produces:
  ```ts
  // implement.ts
  export type ImplementTurn =
    | { readonly kind: "implement" }
    | { readonly kind: "answer"; readonly text: string }
    | { readonly kind: "fix"; readonly round: number; readonly fresh: boolean; readonly stepUps: number;
        readonly findings: readonly WorkflowFinding[]; readonly uncommitted: readonly string[] };
  export interface ImplementOutcome { readonly reply?: ImplementerReply; readonly failure?: string; readonly autoCommitted: boolean }
  export async function runImplementerTurn(sc: StepContext, turn: ImplementTurn): Promise<ImplementOutcome>;
  // fix-round.ts
  export function fixModelFor(story: UserStory, tierOrder: readonly TierConfig[], stepUps: number): ConfiguredModel | undefined;
  // sessions.ts
  export async function closeImplementerSession(sessionManager: ISessionManager | undefined, storyId: string): Promise<void>;
  // story-review.ts / re-review.ts
  export type ReviewOutcome<V> = { readonly ran: true; readonly verdict: V } | { readonly ran: false; readonly why: string };
  export async function runStoryReview(sc: StepContext, concerns: readonly string[]): Promise<ReviewOutcome<StoryReviewVerdict>>;
  export async function runReReview(sc: StepContext, round: number, findings: readonly WorkflowFinding[], fixBase: string): Promise<ReviewOutcome<ReReviewVerdict>>;
  ```
  Rules:
  - A thrown error when `sc.runSignal?.aborted` is rethrown (abort stops the run). Any other thrown error becomes `failure` (implementer) or `{ ran: false }` (reviews).
  - An implementer reply that is not interrupted and has no failure → if `listUncommitted` is non-empty, `autoCommitIfDirty(projectDir, "workflow", "wf-implementer", storyId, undefined, sc.dryRun)` and `autoCommitted: true`.
  - A fresh fix turn calls `closeImplementerSession` first (P2-R5).
  - Timeouts: implement turn `workflow.timeouts.implementMs`; fix and answer turns `fixMs`; reviews `reviewMs`. Reviews run under `stepSignal(sc.runSignal, reviewMs)` passed as `callCtx.signal`. A review stopped by its own limit (limit aborted, run signal not) → `{ ran: false, why: "timeout" }`.

- [ ] **Step 1: Write the failing tests**

`test/unit/workflow/implement.test.ts`:
```ts
import { afterEach, describe, expect, test } from "bun:test";
import { makeTestStory } from "@test/helpers";
import { workflowImplementOp } from "@/operations";
import { fixModelFor } from "@/workflow/fix-round";
import { runImplementerTurn } from "@/workflow/implement";
import { _workflowDeps, type StepContext } from "@/workflow/step-context";

const original = { ..._workflowDeps };
afterEach(() => Object.assign(_workflowDeps, original));

const tiers = [
  { tier: "fast", attempts: 2 },
  { tier: "balanced", attempts: 2 },
  { tier: "powerful", attempts: 2 },
];
const routed = (modelTier: "fast" | "balanced" | "powerful", extra = {}) =>
  makeTestStory({ id: "US-001", routing: { complexity: "medium", modelTier, testStrategy: "tdd-simple", reasoning: "", ...extra } });

describe("fixModelFor", () => {
  test("warm rounds keep the routed model", () => {
    expect(fixModelFor(routed("fast"), tiers, 0)).toBeUndefined();
  });
  test("each step-up climbs one rung", () => {
    expect(fixModelFor(routed("fast"), tiers, 1)).toBe("balanced");
    expect(fixModelFor(routed("fast"), tiers, 2)).toBe("powerful");
  });
  test("last rung stays put", () => {
    expect(fixModelFor(routed("powerful"), tiers, 1)).toBeUndefined();
    expect(fixModelFor(routed("balanced"), tiers, 5)).toBe("powerful");
  });
  test("a profile pin stays on the pinned model", () => {
    expect(fixModelFor(routed("fast", { agent: "native", profileModelPin: "x/y" }), tiers, 2)).toBeUndefined();
  });
  test("agent-qualified ladders carry the agent", () => {
    const ladder = [
      { tier: "balanced", agent: "codex", attempts: 1 },
      { tier: "balanced", agent: "claude", attempts: 1 },
    ];
    expect(fixModelFor(routed("balanced", { agent: "codex" }), ladder, 1)).toEqual({ agent: "claude", model: "balanced" });
  });
});

function makeSc(over: Partial<StepContext> = {}): StepContext {
  return {
    story: routed("fast"),
    tierOrder: tiers,
    workflow: { timeouts: { implementMs: 111, fixMs: 222, reviewMs: 333 }, maxFixRounds: 5 },
    projectDir: "/repo",
    briefPath: "/b.md",
    reportPath: "/r.md",
    dryRun: false,
    callCtx: {},
    ...over,
  } as unknown as StepContext;
}

describe("runImplementerTurn", () => {
  test("implement turn: implementMs, routed model, auto-commit when dirty", async () => {
    const calls: { input: { timeoutMs: number; model?: unknown; prompt: string } }[] = [];
    let committed = false;
    _workflowDeps.callOp = (async (_c: unknown, op: { name: string }, input: never) => {
      expect(op.name).toBe(workflowImplementOp.name);
      calls.push({ input });
      return { status: "DONE", commits: [], testSummary: "ok", interrupted: false };
    }) as typeof _workflowDeps.callOp;
    _workflowDeps.git = async () => ({ stdout: " M src/a.ts\n", exitCode: 0 });
    _workflowDeps.autoCommitIfDirty = (async () => {
      committed = true;
    }) as typeof _workflowDeps.autoCommitIfDirty;
    const out = await runImplementerTurn(makeSc(), { kind: "implement" });
    expect(calls[0]?.input.timeoutMs).toBe(111);
    expect(calls[0]?.input.model).toBeUndefined();
    expect(calls[0]?.input.prompt).toContain("/b.md");
    expect(out.autoCommitted).toBe(true);
    expect(committed).toBe(true);
  });

  test("interrupted turn: no auto-commit, edits stay", async () => {
    let committed = false;
    _workflowDeps.callOp = (async () => ({ status: "DONE_WITH_CONCERNS", commits: [], testSummary: "", interrupted: true })) as typeof _workflowDeps.callOp;
    _workflowDeps.autoCommitIfDirty = (async () => {
      committed = true;
    }) as typeof _workflowDeps.autoCommitIfDirty;
    const out = await runImplementerTurn(makeSc(), { kind: "implement" });
    expect(out.reply?.interrupted).toBe(true);
    expect(committed).toBe(false);
  });

  test("fresh fix turn: closes the warm session first, stepped-up model, fixMs, uncommitted files in prompt", async () => {
    const order: string[] = [];
    const sessionManager = {
      getForStory: () => [{ role: "wf-implementer", handle: "h1", state: "RUNNING" }],
      getLiveHandle: () => ({ id: "live" }),
      closeSession: async () => {
        order.push("close");
      },
    };
    let seen: { timeoutMs: number; model?: unknown; prompt: string } | undefined;
    _workflowDeps.callOp = (async (_c: unknown, _op: unknown, input: never) => {
      order.push("call");
      seen = input;
      return { status: "DONE", commits: [], testSummary: "", interrupted: false };
    }) as typeof _workflowDeps.callOp;
    _workflowDeps.git = async () => ({ stdout: "", exitCode: 0 });
    await runImplementerTurn(makeSc({ sessionManager: sessionManager as never }), {
      kind: "fix",
      round: 4,
      fresh: true,
      stepUps: 1,
      findings: [{ id: "F1", kind: "spec", severity: "important", issue: "x" }],
      uncommitted: ["src/half.ts"],
    });
    expect(order).toEqual(["close", "call"]);
    expect(seen?.timeoutMs).toBe(222);
    expect(seen?.model).toBe("balanced");
    expect(seen?.prompt).toContain("src/half.ts");
    expect(seen?.prompt).toContain("you own it now");
  });

  test("session failure becomes a failure string; abort rethrows", async () => {
    _workflowDeps.callOp = (async () => {
      throw new Error("auth expired");
    }) as typeof _workflowDeps.callOp;
    expect((await runImplementerTurn(makeSc(), { kind: "implement" })).failure).toBe("auth expired");
    const ac = new AbortController();
    ac.abort();
    await expect(runImplementerTurn(makeSc({ runSignal: ac.signal }), { kind: "implement" })).rejects.toThrow("auth expired");
  });
});
```

`test/unit/workflow/reviews.test.ts`:
```ts
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir, makeTestStory } from "@test/helpers";
import { workflowReReviewOp, workflowStoryReviewOp } from "@/operations";
import { runReReview } from "@/workflow/re-review";
import { _workflowDeps, type StepContext } from "@/workflow/step-context";
import { runStoryReview } from "@/workflow/story-review";

const original = { ..._workflowDeps };
const dirs: string[] = [];
afterEach(async () => {
  Object.assign(_workflowDeps, original);
  await Promise.all(dirs.map(cleanupTempDir));
  dirs.length = 0;
});

async function makeSc(): Promise<StepContext> {
  const storyDir = await makeTempDir("wf-review-");
  dirs.push(storyDir);
  _workflowDeps.git = async () => ({ stdout: "", exitCode: 0 });
  return {
    story: makeTestStory({ id: "US-001" }),
    workflow: { timeouts: { reviewMs: 60_000 } },
    projectDir: "/repo",
    storyDir,
    briefPath: "/b.md",
    reportPath: "/r.md",
    base: "base0",
    callCtx: {},
  } as unknown as StepContext;
}

describe("runStoryReview", () => {
  test("writes package-0.diff and review.json; returns the verdict", async () => {
    const sc = await makeSc();
    const verdict = { spec: "pass", quality: "approved", findings: [], cannotVerify: [] };
    _workflowDeps.callOp = (async (_c: unknown, op: { name: string }) => {
      expect(op.name).toBe(workflowStoryReviewOp.name);
      return verdict;
    }) as typeof _workflowDeps.callOp;
    const out = await runStoryReview(sc, []);
    expect(out).toEqual({ ran: true, verdict });
    expect(await Bun.file(join(sc.storyDir, "package-0.diff")).exists()).toBe(true);
    expect(await Bun.file(join(sc.storyDir, "review.json")).json()).toEqual(verdict);
  });

  test("unparseable reply (null) -> not run", async () => {
    const sc = await makeSc();
    _workflowDeps.callOp = (async () => null) as typeof _workflowDeps.callOp;
    expect(await runStoryReview(sc, [])).toEqual({ ran: false, why: "unparseable reply" });
  });

  test("thrown error -> not run with the message", async () => {
    const sc = await makeSc();
    _workflowDeps.callOp = (async () => {
      throw new Error("503");
    }) as typeof _workflowDeps.callOp;
    expect(await runStoryReview(sc, [])).toEqual({ ran: false, why: "503" });
  });
});

describe("runReReview", () => {
  test("scopes the package to fixBase and passes the open ids", async () => {
    const sc = await makeSc();
    const gitCalls: string[][] = [];
    _workflowDeps.git = async (args) => {
      gitCalls.push(args);
      return { stdout: "", exitCode: 0 };
    };
    let openIds: readonly string[] = [];
    _workflowDeps.callOp = (async (_c: unknown, op: { name: string }, input: { openIds: readonly string[] }) => {
      expect(op.name).toBe(workflowReReviewOp.name);
      openIds = input.openIds;
      return { verdicts: [], newFindings: [] };
    }) as typeof _workflowDeps.callOp;
    await runReReview(sc, 2, [{ id: "F3", kind: "quality", severity: "important", issue: "x" }], "fix-base");
    expect(openIds).toEqual(["F3"]);
    expect(gitCalls.some((a) => a.includes("fix-base..HEAD"))).toBe(true);
    expect(await Bun.file(join(sc.storyDir, "package-2.diff")).exists()).toBe(true);
    expect(await Bun.file(join(sc.storyDir, "rereview-2.json")).exists()).toBe(true);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test test/unit/workflow/implement.test.ts test/unit/workflow/reviews.test.ts --timeout=60000`
Expected: FAIL (modules not found).

- [ ] **Step 3: Implement**

`src/workflow/sessions.ts`:
```ts
/** Close the story's live wf-implementer session so the next turn really is fresh (spec §5.5, P2-R5). */
import { errorMessage } from "@nathapp/nax-agent/internal";
import { getLogger } from "@/logger";
import type { ISessionManager } from "@/session/types";

const LIVE_STATES = new Set(["RUNNING", "CREATED"]);

export async function closeImplementerSession(sessionManager: ISessionManager | undefined, storyId: string): Promise<void> {
  if (!sessionManager) return;
  for (const desc of sessionManager.getForStory(storyId)) {
    if (desc.role !== "wf-implementer" || !desc.handle || !LIVE_STATES.has(desc.state)) continue;
    const live = sessionManager.getLiveHandle(desc.handle);
    if (!live) continue;
    try {
      await sessionManager.closeSession(live);
    } catch (err) {
      getLogger().warn("workflow", "Failed to close wf-implementer session — continuing", {
        storyId,
        sessionName: desc.handle,
        error: errorMessage(err),
      });
    }
  }
}
```

`src/workflow/fix-round.ts`:
```ts
/** Model for a fix round (spec §4 "Implementer model"): warm rounds keep the routed model; each fresh round past the warm cap climbs one rung. */
import type { ConfiguredModel, ModelTier, TierConfig } from "@/config";
import { escalateTier } from "@/execution/escalation";
import type { UserStory } from "@/prd";

export function fixModelFor(
  story: UserStory,
  tierOrder: readonly TierConfig[],
  stepUps: number,
): ConfiguredModel | undefined {
  const routing = story.routing;
  if (stepUps <= 0 || !routing || routing.profileModelPin !== undefined) return undefined;
  // Same rule as tier-escalation.ts: match by (tier, agent) only on agent-qualified ladders.
  const hasAgentRungs = tierOrder.some((r) => r.agent !== undefined);
  let rung: { tier: string; agent?: string } = hasAgentRungs
    ? { tier: routing.modelTier, agent: routing.agent }
    : { tier: routing.modelTier };
  for (let i = 0; i < stepUps; i++) {
    const next = escalateTier(rung, [...tierOrder]);
    if (!next) break;
    rung = next;
  }
  if (rung.tier === routing.modelTier && (rung.agent ?? routing.agent) === routing.agent) return undefined;
  return rung.agent !== undefined ? { agent: rung.agent, model: rung.tier } : (rung.tier as ModelTier);
}
```
Check that `ModelTier` and `TierConfig` are exported from `@/config`. Import them from where they are.

`src/workflow/implement.ts`:
```ts
/** Implementer turns (spec §6 steps 2, 5): the first turn, fix rounds and advisor answers, all on workflowImplementOp. */
import { errorMessage } from "@nathapp/nax-agent/internal";
import { workflowImplementOp } from "@/operations";
import { buildWorkflowAnswerPrompt, buildWorkflowFixPrompt, buildWorkflowImplementPrompt } from "@/prompts";
import { fixModelFor } from "./fix-round";
import { listUncommitted } from "./git";
import { closeImplementerSession } from "./sessions";
import { _workflowDeps, type StepContext } from "./step-context";
import type { ImplementerReply, WorkflowFinding } from "./types";

export type ImplementTurn =
  | { readonly kind: "implement" }
  | { readonly kind: "answer"; readonly text: string }
  | {
      readonly kind: "fix";
      readonly round: number;
      readonly fresh: boolean;
      readonly stepUps: number;
      readonly findings: readonly WorkflowFinding[];
      readonly uncommitted: readonly string[];
    };

export interface ImplementOutcome {
  readonly reply?: ImplementerReply;
  readonly failure?: string;
  readonly autoCommitted: boolean;
}

function promptFor(sc: StepContext, turn: ImplementTurn): string {
  if (turn.kind === "implement") {
    return buildWorkflowImplementPrompt({ storyId: sc.story.id, briefPath: sc.briefPath, reportPath: sc.reportPath });
  }
  if (turn.kind === "answer") return buildWorkflowAnswerPrompt(turn.text);
  return buildWorkflowFixPrompt({
    mode: turn.fresh ? "fresh" : "warm",
    round: turn.round,
    maxRounds: sc.workflow.maxFixRounds,
    priorRounds: turn.round - 1,
    findings: turn.findings,
    briefPath: sc.briefPath,
    reportPath: sc.reportPath,
    uncommittedFiles: turn.uncommitted,
  });
}

export async function runImplementerTurn(sc: StepContext, turn: ImplementTurn): Promise<ImplementOutcome> {
  const isFix = turn.kind === "fix";
  if (isFix && turn.fresh) await closeImplementerSession(sc.sessionManager, sc.story.id);
  const model = isFix ? fixModelFor(sc.story, sc.tierOrder, turn.stepUps) : undefined;
  let reply: ImplementerReply;
  try {
    reply = await _workflowDeps.callOp(sc.callCtx, workflowImplementOp, {
      story: sc.story,
      prompt: promptFor(sc, turn),
      ...(model !== undefined ? { model } : {}),
      timeoutMs: turn.kind === "implement" ? sc.workflow.timeouts.implementMs : sc.workflow.timeouts.fixMs,
    });
  } catch (err) {
    if (sc.runSignal?.aborted) throw err;
    return { failure: errorMessage(err), autoCommitted: false };
  }
  if (reply.failure) return { reply, failure: reply.failure, autoCommitted: false };
  if (reply.interrupted) return { reply, autoCommitted: false };
  const dirty = await listUncommitted(sc.projectDir);
  if (dirty.length === 0) return { reply, autoCommitted: false };
  await _workflowDeps.autoCommitIfDirty(sc.projectDir, "workflow", "wf-implementer", sc.story.id, undefined, sc.dryRun);
  return { reply, autoCommitted: true };
}
```

`src/workflow/story-review.ts`:
```ts
/** Story review (spec §6 step 4): fresh session, BASE..HEAD package, review.json. Never throws except on abort. */
import { join } from "node:path";
import { errorMessage } from "@nathapp/nax-agent/internal";
import { workflowStoryReviewOp } from "@/operations";
import { buildWorkflowStoryReviewPrompt } from "@/prompts";
import { stepSignal } from "@/utils/step-signal";
import { writeReviewPackage } from "./git";
import { _workflowDeps, type StepContext } from "./step-context";
import type { StoryReviewVerdict } from "./types";

export type ReviewOutcome<V> = { readonly ran: true; readonly verdict: V } | { readonly ran: false; readonly why: string };

/** Runs one review op under the review step limit; shared with re-review.ts. */
export async function underReviewLimit<V>(sc: StepContext, run: (signal: AbortSignal | undefined) => Promise<V | null>): Promise<ReviewOutcome<V>> {
  const { signal, limit } = stepSignal(sc.runSignal, sc.workflow.timeouts.reviewMs);
  const stoppedHere = (): boolean => limit?.aborted === true && sc.runSignal?.aborted !== true;
  try {
    const verdict = await run(signal);
    if (stoppedHere()) return { ran: false, why: "timeout" };
    return verdict === null ? { ran: false, why: "unparseable reply" } : { ran: true, verdict };
  } catch (err) {
    if (sc.runSignal?.aborted) throw err;
    return { ran: false, why: stoppedHere() ? "timeout" : errorMessage(err) };
  }
}

export async function runStoryReview(sc: StepContext, concerns: readonly string[]): Promise<ReviewOutcome<StoryReviewVerdict>> {
  const packagePath = join(sc.storyDir, "package-0.diff");
  await writeReviewPackage(sc.projectDir, sc.base, packagePath);
  const prompt = buildWorkflowStoryReviewPrompt({ briefPath: sc.briefPath, reportPath: sc.reportPath, packagePath, concerns });
  const outcome = await underReviewLimit(sc, (signal) =>
    _workflowDeps.callOp({ ...sc.callCtx, ...(signal ? { signal } : {}) }, workflowStoryReviewOp, {
      prompt,
      timeoutMs: sc.workflow.timeouts.reviewMs,
    }),
  );
  if (outcome.ran) await Bun.write(join(sc.storyDir, "review.json"), `${JSON.stringify(outcome.verdict, null, 2)}\n`);
  return outcome;
}
```

`src/workflow/re-review.ts`:
```ts
/** Scoped re-review (spec §6 step 5): only FIX_BASE..HEAD, verdict per open finding, rereview-<R>.json. */
import { join } from "node:path";
import { workflowReReviewOp } from "@/operations";
import { buildWorkflowReReviewPrompt } from "@/prompts";
import { writeReviewPackage } from "./git";
import { _workflowDeps, type StepContext } from "./step-context";
import { type ReviewOutcome, underReviewLimit } from "./story-review";
import type { ReReviewVerdict, WorkflowFinding } from "./types";

export async function runReReview(
  sc: StepContext,
  round: number,
  findings: readonly WorkflowFinding[],
  fixBase: string,
): Promise<ReviewOutcome<ReReviewVerdict>> {
  const packagePath = join(sc.storyDir, `package-${round}.diff`);
  await writeReviewPackage(sc.projectDir, fixBase, packagePath);
  const prompt = buildWorkflowReReviewPrompt({ briefPath: sc.briefPath, reportPath: sc.reportPath, packagePath, findings });
  const outcome = await underReviewLimit(sc, (signal) =>
    _workflowDeps.callOp({ ...sc.callCtx, ...(signal ? { signal } : {}) }, workflowReReviewOp, {
      prompt,
      openIds: findings.map((f) => f.id),
      timeoutMs: sc.workflow.timeouts.reviewMs,
    }),
  );
  if (outcome.ran) {
    await Bun.write(join(sc.storyDir, `rereview-${round}.json`), `${JSON.stringify(outcome.verdict, null, 2)}\n`);
  }
  return outcome;
}
```

- [ ] **Step 4: Run them to verify they pass**

Run: `bun test test/unit/workflow/implement.test.ts test/unit/workflow/reviews.test.ts --timeout=60000`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/workflow test/unit/workflow
git commit -m "feat(workflow): implementer turns, fix-round model step-up, story review and re-review steps"
```

---

### Task 9: Advisor seam (stubbed), residual adjudication and end-state derivation

**Files:**
- Create: `src/workflow/advisor.ts`, `src/workflow/adjudicate.ts`, `src/workflow/close.ts`
- Test: `test/unit/workflow/adjudicate-close.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // advisor.ts — PR3 replaces defaultWorkflowAdvisor with the real kinds.
  export interface WorkflowAdvisor {
    answerQuestion(q: { storyId: string; status: "NEEDS_CONTEXT" | "BLOCKED"; concerns: string }): Promise<string | null>;
    ruleResidual(req: ResidualRequest): Promise<ResidualAnswer>;
  }
  export interface ResidualRequest { readonly storyId: string; readonly items: readonly WorkflowFinding[]; readonly redGates: readonly GateName[] }
  export interface ResidualAnswer { readonly rulings: readonly WorkflowRuling[]; readonly diagnoses: Readonly<Partial<Record<GateName, string>>> }
  export function defaultHold(finding: WorkflowFinding): WorkflowRuling;
  export const defaultWorkflowAdvisor: WorkflowAdvisor;
  // adjudicate.ts
  export async function adjudicateResidual(advisor: WorkflowAdvisor, req: ResidualRequest, ledger: (text: string) => Promise<void>): Promise<readonly WorkflowRuling[]>;
  // close.ts
  export function deriveEndState(input: { costStop: boolean; gates?: GateRunResult; suite?: GateRunResult; rulings: number }): { state: WorkflowEndState; reason: string };
  ```

- [ ] **Step 1: Write the failing test**

`test/unit/workflow/adjudicate-close.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { adjudicateResidual } from "@/workflow/adjudicate";
import { defaultWorkflowAdvisor, type WorkflowAdvisor } from "@/workflow/advisor";
import { deriveEndState } from "@/workflow/close";

const f = (id: string) => ({ id, kind: "quality" as const, severity: "important" as const, issue: `issue ${id}` });
const green = { red: false, states: {}, findings: [] };
const red = { red: true, states: { "full-suite": "red" as const }, findings: [] };

describe("adjudicateResidual", () => {
  test("stub advisor: hold every item, ledger one Ruling line each, gate line without diagnosis", async () => {
    const lines: string[] = [];
    const rulings = await adjudicateResidual(
      defaultWorkflowAdvisor,
      { storyId: "US-001", items: [f("F1"), f("F2")], redGates: ["full-suite"] },
      async (t) => {
        lines.push(t);
      },
    );
    expect(rulings.map((r) => [r.findingId, r.action, r.source])).toEqual([
      ["F1", "hold", "default"],
      ["F2", "hold", "default"],
    ]);
    expect(lines[0]).toStartWith("Ruling: hold F1");
    expect(lines.at(-1)).toBe("gate full-suite red at the cap (no diagnosis)");
  });

  test("advisor that throws or omits an item -> per-item default hold", async () => {
    const partial: WorkflowAdvisor = {
      answerQuestion: async () => null,
      ruleResidual: async () => ({
        rulings: [{ findingId: "F1", action: "waive", text: "reviewer wrong", why: "w", costIfWrong: "c", source: "advisor" }],
        diagnoses: { "full-suite": "flaky port" },
      }),
    };
    const lines: string[] = [];
    const rulings = await adjudicateResidual(partial, { storyId: "US-001", items: [f("F1"), f("F2")], redGates: ["full-suite"] }, async (t) => {
      lines.push(t);
    });
    expect(rulings.map((r) => r.action)).toEqual(["waive", "hold"]);
    expect(lines).toContain("gate full-suite red at the cap: flaky port");

    const throwing: WorkflowAdvisor = {
      answerQuestion: async () => null,
      ruleResidual: async () => {
        throw new Error("quota");
      },
    };
    expect((await adjudicateResidual(throwing, { storyId: "US-001", items: [f("F3")], redGates: [] }, async () => {})).map((r) => r.action)).toEqual(["hold"]);
  });

  test("stub never answers questions", async () => {
    expect(await defaultWorkflowAdvisor.answerQuestion({ storyId: "US-001", status: "BLOCKED", concerns: "x" })).toBeNull();
  });
});

describe("deriveEndState", () => {
  test.each([
    [{ costStop: false, gates: green, suite: green, rulings: 0 }, "complete"],
    [{ costStop: false, gates: green, suite: green, rulings: 2 }, "complete-with-rulings"],
    [{ costStop: false, gates: green, suite: red, rulings: 2 }, "complete-gate-open"],
    [{ costStop: false, gates: red, suite: undefined, rulings: 0 }, "complete-gate-open"],
    [{ costStop: true, gates: green, suite: green, rulings: 0 }, "complete-gate-open"],
  ])("%j -> %s", (input, state) => {
    expect(deriveEndState(input).state).toBe(state as never);
  });

  test("cost stop reason is cost-limit; red reason names the gates", () => {
    expect(deriveEndState({ costStop: true, rulings: 0 }).reason).toBe("cost-limit");
    expect(deriveEndState({ costStop: false, gates: green, suite: red, rulings: 0 }).reason).toBe("red: full-suite");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test test/unit/workflow/adjudicate-close.test.ts --timeout=60000`
Expected: FAIL (modules not found).

- [ ] **Step 3: Implement**

`src/workflow/advisor.ts`:
```ts
/**
 * The story loop's advisor seam (spec §8). PR2 ships the deterministic defaults only:
 * no answer to implementer questions, and `hold` for every residual item. PR3 wires the
 * real `implementer-question` and `residual` kinds behind this same interface.
 */
import type { GateName, WorkflowFinding, WorkflowRuling } from "./types";

export interface ResidualRequest {
  readonly storyId: string;
  readonly items: readonly WorkflowFinding[];
  readonly redGates: readonly GateName[];
}

export interface ResidualAnswer {
  readonly rulings: readonly WorkflowRuling[];
  readonly diagnoses: Readonly<Partial<Record<GateName, string>>>;
}

export interface WorkflowAdvisor {
  answerQuestion(q: { storyId: string; status: "NEEDS_CONTEXT" | "BLOCKED"; concerns: string }): Promise<string | null>;
  ruleResidual(req: ResidualRequest): Promise<ResidualAnswer>;
}

export function defaultHold(finding: WorkflowFinding): WorkflowRuling {
  return {
    findingId: finding.id,
    action: "hold",
    text: `hold ${finding.id}: ${finding.issue}`,
    why: "deterministic default (no advisor ruling)",
    costIfWrong: "the finding stays open for the branch review",
    source: "default",
  };
}

export const defaultWorkflowAdvisor: WorkflowAdvisor = {
  answerQuestion: async () => null,
  ruleResidual: async (req) => ({ rulings: req.items.map(defaultHold), diagnoses: {} }),
};
```

`src/workflow/adjudicate.ts`:
```ts
/** Cap adjudication (spec §6 step 7): one batched residual call per story; a missing or failed answer falls to hold. */
import { errorMessage } from "@nathapp/nax-agent/internal";
import { getLogger } from "@/logger";
import { defaultHold, type ResidualAnswer, type ResidualRequest, type WorkflowAdvisor } from "./advisor";
import { ledgerText } from "./ledger";
import type { WorkflowRuling } from "./types";

export async function adjudicateResidual(
  advisor: WorkflowAdvisor,
  req: ResidualRequest,
  ledger: (text: string) => Promise<void>,
): Promise<readonly WorkflowRuling[]> {
  let answer: ResidualAnswer = { rulings: [], diagnoses: {} };
  if (req.items.length > 0 || req.redGates.length > 0) {
    try {
      answer = await advisor.ruleResidual(req);
    } catch (err) {
      getLogger().warn("workflow", "Residual advisor call failed — default hold", {
        storyId: req.storyId,
        error: errorMessage(err),
      });
    }
  }
  const byId = new Map(answer.rulings.filter((r) => r.findingId).map((r) => [r.findingId as string, r]));
  const rulings = req.items.map((item) => byId.get(item.id) ?? defaultHold(item));
  for (const r of rulings) await ledger(ledgerText.ruling(r));
  for (const gate of req.redGates) {
    const diagnosis = answer.diagnoses[gate];
    await ledger(ledgerText.note(diagnosis ? `gate ${gate} red at the cap: ${diagnosis}` : `gate ${gate} red at the cap (no diagnosis)`));
  }
  return rulings;
}
```

`src/workflow/close.ts`:
```ts
/** End state (spec §6 step 8, W-R3). A red gate stays red; rulings never turn it green (D4). */
import type { GateName, GateRunResult, WorkflowEndState } from "./types";

function redGates(result: GateRunResult | undefined): GateName[] {
  if (!result) return [];
  return (Object.entries(result.states) as [GateName, string][]).filter(([, s]) => s === "red").map(([g]) => g);
}

export function deriveEndState(input: {
  costStop: boolean;
  gates?: GateRunResult;
  suite?: GateRunResult;
  rulings: number;
}): { state: WorkflowEndState; reason: string } {
  if (input.costStop) return { state: "complete-gate-open", reason: "cost-limit" };
  const red = [...redGates(input.gates), ...redGates(input.suite)];
  if (red.length > 0 || input.gates?.red || input.suite?.red) {
    return { state: "complete-gate-open", reason: `red: ${red.join(", ") || "gate"}` };
  }
  if (input.rulings > 0) return { state: "complete-with-rulings", reason: `${input.rulings} ruling(s)` };
  return { state: "complete", reason: "clean" };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test test/unit/workflow/adjudicate-close.test.ts --timeout=60000`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/workflow test/unit/workflow/adjudicate-close.test.ts
git commit -m "feat(workflow): advisor seam with deterministic defaults, residual adjudication, end states"
```

---

### Task 10: The story loop state machine

**Files:**
- Create: `src/workflow/story-loop.ts`
- Test: `test/unit/workflow/story-loop.test.ts` (split into `story-loop-resume.test.ts` if it nears 800 lines)

**Interfaces:**
- Consumes: Tasks 2, 8, 9 (types only from Task 8: `ImplementTurn`, `ImplementOutcome`, `ReviewOutcome`).
- Produces:
  ```ts
  export const WARM_ROUND_CAP = 3;
  export const MAX_IMPLEMENTER_QUESTIONS = 2;
  export interface StoryLoopSteps {
    implement(turn: ImplementTurn): Promise<ImplementOutcome>;
    gates(): Promise<GateRunResult>;
    fullSuite(): Promise<GateRunResult>;
    storyReview(concerns: readonly string[]): Promise<ReviewOutcome<StoryReviewVerdict>>;
    reReview(round: number, findings: readonly WorkflowFinding[], fixBase: string): Promise<ReviewOutcome<ReReviewVerdict>>;
    head(): Promise<string>;
    uncommitted(): Promise<string[]>;
    costExceeded(): boolean;
  }
  export interface StoryLoopSink {
    update(patch: Partial<WorkflowStoryRecord>): Promise<void>;
    ledger(text: string): Promise<void>;
  }
  export interface StoryLoopEnv {
    readonly storyId: string;
    readonly maxFixRounds: number;
    readonly steps: StoryLoopSteps;
    readonly advisor: WorkflowAdvisor;
    readonly sink: StoryLoopSink;
    /** A prior run's unfinished record (spec §10 resume); null for a fresh story. */
    readonly resume: WorkflowStoryRecord | null;
  }
  export interface StoryLoopOutcome {
    readonly state: WorkflowEndState;
    readonly reason: string;
    readonly rounds: number;
    readonly rulings: readonly WorkflowRuling[];
    readonly unreviewed: boolean;
  }
  export async function runStoryLoop(env: StoryLoopEnv): Promise<StoryLoopOutcome>;
  ```
  Behaviour (the spec §6 steps, in order):
  1. No resume: implement turn, then answer up to 2 `NEEDS_CONTEXT`/`BLOCKED` replies through `advisor.answerQuestion` (an answer becomes an `answer` turn; `null` attaches the concern). A failed implement adds a synthetic `session` finding. `DONE_WITH_CONCERNS` and interrupted replies attach their concern.
  2. Each iteration: stop if `costExceeded()`. Run gates. **Red** → open = gate findings + review findings still open (no review spent). **Green** → story review if not yet reviewed (not run → `review-skipped`, `unreviewed = true`, proceed), else a re-review of open review findings against `fixBase` (not run → `review-skipped`, findings stay open). Minors → `deferred-minor` lines. If nothing is open → full suite; green ends the loop clean, red opens its findings.
  3. Synthetic session findings from the last turn join the open list.
  4. `round >= maxFixRounds` → residual: a green-gate exit that has not run the suite in this iteration runs it once for the record; review and session items go to `adjudicateResidual`, red gates are listed.
  5. Otherwise `round += 1`, `fresh = round > warm || (resumed && first round after resume)`, `stepUps = max(0, round - warm)`, set `fixBase = head()` if it is unset and review findings are open, ledger `fix round R/max (...)`, run the fix turn with `uncommitted()` files.
  6. A re-review resets `fixBase` to unset. Ids are `F<n>` from `record.nextFindingId`, which persists.
  7. Close: `deriveEndState`, `sink.update({ state, reason, phase: "closed", endedAt })`, ledger `<state> (<rounds> round(s), <reason>[, unreviewed])`.

- [ ] **Step 1: Write the failing tests**

`test/unit/workflow/story-loop.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import type { ImplementTurn } from "@/workflow/implement";
import { defaultWorkflowAdvisor } from "@/workflow/advisor";
import { newStoryRecord } from "@/workflow/result";
import { runStoryLoop, type StoryLoopEnv, type StoryLoopSteps } from "@/workflow/story-loop";
import type { GateRunResult, StoryReviewVerdict, WorkflowStoryRecord } from "@/workflow/types";

const GREEN: GateRunResult = { red: false, states: { lint: "green", typecheck: "green", scoped: "green" }, findings: [] };
const SUITE_GREEN: GateRunResult = { red: false, states: { "full-suite": "green" }, findings: [] };
const SUITE_RED: GateRunResult = {
  red: true,
  states: { "full-suite": "red" },
  findings: [{ kind: "gate", gate: "full-suite", severity: "important", issue: "test x failed" }],
};
const RED_LINT: GateRunResult = {
  red: true,
  states: { lint: "red" },
  findings: [{ kind: "gate", gate: "lint", severity: "important", issue: "no-var" }],
};
const ok = { reply: { status: "DONE" as const, commits: [], testSummary: "", interrupted: false }, autoCommitted: false };
const pass: StoryReviewVerdict = { spec: "pass", quality: "approved", findings: [], cannotVerify: [] };
const failing = (n = 1): StoryReviewVerdict => ({
  spec: "fail",
  quality: "changes",
  findings: Array.from({ length: n }, (_, i) => ({ kind: "spec" as const, severity: "important" as const, issue: `gap ${i}` })),
  cannotVerify: [],
});

interface Script {
  gates?: GateRunResult[];
  suite?: GateRunResult[];
  review?: (StoryReviewVerdict | null)[];
  reReviewAllAddressed?: boolean[];
  implement?: (turn: ImplementTurn) => typeof ok | { failure: string; autoCommitted: false };
}

function harness(script: Script, over: Partial<StoryLoopEnv> = {}) {
  const turns: ImplementTurn[] = [];
  const ledger: string[] = [];
  let record: WorkflowStoryRecord = newStoryRecord("US-001", over.maxFixRounds ?? 5, "t");
  const gates = [...(script.gates ?? [])];
  const suites = [...(script.suite ?? [])];
  const reviews = [...(script.review ?? [])];
  const reReviews = [...(script.reReviewAllAddressed ?? [])];
  let headN = 0;
  const steps: StoryLoopSteps = {
    implement: async (turn) => {
      turns.push(turn);
      return script.implement ? script.implement(turn) : ok;
    },
    gates: async () => gates.shift() ?? GREEN,
    fullSuite: async () => suites.shift() ?? SUITE_GREEN,
    storyReview: async () => {
      const v = reviews.length > 0 ? reviews.shift() : pass;
      return v === null || v === undefined ? { ran: false, why: "unparseable reply" } : { ran: true, verdict: v };
    },
    reReview: async (_round, findings) => {
      const all = reReviews.shift() ?? true;
      return { ran: true, verdict: { verdicts: findings.map((f) => ({ id: f.id, addressed: all, note: "" })), newFindings: [] } };
    },
    head: async () => `h${++headN}`,
    uncommitted: async () => [],
    costExceeded: () => false,
  };
  const env: StoryLoopEnv = {
    storyId: "US-001",
    maxFixRounds: 5,
    steps,
    advisor: defaultWorkflowAdvisor,
    sink: {
      update: async (patch) => {
        record = { ...record, ...patch };
      },
      ledger: async (t) => {
        ledger.push(t);
      },
    },
    resume: null,
    ...over,
  };
  return { env, turns, ledger, record: () => record };
}

const fixTurns = (turns: ImplementTurn[]) => turns.filter((t): t is Extract<ImplementTurn, { kind: "fix" }> => t.kind === "fix");

describe("runStoryLoop", () => {
  test("clean story: implement, gates, review, suite -> complete, 0 rounds", async () => {
    const h = harness({});
    const out = await runStoryLoop(h.env);
    expect(out).toMatchObject({ state: "complete", rounds: 0 });
    expect(h.turns).toEqual([{ kind: "implement" }]);
    expect(h.ledger.at(-1)).toStartWith("complete (0 round(s)");
    expect(h.record().state).toBe("complete");
  });

  test("red gate goes to a fix round with no review spent", async () => {
    let reviews = 0;
    const h = harness({ gates: [RED_LINT, GREEN] });
    const original = h.env.steps.storyReview;
    h.env.steps.storyReview = async (c) => {
      reviews++;
      return original(c);
    };
    const out = await runStoryLoop(h.env);
    expect(out.rounds).toBe(1);
    expect(reviews).toBe(1); // only after the gate went green
    expect(fixTurns(h.turns)[0]?.findings.map((f) => f.kind)).toEqual(["gate"]);
  });

  test("review findings -> warm fix -> re-review addressed -> complete", async () => {
    const h = harness({ review: [failing(2)], reReviewAllAddressed: [true] });
    const out = await runStoryLoop(h.env);
    expect(out).toMatchObject({ state: "complete", rounds: 1 });
    const fix = fixTurns(h.turns)[0];
    expect(fix?.fresh).toBe(false);
    expect(fix?.findings.map((f) => f.id)).toEqual(["F1", "F2"]);
    expect(h.ledger).toContain("fix round 1/5 (2 open: F1, F2)");
  });

  test("minors are deferred and never start a round", async () => {
    const h = harness({
      review: [{ spec: "pass", quality: "approved", findings: [{ kind: "quality", severity: "minor", issue: "nit" }], cannotVerify: [] }],
    });
    const out = await runStoryLoop(h.env);
    expect(out.rounds).toBe(0);
    expect(h.ledger).toContain("deferred-minor: nit");
  });

  test.each([
    [1, [false], 1],
    [3, [false, false, false], 3],
    [5, [false, false, false, true, true], 5],
  ])("maxFixRounds=%d: fresh flags %j, then residual (Review Focus 4)", async (max, freshFlags, rounds) => {
    const h = harness({ review: [failing()], reReviewAllAddressed: Array(max).fill(false) }, { maxFixRounds: max });
    const out = await runStoryLoop(h.env);
    expect(fixTurns(h.turns).map((t) => t.fresh)).toEqual(freshFlags);
    expect(fixTurns(h.turns).map((t) => t.stepUps)).toEqual(freshFlags.map((_, i) => Math.max(0, i + 1 - Math.min(3, max))));
    expect(out).toMatchObject({ state: "complete-with-rulings", rounds });
    expect(h.ledger.some((l) => l.startsWith("Ruling: hold F1"))).toBe(true);
  });

  test("full suite red with rounds left loops; red at the cap -> gate-open", async () => {
    const h = harness({ suite: [SUITE_RED, SUITE_RED] }, { maxFixRounds: 1 });
    const out = await runStoryLoop(h.env);
    expect(out.state).toBe("complete-gate-open");
    expect(out.reason).toBe("red: full-suite");
    expect(fixTurns(h.turns)).toHaveLength(1);
  });

  test("residual at the cap with green gates runs the suite once for the record", async () => {
    let suiteRuns = 0;
    const h = harness({ review: [failing()], reReviewAllAddressed: [false] }, { maxFixRounds: 1 });
    h.env.steps.fullSuite = async () => {
      suiteRuns++;
      return SUITE_GREEN;
    };
    await runStoryLoop(h.env);
    expect(suiteRuns).toBe(1);
  });

  test("unparseable story review -> review-skipped, unreviewed, story proceeds", async () => {
    const h = harness({ review: [null] });
    const out = await runStoryLoop(h.env);
    expect(out).toMatchObject({ state: "complete", unreviewed: true });
    expect(h.ledger).toContain("review-skipped (story review: unparseable reply)");
  });

  test("implementer session failure -> synthetic finding in the next fix round", async () => {
    let first = true;
    const h = harness({
      implement: (turn) => {
        if (turn.kind === "implement" && first) {
          first = false;
          return { failure: "auth expired", autoCommitted: false };
        }
        return ok;
      },
    });
    const out = await runStoryLoop(h.env);
    expect(out.rounds).toBe(1);
    expect(fixTurns(h.turns)[0]?.findings[0]).toMatchObject({ kind: "session", issue: "implementer session failed: auth expired" });
  });

  test("NEEDS_CONTEXT with the stub advisor: no answer turn, concern reaches the review", async () => {
    let concernsSeen: readonly string[] = [];
    const h = harness({
      implement: () => ({ reply: { status: "NEEDS_CONTEXT", commits: [], testSummary: "", concerns: "Which DB?", interrupted: false }, autoCommitted: false }),
    });
    h.env.steps.storyReview = async (c) => {
      concernsSeen = c;
      return { ran: true, verdict: pass };
    };
    await runStoryLoop(h.env);
    expect(h.turns.filter((t) => t.kind === "answer")).toHaveLength(0);
    expect(concernsSeen).toEqual(["NEEDS_CONTEXT: Which DB?"]);
  });

  test("an advisor answer becomes an answer turn, at most twice", async () => {
    const h = harness({
      implement: () => ({ reply: { status: "BLOCKED", commits: [], testSummary: "", concerns: "stuck", interrupted: false }, autoCommitted: false }),
    });
    const advisor = { ...defaultWorkflowAdvisor, answerQuestion: async () => "try X" };
    await runStoryLoop({ ...h.env, advisor });
    expect(h.turns.filter((t) => t.kind === "answer")).toEqual([
      { kind: "answer", text: "try X" },
      { kind: "answer", text: "try X" },
    ]);
  });

  test("cost limit mid-story stops at the next step -> gate-open cost-limit", async () => {
    const h = harness({ review: [failing()] });
    let calls = 0;
    h.env.steps.costExceeded = () => ++calls > 1;
    const out = await runStoryLoop(h.env);
    expect(out).toMatchObject({ state: "complete-gate-open", reason: "cost-limit" });
  });

  test("resume (Review Focus 5): no implement, first round fresh on the same tier, ids continue", async () => {
    const prior: WorkflowStoryRecord = {
      ...newStoryRecord("US-001", 5, "t"),
      round: 1,
      phase: "rereview",
      reviewed: true,
      openFindings: [{ id: "F2", kind: "spec", severity: "important", issue: "gap" }],
      nextFindingId: 3,
    };
    const h = harness({ reReviewAllAddressed: [false, true] }, { resume: prior });
    const out = await runStoryLoop(h.env);
    expect(h.turns[0]).toMatchObject({ kind: "fix", round: 2, fresh: true, stepUps: 0 });
    expect(h.turns.some((t) => t.kind === "implement")).toBe(false);
    expect(fixTurns(h.turns)[1]).toMatchObject({ round: 3, fresh: false });
    expect(out.rounds).toBe(3);
  });

  test("new breakage from a re-review joins the open list with a fresh id", async () => {
    const h = harness({ review: [failing()] });
    let n = 0;
    h.env.steps.reReview = async (_r, findings) => {
      n++;
      return n === 1
        ? {
            ran: true,
            verdict: {
              verdicts: findings.map((f) => ({ id: f.id, addressed: true, note: "" })),
              newFindings: [{ kind: "quality", severity: "critical", issue: "broke parse" }],
            },
          }
        : { ran: true, verdict: { verdicts: findings.map((f) => ({ id: f.id, addressed: true, note: "" })), newFindings: [] } };
    };
    const out = await runStoryLoop(h.env);
    expect(fixTurns(h.turns)[1]?.findings.map((f) => f.id)).toEqual(["F2"]);
    expect(out.state).toBe("complete");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test test/unit/workflow/story-loop.test.ts --timeout=60000`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`src/workflow/story-loop.ts`:
```ts
/**
 * The story state machine (spec §6). Pure orchestration over injected steps:
 * no I/O of its own, so every branch is unit-testable. W-R3: it always returns
 * an end state; it never fails or pauses a story.
 */
import { adjudicateResidual } from "./adjudicate";
import type { WorkflowAdvisor } from "./advisor";
import { deriveEndState } from "./close";
import type { ImplementOutcome, ImplementTurn } from "./implement";
import { ledgerText } from "./ledger";
import type { ReviewOutcome } from "./story-review";
import type {
  GateName,
  GateRunResult,
  ReReviewVerdict,
  StoryReviewVerdict,
  WorkflowEndState,
  WorkflowFinding,
  WorkflowFindingDraft,
  WorkflowRuling,
  WorkflowStoryRecord,
} from "./types";

export const WARM_ROUND_CAP = 3;
export const MAX_IMPLEMENTER_QUESTIONS = 2;

// StoryLoopSteps, StoryLoopSink, StoryLoopEnv, StoryLoopOutcome exactly as in Interfaces.

const isBlocking = (f: WorkflowFindingDraft): boolean => f.severity !== "minor";

class LoopState {
  round: number;
  reviewed: boolean;
  unreviewed: boolean;
  nextId: number;
  reviewOpen: WorkflowFinding[];
  pendingSession: WorkflowFinding[] = [];
  concerns: string[] = [];
  questions = 0;
  deferredMinors: number;
  fixBase: string | undefined;
  gates: GateRunResult | undefined;
  suite: GateRunResult | undefined;
  suiteThisIteration = false;
  costStop = false;

  constructor(resume: WorkflowStoryRecord | null) {
    this.round = resume?.round ?? 0;
    this.reviewed = resume?.reviewed ?? false;
    this.unreviewed = resume?.unreviewed ?? false;
    this.nextId = resume?.nextFindingId ?? 1;
    this.deferredMinors = resume?.deferredMinors ?? 0;
    this.reviewOpen = (resume?.openFindings ?? []).filter((f) => f.kind === "spec" || f.kind === "quality");
  }

  assign(drafts: readonly WorkflowFindingDraft[]): WorkflowFinding[] {
    return drafts.map((d) => ({ ...d, id: `F${this.nextId++}` }));
  }
}

async function absorbTurn(env: StoryLoopEnv, s: LoopState, outcome: ImplementOutcome): Promise<void> {
  let current = outcome;
  for (;;) {
    if (current.failure) {
      s.pendingSession = [
        ...s.pendingSession,
        ...s.assign([{ kind: "session", severity: "important", issue: `implementer session failed: ${current.failure}` }]),
      ];
      return;
    }
    if (current.autoCommitted) await env.sink.ledger(ledgerText.note("auto-committed the implementer's uncommitted edits"));
    const reply = current.reply;
    if (!reply) return;
    const needsAnswer = reply.status === "NEEDS_CONTEXT" || reply.status === "BLOCKED";
    if (needsAnswer && s.questions < MAX_IMPLEMENTER_QUESTIONS) {
      s.questions += 1;
      const answer = await env.advisor.answerQuestion({
        storyId: env.storyId,
        status: reply.status as "NEEDS_CONTEXT" | "BLOCKED",
        concerns: reply.concerns ?? "",
      });
      if (answer !== null) {
        await env.sink.ledger(ledgerText.note(`implementer ${reply.status}: answered by the advisor`));
        current = await env.steps.implement({ kind: "answer", text: answer });
        continue;
      }
    }
    if (reply.status !== "DONE" || reply.interrupted) {
      s.concerns = [...s.concerns, `${reply.status}: ${reply.concerns ?? ""}`.trim()];
    }
    return;
  }
}

async function review(env: StoryLoopEnv, s: LoopState): Promise<void> {
  if (!s.reviewed) {
    const out: ReviewOutcome<StoryReviewVerdict> = await env.steps.storyReview(s.concerns);
    s.reviewed = true;
    if (!out.ran) {
      s.unreviewed = true;
      await env.sink.ledger(ledgerText.reviewSkipped(`story review: ${out.why}`));
      return;
    }
    for (const item of out.verdict.cannotVerify) await env.sink.ledger(ledgerText.note(`cannot-verify: ${item}`));
    await deferMinors(env, s, out.verdict.findings);
    s.reviewOpen = s.assign(out.verdict.findings.filter(isBlocking));
    return;
  }
  if (s.reviewOpen.length === 0 || s.fixBase === undefined) return;
  const out: ReviewOutcome<ReReviewVerdict> = await env.steps.reReview(s.round, s.reviewOpen, s.fixBase);
  s.fixBase = undefined;
  if (!out.ran) {
    await env.sink.ledger(ledgerText.reviewSkipped(`re-review round ${s.round}: ${out.why}`));
    return;
  }
  const stillOpen = new Set(out.verdict.verdicts.filter((v) => !v.addressed).map((v) => v.id));
  await deferMinors(env, s, out.verdict.newFindings);
  s.reviewOpen = [...s.reviewOpen.filter((f) => stillOpen.has(f.id)), ...s.assign(out.verdict.newFindings.filter(isBlocking))];
}

async function deferMinors(env: StoryLoopEnv, s: LoopState, drafts: readonly WorkflowFindingDraft[]): Promise<void> {
  for (const minor of drafts.filter((f) => !isBlocking(f))) {
    s.deferredMinors += 1;
    await env.sink.ledger(ledgerText.deferredMinor(minor.issue));
  }
}

/** One pass of gates -> review -> suite. Returns the open findings, or [] when the story is clean. */
async function evaluate(env: StoryLoopEnv, s: LoopState): Promise<WorkflowFinding[]> {
  s.suiteThisIteration = false;
  await env.sink.update({ phase: "gates" });
  s.gates = await env.steps.gates();
  await env.sink.update({ gates: { ...s.gates.states } });
  if (s.gates.red) return [...s.assign(s.gates.findings), ...s.reviewOpen];
  await env.sink.update({ phase: s.reviewed ? "rereview" : "review" });
  await review(env, s);
  if (s.reviewOpen.length > 0) return [...s.reviewOpen];
  await env.sink.update({ phase: "suite" });
  s.suite = await env.steps.fullSuite();
  s.suiteThisIteration = true;
  return s.suite.red ? s.assign(s.suite.findings) : [];
}

function redGateNames(s: LoopState): GateName[] {
  const states = { ...(s.gates?.states ?? {}), ...(s.suite?.states ?? {}) };
  return (Object.entries(states) as [GateName, string][]).filter(([, v]) => v === "red").map(([g]) => g);
}

export async function runStoryLoop(env: StoryLoopEnv): Promise<StoryLoopOutcome> {
  const s = new LoopState(env.resume);
  const warm = Math.min(WARM_ROUND_CAP, env.maxFixRounds);
  const resumed = env.resume !== null;
  let firstAfterResume = resumed;
  let rulings: readonly WorkflowRuling[] = [];

  if (!resumed) {
    await env.sink.update({ phase: "implement" });
    await absorbTurn(env, s, await env.steps.implement({ kind: "implement" }));
  }

  for (;;) {
    if (env.steps.costExceeded()) {
      s.costStop = true;
      break;
    }
    const open = [...(await evaluate(env, s)), ...s.pendingSession];
    s.pendingSession = [];
    await env.sink.update({ openFindings: open, reviewed: s.reviewed, unreviewed: s.unreviewed, nextFindingId: s.nextId, deferredMinors: s.deferredMinors });
    if (open.length === 0) break;
    if (s.round >= env.maxFixRounds) {
      await env.sink.update({ phase: "residual" });
      if (!s.gates?.red && !s.suiteThisIteration) s.suite = await env.steps.fullSuite();
      const items = open.filter((f) => f.kind !== "gate");
      rulings = await adjudicateResidual(env.advisor, { storyId: env.storyId, items, redGates: redGateNames(s) }, env.sink.ledger);
      break;
    }
    if (env.steps.costExceeded()) {
      s.costStop = true;
      break;
    }
    s.round += 1;
    const fresh = s.round > warm || firstAfterResume;
    firstAfterResume = false;
    if (s.reviewOpen.length > 0 && s.fixBase === undefined) s.fixBase = await env.steps.head();
    await env.sink.ledger(
      ledgerText.fixRound(s.round, env.maxFixRounds, `${open.length} open: ${open.map((f) => f.id).join(", ")}${fresh ? ", fresh" : ""}`),
    );
    await env.sink.update({ phase: "fix", round: s.round });
    const turn: ImplementTurn = {
      kind: "fix",
      round: s.round,
      fresh,
      stepUps: Math.max(0, s.round - warm),
      findings: open,
      uncommitted: await env.steps.uncommitted(),
    };
    await absorbTurn(env, s, await env.steps.implement(turn));
  }

  const end = deriveEndState({ costStop: s.costStop, gates: s.gates, suite: s.suite, rulings: rulings.length });
  return closeLoop(env, s, end.state, end.reason, rulings);
}

async function closeLoop(
  env: StoryLoopEnv,
  s: LoopState,
  state: WorkflowEndState,
  reason: string,
  rulings: readonly WorkflowRuling[],
): Promise<StoryLoopOutcome> {
  await env.sink.update({ state, reason, phase: "closed", rulings: rulings.length, endedAt: new Date().toISOString() });
  await env.sink.ledger(ledgerText.end(state, `${s.round} round(s), ${reason}${s.unreviewed ? ", unreviewed" : ""}`));
  return { state, reason, rounds: s.round, rulings, unreviewed: s.unreviewed };
}
```
The test's "clean story" expectation reads `complete (0 round(s), clean)`. Keep the format exactly as written so the ledger line matches.

- [ ] **Step 4: Run to verify it passes**

Run: `bun test test/unit/workflow/story-loop.test.ts --timeout=60000`
Expected: PASS. Then `wc -l src/workflow/story-loop.ts`: it must be under 600.

- [ ] **Step 5: Commit**

```bash
git add src/workflow/story-loop.ts test/unit/workflow/story-loop*.test.ts
git commit -m "feat(workflow): story loop state machine (warm/fresh rounds, shared cap, resume)"
```

---

### Task 11: `workflowStage`, the workflow pipeline and the iteration-runner swap

**Files:**
- Create: `src/workflow/call-context.ts`, `src/workflow/stage-env.ts`, `src/workflow/stage.ts`, `src/workflow/index.ts`
- Modify: `src/pipeline/stages/index.ts` (`getWorkflowPipeline` + lazy stage)
- Modify: `src/execution/iteration-runner.ts` (~:237, pick the pipeline)
- Modify: `src/execution/workflow-parallel.ts` (`assertPipelineMode`), `src/execution/parallel-worker.ts:92`, `src/execution/merge-conflict-rectify.ts:220` (guards)
- Test: `test/unit/workflow/stage.test.ts`, `test/unit/pipeline/workflow-pipeline.test.ts`, extend `test/unit/execution/workflow-parallel.test.ts`, `test/unit/execution/iteration-runner*.test.ts` (one new case)

**Interfaces:**
- Consumes: everything above.
- Produces:
  ```ts
  // call-context.ts
  export async function buildWorkflowCallContext(ctx: PipelineContext): Promise<{ callCtx: CallContext; dispose: () => Promise<void> }>;
  // stage-env.ts
  export async function buildStoryEnv(ctx: PipelineContext, callCtx: CallContext): Promise<{ sc: StepContext; env: StoryLoopEnv }>;
  // stage.ts
  export const workflowStage: PipelineStage;   // name "workflow"
  export const _workflowStageDeps: { buildWorkflowCallContext; buildStoryEnv; runStoryLoop; writeBrief };
  // pipeline/stages/index.ts
  export function getWorkflowPipeline(): PipelineStage[];   // [queueCheck, routing, constitution, context, workflow (lazy), completion]
  // execution/workflow-parallel.ts
  export function assertPipelineMode(config: NaxConfig, site: string): void;   // throws NaxError WORKFLOW_PARALLEL_UNREACHABLE
  ```

- [ ] **Step 1: Write the failing tests**

`test/unit/pipeline/workflow-pipeline.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { getDefaultPipeline, getWorkflowPipeline } from "@/pipeline/stages";

describe("getWorkflowPipeline", () => {
  test("swaps prompt, optimizer and execution for one workflow stage", () => {
    const names = getWorkflowPipeline().map((s) => s.name);
    const defaults = getDefaultPipeline().map((s) => s.name);
    expect(names).toEqual([defaults[0], defaults[1], defaults[2], defaults[3], "workflow", defaults.at(-1)]);
    expect(names).not.toContain("execution");
    expect(names).not.toContain("prompt");
  });

  test("is memoised", () => {
    expect(getWorkflowPipeline()).toBe(getWorkflowPipeline());
  });
});
```

`test/unit/workflow/stage.test.ts`:
```ts
import { afterEach, describe, expect, test } from "bun:test";
import { makeTestContext } from "@test/helpers";
import { _workflowStageDeps, workflowStage } from "@/workflow/stage";

const original = { ..._workflowStageDeps };
afterEach(() => Object.assign(_workflowStageDeps, original));

function wire(loop: () => Promise<unknown>) {
  let disposed = false;
  _workflowStageDeps.buildWorkflowCallContext = async () => ({
    callCtx: {} as never,
    dispose: async () => {
      disposed = true;
    },
  });
  _workflowStageDeps.buildStoryEnv = async () => ({ sc: {} as never, env: {} as never });
  _workflowStageDeps.writeBrief = async () => {};
  _workflowStageDeps.runStoryLoop = loop as typeof _workflowStageDeps.runStoryLoop;
  return () => disposed;
}

describe("workflowStage", () => {
  test("returns continue, sets agentResult, does not touch storyGitRef or mark the PRD", async () => {
    const disposed = wire(async () => ({ state: "complete-gate-open", reason: "red: lint", rounds: 5, rulings: [], unreviewed: false }));
    const ctx = makeTestContext({ storyGitRef: "base123" });
    const result = await workflowStage.execute(ctx);
    expect(result).toEqual({ action: "continue" });
    expect(ctx.agentResult?.success).toBe(true);
    expect(ctx.storyGitRef).toBe("base123");
    expect(ctx.prd.userStories.find((s) => s.id === ctx.story.id)?.status).not.toBe("passed");
    expect(disposed()).toBe(true);
  });

  test("an unexpected loop error still returns continue (W-R3)", async () => {
    wire(async () => {
      throw new Error("bug");
    });
    expect(await workflowStage.execute(makeTestContext())).toEqual({ action: "continue" });
  });

  test("abort propagates", async () => {
    wire(async () => {
      throw new Error("aborted");
    });
    const ac = new AbortController();
    ac.abort();
    await expect(workflowStage.execute(makeTestContext({ abortSignal: ac.signal }))).rejects.toThrow("aborted");
  });
});
```
Add to `test/unit/execution/workflow-parallel.test.ts`:
```ts
test("assertPipelineMode throws only in workflow mode", () => {
  expect(() => assertPipelineMode(makeNaxConfig({}), "parallel-worker")).not.toThrow();
  expect(() => assertPipelineMode(makeNaxConfig({ execution: { mode: "workflow" } }), "parallel-worker")).toThrow(
    /parallel-worker/,
  );
});
```
Add to the iteration-runner test file that already stubs `_iterationRunnerDeps.runPipeline` (find it with `grep -ln "_iterationRunnerDeps.runPipeline" test/unit/execution`). Add one case: with `execution.mode: "workflow"` in the root config, the stages passed to `runPipeline` include `"workflow"` and not `"execution"`. With the default config, they are `defaultPipeline`. Copy that file's existing setup for the context.

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test test/unit/pipeline/workflow-pipeline.test.ts test/unit/workflow/stage.test.ts test/unit/execution/workflow-parallel.test.ts --timeout=60000`
Expected: FAIL.

- [ ] **Step 3: Implement**

`src/pipeline/stages/index.ts`, after `defaultPipeline`:
```ts
/**
 * A5 workflow mode (spec §5.1): the prompt, optimizer and execution stages give way to
 * one workflow stage that builds its own prompts. Built lazily for the same TDZ reason
 * as the default pipeline. The stage body is a dynamic import, so src/workflow (which
 * imports operations) adds no load-time edge here (check:import-cycles).
 */
const lazyWorkflowStage: PipelineStage = {
  name: "workflow",
  enabled: () => true,
  async execute(ctx) {
    const { workflowStage } = await import("../../workflow");
    return workflowStage.execute(ctx);
  },
};

function buildWorkflowPipeline(): PipelineStage[] {
  return [queueCheckStage, routingStage, constitutionStage, contextStage, lazyWorkflowStage, completionStage];
}

let _workflowPipeline: PipelineStage[] | undefined;
export function getWorkflowPipeline(): PipelineStage[] {
  if (!_workflowPipeline) _workflowPipeline = buildWorkflowPipeline();
  return _workflowPipeline;
}
```
Export `getWorkflowPipeline` from `src/pipeline/index.ts` too if that barrel re-exports `getDefaultPipeline`.

`src/execution/iteration-runner.ts`: replace
```ts
  const { defaultPipeline } = await import("../pipeline/stages");
  const pipelineResult = await _iterationRunnerDeps.runPipeline(defaultPipeline, pipelineContext, ctx.eventEmitter);
```
with
```ts
  const stages = await import("../pipeline/stages");
  // A5: execution.mode is root-only, so the root config decides (spec §5.1).
  const pipeline = isWorkflowMode(ctx.config) ? stages.getWorkflowPipeline() : stages.defaultPipeline;
  const pipelineResult = await _iterationRunnerDeps.runPipeline(pipeline, pipelineContext, ctx.eventEmitter);
```
and add `isWorkflowMode` to the existing `../config` import.

`src/execution/workflow-parallel.ts`: add
```ts
/** Parallel paths are unreachable in workflow mode (normalisation forces parallel off). Reaching one is a bug. */
export function assertPipelineMode(config: NaxConfig, site: string): void {
  if (isWorkflowMode(config)) {
    throw new NaxError(`[${site}] parallel execution reached in workflow mode`, "WORKFLOW_PARALLEL_UNREACHABLE", {
      stage: "execution",
      site,
    });
  }
}
```
Call `assertPipelineMode(<the config in scope>, "parallel-worker")` immediately before `runPipeline(defaultPipeline, …)` in `parallel-worker.ts`, and `assertPipelineMode(<config>, "merge-conflict-rectify")` before the one in `merge-conflict-rectify.ts`. Use the root config each function already has in scope.

`src/workflow/call-context.ts`: the `CallContext` that `executionStage` builds (`src/pipeline/stages/execution.ts:116-192`), minus `acceptanceExecution`, `assembleStageBundle`, `contextToolRunCounter` and `phaseTelemetry`:
```ts
/** CallContext for workflow ops: the executionStage wiring that still applies (spec §5.2 "Approvals"). */
import { buildDispatchAskWiring, buildInteractionBridge, collectEffectiveRunStageModes } from "@/interaction";
import type { CallContext } from "@/operations/types";
import type { PipelineContext } from "@/pipeline/types";
import { storyPackageDir, storyWorkdir } from "@/utils/path-frame";
import { _workflowCallContextDeps } from "./call-context-deps";

export async function buildWorkflowCallContext(
  ctx: PipelineContext,
): Promise<{ callCtx: CallContext; dispose: () => Promise<void> }> {
  const packageView = ctx.packageView ?? ctx.runtime.packages.resolve(ctx.workdir);
  const interactionBridge = buildInteractionBridge(ctx.interaction, {
    featureName: ctx.prd.feature,
    storyId: ctx.story.id,
    stage: "execution",
  });
  const dispatchAsk = await buildDispatchAskWiring(
    {
      config: ctx.config,
      interaction: ctx.interaction,
      outputDir: ctx.runtime.outputDir,
      runId: ctx.runtime.runId,
      repoRoot: ctx.workdir,
      projectRoot: ctx.projectDir,
      featureName: ctx.prd.feature,
      storyId: ctx.story.id,
      abortSignal: ctx.abortSignal,
      stageModes: await collectEffectiveRunStageModes(
        {
          projectDir: ctx.projectDir,
          rootConfig: ctx.rootConfig,
          extraConfigs: [ctx.config],
          packageDirs: ctx.runStoryWorkdirs ?? ctx.stories.map(storyPackageDir),
        },
        _workflowCallContextDeps,
      ),
    },
    _workflowCallContextDeps,
  );
  const callCtx: CallContext = {
    runtime: ctx.runtime,
    packageView,
    packageDir: ctx.workdir,
    instructionDirectories: [...new Set(ctx.stories.map(storyWorkdir))],
    config: ctx.config,
    ...(ctx.contextBundle ? { contextBundle: ctx.contextBundle } : {}),
    ...(ctx.sessionScratchDir ? { storyScratchDirs: [ctx.sessionScratchDir] } : {}),
    agentName: ctx.routing.agent ?? ctx.agentManager?.getDefault() ?? "claude",
    storyId: ctx.story.id,
    featureName: ctx.prd.feature,
    story: ctx.story,
    ...(ctx.featureDir ? { featureDir: ctx.featureDir } : {}),
    ...(interactionBridge ? { interactionBridge } : {}),
    ...(dispatchAsk.askResolver ? { askResolver: dispatchAsk.askResolver } : {}),
    ...(dispatchAsk.commandShadow ? { commandShadow: dispatchAsk.commandShadow } : {}),
  };
  return { callCtx, dispose: () => dispatchAsk.dispose() };
}
```
`src/workflow/call-context-deps.ts` gives the `_deps` object these helpers need. Copy the keys `_executionDeps` passes (`stdinIsTTY`, `buildCommandShadow`, `createHumanAskLink`, `loadConfigForPackage`, `prepareApprovalsStore`) from `src/pipeline/stages/execution.ts:271-285`, importing each from where `execution.ts` imports it. If `CallContext` requires a field this omits (typecheck tells you), copy that field's line from `execution.ts`.

`src/workflow/stage-env.ts`:
```ts
/** Builds the StepContext and wires the real steps, sink and advisor into a StoryLoopEnv (Task 10's contract). */
import { join } from "node:path";
import { getLogger } from "@/logger";
import { resolveWorkflowConfig } from "@/config";
import type { CallContext } from "@/operations/types";
import type { PipelineContext } from "@/pipeline/types";
import { totalSpendUsd } from "@/runtime";
import { resolveTestFilePatterns } from "@/test-runners";
import { packageDirRelative } from "@/utils/paths";
import { defaultWorkflowAdvisor } from "./advisor";
import { listUncommitted, readHead } from "./git";
import { runFullSuiteGate, runStoryGates } from "./gates";
import { runImplementerTurn } from "./implement";
import { appendLedger, ensureLedger } from "./ledger";
import { workflowFeatureDir, workflowRunDir, workflowStoryDir } from "./paths";
import { runReReview } from "./re-review";
import { loadPriorStoryRecord, newStoryRecord, upsertStoryRecord } from "./result";
import { _workflowDeps, type StepContext } from "./step-context";
import type { StoryLoopEnv, StoryLoopSteps } from "./story-loop";
import { runStoryReview } from "./story-review";
import type { WorkflowStoryRecord } from "./types";

function timed<A extends unknown[], R>(
  name: string,
  add: (step: string, ms: number) => void,
  fn: (...args: A) => Promise<R>,
): (...args: A) => Promise<R> {
  return async (...args: A) => {
    const start = _workflowDeps.now();
    try {
      return await fn(...args);
    } finally {
      add(name, _workflowDeps.now() - start);
    }
  };
}

export async function buildStoryEnv(ctx: PipelineContext, callCtx: CallContext): Promise<{ sc: StepContext; env: StoryLoopEnv }> {
  const feature = ctx.prd.feature;
  const { outputDir, runId } = ctx.runtime;
  const runDir = workflowRunDir(outputDir, feature, runId);
  const storyDir = workflowStoryDir(runDir, ctx.story.id);
  const workflow = resolveWorkflowConfig(ctx.rootConfig);
  const base = ctx.storyGitRef ?? (await readHead(ctx.projectDir));
  const sc: StepContext = {
    callCtx,
    story: ctx.story,
    config: ctx.config,
    workflow,
    tierOrder: ctx.rootConfig.autoMode.escalation.tierOrder,
    feature,
    projectDir: ctx.projectDir,
    workdir: ctx.workdir,
    runDir,
    storyDir,
    briefPath: join(storyDir, "brief.md"),
    reportPath: join(storyDir, "report.md"),
    base,
    runSignal: ctx.abortSignal,
    sessionManager: ctx.sessionManager,
    dryRun: ctx.runtime.dryRun === true,
    sessionScratchDir: ctx.sessionScratchDir,
    naxIgnoreIndex: ctx.naxIgnoreIndex,
    resolvedTestPatterns: await resolveTestFilePatterns(ctx.config, ctx.projectDir, packageDirRelative(ctx.projectDir, ctx.workdir)),
    contextMarkdown: ctx.contextMarkdown,
    featureContextMarkdown: ctx.featureContextMarkdown,
    constitution: ctx.constitution?.content,
  };

  await ensureLedger(runDir, runId, feature);
  const prior = await loadPriorStoryRecord(workflowFeatureDir(outputDir, feature), runId, ctx.story.id);
  // A crash during the first implement turn leaves nothing to resume into: start the story over
  // (a new session sees the uncommitted edits in the tree). Mid-loop records resume (spec §10).
  const resume = prior && prior.phase !== "implement" ? prior : null;
  let record: WorkflowStoryRecord = resume
    ? { ...resume, maxRounds: workflow.maxFixRounds }
    : newStoryRecord(ctx.story.id, workflow.maxFixRounds, new Date().toISOString());
  const header = { runId, feature };
  await upsertStoryRecord(runDir, header, record);
  if (resume) {
    await appendLedger(runDir, ctx.story.id, `resumed at round ${resume.round} (prior record, warm session gone)`);
    getLogger().info("workflow", "Resuming story from a prior run", { storyId: ctx.story.id, round: resume.round });
  }

  const addTiming = (step: string, ms: number): void => {
    record = { ...record, timings: { ...record.timings, [step]: (record.timings[step] ?? 0) + ms } };
  };
  const costLimit = ctx.rootConfig.execution.costLimit;
  const steps: StoryLoopSteps = {
    implement: timed("implement", addTiming, (turn) => runImplementerTurn(sc, turn)),
    gates: timed("gates", addTiming, () => runStoryGates(sc)),
    fullSuite: timed("full-suite", addTiming, () => runFullSuiteGate(sc)),
    storyReview: timed("story-review", addTiming, (concerns) => runStoryReview(sc, concerns)),
    reReview: timed("re-review", addTiming, (round, findings, fixBase) => runReReview(sc, round, findings, fixBase)),
    head: () => readHead(sc.projectDir),
    uncommitted: () => listUncommitted(sc.projectDir),
    costExceeded: () =>
      typeof costLimit === "number" && costLimit > 0 && totalSpendUsd(ctx.runtime.costAggregator.snapshot()) >= costLimit,
  };
  const env: StoryLoopEnv = {
    storyId: ctx.story.id,
    maxFixRounds: workflow.maxFixRounds,
    steps,
    advisor: defaultWorkflowAdvisor,
    sink: {
      update: async (patch) => {
        record = { ...record, ...patch };
        await upsertStoryRecord(runDir, header, record);
      },
      ledger: (text) => appendLedger(runDir, ctx.story.id, text),
    },
    resume,
  };
  return { sc, env };
}
```
Check that `execution.costLimit` and `runtime.dryRun` exist under those names. `grep -n "costLimit" src/config/schemas-execution.ts` and `grep -n "dryRun" src/runtime/index.ts` tell you; use the real names.

`src/workflow/stage.ts`:
```ts
/**
 * workflowStage (spec §5.2): one story through the A5 loop. Sets ctx.agentResult only
 * (P2-R1). completionStage still marks the story passed. Always returns continue, except
 * when the run is aborted (W-R3).
 */
import { errorMessage } from "@nathapp/nax-agent/internal";
import { getLogger } from "@/logger";
import type { PipelineContext, PipelineStage, StageResult } from "@/pipeline/types";
import { writeBrief } from "./brief";
import { buildWorkflowCallContext } from "./call-context";
import { appendLedger } from "./ledger";
import { buildStoryEnv } from "./stage-env";
import { runStoryLoop } from "./story-loop";

export const _workflowStageDeps = { buildWorkflowCallContext, buildStoryEnv, runStoryLoop, writeBrief };

export const workflowStage: PipelineStage = {
  name: "workflow",
  enabled: () => true,

  async execute(ctx: PipelineContext): Promise<StageResult> {
    const logger = getLogger();
    const started = Date.now();
    let costUsd = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    const unsubscribe =
      ctx.runtime?.dispatchEvents?.onDispatch((event) => {
        costUsd += event.exactCostUsd ?? event.estimatedCostUsd ?? 0;
        inputTokens += event.tokenUsage?.inputTokens ?? 0;
        outputTokens += event.tokenUsage?.outputTokens ?? 0;
      }) ?? (() => {});
    const { callCtx, dispose } = await _workflowStageDeps.buildWorkflowCallContext(ctx);
    try {
      const { sc, env } = await _workflowStageDeps.buildStoryEnv(ctx, callCtx);
      if (!env.resume) await _workflowStageDeps.writeBrief(sc);
      const outcome = await _workflowStageDeps.runStoryLoop(env);
      logger.info("workflow", "Story closed", {
        storyId: ctx.story.id,
        state: outcome.state,
        reason: outcome.reason,
        rounds: outcome.rounds,
      });
    } catch (err) {
      if (ctx.abortSignal?.aborted) throw err;
      logger.error("workflow", "Workflow loop error — story closed gate-open", {
        storyId: ctx.story.id,
        error: errorMessage(err),
      });
      await appendLedgerSafe(ctx, `complete-gate-open (workflow error: ${errorMessage(err)})`);
    } finally {
      unsubscribe();
      await dispose();
    }
    ctx.agentResult = {
      success: true,
      estimatedCostUsd: costUsd,
      rateLimited: false,
      output: "",
      exitCode: 0,
      durationMs: Date.now() - started,
      tokenUsage: { inputTokens, outputTokens },
    };
    return { action: "continue" };
  },
};

async function appendLedgerSafe(ctx: PipelineContext, text: string): Promise<void> {
  try {
    await appendLedger(workflowRunDir(ctx.runtime.outputDir, ctx.prd.feature, ctx.runtime.runId), ctx.story.id, text);
  } catch {
    // the ledger is best-effort on the error path
  }
}
```
Add `import { workflowRunDir } from "./paths";` to the imports. The stage test uses `makeTestContext`, whose `runtime` may lack `outputDir`, so the safe path must swallow that. If `StageResult` / `AgentResult` / `TokenUsage` need fields this leaves out, copy them from `applyPostRunInspection` (`src/execution/post-run.ts:144-153`).

Before writing `stage.ts`, confirm that warm sessions close after each sequential story. Check `src/execution/unified-executor-dispatch-phases.ts:82` (`closeStorySessions`). If that path doesn't run after a sequential story, add `await closeImplementerSession(ctx.sessionManager, ctx.story.id)` in the `finally` above, and say so in your report.

`src/workflow/index.ts`:
```ts
export { workflowStage } from "./stage";
export type { WorkflowAdvisor } from "./advisor";
export { defaultWorkflowAdvisor } from "./advisor";
export type * from "./types";
```

- [ ] **Step 4: Run them to verify they pass**

Run: `bun test test/unit/pipeline/workflow-pipeline.test.ts test/unit/workflow/stage.test.ts test/unit/execution/workflow-parallel.test.ts <the iteration-runner test file> --timeout=60000 && bun run check:import-cycles && bun run typecheck`
Expected: PASS, with no new cyclic module.

- [ ] **Step 5: Commit**

```bash
git add src/workflow src/pipeline src/execution test/unit
git commit -m "feat(workflow): workflowStage, getWorkflowPipeline and the iteration-runner swap"
```

---

### Task 12: End-to-end story test, docs and CHANGELOG

**Files:**
- Create: `test/integration/workflow/story-e2e.test.ts`
- Modify: `packages/nax/CHANGELOG.md` (`## Unreleased` → `### Added`)
- Modify: `docs/superpowers/specs/2026-10-12-a5-workflow-mode-design.md`: add a §15 "PR2 plan rulings" table that copies P2-R1..R9 from this plan, and change §5.2's `storyGitRef` bullet to cite P2-R1

**Interfaces:**
- Consumes: everything above. The test drives `workflowStage.execute` against a real temp git repo. The only fake is `_workflowDeps.callOp`, dispatched by `op.name`.

- [ ] **Step 1: Write the failing test**

`test/integration/workflow/story-e2e.test.ts`:
```ts
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanupTempDir, makeNaxConfig, makeTempDir, makeTestContext } from "@test/helpers";
import {
  fullSuiteGateOp,
  verifyScopedOp,
  workflowImplementOp,
  workflowReReviewOp,
  workflowStoryReviewOp,
} from "@/operations";
import { _workflowDeps } from "@/workflow/step-context";
import { _workflowStageDeps, workflowStage } from "@/workflow/stage";

const originalDeps = { ..._workflowDeps };
const originalStage = { ..._workflowStageDeps };
const dirs: string[] = [];
afterEach(async () => {
  Object.assign(_workflowDeps, originalDeps);
  Object.assign(_workflowStageDeps, originalStage);
  await Promise.all(dirs.map(cleanupTempDir));
  dirs.length = 0;
});

async function sh(cwd: string, ...args: string[]): Promise<void> {
  const p = Bun.spawn(args, { cwd, stdout: "ignore", stderr: "ignore" });
  await p.exited;
}

async function setup() {
  const repo = await makeTempDir("wf-e2e-repo-");
  const out = await makeTempDir("wf-e2e-out-");
  dirs.push(repo, out);
  await sh(repo, "git", "init", "-q");
  await sh(repo, "git", "config", "user.email", "t@t");
  await sh(repo, "git", "config", "user.name", "t");
  await Bun.write(join(repo, "a.ts"), "export const a = 1;\n");
  await sh(repo, "git", "add", ".");
  await sh(repo, "git", "commit", "-qm", "seed");
  const config = makeNaxConfig({ execution: { mode: "workflow" }, quality: { commands: {} } });
  const ctx = makeTestContext({ config, rootConfig: config, workdir: repo, projectDir: repo });
  // runtime pieces the stage reads; makeTestContext's runtime may already carry them
  Object.assign(ctx.runtime, { outputDir: out, runId: "run-e2e" });
  _workflowStageDeps.buildWorkflowCallContext = async () => ({ callCtx: {} as never, dispose: async () => {} });
  return { repo, out, ctx };
}

function fakeAgent(repo: string, reviews: unknown[]) {
  const queue = [...reviews];
  const seen: string[] = [];
  _workflowDeps.callOp = (async (_c: unknown, op: { name: string }) => {
    seen.push(op.name);
    if (op.name === workflowImplementOp.name) {
      await Bun.write(join(repo, `impl-${seen.length}.ts`), "export const x = 1;\n");
      await sh(repo, "git", "add", ".");
      await sh(repo, "git", "commit", "-qm", "feat: work");
      return { status: "DONE", commits: [], testSummary: "1 pass", interrupted: false };
    }
    if (op.name === workflowStoryReviewOp.name) return queue.shift() ?? null;
    if (op.name === workflowReReviewOp.name) return { verdicts: [{ id: "F1", addressed: true, note: "" }], newFindings: [] };
    if (op.name === verifyScopedOp.name) return { success: true, status: "passed", findings: [], durationMs: 1, passCount: 1, isFullSuite: false };
    if (op.name === fullSuiteGateOp.name) return { success: true, passed: true, status: "passed", estimatedCostUsd: 0, findings: [], rawOutput: "" };
    throw new Error(`unexpected op ${op.name}`);
  }) as typeof _workflowDeps.callOp;
  return seen;
}

describe("workflow story end to end", () => {
  test("review finding -> one warm fix -> re-review -> complete; artifacts written", async () => {
    const { repo, out, ctx } = await setup();
    const seen = fakeAgent(repo, [
      { spec: "fail", quality: "approved", findings: [{ severity: "important", kind: "spec", acId: "AC-1", issue: "AC-1 untested" }], cannotVerify: [] },
    ]);
    const result = await workflowStage.execute(ctx);
    expect(result).toEqual({ action: "continue" });
    expect(seen.filter((n) => n === workflowImplementOp.name)).toHaveLength(2);
    const runDir = join(out, "workflow", ctx.prd.feature, "run-e2e");
    const storyDir = join(runDir, ctx.story.id);
    const ledger = await Bun.file(join(runDir, "ledger.md")).text();
    expect(ledger).toContain(`${ctx.story.id}: fix round 1/5 (1 open: F1)`);
    expect(ledger).toContain(`${ctx.story.id}: complete (1 round(s), clean)`);
    expect(await Bun.file(join(storyDir, "brief.md")).exists()).toBe(true);
    expect(await Bun.file(join(storyDir, "package-0.diff")).text()).toContain("feat: work");
    expect(await Bun.file(join(storyDir, "package-1.diff")).exists()).toBe(true);
    const resultFile = await Bun.file(join(runDir, "result.json")).json();
    expect(resultFile.stories[ctx.story.id]).toMatchObject({ state: "complete", round: 1, phase: "closed" });
    expect(ctx.agentResult?.success).toBe(true);
  });

  test("unparseable review twice over -> review-skipped, story still completes", async () => {
    const { repo, out, ctx } = await setup();
    fakeAgent(repo, [null]);
    await workflowStage.execute(ctx);
    const ledger = await Bun.file(join(out, "workflow", ctx.prd.feature, "run-e2e", "ledger.md")).text();
    expect(ledger).toContain("review-skipped (story review: unparseable reply)");
    expect(ledger).toContain("complete (0 round(s), clean, unreviewed)");
  });
});
```
If `makeTestContext`'s runtime is frozen or has no `costAggregator.snapshot`, build the context with `makeTestRuntime({ config, outputDir })` and pass it as `runtime`. Keep the assertions.

- [ ] **Step 2: Run to verify it fails, then passes**

Run: `bun test test/integration/workflow/story-e2e.test.ts --timeout=60000`
Expected now: PASS, since Tasks 1–11 are in. If it fails, the failure is a real integration defect: fix it in the owning file, not in the test.

- [ ] **Step 3: Docs and CHANGELOG**

`packages/nax/CHANGELOG.md`, under `## Unreleased` → `### Added`:
```
- Workflow mode story loop (A5 PR2): with `execution.mode: "workflow"`, each story runs one implementer
  (TDD with evidence), lint/typecheck/scoped gates, a story review, and up to `workflow.maxFixRounds`
  fix rounds (warm for the first three, then fresh one tier up) with scoped re-reviews, then the full
  suite. Stories always close as `complete`, `complete-with-rulings` or `complete-gate-open`. Writes
  `workflow/<feature>/<runId>/ledger.md`, `result.json` and per-story briefs, reports, reviews and diff
  packages, and resumes a story mid-loop after a crash. Advisor calls use their deterministic defaults
  until PR3.
```
Spec §15 table: copy the "Rulings on the spec" table from the top of this plan verbatim, under the heading `## 15. PR2 plan rulings (2026-10-12)`.

- [ ] **Step 4: Full gate**

Run, from `packages/nax`: `bun run typecheck && bun run check:all && bun run test:coverage`, then from the repo root: `bun run check:all`.
Expected: all green. Every new `src/workflow/*.ts` and `src/operations/workflow-*.ts` file needs coverage at or above the per-file floor. Add tests to the owning task's test file if one falls short.

- [ ] **Step 5: Commit**

```bash
git add test/integration/workflow packages/nax/CHANGELOG.md ../../docs/superpowers/specs/2026-10-12-a5-workflow-mode-design.md
git commit -m "test(workflow): story end-to-end; docs: PR2 rulings and changelog"
```
(Run from `packages/nax`, adjust the CHANGELOG path to `CHANGELOG.md`.)
