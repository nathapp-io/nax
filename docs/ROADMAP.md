# nax Roadmap

> **Authoritative source** for planned and shipped versions.
> Specs in `memory/` are detailed references. GitLab issues are supplementary.
> Full release notes → `docs/releases/`

---

## Next: v0.15.0 — Interactive Pipeline

**Theme:** Human/AI/External interactions via plugins (pause, notify, respond, resume)
**Status:** Spec drafted
**Spec:** `memory/specs/nax-v0.15.0-interactions.md` (VPS)

**User Stories:**
- [ ] US-001: Interaction plugin interface + types
- [ ] US-002: CLI plugin (stdin, default for non-headless)
- [ ] US-003: State persistence (pause/resume with run-state.json)
- [ ] US-004: Built-in triggers (cost-warning, security-review, pre-merge, etc.)
- [ ] US-005: Telegram plugin (inline buttons + polling)
- [ ] US-006: `nax interact` CLI (list, respond, cancel)
- [ ] US-007: Webhook plugin (HTTP POST + callback server)
- [ ] US-008: Auto plugin (AI responder with confidence escalation)
- [ ] US-009: `nax status` enhancement (paused state display)

**Phases:** Core (US-001/3/4/2) → Telegram (US-005/6/9) → Advanced (US-007/8)

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
- [ ] VitePress documentation site — full CLI reference, hosted as standalone docs (pre-publish requirement)

---

## Versioning

Sequential canary → stable: `v0.12.0-canary.0` → `canary.N` → `v0.12.0`
Canary: `npm publish --tag canary`
Stable: `npm publish` (latest)

*Last updated: 2026-02-28*
