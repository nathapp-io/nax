# ADR-010: Context Engine (CONTEXT-002)

**Status:** Accepted  
**Date:** 2026-04-16  
**Author:** William Khoo, Claude

---

## Context

nax v1 delivered context to every pipeline stage as a single monolithic markdown string built from one file (`context.md`) at prompt-build time. That worked for its original scope — single-agent, single-source, single-stage context injection — but exposed five compounding problems as the pipeline grew:

**1. Stage-blind injection.**  
Every stage (decompose, plan, test-writer, implementer, reviewer, rectifier, autofix) received the same context blob regardless of what it needed. A rectifier retrying a lint failure read the same corpus as a greenfield implementer.

**2. Session-blind injection.**  
A story's internal sessions (plan → test-writer → implementer → verifier → reviewer → rectifier) are isolated at the ACP layer. Observations captured during the test-writer session never reached the implementer session, even though they operated on the same code within the same story in the same run.

**3. Single source of truth was a single file.**  
External knowledge — company wikis, ADR databases, embedding indexes, symbol graphs — could not be layered in without forking the provider. The provider interface was a single hard-coded load call, not a contract.

**4. No pull path.**  
Agents could not request context mid-session. Everything had to be pre-injected at prompt build. Long-running roles (implementer) paid for worst-case context guesses on every session.

**5. Agent lock-in and availability fragility.**  
Rules were authored in Claude-specific files (`CLAUDE.md`, `.claude/rules/`). When Claude became unavailable and the runner switched agents, the new agent received a prompt referencing files it would not read on its own. The context substrate (rules + session scratch + feature memory) had no agent-portable representation.

---

## Decision

**Build a stage-aware, session-aware, pluggable context engine (`src/context/engine/`) as the single point of context assembly for all pipeline stages.**

### Core architecture

```
IContextProvider
  ├── StaticRulesProvider      (.nax/rules/ → canonical rules, agent-agnostic)
  ├── FeatureContextProviderV2 (context.md  → feature working memory)
  ├── SessionScratchProvider   (session scratch dirs → cross-stage observations)
  ├── GitHistoryProvider       (git log diffs → recent change context)
  ├── CodeNeighborProvider     (import graph → co-changed file context)
  └── [plugin providers]       (RAG / graph / KB — operator-registered)

ContextOrchestrator.assemble(ContextRequest)
  1. Filter providers for this stage (stageConfig.providerIds)
  2. Parallel fetch with 5-second timeout per provider
  3. Score chunks (role × freshness × kind weights)
  4. Deduplicate (character-level trigram Jaccard ≥ 0.9)
  5. Role filter (drop chunks whose audience tag mismatches request.role)
  6. Min-score filter (drop noise below config.context.v2.minScore)
  7. Greedy pack (floor items first, then fill budget ceiling)
  8. Render push markdown (scope-ordered: project → feature → story → session → retrieved)
  9. Build digest (≤250 tokens, deterministic — threaded into the next stage's request)
  → ContextBundle { pushMarkdown, pullTools, digest, manifest, chunks }
```

### Key decisions within the design

**D1. Provider interface as a duck-typed contract, not inheritance.**  
`IContextProvider` requires three fields: `id: string`, `kind: ChunkKind`, and `fetch(request): Promise<ContextProviderResult>`. No base class, no registry injection. This allows third-party providers (npm packages, relative-path modules) to implement the interface without depending on nax internals. Validated at load time via structural duck-typing in `plugin-loader.ts`.

**D2. Chunk-level granularity, not document-level.**  
Providers return `RawChunk[]` rather than a single markdown string. Each chunk carries `kind`, `scope`, `role`, `rawScore`, and `tokens`. This enables per-chunk scoring, deduplication, role filtering, and budget packing that document-level injection cannot achieve. The bundle manifest records exactly which chunks were included, excluded, and why — making context decisions auditable.

**D3. Hybrid push/pull model.**  
Push markdown (pre-injected) is the default for all stages. Pull tools (agent-callable mid-session) are opt-in per stage via `config.context.v2.pull` and constrained by `maxCallsPerSession`. This separates "context the agent will always need" (push) from "context too large to pre-inject that the agent can request when needed" (pull). Initial pull tools: `query_neighbor` and `query_feature_context`.

