# nax Roadmap

> **Authoritative source** for planned and shipped versions.
> Specs in `memory/` are detailed references. GitLab issues are supplementary.
> Full release notes → `docs/releases/`

---

## Next: v0.16.1 — Project Context Generator

**Theme:** Replace constitution generator with a proper project context system
**Status:** 🔲 Planned

**User Stories:**
- [ ] US-001: Introduce `nax/context.md` as the source for agent config generation
  - Separate from `nax/constitution.md` (nax runtime behavior only — unchanged)
  - `context.md` holds: coding standards, architecture decisions, forbidden patterns
  - `nax init` scaffolds `nax/context.md` starter template (placeholder sections)
- [ ] US-002: Auto-inject project metadata at generate time
  - Read `package.json`: project name + key dependencies (auto-detect stack)
  - Read test/lint commands from `nax/config.json` (already loaded)
  - Configurable: `generate.autoInject: true` (default) in `nax/config.json`; set `false` to skip
- [ ] US-003: `nax generate` top-level CLI command
  - `nax generate` → all agents | `--agent <name>` → specific | `--dry-run` → preview
  - Remove `nax constitution generate` entirely (no deprecation alias)
- [ ] US-004: Update all generators to accept merged `ContextContent` (manual + auto-injected)
  - `ContextContent` replaces `ConstitutionContent` in generator types

---

## v0.16.0 — Story Size Gate (SHIPPED)

**Theme:** Prevent oversized stories from burning tokens and producing low-quality output
**Status:** ✅ Shipped 2026-03-01
**Release Notes:** [releases/v0.16.0.md](releases/v0.16.0.md)

**User Stories:**
- [ ] US-001: Story size precheck gate
  - Runs during precheck phase (before any agent work)
  - Evaluates story complexity using heuristic signals:
    - Acceptance criteria count
    - Description/story text length (token estimate)
    - Number of sub-tasks or bullet points
  - Configurable thresholds in `nax/config.json` (sensible defaults TBD via experimentation)
  - Gate behavior: **Yellow (warn)** — flags via interaction chain, allows user override
  - If user skips warning → story proceeds as normal
  - If user agrees story is too large → run aborts for that story with "needs decomposition" status

**Deferred to v0.16.0:**
- [ ] **SEC-2:** Sandbox plugin import boundary
- [ ] Plugin Fallback Cascade (REL-001 from v0.15.0 review)

---

## v0.15.3 — Constitution Generator + Runner Interaction Wiring (SHIPPED)

**Theme:** Complete v0.15.x with constitution generator and live interaction wiring
**Status:** ✅ Shipped 2026-02-28
**Release Notes:** [releases/v0.15.3.md](releases/v0.15.3.md)

**Changes:**
- [x] US-010: Constitution-to-agent-config generator (`nax constitution generate`)
  - Generates CLAUDE.md, AGENTS.md, .cursorrules, .windsurfrules, .aider.conf.yml
  - 5 agent adapters from single `nax/constitution.md` source
- [x] US-008 (runner wiring): Wire interaction triggers into runner execution loop
  - Interaction chain initialized at runner startup
  - Headless mode support (skips interactions)
  - Automatic cleanup on shutdown
  - Ready for trigger integration (future versions)

---

## v0.15.1 — Architectural Compliance + Security Hardening (SHIPPED)

**Theme:** Resolve all critical findings from v0.15.0 code review
**Status:** ✅ Shipped 2026-02-28
**Release Notes:** [releases/v0.15.1.md](releases/v0.15.1.md)

**Changes:**
- [x] **ARCH-001:** Split all 14 files exceeding 400-line limit (CRITICAL)
- [x] **SEC-001:** Add payload size limit to webhook plugin (CRITICAL)
- [x] **SEC-002/003:** Add exponential backoff + proper error handling to Telegram plugin (CRITICAL)
- [x] **TEST-001:** Add network failure tests for Telegram and Webhook plugins (15 new tests)
- [x] Verify InteractionConfig Zod schema correctness (already correct, no changes)

---

## v0.15.0 — Interactive Pipeline (SHIPPED)

**Theme:** Human/AI/External interactions as hook extensions
**Status:** ✅ Shipped 2026-02-28
**Release Notes:** [releases/v0.15.0.md](releases/v0.15.0.md)
**Spec:** `memory/specs/nax-v0.15.0-interactions.md` (VPS)

