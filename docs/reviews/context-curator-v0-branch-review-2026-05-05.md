# Context Curator v0 Branch Review

**Date:** 2026-05-05  
**Branch:** `feat/context-curator-v0`  
**Base:** `main`  
**Spec:** `docs/specs/2026-05-04-context-curator-v0-design.md` phases 1-7  
**Review mode:** Static code review against the branch diff. Tests were not run.

## Summary

The branch contains a broad Context Curator v0 implementation, including instrumentation, review-decision events, collector, heuristics, renderer, rollup writer, CLI commands, docs, and tests. The main blocking issue is integration: the built-in curator plugin is not actually registered in normal runs, and the runner does not pass the runtime paths/config the curator needs during cleanup. Even if manually registered, the collector currently parses shapes that do not match the existing metrics, review-audit, manifest, and logger JSONL artifacts, so most observations would be missing.

## Findings

### P0: Built-in curator plugin is never registered in real runs

**Files:**

- `src/plugins/loader.ts:98`
- `src/plugins/loader.ts:180`
- `src/plugins/builtin/curator/index.ts:128`

`loadPlugins()` only discovers global, project, and config plugins, then returns a `PluginRegistry` from those loaded plugins. I did not find any production import or registration of `curatorPlugin`; the only registration-like usage is in tests that manually instantiate `new PluginRegistry([curatorPlugin])`.

**Impact:**

`nax-curator` will not appear in `pluginRegistry.getPostRunActions()` by default. As a result, the post-run curator never runs, so phases 1-5 do not produce `observations.jsonl`, `curator-proposals.md`, or rollup rows.

**Suggested fix:**

Add a built-in plugin registration path in the loader or registry. It should include `curatorPlugin` by default unless `config.disabledPlugins` contains `"nax-curator"`. Add an integration test that calls the same `loadPlugins()` path used by `runSetupPhase()` and asserts `getPostRunActions()` includes `nax-curator`.

### P0: Runner does not pass curator runtime context into cleanup

**Files:**

- `src/execution/runner.ts:279`
- `src/execution/lifecycle/run-cleanup.ts:43`
- `src/plugins/builtin/curator/index.ts:88`

`RunCleanupOptions` and `PostRunContext` were extended with `outputDir`, `globalDir`, `projectKey`, `curatorRollupPath`, `logFilePath`, and `config`, but `runner.ts` does not pass those fields into `cleanupRun()`.

`curatorAction.execute()` then casts the context to `CuratorPostRunContext`, calls the collector, and only writes outputs inside `if (context.outputDir)`. In the real runner path, `context.outputDir` is undefined, so no files are written.

**Impact:**

Even if `nax-curator` is registered, normal runs silently skip all curator side effects. The action can still return success with a collected count, making this failure easy to miss.

**Suggested fix:**

Pass the active runtime fields from `runner.ts` into `cleanupRun()`:

```ts
await cleanupRun({
  ...,
  outputDir: runtime.outputDir,
  globalDir: runtime.globalDir,
  projectKey: runtime.projectKey,
  curatorRollupPath: runtime.curatorRollupPath,
  logFilePath,
  config,
});
```

Then add a runner/cleanup integration test that executes a post-run action through `cleanupRun()` with real runtime-like fields and verifies the curator receives them.

### P1: Collector does not match existing artifact and logger schemas

**Files:**

- `src/plugins/builtin/curator/collect.ts:53`
- `src/plugins/builtin/curator/collect.ts:97`
- `src/plugins/builtin/curator/collect.ts:145`
- `src/plugins/builtin/curator/collect.ts:233`

The collector reads shapes that differ from the actual artifacts produced by the codebase:

- `metrics.json` is saved as an array of `RunMetrics`, but the collector expects an object with `data.stories`.
- Review audit files persist findings under `result.findings`, but the collector reads `audit.findings`.
- Context manifests expose `includedChunks`, `excludedChunks`, and `providerResults`, but the collector reads `manifest.chunks` and `manifest.emptyProviders`.
- Logger JSONL lines use `timestamp`, `stage`, `message`, and `data`; the collector looks for `kind` or `event`, then maps values like `"pull-tool"` and `"acceptance-verdict"`.

