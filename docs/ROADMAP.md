# nax Roadmap

> **Authoritative source** for planned and shipped versions.
> Specs in `memory/` are detailed references. GitLab issues are supplementary.
> Full release notes → `docs/releases/`

---

## Next: v0.18.0 — Orchestration Quality

**Theme:** Fix execution bugs and improve orchestration reliability
**Status:** 🔲 Planned

### Bugfixes (Priority)
- [ ] **BUG-016:** Hardcoded 120s timeout in verify stage → read from config
- [ ] **BUG-017:** `run.complete` not emitted on SIGTERM → emit in crash handler
- [ ] **BUG-018:** Test-writer spawns on every retry → skip when tests exist (`story.attempts > 0`)
- [ ] **BUG-019:** Misleading TIMEOUT output preview → separate TIMEOUT vs TEST_FAILURE messaging
- [ ] **BUG-020:** Missing storyId in JSONL events → audit all emitters
- [ ] **BUG-021:** `Task classified` log shows raw LLM result, not final routing after cache/config override → log final routing only
- [ ] **BUG-022:** Story interleaving wastes iterations — after failure, `getNextStory()` picks next pending story instead of retrying the failed one → prioritize current story retries before moving on
- [ ] **BUG-023:** Agent failure doesn't log exitCode/stderr → add to `execution.Agent session failed` event
- [ ] **BUG-025:** `needsHumanReview` doesn't trigger interactive plugin in headless mode → wire to interaction chain or suppress the log

### Features
- [ ] **Per-story testStrategy override in PRD** — add optional `testStrategy` field to userStory schema (`"test-after" | "three-session-tdd" | "three-session-tdd-lite"`). When set, overrides config + task classification for that story. Enables fine-grained control without changing global config.
- [ ] **Smart Test Runner** — detect changed files → scope verify to related tests only (like `jest --findRelatedTests`). Eliminates full-suite timeout issues.
- [ ] **Central Run Registry** — `~/.nax/runs/<project>-<feature>-<runId>/` with status.json + events.jsonl symlink. Dashboard reads from registry.

---

---

## v0.16.4 — Bugfixes: Routing + Env Allowlist (SHIPPED)

**Theme:** Fix routing bugs and macOS auth failure
**Status:** ✅ Shipped 2026-03-02

**Changes:**
- [x] **BUG-012:** Greenfield detection ignores pre-existing test files (fixed: skip test-writer when tests exist)
- [x] **BUG-013:** Escalation routing not applied across iterations (fixed: create routing object when missing)
- [x] **BUG-014:** `buildAllowedEnv()` strips `USER`/`LOGNAME` — breaks macOS Keychain OAuth lookup for Claude Code (fixed: added to essentialVars)

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
| v0.17.0 | Config Management | 2026-03-02 | CM-001 --explain, CM-002 --diff, CM-003 default view |
| v0.16.4 | Bugfixes: Routing + Env Allowlist | 2026-03-02 | BUG-012/013/014 |
| v0.16.1 | Project Context Generator | 2026-03-01 | `nax generate`, auto-inject, multi-language |
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
- [x] ~~BUG-012: Greenfield detection ignores pre-existing test files (fixed v0.16.4)~~
- [x] ~~BUG-013: Escalation routing not applied in iterations (fixed v0.16.4)~~
- [x] ~~BUG-014: buildAllowedEnv() strips USER/LOGNAME, breaks macOS Keychain auth (fixed v0.16.4)~~
- [ ] **BUG-015:** `loadConstitution()` leaks global `~/.nax/constitution.md` into unit tests — `constitution.test.ts` tests expecting null get content instead because `skipGlobal` defaults to false. Hotfix: add `skipGlobal: true` to test configs (applied in worktree `feat/v0.17.0-config-management`, **verify passes after merge**)
- [ ] **BUG-016:** Pipeline verify stage (`src/pipeline/stages/verify.ts:55`) hardcodes `timeoutSeconds: 120` instead of reading `ctx.config.execution.verificationTimeoutSeconds` (default 300). Causes TIMEOUT on large test suites (500+ tests) even when config allows 300s. Root cause of all outer verify failures in v0.17.0 dogfood run. **Fix: one-line change** — replace `120` with `ctx.config.execution.verificationTimeoutSeconds`.
- [ ] **BUG-017:** `run.complete` event not emitted on SIGTERM — crash handler shuts down cleanly but skips writing the final run summary event. Per-session costs ARE correctly recorded in `agent.complete` events ($1.39 for Run 1). No aggregate cost summary in JSONL when nax is killed. Fix: emit `run.complete` in SIGTERM handler before exit.
- [ ] **BUG-018:** Test-writer session spawned on every retry even when tests already exist — BUG-012 detection fires ("tests already exist, skipping") but still costs ~3 min per spawn. Cache `testsExist` flag per-story to skip test-writer entirely on subsequent iterations. Wasted ~24 min across dogfood runs.
- [ ] **BUG-019:** Misleading verify output on TIMEOUT — when `exitCode === TIMEOUT`, nax logs truncated stdout (e.g., precheck JSON mid-run) as "Test output preview", making it look like the failure cause. Should log clear diagnostic: "Test suite exceeded timeout (Ns). Consider increasing `fullSuiteTimeoutSeconds`."
- [ ] **BUG-020:** Missing `storyId` in JSONL events — many events (agent.start, agent.complete, verify) have empty storyId, making automated per-story analysis difficult.

