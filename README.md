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
# Edit nax/features/my-feature/prd.json with your user stories
nax run -f my-feature
```

## How It Works

```
analyze → route → execute (loop until all stories pass)
```

1. **Analyze** each user story — classify complexity, select test strategy
2. **Route** to the right model tier (cheap → standard → premium)
3. **Execute** an agent session (Claude Code by default)
4. **Verify** tests pass; escalate model on failure
5. **Loop** until all stories are complete or a cost/iteration limit is hit

---

## CLI Reference

### `nax init`

Initialize nax in your project. Creates the `nax/` folder structure.

```bash
nax init
```

Creates:
```
nax/
├── config.json       # Project-level config
└── features/         # One folder per feature
```

---

### `nax features create <name>`

Scaffold a new feature.

```bash
nax features create user-auth
```

Creates `nax/features/user-auth/prd.json` — edit this file to define your user stories.

### `nax features list`

List all features and their story completion status.

```bash
nax features list
```

---

### `nax analyze -f <name>`

Parse a `spec.md` file into a structured `prd.json`. Useful if you prefer writing specs in markdown first.

```bash
nax analyze -f my-feature
```

---

### `nax run -f <name>`

Execute the orchestration loop for a feature.

```bash
nax run -f my-feature
```

**Flags:**

| Flag | Description |
|:-----|:------------|
| `-f, --feature <name>` | Feature name (required) |
| `--dry-run` | Preview story routing without running agents |
| `--headless` | Non-interactive output (structured logs, no TUI) |
| `-d, --dir <path>` | Project directory (defaults to `cwd`) |

**Examples:**

```bash
# Preview what would run (no agents spawned)
nax run -f user-auth --dry-run

# Run in a different directory
nax run -f user-auth -d /path/to/project

# Run in CI/CD (structured output)
nax run -f user-auth --headless
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

### `nax logs -f <name>`

Stream logs from the current or last run.

```bash
nax logs -f my-feature

# Follow in real-time
nax logs -f my-feature --follow

# Filter by story
nax logs -f my-feature --story US-003

# Filter by level
nax logs -f my-feature --level error
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

### `nax agents`

List installed coding agents and which models they support.

```bash
nax agents
```

---

## Configuration

Config is layered — project overrides global:

| File | Scope |
|:-----|:------|
| `~/.nax/config.json` | Global (all projects) |
| `nax/config.json` | Project-level override |

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
      "test": "bun test",
      "lint": "bun run lint",
      "typecheck": "bun x tsc --noEmit"
    }
  }
}
```

**TDD strategy options:**

| Value | Behaviour |
|:------|:----------|
| `auto` | nax decides based on complexity and tags |
| `lite` | Prefer `three-session-tdd-lite` for complex stories |
| `strict` | Always use full `three-session-tdd` for complex stories |

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

## Hooks

Integrate notifications, CI triggers, or custom scripts via lifecycle hooks.

**Project hooks** (`nax/hooks.json`):

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
| `on-story-start` | A story starts |
| `on-story-complete` | A story passes |
| `on-story-fail` | A story exhausts all attempts |
| `on-pause` | Run paused (awaiting input) |
| `on-complete` | All stories done |
| `on-error` | Unhandled error |

Each hook receives context via `NAX_*` environment variables and full JSON on stdin.

---

## Plugins

Extend nax with custom reporters or integrations. Configure in `nax/config.json`:

```json
{
  "plugins": [
    { "name": "my-reporter", "path": "./plugins/my-reporter.ts" }
  ]
}
```

Global plugin directory: `~/.nax/plugins/`

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

nax saves progress in `nax/features/<name>/prd.json`. Re-run with the same command — completed stories are skipped automatically.

---

## PRD Format

User stories are defined in `nax/features/<name>/prd.json`:

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

