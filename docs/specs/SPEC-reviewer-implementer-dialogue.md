# SPEC: Reviewer-Implementer Dialogue

## Summary

Replace the stateless one-shot semantic review with a persistent `ReviewerSession` that uses `agent.run()` for tool-enabled AC verification and stays open for the story's lifetime. The autofix agent communicates with the reviewer through a dialogue channel — requesting clarification on findings and receiving targeted guidance — instead of attempting blind fixes from serialized JSON. Re-reviews build on previous context rather than starting from scratch.

## Motivation

Today's semantic review flow has three structural problems:

1. **No tool access.** The semantic review prompt (`src/review/semantic.ts:154-158`) instructs the LLM to "READ the relevant file" and "GREP for its usage" to verify findings — but it calls `agent.complete()` which provides no tool execution. The reviewer cannot actually verify its findings, leading to false positives that waste rectification attempts.

2. **Lost context across rounds.** The reviewer produces JSON findings via a one-shot call. Findings are serialized as text into the autofix prompt. The implementer only sees "AC-3 not satisfied" without understanding the reviewer's reasoning. When re-review runs after autofix, it starts from scratch — no memory of what was flagged, what was attempted, or what was already verified.

3. **No clarification path.** When the implementer is unsure how to satisfy a finding, it guesses. A human would ask "what specifically do you mean by X?" — the implementer cannot. This leads to wasted rectification attempts on misunderstood findings.

## Design

### Existing Types to Extend

- `PipelineContext` in `src/pipeline/types.ts` — add `reviewerSession?: ReviewerSession` field
- `ReviewConfig` in `src/review/types.ts` — add `dialogue: ReviewDialogueConfig` field
- `NaxConfigSchema` in `src/config/schemas.ts` — add `review.dialogue` Zod schema with defaults

### Integration Points

- `src/review/semantic.ts` — current `runSemanticReview()` uses `agent.complete()` at line 472; `ReviewerSession.review()` replaces this with `agent.run()`
- `src/pipeline/stages/review.ts` — creates `ReviewerSession` on first semantic review, stores in `ctx.reviewerSession`; on re-review calls `ctx.reviewerSession.reReview()` instead of fresh `runSemanticReview()`
- `src/pipeline/stages/autofix.ts` — reads `ctx.reviewerSession.history` for context; detects `CLARIFY:` blocks in agent output and relays to `reviewerSession.clarify()`
- `src/pipeline/stages/autofix-prompts.ts` — `buildDialogueAwareRectificationPrompt()` includes findings with reasoning and dialogue history
- `src/pipeline/stages/completion.ts` — calls `ctx.reviewerSession.destroy()` on story pass/fail

### Existing Patterns to Follow

- `src/review/semantic.ts` — current semantic review implementation (prompt structure, diff collection, finding parsing)
- `src/pipeline/stages/autofix.ts:290-302` — existing `agent.run()` call pattern for autofix rectification (session role, permissions, timeout)
- `src/debate/session.ts` — existing persistent session pattern with `runStateful()` using `adapter.run()`

### Approach

This uses `agent.run()` (persistent interactive session with tool support) instead of `agent.complete()` (one-shot, no tools). The reviewer session opens on first semantic review and stays open — `reReview()` and `clarify()` are follow-up prompts within the same session, not separate calls.

**Why `run()` not `complete()`:** The ACP adapter (`src/agents/acp/adapter.ts:974-975`) closes sessions in the `finally` block after every `complete()` call. `sessionName` reuse does not maintain conversation context — each `complete()` is truly ephemeral. `run()` creates a session that persists until explicitly closed.

### Architecture

```
Story lifecycle:
  ┌─────────────────────────────────────────────────┐
  │  ReviewerSession (agent.run(), persistent)       │
  │  - Created on first semantic review              │
  │  - Has tool access (READ, GREP) to verify ACs   │
  │  - Receives updated diffs on re-review           │
  │  - Answers clarification questions from autofix  │
  │  - Destroyed on story pass or fail               │
  └─────────────────────────────────────────────────┘
          ▲                          │
          │ clarification request    │ findings + reasoning
          │                          ▼
  ┌─────────────────────────────────────────────────┐
  │  Autofix/Rectification Agent (agent.run())       │
  │  - Receives findings + per-finding reasoning     │
  │  - Can send CLARIFY: block → relayed to reviewer │
  │  - Makes targeted fixes with full context        │
  └─────────────────────────────────────────────────┘
```

### Core Types

