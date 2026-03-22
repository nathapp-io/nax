# nax

**AI Coding Agent Orchestrator** — loops until done.

Give it a spec. It writes tests, implements code, verifies quality, and retries until everything passes.

## Install

```bash
npm install -g @nathapp/nax
# or
bun install -g @nathapp/nax
```

Requires: Node 18+ or Bun 1.0+. Git must be initialized.

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
(plan →) acceptance setup → route → execute → verify → review → escalate → loop → regression gate → acceptance
```

1. **Plan** *(optional)* — Generate `prd.json` from a spec file using an LLM
2. **Acceptance setup** — Generate acceptance tests; assert RED before implementation
3. **Route** — Classify story complexity and select model tier (fast → balanced → powerful)
4. **Context** — Gather relevant code, tests, and project standards per story
5. **Execute** — Run agent session (Claude Code, Codex, Gemini CLI, or ACP)
6. **Verify** — Run scoped tests; rectify on failure before escalating
7. **Review** — Run lint + typecheck; autofix before escalating
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

nax supports four TDD strategies. Select per-feature in `config.json`:

| Strategy | Sessions | When to use |
|:---------|:---------|:------------|
| `three-session-tdd` | 3 | Strict TDD — red/green/refactor in separate sessions |
| `three-session-tdd-lite` | 3 | Flexible TDD — test-writer may add minimal stubs |
| `tdd-simple` | 1 | Simple changes — single session, implementer writes tests |
| `test-after` | 1 | Legacy / exploratory — implement first, add tests after |
| `no-test` | 0 | Config-only, docs, CI, dependency bumps — requires justification |

See [Test Strategies Guide](docs/guides/test-strategies.md) for details.

### Story Decomposition

Stories over a complexity threshold are auto-decomposed into smaller sub-stories. Triggered by story size or `prd.json` analysis. Sub-stories run sequentially within the feature.

See [Story Decomposition Guide](docs/guides/decomposition.md).

### Regression Gate

After all stories pass, nax runs the full test suite once. If it fails, it retries failed suites with a shorter timeout. If still failing after retries, the feature is marked as needing attention — nax does not block on a full-suite failure.

See [Regression Gate Guide](docs/guides/regression-gate.md).

### Parallel Execution

Stories are batched by compatibility (same model tier, similar complexity) and run in parallel within each batch. Use `--parallel <n>` to control concurrency. Sequential mode uses a deferred regression gate; parallel mode always runs regression at the end.

See [Parallel Execution Guide](docs/guides/parallel-execution.md).

### Monorepo Support

Per-package context files, per-package test commands, and per-story working directories are supported. Initialize with `nax init --package packages/api`. Package config files live at `.nax/mono/packages/<pkg>/config.json`.

See [Monorepo Guide](docs/guides/monorepo.md).

### Hooks

Lifecycle hooks fire at key points (onFeatureStart, onAllStoriesComplete, onComplete, onFinalRegressionFail). Use them to trigger deployments, send notifications, or integrate with external systems.

See [Hooks Guide](docs/guides/hooks.md).

### Plugins

Extensible plugin architecture for prompt optimization, custom routing, code review, and reporting. Plugins live in `.nax/plugins/` (project) or `~/.nax/plugins/` (global).

See [Plugins Guide](docs/guides/agents.md#plugins).

---

## Agents

nax supports multiple agent backends:

| Agent | Protocol | Notes |
|:------|:---------|:------|
| ACP (recommended) | ACP | Works with Claude Code, Codex, Gemini CLI, and more. Supports multi-turn continuity |
| Claude Code | CLI | Direct `claude` invocation. `--agent claude` |
| Codex | CLI | `opencode` / Codex CLI. `--agent opencode` |
| Gemini CLI | CLI | `--agent gemini` |
| OpenCode | CLI | `--agent opencode` |

ACP is recommended — it provides structured JSON-RPC communication, token-cost tracking, and multi-session continuity.

See [Agents Guide](docs/guides/agents.md).

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

## License

MIT
