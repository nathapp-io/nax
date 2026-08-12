# Feature-context fragments — dependency-scoped cross-story memory

**Date:** 2026-08-12
**Status:** Design approved, not yet planned
**Implementation scope:** **Stage 1 only.** Stage 2 (the LLM extractor) is described here so the staging is legible, but it is a separate spec and a separate plan — nothing in stage 2 is a deliverable of this one.
**Verified against:** `main` @ `840b1200` (v0.79.2)
**Closes:** the capture half of context-engine v2 gap item §21 (the v2 write path)

## Motivation

Two findings, both verified against the working tree rather than taken from the gap report.

**The feature-context provider has never had anything to read.** `FeatureContextProviderV2` reads `.nax/features/<featureId>/context.md`. Across **74 feature directories in this repo there are zero such files.** The only `context.md` present is `.nax/context.md` — the unrelated project-level source that `nax generate` compiles into `CLAUDE.md`. The provider is registered in `PHASE_0_PROVIDERS`, so it runs on *every stage of every story by default*, and has been returning `{ chunks: [], pullTools: [] }` every time.

**The write path that would give it content is unbuilt.** No `capture.ts`, extractor, fragment writer, merger, summarizer, or promotion gate exists anywhere under `src/context/`. The `Stage` and `Role` union types declare `context-extract` / `context-summarize` and `context-extractor` / `context-summarizer` / `context-promoter`, but `STAGE_CONTEXT_MAP` has no entries for them — so both stages fall through to `DEFAULT_STAGE_CONFIG` (`role: "implementer"`, `budgetTokens: 8_000`). The types promise a wiring that does not exist.

This design gives the dormant provider content, scoped so that a story sees only what its own dependencies established.

## Goals

1. **Cross-story memory within a feature, scoped to dependency edges.** If US-002 depends on US-001, US-002 sees what US-001 established. Unrelated stories do not leak into each other.
2. **Populate the feature-context provider automatically.** No human authoring step is required for the feature to deliver value.

## Non-goals

- **No cross-feature / durable memory.** Fragments live and die with their feature. This removes the promotion gate entirely.
- **No promotion gate.** Promotion is the archival mechanism for cross-feature memory, which is out of scope.
- **No summarizer in this design.** Score decay plus the existing packer handle budget pressure. A summarizer becomes worth considering only once fragments exist and are measured to overflow.
- **No change to `context.md`.** It remains human-authored, read exactly as today, and is never written by this feature.
- **Batch mode is not covered.** See Known limitations.

## Design

### 1. Storage

One fragment per story:

```
.nax/features/<featureId>/fragments/<storyId>.md
```

Attribution is the filename. No metadata to parse, no per-entry tagging, and the dependency filter reduces to file selection. Fragments are runtime artifacts and belong in the existing `.nax/` gitignore treatment.

`context.md` is untouched. Because no human-authored `context.md` exists in practice, there is no ownership conflict, no merge hazard, and no need for marker-delimited sections inside a shared file.

### 2. Read path — dependency-scoped with decay

`FeatureContextProviderV2.fetch()` gains a second source alongside its existing `context.md` chunk:

1. Read `.nax/features/<featureId>/prd.json` to obtain all stories.
2. Walk `story.dependencies` transitively from the current story, recording each reached story's **distance** (direct dependency = 1, its dependencies = 2, …). Guard with a visited set so a cycle terminates.
3. For each reached story with a fragment on disk, emit one `RawChunk`:
   - `id: fragment:<storyId>`
   - `kind: "feature"`, `scope: "feature"`
   - `rawScore = FRAGMENT_BASE_SCORE * (fragments.decay ** distance)`, where `FRAGMENT_BASE_SCORE = 1.0` — the same base the existing `context.md` chunk uses, so at the default decay a direct dependency's fragment (0.6) ranks below `context.md` (1.0) rather than competing with it.

Story ids need no defensive normalization: `src/prd/schema.ts` already normalizes and dedupes every entry in `dependencies` at parse time and validates each against the real story-id set.

**Decay folds into `rawScore`, not `scoreMultiplier`.** This is deliberate and load-bearing. `scoring.ts` applies `scoreMultiplier` only when a chunk is already stale:

```ts
const freshnessMultiplier = isStale ? (chunk.scoreMultiplier ?? STALENESS_PENALTY) : 1.0;
```

Setting `scoreMultiplier` for dependency decay would therefore be **silently inert on every fresh fragment** — a green test suite over a feature that does nothing. Computing the decayed value into `rawScore` at fetch time requires no change to `scoring.ts` and composes correctly with staleness, which continues to apply its own multiplier on top.

Budget pressure needs no new mechanism: distant fragments carry lower scores, so the existing packer drops them first.

