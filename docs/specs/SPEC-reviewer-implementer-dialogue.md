# SPEC: Reviewer-Implementer Dialogue

## Summary

Replace the current one-way review→rectification flow with a persistent two-agent dialogue where the semantic reviewer and implementing agent can communicate across rectification rounds. The reviewer keeps its session open for the story's lifetime, and the autofix agent can relay questions/responses between sessions, enabling targeted guidance instead of blind re-attempts.

## Motivation

Today's semantic review is stateless:

1. Reviewer produces JSON findings (one-shot `complete()` call)
2. Findings are serialized as text into the autofix prompt
3. Implementer attempts blind fixes based on text dump
4. Re-review starts from scratch — no memory of previous findings or what was attempted

This causes three problems:

- **Lost context:** The reviewer knows *why* something fails an AC but this reasoning is lost in the JSON→text serialization. The implementer only sees "AC-3 not satisfied" without understanding the reviewer's reasoning.
- **False positive loops:** Reviewer flags the same false positive repeatedly because it has no memory. The implementer wastes rectification attempts on phantom issues.
- **No clarification path:** When the implementer is unsure how to satisfy a finding, it guesses. A human would ask "what specifically do you mean by X?" — the implementer cannot.

A persistent reviewer session with a dialogue channel solves all three: the reviewer remembers its own findings, the implementer can request clarification, and re-reviews build on previous context rather than starting fresh.

## Design

### Architecture

```
Story lifecycle:
  ┌─────────────────────────────────────────────────┐
  │  ReviewerSession (persistent for story)          │
  │  - Created on first semantic review              │
  │  - Receives updated diffs on re-review           │
  │  - Answers clarification questions from autofix  │
  │  - Destroyed on story pass or fail               │
  └─────────────────────────────────────────────────┘
          ▲                          │
          │ clarification request    │ findings + guidance
          │                          ▼
  ┌─────────────────────────────────────────────────┐
  │  Autofix/Rectification Agent                     │
  │  - Receives findings + reviewer reasoning        │
  │  - Can send clarification via dialogue channel   │
  │  - Makes targeted fixes with full context        │
  └─────────────────────────────────────────────────┘
```

### Core Types

```typescript
// src/review/dialogue.ts

/** A message in the reviewer-implementer dialogue */
interface DialogueMessage {
  role: "reviewer" | "implementer";
  content: string;
  timestamp: number;
}

/** Persistent reviewer session that maintains context across review rounds */
interface ReviewerSession {
  /** Story this session belongs to */
  storyId: string;
  /** Agent adapter powering the reviewer */
  agent: AgentAdapter;
  /** Session name for agent.complete() reuse */
  sessionName: string;
  /** Accumulated dialogue history */
  history: DialogueMessage[];
  /** Whether the session is still active */
  active: boolean;

  /** Initial review — produces findings with reasoning */
  review(diff: string, story: SemanticStory, config: SemanticReviewConfig): Promise<ReviewDialogueResult>;
  /** Re-review after implementer has made changes */
  reReview(updatedDiff: string): Promise<ReviewDialogueResult>;
  /** Answer a clarification question from the implementer */
  clarify(question: string): Promise<string>;
  /** Destroy the session */
  destroy(): void;
}

/** Extended review result that includes reviewer reasoning */
interface ReviewDialogueResult {
  /** Standard check result (backward compatible) */
  checkResult: ReviewCheckResult;
  /** Per-finding reasoning from the reviewer */
  findingReasoning: Map<string, string>;
  /** Summary of what changed since last review (empty on first review) */
  deltaSummary: string;
}
```

### Integration with `PipelineContext`

```typescript
// src/pipeline/types.ts — add to PipelineContext
/** Persistent reviewer session for dialogue across rectification rounds */
reviewerSession?: ReviewerSession;
```

The session is created lazily on first semantic review and stored in `ctx.reviewerSession`. The autofix stage reads it to get reviewer reasoning and optionally sends clarification requests.

### Session Lifecycle

| Event | Action |
|:------|:-------|
| First semantic review for story | Create `ReviewerSession`, call `review()` |
| Autofix stage runs | Read `ctx.reviewerSession.history` for context |
| Autofix needs clarification | Call `ctx.reviewerSession.clarify(question)` |
| Re-review after autofix | Call `ctx.reviewerSession.reReview(updatedDiff)` instead of fresh `runSemanticReview()` |
| Story passes | Call `ctx.reviewerSession.destroy()` |
| Story fails/escalates | Call `ctx.reviewerSession.destroy()` |

