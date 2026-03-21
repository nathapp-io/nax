# nax

**AI Coding Agent Orchestrator** — loops until done.

Give it a spec. It writes tests, implements code, verifies quality, and retries until everything passes.

## Install

```bash
npm install -g @nathapp/nax
# or
bun install -g @nathapp/nax
```

## Quick Start

```bash
cd your-project
nax init
nax features create my-feature

# Option A: write prd.json manually, then run
nax run -f my-feature

# Option B: generate prd.json from a spec file, then run
nax plan -f my-feature --from spec.md
nax run -f my-feature

# Option C: plan + run in one command
nax run -f my-feature --plan --from spec.md
```

## How It Works

```
(plan →) acceptance setup → route → execute → verify → (escalate) → regression gate → acceptance
```

1. **Plan** *(optional)* — `nax run --plan` generates a `prd.json` from a spec file using an LLM
2. **Acceptance setup** *(pre-run)* — generate acceptance tests and assert RED (tests must fail before implementation)
3. **Route** — classify story complexity and select model tier (fast → balanced → powerful)
4. **Context** — gather relevant code, tests, and project standards
5. **Execute** — run an agent session (Claude Code, Codex, Gemini CLI, or ACP)
6. **Verify** — run scoped tests; if failing, **rectify** before escalating
7. **Review** — lint + typecheck; if failing, **autofix** before escalating
8. **Escalate** — on repeated failure, retry with a higher model tier
9. **Loop** — repeat steps 3–8 per story until all pass or a cost/iteration limit is hit
10. **Regression gate** — deferred full-suite run after all stories pass
11. **Acceptance** *(post-run)* — run the generated acceptance tests against the completed feature

---

## CLI Reference

### `nax init`

Initialize nax in your project. Creates the `.nax/` folder structure.

```bash
nax init
```

Creates:
```
.nax/
├── config.json       # Project-level config
└── features/         # One folder per feature
```

**Monorepo — scaffold a package:**

```bash
nax init --package packages/api
```

Creates `.nax/mono/packages/api/context.md` for per-package agent context.

---

### `nax features create <name>`

Scaffold a new feature.

```bash
nax features create user-auth
```

Creates `.nax/features/user-auth/spec.md` — fill in the overview, user stories, and acceptance criteria, then run `nax plan` to generate `prd.json`.

### `nax features list`

List all features and their story completion status.

```bash
nax features list
```

---

### `nax plan -f <name> --from <spec>`

Generate a `prd.json` from a spec file using an LLM. Replaces the deprecated `nax analyze`.

```bash
nax plan -f my-feature --from spec.md
```

**Flags:**

| Flag | Description |
|:-----|:------------|
| `-f, --feature <name>` | Feature name (required) |
| `--from <spec-path>` | Path to spec file (required) |
| `--auto` / `--one-shot` | Skip interactive Q&A — single LLM call, no back-and-forth |
| `-b, --branch <branch>` | Override default branch name |
| `-d, --dir <path>` | Project directory |

**Interactive vs one-shot:**
- Default (no flag): interactive planning session — nax asks clarifying questions, refines the plan iteratively
- `--auto` / `--one-shot`: single LLM call, faster but less precise

---

### `nax analyze` *(deprecated)*

> ⚠️ **Deprecated.** Use `nax plan` instead. `nax analyze` remains available for backward compatibility but will be removed in a future version.

---

### `nax run -f <name>`

Execute the orchestration loop for a feature.

```bash
nax run -f my-feature
```

**Flags:**