**D4. Deterministic digest for progressive threading.**  
`buildDigest()` produces a ≤250-token summary of each stage's bundle. The next stage's `ContextRequest.priorStageDigest` receives this digest, so the agent always sees a running record of what prior stages assembled — even across session boundaries. Digest is deterministic (same packed chunks → byte-identical digest) so crash-resume produces the same value the original run would have.

**D5. Availability fallback via rebuildForAgent().**  
When an agent adapter reports an availability failure (quota, rate limit, service down), the orchestrator calls `rebuildForAgent(prior, { newAgentId, failure })` which re-renders the existing bundle under the new agent's profile without re-fetching providers. A synthetic failure-note chunk is injected describing the swap. This preserves the story's context substrate across agent changes without any provider I/O.

**D6. Canonical rules store, not agent-specific files.**  
`StaticRulesProvider` reads from `.nax/rules/` (canonical store, agent-agnostic markdown) rather than from `.claude/rules/` or `CLAUDE.md`. Agent-specific files become optional shims; the canonical store is the source of truth for all agents. Config flag `allowLegacyClaudeMd` falls back to the legacy path during the migration period (default: `true`).

**D7. Plugin provider loader with non-fatal semantics.**  
`loadPluginProviders()` (Phase 7) dynamically imports operator-configured `IContextProvider` implementations from npm packages or project-relative paths. Three failure modes (module not found, invalid export shape, `init()` failure) each log a structured warning and skip the provider — never block the pipeline. Path traversal protection prevents relative module paths from escaping the project `workdir`. All providers load in parallel via `Promise.allSettled`.

**D8. Opt-in by default, no silent rollout.**  
`config.context.v2.enabled` defaults to `false`. Projects enable the engine explicitly per project config. The v1 code path (`FeatureContextProvider` + plugin context providers) runs unchanged when v2 is disabled. The v2 path produces `ctx.contextBundle`; existing prompt builders read `bundle.pushMarkdown` via the `ctx.featureContextMarkdown` compat shim until they migrate to direct bundle access.

---

## Alternatives Considered

### A. Extend v1 in-place (add providers to the existing pipeline)

Add RAG/graph/KB as optional injectors plugged into the existing `FeatureContextProvider` and merge their output into the existing markdown string.

**Rejected because:** The existing flow has no scoring, no deduplication, no role filtering, no budget orchestration, and no manifest. Adding providers without these primitives produces context bloat and no auditability. Each new source would require bespoke budget logic. The v1 interface (provider returns a `{ content, label, estimatedTokens }` tuple) has no concept of stage, role, or chunk identity — it cannot support the stage-granularity requirement.

### B. Embedding-based similarity for deduplication and scoring

Use vector embeddings to score chunk relevance (cosine similarity to the current request) and detect near-duplicate chunks.

**Rejected for initial implementation** because it introduces a runtime dependency on an embedding model (latency, cost, model availability). Character-level trigram Jaccard similarity is deterministic, zero-latency, zero-cost, and sufficient for the chunk sizes and duplication patterns observed in the v1 corpus. The design explicitly defers to embedding-based scoring in Phase 3+ once the provider ecosystem produces retrieval results where semantic distance matters more than lexical overlap. The `MIN_SCORE` floor and scoring weights are the tuning lever; replacing the similarity algorithm is a localized change to `dedupe.ts` and `scoring.ts` that does not touch the orchestrator API.

### C. Single global provider set (no stage filtering)

Register all providers globally and deliver all their chunks to every stage, relying on role filtering and budget packing to drop what's irrelevant.

**Rejected because:** Stage filtering is a performance and determinism tool, not just a relevance tool. `GitHistoryProvider` makes filesystem calls; `CodeNeighborProvider` traverses the import graph. Running all providers on every stage (13 stages per story, potentially parallel stories) multiplies I/O by the stage count unnecessarily. Stage filtering (`STAGE_CONTEXT_MAP`) is explicit configuration — operators can see exactly which providers fire on which stage without tracing code.

### D. Implement pull as a streaming side-channel (WebSocket / SSE)

Rather than returning pull tool descriptors alongside push markdown, open a streaming channel to serve agent pull requests in real-time.

