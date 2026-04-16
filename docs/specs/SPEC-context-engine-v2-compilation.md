# SPEC: Context Engine v2 — Compiled Design

> **Status:** Draft compilation. Merges the base spec + 4 amendments + integration design into a single reference.

**Source documents:**

| Document | Covers |
|:---------|:-------|
| [SPEC-context-engine-v2.md](./SPEC-context-engine-v2.md) | Base design: orchestrator, providers, push/pull, scoring, manifest, agent fallback, canonical rules |
| [SPEC-context-engine-v2-amendments.md](./SPEC-context-engine-v2-amendments.md) | Amendments A (pollution), B (execution modes), C (monorepo), D (session manager) |
| [SPEC-session-manager-integration.md](./SPEC-session-manager-integration.md) | Adapter integration: call flows, migration, gap analysis |
| [context-engine-v2-flow.md](./context-engine-v2-flow.md) | ASCII flow diagrams (push path, pull path, digest, scratch, fallback, end-to-end, scope hierarchy) |

---

## What v2 Solves

v1 answered: *"How do we remember what prior stories learned in this feature?"*
v2 answers five harder questions:

| # | Question | v1 | v2 |
|:--|:---------|:---|:---|
| 1 | Session lifecycle — how does context survive session resume, crashes, handoffs? | Not addressed | SessionManager + session scratch |
| 2 | Stage granularity — do all stages get the same context? | Yes (one blob) | No — per-stage budget, role filter, provider selection |
| 3 | Beyond files — RAG, graphs, knowledge bases? | Not possible | Pluggable `IContextProvider` interface |
| 4 | Push vs pull — can the agent ask for context mid-task? | Push only | Hybrid: push (before call) + pull (tools during call) |
| 5 | Agent portability — what happens when Claude is unavailable? | Story fails | Availability fallback: swap agent, preserve scratch + digest |

---

## Architecture

```
Pipeline stage (e.g. tdd-implementer)
  |
  v
SessionManager                            ContextOrchestrator
  - create/resume/transition               - assemble(ContextRequest)
  - scratch directory                        |
  - protocol ID capture                     |  1. Filter providers for stage+role
  - state machine (7 states)                |  2. Parallel fetch with timeout
  - crash recovery                          |  3. Score adjustment (role x freshness x kind)
  - availability fallback handoff           |  4. Dedupe (content similarity >= 0.9)
  |                                         |  5. Min-score threshold (drop noise)
  v                                         |  6. Role filter (audience tags)
SessionDescriptor                           |  7. Staleness detection (age + contradiction)
  { id, role, state, agent,                 |  8. Knapsack pack (DP, budget floor for rules+feature)
    protocolIds, handle,                    |  9. Render markdown (scope-ordered sections)
    scratchDir, completedStages }           | 10. Build digest (deterministic, <= 250 tokens)
  |                                         | 11. Collect pull tools (if agent supports)
  v                                         | 12. Build manifest (audit trail)
AgentAdapter                                |
  - openSession(descriptor)                 v
  - closePhysicalSession(handle)        ContextBundle
  - deriveSessionName(descriptor)         { pushMarkdown, pulledTools, manifest,
  - run(options) → AgentResult              digest, budgetUsed, budgetTotal }
    { protocolIds, sessionRetries,          |
      adapterFailure }                     v
                                        Prompt builder → Agent
```

---

## Components

### Core (src/context/core/)

