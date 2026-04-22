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

When the availability layer fires:

1. Adapter returns a `RunResult` with `adapterFailure: { category: "auth" | "rate_limit" | ... }` — it no longer throws `AllAgentsUnavailableError`.
2. `AgentManager.shouldSwap(failure)` decides whether this failure is swappable.
3. `AgentManager.nextCandidate(current, failure)` walks `agent.fallback.map[current]`.
4. `ContextOrchestrator.rebuildForAgent(bundle, { newAgentId, failure })` re-renders the existing context bundle under the new agent's profile without re-fetching providers (ADR-010 D5).
5. `SessionManager.handoff(sessionId, newAgent)` updates the session descriptor so the stable `sess-<uuid>` persists across the swap (ADR-013 Gap A).
6. An `onSwapAttempt` event is emitted for reporters / TUI / audit consumers.
7. The manager retries until terminal or `maxHopsPerStory` is exhausted.

**Availability fallback ≠ tier escalation.** Tier escalation (`fast` → `balanced` → `powerful`) fires when the *same* agent repeatedly fails the verification gate on *content* — it runs the next attempt at a stronger model. Availability fallback fires when the agent itself cannot be reached. The two can stack: an exhausted escalation can still swap agents if the terminal failure was availability-category.

### Session handoff and the SessionManager

Every story's internal sessions (plan → test-writer → implementer → verifier → reviewer → rectifier) carry a stable `sess-<uuid>` owned by `SessionManager` (ADR-011). The adapter only owns the *physical* acpx session.

Why this matters for agent configuration:

- **Scratch survives swaps.** `SessionScratchProvider` (Context Engine v2) writes to `SessionManager.scratchDir(sessionId)`. When the manager hands off to a new agent on availability swap, the scratch dir is preserved and cross-agent neutralized (AC-42) so observations from the old agent are still available to the new one.
- **Force-terminate is explicit.** A terminally failed session transitions to `FAILED` and is closed atomically via `failAndClose()`. This guarantees AC-83 fires on availability-category exhaustion — previously the adapter's `finally` block could silently swallow the intent.
- **Resume is deterministic.** Orphan detection walks `index.json` for non-terminal sessions older than TTL, replacing the old mtime heuristic. Crash-resume picks up with the same `sess-<uuid>` the original run would have used.

See [Architecture — §34 Session Manager](../architecture/subsystems.md) and [§35 Agent Manager](../architecture/subsystems.md) for the full ownership boundary and state machine.

---

### Adding a Custom Agent Adapter

The `AgentAdapter` interface (`src/agents/types.ts`) is the extension point. Any class implementing `run()`, `complete()`, `plan()`, `decompose()`, `isInstalled()`, and `buildCommand()` can plug in.

To register a custom adapter, use `_registryTestAdapters` (currently the injection point) or extend `createAgentRegistry()` to accept adapter overrides at construction time:

```typescript
import { _registryTestAdapters } from "./src/agents/registry";
_registryTestAdapters.set("my-agent", new MyCustomAdapter(config));
```

See [Architecture: Agent Adapters](../architecture/agent-adapters.md) for the full adapter conventions.

---

[Back to README](../../README.md)
