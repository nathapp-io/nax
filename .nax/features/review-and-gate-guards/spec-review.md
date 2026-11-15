# Spec Review — Review and gate guards

**Verdict: READY for planning.**

**Reviewed against:** `/Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax` at `7d50765120eeb862b8a700bd6ee533839cb895b6`.
**Date:** 2026-11-15.
**Spec:** `.nax/features/review-and-gate-guards/spec.md` — **all 886 lines read**, SHA-256 `81675195f3cecdd8c4a5ab3ae53c19947e2f412957cd66d03556a0688f818f37`.
**Phases run:** **8 of 9: phases 1–8 completed.** Phase 9 is not applicable: no PRD exists. No stop gate fired.
**Current findings:** **0 blockers, 0 majors, 0 minors.**
**Deadlock risk:** **0 DEADLOCK LIKELY, 0 AT RISK, 13 CLEAR**, plus a CLEAR feature row.

## Scope and method

- Fresh source-grounded review, not merely acceptance of the previous verdict. Loaded `repos/nax-spec-kit-skills/skills/spec-review/SKILL.md` and the complete eight applicable phase checklists. Read all **13 canonical `.nax/rules/*.md` files and 13 `.claude/rules/*.md` files**, package context and the architecture index. Canonical rules take precedence.
- Read the previous `spec-review.md` and `spec-review-revalidation.md` for the regression inventory, then checked current contracts independently. Their completed-phase claims are not used as substitutes for this pass.
- Ran git diff/status. The enclosing workspace's unrelated changes are excluded. The target repository has **no tracked product diff**; this feature directory is untracked. Graph and memory MCP tools are unavailable, so navigation used direct source reads and text searches in this checkout only.
- Accepted the supplied normal/strict lint results: **0 errors, 1 advisory (13 stories > target 7)**; did not rerun lint. Independently confirmed `.nax/config.json:4–8` sets `maxAcCount=24`; schema defaults for description length/bullets are **3000/12**. A seven-story target is not a hard cap.
- The additional fix/review round is explicitly authorized. The default two-round budget does not veto that authorization. The approved **single #2924/#2923 bundle** and **repeat=100 / silence=0, silence opt-in** are retained, not reopened as findings.
- Only this report is written in the target repository. No spec/product/PRD/config/rule edits, commits, planner, agent sessions, implementation jobs, services or test/coverage runs. Enumeration scripts are scratchpad-only. **READY means the spec is grounded and implementable; it does not claim the proposed implementation or tests already exist or pass.**

## Summary and evidence denominators

Counts distinguish paths, text-search candidates, contract groups, AC bullets and independently observable assertions.

| Phase | Examined | Result: blockers / majors / minors |
| --- | --- | --- |
| 1 — Existence | **80 distinct rooted code/test/fixture paths**: 71 present, 9 declared Creates; **24 abbreviated slash-path references** reconciled separately; **180 simple/dotted quoted identifier candidates**, plus **88 other quoted expression/basename/command spans**; **20 new-identifier rows** swept across mentions; **0 consumed external data literals** | **0 / 0 / 0** |
| 2 — Shapes | **12 baseline/target rows**, expanded into **31 existing changed touchpoints**; **6 new leaf contracts**; **17 mutated-shape test families** swept for closed-world pins; **31 Modifies permissions** checked for story ownership, single leading path and replacing invariant | **0 / 0 / 0** |
| 3 — Conventions | **26 rule files**, **2 fenced spec blocks**, **9 Creates paths**, and retry/configuration/builder/dependency-injection prose | **0 / 0 / 0** |
| 4 — Semantics | P4.1 **39 existing-behavior claims**; P4.2 **206 AC/prose comparisons**; P4.3 **31 changed touchpoints**; P4.4 **95 input-dimension groups**; P4.5 **42 interaction cells**; P4.6 **7 failure rows**; P4.7 **54 named API touchpoints**; P4.8 **24 risk properties**; P4.9 **0 fixture-generation algorithms**; P4.10 **9 constants + 3 composition relations**; P4.11 **0 shipped/DONE claims**; P4.12 **13 stories + feature row** | **0 / 0 / 0** |
| 5 — Sizing/hygiene | **13 stories**, **206 AC bullets / 215 assertions**, **14 dependency edges**, **62 Context Files entries**, **9 Creates**, **31 Modifies**, **11 exclusions**; all **13 story narratives + 206 ACs + 31 reasons + 11 exclusions** swept for placeholders; **11 feature constraint groups** routed | **0 / 0 / 0** |
| 6 — Staleness | **20 new-name rows** and **31 changed touchpoints** reconciled; **0 shipped/DONE claims**, **0 commit citations**, **0 cross-spec Markdown links**; **2 user-supplied issue references** retained | **0 / 0 / 0**; tracker not queried remotely |
| 7 — Verification | **206 ACs** classified: **126 unit / 80 integration**; all **206 locus checks**; **5 new callable exports** checked for behavior and production-use anchors; separately rechecked **24/24 prior locus findings** | **0 / 0 / 0** |
| 8 — Seams/deletion | **7 Seams entries**, **7 new-callable production bindings across 5 exports**, **20 existing-path traces**, **9 producer/consumer contract groups**; all **206 AC noun surfaces** walked; **0 literal removal-keyword hits**, **2 implicit cleanup groups** routed to static gates; **13 story size/context checks** | **0 / 0 / 0** |
| 9 — PRD fidelity | **0 PRDs** | Not applicable, not represented as passed |