```typescript
// src/review/dialogue.ts

import type { AgentAdapter } from "../agents/types";
import type { ReviewFinding } from "../plugins/types";
import type { ReviewCheckResult, SemanticReviewConfig } from "./types";
import type { SemanticStory } from "./semantic";

/** A message in the reviewer-implementer dialogue */
interface DialogueMessage {
  role: "reviewer" | "implementer";
  content: string;
  timestamp: number;
}

/** Persistent reviewer session that maintains context across review rounds */
interface ReviewerSession {
  storyId: string;
  history: DialogueMessage[];
  active: boolean;

  /** Initial review — opens agent.run() session, produces findings with reasoning */
  review(diff: string, story: SemanticStory, config: SemanticReviewConfig): Promise<ReviewDialogueResult>;
  /** Re-review after implementer has made changes — same session, references previous findings */
  reReview(updatedDiff: string): Promise<ReviewDialogueResult>;
  /** Answer a clarification question from the implementer — same session */
  clarify(question: string): Promise<string>;
  /** Extract final semantic verdict for acceptance bridge consumption */
  getVerdict(): SemanticVerdict;
  /** Close the agent.run() session */
  destroy(): Promise<void>;
}

/** Extended review result with per-finding reasoning */
interface ReviewDialogueResult {
  checkResult: ReviewCheckResult;
  findingReasoning: Map<string, string>;
  deltaSummary: string;
}
```

### Config Schema

```typescript
// src/config/schemas.ts — add to ReviewConfig schema

const ReviewDialogueConfigSchema = z.object({
  enabled: z.boolean().default(false),
  maxClarificationsPerAttempt: z.number().int().min(0).max(10).default(2),
  maxDialogueMessages: z.number().int().min(5).max(100).default(20),
});
```

### Clarification Protocol

The autofix agent requests clarification by including a structured block in its output:

```
CLARIFY: For AC-3, the reviewer says "missing error handling for network timeout"
but the function already has a try/catch at line 42. Is this sufficient or does it
need a specific timeout check?
```

The autofix stage detects this pattern via regex (`/^CLARIFY:\s*(.+)$/ms`), calls `reviewerSession.clarify(question)`, appends the answer to the rectification prompt, and re-sends to the implementer — all within the same rectification attempt. Max 2 round-trips per attempt.

### Backward Compatibility

- **Feature gated:** `review.dialogue.enabled` (default: `false`). When disabled, existing one-shot `runSemanticReview()` behavior is unchanged.
- **Debate compatibility:** When `debate.stages.review.enabled` and `review.dialogue.enabled` are both true, dialogue takes precedence (debate = multi-reviewer; dialogue = reviewer↔implementer — different concerns).
- **Acceptance bridge upgrade:** `SPEC-acceptance-bridge-nax.md` US-003 persists semantic verdicts via file I/O from `ctx.reviewResult.checks`. When this spec lands, `persistSemanticVerdict()` swaps to `reviewerSession.getVerdict()` — same `SemanticVerdict` type, only the producer changes.

### Failure Handling

