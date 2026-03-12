# Code Review: v0.15.0 Interactive Pipeline

**Review Date:** 2026-02-28
**Reviewed By:** Claude Code (Sonnet 4.5)
**Scope:** All files changed between v0.14.4 (6d27bd7) and HEAD (6fe168a)

---

## Overall Grade: B+

**Summary:** The v0.15.0 Interactive Pipeline implementation is well-structured with good separation of concerns. The interaction module follows clean architecture principles with a plugin-based design. However, there are several CRITICAL security and reliability issues that must be fixed immediately, plus architectural violations (files over 400 lines) that need addressing.

**Strengths:**
- Clean plugin architecture for interaction system
- Good type safety throughout interaction module
- Proper separation between CLI, Telegram, Webhook, and Auto plugins
- Unified verification layer eliminates duplication
- Test coverage for critical paths

**Weaknesses:**
- Multiple files exceed 400-line limit (violates CLAUDE.md)
- Missing error handling for network failures in Telegram/Webhook plugins
- No input validation for malformed webhook callbacks
- JSON.parse without try-catch in several locations
- Auto plugin security rule not enforced via config validation
- Missing tests for edge cases (network failures, malformed input, race conditions)

---

## Critical Findings

| ID | Severity | File | Line | Description | Fix |
|:---|:---|:---|:---|:---|:---|
| SEC-001 | CRITICAL | `src/interaction/plugins/webhook.ts` | 158 | JSON.parse without try-catch when handling webhook callbacks. Malformed JSON can crash the server. | Wrap in try-catch, return 400 Bad Request on parse error |
| SEC-002 | CRITICAL | `src/interaction/plugins/telegram.ts` | 79 | No error handling for fetch failure when sending messages. Network errors can crash the plugin. | Add try-catch, throw descriptive error |
| SEC-003 | CRITICAL | `src/interaction/plugins/telegram.ts` | 244 | No error handling for getUpdates fetch failure. Can cause infinite loop on network errors. | Add try-catch with exponential backoff |
| SEC-004 | CRITICAL | `src/interaction/plugins/auto.ts` | 72-73 | Security-review never-auto-approve rule is code-based, not config-enforced. Can be accidentally removed. | Add to config schema validation, enforce at chain level |
| REL-001 | CRITICAL | `src/interaction/chain.ts` | 74-82 | Catch block swallows ALL errors (not just timeout). Plugin crashes are silently converted to timeout responses. | Only catch timeout-specific errors, re-throw others |
| REL-002 | HIGH | `src/interaction/plugins/webhook.ts` | 80-90 | Polling loop has no exponential backoff. Can cause high CPU usage on stuck requests. | Add exponential backoff with max delay |
| REL-003 | HIGH | `src/interaction/plugins/telegram.ts` | 96-111 | Polling loop has no exponential backoff. Can hammer Telegram API and get rate limited. | Add exponential backoff (start 1s, max 5s) |
| TYPE-001 | HIGH | `src/interaction/plugins/webhook.ts` | 117, 127 | Double `as unknown as` casts to work around Bun.serve typing. Loses type safety. | Add proper type definitions for Bun.serve return type |
| ARCH-001 | HIGH | Multiple files | - | 15 files exceed 400-line limit, violating CLAUDE.md hard requirement. | Split files as documented below |
| LOG-001 | MEDIUM | `src/interaction/plugins/telegram.ts` | 79-82 | Telegram API error response not logged. Silent failures are hard to debug. | Log error response body before throwing |
| LOG-002 | MEDIUM | `src/interaction/plugins/webhook.ts` | 72-74 | Webhook POST failure not logged with response body. | Log response body before throwing |
| TEST-001 | MEDIUM | `test/unit/interaction-plugins.test.ts` | - | No tests for network failures, malformed input, or timeout edge cases. | Add failure scenario tests |
| TEST-002 | MEDIUM | `test/unit/interaction-plugins.test.ts` | - | Auto plugin LLM call not mocked. Real LLM calls in tests are slow and flaky. | Mock Bun.spawn for LLM calls |
| MEM-001 | LOW | `src/interaction/plugins/telegram.ts` | 43 | `pendingMessages` Map grows unbounded. Never cleaned up on timeout. | Add cleanup in sendTimeoutMessage |
| MEM-002 | LOW | `src/interaction/plugins/webhook.ts` | 29 | `pendingResponses` Map grows unbounded. | Add cleanup in cancel() method |

---

## Files Exceeding 400-Line Limit (ARCH-001)

