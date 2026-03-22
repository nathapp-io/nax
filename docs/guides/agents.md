---
title: Agents
description: Configuring and using multiple coding agents
---

## Agents

nax supports multiple coding agents via the [Agent Client Protocol (ACP)](https://github.com/openclaw/acpx). **ACP protocol is recommended** — it provides persistent sessions, structured cost/token reporting, and works with all supported agents.

> **CLI protocol** (`agent.protocol: "cli"`) is supported for Claude Code only and is being gradually deprecated in favour of ACP. New projects should use ACP.

```bash
# List installed agents and their capabilities
nax agents
```

**Supported agents:**

| Agent | CLI mode |
|:------|:---------|
| `claude` | ✅ Stable |
| All others (`codex`, `gemini`, `opencode`, `cursor`, `copilot`, `kilo`, `qwen`, `kimi`, `iflow`, `droid`, `kiro`, and more) | 🧪 Experimental |

nax connects to agents via [acpx](https://github.com/openclaw/acpx). All agents run as persistent ACP sessions — nax sends prompts and receives structured JSON-RPC responses including token counts and exact USD cost per session. For the full list of supported agents and their ACP startup commands, see the [acpx agent docs](https://github.com/openclaw/acpx#agents).

> **Note:** When `agent.protocol` is set to `"acp"`, the `--agent` CLI flag has no effect — all execution routes through the ACP adapter regardless of agent name.

> **Known issue — `acpx` ≤ 0.3.1:** The `--model` flag is not supported. Model selection via `execution.model` or per-package `model` overrides has no effect. As a temporary workaround, use the [nathapp-io/acpx](https://github.com/nathapp-io/acpx) fork which adds `--model` support. Upstream fix is tracked in [openclaw/acpx#49](https://github.com/openclaw/acpx/issues/49).

**Configuring agents:**

```json
{
  "execution": {
    "defaultAgent": "claude",
    "protocol": "acp",
    "fallbackOrder": ["claude", "codex", "opencode", "gemini"]
  }
}
```

**Force a specific agent at runtime (CLI protocol only):**

```bash
# Only applies when agent.protocol = "cli" (Claude Code only — other agents experimental)
nax run -f my-feature --agent claude
```

---

[Back to README](../../README.md)
