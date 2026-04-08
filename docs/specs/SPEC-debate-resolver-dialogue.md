# SPEC: Debate Resolver Dialogue Integration

## Summary

Wire **all** debate resolver types (`majority`, `synthesis`, `custom`) to use `ReviewerSession` when both `debate.stages.review.enabled` and `review.dialogue.enabled` are true. Every resolver gains tool access, persistent cross-round context, and the clarification channel to the autofix implementer. Individual debaters remain isolated.

The resolver type determines the **prompt strategy** inside `resolveDebate()`, not the calling mechanism — all three types go through `reviewerSession.resolveDebate()` using `agent.run()`.

This is Phase 2 of the reviewer-implementer dialogue system. Phase 1 shipped the `ReviewerSession` for the non-debate path and the session continuity foundation.

## Prerequisites

**`SPEC-reviewer-implementer-dialogue.md` must ship first.** This spec depends on:
- `ReviewerSession` with `review()`, `reReview()`, `clarify()`, `getVerdict()`, `destroy()` (dialogue US-001, US-002)
- Pipeline integration: `ctx.reviewerSession` on `PipelineContext`, autofix `CLARIFY:` relay, completion `destroy()` (dialogue US-003)
- `resolveOutcome()` accepting `workdir` and `featureName` (continuity US-004)

## Motivation

Three problems with the current debate + review interaction:

1. **All resolvers run blind.** `synthesis` and `custom` resolvers call `adapter.complete()` — a one-shot call with no tool access. The resolver cannot read files, grep for usage, or verify whether debater claims are accurate. `majority` is even worse — pure vote counting with no reasoning, no findings, and no ability to verify anything. All three types produce verdicts based on unverified text.

2. **Debate verdict is discarded.** `semantic.ts:409-423` re-derives its own majority vote from raw proposals, bypassing the resolver's verdict entirely (Issue 3e). The resolver runs, produces a verdict, and that verdict is ignored. For `majority`, this means the resolver's vote is counted twice — once by `majorityResolver()` and again by `semantic.ts`. For `synthesis`/`custom`, the synthesized output is thrown away entirely.

3. **No continuity across review rounds.** When autofix triggers a re-review, the entire debate runs from scratch — N debaters re-run, the resolver re-processes, with no memory of previous findings or what was already verified. A `ReviewerSession` would maintain context: "last round I found X, the implementer fixed Y, let me check Z is still valid."

4. **No clarification path in debate mode.** The autofix `CLARIFY:` protocol only works when `ctx.reviewerSession` is set. In debate mode, no `ReviewerSession` is created, so the implementer cannot ask for clarification on findings — it guesses and wastes rectification attempts.

5. **Majority produces no structured findings.** `majority` returns a bare `"passed"` or `"failed"` — no findings, no reasoning. `semantic.ts` has to re-parse each debater's raw output to extract findings manually. A `ReviewerSession` would receive the debater proposals plus the vote result, then produce tool-verified structured findings that downstream stages can act on.

## Design

### Architecture

```
Review Stage (debate + dialogue enabled)
  │
  ├─ Create ReviewerSession (persistent, tool-enabled)
  │
  ├─ DebateSession.run(prompt)
  │   ├─ Debater 1 ──┐
  │   ├─ Debater 2 ──┤  (parallel, isolated, own sessions)
  │   ├─ Debater N ──┘
  │   │
  │   └─ Resolver: reviewerSession.resolveDebate(proposals, critiques, diff)
  │       │  ← tool access: READ files, GREP for usage
  │       │  ← verifies debater claims before ruling
  │       └─ Returns ReviewDialogueResult (verdict + findings + reasoning)
  │
  ├─ ctx.reviewerSession = session  (stored for autofix)
  │
  │  [autofix loop if review failed]
  │   ├─ Implementer attempts fix
  │   ├─ CLARIFY: block → reviewerSession.clarify(question)
  │   └─ Re-review: reviewerSession.reReviewDebate(newProposals, critiques, updatedDiff)
  │       ← same session, references previous findings
  │
  └─ Completion: reviewerSession.destroy()
```

### Key Insight

The resolver IS the reviewer. In non-debate mode, the `ReviewerSession` reviews the diff directly. In debate mode, the `ReviewerSession` receives N debater proposals as additional context — it reviews the diff through the lens of diverse independent opinions, then produces its own tool-verified verdict.

