# ARCHITECTURE.md — nax Coding Standards & Patterns

> **Purpose:** Single source of truth for code patterns in the nax codebase.
> All contributors (human and AI agent) must follow these patterns.

---

## Document Index

The architecture documentation is split into focused files. Each section number (`§N`) is stable across files for cross-referencing.

### [conventions.md](conventions.md) — Project Conventions (§1–§4)

The "read this first" fundamentals every contributor must know.

- **§1 File Structure** — Directory layout, file size limits, barrel exports, naming
- **§2 Dependency Injection (`_deps`)** — Injectable deps pattern, test usage, 70+ module reference table
- **§3 Error Handling** — `NaxError` base class, error codes, cause chaining
- **§4 Constants** — No magic numbers, `UPPER_SNAKE_CASE`, `_` separators

### [coding-standards.md](coding-standards.md) — Day-to-Day Coding Reference (§5–§10)

Patterns you'll use in every file.

- **§5 Function Design** — ≤30 lines, ≤3 positional params, options objects
- **§6 Async Patterns** — Bun.spawn concurrent drain, Promise.race safety, batch over loop
- **§7 Type Safety** — No `any` in public APIs, discriminated unions, type guards, `satisfies`
- **§8 Testing Patterns** — Test structure, `_deps` mocking, `test.each()`, naming conventions
- **§9 Logging** — Structured JSONL, stage prefix, log levels
- **§10 Git & Commits** — Conventional commits, one concern per commit

### [design-patterns.md](design-patterns.md) — Patterns, Security & Test Performance (§11–§13)

Architectural patterns and security rules — referenced when designing new modules.

- **§11 Design Patterns** — Prompt Builders (composition), Adapter, Registry, Strategy, Chain, Singleton; agent protocol modes; LLM fallback rule
- **§12 Security Standards** — Path security, command construction, process lifecycle, type safety for security
- **§13 Test Performance** — Injectable sleep, zero-delay config, shared `beforeAll`, event-driven waits

### [agent-adapters.md](agent-adapters.md) — Permissions, Strategies & Adapter Wiring (§14–§16)

How agents are configured, permissioned, and organized.

- **§14 Permission Resolution** — `resolvePermissions(config, stage)`, profiles, pipeline stages, mandatory rules
- **§15 Test Strategy Resolution** — `resolveTestStrategy()`, available strategies, shared prompt fragments
- **§16 Agent Adapter Conventions** — Folder structure, `shared/` contents, ACP cost alignment

### [nax-ai-surface.md](nax-ai-surface.md) — The nax-ai Surface the Native Adapter Consumes

Reference for `@nathapp/nax-ai`, so native-path work does not start by reading `node_modules/`.
Pricing rates and tiers, context windows and the provider-override seam, the provider catalog,
error kinds, cache retention. Every figure probed against the real catalog, with the probe script
included so it can be re-derived after a version bump.

### [subsystems.md](subsystems.md) — System Architecture & Subsystem Reference (§17–§51)

Deep reference for each subsystem — consult when working on a specific module.

