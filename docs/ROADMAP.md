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

## v0.18.1 — Type Safety + CI Pipeline ✅

**Theme:** Fix all TypeScript/lint errors, establish CI pipeline
**Status:** ✅ Shipped (2026-03-03)

### TypeScript Fixes (60 errors across 21 files)
- [x] ~~**TS-001:** Fix context module exports (13 errors)~~
- [x] ~~**TS-002:** Fix config/command type safety (12 errors)~~
- [x] ~~**TS-003:** Fix review/verification types (9 errors)~~
- [x] ~~**TS-004:** Fix escalation PRD type construction (4 errors)~~
- [x] ~~**TS-005:** Fix misc types (6 errors)~~
- [x] ~~**LINT-001:** Run biome check --fix + manual review~~

### CI Pipeline (new)
- [x] `.gitlab-ci.yml` — stages: test → release → notify
- [x] Image: `nathapp/node-bun:22.21.0-1.3.9-alpine` (test/release), `gkci/node:22.14.0-alpine-ci` (notify)
- [x] `before_script`: apk add git python3 make g++, safe.directory, git identity
- [x] Test env: `NAX_SKIP_PRECHECK=1 bun test test/ --timeout=60000`
- [x] CI skip guards for env-sensitive tests (claude binary, PID checks, subprocess integration)
- [x] Fixed `checkClaudeCLI()` ENOENT crash — try/catch around Bun.spawn
- [x] Release trigger: `[run-release]` in commit message on master
- [x] Runner requirement: 8GB shared runner (`saas-linux-small-amd64`)
- [x] **Result: 1952 pass, 56 skip, 0 fail**

---

## v0.18.2 — Smart Test Runner + Routing Fix ✅

**Theme:** Scope verify to changed files only + fix routing override
**Status:** ✅ Shipped (2026-03-03)

### Smart Test Runner
- [x] ~~After agent implementation, run `git diff --name-only` to get changed source files~~
- [x] ~~Map source → test files by naming convention (`src/foo/bar.ts` → `test/unit/foo/bar.test.ts`)~~
- [x] ~~Run only related tests for verify (instead of full suite)~~
- [x] ~~Fallback to full suite when mapping yields no test files~~
- [x] ~~Config flag `execution.smartTestRunner: true` (default: true) to opt out~~
- [x] ~~Result: verify drops from ~125s to ~10-20s for typical single-file fixes~~

### Bun PTY Migration (BUN-001)
- [ ] Replace `node-pty` (native addon, requires python/make/g++ to build) with `Bun.Terminal` API (v1.3.5+)
- [ ] Update `src/agents/claude.ts` `runInteractive()` — replace `nodePty.spawn()` with `Bun.Terminal`
- [ ] Update `src/tui/hooks/usePty.ts` — replace `IPty` interface with Bun equivalent
- [ ] Remove `node-pty` from `dependencies` in `package.json`
- [ ] Remove `--ignore-scripts` workaround from `.gitlab-ci.yml`
- [ ] Benefit: no native build, no gyp/python/gcc in CI, cleaner alpine support

### CI Memory Optimization (CI-001)
- [ ] Investigate splitting test suite into parallel jobs (unit / integration / ui) to reduce per-job peak memory
- [ ] Evaluate `bun test --shard` when stable (currently experimental)
- [ ] Target: make test suite pass on 1GB runners (currently requires 8GB shared runner)
- [ ] Known constraints: 2008 tests across 125 files, ~75s on local VPS (3.8GB), OOMs even with `--smol --concurrency 1`
- [ ] Current workaround: use `saas-linux-small-amd64` (8GB) shared runner

---

## v0.18.3 — Execution Reliability ✅

**Theme:** Fix execution pipeline bugs (escalation, routing, review), structured failure context, and Smart Runner enhancement
**Status:** ✅ Shipped (2026-03-04)
**Spec:** [docs/specs/verification-architecture-v2.md](specs/verification-architecture-v2.md) (Phase 1)

### Bugfixes — Completed
- [x] **BUG-026:** Regression gate timeout → accept scoped pass + warn (not escalate). Config: `regressionGate.acceptOnTimeout: true`.
- [x] **BUG-028:** Routing cache ignores escalation tier — `clearCacheForStory(storyId)` in `llm.ts`, called on tier escalation in both `preIterationTierCheck()` and `handleTierEscalation()`.

