# `noNonNullAssertion` drain — closed log (biome 1064 → 0)

Lifted out of `docs/plans/STATUS-test-debt-drain.md` on 2026-08-26, the day it closed. Nine
commits on `chore/drain-no-non-null-assertion` (`9fb596297`..`435f6edd1`), merged as #1726.
Chronological; each entry records what was true when written and is not edited afterwards.

Final state: **biome 1064 → 0 (−100%)**, regex ratchet 792 → 2 (both residual matches are
prose/fixture strings biome does not parse — `assert-defined.ts`'s own doc comment, and a
declaration fixture exercising a `foo!.bar → foo?.bar` edit). `biome.json`'s `test/**` override
now says `"error"` for `noNonNullAssertion` explicitly — promoted, not deleted, because under
Biome v2.5.10 deleting the override lands the rule at default *warning* severity and
`biome check` exits 0 on warnings. This closed item 4 of the phase-3c endgame, and with it the
endgame.

---

## The measurement gap — why biome, not the regex

`scripts/check-test-escape-hatches.ts` is raw text, and its own doc comment concedes the
ceiling: the `nonNullAssert` pattern is anchored to postfix position and "undercounts rather
than over-" — `x! + 1` and an end-of-line `!` are both missed. Measured 2026-08-26 on `main`:

| Counter | regex ratchet | biome | gap |
|:--|--:|--:|--:|
| `anyType` / `noExplicitAny` | 10 | **0** | prose + parser fixtures only |
| `nonNullAssert` / `noNonNullAssertion` | **792** | **1064** | **272 uncounted** |

So 272 non-null assertions in `test/` were counted by **nothing**: the regex missed them and
`noNonNullAssertion` was `off` for `test/**`. That mattered for the promote-back specifically —
draining to 0 as the regex measured it would have left those sites live and failed the
promote-back on a red build. **Zero on the ratchet is not zero on the rule.** The biome probe
that settled it is kept in the live doc's §0.1, generalised.

---

## The recipe record

**The primary recipe is documented in the code.** `test/helpers/assert-defined.ts` (exported
from `@test/helpers`) holds `assertDefined` and `firstCall`. Its doc comment is the ruling:
`!` is matched by *none* of the escape-hatch counters, `expect(x).not.toBeNull()` does not
narrow, and `expect(x?.y).toBe(v)` narrows but **goes vacuously true** when the value really is
absent, converting a real failure into a green test. The helpers throw, so a missing value
fails loudly and names what was missing.

Route order, as proven across the drain:

1. **Declare the hook present** when a shared type erases what a concrete value defines
   (§8.15) — `RunOperationWithHooks<I, O, C, K>` / `FixStrategyWithExtractApplied<F, I, O, C>`.
   This beats fifty `!`s at call sites and, unlike `satisfies`, keeps every other signature
   at its declared domain type.
2. **Complete the fixture** so the value is not optional in the first place.
3. **Tighten the accessor's return type** — a helper returning `T | undefined` because one
   caller needs that, forcing `!` on twenty others, is the defect.
4. **`assertDefined`** for genuinely-optional values — captured callback writes, indexed
   reads under `noUncheckedIndexedAccess`, optional config fields whose schema defaults make
   absence impossible. One assertion per variable per scope, placed at the first read.

---

## Log

### 8.14 Batch 7 — the `executeHop!` seam, 414 → 362 (2026-08-26)

The first session batch after the queue re-measure. 52 sites across 18 files, all the same
shape: inside a `runWithFallbackFn` callback, `await req.executeHop!("claude", …)`.

**The seam question came first and answered "not this seam".** The tempting fix was
tightening `MockAgentManagerOptions.runWithFallbackFn`'s parameter to require
`executeHop` — but the override is reached through BOTH dispatch paths (`run()` and
`runWithFallback()`), and `SessionManager.runInSession` drives requests that genuinely lack
`executeHop`; the real manager accepts hop-less requests too (it falls back to internal
send machinery). So the optionality is real, not type-erasure — **§1 route 2 does not apply
when the accessor's optionality is honest**, and `assertDefined` (route 4) is the correct
tool for a value that is optional for real.

Mechanically: one destructure + assert per callback, then plain calls. All 18 files green,
gates clean. Commit `904da46b9`.

