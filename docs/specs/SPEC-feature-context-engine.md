# SPEC: Feature Context Engine (CONTEXT-001)

## Summary

Add a **feature-scoped context engine** that accumulates decisions, constraints, and gotchas discovered during a multi-story feature build, and feeds that context back into every subsequent story in the same feature. Context is stored per-feature (not globally), grows during the feature's lifecycle, and is archived when the feature merges. A promotion gate surfaces genuinely-general learnings as candidates for permanent project rules.

The goal is to close the **pre-coding context gap**: fresh nax sessions start without the accumulated "why" from prior phases of the same feature, and re-discover constraints the hard way — sometimes taking the wrong path before being corrected by review. Review-stage fixes catch the symptom after the code is written; the context engine prevents the wrong path from being taken in the first place.

## Motivation

`logs/code-quality-gap.md` identified four quality gaps in PR 384/385, one of which is categorically different from the others:

> **Context quality at the moment of coding.** The other session likely started from a task brief or the next-phase spec without having built Phases 1–4 itself. The session that built Phases 1–4 had full context of why each decision was made — the Biome `noStaticOnlyClass` constraint, the barrel import cycle avoidance pattern, what `_deps` injection looks like in this codebase. That history shapes better judgment on edge cases.

Three of the four gaps (`_`-prefixed params, missing sibling test, dual import styles) are **defects in output** — catchable by a sufficiently skeptical reviewer. The fourth is a **defect in input**: the session never had the context needed to make the right call. No amount of reviewing can fix work that started from the wrong foundation.

Currently, every nax story runs as a fresh agent session. Context for that session comes from:

- `CLAUDE.md` + `.claude/rules/*.md` — static, human-curated, read by every session
- `src/context/` — auto-detected project context (tech stack, directory structure)
- `src/constitution/` — behavioral rules per agent type
- `docs/adr/` — architecture decisions, but not auto-injected into prompts
- The story's own PRD + ACs (from `prd.json`)
- The current git state

**What's missing from this stack:** a loop that captures what a session learned *during* a feature build and hands it forward to the next story in the same feature. Session-local knowledge dies with the session.

### Why not global learnings

Explored and rejected in the conversation that produced this SPEC. Promoting every learned pattern to `.claude/rules/` causes:

- **Sprawl.** Rules accumulate monotonically. `learned-patterns.md` grows to hundreds of lines over time; agents stop reading it carefully.
- **Relevance dilution.** A rule specific to the prompt-refactor work is read by every session for every future feature. Irrelevant context is noise; noise hurts agent judgment.
- **Rot.** Global rules can become wrong when the codebase evolves. Auditing stale global rules is expensive human work.
- **Context budget.** Global rules consume prompt tokens for every session, even when irrelevant.

Feature-scoped context solves all four: it's disposed with the feature, only read by sessions working on that feature, naturally bounded in lifetime, and only consumes prompt budget when it's relevant.

### Why not rely on PR descriptions

PR descriptions do capture some of this knowledge, and the cheapest manual workaround is "write a good `## Learnings` section in each PR and reference prior PRs in the next phase's PRD." But PR descriptions are:

- **Per-PR, not per-feature.** A multi-phase feature with 6 PRs has 6 scattered descriptions, not one coherent context.
- **Optimized for humans, not agents.** Written as change narratives, not as structured decisions.
- **Not auto-injected into agent prompts.** An agent would have to be explicitly pointed at them.
- **Not compounding.** Each PR description is written fresh; it doesn't build on prior PRs' context.

A context engine structures the problem as "state that grows over the feature's life," which is different from "a series of independent narratives."

## Non-Goals

- **No global learning store.** Truly-general learnings reach `.claude/rules/` only via an explicit promotion gate, never by default from context engine output.
- **No cross-feature retrieval.** Archived feature contexts are not auto-loaded into new features. If a future refactor touches the same area, a human decides whether to seed the new feature's context from an archived one.
- **No replacement for CLAUDE.md, ADRs, or rules.** These remain the authoritative source for project-wide standards. The context engine is for feature-local working memory.
- **No persistent knowledge base / embedding index.** That's a different architecture (iterative retrieval). Context engine is file-based and simple.
- **No first-version automated write path.** Initial rollout is read-path-only with human-written context files. The extractor agent is Phase 2, gated on evidence that the read path pays off.
- **No default-on rollout.** Ships off by default; opted-in per feature until proven.

## Design

### Where It Fits

The engine has two insertion points in the nax pipeline:

```
┌─ Pre-story (read path) ───────────────────────────────┐
│  Feature-ID resolution → load context.md → inject    │
│  into agent prompt via src/context/                   │
└───────────────────────────────────────────────────────┘
                         ↓
              [execute → verify → rectify → review → autofix]
                         ↓
┌─ Post-story (write path, optional) ───────────────────┐
│  On review pass → extractor LLM call → append to     │
│  context.md fragment → merge at phase boundary       │
└───────────────────────────────────────────────────────┘
                         ↓
┌─ Post-feature (promotion gate, on merge) ─────────────┐
│  Review context.md → surface general learnings as    │
│  PR comment or issue → human promotes to rules       │
│  Archive context.md → .nax/features/_archive/        │
└───────────────────────────────────────────────────────┘
```