## Critical issues — must fix

None.

## Warnings — should fix

None. The supplied story-count advisory remains informational under the explicitly approved bundle, not an unresolved major.

## Suggestions — consider improving

No new finding. Preserve US-012's zero remaining assertion headroom during planning; this is an existing cap, not an extra scope requirement.

## Round-4 fix verification

### W1 — Resolved: publish-side formatter invocation and outcome

**Spec:** `spec.md:237,399–401,636,827–828` (US-010 AC9–10).

The seam now captures `_approvalDeps.branchMismatchReasons` at **both** owners: the production branch-review step and `readinessReasons` reached during production `publish`. US-010 AC9 explicitly captures the publish-time call with persisted kinds; AC10 independently asserts its returned sentence becomes `PublishOutcome.reasons`. A branch-step-only spy or a publish implementation that hard-codes the sentence can no longer satisfy those criteria.

**Current source:** `src/workflow/finalize.ts:535–574` projects persisted facts, computes base readiness at 550, then routes local/push/PR modes; `prMode`/`pushMode` recompute reasons after CI (`447–529`). `src/workflow/approval.ts:123–137` is the existing reason assembler. The formatter/deps are declared new work, so their current absence is not a missing-path defect. The new capture is at the owning production entry, not a helper-only test.

### W2 — Resolved: all 24 identified criteria now contain concrete loci

| Story | Previously flagged AC positions | Current evidence |
| --- | --- | --- |
| US-001 | 5 | `createGateStallMonitor`, line **649** |
| US-004 | 1 | `scoped` and `regression`, **706** |
| US-005 | 18 | `runQualityCommand`, `proc.exited`, `stopReason`, **742** |
| US-008 | 9, 17 | `runReview`, **782**; `gatesStep` / `failingOnHead`, **790** |
| US-012 | 2, 3, 5, 6, 7, 9–12, 14–20 | `callOp(workflowBranchReviewOp)`, `buildWorkflowBranchVerdictMismatchRetry` or `workflowBranchReviewOp.retry`, **849–850,852–854,856–859,861–867** |
| US-013 | 7, 11, 12 | `preferRetryFallbackOnNullParse` / `callOp` / `retryFallback`, **880**; `workflowBranchReviewOp.retry`, **884–885** |

This is **24/24**, not a sample. The full 206-criterion pass also accepts actual unquoted fields/enums/commands such as `exitCode`, `minorTriage`, `adapterFailure`, `agent-tool` and `e2e`; backticks are not an invented additional condition. Token additions do not add behavior or consume assertion budget.

### W3 — Resolved: CLI wire entry distinguished from internal record

**Spec:** `spec.md:255`.

The JSON description now accurately names `GateReportEntry`: `name`, `status`, `exitCode`, `durationMs`, optional `failedPhase`, optional `outputTail`, plus the proposed optional `stopReason` **only** for detector-stopped gates. It preserves passed-gate tail omission and explicitly keeps `cwd` / raw `output` internal.

**Current source:** `src/cli/gates.ts:91–100,197–207,299–305` declares and projects that exact entry and emits one JSON document. `src/finish/gates/quality.ts:57–73` owns the internal fields. No raw-output/cwd CLI expansion is now implied.

### S1 — Resolved: atomic counts and headroom are accurate

**Spec:** `spec.md:261–279`, story-local count labels, and the eight disclosed compound bullets.

Independent recount agrees with **206 bullets / 215 assertions** and the supplied per-story sequence. No story exceeds 24. US-012 is **exactly 24**, not 23 and not a story with headroom.

