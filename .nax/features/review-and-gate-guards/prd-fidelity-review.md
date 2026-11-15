# PRD Fidelity Review — Review and gate guards

**Verdict: READY.**

**Phases run:** 1 of 9 (--phase 9: phases 1–8 skipped by request).  
**Scope:** 1 of9 phase9-only — spec→PRD transformation, not a new full spec audit.  
**Date:** 2026-11-15.  
**Repository:** `repos/nax` at `7d50765120eeb862b8a700bd6ee533839cb895b6`.  
**Spec:** `.nax/features/review-and-gate-guards/spec.md`, SHA-256 `81675195f3cecdd8c4a5ab3ae53c19947e2f412957cd66d03556a0688f818f37`.  
**PRD:** `.nax/features/review-and-gate-guards/prd.json`, SHA-256 `2f01099a60ad7645205603736ef9d4badeb1514f2757cc0b4e68e3a027e03a59`.

## Summary — Phase 9 only

| Examined surface | Denominator and outcome |
| --- | --- |
| AC survival / behavioral fidelity | **206/206 spec bullets → 215/215 PRD assertions**, in their original stories. **188** one-to-one matches after only backtick/whitespace normalization; **8** compound bullets split into **17** assertions; **10** other bullets clarified without losing their behavioral contract. **0 missing, 0 degraded, 0 orphan material-scope ACs.** |
| Runtime mechanisms and concrete loci | All **215** criteria read: **133 unit / 82 integration**; all retain their observable assertions and required identifiers. **24/24** previously corrected locus-bearing spec criteria survive. No file-content/grep criteria introduced. |
| Stories / dependencies / routing | **13/13** IDs, titles and `packages/nax` workdirs match; **14/14** dependency edges match story-local declarations, including **2 explicit empty dependency sets**. All **13 pending**, `passes:false`, zero attempts; `routingProfile: native-codex-dsm`. |
| File roles / authorization | **102/102 entries** match: **62 context**, **9 creates→expectedFiles**, **31 modifies→modifiedFiles**. All **31 reasons** match verbatim. All **62 context entries currently exist**; all **9 creates are currently absent**; **0 self-created-context overlaps**. |
| Correction survival | **14 correction/invariant groups** checked below in executable descriptions/ACs, with structural permissions checked separately. Inert `analysis`, `tags` and routing commentary are not delivery evidence. |
| Forward references / request-data seams | All **20 new-identifier rows** re-swept over **13 descriptions + 215 criteria**. No spelling drift. All **18 changed/split source bullets** compared in detail; **5 targeted existing-contract grounding groups** checked where re-encoding could alter a call/result seam. No PRD-introduced unsatisfiable invocation or payload shape found. |
| Exclusions / cleanup | **11/11 outOfScope entries verbatim**, same order; **0 orphan exclusions**, **0 inverted exclusions**, **0 story-local deferral blocks** requiring a prefix. **0 terminal deletion-only stories** in the approved spec, so the terminal-cleanup test is inapplicable. Natural US-011 floor cleanup remains with its original owner. |
| Size | **13/13** stories at or below **24 atomic assertions / 3000 description characters / 12 description bullet lines**. US-012 is **24**, with no headroom. Largest description **2964 characters**; all descriptions have **0 Markdown bullet lines**. |

**Findings: 0 blockers, 0 majors, 0 minors.**

## Critical issues — must fix

None.

## Warnings — should fix

None.

## Suggestions — consider improving

No new finding or required change. Preserve US-012's zero assertion headroom if the PRD is subsequently edited.

## Scope and complete-read method

Loaded the complete `spec-review/SKILL.md` and `checklists/phase-9-prd-fidelity.md` from `repos/nax-spec-kit-skills/skills/spec-review/`, and read the existing `spec-review.md`. Accepted its phases 1–8 result as the review boundary; did not rerun them, spec lint, product tests, or a design review. The approved single #2924/#2923 bundle and repeat=100 / silence=0 opt-in defaults are not reopened.

Read the complete **886-line spec** and **846 logical-line PRD**. Long JSON descriptions and the **36,639-character analysis field** were losslessly wrapped into scratchpad pages to avoid line/output truncation; all remaining JSON fields were also read in numbered pages. Reading `analysis` establishes complete-file coverage, not correction delivery. Independently parsed and compared ACs, machine-readable story declarations, file roles, modification reasons and exclusions with local deterministic scripts.

Ran git diff/status first: no tracked product changes in the target repository; the feature directory is untracked. Graph and memory tools are not exposed in this session; used direct reads only for the limited PRD seam checks described below. No symbols' spec-level existence, approved shapes, story sizing choices or design decisions were reopened. No dependency/license integration is introduced by the transformation; the dependency/version-change exclusion remains verbatim.

Only this requested report is written in the target repository; scratchpad enumeration files are outside product/spec/PRD content. A general `Write` tool is not exposed, so report emission uses a local file write. No spec/PRD/product edits, commits, agents, billed jobs, approval launch or implementation run. READY certifies fidelity, not an implemented or passing feature. The parent retains commit and approval-tool launch ownership.

## Story mapping, order and actual atomic bounds

Every expected edge matches the story-local `No dependencies.` / `Depends on ...` declaration, not merely the design summary. No artificial edge connects the two approved arcs. In particular, US-009 precedes US-011's parser change, and US-013 follows US-012 while owning delivery rather than retry composition.

| Story | Spec bullets | Spec assertions / PRD ACs | Description chars | Bullet lines | Dependencies |
| --- | ---: | ---: | ---: | ---: | --- |
| US-001 | 21 | 21 / 21 | 2939 | 0 | none |
| US-002 | 11 | 11 / 11 | 2352 | 0 | US-001 |
| US-003 | 20 | 22 / 22 | 2901 | 0 | US-001 |
| US-004 | 16 | 16 / 16 | 2572 | 0 | US-002, US-003 |
| US-005 | 18 | 18 / 18 | 2964 | 0 | US-001 |
| US-006 | 6 | 7 / 7 | 1639 | 0 | US-005 |
| US-007 | 16 | 16 / 16 | 2563 | 0 | US-002, US-005 |
| US-008 | 21 | 21 / 21 | 2914 | 0 | US-004, US-007 |
| US-009 | 18 | 20 / 20 | 2960 | 0 | none |
| US-010 | 14 | 15 / 15 | 2916 | 0 | US-009 |
| US-011 | 9 | 10 / 10 | 2350 | 0 | US-009 |
| US-012 | 23 | 24 / 24 | 2915 | 0 | US-011 |
| US-013 | 13 | 14 / 14 | 2922 | 0 | US-012 |
| **Total** | **206** | **215 / 215** | — | **0** | **14 edges** |

