# Effectiveness attribution — design

Closes context-engine v2 gap item §9 (biased effectiveness classifier) and, on
top of it, §23 (close the effectiveness→scoring loop). §23 has been recorded as
hard-blocked on §9 since the 08-02 pass; this design unblocks it and then builds
it, in that order, behind a gate that can refuse to enable the loop.

## The defect, measured

> References below name **symbols**, not line offsets. Every `file:line` in
> the predecessor gap report went stale when `cli/rules.ts` was split four
> ways; re-locate by symbol.

`classifyWithTerms` (`src/context/engine/effectiveness.ts`) marks a chunk
`followed` when its 300-char summary shares ≥ 3 tokens of length ≥ 4 with the
**whole story diff**. Both operands grow with diff size, so the signal measures
how large the diff was, not whether the chunk mattered.

Measured over this repo's 12 real `.nax/rules/` chunks against 120 real commit
diffs, using the production path (frontmatter stripped, sliced to
`CHUNK_SUMMARY_CHARS = 300`):

| diff lines | n | mean `followed` / 12 |
|-----------:|--:|---------------------:|
| < 25       | 11 | 0.3 |
| 25–100     | 12 | 5.8 |
| 100–250    | 12 | 7.7 |
| 250–600    | 21 | 10.3 |
| 600–1.5k   | 32 | 11.7 |
| > 1.5k     | 32 | 12.0 |

Monotone in diff size, saturating around 600 lines. Two consequences:

- `pollutionRatio = (contradicted + ignored) / totalIncluded` (`pollution.ts`)
  is **inverted against story size** — high for small stories, ~0 for large ones.
  The AC-48 warning at `status-cost.ts` fires on the wrong stories.
- Feeding this to a learned scoring multiplier would teach the engine that every
  chunk is useful on large stories and useless on small ones.

Two earlier claims are corrected here for the record. The signal is **not**
"never `ignored`" — `ignored` fired 188 of 720 times in the 60-commit sample.
And saturation begins near 600 lines, not 16; an earlier measurement that said
otherwise had used whole rule files instead of the 300-char production slice.

## Why flatness is the wrong target

A classifier that always returns `ignored` is perfectly flat across diff sizes
and perfectly useless. Any metric that rewards flatness alone can be maximised
by a constant. There is currently no ground truth about which chunks actually
influenced a change, so **no formula change can be validated today** — including
the one this design recommends.

That inverts the natural build order. The evaluation set is not a test for the
classifier; it is the first deliverable, and the classifier is written against it.

## Approach

Three were considered.

**A — scope-limited deterministic attribution.** Attribute each chunk only
against the diff hunks for files the chunk's own scope admits, counting added
lines rather than whole hunks, and replace the absolute ≥ 3-shared-terms rule
with a size-independent criterion. Deterministic, no LLM cost, preserves the
"no LLM" contract stated in `effectiveness.ts`.

**B — A, plus an LLM judge for the residual.** For chunks whose scope is too
broad to discriminate, ask a cheap model whether the chunk influenced the
change. Breaks the deterministic contract and adds per-story cost scaling with
chunk count — and 89 % of chunk references in the 119 stored manifests are
`static-rules`, so that count is large.

**C — counterfactual attribution.** Infer usefulness from outcomes (pass rate,
rectify rounds) with and without the chunk, rather than from text overlap. This
is the only approach that measures usefulness rather than word overlap, and it
is what §23 ultimately wants. It needs far more runs per chunk than the 119
manifests on disk can supply.

**Chosen: A**, with B and C documented and unbuilt. C is the long-term target
and should be revisited once run volume supports it; B is an escape hatch to
open only if the labelled scores show errors concentrating in broad-scope chunks.

### Why A is cheaper than it looks

The carrier already exists. Rules declare `appliesTo:` globs — all 12 in this
repo do — `RuleSection` already inherits them (`rule-sections.ts`), and
`static-rules.ts` (`ruleMatchesScopeFiles`) already filters by them at
**selection** time against `request.scopeFiles`. What is missing is threading
that same scope through to **classification** time. No new concept is introduced;
an existing one is extended by one hop.

### Measured effect, and its honest limit

Simulating A's scoping over the same 120 commits:

| diff lines | now | scoped | scoped + added-lines only |
|-----------:|----:|-------:|--------------------------:|
| < 25       | 0.3 | 0.2 | 0.0 |
| 25–100     | 5.8 | 0.3 | 0.2 |
| 100–250    | 7.7 | 2.3 | 1.1 |
| 250–600    | 10.3 | 6.5 | 5.0 |
| 600–1.5k   | 11.7 | 8.1 | 6.5 |
| > 1.5k     | 12.0 | 9.3 | 7.9 |

