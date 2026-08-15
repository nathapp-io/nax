# SPEC: Context Engine v2 §22 — Missing Providers and `query_scratch`

## Summary

Add the three deterministic context providers the Context Engine v2 spec called for but never shipped — prior-run failures, lint configuration, and real build/typecheck diagnostics — plus the `query_scratch` pull tool. Each provider is a new implementation of the existing `IContextProvider` interface, wired into the rectify and execution stages so a retrying agent receives what actually broke, what the linter requires, and what the compiler said.

## Motivation

The engine ships six providers (`static-rules`, `feature-context`, `git-history`, `session-scratch`, `code-neighbor`, `test-coverage`) and two pull tools (`query_neighbor`, `query_feature_context`).

The gap is sharpest at `PHASE_3_RECTIFY`. A rectifier retrying a lint failure is the v2 spec's own motivating example, and today it receives no lint configuration, no record of how this story failed on previous runs, and no structured compiler output — only prose scratch entries.

The gap analysis described the third item as "structured build/typecheck diagnostics (today a one-line scratch summary)". That is half right. The `self-verification` scratch entry already carries a structured `SelfVerificationResult` — per-tool `pass | skip | pre_existing | fail` plus a `preExistingFailures[]` array of `{ packageDir, file?, tool, message }`. What is missing is **provenance**: that payload is the agent's self-report parsed from a marker the agent emitted, and `missingMarker` is already a tracked condition. An agent that truncates or omits the marker silently degrades anything built on it. This spec captures real tool output instead.

## Design

### Integration

Verified against `main` @ `ad349d6d`.

| Symbol | Location | Signature / shape as it exists today |
|:---|:---|:---|
| `IContextProvider` | `src/context/engine/types.ts:441` | `{ id: string; kind: ChunkKind; deterministic?: boolean; fetch(...) }` |
| `ContextProviderResult` | `src/context/engine/types.ts:414` | `{ chunks: RawChunk[]; pullTools?: ToolDescriptor[]; budgetPressure?: ProviderBudgetPressure }` |
| `RawChunk` | `src/context/engine/types.ts:366` | `{ id, kind, scope, role, content, tokens, rawScore, … }`; `providerId` is set by the orchestrator, not the provider |
| `ChunkKind` | `src/context/engine/types.ts:100` | closed union of 9 values |
| `ChunkRole` | `src/context/engine/types.ts:121` | `"implementer" \| "reviewer" \| "tdd" \| "all"` |
| `ContextRequest` | `src/context/engine/types.ts:200` | carries `storyId`, `featureId?`, `repoRoot`, `packageDir`, `storyScratchDirs?`, `agentId?` |
| `KIND_WEIGHTS` | `src/context/engine/scoring.ts:31` | `Record<ChunkKind, number>` |
| `createDefaultOrchestrator` | `src/context/engine/orchestrator-factory.ts:41` | providers pushed onto a local `IContextProvider[]` |
| `PHASE_3_RECTIFY` | `src/context/engine/stage-config.ts:92` | `[...PHASE_1_PROVIDERS, "code-neighbor"]` |
| `PULL_TOOL_REGISTRY` | `src/context/engine/pull-tools.ts:132` | `Record<string, ToolDescriptor>` |
| `DEFAULT_MAX_CALLS_PER_SESSION` | `src/context/engine/pull-tools.ts` | derived from `ContextV2ConfigSchema.parse({}).pull.maxCallsPerSession` |
| `callTool` switch | `src/context/engine/tool-runtime.ts:107` | `case "query_neighbor" \| "query_feature_context"`, `default:` throws `PULL_TOOL_NO_HANDLER` |
| `renderEntry` | `src/context/engine/providers/session-scratch.ts:79` | switches on `entry.kind`, `default: return JSON.stringify(entry)` |
| `MAX_ENTRIES_PER_DIR` | `src/context/engine/providers/session-scratch.ts` | `20` |
| `ScratchEntry` | `src/session/scratch-writer.ts:85` | union of `verify-result`, `rectify-attempt`, `tdd-session`, `self-verification` |
| `appendScratchEntry` | `src/session/scratch-writer.ts` | `(scratchDir, entry) => Promise<void>` |
| `loadRunMetrics` | `src/metrics/tracker.ts:468` | `(outputDir: string) => Promise<RunMetrics[]>`, reads `<outputDir>/metrics.json` |
| `runQualityCommand` | `src/quality/runner.ts:83` | returns `QualityCommandResult { commandName, command, success, exitCode, output, durationMs, timedOut }` |
| `detectProjectProfile` | `src/project/detector.ts:163` | `(workdir, existing) => Promise<ProjectProfile>` with `lintTool` |
| `neutralizeForAgent` | `src/context/engine/scratch-neutralizer.ts` | used by session-scratch for cross-agent rendering |

