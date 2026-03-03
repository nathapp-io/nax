# nax Roadmap

> **Authoritative source** for planned and shipped versions.
> Specs in `memory/` are detailed references. GitLab issues are supplementary.
> Full release notes → `docs/releases/`

---

## Next: v0.18.0 — Orchestration Quality

**Theme:** Fix execution bugs and improve orchestration reliability
**Status:** 🔲 Planned

### Bugfixes (Priority)
- [x] ~~**BUG-016:** Hardcoded 120s timeout in verify stage → read from config~~
- [x] ~~**BUG-017:** `run.complete` not emitted on SIGTERM → emit in crash handler~~
- [x] ~~**BUG-018:** Test-writer spawns on every retry → skip when tests exist (`story.attempts > 0`)~~
- [x] ~~**BUG-019:** Misleading TIMEOUT output preview → separate TIMEOUT vs TEST_FAILURE messaging~~
- [x] ~~**BUG-020:** Missing storyId in JSONL events → audit all emitters~~
- [x] ~~**BUG-021:** `Task classified` log shows raw LLM result, not final routing after cache/config override → log final routing only~~
- [x] ~~**BUG-022:** Story interleaving wastes iterations — after failure, `getNextStory()` picks next pending story instead of retrying the failed one → prioritize current story retries before moving on~~
- [x] ~~**BUG-023:** Agent failure doesn't log exitCode/stderr → add to `execution.Agent session failed` event~~
- [x] ~~**BUG-025:** `needsHumanReview` doesn't trigger interactive plugin in headless mode → wire to interaction chain or suppress the log~~

---

## v0.18.1 — Type Safety + Per-Story testStrategy

**Theme:** Fix all TypeScript/lint errors + fine-grained test strategy control
**Status:** 🔲 Planned

### TypeScript Fixes (60 errors across 21 files)
- [ ] **TS-001:** Fix context module exports — add `BuiltContext`, `ContextElement`, `ContextBudget`, `StoryContext` to `context/types.ts` (13 errors)
- [ ] **TS-002:** Fix config/command type safety — type `{}` → proper types in `config/loader.ts`, `commands/logs.ts`, `agents/claude.ts` (12 errors)
- [ ] **TS-003:** Fix review/verification types — add `softViolations`, `warnings`, `description` to review result types (9 errors)
- [ ] **TS-004:** Fix escalation PRD type construction — ensure escalation produces valid `PRD` objects (4 errors)
- [ ] **TS-005:** Fix misc — Logger mock types, null checks, missing exports (`RectificationState`, `TestSummary`, `TestFailure`) (6 errors)

### Lint Fixes (12 errors)
- [ ] **LINT-001:** Run `biome check --fix` + manual review of unsafe fixes

### Verify Stage Fix
- [ ] **TEST-001:** Fix hanging "test command that throws error" test — add timeout or proper process kill

### Per-Story testStrategy
- [ ] Add optional `testStrategy` field to userStory PRD schema (`"test-after" | "three-session-tdd" | "three-session-tdd-lite"`)
- [ ] When set, overrides global config + task classification for that story
- [ ] Update routing stage to check `story.testStrategy` before config/LLM
- [ ] Docs + tests

### Re-enable Checks
- [ ] Re-enable `typecheck` in `nax/config.json` review checks after TS fixes land

---

## v0.18.2 — Smart Test Runner

**Theme:** Scope verify to changed files only — eliminate suite timeout issues
**Status:** 🔲 Planned

- [ ] After agent implementation, run `git diff --name-only` to get changed source files
- [ ] Map source → test files by naming convention (`src/foo/bar.ts` → `test/unit/foo/bar.test.ts`)
- [ ] Run only related tests for verify (instead of full suite)
- [ ] Fallback to full suite when mapping yields no test files
- [ ] Config flag `execution.smartTestRunner: true` (default: true) to opt out
- [ ] Result: verify drops from ~125s to ~10-20s for typical single-file fixes

---

## v0.19.0 — Central Run Registry

**Theme:** Unified run tracking across worktrees + dashboard integration
**Status:** 🔲 Planned

- [ ] **Central Run Registry** — `~/.nax/runs/<project>-<feature>-<runId>/` with status.json + events.jsonl symlink. Dashboard reads from registry.

---

## Shipped

| Version | Theme | Date | Details |
|:---|:---|:---|:---|
| v0.18.0 | Orchestration Quality | 2026-03-03 | BUG-016/017/018/019/020/021/022/023/025 all fixed |
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
- [x] ~~BUG-002: Orphan Claude processes~~
- [x] ~~BUG-003: PRD status "done" not skipped~~
- [x] ~~BUG-004: router.ts crashes on missing tags~~
- [x] ~~BUG-005: Hardcoded `bun run lint` in review~~
- [x] ~~BUG-006: Context auto-detection~~
- [x] ~~BUG-008: E2E tests hang with infinite retry~~
- [x] ~~BUG-009: No cross-story regression check~~
- [x] ~~BUG-010: Greenfield TDD no test files~~
- [x] ~~BUG-011: Escalation tier budget not enforced~~
- [x] ~~BUG-012: Greenfield detection ignores pre-existing test files~~
- [x] ~~BUG-013: Escalation routing not applied in iterations~~
- [x] ~~BUG-014: buildAllowedEnv() strips USER/LOGNAME~~
- [ ] **BUG-015:** `loadConstitution()` leaks global `~/.nax/constitution.md` into unit tests
- [x] ~~**BUG-016:** Hardcoded 120s timeout in pipeline verify stage → fixed in v0.18.0~~
- [x] ~~**BUG-017:** run.complete not emitted on SIGTERM → fixed in v0.18.0~~
- [x] ~~**BUG-018:** Test-writer wastes ~3min/retry when tests already exist → fixed in v0.18.0~~
- [x] ~~**BUG-019:** Misleading TIMEOUT output preview → fixed in v0.18.0~~
- [x] ~~**BUG-020:** Missing storyId in JSONL events → fixed in v0.18.0~~
- [x] ~~**BUG-021:** `Task classified` log shows raw LLM result, not final routing → fixed in v0.18.0~~
- [x] ~~**BUG-022:** Story interleaving — `getNextStory()` round-robins instead of exhausting retries on current story → fixed in v0.18.0~~
- [x] ~~**BUG-023:** Agent failure silent — no exitCode/stderr in JSONL → fixed in v0.18.0~~
- [x] ~~**BUG-025:** `needsHumanReview` not triggering interactive plugin → fixed in v0.18.0~~

### Features
- [x] ~~`nax unlock` command~~
- [x] ~~Constitution file support~~
- [x] ~~Per-story testStrategy override — v0.18.1~~
- [x] ~~Smart Test Runner — v0.18.2~~
- [x] ~~Central Run Registry — v0.19.0~~
- [ ] Cost tracking dashboard
- [ ] npm publish setup
- [ ] `nax diagnose --ai` flag (LLM-assisted, future TBD)
- [ ] **Auto-decompose oversized stories** — When story size gate triggers, offer via interaction chain to auto-decompose using `nax analyse`.
- [ ] **AST-based context file detection** — replace keyword-matching with import/symbol graph analysis. Target: v0.19+
- [ ] VitePress documentation site — full CLI reference, hosted as standalone docs (pre-publish requirement)

---

## Versioning

Sequential canary → stable: `v0.12.0-canary.0` → `canary.N` → `v0.12.0`
Canary: `npm publish --tag canary`
Stable: `npm publish` (latest)

*Last updated: 2026-03-03 (v0.18.0 shipped — all 9 bugs fixed)*
