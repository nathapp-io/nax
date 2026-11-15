# Read-only spec revalidation — Review and gate guards

**Verdict: NOT READY. Planning remains blocked.**

**Reviewed against:** `repos/nax` at `7d50765120eeb862b8a700bd6ee533839cb895b6`.
**Date:** 2026-11-15.
**Inputs read completely:** current `spec.md` (860 lines) and latest `spec-review.md` (227 lines).
**Spec SHA-256:** `207e8275bf45c7bf6be8c7d7ce0c03b624d1a4bd11fd49827c3ca5f912b82811`.
**Prior report SHA-256:** `31fe392dc54ed82c1fd2d5c71569d5ab438f55093489fabe39982cfb535b5d33`.
**Phases executed:** **3 of 9: 1, blocked 2, and the mandatory Phase 4 exception.** Phase 3 and Phases 5–8 remain **HALTED**, not passed. Requested D1/D2 diagnostics were independently revalidated, without representing them as completion of those later phases. Phase 9 is inapplicable: there is no PRD.
**Current findings:** four blockers (B1, B2, D1, D2), three majors (M1–M3). All seven prior findings are confirmed, with qualifications below; none is withdrawn.
**Deadlock roll-up:** 1 story DEADLOCK LIKELY, 12 AT RISK, 0 CLEAR. Incomplete later phases are not clearance.

## Scope and method

- Loaded `repos/nax-spec-kit-skills/skills/spec-review/SKILL.md` and all eight applicable phase checklists completely. No Phase 9 checklist is applicable. The stop-the-line rule is binding; this is not a third fix round.
- Ran git diff/status in `repos/nax`: no tracked product changes; the feature directory is untracked. The initial enclosing-workspace diff was unrelated and excluded.
- Graph and memory tools are not exposed in this session. Used direct reads/searches in this repository only. No substitute repository/index was used.
- Accepted the supplied successful spec lint: 0 errors, one advisory (13 stories > target 7); did not rerun it. Independently read `.nax/config.json:4–8`, confirming **maxAcCount=24**. Accepted the resolved description limits of **3,000 characters / 12 bullets**. These are not a 19-markdown-bullet allowance or a seven-story hard cap.
- The approved **single #2924/#2923 bundle is not reopened**. Silence remains explicitly opt-in, default 0; there is no finding against that choice.
- No spec/product/PRD edits, commits, plan/run/bot, paid service, agent session, or coverage run. The only repository write by this revalidation is this separate report. Earlier findings remain intact in `spec-review.md`.
- No claim that proposed code already passes tests. Source inspection supports the dispatch conclusions. One successful, unpaid `bun -e` graph probe supports B1; two earlier miniature probe definitions failed graph validation before reaching the check and are **not** evidence for B1.

## Dispositions at a glance

| Prior ID | Disposition | Severity / present consequence |
| --- | --- | --- |
| B1 | **CONFIRMED** | Blocker: persisting the graph output requires changing an unauthorized exact-set test. |
| B2 | **CONFIRMED** | Blocker: US-012 requires dispatcher delivery explicitly assigned to dependent US-013. |
| D1 | **CONFIRMED** | Blocker sizing diagnostic: US-012 has at least 25 independent assertions against cap 24. |
| D2 | **CONFIRMED** | Blocker seam diagnostic: three callable exports lack captured production-use anchors. Factory/builder also trigger P4.7 majors; counted once as D2. |
| M1 | **CONFIRMED** | Major: the claimed existing plain-object guard accepts arrays and non-plain objects. Not a proven exploit. |
| M2 | **CONFIRMED** | Major: derived scoped-lint forwarding is mandated but not pinned by the enumerated forwarding criterion. |
| M3 | **CONFIRMED, narrowed** | Major acceptance-anchor gap. Existing timeout/abort protections and tests **do exist**; this is not an assertion that the implementation lacks them. |

## Critical issues — must fix before clearance

### B1 — [CRITICAL / blocker, Phase 2] Missing exact graph-output test authorization

**Spec:** US-009 at lines 377–387 and 787–803; Modifies at 598–602. Persistence and stale-evidence clearing are required through production `runFeatureMachine`. No Modifies entry names `packages/nax/test/unit/workflow/feature-graph.test.ts`, and no AC explicitly authorizes updating its exact output-set contract.

**Independent source evidence** (code paths below relative to `packages/nax`):