| Module | Purpose |
|:-------|:--------|
| `types.ts` | `ContextRequest`, `ContextChunk`, `ContextBundle`, `ContextManifest`, `AgentTarget`, `AgentCapabilities`, `ChunkEffectiveness` |
| `provider.ts` | `IContextProvider` interface — `fetch()`, `tools()`, `onTool()` |
| `orchestrator.ts` | `ContextOrchestrator` — `assemble()`, `handleToolCall()`, `rebuildForAgent()` (re-render only, no provider fetch) |
| `scoring.ts` | Role / freshness / kind weights, `minScore` threshold |
| `dedupe.ts` | Content-normalized dedup (>= 0.9 similarity) |
| `packing.ts` | Phase 0–2: greedy by score/tokens (floor items first). Phase 3+: optional 0/1 DP knapsack if greedy proves suboptimal |
| `render.ts` | Markdown sections by scope: Project > Feature > Story > Session > Retrieved |
| `digest.ts` | Deterministic digest builder (<= 250 tokens) for downstream stages |
| `stage-config.ts` | Default stage context map (budgets, providers, pull tools, kind weights, `planDigestBoost`) |
| `role-filter.ts` | Audience tag filtering (moved from v1 builders into orchestrator) |
| `agent-profiles.ts` | Registry of `AgentProfile` per agent ID (claude, codex, gemini, cursor, local) |
| `agent-renderer.ts` | Per-profile rendering: wrapper framing, tool schema dialect, budget ceiling |
| `rebuild.ts` | `rebuildForAgent()` — LLM-free, preserves portable state, injects failure-note chunk |
| `manifest.ts` | Manifest writer — per-stage audit trail with `ChunkEffectiveness` (post-story) |

### Session Manager (src/session/)

| Module | Purpose |
|:-------|:--------|
| `types.ts` | `SessionDescriptor`, `SessionRole`, `SessionState`, `ScratchEntry` |
| `manager.ts` | `SessionManager` — create, resume, transition, handoff, bindHandle, sweepOrphans, closeStory, archiveStale, recordStage |
| `scratch.ts` | `appendScratch()` helper — append-only JSONL, neutral phrasing, agent-tagged |

### Providers (src/context/providers/)

| Provider | Kind | Push | Pull | Ships in |
|:---------|:-----|:-----|:-----|:---------|
| `StaticRulesProvider` | static | Always (budget floor) | No | Phase 0 |
| `FeatureContextProvider` | feature | Role-filtered, staleness-aware | `query_feature_context` | Phase 0 |
| `SessionScratchProvider` | session | Most recent N within budget | `query_scratch(since?)` | Phase 1 |
| `GitHistoryProvider` | history | Recent diffs (package-scoped) | No | Phase 3 |
| `CodeNeighborProvider` | neighbor | Import graph (package-scoped) | `query_neighbor(file, depth)` | Phase 3 |
| `RagProvider` | rag | Top-K embedding search | `query_rag(q, k)` | Phase 7 (separate spec) |
| `GraphProvider` | graph | Symbol/call graph | `query_graph(symbol, depth)` | Phase 7 (separate spec) |
| `KbProvider` | kb | External wiki/ADR | `query_kb(q)` | Phase 7 (separate spec) |

### Rules (src/context/rules/)

| Module | Purpose |
|:-------|:--------|
| `canonical-loader.ts` | Reads `.nax/rules/*.md` + per-package overlays, neutrality linter |

### CLI (src/cli/)

| Command | Purpose |
|:--------|:--------|
| `nax context inspect <storyId>` | Render manifests as tree — what was injected at each stage and why |
| `nax rules export --agent=<id>` | Generate CLAUDE.md / AGENTS.md shim from canonical store (one-way) |
| `nax rules migrate` | Convert CLAUDE.md + .claude/rules/ → .nax/rules/ draft |
| `nax rules lint` | Validate neutrality of .nax/rules/ content |

---

## Context Window Coordination

The orchestrator's per-stage budget is one of three inputs. The effective budget is the minimum:

```
effectiveBudget = min(
  stageConfig.budgetTokens,                          // configured per-stage (e.g. 4096)
  agent.caps.preferredPromptTokens / expectedStages,  // per-agent ceiling
  req.availableBudgetTokens ?? Infinity               // prompt builder's remaining room
)
```

The prompt builder computes `availableBudgetTokens` before calling `assemble()`:

```
availableBudgetTokens = agent.caps.maxContextTokens
                      - constitution tokens (~2000)
                      - role-task body tokens (~1000)
                      - story brief + ACs tokens (~1500)
                      - code context tokens (~2000)
                      - conventions footer (~300)
                      - safety margin (10%)
```

When `availableBudgetTokens` is provided, the orchestrator never exceeds it — even if the stage config says 4096, if the prompt builder only has 2500 tokens of room, the orchestrator packs to 2500. When omitted (backward compat), the orchestrator uses the stage config budget unchecked.

---

## Budget Floor vs Ceiling

