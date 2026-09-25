---
title: CLI Reference
description: Complete CLI command reference for nax
---

## CLI Reference

### `nax init`

Initialize nax in your project. Creates the `.nax/` folder structure (and a minimal `~/.nax/` global layer on first use). Idempotent: existing config/context files are kept unless `--force`; `.gitignore` and `.naxignore` are reconciled on every run.

```bash
nax init
```

Creates:
```
.nax/
├── config.json       # Project-level config (stack-detected)
├── context.md        # Project context for `nax generate`
├── constitution.md   # Stack-aware coding constitution
├── hooks/
└── features/         # One folder per feature
```

**Flags:**

| Flag | Description |
|:-----|:------------|
| `-d, --dir <path>` | Project directory |
| `-n, --name <name>` | Project name for the output registry (default: directory name). An explicit name that another checkout already claims fails with a collision — resolve with `nax migrate --reclaim/--merge` |
| `-f, --force` | Overwrite existing files |
| `--package <dir>` | Scaffold a monorepo package context (see below) |

**Monorepo — scaffold a package:**

```bash
nax init --package packages/api
```

Creates `.nax/mono/packages/api/context.md` for per-package agent context.

---

### `nax setup`

Analyze the repo and generate `.nax/config.json` via an LLM call.

```bash
nax setup
nax setup --dry-run
```

| Flag | Description |
|:-----|:------------|
| `-d, --dir <path>` | Project directory |
| `-a, --agent <name>` | Force a specific agent |
| `--fill-scripts` | Add missing quality-gate scripts to `package.json` |
| `--dry-run` | Preview the planned config without writing files |
| `--force` | Overwrite an existing `.nax/config.json` |

---

### `nax migrate`

Move generated content (runs, metrics, prompt audits, …) out of a legacy `.nax/` into the output directory (`~/.nax/<project>/`, or `outputDir`), and resolve project-name collisions.

```bash
nax migrate --dry-run
nax migrate --reclaim my-project   # Archive ~/.nax/my-project/ to free the name
nax migrate --merge my-project     # Point the identity for my-project at this workdir
```

| Flag | Description |
|:-----|:------------|
| `-d, --dir <path>` | Project directory |
| `--dry-run` | Preview moves without touching the filesystem |
| `--reclaim <name>` | Archive `~/.nax/<name>/` to free the project name |
| `--merge <name>` | Rewrite the identity for `<name>` to point to this workdir |

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

### `nax features resolve [name]`

Resolve the feature name and spec source deterministically (useful for scripts and skills).

```bash
nax features resolve user-auth --json
```

Flags: `--json` (machine-readable output), `-d, --dir <path>`. Exit codes: `0` resolved, `2` needs a human decision (ambiguous, missing, or unknown feature), `1` hard error / not a nax repo.

---

### `nax plan -f <name> --from <spec>`

Generate a `prd.json` from a spec file using an LLM. Replaces the removed `nax analyze`. The planning strategy comes from `plan.mode` in config (`single`, the default, or `refine`); the retired `debate`/`pipeline` modes are rejected at config load.

```bash
nax plan -f my-feature --from spec.md
```

**Flags:**

| Flag | Description |
|:-----|:------------|
| `-f, --feature <name>` | Feature name (required) |
| `--from <spec-path>` | Path to spec file (required unless `--decompose` is used) |
| `--auto` / `--one-shot` | Accepted for compatibility; no longer changes behaviour (use `plan.mode`) |
| `-b, --branch <branch>` | Override default branch name |
| `--decompose <storyId>` | Decompose an existing story into sub-stories |
| `--no-spec-lint` | Plan even when the spec declares sections that extract to nothing (see `nax spec lint`) |
| `--profile <name>` | Profile(s) to overlay on config (overrides `config.json` profile). Repeatable and comma-separated for a chain — `--profile a,b` or `--profile a --profile b` — where a later profile overrides an earlier one (`b` over `a` over project + global). Accepts the comma form in `NAX_PROFILE` and `config.json` too. |
| `-d, --dir <path>` | Project directory |

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
| `-a, --agent <name>` | Override the default agent for this run (`native`, `claude`, `codex`, `opencode`, `gemini`, `aider`, `pi`). Mutually exclusive with `--compare` |
| `--compare <agents>` | Bake-off mode: comma-separated contestant agents (e.g. `claude,codex`) |
| `--max-cost <usd>` | Override `execution.costLimit` for this run (per contestant with `--compare`) |
| `--plan` | Run plan phase first (requires `--from`) |
| `--from <spec-path>` | Spec file for `--plan` |
| `--no-spec-lint` | With `--plan`: plan even when the spec fails the extraction-integrity lint |
| `--one-shot` | Accepted for compatibility with `--plan`; no longer changes behaviour |
| `--force` | Overwrite existing `prd.json` when using `--plan` |
| `--schedule <when>` | Defer the run start until `<when>` (`30m`, `1h30m`, `17:00`, `2026-07-02T02:00`) |
| `--fresh` / `--no-resume` | Ignore any existing `checkpoint.jsonl` and re-run every incomplete story from scratch (default: auto-resume) |
| `--parallel <n>` | Max parallel sessions (omit = sequential) |
| `--dry-run` | Preview story routing without running agents |
| `--headless` | Non-interactive output (structured logs, no TUI) |
| `--verbose` | Debug-level logging |
| `--quiet` | Warnings and errors only |
| `--silent` | Errors only |
| `--json` | Raw JSONL output to stdout (for scripting) |
| `--skip-precheck` | Skip precheck validations (advanced users only) |
| `--no-context` | Disable context builder (skip file context in prompts) |
| `--no-batch` | Execute all stories individually (disable batching) |
| `-m, --max-iterations <n>` | Max iterations (default: `20`). Overrides `execution.maxIterations` only when the flag is passed |
| `--profile <name>` | Profile(s) to overlay on config (overrides `config.json` profile). Repeatable and comma-separated for a chain — `--profile a,b` or `--profile a --profile b` — where a later profile overrides an earlier one (`b` over `a` over project + global). Accepts the comma form in `NAX_PROFILE` and `config.json` too. |
| `-d, --dir <path>` | Working directory |

