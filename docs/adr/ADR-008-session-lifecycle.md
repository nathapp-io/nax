# ADR-008: Session Lifecycle Across All Agent Roles

**Status:** Proposed
**Date:** 2026-04-14
**Author:** William Khoo, Claude
**Supersedes:** ADR-007 (partial — the implementer portion is retained here verbatim; see §6)

---

## Context

nax opens ACP sessions to run every agent role in the pipeline. Session lifecycle — whether a session stays warm (`keepSessionOpen: true`) across calls or closes after each call — has been decided role-by-role over the last three specs (SPEC-session-continuity, SPEC-semantic-session-continuity, SPEC-debate-session-mode). The decisions are correct individually but have drifted away from a single coherent rule.

### Observed Failure

A multi-round autofix loop oscillated across three adversarial-review rounds, with the reviewer flip-flopping between contradictory findings:

- Round 1 flagged an issue as dead code
- Round 2 instructed the implementer to add code that round 1 had already rejected, plus new unrelated findings
- Round 3 flagged the newly-added code as incorrectly wired, while earlier round-1 findings resurfaced

The review session was kept open (`keepSessionOpen: true` in `src/review/adversarial.ts:249` and `src/review/semantic.ts:389`). Between rounds the implementer modified the diff, but the reviewer re-entered with prior-round reasoning still in its conversation history — so it re-litigated decisions it had already argued about instead of scoring the current diff cleanly. ACP session audits confirmed that the reviewer sessionId was reused across rounds, proving the session was warm. Findings flip-flopped and autofix attempts were burned reacting to an unstable rubric.

### The Underlying Rule

Sessions are valuable when **the agent is iterating on its own work** — the conversation history is the work-in-progress. Sessions are harmful when **the agent is scoring someone else's work** — prior verdicts contaminate the next verdict on a different diff.

No ADR states this rule. Each site decides independently, and the decisions have diverged:

| Role | File | Current `keepSessionOpen` | Correct by rule? |
|:---|:---|:---|:---|
| implementer (main run) | `src/pipeline/stages/execution.ts` | `!!(…)` — true when rectification enabled | ✅ |
| implementer (TDD run) | `src/tdd/session-runner.ts:172` | `true` when role=="implementer" && rectification enabled | ✅ |
| test-writer | `src/tdd/session-runner.ts:172` | `false` (only implementer gets `true`) | ✅ |
| verifier | `src/tdd/session-runner.ts:172` | `false` | ✅ |
| rectifier (TDD) | `src/tdd/rectification-gate.ts:234` | `!isLastAttempt` | ✅ |
| rectifier (autofix) | `src/pipeline/stages/autofix.ts:465` | `!isLastAttempt` | ✅ |
| rectifier (verification) | `src/verification/rectification-loop.ts:261` | `!isLastAttempt` | ✅ |
| autofix-adversarial | `src/pipeline/stages/autofix-adversarial.ts:93` | `keepOpen` (caller-controlled) | ✅ |
| reviewer-semantic | `src/review/semantic.ts` | `true` (initial) / `false` (retry) | ✅ (session closes by end of `runReview`) |
| reviewer-adversarial | `src/review/adversarial.ts` | `true` (initial) / `false` (retry) | ✅ (session closes by end of `runReview`) |
| reviewer-dialogue | `src/review/dialogue.ts:309 et al.` | `true` (5 sites) | ✅ — dialogue is stateful by design |
| debate (stateful) | `src/debate/session-stateful.ts:67` | caller-passed; `false` on close | ✅ |
| debate (one-shot) | `src/debate/session-one-shot.ts` | n/a — `complete()` | ✅ |
| router / auto-approver / decompose / refine / etc. | various | n/a — `complete()` (one-shot) | ✅ |

The semantic reviewer was originally `keepSessionOpen: false`; ADR-007 flipped it to `true` under the theory that the reviewer would be resuming the *implementer* session and should survive into autofix. That theory was then reverted in #414 (reviewer-semantic got its own session), but the `keepSessionOpen: true` line stayed behind. The adversarial reviewer inherited the same flag by copy-paste. Both are now same-role continuations across independent review rounds — exactly the wrong case.

---

## Decision

Adopt a single rule, applied per role:

> **Keep a session open (`keepSessionOpen: true`) if and only if the role is iterating on its own state. Close the session (`keepSessionOpen: false`) if the role is producing an independent verdict on someone else's work.**

### Reviewer Session Invariant (Refined)

For the semantic and adversarial reviewers, the unit of isolation is **one `runReview()` invocation** — not one `agent.run()` call. A single `runReview()` may issue up to two sequential `agent.run()` calls:

