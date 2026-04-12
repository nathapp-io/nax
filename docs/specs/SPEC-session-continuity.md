# SPEC: Session Continuity for Fix Attempts (PROMPT-001)

## Summary

Establish a **single continuous implementer session** that spans from initial code execution through review, autofix, and verification rectification — all within one story. The same agent that wrote the code fixes it, with full memory of what it implemented and why. Subsequent fix attempts send only the **delta** (new error output + escalation preamble) instead of rebuilding the full prompt, cutting input tokens by ~60-70% per retry and improving fix quality.

### The Single Continuous Session

Every story, regardless of execution strategy, opens one implementer session that persists until the story completes (pass, fail, or escalate):

```
nax-<hash8>-<feature>-<storyId>-implementer
```

All five execution strategies produce this same session:

| Strategy | Opens session at | `sessionRole` |
|:---|:---|:---|
| `no-test` | `execution.ts:244` | `"implementer"` |
| `test-after` | `execution.ts:244` | `"implementer"` |
| `tdd-simple` | `execution.ts:244` | `"implementer"` |
| `three-session-tdd-lite` | `session-runner.ts:175` | `"implementer"` |
| `three-session-tdd` | `session-runner.ts:175` | `"implementer"` |

The session flows through every stage that involves the implementer:

```
┌─ Execution ────────────────────────────────────────────────────┐
│  implementer writes code (all 5 strategies)                    │
│  keepSessionOpen: true                                         │
└────────────────────────────────┬───────────────────────────────┘
                                 │ same session
┌────────────────────────────────▼───────────────────────────────┐
│  TDD Rectification (three-session strategies only)             │
│  implementer fixes failing tests                               │
│  keepSessionOpen: !isLastAttempt  ← ALREADY WORKING            │
└────────────────────────────────┬───────────────────────────────┘
                                 │ same session
┌────────────────────────────────▼───────────────────────────────┐
│  Semantic Review (resumes implementer session)                 │
│  reviewer reads implementer context + diff  [semantic spec]    │
│  keepSessionOpen: true (autofix may follow)                    │
└────────────────────────────────┬───────────────────────────────┘
                                 │ same session
┌────────────────────────────────▼───────────────────────────────┐
│  Adversarial Review (OWN session — reviewer-adversarial)       │
│  does NOT resume implementer session (intentional isolation)   │
└────────────────────────────────┬───────────────────────────────┘
                                 │ same implementer session
┌────────────────────────────────▼───────────────────────────────┐
│  Autofix Rectification (if review failed)                      │
│  implementer fixes review findings                             │
│  keepSessionOpen: !isLastAttempt  ← THIS SPEC (currently broken)│
│  continuation prompt on attempt 2+                             │
└────────────────────────────────┬───────────────────────────────┘
                                 │ same session
┌────────────────────────────────▼───────────────────────────────┐
│  Verification Rectification (if tests fail after fix)          │
│  implementer fixes test failures                               │
│  keepSessionOpen: !isLastAttempt  ← THIS SPEC (currently broken)│
│  continuation prompt on attempt 2+                             │
└────────────────────────────────┬───────────────────────────────┘
                                 │
┌────────────────────────────────▼───────────────────────────────┐
│  Story Completion (pass / fail / escalate)                     │
│  session closed by sweepFeatureSessions or final attempt       │
└────────────────────────────────────────────────────────────────┘
```

**Why one session matters:** The agent that wrote the code knows *why* it made each decision — which approach it considered and rejected, what constraints it discovered, what the test-writer's tests expect. When review flags an issue, the same agent can reason about the fix in context: "I chose approach X because of constraint Y. The reviewer says X has a problem. Given Y, the fix is Z." A fresh session would re-discover Y from scratch — or worse, miss it entirely and produce a fix that violates Y.

**What stays separate:** Adversarial review intentionally uses its own session (`reviewer-adversarial`). It needs a fresh destructive perspective, not the implementer's reasoning. Test-writer and verifier (in three-session TDD) also use their own sessions — they are different cognitive roles. Only the implementer session is continuous.

## Motivation

### The Problem: Prompt Repetition on Failure

When a story fails review and enters the autofix loop, the current flow rebuilds the full prompt on every attempt:

```
Attempt 1: [constitution + story + AC + isolation + diff + findings]     → agent fixes
Attempt 2: [constitution + story + AC + isolation + diff + NEW findings] → agent fixes again
Attempt 3: [constitution + story + AC + isolation + diff + NEW findings] → agent fixes again
```

The agent session is often kept open (`keepSessionOpen: true` in `execution.ts:240-242`), meaning the ACP session already has the full context from Attempt 1 in its conversation history. But the prompt builder doesn't know this — it builds a self-contained prompt every time, re-sending ~3-5KB of context the agent already has.

### Quantified Waste

| Scenario | Attempts | Repeated tokens per attempt | Total waste |
|:---|:---|:---|:---|
| Autofix loop (lint/typecheck fail) | 2-3 | ~2-4K | ~4-12K tokens |
| Autofix loop (semantic/adversarial fail) | 2-3 | ~3-6K | ~6-18K tokens |
| Tier escalation (balanced → powerful) | 1-2 | ~4-8K (full rebuild) | ~4-16K tokens |
| Combined (3 autofix + 1 escalation) | 4 | Mixed | ~15-30K tokens |

At Sonnet pricing ($3/1M input), this is ~$0.05-0.09 per failed story. Across a feature with 40% failure rate and 20 stories, that's ~$0.40-0.72 in pure repetition cost. The cost is higher on Opus tier (~$0.60-1.50).

But the **real cost isn't tokens — it's fix quality**. When the agent receives a fresh prompt on each retry, it has no memory of what it already tried. It may:
- Repeat the same failing fix approach
- Undo a partial fix from the prior attempt
- Miss the accumulated context of "I tried X and it didn't work because Y"

### Current Session State — Full Audit

From comprehensive codebase analysis of every `agent.run()` and `agent.complete()` call:

| Component | File | Session open? | `keepSessionOpen` | `acpSessionName` | Prompt rebuilt? | Gap |
|:---|:---|:---|:---|:---|:---|:---|
| Execution (all strategies) | `execution.ts:244` | Yes (when review/rectify enabled) | `!!(review \|\| rectify)` | Implicit (from sessionRole) | N/A (first call) | None |
| TDD session runner | `session-runner.ts:175` | Implementer only | `role === "implementer" && rectify` | Implicit | N/A | None |
| TDD rectification gate | `rectification-gate.ts:214` | Yes, across attempts | `!isLastAttempt` | **Shared** (line 164) | Yes, fully | **Already optimized** — session carries context |
| **Autofix rectification** | `autofix.ts:325` | **No** | **Not set** | **Not set** | Yes, fully | **Missing both `keepSessionOpen` and `acpSessionName`** |
| **Verification rectification** | `rectification-loop.ts:242` | **No** | **Not set** | **Not set** | Yes, fully | **Missing both `keepSessionOpen` and `acpSessionName`** |
| Review dialogue | `dialogue.ts:309,355,415,448,506` | Yes (all 5 turns) | `true` (always) | Shared | Delta only | **Already optimized** — model for others |
| Semantic review | `semantic.ts:381` | Targets implementer | `false` | Implementer session name | N/A | One-shot, no retry |
| Adversarial review | `adversarial.ts:233` | Own session | `false` | Own session name | N/A | One-shot by design, no retry |
| Acceptance diagnosis | `fix-diagnosis.ts:140` | Own session | Not set | Own session name | N/A | Single diagnostic call |
| Debate proposals | `session-stateful.ts:53` | Configurable | From options | Per-debater | N/A | Parallel, not retry |

**Components already participating in the continuous implementer session:**
- Execution stage (`execution.ts:244`) — opens the session with `keepSessionOpen: true`
- TDD rectification gate (`rectification-gate.ts:214`) — resumes with shared `acpSessionName` + `keepSessionOpen: !isLastAttempt`
- Semantic review (`semantic.ts:381`) — resumes with implementer session name (via semantic session continuity spec)

**Components that SHOULD participate but currently don't (the gap this spec fixes):**
- Autofix (`autofix.ts:325`) — passes `sessionRole: "implementer"` but **no `acpSessionName`** and **no `keepSessionOpen`**. Each retry opens a fresh session instead of resuming the implementer's.
- Verification rectification (`rectification-loop.ts:242`) — same problem. Both could follow the TDD rectification gate pattern exactly.

