# nax Roadmap

> **Authoritative source** for planned and shipped versions.
> Specs in `memory/` are detailed references. GitLab issues are supplementary.
> Full release notes → `docs/releases/`

---

## v0.18.0 — Orchestration Quality ✅

**Theme:** Fix execution bugs and improve orchestration reliability
**Status:** ✅ Shipped (2026-03-03)

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
- [x] ~~Replace `node-pty` with `Bun.spawn` (piped stdio) — shipped in v0.18.5~~


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
- [x] ~~All sub-items complete — `claude.ts` + `usePty.ts` migrated to `Bun.spawn`, `node-pty` removed from `package.json`, CI cleaned up~~

---

## v0.23.0 — Status File Consolidation ✅

**Theme:** Auto-write status.json to well-known paths, align readers, remove dead options
**Status:** ✅ Shipped (2026-03-07)
**Spec:** [docs/specs/status-file-consolidation.md](specs/status-file-consolidation.md)
**Pre-requisite for:** v0.24.0 (Central Run Registry)

### Stories
- [x] ~~**SFC-001:** Auto-write project-level status — remove `--status-file` flag, always write to `<workdir>/nax/status.json`~~
- [x] ~~**BUG-043:** Fix scoped test command construction + add `testScoped` config with `{{files}}` template~~
- [x] ~~**BUG-044:** Log scoped and full-suite test commands at info level in verify stage~~
- [x] ~~**SFC-002:** Write feature-level status on run end — copy final snapshot to `<workdir>/nax/features/<feature>/status.json`~~
- [x] ~~**SFC-003:** Align status readers — `nax status` + `nax diagnose` read from correct paths~~
- [x] ~~**SFC-004:** Clean up dead code — remove `--status-file` option, `.nax-status.json` references~~

---


## v0.28.0 — Prompt Builder

**Theme:** Unified, user-overridable prompt architecture replacing 11 scattered functions
**Status:** 🔲 Planned
**Spec:** `nax/features/prompt-builder/prd.json`

### Stories
- [ ] **PB-001:** PromptBuilder class with layered section architecture + fluent API
- [ ] **PB-002:** Typed sections: isolation, role-task, story, verdict, conventions
- [ ] **PB-003:** Default templates + user override loader + config schema (`prompts.overrides`)
- [ ] **PB-004:** Migrate all 6 user-facing prompt call sites to PromptBuilder
- [ ] **PB-005:** Document `prompts` config in `nax config --explain` + precheck validation

---

## v0.27.1 — Pipeline Observability ✅ Shipped (2026-03-08)

**Theme:** Fix redundant verify stage + improve pipeline skip log messages
**Status:** ✅ Shipped (2026-03-08)

### Bugfixes
- [x] **BUG-054:** Skip pipeline verify stage when TDD full-suite gate already passed — `runFullSuiteGate()` now returns `boolean`, propagated via `ThreeSessionTddResult` → `executionStage` → `ctx.fullSuiteGatePassed` → `verifyStage.enabled()` returns false with reason "not needed (full-suite gate already passed)"
- [x] **BUG-055:** Pipeline skip messages now differentiate "not needed" from "disabled". Added optional `skipReason(ctx)` to `PipelineStage` interface; `rectify`, `autofix`, `regression`, `verify` stages all provide context-aware reasons

## v0.27.0 — Review Quality ✅ Shipped (2026-03-08)

**Theme:** Fix review stage reliability — dirty working tree false-positive, stale precheck, dead config fields
**Status:** ✅ Shipped (2026-03-08)
**Spec:** `nax/features/review-quality/prd.json`

### Stories
- [x] **RQ-001:** Assert clean working tree before running review typecheck/lint (BUG-049)
- [x] **RQ-002:** Fix `checkOptionalCommands` precheck to use correct config resolution path (BUG-050)
- [x] **RQ-003:** Consolidate dead `quality.commands.typecheck/lint` into review resolution chain (BUG-051)

---

## v0.26.0 — Routing Persistence ✅ Shipped (2026-03-08)

- **RRP-001:** Persist initial routing classification to `prd.json` on first classification
- **RRP-002:** Add `initialComplexity` to `StoryRouting` and `StoryMetrics` for accurate reporting
- **RRP-003:** Add `contentHash` to `StoryRouting` for staleness detection — stale cached routing is re-classified
- **RRP-004:** Unit tests for routing persistence, idempotence, staleness, content hash, metrics
- **BUG-052:** Replace `console.warn` with structured JSONL logger in `review/runner.ts` and `optimizer/index.ts`

---

## v0.25.0 — Trigger Completion ✅ Shipped (2026-03-07)