### Features
- [x] ~~`nax unlock` command (shipped v0.16.1 dogfood run 2026-03-01)~~
- [x] ~~Constitution file support (shipped v0.15.3 US-010)~~
- [ ] **Smart Test Runner** — nax detects which test files are related to changed source files (like `jest --findRelatedTests`) and scopes `verify` to only those tests. Eliminates full-suite timeout issues and speeds up verify significantly. Target: v0.18.x
- [ ] **Central Run Registry** — nax writes run state to `~/.nax/runs/<project>-<feature>-<runId>/` (status.json + events.jsonl symlink) on every run start, regardless of worktree vs main repo. Dashboard reads from `~/.nax/runs/` — solves two problems: (1) worktree runs invisible to dashboard, (2) no stable pointer to active JSONL. Target: v0.18.0
- [ ] Cost tracking dashboard
- [ ] npm publish setup
- [ ] `nax diagnose --ai` flag (LLM-assisted, future version TBD)
- [ ] **Auto-decompose oversized stories** — When story size gate triggers, offer via interaction chain to auto-decompose using `nax analyse`. User confirms → LLM breaks story into smaller sub-stories → updates PRD. Builds on v0.16.0 gate.
- [ ] **AST-based context file detection** — replace keyword-matching auto-detect with import/symbol graph analysis. Current keyword matcher selects wrong files (e.g., `parallel.ts` instead of `sequential-executor.ts` for sequential execution bugs). AST approach: parse imports, find files that reference symbols mentioned in the story description. Falls back to keyword matching for non-TS projects. Target: v0.19+
- [ ] VitePress documentation site — full CLI reference, hosted as standalone docs (pre-publish requirement)

### Bugs (Found via Dogfooding)
- [x] ~~BUG-012: Greenfield detection ignores pre-existing test files (fixed v0.16.4)~~
- [x] ~~BUG-013: Escalation routing not applied in iterations (fixed v0.16.4)~~
- [x] ~~BUG-014: buildAllowedEnv() strips USER/LOGNAME (fixed v0.16.4)~~
- [ ] **BUG-016:** Hardcoded 120s timeout in pipeline verify stage → target v0.18.0
- [ ] **BUG-017:** run.complete not emitted on SIGTERM → target v0.18.0
- [ ] **BUG-018:** Test-writer wastes ~3min/retry when tests already exist → target v0.18.0
- [ ] **BUG-019:** Misleading TIMEOUT output preview → target v0.18.0
- [ ] **BUG-020:** Missing storyId in JSONL events → target v0.18.0
- [ ] **BUG-021:** `Task classified` log shows raw LLM result, not final routing → target v0.18.0
- [ ] **BUG-022:** Story interleaving — `getNextStory()` round-robins instead of exhausting retries on current story → target v0.18.0
- [ ] **BUG-023:** Agent failure silent — no exitCode/stderr in JSONL → target v0.18.0
- [ ] **BUG-025:** `needsHumanReview` not triggering interactive plugin → target v0.18.0

---

## Versioning

Sequential canary → stable: `v0.12.0-canary.0` → `canary.N` → `v0.12.0`
Canary: `npm publish --tag canary`
Stable: `npm publish` (latest)

*Last updated: 2026-03-02 (v0.17.0 shipped; BUG-016–020 from dogfood run added)*
