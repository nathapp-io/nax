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

- **§11 Design Patterns** — Builder, Adapter, Registry, Strategy, Chain, Singleton; agent protocol modes; LLM fallback rule
- **§12 Security Standards** — Path security, command construction, process lifecycle, type safety for security
- **§13 Test Performance** — Injectable sleep, zero-delay config, shared `beforeAll`, event-driven waits

### [agent-adapters.md](agent-adapters.md) — Permissions, Strategies & Adapter Wiring (§14–§16)

How agents are configured, permissioned, and organized.

- **§14 Permission Resolution** — `resolvePermissions(config, stage)`, profiles, pipeline stages, mandatory rules
- **§15 Test Strategy Resolution** — `resolveTestStrategy()`, available strategies, shared prompt fragments
- **§16 Agent Adapter Conventions** — Folder structure, `shared/` contents, ACP cost alignment

### [subsystems.md](subsystems.md) — System Architecture & Subsystem Reference (§17–§33)

Deep reference for each subsystem — consult when working on a specific module.

- **§17 Pipeline Architecture** — 15 stages, stage contract, `PipelineContext`, `StageResult` actions
- **§18 Execution Modes & Batching** — Sequential/parallel/batch, escalation, crash recovery, lifecycle phases
- **§19 TDD Orchestration** — Three-session workflow, session roles, isolation, failure categories, verdict
- **§20 Acceptance Test System** — Generator, refinement, fix stories, templates, RED gate
- **§21 Verification System** — Orchestrator, strategies (scoped/regression/acceptance), smart runner, rectification
- **§22 Routing & Classification** — `classifyComplexity()`, `determineTestStrategy()`, pluggable strategies
- **§23 Plugin System** — Plugin interface, 7 extension points, lifecycle
- **§24 Context & Constitution** — Token-budgeted context, auto-detect, 7 agent generators, constitution
- **§25 Review & Quality** — Review orchestrator, semantic review, quality runner
- **§26 Interaction & Human-in-the-Loop** — Interaction chain, 8 triggers, bridge, plugins
- **§27 Hooks & Lifecycle** — 11 hook events, `HookDef`, `HookContext`
- **§28 Metrics & Cost Tracking** — `StoryMetrics`, aggregator, cost system
- **§29 Debate System** — Multi-agent debate, resolver strategies, concurrency
- **§30 Worktree & Parallel** — Worktree manager, merge, dispatcher
- **§31 Queue Management** — PAUSE/ABORT/SKIP mid-run control
- **§32 TUI (Terminal UI)** — React/Ink terminal UI, components, hooks
- **§33 Error Classes** — `NaxError` + 5 derived error classes

---

## Quick Reference Card

| Rule | Limit |
|:-----|:------|
| Source file size | ≤400 lines |
| Test file size | ≤800 lines (split if >3 unrelated concerns) |
| Type-only file size | ≤600 lines |
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
| Builder | Multi-step object construction | `static for()` → chain → `.build()` |
| Adapter | Multiple backends, one contract | Interface in `types.ts`, class per backend |
| Registry | Lookup by name/capability | Class (lifecycle) or function (pure lookup) |
| Strategy | Pluggable algorithms | Interface + classes, selected by orchestrator |
| Chain | Priority-ordered handlers | `.register(handler, priority)` → `.prompt()` |
| Singleton | Global services | `initX()` once, `getX()` / `getSafeX()` everywhere |
| Injectable sleep | Test performance | `_moduleDeps.sleep = Bun.sleep` → spy in tests |
| PidRegistry | Subprocess lifecycle | Register on spawn, unregister on exit, `killAll()` on crash |
| Permission resolver | Agent permissions | `resolvePermissions(config, stage)` → `{ mode, skipPermissions }` |

---

*Created: 2026-03-10. Last updated: 2026-04-04. Maintained by nax-dev.*
