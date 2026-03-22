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

| Guide | Description |
|:------|:------------|
| [CLI Reference](guides/cli-reference.md) | Complete `nax` CLI command reference |
| [Configuration](guides/configuration.md) | Config file locations, key options, shell operator limitations |
| [Hooks](guides/hooks.md) | Lifecycle hooks for notifications and CI triggers |
| [Interaction Triggers](guides/triggers.md) | Interactive pause-and-prompt configuration |
| [Troubleshooting](guides/troubleshooting.md) | Common issues and resolutions |
| [PRD Format](guides/prd-format.md) | The `prd.json` schema — fields, types, and usage |
| [Prompt Customization](guides/prompt-customization.md) | Customizing agent prompts per feature |
| [Testing Conventions](guides/testing-conventions.md) | Running and writing tests for nax itself |

## Architecture

| File | Description |
|:-----|:------------|
| [Architecture Overview](architecture/ARCHITECTURE.md) | High-level system design |
| [Architecture Spec](architecture/SPEC.md) | Detailed component specifications |
| [Spec Rectification](architecture/SPEC-rectification.md) | Known spec/code gaps |

## ADRs

| File | Description |
|:-----|:------------|
| [ADR-005: Pipeline Re-architecture](adr/ADR-005-pipeline-re-architecture.md) | Stage-based execution pipeline redesign |

## Specs

Detailed technical specifications for specific features and subsystems:

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
