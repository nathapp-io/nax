# SPEC: Bound the quality reviewer's WALK to changed files

## Summary

The finish phase's QUALITY reviewer is asked to emit one `## WALK` line per
function or method the diff adds or changes — an enumeration whose size grows
with the diff, in the same single reply that must also carry its findings. This
spec bounds that enumeration to **one line per changed file**, keeps the
per-function walk as private scratch work, stops pointing the quality reviewer at
a spec it does not review against, and makes the `auditGaps` obligation check
compare the WALK against the diff's actual changed-file list instead of merely
checking that a WALK section exists.

## Motivation

Across 33 recorded finish runs (117 audit records under `<project>/finish-audit/`),
the two reviewer phases diverge sharply on first-attempt health:

| phase | first attempts | healthy (`passed`/`fixed`) | broken |
|:---|---:|---:|---:|
| spec | 33 | 24 — **72%** | 9 |
| quality | 29 | 10 — **34%** | 19 |

Both phases run the same operation (`finishReviewOp`), the same parser
(`parseReviewReport`), the same retry strategy (`makeParseRetryStrategy`) and the
same three-section reply contract. The failure is concentrated entirely in the
quality phase, and it has survived a change of reply format:

- Under the JSON reply contract (through 2026-08-17): 9 quality first attempts
  came back `unparseable`; the JSON object had nowhere to put the enumeration at
  all, which issue #1614 measured as 2 findings against a comparison review's 14
  on an identical diff.
- Under the prose block contract (from 2026-08-18): `unparseable` fell to zero,
  and both recorded quality runs instead came back `incomplete` — the shape gate
  rejecting a token WALK. One of the two escalated on its second attempt.

The format changed; the failure rate did not. The one structural difference
between the two phases is the size of what they are asked to enumerate:

- spec WALK — *one line per AC in the spec* — bounded; `maxAcCount` caps it at 24.
- quality WALK — *one line per function or method the diff adds or changes* —
  unbounded in the size of the diff.

On a large diff the quality reviewer must emit hundreds of enumeration lines
before it reaches `## FINDINGS`, and it resolves that pressure in one of two
ways: run out of budget mid-reply, or emit a token walk to get to the findings.
Both are observed. The reference this behaviour was ported from
(`references/code-quality.md`) asks the reviewer to *"write **yourself** a
one-line verdict for each"* — private scratch work, cheap to be exhaustive — and
has the worker return findings only. The port turned that private forcing
function into a public output obligation, because nax-finish has no human reading
the reply and needed the walk to be checkable.

Issue #1635 separately observes that `auditGaps` checks the WALK's *shape* and
not its *coverage*: a WALK naming 4 of 30 changed items passes exactly like a
complete one. Bounding the WALK to files is what makes that gate cheap and exact
— comparing file paths to `git diff --name-only` is a set comparison, where
matching free-text per-function lines would have required the fuzzy substring
matching #1635 itself flags as an open question.

Secondarily, `buildReviewPrompt` currently instructs **both** phases to read the
spec in full (`The spec/requirements source is: <path>. Read it in full.`). The
quality dimension is spec-independent by definition, and the reference design
this was ported from explicitly directs the quality worker not to read the spec
or project rules, so that spec-compliance work does not crowd out the open-ended
quality pass.

## Design

The change is two independent edits to the reviewer prompt, plus one edit to the
obligation gate that the first of those makes tractable.

### Integration

Verified symbols and signatures at `HEAD` of `main`:

- `buildReviewPrompt(phase, args)` — `src/finish/review/prompt.ts`. Builds both
  phases' prompts. Its private `outputContract(phase)` holds the per-phase WALK
  instruction. Both its branches (fresh review, and the `since`-narrowed
  re-review) emit the spec-path instruction unconditionally.
- `auditGaps(report: ReviewReport, workdir: string): Promise<string[]>` —
  `src/finish/review/audit-gaps.ts`. Currently checks three things: a non-empty
  `## TOUCHPOINTS` section, that at least one cited touchpoint path stats on disk
  (`found.some(Boolean)`), and a non-empty `## WALK` section. `MAX_CHECKED = 20`
  bounds the stat count. Its `exists()` helper already confines a resolved path
  under `workdir` before stat-ing it.
- `finishReviewOp.verify(parsed, input, ctx)` — `src/operations/finish-review.ts`.
  The only caller of `auditGaps`. `FinishReviewInput` already carries `base`, and
  `src/finish/ops-impl.ts` already populates it (`base: state.base`), so the
  diff range needed by the new gate is available with no plumbing above the op.