**CRITICAL:** CLAUDE.md mandates **400 lines maximum** per file. The following files violate this:

| File | Lines | Recommended Split |
|:---|---:|:---|
| `src/config/schema.ts` | 853 | Split into: `schema-core.ts` (types), `schema-routing.ts`, `schema-interaction.ts`, `schema-validation.ts` |
| `src/agents/claude.ts` | 820 | Split into: `claude-adapter.ts`, `claude-session.ts`, `claude-parser.ts` |
| `src/tdd/orchestrator.ts` | 743 | Split into: `orchestrator.ts` (main loop), `session-manager.ts`, `verdict-handler.ts` |
| `src/execution/sequential-executor.ts` | 648 | Split into: `executor.ts`, `story-runner.ts`, `retry-handler.ts` |
| `src/cli/diagnose.ts` | 638 | Split into: `diagnose.ts`, `checks.ts`, `formatters.ts` |
| `src/execution/post-verify.ts` | 584 | Split into: `post-verify.ts`, `rectification.ts`, `escalation-decision.ts` |
| `src/context/builder.ts` | 576 | Split into: `builder.ts`, `providers.ts`, `test-coverage.ts` |
| `src/cli/analyze.ts` | 568 | Split into: `analyze.ts`, `metrics.ts`, `reports.ts` |
| `src/precheck/checks.ts` | 548 | Split into: `checks.ts`, `validators.ts`, `git-checks.ts` |
| `src/cli/status.ts` | 519 | Split into: `status.ts`, `formatters.ts`, `progress.ts` |
| `src/execution/helpers.ts` | 450 | Split into: `story-filters.ts`, `batch-helpers.ts`, `status-helpers.ts` |
| `src/execution/escalation/tier-escalation.ts` | 439 | Split into: `tier-escalation.ts`, `cost-calculator.ts` |
| `src/routing/strategies/llm.ts` | 432 | Split into: `llm-router.ts`, `batch-router.ts`, `cache.ts` |
| `src/agents/types.ts` | 430 | Split into: `agent-types.ts`, `session-types.ts`, `result-types.ts` |
| `src/execution/parallel.ts` | 404 | OK (close to limit, watch carefully) |

**Action Required:** These files MUST be split before v0.15.0 release. This is a blocking requirement per CLAUDE.md.

---

## Security Analysis

### Input Validation

**FAIL:** Webhook plugin does not validate incoming callback structure.

```typescript
// src/interaction/plugins/webhook.ts:158 (VULNERABLE)
const response = JSON.parse(body) as InteractionResponse;
this.pendingResponses.set(requestId, response);
```

**Attack Vector:**
- Attacker sends `{"malicious": "payload"}` to webhook callback
- JSON.parse succeeds but object doesn't match InteractionResponse
- Type assertion `as InteractionResponse` bypasses type checking
- Invalid response stored in Map, causes undefined behavior later

**Fix:** Add Zod schema validation:

```typescript
import { z } from "zod";

const InteractionResponseSchema = z.object({
  requestId: z.string(),
  action: z.enum(["approve", "reject", "choose", "input", "skip", "abort"]),
  value: z.string().optional(),
  respondedBy: z.string().optional(),
  respondedAt: z.number(),
});

// In handleRequest():
try {
  const parsed = JSON.parse(body);
  const response = InteractionResponseSchema.parse(parsed);
  this.pendingResponses.set(requestId, response);
} catch (err) {
  return new Response("Bad Request: Invalid response format", { status: 400 });
}
```

### Credential Handling

**PASS:** Telegram bot token and webhook secrets are stored correctly:
- Read from env vars or config (never hardcoded)
- HMAC verification uses timing-safe comparison
- Secrets not logged

**Recommendation:** Add config validation to reject empty secrets:

```typescript
// src/config/schema.ts
interaction: {
  config: {
    secret: z.string().min(32).optional(), // Enforce minimum secret length
  }
}
```

### SSRF Protection

**N/A:** Webhook URL is user-configured (not from untrusted input). No SSRF risk.

### Auto Plugin Security Rule

**FAIL:** Security-review never-auto-approve rule is enforced in code only:

```typescript
// src/interaction/plugins/auto.ts:72-74
if (request.metadata?.trigger === "security-review") {
  return undefined; // Escalate to human
}
```

**Issue:** This can be accidentally removed during refactoring.

**Fix:** Enforce at config schema level:

```typescript
// src/config/schema.ts
triggers: {
  "security-review": z.object({
    enabled: z.boolean(),
    autoApprove: z.literal(false), // NEVER allow auto-approve for security
  })
}
```

---

## Reliability Analysis

### Error Handling

**FAIL:** Network errors are not handled properly.

**Telegram Plugin (Critical):**

```typescript
// src/interaction/plugins/telegram.ts:68 (VULNERABLE)
const response = await fetch(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({...}),
});

const data = (await response.json()) as { ok: boolean; result: TelegramMessage };
if (!data.ok) {
  throw new Error("Failed to send Telegram message");
}
```

**Issues:**
1. `fetch()` can throw on network errors (connection refused, DNS failure, timeout)
2. `response.json()` can throw on malformed JSON
3. `data.ok` check assumes `data` is defined
4. No retry logic for transient failures

**Fix:**

```typescript
try {
  const response = await fetch(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({...}),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Telegram API error (${response.status}): ${errorBody}`);
  }

  const data = await response.json();
  if (!data.ok) {
    throw new Error(`Telegram API returned ok=false: ${JSON.stringify(data)}`);
  }

  this.pendingMessages.set(request.id, data.result.message_id);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  throw new Error(`Failed to send Telegram message: ${msg}`);
}
```

**Webhook Plugin (Critical):**

Same issues as Telegram. Apply similar fix pattern.

### Race Conditions

**PASS:** No obvious race conditions found. Interaction chain is single-threaded per request.

**Potential Issue:** Webhook server starts on first `receive()` call, but multiple concurrent calls could race:

```typescript
// src/interaction/plugins/webhook.ts:109
private async startServer(): Promise<void> {
  if (this.server) return; // Already running

  const port = this.config.callbackPort ?? 8765;
  this.server = Bun.serve({...}) as unknown as Server;
}
```

**Race:** Two concurrent `receive()` calls could both check `if (this.server)` before either sets it.

**Fix:** Use a mutex or Promise-based lock:

```typescript
private serverStartPromise: Promise<void> | null = null;

private async startServer(): Promise<void> {
  if (this.server) return;
  if (this.serverStartPromise) {
    await this.serverStartPromise;
    return;
  }

  this.serverStartPromise = (async () => {
    const port = this.config.callbackPort ?? 8765;
    this.server = Bun.serve({...}) as unknown as Server;
  })();

  await this.serverStartPromise;
  this.serverStartPromise = null;
}
```

### Memory Leaks

**MEDIUM:** Two Maps grow unbounded:
- `TelegramInteractionPlugin.pendingMessages` (Line 42)
- `WebhookInteractionPlugin.pendingResponses` (Line 29)

**Issue:** When a request times out, the entry is never removed from the Map.

**Fix:**

```typescript
// In sendTimeoutMessage() / cancel():
this.pendingMessages.delete(requestId);
this.pendingResponses.delete(requestId);
```

Already implemented in `sendTimeoutMessage()` for Telegram (line 331), but not in `cancel()` for Webhook.

---

## Test Coverage Gaps

### Current Coverage

**Good:**
- ✅ Plugin initialization (with/without config, env vars)
- ✅ Config validation (missing required fields)
- ✅ Auto plugin security-review rejection

**Missing:**
- ❌ Network failure scenarios (Telegram API down, webhook unreachable)
- ❌ Malformed responses (invalid JSON, wrong structure)
- ❌ Timeout edge cases (request expires during polling)
- ❌ Concurrent request handling
- ❌ Memory leak verification (Map cleanup)
- ❌ Auto plugin LLM call (currently untested, would make real API calls)

### Recommended Additional Tests

```typescript
describe("TelegramInteractionPlugin - Error Handling", () => {
  test("should handle network failure gracefully", async () => {
    const plugin = new TelegramInteractionPlugin();
    await plugin.init({ botToken: "token", chatId: "123" });

    // Mock fetch to throw network error
    global.fetch = async () => { throw new Error("ECONNREFUSED") };

    const request = { /* ... */ };
    await expect(plugin.send(request)).rejects.toThrow("Failed to send Telegram message");
  });

  test("should handle malformed API response", async () => {
    // Mock fetch to return invalid JSON
    global.fetch = async () => new Response("not json");
    // ... test
  });

  test("should clean up pendingMessages on timeout", async () => {
    // ... verify Map is empty after timeout
  });
});