Individual debaters remain isolated and stateless. Only the resolver — the single authority on pass/fail — gains session continuity.

### Existing Types to Extend

- `ReviewerSession` in `src/review/dialogue.ts` — add `resolveDebate()` and `reReviewDebate()` methods
- `DebateSessionOptions` in `src/debate/session-helpers.ts` — add optional `reviewerSession` field
- `resolveOutcome()` in `src/debate/session-helpers.ts` — accept optional `ReviewerSession`, use it for all resolver types
- `ResolveOutcome` in `src/debate/session-helpers.ts` — add optional `output` and `findings` fields for resolver output passthrough

### Integration Points

- `src/review/dialogue.ts` — add `resolveDebate()` and `reReviewDebate()` methods to `ReviewerSession`
- `src/debate/session-helpers.ts:177-250` — `resolveOutcome()`: when `reviewerSession` is provided, call `reviewerSession.resolveDebate()` for all resolver types (majority runs vote count first, then passes vote result to `resolveDebate()` as context)
- `src/debate/session.ts:34-41` — `DebateSession` constructor: accept and store optional `reviewerSession`
- `src/debate/session-stateful.ts` — forward `reviewerSession` to `resolveOutcome()`
- `src/debate/session-hybrid.ts` — forward `reviewerSession` to `resolveOutcome()`
- `src/debate/session-one-shot.ts` — forward `reviewerSession` to `resolveOutcome()`
- `src/review/semantic.ts:394-481` — debate branch: when `reviewerSession` is provided via the new `resolverSession` option, pass it to `DebateSession`; use the resolver's `ReviewDialogueResult` as the authoritative verdict instead of re-deriving majority from proposals
- `src/pipeline/stages/review.ts:28-137` — remove G4 guard; when both debate and dialogue are enabled, create `ReviewerSession`, pass to `runSemanticReview()` as a new option, store on `ctx.reviewerSession`
- `src/pipeline/stages/autofix.ts` — unchanged; `CLARIFY:` relay already reads `ctx.reviewerSession`

### Existing Patterns to Follow

- `src/review/dialogue.ts:257-297` — `ReviewerSession.review()` call to `agent.run()` (replicate for `resolveDebate()`)
- `src/review/dialogue.ts:299-355` — `ReviewerSession.reReview()` referencing previous findings (replicate for `reReviewDebate()`)
- `src/debate/resolvers.ts:65-72` — `synthesisResolver()` building synthesis prompt from proposals + critiques (replicate prompt structure in `resolveDebate()`)

### New Method on ReviewerSession

```typescript
// src/review/dialogue.ts

/** Context passed to resolveDebate() — varies by resolver type */
interface DebateResolverContext {
  resolverType: "majority-fail-closed" | "majority-fail-open" | "synthesis" | "custom";
  /** For majority: the raw vote tally (computed before resolveDebate is called) */
  majorityVote?: { passed: boolean; passCount: number; failCount: number };
}

interface ReviewerSession {
  // ... existing methods ...

  /**
   * Resolve a debate by reviewing N debater proposals and producing a
   * tool-verified verdict. The resolver type determines prompt strategy:
   * - majority: vote tally is included; reviewer verifies failing findings
   * - synthesis: reviewer synthesizes proposals into a single verdict
   * - custom: reviewer acts as independent judge
   *
   * All types use agent.run() with tool access (READ, GREP) to verify claims.
   *
   * @param proposals      - Array of { debater, output } from each debater
   * @param critiques       - Array of critique/rebuttal outputs (may be empty)
   * @param diff            - The git diff being reviewed (same diff debaters saw)
   * @param story           - Story metadata with acceptance criteria
   * @param semanticConfig  - Semantic review config (model tier, timeout, etc.)
   * @param resolverContext - Resolver-type-specific context (vote tally for majority)
   */
  resolveDebate(
    proposals: Array<{ debater: string; output: string }>,
    critiques: string[],
    diff: string,
    story: SemanticStory,
    semanticConfig: SemanticReviewConfig,
    resolverContext: DebateResolverContext,
  ): Promise<ReviewDialogueResult>;

  /**
   * Re-resolve a debate after implementer changes.
   * Same session — references previous findings and debater proposals.
   *
   * @param proposals       - Updated debater proposals (re-run against new diff)
   * @param critiques        - Updated critiques
   * @param updatedDiff      - The new git diff after implementer changes
   * @param resolverContext  - Resolver-type-specific context
   */
  reReviewDebate(
    proposals: Array<{ debater: string; output: string }>,
    critiques: string[],
    updatedDiff: string,
    resolverContext: DebateResolverContext,
  ): Promise<ReviewDialogueResult>;
}
```

