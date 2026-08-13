# SPEC: Effectiveness Attribution

<!-- spec-writing: completed-through-phase-6 -->

## Summary

Replace the context engine's whole-diff term-overlap effectiveness classifier with
scope-limited attribution, and build the evaluation harness that proves the
replacement is an improvement rather than a differently-shaped guess. Each context
chunk is classified against only the added lines of the diff files its own
`appliesTo` scope admits, instead of against the entire story diff.

## Motivation

`classifyWithTerms` in `src/context/engine/effectiveness.ts` marks a chunk
`followed` when its 300-character summary shares at least 3 tokens of length 4 or
more with the **whole story diff**. Both operands grow with diff size, so the
signal measures how large the diff was, not whether the chunk mattered.

Measured over this repository's 12 real `.nax/rules/` chunks against 120 real
commit diffs, through the production path (frontmatter stripped, sliced to
`CHUNK_SUMMARY_CHARS`):

| diff lines | n | mean `followed` / 12 |
|-----------:|--:|---------------------:|
| < 25 | 11 | 0.3 |
| 25-100 | 12 | 5.8 |
| 100-250 | 12 | 7.7 |
| 250-600 | 21 | 10.3 |
| 600-1.5k | 32 | 11.7 |
| > 1.5k | 32 | 12.0 |

Monotone in diff size, saturating near 600 lines. Two consequences:

- `pollutionRatio` in `computePollutionMetrics` is inverted against story size —
  high for small stories, near zero for large ones — so the operator-facing
  warning guarded by `POLLUTION_WARN_THRESHOLD` fires on the wrong stories.
- Gap item §23 (feeding this signal back into scoring) is blocked: a learned
  multiplier built on it would learn that every chunk is useful on large stories.

The carrier for the fix already exists. All 12 rules in this repository declare
`appliesTo:` globs, `RuleSection` already inherits them, and
`ruleMatchesScopeFiles` in `static-rules.ts` already filters by them at
**selection** time. This spec threads that same scope through to
**classification** time.

## Design

Full rationale, the approaches considered, and the measured limits of the chosen
one are in `docs/superpowers/specs/2026-08-13-effectiveness-attribution-design.md`.

References below name symbols, not line offsets.

### Approach

Scope-limited deterministic attribution. Classification stays deterministic with
no LLM call, preserving the contract stated in the `effectiveness.ts` module
header. Two alternatives were considered and rejected for this spec: an LLM judge
for chunks whose scope is too broad to discriminate, and counterfactual
attribution from run outcomes.

Scoping is a real improvement but not a complete fix. Simulated over the same 120
commits, mean `followed` falls from 5.8 to 0.2 of 12 in the 25-100 line band, but
only from 12.0 to 7.9 above 1.5k lines, because several rules are scoped
`src/**/*.ts`, which matches nearly every file in a nax diff. Whether that
residual matters is a question for the evaluation harness, not for judgement.

**Build order is load-bearing.** There is no ground truth for which chunks
mattered, and any flatness metric is maximised by a classifier that always
answers `ignored`. The harness is therefore built first, and the classifier is
written against it.

### Integration

Verified symbols this spec extends:

| Symbol | File | Current shape |
|:---|:---|:---|
| `RawChunk` | `src/context/engine/types.ts` | interface; has `providerId?`, `kind`, `scope`, `role`, `content`, `tokens`, `rawScore`, `staleCandidate?`, `scoreMultiplier?`. No path carrier. |
| `RuleSection` | `src/context/rules/rule-sections.ts` | already carries `appliesTo?: string[]` inherited from the owning rule |
| `StaticRulesProvider` | `src/context/engine/providers/static-rules.ts` | builds chunk ids as `static-rules:<ruleId>:<section.slug>:<hash>` |
| `buildManifest` | `src/context/engine/manifest-builder.ts` | `buildManifest(inputs: ManifestInputs): ContextManifest`. Chunks arrive as `inputs.packed: PackedChunk[]`; it populates `chunkSummaries[c.id] = c.content.slice(0, CHUNK_SUMMARY_CHARS)`, `CHUNK_SUMMARY_CHARS = 300`. **Has no test file today** — `buildManifest` has zero references under `test/`. |
| `ContextManifest` | `src/context/engine/manifest-types.ts` | has `chunkSummaries?`, `chunkEffectiveness?: Record<string, ChunkEffectiveness>` |
| `annotateManifestEffectiveness` | `src/context/engine/effectiveness.ts` | loads manifests, classifies each included chunk, writes back via read-modify-write inside a per-manifest `catch` |
| `classifyWithTerms` | `src/context/engine/effectiveness.ts` | module-private; takes `(chunkSummary, evidence)` |
| `buildEvidenceTerms` | `src/context/engine/effectiveness.ts` | module-private; pre-tokenises diff/output/findings once per story |
| `classifyEffectiveness` | `src/context/engine/effectiveness.ts` | exported wrapper with **zero `src/` callers** — exercised only by `effectiveness.test.ts` |