The extra nine PRD rows are exactly the approved atomic split ledger: US-003 AC12 **+2**; US-006 AC6, US-009 AC2/18, US-010 AC12, US-011 AC8, US-012 AC22 and US-013 AC5 **+1 each**. Field tuples describing one result, parameterized input classes, and alternate fixtures are not inflated into unrelated assertions. No independent assertion has been hidden by recombining rows.

## Correction survival — spec↔PRD evidence

References below are to the reviewed `spec.md` and `prd.json`; AC numbers are one-based within their owning story. `description` is executable prompt content; `modifiedFiles` is cited only for edit authorization, not as a substitute for behavioral delivery.

| # | Correction / invariant | Approved spec evidence | PRD delivery / disposition |
| --- | --- | --- | --- |
| 1 | Graph output declaration and exact-test permission | Lines **42,389,609**: declare `reviewMismatch` in branch-review `produces`, including explicit undefined clearing. | US-009 **description L513** explicitly preserves the output declaration and undefined-clear requirement; **L522,531–532** persist/clear at runtime; **modifiedFiles L573–574** owns the exact feature-graph pin and preserves all other graph expectations. |
| 2 | Consumer-first, independently gate-safe ordering | Lines **281,389,409,604–609,617–618**. | US-009 dependencies **[] L542**; US-011 depends on US-009 **L664–665**. US-009 description and **AC3 L517** preserve the temporary parser-marker exclusion; US-011 description **L646** owns its later cleanup. Parsed-test permissions remain split between the two stories. |
| 3 | Last-parseable delivery belongs to US-013 | Lines **214–225,260–281,419–435,623–627,855,874–886**. | US-012 description **L699** excludes US-013 delivery; **AC6/8 L706,708** observe retry fallback, not an undeliverable parsed result. US-013 **AC9–13 L781–785**, description **L771**, and permissions **L819–824** own wrapper/null/malformed-follow-up/coverage delivered outcomes through real `callOp`. |
| 4 | Strict opt-in fallback, verify, conditional recover, legacy isolation | Lines **216–225,431–435,874–886**. | US-013 description **L771** retains the flag, private `isPlainRecord`, ordinary/null-prototype acceptance, all invalid classes, nullish absence, validation before hooks, and protection against the legacy catch swallowing the error. **AC1–8 L773–780** retain verify and conditional recover plus rejected classes; **AC14 L786** preserves legacy array fallback on a throwing non-opt-in parse. |
| 5 | Shared formatter at both owners and returned value actually used | Lines **237–241,399–401,636,811,827–830**. | US-009 **AC15 L529** captures the branch-step `_approvalDeps.branchMismatchReasons` call with persisted kinds. US-010 **AC9–10 L597–598** independently capture publish-time use and `PublishOutcome.reasons` carrying its returned sentence; description **L587** requires one persisted-step→publish flow capturing both. Summary carry/render split **L600–601** survives. |
| 6 | Derived scoped-lint policy reaches real command execution | Lines **187,601,781**. | US-008 description **L434**, **AC8 L443**, and exact-test authorization **L495–496** retain the no-template/non-degraded derived fixture, real helper/new runner seam, appended-files command and unchanged degraded production adapter. Template/full/degraded forwarding also remains **AC7 L442**. |
| 7 | Existing outer timeout/abort/package-failure preservation | Lines **251,423,627**: no deadline extension or new timeout/abort AC; named existing wrapper tests stay unedited. | US-012 description **L699** says preserve deadlines/abort tests; US-013 description **L771** concretely preserves `branch-review-sliced.test.ts` package-failure/abort/outer-timeout cases unedited, reinforced by **L823–824**'s permission boundary. No extra timeout/abort AC is added to the full US-012. The preservation survives, not just the long analysis discussion. |
| 8 | Invocation-local semantic budgets and per-hop hard cap | Lines **199–212,421–423,638,861–867**. | US-012 description **L699** retains the invocation-local spent-shape counter, wrapper ordering/offsets, strategy resolved once, **3+C per completed hop** and unchanged **21-send per-hop ceiling**. **AC13–21 L713–721** retain progress/budget isolation, stopped coverage, cross-hop repair exhaustion and transport exclusion; no cross-hop availability cap is invented. |
| 9 | All corrected concrete locus tokens | Existing review W2: spec **649,706,742,782,790,849–850,852–854,856–859,861–867,880,884–885**. | **24/24** source criteria map to criteria below with the same relevant callable/field/enum identifiers. In particular the reworded US-005 AC18 names `proc.exited`/`runQualityCommand`; US-012 AC5/6 names real `callOp`/`workflowBranchReviewOp.retry` and clarifies the decision boundary; US-013 AC12/13 preserves `workflowBranchReviewOp.retry` while explicitly requiring real `callOp`. |
| 10 | Single repeat-100 / silence-0 default and strict opt-in policy | Lines **52–59,101–111,321–327,645–679**. | US-001 description **L11** includes the policy/default/interface, US-002 description **L66** explicitly retains single-source defaults/root parsed spread and the full user config example. **L68–78** preserve default/validation/zero/partial-merge runtime assertions. Feature exclusion **L837** still prohibits default-enabled silence. |
| 11 | Correct CLI wire entry, not internal gate record | Line **255** and US-008 CLI criteria **791–793**. | US-008 description **L434** names **GateReportEntry**, adding only optional `stopReason`, excluding cwd/raw output and retaining passed-tail omission, exit **0/2/1**, one JSON document and plain notice. **AC18–20 L453–455** and **L499–500** preserve CLI outcomes and bounded edit permission. No internal-record schema is substituted for the wire entry. |
| 12 | Accurate size and atomic split survival | Lines **261–279**, eight compound bullets identified there. | Exactly **215** rows with counts shown above; US-012 **24**. Eight splits retain all effects, including empty-group escalation/timers/readers, summary carry/render, factory call/returned-wrapper control and rejected-array/no-hook effects. All descriptions remain below 3000 characters. |
| 13 | Full gate wiring, low-level opt-out, mixed-list evidence | Lines **163–191,683–795**. | US-003/005 preserve no-policy monitor opt-out, terminal ownership and bounded cleanup. US-004 **L190–205** preserves both list orders and timeout routing before zero-tests fallback. US-007/008 preserve resolver/setup/bot/provenance/CLI/review forwarding. No excluded bootstrap/baseline/agent-tool owner gains a default policy; exclusions **L840–841** remain intact. |
| 14 | Honest findings/readiness/counts and historical compatibility | Lines **228–241,798–834,837–844**. | US-009 **L515–534**, US-010 **L589–603**, and US-011 **L648–657** retain real/promoted work, mismatch persistence/resume/clear ownership, exact stable sentences, draft hold, independent reasons and unchanged success/count semantics. The historical no-reason assertion is correctly qualified to otherwise-green facts/no branch-mismatch reason, not suppression of unrelated reasons. |

