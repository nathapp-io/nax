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
analyze → route → execute → verify → (loop until all stories pass) → regression gate
```

1. **Analyze** each user story — classify complexity, select test strategy
2. **Route** to the right model tier (cheap → standard → premium)
3. **Execute** an agent session (Claude Code by default)
4. **Verify** tests pass; escalate model tier on failure
5. **Loop** until all stories are complete or a cost/iteration limit is hit
6. **Regression gate** — deferred full-suite verification after all stories pass

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

Parse a `spec.md` file into a structured `prd.json`. Uses an LLM to decompose the spec into classified user stories.

```bash
nax analyze -f my-feature
```

**Flags:**

| Flag | Description |
|:-----|:------------|
| `--from <path>` | Explicit spec path (overrides default `spec.md`) |
| `--reclassify` | Re-classify existing `prd.json` without re-decomposing |

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

### `nax prompts -f <name>`

Assemble and display the prompt that would be sent to the agent for each story role.

```bash
nax prompts -f my-feature
```

**Flags:**

| Flag | Description |
|:-----|:------------|
| `--init` | Export default role templates to `nax/templates/` for customization |
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

### `nax config --explain`

Display the effective merged configuration with inline explanations for every field.

```bash
nax config -f my-feature --explain
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

**TDD strategy options:**

| Value | Behaviour |
|:------|:----------|
| `auto` | nax decides based on complexity and tags |
| `lite` | Prefer `three-session-tdd-lite` for complex stories |
| `strict` | Always use full `three-session-tdd` for complex stories |

---

## Test Strategies

nax selects a test strategy per story based on complexity and tags:

| Strategy | Sessions | When | Description |
|:---------|:---------|:-----|:------------|
| `test-after` | 1 | Refactors, deletions, config, docs | Single session, no TDD discipline |
| `tdd-simple` | 1 | Simple stories | Single session with TDD prompt (red-green-refactor) |
| `three-session-tdd-lite` | 3 | Medium stories | Three sessions, relaxed isolation rules |
| `three-session-tdd` | 3 | Complex/security stories | Three sessions, strict file isolation |

Configure the default TDD behavior in `nax/config.json`:

```json
{
  "tdd": {
    "strategy": "auto"
  }
}
```

| Value | Behaviour |
|:------|:----------|
| `auto` | nax decides based on complexity and tags (default) |
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

**Project plugins** (`nax/config.json`):

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

