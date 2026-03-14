# ACP Session Mode — Implementation Spec (v2)

**Date:** 2026-03-14
**Branch:** `feat/acp-agent-adapter`
**File:** `src/agents/acp/adapter.ts`
**Supersedes:** v1 (2026-03-13)

---

## Problem (v1 → v2)

v1 spec defined session mode using spawn-based CLI wrappers (`acpx sessions ensure`,
`acpx prompt -s`, `acpx sessions close`). This was implemented as `_runSessionMode()`.

Issues discovered during implementation:
1. Spawn-based approach is hard to test (requires spawn mocks, env leaking, output parsing)
2. `createClient` injectable already exists as a proper programmatic ACP API
3. v1 had `_runSessionMode` (spawn, spec-complete) and `_runWithClient` (createClient, spec-incomplete) — confusing dual paths
4. Session naming not passed through `_runWithClient`
5. `--approve-all` hardcoded instead of following `dangerouslySkipPermissions`
6. No cwd scoping in session names (cross-repo conflicts)
7. No session role suffix for TDD isolation
8. `plan()` hardcoded `timeoutSeconds: 600` instead of reading config
9. `complete()`/`decompose()` switched to createClient but spec said `_runOnce` (exec)

## Goal (v2)

**Single transport: `createClient`** for all methods. Session lifecycle functions
(naming, persistence, ensure/close) layered on top as thin wrappers around the
`AcpClient`/`AcpSession` interfaces.

Remove all spawn-based session helpers and `_runOnce`/`_runSessionMode`.

---

## Architecture

```
┌──────────────────────────────────────────────────────┐
│  Session Lifecycle Layer                             │
│                                                      │
│  buildSessionName(gitRoot, feature, story, role?)    │
│  ensureAcpSession(client, name, agent, permMode)     │
│  runSessionPrompt(session, prompt, timeoutMs, pid?)  │
│  closeAcpSession(session)                            │
│  saveAcpSession() / readAcpSession() / clearAcpSession() │
└─────────────────────┬────────────────────────────────┘
                      │ uses
             ┌────────▼─────────┐
             │  AcpClient API   │
             │  createSession() │
             │  loadSession()   │
             │  start() / close()│
             └──────────────────┘
```

### Method → Transport Matrix

| Method | Transport | Session? | Notes |
|:--|:--|:--|:--|
| `run()` | `createClient` via lifecycle layer | ✅ Named, persistent | Multi-turn, interaction bridge |
| `plan()` | `createClient` via `run()` | ✅ Shared session name | Same session for plan→run continuity |
| `complete()` | `createClient` | ❌ Ephemeral | One-shot, no session name |
| `decompose()` | `createClient` via `complete()` | ❌ Ephemeral | One-shot LLM call |

---

## Session Naming Convention

### Format

```
nax-<gitRootHash8>-<featureName>-<storyId>[-<sessionRole>]
```

Examples:
```
nax-a1b2c3d4-string-toolkit-ST-001              (single-session strategies)
nax-a1b2c3d4-string-toolkit-ST-001-test-writer   (tdd-lite / three-session)
nax-a1b2c3d4-string-toolkit-ST-001-implementer   (tdd-lite / three-session)
nax-a1b2c3d4-string-toolkit-ST-001-verifier      (tdd-lite / three-session)
```

### Components

| Component | Source | Purpose |
|:--|:--|:--|
| `nax` | Constant prefix | Namespace in `acpx sessions list` |
| `gitRootHash8` | SHA-256 of `git rev-parse --show-toplevel`, first 8 chars | Prevent cross-repo/worktree collisions |
| `featureName` | `options.featureName` | Human-readable feature identifier |
| `storyId` | `options.storyId` | Story-level isolation |
| `sessionRole` | `options.sessionRole` (optional) | TDD session isolation |

### Git Root Resolution

Use `git rev-parse --show-toplevel` to resolve the git root. This ensures:
- ✅ Worktrees get different sessions (different git root → different hash)
- ✅ Subdirectories of same project get same session
- ✅ Different projects with same feature name don't collide

The git root can be passed from the caller (nax already knows it) or resolved
inside `buildSessionName`. Prefer passing from caller to avoid async spawn.

