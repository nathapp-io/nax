# Design: Flaky-Test Detection & Quarantine

**Date:** 2026-07-04
**Status:** Design approved (brainstorm), not yet planned/implemented
**Target:** nax verification pipeline (full-suite gate + regression gate)

## Problem

A flaky pre-existing test in the target repo currently burns real money and time:
nax attributes the intermittent failure to the agent's change, dispatches
rectification fix cycles, escalates model tiers, and can fail the regression gate
— all for a failure the story did not cause. There is no re-run-the-failing-test
logic anywhere in the codebase today; every existing re-run (rectification loop,
regression gate, acceptance loop) re-runs a whole scope after an attempted edit,
never "run this same failing test again unchanged to see if it flips."

## Decisions (brainstorm outcomes)

| Dimension | Decision |
|---|---|
| Scope | **Pre-existing repo tests only.** Agent-written tests stay strict — flakiness there is a quality bug the reviewer must catch. |
| Detection | **Re-run + baseline check.** Both signals must agree: (1) the failed test passes at least once when re-run in isolation; (2) the story's diff touched neither the test file nor the source it maps to. |
| Stages | **Per-story full-suite gate + end-of-run regression gate.** Not scoped verify, not acceptance (those target the changed code; failures there are usually genuine). |
| Quarantine semantics | **Run-scoped ignore + report.** For the remainder of the run the test's failures do not block gates; every decision is logged, surfaced in TUI/run summary, written to the run JSONL. Nothing persisted across runs. |
| Architecture | **Approach B: flake-triage step between findings extraction and the fix cycle** (classification, not fixing). Verification layer and FixCycle machinery unchanged. |

## Architecture

Two new modules, two touched integration points.

### New: `src/verification/flake-probe.ts` — the re-run mechanic

Given a `TestFailure { file, testName }` (existing type, `src/test-runners/types.ts`)
and the detected framework, builds a "run just this test" command and executes it
up to N times via the existing `executeWithTimeout()`:

| Framework | Filter command shape |
|---|---|
| bun | `bun test <file> -t <name>` |
| jest / vitest | `<runner> <file> -t <name>` |
| pytest | `pytest <file>::<name>` |
| go | `go test -run '^<name>$' <pkg>` |

Test names must be escaped for `-t` / `-run` regex metacharacters.

Returns one of:
- `flaky` — passed at least once across probes
- `consistent-failure` — failed every probe
- `unprobeable` — `file === "unknown"` (known Bun/Go parse caveat), framework
  resolved via the generic `parseCommonOutput` fallback, or no filter command can
  be built. **Unprobeable always stays blocking — fail closed.**

### New: `src/verification/flake-triage.ts` — the classifier (sole decision-maker)

Input: `failed-test` findings (`source: "test-runner"`) plus story context.
Per finding:

1. **Baseline check first (cheap):** test is pre-existing and untouched — the
   test file is not in the story's git diff, and is not mapped from changed
   sources via the smart-runner helpers (`mapSourceToTests`, import-grep
   fallback). If the diff touched the test or its covered code → skip probing,
   finding stays blocking.
2. **Probe (expensive):** only baseline-passing candidates are re-run in
   isolation.
3. **Relabel:** flake-confirmed findings get `category: "flaky-test"` plus
   `meta: { probeRuns, probePasses }`. Everything else keeps
   `category: "failed-test"`. (`Finding.category` is an open vocabulary by
   design — no schema change.)

Triage keeps a run-scoped in-memory set of quarantined keys
(`${file}::${testName}`, matching the existing `gateFailureKeys()` convention)
so the regression gate does not re-pay probe cost for a test already judged
flaky earlier in the run.

### Touched: story-orchestrator rectification (`src/execution/story-orchestrator/rectification.ts`)

- Triage runs on full-suite-gate findings **before** `gatherRectificationFindings()`
  hands them to the fix cycle.
- Existing fix strategies' `appliesTo` (`category === "failed-test"`) no longer
  match relabeled findings → no agent dispatched for flakes.
