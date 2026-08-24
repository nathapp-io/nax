# HANDOFF #1514 — the tail, by recipe

Written 2026-08-24 against `main` @ `3cacd13fd` (PR #1696 merged), on branch
`chore/1514-guard-before-delegation`. Residue at that commit: **415 typecheck errors across
197 files**.

This handoff is written **to be executed by a cheaper model**. Everything it asks for has been
measured or prototyped on the live tree first; the two clusters marked delegable have each had
one site converted, verified, and reverted. Nothing here is an estimate.

Read `STATUS-1514-drain.md` §6 (traps) before starting. Do not re-derive its lessons.

---

## 0. The guard this handoff depends on

`STATUS-1514-drain.md` says the tail is *"none above 8, no cluster larger than one file."* The
first half is true. **The second half is not** — grouping by error message instead of by file
finds cross-file clusters that share one recipe. That is what makes this batch delegable at all.

Two commits landed before this handoff, and the batch is unsafe without them:

- `567109d11` — the escape-hatch baseline was stale-high (`looseCast` 1994 vs a live 1925).
  69 unmarked `as T` casts could have been added with every gate green. Re-baselined.
- `3cb47afec` — added the `asNever` (619) and `nonNullAssert` (827) counters. `as never` is
  assignable to every type and `looseCast` anchors on `as [A-Z]`, so it was invisible; postfix
  `!` was invisible to every counter *and* to Biome (`noNonNullAssertion` is `off` for
  `test/**`). **Both are the cheapest possible "fix" for exactly the errors in this batch.**

If you are reading this on a branch where `bun run check:test-escape-hatches` prints six
counters rather than eight, stop — you are before the guard and the gates cannot see you.

---

## 1. The loop — every commit, no exceptions

One cluster per commit. One file per commit inside a cluster if the cluster spans files.

```bash
bun x tsc --noEmit                                   # src: must stay 0
bunx tsc --project tsconfig.test.json --noEmit \
  | grep -c "error TS"                               # total: must go DOWN
timeout 60 bun test <the file you touched> --timeout=15000
bun run check:all                                    # 25 gates
bun run test                                         # full suite
bun run check:test-typecheck:update                  # LAST, only when all of the above pass
```

`check:all` includes both ratchets, so a counter you raised fails the commit before you get to
the baseline update. That is the design — do not work around it.

### G1 — the syntax-error guard (read this one twice)

After any edit:

```bash
bunx tsc --project tsconfig.test.json --noEmit | grep -E "error TS1[0-9]{3}:"
```

It must print nothing. A parse error stops `tsc` reporting *semantic* errors project-wide, so a
broken file makes the total collapse and look like a triumph. §12 of the status doc records the
count going 1067 → 16 this way, with nothing fixed. **Any drop larger than the cluster you
touched is a bug report about yourself.** (`TS18046`/`18047`/`18048` are five digits — not
syntax errors.)

### The bail rule

Trap 4: converting a wholesale-rejected literal to a typed factory moves errors from
one-per-object to **one-per-field**, so a file can legitimately get worse mid-edit before it
gets better (§18: 1 error became 4, then the file came out ahead).

That is expected. What is not allowed is reaching for a silencer when it happens. If a file
does not come back **below its own starting count** by the end of your edit:

1. `git checkout -- <the file>`
2. Write down the file, the count, and what you saw.
3. Move to the next file.

Do not add `as never`, `!`, `as any`, `as unknown as`, or a `@ts-expect-error` to close the gap.
All six are counted; a commit that uses one fails `check:all`. **A reverted file is a good
outcome. A silenced file is a failed batch.**

---

## 2. Cluster B — `RoutingDecision` widening (8 errors, 6 files) — DELEGABLE

`mock(() => Promise.resolve({ complexity: "medium", ... }))` infers `complexity` as `string`;
the dep slot wants the `Complexity` union. Nothing is missing from the fixture — it is pure
literal widening.

**Recipe** — annotate the mock's return type. No cast, no fixture change:

```ts
import type { RoutingDecision } from "@/routing";

_routingDeps.resolveRouting = mock((): Promise<RoutingDecision> =>
  Promise.resolve({ complexity: "medium", modelTier: "balanced", ... }),
);
```

**Prototyped on `routing-persistence.test.ts`:** 4 → 0 errors, 10 tests pass, no counter moved.
Reverted. This is §30's `parallel-worker` recipe verbatim, third use.

| File | Errors | Lines |
|:--|--:|:--|
| `test/unit/pipeline/stages/routing-persistence.test.ts` | 4 | 203, 237, 288, 323 |
| `test/unit/pipeline/stages/routing-initial-complexity.test.ts` | 3 | 175, 209, 244 |
| `test/unit/pipeline/stages/routing-greenfield-monorepo.test.ts` | 1 | 91 |

Note the import goes in Biome's `@/…` group; `organizeImports` will fail `check:all` if you put
it first. (§29 lost a cycle to exactly this.)

## 3. Cluster C — the debate logger stub (14 errors, 10 files) — DELEGABLE

`_debateSessionDeps.getSafeLogger = mock(() => ({ info: mock(...), debug, warn, error }))`.
`Logger` is a **class** with ~16 members including private ones, so a four-method literal can
never satisfy it structurally.

**`makeLogger()` already exists for this** (`test/helpers/mock-logger.ts`) and is barrel-exported.
Its docstring says it was built for precisely this shape. As in §17's `makeMergeEngine`, the
helper was written and then never reached these files.

**Recipe:**

```ts
import { makeLogger } from "@test/helpers";   // add to the EXISTING @test/helpers import line

_debateSessionDeps.getSafeLogger = mock(() => makeLogger());
```

**Prototyped on `debate/runner.test.ts`:** 1 → 0, 9 tests pass, no counter moved. Reverted.

**C-1 — 9 errors, 9 files, one per file, all `TS2322`, all the dep-assignment form above.**
All under `test/unit/debate/`: `runner.test.ts:57`, `runner-hybrid.test.ts:94`,
`runner-hybrid-cross-debater.test.ts:85`, `runner-hybrid-rebuttal.test.ts:100`,
`runner-mode-routing.test.ts:70`, `runner-one-shot-roles.test.ts:55`,
`runner-plan.test.ts:99`, `runner-plan-signal.test.ts:70`, `runner-stateful.test.ts:106`.
This is the prototyped path. Take it first.

**C-2 — 5 errors, 1 file, all `TS2352`, and a different site shape.** All five are in
`test/unit/execution/unified-executor-logging.test.ts` (203, 245, 320, 355, 415), where the stub
is a local object handed to `spyOn(loggerModule, "getSafeLogger").mockReturnValue(logger as …)`
rather than assigned to a dep. Same root cause, same helper, and deleting the five casts lowers
`looseCast`. **But this file's entire purpose is asserting on log output**, so unlike C-1 it
*does* read the logger back. Check every assertion before swapping — `makeLogger()` exposes
`.calls` and per-level mocks, so they are rewritable, but if the mapping is not obvious, revert
per the bail rule and leave the 5.

The first draft of this list also named `runner-hybrid-coordinator`, `story-scoped-fix-budget`,
`rule-sections` and `story-orchestrator`. They are **not** in this cluster — they came from a
`grep -B20` that pulled in neighbouring files' errors. Counted exactly, the cluster is 9 + 5.
Anchor a membership grep on the error line itself, never on context lines.

## 4. Cluster A — `_planDeps.createRuntime` (10 errors, 5 files) — **NOT DELEGABLE, escalate**

This was in the first draft of this handoff as the safest cluster. Reading the source removed
it. **Do not attempt it.**

The error reads as a stale fixture — `Mock<() => IAgentManager>` assigned to a slot declared
`(cfg, wd, featureName) => NaxRuntime`. It is not. `src/cli/plan-runtime.ts:34-41`:

```ts
const candidate = _planDeps.createRuntime(config, workdir, featureName) as unknown;
if (isRuntimeWithAgentManager(candidate)) return candidate;
return createRuntime(config, workdir, { agentManager: candidate as IAgentManager, featureName });
```

The production code **deliberately accepts either shape**, duck-typing at runtime, and the tests
exercise the documented second path. The defect is that the dep's *declared* type says only
`NaxRuntime` while its implementation supports both. So the honest fix is a `src/` type change
(widen the slot to `NaxRuntime | IAgentManager`, which is what the `as unknown` + guard already
implements) — or a decision that the seam should not exist. Either way it is an owner call,
which is the G5 boundary.

Any test-side "fix" here either fabricates a `NaxRuntime` the test does not want or casts the
mismatch away. **Both are wrong. Leave the 10 errors in the baseline.**

This is the fourth time in this drain a cluster looked mechanical and was not — and the second
time the cause column was wrong in a load-bearing direction (§29). It is why the bail rule is
not optional.

---

## 5. Not in this batch

- **`TS2769` "no overload matches this call" (23).** Scattered; no shared cause found. Per-site.
- **`TS7024` implicit-`any` recursive return (9).** Needs a real return type worked out per
  function — cheap to get wrong, invisible when wrong.
- **`models` shape drift (9).** `string` where `DeepPartial<Record<ModelTier, ModelEntry>>` is
  wanted. **Third sighting** of this rename (§8, §31). Probably one recipe, not yet measured.
- **`debate/pre-phase/grounder`** — settled in §31, not an escalation any more. Do not reopen.

## 6. Expected landing

22 errors across 16 files — cluster B 8, cluster C-1 9, cluster C-2 5. **415 → ~393**, and
**→ ~398 if C-2 is correctly abandoned** at its assertions. Either landing is a success; a
landing *below* 393 means something in §1 did not hold, most likely G1. Say so in the commit
rather than adjusting the baseline to match.

Every counter must be flat or lower at the end. The current floor:

```
asAny=1386  tsSuppress=40  ratchetAllow=106  absentValue=17
anyType=1877  looseCast=1925  asNever=619  nonNullAssert=827
as-unknown-as=102 (at its floor — zero headroom)
```