- **Reviewer session crash** — fall back to stateless one-shot `runSemanticReview()`. Log warning at `warn` level. Don't block the pipeline (fail-open).
- **Clarification timeout** — treat as "no clarification available." Implementer proceeds with best guess. Log at `debug` level.
- **Context overflow** — when `history` length exceeds `maxDialogueMessages`, call `destroy()` and create a fresh session with a compacted summary of previous exchanges injected as initial context.
- **Clarification parse failure** — if the autofix agent's output doesn't match the `CLARIFY:` regex, skip clarification and proceed with the fix attempt.
- **Non-session agents** — if `agent.run()` is unavailable (e.g., adapter doesn't support persistent sessions), fall back to stateless mode with history injected as prompt context.

## Stories

### US-001: Config Schema + ReviewerSession Core

**Dependencies:** none
**Complexity:** medium

Add `ReviewDialogueConfig` to the config schema and implement the `ReviewerSession` type with `createReviewerSession()` factory, `review()`, and `destroy()` methods.

#### Context Files
- `src/config/schemas.ts` — Zod schema definitions (add `ReviewDialogueConfigSchema` nested under `review`)
- `src/config/schema-types.ts` — config type definitions (add `ReviewDialogueConfig` to `ReviewConfig`)
- `src/review/types.ts` — `ReviewCheckResult`, `SemanticReviewConfig` types
- `src/review/semantic.ts` — current `runSemanticReview()` at line 472 (pattern for prompt + finding parsing)
- `src/pipeline/stages/autofix.ts:290-302` — existing `agent.run()` call pattern to follow
- `src/review/dialogue.ts` — new file for `ReviewerSession`, `DialogueMessage`, `ReviewDialogueResult`

#### Acceptance Criteria
- `ReviewDialogueConfigSchema` has `enabled` (boolean, default `false`), `maxClarificationsPerAttempt` (number, min 0, max 10, default `2`), `maxDialogueMessages` (number, min 5, max 100, default `20`)
- `ReviewConfig` includes a `dialogue` field of type `ReviewDialogueConfig`
- `DEFAULT_CONFIG.review.dialogue.enabled` is `false`
- `createReviewerSession(agent, storyId, workdir, config)` returns a `ReviewerSession` with `active: true` and empty `history`
- `ReviewerSession.review(diff, story, semanticConfig)` calls `agent.run()` with the semantic review prompt, parses the JSON response into a `ReviewDialogueResult` containing `checkResult` and `findingReasoning`
- `review()` appends the prompt (role: `"implementer"`) and response (role: `"reviewer"`) to `history`
- `ReviewerSession.destroy()` closes the `agent.run()` session, sets `active: false`, and clears `history`
- When `review()` is called on a destroyed session (`active: false`), it throws a `NaxError` with code `REVIEWER_SESSION_DESTROYED`

### US-002: Re-review, Clarification, and Verdict

**Dependencies:** US-001
**Complexity:** medium

Add `reReview()`, `clarify()`, and `getVerdict()` to `ReviewerSession`. Re-review sends the updated diff to the same open session referencing previous findings. Clarification sends a question and returns the reviewer's response. Verdict extracts the final semantic pass/fail for acceptance bridge consumption.

#### Context Files
- `src/review/dialogue.ts` — `ReviewerSession` from US-001
- `src/review/semantic.ts:127-184` — existing prompt structure for semantic review (follow same AC verification instructions)
- `src/acceptance/types.ts` — `SemanticVerdict` type (from acceptance bridge spec, consumed by `getVerdict()`)

#### Acceptance Criteria
- `reReview(updatedDiff)` sends a follow-up prompt to the same `agent.run()` session (not a new session) that includes "You previously found these issues: ..." referencing the last `checkResult.findings`
- `reReview()` returns a `ReviewDialogueResult` with `deltaSummary` describing which previous findings are resolved vs still present
- `reReview()` appends both the prompt and response to `history`
- When `history.length` exceeds `maxDialogueMessages`, `reReview()` destroys the current session, creates a fresh one with a compacted summary of previous exchanges as initial context, and logs at `debug` level
- `clarify(question)` sends the question as a follow-up prompt to the same session and returns the raw response text
- `clarify()` appends both the question (role: `"implementer"`) and answer (role: `"reviewer"`) to `history`
- `getVerdict()` returns a `SemanticVerdict` with `storyId`, `passed` (from last `checkResult.success`), `timestamp`, `acCount`, and `findings` (from last `checkResult.findings`)
- When called before any `review()`, `getVerdict()` throws `NaxError` with code `NO_REVIEW_RESULT`

### US-003: Pipeline Integration

**Dependencies:** US-002
**Complexity:** medium

Wire `ReviewerSession` into the review stage, autofix stage, and completion stage. The review stage creates the session; autofix reads dialogue context and relays clarifications; completion destroys the session.

#### Context Files
- `src/pipeline/stages/review.ts` — review stage orchestrator (creates session, stores in `ctx.reviewerSession`)
- `src/pipeline/stages/autofix.ts:208-335` — autofix agent rectification loop (reads findings, runs agent)
- `src/pipeline/stages/autofix-prompts.ts` — rectification prompt builder (enhance with reasoning + history)
- `src/pipeline/stages/completion.ts` — story completion (destroy session)
- `src/pipeline/types.ts` — `PipelineContext` (add `reviewerSession` field)
- `src/review/orchestrator.ts` — review orchestrator (route to dialogue vs one-shot)

#### Acceptance Criteria
- `reviewStage.execute()` creates a `ReviewerSession` via `createReviewerSession()` when `config.review.dialogue.enabled` is `true` and stores it in `ctx.reviewerSession`
- On re-review (autofix retry loop), `reviewStage.execute()` calls `ctx.reviewerSession.reReview(updatedDiff)` instead of `runSemanticReview()`
- `buildDialogueAwareRectificationPrompt()` in `autofix-prompts.ts` includes `findingReasoning` from `ctx.reviewerSession` and `dialogueHistory` from `ctx.reviewerSession.history`
- When the autofix agent's output matches `/^CLARIFY:\s*(.+)$/ms`, the autofix stage calls `ctx.reviewerSession.clarify(extractedQuestion)` and appends the response to the agent's context before re-prompting
- Clarification round-trips are capped at `config.review.dialogue.maxClarificationsPerAttempt` per rectification attempt
- `completionStage.execute()` calls `ctx.reviewerSession.destroy()` after `markStoryPassed()` when `ctx.reviewerSession` exists
- When `review.dialogue.enabled` is `false`, no `ReviewerSession` is created and all stages use existing one-shot behavior
- When `ReviewerSession.review()` throws, the review stage falls back to one-shot `runSemanticReview()` and logs a warning
- When `ReviewerSession.clarify()` throws or times out, the autofix stage proceeds without clarification
- When `ReviewerSession.reReview()` throws, it falls back to a fresh one-shot review with a warning log
