# SPEC: Context Engine v2 — Amendments

> **Status:** Draft. Four amendments to [SPEC-context-engine-v2.md](./SPEC-context-engine-v2.md) addressing gaps identified during review.

---

## Amendment A: Context Pollution Prevention

### Problem

The v2 spec has passive anti-pollution mechanisms (freshness scoring, role filtering, dedup, budget floors, manifests) but no active quality gates. Three gaps:

1. **No feedback loop.** A chunk the agent ignores or contradicts keeps getting injected at the same score in future stories. The system never learns "this context was unhelpful."
2. **No noise threshold.** A chunk with `score: 0.15` gets packed if budget allows. Fresh noise (1.3x freshness weight) can outrank stale signal.
3. **No chunk invalidation.** Feature context entries live until the feature is archived. A constraint established in US-001 but invalidated by US-005's implementation stays injected forever unless a human manually removes it.

### Design

#### A.1 Minimum score threshold

Add a `minScore` floor to `StageContextConfigSchema`. Chunks below this score are dropped during knapsack packing, even if budget allows.

```typescript
const StageContextConfigSchema = z.object({
  budgetTokens: z.number().int().min(256).default(2048),
  providerTimeoutMs: z.number().int().min(1000).default(5000),
  enabledProviders: z.array(z.string()).optional(),
  kindWeights: z.record(z.number()).default({}),
  minScore: z.number().min(0).max(1).default(0.1),  // NEW — chunks below this are dropped
  pull: z.object({ /* ... unchanged */ }).default({}),
});
```

**Behavior:**
- After score adjustment (step 5 in the push path), chunks with `final_score < minScore` are dropped.
- Dropped chunks appear in the manifest with `reason: "below-min-score"`.
- The budget floor for `static` and `feature` providers is exempt — those chunks bypass `minScore` (project rules must never be dropped by a relevance gate).
- Default `0.1` is deliberately low. Operators tune per-project.

**Why not zero?** Zero means "pack anything that fits," which lets garbage fill unused budget and dilute signal. Even a low threshold prevents genuinely irrelevant chunks from occupying space.

#### A.2 Chunk effectiveness signal

After a story completes, the orchestrator computes a per-chunk **effectiveness signal** based on downstream outcomes. This is not a feedback loop (no LLM call, no learning) — it is an **annotation on the manifest** that operators and future tooling can use.

```typescript
// Added to ContextManifest.chunks[]
interface ChunkManifestEntry {
  id: string;
  providerId: string;
  kind: ContextChunk["kind"];
  source: string;
  tokens: number;
  score: number;
  kept: boolean;
  reason?: string;
  effectiveness?: ChunkEffectiveness;  // NEW — populated post-story
}

interface ChunkEffectiveness {
  /** Was the chunk's advice followed in the agent's output? */
  signal: "followed" | "contradicted" | "ignored" | "unknown";
  /** Evidence for the signal (e.g., review finding that contradicted the chunk). */
  evidence?: string;
}
```

**How the signal is computed (deterministic, no LLM):**

| Signal | Condition |
|:-------|:----------|
| `followed` | A `decision` or `constraint` chunk whose key terms appear in the agent's output AND no review finding contradicts it |
| `contradicted` | A review finding explicitly names an approach the chunk recommended, with a negative verdict |
| `ignored` | The chunk was injected (kept=true) but no trace of its content appears in the agent's output, diff, or review findings |
| `unknown` | Default when none of the above conditions match cleanly |

**Scope:** Post-story analysis only. No runtime cost during the push path. Written to the manifest alongside existing fields. The orchestrator does not change chunk scores based on effectiveness — that is a future concern for a learning layer.

**Why not a full learning loop?** A score-decay mechanism that automatically lowers chunk scores across stories would be powerful but introduces non-determinism and debugging difficulty. The effectiveness signal is the foundation: it gives operators and future tooling the data needed to build learning, without baking a specific decay algorithm into v2.

#### A.3 Staleness flag for feature context entries

`FeatureContextProvider` annotates each chunk with a `staleCandidate: boolean` flag based on two heuristics:

1. **Age-based.** The entry's `_Established in: US-XXX_` story is more than `context.staleness.maxStoryAge` stories behind the current story (default: 10). The provider counts completed stories in the same feature after the establishing story.

2. **Contradiction-based.** A newer entry in the same `## Section` of `context.md` explicitly references the older entry's topic and changes the conclusion. Detection is keyword-overlap based (not LLM) — if two entries in the same section share >=3 significant terms and the newer one uses negation language ("no longer", "instead", "replaced", "removed", "deprecated"), the older entry is flagged stale.

**What stale does:**
- `staleCandidate: true` applies a score multiplier of `0.4` (configurable via `context.staleness.scoreMultiplier`).
- The manifest records `staleCandidate: true` on the chunk.
- On `nax context inspect`, stale candidates are highlighted with a warning.
- The chunk is NOT auto-removed. A human must edit `context.md` to remove or update it.

**Config:**
```typescript
const ContextStalenessConfigSchema = z.object({
  enabled: z.boolean().default(true),
  maxStoryAge: z.number().int().min(1).default(10),
  scoreMultiplier: z.number().min(0).max(1).default(0.4),
});

// Added to ContextEngineV2ConfigSchema
staleness: ContextStalenessConfigSchema.default({}),
```

#### A.4 Context pollution metrics

Add aggregate pollution indicators to `StoryMetrics.context`:

```typescript
interface ContextPollutionMetrics {
  /** Chunks dropped by minScore threshold. */
  droppedBelowMinScore: number;
  /** Chunks flagged as stale candidates. */
  staleChunksInjected: number;
  /** Chunks with effectiveness signal "contradicted" (post-story). */
  contradictedChunks: number;
  /** Chunks with effectiveness signal "ignored" (post-story). */
  ignoredChunks: number;
  /** Ratio: contradicted+ignored / total kept. Higher = more pollution. */
  pollutionRatio: number;
}
```

`nax status` surfaces `pollutionRatio` as a warning when it exceeds a threshold (default: 0.3). This tells operators "30% of injected context was ignored or contradicted — review your context.md."

### Acceptance criteria (Amendment A)

44. **Min-score threshold.** Chunks with `final_score < minScore` are excluded from knapsack packing. Manifest records them with `reason: "below-min-score"`. Budget-floor chunks are exempt.

45. **Effectiveness signal.** After story completion, each kept chunk in the manifest is annotated with `effectiveness.signal`. The signal is deterministic for fixed inputs (agent output, review findings, diff).

46. **Staleness flag.** `FeatureContextProvider` chunks from entries older than `maxStoryAge` are annotated `staleCandidate: true` and scored at `scoreMultiplier` of their original score. The manifest records the flag.

47. **Contradiction detection.** When two entries in the same `## Section` share >=3 significant terms and the newer uses negation language, the older is flagged stale.

48. **Pollution metrics.** `StoryMetrics.context.pollution` is populated with `droppedBelowMinScore`, `staleChunksInjected`, `contradictedChunks`, `ignoredChunks`, `pollutionRatio`. `nax status` warns when `pollutionRatio > 0.3`.