Scoping eliminates the small- and mid-diff false positives outright, which is
where `pollutionRatio` is most inverted. It does **not** flatten the top end:
several rules are scoped `src/**/*.ts`, which matches nearly every file in a nax
diff, so coarse globs yield coarse attribution. A is a real improvement, not a
complete fix, and this design does not claim otherwise. Whether the residual
matters is a question for the labelled set, not for judgement.

## Components

### 1. Evaluation harness (built first)

- **Label store** — `test/fixtures/effectiveness/labels.json`: a list of
  `{ manifestPath, chunkId, chunkSummary, diffRef, label }` where `label` is
  `followed | ignored | contradicted | unclear`. Seeded by hand from the 119
  manifests already on disk; `unclear` is a first-class value and is excluded
  from scoring rather than forced into a bucket.
- **Scorer** — `scripts/eval-effectiveness.ts`: runs a named classifier over the
  label set and reports precision, recall and F1 per signal, plus the
  size-correlation statistic (Spearman ρ between diff size and `followed` rate).
  Reports the constant-`ignored` baseline alongside, so a flat-but-useless
  classifier is visibly flat-but-useless.
- **Gate** — a test asserting the shipped classifier beats the recorded baseline
  on the label set. This is the arc's real acceptance anchor.

### 2. Attribution threading

- `RawChunk` gains `scopePaths?: string[]` — the file globs this chunk claims to
  govern. Optional: chunks without it fall back to today's whole-diff behaviour,
  so non-rule providers are unaffected until they opt in.
- `StaticRulesProvider` populates it from the section's inherited `appliesTo`.
- `manifest-builder.ts` persists it alongside `chunkSummaries`, so
  classification (which runs post-story off the stored manifest) can read it
  without re-assembling context.
- `annotateManifestEffectiveness` splits the diff per file once, then classifies
  each chunk against only the concatenated added lines of the files its
  `scopePaths` admit.

### 3. Classifier

`classifyWithTerms` keeps its signature and signal set. The threshold changes
from an absolute shared-term count to a coverage ratio over the chunk's own
summary terms, which is what makes it size-independent. The exact criterion and
its constant are deliberately not fixed in this design — fixing them here would
repeat the unvalidated guess the current code makes. They are pinned in spec (1)
**after** the label set exists and before any implementation story runs, so the
constant lands as a measured value with the measurement recorded beside it.

`classifyEffectiveness`, the exported wrapper with zero `src/` callers (gap item
§9e), is **deleted**, and `classifyWithTerms` plus `buildEvidenceTerms` are
exported in its place so tests exercise the path production actually runs.
(Promoting the wrapper to the production entry point instead would discard the
per-story evidence pre-tokenisation that `buildEvidenceTerms` exists to provide.)
The current arrangement — unit tests exercising a wrapper production does not
call — is what let the bias survive a green suite.

### 4. The §23 loop

Built only after the harness shows the classifier beats baseline.

- A per-**provider** multiplier (not per-chunk) accumulated at run scope from
  observed signals, persisted under `.nax/` and read at assemble time.
  Per-provider keeps the state small and avoids learning noise from chunk IDs
  that change whenever a rule file is edited.
- Applied in `scoreChunk` (`scoring.ts`) as a **new, distinct factor**:
  `rawScore × roleMultiplier × kindWeight × freshnessMultiplier × learnedMultiplier`.
  It must not reuse `chunk.scoreMultiplier`, which `scoreChunk` applies only
  when the chunk `isStale` — folding it in there would leave it inert on every
  fresh chunk.
- Bounded (a floor and ceiling, so one bad run cannot zero a provider) and
  config-gated, default off.

## Error handling

Classification already runs inside a per-manifest `try/catch` that logs and
continues (`effectiveness.ts`); that stays. New failure modes are all
degradations, never throws: a chunk with no `scopePaths` falls back to whole-diff
attribution; an unparseable diff yields `unknown`; a missing or corrupt
multiplier store yields `1.0` — never a run failure, since a scoring input is
not worth aborting a run over.

## Testing

- Unit — `scopePaths` threading provider → manifest; per-file diff splitting,
  including renames and binary files; the multiplier's bounds and its
  independence from `scoreMultiplier`.
- Evaluation — the label set, gating precision/recall against the recorded
  baseline and the constant-`ignored` baseline.
- Regression — the size-correlation statistic must stay under its bound, so a
  future threshold tweak cannot silently reintroduce the bias.
- The size-correlation numbers in this document were produced ad hoc; the
  harness supersedes them and is the number of record from then on.

## Scope

Two specs, sequential: **(1)** harness + attribution + classifier, **(2)** the
§23 loop. (2) does not start until (1)'s labelled scores are in hand, and may be
abandoned if they show A does not beat baseline — in which case the honest
outcome is to retire `chunkEffectiveness` and the AC-48 warning rather than
learn from a signal that does not carry information.

Out of scope: approaches B and C; any change to `context.md`; any change to how
chunks are selected (this design reads `appliesTo`, it does not change selection).
