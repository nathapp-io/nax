# Preflight test baseline — minimal version

Design only. Status: **design approved, not yet implemented.**

This is the **minimal version** of a larger arc. §7 records the deferred full-version
increments and the telemetry trigger for each, so a fresh session can continue the arc
without re-deriving it. Do not implement anything in §7 against this spec.

**Prerequisite:** the Bun test-failure parser direction fix (in flight on a separate
worktree as of 2026-09-19). Test-level identity (§4.2) keys on parser output; attribution
on top of mis-framed failures would label the wrong tests. File-level fallback works
without it, but the fix should land first.

## 1. Goal

When `full-suite-gate` fails, the implementer (or fix-cycle session) currently cannot
tell whether a failing test was already red before the story started or was introduced
by its own changes. It wastes rectification iterations chasing failures it did not
cause, or "fixes" them by editing unrelated code.

This spec gives the harness a deterministic, per-story record of which tests were
failing at the story's base ref — the **baseline** — and surfaces it to the agent in two
small prompt surfaces. The agent is never asked to establish or report the baseline
itself.

Why deterministic rather than agent-run: the agent-report design already exists for
lint/typecheck (`PRE_EXISTING_FAILURES` in the self-verification marker, issue #928) and
decayed to inert — it fails open on a missing marker, was never wired to the
three-session path, and nothing downstream can verify or consume the claim. A test-suite
version would inherit all three defects. Additionally, agent-run capture puts raw suite
output into the transcript where it is re-carried every subsequent turn, and the
knowledge dies at the session boundary — every rectification re-entry, tier escalation,
or fallback swap would have to re-run the suite.

## 2. Baseline model

A story's baseline is **the set of failing tests at the story's base ref** — the commit
the story starts from.

- **Immutable within a story.** Anything that changes after story start is attributable
  to the story, including mechanical lint/format fixes the harness runs on the story's
  behalf. No mid-story re-capture, ever.
- **Keyed `(storyId, baseRef)`** — never `storyId::tier::agent`. The baseline is a
  property of the tree, not of the agent. Tier escalation and fallback swaps inherit it
  with no additional wiring because each new session's prompt is rebuilt from the
  persisted artifact.
- **Distinct concept from `flake-baseline-diff`** (`src/verification/flake-baseline-diff.ts`),
  which is a git-diff of *test files changed* since merge-base. The two must not share a
  name; this artifact is a red/green snapshot.

## 3. Capture — two sites, one new suite run per nax run

### 3.1 Run start (new)

A new deterministic operation (same kind as `greenfield-gate` / `full-suite-gate`: no
LLM session) runs once before the first story:

- Resolves the test command via `resolveQualityTestCommands()` — the same resolver the
  gate uses, per-package aware.
- Runs it once, parses with `parseTestOutput()` (the SSOT parser), persists the failing
  set per §4.
- Timeout: the gate's own config (`execution.regressionGate.timeoutSeconds`, fallback
  `execution.rectification.fullSuiteTimeoutSeconds`). On timeout, non-zero-exit with an
  unparseable output, or a missing test command, it persists an explicit `no-baseline`
  marker with the reason and the run continues. The preflight never blocks a run.
- `execution.regressionGate.enabled: false` disables the gate entirely (issue #1116,
  `full-suite-gate.ts`) — a user who turned it off opted out of harness-driven suite
  runs. The preflight short-circuits under the same flag and persists the
  `no-baseline` marker with reason `gate-disabled`. (Downstream stays consistent: with
  the gate off there are no gate failures to label.)

### 3.2 Roll-forward (reuse, no new runs)

For story N ≥ 2, the baseline is **story N−1's final `full-suite-gate` parse**. The gate
already runs and parses the suite per story; `post-run.ts` already snapshots
`fullSuiteGateFailingFiles` from the same output for deferred-regression blame. This
spec persists the full parsed failure set (not just files) at story-success time as the
next story's baseline. Steady-state cost: zero extra suite runs.

If a story completes without a usable gate parse (gate skipped, degraded parse), the
next story gets the `no-baseline` marker rather than a stale or guessed baseline.

### 3.3 Execution modes — roll-forward is sequential-only

