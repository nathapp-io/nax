---
title: Documentation
description: User guides, architecture references, and specs for nax
---

# nax Documentation

## Getting Started

| Guide | Description |
|:------|:------------|
| [Quick Start](../README.md#quick-start) | Run nax in 5 minutes |
| [Installation](../README.md#install) | Install via npm or bun |

## Guides

### Using nax

| Guide | Description |
|:------|:------------|
| [CLI Reference](guides/cli-reference.md) | Complete `nax` CLI command reference |
| [Configuration](guides/configuration.md) | Config file locations, key options, shell operator limitations, incl. [Autonomous Finish](guides/configuration.md#autonomous-finish-finish) (`finish.*` — review, verify and open a PR after a run) |
| [Agents](guides/agents.md) | Configuring coding agents — the native agent, ACP agents, fallback, and custom adapters |
| [PRD Format](guides/prd-format.md) | The `prd.json` schema — fields, types, and usage |
| [Spec Writing](guides/spec-writing.md) | Pointer to the `spec-writing` skill for authoring `SPEC-*.md` files |
| [Story Decomposition](guides/decomposition.md) | Breaking oversized stories into manageable sub-stories |
| [Test Strategies](guides/test-strategies.md) | Choosing a test strategy and how `auto` routes stories |
| [TDD Strategies](guides/tdd/strategies.md) | Side-by-side comparison of the TDD modes |
| [Three-Session TDD](guides/three-session-tdd.md) | Strict role separation for complex stories |
| [Acceptance & Review Flow](guides/acceptance-review-flow.md) | How acceptance testing, semantic review, and diagnose/fix connect |
| [Semantic Review](guides/semantic-review.md) | LLM-based behavioral review against story acceptance criteria |
| [Regression Gate](guides/regression-gate.md) | Full-suite regression testing after stories complete |
| [Parallel Execution](guides/parallel-execution.md) | Running stories concurrently with git worktrees |
| [Monorepo Support](guides/monorepo.md) | Multi-package projects with per-package configuration |
| [Language Awareness](guides/language-awareness.md) | Auto-detected language, project type, test framework, and lint tool |
| [Hooks](guides/hooks.md) | Lifecycle hooks for notifications and CI triggers |
| [Interaction Triggers](guides/triggers.md) | Interactive pause-and-prompt configuration |
| [Prompt Customization](guides/prompt-customization.md) | Customizing agent prompts per feature |
| [Troubleshooting](guides/troubleshooting.md) | Common issues and resolutions |

### Context

| Guide | Description |
|:------|:------------|
| [Context Engine](guides/context-engine.md) | Seed, configure, extend, and debug the Context Engine v2 |
| [Context Providers](guides/context-providers.md) | Built-in providers and their `context.v2.providers` configuration |
| [Static Rules](guides/static-rules.md) | Authoring and tuning canonical rules (`.nax/rules/`) |
| [Context Curator](guides/curator.md) | Post-run proposals for context and rules maintenance (`nax curator`) |

### Agent tools, permissions and safety

| Guide | Description |
|:------|:------------|
| [Permissions](guides/permissions.md) | Profiles, per-stage allow/deny/ask rules, the expression grammar, Bash segment semantics, and what deliberately stays outside the permission subsystem |
| [The Bash Tool](guides/bash-tool.md) | Giving an agent a shell — the two gates, writing `Bash(...)` rules, what is refused and why, and why a deny rule is not a containment boundary |
| [Sandbox & Command Safety](guides/sandbox-and-command-safety.md) | The OS sandbox around agent-authored commands (`execution.sandbox`, on by default) and the command-safety shadow classifier (`execution.commandSafety`) |
| [Approvals](guides/approvals.md) | Interactive approval prompts, remembered approvals, and revoking them with `nax approvals list` / `nax approvals rm` |
| [Exec Allowlist](guides/exec-allowlist.md) | What an agent may execute via `RunCommand`'s argv branch — the default install-only list, writing an `Exec(...)` grant, and install hardening |
| [MCP & Command Interception](guides/mcp-and-interception.md) | Attaching MCP servers as tools (`mcp`, `nax mcp lock`) and rewriting the `Git` tool through `rtk` (`execution.commandInterceptor`) — both native-agent only |

### Contributing to nax

| Guide | Description |
|:------|:------------|
| [Testing Conventions](guides/testing-conventions.md) | Running and writing tests for nax itself |
| [Testing Rules](guides/testing-rules.md) | Single source of truth for test-writing rules |
| [Hermetic Tests](guides/hermetic-tests.md) | Writing tests that don't depend on external systems |
| [Retry Strategy](guides/retry-strategy.md) | API reference for the sanctioned retry mechanisms (`src/agents/retry/`) |
| [Memory Leak Investigation](guides/memory-leak-investigation.md) | Diagnosing a hanging, memory-bloated test run |

## Architecture

| File | Description |
|:-----|:------------|
| [Architecture Index](architecture/ARCHITECTURE.md) | Entry point — document index, quick-reference card, ADR note |
| [Conventions](architecture/conventions.md) | File structure, `_deps` injection, error handling, constants, agent resolution |
| [Coding Standards](architecture/coding-standards.md) | Function design, async patterns, type safety, testing, logging, git |
| [Design Patterns](architecture/design-patterns.md) | Patterns, security standards, test performance |
| [Agent Adapters](architecture/agent-adapters.md) | Permission resolution, test-strategy resolution, adapter conventions, trust boundary |
| [nax-ai Surface](architecture/nax-ai-surface.md) | The `@nathapp/nax-ai` surface the native adapter consumes |
| [Subsystems](architecture/subsystems.md) | Deep reference for each subsystem (§17–§51) |
| [Story Orchestrator Flow](architecture/story-orchestrator-flow.md) | Per-story control flow inside `executionStage` |
| [Spec → PRD Pipeline](architecture/spec-to-prd-pipeline.md) | Brainstorming → spec → spec-review → `nax plan` workflow contract |

## ADRs

Architecture Decision Records live in [`adr/`](adr/). The sequence starts at ADR-005 (see the [ADR sequence note](architecture/ARCHITECTURE.md#adr-sequence-note)).

| File | Description |
|:-----|:------------|
| [ADR-005](adr/ADR-005-pipeline-re-architecture.md) | Pipeline re-architecture |
| [ADR-006](adr/ADR-006-acceptance-retry-restructure.md) | Acceptance retry loop restructure |
| [ADR-007](adr/ADR-007-implementer-session-lifecycle.md) | Single continuous implementer session across fix stages |
| [ADR-008](adr/ADR-008-session-lifecycle.md) | Session lifecycle across all agent roles |
| [ADR-009](adr/ADR-009-test-file-pattern-ssot.md) | Test file pattern — single source of truth |
| [ADR-010](adr/ADR-010-context-engine.md) | Context Engine |
| [ADR-011](adr/ADR-011-session-manager-ownership.md) | Session Manager ownership |
| [ADR-012](adr/ADR-012-agent-manager-ownership.md) | Agent Manager ownership |
| [ADR-013](adr/ADR-013-session-manager-agent-manager-hierarchy.md) | SessionManager → AgentManager hierarchy |
| [ADR-014](adr/ADR-014-runscope-and-operation-standardization.md) | RunScope composition and operation standardization ([014b](adr/ADR-014b-runscope-and-middleware-superseded.md), superseded) |
| [ADR-015](adr/ADR-015-operation-contract.md) | Operation contract, SessionRunners, and control-flow layer |
| [ADR-016](adr/ADR-016-prompt-composition-and-packageview.md) | Prompt composition (immutable sections) and PackageView |
| [ADR-017](adr/ADR-017-incremental-consolidation.md) | Incremental consolidation |
| [ADR-018](adr/ADR-018-runtime-layering-with-session-runners.md) | Runtime layering — NaxRuntime, operations, SessionRunners |
| [ADR-019](adr/ADR-019-adapter-primitives-and-session-ownership.md) | Adapter primitives and SessionManager/AgentManager peer boundary |
| [ADR-020](adr/ADR-020-dispatch-boundary-ssot.md) | Dispatch boundary as SSOT |
| [ADR-021](adr/ADR-021-findings-and-fix-strategy-ssot.md) | Finding type SSOT |
| [ADR-022](adr/ADR-022-fix-strategy-and-cycle.md) | Fix strategy and cycle orchestration |
| [ADR-023](adr/ADR-023-execution-unification.md) | Execution unification — one builder per story |
| [ADR-024](adr/ADR-024-non-blocking-adversarial-fix.md) | Non-blocking adversarial fix |
| [ADR-025](adr/ADR-025-agent-routing-and-cross-agent-escalation.md) | Agent routing via plan-time selection and cross-agent escalation |
| [ADR-026](adr/ADR-026-followup-category-triage.md) | Category-based `fixTarget` triage for the non-blocking fix |
| [ADR-027](adr/ADR-027-adapter-protocol-split.md) | Adapter-protocol split for the native LLM path |
| [ADR-028](adr/ADR-028-native-sessions-and-tool-loop.md) | Native sessions and the pull-tool loop |
| [ADR-029](adr/ADR-029-phase-c-native-coding-agent-scope.md) | Scope and constraints for a native coding agent |
| [ADR-030](adr/ADR-030-bash-approval-modes.md) | Bash approval modes (`raw` / `gated` / `escalate`) |
| [ADR-031](adr/ADR-031-root-scoped-command-safety-config.md) | Root-scoped command-safety config |
| [ADR-032](adr/ADR-032-single-frame-repo-rooted-paths.md) | Single frame — repo-rooted agent and PRD |

## Specs

Detailed technical specifications for specific features and subsystems. A selection is listed below; see [`specs/`](specs/) for the full set.

| Spec | Description |
|:-----|:------------|
| [Monorepo Workdir](specs/SPEC-monorepo-workdir.md) | Per-package workdir isolation in monorepos |
| [Per-Package Config](specs/SPEC-per-package-config.md) | Per-package `nax.json` configuration override |
| [ACP Agent Adapter](specs/acp-agent-adapter.md) | ACP protocol adapter for external agent integration |
| [ACP Session Lifecycle](specs/acp-session-lifecycle.md) | Session initialization, heartbeat, and teardown |
| [ACP Session Mode](specs/acp-session-mode.md) | Interactive vs deferred execution modes |
| [Central Run Registry](specs/central-run-registry.md) | Shared run state across pipeline stages |
| [Cost SSOT](specs/cost-ssot.md) | Cost tracking as a single source of truth |
| [Plan V2](specs/plan-v2.md) | Enhanced plan generation with acceptance criteria |
| [Scoped Permissions](specs/scoped-permissions.md) | Tool allowlists scoped to story/routing context |
| [Status File Consolidation](specs/status-file-consolidation.md) | Unified `nax/status.json` replacing scattered files |
| [Test Strategy SSOT](specs/test-strategy-ssot.md) | Single source of truth for routing decisions |
| [Trigger Completion](specs/trigger-completion.md) | Event-driven story completion signals |

---

Back to [README](../README.md)
