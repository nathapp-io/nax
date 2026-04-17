# Context Engine v2 Architecture Review

Date: 2026-04-16

## Scope

This review focuses on the architecture of Context Engine v2 after the recent implementation work. The goal is not to re-check the earlier fixed defects, but to look for structural weaknesses, hidden coupling, and failure modes that could become operational issues as the system grows.

## Overall Assessment

The core architecture is strong. The chunk-based provider model, deterministic digesting, rebuild-on-agent-swap flow, and explicit stage configuration are solid foundations.

The main weaknesses sit at the integration seams:

- root path semantics in monorepos
- continuity across attempt boundaries
- completeness of manifest-based auditability
- stage separation for review modes
- lifecycle management for plugin providers

These are the areas most likely to produce subtle behavior drift, confusing operator experience, or scalability problems as more providers and stages are added.

## Findings

### 1. High: repo-root and package-scoped path semantics are still mixed

The runtime distinguishes between repo-root `projectDir` and package-scoped `workdir`, but Context Engine v2 still assembles requests and loads plugin providers from `ctx.workdir`.

Relevant references:

- `src/execution/iteration-runner.ts:137`
- `src/execution/iteration-runner.ts:138`
- `src/pipeline/stages/context.ts:109`
- `src/pipeline/stages/context.ts:136`
- `src/context/engine/stage-assembler.ts:72`
- `src/context/engine/stage-assembler.ts:80`
- `src/context/engine/providers/static-rules.ts:87`
- `src/context/engine/providers/static-rules.ts:150`
- `src/context/rules/canonical-loader.ts:141`
- `src/context/providers/feature-context.ts:54`
- `src/context/providers/feature-context.ts:57`

Why this matters:

- root-scoped providers can resolve `.nax`, canonical rules, and feature memory from the package directory instead of the repository root
- relative plugin modules can be discovered from the wrong base
- the engine has no explicit signal that it queried the wrong root, so failures can look like "missing context" instead of "bad root selection"

Likely impact:

- monorepo stories can lose canonical rules or feature context silently
- package-scoped executions can behave differently from repo-root executions in hard-to-debug ways

## 2. Medium-High: continuity persists on disk, but discovery remains in-memory

Scratch and manifests are persisted, but session discovery still depends on an in-memory `SessionManager` and the current `sessionScratchDir`.

Relevant references:

- `src/session/manager.ts:57`
- `src/execution/iteration-runner.ts:148`
- `src/context/engine/stage-assembler.ts:37`
- `src/context/engine/stage-assembler.ts:46`
- `src/pipeline/stages/context.ts:89`
- `src/tdd/orchestrator.ts:511`

Why this matters:

- continuity works well inside a single pipeline execution
- continuity can disappear across escalation boundaries or fresh invocations
- persisted artifacts on disk are not enough if discovery logic does not rehydrate them

Likely impact:

- prior-attempt context may be lost even though scratch and manifests still exist
- operators may assume the system is learning across attempts when it actually is not
- recovery and replay behavior can become inconsistent

## 3. Medium: the manifest is not yet a complete audit surface

Provider failures and timeouts are flattened into empty results before manifest construction.

Relevant references:

- `src/context/engine/orchestrator.ts:212`
- `src/context/engine/orchestrator.ts:222`
- `src/context/engine/orchestrator.ts:265`
- `src/context/engine/types.ts:129`

Why this matters:

- the manifest can explain chunk inclusion and exclusion
- it cannot explain whether a provider timed out, failed to initialize, or returned nothing due to an execution error
- missing context therefore remains partially opaque unless someone inspects logs

Likely impact:

- the manifest cannot fully support the "explainable assembly" promise
- debugging provider instability will require cross-checking logs instead of relying on one artifact
- operators may misread absent context as policy or budget exclusion when it was actually a provider failure

## 4. Medium: semantic and adversarial review still share one assembled bundle

The stage map models `review-semantic` and `review-adversarial` separately, but the current review path assembles only the semantic bundle and then reuses it for both review modes.

Relevant references:

- `src/review/orchestrator.ts:472`
- `src/review/runner.ts:292`
- `src/review/runner.ts:334`
- `src/context/engine/stage-config.ts:160`
- `src/context/engine/stage-config.ts:168`

Why this matters:

- the code path is currently coupled even though the configuration model says the stages are distinct
- today the configurations happen to match, but the wiring guarantees future drift if the stages ever diverge
- the design intent and the execution path are not aligned

Likely impact:

- one review mode cannot gain distinct providers, budgets, or pull tools without extra refactoring
- future stage-level changes may appear configured but not actually take effect

## 5. Medium: plugin providers have no reuse or teardown lifecycle

Plugin providers are loaded as fresh instances on each assembly pass, with optional `init()`, but there is no cache, reuse strategy, or teardown hook.

Relevant references:

- `src/context/engine/providers/plugin-loader.ts:9`
- `src/context/engine/providers/plugin-loader.ts:138`
- `src/context/engine/providers/plugin-loader.ts:185`
- `src/pipeline/stages/context.ts:134`
- `src/context/engine/stage-assembler.ts:71`

Why this matters:

- light providers are fine under this model
- heavier providers such as graph backends, embedding indexes, or socket/file-handle backed services can become expensive or leaky
- the architecture currently assumes provider setup is cheap and disposable

Likely impact:

- repeated initialization cost across stage assembly
- avoidable latency for multi-stage workflows
- risk of resource leakage if future providers acquire long-lived handles

## Open Questions and Assumptions

### Monorepo root policy

If the intended model is "each package owns its own `.nax/` root", the first finding is less severe. If the intended model is "repo-root `.nax/` with package-local `workdir`", then the current behavior is a real architectural bug.

### Review stage divergence

If semantic and adversarial review are intentionally guaranteed to share the same context policy forever, the fourth finding is lower priority. The current stage configuration suggests that divergence is expected.

### Continuity contract

If the design only promises continuity inside a single pipeline execution, the second finding is a limitation rather than a defect. The fact that scratch and manifests are persisted to disk suggests a broader continuity goal.

## Recommended Next Hardening Work

1. Split context root resolution into explicit repo-root and package-root semantics, then make each provider choose intentionally.
2. Add disk-backed session discovery or rehydration so persisted scratch and manifests can inform later attempts.
3. Extend the manifest schema to record provider execution status, timeout, failure, and empty-result reasons.
4. Assemble review context independently for semantic and adversarial stages, even if they currently share the same config.
5. Introduce provider lifecycle management with optional reuse and teardown for expensive plugin-backed providers.

## Conclusion

Context Engine v2 is architecturally promising and much stronger than a prompt-concatenation design, but the remaining weaknesses are concentrated in the boundaries between configuration, filesystem semantics, persistence, and runtime lifecycle. Those seams are worth hardening before the engine grows more providers or becomes the only context substrate across all stages.