When budget-floor content (static rules + feature context) alone exceeds the stage budget, **the floor wins**. No other providers contribute. The manifest records dropped chunks with `reason: "budget-exceeded-by-floor"`. The budget is a soft ceiling that the floor can override — project rules are never dropped by a size constraint.

---

## Digest Threading (End-to-End)

Digest flows through four touchpoints:

```
STAGE N completes:
  1. orchestrator.assemble() returns bundle with digest (<= 250 tokens)
  2. Pipeline stage calls sessionManager.recordStage(sessionId, stage, digest)
     → persists to <scratchDir>/digest-<stage>.txt
     → appends to descriptor.completedStages[]

STAGE N+1 begins:
  3. Pipeline stage reads the last digest from session manager:
       sessions = sessionManager.getForStory(storyId)
       lastDigest = sessions.flatMap(s => s.completedStages)
                      .sort(by completedAt).at(-1)?.digest ?? ""
  4. Pipeline stage sets req.hints.priorStageDigest = lastDigest
  5. orchestrator.assemble() includes it as a push chunk
     (kind: "digest", freshness: "this-session", score: 1.0)

CRASH RESUME:
  6. sessionManager.resume() reads <scratchDir>/digest-*.txt from disk
     → rebuilds descriptor.completedStages[]
  7. Pipeline stage picks up from step 3 as normal
```

Pipeline stage owns the threading (steps 3-4). Orchestrator only produces (step 1) and consumes (step 5). Session manager only persists and recovers (steps 2, 6).

---

## Cross-Session Scratch Reading

In three-session TDD, the implementer needs to read the test-writer's scratch observations. The pipeline stage populates `ContextRequest.storyScratchDirs` from all sessions for the story:

```typescript
req.storyScratchDirs = sessionManager.getForStory(storyId).map(s => s.scratchDir);
```

`SessionScratchProvider` iterates all directories, reading from every session's `scratch.jsonl`. This keeps the provider decoupled from the session manager — it receives paths, not a manager reference.

---

## Stage Context Map (Complete)

| Stage | Push sources | Pull tools | Budget | Notes |
|:------|:------------|:-----------|:-------|:------|
| `decompose` | static (rules only), prior feature digest | — | 1024 | |
| `plan` | static, feature, story, git-history | — | 3072 | |
| `route` | static (tier rules), story | — | 512 | |
| `tdd-test-writer` | static, feature[tw], story, scratch, neighbor(tests) | query_neighbor | 3072 | Three-session TDD only |
| `tdd-implementer` | static, feature[impl], story, scratch, neighbor, tw.digest | query_rag, query_graph, query_neighbor, query_feature_context | 4096 | Three-session TDD only |
| `tdd-verifier` | static, feature[verifier], failure output from scratch | — | 1024 | Three-session TDD only |
| `single-session` / `tdd-simple` | as tdd-implementer, role-filter covers impl+tw | query_rag, query_graph, query_neighbor | 4096 | `planDigestBoost: 1.5` |
| `no-test` | as tdd-implementer, role-filter covers impl only | query_rag, query_graph, query_neighbor | 4096 | `planDigestBoost: 1.5`, no verify stage |
| `batch` | as tdd-implementer, role-filter covers impl+tw | query_rag, query_graph, query_neighbor | 4096 | `planDigestBoost: 1.5`, multi-story |
| `verify` | static, scratch | — | 512 | |
| `rectify` | feature[impl], failure output, fix pairs, scratch, prior digest | query_neighbor | 2048 | |
| `autofix` | feature[impl], exact failing check, scratch | — | 1024 | |
| `review-semantic` | static, feature[rev-sem], diff, scratch, verify.digest | query_feature_context, query_kb | 3072 | |
| `review-adversarial` | static, feature[rev-adv], diff, abandonment heuristics | query_feature_context | 3072 | |
| `review-dialogue` | prior findings, reviewer-implementer transcripts | — | 2048 | |
| `debate` | static, feature, story, opposing position digest | — | 2048 | |

---

## Execution Mode Stage Sequences

