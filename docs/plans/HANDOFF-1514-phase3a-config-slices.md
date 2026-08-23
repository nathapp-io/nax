# Handoff: #1514 phase 3a — config-slice fixtures

Self-contained. You do not need to read the proposal, the issue, or any commit.

**Branch:** `chore/1514-phase3-drain` (off `main` @ `16997cb0f`).
**Start:** typecheck **1745**, casts **102**,
`asAny=1398, tsSuppress=54, ratchetAllow=107, absentValue=17, anyType=1890, looseCast=2011`.

One mechanical substitution, repeated ~54 times across 14 files. **The seam is already
built and one file is already converted as a worked example** — read `0dd7ba9ac` before
you start. There is no design work in this document.

---

## 1. The substitution

Tests that take a **sliced** config (`ReviewConfig`, `PlanConfig`, …) rather than a whole
`NaxConfig` write the slice out as a literal. That pins every field the type requires, so
when `src/` adds a required field the literal silently rots:

```ts
// before — 3 typecheck errors' worth of missing fields, and the test keeps passing
const reviewConfig: ReviewConfig = {
  enabled: true,
  checks: ["lint"],
  commands: {},
};

// after — complete by construction, defaults from DEFAULT_CONFIG
const reviewConfig: ReviewConfig = makeConfigSlice("review", {
  enabled: true,
  checks: ["lint"],
  commands: {},
});
```

```ts
import { makeConfigSlice } from "@test/helpers";
```

**Keep every field the literal already set** — pass them all as overrides. Do not add the
missing fields by hand; that is what the factory is for. Do not change any value.

The first argument is the `NaxConfig` key, not the type name:

| Slice type | key |
|:--|:--|
| `ReviewConfig` | `"review"` |
| `PlanConfig` | `"plan"` |
| `AcceptanceConfig` | `"acceptance"` |
| `ContextConfig` | `"context"` |
| `QualityConfig` | `"quality"` |
| `ExecutionConfig` | `"execution"` |
| `RectificationConfig` | nested — `makeConfigSlice("execution").rectification` |
| `StorySizeGateConfig` | **needs `makeStorySizeGateConfig` — see §4** |

---

## 2. The work queue

54 sites. Counts drift as you work; regenerate with:

```bash
bun x tsc --project tsconfig.test.json --noEmit 2>&1 | grep -cE "is missing the following properties from type '(Review|Plan|Acceptance|Rectification|StorySizeGate|Quality|Execution|Context)Config'"
```

| File | Sites | Slices |
|:--|--:|:--|
| `test/unit/review/runner.test.ts` | 9 | ReviewConfig |
| `test/unit/precheck/precheck-story-size-gate.test.ts` | 8 | StorySizeGateConfig — **§4** |
| `test/integration/review/review.test.ts` | 7 | ReviewConfig |
| `test/integration/plan/plan.test.ts` | 5 | PlanConfig |
| `test/integration/pipeline/pipeline-events.test.ts` | 5 | Execution, Quality, Review, Plan, Acceptance |
| `test/integration/routing/routing-stage-greenfield.test.ts` | 5 | Rectification, Context, Acceptance, Plan, Review |
| `test/integration/routing/routing-stage-final-state.test.ts` | 5 | same five |
| `test/unit/review/runner-language-fallback.test.ts` | 2+2 | ReviewConfig (2 are a partial-partial, §4) |
| `test/unit/execution/rectification.test.ts` | 2 | RectificationConfig — **§4** |
| `test/unit/pipeline/stages/prompt-acceptance.test.ts` | 2 | RectificationConfig — **§4** |
| `test/integration/pipeline/pipeline-acceptance.test.ts` | 1 | AcceptanceConfig |
| `test/unit/review/scoped-lint.test.ts` | 1 | ReviewConfig |

Start with `test/unit/review/runner.test.ts` and `test/integration/review/review.test.ts`
— same slice as the worked example, 16 sites between them, no surprises expected.

---

## 3. The loop

```bash
# after editing each file
bun x biome check --write test/
bun test <the file you changed> --timeout=60000
```

Per commit (one file, or 3–5 files of the same slice), **all six, in this order**:

