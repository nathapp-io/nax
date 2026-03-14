# ACP Agent Adapter — Design Specification

*Created: 2026-03-13*
*Status: Draft*

## Overview

Replace nax's per-agent CLI adapters (Claude, Codex, Gemini, OpenCode, Aider) with a single unified adapter built on the [Agent Client Protocol (ACP)](https://agentclientprotocol.com). This eliminates PTY scraping, enables mid-session interaction, and provides structured output from any ACP-compatible coding agent.

## Motivation

**Current state:** nax spawns agents via `Bun.spawn(["claude", "-p", prompt])`, waits for exit, and regex-parses stdout for cost/results. Each agent has its own adapter (~920 LOC total across 6 files). There is no mid-session communication — every execution is fire-and-forget.

**Problems:**
1. No mid-session interaction — agent can't ask questions, human can't guide execution
2. Output is unstructured text — cost estimation uses fragile regex
3. Each new agent requires a custom adapter (Codex, Gemini, etc.)
4. Permission handling is all-or-nothing (`--dangerously-skip-permissions`)
5. No session persistence — each `run()` starts fresh
6. Acceptance generators bypass the adapter interface entirely (tech debt)

**ACP solves all of these** — structured messages, persistent sessions, cooperative cancel, token tracking, permission callbacks, and agent-agnostic protocol.

## Dependency

**`acpx`** (npm package) — used as a library, importing only `AcpClient` and related types. We skip acpx's CLI layer, queue IPC, session disk persistence, and output formatting (nax has its own).

The `AcpClient` class handles:
- Agent process spawning and lifecycle (SIGTERM/SIGKILL graceful shutdown)
- ACP JSON-RPC protocol over stdio (via `@agentclientprotocol/sdk`)
- Permission request callbacks
- File system and terminal handlers
- Session create/load/prompt/cancel

## Architecture

### Before (5 adapters)

```
AgentAdapter interface
  ├── ClaudeCodeAdapter   (claude -p, Bun.spawn)
  ├── CodexAdapter        (codex -q, Bun.spawn)
  ├── GeminiAdapter       (gemini -p, Bun.spawn)
  ├── OpenCodeAdapter     (opencode, Bun.spawn)
  └── AiderAdapter        (aider, Bun.spawn)
```

### After (1 adapter)

```
AgentAdapter interface
  └── AcpAgentAdapter
        ├── AcpClient (from acpx) — protocol layer
        ├── AcpSessionManager — session lifecycle for story execution
        ├── AcpOneShotRunner — one-shot calls (complete, decompose)
        └── AcpInteractionBridge — sessionUpdate → interaction chain
```

### New Files

| File | Purpose |
|:-----|:--------|
| `src/agents/acp/adapter.ts` | `AcpAgentAdapter` implementing `AgentAdapter` |
| `src/agents/acp/session-manager.ts` | Manage AcpClient lifecycle per story |
| `src/agents/acp/one-shot.ts` | One-shot LLM calls via ACP exec mode |
| `src/agents/acp/interaction-bridge.ts` | Bridge sessionUpdate → nax interaction chain |
| `src/agents/acp/types.ts` | ACP-specific types |
| `src/agents/acp/index.ts` | Barrel exports |

### Two Interaction Modes

**Session mode** — used by `run()`, `plan()`, future interactive:
- `AcpClient.start()` → `createSession()` → `prompt()` → observe `sessionUpdate` events → `close()`
- Persistent session enables multi-turn conversation
- `sessionUpdate` notifications stream to the interaction bridge for mid-execution Q&A

**One-shot mode** — used by `complete()`, `decompose()`:
- `AcpClient.start()` → `createSession()` → `prompt()` → read result → `close()`
- No session persistence, no interaction bridge
- Equivalent to current `claude -p` but with structured output

## Agent Interaction Map

All 7 categories of agent interaction, mapped to ACP:

### Category 1: `agent.run()` — Story execution (4 call sites)

**Callers:** execution stage, TDD session-runner, TDD rectification-gate, verification rectification-loop

