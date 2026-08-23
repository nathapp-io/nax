# Handoff: #1514 phase 3b — the `callOp` dep slot (47 sites)

Self-contained. You do not need to read the plan, the proposal, or any commit.

**Branch:** `chore/1514-phase3-drain`.
**Start:** typecheck **1745**, casts **102**,
`asAny=1398, tsSuppress=54, ratchetAllow=107, absentValue=17, anyType=1890, looseCast=2011`.

Five `src` modules, ten test files, **zero casts added anywhere**. The approach is
prototyped and measured — the numbers below are real, not estimates.

**Read §2 before touching tier 2.** It contains the one mistake that will cost you an hour
and look like the approach is broken.

---

## 0. What you are fixing and why it works

Tests assign a stub to a `callOp` dep slot and get:

```
Type 'Mock<() => Promise<{ passed: boolean; findings: never[] }>>' is not assignable to
  type '<I, O, C>(ctx: CallContext, op: Operation<I, O, C>, input: I) => Promise<O>'
```

The slot promises *"for **any** `O` the caller picks, I return `Promise<O>`"*. A stub
returning one concrete shape cannot honour that, and **no cast-free value can** — which is
why these were escalated for two phases.

But the slot type is **inferred** from `_callOp`, and each of these modules dispatches
**exactly one op**. The genericity is an inference artifact, not a requirement. Annotate
the bag and the impossible variance error becomes an ordinary "your fixture is missing
fields" error, which a factory closes.

**Do not add `as unknown as` to make a stub fit.** If a stub cannot satisfy an annotated
slot, the fixture is incomplete — that is the finding, and the factory is the fix.

---

## 1. Tier 1 — modules that already have a dep bag (24 sites)

Three modules, three commits. **Do `adversarial.ts` first** — it is the worked example
below, with measured numbers.

| `src` module | Dep bag | Op | Input / Output | Test file(s) | Sites |
|:--|:--|:--|:--|:--|--:|
| `src/review/adversarial.ts` | `_adversarialDeps` | `adversarialReviewOp` | `AdversarialReviewInput` / `AdversarialReviewOutput` | `test/unit/review/adversarial-retry.test.ts` | 9 |
| `src/review/semantic.ts` | `_semanticDeps` | `semanticReviewOp` | `SemanticReviewInput` / `SemanticReviewOutput` | `semantic-retry.test.ts` (8), `semantic-debate.test.ts` (1) | 9 |
| `src/execution/lifecycle/acceptance-fix.ts` | `_diagnosisDeps` | `acceptanceDiagnoseOp` | `AcceptanceDiagnoseInput` / `AcceptanceDiagnoseOutput` | `test/unit/execution/lifecycle/acceptance-fix.test.ts` | 6 |

### 1a. Annotate the bag (no cast)

```ts
// src/review/adversarial.ts — before
export const _adversarialDeps = {
  writeReviewAudit,
  callOp: _callOp,                    // ← inferred as the full generic signature
  collectDiffFileList: _collectDiffFileList,
};

// after
export const _adversarialDeps: {
  writeReviewAudit: typeof writeReviewAudit;
  /**
   * Monomorphic on purpose: this module dispatches exactly one op, so the
   * inferred generic signature over-stated the seam and no stub could satisfy
   * it without a cast (#1514 phase 3b).
   */
  callOp: (
    ctx: CallContext,
    op: typeof adversarialReviewOp,
    input: AdversarialReviewInput,
  ) => Promise<AdversarialReviewOutput>;
  collectDiffFileList: typeof _collectDiffFileList;
} = {
  writeReviewAudit,
  callOp: _callOp,
  collectDiffFileList: _collectDiffFileList,
};
```

A generic function is assignable to any single instantiation, so `_callOp` still fits.
**`bun x tsc --noEmit` must stay at 0** — verified.

Imports you will need to add (`adversarial.ts` needs both; check the others):

```ts
import type { AdversarialReviewInput, AdversarialReviewOutput } from "../operations/adversarial-review";
import type { CallContext } from "../operations/types";
```

**Annotate the whole bag, not just `callOp`.** Spelling the other members as
`typeof <thing>` keeps them exactly as they were.

Two per-module quirks, verified on this tree so you do not have to find them:

- **`_semanticDeps` has an inline-typed member.** `createDebateRunner` is written as
  `(opts: DebateRunnerOptions): DebateRunner => new DebateRunner(opts)`, so `typeof` does
  not apply cleanly — spell its type as
  `(opts: DebateRunnerOptions) => DebateRunner` in the annotation.
- **`_diagnosisDeps` currently reads `callOp: _callOp as typeof _callOp`** — a redundant
  self-cast that does nothing. **Delete the cast** when you annotate; do not carry it over.
  That bag has no other members, so it is the simplest of the three.

### 1b. Add the output factory

The annotated slot now reports what each fixture is missing. For adversarial and semantic
it is the same two fields — `normalizedFindings` and `acDropped`. Put the factories in
`test/helpers/` and export them from `test/helpers/index.ts`:

```ts
export function makeAdversarialOutput(
  overrides: Partial<AdversarialReviewOutput> = {},
): AdversarialReviewOutput {
  return { passed: true, findings: [], normalizedFindings: [], acDropped: [], ...overrides };
}

export function makeSemanticOutput(
  overrides: Partial<SemanticReviewOutput> = {},
): SemanticReviewOutput {
  return { passed: true, findings: [], normalizedFindings: [], acDropped: [], ...overrides };
}

export function makeDiagnoseOutput(
  overrides: Partial<AcceptanceDiagnoseOutput> = {},
): AcceptanceDiagnoseOutput {
  return { verdict: "test_bug", reasoning: "", confidence: 1, ...overrides };
}
```

Those are the **complete** required-field sets, read off the interfaces. Everything else on
those types is optional.

### 1c. Convert the sites

```ts
// before
_adversarialDeps.callOp = mock(async () => ({ passed: true, findings: [] }));

// after
_adversarialDeps.callOp = mock(async () => makeAdversarialOutput({ passed: true, findings: [] }));
```

**Keep every field the literal already set**, and change no values. The factory supplies
only what was missing.

### Measured on the worked example

`adversarial-retry.test.ts`: `src` tsc **0**, converted sites cleared, **10 tests green**,
no cast added. Expect **1745 → ~1721** for all of tier 1.

### What tier 1 actually found

Every adversarial and semantic fixture in the suite has been claiming to be a
`…ReviewOutput` while omitting `normalizedFindings` and `acDropped` — the fields
`src/review/adversarial.ts` reads to decide what is **blocking**. They pass because the
code tolerates `undefined` there, which means **nothing in the suite exercises the
normalization path**. That is a finding worth more than the 24 errors; note it in your
report. Do not try to fix it here.

---

## 2. Tier 2 — modules with NO dep bag (23 sites)

`src/debate/runner-hybrid.ts` and `src/debate/runner-stateful{,-helpers}.ts` call through a
module namespace, so the tests reach them with `spyOn(callModule, "callOp")` and there is
no slot to annotate. **Decision already made: give them a bag** (option (a);
`_runPlanDeps` and `_debateSessionDeps` already exist in `src/debate/`, so this is the
established convention here).

> ### TRAP — read this before you edit anything
>
> **The migration is atomic per `src` module, not per test file.** The moment `runHybrid`
> calls `_hybridDeps.callOp`, every `spyOn(callModule, "callOp")` aimed at it stops
> intercepting. Converting one file of four left the other three spying on a function that
> is no longer called: **13 tests failed**, and they fail with confusing assertion diffs —
>
> ```
> Expected to contain: "proposal-from-claude"
> Received: [ "proposal-claude", "proposal-opencode" ]
> ```
>
> — not with an obvious wiring error. It looks like the approach is broken. It is not.
>
> **Convert every test file for a module in the SAME commit, and run the whole
> `test/unit/debate/` directory, not just the file you edited.**

### The file sets that must move together

| `src` module(s) | Op | Test files — one commit each row | Sites |
|:--|:--|:--|--:|
| `runner-hybrid.ts` | `hybridDebaterOp` | `runner-hybrid-rebuttal` (8), `runner-hybrid-cross-debater` (4), `runner-hybrid-coordinator` (4), `runner-hybrid` (1) | 17 |
| `runner-stateful.ts` + `runner-stateful-helpers.ts` | `statefulDebaterOp` | `runner-stateful-coordinator` (4), `runner-stateful` (2) | 6 |

Both stateful files dispatch the same op, so they share one bag — confirm whether the tests
touch one or both before splitting.

### 2a. Add the bag

```ts
// src/debate/runner-hybrid.ts
export const _hybridDeps: {
  callOp: (
    ctx: CallContext,
    op: typeof hybridDebaterOp,
    input: DebateHybridInput,
  ) => Promise<DebateHybridOutput>;
} = {
  callOp: callModule.callOp,
};
```

Then change the call site from `callModule.callOp(...)` to `_hybridDeps.callOp(...)`.
Import `DebateHybridOutput` as a type — `CallContext` is already imported there.

### 2b. Convert the tests

```ts
// before
const callOpSpy = spyOn(callModule, "callOp").mockImplementation(
  async (_callCtx, _op, input: DebateHybridInput) => { … },
);

// after — installer keeps a real bun mock, so toHaveBeenCalledTimes() still works
function installCallOp(impl: typeof _hybridDeps.callOp) {
  const spy = mock(impl);
  _hybridDeps.callOp = spy;
  return spy;
}

const callOpSpy = installCallOp(async (_callCtx, _op, input) => { … });
```

Add `withDepsRestore(_hybridDeps);` from `@test/helpers` as the first line inside the
`describe`, so the bag is restored between tests the way `mock.restore()` used to handle
the spy.

**No output factory needed for tier 2** — `DebateHybridOutput` and `DebateStatefulOutput`
are both just `{ success, rebut }`, which the existing stubs already return in full.

