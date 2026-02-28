# nax Roadmap

> **Authoritative source** for planned and shipped versions.
> Specs in `memory/` are detailed references. GitLab issues are supplementary.

---

## Shipped

### v0.14.0 — Failure Resilience (2026-02-28)

Improve nax success rate before adding more features. Greenfield detection, auto-switch to test-after, escalation counter fixes.

| Story | Title | Pts | Status |
|:---|:---|:---|:---|
| US-001 | BUG-010: Greenfield detection → force test-after | 3 | ✅ passed |
| US-002 | BUG-009: Cross-story regression gate (test-after) | 5 | ✅ passed |
| US-003 | BUG-006: Context auto-detection (contextFiles) | 5 | ✅ passed |
| US-004 | BUG-002: Orphan process cleanup (PID registry) | 3 | ✅ passed |
| US-005 | Strategy fallback: TDD → test-after on empty tests | 3 | ✅ passed |
| BUG-011 | Escalation attempt counter reset on tier change | 2 | ✅ passed |

**Note:** BUG-011 re-fixed in fd8cc0f — post-pipeline escalation path was still incrementing instead of resetting.

### v0.13.0 — Precheck (2026-02-27)

Fail-fast validation before story execution. `nax precheck` CLI command. Config-driven review commands. PRD auto-default + router tags fix.

| Story | Title | Pts | Status |
|:---|:---|:---|:---|
| US-001 | Precheck types and check implementations | 3 | ✅ passed |
| US-002 | Precheck orchestrator | 3 | ✅ passed |
| US-003 | CLI `nax precheck` with `--json` | 2 | ✅ passed |
| US-004 | Integrate precheck into `nax run` | 2 | ✅ passed |
| US-005 | Config-driven review commands | 3 | ✅ passed |
| US-006 | PRD auto-default + router tags fix | 1 | ✅ passed |

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

### v0.11.0 — Plugin Integration + Parallel Execution (2026-02-27)

8 plugin stories + TDD state-sync fix + test regressions fixed.
Worktree-based parallel execution: WorktreeManager, MergeEngine, ParallelDispatcher, `--parallel` flag.

### v0.10.0 — Prompt Optimizer + Global Config

### v0.9.x — LLM Routing + Isolation

### v0.5.0–v0.8.x — Core pipeline, TDD, verification, structured logging

*(See git tags for full history)*

---

## Next: v0.14.1 — nax diagnose CLI

**Status:** Spec ready → `memory/20260228-v0141-diagnose-spec.md`

Pure CLI command — no LLM calls. Reads events.jsonl, PRD, git log, status.json and outputs structured diagnosis with pattern classification.

| Story | Title | Pts | Status |
|:---|:---|:---|:---|
| US-001 | `nax diagnose` CLI — pure pattern-matching diagnosis | 3 | 🔲 pending |

**Note:** LLM-assisted `--ai` flag deferred to a future version (TBD). Will use direct LLM API call when decided.

---

## Planned: v0.15.0

**Status:** TBD

---

## Backlog

### Bugs
- [x] ~~BUG-003: PRD status "done" not skipped (fixed 080d890)~~
- [x] ~~BUG-004: router.ts crashes on missing tags (fixed 080d890)~~
- [ ] BUG-002: Orphan Claude processes after nax crash (needs PID tracking + process groups)
- [x] ~~BUG-005: Hardcoded `bun run lint` in review (fixed by v0.13.0 US-005)~~
- [ ] BUG-006: scopeToStory falls back to full scan (needs context auto-detection)
- [ ] BUG-008: E2E tests hang with infinite retry (needs timeout/isolation)
- [ ] BUG-009: No cross-story regression check in test-after strategy
- [ ] BUG-010: TDD-lite test writer produces no test files on complex stories (reproduce: v0.13.0 US-001 precheck)
- [x] ~~BUG-011: Escalation tier budget not enforced per story (fixed by BUG-16/BUG-17 pre-iteration check)~~

### Features
- [ ] `nax unlock` command
- [ ] Constitution file support
- [ ] Context file auto-detection
- [ ] Cost tracking dashboard
- [ ] npm publish setup
- [ ] nax diagnose `--ai` flag (LLM-assisted, future version TBD)

---

## Versioning

Sequential canary -> stable: v0.12.0-canary.0 -> canary.N -> v0.12.0
Canary: `npm publish --tag canary`
Stable: `npm publish` (latest)

*Last updated: 2026-02-28*