Patterns followed: the `_deps` injection pattern already used by
`_effectivenessDeps` and `_manifestStoreDeps`; `saveJsonFile` for atomic JSON
writes; barrel exports via `src/context/engine/index.ts`.

### File Format

The evaluation label set is a self-contained JSON file. It embeds every input the
scorer needs and references no path under `.nax/`, because
`purgeStaleManifests` deletes `context-manifest-*.json` files by age and would
otherwise silently empty the fixture.

```json
{
  "version": 1,
  "cases": [
    {
      "caseId": "rules-forbidden-patterns__US-014",
      "chunkId": "static-rules:forbidden-patterns:banned-apis:a1b2c3d4",
      "chunkSummary": "Forbidden patterns. mock.module() is banned; use the _deps pattern...",
      "scopePaths": ["src/**/*.ts"],
      "diffText": "diff --git a/src/agents/acp/adapter.ts b/src/agents/acp/adapter.ts\n@@ ...",
      "label": "followed",
      "note": "diff replaces a mock.module call with _deps injection"
    }
  ]
}
```

`label` is one of `followed`, `ignored`, `contradicted`, `unclear`. `unclear` is a
first-class value: cases carrying it are excluded from precision and recall rather
than forced into a bucket. `scopePaths` may be absent, representing a chunk whose
provider declares no scope.

### CLI Behavior

`nax context effectiveness eval [--labels <path>] [--json]`

- Exit `0` when the scored classifier meets or beats every recorded baseline
  threshold; exit `1` when it does not; exit `2` on a malformed or unreadable
  label file.
- Human output goes to stdout as a table of per-signal precision, recall and F1,
  followed by the size-correlation coefficient and the constant-`ignored`
  baseline row. Diagnostics and warnings go to stderr.
- `--json` emits a single `EvalReport` object to stdout and nothing else.

```
signal         precision  recall     f1
followed       0.82       0.77       0.79
ignored        0.71       0.80       0.75
contradicted   0.60       0.50       0.55
baseline(all-ignored)  0.31  1.00  0.47
size-correlation (spearman)  0.11   cases scored 84   excluded (unclear) 12
```

### Failure Handling

| Condition | Behaviour |
|:---|:---|
| Chunk has no `scopePaths` | Fail open — classify against the whole diff, as today. Non-rule providers are unaffected until they opt in. |
| `scopePaths` matches no file in the diff | Chunk is classified `ignored`. An empty scope slice is evidence of non-involvement, not missing data. |
| Diff text cannot be split into per-file sections | Fail open — classify against the whole diff and record the chunk's signal as `unknown`. |
| Label file missing, unreadable, or failing schema validation | The CLI exits `2` with the reason on stderr. It never falls back to a partial set, because a silently-shrunk label set would report inflated scores. |
| A single label case throws during scoring | Log a warning naming `caseId` and continue; the remaining cases still score. |
| Manifest read-modify-write fails during annotation | Unchanged from today — the existing per-manifest `catch` logs and continues to the next manifest. |

## Out of Scope

- The §23 effectiveness-to-scoring feedback loop — a learned per-provider
  multiplier applied in `scoreChunk` — is deferred to a separate spec that runs
  only after this spec's evaluation harness reports whether the new classifier
  beats the recorded baseline.