## Re-encoded assertions and targeted grounding

These checks evaluate planner-introduced wording/seam risks only. They do not re-review the approved spec or treat proposed new APIs as missing existing code.

1. **US-004 AC9 — execution, not selection metadata.** Spec **L714** says package policy goes into scoped selection; PRD **L198** explicitly identifies `regression` execution of the command returned by `selectScopedTests`. The approved Design already routes this via regression (**L173**). Current `operations/verify-scoped.ts:284–310` builds the regression options and invokes `runTests(selection.effectiveCommand)`; the ordinary zero-tests rerun uses the same local helper (**332**). The PRD does not invent a policy argument to the metadata selector. This preserves the intended execution assertion rather than introducing an unreachable selector seam.
2. **US-005 AC18 — rejection is not stall evidence.** Spec **L742** preserves existing rejection policy; PRD **L275** spells out its result only when rejection precedes a stop. Current `quality/runner.ts:287–294` has the floating suppression, **318** awaits exit, and **383–394** returns the existing non-timeout error result. The concrete result tuple and rejection message are grounded; the criterion neither repairs rejected-exit handling nor labels it a stall.
3. **US-009 historical readiness split.** Spec **L815** splits to PRD **L533–534**, preserving no added mismatch reason and unchanged counts. Current `workflow/approval.ts:123–137` assembles independent gate/CI/story/review reasons; the PRD's otherwise-green qualification correctly avoids suppressing these. No new readiness behavior is introduced.
4. **US-012 corrected-clean/real-blocker and factory splits.** Spec **L852–853,869** maps to PRD **L705–706,722–723**. `RetryDecision` in `agents/retry/types.ts:5–7` permits `retry:false` and optional `fallback`; `workflow-branch-review.ts:78–119` resolves a strategy, not a verdict. `call.ts:41–64` reaches `dispatchRunOp`; `call-dispatch-run.ts:103` resolves the strategy once and **279–341** calls `shouldRetry`, records fallback and sends its prompt. `coverage-retry.ts:75–119` confirms the clean/full-coverage stop path. Thus retry decisions and wrapper-returned prompt control are observable at real `callOp`; delivery is not smuggled into US-012. Existing invocation wording elsewhere is preserved rather than split into a new impossible entry/helper path.
5. **US-013 real-dispatch coverage and hook seam.** Spec **L884–885** becomes explicit real-callOp delivered-value coverage at PRD **L784–785**, consistent with the approved Design **L225**. Current `call-dispatch-run.ts:461–477` parses then reaches `runPostParse`, and **396–408,499–506** shows the separate broad legacy throwing fallback. `post-parse.ts:26–45` calls verify with the parsed value and recover only on null. The proposed opt-in substitution must precede those hooks; the PRD description explicitly prevents the existing catch from swallowing strict-validation errors. No five-argument or otherwise fabricated call signature is introduced.

Other clarified bullets spell out already-approved concrete contracts: US-002 AC9's schema/default block, US-003 AC2's raw flags, US-010 AC1/2's stable sentences. All eight atomic splits retain their original preconditions and independent effects. No orphan assertion or new material scope was found.

## File roles, exclusions, forward names and cleanup

- Compared per-story path arrays, not only totals. All **62 Context Files**, **9 Creates** and **31 Modifies** entries match their owning story; each modified entry has its own populated path/reason, with **31/31 reasons verbatim**. There are no swallowed multi-path permissions and no unexplained extra context hints. No self-created file is context. There are **0 upstream-created context entries in this particular spec**; if present, such entries would legitimately remain consumer context when dependency order supplies them, not be treated as self-created files.
- The **11 feature exclusions** exactly equal PRD **L833–843**, including bundle ownership, silence opt-in, no invented/waived findings, no silencing real work, detector semantics, output/schema bounds, excluded subprocess owners, exit-rejection preservation, platform/dependency limits and no implementation writes to repository `.nax/`. None becomes work to perform. Scope-Out descriptions were checked against those exclusions; no contradiction, unprefixed story waiver or orphan exclusion was found.
- Re-swept the **20 forward-name rows** from spec **L48–69**: `GateStallPolicy`, `GateStopReason`, `GateStallMonitor`, `createGateStallMonitor`, `DEFAULT_GATE_STALL_POLICY`, `resolveStallDetection`, `StallDetectionConfigSchema`, `stallDetection`, `stopReason`, `timedOut`, `makeMismatchClarificationStrategy`, `MismatchClarificationOpts`, `buildWorkflowBranchVerdictMismatchRetry`, `preferRetryFallbackOnNullParse`, `reviewMismatch`, `branchReviewMismatch`, `branchMismatchReasons`, `isPlainRecord`, `_branchReviewRetryDeps`, `_approvalDeps`. All names survive in descriptions/ACs with consistent spellings and correct producer/consumer roles. In particular persisted `reviewMismatch` and readiness input `branchReviewMismatch` remain intentionally distinct, not accidental aliases; the CLI uses `GateReportEntry` rather than widening its internal record.
- The approved spec has **no terminal deletion story**. US-011's obsolete floor marker/helper/import cleanup is natural cleanup already authorized by its description and Modifies entries. It is not transformed into destructive file-content criteria or an invented cleanup story. Runtime assertions remain behavioral; normal build/static gates remain the implementation verification route, not new source-text ACs.

