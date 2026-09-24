# SPEC: Honest gates and labels — declared mechanisms that do what they say

## Summary

Five independent fixes where nax declares, labels or routes something differently from what it
does. A config knob with no reader is retired with a real warning (#2174). Per-package quality
gates choose their cwd from where the command came from, not from whether the package has any
overlay file (#2182). The findings cycle gains a `rotated` outcome and the oscillation breaker's
reason names what it counts (#2154, secondary defects only). The spin breaker gains a time axis so
a slow spin ends as `fail-spin` before the idle watchdog ends it as `fail-stale`, and its nudge
budget is restored after sustained progress (#2017). Post-run approval prompts carry their real
stage, `fail-spin` / `fail-incomplete` retries stop claiming a timeout, and the runner's
interaction-chain threading gets a test (#2213 items 1, 2, 4).

## Motivation

Verified on `main` @ `f6fd92fb8`:

**#2174 — an inert knob.** `review.gateLLMChecksOnMechanicalPass` is declared in
`src/config/schemas-review.ts`, defaulted in `src/config/schemas.ts` and typed in
`src/review/types.ts`, and nothing in `src/` reads it. #1859 moved the LLM checks out of
`runReview`, orphaning it. `ReviewCheckResult.skipped` (`src/review/types.ts`), the flag it was
meant to drive, has no writer and no reader. `docs/guides/semantic-review.md` documents the knob as
live. Setting it to `false` changes nothing and warns nothing.

**#2182 — gate cwd keyed on the wrong thing.** `lint-check.ts`, `typecheck-check.ts`,
`verify-scoped.ts` and `full-suite-gate.ts` (all `src/operations/`) run a configured command in the
package dir when `ctx.packageView.hasOverride` is true and at `repoRoot` otherwise.
`hasOverride` (`src/runtime/packages.ts`) is true whenever `.nax/mono/<pkg>/config.json` exists,
whatever it defines. So a root `lint` runs in `packages/lib` because that overlay defines only
`test`, and at the repo root for `packages/app`, which has no overlay — where a root
`echo 'no lint' && exit 0` passes vacuously. `hydrate()` keeps only the merged config, so the raw
overlay needed to tell the two apart is discarded today.

**#2154 (secondary defects) — two mislabels.** The breaker reason in
`src/execution/oscillation-breaker.ts` says `N regressed-different-source iterations`, but the
count (`countOscillationOutcomes`, `src/execution/oscillation-store.ts`) is the number of finding
sources that reappeared after being resolved. And `classifyOutcome` (`src/findings/cycle.ts`)
returns `regressed` both for "one new finding beside three that persisted" and for "every finding
replaced by a different one", so no consumer can see a full rotation.

**#2017 — slow spins end as `fail-stale`.** The spin breaker (`src/runtime/spin-breaker/index.ts`)
counts repeats only; the tool-call-only idle watchdog fires on wall clock (default 1800 s). A
repeated call that takes ~40 s reaches the watchdog first, and the cancel is classified
`fail-stale` (immediate swap, cooldown, terminal backoff) instead of `fail-spin` (same-agent retry
on a fresh session). Separately, the breaker's nudge budget (`nudges` vs `maxNudges`) is spent once
per session and never restored, so a second spin episode is stopped with no warning.

**#2213 — three leftovers from #2203–#2207.** `createHumanAskLink` (`src/interaction/ask-link.ts`)
hard-codes `stage: "execution"` on every approval prompt, including the acceptance-fix loop, the
deferred regression gate and `nax finish`. `timeoutRetry`
(`src/prompts/builders/timeout-retry-builder.ts`) tells a `fail-spin` or `fail-incomplete` retry
that it "hit a timeout". `runner.ts` passing `interactionChain` into `runCompletionPhase` has no
test.

## Design

### US-001 — Retire `review.gateLLMChecksOnMechanicalPass` (#2174)

- Delete the key from `ReviewConfigSchema` (`src/config/schemas-review.ts`), from the default config
  (`src/config/schemas.ts`) and from `ReviewConfig` (`src/review/types.ts`).
- Delete `skipped?: boolean` from `ReviewCheckResult` (`src/review/types.ts`).
- Add `"review.gateLLMChecksOnMechanicalPass"` to `REMOVED_NO_OP_KEYS`
  (`src/config/config-guards.ts`) with the hint `LLM review checks are sequenced by the story
  orchestrator; this key never had an effect after #1859`. `stripRemovedNoOpKeys` then warns once
  and strips the key, as it does for the existing entries.
- Fix the LLM row of the table in `docs/guides/semantic-review.md` to drop the gating clause.
- Removal of the three declarations and of `skipped` is verified by the build (`bun run typecheck`)
  and the existing lint gate, not by an AC.

### US-002 — Gate cwd from command provenance (#2182)

`PackageView` (`src/runtime/packages.ts`) gains one optional field, so the existing inline
`PackageView` literals in tests keep compiling:

```ts
/** The raw per-package overlay (`.nax/mono/<pkg>/config.json`) before merging; absent when the package has none. */
readonly overlay?: Partial<NaxConfig>;
```

`hydrate()` stores the raw override it loaded in a second map beside `mergedConfigs`; `resolve()`
passes it to `createPackageView`. `hasOverride` keeps its meaning and its other callers.

New module `src/operations/gate-cwd.ts`:

```ts
export type GateCommandProvenance = "root" | "overlay" | "detected";

export interface GateCwdInput {
  /** The quality command the gate runs. */
  readonly commandName: "lint" | "typecheck" | "test";
  /** True when the command was auto-detected from the package manifest, not configured. */
  readonly detected: boolean;
  readonly packageView: Pick<PackageView, "overlay" | "repoRoot">;
  /** The story's package workdir (`input.workdir` in each gate). */
  readonly workdir: string;
}

export interface GateCwd {
  readonly cwd: string;
  readonly provenance: GateCommandProvenance;
}

export function resolveGateCwd(input: GateCwdInput): GateCwd;
```

Rule:
- `detected` → `{ cwd: workdir, provenance: "detected" }`.
- else, the overlay defines `quality.commands[commandName]` or `review.commands[commandName]`
  (either `!== undefined`) → `{ cwd: workdir, provenance: "overlay" }`.
- else → `{ cwd: packageView.repoRoot, provenance: "root" }`.

The `review.commands` arm exists because `full-suite-gate.ts` reads
`review.commands.test ?? quality.commands.test` through `resolveQualityTestCommands`, and
`mergePackageConfig`'s PKG-006 bridge mirrors overlay quality commands into `review.commands`.

Each of the four gates replaces its `hasOverride` ternary with a `resolveGateCwd(...)` call and
uses `.cwd`:
- `lint-check.ts` with `commandName: "lint"`, `detected: detectedFromPackage`.
- `typecheck-check.ts` with `commandName: "typecheck"`, `detected: detectedFromPackage`.
- `verify-scoped.ts` with `commandName: "test"`, `detected: detectedFromPackage`.
- `full-suite-gate.ts`, inside `_fullSuiteGateDeps.resolveGateContext`, with `commandName: "test"`
  and `detected: false` on the configured path (the detected path already returns early with
  `input.workdir`, unchanged).

`verify-scoped.ts` adds `provenance` to its existing `"Running scoped tests"` log data;
`full-suite-gate.ts` stores it on `FullSuiteGateContext` as `cmdProvenance` and adds it to its
existing `"Running full-suite gate"` log data. The doc comment on `FullSuiteGateContext.cmdWorkdir`
is updated to the new rule.

### US-003 — `rotated` outcome and an honest breaker reason (#2154 secondary defects)

`src/findings/cycle.ts` is at 592 of 600 lines, so `classifySingleSource` and `classifyOutcome`
move verbatim into a new module `src/findings/classify-outcome.ts`; `cycle.ts` imports
`classifyOutcome` from it for its own call sites and re-exports it
(`export { classifyOutcome } from "./classify-outcome";`) so every existing import keeps working.

`IterationOutcome` (`src/findings/cycle-types.ts`) gains `"rotated"`, and the inline copy of the
union at `src/plugins/builtin/curator/types.ts` gains it too.

In `classifyOutcome`, after the `regressed-different-source` check and before the per-source
aggregation:

```ts
// nax#2154: every finding replaced by a different one — the defect moved, nothing converged.
const beforeKeys = new Set(before.map(findingRecurrenceKey));
if (after.length > 0 && after.every((f) => !beforeKeys.has(findingRecurrenceKey(f)))) return "rotated";
```

Precedence is therefore: `resolved` (both empty) → `regressed` (before empty) →
`regressed-different-source` → `rotated` → per-source aggregation (unchanged). No consumer treats
`rotated` specially: `countOscillationOutcomes` works on sources, not outcomes, and the curator,
`prior-iterations-builder.ts` and `no-progress-bail.ts` only special-case `resolved` or
`unchanged`.

The breaker reason in `src/execution/oscillation-breaker.ts` becomes:

```ts
reason: `Rectification oscillation threshold reached: ${count} resolved finding sources reappeared across attempts (max ${maxOscillations})`,
```

The `countOscillationOutcomes` comment in `src/execution/post-run.ts` that calls the count
"regressed-different-source iterations" is corrected to the same wording.

### US-004 — Spin breaker time axis and per-episode nudge budget (#2017)

`ResolvedSpinBreakerSettings` (`src/runtime/spin-breaker/index.ts`) gains:

```ts
/**
 * nax#2017: seconds with no new call key after which a repeat run ends the turn, so a slow spin
 * stops as fail-spin before the tool-call-only idle watchdog cancels it as fail-stale. 0 disables.
 */
readonly stopAfterNoProgressSeconds: number;
```

`DEFAULT_SPIN_BREAKER_SETTINGS.stopAfterNoProgressSeconds` is `900`.
`AgentSpinBreakerConfigSchema` (`src/config/schemas-infra.ts`) gains
`stopAfterNoProgressSeconds: z.number().int().min(0).max(86_400).optional()` — optional, no zod
default, because the effective default depends on another section. `AgentSpinBreakerConfig` gains
the matching optional field.

`selectSpinBreakerSettings` (`src/session/spin-breaker-selection.ts`) resolves it as: the configured
value when set; otherwise `Math.floor(t / 2)` where `t` is
`config.agent.idleWatchdog.toolCallOnlyIdleTimeoutSeconds`, when the watchdog `mode` is not `"off"`
and `t > 0`; otherwise `900`.

`createSpinBreaker(settings, deps?)` gains an optional second parameter
`{ readonly now?: () => number }` (milliseconds, default `Date.now`). The breaker keeps
`lastProgressAt`, set to `now()` at creation and on every new-key event.

`SpinStopReason` gains `"no-progress-time"`, with stop message
`"Ending the turn — repeated calls with no new call for too long"`. In `observe`, on the repeat path,
after `repeatsSinceProgress` is incremented and before the `repeat-run` threshold check:

```ts
const NO_PROGRESS_TIME_MIN_REPEATS = 5;
if (
  settings.stopAfterNoProgressSeconds > 0 &&
  repeatsSinceProgress >= NO_PROGRESS_TIME_MIN_REPEATS &&
  now() - lastProgressAt >= settings.stopAfterNoProgressSeconds * 1000
) {
  return stopOrNudge(toolName, repeatsSinceProgress, "no-progress-time");
}
```

`NO_PROGRESS_TIME_MIN_REPEATS` is a module constant, not a setting. The stop reaches the
orchestrator through the existing `spinStopped` → `fail-spin` path; no session, adapter or
`src/session/manager.ts` change.

Nudge budget: the breaker keeps two counters. `nudges` stays the session-cumulative count that
`summary()` reports (telemetry meaning unchanged). A new internal `episodeNudges` is what
`stopOrNudge`, the nudge-point check and `nudgeText` use against `maxNudges`. `episodeNudges` resets
to `0` when a real stop fires, and when `newKeyEvents - newKeyEventsAtLastNudge >=
settings.nudgeAfterRepeats` on a new-key event (`newKeyEventsAtLastNudge` is recorded in
`buildNudge`). Resetting on every new key is deliberately NOT done: a laundering loop that
interleaves a fresh key between repeats of one call (nax#2047) would restore its budget forever and
never stop.

### US-005 — #2213 leftovers: approval stage, retry wording, runner test

**Approval stage.** `createHumanAskLink` (`src/interaction/ask-link.ts`) options gain
`readonly stage?: InteractionStage`; the prompt uses `stage: opts.stage ?? "execution"`.
`DispatchAskOptions` (`src/interaction/dispatch-ask.ts`) gains `readonly stage?: InteractionStage`,
and `buildDispatchAskWiring` passes it to `deps.createHumanAskLink` when defined.
`buildRunDispatchAskWiring` forwards it through its existing spread. Post-run callers pass the
existing `InteractionStage` values (no new union members):
- `src/execution/lifecycle/acceptance-fix-scope.ts` → `"review"`
- `src/execution/lifecycle/run-regression.ts` (deferred regression gate) → `"review"`
- `src/finish/phase.ts` → `"merge"`
- `src/pipeline/stages/execution.ts` passes nothing (keeps `"execution"`).

**Retry wording.** `timeoutRetry` dispatches `fail-spin` and `fail-incomplete` to their own
builders, as it already does for `fail-invalid-tool-call`. Both keep the structure of
`invalidToolCallRetry`: a first line naming what happened, the line
`This was not a timeout. This is attempt N of the same story.`, a change-of-approach line, the
changed-files state paragraph, then `---` and the original prompt.
- `fail-spin` first line: `The previous attempt was stopped because it kept repeating the same tool calls without making progress.`
  Approach line: `Do not repeat a call whose result you already have; if a check keeps returning the same result, change the code or the approach before running it again.`
- `fail-incomplete` first line: `The previous attempt ended its turn before finishing the story.`
  Approach line: `Keep working until every acceptance criterion is met, then finish with your final answer.`
`fail-timeout` and an absent `failure` keep today's wording byte-for-byte.

**Runner test.** A test pins that `run` passes its interaction chain into
`_runnerDeps.runCompletionPhase` unchanged.

### Integration

| Surface | Change |
|:--|:--|
| Config | `review.gateLLMChecksOnMechanicalPass` removed (warns + strips); `agent.spinBreaker.stopAfterNoProgressSeconds` added (optional) |
| Gate cwd | root-sourced commands run at `repoRoot`, overlay-sourced and detected commands in the package dir, independent of unrelated overlay keys |
| `findings.cycle` iteration records | `outcome` may be `"rotated"` |
| Oscillation breaker reason | new wording, same count |
| Spin breaker telemetry | new stop reason `no-progress-time`; `summary().nudges` still cumulative |
| Interaction prompts | post-run approvals carry `stage` `review` / `merge` |
| Retry prompts | `fail-spin` / `fail-incomplete` say what happened instead of "hit a timeout" |

### Failure Handling

| Condition | Behavior |
|:--|:--|
| Overlay file exists but defines none of the gate's command | Gate runs at `repoRoot` (`provenance: "root"`) |
| Overlay defines the command only under `review.commands` | Gate runs in the package dir (`provenance: "overlay"`) |
| Idle watchdog `mode: "off"` and no configured `stopAfterNoProgressSeconds` | Time axis uses `900` |
| `stopAfterNoProgressSeconds: 0` | Time axis disabled; repeat, same-key and backstop axes unchanged |
| A config still sets `review.gateLLMChecksOnMechanicalPass` | One warning naming the key; the key is stripped; load succeeds |

## Out of Scope

- #2154's primary change (counting consecutive rotated iterations toward the oscillation breaker) is not done; it needs a base-rate measurement first.
- #2017's alternative of relabelling a watchdog cancel as `fail-spin` in `src/session/watchdog-turn-classification.ts` is not done.
- #2182's log-only alternative is not done; the provenance rule replaces the `hasOverride` ternary.
- #2213 item 3 (`scripts/check-git-spawn-env.ts` blind spot) is not done: no git spawn in `src/` builds its argv from a git-binary identifier, and the four variable-argv sites are already hardened.
- New `InteractionStage` union members (`acceptance`, `rectification`) are not added.
- `hasOverride` is not removed or renamed; its config-selection callers are unchanged.
- The dead-in-production `AcpInteractionBridge` (`src/agents/acp/interaction-bridge.ts`) keeps its hard-coded stage.
- The historical `docs/specs/SPEC-story-orchestrator.md` mention of the retired knob is not edited.

## Stories

**US-001 — Retire the inert `review.gateLLMChecksOnMechanicalPass` knob (#2174)**
Delete the three declarations and `ReviewCheckResult.skipped`, add the key to `REMOVED_NO_OP_KEYS`,
fix the guide row. No dependencies.

**US-002 — Quality gates choose cwd from command provenance (#2182)**
Keep the raw overlay on `PackageView.overlay`, add `resolveGateCwd` in
`src/operations/gate-cwd.ts`, and use it in the four gates. No dependencies.

**US-003 — `rotated` iteration outcome and honest oscillation reason (#2154)**
Move `classifyOutcome` to `src/findings/classify-outcome.ts`, add `rotated`, reword the breaker
reason. No dependencies.

**US-004 — Spin breaker stops slow spins by time and restores its nudge budget (#2017)**
Add `stopAfterNoProgressSeconds`, the `no-progress-time` stop, the injectable clock, the
watchdog-derived default and the per-episode nudge budget. No dependencies.

**US-005 — Post-run approval stage, honest retry wording, runner chain test (#2213)**
Thread `stage` through the ask link, add `fail-spin` / `fail-incomplete` retry wording, add the
runner test. No dependencies.

### Context Files

**US-001**

- `src/config/config-guards.ts` — `REMOVED_NO_OP_KEYS`, `stripRemovedNoOpKeys`
- `src/config/schemas-review.ts` — the key's declaration
- `src/config/schemas.ts` — the key's default
- `src/review/types.ts` — `ReviewConfig`, `ReviewCheckResult.skipped`
- `docs/guides/semantic-review.md` — the LLM row of the check table

**US-002**

- `src/runtime/packages.ts` — `PackageView`, `createPackageView`, `resolve`, `hydrate`
- `src/operations/lint-check.ts` — the cwd ternary and `detectedFromPackage`
- `src/operations/typecheck-check.ts` — the cwd ternary and `detectedFromPackage`
- `src/operations/verify-scoped.ts` — the cwd ternary and the `"Running scoped tests"` log
- `src/operations/full-suite-gate.ts` — `_fullSuiteGateDeps.resolveGateContext`, `FullSuiteGateContext`, the `"Running full-suite gate"` log
- `src/config/merge.ts` — `mergePackageConfig` and its PKG-006 bridge
- `src/quality/command-resolver.ts` — `resolveQualityTestCommands`

**US-003**

- `src/findings/cycle.ts` — `classifySingleSource`, `classifyOutcome` and their call sites
- `src/findings/cycle-types.ts` — `IterationOutcome`
- `src/findings/types.ts` — `findingRecurrenceKey`
- `src/findings/index.ts` — the `classifyOutcome` / `IterationOutcome` exports
- `src/plugins/builtin/curator/types.ts` — the inline outcome union
- `src/execution/oscillation-breaker.ts` — the reason string
- `src/execution/oscillation-store.ts` — `countOscillationOutcomes`
- `src/execution/post-run.ts` — the comment describing the oscillation count

**US-004**

- `src/runtime/spin-breaker/index.ts` — settings, `createSpinBreaker`, `stopOrNudge`, `buildNudge`, `observe`
- `src/session/spin-breaker-selection.ts` — `selectSpinBreakerSettings`
- `src/config/schemas-infra.ts` — `AgentSpinBreakerConfigSchema`, the idle-watchdog schema
- `src/config/runtime-types-agent.ts` — `AgentSpinBreakerConfig`
- `src/agents/native/session/turn-result.ts` — how `spinStopped` reaches `fail-spin`

**US-005**

- `src/interaction/ask-link.ts` — `createHumanAskLink`
- `src/interaction/dispatch-ask.ts` — `DispatchAskOptions`, `buildDispatchAskWiring`, `buildRunDispatchAskWiring`
- `src/interaction/types.ts` — `InteractionStage`
- `src/execution/lifecycle/acceptance-fix-scope.ts` — its `buildRunDispatchAskWiring` call
- `src/execution/lifecycle/run-regression.ts` — its `buildRunDispatchAskWiring` call
- `src/finish/phase.ts` — its `buildRunDispatchAskWiring` call
- `src/prompts/builders/timeout-retry-builder.ts` — `timeoutRetry`, `invalidToolCallRetry`
- `src/agents/retry/failure-policy.ts` — the `fail-spin` / `fail-incomplete` lane entries
- `src/execution/runner.ts` — `_runnerDeps`, the `runCompletionPhase` call
- `test/unit/execution/runner-total.test.ts` — the existing `runCompletionPhase` mock to follow

### Creates

**US-001**

- `test/unit/config/removed-gate-llm-knob.test.ts` — warning, strip and schema behaviour for the retired key

**US-002**

- `src/operations/gate-cwd.ts` — `resolveGateCwd`, `GateCwdInput`, `GateCwd`, `GateCommandProvenance`
- `test/unit/operations/gate-cwd.test.ts` — the provenance rule
- `test/unit/operations/gate-cwd-wiring.test.ts` — each gate spawns in the resolved cwd
- `test/unit/runtime/packages-overlay.test.ts` — `PackageView.overlay` hydration

**US-003**

- `src/findings/classify-outcome.ts` — `classifyOutcome`, `classifySingleSource`
- `test/unit/findings/classify-outcome-rotated.test.ts` — the `rotated` outcome and precedence

**US-004**

- `test/unit/runtime/spin-breaker-time-axis.test.ts` — the time axis and the per-episode nudge budget

**US-005**

- `test/unit/interaction/ask-link-stage.test.ts` — stage threading through the ask link and dispatch wiring
- `test/unit/prompts/builders/timeout-retry-spin-incomplete.test.ts` — the new retry wording

### Modifies

**US-001**

- `test/unit/config/semantic-review.test.ts` — the assertions that `gateLLMChecksOnMechanicalPass` parses and round-trips are deleted with the key.

**US-002**

- `test/unit/operations/lint-check.test.ts` — the "per-package override exists" routing test must give its `packageView` an `overlay` defining `quality.commands.lint`; the no-override test is unchanged.
- `test/unit/operations/typecheck-check.test.ts` — the "per-package override exists" routing test must give its `packageView` an `overlay` defining `quality.commands.typecheck`.
- `test/unit/operations/verify-scoped.test.ts` — the "per-package override exists" routing test must give its `packageView` an `overlay` defining `quality.commands.test`.
- `test/unit/operations/full-suite-gate.test.ts` — fixtures that build a `packageView` with `hasOverride: true` and expect the package dir must also carry an `overlay` defining the test command.

**US-003**

- `test/unit/execution/oscillation-breaker.test.ts` — a reason-text assertion naming `regressed-different-source` (if any) is updated to the new wording; the count and case-insensitive "oscillat" substring assertions are unchanged.

**US-004**

- `test/unit/session/spin-breaker-selection.test.ts` — an exact-equality assertion over the resolved settings gains `stopAfterNoProgressSeconds`.
- `test/unit/runtime/spin-breaker.test.ts` — an exact-equality assertion over `DEFAULT_SPIN_BREAKER_SETTINGS` or a settings fixture gains `stopAfterNoProgressSeconds`; the laundering test's `stoppedAt` (28) and `nudges` (3) expectations are unchanged.

**US-005**

- `test/unit/interaction/dispatch-ask.test.ts` — an exact-equality assertion over the options passed to `createHumanAskLink` may gain `stage` only where the test passes one.
- `test/unit/execution/runner-total.test.ts` — gains the interaction-chain threading test (278 lines; stays under 800).

`test/unit/findings/cycle.test.ts` (933 lines) is on the file-size baseline and must not grow; new
`classifyOutcome` tests go in the created file. `src/session/manager.ts` (baseline 679) must not
change.

### Seams

- `[unit]` US-002: `lintCheckOp` run against a `packageView` whose `overlay` defines only `quality.commands.test`, with root `quality.commands.lint` configured, spawns the lint command with cwd equal to `repoRoot` — the gate reaches `resolveGateCwd`'s `root` arm through its real call site.
- `[unit]` US-004: `selectSpinBreakerSettings` output passed to `createSpinBreaker` with an injected clock produces a `no-progress-time` stop — the resolved default reaches the breaker.
- `[unit]` US-005: `buildDispatchAskWiring` called with `stage: "review"` and a recording `deps.createHumanAskLink` passes `stage: "review"` to it.

## Acceptance Criteria

### US-001 — Retire the inert `review.gateLLMChecksOnMechanicalPass` knob (#2174)

- `[unit]` `stripRemovedNoOpKeys({ review: { gateLLMChecksOnMechanicalPass: false, enabled: true } }, warn)` returns an object whose `review` has no `gateLLMChecksOnMechanicalPass` key (checked with `in`) and still has `enabled: true`.
- `[unit]` that same call invokes `warn` exactly once, with a message containing `review.gateLLMChecksOnMechanicalPass` and `has been removed`.
- `[unit]` `stripRemovedNoOpKeys` does not mutate its input: the object passed in still has `review.gateLLMChecksOnMechanicalPass === false` afterwards.
- `[unit]` `NaxConfigSchema.parse` of a config with `review: {}` yields a `review` that has no `gateLLMChecksOnMechanicalPass` key (checked with `in`).
- `[unit]` loading a project whose `.nax/config.json` sets `review.gateLLMChecksOnMechanicalPass: true` through the config loader succeeds, and the loaded config's `review` has no `gateLLMChecksOnMechanicalPass` key.

**Out of scope:** implementing the gate in the story orchestrator (issue Option B).

### US-002 — Quality gates choose cwd from command provenance (#2182)

- `[unit]` `resolveGateCwd({ commandName: "lint", detected: false, packageView: { overlay: { quality: { commands: { test: "bun test" } } }, repoRoot: "/r" }, workdir: "/r/packages/lib" })` returns `{ cwd: "/r", provenance: "root" }`.
- `[unit]` `resolveGateCwd` with `commandName: "lint"` and an `overlay` whose `quality.commands.lint` is `"eslint ."` returns `{ cwd: "/r/packages/lib", provenance: "overlay" }`.
- `[unit]` `resolveGateCwd` with `commandName: "test"` and an `overlay` defining only `review.commands.test` returns `provenance: "overlay"` and the package workdir.
- `[unit]` `resolveGateCwd` with no `overlay` and `detected: true` returns `{ cwd: "/r/packages/app", provenance: "detected" }` for workdir `/r/packages/app`.
- `[unit]` `resolveGateCwd` with no `overlay` and `detected: false` returns `{ cwd: "/r", provenance: "root" }`.
- `[unit]` `resolveGateCwd` with an `overlay` that is `{}` and `detected: false` returns `provenance: "root"`.
- `[unit]` a registry created from `src/runtime/packages.ts` whose `hydrate(["packages/lib"], loader)` loader returns `{ quality: { commands: { test: "bun test" } } }` resolves `packages/lib` to a view whose `overlay` deep-equals that object and whose `hasOverride` is `true`.
- `[unit]` a registry hydrated with a loader returning `null` for `packages/app` resolves it to a view with no `overlay` key (checked with `in`) and `hasOverride` `false`.
- `[unit]` `lintCheckOp` with a `packageView` whose `overlay` defines only `quality.commands.test`, root-configured `quality.commands.lint`, `repoRoot` `/r` and `input.workdir` `/r/packages/lib` runs the lint command with cwd `/r`.
- `[unit]` `lintCheckOp` with a `packageView` whose `overlay` defines `quality.commands.lint` runs it with cwd equal to `input.workdir`.
- `[unit]` `typecheckCheckOp` with a `packageView` whose `overlay` defines only `quality.commands.test` and root-configured `quality.commands.typecheck` runs typecheck with cwd equal to `repoRoot`.
- `[unit]` `verifyScopedOp` with a `packageView` whose `overlay` defines only `quality.commands.lint` and root-configured `quality.commands.test` runs the scoped tests with cwd equal to `repoRoot`, and its `"Running scoped tests"` log data carries `provenance: "root"`.
- `[unit]` the real `_fullSuiteGateDeps.resolveGateContext` (not stubbed) for a `packageView` whose `overlay` defines only `quality.commands.lint` and root-configured `quality.commands.test` returns `cmdWorkdir` equal to `repoRoot` and `cmdProvenance` `"root"`.
- `[unit]` the real `_fullSuiteGateDeps.resolveGateContext` for a `packageView` whose `overlay` defines `quality.commands.test` returns `cmdWorkdir` equal to `input.workdir` and `cmdProvenance` `"overlay"`.

**Out of scope:** removing `hasOverride`.

### US-003 — `rotated` iteration outcome and honest oscillation reason (#2154)

- `[unit]` `classifyOutcome` imported from `src/findings/classify-outcome.ts`, given before = four findings (`semantic` at lines 114, 114 with a different `rule`, 121, and `adversarial` at 108) and after = two `semantic` findings at lines 96 and 76, returns `"rotated"`.
- `[unit]` `classifyOutcome` given before = one `semantic` finding at `a.ts:10` and after = one `semantic` finding at `a.ts:20` returns `"rotated"`.
- `[unit]` `classifyOutcome` given before = `semantic` at `a.ts:10` and `a.ts:20`, after = `semantic` at `a.ts:20` and `a.ts:30` returns `"regressed"` (one key persisted).
- `[unit]` `classifyOutcome` given before = `semantic` at `a.ts:10` and after = `adversarial` at `a.ts:10` returns `"regressed-different-source"` (the new-source check takes precedence over `rotated`).
- `[unit]` `classifyOutcome` given before and after = one `semantic` finding with the same file, line and rule but a different `message` returns `"unchanged"` (nax#1581 preserved).
- `[unit]` `classifyOutcome` given an empty before and one after finding returns `"regressed"`; given both empty returns `"resolved"`.
- `[unit]` `classifyOutcome` imported from `src/findings/cycle.ts` and from `src/findings` returns the same result as the `classify-outcome.ts` export for the four-to-two rotation case.
- `[unit]` the oscillation breaker, when it trips with a recorded count of 2 and `maxOscillations` 2, returns a reason containing `2 resolved finding sources reappeared` and not containing `regressed-different-source`.

**Out of scope:** feeding `rotated` into the oscillation count.

### US-004 — Spin breaker stops slow spins by time and restores its nudge budget (#2017)

- `[unit]` a breaker from `createSpinBreaker({ ...DEFAULT_SPIN_BREAKER_SETTINGS, stopAfterNoProgressSeconds: 900 }, { now })`, observing call `A` at `now` = 0 and then `A` eight more times at `now` = 1,000,000 ms without `noteResult`, returns `allow` for repeats 1-4, `nudge` for repeats 5, 6 and 7, and `stop` with reason `"no-progress-time"` on repeat 8.
- `[unit]` the same breaker observing `A` then eight repeats of `A` at `now` = 899,000 ms returns no `stop` and no `nudge` (below the time limit, below `nudgeAfterRepeats`).
- `[unit]` a breaker observing `A` at 0, repeats of `A` at 1,000,000 ms interleaved with a new call key `B` at 1,000,000 ms after the third repeat, returns no `no-progress-time` verdict within four more repeats of `A` (the new key reset the clock and the repeat count).
- `[unit]` a breaker with `stopAfterNoProgressSeconds: 0` observing `A` then 20 repeats at 10,000,000 ms returns no `nudge` or `stop` (time axis disabled; below the repeat thresholds).
- `[unit]` `selectSpinBreakerSettings({ agent: { idleWatchdog: { toolCallOnlyIdleTimeoutSeconds: 1200 } } })` returns `stopAfterNoProgressSeconds: 600`.
- `[unit]` `selectSpinBreakerSettings` with `agent.spinBreaker.stopAfterNoProgressSeconds: 300` and a watchdog of 1200 returns `300`.
- `[unit]` `selectSpinBreakerSettings` with the idle watchdog `mode: "off"` and no configured value returns `900`; with `undefined` config it returns `900`.
- `[unit]` the settings returned by `selectSpinBreakerSettings({ agent: { idleWatchdog: { toolCallOnlyIdleTimeoutSeconds: 1200 } } })`, passed to `createSpinBreaker` with an injected clock, stop call `A`'s repeat run with reason `"no-progress-time"` when the repeats are observed at 601,000 ms.
- `[unit]` `AgentSpinBreakerConfigSchema` rejects `stopAfterNoProgressSeconds: -1` and accepts `0`.
- `[unit]` the laundering loop `[A, B, A, B, ...]` with `noteResult(..., "identical")` after each call still stops at call 28 with `summary().nudges` equal to 3 (unchanged).
- `[unit]` a loop repeating call `A` with `noteResult(..., "identical")` and a never-before-seen key between every two `A` calls still ends with a `stop` whose reason is `"same-key-cumulative"`, and `summary().nudges` is 3 at that stop (a fresh interleaved key does not restore the budget).
- `[unit]` a breaker that spends all 3 nudges on a repeat run of `A` (repeats 25 through 27 at the default nudge points), then observes 25 distinct new keys, then repeats one of those keys 25 times, returns a `nudge` verdict with `nudgeNumber` 1 on that second run, and `summary().nudges` is 4.
- `[unit]` after a real `stop`, the next repeat run of a different key reaching `nudgeAfterRepeats` returns a `nudge` (not a `stop`).

**Out of scope:** relabelling watchdog cancels in `src/session/watchdog-turn-classification.ts`.

### US-005 — Post-run approval stage, honest retry wording, runner chain test (#2213)

- `[unit]` `createHumanAskLink({ chain, timeoutMs: 1000, stage: "review" })` with a recording `chain.prompt` sends a request whose `stage` is `"review"`.
- `[unit]` `createHumanAskLink({ chain, timeoutMs: 1000 })` (no `stage`) sends a request whose `stage` is `"execution"`.
- `[unit]` `buildDispatchAskWiring` called with `stage: "merge"` and a recording `deps.createHumanAskLink` passes `stage: "merge"` to it; called without `stage`, it passes no `stage` key.
- `[unit]` `buildRunDispatchAskWiring` called with `stage: "review"` passes `stage: "review"` through to `deps.createHumanAskLink`.
- `[unit]` the acceptance-fix scope, run with a recording `_acceptanceFixScopeDeps.buildRunDispatchAskWiring`, calls it with `stage: "review"`.
- `[unit]` the deferred regression gate, run with a recording `_regressionDeps.buildRunDispatchAskWiring`, calls it with `stage: "review"`.
- `[unit]` the finish phase, run with a recording `_finishPhaseDeps.buildRunDispatchAskWiring`, calls it with `stage: "merge"`.
- `[unit]` `timeoutRetry` with `failure.outcome` `"fail-spin"`, `changedFiles` `["src/a.ts"]`, `attempt` 1 and prompt `P` returns text that contains `kept repeating the same tool calls`, `This was not a timeout. This is attempt 2 of the same story.`, `- src/a.ts` and `P`, and does not contain `hit a timeout`.
- `[unit]` `timeoutRetry` with `failure.outcome` `"fail-incomplete"` and empty `changedFiles` returns text that contains `ended its turn before finishing the story`, `This was not a timeout.` and `The previous attempt left no file changes on disk.`, and does not contain `hit a timeout`.
- `[unit]` `timeoutRetry` with `failure.outcome` `"fail-timeout"` and with no `failure` returns text that still starts with `The previous attempt hit a timeout after`.
- `[unit]` `run` from `src/execution/runner.ts`, given an interaction chain object `C` and a recording `_runnerDeps.runCompletionPhase`, calls `runCompletionPhase` with an options object whose `interactionChain` is `C` (same reference, `toBe`).

**Out of scope:** extending `InteractionStage`.