**Theme:** Wire all 8 unwired interaction triggers, 3 missing hook events, and add plugin integration tests
**Status:** ✅ Shipped (2026-03-07)
**Spec:** [docs/specs/trigger-completion.md](specs/trigger-completion.md)

### Stories
- [x] **TC-001:** Wire `cost-exceeded` + `cost-warning` triggers — fire at 80%/100% of cost limit in sequential-executor.ts
- [x] **TC-002:** Wire `max-retries` trigger — fire on permanent story failure via `story:failed` event in wireInteraction
- [x] **TC-003:** Wire `security-review`, `merge-conflict`, `pre-merge` triggers — review rejection, git conflict detection, pre-completion gate
- [x] **TC-004:** Wire `story-ambiguity` + `review-gate` triggers — ambiguity keyword detection, per-story human checkpoint
- [x] **TC-005:** Wire missing hook events — `on-resume`, `on-session-end`, `on-error` to pipeline events
- [x] **TC-006:** Auto plugin + Telegram + Webhook integration tests — mock LLM/network, cover approve/reject/HMAC flows

---

## v0.24.0 — Central Run Registry ✅

**Theme:** Global run index across all projects — single source of truth for all nax run history
**Status:** ✅ Shipped (2026-03-07)
**Spec:** [docs/specs/central-run-registry.md](specs/central-run-registry.md)

### Stories
- [x] ~~**CRR-000:** `src/pipeline/subscribers/events-writer.ts` — `wireEventsWriter()`, writes lifecycle events to `~/.nax/events/<project>/events.jsonl` (machine-readable completion signal for watchdog/CI)~~
- [x] ~~**CRR-001:** `src/pipeline/subscribers/registry.ts` — `wireRegistry()` subscriber, listens to `run:started`, writes `~/.nax/runs/<project>-<feature>-<runId>/meta.json` (path pointers only — no data duplication, no symlinks)~~
- [x] ~~**CRR-002:** `src/commands/runs.ts` — `nax runs` CLI, reads `meta.json` → resolves live `status.json` from `statusPath`, displays table (project, feature, status, stories, duration, date). Filters: `--project`, `--last`, `--status`~~
- [x] ~~**CRR-003:** `nax logs --run <runId>` — resolve run from global registry via `eventsDir`, stream logs from any directory~~

---

## v0.21.0 — Process Reliability & Observability ✅

**Theme:** Kill orphan processes cleanly, smart-runner precision, test strategy quality
**Status:** ✅ Shipped (2026-03-06)

### Shipped
- [x] **BUG-039 (simple):** Timeouts for review/runner.ts lint/typecheck, git.ts, executor.ts timer leak
- [x] **BUG-039 (medium):** runOnce() SIGKILL follow-up + pidRegistry.unregister() in finally; LLM stream drain (stdout/stderr cancel) before proc.kill() on timeout
- [x] **FEAT-010:** baseRef tracking — capture HEAD per attempt, `git diff <baseRef>..HEAD` in smart-runner (precise, no cross-story pollution)
- [x] **FEAT-011:** Path-only context for oversized files (>10KB) — was silently dropped, now agent gets a path hint
- [x] **FEAT-013:** Deprecated `test-after` from auto routing — simple/medium stories now default to `three-session-tdd-lite`
- [x] ~~**BUG-041:**~~ Won't fix — superseded by FEAT-010
- [x] ~~**FEAT-012:**~~ Won't fix — balanced tier sufficient for test-writer

### → v0.22.1 Pipeline Re-Architecture ✅ Shipped (2026-03-07)
**ADR:** [docs/adr/ADR-005-pipeline-re-architecture.md](adr/ADR-005-pipeline-re-architecture.md)
**Plan:** [docs/adr/ADR-005-implementation-plan.md](adr/ADR-005-implementation-plan.md)

**Theme:** Eliminate ad-hoc orchestration, consolidate 4 scattered verification paths into single orchestrator, add event-bus-driven hooks/plugins/interaction, new stages (rectify, autofix, regression), post-run pipeline SSOT.

- [x] **Phase 1:** VerificationOrchestrator + Pipeline Event Bus (additive, no behavior change)
- [x] **Phase 2:** New stages — `rectify`, `autofix`, `regression` + `retry` stage action
- [x] **Phase 3:** Event-bus subscribers for hooks, reporters, interaction (replace 20+ scattered call sites)
- [x] **Phase 5:** Post-run pipeline SSOT — `deferred-regression` stage, tier escalation into `iteration-runner`, `runAcceptanceLoop` → `runPipeline(postRunPipeline)`

