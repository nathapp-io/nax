# SPEC: Bake-off `--compare` with profile contestants

<!-- spec-writing: completed-through-phase-5 -->

## Summary

`nax run --compare` runs one feature across several contestants in isolated worktrees and emits a ranked comparison. It has never produced a real result: since PR #1302 it has reported `dnf-crashed` for every contestant on every invocation. This spec makes it execute, and changes what a contestant *is* — a **profile name** rather than an agent name, so a comparison can vary agent, per-tier models, and any other config together.

## Motivation

Two module-level dependencies are declared and never assigned:

```ts
export const _contestantDeps: ContestantRunnerDeps = {
  worktreeManager: undefined as unknown as ContestantRunnerDeps["worktreeManager"],
  pipeline: undefined as unknown as ContestantRunnerDeps["pipeline"],
};
```

`runContestant` calls `deps.worktreeManager.create(...)`, gets a `TypeError` on `undefined`, and its own `catch` reports that as `dnf-crashed` — a legitimate-looking contestant outcome. Two `as unknown as` casts turned a missing dependency into a swallowed runtime failure.

Six test files cover this subsystem and all pass, because each test overwrites the production defaults before reading them (`Object.assign(_contestantDeps, overrides)`). The suite validates the algorithm and is structurally blind to the wiring.

A throwaway spike established the rest of the chain is sound: wiring only `worktreeManager` reached aggregation, ranking, `bakeoff.json`, report rendering, and the exit code, and a single-contestant run completed end to end inside a worktree. The remaining work is one interface change plus three correctness fixes.

Comparing agent names is also the wrong axis. A profile already bundles agent, per-tier models, and arbitrary config overrides — which is what a comparison wants to vary.

## Design

### Approach

Contestants are **profile names**. `--compare cross-agent-pi,cross-agent-mm` resolves each name through the existing profile loader and deep-merges its overlay onto the base config, the same layering `src/config/loader.ts` applies for `--profile`.

Accepting *either* an agent name or a profile name was rejected: profile names already collide with agent names (`~/.nax/profiles/opencode.json` and `.nax/profiles/codex.json` both exist), so any disambiguation rule silently produces a different comparison than intended. A separate `--compare-profiles` flag was rejected as two flags for one concept.

Per-contestant isolation is achieved by setting `outputDir` on each contestant's merged config. `RunOptions` has no output-dir field — the runtime derives it — so this is the only seam, and it redirects metrics, cost, status, runs, and prompt-audit together.

### Integration

Verified against the current tree:

- `src/bakeoff/preflight.ts` — `validateContestants(names, deps)` returns `{ errors, validAgents }`; `ContestantValidationReason` is currently `"unknown-agent" | "no-acp-adapter" | "dnf-not-installed"`. `_preflightDeps.isInstalled` resolves an agent's launch binary via `new AcpAgentAdapter(agentName).binary`; `_preflightDeps.hasAcpAdapterEntry` consults `ACP_ADAPTER_NAMES`.
- `src/bakeoff/contestant.ts` — `runContestant(agent, options, deps)` returns `ContestantResult`; `ContestantRunnerDeps.pipeline` is currently `(config: NaxConfig) => Promise<ContestantPipelineResult>`; `aggregateTotals` sums `cost`, `durationMs`, `attempts` across `ContestantStoryMetric[]`.
- `src/bakeoff/coordinator.ts` — `runBakeoff(options, deps)`; `persistBakeoffResult(result, outputDir)` writes `join(outputDir, "bakeoff.json")`; `handleRunAction(options, deps)` is the CLI dispatch that routes on `options.compare`.
- `src/config/profile.ts` — `loadProfile(profileName, projectRoot)` deep-merges global then project profile JSON and throws `NaxError` code `PROFILE_NOT_FOUND` (message lists available names) or `PROFILE_NAME_INVALID`. **`validateProfileName` is module-private** — its path-segment guarantees are reachable only through `loadProfile`'s throw, not by direct call.
- `src/config/merger.ts` — `deepMergeConfig(base, override)`.
- `src/worktree/manager.ts` — `WorktreeManager.create(projectRoot, storyId)` / `remove(projectRoot, storyId)`; worktree path is `join(projectRoot, ".nax-wt", storyId)`, branch is `nax/${storyId}`. `create` already prunes, force-removes, and force-deletes a leftover branch, but the branch delete is gated on `hasWorktreeRecord` proving nax created it.
- `src/prd/validate.ts` — `validateStoryId(id)` enforces `/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/`.
- `src/execution/runner.ts` — `run(options: RunOptions): Promise<RunResult>`; `RunResult` is `{ success, iterations, storiesCompleted, totalCost, durationMs }`. `RunOptions` carries `prdPath`, `workdir`, `config`, `hooks`, `feature`, `featureDir`, `dryRun`, `statusFile` and **no** output-dir field.
- `src/metrics/tracker.ts` — `loadRunMetrics(outputDir)` reads `join(outputDir, "metrics.json")`.
- `src/runtime/paths.ts` — `projectOutputDir(projectKey, outputDirOverride)` returns `join(globalConfigDir(), projectKey)` when no override, honours an absolute override, and throws `CONFIG_INVALID` otherwise. `src/runtime/index.ts` computes `projectKey = config.name?.trim() || basename(workdir)`.

