# Rules budget: stop the silent tail-drop, meter what the provider discards

**Date:** 2026-08-04
**Branch:** `fix/rules-budget-truncation`
**Base:** `main` @ `4765ca1f`
**Status:** design, pending implementation plan

## Problem

`StaticRulesProvider` hard-truncates the canonical rules store before the packer
ever sees it. On this repository, measured against the real `.nax/rules/` store:

| | tokens | files |
|:--|--:|:--|
| Corpus | 16,425 | 11 |
| Cap (`DEFAULT_CANONICAL_RULES_BUDGET_TOKENS`) | 8,192 | — |
| Delivered | 8,080 | forbidden-patterns, project-conventions, error-handling, testing-commands, test-architecture, config-patterns |
| **Discarded** | **8,345** | **adapter-wiring, test-helpers, monorepo-awareness, retry-strategy, test-writing** |

Every retry rule, every monorepo rule, and most testing rules never reach any
prompt of any stage.

Three things make this worse than a tuning problem:

1. **It contradicts the floor contract.** `static` is a floor kind
   (`packing.ts:36`). Floor chunks are deliberately packed even when they
   overflow the stage budget — `packChunks` never drops them. But the provider
   hard-drops rules *before* packing, so the packer's "never drop rules"
   guarantee is applied to a set that has already lost half its members. The
   provider's ceiling and the packer's floor semantics are in direct conflict.

2. **The loss is unmetered.** `static-rules.ts:245-252` logs a warn carrying
   `droppedCount`, but nothing reaches `StoryMetrics`. A warn in a long run is
   not an observability story, which is why this went unnoticed through seven
   PRs into the context engine in two days.

3. **The provider has no channel to report it.** `ContextProviderResult`
   (`types.ts:543-552`) carries only `chunks` and `pullTools`. Even if the
   orchestrator wanted the number, the provider cannot hand it over.

`applyCanonicalRulesBudget` `break`s at first overflow (`canonical-loader.ts:391`)
and the sort is ascending `priority:`, so the discard is a contiguous tail and
*higher* `priority:` numbers die first. That is intended and documented
(`schemas-context.ts:63`); the design is what is being revisited, not a bug in
its implementation.

## Non-goals

- **Tier-1 rule digests / `query_rules` pull tool.** The agreed destination is a
  two-tier scheme: an always-on tier carrying every rule's prohibitions, plus
  full text on demand. It needs authored per-rule summaries and should be
  designed against measured data. Separate arc.
- **Scoping the 6 unscoped rule files.** Complementary, and it shrinks what
  competes, but it is second-order once nothing is discarded.
- **The `touchedFiles`-empty hole** (`static-rules.ts:141`) that makes
  `appliesTo:` inert for stories declaring no context files. Belongs with the
  scoping work.
- **The effectiveness classifier.** Tracked separately; blocks the Tier-3 write
  path, not this.
- Any change to `packChunks`, floor semantics, or stage budgets.

## Design

### 1. The provider cap becomes soft by default

`budgetTokens` stops being a guillotine and becomes a **reporting threshold**.
By default no rule is discarded; the overage is logged and metered instead —
exactly how floor overage is already handled one layer down.

This resolves the contradiction in Problem #1 rather than picking a larger
arbitrary number. A bigger constant would only move the cliff, and the cliff
would return silently as the corpus grows.

`applyCanonicalRulesBudget(rules, budgetTokens, { enforce })`:

- `enforce: false` (default) — returns **all** rules. `usedTokens` is the true
  total; `droppedCount` is 0; a new `overageTokens` reports
  `max(0, total - budgetTokens)`.
- `enforce: true` — current behaviour exactly: tail-drop at first overflow.

New config key `context.v2.rules.enforceBudget: boolean = false`
(`schemas-context.ts`). Operators with a genuinely oversized corpus keep a hard
ceiling; the default stops losing content.

### 2. A metadata channel on provider results

Add one optional field to `ContextProviderResult`:

```ts
/** This provider's own budget pressure — how far over, and what it discarded. */
budgetPressure?: {
  /** max(0, produced - providerBudget). Non-zero whenever the provider is over. */
  overageTokens: number;
  /** Items discarded to satisfy the budget. Zero unless the budget is enforced. */
  droppedCount: number;
  droppedTokens: number;
  /** Stable ids of the discarded items, for manifest-level debugging. */
  droppedIds: string[];
};
```

Generic rather than rules-specific: it is a property of "provider self-limited",
and putting a `rulesTruncation` field on a shared type would be wrong even
though static-rules is the only provider with an internal budget today. The
orchestrator copies it onto the matching `providerResults[]` entry in the
manifest.