The read path is cheap and should run on every story for opted-in features. The write path is more expensive (extra LLM call per story) and is opted-in separately.

### Storage Layout

Extends the existing `.nax/features/<feature-id>/` namespace without introducing new directories:

```
.nax/features/prompt-refactor/
├── prd.json                          # existing
├── acp-sessions.json                 # existing
├── progress.txt                      # existing
├── context.md                        # NEW — merged feature context
├── context.lock.json                 # NEW — metadata + provenance
└── context-fragments/                # NEW — per-story write buffers
    ├── US-001-20260401-a1b2c3.md
    ├── US-002-20260402-d4e5f6.md
    └── US-003-20260403-...
```

**`context.md`** — the canonical, agent-facing file. This is what gets injected into every subsequent story's prompt. It is append-and-summarize: new content gets added, and the summarization gate (below) rewrites the file when it exceeds budget.

**`context.lock.json`** — metadata:

```json
{
  "featureId": "prompt-refactor",
  "createdAt": "2026-04-12T10:00:00Z",
  "lastUpdatedAt": "2026-04-12T14:22:00Z",
  "lastSummarizedAt": "2026-04-12T13:00:00Z",
  "entriesCount": 14,
  "budgetTokens": 2048,
  "currentTokens": 1670,
  "source": "manual" | "extractor" | "mixed",
  "contributions": [
    { "storyId": "US-001", "at": "2026-04-12T10:30:00Z", "tokens": 220, "author": "extractor" },
    { "storyId": "US-002", "at": "2026-04-12T11:15:00Z", "tokens": 180, "author": "manual" }
  ]
}
```

**`context-fragments/`** — per-story write buffer directory. Each story that writes context produces a fragment file, not a direct edit to `context.md`. Fragments are merged into `context.md` at phase boundaries (or immediately in sequential mode). This is the primary mechanism for **parallel-execution safety** — see below.

### Data Format — `context.md`

Plain Markdown with a light structural convention. Not JSON, not YAML-frontmatter-heavy — the file is agent-facing and plain Markdown is what LLMs read most reliably.

```markdown
# Feature Context — prompt-refactor

_Last updated: 2026-04-12. Source: extractor + manual. Entries: 14._

## Decisions

- **Barrel imports for builders.** All builders under `src/prompts/builders/`
  are imported via the barrel at `src/prompts/index.ts`, never via deep paths
  like `src/prompts/builders/review-builder.ts`. Reason: avoids a circular
  import between `semantic.ts` → `review-builder.ts` → `review/types.ts`.
  _Established in: US-001 (commit a1b2c3)_

- **Types live in `review/types.ts`, not `review/semantic.ts`.** Builder
  files import types from `review/types.ts` to prevent cycles when
  semantic.ts imports the builder.
  _Established in: US-001_

## Constraints

- **Biome `noStaticOnlyClass` rule is enabled.** Classes containing only
  static methods are rejected by lint. Use top-level functions instead,
  or mix at least one instance method into the class.
  _Discovered in: US-002 (during rectification loop)_

- **`_deps` injection pattern is mandatory for spawn/fs/fetch in new code.**
  See `docs/architecture/design-patterns.md` §7. Tests mock via `_deps`,
  not `mock.module()`.
  _Discovered in: US-003_

## Patterns Established

- **Builder test co-location.** Each new builder under
  `src/prompts/builders/<name>.ts` gets a matching
  `test/unit/prompts/<name>-builder.test.ts`. This pattern was established
  in US-001 and should be followed by subsequent phases.
  _Established in: US-001_

## Gotchas for Future Phases

- **Do not rename files in `src/prompts/` without updating the barrel
  `index.ts`.** The barrel is a single source of truth for exports;
  forgetting to update it causes a runtime failure that typecheck misses.
  _Flagged in: US-002_

## Rationale Archive

(Older entries, summarized. Full history is in `context-fragments/`.)

- Considered inline prompt strings in Phase 1 but switched to builder
  classes for testability. Builder classes expose `buildSomethingPrompt()`
  methods, not static-only. See US-001 for the full argument.
```

Five sections, stable headings: `Decisions`, `Constraints`, `Patterns Established`, `Gotchas for Future Phases`, `Rationale Archive`. The extractor agent writes into these sections; the read path injects the full file as-is.

### Feature-ID Resolution

A story knows its feature because nax stores stories inside `.nax/features/<feature-id>/prd.json`. The read path needs a function:

```typescript
function resolveFeatureId(story: Story, workdir: string): string | null {
  // Walk .nax/features/*/prd.json
  // Find the one whose userStories[] contains story.id
  // Cache the result
}
```

Cache the result per-run in `ctx` to avoid re-walking the feature directory. If no feature owns the story (ad-hoc one-off work), return `null` and the context engine is a no-op for that story.

**Edge cases:**