**Resolved:**
- [x] **BUG-040:** Lint/typecheck auto-repair → `autofix` stage + `quality.commands.lintFix/formatFix`
- [x] **BUG-042:** Verifier failure capture → unified `VerifyResult` with `failures[]` always populated
- [x] **FEAT-014:** Heartbeat observability → Pipeline Event Bus with typed events
- [x] **BUG-026:** Regression gate triggers full retry → targeted `rectify` stage with `retry` action
- [x] **BUG-028:** Routing cache ignores escalation tier → cache key includes tier

**Test results:** 2264 pass, 12 skip, 1 fail (pre-existing disk space flaky)

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

---

## Shipped

| Version | Theme | Date | Details |
|:---|:---|:---|:---|
| v0.27.1 | Pipeline Observability | 2026-03-08 | BUG-054: skip redundant verify after full-suite gate; BUG-055: differentiate skip reasons |
| v0.26.0 | Routing Persistence | 2026-03-08 | RRP-001–004: persist initial routing, initialComplexity, contentHash staleness detection, unit tests; BUG-052: structured logger in review/optimizer |
| v0.25.0 | Trigger Completion | 2026-03-07 | TC-001–004: run.complete event, crash recovery, headless formatter, trigger completion |
| v0.24.0 | Central Run Registry | 2026-03-07 | CRR-000–003: events writer, registry, nax runs CLI, nax logs --run global resolution |
| v0.23.0 | Status File Consolidation | 2026-03-07 | SFC-001–004: auto-write status.json, feature-level status, align readers, remove dead code; BUG-043/044: testScoped config + command logging |
| v0.18.1 | Type Safety + CI Pipeline | 2026-03-03 | 60 TS errors + 12 lint errors fixed, GitLab CI green (1952/56/0) |
| v0.22.2 | Routing Stability + SFC-001 | 2026-03-07 | BUG-040 floating outputPromise crash on LLM timeout retry; SFC-001 auto-write status.json |
| v0.22.1 | Pipeline Re-Architecture | 2026-03-07 | VerificationOrchestrator, EventBus, new stages (rectify/autofix/regression/deferred-regression), post-run SSOT. 2264 pass |
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
- [x] ~~**BUG-029:** Escalation resets story to `pending`. Fixed.~~
- [x] ~~**BUG-030:** Review lint failure resets. Fixed.~~
- [x] ~~**BUG-031:** Keyword fallback classifier inconsistency. Fixed.~~
- [x] ~~**BUG-032:** Routing stage overrides escalated modelTier. Fixed.~~
- [x] ~~**BUG-033:** LLM routing timeout/retry. Fixed.~~
- [x] ~~**BUG-037:** Test output summary (verify stage) tail. Fixed.~~
- [x] ~~**BUG-038:** smart-runner over-matching. Fixed.~~
- [x] ~~**BUG-043:** Scoped test command construction. Fixed.~~
- [x] ~~**BUG-044:** Scoped/full-suite test command logging. Fixed.~~
- [x] ~~**BUG-049:** Review typecheck runs on dirty working tree. Fixed in v0.27.0.~~
- [x] ~~**BUG-050:** `checkOptionalCommands` precheck uses legacy config fields. Fixed in v0.27.0.~~
- [x] ~~**BUG-051:** `quality.commands.typecheck/lint` are dead config. Fixed in v0.27.0.~~
- [x] ~~**BUG-052:** `console.warn` in runtime pipeline code bypasses JSONL logger. Fixed in v0.26.0.~~
- [x] ~~**BUG-054:** Redundant scoped verify after TDD full-suite gate passes. Fixed in v0.27.1.~~ When rectification gate runs full test suite and passes, the pipeline verify stage re-runs scoped tests (subset). **Fix:** Skip verify if full-suite gate already passed.
- [x] ~~**BUG-055:** Pipeline skip messages conflate "not needed" with "disabled". Fixed in v0.27.1.~~ `runner.ts:54` logs "skipped (disabled)" for all stages where `enabled()` returns false, even if just because tests passed. **Fix:** Differentiate log message.

### Features
- [x] ~~`nax unlock` command~~
- [x] ~~Constitution file support~~
- [x] ~~Per-story testStrategy override — v0.18.1~~
- [x] ~~Smart Test Runner — v0.18.2~~
- [ ] **Central Run Registry** — moved to v0.24.0
- [x] ~~**BUN-001:** Bun PTY Migration — replace `node-pty` with `Bun.spawn` (piped stdio). Shipped in v0.18.5.~~
- [ ] **CI-001:** CI Memory Optimization — parallel test sharding for 1GB runners
- [ ] **CI-001:** CI Memory Optimization — parallel test sharding to pass on 1GB runners (currently requires 8GB). Evaluate `bun test --shard` when stable.
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

*Last updated: 2026-03-08 (v0.27.1 shipped — Pipeline Observability; v0.28.0 PRD ready — Prompt Builder)*