49. **No runtime cost.** Staleness detection runs during `FeatureContextProvider.fetch()` (read path). Effectiveness signal runs post-story (not on the push/pull hot path). Neither involves an LLM call.

---

## Amendment B: Execution Mode Stage Sequences

### Problem

The v2 spec defines a `Stage` type and a stage context map table, but only describes the three-session TDD flow in the progressive digest section. Four other execution modes — `single-session` (tdd-simple), `no-test`, `batch`, and `three-session-tdd-lite` — have distinct stage sequences that the spec should document explicitly, including how progressive digest and session scratch behave differently for each.

### Design

#### B.1 Stage sequences by execution mode

Each mode goes through a subset of the pipeline stages. The orchestrator calls `assemble()` at every stage that needs context. Stages without context injection (routing, constitution, regression) are not listed.

```
THREE-SESSION TDD (strict / lite)
  Three separate agent sessions; three assemble() calls with distinct roles.
  Progressive digest flows across all three sessions.

  assemble(plan,           role=planner)          budget: 3072
    |
    v  plan.digest
  assemble(tdd-test-writer, role=test-writer)     budget: 3072
    |
    v  test-writer.digest
  assemble(tdd-implementer, role=implementer)     budget: 4096
    |
    v  implementer.digest
  assemble(verify,          role=verifier)        budget: 512
    |  [if fail --> assemble(rectify)]            budget: 2048
    v  verify.digest
  assemble(review-semantic,  role=reviewer-sem)   budget: 3072
  assemble(review-adversarial, role=reviewer-adv) budget: 3072
    |  [if findings --> assemble(rectify)]
    v
  done


SINGLE-SESSION / TDD-SIMPLE
  One agent session with merged implementer+test-writer role.
  Only ONE assemble() call for the execution stage — no cross-session digest.
  Verify/review stages still get their own assemble() calls.

  assemble(plan,           role=planner)          budget: 3072
    |
    v  plan.digest
  assemble(single-session,  role=implementer)     budget: 4096
    |  audience filter: [all] + [implementer] + [test-writer]
    |  pull: query_rag, query_graph, query_neighbor
    v  single-session.digest
  assemble(verify,          role=verifier)        budget: 512
    |  [if fail --> assemble(rectify)]
    v  verify.digest
  assemble(review-semantic,  role=reviewer-sem)   budget: 3072
  assemble(review-adversarial, role=reviewer-adv) budget: 3072
    |  [if findings --> assemble(rectify)]
    v
  done


NO-TEST
  One agent session with implementer-only role. No verify stage.

  assemble(plan,           role=planner)          budget: 3072
    |
    v  plan.digest
  assemble(no-test,         role=implementer)     budget: 4096
    |  audience filter: [all] + [implementer]
    |  pull: query_rag, query_graph, query_neighbor
    v  no-test.digest
  assemble(review-semantic,  role=reviewer-sem)   budget: 3072
  assemble(review-adversarial, role=reviewer-adv) budget: 3072
    |  [if findings --> assemble(rectify)]
    v
  done

  NOTE: No verify stage. rectify after review findings goes directly to
  review again (no test-pass gate). Rectify push sources are reduced
  (no failure output from verify — only review findings in scratch).


BATCH
  One agent session processing multiple stories. Merged role.

  assemble(plan,           role=planner)          budget: 3072
    |  (plan covers all stories in the batch)
    v  plan.digest
  assemble(batch,           role=implementer)     budget: 4096
    |  audience filter: [all] + [implementer] + [test-writer]
    |  pull: query_rag, query_graph, query_neighbor
    |  NOTE: feature context may span multiple features if batch
    |        crosses feature boundaries — featureId in ContextRequest
    |        is the primary story's featureId
    v  batch.digest
  assemble(verify,          role=verifier)        budget: 512
    |  [if fail --> assemble(rectify)]
    v  verify.digest
  assemble(review-semantic,  role=reviewer-sem)   budget: 3072
  assemble(review-adversarial, role=reviewer-adv) budget: 3072
    |  [if findings --> assemble(rectify)]
    v
  done
```

#### B.2 Progressive digest behavior per mode

| Mode | Execution assemble() calls | Digest chain length | Cross-session learning |
|:-----|:---------------------------|:--------------------|:----------------------|
| three-session-tdd | 3 (test-writer, implementer, verifier) | 6+ (plan -> tw -> impl -> verify -> review -> rectify) | Yes — test-writer's discoveries reach implementer via digest |
| single-session / tdd-simple | 1 | 4+ (plan -> single -> verify -> review) | No cross-session digest within execution. Agent must discover everything in one pass |
| no-test | 1 | 3+ (plan -> no-test -> review) | No. Shortest chain |
| batch | 1 | 4+ (plan -> batch -> verify -> review) | No cross-session within execution |

**Gap this reveals:** Single-session and no-test modes have no mechanism for the test-writing and implementation phases to inform each other — the agent does both in one prompt. This is acceptable for simple stories but may hurt complex ones.

**Mitigation (no spec change needed):** The `plan` stage's digest partially compensates. A good plan tells the single-session agent "this story touches `semantic.ts`; existing tests use `_deps` pattern; fixture: `tempDir`" — facts that the test-writer session would have discovered in three-session mode. The plan stage should be weighted more heavily for single-session modes.

**Spec change:** Add a `planDigestBoost` multiplier to single-session stage config. When `stage ∈ { single-session, tdd-simple, no-test, batch }`, the plan digest chunk's score is boosted by `planDigestBoost` (default 1.5x) to compensate for the absent cross-session digest.

```typescript
// In StageContextConfigSchema
planDigestBoost: z.number().min(1).max(3).default(1.0),

// In stage-config.ts defaults for single-session modes
"single-session": { planDigestBoost: 1.5 },
"tdd-simple":     { planDigestBoost: 1.5 },
"no-test":        { planDigestBoost: 1.5 },
"batch":          { planDigestBoost: 1.5 },
```

#### B.3 Scratch writes per mode

Session scratch is written by pipeline stages, not by the orchestrator. The set of scratch entries varies by mode:

| Scratch entry | three-session-tdd | single-session | no-test | batch |
|:--------------|:------------------|:---------------|:--------|:------|
| plan digest | yes | yes | yes | yes |
| test-writer digest | yes | no (merged) | no | no (merged) |
| implementer digest | yes | no (merged) | no (merged) | no (merged) |
| verify output (pass/fail, coverage) | yes | yes | **no** | yes |
| rectify attempt summary | yes (if needed) | yes | yes (review-triggered only) | yes |
| review findings | yes | yes | yes | yes |
| autofix result | yes | yes | yes | yes |

For single-session / tdd-simple / batch, the single execution stage writes ONE digest entry covering both test-writing and implementation combined.

### Acceptance criteria (Amendment B)

50. **Stage sequences documented.** Each execution mode's assemble() call sequence, roles, budgets, and digest chain length are specified in the stage context map section.