### Structured Failure Context — Completed
- [x] **SFC-001:** `StructuredFailure` type with `TestFailureContext[]` + `priorFailures?: StructuredFailure[]` on `UserStory`. Populated on verify, regression, rectification, and escalation failures.
- [x] **SFC-002:** Format `priorFailures` into agent prompt at priority 95 via `createPriorFailuresContext()` in `context/builder.ts`.

### Bugfixes — Completed (Round 2)
- [x] **BUG-029:** Escalation resets story to `pending` → bypasses BUG-022 retry priority. After escalation, `getNextStory()` picks the next pending story instead of retrying the escalated one. **Location:** `src/prd/index.ts:getNextStory()`. **Fix:** Recognize escalated-pending stories in Priority 1 (e.g. check `story.routing.modelTier` changed, or use `"retry-pending"` status).
- [x] **BUG-030:** Review lint/typecheck failure → hard `"fail"`, no rectification or retry. `review.ts:92` returns `{ action: "fail" }` → `markStoryFailed()` permanently. Lint errors are auto-fixable but story is killed with zero retry. **Fix:** Return `"escalate"` for lint/typecheck failures (or add review-rectification loop). Reserve `"fail"` for plugin reviewer rejection only.
- [x] **BUG-032:** Routing stage overrides escalated `modelTier` with complexity-derived tier. `routing.ts:43` always runs `complexityToModelTier()` even when `story.routing.modelTier` was set by escalation → escalated tier silently ignored. BUG-013 fix (`applyCachedRouting`) runs too late. **Fix:** Skip `complexityToModelTier()` when `story.routing.modelTier` is explicitly set.

### STR-007: Smart Test Runner Enhancement — Completed
- [x] Configurable `testFilePatterns` in config (default: `test/**/*.test.ts`)
- [x] `testFileFallback` config option: `"import-grep"` | `"full-suite"` (default: `"import-grep"`)
- [x] 3-pass test discovery: path-convention → import-grep (grep test files for changed module name) → full-suite
- [x] Config schema update: `execution.smartTestRunner` becomes object `{ enabled, testFilePatterns, fallback }` (backward compat: boolean coerced)

---

## v0.18.4 — Routing Stability ✅

**Theme:** Fix routing classifier consistency and LLM routing reliability
**Status:** ✅ Shipped (2026-03-04)

### Bugfixes
- [x] **BUG-031:** Keyword fallback classifier gives inconsistent strategy across retries for same story. `priorErrors` text shifts keyword classification. **Fix:** Keyword classifier should only use original story fields; or lock `story.routing.testStrategy` once set.
- [x] **BUG-033:** LLM routing has no retry on timeout — single 15s attempt, then keyword fallback. **Fix:** Add `routing.llm.retries` config (default: 1) with backoff. Raise default timeout to 30s for batch routing.

---

## v0.18.5 — Bun PTY Migration ✅

**Theme:** Remove native `node-pty` dependency, Bun-native subprocess for agent sessions
**Status:** ✅ Shipped (2026-03-04)
**Spec:** [docs/specs/bun-pty-migration.md](specs/bun-pty-migration.md)

### BUN-001: Replace node-pty with Bun.spawn
- [x] Research gate: verify `Bun.Terminal` availability on Bun 1.3.9; confirm Claude Code works with piped stdio
- [ ] `src/agents/claude.ts` `runInteractive()` — replace `nodePty.spawn()` with `Bun.spawn` (piped stdio)
- [ ] `src/tui/hooks/usePty.ts` — replace `pty.IPty` state with `Bun.Subprocess`
- [ ] `src/agents/types.ts` — remove `IPty` dependency from `PtyHandle` interface
- [ ] `package.json` — remove `node-pty` from dependencies
- [ ] `.gitlab-ci.yml` — remove `python3 make g++` from `apk add`; remove `--ignore-scripts` from `bun install`

---

## v0.21.0 — Process Reliability & Observability

**Theme:** Kill orphan processes cleanly, fix lint/typecheck auto-repair, structured heartbeat & log improvements
**Status:** 🔲 Planned

### Process Lifecycle (BUG-039)
- [ ] **BUG-039:** Orphan processes on abort/timeout — `bun test`, `bun run lint`, `bun run typecheck`, LLM routing calls, and Claude agent sessions are not killed when nax exits or story fails. Use process groups (`Bun.spawn` `{detached: false}`) + kill on SIGTERM/SIGINT. Track all child PIDs in a run registry; sweep on run-end.

