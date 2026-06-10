---
title: CLI Reference
description: Complete CLI command reference for nax
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
| `--from <spec-path>` | Path to spec file (required unless `--decompose` is used) |
| `--auto` / `--one-shot` | Skip interactive Q&A — single LLM call, no back-and-forth |
| `-b, --branch <branch>` | Override default branch name |
| `--decompose <storyId>` | Decompose an existing story into sub-stories |
| `--profile <name>` | Profile to use (overrides `config.json` profile) |
| `-d, --dir <path>` | Project directory |

**Interactive vs one-shot:**
- Default (no flag): interactive planning session — nax asks clarifying questions, refines the plan iteratively
- `--auto` / `--one-shot`: single LLM call, faster but less precise

> **Note:** `nax analyze` was removed — use `nax plan` instead.

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
| `-a, --agent <name>` | Override the default agent for this run (`claude`, `opencode`, `codex`, `gemini`, `aider`, etc.). |
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
| `-m, --max-iterations <n>` | Max iterations (default: `20`) |
| `--profile <name>` | Profile to use (overrides `config.json` profile) |
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

### `nax precheck --light`

Environment-only check — validates git, CLI tools, and deps without requiring a PRD or feature directory.

```bash
nax precheck --light
```

Use this **before `nax plan`** to catch blockers (missing tools, git not initialized, etc.) before spending tokens on planning. Equivalent to running precheck with an empty PRD.

---

### `nax status -f <name>`

Show live run progress — stories passed, failed, current story, cost so far.

```bash
nax status -f my-feature

# Cost metrics across all runs
nax status --cost

# Last run metrics (requires --cost)
nax status --cost --last

# Per-model efficiency (requires --cost)
nax status --cost --model
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
| `-f, --feature <name>` | Feature name (required unless using `--init` or `--export`) |
| `--init` | Initialize default prompt templates for customization |
| `--export <role>` | Export the default prompt for a role to stdout (or `--out` file) |
| `--story <id>` | Filter to a single story ID (e.g., `US-003`) |
| `--out <path>` | Output file for `--export`, or directory for regular prompts (default: stdout) |
| `--force` | Overwrite existing template files |

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

# Filter by project
nax runs --project my-project

# Limit to N most recent (default: 20)
nax runs --last 50

# Filter by status (running|completed|failed|crashed)
nax runs --status failed
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

### `nax curator status`

Show curator observations and proposals from the latest (or specified) run.

```bash
nax curator status                    # Latest run
nax curator status --run <runId>      # Specific run
nax curator status --project <name>   # Specific project
```

Displays:
- Observation counts by kind (review findings, escalations, rectification cycles, etc.)
- Proposal summary by category (add to context, add to rules, drop from rules, advisory)
- Path to the proposal file for review

---

### `nax curator commit <runId>`

Apply checked proposals to your canonical context and rules files.

```bash
nax curator commit run-001
nax curator commit run-001 --project my-project
```

Process:
1. Reads `<runId>/curator-proposals.md`
2. Parses checked `[x]` lines (unchecked `[ ]` lines are skipped)
3. For each checked proposal:
   - **Drop proposals** execute first (removes lines from rules files)
   - **Add proposals** execute second (appends to `.nax/features/<id>/context.md` or `.nax/rules/` files)
4. Opens modified files in `$EDITOR` for human review
5. Prints summary of applied proposals

**Does not commit to git** — changes remain in your working directory for review before `git add` / `git commit`.

---

### `nax curator dryrun`

Re-run curator heuristics against existing observations without re-collecting them.

```bash
nax curator dryrun --run <runId>
nax curator dryrun --project my-project
```

Useful for threshold calibration: adjust `config.curator.thresholds` values, re-run dryrun on the same observations, and see how proposal counts change.

---

### `nax curator gc`

Prune old rows from the cross-run curator rollup.

```bash
nax curator gc --keep 50   # Keep 50 most recent runs (default)
nax curator gc --keep 100  # Keep 100 runs
nax curator gc --project my-project
```

Rewrites only the configured rollup JSONL file, keeping rows for the most recent run IDs. It does not delete per-run proposal files, observations, run logs, metrics, or canonical context/rules files.
