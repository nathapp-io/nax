# SPEC: Session Manager — Adapter Integration Design

> **Status:** Draft. Companion to [SPEC-context-engine-v2-amendments.md](./SPEC-context-engine-v2-amendments.md) Amendment D. Details how `SessionManager` integrates with the existing `AgentAdapter` interface and ACP adapter implementation.

## Current Architecture

### Who owns what today

```
                      SESSION LIFECYCLE (all in adapter)
                      =================================

Pipeline stage (execution.ts / session-runner.ts / semantic.ts / ...)
  |
  |  passes: { sessionRole, keepSessionOpen, acpSessionName,
  |            featureName, storyId }
  |
  v
AgentAdapter.run(AgentRunOptions)
  |
  v
AcpAgentAdapter._runWithClient()
  |
  |  1. RESOLVE SESSION NAME
  |     explicit acpSessionName
  |       > sidecar lookup (acp-sessions.json)
  |         > derived via buildSessionName()
  |
  |  2. CRASH GUARD
  |     sidecar status == "in-flight"?
  |       yes → discard entry, start fresh
  |       no  → resume existing
  |
  |  3. MARK IN-FLIGHT
  |     write sidecar: { sessionName, agentName, status: "in-flight" }
  |
  |  4. ENSURE SESSION
  |     ensureAcpSession(client, sessionName, agentName, permissionMode)
  |       try loadSession() (resume)
  |       fallback createSession()
  |
  |  5. MULTI-TURN LOOP
  |     send prompt, receive response, handle interactions
  |
  |  6. CLEANUP (in finally block)
  |     success + !keepSessionOpen → close + clear sidecar
  |     session broken (stopReason=error) → close + clear sidecar
  |     failure → promote sidecar: "in-flight" → "open" (for retry)
  |     success + keepSessionOpen → promote sidecar to "open"
  |
  v
AgentResult
```

### Problems with this design

| # | Problem | Example |
|:--|:--------|:--------|
| 1 | Adapter owns lifecycle decisions (when to close, when to keep open) | `keepSessionOpen` is a caller hint, but the adapter makes the final call in its `finally` block |
| 2 | Session state lives in adapter-specific sidecar files | `.nax/features/<f>/acp-sessions.json` — a different adapter (Codex, Gemini) would need its own sidecar format |
| 3 | No stable session ID exposed to the pipeline | Pipeline stages reconstruct session names from `(workdir, feature, storyId, role)` — no `ctx.sessionId` |
| 4 | No scratch directory — session observations live only in ACP memory | Context engine v2's `SessionScratchProvider` can't read what doesn't exist |
| 5 | Crash detection uses file mtime, not state machine | Sidecar mtime >2h = orphan. A crash within 2h is invisible |
| 6 | Availability fallback impossible — session is tied to one adapter | Switching from Claude to Codex means starting from scratch |

---

## Target Architecture

### Separation of concerns

```
SESSION MANAGER                        AGENT ADAPTER
(src/session/manager.ts)               (src/agents/acp/adapter.ts)
================================       ================================
Owns:                                  Owns:
  - Stable session ID (sess-<uuid>)      - Physical session (acpx process)
  - Lifecycle state machine              - Protocol-specific operations
    (created/active/suspended/             (loadSession, createSession,
     failed/handed-off/completed/           sendPrompt, closeSession)
     orphaned)                           - Multi-turn interaction loop
  - Scratch directory creation           - Token usage / cost tracking
  - Stage digest persistence             - Prompt audit
  - Sidecar replacement (index.json)
  - Close/resume/handoff decisions
  - Orphan detection + sweep
  - Agent-agnostic session naming

Does NOT own:                          Does NOT own:
  - Protocol-specific operations         - When to close (manager decides)
  - acpx process spawning                - When to resume (manager decides)
  - Multi-turn loop execution            - Session naming (manager provides)
  - Token/cost tracking                  - Crash detection (manager does)
                                         - Sidecar files (manager does)
```

### New call flow

