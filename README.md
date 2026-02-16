# ngent

**AI Coding Agent Orchestrator** — loops until done.

Smart routing. Three-session TDD. Hooks for everything.

## Quick Start

```bash
bun install -g ngent
cd your-project
ngent init
ngent features create my-feature
# Edit ngent/features/my-feature/spec.md and tasks.md
ngent run --feature my-feature
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

For quality-critical work, ngent uses three isolated sessions:

| Session | Role | Rules |
|:--------|:-----|:------|
| 1 | Test Writer | Only creates test files. No source code. |
| 2 | Implementer | Only modifies source. No test changes. |
| 3 | Verifier | Reviews changes. Auto-approves legitimate fixes. |

Isolation is verified automatically between sessions.

## Hooks

Configure lifecycle hooks in `ngent/hooks.json`:

```json
{
  "hooks": {
    "on-start": { "command": "echo started", "timeout": 5000, "enabled": true },
    "on-complete": { "command": "openclaw system event --text 'Done!'", "enabled": true },
    "on-pause": { "command": "bash hooks/notify.sh", "enabled": true }
  }
}
```

Each hook receives context via `NGENT_*` environment variables and full JSON on stdin.

## Configuration

Global: `~/.ngent/config.json`
Project: `ngent/config.json` (overrides global)

## Commands

```bash
ngent init                    # Initialize in project
ngent features create <name>  # Create a feature
ngent features list           # List features
ngent run -f <name>           # Run the loop
ngent run -f <name> --dry-run # Preview without executing
ngent status -f <name>        # Show progress
ngent agents                  # Check installed agents
```

## License

MIT