| Flag | Description |
|:-----|:------------|
| `-f, --feature <name>` | Feature name |
| `-a, --agent <name>` | Force a specific agent (`claude`, `opencode`, `codex`, etc.). Only applies when `agent.protocol = "cli"` — ignored when using ACP protocol. |
| `--plan` | Run plan phase first (requires `--from`) |
| `--from <spec-path>` | Spec file for `--plan` |
| `--one-shot` | Skip interactive Q&A during planning (ACP only) |
| `--force` | Overwrite existing `prd.json` when using `--plan` |
| `--parallel <n>` | Max parallel sessions (`0` = auto based on CPU cores; omit = sequential) |
| `--dry-run` | Preview story routing without running agents |
| `--headless` | Non-interactive output (structured logs, no TUI) |
| `--verbose` | Debug-level logging |
| `--quiet` | Warnings and errors only |
| `--silent` | Errors only |
| `--json` | Raw JSONL output to stdout (for scripting) |
| `--skip-precheck` | Skip precheck validations (advanced users only) |
| `--no-context` | Disable context builder (skip file context in prompts) |
| `--no-batch` | Execute all stories individually (disable batching) |
| `-d, --dir <path>` | Working directory |

**Examples:**

```bash
# Preview what would run (no agents spawned)
nax run -f user-auth --dry-run

# Plan from spec then run — one command
nax run -f user-auth --plan --from spec.md

# Run with parallel execution (auto concurrency)
nax run -f user-auth --parallel 0

# Run with up to 3 parallel worktree sessions
nax run -f user-auth --parallel 3

# Force a specific agent
nax run -f user-auth --agent opencode

# Run in CI/CD (structured output)
nax run -f user-auth --headless

# Raw JSONL for scripting
nax run -f user-auth --json
```

---

### `nax precheck -f <name>`

Validate your project is ready to run — checks git, PRD, CLI tools, deps, test/lint/typecheck scripts.

```bash
nax precheck -f my-feature
```

Run this before `nax run` to catch configuration issues early.

---

### `nax status -f <name>`

Show live run progress — stories passed, failed, current story, cost so far.

```bash
nax status -f my-feature
```

---

### `nax logs`

Stream logs from the current or last run. Run from your project directory.

```bash
# List all recorded runs
nax logs --list

# Follow current run in real-time
nax logs --follow

# Filter by story
nax logs --story US-003

# Filter by log level
nax logs --level error

# Select a specific run by ID
nax logs --run <runId>

# Raw JSONL output (for scripting)
nax logs --json
```

---

### `nax diagnose -f <name>`

Analyze a failed run and suggest fixes. No LLM — pure pattern matching on PRD state, git log, and events.

```bash
nax diagnose -f my-feature

# JSON output for scripting
nax diagnose -f my-feature --json

# Verbose (per-story tier/strategy detail)
nax diagnose -f my-feature --verbose
```

Output sections:
- **Run Summary** — status, stories passed/failed/pending, total cost
- **Story Breakdown** — per-story pattern classification
- **Failure Analysis** — pattern name, symptom, recommended fix
- **Lock Check** — detects stale `nax.lock`
- **Recommendations** — ordered next actions

**Common failure patterns:**

| Pattern | Symptom | Fix |
|:--------|:--------|:----|
| `GREENFIELD_TDD` | No source files exist yet | Use `test-after` or bootstrap files first |
| `MAX_TIERS_EXHAUSTED` | All model tiers tried | Split story into smaller sub-stories |
| `ENVIRONMENTAL` | Build/dep errors | Fix precheck issues before re-running |
| `LOCK_STALE` | `nax.lock` blocking | Shown automatically with `rm nax.lock` |
| `AUTO_RECOVERED` | nax self-healed | No action needed |

---

### `nax generate`

Generate agent config files from `.nax/context.md`. Supports Claude Code, OpenCode, Codex, Cursor, Windsurf, Aider, and Gemini.

```bash
nax generate
```

**Flags:**

| Flag | Description |
|:-----|:------------|
| `-c, --context <path>` | Context file path (default: `.nax/context.md`) |
| `-o, --output <dir>` | Output directory (default: project root) |
| `-a, --agent <name>` | Generate for a specific agent only (`claude`, `opencode`, `cursor`, `windsurf`, `aider`, `codex`, `gemini`) |
| `--dry-run` | Preview without writing files |
| `--no-auto-inject` | Disable auto-injection of project metadata |
| `--package <dir>` | Generate for a specific monorepo package (e.g. `packages/api`) |
| `--all-packages` | Generate for all discovered packages |

**What it generates:**