1. **Initial call** — `keepSessionOpen: true`. The session stays alive so the JSON-retry prompt (sent on the *same* call chain within `runReview`) has full conversation history to re-express the verdict.
2. **JSON-retry call** — `keepSessionOpen: false`. Closes the session after the retry response is received.

The invariant is therefore: **the reviewer session is always closed by the time `runReview()` returns**. From the caller's perspective, each `runReview()` round is still stateless — no session memory persists between autofix rounds.

If no retry is needed (initial response is valid JSON), the initial call's `keepSessionOpen: true` leaves the session open momentarily; `runReview()` does not issue a second call, but the ACP layer closes the session automatically when the connection is released at the end of the round. Fresh sessionIds are still generated per review round, enforced by `sweepFeatureSessions()` at story completion.

### Session Lifecycle Matrix

| Role | `sessionRole` | Method | `keepSessionOpen` policy | Reset on retry | Reset on escalation |
|:---|:---|:---|:---|:---|:---|
| **Implementer** (exec) | *(none)* / `"implementer"` | `run()` | `true` while rectification enabled | no — resume | yes — new tier, fresh session |
| **Test-writer** | `"test-writer"` | `run()` | `false` | n/a (single run per story) | yes |
| **Verifier** | `"verifier"` | `run()` | `false` | n/a | yes |
| **Rectifier** (TDD / autofix / verification) | `"implementer"` | `run()` | `!isLastAttempt` | no — resume implementer session | yes |
| **Reviewer — semantic** | `"reviewer-semantic"` | `run()` | `true` on initial call; `false` on JSON-retry call (session closes by end of `runReview`) | **yes — fresh sessionId per round** | yes |
| **Reviewer — adversarial** | `"reviewer-adversarial"` | `run()` | `true` on initial call; `false` on JSON-retry call (session closes by end of `runReview`) | **yes — fresh sessionId per round** | yes |
| **Reviewer — dialogue** (debate) | `"reviewer"` | `run()` | `true` across all turns of the dialogue | no — dialogue *is* the state | session closed when dialogue concludes |
| **Debate — stateful debater** | `"debate-hybrid-<i>"` / `"plan-<i>"` | `run()` | `true` between proposal and rebuttal; `false` on close | no | yes |
| **Debate — one-shot** | `"debate-proposal-<i>"` etc. | `complete()` | n/a | n/a | n/a |
| **Router / auto-approver / decompose / refine / acceptance-gen / fix-gen** | various | `complete()` | n/a — one-shot | n/a | n/a |
| **Diagnose / source-fix** (acceptance) | `"diagnose"` / `"source-fix"` | `run()` | `false` (single-shot verdict / fix) | yes | yes |

**Why semantic and adversarial differ from dialogue.** Dialogue is a negotiated multi-turn exchange (reviewer ↔ implementer) where each turn is a response to the previous turn — the session *is* the work product. Semantic and adversarial review are per-round scoring passes where each round evaluates the current diff independently. A rerun should not know what the previous rerun said. The `keepSessionOpen: true` on the initial call is an implementation detail — session history is used only within the same `runReview()` call chain for JSON retry, never across independent autofix rounds.

---

## Alternatives Considered

### A. Leave `keepSessionOpen: true` on reviewers, add an explicit reset step

Insert an explicit session-close call between autofix rounds. Complexity is higher and it duplicates what `keepSessionOpen: false` already does. **Rejected.**

### B. Make `keepSessionOpen` a global config flag per role

Expose per-role `keepSessionOpen` in `NaxConfig` for operator override. **Rejected for now** — the correct value is deterministic given the rule above; adding configuration creates room for misconfiguration without a corresponding use case. Revisit if evidence shows operators need to tune this.

### C. Single ADR per role (test-writer, semantic, adversarial, debate each in its own file)

Earlier draft plan. **Rejected** because session continuity is a cross-cutting policy with per-role parameters — readers need the comparison view, not six separate files restating the same rule.

### D. Keep one session per story across all reviewer rounds, reset only on escalation

Would preserve token savings across rounds. **Rejected** — this is precisely the configuration that caused the observed oscillation. Token savings on reviewers are marginal (one JSON verdict per call); correctness of the verdict is the dominant concern.

---

## Consequences

### Positive