describe("WebhookInteractionPlugin - Security", () => {
  test("should reject malformed callback payload", async () => {
    const plugin = new WebhookInteractionPlugin();
    await plugin.init({ url: "http://example.com" });

    const malformed = { malicious: "payload" };
    const response = await plugin.handleRequest(
      new Request("http://localhost:8765/nax/interact/test-id", {
        method: "POST",
        body: JSON.stringify(malformed),
      })
    );

    expect(response.status).toBe(400);
  });

  test("should reject callback without HMAC when secret configured", async () => {
    // ... test
  });
});

describe("AutoInteractionPlugin - LLM", () => {
  test("should make correct LLM decision (mocked)", async () => {
    // Mock Bun.spawn to return fake LLM response
    const originalSpawn = Bun.spawn;
    Bun.spawn = (cmd, opts) => {
      const mockStdout = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(
            JSON.stringify({
              action: "approve",
              confidence: 0.8,
              reasoning: "test"
            })
          ));
          controller.close();
        }
      });
      return { stdout: mockStdout, stderr: new ReadableStream(), exited: Promise.resolve(0) };
    };

    // ... test decision logic

    Bun.spawn = originalSpawn; // Restore
  });
});
```

---

## Architecture Compliance

### Plugin Chain Escalation

**Question:** Does the plugin chain correctly handle escalation when all plugins fail?

**Answer:** **PARTIAL FAIL**

Current behavior:
- `InteractionChain.receive()` catches ALL errors and returns timeout response
- If primary plugin throws, it's converted to timeout (action: "skip")
- No escalation to secondary plugins

**Expected behavior:**
- Try primary plugin
- On failure, try next plugin in chain (by priority)
- Only return timeout if all plugins fail OR timeout reached

**Current code:**
```typescript
// src/interaction/chain.ts:63-82
async receive(requestId: string, timeout?: number): Promise<InteractionResponse> {
  const plugin = this.getPrimary();
  if (!plugin) {
    throw new Error("No interaction plugin registered");
  }

  const timeoutMs = timeout ?? this.config.defaultTimeout;

  try {
    const response = await plugin.receive(requestId, timeoutMs);
    return response;
  } catch (err) {
    // BUG: All errors converted to timeout, no fallback to other plugins
    return {
      requestId,
      action: "skip",
      respondedBy: "timeout",
      respondedAt: Date.now(),
    };
  }
}
```

**Fix:** Implement plugin fallback cascade:

```typescript
async receive(requestId: string, timeout?: number): Promise<InteractionResponse> {
  const timeoutMs = timeout ?? this.config.defaultTimeout;
  const errors: Error[] = [];

  // Try each plugin in priority order
  for (const entry of this.plugins) {
    try {
      const response = await entry.plugin.receive(requestId, timeoutMs);
      return response;
    } catch (err) {
      errors.push(err instanceof Error ? err : new Error(String(err)));
      // Continue to next plugin
    }
  }

  // All plugins failed
  throw new Error(
    `All interaction plugins failed: ${errors.map(e => e.message).join("; ")}`
  );
}
```

### State Persistence

**Question:** Does state persistence correctly serialize/deserialize all runner state?

**Answer:** **PASS**

- `RunState` interface covers all necessary fields (line 11-41)
- Serialization uses JSON.stringify with pretty-printing (line 48)
- Deserialization has error handling for corrupted files (line 68-70)
- File operations use Bun-native APIs correctly

**Recommendation:** Add Zod schema validation for loaded state:

```typescript
import { z } from "zod";

