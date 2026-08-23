# Handoff: #1514 phase 2, steps 0–2 (delegable)

Self-contained. You do not need to read the proposal, the issue, or any commit.

**Branch:** `chore/1514-test-debt-drain`. **Start:** typecheck **1946**, casts **102**,
`asAny=1398`, `tsSuppress=54`, `ratchetAllow=107`, `absentValue=17`.

Three steps. Each one is fully specified below — **there is no design work in this
document.** If you find yourself inventing a type, choosing between two shapes, or
"improving" something not listed, stop and see *Escalate*.

Do the steps **in order**. Step 0 is the guard that makes steps 1–2 verifiable; do not
skip ahead.

---

## 0. The verify loop (run after every step, all six, in this order)

```bash
# 1. src must stay clean — this is new in phase 2 and it is not optional
bun x tsc --noEmit

# 2. test typecheck count. Record it before you start each step.
bun x tsc --noEmit -p tsconfig.test.json 2>&1 | grep -c 'error TS'

# 3. no single file may be worse than its baseline
bun -e '
const b=require("./scripts/baselines/test-typecheck-baseline.json").byFile;
const out=require("child_process").execSync("bun x tsc --project tsconfig.test.json --noEmit 2>&1 || true",{encoding:"utf8",maxBuffer:1e8});
const cur={};for(const l of out.split("\n")){const m=l.match(/^([^(]+)\(\d+,\d+\): error TS/);if(m)cur[m[1]]=(cur[m[1]]||0)+1;}
const worse=Object.keys(cur).filter(f=>cur[f]>(b[f]??0));
console.log("total:",Object.values(cur).reduce((a,x)=>a+x,0),"| worse:",worse.length);
worse.forEach(f=>console.log("  ",f,(b[f]??0),"->",cur[f]));'

# 4. every gate green — BEFORE any baseline update
bun run check:all

# 5. full suite green (~40s)
bun run test

# 6. only now, lower the baselines
bun run check:test-typecheck:update
bun run check:test-escape-hatches:update
bun run check:test-as-unknown-as:update
git diff scripts/baselines/   # every number must have gone DOWN or stayed equal
```

**Never run `--update-baseline` before `check:all` is green.** It writes whatever it
finds, a regression included.

**A typecheck count that drops implausibly far means the tree stopped compiling.** tsc
aborts on the first parse error and reports one error total. If step 2 prints something
like `1` or `3`, you broke the syntax. Run `bun x tsc --noEmit -p tsconfig.test.json | head -3`
and fix it. Do not update a baseline.

---

## Forbidden (these lower a number without doing the work)

- Adding `as any`, `: any`, `<any>`, `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`.
- Adding `as unknown as X`, or `// test-ratchet-allow: as-unknown-as`.
- Adding any file to any `EXEMPT_FILES` / exemption map beyond what step 0 specifies.
- Deleting, skipping, or `.skip`-ing a test; narrowing a `describe`.
- Excluding a file from `tsconfig.test.json`.
- **Changing a type in `src/` so a fixture fits.** Step 1 is the *only* sanctioned `src/`
  change in this document, and it makes the compiler stricter, not looser. Anything else
  in `src/` is out of scope.
- Running `--update-baseline` on a count that grew.
- Resolving a conflict in `scripts/baselines/*.json` by hand-editing the JSON, by taking
  one side wholesale, or by regenerating without checking the result against the floor.
  See *Baseline conflicts* below — this is the one place where every gate can stay green
  while the ratchet is quietly loosened.

---

## Baseline conflicts — the one way to lose the whole drain silently

`scripts/baselines/*.json` is rewritten by every phase, so a rebase or merge will
eventually conflict there. **Do not hand-merge it, and do not reach for
`--update-baseline` as the resolution.**

`--update-baseline` writes whatever it measures *right now*. If a merge quietly dropped
some of the drain's fixes, regeneration records the higher number as the new floor — and
from then on every gate is green, the per-file check compares against the loosened
baseline, and nothing anywhere reports that the work was lost. A ratchet can only ever
catch growth relative to the number it was last told to trust.

The rule: **resolve to the elementwise floor of both sides, then prove the tree meets it.**