**Examples:**

```bash
# Preview what would run (no agents spawned)
nax run -f user-auth --dry-run

# Plan from spec then run — one command
nax run -f user-auth --plan --from spec.md

# Run with up to 3 parallel worktree sessions
nax run -f user-auth --parallel 3

# Force a specific agent
nax run -f user-auth --agent opencode

# Bake-off: run the same feature with two agents and compare
nax run -f user-auth --compare claude,codex

# Start at 2am
nax run -f user-auth --schedule 02:00

# Run in CI/CD (structured output)
nax run -f user-auth --headless

# Raw JSONL for scripting
nax run -f user-auth --json
```

---

### `nax resume -f <name>`

Resume an interrupted run for a feature from its checkpoint (same as `nax run`, which auto-resumes by default).

```bash
nax resume -f my-feature
```

Flags: `-f, --feature <name>` (required), `-d, --dir <path>`.

---

### `nax accept`

Override a failed acceptance criterion; the override and reason are stored in `prd.json`.

```bash
nax accept -f my-feature --override AC-2 -r "intentional: lazy expiry"
```

All three flags are required: `-f, --feature <name>`, `--override <ac-id>`, `-r, --reason <reason>`.

---

### `nax precheck -f <name>`

Validate your project is ready to run — checks git, PRD, CLI tools, deps, test/lint/typecheck scripts.

```bash
nax precheck -f my-feature
```

Run this before `nax run` to catch configuration issues early. Add `--json` for machine-readable output; `-d, --dir <path>` selects the project.

### `nax precheck --light`

Environment-only check — validates git, CLI tools, and deps without requiring a PRD or feature directory.

```bash
nax precheck --light
```

Use this **before `nax plan`** to catch blockers (missing tools, git not initialized, etc.) before spending tokens on planning. It runs only the environment tier of checks (the project tier needs a PRD).

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

# Cost report as JSON (requires --cost)
nax status --cost --json
```

`-d, --dir <path>` selects the project directory.

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

Short forms: `-f` (`--follow`), `-s` (`--story`), `-l` (`--list`), `-r` (`--run`), `-j` (`--json`); `-d, --dir <path>` selects the project.

---

### `nax replay [run-id]`

Reconstruct a post-mortem timeline for a previous run from its artifacts (latest run when `run-id` is omitted). Failure-focused by default.

```bash
nax replay
nax replay <runId> --all          # Include passed stories
nax replay <runId> -s US-003      # One story only
nax replay <runId> --json
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
| `-d, --dir <path>` | Project directory |
| `-a, --agent <name>` | Generate for a specific agent only (`claude`, `opencode`, `cursor`, `windsurf`, `aider`, `codex`, `gemini`) |
| `--dry-run` | Preview without writing files |
| `--no-auto-inject` | Disable auto-injection of project metadata |
| `--package <dir>` | Generate for a specific monorepo package (e.g. `packages/api`) |
| `--all-packages` | Generate for every package that has a `.nax/mono/<package>/context.md` |

**What it generates:**

| Agent | File |
|:------|:-----|
| Claude Code | `CLAUDE.md` |
| OpenCode | `AGENTS.md` |
| Codex | `codex.md` |
| Cursor | `.cursorrules` |
| Windsurf | `.windsurfrules` |
| Aider | `.aider.conf.yml` |
| Gemini | `GEMINI.md` |

