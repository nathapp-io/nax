# SPEC: Feature-context fragments — dependency-scoped cross-story memory

## Summary

Give the dormant `FeatureContextProviderV2` content for the first time by capturing a short fragment per passing story and reading it back only into stories that transitively depend on it, weighted down by dependency distance.

## Motivation

`FeatureContextProviderV2` reads `.nax/features/<featureId>/context.md`. Across 74 feature directories in this repository there are zero such files — the only `context.md` present is `.nax/context.md`, the unrelated project-level source that `nax generate` compiles into `CLAUDE.md`. The provider is registered in `PHASE_0_PROVIDERS`, so it runs on every stage of every story by default and returns an empty chunk list every time.

The write path that would give it content does not exist: there is no capture, extractor, summarizer, or promotion code anywhere under `src/context/`. The `Stage` and `Role` union types already declare `context-extract` / `context-summarize` and `context-extractor` / `context-summarizer`, but `STAGE_CONTEXT_MAP` has no entries for them, so both fall through to `DEFAULT_STAGE_CONFIG` — the types promise a wiring that was never built.

The result is that a story learns nothing from the stories it depends on. If US-001 settles a convention, US-002 rediscovers it.

## Design

Stage 1 of a two-stage plan. This spec ships the storage, the read path, and a deterministic fragment body. A later spec replaces the body with an LLM extractor; nothing about that replacement is a deliverable here.

### Integration

Verified against `main` @ `840b1200`.

| Symbol | Location | Role in this feature |
|:---|:---|:---|
| `FeatureContextProviderV2` | `src/context/engine/providers/feature-context.ts` | Gains a second chunk source alongside its existing `context.md` chunk |
| `completionStage` (a `PipelineStage`) | `src/pipeline/stages/completion.ts` | Host for the capture write |
| `_completionDeps` | `src/pipeline/stages/completion.ts` | Existing injectable deps object — the established seam for stubbing this stage's external calls, and the natural place to reach the capture call from a test |
| `annotateManifestEffectiveness` | `src/context/engine/effectiveness.ts` | The sibling call capture sits beside; its guard and inputs are reused |
| `RawChunk` | `src/context/engine/types.ts` | Shape each fragment is emitted as |
| `ContextRequest` | `src/context/engine/types.ts` | Supplies `storyId`, `featureId`, `repoRoot` |
| `ContextV2ConfigSchema` | `src/config/schemas-context.ts` | Host for the new `fragments` config block |
| `contextInspectCommand`, `formatContextInspect` | `src/cli/context.ts` | Precedent pattern for the new subcommands: a pure formatter plus a thin command |
| `_manifestStoreDeps` | `src/context/engine/manifest-store.ts` | Precedent for the fragment store's injectable file I/O |

The capture host already computes every input a fragment needs, under the guard this feature wants, and already performs a best-effort write next to it:

```ts
if (!isBatch && ctx.projectDir && featureId && ctx.config.context?.v2?.enabled) {
  const diffText = await _completionDeps.getDiffText(ctx.workdir, ctx.storyGitRef);
  // ctx.agentResult?.output, ctx.reviewFindings are in scope here
}
```

No new pipeline stage is introduced.

**Story ids need no defensive normalization.** `src/prd/schema.ts` normalizes and dedupes every entry in `dependencies` at parse time and validates each against the real story-id set.

**Config defaults live in two places, and the outer one wins.** `ContextV2ConfigSchema` in `schemas-context.ts` declares the v2 defaults, and `schemas.ts` carries a hand-written `.default({...})` literal for the whole `context` block that restates them. Zod does not re-parse a default value, so **the outer literal shadows the inner schema's defaults entirely**. This was verified empirically: `NaxConfigSchema.parse({}).context.v2.manifest` resolves to `undefined`, even though `ContextV2ConfigSchema` declares `manifest: { retentionDays: 30 }`.

Adding `fragments` to `ContextV2ConfigSchema` alone therefore leaves `context.v2.fragments` undefined on a default config, and US-001's first four acceptance criteria will fail. **Both sites must carry the new block.** The criteria deliberately assert the resolved outcome of `NaxConfigSchema.parse({})` rather than naming an edit site, so a one-site change fails loudly instead of shipping an unreachable default.

### Approach

Score decay is folded into `rawScore` at fetch time rather than expressed through the existing `scoreMultiplier` field. `scoring.ts` applies `scoreMultiplier` only to chunks already judged stale:

```ts
const freshnessMultiplier = isStale ? (chunk.scoreMultiplier ?? STALENESS_PENALTY) : 1.0;
```

Setting `scoreMultiplier` for dependency decay would therefore be inert on every fresh fragment — passing tests over a feature that does nothing. Computing the decayed value directly into `rawScore` needs no change to `scoring.ts` and composes with staleness, which continues to apply its own multiplier on top.

Fragment base score is `1.0`, matching the existing `context.md` chunk, so at the default decay a direct dependency's fragment (`0.6`) ranks below `context.md` rather than competing with it.