Side finding: `lint:fix` auto-converted 15 pre-existing `@ts-ignore` directives in
`shell-security.test.ts` / `on-all-stories-complete.test.ts` to `@ts-expect-error`, which
surfaced them as TS2578 — they suppress nothing (the imports/functions have been exported
for a long time; HOOK_EVENTS long since contains the event). Deleted rather than converted;
`tsSuppress` 40 → 25 as a side effect. **A suppression that errors when unused is a lint for
dead suppressions — worth sweeping for on purpose, not by lint:fix accident.**

File-sizes: plan.test.ts and call.test.ts each +1 over grandfathered baselines from the
added assert lines; baselines raised by exactly that much with disclosure in the commit.
Compaction was attempted first but every route touched unrelated test semantics.

### 8.15 Batch 8 — declare the hook present, 362 → 311 (2026-08-26)

51 sites across 14 files, all `op.verify!` / `op.hopBody!` / `op.recover!` /
`strategy.extractApplied!`. Root cause one level up: the seven exported op constants annotate
themselves `: RunOperation<I, O, C>`, which erases which optional hooks the literal actually
defines; same for the two strategy factories returning `FixStrategy<…>` with `extractApplied?`.

**`satisfies` was tried first and reverted.** It makes the const's type the literal's own,
so `parse`'s return narrowed from the declared domain type to the literal's inferred union —
and unrelated `.failOpen` reads broke across several suites. The landed shape is a targeted
intersection, `RunOperationWithHooks<I, O, C, K>` (`src/operations/types.ts`):
`RunOperation<I, O, C> & { [P in K]-?: NonNullable<RunOperation<I,O,C>[P]> }`. Every other
signature stays declared; only the named hooks lose optionality; assigning an op that lacks a
listed hook still fails to compile, so the claim stays checked. Same shape for strategies:
`FixStrategyWithExtractApplied<F, I, O, C>` in `src/findings/cycle-types.ts`.
**This is a new §1 route, above "complete the fixture": when a shared type erases what a
concrete exported value defines, declare the hooks present instead of asserting them present
at fifty call sites.** The `NonNullable` matters: `-?` removes the optional modifier but an
indexed read still carries `undefined` into the property type. Commit `5cec76b31`.

### 8.16 Batches delegated — 311 → 0, rule promoted, drain closed (2026-08-26)

The remaining 311 sites across 100 files were all the captured-variable / indexed-read /
optional-config-field population — mechanical under the recipes, so per §6 ("delegate a
proven recipe with many sites left") four parallel delegates took disjoint file sets with a
written brief. **311/311 fixed, zero escalations, zero src changes**, verified at
integration by the owner: added-line diff audited for forbidden patterns (none), full gates
re-run (typecheck 0 all three, check:all, suite 14156/1173/38). Commit `435f6edd1`.

Two recipe refinements the delegates surfaced:

- **`let x: T | null = null` assigned inside a mock closure narrows to `null` at the
  read** — `assertDefined(x)` infers `NonNullable<null>` = `never` and fails to compile.
  Dropping the initializer alone trips TS2454. The working declaration is
  `let x: T | undefined;` with any `=== null` guards updated to `=== undefined`. This is the
  write-side twin of §1's vacuous-`?.` ruling.
- **`expect(x).toBeDefined()` immediately before reads does not narrow** and was folded into
  `assertDefined(x)` where both coexisted — strictly stronger, no line cost.

`cycle.test.ts` grew 3 lines past its grandfathered size baseline (+3 assertion lines);
raised with disclosure, consistent with batch 7's two files.

**Promote-back.** With biome reading 0, `biome.json`'s `test/**` override flipped
`noNonNullAssertion` `"off"` → `"error"` explicitly (kept, not deleted — §0's Biome-v2
correction). `biome check test/` exits 0; the regex ratchet baselines 2 residual matches,
both prose (`assert-defined.ts`'s doc comment explaining why `!` is invisible to counters)
and a fixture string exercising `foo!.bar → foo?.bar` edits — the parser-fixtures family §0
already documents for `asAny`/`anyType`.

Against the branch start: **biome nonNullAssert 1064 → 0 (−100%)**, regex 792 → 2 (prose).
Endgame item 4 closed; endgame complete.