### Reviewer Session Implementation

The reviewer session wraps `agent.complete()` calls with a persistent `sessionName`. Since Claude Code's `-p` mode supports `--session-id`, consecutive calls with the same session name maintain conversation context.

```typescript
// First review call:
agent.complete(buildInitialReviewPrompt(diff, story, config), {
  sessionName: `nax-reviewer-${storyId}`,
  workdir,
});

// Re-review call (same session — agent has context):
agent.complete(buildReReviewPrompt(updatedDiff), {
  sessionName: `nax-reviewer-${storyId}`,
  workdir,
});

// Clarification call (same session):
agent.complete(buildClarificationPrompt(question), {
  sessionName: `nax-reviewer-${storyId}`,
  workdir,
});
```

### Autofix Prompt Enhancement

The autofix prompt currently receives serialized findings text. With dialogue, it receives:

1. **Findings with reasoning** — each finding includes the reviewer's explanation of *why* it's a problem
2. **Dialogue history** — if previous rounds had clarifications, the autofix agent sees the full exchange
3. **Clarification option** — the autofix prompt tells the agent it can ask questions by outputting a `CLARIFY:` block

```typescript
// autofix-prompts.ts — enhanced prompt structure
function buildDialogueAwareRectificationPrompt(
  failedChecks: ReviewCheckResult[],
  findingReasoning: Map<string, string>,
  dialogueHistory: DialogueMessage[],
  story: SemanticStory,
): string;
```

### Clarification Protocol

The autofix agent can request clarification by including a structured block in its output:

```
CLARIFY: For AC-3, the reviewer says "missing error handling for network timeout" 
but the function already has a try/catch at line 42. Is this sufficient or does it 
need a specific timeout check?
```

The autofix stage detects this pattern, calls `reviewerSession.clarify(question)`, appends the answer to context, and re-sends to the implementer — all within the same rectification attempt.

**Limit:** Max 2 clarification round-trips per rectification attempt to prevent infinite loops.

### Backward Compatibility

- **Feature gated:** `review.dialogue.enabled` (default: `false`). When disabled, existing one-shot behavior is unchanged.
- **Debate compatibility:** When `debate.stages.review.enabled` is true AND `review.dialogue.enabled` is true, dialogue takes precedence (debate is a multi-reviewer pattern; dialogue is reviewer↔implementer pattern — they serve different purposes).
- **Non-session agents:** If the agent adapter doesn't support session persistence (no `--session-id` equivalent), falls back to stateless mode with history injected as prompt context.

### Config Schema

```typescript
// config/schema-types.ts
interface ReviewDialogueConfig {
  /** Enable persistent reviewer session with implementer dialogue */
  enabled: boolean;
  /** Max clarification round-trips per rectification attempt (default: 2) */
  maxClarificationsPerAttempt: number;
  /** Max total dialogue messages before forcing a fresh session (context budget) */
  maxDialogueMessages: number;
}

// In ReviewConfig:
interface ReviewConfig {
  // ... existing fields
  dialogue: ReviewDialogueConfig;
}
```

### Failure Handling

- **Reviewer session crash:** Fall back to stateless one-shot review. Log warning. Don't block the pipeline.
- **Clarification timeout:** Treat as "no clarification available" — implementer proceeds with best guess.
- **Context overflow:** When `maxDialogueMessages` is reached, create a fresh session with a summary of previous exchanges (compact history).
- **Clarification parse failure:** If the autofix agent's output doesn't cleanly parse the `CLARIFY:` block, skip clarification and proceed with the fix attempt.

## Stories

### US-001: ReviewerSession Type + Factory

**Dependencies:** none  
**Complexity:** simple

Create the `ReviewerSession` interface, `DialogueMessage` type, `ReviewDialogueResult` type, and a factory function `createReviewerSession()` that wraps an `AgentAdapter`.