1. `src/workflow/feature-machine.ts:108–121` passes the real `FEATURE_GRAPH` to `runStepGraph`, with persistence through `sink.update`.
2. `src/workflow/feature-graph.ts:33–37` declares the branch-review output set without `reviewMismatch`.
3. `src/step-graph/run.ts:69–83,263–279` checks every own patch key, including a key explicitly set to undefined, **before** applying the patch. Persistence follows at 300–303.
4. `test/unit/workflow/feature-graph.test.ts:58–60,109–112` pins that output set exactly:

```typescript
expect([...node.produces].sort()).toEqual([...expectedProduces[id]].sort());
```

A probe used a clone of the actual `FEATURE_GRAPH`, replacing only the branch-review body/transition, and the real engine. Both `{ reviewMismatch: { kinds: ["quality"] } }` and `{ reviewMismatch: undefined }` returned:

```text
STEP_GRAPH_UNDECLARED_OUTPUT
node "branch-review" patched "reviewMismatch", which its produces does not declare
```

**False-positive challenge:** a missing source-file listing alone is not the blocker—implementers can infer necessary source edits. The closed-world **test** collision is. A general persistence AC or a Context Files read does not explicitly authorize rewriting that exact-set pin under Phase 2's contract. Declaring the output is necessary, but makes the existing test fail. Mutating the record in place or bypassing graph validation is not a legitimate way around the declared patch/persistence contract.

**Fix example, not applied:** specify the added branch-review `produces` member and a US-009 Modifies entry for `feature-graph.test.ts` allowing only `reviewMismatch` to join the expected outputs, preserving every existing output, node kind, exit and transition.

### B2 — [CRITICAL / blocker, P4.2] US-012 consumes US-013's undelivered fallback

**Spec:** line 413 explicitly assigns **delivery through callOp to US-013**; lines 425–427 assign the flag and null-parse substitution there. Nevertheless, US-012's integration AC at **841** requires retaining the last parseable verdict after malformed clarification/repair exhaustion. Seams at **627** names real `callOp(workflowBranchReviewOp)`. The adjacent strategy-only fallback AC at 839 is a different, satisfiable assertion.

**Independent source evidence:**

- `src/operations/call-dispatch-run.ts:279–313` records `RetryDecision.fallback` and returns the final raw turn.
- Its `parseRunOutcome` at **463–477** parses the nonempty final raw output and passes that parsed value into `runPostParse`.
- Its stored-fallback ladder at **492–506** is reached on an exception, not on a null parse.
- `src/operations/workflow-replies.ts:136–142,191–194` returns null on unusable shape; branch parsing remains explicitly lenient under US-011.
- `src/operations/workflow-branch-review.ts:74` has the lenient parser and no verify/recover hook; `src/operations/post-parse.ts:26–45` returns the parsed null unchanged without such hooks.

**Counterexample at the story boundary:** a parseable inconsistent verdict contains a real quality finding; clarification is nonempty malformed text; its permitted JSON repair is also nonempty malformed text. US-012 can correctly record the earlier verdict as `fallback`. Before US-013, the authoritative parse is still null. The real dispatcher therefore does not deliver the recorded verdict. The final combined feature could work, but the earlier story cannot satisfy its own integration contract independently.

**False-positive challenge:** reading line 841 as a strategy-record assertion would duplicate 839 and ignore its integration tag plus the real-callOp seam. The spec explicitly separates reporting a fallback from delivering it. Returning a synthetic parseable turn, changing the lenient parser to throw, or adding operation recovery early would implement the later handoff or change the stated contract, not disprove the collision.

**Fix example, not applied:** keep US-012's strategy fallback observation there; assign the exhausted-malformed-follow-up real-callOp retention assertion and necessary branch-operation test authorization to US-013. Do not reverse the dependency into a cycle.

### D1 — [CRITICAL / blocker, requested sizing diagnostic] US-012 is at least 25 assertions

**Spec:** count/headroom claims at 255, 270–272 and 415; 19 AC bullets at 834–852. The actual cap is 24 **assertions**, not bullets. Independent recount reproduces the 19-bullet baseline and these six splits:

| Line | Independently falsifiable outcomes | Added assertions |
| --- | --- | ---: |
| 834 | A mismatch clarification is sent; it uses the **same session handle**, rather than opening another. | +1 |
| 835 | Prompt requests remedy/defect/failed AC or corrected verdict; it requests a **complete branch-review object**, rather than a partial answer. | +1 |
| 843 | Clarification leaves the **coverage allowance** intact; subsequent prompts retain **diff-part references**. | +1 |
| 844 | No-progress comparison uses **only coverage responses**; non-coverage turns do not **spend the retry counter**. | +1 |
| 845 | Intermediate turns do not **reset an active allowance**; they do not **reopen a stopped coverage state**. | +1 |
| 852 | Operation retains **null** when no reply parses; the outer review wrapper reports **skipped review**. | +1 |

**Lower bound: 19 + 6 = 25 > 24.** A correct counter can coexist with a wrong prompt; a correct retry count can coexist with a wrong no-progress baseline; a null-returning dispatcher can coexist with an incorrect outer wrapper. Each is separately breakable, not a list of alternate fixtures for one assertion.

**False-positive challenge:** the recount does **not** split each JSON field, each mismatch kind, or each parameterized input value. It does not restore the removed timeout/session/deadline compound bullet, and does not split line 841. Sharing a test function does not make independently asserted outcomes atomic. US-005's previous cited compound-invariant issue is not being resurrected.

**Fix example, not applied:** reallocate dispatcher/outer-wrapper assertions to their handoff owner and count the resulting independent assertions again. No PRD exists, so this is a spec lower bound, **not** an observed generated-PRD failure or description-size measurement. Formal Phase 5 remains halted.

### D2 — [CRITICAL / blocker, requested two-anchor diagnostic] Three exports lack production-use anchors

**Spec:** declared exports at 61–67; design composition/text-source mandates at 204 and 226; Seams 623–629; ACs 799 and 834–852.

The loaded Phase 7/8 checklists require a direct behavioral anchor **and** a production-entry test capturing the exported symbol's invocation. This requirement is stronger than matching final values.

| New callable export | Evidence present | Missing second anchor |
| --- | --- | --- |
| `createGateStallMonitor` | Direct monitor ACs; Seams 623 captures construction/observations from the engines. | None for this diagnostic. |
| `resolveStallDetection` | Direct default/zero AC; Seams 624 and AC 749 capture `_qualityGateDeps.resolveStallDetection` from `runRepoGates`. | None for this diagnostic. |
| `makeMismatchClarificationStrategy` | Declared export, wrapper test Creates entry, composition mandate; real-callOp behavior scenarios. | No AC/Seams entry stubs/captures the factory being called by the production retry resolver. |
| `buildWorkflowBranchVerdictMismatchRetry` | Declared export and prompt-content expectations. | No AC/Seams entry captures production clarification obtaining its prompt from this builder. |
| `branchMismatchReasons` | Direct helper AC 799; publishing/reason-text assertions. | No AC/Seams entry captures the production persistence/log/readiness path using the shared formatter. |

**False-positive challenge:** real `callOp` and production `publish` are appropriate entry points, but their current specified assertions can all pass with duplicated inline strategy/prompt/reason logic while these exports remain unused. Seams 627's scripted replies and 626's draft-readiness outcome do not assert those calls. Exporting through barrels is also not runtime use. Conversely, the revised resolver anchor **does** meet this diagnostic; it is not flagged again.

The factory/builder additionally lack the named API-use coverage required by P4.7. The formatter is named by its direct AC, so its defect here is specifically the missing **second** anchor, not a fabricated P4.7 omission.

**Fix example, not applied:** specify injected captured-call assertions from real `callOp(workflowBranchReviewOp)` to the factory and builder, and from production feature review/publish to the formatter; retain direct behavior tests. No module mocks or source-text tests. Formal Phases 7/8 remain halted; this is the requested diagnostic, not a full seam/altitude clearance.

## Warnings — should fix

### M1 — [HIGH / major, P4.1] Existing validation is not plain-object validation

**Spec:** 214–218 calls the target fallback condition “the same plain-object guard the throwing path uses”; 425 and 856 require a plain-object fallback.

**Source:** `src/operations/call-dispatch-run.ts:396–408` rejects only `typeof fallback !== "object" || fallback === null`. Arrays and class instances pass. The helper's comment and error text say “plain object,” but its predicate does not enforce that.

**False-positive challenge:** an ordinary parsed review fallback will usually be a plain object; that does not prove the asserted generic guard. This is a misleading existing-behavior claim, not proof that the new code is already vulnerable or that array handling must alter every operation. The new opt-in path can be made correct without broad legacy changes.