| Story | AC bullets | Assertions | Context files | Trimmed narrative characters* |
| --- | ---: | ---: | ---: | ---: |
| US-001 | 21 | 21 | 4 | 317 |
| US-002 | 11 | 11 | 5 | 952 |
| US-003 | 20 | 22 | 5 | 338 |
| US-004 | 16 | 16 | 5 | 637 |
| US-005 | 18 | 18 | 5 | 1109 |
| US-006 | 6 | 7 | 3 | 304 |
| US-007 | 16 | 16 | 5 | 309 |
| US-008 | 21 | 21 | 5 | 551 |
| US-009 | 18 | 20 | 5 | 712 |
| US-010 | 14 | 15 | 5 | 469 |
| US-011 | 9 | 10 | 5 | 367 |
| US-012 | 23 | 24 | 5 | 1513 |
| US-013 | 13 | 14 | 5 | 1392 |
| **Total** | **206** | **215** | **62** | |

*Story narrative after its heading, trimmed, including Workdir/dependency/count/verification notes and excluding the separately extracted file/AC sections. All have zero narrative bullet lines. These are **not generated PRD descriptions**; no PRD exists to measure. Planning must preserve the actual 3000-character/12-bullet limits.

Atomic delta ledger (nine assertions beyond bullets):

- US-003 AC12, **694**: empty-group escalation cancellation, timer cleanup and reader cleanup — **+2**.
- US-006 AC6, **751**: duration sum versus preservation of each entry's output — **+1**.
- US-009 AC2, **799**: no newly fabricated consumer floor versus preservation of the existing parser-marker exclusion until US-011 — **+1**.
- US-009 AC18, **815**: historical readiness reasons versus finding counts — **+1**.
- US-010 AC12, **830**: summary construction versus summary rendering — **+1**.
- US-011 AC8, **843**: retaining authored blockers versus normalizing known-minor triage — **+1**.
- US-012 AC22, **869**: expected factory invocation versus production using its returned wrapper — **+1**.
- US-013 AC5, **878**: invalid-fallback error versus no post-parse hook reached — **+1**.

US-010's two new seam bullets contribute two assertions, yielding **15** there. The recount does not split every JSON field, timeout-flag tuple, alternative fixture or parameterized validation value into invented extra ACs. No forced split is warranted.

## Phase 1 — Existence and forward references

All 71 existing rooted paths are present. The nine absent paths are exactly the declared Creates: the gate-stall leaf; utility, schema, executor, verification-runner and quality-runner tests; routing integration test; clarification strategy and its test. The 24 abbreviated slash references resolve to package source/tests, canonical rules or those declared Creates. Basename-only references, `workflow-{replies,types}.ts`, existing barrels and produced artifacts were reconciled separately. No consumed dataset/endpoint/filename literal needs external provenance.

The 20 new-name rows remain byte-consistent across Design, stories, Creates, Seams and ACs. Forward allowlist: `GateStallPolicy`, `GateStopReason`, `GateStallMonitor`, `createGateStallMonitor`, `DEFAULT_GATE_STALL_POLICY`, `resolveStallDetection`, `StallDetectionConfigSchema`, target `stallDetection`/`stopReason`/lint-typecheck `timedOut`, `makeMismatchClarificationStrategy`, `MismatchClarificationOpts`, `buildWorkflowBranchVerdictMismatchRetry`, `preferRetryFallbackOnNullParse`, `reviewMismatch`, `branchReviewMismatch`, `branchMismatchReasons`, private `isPlainRecord`, `_branchReviewRetryDeps`, `_approvalDeps`. The scoped-lint runner-dependency addition is also explicitly declared in prose. New field names are checked at their target homes, not rejected because an unrelated existing module uses the same short word.

## Phase 2 — Shape and existing-test collision audit

The 31 changed touchpoints are: quality schema/public type/root literal/merge (4); executor options/raw result (2); verification options/result (2); quality options/result (2); gate command/record/bot check (3); four op outputs and the full-suite internal run result (5); RunOperation/branch parser/retry resolver/floor/branch step (5); feature record/readiness facts/publish/graph outputs (4); scoped-lint helper and finish/scoped-lint dependency objects (3); CLI report entry (1). Each has an explicit target, not just an accurate baseline.

The six new leaf contracts (policy, reason union, monitor interface, factory, default, resolver) are mutually compatible. Optional additive fields preserve historical/manual literals; config defaults are parsed before harness forwarding, and low-level opt-out remains distinct from a manually constructed policy-less finish gate.

