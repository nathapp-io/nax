# nax Adversarial Review — Goalpost-Moving / Non-Convergence Root-Cause Report

**Status:** Investigation complete. Second review (Fable) complete — see §8. Diagnosis verified against `main`; proposed fix revised (Phase 0 hardened, Phase 1 mechanic replaced, finding ledger added). Not yet implemented.
**Purpose:** Hand-off to a second reviewer (Fable). The proposed fix below is one option — **please challenge it and propose better solutions.** The problem statement, evidence, and constraints are the durable part; the fix is deliberately open for redesign.
**Repo:** `nax` (Bun + TypeScript AI coding-agent orchestrator). Subject files are under `src/`.
**Date:** 2026-07-17.

---

## 1. Executive summary

A nax feature run (`auth-security-hardening`, project `nathapp-nestjs-platform`) had one story, **US-004**, loop through **~18 adversarial-review rounds across 3 runs** without converging, and was manually stopped.

Investigation found the implementation was **interface-correct** and its acceptance-criteria (AC) tests passed; semantic review passed cleanly every round. **Adversarial review was the sole blocker**, and it blocked on findings that were *factually true about the code but out of the story's AC scope* (atomic rate-limit windows, TOTP replay-window semantics, tenant-column nullability) — none of which the ACs require.

The root cause is a **structural weakness in adversarial AC-grounding**: a blocking finding only needs to (a) quote a verbatim substring of some AC and (b) mention the flagged file/symbol. It is **never checked that the finding's demanded behavior is within the cited AC's scope.** This lets a reviewer attach any out-of-scope concern to any AC and block indefinitely. A secondary amplifier — per-round LLM-assigned severity with no cross-round stability — produced literal pass→fail flip-flops between otherwise-identical rounds.

The proposed fix reframes adversarial blocking around nax's own **executable ground truth**: since adversarial runs *last, on already-green code*, any "the code is broken" finding that is not a `test-gap` is by construction asserting a requirement the green suite (hence the ACs) doesn't encode. So blocking should be restricted to findings that either (i) are `test-gap` (greenness is unearned) or (ii) can be **materialized as a test that maps to an existing AC and fails on current code**. Everything else → advisory + a loud "AC coverage gap" report.

---

## 2. Background: how nax adversarial gating works today

Relevant mechanics (file:line anchors are current `main`):

- **Phase ordering.** The story orchestrator runs a fixed `CANONICAL_ORDER` (`src/execution/story-orchestrator/types.ts:135-148`):
  `test-writer → greenfield-gate → implementer → test-presence-gate → full-suite-gate → mutation-check → verifier → verify-scoped → lint-check → typecheck-check → semantic-review → adversarial-review`.
  **Adversarial review is LAST**, and by the RED→GREEN contract (`execution-plan.ts:77-125`) it only runs on code whose full test suite is already green.
- **The gate.** `adversarialReviewOp.verify()` (`src/operations/adversarial-review.ts:475-505`):
  ```
  substantiated = substantiateAdversarialFindings(findings)          // evidence: does verifiedBy.observed match real code?
  {accepted, dropped} = filterByAcQuote(substantiated, story.acceptanceCriteria)   // AC grounding
  blocking = accepted.filter(f => isBlockingSeverity(f.severity, "error"))
  passed   = parsed.passed && blocking.length === 0
  ```
- **`blockingThreshold` default = `"error"`.** Confirmed: `src/config/schemas-review.ts:185` (`.default("error")`), `src/config/schemas.ts:238`, and every read site uses `?? "error"`. (Audit records show `blockingThreshold: null`, but that is an audit-fidelity artifact — the effective gate is always `error`.)
- **AC grounding = syntactic.** `validateAcQuote` (`src/review/ac-quote-validator.ts:126-175`) accepts a blocking finding iff:
  1. `acQuote` present and `acIndex` in range;
  2. `acQuote` is a whitespace-normalized, markdown-stripped, case-insensitive **substring of the cited AC**;
  3. `acQuote` contains a **locus keyword** — a ≥3-char segment of the file basename, or one of the first 3 identifier tokens in the issue text.
  There is a `test-gap` carve-out (line 160) that waives the locus check for missing/fake-test findings.