```
Pipeline stage
  |
  |  Stage has access to ctx.sessionManager and ctx.sessionId
  |
  v
SessionManager.create() or .resume()
  |  → creates SessionDescriptor { id: "sess-<uuid>", state: "created", ... }
  |  → creates scratch directory
  |  → writes to index.json
  |  → returns descriptor
  |
  v
AgentAdapter.run(AgentRunOptions)
  |  AgentRunOptions now carries: { session: SessionDescriptor, ... }
  |  (replaces: sessionRole, acpSessionName, keepSessionOpen, featureName, storyId)
  |
  v
AcpAgentAdapter._runWithClient()
  |
  |  1. DERIVE PROTOCOL NAME from descriptor
  |     acpName = deriveAcpName(descriptor)
  |     (deterministic, e.g. "nax-<first8-of-uuid>-<role>")
  |
  |  2. NO CRASH GUARD NEEDED
  |     manager already handles orphans via state machine
  |
  |  3. NO SIDECAR WRITE
  |     manager owns session state; adapter just calls
  |     manager.transition(id, "active") before starting
  |
  |  4. ENSURE PHYSICAL SESSION (unchanged)
  |     ensureAcpSession(client, acpName, agentName, permissionMode)
  |       try loadSession() (resume)
  |       fallback createSession()
  |
  |  5. MULTI-TURN LOOP (unchanged)
  |     send prompt, receive response, handle interactions
  |
  |  6. BIND HANDLE (new)
  |     manager.bindHandle(descriptor.id, acpName)
  |
  |  7. NO CLEANUP DECISIONS
  |     adapter returns AgentResult
  |     does NOT close the session
  |     does NOT write sidecar
  |
  v
AgentResult returned to pipeline stage
  |
  v
Pipeline stage makes lifecycle decision:
  |
  +--- success + more stages coming → manager.transition(id, "suspended")
  |
  +--- success + story done → manager.transition(id, "completed")
  |    (manager closes physical session via adapter.closeSession())
  |
  +--- failure + retries left → manager.transition(id, "failed")
  |    (session stays open for rect loop to resume)
  |
  +--- availability failure → manager.handoff(id, newAgent, reason)
  |    (manager records prior agent, new adapter creates new physical session)
  |
  +--- session broken → manager.transition(id, "failed")
       (manager closes physical session, rect loop creates new one)
```

---

## Interface Changes

### AgentRunOptions — before vs after

```typescript
// BEFORE (current)
interface AgentRunOptions {
  prompt: string;
  workdir: string;
  modelTier: ModelTier;
  modelDef: ModelDef;
  timeoutSeconds: number;
  config: NaxConfig;
  // --- session params scattered across 5 fields ---
  acpSessionName?: string;       // protocol-specific name
  featureName?: string;          // for session naming
  storyId?: string;              // for session naming
  sessionRole?: string;          // for session naming
  keepSessionOpen?: boolean;     // lifecycle hint
  // ...other fields unchanged
}

// AFTER (with session manager)
interface AgentRunOptions {
  prompt: string;
  workdir: string;
  modelTier: ModelTier;
  modelDef: ModelDef;
  timeoutSeconds: number;
  config: NaxConfig;
  // --- single session descriptor replaces 5 fields ---
  session: SessionDescriptor;     // NEW — stable ID, role, state, scratchDir
  // acpSessionName   REMOVED — adapter derives from descriptor
  // featureName      REMOVED — available via descriptor.featureId
  // storyId          REMOVED — available via descriptor.storyId
  // sessionRole      REMOVED — available via descriptor.role
  // keepSessionOpen  REMOVED — manager decides, not caller
  // ...other fields unchanged
}
```

### AgentAdapter — before vs after

```typescript
// BEFORE (current)
interface AgentAdapter {
  run(options: AgentRunOptions): Promise<AgentResult>;
  complete(prompt: string, options?: CompleteOptions): Promise<CompleteResult>;
  plan(options: PlanOptions): Promise<PlanResult>;
  decompose(options: DecomposeOptions): Promise<DecomposeResult>;
  closeSession(sessionName: string, workdir: string): Promise<void>;
  // ...
}

// AFTER (with session manager)
interface AgentAdapter {
  run(options: AgentRunOptions): Promise<AgentResult>;
  complete(prompt: string, options?: CompleteOptions): Promise<CompleteResult>;
  plan(options: PlanOptions): Promise<PlanResult>;
  decompose(options: DecomposeOptions): Promise<DecomposeResult>;

  /**
   * Close a physical agent session by its protocol-specific handle.
   * Called by SessionManager when transitioning to "completed".
   * The adapter MUST NOT call this on its own.
   */
  closePhysicalSession(handle: string, workdir: string): Promise<void>;

  /**
   * Derive a protocol-specific session name from a SessionDescriptor.
   * ACP: "nax-<first8-of-uuid>-<role>"
   * CLI: not applicable (process-based)
   * Future adapters: implement their own scheme.
   */
  deriveSessionName(descriptor: SessionDescriptor): string;

  // closeSession() DEPRECATED — replaced by closePhysicalSession()
}
```

### AgentResult — surface protocol IDs

```typescript
// BEFORE (current)
interface AgentResult {
  success: boolean;
  exitCode: number;
  output: string;
  // ... no session identifiers
}

// AFTER (with session manager)
interface AgentResult {
  success: boolean;
  exitCode: number;
  output: string;
  // ... existing fields unchanged ...

  /**
   * Protocol-specific session identifiers from the agent backend.
   * Populated by the adapter after the session runs.
   *
   * ACP: { recordId: acpxRecordId (stable), sessionId: acpxSessionId (volatile) }
   *
   * The pipeline stage passes these to sessionManager.bindHandle() so
   * they are persisted in the SessionDescriptor and index.json.
   * This enables post-run audit correlation: storyId → nax sessionId
   * → acpx recordId → prompt audit files → acpx backend logs.
   */
  protocolIds?: {
    recordId: string | null;
    sessionId: string | null;
  };
}
```