Swept 17 test families: configuration; executor option/raw result; verification options; verification results; quality options/results; gate descriptions; gate records/CLI projection; bot checks; lint/typecheck outputs; scoped/full outputs; RunOperation; branch verdict; feature record; readiness; graph outputs; scoped-lint helper-call pins; dependency seams. Read closed-world assertions and actual-member loop bodies, rather than treating all `toEqual` or all type mentions as collisions.

Necessary gate-object pins are owned by US-007: `gates-quality.test.ts:36–240`, `gates-quality-e2e.test.ts:79–135`, `repo-gates.test.ts:52`, and the nested exact element at `package-profile-registry.test.ts:166`. Bot projections/tables are owned by US-008 (`bot/checks.test.ts:90–95,130–134,228,262–341`), as is the widened helper call (`review/scoped-lint.test.ts:327–359`). Parser/floor pins are bounded to US-009/011; retry-prompt versus dispatch-delivery changes to US-012/013. The graph output pin is explicitly owned by US-009. All 31 Modifies entries have real owning story groups, one leading path apiece and a specific replacing invariant. No necessarily broken, unauthorized closed-world test was substantiated.

## Phase 3 — Project conventions

The TypeScript interface block uses injected **cancellable** timers, within the kill/drain/silence exception; the JSON block is a complete two-field user configuration example, not a mandated repository `.nax/` edit. No forbidden runtime, global module mock, hardcoded permission, secret or inline LLM retry loop is prescribed. Workflow prompt functions are explicitly allowed by the canonical prompt rule despite the generic checklist's class-builder example. New files are concern-named and in sanctioned trees. The leaf import discipline avoids the existing quality-to-verification edge becoming cyclic. Static gates continue to govern final implementation file sizes/imports; hypothetical implementation sizes are not certified here.

## Phase 4 — Behavioral semantics

### P4.1 — 39 existing-behavior claims

Grounded claims in these groups: story mismatch/branch parser/consumer floor (3); whole-stream versus incremental reads, terminal waits, floating catch, group escalation and no-bare-pid lifecycle (8); output origins, env stripping/markers, NO_COLOR and trust (4); verification aggregation/escalation, quality aggregation, scoped zero-tests guard, full-suite timeout translation and workflow red wrapper (6); root precedence, overlay identity, setup ordering, bot projection/remapping/baseline, scoped-lint arms and setup exit (8); invocation retry resolution, per-hop ceiling, null-parse ladder, legacy fallback guard, hooks and outer review limit (6); readiness before approval, generic reason/count/success channels, graph declaration enforcement and CLI JSON projection (4).

Principal evidence (paths relative to `packages/nax/src`): `operations/workflow-replies.ts:136–157,191–207`; `workflow/feature-steps.ts:122–198`; `verification/executor.ts:116–251`; `verification/runners.ts:67–189`; `quality/runner.ts:144–178,279–367,400–434`; `quality/aggregate.ts:8–19`; `operations/verify-scoped.ts:285–390`; `operations/full-suite-gate.ts:190–210,347–374`; `workflow/gates.ts:74–91,161–180`; `finish/gates/quality.ts:87–117,190–321`; bot/review paths below; `operations/call-dispatch-run.ts:103,279–341,396–408,463–506`; `operations/post-parse.ts:26–45`; `workflow/story-review.ts:20–56`; approval/publish/CLI evidence above. W3's former output-contract drift is corrected.

### P4.2 / P4.3 — 206 comparisons / 31 targets

Compared every AC with Design, dependencies and story-local authority. US-012 observes strategies/prompts and ordinary parseable replies; US-013 owns delivery after a null authoritative parse. Consumer-first mismatch handling precedes the parser change. No criterion requires a later story's undelivered capability. All 31 mutated touchpoints have targets; no old signature is presented as the implementation contract.

### P4.4 / P4.5 / P4.7 / P4.8 — Domain ledger

Dimensions were enumerated from contracts/domain before matching their defining ACs/exclusions; grouped variants are not additional atomic assertions.