**Fix example, not applied:** specify a strict record/plain-object predicate for the new null-parse branch and negative fallback cases through real `callOp`, while preserving the legacy non-opt-in ladders. Alternatively explicitly choose the broader object contract and cease describing it as plain-object validation.

### M2 — [HIGH / major, P4.4] Derived scoped-lint policy forwarding lacks its input-class anchor

**Spec:** 183 explicitly mandates **degraded, template, derived and full-lint** forwarding. AC **770** enumerates **template, full and degraded**, omitting derived.

**Source:** `src/review/scoped-lint.ts:301–325` has separate template and non-degraded/no-template **derived** calls. The derived call uses `appendFilesToCommand` only when `isSupportedDerivedScopedCommand(fullLintCommand)` succeeds; it is not the full/degraded arm at 332 onward.

**False-positive challenge:** the corrected Modifies permission at 594 authorizes widening the helper signature and preserves the production adapter's missing-story-ref/full-lint contract. It does not exercise the non-degraded/no-template derived branch. A generic `runReview` outcome or forwarding in three listed arms can be green while this fourth helper call omits policy.

**Fix example, not applied:** parameterize the forwarding criterion with a supported derived-command/no-template fixture and capture policy beyond `_scopedLintDeps.runLintCommand`. This need not add an unrelated story or a standalone AC per fixture.

### M3 — [HIGH / major, P4.6] Timeout/abort preservation is not routed to an acceptance anchor

**Spec:** failure-handling row **245** assigns review timeout/package failure/no dispatch, skipped-review/abort behavior, and no extension to US-012. US-012 ACs 834–852 do not pin review-step timeout or run abort. Line 852 is the no-parseable-reply class. The verification note at 417 routes the 21-send ceiling and same-session constraint, not the step deadline/abort contract.

**Independent counterevidence considered:** existing protection and existing tests are present:

- `src/workflow/story-review.ts:20–36` makes review-limit expiry override even a returned verdict, and propagates a thrown run abort.
- `src/workflow/branch-review.ts:230–245` uses that shared wrapper.
- `src/operations/call-dispatch-run.ts:187–196,317–335` has zero-dispatch and abort guards, including retry sleep.
- **`test/unit/workflow/branch-review-sliced.test.ts:166–187,206–225`** already covers package failure, abort propagation and a timeout overriding a returned parseable verdict. Shared review hardening tests also cover the limit.

**Disposition qualification:** withdraw any interpretation that timeout/abort protection or tests are absent. The actual prior finding—an **unanchored normative failure row**—is confirmed under P4.6: the spec neither gives a covering owning-story AC nor explicitly routes preservation to these named existing contracts or an Out-of-Scope release. A general “run the suite” instruction is not the specific routing that US-005's preservation note demonstrates. An inner 21-send bound and a null parse do not establish the outer deadline/abort outcome during newly interleaved retries.

**Fix example, not applied:** explicitly designate the named existing runtime contracts as the preservation anchor, or place bounded timeout/abort scenarios at the owning outer entry point with enough assertion budget. Do not silently pack them into the already-over-cap US-012 criteria. This is a major authoring gap, not an additional runtime blocker.

## Phase evidence and honest halt