**ACP approach:**
```typescript
async run(options: AgentRunOptions): Promise<AgentResult> {
  const client = new AcpClient({
    agentCommand: this.resolveAgentCommand(options),
    cwd: options.workdir,
    permissionMode: "approve-all",
    onSessionUpdate: (notification) => this.bridge?.onSessionUpdate(notification),
  });
  await client.start();
  const { sessionId } = await client.createSession(options.workdir);
  const response = await client.prompt(sessionId, options.prompt);
  await client.close();
  return this.toAgentResult(response, client);
}
```

**Result mapping:**
- `response.stopReason` → `AgentResult.success`
- `client.getPermissionStats()` → log permission usage
- `sessionRecord.cumulative_token_usage` → `AgentResult.estimatedCost`
- Timeout: use ACP cooperative cancel instead of SIGTERM/SIGKILL

### Category 2: `adapter.complete()` — One-shot LLM (5 call sites)

**Callers:** LLM routing, classifier, auto interaction, acceptance refinement

**ACP approach:** Same as run() but one-shot — no interaction bridge, extract text from response.

### Category 3: `adapter.plan()` — Spec generation (1 call site)

**ACP approach:** Persistent session with multi-turn. If interactive, bridge sessionUpdate to terminal.

### Category 4: `adapter.decompose()` — Story decomposition (3 call sites)

**ACP approach:** One-shot with structured JSON output parsing.

### Category 5: Raw `Bun.spawn` — Acceptance generators (2 call sites)

**Fix:** Refactor `acceptance/generator.ts` and `acceptance/fix-generator.ts` to use `adapter.complete()` instead of `Bun.spawn([adapter.binary, ...])`. This is a prerequisite — must be done before ACP migration.

### Category 6: `runInteractive()` — PTY/TUI (dormant)

**ACP approach:** Replace PTY with ACP session streaming via `sessionUpdate` notifications.

### Category 7: `isInstalled()` — Precheck utility (4 call sites)

**ACP approach:** Keep — check if the ACP agent binary exists on PATH.

## Interaction Bridge Design

The killer feature — mid-session agent ↔ human communication:

```
Agent thinking/working (via sessionUpdate)
  → AcpInteractionBridge receives notification
  → Detects question/ambiguity/review-needed
  → Creates InteractionRequest
  → Sends to nax interaction chain (Telegram/CLI/webhook)
  → Human responds
  → Bridge sends follow-up prompt to same ACP session
```

This hooks into the existing `src/interaction/` system — no new UI needed.

## Configuration

New config fields in `nax/config.json`:

```json
{
  "agent": {
    "protocol": "acp",
    "command": "claude",
    "permissionMode": "approve-all",
    "sessionTimeout": 600,
    "oneShotTimeout": 120
  }
}
```

Backward compatibility: `"protocol": "cli"` falls back to existing adapters.

## Migration Strategy

1. **Phase 1 (ACP-001 to ACP-003):** Fix tech debt + core adapter + one-shot
2. **Phase 2 (ACP-004 to ACP-005):** Interaction bridge + plan/decompose
3. **Phase 3 (ACP-006 to ACP-007):** TDD multi-session + deprecate old adapters

Old adapters remain functional until Phase 3. Config toggle switches between protocols.

## Cost Tracking

ACP provides `cumulative_token_usage` with `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`. This replaces:
- `estimateCostFromOutput()` — regex-based, unreliable
- `estimateCostByDuration()` — duration-based fallback

New cost calculation:
```typescript
function estimateCostFromTokens(usage: SessionTokenUsage, modelTier: ModelTier): number {
  // Use actual token counts with per-model pricing
}
```

## Risks & Mitigations

| Risk | Severity | Mitigation |
|:-----|:---------|:-----------|
| acpx alpha — API instability | Medium | Pin version, vendor core types |
| Node.js compat in Bun | Low | Bun handles child_process/streams well |
| ACP agent binary not installed | Low | Precheck validates, clear error message |
| Session state overhead | Low | One-shot mode for simple calls |
| Claude ACP adapter stalls | Medium | acpx has built-in timeout handling |

## Test Strategy

- Unit tests: mock `AcpClient` — verify adapter correctly maps prompts → ACP calls → AgentResult
- Integration tests: use a mock ACP server (echo agent) to test full protocol flow
- No E2E with real Claude in CI — too expensive and flaky