## Complete AC crosswalk

Each row names one spec bullet, its physical line, every PRD destination and its physical line. “Preserved” includes only backtick/whitespace normalization; “Clarified” entries were examined semantically and grounded where needed above. This table covers **all 206 source bullets and all 215 destinations**, not a similarity sample.

### US-001

| Spec criterion / line / subject | PRD criterion / line | Fidelity |
| --- | --- | --- |
| AC1 / L645 — createGateStallMonitor emits repeated-output on the Nth consecutive equal eligi… | AC1 / L13 | Preserved |
| AC2 / L646 — createGateStallMonitor keeps stdout and stderr repetition counts independent un… | AC2 / L14 | Preserved |
| AC3 / L647 — createGateStallMonitor resets a stream's repetition count on a different eligib… | AC3 / L15 | Preserved |
| AC4 / L648 — createGateStallMonitor resets a stream's repetition count on a whitespace-only … | AC4 / L16 | Preserved |
| AC5 / L649 — createGateStallMonitor never counts a whitespace-only line toward a stop. | AC5 / L17 | Preserved |
| AC6 / L650 — createGateStallMonitor compares decoded text exactly, so indentation, trailing … | AC6 / L18 | Preserved |
| AC7 / L651 — createGateStallMonitor produces the same line decisions for arbitrarily split U… | AC7 / L19 | Preserved |
| AC8 / L652 — createGateStallMonitor treats a CRLF delimiter split across chunks as one delim… | AC8 / L20 | Preserved |
| AC9 / L653 — createGateStallMonitor treats a bare CR as ordinary content rather than a delim… | AC9 / L21 | Preserved |
| AC10 / L654 — createGateStallMonitor.end treats a nonempty unterminated tail as one final lin… | AC10 / L22 | Preserved |
| AC11 / L655 — createGateStallMonitor ignores an over-16,384-code-unit line through its delimi… | AC11 / L23 | Preserved |
| AC12 / L656 — createGateStallMonitor with positive silenceTimeoutSeconds emits silence after … | AC12 / L24 | Preserved |
| AC13 / L657 — createGateStallMonitor resets silence on a nonempty chunk on either stream, inc… | AC13 / L25 | Preserved |
| AC14 / L658 — createGateStallMonitor does not reset silence on an empty chunk. | AC14 / L26 | Preserved |
| AC15 / L659 — createGateStallMonitor does not reset silence at stream EOF. | AC15 / L27 | Preserved |
| AC16 / L660 — createGateStallMonitor with both policy values zero emits no stop while fake ti… | AC16 / L28 | Preserved |
| AC17 / L661 — createGateStallMonitor with repeated lines arriving before each silence deadlin… | AC17 / L29 | Preserved |
| AC18 / L662 — createGateStallMonitor.dispose prevents later callbacks from emitting a stop. | AC18 / L30 | Preserved |
| AC19 / L663 — createGateStallMonitor.dispose leaves no active silence timer. | AC19 / L31 | Preserved |
| AC20 / L664 — Two createGateStallMonitor instances maintain isolated counters and silence dea… | AC20 / L32 | Preserved |
| AC21 / L665 — resolveStallDetection fills an absent field from DEFAULT_GATE_STALL_POLICY and … | AC21 / L33 | Preserved |

### US-002

| Spec criterion / line / subject | PRD criterion / line | Fidelity |
| --- | --- | --- |
| AC1 / L669 — NaxConfigSchema.parse with quality absent resolves stallDetection.repeatedLineT… | AC1 / L68 | Preserved |
| AC2 / L670 — NaxConfigSchema.parse with quality absent resolves stallDetection.silenceTimeou… | AC2 / L69 | Preserved |
| AC3 / L671 — An empty quality block resolves the same policy as an absent quality block. | AC3 / L70 | Preserved |
| AC4 / L672 — StallDetectionConfigSchema accepts repeatedLineThreshold 0. | AC4 / L71 | Preserved |
| AC5 / L673 — StallDetectionConfigSchema accepts an integer repeatedLineThreshold of 2 or more. | AC5 / L72 | Preserved |
| AC6 / L674 — StallDetectionConfigSchema rejects repeatedLineThreshold 1, negatives, fraction… | AC6 / L73 | Preserved |
| AC7 / L675 — StallDetectionConfigSchema accepts silenceTimeoutSeconds 0 and a positive integer. | AC7 / L74 | Preserved |
| AC8 / L676 — StallDetectionConfigSchema rejects negative, fractional, non-numeric, null, boo… | AC8 / L75 | Preserved |
| AC9 / L677 — The root quality literal carries the block, so DEFAULT_CONFIG and a whole-confi… | AC9 / L76 | Clarified; assertion retained |
| AC10 / L678 — mergePackageConfig retains an unset root-policy sibling when a package override… | AC10 / L77 | Preserved |
| AC11 / L679 — mergePackageConfig honors an explicit package zero over a non-zero root value. | AC11 / L78 | Preserved |

### US-003