- **Deterministic reviewer verdicts per round.** Each autofix round starts from a clean reviewer state; findings depend only on the current diff, not prior conversation.
- **Oscillation loops close.** The observed failure mode — a reviewer flip-flopping between "this is dead code" and "this was added-then-removed" across autofix rounds — cannot recur, because the reviewer no longer remembers the prior round.
- **Consistent rule across the codebase.** One sentence describes the whole policy; new roles slot into the matrix without a new ADR.
- **Observability.** Fresh sessionIds per round make the audit log readable: a reader can tell at a glance that round N and round N+1 are independent evaluations.

### Negative / Trade-offs

- **Reviewer token cost per round is slightly higher.** A fresh session means the full review prompt (diff + ACs + rubric) is sent each round instead of a short "recheck" prompt on a warm session. Rough estimate: ~2-4 KB extra input per recheck round. At Sonnet tier this is well under $0.01 per round. At the failure mode we're fixing (three rounds of oscillation), the saved *agent* tokens from a resolved loop dwarf this cost.
- **No reviewer "memory" of prior rounds.** If a reviewer in round 1 spotted a subtle bug and round 2 misses it, the round-2 reviewer has no way to know. Mitigation: this is the correct behaviour — the round-2 diff is what matters. If bug persistence across rounds is needed, it belongs in the *rubric* (passed via prompt), not in session memory. The existing finding-category taxonomy can be extended for this if evidence shows the need.
- **Debate/dialogue roles remain the exception.** The matrix has two patterns (stateful, stateless) and the reader has to know which roles are which. Mitigated by the explicit table in this ADR and the session role registry in `.claude/rules/adapter-wiring.md`.

### Scope of Changes

| File | Change |
|:---|:---|
| `src/agents/acp/adapter.ts` | Add exported `closeNamedAcpSession(workdir, sessionName, agentName, sidecar?)` for explicit single-session close |
| `src/review/semantic.ts` | Initial `agent.run()`: `keepSessionOpen: false` → `true`; happy path calls `_semanticDeps.closeNamedAcpSession`; retry call already `keepSessionOpen: false` |
| `src/review/adversarial.ts` | Initial `agent.run()`: `keepSessionOpen: false` → `true`; happy path calls `_adversarialDeps.closeNamedAcpSession`; retry call already `keepSessionOpen: false` |
| `test/unit/review/semantic-retry.test.ts` | Added initial call `keepSessionOpen: true` assertion; added happy-path/retry-path `closeNamedAcpSession` call count assertions |
| `test/unit/review/adversarial-retry.test.ts` | Same additions as semantic test |
| `docs/adr/ADR-008-session-lifecycle.md` | Refined invariant: "session closes by end of `runReview`" replaces "every `agent.run()` uses `keepSessionOpen: false`" |
| `.claude/rules/adapter-wiring.md` | Update Session Role Registry: semantic and adversarial now `keepSessionOpen: true` on initial call, explicit close on happy path, `false` on retry |
| `docs/adr/ADR-007-implementer-session-lifecycle.md` | Add superseded-by header pointing at this ADR (implementer rules are restated here) |

### Not Changed

- `src/review/dialogue.ts` — stateful by design; all five `keepSessionOpen: true` sites remain correct.
- `src/debate/session-stateful.ts` — caller decides per debater lifecycle phase; correct.
- `src/tdd/session-runner.ts` — implementer continuity logic remains; test-writer and verifier already close.
- All `complete()` call sites — no session lifecycle concept applies.

---

## 6. Implementer Rules Carried Forward from ADR-007

This ADR supersedes ADR-007 structurally (one file covers all roles) but preserves its conclusions for the implementer role verbatim:

1. Session name is `nax-<hash8>-<feature>-<storyId>-implementer` across all five execution strategies.
2. The session stays open from the main execution run through TDD rectification, autofix, and verification rectification.
3. Retry attempts within a fix loop send a **continuation prompt** (error output + escalation preamble), not a full rebuild.
4. `sweepFeatureSessions()` at story completion is the single cleanup point.
5. Tier escalation starts a fresh session — continuity is scoped to one tier's attempts.

ADR-007 should be marked `Superseded by ADR-008` but left in place for historical context.

---

## References

- ADR-007 — implementer session lifecycle (superseded by this ADR)
- SPEC-session-continuity.md — implementer implementation spec
- SPEC-semantic-session-continuity.md — prerequisite naming spec
- SPEC-debate-session-mode.md — stateful debater lifecycle
- `.claude/rules/adapter-wiring.md` — session role registry (to be updated)
- `src/review/dialogue.ts` — reference implementation of stateful reviewer dialogue
- `src/tdd/rectification-gate.ts` — reference implementation of per-attempt `keepSessionOpen: !isLastAttempt`