### Lint/Typecheck Auto-Repair (BUG-040)
- [ ] **BUG-040:** Story fails on trivial lint error → escales to next tier instead of auto-fixing. Root: `review.ts` returns `{ action: "fail" }` for lint/typecheck failures (BUG-030 pattern). Fix: add a review-rectification loop — give agent one retry with full lint/typecheck output; only escalate if retry fails. Reserve `"fail"` for unfixable failures.

### Smart Test Runner — Git-History Mode (FEAT-010)
- [ ] **FEAT-010:** Replace `git diff --name-only HEAD~1` heuristic with branch-vs-baseline comparison. Track `baseCommitHash` per story in `status.json` at story start; on verify, diff `HEAD` vs `baseCommitHash`. Survives multi-commit agent sessions and rebases. Config: `smartTestRunner.mode: "git-diff" | "git-history"`.

### File Context Strategy (FEAT-011)
- [ ] **FEAT-011:** Clarify and document file context injection behaviour. Currently injects full file content — evaluate switching to relative path only for large files (>N lines), with full content only for files <500 lines. Add `context.fileContext.maxInlineLines` config (default: 500).

### TDD Test Writer Tier (FEAT-012)
- [ ] **FEAT-012:** Test writer tier — currently uses `tdd.sessionTiers.testWriter` (default `balanced`). Evaluate whether test writer needs to be same tier as implementer or can stay lower. Risk: if test writer uses `fast` and implementer uses `powerful`, the tests may be too shallow to catch regressions. Recommendation: test writer tier should be ≥ implementer tier for the same story. Add validation/warning.

### Cross-Story Test Isolation (BUG-041)
- [ ] **BUG-041:** Failing test from story N bleeds into story N+1 verification — smart runner may pick up the same test file, masking whether story N+1 actually caused the failure. Fix: after each story's verify pass, record passing test list; flag regressions introduced by the current story only.

### Test-After Strategy Review (FEAT-013)
- [ ] **FEAT-013:** `test-after` strategy is reportedly fragile — agent writes code first, then tests, leaving a window where broken tests pass verify. Consider deprecating `test-after` in favour of `tdd-lite` as default, or adding a post-write strict isolation verify that ensures tests were not written to match broken code.

### Structured Log & Heartbeat (FEAT-014)
- [ ] **FEAT-014:** Add structured progress heartbeat to `nax logs --follow` and `status.json`. Show current story, current stage, elapsed time, pass/fail counts, and cost so far. Heartbeat line emitted every N seconds (config: `logging.heartbeatIntervalSeconds`, default: 30). Useful for long runs without terminal access.

### Verifier Test Failure Capture (BUG-042)
- [ ] **BUG-042:** Full suite knows pass/fail counts but verifier (`verify.ts`) does not surface them in failure context passed to rectification. `parseBunTestOutput()` is called in `run-regression.ts` but not in the per-story verify path. Fix: call `parseBunTestOutput()` in `verify.ts` on failure; attach structured `TestFailure[]` to `VerificationResult` and forward to rectification loop and `priorFailures`.

---

## v0.20.0 — Verification Architecture v2 ✅

**Theme:** Eliminate duplicate test runs, deferred regression gate, structured escalation context
**Status:** ✅ Shipped (2026-03-06)
**Spec:** [docs/specs/verification-architecture-v2.md](specs/verification-architecture-v2.md)

### Shipped
- [x] Pipeline verify stage is single test execution point (Smart Test Runner)
- [x] Removed scoped re-test in `post-verify.ts` (duplicate eliminated)
- [x] Review stage: typecheck + lint only — `checks: ["typecheck", "lint"]`
- [x] Deferred regression gate — `src/execution/lifecycle/run-regression.ts`
- [x] Reverse Smart Test Runner mapping: test → source → responsible story
- [x] Targeted rectification per story with full failure context
- [x] `regressionGate.mode: "deferred" | "per-story" | "disabled"` config
- [x] `maxRectificationAttempts` config (default: 2)
- [x] BUG-037: verify output shows last 20 lines (failures, not prechecks)

---

## v0.19.0 — Hardening & Compliance ✅