### File Format

One fragment per story at `<projectDir>/.nax/features/<featureId>/fragments/<storyId>.md` -- the same feature directory that holds `prd.json` and the context manifests. Attribution is the filename; the file body carries no metadata. A stage-1 body is derived deterministically from the story title, its acceptance criteria, and the files touched in the story's diff:

```markdown
# US-001 — Add the fragment store

## Acceptance criteria
- writeFragment persists a body readable by readFragment
- readFragment returns null when no fragment exists

## Files touched
- src/context/fragments/store.ts
```

### Failure Handling

| Condition | Behaviour |
|:---|:---|
| Fragment write fails (disk error, permissions) | Fail open — log at debug and continue; the story must not fail because its fragment did not persist |
| Fragment body exceeds `fragments.maxTokens` | Truncate to the cap before writing |
| Fragment file missing or unreadable at read time | Skip that story and continue the dependency walk |
| `prd.json` missing or unparseable at read time | Emit no fragment chunks; still return the `context.md` chunk |
| Dependency graph contains a cycle | Terminate via a visited set; each story contributes at most once |
| A story is reached by two dependency paths | Contribute once, at the shortest distance |

## Out of Scope

- The LLM-backed fragment extractor is deferred to a later spec; this spec ships only a deterministic fragment body, and `fragments.extractor` accepts only the value `"deterministic"`.
- Cross-feature and durable memory is deferred; fragments live and die with their own feature and are never read by another feature.
- The promotion gate is deferred, because promotion exists to move knowledge between features and this spec keeps fragments feature-local.
- The summarizer is deferred; budget pressure is handled by score decay and the existing packer, and a summarizer is worth revisiting only once fragments are measured to overflow a real budget.
- Batch-mode capture is deferred; the host block in `completionStage` is guarded by `!isBatch`, so batch runs write no fragments, matching the existing behaviour of effectiveness annotation.
- Adding `context-extract` and `context-summarize` entries to `STAGE_CONTEXT_MAP` is deferred; it is independent of this feature and is tracked separately.
- Changing, migrating, or writing `.nax/features/<id>/context.md` is deferred; this spec only ever reads it, exactly as today.
- Garbage collection of fragments belonging to archived or deleted features is deferred; `nax context fragments prune` is the only removal mechanism this spec ships.

## Stories

### US-001 — Fragment store and configuration

Introduces the fragment storage module and the `context.v2.fragments` config block. No caller yet.

**Context Files**
- `src/config/schemas-context.ts` — the `ContextV2Schema` this block is added to
- `src/context/engine/manifest-store.ts` — precedent for injectable file I/O and feature-scoped paths

**Creates**
- `src/context/fragments/store.ts`
- `src/context/fragments/index.ts`
- `test/unit/context/fragments/store.test.ts`

The barrel is required, not optional: project conventions give every directory with two or more exports an `index.ts`, and consumers must import from the barrel rather than an internal path, to avoid singleton fragmentation. US-002, US-003 and US-004 therefore import from `@/context/fragments`.

### US-002 — Capture a fragment when a story passes

Depends on US-001. Writes a deterministic fragment from `completionStage`.

**Context Files**
- `src/pipeline/stages/completion.ts` — capture host and its existing guard
- `src/context/engine/effectiveness.ts` — the sibling best-effort call whose pattern capture mirrors
- `src/context/fragments/index.ts` — barrel created by US-001, consumed here

**Creates**
- `test/unit/pipeline/stages/completion-fragment-capture.test.ts`

### US-003 — Dependency-scoped fragment reads with distance decay

Depends on US-001. Extends the provider to walk the dependency graph and emit decayed chunks.

**Context Files**
- `src/context/engine/providers/feature-context.ts` — the provider being extended
- `src/context/engine/types.ts` — `RawChunk` and `ContextRequest` shapes
- `src/prd/schema.ts` — confirms dependency ids are normalized and validated
- `src/context/fragments/index.ts` — barrel created by US-001, consumed here

**Creates**
- `test/unit/context/engine/providers/feature-context-fragments.test.ts`

### US-004 — Inspect and prune fragments

Depends on US-001. Adds on-demand curation.

**Context Files**
- `src/cli/context.ts` — existing `nax context` surface and its pure-formatter precedent
- `src/context/fragments/index.ts` — barrel created by US-001, consumed here

**Creates**
- `src/cli/context-fragments.ts`
- `test/unit/cli/context-fragments.test.ts`

### Seams

- **US-001 → US-002.** `writeFragment` is exported by US-001 and called by US-002's capture path. US-002 asserts the call from the `completionStage` entry point.
- **US-001 → US-003.** `readFragment` and `listFragmentStoryIds` are exported by US-001 and called by US-003's provider. US-003 asserts the calls from `FeatureContextProviderV2.fetch`.
- **US-001 → US-004.** `listFragmentStoryIds` and `deleteFragment` are exported by US-001 and called by US-004's commands.