- **Story appears in two features** — configuration error; emit a warning, pick the first match.
- **Feature directory exists but `prd.json` is malformed** — log a warning, fall back to no-op.
- **Story ID not found in any feature** — treat as unattached; no context engine behavior.

### Read Path — Pre-Story Context Injection

Integrates into the existing `src/context/` stage. A new context provider implements the `IContextProvider` interface:

```typescript
// src/context/providers/feature-context.ts
export class FeatureContextProvider implements IContextProvider {
  async getContext(ctx: PipelineContext): Promise<string | null> {
    if (!ctx.config.context?.featureEngine?.enabled) return null

    const featureId = resolveFeatureId(ctx.story, ctx.workdir)
    if (!featureId) return null

    const contextPath = `.nax/features/${featureId}/context.md`
    const file = Bun.file(`${ctx.workdir}/${contextPath}`)
    if (!(await file.exists())) return null

    const content = await file.text()
    if (content.trim().length === 0) return null

    return formatForInjection(content, featureId)
  }
}

function formatForInjection(content: string, featureId: string): string {
  return `## Feature Context (${featureId})

The following context was accumulated by prior stories in this feature.
Read it carefully — it contains decisions, constraints, and gotchas that
should inform your work. Do not contradict these decisions without a
documented reason.

${content}

---
End of feature context.
`
}
```

This provider registers in the default provider chain and runs alongside the existing `CLAUDE.md` / rules / constitution providers. The injected block appears in the agent prompt before the story brief, so the agent reads it as background.

**Prompt ordering** matters. The sequence should be:

1. Project-level context (CLAUDE.md, rules, constitution)
2. **Feature-level context (this engine)** — new
3. Story-level context (PRD, ACs, contextFiles)
4. Runtime context (diff, current state)

Feature context is narrower than project and broader than story — it belongs between them.

**Budget enforcement.** The read path truncates `context.md` if it exceeds the configured token budget (default 2048 tokens). Truncation is tail-biased: keep the most recent entries, drop older ones to the `Rationale Archive` section. The summarization gate (below) is the primary defense against overflow; truncation is a safety net.

### Write Path — Post-Story Extraction

Runs after a story passes review. Opt-in via `context.featureEngine.write.enabled`.

**Trigger conditions:**

- Story state transitioned to `passed`
- Story belongs to a feature (feature ID resolved)
- `context.featureEngine.write.enabled` is `true`
- The feature has not yet been marked closed

**Mechanism:**

1. Assemble input for the extractor LLM call:
   - The story's diff (from the agent session)
   - The story's review findings (from `ctx.reviewFindings`)
   - The story's escalation history (how many retries, which tiers)
   - The current `context.md` (to prevent duplicating existing entries)
   - The extractor prompt (below)
2. Call the LLM via `getAgent(config.autoMode.defaultAgent)` with `sessionRole: "context-extractor"` and modelTier from config (default: `"fast"` — this is a cheap call).
3. Parse the JSON response into structured entries.
4. Write entries to a new fragment file: `context-fragments/<story-id>-<timestamp>-<commit-sha-short>.md`.
5. If sequential mode: merge the fragment into `context.md` immediately.
6. If parallel mode: defer merge to phase boundary.

**Extractor prompt:**

```
You are a context extraction agent. A story in a multi-story feature has just
completed successfully. Your job is to identify non-obvious constraints,
decisions, or patterns from this story that would help a future story in the
same feature avoid rediscovering them.

## Story
{story.id}: {story.title}
{story.description}

## Diff
```diff
{story.diff}
```

## Review findings (resolved)
{reviewFindings, both semantic and adversarial}

## Escalation history
{story.escalations}

## Existing feature context
{contextMd}

## Instructions

Identify up to 5 entries that meet ALL of these criteria:

1. **Non-obvious.** A future agent reading the final code would NOT realise
   this on their own. Rules like "files are under 400 lines" or "use TypeScript
   strict mode" are already in CLAUDE.md — do NOT capture them.

2. **Specific to this feature's scope.** A learning like "barrel imports
   avoid a circular dep between semantic.ts and review-builder.ts" is
   feature-specific. A learning like "use Bun APIs" is project-wide and
   belongs in CLAUDE.md, not here.

3. **Actionable.** A future story can use this information to make a
   different decision or avoid a mistake.

4. **Not already in the existing feature context.** Check the existing
   context for duplicates before proposing.

5. **Cited.** Reference a specific file, line, or symptom from the diff
   or findings. If you cannot cite evidence, do not propose the entry.

## Categories

Assign each entry to ONE of:
- "decision" — a chosen approach with rationale
- "constraint" — an external rule the code must satisfy
- "pattern" — a structural convention established for this feature
- "gotcha" — a trap future phases should avoid

## Output

Respond with JSON only:
{
  "entries": [
    {
      "category": "decision" | "constraint" | "pattern" | "gotcha",
      "title": "short headline",
      "body": "1-3 sentences of detail",
      "evidence": "file path, line, or symptom citation",
      "appliesTo": "which subsequent phases / files this is relevant for"
    }
  ]
}

If the story yielded no learnings worth capturing, respond with
{ "entries": [] }. Empty is acceptable and often correct.
```