| Agent | File |
|:------|:-----|
| Claude Code | `CLAUDE.md` |
| OpenCode | `AGENTS.md` |
| Codex | `AGENTS.md` |
| Cursor | `.cursorrules` |
| Windsurf | `.windsurfrules` |
| Aider | `.aider.md` |
| Gemini | `GEMINI.md` |

**Workflow:**

1. Create `.nax/context.md` — describe your project's architecture, conventions, and coding standards
2. Run `nax generate` — writes agent config files to the project root (and per-package if configured)
3. Commit the generated files — your agents will automatically pick them up

**Monorepo (per-package):**

```bash
# Generate CLAUDE.md for a single package
nax generate --package packages/api

# Generate for all packages (auto-discovers workspace packages)
nax generate --all-packages
```

Each package can have its own context file at `.nax/mono/<package>/context.md` for package-specific agent instructions (created via `nax init --package <package>`).

---

### `nax prompts -f <name>`

Assemble and display the prompt that would be sent to the agent for each story role.

```bash
nax prompts -f my-feature
```

**Flags:**

| Flag | Description |
|:-----|:------------|
| `--init` | Export default role templates to `.nax/templates/` for customization |
| `--role <role>` | Show prompt for a specific role (`implementer`, `test-writer`, `verifier`, `tdd-simple`) |

After running `--init`, edit the templates and nax will use them automatically via `prompts.overrides` config.

---

### `nax unlock`

Release a stale `nax.lock` from a crashed process.

```bash
nax unlock -f my-feature
```

---

### `nax runs`

Show all registered runs from the central registry (`~/.nax/runs/`).

```bash
nax runs
```

---

### `nax agents`

List installed coding agents and which models they support.

```bash
nax agents
```

---

### `nax config`

Display the effective merged configuration (global + project layers).

```bash
# Show merged config
nax config

# Show with field descriptions
nax config --explain

# Show only fields where project overrides global
nax config --diff
```

---

## Configuration

Config is layered — project overrides global:

| File | Scope |
|:-----|:------|
| `~/.nax/config.json` | Global (all projects) |
| `.nax/config.json` | Project-level override |

**Key options:**

```json
{
  "execution": {
    "maxIterations": 20,
    "costLimit": 5.0
  },
  "tdd": {
    "strategy": "auto"
  },
  "quality": {
    "commands": {
      "test": "bun test test/ --timeout=60000",
      "testScoped": "bun test --timeout=60000 {{files}}",
      "lint": "bun run lint",
      "typecheck": "bun x tsc --noEmit",
      "lintFix": "bun x biome check --fix src/",
      "formatFix": "bun x biome format --write src/"
    }
  }
}
```

### Shell Operators in Commands

Review commands (`lint`, `typecheck`) are executed directly via `Bun.spawn` — **not** through a shell. This means shell operators like `&&`, `||`, `;`, and `|` are passed as literal arguments and will not work as expected.

**❌ This will NOT work:**
```json
"typecheck": "bun run build && bun run typecheck"
```

**✅ Workaround — wrap in a `package.json` script:**
```json
// package.json
"scripts": {
  "build-and-check": "bun run build && bun run typecheck"
}
```
```json
// .nax/config.json
"quality": {
  "commands": {
    "typecheck": "bun run build-and-check"
  }
}
```

This limitation applies to all `quality.commands` entries (`test`, `lint`, `typecheck`, `lintFix`, `formatFix`).

---

### Scoped Test Command

By default, nax runs scoped tests (per-story verification) by appending discovered test files to the `test` command. This can produce incorrect commands when the base command includes a directory path (e.g. `bun test test/`), since the path is not replaced — it is appended alongside it.

Use `testScoped` to define the exact scoped test command with a `{{files}}` placeholder:

| Runner | `test` | `testScoped` |
|:-------|:-------|:-------------|
| Bun | `bun test test/ --timeout=60000` | `bun test --timeout=60000 {{files}}` |
| Jest | `npx jest` | `npx jest -- {{files}}` |
| pytest | `pytest tests/` | `pytest {{files}}` |
| cargo | `cargo test` | `cargo test {{files}}` |
| go | `go test ./...` | `go test {{files}}` |