### Strategy → Session Mapping

| Strategy | Sessions | Role suffixes |
|:--|:--|:--|
| `test-after` | 1 | (none) |
| `tdd-simple` | 1 | (none) |
| `single-session` | 1 | (none) |
| `tdd-lite` | 3 | `test-writer`, `implementer`, `verifier` |
| `three-session-tdd` | 3 | `test-writer`, `implementer`, `verifier` |

---

## Session Lifecycle Functions

### `buildSessionName()`

```typescript
function buildSessionName(
  workdir: string,           // git root (or cwd — caller should resolve)
  featureName?: string,
  storyId?: string,
  sessionRole?: string       // "test-writer" | "implementer" | "verifier"
): string
```

- Hash `workdir` with SHA-256, take first 8 hex chars
- Sanitize feature/story/role: replace non-alphanumeric with `-`, lowercase
- Join with `-`: `nax-<hash>-<feature>-<story>[-<role>]`
- If no feature/story provided, return `nax-<hash>` (fallback)

### `ensureAcpSession()`

```typescript
async function ensureAcpSession(
  client: AcpClient,
  sessionName: string,
  agentName: string,
  permissionMode: string     // "approve-all" | "default"
): Promise<AcpSession>
```

1. Try `client.loadSession(sessionName)` (resume existing)
2. If `loadSession` returns null or is not available → `client.createSession({ agentName, permissionMode, sessionName })`
3. Return the session

### `runSessionPrompt()`

```typescript
async function runSessionPrompt(
  session: AcpSession,
  prompt: string,
  timeoutMs: number,
  pidRegistry?: PidRegistry
): Promise<{ response: AcpSessionResponse | null; timedOut: boolean }>
```

1. Start prompt: `session.prompt(prompt)`
2. Race against timeout: `Promise.race([promptPromise, timeoutPromise])`
3. If timeout wins → `session.cancelActivePrompt()` (best-effort), return `{ response: null, timedOut: true }`
4. If prompt wins → return `{ response, timedOut: false }`
5. PID registry: register before prompt, unregister after (if provided)

**Note:** PID registry integration depends on whether `AcpSession` exposes a PID.
If not available via createClient API, skip PID registry (log a debug message).

### `closeAcpSession()`

```typescript
async function closeAcpSession(session: AcpSession): Promise<void>
```

- Call `session.close()` wrapped in try/catch (best-effort, swallow errors)
- Log warning on failure

### Sidecar Persistence (unchanged from v1)

File: `nax/features/<feature>/acp-sessions.json`

```json
{
  "ST-001": "nax-a1b2c3d4-string-toolkit-ST-001"
}
```

Functions (file I/O, transport-agnostic):
- `saveAcpSession(workdir, featureName, storyId, sessionName)` — persist name
- `readAcpSession(workdir, featureName, storyId)` → `string | null` — read name
- `clearAcpSession(workdir, featureName, storyId)` — remove entry

---

## `_runWithClient()` — Main Session Runner