The prompt is deliberately narrow — most stories should produce zero or one entry. The extractor should err on the side of silence rather than noise.

**Cost envelope.** One LLM call per passing story, using `fast` tier (cheap), with bounded input (diff + findings + existing context). Rough estimate: $0.01–0.05 per story. Tunable via `modelTier` knob.

### Fragment Merge — Parallel Execution Safety

Nax supports parallel story execution. If two stories in the same feature finish concurrently and both try to append to `context.md`, they race.

**Solution:** per-story fragment files written independently, merged into `context.md` at a serialization point.

1. Each story writes to `.nax/features/<id>/context-fragments/<storyId>-<ts>-<sha>.md`. No two stories ever target the same fragment file. No lock needed.
2. A **fragment merger** runs:
   - In **sequential mode**, immediately after each story's write.
   - In **parallel mode**, at a phase boundary (when a batch of parallel stories completes) or at run completion (via `postRunPipeline`).
3. The merger reads all unmerged fragments, integrates them into `context.md` under the correct sections, updates `context.lock.json`, and deletes (or archives) the fragments.

Merge logic is deterministic:

- Entries are grouped by category and appended to the corresponding section.
- Duplicates (same `title` or high text overlap) are deduped — keep the earlier one.
- Ordering within a section is chronological by story ID.

The merger runs inside the single-threaded run completion phase, so it has no concurrency of its own to worry about.

**Advisory lock for safety.** The merger acquires a simple file lock on `context.md.lock` before reading+writing. If a second merger somehow runs concurrently, it waits or fails fast. With the fragment-file design, this is belt-and-suspenders.

### Summarization Gate

`context.md` grows linearly with the feature. Without bounds, it eventually exceeds the prompt budget and crowds out the actual story brief. Two safeguards:

**1. Hard token budget** (`context.featureEngine.budgetTokens`, default 2048). The read path truncates if exceeded. Truncation is tail-biased and emits a warning.

**2. Summarization gate** (runs at phase boundary or on growth threshold). An LLM pass reads `context.md` and rewrites it into a tighter form that preserves decisions/constraints/patterns but compresses rationale:

```
You are a context summarizer. The following feature context file has grown
large and needs compaction before the next story reads it. Your job is to
produce a tighter version that preserves all actionable information and
compresses detail.

Rules:
- Preserve every entry in `Decisions`, `Constraints`, `Patterns Established`,
  and `Gotchas for Future Phases` sections. Never drop an entry.
- Compress the body text of each entry to 1-2 sentences maximum.
- Preserve the citation for each entry (file path, story ID, commit).
- Move the "body" or explanatory detail of older entries into the
  `Rationale Archive` section if it's no longer load-bearing.
- Keep the overall file under {budget} tokens.

Output the new Markdown directly. No JSON wrapper.
```

**When to trigger summarization:**

- At phase boundary (a group of stories completes) if `context.md` exceeds 75% of the budget.
- At run completion regardless, if the file was modified this run.
- Never mid-story (would race with the reader).

**Summarization itself is an LLM call** and thus has cost. It runs at most a few times per feature (once per phase boundary that triggers it), so total cost is bounded.

### Lifecycle

**Creation.** `context.md` does not exist until the first write. The read path gracefully handles absence (returns no injection). The first write creates the file, initializes `context.lock.json`, and creates the `context-fragments/` directory.

**Updates.** Writes go to fragments; the merger integrates them into `context.md`.

**Manual edits.** A human MAY edit `context.md` directly. The lock file's `source` field updates to `"mixed"`. The extractor is instructed (via its prompt) to respect existing entries and avoid conflict.

**Archival (on feature merge).** When a feature's PR merges to main, the context should be archived, not deleted. A post-merge hook (manual initially, automated later) moves:

```
.nax/features/prompt-refactor/
├── context.md
├── context.lock.json
└── context-fragments/
```

to:

```
.nax/features/_archive/prompt-refactor/
├── context.md
├── context.lock.json
└── context-fragments/        # fragments preserved for audit
```

Archived contexts are **not read by default**. A future feature that wants to seed from an archive can explicitly reference it via `feature.seedFromArchive: "prompt-refactor"` in its PRD — a manual decision.

**Disposal.** Archived contexts accumulate in `.nax/features/_archive/` indefinitely. They're small Markdown files with low storage cost. A separate housekeeping command (`nax context prune --older-than 180d`) can remove them.

### Promotion Gate — Feature-Local to Project-Wide

At feature close (archival), some learnings may generalize beyond the feature. The promotion gate surfaces candidates:

1. **Trigger.** Runs at archival, after the feature merges.
2. **Input.** The final `context.md`.
3. **Process.** An LLM pass reads the context and asks: *"Which of these entries describe constraints or patterns that apply project-wide, beyond this specific feature? An entry generalizes if a developer working on any part of the codebase would benefit from knowing it. Most entries should NOT generalize."*
4. **Output.** A list of candidate promotions with suggested target files (`CLAUDE.md`, `.claude/rules/project-conventions.md`, `.claude/rules/forbidden-patterns.md`, etc.).
5. **Action.** Never automatic. The candidates are emitted as:
   - A PR comment on the merged PR with suggested edits
   - OR an issue titled "Review candidate project rules from feature X"
   - OR a local file `candidate-promotions.md` for the developer to review
6. **Human decides.** Promotion requires a human to edit the target file. The context engine never writes to `.claude/rules/` or `CLAUDE.md` directly.

**Why manual?** Auto-promoting to global rules would reintroduce the sprawl problem the feature-scoped design specifically avoids. The promotion gate exists so the path from local-to-global is *possible*, not *automatic*.

## Config

New config section at `src/config/schemas.ts`:

```typescript
const FeatureContextWriteConfigSchema = z.object({
  enabled: z.boolean().default(false),           // opt-in: runs extractor post-story
  modelTier: ModelTierSchema.default("fast"),    // extractor LLM tier
  timeoutMs: z.number().int().min(10_000).default(60_000),
  maxEntriesPerStory: z.number().int().min(0).default(5),
});

const FeatureContextEngineConfigSchema = z.object({
  enabled: z.boolean().default(false),           // master switch (read path)
  budgetTokens: z.number().int().min(256).default(2048),
  summarization: z.object({
    enabled: z.boolean().default(true),
    triggerFraction: z.number().min(0).max(1).default(0.75),
    modelTier: ModelTierSchema.default("balanced"),
  }).default({}),
  write: FeatureContextWriteConfigSchema.default({}),
  promotion: z.object({
    enabled: z.boolean().default(false),         // runs at feature archival
    modelTier: ModelTierSchema.default("balanced"),
    output: z.enum(["pr-comment", "issue", "local-file"]).default("local-file"),
  }).default({}),
});

// Attach to ContextConfigSchema
const ContextConfigSchema = z.object({
  // ...existing fields
  featureEngine: FeatureContextEngineConfigSchema.optional(),
});
```

**Defaults justification:**

- `enabled: false` at both master and write levels — opt-in feature, conservative rollout.
- `budgetTokens: 2048` — about 8 KB of Markdown, enough for ~15 entries with moderate detail.
- `summarization.triggerFraction: 0.75` — summarize before the budget is hit, not after, to avoid mid-story truncation.
- `write.modelTier: "fast"` — extractor runs frequently, use a cheap model.
- `summarization.modelTier: "balanced"` — summarization quality matters more than frequency; runs rarely.
- `maxEntriesPerStory: 5` — cap per story, primary defense against noise.
- `promotion.output: "local-file"` — least intrusive; surface candidates without auto-commenting on PRs.

### Opt-In Levels

Users can enable the engine at three graduated levels:

| Level | Config | Behavior |
|:---|:---|:---|
| **Off** | `enabled: false` | No-op. Default. |
| **Read-only** | `enabled: true, write.enabled: false` | Engine reads existing `context.md` files (human-written). No extractor. Cheapest way to benefit. |
| **Read + Write** | `enabled: true, write.enabled: true` | Engine reads and the extractor writes. Full loop. |
| **Read + Write + Promote** | `enabled: true, write.enabled: true, promotion.enabled: true` | Full loop + archival promotion candidates. |

The **read-only** level is the important one for rollout: it lets users manually curate `context.md` during a feature build and see whether injection actually helps, before committing to the cost of the extractor.

## File Surface

### New files

- `src/context/providers/feature-context.ts` — the `IContextProvider` implementation (read path)
- `src/context/feature-resolver.ts` — `resolveFeatureId(story, workdir)` helper with caching
- `src/context/feature-writer.ts` — fragment writer (write path)
- `src/context/feature-merger.ts` — fragment merger (runs at phase boundary / run completion)
- `src/context/feature-summarizer.ts` — summarization gate
- `src/context/feature-promotion.ts` — promotion gate (runs at archival)
- `src/prompts/builders/context-extractor-builder.ts` — extractor prompt builder
- `src/prompts/builders/context-summarizer-builder.ts` — summarizer prompt builder
- `src/prompts/builders/context-promotion-builder.ts` — promotion-gate prompt builder
- `test/unit/context/feature-context.test.ts` — read-path unit tests with `_deps` mocking
- `test/unit/context/feature-resolver.test.ts` — resolver tests (cache, edge cases)
- `test/unit/context/feature-merger.test.ts` — fragment merge logic
- `test/unit/context/feature-summarizer.test.ts` — summarization invariants (never drops entries)
- `test/integration/context/feature-engine-end-to-end.test.ts` — full feature lifecycle
- `test/integration/context/feature-engine-parallel.test.ts` — parallel story fragment merge

### Modified files

