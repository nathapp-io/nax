# Context Engine v2 §22 — Missing Providers and `query_scratch`

**Date:** 2026-08-15
**Status:** design, approved in brainstorming; not yet planned
**Closes:** §22 of `nax-context-engine-v2-gap-analysis-2026-08-02.md`
**Base:** `main` @ `ad349d6d` (v0.80.0-canary.3)

## Problem

The context engine ships six providers — `static-rules`, `feature-context`,
`git-history`, `session-scratch`, `code-neighbor`, `test-coverage` — and two pull
tools, `query_neighbor` and `query_feature_context`. Three providers the spec
called for were never built, and `query_scratch` was specified as shipping
alongside the session-scratch provider and is still missing.

The gap matters most at `PHASE_3_RECTIFY`. A rectifier retrying a lint failure is
the spec's own motivating example, and today it receives no lint configuration, no
record of how this story failed before, and no structured compiler output — only a
prose scratch entry.

### Correction to the gap doc's framing

The gap doc describes the third item as "structured build/typecheck diagnostics
(today a one-line scratch summary)". That is half right. The `self-verification`
scratch entry already carries a structured `SelfVerificationResult`: per-tool
`pass | skip | pre_existing | fail`, plus a `preExistingFailures[]` array of
`{ packageDir, file?, tool, message }`.

What is missing is not structure but **provenance**. That payload is the agent's
self-report, parsed from a marker the agent emitted, and `missingMarker` is already
a tracked condition. An agent that truncates, omits, or misstates the marker
silently degrades any provider built on it. This design therefore captures real
tool output instead.

## Units

| Unit | Data source | New code |
|:---|:---|:---|
| `PriorRunFailureProvider` | `.nax/metrics.json` via `loadRunMetrics(outputDir)`, where `outputDir` is the repo's `.nax` dir | provider |
| `LintConfigProvider` | `detectProjectProfile().lintTool` + per-toolchain digest | provider + extractor |
| `ToolDiagnosticsProvider` | structured diagnostics parsed from real tool output | provider + capture layer |
| `query_scratch` | existing scratch JSONL, on demand | descriptor + dispatch |

## Chunk kinds

`ChunkKind` is a closed union and `KIND_WEIGHTS` in `scoring.ts` is typed
`Record<ChunkKind, number>`. Adding a kind therefore fails `bun run typecheck`
until its weight exists — a compile-time forcing function, not a convention.

| Kind | Scope | Weight | Rationale |
|:---|:---|:---|:---|
| `prior-failure` | `story` | 0.85 | Story-specific and highly actionable on a retry; below `session` (0.9) because it describes a past run, not the current one |
| `lint-config` | `project` | 0.8 | Project-wide invariant, but only relevant when a lint failure is in play |
| `diagnostics` | `session` | 0.95 | The most actionable context a rectifier can receive: what the tool actually said, this run |

**`lint-config` must not reuse the `static` kind.** `static` is a floor kind — it
bypasses packing entirely. That is precisely the over-delivery documented by the
budget-truth work, where 8,080 floor tokens entered a 4,000-token stage. A lint
digest competes for budget like any other chunk.

## Stage wiring

In `stage-config.ts`:

- `PHASE_3_RECTIFY` gains all three providers.
- `PHASE_3_EXECUTION` and `PHASE_3_TDD_IMPLEMENTER` gain `prior-run-failure` and
  `tool-diagnostics`. They do not gain `lint-config`: a lint digest is noise until
  a lint failure exists, and these stages are where the story is first attempted.
- `pullToolNames` gains `query_scratch` for the rectify and execution stages.

No `context-extract` / `context-summarize` entries are added. Nothing in `src/`
emits those stage names, so the entries would be dead config; that item belongs to
the extractor arc and was refuted as a standalone cheap win.

## Diagnostics capture

`runQualityCommand()` returns `QualityCommandResult` with the real `output`,
`exitCode`, and `timedOut` from the spawn. That is the capture point.

New `src/quality/diagnostics.ts`:

```ts
export interface Diagnostic {
  tool: string;          // "biome" | "tsc" | "ruff" | …
  severity: "error" | "warning";
  file?: string;         // repo-relative
  line?: number;
  column?: number;
  rule?: string;
  message: string;
}

export function parseDiagnostics(result: QualityCommandResult, tool: string | undefined): Diagnostic[];
```

Parsing is per-toolchain and **degrades rather than fails**: an unrecognised tool
yields a single `Diagnostic` carrying a bounded tail of raw output, so a new
language is never a hard error and never silently empty. Initial parsers cover
`tsc` and `biome`, matching this repo's own toolchain; others take the raw-tail
path until a parser is added.

Diagnostics persist as a new `tool-diagnostics` entry in the existing scratch
JSONL, written through `appendScratchEntry`. `ToolDiagnosticsProvider` reads the
same file and filters to that entry kind.