| Spec criterion / line / subject | PRD criterion / line | Fidelity |
| --- | --- | --- |
| AC1 / L683 — executeWithTimeout with an explicit repetition policy feeds controlled stdout a… | AC1 / L125 | Preserved |
| AC2 / L684 — executeWithTimeout on repeated-output or opted-in silence returns success false… | AC2 / L126 | Clarified; assertion retained |
| AC3 / L685 — That raw stopped result carries the matching structured stopReason. | AC3 / L127 | Preserved |
| AC4 / L686 — executeWithTimeout detector-stop error starts with EXECUTION_STALLED: and ident… | AC4 / L128 | Preserved |
| AC5 / L687 — executeWithTimeout leaves stopReason absent on an ordinary wall timeout. | AC5 / L129 | Preserved |
| AC6 / L688 — executeWithTimeout leaves stopReason absent on a normal exit. | AC6 / L130 | Preserved |
| AC7 / L689 — executeWithTimeout leaves stopReason absent on a stream error or a drain-deadli… | AC7 / L131 | Preserved |
| AC8 / L690 — executeWithTimeout with no stallDetection argument retains a quiet live process… | AC8 / L132 | Preserved |
| AC9 / L691 — executeWithTimeout with no stallDetection argument creates no monitor, so no de… | AC9 / L133 | Preserved |
| AC10 / L692 — executeWithTimeout uses one SIGTERM-to-SIGKILL group-cleanup sequence when dete… | AC10 / L134 | Preserved |
| AC11 / L693 — executeWithTimeout SIGKILLs surviving group members after leader exit with sing… | AC11 / L135 | Preserved |
| AC12 / L694 — executeWithTimeout cancels escalation when its stopped process group is empty a… | AC12 / L136; AC13 / L137; AC14 / L138 | Atomic split; all effects retained |
| AC13 / L695 — executeWithTimeout preserves a normal leader result when exit is observed befor… | AC15 / L139 | Preserved |
| AC14 / L696 — executeWithTimeout keeps timeout failure when detector stop is observed before … | AC16 / L140 | Preserved |
| AC15 / L697 — executeWithTimeout starts no second termination sequence when a later stop or d… | AC17 / L141 | Preserved |
| AC16 / L698 — executeWithTimeout retains already-collected stdout then stderr when a stream e… | AC18 / L142 | Preserved |
| AC17 / L699 — executeWithTimeout does not reclassify a normal exit as a detector stop when a … | AC19 / L143 | Preserved |
| AC18 / L700 — executeWithTimeout drains simultaneous output larger than an OS pipe buffer wit… | AC20 / L144 | Preserved |
| AC19 / L701 — executeWithTimeout captured output text is unchanged by detector normalization. | AC21 / L145 | Preserved |
| AC20 / L702 — executeWithTimeout refuses an untrusted cwd before creating a monitor or spawni… | AC22 / L146 | Preserved |

### US-004

| Spec criterion / line / subject | PRD criterion / line | Fidelity |
| --- | --- | --- |
| AC1 / L706 — The scoped and regression verification list runs every entry in command order a… | AC1 / L190 | Preserved |
| AC2 / L707 — In the failure-then-stop order, list status, exitCode and error remain the firs… | AC2 / L191 | Preserved |
| AC3 / L708 — In the stop-then-failure order, list status, exitCode and error remain the firs… | AC3 / L192 | Preserved |
| AC4 / L709 — Both orders expose the first detector reason in command order as the list stopR… | AC4 / L193 | Preserved |
| AC5 / L710 — countsTowardEscalation keeps its any-entry semantics in both orders. | AC5 / L194 | Preserved |
| AC6 / L711 — A list with no stopped entry carries no stopReason. | AC6 / L195 | Preserved |
| AC7 / L712 — scoped and regression pass their configured stallDetection into the executor. | AC7 / L196 | Preserved |
| AC8 / L713 — scoped and regression retain status:TIMEOUT and countsTowardEscalation false on… | AC8 / L197 | Preserved |
| AC9 / L714 — verifyScopedOp.execute forwards package-view stallDetection into scoped selection. | AC9 / L198 | Clarified; assertion retained |
| AC10 / L715 — verifyScopedOp.execute forwards the same policy into its ordinary zero-tests fu… | AC10 / L199 | Preserved |
| AC11 / L716 — verifyScopedOp.execute returns status timeout with the stopReason when the scop… | AC11 / L200 | Preserved |
| AC12 / L717 — verifyScopedOp.execute starts no zero-tests full-suite rerun when the aggregate… | AC12 / L201 | Preserved |
| AC13 / L718 — fullSuiteGateOp.execute forwards gate-context stallDetection to regression. | AC13 / L202 | Preserved |
| AC14 / L719 — fullSuiteGateOp.execute derives its timeout evidence from a list-level stop rea… | AC14 / L203 | Preserved |
| AC15 / L720 — fullSuiteGateOp.execute keeps the acceptOnTimeout passed-on-timeout and timeout… | AC15 / L204 | Preserved |
| AC16 / L721 — runWorkflowSuiteGate reports a stopped full suite as red and timed out even whe… | AC16 / L205 | Preserved |

### US-005

| Spec criterion / line / subject | PRD criterion / line | Fidelity |
| --- | --- | --- |
| AC1 / L725 — runQualityCommand with explicit stallDetection feeds live child chunks into cre… | AC1 / L258 | Preserved |
| AC2 / L726 — runQualityCommand detector interruption returns success false, timedOut true, e… | AC2 / L259 | Preserved |
| AC3 / L727 — runQualityCommand harness output identifies stopped-early repeated-output or si… | AC3 / L260 | Preserved |
| AC4 / L728 — runQualityCommand stopped harness output does not expose partial test diagnosti… | AC4 / L261 | Preserved |
| AC5 / L729 — runQualityCommand agent-tool output retains the existing bounded line-boundary … | AC5 / L262 | Preserved |
| AC6 / L730 — An ordinary agent-tool call with no policy remains detector-disabled. | AC6 / L263 | Preserved |
| AC7 / L731 — runQualityCommand with no stallDetection argument retains existing normal-exit … | AC7 / L264 | Preserved |
| AC8 / L732 — runQualityCommand detector interruption preserves group escalation after leader… | AC8 / L265 | Preserved |
| AC9 / L733 — runQualityCommand clears all armed timers by the existing drain deadline after … | AC9 / L266 | Preserved |
| AC10 / L734 — runQualityCommand cancels stalled readers best-effort by the existing drain dea… | AC10 / L267 | Preserved |
| AC11 / L735 — runQualityCommand returns the observed normal exit result when leader exit wins… | AC11 / L268 | Preserved |
| AC12 / L736 — runQualityCommand retains detector failure when the detector callback wins over… | AC12 / L269 | Preserved |
| AC13 / L737 — Repetition, silence and wall callbacks collectively start at most one terminati… | AC13 / L270 | Preserved |
| AC14 / L738 — runQualityCommand stream errors preserve text already collected without produci… | AC14 / L271 | Preserved |
| AC15 / L739 — runQualityCommand consumes both pipes concurrently without losing a large nonre… | AC15 / L272 | Preserved |
| AC16 / L740 — runQualityCommand returns the stopped result after bounded grace and bounded dr… | AC16 / L273 | Preserved |
| AC17 / L741 — runQualityCommand performs the existing trust check before creating a monitor o… | AC17 / L274 | Preserved |
| AC18 / L742 — runQualityCommand keeps the existing floating .catch behavior when proc.exited … | AC18 / L275 | Clarified; assertion retained |

