# ACP Session Mode — Implementation Spec

**Date:** 2026-03-13  
**Branch:** `feat/acp-agent-adapter`  
**File:** `src/agents/acp/adapter.ts`

---

## Problem

`AcpAgentAdapter.run()` currently shells out to `acpx exec` (one-shot mode).  
This means:
- The agent cannot ask questions mid-run
- The interaction bridge is wired but never fires
- auth-module style stories that require human confirmation/input are blocked

## Goal

Switch `run()` from `acpx exec` to **`acpx sessions`** (persistent session mode), enabling:
- Multi-turn agent ↔ human Q&A during story execution
- Interaction questions routed via Telegram plugin
- Session continuity between `plan()` and `run()` phases
- Same `AgentResult` contract — no API changes to callers

`complete()` and `decompose()` stay on `acpx exec` — they are one-shot LLM calls.

---

## acpx Session CLI Reference (confirmed)

```bash
# Create a named session
acpx claude sessions new --name <name>

# Ensure a session exists (idempotent — creates or resumes)
acpx claude sessions ensure --name <name>

# Send a prompt turn using a named session (-s selects the session by name)
# Blocks until agent finishes that turn. stdin = prompt text when --file -
acpx --cwd <dir> --approve-all --format json --model <model> --timeout <secs> \
  claude prompt -s <name> --file -

# Without --file, prompt text is the positional argument:
acpx --cwd <dir> --approve-all --format json --timeout <secs> \
  claude prompt -s <name> "implement the feature"

# List sessions
acpx claude sessions list

# Close session (terminates session entirely — use in finally block)
acpx claude sessions close <name>

# Cancel in-flight prompt (stops current turn, keeps session alive)
acpx claude cancel
```

Key points:
- `prompt -s <name>` selects a named session within the current cwd scope
- Without `-s`, acpx uses the cwd-scoped default session (shared = wrong for nax — all stories in same project would share one session)
- `sessions close <name>` is the cleanup command — handles graceful close and implicit cancellation of any in-flight prompt
- Default `acpx claude prompt` without `-s` exits with `NO_SESSION` if no session exists for that cwd — does NOT auto-create

---

## Session Naming Convention

Sessions are named: **`nax-<featureName>-<storyId>`**  
Example: `nax-string-toolkit-ST-001`

This is deterministic, unique per story execution, and human-readable in `acpx sessions list`.

---

## Session ID Persistence in status.json

Session IDs are stored in the story's entry in `nax/features/<feature>/status.json`:

```json
{
  "stories": {
    "ST-001": {
      "status": "in-progress",
      "acpSessionName": "nax-string-toolkit-ST-001"
    }
  }
}
```

On `plan()` start:
1. `acpx claude sessions new --name nax-<feature>-<storyId>` → stores name in status.json
2. Run planning turn

On `run()` start:
1. Read `acpSessionName` from status.json (if exists)
2. `acpx claude sessions ensure --name <name>` → resumes if alive, creates if not
3. If `ensure` fails (session expired): create new session, update status.json
4. Run implementation turn(s)

On story completion (pass or fail):
1. `acpx claude sessions close <name>` (best-effort, in finally)
2. Clear `acpSessionName` from status.json

---

## New Architecture: `_runSessionMode()`

### Flow

```
_runSessionMode(options, startTime):
  1. Resolve session name: "nax-<feature>-<storyId>"
  2. Ensure session: acpx sessions ensure --name <name>  (creates or resumes)
  3. Turn loop (max MAX_SESSION_TURNS = 10):
       a. currentPrompt = options.prompt (first turn) or human answer (subsequent)
       b. Run: acpx --cwd <dir> --approve-all --format json --timeout <secs> claude prompt -s <sessionName> --file -
              stdin = currentPrompt
       c. Parse output (same JSON parsing as exec mode)
       d. exitCode !== 0 → handle error (rate limit check, etc.), break
       e. extractQuestion(output):
            - If question found AND interactionBridge present:
                → send question via interactionBridge
                → await human answer (INTERACTION_TIMEOUT_MS = 5 min)
                → if no answer (timeout): break loop, return partial result
                → set currentPrompt = answer, continue loop
            - If no question OR no bridge: break loop (done)
  4. Finally (always):
       acpx claude sessions close <name>  (best-effort, swallow errors)
       unregister PID from pidRegistry
  5. Return AgentResult (same shape as exec mode)
```

### Timeout Design

**Per-turn timeout inheriting `config.execution.sessionTimeoutSeconds`.**

- Each `acpx claude prompt` call gets `--timeout <options.timeoutSeconds>` where `options.timeoutSeconds = config.execution.sessionTimeoutSeconds` (default: 1800s)
- Between turns (waiting for human answer), NO subprocess is running → no timeout burns
- Human response wait uses a separate `INTERACTION_TIMEOUT_MS` (5 min default)
- If human never answers → break loop, close session, return partial result

This matches user expectation: "I set 1800s meaning the agent gets 30 min." In session mode, each turn gets that full budget. Human wait time does not count against it.

```
Turn 1: [====agent computing====] timeout=1800s  → outputs question, exits
Wait:   [====human thinking====]  NO timeout     → human answers via Telegram
Turn 2: [====agent computing====] timeout=1800s  → done
```

If `timedOut=true` on a turn:
- Map to exitCode 124 (POSIX convention)
- Close session, return result with `timedOut: true`
- Do NOT retry — agent was stuck, not rate limited

### Question Detection: `extractQuestion(output: string): string | null`

