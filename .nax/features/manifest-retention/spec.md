# SPEC: Context Manifest Retention

## Summary

Context Engine v2 writes a `context-manifest-<stage>.json` per (feature, story, stage) and never deletes one. This feature adds an opt-in, age-based retention sweep that removes context manifests older than a configured number of days across all features, wired into the existing run-completion phase alongside the session-scratch purge it mirrors. Retention is off unless the operator sets `context.v2.manifest.retentionDays`.

## Motivation

`src/context/engine/manifest-store.ts` has no prune, retention, or TTL path of any kind — manifests accumulate for the life of the repository. Measured on the nax repo itself on 2026-08-11: **96 manifest files totalling 1.5 MB across 71 feature directories**, written between 2026-08-03 and 2026-08-09. That is roughly 0.25 MB/day of permanently-retained telemetry, or ~90 MB/year at the observed rate.

The gap is item §15b of the Context Engine v2 gap analysis, and it is the last unbounded-growth path in the context engine. Session scratch already solved the same problem next door: `context.v2.session.retentionDays` drives `purgeStaleScratch()` from `run-completion.ts`. Manifests were simply never given the equivalent.

Retention ships **off by default** so that no existing installation silently loses `nax context inspect` history on upgrade. This feature delivers the mechanism; the operator owns the policy.

## Design

A single new module, one new optional config key, and one new call site. `manifest-store.ts` is not modified.

```typescript
// src/context/engine/manifest-purge.ts
export async function purgeStaleManifests(
  projectDir: string,
  retentionDays: number,
): Promise<number>;
```

Returns the number of manifest files deleted.

Discovery uses one capped glob rather than a nested directory walk, scanned relative to `projectDir`:

```
.nax/features/*/stories/*/{context-manifest-*,rebuild-manifest}.json
```

For each match: read its mtime, and delete it when `mtimeMs < now - retentionDays * 86_400_000`. After processing a story directory, attempt a **non-recursive** directory removal on it. Non-recursive removal is the safety property that matters here: it fails harmlessly when any non-manifest artifact remains, so no recursive deletion is ever performed against a path built from feature and story names.

Following `.nax/rules/project-conventions.md` and `forbidden-patterns-source.md`, the module exposes an injectable `_manifestPurgeDeps` object (`now`, `scan`, `statMtime`, `unlink`, `rmdirIfEmpty`) — `mock.module()` is banned in this codebase, so dependency injection is the only testable seam. Glob scans pass `cwd` explicitly and are capped, per `monorepo-awareness.md` §6.

### Integration

Verified against `main` @ `2a9a4253`:

- **Mirror** `src/session/scratch-purge.ts` (95 lines) — the established retention-module shape: exported `_deps` object, age cutoff computed from an injected `now()`, returns a count.
- **Path shape** comes from `src/context/engine/manifest-store.ts:44-50` — `contextStoryDir()` builds `<projectDir>/.nax/features/<featureId>/stories/<storyId>`, and `contextManifestPath()` / `rebuildManifestPath()` name the two file kinds.
- **Config schema**: add a `manifest` block to `ContextV2ConfigSchema` in `src/config/schemas-context.ts:114`, mirroring the `session` block at `:164-171` — but with `.optional()` and **no** `.default()`, so an unset key resolves to `undefined`. Because Zod omits an optional-without-default key entirely, `DEFAULT_CONFIG` keeps its current shape and no existing config assertion changes.
- **Runtime type**: add the matching optional `manifest` field to `ContextV2Config` in `src/config/runtime-types-context.ts:85`, mirroring the `session` type at `:112-118`.
- **Call site**: `handleRunCompletion()` in `src/execution/lifecycle/run-completion.ts:110`, immediately after the existing scratch-purge block at `:460-479`, gated by `if (manifestCfg?.retentionDays)` — the identical truthiness idiom that gates the scratch purge at `:463`.
- **Barrel**: export `purgeStaleManifests` from `src/context/engine/index.ts`.

**File-size constraint:** `run-completion.ts` is at **549 lines** against the repo's 600-line hard limit (`bun run check:file-sizes`). The new block must stay small; if it would breach 600, extract it rather than growing the file.

**No code is removed by this feature.** The words "delete" and "remove" throughout this spec describe the sweep's *runtime* behaviour against manifest files on disk. No existing symbol, file, or caller is deleted, renamed, or consolidated, so this spec requires no terminal-cleanup story and no build/static-gate removal note.

### Approach

Retention is **age-based on file mtime**, not keep-newest-N. `ContextManifest` carries no timestamp field of its own, so mtime is the only available age signal; a keep-newest-N policy would need mtime anyway to rank recency, making it strictly more machinery for the same input. Age also matches the mental model operators already have from `context.v2.session.retentionDays`.

The sweep covers **all** feature directories, not just the feature being run. This is a deliberate divergence from `purgeStaleScratch()`, which is scoped to a single feature. Per-feature scoping cannot bound growth: a run touches one feature, so the other 70 feature directories observed on this repo would never be swept.

### Failure Handling

| Condition | Behaviour |
|:---|:---|
| `purgeStaleManifests` rejects | Fail-open — `handleRunCompletion` logs at warn level and completes normally. A retention sweep never fails a run. |
| Reading a file's mtime fails | Preserve on uncertainty — the file is retained and excluded from the deleted count. Mirrors `rollup-prune.ts:88-92`: an unreadable entry is a reason to keep it, not to discard it. |
| `.nax/features` does not exist | Return 0. Not an error. |
| Match count exceeds `MAX_MANIFEST_SCAN` | Stop scanning, emit a debug log naming the cap. Bounded work per run. |
| Story directory still holds a non-manifest file | Directory removal fails harmlessly; the directory and its remaining contents survive. |