**Why on `AgentResult` instead of a callback?** The adapter creates/resumes the physical session inside `_runWithClient()`. The protocol IDs are only available after `ensureAcpSession()` returns. The cleanest way to surface them is on the result — the pipeline stage then passes them to `sessionManager.bindHandle()`. This keeps the adapter unaware of the session manager.

### CompleteOptions — minimal change

```typescript
// complete() is for one-shot calls — no multi-turn session.
// It creates ephemeral sessions that are closed immediately.
// Session manager is NOT involved for complete() calls.

interface CompleteOptions {
  // ...existing fields...
  // sessionName, featureName, storyId, sessionRole remain for
  // ephemeral session naming (debugging/audit only).
  // No SessionDescriptor — complete() doesn't participate in
  // the managed session lifecycle.
}
```

**Why `complete()` is excluded:** One-shot calls (`decompose`, `acceptance-gen`, `refine`, etc.) don't need session continuity, scratch, or crash recovery. They create ephemeral sessions that close immediately. Adding session management overhead to every `complete()` call would be pure cost with no benefit.

---

## ACP Adapter Migration — What Changes

### `_runWithClient()` — before vs after

```typescript
// BEFORE (adapter.ts:810-1002, simplified)
private async _runWithClient(options: AgentRunOptions, startTime: number): Promise<AgentResult> {
  const client = createClient(cmdStr, options.workdir, ...);
  await client.start();

  // 1. Resolve session name (3-way fallback)
  let sessionName = options.acpSessionName;
  if (!sessionName) {
    const entry = await readAcpSessionEntry(workdir, feature, sidecarKey);
    if (entry && sidecarStatus(entry) === "in-flight") {
      await clearAcpSession(...);        // crash guard
    } else if (entry) {
      sessionName = sidecarSessionName(entry);
    }
  }
  sessionName ??= buildSessionName(workdir, feature, storyId, role);

  // 2. Write in-flight marker
  await saveAcpSession(workdir, feature, sidecarKey, sessionName, agentName, "in-flight");

  // 3. Ensure session
  const { session } = await ensureAcpSession(client, sessionName, agentName, permissionMode);

  try {
    // 4. Multi-turn loop
    // ... (unchanged) ...
  } finally {
    // 5. Complex close logic — 4 branches
    if (success && !keepSessionOpen) { close + clear sidecar }
    else if (sessionBroken) { close + clear sidecar }
    else if (failure) { promote sidecar "in-flight" → "open" }
    else { /* keepSessionOpen success */ promote sidecar to "open" }
  }
}


// AFTER (with session manager)
private async _runWithClient(options: AgentRunOptions, startTime: number): Promise<AgentResult> {
  const client = createClient(cmdStr, options.workdir, ...);
  await client.start();

  // 1. Derive protocol name from descriptor (one line, no fallback chain)
  const acpName = this.deriveSessionName(options.session);

  // 2. No crash guard — manager handles via state machine
  // 3. No sidecar write — manager owns state

  // 4. Ensure physical session (unchanged internally)
  const { session, resumed } = await ensureAcpSession(client, acpName, agentName, permissionMode);

  // 5. Capture protocol IDs from acpx session object
  //    session.id = volatile acpxSessionId (changes on reconnect)
  //    session.recordId = stable acpxRecordId (never changes)
  const protocolIds = {
    recordId: session.recordId ?? null,
    sessionId: session.id ?? null,
  };

  try {
    // 6. Multi-turn loop (unchanged)
    // ... (unchanged) ...
  } finally {
    // 7. No close logic — just close the acpx client transport
    await client.close().catch(() => {});
    // Manager decides what to do with the session after seeing AgentResult
  }

  // 8. Return protocol IDs on the result — pipeline stage persists them
  return {
    success: ...,
    exitCode: ...,
    output: ...,
    protocolIds,    // <-- NEW: surfaced for session manager binding
    // ...
  };
}
```

**What's deleted from ACP adapter:**
- `buildSessionName()` — replaced by `deriveSessionName(descriptor)`
- Sidecar read/write functions (`saveAcpSession`, `readAcpSession`, `readAcpSessionEntry`, `clearAcpSession`)
- Crash guard logic (lines 824-839)
- In-flight marker write (lines 854-857)
- Close decision logic (lines 964-1001)
- `sweepFeatureSessions()`, `sweepStaleFeatureSessions()`
- `closeNamedAcpSession()`

