# ngent — Architecture Specification

> AI Coding Agent Orchestrator — loops until done.

## Overview

**ngent** is a standalone npm CLI tool (Bun + TypeScript) that orchestrates AI coding agents to implement features autonomously. It takes a feature spec, breaks it into user stories, routes each story to the right model tier based on complexity, and executes them using a configurable test strategy — including a novel **three-session TDD** pattern for quality-critical work.

Inspired by [Relentless](https://github.com/your-repo/relentless) but designed as an independent, lightweight alternative that works with any coding agent.

## Design Principles

1. **Loop until done** — Don't stop at the first failure. Retry, escalate, and only pause when truly blocked.
2. **Smart routing, not start-cheap** — Classify complexity upfront and route to the right model tier (Haiku → Sonnet → Opus), not start cheap and escalate reactively.
3. **Three-session TDD** — For complex/security-critical work, enforce strict separation between test writing, implementation, and verification.
4. **Hooks for everything** — Lifecycle hooks let users integrate notifications, CI, logging, or OpenClaw events without modifying core code.
5. **Standalone first** — Works as a plain CLI. Optional OpenClaw integration via hooks.

## Architecture

```
ngent/
├── bin/
│   └── ngent.ts              # CLI entry point (commander)
├── src/
│   ├── agents/               # Agent adapters
│   │   ├── types.ts          # AgentAdapter interface, AgentResult, ModelTier
│   │   ├── claude.ts         # ClaudeCodeAdapter (spawns `claude -p`)
│   │   ├── registry.ts       # Agent discovery (which agents are installed)
│   │   ├── cost.ts           # Token cost estimation per model tier
│   │   └── index.ts
│   ├── cli/                  # CLI subcommands
│   │   ├── analyze.ts        # Parse spec.md + tasks.md → prd.json
│   │   └── index.ts
│   ├── config/               # Configuration
│   │   ├── schema.ts         # NgentConfig type + DEFAULT_CONFIG
│   │   ├── loader.ts         # Layered config: global → project (deep merge)
│   │   ├── validate.ts       # Config validation (required fields, ranges)
│   │   └── index.ts
│   ├── execution/            # Core loop
│   │   ├── runner.ts         # Main orchestration loop
│   │   ├── progress.ts       # Timestamped progress.txt logging
│   │   └── index.ts
│   ├── hooks/                # Lifecycle hooks
│   │   ├── types.ts          # HookEvent, HookContext
│   │   ├── runner.ts         # Load hooks.json, execute shell commands
│   │   └── index.ts
│   ├── prd/                  # Product Requirements
│   │   ├── types.ts          # PRD, UserStory, StoryRouting
│   │   └── index.ts          # Load/save/order/completion tracking
│   ├── queue/                # Execution queue
│   │   ├── types.ts          # QueueItem, QueueStats
│   │   ├── manager.ts        # Priority queue with retry support
│   │   └── index.ts
│   ├── routing/              # Task routing (ROUTE-001: simplified)
│   │   ├── router.ts         # resolveRouting() — PRD wins > plugin > LLM > keyword
│   │   ├── strategies/
│   │   │   ├── llm.ts        # LLM-based classifier (opt-in via routing.strategy: "llm")
│   │   │   └── llm-prompts.ts
│   │   └── index.ts
│   └── tdd/                  # Three-session TDD
│       ├── types.ts          # TddSessionRole, IsolationCheck, ThreeSessionTddResult
│       ├── isolation.ts      # Git-diff-based file boundary verification
│       ├── orchestrator.ts   # Three-session pipeline runner
│       └── index.ts
├── test/                     # bun:test files
├── docs/
│   └── SPEC.md               # This file
├── CLAUDE.md                 # Dev context for Claude Code
├── README.md
├── package.json
├── tsconfig.json
└── biome.json
```

## Core Concepts

### 1. Complexity-Based Model Routing

Tasks are classified upfront by analyzing the story title, description, acceptance criteria count, and tags:

| Complexity | Criteria | Model Tier | Typical Use |
|:-----------|:---------|:-----------|:------------|
| **simple** | ≤3 AC, no keywords | `cheap` (Haiku) | Typo fixes, config changes |
| **medium** | 4-6 AC | `standard` (Sonnet) | Standard features |
| **complex** | 7+ AC or keywords (security, auth, migration) | `premium` (Opus) | Security-critical, refactors |
| **expert** | Keywords (distributed, consensus, real-time) | `premium` (Opus) | Architecture-level work |

This is **upfront routing**, not start-cheap-and-escalate. The right model is chosen from the start based on task complexity.

**Escalation** happens only on failure: if a cheap model fails a simple task, escalate to standard and retry.

### 2. Test Strategy Decision Tree

```
                    ┌─────────────────┐
                    │  Classify Task   │
                    └────────┬────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
         simple/medium    complex/expert   any + security tag
              │              │              │
         test-after    three-session-tdd  three-session-tdd
```

**Overrides:** Security tags, public API keywords, or database migration keywords always force `three-session-tdd` regardless of complexity.

### 3. Three-Session TDD

For quality-critical work, ngent runs three isolated agent sessions:

| Session | Role | Constraint | Prompt Focus |
|:--------|:-----|:-----------|:-------------|
| **1** | Test Writer | ONLY test files | Write failing tests for all acceptance criteria |
| **2** | Implementer | ONLY source files | Make the tests pass, minimal code |
| **3** | Verifier | Review + fix | Run tests, verify quality, auto-approve or flag |

**Isolation enforcement:** Between sessions, ngent runs `git diff` and checks that:
- Session 1 only created/modified files matching test patterns (`test/`, `*.test.ts`, `*.spec.ts`)
- Session 2 did NOT modify any test files

If isolation is violated, the session fails and requires human review.

### 4. Hook System

Hooks are configured in `ngent/hooks.json`:

```json
{
  "hooks": {
    "on-start": { "command": "echo started", "timeout": 5000, "enabled": true },
    "on-complete": { "command": "openclaw system event --text 'Done!'", "enabled": true },
    "on-pause": { "command": "bash hooks/notify.sh", "enabled": true },
    "on-error": { "command": "echo error", "enabled": false },
    "on-story-start": { "command": "echo $NGENT_STORY_ID", "enabled": true },
    "on-story-complete": { "command": "echo done", "enabled": true }
  }
}
```

Each hook receives context via:
- **Environment variables:** `NGENT_EVENT`, `NGENT_FEATURE`, `NGENT_STORY_ID`, `NGENT_MODEL`, `NGENT_STATUS`, `NGENT_COST`, `NGENT_REASON`
- **JSON on stdin:** Full HookContext object

This enables OpenClaw integration without hard dependency — just add a hook command that calls `openclaw system event`.

### 5. Layered Configuration

Config is merged in order (later overrides earlier):

1. **Defaults** — `DEFAULT_CONFIG` in code
2. **Global** — `~/.ngent/config.json`
3. **Project** — `<project>/ngent/config.json`

```json
{
  "version": 1,
  "autoMode": {
    "enabled": true,
    "defaultAgent": "claude",
    "fallbackOrder": ["claude", "codex", "opencode"],
    "complexityRouting": {
      "simple": "cheap",
      "medium": "standard",
      "complex": "premium",
      "expert": "premium"
    },
    "escalation": {
      "enabled": true,
      "maxAttempts": 3
    }
  },
  "execution": {
    "maxIterations": 20,
    "iterationDelayMs": 2000,
    "costLimit": 5.0,
    "sessionTimeoutSeconds": 600
  },
  "quality": {
    "requireTypecheck": true,
    "requireLint": true,
    "requireTests": true,
    "commands": {
      "typecheck": "bun run typecheck",
      "lint": "bun run lint",
      "test": "bun test"
    }
  },
  "tdd": {
    "maxRetries": 2,
    "autoVerifyIsolation": true,
    "autoApproveVerifier": true
  }
}
```

### 6. Agent Adapter Interface

Every coding agent implements `AgentAdapter`:

```typescript
interface AgentAdapter {
  readonly name: string;
  readonly displayName: string;
  readonly binary: string;
  readonly models: AgentModelMap; // { cheap, standard, premium }

  isInstalled(): Promise<boolean>;
  run(options: AgentRunOptions): Promise<AgentResult>;
  buildCommand(options: AgentRunOptions): string[];
}
```

Currently implemented: **ClaudeCodeAdapter** (spawns `claude -p "prompt"` via Bun.spawn).

Future: Codex, OpenCode, Gemini adapters.

### 7. PRD Format

Features are defined as `prd.json`:

```json
{
  "project": "my-app",
  "feature": "user-auth",
  "branchName": "feat/user-auth",
  "createdAt": "2026-02-16T00:00:00Z",
  "updatedAt": "2026-02-16T00:00:00Z",
  "userStories": [
    {
      "id": "US-001",
      "title": "Add login endpoint",
      "description": "POST /auth/login with email/password",
      "acceptanceCriteria": [
        "Returns JWT on success",
        "Returns 401 on invalid credentials",
        "Rate limited to 5/min"
      ],
      "dependencies": [],
      "tags": ["security", "auth"],
      "status": "pending",
      "passes": false,
      "attempts": 0,
      "escalations": []
    }
  ]
}
```

The `analyze` command generates this from markdown (`tasks.md`).

## Execution Flow

```
ngent run --feature user-auth
     │
     ▼
  Load PRD ──→ Find next story (deps satisfied)
     │                    │
     │              ┌─────┴─────┐
     │              │ Route Task │
     │              └─────┬─────┘
     │                    │
     │         ┌──────────┼──────────┐
     │         │                     │
     │    test-after          three-session-tdd
     │    (1 session)         (3 sessions)
     │         │                     │
     │         ▼                     ▼
     │    Spawn agent         S1: test-writer
     │    (implement +        S2: implementer
     │     test)              S3: verifier
     │         │              (isolation checks)
     │         │                     │
     │         └──────────┬──────────┘
     │                    │
     │              ┌─────┴─────┐
     │              │  Success?  │
     │              └─────┬─────┘
     │              yes   │   no
     │         ┌──────────┼──────────┐
     │    Mark passed      Escalate model?
     │    Log progress     Retry or fail
     │         │                     │
     │         └──────────┬──────────┘
     │                    │
     └────── Loop ────────┘
              │
         All done OR
         cost limit OR
         max iterations
```

## CLI Commands

```bash
ngent init                      # Initialize ngent in project
ngent features create <name>    # Create feature (spec.md, tasks.md, plan.md)
ngent features list             # List features with progress
ngent analyze -f <name>         # Parse tasks.md → prd.json
ngent run -f <name>             # Execute the loop
ngent run -f <name> --dry-run   # Preview routing without executing
ngent status -f <name>          # Show story progress
ngent agents                    # Check installed coding agents
```

## Cost Model

Token costs per model tier (approximate, USD):

| Tier | Input (per 1M tokens) | Output (per 1M tokens) | Example Model |
|:-----|:---------------------|:----------------------|:-------------|
| cheap | $0.25 | $1.25 | Claude Haiku |
| standard | $3.00 | $15.00 | Claude Sonnet |
| premium | $15.00 | $75.00 | Claude Opus |

The execution runner tracks cumulative cost and pauses when `costLimit` is reached.

## Future Plans

- **Parallel execution** — Use QueueManager to run multiple agents concurrently
- **Additional agents** — Codex, OpenCode, Gemini adapters
- **Quality gates** — Run typecheck/lint/test between sessions automatically
- **Web UI** — Progress dashboard
- **OpenClaw skill** — Optional integration layer for notifications + approval workflows
- **Dogfooding** — Use ngent to build ngent (meta!)
