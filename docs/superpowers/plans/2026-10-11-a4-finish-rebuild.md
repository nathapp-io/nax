# A4 Finish Rebuild Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild nax's post-run finish phase so it reviews the whole branch with two JSON review ops, fixes in one shared loop, never escalates, and always ends with a ready or draft PR.

**Architecture:** Two read-only review ops (`finishSpecReviewOp`, `finishBranchReviewOp`) built on the per-story JSON review stack run in parallel; their findings are merged, judged by the A1 advisor, and fixed in one loop. A pure resolver turns the end-of-run facts into `ready | draft`, and the machine finalizes the PR accordingly. The markdown reply contract, evidence gating, the narrative op and every escalation exit are deleted.

**Tech Stack:** Bun 1.4, TypeScript strict, bun:test, Biome, zod. Package `packages/nax`.

**Spec:** `docs/superpowers/specs/2026-10-11-a4-finish-rebuild-design.md` (rev 2). Read it before any task; section numbers below (§n) refer to it.

## Global Constraints

- All paths are relative to `packages/nax/` unless they start with `docs/` or the repo root.
- Bun-native APIs only; `NaxError` for thrown errors; project logger, never `console.*` in `src/`.
- Prompt text lives only in `src/prompts/builders/`, exported through `src/prompts/index.ts`.
- LLM JSON parsing goes through `tryParseLLMJson` (`src/utils/llm-json.ts`).
- Source files ≤ 600 lines, test files ≤ 800 lines; functions ≤ 30 lines where practical (complexity ratchet).
- No `as unknown as`, no `@ts-` suppressions, no new single `as T` casts in tests (`check:test-escape-hatches` looseCast ratchet). Use `assertDefined()` for non-null narrowing in tests.
- Test command while iterating: `timeout 30 bun test <path> --timeout=5000`. Never bare `bun test`, never `bun run nax`.
- Pre-push gate for each PR: from the repo root `bun run check:all` and `bun run typecheck`, and from `packages/nax` `bun run test`. All green.
- Review caps: `MAX_FIX_ATTEMPTS = 3` (acceptance fix, gate fix), review rounds = 3 per finish (`MAX_REVIEW_ROUNDS = 3`), `MAX_ADVISE_ROUNDS = 2`, `re-review` at most once per finish.
- Severity enum stays `"CRITICAL" | "HIGH" | "MEDIUM" | "LOW"`; `Finding.problem` keeps its name.
- Session roles stay `finish-review-spec` / `finish-review-quality` / `finish-fix`; `finish-narrative` is removed.
- `NARRATIVE_MAX_CHARS = 4000`, title ≤ 72 chars via `pr-title.ts` sanitiser, fallback title `feat: <feature>`.
- nax is a public repo: no private project names in code, tests, fixtures or PR text.
- Billed runs (Task 17) need maintainer approval at launch time.

## Review Focus

1. **A lens that returns non-JSON prose twice** — expected: that lens is `missing` for the round, the other lens's findings still get fixed, and the PR is draft with "spec review missing". Pinned in Task 4 (op exhausted fallback) and Task 13 (machine draft path).
2. **The same issue raised by both lenses with different wording but the same file and line** — expected: flagged as a contradiction once, one advisor question, never two conflicting fixes. Pinned in Task 5 and A-10 (Task 11).
3. **The forge CLI missing or unauthenticated at finalize** — expected: status `failed` with the CLI error as reason, notify fires, ledger not written. Pinned in Task 12.
4. **`flowMs` deadline firing in the middle of a fix session** — expected: no further LLM calls, a draft PR is still finalized with reason `deadline` using a fresh signal. Pinned in Task 13.
5. **A gate fix that commits production code after the third review round** — expected: the commit is listed under "Unreviewed fix commits" and the PR is draft, not ready. Pinned in Task 13.

---

## Amendments from the final plan review (2026-10-11) — AUTHORITATIVE

Where a task's text below disagrees with this section, **this section wins**. Each task's implementer must read the amendments tagged with its task number.

### A-1 Ordering and the `src/finish/index.ts` barrel (Tasks 8-15)

Bun fails at link time when a barrel re-exports a name that no longer exists, so removing a runtime export early breaks every test that imports `@/finish`.

- **Tasks 8-12 are additive at runtime.** They add new functions, types and methods alongside the old ones. They never delete a runtime export or a `src/finish/index.ts` / `src/operations/index.ts` entry. Type-only removals (fields on interfaces) are allowed because Bun strips types.
- Concretely:
  - **Task 11** adds `judgedMerged(findings, contradictions, state)` and `approvalFromFacts(facts, approval)` as new methods on `FinishAdvisor`, plus `judgeWithoutAdvisor`. The old `judged` / `approval` / `applyJudgedAdvice` / `runApproval` stay until Task 13. Everywhere later tasks say `advise.judged(...)` or `advise.approval(...)` with the new signatures, read `judgedMerged` / `approvalFromFacts`.
  - **Task 12** adds `reviewSpec` / `reviewBranch` / `finalizeDraftPr` to `FinishOps` and `ops-impl` alongside `review` / `narrate` / `escalate`. `parseTitle` and the `TITLE_*` constants stay until Task 15.
  - **Task 13** (the machine rewrite) deletes the old advisor and ops methods, `routeReview`, `MAX_INCOMPLETE_ATTEMPTS`, `applyJudgedAdvice`, `runApproval`, **and their `index.ts` entries, in the same commit**.
  - **Task 14** removes the escalate and notify exports and their index entries.
  - **Task 15** removes everything else.
- **Expected red, between Task 8 and Task 13:** `bun run typecheck`, and `test/unit/finish/machine-*.test.ts`, `route*.test.ts`, `review-window.test.ts` (the old machine runs on the old state fields). Every other test, including each task's own new tests, must be green at that task's commit.
- **Nothing is pushed before Task 16.** PR 2 is pushed only when the whole stack is green.

### A-2 PRD stories and `prdPath` (Task 13)

`loadFinishContext` does not read the PRD; only `pr/context.ts` does, via `featureDir(workdir, feature)/prd.json` and `storiesFrom`. Do not add fields to `FinishContext`. Instead, in `src/finish/review-inputs.ts` (new; `loadReviewInputs` moves here out of `machine.ts`):

```ts
export const _reviewInputsDeps = {
  readText: (path: string): Promise<string | null> => Bun.file(path).text().catch(() => null),
};

export async function loadReviewInputs(state: FinishState, outputDir: string | undefined): Promise<ReviewInputs> {
  const prdAbs = join(featureDir(state.workdir, state.feature), "prd.json");
  const [changed, hints, prdText] = await Promise.all([
    changedFiles(state.workdir, state.base),
    outputDir ? readA3Hints(outputDir, state.feature) : Promise.resolve([]),
    _reviewInputsDeps.readText(prdAbs),
  ]);
  return { changed, hints, stories: storiesFromText(prdText), prdPath: relative(state.workdir, prdAbs) };
}
```

`storiesFromText(text)` parses JSON fail-open (returns `[]` on null or invalid input) and maps `userStories` to `{ id, title }`. If `pr/context.ts`'s `storiesFrom` can take the parsed object, export it from `pr/` and reuse it, dropping `acCount`. Test both: a valid PRD, and a missing PRD giving `[]`.

### A-3 Second ledger set and status-file types (Task 14)

- `src/finish/context.ts:90` has its own `LEDGER_TERMINAL_STATUSES`, which `checkLedger` reads. Make both sets identical by moving the set to `audit.ts` as an exported `LEDGER_TERMINAL_STATUSES` and importing it in `context.ts`. Members: `opened`, `promoted`, `already-ready`, `draft`, `local-only`, `nothing-to-finish`, plus `escalated` (so old ledgers still skip). Add a test that a ledgered `draft` at the same HEAD routes `already-finished`.
- `src/execution/status-file.ts:42-55` `FinishPhaseStatus` changes:
  - `status: PostRunPhaseStatus | "draft"`
  - `result?` takes the new `FinishResult["status"]` union (import the type)
  - add `outcome?: "ready" | "draft" | "failed"` and `reason?: string`
  - keep `escalationReason?`, marked "pre-A4 only, never written"

  Do **not** change the shared `PostRunPhaseStatus`.

### A-4 Fail-closed fact defaults (Task 13)

- In `resolveAndFinalize` and `recoverAfterThrow`, the defaults are `state.acceptanceFact ?? "unverified"` and `state.gateFacts ?? [{ name: "gates", status: "red", excerpt: "not run" }]`.
- `runAcceptanceLoop` sets `state.acceptanceFact = "not-configured"` explicitly in its `acceptanceStatus === "disabled"` early return.
- A lens is missing if `state.review.rounds === 0`: set `missingLenses = ["spec", "quality"]` before resolution in that case.
- Skip gate zero (the acceptance re-run inside the gates loop) when `state.acceptanceFact` is already `red` or `unverified`, so a red acceptance does not burn three more gate-fix attempts.

### A-5 Review-loop cap, unreviewed commits, acceptance re-check (Task 13)

- **Unreviewed commits.** `state.unreviewedFixCommits` collects the SHA of every fix commit not yet seen by a full review round: acceptance re-check fixes, gate fixes, and a review fix made in the last allowed round.
  - When a review round completes with **no missing lens**, set `state.unreviewedFixCommits = []` **before** that round's own fix commit. The round saw everything committed before it.
  - Then, if that round's fix commit is the last round allowed, push its SHA.
- **Findings at the cap.** At the cap, clear `lastFindings` **only when `commit.committed`**. A no-op fix (all findings rejected, or no diff) keeps them open, so resolution sees them.
- **`reviewedHead`.** Delete the field. It is never read.

Replace the Task 13 cap text with the rules above. Add these `review-loop.test.ts` cases (full bodies under A-10):
- a cap-round no-op fix keeps findings open
- a clean round after a gate-fix SHA clears `unreviewedFixCommits`

### A-6 Throws and finalize (Task 13)

`recoverAfterThrow(state, deps, err)`:

1. `deps.runSignal?.aborted` → `failed` (`reason: "aborted"`). No forge call.
2. `state.finalizing === true` means the throw came from `promotePr` / `finalizeDraftPr` → `failed` with that error. Add `finalizing?: boolean` to `FinishState` in Task 8. It is set immediately before the forge call.
3. Otherwise (a deadline or any other throw), compute facts so far with the A-4 defaults, then `resolve` **without the advisor**, which always gives draft. Prefix the reason with `deadline` when `deps.signal?.aborted`, else `finish error: <message>`. Set `state.resolution`, then `finalizeDraftPr` (with `state.finalizing = true`). If that throws → `failed`.

`resolve()` wraps the advisor call:

```ts
let decision: { action: ApprovalAction; rationale: string };
try {
  decision = await args.advise.approval(facts, approvalFacts(facts, args.reReviewUsed));
} catch (err) {
  decision = { action: "unavailable", rationale: `advisor error: ${String(err)}` };
}
```

Add this to Task 10's tests: an advisor that throws gives `draft` with `"advisor: advisor error: …"`.

### A-7 Narrative deprecation and notify default (Task 14)

- After parsing, both narrative keys are always present, so check `deprecatedNarrative = finish.narrative === false || finish.reviewers.narrative != null`.
- In `src/config/schemas.ts`, change the notify default in **both** places: the inner `.default("escalation")` and the outer finish object's `notify: { mode: "escalation" }`. Both become `"draft"`.
- Remove `preferTelegram` from `FinishOpsDeps` and `phase.ts`. It only steered PR escalation comments, which no longer exist.

### A-8 Missing tests from spec §11 (Tasks 4, 12, 14)

