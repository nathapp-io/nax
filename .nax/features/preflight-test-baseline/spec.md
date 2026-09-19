# SPEC: Preflight Test Baseline (minimal version)

Design source: `docs/superpowers/specs/2026-09-19-preflight-test-baseline-design.md`
(approved + manually reviewed; four review findings already folded in).

## Summary

Give the harness a deterministic, per-story record of which tests were already failing
at the story's base ref — the **baseline** — and surface it to the implementation agent
in two small prompt surfaces: disposition labels on the failing-test lists the fix cycle
already renders, and one bounded upfront prompt section. The agent is never asked to
establish or report the baseline itself. Steady-state cost is zero extra suite runs:
only the run's first capture executes the suite; every later story's baseline is rolled
forward from the previous story's own full-suite-gate parse.

## Motivation

When `full-suite-gate` fails, the implementer cannot tell whether a failing test was
already red before the story started or was introduced by its own changes. It wastes
rectification iterations chasing failures it did not cause, or "fixes" them by editing
unrelated code. The agent-report alternative already exists for lint/typecheck
(`PRE_EXISTING_FAILURES` in the self-verification marker, issue #928) and decayed to
inert: it fails open on a missing marker, was never wired to the three-session path, and
nothing downstream can verify or consume the claim. A deterministic harness-side capture
is also cheaper: agent-run capture puts raw suite output into the transcript where it is
re-carried every turn, and the knowledge dies at the session boundary, so every
escalation or fallback swap would re-run the suite.

## Design

### Baseline model

A story's baseline is the set of failing tests at the story's base ref.

- **Immutable within a story.** Anything that changes after story start — including
  mechanical lint/format fixes the harness runs on the story's behalf — is attributable
  to the story. No mid-story re-capture.
- **Keyed by story and base ref**, never by tier or agent: escalation and fallback swaps
  inherit the baseline because each new session's prompt is rebuilt from the persisted
  artifact.
- **Distinct concept from `resolveFlakeBaselineDiff`**
  (`src/verification/flake-baseline-diff.ts`), which is a git-diff of changed test
  files. This artifact is a red/green snapshot; the two must not share a name.

### New module

`src/verification/test-baseline.ts`, exported from the `src/verification` barrel:

```ts
export type BaselineDisposition = "introduced" | "pre-existing" | "earlier-story" | "unattributed";

export type TestBaseline =
  | {
      kind: "captured";
      baseRef?: string;            // git HEAD at capture; absent when not a git repo
      capturedAt: string;          // ISO timestamp
      source: "preflight" | "roll-forward";
      entries: BaselineEntry[];    // empty array = baseline green
    }
  | {
      kind: "no-baseline";
      reason: "gate-disabled" | "no-test-command" | "timeout" | "unparseable" | "error" | "no-gate-parse";
      capturedAt: string;
    };

export interface BaselineEntry {
  file: string;
  testName?: string;               // absent = file-level fallback entry
}
```

Functions (all exported): `writeRunBaseline`, `readRunBaseline`, `writeStoryBaseline`,
`readStoryBaseline`, `resolveStoryBaseline(root, featureId, storyId, executionMode)` —
the one read path consumers use: returns the story artifact in sequential modes and
the run-start baseline in parallel mode — and
`applyBaselineDispositions(findings, storyBaseline, runBaseline)`.
Artifact paths are built with the `featureDir()` helpers from `@/config`
(`scripts/check-feature-dir-ssot.ts` forbids open-coding them): the run-start baseline
at the feature root, per-story roll-forward baselines under the feature's `stories/`
tree. `readStoryBaseline`/`readRunBaseline` return `undefined` for a missing or
unparseable artifact; classification treats `undefined` like a `no-baseline` marker.

Classification rules for `applyBaselineDispositions` (returns new `Finding` objects
with `baselineDisposition` set; never mutates input, never drops a finding):

- Story baseline entry matches on `(file, testName)` when the entry has a `testName`;
  an entry without `testName` matches any finding in that file (file-level fallback).
- Match against the story baseline → `pre-existing`.
- No match, and the finding IS matched by the story baseline's roll-forward content
  while absent from the run baseline → `earlier-story` (this arm requires both a
  captured story baseline with `source: "roll-forward"` and a captured run baseline;
  otherwise it cannot fire).
- No match at all against a captured story baseline → `introduced`.
- Story baseline is a `no-baseline` marker or `undefined` → `unattributed`.

### Integration

Read-only integration points (verified on `feat/preflight-test-baseline` after the
rebase onto the parser fix, PR #2143):

- `parseTestOutput(output): TestSummary` — `src/test-runners/parser.ts:31`; the SSOT
  parser. `TestSummary.failures: TestFailure[]` with `file`, `testName`, `error`,
  `stackTrace?`.
- `resolveQualityTestCommands(...)` — `src/quality/command-resolver.ts:65`; resolves the
  suite command the gate itself uses.
- `captureGitRef(workdir)` — `src/utils/git.ts:143`; yields the base ref.
- `testSummaryToFindings(summary)` — `src/findings/adapters/test-failure.ts:38`;
  unchanged. Dispositions are attached after it, at the gate.
- `ReviewCheckResult.findings?: Finding[]` — `src/review/types.ts`; the reason one
  disposition field serves both format sites.
- `runExecutionPhase` — `src/execution/runner-execution.ts` (invoked from
  `src/execution/runner.ts:272`); the run-start capture hooks here, before the story
  loop. It must NOT live in precheck: `runPrecheckValidation`
  (`src/execution/lifecycle/precheck-runner.ts`) is opt-in behind `NAX_PRECHECK=1`.

Mutated symbols (baseline listed only to locate the code; implement the target):

- `Finding` — `src/findings/types.ts:88`.
  - Baseline: no baseline-related field.
  - Target: adds optional `baselineDisposition?: BaselineDisposition`. All existing
    producers omit it; absence means "not classified".
- `formatFailingTestsList(findings: Finding[]): string` —
  `src/prompts/builders/rectifier-builder-helpers.ts:389`.
  - Baseline: renders `- <file> / Test: <rule> / Error: <message>` bullets.
  - Target: same signature; when a finding carries `baselineDisposition`, its bullet
    additionally renders a bracketed disposition tag; findings without the field render
    byte-identically to today.
- `renderPrioritizedFailures(failedChecks, opts?)` —
  `src/prompts/builders/rectifier-builder.ts:158` (internal to the builder).
  - Baseline: renders check findings without disposition awareness.
  - Target: renders the same bracketed tag for findings carrying the field.
- `fullSuiteGateOp` failure path — `src/operations/full-suite-gate.ts:306`.
  - Baseline: `const findings = testSummaryToFindings(testResult.parsedSummary)`.
  - Target: after adapting, passes findings through `applyBaselineDispositions` with
    the story and run baselines resolved for the current story.
- `TddPromptBuilder` — `src/prompts/builders/tdd-builder.ts`.
  - Baseline: no baseline-aware section; `.selfVerification(input)` is the precedent
    for an optional chainable section input.
  - Target: gains `.testBaseline(baseline: TestBaseline | undefined)`; `build()`
    renders one bounded baseline section when set (see Prompt section below). Callers
    that assemble implementer/test-writer prompts resolve the story's baseline artifact
    and pass it through.
- `post-run` story-completion path — `src/execution/post-run.ts` (near the existing
  `fullSuiteGateFailingFiles` snapshot at line ~178).
  - Baseline: snapshots failing files only, for deferred-regression blame.
  - Target: additionally persists the story's final gate `parsedSummary` as the NEXT
    story's baseline (`source: "roll-forward"`), via an injectable dep with a default
    so existing `_postRunDeps` construction sites do not break.

### Capture and roll-forward

Run start: a capture step at the top of `runExecutionPhase`, before the first story.
It resolves the suite command via `resolveQualityTestCommands`, runs it once with the
gate's timeout (`execution.regressionGate.timeoutSeconds`, falling back to
`execution.rectification.fullSuiteTimeoutSeconds`, else the schema default), parses
with `parseTestOutput`, records `captureGitRef` as `baseRef`, and persists the
run-start baseline. The capture never blocks or fails the run.

Roll-forward: on story completion, the story's final full-suite-gate parse is persisted
as the next story's baseline. Roll-forward applies only to sequential execution
(shared isolation and sequential worktree isolation, where each story branches after
the previous merge). In parallel execution (`src/execution/parallel.ts` — concurrent
worktrees, no total order) roll-forward is skipped and every story's baseline resolves
to the run-start baseline; the `earlier-story` disposition therefore never fires in
parallel mode. The run-start artifact is retained for the whole run and never
overwritten by roll-forward writes.

### Prompt section

One bounded section rendered by `TddPromptBuilder.build()` when `.testBaseline()` was
given a value. Content, one of:

- captured, failing: base ref, failure count, the failing files (test names omitted);
- captured, green: "baseline green at `<ref>`" plus the statement that any full-suite
  failure is introduced by this story;
- `no-baseline` marker: "no baseline available" with the reason.

Always followed by one directive line: the baseline is authoritative; do not re-run the
full suite to re-derive it. The section is truncated at a character cap (module
constant, ADR-022 `MAX_BLOCK_CHARS` precedent): past the cap it renders the count, the
first files that fit, and "and N more". The existing implementer prose in
`role-task.ts` telling the agent to run its scoped test files stays untouched — scoped
red/green iteration is a different job from full-suite attribution.

### Failure Handling

| Condition | Behaviour |
|:---|:---|
| `execution.regressionGate.enabled: false` | No suite spawn; persist `no-baseline` reason `gate-disabled`. |
| No test command resolvable | No spawn; `no-baseline` reason `no-test-command`. |
| Suite run exceeds the resolved timeout | `no-baseline` reason `timeout`. |
| Non-zero exit with zero structured failures parsed | `no-baseline` reason `unparseable`. |
| Runner throws | Caught; `no-baseline` reason `error`; capture resolves normally. |
| Story ends with no usable gate parse (sequential) | Next story gets `no-baseline` reason `no-gate-parse`. |
| Baseline artifact missing or unreadable at classification/prompt time | Treated as no baseline: dispositions `unattributed`; no upfront section is rendered (a persisted `no-baseline` marker, by contrast, renders the section with its reason). |
| Parallel execution mode | Roll-forward skipped; story baseline = run-start baseline. |

In every degraded case the run proceeds; the feature fails open to "no attribution",
never to a blocked run.

### File-size constraints (the 600-line gate)

`bun run check:file-sizes` blocks growth of grandfathered files and caps new growth at
600 lines. Two touched files are at or near the limit:

- `src/prompts/builders/rectifier-builder.ts` is **903 lines (grandfathered — may not
  grow at all)**. US-003's tag rendering for `renderPrioritizedFailures` must not add
  net lines there: put the tag-formatting helper in
  `rectifier-builder-helpers.ts` (566/600) or the new baseline module, and keep the
  edit inside `rectifier-builder.ts` to same-line changes.
- `src/execution/post-run.ts` is at **596/600**. US-002's roll-forward hook must be a
  single delegated call into `test-baseline-capture.ts`; if that still breaches the
  cap, extract an existing self-contained block from `post-run.ts` into a sibling
  module first.

## Out of Scope

- Gating the `repo-scoped-test-fix` escape hatch on membership in the pre-existing set
  — deferred until run artifacts show the role being invoked for story-introduced
  failures.
- Retiring or validating the self-verification `PRE_EXISTING_FAILURES` lint/typecheck
  self-report against a captured baseline — a different tool axis; separate cleanup.
- Size-adaptive lazy artifact read — naming the artifact path in the prompt so the
  agent can read the full snapshot past the character cap on demand.
- Surfacing the baseline through the session-scratch context channel in addition to the
  fixed prompt section.
- Per-package baseline partitioning for monorepo target repos — v1 captures one
  baseline via the workdir-resolved suite command only.
- Locking or reconciling baseline artifacts across concurrent nax runs sharing one
  feature directory — a feature directory is owned by one run.
- Mid-story baseline re-capture — the baseline is immutable within a story by design.
- US-002 only: a post-merge re-capture for parallel dependency groups — parallel-mode
  stories use the run-start baseline even when their dependencies merged first.

## Stories

### US-001 — Baseline model, artifact persistence, classification

The `TestBaseline` types, read/write functions over the feature tree, the
`baselineDisposition` field on `Finding`, and `applyBaselineDispositions`.
No dependencies.

- New module `src/verification/test-baseline.ts`, exported from the barrel.
- `Finding` gains the optional `baselineDisposition` field.
- Pure logic plus artifact IO; no lifecycle wiring in this story.

### US-002 — Run-start capture and roll-forward persistence

The deterministic capture step in `runExecutionPhase` and the story-completion
roll-forward write in post-run, with every degradation row from Failure Handling.
Depends on: US-001.

- Capture resolves the suite command, runs once with the gate timeout, parses, persists.
- Roll-forward persists the story's final gate parse for the next story
  (sequential modes only); parallel mode resolves every story to the run-start
  baseline.
- Injectable deps with defaults so existing construction sites keep compiling.

### US-003 — Disposition labels at the gate and both format sites

Attach dispositions where gate findings are produced; render the bracketed tags at
`formatFailingTestsList` and `renderPrioritizedFailures`; labels never filter.
Depends on: US-001, US-002.

### US-004 — Upfront baseline prompt section

The `.testBaseline()` builder input, the bounded section with its three content
states, the authoritative-directive line, the character cap, and the plumbing from
the persisted artifact to the builder call sites.
Depends on: US-001.

### Context Files

**US-001**
- `src/findings/types.ts` — `Finding` interface to extend
- `src/config/paths.ts` — `featureDir()` helpers for artifact paths
- `src/verification/flake-baseline-diff.ts` — the neighbouring, distinct baseline concept; naming must not collide
- `src/test-runners/types.ts` — `TestSummary` / `TestFailure` shapes entries derive from

**US-002**
- `src/execution/runner-execution.ts` — capture hook site
- `src/execution/post-run.ts` — roll-forward write site (near the `fullSuiteGateFailingFiles` snapshot)
- `src/quality/command-resolver.ts` — `resolveQualityTestCommands`
- `src/test-runners/parser.ts` — `parseTestOutput`
- `src/verification/test-baseline.ts` — created by US-001, consumed here

**US-003**
- `src/operations/full-suite-gate.ts` — the attach point on the failure path
- `src/prompts/builders/rectifier-builder-helpers.ts` — `formatFailingTestsList`
- `src/prompts/builders/rectifier-builder.ts` — `renderPrioritizedFailures`
- `src/verification/test-baseline.ts` — created by US-001, consumed here

**US-004**
- `src/prompts/builders/tdd-builder.ts` — builder to extend (`.selfVerification()` is the pattern)
- `src/prompts/sections/index.ts` — section export barrel
- `src/execution/plan-inputs.ts` — a `buildForRole` call site to thread the baseline through
- `src/verification/test-baseline.ts` — created by US-001, consumed here

### Creates

**US-001**
- `src/verification/test-baseline.ts`
- `test/unit/verification/test-baseline.test.ts`

**US-002**
- `src/execution/lifecycle/test-baseline-capture.ts`
- `test/unit/execution/lifecycle/test-baseline-capture.test.ts`

**US-003**
- `test/unit/prompts/builders/rectifier-baseline-labels.test.ts`

**US-004**
- `src/prompts/sections/test-baseline.ts`
- `test/unit/prompts/sections/test-baseline.test.ts`

### Modifies

None. Every change is additive behind optional fields, optional builder inputs, or
injectable deps with defaults: the `Finding` field is optional; findings without
`baselineDisposition` render byte-identically to today, so the existing
`formatFailingTestsList` assertions (including those added by PR #2143) keep passing;
existing `_postRunDeps` construction sites and builder tests that never call
`.testBaseline()` compile and pass unchanged.

### Seams

- US-001 → US-002: `writeRunBaseline` / `writeStoryBaseline` are the persistence
  contract; US-002's capture and roll-forward assert through them (stubbed) that the
  right artifact kind, source, and entries are written.
- US-001 → US-003: `applyBaselineDispositions` is invoked on the full-suite-gate
  failure path; US-003 carries the seam AC asserting the gate calls it and emits
  labeled findings.
- US-001 → US-004: `readStoryBaseline` feeds the prompt plumbing; US-004 carries the
  seam AC asserting a seeded on-disk artifact surfaces in the built implementer
  prompt.
- Data availability: the prompt section consumes only fields the `TestBaseline`
  contract declares (`baseRef`, entry count, entry `file` values, marker `reason`) —
  no field is rendered that the producer does not persist.

## Acceptance Criteria

### US-001

- [unit] Writing a captured baseline (`source: "preflight"`, two entries) for a
  feature via `writeRunBaseline` and reading it back with `readRunBaseline` from the
  same root and feature id returns an equal value.
- [unit] `writeStoryBaseline` then `readStoryBaseline` round-trips a
  `source: "roll-forward"` baseline keyed by story id; a different story id reads back
  `undefined`.
- [unit] `readRunBaseline` and `readStoryBaseline` return `undefined` when no artifact
  exists, and `undefined` when the artifact file contains invalid JSON — neither case
  throws.
- [unit] `applyBaselineDispositions` marks a finding `pre-existing` when the story
  baseline contains an entry with the same `file` and `testName` as the finding's
  `file` and `rule`.
- [unit] `applyBaselineDispositions` marks a finding `introduced` when the story
  baseline is captured but contains no matching entry.
- [unit] File-level fallback: an entry with a `file` and no `testName` matches any
  finding in that file, yielding `pre-existing`.
- [unit] No cross-file fallback: an entry carrying a `testName` does not match a
  finding in the same file with a different `rule` — that finding is `introduced`.
- [unit] `earlier-story`: a finding absent from the run baseline's entries but matched
  by a `source: "roll-forward"` story baseline is marked `earlier-story`; the same
  finding is `pre-existing` when the run baseline also matches it.
- [unit] A story baseline that is a `no-baseline` marker, or `undefined`, yields
  `unattributed` for every finding.
- [unit] A captured story baseline with zero entries (green) yields `introduced` for
  every finding.
- [unit] `applyBaselineDispositions` returns new finding objects with every original
  field preserved, does not mutate its input array or elements, and returns exactly
  one output finding per input finding.
- [unit] Importing `TestBaseline`, `BaselineEntry`, `BaselineDisposition`, and the six
  functions (including `resolveStoryBaseline`) from the `src/verification` barrel
  succeeds and each function is callable.

### US-002

- [unit] With a stubbed command runner returning failing suite output and a stubbed
  `captureGitRef` returning a ref, the capture step persists a run baseline with
  `kind: "captured"`, `source: "preflight"`, `baseRef` equal to the stubbed ref, and
  one entry per parsed failure carrying that failure's `file` and `testName`.
- [unit] The capture step executes the command string resolved by the quality command
  resolver — the stubbed runner receives that exact command.
- [unit] With `execution.regressionGate.timeoutSeconds` set, the stubbed runner
  receives that timeout; with it unset and
  `execution.rectification.fullSuiteTimeoutSeconds` set, it receives the fallback.
- [unit] A green suite (exit 0, zero parsed failures) persists a captured baseline
  with an empty `entries` array — not a `no-baseline` marker.
- [unit] With `execution.regressionGate.enabled: false`, the runner stub is never
  invoked and the persisted artifact is a `no-baseline` marker with reason
  `gate-disabled`.
- [unit] With no resolvable test command, the runner stub is never invoked and the
  marker reason is `no-test-command`.
- [unit] A runner result flagged as timed out persists reason `timeout`.
- [unit] A non-zero exit whose output parses to zero structured failures persists
  reason `unparseable`.
- [unit] A runner stub that throws is caught: the capture step resolves without
  rejecting and persists reason `error`.
- [integration] Seam: driving `runExecutionPhase` with a stubbed capture module and a
  minimal single-story PRD invokes the capture exactly once, before the first story's
  pipeline dispatch, with the run's config and workdir.
- [integration] Seam: driving the post-run story-completion path with a pipeline
  result whose full-suite-gate phase output carries a parsed summary invokes the
  stubbed roll-forward writer with that summary's failures targeted at the next story
  id, `source: "roll-forward"`.
- [unit] A story completing with no usable gate parse writes the next story's baseline
  as a `no-baseline` marker with reason `no-gate-parse`.
- [unit] In parallel execution mode the roll-forward writer is not invoked, and
  `resolveStoryBaseline` returns the run-start baseline instead of a story artifact.
- [unit] Roll-forward writes for successive stories never overwrite the run-start
  artifact: after two story writes, `readRunBaseline` still returns the original
  `source: "preflight"` value.
- [unit] Every degraded capture outcome (`gate-disabled`, `no-test-command`,
  `timeout`, `unparseable`, `error`) resolves normally — the capture step never
  rejects, so the run proceeds.

### US-003

- [integration] Seam: executing the full-suite-gate operation's failure path with a
  seeded story baseline artifact on disk and a stubbed test run whose parsed failures
  include one baseline-matched and one unmatched failure emits findings carrying
  `baselineDisposition` values `pre-existing` and `introduced` respectively.
- [unit] `formatFailingTestsList` renders a bracketed disposition tag on each bullet
  whose finding carries `baselineDisposition`, with distinct wordings for
  `introduced`, `pre-existing`, `earlier-story`, and `unattributed`.
- [unit] `formatFailingTestsList` output for findings without `baselineDisposition` is
  byte-identical to the output before this change (existing fixture reused).
- [unit] `renderPrioritizedFailures` renders the same bracketed tags for check
  findings carrying `baselineDisposition`, via the rectifier prompt that embeds it.
- [unit] Labels never filter: given five findings with mixed dispositions,
  `formatFailingTestsList` renders five bullets and its count line says five.
- [unit] The gate's failure output after labeling contains the same number of findings
  as before labeling — `pre-existing` findings are not dropped.

### US-004

- [unit] `TddPromptBuilder.for("implementer").testBaseline(<captured, 2 entries>)`
  produces a prompt containing a baseline section with the base ref, the failure
  count, and each failing file.
- [unit] A green captured baseline renders the section stating the baseline is green
  at the ref and that any full-suite failure is introduced by this story.
- [unit] A `no-baseline` marker renders the section stating no baseline is available,
  including the marker's reason.
- [unit] `build()` without `.testBaseline()` (or with `undefined`) produces a prompt
  with no baseline section, identical to today's output.
- [unit] The section always contains the directive that the baseline is authoritative
  and the full suite must not be re-run to re-derive it.
- [unit] A captured baseline with enough failing files to exceed the section's
  character cap renders within the cap: the count, the leading files that fit, and an
  "and N more" tail.
- [integration] Seam: assembling the implementer-phase prompt through the production
  `buildForRole` path with a seeded story baseline artifact on disk yields a prompt
  containing the baseline section — proving the artifact-to-builder plumbing, not just
  the section renderer.

<!-- spec-writing: completed-through-phase-6 -->