- **§17 Pipeline Architecture** — 8 default stages (+1 pre-run, +1 post-run); per-story phases run inside `executionStage` via `StoryOrchestratorBuilder` `CANONICAL_ORDER`; stage contract, `PipelineContext`, `StageResult` actions
- **§18 Execution Modes & Batching** — Parallel/batch, sequential worktree isolation, escalation, crash recovery, lifecycle phases
- **§19 TDD Orchestration** — Three-session workflow, session roles, isolation, failure categories, verdict
- **§20 Acceptance Test System** — Generator, refinement, fix stories, templates, RED gate
- **§21 Verification & Test Runners** — Orchestrator, strategies (scoped/regression/acceptance), smart runner, rectification, test-runners module (framework detection, output parsing SSOT)
- **§22 Routing & Classification** — `classifyComplexity()`, `determineTestStrategy()`, pluggable strategies
- **§23 Plugin System** — Plugin interface, 7 extension points, lifecycle
- **§24 Context Engine & Constitution** — Context Engine v2 (ADR-010): `ContextOrchestrator`, providers, scoring/dedup/packing, push/pull model, `rebuildForAgent`; legacy v1 builder; per-agent generators; constitution
- **§25 Review & Quality** — Review orchestrator, semantic review, adversarial review, diff utilities, quality runner, test command resolver
- **§26 Interaction & Human-in-the-Loop** — Interaction chain, 8 triggers, bridge, plugins
- **§27 Hooks & Lifecycle** — 11 hook events, `HookDef`, `HookContext`
- **§28 Metrics & Cost Tracking** — `StoryMetrics`, aggregator, cost system
- **§29 Debate System** — Multi-agent debate, resolver strategies, concurrency
- **§30 Worktree & Parallel** — Worktree manager, merge, dispatcher
- **§31 Queue Management** — PAUSE/ABORT/SKIP mid-run control
- **§32 TUI (Terminal UI)** — React/Ink terminal UI, components, hooks
- **§33 Error Classes** — `NaxError` + 5 derived error classes
- **§34 Session Manager** (ADR-011 + ADR-019) — `SessionManager` owns full session lifecycle: `openSession` / `sendPrompt` / `closeSession` / `runInSession` / `nameFor` / `handoff`, 7-state machine, scratch dir, runtime helpers (`failAndClose`)
- **§35 Agent Manager** (ADR-012 + ADR-019) — `AgentManager` is a peer of `SessionManager`. Three entry points: `completeAs` (sessionless), `runAsSession` (caller-managed handle), `runWithFallback` (chain iteration via `executeHop` callback)
- **§36 NaxRuntime** (ADR-018) — Single lifecycle container per run: `agentManager`, `sessionManager`, `configLoader`, `costAggregator`, `promptAuditor`, `reviewAuditor`, `packages`, `logger`, `signal`. Frozen middleware chain (audit → cost → cancellation → logging) wraps every `runAs` / `completeAs` call.
- **§37 Operations & `callOp`** (ADR-018) — `Operation<I, O, C>` typed spec under `src/operations/`. `callOp(ctx, op, input)` slices config via `packageView.select`, composes prompts via `composeSections`, dispatches `kind:"complete"` to `completeAs` and `kind:"run"` to `runWithFallback` with `buildHopCallback`.
- **§38 Post-Run Curator** — Post-run heuristic observer: collects observations from run artifacts, generates proposals (H1–H6 heuristics), writes `curator-proposals.md`. `nax curator commit` stages accepted proposals. See [curator.md guide](../guides/curator.md).
- **§39 Config** — Layered config system (global → project → per-package); Zod schema + selectors; `resolvePermissions` SSOT; legacy-key guards.
- **§40 Logger** — Structured JSONL `LogEntry` producer; `initLogger` / `getLogger` / `getSafeLogger` singleton pattern.
- **§41 Log Format** — Human-facing terminal renderer; consumes `LogEntry` from §40; `VerbosityMode`, `formatRunSummary`. Leaf — never writes log records.
- **§42 CLI** — High-level command implementations (`initCommand`, `planCommand`, `acceptCommand`, `generateCommand`, …). One of two directories permitted to use `process.cwd()`.
- **§43 Commands** — Thin CLI wrappers + `resolveProject(opts)` shared entry point; curator, logs, precheck, migrate sub-commands.
- **§44 Optimizer** — Pipeline stage 6; `NoopOptimizer` / plugin; `resolveOptimizer` factory.
- **§45 Plan** — Spec → `prd.json` pipeline: four strategies (single/pipeline/debate/refine), `runPlanCritic`, `finalizePrdRouting`.
- **§46 Precheck** — Pre-run validation suite; two tiers (environment + project); `EXIT_CODES`; gates every `nax run` via `run-setup.ts`.
- **§47 Project** — Heuristic language/framework/type detection from manifest files; `detectLanguage`, `detectProjectProfile`. Authoritative detector — do not re-derive manifest lookups elsewhere.
- **§48 Findings** — ADR-021/022 SSOT: `Finding` wire type, per-producer adapter converters, `runFixCycle` fix-loop orchestration, `classifyOutcome`.
- **§49 Prompts** — All LLM prompt construction: six builder classes (`TddPromptBuilder`, `RectifierPromptBuilder`, `ReviewPromptBuilder`, `AcceptancePromptBuilder`, `DebatePromptBuilder`, `OneShotPromptBuilder`); `composeSections`; `SectionAccumulator`. No prompt literals outside this module.
- **§50 Analyze** — `nax analyze` codebase scanner; `scanCodebase` → `CodebaseScan` / `SourceRoot[]`; delegates to workspace discovery (§21) and language detection (§47).
- **§51 Utils** — Single-purpose leaf utilities (no barrel): `parseLLMJson` (LLM JSON SSOT), `git.ts`, `path-filters.ts`, `path-security.ts`, `json-file.ts`, `errorMessage`, `killProcessTree`, `bun-deps.ts`, `writeQueueCommand`.

### [story-orchestrator-flow.md](story-orchestrator-flow.md) — Per-Story Control Flow