- **Carry-forward.** Prior rounds' findings are fed into the prompt (`priorAdversarialIterations`, ADR-022) to discourage re-flagging — but this is *soft* (prompt-level), not a structural suppressor.
- **Advisory path.** Sub-threshold findings become `advisoryFindings` and drive a best-effort, fully-rolled-back non-blocking fix pass (ADR-024, `src/execution/non-blocking-fix.ts:160-246`, wired at `execution-plan.ts:281-328`).
- **Coverage-gap telemetry.** `wouldSurviveStructural` (`src/review/ac-structural-counterfactual.ts:45`) is computed on *dropped* findings and emitted to audit only — **purely observational**, never read by any runtime decision.

---

## 3. The triggering case: US-004

**Story:** "Persist IAM security stores with Prisma" — three Prisma-backed IAM stores (`PrismaTotpReplayStore`, `PrismaAuthAttemptStore`, `PrismaWebAuthnMfaBindingStore`) + module wiring.

**Acceptance criteria (verbatim, 7 total):** narrow behavioral passthrough contracts, e.g.
- AC-3/4: `checkAndReserve(key, ttl)` returns true when the delegate `create` resolves / false on Prisma `P2002`.
- AC-5: `increment(key, windowSeconds)` returns the count from the upserted counter row.
- AC-0/1: `consume(id)` returns the row `userId` / calls `delete` when a row exists.
- AC-6/7: DI tokens resolve to the right store via `useExisting`.

**None of the ACs mention** key-format parsing, TOTP time-step derivation, atomic window expiry, concurrency, tenant-scoping, or `expiresAt` filtering.

**What adversarial review blocked on, every round (all evidence-substantiated against real code):**
- `timeStep` falls back to `Date.now()` for `tenantId:userId:code` keys (replay-window semantics).
- `increment` window-expiry is a non-atomic `findFirst`-then-`upsert` race.
- `consume` deletes without checking `expiresAt`.
- `WebAuthnMfaBinding.tenantId` nullable and `bind` never writes it.