- `src/config/schemas.ts` — add `FeatureContextEngineConfigSchema` under `ContextConfigSchema`
- `src/config/types.ts` — re-export new types
- `src/context/index.ts` — register `FeatureContextProvider` in the provider chain
- `src/context/types.ts` — extend `IContextProvider` surface if needed for ordering
- `src/execution/lifecycle/run-completion.ts` — run the fragment merger and summarization gate at run end
- `src/pipeline/stages/capture.ts` — new post-review stage that runs the extractor on passing stories (see **New pipeline stage** below)
- `src/pipeline/default-pipeline.ts` — register the capture stage after review
- `src/agents/types.ts` — add `"context-extractor"`, `"context-summarizer"`, `"context-promoter"` as recognized `sessionRole` values (currently free-form string; this is documentation-level)
- `src/metrics/story-metrics.ts` — add `contextEngine` sub-bucket for cost/token tracking
- `CLAUDE.md` / `.claude/rules/` — document the feature context convention so humans know what `context.md` is when they see it in `.nax/features/`

### New pipeline stage: `capture`

Runs after review (and after autofix, if it fired) but before the story is marked final. Only executes if:

- Story state is `passed`
- `config.context.featureEngine.write.enabled` is true
- Feature ID resolves

Stage responsibilities:

1. Build the extractor input (diff, findings, escalations, existing context)
2. Call the extractor via `agent.complete()` with `sessionRole: "context-extractor"` and `jsonMode: true`
3. Validate the JSON response against the expected schema
4. Write the fragment file
5. Log metrics (entries produced, cost, tokens)

On extractor failure (LLM error, JSON parse error, timeout): log a warning and continue. Never fail the story because the extractor failed — the context engine is best-effort.

The capture stage is **new to the default pipeline** and slots in between `review` and the existing post-review steps. Pipeline modification:

```typescript
// src/pipeline/default-pipeline.ts
export const defaultPipeline = [
  // ...existing stages
  reviewStage,
  autofixStage,
  captureStage,   // NEW — runs only if context engine + write are enabled
  // ...
]
```

## Migration

### No breaking changes

The feature is entirely additive:

- `FeatureContextEngineConfigSchema` is optional under `ContextConfigSchema`.
- The capture stage is a no-op when disabled.
- The `FeatureContextProvider` returns `null` when disabled, integrating cleanly with the provider chain.
- Existing features with no `context.md` file are unaffected.

### Retroactive application to in-flight features

A user who enables the engine partway through a feature can:

1. Write an initial `context.md` manually, seeding it with decisions from completed phases (reading PR descriptions).
2. Turn on `enabled: true, write.enabled: false` — the read path starts injecting immediately, extractor does not run.
3. Optionally turn on `write.enabled: true` for subsequent stories.

No retroactive extraction — historical stories do not get re-processed.

## Rollout Plan

### Phase 0 — Manual proof of concept (zero code)

Before writing any code, validate the hypothesis manually on one real feature:

1. Pick a multi-phase refactor (next prompt-refactor-style work).
2. As each phase's PR merges, manually write `.nax/features/<id>/context.md` capturing the decisions, constraints, and gotchas from that phase.
3. Start the next phase's session by **manually** adding `context.md` to its context files (via `--context` or the story's `contextFiles` array).
4. Observe: does the subsequent phase's session show measurably better context-awareness? Fewer re-discovered constraints? Less review rework?

If this doesn't help, the engine won't either — abort or redesign. If it does help, the evidence justifies Phase 1.

### Phase 1 — Read path only

- Ship `FeatureContextProvider` + `resolveFeatureId` + config schema.
- `enabled: false` by default.
- Users manually write `context.md`; engine auto-injects.
- Add the read-path integration tests.
- Measure: how often is `context.md` present? When present, does it reduce escalation rates or review findings? (Tracked via metrics.)

### Phase 2 — Write path (extractor)

- Ship `feature-writer.ts`, `feature-merger.ts`, `context-extractor-builder.ts`.
- Ship the capture stage.
- `write.enabled: false` by default.
- Users opt in per-feature.
- Measure: extractor quality (human audit of output), cost per story, how often extracted entries actually get cited or referenced by subsequent stories.

### Phase 3 — Summarization gate

- Ship `feature-summarizer.ts`.
- Defaults to `enabled: true` (summarization is a safety feature, not a behavioral change).
- Triggered only at phase boundaries.

### Phase 4 — Parallel-safe fragment merge

- Fragment files exist from Phase 2 onward, but merging in parallel mode requires the run-completion merger.
- Ship and test parallel story fragment merge in this phase.
- Gate with an integration test that spawns 4 parallel stories and verifies no lost fragments.

### Phase 5 — Promotion gate

- Ship `feature-promotion.ts` and the promotion-gate prompt.
- Runs at feature archival.
- Default `output: "local-file"` — least intrusive.
- Opt-in to `output: "pr-comment"` once the promotion candidates are seen to be high-signal.

### Phase 6 — Measurement and tuning

- Collect metrics across several features over a few weeks.
- Tune defaults: budget, summarization trigger, extractor prompt, maxEntriesPerStory.
- Decide whether to flip `enabled` to `true` by default.

### Rollback