If `testScoped` is not configured, nax falls back to a heuristic that replaces the last path-like token in the `test` command. **Recommended:** always configure `testScoped` explicitly to avoid surprises.

**TDD strategy options:** <a name="tdd-strategy-options"></a>

| Value | Behaviour |
|:------|:----------|
| `auto` | nax decides based on complexity and tags — simple→`tdd-simple`, security/public-api→`three-session-tdd`, else→`three-session-tdd-lite` |
| `strict` | Always use `three-session-tdd` (strictest — all stories) |
| `lite` | Always use `three-session-tdd-lite` |
| `simple` | Always use `tdd-simple` (1 session) |
| `off` | No TDD — tests written after implementation (`test-after`) |

---

## Customization

### Prompt Customization

Customize the instructions sent to each agent role for your project's specific needs. Override prompts to enforce coding style, domain knowledge, or architectural constraints.

**Quick start:**

```bash
nax prompts --init              # Create default templates
# Edit .nax/templates/*.md
nax prompts --export test-writer # Preview a role's prompt
nax run -f my-feature           # Uses your custom prompts
```

**Full guide:** See [Prompt Customization Guide](docs/guides/prompt-customization.md) for detailed instructions, role reference, and best practices.

---

## Test Strategies

nax selects a test strategy per story based on complexity and tags:

| Strategy | Sessions | When | Description |
|:---------|:---------|:-----|:------------|
| `test-after` | 1 | Refactors, deletions, config, docs | Single session, no TDD discipline |
| `tdd-simple` | 1 | Simple stories | Single session with TDD prompt (red-green-refactor) |
| `three-session-tdd-lite` | 3 | Medium stories | Three sessions, relaxed isolation rules |
| `three-session-tdd` | 3 | Complex/security stories | Three sessions, strict file isolation |

Configure the default TDD behavior in `.nax/config.json`:

```json
{
  "tdd": {
    "strategy": "auto"
  }
}
```

