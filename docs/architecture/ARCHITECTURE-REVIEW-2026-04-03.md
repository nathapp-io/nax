# Architecture Review

Date: 2026-04-03
Project: `@nathapp/nax`
Reviewer: Codex

## Executive Summary

The repo has a strong architectural direction: a staged pipeline, protocol-aware agent abstraction, centralized config, explicit plugin extension points, and unusually strong test coverage for an orchestration tool. The design intent is clear and generally sound.

The main weakness is not the target architecture, but the gap between the target architecture and the current implementation. Several subsystems are mid-migration, so the codebase currently carries both the new model and the legacy model at the same time. That creates duplication, hidden lifecycle behavior, and a higher risk of drift.

Overall assessment:

- Architecture direction: strong
- Current implementation coherence: moderate
- Main risk class: orchestration drift rather than algorithmic weakness

## Core Architecture

At a high level, the repo is organized around a control-plane architecture:

1. `src/execution/runner.ts` is the top-level run orchestrator.
2. `src/execution/runner-setup.ts`, `src/execution/runner-execution.ts`, and `src/execution/runner-completion.ts` split the run into phases.
3. `src/execution/unified-executor.ts` drives the main story loop and dispatches work either sequentially or in parallel.
4. `src/pipeline/runner.ts` executes ordered `PipelineStage`s against a mutable `PipelineContext`.
5. `src/pipeline/stages/*.ts` implement routing, prompt assembly, agent execution, verification, review, rectification, regression, and completion.
6. `src/pipeline/event-bus.ts` and `src/pipeline/subscribers/*.ts` provide lifecycle fan-out for hooks, reporters, interaction, and registry/event persistence.
7. `src/agents/*` abstracts the execution backend, with `src/agents/registry.ts` switching between CLI and ACP protocol modes.
8. `src/plugins/*` provides extension points for routers, context providers, reviewers, optimizers, reporters, agents, and post-run actions.

This is a good fit for the product: the system is fundamentally an orchestrator, so separating story execution into stages plus lifecycle subscribers is the right architectural shape.

## Strengths

### 1. Clear staged pipeline model

The stage model in `src/pipeline/stages/index.ts` is easy to follow and gives the product a strong execution grammar:

- queue check
- routing
- constitution
- context
- prompt
- optimizer
- execution
- verify
- rectify
- review
- autofix
- regression
- completion

That is a much better long-term foundation than a monolithic runner.

### 2. Good backend abstraction for agents

`src/agents/types.ts` and `src/agents/registry.ts` give the repo a stable seam around agent protocols. The `createAgentRegistry(config)` pattern is a solid choice because orchestration code does not need to care whether the active backend is ACP or CLI.

### 3. Strong testability discipline

The `_deps` pattern described in [ARCHITECTURE.md](/home/williamkhoo/Desktop/projects/nathapp/ai-coder/ngent/docs/architecture/ARCHITECTURE.md) is reflected broadly in the codebase. Combined with the large unit and integration test suite, this materially lowers change risk.

### 4. Plugin extension points are explicit

The plugin system is well-factored conceptually. `PluginRegistry` gives typed getters by capability, which is cleaner than string-based extension dispatch.

### 5. Config centralization is moving in the right direction

The repo has real architectural intent around “single source of truth” config, especially permissions. That is the correct direction for an orchestration-heavy CLI.

## Key Weaknesses

## 1. Event-bus migration is incomplete, causing lifecycle drift

Severity: High

The repo’s own ADR says the pipeline plus event bus should become the single source of truth for lifecycle behavior:

- [ADR-005-pipeline-re-architecture.md#L65](/home/williamkhoo/Desktop/projects/nathapp/ai-coder/ngent/docs/adr/ADR-005-pipeline-re-architecture.md#L65)

But the implementation still mixes event-driven lifecycle handling with direct hook/reporter calls outside the bus:

- `run-setup` still calls `fireHook("on-start")` directly at [run-setup.ts:245](/home/williamkhoo/Desktop/projects/nathapp/ai-coder/ngent/src/execution/lifecycle/run-setup.ts#L245)
- `runner-execution` still calls reporter `onRunStart()` directly at [runner-execution.ts:106](/home/williamkhoo/Desktop/projects/nathapp/ai-coder/ngent/src/execution/runner-execution.ts#L106)
- the subscribers still expect `run:started` from the bus at [hooks.ts:46](/home/williamkhoo/Desktop/projects/nathapp/ai-coder/ngent/src/pipeline/subscribers/hooks.ts#L46) and [reporters.ts:44](/home/williamkhoo/Desktop/projects/nathapp/ai-coder/ngent/src/pipeline/subscribers/reporters.ts#L44)
- but there is no live `run:started` emission in the codebase; `rg` only finds subscriber listeners, not a producer

Impact:

- lifecycle logic is split across two mental models
- some subscriber behavior is effectively dead until the missing event is emitted
- future changes can easily reintroduce duplicate notifications

Recommendation:

- make the bus the only source of run lifecycle events
- emit `run:started` once, early in setup
- delete direct `fireHook("on-start")` and direct `reporter.onRunStart()` paths once the event is wired

## 2. `onRunEnd` is implemented in two active paths

Severity: High

This is the clearest current architecture defect.

Path 1:

- `run:completed` is emitted at [run-completion.ts:171](/home/williamkhoo/Desktop/projects/nathapp/ai-coder/ngent/src/execution/lifecycle/run-completion.ts#L171)
- the reporter subscriber turns that into `reporter.onRunEnd()` at [reporters.ts:145](/home/williamkhoo/Desktop/projects/nathapp/ai-coder/ngent/src/pipeline/subscribers/reporters.ts#L145)

Path 2:

- cleanup calls `reporter.onRunEnd()` directly at [run-cleanup.ts:72](/home/williamkhoo/Desktop/projects/nathapp/ai-coder/ngent/src/execution/lifecycle/run-cleanup.ts#L72)

On successful runs this likely produces duplicate run-end notifications, and possibly inconsistent summaries because the two paths calculate summary data differently.

Impact:

- duplicate reporter side effects
- duplicate external notifications / CI updates / dashboards
- increased plugin fragility because plugin authors must defensively dedupe events that the core should only emit once

Recommendation:

- choose one ownership model
- best option: keep `run:completed` as the success path, and reserve `cleanupRun()` for teardown plus abnormal termination handling only
- if cleanup must report abnormal exits, add a separate event such as `run:terminated`

## 3. The pipeline is not yet the real single source of truth

Severity: High

The pipeline stages are strong, but key state transitions still happen outside the stage graph. `src/execution/pipeline-result-handler.ts` still owns major outcome handling:

- failure routing and state transitions at [pipeline-result-handler.ts:135](/home/williamkhoo/Desktop/projects/nathapp/ai-coder/ngent/src/execution/pipeline-result-handler.ts#L135)
- pause/fail/escalate behavior at [pipeline-result-handler.ts:145](/home/williamkhoo/Desktop/projects/nathapp/ai-coder/ngent/src/execution/pipeline-result-handler.ts#L145)
- escalation handoff at [pipeline-result-handler.ts:195](/home/williamkhoo/Desktop/projects/nathapp/ai-coder/ngent/src/execution/pipeline-result-handler.ts#L195)

There is also still direct hook behavior inside escalation:

- [tier-escalation.ts:168](/home/williamkhoo/Desktop/projects/nathapp/ai-coder/ngent/src/execution/escalation/tier-escalation.ts#L168)

This means the stage pipeline governs “work execution”, but post-stage consequences are still partially governed elsewhere.

Impact:

- harder to reason about end-to-end story lifecycle
- stage contracts are less authoritative than they appear
- more places to inspect when debugging a story outcome

Recommendation:

- move escalation/failure outcome orchestration behind explicit events or dedicated terminal stages
- treat `pipeline-result-handler.ts` as a migration boundary to shrink, not a permanent second control plane

## 4. Global singleton event bus limits isolation and future concurrency

Severity: Medium

The event bus is a process-wide singleton:

- [event-bus.ts:289](/home/williamkhoo/Desktop/projects/nathapp/ai-coder/ngent/src/pipeline/event-bus.ts#L289)

Executors clear and rewire it at runtime:

- [unified-executor.ts:48](/home/williamkhoo/Desktop/projects/nathapp/ai-coder/ngent/src/execution/unified-executor.ts#L48)
- [sequential-executor.ts:46](/home/williamkhoo/Desktop/projects/nathapp/ai-coder/ngent/src/execution/sequential-executor.ts#L46)

This works for single-run ownership, but it is a weak fit if the process ever needs:

- more than one active run
- embedded programmatic usage
- stronger test isolation
- long-lived TUI sessions with sidecar workflows

Impact:

- hidden shared state
- accidental subscriber loss if another flow clears the singleton
- concurrency ceiling at the process orchestration layer

Recommendation:

- instantiate a `PipelineEventBus` per run
- pass it through `RunnerSetupOptions` / execution context instead of importing a singleton

## 5. Executor duplication is still significant

Severity: Medium

`executeUnified()` and `executeSequential()` still share a large amount of structure:

- duplicated bus wiring and heartbeat setup in [unified-executor.ts:48](/home/williamkhoo/Desktop/projects/nathapp/ai-coder/ngent/src/execution/unified-executor.ts#L48) and [sequential-executor.ts:46](/home/williamkhoo/Desktop/projects/nathapp/ai-coder/ngent/src/execution/sequential-executor.ts#L46)
- duplicated run loop scaffolding and early completion checks in both files

The existence of both suggests the architectural transition is still mid-flight. The risk is not just code size; it is divergence in behavior over time.

Impact:

- fixes must be ported twice
- behavioral drift between “unified” and “sequential” paths becomes likely
- maintainers must remember which executor is authoritative

Recommendation:

- either fully retire `executeSequential()` or extract the shared loop skeleton into smaller reusable helpers
- pick one canonical executor abstraction and make the other a thin compatibility layer

## 6. `PipelineContext` has become a large mutable state bag

Severity: Medium

`PipelineContext` now carries a broad mix of inputs, intermediate artifacts, retry state, metrics, review findings, runtime crash counters, acceptance setup data, and cross-stage control flags:

- [pipeline/types.ts:60](/home/williamkhoo/Desktop/projects/nathapp/ai-coder/ngent/src/pipeline/types.ts#L60)

This is common in stage pipelines, but it is starting to erode local reasoning. Stages depend on fields being present because earlier stages happened to populate them, not because the type system enforces a phase boundary.

Impact:

- hidden stage coupling
- optional-field sprawl
- weaker compile-time guarantees
- more regression risk when stage order changes

Recommendation:

- split the context into smaller phase-typed shapes where practical
- at minimum, group state by concern: immutable inputs, execution artifacts, verification artifacts, review artifacts, and control metadata
- consider a `ctx.state` object with sub-objects rather than a single flat bag

## 7. Architectural rules are being violated by hotspot file growth

Severity: Medium

The architecture guide sets a hard source-file limit of 400 lines, but several core files now exceed it substantially:

- `src/agents/acp/adapter.ts` — 1160 lines
- `src/cli/plan.ts` — 960 lines
- `src/debate/session.ts` — 873 lines
- `src/acceptance/generator.ts` — 699 lines
- `src/execution/lifecycle/acceptance-loop.ts` — 691 lines
- `src/execution/unified-executor.ts` — 473 lines
- `src/acceptance/fix-generator.ts` — 426 lines
- `src/tdd/orchestrator.ts` — 418 lines
- `src/plugins/validator.ts` — 401 lines

This matters architecturally because the codebase explicitly relies on cognitive-fit constraints to stay maintainable.

Impact:

- hotspot concentration
- longer refactor cycle time
- larger blast radius per change
- harder onboarding for new contributors and agents

Recommendation:

- prioritize decomposition of orchestration hotspots first, especially ACP adapter, acceptance flow, debate session, and unified executor
- treat the documented limit as an actual architecture governance rule

## 8. Permission architecture is only partially realized

Severity: Medium

The repo is correctly centralized around `resolvePermissions(config, stage)`, but stage-sensitive scoped permissions are not implemented yet:

- `resolvePermissions()` delegates `scoped` to `resolveScopedPermissions()` at [permissions.ts:40](/home/williamkhoo/Desktop/projects/nathapp/ai-coder/ngent/src/config/permissions.ts#L40)
- `resolveScopedPermissions()` is still a stub at [permissions.ts:60](/home/williamkhoo/Desktop/projects/nathapp/ai-coder/ngent/src/config/permissions.ts#L60)

So the architecture promises per-stage permission resolution, but today it effectively collapses back to safe defaults.

Impact:

- security model is less expressive than the public architecture suggests
- stage parameter currently carries less architectural value than intended
- future contributors may assume enforcement exists when it does not

Recommendation:

- either implement stage-scoped permission policies
- or downgrade the abstraction until the behavior exists, to avoid false confidence

## Secondary Observations

- The repo shows healthy architectural self-awareness. The ADRs accurately describe many current issues.
- The biggest problems are mostly “migration incompleteness” rather than bad design choices.
- The codebase already contains comments acknowledging some duplication regressions, which is a good sign operationally.

## Recommended Remediation Order

1. Fix lifecycle ownership first.
   Remove the duplicate `onRunEnd` path and introduce a real `run:started` emission.

2. Finish the event-bus migration.
   Delete direct hook/reporter lifecycle calls that are now supposed to be subscriber-owned.

3. Collapse orchestration layers.
   Shrink `pipeline-result-handler.ts` and move more outcome ownership into the pipeline/event model.

4. Replace the singleton bus with a per-run bus.
   This is the cleanest way to improve isolation before concurrency needs grow further.

5. Reduce structural duplication.
   Consolidate `executeSequential()` and `executeUnified()`.

6. Decompose hotspot files.
   Especially ACP adapter, acceptance flow, debate session, and unified executor.

7. Finish or narrow the permissions abstraction.
   Avoid advertising a scoped policy model that is still stubbed.

## Final Assessment

This repo has better architectural bones than many tools in the same category. The pipeline, adapter registry, plugin system, and test discipline are all real strengths.

The main concern is architectural drift during rapid evolution. Right now the codebase is carrying both the old orchestration model and the new one. If that remains unresolved, the cost of change will rise quickly and subtle lifecycle bugs will keep reappearing.

If the team finishes the migration toward a true pipeline-plus-events control plane, this architecture can scale well.