51. **Plan digest boost.** For stages `single-session`, `tdd-simple`, `no-test`, and `batch`, the plan digest chunk's score is multiplied by `planDigestBoost` (default 1.5). Verified by comparing plan-digest inclusion in single-session vs three-session-tdd bundles.

52. **Scratch write coverage.** Each mode writes the correct set of scratch entries per the table in B.3. No-test mode produces no verify scratch entries. Single-session mode produces one combined execution digest (not separate test-writer + implementer digests).

53. **No-test rectify scope.** In no-test mode, rectify is triggered only by review findings (not verify failures). The rectify push sources exclude `failure output from verify` and include only `review findings from scratch`.

---

## Amendment C: Monorepo Scoping

### Problem

The v2 spec's `ContextRequest` includes `workdir: string` but no provider uses it for scoped resolution. The codebase has monorepo infrastructure (story.workdir, per-package config merging, per-package acceptance tests — shipped v0.47-v0.49), but the context engine ignores all of it. In a monorepo where `packages/api` uses Express and `packages/web` uses Next.js, every story gets the same context regardless of which package it targets.

### Design

#### C.1 Dual workdir in ContextRequest

Replace the single `workdir` with two fields:

```typescript
export interface ContextRequest {
  stage: Stage;
  role: Role;
  story: UserStory;
  featureId: string | null;
  sessionId: string;
  /** Absolute path to the repository root. Always set. */
  repoRoot: string;                                        // RENAMED from workdir
  /** Absolute path to the story's package directory. Equals repoRoot for non-monorepo. */
  packageDir: string;                                      // NEW
  config: NaxConfig;                                       // effective config (already merged per-package)
  agent: AgentTarget;
  hints?: { /* ... unchanged */ };
  query?: string;
}
```

**Resolution:**
```typescript
const repoRoot = ctx.workdir;                              // always repo root
const packageDir = ctx.story.workdir
  ? join(ctx.workdir, ctx.story.workdir)                   // monorepo: story's package
  : ctx.workdir;                                           // non-monorepo: same as root
```

For non-monorepo projects, `packageDir === repoRoot`. All existing provider logic works unchanged.

#### C.2 Provider scoping rules

Each provider resolves context using `packageDir` as primary scope, with `repoRoot` as fallback. The merge order mirrors config merge order (root < package):

| Provider | Scoping behavior |
|:---------|:-----------------|
| `StaticRulesProvider` | Read `.nax/rules/*.md` at `repoRoot`. Then overlay `<packageDir>/.nax/rules/*.md` if it exists. Package rules extend, not replace (file-level merge: same filename = package wins, unique filenames from both are included). |
| `FeatureContextProvider` | Resolve `featureId` by scanning `<repoRoot>/.nax/features/*/prd.json`. Feature context is always at repo root (features span packages). No change from v1. |
| `SessionScratchProvider` | Scratch path unchanged: `.nax/features/<id>/sessions/<sessionId>/scratch.jsonl`. Session is story-scoped, not package-scoped. No change. |
| `GitHistoryProvider` | Scoped to `packageDir`. `git log -- <packageDir>` instead of `git log`. Shows only commits touching the story's package. Falls back to repo-wide if `packageDir === repoRoot`. |
| `CodeNeighborProvider` | Scoped to `packageDir` by default. Import tracing stops at the package boundary unless the import resolves to a shared package (e.g., `packages/shared/`). Config-overridable: `context.providers[].options.neighborScope: "package" | "repo"`. Default: `"package"`. |
| `RagProvider` (future) | Index is repo-wide. Query results filtered by `packageDir` prefix when `neighborScope: "package"`. |

#### C.3 Per-package rules store

Extend `.nax/rules/` to support package-level overrides:

```
.nax/rules/                          <-- repo-level rules (always loaded)
  coding-style.md
  project-conventions.md
  testing.md

packages/api/.nax/rules/             <-- package-level rules (loaded for stories targeting packages/api/)
  testing.md                         <-- overrides repo-level testing.md for this package
  api-conventions.md                 <-- additional rules only for this package
```

**Merge logic (StaticRulesProvider):**

1. Load all `*.md` from `<repoRoot>/.nax/rules/` as repo-level chunks.
2. If `packageDir !== repoRoot`, load all `*.md` from `<packageDir>/.nax/rules/`.
3. For each package-level file:
   - If a repo-level file with the same name exists, the package-level file **replaces** it (not merged — the package file is the complete override for that topic).
   - If no repo-level file matches, the package-level file is added.
4. All loaded files are injected as `kind: "static"` chunks with budget floor protection.

**Why replace, not merge?** Per-file replacement is simpler to reason about and matches the config merge pattern (package config overrides root config per-key). Operators who want to extend rather than replace can reference the repo-level content in their package-level file manually.

#### C.4 Per-package feature context (non-goal)

Features remain repo-scoped. A feature like "auth-v2" may touch `packages/api` and `packages/web`. The feature's `context.md` is at `.nax/features/auth-v2/context.md`, not duplicated per package. Audience tags (`[implementer]`, `[test-writer]`) handle role-based filtering; package-based filtering is not added.

**Rationale:** Feature context captures cross-cutting decisions ("barrel imports avoid a cycle between semantic.ts and review-builder.ts"). These decisions often span packages. Per-package feature context would fragment this knowledge and create sync problems.

If a specific entry is relevant to only one package, the operator annotates it in the entry body (e.g., "Applies to `packages/api` only."). This is a documentation convention, not a system-level filter.

#### C.5 Per-package stage budgets

The `config` field in `ContextRequest` is already the effective (per-package merged) config. If a package config overrides `context.stages["tdd-implementer"].budgetTokens`, the orchestrator automatically uses the package-level value. No additional wiring needed — this falls out of existing per-package config merge (PKG-002).

Example:
```json
// packages/api/.nax/config.json
{
  "context": {
    "stages": {
      "tdd-implementer": { "budgetTokens": 6144 }
    }
  }
}
```

Stories targeting `packages/api/` get 6144-token budgets for the implementer stage; other packages use the repo-level default (4096).

#### C.6 Manifest and scratch paths

Unchanged. Both live under `.nax/features/<id>/stories/<storyId>/` and `.nax/features/<id>/sessions/<sessionId>/`, respectively. These are feature-scoped and story-scoped, not package-scoped.

The manifest records `packageDir` as metadata so `nax context inspect` can display which package the story targeted:

```typescript
export interface ContextManifest {
  storyId: string;
  stage: Stage;
  role: Role;
  sessionId: string;
  repoRoot: string;           // NEW
  packageDir: string;          // NEW
  generatedAt: string;
  chunks: Array<{ /* ... */ }>;
  pullCalls: Array<{ /* ... */ }>;
}
```

#### C.7 Config additions

```typescript
// Added to ProviderConfigSchema.options (provider-specific)
// For CodeNeighborProvider:
neighborScope: z.enum(["package", "repo"]).default("package"),

// For GitHistoryProvider:
historyScope: z.enum(["package", "repo"]).default("package"),
```