**What stays in ACP adapter:**
- `ensureAcpSession()` — still creates/resumes the physical ACP session
- `closeAcpSession()` — renamed to `closePhysicalSession()`, called by manager
- `runSessionPrompt()` / multi-turn loop
- Token/cost tracking
- Prompt audit
- `_acpAdapterDeps` pattern for testing
- `deriveSessionName()` — new, protocol-specific name derivation

### Lines of code impact

| Removed from adapter | Approximate lines |
|:---------------------|:------------------|
| `buildSessionName()` | ~20 |
| Sidecar CRUD functions | ~110 |
| Crash guard in `_runWithClient()` | ~15 |
| In-flight marker logic | ~5 |
| Close decision branches | ~40 |
| `sweepFeatureSessions()` | ~45 |
| `sweepStaleFeatureSessions()` | ~50 |
| `closeNamedAcpSession()` | ~30 |
| **Total removed** | **~315 lines** |

| Added to adapter | Approximate lines |
|:-----------------|:------------------|
| `deriveSessionName()` | ~5 |
| `closePhysicalSession()` wrapper | ~10 |
| Read `session` from `AgentRunOptions` | ~5 |
| **Total added** | **~20 lines** |

Net: ~295 lines removed from adapter. Session logic moves to `SessionManager` (~250 lines) + `scratch.ts` (~50 lines).

---

## Pipeline Stage Integration — Who Calls What

### context.ts (session creation)

```typescript
// src/pipeline/stages/context.ts

async execute(ctx: PipelineContext): Promise<StageResult> {
  // ... existing feature resolution ...

  // NEW: Create session(s) based on routing strategy
  const strategy = ctx.routing?.testStrategy ?? "simple";
  const primaryRole = resolveSessionRole(strategy);
  // single-session / tdd-simple / no-test / batch → 1 session
  // three-session-tdd → 3 sessions (test-writer, implementer, verifier)

  const session = await ctx.sessionManager.create({
    storyId: ctx.story.id,
    featureId: featureResult?.featureId ?? null,
    role: primaryRole,
    agent: ctx.agentTarget,
    repoRoot: ctx.workdir,
  });

  ctx.sessionId = session.id;

  // ... existing context building ...
}
```

### execution.ts (adapter call + lifecycle decision)

```typescript
// src/pipeline/stages/execution.ts

async execute(ctx: PipelineContext): Promise<StageResult> {
  const session = ctx.sessionManager.get(ctx.story.id, "implementer")
                ?? ctx.sessionManager.get(ctx.story.id, "single-session")!;

  // Transition to active
  await ctx.sessionManager.transition(session.id, "active");

  const result = await agent.run({
    prompt,
    workdir: ctx.workdir,
    session,                         // SessionDescriptor, not 5 separate params
    modelTier,
    modelDef,
    timeoutSeconds,
    config: ctx.config,
  });

  // Bind protocol IDs from the adapter result to the session descriptor.
  // This persists the acpx recordId (stable) and sessionId (volatile)
  // in index.json for post-run audit correlation:
  //   storyId → nax sess-<uuid> → acpx recordId → prompt audit files
  if (result.protocolIds) {
    await ctx.sessionManager.bindHandle(
      session.id,
      agent.deriveSessionName(session),
      result.protocolIds,
    );
  }

  // Pipeline stage makes the lifecycle decision — NOT the adapter
  if (result.success) {
    // More stages coming (verify, review) — suspend, don't close
    await ctx.sessionManager.transition(session.id, "suspended");
  } else if (result.sessionError && !result.sessionErrorRetryable) {
    // Session is broken — mark failed, rect loop will create new
    await ctx.sessionManager.transition(session.id, "failed");
  } else {
    // Retriable failure — keep in active state for rect loop
    await ctx.sessionManager.transition(session.id, "failed");
  }

  return { action: result.success ? "continue" : "retry" };
}
```

### session-runner.ts (three-session TDD)

```typescript
// src/tdd/session-runner.ts

async runTestWriter(ctx: PipelineContext): Promise<SessionResult> {
  // Create or resume test-writer session
  let session = await ctx.sessionManager.resume(ctx.story.id, "test-writer")
             ?? await ctx.sessionManager.create({
                  storyId: ctx.story.id,
                  featureId: ctx.featureId,
                  role: "test-writer",
                  agent: ctx.agentTarget,
                  repoRoot: ctx.workdir,
                });

  await ctx.sessionManager.transition(session.id, "active");

  const result = await agent.run({
    prompt: testWriterPrompt,
    session,
    // ...other options
  });

  if (result.success) {
    // Test-writer done — suspend session
    await ctx.sessionManager.transition(session.id, "suspended");
    // Record stage digest for progressive context
    await ctx.sessionManager.recordStage(session.id, "tdd-test-writer", digest);
  }

  return result;
}

async runImplementer(ctx: PipelineContext): Promise<SessionResult> {
  // Create implementer session (primary session)
  let session = await ctx.sessionManager.resume(ctx.story.id, "implementer")
             ?? await ctx.sessionManager.create({ ... });

  // ... same pattern: transition, run, transition based on result
}
```