### Resolver Prompt Strategy by Type

`resolveDebate()` receives the `resolverType` and builds a type-specific prompt. All three share the same base structure (acceptance criteria, labeled proposals, critiques, diff, tool-verification instructions) but differ in their framing:

| Resolver type | Internal function | Prompt framing | Vote context |
|:---|:---|:---|:---|
| **majority-fail-closed** | `majorityResolver()` (pre-vote) → `resolveDebate()` | "N debaters voted: X passed, Y failed. Unparseable proposals counted as fail. Verify the failing findings with tools." | Vote tally included in prompt |
| **majority-fail-open** | `majorityResolver()` (pre-vote) → `resolveDebate()` | "N debaters voted: X passed, Y failed. Unparseable proposals counted as pass. Verify the failing findings with tools." | Vote tally included in prompt |
| **synthesis** | `resolveDebate()` directly | "Synthesize N debater proposals into a single verdict. Verify claims with tools before ruling." | No pre-vote |
| **custom** | `resolveDebate()` directly | "You are the judge (`judgeResolver` style). Evaluate these proposals independently. Verify claims with tools." | No pre-vote |

All three output the same JSON: `{ passed, findings, findingReasoning }`

For majority, `resolveDebate()`:
1. Calls `majorityResolver(proposalOutputs)` to get the raw vote
2. Includes the vote result in the prompt: "The majority vote is FAILED (1 pass, 2 fail)"
3. Instructs the reviewer to verify the failing findings — tool access lets it confirm or override the vote
4. The reviewer's `passed` field in the JSON response is the **authoritative verdict** (may differ from the raw vote if findings are non-blocking or unverifiable)

This replaces `buildSynthesisPrompt()` / `buildJudgePrompt()` and eliminates the manual majority re-derivation in `semantic.ts`.

### ResolveOutcome Extension

```typescript
// src/debate/session-helpers.ts

export interface ResolveOutcome {
  outcome: "passed" | "failed" | "skipped";
  resolverCostUsd: number;
  /** Resolver output text — populated when synthesis/custom resolver produces output */
  output?: string;
  /** Structured findings from ReviewerSession resolver (debate+dialogue mode only) */
  dialogueResult?: import("../review/dialogue").ReviewDialogueResult;
}
```

### Backward Compatibility

- **All resolver types with dialogue disabled:** When `review.dialogue.enabled` is false, no `ReviewerSession` is created. All resolver types use their existing stateless paths (`majorityResolver()`, `synthesisResolver()`, `judgeResolver()`). No behavioral change.

- **Majority with dialogue enabled:** Majority's behavior changes — it goes from pure vote counting to vote counting + tool-verified findings via `ReviewerSession`. The raw vote is still computed first (same `majorityResolver()` function), but the vote result is then passed to `resolveDebate()` as context. The reviewer's tool-verified verdict becomes authoritative. This is an intentional upgrade, not a regression — the raw vote is preserved in the prompt as context.

- **Dialogue without debate:** When `review.dialogue.enabled` is true but `debate.stages.review.enabled` is false, `ReviewerSession.review()` is used directly (non-debate path). No behavioral change from Phase 1.

- **`DebateResult` shape:** Unchanged. The resolver's output flows through `ResolveOutcome.dialogueResult`, which the `semantic.ts` debate branch reads to produce the same `ReviewCheckResult` — callers of `runSemanticReview()` see no shape change.

- **Autofix `CLARIFY:` relay:** Works unchanged. `ctx.reviewerSession` is set in both debate+dialogue and dialogue-only modes. The autofix stage doesn't care how the session was created.

### Failure Handling