**Acceptance Criteria:**
- `createReviewerSession(agent, storyId, workdir)` returns a `ReviewerSession` with `active: true` and empty `history`
- `ReviewerSession.review()` calls `agent.complete()` with `sessionName: "nax-reviewer-<storyId>"` and returns a `ReviewDialogueResult` containing parsed findings and reasoning
- `ReviewerSession.destroy()` sets `active: false` and clears history
- When `review()` is called on a destroyed session, it throws `ReviewerSessionDestroyed` error
- `DialogueMessage` records include `role`, `content`, and `timestamp` fields
- Each `review()` and `clarify()` call appends messages to `history` array

### US-002: Re-review and Clarification Methods

**Dependencies:** US-001  
**Complexity:** medium

Implement `reReview()` and `clarify()` on `ReviewerSession`. `reReview()` sends the updated diff to the same session with a prompt that references previous findings. `clarify()` sends a question and returns the reviewer's response.

**Acceptance Criteria:**
- `reReview(updatedDiff)` calls `agent.complete()` with the same `sessionName` as the initial `review()` call
- `reReview()` prompt includes "You previously found these issues: ..." referencing the last findings
- `reReview()` result includes a `deltaSummary` describing which previous findings are now resolved vs still present
- `clarify(question)` calls `agent.complete()` with the same `sessionName` and returns the raw response text
- `clarify()` appends both the question (role: "implementer") and answer (role: "reviewer") to `history`
- When `history` length exceeds `maxDialogueMessages`, `reReview()` creates a fresh session with a compacted summary of previous exchanges

### US-003: Pipeline Integration — Review Stage + Autofix Stage

**Dependencies:** US-002  
**Complexity:** medium

Wire `ReviewerSession` into the pipeline. The review stage creates the session on first run and stores it in `ctx.reviewerSession`. The autofix stage reads dialogue context from the session and optionally sends clarification requests.

**Acceptance Criteria:**
- `reviewStage.execute()` creates a `ReviewerSession` when `review.dialogue.enabled` is true and stores it in `ctx.reviewerSession`
- On re-review (after autofix retry), `reviewStage.execute()` calls `ctx.reviewerSession.reReview()` instead of `runSemanticReview()`
- `autofixStage.execute()` includes `findingReasoning` from `ctx.reviewerSession` in the rectification prompt
- When the autofix agent outputs a `CLARIFY:` block, the stage calls `ctx.reviewerSession.clarify()` and re-sends the response to the agent
- Clarification round-trips are capped at `maxClarificationsPerAttempt` (default: 2) per rectification attempt
- `ctx.reviewerSession.destroy()` is called in the completion stage when the story passes or fails
- When `review.dialogue.enabled` is false, the existing one-shot behavior is unchanged (no `ReviewerSession` created)

### US-004: Config Schema + Defaults

**Dependencies:** none  
**Complexity:** simple

Add `ReviewDialogueConfig` to the config schema with `enabled`, `maxClarificationsPerAttempt`, and `maxDialogueMessages` fields.

**Acceptance Criteria:**
- `ReviewDialogueConfig` schema has `enabled` (boolean, default `false`), `maxClarificationsPerAttempt` (number, default `2`), `maxDialogueMessages` (number, default `20`)
- `ReviewConfig` includes a `dialogue` field of type `ReviewDialogueConfig`
- `DEFAULT_CONFIG.review.dialogue.enabled` is `false`
- Config diff shows `dialogue` section when user overrides any dialogue field
- Schema validation rejects `maxClarificationsPerAttempt` values < 0 or > 10
- Schema validation rejects `maxDialogueMessages` values < 5 or > 100

### US-005: Fallback + Session Cleanup

**Dependencies:** US-003  
**Complexity:** simple

Handle edge cases: reviewer session crash, non-session agents, and session cleanup on story completion/escalation.

**Acceptance Criteria:**
- When `ReviewerSession.review()` throws, the review stage falls back to one-shot `runSemanticReview()` and logs a warning
- When `ReviewerSession.clarify()` throws or times out, the autofix stage proceeds without clarification (no error propagation)
- When `ReviewerSession.reReview()` throws, it falls back to a fresh one-shot review with a warning log
- Story completion (pass, fail, or escalate) calls `destroy()` on `ctx.reviewerSession` if it exists
- When `ctx.reviewerSession` is destroyed mid-pipeline (crash recovery), subsequent stage accesses fall back to stateless mode