### rectification-loop.ts (retry with session resume)

```typescript
// src/pipeline/stages/rectify.ts (or rectification-loop.ts)

async rectify(ctx: PipelineContext, attempt: number): Promise<StageResult> {
  // Resume the implementer session — it was marked "failed" by verify
  const session = await ctx.sessionManager.resume(ctx.story.id, "implementer");
  if (!session) {
    // Session was broken — create new
    session = await ctx.sessionManager.create({ role: "implementer", ... });
  }

  await ctx.sessionManager.transition(session.id, "active");

  // Write failure context to scratch
  await appendScratch(ctx.sessionManager, session.id, {
    stage: "rectify",
    kind: "rectify-attempt",
    content: `Attempt ${attempt}: ${failureOutput}`,
  });

  const result = await agent.run({ prompt: rectifyPrompt, session, ... });

  if (result.success) {
    await ctx.sessionManager.transition(session.id, "suspended");
    // Back to verify stage
  } else {
    await ctx.sessionManager.transition(session.id, "failed");
    // More retries or give up
  }
}
```

### review/semantic.ts (reviewer session)

```typescript
// src/review/semantic.ts

async runReview(ctx: PipelineContext): Promise<ReviewResult> {
  // Reviewer gets its own session — separate from implementer
  const session = await ctx.sessionManager.create({
    storyId: ctx.story.id,
    featureId: ctx.featureId,
    role: "reviewer-semantic",
    agent: ctx.agentTarget,
    repoRoot: ctx.workdir,
  });

  await ctx.sessionManager.transition(session.id, "active");

  const result = await agent.run({ prompt: reviewPrompt, session, ... });

  // Review session always closes when review is done (ADR-008)
  await ctx.sessionManager.transition(session.id, "completed");

  // Write findings to implementer's scratch (cross-session sharing, OQ-24)
  const implSession = ctx.sessionManager.get(ctx.story.id, "implementer");
  if (implSession && findings.length > 0) {
    await appendScratch(ctx.sessionManager, implSession.id, {
      stage: "review-semantic",
      kind: "review-finding",
      content: formatFindings(findings),
    });
  }

  return { findings };
}
```

### run-completion.ts (story cleanup)

```typescript
// src/execution/lifecycle/run-completion.ts

async complete(ctx: PipelineContext): Promise<void> {
  // Close all sessions for completed stories
  for (const story of completedStories) {
    await ctx.sessionManager.closeStory(story.id);
    // closeStory() transitions all sessions to "completed"
    // and calls adapter.closePhysicalSession() for each
  }

  // Archive stale scratch
  await ctx.sessionManager.archiveStale(config.context.session.retentionDays);
}
```

---

## Future Adapter Support

The design makes adding a new adapter straightforward. A new adapter (e.g., Codex, Gemini) implements:

```typescript
class CodexAgentAdapter implements AgentAdapter {
  // 1. Protocol-specific session name derivation
  deriveSessionName(descriptor: SessionDescriptor): string {
    // Codex might use a different naming convention
    return `codex-${descriptor.id.slice(5, 13)}`;
  }

  // 2. Physical session close
  async closePhysicalSession(handle: string, workdir: string): Promise<void> {
    // Codex-specific close logic
  }

  // 3. run() — receives SessionDescriptor, creates Codex session, runs prompt
  async run(options: AgentRunOptions): Promise<AgentResult> {
    const sessionName = this.deriveSessionName(options.session);
    // Create/resume Codex session with sessionName
    // Run multi-turn loop
    // Return AgentResult — no session lifecycle decisions
  }

  // 4. complete() — ephemeral, unchanged pattern
}
```

The new adapter does NOT need to:
- Implement crash detection
- Manage sidecar files
- Decide when to close sessions
- Handle availability fallback handoff
- Track session state

All of that is handled by `SessionManager`, which is adapter-agnostic.

### Adapter-agnostic session handoff (availability fallback)

```
Claude session hits quota
  |
  v
Runner detects availability failure
  |
  v
ctx.sessionManager.handoff(sessionId, codexTarget, "fail-quota")
  |  - priorAgents[] += { agent: claude, failedAt, reason }
  |  - descriptor.agent = codexTarget
  |  - state: active → handed-off
  |  - sessionId UNCHANGED (scratch carries forward)
  |
  v
codexAdapter.run({ session: descriptor, ... })
  |  codexAdapter.deriveSessionName(descriptor) → "codex-a1b2c3d4"
  |  creates NEW physical Codex session
  |  reads EXISTING scratch (written by Claude stages)
  |
  v
ctx.sessionManager.bindHandle(sessionId, "codex-a1b2c3d4")
  |  state: handed-off → active
  |
  v
Story continues under Codex
```