- An LLM-backed judge for chunks whose `appliesTo` scope is too broad to
  discriminate is deferred; this spec ships deterministic attribution only.
- Counterfactual attribution, inferring chunk usefulness from run outcomes rather
  than from text overlap, is deferred pending far more stored runs than exist.
- Authoring the hand-labelled evaluation cases is a manual data task performed
  outside any implementation story; stories here are verified against a synthetic
  fixture committed with the code.
- Populating `scopePaths` for providers other than `StaticRulesProvider` is
  deferred; those chunks keep today's whole-diff behaviour.
- No change to how chunks are selected for a bundle. This spec reads `appliesTo`
  at classification time and does not alter `ruleMatchesScopeFiles` or any
  selection-time filtering.
- No change to `context.md`, to `pollutionRatio`'s formula, or to the
  `POLLUTION_WARN_THRESHOLD` value.
- US-003 only: the classifier's coverage-ratio constant is not pinned to a
  specific value. It is whatever value makes US-003's two fixture-scored ACs
  pass, and the measured value is recorded alongside the fixture.

## Stories

**US-001 — Evaluation harness** (no dependencies)
Label-set loading with schema validation, per-signal precision/recall/F1 scoring,
the size-correlation coefficient, and the constant-`ignored` baseline row.
Produces the `EvalReport` shape that US-003's gate consumes.

- Context Files: `src/context/engine/effectiveness.ts`, `src/context/engine/types.ts`, `src/utils/json-file.ts`, `src/cli/context.ts`
- Creates: `src/context/engine/effectiveness-eval.ts`, `test/fixtures/effectiveness/labels.sample.json`, `test/unit/context/engine/effectiveness-eval.test.ts`

**US-002 — Attribution carrier** (no dependencies)
Add `scopePaths` to `RawChunk`, populate it in `StaticRulesProvider` from the
section's inherited `appliesTo`, and persist it through `buildManifest`
onto the stored manifest so post-story classification can read it.

- Context Files: `src/context/rules/rule-sections.ts`, `src/context/engine/manifest-types.ts`, `src/context/engine/packing.ts`
- Creates: `test/unit/context/engine/manifest-builder.test.ts`

No `Modifies` entry is needed. `buildManifest` has **no test file today** and zero
references under `test/`, so there is no closed-world assertion for
`chunkScopePaths` to break — the story authors that file instead.

`scopePaths` needs adding to `RawChunk` only: `PackedChunk extends ScoredChunk
extends RawChunk`, so the field reaches `buildManifest` through `inputs.packed`
with no further plumbing.

**Sizing constraint:** `static-rules.ts` is 583 lines against the project's
600-line source limit enforced by `bun run check:file-sizes`. Keep the
`scopePaths` population minimal; if the change would breach 600, extract the
chunk-construction block to a sibling module rather than growing the file.

**US-003 — Scoped classification** (depends on US-001, US-002)
Split the diff per file once per story, restrict each chunk's evidence to the
added lines of the files its `scopePaths` admits, and replace the absolute
shared-term threshold with a size-independent criterion. Gated by the US-001
harness against the recorded baseline.

- Context Files: `src/context/engine/manifest-store.ts`, `src/context/engine/effectiveness-eval.ts` — created by US-001, consumed here, `test/fixtures/effectiveness/labels.sample.json` — created by US-001, scored against here

**US-004 — Retire the test-only wrapper** (depends on US-003; terminal cleanup)
Delete the exported `classifyEffectiveness` wrapper, which has zero `src/`
callers and let the bias survive a green suite by giving tests a path production
never runs. Deletion-only: no new behaviour.

- Context Files: `src/context/engine/index.ts`, `src/context/index.ts`

Verification note for US-004: removals are verified by the build/static gate, not
by runtime acceptance criteria. Gate command: `bun run typecheck && bun run lint`.

### Modifies

**US-003**