**Components correctly isolated from the implementer session:**
- Adversarial review — own session (`reviewer-adversarial`), one-shot, intentional isolation
- Test-writer — own session, different cognitive role
- Verifier — own session, different cognitive role
- Review dialogue — own session (`reviewer`), multi-turn but separate perspective

The TDD rectification gate serves as the **reference implementation** for how to wire into the continuous session:
```typescript
// rectification-gate.ts:164 — already working
const rectificationSessionName = buildSessionName(workdir, featureName, story.id, "implementer");
// ...
await agent.run({
  acpSessionName: rectificationSessionName,
  keepSessionOpen: !isLastAttempt,
  // ...
});
```

Autofix and verification rectification need the same two lines added.

## Non-Goals

- **No changes to tier escalation sessions.** When escalating from `balanced` to `powerful`, a new model handles the task. A fresh session with full context is correct — the new model hasn't seen the conversation. The first attempt on a new tier always uses full mode.
- **No merging of non-implementer sessions.** Test-writer, verifier, adversarial reviewer, and debaters each have their own sessions with their own cognitive roles. Only the implementer session is continuous.
- **No session persistence across stories.** Each story gets its own implementer session. Cross-story memory is the context engine's job (CONTEXT-001), not this spec's.
- **No prompt caching changes.** ACP/Anthropic prompt caching already reduces cost for repeated prefixes. This spec reduces what's sent, not how it's cached. The two are complementary.
- **No architectural changes to the prompt builder.** The builder stays capable of producing self-contained prompts. Continuation mode is an addition, not a replacement.

## Design

### Continuation-Aware Prompt Building

The core change is a **two-mode prompt builder** for autofix:

1. **Full mode** (first attempt, or session was closed/reset): Build the complete self-contained prompt as today.
2. **Continuation mode** (subsequent attempts in the same open session): Build only the delta.

The autofix stage tracks whether this is a continuation via a simple boolean:

```typescript
// src/pipeline/stages/autofix.ts — in the retry loop
const isSessionContinuation = attempt > 0 && sessionStillOpen;

const prompt = isSessionContinuation
  ? buildReviewRectificationContinuation(state.failedChecks, attempt, maxAttempts, rethinkAtAttempt, urgencyAtAttempt)
  : buildReviewRectificationPrompt(state.failedChecks, ctx.story);
```

### Continuation Prompt Format

The continuation prompt is minimal — just the new error output and escalation context:

```typescript
// src/pipeline/stages/autofix-prompts.ts

export function buildReviewRectificationContinuation(
  failedChecks: ReviewCheckResult[],
  attempt: number,
  maxAttempts: number,
  rethinkAtAttempt: number,
  urgencyAtAttempt: number,
): string {
  const parts: string[] = [];

  parts.push("Your previous fix attempt did not resolve all issues. Here are the remaining failures:\n");

  for (const check of failedChecks) {
    parts.push(`### ${check.check} (exit ${check.exitCode})\n`);
    parts.push("```\n" + check.output.slice(0, 4000) + "\n```\n");
    if (check.findings?.length) {
      parts.push("Structured findings:\n");
      for (const f of check.findings) {
        parts.push(`- [${f.severity}] ${f.file}:${f.line} — ${f.message}\n`);
      }
    }
  }

  // Escalation preamble (same as existing, but only the delta)
  if (attempt >= rethinkAtAttempt) {
    parts.push("\n**Rethink your approach.** The same strategy has failed multiple times. Consider a fundamentally different fix.\n");
  }
  if (attempt >= urgencyAtAttempt) {
    parts.push("\n**URGENT: This is your final attempt.** If you cannot fix all issues, emit `UNRESOLVED: <reason>` to escalate.\n");
  }

  parts.push(CONTRADICTION_ESCAPE_HATCH);

  return parts.join("\n");
}
```

**What's NOT in the continuation prompt:**
- Constitution (already in session context)
- Story title, description, ACs (already in session context)
- Isolation rules (already in session context)
- Diff (already in session context from the first attempt)
- Context markdown / feature context (already injected)

### Session Lifecycle Rules — The Continuous Implementer Session

The implementer session opens at execution and stays open until the story completes. Every stage that involves the implementer resumes the same session by passing the same `acpSessionName`:

```typescript
const implementerSession = buildSessionName(workdir, featureName, storyId, "implementer");
// Used by: execution, TDD rectification, semantic review, autofix, verification rectification
```

**`keepSessionOpen` rules per stage:**

| Stage | `keepSessionOpen` | Rationale |
|:---|:---|:---|
| Execution | `true` (always) | Review or rectification may follow |
| TDD rectification | `!isLastAttempt` | Keep open for review; close on final attempt only if no review follows |
| Semantic review | `true` | Autofix may follow if review fails |
| Autofix attempt 1..N-1 | `true` | Next attempt continues the session |
| Autofix final attempt | `false` | Story completes after this |
| Verification rectification 1..N-1 | `true` | Next attempt continues |
| Verification rectification final | `false` | Story completes after this |

**Key change from current state:** Semantic review currently sets `keepSessionOpen: false` (thinks it's the last consumer). This spec changes it to `true` so autofix can resume the same session. If review passes (no autofix needed), the session is closed in the completion phase by `sweepFeatureSessions()`.

**Fallback rules:**

1. **Session closed between stages**: If the session was closed (crash recovery, timeout, sweep), fall back to full mode. The adapter's `ensureAcpSession()` creates a new session transparently — no regression, just loss of the optimization.

2. **Session role consistency**: All stages use `sessionRole: "implementer"` and the same `acpSessionName`. This is already true for execution, TDD rectification, and autofix. This spec adds it to verification rectification.

3. **Session compaction**: If the ACP provider compacts the session mid-story (conversation too long), the provider handles this transparently — the agent still sees the full context in its compacted form. No special handling needed.

4. **Tier escalation breaks the session**: When escalating from `balanced` to `powerful`, a new model starts a new session. The first attempt on the new tier uses full mode. This is correct — different model, different context window.

### Detecting Whether the Session Is Continuable

The autofix stage resumes the continuous implementer session — but it needs to know if the session still exists (execution and review stages succeeded before it). Two approaches:

**Option A: Assume open.** The autofix stage only runs after review, which only runs after execution. If both succeeded, the implementer session is open. The first autofix attempt always uses the session name from `buildSessionName()`. If the session doesn't exist, `ensureAcpSession()` creates it — the full prompt is sent anyway (attempt 0).

For subsequent attempts within the autofix loop, track a local `sessionConfirmedOpen` flag:

```typescript
const implementerSession = buildSessionName(ctx.workdir, ctx.prd.feature, ctx.story.id, "implementer");
let sessionConfirmedOpen = true; // Assume open — execution + review came before us

for (let attempt = 0; attempt < maxAttempts; attempt++) {
  const isSessionContinuation = attempt > 0 && sessionConfirmedOpen;

  const prompt = isSessionContinuation
    ? buildReviewRectificationContinuation(state.failedChecks, ...)
    : buildReviewRectificationPrompt(state.failedChecks, ctx.story);

  try {
    const result = await agent.run({
      prompt,
      acpSessionName: implementerSession,
      keepSessionOpen: !isLastAttempt,
      sessionRole: "implementer",
      // ...
    });
    sessionConfirmedOpen = true;
  } catch (err) {
    sessionConfirmedOpen = false; // Session state unknown — next attempt uses full prompt
  }
}
```

**Option B: Query the adapter.** Add `isSessionOpen(sessionName: string): Promise<boolean>` to `AgentAdapter`.

Option A is simpler and sufficient. The continuous session design means the session is almost always open when autofix starts. The flag handles the rare failure case.

### TDD Rectification (Verification Loop)

The same pattern applies to the TDD rectification gate (`src/tdd/rectification-gate.ts`), which retries when tests fail after implementation:

```
Attempt 1: [full story + test output + rectification instructions] → agent fixes
Attempt 2: [full story + NEW test output + rectification instructions] → same fix
```

The rectification gate should also use continuation mode when the implementer session is open. The `RectifierPromptBuilder` gets a `.continuation()` variant that sends only the new test output.

### What Changes for Tier Escalation

**The continuous session breaks at tier boundaries.** Tier escalation creates a new session with a new model (e.g. `balanced` → `powerful`). The new model has no memory of the previous tier's conversation. This is the correct behavior — a fresh perspective is the point of escalation.

```
balanced tier:
  execution → TDD rectify → review → autofix (attempts 1-3, continuation)
    ↓ escalation (session breaks here)
