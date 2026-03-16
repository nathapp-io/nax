# ACP Session Lifecycle — Spec

**Date:** 2026-03-16
**Status:** Draft — pending acpx behavior validation
**Depends on:** `acp-session-mode.md` (v2), `scoped-permissions.md` (PERM-001)

---

## Problem

ACP sessions are currently closed unconditionally in the `finally` block of `_runWithClient()`,
regardless of whether the story passed or failed. This has three consequences:

1. **Lost context on failure** — when a story fails, the agent's accumulated context (what it tried,
   what errors it saw, which files it modified) is discarded. Rectification starts cold.

2. **Rectification-loop doesn't reuse sessions** — `rectification-loop.ts` calls `agent.run()` without
   passing `featureName`, `storyId`, or `sessionRole`. Each retry creates an anonymous, context-free session.

3. **No lifecycle boundary** — sessions are never swept at run-end or startup, so any session that
   escapes the `finally` block (crash, OOM, kill -9) becomes permanently stale.

### Current State

| Flow | Session name passed? | Closes on exit? |
|:-----|:---------------------|:----------------|
| Story execution (`_runWithClient`) | ✅ featureName + storyId | Always (finally block) |
| Rectification loop (`rectification-loop.ts`) | ❌ Missing featureName/storyId | N/A (anonymous session) |
| TDD rectification gate (`rectification-gate.ts`) | ✅ featureName + storyId + role | Always (via _runWithClient) |
| Plan (`plan()` method) | ✅ featureName | Always |
| Complete/decompose | ❌ Anonymous | Always |

---

## Goal

Sessions persist on failure so retry/rectification resumes with full agent context.
Clean lifecycle boundaries ensure no sessions leak.

---

## Design

### Session Close Policy

```
Story run completes
  ├── success (passes=true)  → close session + clear sidecar entry
  └── failure (passes=false) → keep session open, keep sidecar entry
                                (session will be resumed on next retry)
```

The close decision is made **inside `_runWithClient()`** based on the `AgentResult.success` value.

### Rectification Session Inheritance

`rectification-loop.ts` must pass session context so it resumes the story's existing session:

```typescript
// Current (broken):
const agentResult = await agent.run({
  prompt: rectificationPrompt,
  workdir,
  // ... no featureName, storyId, sessionRole
});

// Fixed:
const agentResult = await agent.run({
  prompt: rectificationPrompt,
  workdir,
  featureName,        // from caller
  storyId: story.id,
  sessionRole: "implementer",  // rectification is implementation work
  // ...
});
```

The `ensureAcpSession()` function already handles resume: it calls `loadSession()` first, falls back
to `createSession()` if the session doesn't exist.

### Run-End Sweep (Primary Cleanup)

When `runner.ts` finishes (success, failure, or max iterations), sweep all open sessions:

```typescript
// runner.ts finally block (after execution phase):
await sweepFeatureSessions(workdir, feature);
```

**`sweepFeatureSessions(workdir, feature)`:**
1. Read `nax/features/<feature>/acp-sessions.json`
2. For each entry: create a temporary client, `loadSession()`, close it
3. Clear sidecar file

This ensures no sessions survive past the run boundary.

### Startup Sweep (Safety Net)

When `nax run` starts (in `runner-setup.ts`), before first story:

```typescript
// runner-setup.ts, after precheck:
await sweepStaleFeatureSessions(workdir, feature, MAX_SESSION_AGE_MS);
```

**`sweepStaleFeatureSessions(workdir, feature, maxAgeMs)`:**
1. Read sidecar file
2. Check sidecar file `mtime` — if older than `maxAgeMs` (default: 2 hours), sweep all
3. If recent, skip (sessions are from an ongoing or recent run)

This catches sessions orphaned by crashes, OOM, machine restarts.

### Crash Cleanup (Existing)

`PidRegistry.killAll()` already fires on SIGTERM/SIGINT. This kills acpx client processes,
which tears down their sessions at the process level. The sidecar entries remain stale but
are handled by the startup sweep on next run.

---

## Lifecycle Summary

```
nax run starts
  │
  ├── Startup sweep: prune stale sidecar entries (>2h old)
  │
  ├── Story US-001
  │   ├── ensureAcpSession() → create or resume
  │   ├── run agent...
  │   ├── PASS → close session + clear sidecar
  │   └── FAIL → keep session open, keep sidecar
  │
  ├── Rectification (retry US-001)
  │   ├── ensureAcpSession() → resume existing (has context!)
  │   ├── run agent with fix prompt...
  │   ├── PASS → close session + clear sidecar
  │   └── FAIL → keep session open
  │
  ├── ... more stories ...
  │
  └── Run ends (finally)
      └── sweepFeatureSessions() → close ALL remaining sessions
```

---

## Files Changed

| File | Change |
|:-----|:-------|
| `src/agents/acp/adapter.ts` | Conditional close in `_runWithClient()`: close on success, keep on failure |
| `src/agents/acp/adapter.ts` | New: `sweepFeatureSessions()`, `sweepStaleFeatureSessions()` |
| `src/verification/rectification-loop.ts` | Pass `featureName`, `storyId`, `sessionRole` to `agent.run()` |
| `src/execution/runner.ts` | Call `sweepFeatureSessions()` in finally block |
| `src/execution/runner-setup.ts` or `lifecycle/run-setup.ts` | Call `sweepStaleFeatureSessions()` at startup |

---

## Assumptions to Validate (acpx behavior)

Before implementing, we must confirm how acpx actually handles sessions:

### Q1: Session persistence after client close
If we close the **client** (acpx process) but NOT the session, does the session persist?
Can a new client `loadSession()` the same named session?

> **Test:** Create client → create named session → close client (not session) →
> create new client → `loadSession(sameName)` → does it return the session with history?

### Q2: Session state after process kill
If the acpx process is killed (SIGTERM/SIGKILL), is the named session recoverable
by a new client?

> **Test:** Create client → create named session → send a prompt → kill process →
> create new client → `loadSession(sameName)` → does it have the conversation history?

### Q3: loadSession on closed sessions
If we explicitly `session.close()`, does `loadSession(sameName)` return null or error?

> **Test:** Create session → close session → `loadSession(sameName)` → null or error?

### Q4: Session idle timeout
Does acpx/the agent backend have a built-in idle timeout that closes sessions
after N minutes of inactivity?

> **Test:** Create session → wait 10+ minutes → `loadSession(sameName)` → still alive?

### Q5: Multiple clients, same session
Can two clients access the same named session simultaneously? (Relevant for parallel stories)

> **Test:** Client A creates session "foo" → Client B `loadSession("foo")` → both prompt → conflict?

---

## Risks

1. **Context window overflow** — long-running session accumulates tokens. If the agent hits its
   context limit, the session becomes unusable. Mitigation: acpx/agent should handle truncation
   internally; nax doesn't manage context windows.

2. **Session state corruption** — if a failed session left files in a broken state, resuming with
   the same context might confuse the agent. Mitigation: rectification prompt already includes
   the current error output, which overrides stale context.

3. **acpx doesn't support persistence** — if Q1/Q2 show sessions don't survive client restarts,
   this spec is not implementable. Fallback: keep current behavior, just fix rectification-loop
   to pass session context (creates new session with same name, no history but at least named).

---

## Out of Scope

- Per-stage session isolation (e.g., separate session for verify vs implement) — future work
- Session context summarization/compression — depends on agent capabilities
- Cross-feature session sharing — features are isolated by design

---

*Author: nax-dev. Reviewed: pending.*
