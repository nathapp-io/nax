# Bake-off `--compare`: profile contestants

**Date:** 2026-08-16
**Status:** Design approved, not implemented
**Supersedes:** the contestant/coordinator seams shipped in PR #1302

## Problem

`nax run --compare` has never produced a real result. It shipped in PR #1302 on 2026-07-04 and has reported `dnf-crashed` for every contestant on every invocation since.

The cause is two lines:

```ts
export const _contestantDeps: ContestantRunnerDeps = {
  worktreeManager: undefined as unknown as ContestantRunnerDeps["worktreeManager"],
  pipeline: undefined as unknown as ContestantRunnerDeps["pipeline"],
};
```

Nothing ever assigns them. `runContestant` calls `deps.worktreeManager.create(...)`, gets a `TypeError` on `undefined`, and its own catch reports `dnf-crashed`. Two `as unknown as` casts converted a missing dependency into a runtime failure that the code then swallowed as a legitimate contestant outcome.

Six test files (~58KB) cover this subsystem and all pass, because each test overwrites the production defaults before reading them:

```ts
Object.assign(_contestantDeps, overrides);   // shared mutable default
```

The tests validate the algorithm and are structurally blind to the wiring.

## What a spike established

A throwaway spike (reverted; nothing kept) wired the deps and ran the real path.

**The chain works.** Wiring only `worktreeManager` — four lines, because `WorktreeManager.create/remove(projectRoot, storyId)` already matches the declared dep signature exactly — carried execution through worktree creation, the pipeline call, aggregation, ranking, `bakeoff.json`, report rendering, and exit code.

**`run()` executes correctly inside a worktree.** A clean single-contestant run completed end to end:

```
Path:  .../.nax-wt/bakeoff-contestant-claude
Total: 1   Passed: 1   Success: 100.0%
claude => passed
```

There is no structural incompatibility. The remaining work is an interface change and three correctness fixes, not a subsystem build.

**Findings that changed the design:**

| # | Finding |
|:--|:--|
| 1 | The `pipeline` dep signature `(config: NaxConfig) => …` cannot carry per-contestant state. Smuggling it through a global made contestant #2 run inside contestant #1's worktree. |
| 2 | `RunResult` (`{success, iterations, storiesCompleted, totalCost, durationMs}`) does not satisfy `ContestantPipelineResult`, which wants per-story `results[]` and `metrics[]`. The original design targeted `executeParallel`/`StoryMetrics`, not `run()`. |
| 3 | The worktree is a fresh checkout, so an uncommitted PRD is invisible inside it (`PRD file not found`). |
| 4 | A `SIGKILL` mid-run leaves a branch with no worktree record, which `create()` deliberately refuses to reclaim (see Section 3). |
| 5 | `projectKey = config.name?.trim() \|\| basename(workdir)`, so contestants isolate **by accident** — writing to `~/.nax/bakeoff-contestant-<x>/`, outside the project root. With `config.name` set, they collide instead. |
| 6 | `--dry-run` is **not free**: it spent $0.2736, because `routing.strategy: llm` classifies before the dry-run short-circuit in `iteration-runner.ts:65`. |

## Design

### 1. Profiles as contestants

`--compare` takes **profile names**, not agent names:

```
nax run --compare cross-agent-pi,cross-agent-mm -f <feature>
```

A profile bundles agent, per-tier models, and arbitrary config — which is what a comparison actually wants to vary. `runContestant` deep-merges the profile overlay into the base config exactly as `loader.ts` does for `--profile`, rather than only pinning `agent.default`. Preflight validates via profile resolution; `loadProfile` already throws `PROFILE_NOT_FOUND` with an "Available: …" list.

**Rejected — accepting either an agent or a profile name.** Profile names already collide with agent names: `~/.nax/profiles/opencode.json` and `.nax/profiles/codex.json` both exist. Any disambiguation rule silently produces a different comparison than intended.

**Rejected — a separate `--compare-profiles` flag.** Two flags for one concept, and the surviving one is the form that never worked.

Replacing the flag's meaning is acceptable precisely because it has never produced a working result.

**Invariant:** `agent.fallback.enabled` is forced to `false` *after* the profile merge, overriding whatever the profile sets. A profile permitting fallback could let contestant A execute as contestant B's agent, silently destroying the comparison.

### 2. The pipeline seam

```ts
/** Everything a contestant's run needs that varies per contestant. */
export interface ContestantRunContext {
  /** Profile name — also the contestant's label in the report. */
  profile: string;
  /** Base config + profile overlay, with fallback hard-pinned off. */
  config: NaxConfig;
  /** This contestant's worktree — becomes the run's workdir. */
  worktree: string;
  /** This contestant's isolated output root. */
  outputDir: string;
  feature: string;
}

pipeline: (ctx: ContestantRunContext) => Promise<ContestantPipelineResult>;
```

The adapter lives in a new `src/bakeoff/pipeline-adapter.ts`, keeping `contestant.ts` free of `src/execution` and cheap to test. It calls `run()` with `workdir: ctx.worktree`, `prdPath`/`featureDir` resolved inside the worktree, and `statusFile` under `ctx.outputDir`; `RunResult` supplies pass/fail and totals, and `loadRunMetrics(ctx.outputDir)` supplies the per-story `metrics[]` that `aggregateTotals` consumes.