### US-006

| Spec criterion / line / subject | PRD criterion / line | Fidelity |
| --- | --- | --- |
| AC1 / L746 — runQualityCommand gives every list entry fresh repetition and silence state. | AC1 / L323 | Preserved |
| AC2 / L747 — runQualityCommand continues later list entries after a stopped entry. | AC2 / L324 | Preserved |
| AC3 / L748 — aggregateResults exposes the first detector stopReason in command order. | AC3 / L325 | Preserved |
| AC4 / L749 — aggregateResults preserves the first non-zero step's exit code. | AC4 / L326 | Preserved |
| AC5 / L750 — aggregateResults preserves any-entry timedOut semantics. | AC5 / L327 | Preserved |
| AC6 / L751 — aggregateResults preserves summed duration and every entry's output. | AC6 / L328; AC7 / L329 | Atomic split; all effects retained |

### US-007

| Spec criterion / line / subject | PRD criterion / line | Fidelity |
| --- | --- | --- |
| AC1 / L755 — resolveGateCommands attaches the root's resolved policy to root commands. | AC1 / L367 | Preserved |
| AC2 / L756 — resolveGateCommands attaches the field-wise merged overlay policy to eligible p… | AC2 / L368 | Preserved |
| AC3 / L757 — resolveGateCommands keeps root-key precedence unchanged when an overlay names t… | AC3 / L369 | Preserved |
| AC4 / L758 — resolveGateCommands includes the resolved policy in overlay run identity, so id… | AC4 / L370 | Preserved |
| AC5 / L759 — resolveGateCommands still deduplicates overlay gates whose resolved policies ar… | AC5 / L371 | Preserved |
| AC6 / L760 — runRepoGates reaches runQualityCommand with the resolved policy for configured … | AC6 / L372 | Preserved |
| AC7 / L761 — runRepoGates reaches resolveStallDetection through _qualityGateDeps for a confi… | AC7 / L373 | Preserved |
| AC8 / L762 — runQualityGates gives a manually constructed GateCommand with no policy DEFAULT… | AC8 / L374 | Preserved |
| AC9 / L763 — runQualityGates honors an explicit both-zero policy instead of the default. | AC9 / L375 | Preserved |
| AC10 / L764 — runQualityGates classifies detector-stopped exit -1 as timed-out. | AC10 / L376 | Preserved |
| AC11 / L765 — runQualityGates copies the stopReason to the gate record. | AC11 / L377 | Preserved |
| AC12 / L766 — runQualityGates continues subsequent gates after a stopped gate. | AC12 / L378 | Preserved |
| AC13 / L767 — A gate record carries stopReason only when a detector stopped the run. | AC13 / L379 | Preserved |
| AC14 / L768 — runQualityGates passes the e2e gate's policy to its setup command. | AC14 / L380 | Preserved |
| AC15 / L769 — A stopped e2e setup yields that gate's timed-out record with failedPhase setup. | AC15 / L381 | Preserved |
| AC16 / L770 — The e2e journey does not start after a stopped setup. | AC16 / L382 | Preserved |

### US-008

| Spec criterion / line / subject | PRD criterion / line | Fidelity |
| --- | --- | --- |
| AC1 / L774 — runStoryGates passes the package-view stallDetection to lint, including manifes… | AC1 / L436 | Preserved |
| AC2 / L775 — runStoryGates reports a stopped lint command in GateRunResult.timedOut. | AC2 / L437 | Preserved |
| AC3 / L776 — runStoryGates passes the package-view stallDetection to typecheck. | AC3 / L438 | Preserved |
| AC4 / L777 — runStoryGates reports a stopped typecheck command in GateRunResult.timedOut. | AC4 / L439 | Preserved |
| AC5 / L778 — runStoryGates keeps a green lint or typecheck gate out of the timed-out list. | AC5 / L440 | Preserved |
| AC6 / L779 — runReview mechanical checks pass the provided config policy to the quality runner. | AC6 / L441 | Preserved |
| AC7 / L780 — runScopedLintCheck template, full and degraded paths pass the same policy. | AC7 / L442 | Preserved |
| AC8 / L781 — runScopedLintCheck's supported derived-command arm — no template, no degraded r… | AC8 / L443 | Preserved |
| AC9 / L782 — runReview with no full config gets the schema-derived policy rather than detect… | AC9 / L444 | Preserved |
| AC10 / L783 — runSetupGate forwards the supplied config policy to its verification command. | AC10 / L445 | Preserved |
| AC11 / L784 — runSetupGate returns the existing nonzero result when the command is stopped. | AC11 / L446 | Preserved |
| AC12 / L785 — resolveBotChecks preserves a configured gate's policy when projecting trusted s… | AC12 / L447 | Preserved |
| AC13 / L786 — resolveBotChecks attaches the trusted input-config policy to instruction-derive… | AC13 / L448 | Preserved |
| AC14 / L787 — resolveBotChecks attaches the same trusted policy to detection-derived gates. | AC14 / L449 | Preserved |
| AC15 / L788 — Bot gatesStep retains the reviewed gate policy while mapping execution to the c… | AC15 / L450 | Preserved |
| AC16 / L789 — failingOnHead retains the reviewed gate policy when running the baseline on the… | AC16 / L451 | Preserved |
| AC17 / L790 — Neither bot gatesStep nor failingOnHead rereads the policy from the fixed tree. | AC17 / L452 | Preserved |
| AC18 / L791 — gatesRunCommand with a stopped configured gate returns exit 2. | AC18 / L453 | Preserved |
| AC19 / L792 — gatesRunCommand writes one JSON document containing that gate's structured stop… | AC19 / L454 | Preserved |
| AC20 / L793 — gatesRunCommand plain output shows the reason in that gate's output. | AC20 / L455 | Preserved |
| AC21 / L794 — runStoryGates with an enabled detector and controlled child streams surfaces an… | AC21 / L456 | Preserved |