- If **all** gate failures are flaky → gate treated as passed-with-warnings.
- `gateFailureKeys()` and `describeGateRegression()` (phase-eval) skip
  `flaky-test` findings so a flake flipping state mid-story does not read as a
  rectification regression. #1383 extended this: `describeGateRegression` also
  excludes keys in its effective quarantine memo. #1404 adds read-only NBF triage:
  first-observation verdicts enter a transaction-local overlay because the raw gate
  output deliberately never carries the `flaky-test` category itself.

### Touched: regression gate (`src/execution/lifecycle/run-regression.ts`)

- Same triage before `buildRegressionFindings()` / story attribution.
- Flaky failures excluded from `findResponsibleStoryByTransition()` attribution
  and from the fix cycle.
- A regression gate whose only failures are flaky returns success-with-warnings.

### Visibility (run-scoped)

Every quarantine decision emits a structured log line + a pipeline-bus event —
landing in the existing review-warning aggregation, the TUI, and the run
report/JSONL. No cross-run persistence.

#### Skip telemetry (#1657)

Every path where triage is *skipped* — so a flake and a deterministic failure
are indistinguishable to the `repo-scoped-test-fix` fallthrough (#1656) —
emits one `flake.triage.skipped` event via `logFlakeTriageSkip`
(`src/verification/flake-triage-telemetry.ts`):

| `reason` | Emitted from | `candidateBasis` |
|:---|:---|:---|
| `max-probes-per-gate` | `triageFlakyFindings` | `probe-eligible` (exact) |
| `framework-undetected` | `productionTriageSeam`, `runRegressionFlakeTriage` | `gate-findings` (upper bound) |
| `no-test-command` | `productionTriageSeam` | `gate-findings` |
| `baseline-diff-unresolved` | `productionTriageSeam`, `runRegressionFlakeTriage` | `gate-findings` |
| `context-error` | `productionTriageSeam` | `gate-findings` |

`gate-findings` is the raw finding set handed to the seam — unnarrowed by the
baseline diff and unfiltered by category — so it is an upper bound, never a
probe count. Only `probe-eligible` is exact.

`flakeDetection.enabled: false` emits nothing — an operator opt-out is not a
gap in a feature believed to be on.

**`scope` is the field that decides #1657 §3.** Every row carries one of:

| `scope` | Cycle | Can dispatch `repo-scoped-test-fix`? |
|:---|:---|:---|
| `blocking-gate` | `triageGateFindings`, once per rectification entry | **Yes** — the only one |
| `nbf` | `triageNbfGate`, per phase per `runRectify` attempt | No — not registered on that cycle |
| `regression` | `runRegressionFlakeTriage`, the run-scoped deferred gate | No |

`makeRepoScopedTestFixStrategy` is registered on the blocking cycle only
(`src/execution/build-plan-for-strategy.ts`). Counting `nbf` rows — which the
per-attempt revalidation loop multiplies — toward the decision would argue for
plumbing on traffic that carries none of the risk. The field is required rather
than defaulted: a mislabeled row cannot be repaired once the data has accrued.

A completed triage emits the matching denominator, `flake.triage.ran`, at
`debug` (no console lines in a normal run; the JSONL records every level).
Without it "only if path 1 shows up at a meaningful rate" has no rate.

Read the accrued counter off the run logs:

```bash
jq -c 'select(.data.event == "flake.triage.skipped" or .data.event == "flake.triage.ran") | .data' \
  ~/.nax/*/features/*/runs/*.jsonl \
  | jq -s 'group_by(.scope) | map({
      scope: .[0].scope,
      ran: (map(select(.event == "flake.triage.ran")) | length),
      skipped: (group_by(.reason) | map(select(.[0].reason != null) | {(.[0].reason): length}) | add)
    })'
```

Per #1657 the follow-up guard is gated on `max-probes-per-gate` at
`scope: "blocking-gate"` in particular showing up at a meaningful rate — the
plumbing is not paid for on speculation.

**If that guard is built, `flakeTriageRan` is the wrong signal for it.**
`triageFlakyFindings` returns normally on the `max-probes-per-gate` skip, so
`productionTriageSeam` reports `flakeTriageRan: true` for exactly the path
#1657 names as mattering most — a guard written against that flag would be
inert there. Step 3 needs a distinct signal (`probed`, or a `false` on the cap
path), and changing `flakeTriageRan` itself is not free: `triageNbfGate` feeds
it into `recordAttempt`, where `false` also changes which keys are marked
attempted.

## Config

One new block under `execution` (Zod schema, `src/config/schemas*.ts`):

```json
"execution": {
  "flakeDetection": {
    "enabled": true,
    "probeRuns": 2,
    "maxProbesPerGate": 5,
    "probeTimeoutSeconds": 60
  }
}
```

- `enabled` — default **true**. Safe because the feature only activates on the
  narrow pre-existing-and-untouched path; disable per-project or per-package via
  the existing `.nax/mono/<pkg>/config.json` deep-merge.
- `probeRuns` — isolation re-runs per candidate; pass-at-least-once ⇒ flaky.
- `maxProbesPerGate` — cost guard: more than 5 distinct pre-existing failures at
  one gate is almost certainly a real breakage or environment problem, not five
  simultaneous flakes → skip probing entirely, everything stays blocking, log why.
- `probeTimeoutSeconds` — per-probe timeout via `executeWithTimeout`; a timed-out
  probe counts as a failed probe (never a pass).

## Edge cases & error handling

- **Ambiguous probe outcomes fail closed.** Any probe that does not produce a
  clean pass (crash, `ENVIRONMENTAL_FAILURE` classification, timeout) counts as
  a failed probe. The probe never promotes a failure to flaky on ambiguous
  evidence.
- **Monorepo:** probes run in the failing test's package `workdir` with that
  package's quality commands (per-package config resolution already exists); in
  worktree isolation mode the probe runs inside the story's worktree.
- **Shared-state flakes:** a test failing in-suite but passing in isolation may
  be order-dependent rather than random. Accepted: either way it is a
  pre-existing test the diff did not touch, so run-scoped quarantine is the
  correct call. The report labels it "passed in isolation" so a human can
  distinguish.
- **`nax accept` interaction:** none — quarantine happens before findings reach
  any gate verdict; manual AC override semantics unchanged.

## Testing strategy

- **Unit:**
  - flake-probe command construction per framework (bun/jest/vitest/pytest/go),
    including test-name escaping for `-t`/`-run` regex metacharacters;
  - triage classification matrix: touched vs untouched × probe outcomes ×
    unprobeable × `maxProbesPerGate` overflow;
  - relabeling and `gateFailureKeys` exclusion.
- **Integration:**
  - fixture repo with a deliberately order-dependent/random test: run the
    full-suite gate path, assert no fix cycle dispatched, gate passes with
    warnings, quarantine event present in run JSONL;
  - control case: diff touches the flaky test file → assert it stays blocking.
- Follows nax DI conventions (`_deps` injection, no `mock.module()` leaks).

## Out of scope (explicit)

- Persistent flaky-history store across runs (`.nax/flaky.json`) — deferred;
  revisit once run-scoped quarantine proves out.
- Flakiness detection for agent-written or acceptance tests.
- Auto-fixing the flaky test itself (could later be a curator proposal).

## Grounding notes (verified against codebase @ v0.70.8)

- Per-test failure identity already exists: `TestFailure { file, testName, error,
  stackTrace }` parsed per framework in `src/test-runners/parser.ts`.
- Failures flow: `runVerificationCore` → `TEST_FAILURE` → `parseTestOutput` →
  `testSummaryToFindings` → `FixCycle`/`runFixCycle` with
  `makeFullSuiteRectifyStrategy`.
- Precedent for the philosophy: verifier-passed carve-out in
  `shouldSkipPhaseForRectification()` already treats a failing gate with a
  passing verifier as an unrelated pre-existing regression.
- No existing "flaky" feature anywhere in the repo (grep-verified greenfield).