Roll-forward assumes a total order of stories. That holds for sequential execution
(shared isolation, and `storyIsolation: "worktree"`, where each story branches from
main HEAD after the previous story's merge). It does **not** hold for parallel
execution (`src/execution/parallel.ts`): stories run in concurrent git worktrees,
grouped by dependencies and merged in dependency order — "the previous story" is
undefined.

In parallel mode, a story's baseline is **the capture at its worktree's branch
point**: the run-start preflight baseline for stories branching from the run's base,
or — when a dependency group's worktree is created after its dependencies merged — a
capture at that post-merge ref if one is available, else the run-start baseline. No
roll-forward between siblings. The *caused by an earlier story in this run* label
(§5.1) is sequential-only; in parallel mode a failure introduced by a sibling story's
merge is labeled **unattributed** rather than misattributed.

## 4. Persistence

### 4.1 Location

One JSON artifact per story under the feature tree, written via the `featureDir()` path
helpers (`src/config/paths.ts` — open-coding `.nax/features/...` is gated). Lives with
`stories/` artifacts; wiped/replaced per run like other run-scoped story state.

### 4.2 Identity

Each entry is `(file, testName?)`:

- **Test-level** when the parser yields a test name — the precise match.
- **File-level fallback** when it does not (generic-regex frameworks): the entry carries
  only `file`, and any gate failure in that file matches it. This is deliberately
  coarse; a new failure in a file that already had a pre-existing one will be labeled
  pre-existing at file granularity. Accepted for the minimal version.

The artifact also records `baseRef`, capture timestamp, the source (`preflight` |
`roll-forward`), and — for the `no-baseline` case — the reason.

## 5. Consumption — two prompt surfaces

### 5.1 Labels at the format sites

Where gate failures are already rendered into the fix-cycle prompt —
`formatFailingTestsList` (`src/prompts/builders/rectifier-builder-helpers.ts`) and
`renderPrioritizedFailures` (`RectifierPromptBuilder.firstAttemptDelta`) — each failure
is tagged with exactly one label by diffing against the baseline:

- **introduced by your changes** — not in the baseline.
- **pre-existing at baseRef** — in the story's own baseline.
- **caused by an earlier story in this run** — sequential mode, story ≥ 2 only:
  absent from the run's first baseline but present in this story's rolled-forward
  baseline (§3.3: never emitted in parallel mode).
- **unattributed** — the baseline is the `no-baseline` marker.

Labels only, never filtering. A pre-existing failure an acceptance criterion requires
fixing must stay visible.

Implementation constraint: the two sites take different types —
`formatFailingTestsList` takes `Finding[]`, `renderPrioritizedFailures` takes
`ReviewCheckResult[]`. The baseline diff is computed once, upstream of both (attach
the label where findings/check results are produced), with each site rendering the
already-attached label. Do not unify the two types to share a signature.

The *earlier story* label compares this story's rolled-forward baseline against the
**run's first baseline**, so the run-start (`source: preflight`) artifact must be
retained for the whole run — roll-forward writes a new per-story artifact and never
overwrites it.

### 5.2 Upfront section

One bounded section added in `TddPromptBuilder.build()` — the shared SSOT, so the
three-session and single-session families both get it with one edit. Content, one of:

- baseline ref + failure count + the failing files (test names omitted here), or
- "baseline green at `<ref>`" — itself signal: any gate failure is the story's, or
- "no baseline available (`<reason>`)".

Plus one instruction line: the baseline above is authoritative; do not re-run the full
suite to re-derive it. Truncated at a character cap (precedent: ADR-022
`MAX_BLOCK_CHARS` in `prior-iterations-builder.ts`); past the cap, count + first N files
+ "and M more".

The existing implementer prose in `role-task.ts` telling the agent to run its **scoped**
test files once stays untouched — that serves red/green iteration on the story's own
tests, a different job from full-suite attribution.

## 6. Testing

Unit:

- Diff/labeling: test-level match, file-level fallback, all four labels, green baseline,
  `no-baseline` marker.
- Capture op degradation: timeout → `no-baseline` with reason; missing command; parse
  yielding zero structured failures on non-zero exit.
- Upfront section: green / small / truncated-at-cap / no-baseline renderings.

Integration:

- Story 2's baseline equals story 1's final gate parse (roll-forward).
- Labels render at both format sites from a seeded baseline artifact.
- A run with the preflight timing out completes with `unattributed` labels.

## 7. Out of scope — the full-version roadmap

Named increments, deliberately deferred. Each lists its adoption trigger. `nax plan`
must not synthesize stories for any of these.

1. **`repo-scoped-test-fix` gating** — restrict the escape-hatch session role to
   failures present in the pre-existing set. Adopt if run artifacts show the role being
   invoked for story-introduced failures.
2. **`PRE_EXISTING_FAILURES` retirement/validation** — capture lint/typecheck baselines
   the same way and validate (or retire) the self-reported marker field, which is
   currently inert (only rendered as a count in session scratch). Different tool axis;
   separate cleanup.
3. **Size-adaptive lazy artifact read** — above the cap, name the artifact path in the
   prompt and let the agent read the full snapshot on demand. Adopt if truncation is
   observed to hide failures the agent then mishandles.
4. **Session-scratch injection channel** — additionally surface the baseline as a
   budget-participating scratch chunk. Adopt only if the fixed upfront section proves
   too costly on rule-heavy repos.

Success measure for the minimal version (and the gate for investing further):
fix-cycle iterations spent on failures labeled pre-existing, before vs. after, from the
run cost ledger and cycle iteration logs.