See [TDD strategy options](#tdd-strategy-options) for all values.

---

## Three-Session TDD

For complex or security-critical stories, nax enforces strict role separation:

| Session | Role | Allowed Files |
|:--------|:-----|:--------------|
| 1 | Test Writer | Test files only — no source code |
| 2 | Implementer | Source files only — no test changes |
| 3 | Verifier | Reviews quality, auto-approves or flags |

Isolation is verified automatically via `git diff` between sessions. Violations cause an immediate failure.

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

## Story Decomposition

When a story is too large (complex/expert with >6 acceptance criteria), nax can automatically decompose it into smaller sub-stories. This runs during the routing stage.

**Trigger:** The `story-oversized` interaction trigger fires when a story exceeds the configured thresholds. You can approve decomposition, skip the story, or continue as-is.

**How it works:**

1. The `DecomposeBuilder` constructs a prompt with the target story, sibling stories (to prevent overlap), and codebase context
2. An LLM generates sub-stories with IDs, titles, descriptions, acceptance criteria, and dependency ordering
3. Post-decompose validators check:
   - **Overlap** — sub-stories must not duplicate scope of existing stories
   - **Coverage** — sub-stories must cover all parent acceptance criteria
   - **Complexity** — each sub-story must be simpler than the parent
   - **Dependencies** — dependency graph must be acyclic with valid references
4. The parent story is replaced in the PRD with the validated sub-stories

**Configuration:**

```json
{
  "decompose": {
    "enabled": true,
    "maxSubStories": 5,
    "minAcceptanceCriteria": 6,
    "complexityThreshold": ["complex", "expert"]
  }
}
```

---

## Regression Gate

After all stories pass their individual verification, nax can run a deferred full-suite regression gate to catch cross-story regressions.

```json
{
  "execution": {
    "regressionGate": {
      "mode": "deferred",
      "acceptOnTimeout": true,
      "maxRectificationAttempts": 2
    }
  }
}
```

| Mode | Behaviour |
|:-----|:----------|
| `disabled` | No regression gate |
| `per-story` | Full suite after each story (expensive) |
| `deferred` | Full suite once after all stories pass (recommended) |

If the regression gate detects failures, nax maps them to the responsible story via git blame and attempts automated rectification. If rectification fails, affected stories are marked as `regression-failed`.

> **Smart skip (v0.34.0):** When all stories used `three-session-tdd` or `three-session-tdd-lite` in sequential mode, each story already ran the full suite gate. nax will skip the redundant deferred regression in this case.

---

## Parallel Execution

nax can run multiple stories concurrently using git worktrees — each story gets an isolated worktree so agents don't step on each other.

```bash
# Auto concurrency (based on CPU cores)
nax run -f my-feature --parallel 0

# Fixed concurrency
nax run -f my-feature --parallel 3
```

**How it works:**

1. Stories are grouped by dependency order (dependent stories wait for their prerequisites)
2. Each batch of independent stories gets its own git worktree
3. Agent sessions run concurrently inside those worktrees
4. Once a batch completes, changes are merged back in dependency order
5. Merge conflicts are automatically rectified by re-running the conflicted story on the updated base

**Config:**

```json
{
  "execution": {
    "maxParallelSessions": 4
  }
}
```

> Sequential mode (no `--parallel`) is the safe default. Use parallel for large feature sets with independent stories.

---

## Agents

nax supports multiple coding agents. **ACP protocol (via [acpx](https://github.com/nathapp/acpx)) is recommended** — it provides persistent sessions, structured cost/token reporting, and works with all supported agents.

> **CLI protocol** (`agent.protocol: "cli"`) is supported for Claude Code only. Other agents in CLI mode are experimental and not recommended for production use.

```bash
# List installed agents and their capabilities
nax agents
```

**Supported agents:**

| Agent | Status | Notes |
|:------|:-------|:------|
| `claude` | ✅ Stable | Claude Code via acpx (ACP) or direct CLI |
| `opencode` | 🧪 Experimental | ACP only — CLI mode not supported |
| `codex` | 🧪 Experimental | ACP only — CLI mode not supported |
| `cursor` | 🧪 Experimental | ACP only — CLI mode not supported |
| `windsurf` | 🧪 Experimental | ACP only — CLI mode not supported |
| `aider` | 🧪 Experimental | ACP only — CLI mode not supported |
| `gemini` | 🧪 Experimental | ACP only — CLI mode not supported |

**ACP protocol (recommended):**

nax uses [acpx](https://github.com/nathapp/acpx) as the ACP transport. All agents run as persistent sessions — nax sends prompts and receives structured JSON-RPC responses including token counts and exact USD cost per session.

> **Note:** When `agent.protocol` is set to `"acp"`, the `--agent` CLI flag has no effect — all execution routes through the ACP adapter regardless of agent name.

> **Known issue — `acpx` ≤ 0.3.1:** The `--model` flag is not supported. Model selection via `execution.model` or per-package `model` overrides has no effect when using acpx as the ACP transport. This is a limitation in the underlying `@zed-industries/claude-agent-acp` adapter, which ignores runtime model requests and always uses the model configured in Claude Code settings. A fix is being tracked in [openclaw/acpx#49](https://github.com/openclaw/acpx/issues/49). As a workaround, set your preferred model directly in Claude Code settings before running nax.

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

## Monorepo Support

nax supports monorepos with workspace-level and per-package configuration.

### Setup

```bash
# Initialize nax at the repo root
nax init

# Scaffold per-package context for a specific package
nax init --package packages/api
nax init --package packages/web
```

### Per-Package Config

Each package's config and context are stored centrally under the root `.nax/mono/` directory:

```
repo-root/
├── .nax/
│   ├── config.json                    # root config
│   └── mono/
│       ├── packages/
│       │   └── api/
│       │       ├── config.json        # overrides for packages/api
│       │       └── context.md        # agent context for packages/api
│       └── apps/
│           └── api/
│               ├── config.json        # overrides for apps/api
│               └── context.md        # agent context for apps/api
```

**Overridable fields per package:** `execution`, `review`, `acceptance`, `quality`, `context`

```json
// .nax/mono/packages/api/config.json
{
  "quality": {
    "commands": {
      "test": "turbo test --filter=@myapp/api",
      "lint": "turbo lint --filter=@myapp/api"
    }
  }
}
```

### Per-Package Stories

In your `prd.json`, set `workdir` on each story to point to the package:

```json
{
  "userStories": [
    {
      "id": "US-001",
      "title": "Add auth endpoint",
      "workdir": "packages/api",
      "status": "pending"
    }
  ]
}
```

nax will run the agent inside that package's directory and apply its config overrides automatically.

### Workspace Detection

When `nax plan` generates stories for a monorepo, it auto-discovers packages from:
- `turbo.json` → `packages` field
- `package.json` → `workspaces`
- `pnpm-workspace.yaml` → `packages`
- Existing `.nax/mono/*/context.md` files

### Generate Agent Files for All Packages

```bash
nax generate --all-packages
```

Generates a `CLAUDE.md` (or agent-specific file) in each discovered package directory, using the package's own `.nax/mono/<package>/context.md` if present.

---

## Hooks

Integrate notifications, CI triggers, or custom scripts via lifecycle hooks.

**Project hooks** (`.nax/hooks.json`):

```json
{
  "hooks": {
    "on-complete": {
      "command": "openclaw system event --text 'Feature done!'",
      "enabled": true
    },
    "on-pause": {
      "command": "bash hooks/notify.sh",
      "enabled": true
    }
  }
}
```

**Available events:**

| Event | Fires when |
|:------|:-----------|
| `on-start` | Run begins |
| `on-story-start` | A story starts processing |
| `on-story-complete` | A story passes all checks |
| `on-story-fail` | A story exhausts all retry attempts |
| `on-pause` | Run paused (awaiting human input) |
| `on-resume` | Run resumed after pause |
| `on-session-end` | An agent session ends (per-session teardown) |
| `on-all-stories-complete` | All stories passed — regression gate pending *(v0.34.0)* |
| `on-final-regression-fail` | Deferred regression failed after rectification *(v0.34.0)* |
| `on-complete` | Everything finished and verified (including regression gate) |
| `on-error` | Unhandled error terminates the run |

**Hook lifecycle:**

```
on-start
  └─ on-story-start → on-story-complete (or on-story-fail)  ← per story
       └─ on-all-stories-complete                            ← all stories done
            └─ deferred regression gate (if enabled)
                 └─ on-final-regression-fail                 ← if regression fails
       └─ on-complete                                        ← everything verified
```

Each hook receives context via `NAX_*` environment variables and full JSON on stdin.

**Environment variables passed to hooks:**

| Variable | Description |
|:---------|:------------|
| `NAX_EVENT` | Event name (e.g., `on-story-complete`) |
| `NAX_FEATURE` | Feature name |
| `NAX_STORY_ID` | Current story ID (if applicable) |
| `NAX_STATUS` | Status (`pass`, `fail`, `paused`, `error`) |
| `NAX_REASON` | Reason for pause or error |
| `NAX_COST` | Accumulated cost in USD |
| `NAX_MODEL` | Current model |
| `NAX_AGENT` | Current agent |
| `NAX_ITERATION` | Current iteration number |

**Global vs project hooks:** Global hooks (`~/.nax/hooks.json`) fire alongside project hooks. Set `"skipGlobal": true` in your project `hooks.json` to disable global hooks.

---

## Interaction Triggers

nax can pause execution and prompt you for decisions at critical points. Configure triggers in `nax/config.json` (or `~/.nax/config.json` globally):

```json
{
  "interaction": {
    "plugin": "telegram",
    "defaults": {
      "timeout": 600000,
      "fallback": "escalate"
    },
    "triggers": {
      "security-review": true,
      "cost-exceeded": true,
      "cost-warning": true,
      "max-retries": true,
      "human-review": true,
      "story-ambiguity": true,
      "story-oversized": true,
      "review-gate": true,
      "pre-merge": false,
      "merge-conflict": true
    }
  }
}
```

**Available triggers:**

| Trigger | Safety | Default Fallback | Description |
|:--------|:------:|:----------------:|:------------|
| `security-review` | 🔴 Red | `abort` | Critical security issues found during review |
| `cost-exceeded` | 🔴 Red | `abort` | Run cost exceeded the configured limit |
| `merge-conflict` | 🔴 Red | `abort` | Git merge conflict detected |
| `cost-warning` | 🟡 Yellow | `escalate` | Approaching cost limit — escalate to higher model tier? |
| `max-retries` | 🟡 Yellow | `skip` | Story exhausted all retry attempts — skip and continue? |
| `pre-merge` | 🟡 Yellow | `escalate` | Checkpoint before merging to main branch |
| `human-review` | 🟡 Yellow | `skip` | Human review required on critical failure |
| `story-oversized` | 🟡 Yellow | `continue` | Story too complex — decompose into sub-stories? |
| `story-ambiguity` | 🟢 Green | `continue` | Story requirements unclear — continue with best effort? |
| `review-gate` | 🟢 Green | `continue` | Code review checkpoint before proceeding |

**Safety tiers:**
- 🔴 **Red** — Critical; defaults to aborting if no response
- 🟡 **Yellow** — Caution; defaults to escalating or skipping
- 🟢 **Green** — Informational; defaults to continuing

**Fallback behaviors** (when interaction times out):
- `continue` — proceed as normal
- `skip` — skip the current story
- `escalate` — escalate to a higher model tier
- `abort` — stop the run

**Interaction plugins:**

| Plugin | Description |
|:-------|:------------|
| `telegram` | Send prompts via Telegram bot (recommended for remote runs) |
| `cli` | Interactive terminal prompts (for local runs) |
| `webhook` | POST interaction requests to a webhook URL |
| `auto` | Auto-respond based on fallback behavior (no human prompt) |

---

## Plugins

Extend nax with custom reviewers, reporters, or integrations.

**Project plugins** (`.nax/config.json`):

```json
{
  "plugins": [
    { "name": "my-reporter", "path": "./plugins/my-reporter.ts" }
  ]
}
```

**Global plugin directory:** `~/.nax/plugins/` — plugins here are loaded for all projects.

### Reviewer Plugins

Reviewer plugins run during the review pipeline stage and return structured `ReviewFinding` objects:

```typescript
interface ReviewFinding {
  ruleId: string;        // e.g. "javascript.express.security.audit.xss"
  severity: "critical" | "error" | "warning" | "info" | "low";
  file: string;
  line: number;
  column?: number;
  message: string;
  url?: string;          // Link to rule documentation
  source: string;        // e.g. "semgrep", "eslint", "snyk"
  category?: string;     // e.g. "security", "performance"
}
```

Findings are threaded through the escalation pipeline — if a story fails review, the retry agent receives the exact file, line, and rule to fix.

**Example:** The built-in Semgrep reviewer plugin scans for security issues using `semgrep scan --config auto` and returns structured findings.

---

## Troubleshooting

**`nax.lock` blocking a new run**

```bash
# Check if nax is actually running first
pgrep -fa nax

# If nothing is running, remove the lock
rm nax.lock
```

**Story keeps failing**

```bash
nax diagnose -f my-feature
```

**Precheck fails**

```bash
nax precheck -f my-feature
# Fix reported issues, then re-run
```

**Run stopped mid-way**

nax saves progress in `.nax/features/<name>/prd.json`. Re-run with the same command — completed stories are skipped automatically.

---

## PRD Format

User stories are defined in `.nax/features/<name>/prd.json`:

```json
{
  "feature": "user-auth",
  "userStories": [
    {
      "id": "US-001",
      "title": "Add login endpoint",
      "description": "POST /auth/login with email/password",
      "acceptanceCriteria": [
        "Returns JWT on success",
        "Returns 401 on invalid credentials"
      ],
      "complexity": "medium",
      "tags": ["auth", "security"],
      "status": "pending"
    }
  ]
}
```

> **Note:** Use `"status": "passed"` (not `"done"`) to manually mark a story complete.

---


## License

MIT