**Theme:** Security hardening, _deps injection pattern, Node.js API removal
**Status:** ✅ Shipped (2026-03-04)
**Spec:** [docs/specs/verification-architecture-v2.md](specs/verification-architecture-v2.md) (Phase 2)

### Shipped
- [x] Pipeline verify stage is the single test execution point (Smart Test Runner)
- [x] Remove scoped re-test in `post-verify.ts` (duplicate of pipeline verify)
- [x] Review stage runs typecheck + lint only — remove `review.commands.test` execution
- [x] `priorFailures` injected into escalated agent prompts via `context/builder.ts`
- [x] Reverse file mapping for regression attribution

### Central Run Registry (carried forward)
- [ ] `~/.nax/runs/<project>-<feature>-<runId>/` with status.json + events.jsonl symlink

---

## Shipped

| Version | Theme | Date | Details |
|:---|:---|:---|:---|
| v0.18.1 | Type Safety + CI Pipeline | 2026-03-03 | 60 TS errors + 12 lint errors fixed, GitLab CI green (1952/56/0) |
| v0.20.0 | Verification Architecture v2 | 2026-03-06 | Deferred regression gate, remove duplicate tests, BUG-037 |
| v0.19.0 | Hardening & Compliance | 2026-03-04 | SEC-1 to SEC-5, BUG-1, Node.js API removal, _deps rollout |
| v0.18.5 | Bun PTY Migration | 2026-03-04 | BUN-001: node-pty → Bun.spawn, CI cleanup, flaky test fix |
| v0.18.4 | Routing Stability | 2026-03-04 | BUG-031 keyword drift, BUG-033 LLM retry, pre-commit hook |
| v0.18.3 | Execution Reliability + Smart Runner | 2026-03-04 | BUG-026/028/029/030/032 + SFC-001/002 + STR-007, all items complete |
| v0.18.2 | Smart Test Runner + Routing Fix | 2026-03-03 | FIX-001 + STR-001–006, 2038 pass/11 skip/0 fail |
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
- [x] ~~**BUG-015:** `loadConstitution()` leaks global `~/.nax/constitution.md` into unit tests — fixed via `skipGlobal: true` in all unit tests~~
- [x] ~~**BUG-027:** `runPrecheck()` always prints to stdout — pollutes test output when called programmatically. Shipped in v0.18.2.~~
- [x] ~~**BUG-028:** Routing cache ignores escalation tier — escalated stories re-run at original tier. Shipped in v0.18.3.~~
- [x] ~~**BUG-016:** Hardcoded 120s timeout in pipeline verify stage → fixed in v0.18.0~~
- [x] ~~**BUG-017:** run.complete not emitted on SIGTERM → fixed in v0.18.0~~
- [x] ~~**BUG-018:** Test-writer wastes ~3min/retry when tests already exist → fixed in v0.18.0~~
- [x] ~~**BUG-019:** Misleading TIMEOUT output preview → fixed in v0.18.0~~
- [x] ~~**BUG-020:** Missing storyId in JSONL events → fixed in v0.18.0~~
- [x] ~~**BUG-021:** `Task classified` log shows raw LLM result, not final routing → fixed in v0.18.0~~
- [x] ~~**BUG-022:** Story interleaving — `getNextStory()` round-robins instead of exhausting retries on current story → fixed in v0.18.0~~
- [x] ~~**BUG-023:** Agent failure silent — no exitCode/stderr in JSONL → fixed in v0.18.0~~
- [x] ~~**BUG-025:** `needsHumanReview` not triggering interactive plugin → fixed in v0.18.0~~