| Story | Input dimensions | Interaction cells | Named APIs | Risk properties |
| --- | --- | ---: | ---: | ---: |
| US-001 | **9**: streams, chunks/UTF-8, delimiters/tail, exact text, blanks, length cap, repetition, silence/activity, disposal/isolation | 4 | 2 | 3 |
| US-002 | **5**: absent/empty, repeat domain, silence domain, whole-object default, partial/zero overlay | 2 | 4 | n/a |
| US-003 | **9**: opt-in, stop kind, terminal order, groups, exit settlement, read/drain errors, output, cleanup, trust | 4 | 2 | 6 |
| US-004 | **6**: list order, first reason, escalation, policy/selection, zero tests, accepted timeout | 3 | 6 | n/a |
| US-005 | **10**: origin/opt-in, stop kind, order, groups, never/rejected exit, read/drain failure, volume, exposure, cleanup, trust | 4 | 2 | 6 |
| US-006 | **4**: fresh state, continuation/order, reason order, aggregate fields | 2 | 2 | n/a |
| US-007 | **8**: root/overlay, sparse/zero, precedence, identity/dedupe, manual policy absence, classification, setup, continuation | 3 | 3 | 2 |
| US-008 | **8**: provenance, mechanical timeout flags, four lint arms, setup, bot source, checkout trust, CLI exit/output, partial diagnostics | 3 | 11 | 2 |
| US-009 | **8**: direct/parsed, kinds, real/minor work, empty work/counts, persistence/order, resume, re-review, clear/history | 3 | 4 | 3 |
| US-010 | **6**: kinds, independent reasons, advisor/CI, modes, artifacts/counts, execution success | 2 | 6 | n/a |
| US-011 | **5**: malformed shape, kinds, severity/evidence, triage, order/deduplication | 2 | 1 | n/a |
| US-012 | **10**: shape, mismatch, budgets, priority, interleaving, progress, malformed follow-up, last parseable, hops/transport, outer limit/abort | 7 | 5 | 1 |
| US-013 | **7**: opt-in/nullish parse, fallback absence, ordinary/null-prototype record, invalid classes, verify, conditional recover, legacy isolation | 3 | 6 | 1 |

The 42 interactions cover stream activity/repetition/silence, cap/reset, disposal/late callbacks, first-observed exit/stop, leader/group survival, drains versus execution, trust/spawn, ordinary-failure-plus-stop in both list orders, zero-tests bypass, accepted-timeout/workflow-red composition, overlay precedence/identity, setup/journey, bot provenance/remapping, mismatch with real/promoted work, resumed/fresh clearing, green CI/advisor versus draft hold, and shape/clarification/coverage/hop/null-parse-hook combinations.

The 54 APIs are monitor/resolver (2), schema/default/merge consumers (4), executor/monitor (2), scoped/regression/executor/test ops/suite wrapper (6), quality runner/monitor (2), runner/aggregator (2), finish resolver/runner/policy resolver (3), story gates/lint/typecheck/review/scoped lint/setup/bot resolver/gate/baseline/CLI/derived runner seam (11), feature machine/step/floor/formatter (4), readiness/publish/formatter/summary builder/summary renderer/open items (6), branch parser (1), branch retry/shape/coverage/factory/builder (5), and dispatch/authoritative parse/post-parse/verify/recover/private record guard (6). Both formatter owners now have captures. No design-mandated named API is left dependent on outcome-only coverage behind an unconstrained double.

The 24 risk properties cover per-spawn state/disposal; each engine's trust, terminal ownership, single termination, group safety, bounded settlement and cleanup; policy identity/default isolation; trusted bot provenance/no reread; mismatch persistence/clear ownership/historical compatibility; invocation-local retry budgets; and strict opt-in isolation. No missing auth/SQL/web feature is invented.

### P4.6 — 7 failure rows

All seven rows map to owning runtime criteria or named existing preservation contracts. Rejected exit handling is expressly outside repair scope. Package failure, no dispatch, review timeout and abort are anchored to `underReviewLimit`, dispatch guards and existing `branch-review-sliced.test.ts:166–225`; the spec requires these cases remain green unedited. That preservation routing does not silently add ACs to US-012.

### P4.9–P4.11 — Derivability and shipment

No fixture-generation algorithm asserts an underivable property; controlled streams and scripted replies are supplied inputs. Nine values are defined: repeat **100**, silence **0**, repeat minimum **2**, line cap **16384**, agent tail **4000**, shape repair **1**, clarification **1**, coverage default **3**, per-hop hard ceiling **21**. Three relations are explicit: first-observed terminal wins; silence/wall limits are independent; semantic **3+C** remains inside the existing per-hop send loop, with invocation-scoped semantic budgets rather than a new cross-hop availability cap. There are zero shipped/DONE implementation claims. P4.12 is assembled after Phase 8 below.

## Phase 5 — Sizing, ownership and hygiene

The table/recount above establishes all 13 assertion/context bounds. Fourteen story-local dependency edges agree with the design DAG, all point backward, and there are two independent roots (US-001/009). The bundle exception is expressly approved, not a missing author decision. US-002 supplies config before US-004/007 read it; US-003/005 supply engines before their forwarding/aggregation consumers; US-009 precedes parser US-011; US-012/013 separate composition from delivery. Shared-test permissions preserve these boundaries.