Each finding cited a real AC substring (e.g. `acIndex: 5`, quoting AC-5's text verbatim) and named the file — so it **passed `filterByAcQuote` and blocked** — even though the *concern* (atomicity) has nothing to do with what AC-5 requires (return the count).

**Evidence of non-convergence and instability** (from `~/.nax/.../review-audit/`):
- Run 1 session produced **8 adversarial rounds** in one run (17:04→17:41). Run 3 another ~8. This **exceeds** issue #1157's stated bound ("no single run exceeds 4 adversarial rounds").
- The *same ~5 concerns* recur across rounds with **severity oscillating error↔warning**.
- Literal **pass→fail flip-flops with no code change**: a round at 01:56 returned `passed:true`, the next at 01:58 returned `passed:false`; same again 09:56→09:58.
- **Semantic review passed cleanly** (0 findings) nearly every round. Adversarial was the sole blocker.

**Resolution applied (committed `81f9746`, separate from the nax fix):** one genuinely in-scope defect existed — the `increment` upsert had no window-reset (`{ attemptCount: { increment: 1 } }` grows counters forever). Fixed by adding `windowStart` reset. Separately, the nax-generated `.nax-acceptance.test.ts` had **hallucinated method signatures** (5-arg `checkAndReserve`, 3-arg `increment`) contradicting both the published interface and the AC prose; corrected to match. After both, all AC tests pass and US-004 was marked passed. **This report is about the nax gating bug the case exposed, not the US-004 code.**

---

## 4. Findings (root cause)

### Finding 1 (primary): AC-grounding is syntactic, not semantic

`validateAcQuote` confirms the finding *cites* an AC and *names the locus*, but never that the finding's demanded behavior is a **violation of what that AC asserts**. Because the reviewer freely chooses which AC to quote and how to phrase the issue, any out-of-scope, factually-true concern can be laundered into a blocking finding by quoting an adjacent AC verbatim + mentioning the file. This is the structural enabler of goalpost-moving. (`src/review/ac-quote-validator.ts:126-175`.)

### Finding 2 (amplifier): per-round severity, no cross-round stability

`passed` depends on `isBlockingSeverity(f.severity, "error")` where severity is re-assigned by the LLM every round with no consensus/quorum/hysteresis (`adversarial-review.ts:492-494`). Carry-forward is prompt-level only. Result: the same concern crosses the blocking threshold nondeterministically → pass/fail flip-flops → the loop cannot settle.

### Finding 3 (minor, version-dependent): audit fidelity

The runs' audit records show `blockingThreshold: null` and null drop/accept analyses. Current `main` computes and emits the resolved values (`src/review/adversarial.ts:360, 389, 408, 463-474`), so the runs likely used an older runtime — worth confirming against the exact version, but not a correctness issue.

### Relationship to existing issues

- **#1157** (open) — the convergence/goalpost lineage (`#736 → #757 → #972` carry-forward). Claims the symptom is fixed ("97% ≤3 rounds; no run exceeds 4"). **US-004 is a live counterexample** (8 rounds/run, severity-oscillation flip-flop). Its residual ("whack-a-mole": *new* findings same file) is a different, milder pattern than US-004's *same-findings-re-raised*.
- **#1033** (open) — the acQuote-grounding lineage. Obs-1: reviewer *fabricates* acQuotes → dropped (`ac_quote_not_substring`); proposed fix is prompt-only. Obs-2: `wouldSurviveStructural` drops = AC coverage-gap signal (telemetry only). **Neither reaches US-004**, because US-004's blocking quotes were *verbatim and correctly attributed* (not fabricated → not dropped → they blocked). The gap — **verbatim-but-out-of-scope quotes that survive grounding and block** — is unclaimed by either issue.

**Key negative result:** the cheap structural signal (`wouldSurviveStructural`) is computed only on the *dropped* set. US-004's findings were *accepted*. So no purely-structural shortcut distinguishes US-004's out-of-scope findings from genuine in-scope ones. Only a semantic judge or an executable test can. This is why the fix below leans executable.

---

## 5. Proposed fix (open for redesign)

### 5.1 The reframe

Adversarial review runs **last, on green code**. Therefore any "the code is broken" finding that is not a `test-gap` is, by construction, asserting a requirement the green suite (and thus the ACs) does not encode. Restated as policy:

> On green code, adversarial-review may **block** only via:
> 1. a **`test-gap`** finding (the greenness is unearned — a fake/tautological test "covers" an AC), **or**
> 2. a **materialized test that maps to an existing AC and fails on current code**.
>
> Any finding that cannot produce a failing AC-mapped test is **beyond current AC scope → advisory + a loud "AC coverage gap" report** (never a silent drop).

This replaces the fuzzy substring+locus heuristic with an objective, executable discriminator, and it aligns with nax's TDD spine and the spec-kit principle that "ACs are runtime test cases, never grep/content assertions."

### 5.2 Why not the obvious alternatives

- **Make adversarial advisory-by-default (globally non-blocking).** Rejected: discards adversarial's genuine in-scope blocking value everywhere to fix a narrow false-positive path. ("Not all adversarial reviews face this issue.")
- **LLM scope-judge** ("is this finding in AC-N's scope?"). Weaker than it looks: it answers a fuzzy question with *another* LLM → can oscillate just like the thing it polices; adds a call; not deterministic.
- **Cross-round stability/hysteresis alone.** Fixes oscillation (Finding 2) but **not** scope (Finding 1): a *stable* out-of-scope finding still deadlocks forever. Necessary-not-sufficient.
- **Promote `wouldSurviveStructural` coverage-gap.** Helps #1033's dropped/fabricated cases but **does not catch US-004** (whose findings were accepted, not dropped).

### 5.3 Mechanics

Restrict `adversarialReviewOp.verify()`'s blocking set to `{test-gap findings, materialized-failing-AC-test findings}`; route the rest to `advisoryFindings` + a new coverage-gap verdict. Materialization reuses the **already-present but unwired** capability:
- `AutofixTestWriterInput.mode = "write-failing-test"` (`src/operations/autofix-test-writer.ts:11`) and its prompt (`src/prompts/builders/rectifier-builder.ts:287-336`) already implement "write a NEW test that asserts spec-correct behavior and must fail on current code; do not fix source." **No strategy sets this mode today.**
- Per-finding `acIndex`/`acQuote` already reach the strategy layer (`_finding-to-check.ts:37-45`) but are **not** rendered per-finding in any prompt — this threading is new.

---

## 6. Feasibility, risk, blast radius

### Feasibility: Medium

**Enablers (proposal rides existing rails):** adversarial-runs-on-green guarantees the precondition; `write-failing-test` mode+prompt exist (dormant); advisory + non-blocking-fix + coverage-gap-branch (`adversarial.ts:493-582`) exist; a new config flag slots next to `acRegroundOnDrop`.
**Genuine new work:** per-finding AC→test mapping (does not exist); wiring a strategy to set `write-failing-test`; capturing/running the produced test and gating on it (new control flow, turning a terminal judgment into materialize-then-judge).

### Risks (ranked)

1. **Trust-recursion (highest):** objectivity now rests on the test-writer (an LLM). A test that must *run and fail* is far more falsifiable than a severity label (sharply reduces oscillation), but a test-writer can still write a wrong/flaky/tautological test. Mitigate: require the materialized test to fail on HEAD, carry a valid in-range `acIndex`, and pass the same fake-test/`test-gap` screen.
2. **Control-flow reshape:** touches `verify()` + wrapper Case A/B + a new strategy + phase-eval; not one function.
3. **Two verdict paths in lockstep:** standalone `review/runner.ts:389-499` and the orchestrator phase path (`phase-eval.ts` → `execution-plan.ts`) both consume `passed`; `orchestrator-wrapper-parity.test.ts` guards their equality.
4. **Policy/behavior shift:** stories that block today would "pass with coverage-gap warnings" — intended, but must be loud or real issues get silently downgraded.
5. **Cost/latency:** +1 test-writer turn + a test run per blocking finding (bounded; adversarial is last).

### Blast radius (quantified)

- **Source (~8-10 files):** `adversarial-review.ts` (verify 475-505), `adversarial.ts` (wrapper Case A/B 493-582), `autofix-test-writer-strategy.ts` + `autofix-test-writer.ts` (wire mode), `rectifier-builder.ts` (thread per-finding AC), `category-fix-target.ts` / `adversarial-helpers.ts` (routing), `phase-eval.ts` + `execution-plan.ts` (verdict + capture), `review/runner.ts` (parallel path), config (`schemas-review.ts`, `types.ts`, `schemas.ts`).
- **Tests (~10-12 files, ~60-90 cases):** core decision surface ≈82 tests (`adversarial-review-verify`, `adversarial-pass-fail`, `adversarial-review`, `ac-quote-validator`, `adversarial-threshold`, `adversarial-advisory-findings`); + parity, audit-shape/counterfactual; + E2E (`non-blocking-fix.e2e`, `full-suite-rectify.e2e`).

### Suggested phasing

- **Phase 0 (small, ~2-3 files, reversible):** config flag + a coverage-gap verdict that demotes accepted-but-unmaterialized findings to advisory (keeping `test-gap` blocking). Unblocks the US-004 class immediately.
- **Phase 1 (the real fix):** wire `write-failing-test` + per-finding AC threading + materialize→run→gate, restoring *objective* blocking for genuine in-scope findings.

---

## 7. Questions for the second reviewer (Fable)

1. Is the **executable AC-reduction** framing sound, or is there a cleaner discriminator between "in-scope violation" and "beyond-AC requirement" that avoids both the LLM-judge fuzziness and the test-materialization cost?
2. The reframe leans on "adversarial runs on green code ⇒ non-test-gap findings are beyond-scope." Are there legitimate blocking findings on green code that are **neither** `test-gap` **nor** expressible as a failing AC-mapped test? (e.g. security issues with no behavioral test surface.) If so, the policy needs a third blocking class.
3. Is **trust-recursion** (test-writer as the new oracle) acceptable, or does it just move the problem? Is there a non-LLM way to validate "this materialized test genuinely maps to AC-N"?
4. Should this be **AC-authoring feedback** instead of / in addition to a gate change? US-004's real lesson may be that the ACs were under-specified (they never stated the security properties the reviewer cared about). Is surfacing coverage gaps to the PRD author a better leverage point than tuning the gate?
5. Is there value in a **stronger structural** grounding (beyond substring+locus) that would catch out-of-scope quotes cheaply, closing the gap without materialization?

---

## 8. Second-reviewer assessment (Fable, 2026-07-17)

Independent verification was performed against current `main` (4 parallel verification passes over the gate mechanics, feasibility claims, alternative mechanisms, and materialization practicality). Verdict: **the diagnosis is sound and fully verified; the proposed fix is directionally right but not sufficient as written.** Two holes would recreate the failure mode, and the Phase 1 mechanic is more invasive than necessary. Revised plan in §8.6.

### 8.1 Verification results

Every load-bearing claim confirmed:

- `verify()` gates exactly as described (substantiate → `filterByAcQuote` → severity-only blocking filter); severity is re-assigned by the LLM every round. **No fingerprint, dedup, hysteresis, or quorum mechanism exists anywhere in `src/review/` or `src/operations/`** — carry-forward is prompt text only (`buildPriorIterationsBlock` renders aggregated counts, not per-finding dispositions).
- `validateAcQuote` is purely lexical; the `test-gap` carve-out at `ac-quote-validator.ts:160` returns before the locus check; no semantic scope check exists. Finding 1 confirmed.
- `write-failing-test` mode + prompt exist and are **fully dormant** (no production caller sets the mode; only direct unit tests of the builder exercise it). Per-finding `acIndex`/`acQuote` reach the strategy layer inside `Finding.meta` but are never rendered per-finding in any rectifier prompt. Both feasibility claims confirmed.
- `substantiateAdversarialFindings` verifies **quote existence** (substring match of `verifiedBy.observed` near the cited line), not **claim truth** — US-004's findings were all "real code, mischaracterized scope," which substantiation cannot catch. Confirms the key negative result.
- **Corrections (do not change conclusions):** (a) `_finding-to-check.ts` lives in `src/operations/`, not `src/execution/story-orchestrator/`; (b) `wouldSurviveStructural` / the counterfactual analysis is computed for **accepted** findings too (`AdversarialAcceptAnalysis`), not only dropped — still telemetry-only either way; (c) commit `073dc68e` (#1333, merged 2026-07-16) changed adversarial-finding routing in `build-plan-for-strategy.ts` (`adversarialReviewByFixTarget: "source"` → implementer; test-writer claims only test-targeted findings) — any Phase 1 wiring must be built on top of it.
- **Prior art the report missed:** ADR-024's Alternatives Considered already catalogued this exact design ("repro-test execution-substantiation pipeline", ADR-024 §Alternative D) and deferred it, citing: executes LLM-authored code during review, low repro yield on fixture/cassette-heavy repos, large new surface area. Those objections are not refuted by this report — they are addressed by the revised mechanic in §8.4 (transactional rollback, fail-on-HEAD validation via the scoped-runner seam, strategy-budget caps).

### 8.2 Hole 1 — `test-gap` becomes the new laundering channel

Under the proposed policy, `test-gap` is the only category that blocks *without* materialization — and **category is LLM-self-assigned and unverified**. The code itself documents (`ac-quote-validator.ts:155-159`) that mislabeling `test-gap` today only *relaxes the locus check* — "Mislabelling makes a finding more likely to block (stricter), never bypass-to-pass." That safety argument holds only while category carries no bypass power (blocking is decided by severity alone). The proposal inverts the premise: once `test-gap` is the one category that blocks *without* materialization, mislabeling an out-of-scope finding as `test-gap` becomes the reviewer's rational path to retained blocking power — the same laundering pattern as acQuote, one field over.

**Required mitigation (cheap, structural):** a `test-gap` finding must cite a file matching `resolveTestFilePatterns()` (the existing ADR-009 SSOT), and its `verifiedBy.observed` quote must substantiate against that test file. A "test-gap" finding pointing at a source file is auto-reclassified to its non-carve-out category (and thus subject to demotion/materialization). Deterministic, ~1 file.

### 8.3 Hole 2 — no disposition for real defects with no behavioral test surface

The report's own Question 2 is left unanswered, and US-004 contains the live example (`WebAuthnMfaBinding.tenantId` nullable — schema-shape, not single-AC-behavioral). Under the strict two-clause policy such findings can *never* block — a silent downgrade of exactly the class adversarial review exists to catch.

**Resolution: a third *disposition*, not a third blocking class.** The escalation layer already distinguishes `pause` (needs-human) from `fail` (`resolveMaxAttemptsOutcome`, `src/execution/escalation/tier-escalation.ts:87`). A substantiated, severity-`critical`, non-materializable finding should **pause the story for human triage** — not deadlock the fix loop (blocking) and not vanish (advisory). Blocking-forever and advisory were never the only two options.

### 8.4 Better mechanics

**(a) Durable finding ledger with one-time adjudication (new, highest conceptual leverage).** The deepest structural problem is that every round re-derives the whole verdict from scratch. Instead: fingerprint each accepted finding (file + category + acIndex + normalized issue text), persist across rounds in run state, and adjudicate each fingerprint **once** — materialized into a committed failing test, fixed, demoted to advisory with a coverage-gap report, or paused for human triage. Re-raised findings matching an adjudicated fingerprint are structurally suppressed; new fingerprints are genuinely new work. This converts adversarial review from "re-litigate until the reviewer happens to say pass" into "monotonically shrink an adjudication queue" — convergence becomes structural, not statistical. It kills Finding 2 outright (a flip-flopped severity on a known fingerprint is ignored), makes #1157's round bound enforceable rather than emergent, and subsumes hysteresis. Soft spot: fuzzy fingerprint matching when the reviewer rephrases; normalized file+acIndex+category catches most of it (US-004's recurrences were near-verbatim).

**(b) Commit-the-failing-test instead of materialize-then-judge (replaces §5.3's control-flow reshape).** Rather than turning `verify()` into materialize→run→judge (Risk 2/3: reshaping both verdict paths + parity), route demoted-but-materializable findings to a fix strategy that runs the test-writer in `write-failing-test` mode. The materialized test — validated to fail on HEAD (via the `verifyScopedOp`/scoped-runner seam, which already picks up new test files as changed files), located in a `resolveTestFilePatterns()` path, carrying a valid `acIndex` — is **committed into the suite**. The ordinary `full-suite-gate`/verifier goes red; the ordinary implementer fixes it. The test becomes the durable, deterministic carrier of the finding: no re-litigation next round, no severity oscillation, **no change to either verdict path's semantics** beyond Phase 0's demotion. Trust-recursion is bounded transactionally (ADR-024-style): if the implementer cannot satisfy the materialized test within its strategy budget, remove the test and demote the finding to advisory with a loud report.

### 8.5 Rejected alternatives (beyond §5.2)

- **Category gating via the inert `BLOCKING_CATEGORIES` set** (`ac-structural-counterfactual.ts:25` = `{input, error-path, abandonment, assumption}`, today wired only into telemetry and fix-lane routing). Tempting — it already exists and #986 gathered measurement data for it — but categories are LLM-assigned per round: US-004's atomicity/replay findings could plausibly be labeled `error-path` or `assumption` and keep blocking. It inherits the exact laundering problem. Keep as defense-in-depth telemetry; wrong as the discriminator.
- **Stronger structural grounding alone** (Question 5): no. Verbatim, correctly-attributed quotes carry zero structural signal about scope; any cheap lexical check is gameable by the same laundering. The only cheap structural win available is the test-gap/test-file-path guard (§8.2).

### 8.6 Revised recommended plan

1. **Phase 0 (do now, ~3-4 files, config-flagged):** demote accepted non-`test-gap` blocking findings to advisory + loud AC-coverage-gap verdict (as proposed), **plus** the test-gap structural guard (§8.2), **plus** cross-round severity hysteresis computed from the `Iteration[]` history ADR-022 already keeps (a finding must hold blocking severity across consecutive rounds to block) — kills the Finding-2 flip-flops even for the still-blocking `test-gap` class.
2. **Route the coverage-gap report to the PRD/spec author** (Question 4: yes — both/and). US-004's ACs never encoded the security properties the reviewer cared about; each demoted finding is precisely a candidate AC (or out-of-scope declaration) for the next spec revision. Companion change shipped in `nax-spec-kit-skills`: spec-writing now requires risk-property pinning (encode as AC or declare out-of-scope) for security/concurrency-sensitive stories; spec-review now flags the US-004 deadlock signature (risk-domain story, all-happy-path ACs, no scope declaration) and audits PRD AC signatures against real interfaces.
3. **Phase 1 (measure first, then build):** the finding ledger (§8.4a) + commit-the-failing-test materialization (§8.4b), only if Phase 0 telemetry shows genuine in-scope defects being wrongly demoted. Add the `pause`-for-human disposition for substantiated critical non-materializable findings (§8.3). Build on `073dc68e`'s routing.

### 8.7 Answers to §7

1. **Framing sound?** Yes — the executable-AC-reduction reframe is architecturally coherent (adversarial-runs-last-on-green is real, verified). No cheaper discriminator exists; the key negative result held up. But the two-clause policy needs §8.2/§8.3's amendments, and materialization should ride the RED→GREEN spine (§8.4b), not reshape `verify()`.
2. **Third blocking class needed?** Findings with no behavioral test surface are real (US-004's `tenantId` case). Answer: a third **disposition** (pause-for-human on substantiated critical), not a third blocking class (§8.3).
3. **Trust-recursion acceptable?** Bounded, yes: fail-on-HEAD execution + test-path structural check + acIndex validity + transactional rollback on implementer exhaustion make the materialized test far more falsifiable than a severity label. Non-LLM validation of "genuinely maps to AC-N" does not exist; the mitigations reduce, not eliminate, the recursion — acceptable given the alternative is an unfalsifiable severity label.
4. **AC-authoring feedback?** Yes, and structurally: coverage-gap reports must feed spec revision (see §8.6 item 2), not terminate in the run log. But it is a complement, not a substitute — a perfect spec cannot enumerate every concern an adversarial reviewer can imagine.
5. **Stronger structural grounding?** No general form exists (§8.5). Only the test-gap/test-file-path guard is both structural and load-bearing.

### 8.8 Open item

Finding 3 (audit records showing `blockingThreshold: null`) remains the report's only unverified claim — pin the exact runtime version of the US-004 runs before closing it out.

---

## Appendix: key file:line references

| Concern | Location |
|:--|:--|
| Blocking threshold default `"error"` | `src/config/schemas-review.ts:185`, `src/config/schemas.ts:238` |
| Adversarial gate (passed computation) | `src/operations/adversarial-review.ts:475-505` |
| Syntactic AC grounding | `src/review/ac-quote-validator.ts:126-175` (`validateAcQuote`), `:190` (`filterByAcQuote`) |
| `test-gap` carve-out | `src/review/ac-quote-validator.ts:160` |
| Phase order (adversarial last) | `src/execution/story-orchestrator/types.ts:135-148` |
| Green-before-review contract | `src/execution/story-orchestrator/execution-plan.ts:77-125` |
| Carry-forward (soft) | `AdversarialReviewInput.priorAdversarialIterations`, `adversarial-review.ts:48-49` |
| Advisory / non-blocking fix (ADR-024) | `src/execution/non-blocking-fix.ts:160-246`, `execution-plan.ts:281-328` |
| Coverage-gap telemetry (observational) | `src/review/ac-structural-counterfactual.ts:45` |
| Wrapper AC-coverage-gap branch (Case A/B) | `src/review/adversarial.ts:493-582` |
| Dormant test-materialization capability | `src/operations/autofix-test-writer.ts:11`, `src/prompts/builders/rectifier-builder.ts:287-336` |
| Inert category set (telemetry/routing only, §8.5) | `src/review/ac-structural-counterfactual.ts:25` (`BLOCKING_CATEGORIES`) |
| Escalation pause/fail dispositions (§8.3) | `src/execution/escalation/tier-escalation.ts:87` (`resolveMaxAttemptsOutcome`) |
| Test-gap mislabeling comment (§8.2) | `src/review/ac-quote-validator.ts:155-159` |
| #1333 routing change (§8.1c) | `src/execution/build-plan-for-strategy.ts:239` (`adversarialReviewByFixTarget`), commit `073dc68e` |
| ADR-024 deferred materialization (§8.1) | `docs/adr/ADR-024-non-blocking-adversarial-fix.md:108` (§Alternative D) |
| Finding→strategy routing | `autofix-implementer-strategy.ts:11,60-72`, `autofix-test-writer-strategy.ts:50-53`, `category-fix-target.ts:11-13` |
| Two verdict paths + parity | `review/runner.ts:389-499`, `phase-eval.ts:13-97`, `test/unit/review/orchestrator-wrapper-parity.test.ts` |
| Related issues | GitHub #1157 (convergence/carry-forward), #1033 (acQuote grounding) |