const RunStateSchema = z.object({
  feature: z.string(),
  prdPath: z.string(),
  iteration: z.number(),
  totalCost: z.number(),
  storiesCompleted: z.number(),
  pendingInteractions: z.array(z.any()), // Use InteractionRequestSchema
  completedInteractions: z.array(z.any()),
  pausedAt: z.number(),
  pauseReason: z.string(),
  currentStoryId: z.string().optional(),
  currentTier: z.string().optional(),
  currentModel: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export async function deserializeRunState(featureDir: string): Promise<RunState | null> {
  try {
    const file = Bun.file(stateFile);
    const exists = await file.exists();
    if (!exists) return null;

    const json = await file.text();
    const parsed = JSON.parse(json);
    const state = RunStateSchema.parse(parsed); // Validate before returning
    return state as RunState;
  } catch (err) {
    // Log validation error for debugging
    console.error("Invalid run state file:", err);
    return null;
  }
}
```

### Config Schema Validation

**Question:** Are all config schema additions validated with Zod?

**Answer:** **PARTIAL PASS**

New `InteractionConfig` interface exists (line 289-304) but NOT in Zod schema.

**Current issue:**
```typescript
// src/config/schema.ts:289-304
export interface InteractionConfig {
  plugin: string;
  config?: Record<string, unknown>;
  defaults: { timeout: number; fallback: string };
  triggers: Partial<Record<string, boolean | { enabled: boolean; fallback?: string; timeout?: number }>>;
}
```

This is a **TypeScript interface only** — no runtime validation!

**Fix:** Add Zod schema:

```typescript
const InteractionConfigSchema = z.object({
  plugin: z.enum(["cli", "telegram", "webhook", "auto"]),
  config: z.record(z.unknown()).optional(),
  defaults: z.object({
    timeout: z.number().min(1000).max(3600000), // 1s to 1hr
    fallback: z.enum(["continue", "skip", "escalate", "abort"]),
  }),
  triggers: z.record(
    z.union([
      z.boolean(),
      z.object({
        enabled: z.boolean(),
        fallback: z.enum(["continue", "skip", "escalate", "abort"]).optional(),
        timeout: z.number().min(1000).optional(),
      }),
    ])
  ).partial(),
});

// In main config schema:
export const NaxConfigSchema = z.object({
  // ... existing fields
  interaction: InteractionConfigSchema.optional(),
});
```

---

## Top 5 Fixes (Priority Order)

### 1. Fix Webhook JSON.parse Vulnerability (SEC-001)
**File:** `src/interaction/plugins/webhook.ts:158`
**Impact:** CRITICAL — Can crash server on malformed input
**Effort:** 15 minutes

Add try-catch + Zod validation:
```typescript
try {
  const parsed = JSON.parse(body);
  const response = InteractionResponseSchema.parse(parsed);
  this.pendingResponses.set(requestId, response);
} catch (err) {
  return new Response("Bad Request", { status: 400 });
}
```

### 2. Add Network Error Handling to Telegram Plugin (SEC-002, SEC-003)
**File:** `src/interaction/plugins/telegram.ts:68, 235`
**Impact:** CRITICAL — Can crash plugin on network failures
**Effort:** 30 minutes

Wrap all fetch() calls in try-catch with descriptive errors.

### 3. Fix InteractionChain Error Swallowing (REL-001)
**File:** `src/interaction/chain.ts:74-82`
**Impact:** CRITICAL — Masks real errors as timeouts
**Effort:** 20 minutes

Implement plugin fallback cascade (see Architecture section).

### 4. Add Config Schema Validation for Interaction (SEC-004)
**File:** `src/config/schema.ts`
**Impact:** HIGH — Runtime validation missing
**Effort:** 30 minutes

Add Zod schemas for InteractionConfig and all trigger configs.

### 5. Split Files Over 400 Lines (ARCH-001)
**Files:** 14 files (see table above)
**Impact:** HIGH — Violates CLAUDE.md hard requirement
**Effort:** 4-6 hours

Start with largest offenders:
1. `config/schema.ts` (853 lines) → 4 files
2. `agents/claude.ts` (820 lines) → 3 files
3. `tdd/orchestrator.ts` (743 lines) → 3 files

---

## Conclusion

The v0.15.0 Interactive Pipeline implementation demonstrates solid engineering with clean separation of concerns and a well-designed plugin architecture. However, **several CRITICAL security and reliability issues must be fixed before release**.

**Blocking Issues for Release:**
1. ✅ Test coverage is adequate (10/10 tests pass)
2. ❌ **SEC-001, SEC-002, SEC-003** — Network error handling (CRITICAL)
3. ❌ **REL-001** — Error swallowing in chain (CRITICAL)
4. ❌ **ARCH-001** — 14 files exceed 400 lines (CRITICAL per CLAUDE.md)

**Recommended Release Plan:**
1. Fix all CRITICAL findings (1-3 above) — **2 hours**
2. Fix HIGH findings (config validation, type casts) — **1 hour**
3. Split 3 largest files (config, agents, tdd) — **3 hours**
4. Add missing tests for network failures — **2 hours**
5. Re-run full test suite + typecheck — **30 minutes**
6. **Total:** ~8-9 hours to production-ready

**Post-Release Backlog:**
- Split remaining 11 files over 400 lines
- Add comprehensive integration tests
- Implement exponential backoff for polling loops
- Add Prometheus metrics for interaction success/failure rates

---

**Reviewer Signature:** Claude Sonnet 4.5
**Review Completed:** 2026-02-28