### US-009

| Spec criterion / line / subject | PRD criterion / line | Fidelity |
| --- | --- | --- |
| AC1 / L798 — branchReviewStep writes the branch-review artifact with real assigned finding i… | AC1 / L515 | Preserved |
| AC2 / L799 — withQualityFloor adds no draft of its own: B ids come from the verdict's blocki… | AC2 / L516; AC3 / L517 | Atomic split; all effects retained |
| AC3 / L800 — A quality changes verdict with no blocking finding and no promoted minor issues… | AC4 / L518 | Preserved |
| AC4 / L801 — runFeatureMachine dispatches no branch fix for mismatch-only evidence. | AC5 / L519 | Preserved |
| AC5 / L802 — runFeatureMachine recognizes spec-fail-without-evidence on a directly injected … | AC6 / L520 | Preserved |
| AC6 / L803 — runFeatureMachine recognizes changes-without-a-blocking-finding on a directly i… | AC7 / L521 | Preserved |
| AC7 / L804 — runFeatureMachine persists reviewMismatch.kinds in spec then quality order. | AC8 / L522 | Preserved |
| AC8 / L805 — runFeatureMachine keeps reviewRan true for a parseable inconsistent review. | AC9 / L523 | Preserved |
| AC9 / L806 — runFeatureMachine still fixes real blocking findings and gate findings alongsid… | AC10 / L524 | Preserved |
| AC10 / L807 — runFeatureMachine still fixes fix-now minors alongside a mismatch. | AC11 / L525 | Preserved |
| AC11 / L808 — runFeatureMachine still assigns B ids to promoted minors alongside a mismatch. | AC12 / L526 | Preserved |
| AC12 / L809 — runFeatureMachine retains a spec mismatch when a quality minor is promoted. | AC13 / L527 | Preserved |
| AC13 / L810 — branchMismatchReasons emits each applicable stable sentence once, in spec then … | AC14 / L528 | Preserved |
| AC14 / L811 — runFeatureMachine's branch-review step obtains those sentences through _approva… | AC15 / L529 | Preserved |
| AC15 / L812 — runFeatureMachine resumed downstream of branch review retains mismatch evidence… | AC16 / L530 | Preserved |
| AC16 / L813 — A newly consistent full branch review clears stale reviewMismatch evidence. | AC17 / L531 | Preserved |
| AC17 / L814 — A downstream finding re-review does not clear reviewMismatch. | AC18 / L532 | Preserved |
| AC18 / L815 — A historical record lacking reviewMismatch produces no readiness reason and unc… | AC19 / L533; AC20 / L534 | Atomic split; all effects retained |

### US-010

| Spec criterion / line / subject | PRD criterion / line | Fidelity |
| --- | --- | --- |
| AC1 / L819 — readinessReasons yields the exact spec mismatch sentence for the spec kind. | AC1 / L589 | Clarified; assertion retained |
| AC2 / L820 — readinessReasons yields the exact quality mismatch sentence for the quality kind. | AC2 / L590 | Clarified; assertion retained |
| AC3 / L821 — readinessReasons yields both sentences in spec then quality order when both kin… | AC3 / L591 | Preserved |
| AC4 / L822 — readinessReasons preserves independent unread-file, gate, CI, skipped-review an… | AC4 / L592 | Preserved |
| AC5 / L823 — Production publish with green gates, green CI and an approving advisor double l… | AC5 / L593 | Preserved |
| AC6 / L824 — That publish path never asks finish approval to overrule the deterministic mism… | AC6 / L594 | Preserved |
| AC7 / L825 — Production publish retains the mismatch reason under local-only mode without in… | AC7 / L595 | Preserved |
| AC8 / L826 — Production publish retains the mismatch reason under push-only mode without inv… | AC8 / L596 | Preserved |
| AC9 / L827 — Production publish obtains the mismatch readiness reason through _approvalDeps.… | AC9 / L597 | Preserved |
| AC10 / L828 — The sentence _approvalDeps.branchMismatchReasons returns during that publish ca… | AC10 / L598 | Preserved |
| AC11 / L829 — buildWorkflowRunSummary reports zero added branch findings for mismatch-only ev… | AC11 / L599 | Preserved |
| AC12 / L830 — buildWorkflowRunSummary carries the published mismatch reason and formatWorkflo… | AC12 / L600; AC13 / L601 | Atomic split; all effects retained |
| AC13 / L831 — buildOpenItems represents a persisted publish mismatch reason as a reason item … | AC14 / L602 | Preserved |
| AC14 / L832 — Mismatch-only readiness leaves workflowPassed and RunResult.success unchanged. | AC15 / L603 | Preserved |

### US-011

| Spec criterion / line / subject | PRD criterion / line | Fidelity |
| --- | --- | --- |
| AC1 / L836 — parseBranchReviewReply returns the spec mismatch for a fail verdict with no cri… | AC1 / L648 | Preserved |
| AC2 / L837 — parseBranchReviewReply preserves only the real drafts when the reply has no fin… | AC2 / L649 | Preserved |
| AC3 / L838 — parseBranchReviewReply preserves only the real drafts when findings were droppe… | AC3 / L650 | Preserved |
| AC4 / L839 — parseBranchReviewReply preserves only the real drafts when findings are minor-o… | AC4 / L651 | Preserved |
| AC5 / L840 — parseBranchReviewReply returns the quality mismatch for a changes verdict with … | AC5 / L652 | Preserved |
| AC6 / L841 — parseBranchReviewReply adds no important quality draft for that case. | AC6 / L653 | Preserved |
| AC7 / L842 — parseBranchReviewReply reports both mismatch kinds once in spec then quality or… | AC7 / L654 | Preserved |
| AC8 / L843 — parseBranchReviewReply preserves concrete blocking findings and the existing kn… | AC8 / L655; AC9 / L656 | Atomic split; all effects retained |
| AC9 / L844 — parseBranchReviewReply still returns null for a malformed verdict shape. | AC10 / L657 | Preserved |

