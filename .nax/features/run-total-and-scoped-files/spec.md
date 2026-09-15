# SPEC: One Run Total, and a `{{files}}` List That Splits

## Summary

Two defects found by auditing the artifacts of run `run-2026-09-14T17-00-20-930Z`,
bundled because they are both single-function fixes in disjoint modules with no
shared code. First, a headless run prints two different figures for its own cost,
because the reconciled total the completion phase computes never reaches the
runner — so the printed footer, every post-run plugin and every reporter see a
pre-completion accumulator that omits post-execution rectification spend and
failed-dispatch spend. Second, a multi-path `{{files}}` value reaches the shell as
one quoted argument whenever no token happens to be an *existing file*, which is
the normal state for a list of directories and for the not-yet-created test paths
a TDD test-writer names — the value then matches nothing and the agent is told its
files do not exist.

## Motivation

**nax#2053 — the run reports two totals.** One run printed `RUN SUMMARY 💰 Cost:
$5.8042` and, nine lines later, `── Summary ── Cost: $5.6995`. The delta is
`$0.104691`, which is exactly the run's last two ledger rows (`US-001 diagnose`
`$0.032839` + `US-001 test-fix` `$0.071852`), billed during the post-execution
rectification pass. There are **zero** ledger rows after the execution phase's
handoff timestamp, so this is not late spend arriving after a snapshot — the
accumulator structurally never sees the rectification phase. The codebase already
documents this trap at `runner-completion.ts:361`: *"Use reportedTotal
(cost-aggregator-corrected) instead of the legacy options.totalCost accumulator,
which drops acceptance/review/diagnosis spend (issue #909)."* That fix was applied
to `status.json`, the exit summary and the `RUN SUMMARY` block, and missed the
value the runner returns. A second, independent divergence rides along: the
reconciled figure is `totalCostUsd + totalErrorCostUsd`, so the accumulator also
omits failed-dispatch spend entirely.

The printed line is the least of it. The same stale value is handed to
`cleanupRun`, and from there to `PostRunContext.totalCost` (read by every post-run
plugin, the curator included) and to `reporter.onRunEnd`. A plugin that bills,
budgets or reports on run cost sees the pre-rectification figure while
`status.json` sees the real one.

**nax#2055 — a multi-path `{{files}}` is not split.** `pathListElements` splits a
space-joined value into separate shell arguments only when at least one token is an
existing **file**. The existing-file test is there to tell a path list from a NAME
filter (`pytest -k`, `jest -t`), which is right, but it also rejects two shapes
that are ordinary path lists:

1. **Directories** — `test/unit/tools test/unit/agents/cost`. `isExistingFile` uses
   `isFile()`, so a directory is not evidence.
2. **Test files that do not exist yet** — the normal state of a TDD `test-writer`
   phase, which names the paths it is about to create.

In both cases the whole value goes to the shell as one argument and the agent gets
`bun test`'s *"The following filters did not match any test files … N files were
searched"* — the exact misleading message nax#1998 was filed to eliminate. Across
every stored tool-audit, **40 of 40** multi-token filter-miss failures were
unsplit: the harness echoed the entire value back as a single filter line. Of
those, 36 carried file-like tokens that did not exist yet and 4 were
directory-only. Two occurred in the audited run, and in both the agent escalated to
`Exec`, which the allowlist denied — so each occurrence cost three round trips and
left the agent no closer to a scoped run.

Measured: the same two directories exit 1 as one quoted argument and pass **767
tests across 42 files** as separate arguments. Adding any one existing file to an
identical directory list flips it to working, which makes the behaviour look
nondeterministic from the agent's side.

## Design

Two independent changes. Neither touches the other's module.

### Integration — nax#2053 (US-001)

Read-only, verified on `db7fa2b64`:

- `totalSpendUsd(snap)` (`src/runtime/cost-aggregator.ts:222`) returns
  `snap.totalCostUsd + snap.totalErrorCostUsd`.
- `reportedTotal` is computed at `src/execution/lifecycle/run-completion.ts:363`
  as `totalSpendUsd(aggSnap)`, and is already the authority for `status.json`
  (`runner-completion.ts:378`), the headless footer (`:419`) and the exit summary
  (`:429`).
- `bin/nax.ts:707` prints `result.totalCost` in the headless `── Summary ──` block.
- `cleanupRun` (`src/execution/lifecycle/run-cleanup.ts:149, :213`) forwards its
  `totalCost` option to `PostRunContext.totalCost` and to `reporter.onRunEnd`.

Mutated symbols — the baseline is stated only to locate the code and is never the
interface to implement:

**`RunnerCompletionResult`** (`src/execution/runner-completion.ts:85`)

- Baseline: `{ durationMs, runCompletedAt, acceptancePassed, pluginGateFailed }`.
- Target: the same four fields plus `reportedTotal: number` — the
  cost-aggregator-reconciled total for the whole run, successful plus
  failed-dispatch spend.

**`runCompletionPhase`** (`src/execution/runner-completion.ts:130`, returning at
`:472`)

- Baseline: destructures `reportedTotal` from its inner completion result at `:358`,
  uses it locally, and returns the four fields above.
- Target: returns `reportedTotal` alongside them. This is the actual seam — the
  field never reaches `runner.ts`, so nothing there can be "dropping" it.

**`run`'s completion handoff** (`src/execution/runner.ts:130`, handoff at `:336`)

- Baseline: `const { durationMs, acceptancePassed, pluginGateFailed } =
  completionResult;` and the execution-phase accumulator assigned at `:298`
  (`totalCost = executionResult.totalCost`) is what `:345` returns and what the
  `finally` block hands `cleanupRun` at `:384`.
- Target: the reconciled total is what every consumer downstream of the completion
  phase reports — the returned `RunResult.totalCost`, and the value `cleanupRun`
  receives. Both read the same `totalCost` binding (the `finally` block included),
  so one assignment after the completion phase can satisfy both; the acceptance
  criteria pin the observable values, not the mechanism.

**No fallback.** When the aggregator snapshot is empty, `reportedTotal` is `0`, and
that is left as-is. It is already the number written to `status.json` and printed
in `RUN SUMMARY`, so trusting it in one more place adds no new failure mode, while a
`Math.max`-style guard would invent a divergence between the two surfaces this
feature exists to make agree.

### Integration — nax#2055 (US-002)

Read-only, verified on `db7fa2b64`:

- `src/tools/policy.ts:496-514` iterates `scope.listPathFields`, calls
  `pathListElements(value, resolvedRoot)`, and for **every** returned element
  resolves it within the root, applies path rules, and grant-checks it before
  pushing to `resolvedPaths`. Returning more elements therefore grant-checks more
  paths — containment tightens, never loosens.
- `src/tools/run-command.ts:307` declares `scope.listPathFields: ["values.files"]`,
  and `:374` onward pairs `pathListElements`' output positionally against
  `ctx.resolvedPaths`, with a length-mismatch fail-safe that falls back to the raw
  single-argument value.
- `substituteCommand` (`src/tools/run-command.ts:124`) quotes an array value per
  element and a string value whole. Unchanged by this feature.
- Inside that positional pairing, an element is swapped for its resolved absolute
  path **only when it is an existing file**; every other element keeps the raw token
  it arrived as. Directories and not-yet-created paths therefore stay relative, which
  is what the test runner expects, so widening the split does not require widening
  absolutisation. Unchanged by this feature.

Mutated symbol:

**`pathListElements(value, root)`** (`src/tools/path-list.ts:26`)

- Baseline: splits on whitespace; returns `[value]` when there are ≤1 tokens or
  when no token is an existing file.
- Target: the same signature, deciding by ordered evidence tiers:

  1. ≤1 token → `[value]`.
  2. The **whole value** resolves to an existing file → `[value]`. This is the
     space-in-path guard nax#1998 introduced and it must be checked before any
     token-level test.
  3. **Any** token is an existing file **or an existing directory** → the tokens.
  4. **Every** token looks like a path — contains a path separator, or ends in a
     file extension → the tokens. This is what admits a not-yet-created test path.
  5. Otherwise → `[value]`. A multi-token name filter (`pytest -k`, `jest -t`)
     lands here.

  Tier 4 is deliberately language-neutral: it keys on path *syntax*, not on a
  test-file naming convention, so it works for `test_foo.py`, `foo_test.go` and
  `Foo.test.ts` alike without nax knowing the host project's language. Tier 4
  requires **every** token to qualify, so a mixed name-filter-plus-path value where
  nothing exists keeps today's whole-value behaviour rather than guessing.

Because both the policy layer and the tool call this one function, the two layers
continue to agree by construction — that agreement is nax#1998's invariant and the
reason the function exists.

The `values` parameter description (`src/tools/run-command.ts:272`) currently tells
the agent *"A path placeholder takes several paths separated by spaces … one call,
not one per file."* That is true for existing files and silently wrong for the two
shapes above, and the array form the tool already accepts is undocumented. The
description gains the array form as an explicitly accepted shape.

### Failure Handling

| condition | behaviour |
|:---|:---|
| Cost aggregator snapshot is empty at completion | `reportedTotal` is `0` and is reported as-is; no fallback to the accumulator (see "No fallback" above, and Out of Scope). |
| Policy and tool disagree on element count for one value | Existing length-mismatch fail-safe stands: the shell receives the raw single argument, which is always a subset of what the policy approved. Unchanged. |
| A token in a multi-token value resolves outside the root | The policy denies the whole call with the existing out-of-root reason, per element. Splitting more tokens means more elements are checked. |
| A multi-token value whose tokens are neither existing paths nor path-shaped | Returned whole (tier 5), preserving name-filter semantics. |
| A whitespace-only or empty `{{files}}` value | Returned as a single element, never an empty list — existing contract, unchanged. |

## Out of Scope

- Changing `substituteCommand`'s quoting rule, including how an array value is quoted per element and a string value quoted whole.
- Changing which project-declared commands declare a `{{files}}` placeholder, or the contents of any `quality.commands` entry.
- Adding a fallback for an empty cost-aggregator snapshot, including any `Math.max` between the reconciled total and the execution-phase accumulator.
- Changing how `costUsd`, `estimatedCostUsd`, `exactCostUsd` or `confidence` are computed, and any budget gate or spend cap that reads them.
- Changing the TUI's own run summary, which renders independently of the headless footer.
- Backfilling, re-reporting or migrating the totals of runs that already completed.
- Changing the `Exec` allowlist or the denial messages an `Exec` escalation produces — the denied escalations in nax#2055's evidence belong to nax#2010 and nax#2044.
- Changing the 40 KiB tool-result cap or any carry-cost work; result size and its re-read multiplier are nax#2056.
- Making the `{{files}}` evidence rule depend on a language-specific test-file naming convention such as `*.test.ts` or `test_*.py`.
- Changing `pathListElements`' single-token contract or its empty/whitespace-only contract.
- Any change to `reporter.onRunEnd`'s or `PostRunContext`'s shape; only the value passed for `totalCost` changes.
- Changing the positional-pairing length-mismatch fail-safe in `RunCommand`, which falls back to the raw single-argument value when the policy and the tool disagree on element count. It stays exactly as it is, including its fail-safe direction.
- Detecting or reporting that the two figures disagreed in a past run.

## Stories

### US-001 — One reconciled total reaches every consumer

Carry the cost-aggregator-reconciled total out of the completion phase so the
returned run result, the headless `── Summary ──` line, `PostRunContext.totalCost`
and `reporter.onRunEnd` all report the same figure `status.json` already does.

Depends on: nothing.

#### Context Files
- `src/execution/runner-completion.ts` — `RunnerCompletionResult` and the completion phase that already destructures `reportedTotal`
- `src/execution/runner.ts` — the completion handoff, the returned `RunResult`, and the `finally` block that calls `cleanupRun`
- `src/execution/lifecycle/run-completion.ts` — where `reportedTotal` is computed
- `src/execution/lifecycle/run-cleanup.ts` — `PostRunContext.totalCost` and `reporter.onRunEnd`
- `src/runtime/cost-aggregator.ts` — `totalSpendUsd` and the snapshot shape

#### Creates
- `test/unit/execution/runner-completion-reported-total.test.ts` — mirrors `src/execution/runner-completion.ts`, matching the existing `runner-completion-*.test.ts` naming

### US-002 — A multi-path `{{files}}` splits for directories and for files not yet written

Widen `pathListElements`' evidence rule so a list of directories, and a list of
not-yet-created path-shaped tokens, split into separate shell arguments, while a
multi-token name filter and a single path containing spaces keep today's
whole-value behaviour. Document the array form the tool already accepts.

Depends on: nothing.

#### Context Files
- `src/tools/path-list.ts` — the evidence rule
- `src/tools/run-command.ts` — `listPathFields`, the positional pairing, and the `values` description
- `src/tools/policy.ts` — the per-element grant check that must keep agreeing
- `test/unit/tools/run-command.test.ts` — the existing multi-path `{{files}}` and per-element quoting tests (nax#1998)

#### Creates
- `test/unit/tools/path-list.test.ts` — mirrors `src/tools/path-list.ts`, which today has no test file of its own; keeps `run-command.test.ts` (640 lines) clear of the 800-line test cap

### Seams

**No cross-story seam exists.** The two stories share no module, no symbol and no
data: US-001 touches `src/execution/**` and US-002 touches `src/tools/**`, and
neither introduces a symbol the other calls. Each story's own wiring is proved
inside its own acceptance criteria — US-001's by asserting the value that reaches
`reporter.onRunEnd`, which is the outermost consumer of the changed field, and
US-002's by asserting the argument list the tool produces and the paths the policy
grant-checks.

## Acceptance Criteria

### US-001

- [unit] `runCompletionPhase` resolves to a result whose `reportedTotal` equals the sum of the cost-aggregator snapshot's `totalCostUsd` and `totalErrorCostUsd`: for a snapshot with `totalCostUsd` 5.6995 and `totalErrorCostUsd` 0.1047 it is 5.8042.
- [unit] `runCompletionPhase` resolves to a result whose `reportedTotal` equals the snapshot's `totalCostUsd` when `totalErrorCostUsd` is 0.
- [integration] Given an execution phase that accumulated 5.6995 and a cost-aggregator snapshot totalling 5.8042, the run result returned by the runner has `totalCost` equal to 5.8042.
- [integration] Given that same run, the `totalCost` the runner returns equals the `reportedTotal` its completion phase produced, for any pair of accumulator and snapshot values that differ.
- [integration] Given that same run, a registered reporter's `onRunEnd` is invoked with `totalCost` equal to 5.8042, not 5.6995.
- [integration] Given that same run, the post-run context built for plugins has `totalCost` equal to 5.8042.
- [integration] When the accumulator and the snapshot total are equal, the run result's `totalCost` equals that shared value, so a run with no post-execution spend reports the same figure as before this change.
- [unit] When the cost-aggregator snapshot is empty, `runCompletionPhase` resolves to a result whose `reportedTotal` is 0, and the run result's `totalCost` is 0.

### US-002

- [unit] `pathListElements` called with two existing directory paths separated by a space returns two elements, one per directory.
- [unit] `pathListElements` called with two existing directory paths that each carry a trailing path separator returns two elements.
- [unit] `pathListElements` called with two path-shaped tokens that do not exist on disk, each containing a path separator and a file extension, returns two elements.
- [unit] `pathListElements` called with one existing directory and one non-existent path-shaped token returns two elements.
- [unit] `pathListElements` called with two tokens that contain no path separator and no file extension returns one element equal to the whole input value, so a multi-token name filter is not split.
- [unit] `pathListElements` called with the path of a single existing file whose own name contains a space returns one element equal to that whole path.
- [unit] `pathListElements` called with a value of one token returns one element equal to that value.
- [unit] `pathListElements` called with a whitespace-only value returns exactly one element rather than an empty list.
- [unit] `pathListElements` called with a mixed value in which one token has no path separator and no extension and the other is a non-existent path-shaped token, with neither existing on disk, returns one element equal to the whole value.
- [integration] Invoking `RunCommand` with a declared command whose template contains `{{files}}` and a `values.files` of two existing directories runs a command in which each directory appears as its own quoted argument.
- [integration] Invoking `RunCommand` with a `values.files` of two existing directories where one resolves outside the tool's root is denied, and the denial names the out-of-root element.
- [unit] The `values` parameter description on the tool returned by `createRunCommandTool` names an array of paths as an accepted shape for a path placeholder.
- [unit] `substituteCommand` called with a `files` value that is an array of two paths produces a command in which each path is a separate quoted argument.

<!-- spec-writing: completed-through-phase-6 -->