- Set `enabled: false` — engine goes completely silent.
- Delete `.nax/features/*/context.md` if desired — no code depends on them.
- All stages handle absence gracefully.

## Risks

### Extractor hallucinations

The extractor agent may invent constraints that don't actually exist, or misattribute decisions. **Mitigations:**

- Prompt requires citation (file path, commit, symptom) for every entry.
- Extractor sees only the actual diff + findings, not speculation.
- Human audit of the first N features before flipping defaults.
- Context entries reference their source story and commit SHA, so claims are traceable.
- If an entry becomes wrong, a subsequent human edit to `context.md` corrects it.

### Context file as a source of outdated guidance

An entry written at US-001 may become wrong by US-012 due to changes in the feature itself. A future story reads stale guidance and makes a wrong decision. **Mitigations:**

- Summarization gate is an opportunity to spot contradictions (one entry contradicts a later one).
- The extractor, when reading `existing context`, is instructed to flag contradictions: `"If an entry you would add contradicts an existing entry, note the contradiction in your response."` (This is an extension to the extractor prompt for later phases.)
- Feature closure is the natural GC — stale entries die with the feature.
- Manual editing is always allowed and expected.

### Over-capture noise

If the extractor fires on every story and produces 5 entries each, a 20-story feature accumulates 100 entries. Even with summarization, the file gets unwieldy. **Mitigations:**

- `maxEntriesPerStory` cap (default 5).
- Extractor prompt explicitly instructs to err on the side of silence.
- Summarization gate compresses aggressively.
- Budget ceiling with tail-biased truncation as a safety net.

### Extraction cost

One LLM call per passing story, plus summarization calls, plus the promotion-gate call at archival. Adds up. **Mitigations:**

- `modelTier: "fast"` for the extractor — cheap per call.
- Opt-in, so cost is only paid when the user chose to pay it.
- Metrics bucket (`metrics.contextEngine.cost`) makes cost visible.

### Parallel merge conflicts

Fragment files prevent concurrent writes to `context.md`, but the merger itself must handle the case where two fragments propose contradictory entries. **Mitigations:**

- Deterministic merge order (by story ID) gives a canonical resolution.
- Dedup on title/high-overlap body.
- Both contradicting entries are preserved if dedup doesn't catch them — a later summarization pass surfaces the contradiction.

### Privacy and secret leakage

The extractor reads diffs; diffs can contain secrets, API responses, user data. Writing these into `context.md` is a leak, especially if the file is committed to git. **Mitigations:**

- The extractor prompt explicitly excludes capturing literal values: *"Do not include literal secret values, API keys, user data, or the contents of environment variables. If a gotcha involves a secret, describe the mechanism abstractly."*
- `context.md` is in `.nax/features/` which should be gitignored or carefully reviewed before commit. (The existing `.nax/features/` convention needs verification here — see **Open Questions**.)
- A post-extractor redaction pass using regex for common secret patterns (AWS keys, tokens) provides a second layer.

### Interaction with adversarial review

Adversarial review catches abandonment signals post-hoc. Context engine prevents some of those signals by giving the agent better starting context. There's no conflict — they're complementary. But there is a risk that the engine captures advice like "always use `_` prefix for unused parameters" based on a misread of past work, which would actively train agents to produce the wrong pattern. **Mitigation:** the extractor prompt should exclude capturing workarounds as patterns. `_` prefixes in particular are an anti-pattern and should never appear in `context.md`.

### `context.md` becomes a second CLAUDE.md

If users start writing project-wide conventions into `context.md` instead of `CLAUDE.md`, the feature-scoped design is undermined. **Mitigation:** the read path's injection header is explicit that context is feature-scoped: *"The following context was accumulated by prior stories in this feature."* The extractor prompt explicitly rejects capturing project-wide rules. Documentation in CLAUDE.md explains the distinction.

## Open Questions

1. **Is `.nax/features/` gitignored by default, or committed?** This materially affects the design:
   - **Committed:** `context.md` becomes part of the repo, reviewable in PRs, version-controlled. Promotion to `CLAUDE.md` is less urgent because `context.md` itself is durable. Secrets risk is higher.
   - **Gitignored:** `context.md` is local state, ephemeral across clones, machine-specific. Harder to share between team members working on the same feature. Secrets risk is lower.

   Need to check the current nax convention and decide. If `.nax/features/` is currently mixed (some committed, some not), the context engine needs its own decision.

2. **Should `context.md` be human-readable Markdown (current design) or structured JSON?** Markdown is LLM-friendly and human-editable. JSON is queryable and type-safe but harder to edit. Markdown wins for the agent-facing use case, but a JSON sidecar (`context.entries.json`) for metrics and querying may be worth adding.

3. **How does the engine interact with `constitution` and `src/context/` existing providers?** Need to verify the provider chain supports ordered injection (project → feature → story) without duplication or conflict.

4. **What happens when a story is part of no feature?** Current design: no-op. Alternative: per-run context scope, disposed at run end. The per-run scope adds complexity for a marginal benefit; recommend deferring until Phase 6 evidence shows it's needed.