| Phase / check | Independently examined denominator | Result |
| --- | --- | --- |
| 1 | **76 distinct repository-rooted source/test/fixture paths**: 67 exist, 9 are declared Creates; **155 inline identifier-component candidates** checked against source/tests, with unmatched items reconciled to declared new identifiers, local `clarified`, policy fields and the defined diagnostic. **17 identifier-table rows** reconciled across all mentions; **0 consumed external data literals** requiring outside provenance. Abbreviated paths, existing barrels and new barrel-export requirements were also read. | No new existence/spelling blocker. A text hit is existence evidence, not proof of shape/behavior. |
| 2 | **11 baseline/target surface rows**, the monitor's **4 forward contracts** (policy/reason/interface/factory), and the additional feature-graph declaration/test boundary; **28 Modifies permissions** checked for story groups/single leading paths while revalidating authorization. | **B1 blocks the gate.** No claim of a completed collision sweep over every affected test or a clean shape pass. |
| 3 | Applies, but blocked by Phase 2. Both rule stores were listed (13 Markdown files each); their full convention audit was **not executed**. | **HALTED**, not passed. |
| P4.1 | **36 existing-behavior claims**, source-grounded ledger below. | 1 major, M1. No added decision-logic blocker. |
| P4.2 | **190 AC-to-Design comparisons** across all 13 stories. | 1 blocker, B2. |
| P4.3 | **11 mutated surface rows** checked for an explicit target rather than a baseline-only signature. | Targets stated; no additional finding. B1 is a missed graph boundary, not a baseline-only listing. |
| P4.4 | **93 input-dimension groups**, independently enumerated from the contracts/domain; per-story ledger below. | 1 major, M2. |
| P4.5 | **41 interaction cells**: 4/2/4/3/4/2/3/3/3/2/2/7/2 by US-001 through US-013. | No additional contradictory/undefined composition found. |
| P4.6 | **7 failure-handling rows**. | 1 major, M3. |
| P4.7 | **48 named API touchpoints**: 2/3/2/6/2/2/3/10/3/5/1/4/5 by story. | Factory and builder use mandates uncovered; included in D2, not double-counted. |
| P4.8 | **24 risk properties**: 3 monitor isolation/disposal; 6 executor trust/lifecycle; 6 quality trust/lifecycle; 2 bot provenance/isolation; 3 mismatch persistence/clearing; 3 retry invocation/termination properties; 1 opt-in isolation. | No additional unpinned property identified. |
| P4.9 | **0 fixture-generation algorithms** prescribing additional derived fixture properties. Controlled streams/scripted replies are inputs, not an unstated data-generation procedure. | No underivability finding. |
| P4.10 | **9 behavior constants**, **3 composition relations**. | Derivable: repeat 100, silence 0, repeat minimum 2, line cap 16,384, tail 4,000, shape 1, clarification 1, coverage default 3, per-hop ceiling 21; terminal observation order, independent silence/wall relation, semantic 3+C within per-hop ceiling. |
| P4.11 | **0 shipped/DONE implementation claims**; quoted status-like words are not release claims. | No shipped-claim finding. |
| P4.12 | **13 stories + feature row**, assembled after diagnostics. | Roll-up below. |
| 5–8 | Apply, but Phase 2 and Phase 4 have blockers. Requested diagnostic coverage only: **13 story bullet totals**, the **US-012 six-split lower bound**, **5 callable-export production-use anchors**, **61 Context Files entries**, **9 Creates**, **28 Modifies**, **14 declared dependency edges**, **11 Out-of-Scope bullets**, **190 tags (124 unit / 66 integration)**. Context blocks have at most five files. | **HALTED.** D1/D2 remain actionable diagnostics; no full hygiene/stale-reference/verification/seam certification. No generated-description size claim. |
| 9 | **0 PRDs supplied/present** in the feature directory. | Inapplicable, not passed. |

### P4.1 source-grounded claim ledger (36 claims)

Claims 1–3: story parser detects mismatch without fabrication; branch parser currently synthesizes; consumer currently adds a quality floor (`workflow-replies.ts:136–157,191–207`; `feature-steps.ts:122–147`).

Claims 4–10: verification collectors are whole-stream; quality collector is incremental; verification races exit/timeout and bounds post-kill wait; quality directly awaits exit; its floating exit observer has a catch; group cleanup can outlive leader exit; bare-pid fallback is disabled after leader exit (`verification/executor.ts:140–210`; `quality/runner.ts:144–178,279–338`). No stronger promise about fixing rejected exits is inferred.

Claims 11–14: harness/agent-tool timeout output differs; environment marker/strip rules persist; NO_COLOR respects overrides; trust precedes spawn (`quality/runner.ts:44–66,193–200,243–276,353–367,400–402`; `verification/executor.ts:74–88,116–118`).

Claims 15–20: verification list first-failure/every-entry semantics; any-entry escalation; quality list first-failure/any-timeout aggregation; scoped zero-tests rerun excludes TIMEOUT; full-suite acceptOnTimeout translates at the operation; workflow treats passed-on-timeout as red (`verification/runners.ts:126–164`; `quality/aggregate.ts:8–19`; `verify-scoped.ts:285–332`; `full-suite-gate.ts:190–210,347–365`; `workflow/gates.ts:161–180`).