## Out of Scope

- Whole feature-directory retention — `prd.json`, `plan/`, `checkpoint.jsonl`, `status.json` and acceptance artifacts are not pruned by this feature, which touches context manifests only.
- Archiving manifests to an `_archive/` directory instead of deleting them; the sweep deletes only.
- Curator rollup garbage collection (issue #1445) is unchanged by this feature.
- A keep-newest-N retention policy; retention is age-based on file mtime only.
- Session scratch retention is unchanged — `purgeStaleScratch()` and the `context.v2.session` config keep their existing behaviour.
- A log message advertising the retention knob when it is unset.
- Concurrency safety of any kind: neither a second nax process purging the same directories, nor a concurrent reader such as `nax context inspect` or `loadContextManifests` observing a directory mid-purge, is addressed. The sweep runs at run completion and is best-effort.
- Retention of manifests belonging to a feature that is still in progress is not treated specially — age is the only criterion, so a long-running feature's early manifests are eligible for deletion like any other.
- A CLI command to trigger the manifest purge manually.

## Stories

1. **US-001: Manifest retention config key and purge module** — no dependencies
2. **US-002: Wire the manifest purge into run completion** — depends on US-001

### US-001 — Manifest retention config key and purge module

Adds the optional `context.v2.manifest.retentionDays` config key (schema plus runtime type) and the `purgeStaleManifests` module that performs the age-based sweep.

#### Context Files
- `src/session/scratch-purge.ts` — the retention-module pattern to mirror (injectable deps, age cutoff, count return)
- `src/context/engine/manifest-store.ts` — manifest path shape (`contextStoryDir`, `contextManifestPath`, `rebuildManifestPath`)
- `src/config/schemas-context.ts` — the `session` Zod block at `:164-171` to mirror
- `src/config/runtime-types-context.ts` — the `session` runtime type at `:112-118` to mirror
- `src/context/engine/index.ts` — barrel the new symbol is exported from

#### Creates
- `src/context/engine/manifest-purge.ts` — the purge module and its injectable deps

### US-002 — Wire the manifest purge into run completion

Invokes the purge from the run-completion phase when the key is configured, and keeps a failing sweep from affecting the run.

#### Context Files
- `src/execution/lifecycle/run-completion.ts` — the call site; existing scratch-purge block at `:460-479`
- `src/session/scratch-purge.ts` — the sibling purge whose wiring shape this mirrors
- `src/context/engine/manifest-purge.ts` — created by US-001, invoked here

### Seams

- `[integration]` stub `purgeStaleManifests`; call `handleRunCompletion` with `context.v2.manifest.retentionDays` set to 30; assert `purgeStaleManifests` was invoked once with the resolved project directory and 30. The trigger is `handleRunCompletion` itself — the outermost entry point — so the test enters above the `if (manifestCfg?.retentionDays)` guard where the wiring lives.
- `[integration]` the guard's negative case: with `context.v2.manifest` unset, `handleRunCompletion` must not invoke `purgeStaleManifests` at all.

## Acceptance Criteria

### US-001

- `[unit]` parsing an empty configuration object leaves `context.v2.manifest` undefined, so retention is inactive unless configured.
- `[unit]` parsing a configuration whose `context.v2.manifest.retentionDays` is 30 resolves that field to 30.
- `[unit]` parsing a configuration whose `context.v2.manifest.retentionDays` is 0 fails schema validation, because the field has a minimum of 1.
- `[unit]` `purgeStaleManifests` returns 0 when the given project directory contains no `.nax/features` directory.
- `[unit]` `purgeStaleManifests` called with a retention of 30 days deletes a `context-manifest-context.json` whose modification time is 31 days old.
- `[unit]` `purgeStaleManifests` called with a retention of 30 days leaves a `context-manifest-context.json` whose modification time is 29 days old present on disk.
- `[unit]` `purgeStaleManifests` returns the number of manifest files it deleted.
- `[unit]` `purgeStaleManifests` called with a retention of 30 days deletes a `rebuild-manifest.json` whose modification time is 31 days old.
- `[unit]` when the injected modification-time lookup throws for one manifest, `purgeStaleManifests` leaves that file on disk.
- `[unit]` when the injected modification-time lookup throws for one manifest, that file is not counted in the value `purgeStaleManifests` returns.
- `[unit]` after `purgeStaleManifests` deletes the last manifest in a story directory, that story directory no longer exists.
- `[unit]` when a story directory holds a file that is neither a context manifest nor a rebuild manifest, `purgeStaleManifests` leaves both that directory and that file in place.
- `[unit]` `purgeStaleManifests` stops examining entries once it reaches `MAX_MANIFEST_SCAN` and emits a debug-level log naming that cap.

### US-002

- `[integration]` `handleRunCompletion`, given a configuration with `context.v2.manifest.retentionDays` set to 30, invokes `purgeStaleManifests` exactly once with the resolved project directory and 30.
- `[integration]` `handleRunCompletion`, given a configuration with `context.v2.manifest` unset, does not invoke `purgeStaleManifests`.
- `[integration]` when `purgeStaleManifests` rejects, `handleRunCompletion` still resolves with its normal completion result rather than propagating the rejection.
- `[integration]` when `purgeStaleManifests` rejects, `handleRunCompletion` emits a warn-level log recording the failure.
- `[integration]` when `purgeStaleManifests` returns a count greater than zero, `handleRunCompletion` emits an info-level log carrying that count.

<!-- spec-writing: completed-through-phase-6 -->
