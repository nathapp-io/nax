# nax

[![npm](https://img.shields.io/npm/v/@nathapp/nax?style=flat-square)](https://npmjs.com/@nathapp/nax)
[![CI](https://img.shields.io/github/actions/workflow/status/nathapp-io/nax/ci.yml?style=flat-square)](https://github.com/nathapp-io/nax/actions)
[![Bun](https://img.shields.io/badge/Bun-1.3.7%2B-eeffff?style=flat-square)](https://bun.sh)
[![License](https://img.shields.io/npm/l/@nathapp/nax?style=flat-square)](LICENSE)

**AI Coding Agent Orchestrator** — loops until done.

Give it a spec. It writes tests, implements code, verifies quality, and retries until everything passes.

## Why nax

nax is an **orchestrator, not an agent** — it doesn't write code itself. It drives whatever coding agent you choose through a disciplined loop until your tests pass.

- **Agent-agnostic** — runs its own in-process native agent by default, or drives Claude Code, Codex, Gemini CLI, OpenCode, or any ACP-compatible agent
- **TDD-enforced** — acceptance tests must fail before implementation starts
- **Loop until done** — verify, retry, escalate, and regression-check automatically
- **Monorepo-ready** — per-package config and per-story working directories
- **Extensible** — plugin system for routing, review, reporting, and post-run actions
- **Language-aware** — auto-detects Go, Rust, Python, TypeScript from manifest files; adapts commands, test structure, and mocking patterns per language
- **Semantic review** — LLM-based behavioral review against story acceptance criteria; catches stubs, placeholders, and out-of-scope changes
- **Adversarial review** — LLM-based adversarial code review that probes for input handling, error paths, and abandoned implementations
- **Context curator** — deterministic post-run analysis that proposes additions/deletions to context.md and rules files, preventing context drift
- **Guarded agent commands** — agent-authored shell commands run inside an OS sandbox by default, are adjudicated by a per-stage bash approval mode, and can pause for interactive approval that you can remember and later revoke (`nax approvals`)

## Install

```bash
npm install -g @nathapp/nax
# or
bun install -g @nathapp/nax
```

Requires: Bun 1.3.7+ (nax runs on the Bun runtime even when installed through npm; CI pins Bun 1.4.0). Git must be initialized.

The default `native` agent needs provider credentials — run `nax auth login <provider>` or, for CI, set the provider's environment variable (a stored credential takes precedence).

## Quick Start

```bash
cd your-project
nax init                          # Create .nax/ structure
nax setup                         # Optional: LLM-analyze the repo and write .nax/config.json
nax features create my-feature    # Scaffold a feature

# Write your spec, then plan + run
nax plan -f my-feature --from spec.md
nax run -f my-feature

# Or in one shot (no interactive Q&A)
nax run -f my-feature --plan --from spec.md
```

See [docs/](docs/) for full guides on configuration, test strategies, monorepo setup, and more.

## How It Works

```
(plan →) acceptance setup → route → execute → verify → review (semantic + adversarial) → escalate → loop → regression gate → acceptance
```

1. **Plan** *(optional)* — Generate `prd.json` from a spec file using an LLM
2. **Acceptance setup** — Generate acceptance tests; assert RED before implementation
3. **Route** — Classify story complexity and select model tier (fast → balanced → powerful)
4. **Context** — Gather relevant code, tests, and project standards per story
5. **Execute** — Run agent session (native in-process agent by default, or an ACP agent such as Claude Code, Codex, Gemini CLI)
6. **Verify** — Run scoped tests; rectify on failure before escalating
7. **Review** — Run lint + typecheck + semantic review + adversarial review; autofix before escalating
8. **Escalate** — On repeated failure, retry with a higher model tier
9. **Loop** — Repeat steps 3–8 per story until all pass or a cost/iteration limit is hit
10. **Regression gate** — Run full test suite after all stories pass
11. **Acceptance** — Run acceptance tests against the completed feature

---

## CLI Reference

| Command | Description |
|:--------|:-----------|
| [`nax init`](docs/guides/cli-reference.md#nax-init) | Initialize nax in your project |
| `nax setup` | Analyze the repo and generate `.nax/config.json` via LLM |
| [`nax features create`](docs/guides/cli-reference.md#nax-features-create-name) | Scaffold a new feature directory |
| [`nax features list`](docs/guides/cli-reference.md#nax-features-list) | List all features and story status |
| `nax features resolve` | Resolve a feature name and its spec source |
| [`nax plan`](docs/guides/cli-reference.md#nax-plan--f-name---from-spec) | Generate `prd.json` from a spec file (`--decompose <storyId>` splits an existing story) |
| `nax spec lint` | Check a spec's machine-extracted sections before planning |
| [`nax run`](docs/guides/cli-reference.md#nax-run--f-name) | Execute the orchestration loop (`--compare` for a multi-agent bake-off, `--schedule` to defer) |
| `nax resume` | Resume an interrupted run from its checkpoint |
| [`nax precheck`](docs/guides/cli-reference.md#nax-precheck--f-name) | Validate project readiness |
| [`nax status`](docs/guides/cli-reference.md#nax-status--f-name) | Show live run progress |
| [`nax logs`](docs/guides/cli-reference.md#nax-logs) | Stream or query run logs |
| [`nax runs`](docs/guides/cli-reference.md#nax-runs) | List recorded run metadata (`nax runs show <run-id>`) |
| `nax replay` | Reconstruct a post-mortem timeline for a previous run |
| `nax accept` | Override failed acceptance criteria |
| [`nax unlock`](docs/guides/cli-reference.md#nax-unlock) | Release a stale lock from a crashed nax process |
| [`nax generate`](docs/guides/cli-reference.md#nax-generate) | Generate agent context files (`CLAUDE.md`, `AGENTS.md`, …) from `.nax/context.md` |
| [`nax prompts`](docs/guides/cli-reference.md#nax-prompts--f-name) | Assemble or initialize prompts |
| `nax context` | Inspect context-engine artifacts and feature fragments |
| `nax rules` | Lint, export, or migrate the canonical rules store (`.nax/rules/`) |
| `nax detect` | Detect test-file patterns and optionally persist them |
| [`nax agents`](docs/guides/cli-reference.md#nax-agents) | List available coding agents |
| `nax auth` | Manage provider credentials for the native agent (`login`, `import`, `list`, `rm`) |
| [`nax approvals`](docs/guides/cli-reference.md#nax-approvals-list) | List or revoke remembered command approvals (`list`, `rm`) |
| `nax mcp lock` | Pin configured MCP servers' tool surface to `.nax/mcp-lock.json` |
| [`nax config`](docs/guides/cli-reference.md#nax-config) | Display the effective merged config (`--explain`, `--diff`); `nax config profile` manages config profiles |
| [`nax curator`](docs/guides/cli-reference.md#nax-curator-status) | Inspect, commit, or garbage-collect curator proposals |
| `nax routing calibrate` | Propose complexity→tier mapping adjustments from run history |
| `nax plugins list` | List installed plugins |
| `nax migrate` | Move generated content from `.nax/` to the output directory (`~/.nax/<project>/`) |

For full flag details, see the [CLI Reference](docs/guides/cli-reference.md).

---

## Configuration

`.nax/config.json` is the project-level config. Key fields:

```json
{
  "agent": {
    "protocol": "hybrid",                  // "acp" | "native" | "hybrid" — which transports are permitted
    "default": "native"                    // In-process nax-ai agent; or an ACP agent such as "claude"
  },
  "execution": {
    "maxIterations": 10,
    "permissionProfile": "unrestricted",   // "unrestricted" | "safe" | "scoped"
    "storyIsolation": "shared",            // "shared" | "worktree"
    "bashApproval": "raw",                 // "raw" | "gated" | "escalate" — how agent Bash commands are adjudicated
    "sandbox": {
      "enabled": true,                     // OS sandbox around agent-authored Bash / Exec commands (on by default)
      "network": { "allowedDomains": ["registry.npmjs.org"] }  // Omit for unrestricted, [] for no network
    },
    "commandInterceptor": {
      "provider": "rtk",                   // Token-reducing proxy for the Git tool
      "enabled": true,                     // Off by default — opt in per project
      "git": { "verbs": ["log", "diff"] }  // Only these subcommands are rewritten
    }
  },
  "tdd": {
    "strategy": "auto"                     // How to write tests (see Test Strategies)
  },
  "routing": {
    "strategy": "keyword"                  // "keyword" | "llm"
  },
  "quality": {
    "commands": {
      "test": "bun test",                  // Root test command
      "lint": "bun lint",                  // Optional linter
      "typecheck": "bun typecheck"         // Optional type checker
    }
  },
  "hooks": {
    "hooks": {
      "on-all-stories-complete": { "command": "npm run build" }  // Fire after all stories pass
    }
  },
  "mcp": {
    "servers": {
      "codebase-memory": {
        "command": "codebase-memory-mcp",  // stdio MCP server binary (client only)
        "args": [],                        // Optional server args
        "stages": ["run"],                 // Attach in these pipeline stages ("*" = all)
        "allowedTools": ["search_graph"]   // Optional: subset of locked tools that is grantable
      }
    }
  }
}
```

`mcp` attaches external Model Context Protocol (MCP) servers as tool providers — nax is a client only, never an MCP server. The server id is the tool-name namespace: the `codebase-memory` server advertises its tools as `codebase-memory__search_graph`, `codebase-memory__trace_path`, and so on. Before any of those tools are grantable, run `nax mcp lock` at the project root: it connects every enabled server once, pins the advertised tool surface (name + input-schema hash) to `.nax/mcp-lock.json`, and that lockfile is committed like `bun.lock`. `stages` is the attachment control — a server's tools attach only to the listed pipeline stages, and an empty list attaches nowhere. MCP tool reach follows the permission profile: `unrestricted` advertises every attached server's tools, `scoped` only what the stage's `Mcp(...)` rules admit, and `safe` none at all. `allowedTools` narrows which locked tools are grantable; omitted means every locked tool is.

`execution.commandInterceptor` rewrites the `Git` tool's argv through `rtk` so `log` and `diff` output reaches the model compressed. It is confined to the Git site: user-authored `quality.commands` and `acceptance.command` are never wrapped. It fails open — if the `rtk` binary is missing the call runs as plain git.

**Both features are native-agent only.** An ACP agent (`claude`, `codex`, `opencode`, `gemini`) brings its own tools, so nax's `Git` tool is never invoked and no MCP tool is advertised. A project on `"protocol": "acp"` can hold a complete, valid config for both and get zero effect, with no error. The built-in defaults (`agent.protocol: "hybrid"`, `agent.default: "native"`) enable both; a config that switches to an acpx agent does not.

See [MCP & Command Interception](docs/guides/mcp-and-interception.md) for setup, verification and troubleshooting, and the [Configuration Guide](docs/guides/configuration.md) for the full schema.

`execution.bashApproval` decides how an agent's Bash command is adjudicated (ADR-030). The default `raw` is a pass-through — no per-segment grant matching or root containment, only a best-effort screen that refuses a parseable command naming a nax-owned file (`.nax/config.json`, a feature `prd.json`, the queue-control files). `gated` matches each segment against the stage's single `Bash(...)` allow rule, and `escalate` turns a denial the gate could not adjudicate into an interactive approval prompt; under either, a stage without a `Bash(...)` rule never gets the tool, and nax warns about such inert stages at run start. Approvals you choose to remember are kept per project and managed with `nax approvals list` / `nax approvals rm`; `execution.approvalTimeout` (default 600000 ms) bounds how long a prompt waits before denying.

`execution.sandbox` wraps agent-authored Bash and `RunCommand` exec commands in an OS sandbox (backend `srt`, **on by default**): writes are confined to the repository root, system temp directories and package-manager caches, credential files are unreadable, and `network.allowedDomains` optionally limits network access. When the sandbox is enabled but unavailable on the machine, `raw` Bash is refused rather than run unsandboxed — switch the stage to `gated`/`escalate` or set `sandbox.enabled: false`. `execution.commandSafety.shadow` optionally attaches a loopback shadow classifier that scores every agent command and records the result without ever deciding anything.

These settings govern nax's own `Bash` and `RunCommand` tools, so, like MCP and the interceptor, they take effect for the native agent; an ACP agent runs commands under its own tooling.

See [Sandbox & Command Safety](docs/guides/sandbox-and-command-safety.md), [Approvals](docs/guides/approvals.md), [The Bash Tool](docs/guides/bash-tool.md) and [Permissions](docs/guides/permissions.md).

---

## Key Concepts

### Test Strategies

nax supports five test strategies. When `tdd.strategy` is `"auto"` (default), the planner selects the strategy per story based on complexity and content — security-critical stories always get `three-session-tdd` regardless of complexity.

| Strategy | Sessions | When to use |
|:---------|:---------|:------------|
| `three-session-tdd` | 3 | Expert stories and security-critical code (auth, tokens, RBAC) — strict isolation: test-writer cannot touch `src/`, implementer cannot touch tests |
| `three-session-tdd-lite` | 3 | Complex stories — relaxed isolation: test-writer may add minimal `src/` stubs |
| `tdd-simple` | 1 | Simple and medium stories — single session, TDD discipline (red → green → refactor) |
| `test-after` | 1 | Exploratory / prototyping — implement first, add tests after |
| `no-test` | 0 | Config-only, docs, CI, dependency bumps — requires `noTestJustification` |

See [Test Strategies Guide](docs/guides/test-strategies.md) for the full routing decision tree and security override rules.

### Story Decomposition

Stories over a complexity threshold are auto-decomposed into smaller sub-stories. Triggered by story size or `prd.json` analysis. Sub-stories run sequentially within the feature.

See [Story Decomposition Guide](docs/guides/decomposition.md).

### Regression Gate

After all stories pass, nax runs the full test suite once. If it fails, it retries failed suites with a shorter timeout. If still failing after retries, the feature is marked as needing attention — nax does not block on a full-suite failure.

See [Regression Gate Guide](docs/guides/regression-gate.md).

### Parallel & Isolated Execution

Stories are batched by compatibility (same model tier, similar complexity) and run in parallel within each batch. Use `--parallel <n>` to control concurrency. Sequential mode uses a deferred regression gate; parallel mode always runs regression at the end.

Even in sequential mode, stories can be isolated in per-story git worktrees (`execution.storyIsolation: "worktree"`) to prevent cross-story state leakage.

See [Parallel Execution Guide](docs/guides/parallel-execution.md).

### Monorepo Support

Per-package context files, per-package test commands, and per-story working directories are supported. Initialize with `nax init --package packages/api`. Package config files live at `.nax/mono/packages/<pkg>/config.json`.

See [Monorepo Guide](docs/guides/monorepo.md).

### Hooks

Lifecycle hooks fire at key points (`on-start`, `on-story-complete`, `on-all-stories-complete`, `on-complete`, `on-final-regression-fail`, and more). Use them to trigger deployments, send notifications, or integrate with external systems.

See [Hooks Guide](docs/guides/hooks.md).

### Plugins

Extensible plugin architecture for prompt optimization, custom routing, code review, and reporting. Plugins live in `.nax/plugins/` (project) or `~/.nax/plugins/` (global). Post-run action plugins (e.g. auto-PR creation) can implement `IPostRunAction` for results-aware post-completion workflows.

See [Plugin System](docs/architecture/subsystems.md#23-plugin-system).

---

## Agents

The default agent is `native`: nax drives the model in-process over `@nathapp/nax-ai` (no CLI binary), using the built-in `models.native` Anthropic tier map, so it needs Anthropic credentials (`nax auth` or the provider's environment variable) unless you override the map. Every other agent is reached via [ACP](https://github.com/openclaw/acpx) (Agent Client Protocol) — a JSON-RPC protocol that provides persistent sessions, exact token/cost reporting, and multi-turn session continuity.

| Agent | Binary | Notes |
|:------|:-------|:------|
| Native (nax-ai) | — (in-process) | Default. `agent.default: "native"` |
| Claude Code | `claude` | Set `agent.default: "claude"` |
| OpenCode | `opencode` | Set `agent.default: "opencode"` |
| Codex | `codex` | Set `agent.default: "codex"` |
| Gemini CLI | `gemini` | Set `agent.default: "gemini"` |
| Pi Coding Agent | `pi` | Set `agent.default: "pi"` (via the pi-acp bridge) |
| Aider | `aider` | Set `agent.default: "aider"` |
| Any ACP-compatible | — | See [acpx agent docs](https://github.com/openclaw/acpx#agents) |

See [Agents Guide](docs/guides/agents.md) and the [Context Engine Guide](docs/guides/context-engine.md) for agent-portable context configuration.

---

## Troubleshooting

| Problem | Solution |
|:--------|:---------|
| Precheck blocks with "Uncommitted changes detected" | Commit or stash your changes — nax's own runtime files are ignored by the check |
| HOME env warning | Set HOME to an absolute path — nax warns if it contains `~` |
| ACP sessions leaking | Upgrade to nax v0.48+ and ensure `.nax/acp-sessions.json` is gitignored |
| Monorepo packages misclassified | Ensure `.nax/mono/packages/<pkg>/config.json` is set up per package |
| Agent Bash refused with "sandbox unavailable" | The OS sandbox is on by default and `raw` Bash requires it; the message names why the sandbox probe failed (e.g. unsupported platform, or a container where the sandbox cannot enforce). Fix the environment, set the stage's `bashApproval` to `gated`/`escalate`, or set `execution.sandbox.enabled: false` |
| Acceptance tests regenerating every run | Check `acceptance-meta.json` — stale fingerprints indicate outdated story context |

See the [Troubleshooting Guide](docs/guides/troubleshooting.md) for more.

---

## Credits

nax is inspired by [Relentless](https://github.com/ArvorCo/Relentless) — the same "keep trying until done" philosophy, applied to AI agent orchestration.

ACP support is powered by [acpx](https://github.com/openclaw/acpx) from the [OpenClaw](https://github.com/openclaw/openclaw) project.

## License

MIT