Key: the `SessionDescriptor.id` never changes. Scratch, digests, and manifest entries are keyed by this stable ID. The physical session handle changes, but the logical session is continuous.

---

## Migration Path

### Phase 0: Dual-write

Both systems run in parallel. Session manager creates sessions and tracks state; adapter continues its existing sidecar logic. The manager's state is the source of truth for new code; sidecar is kept for backward compatibility with any tooling that reads it.

```
                     Phase 0
                     =======
Pipeline stage
  |
  +---> SessionManager.create()       <-- new path
  |       writes index.json
  |       creates scratch dir
  |
  +---> AgentAdapter.run()
          |
          +---> old path: buildSessionName(), sidecar, crash guard
          +---> new path: reads descriptor.id (but also writes sidecar for compat)
```

### Phase 1: Adapter reads descriptor

Adapter reads `options.session` for session name derivation. Falls back to old path if `options.session` is undefined (backward compat).

### Phase 5.5: Legacy removal

- Remove `buildSessionName()`, sidecar CRUD, crash guard, close decision branches from adapter
- Remove `keepSessionOpen` from `AgentRunOptions`
- Remove `acpSessionName` from `AgentRunOptions`
- Remove `sweepFeatureSessions()`, `sweepStaleFeatureSessions()`
- Adapter is ~295 lines lighter

---

## Gaps Found in Re-Analysis

The following behaviors exist in the current ACP adapter but were not addressed in the SessionManager design (Amendment D) or this integration spec. Each is analyzed with a resolution.

### Gap 1: Session Error Retry Logic

**Current behavior:** The adapter's `run()` method has an internal retry loop (lines 692-715) that handles session errors (exit code 4, `QUEUE_DISCONNECTED_BEFORE_COMPLETION`). Two tracks:

| Error type | Retryable | Max retries | Action |
|:-----------|:----------|:------------|:-------|
| Non-retryable session error (stale/locked) | No | 1 (`sessionErrorMaxRetries`) | Clear sidecar, create fresh physical session |
| Retryable session error (QUEUE_DISCONNECTED) | Yes | 3 (`sessionErrorRetryableMaxRetries`) | Clear sidecar, create fresh physical session |

The `shouldRetrySessionError` flag in `_acpAdapterDeps` (default `true`, `false` in tests) controls whether retry fires.

**Problem:** The SessionManager doesn't know about these retries. When the adapter internally retries with a fresh physical session, the manager still thinks the original session is "active." The manager's `handle` and `protocolIds` point to the first physical session, not the retry.

**Resolution: Session error retries stay in the adapter.** These are protocol-level reconnection retries — the logical session hasn't changed, just the physical connection. The adapter handles them transparently and surfaces the final result to the pipeline stage. On retry:

1. Adapter closes the broken physical session internally.
2. Adapter creates a new physical session (same derived name — acpx identifies sessions by name, not by connection).
3. Adapter updates `protocolIds` on the `AgentResult` to reflect the final session's IDs.
4. Pipeline stage calls `bindHandle()` with the final IDs — overwrites any stale values.

The session manager's state stays `active` throughout retries. No state transition needed. This is analogous to a TCP reconnect — the application session continues, the transport is replaced.

**Config stays in adapter:** `sessionErrorMaxRetries` and `sessionErrorRetryableMaxRetries` remain adapter config, not session manager config. They're protocol-specific retry behavior.

**AgentResult change:** Add `sessionRetries: number` to `AgentResult` so the pipeline stage and metrics can track how many session-level retries occurred:

```typescript
interface AgentResult {
  // ... existing fields ...
  protocolIds?: { recordId: string | null; sessionId: string | null };
  /** Number of session-level retries (broken connection, QUEUE_DISCONNECTED). */
  sessionRetries?: number;
}
```

### Gap 2: Adapter-Level Multi-Agent Fallback (`_unavailableAgents`)

**Current behavior:** The adapter tracks a per-story `_unavailableAgents` Set. When `run()` or `complete()` encounters an auth failure (401/403), it marks that agent as unavailable and walks `config.autoMode.fallbackOrder[]` to try the next agent. Rate-limit errors (429) trigger sleep + retry. `clearUnavailableAgents()` resets at story boundaries via `AgentRegistry.resetStoryState()`.

**Problem:** This is a separate fallback mechanism from v2's `SessionManager.handoff()`. Both handle "switch to a different agent," but at different layers:

