---
title: Agents
description: Configuring and using coding agents via ACP
---

## Agents

nax communicates with all coding agents via [ACP](https://github.com/openclaw/acpx) (Agent Client Protocol) — a JSON-RPC protocol layered over stdio that provides persistent sessions, exact USD cost reporting, and multi-turn session continuity. ACP is the only supported protocol.

```bash
# List installed agents and their versions
nax agents
```

**Supported agents:**

| Agent | Binary | Status |
|:------|:-------|:-------|
| Claude Code | `claude` | Stable (default) |
| OpenCode | `opencode` | Stable |
| Codex | `codex` | Stable |
| Gemini CLI | `gemini` | Stable |
| Aider | `aider` | Stable |
| Any ACP-compatible agent | — | See [acpx docs](https://github.com/openclaw/acpx#agents) |

nax connects to agents via [acpx](https://github.com/openclaw/acpx). All agents run as persistent ACP sessions — nax sends prompts and receives structured JSON-RPC responses including token counts and exact USD cost per session.

> **Known issue — `acpx` ≤ 0.3.1:** The `--model` flag is not supported. Model selection via `execution.model` or per-package `model` overrides has no effect. As a temporary workaround, use the [nathapp-io/acpx](https://github.com/nathapp-io/acpx) fork which adds `--model` support. Upstream fix is tracked in [openclaw/acpx#49](https://github.com/openclaw/acpx/issues/49).

**Configuring the default agent and fallback chain (ADR-012):**

```json
{
  "agent": {
    "protocol": "acp",
    "default": "claude",
    "fallback": {
      "enabled": true,
      "map": {
        "claude": ["codex", "opencode"],
        "codex": ["claude"]
      },
      "maxHopsPerStory": 2,
      "rebuildContext": true,
      "onQualityFailure": false
    }
  }
}
```

> Legacy keys (`autoMode.defaultAgent`, `autoMode.fallbackOrder`, `context.v2.fallback`) were removed in ADR-012 Phase 6. Loading a config with them throws `NaxError CONFIG_LEGACY_AGENT_KEYS` with a per-key migration hint. See [Configuration — Agent Configuration](configuration.md#agent-configuration) for the full schema.

**Selecting an agent at runtime:**

```bash
# Run with a specific agent (overrides agent.default for the invocation)
nax run -f my-feature --agent opencode
```

---

### How fallback works

nax has three independent retry layers. Only one of them swaps the agent; the other two stay on the same agent. Conflating them causes silent regressions (the T16.3 bug), so it's worth understanding the split.

| Layer | Trigger | Owner | Swaps agent? |
|:------|:--------|:------|:-------------|
| **Availability** | Auth (401), rate-limit (429), service down | `AgentManager` | Yes — walks `agent.fallback.map` |
| **Transport** | Broken socket, `QUEUE_DISCONNECTED`, stale session | `AcpAgentAdapter` | No — same agent, new protocol session |
| **Payload** | JSON parse / schema mismatch on LLM reply | Caller (e.g. semantic / adversarial review) | No — same agent, re-ask |

When the availability layer fires, `AgentManager.runWithFallback` iterates the
fallback chain and invokes the per-hop callback (`buildHopCallback`, ADR-019
§5) for each attempt. Per hop:

1. Adapter returns a `TurnResult` whose `adapterFailure: { category: "auth" | "rate_limit" | ... }` is surfaced via the middleware envelope — adapters no longer throw `AllAgentsUnavailableError`.
2. `AgentManager.shouldSwap(failure)` decides whether this failure is swappable.
3. `AgentManager.nextCandidate(current, failure)` walks `agent.fallback.map[current]`.
4. The callback calls `ContextOrchestrator.rebuildForAgent(bundle, { newAgentId, failure })` to re-render the existing bundle under the new agent's profile (no provider re-fetch; ADR-010 D5).
5. The callback calls `SessionManager.handoff(sessionId, newAgent)` (descriptor metadata only) and `SessionManager.openSession(name, { agentName, … })` to spin up a fresh adapter-level session for the new agent.
6. The callback calls `AgentManager.runAsSession(agent, handle, prompt)` — the middleware envelope (audit / cost / cancellation / logging) fires here.
7. The previous hop's adapter session is closed in `finally`; one descriptor wraps N adapter sessions across all hops in one story attempt.
8. An `onSwapAttempt` event is emitted for reporters / TUI / audit consumers.
9. The manager retries until terminal or `maxHopsPerStory` is exhausted.

**Availability fallback ≠ tier escalation.** Tier escalation (`fast` → `balanced` → `powerful`) fires when the *same* agent repeatedly fails the verification gate on *content* — it runs the next attempt at a stronger model. Availability fallback fires when the agent itself cannot be reached. The two can stack: an exhausted escalation can still swap agents if the terminal failure was availability-category.

### Session handoff and the SessionManager

Every story's internal sessions (plan → test-writer → implementer → verifier → reviewer → rectifier) carry a stable `sess-<uuid>` owned by `SessionManager` (ADR-011 + ADR-019). The adapter exposes 4 protocol primitives (`openSession`, `sendTurn`, `closeSession`, `complete`); SessionManager owns naming, turn count, resume detection, and the multi-prompt outer loop.

Why this matters for agent configuration:

- **Scratch survives swaps.** `SessionScratchProvider` (Context Engine v2) writes to `SessionManager.scratchDir(sessionId)`. When the manager hands off to a new agent on availability swap, the scratch dir is preserved and cross-agent neutralized (AC-42) so observations from the old agent are still available to the new one.
- **Force-terminate is explicit.** A terminally failed session transitions to `FAILED` and is closed atomically via `failAndClose()`. This guarantees AC-83 fires on availability-category exhaustion — previously the adapter's `finally` block could silently swallow the intent.
- **Resume is deterministic.** Orphan detection walks `index.json` for non-terminal sessions older than TTL, replacing the old mtime heuristic. Crash-resume picks up with the same `sess-<uuid>` the original run would have used.

See [Architecture — §34 Session Manager](../architecture/subsystems.md) and [§35 Agent Manager](../architecture/subsystems.md) for the full ownership boundary and state machine. For configuring what context the agent sees at each stage (and how to plug in RAG / graph providers), see the [Context Engine Guide](context-engine.md).

---

### Adding a Custom Agent Adapter

The `AgentAdapter` interface (`src/agents/types.ts`) is the extension point. Since ADR-019 the surface is **4 primitives**:

| Method | Purpose |
|:---|:---|
| `openSession(name, opts)` | Open or resume a physical session; receives pre-resolved permissions |
| `sendTurn(handle, prompt, opts)` | Send one prompt; framework's `interactionHandler` handles mid-turn callbacks |
| `closeSession(handle)` | Idempotent close |
| `complete(prompt, opts)` | Sessionless one-shot; no state, no `interactionHandler` |

Plus `isInstalled()`, `buildCommand()`, and `capabilities` metadata. `plan` and
`decompose` are not adapter methods — they are typed `Operation`s under
`src/operations/`, dispatched through `callOp` (see Architecture §37).

To register a custom adapter, use `_registryTestAdapters` (currently the injection point) or extend `createAgentRegistry()` to accept adapter overrides at construction time:

```typescript
import { _registryTestAdapters } from "./src/agents/registry";
_registryTestAdapters.set("my-agent", new MyCustomAdapter(config));
```

See [Architecture: Agent Adapters](../architecture/agent-adapters.md) for the full adapter conventions.

---

[Back to README](../../README.md)