```
THREE-SESSION TDD (strict / lite):
  context → plan → assemble(tw) → assemble(impl) → assemble(verifier)
    → verify → [rectify loop] → review → [rectify loop] → done
  Sessions: 3 (test-writer, implementer, verifier)
  Digest chain: plan → tw → impl → verify → review → rectify (6+ stages)

SINGLE-SESSION / TDD-SIMPLE:
  context → plan → assemble(single-session) → verify → [rectify] → review → done
  Sessions: 1 (merged impl+tw role)
  Digest chain: plan → single → verify → review (4+ stages, planDigestBoost: 1.5)

NO-TEST:
  context → plan → assemble(no-test) → review → [rectify] → done
  Sessions: 1 (impl role only)
  Digest chain: plan → no-test → review (3+ stages, planDigestBoost: 1.5)
  No verify stage. Rectify triggered only by review findings.

BATCH:
  context → plan → assemble(batch) → verify → [rectify] → review → done
  Sessions: 1 (merged impl+tw role, multiple stories)
  Digest chain: plan → batch → verify → review (4+ stages, planDigestBoost: 1.5)
```

---

## Session Manager State Machine

```
created ──bind──→ active ──success──→ suspended ──resume──→ active
                    │                                          ↑
                    ├──failure──→ failed ──retry────────────────┘
                    │
                    ├──availability-fail──→ handed-off ──new-agent-bind──→ active
                    │
                    └──any──crash-detected──→ orphaned ──startup-resume──→ active

Any non-terminal state ──story-complete──→ completed
```

| State | Meaning | Physical session |
|:------|:--------|:-----------------|
| `created` | Descriptor exists, no agent session yet | None |
| `active` | Agent session running | Open |
| `suspended` | Between stages (e.g., tw → impl) | Open (server-side) |
| `failed` | Stage failed, pending retry/fallback | Open (resumable) or closed (broken) |
| `handed-off` | Availability fallback, new agent taking over | Prior closed, new pending |
| `completed` | Story done, session will be archived | Closed |
| `orphaned` | Crash detected | Open (server-side, stale) |

---

## Scope Hierarchy

```
PROJECT (.nax/rules/*.md)                    StaticRulesProvider
  └─ per-package overlay                     <packageDir>/.nax/rules/*.md
       (same name = package wins)

FEATURE (.nax/features/<id>/context.md)      FeatureContextProvider
  └─ always repo-scoped (not per-package)    role-filtered, staleness-aware

STORY (.nax/features/<id>/stories/<storyId>/)
  ├─ context.md                              auto-extracted (v2 write path)
  ├─ context-manifest-<stage>.json           audit trail per stage
  └─ rebuild-manifest.json                   on availability fallback

SESSION (.nax/features/<id>/sessions/<sessionId>/)
  ├─ scratch.jsonl                           append-only, gitignored
  └─ digest-<stage>.txt                      persisted for crash resume
```

---

## Monorepo Scoping

| Provider | Default scope | Configurable | Cross-package |
|:---------|:-------------|:-------------|:--------------|
| StaticRules | repo + package overlay | No (always merges both) | N/A |
| FeatureContext | repo (features are cross-cutting) | No | N/A |
| SessionScratch | story-scoped (not package-scoped) | No | N/A |
| GitHistory | `packageDir` | `historyScope: "package" \| "repo"` | Commits touching shared packages shown in full |
| CodeNeighbor | `packageDir` | `neighborScope: "package" \| "repo"` | `crossPackageDepth: 0 \| 1 \| 2` (default 1) |

`ContextRequest` carries both `repoRoot` (absolute) and `packageDir` (absolute). Non-monorepo: `packageDir === repoRoot`.

---

## Context Pollution Prevention

| Layer | Mechanism | When applied |
|:------|:----------|:-------------|
| `minScore` threshold | Chunks below 0.1 (configurable) dropped even if budget allows. Budget-floor exempt. | During knapsack (step 8) |
| Freshness scoring | `this-session` 1.3x → `historical` 0.6x | During scoring (step 5) |
| Staleness flag | Entries > `maxStoryAge` stories old, or contradicted by newer entries → 0.4x score | During `FeatureContextProvider.fetch()` |
| Role filtering | Audience tags narrow to role-relevant chunks | During role filter (step 7) |
| Dedup | Content similarity >= 0.9 → merge | During dedup (step 6) |
| Effectiveness signal | Post-story: `followed` / `contradicted` / `ignored` / `unknown` | Post-story manifest annotation |
| Pollution metrics | `pollutionRatio` = (contradicted+ignored)/total. Warns at > 0.3 | `nax status` |
| Manifest audit | Every chunk: kept/dropped + reason | Per `assemble()` call |