- `gitWithTimeout(...)` — `src/utils/git.ts`. The repo's sanctioned git helper,
  backed by the injectable `_gitDeps.spawn` seam that tests stub. This is the
  mechanism the new changed-file lookup uses; it satisfies the Bun-native rule
  in `.nax/rules/project-conventions.md` and gives the new gate a test seam
  without a git fixture.
- `report.walk: string[]` — `src/finish/types.ts`, populated by
  `parseReviewReport` (`src/finish/review/parse.ts`) as raw trimmed lines. The
  parser is **not** changed by this spec; the leading path token is extracted
  where it is consumed, in `audit-gaps.ts`.
- `NAX_ARTIFACT_PATHSPEC = "**/.nax/**"` — `src/finish/pr/context.ts`, currently
  module-private. It is the same exclusion the new gate needs, but the gate
  **defines its own** noise-filter constants in `audit-gaps.ts` rather than
  exporting this one. Widening a constant's visibility across module boundaries
  is a change `src/finish/pr/context.ts` does not need and this story is not
  authorised to make; duplicating a four-character glob is the cheaper seam.

Generated-prompt constraint: `src/finish/review/prompts.gen.ts` is generated from
`src/finish/review/references/*.md` by `scripts/generate-review-prompts.ts`, and
`scripts/check-review-prompts-generated.ts` fails the build if it is stale. The
reference markdown is the edit target; `prompts.gen.ts` is regenerated, never
hand-edited.

### Approach

**The WALK becomes per-file; the per-function walk stays, privately.** The
forcing function is what finds the defects — it is not being removed. What
changes is that its output no longer has to be transcribed into the reply. The
reviewer walks every changed function in its own reasoning, then emits one line
per changed *file* carrying that file's verdict. `references/code-quality.md`
and `outputContract("quality")` are updated together so the reference and the
reply contract continue to agree; a disagreement between those two is the
regression that PR #1636 fixed and this spec must not reintroduce.

**Coverage gating is per-file and exact.** `auditGaps` gains the diff range,
lists the changed files, subtracts the noise classes the worker protocol already
tells the reviewer to ignore, and requires the WALK to name all of them. The
comparison is exact-path, on the leading token of each WALK line. When files are
unwalked, the gap message names them, so the re-review is directed rather than
generic.

**One directed re-review before escalation — no new machinery.** `routeReview`
already routes gaps to `incomplete` while `incompleteAttempts <
MAX_INCOMPLETE_ATTEMPTS` (cap 1) and escalates past it. A coverage gap therefore
already produces exactly one directed re-review before escalating. `route.ts` is
deliberately not changed.

**The spec phase is not touched.** It is at 72% first-attempt health, its
enumeration is already bounded, and it does need the spec. Changing it would be
speculative work on the phase that is not failing.

### Failure Handling

| Condition | Behaviour |
|:---|:---|
| The changed-file listing fails (git error, non-zero exit, timeout) | Emit no coverage gap. The gate degrades to its current shape-only checks rather than failing a review over an infrastructure error — a spurious gap escalates the run at `MAX_INCOMPLETE_ATTEMPTS = 1`. |
| The diff has no reviewable changed files after the noise filter | Emit no coverage gap. There is nothing to require the WALK to name. |
| A WALK line has no extractable leading path token | It contributes no coverage; it is not itself an error. Unwalked files are reported by absence, not by malformed-line detection. |
| The reviewer's WALK names a path not in the changed set | Ignored for coverage purposes. Over-walking is not a defect. |

## Out of Scope

- Gating the SPEC phase's WALK against the spec's AC list. Issue #1635 proposes
  it; the spec phase is at 72% first-attempt health with no observed failure, so
  it is deferred to its own issue rather than bundled here. #1635 is descoped to
  the quality phase.
- Changing `MAX_INCOMPLETE_ATTEMPTS`, `MAX_FIX_ATTEMPTS`, or any routing
  threshold in `src/finish/route.ts`.
- Changing `parseReviewReport` or the `ReviewReport` shape. The WALK stays
  `string[]`; the path token is extracted at the point of use.
- Changing the reply format to JSON, or altering the parse-retry strategy on
  `finishReviewOp`. Measurement shows the failure is not format-bound.
- Adding a diff-size guard or splitting the quality review across multiple
  workers. The finish phase already runs spec and quality as two separate
  sequential reviewer operations with independent session roles.
- Updating `finish-audit-stats.py`. It lives in the separate `nax-global`
  repository (`~/.nax` is a symlink to it) and cannot be modified from this repo.