Example:
```json
{
  "context": {
    "providers": [
      { "id": "code-neighbor", "options": { "neighborScope": "package" } },
      { "id": "git-history", "options": { "historyScope": "repo" } }
    ]
  }
}
```

### Impact on existing types

**ContextRequest:** `workdir` renamed to `repoRoot`, `packageDir` added. All callers of `assemble()` updated to resolve both from `ctx.workdir` + `ctx.story.workdir`.

**ContextManifest:** `repoRoot` and `packageDir` added as metadata fields.

**IContextProvider.fetch():** No interface change. Providers read `req.repoRoot` and `req.packageDir` from the request. Existing providers that only use `req.workdir` are updated to use `req.repoRoot` (same value).

**StaticRulesProvider:** Gains per-package rules overlay logic.

**GitHistoryProvider, CodeNeighborProvider:** Gain `scope` option, default to `"package"`.

### Rollout

Monorepo scoping ships as part of Phase 3 (new providers). Per-package rules overlay ships as part of Phase 5.1 (canonical rules). No impact on Phase 0-2 (orchestrator + feature + scratch + digest).

Non-monorepo projects (where `story.workdir` is undefined) see zero behavioral change — `packageDir === repoRoot` everywhere.

### Risks

**Per-package rules drift.** Package-level rule files may diverge from repo-level over time. **Mitigation:** `nax rules lint` validates both levels; `nax status` warns when package rules shadow repo rules.

**Neighbor scope too narrow.** A story in `packages/api` may need to see imports from `packages/shared`, but `neighborScope: "package"` stops at the package boundary. **Mitigation:** CodeNeighborProvider resolves cross-package imports transitively up to depth 1 for packages in the workspace's `packages/` directory. Configurable via `options.crossPackageDepth: 0 | 1 | 2` (default: 1).

**Git history scope too narrow.** A commit touching both `packages/api` and `packages/shared` would be shown for `packages/api` stories but the diff would be filtered to `packages/api` paths only, potentially hiding relevant changes in shared code. **Mitigation:** commits that touch `packageDir` AND a known shared package are shown in full; shared packages detected from workspace config.

### Acceptance criteria (Amendment C)

54. **Dual workdir resolution.** `ContextRequest` has `repoRoot` (absolute repo path) and `packageDir` (absolute package path). For non-monorepo stories, `packageDir === repoRoot`.

55. **GitHistoryProvider package scope.** With `historyScope: "package"`, git history is limited to `packageDir` paths. With `historyScope: "repo"`, full repo history is used. Default: `"package"`.

56. **CodeNeighborProvider package scope.** With `neighborScope: "package"`, import tracing stops at the package boundary except for shared packages (depth 1 by default). With `neighborScope: "repo"`, full repo tracing. Default: `"package"`.

57. **Per-package rules overlay.** `StaticRulesProvider` loads `<repoRoot>/.nax/rules/*.md`, then overlays `<packageDir>/.nax/rules/*.md`. Same-name files: package wins. Unique files: both included.

58. **Feature context remains repo-scoped.** `FeatureContextProvider` resolves features at `repoRoot`. `packageDir` does not affect feature context resolution.

59. **Per-package stage budgets.** A package config that overrides `context.stages["tdd-implementer"].budgetTokens` is respected by the orchestrator. Verified by comparing budgets for stories in different packages.

60. **Manifest records package.** `ContextManifest` includes `repoRoot` and `packageDir`. `nax context inspect` displays which package the story targeted.

61. **Non-monorepo no-op.** When `story.workdir` is undefined, behavior is identical to pre-amendment. No config change required.

62. **Cross-package neighbor resolution.** CodeNeighborProvider resolves imports from shared packages (e.g., `packages/shared/`) up to `crossPackageDepth` (default 1), even when `neighborScope: "package"`.

---

## Amendment D: Centralized Session Manager

### Problem

Session lifecycle is currently owned by individual agent adapters, not by the pipeline:

1. **ACP adapter (`src/agents/acp/adapter.ts`)** manages sessions via sidecar files (`.nax/features/<feature>/acp-sessions.json`), deterministic name generation (`nax-<hash8>-<feature>-<storyId>-<role>`), and conditional close-on-success logic.
2. **CLI adapter (`src/agents/claude/`)** has its own session concept, disconnected from ACP's.
3. **No `sessionId` on `PipelineContext`** — session names are reconstructed from `(workdir, feature, storyId, role)` each time.
4. **No scratch storage** — v2 expects `.nax/features/<id>/sessions/<sessionId>/scratch.jsonl` but nothing creates this directory today.
5. **Crash detection is file-age-based** — sidecar mtime >2h to detect orphans. A crash within 2h is invisible until the timeout expires.

This creates five concrete problems for v2:

| Problem | Impact |
|:--------|:-------|
| Context engine can't read scratch because no session ID is threaded through the pipeline | Session scratch provider is unimplementable |
| Progressive digest has no stable session identifier to key on | Digest can't survive crash resume |
| Availability fallback needs to hand off session state to a new agent, but session state lives inside the adapter | `rebuildForAgent()` has no session to rebuild from |
| Each adapter implements its own close/resume/sweep policy | Behavior diverges across agents; bugs in one adapter don't get fixed in the other |
| Rectification loops (verify, autofix) sometimes don't resume the session — each retry creates a fresh session | Context from prior attempts is lost |

### Design

#### D.1 SessionManager — centralized lifecycle owner

A new module `src/session/manager.ts` that owns session lifecycle for all agent protocols. Adapters become session *consumers*, not session *owners*.

