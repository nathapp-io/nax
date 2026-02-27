# nax Roadmap

> **Authoritative source** for planned and shipped versions.
> Specs in `memory/` are detailed references. GitLab issues are supplementary.

---

## Shipped

### v0.11.0 — Plugin Integration (2026-02-27)

8 plugin stories + TDD state-sync fix + test regressions fixed.

### v0.10.0 — Prompt Optimizer + Global Config

### v0.9.x — LLM Routing + Isolation

### v0.5.0–v0.8.x — Core pipeline, TDD, verification, structured logging

*(See git tags for full history)*

---

## Current: v0.12.0-canary — Structured Logging

**Status:** Spec approved, not started
**Spec:** memory/20260227-spec-logging.md

Human-friendly output, `nax status`, `nax logs`, crash recovery.

| Story | Title | Pts | Status |
|:---|:---|:---|:---|
| US-001 | Project resolver (CWD + -d) | 2 | pending |
| US-002 | Logging formatter | 5 | pending |
| US-003 | status.json writer | 3 | pending |
| US-004 | `nax status` command | 3 | pending |
| US-005 | `nax logs` command | 5 | pending |
| US-006 | Integrate formatter into runner | 3 | pending |
| US-007 | Crash recovery (signals, heartbeat) | 3 | pending |

---

## Next: v0.13.0-canary — Precheck

**Spec:** memory/20260227-spec-precheck.md

Fail-fast validation before story execution. `nax precheck` CLI command.

| Story | Title | Pts | Status |
|:---|:---|:---|:---|
| US-001 | Precheck types and check implementations | 3 | pending |
| US-002 | Precheck orchestrator | 3 | pending |
| US-003 | CLI `nax precheck` with `--json` | 2 | pending |
| US-004 | Integrate precheck into `nax run` | 2 | pending |
| US-005 | Config-driven review commands | 3 | pending |
| US-006 | PRD auto-default + router tags fix | 1 | pending |

---

## Future: v0.14.0 — Parallel Execution

- Git worktree isolation per story
- Claude Code --worktree flag
- Parallel 2-3 concurrent stories
- Dependency-aware ordering

---

## Backlog

- [ ] E2E test fix (infinite retry loop)
- [ ] `nax unlock` command
- [ ] Constitution file support
- [ ] Context file auto-detection
- [ ] Cost tracking dashboard
- [ ] npm publish setup

---

## Versioning

Sequential canary -> stable: v0.12.0-canary.0 -> canary.N -> v0.12.0
Canary: `npm publish --tag canary`
Stable: `npm publish` (latest)

*Last updated: 2026-02-27*