**Workflow:**

1. Create `.nax/context.md` — describe your project's architecture, conventions, and coding standards
2. Run `nax generate` — writes agent config files to the project root (and per-package if configured)
3. Commit the generated files — your agents will automatically pick them up

**Monorepo (per-package):**

```bash
# Generate CLAUDE.md for a single package (other agents via config generate.agents)
nax generate --package packages/api

# Generate for every package with a .nax/mono/<package>/context.md
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
| `-d, --dir <path>` | Project directory |

After running `--init`, edit the templates and nax will use them automatically via `prompts.overrides` config.

---

### `nax unlock`

Release a stale `nax.lock` from a crashed process. The holder's liveness is checked first.

```bash
nax unlock                 # Checkout lock + every stale per-feature lock
nax unlock -f my-feature   # Only <outputDir>/features/my-feature/nax.lock
nax unlock --force         # Skip the liveness check
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

# Filter by status (running|completed|failed|crashed|cost-limit)
nax runs --status failed

# Runs for one feature in this project
nax runs list -f my-feature
nax runs show <run-id> -f my-feature
```

---

### `nax approvals list`

List the human-remembered approvals on the project's cache and report
whether the store is currently trusted.

```bash
nax approvals list

# Resolve the store for a specific workdir
nax approvals list -d /path/to/project

# Emit machine-readable JSON
nax approvals list --json
```

**Flags:**

| Flag | Description |
|:-----|:------------|
| `-d, --dir <path>` | Project directory (defaults to the current directory) |
| `--json` | Emit the list as a machine-readable JSON object |

**Output:**

The first two lines name the resolved store file and report cache trust:

```
Approvals store: <path>/approvals.json
Cache: trusted
```

A store that a forge-capable run has touched since shows `Cache: TAINTED`
together with the `since`, `runId`, pid liveness and a one-line note that a
trusted run will discard those entries. The third line is the count of
remembered approvals, followed by one block per entry:

```
<approvalId>  <stage>  <origin>  <approvedAt>  <approvedBy>  naxCommit <naxCommit>
          root <root>
          $ <first command line>
            <second command line>
```

Commands print raw. There is no expiry: entries are removed via `nax approvals rm`.

A missing store prints a single notice on stdout:

```
No remembered approvals at <path>/approvals.json
```

A store whose bytes cannot be parsed warns on stderr (`approvals.json could not
be parsed; the cache reads it as empty`) and prints the same notice on stdout.
A store whose JSON parses but holds array elements that are not approval
entries lists `<n> malformed entries ignored` on stderr and lists the valid
entries on stdout.

`--json` prints one JSON object on stdout with the keys `path`, `state`,
`taint` (null when absent), `droppedMalformed` and `entries`; each entry is
`{ id: approvalId(entry), ...entry }`. `state` is `"missing"`, `"unparseable"`
or `"ok"`. The unparseable body keeps the parse warning on stderr but writes
the JSON body alone.

---

### `nax approvals rm`

Revoke one or more remembered approvals from the project's cache. Every form
goes through the same locked, taint-preserving `removeApprovals` primitive, so
a partial or interrupted revocation cannot leave the cache half-written.

```bash
# Revoke one or more approvals by their 8-character hex id
nax approvals rm <id> [<id>...]

# Revoke every approval for a stage
nax approvals rm --stage execution

# Revoke every remembered approval (with confirmation)
nax approvals rm --all