Two providers reading one file is unusual and deliberate. `scratchDir` resolution
is already plumbed through `stage-assembler`, and inventing a second artifact path
means new path plumbing — which is exactly where the fragments defect (#1592)
lived. Reusing proven plumbing is worth the mild oddity.

### `SessionScratchProvider` must be taught to skip the new kind

`renderEntry()` in `session-scratch.ts` switches on `entry.kind` and ends with
`default: return JSON.stringify(entry)`. Adding a `tool-diagnostics` entry to the
`ScratchEntry` union without touching that switch would therefore **dump the raw
JSON of every diagnostic into the session chunk** — the same content surfacing
twice, once well through the new provider and once badly through the old one,
paying tokens for both.

Worse, `session-scratch` keeps only the most recent `MAX_ENTRIES_PER_DIR = 20`
entries per dir. A failing typecheck emitting many diagnostics would evict the
`verify-result` and `rectify-attempt` entries the rectifier actually needs.

Story 1 therefore adds an explicit skip for `tool-diagnostics` in
`SessionScratchProvider`, filtered out **before** the recency cap is applied, not
after. This is an acceptance criterion, not a note.

## Provider contracts

Every provider implements `IContextProvider` and inherits its hard contracts:

- **`fetch()` must never throw.** Return an empty chunk array and log internally.
  The single exception in the codebase is `StaticRulesProvider`'s deliberate
  fail-closed `NeutralityLintError`; none of these three qualify.
- **Concurrency:** `fetch()` runs in parallel across providers and may be shared
  across parallel stories. No per-call mutable state on the instance.
- **Determinism:** all three are deterministic, so `deterministic` stays absent.

Path and scope rules follow `monorepo-awareness.md`:

- `prior-run-failure` is **repo-scoped** — metrics live under the repo's `.nax`.
- `lint-config` and `tool-diagnostics` are **package-scoped** — they read
  `packageDir`, since a monorepo lints per package.
- Feature-tree paths go through `featureDir()` / `featuresDir()` from `@/config`;
  no re-spelling of `.nax` + `features`, per the gate added in #1592.

## `query_scratch`

A `ToolDescriptor` in `pull-tools.ts` alongside `QUERY_NEIGHBOR_DESCRIPTOR`,
dispatched from the `switch` in `tool-runtime.ts`, reusing
`DEFAULT_MAX_CALLS_PER_SESSION`.

Input schema takes an optional `kind` filter (`verify-result`, `rectify-attempt`,
`tdd-session`, `self-verification`, `tool-diagnostics`) and an optional `limit`.
The schema is a plain `type: "object"` — **no `oneOf` / `anyOf` at the top level**,
which breaks tool-schema handling.

Results reuse the existing `neutralizeForAgent` path, so scratch written by one
agent is neutralised before another agent reads it (AC-42).

## Story slicing

Five stories, each inside the 24-AC cap:

1. **Diagnostics capture** — `parseDiagnostics`, the `tool-diagnostics` scratch
   entry kind, the `SessionScratchProvider` skip above, and capture at the
   lint/typecheck `runQualityCommand` call sites that already feed
   self-verification in `src/execution/post-run.ts`. Capture is best-effort and
   never blocks the story, matching how the existing scratch writes there are
   wrapped. The only story touching the quality subsystem.
2. **`ToolDiagnosticsProvider`** — new kind, weight, provider, stage wiring.
3. **`PriorRunFailureProvider`** — new kind, weight, provider, stage wiring.
4. **`LintConfigProvider`** — new kind, weight, digest extractor, provider, wiring.
5. **`query_scratch`** — descriptor, dispatch, stage `pullToolNames`.

Story 1 must land before 2. Stories 3, 4, and 5 are independent of each other.

## Testing

Each provider gets `_deps`-injected unit tests following the existing provider
pattern, **plus at least one real-filesystem test**. Round-trip and fully-mocked
tests are what allowed the fragments defect to ship: read and write shared a helper,
so every assertion passed against the wrong directory. At minimum each provider
proves, against a real temp dir, that it reads the path it claims to read.

Specific cases worth pinning:

- `parseDiagnostics` on an unrecognised tool returns the raw-tail diagnostic, not `[]`.
- Each provider returns `[]` rather than throwing when its source file is absent.
- `prior-run-failure` returns `[]` for a story with no prior failures, and does not
  leak other stories' failures into the chunk.
- `lint-config` names the tool and command when the config format is unknown.
- `query_scratch` respects its per-session call ceiling and its `kind` filter.

## Out of scope

- LLM-backed extraction, summarisation, or promotion (§21 remainder).
- `context-extract` / `context-summarize` stage entries — refuted; dead config.
- Changing `static` floor-kind budget behaviour.
- Per-provider soft budgets (§10) — that changes `fetch()` across every provider.
- RAG, graph, and KB providers — separate spec'd plugin follow-ups.
- Backfilling diagnostics for runs that already completed.