How a single story executes inside `executionStage`: the `CANONICAL_ORDER` phase list, three-session vs single-session mode selection (`routing.testStrategy`), the phase taxonomy (agent sessions / gates / mechanical checks / LLM reviews), and the review → fix → revalidation cycle (`STRATEGY_TO_REVALIDATION_PHASES`). Includes the `mechanical-lintfix` soundness note — why `full-suite-gate` is not re-run after a lint-fix, and why Biome safe-fix mode keeps that sound.

### [spec-to-prd-pipeline.md](spec-to-prd-pipeline.md) — Spec → PRD → Execution Workflow

The four-stage workflow contract: brainstorming → spec-writing → spec-review → `nax plan`. SSOT for how `contextFiles` / `expectedFiles` / `expectedOutput` flow from `SPEC-*.md` through `prd.json` into per-story execution. Covers the `nax plan` decomposition step (`src/operations/plan-refine.ts`, `src/prompts/builders/plan-builder.ts`), the spec-review fidelity gate (Phase 9), and the cross-story produced-file rule.

---

## Quick Reference Card

| Rule | Limit |
|:-----|:------|
| Source file size | ≤600 lines hard (400 soft) |
| Test file size | ≤800 lines hard (500 soft; split if >3 unrelated concerns) |
| Type-only file size | ≤600 lines hard (500 soft) |
| Function size | ≤30 lines (50 hard max) |
| Positional params | ≤3 (use options object beyond) |
| `any` in public API | Forbidden |
| Magic numbers | Forbidden (use named constants) |
| `_deps` for externals | Required |
| Error messages | Must include `[stage]` prefix + context |
| `realpathSync` before containment | Required (no lexical-only checks) |
| `process.on` handlers | Must store named ref for removal |
| Permission resolution | `resolvePermissions(config, stage)` only — no local fallbacks |
| Permission booleans | Never read `dangerouslySkipPermissions` directly |
| `pipelineStage` on adapter calls | Required on all `run()`, `complete()`, `plan()`, `decompose()` |
| Test sleep | Injectable `_deps.sleep`, never real `Bun.sleep` |
| Integration test config | `iterationDelayMs: 0` (never DEFAULT_CONFIG) |

| Pattern | When to use | Entry point |
|:--------|:-----------|:------------|
| Prompt Builder | Domain-specific prompt construction (composition) | `TddPromptBuilder`, `ReviewPromptBuilder`, etc. |
| Builder | Multi-step object construction | `static for()` → chain → `.build()` |
| Adapter | Multiple backends, one contract | Interface in `types.ts`, class per backend |
| Registry | Lookup by name/capability | Class (lifecycle) or function (pure lookup) |
| Strategy | Pluggable algorithms | Interface + classes, selected by orchestrator |
| Chain | Priority-ordered handlers | `.register(handler, priority)` → `.prompt()` |
| Singleton | Global services | `initX()` once, `getX()` / `getSafeX()` everywhere |
| Injectable sleep | Test performance | `_moduleDeps.sleep = Bun.sleep` → spy in tests |
| PidRegistry | Subprocess lifecycle | Register on spawn, unregister on exit, `killAll()` on crash |
| Permission resolver | Agent permissions | `resolvePermissions(config, stage)` → `{ mode, skipPermissions }` |
| Context Engine v2 | Stage-aware context assembly | `ContextOrchestrator.assemble(request)` → `ContextBundle` |
| Session Manager | Session lifecycle + state machine | `sessionManager.openSession() / sendPrompt() / closeSession() / runInSession() / handoff()` |
| Agent Manager | Agent default + availability fallback | `agentManager.getDefault() / completeAs() / runAsSession() / runWithFallback()` |
| NaxRuntime | Single lifecycle container per run | `createRuntime(config, workdir)` → `{ agentManager, sessionManager, configLoader, costAggregator, promptAuditor, reviewAuditor, … }` |
| Operation | Typed semantic envelope for LLM work | `Operation<I, O, C>` + `callOp(ctx, op, input)` |

---

## ADR Sequence Note

The ADR sequence starts at **ADR-005**. ADR-001–004 were never filed — the project began formal ADR tracking mid-development, at the point of the pipeline re-architecture. There are no tombstone files for 001–004; the gap is intentional.

The ADR index lives in `docs/adr/`. Key ADRs: 005 (pipeline re-arch), 009 (test-pattern SSOT), 010 (context engine), 011–013 (session/agent ownership), 018 (runtime layering), 019–020 (dispatch boundary), 023 (execution unification).

---

*Created: 2026-03-10. Last updated: 2026-06-19 (ADR gap note, spec-to-prd link, subsystems §39–§51). Maintained by nax-dev.*
