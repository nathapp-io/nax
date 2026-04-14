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

**Configuring the default agent:**

```json
{
  "autoMode": {
    "defaultAgent": "claude",
    "fallbackOrder": ["claude", "opencode", "codex", "gemini"]
  }
}
```

**Selecting an agent at runtime:**

```bash
# Run with a specific agent
nax run -f my-feature --agent opencode
```

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