All six required sections are present; CLI exit/stdout/stderr behavior and the full two-field config example are specified. All 11 exclusions are self-contained extractable bullets. All 13 story contexts are nonempty and at most five files. No implementation story writes repository `.nax/` state. Repeated criterion prefixes were read, not automatically called duplicates: they address distinct states/fields/effects. No unresolved duplicate, placeholder, trailing AC “etc.”, vague validation/error-handling sentinel or title/body drift was found.

Eleven constraint groups route through criteria, exclusions or named rules: bundle ownership; dependency/version scope; story semantics; finding honesty; silence defaults; exact detector semantics; output/schema scope; subprocess ownership; rejected-exit policy; trust/platform boundary; repository-state writes. No extra criterion is requested merely to restate an existing suite/static invariant.

## Phase 6 — Staleness

Current target homes still lack the proposed additions. Existing parser and consumer floors, old dispatch precedence and gate-policy gaps remain real work, not already-shipped no-ops. All 20 new-name rows and 31 additive/changed touchpoints were reconciled with current source. There are no shipment/commit/phase-continuity or cross-spec-link claims to validate. The two issue IDs are user-supplied closure references and parse as `Closes: #2924, #2923`; no remote issue-inspection claim is made.

## Phase 7 — Runtime verification anchors

All 206 ACs carry a valid unit/integration runtime mechanism, with observable prose after tags are stripped. No zero-AC story, file-content/shell AC, removal-as-AC, invalid tag or unbacked architecture meta-AC was found. Negative runtime effects (no extra prompt/fix/hook/kill) are observable behaviors, not banned source-absence assertions. Five new callable exports have direct behavior and captured production-use anchors. Structural types/schema/default values are exercised through runtime consumers and static imports, not fictitious function spies. W2 is resolved across its 24 criteria and the complete locus sweep.

## Phase 8 — Seam reality, contracts and cleanup

### Class A — 7 new-callable production bindings

`createGateStallMonitor` from **each engine** (2); `resolveStallDetection` from `runRepoGates` through finish deps (1); clarification factory and builder from real `callOp(workflowBranchReviewOp)` (2); reason formatter from production feature branch review and from production publish readiness (2). These are **7 bindings across 5 exports**. The factory's returned wrapper determines prompts; the builder's returned prompt is sent; the formatter's returned sentence reaches reasons. Late-callback, one-clarification, spent-shape two-hop and resumed-record scenarios cover re-trigger/stateful guards. New endpoints are declared new work, not falsely claimed existing calls.

### Class B — 20 observed existing-path traces

Paths below are relative to `packages/nax/src`; proposed policy/reason forwarding is the new work layered on these verified paths.