### 3. Write path — staged

**Stage 1 — deterministic fragment (ships first).**

Capture runs in `src/pipeline/stages/completion.ts` as a sibling of the existing `annotateManifestEffectiveness` call. That block already computes and holds every input a fragment needs, under the guard this feature wants anyway:

```ts
if (!isBatch && ctx.projectDir && featureId && ctx.config.context?.v2?.enabled) {
  const diffText = await _completionDeps.getDiffText(ctx.workdir, ctx.storyGitRef);
  // agentOutput: ctx.agentResult?.output, findings: ctx.reviewFindings
}
```

No new pipeline stage is introduced. The spec's proposed `src/pipeline/stages/capture.ts` is unnecessary — it would duplicate a guard, a diff computation, and a best-effort write that already exist at exactly the right point in the lifecycle.

The stage-1 fragment body is derived deterministically from the story (title, acceptance criteria) and the diff (files touched). Its purpose is to prove storage, closure, decay, packing, and provider wiring end-to-end with zero LLM risk.

**Stage 2 — LLM extractor (follow-on).**

Replace the fragment body with a `context-extractor` complete-kind operation, gated behind config and capped at roughly 400 tokens. Call sites, storage layout, and read path are unchanged — only the body differs. The value of a fragment is in recording *decisions and rationale* ("US-001 settled on `Result<T>` over exceptions because …"), which is the one thing not already recoverable from the `git-history` and `code-neighbor` providers; deterministic extraction alone largely duplicates those.

Staging exists so the hallucination-bearing half lands on infrastructure already proven to work.

### 4. Curation

- `nax context show <feature>` — list fragments with size and which stories depend on each.
- `nax context prune <feature> [--story <id>]` — delete fragments.

Curation is available on demand and never required. The sprawl control is the token budget, not a reviewer: a fragment that packing never selects costs disk, not context. A gated write-then-approve model was considered and rejected — with no existing curation habit (evidenced by 74 features and zero authored `context.md` files), an approval queue would most likely leave the read path permanently empty.

### 5. Configuration

Under `context.v2`, following the existing config-patterns rules (defaults in the Zod schema, not a hand-maintained literal):

| Key | Default | Meaning |
|:---|:---|:---|
| `fragments.enabled` | `false` | Master switch for capture and read |
| `fragments.decay` | `0.6` | Per-distance score multiplier |
| `fragments.maxTokens` | `400` | Hard cap on one fragment |
| `fragments.extractor` | `"deterministic"` | `"deterministic"` \| `"llm"` — stage 2 flips the default |

Shipping off by default matches every prior v2 phase and lets the feature be measured before it is trusted.

### 6. Failure handling

- **Capture is best-effort and non-fatal.** A story must never fail because its fragment did not write, matching the effectiveness annotation it sits beside (`logger.debug` + continue).
- **A missing or unreadable fragment is a skip, not an error** — the dependency walk continues.
- **A missing or malformed `prd.json`** yields no fragment chunks; the provider still returns its `context.md` chunk as it does today.
- **A dependency cycle terminates** via the visited set rather than recursing.

### 7. Testing

Behavioural tests, no grep or file-content assertions:

- Closure correctness: linear chain, diamond dependency (a story reached by two paths appears once, at its shortest distance), cycle, missing fragment mid-chain.
- Decay: a distance-2 fragment scores below a distance-1 fragment; ordering survives into the packed bundle.
- Budget: under a budget that fits only some fragments, the most distant are dropped first.
- Isolation: a story with no dependencies receives no fragments; a sibling story's fragment never appears.
- Capture: a passing story writes exactly one fragment; a failing story writes none; a capture failure does not fail the story.

**Mutation check required.** Reverting the decay computation must fail at least one test. Two prior incidents in this subsystem shipped inert wiring past a fully green suite — the `execution.ts` `callCtx` edge (2996 tests green while the feature was dead in production) and gap item §11. A green suite is not evidence that this feature is wired.

## Known limitations

- **Batch mode captures nothing.** The completion block is guarded by `!isBatch`, so batch runs write no fragments. This inherits the same limitation as effectiveness annotation (gap item §9c) and is accepted rather than widened here.
- **Value is unproven.** The provider this feature feeds has returned nothing for 74 features without anyone noticing. Stage 1 is deliberately small so the question "do fragments actually help?" can be answered before paying for the LLM extractor.

## Consequences for the gap report

Closes the capture half of §21. Explicitly does **not** close: the summarizer, the promotion gate, or the missing `STAGE_CONTEXT_MAP` entries for `context-extract` / `context-summarize` — that last item is independent of this design and remains a standalone cheap win.