| Concern | Adapter fallback (today) | SessionManager fallback (v2) |
|:--------|:------------------------|:----------------------------|
| Trigger | Auth error, rate limit in `parseAgentError()` | `AdapterFailure.category === "availability"` |
| Decision maker | Adapter's `run()` loop | Runner + session manager |
| Agent selection | `config.autoMode.fallbackOrder[]` | `config.context.fallback.map` |
| Session continuity | None — fresh session, no scratch carry | Yes — same sessionId, scratch preserved |
| Context rebuild | None — same prompt re-sent to new agent | `orchestrator.rebuildForAgent()` re-renders for new agent profile |

**Resolution: Two-phase migration.**

**Phase 0-4 (coexistence):** Adapter-level fallback continues to handle rate-limit and auth errors as today. These are *transport-level* failures — the prompt doesn't need to be re-rendered for a different agent profile. The adapter walks `fallbackOrder[]` internally and the session manager sees a single `agent.run()` call that either succeeds or fails.

**Phase 5.5 (unification):** Adapter-level fallback is replaced by the v2 fallback path:

1. Adapter's `run()` stops walking `fallbackOrder[]` internally.
2. Instead, on auth/rate-limit failure, adapter returns `AgentResult` with a structured failure:
   ```typescript
   interface AgentResult {
     // ... existing fields ...
     adapterFailure?: {
       category: "availability" | "quality";
       outcome: "fail-quota" | "fail-service-down" | "fail-auth" | "fail-timeout" | "fail-adapter-error";
       retriable: boolean;
       retryAfterSeconds?: number;
     };
   }
   ```
3. The pipeline stage inspects `adapterFailure` and calls `sessionManager.handoff()` + `orchestrator.rebuildForAgent()`.
4. `_unavailableAgents` tracking moves to the session manager (per-story, not per-adapter).
5. `config.autoMode.fallbackOrder` is superseded by `config.context.fallback.map`.

**Why not unify immediately?** The adapter's fallback is deeply interleaved with its retry loop and works today. Replacing it before the session manager and orchestrator are solid would break a working system. Coexistence is safe because the two mechanisms operate at different layers.

### Gap 3: Timeout State Transition

**Current behavior:** When `runSessionPrompt()` times out:
1. `cancelActivePrompt()` kills the in-flight `acpx` process (SIGTERM).
2. Returns `{ timedOut: true }`.
3. The session is NOT closed — it's left open on the server side.
4. The `finally` block in `_runWithClient()` sees `!runState.succeeded` and either:
   - `isSessionBroken` (stopReason=error) → close + clear
   - Not broken → promote sidecar to "open" (keep for retry)

**Problem:** The SessionManager state machine doesn't have a timeout-specific transition. Is timeout `failed` or something else?

**Resolution: Timeout is a `failed` state with metadata.**

```
Timeout occurs
  → adapter returns AgentResult { success: false, exitCode: 124, timedOut: true }
  → pipeline stage calls sessionManager.transition(id, "failed")
  → session stays open on server side (adapter does NOT close)
  → rectification loop can resume with sessionManager.resume()
```