- `test/unit/context/engine/effectiveness.test.ts` — its `classifyEffectiveness` cases assert whole-diff term-overlap outcomes that scoped attribution deliberately changes; a correct implementation fails them. Replace each with the equivalent assertion through `classifyWithTerms` plus `buildEvidenceTerms`, holding scope constant, so the invariant becomes "the same evidence under a fixed scope yields the same signal" rather than "the whole diff yields the same signal".

**US-004**

- `test/unit/context/engine/effectiveness.test.ts` — every remaining reference to the deleted `classifyEffectiveness` export must move to the `classifyWithTerms` + `buildEvidenceTerms` pair US-003 exports; the file cannot compile against a symbol this story removes.

### Seams

- **US-002 produces, US-003 consumes — data availability.** US-003's ACs read
  `scopePaths` off the stored manifest. US-002 must therefore persist it as a
  declared manifest field (`chunkScopePaths`), not merely set it on the in-memory
  `RawChunk`. US-002 carries an AC asserting the field survives a manifest
  write-then-read round trip.
- **US-001 produces, US-003 consumes — data availability.** US-003's gate AC
  reads per-signal `precision`/`recall`/`f1`, `sizeCorrelation`, and
  `baseline.f1` from the `EvalReport`. US-001 carries an AC asserting the report
  object exposes exactly those fields.
- **US-001 exports `scoreEffectiveness`; US-003 calls it.** US-003 carries a seam
  AC that stubs `scoreEffectiveness`, invokes the eval CLI command
  (`nax context effectiveness eval`, the outermost production entry point), and
  asserts the stub was called with the loaded case list.

## Acceptance Criteria

### US-001 — Evaluation harness

1. `[unit]` `loadLabelSet` is importable from `src/context/engine/effectiveness-eval.ts` and, given a JSON string holding `version: 1` and one well-formed case, returns a set whose `cases` array has length 1 and whose single entry's `caseId` equals the input's.
2. `[unit]` `loadLabelSet` given a JSON string whose single case omits `label` throws an error whose message names both `caseId` and the missing field `label`.
3. `[unit]` `loadLabelSet` given text that is not valid JSON throws an error distinguishable from the schema error by its error code, so the CLI can map it to exit `2`.
4. `[unit]` `scoreEffectiveness`, given a case list in which a classifier returns the recorded label for 3 of 4 scored cases, returns per-signal `precision`, `recall`, and `f1` numbers in the range 0 to 1 inclusive.
5. `[unit]` `scoreEffectiveness`, given a case list containing cases labelled `unclear`, excludes them from every per-signal precision and recall figure and reports their count separately as `excludedCount`.
6. `[unit]` `scoreEffectiveness` returns a `baseline` entry computed from a classifier that answers `ignored` for every case, so a flat classifier's score is always visible alongside the scored one.
7. `[unit]` `scoreEffectiveness` returns `sizeCorrelation`, the Spearman rank correlation between each case's diff length and whether the classifier answered `followed`; for a case list where `followed` is returned for exactly the longest half of the diffs, the value is greater than 0.9.
8. `[unit]` `scoreEffectiveness` returns `sizeCorrelation` near 0 (absolute value below 0.2) for a case list where the classifier's `followed` answers are evenly distributed across diff lengths.
9. `[unit]` the object returned by `scoreEffectiveness` exposes `perSignal`, `baseline`, `sizeCorrelation`, `scoredCount`, and `excludedCount`, which are the fields US-003's gate reads.
10. `[cli]` running `nax context effectiveness eval --labels <path to a fixture whose classifier meets every baseline threshold>` exits with code 0.
11. `[cli]` running `nax context effectiveness eval --labels <path to a nonexistent file>` exits with code 2 and writes a message naming the path to stderr.
12. `[cli]` running `nax context effectiveness eval --labels <fixture> --json` writes a single parseable JSON object to stdout whose keys include `perSignal` and `sizeCorrelation`, and writes no table rows to stdout.

### US-002 — Attribution carrier