Patterns to follow: `_preflightDeps` / `_coordinatorDeps` injectable-deps shape already used across `src/bakeoff/`; `NaxError` with a stable code and `{ stage }` context per `.nax/rules/error-handling.md`.

### Contestant run context

The dependency that cannot carry per-contestant state is replaced:

```ts
export interface ContestantRunContext {
  /** Profile name — also the contestant's label in the report. */
  profile: string;
  /** Base config + profile overlay, with fallback pinned off and outputDir set. */
  config: NaxConfig;
  /** This contestant's worktree — becomes the run's workdir. */
  worktree: string;
  /** This contestant's isolated output root. */
  outputDir: string;
  feature: string;
}

pipeline: (ctx: ContestantRunContext) => Promise<ContestantPipelineResult>;
```

`deps` becomes a **required** parameter of `runContestant`; the mutable `_contestantDeps` default is deleted. A missing wiring then fails the build rather than surfacing as a contestant outcome.

### Output scoping

```
<projectOutputDir(projectKey, baseConfig.outputDir)>/bakeoff/<feature>/<profile>
```

That path is set as `outputDir` on the contestant's merged config, and `bakeoff.json` moves alongside the contestant directories at `bakeoff/<feature>/bakeoff.json`. Paths are always derived from `projectOutputDir` — never hardcoded, because `globalConfigDir()` is redirected under test by `test/preload.ts` and `check-no-real-global-nax` enforces it.

### Worktree identity

Contestant worktree ids carry a `bakeoff-` prefix, making `nax/bakeoff-…` a namespace no user branch occupies. Ids are derived from feature and profile, reduced to the character set `validateStoryId` accepts, and truncated to at most 64 characters with a stable distinguishing suffix when the natural id would overflow.

### CLI Behavior

- `nax run --compare <profiles> -f <feature>` — comma-separated profile names.
- `--compare` and `--agent` remain mutually exclusive (`assertCompareAgentExclusive`, `COMPARE_AGENT_EXCLUSIVE`).
- Exit `0` when at least one contestant finished (status `passed` or `failed`); exit `1` when every contestant is a non-finisher.
- The ranked table is written to stdout; validation errors and preflight rejections are reported through the logger.

### Failure Handling

