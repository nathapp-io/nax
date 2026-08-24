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

**One file per commit.** Three commits for cluster B, nine for C-1, one for C-2 (its five sites
are one file and were verified together) — **thirteen commits**. Do not batch a cluster into one
commit: a single bad file then forces you to unpick a green commit, and per-file is what every
prior batch in this drain used.

Work on branch `chore/1514-tail-recipes`, cut from this one (`chore/1514-guard-before-delegation`)
so the guard commits are in your history. Do **not** cut from `main` — see §0.

For each file, in this order:

```bash
# 1. edit the ONE file

# 2. syntax guard — must print the ONE known TS1355 line and nothing else (see G1 below)
bunx tsc --project tsconfig.test.json --noEmit | grep -E "error TS1[0-9]{3}:"

# 3. src must stay 0
bun x tsc --noEmit

# 4. total must go DOWN, by the number of errors this file had — no more, no less
bunx tsc --project tsconfig.test.json --noEmit | grep -c "error TS"

# 5. formatting + import order on just this file (fast; catches the §2 import trap
#    in 4ms instead of at the end of a 25-gate run)
bun x biome check <the file you touched>

# 6. the file's own tests
timeout 60 bun test <the file you touched> --timeout=15000

# 7. 25 gates, including both ratchets
bun run check:all

# 8. full suite
bun run test

# 9. baseline LAST, only when 2-8 all passed
bun run check:test-typecheck:update

# 10. commit - stage EXPLICITLY, never `git add -A` (§30 swept 35 junk artifacts that way)
git add <the file> scripts/baselines/test-typecheck-baseline.json
git commit -m "test: <what you did> (#1514 tail-recipes)"
```

Step 9 before step 10 matters: the pre-commit hook re-runs `check:all`, and `check:test-typecheck`
compares per-file against the baseline. Both orders pass the gate, but updating first keeps the
commit self-consistent — the baseline in the commit describes the tree in the commit.

`check:all` includes both ratchets, so a counter you raised fails the commit before you reach
the baseline update. That is the design — do not work around it.

### G1 — the syntax-error guard (read this one twice)

After any edit:

```bash
bunx tsc --project tsconfig.test.json --noEmit | grep -E "error TS1[0-9]{3}:"
```

**Expected output is exactly one line, and it is not yours:**

```
test/unit/verification/smart-runner.test.ts(516,7): error TS1355: A 'const' assertion can only
be applied to references to enum members, or string, number, boolean, array, or object literals.
```

That `TS1355` is pre-existing and predates this handoff — §13 and §16 of the status doc both
record G1 "flat at 1" for the same reason. **Leave it alone.** It is in none of your clusters,
and it is a `const`-assertion error, not a parse failure, so it does not suppress anything.

**Any second line is yours, and means stop and revert that file.** A genuine parse error stops
`tsc` reporting *semantic* errors project-wide, so a broken file makes the total collapse and
look like a triumph — §12 records the count going 1067 → 16 this way with nothing fixed. That is
also why step 4 checks the drop is *exactly* cluster-sized: **any drop larger than the file you
touched is a bug report about yourself.**

