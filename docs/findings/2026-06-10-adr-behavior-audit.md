# ADR Behavior Audit — Codebase vs docs/adr/

**Date:** 2026-06-10
**Baseline:** `main` @ `9c992d05` (v0.69.6)
**Scope:** All 21 ADR documents (ADR-005 … ADR-024) audited against current source, focusing on *behavioral* commitments — older ADRs may reference renamed/moved files, which counts as drift only when the promised behavior is missing or changed.
**Method:** Six parallel read-only analysis passes (one per ADR batch), each extracting the concrete behavioral commitments from its ADRs and verifying them against source with file:line evidence. Conflicting findings were re-verified directly (e.g. `src/runtime/packages.ts`).

---

## Executive Summary

**The codebase is in very good shape relative to its ADRs.** No HIGH-severity behavioral drift was found. The architecture has evolved through an explicit supersession chain (ADR-014/015/016/017 → ADR-018 → ADR-019/020), and the current code matches the *latest* accepted direction. The gaps that remain fall into four buckets:

1. **One real functional divergence (MEDIUM):** `format-check` and `plugin-reviews` phases promised by ADR-023's CANONICAL_ORDER were never built — formatting is handled only reactively via the `mechanical-formatfix` strategy.
2. **Staged work explicitly deferred:** ADR-018 Wave 4 (`RetryInput` unification), ADR-013 Phase 6 formalization. (ADR-021 Phase 8 was initially listed here but is in fact shipped unconditionally — see F3.)
3. **Operational fragility (MEDIUM):** per-package config correctness depends on `runtime.packages.hydrate()` being called at run setup; entry points that bypass `runSetupPhase` silently fall back to root config.
4. **Stale documentation:** ADR-005's stage table and file references, ADR-007's `keepSessionOpen` mechanics, and the duplicate ADR-014 files describe structures that no longer exist (behavior preserved via successors).