- Profile name that does not resolve → that contestant is rejected in preflight with reason `unknown-profile`; remaining contestants still run.
- Profile whose resolved agent has no ACP adapter → reason `no-acp-adapter`; remaining contestants still run.
- Profile whose resolved agent binary is absent from PATH → reason `dnf-not-installed`; remaining contestants still run.
- Feature `prd.json` untracked or carrying uncommitted modifications → the whole bake-off is rejected before any worktree is created and before any spend.
- Stale `nax/bakeoff-…` branch left by a killed run → reclaimed during preflight so worktree creation succeeds.
- Branch outside the `nax/bakeoff-` namespace that collides → left untouched; worktree creation fails and that contestant is reported `dnf-crashed`.
- Contestant pipeline throws → that contestant is reported `dnf-crashed` and the coordinator continues with the remaining contestants.

## Out of Scope

- Keeping, merging, or applying a winning contestant's work; the bake-off remains report-only.
- Running contestants in parallel; contestants continue to execute sequentially.
- Changing `WorktreeManager`'s `hasWorktreeRecord` branch-reclaim guard.
- Making `nax run --dry-run` free of LLM routing cost.
- Copying an uncommitted PRD into a contestant worktree.
- Accepting bare agent names as contestants; `--compare` accepts profile names only.
- US-002 only: worktree removal failures remain best-effort and do not change the contestant's reported status.
- US-004 only: reclaiming worktree directories left on disk without a matching git branch.

## Stories

1. **US-001: Profile contestants** — no dependencies
2. **US-002: Per-contestant execution context** — depends on US-001
3. **US-003: Pipeline adapter over `run()`** — depends on US-002
4. **US-004: Worktree namespace and preflight guards** — depends on US-001
5. **US-005: Terminal cleanup** — depends on US-002, US-003, US-004

### US-001: Profile contestants

Resolve each `--compare` entry as a profile, validate the profile's resolved agent, and build the contestant's merged config.

#### Context Files
- `src/bakeoff/preflight.ts` — validation shape and injectable deps to extend
- `src/config/profile.ts` — `loadProfile` behaviour and its error codes
- `src/config/loader.ts` — how a profile overlay is layered onto base config
- `src/config/merger.ts` — `deepMergeConfig` semantics

#### Modifies

**US-001**
- `test/unit/bakeoff/preflight.test.ts` — asserts `result.errors[0].reason` is `"unknown-agent"` for a name absent from `KNOWN_AGENT_NAMES`, and that `validateContestants(["claude","codex"])` yields those names in `validAgents`. Contestants are profiles under this story, so both assertions pin a resolution path that no longer exists. US-001 owns replacing them with the profile equivalents: an unresolvable profile yields reason `"unknown-profile"`, and a resolvable profile name appears in `validAgents`.

### US-002: Per-contestant execution context

Give each contestant its own worktree path, its own output root, and a context object carrying both to the pipeline; relocate the persisted result.

#### Context Files
- `src/bakeoff/contestant.ts` — `runContestant`, `aggregateTotals`, the deps shape being replaced
- `src/bakeoff/coordinator.ts` — `runBakeoff` loop and `persistBakeoffResult`
- `src/runtime/paths.ts` — `projectOutputDir` resolution rules
- `src/worktree/manager.ts` — `create`/`remove` signatures and worktree path layout

#### Modifies

**US-002**
- `test/unit/bakeoff/contestant.test.ts` — its `withDeps` helper mutates the shared `_contestantDeps` object and its stubs implement `pipeline` as `(config) => …`. This story deletes that default and changes the pipeline parameter to a `ContestantRunContext`, so every test in the file fails against a correct implementation. US-002 owns rewriting them to pass deps explicitly into `runContestant` and to assert on the context object's fields.
- `test/unit/bakeoff/coordinator.test.ts` — supplies a `runContestant` dep typed against the old `(agent, options)` shape. US-002 owns updating it to the profile/context shape.
- `test/unit/bakeoff/report.test.ts` — the case named "AC5: writes bakeoff.json under outputDir …" asserts the file lands directly under the passed `outputDir`. This story moves it to `bakeoff/<feature>/bakeoff.json`, so the assertion fails against a correct implementation. US-002 owns updating it to the feature-scoped path.

