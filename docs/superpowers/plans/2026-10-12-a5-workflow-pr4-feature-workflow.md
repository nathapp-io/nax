# A5 Workflow Mode — PR4 Feature Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish workflow mode end to end. Run the advisor pre-flight once before the first story. After the last story, run one feature workflow: repo gates, one whole-branch review, one branch fix, one scoped re-review, adjudication, gates again, then push, CI wait, approval and a PR. Wire it into the run: executor, runner-completion, `RunResult.success` and `status.json`.

**Architecture:**
- The feature workflow is a **persisted state machine**, the feature-level twin of PR2's story loop:
  - `feature-machine.ts` is pure orchestration over injected steps. Every branch is unit-testable, the same pattern as `story-loop.ts`.
  - `feature.ts` (`runWorkflowFeature`) builds the context and the real steps, then drives the machine.
  - The machine's state is a `WorkflowFeatureRecord`, written into the current run's `result.json` after every step. A crash resumes at the next step (spec §10).
- Each step is one small file under `src/workflow/`:
  - `repo-gates.ts`, `branch-review.ts`, `branch-fix.ts`, `approval.ts`;
  - `finalize.ts` (publish), `pr-body.ts`, `ci-wait.ts`, `seed.ts`.
- Two new ops: `workflowBranchReviewOp` and `workflowBranchFixOp`. The re-review reuses `workflowReReviewOp` with a branch prompt. Adjudication reuses PR3's live advisor in a feature-scoped mode.
- Run wiring:
  - `unified-executor` calls `runWorkflowPreflight` once before the loop.
  - `runner-completion` delegates to `runWorkflowFeature` instead of `runFinishPhase` in workflow mode, through a new `execution/end-phase.ts`, so `runner-completion.ts` stays under 600 lines.
  - The result flows into `RunResult.success` and a `status.json` `workflow` block.

**Tech Stack:** TypeScript, Bun 1.4, bun:test.

**Spec:** `docs/superpowers/specs/2026-10-12-a5-workflow-mode-design.md` (rev 2). This plan covers §5.3, §7, §7.1, §9 (feature artifacts, `status.json` block, per-role tokens), §10 (feature resume) and §12 PR4. Read §15 and §16 for the PR2 and PR3 rulings it builds on.

