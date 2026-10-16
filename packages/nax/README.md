# nax

[![npm](https://img.shields.io/npm/v/@nathapp/nax?style=flat-square)](https://npmjs.com/@nathapp/nax)
[![CI](https://img.shields.io/github/actions/workflow/status/nathapp-io/nax/ci.yml?style=flat-square)](https://github.com/nathapp-io/nax/actions)
[![Bun](https://img.shields.io/badge/Bun-1.4.3-eeffff?style=flat-square)](https://bun.sh)
[![License](https://img.shields.io/npm/l/@nathapp/nax?style=flat-square)](LICENSE)

**AI Coding Agent Orchestrator** — loops until done.

Give it a spec. It implements each story, runs the deterministic gates, reviews the work with an LLM, fixes what the review finds, and opens a pull request when the branch is ready.

## Why nax

nax is an **orchestrator, not an agent** — it doesn't write code itself. It drives whatever coding agent you choose through a disciplined loop until your gates pass.

- **Agent-agnostic** — runs its own in-process native agent by default, or drives Claude Code, Codex, Gemini CLI, OpenCode, Pi, or any ACP-compatible agent
- **Deterministic gates** — lint, typecheck, scoped tests and the full suite decide pass or fail; LLM reviewers do not turn a red gate green
- **Loop until done** — per-story fix rounds, a whole-branch review with its own fix rounds, and a final gate repair pass, all bounded by config
- **Story and branch review** — LLM review of each story against its spec and acceptance criteria, then one review of the whole branch before publishing
- **Advisor** — rules on judgment calls (implementer questions, unresolved findings, pre-flight conflicts) and records every ruling in the run ledger and the PR body, instead of stopping the run
- **Publishes a PR** — opens a draft PR, waits for CI, and promotes it to ready only when no deterministic reason keeps it draft; nax never merges
- **Monorepo-ready** — per-package config and per-story working directories
- **Extensible** — plugin system for routing, review, reporting, and post-run actions
- **Language-aware** — auto-detects Go, Rust, Python, TypeScript from manifest files; adapts commands and test structure per language
- **Context curator** — deterministic post-run analysis that proposes additions/deletions to context.md and rules files, preventing context drift
- **Guarded agent commands** — agent-authored shell commands run inside an OS sandbox by default, are adjudicated by a per-stage bash approval mode, and can pause for interactive approval that you can remember and later revoke (`nax approvals`)

## Install

```bash
npm install -g @nathapp/nax
# or
bun install -g @nathapp/nax
```

Requires the Bun runtime (nax runs on Bun even when installed through npm; CI pins Bun 1.4.3). Git must be initialized.

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

# Or plan and run in one command
nax run -f my-feature --plan --from spec.md
```

`nax run` uses workflow mode by default (see [How It Works](#how-it-works)). With a forge configured, it ends with a draft PR, promoted to ready when the deterministic checks pass.

See the [documentation index](https://github.com/nathapp-io/nax/blob/main/docs/README.md) for full guides on configuration, workflow mode, monorepo setup, and more.

## How It Works

nax has two execution modes. **Workflow mode** is the default (`execution.mode: "workflow"`). The **pipeline** mode (`execution.mode: "pipeline"`) is deprecated: it still runs, warns at config load, and will be removed in a future release.

### Workflow mode (default)

```
story: implement → gates → story review → fix rounds → full suite → residual ruling
feature: repo gates → branch review → branch fix → re-review → adjudicate → final gates → publish
```

1. **Pre-flight** *(optional, on by default)* — the advisor checks the PRD for stories that share files and for spec/AC contradictions, before the first story
2. **Implement** — one implementer session per story writes the tests and code, runs them, and commits
3. **Gates** — `lint`, `typecheck` and `scoped` tests run after each turn
4. **Story review** — one LLM review of the story diff against the spec, returning a spec verdict and a quality verdict
5. **Fix rounds** — open findings go back to the implementer, up to `workflow.maxFixRounds` (default 5); minor findings are deferred to the ledger
6. **Full suite** — the `full-suite` gate runs once the review passes
7. **Feature workflow** — after the last story: repo gates, one whole-branch review, up to `workflow.maxBranchFixRounds` (default 2) fix rounds each with a scoped re-review, adjudication, final gates, and up to `workflow.finalGateRepairRounds` (default 1) repair passes
8. **Publish** — `workflow.publish` (`pr` by default) commits the ledger, pushes, opens or finds a draft PR, waits for CI, and promotes the draft when the deterministic readiness checks pass

Stories run one at a time. `--parallel` and story batching are ignored in workflow mode.

See [Workflow Mode](https://github.com/nathapp-io/nax/blob/main/docs/guides/workflow-mode.md) for the full loop, end states, publishing modes and config reference, and [ADR-034](https://github.com/nathapp-io/nax/blob/main/docs/adr/ADR-034-workflow-execution-mode.md) for the design.

### Pipeline mode (deprecated)

Selected with `execution.mode: "pipeline"`. Each story runs through a staged pipeline: acceptance setup, routing, context, execution, verify, review (semantic and adversarial), escalation, and a regression gate after all stories pass. Pipeline mode is frozen; no new features are added to it.

---

## CLI Reference

| Command | Description |
|:--------|:-----------|
| [`nax init`](https://github.com/nathapp-io/nax/blob/main/docs/guides/cli-reference.md#nax-init) | Initialize nax in your project |
| `nax setup` | Analyze the repo and generate `.nax/config.json` via LLM |
| [`nax features create`](https://github.com/nathapp-io/nax/blob/main/docs/guides/cli-reference.md#nax-features-create-name) | Scaffold a new feature directory |
| [`nax features list`](https://github.com/nathapp-io/nax/blob/main/docs/guides/cli-reference.md#nax-features-list) | List all features and story status |
| `nax features resolve` | Resolve a feature name and its spec source |
| [`nax plan`](https://github.com/nathapp-io/nax/blob/main/docs/guides/cli-reference.md#nax-plan--f-name---from-spec) | Generate `prd.json` from a spec file (`--decompose <storyId>` splits an existing story) |
| `nax spec lint` | Check a spec's machine-extracted sections before planning |
| [`nax run`](https://github.com/nathapp-io/nax/blob/main/docs/guides/cli-reference.md#nax-run--f-name) | Execute the feature in workflow mode (`--compare` for a multi-agent bake-off, `--schedule` to defer, `--plan` to plan first) |
| `nax resume` | Resume an interrupted run from its checkpoint |
| [`nax precheck`](https://github.com/nathapp-io/nax/blob/main/docs/guides/cli-reference.md#nax-precheck--f-name) | Validate project readiness |
| [`nax status`](https://github.com/nathapp-io/nax/blob/main/docs/guides/cli-reference.md#nax-status--f-name) | Show live run progress |
| [`nax logs`](https://github.com/nathapp-io/nax/blob/main/docs/guides/cli-reference.md#nax-logs) | Stream or query run logs |
| [`nax runs`](https://github.com/nathapp-io/nax/blob/main/docs/guides/cli-reference.md#nax-runs) | List recorded run metadata (`nax runs show <run-id>`) |
| `nax replay` | Reconstruct a post-mortem timeline for a previous run |
| `nax accept` | Override failed acceptance criteria (pipeline mode; workflow mode does not run acceptance tests) |
| [`nax unlock`](https://github.com/nathapp-io/nax/blob/main/docs/guides/cli-reference.md#nax-unlock) | Release a stale lock from a crashed nax process |
| [`nax doctor`](https://github.com/nathapp-io/nax/blob/main/docs/guides/cli-reference.md) | Diagnose the nax installation and environment |
| [`nax generate`](https://github.com/nathapp-io/nax/blob/main/docs/guides/cli-reference.md#nax-generate) | Generate agent context files (`CLAUDE.md`, `AGENTS.md`, …) from `.nax/context.md` |
| [`nax prompts`](https://github.com/nathapp-io/nax/blob/main/docs/guides/cli-reference.md#nax-prompts--f-name) | Assemble or initialize prompts |
| `nax context` | Inspect context-engine artifacts and feature fragments |
| `nax rules` | Lint, export, or migrate the canonical rules store (`.nax/rules/`) |
| `nax detect` | Detect test-file patterns and optionally persist them |
| [`nax agents`](https://github.com/nathapp-io/nax/blob/main/docs/guides/cli-reference.md#nax-agents) | List available coding agents |
| `nax auth` | Manage provider credentials for the native agent (`login`, `import`, `list`, `rm`) |
| `nax sandbox probe` | Check whether the OS sandbox for agent commands works on this machine |
| [`nax approvals`](https://github.com/nathapp-io/nax/blob/main/docs/guides/cli-reference.md#nax-approvals-list) | List or revoke remembered command approvals (`list`, `rm`) |
| `nax advisor` | Inspect, label, and replay advisor decisions (`list`, `label`, `replay`, `import-finish`) |
| [`nax trust`](https://github.com/nathapp-io/nax/blob/main/docs/guides/cli-reference.md#nax-trust) | Trust or untrust project folders (`list`, `add`, `rm`, `check`) |
| `nax mcp lock` | Pin configured MCP servers' tool surface to `.nax/mcp-lock.json` |
| [`nax config`](https://github.com/nathapp-io/nax/blob/main/docs/guides/cli-reference.md#nax-config) | Display the effective merged config (`--explain`, `--diff`); `nax config profile` manages config profiles |
| [`nax curator`](https://github.com/nathapp-io/nax/blob/main/docs/guides/cli-reference.md#nax-curator-status) | Inspect, commit, or garbage-collect curator proposals |
| `nax routing calibrate` | Propose complexity→tier mapping adjustments from run history |
| `nax plugins list` | List installed plugins |
| `nax migrate` | Move generated content from `.nax/` to the output directory (`~/.nax/<project>/`) |

For full flag details, see the [CLI Reference](https://github.com/nathapp-io/nax/blob/main/docs/guides/cli-reference.md).

---

## Configuration

`.nax/config.json` is the project-level config. Key fields:

```json
{
  "execution": {
    "mode": "workflow",                    // "workflow" (default) | "pipeline" (deprecated)
    "maxIterations": 20,                   // Note: `nax run -m <n>` overrides this only when the flag is passed
    "costLimit": 30,                       // USD; past it, the run stops its loops and publishes a draft
    "permissionProfile": "unrestricted",   // "unrestricted" | "safe" | "scoped"
    "storyIsolation": "shared",            // "shared" | "worktree" (workflow mode forces "shared")
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
  "workflow": {
    "maxFixRounds": 5,                     // Per-story fix rounds
    "maxBranchFixRounds": 2,               // Feature-level branch fix rounds
    "finalGateRepairRounds": 1,            // Repair passes when a branch fix turns a gate red
    "preflight": true,                     // Advisor pre-flight before the first story
    "publish": "pr"                        // "pr" | "push" | "none"
  },
  "agent": {
    "protocol": "hybrid",                  // "acp" | "native" | "hybrid" — which transports are permitted
    "default": "native",                   // In-process nax-ai agent; or an ACP agent such as "claude"
    "native": {
      "instructionFileName": "AGENTS.md"   // Repository instruction basename; e.g. "TEAM.md"
    }
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

The `execution.mode` default is `"workflow"`. Setting `"pipeline"` loads with a deprecation warning. In workflow mode the `workflow` block governs the loops; the pipeline-only keys (`acceptance`, `tdd`, `execution.regressionGate`) are not read by the workflow story loop. See [Workflow Mode](https://github.com/nathapp-io/nax/blob/main/docs/guides/workflow-mode.md) for the complete `workflow` reference.

`mcp` attaches external Model Context Protocol (MCP) servers as tool providers — nax is a client only, never an MCP server. The server id is the tool-name namespace: the `codebase-memory` server advertises its tools as `codebase-memory__search_graph`, `codebase-memory__trace_path`, and so on. Before any of those tools are grantable, run `nax mcp lock` at the project root: it connects every enabled server once, pins the advertised tool surface (name + input-schema hash) to `.nax/mcp-lock.json`, and that lockfile is committed like `bun.lock`. `stages` is the attachment control — a server's tools attach only to the listed pipeline stages, and an empty list attaches nowhere. MCP tool reach follows the permission profile: `unrestricted` advertises every attached server's tools, `scoped` only what the stage's `Mcp(...)` rules admit, and `safe` none at all. `allowedTools` narrows which locked tools are grantable; omitted means every locked tool is.

`execution.commandInterceptor` rewrites the `Git` tool's argv through `rtk` so `log` and `diff` output reaches the model compressed. It is confined to the Git site: user-authored `quality.commands` and `acceptance.command` are never wrapped. It fails open — if the `rtk` binary is missing the call runs as plain git.

**Both features are native-agent only.** An ACP agent (`claude`, `codex`, `opencode`, `gemini`, `pi`) brings its own tools, so nax's `Git` tool is never invoked and no MCP tool is advertised. A project on `"protocol": "acp"` can hold a complete, valid config for both and get zero effect, with no error. The built-in defaults (`agent.protocol: "hybrid"`, `agent.default: "native"`) let both take effect once configured (the interceptor itself is off by default); a config that switches to an ACP agent does not.

See [MCP & Command Interception](https://github.com/nathapp-io/nax/blob/main/docs/guides/mcp-and-interception.md) for setup, verification and troubleshooting, and the [Configuration Guide](https://github.com/nathapp-io/nax/blob/main/docs/guides/configuration.md) for the full schema.

`execution.bashApproval` decides how an agent's Bash command is adjudicated (ADR-030). The default `raw` is a pass-through — no per-segment grant matching or root containment, only a best-effort screen that refuses a parseable command naming a nax-owned file (`.nax/config.json`, a feature `prd.json`, the queue-control files). `gated` matches each segment against the stage's single `Bash(...)` allow rule, and `escalate` turns a denial the gate could not adjudicate into an interactive approval prompt; under either, a stage without a `Bash(...)` rule never gets the tool, and nax warns about such inert stages at run start. Approvals you choose to remember are kept per project and managed with `nax approvals list` / `nax approvals rm`; `execution.approvalTimeout` (default 600000 ms) bounds how long a prompt waits before denying.

`execution.sandbox` wraps agent-authored Bash and `RunCommand` exec commands in an OS sandbox (backend `srt`, **on by default**): writes are confined to the repository root, system temp directories and package-manager caches, credential files are unreadable, and `network.allowedDomains` optionally limits network access. When the sandbox is enabled but unavailable on the machine, `raw` Bash is refused rather than run unsandboxed — switch the stage to `gated`/`escalate` or set `sandbox.enabled: false`. `execution.commandSafety.shadow` optionally attaches a loopback shadow classifier that scores every agent command and records the result without ever deciding anything.

These settings govern nax's own `Bash` and `RunCommand` tools, so, like MCP and the interceptor, they take effect for the native agent; an ACP agent runs commands under its own tooling.

See [Sandbox & Command Safety](https://github.com/nathapp-io/nax/blob/main/docs/guides/sandbox-and-command-safety.md), [Approvals](https://github.com/nathapp-io/nax/blob/main/docs/guides/approvals.md), [The Bash Tool](https://github.com/nathapp-io/nax/blob/main/docs/guides/bash-tool.md) and [Permissions](https://github.com/nathapp-io/nax/blob/main/docs/guides/permissions.md).

---

## Key Concepts

### Project trust

nax runs repository-controlled code — project plugins, context plugin providers, hooks, MCP servers and the quality / test / acceptance / setup commands — unsandboxed on the host. Before a gated command (`nax run`, `nax plan`, `nax mcp lock`, …) acts on a project, that project's folder must be trusted, and a refusal exits 2 with `run: nax trust add <root>`.

```bash
nax trust add "$PWD"          # trust this checkout (asks for confirmation)
nax trust list                # what is trusted, and which entry covers the cwd
nax trust check --json        # machine-readable answer for a script
```

Trust is hierarchical and stored once per machine (`~/.nax/trust.json`): an entry for a folder covers that folder and **every folder beneath it**, so trusting a parent covers the clones, worktrees and new projects you create under it later — you do not re-grant trust per checkout. Trusting `/` or your home directory would cover everything you own and is refused unless you pass `--force`. In CI, grant trust once at the top of the job with `nax trust add "$PWD" --yes`, which is a no-op (exit 0) on a cache that already covers the path.

See [`nax trust`](https://github.com/nathapp-io/nax/blob/main/docs/guides/cli-reference.md#nax-trust) for the full surface.

### Test Strategies (pipeline mode)

In pipeline mode, each story gets a test strategy. `tdd.strategy` (default `"auto"`) selects how strategies are chosen: `auto` picks per story based on complexity and content — security-critical stories always get `three-session-tdd` regardless of complexity. The strategy values are:

| Strategy | Sessions | When to use |
|:---------|:---------|:------------|
| `three-session-tdd` | 3 | Expert stories and security-critical code (auth, tokens, RBAC) — strict isolation: test-writer cannot touch `src/`, implementer cannot touch tests |
| `three-session-tdd-lite` | 3 | Complex stories — relaxed isolation: test-writer may add minimal `src/` stubs |
| `tdd-simple` | 1 | Simple and medium stories — single session, TDD discipline (red → green → refactor) |
| `test-after` | 1 | Exploratory / prototyping — implement first, add tests after |
| `no-test` | 0 | Config-only, docs, CI, dependency bumps — requires `noTestJustification` |

Workflow mode does not read these strategies: the implementer writes its own tests in one session, and the gates decide the result. See [Test Strategies Guide](https://github.com/nathapp-io/nax/blob/main/docs/guides/test-strategies.md) for the pipeline routing decision tree and security override rules.

### Story Decomposition

An oversized story is split into smaller sub-stories with `nax plan -f <feature> --decompose <storyId>` — a plan-time operation, not a mid-run stage. The precheck story-size gate (`precheck.storySizeGate`) flags stories over its thresholds. The parent is marked `decomposed` and the sub-stories, with dependency ordering, are added to the PRD.

See [Story Decomposition Guide](https://github.com/nathapp-io/nax/blob/main/docs/guides/decomposition.md).

### Regression Gate (pipeline mode)

In pipeline mode, after all stories pass, nax runs the full test suite once. If it fails, nax maps each failing test file back to the story that introduced it and runs a targeted rectification cycle for that story. A suite timeout is accepted as a pass by default (`execution.regressionGate.acceptOnTimeout`). If failures remain, the affected stories are marked `regression-failed`, the run status becomes `failed`, and the `on-final-regression-fail` hook fires.

In workflow mode the equivalent checks are the `full-suite` gate in each story and the `final-gates` step of the feature workflow.

See [Regression Gate Guide](https://github.com/nathapp-io/nax/blob/main/docs/guides/regression-gate.md).

### Parallel & Isolated Execution

Parallel execution is a pipeline-mode feature. With `--parallel <n>` in pipeline mode, nax runs up to `n` stories whose dependencies are already satisfied at the same time, each in its own git worktree (`0` = auto, based on CPU cores). Both modes run the regression gate once at the end; only sequential runs attribute a regression to a story and rectify it — in parallel mode it is reported for a human. Workflow mode ignores `--parallel` and runs stories one at a time.

Even in sequential pipeline mode, stories can be isolated in per-story git worktrees (`execution.storyIsolation: "worktree"`) to prevent cross-story state leakage. Workflow mode forces `storyIsolation` to `shared`.

See [Parallel Execution Guide](https://github.com/nathapp-io/nax/blob/main/docs/guides/parallel-execution.md).

### Monorepo Support

Per-package context files, per-package test commands, and per-story working directories are supported. Initialize with `nax init --package packages/api`. Package config files live at `.nax/mono/packages/<pkg>/config.json`.

See [Monorepo Guide](https://github.com/nathapp-io/nax/blob/main/docs/guides/monorepo.md).

### Hooks

Lifecycle hooks, defined in `.nax/hooks.json` (project) and `~/.nax/hooks.json` (global) — not in `config.json` — fire at key points (`on-start`, `on-story-complete`, `on-all-stories-complete`, `on-complete`, `on-final-regression-fail`, and more). Use them to trigger deployments, send notifications, or integrate with external systems.

See [Hooks Guide](https://github.com/nathapp-io/nax/blob/main/docs/guides/hooks.md).

### Plugins

Extensible plugin architecture for prompt optimization, custom routing, code review, and reporting. Plugins live in `.nax/plugins/` (project) or `~/.nax/plugins/` (global). Post-run action plugins (e.g. auto-PR creation) can implement `IPostRunAction` for results-aware post-completion workflows.

See [Plugin System](https://github.com/nathapp-io/nax/blob/main/docs/architecture/subsystems.md#23-plugin-system).

---

## Agents

The default agent is `native`: nax drives the model in-process over `@nathapp/nax-ai` (no CLI binary), using the built-in `models.native` Anthropic tier map, so it needs Anthropic credentials (`nax auth` or the provider's environment variable) unless you override the map. Every other agent is reached over ACP (Agent Client Protocol) through `@nathapp/nax-agent-acp`, which launches the agent's own ACP launcher and talks JSON-RPC over stdio: persistent sessions, reported token/cost usage, and multi-turn session continuity. Install the launcher for each ACP agent you use; where an `npx` fallback exists, the first run downloads it and `nax precheck` warns.

| Agent | ACP launcher | Notes |
|:------|:-------------|:------|
| Native (nax-ai) | — (in-process) | Default. `agent.default: "native"` |
| Claude Code | `claude-agent-acp` (or `npx @agentclientprotocol/claude-agent-acp`) | Set `agent.default: "claude"` |
| OpenCode | `opencode acp` | Set `agent.default: "opencode"` |
| Codex | `codex-acp` (or `npx @agentclientprotocol/codex-acp`) | Set `agent.default: "codex"` |
| Gemini CLI | `gemini --acp` | Set `agent.default: "gemini"` |
| Pi Coding Agent | `pi-acp` (or `npx pi-acp`) | Set `agent.default: "pi"` |
| Aider | — | Known name with no ACP launcher; it lists but fails at session open |

See [Agents Guide](https://github.com/nathapp-io/nax/blob/main/docs/guides/agents.md) and the [Context Engine Guide](https://github.com/nathapp-io/nax/blob/main/docs/guides/context-engine.md) for agent-portable context configuration.

---

## Troubleshooting

| Problem | Solution |
|:--------|:---------|
| Precheck blocks with "Uncommitted changes detected" | Commit or stash your changes — nax's own runtime files are ignored by the check |
| HOME env warning | Set HOME to an absolute path — nax warns if it contains `~` |
| Monorepo packages misclassified | Ensure `.nax/mono/packages/<pkg>/config.json` is set up per package |
| Agent Bash refused because the sandbox is unavailable | The OS sandbox is on by default and `raw` Bash requires it. Run `nax sandbox probe` to see why it cannot enforce on this machine, then fix the environment, set the stage's `bashApproval` to `gated`/`escalate`, or set `execution.sandbox.enabled: false` |
| Acceptance tests regenerating every run (pipeline mode) | Check `acceptance-meta.json` — stale fingerprints indicate outdated story context. Workflow mode does not run acceptance tests |

See the [Troubleshooting Guide](https://github.com/nathapp-io/nax/blob/main/docs/guides/troubleshooting.md) for more.

---

## Credits

nax is inspired by [Relentless](https://github.com/ArvorCo/Relentless) — the same "keep trying until done" philosophy, applied to AI agent orchestration.

ACP support is powered by `@nathapp/nax-agent-acp` over the Agent Client Protocol (`@agentclientprotocol/sdk`).

## License

MIT