# Same, skipping the confirmation prompt
nax approvals rm --all --yes
```

**Flags:**

| Flag | Description |
|:-----|:------------|
| `-d, --dir <path>` | Project directory (defaults to the current directory) |
| `--stage <stage>` | Remove every approval for the given stage |
| `--all` | Remove every remembered approval |
| `--yes` | Skip the `--all` confirmation prompt |

**Selectors.** Exactly one of `<id...>`, `--stage <stage>`, or `--all` must be
supplied. Mixing selectors, or supplying none, prints
`Specify exactly one of <id...>, --stage <stage>, --all` on stderr and exits 1.
An id outside the eight-character hex shape prints `Invalid id: <id>` on stderr
and exits 1.

**`--all` flow.** `--all` revokes every remembered approval. The store is read
first; `<store>` below is the resolved `approvals.json` path.

- A missing store or a present store with no entries prints
  `No remembered approvals at <store>` on stdout and exits 0;
  no prompt is shown and no write happens.
- An unparseable store prints
  `approvals.json could not be parsed; not rewriting it` on stderr and exits 1;
  the file is left untouched.
- Otherwise the confirmation gate runs (unless `--yes` was given):
  - Without a TTY and without `--yes`, prints `Aborted` on stderr and exits 1.
  - On a TTY, asks `Remove all remembered approvals?` through
    `promptForConfirmation`; a `false` answer prints `Aborted` on stderr and
    exits 1, a `true` answer revokes every entry.

After a successful `--all` revocation, the store is empty (or absent if it was
created by the run) and one `removed <id>  <stage>  <preview>` line per entry
is written to stdout. If the read dropped malformed array elements while
writing, `<n> malformed entries dropped` is written to stderr.

The `taint` marker is preserved by every form here. Only a trusted run clears
it through `clearApprovalsTaint`; `nax approvals rm` never touches it.

**Store failures.** A `FILE_LOCK_TIMEOUT` (another nax run is mid-write)
prints `a nax run is writing <store>; retry` on stderr and exits 1.
Any other store error prints `Failed to update <store>: <message>` on stderr
and exits 1.

---

### `nax agents`

List installed coding agents and which models they support.

```bash
nax agents
```

---

### `nax auth`

Manage provider credentials for the `native` agent. A stored credential takes precedence over an environment variable.

```bash
nax auth login <provider>              # Interactive; --method api-key|oauth skips the prompt
nax auth import                        # Import from pi's ~/.pi/agent/auth.json (--from <path>, --force)
nax auth list
nax auth rm <provider>                 # Local removal only; does not revoke at the provider
```

---

### `nax mcp lock`

Refresh `.nax/mcp-lock.json` from what each configured MCP server (`mcp.servers`) advertises. Connects every enabled server once, at the project root.

```bash
nax mcp lock
```

---

### `nax routing calibrate`

Propose complexity→tier mapping adjustments from run history.

```bash
nax routing calibrate
nax routing calibrate --apply          # Write the mapping into .nax/config.json
```

Flags: `-d, --dir <path>`, `--apply`, `--json`, `--min-samples <n>` (override the per-band sample floor).

---

### `nax detect`

Detect test-file patterns for the project and optionally persist them.

```bash
nax detect
nax detect --apply
```

Flags: `-d, --dir <path>`, `--apply` (write to `.nax/` configs), `--json`, `--package <dir>` (one package only), `--force` (with `--apply`, overwrite an explicit `testFilePatterns`).

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

**Profiles:**

```bash
nax config profile list            # Available profiles grouped by scope
nax config profile show <name>     # Resolved profile JSON (--unmask shows secrets)
nax config profile use <name>      # Set the active profile ('default' clears it)
nax config profile current         # Active profile name
nax config profile create <name>   # Create an empty profile
```

All `config` subcommands accept `-d, --dir <path>`.

---

### `nax context`

Inspect context-engine artifacts.

```bash
nax context inspect US-003 [-f <feature>] [--json]   # Persisted context manifests for a story
nax context fragments inspect -f <feature>           # Fragments + dependent story IDs
nax context fragments prune -f <feature> [storyId]   # Remove fragments (one story, or all)
nax context effectiveness eval -l labels.json [--json]
```

---

### `nax spec lint [paths...]`

Check a spec's machine-extracted sections before `nax plan` spends on it.

```bash
nax spec lint -f my-feature
nax spec lint path/to/spec.md --strict
```

Flags: `-f, --feature <name>` (lint that feature's `spec.md`), `-d, --dir <path>`, `--strict` (fail on every error, not only those that block `nax plan`).

---

### `nax rules`

Manage the canonical rules store (`.nax/rules/`).

```bash
nax rules lint                           # Validate neutrality/frontmatter (root + package overlays)
nax rules export -a claude               # claude → .claude/rules/; codex|gemini|cursor → shim file
nax rules export -a claude --check       # Exit non-zero on drift
nax rules migrate [--force] [--dry-run]  # Legacy CLAUDE.md + .claude/rules/*.md → .nax/rules/
```

---

### `nax plugins list`

List installed plugins.

```bash
nax plugins list
```

---

### `nax curator status`

Show curator observations and proposals from the latest (or specified) run.

```bash
nax curator status                    # Latest run
nax curator status --run <runId>      # Specific run
nax curator status --project <path>   # Specific project directory
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
nax curator commit run-001 --project ./path/to/project
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
nax curator dryrun --project ./path/to/project
```

Useful for threshold calibration: adjust `config.curator.thresholds` values, re-run dryrun on the same observations, and see how proposal counts change.

---

### `nax curator gc`

Prune old rows from the cross-run curator rollup.

```bash
nax curator gc --keep 50   # Keep 50 most recent runs (default)
nax curator gc --keep 100  # Keep 100 runs
nax curator gc --project ./path/to/project
nax curator gc --sweep-unattributed   # Also drop rows with no projectKey (machine-wide)
```

Rewrites only the configured rollup JSONL file, keeping rows for the most recent run IDs. It does not delete per-run proposal files, observations, run logs, metrics, or canonical context/rules files.
