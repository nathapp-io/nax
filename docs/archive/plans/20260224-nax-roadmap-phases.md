# nax Roadmap — TDD-Lite, LLM Service Layer, Parallelism

*Date: 2026-02-24*
*Status: Proposed*

---

## Context

nax v0.10.0 has a solid TDD pipeline for TypeScript libraries, but struggles with:
- Non-TS/polyglot projects (UI, shell scripts, integration-heavy)
- No parallelism (sequential story execution)
- Memory-heavy (long-running agent sessions, OOMs on 4GB VPS)
- Single agent backend (claude CLI only, no OpenClaw sub-agents)

dev-orchestrator (OpenClaw skill) solves execution well — worktrees, parallel coders, phase-by-phase memory — but lacks nax's TDD pipeline, structured logging, PRD workflow, and CLI.

## nax vs dev-orchestrator — Honest Comparison

| Capability | nax v0.10.0 | dev-orchestrator |
|:-----------|:-----------|:-----------------|
| **TDD pipeline** | ✅ Three-session (strict isolation) | ❌ None |
| **Verification** | ✅ Isolated verifier | ❌ Code review only |
| **Test quality gates** | ✅ Coverage, typecheck, lint | ❌ Up to the coder |
| **Planning/PRD** | ✅ `nax plan` → `analyze` → structured stories | ❌ Simple task decomposition |
| **Parallelism** | ❌ Sequential (batch = same session) | ✅ Git worktrees, true parallel |
| **Memory** | ❌ Peaks 3-4GB+, OOMs on VPS | ✅ Phase-by-phase ~1-2GB, exits between phases |
| **Agent backends** | ❌ claude CLI only | ✅ OpenClaw sessions_spawn + claude CLI |
| **Structured logging** | ✅ JSONL, `nax runs list/show` | ❌ None |
| **Hooks/plugins** | ✅ Global hooks, plugin system | ❌ None |
| **Escalation tiers** | ✅ Automatic model escalation | ❌ Manual |
| **Reproducibility** | ✅ Same PRD = same run | ❌ Depends on orchestrator prompt |
| **Polyglot support** | ❌ TDD isolation breaks for UI/bash | ✅ Handles anything |
| **Setup overhead** | ❌ PRD → analyze → config → run | ✅ Zero — just spawn with task |
| **CLI** | ✅ Full CLI (`nax plan/run/accept/stories`) | ❌ OpenClaw skill only |

### Key Insight

nax's TDD pipeline is its strongest differentiator. dev-orchestrator's execution model (worktrees + phase-by-phase agents) is proven and lighter. The gap is **agent spawning** — nax can't spawn parallel managed agents (#3 LLM Service Layer).

## Decision

**Fix nax** in phases. Port dev-orchestrator's execution strengths into nax rather than rebuilding nax's TDD/PRD pipeline elsewhere.

---

## Phase 1 — TDD-Lite + Fallback (Quick Win)

**Goal:** Solve GitLab #20, support non-TS projects without abandoning TDD.

### Three TDD Tiers

| Strategy | Test Writer | Implementer | Verifier | Use Case |
|:---------|:-----------|:------------|:---------|:---------|
| `three-session-tdd` (strict) | Isolated — no source access | Isolated — no test access | Isolated ✅ | TS libraries, APIs |
| `three-session-tdd-lite` | Can read source, write tests | Free to modify anything | Isolated ✅ | UI, polyglot, integration |
| `test-after` | N/A | Writes code + tests together | N/A | Simple tasks |

### Fallback Logic

- If test-writer produces **0 test files** in strict mode → auto-downgrade to `tdd-lite` and retry
- No wasted iteration, no story pause

### Config

```json
{
  "tdd": {
    "strategy": "auto" | "strict" | "lite" | "off",
    "enabled": true
  }
}
```

- `auto` (default): LLM router classifies testability, picks strict or lite
- `strict`: Always three-session-tdd
- `lite`: Always three-session-tdd-lite
- `off`: test-after for everything

### Scope

- Modify `src/tdd/` prompts for lite mode (relax isolation rules for test-writer)
- Add fallback logic in `src/execution/runner.ts`
- Add `strategy` to routing decision
- Update config schema
- No architecture changes needed

---

## Phase 2 — LLM Service Layer (GitLab #3)

**Goal:** Abstract agent spawning so nax can use multiple backends and run agents in parallel.

### Agent Interface

```typescript
interface Agent {
  name: string;
  spawn(options: AgentSpawnOptions): Promise<AgentSession>;
  isInstalled(): Promise<boolean>;
}

interface AgentSession {
  id: string;
  status: 'running' | 'completed' | 'failed';
  workdir: string;
  wait(): Promise<AgentResult>;
  kill(): Promise<void>;
  steer?(message: string): Promise<void>;  // optional
}

interface AgentSpawnOptions {
  prompt: string;
  workdir: string;
  model?: string;
  timeout?: number;
  env?: Record<string, string>;
}
```

### Backends

| Backend | How | Parallelism | Where |
|:--------|:----|:-----------|:------|
| `ClaudeCliAgent` | `claude -p` (existing) | ❌ Sequential | VPS, Mac01 |
| `OpenClawAgent` | `sessions_spawn` | ✅ Managed sub-agents | OpenClaw environments |
| `ApiAgent` | Direct Anthropic/Google API | ✅ Concurrent requests | Anywhere |

### Key Design Decisions

- Agent selection via config: `autoMode.defaultAgent: "claude-cli" | "openclaw" | "api"`
- Each backend implements the same interface — runner doesn't care
- `ApiAgent` is the lightest (no CLI overhead) but needs prompt engineering for tool use

---

## Phase 3 — Worktree Parallelism

**Goal:** Run N stories concurrently using git worktrees + LLM Service Layer agents.

### Flow

```
nax run -f feature --parallel 3
  │
  ├── Worktree: .nax-wt/story-001/ → Agent 1 (tdd pipeline)
  ├── Worktree: .nax-wt/story-002/ → Agent 2 (tdd pipeline)
  └── Worktree: .nax-wt/story-003/ → Agent 3 (tdd pipeline)
  │
  ├── Each agent exits after its story (phase-by-phase memory)
  ├── Verifier runs per-worktree (isolated)
  └── Merge back to main branch on pass
```

### Benefits

- True parallelism (stolen from dev-orchestrator's proven model)
- Phase-by-phase execution = low memory (solves VPS OOM)
- Each worktree is isolated — no git conflicts during execution
- Merge conflicts detected at merge time, not runtime

### Dependencies

- Phase 2 (LLM Service Layer) — need agent spawning abstraction
- Worktree management utilities (create, merge, cleanup)
- Dependency-aware scheduling (respect story dependencies in PRD)

---

## Dependency Chain

```
Phase 1: tdd-lite + fallback     ← standalone, no blockers
    ↓
Phase 2: LLM Service Layer (#3)  ← abstracts agent spawning
    ↓
Phase 3: Worktree parallelism    ← needs Phase 2
    ↓
Memory optimization              ← comes free with Phase 3
```

---

## Open Questions

1. Should `ApiAgent` support tool use (file read/write/exec) or is it prompt-only?
2. For OpenClaw backend — do we use `sessions_spawn` (managed) or `exec` with claude CLI?
3. Worktree merge strategy — rebase or merge commit?
4. Should nax accept a `--backend` flag or always use config?