```typescript
// src/session/manager.ts

export interface SessionDescriptor {
  /** Stable session ID. Generated once, never changes. Format: "sess-<uuid>". */
  id: string;
  /** Story this session belongs to. */
  storyId: string;
  /** Feature this session belongs to (null if unattached). */
  featureId: string | null;
  /** Session role — maps to PromptRole. */
  role: SessionRole;
  /** Current lifecycle state. */
  state: SessionState;
  /** Agent currently owning the physical session. Changes on fallback. */
  agent: AgentTarget;
  /** Protocol-specific session handle (ACP session name, CLI process ID, etc.). */
  handle: string | null;
  /**
   * Protocol-specific session identifiers reported by the agent backend.
   * Updated by the adapter after session creation/resume via bindHandle().
   *
   * For ACP (acpx): recordId is the stable session ID that never changes
   * across reconnects; sessionId is volatile (changes on reconnect).
   * recordId is the key for post-run correlation and audit trails.
   *
   * For future adapters: populate with whatever stable+volatile IDs
   * the protocol provides.
   */
  protocolIds: {
    /** Stable backend session ID. ACP: acpxRecordId. */
    recordId: string | null;
    /** Volatile backend session ID. ACP: acpxSessionId. */
    sessionId: string | null;
  };
  /** Stages completed in this session, with their digests. */
  completedStages: Array<{ stage: Stage; digest: string; completedAt: string }>;
  /** Absolute path to scratch directory. */
  scratchDir: string;
  /** Created timestamp (ISO). */
  createdAt: string;
  /** Last activity timestamp (ISO). Updated on every state transition. */
  lastActivityAt: string;
  /** Number of agent swaps due to availability fallback. */
  fallbackHops: number;
  /** Prior agents that failed (for manifest/audit). */
  priorAgents: Array<{ agent: AgentTarget; failedAt: string; reason: string }>;
}

export type SessionRole =
  | "planner"
  | "test-writer"
  | "implementer"
  | "verifier"
  | "reviewer-semantic"
  | "reviewer-adversarial"
  | "reviewer-dialogue"
  | "rectifier"
  | "autofixer"
  | "decomposer"
  | "single-session"
  | "batch";

export type SessionState =
  | "created"       // session descriptor exists, no agent session yet
  | "active"        // agent session is running
  | "suspended"     // agent session closed, can be resumed (e.g., between TDD phases)
  | "failed"        // agent session failed, pending retry or fallback
  | "handed-off"    // availability fallback — new agent taking over
  | "completed"     // story completed, session will be archived
  | "orphaned";     // detected as abandoned (crash recovery)

export interface SessionManager {
  /**
   * Create a new session for a story+role. Creates scratch directory.
   * Returns the session descriptor with a stable ID.
   */
  create(opts: {
    storyId: string;
    featureId: string | null;
    role: SessionRole;
    agent: AgentTarget;
    repoRoot: string;
  }): Promise<SessionDescriptor>;

  /**
   * Resume an existing session (same story+role). Used for:
   * - Rectification retries (implementer session stays open)
   * - Crash recovery (orphaned session detected at startup)
   * Returns null if no session exists for this story+role.
   */
  resume(storyId: string, role: SessionRole): Promise<SessionDescriptor | null>;

  /**
   * Get the current session for a story+role without changing state.
   */
  get(storyId: string, role: SessionRole): SessionDescriptor | null;

  /**
   * Get all sessions for a story (all roles).
   */
  getForStory(storyId: string): SessionDescriptor[];

  /**
   * Transition session state. Validates the transition is legal.
   * Updates lastActivityAt.
   */
  transition(sessionId: string, to: SessionState): Promise<void>;

  /**
   * Record a completed stage with its digest. Used by progressive digest.
   */
  recordStage(sessionId: string, stage: Stage, digest: string): Promise<void>;

  /**
   * Hand off session to a new agent (availability fallback).
   * - Records prior agent in priorAgents[]
   * - Updates agent field
   * - Increments fallbackHops
   * - Transitions state to "handed-off" then "active"
   * - Returns updated descriptor
   */
  handoff(sessionId: string, newAgent: AgentTarget, reason: string): Promise<SessionDescriptor>;

  /**
   * Bind a protocol-specific handle and backend IDs to the session.
   * Called by the adapter after creating/resuming the physical agent session.
   *
   * @param handle - Protocol-specific session name (ACP: acpx session name, CLI: process PID)
   * @param protocolIds - Backend session identifiers for audit correlation
   *   ACP: { recordId: acpxRecordId (stable), sessionId: acpxSessionId (volatile) }
   */
  bindHandle(sessionId: string, handle: string, protocolIds?: {
    recordId: string | null;
    sessionId: string | null;
  }): Promise<void>;

  /**
   * Sweep orphaned sessions. Called at startup and run-end.
   * Sessions in "active" state whose lastActivityAt exceeds the timeout
   * are transitioned to "orphaned".
   */
  sweepOrphans(timeoutMs: number): Promise<SessionDescriptor[]>;

  /**
   * Close all sessions for a story. Called on story completion.
   * Transitions all non-completed sessions to "completed".
   */
  closeStory(storyId: string): Promise<void>;

  /**
   * Archive scratch for completed sessions older than retentionDays.
   */
  archiveStale(retentionDays: number): Promise<number>;
}
```

#### D.2 State machine

Legal state transitions:

```
                  +----------+
                  | created  |
                  +----+-----+
                       |
              adapter binds handle
                       |
                       v
                  +----------+      availability
                  |  active  | ----failure----> +------------+
                  +----+-----+                  | handed-off |
                       |                        +-----+------+
              +--------+--------+                     |
              |                 |              new agent binds
         agent done        agent fails                |
              |                 |                      v
              v                 v                 +----------+
        +-----------+     +----------+            |  active  |
        | suspended |     |  failed  |            +----------+
        +-----+-----+     +----+-----+
              |                 |
         resume (next      retry (same
         stage or rect)    role, same story)
              |                 |
              v                 v
         +----------+     +----------+
         |  active  |     |  active  |
         +----------+     +----------+

         Any state ---crash-detected---> +----------+
                                         | orphaned |
                                         +----+-----+
                                              |
                                     startup resume
                                              |
                                              v
                                         +----------+
                                         |  active  |
                                         +----------+

         Any non-terminal state ---story-complete---> +-----------+
                                                      | completed |
                                                      +-----------+
```

**Key transitions:**

| From | To | Trigger | Who |
|:-----|:---|:--------|:----|
| `created` | `active` | Adapter creates physical session, calls `bindHandle()` | Adapter |
| `active` | `suspended` | Agent session closes normally (e.g., test-writer done, implementer pending) | Pipeline stage |
| `active` | `failed` | Agent session fails (test failure, review rejection, adapter error) | Pipeline stage |
| `active` | `handed-off` | Availability failure detected, fallback initiated | Runner |
| `suspended` | `active` | Next stage or rectification retry resumes the session | Pipeline stage |
| `failed` | `active` | Retry attempt (rect loop, autofix retry) | Pipeline stage |
| `handed-off` | `active` | New agent binds handle, resumes work | Adapter |
| `*` | `orphaned` | Crash detected (`lastActivityAt` exceeds timeout) | `sweepOrphans()` |
| `orphaned` | `active` | Startup resume detects orphan, re-binds | Runner startup |
| `*` | `completed` | Story completes (success or terminal failure) | `closeStory()` |

#### D.3 Storage

Session descriptors are stored as JSON files:

```
.nax/features/<featureId>/sessions/
  index.json                           <-- array of SessionDescriptor (the registry)
  <sessionId>/
    scratch.jsonl                      <-- append-only observations (v2 spec)
    digest-<stage>.txt                 <-- stage digests (for crash resume)
```

For unattached stories (no feature):

```
.nax/sessions/
  index.json
  <sessionId>/
    scratch.jsonl
    digest-<stage>.txt
```

**Why files, not a database?** Same rationale as v1's `context.lock.json` — no external dependencies, git-ignorable, inspectable with `cat`. The index is small (one entry per session per story; a 20-story run has ~100 entries at most).

**Concurrency:** Parallel story execution means concurrent writes to different `index.json` files (per-feature). Within a feature, stories run sequentially (current pipeline constraint). If parallel intra-feature execution is added later, `index.json` must use file locking or per-session files.

#### D.4 Integration with PipelineContext

Add `sessionId` and session manager reference to `PipelineContext`:

```typescript
// src/pipeline/types.ts additions

export interface PipelineContext {
  // ... existing fields ...

  /** Stable session ID for the current execution session. Set by context stage. */
  sessionId: string;

  /** Session manager instance. Shared across all stages in a run. */
  sessionManager: SessionManager;
}
```