(`TS18046`/`18047`/`18048` are five digits, so this grep does not match them. They are not
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

Do not reach for a silencer. Every one of them is counted, and a commit that adds one fails
`check:all`:

| Silencer | Counter |
|:--|:--|
| `as never` | `asNever` (619) |
| postfix `!` | `nonNullAssert` (827) |
| `as any` | `asAny` (1386) |
| `: any`, `<any>` | `anyType` (1877) |
| `as T` | `looseCast` (1925) |
| `@ts-expect-error` / `@ts-ignore` / `@ts-nocheck` | `tsSuppress` (40) |
| `test-ratchet-allow:` marker | `ratchetAllow` (106) |
| `absentValue<T>()` / `nullValue<T>()` | `absentValue` (17) |
| `as unknown as` | its own ratchet, floor 102, **zero headroom** |

**A reverted file is a good outcome. A silenced file is a failed batch.** If you finish with
fewer files done than this handoff lists, that is a result worth reporting, not a failure to
hide. Say which files you reverted and what you saw.

---

## 2. Cluster B — `RoutingDecision` widening (8 errors, 3 files) — DELEGABLE

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

**Prototyped on `routing-persistence.test.ts`:** 4 → 0 errors, 10 tests pass, all eight hatch
counters and `as unknown as` measured flat. Reverted. This is §30's `parallel-worker` recipe
verbatim, third use.

| File | Errors | Lines |
|:--|--:|:--|
| `test/unit/pipeline/stages/routing-persistence.test.ts` | 4 | 203, 237, 288, 323 |
| `test/unit/pipeline/stages/routing-initial-complexity.test.ts` | 3 | 175, 209, 244 |
| `test/unit/pipeline/stages/routing-greenfield-monorepo.test.ts` | 1 | 91 |

**All three files need a NEW import line, and its position is not free.** `organizeImports`
sorts the `@/…` group as plain strings, so `@/routing` goes **after** `@/prd/types`, not after
`@/prd`:

```ts
import type { PipelineContext } from "@/pipeline/types";
import type { PRD, UserStory } from "@/prd";
import type { StoryRouting } from "@/prd/types";
import type { RoutingDecision } from "@/routing";   // <- here
import { makeNaxConfig, makeStory } from "@test/helpers";
```

This is checked, not guessed: putting it one line earlier (the natural spot, next to the other
`@/prd` imports) fails `bun x biome check` with *"Import statements could be sorted"*, and so
fails `check:all` and the pre-commit hook. §29 lost a cycle to the same rule.
`routing-greenfield-monorepo.test.ts` has no `@/prd` line — there `@/routing` follows
`@/prd/types` all the same.

If you are unsure, run `bun x biome check <file>` right after editing; it names the exact
ordering it wants.

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

**Prototyped on `debate/runner.test.ts`:** 1 → 0, 9 tests pass, all eight hatch counters and
`as unknown as` measured flat. Reverted. All nine C-1 files already have an `@test/helpers`
import line, so no new import and no ordering question — checked.

**This recipe applies to C-1 only.** It is right there because those stubs are pure scaffolding —
nothing reads the logger back. C-2 asserts on log output and takes a different fix; see below.
Before swapping any file, grep it for `logger`-reading assertions. If a file turns out to read
its logger, stop and treat it as C-2, or revert per the bail rule.

**Size trap:** `runner-plan.test.ts` is grandfathered in `file-sizes-baseline.json` at **1117
lines**, so `check:file-sizes` caps it. The recipe replaces a 6-line literal with a 1-line call,
i.e. it *shrinks* the file, so it is safe — but do not let anything else in that file grow.

**C-1 — 9 errors, 9 files, one per file, all `TS2322`, all the dep-assignment form above.**
All under `test/unit/debate/`: `runner.test.ts:57`, `runner-hybrid.test.ts:94`,
`runner-hybrid-cross-debater.test.ts:85`, `runner-hybrid-rebuttal.test.ts:100`,
`runner-mode-routing.test.ts:70`, `runner-one-shot-roles.test.ts:55`,
`runner-plan.test.ts:99`, `runner-plan-signal.test.ts:70`, `runner-stateful.test.ts:106`.
This is the prototyped path. Take it first.

**C-2 — 5 errors, 1 file, all `TS2352`. Different site shape, and `makeLogger()` is the WRONG
fix here.** All five are in `test/unit/execution/unified-executor-logging.test.ts` (lines 203,
245, 320, 355, 415).

This file asserts on log output — each stub pushes into a local `infoCalls` array the test then
filters. `makeLogger()` would work but forces rewiring `infoCalls` and the `loggerSpy?.mockRestore()`
in three `afterEach` blocks. **Do not do that.** The file already documents its own answer: its
`installStoryLogSpy()` helper (line 29) types the stub `Partial<Logger>` precisely so *"the
narrowing cast is a plain widening rather than a double cast"*. Four tests use it correctly; five
sites are inline copies that were never updated.

The minimal faithful fix is two edits per site, no rewiring, no new import (`Logger` is already
imported at line 14):

```ts
const logger: Partial<Logger> = {          // was: const logger = {
  info: mock((stage, message, data) => { infoCalls.push({ stage, message, data }); }),
  ...
};
loggerSpy = spyOn(loggerModule, "getSafeLogger").mockReturnValue(logger as Logger);
//                                    was: logger as ReturnType<typeof loggerModule.getSafeLogger>
```

**Verified end-to-end on all five sites:** total 415 → 410 (exactly cluster-sized), 12 tests
pass, all eight counters flat. Reverted.

One wrinkle: the shorter cast makes the call fit on one line, so the formatter reflows it and
`bun x biome check` fails until you run `bun x biome check --write <file>`. Expected — do that,
then re-run step 5.

Because C-2 is verified as a whole rather than one-site-prototyped, it is a **single commit**,
not five.

The first draft of this list also named `runner-hybrid-coordinator`, `story-scoped-fix-budget`,
`rule-sections` and `story-orchestrator`. They are **not** in this cluster — they came from a
`grep -B20` that pulled in neighbouring files' errors. Counted exactly, the cluster is 9 + 5.
Anchor a membership grep on the error line itself, never on context lines.

## 4. Cluster A — `_planDeps.createRuntime` (10 errors, 4 files) — ~~NOT DELEGABLE~~ **WRONG; done**

> **Correction, 2026-08-24.** This verdict was wrong and the cluster was drained test-side
> (393 → 383, no counter moved). The reasoning below reads only the `src/` side; the sibling
> tests — `plan-decompose-ac-repair`, `ac13-14`, `regression`, `plan-debate` — already wrap
> their manager in `makeMockRuntime({ agentManager })` and typecheck clean, so the four
> erroring files were stale stragglers, not a seam problem. The duck-typed fallback the
> section defends was then *proved dead at runtime* and removed (`cd5ee7b52`).
> Full account: `STATUS-1514-drain.md` §33. **Kept unedited below as the record of a
> failure mode: reading the `src/` side is necessary, not sufficient — read the siblings too.**


`plan-decompose-debate` 5, `plan-decompose-guards` 2, `plan-decompose-writeback` 2,
`plan-decompose-mapper` 1 — all under `test/unit/cli/`.

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

§29 already recorded its plan's cause column being *"wrong in a load-bearing way twice"* out of
six batches, and §31 found three files held back for an owner that turned out to be plain stale
test-side references. The prior in both directions is weak. That is why the bail rule is not
optional, and why §4 exists at all: **an error message tells you two types disagree, never which
side is wrong.** Read the `src/` side of any seam before touching the fixture.

---

## 5. Not in this batch

- **`TS2769` "no overload matches this call" (23).** Scattered; no shared cause found. Per-site.
- **`TS7024` implicit-`any` recursive return (9).** Needs a real return type worked out per
  function — cheap to get wrong, invisible when wrong.
- **`models` shape drift (9).** `string` where `DeepPartial<Record<ModelTier, ModelEntry>>` is
  wanted. **Third sighting** of this rename (§8, §31). Probably one recipe, not yet measured.
- **`debate/pre-phase/grounder`** — settled in §31, not an escalation any more. Do not reopen.

## 6. Expected landing

**22 errors across 13 files, in 13 commits** — cluster B 8 errors / 3 files, C-1 9 / 9,
C-2 5 / 1.

All three clusters land at **415 → 393**. Each has been run against the live tree — B and C-1
one site each, C-2 in full at 415 → 410 — so 393 is measured arithmetic, not a forecast.

A total *below* 393 is not a better result: it means something in §1 did not hold, most likely
G1. Say so in the commit rather than adjust the baseline to match. A total above 393 means a
file was reverted; name it and say what you saw.

Every counter must be flat or lower at the end. Verified flat across both prototypes, so an
increase is your edit, not the recipe. The current floor:

```
asAny=1386  tsSuppress=40  ratchetAllow=106  absentValue=17
anyType=1877  looseCast=1925  asNever=619  nonNullAssert=827
as-unknown-as=102 (at its floor — zero headroom)
```