Claims 21–28: gate classification checks timeout first; root precedence is per key; overlay run identity is cwd/command/setup; failed e2e setup prevents journey; bot projection drops extra fields; fix/baseline reuse reviewed gate objects; scoped lint has distinct template/derived/full/degraded calls; setup returns the runner exit code (`finish/gates/quality.ts:87–92,190–240,253–321`; `bot/checks.ts:92–101`; `bot/fix-steps.ts:223–232`; `bot/gate-baseline.ts:53–76`; `review/scoped-lint.ts:253–339`; `cli/setup-verify.ts:15–34`).

Claims 29–34: retry strategy resolves once per invocation; 21-send bound is per retry loop; null parse does not consume stored fallback; existing fallback validator is plain-object validation **(contradicted: M1)**; post-parse verify then conditional recover; outer review limit/abort semantics (`call-dispatch-run.ts:103,279–341,396–408,463–506`; `post-parse.ts:26–45`; `story-review.ts:20–36`).

Claims 35–36: deterministic reasons precede approval; generic reason items and summary channels preserve the distinction from actual finding counts/success (`finalize.ts:531–574`; `approval.ts:123–145`; `open-items.ts:118–168`; `run-summary.ts:49–67,118–163`).

### P4 dimension / interaction ledger

Units below are contract/domain dimensions, **not atomic-assertion counts**. Multiple variants of one dimension are grouped; no per-field AC inflation is inferred from these denominators.

| Story | Input dimensions examined | Interaction cells checked |
| --- | --- | --- |
| US-001 | **9**: streams; UTF-8/chunks; delimiters/tails; exact text; blank eligibility; length cap; repetition threshold; silence/activity; disposal/isolation. | **4**: cross-stream activity/silence; blanks/repetition; cap/repetition; disposal/queued callback. |
| US-002 | **5**: absent/empty; repeat domain; silence domain; whole-object default; partial/zero overlay. | **2**: overlay/unset sibling; overlay/explicit zero. |
| US-003 | **9**: opt-in; stop kind; terminal ordering; process group; exit settlement; pipe/read/drain failure; output; cleanup; cwd trust. | **4**: exit/stop order; leader/group survival; drain/silence; trust/spawn. |
| US-004 | **6**: command order; first reason; escalation; policy/selection; zero tests; accepted timeout/wrapper. | **3**: first failure/later stop; interruption/zero tests; acceptOnTimeout/workflow red. |
| US-005 | **10**: origin/opt-in; stop kinds; terminal order; group survival; never/rejected exit; stream/drain failure; volume; exposure; cleanup; trust. | **4**: exit/stop; never exit/deadline; origin/output; read failure/stop classification. |
| US-006 | **4**: fresh state; continuation/order; reason order; aggregate fields. | **2**: ordinary first failure/later stop; stopped entry/next state. |
| US-007 | **8**: root/overlay; sparse/zero; precedence; dedupe; absent manual policy; record classification; e2e setup; continuation. | **3**: precedence/policy; identity/policy; setup stop/journey. |
| US-008 | **8**: config/provenance; lint/typecheck flags; scoped-lint arms; setup; bot source; bot checkout/no reread; CLI exit/output; partial diagnostics. | **3**: provenance/policy; checkout/trusted policy; interruption/parser output. |
| US-009 | **8**: direct/parsed; kinds; real/minor work; empty work/counts; persistence/order; resume; re-review; clearing/history. | **3**: real work/mismatch; promoted minor/spec mismatch; resume/fresh clearing. |
| US-010 | **6**: kinds; other reasons; advisor/CI; publish modes; artifacts/counts; execution success. | **2**: green/advisor versus mismatch hold; modes/reason retention. |
| US-011 | **5**: malformed shape; kinds; evidence/severity; triage; ordering/deduplication. | **2**: both mismatch kinds; minor-only/blocking evidence. |
| US-012 | **10**: shape; mismatch; budget limits; priority; interleaving; coverage progress; malformed follow-up; last-parseable; transport/hops; abort/deadline/no dispatch. | **7**: shape/mismatch; mismatch/coverage; exhausted coverage/unused clarification; noncoverage/progress baseline; intermediate turns/stopped coverage; fallback hop/spent shape; semantic bound/outer limit. |
| US-013 | **5**: opt-in/nullish parse; fallback domain; null fallback; verify; recover. | **2**: opt-in/null fallback; verify/conditional recover. |