**Plan series:**
1. PR1 foundations (nax#2475)
2. PR2 story loop (nax#2476)
3. PR3 advisor kinds (nax#2477)
4. **PR4 feature workflow (this plan)**

Then the billed A/B (spec §12), with approval at each launch.

## Rulings on the spec (made while planning, against the merged code)

| # | Ruling | Why |
|---|---|---|
| P4-R1 | **Persistence and resume.**<br>- The feature workflow's state is a `WorkflowFeatureRecord` under `feature` in the **current run's** `result.json`, rewritten after every step.<br>- On start, if the newest other run of the feature left an unfinished record, it is copied and resumed at its `step`.<br>- If that record is `done` and its `head` equals the current HEAD, the workflow is skipped (already finished) | Spec §10: "resumes at the first step missing from `result.json`". A re-run of a finished feature must not open a second review or rewrite the PR |
| P4-R2 | **Story states come from records across runs.**<br>- They are read from every run's `result.json` of the feature; the newest file wins per story.<br>- A story that is `passed` in prd.json but has no record counts as `complete` ("passed earlier, no workflow record").<br>- A story with no `complete*` record and not passed counts as `not-run` | A resumed or re-run feature spans run dirs. PR2's `result.json` is per run |
| P4-R3 | **Draft first.** The sequence is:<br>1. push;<br>2. open (or find) a draft PR;<br>3. CI wait on that PR;<br>4. approval;<br>5. promote it to ready or keep it as a draft, with the final body | `gh pr checks` and `glab mr view` need a PR or MR to exist. This is finish's D7 order, and it reuses `openDraftFinishPr` / `openOrPromotePr` unchanged |
| P4-R4 | **CI wait polling.** It keeps polling while the forge reports no checks yet (`gh`: empty stdout with "no checks reported"; `glab`: no head pipeline) or checks still running, until `ciWaitMs`, then returns `pending`. Unparseable output or a CLI error returns `pending` at once and is logged. `gh pr checks` exit codes are ignored when stdout has JSON (it exits 8 while checks are pending) | Checks register seconds after a push, so "no checks" on the first poll is normal, not an outcome. W-R9: a timeout is `pending`, never `failed` |
| P4-R5 | **Gates again** = `runQualityGates` again; its `test` gate is the repo's full suite. They re-run only when the branch fix ran (otherwise HEAD has not moved since step 1). A repo with no `quality.commands` is "nothing verified": a draft reason, not a red gate | `fullSuiteGateOp` is story-scoped. `runQualityGates` is the feature-level SSOT finish already uses |
| P4-R6 | Ready also requires that **the branch review ran**. A skipped branch review (no seed, unparseable reply, timeout) keeps the PR a draft | Conservative addition: otherwise unreviewed cross-story code could go ready. The spec's list is silent on a skipped review |
| P4-R7 | **What the fix, re-review and adjudication cover.**<br>- The branch fix gets: blocking review findings, fix-now minors, red repo gates, and gate-open stories (one finding each).<br>- The re-review judges only review findings and fix-now minors.<br>- Gates are judged by the final gates. Adjudication covers review findings still open after the re-review.<br>- An unaddressed fix-now minor becomes `leave`. Minor findings the branch review raises go to the PR body as `leave` | Mirrors the story loop: a re-review judges review findings, gates judge gates. Minors never start a fix pass (spec §6.5) |
| P4-R8 | A deferred minor the branch review doesn't triage is `leave` | Fail-safe: no unrequested edits |
| P4-R9 | The feature-scoped advisor (pre-flight, branch adjudication, approval) has **no heads-up channel** in PR4. A flagged ruling keeps the PR a draft and is listed in the PR body | `headsUpChannel` needs a `PipelineContext`; feature level has none. The PR body is the visible channel |
| P4-R10 | **Approval.** The deterministic preconditions are checked first, and the advisor (`finish-approval`) is asked only when all of them hold. The menu is approve / hold (`reReviewUsed: true`: there is no second pass). An advisor failure means draft (spec §8 default) | No LLM call for a PR that is a draft anyway. Spec §7.8 lists the advisor as one of the ready conditions |
| P4-R11 | **Skips and local-only.**<br>- A dry run, or an aborted run, skips the feature workflow entirely.<br>- A non-feature branch (`main`/`master`/empty) or no detected forge runs steps 1-6 and then ends `local-only`: no push, CI or PR.<br>- A push failure ends `local-only` with the reason | Finish's rules for when nax may push (`isFeatureBranch`, nax#1809). The review and fix still have value without a PR |
| P4-R12 | The `status.json` `workflow` block is updated in memory at each feature step and persisted by the existing post-finish status write in `runner-completion`. Live per-story progress stays in `result.json`. The "exit summary" is one `Workflow complete` log line with every story's state | The heartbeat is already stopped before finish. Adding mid-phase status writes would need new writer plumbing for no reader |
| P4-R13 | **Run result.**<br>- `RunnerCompletionResult` gains optional `workflowPassed`, and `RunResult.success` ANDs `workflowPassed !== false`.<br>- `passed` = no story is `complete-gate-open`/`not-run`, and the final gates have no failing gate.<br>- If the feature workflow throws, `workflowPassed` is `false` | Spec §7 "Run result". Optional, so existing completion fakes need no change |
| P4-R14 | **Pre-flight placement.** It runs in `executeUnified` after the (skipped) pre-run pipeline and before the loop, and it is fail-open. It covers stories not yet passed. If this run dir has no `preflight.json`, the newest **reusable** one from an earlier run of the feature is copied in first, so a resumed run doesn't re-ask | `runPreflight` reuses only its own run dir's file (PR3). Without the copy, every resume would append duplicate pre-flight decisions |
| P4-R15 | **Seed fallback order:**<br>1. `merge-base <origin default> HEAD`;<br>2. `merge-base main HEAD`;<br>3. the first story's persisted `storyGitRef` in prd.json.<br>With no seed at all, the branch review is skipped (ledger `review-skipped (no seed)`) | Spec §7.2 says to fall back to `main`. The persisted start ref (BUG-114) covers a repo with no `main` |
| P4-R16 | `runner-completion.ts` (589 lines) must stay ≤ 600. The finish call moves into a new `execution/end-phase.ts` together with its two helpers (`resolveBranch`, `finishStorySummary`), which branches to `runWorkflowFeature` in workflow mode | The file-size gate. Spec §5.3: runner-completion only gets delegates |
| P4-R17 | The spec §11 "prompt-audit and tool-audit rows for the new roles" check is left to the live smoke (billed). The audit middleware is role-generic and already covered; PR4 pins that each new op declares its role and tools | A real audit row needs a real agent session |
| P4-R18 | **Branch adjudication** uses PR3's live advisor with no `storyId`: request `storyId` `"_run"`, items with no `storyId`, no dependents (so no carry option), no red-gate diagnoses (a red repo gate means draft). Its ledger lines are `_run: Ruling: …` | One residual batch, as spec §7.5 says. Branch findings are not story-scoped |
| P4-R19 | PR3 carry-overs:<br>- M2: a pre-flight conflict with no known `storyIds` falls back to its AC's story, or is dropped with a warning.<br>- M5: `waivedSubject` falls back to `rulingTitle` / `anchorFile`.<br>- M6: `preflight.json` reuse checks each element's shape | The PR3 final review deferred them to PR4, where `preflight.json` gets its first reader |
| P4-R20 | The branch fix reuses the implementer's reply contract (`REPLY_CONTRACT`) and parser (`parseImplementerReply`). The soft-interrupt hop body moves from `workflowImplementOp` to a shared `softInterruptTurn` in `operations/_interrupt.ts` | One reply contract and one interrupt rule for every write turn. No verbatim duplicate of the hop body |
| P4-R21 | `workflowConfigSelector` gains `finish`, so the branch ops fall back to `finish.reviewers.quality` / `finish.reviewers.fix` (spec §4) | The op owns its model fallback, as `workflowStoryReviewOp` does |

## Global Constraints

- **Commands:**
  - Work in `packages/nax` and run commands from there. Never run bare `bun test` with no path, and never `bun run nax`.
  - Single test file: `timeout 60 bun test <path> --timeout=60000`.
  - Gate before push: package `bun run check:all` **and** repo-root `bun run check:all`, plus `bun run typecheck` and `bun run test:coverage`. Never `--update-baseline` on any ratchet.
- **Sizes and complexity:**
  - Source files ≤ 600 lines, test files ≤ 800 lines.
  - `runner-completion.ts` must end ≤ 600 lines (P4-R16).
  - `agents/manager.ts` and `session/manager.ts` must not grow.
  - Cognitive complexity ≤ 20 per function (`check:complexity`). Split a function before it gets there.
- **Imports and cycles:**
  - `src/workflow` may import `@/finish`, `@/forge`, `@/execution`, `@/advisor`, `@/operations`, `@/prompts` and `@/config` barrels.
  - Nothing outside `src/workflow` imports `@/workflow` statically. `pipeline/stages/index.ts`, `execution/unified-executor.ts` and `execution/end-phase.ts` use `await import("@/workflow")`.
  - `check:import-cycles` must not grow.
- **CallContext:** every literal with `runtime` + `packageView` + `agentName` must name `askResolver` and `commandShadow`, exactly as `finish/phase.ts` does (`check:bash-dispatch-ask`).
- **Pipeline mode is untouched.** With `execution.mode` absent or `"pipeline"`:
  - `runFinishPhase` runs exactly as today, with the same context;
  - pre-flight never runs;
  - `RunResult.success` is unchanged.
- **The ready gate (W-R3, D4).** nax never merges. A red gate stays red, and a PR is **ready** only when all of these hold:
  - every final gate is green and something was verified;
  - CI isn't `failed`;
  - no story is `complete-gate-open` or `not-run`;
  - no ruling is flagged;
  - the branch review ran;
  - the advisor approves.
- **Prompts and logging:** prompt text lives only in `src/prompts/builders/`, exported from `src/prompts/index.ts`. Every log call in `src/workflow/` and `src/execution/` carries `storyId` (a story id, or `"_run"`) as the **first** data key.
- **Tests:**
  - No `as never`, no `as unknown as`, no `@ts-` directives, and no new single `as` casts beyond the looseCast baseline.
  - No fixed sleeps: the CI wait takes an injected `sleep` and `now`.
  - Use `_deps` injection; no `mock.module()`.
  - Shared fakes go in `test/helpers/` and are exported from `@test/helpers`.
- **Style:**
  - Immutability: never mutate a record, finding, decision or config; build new objects.
  - Conventional commits (`feat:`, `test:`, `docs:`, `refactor:`). No emojis.

## Review Focus

1. **A branch with no commits past its seed, or no seed at all.** The branch review is skipped with a ledger line, the PR is a draft with the reason "branch review did not run", and nothing throws. Pinned in Task 1 (seed) and Task 10 (machine).
2. **`gh pr checks` reports "no checks reported" right after the push, or `gh` isn't installed.**
   - With no checks yet, it keeps polling until the limit, then returns `pending`.
   - A CLI error returns `pending` at once.
   - Neither is `failed`, and the PR still opens.
   Pinned in Task 2.
3. **A crash in the middle of the feature workflow, then a re-run.**
   - It resumes at the recorded step without repeating the branch review.
   - A second re-run at the same HEAD after `done` skips the whole workflow.
   Pinned in Task 5 and Task 10.
4. **A branch review reply that omits `minorTriage`, or names minor ids that don't exist.** Every real minor gets `leave`, and unknown ids are ignored. Pinned in Task 3.
5. **A push that fails, or a repo with no forge remote.** The outcome is `local-only` with the reason; the run result depends only on gates and story states, never on the forge. Pinned in Task 9.

## File map

| File | Status | Responsibility |
|---|---|---|
| `src/runtime/session-role.ts` | modify | register `wf-branch-review`, `wf-branch-fix` |
| `src/config/selectors.ts` | modify | `workflowConfigSelector` + `finish` |
| `src/workflow/seed.ts` | create | `resolveSeed` (P4-R15) |
| `src/workflow/ci-wait.ts` | create | `waitForChecks`, gh/glab classifiers (P4-R4) |
| `src/operations/_interrupt.ts` | modify | + `softInterruptTurn` (P4-R20) |
| `src/operations/workflow-branch-review.ts` | create | `workflowBranchReviewOp` |
| `src/operations/workflow-branch-fix.ts` | create | `workflowBranchFixOp` |
| `src/operations/workflow-replies.ts`, `workflow-types.ts` | modify | `parseBranchReviewReply`, `BranchReviewVerdict` |
| `src/prompts/builders/workflow-branch-builder.ts` | create | branch review, branch re-review, branch fix prompts |
| `src/advisor/batch-preflight.ts`, `src/advisor/format.ts` | modify | M2, M5 |
| `src/workflow/preflight.ts` | modify | M6 shape check, `adoptPriorPreflight` |
| `src/workflow/advisor-live.ts`, `advisor.ts`, `story-loop.ts`, `types.ts` | modify | feature-scoped residual, `needsHumanConfirm`, `isFlaggedRuling`, story `flagged` count |
| `src/workflow/feature-record.ts` | create | feature record types' helpers, `collectStoryRecords`, `loadPriorFeature`, `summariseStories` |
| `src/workflow/ledger-items.ts` | create | deferred minors / cannot-verify / parked rulings from every run's `ledger.md` |
| `src/workflow/result.ts` | modify | `upsertFeatureRecord`, `feature` key |
| `src/workflow/feature-context.ts` | create | `FeatureContext`, `buildFeatureContext` (feature-level `CallContext`) |
| `src/workflow/feature-deps.ts` | create | `_featureDeps` seam (forge, gates, push, PR) |
| `src/workflow/repo-gates.ts` | create | step 1 / step 6 |
| `src/workflow/branch-review.ts` | create | step 2 and step 4 |
| `src/workflow/branch-fix.ts` | create | step 3 |
| `src/workflow/approval.ts` | create | `readinessReasons`, `askApproval` (P4-R10) |
| `src/workflow/pr-body.ts` | create | `buildWorkflowPrBody` |
| `src/workflow/finalize.ts` | create | `publish`: push, draft PR, CI, approval, promote (P4-R3, P4-R11) |
| `src/workflow/feature-machine.ts` | create | the pure state machine |
| `src/workflow/feature.ts` | create | `runWorkflowFeature` |
| `src/workflow/preflight-run.ts` | create | `runWorkflowPreflight` (P4-R14) |
| `src/workflow/tokens.ts` | create | per-role token meter |
| `src/workflow/stage.ts`, `stage-env.ts` | modify | token meter, `tokensByRole` on story records |
| `src/workflow/index.ts` | modify | exports |
| `src/finish/pr/body.ts`, `src/finish/pr/index.ts`, `src/finish/index.ts` | modify | export the advisor section renderer and escapes |
| `src/execution/status-file.ts`, `status-writer.ts`, `index.ts` | modify | `workflow` block |
| `src/execution/end-phase.ts` | create | finish / workflow delegate (P4-R16) |
| `src/execution/runner-completion.ts`, `runner.ts`, `unified-executor.ts` | modify | delegates, `skipRegression`, `workflowPassed`, pre-flight placement |

---

### Task 1: Branch session roles, selector `finish`, and the seed helper

**Files:**
- Modify: `src/runtime/session-role.ts`; `src/config/selectors.ts`
- Modify: repo-root `.nax/rules/adapter-wiring.md` **and** repo-root `.claude/rules/adapter-wiring.md` (Rule 2 table, identically)
- Create: `src/workflow/seed.ts`
- Modify tests: `test/unit/runtime/workflow-session-roles.test.ts`, `test/unit/config/workflow-selector.test.ts`
- Create test: `test/unit/workflow/seed.test.ts`

**Interfaces:**
- Produces:
  - `SessionRole` gains `"wf-branch-review" | "wf-branch-fix"`.
  - `WorkflowOpConfig` gains the `finish` key.
  - `resolveSeed(projectDir: string, prd: PRD): Promise<string | null>` from `src/workflow/seed.ts`.

- [ ] **Step 1: Write the failing tests**

Replace the body of `test/unit/runtime/workflow-session-roles.test.ts` with:
```ts
import { describe, expect, test } from "bun:test";
import { isSessionRole, KNOWN_SESSION_ROLES } from "@/runtime/session-role";

describe("workflow session roles", () => {
  test.each(["wf-implementer", "wf-story-review", "wf-rereview", "wf-branch-review", "wf-branch-fix"])(
    "%s is a known role",
    (role) => {
      expect(KNOWN_SESSION_ROLES).toContain(role as (typeof KNOWN_SESSION_ROLES)[number]);
      expect(isSessionRole(role)).toBe(true);
    },
  );
});
```

In `test/unit/config/workflow-selector.test.ts`, change the expected key list and add one assertion:
```ts
    expect(Object.keys(slice).sort()).toEqual(
      ["agent", "autoMode", "execution", "finish", "models", "quality", "review", "workflow"].sort(),
    );
    expect(slice.workflow?.maxFixRounds).toBe(5);
    expect(slice.finish?.reviewers).toBeDefined();
```

`test/unit/workflow/seed.test.ts`:
```ts
import { afterEach, describe, expect, test } from "bun:test";
import { makeTestPRD, makeTestStory } from "@test/helpers";
import { resolveSeed } from "@/workflow/seed";
import { _workflowDeps } from "@/workflow/step-context";

const original = { ..._workflowDeps };
afterEach(() => Object.assign(_workflowDeps, original));

type GitReply = { stdout: string; exitCode: number };

/** Fake git: answers by the first two argv words; records every call. */
function fakeGit(replies: Record<string, GitReply>): string[][] {
  const calls: string[][] = [];
  _workflowDeps.git = async (args) => {
    calls.push(args);
    return replies[`${args[0]} ${args[1]}`] ?? { stdout: "", exitCode: 1 };
  };
  return calls;
}

const prd = makeTestPRD([makeTestStory({ id: "US-001" })]);

describe("resolveSeed", () => {
  test("merge-base against origin's default branch", async () => {
    const calls = fakeGit({
      "symbolic-ref refs/remotes/origin/HEAD": { stdout: "refs/remotes/origin/develop\n", exitCode: 0 },
      "merge-base refs/remotes/origin/develop": { stdout: "abc123\n", exitCode: 0 },
    });
    expect(await resolveSeed("/repo", prd)).toBe("abc123");
    expect(calls[1]).toEqual(["merge-base", "refs/remotes/origin/develop", "HEAD"]);
  });

  test("no origin HEAD -> merge-base against main", async () => {
    const calls = fakeGit({ "merge-base main": { stdout: "m1\n", exitCode: 0 } });
    expect(await resolveSeed("/repo", prd)).toBe("m1");
    expect(calls.at(-1)).toEqual(["merge-base", "main", "HEAD"]);
  });

  test("origin default has no merge-base -> tries main next", async () => {
    fakeGit({
      "symbolic-ref refs/remotes/origin/HEAD": { stdout: "refs/remotes/origin/trunk\n", exitCode: 0 },
      "merge-base main": { stdout: "m2\n", exitCode: 0 },
    });
    expect(await resolveSeed("/repo", prd)).toBe("m2");
  });

  test("no merge-base at all -> the first persisted story start ref", async () => {
    fakeGit({});
    const withRef = makeTestPRD([makeTestStory({ id: "US-001" }), makeTestStory({ id: "US-002", storyGitRef: "s2" })]);
    expect(await resolveSeed("/repo", withRef)).toBe("s2");
  });

  test("nothing at all -> null", async () => {
    fakeGit({});
    expect(await resolveSeed("/repo", prd)).toBeNull();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `timeout 60 bun test test/unit/runtime/workflow-session-roles.test.ts test/unit/config/workflow-selector.test.ts test/unit/workflow/seed.test.ts --timeout=60000`
Expected: FAIL. The two roles are unknown, the selector has no `finish`, and `@/workflow/seed` can't be resolved.

- [ ] **Step 3: Implement**

`src/runtime/session-role.ts`: change `| "wf-rereview";` to `| "wf-rereview"` and append:
```ts
  /** A5 — fresh, read-only whole-branch review (one per feature). */
  | "wf-branch-review"
  /** A5 — fresh, write-tool branch fix (exactly one pass). */
  | "wf-branch-fix";
```
Append `"wf-branch-review", "wf-branch-fix",` to `KNOWN_SESSION_ROLES` after `"wf-rereview",`.

In `.nax/rules/adapter-wiring.md` and `.claude/rules/adapter-wiring.md` (repo root), in the Rule 2 table, the `callOp` run-kind row ends `…, \`wf-implementer\`, \`wf-story-review\`, \`wf-rereview\`, \`wf-branch-review\`, \`wf-branch-fix\` | \`callOp\` run-kind |`. Then run `bun run check:rules-drift` from the repo root. It must pass.

`src/config/selectors.ts`: add `"finish",` as the last key of `workflowConfigSelector` (after `"models"`). Above the selector, add one comment line:
```ts
// `finish` supplies the branch-review / branch-fix model fallbacks (spec §4, P4-R21).
```

`src/workflow/seed.ts`:
```ts
/** The branch's seed (spec §7 step 2, P4-R15): where the feature branch left the default branch. */
import type { PRD } from "@/prd";
import { _workflowDeps } from "./step-context";

const ORIGIN_HEAD = "refs/remotes/origin/HEAD";
const ORIGIN_PREFIX = "refs/remotes/origin/";
const FALLBACK_BRANCH = "main";

async function originDefaultRef(projectDir: string): Promise<string | null> {
  const { stdout, exitCode } = await _workflowDeps.git(["symbolic-ref", ORIGIN_HEAD], projectDir);
  const ref = stdout.trim();
  return exitCode === 0 && ref.startsWith(ORIGIN_PREFIX) ? ref : null;
}

async function mergeBase(projectDir: string, ref: string): Promise<string | null> {
  const { stdout, exitCode } = await _workflowDeps.git(["merge-base", ref, "HEAD"], projectDir);
  const sha = stdout.trim();
  return exitCode === 0 && sha !== "" ? sha : null;
}

export async function resolveSeed(projectDir: string, prd: PRD): Promise<string | null> {
  const origin = await originDefaultRef(projectDir);
  const fromOrigin = origin ? await mergeBase(projectDir, origin) : null;
  if (fromOrigin) return fromOrigin;
  const fromMain = await mergeBase(projectDir, FALLBACK_BRANCH);
  if (fromMain) return fromMain;
  return prd.userStories.find((s) => s.storyGitRef)?.storyGitRef ?? null;
}
```

- [ ] **Step 4: Run them to verify they pass**

Run the Step 2 command. Expected: PASS.
Then run `timeout 120 bun test test/unit/operations test/unit/workflow --timeout=60000`. Expected: PASS. Nothing else reads the selector's key list.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/session-role.ts src/config/selectors.ts src/workflow/seed.ts test/unit/runtime/workflow-session-roles.test.ts test/unit/config/workflow-selector.test.ts test/unit/workflow/seed.test.ts ../../.nax/rules/adapter-wiring.md ../../.claude/rules/adapter-wiring.md
git commit -m "feat(workflow): branch session roles, finish in the workflow selector, seed helper"
```

---

### Task 2: CI wait

**Files:**
- Create: `src/workflow/ci-wait.ts`
- Test: `test/unit/workflow/ci-wait.test.ts`

**Interfaces:**
- Produces (from `src/workflow/ci-wait.ts`):
  ```ts
  export type CiWaitOutcome = "green" | "failed" | "pending";
  export interface CiWaitResult { readonly outcome: CiWaitOutcome; readonly detail: string }
  export const _ciWaitDeps: {
    run(cmd: string[], opts: { cwd: string }): Promise<ForgeRunResult>;
    sleep(ms: number): Promise<void>;
    now(): number;
  };
  export function waitForChecks(
    forge: ForgeKind,
    prRef: string,
    opts: { readonly cwd: string; readonly timeoutMs: number; readonly pollMs: number; readonly signal?: AbortSignal },
  ): Promise<CiWaitResult>;
  ```
  `prRef` is the branch name: both `gh pr checks <branch>` and `glab mr view <branch>` resolve the branch's PR/MR.

- [ ] **Step 1: Write the failing test**

`test/unit/workflow/ci-wait.test.ts`:
```ts
import { afterEach, describe, expect, test } from "bun:test";
import type { ForgeRunResult } from "@/forge";
import { _ciWaitDeps, waitForChecks } from "@/workflow/ci-wait";

const original = { ..._ciWaitDeps };
afterEach(() => Object.assign(_ciWaitDeps, original));

const OPTS = { cwd: "/repo", timeoutMs: 100, pollMs: 30 };
const r = (stdout: string, exitCode = 0, stderr = ""): ForgeRunResult => ({ stdout, stderr, exitCode });

/** Scripted forge: one reply per poll (the last repeats); a virtual clock advanced by sleep. */
function script(replies: (ForgeRunResult | Error)[]): { calls: string[][]; sleeps: number[] } {
  const calls: string[][] = [];
  const sleeps: number[] = [];
  let clock = 0;
  _ciWaitDeps.now = () => clock;
  _ciWaitDeps.sleep = async (ms) => {
    sleeps.push(ms);
    clock += ms;
  };
  _ciWaitDeps.run = async (cmd) => {
    calls.push(cmd);
    const next = replies.length > 1 ? replies.shift() : replies[0];
    if (next instanceof Error) throw next;
    if (!next) throw new Error("no reply scripted");
    return next;
  };
  return { calls, sleeps };
}

const gh = (buckets: string[]): ForgeRunResult =>
  r(JSON.stringify(buckets.map((bucket, i) => ({ name: `c${i}`, state: bucket.toUpperCase(), bucket }))), 8);

describe("waitForChecks (github)", () => {
  test("every check passes -> green, with the gh argv", async () => {
    const { calls } = script([gh(["pass", "skipping"])]);
    expect((await waitForChecks("github", "feat/x", OPTS)).outcome).toBe("green");
    expect(calls[0]).toEqual(["gh", "pr", "checks", "feat/x", "--json", "name,state,bucket"]);
  });

  test("any failed or cancelled check -> failed", async () => {
    script([gh(["pass", "fail"])]);
    expect((await waitForChecks("github", "b", OPTS)).outcome).toBe("failed");
    script([gh(["cancel"])]);
    expect((await waitForChecks("github", "b", OPTS)).outcome).toBe("failed");
  });

  test("pending, then green: keeps polling (exit 8 with JSON is not an error)", async () => {
    const { calls, sleeps } = script([gh(["pending"]), gh(["pass"])]);
    expect((await waitForChecks("github", "b", OPTS)).outcome).toBe("green");
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([30]);
  });

  test("no checks reported yet keeps polling; the limit returns pending (W-R9)", async () => {
    const { calls } = script([r("", 1, "no checks reported on the 'b' branch")]);
    const out = await waitForChecks("github", "b", OPTS);
    expect(out.outcome).toBe("pending");
    expect(out.detail).toContain("100ms");
    expect(calls.length).toBeGreaterThan(1);
  });

  test("a CLI error returns pending at once (P4-R4)", async () => {
    const { calls } = script([r("", 4, "gh: command failed: auth required")]);
    const out = await waitForChecks("github", "b", OPTS);
    expect(out).toEqual({ outcome: "pending", detail: "CI status unavailable: gh: command failed: auth required" });
    expect(calls).toHaveLength(1);
  });

  test("a spawn throw (gh not installed) returns pending", async () => {
    script([new Error("ENOENT: gh")]);
    expect((await waitForChecks("github", "b", OPTS)).outcome).toBe("pending");
  });

  test("unparseable stdout returns pending", async () => {
    script([r("not json")]);
    expect((await waitForChecks("github", "b", OPTS)).detail).toContain("unparseable");
  });

  test("an aborted signal returns pending without polling", async () => {
    const { calls } = script([gh(["pending"])]);
    const ac = new AbortController();
    ac.abort();
    expect((await waitForChecks("github", "b", { ...OPTS, signal: ac.signal })).outcome).toBe("pending");
    expect(calls).toHaveLength(0);
  });
});

describe("waitForChecks (gitlab)", () => {
  const mr = (status: string | null): ForgeRunResult =>
    r(JSON.stringify({ iid: 3, head_pipeline: status === null ? null : { status } }));

  test("success -> green, with the glab argv", async () => {
    const { calls } = script([mr("success")]);
    expect((await waitForChecks("gitlab", "feat/x", OPTS)).outcome).toBe("green");
    expect(calls[0]).toEqual(["glab", "mr", "view", "feat/x", "--output", "json"]);
  });

  test("failed and canceled -> failed", async () => {
    script([mr("failed")]);
    expect((await waitForChecks("gitlab", "b", OPTS)).outcome).toBe("failed");
    script([mr("canceled")]);
    expect((await waitForChecks("gitlab", "b", OPTS)).outcome).toBe("failed");
  });

  test("no head pipeline, then running, then success", async () => {
    script([mr(null), mr("running"), mr("success")]);
    expect((await waitForChecks("gitlab", "b", OPTS)).outcome).toBe("green");
  });

  test("glab error exit -> pending", async () => {
    script([r("", 1, "glab: not logged in")]);
    expect((await waitForChecks("gitlab", "b", OPTS)).outcome).toBe("pending");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `timeout 60 bun test test/unit/workflow/ci-wait.test.ts --timeout=60000`
Expected: FAIL (`@/workflow/ci-wait` can't be resolved).

- [ ] **Step 3: Implement `src/workflow/ci-wait.ts`**

```ts
/**
 * CI wait (spec §7.1, P4-R4). Polls the branch's PR/MR checks until they are green,
 * one fails, or `timeoutMs` passes. A timeout or a CLI error is `pending`, never
 * `failed` (W-R9). `_ciWaitDeps` is the test seam (spawn, sleep, clock).
 */
import { errorMessage } from "@nathapp/nax-agent/internal";
import { defaultForgeDeps, type ForgeKind, type ForgeRunResult } from "@/forge";
import { getSafeLogger } from "@/logger";

export type CiWaitOutcome = "green" | "failed" | "pending";

export interface CiWaitResult {
  readonly outcome: CiWaitOutcome;
  readonly detail: string;
}

export const _ciWaitDeps = {
  run: (cmd: string[], opts: { cwd: string }): Promise<ForgeRunResult> => defaultForgeDeps.run(cmd, opts),
  sleep: (ms: number): Promise<void> => Bun.sleep(ms),
  now: (): number => Date.now(),
};

type Poll = { readonly state: "green" | "failed" | "waiting" } | { readonly state: "error"; readonly detail: string };

const GH_FAILED = new Set(["fail", "cancel"]);
const GH_OK = new Set(["pass", "skipping"]);
const GL_FAILED = new Set(["failed", "canceled"]);
const NO_CHECKS = /no checks reported/i;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseJson(stdout: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(stdout) };
  } catch {
    return { ok: false };
  }
}

function cliError(r: ForgeRunResult): Poll {
  return { state: "error", detail: r.stderr.trim() || `exit ${r.exitCode}` };
}

function classifyGh(r: ForgeRunResult): Poll {
  const out = r.stdout.trim();
  if (out === "") return NO_CHECKS.test(r.stderr) ? { state: "waiting" } : cliError(r);
  const parsed = parseJson(out);
  if (!parsed.ok || !Array.isArray(parsed.value)) {
    return { state: "error", detail: `unparseable gh output: ${out.slice(0, 200)}` };
  }
  const buckets = parsed.value.map((c) => (isRecord(c) && typeof c.bucket === "string" ? c.bucket : "pending"));
  if (buckets.length === 0) return { state: "waiting" };
  if (buckets.some((b) => GH_FAILED.has(b))) return { state: "failed" };
  return buckets.every((b) => GH_OK.has(b)) ? { state: "green" } : { state: "waiting" };
}

function classifyGlab(r: ForgeRunResult): Poll {
  if (r.exitCode !== 0) return cliError(r);
  const parsed = parseJson(r.stdout.trim());
  if (!parsed.ok || !isRecord(parsed.value)) {
    return { state: "error", detail: `unparseable glab output: ${r.stdout.slice(0, 200)}` };
  }
  const pipeline = parsed.value.head_pipeline ?? parsed.value.pipeline;
  const status = isRecord(pipeline) && typeof pipeline.status === "string" ? pipeline.status : undefined;
  if (status === undefined) return { state: "waiting" };
  if (status === "success") return { state: "green" };
  return GL_FAILED.has(status) ? { state: "failed" } : { state: "waiting" };
}

function checksArgv(forge: ForgeKind, prRef: string): string[] {
  return forge === "github"
    ? ["gh", "pr", "checks", prRef, "--json", "name,state,bucket"]
    : ["glab", "mr", "view", prRef, "--output", "json"];
}

async function pollOnce(forge: ForgeKind, prRef: string, cwd: string): Promise<Poll> {
  try {
    const r = await _ciWaitDeps.run(checksArgv(forge, prRef), { cwd });
    return forge === "github" ? classifyGh(r) : classifyGlab(r);
  } catch (err) {
    return { state: "error", detail: errorMessage(err) };
  }
}

export async function waitForChecks(
  forge: ForgeKind,
  prRef: string,
  opts: { readonly cwd: string; readonly timeoutMs: number; readonly pollMs: number; readonly signal?: AbortSignal },
): Promise<CiWaitResult> {
  const deadline = _ciWaitDeps.now() + opts.timeoutMs;
  for (;;) {
    if (opts.signal?.aborted) return { outcome: "pending", detail: "aborted" };
    const poll = await pollOnce(forge, prRef, opts.cwd);
    if (poll.state === "green") return { outcome: "green", detail: "all checks passed" };
    if (poll.state === "failed") return { outcome: "failed", detail: "a check failed" };
    if (poll.state === "error") {
      getSafeLogger()?.warn("workflow", "CI status unavailable — treated as pending", {
        storyId: "_run",
        forge,
        error: poll.detail,
      });
      return { outcome: "pending", detail: `CI status unavailable: ${poll.detail}` };
    }
    if (_ciWaitDeps.now() + opts.pollMs > deadline) {
      return { outcome: "pending", detail: `no CI result within ${opts.timeoutMs}ms` };
    }
    await _ciWaitDeps.sleep(opts.pollMs);
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/workflow/ci-wait.ts test/unit/workflow/ci-wait.test.ts
git commit -m "feat(workflow): CI wait with gh/glab outcome mapping (timeout = pending)"
```

---
### Task 3: Branch ops, the branch review parser, and the branch prompts

**Files:**
- Modify: `src/operations/_interrupt.ts` (add `softInterruptTurn`), `src/operations/workflow-implement.ts` (use it; export `WORKFLOW_WRITE_TOOLS`)
- Modify: `src/operations/workflow-types.ts`, `src/operations/workflow-replies.ts`, `src/operations/index.ts`
- Create: `src/operations/workflow-branch-review.ts`, `src/operations/workflow-branch-fix.ts`
- Modify: `src/prompts/builders/workflow-implementer-builder.ts` (export the reply contract)
- Create: `src/prompts/builders/workflow-branch-builder.ts`; Modify: `src/prompts/index.ts`
- Test: `test/unit/operations/workflow-branch-review.test.ts`, `test/unit/operations/workflow-branch-fix.test.ts`, `test/unit/prompts/workflow-branch-builder.test.ts`; extend `test/unit/operations/workflow-replies.test.ts`

**Interfaces:**
- Consumes:
  - `WORKFLOW_REVIEW_TOOLS` and `WorkflowReviewInput` (operations);
  - `parseStoryReviewReply` and `parseImplementerReply`;
  - `renderWorkflowFindings` and `WorkflowPromptFinding` (prompts);
  - `workflowConfigSelector`, which now has `finish` (Task 1).
- Produces:
  ```ts
  // operations/workflow-types.ts
  export type MinorTriageDecision = "fix-now" | "leave";
  export interface BranchReviewVerdict extends StoryReviewVerdict {
    readonly minorTriage: readonly { readonly id: string; readonly decision: MinorTriageDecision }[];
  }
  // operations/workflow-replies.ts
  export function parseBranchReviewReply(output: string, minorIds: readonly string[]): BranchReviewVerdict | null;
  // operations/_interrupt.ts
  export function softInterruptTurn<I extends { readonly timeoutMs: number }>(prompt: string, ctx: HopBodyContext<I>): Promise<TurnResult>;
  // operations/workflow-implement.ts
  export const WORKFLOW_WRITE_TOOLS: readonly string[];
  // operations/workflow-branch-review.ts
  export interface WorkflowBranchReviewInput extends WorkflowReviewInput { readonly minorIds: readonly string[] }
  export const workflowBranchReviewOp: RunOperation<WorkflowBranchReviewInput, BranchReviewVerdict | null, WorkflowOpConfig>;
  // operations/workflow-branch-fix.ts
  export interface WorkflowBranchFixInput { readonly prompt: string; readonly model?: ConfiguredModel; readonly timeoutMs: number }
  export const workflowBranchFixOp: RunOperationWithHooks<WorkflowBranchFixInput, ImplementerReply, WorkflowOpConfig, "hopBody" | "recover">;
  // prompts (barrel)
  export const WORKFLOW_REPLY_CONTRACT: string;
  export interface BranchReviewPromptInput { … see Step 3 … }
  export function buildWorkflowBranchReviewPrompt(input: BranchReviewPromptInput): string;
  export function buildWorkflowBranchReReviewPrompt(input: { specPath?: string; reportPath: string; packagePath: string; findings: readonly WorkflowPromptFinding[] }): string;
  export function buildWorkflowBranchFixPrompt(input: { specPath?: string; prdPath: string; reportPath: string; findings: readonly WorkflowPromptFinding[] }): string;
  ```

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/operations/workflow-replies.test.ts` (add `parseBranchReviewReply` to its `@/operations` import):
```ts
describe("parseBranchReviewReply", () => {
  const base = { spec: "pass", quality: "approved", findings: [], cannotVerify: [] };

  test("keeps the story-review verdict and one triage entry per known minor id", () => {
    const out = parseBranchReviewReply(
      JSON.stringify({
        ...base,
        minorTriage: [
          { id: "M2", decision: "fix-now" },
          { id: "M1", decision: "leave" },
        ],
      }),
      ["M1", "M2", "M3"],
    );
    expect(out?.spec).toBe("pass");
    expect(out?.minorTriage).toEqual([
      { id: "M1", decision: "leave" },
      { id: "M2", decision: "fix-now" },
      { id: "M3", decision: "leave" },
    ]);
  });

  test("missing minorTriage, unknown ids, bad decisions and duplicates -> leave / ignored (P4-R8)", () => {
    const out = parseBranchReviewReply(
      JSON.stringify({
        ...base,
        minorTriage: [
          { id: "M9", decision: "fix-now" },
          { id: "M1", decision: "now!" },
          { id: "M1", decision: "fix-now" },
          { id: "M1", decision: "leave" },
        ],
      }),
      ["M1"],
    );
    expect(out?.minorTriage).toEqual([{ id: "M1", decision: "fix-now" }]);
    expect(parseBranchReviewReply(JSON.stringify(base), ["M1"])?.minorTriage).toEqual([{ id: "M1", decision: "leave" }]);
  });

  test("an invalid review shape is null", () => {
    expect(parseBranchReviewReply("nope", ["M1"])).toBeNull();
    expect(parseBranchReviewReply(JSON.stringify({ spec: "maybe" }), [])).toBeNull();
  });
});
```

`test/unit/operations/workflow-branch-review.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { makeNaxConfig, makeTestRuntime, opSelector } from "@test/helpers";
import { workflowConfigSelector } from "@/config";
import { type WorkflowBranchReviewInput, workflowBranchReviewOp } from "@/operations";

function buildCtx(overrides: Record<string, unknown> = {}) {
  const config = makeNaxConfig(overrides);
  const packageView = makeTestRuntime({ config }).packages.repo();
  return { packageView, config: packageView.select(opSelector(workflowConfigSelector)) };
}

const input: WorkflowBranchReviewInput = { prompt: "review the branch", timeoutMs: 1000, minorIds: ["M1"] };

function modelFor(i: WorkflowBranchReviewInput, overrides: Record<string, unknown>) {
  const m = workflowBranchReviewOp.model;
  return typeof m === "function" ? m(i, buildCtx(overrides)) : m;
}

describe("workflowBranchReviewOp", () => {
  test("shape: fresh wf-branch-review, stage review, read tools + Git only", () => {
    expect(workflowBranchReviewOp.session).toEqual({ role: "wf-branch-review", lifetime: "fresh" });
    expect(workflowBranchReviewOp.stage).toBe("review");
    expect(workflowBranchReviewOp.tools).toEqual(["Read", "Glob", "Grep", "Git"]);
    expect(workflowBranchReviewOp.build(input, buildCtx()).task.content).toBe("review the branch");
  });

  test("model: input, then workflow.models.branchReview, then finish.reviewers.quality (spec §4)", () => {
    expect(modelFor(input, { finish: { reviewers: { quality: "fast" } } })).toBe("fast");
    expect(
      modelFor(input, { finish: { reviewers: { quality: "fast" } }, workflow: { models: { branchReview: "powerful" } } }),
    ).toBe("powerful");
    expect(modelFor({ ...input, model: "balanced" }, { workflow: { models: { branchReview: "powerful" } } })).toBe(
      "balanced",
    );
  });

  test("parse triages the given minor ids", () => {
    const out = workflowBranchReviewOp.parse(
      JSON.stringify({ spec: "pass", quality: "approved", findings: [], cannotVerify: [] }),
      input,
      buildCtx(),
    );
    expect(out?.minorTriage).toEqual([{ id: "M1", decision: "leave" }]);
  });
});
```

`test/unit/operations/workflow-branch-fix.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { makeNaxConfig, makeTestRuntime, opSelector } from "@test/helpers";
import { SessionFailureError } from "@/agents";
import { workflowConfigSelector } from "@/config";
import type { AdapterFailure } from "@/context/engine";
import { WORKFLOW_INTERRUPT_MARKER, type WorkflowBranchFixInput, workflowBranchFixOp } from "@/operations";
import type { HopBodyContext } from "@/operations/types";

function buildCtx(overrides: Record<string, unknown> = {}) {
  const config = makeNaxConfig(overrides);
  const packageView = makeTestRuntime({ config }).packages.repo();
  return { packageView, config: packageView.select(opSelector(workflowConfigSelector)) };
}

const input: WorkflowBranchFixInput = { prompt: "fix B1", timeoutMs: 1 };
const interrupted: AdapterFailure = {
  category: "availability",
  outcome: "fail-stale",
  retriable: true,
  reason: "interrupted",
  message: "interrupted",
};

function modelFor(i: WorkflowBranchFixInput, overrides: Record<string, unknown>) {
  const m = workflowBranchFixOp.model;
  return typeof m === "function" ? m(i, buildCtx(overrides)) : m;
}

describe("workflowBranchFixOp", () => {
  test("shape: fresh wf-branch-fix, stage run, write tools, not kept open", () => {
    expect(workflowBranchFixOp.session).toEqual({ role: "wf-branch-fix", lifetime: "fresh" });
    expect(workflowBranchFixOp.stage).toBe("run");
    expect(workflowBranchFixOp.tools).toContain("Write");
    expect(workflowBranchFixOp.tools).toContain("Bash");
    expect(workflowBranchFixOp.keepOpen).toBeUndefined();
  });

  test("model: input, then workflow.models.branchFix, then finish.reviewers.fix", () => {
    expect(modelFor(input, { finish: { reviewers: { fix: "fast" } } })).toBe("fast");
    expect(modelFor(input, { finish: { reviewers: { fix: "fast" } }, workflow: { models: { branchFix: "powerful" } } })).toBe(
      "powerful",
    );
  });

  test("hopBody: an interrupted turn returns the marker (shared softInterruptTurn)", async () => {
    const send = async (_prompt: string, opts?: { interrupt?: AbortSignal }) => {
      await new Promise((resolve) => opts?.interrupt?.addEventListener("abort", resolve, { once: true }));
      throw new SessionFailureError("interrupted", interrupted);
    };
    const ctx: HopBodyContext<WorkflowBranchFixInput> = { send, sendWithParseRetry: send, input };
    expect((await workflowBranchFixOp.hopBody("go", ctx)).output).toBe(WORKFLOW_INTERRUPT_MARKER);
  });

  test("parse uses the implementer reply contract; an empty reply recovers to DONE_WITH_CONCERNS", async () => {
    const out = workflowBranchFixOp.parse(
      '```json\n{"status":"DONE","commits":["a1"],"testSummary":"3 pass"}\n```',
      input,
      buildCtx(),
    );
    expect(out.status).toBe("DONE");
    expect(out.commits).toEqual(["a1"]);
    expect((await workflowBranchFixOp.recover(input, buildCtx())).status).toBe("DONE_WITH_CONCERNS");
  });
});
```
Before running, read `workflowImplementOp.recover`'s signature in `src/operations/workflow-implement.ts` and `RunOperationWithHooks` in `src/operations/types.ts`. If `recover` takes a different second argument than the build context, call it the way `workflowImplementOp` is exercised in `test/unit/operations/workflow-ops.test.ts`, keeping the assertion.

`test/unit/prompts/workflow-branch-builder.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import {
  buildWorkflowBranchFixPrompt,
  buildWorkflowBranchReReviewPrompt,
  buildWorkflowBranchReviewPrompt,
  WORKFLOW_REPLY_CONTRACT,
} from "@/prompts";

const finding = { id: "B1", kind: "quality", severity: "important", issue: "US-2 never calls the US-1 lock" };

describe("buildWorkflowBranchReviewPrompt", () => {
  const prompt = buildWorkflowBranchReviewPrompt({
    specPath: ".nax/features/f/spec.md",
    prdPath: "/repo/.nax/features/f/prd.json",
    preflightPath: "/out/workflow/f/r1/preflight.json",
    packagePath: "/out/workflow/f/r1/package-branch.diff",
    stories: [
      { id: "US-001", state: "complete" },
      { id: "US-002", state: "complete-gate-open", note: "red: lint" },
      { id: "US-003", state: "not-run" },
    ],
    minors: [{ id: "M1", storyId: "US-001", text: "rename tmp var" }],
    parked: [{ storyId: "US-002", text: "hold F3: flaky timer" }],
    cannotVerify: [{ storyId: "US-001", text: "Redis TTL behaviour" }],
    gateFindings: [{ id: "B1", kind: "gate", severity: "important", issue: "repo gate lint failed" }],
  });

  test("names every input file", () => {
    for (const path of ["spec.md", "prd.json", "preflight.json", "package-branch.diff"]) expect(prompt).toContain(path);
  });

  test("lists story states, minors with ids, parked rulings, cannot-verify items and gate findings", () => {
    expect(prompt).toContain("- US-002: complete-gate-open (red: lint)");
    expect(prompt).toContain("- US-003: not-run");
    expect(prompt).toContain("[M1] US-001: rename tmp var");
    expect(prompt).toContain("US-002: hold F3: flaky timer");
    expect(prompt).toContain("US-001: Redis TTL behaviour");
    expect(prompt).toContain("[B1] [important/gate] repo gate lint failed");
  });

  test("states the remit, no per-function walk, and the reply shape with minorTriage", () => {
    expect(prompt).toContain("Cross-story integration");
    expect(prompt).toContain("Reachability");
    expect(prompt).toContain("Do not re-review each story line by line");
    expect(prompt).toContain('"minorTriage": [{"id": "M1", "decision": "fix-now|leave"}]');
  });

  test("empty sections read as none", () => {
    const empty = buildWorkflowBranchReviewPrompt({
      prdPath: "p",
      packagePath: "k",
      stories: [],
      minors: [],
      parked: [],
      cannotVerify: [],
      gateFindings: [],
    });
    expect(empty).toContain("(no spec file found)");
    expect(empty).toContain("(none)");
    expect(empty).not.toContain("preflight.json");
  });
});

describe("buildWorkflowBranchReReviewPrompt", () => {
  test("scopes to the fix diff and asks for a verdict per id", () => {
    const prompt = buildWorkflowBranchReReviewPrompt({
      reportPath: "/out/feature-report.md",
      packagePath: "/out/package-branch-fix.diff",
      findings: [finding],
    });
    expect(prompt).toContain("/out/package-branch-fix.diff");
    expect(prompt).toContain("[B1]");
    expect(prompt).toContain("ADDRESSED|NOT_ADDRESSED");
    expect(prompt).toContain("Do not re-review the rest of the branch");
  });
});

describe("buildWorkflowBranchFixPrompt", () => {
  test("one pass only, findings verbatim, report section, no sub-agents, the reply contract", () => {
    const prompt = buildWorkflowBranchFixPrompt({
      prdPath: "/repo/.nax/features/f/prd.json",
      reportPath: "/out/feature-report.md",
      findings: [finding],
    });
    expect(prompt).toContain("only fix pass");
    expect(prompt).toContain("[B1] [important/quality] US-2 never calls the US-1 lock");
    expect(prompt).toContain('append a "Branch fix" section to /out/feature-report.md');
    expect(prompt).toContain("Do not dispatch sub-agents");
    expect(prompt).toContain(WORKFLOW_REPLY_CONTRACT);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `timeout 60 bun test test/unit/operations/workflow-replies.test.ts test/unit/operations/workflow-branch-review.test.ts test/unit/operations/workflow-branch-fix.test.ts test/unit/prompts/workflow-branch-builder.test.ts --timeout=60000`
Expected: FAIL. None of the new exports exist.

- [ ] **Step 3: Implement**

`src/operations/workflow-types.ts`, append:
```ts
export type MinorTriageDecision = "fix-now" | "leave";

/** The whole-branch review (spec §7 step 2): the story-review verdict plus one triage per deferred minor. */
export interface BranchReviewVerdict extends StoryReviewVerdict {
  readonly minorTriage: readonly { readonly id: string; readonly decision: MinorTriageDecision }[];
}
```

`src/operations/workflow-replies.ts`: add `BranchReviewVerdict` and `MinorTriageDecision` to the type import, then append:
```ts
function triageOf(parsed: unknown): Map<string, MinorTriageDecision> {
  const triage = new Map<string, MinorTriageDecision>();
  if (!isRecord(parsed) || !Array.isArray(parsed.minorTriage)) return triage;
  for (const entry of parsed.minorTriage) {
    if (!isRecord(entry) || typeof entry.id !== "string" || triage.has(entry.id)) continue;
    if (entry.decision === "fix-now" || entry.decision === "leave") triage.set(entry.id, entry.decision);
  }
  return triage;
}

/** One triage entry per known minor id, in the given order; untriaged or unknown -> leave (P4-R8). */
export function parseBranchReviewReply(output: string, minorIds: readonly string[]): BranchReviewVerdict | null {
  const verdict = parseStoryReviewReply(output);
  if (!verdict) return null;
  const triage = triageOf(tryParseLLMJson<unknown>(output));
  return { ...verdict, minorTriage: minorIds.map((id) => ({ id, decision: triage.get(id) ?? "leave" })) };
}
```

`src/operations/_interrupt.ts`, append (and add the imports):
```ts
import type { TurnResult } from "@/agents/types";
import type { HopBodyContext } from "./types";
import { WORKFLOW_INTERRUPT_MARKER } from "./workflow-replies";

const EMPTY_TURN: TurnResult = {
  output: "",
  tokenUsage: { inputTokens: 0, outputTokens: 0 },
  estimatedCostUsd: 0,
  internalRoundTrips: 0,
};

/**
 * One write turn under a soft interrupt at the step limit (A5, P2-R4). An interrupted
 * turn leaves the session and its edits in place and comes back as the marker — never
 * rethrown, so the stale-retry never re-runs a stopped turn.
 */
export async function softInterruptTurn<I extends { readonly timeoutMs: number }>(
  prompt: string,
  ctx: HopBodyContext<I>,
): Promise<TurnResult> {
  const interrupt = AbortSignal.timeout(ctx.input.timeoutMs);
  try {
    return await ctx.send(prompt, { interrupt });
  } catch (err) {
    if (!interrupt.aborted || !isInterruptedStale(err)) throw err;
    return { ...EMPTY_TURN, output: WORKFLOW_INTERRUPT_MARKER };
  }
}
```

`src/operations/workflow-implement.ts`:
- Move the tools array to `export const WORKFLOW_WRITE_TOOLS = ["Read", "Glob", "Grep", "Write", "Edit", "Delete", "Git", "RunCommand", "GitCommit", "Exec", "Bash", "RequestCapability"] as const;` and set `tools: [...WORKFLOW_WRITE_TOOLS],`.
- Replace the whole `async hopBody(initialPrompt, ctx) { … }` with `hopBody: (initialPrompt, ctx) => softInterruptTurn(initialPrompt, ctx),`. Keep its doc comment above it.
- Delete the now-unused `EMPTY_TURN`, `TurnResult` and `isInterruptedStale` imports and add `import { softInterruptTurn } from "./_interrupt";`.

`check:op-tool-capability` reads tools through the barrel. Run it after this change, and if it can't see a spread const, keep the literal array in both ops instead.

`src/operations/workflow-branch-review.ts`:
```ts
/** A5 workflow mode: the one whole-branch review (spec §7 step 2). Fresh, read-only; one parse retry, then null. */
import { makeParseRetryStrategy } from "@/agents/retry";
import { workflowConfigSelector } from "@/config";
import type { WorkflowOpConfig } from "@/config/selectors";
import { buildWorkflowReviewJsonRetry, buildWorkflowReviewJsonRetryCondensed } from "@/prompts";
import { STEP_TIMEOUT_MARGIN_MS } from "@/utils/step-signal";
import type { RunOperation } from "./types";
import { parseBranchReviewReply } from "./workflow-replies";
import { WORKFLOW_REVIEW_TOOLS, type WorkflowReviewInput } from "./workflow-story-review";
import type { BranchReviewVerdict } from "./workflow-types";

export interface WorkflowBranchReviewInput extends WorkflowReviewInput {
  /** The deferred minors the reviewer must triage, in prompt order. */
  readonly minorIds: readonly string[];
}

export const workflowBranchReviewOp: RunOperation<
  WorkflowBranchReviewInput,
  BranchReviewVerdict | null,
  WorkflowOpConfig
> = {
  kind: "run",
  name: "workflow-branch-review",
  stage: "review",
  session: { role: "wf-branch-review", lifetime: "fresh" },
  config: workflowConfigSelector,
  tools: [...WORKFLOW_REVIEW_TOOLS],
  model: (input, ctx) =>
    input.model ?? ctx.config.workflow?.models?.branchReview ?? ctx.config.finish?.reviewers?.quality ?? undefined,
  timeoutMs: (input) => input.timeoutMs + STEP_TIMEOUT_MARGIN_MS,
  build(input) {
    return {
      role: { id: "role", content: "", overridable: false },
      task: { id: "task", content: input.prompt, overridable: false },
    };
  },
  parse: (output, input) => parseBranchReviewReply(output, input.minorIds),
  retry: (input) =>
    makeParseRetryStrategy({
      parse: (output) => parseBranchReviewReply(output, input.minorIds),
      validate: (parsed) => parsed !== null,
      reviewerKind: "workflow-branch-review",
      maxAttempts: 2,
      prompts: { invalid: buildWorkflowReviewJsonRetry, truncated: buildWorkflowReviewJsonRetryCondensed },
      exhaustedFallback: () => null,
    }),
};
```

`src/operations/workflow-branch-fix.ts`:
```ts
/**
 * A5 workflow mode: the one branch fix (spec §7 step 3). Fresh session, write tools,
 * soft interrupt at the fix limit. Same reply contract and parser as the implementer (P4-R20).
 */
import type { ConfiguredModel } from "@/config";
import { workflowConfigSelector } from "@/config";
import type { WorkflowOpConfig } from "@/config/selectors";
import { STEP_TIMEOUT_MARGIN_MS } from "@/utils/step-signal";
import { softInterruptTurn } from "./_interrupt";
import type { RunOperationWithHooks } from "./types";
import { WORKFLOW_WRITE_TOOLS } from "./workflow-implement";
import { parseImplementerReply } from "./workflow-replies";
import type { ImplementerReply } from "./workflow-types";

export interface WorkflowBranchFixInput {
  readonly prompt: string;
  /** Undefined: workflow.models.branchFix, then finish.reviewers.fix. */
  readonly model?: ConfiguredModel;
  /** Step limit: the soft interrupt fires here. */
  readonly timeoutMs: number;
}

export const workflowBranchFixOp: RunOperationWithHooks<
  WorkflowBranchFixInput,
  ImplementerReply,
  WorkflowOpConfig,
  "hopBody" | "recover"
> = {
  kind: "run",
  name: "workflow-branch-fix",
  stage: "run",
  session: { role: "wf-branch-fix", lifetime: "fresh" },
  config: workflowConfigSelector,
  tools: [...WORKFLOW_WRITE_TOOLS],
  model: (input, ctx) =>
    input.model ?? ctx.config.workflow?.models?.branchFix ?? ctx.config.finish?.reviewers?.fix ?? undefined,
  timeoutMs: (input) => input.timeoutMs + STEP_TIMEOUT_MARGIN_MS,
  build(input) {
    return {
      role: { id: "role", content: "", overridable: false },
      task: { id: "task", content: input.prompt, overridable: false },
    };
  },
  hopBody: (initialPrompt, ctx) => softInterruptTurn(initialPrompt, ctx),
  parse: (output) => parseImplementerReply(output),
  /** An empty reply is not a failure: the fix's real output is the working tree. */
  async recover() {
    return parseImplementerReply("");
  },
};
```

`src/operations/index.ts`:
- Add `export type { WorkflowBranchFixInput } from "./workflow-branch-fix"; export { workflowBranchFixOp } from "./workflow-branch-fix";` and the same pair for `workflow-branch-review` (`WorkflowBranchReviewInput`, `workflowBranchReviewOp`), in alphabetical position before `workflow-implement`.
- Add `WORKFLOW_WRITE_TOOLS` to the `workflow-implement` value export.
- Add `parseBranchReviewReply` to the `workflow-replies` export.
- Add `BranchReviewVerdict` and `MinorTriageDecision` to the `workflow-types` type export.

`src/prompts/builders/workflow-implementer-builder.ts`: rename `const REPLY_CONTRACT` to `export const WORKFLOW_REPLY_CONTRACT` and update its two uses in the same file.

`src/prompts/builders/workflow-branch-builder.ts`:
```ts
/** A5 workflow mode: the whole-branch review, its scoped re-review, and the one branch fix (spec §7 steps 2-4). */
import {
  renderWorkflowFindings,
  WORKFLOW_REPLY_CONTRACT,
  type WorkflowPromptFinding,
} from "./workflow-implementer-builder";

export interface BranchReviewPromptInput {
  readonly specPath?: string;
  readonly prdPath: string;
  readonly preflightPath?: string;
  readonly packagePath: string;
  readonly stories: readonly { readonly id: string; readonly state: string; readonly note?: string }[];
  readonly minors: readonly { readonly id: string; readonly storyId: string; readonly text: string }[];
  readonly parked: readonly { readonly storyId: string; readonly text: string }[];
  readonly cannotVerify: readonly { readonly storyId: string; readonly text: string }[];
  readonly gateFindings: readonly WorkflowPromptFinding[];
}

const NONE = "(none)";

function bullets(lines: readonly string[]): string {
  return lines.length > 0 ? lines.map((l) => `- ${l}`).join("\n") : NONE;
}

function storyLines(input: BranchReviewPromptInput): string {
  return bullets(input.stories.map((s) => `${s.id}: ${s.state}${s.note ? ` (${s.note})` : ""}`));
}

const REVIEW_JSON =
  '{"spec": "pass|fail", "quality": "approved|changes", "findings": [{"severity": "critical|important|minor", "kind": "spec|quality", "file": "path", "line": 0, "acId": "AC-3", "issue": "what is wrong", "suggestion": "how to fix"}], "cannotVerify": ["..."], "minorTriage": [{"id": "M1", "decision": "fix-now|leave"}]}';

export function buildWorkflowBranchReviewPrompt(input: BranchReviewPromptInput): string {
  const preflight = input.preflightPath ? `\n- the pre-flight rulings: ${input.preflightPath}` : "";
  const gates = input.gateFindings.length > 0 ? renderWorkflowFindings(input.gateFindings) : NONE;
  return `You are reviewing a whole feature branch. Every story was implemented and reviewed on its own already. Read:
- the feature spec: ${input.specPath ?? "(no spec file found)"}
- the PRD (stories and acceptance criteria): ${input.prdPath}${preflight}
- the branch review package (commits, --stat, full diff with context; truncated files are listed by name, read them yourself): ${input.packagePath}

## Stories
${storyLines(input)}

## Repo gate failures
${gates}

## Parked rulings from the story loops
${bullets(input.parked.map((p) => `${p.storyId}: ${p.text}`))}

## What the story reviewers could not verify
${bullets(input.cannotVerify.map((c) => `${c.storyId}: ${c.text}`))}

## Deferred minor findings (triage each one)
${input.minors.length > 0 ? input.minors.map((m) => `[${m.id}] ${m.storyId}: ${m.text}`).join("\n") : NONE}

## Your remit
- Cross-story integration and contracts: do the stories fit together, do callers and callees agree, is shared state consistent?
- Reachability: is every new piece wired in and reachable from where the spec says it is used?
- Consistency and duplication across stories.
- Triage each deferred minor as "fix-now" (cheap and worth doing before the PR) or "leave".
Do not re-review each story line by line; the story reviews did that.

Severity: "critical" (wrong or unsafe behaviour), "important" (must fix before the PR), "minor" (worth noting, not blocking). Put anything you could not check in "cannotVerify".

Reply with only this JSON object:
${REVIEW_JSON}`;
}

export function buildWorkflowBranchReReviewPrompt(input: {
  specPath?: string;
  reportPath: string;
  packagePath: string;
  findings: readonly WorkflowPromptFinding[];
}): string {
  const spec = input.specPath ? ` the spec (${input.specPath}),` : "";
  return `You are checking the one branch fix. Read${spec} the feature report (${input.reportPath}, see its "Branch fix" section) and the fix package (${input.packagePath}). The package holds only the fix diff.

## Findings the fix had to address
${renderWorkflowFindings(input.findings)}

For each finding id, answer ADDRESSED or NOT_ADDRESSED. Then list new problems introduced only in this fix diff. Do not re-review the rest of the branch.

Reply with only this JSON object:
{"findings": [{"id": "B1", "verdict": "ADDRESSED|NOT_ADDRESSED", "note": "one sentence"}], "newFindings": [{"severity": "critical|important|minor", "kind": "spec|quality", "file": "path", "line": 0, "issue": "...", "suggestion": "..."}]}`;
}

export function buildWorkflowBranchFixPrompt(input: {
  specPath?: string;
  prdPath: string;
  reportPath: string;
  findings: readonly WorkflowPromptFinding[];
}): string {
  const spec = input.specPath ? `the spec (${input.specPath}) and ` : "";
  return `You are fixing a feature branch after its whole-branch review. This is the only fix pass: there is no second one. Read ${spec}the PRD (${input.prdPath}) for what the feature must do.

## Findings to fix
${renderWorkflowFindings(input.findings)}

## How to work
- Fix every finding above. Findings marked minor are cheap cleanups the reviewer chose to fix now.
- For a red repo gate, make that gate green. For a story that ended with a red gate, make its gates green.
- Re-run the tests that cover what you changed, and add a test where a finding names a missing one (TDD: see it fail first).
- Commit, then append a "Branch fix" section to ${input.reportPath}: what you changed for each finding id, the test evidence, and any Decisions & assumptions.
- Do not dispatch sub-agents or reviewers.

${WORKFLOW_REPLY_CONTRACT}`;
}
```

`src/prompts/index.ts`: next to the other workflow builder exports, add:
```ts
export type { BranchReviewPromptInput } from "./builders/workflow-branch-builder";
export {
  buildWorkflowBranchFixPrompt,
  buildWorkflowBranchReReviewPrompt,
  buildWorkflowBranchReviewPrompt,
} from "./builders/workflow-branch-builder";
```
and add `WORKFLOW_REPLY_CONTRACT` to the `workflow-implementer-builder` value export.

- [ ] **Step 4: Run them to verify they pass**

Run the Step 2 command, then `timeout 120 bun test test/unit/operations test/unit/prompts --timeout=60000` and `bun run check:op-tool-capability`. Expected: all PASS. The existing `workflowImplementOp` hopBody tests must pass unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/operations src/prompts test/unit/operations test/unit/prompts
git commit -m "feat(workflow): branch review and branch fix ops, branch prompts, shared soft-interrupt turn"
```

---

### Task 4: PR3 carry-overs, the feature-scoped residual, and flagged rulings

**Files:**
- Modify: `src/advisor/batch-preflight.ts` (M2), `src/advisor/format.ts` (M5), `src/workflow/preflight.ts` (M6)
- Modify: `src/workflow/types.ts` (`WorkflowRuling.needsHumanConfirm`, `WorkflowStoryRecord.flagged`)
- Modify: `src/workflow/advisor.ts` (`isFlaggedRuling`), `src/workflow/advisor-live.ts` (optional `storyId`, `FEATURE_SCOPE`, `needsHumanConfirm`), `src/workflow/story-loop.ts` (`flagged` at close)
- Test: create `test/unit/advisor/batch-preflight.test.ts`; extend `test/unit/advisor/format.test.ts`, `test/unit/workflow/preflight.test.ts`, `test/unit/workflow/advisor-live.test.ts`, `test/unit/workflow/story-loop.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // workflow/types.ts
  WorkflowRuling: + readonly needsHumanConfirm?: boolean;
  WorkflowStoryRecord: + readonly flagged?: number;
  // workflow/advisor.ts
  export function isFlaggedRuling(r: WorkflowRuling): boolean;   // hold, or the advisor asked for confirmation
  // workflow/advisor-live.ts
  export const FEATURE_SCOPE = "_run";
  LiveAdvisorInput.storyId?: string;   // absent = feature-scoped residual (P4-R18)
  ```

- [ ] **Step 1: Write the failing tests**

`test/unit/advisor/batch-preflight.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { preflightItems } from "@/advisor/batch-preflight";
import type { RawPreflightConflict } from "@/operations";

const base = { feature: "f", askedAtSha: "s", newId: (() => {
  let n = 0;
  return () => `Q-${++n}`;
})() };

const conflict = (over: Partial<RawPreflightConflict>): RawPreflightConflict => ({
  storyIds: [],
  description: "30 days vs 14 days",
  specSection: "3.2",
  raw: { optionId: "B" },
  ...over,
});

describe("preflightItems story ids (PR3 M2)", () => {
  test("listed known ids are kept; unknown ones dropped", () => {
    const [item] = preflightItems([conflict({ storyIds: ["US-1", "US-9"] })], ["US-1", "US-2"], base);
    expect(item?.appliesTo).toEqual(["US-1"]);
    expect(item?.question.storyId).toBe("US-1");
  });

  test("no listed ids -> falls back to the AC's story when it is known", () => {
    const [item] = preflightItems(
      [conflict({ storyIds: [], acRef: { storyId: "US-2", acId: "AC-3" } })],
      ["US-1", "US-2"],
      base,
    );
    expect(item?.appliesTo).toEqual(["US-2"]);
  });

  test("no known story at all -> dropped", () => {
    expect(preflightItems([conflict({ storyIds: ["US-9"] })], ["US-1"], base)).toEqual([]);
    expect(
      preflightItems([conflict({ storyIds: [], acRef: { storyId: "US-9", acId: "AC-1" } })], ["US-1"], base),
    ).toEqual([]);
  });
});
```
If `@/advisor/batch-preflight` isn't importable as an internal (it is; tests may reach internals), import it the same way `test/unit/advisor/batch.test.ts` imports its unit.

Append to `test/unit/advisor/format.test.ts`:
```ts
describe("waived subject (PR3 M5)", () => {
  test("a residual waive with no dedupeKey names the ruled finding and its file", () => {
    const text = formatDecisionsForPrompt([
      d("D-9", { type: "waive", reason: "reviewer misread" }, { kind: "residual", rulingTitle: "Missing null check", anchorFile: "src/a.ts", storyId: "US-3" }),
    ]);
    expect(text).toContain("D-9 waived: Missing null check (src/a.ts) — reviewer misread");
  });

  test("rulingTitle without a file; and the story id as the last fallback", () => {
    expect(formatDecisionsForPrompt([d("D-1", { type: "waive", reason: "r" }, { rulingTitle: "T" })])).toContain(
      "D-1 waived: T — r",
    );
    expect(formatDecisionsForPrompt([d("D-2", { type: "waive", reason: "r" }, { storyId: "US-4" })])).toContain(
      "D-2 waived: US-4 — r",
    );
  });
});
```

Append to `test/unit/workflow/preflight.test.ts`:
```ts
describe("preflight.json reuse checks element shape (PR3 M6)", () => {
  test("a conflict missing storyIds is not reused: pre-flight runs again", async () => {
    const runDir = makeTempDir("wf-pf-shape-");
    dirs.push(runDir);
    await Bun.write(
      preflightPath(runDir),
      JSON.stringify({ schemaVersion: 1, overlap: [], conflicts: [{ questionId: "Q-1", summary: "s", decisionId: null, action: "hold" }] }),
    );
    const advisor = advisorReturning({ kind: "preflight", overlap: [], items: [] });
    await runPreflight({ advisor, runDir, storyIds: ["US-1"], ledger: async () => {} });
    expect(advisor.calls).toHaveLength(1);
  });

  test("an overlap entry with a non-string section is not reused", async () => {
    const runDir = makeTempDir("wf-pf-shape-");
    dirs.push(runDir);
    await Bun.write(
      preflightPath(runDir),
      JSON.stringify({ schemaVersion: 1, overlap: [{ storyId: "US-1", specSections: [3] }], conflicts: [] }),
    );
    const advisor = advisorReturning({ kind: "preflight", overlap: [], items: [] });
    await runPreflight({ advisor, runDir, storyIds: ["US-1"], ledger: async () => {} });
    expect(advisor.calls).toHaveLength(1);
  });

  test("a well-formed file is reused (no advisor call)", async () => {
    const runDir = makeTempDir("wf-pf-shape-");
    dirs.push(runDir);
    const file: PreflightFile = {
      schemaVersion: 1,
      overlap: [{ storyId: "US-1", specSections: ["3"] }],
      conflicts: [{ questionId: "Q-1", storyIds: ["US-1"], summary: "s", decisionId: "D-1", action: "supersede" }],
    };
    await Bun.write(preflightPath(runDir), JSON.stringify(file));
    const advisor = advisorReturning({ kind: "preflight", overlap: [], items: [] });
    expect(await runPreflight({ advisor, runDir, storyIds: ["US-1"], ledger: async () => {} })).toEqual(file);
    expect(advisor.calls).toHaveLength(0);
  });
});
```

Append to `test/unit/workflow/advisor-live.test.ts`. Reuse that file's existing fake-advisor helper; if its name differs from `fakeAdvisor` below, use the file's own helper with the same behaviour: record `adviseBatch` requests, return a residual result with no decisions.
```ts
describe("feature-scoped residual (P4-R18)", () => {
  test("no storyId: request storyId _run, items carry no storyId, no carry option", async () => {
    const calls: BatchRequest[] = [];
    const advisor: Advisor = {
      advise: async () => ({ decision: null }),
      recordReuse: async () => null,
      adviseBatch: async (req) => {
        calls.push(req);
        return { kind: "residual", items: [], diagnoses: {} };
      },
    };
    const live = createLiveWorkflowAdvisor({ advisor, feature: "f", dependents: [] });
    await live.ruleResidual({
      storyId: FEATURE_SCOPE,
      items: [{ id: "B1", kind: "quality", severity: "important", issue: "contract drift" }],
      redGates: [],
    });
    const req = calls[0];
    if (req?.kind !== "residual") throw new Error("expected a residual batch");
    expect(req.storyId).toBe("_run");
    expect(req.summary).toContain("branch review");
    expect(req.items[0]?.storyId).toBeUndefined();
    expect(req.items[0]?.options.map((o) => o.type)).toEqual(["waive", "defer", "hold"]);
  });

  test("toWorkflowRuling keeps needsHumanConfirm", () => {
    const ruling = toWorkflowRuling("F1", makeAdviceDecision({ action: { type: "defer", reason: "later" }, needsHumanConfirm: true }));
    expect(ruling?.needsHumanConfirm).toBe(true);
  });
});
```
Add `FEATURE_SCOPE` and `toWorkflowRuling` to the file's `@/workflow/advisor-live` import, `makeAdviceDecision` to its `@test/helpers` import, and `Advisor`, `BatchRequest` to its `@/advisor` type import. Before writing, read `makeAdviceDecision` in `test/helpers`. If it doesn't take an override object, build the decision inline with every required `AdviceDecision` field, as `test/unit/advisor/format.test.ts` does.

Append to `test/unit/workflow/story-loop.test.ts`. It uses the file's `harness`; read its return value first, and read the closed record from the field `harness` exposes (`record` or its getter):
```ts
describe("flagged rulings at close", () => {
  test("a default hold at the cap counts as flagged on the record", async () => {
    const h = harness({ review: [failing(1)], reReviewAllAddressed: [false] }, { maxFixRounds: 1 });
    await runStoryLoop(h.env);
    expect(h.record().flagged).toBe(1);
  });

  test("a clean story has flagged 0", async () => {
    const h = harness({});
    await runStoryLoop(h.env);
    expect(h.record().flagged).toBe(0);
  });
});
```
If `harness` exposes the record under another name, use it. If it doesn't expose the record at all, add a `record: () => record` getter to the harness's return value and keep the assertions.

- [ ] **Step 2: Run them to verify they fail**

Run: `timeout 60 bun test test/unit/advisor/batch-preflight.test.ts test/unit/advisor/format.test.ts test/unit/workflow/preflight.test.ts test/unit/workflow/advisor-live.test.ts test/unit/workflow/story-loop.test.ts --timeout=60000`
Expected: FAIL. The AC fallback drops the conflict, the residual waive reads "US-3", the malformed files are reused, `FEATURE_SCOPE` doesn't exist, and `flagged` is undefined.

- [ ] **Step 3: Implement**

`src/advisor/batch-preflight.ts`: replace the `kept` / dropped-loop / `storyId` lines inside `preflightItems` with a call to a new helper, and set `appliesTo` from it:
```ts
/** The batch story ids a conflict applies to; with none listed, its AC's story when known (PR3 M2). */
function appliesToOf(conflict: RawPreflightConflict, knownStoryIds: readonly string[]): string[] {
  const kept = conflict.storyIds.filter((id) => knownStoryIds.includes(id));
  for (const dropped of conflict.storyIds.filter((id) => !knownStoryIds.includes(id))) {
    getSafeLogger()?.warn("advisor", "Pre-flight conflict names a story that is not in the batch — dropped", {
      storyId: dropped,
      description: conflict.description,
    });
  }
  if (kept.length > 0) return kept;
  const acStory = conflict.acRef?.storyId;
  if (acStory !== undefined && knownStoryIds.includes(acStory)) return [acStory];
  getSafeLogger()?.warn("advisor", "Pre-flight conflict names no story in the batch — dropped", {
    storyId: "_run",
    description: conflict.description,
  });
  return [];
}
```
In the loop:
```ts
    const appliesTo = appliesToOf(conflict, knownStoryIds);
    const storyId = appliesTo[0];
    if (storyId === undefined) continue;
```
and `appliesTo,` in the pushed item (replacing `appliesTo: kept`).

`src/advisor/format.ts`:
```ts
function waivedSubject(d: AdviceDecision): string {
  const [, keyTitle, keyPath] = (d.dedupeKey ?? "").split("|");
  const title = keyTitle || d.rulingTitle;
  const path = keyPath || d.anchorFile;
  if (!title) return d.storyId ?? "finding";
  return path ? `${title} (${path})` : title;
}
```

`src/workflow/preflight.ts`: replace `isReusable` with:
```ts
function isRecordObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((s) => typeof s === "string");
}

function isOverlapEntry(v: unknown): boolean {
  return isRecordObject(v) && typeof v.storyId === "string" && isStringArray(v.specSections);
}

function isConflictRecord(v: unknown): boolean {
  return (
    isRecordObject(v) &&
    typeof v.questionId === "string" &&
    isStringArray(v.storyIds) &&
    typeof v.summary === "string" &&
    (v.decisionId === null || typeof v.decisionId === "string") &&
    typeof v.action === "string"
  );
}

/** Reusable = this schema, every element well-formed (PR3 M6), and not a failed pre-flight. */
function isReusable(v: unknown): v is PreflightFile {
  if (!isRecordObject(v) || v.schemaVersion !== 1 || v.fallbackReason) return false;
  return (
    Array.isArray(v.overlap) &&
    v.overlap.every(isOverlapEntry) &&
    Array.isArray(v.conflicts) &&
    v.conflicts.every(isConflictRecord)
  );
}
```
Export `isReusable` as `isReusablePreflight` too (`export const isReusablePreflight = isReusable;`), because Task 11's `adoptPriorPreflight` uses it.

`src/workflow/types.ts`: add to `WorkflowRuling` after `toStories`:
```ts
  /** The advisor asked for a human to confirm this ruling (keeps the PR a draft). */
  readonly needsHumanConfirm?: boolean;
```
and to `WorkflowStoryRecord` after `rulings`:
```ts
  /** Rulings flagged for a human (hold, or needs confirmation), set at close. */
  readonly flagged?: number;
```

`src/workflow/advisor.ts`, append:
```ts
/** A ruling a human must look at before the PR is ready (spec §7.8): a hold, or an advisor-flagged decision. */
export function isFlaggedRuling(r: WorkflowRuling): boolean {
  return r.action === "hold" || r.needsHumanConfirm === true;
}
```

`src/workflow/advisor-live.ts`:
- `LiveAdvisorInput.storyId` becomes optional, with the doc line `/** Absent: a feature-scoped residual (branch adjudication, P4-R18). */`.
- Add `export const FEATURE_SCOPE = "_run";`.
- In `toWorkflowRuling`, add `...(d.needsHumanConfirm ? { needsHumanConfirm: true } : {}),` to `base`.
- In `ruleResidual`, items get `...(storyId ? { storyId } : {}),` instead of `storyId,`, and the batch call becomes:
  ```ts
      const result = await advisor.adviseBatch({
        kind: "residual",
        storyId: storyId ?? FEATURE_SCOPE,
        summary: storyId
          ? `${storyId} reached its fix-round cap with ${req.items.length} open item(s).`
          : `The branch review left ${req.items.length} open item(s) after its one fix pass.`,
        items,
        redGates: [...req.redGates],
      });
  ```
  `answerQuestion` is unchanged: it uses `q.storyId`.

`src/workflow/story-loop.ts`: import `isFlaggedRuling` from `./advisor`, and in `closeLoop` add `flagged: rulings.filter(isFlaggedRuling).length,` to the `env.sink.update({...})` patch.

- [ ] **Step 4: Run them to verify they pass**

Run the Step 2 command, then `timeout 120 bun test test/unit/advisor test/unit/workflow test/integration/workflow --timeout=60000`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/advisor src/workflow test/unit/advisor test/unit/workflow
git commit -m "fix(workflow): PR3 carry-overs (pre-flight story fallback, waived subject, preflight.json shape) and flagged rulings"
```

---
### Task 5: Feature state, ledger items, and per-role tokens

**Files:**
- Modify: `src/workflow/types.ts`, `src/workflow/result.ts`
- Create: `src/workflow/feature-record.ts`, `src/workflow/ledger-items.ts`, `src/workflow/tokens.ts`
- Modify: `src/workflow/stage.ts` (token meter, `tokensByRole` on the story record)
- Test: extend `test/unit/workflow/result.test.ts`, `test/unit/workflow/stage.test.ts`; create `test/unit/workflow/feature-record.test.ts`, `test/unit/workflow/ledger-items.test.ts`, `test/unit/workflow/tokens.test.ts`

**Interfaces:**
- Consumes: `isReusablePreflight`, `preflightPath`, `PreflightFile` (Task 4); `FEATURE_SCOPE` (Task 4); `MinorTriageDecision`, `BranchReviewVerdict` (Task 3).
- Produces (all from `src/workflow/…`):
  ```ts
  // types.ts
  export interface RoleTokens { readonly inputTokens: number; readonly outputTokens: number; readonly costUsd: number; readonly calls: number }
  export type FeatureStep = "repo-gates" | "branch-review" | "branch-fix" | "branch-rereview" | "adjudicate" | "final-gates" | "publish" | "done";
  export interface RepoGateSummary { readonly ran: readonly string[]; readonly failing: readonly string[] }
  export type FeatureCiState = "green" | "failed" | "pending" | "skipped";
  export type FeatureOutcome = "ready" | "draft" | "local-only";
  export interface MinorItem { readonly id: string; readonly storyId: string; readonly text: string; readonly triage: MinorTriageDecision }
  export type StoryState = WorkflowEndState | "not-run";
  export interface StorySummary { readonly id: string; readonly title: string; readonly state: StoryState; readonly reason?: string; readonly rounds: number; readonly unreviewed: boolean; readonly flagged: number; readonly runDir?: string }
  export interface WorkflowFeatureRecord { … see Step 3 … }
  WorkflowResultFile: + readonly featureWorkflow?: WorkflowFeatureRecord;
  WorkflowStoryRecord: + readonly tokensByRole?: Readonly<Record<string, RoleTokens>>;
  // result.ts
  export function runDirsNewestFirst(featureDir: string): Promise<string[]>;
  export function upsertFeatureRecord(runDir: string, header: { runId: string; feature: string }, record: WorkflowFeatureRecord): Promise<void>;
  // feature-record.ts
  export const FEATURE_STEPS: readonly FeatureStep[];
  export function newFeatureRecord(input: { now: string; seed: string | null; minors: readonly MinorItem[] }): WorkflowFeatureRecord;
  export function minorsFrom(deferred: readonly LedgerItem[]): MinorItem[];
  export interface LocatedStoryRecord { readonly record: WorkflowStoryRecord; readonly runDir: string }
  export function collectStoryRecords(featureDir: string): Promise<Readonly<Record<string, LocatedStoryRecord>>>;
  export function loadPriorFeature(featureDir: string, currentRunId: string): Promise<WorkflowFeatureRecord | null>;
  export function summariseStories(prd: PRD, records: Readonly<Record<string, LocatedStoryRecord>>): StorySummary[];
  export function newestPreflight(featureDir: string): Promise<{ readonly path: string; readonly file: PreflightFile } | null>;
  // ledger-items.ts
  export interface LedgerItem { readonly storyId: string; readonly text: string }
  export interface LedgerItems { readonly deferredMinors: readonly LedgerItem[]; readonly cannotVerify: readonly LedgerItem[]; readonly parked: readonly LedgerItem[] }
  export function collectLedgerItems(featureDir: string): Promise<LedgerItems>;
  // tokens.ts
  export const EMPTY_TOKENS: RoleTokens;
  export function addRoleTokens(a: Readonly<Record<string, RoleTokens>>, b: Readonly<Record<string, RoleTokens>>): Record<string, RoleTokens>;
  export interface TokenMeter { totals(): RoleTokens; byRole(): Readonly<Record<string, RoleTokens>>; stop(): void }
  export function startTokenMeter(source: DispatchSource | undefined): TokenMeter;
  ```

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/workflow/result.test.ts` (add `upsertFeatureRecord` and `runDirsNewestFirst` to its `@/workflow/result` import, and `newFeatureRecord` from `@/workflow/feature-record`):
```ts
describe("feature record in result.json (P4-R1)", () => {
  test("upsertFeatureRecord keeps the story records; upsertStoryRecord keeps the feature record", async () => {
    const run = makeTempDir("wf-result-");
    dirs.push(run);
    await upsertStoryRecord(run, header("run-1"), newStoryRecord("US-001", 5, "t"));
    const feature = newFeatureRecord({ now: "t", seed: "s0", minors: [] });
    await upsertFeatureRecord(run, header("run-1"), feature);
    expect((await readResult(run))?.stories["US-001"]).toBeDefined();
    await upsertStoryRecord(run, header("run-1"), { ...newStoryRecord("US-001", 5, "t"), round: 2 });
    const file = await readResult(run);
    expect(file?.featureWorkflow?.seed).toBe("s0");
    expect(file?.stories["US-001"]?.round).toBe(2);
  });

  test("runDirsNewestFirst orders run dirs by result.json mtime and skips dirs without one", async () => {
    const feature = makeTempDir("wf-feature-");
    dirs.push(feature);
    for (const [name, secs] of [["run-a", 100], ["run-b", 300], ["run-c", 200]] as const) {
      await upsertStoryRecord(join(feature, name), header(name), newStoryRecord("US-001", 5, "t"));
      await utimes(join(feature, name, "result.json"), secs, secs);
    }
    await mkdir(join(feature, "not-a-run"), { recursive: true });
    expect(await runDirsNewestFirst(feature)).toEqual(["run-b", "run-c", "run-a"].map((n) => join(feature, n)));
  });
});
```

`test/unit/workflow/feature-record.test.ts`:
```ts
import { afterEach, describe, expect, test } from "bun:test";
import { utimes } from "node:fs/promises";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir, makeTestPRD, makeTestStory } from "@test/helpers";
import {
  collectStoryRecords,
  loadPriorFeature,
  minorsFrom,
  newestPreflight,
  newFeatureRecord,
  summariseStories,
} from "@/workflow/feature-record";
import { preflightPath } from "@/workflow/preflight";
import { newStoryRecord, upsertFeatureRecord, upsertStoryRecord } from "@/workflow/result";
import type { WorkflowStoryRecord } from "@/workflow/types";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.map(cleanupTempDir));
  dirs.length = 0;
});

const header = (runId: string) => ({ runId, feature: "f" });
const closed = (id: string, over: Partial<WorkflowStoryRecord> = {}): WorkflowStoryRecord => ({
  ...newStoryRecord(id, 5, "t"),
  state: "complete",
  reason: "clean",
  phase: "closed",
  ...over,
});

async function writeRun(featureDir: string, runId: string, secs: number, records: WorkflowStoryRecord[]): Promise<string> {
  const runDir = join(featureDir, runId);
  for (const r of records) await upsertStoryRecord(runDir, header(runId), r);
  await utimes(join(runDir, "result.json"), secs, secs);
  return runDir;
}

describe("collectStoryRecords (P4-R2)", () => {
  test("newest run wins per story; each record keeps its run dir", async () => {
    const feature = makeTempDir("wf-fr-");
    dirs.push(feature);
    const old = await writeRun(feature, "run-1", 100, [closed("US-001", { round: 1 }), closed("US-002")]);
    const fresh = await writeRun(feature, "run-2", 200, [closed("US-001", { round: 3 })]);
    const records = await collectStoryRecords(feature);
    expect(records["US-001"]?.record.round).toBe(3);
    expect(records["US-001"]?.runDir).toBe(fresh);
    expect(records["US-002"]?.runDir).toBe(old);
  });

  test("a missing feature dir is empty", async () => {
    expect(await collectStoryRecords("/nonexistent/wf")).toEqual({});
  });
});

describe("summariseStories", () => {
  test("record states, passed-without-record = complete, everything else not-run", () => {
    const prd = makeTestPRD([
      makeTestStory({ id: "US-001", title: "A" }),
      makeTestStory({ id: "US-002", title: "B", status: "passed", passes: true }),
      makeTestStory({ id: "US-003", title: "C" }),
      makeTestStory({ id: "US-004", title: "D" }),
    ]);
    const summaries = summariseStories(prd, {
      "US-001": { record: closed("US-001", { state: "complete-gate-open", reason: "red: lint", round: 2, flagged: 1 }), runDir: "/r1" },
      "US-004": { record: { ...newStoryRecord("US-004", 5, "t"), phase: "fix", round: 1 }, runDir: "/r1" },
    });
    expect(summaries).toEqual([
      { id: "US-001", title: "A", state: "complete-gate-open", reason: "red: lint", rounds: 2, unreviewed: false, flagged: 1, runDir: "/r1" },
      { id: "US-002", title: "B", state: "complete", reason: "passed earlier, no workflow record", rounds: 0, unreviewed: false, flagged: 0 },
      { id: "US-003", title: "C", state: "not-run", rounds: 0, unreviewed: false, flagged: 0 },
      { id: "US-004", title: "D", state: "not-run", rounds: 1, unreviewed: false, flagged: 0 },
    ]);
  });
});

describe("loadPriorFeature (P4-R1)", () => {
  test("the newest OTHER run's feature record; the current run is ignored", async () => {
    const feature = makeTempDir("wf-fr-");
    dirs.push(feature);
    const r1 = await writeRun(feature, "run-1", 100, [closed("US-001")]);
    await upsertFeatureRecord(r1, header("run-1"), { ...newFeatureRecord({ now: "t", seed: "s1", minors: [] }), step: "branch-fix" });
    await utimes(join(r1, "result.json"), 100, 100);
    const r2 = await writeRun(feature, "run-2", 200, [closed("US-001")]);
    await upsertFeatureRecord(r2, header("run-2"), newFeatureRecord({ now: "t", seed: "s2", minors: [] }));
    await utimes(join(r2, "result.json"), 200, 200);
    expect((await loadPriorFeature(feature, "run-2"))?.step).toBe("branch-fix");
    expect((await loadPriorFeature(feature, "run-9"))?.seed).toBe("s2");
  });

  test("a malformed feature record is ignored", async () => {
    const feature = makeTempDir("wf-fr-");
    dirs.push(feature);
    const r1 = await writeRun(feature, "run-1", 100, [closed("US-001")]);
    const file = await Bun.file(join(r1, "result.json")).json();
    await Bun.write(join(r1, "result.json"), JSON.stringify({ ...file, featureWorkflow: { step: "teleport" } }));
    expect(await loadPriorFeature(feature, "run-2")).toBeNull();
  });
});

describe("minorsFrom and newestPreflight", () => {
  test("minors get M ids in order and start as leave", () => {
    expect(minorsFrom([{ storyId: "US-001", text: "a" }, { storyId: "US-002", text: "b" }])).toEqual([
      { id: "M1", storyId: "US-001", text: "a", triage: "leave" },
      { id: "M2", storyId: "US-002", text: "b", triage: "leave" },
    ]);
  });

  test("newestPreflight returns the newest reusable preflight.json, skipping failed ones", async () => {
    const feature = makeTempDir("wf-fr-");
    dirs.push(feature);
    const good = await writeRun(feature, "run-1", 100, [closed("US-001")]);
    const failed = await writeRun(feature, "run-2", 200, [closed("US-001")]);
    await Bun.write(preflightPath(good), JSON.stringify({ schemaVersion: 1, overlap: [], conflicts: [] }));
    await Bun.write(preflightPath(failed), JSON.stringify({ schemaVersion: 1, overlap: [], conflicts: [], fallbackReason: "all models failed" }));
    expect((await newestPreflight(feature))?.path).toBe(preflightPath(good));
  });
});
```

`test/unit/workflow/ledger-items.test.ts`:
```ts
import { afterEach, describe, expect, test } from "bun:test";
import { utimes } from "node:fs/promises";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { collectLedgerItems } from "@/workflow/ledger-items";
import { newStoryRecord, upsertStoryRecord } from "@/workflow/result";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.map(cleanupTempDir));
  dirs.length = 0;
});

async function run(feature: string, name: string, secs: number, ledger: string): Promise<void> {
  const runDir = join(feature, name);
  await upsertStoryRecord(runDir, { runId: name, feature: "f" }, newStoryRecord("US-001", 5, "t"));
  await utimes(join(runDir, "result.json"), secs, secs);
  await Bun.write(join(runDir, "ledger.md"), ledger);
}

describe("collectLedgerItems", () => {
  test("deferred minors, cannot-verify items and parked rulings, oldest run first, deduped", async () => {
    const feature = makeTempDir("wf-li-");
    dirs.push(feature);
    await run(
      feature,
      "run-1",
      100,
      [
        "# Workflow ledger — run: run-1 — feature: f",
        "US-001: deferred-minor: rename tmp",
        "US-001: cannot-verify: Redis TTL",
        "US-001: Ruling: hold F2: flaky timer — deterministic default — stays open",
        "US-002: Ruling: pre-flight D-1: supersede US-2 AC-3 — spec newer — high confidence; reversible",
        "_run: Ruling: hold B1: drift — x — y",
        "US-001: fix round 1/5 (1 open: F1)",
      ].join("\n"),
    );
    await run(feature, "run-2", 200, "US-001: deferred-minor: rename tmp\nUS-003: deferred-minor: add doc comment\n");
    expect(await collectLedgerItems(feature)).toEqual({
      deferredMinors: [
        { storyId: "US-001", text: "rename tmp" },
        { storyId: "US-003", text: "add doc comment" },
      ],
      cannotVerify: [{ storyId: "US-001", text: "Redis TTL" }],
      parked: [{ storyId: "US-001", text: "hold F2: flaky timer — deterministic default — stays open" }],
    });
  });

  test("no run dirs -> empty lists", async () => {
    expect(await collectLedgerItems("/nonexistent/wf")).toEqual({ deferredMinors: [], cannotVerify: [], parked: [] });
  });
});
```

`test/unit/workflow/tokens.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { addRoleTokens, type MeterEvent, startTokenMeter } from "@/workflow/tokens";

type Listener = (e: MeterEvent) => void;

function source() {
  const listeners: Listener[] = [];
  let off = 0;
  return {
    onDispatch(l: Listener) {
      listeners.push(l);
      return () => {
        off++;
      };
    },
    emit: (e: MeterEvent) => {
      for (const l of listeners) l(e);
    },
    offCount: () => off,
  };
}

describe("startTokenMeter", () => {
  test("totals and per-role buckets; exact cost wins over estimated", () => {
    const s = source();
    const meter = startTokenMeter(s);
    s.emit({ sessionRole: "wf-implementer", exactCostUsd: 0.25, estimatedCostUsd: 9, tokenUsage: { inputTokens: 10, outputTokens: 5 } });
    s.emit({ sessionRole: "wf-implementer", estimatedCostUsd: 0.5, tokenUsage: { inputTokens: 20, outputTokens: 7 } });
    s.emit({ sessionRole: "wf-story-review" });
    expect(meter.byRole()).toEqual({
      "wf-implementer": { inputTokens: 30, outputTokens: 12, costUsd: 0.75, calls: 2 },
      "wf-story-review": { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 1 },
    });
    expect(meter.totals()).toEqual({ inputTokens: 30, outputTokens: 12, costUsd: 0.75, calls: 3 });
    meter.stop();
    expect(s.offCount()).toBe(1);
  });

  test("no source -> zero totals, stop is a no-op", () => {
    const meter = startTokenMeter(undefined);
    meter.stop();
    expect(meter.totals()).toEqual({ inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 });
  });

  test("addRoleTokens merges role by role", () => {
    const one = { inputTokens: 1, outputTokens: 1, costUsd: 1, calls: 1 };
    expect(addRoleTokens({ a: one }, { a: one, b: one })).toEqual({
      a: { inputTokens: 2, outputTokens: 2, costUsd: 2, calls: 2 },
      b: one,
    });
  });
});
```
`MeterEvent` is exported from `tokens.ts` (Step 3) for exactly this fake.

Append to `test/unit/workflow/stage.test.ts`, inside the `describe` that holds "cost and token totals from dispatch events land in agentResult". Read `wire` first. The stub `env.sink.update` must record its patches; if `wire` doesn't expose them, give it an optional `updates: unknown[]` collector the same way it takes `closed`.
```ts
  test("per-role token totals are written onto the story record (spec §9)", async () => {
    const runtime = makeMockRuntime({ costAggregator: createNoOpCostAggregator() });
    const updates: unknown[] = [];
    wire(
      async () => {
        runtime.dispatchEvents.emitDispatch(
          makeEvent({ sessionRole: "wf-implementer", estimatedCostUsd: 0.5, tokenUsage: { inputTokens: 20, outputTokens: 7 } }),
        );
        return OUTCOME;
      },
      { updates },
    );
    await workflowStage.execute(makeTestContext({ runtime }));
    expect(updates.at(-1)).toEqual({
      tokensByRole: { "wf-implementer": { inputTokens: 20, outputTokens: 7, costUsd: 0.5, calls: 1 } },
    });
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `timeout 60 bun test test/unit/workflow/result.test.ts test/unit/workflow/feature-record.test.ts test/unit/workflow/ledger-items.test.ts test/unit/workflow/tokens.test.ts test/unit/workflow/stage.test.ts --timeout=60000`
Expected: FAIL. The new modules and exports don't exist, and the stage writes no `tokensByRole`.

- [ ] **Step 3: Implement**

`src/workflow/types.ts`:
- Add `BranchReviewVerdict` and `MinorTriageDecision` to the `export type { … } from "@/operations"` list and to the local `import type`.
- Add `readonly tokensByRole?: Readonly<Record<string, RoleTokens>>;` to `WorkflowStoryRecord` (after `timings`).
- Add `readonly featureWorkflow?: WorkflowFeatureRecord;` to `WorkflowResultFile`.
- Append:
```ts
export interface RoleTokens {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  readonly calls: number;
}

export type FeatureStep =
  | "repo-gates"
  | "branch-review"
  | "branch-fix"
  | "branch-rereview"
  | "adjudicate"
  | "final-gates"
  | "publish"
  | "done";

/** One runQualityGates pass. Nothing ran = nothing verified (P4-R5). */
export interface RepoGateSummary {
  readonly ran: readonly string[];
  readonly failing: readonly string[];
}

export type FeatureCiState = "green" | "failed" | "pending" | "skipped";
export type FeatureOutcome = "ready" | "draft" | "local-only";

/** A story loop's deferred minor, numbered for the branch review's triage (P4-R7, P4-R8). */
export interface MinorItem {
  readonly id: string;
  readonly storyId: string;
  readonly text: string;
  readonly triage: MinorTriageDecision;
}

export type StoryState = WorkflowEndState | "not-run";

export interface StorySummary {
  readonly id: string;
  readonly title: string;
  readonly state: StoryState;
  readonly reason?: string;
  readonly rounds: number;
  readonly unreviewed: boolean;
  readonly flagged: number;
  /** The run dir holding this story's brief/report (absent when it has no record). */
  readonly runDir?: string;
}

/** The feature workflow's persisted state (spec §7, §10, P4-R1). `step` is the NEXT step to run. */
export interface WorkflowFeatureRecord {
  readonly step: FeatureStep;
  readonly startedAt: string;
  readonly endedAt?: string;
  /** HEAD when the workflow reached `done`. */
  readonly head?: string;
  readonly seed: string | null;
  readonly repoGates?: RepoGateSummary;
  /** Red repo gates and gate-open stories (step 1), handed to the branch fix. */
  readonly gateFindings: readonly WorkflowFinding[];
  readonly reviewRan: boolean;
  /** Blocking branch-review findings still open. */
  readonly reviewOpen: readonly WorkflowFinding[];
  readonly minors: readonly MinorItem[];
  /** Minor findings raised by the branch review or re-review (PR body, `leave`). */
  readonly newMinors: readonly string[];
  readonly nextFindingId: number;
  readonly fixBase?: string;
  readonly fixRan: boolean;
  readonly rulings: readonly WorkflowRuling[];
  readonly finalGates?: RepoGateSummary;
  readonly ci?: FeatureCiState;
  readonly outcome?: FeatureOutcome;
  readonly reasons: readonly string[];
  readonly url?: string;
  readonly passed?: boolean;
  readonly timings: Readonly<Record<string, number>>;
  readonly tokensByRole: Readonly<Record<string, RoleTokens>>;
}
```

`src/workflow/result.ts`:
- Add `basename` to the `node:path` import.
- Add `export async function runDirsNewestFirst(featureDir: string): Promise<string[]>`, moving the readdir/stat/sort logic out of `loadPriorStory`, so `loadPriorStory` iterates `await runDirsNewestFirst(featureDir)` and skips `basename(runDir) === currentRunId`.
- Add a private `writeResult(runDir, next)` holding the mkdir + tmp + rename that `upsertStoryRecord` does today.
- `upsertStoryRecord` builds `next` with `...(current?.featureWorkflow ? { featureWorkflow: current.featureWorkflow } : {})`.
- Append:
```ts
/** Writes the feature workflow's state into this run's result.json, keeping the story records (P4-R1). */
export async function upsertFeatureRecord(
  runDir: string,
  header: { readonly runId: string; readonly feature: string },
  record: WorkflowFeatureRecord,
): Promise<void> {
  const current = await readResult(runDir);
  await writeResult(runDir, {
    schemaVersion: 1,
    runId: header.runId,
    feature: header.feature,
    stories: current?.stories ?? {},
    featureWorkflow: record,
  });
}
```
For reference, `runDirsNewestFirst` is:
```ts
/** Run dirs of a feature that hold a result.json, newest result.json first. */
export async function runDirsNewestFirst(featureDir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await _resultDeps.readdir(featureDir);
  } catch {
    return [];
  }
  const dated: { runDir: string; mtimeMs: number }[] = [];
  for (const name of entries) {
    const runDir = join(featureDir, name);
    try {
      dated.push({ runDir, mtimeMs: (await _resultDeps.stat(join(runDir, RESULT_FILE))).mtimeMs });
    } catch {
      // not a run dir, or no result.json yet
    }
  }
  return [...dated].sort((a, b) => b.mtimeMs - a.mtimeMs).map((d) => d.runDir);
}
```

`src/workflow/feature-record.ts`:
```ts
/** Feature-workflow state (P4-R1, P4-R2): the record, story states across runs, prior-run resume. */
import { basename } from "node:path";
import { getSafeLogger } from "@/logger";
import type { PRD } from "@/prd";
import type { LedgerItem } from "./ledger-items";
import { isReusablePreflight, type PreflightFile, preflightPath } from "./preflight";
import { readResult, runDirsNewestFirst } from "./result";
import type { FeatureStep, MinorItem, StorySummary, WorkflowFeatureRecord, WorkflowStoryRecord } from "./types";

export const FEATURE_STEPS: readonly FeatureStep[] = [
  "repo-gates",
  "branch-review",
  "branch-fix",
  "branch-rereview",
  "adjudicate",
  "final-gates",
  "publish",
  "done",
];

const PASSED_EARLIER = "passed earlier, no workflow record";

export function newFeatureRecord(input: {
  readonly now: string;
  readonly seed: string | null;
  readonly minors: readonly MinorItem[];
}): WorkflowFeatureRecord {
  return {
    step: "repo-gates",
    startedAt: input.now,
    seed: input.seed,
    gateFindings: [],
    reviewRan: false,
    reviewOpen: [],
    minors: input.minors,
    newMinors: [],
    nextFindingId: 1,
    fixRan: false,
    rulings: [],
    reasons: [],
    timings: {},
    tokensByRole: {},
  };
}

export function minorsFrom(deferred: readonly LedgerItem[]): MinorItem[] {
  return deferred.map((m, i) => ({ id: `M${i + 1}`, storyId: m.storyId, text: m.text, triage: "leave" }));
}

export interface LocatedStoryRecord {
  readonly record: WorkflowStoryRecord;
  readonly runDir: string;
}

/** Every story's newest record across the feature's runs (P4-R2). */
export async function collectStoryRecords(featureDir: string): Promise<Readonly<Record<string, LocatedStoryRecord>>> {
  const found = new Map<string, LocatedStoryRecord>();
  for (const runDir of await runDirsNewestFirst(featureDir)) {
    const stories = (await readResult(runDir))?.stories ?? {};
    for (const [id, record] of Object.entries(stories)) {
      if (!found.has(id)) found.set(id, { record, runDir });
    }
  }
  return Object.fromEntries(found);
}

function isFeatureRecord(v: unknown): v is WorkflowFeatureRecord {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    FEATURE_STEPS.includes(o.step as FeatureStep) &&
    Array.isArray(o.gateFindings) &&
    Array.isArray(o.reviewOpen) &&
    Array.isArray(o.minors) &&
    Array.isArray(o.rulings) &&
    Array.isArray(o.reasons)
  );
}

/** The newest OTHER run's feature record (P4-R1); a malformed record is skipped with a warning. */
export async function loadPriorFeature(featureDir: string, currentRunId: string): Promise<WorkflowFeatureRecord | null> {
  for (const runDir of await runDirsNewestFirst(featureDir)) {
    if (basename(runDir) === currentRunId) continue;
    const feature = (await readResult(runDir))?.featureWorkflow;
    if (feature === undefined) continue;
    if (isFeatureRecord(feature)) return feature;
    getSafeLogger()?.warn("workflow", "Prior feature record is malformed — ignored", { storyId: "_run", runDir });
  }
  return null;
}

function fromRecord(id: string, title: string, located: LocatedStoryRecord): StorySummary | null {
  const r = located.record;
  if (!r.state) return null;
  return {
    id,
    title,
    state: r.state,
    ...(r.reason ? { reason: r.reason } : {}),
    rounds: r.round,
    unreviewed: r.unreviewed,
    flagged: r.flagged ?? 0,
    runDir: located.runDir,
  };
}

export function summariseStories(prd: PRD, records: Readonly<Record<string, LocatedStoryRecord>>): StorySummary[] {
  return prd.userStories.map((s) => {
    const located = records[s.id];
    const closed = located ? fromRecord(s.id, s.title, located) : null;
    if (closed) return closed;
    const base = { id: s.id, title: s.title, unreviewed: false, flagged: 0 };
    if (s.passes || s.status === "passed") return { ...base, state: "complete", reason: PASSED_EARLIER, rounds: 0 };
    return { ...base, state: "not-run", rounds: located?.record.round ?? 0 };
  });
}

/** The newest reusable preflight.json of the feature (P4-R14); failed or malformed files are skipped. */
export async function newestPreflight(
  featureDir: string,
): Promise<{ readonly path: string; readonly file: PreflightFile } | null> {
  for (const runDir of await runDirsNewestFirst(featureDir)) {
    const path = preflightPath(runDir);
    const file = Bun.file(path);
    if (!(await file.exists())) continue;
    try {
      const parsed: unknown = JSON.parse(await file.text());
      if (isReusablePreflight(parsed)) return { path, file: parsed };
    } catch {
      // unreadable: try an older run
    }
  }
  return null;
}
```
The single `as` casts here are in `src/`, where they are allowed; the looseCast ratchet counts tests only.

`src/workflow/ledger-items.ts`:
```ts
/** What the story loops left for the branch review (spec §7 step 2): deferred minors, cannot-verify items, parked rulings. */
import { FEATURE_SCOPE } from "./advisor-live";
import { ledgerFilePath } from "./ledger";
import { runDirsNewestFirst } from "./result";

export interface LedgerItem {
  readonly storyId: string;
  readonly text: string;
}

export interface LedgerItems {
  readonly deferredMinors: readonly LedgerItem[];
  readonly cannotVerify: readonly LedgerItem[];
  readonly parked: readonly LedgerItem[];
}

type Kind = keyof LedgerItems;

const LINE = /^(\S+): (deferred-minor|cannot-verify|Ruling): (.+)$/;
const KIND: Readonly<Record<string, Kind>> = {
  "deferred-minor": "deferredMinors",
  "cannot-verify": "cannotVerify",
  Ruling: "parked",
};
const PREFLIGHT_RULING = /^pre-flight /;

function parseLine(line: string): { kind: Kind; item: LedgerItem } | null {
  const m = LINE.exec(line);
  if (!m || m[1] === FEATURE_SCOPE) return null;
  const kind = KIND[m[2] ?? ""];
  const text = (m[3] ?? "").trim();
  if (!kind || text === "" || (kind === "parked" && PREFLIGHT_RULING.test(text))) return null;
  return { kind, item: { storyId: m[1] ?? "", text } };
}

/** Every run's ledger, oldest run first; identical lines from a resumed story count once. */
export async function collectLedgerItems(featureDir: string): Promise<LedgerItems> {
  const out: Record<Kind, LedgerItem[]> = { deferredMinors: [], cannotVerify: [], parked: [] };
  const seen = new Set<string>();
  for (const runDir of [...(await runDirsNewestFirst(featureDir))].reverse()) {
    const file = Bun.file(ledgerFilePath(runDir));
    if (!(await file.exists())) continue;
    for (const line of (await file.text()).split("\n")) {
      const parsed = parseLine(line);
      const key = parsed ? `${parsed.kind}|${parsed.item.storyId}|${parsed.item.text}` : "";
      if (!parsed || seen.has(key)) continue;
      seen.add(key);
      out[parsed.kind] = [...out[parsed.kind], parsed.item];
    }
  }
  return out;
}
```

`src/workflow/tokens.ts`:
```ts
/** Token and cost totals per session role (spec §9 "token totals per role", P2-R3). */
import type { RoleTokens } from "./types";

/** The DispatchEvent fields the meter reads (structural, so any dispatch-event source fits). */
export interface MeterEvent {
  readonly sessionRole: string;
  readonly exactCostUsd?: number;
  readonly estimatedCostUsd?: number;
  readonly tokenUsage?: { readonly inputTokens?: number; readonly outputTokens?: number };
}

export interface DispatchSource {
  onDispatch(listener: (event: MeterEvent) => void): () => void;
}

export interface TokenMeter {
  totals(): RoleTokens;
  byRole(): Readonly<Record<string, RoleTokens>>;
  stop(): void;
}

export const EMPTY_TOKENS: RoleTokens = { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 };

function add(a: RoleTokens, b: RoleTokens): RoleTokens {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    costUsd: a.costUsd + b.costUsd,
    calls: a.calls + b.calls,
  };
}

export function addRoleTokens(
  a: Readonly<Record<string, RoleTokens>>,
  b: Readonly<Record<string, RoleTokens>>,
): Record<string, RoleTokens> {
  const roles = new Set([...Object.keys(a), ...Object.keys(b)]);
  return Object.fromEntries([...roles].map((r) => [r, add(a[r] ?? EMPTY_TOKENS, b[r] ?? EMPTY_TOKENS)]));
}

export function startTokenMeter(source: DispatchSource | undefined): TokenMeter {
  let byRole: Readonly<Record<string, RoleTokens>> = {};
  const unsubscribe =
    source?.onDispatch((e) => {
      const one: RoleTokens = {
        inputTokens: e.tokenUsage?.inputTokens ?? 0,
        outputTokens: e.tokenUsage?.outputTokens ?? 0,
        costUsd: e.exactCostUsd ?? e.estimatedCostUsd ?? 0,
        calls: 1,
      };
      byRole = { ...byRole, [e.sessionRole]: add(byRole[e.sessionRole] ?? EMPTY_TOKENS, one) };
    }) ?? (() => {});
  return {
    totals: () => Object.values(byRole).reduce(add, EMPTY_TOKENS),
    byRole: () => byRole,
    stop: unsubscribe,
  };
}
```

`src/workflow/stage.ts`:
- Replace the `costUsd` / `inputTokens` / `outputTokens` locals and the `onDispatch` subscription with `const meter = startTokenMeter(ctx.runtime?.dispatchEvents);`.
- Keep a `let storyEnv: Awaited<ReturnType<typeof _workflowStageDeps.buildStoryEnv>> | null = null;` set when built, in place of the current local destructuring.
- In `finally`, in this order: `meter.stop();`, then `if (storyEnv) await recordTokensSafe(storyEnv.env, meter.byRole(), ctx.story.id);`, then the existing dispose.
- Build `ctx.agentResult` from `const totals = meter.totals();` (`estimatedCostUsd: totals.costUsd`, `tokenUsage: { inputTokens: totals.inputTokens, outputTokens: totals.outputTokens }`).
- Add:
```ts
/** Per-role tokens onto the story record (spec §9); best effort, like the ledger line. */
async function recordTokensSafe(
  env: { readonly sink: { update(patch: { tokensByRole: Readonly<Record<string, RoleTokens>> }): Promise<void> } },
  byRole: Readonly<Record<string, RoleTokens>>,
  storyId: string,
): Promise<void> {
  try {
    await env.sink.update({ tokensByRole: byRole });
  } catch (err) {
    getLogger().debug("workflow", "Token totals not recorded", { storyId, error: errorMessage(err) });
  }
}
```
Import `startTokenMeter` from `./tokens` and `type RoleTokens` from `./types`.

- [ ] **Step 4: Run them to verify they pass**

Run the Step 2 command, then `timeout 120 bun test test/unit/workflow test/integration/workflow --timeout=60000`. Expected: PASS. The existing stage tests (dispatch subscribe/unsubscribe counts, agentResult totals) must pass unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/workflow test/unit/workflow
git commit -m "feat(workflow): feature record and resume state, ledger items, per-role token meter"
```

---

### Task 6: Feature context, I/O seam, repo gates and the branch review steps

**Files:**
- Create: `src/workflow/feature-context.ts`, `src/workflow/feature-deps.ts`, `src/workflow/repo-gates.ts`, `src/workflow/branch-review.ts`
- Modify: `src/workflow/story-review.ts` (`underReviewLimit` takes `Pick<StepContext, "runSignal" | "workflow">`)
- Create helper: `test/helpers/workflow-feature-context.ts` (`makeFeatureContext`), exported from `test/helpers/index.ts`
- Test: `test/unit/workflow/feature-context.test.ts`, `test/unit/workflow/repo-gates.test.ts`, `test/unit/workflow/branch-review.test.ts`

**Interfaces:**
- Consumes:
  - `resolveGateCommands` and `runQualityGates` (`@/finish`);
  - `buildRunDispatchAskWiring` (`@/interaction`);
  - `workflowBranchReviewOp` and `workflowReReviewOp` (`@/operations`);
  - the branch prompts (Task 3).
- Produces:
  ```ts
  // feature-context.ts
  export interface WorkflowFeatureInput {
    readonly runtime: NaxRuntime; readonly config: NaxConfig; readonly prd: PRD; readonly feature: string;
    readonly workdir: string; readonly branch: string; readonly runId: string; readonly agentName: string;
    readonly abortSignal?: AbortSignal; readonly interactionChain?: InteractionChain | null;
    readonly statusWriter?: { setWorkflowStatus?(block: WorkflowStatusBlock): void };
  }
  export interface FeatureContext {
    readonly callCtx: CallContext; readonly config: NaxConfig; readonly workflow: WorkflowConfig; readonly prd: PRD;
    readonly feature: string; readonly projectDir: string; readonly branch: string; readonly runId: string;
    readonly outputDir: string; readonly runDir: string; readonly featureDir: string; readonly prdPath: string;
    readonly reportPath: string; readonly packageDirs: readonly string[]; readonly runSignal?: AbortSignal; readonly dryRun: boolean;
  }
  export const _featureContextDeps: { buildRunDispatchAskWiring: typeof buildRunDispatchAskWiring };
  export function buildFeatureContext(input: WorkflowFeatureInput): Promise<{ fc: FeatureContext; dispose: () => Promise<void> }>;
  // feature-deps.ts
  export const _featureDeps: { forge; detectForge; resolveGateCommands; runQualityGates; commitAndPush; openDraftFinishPr; openOrPromotePr; waitForChecks };
  // repo-gates.ts
  export interface RepoGateRun { readonly summary: RepoGateSummary; readonly findings: readonly WorkflowFindingDraft[] }
  export function gateExcerpt(output: string, name: string): string;
  export function runRepoGates(fc: FeatureContext): Promise<RepoGateRun>;
  // branch-review.ts
  export type BranchReviewFacts = Pick<BranchReviewPromptInput, "stories" | "minors" | "parked" | "cannotVerify" | "gateFindings">;
  export function writeFeatureArtifact(fc: FeatureContext, name: string, value: unknown): Promise<void>;
  export function branchReviewModel(fc: FeatureContext): ConfiguredModel | undefined;
  export function runBranchReview(fc: FeatureContext, input: { seed: string; specPath?: string; preflightPath?: string; facts: BranchReviewFacts }): Promise<ReviewOutcome<BranchReviewVerdict>>;
  export function runBranchReReview(fc: FeatureContext, input: { specPath?: string; findings: readonly WorkflowFinding[]; fixBase: string }): Promise<ReviewOutcome<ReReviewVerdict>>;
  ```
  `WorkflowStatusBlock` is added to `@/execution` in Task 11. In this task, declare `statusWriter` as `{ setWorkflowStatus?(block: { step: string }): void }`; Task 11 narrows it to `WorkflowStatusBlock`.

- [ ] **Step 1: Write the failing tests**

`test/helpers/workflow-feature-context.ts`:
```ts
import { resolveWorkflowConfig } from "@/config";
import type { FeatureContext } from "@/workflow/feature-context";
import { makeNaxConfig } from "./mock-nax-config";
import { makeTestPRD } from "./pipeline-context";
```
then:
```ts
export function makeFeatureContext(overrides: Partial<FeatureContext> = {}): FeatureContext {
  const config = makeNaxConfig();
  return {
    callCtx: makeMockCallContext(),
    config,
    workflow: resolveWorkflowConfig(config),
    prd: makeTestPRD(),
    feature: "f",
    projectDir: "/repo",
    branch: "feat/x",
    runId: "r1",
    outputDir: "/out",
    runDir: "/out/workflow/f/r1",
    featureDir: "/out/workflow/f",
    prdPath: "/repo/.nax/features/f/prd.json",
    reportPath: "/out/workflow/f/r1/feature-report.md",
    packageDirs: [],
    dryRun: false,
    ...overrides,
  };
}
```
Import `makeMockCallContext` the same way `test/helpers/workflow-step-context.ts` does, and match that file's other import paths. Add `export { makeFeatureContext } from "./workflow-feature-context";` to `test/helpers/index.ts` next to `makeStepContext`.

`test/unit/workflow/feature-context.test.ts`:
```ts
import { afterEach, describe, expect, test } from "bun:test";
import { makeNaxConfig, makeTestPRD, makeTestRuntime, makeTestStory } from "@test/helpers";
import { _featureContextDeps, buildFeatureContext } from "@/workflow/feature-context";

const original = { ..._featureContextDeps };
afterEach(() => Object.assign(_featureContextDeps, original));

describe("buildFeatureContext", () => {
  test("root-config CallContext with the ask wiring, stage merge, and the run's paths", async () => {
    const seen: Record<string, unknown>[] = [];
    let disposed = false;
    _featureContextDeps.buildRunDispatchAskWiring = async (opts) => {
      seen.push({ stage: opts.stage, featureName: opts.featureName, packageDirs: opts.packageDirs });
      return { askResolver: async () => ({ approved: false }), dispose: async () => { disposed = true; } };
    };
    const config = makeNaxConfig({ outputDir: "/out" });
    const runtime = makeTestRuntime({ config, workdir: "/repo" });
    const prd = makeTestPRD([makeTestStory({ id: "US-001", workdir: "packages/api" }), makeTestStory({ id: "US-002" })]);
    const { fc, dispose } = await buildFeatureContext({
      runtime,
      config,
      prd,
      feature: "f",
      workdir: "/repo",
      branch: "feat/x",
      runId: "r1",
      agentName: "claude",
    });
    expect(seen[0]).toEqual({ stage: "merge", featureName: "f", packageDirs: ["packages/api", undefined] });
    expect(fc.callCtx.featureName).toBe("f");
    expect(fc.callCtx.storyId).toBeUndefined();
    expect(fc.callCtx.askResolver).toBeDefined();
    expect(fc.runDir).toBe(`${runtime.outputDir}/workflow/f/r1`);
    expect(fc.featureDir).toBe(`${runtime.outputDir}/workflow/f`);
    expect(fc.prdPath).toBe("/repo/.nax/features/f/prd.json");
    expect(fc.reportPath).toBe(`${runtime.outputDir}/workflow/f/r1/feature-report.md`);
    expect(fc.packageDirs).toEqual(["packages/api"]);
    await dispose();
    expect(disposed).toBe(true);
    await runtime.close();
  });
});
```
Before writing, read `DispatchAskWiring` in `src/interaction/dispatch-ask.ts`. The fake must return that exact shape: fill every required field, with `commandShadow` omitted if it is optional. If `askResolver`'s signature differs, use a no-op of the right signature. Adjust the `packageDirs` expectation to whatever `storyPackageDir` returns for a story with no `workdir`. Keep the assertion that the list is passed through unfiltered.

`test/unit/workflow/repo-gates.test.ts`:
```ts
import { afterEach, describe, expect, test } from "bun:test";
import { makeFeatureContext } from "@test/helpers";
import { _featureDeps } from "@/workflow/feature-deps";
import { gateExcerpt, runRepoGates } from "@/workflow/repo-gates";

const original = { ..._featureDeps };
afterEach(() => Object.assign(_featureDeps, original));

describe("gateExcerpt", () => {
  test("the named gate's chunk, without its header line", () => {
    const out = "[build] exit=0\nok\n\n[lint] exit=1\nsrc/a.ts:1 no-var\nsrc/b.ts:2 eqeqeq";
    expect(gateExcerpt(out, "lint")).toBe("src/a.ts:1 no-var\nsrc/b.ts:2 eqeqeq");
    expect(gateExcerpt(out, "test")).toBe("");
  });

  test("keeps only the last 40 lines", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`);
    const excerpt = gateExcerpt(`[test] exit=1\n${lines.join("\n")}`, "test");
    expect(excerpt.split("\n")).toHaveLength(40);
    expect(excerpt.endsWith("line 99")).toBe(true);
  });
});

describe("runRepoGates", () => {
  test("passes the feature's package dirs; one finding per failing gate", async () => {
    const seen: string[][] = [];
    _featureDeps.resolveGateCommands = async (_root, packageDirs) => {
      seen.push(packageDirs);
      return [];
    };
    _featureDeps.runQualityGates = async () => ({
      passed: false,
      ran: ["build", "lint"],
      failing: ["lint"],
      output: "[build] exit=0\n\n[lint] exit=1\nno-var",
    });
    const run = await runRepoGates(makeFeatureContext({ packageDirs: ["packages/api"] }));
    expect(seen).toEqual([["packages/api"]]);
    expect(run.summary).toEqual({ ran: ["build", "lint"], failing: ["lint"] });
    expect(run.findings).toEqual([{ kind: "gate", severity: "important", issue: "repo gate lint failed:\nno-var" }]);
  });

  test("nothing configured: nothing ran, no findings (a draft reason later, not a red gate)", async () => {
    _featureDeps.resolveGateCommands = async () => [];
    _featureDeps.runQualityGates = async () => ({ passed: false, ran: [], failing: [], output: "nothing" });
    expect(await runRepoGates(makeFeatureContext())).toEqual({ summary: { ran: [], failing: [] }, findings: [] });
  });

  test("a gate runner throw becomes one red repo-gates finding; abort rethrows", async () => {
    _featureDeps.resolveGateCommands = async () => {
      throw new Error("config load failed");
    };
    const run = await runRepoGates(makeFeatureContext());
    expect(run.summary.failing).toEqual(["repo-gates"]);
    expect(run.findings[0]?.issue).toContain("config load failed");
    const ac = new AbortController();
    ac.abort();
    await expect(runRepoGates(makeFeatureContext({ runSignal: ac.signal }))).rejects.toThrow("config load failed");
  });
});
```
Read `QualityGateResult` in `src/finish/types.ts`. If it has more required fields than `passed/ran/failing/output`, add them to the fakes.

`test/unit/workflow/branch-review.test.ts`:
```ts
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanupTempDir, makeFeatureContext, makeScriptedCallOp, makeTempDir } from "@test/helpers";
import { workflowBranchReviewOp, workflowReReviewOp } from "@/operations";
import { runBranchReReview, runBranchReview } from "@/workflow/branch-review";
import { _workflowDeps } from "@/workflow/step-context";
import type { BranchReviewVerdict } from "@/workflow/types";

const original = { ..._workflowDeps };
const dirs: string[] = [];
afterEach(async () => {
  Object.assign(_workflowDeps, original);
  await Promise.all(dirs.map(cleanupTempDir));
  dirs.length = 0;
});

function fc(over = {}) {
  const runDir = makeTempDir("wf-br-");
  dirs.push(runDir);
  _workflowDeps.git = async () => ({ stdout: "", exitCode: 0 });
  return makeFeatureContext({ runDir, ...over });
}

const facts = {
  stories: [{ id: "US-001", state: "complete" }],
  minors: [{ id: "M1", storyId: "US-001", text: "rename tmp" }],
  parked: [],
  cannotVerify: [],
  gateFindings: [],
};

describe("runBranchReview", () => {
  test("writes package-branch.diff from the seed and branch-review.json; passes the minor ids", async () => {
    const ctx = fc();
    const gitCalls: string[][] = [];
    _workflowDeps.git = async (args) => {
      gitCalls.push(args);
      return { stdout: "", exitCode: 0 };
    };
    const verdict: BranchReviewVerdict = {
      spec: "pass",
      quality: "approved",
      findings: [],
      cannotVerify: [],
      minorTriage: [{ id: "M1", decision: "fix-now" }],
    };
    const inputs: unknown[] = [];
    _workflowDeps.callOp = makeScriptedCallOp((op, input) => {
      expect(op.name).toBe(workflowBranchReviewOp.name);
      inputs.push(input);
      return verdict;
    });
    const out = await runBranchReview(ctx, { seed: "seed0", specPath: "spec.md", facts });
    expect(out).toEqual({ ran: true, verdict });
    expect(gitCalls.some((a) => a.includes("seed0..HEAD"))).toBe(true);
    expect(await Bun.file(join(ctx.runDir, "package-branch.diff")).exists()).toBe(true);
    expect(await Bun.file(join(ctx.runDir, "branch-review.json")).json()).toEqual(verdict);
    expect(inputs[0]).toMatchObject({ minorIds: ["M1"], timeoutMs: ctx.workflow.timeouts.reviewMs });
  });

  test("unparseable reply -> not run, no artifact", async () => {
    const ctx = fc();
    _workflowDeps.callOp = makeScriptedCallOp(() => null);
    expect(await runBranchReview(ctx, { seed: "s", facts })).toEqual({ ran: false, why: "unparseable reply" });
    expect(await Bun.file(join(ctx.runDir, "branch-review.json")).exists()).toBe(false);
  });
});

describe("runBranchReReview", () => {
  test("re-review op on the fix diff with the branch model; writes branch-rereview.json", async () => {
    const ctx = fc({ workflow: { ...makeFeatureContext().workflow, models: { branchReview: "powerful" } } });
    const inputs: unknown[] = [];
    _workflowDeps.callOp = makeScriptedCallOp((op, input) => {
      expect(op.name).toBe(workflowReReviewOp.name);
      inputs.push(input);
      return { verdicts: [{ id: "B1", addressed: true, note: "" }], newFindings: [] };
    });
    const out = await runBranchReReview(ctx, {
      findings: [{ id: "B1", kind: "quality", severity: "important", issue: "drift" }],
      fixBase: "fix0",
    });
    expect(out.ran).toBe(true);
    expect(inputs[0]).toMatchObject({ openIds: ["B1"], model: "powerful" });
    expect(await Bun.file(join(ctx.runDir, "package-branch-fix.diff")).exists()).toBe(true);
    expect(await Bun.file(join(ctx.runDir, "branch-rereview.json")).exists()).toBe(true);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `timeout 60 bun test test/unit/workflow/feature-context.test.ts test/unit/workflow/repo-gates.test.ts test/unit/workflow/branch-review.test.ts --timeout=60000`
Expected: FAIL (the modules don't exist).

- [ ] **Step 3: Implement**

`src/workflow/story-review.ts`: change `underReviewLimit`'s first parameter type to `sc: Pick<StepContext, "runSignal" | "workflow">`. The body is unchanged, and so are its callers.

`src/workflow/feature-context.ts`:
```ts
/** The feature-level context (spec §7): root config, one feature CallContext, and the run's paths. */
import { join } from "node:path";
import { featureDir, type NaxConfig, resolveWorkflowConfig, type WorkflowConfig } from "@/config";
import { buildRunDispatchAskWiring, type InteractionChain } from "@/interaction";
import type { CallContext } from "@/operations";
import type { PRD } from "@/prd";
import type { NaxRuntime } from "@/runtime";
import { storyPackageDir } from "@/utils/path-frame";
import { workflowFeatureDir, workflowRunDir } from "./paths";

export interface WorkflowFeatureInput {
  readonly runtime: NaxRuntime;
  /** The run's root config. */
  readonly config: NaxConfig;
  readonly prd: PRD;
  readonly feature: string;
  /** Repo root. */
  readonly workdir: string;
  readonly branch: string;
  readonly runId: string;
  readonly agentName: string;
  readonly abortSignal?: AbortSignal;
  readonly interactionChain?: InteractionChain | null;
  readonly statusWriter?: { setWorkflowStatus?(block: { step: string }): void };
}

export interface FeatureContext {
  readonly callCtx: CallContext;
  readonly config: NaxConfig;
  readonly workflow: WorkflowConfig;
  readonly prd: PRD;
  readonly feature: string;
  readonly projectDir: string;
  readonly branch: string;
  readonly runId: string;
  readonly outputDir: string;
  /** This run's workflow dir. */
  readonly runDir: string;
  /** Every run of this feature (`workflow/<feature>`). */
  readonly featureDir: string;
  readonly prdPath: string;
  /** `<runDir>/feature-report.md`. */
  readonly reportPath: string;
  /** Distinct story package dirs (repo-relative), for the repo gates. */
  readonly packageDirs: readonly string[];
  readonly runSignal?: AbortSignal;
  readonly dryRun: boolean;
}

export const _featureContextDeps = { buildRunDispatchAskWiring };

export async function buildFeatureContext(
  input: WorkflowFeatureInput,
): Promise<{ fc: FeatureContext; dispose: () => Promise<void> }> {
  const storyPackageDirs = input.prd.userStories.map(storyPackageDir);
  // ADR-031: a whole-feature op uses root config; the branch fix declares Bash, so the ask wiring is required.
  const dispatchAsk = await _featureContextDeps.buildRunDispatchAskWiring({
    config: input.config,
    rootConfig: input.config,
    projectDir: input.workdir,
    packageDirs: storyPackageDirs,
    interaction: input.interactionChain,
    outputDir: input.runtime.outputDir,
    runId: input.runId,
    repoRoot: input.workdir,
    featureName: input.feature,
    abortSignal: input.abortSignal,
    stage: "merge",
  });
  const callCtx: CallContext = {
    runtime: input.runtime,
    packageView: input.runtime.packages.resolve(input.workdir),
    packageDir: input.workdir,
    config: input.config,
    agentName: input.agentName,
    featureName: input.feature,
    ...(input.abortSignal ? { signal: input.abortSignal } : {}),
    askResolver: dispatchAsk.askResolver,
    ...(dispatchAsk.commandShadow ? { commandShadow: dispatchAsk.commandShadow } : {}),
  };
  const runDir = workflowRunDir(input.runtime.outputDir, input.feature, input.runId);
  const fc: FeatureContext = {
    callCtx,
    config: input.config,
    workflow: resolveWorkflowConfig(input.config),
    prd: input.prd,
    feature: input.feature,
    projectDir: input.workdir,
    branch: input.branch,
    runId: input.runId,
    outputDir: input.runtime.outputDir,
    runDir,
    featureDir: workflowFeatureDir(input.runtime.outputDir, input.feature),
    prdPath: join(featureDir(input.workdir, input.feature), "prd.json"),
    reportPath: join(runDir, "feature-report.md"),
    packageDirs: [...new Set(storyPackageDirs.filter((d): d is string => typeof d === "string" && d !== ""))],
    ...(input.abortSignal ? { runSignal: input.abortSignal } : {}),
    dryRun: input.runtime.dryRun === true,
  };
  return { fc, dispose: () => dispatchAsk.dispose() };
}
```
If `RunDispatchAskOptions.abortSignal` is required (non-optional), pass `abortSignal: input.abortSignal ?? new AbortController().signal`.

`src/workflow/feature-deps.ts`:
```ts
/** The feature workflow's I/O seam (forge, repo gates, push, PR, CI). Tests replace fields; production uses these. */
import { commitAndPush, openDraftFinishPr, openOrPromotePr, resolveGateCommands, runQualityGates } from "@/finish";
import { defaultForgeDeps, detectForge, type ForgeDeps, type ForgeKind } from "@/forge";
import { waitForChecks } from "./ci-wait";

export const _featureDeps = {
  forge: defaultForgeDeps as ForgeDeps,
  detectForge: (projectDir: string): Promise<ForgeKind | null> => detectForge(defaultForgeDeps, projectDir),
  resolveGateCommands,
  runQualityGates,
  commitAndPush,
  openDraftFinishPr,
  openOrPromotePr,
  waitForChecks,
};
```
(`defaultForgeDeps` is already typed `ForgeDeps`. The annotation just widens the field so a test fake assigns cleanly. If biome flags the `as` as redundant, drop it.)

`src/workflow/repo-gates.ts`:
```ts
/** Repo gates (spec §7 steps 1 and 6, P4-R5): every configured quality command across the feature's packages. */
import { errorMessage } from "@nathapp/nax-agent/internal";
import type { FeatureContext } from "./feature-context";
import { _featureDeps } from "./feature-deps";
import type { RepoGateSummary, WorkflowFindingDraft } from "./types";

export const GATE_EXCERPT_LINES = 40;
const GATE_EXCERPT_CHARS = 4_000;
const CHUNK_SPLIT = /\n\n(?=\[)/;

export interface RepoGateRun {
  readonly summary: RepoGateSummary;
  readonly findings: readonly WorkflowFindingDraft[];
}

/** The tail of one gate's chunk in runQualityGates' combined output (`[name] exit=N\n…`). */
export function gateExcerpt(output: string, name: string): string {
  const chunk = output.split(CHUNK_SPLIT).find((c) => c.startsWith(`[${name}] exit=`)) ?? "";
  const tail = chunk.split("\n").slice(1).slice(-GATE_EXCERPT_LINES).join("\n");
  return tail.length > GATE_EXCERPT_CHARS ? tail.slice(-GATE_EXCERPT_CHARS) : tail;
}

export async function runRepoGates(fc: FeatureContext): Promise<RepoGateRun> {
  try {
    const commands = await _featureDeps.resolveGateCommands(fc.projectDir, [...fc.packageDirs]);
    const res = await _featureDeps.runQualityGates(fc.projectDir, commands);
    return {
      summary: { ran: res.ran, failing: res.failing },
      findings: res.failing.map((name) => ({
        kind: "gate" as const,
        severity: "important" as const,
        issue: `repo gate ${name} failed:\n${gateExcerpt(res.output, name)}`,
      })),
    };
  } catch (err) {
    if (fc.runSignal?.aborted) throw err;
    return {
      summary: { ran: ["repo-gates"], failing: ["repo-gates"] },
      findings: [{ kind: "gate", severity: "important", issue: `repo gates errored: ${errorMessage(err)}` }],
    };
  }
}
```

`src/workflow/branch-review.ts`:
```ts
/** The whole-branch review (spec §7 step 2) and its scoped re-review (step 4). Never throw except on abort. */
import { join } from "node:path";
import { errorMessage } from "@nathapp/nax-agent/internal";
import type { ConfiguredModel } from "@/config";
import { getLogger } from "@/logger";
import { workflowBranchReviewOp, workflowReReviewOp } from "@/operations";
import {
  type BranchReviewPromptInput,
  buildWorkflowBranchReReviewPrompt,
  buildWorkflowBranchReviewPrompt,
} from "@/prompts";
import type { FeatureContext } from "./feature-context";
import { writeReviewPackage } from "./git";
import { _workflowDeps } from "./step-context";
import { type ReviewOutcome, underReviewLimit } from "./story-review";
import type { BranchReviewVerdict, ReReviewVerdict, WorkflowFinding } from "./types";

export type BranchReviewFacts = Pick<
  BranchReviewPromptInput,
  "stories" | "minors" | "parked" | "cannotVerify" | "gateFindings"
>;

/** Feature artifacts are best effort: a write failure is logged and the step goes on. */
export async function writeFeatureArtifact(fc: FeatureContext, name: string, value: unknown): Promise<void> {
  try {
    await Bun.write(join(fc.runDir, name), `${JSON.stringify(value, null, 2)}\n`);
  } catch (err) {
    getLogger().warn("workflow", `Could not write ${name}, continuing`, { storyId: "_run", error: errorMessage(err) });
  }
}

/** The branch reviewer's model (spec §4): workflow.models.branchReview, then finish.reviewers.quality. */
export function branchReviewModel(fc: FeatureContext): ConfiguredModel | undefined {
  return fc.workflow.models.branchReview ?? fc.config.finish?.reviewers?.quality ?? undefined;
}

export async function runBranchReview(
  fc: FeatureContext,
  input: { seed: string; specPath?: string; preflightPath?: string; facts: BranchReviewFacts },
): Promise<ReviewOutcome<BranchReviewVerdict>> {
  const packagePath = join(fc.runDir, "package-branch.diff");
  const prompt = buildWorkflowBranchReviewPrompt({
    ...(input.specPath ? { specPath: input.specPath } : {}),
    prdPath: fc.prdPath,
    ...(input.preflightPath ? { preflightPath: input.preflightPath } : {}),
    packagePath,
    ...input.facts,
  });
  const outcome = await underReviewLimit(
    fc,
    () => writeReviewPackage(fc.projectDir, input.seed, packagePath),
    (signal) =>
      _workflowDeps.callOp({ ...fc.callCtx, ...(signal ? { signal } : {}) }, workflowBranchReviewOp, {
        prompt,
        timeoutMs: fc.workflow.timeouts.reviewMs,
        minorIds: input.facts.minors.map((m) => m.id),
      }),
  );
  if (outcome.ran) await writeFeatureArtifact(fc, "branch-review.json", outcome.verdict);
  return outcome;
}

export async function runBranchReReview(
  fc: FeatureContext,
  input: { specPath?: string; findings: readonly WorkflowFinding[]; fixBase: string },
): Promise<ReviewOutcome<ReReviewVerdict>> {
  const packagePath = join(fc.runDir, "package-branch-fix.diff");
  const prompt = buildWorkflowBranchReReviewPrompt({
    ...(input.specPath ? { specPath: input.specPath } : {}),
    reportPath: fc.reportPath,
    packagePath,
    findings: input.findings,
  });
  const model = branchReviewModel(fc);
  const outcome = await underReviewLimit(
    fc,
    () => writeReviewPackage(fc.projectDir, input.fixBase, packagePath),
    (signal) =>
      _workflowDeps.callOp({ ...fc.callCtx, ...(signal ? { signal } : {}) }, workflowReReviewOp, {
        prompt,
        openIds: input.findings.map((f) => f.id),
        timeoutMs: fc.workflow.timeouts.reviewMs,
        ...(model !== undefined ? { model } : {}),
      }),
  );
  if (outcome.ran) await writeFeatureArtifact(fc, "branch-rereview.json", outcome.verdict);
  return outcome;
}
```
`fc.config.finish` may be typed non-optional, so the `?.` is defensive. Keep it if biome accepts it, and drop the `?.` on `finish` only if biome reports `noUnnecessaryCondition`.

- [ ] **Step 4: Run them to verify they pass**

Run the Step 2 command, then `timeout 120 bun test test/unit/workflow --timeout=60000`, `bun run check:import-cycles`, and `bun run check:bash-dispatch-ask`. Expected: all PASS. `src/workflow` → `@/finish` is a new edge; nothing in `@/finish` reaches `src/workflow` statically.

- [ ] **Step 5: Commit**

```bash
git add src/workflow test/helpers test/unit/workflow
git commit -m "feat(workflow): feature context, I/O seam, repo gates and branch review steps"
```

---
### Task 7: The branch fix step

**Files:**
- Create: `src/workflow/branch-fix.ts`
- Test: `test/unit/workflow/branch-fix.test.ts`

**Interfaces:**
- Consumes: `workflowBranchFixOp`, `buildWorkflowBranchFixPrompt` (Task 3); `FeatureContext`, `makeFeatureContext` (Task 6); `listUncommitted` (`./git`); `_workflowDeps.callOp` / `autoCommitIfDirty`.
- Produces:
  ```ts
  export interface BranchFixOutcome { readonly reply?: ImplementerReply; readonly failure?: string; readonly autoCommitted: boolean }
  export function runBranchFix(fc: FeatureContext, input: { specPath?: string; findings: readonly WorkflowFinding[] }): Promise<BranchFixOutcome>;
  ```

- [ ] **Step 1: Write the failing test**

`test/unit/workflow/branch-fix.test.ts`:
```ts
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanupTempDir, makeFeatureContext, makeScriptedCallOp, makeTempDir } from "@test/helpers";
import { workflowBranchFixOp } from "@/operations";
import { runBranchFix } from "@/workflow/branch-fix";
import { _workflowDeps } from "@/workflow/step-context";
import type { ImplementerReply, WorkflowFinding } from "@/workflow/types";

const original = { ..._workflowDeps };
const dirs: string[] = [];
afterEach(async () => {
  Object.assign(_workflowDeps, original);
  await Promise.all(dirs.map(cleanupTempDir));
  dirs.length = 0;
});

const findings: WorkflowFinding[] = [{ id: "B1", kind: "quality", severity: "important", issue: "drift" }];
const done: ImplementerReply = { status: "DONE", commits: ["a1"], testSummary: "3 pass", interrupted: false };

function setup(reply: ImplementerReply | Error, dirty: string) {
  const runDir = makeTempDir("wf-bf-");
  dirs.push(runDir);
  const fc = makeFeatureContext({ runDir, reportPath: join(runDir, "feature-report.md") });
  const inputs: unknown[] = [];
  const commits: unknown[][] = [];
  _workflowDeps.callOp = makeScriptedCallOp((op, input) => {
    expect(op.name).toBe(workflowBranchFixOp.name);
    inputs.push(input);
    if (reply instanceof Error) throw reply;
    return reply;
  });
  _workflowDeps.git = async () => ({ stdout: dirty, exitCode: 0 });
  _workflowDeps.autoCommitIfDirty = async (...args: unknown[]) => {
    commits.push(args);
  };
  return { fc, inputs, commits };
}

describe("runBranchFix", () => {
  test("creates feature-report.md, runs the fix op under fixMs, auto-commits leftover edits", async () => {
    const { fc, inputs, commits } = setup(done, " M src/a.ts\n");
    const out = await runBranchFix(fc, { specPath: "spec.md", findings });
    expect(out).toEqual({ reply: done, autoCommitted: true });
    expect(await Bun.file(fc.reportPath).text()).toContain("# Feature report — f");
    expect(inputs[0]).toMatchObject({ timeoutMs: fc.workflow.timeouts.fixMs });
    expect(String((inputs[0] as { prompt: string }).prompt)).toContain("[B1]");
    expect(commits[0]?.slice(0, 4)).toEqual([fc.projectDir, "workflow", "wf-branch-fix", "_run"]);
  });

  test("a clean tree is not committed", async () => {
    const { fc, commits } = setup(done, "");
    expect((await runBranchFix(fc, { findings })).autoCommitted).toBe(false);
    expect(commits).toHaveLength(0);
  });

  test("an interrupted turn still commits its edits: no later round will pick them up", async () => {
    const { fc } = setup({ ...done, interrupted: true }, " M src/a.ts\n");
    expect((await runBranchFix(fc, { findings })).autoCommitted).toBe(true);
  });

  test("a session failure is returned, not thrown; reply.failure likewise", async () => {
    expect((await runBranchFix(setup(new Error("503"), "").fc, { findings })).failure).toBe("503");
    const failed = { ...done, failure: 'Agent "native" failed: quota' };
    expect((await runBranchFix(setup(failed, "").fc, { findings })).failure).toContain("quota");
  });

  test("an existing report is not overwritten", async () => {
    const { fc } = setup(done, "");
    await Bun.write(fc.reportPath, "# Feature report — f\n\n## Branch fix\nearlier\n");
    await runBranchFix(fc, { findings });
    expect(await Bun.file(fc.reportPath).text()).toContain("earlier");
  });

  test("abort rethrows", async () => {
    const ac = new AbortController();
    ac.abort();
    const { fc } = setup(new Error("stopped"), "");
    await expect(runBranchFix({ ...fc, runSignal: ac.signal }, { findings })).rejects.toThrow("stopped");
  });
});
```
`(inputs[0] as { prompt: string })` is one single-`as` cast. If the looseCast ratchet rejects it, type `inputs` as `{ prompt: string; timeoutMs: number }[]` and push the input after narrowing (`typeof input === "object" && input !== null && "prompt" in input`). If `_workflowDeps.autoCommitIfDirty`'s type doesn't accept a rest-args fake, declare the fake with the real parameter list (read `autoCommitIfDirty` in `src/utils/git.ts`).

- [ ] **Step 2: Run it to verify it fails**

Run: `timeout 60 bun test test/unit/workflow/branch-fix.test.ts --timeout=60000`
Expected: FAIL (`@/workflow/branch-fix` can't be resolved).

- [ ] **Step 3: Implement `src/workflow/branch-fix.ts`**

```ts
/**
 * The one branch fix (spec §7 step 3). Fresh session, write tools, the fix time limit.
 * Leftover edits are always committed (even after an interrupt: no later round picks them up),
 * and the fix appends its section to feature-report.md.
 */
import { errorMessage } from "@nathapp/nax-agent/internal";
import { workflowBranchFixOp } from "@/operations";
import { buildWorkflowBranchFixPrompt } from "@/prompts";
import { FEATURE_SCOPE } from "./advisor-live";
import type { FeatureContext } from "./feature-context";
import { listUncommitted } from "./git";
import { _workflowDeps } from "./step-context";
import type { ImplementerReply, WorkflowFinding } from "./types";

export interface BranchFixOutcome {
  readonly reply?: ImplementerReply;
  readonly failure?: string;
  readonly autoCommitted: boolean;
}

async function ensureReport(fc: FeatureContext): Promise<void> {
  if (await Bun.file(fc.reportPath).exists()) return;
  await Bun.write(fc.reportPath, `# Feature report — ${fc.feature}\n\nThe branch fix appends its section below.\n`);
}

async function commitLeftovers(fc: FeatureContext): Promise<boolean> {
  if ((await listUncommitted(fc.projectDir)).length === 0) return false;
  await _workflowDeps.autoCommitIfDirty(fc.projectDir, "workflow", "wf-branch-fix", FEATURE_SCOPE, undefined, fc.dryRun);
  return true;
}

export async function runBranchFix(
  fc: FeatureContext,
  input: { specPath?: string; findings: readonly WorkflowFinding[] },
): Promise<BranchFixOutcome> {
  await ensureReport(fc);
  const prompt = buildWorkflowBranchFixPrompt({
    ...(input.specPath ? { specPath: input.specPath } : {}),
    prdPath: fc.prdPath,
    reportPath: fc.reportPath,
    findings: input.findings,
  });
  let reply: ImplementerReply;
  try {
    reply = await _workflowDeps.callOp(fc.callCtx, workflowBranchFixOp, {
      prompt,
      timeoutMs: fc.workflow.timeouts.fixMs,
    });
  } catch (err) {
    if (fc.runSignal?.aborted) throw err;
    return { failure: errorMessage(err), autoCommitted: false };
  }
  if (reply.failure) return { reply, failure: reply.failure, autoCommitted: false };
  return { reply, autoCommitted: await commitLeftovers(fc) };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/workflow/branch-fix.ts test/unit/workflow/branch-fix.test.ts
git commit -m "feat(workflow): the one branch fix step"
```

---

### Task 8: Readiness, approval and the workflow PR body

**Files:**
- Modify: `src/finish/pr/body.ts` (export `buildAdvisorSection`), `src/finish/pr/index.ts`, `src/finish/index.ts`
- Create: `src/workflow/approval.ts`, `src/workflow/pr-body.ts`
- Test: `test/unit/workflow/approval.test.ts`, `test/unit/workflow/pr-body.test.ts`

**Interfaces:**
- Consumes: `buildMenu`, `Advisor` (`@/advisor`); `isFlaggedRuling` (Task 4); `StorySummary`, `RepoGateSummary`, `FeatureCiState`, `FeatureOutcome` (Task 5); `PreflightFile` (PR3).
- Produces:
  ```ts
  // @/finish barrel
  export function buildAdvisorSection(decisions: AdviceDecision[] | undefined): string | null;
  export function escapeInline(value: string, max?: number): string;
  export function escapeTableCell(value: string, max?: number): string;
  // workflow/approval.ts
  export interface ReadinessFacts { readonly finalGates?: RepoGateSummary; readonly ci: FeatureCiState; readonly stories: readonly StorySummary[]; readonly flagged: number; readonly branchReviewRan: boolean }
  export function readinessReasons(f: ReadinessFacts): string[];
  export function featurePassed(f: Pick<ReadinessFacts, "finalGates" | "stories">): boolean;
  export function flaggedCount(stories: readonly StorySummary[], preflight: PreflightFile | null, rulings: readonly WorkflowRuling[]): number;
  export function askApproval(advisor: Advisor, input: { feature: string; evidence: readonly string[] }): Promise<{ approved: boolean; rationale: string }>;
  // workflow/pr-body.ts
  export interface WorkflowPrBodyFacts { feature; stories; preflight; decisions; rulings; minorsLeft; finalGates?; assumptions }
  export interface WorkflowPrBodyInput extends WorkflowPrBodyFacts { readonly outcome: FeatureOutcome; readonly ci: FeatureCiState; readonly reasons: readonly string[] }
  export function buildWorkflowPrBody(input: WorkflowPrBodyInput): string;
  export function extractAssumptions(report: string): string;
  ```

- [ ] **Step 1: Write the failing tests**

`test/unit/workflow/approval.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { makeAdviceDecision } from "@test/helpers";
import type { Advisor, QuestionDraft } from "@/advisor";
import { askApproval, featurePassed, flaggedCount, type ReadinessFacts, readinessReasons } from "@/workflow/approval";
import type { StorySummary } from "@/workflow/types";

const story = (id: string, over: Partial<StorySummary> = {}): StorySummary => ({
  id,
  title: id,
  state: "complete",
  rounds: 0,
  unreviewed: false,
  flagged: 0,
  ...over,
});
const READY: ReadinessFacts = {
  finalGates: { ran: ["build", "test"], failing: [] },
  ci: "pending",
  stories: [story("US-001")],
  flagged: 0,
  branchReviewRan: true,
};

describe("readinessReasons (spec §7.8, P4-R6)", () => {
  test("all conditions hold -> no reasons; CI pending does not block (W-R9)", () => {
    expect(readinessReasons(READY)).toEqual([]);
  });

  test.each([
    [{ finalGates: { ran: [], failing: [] } }, "no quality commands configured — nothing was verified"],
    [{ finalGates: undefined }, "no quality commands configured — nothing was verified"],
    [{ finalGates: { ran: ["lint"], failing: ["lint"] } }, "gates red: lint"],
    [{ ci: "failed" as const }, "CI failed"],
    [{ stories: [story("US-001", { state: "complete-gate-open" })] }, "stories gate-open: US-001"],
    [{ stories: [story("US-002", { state: "not-run" })] }, "stories not run: US-002"],
    [{ flagged: 2 }, "2 ruling(s) flagged for a human"],
    [{ branchReviewRan: false }, "branch review did not run"],
  ])("%p -> %s", (over, reason) => {
    expect(readinessReasons({ ...READY, ...over })).toEqual([reason]);
  });
});

describe("featurePassed (P4-R13)", () => {
  test("true with green gates and complete stories, even with nothing configured", () => {
    expect(featurePassed(READY)).toBe(true);
    expect(featurePassed({ ...READY, finalGates: { ran: [], failing: [] } })).toBe(true);
  });

  test("false on a failing gate, a gate-open story or a not-run story", () => {
    expect(featurePassed({ ...READY, finalGates: { ran: ["lint"], failing: ["lint"] } })).toBe(false);
    expect(featurePassed({ ...READY, stories: [story("US-1", { state: "complete-gate-open" })] })).toBe(false);
    expect(featurePassed({ ...READY, stories: [story("US-1", { state: "not-run" })] })).toBe(false);
  });
});

describe("flaggedCount", () => {
  test("story flags + pre-flight holds + flagged branch rulings", () => {
    const n = flaggedCount(
      [story("US-1", { flagged: 1 }), story("US-2", { flagged: 2 })],
      {
        schemaVersion: 1,
        overlap: [],
        conflicts: [
          { questionId: "Q1", storyIds: ["US-1"], summary: "s", decisionId: "D-1", action: "hold" },
          { questionId: "Q2", storyIds: ["US-2"], summary: "s", decisionId: "D-2", action: "supersede" },
        ],
      },
      [
        { findingId: "B1", action: "waive", text: "t", why: "w", costIfWrong: "c", source: "advisor", needsHumanConfirm: true },
        { findingId: "B2", action: "defer", text: "t", why: "w", costIfWrong: "c", source: "advisor" },
      ],
    );
    expect(n).toBe(5);
  });
});

describe("askApproval (P4-R10)", () => {
  function advisor(result: Awaited<ReturnType<Advisor["advise"]>> | Error, seen: QuestionDraft[] = []): Advisor {
    return {
      advise: async (q) => {
        seen.push(q);
        if (result instanceof Error) throw result;
        return result;
      },
      recordReuse: async () => null,
      adviseBatch: async () => ({ kind: "residual", items: [], diagnoses: {} }),
    };
  }

  test("asks finish-approval with an approve/hold menu and the evidence", async () => {
    const seen: QuestionDraft[] = [];
    const out = await askApproval(
      advisor({ decision: makeAdviceDecision({ action: { type: "approve" }, rationale: "clean" }) }, seen),
      { feature: "f", evidence: ["Stories: US-001 complete"] },
    );
    expect(out).toEqual({ approved: true, rationale: "clean" });
    expect(seen[0]?.kind).toBe("finish-approval");
    expect(seen[0]?.options.map((o) => o.type)).toEqual(["approve", "hold"]);
    expect(seen[0]?.evidence.map((e) => e.text)).toEqual(["Stories: US-001 complete"]);
  });

  test("hold, no decision, or a throw -> not approved with the reason", async () => {
    const held = await askApproval(
      advisor({ decision: makeAdviceDecision({ action: { type: "hold", reason: "x" }, rationale: "risky" }) }),
      { feature: "f", evidence: [] },
    );
    expect(held).toEqual({ approved: false, rationale: "advisor held: risky" });
    expect(await askApproval(advisor({ decision: null, fallbackReason: "all models failed" }), { feature: "f", evidence: [] })).toEqual({
      approved: false,
      rationale: "advisor unavailable: all models failed",
    });
    expect((await askApproval(advisor(new Error("boom")), { feature: "f", evidence: [] })).rationale).toBe(
      "advisor unavailable: boom",
    );
  });
});
```
Read `makeAdviceDecision` in `test/helpers` first (Task 4 read it too). If `{ type: "approve" }` isn't a valid `AdviceAction` literal, use the shape `src/advisor/types.ts` declares for approve.

`test/unit/workflow/pr-body.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { makeAdviceDecision } from "@test/helpers";
import { buildWorkflowPrBody, extractAssumptions, type WorkflowPrBodyInput } from "@/workflow/pr-body";

const input: WorkflowPrBodyInput = {
  feature: "refunds",
  outcome: "draft",
  ci: "pending",
  reasons: ["stories gate-open: US-002"],
  stories: [
    { id: "US-001", title: "Create | list", state: "complete", rounds: 1, unreviewed: false, flagged: 0 },
    { id: "US-002", title: "Approve", state: "complete-gate-open", reason: "red: lint", rounds: 5, unreviewed: true, flagged: 0 },
  ],
  preflight: {
    schemaVersion: 1,
    overlap: [],
    conflicts: [{ questionId: "Q1", storyIds: ["US-002"], summary: "30d vs 14d", decisionId: "D-1", action: "supersede" }],
  },
  decisions: [makeAdviceDecision({ id: "D-1", action: { type: "carry", instruction: "keep lock order", toStories: ["US-3"] } })],
  rulings: [{ findingId: "B2", action: "defer", text: "split later", why: "low risk", costIfWrong: "c", source: "advisor" }],
  minorsLeft: ["US-001: rename tmp"],
  finalGates: { ran: ["build", "lint"], failing: ["lint"] },
  assumptions: [{ storyId: "US-001", text: "used the JWT tenant id" }],
};

describe("buildWorkflowPrBody", () => {
  const body = buildWorkflowPrBody(input);

  test("every section in order", () => {
    const order = [
      "## Summary",
      "## Stories",
      "## Pre-flight rulings",
      "## Advisor decisions",
      "## Parked findings",
      "## Deferred minors (left)",
      "## Gates and CI",
      "## Decisions & assumptions",
    ].map((h) => body.indexOf(h));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  test("outcome, reasons, story rows (escaped), unreviewed marker", () => {
    expect(body).toContain("Outcome: **draft**");
    expect(body).toContain("- stories gate-open: US-002");
    expect(body).toContain("| US-001 | Create \\| list | complete | 1 |");
    expect(body).toContain("| US-002 | Approve | complete-gate-open (unreviewed) | 5 |");
  });

  test("pre-flight, advisor decisions, parked findings, minors, gates, CI, assumptions", () => {
    expect(body).toContain("- D-1 (US-002): supersede — 30d vs 14d");
    expect(body).toContain("**D-1**");
    expect(body).toContain("- B2 defer: split later — low risk");
    expect(body).toContain("- US-001: rename tmp");
    expect(body).toContain("- Gates: red: lint (ran build, lint)");
    expect(body).toContain("- CI: pending");
    expect(body).toContain("- US-001: used the JWT tenant id");
    expect(body).toContain("nax never merges");
  });

  test("empty sections read None.", () => {
    const empty = buildWorkflowPrBody({
      ...input,
      reasons: [],
      outcome: "ready",
      preflight: null,
      decisions: [],
      rulings: [],
      minorsLeft: [],
      assumptions: [],
      finalGates: { ran: [], failing: [] },
    });
    expect(empty).not.toContain("Not ready because");
    expect(empty.match(/None\./g)?.length).toBe(5);
    expect(empty).toContain("- Gates: nothing configured (nothing was verified)");
  });

  test("lists are capped at 50 rows", () => {
    const many = buildWorkflowPrBody({ ...input, minorsLeft: Array.from({ length: 60 }, (_, i) => `m${i}`) });
    expect(many).toContain("- …and 10 more");
  });
});

describe("extractAssumptions", () => {
  test("a heading section, up to the next heading", () => {
    const report = "## What was built\nx\n\n## Decisions & assumptions\n- chose X because Y\n- assumed Z\n\n## Files changed\n- a.ts";
    expect(extractAssumptions(report)).toBe("- chose X because Y - assumed Z");
  });

  test("an inline bold bullet, up to the next bold bullet", () => {
    const report = "- **What was built**: a\n- **Decisions & assumptions**: used the tenant id from the JWT.\n- **Files changed**: a.ts";
    expect(extractAssumptions(report)).toBe("used the tenant id from the JWT.");
  });

  test("no section -> empty; a long section is capped", () => {
    expect(extractAssumptions("## Files changed\n- a.ts")).toBe("");
    const long = extractAssumptions(`## Decisions & assumptions\n${"x".repeat(1000)}`);
    expect(long.length).toBe(601);
    expect(long.endsWith("…")).toBe(true);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `timeout 60 bun test test/unit/workflow/approval.test.ts test/unit/workflow/pr-body.test.ts --timeout=60000`
Expected: FAIL (the modules don't exist).

- [ ] **Step 3: Implement**

`src/finish/pr/body.ts`: change `function buildAdvisorSection(` to `export function buildAdvisorSection(`.
`src/finish/pr/index.ts`: change the body export to `export { buildAdvisorSection, buildFinishBody, buildFinishTitle } from "./body";` and add `export { escapeInline, escapeTableCell } from "./escape";`.
`src/finish/index.ts`: in the `./pr` value export list, add `buildAdvisorSection`, `escapeInline` and `escapeTableCell` (alphabetical).

`src/workflow/approval.ts`:
```ts
/** Ready or draft (spec §7 step 8, P4-R6, P4-R10): deterministic reasons first, the advisor only when none apply. */
import { errorMessage } from "@nathapp/nax-agent/internal";
import type { Advisor, QuestionDraft } from "@/advisor";
import { buildMenu } from "@/advisor";
import { getSafeLogger } from "@/logger";
import { isFlaggedRuling } from "./advisor";
import type { PreflightFile } from "./preflight";
import type { FeatureCiState, RepoGateSummary, StorySummary, StoryState, WorkflowRuling } from "./types";

export interface ReadinessFacts {
  readonly finalGates?: RepoGateSummary;
  readonly ci: FeatureCiState;
  readonly stories: readonly StorySummary[];
  readonly flagged: number;
  readonly branchReviewRan: boolean;
}

const NOTHING_VERIFIED = "no quality commands configured — nothing was verified";

function idsIn(stories: readonly StorySummary[], state: StoryState): string[] {
  return stories.filter((s) => s.state === state).map((s) => s.id);
}

function gateReasons(gates: RepoGateSummary | undefined): string[] {
  if (!gates || gates.ran.length === 0) return [NOTHING_VERIFIED];
  return gates.failing.length > 0 ? [`gates red: ${gates.failing.join(", ")}`] : [];
}

/** Why the PR can't be ready, in a stable order; empty = ask the advisor. CI pending never blocks (W-R9). */
export function readinessReasons(f: ReadinessFacts): string[] {
  const gateOpen = idsIn(f.stories, "complete-gate-open");
  const notRun = idsIn(f.stories, "not-run");
  return [
    ...gateReasons(f.finalGates),
    ...(f.ci === "failed" ? ["CI failed"] : []),
    ...(gateOpen.length > 0 ? [`stories gate-open: ${gateOpen.join(", ")}`] : []),
    ...(notRun.length > 0 ? [`stories not run: ${notRun.join(", ")}`] : []),
    ...(f.flagged > 0 ? [`${f.flagged} ruling(s) flagged for a human`] : []),
    ...(f.branchReviewRan ? [] : ["branch review did not run"]),
  ];
}

/** RunResult.success for workflow mode (spec §7, P4-R13). */
export function featurePassed(f: Pick<ReadinessFacts, "finalGates" | "stories">): boolean {
  const storiesOk = f.stories.every((s) => s.state !== "complete-gate-open" && s.state !== "not-run");
  return storiesOk && (f.finalGates?.failing.length ?? 0) === 0;
}

export function flaggedCount(
  stories: readonly StorySummary[],
  preflight: PreflightFile | null,
  rulings: readonly WorkflowRuling[],
): number {
  const storyFlags = stories.reduce((n, s) => n + s.flagged, 0);
  const preflightHolds = (preflight?.conflicts ?? []).filter((c) => c.action === "hold").length;
  return storyFlags + preflightHolds + rulings.filter(isFlaggedRuling).length;
}

export async function askApproval(
  advisor: Advisor,
  input: { readonly feature: string; readonly evidence: readonly string[] },
): Promise<{ approved: boolean; rationale: string }> {
  const draft: QuestionDraft = {
    kind: "finish-approval",
    feature: input.feature,
    summary: `Approve the workflow PR for ${input.feature}? Every deterministic ready condition holds.`,
    evidence: input.evidence.map((text) => ({ source: "review-round", text })),
    options: buildMenu({
      kind: "finish-approval",
      allPhasesComplete: true,
      gatesGreen: true,
      reReviewUsed: true,
      reReviewPhase: "quality",
    }),
  };
  try {
    const { decision, fallbackReason } = await advisor.advise(draft);
    if (!decision) return { approved: false, rationale: `advisor unavailable: ${fallbackReason ?? "no decision"}` };
    return decision.action.type === "approve"
      ? { approved: true, rationale: decision.rationale }
      : { approved: false, rationale: `advisor held: ${decision.rationale}` };
  } catch (err) {
    getSafeLogger()?.warn("workflow", "Approval advisor failed — the PR stays a draft", {
      storyId: "_run",
      error: errorMessage(err),
    });
    return { approved: false, rationale: `advisor unavailable: ${errorMessage(err)}` };
  }
}
```

`src/workflow/pr-body.ts`:
```ts
/** The workflow PR body (spec §7 step 9). Separate from finish's body; reuses its advisor section and escapes. */
import type { AdviceDecision } from "@/advisor";
import { buildAdvisorSection, escapeInline, escapeTableCell } from "@/finish";
import type { PreflightFile } from "./preflight";
import type { FeatureCiState, FeatureOutcome, RepoGateSummary, StorySummary, WorkflowRuling } from "./types";

export interface WorkflowPrBodyFacts {
  readonly feature: string;
  readonly stories: readonly StorySummary[];
  readonly preflight: PreflightFile | null;
  readonly decisions: readonly AdviceDecision[];
  /** Branch adjudication rulings (the parked branch findings). */
  readonly rulings: readonly WorkflowRuling[];
  /** Deferred minors marked leave, plus minors the branch review raised. */
  readonly minorsLeft: readonly string[];
  readonly finalGates?: RepoGateSummary;
  readonly assumptions: readonly { readonly storyId: string; readonly text: string }[];
}

export interface WorkflowPrBodyInput extends WorkflowPrBodyFacts {
  readonly outcome: FeatureOutcome;
  readonly ci: FeatureCiState;
  readonly reasons: readonly string[];
}

const ROW_CAP = 50;
const ITEM_CHARS = 300;
const ASSUMPTION_ITEM_CHARS = 700;
const ASSUMPTIONS_CAP = 600;
const NONE = "None.";
const ASSUMPTIONS_HEADING = /decisions\s*(?:&|and)\s*assumptions/i;
const NEXT_SECTION = /^\s*(?:#{1,6}\s|- \*\*|\*\*[^*]+\*\*)/;

function list(items: readonly string[], chars = ITEM_CHARS): string {
  if (items.length === 0) return NONE;
  const shown = items.slice(0, ROW_CAP).map((i) => `- ${escapeInline(i, chars)}`);
  const hidden = items.length - shown.length;
  return [...shown, ...(hidden > 0 ? [`- …and ${hidden} more`] : [])].join("\n");
}

function summary(input: WorkflowPrBodyInput): string {
  const n = input.stories.length;
  const head = `Workflow mode (A5) implemented ${n} ${n === 1 ? "story" : "stories"} for **${escapeInline(input.feature)}**. Outcome: **${input.outcome}**.`;
  return input.reasons.length > 0 ? `${head}\n\nNot ready because:\n${list(input.reasons)}` : head;
}

function storiesTable(stories: readonly StorySummary[]): string {
  const rows = stories
    .slice(0, ROW_CAP)
    .map(
      (s) =>
        `| ${escapeTableCell(s.id)} | ${escapeTableCell(s.title)} | ${escapeTableCell(s.state)}${s.unreviewed ? " (unreviewed)" : ""} | ${s.rounds} |`,
    );
  return ["| Story | Title | State | Rounds |", "|---|---|---|---|", ...rows].join("\n");
}

function preflightLines(p: PreflightFile | null): string[] {
  return (p?.conflicts ?? []).map(
    (c) => `${c.decisionId ?? "default"} (${c.storyIds.join(", ") || "no story"}): ${c.action} — ${c.summary}`,
  );
}

function gateLines(input: WorkflowPrBodyInput): string[] {
  const g = input.finalGates;
  const gates =
    !g || g.ran.length === 0
      ? "Gates: nothing configured (nothing was verified)"
      : g.failing.length > 0
        ? `Gates: red: ${g.failing.join(", ")} (ran ${g.ran.join(", ")})`
        : `Gates: green (${g.ran.join(", ")})`;
  return [gates, `CI: ${input.ci}`];
}

export function buildWorkflowPrBody(input: WorkflowPrBodyInput): string {
  return [
    `## Summary\n\n${summary(input)}`,
    `## Stories\n\n${storiesTable(input.stories)}`,
    `## Pre-flight rulings\n\n${list(preflightLines(input.preflight))}`,
    `## Advisor decisions\n\n${buildAdvisorSection([...input.decisions]) ?? NONE}`,
    `## Parked findings\n\n${list(input.rulings.map((r) => `${r.findingId ?? "?"} ${r.action}: ${r.text} — ${r.why}`))}`,
    `## Deferred minors (left)\n\n${list(input.minorsLeft)}`,
    `## Gates and CI\n\n${list(gateLines(input))}`,
    `## Decisions & assumptions\n\n${list(
      input.assumptions.map((a) => `${a.storyId}: ${a.text}`),
      ASSUMPTION_ITEM_CHARS,
    )}`,
    "_Opened by nax workflow mode. nax never merges._",
  ].join("\n\n");
}

/** The first "Decisions & assumptions" section of a story report, flattened and capped (spec §7.9). */
export function extractAssumptions(report: string): string {
  const lines = report.split("\n");
  const start = lines.findIndex((l) => ASSUMPTIONS_HEADING.test(l));
  if (start < 0) return "";
  const inline = (lines[start] ?? "").split(ASSUMPTIONS_HEADING)[1]?.replace(/^[*:\s]+/, "") ?? "";
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => NEXT_SECTION.test(l));
  const body = [inline, ...(end < 0 ? rest : rest.slice(0, end))].join(" ").replace(/\s+/g, " ").trim();
  return body.length > ASSUMPTIONS_CAP ? `${body.slice(0, ASSUMPTIONS_CAP)}…` : body;
}
```
The "empty sections read None." test expects 5 `None.` occurrences: pre-flight, advisor decisions, parked, minors, assumptions. Gates always has lines.

- [ ] **Step 4: Run them to verify they pass**

Run the Step 2 command, then `timeout 120 bun test test/unit/finish --timeout=60000` (the finish body must render byte-for-byte as before) and `bun run check:import-cycles`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/finish/pr/body.ts src/finish/pr/index.ts src/finish/index.ts src/workflow/approval.ts src/workflow/pr-body.ts test/unit/workflow/approval.test.ts test/unit/workflow/pr-body.test.ts
git commit -m "feat(workflow): readiness rules, finish-approval ask, and the workflow PR body"
```

---

### Task 9: Publish — push, draft PR, CI wait, approval, promote

**Files:**
- Create: `src/workflow/finalize.ts`
- Test: `test/unit/workflow/finalize.test.ts`

**Interfaces:**
- Consumes:
  - `_featureDeps` (Task 6);
  - `readinessReasons`, `askApproval` (Task 8);
  - `buildWorkflowPrBody`, `extractAssumptions` (Task 8);
  - `sanitizeTitle` (`@/finish`);
  - `_workflowDeps.readTrustedDecisions`.
- Produces:
  ```ts
  export interface PublishInput {
    readonly record: WorkflowFeatureRecord; readonly stories: readonly StorySummary[];
    readonly flagged: number; readonly advisor: Advisor; readonly preflight: PreflightFile | null;
  }
  export interface PublishOutcome { readonly outcome: FeatureOutcome; readonly ci: FeatureCiState; readonly url?: string; readonly reasons: readonly string[] }
  export function isPublishableBranch(branch: string): boolean;
  export function workflowPrTitle(fc: FeatureContext): string;
  export function publish(fc: FeatureContext, input: PublishInput): Promise<PublishOutcome>;
  ```

- [ ] **Step 1: Write the failing test**

`test/unit/workflow/finalize.test.ts`:
```ts
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanupTempDir, makeAdviceDecision, makeFeatureContext, makeTempDir } from "@test/helpers";
import type { Advisor } from "@/advisor";
import { newFeatureRecord } from "@/workflow/feature-record";
import { _featureDeps } from "@/workflow/feature-deps";
import { isPublishableBranch, publish, type PublishInput } from "@/workflow/finalize";
import { _workflowDeps } from "@/workflow/step-context";
import type { StorySummary } from "@/workflow/types";

const originalFeature = { ..._featureDeps };
const originalWorkflow = { ..._workflowDeps };
const dirs: string[] = [];
afterEach(async () => {
  Object.assign(_featureDeps, originalFeature);
  Object.assign(_workflowDeps, originalWorkflow);
  await Promise.all(dirs.map(cleanupTempDir));
  dirs.length = 0;
});

const done: StorySummary = { id: "US-001", title: "A", state: "complete", rounds: 1, unreviewed: false, flagged: 0 };
const greenRecord = {
  ...newFeatureRecord({ now: "t", seed: "s", minors: [] }),
  reviewRan: true,
  finalGates: { ran: ["build", "test"], failing: [] },
};

function advisor(approve: boolean, asked: string[] = []): Advisor {
  return {
    advise: async (q) => {
      asked.push(q.kind);
      return {
        decision: makeAdviceDecision({
          action: approve ? { type: "approve" } : { type: "hold", reason: "r" },
          rationale: approve ? "clean" : "risky",
        }),
      };
    },
    recordReuse: async () => null,
    adviseBatch: async () => ({ kind: "residual", items: [], diagnoses: {} }),
  };
}

/** Wires every forge-side dep; returns the call log. */
function wire(opts: { ci?: "green" | "failed" | "pending"; pushFails?: boolean; promoteThrows?: boolean } = {}) {
  const calls: { name: string; arg?: unknown }[] = [];
  _featureDeps.detectForge = async () => "github";
  _featureDeps.commitAndPush = async (...args) => {
    calls.push({ name: "push", arg: args.slice(0, 2) });
    if (opts.pushFails) throw new Error("rejected: non-fast-forward");
    return { committed: false, pushed: true };
  };
  _featureDeps.openDraftFinishPr = async (args) => {
    calls.push({ name: "draft", arg: args.body });
    return { url: "https://gh/pr/7" };
  };
  _featureDeps.waitForChecks = async () => {
    calls.push({ name: "ci" });
    return { outcome: opts.ci ?? "pending", detail: "d" };
  };
  _featureDeps.openOrPromotePr = async (args) => {
    calls.push({ name: "promote", arg: { keepDraft: args.keepDraft, body: args.body } });
    if (opts.promoteThrows) throw new Error("gh edit failed");
    return { status: args.keepDraft ? "draft" : "promoted", url: "https://gh/pr/7" };
  };
  _workflowDeps.readTrustedDecisions = async () => [];
  return calls;
}

function input(over: Partial<PublishInput> = {}): PublishInput {
  return { record: greenRecord, stories: [done], flagged: 0, advisor: advisor(true), preflight: null, ...over };
}

describe("isPublishableBranch", () => {
  test.each([
    ["feat/x", true],
    ["main", false],
    ["master", false],
    ["", false],
  ])("%s -> %p", (branch, ok) => expect(isPublishableBranch(branch)).toBe(ok));
});

describe("publish (P4-R3, P4-R11)", () => {
  test("happy path: push, draft PR, CI pending, advisor approves -> promoted, ready", async () => {
    const calls = wire({ ci: "pending" });
    const asked: string[] = [];
    const out = await publish(makeFeatureContext(), input({ advisor: advisor(true, asked) }));
    expect(calls.map((c) => c.name)).toEqual(["push", "draft", "ci", "promote"]);
    expect(calls[0]?.arg).toEqual(["/repo", "feat/x"]);
    expect(asked).toEqual(["finish-approval"]);
    expect(calls[3]?.arg).toMatchObject({ keepDraft: false });
    expect(String((calls[3]?.arg as { body: string }).body)).toContain("Outcome: **ready**");
    expect(out).toEqual({ outcome: "ready", ci: "pending", url: "https://gh/pr/7", reasons: [] });
  });

  test("a deterministic reason keeps the draft and never asks the advisor (P4-R10)", async () => {
    const calls = wire();
    const asked: string[] = [];
    const out = await publish(
      makeFeatureContext(),
      input({ stories: [{ ...done, state: "complete-gate-open" }], advisor: advisor(true, asked) }),
    );
    expect(asked).toEqual([]);
    expect(calls.at(-1)?.arg).toMatchObject({ keepDraft: true });
    expect(out.outcome).toBe("draft");
    expect(out.reasons).toEqual(["stories gate-open: US-001"]);
  });

  test("CI failed -> draft with the reason", async () => {
    wire({ ci: "failed" });
    const out = await publish(makeFeatureContext(), input());
    expect(out).toMatchObject({ outcome: "draft", ci: "failed", reasons: ["CI failed"] });
  });

  test("the advisor holds -> draft with its rationale", async () => {
    wire({ ci: "green" });
    const out = await publish(makeFeatureContext(), input({ advisor: advisor(false) }));
    expect(out).toMatchObject({ outcome: "draft", reasons: ["advisor held: risky"] });
  });

  test("main, an empty branch, a dry run, or no forge -> local-only, nothing pushed", async () => {
    const calls = wire();
    expect((await publish(makeFeatureContext({ branch: "main" }), input())).outcome).toBe("local-only");
    expect((await publish(makeFeatureContext({ dryRun: true }), input())).reasons).toContain("dry run");
    _featureDeps.detectForge = async () => null;
    const out = await publish(makeFeatureContext(), input());
    expect(out).toMatchObject({ outcome: "local-only", ci: "skipped" });
    expect(out.reasons.at(-1)).toContain("no forge detected");
    expect(calls).toEqual([]);
  });

  test("a push failure -> local-only with the reason, no PR calls", async () => {
    const calls = wire({ pushFails: true });
    const out = await publish(makeFeatureContext(), input());
    expect(out.outcome).toBe("local-only");
    expect(out.reasons.at(-1)).toBe("push failed: rejected: non-fast-forward");
    expect(calls.map((c) => c.name)).toEqual(["push"]);
  });

  test("a promote failure keeps the draft URL and adds the reason", async () => {
    wire({ ci: "green", promoteThrows: true });
    const out = await publish(makeFeatureContext(), input());
    expect(out).toMatchObject({ outcome: "draft", url: "https://gh/pr/7" });
    expect(out.reasons.at(-1)).toBe("PR update failed: gh edit failed");
  });

  test("the body carries each story's Decisions & assumptions from its report", async () => {
    const runDir = makeTempDir("wf-fin-");
    dirs.push(runDir);
    await Bun.write(join(runDir, "US-001", "report.md"), "## Decisions & assumptions\n- used the JWT tenant id\n");
    const calls = wire({ ci: "green" });
    await publish(makeFeatureContext(), input({ stories: [{ ...done, runDir }] }));
    expect(String(calls.find((c) => c.name === "draft")?.arg)).toContain("US-001: - used the JWT tenant id");
  });
});
```
The fakes' parameter shapes must match `_featureDeps`. Read `commitAndPush`, `openDraftFinishPr` and `openOrPromotePr` (`src/finish/commit.ts`, `src/finish/pr/open.ts`) and give each fake the real parameter list and return type. In particular, `commitAndPush` returns `SyncOutcome`, so fill its required fields. The single `as { body: string }` cast can be replaced with a typed `calls` entry (`arg: { keepDraft?: boolean; body: string }`) if the looseCast ratchet objects.

- [ ] **Step 2: Run it to verify it fails**

Run: `timeout 60 bun test test/unit/workflow/finalize.test.ts --timeout=60000`
Expected: FAIL (`@/workflow/finalize` can't be resolved).

- [ ] **Step 3: Implement `src/workflow/finalize.ts`**

```ts
/**
 * Publish (spec §7 steps 7-9, P4-R3, P4-R11): push, open (or find) the draft PR, wait for CI,
 * ask for approval only when every deterministic condition holds, then promote or keep the draft.
 * nax never merges. A non-feature branch, a dry run, no forge or a failed push ends local-only.
 */
import { join } from "node:path";
import { errorMessage } from "@nathapp/nax-agent/internal";
import type { AdviceDecision, Advisor } from "@/advisor";
import { sanitizeTitle } from "@/finish";
import type { ForgeKind } from "@/forge";
import { getSafeLogger } from "@/logger";
import { askApproval, type ReadinessFacts, readinessReasons } from "./approval";
import type { CiWaitResult } from "./ci-wait";
import type { FeatureContext } from "./feature-context";
import { _featureDeps } from "./feature-deps";
import { workflowStoryDir } from "./paths";
import { buildWorkflowPrBody, extractAssumptions, type WorkflowPrBodyFacts } from "./pr-body";
import type { PreflightFile } from "./preflight";
import { _workflowDeps } from "./step-context";
import type { FeatureCiState, FeatureOutcome, StorySummary, WorkflowFeatureRecord } from "./types";

export interface PublishInput {
  readonly record: WorkflowFeatureRecord;
  readonly stories: readonly StorySummary[];
  readonly flagged: number;
  readonly advisor: Advisor;
  readonly preflight: PreflightFile | null;
}

export interface PublishOutcome {
  readonly outcome: FeatureOutcome;
  readonly ci: FeatureCiState;
  readonly url?: string;
  readonly reasons: readonly string[];
}

const PROTECTED_BRANCHES = new Set(["", "main", "master"]);

export function isPublishableBranch(branch: string): boolean {
  return !PROTECTED_BRANCHES.has(branch);
}

export function workflowPrTitle(fc: FeatureContext): string {
  const raw = `feat(${fc.feature}): ${fc.prd.userStories.length} stories (nax workflow)`;
  return sanitizeTitle(raw) ?? raw;
}

async function publishTarget(fc: FeatureContext): Promise<{ forge: ForgeKind } | { reason: string }> {
  if (fc.dryRun) return { reason: "dry run" };
  if (!isPublishableBranch(fc.branch)) return { reason: `branch "${fc.branch || "(empty)"}" is not a feature branch` };
  const forge = await _featureDeps.detectForge(fc.projectDir);
  return forge ? { forge } : { reason: "no forge detected (origin is not GitHub or GitLab)" };
}

async function pushBranch(fc: FeatureContext): Promise<string | null> {
  try {
    await _featureDeps.commitAndPush(fc.projectDir, fc.branch, `chore(${fc.feature}): workflow`, { skipCommit: true });
    return null;
  } catch (err) {
    if (fc.runSignal?.aborted) throw err;
    getSafeLogger()?.warn("workflow", "Push failed — the feature ends local-only", {
      storyId: "_run",
      error: errorMessage(err),
    });
    return `push failed: ${errorMessage(err)}`;
  }
}

async function loadDecisions(fc: FeatureContext): Promise<readonly AdviceDecision[]> {
  try {
    return await _workflowDeps.readTrustedDecisions(fc.projectDir, fc.feature, fc.outputDir);
  } catch (err) {
    getSafeLogger()?.warn("workflow", "Advisor decisions unavailable for the PR body", {
      storyId: "_run",
      error: errorMessage(err),
    });
    return [];
  }
}

async function loadAssumptions(stories: readonly StorySummary[]): Promise<{ storyId: string; text: string }[]> {
  const out: { storyId: string; text: string }[] = [];
  for (const s of stories) {
    if (!s.runDir) continue;
    try {
      const file = Bun.file(join(workflowStoryDir(s.runDir, s.id), "report.md"));
      const text = (await file.exists()) ? extractAssumptions(await file.text()) : "";
      if (text) out.push({ storyId: s.id, text });
    } catch {
      // an unreadable report only loses its assumptions line
    }
  }
  return out;
}

async function bodyFacts(fc: FeatureContext, input: PublishInput): Promise<WorkflowPrBodyFacts> {
  const r = input.record;
  return {
    feature: fc.feature,
    stories: input.stories,
    preflight: input.preflight,
    decisions: await loadDecisions(fc),
    rulings: r.rulings,
    minorsLeft: [...r.minors.filter((m) => m.triage === "leave").map((m) => `${m.storyId}: ${m.text}`), ...r.newMinors],
    ...(r.finalGates ? { finalGates: r.finalGates } : {}),
    assumptions: await loadAssumptions(input.stories),
  };
}

function approvalEvidence(input: PublishInput, ci: CiWaitResult, minorsLeft: number): string[] {
  const r = input.record;
  return [
    `Stories: ${input.stories.map((s) => `${s.id} ${s.state} (${s.rounds} round(s))`).join(", ") || "none"}`,
    `Final gates: ${r.finalGates?.ran.join(", ") || "none"}, all green`,
    `CI: ${ci.outcome} (${ci.detail})`,
    `Branch review ran; open findings after the fix pass: ${r.reviewOpen.length}; branch rulings: ${r.rulings.length}`,
    `Deferred minors left: ${minorsLeft}`,
  ];
}

export async function publish(fc: FeatureContext, input: PublishInput): Promise<PublishOutcome> {
  const facts: Omit<ReadinessFacts, "ci"> = {
    ...(input.record.finalGates ? { finalGates: input.record.finalGates } : {}),
    stories: input.stories,
    flagged: input.flagged,
    branchReviewRan: input.record.reviewRan,
  };
  const base = readinessReasons({ ...facts, ci: "skipped" });
  const target = await publishTarget(fc);
  if (!("forge" in target)) return { outcome: "local-only", ci: "skipped", reasons: [...base, target.reason] };
  const pushFailed = await pushBranch(fc);
  if (pushFailed) return { outcome: "local-only", ci: "skipped", reasons: [...base, pushFailed] };

  const body = await bodyFacts(fc, input);
  const pr = { workdir: fc.projectDir, branch: fc.branch, title: workflowPrTitle(fc), forge: target.forge };
  const draft = await _featureDeps.openDraftFinishPr(
    { ...pr, body: buildWorkflowPrBody({ ...body, outcome: "draft", ci: "pending", reasons: base }) },
    _featureDeps.forge,
  );
  const ci = await _featureDeps.waitForChecks(target.forge, fc.branch, {
    cwd: fc.projectDir,
    timeoutMs: fc.workflow.timeouts.ciWaitMs,
    pollMs: fc.workflow.timeouts.ciPollMs,
    ...(fc.runSignal ? { signal: fc.runSignal } : {}),
  });
  const reasons = readinessReasons({ ...facts, ci: ci.outcome });
  const approval =
    reasons.length === 0
      ? await askApproval(input.advisor, {
          feature: fc.feature,
          evidence: approvalEvidence(input, ci, body.minorsLeft.length),
        })
      : null;
  const ready = approval?.approved === true;
  const finalReasons = ready ? [] : approval ? [...reasons, approval.rationale] : reasons;
  const finalBody = buildWorkflowPrBody({ ...body, outcome: ready ? "ready" : "draft", ci: ci.outcome, reasons: finalReasons });
  try {
    const res = await _featureDeps.openOrPromotePr(
      { ...pr, body: finalBody, committedThisRun: true, keepDraft: !ready },
      _featureDeps.forge,
    );
    const url = res.url ?? draft?.url;
    return { outcome: ready ? "ready" : "draft", ci: ci.outcome, ...(url ? { url } : {}), reasons: finalReasons };
  } catch (err) {
    if (fc.runSignal?.aborted) throw err;
    return {
      outcome: "draft",
      ci: ci.outcome,
      ...(draft?.url ? { url: draft.url } : {}),
      reasons: [...finalReasons, `PR update failed: ${errorMessage(err)}`],
    };
  }
}
```
`publish` must stay ≤ 20 cognitive complexity. If `check:complexity` flags it, move the `try/catch` tail into `async function settlePr(fc, a): Promise<PublishOutcome>` taking `{ pr, body, ready, ci, reasons, draftUrl }`.

- [ ] **Step 4: Run it to verify it passes**

Run the Step 2 command, then `bun run check:complexity`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/workflow/finalize.ts test/unit/workflow/finalize.test.ts
git commit -m "feat(workflow): publish — push, draft PR, CI wait, approval, promote or keep the draft"
```

---
### Task 10: The feature state machine

**Files:**
- Create: `src/workflow/feature-machine.ts`
- Test: `test/unit/workflow/feature-machine.test.ts`

**Interfaces:**
- Consumes (types only, plus `featurePassed` and `ledgerText`):
  - `RepoGateRun` (Task 6), `BranchReviewFacts` (Task 6), `BranchFixOutcome` (Task 7), `PublishOutcome` (Task 9);
  - `ReviewOutcome` (`./story-review`), `LedgerItem` (Task 5);
  - `WorkflowFeatureRecord`, `StorySummary`, `MinorItem` (Task 5).
- Produces:
  ```ts
  export interface FeatureSteps {
    repoGates(): Promise<RepoGateRun>;
    branchReview(seed: string, facts: BranchReviewFacts): Promise<ReviewOutcome<BranchReviewVerdict>>;
    branchFix(findings: readonly WorkflowFinding[]): Promise<BranchFixOutcome>;
    branchReReview(findings: readonly WorkflowFinding[], fixBase: string): Promise<ReviewOutcome<ReReviewVerdict>>;
    adjudicate(items: readonly WorkflowFinding[]): Promise<readonly WorkflowRuling[]>;
    publish(record: WorkflowFeatureRecord): Promise<PublishOutcome>;
    head(): Promise<string>;
  }
  export interface FeatureSink {
    update(record: WorkflowFeatureRecord): Promise<void>;
    ledger(text: string): Promise<void>;
    step(step: FeatureStep, record: WorkflowFeatureRecord): void;
  }
  export interface FeatureFacts { readonly stories: readonly StorySummary[]; readonly parked: readonly LedgerItem[]; readonly cannotVerify: readonly LedgerItem[] }
  export interface FeatureEnv {
    readonly steps: FeatureSteps; readonly sink: FeatureSink; readonly facts: FeatureFacts;
    readonly record: WorkflowFeatureRecord; readonly aborted: () => boolean; readonly now: () => number;
  }
  export function runFeatureMachine(env: FeatureEnv): Promise<WorkflowFeatureRecord>;
  ```

- [ ] **Step 1: Write the failing test**

`test/unit/workflow/feature-machine.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import type { BranchFixOutcome } from "@/workflow/branch-fix";
import { newFeatureRecord } from "@/workflow/feature-record";
import { type FeatureEnv, type FeatureSteps, runFeatureMachine } from "@/workflow/feature-machine";
import type { PublishOutcome } from "@/workflow/finalize";
import type { RepoGateRun } from "@/workflow/repo-gates";
import type {
  BranchReviewVerdict,
  FeatureStep,
  ReReviewVerdict,
  StorySummary,
  WorkflowFeatureRecord,
  WorkflowFinding,
} from "@/workflow/types";

const GREEN: RepoGateRun = { summary: { ran: ["build", "test"], failing: [] }, findings: [] };
const RED_LINT: RepoGateRun = {
  summary: { ran: ["build", "lint"], failing: ["lint"] },
  findings: [{ kind: "gate", severity: "important", issue: "repo gate lint failed:\nno-var" }],
};
const PASS: BranchReviewVerdict = { spec: "pass", quality: "approved", findings: [], cannotVerify: [], minorTriage: [] };
const FIXED: BranchFixOutcome = {
  reply: { status: "DONE", commits: [], testSummary: "", interrupted: false },
  autoCommitted: false,
};
const PUBLISHED: PublishOutcome = { outcome: "ready", ci: "pending", url: "https://gh/pr/1", reasons: [] };
const done = (id: string, over: Partial<StorySummary> = {}): StorySummary => ({
  id,
  title: id,
  state: "complete",
  rounds: 0,
  unreviewed: false,
  flagged: 0,
  ...over,
});

interface Script {
  gates?: RepoGateRun[];
  review?: BranchReviewVerdict | null;
  reReview?: ReReviewVerdict | null;
  fix?: BranchFixOutcome;
}

function harness(script: Script, over: { record?: WorkflowFeatureRecord; stories?: StorySummary[]; aborted?: boolean } = {}) {
  const calls: string[] = [];
  const ledger: string[] = [];
  const stepsSeen: FeatureStep[] = [];
  const updates: WorkflowFeatureRecord[] = [];
  const fixInputs: (readonly WorkflowFinding[])[] = [];
  const reReviewInputs: (readonly WorkflowFinding[])[] = [];
  const adjudicated: (readonly WorkflowFinding[])[] = [];
  const gates = [...(script.gates ?? [])];
  let clock = 0;
  const steps: FeatureSteps = {
    repoGates: async () => {
      calls.push("repoGates");
      return gates.shift() ?? GREEN;
    },
    branchReview: async (seed) => {
      calls.push(`branchReview:${seed}`);
      const v = script.review === undefined ? PASS : script.review;
      return v === null ? { ran: false, why: "unparseable reply" } : { ran: true, verdict: v };
    },
    branchFix: async (findings) => {
      calls.push("branchFix");
      fixInputs.push(findings);
      return script.fix ?? FIXED;
    },
    branchReReview: async (findings, fixBase) => {
      calls.push(`branchReReview:${fixBase}`);
      reReviewInputs.push(findings);
      const v =
        script.reReview === undefined
          ? { verdicts: findings.map((f) => ({ id: f.id, addressed: true, note: "" })), newFindings: [] }
          : script.reReview;
      return v === null ? { ran: false, why: "timeout" } : { ran: true, verdict: v };
    },
    adjudicate: async (items) => {
      calls.push("adjudicate");
      adjudicated.push(items);
      return items.map((f) => ({
        findingId: f.id,
        action: "hold" as const,
        text: `hold ${f.id}`,
        why: "w",
        costIfWrong: "c",
        source: "default" as const,
      }));
    },
    publish: async () => {
      calls.push("publish");
      return PUBLISHED;
    },
    head: async () => `h${calls.length}`,
  };
  const env: FeatureEnv = {
    steps,
    sink: {
      update: async (r) => {
        updates.push(r);
      },
      ledger: async (t) => {
        ledger.push(t);
      },
      step: (s) => {
        stepsSeen.push(s);
      },
    },
    facts: { stories: over.stories ?? [done("US-001")], parked: [], cannotVerify: [] },
    record: over.record ?? newFeatureRecord({ now: "t", seed: "seed0", minors: [] }),
    aborted: () => over.aborted === true,
    now: () => (clock += 5),
  };
  return { env, calls, ledger, stepsSeen, updates, fixInputs, reReviewInputs, adjudicated };
}

describe("runFeatureMachine", () => {
  test("clean branch: no fix, no re-review, no adjudication; final gates reuse step 1", async () => {
    const h = harness({});
    const final = await runFeatureMachine(h.env);
    expect(h.calls).toEqual(["repoGates", "branchReview:seed0", "publish"]);
    expect(h.stepsSeen).toEqual([
      "repo-gates",
      "branch-review",
      "branch-fix",
      "branch-rereview",
      "adjudicate",
      "final-gates",
      "publish",
      "done",
    ]);
    expect(h.updates).toHaveLength(7);
    expect(final).toMatchObject({
      step: "done",
      reviewRan: true,
      finalGates: GREEN.summary,
      outcome: "ready",
      ci: "pending",
      url: "https://gh/pr/1",
      passed: true,
    });
    expect(final.head).toBe("h3");
    expect(final.timings["repo-gates"]).toBe(5);
  });

  test("findings, a fix-now minor, a red gate and a gate-open story all reach the one fix (P4-R7)", async () => {
    const h = harness(
      {
        gates: [RED_LINT, GREEN],
        review: {
          ...PASS,
          quality: "changes",
          findings: [
            { kind: "quality", severity: "important", issue: "US-2 skips the US-1 lock" },
            { kind: "quality", severity: "minor", issue: "naming nit" },
          ],
          minorTriage: [{ id: "M1", decision: "fix-now" }],
        },
        reReview: {
          verdicts: [
            { id: "B3", addressed: false, note: "still skipped" },
            { id: "M1", addressed: false, note: "" },
          ],
          newFindings: [
            { kind: "quality", severity: "critical", issue: "new race" },
            { kind: "quality", severity: "minor", issue: "typo" },
          ],
        },
      },
      {
        record: {
          ...newFeatureRecord({ now: "t", seed: "seed0", minors: [{ id: "M1", storyId: "US-001", text: "rename", triage: "leave" }] }),
        },
        stories: [done("US-001"), done("US-002", { state: "complete-gate-open", reason: "red: lint" })],
      },
    );
    const final = await runFeatureMachine(h.env);
    expect(h.fixInputs[0]?.map((f) => f.id)).toEqual(["B3", "M1", "B1", "B2"]);
    expect(h.fixInputs[0]?.find((f) => f.id === "B2")?.issue).toContain("US-002 ended with a red gate (red: lint)");
    expect(h.reReviewInputs[0]?.map((f) => f.id)).toEqual(["B3", "M1"]);
    expect(h.adjudicated[0]?.map((f) => f.id)).toEqual(["B3", "B4"]);
    expect(final.minors).toEqual([{ id: "M1", storyId: "US-001", text: "rename", triage: "leave" }]);
    expect(final.newMinors).toEqual(["naming nit", "typo"]);
    expect(final.rulings).toHaveLength(2);
    expect(final.finalGates).toEqual(GREEN.summary);
    expect(h.calls.filter((c) => c === "repoGates")).toHaveLength(2);
    expect(h.ledger).toContain("repo gates red: lint");
  });

  test("no seed: the branch review is skipped with a ledger line; review did not run (P4-R15)", async () => {
    const h = harness({}, { record: newFeatureRecord({ now: "t", seed: null, minors: [] }) });
    const final = await runFeatureMachine(h.env);
    expect(h.calls.some((c) => c.startsWith("branchReview"))).toBe(false);
    expect(h.ledger).toContain("review-skipped (branch review: no seed)");
    expect(final.reviewRan).toBe(false);
  });

  test("an unparseable branch review: skipped, but red gates still go to the fix", async () => {
    const h = harness({ gates: [RED_LINT, GREEN], review: null });
    const final = await runFeatureMachine(h.env);
    expect(h.ledger).toContain("review-skipped (branch review: unparseable reply)");
    expect(h.fixInputs[0]?.map((f) => f.id)).toEqual(["B1"]);
    expect(final.reviewRan).toBe(false);
    expect(h.calls.some((c) => c.startsWith("branchReReview"))).toBe(false);
  });

  test("a re-review that does not run leaves every review finding open for adjudication", async () => {
    const h = harness({
      review: { ...PASS, findings: [{ kind: "spec", severity: "important", issue: "AC-2 unwired" }] },
      reReview: null,
    });
    await runFeatureMachine(h.env);
    expect(h.ledger).toContain("review-skipped (branch re-review: timeout)");
    expect(h.adjudicated[0]?.map((f) => f.id)).toEqual(["B1"]);
  });

  test("the re-review gets the HEAD recorded just before the fix as its base", async () => {
    const h = harness({ review: { ...PASS, findings: [{ kind: "spec", severity: "important", issue: "x" }] } });
    await runFeatureMachine(h.env);
    const fixAt = h.calls.indexOf("branchFix");
    expect(h.calls[fixAt + 1]).toMatch(/^branchReReview:h\d+$/);
  });

  test("a fix session failure is ledgered and the workflow goes on", async () => {
    const h = harness({
      review: { ...PASS, findings: [{ kind: "spec", severity: "important", issue: "x" }] },
      fix: { failure: "quota", autoCommitted: false },
    });
    const final = await runFeatureMachine(h.env);
    expect(h.ledger).toContain("branch fix session failed: quota");
    expect(final.step).toBe("done");
  });

  test("resume at adjudicate: earlier steps never run again (P4-R1)", async () => {
    const record: WorkflowFeatureRecord = {
      ...newFeatureRecord({ now: "t", seed: "s", minors: [] }),
      step: "adjudicate",
      reviewRan: true,
      fixRan: true,
      repoGates: GREEN.summary,
      reviewOpen: [{ id: "B1", kind: "quality", severity: "important", issue: "x" }],
    };
    const h = harness({}, { record });
    await runFeatureMachine(h.env);
    expect(h.calls).toEqual(["adjudicate", "repoGates", "publish"]);
  });

  test("an aborted run throws before the next step and runs nothing", async () => {
    const h = harness({}, { aborted: true });
    await expect(runFeatureMachine(h.env)).rejects.toThrow("aborted");
    expect(h.calls).toEqual([]);
  });

  test("passed is false when a story is not-run, even if publish succeeds", async () => {
    const h = harness({}, { stories: [done("US-001", { state: "not-run" })] });
    expect((await runFeatureMachine(h.env)).passed).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `timeout 60 bun test test/unit/workflow/feature-machine.test.ts --timeout=60000`
Expected: FAIL (`@/workflow/feature-machine` can't be resolved).

- [ ] **Step 3: Implement `src/workflow/feature-machine.ts`**

```ts
/**
 * The feature workflow (spec §7) as a state machine. Pure orchestration over injected
 * steps, persisted after every step (P4-R1), so a crash resumes at `record.step`.
 * One branch review, exactly one fix pass, one scoped re-review, one adjudication.
 */
import { NaxError } from "@/errors";
import { featurePassed } from "./approval";
import type { BranchFixOutcome } from "./branch-fix";
import type { BranchReviewFacts } from "./branch-review";
import type { PublishOutcome } from "./finalize";
import { ledgerText } from "./ledger";
import type { LedgerItem } from "./ledger-items";
import type { RepoGateRun } from "./repo-gates";
import type { ReviewOutcome } from "./story-review";
import type {
  BranchReviewVerdict,
  FeatureStep,
  MinorItem,
  ReReviewVerdict,
  StorySummary,
  WorkflowFeatureRecord,
  WorkflowFinding,
  WorkflowFindingDraft,
  WorkflowRuling,
} from "./types";

export interface FeatureSteps {
  repoGates(): Promise<RepoGateRun>;
  branchReview(seed: string, facts: BranchReviewFacts): Promise<ReviewOutcome<BranchReviewVerdict>>;
  branchFix(findings: readonly WorkflowFinding[]): Promise<BranchFixOutcome>;
  branchReReview(findings: readonly WorkflowFinding[], fixBase: string): Promise<ReviewOutcome<ReReviewVerdict>>;
  adjudicate(items: readonly WorkflowFinding[]): Promise<readonly WorkflowRuling[]>;
  publish(record: WorkflowFeatureRecord): Promise<PublishOutcome>;
  head(): Promise<string>;
}

export interface FeatureSink {
  update(record: WorkflowFeatureRecord): Promise<void>;
  ledger(text: string): Promise<void>;
  step(step: FeatureStep, record: WorkflowFeatureRecord): void;
}

export interface FeatureFacts {
  readonly stories: readonly StorySummary[];
  readonly parked: readonly LedgerItem[];
  readonly cannotVerify: readonly LedgerItem[];
}

export interface FeatureEnv {
  readonly steps: FeatureSteps;
  readonly sink: FeatureSink;
  readonly facts: FeatureFacts;
  readonly record: WorkflowFeatureRecord;
  readonly aborted: () => boolean;
  readonly now: () => number;
}

type Patch = Partial<WorkflowFeatureRecord>;
type StepFn = (env: FeatureEnv, rec: WorkflowFeatureRecord) => Promise<Patch>;

const isBlocking = (f: WorkflowFindingDraft): boolean => f.severity !== "minor";
const minorIssues = (drafts: readonly WorkflowFindingDraft[]): string[] =>
  drafts.filter((f) => !isBlocking(f)).map((f) => f.issue);

function assign(
  rec: WorkflowFeatureRecord,
  drafts: readonly WorkflowFindingDraft[],
): { findings: WorkflowFinding[]; nextFindingId: number } {
  const findings = drafts.map((d, i) => ({ ...d, id: `B${rec.nextFindingId + i}` }));
  return { findings, nextFindingId: rec.nextFindingId + drafts.length };
}

function minorFinding(m: MinorItem): WorkflowFinding {
  return { id: m.id, kind: "quality", severity: "minor", issue: `${m.storyId}: ${m.text}` };
}

function fixNowMinors(rec: WorkflowFeatureRecord): WorkflowFinding[] {
  return rec.minors.filter((m) => m.triage === "fix-now").map(minorFinding);
}

function storyNote(s: StorySummary): string | undefined {
  const parts = [s.state === "complete" ? undefined : s.reason, s.unreviewed ? "unreviewed" : undefined];
  const kept = parts.filter((p): p is string => typeof p === "string" && p !== "");
  return kept.length > 0 ? kept.join("; ") : undefined;
}

function reviewFacts(env: FeatureEnv, rec: WorkflowFeatureRecord): BranchReviewFacts {
  return {
    stories: env.facts.stories.map((s) => {
      const note = storyNote(s);
      return { id: s.id, state: s.state, ...(note ? { note } : {}) };
    }),
    minors: rec.minors.map((m) => ({ id: m.id, storyId: m.storyId, text: m.text })),
    parked: env.facts.parked,
    cannotVerify: env.facts.cannotVerify,
    gateFindings: rec.gateFindings,
  };
}

async function repoGatesStep(env: FeatureEnv, rec: WorkflowFeatureRecord): Promise<Patch> {
  const run = await env.steps.repoGates();
  const gateOpen: WorkflowFindingDraft[] = env.facts.stories
    .filter((s) => s.state === "complete-gate-open")
    .map((s) => ({
      kind: "gate",
      severity: "important",
      issue: `${s.id} ended with a red gate (${s.reason ?? "gate red"}). Make its gates green.`,
    }));
  const { findings, nextFindingId } = assign(rec, [...run.findings, ...gateOpen]);
  if (run.summary.failing.length > 0) {
    await env.sink.ledger(ledgerText.note(`repo gates red: ${run.summary.failing.join(", ")}`));
  }
  return { repoGates: run.summary, gateFindings: findings, nextFindingId, step: "branch-review" };
}

async function branchReviewStep(env: FeatureEnv, rec: WorkflowFeatureRecord): Promise<Patch> {
  if (!rec.seed) {
    await env.sink.ledger(ledgerText.reviewSkipped("branch review: no seed"));
    return { reviewRan: false, step: "branch-fix" };
  }
  const out = await env.steps.branchReview(rec.seed, reviewFacts(env, rec));
  if (!out.ran) {
    await env.sink.ledger(ledgerText.reviewSkipped(`branch review: ${out.why}`));
    return { reviewRan: false, step: "branch-fix" };
  }
  for (const item of out.verdict.cannotVerify) await env.sink.ledger(ledgerText.note(`cannot-verify: ${item}`));
  const triage = new Map(out.verdict.minorTriage.map((t) => [t.id, t.decision]));
  const { findings, nextFindingId } = assign(rec, out.verdict.findings.filter(isBlocking));
  return {
    reviewRan: true,
    reviewOpen: findings,
    nextFindingId,
    minors: rec.minors.map((m) => ({ ...m, triage: triage.get(m.id) ?? "leave" })),
    newMinors: [...rec.newMinors, ...minorIssues(out.verdict.findings)],
    step: "branch-fix",
  };
}

async function branchFixStep(env: FeatureEnv, rec: WorkflowFeatureRecord): Promise<Patch> {
  const toFix = [...rec.reviewOpen, ...fixNowMinors(rec), ...rec.gateFindings];
  if (toFix.length === 0) return { step: "final-gates" };
  const fixBase = await env.steps.head();
  await env.sink.ledger(ledgerText.note(`branch fix: ${toFix.length} item(s): ${toFix.map((f) => f.id).join(", ")}`));
  const out = await env.steps.branchFix(toFix);
  if (out.failure) await env.sink.ledger(ledgerText.note(`branch fix session failed: ${out.failure}`));
  if (out.autoCommitted) await env.sink.ledger(ledgerText.note("auto-committed the branch fix's edits"));
  return { fixBase, fixRan: true, step: "branch-rereview" };
}

async function branchReReviewStep(env: FeatureEnv, rec: WorkflowFeatureRecord): Promise<Patch> {
  const items = [...rec.reviewOpen, ...fixNowMinors(rec)];
  if (items.length === 0 || !rec.fixBase) return { step: "adjudicate" };
  const out = await env.steps.branchReReview(items, rec.fixBase);
  if (!out.ran) {
    await env.sink.ledger(ledgerText.reviewSkipped(`branch re-review: ${out.why}`));
    return { step: "adjudicate" };
  }
  const stillOpen = new Set(out.verdict.verdicts.filter((v) => !v.addressed).map((v) => v.id));
  const { findings, nextFindingId } = assign(rec, out.verdict.newFindings.filter(isBlocking));
  return {
    reviewOpen: [...rec.reviewOpen.filter((f) => stillOpen.has(f.id)), ...findings],
    nextFindingId,
    minors: rec.minors.map((m) => (m.triage === "fix-now" && stillOpen.has(m.id) ? { ...m, triage: "leave" } : m)),
    newMinors: [...rec.newMinors, ...minorIssues(out.verdict.newFindings)],
    step: "adjudicate",
  };
}

async function adjudicateStep(env: FeatureEnv, rec: WorkflowFeatureRecord): Promise<Patch> {
  if (rec.reviewOpen.length === 0) return { step: "final-gates" };
  return { rulings: await env.steps.adjudicate(rec.reviewOpen), step: "final-gates" };
}

async function finalGatesStep(env: FeatureEnv, rec: WorkflowFeatureRecord): Promise<Patch> {
  if (!rec.fixRan) return { ...(rec.repoGates ? { finalGates: rec.repoGates } : {}), step: "publish" };
  const run = await env.steps.repoGates();
  if (run.summary.failing.length > 0) {
    await env.sink.ledger(ledgerText.note(`final gates red: ${run.summary.failing.join(", ")}`));
  }
  return { finalGates: run.summary, step: "publish" };
}

async function publishStep(env: FeatureEnv, rec: WorkflowFeatureRecord): Promise<Patch> {
  const out = await env.steps.publish(rec);
  const head = await env.steps.head();
  const why = out.reasons.length > 0 ? `: ${out.reasons.join("; ")}` : "";
  await env.sink.ledger(ledgerText.note(`feature ${out.outcome}${out.url ? ` ${out.url}` : ""}${why}`));
  return {
    outcome: out.outcome,
    ci: out.ci,
    reasons: out.reasons,
    ...(out.url ? { url: out.url } : {}),
    head,
    passed: featurePassed({ ...(rec.finalGates ? { finalGates: rec.finalGates } : {}), stories: env.facts.stories }),
    endedAt: new Date().toISOString(),
    step: "done",
  };
}

const STEPS: Readonly<Record<Exclude<FeatureStep, "done">, StepFn>> = {
  "repo-gates": repoGatesStep,
  "branch-review": branchReviewStep,
  "branch-fix": branchFixStep,
  "branch-rereview": branchReReviewStep,
  adjudicate: adjudicateStep,
  "final-gates": finalGatesStep,
  publish: publishStep,
};

export async function runFeatureMachine(env: FeatureEnv): Promise<WorkflowFeatureRecord> {
  let rec = env.record;
  for (;;) {
    const step = rec.step;
    if (step === "done") break;
    if (env.aborted()) {
      throw new NaxError("Run aborted during the feature workflow", "WORKFLOW_ABORTED", {
        stage: "workflow",
        storyId: "_run",
        step,
      });
    }
    env.sink.step(step, rec);
    const started = env.now();
    const patch = await STEPS[step](env, rec);
    rec = { ...rec, ...patch, timings: { ...rec.timings, [step]: (rec.timings[step] ?? 0) + (env.now() - started) } };
    await env.sink.update(rec);
  }
  env.sink.step("done", rec);
  return rec;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run the Step 2 command, then `bun run check:complexity`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/workflow/feature-machine.ts test/unit/workflow/feature-machine.test.ts
git commit -m "feat(workflow): the feature workflow state machine (one review, one fix, one re-review)"
```

---

### Task 11: `runWorkflowFeature` — wiring the machine to the real steps

**Files:**
- Modify: `src/execution/status-file.ts` (the `WorkflowStatusBlock` type only), `src/execution/index.ts` (export it)
- Create: `src/workflow/status-block.ts`, `src/workflow/feature-env.ts`, `src/workflow/feature.ts`
- Modify: `src/workflow/feature-context.ts` (`statusWriter` typed with `WorkflowStatusBlock`), `src/workflow/index.ts`
- Test: `test/unit/workflow/feature.test.ts`, `test/unit/workflow/feature-env.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 5-10, plus `createLiveWorkflowAdvisor`, `FEATURE_SCOPE` (Task 4) and `adjudicateResidual` (PR2).
- Produces:
  ```ts
  // @/execution
  export interface WorkflowStatusBlock {
    step: string;
    stories: Record<string, { state: string; round: number }>;
    outcome?: string;
    url?: string;
  }
  // workflow/status-block.ts
  export function workflowStatusBlock(stories: readonly StorySummary[], step: string, rec?: Pick<WorkflowFeatureRecord, "outcome" | "url">): WorkflowStatusBlock;
  // workflow/feature-env.ts
  export interface FeatureEnvInput {
    readonly stories: readonly StorySummary[]; readonly ledgerItems: LedgerItems; readonly record: WorkflowFeatureRecord;
    readonly meter: TokenMeter; readonly preflight: { readonly path: string; readonly file: PreflightFile } | null; readonly specPath: string;
  }
  export function buildFeatureEnv(fc: FeatureContext, input: WorkflowFeatureInput, ctx: FeatureEnvInput): FeatureEnv;
  // workflow/feature.ts
  export interface WorkflowFeatureResult { readonly passed: boolean; readonly outcome: FeatureOutcome | "already-finished"; readonly url?: string; readonly reasons: readonly string[] }
  export const _featureRunDeps: { buildFeatureContext: typeof buildFeatureContext; runFeatureMachine: typeof runFeatureMachine };
  export function runWorkflowFeature(input: WorkflowFeatureInput): Promise<WorkflowFeatureResult | null>;
  // workflow/index.ts adds: runWorkflowFeature, type WorkflowFeatureInput, type WorkflowFeatureResult
  ```

- [ ] **Step 1: Write the failing tests**

`test/unit/workflow/feature-env.test.ts`:
```ts
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanupTempDir, makeFeatureContext, makeTempDir } from "@test/helpers";
import type { Advisor } from "@/advisor";
import { buildFeatureEnv } from "@/workflow/feature-env";
import { newFeatureRecord } from "@/workflow/feature-record";
import { readResult } from "@/workflow/result";
import { _workflowDeps } from "@/workflow/step-context";
import { startTokenMeter } from "@/workflow/tokens";

const original = { ..._workflowDeps };
const dirs: string[] = [];
afterEach(async () => {
  Object.assign(_workflowDeps, original);
  await Promise.all(dirs.map(cleanupTempDir));
  dirs.length = 0;
});

const noDecisions: Advisor = {
  advise: async () => ({ decision: null, fallbackReason: "off" }),
  recordReuse: async () => null,
  adviseBatch: async () => ({ kind: "residual", items: [], diagnoses: {} }),
};

function setup() {
  const runDir = makeTempDir("wf-env-");
  dirs.push(runDir);
  _workflowDeps.createAdvisor = () => noDecisions;
  const fc = makeFeatureContext({ runDir });
  const blocks: unknown[] = [];
  const env = buildFeatureEnv(
    fc,
    {
      runtime: fc.callCtx.runtime,
      config: fc.config,
      prd: fc.prd,
      feature: fc.feature,
      workdir: fc.projectDir,
      branch: fc.branch,
      runId: fc.runId,
      agentName: "claude",
      statusWriter: { setWorkflowStatus: (b) => blocks.push(b) },
    },
    {
      stories: [{ id: "US-001", title: "A", state: "complete", rounds: 2, unreviewed: false, flagged: 0 }],
      ledgerItems: { deferredMinors: [], cannotVerify: [], parked: [] },
      record: { ...newFeatureRecord({ now: "t", seed: "s", minors: [] }), tokensByRole: { "wf-implementer": { inputTokens: 1, outputTokens: 1, costUsd: 1, calls: 1 } } },
      meter: startTokenMeter(undefined),
      preflight: null,
      specPath: "",
    },
  );
  return { fc, env, blocks };
}

describe("buildFeatureEnv", () => {
  test("sink.update writes featureWorkflow into this run's result.json, keeping prior tokens", async () => {
    const { fc, env } = setup();
    await env.sink.update({ ...env.record, step: "branch-review" });
    const file = await readResult(fc.runDir);
    expect(file?.featureWorkflow?.step).toBe("branch-review");
    expect(file?.featureWorkflow?.tokensByRole["wf-implementer"]?.calls).toBe(1);
  });

  test("sink.step sets the status.json workflow block", () => {
    const { env, blocks } = setup();
    env.sink.step("publish", { ...env.record, outcome: "draft", url: "u" });
    expect(blocks).toEqual([{ step: "publish", stories: { "US-001": { state: "complete", round: 2 } }, outcome: "draft", url: "u" }]);
  });

  test("adjudicate is feature-scoped: default holds land as _run ledger lines (P4-R18)", async () => {
    const { fc, env } = setup();
    const rulings = await env.steps.adjudicate([{ id: "B1", kind: "quality", severity: "important", issue: "drift" }]);
    expect(rulings).toHaveLength(1);
    expect(rulings[0]?.action).toBe("hold");
    expect(await Bun.file(join(fc.runDir, "ledger.md")).text()).toContain("_run: Ruling: hold B1: drift");
  });
});
```
`fc.callCtx.runtime` comes from `makeMockCallContext()`. If that runtime type doesn't satisfy `NaxRuntime`, build one with `makeTestRuntime()` (and close it in `afterEach`). The ledger line format comes from `defaultHold` + `ledgerText.ruling` (`hold B1: drift — deterministic default (no advisor ruling) — …`). The ledger file is appended without `ensureLedger` here, which is fine because `appendFile` creates it.

`test/unit/workflow/feature.test.ts`:
```ts
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  cleanupTempDir,
  makeFeatureContext,
  makeNaxConfig,
  makeTempDir,
  makeTestPRD,
  makeTestRuntime,
  makeTestStory,
} from "@test/helpers";
import type { NaxRuntime } from "@/runtime";
import { _featureRunDeps, runWorkflowFeature } from "@/workflow/feature";
import type { FeatureEnv } from "@/workflow/feature-machine";
import { newFeatureRecord } from "@/workflow/feature-record";
import { newStoryRecord, upsertFeatureRecord, upsertStoryRecord } from "@/workflow/result";
import { _workflowDeps } from "@/workflow/step-context";

const originalRun = { ..._featureRunDeps };
const originalWf = { ..._workflowDeps };
const dirs: string[] = [];
const runtimes: NaxRuntime[] = [];
afterEach(async () => {
  Object.assign(_featureRunDeps, originalRun);
  Object.assign(_workflowDeps, originalWf);
  await Promise.allSettled(runtimes.map((r) => r.close()));
  runtimes.length = 0;
  await Promise.all(dirs.map(cleanupTempDir));
  dirs.length = 0;
});

function setup(over: { dryRun?: boolean } = {}) {
  const out = makeTempDir("wf-feat-");
  dirs.push(out);
  const config = makeNaxConfig({ outputDir: out });
  const runtime = makeTestRuntime({ config, workdir: "/repo", ...(over.dryRun ? { dryRun: true } : {}) });
  runtimes.push(runtime);
  const prd = makeTestPRD([makeTestStory({ id: "US-001", status: "passed", passes: true })]);
  const featureDir = join(out, "workflow", prd.feature);
  const fc = makeFeatureContext({ prd, feature: prd.feature, featureDir, runDir: join(featureDir, "r-now"), runId: "r-now" });
  let disposed = 0;
  _featureRunDeps.buildFeatureContext = async () => ({
    fc,
    dispose: async () => {
      disposed++;
    },
  });
  _workflowDeps.git = async (args) =>
    args[0] === "rev-parse" ? { stdout: "headX\n", exitCode: 0 } : { stdout: "", exitCode: 1 };
  const envs: FeatureEnv[] = [];
  _featureRunDeps.runFeatureMachine = async (env) => {
    envs.push(env);
    return { ...env.record, step: "done", outcome: "draft", passed: false, reasons: ["CI failed"], url: "u" };
  };
  const input = {
    runtime,
    config,
    prd,
    feature: prd.feature,
    workdir: "/repo",
    branch: "feat/x",
    runId: "r-now",
    agentName: "claude",
  };
  return { fc, input, envs, featureDir, disposed: () => disposed };
}

describe("runWorkflowFeature", () => {
  test("dry run: skipped before any context is built", async () => {
    const { input, envs, disposed } = setup({ dryRun: true });
    expect(await runWorkflowFeature(input)).toBeNull();
    expect(envs).toHaveLength(0);
    expect(disposed()).toBe(0);
  });

  test("a fresh feature: new record at repo-gates; the result comes from the final record", async () => {
    const { input, envs, disposed } = setup();
    const result = await runWorkflowFeature(input);
    expect(envs[0]?.record.step).toBe("repo-gates");
    expect(result).toEqual({ passed: false, outcome: "draft", url: "u", reasons: ["CI failed"] });
    expect(disposed()).toBe(1);
  });

  test("an unfinished prior record is resumed (P4-R1)", async () => {
    const { input, envs, featureDir } = setup();
    const prior = join(featureDir, "r-old");
    await upsertStoryRecord(prior, { runId: "r-old", feature: input.feature }, newStoryRecord("US-001", 5, "t"));
    await upsertFeatureRecord(prior, { runId: "r-old", feature: input.feature }, {
      ...newFeatureRecord({ now: "t", seed: "s", minors: [] }),
      step: "branch-fix",
    });
    await runWorkflowFeature(input);
    expect(envs[0]?.record.step).toBe("branch-fix");
  });

  test("a finished prior record at the same HEAD skips the machine (already finished)", async () => {
    const { input, envs, featureDir } = setup();
    const prior = join(featureDir, "r-old");
    await upsertStoryRecord(prior, { runId: "r-old", feature: input.feature }, newStoryRecord("US-001", 5, "t"));
    await upsertFeatureRecord(prior, { runId: "r-old", feature: input.feature }, {
      ...newFeatureRecord({ now: "t", seed: "s", minors: [] }),
      step: "done",
      head: "headX",
      passed: true,
      outcome: "ready",
      url: "https://gh/pr/1",
    });
    expect(await runWorkflowFeature(input)).toEqual({
      passed: true,
      outcome: "already-finished",
      url: "https://gh/pr/1",
      reasons: [],
    });
    expect(envs).toHaveLength(0);
  });

  test("a machine throw still disposes and propagates", async () => {
    const { input, disposed } = setup();
    _featureRunDeps.runFeatureMachine = async () => {
      throw new Error("boom");
    };
    await expect(runWorkflowFeature(input)).rejects.toThrow("boom");
    expect(disposed()).toBe(1);
  });
});
```
Read `makeTestRuntime`'s options first. If it doesn't take `dryRun`, set it on the runtime the way other tests build a dry-run runtime (grep `dryRun: true` in `test/unit/finish/phase*.test.ts`).

- [ ] **Step 2: Run them to verify they fail**

Run: `timeout 60 bun test test/unit/workflow/feature-env.test.ts test/unit/workflow/feature.test.ts --timeout=60000`
Expected: FAIL (the modules don't exist).

- [ ] **Step 3: Implement**

`src/execution/status-file.ts`, next to `AdvisorSummary` usage, add the exported interface:
```ts
/** A5 workflow mode (spec §9, P4-R12): the feature step and every story's state. Absent outside workflow mode. */
export interface WorkflowStatusBlock {
  step: string;
  stories: Record<string, { state: string; round: number }>;
  outcome?: string;
  url?: string;
}
```
`src/execution/index.ts`: add `export type { WorkflowStatusBlock } from "./status-file";`.

`src/workflow/feature-context.ts`: import `type WorkflowStatusBlock` from `@/execution` and type `statusWriter` as `{ setWorkflowStatus?(block: WorkflowStatusBlock): void }`.

`src/workflow/status-block.ts`:
```ts
/** The status.json `workflow` block (spec §9, P4-R12). */
import type { WorkflowStatusBlock } from "@/execution";
import type { StorySummary, WorkflowFeatureRecord } from "./types";

export function workflowStatusBlock(
  stories: readonly StorySummary[],
  step: string,
  rec?: Pick<WorkflowFeatureRecord, "outcome" | "url">,
): WorkflowStatusBlock {
  return {
    step,
    stories: Object.fromEntries(stories.map((s) => [s.id, { state: s.state, round: s.rounds }])),
    ...(rec?.outcome ? { outcome: rec.outcome } : {}),
    ...(rec?.url ? { url: rec.url } : {}),
  };
}
```

`src/workflow/feature-env.ts`:
```ts
/** Wires the feature machine to the real steps, the result.json sink and the status block (spec §7). */
import { adjudicateResidual } from "./adjudicate";
import { createLiveWorkflowAdvisor, FEATURE_SCOPE } from "./advisor-live";
import { flaggedCount } from "./approval";
import { runBranchFix } from "./branch-fix";
import { runBranchReReview, runBranchReview } from "./branch-review";
import type { FeatureContext, WorkflowFeatureInput } from "./feature-context";
import type { FeatureEnv, FeatureSink, FeatureSteps } from "./feature-machine";
import { publish } from "./finalize";
import { readHead } from "./git";
import { appendLedger } from "./ledger";
import type { LedgerItems } from "./ledger-items";
import type { PreflightFile } from "./preflight";
import { runRepoGates } from "./repo-gates";
import { upsertFeatureRecord } from "./result";
import { workflowStatusBlock } from "./status-block";
import { _workflowDeps } from "./step-context";
import { addRoleTokens, type TokenMeter } from "./tokens";
import type { StorySummary, WorkflowFeatureRecord } from "./types";

export interface FeatureEnvInput {
  readonly stories: readonly StorySummary[];
  readonly ledgerItems: LedgerItems;
  readonly record: WorkflowFeatureRecord;
  readonly meter: TokenMeter;
  readonly preflight: { readonly path: string; readonly file: PreflightFile } | null;
  /** Repo-relative spec path, "" when the feature has none. */
  readonly specPath: string;
}

export function buildFeatureEnv(fc: FeatureContext, input: WorkflowFeatureInput, ctx: FeatureEnvInput): FeatureEnv {
  const spec = ctx.specPath ? { specPath: ctx.specPath } : {};
  const advisor = _workflowDeps.createAdvisor({
    callCtx: fc.callCtx,
    repoRoot: fc.projectDir,
    outputDir: fc.outputDir,
    feature: fc.feature,
    runId: fc.runId,
    specPath: ctx.specPath,
    workdir: fc.projectDir,
  });
  const live = createLiveWorkflowAdvisor({ advisor, feature: fc.feature, dependents: [] });
  const ledger = (text: string) => appendLedger(fc.runDir, FEATURE_SCOPE, text);
  const preflightFile = ctx.preflight?.file ?? null;
  const steps: FeatureSteps = {
    repoGates: () => runRepoGates(fc),
    branchReview: (seed, facts) =>
      runBranchReview(fc, { seed, ...spec, ...(ctx.preflight ? { preflightPath: ctx.preflight.path } : {}), facts }),
    branchFix: (findings) => runBranchFix(fc, { ...spec, findings }),
    branchReReview: (findings, fixBase) => runBranchReReview(fc, { ...spec, findings, fixBase }),
    adjudicate: (items) => adjudicateResidual(live, { storyId: FEATURE_SCOPE, items, redGates: [] }, ledger),
    publish: (record) =>
      publish(fc, {
        record,
        stories: ctx.stories,
        flagged: flaggedCount(ctx.stories, preflightFile, record.rulings),
        advisor,
        preflight: preflightFile,
      }),
    head: () => readHead(fc.projectDir),
  };
  const header = { runId: fc.runId, feature: fc.feature };
  const sink: FeatureSink = {
    update: (record) =>
      upsertFeatureRecord(fc.runDir, header, {
        ...record,
        tokensByRole: addRoleTokens(ctx.record.tokensByRole, ctx.meter.byRole()),
      }),
    ledger,
    step: (step, record) => input.statusWriter?.setWorkflowStatus?.(workflowStatusBlock(ctx.stories, step, record)),
  };
  return {
    steps,
    sink,
    facts: { stories: ctx.stories, parked: ctx.ledgerItems.parked, cannotVerify: ctx.ledgerItems.cannotVerify },
    record: ctx.record,
    aborted: () => fc.runSignal?.aborted === true,
    now: () => _workflowDeps.now(),
  };
}
```
`createAdvisor`'s argument type is `AdvisorCallContext`. If it requires a field not listed here, add it the way `stage-env.ts` does, minus the heads-up channel (P4-R9).

`src/workflow/feature.ts`:
```ts
/**
 * runWorkflowFeature (spec §7): after the last story, one feature workflow — repo gates,
 * one branch review, one branch fix, one re-review, adjudication, gates again, then publish.
 * Resumes an unfinished prior record; skips when already finished at this HEAD (P4-R1).
 */
import { getSafeLogger } from "@/logger";
import { specPathFor } from "./brief";
import { buildFeatureContext, type FeatureContext, type WorkflowFeatureInput } from "./feature-context";
import { buildFeatureEnv } from "./feature-env";
import { runFeatureMachine } from "./feature-machine";
import {
  collectStoryRecords,
  loadPriorFeature,
  minorsFrom,
  newestPreflight,
  newFeatureRecord,
  summariseStories,
} from "./feature-record";
import { readHead } from "./git";
import { appendLedger, ensureLedger, ledgerText } from "./ledger";
import { collectLedgerItems } from "./ledger-items";
import { resolveSeed } from "./seed";
import { startTokenMeter, type TokenMeter } from "./tokens";
import type { FeatureOutcome, StorySummary, WorkflowFeatureRecord } from "./types";

export interface WorkflowFeatureResult {
  readonly passed: boolean;
  readonly outcome: FeatureOutcome | "already-finished";
  readonly url?: string;
  readonly reasons: readonly string[];
}

export const _featureRunDeps = { buildFeatureContext, runFeatureMachine };

export async function runWorkflowFeature(input: WorkflowFeatureInput): Promise<WorkflowFeatureResult | null> {
  if (input.runtime.dryRun || input.abortSignal?.aborted) {
    getSafeLogger()?.info("workflow", "Feature workflow skipped", {
      storyId: "_run",
      reason: input.runtime.dryRun ? "dry-run" : "aborted",
    });
    return null;
  }
  const meter = startTokenMeter(input.runtime.dispatchEvents);
  const { fc, dispose } = await _featureRunDeps.buildFeatureContext(input);
  try {
    return await runInContext(fc, input, meter);
  } finally {
    meter.stop();
    await dispose();
  }
}

function resultOf(rec: WorkflowFeatureRecord): WorkflowFeatureResult {
  return {
    passed: rec.passed ?? false,
    outcome: rec.outcome ?? "local-only",
    ...(rec.url ? { url: rec.url } : {}),
    reasons: rec.reasons,
  };
}

async function startRecord(fc: FeatureContext, prior: WorkflowFeatureRecord | null): Promise<WorkflowFeatureRecord> {
  if (prior && prior.step !== "done") {
    await appendLedger(fc.runDir, "_run", ledgerText.note(`resumed the feature workflow at ${prior.step}`));
    return prior;
  }
  return newFeatureRecord({
    now: new Date().toISOString(),
    seed: await resolveSeed(fc.projectDir, fc.prd),
    minors: minorsFrom((await collectLedgerItems(fc.featureDir)).deferredMinors),
  });
}

function logComplete(stories: readonly StorySummary[], rec: WorkflowFeatureRecord): void {
  getSafeLogger()?.info("workflow", "Workflow complete", {
    storyId: "_run",
    outcome: rec.outcome,
    passed: rec.passed,
    ...(rec.url ? { url: rec.url } : {}),
    reasons: rec.reasons,
    stories: Object.fromEntries(stories.map((s) => [s.id, s.state])),
  });
}

async function runInContext(
  fc: FeatureContext,
  input: WorkflowFeatureInput,
  meter: TokenMeter,
): Promise<WorkflowFeatureResult> {
  await ensureLedger(fc.runDir, fc.runId, fc.feature);
  const stories = summariseStories(fc.prd, await collectStoryRecords(fc.featureDir));
  const prior = await loadPriorFeature(fc.featureDir, fc.runId);
  if (prior?.step === "done" && prior.head === (await readHead(fc.projectDir))) {
    getSafeLogger()?.info("workflow", "Feature workflow already finished at this HEAD — skipped", {
      storyId: "_run",
      ...(prior.url ? { url: prior.url } : {}),
    });
    return { ...resultOf(prior), outcome: "already-finished" };
  }
  const record = await startRecord(fc, prior);
  const env = buildFeatureEnv(fc, input, {
    stories,
    ledgerItems: await collectLedgerItems(fc.featureDir),
    record,
    meter,
    preflight: await newestPreflight(fc.featureDir),
    specPath: await specPathFor(fc.feature, fc.projectDir),
  });
  const final = await _featureRunDeps.runFeatureMachine(env);
  logComplete(stories, final);
  return resultOf(final);
}
```

`src/workflow/index.ts`: add
```ts
export type { WorkflowFeatureInput } from "./feature-context";
export type { WorkflowFeatureResult } from "./feature";
export { runWorkflowFeature } from "./feature";
```

- [ ] **Step 4: Run them to verify they pass**

Run the Step 2 command, then `timeout 120 bun test test/unit/workflow --timeout=60000`, `bun run check:import-cycles` and `bun run check:file-sizes`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/execution/status-file.ts src/execution/index.ts src/workflow test/unit/workflow
git commit -m "feat(workflow): runWorkflowFeature wires the feature machine to its steps, result.json and the status block"
```

---
### Task 12: Run start — the status writer block and pre-flight placement

**Files:**
- Modify: `src/execution/status-file.ts` (`NaxStatusFile.workflow`, `RunStateSnapshot.workflow`, `buildStatusSnapshot`), `src/execution/status-writer.ts` (`setWorkflowStatus`)
- Create: `src/workflow/preflight-run.ts`; Modify: `src/workflow/index.ts`
- Modify: `src/execution/unified-executor.ts` (`_unifiedExecutorDeps.runWorkflowPreflight` + the call)
- Test: create `test/unit/execution/status-writer-workflow.test.ts`, `test/unit/workflow/preflight-run.test.ts`, `test/unit/execution/unified-executor-preflight.test.ts`

**Interfaces:**
- Consumes: `buildFeatureContext` (Task 6); `newestPreflight` (Task 5); `runPreflight`, `preflightPath` (PR3); `specPathFor` (`./brief`); `WorkflowStatusBlock` (Task 11).
- Produces:
  ```ts
  // StatusWriter
  setWorkflowStatus(block: WorkflowStatusBlock): void;   // NaxStatusFile.workflow
  // workflow/preflight-run.ts (exported from @/workflow)
  export interface WorkflowRunStartInput {
    readonly runtime: NaxRuntime; readonly config: NaxConfig; readonly prd: PRD; readonly feature: string;
    readonly workdir: string; readonly runId: string; readonly agentName: string;
    readonly abortSignal?: AbortSignal; readonly interactionChain?: InteractionChain | null;
  }
  export const _preflightRunDeps: { buildFeatureContext: typeof buildFeatureContext };
  export function adoptPriorPreflight(featureDir: string, runDir: string): Promise<boolean>;
  export function runWorkflowPreflight(input: WorkflowRunStartInput): Promise<void>;
  // unified-executor
  _unifiedExecutorDeps.runWorkflowPreflight(input: WorkflowRunStartInput): Promise<void>;
  ```

- [ ] **Step 1: Write the failing tests**

`test/unit/execution/status-writer-workflow.test.ts`:
```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanupTempDir, makePRD, makeTempDir } from "@test/helpers";
import { DEFAULT_CONFIG } from "@/config";
import { StatusWriter } from "@/execution";

let dir: string;
beforeEach(() => {
  dir = makeTempDir("nax-status-writer-workflow-");
});
afterEach(() => cleanupTempDir(dir));

function writer(): StatusWriter {
  return new StatusWriter(join(dir, "status.json"), DEFAULT_CONFIG, {
    runId: "r1",
    feature: "f",
    startedAt: new Date().toISOString(),
    dryRun: false,
    startTimeMs: Date.now(),
    pid: process.pid,
  });
}

describe("StatusWriter — workflow block (spec §9)", () => {
  test("absent unless set; set -> written to status.json", async () => {
    const w = writer();
    w.setPrd(makePRD());
    await w.update(0, 1);
    expect((await Bun.file(join(dir, "status.json")).json()).workflow).toBeUndefined();
    const block = { step: "publish", stories: { "US-001": { state: "complete", round: 1 } }, outcome: "draft" };
    w.setWorkflowStatus(block);
    await w.update(0, 1);
    expect((await Bun.file(join(dir, "status.json")).json()).workflow).toEqual(block);
  });
});
```

`test/unit/workflow/preflight-run.test.ts`:
```ts
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  cleanupTempDir,
  makeFeatureContext,
  makeNaxConfig,
  makeTempDir,
  makeTestPRD,
  makeTestRuntime,
  makeTestStory,
} from "@test/helpers";
import type { Advisor, BatchRequest } from "@/advisor";
import type { NaxRuntime } from "@/runtime";
import { preflightPath } from "@/workflow/preflight";
import { _preflightRunDeps, adoptPriorPreflight, runWorkflowPreflight } from "@/workflow/preflight-run";
import { newStoryRecord, upsertStoryRecord } from "@/workflow/result";
import { _workflowDeps } from "@/workflow/step-context";

const originalRun = { ..._preflightRunDeps };
const originalWf = { ..._workflowDeps };
const dirs: string[] = [];
const runtimes: NaxRuntime[] = [];
afterEach(async () => {
  Object.assign(_preflightRunDeps, originalRun);
  Object.assign(_workflowDeps, originalWf);
  await Promise.allSettled(runtimes.map((r) => r.close()));
  runtimes.length = 0;
  await Promise.all(dirs.map(cleanupTempDir));
  dirs.length = 0;
});

function setup(opts: { preflight?: boolean; batchThrows?: boolean } = {}) {
  const out = makeTempDir("wf-pfr-");
  dirs.push(out);
  const config = makeNaxConfig({ outputDir: out, workflow: { preflight: opts.preflight ?? true } });
  const runtime = makeTestRuntime({ config, workdir: "/repo" });
  runtimes.push(runtime);
  const featureDir = join(out, "workflow", "f");
  const runDir = join(featureDir, "r-now");
  _preflightRunDeps.buildFeatureContext = async () => ({
    fc: makeFeatureContext({ featureDir, runDir, runId: "r-now" }),
    dispose: async () => {},
  });
  const calls: BatchRequest[] = [];
  const advisor: Advisor = {
    advise: async () => ({ decision: null }),
    recordReuse: async () => null,
    adviseBatch: async (req) => {
      calls.push(req);
      if (opts.batchThrows) throw new Error("ladder down");
      return { kind: "preflight", overlap: [], items: [] };
    },
  };
  _workflowDeps.createAdvisor = () => advisor;
  const prd = makeTestPRD([
    makeTestStory({ id: "US-001" }),
    makeTestStory({ id: "US-002", status: "passed", passes: true }),
    makeTestStory({ id: "US-003", status: "skipped" }),
  ]);
  const input = { runtime, config, prd, feature: "f", workdir: "/repo", runId: "r-now", agentName: "claude" };
  return { input, calls, runDir, featureDir };
}

describe("runWorkflowPreflight (P4-R14)", () => {
  test("one batch over the stories not yet passed or skipped; preflight.json written", async () => {
    const { input, calls, runDir } = setup();
    await runWorkflowPreflight(input);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ kind: "preflight", storyIds: ["US-001"] });
    expect(await Bun.file(preflightPath(runDir)).exists()).toBe(true);
  });

  test("workflow.preflight false -> nothing", async () => {
    const { input, calls } = setup({ preflight: false });
    await runWorkflowPreflight(input);
    expect(calls).toHaveLength(0);
  });

  test("a reusable preflight.json from an earlier run is adopted: no second batch", async () => {
    const { input, calls, featureDir, runDir } = setup();
    const old = join(featureDir, "r-old");
    await upsertStoryRecord(old, { runId: "r-old", feature: "f" }, newStoryRecord("US-001", 5, "t"));
    await Bun.write(preflightPath(old), JSON.stringify({ schemaVersion: 1, overlap: [], conflicts: [] }));
    await runWorkflowPreflight(input);
    expect(calls).toHaveLength(0);
    expect(await Bun.file(preflightPath(runDir)).json()).toEqual({ schemaVersion: 1, overlap: [], conflicts: [] });
  });

  test("fail-open: an advisor failure never throws", async () => {
    const { input } = setup({ batchThrows: true });
    await expect(runWorkflowPreflight(input)).resolves.toBeUndefined();
  });
});

describe("adoptPriorPreflight", () => {
  test("never overwrites this run's own file", async () => {
    const { featureDir, runDir } = setup();
    await Bun.write(preflightPath(runDir), JSON.stringify({ schemaVersion: 1, overlap: [], conflicts: [], mine: true }));
    expect(await adoptPriorPreflight(featureDir, runDir)).toBe(false);
  });
});
```
`adviseBatch` is total in production (PR3). The `batchThrows` case pins the outer fail-open guard (`runPreflight` lets a throw through). If `runPreflight` turns out to catch it, the test still passes.

`test/unit/execution/unified-executor-preflight.test.ts` (fixtures follow `unified-executor-fallback-seam.test.ts`):
```ts
import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { makeDispatchContext, makePluginRegistry, makePRD, makeStatusWriter, makeTestRuntime } from "@test/helpers";
import { DEFAULT_CONFIG } from "@/config/defaults";
import { stopHeartbeat } from "@/execution/crash-recovery";
import { _unifiedExecutorDeps, executeUnified, type SequentialExecutionContext } from "@/execution/unified-executor";
import type { NaxRuntime } from "@/runtime";
import type { WorkflowRunStartInput } from "@/workflow";

const WORKDIR = `/tmp/nax-wf-preflight-${randomUUID()}`;
const origDeps = { ..._unifiedExecutorDeps };
const runtimes: NaxRuntime[] = [];
afterEach(async () => {
  Object.assign(_unifiedExecutorDeps, origDeps);
  stopHeartbeat();
  await Promise.allSettled(runtimes.map((r) => r.close()));
  runtimes.length = 0;
});

function configFor(mode: "pipeline" | "workflow") {
  return {
    ...DEFAULT_CONFIG,
    acceptance: { ...DEFAULT_CONFIG.acceptance, enabled: false },
    execution: { ...DEFAULT_CONFIG.execution, mode, maxIterations: 0, iterationDelayMs: 0 },
  };
}

async function run(mode: "pipeline" | "workflow", dryRun = false): Promise<WorkflowRunStartInput[]> {
  const seen: WorkflowRunStartInput[] = [];
  _unifiedExecutorDeps.runWorkflowPreflight = async (input) => {
    seen.push(input);
  };
  const config = configFor(mode);
  const runtime = makeTestRuntime({ config });
  runtimes.push(runtime);
  const ctx: SequentialExecutionContext = {
    prdPath: `${WORKDIR}/prd.json`,
    workdir: WORKDIR,
    config,
    hooks: { hooks: {} },
    feature: "f",
    dryRun,
    useBatch: false,
    pluginRegistry: makePluginRegistry(),
    statusWriter: makeStatusWriter(),
    runId: "run-pf",
    startTime: Date.now(),
    batchPlan: [],
    interactionChain: null,
    ...makeDispatchContext({ runtime }),
  };
  await executeUnified(ctx, makePRD({ feature: "f" }));
  return seen;
}

describe("executeUnified — workflow pre-flight placement (spec §5.3, P4-R14)", () => {
  test("workflow mode: called once with the run's prd, feature, run id and agent", async () => {
    const seen = await run("workflow");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ feature: "f", runId: "run-pf", workdir: WORKDIR });
    expect(typeof seen[0]?.agentName).toBe("string");
  });

  test("pipeline mode and dry runs: never called", async () => {
    expect(await run("pipeline")).toHaveLength(0);
    expect(await run("workflow", true)).toHaveLength(0);
  });
});
```
`makePRD()`'s default story must be pending (not passed), so `isComplete` is false. If it isn't, pass `userStories: [makeStory({ status: "pending", passes: false })]`.

- [ ] **Step 2: Run them to verify they fail**

Run: `timeout 60 bun test test/unit/execution/status-writer-workflow.test.ts test/unit/workflow/preflight-run.test.ts test/unit/execution/unified-executor-preflight.test.ts --timeout=60000`
Expected: FAIL. There is no `setWorkflowStatus`, no `preflight-run`, and no `runWorkflowPreflight` dep.

- [ ] **Step 3: Implement**

`src/execution/status-file.ts`:
- Add `workflow?: WorkflowStatusBlock;` to `NaxStatusFile` (after `mcpAdoption`) and to `RunStateSnapshot`, each with the doc line `/** A5: workflow-mode block (spec §9); absent outside workflow mode. */`.
- In `buildStatusSnapshot`, after the `mcpAdoption` copy:
```ts
  if (state.workflow) {
    snapshot.workflow = state.workflow;
  }
```

`src/execution/status-writer.ts`: import `type WorkflowStatusBlock` from `./status-file`, then add `private _workflow: WorkflowStatusBlock | null = null;` next to `_advisor`. Add the method:
```ts
  /** A5: the workflow-mode block (spec §9, P4-R12), persisted by the next update(). */
  setWorkflowStatus(block: WorkflowStatusBlock): void {
    this._workflow = block;
  }
```
In `getSnapshot`, after the advisor copy, add `if (this._workflow !== null) snapshot.workflow = this._workflow;`.

`src/workflow/preflight-run.ts`:
```ts
/** Pre-flight placement (spec §5.3, §8, P4-R14): once per run, before the first story. Fail-open. */
import { mkdir } from "node:fs/promises";
import { errorMessage } from "@nathapp/nax-agent/internal";
import { type NaxConfig, resolveWorkflowConfig } from "@/config";
import type { InteractionChain } from "@/interaction";
import { getSafeLogger } from "@/logger";
import type { PRD } from "@/prd";
import type { NaxRuntime } from "@/runtime";
import { specPathFor } from "./brief";
import { buildFeatureContext } from "./feature-context";
import { newestPreflight } from "./feature-record";
import { appendLedger, ensureLedger } from "./ledger";
import { preflightPath, runPreflight } from "./preflight";
import { _workflowDeps } from "./step-context";

export interface WorkflowRunStartInput {
  readonly runtime: NaxRuntime;
  readonly config: NaxConfig;
  readonly prd: PRD;
  readonly feature: string;
  readonly workdir: string;
  readonly runId: string;
  readonly agentName: string;
  readonly abortSignal?: AbortSignal;
  readonly interactionChain?: InteractionChain | null;
}

export const _preflightRunDeps = { buildFeatureContext };

function pendingStoryIds(prd: PRD): string[] {
  return prd.userStories.filter((s) => !s.passes && s.status !== "passed" && s.status !== "skipped").map((s) => s.id);
}

/** Copy the newest reusable preflight.json of an earlier run into this run dir, unless it already has one. */
export async function adoptPriorPreflight(featureDir: string, runDir: string): Promise<boolean> {
  if (await Bun.file(preflightPath(runDir)).exists()) return false;
  const prior = await newestPreflight(featureDir);
  if (!prior) return false;
  await mkdir(runDir, { recursive: true });
  await Bun.write(preflightPath(runDir), `${JSON.stringify(prior.file, null, 2)}\n`);
  return true;
}

export async function runWorkflowPreflight(input: WorkflowRunStartInput): Promise<void> {
  if (!resolveWorkflowConfig(input.config).preflight) return;
  const storyIds = pendingStoryIds(input.prd);
  if (storyIds.length === 0) return;
  let dispose: (() => Promise<void>) | undefined;
  try {
    const built = await _preflightRunDeps.buildFeatureContext({ ...input, branch: "" });
    dispose = built.dispose;
    const { fc } = built;
    await ensureLedger(fc.runDir, fc.runId, fc.feature);
    if (await adoptPriorPreflight(fc.featureDir, fc.runDir)) {
      getSafeLogger()?.info("workflow", "Reusing the pre-flight of an earlier run", { storyId: "_run" });
    }
    const advisor = _workflowDeps.createAdvisor({
      callCtx: fc.callCtx,
      repoRoot: fc.projectDir,
      outputDir: fc.outputDir,
      feature: fc.feature,
      runId: fc.runId,
      specPath: await specPathFor(fc.feature, fc.projectDir),
      workdir: fc.projectDir,
    });
    const file = await runPreflight({
      advisor,
      runDir: fc.runDir,
      storyIds,
      ledger: (storyId, text) => appendLedger(fc.runDir, storyId, text),
    });
    getSafeLogger()?.info("workflow", "Pre-flight done", { storyId: "_run", conflicts: file.conflicts.length });
  } catch (err) {
    if (input.abortSignal?.aborted) throw err;
    getSafeLogger()?.warn("workflow", "Pre-flight failed — stories run under the spec as written", {
      storyId: "_run",
      error: errorMessage(err),
    });
  } finally {
    await dispose?.();
  }
}
```

`src/workflow/index.ts`: add `export type { WorkflowRunStartInput } from "./preflight-run"; export { runWorkflowPreflight } from "./preflight-run";`.

`src/execution/unified-executor.ts`:
- Add `isWorkflowMode` to the imports (`import { isWorkflowMode } from "../config";`) and `import type { WorkflowRunStartInput } from "@/workflow";` (type-only: erased, adds no runtime edge).
- After the pre-run pipeline block, before `while (iterations < …)`:
```ts
    // A5 (spec §5.3): the advisor pre-flight runs once before the first story. Fail-open inside.
    if (isWorkflowMode(ctx.config) && !ctx.dryRun) {
      await _unifiedExecutorDeps.runWorkflowPreflight({
        runtime: ctx.runtime,
        config: ctx.config,
        prd: state.prd,
        feature: ctx.feature,
        workdir: ctx.workdir,
        runId: ctx.runId,
        agentName: ctx.agentManager.getDefault(),
        abortSignal: ctx.abortSignal,
        interactionChain: ctx.interactionChain,
      });
    }
```
- In `_unifiedExecutorDeps` add:
```ts
  // Dynamic import: src/workflow is loaded lazily everywhere (no load-time cycle through operations).
  runWorkflowPreflight: async (input: WorkflowRunStartInput): Promise<void> => {
    const { runWorkflowPreflight } = await import("@/workflow");
    return runWorkflowPreflight(input);
  },
```
If `ctx.agentManager` is optional on `SequentialExecutionContext`, use `ctx.agentManager?.getDefault() ?? "claude"` (the Rule 4 accessor).

Then grep `test/unit/execution` and `test/integration` for tests that run `executeUnified` with `mode: "workflow"` (`grep -rln '"workflow"' test/unit/execution test/integration | xargs grep -l executeUnified`). Stub `_unifiedExecutorDeps.runWorkflowPreflight` to a no-op in each, so none dispatches a real advisor call.

- [ ] **Step 4: Run them to verify they pass**

Run the Step 2 command, then `timeout 300 bun test test/unit/execution --timeout=60000`, `bun run check:import-cycles` and `bun run check:file-sizes`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/execution src/workflow test/unit/execution test/unit/workflow
git commit -m "feat(workflow): status.json workflow block and pre-flight placement before the first story"
```

---

### Task 13: Run end — the end-phase delegate, `skipRegression`, and `RunResult.success`

**Files:**
- Create: `src/execution/end-phase.ts`
- Modify: `src/execution/runner-completion.ts` (use `runEndPhase`; remove `resolveBranch` / `finishStorySummary`; add the `runWorkflowFeature` dep; `skipRegression`; `workflowPassed`)
- Modify: `src/execution/runner.ts` (`success` ANDs `workflowPassed !== false`)
- Test: create `test/unit/execution/end-phase.test.ts`; extend `test/unit/execution/runner-total.test.ts`; re-run the `runner-completion-*.test.ts` files unchanged

**Interfaces:**
- Consumes: `runWorkflowFeature`, `WorkflowFeatureInput`, `WorkflowFeatureResult` (Task 11), as type imports plus a dynamic import.
- Produces:
  ```ts
  // execution/end-phase.ts
  export interface EndPhaseDeps {
    runFinishPhase(ctx: FinishPhaseContext): Promise<FinishResult | null>;
    runWorkflowFeature(input: WorkflowFeatureInput): Promise<WorkflowFeatureResult | null>;
  }
  export const _endPhaseDeps: { resolveBranch(workdir: string): Promise<string> };
  export function finishStorySummary(options: RunnerCompletionOptions): { completed: number; failed: number; paused: number };
  /** undefined in pipeline mode; workflow mode: whether the feature workflow passed (P4-R13). */
  export function runEndPhase(options: RunnerCompletionOptions, deps: EndPhaseDeps): Promise<boolean | undefined>;
  // runner-completion
  RunnerCompletionResult: + workflowPassed?: boolean;
  _runnerCompletionDeps: + runWorkflowFeature(input: WorkflowFeatureInput): Promise<WorkflowFeatureResult | null>;
  ```

- [ ] **Step 1: Write the failing tests**

`test/unit/execution/end-phase.test.ts`:
```ts
import { afterEach, describe, expect, test } from "bun:test";
import { makeDispatchContext, makeNaxConfig, makePRD, makeStatusWriter } from "@test/helpers";
import type { NaxConfig } from "@/config";
import { _endPhaseDeps, type EndPhaseDeps, finishStorySummary, runEndPhase } from "@/execution/end-phase";
import type { RunnerCompletionOptions } from "@/execution/runner-completion";
import type { FinishPhaseContext } from "@/finish";
import type { LoadedHooksConfig } from "@/hooks";
import { PluginRegistry } from "@/plugins";
import type { WorkflowFeatureInput, WorkflowFeatureResult } from "@/workflow";

const original = { ..._endPhaseDeps };
afterEach(() => Object.assign(_endPhaseDeps, original));

function opts(config: NaxConfig, over: Partial<RunnerCompletionOptions> = {}): RunnerCompletionOptions {
  return {
    config,
    hooks: { hooks: {}, _skipGlobal: false } satisfies LoadedHooksConfig,
    feature: "f",
    workdir: "/repo",
    statusFile: "/repo/status.json",
    runId: "run-1",
    startedAt: new Date().toISOString(),
    startTime: Date.now(),
    formatterMode: "quiet",
    headless: false,
    prd: makePRD({ feature: "f" }),
    allStoryMetrics: [],
    totalCost: 0,
    storiesCompleted: 1,
    iterations: 1,
    statusWriter: makeStatusWriter(),
    pluginRegistry: new PluginRegistry([]),
    prdPath: "/repo/prd.json",
    ...makeDispatchContext(),
    ...over,
  };
}

function deps(result: WorkflowFeatureResult | null | Error = null) {
  const finish: FinishPhaseContext[] = [];
  const workflow: WorkflowFeatureInput[] = [];
  const d: EndPhaseDeps = {
    runFinishPhase: async (ctx) => {
      finish.push(ctx);
      return null;
    },
    runWorkflowFeature: async (input) => {
      workflow.push(input);
      if (result instanceof Error) throw result;
      return result;
    },
  };
  return { d, finish, workflow };
}

const PIPELINE = makeNaxConfig({});
const WORKFLOW = makeNaxConfig({ execution: { mode: "workflow" } });

describe("runEndPhase (P4-R16)", () => {
  test("pipeline mode: finish runs with the same context as before; workflowPassed undefined", async () => {
    _endPhaseDeps.resolveBranch = async () => "feat/x";
    const { d, finish, workflow } = deps();
    expect(await runEndPhase(opts(PIPELINE), d)).toBeUndefined();
    expect(workflow).toHaveLength(0);
    expect(finish[0]).toMatchObject({ feature: "f", workdir: "/repo", branch: "feat/x", runId: "run-1" });
    expect(finish[0]?.storySummary).toEqual(finishStorySummary(opts(PIPELINE)));
  });

  test("pipeline mode: a finish throw is swallowed (fail-open)", async () => {
    _endPhaseDeps.resolveBranch = async () => "feat/x";
    const d: EndPhaseDeps = {
      runFinishPhase: async () => {
        throw new Error("finish broke");
      },
      runWorkflowFeature: async () => null,
    };
    expect(await runEndPhase(opts(PIPELINE), d)).toBeUndefined();
  });

  test("workflow mode: runWorkflowFeature instead of finish; passed flows out", async () => {
    _endPhaseDeps.resolveBranch = async () => "feat/x";
    const { d, finish, workflow } = deps({ passed: false, outcome: "draft", reasons: ["CI failed"] });
    expect(await runEndPhase(opts(WORKFLOW), d)).toBe(false);
    expect(finish).toHaveLength(0);
    expect(workflow[0]).toMatchObject({ feature: "f", workdir: "/repo", branch: "feat/x", runId: "run-1" });
  });

  test("workflow mode: skipped (null) -> true; a throw -> false (P4-R13)", async () => {
    _endPhaseDeps.resolveBranch = async () => "feat/x";
    expect(await runEndPhase(opts(WORKFLOW), deps(null).d)).toBe(true);
    expect(await runEndPhase(opts(WORKFLOW), deps(new Error("boom")).d)).toBe(false);
  });

  test("workflow mode: an aborted run never starts the feature workflow", async () => {
    _endPhaseDeps.resolveBranch = async () => "feat/x";
    const { d, workflow } = deps({ passed: true, outcome: "ready", reasons: [] });
    await runEndPhase(opts(WORKFLOW, { exitReason: "aborted" }), d);
    expect(workflow).toHaveLength(0);
  });
});
```
If `RunnerCompletionOptions` makes some of these fields required with other types, follow `makeOpts` in `test/unit/execution/runner-completion-finish.test.ts` field for field.

Append to `test/unit/execution/runner-total.test.ts`, inside its existing `describe`, reusing the file's helpers (`makeCompletePrd`, `makeSetupResult`, `makeMinimalOptions`). Use plain async functions, not `mock(...) as typeof`, so the looseCast count doesn't grow:
```ts
  test("workflow mode: a failed feature workflow makes the run unsuccessful (P4-R13)", async () => {
    const prd = makeCompletePrd();
    _runnerDeps.runSetupPhase = async () => makeSetupResult(prd);
    _runnerDeps.runExecutionPhase = async () => ({
      prd,
      iterations: 1,
      storiesCompleted: 1,
      totalCost: 0,
      allStoryMetrics: [],
      exitReason: "completed",
    });
    _runnerDeps.runCompletionPhase = async () => ({
      durationMs: 1,
      runCompletedAt: new Date().toISOString(),
      acceptancePassed: true,
      pluginGateFailed: false,
      reportedTotal: 0,
      workflowPassed: false,
    });
    expect((await run(makeMinimalOptions())).success).toBe(false);
  });
```
If assigning a plain async function fails typecheck because of the deps' declared types (for example `runExecutionPhase` returning a wider type), copy the exact shape the file's existing tests return, and keep the casts out.

- [ ] **Step 2: Run them to verify they fail**

Run: `timeout 60 bun test test/unit/execution/end-phase.test.ts test/unit/execution/runner-total.test.ts --timeout=60000`
Expected: FAIL. `end-phase` doesn't exist, and `workflowPassed` is ignored by `runner.ts` (or is a type error).

- [ ] **Step 3: Implement**

`src/execution/end-phase.ts`. Move `finishStorySummary` (with its full doc comment) and `resolveBranch` out of `runner-completion.ts` verbatim; only `finishStorySummary` gains `export`. Then:
```ts
/**
 * The end-of-run phase (spec §5.3, P4-R16): finish in pipeline mode, the A5 feature
 * workflow in workflow mode. Both are fail-open on setup errors. Split out of
 * runner-completion.ts to keep it under the file-size limit.
 */
import { errorMessage } from "@nathapp/nax-agent/internal";
import { isWorkflowMode } from "@/config";
import type { FinishPhaseContext, FinishResult } from "@/finish";
import { getSafeLogger } from "@/logger";
import { countStories, isComplete } from "@/prd";
import { gitWithTimeout } from "@/utils/git";
import { storyPackageDir } from "@/utils/path-frame";
import type { WorkflowFeatureInput, WorkflowFeatureResult } from "@/workflow";
import type { RunnerCompletionOptions } from "./runner-completion";

export interface EndPhaseDeps {
  runFinishPhase(ctx: FinishPhaseContext): Promise<FinishResult | null>;
  runWorkflowFeature(input: WorkflowFeatureInput): Promise<WorkflowFeatureResult | null>;
}

// … finishStorySummary (moved, exported) and resolveBranch (moved) go here …

export const _endPhaseDeps = { resolveBranch };

async function runFinish(options: RunnerCompletionOptions, deps: EndPhaseDeps, branch: string): Promise<void> {
  try {
    await deps.runFinishPhase({
      runtime: options.runtime,
      config: options.config,
      feature: options.feature,
      workdir: options.workdir,
      branch,
      runId: options.runId,
      agentName: options.agentManager.getDefault(),
      abortSignal: options.abortSignal,
      storySummary: finishStorySummary(options),
      statusWriter: options.statusWriter,
      interactionChain: options.interactionChain,
      packageDirs: options.prd.userStories.map(storyPackageDir),
    });
  } catch (err) {
    getSafeLogger()?.warn("finish", "Finish phase failed; the run is unaffected", {
      storyId: "_run",
      error: errorMessage(err),
    });
  }
}

async function runWorkflowEnd(options: RunnerCompletionOptions, deps: EndPhaseDeps, branch: string): Promise<boolean> {
  if (options.exitReason === "aborted" || options.abortSignal?.aborted) {
    getSafeLogger()?.info("workflow", "Feature workflow skipped — the run was aborted", { storyId: "_run" });
    return true;
  }
  try {
    const result = await deps.runWorkflowFeature({
      runtime: options.runtime,
      config: options.config,
      prd: options.prd,
      feature: options.feature,
      workdir: options.workdir,
      branch,
      runId: options.runId,
      agentName: options.agentManager.getDefault(),
      abortSignal: options.abortSignal,
      interactionChain: options.interactionChain,
      statusWriter: options.statusWriter,
    });
    return result?.passed ?? true;
  } catch (err) {
    getSafeLogger()?.warn("workflow", "Feature workflow failed — run marked unsuccessful", {
      storyId: "_run",
      error: errorMessage(err),
    });
    return false;
  }
}

export async function runEndPhase(options: RunnerCompletionOptions, deps: EndPhaseDeps): Promise<boolean | undefined> {
  const branch = await _endPhaseDeps.resolveBranch(options.workdir);
  if (isWorkflowMode(options.config)) return runWorkflowEnd(options, deps, branch);
  await runFinish(options, deps, branch);
  return undefined;
}
```
The pipeline-mode finish context is built exactly as `runner-completion.ts` built it before, field for field.

`src/execution/runner-completion.ts`:
- Delete `finishStorySummary` and `resolveBranch` (now in `end-phase.ts`), and the `countStories` / `gitWithTimeout` / `storyPackageDir` imports if nothing else uses them.
- Add `import { runEndPhase } from "./end-phase";`, and `isWorkflowMode` to the `@/config` import. Also add `import type { WorkflowFeatureInput, WorkflowFeatureResult } from "@/workflow";`.
- Add to `RunnerCompletionResult`:
```ts
  /** A5: false when the feature workflow did not pass (spec §7 "Run result"); absent in pipeline mode. */
  workflowPassed?: boolean;
```
- Add to the `_runnerCompletionDeps` type and value (dynamic import, same pattern as `runFinishPhase`):
```ts
  runWorkflowFeature(input: WorkflowFeatureInput): Promise<WorkflowFeatureResult | null>;
```
```ts
  async runWorkflowFeature(input) {
    const { runWorkflowFeature } = await import("@/workflow");
    return runWorkflowFeature(input);
  },
```
- In the `handleRunCompletion` call: `skipRegression: regressionAlreadyPassed || isWorkflowMode(options.config),`, with a one-line comment above it: `// A5: the feature workflow's gates subsume the deferred regression gate (spec §5.3).`
- Replace the whole `try { await _runnerCompletionDeps.runFinishPhase({ … }) } catch { … }` block (keep its comment) with:
```ts
  const workflowPassed = await runEndPhase(options, _runnerCompletionDeps);
```
- Return `...(workflowPassed !== undefined ? { workflowPassed } : {}),` in the result object.

After the edit, `wc -l src/execution/runner-completion.ts` must be ≤ 600.

`src/execution/runner.ts`: change the success expression to
```ts
      success: isComplete(prd) && acceptancePassed && !pluginGateFailed && completionResult.workflowPassed !== false,
```
If `completionResult` is destructured, add `workflowPassed` to the destructure and use `workflowPassed !== false`.

- [ ] **Step 4: Run them to verify they pass**

Run the Step 2 command, then `timeout 300 bun test test/unit/execution --timeout=60000`. Every `runner-completion-*.test.ts` must pass unchanged; they observe `runFinishPhase` through `_runnerCompletionDeps`, which `runEndPhase` receives. Then run `bun run check:file-sizes`, `bun run check:import-cycles` and `bun run check:complexity`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/execution test/unit/execution
git commit -m "feat(workflow): end-phase delegate runs the feature workflow; run success includes it"
```

---

### Task 14: Feature workflow end to end, spec rulings, changelog

**Files:**
- Create: `test/integration/workflow/feature-e2e.test.ts`
- Modify: `docs/superpowers/specs/2026-10-12-a5-workflow-mode-design.md` (append §17), `packages/nax/CHANGELOG.md` (Unreleased → Added)

**Interfaces:**
- Consumes: `runWorkflowFeature` (Task 11) and every seam it reaches:
  - `_featureContextDeps.buildRunDispatchAskWiring`;
  - `_featureDeps` (forge, gates, push);
  - `_ciWaitDeps`;
  - `_workflowDeps.callOp` / `createAdvisor` / `readTrustedDecisions`.

- [ ] **Step 1: Write the integration test**

`test/integration/workflow/feature-e2e.test.ts`:
```ts
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  cleanupTempDir,
  makeAdviceDecision,
  makeNaxConfig,
  makeScriptedCallOp,
  makeTempDir,
  makeTestPRD,
  makeTestRuntime,
  makeTestStory,
} from "@test/helpers";
import type { Advisor } from "@/advisor";
import type { ForgeRunResult } from "@/forge";
import { workflowBranchFixOp, workflowBranchReviewOp, workflowReReviewOp } from "@/operations";
import type { NaxRuntime } from "@/runtime";
import { _ciWaitDeps } from "@/workflow/ci-wait";
import { runWorkflowFeature } from "@/workflow/feature";
import { _featureContextDeps } from "@/workflow/feature-context";
import { _featureDeps } from "@/workflow/feature-deps";
import { newStoryRecord, readResult, upsertStoryRecord } from "@/workflow/result";
import { _workflowDeps } from "@/workflow/step-context";

const saved = {
  wf: { ..._workflowDeps },
  feature: { ..._featureDeps },
  ctx: { ..._featureContextDeps },
  ci: { ..._ciWaitDeps },
};
const dirs: string[] = [];
const runtimes: NaxRuntime[] = [];
afterEach(async () => {
  Object.assign(_workflowDeps, saved.wf);
  Object.assign(_featureDeps, saved.feature);
  Object.assign(_featureContextDeps, saved.ctx);
  Object.assign(_ciWaitDeps, saved.ci);
  await Promise.allSettled(runtimes.map((r) => r.close()));
  runtimes.length = 0;
  await Promise.all(dirs.map(cleanupTempDir));
  dirs.length = 0;
});

async function sh(cwd: string, ...args: string[]): Promise<void> {
  const p = Bun.spawn(args, { cwd, stdout: "ignore", stderr: "pipe" });
  const [code, stderr] = await Promise.all([p.exited, new Response(p.stderr).text()]);
  if (code !== 0) throw new Error(`command failed (${code}): ${args.join(" ")}\n${stderr}`);
}

async function setup() {
  const repo = makeTempDir("wf-fe2e-repo-");
  const out = makeTempDir("wf-fe2e-out-");
  dirs.push(repo, out);
  await sh(repo, "git", "init", "-q", "-b", "main");
  await sh(repo, "git", "config", "user.email", "t@t");
  await sh(repo, "git", "config", "user.name", "t");
  await Bun.write(join(repo, "a.ts"), "export const a = 1;\n");
  await sh(repo, "git", "add", ".");
  await sh(repo, "git", "commit", "-qm", "seed");
  await sh(repo, "git", "checkout", "-qb", "feat/x");
  await Bun.write(join(repo, "b.ts"), "export const b = 2;\n");
  await sh(repo, "git", "add", ".");
  await sh(repo, "git", "commit", "-qm", "feat: story work");

  const config = makeNaxConfig({ execution: { mode: "workflow" }, outputDir: out });
  const runtime = makeTestRuntime({ config, workdir: repo });
  runtimes.push(runtime);
  const prd = makeTestPRD([makeTestStory({ id: "US-001", status: "passed", passes: true })]);
  // A prior story run left a closed record and one deferred minor.
  const storyRun = join(out, "workflow", prd.feature, "run-stories");
  await upsertStoryRecord(storyRun, { runId: "run-stories", feature: prd.feature }, {
    ...newStoryRecord("US-001", 5, "t"),
    state: "complete",
    reason: "clean",
    phase: "closed",
    round: 1,
  });
  await Bun.write(join(storyRun, "ledger.md"), "# ledger\nUS-001: deferred-minor: rename tmp var\n");

  _featureContextDeps.buildRunDispatchAskWiring = async () => ({
    askResolver: async () => ({ approved: false }),
    dispose: async () => {},
  });
  const gh: string[][] = [];
  _featureDeps.detectForge = async () => "github";
  _featureDeps.commitAndPush = async () => ({ committed: false, pushed: true });
  _featureDeps.resolveGateCommands = async () => [];
  _featureDeps.runQualityGates = async () => ({ passed: true, ran: ["test"], failing: [], output: "[test] exit=0" });
  _featureDeps.forge = {
    readText: async () => null,
    run: async (cmd): Promise<ForgeRunResult> => {
      gh.push(cmd);
      const sub = `${cmd[1]} ${cmd[2]}`;
      if (sub === "pr list") return { exitCode: 0, stdout: "[]", stderr: "" };
      if (sub === "pr create") return { exitCode: 0, stdout: "https://github.com/o/r/pull/9\n", stderr: "" };
      if (sub === "pr view") return { exitCode: 0, stdout: '{"isDraft":true,"url":"https://github.com/o/r/pull/9"}', stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  let clock = 0;
  _ciWaitDeps.now = () => clock;
  _ciWaitDeps.sleep = async (ms) => {
    clock += ms;
  };
  _ciWaitDeps.run = async () => ({ exitCode: 1, stdout: "", stderr: "no checks reported on the 'feat/x' branch" });

  const approver: Advisor = {
    advise: async () => ({ decision: makeAdviceDecision({ action: { type: "approve" }, rationale: "clean" }) }),
    recordReuse: async () => null,
    adviseBatch: async () => ({ kind: "residual", items: [], diagnoses: {} }),
  };
  _workflowDeps.createAdvisor = () => approver;
  _workflowDeps.readTrustedDecisions = async () => [];
  const ops: string[] = [];
  _workflowDeps.callOp = makeScriptedCallOp(async (op) => {
    ops.push(op.name);
    if (op.name === workflowBranchReviewOp.name) {
      return {
        spec: "pass",
        quality: "changes",
        findings: [{ kind: "quality", severity: "important", issue: "b.ts never exported from the barrel" }],
        cannotVerify: [],
        minorTriage: [{ id: "M1", decision: "fix-now" }],
      };
    }
    if (op.name === workflowBranchFixOp.name) {
      await Bun.write(join(repo, "index.ts"), 'export * from "./b";\n');
      await sh(repo, "git", "add", ".");
      await sh(repo, "git", "commit", "-qm", "fix: export b");
      return { status: "DONE", commits: [], testSummary: "1 pass", interrupted: false };
    }
    if (op.name === workflowReReviewOp.name) {
      return {
        verdicts: [
          { id: "B1", addressed: true, note: "" },
          { id: "M1", addressed: true, note: "" },
        ],
        newFindings: [],
      };
    }
    throw new Error(`unexpected op ${op.name}`);
  });
  const input = {
    runtime,
    config,
    prd,
    feature: prd.feature,
    workdir: repo,
    branch: "feat/x",
    runId: runtime.runId,
    agentName: "claude",
  };
  return { repo, out, input, gh, ops, runDir: join(out, "workflow", prd.feature, runtime.runId) };
}

describe("workflow feature end to end", () => {
  test("review -> one fix -> re-review -> gates -> push -> draft PR -> CI timeout (pending) -> approved -> ready", async () => {
    const { input, gh, ops, runDir } = await setup();
    const result = await runWorkflowFeature(input);
    expect(result).toEqual({ passed: true, outcome: "ready", url: "https://github.com/o/r/pull/9", reasons: [] });
    expect(ops).toEqual([workflowBranchReviewOp.name, workflowBranchFixOp.name, workflowReReviewOp.name]);
    expect(gh.some((c) => c.join(" ").startsWith("gh pr create") && c.includes("--draft"))).toBe(true);
    expect(gh.some((c) => c.join(" ").startsWith("gh pr ready"))).toBe(true);
    const record = (await readResult(runDir))?.featureWorkflow;
    expect(record).toMatchObject({ step: "done", outcome: "ready", ci: "pending", reviewRan: true, fixRan: true });
    expect(record?.minors).toEqual([{ id: "M1", storyId: "US-001", text: "rename tmp var", triage: "fix-now" }]);
    for (const f of ["branch-review.json", "branch-rereview.json", "feature-report.md", "package-branch.diff"]) {
      expect(await Bun.file(join(runDir, f)).exists()).toBe(true);
    }
    expect(await Bun.file(join(runDir, "ledger.md")).text()).toContain("_run: feature ready https://github.com/o/r/pull/9");
  });

  test("a second run at the same HEAD is already finished: no review, no forge calls", async () => {
    const first = await setup();
    await runWorkflowFeature(first.input);
    const ghBefore = first.gh.length;
    const opsBefore = first.ops.length;
    const again = await runWorkflowFeature({ ...first.input, runId: "run-again" });
    expect(again?.outcome).toBe("already-finished");
    expect(first.gh.length).toBe(ghBefore);
    expect(first.ops.length).toBe(opsBefore);
  });
});
```
The fakes must match their real types. Before running, read:
- `DispatchAskWiring` (`src/interaction/dispatch-ask.ts`);
- `SyncOutcome` (`src/finish/commit.ts`);
- `QualityGateResult` (`src/finish/types.ts`).

Fill any required field each fake lacks. The `pr create` reply must carry the URL on stdout, as `gh` prints it. If `makeTestRuntime` names its output dir differently from `config.outputDir`, derive `runDir` from `runtime.outputDir`, as `test/integration/workflow/story-e2e.test.ts` does.

- [ ] **Step 2: Run it**

Run: `timeout 120 bun test test/integration/workflow/feature-e2e.test.ts --timeout=60000`
Expected: PASS. If it fails, the failure is a wiring defect in Tasks 5-11, not in this test. Fix it at its source, and add a unit test in the owning task's test file that pins it.

- [ ] **Step 3: Spec §17 and changelog**

Append to `docs/superpowers/specs/2026-10-12-a5-workflow-mode-design.md`:
```markdown

## 17. PR4 plan rulings (2026-10-12)

| # | Ruling | Why |
|---|---|---|
| P4-R1 | The feature workflow's state is a `WorkflowFeatureRecord` under `featureWorkflow` in the current run's `result.json`, rewritten after every step; an unfinished prior record is resumed at its step; a `done` record at the current HEAD skips the workflow | §10 resume; a re-run must not open a second review or rewrite the PR |
| P4-R2 | Story states for the feature workflow come from every run's `result.json` (newest wins per story); passed-without-record = `complete`; otherwise `not-run` | Resumed and re-run features span run dirs |
| P4-R3 | Draft first: push, draft PR, CI wait on it, approval, then promote or keep the draft | `gh pr checks` / `glab mr view` need a PR; finish's D7 order |
| P4-R4 | CI wait polls through "no checks yet" and running checks until `ciWaitMs` (→ `pending`); a CLI error or unparseable output is `pending` at once | Checks register after the push; W-R9 |
| P4-R5 | Gates again = `runQualityGates` again (its `test` gate is the full suite), only when the branch fix ran; no configured commands = "nothing verified" (draft reason, not red) | `fullSuiteGateOp` is story-scoped |
| P4-R6 | Ready also requires that the branch review ran | Unreviewed cross-story code must not go ready |
| P4-R7 | The fix gets review findings, fix-now minors, red repo gates and gate-open stories; the re-review judges review findings and fix-now minors; gates judge gates; adjudication covers review findings still open; unaddressed fix-now minors become `leave` | Mirrors the story loop |
| P4-R8 | An untriaged minor is `leave` | Fail-safe |
| P4-R9 | The feature-scoped advisor has no heads-up channel in PR4; flagged rulings keep the PR a draft and are listed in the body | No `PipelineContext` at feature level |
| P4-R10 | The advisor is asked to approve only when every deterministic condition holds; menu approve/hold; failure = draft | §7.8, §8 default |
| P4-R11 | Dry run / abort skip the feature workflow; a non-feature branch, no forge, or a failed push end `local-only` | Finish's push rules |
| P4-R12 | The `status.json` `workflow` block is set at each feature step and persisted by the post-finish status write; one `Workflow complete` log line is the exit summary | Heartbeat is stopped before finish |
| P4-R13 | `RunnerCompletionResult.workflowPassed` (optional) ANDs into `RunResult.success`; a feature-workflow throw is `false` | §7 run result |
| P4-R14 | Pre-flight runs in `executeUnified` before the loop, fail-open, over stories not yet passed; a reusable prior `preflight.json` is adopted first | No duplicate pre-flight decisions on resume |
| P4-R15 | Seed = merge-base(origin default) → merge-base(main) → first persisted `storyGitRef`; none → branch review skipped | §7.2 plus a repo without `main` |
| P4-R16 | Finish / workflow delegation lives in `execution/end-phase.ts` | `runner-completion.ts` file-size limit |
| P4-R17 | Prompt-/tool-audit rows for the new roles are checked in the live smoke | Needs a real session |
| P4-R18 | Branch adjudication is PR3's residual batch with no `storyId` (`_run`), no carry, no gate diagnoses | Branch findings are not story-scoped |
| P4-R19 | PR3 carry-overs M2, M5, M6 | Deferred by the PR3 final review |
| P4-R20 | The branch fix reuses the implementer reply contract and parser; one shared `softInterruptTurn` | One write-turn contract |
| P4-R21 | `workflowConfigSelector` gains `finish` for the branch model fallbacks | §4 fallbacks |
```

In `packages/nax/CHANGELOG.md`, under `## Unreleased` → `### Added`, prepend:
```markdown
- **Workflow mode feature workflow (A5 PR4).** With `execution.mode: "workflow"`, the advisor pre-flight
  runs once before the first story, and after the last story one feature workflow runs: repo gates, one
  whole-branch review (cross-story integration, reachability, consistency, triage of every deferred minor),
  exactly one branch fix, one scoped re-review, an advisor ruling on whatever is still open, gates again,
  then push, a draft PR, a CI wait (a timeout is `pending`, never `failed`), advisor approval, and the PR
  promoted to ready only when every gate is green, CI did not fail, no story is gate-open or not run, no
  ruling is flagged and the branch review ran. nax never merges. The run's success includes the feature
  workflow; `status.json` gains a `workflow` block; `result.json` gains the resumable feature record and
  per-role token totals. Finish and the deferred regression gate do not run in workflow mode.
```

- [ ] **Step 4: Full gate**

Run, from `packages/nax`:
- `bun run typecheck`
- `bun run check:all`
- `bun run test`
- `bun run test:coverage`

Then from the repo root: `bun run check:all`.
Expected: all green. Fix any failure at its source; never `--update-baseline`. Every new `src/workflow/*.ts` file needs ≥ 80% line coverage from its own test (`coverage-per-file-baseline`).

- [ ] **Step 5: Commit**

```bash
git add test/integration/workflow/feature-e2e.test.ts ../../docs/superpowers/specs/2026-10-12-a5-workflow-mode-design.md CHANGELOG.md
git commit -m "test(workflow): feature workflow end to end; docs: PR4 rulings and changelog"
```