1. `scoped` (`verification/runners.ts:168`) → `runVerificationCore` (141) → single core (39) → `executeWithTimeout` (67).
2. `regression` (`verification/runners.ts:187`) → the same core/executor (189/67).
3. `verifyScopedOp.execute` (`operations/verify-scoped.ts:160`) → local `runTests` (284) → `deps.regression` (285); zero-tests rerun uses it again (332).
4. `fullSuiteGateOp.execute` (`operations/full-suite-gate.ts:286`) → `deps.runTests` (326) → production `regression` (190).
5. `runStoryGates` (`workflow/gates.ts:118`) → lint `callOp` (123) → deterministic execute (`operations/call.ts:57`) → runner (`operations/lint-check.ts:132`).
6. Same story entry → typecheck `callOp` (126) → deterministic execute → runner (`operations/typecheck-check.ts:136`).
7. `runWorkflowSuiteGate` (`workflow/gates.ts:161`) → full-suite `callOp` (163) → full-suite path above.
8. `runRepoGates` (`workflow/repo-gates.ts:24`) → resolved commands (26) → finish gates (27) → `_qualityGateDeps.run` (`finish/gates/quality.ts:300`).
9. `gatesRunCommand` (`cli/gates.ts:267`) → resolved/selected gates (274/299) → finish gates → runner.
10. `runSetupGate` (`cli/setup-verify.ts:15`) → quality runner (28), returning its exit code (34).
11. `runReview` (`review/runner/index.ts:349`) → mechanical check (368/297) → `runCheck` → quality runner (171), or lint path (325).
12. `runScopedLintCheck` (`review/scoped-lint.ts:253`) → degraded/template/derived/full helper calls (265/301/314/332) → real `runLintCommand` (201) → quality runner (208). The supported-derived/no-template/non-degraded fixture establishes the derived guard without rewiring the intentionally degraded production adapter.
13. `resolveBotChecks` (`bot/checks.ts:201`) → configured tier (92) → trusted-snapshot resolver (95); instruction/detected alternatives have explicit provenance fixtures.
14. Bot `gatesStep` (`bot/fix-steps.ts:223`) → spread gate plus worktree cwd (229) → injected finish gates (232); safe-tree and nonempty gates are established.
15. `failingOnHead` (`bot/gate-baseline.ts:53`) → clean status/head checkout guards (60–64) → supplied gates into finish runner (66), restored in finally.
16. `runFeatureMachine` (`workflow/feature-machine.ts:103`) → real graph branch-review node (`feature-graph.ts:33`) → `branchReviewStep` (`feature-steps.ts:149`) → patch validation/persistence (`step-graph/run.ts:271,303`).
17. `publish` (`workflow/finalize.ts:535`) → facts (536–548) → readiness (550 and pushing modes), deterministic reasons before approval/mode publication.
18. `callOp` (`operations/call.ts:41`) → run dispatcher (64) → strategy resolution once (`call-dispatch-run.ts:103`) → branch retry resolver (`workflow-branch-review.ts:75–120`).
19. `runBranchReview` (`workflow/branch-review.ts:216`) → package preparation → `underReviewLimit` (230) → `_workflowDeps.callOp` (234); package/abort/deadline guards are retained.
20. Real `callOp` → authoritative parse (`operations/call-dispatch-run.ts:463`) → `runPostParse` (477) → verify then conditional recover (`operations/post-parse.ts:26–45`). Null-parse substitution before this boundary is explicitly US-013's new work.

Nine producer/consumer groups reconcile config/default/overlay policy; raw verification→list evidence; quality→aggregation evidence; gate carrier→bot projection; result→op/workflow interruption; parser/verdict→persisted graph record; record→readiness/artifact/summary reasons; retry fallback→authoritative parse/hooks; and internal gate record→CLI JSON projection. Required values have reachable producers, thresholds are sourced, and the CLI encoding now matches its actual contract. Same-package typed forwarding is compiler-spanned; serialized artifacts and JSON projection were checked separately.

There are zero literal `delete|remove|consolidate|retire|rename` word matches. Two implicit cleanup groups—parser-floor marker/consumer exclusion, and obsolete floor helper/import cleanup—are routed to the static-gate note at `spec.md:257` and US-011 prose. There is no destructive file-content AC, missing terminal deletion story or mixed additive/destructive acceptance story. All 13 context/assertion bounds were rechecked.

## Earlier-finding regression disposition

| Earlier issue | Current independent disposition |
| --- | --- |
| Graph output/test authorization | **Preserved/resolved.** Spec target row 42, US-009 prose 389 and Modifies 609 authorize `reviewMismatch` in the branch-review declared output and exact pin. Source `feature-graph.ts:33–37`, `feature-graph.test.ts:58–60,109–116`, and `step-graph/run.ts:69–83` confirm both persistence and explicit undefined clearing require this declaration. |
| US-012 consumes US-013 delivery | **Preserved/resolved.** US-012's fallback is a strategy decision; real-callOp malformed-follow-up delivery, surviving findings/mismatch and null/skipped-wrapper outcomes are owned by US-013 (`spec.md:431,626–627,874–886`). The current null authoritative parse still bypasses stored fallback, confirming why that owner is necessary. |
| US-012 sizing blocker | **Resolved, not revived.** Independent recount is 24; the prior lower-bound 25 applied to an older spec. Current count/headroom prose is accurate. |
| Factory/builder/formatter production-use gaps | **Preserved/resolved.** Seams 632–637 and ACs 811,827–828,869–870 capture both formatter owners and the factory/builder, including observable use of returned values. |
| Strict-record versus broad legacy validator | **Preserved/resolved.** Spec 218–225 defines private strict `isPlainRecord` only for opt-in null-parse substitution, accepting ordinary/null-prototype records and rejecting arrays/classes/primitives. Source `call-dispatch-run.ts:396–408` still uses the broader throwing-path check, which US-013 preserves. |
| Derived scoped-lint forwarding | **Preserved/resolved.** Spec 187/601/781 requires the supported-derived/no-template fixture and capture beyond the restored real helper through the new runner dependency; current source has that separate derived call at `scoped-lint.ts:314`. Adapter pin remains intentionally degraded, not scope-rewired. |
| No semantic-budget reset across manager hops | **Preserved.** Spec 201–208 and US-012 AC20 plus Seams 638 retain the invocation-local spent-shape count and two-hop prompt-count observation. Source resolves the strategy once at dispatcher 103 but resets local attempt to zero at 286. No new cross-hop transport cap is introduced. |
| Outer review timeout/abort/no dispatch | **Preserved/resolved.** Spec 251/423 names existing guards/tests and forbids deadline extension. Source `story-review.ts:20–56`, branch wrapper 230–245, dispatch guards 187–196/317–335, and `branch-review-sliced.test.ts:166–225` substantiate the preservation anchor. |
| Full gate wiring | **Preserved.** US-004/007/008 and the execution inventory retain both engines, mixed lists, ordinary zero-tests fallback, e2e setup, package policy identity, CLI, review's four lint arms, setup and trusted bot projections. Bootstrap/baseline/agent-tool opt-outs are explicit, not accidentally omitted gates. |