## Acceptance Criteria

### US-001 — Fragment store and configuration

1. `[unit]` Parsing an empty configuration object with the nax config schema yields `context.v2.fragments.enabled` equal to `false`.
2. `[unit]` Parsing an empty configuration object with the nax config schema yields `context.v2.fragments.decay` equal to `0.6`.
3. `[unit]` Parsing an empty configuration object with the nax config schema yields `context.v2.fragments.maxTokens` equal to `400`.
4. `[unit]` Parsing an empty configuration object with the nax config schema yields `context.v2.fragments.extractor` equal to `"deterministic"`.
5. `[unit]` Parsing a configuration whose `context.v2.fragments.decay` is `1.5` fails validation, because decay is constrained to the range 0 to 1 inclusive.
6. `[unit]` `writeFragment` is importable from the fragment store module, and calling it with a project directory, feature id, story id and body, followed by `readFragment` with the same project directory, feature id and story id, returns exactly the body that was written.
7. `[unit]` Calling `readFragment` for a story that has no fragment returns `null`.
8. `[unit]` Calling `writeFragment` with a body longer than the configured `maxTokens` budget, then reading it back, returns a body no longer than that budget.
9. `[unit]` Calling `listFragmentStoryIds` after writing fragments for two stories returns both story ids, and does not return a story id that has no fragment.
10. `[unit]` Calling `deleteFragment` for a story that has a fragment causes a subsequent `readFragment` for that story to return `null`.
11. `[unit]` Calling `deleteFragment` for a story that has no fragment completes without raising.
12. `[unit]` Calling `writeFragment` twice for the same story with different bodies, then reading it back, returns only the second body — the store overwrites rather than appends.

### US-002 — Capture a fragment when a story passes

1. `[integration]` Running `completionStage` for a passing story, with v2 context and fragments both enabled, invokes `writeFragment` exactly once with the story's own id.
2. `[integration]` Running `completionStage` for a passing story with `context.v2.fragments.enabled` set to `false` does not invoke `writeFragment`.
3. `[integration]` Running `completionStage` for a passing story with `context.v2.enabled` set to `false` does not invoke `writeFragment`.
4. `[integration]` The body passed to `writeFragment` includes the story's title.
5. `[integration]` The body passed to `writeFragment` includes each of the story's acceptance criteria.
6. `[integration]` The body passed to `writeFragment` names each file reported as changed in the story's diff.
7. `[integration]` When `writeFragment` raises, `completionStage` still completes successfully and reports the story as passed.
8. `[integration]` Running `completionStage` twice for the same story invokes `writeFragment` twice, each time with that story's id.

### US-003 — Dependency-scoped fragment reads with distance decay

1. `[unit]` For a story whose dependency list is empty, `FeatureContextProviderV2.fetch` returns no chunk whose id identifies a fragment.
2. `[unit]` For a story that directly depends on one story which has a fragment, `fetch` returns exactly one fragment chunk, identifying that dependency's story id.
3. `[unit]` For a chain in which the requesting story depends on a second story which depends on a third, and all three have fragments, `fetch` returns fragment chunks for the second and third stories and none for the requesting story itself.
4. `[unit]` In that same chain, the chunk for the transitively reached third story has a strictly lower score than the chunk for the directly depended-upon second story.
5. `[unit]` For a diamond dependency in which two separate paths reach the same story, `fetch` returns exactly one chunk for that story, scored at the shorter of the two distances.
6. `[unit]` For a dependency graph containing a cycle, `fetch` returns without raising and returns at most one chunk per story.
7. `[unit]` A fragment chunk's score equals the configured `decay` raised to the power of the dependency distance, taking a base score of `1.0`.
8. `[unit]` A story whose fragment file is absent contributes no chunk, while its own dependencies are still reached and still contribute chunks.
9. `[unit]` When the feature's `prd.json` is absent, `fetch` returns no fragment chunks and still returns the chunk derived from `context.md`.
10. `[unit]` With `context.v2.fragments.enabled` set to `false`, `fetch` returns no fragment chunks even when fragments exist on disk.
11. `[unit]` Each returned fragment chunk carries kind `feature`.

### US-004 — Inspect and prune fragments

1. `[cli]` Running the fragments inspect command for a feature with two fragments lists both story ids.
2. `[cli]` Running the fragments inspect command for a feature with no fragments reports that none were found and exits with status `0`.
3. `[cli]` Running the fragments inspect command prints, for each fragment, the story ids that transitively depend on it.
4. `[cli]` Running the fragments prune command with a story id removes only that story's fragment, leaving other fragments readable.
5. `[cli]` Running the fragments prune command without a story id removes every fragment for that feature.
6. `[cli]` Running the fragments prune command for a feature that has no fragments exits with status `0` and reports that nothing was removed.
7. `[unit]` The fragments output formatter is a pure function of its arguments: called twice with the same fragment listing, it returns identical output and performs no file access.

<!-- spec-writing: completed-through-phase-6 -->