- **Task 4, retry → missing.** For each op, add a test that drives `op.retry` to exhaustion and asserts `exhaustedFallback` returns `MISSING_REVIEW`. Model it on the `RetryStrategy` / `ParseValidationError` cases in `test/unit/operations/finish-review.test.ts`, before Task 15 deletes that file. Copy the harness shape, not the assertions.
- **Task 12, concurrency.** In `ops-impl.test.ts`, stub `_finishOpsDeps.callOp` with a gate (as in Task 6's test). Call `Promise.all([ops.reviewSpec(s, i), ops.reviewBranch(s, i)])` and assert both calls started before either resolved, with `sessionOverride.role` values `finish-review-spec` and `finish-review-quality`. Per-role cost attribution comes from `callOp` + `sessionOverride.role`, which existing `callOp` tests cover. That is an accepted reduction from spec §4.5's fake-agent wording.
- **Task 14, run summary.** `phase.ts` logs one info line `PR <url> opened (<outcome>): <reason or "clean">` (or `local-only` / `failed: <reason>`), with `storyId: "_run"` first. Test it with the logger sink pattern `nbf-worth-check.test.ts` uses (`addSink` / `initLogger`).

### A-9 Smaller fixes

- **Task 8:** `FinishRoundOutcome` keeps every existing member, `escalated` and `incomplete` included, as read-only history, and adds `"missing"`. `FinishState` gains these, all defined in Task 8, not Task 12:
  - `resolution?: { outcome: "ready" | "draft"; reason?: string; facts: ResolutionFacts; acceptedResidue: Finding[] }`
  - `reason?: string`
  - `finalizing?: boolean`
- **Task 8, outcome union:** `FinishResult.outcome` is `"ready" | "draft" | "failed"`. No forge is a **status** (`local-only`), not an outcome. A clean run with no forge has `status: "local-only"`, `outcome: "ready"`, and passes. This narrows spec §7.2's outcome union; the behaviour is as the spec intends.
- **Task 12:** the PR context reads `state.resolution`. `LoadPrContextArgs` gets no new field. For the `--draft` create path, call `openPr(forge, { title, body, branch, draft: true }, deps, workdir)` from `src/forge/pr.ts:76-90`, not hand-built argv. `updatePrBody` swallows failures by design, so a failed body update on an existing draft still reports `draft`. Document that at the call site.
- **Task 13, also touched:**
  - `src/finish/commit.ts:176`: add `"review"` to `REVIEWED_PHASES`.
  - `src/finish/commit-message.ts`: make `phaseLabel` / `reviewSubject` render `review` as "branch review", not "review review", and add a test.
  - `src/finish/pr/body.ts`: add a `missing` entry to `EMPTY_ROUND_NOTE` (`"- _no verdict from this review_"`).
- **Task 13, gate fixes:** a `tests-only` gate fix is treated like `changed`: one more review round if any remain, otherwise its SHA goes to `unreviewedFixCommits`.
- **Task 14:**
  - Add `status?: string` to `RecordedResult` in `advisor-import.ts`.
  - Put the new phase cases in `test/unit/finish/phase-a4.test.ts`, because `phase.test.ts` is already 734 lines.
- **Task 15:** `call-root-collapse.test.ts` only mentions the role string. Update or keep it according to the Step 1 grep.

### A-10 Shared test fixture and written-out tests

**Shared fixture (create in Task 11).** `baseContext` / `baseState` / `makeOps` are file-local today and must not be copy-pasted (`test-helpers.md`). Create `test/helpers/finish-machine.ts` and export it from `test/helpers/index.ts`:

```ts
import type { AcceptanceGroupResult } from "@/cli";
import type { FinishContext, FinishOps, FinishReviewOutput, FinishState } from "@/finish";
import { createFinishState } from "@/finish";

export function makeFinishContext(overrides: Partial<FinishContext> = {}): FinishContext {
  const group: AcceptanceGroupResult = { packageDir: "", testPath: "test/acceptance/feat.test.ts", exists: true, cwd: "" };
  return {
    base: "origin/main",
    specPath: ".nax/features/feat/spec.md",
    acceptanceStatus: "ok",
    groups: [group],
    testFileRegex: ["\\.test\\.ts$"],
    commitsAhead: 3,
    route: "proceed",
    ...overrides,
  };
}

export function makeFinishState(overrides: Partial<FinishState> = {}): FinishState {
  const state = createFinishState({
    feature: "feat",
    workdir: "/repo",
    branch: "feat/x",
    runId: "run-1",
    base: "origin/main",
    specPath: ".nax/features/feat/spec.md",
  });
  return { ...state, ...overrides };
}

export const CLEAN_REVIEW: FinishReviewOutput = { findings: [], covered: [] };

/** Scripted A4 ops: each review call shifts the next scripted output (default clean). Records a call trail. */
export function makeFinishOps(
  trail: string[],
  script: { spec?: FinishReviewOutput[]; quality?: FinishReviewOutput[] } = {},
  overrides: Partial<FinishOps> = {},
): FinishOps {
  const spec = [...(script.spec ?? [])];
  const quality = [...(script.quality ?? [])];
  return {
    reviewSpec: async () => {
      trail.push("review:spec");
      return spec.shift() ?? CLEAN_REVIEW;
    },
    reviewBranch: async () => {
      trail.push("review:quality");
      return quality.shift() ?? CLEAN_REVIEW;
    },
    fix: async (phase) => {
      trail.push(`fix:${phase}`);
      return {};
    },
    openDraftPr: async () => {
      trail.push("openDraftPr");
      return { url: "https://x/pr/1" };
    },
    promotePr: async () => {
      trail.push("promotePr");
      return { status: "promoted", url: "https://x/pr/1" };
    },
    finalizeDraftPr: async () => {
      trail.push("finalizeDraftPr");
      return { status: "draft", url: "https://x/pr/1" };
    },
    ...overrides,
  };
}
```

Until Task 13 deletes them, `FinishOps` still has the old `review` / `narrate` / `escalate` members (A-1). In Tasks 11-12, `makeFinishOps` adds throwing stubs for them (`review: async () => { throw new Error("old review path called"); }`, and likewise for the others), and Task 13 removes those stubs. The old machine tests keep their own file-local helpers until Task 13 rewrites them onto this fixture.

The `git` stub for review-loop and machine tests uses the existing `_finishGitDeps.git` seam:

```ts
// in each test file
const originalGit = _finishGitDeps.git;
afterEach(() => {
  _finishGitDeps.git = originalGit;
});
/** HEAD advances on every commit; status is dirty after any fix call. */
function stubGit(state: { dirty: boolean; head: number }) {
  _finishGitDeps.git = async (args) => {
    if (args[0] === "rev-parse") return { exitCode: 0, stdout: `sha${state.head}\n`, stderr: "" };
    if (args[0] === "status") return { exitCode: 0, stdout: state.dirty ? " M a.ts\n" : "", stderr: "" };
    if (args[0] === "commit") {
      state.head += 1;
      state.dirty = false;
    }
    if (args[0] === "diff" && args.includes("--cached")) return { exitCode: state.dirty ? 1 : 0, stdout: "", stderr: "" };
    return { exitCode: 0, stdout: "", stderr: "" };
  };
}
```

Before relying on it, check `commitFixes` in `src/finish/commit.ts` (`gitlinkSafeAdd`, `hasStagedChanges`) for the exact git calls it makes, and adjust the stub so that a dirty tree commits and a clean tree does not. The fixer stub sets `git.dirty = true` to simulate an edit.

**Task 13, `review-loop.test.ts` (the risky cases, in full):**

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { makeFinishOps, makeFinishState, withTempDir } from "@test/helpers";
import { _finishGitDeps, MAX_REVIEW_ROUNDS, runReviewLoop } from "@/finish";
import type { Finding, FinishReviewOutput, ReviewInputs } from "@/finish";

const inputs: ReviewInputs = { changed: ["a.ts"], hints: [], stories: [], prdPath: ".nax/features/feat/prd.json" };
const q = (title: string, extra: Partial<Finding> = {}): FinishReviewOutput => ({
  findings: [{ severity: "MEDIUM", title, problem: "p", fix: "f", source: "quality", file: "a.ts", ...extra }],
  covered: ["a.ts"],
});
// stubGit(...) from the fixture section, declared in this file

function deps(ops: ReturnType<typeof makeFinishOps>, auditDir: string) {
  return {
    ops,
    inputs,
    audit: { auditDir, runId: "run-1" },
    now: () => "t",
    assertNotAborted: () => {},
  };
}

describe("runReviewLoop cap", () => {
  test("three rounds with findings: the round-3 fix SHA is unreviewed and its findings cleared", async () => {
    await withTempDir(async (dir) => {
      const git = { dirty: false, head: 1 };
      stubGit(git);
      const trail: string[] = [];
      const ops = makeFinishOps(trail, { quality: [q("A"), q("B"), q("C")] }, {
        fix: async (phase) => {
          trail.push(`fix:${phase}`);
          git.dirty = true;
          return {};
        },
      });
      const state = makeFinishState();
      await runReviewLoop(state, deps(ops, dir));
      expect(state.review.rounds).toBe(MAX_REVIEW_ROUNDS);
      expect(trail.filter((t) => t === "fix:review")).toHaveLength(3);
      expect(state.review.lastFindings).toEqual([]);
      expect(state.unreviewedFixCommits).toEqual(["sha4"]);
    });
  });

  test("a cap-round fix that commits nothing keeps the findings open", async () => {
    await withTempDir(async (dir) => {
      const git = { dirty: false, head: 1 };
      stubGit(git);
      const trail: string[] = [];
      const ops = makeFinishOps(trail, { quality: [q("A"), q("B"), q("C")] }, {
        fix: async () => {
          if (git.head < 3) git.dirty = true; // rounds 1-2 edit, round 3 rejects everything
          return {};
        },
      });
      const state = makeFinishState();
      await runReviewLoop(state, deps(ops, dir));
      expect(state.review.lastFindings.map((f) => f.title)).toEqual(["C"]);
      expect(state.unreviewedFixCommits).toEqual([]);
    });
  });
});

describe("runReviewLoop failures and advisor-off judgment", () => {
  test("a fix session that throws counts the round and leaves findings open", async () => {
    await withTempDir(async (dir) => {
      stubGit({ dirty: false, head: 1 });
      const trail: string[] = [];
      const ops = makeFinishOps(trail, { quality: [q("A"), q("A")] }, {
        fix: async () => {
          throw new Error("session died");
        },
      });
      const state = makeFinishState();
      await runReviewLoop(state, deps(ops, dir));
      expect(state.review.rounds).toBe(3);
      expect(state.review.lastFindings.map((f) => f.title)).toEqual(["A"]);
    });
  });

  test("contradiction with the advisor off: spec finding fixed, quality finding unresolved", async () => {
    await withTempDir(async (dir) => {
      const git = { dirty: false, head: 1 };
      stubGit(git);
      const fixed: Finding[][] = [];
      const trail: string[] = [];
      const spec: FinishReviewOutput = {
        findings: [{ severity: "HIGH", title: "Must retry", problem: "p", fix: "add retry", source: "spec", file: "a.ts", line: 9 }],
        covered: [],
      };
      const ops = makeFinishOps(trail, { spec: [spec], quality: [q("Retry is bad", { line: 9 })] }, {
        fix: async (_phase, req) => {
          fixed.push(req.findings ?? []);
          git.dirty = true;
          return {};
        },
      });
      const state = makeFinishState();
      await runReviewLoop(state, deps(ops, dir));
      expect(fixed[0]?.map((f) => f.title)).toEqual(["Must retry"]);
      expect(state.review.unresolved.map((f) => f.title)).toEqual(["Retry is bad"]);
    });
  });

  test("a clean round after a gate-fix SHA clears unreviewedFixCommits", async () => {
    await withTempDir(async (dir) => {
      stubGit({ dirty: false, head: 5 });
      const state = makeFinishState({ unreviewedFixCommits: ["sha4"] });
      await runReviewLoop(state, deps(makeFinishOps([]), dir), 1);
      expect(state.unreviewedFixCommits).toEqual([]);
    });
  });
});
```

Exact SHA values depend on how many `commit` calls `commitFixes` makes. Derive them from the stub, and keep the assertion that the cap-round SHA is the one recorded.

**Task 13, machine invariants (in full):**

```ts
test("run abort mid-review → failed 'aborted', no PR calls", async () => {
  const run = new AbortController();
  const trail: string[] = [];
  const ops = makeFinishOps(trail, {}, {
    reviewSpec: async () => {
      run.abort();
      throw new Error("aborted");
    },
  });
  const result = await runFinishMachine(makeFinishState(), {
    context: makeFinishContext({ acceptanceStatus: "disabled" }),
    ops,
    audit,
    signal: run.signal,
    runSignal: run.signal,
    now: () => "t",
  });
  expect(result.status).toBe("failed");
  expect(result.reason).toBe("aborted");
  expect(trail).not.toContain("promotePr");
  expect(trail).not.toContain("finalizeDraftPr");
});

test("flowMs deadline during a fix → no further LLM calls, draft with reason 'deadline'", async () => {
  const phase = new AbortController();
  const trail: string[] = [];
  const ops = makeFinishOps(trail, { quality: [q("A")] }, {
    fix: async () => {
      trail.push("fix:review");
      phase.abort();
      throw new Error("deadline");
    },
  });
  const result = await runFinishMachine(makeFinishState(), {
    context: makeFinishContext({ acceptanceStatus: "disabled" }),
    ops,
    audit,
    signal: phase.signal,
    runSignal: new AbortController().signal,
    now: () => "t",
  });
  expect(result.outcome).toBe("draft");
  expect(result.reason?.startsWith("deadline")).toBe(true);
  expect(trail.slice(trail.indexOf("fix:review") + 1)).toEqual(["finalizeDraftPr"]);
});

test("finalizeDraftPr throws → failed with that error", async () => {
  const ops = makeFinishOps([], { quality: [q("A"), q("A"), q("A")] }, {
    finalizeDraftPr: async () => {
      throw new Error("gh: not authenticated");
    },
  });
  const result = await runFinishMachine(makeFinishState(), {
    context: makeFinishContext({ acceptanceStatus: "disabled" }),
    ops,
    audit,
    now: () => "t",
  });
  expect(result.status).toBe("failed");
  expect(result.reason).toContain("gh: not authenticated");
});
```

(`audit` = a temp-dir `AuditTarget`, `q` as in `review-loop.test.ts`, and `_qualityGateDeps` stubbed green, as the current `machine-loops.test.ts` does.) For the deadline test the trail check needs the gates loop skipped after the abort: `assertNotAborted` throws at the next step, which routes to `recoverAfterThrow`.

**Task 11, `advise.test.ts` (in full, using the file's existing `decision` / `fakeAdvisor` / `state` / `make`):**

```ts
test("hold on one finding does not stop the next", async () => {
  await withTempDir(async (dir) => {
    const replies = [
      { decision: decision({ id: "D-1", action: { type: "hold", reason: "ask a human" } }) },
      { decision: decision({ id: "D-2", action: { type: "fix", instruction: "do it" } }) },
    ];
    const { advisor } = fakeAdvisor(() => replies.shift() ?? { fallbackReason: "none" });
    const j1 = { ...judged, title: "One", source: "spec" as const };
    const j2 = { ...judged, title: "Two", source: "quality" as const };
    const out = await make(dir, advisor).judgedMerged([j1, j2], [], state(dir));
    expect(out.unresolved.map((f) => f.title)).toEqual(["One"]);
    expect(out.toFix.map((f) => f.title)).toEqual(["Two"]);
    expect(out.toFix[0]?.fix).toContain("Advisor ruling (D-2): do it");
    expect(out.advice.map((a) => a.decisionId)).toEqual(["D-1", "D-2"]);
  });
});

test("a contradiction is one question with both findings as evidence; fix → spec finding", async () => {
  await withTempDir(async (dir) => {
    const { advisor, asked } = fakeAdvisor(() => ({ decision: decision({ action: { type: "fix", instruction: "keep retry" } }) }));
    const s = { severity: "LOW" as const, title: "S", problem: "sp", fix: "sf", source: "spec" as const, file: "a.ts", line: 2 };
    const qf = { ...s, title: "Q", problem: "qp", source: "quality" as const, severity: "HIGH" as const };
    const out = await make(dir, advisor).judgedMerged([], [{ spec: s, quality: qf }], state(dir));
    expect(asked).toHaveLength(1);
    expect(asked[0]?.summary).toBe("Spec and quality reviews disagree on a.ts:2");
    expect(asked[0]?.evidence.map((e) => e.text.split(":")[0])).toEqual(["Spec review", "Quality review"]);
    expect(asked[0]?.findingSeverity).toBe("HIGH");
    expect(asked[0]?.dedupeKey).toBe(dedupeKeyFor("spec", s));
    expect(out.toFix.map((f) => f.title)).toEqual(["S"]);
    expect(out.unresolved).toEqual([]);
  });
});
```

Match the `hold` / `fix` action object shapes to `AdviceAction` in `src/advisor/types.ts` (`hold` carries `reason`), and match the fallback `AdviceResult` shape to what `advise()` returns when there is no decision.

**Task 12, `keepDraft` (in full, inside `pr-open.test.ts`):**

```ts
function recordingDeps(view: { exitCode: number; stdout: string }) {
  const calls: string[][] = [];
  const deps = {
    run: async (argv: string[]) => {
      calls.push(argv);
      if (argv.includes("view")) return { exitCode: view.exitCode, stdout: view.stdout, stderr: "" };
      return { exitCode: 0, stdout: "https://x/pr/9\n", stderr: "" };
    },
  };
  return { calls, deps };
}

const args = (forge: "github" | "gitlab") => ({
  workdir: "/r",
  branch: "feat/x",
  title: "feat: x",
  body: "b",
  forge,
  committedThisRun: true,
  keepDraft: true,
});

test.each(["github", "gitlab"] as const)("%s: existing draft is updated and left draft", async (forge) => {
  const viewJson = forge === "github" ? '{"isDraft":true,"url":"https://x/pr/9"}' : '{"draft":true,"web_url":"https://x/pr/9"}';
  const { calls, deps } = recordingDeps({ exitCode: 0, stdout: viewJson });
  const out = await openOrPromotePr(args(forge), deps);
  expect(out.status).toBe("draft");
  expect(calls.some((c) => c.includes("ready") || c.includes("--ready"))).toBe(false);
  expect(calls.some((c) => c.includes("edit") || (c.includes("update") && c.includes("--title")))).toBe(true);
});

test.each(["github", "gitlab"] as const)("%s: no PR → created as a draft", async (forge) => {
  const { calls, deps } = recordingDeps({ exitCode: 1, stdout: "" });
  const out = await openOrPromotePr(args(forge), deps);
  expect(out.status).toBe("draft");
  expect(calls.some((c) => c.includes("create") && c.includes("--draft"))).toBe(true);
});

test("an already-ready PR is not demoted", async () => {
  const { calls, deps } = recordingDeps({ exitCode: 0, stdout: '{"isDraft":false,"url":"https://x/pr/9"}' });
  const out = await openOrPromotePr(args("github"), deps);
  expect(out.status).toBe("already-ready");
  expect(calls.some((c) => c.includes("ready"))).toBe(false);
});
```

Match `viewJson` to what `parseView` (`pr/open.ts:34`) reads for each forge, and match `deps` to the `ForgeDeps` type (add the other members the existing `pr-open.test.ts` stub provides). `openPr` (used for the draft create) may check `hasOpenPr` first, through `deps.run`. Make the stub answer that call the same way the existing `openDraftFinishPr` tests do.

The Task 14 table-driven bodies and the Task 12 body-section cases may be written by the implementer, from the case lists given.

---

## File map

**PR 1 (inert, adds only):**

| File | Responsibility |
|---|---|
| `src/finish/types.ts` (modify) | `ReviewLens`, `Finding.file/line/source`, `FinishReviewOutput` |
| `src/finish/review-json/index.ts` (create, nested barrel) | parse + validate a review op's JSON reply into `FinishReviewOutput` |
| `src/finish/a3-hints.ts` (create) | read A3 worth-check skip verdicts for a feature |
| `src/finish/changed-files.ts` (create) | `git diff --name-only base...HEAD` |
| `src/prompts/builders/finish-review-builder.ts` (create) | spec/branch review prompts, JSON retry prompts, grouped fix prompt |
| `src/operations/finish-spec-review.ts` (create) | `finishSpecReviewOp` |
| `src/operations/finish-branch-review.ts` (create) | `finishBranchReviewOp` |
| `src/finish/merge-findings.ts` (create) | merge, dedupe, contradiction flagging |
| `src/finish/review-round.ts` (create) | run both lenses concurrently with `Promise.allSettled` |

**PR 2 (rebuild + deletions):**

| File | Responsibility |
|---|---|
| `src/finish/state.ts`, `types.ts` | `review` loop record, statuses, round outcomes, `FinishPhase` gains `review` |
| `src/finish/fix/dispositions.ts` (create) | `parseDispositions`, `validateDispositions` moved out of `review/` |
| `src/operations/finish-fix.ts` | uses the builder's fix prompt and `finish/fix` |
| `src/finish/advise.ts` | judged signature, contradiction question, approval question from facts |
| `src/finish/resolve.ts` (create) | resolution facts + decision |
| `src/finish/review-loop.ts` (create) | the shared review/fix loop |
| `src/finish/route.ts` | acceptance/gate facts; `routeReview` removed |
| `src/finish/machine.ts` | rewritten flow |
| `src/finish/ops.ts`, `ops-impl.ts` | two review ops, `finalizeDraftPr`, no `narrate` / `escalate` |
| `src/finish/pr/open.ts`, `pr/body.ts`, `pr/context.ts`, `pr-title.ts` | keep-draft path, new sections, reviewer title/summary |
| `src/finish/phase.ts`, `audit.ts`, `notify.ts`, `escalate.ts` | status mapping, ledger, notify |
| `src/config/schemas.ts`, `src/config/runtime-types-finish.ts`, `src/finish/config.ts` | `draft` notify mode, deprecations |
| `src/runtime/session-role.ts` | drop `finish-narrative` |
| `src/cli/advisor-import.ts` | pre-A4 import guard |
| deletions | `src/finish/review/`, `operations/finish-review.ts`, `operations/finish-narrative.ts`, generator scripts, baselines |

---

# PR 1 — Review ops (inert)

Branch: `feat/a4-finish-rebuild` (exists, holds the spec). PR 1 is pushed from this branch; PR 2 continues on a stacked branch `feat/a4-finish-rebuild-2` created after PR 1 merges (or stacked on it if PR 1 is still in review).

### Task 1: Finding shape and review JSON parser

**Files:**
- Modify: `src/finish/types.ts` (the `Finding` interface, lines 5-21)
- Create: `src/finish/review-json/index.ts` (a nested barrel from day one: `src/operations` must import it as `@/finish/review-json` — importing the `@/finish` barrel from `src/operations` is a certain cycle, because `@/finish` exports `ops-impl`, which imports `@/operations`)
- Modify: `src/finish/index.ts` (export the new symbols)
- Test: `test/unit/finish/review-json.test.ts`

**Interfaces:**
- Produces:
  - `export type ReviewLens = "spec" | "quality";` (in `types.ts`)
  - `Finding` gains `file?: string; line?: number; source?: ReviewLens;`
  - `export interface FinishReviewOutput { findings: Finding[]; covered: string[]; title?: string; summary?: string; missing?: true }` (in `types.ts`)
  - `export function parseFinishReviewReply(text: string, lens: ReviewLens): FinishReviewOutput | null` (in `review-json.ts`) — `null` means "not a verdict"
  - `export function isFinishReviewShape(value: unknown): boolean`
  - `export const MISSING_REVIEW: FinishReviewOutput` = `{ findings: [], covered: [], missing: true }`

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/finish/review-json.test.ts
import { describe, expect, test } from "bun:test";
import { isFinishReviewShape, MISSING_REVIEW, parseFinishReviewReply } from "@/finish/review-json";

describe("parseFinishReviewReply", () => {
  test("maps a JSON reply onto Finding with the lens as source", () => {
    const reply = JSON.stringify({
      findings: [
        { severity: "high", title: "Unwired", problem: "new fn never called", fix: "call it", file: "src/a.ts", line: 4 },
      ],
      covered: ["src/a.ts"],
    });
    expect(parseFinishReviewReply(reply, "quality")).toEqual({
      findings: [
        {
          severity: "HIGH",
          title: "Unwired",
          problem: "new fn never called",
          fix: "call it",
          file: "src/a.ts",
          line: 4,
          source: "quality",
        },
      ],
      covered: ["src/a.ts"],
    });
  });

  test("normalises unknown and info severities to LOW and a missing fix to empty", () => {
    const reply = JSON.stringify({
      findings: [
        { severity: "info", title: "a", problem: "p" },
        { severity: "weird", title: "b", problem: "p" },
      ],
      covered: [],
    });
    const out = parseFinishReviewReply(reply, "spec");
    expect(out?.findings.map((f) => [f.severity, f.fix])).toEqual([
      ["LOW", ""],
      ["LOW", ""],
    ]);
  });

  test("keeps judgment fields and multi-line summary, trims title", () => {
    const reply =
      '{"findings":[{"severity":"MEDIUM","title":"t","problem":"p","fix":"f","judgment":true,"judgmentReason":"spec vs code"}],' +
      '"covered":[],"title":"  feat(x): add y  ","summary":"line one\nline two"}';
    const out = parseFinishReviewReply(reply, "quality");
    expect(out?.findings[0]?.judgment).toBe(true);
    expect(out?.findings[0]?.judgmentReason).toBe("spec vs code");
    expect(out?.title).toBe("feat(x): add y");
    expect(out?.summary).toBe("line one\nline two");
  });

  test("drops findings missing title or problem, and non-string covered entries", () => {
    const reply = JSON.stringify({
      findings: [{ severity: "LOW", title: "", problem: "p" }, { severity: "LOW", title: "ok", problem: "p" }],
      covered: ["a.ts", 3, null],
    });
    const out = parseFinishReviewReply(reply, "spec");
    expect(out?.findings.map((f) => f.title)).toEqual(["ok"]);
    expect(out?.covered).toEqual(["a.ts"]);
  });

  test("returns null for prose and for an object without a findings array", () => {
    expect(parseFinishReviewReply("I looked at the diff and it is fine.", "spec")).toBeNull();
    expect(parseFinishReviewReply('{"covered":[]}', "spec")).toBeNull();
  });

  test("isFinishReviewShape and MISSING_REVIEW", () => {
    expect(isFinishReviewShape({ findings: [], covered: [] })).toBe(true);
    expect(isFinishReviewShape({ findings: "no" })).toBe(false);
    expect(MISSING_REVIEW).toEqual({ findings: [], covered: [], missing: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `timeout 30 bun test test/unit/finish/review-json.test.ts --timeout=5000`
Expected: FAIL — `Cannot find module '@/finish/review-json'`.

- [ ] **Step 3: Extend the types**

In `src/finish/types.ts`, replace the `Finding` interface (keep its existing doc comments on `judgment` / `judgmentReason`) and add the two new types directly below it:

```ts
export type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

/** Which finish review produced a finding (A4). */
export type ReviewLens = "spec" | "quality";

export interface Finding {
  severity: Severity;
  title: string;
  problem: string;
  fix: string;
  /** (keep the existing doc comment) */
  judgment?: boolean;
  /** (keep the existing doc comment) */
  judgmentReason?: string;
  /** A4: repo-relative path the finding is about, when it has one. */
  file?: string;
  /** A4: line in `file`, when the reviewer gave one. */
  line?: number;
  /**
   * A4: the review that produced it. Set by finish from the producing op, never by the model.
   * Optional only so pre-A4 `result.json` files still type-check when imported.
   */
  source?: ReviewLens;
}

/** What one A4 finish review op returns. */
export interface FinishReviewOutput {
  findings: Finding[];
  /** Repo-relative paths the reviewer says it read. Telemetry only — never routed on. */
  covered: string[];
  /** Branch review only: conventional-commit PR title. */
  title?: string;
  /** Branch review only: the PR's "What changed" prose. */
  summary?: string;
  /** Set when the op produced no parseable verdict after its retry. */
  missing?: true;
}
```

- [ ] **Step 4: Write the parser**

```ts
// src/finish/review-json/index.ts
/**
 * A4: parse one finish review op's JSON reply (spec §4.1).
 *
 * The reply shape is shared by both lenses; `lens` is stamped onto every
 * finding here so the model can never claim a source. `null` means "not a
 * verdict" — the op's retry strategy reprompts on it, and its exhausted
 * fallback is `MISSING_REVIEW`.
 */
import { tryParseLLMJson } from "@/utils/llm-json";
import type { Finding, FinishReviewOutput, ReviewLens, Severity } from "../types";

const SEVERITIES: ReadonlySet<string> = new Set(["CRITICAL", "HIGH", "MEDIUM", "LOW"]);

export const MISSING_REVIEW: FinishReviewOutput = { findings: [], covered: [], missing: true };

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function toSeverity(value: unknown): Severity {
  const upper = typeof value === "string" ? value.trim().toUpperCase() : "";
  return SEVERITIES.has(upper) ? (upper as Severity) : "LOW";
}

function toFinding(raw: unknown, lens: ReviewLens): Finding | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const title = str(r.title);
  const problem = str(r.problem);
  if (!title || !problem) return null;
  const file = str(r.file);
  const line = typeof r.line === "number" && Number.isInteger(r.line) && r.line > 0 ? r.line : undefined;
  const judgmentReason = str(r.judgmentReason);
  return {
    severity: toSeverity(r.severity),
    title,
    problem,
    fix: str(r.fix) ?? "",
    ...(r.judgment === true ? { judgment: true } : {}),
    ...(judgmentReason ? { judgmentReason } : {}),
    ...(file ? { file } : {}),
    ...(line ? { line } : {}),
    source: lens,
  };
}