**Rejected because:** nax's ACP adapter model is request/response, not streaming. Pull tools are registered on the ACP session as callable tools — the agent invokes them through the normal tool-call protocol. This is simpler, auditable (tool calls appear in the session transcript), and compatible with all ACP-capable agents. A streaming channel would require changes to the adapter layer and session lifecycle that exceed the Phase 4 scope.

### E. Persist ContextBundle to disk between stages

Write the assembled bundle to the session scratch directory so subsequent stages can read it without re-fetching providers.

**Rejected because:** The digest — a ≤250-token deterministic summary — threads between stages via `ContextRequest.priorStageDigest` without persisting the full bundle. Each stage's assemble call is fast (parallel fetch, no LLM, <100ms target) and produces a fresh bundle tuned to that stage's role and provider set. Persisting the full bundle would require schema versioning, cache invalidation on provider config changes, and safe concurrent access from parallel stories. The digest achieves the goal (cross-stage continuity) at a fraction of the complexity. Full bundle persistence is deferred to a future "cold resume" spec for story-level crash recovery where cold-start latency matters.

---

## Consequences

### Positive

- **Stage-appropriate context.** Each pipeline stage receives a bundle scored and filtered for its exact role. Reviewers get reviewer-role chunks; implementers get implementer-role chunks. Role-mismatch chunks are excluded and recorded in the manifest.
- **Budget discipline.** The greedy packer with floor items ensures high-priority chunks (static rules, feature context) are always included regardless of budget; remaining budget fills with scored chunks. No silent truncation — all exclusions are manifest-recorded with reason.
- **Auditability.** Every `assemble()` call produces a `ContextManifest` recording included chunks, excluded chunks (with reason: role-filter / below-min-score / dedupe / budget), floor items, token counts, and build latency. Context-driven agent mistakes can be traced to specific chunks.
- **Provider extensibility.** Adding a new provider means implementing `IContextProvider` (three fields) and registering it in `createDefaultOrchestrator()` or operator config. No changes to the orchestrator, pipeline stages, or prompt builders.
- **Agent portability.** `StaticRulesProvider` delivers canonical rules in agent-agnostic markdown. `rebuildForAgent()` preserves the context substrate across agent swaps. A story continues from its last checkpoint regardless of which agent continues it.
- **Plugin ecosystem.** Phase 7's `loadPluginProviders()` enables operator-registered RAG, graph, and KB providers via npm packages or project-relative paths — no nax core changes required to add domain-specific context sources.

### Negative / Trade-offs

- **Two code paths during transition.** `config.context.v2.enabled: false` (default) runs the v1 path; `true` runs v2. Both paths must be maintained until all callers migrate to bundle access. The compat shim (`ctx.featureContextMarkdown = bundle.pushMarkdown`) reduces migration friction but doubles the surface to test. Stages calling `ctx.config.context?.v2?.enabled` with defensive optional chaining expose the gap between Zod-parsed production configs (where `v2` is always present) and test fixtures that bypass the parser.
- **Provider I/O on every stage.** Unlike v1's single load at the context stage, v2 fetches providers at every assembling stage (context, execution, verify, rectify). `GitHistoryProvider` and `CodeNeighborProvider` make filesystem calls on each call. Mitigation: 5-second timeout per provider, stage filtering limits which providers fire per stage, and the provider set is short-circuited to empty results when `touchedFiles` is absent (the common case for many stages).
- **Trigram deduplication false positives.** Two chunks with different semantic meaning but similar surface text (e.g., two error messages using the same boilerplate) may be incorrectly merged. Jaccard ≥ 0.9 is a conservative threshold that prioritizes false negatives (keeping duplicates) over false positives (dropping unique content). Observed impact: minimal in practice because chunk sizes (~100-500 tokens) are large enough for Jaccard to distinguish structurally different content.
- **Plugin path traversal limited to workdir.** The traversal guard (`resolvedPath.startsWith(resolvedWorkdir + "/")`) prevents plugin modules from escaping the project root but does not validate npm package names against a allowlist. A malicious package name resolved by the runtime is outside the guard's scope. Plugin providers are operator-configured — they are in the same trust boundary as the project config file itself.
- **Digest determinism requires stable chunk IDs.** Providers are responsible for producing stable `id` values (`<providerId>:<contentHash8>`) across runs. A provider that generates non-deterministic IDs (e.g., timestamp-based) will produce different digests for identical content, breaking progressive threading. This is a provider contract that is not enforced by the orchestrator — it relies on convention.