```typescript
function extractQuestion(output: string): string | null {
  const text = output.trim();
  if (!text) return null;

  // Split into sentences, find last question
  const sentences = text.split(/(?<=[.!?])\s+/);
  const questionSentences = sentences.filter(s => s.trim().endsWith("?"));
  if (questionSentences.length > 0) {
    const q = questionSentences[questionSentences.length - 1].trim();
    if (q.length > 10) return q;
  }

  // Explicit question markers (even without ?)
  const lower = text.toLowerCase();
  const markers = ["please confirm", "please specify", "please provide", "which would you", "should i ", "do you want", "can you clarify"];
  for (const marker of markers) {
    if (lower.includes(marker)) {
      // Return last 200 chars as the question
      return text.slice(-200).trim();
    }
  }

  return null;
}
```

---

## Implementation Details

### New helper functions (all in `adapter.ts`)

```typescript
// Build the deterministic session name for a story
function buildSessionName(featureName: string, storyId: string): string

// Ensure session exists (create or resume), returns session name
async function ensureAcpSession(params: {
  agentName: string;
  sessionName: string;
  env: Record<string, string | undefined>;
  cwd: string;
}): Promise<void>

// Run a single prompt turn using: acpx claude prompt -s <sessionName> --file -
// stdin = prompt text
async function runSessionPrompt(params: {
  agentName: string;
  sessionName: string;   // -s <name> flag value
  prompt: string;        // piped via stdin (--file -)
  env: Record<string, string | undefined>;
  cwd: string;
  model: string;
  timeoutSeconds: number;
  pidRegistry?: PidRegistry;
}): Promise<{ output: string; parsed: AcpJsonOutput; exitCode: number; timedOut: boolean; pid?: number }>

// Close session (best-effort cleanup)
async function closeAcpSession(params: {
  agentName: string;
  sessionName: string;
  env: Record<string, string | undefined>;
  cwd: string;
}): Promise<void>

// Extract question from agent output
function extractQuestion(output: string): string | null
```

### `run()` modification

```typescript
async run(options: AgentRunOptions): Promise<AgentResult> {
  // ... existing retry/rate-limit loop ...
  const result = await this._runSessionMode(options, startTime);
  // ... same result handling ...
}
```

### `_runOnce()` — keep intact

Used by `complete()` and `decompose()`. No changes.

### Cost accumulation across turns

```typescript
let totalTokenUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
// Per turn:
if (parsed.tokenUsage) {
  totalTokenUsage.inputTokens += parsed.tokenUsage.inputTokens ?? 0;
  totalTokenUsage.outputTokens += parsed.tokenUsage.outputTokens ?? 0;
}
// Final cost from totalTokenUsage
```

---

## AgentRunOptions — new optional fields

```typescript
// Add to AgentRunOptions in types.ts:
acpSessionName?: string;  // If set, resume this named session instead of creating new
featureName?: string;     // Used to build session name (nax-<featureName>-<storyId>)
storyId?: string;         // Used to build session name
```

These are optional — if not provided, `_runSessionMode` creates an anonymous session (UUID-named).

---

## Error Handling

| Scenario | Behaviour |
|:---------|:----------|
| `sessions ensure` fails | Throw — retry logic in `run()` handles it |
| Turn times out | `timedOut=true`, exitCode=124, close session, return result |
| Turn exits non-zero | Check rate limit; if rate limited → retry outer loop; else return failure |
| Session expired between turns | `runSessionPrompt` will fail → catch `SESSION_NOT_FOUND` → return partial result with error message |
| Max turns (10) reached | Close session, return last output as result |
| Human answer timeout (5 min) | Break loop, close session, return partial result |
| `sessions close` fails | Log warn, ignore — best-effort only |

---

## Files to Change

| File | Change |
|:-----|:-------|
| `src/agents/acp/adapter.ts` | Add `_runSessionMode()` + helper functions. Modify `run()` to call it. Keep `_runOnce()` intact. |
| `src/agents/types.ts` | Add `acpSessionName?`, `featureName?`, `storyId?` to `AgentRunOptions` |

No pipeline/runner changes needed for basic session mode. Session name threading from `plan()` is a follow-up.

---

## Testing

New file: `test/unit/agents/acp/adapter-session.test.ts`

Test cases:
- Single turn, no question → done, correct AgentResult
- Turn with question → interactionBridge.ask() called → answer → second turn → done
- Interaction timeout → partial result returned
- Max turns (10) reached → returns last output
- `sessions ensure` failure → throws (triggers outer retry)
- Turn non-zero exit → rate limit path vs generic failure path
- Session close failure → silently ignored, result still returned
- `timedOut=true` on turn → exitCode=124, timedOut in result

---

## Plan Mode + Session Continuity

`plan()` and `run()` share the same session so the agent retains planning context (file reads, analysis) during implementation.

### Flow

```
plan() phase:
  1. sessions ensure --name nax-<feature>-<storyId>    (creates session)
  2. Write acpSessionName to status.json under the story entry
  3. Run planning turn → return plan text

run() phase:
  1. Read acpSessionName from status.json (if present)
  2. sessions ensure --name <acpSessionName>            (resumes if alive, creates if expired)
  3. If ensure fails (session truly gone): create new, update status.json
  4. Run implementation turn(s) — agent has planning context in memory
```

Graceful degradation: if the session expired between plan and run (long pause), `sessions ensure` silently creates a fresh session. The implementation prompt includes the plan text, so the agent has the plan even without the session history.

### status.json shape

```json
{
  "stories": {
    "ST-001": {
      "status": "in-progress",
      "acpSessionName": "nax-string-toolkit-ST-001"
    }
  }
}
```

Clear `acpSessionName` on story completion (pass or fail) after `sessions close`.

---

## Out of Scope

- Session resume across nax restarts beyond status.json (future)
- Multiple concurrent sessions per story (not needed)
- `acpx sessions list` for orphan cleanup (future ops tooling)