| ADR | Title | Status | Notes |
|:---|:---|:---|:---|
| 005 | Pipeline re-architecture | PARTIAL / SUPERSEDED by 023 | Event bus fully honored; 12-stage sequence collapsed to 8 stages + builder phases (intentional, ADR-023) |
| 006 | Acceptance retry restructure | HONORED (mostly) | Outer-loop ownership + single retry budget verified; "surgical test fix" claim unverified; prior-failure context generalized by ADR-022 |
| 007 | Implementer session lifecycle | SUPERSEDED by 008 | `keepSessionOpen` primitive replaced by ADR-011 state machine; continuity behavior preserved |
| 008 | Session lifecycle (all roles) | HONORED via ADR-011 | Stateful-vs-stateless rule sound; reviewer fresh-session-per-round enforcement not directly visible (moved into SessionManager layer) |
| 009 | Test-file pattern SSOT | FULLY HONORED | Resolver consumed at 8+ sites; only the 4 already-tracked violations (#533–#536) exist |
| 010 | Context engine | FULLY HONORED | All 8 decisions + amendments A–D implemented (Phases 0–7) |
| 011 | SessionManager ownership | FULLY HONORED | 7-state FSM enforced; `runInSession`; orphan sweep; force-terminate on FAILED |
| 012 | AgentManager ownership | FULLY HONORED | All 6 phases complete; legacy keys rejected at parse time; retry layers separated |
| 013 | SessionManager↔AgentManager hierarchy | PARTIAL (~80%) | Core hierarchy done; Phase 6 lifetime formalization absorbed by ADR-018's `createRuntime()` |
| 014 (×2) | RunScope + middleware / op standardization | REJECTED (by design) | Both marked Reject; superseded by ADR-018. `Operation<I,O,C>` and `PackageView` survived into the accepted design |
| 015 | Operation contract + session runners | REJECTED (by design) | Op contract honored; `scope.invoke()`, runner classes, `src/control/` correctly never built |
| 016 | Prompt composition + PackageView | PARTIAL | PackageView fully honored; prompt-middleware chain superseded; builder section-migration incomplete |
| 017 | Incremental consolidation | SUPERSEDED by 018 | Explicit supersession note dated 2026-04-24 |
| 018 | Runtime layering + session runners | ~85% IMPLEMENTED | Layers 1–4 live (NaxRuntime, runAs envelope, runInSession, callOp); Wave 4 RetryInput unification pending |
| 019 | Adapter primitives + session ownership | FULLY HONORED | 4-primitive adapter; peers via `buildHopCallback`; deprecated methods deleted |
| 020 | Dispatch boundary SSOT | FULLY HONORED | 3 emission points; pure event-subscriber middleware; `DispatchContext`; `SessionRole` SSOT |
| 021 | Findings + fix-strategy SSOT | FULLY HONORED | Phases 1–4, 6–9 shipped (Phase 8 rolled out unconditionally — flag dropped after dogfood); Phase 5 suggestion-only by design |
| 022 | Fix strategy and cycle | FULLY HONORED | Incl. #1204 uncapped-companion fix; dual budgets; validator retry-once |
| 023 | Execution unification | HONORED w/ 1 gap | 8-stage pipeline + builder CANONICAL_ORDER live; **format-check / plugin-reviews phases missing** |
| 024 | Non-blocking adversarial fix | FULLY HONORED | Snapshot/restore transaction; deterministic-only revalidation; opt-in (default off) |

---

## 1. Findings Requiring Action

### F1 — `format-check` and `plugin-reviews` phases absent from CANONICAL_ORDER (ADR-023) — MEDIUM

- **ADR claim:** ADR-023 §1 lists the per-story sequence `… lint-check → typecheck-check → format-check → plugin-reviews → …`.
- **Reality:** `src/execution/story-orchestrator.ts:250-261` defines 10 phases; `format-check` and `plugin-reviews` were never wired. Formatting is handled only *reactively*: `makeMechanicalFormatFixStrategy()` is registered when `pkgQuality.commands.formatFix` exists (`src/execution/build-plan-for-strategy.ts:156-159`), so unformatted files are only fixed when some other finding triggers rectification.
- **Impact:** Low functional risk (lint usually catches format issues), but a project relying on a standalone format command gets no proactive gate. `plugin-reviews` as a builder phase is also unrepresented (plugin review currently flows through the deferred end-of-run review per ADR-023/#1146 — confirm that ADR text and `IReviewPlugin` docs agree).
- **Recommendation:** Either implement `format-check` as a `DeterministicOperation` phase, or amend ADR-023 to document the reactive-only design. Same decision for `plugin-reviews`.

### F2 — Per-package config correctness depends on explicit `hydrate()` (ADR-016/018) — MEDIUM

- **ADR claim:** per-package `.nax/mono/<pkg>/config.json` overrides apply throughout the pipeline via `PackageView`.
- **Reality (verified directly):** the mechanism is fully implemented — `src/runtime/packages.ts` `hydrate()` merges overrides via `mergePackageConfig()` and `resolve()` returns the merged view (keys normalized repo-relative); `src/execution/lifecycle/run-setup.ts:197` calls `runtime.packages.hydrate(workspacePackages)`; `callOp` slices via `ctx.packageView.select()` (`src/operations/call.ts:130`).
- **Gap:** `resolve()` silently returns root config for any package not hydrated. Any entry point that constructs a runtime without running `runSetupPhase` (one-off CLI commands, plugins, future tools) gets root config with no warning.
- **Recommendation:** add a debug log (or one-time warn) when `resolve(packageDir)` misses `mergedConfigs` while `packageDir` is non-empty and hydration has never run; or hydrate lazily inside `resolve()`.

### F3 — ADR-021 Phase 8 — RESOLVED (audit premise was stale, no drift)

- **Correction (2026-06-10):** the original finding was wrong. There is no `acceptance.fix.findingsV2` flag — `grep -rn findingsV2 src/ test/` returns zero hits, and the config schema carries no `acceptance.fix.*` gate. ADR-021's own implementation-status header records that the flag was **skipped — schema rolled out unconditionally after dogfood validation**. The audit's parallel read-pass picked up the *planned* flag-gated design and never reconciled it against that header note.
- **Reality:** Phase 8 shipped unconditionally. `acceptanceDiagnoseOp` always emits canonical `Finding[]` with per-item `fixTarget` (`src/operations/acceptance-diagnose.ts:66-67`); the acceptance loop always prefers structured findings and routes source/test fixes off `fixTarget` (`src/execution/lifecycle/acceptance-loop.ts:151-167`). The verdict-only branch at `:153-167` is the graceful fallback when the LLM returns no structured findings, not a flag-gated default. `DiagnosisResult.findings?: Finding[]` exists; old `testIssues`/`sourceIssues` fields are gone.
- **Action:** none — feature is complete. (Optional observability nicety: a `logger.debug` at `acceptance-loop.ts:152` to make the verdict-fallback path visible in JSONL. Low priority, not tracked.)

### F4 — Reviewer session-freshness invariant not directly observable (ADR-008) — MEDIUM (verification gap)

- ADR-008's "reviewer session always closed by end of review; fresh sessionIds per round" (anti-oscillation guarantee) is now implemented indirectly: reviews are dispatched as operations through `callOp`/`runInSession`, and `closeNamedAcpSession`/`runReview()` named in the ADR no longer exist.
- The audit found no code violating the invariant, but also no explicit test or assertion enforcing fresh reviewer sessions per round.
- **Recommendation:** add/locate a unit test asserting that consecutive semantic/adversarial review rounds for the same story use distinct session descriptors (or that the review op's session lifetime is single-shot). If oscillating verdicts reappear in runs, this is the first place to look.

### F5 — ADR-006 "surgical test fix" claim unverified — LOW

- ADR-006 §2 promised `executeTestFix()` applying a surgical patch so passing tests are untouched. That function doesn't exist; acceptance test-fixes flow through `acceptanceFixTestOp` within the generic fix cycle. Behavior may well be surgical via the prompt, but nothing structurally guarantees passing tests are preserved.
- **Recommendation:** confirm the prompt/op semantics in `src/operations/acceptance-fix.ts` and either note conformance or amend ADR-006.

---

## 2. Intentional Supersession Chain (no action needed, useful map)

```
ADR-005 (pipeline stages) ──────────────► ADR-023 (8 stages + builder CANONICAL_ORDER)
ADR-007 (keepSessionOpen) ──► ADR-008 ──► ADR-011 (7-state FSM, runInSession)
ADR-014 ×2 (RunScope + middleware chains)  [Status: Reject]
ADR-015 (scope.invoke, runner classes,     [Status: Reject]      ──► ADR-018 (4-layer runtime:
         src/control/)                                                 NaxRuntime / runAs / runInSession / callOp)
ADR-016 (prompt middleware part)           [superseded]          ──► composeSections() (ADR-018 §7)
ADR-017 (incremental consolidation)        [explicitly superseded 2026-04-24] ──► ADR-018
ADR-018 session-runner classes             ──► ADR-019 Phase C (buildHopCallback; ISessionRunner deleted)
```

Survivors carried forward from rejected ADRs: `Operation<I,O,C>` + `ConfigSelector` (014-alt/015), `PackageView`/`PackageRegistry` (014-alt/016), observer middleware in simplified form (014).

**Housekeeping:** two files share the ADR-014 number (`runscope-and-middleware`, `runscope-and-operation-standardization`), both Rejected. Consider renaming one (e.g. ADR-014a/b) or adding a cross-note so the index stays unambiguous.

---

## 3. Verified-Honored Highlights (spot-check evidence)

- **Event bus (ADR-005):** `src/pipeline/event-bus.ts`; hooks/reporters/interaction all consume events via `src/pipeline/subscribers/` — no direct `fireHook()`/`executeTrigger()` calls from stages.
- **Acceptance loop (ADR-006):** single budget `acceptance.maxRetries` (`src/execution/lifecycle/acceptance-loop.ts:328`); outer loop always continues after fix attempts (`:342-398`).
- **Test-pattern SSOT (ADR-009):** `resolveTestFilePatterns()` consumed in context, review, pipeline, execution (8+ sites); no new violations beyond tracked #533–#536.
- **Context engine (ADR-010):** provider ecosystem Phases 0–7 complete, incl. `rebuildForAgent()`, canonical rules store, plugin provider loader, digest threading.
- **Session FSM (ADR-011):** `SESSION_TRANSITIONS` enforced (`src/session/manager.ts:245-262`); `failAndClose` force-terminate (`src/execution/session-manager-runtime.ts:98-118`); state-based orphan sweep (`src/session/manager-sweep.ts`).
- **Agent config (ADR-012):** `rejectLegacyAgentKeys` pre-parse guard; no `autoMode.defaultAgent` reads outside `src/config/`; availability/transport/payload retry layers separated.
- **Adapter primitives (ADR-019):** `AgentAdapter` = `complete/openSession/sendTurn/closeSession` only (`src/agents/types.ts:517-537`); `adapter.run/plan/decompose` gone; managers are peers integrated by `buildHopCallback` (`src/operations/build-hop-callback.ts:85-89`).
- **Dispatch SSOT (ADR-020):** exactly three `DispatchEvent` emitters (`runAsSession`, `completeAs`, `runTrackedSession` error path); audit/cost middleware are pure subscribers (`src/runtime/middleware/audit.ts`, `cost.ts`); `SessionRole` union + `KNOWN_SESSION_ROLES` (`src/runtime/session-role.ts`).
- **Fix cycle (ADR-022):** three-layer nesting (`src/findings/cycle.ts:148-493`); per-source `classifyOutcome` with `regressed-different-source` (`:71-96`); validator retry-once-then-terminal (`:423-456`); dual budgets; `buildPriorIterationsBlock` with 6000-char guard (`src/prompts/builders/prior-iterations-builder.ts`); #1204 uncapped-companion fix in place (`cycle.ts:185-206`).
- **Non-blocking adversarial fix (ADR-024):** blocking/advisory split (`src/operations/adversarial-review.ts:482-495`); advisory findings surfaced through dispatch events → review-audit middleware (`src/runtime/middleware/review-audit.ts:53`); snapshot/restore transaction with deterministic-only revalidation (`src/execution/non-blocking-fix.ts`); ships `enabled: false`.

---

## 4. Stale-Documentation List (behavior preserved; text outdated)

| Document | Stale content | Pointer to current truth |
|:---|:---|:---|
| ADR-005 | 12-stage sequence table; references to `src/verification/orchestrator.ts`, `post-verify.ts`, `rectification.ts`, `VerifyResult` type | ADR-023 (8 stages + builder); `Finding[]` per ADR-021/022; `src/findings/`, `src/operations/` |
| ADR-007 | `keepSessionOpen: !isLastAttempt` mechanics | ADR-008 → ADR-011 state machine; `keepOpen` narrowed to adapter-internal close-on-success |
| ADR-008 | `runReview()`, `closeNamedAcpSession` function names | Review ops via `callOp`; lifecycle owned by SessionManager (ADR-011/019) |
| ADR-014 (both) | Entire proposals (Rejected) | ADR-018 — consider adding a one-line tombstone header pointing there |
| ADR-016 | Prompt middleware chain (§1.1–1.3) and builder forbidden-import enforcement | `composeSections()` (ADR-018 §7); builders not yet section-migrated |
| ADR-023 | CANONICAL_ORDER listing `format-check` / `plugin-reviews` | 10 actual phases in `story-orchestrator.ts:250-261` (see F1 — fix code or doc) |

---

## 5. Suggested Next Steps (priority order)

1. **Decide F1:** implement `format-check` as a deterministic phase or amend ADR-023 to document reactive-only formatting. Same for `plugin-reviews`.
2. **Harden F2:** warn or lazily hydrate when `packages.resolve()` misses an override for a non-root package.
3. ~~**Close F3:** ramp or formally defer `acceptance.fix.findingsV2` (ADR-021 Phase 8).~~ **RESOLVED** — premise was stale; Phase 8 shipped unconditionally, no flag exists. See F3.
4. **Test F4:** add a regression test for fresh reviewer sessions per review round.
5. **Docs pass:** add supersession tombstones to ADR-005/007/014×2/016/017 headers and resolve the duplicate ADR-014 numbering.