export function isFinishReviewShape(value: unknown): boolean {
  return !!value && typeof value === "object" && Array.isArray((value as { findings?: unknown }).findings);
}

export function parseFinishReviewReply(text: string, lens: ReviewLens): FinishReviewOutput | null {
  const parsed = tryParseLLMJson<Record<string, unknown>>(text);
  if (!isFinishReviewShape(parsed)) return null;
  const p = parsed as Record<string, unknown>;
  const findings = (p.findings as unknown[]).map((f) => toFinding(f, lens)).filter((f): f is Finding => f !== null);
  const covered = Array.isArray(p.covered) ? p.covered.filter((c): c is string => typeof c === "string") : [];
  const title = str(p.title);
  const summary = str(p.summary);
  return { findings, covered, ...(title ? { title } : {}), ...(summary ? { summary } : {}) };
}
```

`tryParseLLMJson<T>(text): T | null` never throws (`src/utils/llm-json.ts:456`), so no try/catch is needed.

Add to `src/finish/index.ts`:

```ts
export type { FinishReviewOutput, ReviewLens } from "./types";
export { isFinishReviewShape, MISSING_REVIEW, parseFinishReviewReply } from "./review-json";  // resolves to review-json/index.ts
```

- [ ] **Step 5: Run test to verify it passes**

Run: `timeout 30 bun test test/unit/finish/review-json.test.ts --timeout=5000`
Expected: PASS (6 tests).

- [ ] **Step 6: Run the finish suite to confirm the widened `Finding` breaks nothing**

Run: `timeout 60 bun test test/unit/finish/ --timeout=5000`
Expected: PASS (all existing tests).

- [ ] **Step 7: Commit**

```bash
git add src/finish/types.ts src/finish/review-json src/finish/index.ts test/unit/finish/review-json.test.ts
git commit -m "feat(finish): A4 finding location/source and review JSON parser"
```

### Task 2: A3 hints reader

**Files:**
- Create: `src/finish/a3-hints.ts`
- Modify: `src/finish/index.ts`
- Test: `test/unit/finish/a3-hints.test.ts`

**Interfaces:**
- Consumes: the `NbfWorthCheckAuditFile` JSON shape written by `src/operations/nbf-worth-check-audit.ts` — fields used: `mode` (`"on" | "shadow"`), `parsed` (boolean), `findings[] {index?, severity, category, file?, line?, message}`, `verdicts[] {index, verdict, reason}`. Verified: each audit `findings[]` entry carries a 1-based `index` (`nbf-worth-check-audit.ts`, `index: index + 1`); join `verdicts[i].index` to the finding with the same `index` field.
- Produces:
  - `export interface A3Hint { file?: string; line?: number; severity: string; message: string; reason: string }`
  - `export async function readA3Hints(outputDir: string, feature: string): Promise<A3Hint[]>`
  - `export const _a3HintsDeps = { listJson: (dir: string) => Promise<string[]>, readText: (path: string) => Promise<string> }`

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/finish/a3-hints.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { _a3HintsDeps, readA3Hints } from "@/finish/a3-hints";

const original = { ..._a3HintsDeps };
afterEach(() => Object.assign(_a3HintsDeps, original));

function record(mode: "on" | "shadow", parsed: boolean) {
  return JSON.stringify({
    mode,
    parsed,
    findings: [
      { index: 1, severity: "info", category: "convention", file: "src/a.ts", line: 3, message: "stale comment" },
      { index: 2, severity: "warning", category: "input", file: "src/b.ts", message: "empty list" },
    ],
    verdicts: [
      { index: 1, verdict: "skip", reason: "only matters if code changes" },
      { index: 2, verdict: "fix", reason: "real" },
    ],
  });
}

function stubFiles(files: Record<string, string>) {
  _a3HintsDeps.listJson = async () => Object.keys(files);
  _a3HintsDeps.readText = async (p) => {
    const text = files[p];
    if (text === undefined) throw new Error("ENOENT");
    return text;
  };
}

describe("readA3Hints", () => {
  test("returns skip verdicts joined to their finding, from on+parsed records only", async () => {
    stubFiles({ "/out/nbf-worth-check/feat/US-1-1.json": record("on", true) });
    expect(await readA3Hints("/out", "feat")).toEqual([
      { file: "src/a.ts", line: 3, severity: "info", message: "stale comment", reason: "only matters if code changes" },
    ]);
  });

  test("ignores shadow and unparsed records", async () => {
    stubFiles({
      "/out/nbf-worth-check/feat/US-1-1.json": record("shadow", true),
      "/out/nbf-worth-check/feat/US-2-1.json": record("on", false),
    });
    expect(await readA3Hints("/out", "feat")).toEqual([]);
  });

  test("absent directory reads as no hints", async () => {
    _a3HintsDeps.listJson = async () => {
      throw new Error("ENOENT");
    };
    expect(await readA3Hints("/out", "feat")).toEqual([]);
  });

  test("a malformed file is skipped, others still read", async () => {
    stubFiles({
      "/out/nbf-worth-check/feat/bad.json": "{not json",
      "/out/nbf-worth-check/feat/US-1-1.json": record("on", true),
    });
    expect((await readA3Hints("/out", "feat")).length).toBe(1);
  });

  test("a verdict index with no matching finding is dropped", async () => {
    stubFiles({
      "/out/nbf-worth-check/feat/x.json": JSON.stringify({
        mode: "on",
        parsed: true,
        findings: [],
        verdicts: [{ index: 7, verdict: "skip", reason: "r" }],
      }),
    });
    expect(await readA3Hints("/out", "feat")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `timeout 30 bun test test/unit/finish/a3-hints.test.ts --timeout=5000`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the reader**

```ts
// src/finish/a3-hints.ts
/**
 * A4: the A3 worth-check's skipped findings for one feature, as hints for the
 * branch reviewer (spec §4.4). Context only — never findings by themselves.
 *
 * Only `mode: "on"` records with a parsed reply count: in shadow mode the
 * worth-check judged but nothing was skipped, so its `skip` verdicts are not
 * "previously skipped". Every read failure degrades to fewer hints, never a throw.
 */
import { join } from "node:path";
import { getSafeLogger } from "@/logger";

export interface A3Hint {
  file?: string;
  line?: number;
  severity: string;
  message: string;
  reason: string;
}

async function listJson(dir: string): Promise<string[]> {
  const glob = new Bun.Glob("*.json");
  const out: string[] = [];
  for await (const name of glob.scan({ cwd: dir, absolute: false })) out.push(join(dir, name));
  return out.sort();
}

export const _a3HintsDeps = {
  listJson,
  readText: (path: string): Promise<string> => Bun.file(path).text(),
};

interface AuditFinding {
  index?: unknown;
  severity?: unknown;
  file?: unknown;
  line?: unknown;
  message?: unknown;
}

function hintsFromRecord(raw: unknown): A3Hint[] {
  if (!raw || typeof raw !== "object") return [];
  const r = raw as { mode?: unknown; parsed?: unknown; findings?: unknown; verdicts?: unknown };
  if (r.mode !== "on" || r.parsed !== true || !Array.isArray(r.findings) || !Array.isArray(r.verdicts)) return [];
  const findings = r.findings as AuditFinding[];
  const out: A3Hint[] = [];
  for (const v of r.verdicts as { index?: unknown; verdict?: unknown; reason?: unknown }[]) {
    if (v.verdict !== "skip" || typeof v.index !== "number") continue;
    const f = findings.find((x) => x.index === v.index);
    if (!f || typeof f.message !== "string") continue;
    out.push({
      ...(typeof f.file === "string" ? { file: f.file } : {}),
      ...(typeof f.line === "number" ? { line: f.line } : {}),
      severity: typeof f.severity === "string" ? f.severity : "info",
      message: f.message,
      reason: typeof v.reason === "string" ? v.reason : "",
    });
  }
  return out;
}

export async function readA3Hints(outputDir: string, feature: string): Promise<A3Hint[]> {
  const dir = join(outputDir, "nbf-worth-check", feature);
  let files: string[];
  try {
    files = await _a3HintsDeps.listJson(dir);
  } catch {
    return []; // no worth-check records for this feature: off, or never ran
  }
  const hints: A3Hint[] = [];
  for (const path of files) {
    try {
      hints.push(...hintsFromRecord(JSON.parse(await _a3HintsDeps.readText(path))));
    } catch (err) {
      getSafeLogger()?.debug("finish", "A3 hint record skipped", { storyId: "_run", path, error: String(err) });
    }
  }
  return hints;
}
```

Export from `src/finish/index.ts`:

```ts
export type { A3Hint } from "./a3-hints";
export { _a3HintsDeps, readA3Hints } from "./a3-hints";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `timeout 30 bun test test/unit/finish/a3-hints.test.ts --timeout=5000`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/finish/a3-hints.ts src/finish/index.ts test/unit/finish/a3-hints.test.ts
git commit -m "feat(finish): A4 read A3 worth-check skips as branch-review hints"
```

### Task 3: Changed files and the review prompt builders

**Files:**
- Create: `src/finish/changed-files.ts`
- Create: `src/prompts/builders/finish-review-builder.ts`
- Modify: `src/prompts/index.ts`, `src/finish/index.ts`
- Test: `test/unit/finish/changed-files.test.ts`, `test/unit/prompts/builders/finish-review-builder.test.ts`

**Interfaces:**
- Consumes: `A3Hint` (Task 2), `Finding` (Task 1), `_finishGitDeps.git` (`src/finish/commit.ts:34`, signature `(args: string[], cwd: string) => Promise<{ exitCode: number; stdout: string; stderr: string }>` — confirm in `src/utils/git.ts` `gitWithTimeout`).
- Produces:
  - `export async function changedFiles(workdir: string, base: string): Promise<string[]>` — `[]` on any git failure.
  - `export interface FinishSpecReviewPromptInput { base: string; specPath: string; prdPath: string; changedFiles: string[]; decisions?: string }`
  - `export interface FinishBranchReviewPromptInput { base: string; stories: { id: string; title: string }[]; changedFiles: string[]; hints: A3Hint[] }`
  - `export function buildFinishSpecReviewPrompt(input: FinishSpecReviewPromptInput): string`
  - `export function buildFinishBranchReviewPrompt(input: FinishBranchReviewPromptInput): string`
  - `export function buildFinishReviewJsonRetry(): string`
  - `export function buildFinishReviewJsonRetryCondensed(): string`
  - `export function buildFinishFixPrompt(phase: "acceptance" | "gate" | "review", args: { findings?: Finding[]; gateOutput?: string; acceptanceOutput?: string }): string`

- [ ] **Step 1: Write the failing tests**

```ts
// test/unit/finish/changed-files.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { _finishGitDeps } from "@/finish";
import { changedFiles } from "@/finish/changed-files";

const original = _finishGitDeps.git;
afterEach(() => {
  _finishGitDeps.git = original;
});

describe("changedFiles", () => {
  test("lists files changed on the branch, three-dot range", async () => {
    let seen: string[] = [];
    _finishGitDeps.git = async (args) => {
      seen = args;
      return { exitCode: 0, stdout: "src/a.ts\nsrc/b.ts\n\n", stderr: "" };
    };
    expect(await changedFiles("/repo", "origin/main")).toEqual(["src/a.ts", "src/b.ts"]);
    expect(seen).toEqual(["diff", "--name-only", "origin/main...HEAD"]);
  });

  test("a failing git reads as no files", async () => {
    _finishGitDeps.git = async () => ({ exitCode: 128, stdout: "", stderr: "bad ref" });
    expect(await changedFiles("/repo", "origin/main")).toEqual([]);
  });
});
```

```ts
// test/unit/prompts/builders/finish-review-builder.test.ts
import { describe, expect, test } from "bun:test";
import {
  buildFinishBranchReviewPrompt,
  buildFinishFixPrompt,
  buildFinishReviewJsonRetry,
  buildFinishSpecReviewPrompt,
} from "@/prompts";