Patterns mirrored: `TestCoverageProvider` for a config-gated provider registered unconditionally; `SessionScratchProvider` for JSONL reading with `_deps` injection.

`detectLintTool` is **private** in `detector.ts`; the public surface is `detectProjectProfile()` returning `ProjectProfile.lintTool`. This spec uses the public one.

### Approach

New chunk kinds rather than reuse of existing ones. `KIND_WEIGHTS` is typed `Record<ChunkKind, number>`, so adding a kind fails `bun run typecheck` until its weight exists.

| Kind | Scope | Weight |
|:---|:---|:---|
| `prior-failure` | `story` | 0.85 |
| `lint-config` | `project` | 0.8 |
| `diagnostics` | `session` | 0.95 |

`lint-config` must not reuse the `static` kind. `static` is a floor kind that bypasses packing, which is the over-delivery the budget-truth work documented. A lint digest competes for budget like any other chunk.

Diagnostics persist as a new `tool-diagnostics` entry in the existing scratch JSONL rather than a new artifact path: `scratchDir` resolution is already plumbed through `stage-assembler`, and new path plumbing is where the fragments defect (#1592) lived.

`parseDiagnostics` degrades rather than fails — an unrecognised toolchain yields one `Diagnostic` carrying a bounded tail of raw output, so a new language is never a hard error and never silently empty.

### Failure Handling

| Condition | Behaviour |
|:---|:---|
| Provider source file absent (no `metrics.json`, no scratch file, no lint config) | `fetch()` returns an empty `chunks` array; never throws |
| Provider source file malformed (unparseable JSON / JSONL line) | Skip the unreadable unit, return whatever parsed; never throws |
| `parseDiagnostics` receives output from an unrecognised toolchain | Return one `Diagnostic` with `tool` set to the detected or reported name and `message` set to a bounded tail of the raw output |
| Diagnostics capture fails while writing the scratch entry | Log at warn and continue; capture never blocks story completion |
| `query_scratch` invoked past its per-session call ceiling | The existing pull-tool budget path applies, as for `query_neighbor` |

`fetch()` must never throw — the interface's hard contract. The only sanctioned exception in the codebase is `StaticRulesProvider`'s fail-closed `NeutralityLintError`; none of these three qualify.

## Out of Scope

- LLM-backed context extraction, summarisation, and promotion (Context Engine v2 §21 remainder) are not implemented by this spec; only deterministic providers are added.
- `context-extract` and `context-summarize` entries are not added to `STAGE_CONTEXT_MAP`, because no code in `src/` emits those stage names and the entries would be dead config.
- The floor-kind budget behaviour of the `static` chunk kind is not changed by this spec.
- Per-provider soft budgets (Context Engine v2 §10) are not implemented; the `fetch()` signature is unchanged.
- RAG, graph, and KB providers are not implemented; they remain separate spec'd follow-ups.
- Diagnostics are not backfilled for runs that completed before this feature shipped.
- Diagnostic parsers beyond `tsc` and `biome` are not implemented; other toolchains take the raw-tail path.
- US-005 only: enforcement of the `query_scratch` per-session call ceiling is not verified by this spec; it is existing pull-tool budget behaviour shared with `query_neighbor`, and only the descriptor's ceiling value is pinned.

## Stories

**US-001 — Capture real tool diagnostics into scratch** (no dependencies)

Add `parseDiagnostics` and the `tool-diagnostics` scratch entry kind, capture diagnostics at the lint/typecheck sites that already write self-verification scratch, and teach `SessionScratchProvider` to skip the new kind before its recency cap applies.

### Context Files
- `src/quality/runner.ts`
- `src/session/scratch-writer.ts`
- `src/execution/post-run.ts`
- `src/context/engine/providers/session-scratch.ts`

### Creates
- `src/quality/diagnostics.ts`
- `test/unit/quality/diagnostics.test.ts`

**US-002 — ToolDiagnosticsProvider** (depends on US-001)

Add the `diagnostics` chunk kind and a provider that reads `tool-diagnostics` entries from the story's scratch dirs.

### Context Files
- `src/context/engine/providers/session-scratch.ts`
- `src/context/engine/types.ts`
- `src/context/engine/scoring.ts`
- `src/context/engine/orchestrator-factory.ts`
- `src/context/engine/stage-config.ts`

### Creates
- `src/context/engine/providers/tool-diagnostics.ts`
- `test/unit/context/engine/providers/tool-diagnostics.test.ts`

**US-003 — PriorRunFailureProvider** (depends on US-002)

Add the `prior-failure` chunk kind and a provider that reports this story's own failures from earlier runs. This story must run after US-002: both add a member to the `ChunkKind` union and an entry to `KIND_WEIGHTS`, so running them concurrently means two edits to the same union and the same `Record` in one tree.

### Context Files
- `src/metrics/tracker.ts`
- `src/metrics/types.ts`
- `src/context/engine/types.ts`
- `src/context/engine/scoring.ts`
- `src/context/engine/stage-config.ts`

### Creates
- `src/context/engine/providers/prior-run-failure.ts`
- `test/unit/context/engine/providers/prior-run-failure.test.ts`

**US-004 — LintConfigProvider** (depends on US-002)

Add the `lint-config` chunk kind and a provider that names the governing linter and distils the settings most likely to cause a retry loop. This story must run after US-002 for the same reason as US-003: both edit the `ChunkKind` union and `KIND_WEIGHTS`.

### Context Files
- `src/project/detector.ts`
- `src/quality/command-defaults.ts`
- `src/context/engine/types.ts`
- `src/context/engine/scoring.ts`
- `src/context/engine/stage-config.ts`

### Creates
- `src/context/engine/providers/lint-config.ts`
- `test/unit/context/engine/providers/lint-config.test.ts`

**US-005 — query_scratch pull tool** (depends on US-001)

Add the descriptor, registry entry, runtime handler, and stage wiring for on-demand scratch reads.

### Context Files
- `src/context/engine/pull-tools.ts`
- `src/context/engine/tool-runtime.ts`
- `src/context/engine/stage-config.ts`
- `src/session/scratch-writer.ts`

### Creates
- `test/unit/context/engine/query-scratch.test.ts`

### Seams

- **US-001 → US-002.** `parseDiagnostics` and the `tool-diagnostics` entry kind are consumed by `ToolDiagnosticsProvider`. US-002 carries the seam AC.
- **US-001 → US-005.** The `tool-diagnostics` entry kind is one of the filter values `query_scratch` accepts. US-005 carries the seam AC.
- **US-002 / US-003 / US-004 → orchestrator.** Each provider is registered in `createDefaultOrchestrator`. Each story carries a seam AC proving its provider is reachable through that factory, not merely constructible.

## Acceptance Criteria

### US-001 — Capture real tool diagnostics into scratch

1. `[unit]` `parseDiagnostics` is importable from `src/quality/diagnostics.ts` and returns an array when called with a successful `QualityCommandResult` and the tool name `tsc`.
2. `[unit]` Calling `parseDiagnostics` with a `QualityCommandResult` whose `output` contains a `tsc` error line for file `src/a.ts` at line 12 returns one `Diagnostic` whose `file` is `src/a.ts`, `line` is 12, and `severity` is `error`.
3. `[unit]` Calling `parseDiagnostics` with a `QualityCommandResult` whose `output` contains a `biome` diagnostic naming a rule returns one `Diagnostic` whose `rule` equals that rule name.
4. `[unit]` Calling `parseDiagnostics` with the tool name `unknown-linter` and a non-empty `output` returns exactly one `Diagnostic` whose `message` is non-empty and whose `tool` is `unknown-linter`.
5. `[unit]` Calling `parseDiagnostics` with the tool name `unknown-linter` and an `output` longer than the bounded tail limit returns one `Diagnostic` whose `message` length does not exceed that limit.
6. `[unit]` Calling `parseDiagnostics` with a `QualityCommandResult` whose `success` is true and whose `output` is empty returns an empty array.
7. `[unit]` A `tool-diagnostics` scratch entry can be constructed with `kind` set to `tool-diagnostics`, a `timestamp`, a `storyId`, and a `diagnostics` array, and is accepted by `appendScratchEntry` without error.
8. `[integration]` Appending a `tool-diagnostics` entry to a scratch dir and then reading that dir's scratch file back yields an entry whose `kind` is `tool-diagnostics` and whose `diagnostics` array has the same length as the one written.
9. `[unit]` Rendering a scratch dir containing one `tool-diagnostics` entry and one `verify-result` entry through `SessionScratchProvider` produces chunk content that includes the verify text and does not include the literal string `tool-diagnostics`.
10. `[unit]` Rendering a scratch dir containing 25 `tool-diagnostics` entries followed by one `verify-result` entry through `SessionScratchProvider` produces chunk content that includes the verify text, proving the new kind is filtered before the 20-entry recency cap is applied.
11. `[integration]` When a lint or typecheck command runs and returns a non-zero `exitCode`, a `tool-diagnostics` entry is appended to the story's scratch dir.
12. `[integration]` When appending the `tool-diagnostics` entry throws, the surrounding execution still completes and reports success, proving capture is best-effort.

**Out of scope:** parsers for toolchains other than `tsc` and `biome` — those take the raw-tail path by design.

### US-002 — ToolDiagnosticsProvider

1. `[unit]` `ToolDiagnosticsProvider` is importable from `src/context/engine/providers/tool-diagnostics.ts` and can be constructed with no arguments.
2. `[unit]` A constructed `ToolDiagnosticsProvider` exposes `id` equal to `tool-diagnostics` and `kind` equal to `diagnostics`.
3. `[unit]` Scoring a chunk whose `kind` is `diagnostics` applies the kind weight 0.95.
4. `[unit]` Scoring a chunk whose `kind` is `session` still applies the kind weight 0.9, proving existing weights are unchanged.
5. `[unit]` Calling `fetch` with a request whose `storyScratchDirs` is undefined returns a result whose `chunks` array is empty.
6. `[unit]` Calling `fetch` with a request naming a scratch dir that does not exist returns a result whose `chunks` array is empty and does not throw.
7. `[unit]` Calling `fetch` with a request naming a scratch dir whose scratch file contains one malformed JSONL line and one valid `tool-diagnostics` entry returns a result containing one chunk.
8. `[integration]` Calling `fetch` against a real temp directory containing a scratch file with two `tool-diagnostics` entries returns chunks whose combined content names both diagnostics' files.
9. `[unit]` Calling `fetch` with a scratch dir containing only `verify-result` entries returns a result whose `chunks` array is empty, proving the provider filters to its own entry kind.
10. `[unit]` Every chunk returned by `fetch` has `kind` equal to `diagnostics`, `scope` equal to `session`, and a `tokens` value greater than zero.
11. `[integration]` An orchestrator built by `createDefaultOrchestrator` includes a provider whose `id` is `tool-diagnostics`.
12. `[unit]` Resolving the stage context config for the rectify stage yields a `providerIds` list that includes `tool-diagnostics`.
13. `[unit]` Resolving the stage context config for the execution stage yields a `providerIds` list that includes `tool-diagnostics`.

### US-003 — PriorRunFailureProvider

1. `[unit]` `PriorRunFailureProvider` is importable from `src/context/engine/providers/prior-run-failure.ts` and can be constructed with no arguments.
2. `[unit]` A constructed `PriorRunFailureProvider` exposes `id` equal to `prior-run-failure` and `kind` equal to `prior-failure`.
3. `[unit]` Scoring a chunk whose `kind` is `prior-failure` applies the kind weight 0.85.
4. `[unit]` Calling `fetch` when no metrics file exists at the request's `repoRoot` returns a result whose `chunks` array is empty and does not throw.
5. `[integration]` Calling `fetch` against a real temp repo whose metrics file records the request's `storyId` as failed in a prior run returns one chunk whose content names that story id.
6. `[integration]` Calling `fetch` against a metrics file recording the request's story as failed with two entries in `failingTestFiles` returns a chunk whose content names both test files.
7. `[unit]` Calling `fetch` against a metrics file in which the request's story never failed returns a result whose `chunks` array is empty.
8. `[unit]` Calling `fetch` against a metrics file recording a failure for a different story id returns a result whose `chunks` array is empty, proving other stories' failures do not leak.
9. `[unit]` Calling `fetch` against a metrics file that is not valid JSON returns a result whose `chunks` array is empty and does not throw.
10. `[integration]` Calling `fetch` against a metrics file recording the request's story as failed in two separate runs returns a chunk whose content reports the attempt count from both.
11. `[unit]` Every chunk returned by `fetch` has `kind` equal to `prior-failure` and `scope` equal to `story`.
12. `[integration]` An orchestrator built by `createDefaultOrchestrator` includes a provider whose `id` is `prior-run-failure`.
13. `[unit]` Resolving the stage context config for the rectify stage yields a `providerIds` list that includes `prior-run-failure`.

### US-004 — LintConfigProvider

1. `[unit]` `LintConfigProvider` is importable from `src/context/engine/providers/lint-config.ts` and can be constructed with no arguments.
2. `[unit]` A constructed `LintConfigProvider` exposes `id` equal to `lint-config` and `kind` equal to `lint-config`.
3. `[unit]` Scoring a chunk whose `kind` is `lint-config` applies the kind weight 0.8.
4. `[unit]` Scoring a chunk whose `kind` is `static` still applies the kind weight 1.0, proving the new kind did not disturb the floor kind.
5. `[integration]` Calling `fetch` against a real temp package containing a `biome.json` returns one chunk whose content names `biome`.
6. `[integration]` Calling `fetch` against a real temp package containing a `biome.json` that sets an indent width returns a chunk whose content reports that indent width.
7. `[integration]` Calling `fetch` against a real temp package whose lint configuration is in a format with no distiller returns a chunk that still names the detected tool.
8. `[unit]` Calling `fetch` against a package with no detectable lint tool returns a result whose `chunks` array is empty and does not throw.
9. `[unit]` Calling `fetch` against a package whose lint config file is malformed returns a chunk that names the tool and does not throw.
10. `[unit]` Every chunk returned by `fetch` has `kind` equal to `lint-config` and `scope` equal to `project`.
11. `[unit]` Calling `fetch` reads the request's `packageDir` rather than its `repoRoot`, proving the provider is package-scoped: a request whose `packageDir` contains a lint config and whose `repoRoot` does not returns one chunk.
12. `[unit]` Calling `fetch` with a stubbed `detectProjectProfile` invokes that stub with the request's `packageDir`, proving lint-tool detection goes through the public detector rather than a re-implementation.
13. `[integration]` An orchestrator built by `createDefaultOrchestrator` includes a provider whose `id` is `lint-config`.
14. `[unit]` Resolving the stage context config for the rectify stage yields a `providerIds` list that includes `lint-config`.
15. `[unit]` Resolving the stage context config for the execution stage yields a `providerIds` list that does not include `lint-config`.

### US-005 — query_scratch pull tool

1. `[unit]` `PULL_TOOL_REGISTRY` contains the key `query_scratch`, and the descriptor stored there has `name` equal to `query_scratch`.
2. `[unit]` The `query_scratch` descriptor's `inputSchema` has `type` equal to `object` and declares no top-level `oneOf` or `anyOf` key.
3. `[unit]` The `query_scratch` descriptor's `inputSchema` declares optional properties `kind` and `limit`, and its `required` list is empty or absent.
4. `[unit]` The `query_scratch` descriptor's `maxCallsPerSession` equals `DEFAULT_MAX_CALLS_PER_SESSION`.
5. `[integration]` Invoking `callTool` with the name `query_scratch` against a story whose scratch dir contains one `verify-result` entry returns a non-empty string naming that entry's outcome.
6. `[integration]` Invoking `callTool` with the name `query_scratch` and an input whose `kind` is `tool-diagnostics`, against a scratch dir containing one `tool-diagnostics` entry and one `verify-result` entry, returns a string that names the diagnostic and not the verify entry.
7. `[integration]` Invoking `callTool` with the name `query_scratch` and an input whose `limit` is 1, against a scratch dir containing three entries, returns a string naming exactly one entry.
8. `[integration]` Invoking `callTool` with the name `query_scratch` against a story with no scratch dir returns a string reporting that no entries were found, rather than throwing.
9. `[integration]` Invoking `callTool` with the name `query_scratch` and an input whose `kind` is a value no entry uses returns a string reporting that no entries were found.
10. `[integration]` Invoking `callTool` with the name `query_scratch` returns content in which agent-specific tool references written by a different agent have been neutralised for the requesting agent.
11. `[unit]` Resolving the stage context config for the rectify stage yields a `pullToolNames` list that includes `query_scratch`.
12. `[unit]` Resolving the stage context config for the execution stage yields a `pullToolNames` list that includes `query_scratch`.

**Out of scope:** enforcement of the per-session call ceiling is existing pull-tool budget behaviour shared with `query_neighbor`; this story pins the descriptor's ceiling value but does not re-verify the budget path.

<!-- spec-writing: completed-through-phase-6 -->