### Scope of Changes (Phase 0–7)

| Phase | What was built | Key files |
|:------|:--------------|:----------|
| 0 | `IContextProvider`, `ContextOrchestrator`, `ContextBundle`, `ContextManifest`, scoring, dedup, packing, render, digest, `StaticRulesProvider`, `FeatureContextProviderV2`, context stage v2 path | `src/context/engine/` |
| 1 | `SessionScratchProvider`, session scratch read/write, `ctx.sessionScratchDir` | `providers/session-scratch.ts`, `session/scratch-writer.ts` |
| 2 | Prior-stage digest threading, digest persistence, crash resume | `orchestrator.ts`, `context.ts` |
| 3 | `GitHistoryProvider`, `CodeNeighborProvider`, `touchedFiles` threading | `providers/git-history.ts`, `providers/code-neighbor.ts` |
| 4 | Pull tools infrastructure, `PULL_TOOL_REGISTRY`, `handleQueryNeighbor`, `handleQueryFeatureContext` | `pull-tools.ts`, `stage-config.ts` |
| 5.1 | Canonical rules store, `loadCanonicalRules`, `lintForNeutrality`, `CANONICAL_RULES_DIR` | `rules/canonical-loader.ts` |
| 5.5 | `rebuildForAgent()`, `RebuildOptions`, `AdapterFailure`, agent profiles, `renderForAgent()` | `orchestrator.ts`, `agent-profiles.ts`, `agent-renderer.ts` |
| 6 | Renamed `src/context/v2/` → `src/context/engine/`, made `v2` required in config schema | `src/context/engine/`, `src/config/schemas.ts` |
| 7 | Plugin provider loader, `ContextPluginProviderConfig`, path traversal guard, `InitialisableProvider` lifecycle | `providers/plugin-loader.ts`, `orchestrator-factory.ts` |

---

## Post-Acceptance Amendments

The core decisions (D1–D8) have been extended by four amendment specs after this ADR was accepted. Each adds primitives on top of the existing architecture — none reverse a decision above.

### Amendment A — Context pollution prevention (AC-44–49, Accepted 2026-04-17)

Adds three deterministic post-hoc signals to the packer, none of which invoke an LLM:

- **Min-score floor** (`config.context.v2.minScore`, default 0.1) — chunks scoring below threshold are dropped before packing; floor items (static rules, feature context) are exempt.
- **Staleness flag** (`src/context/engine/staleness.ts`) — age-based + contradiction-based detection annotates chunks with `staleCandidate: true` and multiplies their score by a configured factor (default 0.4). Human removal is still required; the flag surfaces candidates.
- **Pollution metrics** (`src/context/engine/pollution.ts`) — per-run aggregates (`droppedBelowMinScore`, `staleChunksInjected`, `pollutionRatio`) written to `StoryMetrics.context.pollution`, surfaced in `nax status` when ratio > 0.3.

Effectiveness classification (`src/context/engine/effectiveness.ts`) annotates each chunk post-story as `followed | contradicted | ignored | unknown` based on deterministic signals (agent output, review findings, diff). Ops-facing only — no feedback loop into scoring.

Spec: [SPEC-context-engine-v2-amendments.md](../specs/SPEC-context-engine-v2-amendments.md) §Amendment A.

### Amendment B — Execution-mode stage sequences (AC-50–53, Accepted 2026-04-17)

Adds `planDigestBoost: 1.5` to `STAGE_CONTEXT_MAP` for single-session, tdd-simple, no-test, and batch modes. The prior-stage plan digest's `rawScore` is multiplied by the boost when the stage opts in, giving it competitive footing against fresh provider chunks in scoring/packing. Does not change the digest content or threading mechanism (D4 preserved).

Spec: [SPEC-context-engine-v2-amendments.md](../specs/SPEC-context-engine-v2-amendments.md) §Amendment B.

### Amendment C — Monorepo scoping (AC-54–62, Accepted 2026-04-17)