---

## Adapter Integration

### Boundary

```
SessionManager owns:                    Adapter owns:
  - Stable session ID (sess-<uuid>)       - Physical session (acpx create/load/close)
  - State machine (7 states)              - Multi-turn interaction loop
  - Close/resume/handoff decisions        - Protocol-specific name derivation
  - Scratch directory                     - Token/cost tracking
  - Protocol ID persistence               - Prompt audit
  - Orphan detection                      - Session error retries (transparent)
```

### What moves from adapter to manager

| Before (adapter) | After (manager) | Lines saved |
|:-----------------|:-----------------|:------------|
| `buildSessionName()` | `deriveSessionName(descriptor)` (5 lines in adapter) | ~20 |
| Sidecar CRUD (save/read/clear) | `index.json` | ~110 |
| Crash guard (BUG-456 in-flight check) | State machine + `lastActivityAt` | ~15 |
| Close decision (4-branch finally) | `transition()` called by pipeline stage | ~40 |
| `sweepFeatureSessions()` | `sweepOrphans()` | ~45 |
| `sweepStaleFeatureSessions()` | `sweepOrphans()` (time-based) | ~50 |
| `closeNamedAcpSession()` | `closePhysicalSession()` via manager | ~30 |
| **Total removed from adapter** | | **~315 lines** |

### What stays in adapter

| Behavior | Why |
|:---------|:----|
| Session error retries (QUEUE_DISCONNECTED, stale) | Protocol-level reconnection, transparent to manager |
| Multi-agent fallback walk (Phase 0-4) | Coexists until replaced by v2 fallback at Phase 5.5 |
| `ensureAcpSession()` (physical create/resume) | Protocol-specific operation |
| `_unavailableAgents` per-story tracking | Adapter transient state, cleared at story boundary |
| Token/cost accumulation across turns | Per-invocation accounting |

### AgentResult additions

```typescript
interface AgentResult {
  // ... existing fields ...
  protocolIds?: { recordId: string | null; sessionId: string | null };
  sessionRetries?: number;
  adapterFailure?: {                     // ships Phase 5.5
    category: "availability" | "quality";
    outcome: "fail-quota" | "fail-service-down" | "fail-auth"
           | "fail-timeout" | "fail-adapter-error";
    retriable: boolean;
    retryAfterSeconds?: number;
  };
}
```

### Audit Correlation Chain

```
storyId
  → SessionDescriptor.id              nax session (sess-<uuid>)
    → protocolIds.recordId             acpx stable ID (never changes)
      → prompt audit files             .nax/prompt-audit/<feature>/<epoch>-<name>.txt
        → acpx backend logs            server-side, keyed by recordId
```

---

## Consolidated Rollout Plan

| Phase | Ships | Amendment additions | Default | Exit gate |
|:------|:------|:-------------------|:--------|:----------|
| **0** | Orchestrator + StaticRules + FeatureContext. Behavior parity with v1. | SessionManager types + create/get/transition (dual-write with legacy sidecar). `ctx.sessionId` on PipelineContext. `minScore: 0.1` (near-zero impact). | off | Parity tests pass; no regression |
| **1** | SessionScratchProvider | `appendScratch()` wired into verify/rectify/review/autofix. Scratch reads from manager-created dirs. | off | Fewer re-runs after session resume |
| **2** | Progressive digest | `planDigestBoost: 1.5` for single-session modes. `recordStage()` wired. Digests persisted for crash resume. | off | Reduction in cross-stage "I didn't know X" findings |
| **3** | GitHistoryProvider + CodeNeighborProvider | Monorepo scoping: `repoRoot` + `packageDir` on ContextRequest. `neighborScope` and `historyScope` options. | off | Lower rate of missing-sibling-test findings |
| **4** | Pull tools (implementer) | Pull tool results appended to scratch. | off | Tool budget respected, cost within envelope |
| **5** | Pull tools (reviewer, rectifier) | — | off | Review finding noise decreases |
| **5.1** | Canonical rules store (`.nax/rules/` + neutrality linter + `nax rules migrate` + `nax rules export`) | Per-package rules overlay (`<packageDir>/.nax/rules/`). | `allowLegacyClaudeMd: true` 1 version | Migration tool produces clean `.nax/rules/`; linter passes |
| **5.5** | Agent profiles + `rebuildForAgent()` + availability fallback | `handoff()` wired. Adapter `openSession()`/`closeSession()` finalized. Legacy sidecar + adapter fallback walk removed. `adapterFailure` on AgentResult. | off (fallback map empty) | Story survives Claude → Codex swap with scratch + digest |
| **6** | Default-on for opted-in projects | — | selective on | One feature end-to-end on v2 with fallback surviving |
| **7** | Plugin providers (RAG/graph/KB) | — | per spec | — |
| **8** | Additional agent profiles (gemini, cursor, local) | — | per-agent | One real feature per profile |
| **Post-GA** | — | A.2 effectiveness signal, A.3 staleness flag, pollution metrics | — | Keyword accuracy > 80% |