**`deps` becomes a required parameter of `runContestant`.** The mutable module-level `_contestantDeps` is deleted. The coordinator passes real deps; tests pass fakes. A missing wiring becomes a `tsc` error rather than a runtime `dnf-crashed`, and the shared mutable state between tests disappears. This makes the defect class that shipped **unrepresentable** rather than merely tested.

### 3. Output scoping

`RunOptions` does not accept an output dir — the runtime derives it:

```ts
const projectKey = config.name?.trim() || basename(workdir);
const outputDir = projectOutputDir(projectKey, config.outputDir);
```

`projectOutputDir` honours an absolute `config.outputDir` override, so setting it on the per-contestant merged config redirects metrics, cost, status, runs, and prompt-audit in one move, with no change to `run()` or the runtime:

```ts
const contestantRoot = join(
  projectOutputDir(projectKey, baseConfig.outputDir),   // the project's real root
  "bakeoff", feature, profile,
);
```

This makes isolation deliberate rather than dependent on whether `config.name` is set, keeps artifacts inside the project's output root where they are discoverable and cleanable, and makes `loadRunMetrics(contestantRoot)` return exactly one contestant's runs.

Never hardcode a path: `globalConfigDir()` is redirected under test by `test/preload.ts`, enforced by `check-no-real-global-nax`.

`persistBakeoffResult` moves from `join(outputDir, "bakeoff.json")` to `bakeoff/<feature>/bakeoff.json`, so comparing a second feature no longer overwrites the first result. This changes existing behaviour and its test.

`profile` is safe as a path segment for free — `validateProfileName` already rejects `/`, `\`, NUL, `.`, and `..`.

### 4. Worktree lifecycle and preflight

**`create()` is not at fault.** It already runs a three-step reclaim — prune, `worktree remove --force`, then `branch -D` — with the last step gated by BUG-28:

```ts
const hadWorktreeRecord = await this.hasWorktreeRecord(projectRoot, branchName);
...
if (!removedLiveWorktree && hadWorktreeRecord) { /* git branch -D */ }
```

It force-deletes a leftover branch only when a worktree record proves nax created it, so it cannot destroy an unmerged user branch sharing the name. A `SIGKILL` can leave a branch *without* that record, at which point `create()` correctly refuses and fails. That guard stays untouched.

**A reserved namespace instead.** Contestant worktrees take a `bakeoff-` prefixed id, making `nax/bakeoff-…` definitionally nax-created. A bake-off-scoped preflight reclaims stale branches matching only that prefix, so the blast radius is the bake-off's own namespace.

**Id construction.** `validateStoryId` enforces `/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/` — 64 chars, no slashes. Profile names are path-safe but not necessarily id-safe, and `bakeoff-<feature>-<profile>` can overflow. The id sanitizes both segments to the allowed set and, on overflow, truncates with a short stable hash suffix to keep contestants distinct.

**Uncommitted-PRD preflight.** Before any worktree is created, verify `.nax/features/<feature>/prd.json` is both (a) tracked by git and (b) free of uncommitted modifications — either condition failing means the worktree would see a different PRD than the one on disk. Fail with a message naming the file and the required action.

Copying the PRD into the worktree was rejected: it makes the worktree diverge from the branch under test, so any story touching other feature files sees inconsistent state.

Both checks live in `preflight.ts` beside `validateContestants`.

A `SIGKILL` can always orphan a worktree. The `finally` in `runContestant` handles ordinary failure; the namespace reclaim handles what the `finally` never ran for. The design assumes reclaim rather than prevention.

### 5. Testing

Making `deps` required (Section 2) removes the `withDeps` shared-mutable pattern and the defect class it hid. On top of that:

- **Unit** — profile merge precedence; the `fallback.enabled = false` pin surviving a profile that enables it; per-contestant `outputDir` computation; worktree-id sanitization and the 64-char truncation path; `RunResult` + `metrics.json` → `ContestantPipelineResult` mapping.
- **Preflight** — profile resolution against a temp project; uncommitted-PRD rejection; stale-branch reclaim in a temp git repo. Note `git add -- <file>` when staging fixtures: an all-new directory is reported by `git status --porcelain` as a single `?? dir/` entry, and `--` stops git treating a name like `src/[id]/x.ts` as a pathspec.
- **Integration, no agents** — a real `WorktreeManager` against a temp repo with the pipeline dep stubbed to record what it received, asserting the contestant gets its own worktree path, own output root, and correctly merged config. This is the test that would have caught the original bug.
- **Composition** — that `handleRunAction → runBakeoff → runContestant` reaches a real pipeline adapter, not a fake.

No agent spend is required: `run()` is injectable at the adapter boundary and `loadRunMetrics` reads a fixture.

For a manual end-to-end check, `--dry-run` alone is not free (finding 6). A cheap smoke run needs `routing.strategy: "keywords"` alongside it — which a dedicated bake-off smoke profile can set.

## Out of scope

- Keeping or merging a winner's work. The bake-off stays report-only, as decided in the original arc.
- Parallel contestants. Sequential execution is retained so one crash cannot block the rest, and so wall-time stays comparable.
- Changing `WorktreeManager`'s BUG-28 guard.
- Making `--dry-run` free. Finding 6 is a real defect in its own right but is tracked separately, not fixed here.

## Sequencing

Sections 2 and 3 must land together. Section 2 alone makes `--compare` execute while contestants still write to accidental, project-external output roots — a benchmark that runs and produces untrustworthy numbers. This subsystem already shipped once in a state that never ran; shipping it in a state that runs and lies would be worse.