- [x] **BUG-029:** Escalation resets story to `pending` → bypasses BUG-022 retry priority. `handleTierEscalation()` sets `status: "pending"` after escalation, but `getNextStory()` Priority 1 only checks `status === "failed"`. Result: after BUG-026 escalated (iter 1), nax moved to BUG-028 (iter 2) instead of retrying BUG-026 immediately. **Location:** `src/prd/index.ts:getNextStory()` + `src/execution/escalation/tier-escalation.ts`. **Fix:** `getNextStory()` should also prioritize stories with `story.routing.modelTier` that changed since last attempt (escalation marker), or `handleTierEscalation` should use a distinct status like `"retry-pending"` that Priority 1 recognizes.
- [x] **BUG-030:** Review lint failure → hard `"fail"`, no rectification or retry. `src/pipeline/stages/review.ts:92` returns `{ action: "fail" }` for all review failures including lint. In `pipeline-result-handler.ts`, `"fail"` calls `markStoryFailed()` — permanently dead. But lint errors are auto-fixable (agent can run `biome check --fix`). Contrast with verify stage which returns `"escalate"` on test failure, allowing retry. SFC-001 and SFC-002 both hit this — tests passed but 5 Biome lint errors killed the stories permanently. **Fix:** Review stage should return `"escalate"` (not `"fail"`) for lint/typecheck failures, or add a review-rectification loop (like verify has) that gives the agent one retry with the lint output as context. Reserve `"fail"` for unfixable review issues (e.g. plugin reviewer rejection).
- [x] **BUG-031:** Keyword fallback classifier gives inconsistent strategy across retries for same story. BUG-026 was classified as `test-after` on iter 1 (keyword fallback), but `three-session-tdd-lite` on iter 5 (same keyword fallback). The keyword classifier in `src/routing/strategies/keyword.ts:classifyComplexity()` may be influenced by `priorErrors` text added between attempts, shifting the keyword match result. **Location:** `src/routing/strategies/keyword.ts`. **Fix:** Keyword classifier should only consider the story's original title + description + acceptance criteria, not accumulated `priorErrors` or `priorFailures`. Alternatively, once a strategy is set in `story.routing.testStrategy`, the routing stage should preserve it across retries (already partially done in `routing.ts:40-41` but may not apply when LLM falls back to keyword).
- [x] **BUG-032:** Routing stage overrides escalated `modelTier` with complexity-derived tier. `src/pipeline/stages/routing.ts:43` always runs `complexityToModelTier(routing.complexity, config)` even when `story.routing.modelTier` was explicitly set by `handleTierEscalation()`. BUG-026 was escalated to `balanced` (logged in iteration header), but `Task classified` shows `modelTier=fast` because `complexityToModelTier("simple", config)` → `"fast"`. Related to BUG-013 (escalation routing not applied) which was marked fixed, but the fix in `applyCachedRouting()` in `pipeline-result-handler.ts:295-310` runs **after** the routing stage — too late. **Location:** `src/pipeline/stages/routing.ts:43`. **Fix:** When `story.routing.modelTier` is explicitly set (by escalation), skip `complexityToModelTier()` and use the cached tier directly. Only derive from complexity when `story.routing.modelTier` is absent.
- [x] **BUG-033:** LLM routing has no retry on timeout — single attempt with hardcoded 15s default. All 5 LLM routing attempts in the v0.18.3 run timed out at 15s, forcing keyword fallback every time. `src/routing/strategies/llm.ts:63` reads `llmConfig?.timeoutMs ?? 15000` but there's no retry logic — one timeout = immediate fallback. **Location:** `src/routing/strategies/llm.ts:callLlm()`. **Fix:** Add `routing.llm.retries` config (default: 1) with backoff. Also surface `routing.llm.timeoutMs` in `nax config --explain` and consider raising default to 30s for batch routing which processes multiple stories.

- [ ] **BUG-037:** Test output summary (verify stage) captures precheck boilerplate instead of actual `bun test` failure. **Symptom:** Logs show successful prechecks (Head) instead of failed tests (Tail). **Fix:** Change `Test output preview` log to tail the last 20 lines of output instead of heading the first 10.
- [ ] **BUG-038:** `smart-runner` over-matching when global defaults change. **Symptom:** Changing `DEFAULT_CONFIG` matches broad integration tests that fail due to environment/precheck side effects, obscuring targeted results. **Fix:** Refine path mapping to prioritize direct unit tests and exclude known heavy integration tests from default smart-runner matches unless explicitly relevant.
### Features
- [x] ~~`nax unlock` command~~
- [x] ~~Constitution file support~~
- [x] ~~Per-story testStrategy override — v0.18.1~~
- [x] ~~Smart Test Runner — v0.18.2~~
- [x] ~~Central Run Registry — v0.19.0~~
- [ ] **BUN-001:** Bun PTY Migration — replace `node-pty` with `Bun.Terminal` API
- [ ] **CI-001:** CI Memory Optimization — parallel test sharding for 1GB runners
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

*Last updated: 2026-03-06 (v0.20.0 shipped; v0.21.0: Process Reliability & Observability planned — BUG-039..042, FEAT-010..014)*