- **`resolveDebate()` throws:** Fall back to stateless resolver (`majorityResolver()`, `synthesisResolver()`, or `judgeResolver()`). Log at `warn` level: `"ReviewerSession.resolveDebate() failed — falling back to stateless resolver"`. The debate still produces a verdict. For majority, the fallback is the raw vote with no structured findings (current behavior).
- **`reReviewDebate()` throws:** Fall back to full re-debate (run debaters again, resolve with stateless resolver). Log at `warn` level.
- **`ReviewerSession` already destroyed:** If `active` is `false` when `resolveDebate()` is called, throw `REVIEWER_SESSION_DESTROYED` — caught by the caller's fallback logic.
- **Agent lacks `run()` support:** `resolveDebate()` uses `agent.run()`. If the adapter doesn't support persistent sessions, `run()` degrades to a single-turn call — tool access still works, just no cross-round memory. Acceptable degradation.

### Config

No new config fields. The combination of existing flags determines behavior.

#### Resolver Type Reference

The codebase defines 4 resolver types (`ResolverType` in `src/debate/types.ts`):

| Config value | Internal resolver | LLM call (current) | LLM call (after spec, dialogue enabled) |
|:---|:---|:---|:---|
| `majority-fail-closed` | `majorityResolver()` — vote count, unparseable = fail | No | Yes — `reviewerSession.resolveDebate()` with vote tally as context |
| `majority-fail-open` | `majorityResolver()` — vote count, unparseable = pass | No | Yes — same as above |
| `synthesis` | `synthesisResolver()` — `adapter.complete()` | Yes (one-shot, blind) | Yes — `reviewerSession.resolveDebate()` with persistent session + tools |
| `custom` | `judgeResolver()` — `adapter.complete()` with judge prompt | Yes (one-shot, blind) | Yes — `reviewerSession.resolveDebate()` with persistent session + tools |

#### Behavior Matrix — Review Stage (Semantic Review)

The review stage behavior depends on three flags: `debate.enabled` + `debate.stages.review.enabled` (combined as "debate"), `review.dialogue.enabled`, and `sessionMode`.

**Current state** (before this spec):

| debate | dialogue | sessionMode | Reviewer | Resolver | Tools | Clarify | Re-review ctx |
|:---:|:---:|:---:|:---|:---|:---:|:---:|:---:|
| off | off | — | `agent.run()` resumes implementer session | N/A (single reviewer) | No | No | No |
| off | on | — | `ReviewerSession.review()` | N/A (single reviewer) | Yes | Yes | Yes |
| on | off | one-shot | N debaters via `agent.complete()` | Stateless (`majorityResolver` / `synthesisResolver` / `judgeResolver`) | No | No | No |
| on | off | stateful | N debaters via `agent.run()` + rebuttal loop | Stateless (resolver resumes implementer session via continuity US-004) | No | No | No |
| on | on | one-shot | **G4 blocks** — dialogue disabled, falls back to debate-only | Stateless | No | No | No |
| on | on | stateful | **G4 blocks** — dialogue disabled, falls back to debate-only | Stateless | No | No | No |

**After this spec:**

| debate | dialogue | sessionMode | Reviewer | Resolver | Tools | Clarify | Re-review ctx |
|:---:|:---:|:---:|:---|:---|:---:|:---:|:---:|
| off | off | — | `agent.run()` resumes implementer session | N/A (single reviewer) | No | No | No |
| off | on | — | `ReviewerSession.review()` | N/A (single reviewer) | Yes | Yes | Yes |
| on | off | one-shot | N debaters via `agent.complete()` | Stateless (`majorityResolver` / `synthesisResolver` / `judgeResolver`) | No | No | No |
| on | off | stateful | N debaters via `agent.run()` + rebuttal loop | Stateless (resolver resumes implementer session) | No | No | No |
| on | **on** | one-shot | N debaters via `agent.complete()` | **`reviewerSession.resolveDebate()`** — all resolver types | **Yes** | **Yes** | **Yes** |
| on | **on** | stateful | N debaters via `agent.run()` + rebuttal loop | **`reviewerSession.resolveDebate()`** — all resolver types | **Yes** | **Yes** | **Yes** |

**What changes:** The last two rows. G4 guard is removed. When both debate and dialogue are enabled, the `ReviewerSession` is created and the resolver uses `resolveDebate()` instead of stateless resolvers. Debaters remain isolated and unchanged.

#### Behavior Matrix — Plan Stage