5. **Does the capture stage run on escalation retries?** If a story escalated from `fast` → `balanced` → `powerful`, the final successful attempt is what the extractor sees. Escalation history is input but the diff is the final state. This seems right, but worth confirming the desired behavior.

6. **Summarization determinism.** An LLM-driven summarizer produces different output on each run. If two runs summarize the same file, `context.md` can churn. Is this acceptable? Options: (a) cache summaries by input hash, (b) seed the LLM with a stable temperature of 0, (c) accept the churn. Probably (b) plus (a) for safety.

7. **Archive retention policy.** `.nax/features/_archive/` grows unboundedly. Is there a housekeeping command? Should archives older than N days be deleted? Deferred to a follow-up spec.

8. **Cross-feature seeding.** `feature.seedFromArchive: "prior-feature-id"` in the new feature's PRD. Does this get implemented in the initial rollout or deferred? Recommend deferred — ship the basic loop first, add seeding only if a real use case arises.

## Acceptance Criteria

1. **Config:** `context.featureEngine` is an optional config section that validates against `FeatureContextEngineConfigSchema`. Configs without it parse unchanged.

2. **Feature resolution:** `resolveFeatureId(story, workdir)` returns the correct feature ID when the story appears in exactly one `.nax/features/*/prd.json`, returns `null` when the story is unattached, and caches results per-run.

3. **Read path — absent file:** When `enabled: true` and no `context.md` exists, `FeatureContextProvider.getContext()` returns `null` and the agent prompt is unchanged.

4. **Read path — present file:** When `enabled: true` and `context.md` exists, the provider returns a formatted block containing the file contents wrapped in the injection header. The block is placed between project context and story context in the final prompt.

5. **Budget enforcement:** When `context.md` exceeds `budgetTokens`, the read path truncates to the budget and logs a warning. Truncation is tail-biased (most recent entries preserved).

6. **Write path — disabled:** When `write.enabled: false`, the capture stage runs as a no-op and produces no fragment files.

7. **Write path — enabled, successful extraction:** When `write.enabled: true` and a story passes review, the capture stage calls the extractor, receives a valid JSON response, writes a fragment file to `.nax/features/<id>/context-fragments/<storyId>-<ts>-<sha>.md`, and logs the contribution to `context.lock.json`.

8. **Write path — extractor failure:** When the extractor returns invalid JSON, times out, or fails, the story is not failed; a warning is logged and no fragment file is written.

9. **Fragment merge — sequential:** In sequential mode, fragments are merged into `context.md` immediately after each story. `context.md` reflects the latest state before the next story reads it.

10. **Fragment merge — parallel:** In parallel mode, fragments from concurrent stories are written independently without conflicts, and the run-completion merger integrates all fragments at run end. No fragments are lost; no fragment is merged twice.

11. **Merge — dedup:** If two fragments contain entries with identical titles or near-identical bodies, the merger keeps the earlier one (by story ID order) and discards the later.

12. **Summarization gate:** When `context.md` exceeds `triggerFraction * budgetTokens` at phase boundary, the summarizer runs and rewrites the file. After summarization, no entry is dropped from `Decisions`, `Constraints`, `Patterns Established`, or `Gotchas for Future Phases`; older rationale is moved to `Rationale Archive`.

13. **Summarization invariant:** Summarization is a property test — for any valid `context.md`, the summarized version contains every entry from the input (verified by title + citation), and the total token count is below budget.

14. **Metrics:** `StoryMetrics.contextEngine` is populated with `cost`, `tokens`, `wallClockMs`, `entriesWritten`, and `summarizationsRun` after a run with the engine enabled.

15. **Promotion gate — disabled:** When `promotion.enabled: false`, archival does not run the promotion gate and does not produce candidate files.

16. **Promotion gate — enabled:** When `promotion.enabled: true` and a feature is archived, the promotion gate runs and produces a `candidate-promotions.md` file (or PR comment / issue, per config) listing candidate entries for global rules. The gate never writes directly to `CLAUDE.md` or `.claude/rules/`.

17. **Archival:** On feature archival, `context.md`, `context.lock.json`, and `context-fragments/` are moved to `.nax/features/_archive/<feature-id>/`. The original directory's context files are removed. Non-context files (`prd.json`, etc.) are handled by existing nax archival logic, unchanged by this feature.

18. **Sessions differentiated:** The capture, summarization, and promotion LLM calls use distinct `sessionRole` values (`"context-extractor"`, `"context-summarizer"`, `"context-promoter"`) and are correlatable in logs via the first-class `sessionRole` field introduced by the adversarial review SPEC.

19. **No impact when disabled:** With `enabled: false` at every level, the pipeline's wall-clock time, cost, and output are indistinguishable from a run without this feature. Verified by diff on a reference run.

20. **Self-referential dogfooding:** This feature's own implementation, developed across multiple nax stories, uses the context engine (at `read-only` level initially) and `context.md` is manually maintained. The first real-world validation of the read path is the feature's own development.