---

## Complete File Surface

### New modules

| File | Lines (est.) | Phase |
|:-----|:-------------|:------|
| `src/context/core/types.ts` | 120 | 0 |
| `src/context/core/provider.ts` | 40 | 0 |
| `src/context/core/orchestrator.ts` | 200 | 0 |
| `src/context/core/scoring.ts` | 80 | 0 |
| `src/context/core/dedupe.ts` | 60 | 0 |
| `src/context/core/knapsack.ts` | 100 | 0 |
| `src/context/core/render.ts` | 80 | 0 |
| `src/context/core/digest.ts` | 60 | 2 |
| `src/context/core/stage-config.ts` | 80 | 0 |
| `src/context/core/role-filter.ts` | 60 | 0 |
| `src/context/core/manifest.ts` | 80 | 0 |
| `src/context/core/agent-profiles.ts` | 80 | 5.5 |
| `src/context/core/agent-renderer.ts` | 100 | 5.5 |
| `src/context/core/rebuild.ts` | 80 | 5.5 |
| `src/context/rules/canonical-loader.ts` | 100 | 5.1 |
| `src/context/providers/static-rules-provider.ts` | 80 | 0 |
| `src/context/providers/feature-context-provider.ts` | 60 | 0 |
| `src/context/providers/session-scratch-provider.ts` | 80 | 1 |
| `src/context/providers/git-history-provider.ts` | 100 | 3 |
| `src/context/providers/code-neighbor-provider.ts` | 120 | 3 |
| `src/session/types.ts` | 60 | 0 |
| `src/session/manager.ts` | 250 | 0 |
| `src/session/scratch.ts` | 50 | 1 |
| `src/session/index.ts` | 10 | 0 |
| `src/cli/context-inspect.ts` | 100 | 0 |
| `src/cli/rules-export.ts` | 80 | 5.1 |
| `.nax/rules/` (canonical store) | — | 5.1 |
| **Total new** | **~2430** | |

### Modified modules