Plan stage uses `adapter.plan()` for proposals (not `adapter.run()` or `adapter.complete()`). `review.dialogue` does not apply to plan — it is a review-only feature. The `ReviewerSession` is not created for plan stage debates.

**Current state AND after this spec** (no changes — this spec only affects review):

| debate | sessionMode | mode | Proposer | Rebuttal | Resolver |
|:---:|:---:|:---:|:---|:---|:---|
| off | — | — | Single `adapter.plan()` | None | N/A |
| on | one-shot | panel | N `adapter.plan()` (parallel) | None | Stateless resolver |
| on | stateful | panel | N `adapter.plan()` (parallel) | None | Stateless resolver |
| on | stateful | hybrid | N `adapter.plan()` (parallel) | Sequential via `adapter.run()` (`runRebuttalLoop`) | Stateless resolver |
| on | one-shot | hybrid | N `adapter.plan()` (parallel) | **Skipped** — warns "hybrid requires stateful" | Stateless resolver |

## Stories

### US-001: Add `resolveDebate()` and `reReviewDebate()` to ReviewerSession

**Dependencies:** none (builds on existing `ReviewerSession`)
**Complexity:** medium

Add two new methods to `ReviewerSession` that accept debate proposals, critiques, and the diff, then use `agent.run()` with tool access to produce a verified verdict.

#### Context Files
- `src/review/dialogue.ts` — `ReviewerSession` implementation; add `resolveDebate()` and `reReviewDebate()` following the `review()` and `reReview()` patterns
- `src/review/dialogue.ts:76-89` — `buildReviewPrompt()` (adapt for debate context with proposals + critiques)
- `src/review/dialogue.ts:91-106` — `buildReReviewPrompt()` (adapt for debate re-review)
- `src/debate/prompts.ts` — `buildSynthesisPrompt()`, `buildJudgePrompt()` (reference for proposal formatting)
- `src/review/semantic.ts:127-184` — semantic review prompt structure (AC verification instructions to include)

#### Acceptance Criteria
- `resolveDebate(proposals, critiques, diff, story, semanticConfig, resolverContext)` calls `agent.run()` with a prompt that includes: acceptance criteria, labeled debater proposals, critiques (if any), the git diff, and instructions to verify claims using tools (READ, GREP)
- The prompt framing varies by `resolverContext.resolverType`:
  - `"majority-fail-closed"` / `"majority-fail-open"`: includes vote tally from `resolverContext.majorityVote` ("N debaters voted: X passed, Y failed"); instructs the reviewer to verify failing findings and produce an authoritative verdict
  - `"synthesis"`: instructs the reviewer to synthesize all proposals into a single coherent verdict
  - `"custom"`: instructs the reviewer to act as an independent judge (`judgeResolver` prompt style) evaluating proposals
- `resolveDebate()` parses the JSON response into `ReviewDialogueResult` with `checkResult`, `findingReasoning`, and `cost`
- `resolveDebate()` appends the prompt (role: `"implementer"`) and response (role: `"reviewer"`) to `history`
- `resolveDebate()` stores the result as `lastCheckResult` so `getVerdict()` and `reReviewDebate()` work correctly
- `reReviewDebate(proposals, critiques, updatedDiff, resolverContext)` sends a follow-up prompt to the same session referencing previous findings
- `reReviewDebate()` returns a `ReviewDialogueResult` with `deltaSummary`
- `reReviewDebate()` triggers history compaction when `history.length` exceeds `maxDialogueMessages` (same logic as `reReview()`)
- Both methods throw `REVIEWER_SESSION_DESTROYED` when `active` is `false`
- `reReviewDebate()` throws `NO_REVIEW_RESULT` when called before any `resolveDebate()` or `review()`
- `clarify()` and `getVerdict()` work correctly after `resolveDebate()` (they read from `lastCheckResult` which `resolveDebate()` sets)

### US-002: Extend `resolveOutcome()` to Use ReviewerSession

**Dependencies:** US-001
**Complexity:** medium

When a `ReviewerSession` is passed to `resolveOutcome()`, all resolver types call `reviewerSession.resolveDebate()` to produce a tool-verified verdict. The resolver type is passed through to `resolveDebate()` which uses it to select the prompt strategy. Falls back to stateless resolvers on error.

