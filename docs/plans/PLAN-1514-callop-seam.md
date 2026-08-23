# Plan: #1514 callop-seam — the `callOp` dep slot (55 errors)

Branch `chore/1514-phase3-drain` @ `86fb9d5b8`. Measured on that tree: typecheck **1745**,
casts **102**, `anyType=1890`, `looseCast=2011`.

**55 errors, 12 files, one target type.** This is the single largest remaining cluster,
and the one I previously called "provably unimplementable cast-free". That was right about
the *symptom* and wrong about the *fix* — the conclusion below is better than the contained
seam originally proposed as D3, and it costs zero casts.

---

## 1. The error

```
Type 'Mock<() => Promise<{ passed: boolean; findings: never[] }>>' is not assignable to
  type '<I, O, C>(ctx: CallContext, op: Operation<I, O, C>, input: I) => Promise<O>'
```

The slot's type promises: *for **any** `O` the caller picks, I return `Promise<O>`.* A stub
returning one concrete shape cannot honour that, and no cast-free value can — the caller
chooses `O`, not the implementation. Hence the original "escalate, needs a seam" ruling.

## 2. Why the slot is generic at all — and why it should not be

The slot type is **inferred** from `_callOp`:

```ts
export const _adversarialDeps = {
  writeReviewAudit,
  callOp: _callOp,          // ← inferred as the full generic signature
  collectDiffFileList: _collectDiffFileList,
};
```

But `adversarial.ts` dispatches **exactly one op**:

```ts
opResult = await _adversarialDeps.callOp(callCtx, adversarialReviewOp, { … });
```

The genericity is an artifact of inference, not a requirement of the module. The seam is
monomorphic in every use; only its *type* claims otherwise. **This is the same defect
phase 2 fixed in `DeterministicOperation`** — a type that overstates what the code does,
and tests paying for it.

## 3. The fix, measured

Annotate the dep bag instead of letting it infer. No cast:

```ts
export const _adversarialDeps: {
  writeReviewAudit: typeof writeReviewAudit;
  callOp: (
    ctx: CallContext,
    op: typeof adversarialReviewOp,
    input: AdversarialReviewInput,
  ) => Promise<AdversarialReviewOutput>;
  collectDiffFileList: typeof _collectDiffFileList;
} = { writeReviewAudit, callOp: _callOp, collectDiffFileList: _collectDiffFileList };
```

A generic function is assignable to any single instantiation, so `_callOp` still fits and
`src/` stays at **0 errors** (verified).

**What this does to the test error is the point.** It does not remove it — it *transforms*
it:

```
before: Type 'Mock<…>' is not assignable to '<I, O, C>(ctx, op, input: I) => Promise<O>'
                                              ^ unimplementable — variance

after:  Type '{ passed: boolean; findings: never[] }' is missing the following
        properties from type 'AdversarialReviewOutput': normalizedFindings, acDropped
                                              ^ ordinary — a fixture is incomplete
```

An impossible problem becomes a factory call. Step two is a normal output factory:

```ts
export function makeAdversarialOutput(
  overrides: Partial<AdversarialReviewOutput> = {},
): AdversarialReviewOutput {
  return { passed: true, findings: [], normalizedFindings: [], acDropped: [], ...overrides };
}
```

**Prototyped end to end and reverted; the tree is clean.** On `adversarial-retry.test.ts`:
`src` tsc stayed 0, converted sites dropped out (9 → 5 with a crude regex that matched only
4 of the 9 literal shapes — a careful edit gets all 9), and all **10 tests stayed green**.
Zero casts added anywhere: no `as unknown as`, no `looseCast`, no `anyType`.

**And the two fields it surfaced are a real finding.** Every one of those fixtures has been
claiming to be an `AdversarialReviewOutput` while missing `normalizedFindings` and
`acDropped` — the fields `src/review/adversarial.ts` reads to decide what is *blocking*.
The tests pass because the code tolerates `undefined` there. Nobody was asserting on the
normalization path at all.