### US-012

| Spec criterion / line / subject | PRD criterion / line | Fidelity |
| --- | --- | --- |
| AC1 / L848 — callOp(workflowBranchReviewOp) sends exactly one mismatch clarification when a … | AC1 / L701 | Preserved |
| AC2 / L849 — callOp(workflowBranchReviewOp) issues that clarification on the initial review'… | AC2 / L702 | Preserved |
| AC3 / L850 — buildWorkflowBranchVerdictMismatchRetry's clarification text asks for the faile… | AC3 / L703 | Preserved |
| AC4 / L851 — The clarification requires the complete branch-review object naming findings, i… | AC4 / L704 | Preserved |
| AC5 / L852 — callOp(workflowBranchReviewOp) accepts a corrected clean verdict with no fix ta… | AC5 / L705 | Clarified; assertion retained |
| AC6 / L853 — workflowBranchReviewOp.retry returns real blocking work for the clarified reply… | AC6 / L706 | Clarified; assertion retained |
| AC7 / L854 — A persistently inconsistent reply receives no second mismatch clarification fro… | AC7 / L707 | Preserved |
| AC8 / L855 — workflowBranchReviewOp.retry reports the last parseable reply, with its mismatc… | AC8 / L708 | Preserved |
| AC9 / L856 — workflowBranchReviewOp.retry repairs a malformed clarification only with the re… | AC9 / L709 | Preserved |
| AC10 / L857 — workflowBranchReviewOp.retry clarifies an initially inconsistent and incomplete… | AC10 / L710 | Preserved |
| AC11 / L858 — workflowBranchReviewOp.retry keeps the configured coverageRetries allowance for… | AC11 / L711 | Preserved |
| AC12 / L859 — Those post-clarification coverage prompts from workflowBranchReviewOp.retry kee… | AC12 / L712 | Preserved |
| AC13 / L860 — workflowBranchReviewOp.retry measures coverage no-progress only against respons… | AC13 / L713 | Preserved |
| AC14 / L861 — workflowBranchReviewOp.retry spends no coverageRetries budget on a clarificatio… | AC14 / L714 | Preserved |
| AC15 / L862 — workflowBranchReviewOp.retry cannot reset an active coverage allowance with a c… | AC15 / L715 | Preserved |
| AC16 / L863 — workflowBranchReviewOp.retry cannot reopen a stopped coverage state with a clar… | AC16 / L716 | Preserved |
| AC17 / L864 — A mismatch first introduced by a coverage response is clarified by workflowBran… | AC17 / L717 | Preserved |
| AC18 / L865 — workflowBranchReviewOp.retry does not suppress the unspent clarification on cov… | AC18 / L718 | Preserved |
| AC19 / L866 — For coverage allowance C, callOp(workflowBranchReviewOp) sends no more than 3+C… | AC19 / L719 | Preserved |
| AC20 / L867 — workflowBranchReviewOp.retry issues no JSON repair in a manager fallback hop wh… | AC20 / L720 | Preserved |
| AC21 / L868 — No clarification, JSON or coverage prompt is sent for an adapterFailure transpo… | AC21 / L721 | Preserved |
| AC22 / L869 — workflowBranchReviewOp.retry obtains its clarification wrapper from _branchRevi… | AC22 / L722; AC23 / L723 | Atomic split; all effects retained |
| AC23 / L870 — The clarification prompt callOp sends is the output of the captured _branchRevi… | AC24 / L724 | Preserved |

### US-013

| Spec criterion / line / subject | PRD criterion / line | Fidelity |
| --- | --- | --- |
| AC1 / L874 — With preferRetryFallbackOnNullParse set, callOp returns the strategy's plain-re… | AC1 / L773 | Preserved |
| AC2 / L875 — That opt-in result passes the fallback object to a declared verify as the value… | AC2 / L774 | Preserved |
| AC3 / L876 — recover runs for that opt-in result only when that verify returns null. | AC3 / L775 | Preserved |
| AC4 / L877 — A fallback record whose prototype is null is substituted as the parsed value un… | AC4 / L776 | Preserved |
| AC5 / L878 — An array fallback under the flag raises CALL_OP_INVALID_FALLBACK before any pos… | AC5 / L777; AC6 / L778 | Atomic split; all effects retained |
| AC6 / L879 — A class-instance fallback under the flag raises CALL_OP_INVALID_FALLBACK and su… | AC7 / L779 | Preserved |
| AC7 / L880 — Under preferRetryFallbackOnNullParse, callOp leaves the null parse result intac… | AC8 / L780 | Preserved |
| AC8 / L881 — With the flag set and no parseable reply, runBranchReview reports skipped revie… | AC9 / L781 | Preserved |
| AC9 / L882 — runBranchReview receives the last parseable inconsistent review as the branch v… | AC10 / L782 | Preserved |
| AC10 / L883 — Through real callOp(workflowBranchReviewOp), a parseable inconsistent verdict f… | AC11 / L783 | Preserved |
| AC11 / L884 — workflowBranchReviewOp.retry keeps the real findings of the last-parseable verd… | AC12 / L784 | Clarified; assertion retained |
| AC12 / L885 — workflowBranchReviewOp.retry also keeps the mismatch kinds carried by that last… | AC13 / L785 | Clarified; assertion retained |
| AC13 / L886 — An operation without the flag whose parse throws keeps today's precedence, retu… | AC14 / L786 | Preserved |


## Handoff

**READY — Phase 9 only: 0 blockers, 0 majors, 0 minors.** No spec/PRD changes are requested. This does not claim phases 1–8 were rerun or that implementation tests pass. The parent may handle the separately authorized commit/approval-tool run; this reviewer has not launched it.