### 2c. Two things that will trip you, both cheap

- Some sites annotate the op parameter, e.g.
  `async (_c, op: RunOperation<DebateHybridInput, unknown, unknown>, input) => …`. That
  stale annotation no longer matches the monomorphic slot — **delete the annotation** and
  let it infer. One site in `runner-hybrid-cross-debater.test.ts`.
- `runner-hybrid.test.ts` drives the public `DebateRunner` class rather than `runHybrid`
  directly, and one of its stubs is annotated `DebateStatefulInput` while routing through
  the hybrid path. Check which op each stub really serves. **Do this file last.**

### Measured

`_hybridDeps` + `runner-hybrid-coordinator.test.ts`: `src` tsc **0**, that file's 4 callOp
errors → **0**, its 5 tests green, zero casts. Expect **~1721 → ~1698** for all of tier 2.

---

## 3. Not in scope — leave these alone

8 sites in `story-orchestrator-resume-integration.test.ts` (7) and
`story-orchestrator.test.ts` (1). `src/execution/story-orchestrator/run-phase.ts` dispatches
`slot.op` from `AnySlot` — it really is polymorphic, so the generic signature is **correct**
and must stay. Same for `src/finish/ops-impl.ts` (three ops) and `src/acceptance/hardening.ts`
(two). They are documented exceptions.

---

## 4. The loop

```bash
# after editing
bun x biome check --write test/ src/
bun test test/unit/<the module's whole directory> --timeout=60000   # NOT just one file
```

Per commit (one `src` module + all its test files), **all six, in this order**:

```bash
# 1. src must stay clean — this is the check that the annotation is right
bun x tsc --noEmit

# 2. test typecheck count — record it before you start
bun x tsc --noEmit -p tsconfig.test.json 2>&1 | grep -c 'error TS'

# 3. no single file worse than its baseline
bun -e '
const b=require("./scripts/baselines/test-typecheck-baseline.json").byFile;
const out=require("child_process").execSync("bun x tsc --project tsconfig.test.json --noEmit 2>&1 || true",{encoding:"utf8",maxBuffer:1e8});
const cur={};for(const l of out.split("\n")){const m=l.match(/^([^(]+)\(\d+,\d+\): error TS/);if(m)cur[m[1]]=(cur[m[1]]||0)+1;}
const worse=Object.keys(cur).filter(f=>cur[f]>(b[f]??0));
console.log("total:",Object.values(cur).reduce((a,x)=>a+x,0),"| worse:",worse.length);
worse.forEach(f=>console.log("  ",f,(b[f]??0),"->",cur[f]));'

# 4. every gate green — BEFORE any baseline update
bun run check:all

# 5. full suite green
bun run test

# 6. only now, lower the baseline
bun run check:test-typecheck:update
git diff scripts/baselines/   # must have gone DOWN
```

Commit as `refactor(<area>): type callOp monomorphically (#1514 phase 3b)` with a body line
`typecheck: P -> Q`.

**A typecheck count that drops implausibly far means the tree stopped compiling.** tsc
aborts on the first parse error and reports one error total. If step 2 prints `1` or `3`,
you broke the syntax — do not update a baseline.

---

## 5. Forbidden

- Adding `as any`, `: any`, `<any>`, `as unknown as`, `@ts-ignore`, `@ts-expect-error`,
  `@ts-nocheck`, or `// test-ratchet-allow`. This phase adds **zero** casts; if you think
  you need one, escalate instead.
- Making a dep slot generic again, or widening an annotation to `unknown` / `any`, to make
  a stub fit. The stub is wrong, not the slot.
- Adding the missing output fields inline instead of via the factory.
- Changing any value a fixture already sets.
- Touching §3 (story-orchestrator / finish / hardening).
- Deleting, skipping, or `.skip`-ing a test; narrowing a `describe`.
- Running `--update-baseline` on a count that grew.

## 6. Escalate — stop and report, do not guess

- `bun x tsc --noEmit` (src) is non-zero after annotating a bag, and the cause is not a
  missing type import.
- A module you were told is monomorphic turns out to dispatch a second op
  (`grep -n "callOp(" <module>` to confirm before you start).
- Converting a whole module's test files still leaves that module's tests red. Report the
  failures; do **not** revert the `src` annotation to make them pass.
- A fixture cannot be completed without changing what the test asserts.
- The same module fails twice in a row. Two attempts, then hand it back.

## 7. Definition of done

`bun run check:all` green, `bun run test` green, `bun x tsc --noEmit` = 0, per-file gate
`worse: 0`, typecheck baseline lower. Expected landing: **1745 → ~1698 (−47)**.

**Casts stay at 102 and all six hatch counters stay at their baselines.** No step may trade
one counter against another — a typecheck drop paired with an `anyType` or `looseCast` rise
is a failed step, not partial progress.

Report before/after for: src tsc, test typecheck, casts, all six hatch counters — and the
normalization-path finding from §1.