### US-003: Pipeline adapter over `run()`

Author the adapter that turns a `ContestantRunContext` into a real run and maps the result back.

#### Context Files
- `src/execution/runner.ts` — `RunOptions` and `RunResult` shapes
- `src/metrics/tracker.ts` — `loadRunMetrics` and the metrics file location
- `src/bakeoff/contestant.ts` — created by US-002 in its new form; the context and result types this adapter satisfies
- `src/hooks/runner.ts` — `loadHooksConfig` for the run's hooks argument

#### Creates
- `src/bakeoff/pipeline-adapter.ts` — the `run()` adapter, kept out of `contestant.ts` so that module stays free of `src/execution`

### US-004: Worktree namespace and preflight guards

Derive contestant worktree ids in a reserved namespace, reclaim stale branches within it, and reject a bake-off whose PRD is not committed.

#### Context Files
- `src/prd/validate.ts` — `validateStoryId` character and length rules
- `src/worktree/manager.ts` — the `hasWorktreeRecord` guard and branch naming
- `src/bakeoff/preflight.ts` — where the guards attach
- `src/utils/git.ts` — existing git invocation patterns

### US-005: Terminal cleanup

Deletion-only. Remove the `_contestantDeps` module-level default, the agent-name validation surface superseded by profile resolution, and the superseded `pipeline` signature type. No new code.

Verification note: removals are verified by the build/static gate — `bun run typecheck` and `bun run lint` fail on any surviving reference.

#### Context Files
- `src/bakeoff/contestant.ts` — the default deps object being removed
- `src/bakeoff/preflight.ts` — the superseded agent-name validation path

### Seams

- US-003 → CLI: stub the pipeline adapter, invoke `handleRunAction` with `compare` set, assert the adapter is invoked once per validated contestant (AC-24).
- US-004 → CLI: stub the PRD-tracking guard, invoke `handleRunAction` with `compare` set, assert the guard runs before any contestant executes (AC-34).

## Acceptance Criteria

### US-001: Profile contestants

- AC-1 `[unit]` `validateContestants` returns `validAgents` containing `"cross-agent-pi"` and an empty `errors` array when a profile named `cross-agent-pi` resolves.
- AC-2 `[unit]` `validateContestants` returns a single error whose `reason` is `"unknown-profile"` when the named profile does not resolve.
- AC-3 `[unit]` `validateContestants` omits an unresolvable profile from `validAgents` while retaining the resolvable ones in the same call.
- AC-4 `[unit]` the error reported for an unresolvable profile carries the profile name in its message.
- AC-5 `[unit]` `validateContestants` invokes `loadProfile` once per contestant name with that name as its first argument.
- AC-6 `[unit]` `validateContestants` returns reason `"no-acp-adapter"` when the resolved profile's `agent.default` is absent from the ACP adapter registry.
- AC-7 `[unit]` `validateContestants` returns reason `"dnf-not-installed"` when the resolved profile's agent binary is reported absent from PATH.
- AC-8 `[unit]` the contestant's merged config resolves a key set only by the profile overlay to the profile's value.
- AC-9 `[unit]` the contestant's merged config resolves a key set by both base config and profile overlay to the profile's value.
- AC-10 `[unit]` the contestant's merged config has `agent.default` equal to the profile's `agent.default`.
- AC-11 `[unit]` the contestant's merged config has `agent.fallback.enabled` equal to `false` when the profile overlay sets it to `true`.

### US-002: Per-contestant execution context