Reporting **overage separately from drops** is what keeps the default path
observable. In soft mode nothing is discarded, so a drop-only metric would be
permanently zero and tell you nothing — while the fact that your corpus is 8.2k
over its threshold is precisely the signal worth having.

### 3. Metric

Extend the existing `ContextProviderMetrics` (`metrics/types.ts:72`) rather than
adding a new top-level metric:

```ts
budgetPressure?: { overageTokens: number; droppedCount: number; droppedTokens: number };
```

`tracker.ts:57-80` already loops per provider per manifest and aggregates
`tokensProduced` / `chunksKept` / `timedOut`; the new fields sum in the same
loop. Ids stay in the manifest and are deliberately **not** aggregated into
metrics — unbounded growth across stages, and the manifest is the right place to
look them up.

Result: `nax status` and the metrics report show, per provider, how far past its
own budget that provider ran and how much it threw away — two classes of signal
the system previously had no vocabulary for.

### Data flow

```
canonical-loader.applyCanonicalRulesBudget(rules, cap, {enforce})
  -> {rules, totalTokens, usedTokens, droppedCount, overageTokens}
       |
static-rules.fetch()
  -> ContextProviderResult{chunks, budgetPressure?}
  -> budgetPressure present whenever totalTokens > cap (soft OR enforced)
  -> warn, as today
       |
orchestrator provider loop
  -> manifest.providerResults[i].budgetPressure
       |
metrics/tracker.collectContextMetrics()
  -> StoryMetrics.context.providers[id].budgetPressure
```

Default (`enforce: false`) on this repo today: `overageTokens: 8233`,
`droppedCount: 0` — "you are well over your rules threshold and shipping all of
it anyway". With `enforce: true`: `overageTokens: 8233, droppedCount: 5`.
Under budget, `budgetPressure` is absent entirely.

## Error handling

- `budgetTokens <= 0` or non-finite: unchanged — returns no rules, all counted
  dropped. Already covered (`canonical-loader.ts:376-384`).
- Soft mode never throws and never returns fewer rules than it was given.
- `NeutralityLintError` propagation from the loader is untouched (that is
  finding 1's fail-closed behaviour from #1449 — must not regress).
- Manifests written before this change lack `droppedByBudget`; the tracker treats
  absent as "nothing dropped" rather than inferring, matching how
  `computeFloorOverage` handles legacy manifests without `effectiveBudget`.

## Testing

`applyCanonicalRulesBudget` already has unit coverage
(`test/unit/context/rules/canonical-loader.test.ts:383`); extend it.

1. **Soft mode returns everything** — corpus over budget, `enforce: false` ⇒ all
   rules returned, `droppedCount === 0`, `overageTokens === total - cap`.
2. **Enforce mode preserves today's behaviour** — same input, `enforce: true` ⇒
   identical kept/dropped set to current `main`. Pins the escape hatch.
3. **Provider reports pressure in soft mode** — `StaticRulesProvider` over budget
   with `enforce: false` returns `budgetPressure` with the right `overageTokens`
   and `droppedCount === 0`. This is the default path, so it is the one that
   must not silently report nothing.
4. **Provider reports drops when enforcing** — same store, `enforce: true` ⇒
   correct `droppedCount`, `droppedTokens` and `droppedIds`.
5. **Metric aggregates across stages** — two stage manifests each carrying
   `budgetPressure` ⇒ tracker sums both into one per-provider figure.
6. **Regression against the real store** — load this repo's actual `.nax/rules/`
   under default config and assert all 11 rule files are delivered and
   `usedTokens > 8192`. This is the acceptance anchor: it fails on `main` today
   and passes after the change.

Test 6 deliberately reads the repository's own rules store rather than a
fixture, following the US-004 precedent from the budget-truth arc: a
fixture-only test goes green without the real store ever being delivered
correctly. Cost: it couples to rule authoring, so it asserts on file *count* and
a token floor, not on rule content.

## Risks

**Prompts get bigger.** Rules go from ~8.1k to ~16.4k delivered per stage. Rules
are floor-kind, so on the three stages budgeted at 4,000 (`stage-config.ts`) the
floor overrun goes from roughly 2x to 4x. This is a real cost in tokens and
money on every agent call.

Accepted deliberately: a 200k context window absorbs the tokens, whereas a
missing prohibition ships a bug — and these rules are regression-derived, with
`forbidden-patterns.md` citing shipped incidents. The `floorOverage` metric
from #1456 already makes the enlarged footprint visible, and this change adds
the counterpart figure for what is lost.

**Rollback** is `context.v2.rules.enforceBudget: true`, which restores current
behaviour exactly, now with the loss metered.

**What this does not fix:** whether the delivered 16.4k is *worth* its cost. That
is the measurement this change exists to enable, and the input to the two-tier
design.
