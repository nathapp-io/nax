# ADR-007: Single Continuous Implementer Session Across Fix Stages

**Status:** Proposed  
**Date:** 2026-04-12  
**Author:** William Khoo, Claude  

---

## Context

Every nax story that uses an LLM to write code opens an ACP session. When the code fails review or tests, the pipeline enters fix stages (autofix, verification rectification) where the same agent is asked to correct the problems. As of v0.62.0, these fix stages each open fresh agent sessions despite the implementer session from execution still being alive.

### The Problem

Three distinct gaps existed simultaneously:

**1. Inconsistent session naming across execution strategies.**  
TDD strategies (`three-session-tdd`, `three-session-tdd-lite`) pass `sessionRole: "implementer"` to `agent.run()`, producing `nax-<hash>-<feature>-<storyId>-implementer`. Single-session strategies (`no-test`, `test-after`, `tdd-simple`) pass no role, producing `nax-<hash>-<feature>-<storyId>`. Semantic review and autofix cannot reliably target the implementer session when the name varies by strategy. (Addressed by SPEC-semantic-session-continuity US-001.)

**2. Fix stages ignoring the open implementer session.**  
Both autofix (`autofix.ts:325`) and verification rectification (`rectification-loop.ts:242`) pass `sessionRole: "implementer"` but no `acpSessionName` and no `keepSessionOpen`. The ACP adapter creates a new session on every call instead of resuming the one opened by execution. The agent that wrote the code starts each fix attempt with no memory of what it implemented or what it already tried.

**3. Full prompt rebuilt on every retry.**  
Because no session is shared, the prompt builder has no choice but to send the complete context (constitution + story + ACs + isolation rules + diff + findings) on every attempt. For a 3-attempt autofix loop, this repeats 3-5 KB of context 2 unnecessary times.

### Observed Consequences

- Fix agents repeat approaches that failed in a prior attempt because they have no record of the prior attempt.
- Partial fixes from attempt N are sometimes undone in attempt N+1 because the agent has no continuity.
- Token waste of ~10-30K input tokens per failing story (the majority is on Opus tier where cost is 5× higher).
- The TDD rectification gate (`rectification-gate.ts`) accidentally got this right: it uses a shared `acpSessionName` and `keepSessionOpen: !isLastAttempt`. The inconsistency is a bug, not a design choice.

---

## Decision

**Keep one continuous implementer session alive from execution through all fix stages within a story.**

The session name `nax-<hash8>-<feature>-<storyId>-implementer` is produced by all five execution strategies (after SPEC-semantic-session-continuity US-001) and reused by every subsequent stage that involves the implementer:

```
execution          → opens session,  keepSessionOpen: true
TDD rectification  → resumes session, keepSessionOpen: !isLastAttempt  (already done)
semantic review    → resumes session, keepSessionOpen: true             (amended by this ADR)
autofix            → resumes session, keepSessionOpen: !isLastAttempt  (gap fixed)
verification rect  → resumes session, keepSessionOpen: !isLastAttempt  (gap fixed)
story completion   → sweepFeatureSessions() closes the session
```

Within the fix stages, subsequent retry attempts send a **continuation prompt** (only the new error output + escalation preamble) instead of a full prompt rebuild. The agent already has constitution, story, ACs, diff, and isolation rules in its conversation history from the first attempt.

### Amendment to Semantic Session Continuity Spec

The semantic session continuity spec (SPEC-semantic-session-continuity) set `keepSessionOpen: false` on the semantic review call — it assumed review was the last consumer. This ADR amends that: semantic review sets `keepSessionOpen: true` so the session survives into autofix if review fails. If review passes and no autofix follows, the session is closed naturally by `sweepFeatureSessions()` at story completion.

---

## Alternatives Considered

### A. Fresh session per stage (status quo)

Each stage opens its own session. Simple, isolated, predictable.

**Rejected because:** The agent that wrote the code has the full context of *why* it made each decision. A fresh session re-discovers that context from the diff and prompt — imperfectly, because the diff shows *what* changed but not the reasoning. Observed failures show agents cycling through the same wrong approaches across retries because they have no memory of prior attempts.

### B. Pass full context via prompt on each retry (no session continuity)

Keep fresh sessions but make the prompt richer — include prior attempt outputs and escalation context.