Introduces dual-workdir resolution in `ContextRequest`:

- **`repoRoot`** (renamed from `workdir`) — absolute path to the git root.
- **`packageDir`** (new) — absolute path to the story's target package; equals `repoRoot` in non-monorepo projects.

Provider scopes become configurable:
- `GitHistoryProvider.historyScope: "package" | "repo"` (default `package`)
- `CodeNeighborProvider.neighborScope: "package" | "repo"` + `crossPackageDepth: 0 | 1 | 2` (defaults `package`, depth 1)
- `StaticRulesProvider` overlays `<repoRoot>/.nax/rules/` with `<packageDir>/.nax/rules/`; same-filename entries → package wins (AC-57).

`FeatureContextProviderV2` remains repo-scoped (AC-58) — features are cross-cutting. Manifest records both paths (AC-60) for audit.

Spec: [SPEC-context-engine-v2-amendments.md](../specs/SPEC-context-engine-v2-amendments.md) §Amendment C.

### Amendment D — Session Manager ownership (AC-63–78, Accepted 2026-04-18)

Moves session lifecycle out of the adapter into a dedicated `SessionManager`. This is a cross-cutting architectural change with its own ADR; see **[ADR-011](ADR-011-session-manager-ownership.md)** for ownership boundary, 7-state machine, force-terminate (AC-83), handoff semantics, and mapping from ADR-008's `keepSessionOpen` primitive.

Intersection with this ADR: `SessionScratchProvider` now reads `descriptor.scratchDir` from the manager rather than re-deriving it from `(workdir, feature, storyId)`. D4's digest threading continues to work unchanged because digests persist on the descriptor, not the physical session.

Spec: [SPEC-session-manager-integration.md](../specs/SPEC-session-manager-integration.md).

### Additional post-acceptance hardening (not amendment-level)

- **AC-16 unknown provider validation** — `assemble()` throws `CONTEXT_UNKNOWN_PROVIDER_IDS` when a stage config references an unregistered provider. Test-override `request.providerIds` filters silently (intentional; test-only).
- **AC-19 `nax context inspect`** — CLI manifest formatter ([src/cli/context.ts](../../src/cli/context.ts)).
- **AC-20 scratch retention** — `purgeStaleScratch()` runs at run completion; retention days configurable.
- **AC-24 determinism mode** — `request.deterministic: true` excludes providers marked `deterministic: false`.
- **AC-25 provider cost accounting** — per-provider `costUsd` rolled up into `StoryMetrics.context.providers[*].costUsd`.
- **AC-41 agent-swap observability** — `ctx.agentFallbacks[]` records every swap hop; surfaced as `StoryMetrics.fallback.hops[]`.
- **AC-42 cross-agent scratch neutralization** — scratch entries are rewritten to drop agent-specific tooling references before being replayed for a fallback agent ([src/context/engine/scratch-neutralizer.ts](../../src/context/engine/scratch-neutralizer.ts)).

---

## References

- [SPEC-context-engine-v2.md](../specs/SPEC-context-engine-v2.md) — full implementation spec
- [SPEC-context-engine-v2-amendments.md](../specs/SPEC-context-engine-v2-amendments.md) — Amendments A–D
- [SPEC-context-engine-v2-compilation.md](../specs/SPEC-context-engine-v2-compilation.md) — compiled view
- [SPEC-context-engine-agent-fallback.md](../specs/SPEC-context-engine-agent-fallback.md) — fallback taxonomy + handoff
- [SPEC-context-engine-canonical-rules.md](../specs/SPEC-context-engine-canonical-rules.md) — canonical rules store design
- [SPEC-session-manager-integration.md](../specs/SPEC-session-manager-integration.md) — Amendment D mechanism spec
- [SPEC-feature-context-engine.md](../specs/SPEC-feature-context-engine.md) — v1 spec (superseded for new providers; storage layout unchanged)
- `src/context/engine/` — implementation
- `test/unit/context/engine/` — unit tests (37 files)
- ADR-007, ADR-008 — session lifecycle decisions that motivated Phase 5.5 availability fallback
- [ADR-011](ADR-011-session-manager-ownership.md) — session manager ownership (Amendment D)