Timeout is not a session error (the session isn't broken — it just took too long). The session remains resumable. The `failed` state is correct because the stage didn't complete successfully.

The `timedOut` flag on `AgentResult` already distinguishes timeout from other failures. No new state needed in the state machine — `failed` with `AgentResult.exitCode === 124` is sufficient.

### Gap 4: Force-Terminate on Close

**Current behavior:** The `complete()` method closes sessions with `forceTerminate: hadError` flag (lines 1175-1178). When `forceTerminate=true`, the client spawns `acpx stop` (hard kill) instead of a gentle `acpx sessions close`. The `run()` path always uses gentle close.

**Problem:** `closePhysicalSession()` in our spec has no `force` parameter.

**Resolution: Add optional `force` parameter:**

```typescript
interface AgentAdapter {
  closePhysicalSession(handle: string, workdir: string, options?: {
    /** Force-terminate (e.g., acpx stop). Default: false (gentle close). */
    force?: boolean;
  }): Promise<void>;
}
```

The session manager calls with `force: true` when transitioning from `active` to `completed` after an error (session is stuck). Default is `false` (gentle close).

### Gap 5: `plan()` Session Creation

**Current behavior:** `plan()` wraps `run()` internally, passing `featureName` and `storyId`. It creates a sidecar entry like a normal run. It uses the same session lifecycle as `run()`.

**Problem:** The integration spec doesn't show how the plan stage creates a session.

**Resolution: Plan stage creates a "planner" session.** Already addressed in Amendment D section D.4:

```
context.ts stage:
  2. Determine session role from routing strategy:
       three-session-tdd → creates 3 sessions (test-writer, implementer, verifier)
       ...
```

But the plan stage runs BEFORE the TDD sessions. The plan session is separate:

```
context.ts stage → creates "planner" session (short-lived, closed after planning)
tdd session-runner → creates "test-writer", "implementer", "verifier" sessions
```

Plan session lifecycle:
- Created by context stage or plan stage
- Transitions: created → active → completed (plan always closes after producing the plan)
- Digest from plan is recorded via `sessionManager.recordStage(id, "plan", digest)`
- Session marked completed immediately — plan never needs retry (if plan fails, the story fails)

### Gap 6: Per-Story `clearUnavailableAgents()` Lifecycle

**Current behavior:** `AgentRegistry.resetStoryState()` is called at story boundaries. It calls `clearUnavailableAgents()` on each adapter, which clears the `_unavailableAgents` Set. This prevents a transient auth failure in story A from blocking the agent in story B.

**Problem:** This per-story reset interacts with the session manager's per-story `closeStory()`. Are they called at the same point?

**Resolution: Both called in `run-completion.ts`.** `closeStory()` handles session cleanup. `resetStoryState()` handles adapter transient state. They're independent and both called at story completion:

```typescript
// run-completion.ts
for (const story of completedStories) {
  await ctx.sessionManager.closeStory(story.id);    // session cleanup
  registry.resetStoryState();                         // adapter transient state
}
```

No change needed. They coexist at the same lifecycle point.

### Gap 7: SpawnAcpClient is Stateless Per-Call

**Current behavior:** Each `session.prompt()` spawns a fresh `acpx` process. There's no persistent connection. Sessions exist server-side in acpx; the adapter is just a CLI client.

**Problem:** The SessionManager's `handle` field implies a connection handle. In reality, it's just a session name string.

**Resolution: Clarify semantics.** The `handle` field in `SessionDescriptor` is the protocol-specific session identifier used to address the session — NOT a connection handle. For ACP, it's the session name passed to `acpx sessions ensure --name <handle>`. For a future WebSocket-based adapter, it might be a connection ID. The session manager doesn't care about the semantics — it stores and passes it to `adapter.closePhysicalSession(handle)`.

Rename in documentation: "Protocol-specific session handle" → "Protocol-specific session identifier" to avoid confusion with connection handles.

---

## Summary of Changes From Re-Analysis

### AgentResult additions

```typescript
interface AgentResult {
  // ... existing fields ...
  protocolIds?: { recordId: string | null; sessionId: string | null };
  sessionRetries?: number;                    // NEW (Gap 1)
  adapterFailure?: {                          // NEW (Gap 2, ships Phase 5.5)
    category: "availability" | "quality";
    outcome: "fail-quota" | "fail-service-down" | "fail-auth"
           | "fail-timeout" | "fail-adapter-error";
    retriable: boolean;
    retryAfterSeconds?: number;
  };
}
```

### closePhysicalSession signature update

```typescript
closePhysicalSession(handle: string, workdir: string, options?: {
  force?: boolean;                            // NEW (Gap 4)
}): Promise<void>;
```

### What stays in the adapter (not migrated)

| Behavior | Why it stays |
|:---------|:-------------|
| Session error retry loop (Gap 1) | Protocol-level reconnection — transparent to session manager |
| Multi-agent fallback walk (Gap 2) | Coexists through Phase 5.5, then replaced by v2 fallback |
| `shouldRetrySessionError` dep injection | Test-only concern, adapter-specific |
| Token/cost accumulation across turns | Per-invocation accounting, not session lifecycle |
| `_unavailableAgents` per-story tracking (Gap 6) | Adapter transient state, cleared at story boundary alongside `closeStory()` |

### Acceptance criteria additions

79. **Session error retries transparent.** When the adapter retries due to session error (QUEUE_DISCONNECTED, stale session), the session manager's state remains `active`. `AgentResult.protocolIds` reflects the FINAL physical session's IDs, not the first attempt's. `AgentResult.sessionRetries` reports the retry count.

80. **Adapter fallback coexistence (Phase 0-4).** The adapter's internal `fallbackOrder[]` walk for auth/rate-limit errors continues to work alongside the session manager. The session manager sees a single `agent.run()` call. No `handoff()` is triggered by adapter-level fallback.

81. **Adapter fallback replacement (Phase 5.5).** The adapter returns `adapterFailure` on `AgentResult` instead of retrying internally. The pipeline stage calls `sessionManager.handoff()` and `orchestrator.rebuildForAgent()`. `_unavailableAgents` tracking moves to the session manager.

82. **Timeout treated as failed.** A timed-out session (`exitCode: 124`) transitions to `failed` via `sessionManager.transition()`. The physical session is NOT closed (it's left open on the server). Rectification can resume it.

83. **Force-terminate on close.** `closePhysicalSession()` accepts `options.force: boolean`. When `true`, the adapter uses hard termination (e.g., `acpx stop`). The session manager calls with `force: true` when closing an errored session.