- Demonstrating that the reviewer's real-world finding yield or first-attempt
  health improves. That is behavioural on a live model and is measured over
  subsequent runs against the 34% baseline recorded above; no acceptance
  criterion in this spec asserts it.

## Stories

**US-001 — Bound the quality reviewer's reply contract** *(no dependencies)*

Change the quality phase's `## WALK` instruction from one line per changed
function to one line per changed file, keeping the per-function walk as private
scratch work in the dimension reference; and stop instructing the quality
reviewer to read the spec. Both edits land in `buildReviewPrompt` /
`outputContract` and the quality dimension reference, and both necessarily break
the same existing test file, so they ship as one story.


**US-002 — Gate the WALK against the diff's changed files** *(depends on US-001)*

Make `auditGaps` diff-relative: list the changed files for the review's range,
subtract noise, and report the files the WALK does not name. Tighten the
touchpoint check from "at least one cited path exists" to "most cited paths
exist". Applies to the quality phase only.


### Context Files

Files each story reads for context. None is authored by the story that lists it.

**US-001**

- `src/finish/review/prompt.ts`
- `src/finish/review/references/code-quality.md`
- `src/finish/review/references/spec-review.md`
- `scripts/generate-review-prompts.ts`

**US-002**

- `src/finish/review/audit-gaps.ts`
- `src/operations/finish-review.ts`
- `src/utils/git.ts`
- `src/finish/pr/context.ts`
- `src/finish/types.ts`

### Modifies

Existing files whose correct change under this spec necessarily breaks them.
Each bullet names exactly one path; the bold line above a group is its owning
story.

**US-001**

- `test/unit/finish/review-prompt.test.ts` — its test *"the quality prompt asks
  for a per-function walk, the spec prompt for a per-AC walk"* asserts the
  returned quality prompt contains `one line per function`. That assertion pins
  the exact contract this story replaces. It must become an assertion that the
  quality prompt is per-file and that the spec prompt remains per-AC.
- `src/finish/review/prompts.gen.ts` — generated from the reference markdown by
  `scripts/generate-review-prompts.ts`. Regenerate it; do not hand-edit.
  `scripts/check-review-prompts-generated.ts` fails the build when it is stale.

**US-002**

- `test/unit/finish/review-audit-gaps.test.ts` — every one of its nine call sites
  invokes `auditGaps(report, dir)` with two arguments. This story changes that
  signature, so all of them must be updated to supply the review range and phase.
- `test/unit/operations/finish-review.test.ts` — its `finishReviewOp.verify()`
  block calls `verify` directly and asserts on the returned `gaps`. `verify` now
  consults git for the changed-file list, so those cases must stub the git seam
  and supply a `base`.

### Seams

- **US-001 → US-002 (data availability).** US-002's coverage comparison reads the
  **leading whitespace-delimited token** of each `report.walk` line and matches it
  as a repo-relative file path against `git diff --name-only`. US-001's contract
  must therefore produce a WALK line whose first token is a bare path with no
  `:symbol` suffix and no surrounding punctuation — `src/finish/review/prompt.ts —
  earns its place`, not `src/finish/review/prompt.ts:outputContract — …`. If
  US-001 ships a `path:symbol` shape, every file reads as unwalked and the gate
  fails every review. US-002 carries an acceptance criterion pinning this
  extraction against a line in exactly the shape US-001's contract asks for.
- **US-002 internal (wiring this story creates).** `auditGaps` is an existing
  export whose signature changes; its sole production caller is
  `finishReviewOp.verify` (`src/operations/finish-review.ts`). Today `auditGaps`
  consults only the filesystem and never invokes git, so the path
  `verify → auditGaps → gitWithTimeout → _gitDeps.spawn` **does not exist yet** —
  US-002 creates it. AC 10 asserts that path end to end, so it is a wiring
  criterion, not a check against a call chain already in place. It fails until
  the story builds the chain, which is the intended fail-first shape.

## Acceptance Criteria

### US-001 — Bound the quality reviewer's reply contract

1. `[unit]` Calling `buildReviewPrompt` with phase `"quality"` returns a prompt
   whose WALK instruction is per changed file: the returned prompt string
   includes the phrase `one line per file` and omits the phrase `one line per
   function`.
2. `[unit]` Calling `buildReviewPrompt` with phase `"spec"` returns a prompt
   whose WALK instruction is still per AC: the returned prompt string includes
   the phrase `one line per AC`.
