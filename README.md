# nax

[![npm](https://img.shields.io/npm/v/@nathapp/nax?style=flat-square)](https://npmjs.com/@nathapp/nax)
[![CI](https://img.shields.io/github/actions/workflow/status/nathapp-io/nax/ci.yml?style=flat-square)](https://github.com/nathapp-io/nax/actions)
[![Bun](https://img.shields.io/badge/Bun-1.3.7%2B-eeffff?style=flat-square)](https://bun.sh)
[![Node](https://img.shields.io/badge/Node-22%2B-green?style=flat-square)](https://nodejs.org)
[![License](https://img.shields.io/npm/l/@nathapp/nax?style=flat-square)](LICENSE)

**AI Coding Agent Orchestrator** — loops until done.

Give it a spec. It writes tests, implements code, verifies quality, and retries until everything passes.

## Why nax

nax is an **orchestrator, not an agent** — it doesn't write code itself. It drives whatever coding agent you choose through a disciplined loop until your tests pass.

- **Agent-agnostic** — use Claude Code, Codex, Gemini CLI, or any ACP-compatible agent
- **TDD-enforced** — acceptance tests must fail before implementation starts
- **Loop until done** — verify, retry, escalate, and regression-check automatically
- **Monorepo-ready** — per-package config and per-story working directories
- **Extensible** — plugin system for routing, review, reporting, and post-run actions
- **Language-aware** — auto-detects Go, Rust, Python, TypeScript from manifest files; adapts commands, test structure, and mocking patterns per language
- **Semantic review** — LLM-based behavioral review against story acceptance criteria; catches stubs, placeholders, and out-of-scope changes
- **Adversarial review** — LLM-based adversarial code review that probes for input handling, error paths, and abandoned implementations

## Install

```bash
npm install -g @nathapp/nax
# or
bun install -g @nathapp/nax
```

Requires: Bun 1.3.7+ or Node 22+. Git must be initialized.

## Quick Start

```bash
cd your-project
nax init                          # Create .nax/ structure
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
5. **Execute** — Run agent session (Claude Code, Codex, Gemini CLI, or ACP)
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
| [`nax features create`](docs/guides/cli-reference.md#nax-features-create-name) | Scaffold a new feature directory |
| [`nax features list`](docs/guides/cli-reference.md#nax-features-list) | List all features and story status |
| [`nax plan`](docs/guides/cli-reference.md#nax-plan---from-spec) | Generate `prd.json` from a spec file |
| [`nax run`](docs/guides/cli-reference.md#nax-run) | Execute the orchestration loop |
| [`nax precheck`](docs/guides/cli-reference.md#nax-precheck) | Validate project readiness |
| [`nax status`](docs/guides/cli-reference.md#nax-status) | Show live run progress |
| [`nax logs`](docs/guides/cli-reference.md#nax-logs) | Stream or query run logs |
| [`nax diagnose`](docs/guides/cli-reference.md#nax-diagnose) | Analyze failures, suggest fixes |
| [`nax generate`](docs/guides/cli-reference.md#nax-generate) | Generate `.nax/` files for all packages in a monorepo |
| [`nax prompts`](docs/guides/cli-reference.md#nax-prompts) | Print prompt snapshots for debugging |
| [`nax runs`](docs/guides/cli-reference.md#nax-runs) | List recorded run metadata |
| [`nax config`](docs/guides/cli-reference.md#nax-config) | Show/validate configuration |

For full flag details, see the [CLI Reference](docs/guides/cli-reference.md).

---

## Configuration

`.nax/config.json` is the project-level config. Key fields:

```json
{
  "execution": {
    "testStrategy": "three-session-tdd",  // How to write tests (see Test Strategies)
    "maxIterations": 5,
    "modelTier": "balanced",               // "fast" | "balanced" | "powerful"
    "permissionProfile": "unrestricted"    // "unrestricted" | "safe" | "scoped"
  },
  "quality": {
    "commands": {
      "test": "bun test",                   // Root test command
      "lint": "bun lint",                  // Optional linter
      "typecheck": "bun typecheck"          // Optional type checker
    }
  },
  "hooks": {
    "onComplete": "npm run build"          // Fire after a feature completes
  }
}
```

See [Configuration Guide](docs/guides/configuration.md) for the full schema.

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

Lifecycle hooks fire at key points (onFeatureStart, onAllStoriesComplete, onComplete, onFinalRegressionFail). Use them to trigger deployments, send notifications, or integrate with external systems.

See [Hooks Guide](docs/guides/hooks.md).

### Plugins

Extensible plugin architecture for prompt optimization, custom routing, code review, and reporting. Plugins live in `.nax/plugins/` (project) or `~/.nax/plugins/` (global). Post-run action plugins (e.g. auto-PR creation) can implement `IPostRunAction` for results-aware post-completion workflows.

See [Plugins Guide](docs/guides/agents.md#plugins).

---

## Agents

nax communicates with all coding agents via [ACP](https://github.com/openclaw/acpx) (Agent Client Protocol) — a JSON-RPC protocol that provides persistent sessions, exact token/cost reporting, and multi-turn session continuity.

| Agent | Binary | Notes |
|:------|:-------|:------|
| Claude Code | `claude` | Default. Set `agent.default: "claude"` |
| OpenCode | `opencode` | Set `agent.default: "opencode"` |
| Codex | `codex` | Set `agent.default: "codex"` |
| Gemini CLI | `gemini` | Set `agent.default: "gemini"` |
| Aider | `aider` | Set `agent.default: "aider"` |
| Any ACP-compatible | — | See [acpx agent docs](https://github.com/openclaw/acpx#agents) |

See [Agents Guide](docs/guides/agents.md) and the [Context Engine Guide](docs/guides/context-engine.md) for agent-portable context configuration.

---

## Troubleshooting

| Problem | Solution |
|:--------|:---------|
| "Working tree is dirty" | Commit or stash changes; nax will restore your working tree after the run |
| HOME env warning | Set HOME to an absolute path — nax warns if it contains `~` |
| ACP sessions leaking | Upgrade to nax v0.48+ and ensure `.nax/acp-sessions.json` is gitignored |
| Monorepo packages misclassified | Ensure `.nax/mono/packages/<pkg>/config.json` is set up per package |
| Acceptance tests regenerating every run | Check `acceptance-meta.json` — stale fingerprints indicate outdated story context |

See the [Troubleshooting Guide](docs/guides/troubleshooting.md) for more.

---

## Credits

nax is inspired by [Relentless](https://github.com/ArvorCo/Relentless) — the same "keep trying until done" philosophy, applied to AI agent orchestration.

ACP support is powered by [acpx](https://github.com/openclaw/acpx) from the [OpenClaw](https://github.com/openclaw/openclaw) project.

## License

MIT