```bash
# Both sides of the conflict, without touching the working tree:
git show :2:scripts/baselines/test-typecheck-baseline.json > /tmp/ours.json    # HEAD
git show :3:scripts/baselines/test-typecheck-baseline.json > /tmp/theirs.json  # incoming

# Write the elementwise MINIMUM (every byFile entry; total re-derived) as the resolution.
bun -e '
const a=require("/tmp/ours.json"), b=require("/tmp/theirs.json");
const files=new Set([...Object.keys(a.byFile??{}), ...Object.keys(b.byFile??{})]);
const byFile={};
for(const f of files){
  // ABSENT FROM byFile MEANS ZERO, NOT UNKNOWN. The scanners only record files that
  // HAVE errors, so a file missing on one side is a file that side drove to 0.
  // Using `?? Infinity` here keeps the OTHER side number and throws the fix away.
  const v = Math.min(a.byFile?.[f] ?? 0, b.byFile?.[f] ?? 0);
  if (v > 0) byFile[f] = v;
}
// Re-derive the total from the floor. Math.min(a.count,b.count) is WRONG: each side may
// win on different files, so the true floor sits BELOW both totals.
const count = Object.values(byFile).reduce((s,x)=>s+x,0);
require("fs").writeFileSync("scripts/baselines/test-typecheck-baseline.json",
  JSON.stringify({count, updatedAt:new Date().toISOString(), byFile},null,2)+"\n");
console.log("floor:", count, "(ours", a.count, "/ theirs", b.count, ")");'

# Now prove the merged tree actually MEETS that floor. Do NOT update the baseline first.
bun run check:test-typecheck
```

- **Green** → the merge preserved both sides' work. Commit the floor as resolved. Done.
- **Red** → the merge lost fixes. That is the finding. Go recover them; do **not**
  regenerate the baseline to make it pass.

Both rules in that snippet are load-bearing, and both were **wrong in the first draft of
this document** until it was actually run against a simulated conflict:

| Trap | Wrong | Right |
|:--|:--|:--|
| file absent from one side's `byFile` | `?? Infinity` — keeps the other side's count | `?? 0` — absent means that side fixed it |
| the `count` field | `Math.min(a.count, b.count)` | re-derive as the sum of the floored `byFile` |

On the simulated conflict the wrong version produced a floor of **1946** and silently kept
5 errors in a file the other side had already fixed; the corrected version produced
**1941**. Every gate would have stayed green either way. That is the whole hazard.

For `test-escape-hatches-baseline.json` the same applies per counter — take
`Math.min` of each of the six independently (absent counter = 0), because one side may
have improved `asAny` while the other improved `anyType`. Taking either side wholesale
would discard one of them. `test-as-unknown-as-baseline.json` has the same
`{count, byFile}` shape as the typecheck baseline, so the snippet works on it unchanged.

`--update-baseline` is legitimate only in its normal place: after `check:all` and
`bun run test` are green, to record an improvement you just made and verified. It is never
a conflict-resolution tool.

---

# Step 0 — close the escape-hatch leaks

`scripts/check-test-escape-hatches.ts`. Three edits, one test file.

### 0a. Per-kind exemptions (GitHub #1682)

Today `EXEMPT_FILES` skips a file for **all four** counters:

```ts
if (EXEMPT_FILES.has(rel)) continue;   // line ~100
```

`test/helpers/absent.ts` is in that set for one reason only — its two
`absentValue<T>()` / `nullValue<T>()` *declarations* match the `absentValue` call-site
pattern. But it is also invisible to `asAny`, `tsSuppress` and `ratchetAllow`, so an
`as any` parked there would be counted by nothing.

Replace the set with a per-kind map:

```ts
/**
 * Per-kind exemptions. Scoped deliberately: a file exempt from one counter is
 * still graded by the other three. See GitHub #1682.
 */
const ALL_KINDS: ReadonlySet<HatchKind> = new Set(["asAny", "tsSuppress", "ratchetAllow", "absentValue"]);

const EXEMPT_BY_KIND: ReadonlyMap<string, ReadonlySet<HatchKind>> = new Map([
  // Scanner scaffolding: fixture strings legitimately contain all four patterns.
  ["test/unit/scripts/check-test-typecheck.test.ts", ALL_KINDS],
  ["test/unit/scripts/check-test-as-unknown-as.test.ts", ALL_KINDS],
  ["test/unit/scripts/check-test-escape-hatches.test.ts", ALL_KINDS],
  // The idiom's own definition. Its declarations match the CALL-SITE pattern;
  // counting them would inflate `absentValue` by 2 forever. Every other
  // counter still applies to this file.
  ["test/helpers/absent.ts", new Set(["absentValue"])],
]);
```

and in the scan loop, drop the `continue` and skip per kind instead:

```ts
const exempt = EXEMPT_BY_KIND.get(rel);
for (const kind of HATCH_KINDS) {
  if (exempt?.has(kind)) continue;
  // …existing body unchanged…
}
```

### 0b. Two new counters

Add to `PATTERNS`:

```ts
  /**
   * `any` in TYPE position — `: any`, `<any>`, `Record<string, any>`, `as any`.
   * Uncounted until now, and the cheapest possible way to silence a
   * `TS7006 implicit any` without fixing it. A superset of `asAny`; both
   * retire together when biome's `noExplicitAny` is enabled for `test/**`.
   *
   * Anchored to a type-position prefix on purpose. A bare /\bany\b/ also
   * matches the ENGLISH WORD in comments and fixture strings — 262 of them
   * in test/ today — so writing a doc comment containing "any" would trip
   * the ratchet and invite gaming it. Do not "simplify" this pattern.
   */
  anyType: /(?:\bas\s+any\b|[:<|&,(]\s*any\b)/g,
  /**
   * Single `as T` casts. NOT a drain target — this exists so the 189 `TS2352`
   * errors ("convert the expression to `unknown` first") cannot escape into
   * unmarked single casts while the cast ratchet is at its floor.
   */
  looseCast: /\bas\s+[A-Z]\w*/g,
```

`looseCast` needs one extra step the other patterns do not: the trailing half of
`as unknown as Foo` also matches `\bas\s+[A-Z]`, and the cast ratchet already counts that
cast. Strip it first so the two counters do not double-count. The scan loop today reads:

```ts
    const text = await Bun.file(join(rootDir, rel)).text();
    for (const kind of HATCH_KINDS) {
      const matches = text.match(PATTERNS[kind]);
```

Change those three lines to:

```ts
    const text = await Bun.file(join(rootDir, rel)).text();
    // `as unknown as Foo` ends in something `looseCast` would match, and the
    // cast ratchet already counts it. Strip it for that counter only.
    const looseText = text.replace(/\bas\s+unknown\s+as\b/g, "");
    for (const kind of HATCH_KINDS) {
      const matches = (kind === "looseCast" ? looseText : text).match(PATTERNS[kind]);
```

(`as const` / `as any` need no exclusion — the leading `[A-Z]` already rules them out.)

`HatchKind` is `keyof typeof PATTERNS` and `Counts` is `Record<HatchKind, number>`, so
both widen on their own. **The only hand edit is `emptyCounts()`** — add
`anyType: 0, looseCast: 0`. If you forget, `bun x tsc --noEmit` names it.

### 0c. Test

In `test/unit/scripts/check-test-escape-hatches.test.ts` (itself fully exempt, so its
fixture strings will not self-count) add:

- an `as any` written into a file that is exempt for `absentValue` only **is** counted
  by `asAny`;
- an `absentValue<T>()` in that same file is **not** counted;
- `anyType` counts `: any` and `<any>`, not just `as any`;
- `looseCast` counts `x as Foo` but not `x as unknown as Foo`, `x as const`, `x as any`.

### 0d. Ordering — step 0 inverts the usual rule, once

The verify loop says "`check:all` green **before** any baseline update". **Step 0 is the
one exception, and only for this reason:** a brand-new counter has no baseline entry, so
`formatReport` reads it as `0` and every one of its ~1898 matches counts as growth.
`check:test-escape-hatches` — and therefore `check:all` — is guaranteed red until the new
counters are baselined. That is expected, not a regression.

So for step 0 only:

```bash
# 1. baseline FIRST — the new counters have nothing to protect yet
bun run check:test-escape-hatches:update

# 2. the invariant that actually matters: the four ORIGINAL counters did not move
git diff scripts/baselines/test-escape-hatches-baseline.json | grep -E '^[-+].*(asAny|tsSuppress|ratchetAllow|absentValue)"'
#    → must show NO -/+ pair with a changed number for those four.
#      Only `anyType`, `looseCast` and `updatedAt` may appear as additions.

# 3. now the normal loop, from its step 1
```

Do **not** carry this exception into steps 1 or 2. There, `check:all` green comes first.

### Expected result for step 0

`asAny=1398, tsSuppress=54, ratchetAllow=107, absentValue=17` — **all four unchanged**.
Typecheck unchanged at 1946. Casts unchanged at 102.

`anyType` and `looseCast` are new. **This spec was executed and measured before this
handoff was written** — with it applied you should get exactly:

```
asAny=1398, tsSuppress=54, ratchetAllow=107, absentValue=17, anyType=1890, looseCast=2011
```

(`anyType=1890` is a coincidence with step 1's typecheck total — they are unrelated
numbers.) If yours differ, your pattern is wrong: for `anyType` check you did not use a
bare `\bany\b`; for `looseCast` check the `as unknown as` strip.

Two behaviours were verified against this tree and are what 0c must assert:

| Probe | Result |
|:--|:--|
| plant `const _probe = {} as any;` in `test/helpers/absent.ts` | `asAny` 1398 → **1399** — the #1682 leak is closed |
| the file's own `absentValue<T>()` / `nullValue<T>()` declarations | `absentValue` stays **17** — still exempt, no double-count |

**If any of the original four numbers moves, the fix is wrong.** Revert and escalate.

Commit: `fix(scripts): scope escape-hatch exemptions per kind, add anyType/looseCast counters (#1682)`

---

# Step 1 — put the injected-deps parameter into the operation type

`DeterministicOperation` declares `execute(input, ctx)`. Seven ops implement
`execute(input, ctx, deps = _xDeps)`. TypeScript ignores *optional* extra parameters when
checking assignability, so `src/` compiles and the deps seam is erased from the contract —
which is why 101 tests get `TS2554: Expected 2 arguments, but got 3`.

**This exact change has been prototyped and measured. Apply it verbatim.**

### 1a. `src/operations/types.ts`

```ts
export interface DeterministicOperation<I, O, C = NaxConfig, D = void>
  extends Pick<OperationBase<I, O, C>, "name" | "stage" | "config"> {
  readonly kind: "deterministic";
  readonly timeoutMs?: never;
  /**
   * `deps` is the op's injectable seam and is part of its public type — an
   * implementation may declare it optional with a default, but the interface
   * must name it, or tests cannot pass it. See #1514 phase 2.
   */
  execute(input: I, ctx: CallContext, deps?: D): Promise<O>;
}

export type Operation<I, O, C> =
  | RunOperation<I, O, C>
  | CompleteOperation<I, O, C>
  | DeterministicOperation<I, O, C, never>;
```

`never` in the union is deliberate: by parameter contravariance it accepts an op with any
concrete `D`. Do not write `unknown` or `any` there.

### 1b. `src/execution/story-orchestrator/types.ts:129`

```ts
export type AnySlot = { op: RunOperation<any, any, any> | DeterministicOperation<any, any, any, any>; input: unknown };
```

### 1c. Supply `D` at all seven op declarations

| File | Add as 4th type argument |
|:--|:--|
| `src/operations/verify-scoped.ts:59` | `VerifyScopedDeps` |
| `src/operations/full-suite-gate.ts:206` | `FullSuiteGateDeps` |
| `src/operations/lint-check.ts:81` | `LintCheckDeps` |
| `src/operations/typecheck-check.ts:85` | `TypecheckCheckDeps` |
| `src/operations/mutation-check.ts:126` | `MutationCheckDeps` |
| `src/operations/mechanical-lintfix-strategy.ts:43` | `MechanicalLintFixDeps` |
| `src/operations/mechanical-formatfix-strategy.ts:43` | `MechanicalFormatFixDeps` |

`full-suite-gate.ts` and `mechanical-formatfix-strategy.ts` write their type arguments
across several lines. Add the 4th on its own line with a trailing comma on the third —
**edit these two by hand.** A regex over a multi-line generic produced unbalanced
punctuation twice on this branch already.

If you miss one of the seven, `bun x tsc --noEmit` names it — the interface now fails
closed. That is the check working, not a problem.

**Checkpoint:** `bun x tsc --noEmit` must print **0 errors**. Test typecheck should read
**1890**, per-file gate `worse: 0`.

### 1d. The 39 errors this reveals

Removing the arity error unmasks `TS2741: Property 'resolution' is missing … but required
in type 'ResolvedTestPatterns'` — 39 sites, one field, five files:

| File | Sites |
|:--|--:|
| `test/unit/operations/mutation-check.test.ts` | 16 |
| `test/unit/operations/mutation-check-diff-scope.test.ts` | 14 |
| `test/unit/operations/mutation-check-selection.test.ts` | 6 |
| `test/unit/operations/mutation-check-telemetry.test.ts` | 2 |
| `test/unit/operations/mutation-check-revert.test.ts` | 1 |

A factory already exists but is **private**. In `test/helpers/plan-inputs.ts`, export it
and give it overrides:

```ts
/** Minimal resolved test patterns. Total by construction — pass overrides, never a literal. */
export function makeResolvedTestPatterns(
  overrides: Partial<ResolvedTestPatterns> = {},
): ResolvedTestPatterns {
  return {
    globs: ["test/**/*.test.ts"],
    regex: [/\.test\.ts$/],
    pathspec: [":(exclude)test/**/*.test.ts"],
    testDirs: ["test/unit", "test/integration"],
    resolution: "detected",
    ...overrides,
  };
}
```

Re-export it from `test/helpers/index.ts` next to `makeMockPlanInputs`. Then replace each
of the 39 object literals with `makeResolvedTestPatterns({ …the fields that literal set… })`.
**Keep every field the literal already set** — pass them as overrides. Do not add
`resolution` to the literal by hand; use the factory.

### Expected result for step 1

Typecheck **1946 → ~1851 (−95)**. `bun x tsc --noEmit` = 0. Per-file gate `worse: 0`.
All escape-hatch counters unchanged. Casts unchanged at 102.

Six `TS2554` remain, in `test/unit/operations/autofix-implementer-strategy.test.ts`
(lines 232, 247, 256, 265, 274, 293). **Leave them** — that is a different signature
(`strategy.extractApplied`), not a `DeterministicOperation`. Out of scope.

Commit the src change and the 39-site fixup **together** —
`bun run check:all` is red in between.

Commit: `refactor(operations): make injectable deps part of DeterministicOperation's type (#1514 phase 2)`

---

# Step 2 — the 77 missing type imports

Pure missing `import type` lines. Ten files, plus two judgement cases handled below.

Canonical import paths — use these exactly:

```ts
import type { PRD, UserStory } from "@/prd";
import type { NaxConfig } from "@/config";
import type { IAgentManager } from "@/agents";
import type { DecomposedStory } from "@/agents/shared/types-extended";
```

| File | Missing names |
|:--|:--|
| `test/unit/cli/plan-decompose-guards.test.ts` | `UserStory`×11, `PRD`×2, `DecomposedStory`×1 |
| `test/unit/cli/plan-decompose-writeback.test.ts` | `UserStory`×7, `PRD`×6 |
| `test/unit/cli/plan-decompose-ac13-14.test.ts` | `UserStory`×7, `PRD`×2, `NaxConfig`×2 |
| `test/unit/cli/plan-decompose-mapper.test.ts` | `PRD`×8, `UserStory`×3 |
| `test/unit/cli/plan-decompose-regression.test.ts` | `PRD`×7, `UserStory`×2, `NaxConfig`×1 |
| `test/unit/cli/plan-decompose-debate.test.ts` | `PRD`×7, `UserStory`×1 |
| `test/unit/session/manager-session-retry.test.ts` | `IAgentManager`×3 |
| `test/unit/interaction/init-headless.test.ts` | `NaxConfig`×2 |
| `test/unit/precheck/precheck-run-story-size-gate-routing.test.ts` | `NaxConfig`×2 |
| `test/unit/execution/lifecycle/run-setup-credentials.test.ts` | `IAgentManager`×1 |
| `test/helpers/deps.ts` | `afterEach` — add `import { afterEach, beforeEach } from "bun:test";` |
| `test/helpers/timer-spy.ts` | `TimerHandler` — **escalate, see below** |

`TimerHandler` is a DOM lib type and `tsconfig.json` sets `"lib": ["ESNext"]`. Do **not**
add `"DOM"` to `lib` — that changes the whole project's globals. Either declare the alias
locally in that file (`type TimerHandler = string | ((...args: unknown[]) => void);` —
match what the surrounding code actually passes) or leave the single error and report it.
One error is not worth a lib change.

Some files may already import one of these names — check before adding, and let
`bun x biome check --write test/` sort the import block afterwards.

### Expected result for step 2

Typecheck **~1851 → ~1774 (−77)**, or −76 if you leave `TimerHandler`. Per-file gate
`worse: 0`. Everything else unchanged.

Commit: `test(cli,session): add missing type imports (#1514 phase 2)`

---

## Escalate — stop and report, do not guess

- Any of step 0's four original counters moves.
- `bun x tsc --noEmit` (src) is non-zero after step 1c and the cause is **not** one of the
  seven ops missing its `D`.
- A fixture change makes a *different* test fail. That test was relying on the wrong
  shape — report it, do not paper over it.
- The error names a **source** type as wrong rather than a fixture.
- A step's actual number is more than ~10 off the expected number above.
- The same file fails twice in a row. Two attempts, then hand it back.
- Anything at all in steps 3–6 of `PROPOSAL-1514-phase2-typecheck-drain.md`. Those need
  design calls and are explicitly **not** in this handoff.

## Definition of done

All three steps committed. `bun run check:all` green, `bun run test` green,
`bun x tsc --noEmit` = 0. Typecheck baseline **~1774** (from 1946). Casts still **102**.
`asAny`, `tsSuppress`, `ratchetAllow`, `absentValue`, `anyType`, `looseCast` all equal or
lower than their step-0 baselines.

**No step may trade one counter against another.** A typecheck drop paired with an
`anyType` rise is a failed step, not partial progress.

Report before/after numbers for: src tsc, test typecheck, casts, and all six hatch counters.