| File | Change | Phase |
|:-----|:-------|:------|
| `src/config/schemas.ts` | `ContextEngineV2ConfigSchema`, `SessionManagerConfigSchema`, `ContextStalenessConfigSchema` | 0 |
| `src/config/types.ts` | Re-export new config types | 0 |
| `src/pipeline/types.ts` | Add `sessionId`, `sessionManager` to `PipelineContext` | 0 |
| `src/pipeline/stages/context.ts` | Call orchestrator, create sessions, attach bundle | 0 |
| `src/pipeline/stages/verify.ts` | Write test output to scratch | 1 |
| `src/pipeline/stages/rectify.ts` | Write attempt summary to scratch, read scratch via bundle | 1 |
| `src/pipeline/stages/review.ts` | Write findings to scratch, pass bundle | 1 |
| `src/pipeline/stages/autofix.ts` | Write fix result to scratch, pass bundle | 1 |
| `src/pipeline/stages/prompt.ts` | Thread featureContextMarkdown (v1 compat) | 0 |
| `src/pipeline/stages/tdd.ts` | Pass bundle into builders, write scratch | 1 |
| `src/prompts/builders/tdd-builder.ts` | Accept ContextBundle (Phase 0: `.context(bundle.pushMarkdown)` adapter) | 0 |
| `src/prompts/builders/review-builder.ts` | Same | 0 |
| `src/prompts/builders/rectifier-builder.ts` | Same | 0 |
| `src/prompts/builders/acceptance-builder.ts` | Same | 0 |
| `src/prompts/builders/debate-builder.ts` | Same | 0 |
| `src/prompts/builders/one-shot-builder.ts` | Same | 0 |
| `src/agents/types.ts` | Add `session` to `AgentRunOptions`, `protocolIds` + `sessionRetries` + `adapterFailure` to `AgentResult` | 0 / 5.5 |
| `src/agents/acp/adapter.ts` | Demote from session owner to consumer (Phase 0: dual-write; Phase 5.5: legacy removed, ~315 lines deleted) | 0 → 5.5 |
| `src/tdd/session-runner.ts` | Use `sessionManager.resume()`, remove `keepSessionOpen` | 0 |
| `src/review/semantic.ts` | Create reviewer session via manager, write findings to impl scratch | 0 |
| `src/review/adversarial.ts` | Same pattern | 0 |
| `src/execution/lifecycle/run-setup.ts` | Instantiate SessionManager | 0 |
| `src/execution/lifecycle/run-completion.ts` | `closeStory()`, `archiveStale()` | 0 |
| `src/execution/crash-recovery.ts` | Delegate to `sweepOrphans()` | 0 |

### Test files

| File | Phase |
|:-----|:------|
| `test/unit/context/core/*.test.ts` (per-module) | 0 |
| `test/unit/context/providers/*.test.ts` (per-provider) | 0-3 |
| `test/unit/session/manager.test.ts` | 0 |
| `test/unit/session/scratch.test.ts` | 1 |
| `test/integration/context/end-to-end-stage-progression.test.ts` | 2 |
| `test/integration/context/pull-tool-budget.test.ts` | 4 |
| `test/integration/session/crash-resume.test.ts` | 0 |
| `test/integration/session/fallback-handoff.test.ts` | 5.5 |

---

## Acceptance Criteria (Complete: 1-83)

### Base spec (1-43)

1-12: Orchestrator contract, parity, provider interface, parallel fetch, timeout, budget (floor overrides ceiling), packing (greedy Phase 0, DP Phase 3+), role filtering, dedup, digest propagation (end-to-end threading specified), session scratch, manifest writing.

13-18: Pull tools, budget, graceful degradation, config validation, no-op when disabled, metrics.

19-26: Manifest inspection, scratch retention, v1 preserved, builder migration, plugin integration, determinism mode, cost accounting, self-dogfooding.

27-33: Agent profile registry, canonical rules delivery, neutrality linter, rules export, legacy compat flag, agent-dimension budget, tool registration gated on capability.

34-43: Fallback trigger categories, fallback map resolution, fallback same tier, rebuild portable state, rebuild latency (<= 100ms), rebuild manifest, fallback hop bound, fallback observability, cross-agent scratch neutralization, failure-note determinism.

### Amendment A: Context Pollution (44-49)

44: Min-score threshold. 45: Effectiveness signal. 46: Staleness flag. 47: Contradiction detection. 48: Pollution metrics. 49: No runtime cost.

### Amendment B: Execution Modes (50-53)

50: Stage sequences documented. 51: Plan digest boost. 52: Scratch write coverage. 53: No-test rectify scope.

### Amendment C: Monorepo (54-62)

54: Dual workdir. 55: GitHistory package scope. 56: CodeNeighbor package scope. 57: Per-package rules overlay. 58: Feature context repo-scoped. 59: Per-package stage budgets. 60: Manifest records package. 61: Non-monorepo no-op. 62: Cross-package neighbor.

### Amendment D: Session Manager (63-78)

63: Session creation. 64: Session resume. 65: State machine enforcement. 66: Stage recording. 67: Handoff. 68: Adapter demotion. 69: PipelineContext threading. 70: Scratch directory lifecycle. 71: Orphan detection. 72: Concurrent safety. 73: Close policy centralized. 74: Three-session TDD integration. 75: Single-session integration. 76: Protocol ID capture. 77: Audit correlation chain. 78: Protocol ID on manifest.

### Integration gaps (79-83)