describe("finish review prompts", () => {
  test("spec prompt names spec, PRD, changed files, decisions and the no-AC-rewalk remit", () => {
    const p = buildFinishSpecReviewPrompt({
      base: "origin/main",
      specPath: ".nax/features/f/spec.md",
      prdPath: ".nax/features/f/prd.json",
      changedFiles: ["src/a.ts"],
      decisions: "- D1 waived X",
    });
    expect(p).toContain(".nax/features/f/spec.md");
    expect(p).toContain(".nax/features/f/prd.json");
    expect(p).toContain("src/a.ts");
    expect(p).toContain("- D1 waived X");
    expect(p).toContain("Do not re-check acceptance criteria one by one");
    expect(p).toContain('"findings"');
    expect(p).not.toContain("## WALK");
  });

  test("branch prompt lists stories by id and title only, plus A3 hints, and asks for title + summary", () => {
    const p = buildFinishBranchReviewPrompt({
      base: "origin/main",
      stories: [{ id: "US-001", title: "Add store" }],
      changedFiles: ["src/a.ts"],
      hints: [{ file: "src/a.ts", line: 3, severity: "info", message: "stale comment", reason: "later only" }],
    });
    expect(p).toContain("US-001: Add store");
    expect(p).toContain("Previously skipped as not worth fixing");
    expect(p).toContain("src/a.ts:3 — stale comment (skipped: later only)");
    expect(p).toContain('"title"');
    expect(p).toContain('"summary"');
    expect(p).not.toContain("## WALK");
  });

  test("branch prompt without hints has no hints section", () => {
    const p = buildFinishBranchReviewPrompt({ base: "b", stories: [], changedFiles: [], hints: [] });
    expect(p).not.toContain("Previously skipped");
  });

  test("review fix prompt groups findings by source and keeps 1-based numbering across groups", () => {
    const p = buildFinishFixPrompt("review", {
      findings: [
        { severity: "HIGH", title: "Q1", problem: "qp", fix: "qf", source: "quality" },
        { severity: "MEDIUM", title: "S1", problem: "sp", fix: "sf", source: "spec" },
      ],
    });
    expect(p.indexOf("## Spec findings")).toBeLessThan(p.indexOf("## Quality findings"));
    expect(p).toContain("[1] [MEDIUM] S1");
    expect(p).toContain("[2] [HIGH] Q1");
    expect(p).toContain("## DISPOSITIONS");
  });

  test("gate fix prompt carries the gate output", () => {
    expect(buildFinishFixPrompt("gate", { gateOutput: "lint failed" })).toContain("lint failed");
  });

  test("json retry asks for the object only", () => {
    expect(buildFinishReviewJsonRetry()).toContain('{"findings"');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `timeout 30 bun test test/unit/finish/changed-files.test.ts test/unit/prompts/builders/finish-review-builder.test.ts --timeout=5000`
Expected: FAIL — modules/exports not found.

- [ ] **Step 3: Write `changed-files.ts`**

```ts
// src/finish/changed-files.ts
/** A4: files the feature branch changed, for the review prompts and coverage telemetry. */
import { _finishGitDeps } from "./commit";

export async function changedFiles(workdir: string, base: string): Promise<string[]> {
  try {
    const res = await _finishGitDeps.git(["diff", "--name-only", `${base}...HEAD`], workdir);
    if (res.exitCode !== 0) return [];
    return res.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  } catch {
    return []; // git unavailable: the prompts fall back to "read the diff yourself"
  }
}
```

Export from `src/finish/index.ts`: `export { changedFiles } from "./changed-files";`

- [ ] **Step 4: Write the builder**

Before writing, open `src/finish/review/references/code-quality.md` and copy its "What to look for" bullet list verbatim into `QUALITY_CHECKLIST` below (replace the abbreviated list). Do not copy the "Forcing function" / `## WALK` section.

```ts
// src/prompts/builders/finish-review-builder.ts
/**
 * A4 finish prompts (spec §4.2, §4.3, §5): the branch-level spec review, the
 * branch review, their JSON retry prompts, and the finish fix prompt.
 * Replaces the markdown contract in `src/finish/review/prompt.ts`.
 */
import type { A3Hint } from "@/finish/a3-hints";
import type { Finding } from "@/finish/types";

const REPLY_SHAPE = `## Reply
Reply with only one JSON object, no prose before or after it:
{"findings":[{"severity":"HIGH|MEDIUM|LOW|CRITICAL","title":"<short>","problem":"<what is wrong>","fix":"<what to change>","file":"<repo-relative path>","line":<number or omit>,"judgment":<true only if it needs a decision, not a code change>,"judgmentReason":"<why, when judgment>"}],
 "covered":["<every repo-relative path you read>"]BRANCH_FIELDS}
An empty "findings" array means you found nothing. Do not invent findings to fill it.`;

const BRANCH_FIELDS = `,
 "title":"<conventional-commit PR title, at most 72 characters>",
 "summary":"<what changed on this branch and why, a few short paragraphs for a reviewer>"`;

const QUALITY_CHECKLIST = `## Clean-code checklist
- Test isolation: shared state, globals or files mutated without teardown.
- Dead or redundant code; logic duplicated from an existing helper.
- Resource leaks: handles, timers, listeners, subprocesses not closed.
- Error handling: swallowed errors, missing validation on a new input path.
- Concurrency: unsynchronised shared state, check-then-act races.
- Performance: N+1 calls, blocking I/O on a hot path, quadratic scans.
- Accessibility (UI diffs only).
- Security (only where the diff touches it).
- Type safety: unsafe casts, widened types, dropped narrowing.`;

function fileList(files: string[], base: string): string {
  return files.length > 0 ? files.map((f) => `- ${f}`).join("\n") : `(could not list them — read \`git diff ${base}...HEAD\`)`;
}

export interface FinishSpecReviewPromptInput {
  base: string;
  specPath: string;
  prdPath: string;
  changedFiles: string[];
  decisions?: string;
}

export function buildFinishSpecReviewPrompt(input: FinishSpecReviewPromptInput): string {
  return [
    "You are reviewing a finished feature branch against its spec, as a whole. You do not edit anything.",
    `## Inputs\n- Spec: \`${input.specPath}\`\n- PRD (stories and acceptance criteria): \`${input.prdPath}\`\n- Diff: \`git diff ${input.base}...HEAD\``,
    `## Changed files\n${fileList(input.changedFiles, input.base)}`,
    ...(input.decisions ? [`## Decisions already made (do not raise these again)\n${input.decisions}`] : []),
    [
      "## What to look for",
      "- Spec requirements that no story implemented (the PRD may have dropped or split them).",
      "- Constraints that span stories: limits, ordering, atomicity, error behaviour.",
      "- A later story contradicting or undoing an earlier one.",
      "- Code that conflicts with the spec. Mark these `judgment: true` when deciding needs a person or the advisor.",
      "Do not re-check acceptance criteria one by one — each story's review already did. Do not report code style.",
    ].join("\n"),
    REPLY_SHAPE.replace("BRANCH_FIELDS", ""),
  ].join("\n\n");
}

export interface FinishBranchReviewPromptInput {
  base: string;
  stories: { id: string; title: string }[];
  changedFiles: string[];
  hints: A3Hint[];
}

function hintLine(h: A3Hint): string {
  const where = h.file ? `${h.file}${h.line ? `:${h.line}` : ""}` : "(no file)";
  return `- ${where} — ${h.message} (skipped: ${h.reason})`;
}

export function buildFinishBranchReviewPrompt(input: FinishBranchReviewPromptInput): string {
  const stories = input.stories.length > 0 ? input.stories.map((s) => `- ${s.id}: ${s.title}`).join("\n") : "(none listed)";
  return [
    "You are reviewing a finished feature branch as a whole, across all of its stories. You do not edit anything.",
    `## Inputs\n- Diff: \`git diff ${input.base}...HEAD\`\n## Stories\n${stories}`,
    `## Changed files\n${fileList(input.changedFiles, input.base)}`,
    [
      "## What to look for",
      "- New code that nothing in production reaches (not wired in, only called from tests).",
      "- Logic duplicated across stories, or duplicating an existing helper.",
      "- Inconsistent patterns between stories for the same kind of thing.",
    ].join("\n"),
    QUALITY_CHECKLIST,
    ...(input.hints.length > 0
      ? [
          `## Previously skipped as not worth fixing — re-raise only if the whole branch makes it matter\n${input.hints.map(hintLine).join("\n")}`,
        ]
      : []),
    REPLY_SHAPE.replace("BRANCH_FIELDS", BRANCH_FIELDS),
  ].join("\n\n");
}

export function buildFinishReviewJsonRetry(): string {
  return 'Your reply was not the required JSON object. Re-send it now as only {"findings":[...],"covered":[...]} (plus "title" and "summary" if you were asked for them), with no other text.';
}

export function buildFinishReviewJsonRetryCondensed(): string {
  return 'Your reply was cut off. Re-send a shorter version: keep every finding but shorten "problem" and "fix" to one sentence each, and keep "summary" under 120 words. Only the JSON object.';
}

function numbered(findings: Finding[], offset: number): string {
  return findings
    .map((f, i) => `[${offset + i + 1}] [${f.severity}] ${f.title}${f.file ? ` (${f.file}${f.line ? `:${f.line}` : ""})` : ""}\n  Problem: ${f.problem}\n  Fix: ${f.fix}`)
    .join("\n");
}

const NO_COMMIT = "Do not commit, push, or open PRs — nax commits and pushes your edits itself.";

export function buildFinishFixPrompt(
  phase: "acceptance" | "gate" | "review",
  args: { findings?: Finding[]; gateOutput?: string; acceptanceOutput?: string },
): string {
  if (phase !== "review") {
    const detail = phase === "gate" ? (args.gateOutput ?? "") : (args.acceptanceOutput ?? "");
    return [
      `Fix the failing ${phase === "gate" ? "repo checks" : "acceptance tests"} below, directly in the repo.`,
      NO_COMMIT,
      `Output:\n${detail}`,
      "After fixing, re-run them; stop when they pass.",
    ].join("\n\n");
  }
  const all = args.findings ?? [];
  const spec = all.filter((f) => f.source === "spec");
  const quality = all.filter((f) => f.source !== "spec");
  return [
    "Resolve the branch review findings below, directly in the repo.",
    NO_COMMIT,
    ...(spec.length > 0 ? [`## Spec findings\n${numbered(spec, 0)}`] : []),
    ...(quality.length > 0 ? [`## Quality findings\n${numbered(quality, spec.length)}`] : []),
    [
      "A finding may be REJECTED rather than fixed — only on evidence: an existing test that deliberately pins",
      "the current behaviour, or a spec statement that requires it. Cite the `file:line`. Fix everything else.",
    ].join("\n"),
    [
      "After fixing, re-run the feature's acceptance tests and the relevant checks.",
      "Then end your reply with one line per finding, numbered as above:",
      "",
      "## DISPOSITIONS",
      "[1] fixed",
      "[2] rejected — evidence: test/unit/foo.test.ts:42",
    ].join("\n"),
  ].join("\n\n");
}
```

The fix prompt's numbering is spec findings first, then quality findings. The caller (Task 11) must pass the same order to `parseDispositions` consumers: sort `toFix` as `[...spec, ...quality]` before calling the op, so disposition index N maps to `toFix[N-1]`.

Export from `src/prompts/index.ts` (next to the nbf-worth-check exports):

```ts
export type {
  FinishBranchReviewPromptInput,
  FinishSpecReviewPromptInput,
} from "./builders/finish-review-builder";
export {
  buildFinishBranchReviewPrompt,
  buildFinishFixPrompt,
  buildFinishReviewJsonRetry,
  buildFinishReviewJsonRetryCondensed,
  buildFinishSpecReviewPrompt,
} from "./builders/finish-review-builder";
```

If `bun run check:import-cycles` reports a new cycle from the type-only `@/finish/*` imports, it should not (type-only imports are excluded); if it does, move `A3Hint` and the `Finding` import to `import type` from leaf paths exactly as written above and re-run.

- [ ] **Step 5: Run tests to verify they pass**

Run: `timeout 30 bun test test/unit/finish/changed-files.test.ts test/unit/prompts/builders/finish-review-builder.test.ts --timeout=5000`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/finish/changed-files.ts src/finish/index.ts src/prompts/builders/finish-review-builder.ts src/prompts/index.ts test/unit/finish/changed-files.test.ts test/unit/prompts/builders/finish-review-builder.test.ts
git commit -m "feat(finish): A4 branch review prompt builders and changed-file list"
```

### Task 4: The two review ops

**Files:**
- Create: `src/operations/finish-spec-review.ts`, `src/operations/finish-branch-review.ts`
- Modify: `src/operations/index.ts`
- Test: `test/unit/operations/finish-spec-review.test.ts`, `test/unit/operations/finish-branch-review.test.ts`

**Interfaces:**
- Consumes: Task 1 (`parseFinishReviewReply`, `MISSING_REVIEW`, `FinishReviewOutput`), Task 3 builders, `makeParseRetryStrategy` (`src/agents/retry`), `finishConfigSelector`.
- Produces:
  - `export interface FinishSpecReviewInput { base: string; specPath: string; prdPath: string; changedFiles: string[]; decisions?: string; model?: ConfiguredModel; timeoutMs?: number }`
  - `export const finishSpecReviewOp: RunOperation<FinishSpecReviewInput, FinishReviewOutput, FinishConfig>` (session role `finish-review-spec`)
  - `export interface FinishBranchReviewInput { base: string; stories: { id: string; title: string }[]; changedFiles: string[]; hints: A3Hint[]; model?: ConfiguredModel; timeoutMs?: number }`
  - `export const finishBranchReviewOp: RunOperation<FinishBranchReviewInput, FinishReviewOutput, FinishConfig>` (session role `finish-review-quality`)

Before writing, open `src/operations/finish-review.ts` (the op being replaced) and `src/operations/types.ts`: copy its `kind`, `stage: "review"`, `config`, `session` (`lifetime: "fresh"`), `model`, `timeoutMs` and `build` return shape (`{ role: {...}, task: {...} }`) exactly. Check `makeParseRetryStrategy`'s options in `src/agents/retry` — the adversarial op passes `validate`, `reviewerKind`, `maxAttempts`, `prompts.{invalid,truncated}`, `exhaustedFallback`, `outputPreviewBytes`, `logContext`; `finish-review.ts` additionally passes `parse`. Use `parse` + `validate` as below. If the finish-review op declares `tools` (it does not today), keep read-only tools only.

- [ ] **Step 1: Write the failing tests**

```ts
// test/unit/operations/finish-spec-review.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { makeTestRuntime, opSelector } from "@test/helpers";
import { finishSpecReviewOp } from "@/operations";
import type { NaxRuntime } from "@/runtime";

const createdRuntimes: NaxRuntime[] = [];
afterEach(async () => {
  await Promise.allSettled(createdRuntimes.map((r) => r.close()));
  createdRuntimes.length = 0;
});

// Same op-context construction as the finish-review op test this replaces.
function makeCtx() {
  const runtime = makeTestRuntime();
  createdRuntimes.push(runtime);
  const view = runtime.packages.repo();
  return { packageView: view, config: view.select(opSelector(finishSpecReviewOp.config)) };
}

const input = {
  base: "origin/main",
  specPath: ".nax/features/f/spec.md",
  prdPath: ".nax/features/f/prd.json",
  changedFiles: ["src/a.ts"],
};

describe("finishSpecReviewOp", () => {
  test("is a read-only review op on the finish-review-spec role", () => {
    expect(finishSpecReviewOp.name).toBe("finish-spec-review");
    expect(finishSpecReviewOp.session.role).toBe("finish-review-spec");
    expect(finishSpecReviewOp.session.lifetime).toBe("fresh");
    expect(finishSpecReviewOp.tools).toEqual(["Read", "Glob", "Grep", "Git"]);
  });

  test("build carries the spec, PRD and changed files", () => {
    const built = finishSpecReviewOp.build(input, makeCtx());
    expect(built.task.content).toContain(".nax/features/f/prd.json");
    expect(built.task.content).toContain("src/a.ts");
  });

  test("parse stamps spec as the source", () => {
    const out = finishSpecReviewOp.parse(
      '{"findings":[{"severity":"HIGH","title":"t","problem":"p","fix":"f"}],"covered":[]}',
      input,
      makeCtx(),
    );
    expect(out.findings[0]?.source).toBe("spec");
  });

  test("parse of prose is a missing review, not a throw", () => {
    expect(finishSpecReviewOp.parse("looks fine to me", input, makeCtx())).toEqual({
      findings: [],
      covered: [],
      missing: true,
    });
  });
});
```

If `parse`'s third parameter type differs from `build`'s context (check `RunOperation` in `src/operations/types.ts`), build the matching value the same way `test/unit/operations/finish-review.test.ts` does for its `parse` cases; never cast.

```ts
// test/unit/operations/finish-branch-review.test.ts — same structure, plus:
//  - name "finish-branch-review", role "finish-review-quality"
//  - parse keeps title and summary:
//    finishBranchReviewOp.parse('{"findings":[],"covered":[],"title":"feat: x","summary":"s"}', input, ctx)
//    toEqual({ findings: [], covered: [], title: "feat: x", summary: "s" })
//  - build(input, ctx).task.content contains "US-001: Add store" and "Previously skipped" when hints are given
```

Write the branch-review test file in full following that list (copy the spec test file and change names, role and assertions as listed; do not leave the comment block).

- [ ] **Step 2: Run tests to verify they fail**

Run: `timeout 30 bun test test/unit/operations/finish-spec-review.test.ts test/unit/operations/finish-branch-review.test.ts --timeout=5000`
Expected: FAIL — exports not found.

- [ ] **Step 3: Write the ops**

```ts
// src/operations/finish-spec-review.ts
/**
 * A4: branch-level spec review (spec §4.2). Read-only; JSON reply; one parse
 * retry, then a missing verdict (`MISSING_REVIEW`) — never a throw, never a pass.
 */
import { makeParseRetryStrategy } from "@/agents/retry";
import type { ConfiguredModel } from "@/config";
import { finishConfigSelector } from "@/config";
import type { FinishConfig } from "@/config/selectors";
import type { FinishReviewOutput } from "@/finish/types";
import { MISSING_REVIEW, parseFinishReviewReply } from "@/finish/review-json";
import { buildFinishReviewJsonRetry, buildFinishReviewJsonRetryCondensed, buildFinishSpecReviewPrompt } from "@/prompts";
import type { RunOperation } from "./types";

export interface FinishSpecReviewInput {
  base: string;
  specPath: string;
  prdPath: string;
  changedFiles: string[];
  decisions?: string;
  model?: ConfiguredModel;
  timeoutMs?: number;
}

export const finishSpecReviewOp: RunOperation<FinishSpecReviewInput, FinishReviewOutput, FinishConfig> = {
  kind: "run",
  name: "finish-spec-review",
  stage: "review",
  config: finishConfigSelector,
  session: { role: "finish-review-spec", lifetime: "fresh" },
  // Read-only, plus Git: the prompt tells the reviewer to read `git diff base...HEAD`,
  // and DEFAULT_CODING_TOOLS has no Git (same list as adversarial-review.ts).
  tools: ["Read", "Glob", "Grep", "Git"],
  model: (input) => input.model,
  timeoutMs: (input, ctx) => input.timeoutMs ?? ctx.config.execution.sessionTimeoutSeconds * 1000,
  build(input) {
    const content = buildFinishSpecReviewPrompt(input);
    return {
      role: { id: "role", content: "", overridable: false },
      task: { id: "task", content, overridable: false },
    };
  },
  parse(output) {
    return parseFinishReviewReply(output, "spec") ?? MISSING_REVIEW;
  },
  retry: makeParseRetryStrategy({
    parse: (output) => parseFinishReviewReply(output, "spec"),
    validate: (parsed) => parsed !== null,
    reviewerKind: "finish-spec-review",
    maxAttempts: 2,
    prompts: { invalid: buildFinishReviewJsonRetry, truncated: buildFinishReviewJsonRetryCondensed },
    exhaustedFallback: () => MISSING_REVIEW,
  }),
};
```

`@/finish/review-json` is a nested barrel (Task 1), an exact-match specifier allowed by `check:alias-internals`. Never import the `@/finish` barrel from `src/operations` (cycle). `@/finish/types` is a type-only leaf import, which is allowed.

`src/operations/finish-branch-review.ts` is the same with: `FinishBranchReviewInput` (fields listed in Interfaces), `name: "finish-branch-review"`, `session: { role: "finish-review-quality", lifetime: "fresh" }`, `build` calls `buildFinishBranchReviewPrompt(input)`, every `"spec"` lens argument becomes `"quality"`, `reviewerKind: "finish-branch-review"`, same `tools`. Write it out in full.

Add to `src/operations/index.ts` next to the finish ops:

```ts
export type { FinishSpecReviewInput } from "./finish-spec-review";
export { finishSpecReviewOp } from "./finish-spec-review";
export type { FinishBranchReviewInput } from "./finish-branch-review";
export { finishBranchReviewOp } from "./finish-branch-review";
```

If `scripts/check-op-tool-capability.ts` lists ops or roles and fails on the new ops, add them with the same entry shape `finishReviewOp` has.

- [ ] **Step 4: Run tests to verify they pass**

Run: `timeout 30 bun test test/unit/operations/finish-spec-review.test.ts test/unit/operations/finish-branch-review.test.ts --timeout=5000`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/operations/finish-spec-review.ts src/operations/finish-branch-review.ts src/operations/index.ts test/unit/operations/finish-spec-review.test.ts test/unit/operations/finish-branch-review.test.ts
git commit -m "feat(finish): A4 spec and branch review ops (JSON, read-only)"
```

### Task 5: Merge, dedupe, contradiction flagging

**Files:**
- Create: `src/finish/merge-findings.ts`
- Modify: `src/finish/index.ts`
- Test: `test/unit/finish/merge-findings.test.ts`

**Interfaces:**
- Consumes: `Finding` (Task 1).
- Produces:
  - `export interface Contradiction { spec: Finding; quality: Finding }`
  - `export interface MergedFindings { toFix: Finding[]; judged: Finding[]; contradictions: Contradiction[] }`
  - `export function mergeFindings(spec: Finding[], quality: Finding[]): MergedFindings`
  - Rules (spec §5 steps 2-3): duplicates = same `file` (both absent counts as same), same `line` (both absent counts as same), same case-folded trimmed `title` → keep one, higher severity wins, its `source` is the kept finding's. Judgment findings go to `judged` (after dedupe). A non-judgment spec finding and a non-judgment quality finding with the same defined `file` and the same `line` (both absent counts as same) form a `Contradiction` and leave `toFix`. Findings without `file` are never contradictions. Each finding is in at most one contradiction (first match wins, spec order). `toFix` is ordered spec-source first, then quality.

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/finish/merge-findings.test.ts
import { describe, expect, test } from "bun:test";
import { mergeFindings } from "@/finish/merge-findings";
import type { Finding } from "@/finish/types";

const f = (o: Partial<Finding>): Finding => ({ severity: "LOW", title: "t", problem: "p", fix: "x", ...o });

describe("mergeFindings", () => {
  test("collapses exact duplicates across lenses, keeping the higher severity", () => {
    const out = mergeFindings(
      [f({ title: "Leak", file: "a.ts", line: 3, severity: "LOW", source: "spec" })],
      [f({ title: " leak ", file: "a.ts", line: 3, severity: "HIGH", source: "quality" })],
    );
    expect(out.toFix).toHaveLength(1);
    expect(out.toFix[0]?.severity).toBe("HIGH");
    expect(out.contradictions).toEqual([]);
  });

  test("same file and line, different titles, different lenses = contradiction, not fixed", () => {
    const s = f({ title: "Must retry", file: "a.ts", line: 9, source: "spec" });
    const q = f({ title: "Retry loop is bad design", file: "a.ts", line: 9, source: "quality" });
    const out = mergeFindings([s], [q]);
    expect(out.toFix).toEqual([]);
    expect(out.contradictions).toEqual([{ spec: s, quality: q }]);
  });

  test("findings without a file are never contradictions", () => {
    const out = mergeFindings([f({ title: "A", source: "spec" })], [f({ title: "B", source: "quality" })]);
    expect(out.contradictions).toEqual([]);
    expect(out.toFix.map((x) => x.title)).toEqual(["A", "B"]);
  });

  test("judgment findings are routed to judged, never to toFix or contradictions", () => {
    const j = f({ title: "J", file: "a.ts", line: 1, judgment: true, source: "spec" });
    const q = f({ title: "Q", file: "a.ts", line: 1, source: "quality" });
    const out = mergeFindings([j], [q]);
    expect(out.judged).toEqual([j]);
    expect(out.toFix).toEqual([q]);
    expect(out.contradictions).toEqual([]);
  });

  test("toFix is spec first, then quality", () => {
    const out = mergeFindings(
      [f({ title: "S", file: "s.ts", source: "spec" })],
      [f({ title: "Q", file: "q.ts", source: "quality" })],
    );
    expect(out.toFix.map((x) => x.source)).toEqual(["spec", "quality"]);
  });

  test("one spec finding pairs with at most one quality finding", () => {
    const s = f({ title: "S", file: "a.ts", line: 2, source: "spec" });
    const q1 = f({ title: "Q1", file: "a.ts", line: 2, source: "quality" });
    const q2 = f({ title: "Q2", file: "a.ts", line: 2, source: "quality" });
    const out = mergeFindings([s], [q1, q2]);
    expect(out.contradictions).toEqual([{ spec: s, quality: q1 }]);
    expect(out.toFix).toEqual([q2]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `timeout 30 bun test test/unit/finish/merge-findings.test.ts --timeout=5000`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/finish/merge-findings.ts
/**
 * A4 review-round merge (spec §5 steps 2-3): dedupe across both lenses, split
 * out judgment findings, and flag possible spec-vs-quality contradictions so
 * the fixer is never handed two opposing changes. Pure.
 */
import type { Finding, Severity } from "./types";

export interface Contradiction {
  spec: Finding;
  quality: Finding;
}

export interface MergedFindings {
  toFix: Finding[];
  judged: Finding[];
  contradictions: Contradiction[];
}

const RANK: Record<Severity, number> = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 };

const locKey = (f: Finding): string => `${f.file ?? ""}\u0000${f.line ?? ""}`;
const dupKey = (f: Finding): string => `${locKey(f)}\u0000${f.title.trim().toLowerCase()}`;

function dedupe(all: Finding[]): Finding[] {
  const kept = new Map<string, Finding>();
  for (const f of all) {
    const prev = kept.get(dupKey(f));
    if (!prev || RANK[f.severity] > RANK[prev.severity]) kept.set(dupKey(f), f);
  }
  return [...kept.values()];
}

function pairContradictions(spec: Finding[], quality: Finding[]): { pairs: Contradiction[]; used: Set<Finding> } {
  const used = new Set<Finding>();
  const pairs: Contradiction[] = [];
  for (const s of spec) {
    if (!s.file) continue;
    const q = quality.find((x) => x.file && !used.has(x) && locKey(x) === locKey(s));
    if (!q) continue;
    used.add(s);
    used.add(q);
    pairs.push({ spec: s, quality: q });
  }
  return { pairs, used };
}

export function mergeFindings(spec: Finding[], quality: Finding[]): MergedFindings {
  const unique = dedupe([...spec, ...quality]);
  const judged = unique.filter((f) => f.judgment);
  const plain = unique.filter((f) => !f.judgment);
  const plainSpec = plain.filter((f) => f.source === "spec");
  const plainQuality = plain.filter((f) => f.source !== "spec");
  const { pairs, used } = pairContradictions(plainSpec, plainQuality);
  const toFix = [...plainSpec, ...plainQuality].filter((f) => !used.has(f));
  return { toFix, judged, contradictions: pairs };
}
```

Export from `src/finish/index.ts`:

```ts
export type { Contradiction, MergedFindings } from "./merge-findings";
export { mergeFindings } from "./merge-findings";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `timeout 30 bun test test/unit/finish/merge-findings.test.ts --timeout=5000`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/finish/merge-findings.ts src/finish/index.ts test/unit/finish/merge-findings.test.ts
git commit -m "feat(finish): A4 merge review findings and flag spec/quality contradictions"
```

### Task 6: Concurrent review round

**Files:**
- Create: `src/finish/review-round.ts`
- Modify: `src/finish/index.ts`
- Test: `test/unit/finish/review-round.test.ts`

**Interfaces:**
- Consumes: `FinishReviewOutput`, `MISSING_REVIEW` (Task 1).
- Produces:
  - `export interface ReviewRoundResult { spec: FinishReviewOutput; quality: FinishReviewOutput; missing: ReviewLens[] }`
  - `export async function runReviewRound(run: { spec: () => Promise<FinishReviewOutput>; quality: () => Promise<FinishReviewOutput> }): Promise<ReviewRoundResult>`
  - A rejected or `missing` lens becomes `MISSING_REVIEW` and is listed in `missing`; the other lens is unaffected.

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/finish/review-round.test.ts
import { describe, expect, test } from "bun:test";
import { runReviewRound } from "@/finish/review-round";
import type { FinishReviewOutput } from "@/finish/types";

const ok = (title: string): FinishReviewOutput => ({
  findings: [{ severity: "LOW", title, problem: "p", fix: "f" }],
  covered: [],
});

describe("runReviewRound", () => {
  test("runs both lenses concurrently", async () => {
    const order: string[] = [];
    let releaseSpec: () => void = () => {};
    const specGate = new Promise<void>((r) => {
      releaseSpec = r;
    });
    const result = runReviewRound({
      spec: async () => {
        order.push("spec:start");
        await specGate;
        order.push("spec:end");
        return ok("s");
      },
      quality: async () => {
        order.push("quality:start");
        releaseSpec();
        return ok("q");
      },
    });
    await result;
    expect(order.slice(0, 2).sort()).toEqual(["quality:start", "spec:start"]);
  });

  test("a throwing lens is missing and does not cancel the other", async () => {
    const out = await runReviewRound({
      spec: async () => {
        throw new Error("timeout");
      },
      quality: async () => ok("q"),
    });
    expect(out.missing).toEqual(["spec"]);
    expect(out.spec).toEqual({ findings: [], covered: [], missing: true });
    expect(out.quality.findings[0]?.title).toBe("q");
  });

  test("a lens that returned missing is listed as missing", async () => {
    const out = await runReviewRound({
      spec: async () => ({ findings: [], covered: [], missing: true }),
      quality: async () => ok("q"),
    });
    expect(out.missing).toEqual(["spec"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `timeout 30 bun test test/unit/finish/review-round.test.ts --timeout=5000`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/finish/review-round.ts
/**
 * A4: one review round, both lenses in parallel (spec §4.5). `allSettled`, so
 * one lens timing out or throwing never cancels the other; either failure
 * reads as a missing verdict for that lens.
 */
import { getSafeLogger } from "@/logger";
import { MISSING_REVIEW } from "./review-json";
import type { FinishReviewOutput, ReviewLens } from "./types";

export interface ReviewRoundResult {
  spec: FinishReviewOutput;
  quality: FinishReviewOutput;
  missing: ReviewLens[];
}

function settle(lens: ReviewLens, r: PromiseSettledResult<FinishReviewOutput>): FinishReviewOutput {
  if (r.status === "fulfilled") return r.value;
  getSafeLogger()?.warn("finish", "Finish review lens failed", { storyId: "_run", lens, error: String(r.reason) });
  return MISSING_REVIEW;
}

export async function runReviewRound(run: {
  spec: () => Promise<FinishReviewOutput>;
  quality: () => Promise<FinishReviewOutput>;
}): Promise<ReviewRoundResult> {
  const [s, q] = await Promise.allSettled([run.spec(), run.quality()]);
  const spec = settle("spec", s);
  const quality = settle("quality", q);
  const missing: ReviewLens[] = [];
  if (spec.missing) missing.push("spec");
  if (quality.missing) missing.push("quality");
  return { spec, quality, missing };
}
```

Export from `src/finish/index.ts`:

```ts
export type { ReviewRoundResult } from "./review-round";
export { runReviewRound } from "./review-round";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `timeout 30 bun test test/unit/finish/review-round.test.ts --timeout=5000`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/finish/review-round.ts src/finish/index.ts test/unit/finish/review-round.test.ts
git commit -m "feat(finish): A4 run both review lenses concurrently"
```

### Task 7: PR 1 gate, review, push

- [ ] **Step 1: Full gates**

Run from the repo root: `bun run check:all && bun run typecheck`; then from `packages/nax`: `bun run test`.
Expected: all green. Fix any ratchet (file-size, complexity, test escape hatches, coverage-per-file, api, op-tool-capability) at the site; never `--update-baseline` on a count that grew. New files must meet the 80% per-file coverage floor — run `bun run test:coverage` and add tests if a new file is below it.

- [ ] **Step 2: Code review before push**

Dispatch one read-only reviewer (sonnet) over `git diff origin/main...HEAD` with the spec §4-§5 and this plan's Tasks 1-6. Apply CRITICAL/HIGH findings, at most 2 fix rounds.

- [ ] **Step 3: Push and open PR 1**

```bash
git status -sb   # confirm branch feat/a4-finish-rebuild, not detached
git push -u origin feat/a4-finish-rebuild
gh pr create --title "feat(finish): A4 branch review ops (inert)" --body "<summary: Tasks 1-6, nothing wired; spec link; test plan>"
```

Do not merge without maintainer approval.

---

# PR 2 — Finish rebuild

Branch: `feat/a4-finish-rebuild-2`, created from PR 1's head (rebase onto `main` once PR 1 merges).

### Task 8: State, phases, statuses, round outcomes

**Files:**
- Modify: `src/finish/types.ts`, `src/finish/state.ts`, `src/finish/index.ts`
- Test: `test/unit/finish/state.test.ts` (extend)

**Interfaces:**
- Produces:
  - `FinishPhase = "acceptance" | "spec" | "quality" | "review" | "gate"` (`review` = the shared fix round)
  - `FinishPhaseState` loses `incompleteAttempts`, `reviewGaps`, `reviewSince`; keeps `fixAttempts`, `reviewAttempts`, `rounds`, `adviseRounds?`, `lastOutcome?`
  - `export interface ReviewLoopState { rounds: number; lastFindings: Finding[]; missingLenses: ReviewLens[]; unresolved: Finding[]; reReviewUsed: boolean; committedFixes: boolean; reviewedHead?: string; title?: string; summary?: string; covered: Record<ReviewLens, string[]> }`
  - `FinishState.version: 2`; `FinishState.review: ReviewLoopState`; `FinishState.unreviewedFixCommits: string[]`; `FinishState.acceptanceFact?: AcceptanceFact`; `FinishState.gateFacts?: GateFact[]`; `escalationReason` removed; new `reason?: string`
  - `export type AcceptanceFact = "green" | "red" | "unverified" | "not-configured"`
  - `export interface GateFact { name: string; status: "green" | "red"; excerpt?: string }`
  - `FinishStatus` / `FinishResult.status`: `"running" | "opened" | "promoted" | "already-ready" | "draft" | "local-only" | "failed" | "nothing-to-finish"` (state adds `running`; result omits it)
  - `FinishResult` gains `outcome?: "ready" | "draft" | "local-only" | "failed"`, `reason?: string`, `facts?: ResolutionFacts` (type defined in Task 10 — declare it in `types.ts` here so `types.ts` stays the type home), `acceptedResidue?: Finding[]`; loses `escalationReason`; keeps `findings?` (now: open findings on a draft)
  - `ResolutionFacts` (declared here, computed in Task 10): `{ findingsOpen: Finding[]; acceptance: AcceptanceFact; gates: GateFact[]; reviewsMissing: ReviewLens[]; unreviewedFixCommits: string[]; coverage: Record<ReviewLens, number | null>; fixRounds: number }`
  - `FinishRoundOutcome`: remove `"incomplete"` and `"escalated"`... **keep both members** for reading old audit trails (doc comment: "read-only history, no longer emitted"), and add `"missing"` (a lens without a verdict)
- `deserializeFinishState` accepts only `version === 2`.

- [ ] **Step 1: Write the failing test**

Add to `test/unit/finish/state.test.ts`:

```ts
describe("A4 finish state", () => {
  test("createFinishState is version 2 with a zeroed review loop and five phases", () => {
    const s = createFinishState({
      feature: "f",
      workdir: "/r",
      branch: "b",
      runId: "r1",
      base: "origin/main",
      specPath: "s.md",
    });
    expect(s.version).toBe(2);
    expect(Object.keys(s.phases).sort()).toEqual(["acceptance", "gate", "quality", "review", "spec"]);
    expect(s.review).toEqual({
      rounds: 0,
      lastFindings: [],
      missingLenses: [],
      unresolved: [],
      reReviewUsed: false,
      committedFixes: false,
      covered: { spec: [], quality: [] },
    });
    expect(s.unreviewedFixCommits).toEqual([]);
  });

  test("a version 1 state is rejected", () => {
    expect(() => deserializeFinishState('{"version":1}')).toThrow("unsupported version");
  });
});
```

Update the existing state tests that assert `version: 1` or `incompleteAttempts` to the new shape.

- [ ] **Step 2: Run test to verify it fails**

Run: `timeout 30 bun test test/unit/finish/state.test.ts --timeout=5000`
Expected: FAIL.

- [ ] **Step 3: Implement**

Apply the type changes listed in Interfaces to `types.ts` and `state.ts`:

```ts
// state.ts (relevant parts)
const FINISH_PHASES: readonly FinishPhase[] = ["acceptance", "spec", "quality", "review", "gate"];

export interface ReviewLoopState {
  /** Review rounds run this finish (both lenses = one round). Capped by MAX_REVIEW_ROUNDS. */
  rounds: number;
  /** Merged findings from the last round, before judgment. */
  lastFindings: Finding[];
  /** Lenses with no verdict in the last round. */
  missingLenses: ReviewLens[];
  /** Judged findings carried to resolution unfixed (hold, advisor off, fallback). */
  unresolved: Finding[];
  reReviewUsed: boolean;
  /** True once a review fix round committed. Triggers the acceptance re-check. */
  committedFixes: boolean;
  /** HEAD the last completed review round saw. */
  reviewedHead?: string;
  /** Branch reviewer's last title / summary for the PR. */
  title?: string;
  summary?: string;
  covered: Record<ReviewLens, string[]>;
}

function zeroedPhaseState(): FinishPhaseState {
  return { fixAttempts: 0, reviewAttempts: 0, rounds: 0 };
}

function zeroedReview(): ReviewLoopState {
  return {
    rounds: 0,
    lastFindings: [],
    missingLenses: [],
    unresolved: [],
    reReviewUsed: false,
    committedFixes: false,
    covered: { spec: [], quality: [] },
  };
}
```

`createFinishState` returns `version: 2`, `review: zeroedReview()`, `unreviewedFixCommits: []`, and no `escalationReason`. `deserializeFinishState` checks `version !== 2`.

Then run `bun run typecheck` and fix every compile error in `src/finish/` caused by the removed fields **only by deleting the dead reads** where the code will be deleted in Task 15 anyway (`review/`, `route.ts routeReview`, `machine.ts` review loop). Where a file is rewritten later in this PR (`machine.ts`, `advise.ts`, `ops-impl.ts`), it is acceptable for this task's commit to leave typecheck red **only if** the next tasks are committed before any push; record the red files in the commit body. Prefer keeping the tree compiling by doing Tasks 8-13 before the first `bun run typecheck` gate.

- [ ] **Step 4: Run test to verify it passes**

Run: `timeout 30 bun test test/unit/finish/state.test.ts --timeout=5000`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/finish/types.ts src/finish/state.ts src/finish/index.ts test/unit/finish/state.test.ts
git commit -m "refactor(finish): A4 state v2 — review loop record, draft/failed statuses"
```

### Task 9: Move the fix stack out of `review/`

**Files:**
- Create: `src/finish/fix/dispositions.ts`, `src/finish/fix/index.ts`
- Modify: `src/operations/finish-fix.ts`
- Test: move `parseDispositions` / `validateDispositions` tests from `test/unit/finish/review-parse.test.ts` and `review-audit-gaps.test.ts` into `test/unit/finish/fix/dispositions.test.ts`; extend `test/unit/operations/finish-fix.test.ts`

**Interfaces:**
- Produces: `parseDispositions(text): FindingDisposition[]`, `validateDispositions(workdir, dispositions): Promise<FindingDisposition[]>` from `@/finish/fix` (nested barrel), unchanged behaviour.
- `FinishFixInput.phase` becomes `"acceptance" | "gate" | "review"`.

- [ ] **Step 1: Move the tests first**

Create `test/unit/finish/fix/dispositions.test.ts` by moving (not copying) every `parseDispositions` and `validateDispositions` test case from the two old files, changing only the import to `import { parseDispositions, validateDispositions } from "@/finish/fix";`. Add one case to `test/unit/operations/finish-fix.test.ts`:

```ts
test("review phase prompt groups findings by source", () => {
  const built = finishFixOp.build(
    {
      phase: "review",
      workdir: "/r",
      findings: [
        { severity: "LOW", title: "S", problem: "p", fix: "f", source: "spec" },
        { severity: "LOW", title: "Q", problem: "p", fix: "f", source: "quality" },
      ],
    },
    ctx, // the ctx helper this test file already uses
  );
  expect(built.task.content).toContain("## Spec findings");
  expect(built.task.content).toContain("## Quality findings");
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `timeout 30 bun test test/unit/finish/fix/ test/unit/operations/finish-fix.test.ts --timeout=5000`
Expected: FAIL — `@/finish/fix` not found; review phase not accepted.

- [ ] **Step 3: Implement**

Move the `DISPOSITION` and `EVIDENCE` regexes and `parseDispositions` from `src/finish/review/parse.ts:57-58,173-186` and `validateDispositions` (with its `exists` helper) from `src/finish/review/audit-gaps.ts:169-180` into `src/finish/fix/dispositions.ts` verbatim. `src/finish/fix/index.ts`:

```ts
export { parseDispositions, validateDispositions } from "./dispositions";
```

In `src/operations/finish-fix.ts`: import `{ parseDispositions, validateDispositions }` from `"@/finish/fix"` and `{ buildFinishFixPrompt }` from `"@/prompts"`; `FinishFixInput.phase: "acceptance" | "gate" | "review"`; `build` calls `buildFinishFixPrompt(input.phase, { findings: input.findings, gateOutput: input.gateOutput, acceptanceOutput: input.acceptanceOutput })`. Update the module doc comment ("drives the acceptance, gate and review fix phases"). Leave the old functions in `review/` in place until Task 15 deletes the directory.

- [ ] **Step 4: Run to verify they pass**

Run: `timeout 30 bun test test/unit/finish/fix/ test/unit/operations/finish-fix.test.ts --timeout=5000`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/finish/fix src/operations/finish-fix.ts test/unit/finish/fix test/unit/operations/finish-fix.test.ts test/unit/finish/review-parse.test.ts test/unit/finish/review-audit-gaps.test.ts
git commit -m "refactor(finish): A4 move fix dispositions and fix prompt out of review/"
```

### Task 10: Resolution facts and decision

**Files:**
- Create: `src/finish/resolve.ts`
- Modify: `src/finish/index.ts`
- Test: `test/unit/finish/resolve.test.ts`

**Interfaces:**
- Consumes: `ResolutionFacts`, `AcceptanceFact`, `GateFact`, `ReviewLoopState` (Task 8).
- Produces:
  - `export function computeFacts(args: { review: ReviewLoopState; acceptance: AcceptanceFact; gates: GateFact[]; unreviewedFixCommits: string[]; changed: string[] }): ResolutionFacts` — `findingsOpen = [...review.lastFindings, ...review.unresolved]` deduped by object identity; `coverage[lens] = changed.length === 0 ? null : |covered ∩ changed| / changed.length`.
  - `export function isClean(f: ResolutionFacts): boolean` — no open findings, acceptance `green` or `not-configured`, every gate green, no missing lens, no unreviewed fix commits.
  - `export function approvalFacts(f: ResolutionFacts, reReviewUsed: boolean): { allPhasesComplete: boolean; gatesGreen: boolean; reReviewUsed: boolean }` — `allPhasesComplete = reviewsMissing.length === 0`; `gatesGreen = (acceptance green|not-configured) && every gate green`.
  - `export type Resolution = { outcome: "ready"; acceptedResidue: Finding[] } | { outcome: "draft"; reason: string } | { outcome: "re-review" }`
  - `export function draftReason(f: ResolutionFacts): string` — one line listing what is unresolved, e.g. `"2 open finding(s); acceptance red; spec review missing"`.
  - `export async function resolve(args: { facts: ResolutionFacts; advise?: { approval: (facts: ResolutionFacts, approval: ReturnType<typeof approvalFacts>) => Promise<{ action: "approve" | "re-review" | "hold" | "unavailable"; rationale: string }> }; reReviewUsed: boolean }): Promise<Resolution>`
    - clean → `{ outcome: "ready", acceptedResidue: [] }` without calling the advisor
    - no advisor → `{ outcome: "draft", reason: draftReason(facts) }`
    - `approve` → `{ outcome: "ready", acceptedResidue: facts.findingsOpen }`
    - `re-review` and `!reReviewUsed` → `{ outcome: "re-review" }`
    - anything else (hold, unavailable, re-review already used) → `{ outcome: "draft", reason: "advisor: <rationale>; " + draftReason(facts) }`

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/finish/resolve.test.ts
import { describe, expect, test } from "bun:test";
import { approvalFacts, computeFacts, draftReason, isClean, resolve } from "@/finish/resolve";
import type { ResolutionFacts } from "@/finish/types";
import { createFinishState } from "@/finish";

const review = () =>
  createFinishState({ feature: "f", workdir: "/r", branch: "b", runId: "r", base: "m", specPath: "s" }).review;
const finding = { severity: "HIGH" as const, title: "t", problem: "p", fix: "f" };

function facts(over: Partial<ResolutionFacts> = {}): ResolutionFacts {
  return {
    findingsOpen: [],
    acceptance: "green",
    gates: [{ name: "lint", status: "green" }],
    reviewsMissing: [],
    unreviewedFixCommits: [],
    coverage: { spec: 1, quality: 1 },
    fixRounds: 1,
    ...over,
  };
}

describe("computeFacts", () => {
  test("coverage is covered∩changed over changed, null when nothing changed", () => {
    const r = { ...review(), covered: { spec: ["a.ts", "z.ts"], quality: [] } };
    const f = computeFacts({ review: r, acceptance: "green", gates: [], unreviewedFixCommits: [], changed: ["a.ts", "b.ts"] });
    expect(f.coverage).toEqual({ spec: 0.5, quality: 0 });
    expect(computeFacts({ review: r, acceptance: "green", gates: [], unreviewedFixCommits: [], changed: [] }).coverage).toEqual({
      spec: null,
      quality: null,
    });
  });

  test("open findings include unresolved judged findings", () => {
    const r = { ...review(), lastFindings: [finding], unresolved: [{ ...finding, title: "j", judgment: true }] };
    expect(computeFacts({ review: r, acceptance: "green", gates: [], unreviewedFixCommits: [], changed: [] }).findingsOpen).toHaveLength(2);
  });
});

describe("isClean / approvalFacts / draftReason", () => {
  test.each([
    ["clean", facts(), true],
    ["open finding", facts({ findingsOpen: [finding] }), false],
    ["acceptance red", facts({ acceptance: "red" }), false],
    ["acceptance unverified", facts({ acceptance: "unverified" }), false],
    ["acceptance not configured", facts({ acceptance: "not-configured" }), true],
    ["gate red", facts({ gates: [{ name: "lint", status: "red" }] }), false],
    ["lens missing", facts({ reviewsMissing: ["spec"] }), false],
    ["unreviewed fix commit", facts({ unreviewedFixCommits: ["abc"] }), false],
  ])("%s", (_name, f, clean) => {
    expect(isClean(f)).toBe(clean);
  });

  test("approvalFacts maps missing lenses and gates", () => {
    expect(approvalFacts(facts({ reviewsMissing: ["quality"] }), false)).toEqual({
      allPhasesComplete: false,
      gatesGreen: true,
      reReviewUsed: false,
    });
    expect(approvalFacts(facts({ acceptance: "unverified" }), true).gatesGreen).toBe(false);
  });

  test("draftReason lists every unresolved item", () => {
    expect(
      draftReason(
        facts({
          findingsOpen: [finding, finding],
          acceptance: "red",
          gates: [{ name: "lint", status: "red" }],
          reviewsMissing: ["spec"],
          unreviewedFixCommits: ["abc"],
        }),
      ),
    ).toBe("2 open finding(s); acceptance red; gates red: lint; spec review missing; 1 unreviewed fix commit(s)");
  });
});

describe("resolve", () => {
  const approve = (action: "approve" | "re-review" | "hold" | "unavailable") => ({
    approval: async () => ({ action, rationale: "why" }),
  });

  test("clean is ready without asking the advisor", async () => {
    let asked = false;
    const out = await resolve({
      facts: facts(),
      advise: { approval: async () => ((asked = true), { action: "hold", rationale: "" }) },
      reReviewUsed: false,
    });
    expect(out).toEqual({ outcome: "ready", acceptedResidue: [] });
    expect(asked).toBe(false);
  });

  test("not clean without an advisor is draft", async () => {
    expect(await resolve({ facts: facts({ acceptance: "red" }), reReviewUsed: false })).toEqual({
      outcome: "draft",
      reason: "acceptance red",
    });
  });

  test("approve with open findings is ready with residue", async () => {
    const out = await resolve({ facts: facts({ findingsOpen: [finding] }), advise: approve("approve"), reReviewUsed: false });
    expect(out).toEqual({ outcome: "ready", acceptedResidue: [finding] });
  });

  test("re-review once, then draft", async () => {
    const f = facts({ findingsOpen: [finding] });
    expect(await resolve({ facts: f, advise: approve("re-review"), reReviewUsed: false })).toEqual({ outcome: "re-review" });
    expect((await resolve({ facts: f, advise: approve("re-review"), reReviewUsed: true })).outcome).toBe("draft");
  });

  test.each(["hold", "unavailable"] as const)("%s is draft with the advisor rationale", async (action) => {
    const out = await resolve({ facts: facts({ findingsOpen: [finding] }), advise: approve(action), reReviewUsed: false });
    expect(out).toEqual({ outcome: "draft", reason: "advisor: why; 1 open finding(s)" });
  });
});
```

The `asked = true` comma expression may trip biome (`noCommaOperator`); if so, write the stub as a block body `async () => { asked = true; return { action: "hold" as const, rationale: "" }; }`.

- [ ] **Step 2: Run test to verify it fails**

Run: `timeout 30 bun test test/unit/finish/resolve.test.ts --timeout=5000`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/finish/resolve.ts
/**
 * A4 resolution (spec §6): the end-of-finish facts, computed in code, and the
 * ready/draft decision. Replaces every escalation exit — nothing here stops
 * the run. Pure apart from the injected advisor call.
 */
import type { AcceptanceFact, Finding, GateFact, ResolutionFacts, ReviewLens } from "./types";
import type { ReviewLoopState } from "./state";

const LENSES: readonly ReviewLens[] = ["spec", "quality"];

function coverageOf(covered: string[], changed: string[]): number | null {
  if (changed.length === 0) return null;
  const read = new Set(covered);
  return changed.filter((f) => read.has(f)).length / changed.length;
}

export function computeFacts(args: {
  review: ReviewLoopState;
  acceptance: AcceptanceFact;
  gates: GateFact[];
  unreviewedFixCommits: string[];
  changed: string[];
}): ResolutionFacts {
  const findingsOpen = [...new Set([...args.review.lastFindings, ...args.review.unresolved])];
  return {
    findingsOpen,
    acceptance: args.acceptance,
    gates: args.gates,
    reviewsMissing: [...args.review.missingLenses],
    unreviewedFixCommits: [...args.unreviewedFixCommits],
    coverage: {
      spec: coverageOf(args.review.covered.spec, args.changed),
      quality: coverageOf(args.review.covered.quality, args.changed),
    },
    fixRounds: args.review.rounds,
  };
}

const acceptanceOk = (a: AcceptanceFact): boolean => a === "green" || a === "not-configured";
const gatesGreen = (f: ResolutionFacts): boolean => acceptanceOk(f.acceptance) && f.gates.every((g) => g.status === "green");

export function isClean(f: ResolutionFacts): boolean {
  return (
    f.findingsOpen.length === 0 && gatesGreen(f) && f.reviewsMissing.length === 0 && f.unreviewedFixCommits.length === 0
  );
}

export function approvalFacts(f: ResolutionFacts, reReviewUsed: boolean) {
  return { allPhasesComplete: f.reviewsMissing.length === 0, gatesGreen: gatesGreen(f), reReviewUsed };
}

export function draftReason(f: ResolutionFacts): string {
  const parts: string[] = [];
  if (f.findingsOpen.length > 0) parts.push(`${f.findingsOpen.length} open finding(s)`);
  if (!acceptanceOk(f.acceptance)) parts.push(`acceptance ${f.acceptance}`);
  const red = f.gates.filter((g) => g.status === "red").map((g) => g.name);
  if (red.length > 0) parts.push(`gates red: ${red.join(", ")}`);
  for (const lens of LENSES) if (f.reviewsMissing.includes(lens)) parts.push(`${lens} review missing`);
  if (f.unreviewedFixCommits.length > 0) parts.push(`${f.unreviewedFixCommits.length} unreviewed fix commit(s)`);
  return parts.join("; ");
}

export type ApprovalAction = "approve" | "re-review" | "hold" | "unavailable";

export type Resolution =
  | { outcome: "ready"; acceptedResidue: Finding[] }
  | { outcome: "draft"; reason: string }
  | { outcome: "re-review" };

export async function resolve(args: {
  facts: ResolutionFacts;
  advise?: {
    approval: (
      facts: ResolutionFacts,
      approval: ReturnType<typeof approvalFacts>,
    ) => Promise<{ action: ApprovalAction; rationale: string }>;
  };
  reReviewUsed: boolean;
}): Promise<Resolution> {
  const { facts } = args;
  if (isClean(facts)) return { outcome: "ready", acceptedResidue: [] };
  if (!args.advise) return { outcome: "draft", reason: draftReason(facts) };
  const decision = await args.advise.approval(facts, approvalFacts(facts, args.reReviewUsed));
  if (decision.action === "approve") return { outcome: "ready", acceptedResidue: facts.findingsOpen };
  if (decision.action === "re-review" && !args.reReviewUsed) return { outcome: "re-review" };
  return { outcome: "draft", reason: `advisor: ${decision.rationale}; ${draftReason(facts)}` };
}
```

`approve` is only offered by the advisor menu when `gatesGreen` (Task 11 builds the menu from `approvalFacts`), so `approve` with red gates cannot happen; `resolve` does not re-check it.

Export from `src/finish/index.ts`:

```ts
export type { ApprovalAction, Resolution } from "./resolve";
export { approvalFacts, computeFacts, draftReason, isClean, resolve } from "./resolve";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `timeout 30 bun test test/unit/finish/resolve.test.ts --timeout=5000`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/finish/resolve.ts src/finish/index.ts test/unit/finish/resolve.test.ts
git commit -m "feat(finish): A4 resolution facts and ready/draft decision"
```

### Task 11: Advisor glue reshaped

**Files:**
- Modify: `src/finish/advise.ts`
- Test: rewrite `test/unit/finish/advise.test.ts`

**Interfaces:**
- Consumes: `Contradiction` (Task 5), `ResolutionFacts`, `approvalFacts`, `ApprovalAction` (Task 10).
- Produces (replacing `FinishAdvisor`, `applyJudgedAdvice`, `runApproval`, `JudgedOutcome`, `ApplyJudgedArgs`, `RunApprovalArgs`, `ApprovalFacts`):

```ts
export interface JudgedResult {
  toFix: Finding[];
  advice: AdviceRef[];
  /** Hold, advisor unavailable, or (advisor off) judged findings: carried to resolution unfixed. */
  unresolved: Finding[];
}

export interface FinishAdvisor {
  judgedEnabled: boolean;
  approvalEnabled: boolean;
  judged(findings: Finding[], contradictions: Contradiction[], state: FinishState): Promise<JudgedResult>;
  approval(facts: ResolutionFacts, approval: ReturnType<typeof approvalFacts>): Promise<{ action: ApprovalAction; rationale: string }>;
  commitLedger(state: FinishState): Promise<void>;
}

/** Advisor off or judged caller disabled: the deterministic fallback (spec §5 step 4). */
export function judgeWithoutAdvisor(findings: Finding[], contradictions: Contradiction[]): JudgedResult;
```

- Behaviour:
  - `judged`: for each judgment finding, the existing `judgeOne` logic, with `phase = finding.source ?? "quality"` for `dedupeKeyFor`. `waive` / `supersede` → dropped (ref recorded); `fix` → `toFix` (with the existing "Advisor ruling" suffix); `hold` or fallback → `unresolved` **and continue with the next finding** (no early return). For each contradiction: one `finish-judgment` question whose `summary` is `"Spec and quality reviews disagree on <file>:<line>"`, evidence = two `{ source: "finding" }` entries (`"Spec review: <title> — <problem>\nSuggested fix: <fix>"` and the same for quality), `dedupeKey = dedupeKeyFor("spec", contradiction.spec)`, `findingSeverity` = the higher of the two. Decision `fix` → spec finding to `toFix` with the ruling text; `waive` → both dropped; `supersede` → both dropped; `hold` / fallback → quality finding to `unresolved`, spec finding to `toFix` (same as advisor off).
  - `judgeWithoutAdvisor`: every judgment finding → `unresolved`; each contradiction → spec to `toFix`, quality to `unresolved`; no refs.
  - `approval`: builds the `finish-approval` question from facts. `summary`: `"Approve the PR for <feature>? <draftReason(facts)>"`. Evidence, each one `{ source: "review-round", text }`: open findings (`"[SEV] (source) title — file:line"` one per line, or `"none"`); `"Acceptance: <fact>"`; gates (`"<name>: <status>"` lines, red ones followed by the first 20 lines of `excerpt`); `"Missing reviews: <lenses or none>"`; `"Unreviewed fix commits: <shas or none>"`; `"Coverage: spec <pct|n/a>, quality <pct|n/a>"`. Options: `buildMenu({ kind: "finish-approval", ...approval, reReviewPhase: "quality" })` (menu unchanged). Maps the decision: `approve` / `re-review` / `hold` from `decision.action.type`; no decision → `{ action: "unavailable", rationale: fallbackReason ?? "no decision" }`; any other action type → `hold`.
  - `commitLedger` unchanged.
  - `buildFinishAdvisorForPhase` unchanged.

- [ ] **Step 1: Write the failing tests**

Rewrite `test/unit/finish/advise.test.ts`. Keep its existing advisor fake (whatever it uses to script `advisor.advise` / `recordReuse` decisions) and replace the cases with:

```ts
describe("createFinishAdvisor.judged (A4)", () => {
  test("hold on one finding does not stop the next: hold → unresolved, fix → toFix", async () => {
    // script two decisions: first "hold", second "fix" with instruction "do it"
    // judged([j1, j2], [], state) → unresolved [j1], toFix [j2 with "Advisor ruling" suffix], advice has 2 refs
  });
  test("waive and supersede drop the finding", async () => {});
  test("advisor unavailable → unresolved", async () => {});
  test("dedupe key uses the finding's source", async () => {
    // assert the question's dedupeKey === dedupeKeyFor("spec", f) for a spec-source finding
  });
  test("a contradiction is one question with both findings as evidence", async () => {
    // one advise call; evidence texts start with "Spec review:" and "Quality review:"
    // decision fix → toFix [spec finding]; unresolved []
  });
  test("contradiction on hold → spec to toFix, quality to unresolved", async () => {});
});

describe("judgeWithoutAdvisor", () => {
  test("judged findings are unresolved; contradictions resolve spec-first", () => {
    const s = { severity: "LOW" as const, title: "S", problem: "p", fix: "f", source: "spec" as const, file: "a.ts" };
    const q = { ...s, title: "Q", source: "quality" as const };
    const j = { ...s, title: "J", judgment: true };
    expect(judgeWithoutAdvisor([j], [{ spec: s, quality: q }])).toEqual({ toFix: [s], advice: [], unresolved: [j, q] });
  });
});

describe("createFinishAdvisor.approval (A4)", () => {
  test("question evidence lists open findings, acceptance, gates with excerpt, missing lenses, unreviewed commits, coverage", async () => {});
  test.each([
    ["approve", "approve"],
    ["re-review", "re-review"],
    ["hold", "hold"],
  ])("decision %s maps to %s", async () => {});
  test("no decision → unavailable with the fallback reason", async () => {});
});
```

Fill every empty test body with real arrange/act/assert code using the file's existing fake; do not leave comments in place of assertions. `judgeWithoutAdvisor`'s expected `unresolved` order is judged findings first, then contradiction quality findings.

- [ ] **Step 2: Run to verify they fail**

Run: `timeout 30 bun test test/unit/finish/advise.test.ts --timeout=5000`
Expected: FAIL.

- [ ] **Step 3: Implement**

Rewrite `src/finish/advise.ts` per the Interfaces block. Keep `judgmentQuestion`, `reusablePrior`, `judgeOne` (change its `phase` parameter to come from `f.source ?? "quality"`), `createFinishAdvisor`, `buildFinishAdvisorForPhase`. Delete `applyJudgedAdvice`, `runApproval`, `ApplyJudgedArgs`, `RunApprovalArgs`, `ApprovalFacts`, `JudgedOutcome`, `COMPLETE_OUTCOMES` and the `RoutedReview` / `FinishPhaseState` / `FinishResult` / `FinishRound` imports. Add:

```ts
function contradictionQuestion(deps: FinishAdvisorDeps, c: Contradiction): QuestionDraft {
  const where = `${c.spec.file}${c.spec.line ? `:${c.spec.line}` : ""}`;
  const line = (label: string, f: Finding) => `${label}: ${f.title} — ${f.problem}\nSuggested fix: ${f.fix}`;
  const sev = RANK[c.spec.severity] >= RANK[c.quality.severity] ? c.spec.severity : c.quality.severity;
  return {
    kind: "finish-judgment",
    feature: deps.feature,
    dedupeKey: dedupeKeyFor("spec", c.spec),
    summary: `Spec and quality reviews disagree on ${where}`,
    evidence: [
      { source: "finding", text: line("Spec review", c.spec) },
      { source: "finding", text: line("Quality review", c.quality) },
    ],
    options: buildMenu({ kind: "finish-judgment", acceptanceEnabledForStory: deps.acceptanceEnabled(), citesSpecSection: "spec" }),
    findingSeverity: sev,
  };
}
```

(`RANK` = `{ CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 }`, local constant.) Implement `judged` as a loop over findings then contradictions, each step ≤ 30 lines (split `judgeContradiction` out). Implement `approvalQuestion(deps, facts, approval)` with the evidence layout above (helper `approvalEvidence(facts): { source: "review-round"; text: string }[]`), and `approval` mapping the decision.

- [ ] **Step 4: Run to verify they pass**

Run: `timeout 30 bun test test/unit/finish/advise.test.ts --timeout=5000`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/finish/advise.ts test/unit/finish/advise.test.ts
git commit -m "refactor(finish): A4 advisor judges merged findings and approves from facts"
```

### Task 12: Ops, PR lifecycle, body, title

**Files:**
- Modify: `src/finish/ops.ts`, `src/finish/ops-impl.ts`, `src/finish/pr/open.ts`, `src/finish/pr/body.ts`, `src/finish/pr/context.ts`, `src/finish/pr/index.ts`, `src/finish/pr-title.ts`
- Test: rewrite `test/unit/finish/ops-impl.test.ts`; extend `pr-open.test.ts`, `pr-body.test.ts`, `pr-context.test.ts`, `pr-title.test.ts`

**Interfaces:**
- `FinishOps` becomes:

```ts
export interface ReviewInputs {
  changed: string[];
  stories: { id: string; title: string }[];
  hints: A3Hint[];
  prdPath: string;
}

export interface FinishOps {
  reviewSpec(state: FinishState, inputs: ReviewInputs): Promise<FinishReviewOutput>;
  reviewBranch(state: FinishState, inputs: ReviewInputs): Promise<FinishReviewOutput>;
  fix(phase: "acceptance" | "gate" | "review", req: FixRequest): Promise<FixOutcome>;
  openDraftPr(state: FinishState): Promise<{ url: string } | null>;
  /** Push, then promote (or open ready). */
  promotePr(state: FinishState): Promise<{ status: "opened" | "promoted" | "already-ready" | "local-only"; url?: string }>;
  /** Push, then keep the PR draft: update title/body, or create it as a draft. */
  finalizeDraftPr(state: FinishState): Promise<{ status: "draft" | "local-only"; url?: string }>;
}
```

  `narrate` and `escalate` are removed. `ReviewRequest` is removed.
- `openOrPromotePr(args & { keepDraft?: boolean }, deps)`: when `keepDraft` — if a PR exists (view succeeds): `updatePrBody` and return `{ status: "draft", url }` without the ready call, **even if the PR is already ready** (a ready PR is not demoted; record `status: "already-ready"` in that one case so the result does not lie); if none exists: create with `--draft` (`gh pr create … --draft` / `glab mr create … --draft`) and return `{ status: "draft", url }`. Return type widens to `"opened" | "promoted" | "already-ready" | "draft"`.
- `forgeKind === null` → `promotePr` and `finalizeDraftPr` push and return `{ status: "local-only" }`.
- `FinishPrContext` gains `unresolved?: { reason: string; findings: Finding[]; acceptance: AcceptanceFact; gates: GateFact[]; missing: ReviewLens[]; unreviewed: string[]; accepted: Finding[] }`, `coverage?: Record<ReviewLens, number | null>`; `narrative` comes from `state.review.summary` through `resolveNarrative` (moved, see below); `title` from `resolveTitle(state.review.title, feature)`.
- `resolveNarrative`, `readSpecSummary`, `NARRATIVE_MAX_CHARS` move from `operations/finish-narrative.ts` to `src/finish/pr/narrative.ts` (verbatim), imported by `pr/context.ts` instead of `@/operations`.
- `pr-title.ts`: delete `parseTitle` and the `<title>` sentinel constants; keep `sanitizeTitle` and `resolveTitle`.
- Body section order and keys per spec §7.3: `unresolved` (new, first), `narrative`, `stories`, `advisor`, `rounds` (heading "Review"), `verification`, `outOfScope`, `footer`. Check `pr-template-merge.ts` / `src/forge/template-merge.ts` default section aliases and add `unresolved` to any key list there.

- [ ] **Step 1: Write the failing tests**

`test/unit/finish/pr-open.test.ts` — add:

```ts
describe("openOrPromotePr keepDraft (A4)", () => {
  test.each(["github", "gitlab"] as const)("%s: existing draft is updated and left draft", async (forge) => {
    // stub deps.run: view → exit 0 with isDraft true; record every argv
    // expect no argv containing "ready"; expect an edit/update argv with the new title; status "draft"
  });
  test.each(["github", "gitlab"] as const)("%s: no PR → created with --draft", async (forge) => {
    // view → exit 1; create argv includes "--draft"; status "draft"
  });
  test("an already-ready PR is not demoted: body updated, status already-ready", async () => {});
});
```

`test/unit/finish/pr-body.test.ts` — add:

```ts
test("draft body puts Unresolved first with reason, findings, red gates, missing reviews, unreviewed commits", () => {});
test("ready body with accepted residue renders 'Accepted by the advisor'", () => {});
test("ready body without residue has no Unresolved section", () => {});
test("Review section shows rounds and coverage percentages", () => {});
```

`test/unit/finish/ops-impl.test.ts` — replace with cases for: `reviewSpec` calls `callOp` with `finishSpecReviewOp`, `sessionOverride.role === "finish-review-spec"`, input carries `prdPath`, `changedFiles`, `decisions`; `reviewBranch` with `finishBranchReviewOp`, role `finish-review-quality`, `hints`, `stories`; `fix("review", …)` passes findings; `promotePr` / `finalizeDraftPr` with `forgeKind: null` push and return `local-only`; `finalizeDraftPr` calls `openOrPromotePr` with `keepDraft: true`.

`test/unit/finish/pr-title.test.ts` — remove `parseTitle` cases; keep `sanitizeTitle` / `resolveTitle`.

Write every case in full using each file's existing stubs (`_finishOpsDeps.callOp`, the forge `deps.run` stub, `loadFinishPrContext` inputs). No comment-only bodies.

- [ ] **Step 2: Run to verify they fail**

Run: `timeout 60 bun test test/unit/finish/pr-open.test.ts test/unit/finish/pr-body.test.ts test/unit/finish/ops-impl.test.ts test/unit/finish/pr-title.test.ts test/unit/finish/pr-context.test.ts --timeout=5000`
Expected: FAIL.

- [ ] **Step 3: Implement**

1. `pr/narrative.ts`: move `NARRATIVE_MAX_CHARS`, `truncate`, `resolveNarrative`, `sectionBody`, `SUMMARY_HEADINGS`, `readSpecSummary` verbatim from `operations/finish-narrative.ts`; export from `pr/index.ts`.
2. `pr/open.ts`: add `keepDraft` as specified:

```ts
async function keepDraftPr(
  args: { workdir: string; branch: string; title: string; body: string; forge: ForgeKind },
  view: { exitCode: number; stdout: string },
  deps: ForgeDeps,
): Promise<{ status: "draft" | "already-ready"; url?: string }> {
  if (view.exitCode === 0) {
    const { isDraft, url } = parseView(view.stdout, args.forge);
    await updatePrBody(args, deps);
    return { status: isDraft ? "draft" : "already-ready", url };
  }
  const createCmd =
    args.forge === "github"
      ? ["gh", "pr", "create", "--draft", "--title", args.title, "--body", args.body, "--head", args.branch]
      : ["glab", "mr", "create", "--draft", "--title", args.title, "--description", args.body, "--source-branch", args.branch];
  const create = await deps.run(createCmd, { cwd: args.workdir });
  if (create.exitCode !== 0) {
    throw new NaxError(
      `Failed to create draft PR/MR for "${args.branch}": ${create.stderr.trim() || `exit ${create.exitCode}`}`,
      "FINISH_PR_CREATE_FAILED",
      { stage: "finish-pr", branch: args.branch },
    );
  }
  return { status: "draft", url: extractUrl(create.stdout) };
}
```

   and at the top of `openOrPromotePr`, after the view call: `if (args.keepDraft) return keepDraftPr(args, view, deps);`. Confirm the `glab mr create --draft` flag name against `src/forge/pr.ts` (which already builds a draft argv for `openPr`) and reuse that file's argv builder if one exists instead of the literal above.
3. `ops.ts`: replace the interface as specified; remove `ReviewRequest`, `escalate`, `narrate` and their docs.
4. `ops-impl.ts`: remove `review`, `escalate`, `narrate`, `ESCALATION_PUSH_MESSAGE`, the narrative/escalate imports and `FinishOpsDeps.narrative` / `models.narrative` / `timeouts.narrativeMs`; add:

```ts
async reviewSpec(state, inputs) {
  const input: FinishSpecReviewInput = {
    base: state.base,
    specPath: state.specPath,
    prdPath: inputs.prdPath,
    changedFiles: inputs.changed,
    decisions: await loadDecisionNotes(state, advisorOutputDir),
    model: models?.reviewSpec,
    timeoutMs: timeouts?.reviewMs,
  };
  return _finishOpsDeps.callOp({ ...callCtx, sessionOverride: { role: "finish-review-spec" } }, finishSpecReviewOp, input);
},
async reviewBranch(state, inputs) {
  const input: FinishBranchReviewInput = {
    base: state.base,
    stories: inputs.stories,
    changedFiles: inputs.changed,
    hints: inputs.hints,
    model: models?.reviewQuality,
    timeoutMs: timeouts?.reviewMs,
  };
  return _finishOpsDeps.callOp({ ...callCtx, sessionOverride: { role: "finish-review-quality" } }, finishBranchReviewOp, input);
},
async finalizeDraftPr(state) {
  const { committed } = await commitAndPush(state.workdir, state.branch, PROMOTE_MESSAGE(state.feature));
  if (committed) state.committedThisRun = true;
  if (forgeKind === null) return { status: "local-only" };
  const content = await buildPrContentOrFallback(state, audit, forgeKind, prBody, advisorOutputDir);
  const out = await openOrPromotePr(
    { workdir: state.workdir, branch: state.branch, title: content.title, body: content.body, forge: forgeKind, committedThisRun: true, keepDraft: true },
    forge,
  );
  // A PR a human already marked ready is not demoted; report that honestly.
  return { status: out.status === "already-ready" ? "already-ready" : "draft", url: out.url };
},
```

   Widen `finalizeDraftPr`'s return type in `ops.ts` to `{ status: "draft" | "already-ready" | "local-only"; url?: string }`. The result's `outcome` stays `"draft"` in that case (Task 13 sets `outcome` from the resolution, `status` from the forge). `promotePr` returns `{ status: "local-only" }` when `forgeKind === null` (was `already-ready`).
5. `pr/context.ts`: read `narrative` via `resolveNarrative(state.review.summary, await readSpecSummary(...))` and `title` via `resolveTitle(state.review.title, state.feature)`; add `unresolved` and `coverage` from new optional `LoadPrContextArgs` fields `resolution?: { outcome: "ready" | "draft"; reason?: string; facts: ResolutionFacts; acceptedResidue: Finding[] }` (set by the machine on `state` — add `resolution?` to `FinishState` in this task and read it from `state`).
6. `pr/body.ts`: add `buildUnresolvedSection(ctx)` (returns `null` when `ctx.unresolved` is absent or, on a ready PR, has no accepted residue), rename the `rounds` heading to `"Review"` and append coverage lines `- Coverage: spec 80%, quality n/a`; insert `{ key: "unresolved", heading: "Unresolved", body: … }` first.
7. `pr-title.ts`: delete `parseTitle`, `TITLE_OPEN_TAG`, `TITLE_CLOSE_TAG`.

- [ ] **Step 4: Run to verify they pass**

Run: the Step 2 command.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/finish/ops.ts src/finish/ops-impl.ts src/finish/pr src/finish/pr-title.ts src/finish/state.ts test/unit/finish/
git commit -m "feat(finish): A4 two review ops, keep-draft PR path, Unresolved PR section"
```

### Task 13: Review loop and machine rewrite

**Files:**
- Create: `src/finish/review-loop.ts`
- Modify: `src/finish/route.ts`, `src/finish/machine.ts`, `src/finish/index.ts`
- Test: create `test/unit/finish/review-loop.test.ts`; rewrite `machine-loops.test.ts`, `machine-invariants.test.ts`, `machine-advise.test.ts`, `machine-end-to-end.test.ts`; delete `route-advise.test.ts`, `review-window.test.ts`; trim `route.test.ts` to the acceptance/gate fact functions

**Interfaces:**
- `route.ts`:
  - delete `routeReview`, `ReviewRoute`, `RoutedReview`, `ReviewOutcome`, `MAX_INCOMPLETE_ATTEMPTS`, `MAX_ADVISE_ROUNDS` (moves to `review-loop.ts`).
  - `export const MAX_REVIEW_ROUNDS = 3;`
  - `export function acceptanceFact(result: AcceptanceGateResult, acceptanceStatus: string): AcceptanceFact` — `"disabled"` status or no groups → `not-configured`; passed with `missing.length > 0` or `ran === 0` → `unverified`; passed → `green`; else `red`.
  - `export function routeAcceptance(result, st): { route: "proceed" | "fix" | "stop"; fact: AcceptanceFact }` — `stop` replaces `escalate` (cap reached or unverified).
  - `routeQualityGates(result, st)`: `escalate` → `stop` with the same reasons; `green` / `fix` unchanged. `gateFacts(result): GateFact[]` — one entry per `ran` name: `failing.includes(name) ? red (excerpt = output) : green`; `ran.length === 0` → `[{ name: "quality.commands", status: "red", excerpt: "No quality.commands configured" }]`.
- `review-loop.ts`:

```ts
export const MAX_ADVISE_ROUNDS = 2;

export interface ReviewLoopDeps {
  ops: FinishOps;
  advise?: FinishAdvisor;
  inputs: ReviewInputs;
  audit: AuditTarget;
  now: () => string;
  assertNotAborted: () => void;
}

/** Runs review rounds until clean, nothing to fix, or MAX_REVIEW_ROUNDS. Mutates state.review. */
export async function runReviewLoop(state: FinishState, deps: ReviewLoopDeps, extraRounds?: number): Promise<void>;
```

  Per round (spec §5): `assertNotAborted`; `runReviewRound({ spec: () => ops.reviewSpec(state, inputs), quality: () => ops.reviewBranch(state, inputs) })`; record one round per lens (`phase: lens`, outcome `passed` (no findings) / `missing` / `fixed` is recorded only on the fix round); store `covered`, branch `title`/`summary` (only when present); `mergeFindings(spec.findings, quality.findings)`; judged = advisor `judged(...)` when `advise?.judgedEnabled` and `state.phases.review.adviseRounds < MAX_ADVISE_ROUNDS` (increment it), else `judgeWithoutAdvisor`; `state.review.unresolved` accumulates `unresolved` (dedupe by title+file); `fixList = [...merged.toFix, ...judged.toFix]` ordered spec-source first; `state.review.lastFindings = fixList`; `state.review.missingLenses = round.missing`; `state.review.rounds += 1`; `state.review.reviewedHead = await headSha(state.workdir)`; if `fixList` empty → stop; else `ops.fix("review", { state, findings: fixList })`, `commitFixes`, record a `review` round with `outcome: "fixed"` and advice refs, set `committedFixes`/`committedThisRun`; stop when both lenses returned no findings and none missing, or `rounds >= MAX_REVIEW_ROUNDS + (extraRounds ?? 0)`. After the last round with a fix, **the fixed findings are still `lastFindings`** — resolution must not report them as open. So: after a fix round that is the last round (cap hit), run no further review; `lastFindings` stays as "fixed but not re-reviewed" — mark the fix commit sha in `state.unreviewedFixCommits` instead and clear `lastFindings`. A fix session that throws: catch in `runReviewLoop`, log `warn`, count the round, leave `lastFindings` as open, continue to the next round.
- `machine.ts` (spec §3, §3.1):

```ts
export async function runFinishMachine(state: FinishState, deps: FinishMachineDeps): Promise<FinishResult> {
  const pre = await runPreconditions(state, deps);          // context "escalate" route → failed (no PR attempt)
  if (pre) return pre;
  try {
    await runAcceptanceLoop(state, deps);                    // sets state.acceptanceFact; never returns a result
    await maybeOpenDraftPr(state, deps);                     // unchanged
    const inputs = await loadReviewInputs(state, deps);      // changed files, stories, hints, prdPath
    await runReviewLoop(state, reviewDeps(deps, inputs));
    if (state.review.committedFixes) await runAcceptanceLoop(state, deps);  // re-check, remaining cap
    await runGatesLoop(state, deps, inputs);                 // sets state.gateFacts; gate fix commit → one more review round if rounds remain, else unreviewedFixCommits
    return await resolveAndFinalize(state, deps, inputs);    // computeFacts → resolve (re-review loops once) → promote | finalizeDraft
  } catch (err) {
    return await recoverAfterThrow(state, deps, err);        // §3.1 table
  }
}
```

  - `runPreconditions`: `already-finished` / `nothing-to-finish` unchanged; `escalate` → write `{ status: "failed", outcome: "failed", reason }` and return (no push, no forge).
  - `recoverAfterThrow(state, deps, err)`: if `deps.runSignal?.aborted` → `failed`, reason `aborted`, no PR call; else if `deps.signal?.aborted` (deadline) → finalize draft with reason `deadline`, using a fresh `AbortSignal.timeout(60_000)` for the forge calls (the ops read `callCtx.signal`; pass the fresh signal by building the draft through `deps.ops.finalizeDraftPr` with `state.reason = "deadline"` — the forge calls in `pr/open.ts` do not take a signal today, so no change is needed beyond not calling `assertNotAborted` on this path); else → finalize draft with reason `finish error: <message>`; if finalize itself throws → `failed` with the finalize error.
  - `resolveAndFinalize`: `facts = computeFacts({ review: state.review, acceptance: state.acceptanceFact ?? "not-configured", gates: state.gateFacts ?? [], unreviewedFixCommits: state.unreviewedFixCommits, changed: inputs.changed })`; `res = await resolve({ facts, advise: deps.advise?.approvalEnabled ? deps.advise : undefined, reReviewUsed: state.review.reReviewUsed })`; on `re-review`: set `reReviewUsed`, `runReviewLoop(state, …, 1)` (one extra round), acceptance re-check if it committed, `runGatesLoop`, then resolve again (the second resolve cannot return re-review); `state.resolution = { outcome, reason, facts, acceptedResidue }`; `ready` → `ops.promotePr`; `draft` → `ops.finalizeDraftPr`; `commitLedger` before finalizing when the advisor ran; write the result: `{ feature, status, outcome, reason?, facts, acceptedResidue?, findings: facts.findingsOpen (draft only), branch, headSha, url }`.
  - Remove `doEscalate`, `noteCommitWindow`, `routeReviewStep`, `fixAndRecord`, `finishTerminal`; `assertNotAborted` stays.
  - Each function ≤ 30 lines; split helpers as needed. `machine.ts` must stay under 600 lines.

- [ ] **Step 1: Write the failing tests**

`test/unit/finish/review-loop.test.ts` — with stub `FinishOps` (`reviewSpec`/`reviewBranch` returning scripted `FinishReviewOutput`s per round), `_finishGitDeps.git` stubbed for `headSha` / `commitFixes`, and an in-memory `AuditTarget` under `withTempDir`:

```ts
describe("runReviewLoop", () => {
  test("clean first round: no fix, rounds 1, lastFindings empty", async () => {});
  test("findings → one fix with spec-first order → clean second round", async () => {});
  test("cap: three rounds with findings → fix commit of round 3 lands in unreviewedFixCommits, lastFindings cleared", async () => {});
  test("one lens missing: other lens still fixed, missingLenses records it", async () => {});
  test("judged finding with advisor off → unresolved, not fixed", async () => {});
  test("contradiction with advisor off → spec fixed, quality unresolved", async () => {});
  test("fix session throws → round counted, findings stay open, loop continues", async () => {});
  test("title and summary from the branch lens are kept from the latest round that gave them", async () => {});
});
```

`test/unit/finish/machine-*.test.ts` — rewrite around the new `FinishOps` shape (`reviewSpec`, `reviewBranch`, `fix`, `openDraftPr`, `promotePr`, `finalizeDraftPr`). Required cases (one `test` each; the §3.1 table and Review Focus items 1, 4, 5):

```ts
// machine-end-to-end.test.ts
test("clean run: acceptance green → reviews clean → gates green → promotePr, status promoted, outcome ready");
test("open findings after cap, advisor off → finalizeDraftPr, outcome draft, result.findings set");
test("spec lens prose twice (missing) → draft with 'spec review missing'");                       // Review Focus 1
test("no forge → local-only");
// machine-invariants.test.ts
test("run abort mid-review → failed 'aborted', neither promotePr nor finalizeDraftPr called");
test("flowMs deadline during a fix session → no further review/fix calls, finalizeDraftPr with reason 'deadline'"); // Review Focus 4
test("acceptance runner throws → acceptance red, run continues to a draft");
test("gate runner throws → gate red with the error, draft");
test("finalizeDraftPr throws → failed with that error");
test("context route escalate → failed, no forge call");
test("nothing-to-finish and already-finished unchanged");
// machine-loops.test.ts
test("review fix committed → acceptance re-checked once");
test("gate fix committing code with rounds left → one more review round");
test("gate fix after the third review round → unreviewedFixCommits, draft");                   // Review Focus 5
test("acceptance unverified (ran 0) → draft, never ready");
// machine-advise.test.ts
test("advisor approve with open findings → promotePr, acceptedResidue recorded");
test("advisor re-review → exactly one extra round, then resolve again");
test("advisor hold → draft with 'advisor:' reason");
test("advisor unavailable → draft");
test("clean run never calls advisor approval");
```

Write each with real stubs and assertions on the call trail and returned `FinishResult`, reusing the existing helpers in these files (`baseContext`, `baseState`, `makeOps`, `configWithCommands`). Keep each test file under 650 lines; split by describe block if needed.

- [ ] **Step 2: Run to verify they fail**

Run: `timeout 90 bun test test/unit/finish/review-loop.test.ts test/unit/finish/machine-end-to-end.test.ts test/unit/finish/machine-invariants.test.ts test/unit/finish/machine-loops.test.ts test/unit/finish/machine-advise.test.ts test/unit/finish/route.test.ts --timeout=10000`
Expected: FAIL.

- [ ] **Step 3: Implement `route.ts` changes, `review-loop.ts`, `machine.ts`** per the Interfaces block. `loadReviewInputs`:

```ts
async function loadReviewInputs(state: FinishState, deps: FinishMachineDeps): Promise<ReviewInputs> {
  const [changed, hints] = await Promise.all([
    changedFiles(state.workdir, state.base),
    deps.outputDir ? readA3Hints(deps.outputDir, state.feature) : Promise.resolve([]),
  ]);
  return { changed, hints, stories: deps.context.stories ?? [], prdPath: deps.context.prdPath };
}
```

`FinishMachineDeps` gains `outputDir?: string`. `FinishContext` gains `stories?: { id: string; title: string }[]` and `prdPath: string` — populate both in `src/finish/context.ts` `loadFinishContext` from the PRD it already reads (find where `specPath` is resolved and resolve `prdPath` the same way, repo-relative; stories = `prd.userStories.map(s => ({ id: s.id, title: s.title }))`), and add a case to `test/unit/finish/context.test.ts` asserting both.

- [ ] **Step 4: Run to verify they pass**

Run: the Step 2 command, then `timeout 120 bun test test/unit/finish/ --timeout=10000`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/finish test/unit/finish
git commit -m "feat(finish): A4 shared review loop and a machine that always ends in a PR"
```

### Task 14: Phase, status, ledger, notify, config, roles, advisor import

**Files:**
- Modify: `src/finish/phase.ts`, `src/finish/audit.ts`, `src/finish/notify.ts`, `src/finish/escalate.ts`, `src/finish/config.ts`, `src/config/schemas.ts` (finish block, lines ~396-470), `src/config/runtime-types-finish.ts`, `src/runtime/session-role.ts`, `src/cli/advisor-import.ts`
- Test: `test/unit/finish/phase.test.ts`, `audit.test.ts`, `notify.test.ts`, `escalate.test.ts`, `escalation-delivery.test.ts` (delete or reduce to failed-notify), `config.test.ts`, `test/unit/config/*finish*` (find with `grep -rl "notify" test/unit/config`), `test/unit/runtime/session-role.test.ts`, the usage-auditor test that lists roles, `test/unit/cli/advisor-import.test.ts`

**Interfaces / behaviour:**
- `phase.ts`: `passed = failure === undefined && result !== null && (result.outcome === "ready" || result.status === "nothing-to-finish")` — keyed on `outcome`, not `status`, because a draft finalized onto a PR a human already marked ready has `status: "already-ready"` but `outcome: "draft"`; status entry writes `result: result.status`, `outcome`, `reason` (no `escalationReason`); `postRun.finish.status` gains `"draft"` when `result.status === "draft"` (otherwise `passed`/`failed`/`skipped` as today); log one `warn` per run if the raw finish config has `narrative` or `reviewers.narrative` set: `"finish.narrative / finish.reviewers.narrative are deprecated and ignored (A4)"`; pass `outputDir: ctx.runtime.outputDir` into the machine deps; drop `narrative`, `narrativeMs` from `createFinishOps` args.
- `notify(…)`: mode `off` → none; mode `draft` (and alias `escalation`) → only on `draft` or `failed`; `always` → every result. Message: `buildTerminalMessage` for ready statuses; new `buildDraftMessage(feature, reason, url, findings)` in `notify.ts` (reuse `buildEscalationMessage`'s finding formatting and rename it) for draft/failed.
- `audit.ts`: `LEDGER_TERMINAL_STATUSES = new Set(["opened", "promoted", "already-ready", "draft", "local-only", "nothing-to-finish"])` (keep `"escalated"` readable in `FinishLedgerEntry` parsing for old ledgers but never written); remove the `escalated && deliveryError` guard; `failed` is never ledgered.
- `escalate.ts`: delete `postEscalation`, `EscalationOutcome`, `buildEscalationComment` and their tests (no PR comments any more). If nothing else remains, delete the file and its test.
- Config: `notify.mode: z.enum(["draft", "escalation", "always", "off"]).default("draft")`; `readFinishConfig` maps `escalation` → `draft`; `FinishSettings.notify.mode: "draft" | "always" | "off"`; `FinishSettings` drops `narrative` and adds `deprecatedNarrative: boolean` (true when either narrative key was present in the raw config); `modelsOf` drops `narrative`. Schema: keep `narrative` and `reviewers.narrative` keys accepted (do not remove from zod, or profiles with them fail validation); update their doc comments to "deprecated, ignored (A4)"; update `sectionMap` doc's known keys to `unresolved, narrative, stories, advisor, rounds, verification, outOfScope`.
- `session-role.ts`: remove `"finish-narrative"` from the union and `KNOWN_SESSION_ROLES`.
- `advisor-import.ts`: `import-finish` imports only results whose `rounds` contain an `outcome === "escalated"` round **or** whose `status === "escalated"`; a post-A4 result (status `draft`/`failed`/ready) is skipped with the log line `"skipped <path>: not a pre-A4 escalation"`. `RecordedFinding` unchanged.

- [ ] **Step 1: Write the failing tests** — one per bullet above, in the listed test files, e.g.:

```ts
// phase.test.ts
test("draft result reports passed false and postRun.finish.status draft", async () => {});
test("deprecated narrative config logs one warning", async () => {});
// notify.test.ts
test.each([
  ["draft", "draft", true],
  ["draft", "promoted", false],
  ["draft", "failed", true],
  ["escalation", "draft", true],
  ["always", "promoted", true],
  ["off", "draft", false],
])("mode %s, status %s → notified %s", async () => {});
// audit.test.ts
test("draft and local-only are ledgered; failed is not", async () => {});
// config.test.ts
test("notify mode escalation reads as draft; default is draft", () => {});
test("profiles with finish.narrative still parse", () => {});
// advisor-import.test.ts
test("a post-A4 draft result is skipped; a pre-A4 escalated result still imports", async () => {});
```

Write each body in full with the file's existing fixtures.

- [ ] **Step 2: Run to verify they fail**

Run: `timeout 90 bun test test/unit/finish/ test/unit/cli/advisor-import.test.ts test/unit/runtime/session-role.test.ts test/unit/config/ --timeout=10000`
Expected: FAIL on the new cases.

- [ ] **Step 3: Implement** per the bullets.

- [ ] **Step 4: Run to verify they pass**

Run: the Step 2 command.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/finish src/config src/runtime/session-role.ts src/cli/advisor-import.ts test/unit
git commit -m "feat(finish): A4 draft status, ledger, notify mode, config deprecations"
```

### Task 15: Delete the old review stack, scripts, baselines, docs

**Files:**
- Delete: `src/finish/review/` (whole directory), `src/operations/finish-review.ts`, `src/operations/finish-narrative.ts`, `scripts/generate-review-prompts.ts`, `scripts/check-review-prompts-generated.ts`, `test/unit/finish/review-audit-gaps.test.ts`, `review-parse.test.ts`, `review-prompt.test.ts`, `route-advise.test.ts`, `review-window.test.ts`, `test/unit/operations/finish-review.test.ts`, `test/unit/operations/finish-narrative.test.ts`, `test/unit/scripts/generate-review-prompts.test.ts`
- Modify: `package.json` (remove `gen:review-prompts`, `check:review-prompts` and any `check:all` reference to them), `scripts/check-worktree-id-ssot.ts` (drop the `prompts.gen.ts` entry near line 115), `scripts/baselines/complexity-baseline.json` and `scripts/baselines/test-escape-hatches-baseline.json` (remove entries for deleted files only), `src/operations/index.ts` (remove finish-review / finish-narrative exports), `src/finish/index.ts` (remove `MAX_INCOMPLETE_ATTEMPTS` and other deleted exports), `test/unit/operations/call-root-collapse.test.ts` (remove references to deleted ops), `docs/architecture/subsystems.md` and any doc found by `grep -rln "WALK\|finish-narrative\|escalat" docs/ | grep -i finish`
- Check: `scripts/baselines/coverage-per-file-baseline.json` for entries naming deleted files (remove them)

- [ ] **Step 1: Find every remaining reference**

Run: `grep -rn "finish/review\|finishReviewOp\|finishNarrativeOp\|FinishNarrative\|FinishReviewInput\|parseReviewReport\|auditGaps\|prompts.gen\|MAX_INCOMPLETE_ATTEMPTS\|finish-narrative\|routeReview\|incompleteAttempts\|reviewGaps\|escalationReason" src test scripts package.json docs/architecture`
Expected: only the files listed above (and read-only doc comments on `FinishRoundOutcome`'s retained `escalated`/`incomplete` members).

- [ ] **Step 2: Delete and edit** as listed. In docs, replace the finish description with the spec §3 flow (one paragraph + the flow line) and remove WALK/escalation text.

- [ ] **Step 3: Full verification**

Run from the repo root: `bun run check:all && bun run typecheck`; from `packages/nax`: `bun run test` and `bun run test:coverage`.
Expected: all green. Lower baselines only for deleted files (`check:file-sizes:update`, `check:test-escape-hatches:update` after confirming the count only dropped).

- [ ] **Step 4: Commit**

```bash
git add -A src test scripts package.json docs
git commit -m "refactor(finish): A4 delete markdown review contract, narrative op and escalation path"
```

### Task 16: PR 2 integration test, review, push

**Files:**
- Create: `test/integration/finish/finish-a4.test.ts`

- [ ] **Step 1: Write the integration test**

A finish run over a real temp git repo (`withTempDir`, `git init`, two commits on a feature branch, `origin/main` simulated with a local bare remote), real `runFinishMachine`, real `commitFixes`, stub `FinishOps` review methods (scripted JSON outputs), stub forge `deps.run`. Two tests: (1) review clean → `promotePr` path, result `promoted`, `result.json` has `outcome: "ready"`; (2) one quality finding that the stub fixer "fixes" by writing a file, second round clean, but acceptance red → `finalizeDraftPr` path, result `draft`, body contains "## Unresolved" and "acceptance red". Use the existing finish integration helpers if `test/integration/finish/` already has any (check first).

- [ ] **Step 2: Run it**

Run: `timeout -k 5s 120s bun test test/integration/finish/finish-a4.test.ts --timeout=60000`
Expected: PASS.

- [ ] **Step 3: Full gates** — as Task 15 Step 3.

- [ ] **Step 4: Code review before push** — one read-only reviewer over `git diff origin/main...HEAD` against spec §3-§9 and Tasks 8-16. At most 2 fix rounds.

- [ ] **Step 5: Push and open PR 2**

```bash
git status -sb
git push -u origin feat/a4-finish-rebuild-2
gh pr create --title "feat(finish): A4 finish rebuild — branch review, no escalation, always a PR" --body "<summary, rulings R1-R7, deletions, migration notes for finish.notify.mode and narrative keys, test plan>"
```

Do not merge without maintainer approval.

### Task 17: Go-live checks (billed — maintainer approval at each launch)

- [ ] **Step 1: Catch-rate replay (approval required).** With PR 2 merged (or the branch checked out in the local build worktree `projects/nax/repos/nax-run`), for each of the 10 workspace baseline cases with a real signal (4 spec-vs-code, 6 design — list and SHAs in the workspace `autonomy-baseline-2026-10-10/` and the A1 replay scratch `cases3.tsv`), check out the recorded SHA in the case's repo and call the two ops once each through a small script under the session scratchpad (not in the repo) that builds a `CallContext` the way `phase.ts` does and calls `callOp(finishSpecReviewOp, …)` / `callOp(finishBranchReviewOp, …)`. Record, per case, whether either lens raised the recorded concern. Bar: ≥ 8/10. Write results to the workspace (`projects/nax/autonomy-a4-catch-rate-<date>/`), not the nax repo.
- [ ] **Step 2: One live finish (approval required).** On a real feature, local build, `--profile <usual>,advisor,nax-finish-native`. Check: a PR opened (ready or draft), no escalation, `finish-audit/<feature>/<runId>.result.json` has `outcome` and `facts.coverage`.
- [ ] **Step 3: Record** the outcome in the workspace master plan §7 (A4 row) and close out the spec's "Done when".
