# nax Roadmap

> **Authoritative source** for planned and shipped versions.
> Specs in `memory/` are detailed references. GitLab issues are supplementary.
> Full release notes → `docs/releases/`

---

## Next: v0.15.0

**Status:** TBD

---

---

## Shipped

| Version | Theme | Date | Details |
|:---|:---|:---|:---|
| v0.14.1 | nax diagnose CLI | 2026-02-28 | [releases/v0.14.1.md](releases/v0.14.1.md) |
| v0.14.0 | Failure Resilience | 2026-02-28 | [releases/v0.14.0.md](releases/v0.14.0.md) |
| v0.13.0 | Precheck | 2026-02-27 | [releases/v0.13.0.md](releases/v0.13.0.md) |
| v0.12.0 | Structured Logging | 2026-02-27 | [releases/v0.12.0.md](releases/v0.12.0.md) |
| v0.11.0 and earlier | Plugin Integration, LLM Routing, Core Pipeline | 2026-02-27 | [releases/v0.11.0-and-earlier.md](releases/v0.11.0-and-earlier.md) |

---

## Backlog

### Bugs
- [x] ~~BUG-002: Orphan Claude processes (fixed v0.14.0 US-004)~~
- [x] ~~BUG-003: PRD status "done" not skipped (fixed 080d890)~~
- [x] ~~BUG-004: router.ts crashes on missing tags (fixed 080d890)~~
- [x] ~~BUG-005: Hardcoded `bun run lint` in review (fixed v0.13.0 US-005)~~
- [x] ~~BUG-006: Context auto-detection (fixed v0.14.0 US-003)~~
- [x] ~~BUG-009: No cross-story regression check (fixed v0.14.0 US-002)~~
- [x] ~~BUG-010: Greenfield TDD no test files (fixed v0.14.0 US-001 + US-005)~~
- [x] ~~BUG-011: Escalation tier budget not enforced (fixed v0.14.0)~~
- [ ] BUG-008: E2E tests hang with infinite retry (needs timeout/isolation)

### Features
- [ ] `nax unlock` command
- [ ] Constitution file support
- [ ] Cost tracking dashboard
- [ ] npm publish setup
- [ ] `nax diagnose --ai` flag (LLM-assisted, future version TBD)

---

## Versioning

Sequential canary → stable: `v0.12.0-canary.0` → `canary.N` → `v0.12.0`
Canary: `npm publish --tag canary`
Stable: `npm publish` (latest)

*Last updated: 2026-02-28*