```typescript
private async _runWithClient(options: AgentRunOptions, startTime: number): Promise<AgentResult> {
  const client = _acpAdapterDeps.createClient(cmdStr);
  await client.start();

  // 1. Resolve session name
  let sessionName = options.acpSessionName;
  if (!sessionName && options.featureName && options.storyId) {
    sessionName = await readAcpSession(options.workdir, options.featureName, options.storyId) ?? undefined;
  }
  sessionName ??= buildSessionName(options.workdir, options.featureName, options.storyId, options.sessionRole);

  // 2. Resolve permission mode from options
  const permissionMode = options.dangerouslySkipPermissions ? "approve-all" : "default";

  // 3. Ensure session (create or resume)
  const session = await ensureAcpSession(client, sessionName, this.name, permissionMode);

  // 4. Persist for plan→run continuity
  if (options.featureName && options.storyId) {
    await saveAcpSession(options.workdir, options.featureName, options.storyId, sessionName);
  }

  try {
    // 5. Multi-turn loop
    let currentPrompt = options.prompt;
    let turnCount = 0;
    const MAX_TURNS = options.interactionBridge ? 10 : 1;
    let lastResponse: AcpSessionResponse | null = null;
    let timedOut = false;
    const totalTokenUsage = { input_tokens: 0, output_tokens: 0 };

    while (turnCount < MAX_TURNS) {
      turnCount++;
      getSafeLogger()?.debug("acp-adapter", `Session turn ${turnCount}/${MAX_TURNS}`, { sessionName });

      const turnResult = await runSessionPrompt(
        session, currentPrompt, options.timeoutSeconds * 1000, options.pidRegistry
      );

      if (turnResult.timedOut) { timedOut = true; break; }
      lastResponse = turnResult.response;
      if (!lastResponse) break;

      // Accumulate token usage
      if (lastResponse.cumulative_token_usage) {
        totalTokenUsage.input_tokens += lastResponse.cumulative_token_usage.input_tokens ?? 0;
        totalTokenUsage.output_tokens += lastResponse.cumulative_token_usage.output_tokens ?? 0;
      }

      // Check for question → route to interaction bridge
      const outputText = extractOutput(lastResponse);
      const question = extractQuestion(outputText);
      if (!question || !options.interactionBridge) break;

      // Route question with timeout
      try {
        const answer = await Promise.race([
          options.interactionBridge.onQuestionDetected(question),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("interaction timeout")), INTERACTION_TIMEOUT_MS)
          ),
        ]);
        currentPrompt = answer;
      } catch {
        break; // Interaction failed or timed out
      }
    }

    // Build result
    // ...
  } finally {
    // 6. Cleanup
    await closeAcpSession(session);
    if (options.featureName && options.storyId) {
      await clearAcpSession(options.workdir, options.featureName, options.storyId);
    }
  }
}
```

---

## Permission Mode

### Rule

`permissionMode` MUST follow `options.dangerouslySkipPermissions`:

| `dangerouslySkipPermissions` | `permissionMode` |
|:--|:--|
| `true` | `"approve-all"` |
| `false` / undefined | `"default"` |

### Affected locations

| Location | v1 behavior | v2 behavior |
|:--|:--|:--|
| `_runWithClient()` `createSession()` | Hardcoded `"approve-all"` | Map from `options.dangerouslySkipPermissions` |
| `complete()` `createSession()` | Hardcoded `"approve-all"` | Map from `_options?.dangerouslySkipPermissions` |
| `plan()` calling `run()` | Hardcoded `dangerouslySkipPermissions: true` | Pass through from `options` or config |

---

## Timeout

### Per-turn timeout

Each session turn gets `options.timeoutSeconds * 1000` ms as its timeout.
`options.timeoutSeconds` should come from the caller, ultimately from
`config.execution.sessionTimeoutSeconds`.

### `plan()` timeout

`plan()` currently hardcodes `timeoutSeconds: 600`. Change to:
```typescript
timeoutSeconds: options.timeoutSeconds ?? config.execution.sessionTimeoutSeconds ?? 600,
```

### Human interaction wait

Separate from agent timeout: `INTERACTION_TIMEOUT_MS = 5 * 60 * 1000` (5 min).
Human wait time does NOT count against agent timeout.

---

## `complete()` — One-Shot (No Session Name)

```typescript
async complete(prompt: string, _options?: CompleteOptions): Promise<string> {
  const client = _acpAdapterDeps.createClient(cmdStr);
  await client.start();

  const permissionMode = _options?.dangerouslySkipPermissions ? "approve-all" : "default";
  const session = await client.createSession({
    agentName: this.name,
    permissionMode,
    // No sessionName — ephemeral
  });

  try {
    const response = await session.prompt(prompt);
    // ... extract text, handle errors ...
  } finally {
    await session.close().catch(() => {});
  }
}
```

No session naming, no sidecar persistence, no multi-turn. Pure one-shot.

---

## `plan()` — Shared Session via `run()`

```typescript
async plan(options: PlanOptions): Promise<PlanResult> {
  const result = await this.run({
    prompt: options.prompt,
    workdir: options.workdir,
    modelTier: options.modelTier ?? "balanced",
    modelDef: modelDef,
    timeoutSeconds: options.timeoutSeconds ?? 600,
    dangerouslySkipPermissions: options.dangerouslySkipPermissions ?? false,
    interactionBridge: options.interactionBridge,
    featureName: options.featureName,
    storyId: options.storyId,
    sessionRole: options.sessionRole,
  });
  // ... extract specContent ...
}
```