**Rejected because:** This is what the escalation preamble already does (`rethinkAtAttempt`, `urgencyAtAttempt`), and it's not sufficient. An agent reading a summary of its prior failure ("attempt 2: still failing") produces worse reasoning than one that has the actual conversation history. Session continuity also reduces token cost; richer prompts increase it.

### C. Single session for the entire run (across stories)

One ACP session handles all stories in a run. Maximises context but minimises isolation.

**Rejected because:** Stories are independent work items. Cross-story context contamination is a reliability risk (a constraint discovered in story A might not apply to story B, but the agent may over-apply it). Cross-story memory is the context engine's job (CONTEXT-001), not the session lifecycle's job. Session lifetime is bounded to one story.

### D. Session continuity for autofix only, not verification rectification

Apply the pattern only to autofix and leave verification rectification as-is.

**Rejected because:** The gap in verification rectification is identical — same retry loop, same missing `acpSessionName`, same full prompt rebuild. Applying the fix to one but not the other creates an inconsistent system where the implementer has memory in some loops but not others within the same story.

---

## Consequences

### Positive

- **Fix quality improvement.** The implementer agent sees its own prior attempts in context and can reason about why an approach failed before choosing the next one.
- **Token savings.** Continuation prompts replace full rebuilds on retries: ~60-70% input token reduction per retry attempt. Rough estimate: $0.02-0.05 per failing story, compounding at Opus tier.
- **Consistency.** All five execution strategies produce the same session name; all fix stages resume it. The TDD rectification gate was the accidental reference implementation — now the whole system matches it.
- **Cleaner session lifecycle.** One session open, one session closed per story. `sweepFeatureSessions()` as the single cleanup point rather than ad-hoc closes across stages.

### Negative / Trade-offs

- **Session compaction risk.** Long stories (many retries, large diffs) may trigger ACP session compaction. Compaction summarises older turns — the summary may lose precision compared to the original. Mitigation: compaction is handled by the ACP provider transparently; the agent still sees a coherent summary. If evidence shows critical context is lost, the continuation prompt can include a "context refresh" block with story title + ACs.
- **Session state uncertainty on crash.** If the agent process crashes mid-session, the session may be in an undefined state. The fix loop falls back to a fresh full-prompt call — no regression, just loss of the continuity benefit for that attempt.
- **Coupling between stages.** Stages now share a mutable session state. A bug in one stage that corrupts the session (e.g., filling context with noise) affects all subsequent stages. Mitigation: stages only append to the session; they don't rewrite history. The session is read-append, not read-write.
- **Tier escalation breaks continuity.** Each escalation tier starts a fresh session. This is intentional (new model, different capability), but it means the continuous session benefit is scoped to one tier's attempts. Logged clearly so debugging escalation issues doesn't assume continuity across tiers.

### Scope of Changes

| File | Change |
|:-----|:-------|
| `src/pipeline/stages/autofix.ts` | Add `acpSessionName`, `keepSessionOpen: !isLastAttempt`, `sessionConfirmedOpen` tracking, continuation prompt |
| `src/verification/rectification-loop.ts` | Add `acpSessionName`, `keepSessionOpen: !isLastAttempt` |
| `src/review/semantic.ts` | Change `keepSessionOpen: false` → `true` |
| `src/pipeline/stages/autofix-continuation.ts` | New: `buildReviewRectificationContinuation()` |
| `src/tdd/rectification-gate.ts` | Already correct — add continuation prompt (Phase 2) |

### Not Changed

- `src/review/adversarial.ts` — adversarial review uses its own session (`reviewer-adversarial`) intentionally. It needs a fresh destructive perspective, not the implementer's reasoning. This is the explicit exception to the continuous session pattern.
- Test-writer and verifier sessions — different cognitive roles; isolation is correct.
- Session lifecycle across stories — each story has exactly one implementer session; stories are fully isolated from each other.

---

## References

- SPEC-session-continuity.md (PROMPT-001) — implementation spec
- SPEC-semantic-session-continuity.md — prerequisite: normalises session naming across strategies
- `src/tdd/rectification-gate.ts:164` — reference implementation of continuous session wiring
- `src/review/dialogue.ts` — reference implementation of multi-turn continuation (reviewer dialogue)
