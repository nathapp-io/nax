# Context Engine v2 Branch Review

Date: 2026-04-16
Branch reviewed: `feat/context-engine-v2`
Base compared: `main`

## Scope

Review of the current branch implementation against:

- `docs/specs/SPEC-context-engine-v2.md`
- `docs/specs/SPEC-context-engine-v2-amendments.md`
- `docs/specs/SPEC-context-engine-v2-compilation.md`
- `docs/adr/ADR-010-context-engine.md`

This review focuses on correctness, integration depth, and spec/ADR gaps.

## Findings

### 1. High: engine is not yet integrated as a per-stage assembler

The implementation currently assembles a v2 bundle only in the `context` stage, then copies the rendered markdown into the legacy `featureContextMarkdown` field.

Evidence:

- `src/pipeline/stages/context.ts:91`
- `src/pipeline/stages/context.ts:136`

Downstream runtime paths still consume the legacy prompt channel instead of assembling stage-specific bundles at execution/review time:

- `src/pipeline/stages/prompt.ts:74`
- `src/tdd/session-runner.ts:145`
- `src/review/semantic.ts:229`
- `src/review/adversarial.ts:223`

Impact:

- The stage-aware provider selection is not really in effect at the runtime points that matter.
- Stage-specific budgets and digest threading are not reaching execution, TDD, rectify, and review in the way the spec describes.
- The branch currently behaves more like a precomputed context blob than a stage-aware context engine.

### 2. High: the v1 compatibility shim is lossy and can drop v2 content

`bundle.pushMarkdown` is copied into `ctx.featureContextMarkdown`, but that field is still processed by v1-style role filtering in TDD and review prompt builders.

Evidence:

- `src/pipeline/stages/context.ts:139`
- `src/prompts/builders/tdd-builder.ts:149`
- `src/review/semantic.ts:231`
- `src/review/adversarial.ts:225`

The legacy filter is designed for `context.md` bullet entries and explicitly drops free-form section content inside `##` sections.

Evidence:

- `src/context/feature-context-filter.ts:84`
- `src/context/feature-context-filter.ts:123`

Impact:

- Static rules, scratch/history/neighbor sections, and other generic rendered markdown can be partially or fully discarded before they reach the agent.
- This creates a hidden mismatch where the orchestrator assembles one bundle, but prompt builders may inject a materially different subset.

### 3. High: pull tools are implemented but not wired into agent runs

The orchestrator returns `pullTools`, but there is no runtime path that registers them with an agent session.

Evidence:

- `src/context/engine/orchestrator.ts:229`
- `src/context/engine/orchestrator.ts:291`

`AgentRunOptions` does not expose a place to pass tool descriptors or server-side handlers into adapters.

Evidence:

- `src/agents/types.ts:55`

I also could not find production call sites consuming `ctx.contextBundle.pullTools`.

Impact:

- `query_neighbor` and `query_feature_context` are effectively dead code in normal execution.
- The branch currently delivers push-only behavior even though the spec/ADR treats pull as a core part of the design.

### 4. Medium: `rebuildForAgent()` does not preserve rebuilt audit state

`assemble()` does not set `bundle.agentId`, even though the type contract says it should.

Evidence:

- `src/context/engine/types.ts:185`
- `src/context/engine/orchestrator.ts:291`

`rebuildForAgent()` injects a synthetic failure-note chunk into local `packedChunks`, but returns `chunks: prior.chunks` and keeps the inherited manifest chunk lists.

Evidence:

- `src/context/engine/orchestrator.ts:334`
- `src/context/engine/orchestrator.ts:358`
- `src/context/engine/orchestrator.ts:372`

Impact:

- The rebuilt prompt may contain information that is missing from the returned bundle state.
- Manifest/audit data for availability fallback is incomplete.
- A second rebuild or later inspection cannot rely on the returned bundle as the full source of truth.

## Gaps Against Spec / ADR

### 1. Session-aware continuity is only partially implemented

The spec expects story-level scratch aggregation across sessions, but the context stage currently seeds only a single scratch dir for the current pipeline run.

Evidence:

- `src/pipeline/stages/context.ts:55`
- `src/pipeline/stages/context.ts:63`

`SessionManager` exists, but is still described and implemented as a non-authoritative in-memory skeleton. I could not find production wiring that uses it to drive context assembly.

Evidence:

- `src/session/manager.ts:4`
- `src/session/manager.ts:54`

Gap:

- The spec flow using `getForStory(storyId).map(s => s.scratchDir)` is not actually in place.
- Cross-session learning for three-session TDD is therefore not fully realized.

### 2. Stage map coverage is incomplete relative to the compiled design

The current stage config only covers a subset of the documented stage matrix and execution modes.

Evidence:

- `src/context/engine/stage-config.ts:101`

Missing or under-modeled relative to the compiled spec:

- `single-session`
- `no-test`
- `batch`
- `route`
- `review-dialogue`
- `debate`

There are also material differences in stage budgets and provider selection versus the compiled design.

### 3. `ContextRequest` is narrower than the design contract

The implementation request type lacks several design-level fields that the spec and ADR describe, including target agent metadata/capabilities, explicit session identity, richer failure/review hints, and monorepo repo/package scoping.

Evidence:

- `src/context/engine/types.ts:226`

Gap:

- Agent-aware budgeting/rendering is only partially modeled.
- Availability fallback and monorepo behavior are not represented end-to-end at the request boundary.

### 4. Manifest auditability is mostly in-memory, not persisted

The spec and compiled design describe per-stage context manifests and inspection tooling, but I could not find production code that writes `context-manifest-*.json` files or implements `nax context inspect`.

Evidence:

- `src/context/engine/orchestrator.ts:265`
- search across `src/cli` and `src/context` found no production `context inspect` command

Gap:

- The manifest exists as a return value but not yet as durable audit output.
- This weakens one of the main design goals: explainability of injected context.

## Overall Assessment

The branch builds a substantial amount of good engine scaffolding:

- orchestrator
- provider abstraction
- scoring / dedupe / packing
- session scratch provider
- canonical rules loader
- plugin provider loader
- rebuild scaffolding

The main issue is not lack of implementation volume. The main issue is integration depth.

Right now, the codebase has a strong engine core, but the actual runtime still mostly behaves like the old single-blob system because:

1. bundle assembly is concentrated in the `context` stage,
2. downstream prompt construction still flows through legacy `featureContextMarkdown`,
3. pull tools are not registered with agents,
4. session-manager-driven cross-session continuity is not yet authoritative.

## Recommended Next Steps

1. Stop routing v2 through `featureContextMarkdown` for the main execution paths; consume `ContextBundle` directly in prompt/runtime code.
2. Add stage-specific `assemble()` calls at the real execution points: single-session prompt, TDD sub-sessions, verify/rectify, and review.
3. Extend adapter run options and runtime wiring so `pullTools` can be registered and handled for actual sessions.
4. Make session-manager-backed story scratch discovery authoritative before claiming cross-session continuity.
5. Persist manifests to disk and add the inspection CLI promised by the design.

## Review Notes

This review was produced by code inspection of the current branch diff against `main` and comparison against the listed specs/ADR. It does not claim that the implementation is without value; the core architecture work is substantial. The current concern is that the shipped behavior does not yet match the architecture that the docs describe.
