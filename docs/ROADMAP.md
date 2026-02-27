# nax Roadmap

> **Authoritative source** for planned and shipped versions.
> Specs in `memory/` are detailed references. GitLab issues are supplementary.

---

## Shipped

### v0.12.0 — Structured Logging (2026-02-27)

Human-friendly output, `nax status`, `nax logs`, crash recovery.

| Story | Title | Pts | Status |
|:---|:---|:---|:---|
| US-001 | Project resolver (CWD + -d) | 2 | ✅ passed |
| US-002 | Logging formatter | 5 | ✅ passed |
| US-003 | status.json writer | 3 | ✅ passed |
| US-004 | `nax status` command | 3 | ✅ passed |
| US-005 | `nax logs` command | 5 | ✅ passed |
| US-006 | Integrate formatter into runner | 3 | ✅ passed |
| US-007 | Crash recovery (signals, heartbeat) | 3 | ✅ passed |

**Next:** Run full test suite, then publish `v0.12.0-canary.0`.

### v0.11.0 — Plugin Integration (2026-02-27)

8 plugin stories + TDD state-sync fix + test regressions fixed.

### v0.10.0 — Prompt Optimizer + Global Config

### v0.9.x — LLM Routing + Isolation

### v0.5.0–v0.8.x — Core pipeline, TDD, verification, structured logging

*(See git tags for full history)*

---

## Current: v0.13.0-canary — Precheck

**Status:** Spec approved, not started
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

## Next: v0.14.0 — Parallel Execution

- Git worktree isolation per story
- Claude Code --worktree flag
- Parallel 2-3 concurrent stories
- Dependency-aware ordering

---

## Backlog

### Bugs
- [x] ~~BUG-003: PRD status "done" not skipped (fixed 080d890)~~
- [x] ~~BUG-004: router.ts crashes on missing tags (fixed 080d890)~~
- [ ] BUG-002: Orphan Claude processes after nax crash (needs PID tracking + process groups)
- [ ] BUG-005: Hardcoded `bun run lint` in review (v0.13.0 precheck)
- [ ] BUG-006: scopeToStory falls back to full scan (needs context auto-detection)
- [ ] BUG-008: E2E tests hang with infinite retry (needs timeout/isolation)
- [ ] BUG-009: No cross-story regression check in test-after strategy

### Features
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