## Deadlock risk — per story (P4.12, assembled after Phase 8)

Cells are **findings/examined**, not a count of tests run. P5-ph/P8-noun uses each story's AC surfaces; all narratives, Modifies reasons and exclusions were additionally swept above. `n/a` means inapplicable, not an unexecuted applicable check.

| Story | P4.2 ACs | P4.4 dimensions | P4.5 interactions | P4.7 APIs | P4.8 properties | P4.9/10 values | P5-ph / P8-noun | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| US-001 | 0/21 | 0/9 | 0/4 | 0/2 | 0/3 | 0/4 | 0/21 · 0/21 | CLEAR |
| US-002 | 0/11 | 0/5 | 0/2 | 0/4 | n/a | n/a | 0/11 · 0/11 | CLEAR |
| US-003 | 0/20 | 0/9 | 0/4 | 0/2 | 0/6 | n/a | 0/20 · 0/20 | CLEAR |
| US-004 | 0/16 | 0/6 | 0/3 | 0/6 | n/a | n/a | 0/16 · 0/16 | CLEAR |
| US-005 | 0/18 | 0/10 | 0/4 | 0/2 | 0/6 | 0/1 | 0/18 · 0/18 | CLEAR |
| US-006 | 0/6 | 0/4 | 0/2 | 0/2 | n/a | n/a | 0/6 · 0/6 | CLEAR |
| US-007 | 0/16 | 0/8 | 0/3 | 0/3 | 0/2 | n/a | 0/16 · 0/16 | CLEAR |
| US-008 | 0/21 | 0/8 | 0/3 | 0/11 | 0/2 | n/a | 0/21 · 0/21 | CLEAR |
| US-009 | 0/18 | 0/8 | 0/3 | 0/4 | 0/3 | n/a | 0/18 · 0/18 | CLEAR |
| US-010 | 0/14 | 0/6 | 0/2 | 0/6 | n/a | n/a | 0/14 · 0/14 | CLEAR |
| US-011 | 0/9 | 0/5 | 0/2 | 0/1 | n/a | n/a | 0/9 · 0/9 | CLEAR |
| US-012 | 0/23 | 0/10 | 0/7 | 0/5 | 0/1 | 0/4 | 0/23 · 0/23 | CLEAR |
| US-013 | 0/13 | 0/7 | 0/3 | 0/6 | 0/1 | n/a | 0/13 · 0/13 | CLEAR |
| — (feature) | n/a | n/a | n/a | n/a | n/a | 0/3 relations | 0/11 exclusions · n/a | CLEAR |

## Security, performance and handoff

No dependency/version/license integration is proposed. No exposed credential, SQL injection, XSS, path-traversal, CSRF or authentication-bypass requirement was found. Relevant controls remain trust-before-spawn, trusted bot policy provenance, environment stripping, reason-only structured logging, terminal ownership, safe process-group escalation and bounded cleanup. Strict validation is limited to the new opt-in branch without silently changing legacy dispatch.

The monitor is implementable in **O(decoded input length)** with bounded detector-only per-stream line state; existing retained output remains intentionally outside that cap. Retry counters are invocation-local and bounded. This is source/spec analysis, not a benchmark or a passing implementation-test claim.

**READY: 0 blockers, 0 majors, 0 minors.** W1/W2/W3/S1 are resolved and earlier resolutions remain intact. No spec/product changes, commits or jobs were made. The parent owns any separately authorized **native-codex-dsm** planning launch; this reviewer did not launch it. Phase 9 must audit the actual future PRD before implementation handoff; it has not been pre-certified here.