**Who creates the session?** The `context.ts` pipeline stage, which already resolves `featureId`. Updated flow:

```
context.ts stage:
  1. Resolve featureId (existing v1 logic)
  2. Determine session role from routing strategy:
       three-session-tdd → creates 3 sessions (test-writer, implementer, verifier)
       single-session    → creates 1 session (single-session)
       no-test           → creates 1 session (single-session)
       batch             → creates 1 session (batch)
  3. Create session(s) via sessionManager.create()
  4. Set ctx.sessionId to the primary session's ID
  5. Create scratch directory
  6. Build context (existing logic)
  7. Load feature context (existing v1 logic)
```

For three-session TDD, the `tdd/session-runner.ts` calls `sessionManager.resume()` or `sessionManager.create()` for each sub-session (test-writer, implementer, verifier). The primary `ctx.sessionId` points to the implementer session (the longest-lived one).

#### D.5 Integration with agent adapters

Adapters are demoted from session owners to session consumers. The adapter receives a `SessionDescriptor` and translates it to protocol-specific operations:

```typescript
// Adapter interface addition

interface AgentAdapter {
  // ... existing methods ...

  /**
   * Open or resume a physical agent session for the given descriptor.
   * Returns the protocol-specific handle (ACP session name, CLI PID, etc.).
   * The adapter must NOT manage session lifecycle — only the physical connection.
   */
  openSession(descriptor: SessionDescriptor, config: NaxConfig): Promise<string>;

  /**
   * Close the physical agent session.
   * The adapter must NOT decide whether to close — the session manager decides.
   */
  closeSession(handle: string): Promise<void>;
}
```

**Migration path for ACP adapter:**

Today's `ensureAcpSession()` does three things:
1. Generates a deterministic session name
2. Checks if an ACP session with that name exists (resume) or creates one
3. Manages sidecar file state

After migration:
1. Session name generation moves to `SessionManager.create()` (stable UUID, not hash-based)
2. The ACP adapter's `openSession()` calls `acpx createSession` or `acpx loadSession` using the session name from the descriptor
3. Sidecar file management is replaced by `SessionManager`'s `index.json`
4. The adapter's `buildSessionName()` is deprecated — session names come from the manager
5. `sweepFeatureSessions()` and `sweepStaleFeatureSessions()` move to `SessionManager.sweepOrphans()` and `SessionManager.archiveStale()`

**ACP session name mapping:**

The ACP adapter still needs a deterministic session name for `acpx` (which identifies sessions by name). The adapter derives it from the stable session ID:

```typescript
// src/agents/acp/adapter.ts
function acpSessionName(descriptor: SessionDescriptor): string {
  // Deterministic: "nax-sess-<first8-of-sessionId>-<role>"
  return `nax-${descriptor.id.slice(5, 13)}-${descriptor.role}`;
}
```

#### D.6 Integration with context engine

`ContextRequest.sessionId` is now a real, stable identifier:

```typescript
export interface ContextRequest {
  // ... existing fields ...
  sessionId: string;  // from ctx.sessionId, set by SessionManager
}
```

**SessionScratchProvider** reads scratch from the session manager's storage:

```typescript
class SessionScratchProvider implements IContextProvider {
  async fetch(req: ContextRequest, softBudget: number): Promise<ContextChunk[]> {
    const scratchPath = join(
      req.repoRoot, ".nax", "features", req.featureId ?? "_unattached",
      "sessions", req.sessionId, "scratch.jsonl"
    );
    // Read, parse, return most recent entries within softBudget
  }
}
```

**Scratch writers** (pipeline stages) use a helper:

```typescript
// src/session/scratch.ts

export async function appendScratch(
  sessionManager: SessionManager,
  sessionId: string,
  entry: ScratchEntry,
): Promise<void> {
  const descriptor = sessionManager.getById(sessionId);
  if (!descriptor) return; // defensive — should not happen
  const scratchPath = join(descriptor.scratchDir, "scratch.jsonl");
  const line = JSON.stringify({ ...entry, timestamp: new Date().toISOString() });
  await Bun.write(scratchPath, (await readExisting(scratchPath)) + line + "\n");
}

export interface ScratchEntry {
  stage: Stage;
  kind: "digest" | "test-output" | "review-finding" | "rectify-attempt"
      | "autofix-result" | "tool-call" | "observation";
  content: string;
  /** Agent that produced this entry. For cross-agent scratch neutralization. */
  writtenByAgent?: string;
}
```

#### D.7 Integration with availability fallback

When the adapter reports an availability failure, the runner calls `sessionManager.handoff()` before `orchestrator.rebuildForAgent()`:

```
Runner detects availability failure
  |
  v
sessionManager.handoff(sessionId, codexTarget, "fail-quota")
  |  - records claude in priorAgents[]
  |  - updates agent to codex
  |  - increments fallbackHops
  |  - transitions: active -> handed-off
  |
  v
orchestrator.rebuildForAgent(priorBundle, codexTarget, failure)
  |  - re-renders push block for codex profile
  |  - injects failure-note chunk
  |  - preserves scratch (same scratchDir, same sessionId)
  |
  v
adapter.openSession(descriptor, config)
  |  - codex adapter creates new physical session
  |  - calls sessionManager.bindHandle(sessionId, newHandle)
  |  - transitions: handed-off -> active
  |
  v
Story continues under codex with full scratch history
```

**Key insight:** The session ID stays the same across agent swaps. Scratch accumulated under Claude is readable by the Codex session because it's keyed by `sessionId`, not by agent.

#### D.8 Integration with crash recovery

Startup flow:

```
Runner startup
  |
  v
sessionManager.sweepOrphans(timeoutMs: 7200000)  // 2h default
  |  - scans all index.json files across features
  |  - sessions in "active" state whose lastActivityAt > 2h ago
  |    are transitioned to "orphaned"
  |
  v
For each orphaned session:
  |  - if story is in the current run's PRD: resume
  |    sessionManager.resume(storyId, role) -> transitions orphaned -> active
  |    adapter.openSession(descriptor) -> binds new handle
  |    scratch from prior run is available to SessionScratchProvider
  |
  |  - if story is NOT in current run: leave orphaned
  |    archiveStale() will clean up after retentionDays
```

**Improvement over current:** Current crash detection uses sidecar file mtime (fragile, no state machine). Session manager uses explicit `lastActivityAt` timestamps and a state machine, making detection reliable and testable.

#### D.9 Session close policy

The session manager owns the close decision. Adapters never close sessions on their own.

