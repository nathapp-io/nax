# nax

**AI Coding Agent Orchestrator** — loops until done.

Smart routing. Three-session TDD. Hooks for everything.

## Quick Start

```bash
bun install -g @nathapp/nax
cd your-project
nax init
nax features create my-feature
# Edit nax/features/my-feature/spec.md and tasks.md
nax run --feature my-feature
```

## How It Works

```
plan → tasks → analyze → execute (loop until complete)
```

1. **Classify** each story by complexity (simple/medium/complex/expert)
2. **Route** to the right model (Haiku → Sonnet → Opus)
3. **Select test strategy** via decision tree:
   - Simple/medium → `test-after` (single session)
   - Complex/expert/security/public-api → `three-session-tdd`
4. **Execute** agent sessions with auto-escalation on failure
5. **Verify** isolation between TDD sessions
6. **Loop** until all stories pass or a blocker is hit

## Three-Session TDD

For quality-critical work, nax uses three isolated sessions:

| Session | Role | Rules |
|:--------|:-----|:------|
| 1 | Test Writer | Only creates test files. No source code. |
| 2 | Implementer | Only modifies source. No test changes. |
| 3 | Verifier | Reviews changes. Auto-approves legitimate fixes. |

Isolation is verified automatically between sessions.

## Hooks

Configure lifecycle hooks in `nax/hooks.json`:

```json
{
  "hooks": {
    "on-start": { "command": "echo started", "timeout": 5000, "enabled": true },
    "on-complete": { "command": "openclaw system event --text 'Done!'", "enabled": true },
    "on-pause": { "command": "bash hooks/notify.sh", "enabled": true }
  }
}
```

Each hook receives context via `NAX_*` environment variables and full JSON on stdin.

## Configuration

Global: `~/.nax/config.json`
Project: `nax/config.json` (overrides global)

## Commands

```bash
nax init                    # Initialize in project
nax features create <name>  # Create a feature
nax features list           # List features
nax run -f <name>           # Run the loop
nax run -f <name> --dry-run # Preview without executing
nax status -f <name>        # Show progress
nax agents                  # Check installed agents
```

## License

MIT