powerful tier:
  execution → TDD rectify → review → autofix (attempts 1-3, continuation)
    ↑ new continuous session starts here
```

Each tier gets its own continuous implementer session. The session name is the same (`nax-<hash>-<feature>-<storyId>-implementer`), but the old session was closed at escalation and a new one is created by the new tier's execution stage.

## Cost Model

### Per-Story Token Savings

| Metric | Before | After | Savings |
|:---|:---|:---|:---|
| Autofix attempt 2 input | ~4K tokens | ~1.2K tokens | ~70% |
| Autofix attempt 3 input | ~4K tokens | ~1.2K tokens | ~70% |
| Rectification attempt 2 input | ~3K tokens | ~0.8K tokens | ~73% |
| Total for 3-attempt story | ~12K input | ~5.2K input | ~57% |

### Per-Feature Impact

Assumptions: 20 stories, 40% failure rate (8 stories fail), average 2.5 retries per failing story.

| Metric | Before | After | Savings |
|:---|:---|:---|:---|
| Retry input tokens | ~80K | ~33K | ~59% |
| Cost at Sonnet ($3/1M) | ~$0.24 | ~$0.10 | ~$0.14 |
| Cost at Opus ($15/1M) | ~$1.20 | ~$0.50 | ~$0.70 |

### Fix Quality Improvement (Harder to Quantify)

The agent seeing its own prior attempt is the higher-value benefit:
- **Avoids repeating failed approaches.** The agent's conversation history shows "I tried X, it produced this error." It naturally tries something different.
- **Preserves partial progress.** If attempt 1 fixed 2 of 3 lint errors but introduced a new one, the continuation makes this visible. A full-prompt retry might undo the 2 fixes.
- **Reduces UNRESOLVED escalations.** Some escalations happen because the agent cycles through the same approach 3 times. Session continuity breaks the cycle earlier.

Estimated: 10-20% reduction in escalation rate for stories that enter the autofix loop. This is the ROI that justifies the feature beyond token savings.

## File Surface

### New files

- `src/pipeline/stages/autofix-continuation.ts` — `buildReviewRectificationContinuation()` function
- `test/unit/pipeline/stages/autofix-continuation.test.ts` — unit tests for continuation prompt builder

### Modified files

- `src/pipeline/stages/autofix.ts` — add `acpSessionName`, `keepSessionOpen: !isLastAttempt`, `sessionConfirmedOpen` tracking, choose between full and continuation prompts
- `src/pipeline/stages/autofix-prompts.ts` — export `CONTRADICTION_ESCAPE_HATCH` for reuse in continuation builder
- `src/verification/rectification-loop.ts` — add `acpSessionName` and `keepSessionOpen: !isLastAttempt` to `agent.run()` call at line 242 (same pattern as TDD rectification gate)
- `src/tdd/rectification-gate.ts` — already has session continuity; add continuation prompt mode (optional Phase 2)
- `src/prompts/builders/rectifier-builder.ts` — add `.continuation()` variant (optional Phase 2)

- `src/review/semantic.ts` — change `keepSessionOpen` from `false` to `true` so the continuous implementer session survives into autofix (session targeting itself handled by SPEC-semantic-session-continuity)

### Unchanged files

- `src/agents/types.ts` — no interface changes (no `isSessionOpen` method)
- `src/agents/acp/adapter.ts` — no changes (session lifecycle unchanged)
- `src/review/dialogue.ts` — already optimized, serves as the model implementation
- `src/review/adversarial.ts` — one-shot by design, own session, no changes needed

## Rollout

### Phase 0 — Session wiring (prerequisite, no prompt changes)

Wire `acpSessionName` and `keepSessionOpen` into the two retry loops that are missing them. This is pure plumbing — no continuation prompt yet, just ensuring the session stays open across attempts so Phase 1 can leverage it.

- `autofix.ts:325` — add `acpSessionName: buildSessionName(workdir, featureName, storyId, "implementer")` and `keepSessionOpen: !isLastAttempt`
- `rectification-loop.ts:242` — add `acpSessionName: buildSessionName(workdir, featureName, storyId, "implementer")` and `keepSessionOpen: !isLastAttempt`
- Both follow the exact pattern already working in `rectification-gate.ts:214`
- Unit tests: verify `acpSessionName` is passed and `keepSessionOpen` toggles correctly

**Dependency:** Requires SPEC-semantic-session-continuity US-001 (normalized `sessionRole: "implementer"` across all strategies) to ensure session names match.

### Phase 1 — Autofix continuation mode

- Implement `buildReviewRectificationContinuation()`.
- Add `sessionConfirmedOpen` tracking to the autofix retry loop.
- Choose continuation vs full prompt based on session state.
- Unit tests for continuation prompt builder.
- Integration test: mock a 3-attempt autofix loop, verify attempt 2 and 3 use continuation prompts.
- Measure: compare input token counts before/after on a reference run.

### Phase 2 — Verification + TDD rectification continuation

- Apply continuation prompt to `rectification-loop.ts` (verification rectification).
- Apply continuation prompt to `rectification-gate.ts` (TDD rectification — already has session wiring, just needs delta prompt).
- Add `continuation()` variant to `RectifierPromptBuilder`.
- Verify the implementer session is open before using continuation mode.

### Phase 3 — Measurement and tuning

- Track per-attempt prompt sizes in metrics.
- Compare escalation rates before/after.
- If continuation mode causes fix quality regression (agent loses context after compaction), add a fallback: if the continuation attempt fails, retry with full prompt.

### Rollback

- Remove continuation mode branching — the full prompt path is always available as fallback.
- No config flag needed: continuation mode is an internal optimization, not user-facing behavior. But a `debug.disablePromptContinuation` flag can be added if rollback needs to be testable without code changes.

## Risks

### Session compaction loses critical context

ACP sessions may compact older conversation turns when the context window fills. If compaction removes the original story/AC context from the conversation, the continuation prompt (which omits story/AC) leaves the agent without that information.

**Mitigation:** ACP compaction preserves a summary of compacted turns. The story/AC are high-signal and should survive summarization. If evidence shows otherwise, add a "context refresh" block to the continuation prompt that re-injects story title + ACs (much smaller than the full prompt).

### Agent interprets continuation as a new task

If the continuation prompt doesn't clearly signal "this is a follow-up to your previous attempt," the agent may treat it as a fresh task without the prior context.

**Mitigation:** The continuation prompt opens with: "Your previous fix attempt did not resolve all issues." This is an explicit signal. The ACP session's conversation history provides the rest of the context.

### Race condition: session closed between attempts

The session may be closed by a concurrent process (e.g., session sweep, timeout) between attempts. The `sessionConfirmedOpen` flag would be stale.

**Mitigation:** If the agent call with a continuation prompt fails (session not found), catch the error, reset `sessionConfirmedOpen = false`, and retry with a full prompt. One extra call in a rare edge case — acceptable.

### Continuation prompt diverges from full prompt

Over time, if the full prompt changes (new sections, updated constitution format) but the continuation prompt isn't updated, the two modes may produce inconsistent behavior.

**Mitigation:** The continuation prompt is intentionally minimal — it contains only error output and escalation preamble, which are the same data in both modes. The risk of divergence is low because the continuation doesn't duplicate sections from the full prompt.

## Interaction with Other Specs

### SPEC-semantic-session-continuity (Semantic Review Session Continuity)

The semantic session continuity spec makes the **reviewer resume the implementer's session** — the reviewer reads the implementer's full conversation history instead of working from a cold diff.

**Potential conflict: session lifecycle overlap.**

The semantic spec says:
- Execution stage keeps implementer session open (`keepSessionOpen: true` when review enabled)
- Semantic reviewer resumes implementer session with `keepSessionOpen: false` (last consumer)
- Autofix, if needed, opens its own turn after review

This spec (PROMPT-001) says:
- Autofix should keep the session open across retry attempts (`keepSessionOpen: !isLastAttempt`)

**Resolution — complementary, with one amendment to the semantic spec.**

The semantic spec sets `keepSessionOpen: false` for semantic review (it assumes it's the last consumer). This spec amends that to `keepSessionOpen: true` — the continuous implementer session should stay open until the story completes, not until the last known consumer at design time. The session flows:

```
execution.run()  → keepSessionOpen: true    [semantic spec US-001]
  ↓ same session