P4.7 API accounting: monitor/resolver (US-001); schema parse/default exposure/merge (002); executor/monitor (003); scoped/regression/executor/scoped-op/full-suite-op/suite-wrapper (004); quality runner/monitor (005); runner/aggregator (006); gate resolver/gate runner/policy resolver (007); story gates/lint/typecheck/review/scoped lint/setup/bot resolver/bot gate/baseline/CLI (008); step/floor/formatter (009); publish/readiness/summary builder/summary formatter/open items (010); branch parser (011); clarification factory/shape strategy/coverage strategy/branch prompt builder (012); callOp/parseRunOutcome/runPostParse/verify/recover (013). The handoff hook captures cover the existing verify/recover path; the two new callable-use gaps are the factory and prompt builder.

### P4.12 — Per-story deadlock risk

Cells are **findings/examined**. `not run` means an applicable later phase halted, not an inapplicable check or a pass. D1/D2 are not silently turned into full Phase 5/8 denominators.

| Story | P4.2 | P4.4 | P4.5 | P4.7 | P4.8 | P4.9/10 | P5-ph / P8-noun | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| US-001 | 0/21 | 0/9 | 0/4 | 0/2 | 0/3 | 0/4 | not run / not run | AT RISK |
| US-002 | 0/11 | 0/5 | 0/2 | 0/3 | n/a | n/a | not run / not run | AT RISK |
| US-003 | 0/20 | 0/9 | 0/4 | 0/2 | 0/6 | n/a | not run / not run | AT RISK |
| US-004 | 0/16 | 0/6 | 0/3 | 0/6 | n/a | n/a | not run / not run | AT RISK |
| US-005 | 0/18 | 0/10 | 0/4 | 0/2 | 0/6 | 0/1 | not run / not run | AT RISK |
| US-006 | 0/6 | 0/4 | 0/2 | 0/2 | n/a | n/a | not run / not run | AT RISK |
| US-007 | 0/16 | 0/8 | 0/3 | 0/3 | n/a | n/a | not run / not run | AT RISK |
| US-008 | 0/20 | **1/8** | 0/3 | 0/10 | 0/2 | n/a | not run / not run | AT RISK |
| US-009 | 0/17 | 0/8 | 0/3 | 0/3 | 0/3 | n/a | not run / not run | AT RISK |
| US-010 | 0/12 | 0/6 | 0/2 | 0/5 | n/a | n/a | not run / not run | AT RISK |
| US-011 | 0/9 | 0/5 | 0/2 | 0/1 | n/a | n/a | not run / not run | AT RISK |
| US-012 | **1/19** | 0/10 | 0/7 | **2/4** | 0/3 | 0/4 | not run / not run | **DEADLOCK LIKELY** |
| US-013 | 0/5 | 0/5 | 0/2 | 0/5 | 0/1 | n/a | not run / not run | AT RISK |
| — (feature) | n/a | n/a | n/a | n/a | n/a | 0/3 relations | not run / not run | AT RISK |

- **US-012:** P4.2 B2 (413/841) independently makes the story unsatisfiable at its boundary; P4.7's factory/builder mandates are D2. D1 and M3 additionally remain.
- **US-008:** P4.4 M2 (183/770), the derived scoped-lint class, contributes to AT RISK.
- **US-009:** B1 independently blocks the overall shape gate; D2 includes its formatter. Neither is disguised as a different P4 contradiction.
- **US-013:** M1 is the existing-validator behavioral claim. It is not a proved new security exploit or an invented AC contradiction.
- Other story/feature AT RISK rows reflect the applicable later checks halted by actual blockers, not newly asserted defects in every story.

## Operational / security and performance considerations

No new dependency or version is proposed, so there is no newly integrated library/license to approve. The design preserves trusted cwd, configured environment stripping, trusted bot snapshot provenance, first-observed terminal ownership, group escalation without bare-pid fallback after leader exit, bounded drains and reason-only structured logging. No new web/SQL/auth endpoint is proposed. M1 is a validation-contract mismatch, not evidence of secret exposure.

The detector is implementable in linear time in decoded input with capped per-stream detector state (16,384 code units); collectors retain the existing output-retention contract. No benchmark or completed implementation is implied.

## Handoff decision

**NOT READY.** No prior finding was disproved sufficiently to clear the stop gates. Four blockers and three majors remain; later applicable phases remain honestly halted. No further fix round was performed or proposed as an authorized action. The approved bundle and silence default stand. Do **not** launch planning from this report. If a future review clears all gates and completes the remaining applicable phases, the parent owns the requested **native-codex-dsm** planner launch.
