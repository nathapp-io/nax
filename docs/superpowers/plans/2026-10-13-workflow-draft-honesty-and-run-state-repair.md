# Workflow Draft Honesty and Run-State Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close #2496 (a workflow draft says exactly what is left, the branch advisor cannot defer to a step that has passed, one capped second branch fix) and #2497 (nax-owned run state is repaired after every agent turn, whatever command damaged it).

**Architecture:** Part A changes the A5 feature machine (`src/workflow/`) and the residual advisor menu: a scope-aware menu, one extra fix round, finding ids in the review artifacts, a pure `buildOpenItems` that feeds a top-level `verdict` in `result.json` and a "Before marking ready" PR section. Part B adds `src/runstate/`: a per-run keeper that records what nax writes (via `runStateWrite`, called by the five writers), and `repairRunState`, which restores and un-hides tracked files after every turn (`SessionManager` hook), before every auto-commit (`utils/git` hook), and at run end and crash (replacing the #2490 sweep).

**Tech Stack:** Bun 1.4, TypeScript strict, `bun:test`, Biome. Package `packages/nax` (plus one comment in `packages/nax-agent`).

**Spec:** `docs/superpowers/specs/2026-10-13-workflow-draft-honesty-and-run-state-repair-design.md` (read it first; §6.5 lists what changed from the first draft).

## Global Constraints

- Work on branch `fix/2496-2497-draft-honesty-run-state` in `/Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax`. Package commands run from `packages/nax`.
- Never run bare `bun test`. Scoped: `timeout 30 bun test <path> --timeout=5000`. Full: `bun run test`.
- Bun-native APIs only in `src/` (`Bun.file`, `Bun.write`; `rename`/`mkdir`/`appendFile` from `node:fs/promises` are already used in `src/workflow/result.ts` and allowed). No `console.log`. Errors are `NaxError` with `stage` in context.
- Source files: 600-line hard limit; `src/session/manager.ts` is grandfathered at 658 and MUST NOT grow (Task 9 shrinks it). `src/execution/runner-completion.ts` is at 578: net zero lines.
- Every `logger.*` call inside a run carries `storyId` as the FIRST key of its data object.
- Barrel imports in `src/` (`@/runstate`, `@/runstate/store`, `@/config/paths` are nested barrels). Tests may import internals via `@/...`; helpers only via `@test/helpers`.
- No new `as unknown as`, `@ts-*`, `as any`, `as never`, postfix `!` in tests (`assertDefined` from `@test/helpers` instead).
- Never write `.nax/features` as a literal in `src/`; use `PROJECT_FEATURES_DIR` / `featureDir()` from `@/config/paths` (`check:feature-dir-ssot`).
- `result.json` stays `schemaVersion: 1`; every new field is optional.
- No emojis anywhere. Conventional commits (`feat:`, `fix:`, `test:`, `docs:`, `refactor:`).
- Do not push and do not open a PR; the user pushes after a code review.

## Review Focus

1. **Resuming a run whose `result.json` predates this change** (no `fixRounds`, `fixTargets`, `cannotVerify`): the machine must treat them as `fixRan ? 1 : 0`, `[]`, `[]` and not crash or loop. Test added in Task 3.
2. **The agent deletes the whole feature dir** (`rm -rf .nax/features/f`): repair must recreate the directory before restoring. Test added in Task 7.
3. **A second nax run on another feature in the same repo**: its PRD and status writes must never be recorded or reverted by this run's keeper. Test added in Task 6.
4. **An append to a run-state file that existed before the keeper saw it** (e.g. `decisions.jsonl` from an earlier run, not seeded): the kept content must be the file's real content plus the chunk, not just the chunk. Test added in Task 6.
5. **The afterTurn repair throws or git is unavailable**: the turn's own result or error must reach the caller unchanged. Test added in Task 9.

---

## Part A: #2496

### Task 1: Branch-scope residual menu, prompt guidance and defer coercion

**Files:**
- Modify: `packages/nax/src/advisor/types.ts:147` (residual `MenuFacts`)
- Modify: `packages/nax/src/advisor/menus.ts:162-176` (residual case) and add `residualDrafts`
- Modify: `packages/nax/src/prompts/builders/advisor-batch-builder.ts:19-31` (`residualBlock`)
- Modify: `packages/nax/src/workflow/types.ts:30-43` (`WorkflowRuling.coercedFrom`)
- Modify: `packages/nax/src/workflow/advisor-live.ts:39-59, 96-120` (`toWorkflowRuling`, `ruleResidual`)
- Modify: `packages/nax/src/workflow/ledger.ts:24` (`ledgerText.ruling`)
- Modify: `docs/superpowers/specs/2026-10-12-a5-workflow-mode-design.md:379` (residual row)
- Test: `packages/nax/test/unit/advisor/menus.test.ts`, `packages/nax/test/unit/prompts/advisor-batch-builder.test.ts`, `packages/nax/test/unit/workflow/advisor-live.test.ts`, `packages/nax/test/unit/workflow/ledger.test.ts`

**Interfaces:**
- Produces: `MenuFacts` residual variant `{ kind: "residual"; dependents: string[]; scope?: "story" | "branch" }` (absent = `"story"`).
- Produces: `toWorkflowRuling(findingId: string, d: AdviceDecision, scope?: "story" | "branch"): WorkflowRuling | null`.
- Produces: `WorkflowRuling.coercedFrom?: "defer"`.

- [ ] **Step 1: Write the failing tests**

In `test/unit/advisor/menus.test.ts`, inside `describe("buildMenu", ...)`:

```ts
  test("residual at branch scope offers only waive and hold (#2496)", () => {
    const menu = buildMenu({ kind: "residual", dependents: [], scope: "branch" });
    expect(menu.map((o) => o.type)).toEqual(["waive", "hold"]);
  });

  test("residual at story scope keeps defer and carry", () => {
    const menu = buildMenu({ kind: "residual", dependents: ["US-2"] });
    expect(menu.map((o) => o.type)).toEqual(["waive", "defer", "carry", "hold"]);
  });
```

In `test/unit/prompts/advisor-batch-builder.test.ts`:

```ts
  test("residual without a defer option says no review step follows (#2496)", () => {
    const text = buildAdvisorBatchPrompt({ ...base, kind: "residual", summary: "branch", items: [item], redGates: [], storyIds: [] });
    expect(text).toContain("No review step follows");
    expect(text).not.toContain("can wait for the branch review");
    expect(text).not.toContain("Choose carry");
  });

  test("residual with a defer option keeps the branch-review guidance", () => {
    const withDefer: AdviceQuestion = {
      ...item,
      options: [...item.options, { id: "B", type: "defer", label: "Park: defer" }],
    };
    const text = buildAdvisorBatchPrompt({ ...base, kind: "residual", summary: "s", items: [withDefer], redGates: [], storyIds: [] });
    expect(text).toContain("can wait for the branch review (defer)");
  });
```

In `test/unit/workflow/advisor-live.test.ts` (reuse the file's `decision()` factory):

```ts
  test("toWorkflowRuling coerces defer to a flagged hold at branch scope (#2496)", () => {
    const ruling = toWorkflowRuling("B3", decision({ action: { type: "defer", reason: "later" } }), "branch");
    expect(ruling).toMatchObject({ findingId: "B3", action: "hold", text: "later", needsHumanConfirm: true, coercedFrom: "defer" });
  });

  test("toWorkflowRuling keeps defer at story scope", () => {
    const ruling = toWorkflowRuling("F1", decision({ action: { type: "defer", reason: "later" } }), "story");
    expect(ruling?.action).toBe("defer");
    expect(ruling?.coercedFrom).toBeUndefined();
  });
```

In `test/unit/workflow/ledger.test.ts`:

```ts
  test("ledgerText.ruling marks a coerced defer (#2496)", () => {
    const text = ledgerText.ruling({
      findingId: "B3", action: "hold", text: "t", why: "w", costIfWrong: "c", source: "advisor", coercedFrom: "defer",
    });
    expect(text).toEndWith("(coerced from defer: no later review step)");
  });
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `cd packages/nax && timeout 60 bun test test/unit/advisor/menus.test.ts test/unit/prompts/advisor-batch-builder.test.ts test/unit/workflow/advisor-live.test.ts test/unit/workflow/ledger.test.ts --timeout=5000`
Expected: the new tests FAIL (typecheck-level `scope` / `coercedFrom` unknown, or wrong menu).

- [ ] **Step 3: Implement**

`src/advisor/types.ts:147`:

```ts
  | { kind: "residual"; dependents: string[]; scope?: "story" | "branch" }
```

`src/advisor/menus.ts`: add below `giveUpDrafts`:

```ts
/** Branch adjudication has no later review step, so a real defect can only be accepted or flagged (#2496). */
function residualDrafts(f: Extract<MenuFacts, { kind: "residual" }>): Draft[] {
  if (f.scope === "branch") {
    return [
      { type: "waive", label: "Accept the risk: say in reason why it is safe to ship" },
      { type: "hold", label: "A human must decide before this is marked ready" },
    ];
  }
  return [
    { type: "waive", label: "Park: the reviewer is wrong (say why in reason)" },
    { type: "defer", label: "Park: real, but defer it to the branch review (say why in reason)" },
    ...(f.dependents.length > 0
      ? [
          {
            type: "carry" as const,
            fixed: { toStories: f.dependents },
            label: `Load-bearing: carry an instruction into ${f.dependents.join(", ")}`,
          },
        ]
      : []),
    { type: "hold", label: "Flag for a human" },
  ];
}
```

and replace the whole `case "residual": return withIds([...]);` with:

```ts
    case "residual":
      return withIds(residualDrafts(facts));
```

`src/prompts/builders/advisor-batch-builder.ts`: add above `residualBlock` and use it:

```ts
/** The parking guidance follows the menu actually offered: branch scope has no defer and no carry (#2496). */
function parkGuidance(items: readonly AdviceQuestion[]): string {
  const offered = new Set(items.flatMap((i) => i.options.map((o) => o.type)));
  const park = offered.has("defer")
    ? "Park an item when the reviewer is wrong (waive) or when it is real but can wait for the branch review (defer)."
    : "No review step follows. Accept the risk (waive) only when the item is safe to ship, and say why in reason; otherwise flag it for a human (hold).";
  const carry = offered.has("carry")
    ? " Choose carry only when a later story must act on it, and say exactly what that story must do."
    : "";
  return `${park}${carry}`;
}
```

In `residualBlock`, replace the heading-and-guidance part of the returned template:

```ts
  const heading = input.items.some((i) => i.options.some((o) => o.type === "defer"))
    ? "## The story reached its fix-round cap"
    : "## Open items after the branch fix";
  return `${heading}\n${input.summary}\n\nRule on each open item below. ${parkGuidance(input.items)}\n\n${items}${gates}
```

(keep the `## Reply` part unchanged).

`src/workflow/types.ts` in `WorkflowRuling`, after `needsHumanConfirm`:

```ts
  /** Set when the advisor answered an action the scope does not allow and nax substituted this one (#2496). */
  readonly coercedFrom?: "defer";
```

`src/workflow/advisor-live.ts`:

```ts
export function toWorkflowRuling(
  findingId: string,
  d: AdviceDecision,
  scope: "story" | "branch" = "story",
): WorkflowRuling | null {
  // ...base unchanged...
  const a = d.action;
  switch (a.type) {
    case "defer":
      // #2496: nothing reviews again after branch adjudication, so a defer can only mean "a human decides".
      if (scope === "branch") {
        return { ...base, action: "hold", text: a.reason, needsHumanConfirm: true, coercedFrom: "defer" };
      }
      return { ...base, action: "defer", text: a.reason };
    case "waive":
    case "hold":
      return { ...base, action: a.type, text: a.reason };
    case "carry":
      return { ...base, action: "carry", text: a.instruction, toStories: a.toStories };
    default:
      return null;
  }
}
```

In `ruleResidual`: compute `const scope = storyId ? "story" : "branch";` once; build the menu with `buildMenu({ kind: "residual", dependents: [...dependents], scope })`; call `toWorkflowRuling(finding.id, item.decision, scope)`; after building `rulings`, warn once per coerced ruling:

```ts
      for (const r of rulings.filter((x) => x.coercedFrom)) {
        getSafeLogger()?.warn("workflow", "Advisor deferred at branch scope; coerced to hold (no later review step)", {
          storyId: FEATURE_SCOPE,
          findingId: r.findingId,
          from: "defer",
          to: "hold",
        });
      }
```

`src/workflow/ledger.ts:24`:

```ts
  ruling: (r: WorkflowRuling): string =>
    `Ruling: ${oneLine(r.text)} — ${oneLine(r.why)} — ${oneLine(r.costIfWrong)}${r.coercedFrom ? " (coerced from defer: no later review step)" : ""}`,
```

`docs/superpowers/specs/2026-10-12-a5-workflow-mode-design.md:379`: in the `residual` row replace `` `park-real-deferred` → `defer` `` with `` `park-real-deferred` → `defer` (story scope only; at branch scope the menu is `waive` / `hold` and a returned `defer` is coerced to a flagged `hold`, #2496) ``.

- [ ] **Step 4: Run the tests and confirm they pass**

Run the Step 2 command. Expected: PASS. Also run `timeout 60 bun test test/unit/workflow/ test/unit/advisor/ --timeout=5000` and fix any existing assertion that pinned the old residual heading or the always-present carry sentence (update the assertion to the new text; do not weaken it).

- [ ] **Step 5: Commit**

```bash
git add packages/nax/src/advisor packages/nax/src/prompts/builders/advisor-batch-builder.ts packages/nax/src/workflow/types.ts packages/nax/src/workflow/advisor-live.ts packages/nax/src/workflow/ledger.ts packages/nax/test docs/superpowers/specs/2026-10-12-a5-workflow-mode-design.md
git commit -m "fix(workflow): branch adjudication offers waive or hold only; coerce defer (#2496)"
```

---

### Task 2: Review artifacts carry finding ids; record keeps cannot-verify

**Files:**
- Modify: `packages/nax/src/workflow/feature-machine.ts` (`FeatureSink`, `branchReviewStep`, `branchReReviewStep`)
- Modify: `packages/nax/src/workflow/branch-review.ts:58, 86` (remove the two artifact writes)
- Modify: `packages/nax/src/workflow/feature-env.ts` (sink gains `artifact`)
- Modify: `packages/nax/src/workflow/types.ts` (`WorkflowFeatureRecord.cannotVerify`)
- Test: `packages/nax/test/unit/workflow/feature-machine.test.ts`, `packages/nax/test/unit/workflow/branch-review.test.ts`, every other test that builds a `FeatureSink` (find them with `grep -rln "sink: {" packages/nax/test | xargs grep -l "ledger:"`)

**Interfaces:**
- Produces: `FeatureSink.artifact(name: string, value: unknown): Promise<void>` (best effort, never throws).
- Produces: `WorkflowFeatureRecord.cannotVerify?: readonly string[]` (branch review's cannot-verify items).

- [ ] **Step 1: Write the failing tests**

In `feature-machine.test.ts` `harness()`, add `const artifacts: Record<string, unknown> = {};`, add to `sink`: `artifact: async (name, value) => { artifacts[name] = value; },`, and return `artifacts`. Then:

```ts
  test("branch-review.json carries the same B-ids as the record; cannot-verify kept (#2496)", async () => {
    const review: BranchReviewVerdict = {
      ...PASS,
      spec: "fail",
      findings: [
        { kind: "spec", severity: "important", issue: "missing refund cap", file: "src/r.ts", line: 4 },
        { kind: "quality", severity: "minor", issue: "rename tmp" },
      ],
      cannotVerify: ["CI-only path"],
    };
    const h = harness({ review });
    const final = await runFeatureMachine(h.env);
    const written = h.artifacts["branch-review.json"] as BranchReviewVerdict & { findings: { id?: string }[] };
    expect(written.findings[0]?.id).toBe("B1");
    expect(final.cannotVerify).toEqual(["CI-only path"]);
    expect(h.artifacts["branch-rereview.json"]).toBeDefined();
  });
```

In `branch-review.test.ts`, change any assertion that `runBranchReview` writes `branch-review.json` into an assertion that it does NOT write it (the machine owns the write now):

```ts
    expect(await Bun.file(join(runDir, "branch-review.json")).exists()).toBe(false);
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd packages/nax && timeout 60 bun test test/unit/workflow/feature-machine.test.ts test/unit/workflow/branch-review.test.ts --timeout=5000`
Expected: FAIL (`artifact` not on `FeatureSink`, no ids, file still written).

- [ ] **Step 3: Implement**

`types.ts` in `WorkflowFeatureRecord` after `reviewRan`:

```ts
  /** The branch review's cannot-verify items (#2496: listed as open items, never blocking). */
  readonly cannotVerify?: readonly string[];
```

`feature-machine.ts` `FeatureSink`:

```ts
  /** Writes a review artifact into the run dir. Best effort: never throws. */
  artifact(name: string, value: unknown): Promise<void>;
```

In `branchReviewStep`, right after `const minors = ...`:

```ts
  // #2496: written here, after assign(), so the file and result.json name findings the same way.
  await env.sink.artifact("branch-review.json", { ...out.verdict, findings: [...findings, ...minors] });
```

and add `cannotVerify: out.verdict.cannotVerify,` to the returned patch.

In `branchReReviewStep`, after `const { findings, nextFindingId } = assign(...)`:

```ts
  await env.sink.artifact("branch-rereview.json", {
    ...out.verdict,
    newFindings: [...findings, ...out.verdict.newFindings.filter((f) => !isBlocking(f))],
  });
```

`branch-review.ts`: delete `if (outcome.ran) await writeFeatureArtifact(fc, "branch-review.json", outcome.verdict);` and the `branch-rereview.json` twin. Keep `writeFeatureArtifact` exported.

`feature-env.ts`: import `writeFeatureArtifact` alongside `runBranchReReview, runBranchReview` from `./branch-review`; add to `sink`:

```ts
    artifact: (name, value) => writeFeatureArtifact(fc, name, value),
```

Add `artifact: async () => {},` to every other test `FeatureSink` that typecheck now flags.

- [ ] **Step 4: Run and confirm pass**

Run the Step 2 command, then `cd packages/nax && bun run typecheck`. Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/nax/src/workflow packages/nax/test
git commit -m "fix(workflow): review artifacts carry finding ids; record keeps cannot-verify (#2496)"
```

---

### Task 3: One capped second branch fix

**Files:**
- Modify: `packages/nax/src/workflow/types.ts` (`fixRounds`, `fixTargets`)
- Modify: `packages/nax/src/workflow/feature-machine.ts` (header comment, `FeatureSteps.changedFiles`, `branchFixStep`, `branchReReviewStep`, new helpers)
- Modify: `packages/nax/src/workflow/git.ts` (`changedFilesSince`)
- Modify: `packages/nax/src/workflow/feature-env.ts` (`changedFiles` step)
- Test: `packages/nax/test/unit/workflow/feature-machine.test.ts` (if it passes ~650 lines, put these in a new `feature-machine-second-fix.test.ts` by describe block, copying the harness through a shared local helper is NOT allowed; instead move `harness` into `packages/nax/test/helpers/feature-machine.ts`, export it from `@test/helpers`, and import it in both files), `packages/nax/test/unit/workflow/git.test.ts`

**Interfaces:**
- Consumes: `FeatureSink.artifact` (Task 2).
- Produces: `FeatureSteps.changedFiles(base: string): Promise<readonly string[]>` (repo-rooted paths, throws on git failure).
- Produces: `WorkflowFeatureRecord.fixRounds?: number`, `fixTargets?: readonly string[]`.
- Produces: `changedFilesSince(projectDir: string, base: string): Promise<string[]>` in `src/workflow/git.ts`.

- [ ] **Step 1: Write the failing tests**

Extend `Script` with `reReviews?: (ReReviewVerdict | null)[]` (a queue, consumed in order, falling back to `reReview`) and `changed?: string[] | Error`; add to `steps`:

```ts
    changedFiles: async () => {
      calls.push("changedFiles");
      if (script.changed instanceof Error) throw script.changed;
      return script.changed ?? [];
    },
```

and make `branchReReview` take `script.reReviews?.shift()` first when the queue is non-empty. Tests:

```ts
const REVIEW_B1: BranchReviewVerdict = {
  ...PASS,
  spec: "fail",
  findings: [{ kind: "spec", severity: "important", issue: "cap missing", file: "src/a.ts" }],
};
const NEW_IN_FIX = (file?: string): ReReviewVerdict => ({
  verdicts: [{ id: "B1", addressed: true, note: "" }],
  newFindings: [{ kind: "spec", severity: "important", issue: "fix broke publish", ...(file ? { file } : {}) }],
});
const ALL_ADDRESSED = (id: string): ReReviewVerdict => ({ verdicts: [{ id, addressed: true, note: "" }], newFindings: [] });

describe("second branch fix (#2496)", () => {
  test("taken when every item is addressed and new blocking findings sit in the fix diff", async () => {
    const h = harness({ review: REVIEW_B1, reReviews: [NEW_IN_FIX("src/a.ts"), ALL_ADDRESSED("B2")], changed: ["src/a.ts"] });
    const final = await runFeatureMachine(h.env);
    expect(h.fixInputs.map((f) => f.map((x) => x.id))).toEqual([["B1"], ["B2"]]);
    expect(h.reReviewInputs[1]?.map((f) => f.id)).toEqual(["B2"]);
    expect(final.fixRounds).toBe(2);
    expect(final.reviewOpen).toEqual([]);
    expect(h.calls).not.toContain("adjudicate");
    expect(h.ledger.some((l) => l.startsWith("branch fix r2: 1 item(s): B2"))).toBe(true);
    expect(h.artifacts["branch-rereview-r2.json"]).toBeDefined();
  });

  test("never a third round: round-2 re-review findings go to adjudicate", async () => {
    const h = harness({ review: REVIEW_B1, reReviews: [NEW_IN_FIX("src/a.ts"), NEW_IN_FIX("src/a.ts")], changed: ["src/a.ts"] });
    const final = await runFeatureMachine(h.env);
    expect(h.fixInputs).toHaveLength(2);
    expect(h.calls).toContain("adjudicate");
    expect(final.fixRounds).toBe(2);
  });

  test("not taken when an earlier item stays open", async () => {
    const stillOpen: ReReviewVerdict = { ...NEW_IN_FIX("src/a.ts"), verdicts: [{ id: "B1", addressed: false, note: "" }] };
    const h = harness({ review: REVIEW_B1, reReviews: [stillOpen], changed: ["src/a.ts"] });
    await runFeatureMachine(h.env);
    expect(h.fixInputs).toHaveLength(1);
    expect(h.calls).toContain("adjudicate");
  });

  test("not taken when a new finding is outside the fix diff", async () => {
    const h = harness({ review: REVIEW_B1, reReviews: [NEW_IN_FIX("src/other.ts")], changed: ["src/a.ts"] });
    await runFeatureMachine(h.env);
    expect(h.fixInputs).toHaveLength(1);
  });

  test("not taken when a new finding names no file", async () => {
    const h = harness({ review: REVIEW_B1, reReviews: [NEW_IN_FIX()], changed: ["src/a.ts"] });
    await runFeatureMachine(h.env);
    expect(h.fixInputs).toHaveLength(1);
  });

  test("a git failure listing the fix diff skips the second fix and says so", async () => {
    const h = harness({ review: REVIEW_B1, reReviews: [NEW_IN_FIX("src/a.ts")], changed: new Error("bad revision") });
    await runFeatureMachine(h.env);
    expect(h.fixInputs).toHaveLength(1);
    expect(h.ledger.some((l) => l.includes("second branch fix skipped"))).toBe(true);
  });

  test("a file spelled ./src/a.ts still matches the fix diff", async () => {
    const h = harness({ review: REVIEW_B1, reReviews: [NEW_IN_FIX("./src/a.ts"), ALL_ADDRESSED("B2")], changed: ["src/a.ts"] });
    await runFeatureMachine(h.env);
    expect(h.fixInputs).toHaveLength(2);
  });

  test("resumes a pre-#2496 record (no fixRounds/fixTargets/cannotVerify) without a second round", async () => {
    const legacy: WorkflowFeatureRecord = {
      ...newFeatureRecord({ now: "t", seed: "seed0", minors: [] }),
      step: "branch-rereview",
      fixRan: true,
      fixBase: "h1",
      reviewOpen: [{ id: "B1", kind: "spec", severity: "important", issue: "x", file: "src/a.ts" }],
      nextFindingId: 2,
    };
    const h = harness({ reReviews: [ALL_ADDRESSED("B1")] }, { record: legacy });
    const final = await runFeatureMachine(h.env);
    expect(h.fixInputs).toHaveLength(0);
    expect(final.step).toBe("done");
  });
});
```

In `test/unit/workflow/git.test.ts` (create if absent, mirroring `src/workflow/git.ts`), using `_workflowDeps.git` injection with save/restore in `afterEach`:

```ts
  test("changedFilesSince lists names from base..HEAD and throws on a git failure", async () => {
    _workflowDeps.git = async () => ({ stdout: "src/a.ts\nsrc/b.ts\n", exitCode: 0 });
    expect(await changedFilesSince("/repo", "abc")).toEqual(["src/a.ts", "src/b.ts"]);
    _workflowDeps.git = async () => ({ stdout: "", stderr: "bad revision", exitCode: 128 });
    await expect(changedFilesSince("/repo", "abc")).rejects.toThrow("bad revision");
  });
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd packages/nax && timeout 60 bun test test/unit/workflow/feature-machine.test.ts test/unit/workflow/git.test.ts --timeout=5000`
Expected: FAIL.

- [ ] **Step 3: Implement**

`types.ts` in `WorkflowFeatureRecord` after `fixRan`:

```ts
  /** Branch fix sessions run so far (#2496: at most 2). Absent on records written before #2496. */
  readonly fixRounds?: number;
  /** Round 2 only: the ids of the new findings the second fix targets. */
  readonly fixTargets?: readonly string[];
```

`git.ts`:

```ts
/** Repo-rooted paths changed between `base` and HEAD (#2496 second-fix eligibility). Throws on a git failure. */
export async function changedFilesSince(projectDir: string, base: string): Promise<string[]> {
  const { stdout, stderr, exitCode } = await _workflowDeps.git(["diff", "--name-only", `${base}..HEAD`], projectDir);
  if (exitCode !== 0) {
    throw new NaxError(`git diff --name-only failed: ${stderr ?? ""}`.trim(), "WORKFLOW_GIT_FAILED", {
      stage: "workflow",
      storyId: "_run",
    });
  }
  return stdout.split("\n").filter((line) => line !== "");
}
```

`feature-machine.ts`:
- Header comment: replace "One branch review, exactly one fix pass, one scoped re-review, one adjudication." with "One branch review, one fix pass (plus one targeted second pass for defects the fix introduced, #2496), one scoped re-review per pass, one adjudication."
- `FeatureSteps`: add `changedFiles(base: string): Promise<readonly string[]>;`
- Import `errorMessage` from `@nathapp/nax-agent/internal`.
- Helpers below `fixNowMinors`:

```ts
const MAX_BRANCH_FIX_ROUNDS = 2;
const fixRoundsOf = (rec: WorkflowFeatureRecord): number => rec.fixRounds ?? (rec.fixRan ? 1 : 0);
const isSecondRound = (rec: WorkflowFeatureRecord): boolean =>
  fixRoundsOf(rec) >= 1 && (rec.fixTargets?.length ?? 0) > 0;
const repoPath = (file: string): string => file.replace(/^\.\//, "");

function secondRoundTargets(rec: WorkflowFeatureRecord): WorkflowFinding[] {
  const ids = new Set(rec.fixTargets ?? []);
  return rec.reviewOpen.filter((f) => ids.has(f.id));
}

/** #2496: one more fix only when the first fix is clean and its own diff introduced the new defects. */
async function secondFixEligible(
  env: FeatureEnv,
  rec: WorkflowFeatureRecord,
  stillOpen: ReadonlySet<string>,
  added: readonly WorkflowFinding[],
): Promise<boolean> {
  if (fixRoundsOf(rec) >= MAX_BRANCH_FIX_ROUNDS || stillOpen.size > 0 || added.length === 0 || !rec.fixBase) return false;
  if (added.some((f) => !f.file)) return false;
  try {
    const changed = new Set((await env.steps.changedFiles(rec.fixBase)).map(repoPath));
    return added.every((f) => f.file !== undefined && changed.has(repoPath(f.file)));
  } catch (err) {
    await env.sink.ledger(
      ledgerText.note(`second branch fix skipped: could not list the fix diff (${errorMessage(err)})`),
      NO_MIRROR,
    );
    return false;
  }
}
```

- `branchFixStep`:

```ts
async function branchFixStep(env: FeatureEnv, rec: WorkflowFeatureRecord): Promise<Patch> {
  const round = fixRoundsOf(rec) + 1;
  const toFix = isSecondRound(rec)
    ? secondRoundTargets(rec)
    : [...rec.reviewOpen, ...fixNowMinors(rec), ...rec.gateFindings];
  if (toFix.length === 0) return { step: "branch-rereview" };
  const fixBase = await env.steps.head();
  const label = round > 1 ? `branch fix r${round}` : "branch fix";
  await env.sink.ledger(
    ledgerText.note(`${label}: ${toFix.length} item(s): ${toFix.map((f) => f.id).join(", ")}`),
    NO_MIRROR,
  );
  const log = featureStep(round > 1 ? `branch-fix r${round}` : "branch-fix", true, false, env.steps.modelFor?.("branch-fix"));
  // ...the out / log.done / three ledger lines stay as they are...
  return { fixBase, fixRan: true, fixRounds: round, step: "branch-rereview" };
}
```

- `branchReReviewStep`: at the top `const second = isSecondRound(rec);` and `const items = second ? secondRoundTargets(rec) : [...rec.reviewOpen, ...fixNowMinors(rec)];`; the step label `second ? "branch-rereview r2" : "branch-rereview"`; the artifact name from Task 2 becomes `second ? "branch-rereview-r2.json" : "branch-rereview.json"`. Replace the final `return { ..., step: "adjudicate" };` with:

```ts
  const again = !second && (await secondFixEligible(env, rec, stillOpen, findings));
  if (again) {
    await env.sink.ledger(
      ledgerText.note(`second branch fix: ${findings.map((f) => f.id).join(", ")} introduced by the fix`),
      NO_MIRROR,
    );
  }
  return {
    reviewOpen: [...rec.reviewOpen.filter((f) => stillOpen.has(f.id)), ...findings],
    nextFindingId,
    minors,
    newMinors,
    ...(again ? { fixTargets: findings.map((f) => f.id) } : {}),
    step: again ? "branch-fix" : "adjudicate",
  };
```

`feature-env.ts`: import `changedFilesSince` with `readHead` from `./git`; add to `steps`: `changedFiles: (base) => changedFilesSince(fc.projectDir, base),`.

Add `changedFiles: async () => [],` to every other test `FeatureSteps` that typecheck flags.

- [ ] **Step 4: Run and confirm pass**

Run the Step 2 command, then `timeout 120 bun test test/unit/workflow/ test/integration/workflow/ --timeout=10000` and `bun run typecheck`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/nax/src/workflow packages/nax/test
git commit -m "feat(workflow): one capped second branch fix for defects the fix introduced (#2496)"
```

---

### Task 4: Open items and a top-level verdict in result.json

**Files:**
- Create: `packages/nax/src/workflow/open-items.ts`
- Modify: `packages/nax/src/workflow/types.ts` (`OpenItem`, `WorkflowVerdict`, `WorkflowResultFile.verdict`)
- Modify: `packages/nax/src/workflow/result.ts` (`upsertFeatureRecord`, `upsertStoryRecord`)
- Modify: `packages/nax/src/workflow/index.ts` (export `buildOpenItems`, `buildVerdict` and the two types if the barrel lists workflow exports)
- Modify: `docs/superpowers/specs/2026-10-12-a5-workflow-mode-design.md` (append "Appendix: finishing contract")
- Test: `packages/nax/test/unit/workflow/open-items.test.ts`, `packages/nax/test/unit/workflow/result.test.ts`

**Interfaces:**
- Consumes: `WorkflowFeatureRecord.cannotVerify` (Task 2).
- Produces (types in `types.ts`):

```ts
export interface OpenItem {
  readonly id: string;
  readonly kind: "finding" | "ruling" | "cannot-verify" | "gate";
  readonly severity?: WorkflowSeverity;
  readonly file?: string;
  readonly line?: number;
  readonly issue: string;
  readonly suggestion?: string;
  readonly ruling?: { readonly action: WorkflowRuling["action"]; readonly why: string; readonly decisionId?: string };
}

export interface WorkflowVerdict {
  readonly workflowPassed: boolean;
  readonly outcome: FeatureOutcome;
  readonly reasons: readonly string[];
  readonly openItems: readonly OpenItem[];
}
```

- Produces: `buildOpenItems(rec: WorkflowFeatureRecord): OpenItem[]`, `buildVerdict(rec: WorkflowFeatureRecord): WorkflowVerdict | undefined` (undefined until `rec.outcome` is set).

- [ ] **Step 1: Write the failing tests**

`test/unit/workflow/open-items.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { newFeatureRecord } from "@/workflow/feature-record";
import { buildOpenItems, buildVerdict } from "@/workflow/open-items";
import type { WorkflowFeatureRecord, WorkflowRuling } from "@/workflow/types";

const B3 = { id: "B3", kind: "spec" as const, severity: "important" as const, issue: "x".repeat(500), file: "src/p.ts", line: 9, suggestion: "return the id" };
const ruling = (over: Partial<WorkflowRuling>): WorkflowRuling => ({
  findingId: "B3", action: "hold", text: "t", why: "needs a human", costIfWrong: "c", source: "advisor", ...over,
});
const rec = (over: Partial<WorkflowFeatureRecord>): WorkflowFeatureRecord => ({
  ...newFeatureRecord({ now: "t", seed: "s", minors: [] }),
  ...over,
});

describe("buildOpenItems (#2496)", () => {
  test("a held finding is open with its evidence in full and its ruling", () => {
    const [item] = buildOpenItems(rec({ reviewOpen: [B3], rulings: [ruling({ decisionId: "D-4" })] }));
    expect(item).toEqual({
      id: "B3", kind: "ruling", severity: "important", file: "src/p.ts", line: 9, issue: B3.issue,
      suggestion: "return the id", ruling: { action: "hold", why: "needs a human", decisionId: "D-4" },
    });
  });

  test("an unflagged waive closes the finding; a flagged waive keeps it open", () => {
    expect(buildOpenItems(rec({ reviewOpen: [B3], rulings: [ruling({ action: "waive" })] }))).toEqual([]);
    const flagged = buildOpenItems(rec({ reviewOpen: [B3], rulings: [ruling({ action: "waive", needsHumanConfirm: true })] }));
    expect(flagged[0]?.kind).toBe("ruling");
  });

  test("an unruled finding is kind finding; cannot-verify and red final gates are listed", () => {
    const items = buildOpenItems(
      rec({
        reviewOpen: [B3],
        cannotVerify: ["CI-only path"],
        finalGates: { ran: ["lint"], failing: ["lint"] },
        finalGateFindings: [{ kind: "gate", severity: "important", issue: "repo gate lint failed:\nno-var" }],
      }),
    );
    expect(items.map((i) => [i.id, i.kind])).toEqual([["B3", "finding"], ["_run:cv1", "cannot-verify"], ["lint", "gate"]]);
    expect(items[2]?.issue).toBe("repo gate lint failed:\nno-var");
  });
});

describe("buildVerdict (#2496)", () => {
  test("undefined before publish", () => {
    expect(buildVerdict(rec({}))).toBeUndefined();
  });

  test("workflowPassed is false while a finding, ruling or gate is open, and ignores cannot-verify", () => {
    const base = { outcome: "draft" as const, passed: true, reasons: ["1 ruling(s) flagged for a human"] };
    expect(buildVerdict(rec({ ...base, reviewOpen: [B3], rulings: [ruling({})] }))?.workflowPassed).toBe(false);
    expect(buildVerdict(rec({ ...base, outcome: "ready", reasons: [], cannotVerify: ["x"] }))?.workflowPassed).toBe(true);
    expect(buildVerdict(rec({ ...base, outcome: "ready", reasons: [], passed: false }))?.workflowPassed).toBe(false);
  });
});
```

In `result.test.ts`:

```ts
  test("upsertFeatureRecord writes a top-level verdict once the outcome is set; story upserts keep it (#2496)", async () => {
    await withTempDir(async (runDir) => {
      const record = { ...newFeatureRecord({ now: "t", seed: "s", minors: [] }), outcome: "draft" as const, passed: true, reasons: ["r"] };
      await upsertFeatureRecord(runDir, { runId: "r1", feature: "f" }, record);
      await upsertStoryRecord(runDir, { runId: "r1", feature: "f" }, newStoryRecord("US-001", 3, "t"));
      const file = await readResult(runDir);
      expect(file?.verdict).toEqual({ workflowPassed: true, outcome: "draft", reasons: ["r"], openItems: [] });
    });
  });
```

(import `withTempDir` from `@test/helpers` if the file does not already.)

- [ ] **Step 2: Run and confirm failure**

Run: `cd packages/nax && timeout 30 bun test test/unit/workflow/open-items.test.ts test/unit/workflow/result.test.ts --timeout=5000`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

Add the two interfaces (Interfaces block above) to `types.ts`, and to `WorkflowResultFile`:

```ts
  /** #2496: the one place a finishing tool reads. Absent until the feature workflow publishes. */
  readonly verdict?: WorkflowVerdict;
```

`src/workflow/open-items.ts`:

```ts
/** #2496: what is still open on a workflow feature, and the verdict a finishing tool reads. Pure. */
import type { OpenItem, WorkflowFeatureRecord, WorkflowFinding, WorkflowRuling, WorkflowVerdict } from "./types";

const BLOCKING_KINDS: ReadonlySet<OpenItem["kind"]> = new Set(["finding", "ruling", "gate"]);

const acceptsRisk = (r: WorkflowRuling | undefined): boolean => r?.action === "waive" && r.needsHumanConfirm !== true;

function findingItem(f: WorkflowFinding, r: WorkflowRuling | undefined): OpenItem {
  return {
    id: f.id,
    kind: r ? "ruling" : "finding",
    severity: f.severity,
    ...(f.file ? { file: f.file } : {}),
    ...(f.line !== undefined ? { line: f.line } : {}),
    issue: f.issue,
    ...(f.suggestion ? { suggestion: f.suggestion } : {}),
    ...(r ? { ruling: { action: r.action, why: r.why, ...(r.decisionId ? { decisionId: r.decisionId } : {}) } } : {}),
  };
}

function gateItems(rec: WorkflowFeatureRecord): OpenItem[] {
  return (rec.finalGates?.failing ?? []).map((name) => ({
    id: name,
    kind: "gate" as const,
    issue: rec.finalGateFindings?.find((g) => g.issue.startsWith(`repo gate ${name} failed`))?.issue ?? `final gate ${name} is red`,
  }));
}

export function buildOpenItems(rec: WorkflowFeatureRecord): OpenItem[] {
  const rulings = new Map(rec.rulings.flatMap((r) => (r.findingId ? [[r.findingId, r] as const] : [])));
  const findings = rec.reviewOpen
    .filter((f) => !acceptsRisk(rulings.get(f.id)))
    .map((f) => findingItem(f, rulings.get(f.id)));
  const cannotVerify = (rec.cannotVerify ?? []).map((issue, i) => ({
    id: `_run:cv${i + 1}`,
    kind: "cannot-verify" as const,
    issue,
  }));
  return [...findings, ...cannotVerify, ...gateItems(rec)];
}

export function buildVerdict(rec: WorkflowFeatureRecord): WorkflowVerdict | undefined {
  if (!rec.outcome) return undefined;
  const openItems = buildOpenItems(rec);
  return {
    workflowPassed: rec.passed === true && !openItems.some((i) => BLOCKING_KINDS.has(i.kind)),
    outcome: rec.outcome,
    reasons: rec.reasons,
    openItems,
  };
}
```

Confirm the `repo gate <name> failed` prefix against `src/workflow/repo-gates.ts` (where `findings` are built); if the wording differs, use the real prefix in both `gateItems` and the test.

`result.ts`: import `buildVerdict` from `./open-items`. In `upsertFeatureRecord`:

```ts
  const verdict = buildVerdict(record);
  await writeResult(runDir, {
    schemaVersion: 1,
    runId: header.runId,
    feature: header.feature,
    stories: current?.stories ?? {},
    featureWorkflow: record,
    ...(verdict ? { verdict } : {}),
  });
```

In `upsertStoryRecord` add `...(current?.verdict ? { verdict: current.verdict } : {}),` after the `featureWorkflow` spread.

Append to the A5 spec:

```markdown
## Appendix: finishing contract (#2496)

A tool that takes a workflow draft to ready (the toolkit finish skill) reads one file:
`.nax/features/<feature>/workflow/<runId>/result.json`. Stable within `schemaVersion` 1:

- `verdict.workflowPassed`: stories and final gates pass and no finding, ruling or gate item is open.
- `verdict.outcome`: `ready` | `draft` | `local-only`. `verdict.reasons`: why it is not ready.
- `verdict.openItems[]`: `{ id, kind: finding | ruling | cannot-verify | gate, severity?, file?, line?, issue, suggestion?, ruling? }`, full text.
- `featureWorkflow.{outcome, reasons, reviewOpen, rulings, finalGates, finalGateFindings}`.
- `branch-review.json` / `branch-rereview.json` findings carry the same `B<n>` ids.
- `ledger.md` lines `_run: cannot-verify: <item>` and `Ruling: ...`.
```

- [ ] **Step 4: Run and confirm pass**

Run the Step 2 command, then `timeout 120 bun test test/unit/workflow/ --timeout=10000`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/nax/src/workflow packages/nax/test docs/superpowers/specs/2026-10-12-a5-workflow-mode-design.md
git commit -m "feat(workflow): result.json verdict with open items; finishing contract (#2496)"
```

---

### Task 5: "Before marking ready" PR section

**Files:**
- Modify: `packages/nax/src/workflow/pr-body.ts` (`WorkflowPrBodyFacts.openItems`, `beforeReady`, `buildWorkflowPrBody`)
- Modify: `packages/nax/src/workflow/finalize.ts:100-111` (`bodyFacts` passes `openItems`)
- Test: `packages/nax/test/unit/workflow/pr-body.test.ts`, `packages/nax/test/unit/workflow/finalize.test.ts`, `packages/nax/test/integration/workflow/feature-e2e.test.ts`

**Interfaces:**
- Consumes: `OpenItem`, `buildOpenItems` (Task 4).
- Produces: `WorkflowPrBodyFacts.openItems: readonly OpenItem[]` (required).

- [ ] **Step 1: Write the failing tests**

In `pr-body.test.ts` add `openItems: []` to the shared `input`, then:

```ts
  const held: OpenItem = {
    id: "B3", kind: "ruling", severity: "important", file: "src/p.ts", line: 9,
    issue: `published() returns void ${"y".repeat(400)} <script>`, suggestion: "return the `id`",
    ruling: { action: "hold", why: "needs a human" },
  };

  test("draft: Before marking ready lists each open item in full with a checklist (#2496)", () => {
    const body = buildWorkflowPrBody({ ...input, openItems: [held] });
    const section = body.slice(body.indexOf("## Before marking ready"), body.indexOf("## Pre-flight rulings"));
    expect(section).toContain("- [ ] **B3** (important, ruling) `src/p.ts:9`");
    expect(section).toContain("y".repeat(400));
    expect(section).toContain("&lt;script&gt;");
    expect(section).toContain("Suggestion: return the 'id'");
    expect(section).toContain("Advisor: hold — needs a human");
    expect(section).toContain("Then: rerun the repo gates, push, and run `gh pr ready`.");
    expect(body.indexOf("## Before marking ready")).toBeGreaterThan(body.indexOf("## Stories"));
  });

  test("no section when nothing is open or the PR is ready", () => {
    expect(buildWorkflowPrBody(input)).not.toContain("## Before marking ready");
    expect(buildWorkflowPrBody({ ...input, outcome: "ready", openItems: [held] })).not.toContain("## Before marking ready");
  });

  test("more than 50 open items: cap with a pointer to result.json", () => {
    const many = Array.from({ length: 52 }, (_, i) => ({ ...held, id: `B${i}` }));
    expect(buildWorkflowPrBody({ ...input, openItems: many })).toContain("…and 2 more, see result.json verdict.openItems");
  });
```

(import `OpenItem` from `@/workflow/types`.)

In `test/integration/workflow/feature-e2e.test.ts`, add the spec's B3 scenario using the file's existing scripted ops (`workflowBranchReviewOp`, `workflowBranchFixOp`, `workflowReReviewOp` stubs through `_workflowDeps.callOp`) and `_featureDeps` forge fakes:

```ts
  test("B3: a defect the branch fix introduced is fixed by the second pass (#2496)", async () => {
    // branch review: one important finding B1 in src/a.ts
    // re-review 1: B1 addressed, new important finding in src/a.ts (inside the fix diff: stub _workflowDeps.git
    //   so `diff --name-only <base>..HEAD` returns "src/a.ts")
    // re-review 2: B2 addressed, nothing new
    // expect: two branch-fix callOp invocations, result.json verdict.openItems == [], featureWorkflow.fixRounds == 2
  });

  test("B3: second re-review still failing ends draft with the full open item", async () => {
    // same script, re-review 2 marks B2 not addressed; advisor rules hold
    // expect: verdict.outcome "draft", verdict.workflowPassed false,
    //   verdict.openItems[0] has id "B2", file "src/a.ts", the full issue text, and ruling.action "hold";
    //   the PR body passed to the forge fake contains "## Before marking ready" and "**B2**"
  });
```

Write each scripted step the way the neighbouring tests in that file script theirs (same helpers, same stubs); the comments above are the exact script and assertions.

In `finalize.test.ts`, assert the draft body passed to `openDraftFinishPr` contains `## Before marking ready` when the record has a held `reviewOpen` finding (follow the file's existing publish test setup).

- [ ] **Step 2: Run and confirm failure**

Run: `cd packages/nax && timeout 90 bun test test/unit/workflow/pr-body.test.ts test/unit/workflow/finalize.test.ts test/integration/workflow/feature-e2e.test.ts --timeout=10000`
Expected: FAIL.

- [ ] **Step 3: Implement**

`pr-body.ts`: import `OpenItem` type from `./types`; add `readonly openItems: readonly OpenItem[];` to `WorkflowPrBodyFacts`; add:

```ts
/** Open items are shown in full: a human acts on them, so nothing is truncated (#2496). */
const FULL_TEXT = Number.MAX_SAFE_INTEGER;

function openItemLine(item: OpenItem): string {
  const where = item.file ? ` \`${escapeInline(item.file, FULL_TEXT)}${item.line !== undefined ? `:${item.line}` : ""}\`` : "";
  const tags = [item.severity, item.kind].filter((t): t is string => t !== undefined).join(", ");
  return [
    `- [ ] **${escapeInline(item.id, FULL_TEXT)}** (${tags})${where} — ${escapeInline(item.issue, FULL_TEXT)}`,
    ...(item.suggestion ? [`  Suggestion: ${escapeInline(item.suggestion, FULL_TEXT)}`] : []),
    ...(item.ruling ? [`  Advisor: ${item.ruling.action} — ${escapeInline(item.ruling.why, FULL_TEXT)}`] : []),
  ].join("\n");
}

function beforeReady(input: WorkflowPrBodyInput): string | null {
  if (input.outcome === "ready" || input.openItems.length === 0) return null;
  const shown = input.openItems.slice(0, ROW_CAP).map(openItemLine);
  const hidden = input.openItems.length - shown.length;
  return [
    "## Before marking ready",
    "",
    ...shown,
    ...(hidden > 0 ? [`- …and ${hidden} more, see result.json verdict.openItems`] : []),
    "",
    "Then: rerun the repo gates, push, and run `gh pr ready`.",
  ].join("\n");
}
```

In `buildWorkflowPrBody`, build the section list with the new section right after Stories:

```ts
  const ready = beforeReady(input);
  return [
    `## Summary\n\n${summary(input)}`,
    `## Stories\n\n${storiesTable(input.stories)}`,
    ...(ready ? [ready] : []),
    `## Pre-flight rulings\n\n${list(preflightLines(input.preflight))}`,
    // ...rest unchanged
  ].join("\n\n");
```

Check `escapeInline`'s `capEscaped` with `Number.MAX_SAFE_INTEGER` returns the whole string (read `src/finish/pr/escape.ts`); if it slices by a computed length that breaks on a huge max, add an `escapeInlineFull(value)` beside `escapeInline` in `escape.ts` that applies the same replacements without capping, export it from `@/finish`, and use it here.

`finalize.ts` `bodyFacts`: import `buildOpenItems` from `./open-items`; add `openItems: buildOpenItems(r),` to the returned object. Add `openItems: []` to any other `WorkflowPrBodyFacts` literal typecheck flags.

- [ ] **Step 4: Run and confirm pass**

Run the Step 2 command, then `timeout 120 bun test test/unit/workflow/ test/integration/workflow/ --timeout=10000` and `bun run typecheck`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/nax/src/workflow packages/nax/src/finish packages/nax/test
git commit -m "feat(workflow): draft PR lists open items in full under Before marking ready (#2496)"
```

---

## Part B: #2497

### Task 6: Run-state store (paths, keeper, registry, runStateWrite)

**Files:**
- Create: `packages/nax/src/runstate/store/paths.ts`, `packages/nax/src/runstate/store/keeper.ts`, `packages/nax/src/runstate/store/registry.ts`, `packages/nax/src/runstate/store/index.ts`
- Test: `packages/nax/test/unit/runstate/store/paths.test.ts`, `packages/nax/test/unit/runstate/store/keeper.test.ts`, `packages/nax/test/unit/runstate/store/registry.test.ts`

**Interfaces:**
- Produces (all exported from `@/runstate/store`):

```ts
export type RunStateKind = "prd" | "status" | "workflow-result" | "ledger" | "decisions";
export interface RunStatePath { readonly root: string; readonly feature: string; readonly kind: RunStateKind; readonly rel: string }
export function classifyRunStatePath(absPath: string): RunStatePath | null;

export interface KeptFile extends RunStatePath { readonly path: string; readonly content: string }
export class RunStateKeeper {
  constructor(runId: string, feature: string);
  readonly runId: string; readonly feature: string;
  owns(p: RunStatePath): boolean;
  record(path: string, p: RunStatePath, content: string): void;
  get(path: string): KeptFile | undefined;
  files(): readonly KeptFile[];
  roots(): readonly string[];
  begin(path: string): void; end(path: string): void; isInFlight(path: string): boolean;
}

export type WriteIntent = { readonly content: string } | { readonly append: string };
export function registerKeeper(k: RunStateKeeper): void;
export function unregisterKeeper(k: RunStateKeeper): void;
export function activeKeepers(): readonly RunStateKeeper[];
export function runStateWrite(path: string, intent: WriteIntent, write: () => Promise<void>): Promise<void>;
```

`store/` imports nothing from `src/` except `@/config/paths` (keeps `utils/json-file` free of a cycle).

- [ ] **Step 1: Write the failing tests**

`paths.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { classifyRunStatePath } from "@/runstate/store";

describe("classifyRunStatePath (#2497)", () => {
  test.each([
    ["/r/.nax/features/f/prd.json", "prd", "/r"],
    ["/r/.nax/features/f/status.json", "status", "/r"],
    ["/r/.nax/features/f/decisions.jsonl", "decisions", "/r"],
    ["/r/.nax/features/f/workflow/run-1/result.json", "workflow-result", "/r"],
    ["/r/.nax/features/f/workflow/run-1/ledger.md", "ledger", "/r"],
    ["/r/pkg/.nax/features/f/prd.json", "prd", "/r/pkg"],
  ])("%s is %s under %s", (path, kind, root) => {
    expect(classifyRunStatePath(path)).toMatchObject({ kind, root, feature: "f" });
  });

  test.each([
    "/r/.nax/features/f/context.md",
    "/r/.nax/features/f/workflow/run-1/brief.md",
    "/r/.nax/config.json",
    "/r/src/prd.json",
    "/r/.nax/features/f/stories/US-1/prd.json",
  ])("%s is not run state", (path) => {
    expect(classifyRunStatePath(path)).toBeNull();
  });

  test("rel is root-relative", () => {
    expect(classifyRunStatePath("/r/.nax/features/f/workflow/run-1/ledger.md")?.rel).toBe(".nax/features/f/workflow/run-1/ledger.md");
  });
});
```

`keeper.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { assertDefined } from "@test/helpers";
import { classifyRunStatePath, RunStateKeeper } from "@/runstate/store";

const P = "/r/.nax/features/f/prd.json";

describe("RunStateKeeper", () => {
  test("records content per path, lists roots, owns only its feature", () => {
    const k = new RunStateKeeper("run-1", "f");
    const p = assertDefined(classifyRunStatePath(P), "path");
    k.record(P, p, "{}");
    expect(k.get(P)?.content).toBe("{}");
    expect(k.roots()).toEqual(["/r"]);
    expect(k.owns(assertDefined(classifyRunStatePath("/r/.nax/features/g/prd.json"), "g"))).toBe(false);
  });

  test("in-flight is counted, so overlapping writes keep the mark", () => {
    const k = new RunStateKeeper("run-1", "f");
    k.begin(P);
    k.begin(P);
    k.end(P);
    expect(k.isInFlight(P)).toBe(true);
    k.end(P);
    expect(k.isInFlight(P)).toBe(false);
  });
});
```

`registry.test.ts` (uses `makeTempDir` / `cleanupTempDir` from `@test/helpers`; unregister every keeper in `afterEach`):

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { activeKeepers, registerKeeper, RunStateKeeper, runStateWrite, unregisterKeeper } from "@/runstate/store";

let dir: string;
beforeEach(() => { dir = makeTempDir(); });
afterEach(() => {
  for (const k of activeKeepers()) unregisterKeeper(k);
  cleanupTempDir(dir);
});

async function featureFile(feature: string, name: string): Promise<string> {
  await mkdir(join(dir, ".nax/features", feature), { recursive: true });
  return join(dir, ".nax/features", feature, name);
}

describe("runStateWrite (#2497)", () => {
  test("no active keeper: just runs the write", async () => {
    const path = await featureFile("f", "prd.json");
    await runStateWrite(path, { content: "{}" }, () => Bun.write(path, "{}").then(() => undefined));
    expect(await Bun.file(path).text()).toBe("{}");
  });

  test("records the content before the write and clears the in-flight mark after", async () => {
    const k = new RunStateKeeper("r", "f");
    registerKeeper(k);
    const path = await featureFile("f", "prd.json");
    let seenDuringWrite: string | undefined;
    await runStateWrite(path, { content: "{\"a\":1}" }, async () => {
      seenDuringWrite = k.get(path)?.content;
      expect(k.isInFlight(path)).toBe(true);
      await Bun.write(path, "{\"a\":1}");
    });
    expect(seenDuringWrite).toBe("{\"a\":1}");
    expect(k.isInFlight(path)).toBe(false);
  });

  test("another feature's writes are not recorded (second run in the same repo)", async () => {
    const k = new RunStateKeeper("r", "f");
    registerKeeper(k);
    const other = await featureFile("g", "prd.json");
    await runStateWrite(other, { content: "{}" }, () => Bun.write(other, "{}").then(() => undefined));
    expect(k.files()).toEqual([]);
  });

  test("an append to an untracked existing file keeps the real base plus the chunk", async () => {
    const path = await featureFile("f", "decisions.jsonl");
    await Bun.write(path, "{\"id\":\"D-1\"}\n");
    const k = new RunStateKeeper("r", "f");
    registerKeeper(k);
    const chunk = "{\"id\":\"D-2\"}\n";
    await runStateWrite(path, { append: chunk }, () => appendFile(path, chunk));
    expect(k.get(path)?.content).toBe("{\"id\":\"D-1\"}\n{\"id\":\"D-2\"}\n");
    expect(k.get(path)?.content).toBe(await Bun.file(path).text());
  });

  test("a failing write still clears the in-flight mark and rethrows", async () => {
    const k = new RunStateKeeper("r", "f");
    registerKeeper(k);
    const path = await featureFile("f", "prd.json");
    await expect(runStateWrite(path, { content: "x" }, async () => { throw new Error("disk full"); })).rejects.toThrow("disk full");
    expect(k.isInFlight(path)).toBe(false);
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd packages/nax && timeout 30 bun test test/unit/runstate/ --timeout=5000`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

`store/paths.ts`:

```ts
/** Which files are nax run state (#2497). Pure: no IO. */
import { PROJECT_FEATURES_DIR } from "@/config/paths";

export type RunStateKind = "prd" | "status" | "workflow-result" | "ledger" | "decisions";

export interface RunStatePath {
  /** The directory holding `.nax/`, absolute. */
  readonly root: string;
  readonly feature: string;
  readonly kind: RunStateKind;
  /** Root-relative, `/`-joined. */
  readonly rel: string;
}

const FEATURE_FILES: Readonly<Record<string, RunStateKind>> = {
  "prd.json": "prd",
  "status.json": "status",
  "decisions.jsonl": "decisions",
};
const WORKFLOW_RUN_FILES: Readonly<Record<string, RunStateKind>> = {
  "result.json": "workflow-result",
  "ledger.md": "ledger",
};

function kindOf(tail: readonly string[]): RunStateKind | undefined {
  if (tail.length === 1) return FEATURE_FILES[tail[0] ?? ""];
  if (tail.length === 3 && tail[0] === "workflow") return WORKFLOW_RUN_FILES[tail[2] ?? ""];
  return undefined;
}

export function classifyRunStatePath(absPath: string): RunStatePath | null {
  const marker = `/${PROJECT_FEATURES_DIR}/`;
  const at = absPath.lastIndexOf(marker);
  if (at < 0) return null;
  const [feature, ...tail] = absPath.slice(at + marker.length).split("/");
  const kind = feature ? kindOf(tail) : undefined;
  if (!feature || !kind) return null;
  return { root: absPath.slice(0, at), feature, kind, rel: `${PROJECT_FEATURES_DIR}/${[feature, ...tail].join("/")}` };
}
```

`store/keeper.ts`:

```ts
/** The bytes nax last wrote for each run-state file of one run's feature (#2497). Internal maps are the keeper's own state. */
import type { RunStatePath } from "./paths";

export interface KeptFile extends RunStatePath {
  readonly path: string;
  readonly content: string;
}

export class RunStateKeeper {
  private readonly kept = new Map<string, KeptFile>();
  private readonly inFlight = new Map<string, number>();

  constructor(
    readonly runId: string,
    readonly feature: string,
  ) {}

  owns(p: RunStatePath): boolean {
    return p.feature === this.feature;
  }

  record(path: string, p: RunStatePath, content: string): void {
    this.kept.set(path, { ...p, path, content });
  }

  get(path: string): KeptFile | undefined {
    return this.kept.get(path);
  }

  files(): readonly KeptFile[] {
    return [...this.kept.values()];
  }

  roots(): readonly string[] {
    return [...new Set(this.files().map((f) => f.root))];
  }

  begin(path: string): void {
    this.inFlight.set(path, (this.inFlight.get(path) ?? 0) + 1);
  }

  end(path: string): void {
    const n = (this.inFlight.get(path) ?? 1) - 1;
    if (n <= 0) this.inFlight.delete(path);
    else this.inFlight.set(path, n);
  }

  isInFlight(path: string): boolean {
    return this.inFlight.has(path);
  }
}
```

`store/registry.ts`:

```ts
/**
 * Process-wide set of active run-state keepers (#2497), the same shape as the tool-audit sink
 * registry. Writers call runStateWrite; with no keeper active it only runs the write.
 */
import { resolve } from "node:path";
import type { RunStateKeeper } from "./keeper";
import { classifyRunStatePath } from "./paths";

export type WriteIntent = { readonly content: string } | { readonly append: string };

const active = new Set<RunStateKeeper>();

export function registerKeeper(k: RunStateKeeper): void {
  active.add(k);
}

export function unregisterKeeper(k: RunStateKeeper): void {
  active.delete(k);
}

export function activeKeepers(): readonly RunStateKeeper[] {
  return [...active];
}

async function baseContent(keeper: RunStateKeeper, path: string): Promise<string> {
  const kept = keeper.get(path);
  if (kept) return kept.content;
  const file = Bun.file(path);
  return (await file.exists()) ? await file.text() : "";
}

/** Record the intent first, so a concurrent repair restores exactly what nax is writing, then write. */
export async function runStateWrite(path: string, intent: WriteIntent, write: () => Promise<void>): Promise<void> {
  const abs = resolve(path);
  const classified = classifyRunStatePath(abs);
  const keepers = classified ? [...active].filter((k) => k.owns(classified)) : [];
  if (!classified || keepers.length === 0) return write();
  for (const k of keepers) {
    const content = "content" in intent ? intent.content : `${await baseContent(k, abs)}${intent.append}`;
    k.record(abs, classified, content);
    k.begin(abs);
  }
  try {
    await write();
  } finally {
    for (const k of keepers) k.end(abs);
  }
}
```

`store/index.ts`:

```ts
export { type KeptFile, RunStateKeeper } from "./keeper";
export { classifyRunStatePath, type RunStateKind, type RunStatePath } from "./paths";
export { activeKeepers, registerKeeper, runStateWrite, unregisterKeeper, type WriteIntent } from "./registry";
```

- [ ] **Step 4: Run and confirm pass**

Run the Step 2 command, then `bun run check:import-cycles && bun run check:feature-dir-ssot && bun run check:alias-internals`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/nax/src/runstate packages/nax/test/unit/runstate
git commit -m "feat(runstate): keeper and runStateWrite for nax-owned run state (#2497)"
```

---

### Task 7: Verify and repair, activation, fallback

**Files:**
- Create: `packages/nax/src/runstate/repair.ts`, `packages/nax/src/runstate/activate.ts`, `packages/nax/src/runstate/index.ts`
- Modify: `packages/nax/src/utils/nax-index-flags.ts` (export `hiddenNaxPaths`)
- Modify: `packages/nax/src/utils/git.ts` (`registerBeforeAutoCommit`, hook call in `autoCommitIfDirty`)
- Test: `packages/nax/test/unit/runstate/repair.test.ts`, `packages/nax/test/unit/runstate/activate.test.ts`, `packages/nax/test/unit/utils/auto-commit.test.ts`

**Interfaces:**
- Consumes: everything in `@/runstate/store` (Task 6).
- Produces (exported from `@/runstate`, which also re-exports `@/runstate/store`):

```ts
export type RepairTrigger = "turn" | "pre-commit" | "run-end" | "crash";
export interface RepairContext {
  readonly trigger: RepairTrigger;
  readonly storyId?: string;
  readonly sessionName?: string;
  readonly stage?: string;
  readonly turn?: number;
  /** Fallback only: the workdir the #2490 flag sweep runs on when no keeper is active. */
  readonly workdir?: string;
}
export type Damage = "missing" | "modified" | "hidden";
export interface RepairRecord { readonly path: string; readonly rel: string; readonly damage: readonly Damage[]; readonly restored: boolean }
export function repairRunState(ctx: RepairContext): Promise<readonly RepairRecord[]>; // never rejects
export interface RunStateHandle { readonly keeper: RunStateKeeper; deactivate(): void }
export function activateRunState(input: { runId: string; feature: string; root: string }): Promise<RunStateHandle>;
export const _repairDeps: { hiddenNaxPaths: typeof hiddenNaxPaths; clearNaxIndexFlags: typeof clearNaxIndexFlags; logger: () => IndexFlagLogger | null };
```

- Produces (from `src/utils/git.ts`): `registerBeforeAutoCommit(hook: (ctx: { workdir: string; stage: string; storyId: string }) => Promise<void>): () => void`.

- [ ] **Step 1: Write the failing tests**

`repair.test.ts`, against a real git repo (follow `test/unit/utils/nax-index-flags.test.ts`, but with `makeTempDir` / `cleanupTempDir` from `@test/helpers`):

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { _repairDeps, activateRunState, activeKeepers, repairRunState, type RunStateHandle, unregisterKeeper } from "@/runstate";
import { runStateWrite } from "@/runstate/store";
import { gitWithTimeout } from "@/utils/git";

const PRD = ".nax/features/f/prd.json";
const NAX_PRD = "{\"stories\":\"nax\"}";
let dir: string;
let handle: RunStateHandle | undefined;

/** nax's own write: recorded by the keeper (Task 8 later routes the real writers through runStateWrite). */
async function naxWrite(path: string, content: string): Promise<void> {
  await runStateWrite(path, { content }, async () => {
    await Bun.write(path, content);
  });
}
const warnings: { message: string; data?: Record<string, unknown> }[] = [];
const origLogger = _repairDeps.logger;

async function git(...args: string[]): Promise<string> {
  return (await gitWithTimeout(args, dir)).stdout;
}

beforeEach(async () => {
  dir = makeTempDir();
  for (const args of [["init", "-q"], ["config", "user.email", "t@example.com"], ["config", "user.name", "t"]]) await git(...args);
  mkdirSync(join(dir, ".nax/features/f"), { recursive: true });
  writeFileSync(join(dir, PRD), "{\"stories\":\"seed\"}");
  await git("add", "-A");
  await git("commit", "-q", "-m", "seed");
  _repairDeps.logger = () => ({ warn: (_s: string, message: string, data?: Record<string, unknown>) => warnings.push({ message, data }) });
  handle = await activateRunState({ runId: "r1", feature: "f", root: dir });
  await naxWrite(join(dir, PRD), NAX_PRD);
});

afterEach(() => {
  handle?.deactivate();
  for (const k of activeKeepers()) unregisterKeeper(k);
  _repairDeps.logger = origLogger;
  warnings.length = 0;
  cleanupTempDir(dir);
});

const ctx = { trigger: "turn" as const, storyId: "US-002", sessionName: "s1", stage: "implementer", turn: 3 };

describe("repairRunState (#2497)", () => {
  test("restores a reverted file and warns with session, step and turn", async () => {
    await git("checkout", "--", PRD);
    const records = await repairRunState(ctx);
    expect(await Bun.file(join(dir, PRD)).text()).toBe(NAX_PRD);
    expect(records).toEqual([{ path: join(dir, PRD), rel: PRD, damage: ["modified"], restored: true }]);
    expect(warnings[0]?.message).toBe(`US-002 implementer turn 3: ${PRD} modified by the agent; restored`);
    expect(Object.keys(warnings[0]?.data ?? {})[0]).toBe("storyId");
  });

  test("recreates a deleted feature directory", async () => {
    rmSync(join(dir, ".nax/features/f"), { recursive: true, force: true });
    const records = await repairRunState(ctx);
    expect(records[0]?.damage).toEqual(["missing"]);
    expect(await Bun.file(join(dir, PRD)).text()).toBe(NAX_PRD);
  });

  test("clears skip-worktree on a tracked file", async () => {
    await git("update-index", "--skip-worktree", PRD);
    const records = await repairRunState(ctx);
    expect(records[0]?.damage).toEqual(["hidden"]);
    expect(await git("ls-files", "-v", "--", PRD)).toMatch(/^H /);
  });

  test("an intact file is not reported", async () => {
    expect(await repairRunState(ctx)).toEqual([]);
    expect(warnings).toEqual([]);
  });

  test("a file being written by nax is skipped", async () => {
    const keeper = activeKeepers()[0];
    keeper?.begin(join(dir, PRD));
    await git("checkout", "--", PRD);
    expect(await repairRunState(ctx)).toEqual([]);
    keeper?.end(join(dir, PRD));
  });

  test("a workflow ledger tracked under the root gets one repair line", async () => {
    const ledger = join(dir, ".nax/features/f/workflow/run-1/ledger.md");
    mkdirSync(join(dir, ".nax/features/f/workflow/run-1"), { recursive: true });
    await naxWrite(ledger, "# Workflow ledger\n");
    await git("checkout", "--", PRD);
    await repairRunState(ctx);
    expect(await Bun.file(ledger).text()).toBe(`# Workflow ledger\nUS-002: run-state repaired: ${PRD} (modified)\n`);
    expect(await repairRunState(ctx)).toEqual([]); // the ledger line is nax's own write, never flagged
  });

  test("never rejects when git fails; falls back to the flag sweep with no keeper", async () => {
    const origHidden = _repairDeps.hiddenNaxPaths;
    _repairDeps.hiddenNaxPaths = async () => { throw new Error("git gone"); };
    await expect(repairRunState(ctx)).resolves.toBeDefined();
    _repairDeps.hiddenNaxPaths = origHidden;

    handle?.deactivate();
    const swept: string[] = [];
    const origClear = _repairDeps.clearNaxIndexFlags;
    _repairDeps.clearNaxIndexFlags = async (workdir) => { swept.push(workdir); return []; };
    await repairRunState({ trigger: "run-end", workdir: dir });
    _repairDeps.clearNaxIndexFlags = origClear;
    expect(swept).toEqual([dir]);
  });
});
```

`activate.test.ts` (same `makeTempDir` / `cleanupTempDir` lifecycle as `repair.test.ts`; imports `mkdirSync`, `writeFileSync` from `node:fs`, `join` from `node:path`, `activateRunState`, `activeKeepers` from `@/runstate`):

```ts
  test("seeds prd.json, status.json and decisions.jsonl that exist; deactivate unregisters and unhooks", async () => {
    mkdirSync(join(dir, ".nax/features/f"), { recursive: true });
    writeFileSync(join(dir, ".nax/features/f/prd.json"), "{}");
    writeFileSync(join(dir, ".nax/features/f/decisions.jsonl"), "");
    const handle = await activateRunState({ runId: "r1", feature: "f", root: dir });
    expect(handle.keeper.files().map((f) => f.kind).sort()).toEqual(["decisions", "prd"]);
    expect(activeKeepers()).toContain(handle.keeper);
    handle.deactivate();
    expect(activeKeepers()).not.toContain(handle.keeper);
  });
```

In `test/unit/utils/auto-commit.test.ts`, inside `describe("autoCommitIfDirty", ...)` (it already restores `_gitDeps.spawn` via `withDepsRestore` and builds fakes with `makeSpawn`); import `registerBeforeAutoCommit` alongside `autoCommitIfDirty`:

```ts
  test("before-auto-commit hooks run first; a throwing hook does not block the commit (#2497)", async () => {
    const order: string[] = [];
    _gitDeps.spawn = makeSpawn(({ cmd }) => {
      if (cmd.includes("rev-parse")) return "/repo\n";
      if (cmd.includes("status")) return " M src/foo.ts\n";
      if (cmd.includes("--cached")) return { exitCode: 1 };
      if (cmd.includes("commit")) order.push("commit");
      return "";
    }).spawn;
    const unhookA = registerBeforeAutoCommit(async (c) => {
      order.push(`hook:${c.stage}:${c.storyId}`);
    });
    const unhookB = registerBeforeAutoCommit(async () => {
      throw new Error("boom");
    });
    await autoCommitIfDirty("/repo", "run.complete", "run-summary", "US-001");
    unhookA();
    unhookB();
    expect(order).toEqual(["hook:run.complete:US-001", "commit"]);
  });

  test("a dry run skips the hooks", async () => {
    let ran = false;
    const unhook = registerBeforeAutoCommit(async () => {
      ran = true;
    });
    await autoCommitIfDirty("/repo", "s", "r", "US-001", undefined, true);
    unhook();
    expect(ran).toBe(false);
  });
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd packages/nax && timeout 60 bun test test/unit/runstate/ test/unit/utils/auto-commit.test.ts --timeout=10000`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement**

`nax-index-flags.ts`: change `async function hiddenNaxPaths` to `export async function hiddenNaxPaths`.

`utils/git.ts`, above `autoCommitIfDirty`:

```ts
/** Context handed to before-auto-commit hooks (#2497: run-state repair runs here). */
export interface AutoCommitHookContext {
  readonly workdir: string;
  readonly stage: string;
  readonly storyId: string;
}
type AutoCommitHook = (ctx: AutoCommitHookContext) => Promise<void>;
const beforeAutoCommitHooks = new Set<AutoCommitHook>();

/** Registers a hook awaited before every auto-commit; returns its unregister. utils/git never imports the hook owners. */
export function registerBeforeAutoCommit(hook: AutoCommitHook): () => void {
  beforeAutoCommitHooks.add(hook);
  return () => {
    beforeAutoCommitHooks.delete(hook);
  };
}
```

and in `autoCommitIfDirty`, right after the dry-run early return:

```ts
  for (const hook of [...beforeAutoCommitHooks]) {
    await hook({ workdir, stage, storyId }).catch((err: unknown) =>
      logger?.warn(stage, "auto-commit: before-commit hook failed", { storyId, error: errorMessage(err) }),
    );
  }
```

(import `errorMessage` from `@nathapp/nax-agent/internal` if `utils/git.ts` does not already.)

`runstate/repair.ts`:

```ts
/** Detect and repair agent damage to nax run state (#2497). Never throws. */
import { appendFile, mkdir, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { errorMessage } from "@nathapp/nax-agent/internal";
import { getSafeLogger } from "../logger";
import { clearNaxIndexFlags, hiddenNaxPaths, type IndexFlagLogger } from "../utils/nax-index-flags";
import { activeKeepers, type KeptFile, type RunStateKeeper, runStateWrite } from "./store";

export type RepairTrigger = "turn" | "pre-commit" | "run-end" | "crash";
export interface RepairContext {
  readonly trigger: RepairTrigger;
  readonly storyId?: string;
  readonly sessionName?: string;
  readonly stage?: string;
  readonly turn?: number;
  readonly workdir?: string;
}
export type Damage = "missing" | "modified" | "hidden";
export interface RepairRecord {
  readonly path: string;
  readonly rel: string;
  readonly damage: readonly Damage[];
  readonly restored: boolean;
}

export const _repairDeps = {
  hiddenNaxPaths,
  clearNaxIndexFlags,
  logger: (): IndexFlagLogger | null => getSafeLogger() ?? null,
};

async function damageOf(f: KeptFile, hidden: ReadonlySet<string>): Promise<Damage[]> {
  const file = Bun.file(f.path);
  const exists = await file.exists();
  const content = exists ? await file.text() : undefined;
  return [
    ...(!exists ? (["missing"] as const) : []),
    ...(exists && content !== f.content ? (["modified"] as const) : []),
    ...(hidden.has(f.rel) ? (["hidden"] as const) : []),
  ];
}

async function restore(f: KeptFile): Promise<void> {
  await mkdir(dirname(f.path), { recursive: true });
  const tmp = `${f.path}.runstate-${crypto.randomUUID()}`;
  await Bun.write(tmp, f.content);
  await rename(tmp, f.path);
}

function where(ctx: RepairContext): string {
  return [ctx.storyId ?? "_run", ctx.stage, ctx.turn !== undefined ? `turn ${ctx.turn}` : ctx.trigger]
    .filter((p): p is string => p !== undefined)
    .join(" ");
}

async function repairFile(f: KeptFile, damage: Damage[], ctx: RepairContext): Promise<RepairRecord> {
  const log = _repairDeps.logger();
  const data = { storyId: ctx.storyId ?? "_run", sessionName: ctx.sessionName, stage: ctx.stage, turn: ctx.turn, trigger: ctx.trigger, path: f.rel, damage };
  try {
    if (damage.includes("missing") || damage.includes("modified")) await restore(f);
    log?.warn("runstate", `${where(ctx)}: ${f.rel} ${damage.join("+")} by the agent; restored`, data);
    return { path: f.path, rel: f.rel, damage, restored: true };
  } catch (err) {
    log?.warn("runstate", `[FAIL] ${where(ctx)}: could not restore ${f.rel}`, { ...data, error: errorMessage(err) });
    return { path: f.path, rel: f.rel, damage, restored: false };
  }
}

async function noteInLedgers(keeper: RunStateKeeper, root: string, records: readonly RepairRecord[], ctx: RepairContext): Promise<void> {
  const ledgers = keeper.files().filter((f) => f.root === root && f.kind === "ledger");
  for (const ledger of ledgers) {
    for (const r of records) {
      const line = `${ctx.storyId ?? "_run"}: run-state repaired: ${r.rel} (${r.damage.join("+")})\n`;
      await runStateWrite(ledger.path, { append: line }, () => appendFile(ledger.path, line));
    }
  }
}

async function repairRoot(keeper: RunStateKeeper, root: string, ctx: RepairContext): Promise<RepairRecord[]> {
  const files = keeper.files().filter((f) => f.root === root && !keeper.isInFlight(f.path));
  if (files.length === 0) return [];
  const log = _repairDeps.logger();
  const hidden = new Set(await _repairDeps.hiddenNaxPaths(root, log));
  if (files.some((f) => hidden.has(f.rel))) await _repairDeps.clearNaxIndexFlags(root, log);
  const records: RepairRecord[] = [];
  for (const f of files) {
    const damage = await damageOf(f, hidden);
    if (damage.length > 0) records.push(await repairFile(f, damage, ctx));
  }
  if (records.length > 0) await noteInLedgers(keeper, root, records, ctx);
  return records;
}

async function repairAll(ctx: RepairContext): Promise<RepairRecord[]> {
  const keepers = activeKeepers();
  if (keepers.length === 0) {
    if (ctx.workdir) await _repairDeps.clearNaxIndexFlags(ctx.workdir, _repairDeps.logger());
    return [];
  }
  const out: RepairRecord[] = [];
  for (const k of keepers) for (const root of k.roots()) out.push(...(await repairRoot(k, root, ctx)));
  return out;
}

let chain: Promise<unknown> = Promise.resolve();

/** Serialised: two sessions ending turns at once never repair concurrently. Never rejects. */
export function repairRunState(ctx: RepairContext): Promise<readonly RepairRecord[]> {
  const next = chain.then(
    () => repairAll(ctx),
    () => repairAll(ctx),
  );
  chain = next.catch(() => undefined);
  return next.catch((err: unknown) => {
    _repairDeps.logger()?.warn("runstate", "Run-state repair failed", { storyId: ctx.storyId ?? "_run", error: errorMessage(err) });
    return [];
  });
}
```

If `repairRoot` grows past 30 lines or `check:complexity` flags it, split the hidden-flag clearing into its own helper; do not raise the complexity baseline.

`runstate/activate.ts`:

```ts
/** One run-state keeper per run, scoped to the run's feature (#2497). */
import { join } from "node:path";
import { featureDir } from "@/config/paths";
import { registerBeforeAutoCommit } from "../utils/git";
import { repairRunState } from "./repair";
import { classifyRunStatePath, RunStateKeeper, registerKeeper, unregisterKeeper } from "./store";

const SEEDED = ["prd.json", "status.json", "decisions.jsonl"] as const;

export interface RunStateHandle {
  readonly keeper: RunStateKeeper;
  deactivate(): void;
}

async function seed(keeper: RunStateKeeper, root: string): Promise<void> {
  for (const name of SEEDED) {
    const path = join(featureDir(root, keeper.feature), name);
    const classified = classifyRunStatePath(path);
    const file = Bun.file(path);
    if (classified && (await file.exists())) keeper.record(path, classified, await file.text());
  }
}

export async function activateRunState(input: { runId: string; feature: string; root: string }): Promise<RunStateHandle> {
  const keeper = new RunStateKeeper(input.runId, input.feature);
  await seed(keeper, input.root);
  registerKeeper(keeper);
  const unhook = registerBeforeAutoCommit(async (c) => {
    await repairRunState({ trigger: "pre-commit", storyId: c.storyId, stage: c.stage, workdir: c.workdir });
  });
  return {
    keeper,
    deactivate: () => {
      unhook();
      unregisterKeeper(keeper);
    },
  };
}
```

Use `featureDir` from wherever `@/config/paths` exports it (it is in `src/config/paths/index.ts:119`). Check `featureDir(root, f)` returns an absolute path when `root` is absolute.

`runstate/index.ts`:

```ts
export { activateRunState, type RunStateHandle } from "./activate";
export {
  _repairDeps,
  type Damage,
  type RepairContext,
  type RepairRecord,
  type RepairTrigger,
  repairRunState,
} from "./repair";
export * from "./store";
```

(if the repo's Biome config forbids `export *`, list the store exports explicitly.)

- [ ] **Step 4: Run and confirm pass**

Run the Step 2 command, then `bun run check:import-cycles && bun run check:complexity && bun run check:logger-storyid`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/nax/src/runstate packages/nax/src/utils packages/nax/test
git commit -m "feat(runstate): repair reverted, deleted or hidden run state; auto-commit hook (#2497)"
```

---

### Task 8: Writers record through runStateWrite

**Files:**
- Modify: `packages/nax/src/utils/json-file.ts:129` (`atomicWriteText`, covers `savePRD` and `persist-prd`)
- Modify: `packages/nax/src/execution/status-file.ts:433-456` (`writeStatusFile`, covers heartbeat, feature and crash status)
- Modify: `packages/nax/src/workflow/result.ts:57-62` (`writeResult`)
- Modify: `packages/nax/src/workflow/ledger.ts:30-51` (`ensureLedger`, `appendLedger`)
- Modify: `packages/nax/src/advisor/ledger.ts:77-89` (`appendDecision`)
- Test: `packages/nax/test/integration/runstate/writers.test.ts`

**Interfaces:**
- Consumes: `runStateWrite`, `RunStateKeeper`, `registerKeeper`, `unregisterKeeper` from `@/runstate/store` (Task 6).
- Produces: after any of the five writers runs inside an active keeper's feature, `keeper.get(path)?.content === await Bun.file(path).text()`.

- [ ] **Step 1: Write the failing test**

`test/integration/runstate/writers.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { cleanupTempDir, makePRD, makeTempDir } from "@test/helpers";
import { type AdviceDecision, appendDecision } from "@/advisor";
import { buildStatusSnapshot, writeStatusFile } from "@/execution/status-file";
import { savePRD } from "@/prd";
import { RunStateKeeper, registerKeeper, unregisterKeeper } from "@/runstate/store";
import { appendLedger, ensureLedger } from "@/workflow/ledger";
import { newFeatureRecord } from "@/workflow/feature-record";
import { upsertFeatureRecord } from "@/workflow/result";

let dir: string;
let keeper: RunStateKeeper;
const fdir = () => join(dir, ".nax/features/f");

const decisionDraft: Omit<AdviceDecision, "id"> = {
  questionId: "Q",
  kind: "finish-judgment",
  chosenOptionId: "A",
  action: { type: "fix", instruction: "x" },
  rationale: "r",
  confidence: "high",
  reversible: true,
  needsHumanConfirm: false,
  decidedAt: "2026-10-10T00:00:00Z",
  model: "m",
  memoryMode: "stateless",
  auditRef: "a",
};

beforeEach(async () => {
  dir = makeTempDir();
  await mkdir(join(fdir(), "workflow/run-1"), { recursive: true });
  keeper = new RunStateKeeper("run-1", "f");
  registerKeeper(keeper);
});
afterEach(() => {
  unregisterKeeper(keeper);
  cleanupTempDir(dir);
});

async function expectKept(path: string): Promise<void> {
  expect(keeper.get(path)?.content).toBe(await Bun.file(path).text());
  expect(keeper.isInFlight(path)).toBe(false);
}

describe("run-state writers record what they write (#2497)", () => {
  test("savePRD", async () => {
    const path = join(fdir(), "prd.json");
    await savePRD(makePRD(), path);
    await expectKept(path);
  });

  test("writeStatusFile", async () => {
    const path = join(fdir(), "status.json");
    const status = buildStatusSnapshot({
      runId: "run-1",
      feature: "f",
      startedAt: "2026-10-13T00:00:00.000Z",
      runStatus: "running",
      dryRun: false,
      pid: process.pid,
      prd: makePRD(),
      totalCost: 0,
      costLimit: 5,
      currentStory: null,
      iterations: 0,
      startTimeMs: Date.now(),
    });
    await writeStatusFile(path, status);
    await expectKept(path);
  });

  test("workflow result.json", async () => {
    const runDir = join(fdir(), "workflow/run-1");
    await upsertFeatureRecord(runDir, { runId: "run-1", feature: "f" }, newFeatureRecord({ now: "t", seed: null, minors: [] }));
    await expectKept(join(runDir, "result.json"));
  });

  test("workflow ledger header and appends", async () => {
    const runDir = join(fdir(), "workflow/run-1");
    await ensureLedger(runDir, "run-1", "f");
    await appendLedger(runDir, "US-001", "note one", { mirror: false });
    await appendLedger(runDir, "US-001", "note two", { mirror: false });
    await expectKept(join(runDir, "ledger.md"));
  });

  test("advisor decisions.jsonl appends", async () => {
    await appendDecision(dir, "f", decisionDraft);
    await appendDecision(dir, "f", { ...decisionDraft, questionId: "Q2" });
    await expectKept(join(fdir(), "decisions.jsonl"));
  });
});
```

The status fixture mirrors `makeRunState()` in `test/integration/execution/status-file.test.ts`; the decision draft mirrors `draft()` in `test/unit/advisor/ledger.test.ts`. If `appendDecision` or `AdviceDecision` is not exported from `@/advisor`, import from the path `test/unit/advisor/ledger.test.ts` uses.

- [ ] **Step 2: Run and confirm failure**

Run: `cd packages/nax && timeout 30 bun test test/integration/runstate/writers.test.ts --timeout=10000`
Expected: FAIL (keeper empty).

- [ ] **Step 3: Implement**

`utils/json-file.ts`: import `runStateWrite` from `"../runstate/store"`; rename the current body of `atomicWriteText` to a private `writeTextAtomically(path, content, context)` and make:

```ts
export async function atomicWriteText(path: string, content: string, context = "json-file"): Promise<void> {
  // #2497: run-state files are recorded for repair; any other path is written as before.
  await runStateWrite(path, { content }, () => writeTextAtomically(path, content, context));
}
```

`execution/status-file.ts` `writeStatusFile`: compute the text once and wrap the write:

```ts
  const text = JSON.stringify(status, null, 2);
  await runStateWrite(resolvedPath, { content: text }, async () => {
    await Bun.write(tmpPath, text);
    await rename(tmpPath, resolvedPath);
  });
```

(keep the path-traversal check and the stale `.tmp` cleanup before it.)

`workflow/result.ts` `writeResult`:

```ts
async function writeResult(runDir: string, next: WorkflowResultFile): Promise<void> {
  await _resultDeps.mkdir(runDir, { recursive: true });
  const path = join(runDir, RESULT_FILE);
  const tmp = `${path}.tmp`;
  const text = `${JSON.stringify(next, null, 2)}\n`;
  await runStateWrite(path, { content: text }, async () => {
    await Bun.write(tmp, text);
    await _resultDeps.rename(tmp, path);
  });
}
```

`workflow/ledger.ts`:

```ts
export async function ensureLedger(runDir: string, runId: string, feature: string): Promise<void> {
  const path = ledgerFilePath(runDir);
  if (await Bun.file(path).exists()) return;
  await _ledgerDeps.mkdir(runDir, { recursive: true });
  const header = `# Workflow ledger — run: ${runId} — feature: ${feature}\n`;
  await runStateWrite(path, { content: header }, async () => {
    await Bun.write(path, header);
  });
}

export async function appendLedger(runDir: string, storyId: string, text: string, options: LedgerWriteOptions = {}): Promise<void> {
  const path = ledgerFilePath(runDir);
  const line = `${storyId}: ${text}\n`;
  await runStateWrite(path, { append: line }, () => _ledgerDeps.appendFile(path, line));
  if (options.mirror !== false) mirrorLedger(storyId, text);
}
```

`advisor/ledger.ts` `appendDecision`, inside `withLock`:

```ts
    const chunk = `${prefix}${JSON.stringify(decision)}\n`;
    await runStateWrite(path, { append: chunk }, () => _ledgerDeps.appendText(path, chunk));
    return decision;
```

All three `src/workflow` / `src/advisor` / `src/execution` files import `runStateWrite` from `@/runstate/store`.

- [ ] **Step 4: Run and confirm pass**

Run the Step 2 command, then `bun run check:import-cycles` and `timeout 300 bun test test/unit/prd/ test/unit/execution/ test/unit/workflow/ test/unit/advisor/ test/unit/utils/ --timeout=10000`. Expected: PASS, no new cycle. If `check:import-cycles` reports `utils/json-file` newly cyclic, the store imported something beyond `@/config/paths`: remove that import, do not update the baseline.

- [ ] **Step 5: Commit**

```bash
git add packages/nax/src packages/nax/test/integration/runstate
git commit -m "feat(runstate): run-state writers record through runStateWrite (#2497)"
```

---

### Task 9: Repair after every turn, before every commit, at run end and crash

**Files:**
- Create: `packages/nax/src/session/turn-hooks.ts`
- Modify: `packages/nax/src/session/manager.ts` (net SHRINK: lines 90-92 field, 103-125 `configureRuntime`, 574-582 loop-handler block, 618-623 `finally`)
- Modify: `packages/nax/src/runtime/index.ts:402-415` (`afterTurn` wiring)
- Modify: `packages/nax/src/execution/runner.ts` (activation after setup; `426` sweep swap; deactivate)
- Modify: `packages/nax/src/execution/runner-completion.ts:542` (sweep swap, net zero lines)
- Modify: `packages/nax/src/execution/crash-signals.ts:20, 166` (sweep swap)
- Modify: `packages/nax/scripts/baselines/file-sizes-baseline.json` (via `bun run check:file-sizes:update`, only after `manager.ts` shrank)
- Test: `packages/nax/test/unit/session/turn-hooks.test.ts`, `packages/nax/test/unit/session/manager.test.ts` (or the existing sendPrompt test file), `packages/nax/test/unit/execution/crash-signals.test.ts`, `packages/nax/test/unit/execution/runner*.test.ts` touched by `_runnerDeps`

**Interfaces:**
- Consumes: `repairRunState`, `activateRunState` (Task 7).
- Produces: `TurnHooks` class (`setAfterTurn(hook)`, `loopHandlerOpts(handle, descriptor, set)`, `afterTurn(descriptor, sessionName)`), `AfterTurnHook = (desc: SessionDescriptor, turn: number) => Promise<void>`; `SessionManager.configureRuntime({ afterTurn?: AfterTurnHook })`; `_runnerDeps.activateRunState`.

- [ ] **Step 1: Write the failing tests**

`turn-hooks.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { TurnHooks } from "@/session/turn-hooks";
import type { SessionDescriptor } from "@/session";

const desc = { id: "sess-1", role: "implementer", storyId: "US-001" } as SessionDescriptor; // use the repo's descriptor factory if one exists in @test/helpers

describe("TurnHooks.afterTurn (#2497)", () => {
  test("counts turns per session and passes the descriptor", async () => {
    const seen: [string, number][] = [];
    const hooks = new TurnHooks();
    hooks.setAfterTurn(async (d, turn) => { seen.push([d.id, turn]); });
    await hooks.afterTurn(desc, "sess-1");
    await hooks.afterTurn(desc, "sess-1");
    await hooks.afterTurn({ ...desc, id: "sess-2" }, "sess-2");
    expect(seen).toEqual([["sess-1", 1], ["sess-1", 2], ["sess-2", 1]]);
  });

  test("a throwing hook is swallowed", async () => {
    const hooks = new TurnHooks();
    hooks.setAfterTurn(async () => { throw new Error("git gone"); });
    await expect(hooks.afterTurn(desc, "sess-1")).resolves.toBeUndefined();
  });

  test("no hook, no descriptor: no-op", async () => {
    await expect(new TurnHooks().afterTurn(undefined, "sess-1")).resolves.toBeUndefined();
  });
});
```

If `as SessionDescriptor` is flagged by `check:test-escape-hatches` (`looseCast`), build a full descriptor literal instead.

In the SessionManager `sendPrompt` test file (find it with `grep -rln "sendPrompt" packages/nax/test/unit/session`), using `makeAgentAdapter` from `@test/helpers`:

```ts
  test("afterTurn runs after a turn that throws; the turn's error reaches the caller (#2497)", async () => {
    const turns: number[] = [];
    // build the manager + an adapter whose sendTurn rejects with new Error("turn failed"), as the file's other tests do
    manager.configureRuntime({ afterTurn: async (_d, turn) => { turns.push(turn); throw new Error("repair failed"); } });
    await expect(manager.sendPrompt(handle, "go")).rejects.toThrow("turn failed");
    expect(turns).toEqual([1]);
  });

  test("afterTurn runs after a successful turn and the result is returned", async () => {
    const turns: number[] = [];
    manager.configureRuntime({ afterTurn: async (_d, turn) => { turns.push(turn); } });
    const result = await manager.sendPrompt(handle, "go");
    expect(result.output).toBeDefined();
    expect(turns).toEqual([1]);
  });
```

In `crash-signals.test.ts`, change the #2490 sweep test so it asserts `repairRunState` runs (mock via `_repairDeps.clearNaxIndexFlags` capturing the workdir, with no keeper active), still bounded by the 2000 ms budget.

- [ ] **Step 2: Run and confirm failure**

Run: `cd packages/nax && timeout 60 bun test test/unit/session/ test/unit/execution/crash-signals.test.ts --timeout=10000`
Expected: FAIL.

- [ ] **Step 3: Implement**

`src/session/turn-hooks.ts`:

```ts
/** Per-turn work SessionManager runs around adapter.sendTurn: plugin loop handlers, and the afterTurn hook (#2497). */
import { errorMessage } from "@nathapp/nax-agent/internal";
import { getLogger } from "../logger";
// import buildLoopHandlerTurnOpts, LOOP_HANDLERS_NATIVE_ONLY_MESSAGE, shouldLogNativeOnlyScope
// from the same module session/manager.ts imports them from today (manager.ts lines 20-24),
// plus the SessionHandle / SessionDescriptor / LoopHandlerSet types manager.ts uses.

export type AfterTurnHook = (desc: SessionDescriptor, turn: number) => Promise<void>;

export class TurnHooks {
  private scopeLogged = false;
  private hook: AfterTurnHook | undefined;
  private readonly turns = new Map<string, number>();

  setAfterTurn(hook: AfterTurnHook): void {
    this.hook = hook;
  }

  /** US-004: deliver the run's loop handlers; say once when a non-native session cannot use them. */
  loopHandlerOpts(handle: SessionHandle, descriptor: SessionDescriptor | undefined, set: LoopHandlerSet) {
    const opts = buildLoopHandlerTurnOpts({ handle, descriptor, set });
    if (shouldLogNativeOnlyScope(set, handle, this.scopeLogged)) {
      this.scopeLogged = true;
      getLogger().info("plugins", LOOP_HANDLERS_NATIVE_ONLY_MESSAGE, { sessionName: handle.id });
    }
    return opts;
  }

  /** Awaited in sendPrompt's finally; never throws, so the turn's own result or error wins. */
  async afterTurn(desc: SessionDescriptor | undefined, sessionName: string): Promise<void> {
    if (!this.hook || !desc) return;
    const turn = (this.turns.get(sessionName) ?? 0) + 1;
    this.turns.set(sessionName, turn);
    try {
      await this.hook(desc, turn);
    } catch (err) {
      getLogger().warn("session", "afterTurn hook failed", { storyId: desc.storyId, sessionName, error: errorMessage(err) });
    }
  }
}
```

Match the parameter type of `buildLoopHandlerTurnOpts`'s `descriptor` exactly (it is whatever `terminalDesc` is today).

`src/session/manager.ts`:
- Replace the field `private _loopHandlerScopeLogged = false;` (line 92) with `private readonly _turnHooks = new TurnHooks();`.
- In `configureRuntime`'s options type add `afterTurn?: AfterTurnHook;` and in its body `if (opts.afterTurn) this._turnHooks.setAfterTurn(opts.afterTurn);`.
- Replace lines 574-582 (the US-004 comment, `const loopHandlerOpts = ...`, and the `if (shouldLogNativeOnlyScope ...)` block) with:

```ts
    const loopHandlerOpts = this._turnHooks.loopHandlerOpts(handle, terminalDesc, this._loopHandlers);
```

- In the `finally` after `this._busySessions.delete(handle.id);` add:

```ts
      await this._turnHooks.afterTurn(terminalDesc, handle.id); // #2497 run-state repair
```

- Remove the now-unused imports (`buildLoopHandlerTurnOpts`, `LOOP_HANDLERS_NATIVE_ONLY_MESSAGE`, `shouldLogNativeOnlyScope` if nothing else uses them) and import `TurnHooks`, `AfterTurnHook` from `./turn-hooks`.
- Check: `wc -l src/session/manager.ts` must be below 658. Then run `bun run check:file-sizes:update` to lower its baseline, and confirm the JSON diff only lowers `src/session/manager.ts`.

`src/runtime/index.ts` in `sessionManager.configureRuntime({...})`:

```ts
      // #2497: repair nax run state after every agent turn (native and ACP).
      afterTurn: async (desc, turn) => {
        await repairRunState({ trigger: "turn", storyId: desc.storyId, sessionName: desc.handle ?? desc.id, stage: desc.role, turn });
      },
```

(import `repairRunState` from `@/runstate`.)

`src/execution/runner.ts`:
- Add `activateRunState` to `_runnerDeps` (import from `../runstate`), so runner tests can stub it.
- Immediately after the setup `try { setupResult = await _runnerDeps.runSetupPhase(...) } catch ...` block:

```ts
  // #2497: track nax run state for this run's feature so agent damage is repaired.
  const runState = feature ? await _runnerDeps.activateRunState({ runId, feature, root: workdir }) : null;
```

- In the finally at line 426 replace `await clearNaxIndexFlags(workdir, logger);` with:

```ts
      await repairRunState({ trigger: "run-end", workdir });
      runState?.deactivate();
```

and update the #2490 comment above it to "#2490/#2497: idempotent repair; covers an execution-phase throw that skipped the completion-phase repair. Never throws." Drop the `clearNaxIndexFlags` import if unused. If `runState` is not in scope at that finally (it sits in a nested `try`), declare `let runState: RunStateHandle | null = null;` before the outer `try` and assign it after setup instead.
- Stub `activateRunState` in the runner tests' `_runnerDeps` save/restore so they do not touch real files (`async () => ({ keeper: new RunStateKeeper("r", "f"), deactivate: () => {} })`).

`src/execution/runner-completion.ts:542`: replace `await clearNaxIndexFlags(options.workdir, logger);` with `await repairRunState({ trigger: "run-end", workdir: options.workdir });` and swap the import line. Comment above: replace "#2490: un-hide any .nax path" with "#2490/#2497: repair any run state an agent reverted, deleted or hid,". `wc -l` must stay 578.

`src/execution/crash-signals.ts`: replace the `clearNaxIndexFlags` import with `import { repairRunState } from "../runstate";` and line 166 with:

```ts
    await Promise.race([repairRunState({ trigger: "crash", workdir: ctx.workdir }).then(() => undefined), budget]);
```

- [ ] **Step 4: Run and confirm pass**

Run the Step 2 command, then:
`timeout 300 bun test test/unit/session/ test/unit/execution/ test/unit/runtime/ --timeout=10000`, `bun run typecheck`, `bun run check:file-sizes`, `bun run check:import-cycles`, and `bun test test/integration/cli/adapter-boundary.test.ts --timeout=30000` with a `timeout 60` prefix. Expected: all PASS; `manager.ts` baseline lowered.

- [ ] **Step 5: Commit**

```bash
git add packages/nax/src packages/nax/test packages/nax/scripts/baselines/file-sizes-baseline.json
git commit -m "feat(runstate): repair after every turn, before commits, at run end and crash (#2497)"
```

---

### Task 10: Bypass matrix through a real git repo; guard header points at repair

**Files:**
- Create: `packages/nax/test/integration/runstate/bypass-matrix.test.ts`
- Modify: `packages/nax-agent/src/tools/nax-state-guard.ts:75` (KNOWN, NOT FIXED header)
- Test: the new file

**Interfaces:**
- Consumes: `activateRunState`, `repairRunState`, `atomicWriteText` (Tasks 7-8).

- [ ] **Step 1: Write the test**

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { activateRunState, type RunStateHandle, repairRunState } from "@/runstate";
import { gitWithTimeout } from "@/utils/git";
import { atomicWriteText } from "@/utils/json-file";

const PRD = ".nax/features/f/prd.json";
const STATUS = ".nax/features/f/status.json";
const NAX_PRD = "{\"stories\":\"nax\"}";
const NAX_STATUS = "{\"status\":\"running\"}";
let dir: string;
let handle: RunStateHandle;

async function git(...args: string[]): Promise<string> {
  return (await gitWithTimeout(args, dir)).stdout;
}

async function sh(cmd: string, env: Record<string, string> = {}): Promise<void> {
  const proc = Bun.spawn(["sh", "-c", cmd], { cwd: dir, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  await proc.exited;
}

beforeEach(async () => {
  dir = makeTempDir();
  for (const a of [["init", "-q"], ["config", "user.email", "t@example.com"], ["config", "user.name", "t"]]) await git(...a);
  mkdirSync(join(dir, ".nax/features/f"), { recursive: true });
  writeFileSync(join(dir, PRD), "{\"stories\":\"seed\"}");
  writeFileSync(join(dir, "a.txt"), "1\n");
  await git("add", "-A");
  await git("commit", "-q", "-m", "seed");
  writeFileSync(join(dir, "a.txt"), "2\n");
  await git("commit", "-q", "-am", "second");
  handle = await activateRunState({ runId: "r1", feature: "f", root: dir });
  await atomicWriteText(join(dir, PRD), NAX_PRD); // tracked + modified: a revert loses nax's write
  await atomicWriteText(join(dir, STATUS), NAX_STATUS); // untracked: a clean/stash/rm loses it
});

afterEach(() => {
  handle.deactivate();
  cleanupTempDir(dir);
});

const read = (rel: string) => Bun.file(join(dir, rel)).text().catch(() => "<missing>");

async function expectRepaired(): Promise<void> {
  const records = await repairRunState({ trigger: "turn", storyId: "US-001", sessionName: "s1", stage: "implementer", turn: 1 });
  expect(records.length).toBeGreaterThan(0);
  expect(records.every((r) => r.restored)).toBe(true);
  expect(await read(PRD)).toBe(NAX_PRD);
  expect(await read(STATUS)).toBe(NAX_STATUS);
  expect(await git("ls-files", "-v", "--", PRD)).toMatch(/^H /);
}

/** Each case first proves the command really damaged the state, then that repair undid it. */
const CASES: { name: string; cmd: string; env?: Record<string, string>; damaged: () => Promise<boolean> }[] = [
  { name: "alias to stash", cmd: "git -c alias.x='stash -u' x", damaged: async () => (await read(PRD)) !== NAX_PRD },
  { name: "shell alias checkout", cmd: "git -c 'alias.x=!git checkout -- .nax' x", damaged: async () => (await read(PRD)) !== NAX_PRD },
  { name: "rebase -x deletes status", cmd: "git stash -q && git rebase -q -x 'rm -f .nax/features/f/status.json' HEAD~1; git stash pop -q", damaged: async () => (await read(STATUS)) === "<missing>" },
  { name: "GIT_EXTERNAL_DIFF executes", cmd: "git diff --ext-diff", env: { GIT_EXTERNAL_DIFF: "sh -c 'git checkout -- .nax/features/f/prd.json' --" }, damaged: async () => (await read(PRD)) !== NAX_PRD },
  { name: "interpreter overwrite", cmd: "bun -e \"await Bun.write('.nax/features/f/prd.json', '{}')\"", damaged: async () => (await read(PRD)) === "{}" },
  { name: "rm status", cmd: "rm .nax/features/f/status.json", damaged: async () => (await read(STATUS)) === "<missing>" },
  { name: "exclude pathspec that does not exclude", cmd: "git checkout -- . ':(exclude,glob)**/.nax'", damaged: async () => (await read(PRD)) !== NAX_PRD },
  { name: "skip-worktree", cmd: "git update-index --skip-worktree .nax/features/f/prd.json", damaged: async () => (await git("ls-files", "-v", "--", PRD)).startsWith("S ") },
  { name: "assume-unchanged", cmd: "git update-index --assume-unchanged .nax/features/f/prd.json", damaged: async () => /^[a-z] /.test(await git("ls-files", "-v", "--", PRD)) },
  { name: "stash -u with only .nax dirty", cmd: "git stash -u", damaged: async () => (await read(STATUS)) === "<missing>" },
  { name: "clean -fdx", cmd: "git clean -fdxq", damaged: async () => (await read(STATUS)) === "<missing>" },
];

describe("run-state bypass matrix: repair, not refusal (#2497)", () => {
  test.each(CASES)("$name", async ({ cmd, env, damaged }) => {
    await sh(cmd, env);
    expect(await damaged()).toBe(true);
    await expectRepaired();
  });
});
```

Note on "rebase -x": a rebase refuses to start with a dirty tracked file, so the case stashes the PRD change first and pops it after; the damage under test is the `-x` command deleting the untracked status file. If a case's precondition fails on the installed git (the `damaged()` assertion), fix the command so it really damages the state; never delete the precondition.

- [ ] **Step 2: Run it**

Run: `cd packages/nax && timeout 120 bun test test/integration/runstate/bypass-matrix.test.ts --timeout=20000`
Expected: PASS for all 11 cases (Tasks 6-9 implement the behaviour; this task proves it end to end). Any FAIL in `expectRepaired` is a real defect in Task 7: fix it there.

- [ ] **Step 3: Rewrite the guard's known-gaps header**

In `packages/nax-agent/src/tools/nax-state-guard.ts`, replace the line ` * KNOWN, NOT FIXED:` with:

```ts
 * KNOWN, NOT FIXED (by design, #2497): this guard is a first line that redirects
 * common accidents with a helpful message. It is not the boundary and is not
 * extended toward completeness. The guarantee is detect-and-repair: nax's
 * `src/runstate/` restores any nax-owned run-state file, and clears its index
 * flags, after every agent turn and before every auto-commit, whatever command
 * changed it (bypass matrix: test/integration/runstate/bypass-matrix.test.ts).
 * Gaps:
```

Keep every existing bullet below it unchanged.

- [ ] **Step 4: Run the nax-agent checks**

Run: `cd packages/nax-agent && bun run check:all`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/nax/test/integration/runstate packages/nax-agent/src/tools/nax-state-guard.ts
git commit -m "test(runstate): real-git bypass matrix asserts repair; guard points at it (#2497)"
```

---

### Task 11: Full gates and whole-branch review

**Files:** none new.

- [ ] **Step 1: Run every gate**

From the repo root: `bun run check:all` and `bun run typecheck`. From `packages/nax`: `bun run test` and `bun run test:coverage`. From `packages/nax-agent`: `bun run test`.
Expected: all PASS. New files under `src/runstate/` and `src/workflow/open-items.ts` at 80%+ line coverage (the per-file floor fails a new file below it).

- [ ] **Step 2: Fix and commit anything the gates found**

Fix at the site (never raise a baseline that grew). Commit as `fix: <what> (#2496, #2497)`.

- [ ] **Step 3: Whole-branch review**

Dispatch one reviewer over `git diff main...HEAD` with the spec path and the Review Focus list. Address CRITICAL and HIGH findings; at most two fix rounds. Do not push: report the branch state to the user, who pushes and opens the PR.