#### Context Files
- `src/debate/session-helpers.ts:177-250` — `resolveOutcome()` function to extend
- `src/debate/session-helpers.ts:41-44` — `ResolveOutcome` interface to extend with `output` and `dialogueResult`
- `src/debate/session-helpers.ts:48-56` — `DebateSessionOptions` to add `reviewerSession`
- `src/debate/resolvers.ts:46-59` — `majorityResolver()` (still called pre-vote for majority type, becomes fallback)
- `src/debate/resolvers.ts:65-72` — `synthesisResolver()` (existing stateless path, becomes fallback)
- `src/debate/resolvers.ts:79-98` — `judgeResolver()` (existing stateless path, becomes fallback)

#### Acceptance Criteria
- `resolveOutcome()` signature adds optional `reviewerSession?: ReviewerSession` parameter
- `ResolveOutcome` adds optional `output?: string` and `dialogueResult?: ReviewDialogueResult` fields
- When `reviewerSession` is provided and resolver type is `majority-fail-closed` or `majority-fail-open`:
  - Calls `majorityResolver(proposalOutputs, failOpen)` first to get the raw vote tally
  - Passes the vote result to `reviewerSession.resolveDebate()` with `resolverType` matching the config (`"majority-fail-closed"` or `"majority-fail-open"`) and `majorityVote: { passed, failCount, passCount }` in the resolver context
  - Uses `dialogueResult.checkResult.success` to determine `outcome` (the reviewer's tool-verified verdict, which may differ from the raw vote)
  - Sets `resolverCostUsd` from `dialogueResult.cost`
  - Sets `dialogueResult` on the return value
- When `reviewerSession` is provided and resolver type is `synthesis`:
  - Calls `reviewerSession.resolveDebate(proposals, critiques, diff, story, semanticConfig)` with `resolverType: "synthesis"` (proposals and diff must be threaded through — see US-004)
  - Uses `dialogueResult.checkResult.success` to determine `outcome` ("passed" or "failed")
  - Sets `resolverCostUsd` from `dialogueResult.cost`
  - Sets `dialogueResult` on the return value
- When `reviewerSession` is provided and resolver type is `custom`:
  - Same behavior as `synthesis` above, with `resolverType: "custom"`
- When `reviewerSession.resolveDebate()` throws:
  - Logs at `warn` level: `"ReviewerSession.resolveDebate() failed — falling back to stateless resolver"`
  - Falls back to `majorityResolver()`, `synthesisResolver()`, or `judgeResolver()` as appropriate
  - For majority fallback: returns the raw vote result with no structured findings (current behavior)
- `DebateSessionOptions` adds optional `reviewerSession?: ReviewerSession`
- `DebateSession` constructor stores `reviewerSession` and forwards it through to `resolveOutcome()` in all session modes (stateful, hybrid, one-shot)

### US-003: Wire Debate + Dialogue in Review Stage

**Dependencies:** US-002
**Complexity:** medium

Remove the G4 mutual exclusion guard. When both debate and dialogue are enabled for the review stage, create a `ReviewerSession`, pass it to `DebateSession`, and use the resolver's `ReviewDialogueResult` as the authoritative verdict.

#### Context Files
- `src/pipeline/stages/review.ts:28-30` — G4 guard to remove (`reviewDebateEnabled` check that disables dialogue)
- `src/review/semantic.ts:392-481` — debate branch in `runSemanticReview()`; extend to accept and use `ReviewerSession`
- `src/review/semantic.ts:127-184` — `buildPrompt()` (prompt that becomes the diff context for debaters)
- `src/pipeline/stages/review.ts:77-136` — dialogue session creation (merge with debate path)

#### Acceptance Criteria
- The G4 guard in `review.ts` (`const reviewDebateEnabled = ...`) is removed — `dialogueEnabled` is determined solely by `ctx.config.review?.dialogue?.enabled`
- When both `debate.stages.review.enabled` and `review.dialogue.enabled` are true:
  - `review.ts` creates a `ReviewerSession` via `createReviewerSession()`
  - `review.ts` passes the `ReviewerSession` to `runSemanticReview()` as a new `resolverSession` option
  - `runSemanticReview()` passes the `ReviewerSession` to `DebateSession` constructor via the `reviewerSession` option
  - `DebateSession.run()` forwards it to `resolveOutcome()`, which calls `reviewerSession.resolveDebate()`
  - The resolver's `ReviewDialogueResult` is used to produce the `ReviewCheckResult` — the `semantic.ts` debate branch no longer re-derives majority from raw proposals
  - `ctx.reviewerSession` is set — autofix `CLARIFY:` relay works
- When only `debate.stages.review.enabled` is true (no dialogue):
  - No `ReviewerSession` is created
  - `DebateSession` is created without `reviewerSession`
  - The stateless resolver path (`adapter.complete()`) is used — no behavioral change
- When `review.ts` has a `ctx.reviewerSession` from a previous round (re-review after autofix):
  - The debate branch in `semantic.ts` passes the existing `ReviewerSession` to `DebateSession`
  - `resolveOutcome()` calls `reviewerSession.reReviewDebate()` (not `resolveDebate()`) — same session, references previous findings
  - Debaters re-run with the updated diff (they are stateless and always start fresh)
- The `semantic.ts` debate branch produces `ReviewCheckResult` from the resolver's `dialogueResult`:
  - `success` = `dialogueResult.checkResult.success`
  - `findings` = `dialogueResult.checkResult.findings` (already verified by tool-enabled resolver)
  - No manual majority re-derivation from proposals — the resolver's verdict is authoritative
- When the resolver falls back to stateless (e.g., `resolveDebate()` threw):
  - The `semantic.ts` debate branch falls back to the existing majority re-derivation logic (current behavior)
  - `ctx.reviewerSession` is still set — clarification channel is available even if the resolver fell back

### US-004: Thread Proposals and Diff Through resolveOutcome()

**Dependencies:** US-002
**Complexity:** simple

`resolveOutcome()` currently receives `proposalOutputs` (strings) and `critiqueOutputs` (strings). For `resolveDebate()`, it also needs the raw `diff`, `story`, `semanticConfig`, and labeled proposals (with debater agent names). Thread these through as an optional context object.

#### Context Files
- `src/debate/session-helpers.ts:177-250` — `resolveOutcome()` to extend
- `src/debate/session-stateful.ts:269-278` — `resolveOutcome()` call site
- `src/debate/session-hybrid.ts:234-241` — `resolveOutcome()` call site
- `src/debate/session-one-shot.ts:207-214` — `resolveOutcome()` call site
- `src/debate/session-plan.ts:191-198` — `resolveOutcome()` call site
- `src/review/semantic.ts:397-406` — where `DebateSession` is created with story/diff context

#### Acceptance Criteria
- `resolveOutcome()` accepts an optional `resolverContext` parameter:
  ```typescript
  interface ResolverContext {
    diff: string;
    story: { id: string; title: string; acceptanceCriteria: string[] };
    semanticConfig: SemanticReviewConfig;
    labeledProposals: Array<{ debater: string; output: string }>;
    resolverType: "majority-fail-closed" | "majority-fail-open" | "synthesis" | "custom";
    isReReview?: boolean;
  }
  ```
- `resolverContext` is only populated when called from the review debate path (not plan or other stages)
- When `reviewerSession` is provided but `resolverContext` is undefined, log at `warn` level and fall back to stateless resolver (cannot call `resolveDebate()` without diff/story)
- `semantic.ts` debate branch passes `resolverContext` when creating and running the `DebateSession`:
  - `diff` from the diff already computed for the debaters
  - `story` from the `SemanticStory` already available
  - `semanticConfig` from the existing config
  - `labeledProposals` from `debateResult.proposals` mapped to `{ debater: p.debater.agent, output: p.output }`
  - `isReReview` = `true` when `ctx.reviewerSession` already existed (re-review path)
- Existing call sites in `session-stateful.ts`, `session-hybrid.ts`, `session-one-shot.ts`, and `session-plan.ts` pass `undefined` for `resolverContext` — no behavioral change

## Dependency Graph

```
US-001 (resolveDebate on ReviewerSession)
  │
  ├──→ US-002 (resolveOutcome uses ReviewerSession)
  │       │
  │       ├──→ US-003 (pipeline wiring, remove G4)
  │       │
  │       └──→ US-004 (thread diff/story/proposals through)
  │               │
  │               └──→ US-003 (needs resolverContext to pass diff)
```

US-003 depends on both US-002 and US-004.
US-001 is independently implementable.
US-004 is independently implementable (adds the parameter, call sites pass `undefined`).