```bash
# 1. src must stay clean
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

Commit as `test(<area>): convert <slice> fixtures to makeConfigSlice (#1514 phase 3a)`
with a body line `typecheck: P -> Q`.

**A typecheck count that drops implausibly far means the tree stopped compiling.** tsc
aborts on the first parse error and reports one error total. If step 2 prints `1` or `3`,
you broke the syntax — do not update a baseline.

---

## 4. The four sites that are NOT the plain substitution

The two nested slices behave differently, because one parent key is **optional** on
`NaxConfig`. Both forms below were compiled against this tree — use them verbatim.

**`RectificationConfig`** lives at `execution.rectification`, and `execution` is required,
so the plain nested access compiles. 4 sites (`rectification.test.ts` x2,
`prompt-acceptance.test.ts` x2, plus one inside each `routing-stage-*` file):

```ts
const cfg: RectificationConfig = makeConfigSlice("execution", {
  rectification: { maxAttemptsTotal: 3 },   // the fields the literal already set
}).rectification;
```

**`StorySizeGateConfig` needs its own helper — `makeConfigSlice` alone does NOT work here.**
It lives at `precheck.storySizeGate`, and `precheck?: PrecheckConfig` is **optional**
(`src/config/runtime-types.ts:532`). `makeConfigSlice("precheck")` therefore returns
`PrecheckConfig | undefined` and the property access fails with
`TS2532: Object is possibly 'undefined'`. That is the helper working correctly — it reports
optionality honestly rather than asserting it away.

Add this next to `makeConfigSlice` in `test/helpers/mock-nax-config.ts` and export it from
`test/helpers/index.ts`. **Do not** reach for `!`, `as`, or a `?.` that leaves the type
optional:

```ts
/**
 * `precheck` is optional on NaxConfig, so the generic slice helper cannot reach
 * through it without asserting. DEFAULT_CONFIG always supplies it; the throw
 * states that invariant instead of hiding it behind a non-null assertion.
 */
export function makeStorySizeGateConfig(
  overrides: DeepPartial<StorySizeGateConfig> = {},
): StorySizeGateConfig {
  const slice = makeNaxConfig({ precheck: { storySizeGate: overrides } }).precheck?.storySizeGate;
  if (slice === undefined) throw new Error("DEFAULT_CONFIG.precheck.storySizeGate is missing");
  return slice;
}
```

Then the 8 sites in `precheck-story-size-gate.test.ts` become:

```ts
const gate: StorySizeGateConfig = makeStorySizeGateConfig({ enabled: true, maxAcCount: 10 });
```

Verified: compiles, and yields
`{ enabled, maxAcCount, maxDescriptionLength: 3000, maxBulletPoints: 12, action: "block", maxReplanAttempts: 3 }`
— the two fields those literals are missing are `action` and `maxReplanAttempts`.

**`runner-language-fallback.test.ts` has two sites of a different shape** — the literal
already sets `pluginMode` and `semantic`, and is missing only `parseRetryMaxAttempts` and
`conflictDetection`. Same substitution, but check the `semantic` override survives the
merge (it is `SemanticReviewConfig | undefined`).

**`pipeline-events.test.ts:40` (`ExecutionConfig`, 10 missing fields)** is the largest
single literal. Convert it last, on its own commit.

---

## 5. Forbidden

- Adding `as any`, `: any`, `<any>`, `as unknown as`, `@ts-ignore`, `@ts-expect-error`,
  `@ts-nocheck`, or `// test-ratchet-allow`.
- Adding the missing fields to the literal by hand when `makeConfigSlice` applies. The
  point is that the fixture stops needing maintenance, not that today's error goes away.
- **Changing any value a fixture already sets.** If a test asserts on `maxAttemptsTotal: 3`,
  it still sets `maxAttemptsTotal: 3` afterwards.
- Changing a type in `src/` so a fixture fits. There is no `src/` change in this phase.
- Deleting, skipping, or `.skip`-ing a test; narrowing a `describe`.
- Running `--update-baseline` on a count that grew.

---

## 6. Escalate — stop and report, do not guess

- A converted fixture makes a **different** test fail. The test was relying on a field
  being absent; report it rather than papering over it.
- The factory's default for a field disagrees with what the test needs, and overriding it
  changes what the test asserts.
- Any counter other than `check:test-typecheck` moves.
- The same file fails twice in a row. Two attempts, then hand it back.

## 7. Definition of done

`bun run check:all` green, `bun run test` green, `bun x tsc --noEmit` = 0, per-file gate
`worse: 0`, and the typecheck baseline lower. Expected landing: **1745 → ~1691 (−54)**.

**Casts stay at 102 and all six hatch counters stay at or below their baselines.** No step
may trade one counter against another — a typecheck drop paired with an `anyType` or
`looseCast` rise is a failed step, not partial progress.

Report before/after for: src tsc, test typecheck, casts, and all six hatch counters.

---

## 8. Why the seam is written the way it is

Worth 60 seconds before you copy the pattern elsewhere. The obvious formulation needs two
casts:

```ts
// DON'T — this is what shipped first, and the looseCast ratchet rejected the commit
return makeNaxConfig({ [key]: overrides } as DeepPartial<NaxConfig>)[key] as NonNullable<NaxConfig[K]>;
```

A computed generic key is not provable as `DeepPartial<NaxConfig>`, and `NonNullable<>`
then has to be re-asserted. Returning `NaxConfig[K]` and merging the slice directly avoids
both, and types better besides — an **optional** config key correctly yields `| undefined`
instead of having it asserted away:

```ts
export function makeConfigSlice<K extends keyof NaxConfig>(
  key: K,
  overrides: DeepPartial<NaxConfig[K]> = {},
): NaxConfig[K] {
  return deepMerge(makeNaxConfig()[key], overrides);
}
```

If you need a similar helper for a slice this one cannot reach, write it cast-free the
same way. `looseCast` will tell you if you didn't.