**Impact:**

Most Tier 1 sources from the spec will produce zero observations in real runs. This undermines phase 1 collection and cascades into empty or misleading proposal generation.

**Suggested fix:**

Align each source parser with the actual persisted shape:

- For metrics, find the current run entry by `runId` in the metrics array and iterate `run.stories`.
- For review audit, iterate `audit.result?.findings ?? []` and include `advisoryFindings` if intended.
- For manifests, map `includedChunks` IDs and `excludedChunks` objects; use `chunkSummaries` or provider IDs when available for labels/tokens/scores. Derive provider-empty from `providerResults` statuses such as empty/failed/timeout as the spec requires.
- For JSONL, key off `entry.stage` and `entry.message`, then read structured fields from `entry.data`. For the new emits specifically, parse `stage === "pull-tool" && message === "invoked"` and `stage === "acceptance" && message === "verdict"`.

Add fixture tests using real sample artifact shapes from `src/metrics/tracker.ts`, `src/review/review-audit.ts`, `src/context/engine/types.ts`, and `src/logger/formatters.ts` rather than synthetic curator-only shapes.

### P1: H2 and H6 heuristics implement different predicates from the spec

**Files:**

- `src/plugins/builtin/curator/heuristics.ts:103`
- `src/plugins/builtin/curator/heuristics.ts:234`

H2 in the spec is “pull-tool empty result”: `pull-call` where `resultCount = 0`, grouped by the same `keyword`. The implementation groups all pull calls by `toolName` and never checks `resultCount` or `keyword`.

H6 in the spec is “fix-cycle unchanged outcome”: `fix-cycle.iteration` where `outcome = "unchanged"`, with at least the configured number of consecutive unchanged outcomes. The implementation filters `payload.status === "passed"` and describes those as unchanged.

**Impact:**

H2 can fire on healthy pull-tool usage and miss the empty keyword signal it was designed for. H6 can fire on successful fix-cycle iterations and miss actual unchanged/regression loops.

**Suggested fix:**

Update the observation payload types and collector to preserve the spec fields, then rewrite the heuristics:

- H2 should filter `obs.kind === "pull-call"`, `obs.payload.resultCount === 0`, and a non-empty `keyword`, then group by keyword.
- H6 should filter `obs.kind === "fix-cycle.iteration"` or the chosen internal equivalent where `payload.outcome === "unchanged"`, then check consecutive runs/iterations per story or cycle.

Add negative tests proving H2 does not fire for non-empty pull calls and H6 does not fire for merely passed iterations.

### P2: Rollup append is not append-only or concurrency safe

**File:** `src/plugins/builtin/curator/rollup.ts:33`

`appendToRollup()` reads the entire existing rollup file, concatenates new JSONL lines, and overwrites the file with `Bun.write()`.

**Impact:**

Concurrent runs can lose observations: two writers can read the same old file, then the later overwrite drops the earlier writer’s new lines. This contradicts the spec’s append-only concurrency requirement.

**Suggested fix:**

Use an append API instead of read-modify-write, for example `node:fs/promises.appendFile`, after ensuring the parent directory exists. Keep one JSON object per line and avoid rewriting the existing rollup except for explicit `curator gc`.

## Additional Notes

- The branch includes many generated `.nax` artifacts and several `test/unit/runtime/middleware/test-logging-sub-*.jsonl` files. They are not functional blockers, but they look like run/test outputs and should likely be removed before merge unless intentionally tracked.
- `curatorPlugin.execute()` returns `{ success: false }` on curator errors, which `cleanupRun()` logs as a warning and continues. That preserves run exit behavior, but after the P0 context issue is fixed, consider making partial write failures more granular so one failed side effect does not obscure successfully written outputs.

## Recommended Fix Order

1. Register the built-in plugin by default and honor `disabledPlugins: ["nax-curator"]`.
2. Pass runtime path/config fields from `runner.ts` into `cleanupRun()`.
3. Realign collector parsers with existing artifact/log shapes and add real-shape fixtures.
4. Correct H2/H6 predicates and payload types.
5. Replace rollup read-modify-write with true append.
6. Prune generated artifacts from the branch if they are not intentionally part of the PR.
