# Effectiveness → Scoring Feedback Loop (context-engine §23)

Date: 2026-08-13
Status: design approved, spec pending
Closes: context-engine v2 gap §23
Depends on: §9, closed by #1570 (`9cd4cb02`)

## Summary

Close the effectiveness→scoring loop by deriving a per-provider score multiplier
from the `ignored` verdicts recorded on prior stories' context manifests, and
extend scoped attribution (`scopePaths`) to the two non-floor providers whose
score that multiplier can actually act on.

The two halves are not independent. The second is a prerequisite for the first,
for a reason that was not visible until the floor rules were re-read — see
[Why the provider half comes first](#why-the-provider-half-comes-first).

## Background

`chunkEffectiveness` has been written to stored manifests since Amendment A
AC-45, and nothing has ever read it back into scoring. §23 called for a
"per-provider learned multiplier persisted at run scope", and was held blocked
on §9 because the classifier it would learn from was a monotone function of diff
size: closing the loop on it "would teach the engine that every rule chunk is
always useful".

#1570 replaced whole-diff term overlap with scope-limited attribution. The bias
is reduced, not retired. Measured on the same corpus, mean `followed` per 12
chunks fell from 5.8 → 0.2 for 25–100 line diffs, but only 12.0 → 7.9 above
1.5k lines, because most rules declare `appliesTo: src/**/*.ts`, which admits
nearly every changed file.

So the design question is not "is the signal clean now" — it is not. It is
"which part of the signal is clean enough to act on".

## Why the provider half comes first

`orchestrator.ts:382-383` drops `belowMinScore` chunks for every kind *except*
`FLOOR_KINDS`, and `packing.ts` includes floor chunks regardless of budget:

```ts
export const FLOOR_KINDS: ChunkKind[] = ["static", "feature", "test-coverage"];
```

A learned downweight applied to a `static-rules` chunk is therefore a **complete
no-op**. Static, feature, and test-coverage chunks cannot be scored out of the
context at any multiplier.

The kinds scoring can actually prune are `session` (session-scratch), `history`
(git-history), `neighbor` (code-neighbor), and the plugin kinds (`rag`, `graph`,
`kb`).

#1570 populated `scopePaths` on `StaticRulesProvider` only — the one provider
whose score can never change anything. Every provider the §23 loop is allowed to
act on currently has no `scopePaths`, so its verdicts still come from the
whole-diff path, which is the biased one.

Extending `scopePaths` to those providers is therefore not an optional
enhancement bundled for convenience. Without it, §23 would learn from the biased
classifier on precisely the providers it can act on — a smaller version of the
original blocking objection.

## Design decisions

### D1 — Learn only from `ignored`, and only downward

The multiplier is a function of the `ignored` ratio alone, and is clamped to
`[MIN_WEIGHT, 1.0]`. `followed` is not consumed.

Note on vocabulary, since "floor" is otherwise overloaded in this subsystem:
`MIN_WEIGHT` is the multiplier's lower clamp. It is unrelated to `FLOOR_KINDS`,
which is the always-included chunk-kind set. This document uses "floor"
exclusively for the latter.

Rationale: the classifier's residual bias runs toward **false `followed`** on
large diffs — it over-reports usefulness. It has no known bias toward false
`ignored`. `ignored` is the verdict that survives the remaining noise, and it is
exactly the pruning signal §23 exists to produce.

The asymmetry is the safety property, not a limitation. A biased signal can then
only make the engine more conservative; it can never amplify a chunk it wrongly
believes was followed. If the residual bias is worse than measured, the failure
mode is under-pruning — the status quo — not over-trust.

### D2 — Derive per story from manifests already on disk; no new store

Before each story, aggregate `chunkEffectiveness` across the feature's stored
manifests via `loadContextManifests`, and compute the weights in memory. Story N
benefits from stories 1..N-1.

Rejected: a persisted `effectiveness-weights.json` accumulating across runs. It
buys a larger sample and no cold start, at the cost of a new schema, a retention
policy, a gc path, and a staleness story. Open issue #1445 (curator rollup grows
unbounded because gc is never invoked) is that exact failure mode already in
this repo. Deriving from manifests inherits `purgeStaleManifests` (#1541) for
free: a purge shrinks the window, and the weights degrade to 1.0.

Rejected: repo-wide aggregation across all features. Bigger sample, but mixes
evidence from features whose provider usefulness genuinely differs.

### D3 — `providerId` is the learning key

Chunk IDs embed a content hash — `git-history:${contentHash8(content)}`,
`code-neighbor:${contentHash8(content)}`,
`static-rules:${ruleId}:${slug}:${hash}` — so nothing keyed on chunk ID survives
a content edit. For the providers that matter, `providerId` is the only stable
key available.

§23's original "per-provider" wording is correct, for a reason the gap doc did
not state.

### D4 — A fifth scoring operand, not a reused field

```
adjustedScore = rawScore × roleMultiplier × kindWeight × freshnessMultiplier × effectivenessMultiplier
```

`RawChunk.scoreMultiplier` is already owned by staleness and must not be
overloaded. The effectiveness multiplier is caller-derived rather than
provider-declared, so it reaches the orchestrator through `ContextRequest` —
following the precedent `minScore` already sets at
`src/pipeline/stages/context.ts:158`, whose comment states the intent: "passed
through ContextRequest so callers control it without coupling the orchestrator
to NaxConfig."

### D5 — Constants are not acceptance criteria

Carried forward from the §9 arc: the ratio coefficient, `MIN_WEIGHT`, and the
minimum observation count are not knowable at authoring time. ACs assert
*properties* — monotone non-increasing in the ignored ratio, never above 1.0,
identity below the observation gate, never below `MIN_WEIGHT` — and the
constants are whatever satisfies them.

## Safety properties

| Property | Consequence if violated |
|:---|:---|
| Multiplier never exceeds 1.0 | A false `followed` could amplify a useless chunk |
| Identity below `MIN_OBSERVATIONS` | Story 1 would score against a one-sample guess |
| Clamped at `MIN_WEIGHT` | A provider could be effectively silenced by a noisy window |
| Floor kinds unaffected | Silent behaviour change to always-included context |

The blast radius is bounded by construction: the only chunks a weight can remove
are non-floor chunks that were already subject to `minScore`, and the engine
retains its pull-tool surface for context it did not push.

## Provider scoping

Both target providers emit a single aggregate chunk, so `scopePaths` is the
union of the files that chunk actually describes.

**`GitHistoryProvider`** — scope must be the files that *produced a section*,
not `filesToProcess`. `fetchFileHistory` returns `null` for files with no
history and those are filtered out, so deriving scope from the input list would
claim scope over files the chunk says nothing about. This requires keeping a
per-file association instead of the current map-then-filter over a parallel
array.

**`CodeNeighborProvider`** — scope is each `file` key plus the neighbour paths
listed beneath it. `src/context/engine/providers/code-neighbor.ts` is **613
lines**, over the 600-line limit and grandfathered by
`bun run check:file-sizes`, so it cannot grow. The chunk-assembly path must be
extracted into a sibling module.

## Verification

The executable anchor already exists. #1570 shipped `loadLabelSet` /
`scoreEffectiveness`, the `nax context effectiveness eval` command, and a
committed synthetic fixture at `test/fixtures/effectiveness/labels.sample.json`.

The provider stories extend that fixture with `neighbor` and `history` cases and
assert the same property the §9 arc used: scoped `sizeCorrelation` strictly
smaller in magnitude than whole-diff on the same fixture. Reusing the existing
harness avoids inventing a second, unvalidated notion of "better".

## Stories

1. **US-001** — `scopePaths` on `GitHistoryProvider`, including the per-file
   section association fix.
2. **US-002** — `scopePaths` on `CodeNeighborProvider`, with the chunk-assembly
   module extraction required to stay under the size limit.
3. **US-003** — `deriveProviderWeights()`: pure aggregation over
   `StoredContextManifest[]`, with the observation gate, `MIN_WEIGHT`, and the
   never-above-1.0 clamp.
4. **US-004** — thread the weights through `ContextRequest` into `scoreChunk`,
   and pin that floor kinds remain included at any weight.

US-004 depends on US-003. US-001 and US-002 are independent of both and of each
other.

## Out of scope

- Cross-run persistence of learned weights (D2).
- Per-rule-section granularity (D3).
- LLM-judged attribution for broad-scope chunks.
- Counterfactual attribution from run outcomes.
- `scopePaths` for `SessionScratchProvider`, `FeatureContextProvider`, and
  plugin providers — all keep whole-diff fail-open behaviour.
- Consuming the `followed` verdict in any scoring path (D1).

## Known limitation

**This cannot prune static rules.** They are floor-included by design, so the
largest single block of injected context stays outside the loop's reach. Their
`ignored` verdicts still feed `pollutionRatio` for the operator, but nothing
acts on them automatically.

If pruning static rules is the actual goal of §23, that requires a floor-kind
policy change — a separate and larger decision, deliberately not smuggled into
this spec.