**Architecture:** Interactions extend the existing hook system (not a separate config surface). Hooks gain an optional `interaction` field for two-way request/response. Plugins (telegram, webhook, cli, auto) handle transport only.

**Safety defaults:** ð´ abort (security-review, cost-exceeded, merge-conflict) | ð¡ escalate/skip (cost-warning, max-retries, pre-merge) | ð¢ continue (story-ambiguity, review-gate)

**Timeout strategy:** Plugin chain cascade with `escalate` fallback. Plugins tried in priority order; when all exhausted → abort.

**User Stories:**
- [x] US-001: Interaction plugin interface + types + plugin chain (v0.15.0 Phase 1)
- [x] US-002: CLI plugin (stdin, default for non-headless) (v0.15.0 Phase 1)
- [x] US-003: State persistence (pause/resume with run-state.json) (v0.15.0 Phase 1)
- [x] US-004: Built-in triggers + hook `interaction` field extension (v0.15.0 Phase 1)
- [x] US-005: Telegram plugin (inline buttons + polling) (v0.15.0 Phase 2)
- [x] US-006: `nax interact` CLI (list, respond, cancel) (v0.15.0 Phase 2)
- [x] US-007: Webhook plugin (HTTP POST + callback server + HMAC) (v0.15.0 Phase 2)
- [x] US-008: Auto plugin (AI responder with confidence escalation) (v0.15.0 Phase 2)
- [x] US-009: `nax status` enhancement (paused state + safety category) (v0.15.0 Phase 2)
- [x] US-010: Constitution-to-agent-config generator (CLAUDE.md, AGENTS.md, .cursorrules, etc.) (v0.15.3 — in progress)

**Phases:** Core (US-001/3/4/2) → Telegram (US-005/6/9) → Advanced (US-007/8)

---

---

## Shipped

| Version | Theme | Date | Details |
|:---|:---|:---|:---|
| v0.16.0 | Story Size Gate | 2026-03-01 | [releases/v0.16.0.md](releases/v0.16.0.md) |
| v0.15.3 | Constitution Generator + Runner Interaction Wiring | 2026-02-28 | [releases/v0.15.3.md](releases/v0.15.3.md) |
| v0.15.1 | Architectural Compliance + Security Hardening | 2026-02-28 | [releases/v0.15.1.md](releases/v0.15.1.md) |
| v0.15.0 | Interactive Pipeline | 2026-02-28 | [releases/v0.15.0.md](releases/v0.15.0.md) |
| v0.14.4 | Code Audit Cleanup (MEDIUM findings) | 2026-02-28 | [releases/v0.14.4.md](releases/v0.14.4.md) |
| v0.14.3 | Code Audit Fixes (CRITICAL+HIGH+MEDIUM) | 2026-02-28 | [releases/v0.14.3.md](releases/v0.14.3.md) |
| v0.14.2 | E2E Test Hang Fix | 2026-02-28 | [releases/v0.14.2.md](releases/v0.14.2.md) |
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
- [x] ~~BUG-008: E2E tests hang with infinite retry (fixed v0.14.2)~~
- [x] ~~BUG-009: No cross-story regression check (fixed v0.14.0 US-002)~~
- [x] ~~BUG-010: Greenfield TDD no test files (fixed v0.14.0 US-001 + US-005)~~
- [x] ~~BUG-011: Escalation tier budget not enforced (fixed v0.14.0)~~

### Features
- [ ] `nax unlock` command
- [x] ~~Constitution file support (shipped v0.15.3 US-010)~~
- [ ] Cost tracking dashboard
- [ ] npm publish setup
- [ ] `nax diagnose --ai` flag (LLM-assisted, future version TBD)
- [ ] **Auto-decompose oversized stories** — When story size gate triggers, offer via interaction chain to auto-decompose using `nax analyse`. User confirms → LLM breaks story into smaller sub-stories → updates PRD. Builds on v0.16.0 gate.
- [ ] VitePress documentation site — full CLI reference, hosted as standalone docs (pre-publish requirement)

---

## Versioning

Sequential canary → stable: `v0.12.0-canary.0` → `canary.N` → `v0.12.0`
Canary: `npm publish --tag canary`
Stable: `npm publish` (latest)

*Last updated: 2026-03-01 (v0.16.1 planned)*