79: Session error retries transparent. 80: Adapter fallback coexistence. 81: Adapter fallback replacement. 82: Timeout treated as failed. 83: Force-terminate on close.

### Context window coordination (84)

84: **Available budget respected.** When `ContextRequest.availableBudgetTokens` is provided, `ContextBundle.budgetUsed` never exceeds it. Verified by passing a small `availableBudgetTokens` (e.g. 1024) with a stage config of 4096 and confirming the packed output stays within 1024.

---

## Open Questions (Complete: 1-25)

| # | Question | Status | Tentative |
|:--|:---------|:-------|:----------|
| 1 | Pull tool surface — per-provider or dispatched? | Open | Per-provider |
| 2 | Push block ordering in prompt | Open | Scope-ordered sections |
| 3 | Manifest privacy | Open | Archive opt-in |
| 4 | Static rules integration with src/context/ | Open | Absorb |
| 5 | Builder API change size (Phase 0 adapter?) | Open | `.context(bundle.pushMarkdown)` adapter |
| 6 | Where does digest live for resume? | Open | Write to scratch |
| 7 | Cost attribution from providers | Open | `metrics.context.providers[id].cost` |
| 8 | Cross-feature retrieval via RAG | Open | Opt-in |
| 9 | Tool-call failures | Open | Return structured error to agent |
| 10 | Determinism modes flag | Open | `context.deterministic: true` |
| 11 | Fallback escalation ordering | **Resolved** | Orthogonal axes |
| 12 | Agent profile registry ownership | Open | Hardcoded built-in + plugin |
| 13 | Fall back on quality failures? | **Resolved** | Availability only by default |
| 14 | Rules-in-neutral-form timing | **Resolved** | Ship with v2, not follow-up |
| 15 | Legacy CLAUDE.md fallback duration | Open | One minor version |
| 16 | Who authors .nax/rules/ initially | Open | `nax rules migrate` + style guide |
| 17 | Fallback credential discovery | Open | Env vars + fallback map entry |
| 18 | Cross-agent RAG index neutralization | Open | Track under RAG spec |
| 19 | Effectiveness signal accuracy | Open | Start keyword, add LLM if < 80% |
| 20 | Staleness across features | Open | Per-feature only |
| 21 | Package-level feature context | Open | No (revisit on request) |
| 22 | Batch mode cross-feature | Open | Primary story's featureId |
| 23 | Session manager vs adapter naming | Open | Manager owns ID, adapter derives |
| 24 | Scratch sharing across TDD sub-sessions | **Resolved** | `storyScratchDirs` on ContextRequest, populated by pipeline stage |
| 25 | Session manager as v2 prerequisite | Open | Ship alongside Phase 0 |

---

## Risk Summary

| Risk | Severity | Mitigation |
|:-----|:---------|:-----------|
| Orchestrator becomes god-object | Medium | Split into core/*.ts modules, 400-line limit |
| Latency regression (parallel fetch + knapsack) | Medium | Per-provider timeout (5s), metrics track wall-clock |
| Manifest size explosion (160 per run) | Low | Small files, gitignored, TTL cleanup |
| Pull tool budget gaming | Medium | Per-session + per-run ceilings, cost metrics |
| Provider ordering dependence | Low | Parallel fetch, budget floor by kind |
| Session scratch leaks secrets | Medium | Gitignored, regex redaction, TTL cleanup |
| Non-determinism from plugins | Medium | Manifest records hashes, version pinning |
| v1 regressions from role-filter move | High | Phase 0 parity tests (byte-identical) |
| Canonical rules migration cost | Medium | `nax rules migrate` + neutrality linter |
| Fallback rebuild latency | Low | LLM-free, target <= 100ms |
| Fallback hides degraded service | Medium | `context.fallback.triggered` metric, `nax status` |
| Context pollution (stale/noisy chunks) | Medium | minScore + staleness + effectiveness signal + pollution metrics |
| Per-package rules drift | Low | `nax rules lint` validates both levels |
| Adapter-manager synchronization | Medium | `lastActivityAt` heartbeat, `sweepOrphans()` |
| Adapter migration complexity (~315 lines) | Medium | Dual-write Phase 0, flip Phase 1, remove Phase 5.5 |