1. `[unit]` a `RawChunk` value may carry `scopePaths` as an array of strings, and a `RawChunk` constructed without it is still accepted everywhere a chunk is accepted today.
2. `[integration]` `StaticRulesProvider.fetch`, run against a rules directory containing one rule whose frontmatter declares `appliesTo: ["src/agents/**/*.ts"]`, returns a chunk whose `scopePaths` equals `["src/agents/**/*.ts"]`.
3. `[integration]` `StaticRulesProvider.fetch`, run against a rules directory containing one rule with no `appliesTo` frontmatter, returns a chunk whose `scopePaths` is absent.
4. `[integration]` two sections of the same rule file both carry that rule's `appliesTo` globs in their `scopePaths`, because scope is inherited from the owning rule rather than declared per section.
5. `[unit]` `buildManifest`, given a `ManifestInputs` whose `packed` list contains at least one chunk declaring `scopePaths`, returns a manifest whose `chunkScopePaths` maps that chunk's id to its globs.
6. `[unit]` `buildManifest`, given a `ManifestInputs` whose `packed` chunks all lack `scopePaths`, returns a manifest with `chunkScopePaths` absent, matching how `chunkSummaries` is omitted when empty.
7. `[integration]` writing a manifest that carries `chunkScopePaths` with `writeContextManifest` and reading it back with `loadContextManifests` yields the same chunk-id-to-globs mapping.

### US-003 — Scoped classification

1. `[unit]` `splitDiffByFile` is importable from `src/context/engine/effectiveness.ts` and, given a unified diff touching two files, returns a mapping from each file's post-image path to only that file's section.
2. `[unit]` `splitDiffByFile`, given a diff containing a rename, keys the section by the post-rename path.
3. `[unit]` `splitDiffByFile`, given a diff containing a binary-file marker, returns that file with an empty section rather than throwing.
4. `[unit]` given a chunk whose `scopePaths` is `["src/agents/**/*.ts"]` and a diff touching only `src/cli/context.ts`, classification returns `ignored`, even when the chunk summary and the diff share more than three terms.
5. `[unit]` given a chunk whose `scopePaths` is `["src/agents/**/*.ts"]` and a diff touching both `src/agents/acp/adapter.ts` and `src/cli/context.ts`, the terms considered come only from the `src/agents/acp/adapter.ts` section.
6. `[unit]` given a chunk with no `scopePaths`, classification considers the whole diff, preserving today's behaviour for providers that declare no scope.
7. `[unit]` classification considers only added lines: a chunk whose terms appear exclusively in the diff's removed and context lines, and never in an added line, is not classified `followed`.
8. `[unit]` a chunk classified `followed` returns evidence naming at least one file path from the scoped slice, so an operator can tell which change earned the signal.
9. `[integration]` `annotateManifestEffectiveness`, run over a stored manifest whose `chunkScopePaths` restricts one chunk to files the diff does not touch, writes `ignored` for that chunk and does not write `followed`.
10. `[integration]` scoring the committed synthetic fixture reports a `sizeCorrelation` for the scoped classifier whose absolute value is strictly smaller than the `sizeCorrelation` the same fixture yields for the pre-change whole-diff classifier, so the improvement is measured against the classifier being replaced rather than against a hardcoded bound.
11. `[integration]` scoring the committed synthetic fixture reports a `followed` F1 strictly greater than the `baseline.f1` returned in the same report, so a constant classifier cannot pass this gate.
12. `[integration]` stubbing `scoreEffectiveness` and invoking `nax context effectiveness eval --labels <fixture>` calls the stub exactly once with a case list whose length equals the fixture's case count.

**Out of scope:** tuning the classifier's coverage-ratio constant to a specific value is deliberately not pinned here; the constant is whatever value makes AC-10 and AC-11 pass, and the measured value is recorded alongside the fixture.

### US-004 — Retire the test-only wrapper

1. `[unit]` `classifyWithTerms` and `buildEvidenceTerms` are importable from `src/context/engine/effectiveness.ts`, and classifying a chunk summary against evidence built by `buildEvidenceTerms` returns the same signal the story's other tests expect.
2. `[unit]` `classifyWithTerms` reached through the `src/context/engine` barrel behaves identically to the direct import, so the barrel export is wired rather than merely declared.

Verification note: the removal of `classifyEffectiveness` is verified by the
build/static gate, not by an acceptance criterion. Gate command:
`bun run typecheck && bun run lint`.
