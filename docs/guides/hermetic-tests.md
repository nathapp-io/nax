---
title: Hermetic Test Enforcement
description: Writing tests that don't depend on external systems
---

## Hermetic Test Enforcement

By default, nax instructs agents to write **hermetic tests** — tests that never invoke real external processes or connect to real services. This prevents flaky tests, unintended side effects, and accidental API calls during automated runs.

The hermetic requirement is injected into all code-writing prompts (test-writer, implementer, tdd-simple, batch, single-session). It covers all I/O boundaries: HTTP/gRPC calls, CLI tool spawning (`Bun.spawn`/`exec`), database and cache clients, message queues, and file operations outside the test working directory.

### Configuration

Configured under `quality.testing` — supports **per-package override** in monorepos.

```json
{
  "quality": {
    "testing": {
      "hermetic": true,
      "externalBoundaries": ["claude", "acpx", "redis", "grpc"],
      "mockGuidance": "Use injectable deps for CLI spawning, ioredis-mock for Redis"
    }
  }
}
```

| Field | Type | Default | Description |
|:------|:-----|:--------|:------------|
| `hermetic` | `boolean` | `true` | Inject hermetic test requirement into prompts. Set `false` to allow real external calls. |
| `externalBoundaries` | `string[]` | — | Project-specific CLI tools, clients, or services to mock (e.g. `["claude", "redis"]`). The AI uses this list to identify what to mock in your project. |
| `mockGuidance` | `string` | — | Project-specific mocking instructions injected verbatim into the prompt (e.g. which mock libraries to use). |

> **Tip:** `externalBoundaries` and `mockGuidance` complement `context.md`. nax provides the rule ("mock all I/O"), while `context.md` provides project-specific knowledge ("use `ioredis-mock` for Redis"). Use both for best results.

> **Monorepo:** Each package can override `quality.testing` in its own `.nax/mono/<package>/config.json`. For example, `packages/api` can specify Redis boundaries while `apps/web` specifies HTTP-only.

> **Opt-out:** Set `quality.testing.hermetic: false` if your project requires real integration calls (e.g. live database tests against a local dev container).

---

[Back to README](../../README.md)