semantic review  → resumes session, keepSessionOpen: true  [semantic spec + THIS spec amendment]
  ↓ same session (if review fails)
autofix attempt 1 → resumes session, keepSessionOpen: true  [THIS spec]
autofix attempt 2 → continues session, keepSessionOpen: true  [THIS spec]
autofix attempt N → continues session, keepSessionOpen: false  [THIS spec — last consumer]
  ↓ (if review passes — no autofix)
story completion  → sweepFeatureSessions() closes the session  [existing cleanup]
```

**Dependency:** This spec must be implemented **after** the semantic session continuity spec. The semantic spec normalizes session naming across all five strategies (US-001) and threads `featureName` through the call chain (US-002). PROMPT-001 depends on both.

**Amendment to semantic spec US-003:** Change `keepSessionOpen: false` to `keepSessionOpen: true` in the semantic review `agent.run()` call. If review passes and no autofix follows, the session is closed by `sweepFeatureSessions()` in the completion phase — no dangling sessions.

### Adversarial Review (REVIEW-003)

**No conflict.** Adversarial review:
- Uses its **own** session (`reviewer-adversarial`), not the implementer session
- Is always one-shot (`keepSessionOpen: false`) — no retry loop
- Produces findings that flow to autofix as `ReviewCheckResult`

Adversarial findings appear in the autofix prompt alongside other check failures. The continuation prompt includes them in the same format. No special handling needed.

**Session isolation is correct:** The adversarial reviewer intentionally does NOT resume the implementer session. It operates from a fresh perspective (destructive heuristics) and should not be influenced by the implementer's reasoning. This is the opposite of semantic review, which benefits from implementer context.

### CONTEXT-001 (Feature Context Engine)

Session continuity and the context engine are complementary:
- **Context engine** prevents cross-story mistakes (feature-scoped memory).
- **Session continuity** prevents within-story repeated mistakes (session-scoped memory).

The context engine's role-filtered context is injected in the full prompt (attempt 1). Continuation attempts don't need to re-inject it — it's already in the session.

### REVIEW-003 (Adversarial Review — UNRESOLVED Escape Hatch)

The UNRESOLVED escape hatch (`CONTRADICTION_ESCAPE_HATCH`) is included in both full and continuation prompts — the agent must always have the option to signal an impossible fix. The continuation prompt explicitly includes it (not inherited from session context) because it's a behavioral instruction that must be salient on every attempt.

## Acceptance Criteria

1. **Continuation prompt built on retry:** When the autofix loop enters attempt 2+ and the session is confirmed open, the prompt is built via `buildReviewRectificationContinuation()`, not `buildReviewRectificationPrompt()`.

2. **Full prompt on first attempt:** Attempt 0 always uses the full prompt regardless of session state.

3. **Full prompt on session failure:** If the prior attempt threw an error (session state unknown), the next attempt uses the full prompt.

4. **Continuation prompt content:** The continuation prompt contains only: new error output, escalation preamble (if applicable), and the CONTRADICTION_ESCAPE_HATCH. It does NOT contain: constitution, story title/ACs, isolation rules, diff, or context markdown.

5. **Token reduction:** For a 3-attempt autofix loop, the total input tokens for attempts 2-3 are at least 50% less than the full prompt's token count. Verified by metrics comparison.

6. **Fix quality parity:** Stories that enter the autofix loop with continuation mode enabled have equal or better fix success rates compared to full-prompt mode. Measured over a reference run of 20+ stories.

7. **Escalation unaffected:** Tier escalation always starts a new session with a full prompt. Continuation mode is never used on the first attempt after escalation.

8. **UNRESOLVED escape hatch preserved:** The CONTRADICTION_ESCAPE_HATCH block is present in both full and continuation prompts. The UNRESOLVED detection in `autofix.ts` works identically in both modes.

9. **Fallback on session loss:** If a continuation-mode attempt fails due to session not found, the stage retries with a full prompt without counting as an additional attempt.

10. **No user-visible behavior change:** From the user's perspective, autofix behavior is identical. The optimization is internal — prompt content changes, not outcomes.