3. `[unit]` Calling `buildReviewPrompt` with phase `"quality"` returns a prompt
   that still directs the reviewer to walk every changed function as its own
   private step — the returned prompt string includes the phrase `write
   yourself` — so the forcing function survives the contract change.
4. `[unit]` Calling `buildReviewPrompt` with phase `"quality"`, no `since`, and
   `specPath` set to `.nax/features/x/spec.md` returns a prompt string that
   omits the path `.nax/features/x/spec.md` entirely.
5. `[unit]` Calling `buildReviewPrompt` with phase `"quality"`, a `since` value
   and a non-empty `priorFindings` list, and `specPath` set to
   `.nax/features/x/spec.md`, returns a prompt string that omits the path
   `.nax/features/x/spec.md` entirely — the re-review branch omits it too.
6. `[unit]` Calling `buildReviewPrompt` with phase `"spec"` and `specPath` set to
   `.nax/features/x/spec.md` returns a prompt string that includes the path
   `.nax/features/x/spec.md`, in both the fresh-review and `since`-narrowed
   forms.
7. `[unit]` Calling `buildReviewPrompt` with phase `"quality"` returns a prompt
   that still requires all three reply sections: the returned prompt string
   includes the headings `## TOUCHPOINTS`, `## WALK` and `## FINDINGS`.

**Verification note — read this before implementing.** That `prompts.gen.ts`
matches the reference markdown is not an acceptance criterion; it is verified by
the repo's build/static gate `bun run lint`, which ends in `bun run
check:review-prompts` (`scripts/check-review-prompts-generated.ts`). CI reaches
it through `bun run check:all`, whose first step is `bun run lint`.

**However, that gate does not run during a `nax run`.** This repo's
`.nax/config.json` sets `quality.commands.lint` to `bun run lint:json`, which is
three checks (`biome`, `check:nax-error`, `check:logger-storyid`) and does **not**
include `check:review-prompts`. An implementer who edits
`references/code-quality.md` and forgets to run
`scripts/generate-review-prompts.ts` will therefore pass every gate it sees and
fail only later in CI.

AC 3 is the runtime backstop for exactly this: the phrase `write yourself` lives
in the generated `prompts.gen.ts`, so an un-regenerated reference edit fails that
test rather than escaping to CI. Do not weaken AC 3 to compensate for a stale
generated file — run the generator.

### US-002 — Gate the WALK against the diff's changed files

1. `[unit]` When the changed-file listing for the review range yields
   `src/a.ts` and `src/b.ts`, and the report's WALK names both, `auditGaps`
   returns no gap mentioning unwalked files.
2. `[unit]` When the changed-file listing yields `src/a.ts` and `src/b.ts` and
   the report's WALK names only `src/a.ts`, `auditGaps` returns a gap whose text
   names `src/b.ts`.
3. `[unit]` A WALK line of the form `src/a.ts — earns its place` counts as
   naming the changed file `src/a.ts`, so a report walking every changed file in
   that shape returns no unwalked-files gap.
4. `[unit]` Changed paths under a `.nax/` directory at any depth are excluded
   from the required set: when the listing yields `src/a.ts` and
   `packages/core/.nax/config.json` and the WALK names only `src/a.ts`,
   `auditGaps` returns no unwalked-files gap.
5. `[unit]` Changed paths that are lockfiles or generated output are excluded
   from the required set: when the listing yields `src/a.ts` and `bun.lock` and
   the WALK names only `src/a.ts`, `auditGaps` returns no unwalked-files gap.
6. `[unit]` When the changed-file listing fails — the git invocation exits
   non-zero — `auditGaps` returns no unwalked-files gap, and still returns the
   shape gaps its existing checks produce for a report with no `## TOUCHPOINTS`
   section.
7. `[unit]` When `auditGaps` is called for phase `"spec"`, it returns no
   unwalked-files gap even when the WALK names none of the changed files.
8. `[unit]` When a report cites four touchpoint paths of which one exists on
   disk, `auditGaps` returns the touchpoint gap; when three of the four exist,
   it returns no touchpoint gap.
9. `[unit]` A report whose `## WALK` section is absent or empty still yields the
   existing missing-WALK gap, unchanged by this story.
10. `[integration]` Stub the git seam `_gitDeps.spawn`; invoke
    `finishReviewOp.verify` with an input whose `base` is `origin/main` and whose
    phase is `"quality"`; assert the stubbed git invocation received an argument
    list containing `origin/main...HEAD`, proving `verify` passes the review's
    range through to the gate rather than defaulting it.

<!-- spec-writing: completed-through-phase-6 -->