| Scenario | Policy | Who triggers |
|:---------|:-------|:-------------|
| Test-writer session done (three-session TDD) | Suspend (next stage will resume as implementer) | `session-runner.ts` |
| Implementer session done, verify passes, review passes | Complete | `run-completion.ts` |
| Implementer session done, verify fails | Keep active (rectify will retry) | `rectification-loop.ts` |
| Review finds issues | Keep active (rectify will retry) | `review/runner.ts` |
| Story fails terminally | Complete (with failure status in descriptor) | `unified-executor.ts` |
| Availability fallback | Hand off (don't close — new agent takes over) | Runner |
| Run ends | Close all remaining active/suspended sessions | `run-completion.ts` |

**Migration note:** Today's `keepSessionOpen` parameter in adapter calls is replaced by the session manager's state machine. The adapter no longer makes close decisions — it always defers to `sessionManager.transition()`.

#### D.10 Config

```typescript
// src/config/schemas.ts addition

const SessionManagerConfigSchema = z.object({
  /** Timeout for orphan detection (ms). Default: 2h. */
  orphanTimeoutMs: z.number().int().min(60000).default(7200000),
  /** Retention days for completed session scratch. Default: 7. */
  retentionDays: z.number().int().min(1).default(7),
  /** Max sessions per story (safety limit). Default: 10. */
  maxSessionsPerStory: z.number().int().min(1).default(10),
});

// Added to ContextEngineV2ConfigSchema
session: SessionManagerConfigSchema.default({}),
```

### File surface

#### New

- `src/session/manager.ts` — `SessionManager` implementation
- `src/session/types.ts` — `SessionDescriptor`, `SessionRole`, `SessionState`, `ScratchEntry`
- `src/session/scratch.ts` — `appendScratch()` helper for pipeline stages
- `src/session/index.ts` — barrel exports
- `test/unit/session/manager.test.ts` — state machine transitions, create/resume/handoff/sweep
- `test/unit/session/scratch.test.ts` — append/read/neutralization
- `test/integration/session/crash-resume.test.ts` — orphan detection + resume with scratch preserved
- `test/integration/session/fallback-handoff.test.ts` — agent swap with session continuity

#### Modified

- `src/pipeline/types.ts` — add `sessionId: string`, `sessionManager: SessionManager`
- `src/pipeline/stages/context.ts` — create session(s) via manager, set `ctx.sessionId`
- `src/pipeline/stages/verify.ts` — call `appendScratch()` with test output
- `src/pipeline/stages/rectify.ts` — call `appendScratch()` with attempt summary
- `src/pipeline/stages/review.ts` — call `appendScratch()` with findings
- `src/pipeline/stages/autofix.ts` — call `appendScratch()` with fix result
- `src/agents/acp/adapter.ts` — demote from session owner to consumer: `openSession()` / `closeSession()` replace `ensureAcpSession()` / session close logic; `buildSessionName()` deprecated; sidecar management removed
- `src/agents/claude/adapter.ts` — same pattern: `openSession()` / `closeSession()`
- `src/tdd/session-runner.ts` — use `sessionManager.resume()` instead of reconstructing session names; remove `keepSessionOpen` parameter (manager decides)
- `src/execution/lifecycle/run-setup.ts` — instantiate `SessionManager`, attach to run context
- `src/execution/lifecycle/run-completion.ts` — call `sessionManager.closeStory()` for all completed stories; call `sessionManager.archiveStale()`
- `src/execution/crash-recovery.ts` — delegate to `sessionManager.sweepOrphans()` instead of sidecar-based sweep

### Risks

**Adapter-manager synchronization.** The physical agent session (ACP process, CLI process) can die without the session manager knowing. **Mitigation:** The adapter catches spawn errors and calls `sessionManager.transition(id, "failed")`. The `lastActivityAt` heartbeat (updated on every adapter call) provides a second line of defense via `sweepOrphans()`.

**Index.json corruption.** A crash during index write could corrupt the registry. **Mitigation:** Write to `index.json.tmp` then rename (atomic on most filesystems). On read, if parse fails, fall back to empty registry and log a warning — sessions are re-discoverable from directory structure.

**Migration complexity.** Existing ACP adapter has ~400 lines of session management interwoven with protocol logic. Extracting it is a significant refactor. **Mitigation:** Phase 0 ships the session manager alongside the adapter's existing logic (dual-write). Phase 1 flips the adapter to consume the manager. Phase 2 removes the adapter's legacy session code.

**Parallel story execution.** Multiple stories writing to different `index.json` files (per-feature) is safe. Multiple sessions within the same feature would need coordination. **Mitigation:** Current pipeline runs stories sequentially within a feature. If parallel intra-feature is added, switch to per-session files instead of a shared index.

### Rollout

| Phase | What ships |
|:------|:-----------|
| 0 (with orchestrator) | `SessionManager` types + create/get/transition. Dual-write with adapter's existing sidecar logic. `ctx.sessionId` added to `PipelineContext`. Scratch directory creation. |
| 1 (session scratch) | `appendScratch()` wired into verify/rectify/review/autofix stages. `SessionScratchProvider` reads from manager-created scratch dirs. |
| 2 (digest) | `recordStage()` wired. Digests persisted to scratch dir for crash resume. |
| 3 (new providers) | No session manager changes. |
| 4-5 (pull tools) | Pull tool results appended to scratch via `appendScratch()`. |
| 5.5 (fallback) | `handoff()` wired. Adapter `openSession()`/`closeSession()` interface finalized. Legacy sidecar code removed from ACP adapter. |

### Acceptance criteria (Amendment D)

63. **Session creation.** `SessionManager.create()` returns a `SessionDescriptor` with a stable `id` (format: `sess-<uuid>`), creates the scratch directory at `.nax/features/<featureId>/sessions/<sessionId>/`, and writes the descriptor to `index.json`.

64. **Session resume.** `SessionManager.resume(storyId, role)` returns the existing descriptor if one exists in a resumable state (`suspended`, `failed`, `orphaned`). Returns null otherwise. Transitions state to `active`.

65. **State machine enforcement.** `SessionManager.transition()` rejects illegal transitions (e.g., `completed` -> `active`) with a `NaxError`. All legal transitions are per the state diagram in D.2.

66. **Stage recording.** `SessionManager.recordStage(sessionId, stage, digest)` appends to `completedStages[]` and persists the digest to `<scratchDir>/digest-<stage>.txt`. On crash resume, digests are recoverable from disk.

67. **Handoff.** `SessionManager.handoff(sessionId, newAgent, reason)` records the prior agent, updates the agent field, increments `fallbackHops`, and transitions `active` -> `handed-off`. The `sessionId` and `scratchDir` remain unchanged — scratch accumulated under the prior agent is readable by the new agent.

68. **Adapter demotion.** Agent adapters implement `openSession(descriptor)` and `closeSession(handle)`. Adapters never create, close, or manage session state — only the session manager does. The adapter's `buildSessionName()` and sidecar file management are deprecated.

69. **PipelineContext threading.** `ctx.sessionId` is set by the `context.ts` stage after session creation. All downstream stages and providers access the session via `ctx.sessionId` and `ctx.sessionManager`.

70. **Scratch directory lifecycle.** Created by `SessionManager.create()`. Written to by pipeline stages via `appendScratch()`. Read by `SessionScratchProvider` during `assemble()`. Archived by `SessionManager.archiveStale()` after `retentionDays`. Deleted after archive (or moved to `_archive/` if configured).

71. **Orphan detection.** `SessionManager.sweepOrphans(timeoutMs)` finds sessions in `active` state whose `lastActivityAt` exceeds the timeout, transitions them to `orphaned`, and returns the list. Replaces sidecar-mtime-based crash detection.

72. **Concurrent safety.** Session manager writes use atomic file rename (`index.json.tmp` -> `index.json`). Parse failures on read fall back to empty registry with a warning.

73. **Close policy centralized.** The `keepSessionOpen` parameter is removed from adapter call signatures. Session close decisions are made exclusively by pipeline stages calling `sessionManager.transition()`. Adapters defer to the manager.

74. **Three-session TDD integration.** For three-session TDD, three sessions are created (test-writer, implementer, verifier). The test-writer session is `suspended` after phase 1. The implementer session is the primary (`ctx.sessionId`). The verifier session is created on demand. All three share the same `featureId` and `storyId` but have distinct `sessionId`s and `scratchDir`s.

75. **Single-session integration.** For single-session, tdd-simple, no-test, and batch modes, one session is created. `ctx.sessionId` points to it. Session role matches the execution mode.

76. **Protocol ID capture.** `AgentResult` includes `protocolIds: { recordId, sessionId }`. After each `agent.run()` call, the pipeline stage calls `sessionManager.bindHandle(id, handle, protocolIds)` to persist both the protocol-specific handle and the backend IDs. For ACP: `recordId` is the stable `acpxRecordId` (never changes across reconnects); `sessionId` is the volatile `acpxSessionId`. Both are persisted in `index.json` and available via `SessionDescriptor.protocolIds`.

77. **Audit correlation chain.** The persisted `protocolIds.recordId` enables a full audit trail: `storyId` -> `SessionDescriptor.id` (nax session) -> `protocolIds.recordId` (acpx stable ID) -> prompt audit files -> acpx backend logs. `nax context inspect <storyId>` displays protocol IDs alongside manifests.

78. **Protocol ID on manifest.** `ContextManifest` includes `protocolIds` from the active session's descriptor, enabling correlation between context assembly decisions and the agent backend session that consumed them.

---

## Open questions (from amendments)

19. **Effectiveness signal accuracy.** The "followed" / "contradicted" / "ignored" classification is keyword-based. How reliable is it without an LLM? Tentative: start with keyword matching, measure accuracy on a test corpus, add LLM-based classification as an optional post-story step if keyword accuracy < 80%.

20. **Staleness across features.** A constraint established in feature A may be relevant to feature B. If feature A is archived, does the constraint's `maxStoryAge` reset or continue counting? Tentative: staleness is per-feature only. Cross-feature staleness is a RAG provider concern (OQ-8).

21. **Package-level feature context.** Amendment C.4 says features are repo-scoped. Should we allow a package-level `context.md` overlay (e.g., `packages/api/.nax/features/<id>/context.md`)? Tentative: no, but revisit if operators request it.

22. **Batch mode cross-feature.** When a batch spans stories from different features, which feature's context.md is loaded? Tentative: primary story's featureId. Secondary stories' feature contexts are loaded as additional chunks with lower priority.

23. **Session manager vs adapter session naming.** ACP sessions are identified by name (`acpx` uses names, not UUIDs). The session manager generates UUID-based IDs. The adapter derives an ACP-compatible name from the UUID. Should we let the adapter choose its own naming scheme, or should the manager dictate it? Tentative: manager owns the `sessionId` (stable UUID); adapter derives a protocol-specific name from it. The manager doesn't know or care about protocol-specific names.

24. *(Resolved.)* ~~**Scratch sharing across TDD sub-sessions.**~~ Yes — `SessionScratchProvider` reads scratch from ALL sessions for the same story. The pipeline stage populates `ContextRequest.storyScratchDirs` from `sessionManager.getForStory(storyId).map(s => s.scratchDir)`. The provider iterates all directories, keeping the provider decoupled from the session manager. Decided.

25. **Session manager as a v2 prerequisite.** Should the session manager ship before v2 Phase 0, or as part of it? Tentative: ship alongside Phase 0. The orchestrator needs `sessionId` from day one. Dual-write with legacy sidecar logic during Phase 0; legacy removed at Phase 5.5.

---

## Summary of spec changes

### New sections to add to SPEC-context-engine-v2.md

| Section | Amendment | Insert after |
|:--------|:----------|:-------------|
| Context pollution prevention (minScore, staleness, effectiveness) | A | Scoring, dedup, and knapsack packing |
| Execution mode stage sequences | B | Stage context map (default) |
| Monorepo scoping | C | Session model |
| Centralized session manager | D | Session model (before C) |

### Modified types

| Type | Change | Amendment |
|:-----|:-------|:----------|
| `StageContextConfigSchema` | Add `minScore`, `planDigestBoost` | A, B |
| `ContextEngineV2ConfigSchema` | Add `staleness`, `session` | A, D |
| `ContextManifest.chunks[]` | Add `effectiveness` | A |
| `ContextManifest` | Add `repoRoot`, `packageDir` | C |
| `ContextRequest` | Rename `workdir` to `repoRoot`, add `packageDir` | C |
| `StoryMetrics.context` | Add `pollution` | A |
| `PipelineContext` | Add `sessionId`, `sessionManager` | D |
| `AgentResult` | Add `protocolIds: { recordId, sessionId }` | D |
| `ContextManifest` | Add `protocolIds` | D |

### New types

| Type | Module | Amendment |
|:-----|:-------|:----------|
| `SessionDescriptor` | `src/session/types.ts` | D |
| `SessionRole` | `src/session/types.ts` | D |
| `SessionState` | `src/session/types.ts` | D |
| `ScratchEntry` | `src/session/types.ts` | D |
| `SessionManager` | `src/session/manager.ts` | D |
| `ChunkEffectiveness` | `src/context/core/types.ts` | A |
| `ContextPollutionMetrics` | `src/metrics/types.ts` | A |

### New acceptance criteria: 44-78

### New open questions: 19-25

### Rollout impact

| Phase | Amendment impact |
|:------|:----------------|
| 0 (orchestrator + parity) | A.1 minScore (near-zero impact). D.0 SessionManager types + create/get/transition, dual-write with legacy sidecar, `ctx.sessionId` on PipelineContext |
| 1 (session scratch) | D.1 `appendScratch()` wired into stages. `SessionScratchProvider` reads from manager-created scratch dirs |
| 2 (digest) | B.2 planDigestBoost. D.2 `recordStage()` wired, digests persisted for crash resume |
| 3 (new providers) | C.1-C.2 monorepo scoping, C.7 scope options |
| 4 (pull tools) | D.4 pull tool results appended to scratch |
| 5 (reviewer pull) | No amendment impact |
| 5.1 (canonical rules) | C.3 per-package rules overlay |
| 5.5 (fallback) | D.5 `handoff()` wired. Adapter `openSession()`/`closeSession()` finalized. Legacy sidecar removed from ACP adapter |
| Post-GA | A.2 effectiveness signal, A.3 staleness flag |