---

## 4. The 55 split into three tiers, and only tier 1 is mechanical

The fix above works **only where the module dispatches one op**. Verified per module:

### Tier 1 — monomorphic, has a `_xDeps` bag (24 errors)

Annotate the bag, add an output factory, convert the sites. No `spyOn`, no restructuring.

| Module | Op it dispatches | Test file | Errors |
|:--|:--|:--|--:|
| `src/review/adversarial.ts` | `adversarialReviewOp` | `review/adversarial-retry.test.ts` | 9 |
| `src/review/semantic.ts` | `semanticReviewOp` | `review/semantic-retry.test.ts` (8) + `semantic-debate.test.ts` (1) | 9 |
| `src/execution/lifecycle/acceptance-fix.ts` | `acceptanceDiagnoseOp` | `execution/lifecycle/acceptance-fix.test.ts` | 6 |

**Do tier 1 first, one module per commit, `adversarial.ts` first** — it is the worked
example above and the one whose numbers are already measured.

### Tier 2 — monomorphic, but NO dep bag (23 errors)

`src/debate/runner-hybrid.ts` (`hybridDebaterOp`) and `src/debate/runner-stateful{,-helpers}.ts`
(`statefulDebaterOp`) call through a module namespace:

```ts
import * as callModule from "../operations/call";
await callModule.callOp(ctx, hybridDebaterOp, { … });
```

so the tests reach them with `spyOn(callModule, "callOp").mockImplementation(…)`, and
`spyOn` types the implementation against the real generic signature. **There is no slot to
annotate.** Files: `runner-hybrid-rebuttal` 8, `runner-stateful-coordinator` 4,
`runner-hybrid-cross-debater` 4, `runner-hybrid-coordinator` 4, `runner-stateful` 2,
`runner-hybrid` 1.

**Decision: (a) — give these modules a dep bag.** Ruled 2026-08-23. It is the same
"make the type say what the code does" move as tier 1 and phase 2, it costs zero casts, and
it removes a module-namespace spy the repo otherwise avoids (`_runPlanDeps` and
`_debateSessionDeps` already exist in `src/debate/`, so the convention is established here).
The rejected option (b) — a `makeCallOpSpy` helper holding one cast — buys a smaller diff
by keeping the spy pattern, and hides the fixture shape the annotated slot exposes.

### Prototyped, and it works — plus one trap that will bite

`_hybridDeps` added to `runner-hybrid.ts` with `callOp` typed to `hybridDebaterOp`, and
`runner-hybrid-coordinator.test.ts` moved off `spyOn`:

```ts
// src/debate/runner-hybrid.ts
export const _hybridDeps: {
  callOp: (ctx: CallContext, op: typeof hybridDebaterOp, input: DebateHybridInput) => Promise<DebateHybridOutput>;
} = { callOp: callModule.callOp };

// test — installer keeps the bun mock, so toHaveBeenCalledTimes() still works
function installCallOp(impl: typeof _hybridDeps.callOp) {
  const spy = mock(impl);
  _hybridDeps.callOp = spy;
  return spy;
}
withDepsRestore(_hybridDeps);   // from @test/helpers
```

Result: `src` tsc **0**, that file's 4 callOp errors → **0**, its 5 tests green, zero casts.
`DebateHybridOutput` is only `{ success, rebut }`, so **tier 2 needs no output factory** —
unlike tier 1.

> **TRAP — the migration is atomic per `src` module, not per test file.**
> The moment `runHybrid` calls `_hybridDeps.callOp`, every `spyOn(callModule, "callOp")`
> aimed at it stops intercepting. Converting one file of four left the other three
> spying on a function no longer called: **13 tests failed**, and they fail with confusing
> assertion diffs (`Expected "proposal-from-claude", received ["proposal-claude", …]`),
> not with an obvious wiring error. Convert **all** test files for a module in the **same
> commit**, and run the module's whole test directory — not just the file you edited.

Two more things found while prototyping, both cheap once you know:

- Some sites annotate the op parameter explicitly, e.g.
  `installCallOp(async (_c, op: RunOperation<DebateHybridInput, unknown, unknown>, input) => …)`.
  That stale annotation no longer matches the monomorphic slot — **delete the annotation**
  and let it infer. One site in `runner-hybrid-cross-debater.test.ts`.
- `runner-hybrid.test.ts` drives the public `DebateRunner` class rather than `runHybrid`
  directly, and one of its stubs is annotated `DebateStatefulInput` while routing through
  the hybrid path. Check which op each stub really serves before converting; do this file
  last.

**Per-module file sets that must move together:**

| `src` module | Test files (all in one commit) | callOp errors |
|:--|:--|--:|
| `runner-hybrid.ts` | `runner-hybrid-rebuttal` (8), `runner-hybrid-cross-debater` (4), `runner-hybrid-coordinator` (4), `runner-hybrid` (1) | 17 |
| `runner-stateful.ts` + `runner-stateful-helpers.ts` | `runner-stateful-coordinator` (4), `runner-stateful` (2) | 6 |

Both stateful files dispatch `statefulDebaterOp`, so they share one bag — check whether the
tests target one or both before splitting.

### Tier 3 — genuinely polymorphic, leave alone (8 errors)

These modules really do dispatch arbitrary ops, so the generic signature is **correct** and
must stay:

| Module | Why | Errors |
|:--|:--|--:|
| `src/execution/story-orchestrator/run-phase.ts` | dispatches `slot.op` from `AnySlot` — any op in the orchestrator | 8 (`story-orchestrator-resume-integration` 7, `story-orchestrator` 1) |
| `src/finish/ops-impl.ts` | three ops | — |
| `src/acceptance/hardening.ts` | two ops (`acceptanceRefineOp`, `acceptanceGenerateOp`) | — |

For tier 3 the contained seam (one cast in `test/helpers`) is the honest answer, because
here the variance is real rather than an inference artifact. **8 errors is not worth a
seam**; document them as accepted and revisit only if the cluster grows. A two-op module
like `hardening.ts` could also take an overloaded slot — more type machinery than 0 current
errors justifies.

---

## 5. Expected landing

| Tier | Errors | Casts added | Confidence |
|:--|--:|--:|:--|
| 1 — annotate bag + output factory | **24** | **0** | measured on 1 of 3 modules |
| 2 — dep bag + move tests off `spyOn` (**decision (a)**) | **23** | **0** | prototyped on 1 of 6 files |
| 3 — accept as documented | 8 | 0 | — |

Tier 1 alone: **1745 → ~1721**. Tiers 1+2: **→ ~1698**.

## 6. What this changes about the earlier proposal

`PROPOSAL-1514-phase2-typecheck-drain.md` §4 D3 said these 32 (now 55) errors "need the
contained-seam pattern — one cast inside a helper, none at the sites". **That is now the
tier-3 answer only, and tier 3 is 8 errors.** For the other 47 the seam is unnecessary: the
slot was never really generic, and saying so costs nothing. Prefer fixing the type over
containing a cast whenever the code is monomorphic — the cast hides the fixture defect that
the honest type exposes, which in tier 1 turned out to be `normalizedFindings` / `acDropped`
missing from every adversarial fixture in the suite.

## 7. Before starting

- Tier 1 and tier 2 are both delegable once someone writes the per-module handoff. Tier 2
  carries the atomicity trap above — a delegate who converts file-by-file will hit 13 red
  tests and may "fix" them by reverting the src change. Say so in the handoff.
- Tier 3 is a documentation task.
- Every commit: `bun x tsc --noEmit` = 0, `check:all` green, `bun run test` green, per-file
  gate `worse: 0`, and **no counter trades against another** — a typecheck drop with an
  `anyType` or `looseCast` rise is a failed step.
- Do not add `as unknown as` to make a stub fit. If a stub cannot satisfy an annotated slot,
  the fixture is incomplete — that is the finding, and the factory is the fix.