The session name created during `plan()` is persisted to the sidecar file.
When `run()` is called later for the same feature/story, it reads the sidecar
and resumes the same session (via `ensureAcpSession` → `loadSession`).

---

## AgentRunOptions — Updated Fields

```typescript
// In types.ts:
interface AgentRunOptions {
  // ... existing fields ...
  acpSessionName?: string;   // Explicit session name (overrides derived name)
  featureName?: string;      // For session name: nax-<hash>-<feature>-<story>
  storyId?: string;          // For session name: nax-<hash>-<feature>-<story>
  sessionRole?: string;      // For TDD isolation: "test-writer" | "implementer" | "verifier"
}
```

---

## What Gets Removed

| Item | Reason |
|:--|:--|
| `_runSessionMode()` | Replaced by `_runWithClient()` with lifecycle layer |
| `_runOnce()` | `complete()` uses createClient directly |
| Old `ensureAcpSession()` (spawn: `acpx sessions ensure`) | Replaced by createClient-based version |
| Old `runSessionPrompt()` (spawn: `acpx prompt -s`) | Replaced by `session.prompt()` wrapper |
| Old `closeAcpSession()` (spawn: `acpx sessions close`) | Replaced by `session.close()` wrapper |
| `buildAcpxExecCommand()` | No longer used (was for spawn exec mode) |
| `buildAllowedEnv()` export | No longer needed (createClient handles env) |
| `withProcessTimeout` import | No longer used |
| `streamJsonRpcEvents` import | No longer used (was for _runOnce streaming) |
| `parseAcpxJsonOutput` import | No longer used (was for spawn output parsing) |

---

## Error Handling

| Scenario | Behaviour |
|:--|:--|
| `loadSession` returns null | Fall back to `createSession` |
| `createSession` fails | Throw → retry logic in `run()` handles it |
| Turn times out | `timedOut=true`, cancel prompt, close session, return result |
| Turn response has `stopReason: "error"` | Return `success: false` |
| Rate limit detected | Throw → outer retry loop with exponential backoff |
| Max turns (10) reached | Close session, return last output |
| Human answer timeout (5 min) | Break loop, close session, return partial result |
| `session.close()` fails | Log warn, ignore — best-effort only |
| `cancelActivePrompt()` fails | Catch, try `session.close()` instead |

---

## Testing

Existing test file: `test/unit/agents/acp/adapter-session.test.ts`

Tests mock `_acpAdapterDeps.createClient` to return a mock `AcpClient` that
creates mock `AcpSession` objects. All lifecycle functions are exercised through
the public API (`run()`, `plan()`, `complete()`).

### New/updated test cases needed

- Session name contains cwd hash, feature, story, role
- `buildSessionName()` unit tests with various inputs
- `loadSession` called first, fallback to `createSession`
- `permissionMode` follows `dangerouslySkipPermissions`
- `plan()` passes `timeoutSeconds` from options (not hardcoded 600)
- `plan()` passes `sessionRole` through to `run()`
- Sidecar persistence: save on session create, read on resume, clear on close
- TDD roles produce different session names

---

## Files to Change

| File | Change |
|:-----|:-------|
| `src/agents/acp/adapter.ts` | Rewrite lifecycle functions, remove spawn helpers, update `_runWithClient`, `complete`, `plan` |
| `src/agents/types.ts` | Add `sessionRole?` to `AgentRunOptions` (if not already present) |
| `test/unit/agents/acp/adapter-session.test.ts` | Add tests for new session naming, lifecycle, permission mode |
| `docs/specs/acp-session-mode.md` | This file (v2) |

---

## Out of Scope

- Session resume across nax restarts beyond sidecar file (future)
- Multiple concurrent sessions per story (not needed)
- `acpx sessions list` for orphan cleanup (future ops tooling)
- PID registry via createClient (depends on AcpSession exposing PID — deferred)