- AC-12 `[unit]` `runContestant` invokes the `pipeline` dependency with a context whose `profile` equals the contestant's profile name.
- AC-13 `[unit]` the context's `feature` equals the feature passed to the bake-off.
- AC-14 `[unit]` the context's `worktree` path ends with the contestant's worktree id.
- AC-15 `[unit]` two contestants in one bake-off receive contexts with different `worktree` values.
- AC-16 `[unit]` the context's `outputDir` equals the project output root joined with `bakeoff`, the feature, and the profile name.
- AC-17 `[unit]` two contestants in one bake-off receive contexts with different `outputDir` values.
- AC-18 `[unit]` the context's `config.outputDir` equals the context's `outputDir`.
- AC-19 `[unit]` `runContestant` returns status `"dnf-crashed"` when the `pipeline` dependency rejects.
- AC-20 `[unit]` a bake-off whose first contestant's pipeline rejects still invokes the pipeline for the second contestant.
- AC-21 `[integration]` a two-contestant bake-off creates two distinct worktrees and removes both by the time it returns.
- AC-22 `[unit]` `persistBakeoffResult` writes the result to a `bakeoff.json` nested under `bakeoff` and the feature name within the passed output directory.
- AC-23 `[unit]` persisting results for two different features leaves both features' `bakeoff.json` files readable with their own feature values.

### US-003: Pipeline adapter over `run()`

- AC-24 `[integration]` stub the pipeline adapter; invoke `handleRunAction` with `compare` naming two resolvable profiles; assert the adapter is invoked exactly twice.
- AC-25 `[unit]` the adapter invokes `run` with `workdir` equal to the context's `worktree`.
- AC-26 `[unit]` the adapter invokes `run` with `prdPath` located inside the context's `worktree`.
- AC-27 `[unit]` the adapter invokes `run` with `prdPath` naming the context's feature.
- AC-28 `[unit]` the adapter invokes `run` with `statusFile` located inside the context's `outputDir`.
- AC-29 `[unit]` the adapter invokes `run` with `config` equal to the context's `config`.
- AC-30 `[unit]` the adapter returns a `results` array whose length equals `storiesCompleted` from the run result.
- AC-31 `[unit]` the adapter invokes `loadRunMetrics` with the context's `outputDir`.
- AC-32 `[unit]` the adapter returns one `metrics` entry per story metric reported by `loadRunMetrics`, carrying that metric's cost and duration.
- AC-33 `[unit]` the adapter returns a single `metrics` entry derived from the run result's `totalCost` and `durationMs` when `loadRunMetrics` yields no entries.

### US-004: Worktree namespace and preflight guards

- AC-34 `[integration]` stub the PRD-tracking guard to reject; invoke `handleRunAction` with `compare` set; assert no worktree is created.
- AC-35 `[unit]` the worktree id derived for a feature and profile begins with `bakeoff-`.
- AC-36 `[unit]` the worktree id derived from a profile name containing characters outside the story-id alphabet is accepted by `validateStoryId` without throwing.
- AC-37 `[unit]` the worktree id derived from a feature and profile whose combined length exceeds the story-id limit is at most 64 characters long.
- AC-38 `[unit]` two different feature-and-profile pairs that both exceed the length limit yield different worktree ids.
- AC-39 `[integration]` a leftover branch named `nax/bakeoff-<id>` with no worktree record is removed by the bake-off preflight, and a subsequent worktree creation for that id succeeds.
- AC-40 `[integration]` a branch whose name does not begin with `nax/bakeoff-` still exists after the bake-off preflight runs.
- AC-41 `[unit]` the bake-off is rejected with an error naming the feature's `prd.json` path when that file is untracked by git.
- AC-42 `[unit]` the bake-off is rejected with an error naming the feature's `prd.json` path when that file has uncommitted modifications.
- AC-43 `[unit]` the bake-off rejection for an untracked PRD occurs without invoking the `pipeline` dependency.

**Out of scope:**
- Reclaiming a worktree directory present on disk with no corresponding git branch — the reclaim keys on the branch namespace only.

### US-005: Terminal cleanup

No runtime acceptance criteria — this story only deletes superseded code.

Verification note: `bun run typecheck` and `bun run lint` — both fail on any surviving reference to the removed `_contestantDeps` default, the superseded agent-name validation path, or the old `pipeline` signature type.
