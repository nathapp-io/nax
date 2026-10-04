# S3-4 — The agent session facade — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `createAgentSession`, a conversational session API for embedders. It provides multi-turn chat with streamed `SessionEvent`s, embedder-supplied tools, approvals and questions answered through `session.answer()`, per-session tool profiles (`none` / `read` / `full`), cancellation, and an injected `TranscriptStore`. It is layered over the S1 `AgentSessionAdapter`, and nax's behaviour does not change.

**Architecture:**
- The facade is a set of small modules in `packages/nax-agent/src/session/`. Each one has a single job:
  - options validation
  - an event channel with coalescing and a stall cap
  - a pending-ask table with deadlines
  - an `AskLink` that raises approvals to the person
  - profile-to-tool resolution with the sandbox floor
  - an `InteractionHandler` that routes embedder tools, built-in coding tools and questions
  - a per-turn runner
  - the session object itself
- It drives one `NativeSessionAdapter` per session through the S1 contract only:
  - `openSession` with `transcriptStore` + `retainOnClose`
  - `sendTurn` with `onTurnEvent`, `codingTools`, `signal` and `maxInteractions`
  - `closeSession`
- Two small backend changes come first:
  - a new optional `OpenSessionOpts.systemPrompt`, carried as nax-ai's top-level `system` request field, which is how `instructions` reaches the model;
  - the bounded tool-input redaction carried from the S3-3 final review.

**Tech Stack:** TypeScript 7.0.2, Bun 1.4 (bun:test), zod `^4.3.6` (already a nax-agent dependency), `@nathapp/nax-ai@0.1.16` (pinned; `ClientRequest.system` already exists, so no nax-ai release is needed).

**Spec:** `docs/superpowers/specs/2026-10-03-s3-conversational-session-api-design.md`. The relevant sections are §4.1-§4.6 (public API, events, profiles), §5.1 (the facade), §6.1-§6.3 (approvals, host ports, security floor), §7 (errors), §8 (tests) and §9 row S3-4. `resumeAgentSession`, `interrupted`, README/CHANGELOG, the Node contract cases and the packed smoke are S3-5 (spec §9).

**Base:** `main` @ `76e135064` (S3-3 merged, #2345). Branch `feat/s3-4-facade`. One PR.

## Global Constraints

- **nax behaviour is unchanged.** nax never sets `systemPrompt`, `onTurnEvent`, `transcriptStore` or `retainOnClose`. Its `TurnResult`, stream-bus events, transcript bytes, cost rows and tool-audit records must stay identical to `main`. Task 2 changes only what an `onTurnEvent` sink receives, and nax sets none.
- **Dependency direction** is `nax-ai` → `nax-agent` → `nax`.
  - `@nathapp/nax-ai` is importable in nax-agent only from `src/native/` and `src/cost/standard-types.ts` (`check:nax-ai-imports`).
  - New files under `src/session/` must not import `@nathapp/nax-ai`. Type imports from `#src/...` modules that re-export nax-ai types (for example `#src/cost/standard-types` for `TokenUsage`) are fine.
- **Node built-ins only.** nax-agent ships zero Bun APIs (`check:no-bun-apis`), so `src/` uses `node:` built-ins only.
- **Every thrown error is a `NaxError`** (`check-nax-error`). The facade's public errors are `AgentSessionError`, a `NaxError` subclass. Internal turn-level reasons use `NaxError` directly.
- **Public names (`.`).**
  - Names on `.` are explicitly named (no `export *`), and no `_` name is allowed.
  - `/internal` is unstable and holds the `_agentSessionDeps` seam.
  - After every task that changes exports, run `bun run check:api`, then `bun run api:update`, and commit `api/nax-agent.api.txt`. Additions only.
- **Coverage:** 80% overall and 80% per file, with an empty baseline (`bun run test:coverage`). Every new `src/` file needs a test that imports it (`--require-all-files`).
- **Size and complexity.**
  - Source files must be at most 600 lines and test files at most 800 (`check-file-sizes`). `src/session/session-types.ts` is already long: put new types in new files.
  - Complexity ratchet: cognitive complexity of at most 20 per function (`check-complexity`). After any task that touches `src/`, run `bun ../repo-tooling/scripts/check-complexity.ts --package=.`.
  - Baselined hot spots this plan must not grow: `sendTurn` 21 and `runToolBatch` 59.
  - `openNativeSession` and the adapter's `complete` closure are near the limit. Task 1 adds no branch to either and puts the branching in helpers.
- **Commands.** Never run bare `bun test` or `bun run nax`. Run package scripts from the package directory (`cd packages/nax-agent`). To run a single test file: `bun test ./test/unit/<path>.test.ts --timeout=60000`.
- **Test rules.**
  - Escape-hatch ratchet: the regex `\bas\s+[A-Z]\w*` counts test text, test names included, as a loose cast. Use typed declarations, and keep test names clear of "as <Capitalised>". `as const` and lower-case `as number` are fine.
  - Tests do not sleep. Timers go through `_agentSessionDeps`, which tests replace with a manual scheduler. A test that needs one macrotask turn uses `await new Promise((resolve) => setImmediate(resolve))`.
  - Do not name test files after stories (`check:test-satellites`).
- **Style.** No emojis. Conventional commit messages (`feat:`, `refactor:`, `test:`, `docs:`).
- **macOS shell:** `sed -i ''`. Use a `for` loop over `grep -rl` output instead of piping into `xargs`.

## Review Focus

1. **A `sessionId` shaped like a path** (`../escape`, `a/b`, an empty string, or 200 characters) with a file-backed `TranscriptStore` (`<dir>/<id>.transcript.json`). Expected: `createAgentSession` throws `AGENT_SESSION_INVALID_OPTIONS` before any store call. No file is created outside the store directory. Pinned in Task 4.
2. **An embedder tool whose `run` waits on its `signal` while the person cancels.** Expected:
   - `ctx.signal` aborts and `turn_end.status` is `"cancelled"`;
   - the session accepts a new `send` once that `turn_end` has been delivered;
   - a late resolution of the abandoned `run` changes nothing.
   
   Pinned in Task 10.
3. **Racy and wrong `answer()` calls.** Expected:
   - An answer after the deadline returns `"expired"`.
   - A second answer to an id the person already settled returns `"expired"`.
   - An answer to a cancelled request returns `"cancelled"`.
   - A `{ text }` reply to an approval throws `AGENT_SESSION_INVALID_ANSWER`, and so does an id never issued.
   - Any answer after `close()` returns `"unknown"`.
   
   Pinned in Task 6 (table) and Task 10 (through a live turn).
4. **A consumer that calls `send()` again from inside its `for await` body the moment it sees `turn_end`.** Expected: the call succeeds, because the session releases its single-flight slot before it emits `turn_end`. Pinned in Task 9.
5. **A consumer that breaks out of the `for await` mid-turn, then calls `send()` straight away.** Expected:
   - the immediate call throws `AGENT_SESSION_BUSY`, because the abandoned turn is still draining;
   - after it settles, a new `send` works;
   - the transcript holds the first turn's user message.
   
   Pinned in Task 10.

## Deviations from the spec (decided while planning)

- **`instructions` reaches the model as nax-ai's top-level `system` field.**
  - The spec names the option but not how it gets to the model. nax-ai's `ConversationMessage` has no system role; `ClientRequest.system` exists and each protocol places it correctly (Anthropic's `system` parameter, OpenAI's system message).
  - Task 1 adds an optional `OpenSessionOpts.systemPrompt`. The native adapter sends it on every round-trip request, but not on the compaction summary. nax sets none. ACP ignores it until S4.
- **Embedder tools are routed by the facade's `InteractionHandler`, not by the runtime's `extraTools` + grant (spec §4.3).**
  - The facade appends a descriptor-only `CodingTool` per embedder tool to `SendTurnOpts.codingTools`, so the model sees it. The loop sends calls to it as `coding-tool` requests, and the handler runs the embedder's `run` itself.
  - This is the one place that has `toolCallId` and the turn signal (`ToolRunContext` carries neither).
  - It keeps embedder tools out of the path policy, which has no fields to check for them anyway.
  - It avoids `extraTools` letting a tool shadow a built-in name, since `createCodingToolRuntime` resolves `extra.get(name)` first and checks no reserved list. The facade validates names itself (Task 4).
- **Tool failures become `isError` results by throwing from the handler.**
  - This covers embedder `isError: true`, an embedder `run` that throws, and a built-in `CodingToolOutcome` of kind `"error"`.
  - `AdapterInteractionResponse` has no error flag. `runToolBatch` already turns a handler throw into a tool result with the thrown message as content and `isError: true` (`turn-tool-batch.ts:300-315`), so no loop change is needed.
  - Side effect: the spin breaker does not note the result for those calls (its `noteResult` sits on the success path), which matches how nax's tool errors already behave.
- **The approval's `callId` for built-in tools comes from a per-session "current call" slot.**
  - `AskRequest` has no `toolCallId`. The batch runs calls one at a time, so the handler records the id before it calls `runtime.callTool` and clears it after.
  - Embedder approvals pass the id directly.
- **Deferred: `hostPorts.runDeclaredCommand`.** `RunCommand` is built only from a declared-command catalogue (`declaredCommands`), which the spec's option set does not carry. Under `full`, the facade offers Write, Edit, Delete and Bash, plus GitCommit when `hostPorts.protectedPaths.gitIgnorePatterns` is non-empty. RunCommand is carried to S3-5 with a catalogue option.
- **No cross-session client cache (spec §5.1).**
  - A session with `catalogOverrides` or `credentials` builds and owns one client (`ownClient: true`, about 50 ms each).
  - A session with neither shares nax-agent's process memo (`getNativeClient([])`), the same as an adapter built without options.
  - A cache can follow if profiling asks for it.
- **The default protected-paths policy uses only the configured credentials slot's directory.**
  - A session without `credentials` gets `credentialDir = credentialsConfig().configDir()` when `configureCredentials` was called, and none otherwise.
  - Memory and exec sources report no directory, because neither has one on disk.
  - The spec said "exec reports its directory"; it has none.
- **`unshowable` asks emit no events.** They are denied with `decidedBy: "unshowable"` (the link's outcome, which reaches the model as the denial text). No request id is issued, because there is nothing to show.
- **`answer()` keeps every request id for the session's lifetime.**
  - The spec says `"expired"` / `"cancelled"` for "an id settled earlier in the current or last turn". Keeping all ids means an id from any earlier turn gets the same answer rather than a throw, which is still "never issued → throw".
  - A repeat answer to an id the person already settled returns `"expired"`.
- **A second iteration of one `send()` iterable throws `AGENT_SESSION_BUSY`.** The spec says the iterable is single-use but names no code.
- **`turn_end.error.code`:**
  - `AdapterFailure.outcome` for provider faults (for example `"fail-auth"`, `"fail-rate-limit"`);
  - the `NaxError` code for nax-agent errors, including a throwing store (`TRANSCRIPT_CORRUPT`, and so on);
  - `AGENT_SESSION_CONSUMER_STALLED` for the cap;
  - `AGENT_SESSION_TURN_FAILED` otherwise.
- **`AgentSessionError` is a public class.** `NaxError` is not on `.`, so embedders get a typed `code` (`AgentSessionErrorCode`) from this subclass.
- **The control-event cap (1000) and the timers go through `_agentSessionDeps` on `/internal`,** so tests can lower the cap and fire deadlines without sleeping.
- **`workdir` is optional for `none`.** When it is absent, the facade creates a private temporary root for the scratchpad (`buildCodingToolSupport` requires a root) and removes it on `close()`.
- **`AgentSession.lastTurn` is a required `| undefined` property, not an optional one.** The session class implements it as a getter, and under `exactOptionalPropertyTypes` a getter of type `X | undefined` does not satisfy `lastTurn?: X`. An embedder reads it the same way.
- **The `ask_human` budget is fixed at 10 per turn (`ASK_HUMAN_BUDGET`).** This is nax's `agent.maxInteractionTurns` default. The spec only requires it to be above zero.
- **Rules for `bashApproval` and `allowUnsandboxed`:**
  - Both are rejected with `AGENT_SESSION_INVALID_OPTIONS` outside `full`.
  - `allowUnsandboxed: true` requires `bashApproval: "gated"`; spec §6.3 only honours it with gated.
- **Turn deadline.** The facade arms its own timer at `turnTimeoutSeconds` and passes the same value as the adapter's `timeoutSeconds`.
  - When the timer fires, it aborts the turn signal. That ends a pending question, which carries no signal of its own.
  - It marks the turn `timed_out`.
  - A `TurnResult` with `timedOut: true` from the adapter also maps to `timed_out`.
- **Carried from S3-3** (Task 2): `tool_call.input` redaction is bounded. String values are cut to the redaction scan size before `redactSecrets` walks the input, so a multi-MB `Write` no longer runs the patterns over megabytes.
- **Carried from S3-3 and S3-1** (Task 11): the spec is amended to match what shipped:
  - §5.4: the event deviations;
  - §5.5: `retainFailed(sessionId)` takes no document;
  - §4.3: embedder-tool routing.
  
  The S3-1 file-store prune limitation (a `retainOnClose` session should not share a file-store directory with sessions that close failed) is already on the `retainOnClose` doc. It is restated on `CreateAgentSessionOptions.transcriptStore`.

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `packages/nax-agent/src/session/session-types.ts` | Modify | `OpenSessionOpts.systemPrompt` |
| `packages/nax-agent/src/native/session/session.ts` | Modify | `systemPrompts` state map, `recordSystemPrompt`, `systemFieldFor` |
| `packages/nax-agent/src/native/session-adapter.ts` | Modify | Send `system` on round-trip requests |
| `packages/nax-agent/test/unit/native/session-adapter-system-prompt.test.ts` | Create | Task 1 tests |
| `packages/nax-agent/src/native/session/turn-event-emitter.ts` | Modify | `capStrings` before redaction |
| `packages/nax-agent/test/unit/native/session/turn-event-emitter-input-cap.test.ts` | Create | Task 2 tests |
| `packages/nax-agent/src/session/agent-session-errors.ts` | Create | `AgentSessionError`, `AgentSessionErrorCode` |
| `packages/nax-agent/src/session/agent-session-types.ts` | Create | Public facade types and `SessionEvent` |
| `packages/nax-agent/src/index.ts` | Modify | Export facade types, loop-handler types, interceptor types, then `createAgentSession` |
| `packages/nax-agent/src/internal.ts` | Modify | `export * from "#src/session/agent-session-deps"` |
| `packages/nax-agent/api/nax-agent.api.txt` | Modify | `api:update` |
| `packages/nax-agent/test/unit/session/agent-session-errors.test.ts` | Create | Task 3 tests |
| `packages/nax-agent/src/session/agent-session-deps.ts` | Create | `_agentSessionDeps` seam (clock, timers, ids, scratch root, control cap) |
| `packages/nax-agent/src/session/agent-session-options.ts` | Create | zod validation and defaults |
| `packages/nax-agent/test/unit/session/agent-session-options.test.ts` | Create | Task 4 tests |
| `packages/nax-agent/src/session/session-event-channel.ts` | Create | Push-to-pull channel, coalescing, stall cap, single consumer |
| `packages/nax-agent/test/unit/session/session-event-channel.test.ts` | Create | Task 5 tests |
| `packages/nax-agent/src/session/pending-asks.ts` | Create | Request ids, deadlines, `answer` statuses |
| `packages/nax-agent/src/session/session-ask-link.ts` | Create | `askPerson`, `createSessionAskLink`, `createSessionAskResolver` |
| `packages/nax-agent/test/unit/session/pending-asks.test.ts` | Create | Task 6 tests |
| `packages/nax-agent/test/unit/session/session-ask-link.test.ts` | Create | Task 6 tests |
| `packages/nax-agent/src/session/session-tool-support.ts` | Create | Profile → declared tools and grants; protected-paths default; sandbox floor |
| `packages/nax-agent/test/unit/session/session-tool-support.test.ts` | Create | Task 7 tests |
| `packages/nax-agent/src/session/session-interaction.ts` | Create | Embedder descriptor, routing handler |
| `packages/nax-agent/test/unit/session/session-interaction.test.ts` | Create | Task 8 tests |
| `packages/nax-agent/src/session/agent-session-turn.ts` | Create | `claimTurn`, the per-turn runner, `turn_end` mapping |
| `packages/nax-agent/src/session/agent-session.ts` | Create | `createAgentSession`, the session object |
| `packages/nax-agent/test/helpers/agent-session.ts` | Create | Scripted client, manual timers, event readers |
| `packages/nax-agent/test/unit/session/agent-session-chat.test.ts` | Create | Task 9 tests |
| `packages/nax-agent/test/unit/session/agent-session-asks.test.ts` | Create | Task 10 tests |
| `docs/superpowers/specs/2026-10-03-s3-conversational-session-api-design.md` | Modify | Task 11 amendments |

---

### Task 1: `OpenSessionOpts.systemPrompt` reaches every round-trip request

**Files:**
- Modify: `packages/nax-agent/src/session/session-types.ts` (inside `OpenSessionOpts`, after `retainOnClose`)
- Modify: `packages/nax-agent/src/native/session/session.ts` (`NativeSessionState`, `createNativeSessionState`, `openNativeSession`, `clearNativeSessionState`, two new helpers)
- Modify: `packages/nax-agent/src/native/session-adapter.ts` (the import from `./session/session.ts`; `sendTurn`)
- Test: `packages/nax-agent/test/unit/native/session-adapter-system-prompt.test.ts`

**Interfaces:**
- Produces: `OpenSessionOpts.systemPrompt?: string`. Task 9 sets it from `instructions`.
- Produces: `systemFieldFor(state: NativeSessionState, sessionName: string): { readonly system?: string }`, exported from `native/session/session.ts`.

- [ ] **Step 1: Write the failing test**

Create `packages/nax-agent/test/unit/native/session-adapter-system-prompt.test.ts`:

```ts
/**
 * S3-4: OpenSessionOpts.systemPrompt reaches every round-trip request as
 * nax-ai's top-level `system`. A session opened without one sends none, and
 * the prompt is forgotten on close.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client, ClientRequest, ProtocolEvent, ResolvedModel } from "@nathapp/nax-ai";
import { _clientDeps, _resetNativeClient } from "#src/native/client";
import { NativeSessionAdapter, nativeSessionStateOf } from "#src/native/session-adapter";
import type { OpenSessionOpts } from "#src/session/session-types";
import type { CodingTool } from "#src/tools/registry";

const REAL_BUILD = _clientDeps.build;
afterEach(() => {
  _clientDeps.build = REAL_BUILD;
  _resetNativeClient();
});

const model: ResolvedModel = {
  id: "gpt-5.4-mini",
  provider: "openai",
  protocol: "openai-responses",
  pricing: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  supportsTools: true,
  thinkingLevels: [],
};

const TOOL_ROUND: ProtocolEvent[] = [
  { type: "tool-call", call: { id: "c1", name: "Read", input: { path: "a.ts" } } },
  { type: "usage", usage: { inputTokens: 4, outputTokens: 2 } },
  { type: "done", stopReason: "tool_use" },
];
const TEXT_ROUND: ProtocolEvent[] = [
  { type: "text-delta", text: "done" },
  { type: "usage", usage: { inputTokens: 6, outputTokens: 1 } },
  { type: "done", stopReason: "stop" },
];

function recordingClient(requests: ClientRequest[]): Client {
  return {
    model: async () => model,
    listModels: async () => [model],
    pricing: () => model.pricing,
    stream(_model, req) {
      requests.push(req);
      const events = requests.length === 1 ? TOOL_ROUND : TEXT_ROUND;
      return (async function* replay() {
        yield* events;
      })();
    },
    complete: async () => {
      throw new Error("round trips must stream");
    },
    validate: () => {},
  };
}

const fakeRead: CodingTool = {
  name: "Read",
  description: "read a file",
  inputSchema: { type: "object" },
  scope: { pathFields: ["path"] },
  async run() {
    return { content: "contents" };
  },
};

async function openOpts(extra: Partial<OpenSessionOpts>): Promise<OpenSessionOpts> {
  const dir = await mkdtemp(join(tmpdir(), "nax-system-prompt-"));
  return {
    agentName: "native",
    workdir: dir,
    transcriptDir: dir,
    timeoutSeconds: 60,
    resolvedPermissions: { mode: "approve-all", bashApproval: "raw" },
    modelDef: { provider: "unknown", model: "openai/gpt-5.4-mini" },
    ...extra,
  };
}

async function turnWith(extra: Partial<OpenSessionOpts>): Promise<ClientRequest[]> {
  const requests: ClientRequest[] = [];
  _resetNativeClient();
  _clientDeps.build = async () => recordingClient(requests);
  const adapter = new NativeSessionAdapter();
  const handle = await adapter.openSession("system-prompt", await openOpts(extra));
  await adapter.sendTurn(handle, "read a.ts", {
    interactionHandler: { onInteraction: async () => ({ answer: "contents" }) },
    codingTools: [fakeRead],
  });
  await adapter.closeSession(handle);
  return requests;
}

describe("OpenSessionOpts.systemPrompt", () => {
  test("is sent as `system` on every round-trip request", async () => {
    const requests = await turnWith({ systemPrompt: "You are terse." });
    expect(requests).toHaveLength(2);
    expect(requests.map((req) => req.system)).toEqual(["You are terse.", "You are terse."]);
  });

  test("a session opened without one sends no `system` key", async () => {
    const requests = await turnWith({});
    expect(requests).toHaveLength(2);
    expect(requests.some((req) => "system" in req)).toBe(false);
  });

  test("close forgets the prompt; reopening the same name without one sends none", async () => {
    _resetNativeClient();
    _clientDeps.build = async () => recordingClient([]);
    const adapter = new NativeSessionAdapter();
    const first = await adapter.openSession("reused", await openOpts({ systemPrompt: "first" }));
    expect(nativeSessionStateOf(adapter).systemPrompts.get("reused")).toBe("first");
    await adapter.closeSession(first);
    expect(nativeSessionStateOf(adapter).systemPrompts.has("reused")).toBe(false);
    await adapter.openSession("reused", await openOpts({}));
    expect(nativeSessionStateOf(adapter).systemPrompts.has("reused")).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/nax-agent && bun test ./test/unit/native/session-adapter-system-prompt.test.ts --timeout=60000`
Expected: FAIL. `bun test` does not typecheck, so all three tests run:
- The first fails because `req.system` is undefined.
- The second passes.
- The third fails because `systemPrompts` is undefined on the state.

- [ ] **Step 3: Add the option to `OpenSessionOpts`**

In `packages/nax-agent/src/session/session-types.ts`, insert directly after the `retainOnClose?: boolean;` member of `OpenSessionOpts`:

```ts
  /**
   * Native: the session's system prompt, sent as the request's top-level
   * `system` on every round trip (not on the compaction summary). The S3
   * facade sets it from `instructions`; nax leaves it unset. ACP ignores it.
   */
  systemPrompt?: string;
```

- [ ] **Step 4: Store it per session and expose the request field**

In `packages/nax-agent/src/native/session/session.ts`:

1. In `interface NativeSessionState`, after the `lastUsage` member, add:

```ts

  /**
   * Session name -> the system prompt sent as each round trip's top-level
   * `system` (S3-4; the facade's `instructions`). nax opens without one. Same
   * lifecycle as the maps above: set on open, cleared on close.
   */
  readonly systemPrompts: Map<string, string>;
```

2. In `createNativeSessionState()`, after `lastUsage: new Map(),`, add `systemPrompts: new Map(),`.

3. Directly above `export async function openNativeSession(`, add:

```ts
/**
 * Records, or clears, the session's system prompt at open. A helper so that
 * openNativeSession gains no branch.
 */
function recordSystemPrompt(state: NativeSessionState, name: string, systemPrompt: string | undefined): void {
  if (systemPrompt === undefined) state.systemPrompts.delete(name);
  else state.systemPrompts.set(name, systemPrompt);
}

/** The request field for the session's system prompt: `{ system }`, or `{}` when it has none. */
export function systemFieldFor(state: NativeSessionState, sessionName: string): { readonly system?: string } {
  const system = state.systemPrompts.get(sessionName);
  return system === undefined ? {} : { system };
}
```

4. In `openNativeSession`, directly after the two `transcriptOwners` lines (`if (opts.transcriptOwner !== undefined) ... else state.transcriptOwners.delete(name);`), add:

```ts
  recordSystemPrompt(state, name, opts.systemPrompt);
```

5. In `clearNativeSessionState`, after `state.lastUsage.delete(sessionName);`, add `state.systemPrompts.delete(sessionName);`.

- [ ] **Step 5: Send it from the adapter**

In `packages/nax-agent/src/native/session-adapter.ts`:

1. Add `systemFieldFor` to the import from `./session/session.ts`, keeping the names sorted:

```ts
import {
  closeNativeSession,
  createNativeSessionState,
  markNativeTurnOutcome,
  type NativeSessionState,
  openNativeSession,
  systemFieldFor,
} from "./session/session.ts";
```

2. In `sendTurn`, directly after `const sessionId = nativeSessionId(handle.id);`, add:

```ts
    // S3-4: the session's system prompt (facade `instructions`), or `{}`.
    // Resolved here so the `complete` closure spreads it without a branch.
    const systemField = systemFieldFor(this.state, handle.id);
```

3. In the `complete` closure's `streamComplete(client, resolved, { ... })` request object, directly after `sessionId,`, add `...systemField,`. Do not change the `summarize` closure: a summary is not a conversation turn.

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd packages/nax-agent && bun test ./test/unit/native/session-adapter-system-prompt.test.ts --timeout=60000`
Expected: PASS (3 tests).

- [ ] **Step 7: Run the native suites, typecheck and the gates**

Run: `cd packages/nax-agent && bun test ./test/unit/native/ --timeout=60000 && bun run typecheck && bun ../repo-tooling/scripts/check-complexity.ts --package=. && bun run check:all`
Expected: all pass. Complexity reports no growth for `sendTurn` or `openNativeSession`.

- [ ] **Step 8: Commit**

```bash
git add packages/nax-agent/src/session/session-types.ts packages/nax-agent/src/native/session/session.ts packages/nax-agent/src/native/session-adapter.ts packages/nax-agent/test/unit/native/session-adapter-system-prompt.test.ts
git commit -m "feat(nax-agent): OpenSessionOpts.systemPrompt sent as the request system field"
```

---

### Task 2: Bound the redaction scan of `tool_call.input` (S3-3 carry)

**Files:**
- Modify: `packages/nax-agent/src/native/session/turn-event-emitter.ts` (`cappedInput`, new `capStrings`)
- Test: `packages/nax-agent/test/unit/native/session/turn-event-emitter-input-cap.test.ts`

**Interfaces:** none new. `TurnEvent` shapes are unchanged.

- [ ] **Step 1: Write the failing test**

Create `packages/nax-agent/test/unit/native/session/turn-event-emitter-input-cap.test.ts`:

```ts
/**
 * S3-4 (carried from the S3-3 final review): `tool_call.input` redaction must
 * not walk megabytes. String values are cut to the redaction scan size before
 * `redactSecrets` runs, and key-named secrets are still masked.
 */
import { describe, expect, test } from "bun:test";
import type { ToolCall } from "@nathapp/nax-ai";
import { createTurnEventEmitter, TOOL_CALL_INPUT_BYTES } from "#src/native/session/turn-event-emitter";
import type { TurnEvent } from "#src/session/turn-event";

function toolCallInput(input: Record<string, unknown>): unknown {
  const events: TurnEvent[] = [];
  const call: ToolCall = { id: "c1", name: "Write", input };
  createTurnEventEmitter((event) => events.push(event)).toolCall(call, undefined);
  const first = events[0];
  if (first?.type !== "tool_call") throw new Error("expected a tool_call event");
  return first.input;
}

describe("tool_call.input redaction bound", () => {
  test("a multi-MB string is cut before redaction; the key-named secret is still masked", () => {
    const input = toolCallInput({ path: "big.txt", content: "x".repeat(2_000_000), apiKey: "plainsecret" });
    expect(input).toMatchObject({ truncated: true });
    const preview = (input as { preview: string }).preview;
    expect(Buffer.byteLength(preview, "utf8")).toBeLessThanOrEqual(TOOL_CALL_INPUT_BYTES);
    expect(preview).not.toContain("plainsecret");
  });

  test("a small input keeps its structure, with secret-named keys masked", () => {
    const input = toolCallInput({ path: "a.ts", apiKey: "plainsecret" });
    expect(input).toEqual({ path: "a.ts", apiKey: "[REDACTED]" });
  });

  test("a large input that holds a secret-named key masks it in the preview", () => {
    const input = toolCallInput({ apiKey: "plainsecret", content: "y".repeat(100_000) });
    const preview = (input as { preview: string }).preview;
    expect(preview).toContain("[REDACTED]");
    expect(preview).not.toContain("plainsecret");
  });

  test("a cyclic input does not recurse forever", () => {
    const cyclic: Record<string, unknown> = { path: "a.ts" };
    cyclic.self = cyclic;
    expect(() => toolCallInput(cyclic)).not.toThrow();
  });
});
```

The `(input as { preview: string })` casts start with a lower-case `{` and pass the escape-hatch regex.

> The bound itself (no redactor pass over megabytes) is not observable without a production seam, and adding one for this is not worth it. These tests pin the behaviour around it: the size cap, masking of a secret-named key on both paths, and cycles. The diff shows the bound.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/nax-agent && bun test ./test/unit/native/session/turn-event-emitter-input-cap.test.ts --timeout=60000`
Expected: the size and masking tests already PASS before the change, because today's code redacts the whole input and then truncates. They are regression pins, not RED tests. The cyclic test passes or fails depending on `redactSecrets`'s own cycle guard; either is fine before the change. This task is a bounded refactor of an internal step, so a RED phase is not required. Confirm the tests stay green after Step 3.

- [ ] **Step 3: Implement `capStrings` and use it in `cappedInput`**

In `packages/nax-agent/src/native/session/turn-event-emitter.ts`, replace the whole `cappedInput` function with:

```ts
/**
 * A copy of `value` with every string cut to REDACTION_SCAN_BYTES, so the
 * redactor never walks a multi-MB `Write` content. Cycles become "[Circular]".
 */
function capStrings(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (typeof value === "string") return cutToByteCap(value, REDACTION_SCAN_BYTES);
  if (typeof value !== "object" || value === null) return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => capStrings(item, seen));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, capStrings(item, seen)]));
}

function cappedInput(input: unknown): unknown {
  const redacted = redactSecrets(capStrings(input));
  let json: string;
  try {
    json = JSON.stringify(redacted) ?? "null";
  } catch {
    return { truncated: true, preview: "[input not serializable]" };
  }
  if (Buffer.byteLength(json, "utf8") <= TOOL_CALL_INPUT_BYTES) return redacted;
  return { truncated: true, preview: cutToByteCap(json, TOOL_CALL_INPUT_BYTES) };
}
```

Then update the doc comment on `REDACTION_SCAN_BYTES` to: `/** Redaction scans at most this many bytes of a result, and of each string in a tool input; the preview keeps far fewer. */`.

A shared object reached twice without a cycle also becomes `"[Circular]"` on the second visit. That is acceptable for a display preview.

- [ ] **Step 4: Run the new and the existing emitter tests**

Run: `cd packages/nax-agent && bun test ./test/unit/native/session/turn-event-emitter-input-cap.test.ts ./test/unit/native/session/turn-event-emitter.test.ts --timeout=60000`
Expected: PASS. The existing redaction and pairing tests are unchanged.

- [ ] **Step 5: Gates and commit**

Run: `cd packages/nax-agent && bun run typecheck && bun ../repo-tooling/scripts/check-complexity.ts --package=. && bun run check:all`
Expected: pass.

```bash
git add packages/nax-agent/src/native/session/turn-event-emitter.ts packages/nax-agent/test/unit/native/session/turn-event-emitter-input-cap.test.ts
git commit -m "fix(nax-agent): bound the redaction scan of tool_call input"
```

---
### Task 3: Public errors, facade types and promoted loop and interceptor types

**Files:**
- Create: `packages/nax-agent/src/session/agent-session-errors.ts`
- Create: `packages/nax-agent/src/session/agent-session-types.ts`
- Modify: `packages/nax-agent/src/index.ts`
- Modify: `packages/nax-agent/api/nax-agent.api.txt` (`api:update`)
- Test: `packages/nax-agent/test/unit/session/agent-session-errors.test.ts`

**Interfaces:**
- Produces (used by every later task):
  - `AgentSessionError(message, code, context?)` with `code: AgentSessionErrorCode`;
  - the types `AgentSessionProfile`, `EmbedderTool`, `EmbedderToolContext`, `EmbedderToolResult`, `AgentSessionHostPorts`, `CreateAgentSessionOptions`, `TurnEndStatus`, `ApprovalDecidedBy`, `SessionEventBase`, `SessionEventBody`, `SessionEvent`, `AnswerReply`, `AnswerStatus` and `AgentSession`.

- [ ] **Step 1: Write the failing test**

Create `packages/nax-agent/test/unit/session/agent-session-errors.test.ts`:

```ts
/**
 * S3-4: the facade's public error. A NaxError subclass so nax-agent's own
 * `instanceof NaxError` checks keep working, with a typed code for embedders
 * (NaxError itself is not on `.`).
 */
import { describe, expect, test } from "bun:test";
import { AgentSessionError } from "@nathapp/nax-agent";
import { NaxError } from "#src/infra/nax-error";

describe("AgentSessionError", () => {
  test("is a NaxError with a typed code and the agent-session stage", () => {
    const err = new AgentSessionError("busy", "AGENT_SESSION_BUSY", { sessionId: "s1" });
    expect(err).toBeInstanceOf(NaxError);
    expect(err).toBeInstanceOf(AgentSessionError);
    expect(err.name).toBe("AgentSessionError");
    expect(err.code).toBe("AGENT_SESSION_BUSY");
    expect(err.message).toBe("busy");
    expect(err.context).toEqual({ stage: "agent-session", sessionId: "s1" });
  });

  test("context defaults to the stage alone", () => {
    expect(new AgentSessionError("x", "AGENT_SESSION_CLOSED").context).toEqual({ stage: "agent-session" });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/nax-agent && bun test ./test/unit/session/agent-session-errors.test.ts --timeout=60000`
Expected: FAIL. `AgentSessionError` is not exported from `@nathapp/nax-agent`; it is `undefined`, so the constructor call throws a `TypeError`.

- [ ] **Step 3: Create the error module**

Create `packages/nax-agent/src/session/agent-session-errors.ts`:

```ts
/**
 * The agent session facade's public error (S3 spec section 7). Every code is
 * namespaced AGENT_SESSION_* so it cannot collide with nax's SESSION_* codes
 * or registerCodingTool's TOOL_NAME_RESERVED.
 */
import { NaxError } from "#src/infra/nax-error";

export type AgentSessionErrorCode =
  | "AGENT_SESSION_INVALID_OPTIONS"
  | "AGENT_SESSION_EXISTS"
  | "AGENT_SESSION_BUSY"
  | "AGENT_SESSION_CLOSED"
  | "AGENT_SESSION_INVALID_ANSWER"
  | "AGENT_SESSION_NOT_FOUND"
  | "AGENT_SESSION_SCHEMA_UNSUPPORTED"
  | "AGENT_SESSION_MODEL_MISMATCH"
  | "AGENT_SESSION_SANDBOX_UNAVAILABLE"
  | "AGENT_SESSION_TOOL_NAME_RESERVED";

export class AgentSessionError extends NaxError {
  declare readonly code: AgentSessionErrorCode;

  constructor(message: string, code: AgentSessionErrorCode, context: Record<string, unknown> = {}) {
    super(message, code, { stage: "agent-session", ...context });
    this.name = "AgentSessionError";
  }
}
```

`NOT_FOUND`, `SCHEMA_UNSUPPORTED` and `MODEL_MISMATCH` are thrown by `resumeAgentSession` in S3-5. They are declared now so the public union does not change twice.

- [ ] **Step 4: Create the public types**

Create `packages/nax-agent/src/session/agent-session-types.ts`:

```ts
/**
 * Public types of the agent session facade (S3 spec section 4). The facade
 * drives the S1 AgentSessionAdapter; nothing here is backend-specific, so the
 * acpx backend (S4) reuses these types unchanged.
 */
import type { CommandInterceptor } from "#src/command-interceptor/index";
import type { BashApprovalMode } from "#src/config/bash-approval";
import type { TokenUsage } from "#src/cost/standard-types";
import type { NativeCatalogOverrides } from "#src/native/client";
import type { CredentialSource } from "#src/native/credentials/session-source";
import type { LoopHandlerSet } from "#src/native/session/loop-events/types";
import type { TranscriptStore } from "#src/native/session/transcript-types";
import type { ProtectedPathsPolicy } from "#src/tools/protected-paths";
import type { JSONSchema } from "./tool-descriptor.ts";

/** What the session's agent may touch. Capability statements, not tool lists (spec 4.5). */
export type AgentSessionProfile = "none" | "read" | "full";

export interface EmbedderToolContext {
  readonly sessionId: string;
  /** The provider's tool-call id: the same id as the `tool_call` / `tool_result` events. */
  readonly toolCallId: string;
  /** Aborts when the turn is cancelled, times out or the session closes. */
  readonly signal: AbortSignal;
}

export interface EmbedderToolResult {
  readonly content: string;
  readonly isError?: boolean;
}

/** An in-process tool the embedder supplies (spec 4.3). */
export interface EmbedderTool {
  /** The name the model sees. A letter, then letters, digits, `_` or `-`; at most 64 characters. */
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JSONSchema;
  /** `always` asks the person through `answer()` before every run. */
  readonly approval: "never" | "always";
  /** The approval summary. Default: the redacted, byte-capped JSON of the input. */
  describe?(input: unknown): string;
  /** A throw, or `isError: true`, reaches the model as an error result. */
  run(input: unknown, ctx: EmbedderToolContext): Promise<EmbedderToolResult>;
}

/** Host ports an embedder may supply (spec 6.2). */
export interface AgentSessionHostPorts {
  /** Paths the sandbox and the read tools deny. Default: the configured credentials directory, if any. */
  readonly protectedPaths?: ProtectedPathsPolicy;
  readonly commandInterceptor?: CommandInterceptor;
}

export interface CreateAgentSessionOptions {
  readonly backend: "native";
  /** The store key. Generated when absent. Letters, digits, `.`, `_`, `-`; starts with a letter or digit; at most 128 characters. */
  readonly sessionId?: string;
  /** `"provider/model"`, optionally with an `[effort]` suffix. */
  readonly model: string;
  readonly profile: AgentSessionProfile;
  /** An absolute directory. Required for `read` and `full`; `none` gets a private temporary root. */
  readonly workdir?: string;
  /** The embedder's system prompt. */
  readonly instructions?: string;
  readonly tools?: readonly EmbedderTool[];
  /**
   * Where the conversation lives. The session keeps its document on close, so
   * it can be resumed. A file store's failed-close prune counts every
   * transcript in its directory, so do not share a file-store directory with
   * sessions that are closed as failed.
   */
  readonly transcriptStore: TranscriptStore;
  /** How long an approval or question waits. Default 600000; 30000..3600000. */
  readonly approvalTimeoutMs?: number;
  /** `full` only. Default `"gated"`. */
  readonly bashApproval?: BashApprovalMode;
  /** `full` only, and only with `bashApproval: "gated"`: run without a sandbox when none is usable. */
  readonly allowUnsandboxed?: boolean;
  /** Falls back to the `configureCredentials` slot when absent. */
  readonly credentials?: CredentialSource;
  readonly catalogOverrides?: NativeCatalogOverrides;
  readonly loopHandlers?: LoopHandlerSet;
  readonly hostPorts?: AgentSessionHostPorts;
  /** Copied onto every event. */
  readonly metadata?: Readonly<Record<string, string>>;
  /** Per-turn wall clock. Default 3600; 1..86400. */
  readonly turnTimeoutSeconds?: number;
}

export type TurnEndStatus = "completed" | "cancelled" | "timed_out" | "interrupted" | "errored";

export type ApprovalDecidedBy = "human" | "timeout" | "cancelled" | "unavailable" | "unshowable";

export interface SessionEventBase {
  readonly sessionId: string;
  readonly turnId: string;
  /** ISO 8601. */
  readonly at: string;
  readonly metadata: Readonly<Record<string, string>>;
}

export type SessionEventBody =
  | { readonly type: "turn_start" }
  | { readonly type: "text_delta"; readonly round: number; readonly text: string }
  | { readonly type: "thinking_delta"; readonly round: number; readonly text: string }
  | { readonly type: "stream_reset"; readonly round: number; readonly attempt: number }
  | { readonly type: "tool_call"; readonly callId: string; readonly name: string; readonly input: unknown }
  | { readonly type: "tool_result"; readonly callId: string; readonly isError: boolean; readonly preview: string }
  | {
      readonly type: "approval_requested";
      readonly requestId: string;
      readonly callId?: string;
      readonly tool: string;
      readonly summary: string;
      readonly command?: string;
      readonly reason: string;
      readonly expiresAt: string;
    }
  | {
      readonly type: "approval_resolved";
      readonly requestId: string;
      readonly decision: "allow" | "deny";
      readonly decidedBy: ApprovalDecidedBy;
    }
  | { readonly type: "question"; readonly requestId: string; readonly text: string; readonly expiresAt: string }
  | {
      readonly type: "usage";
      readonly round: number;
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly cacheRead?: number;
      readonly cacheWrite?: number;
      readonly costUsd: number;
    }
  | { readonly type: "compaction"; readonly reason: "proactive" | "overflow" }
  | {
      readonly type: "turn_end";
      readonly status: TurnEndStatus;
      /** The final round's text, as `TurnResult.output`. Empty when the turn did not complete. */
      readonly output: string;
      readonly usage: TokenUsage;
      readonly costUsd: number;
      readonly error?: { readonly code: string; readonly message: string };
    };

/**
 * One event of a `send()` (spec 4.4). Deltas are provisional: the transcript
 * and `turn_end.output` are authoritative. `turn_end` is always last.
 */
export type SessionEvent = SessionEventBase & SessionEventBody;

export type AnswerReply = { readonly decision: "allow" | "deny" } | { readonly text: string };

export type AnswerStatus = "accepted" | "expired" | "cancelled" | "unknown";

export interface AgentSession {
  readonly id: string;
  /** Set after each `turn_end`; undefined before the first. */
  readonly lastTurn: { readonly turnId: string; readonly status: TurnEndStatus } | undefined;
  /** Claims the session's single turn slot synchronously; the turn starts on the first `next()`. */
  send(message: string): AsyncIterable<SessionEvent>;
  answer(requestId: string, reply: AnswerReply): AnswerStatus;
  /** Aborts the running turn; a no-op when none runs. */
  cancel(reason?: string): void;
  /** Idempotent. Cancels a running turn, waits for it, keeps the document in the store. */
  close(): Promise<void>;
}
```

- [ ] **Step 5: Export on `.`**

In `packages/nax-agent/src/index.ts`, add these blocks. Keep the file's order, which is alphabetical by module path:

1. Before the `#src/command-safety/index` block:

```ts
export type {
  CommandInterceptor,
  InterceptRequest,
  InterceptResult,
  ShellInterceptRequest,
  ShellInterceptResult,
} from "#src/command-interceptor/index";
```

2. After the `#src/native/session-adapter` block (`session-adapter` sorts before `session/` because `-` is below `/`):

```ts
export type {
  AfterResponsePatch,
  AfterResponsePayload,
  AfterToolPatch,
  AfterToolPayload,
  BeforeCompactionPatch,
  BeforeCompactionPayload,
  BeforeRequestPatch,
  BeforeRequestPayload,
  BeforeToolOutcome,
  BeforeToolPayload,
  BeforeTurnEndPatch,
  BeforeTurnEndPayload,
  BeforeTurnPatch,
  BeforeTurnPayload,
  CompleteCallOptions,
  ExternalHandlerOf,
  LoopEvent,
  LoopEventMap,
  LoopHandlerContext,
  LoopHandlerEntry,
  LoopHandlerSet,
  PatchOf,
  PayloadOf,
  TransformContextPatch,
  TransformContextPayload,
} from "#src/native/session/loop-events/types";
```

3. After the `#src/session/adapter-failure` line:

```ts
export { AgentSessionError, type AgentSessionErrorCode } from "#src/session/agent-session-errors";
export type {
  AgentSession,
  AgentSessionHostPorts,
  AgentSessionProfile,
  AnswerReply,
  AnswerStatus,
  ApprovalDecidedBy,
  CreateAgentSessionOptions,
  EmbedderTool,
  EmbedderToolContext,
  EmbedderToolResult,
  SessionEvent,
  SessionEventBase,
  SessionEventBody,
  TurnEndStatus,
} from "#src/session/agent-session-types";
```

The loop-handler names stay on `./internal` too, through its existing `export *`. A name exported from both entries is fine.

- [ ] **Step 6: Run the test, typecheck, lint and the API snapshot**

Run: `cd packages/nax-agent && bun test ./test/unit/session/agent-session-errors.test.ts --timeout=60000 && bun run typecheck && bun run lint:fix && bun run check:all && bun run check:api`
Expected:
- The test PASSES (2 tests), and typecheck and lint pass.
- `check:api` FAILS and lists the new `.` names: 45 type names (5 interceptor, 25 loop-handler, 14 facade, `AgentSessionErrorCode`) plus the `AgentSessionError` value.

Then run: `bun run api:update && bun run check:api`
Expected: PASS. Inspect the diff of `api/nax-agent.api.txt`: the `[.]` section gains exactly the names above, and nothing is removed.

- [ ] **Step 7: Commit**

```bash
git add packages/nax-agent/src/session/agent-session-errors.ts packages/nax-agent/src/session/agent-session-types.ts packages/nax-agent/src/index.ts packages/nax-agent/api/nax-agent.api.txt packages/nax-agent/test/unit/session/agent-session-errors.test.ts
git commit -m "feat(nax-agent): agent session public types and error; promote loop-handler types to the package entry"
```

---

### Task 4: The deps seam and option validation

**Files:**
- Create: `packages/nax-agent/src/session/agent-session-deps.ts`
- Create: `packages/nax-agent/src/session/agent-session-options.ts`
- Modify: `packages/nax-agent/src/internal.ts`
- Modify: `packages/nax-agent/api/nax-agent.api.txt` (`api:update`: `./internal` gains `_agentSessionDeps`)
- Test: `packages/nax-agent/test/unit/session/agent-session-options.test.ts`

**Interfaces:**
- Consumes: `AgentSessionError` and `CreateAgentSessionOptions` (Task 3).
- Produces:
  - `_agentSessionDeps`, with the members `now()`, `setTimeout(fn, ms): unknown`, `clearTimeout(handle: unknown)`, `randomUUID()`, `isDirectory(path): Promise<boolean>`, `makeScratchRoot(): Promise<string>`, `removeScratchRoot(dir): Promise<void>` and `controlEventCap: number`.
  - `resolveAgentSessionOptions(input: unknown): ResolvedAgentSessionOptions`.
  - The constants `DEFAULT_APPROVAL_TIMEOUT_MS = 600_000` and `DEFAULT_TURN_TIMEOUT_SECONDS = 3600`.
  - `ResolvedAgentSessionOptions`:

```ts
export interface ResolvedAgentSessionOptions {
  /** The caller's object, unchanged (tool objects keep their `this`). */
  readonly raw: CreateAgentSessionOptions;
  readonly provider: string;
  readonly approvalTimeoutMs: number;
  readonly turnTimeoutSeconds: number;
  readonly bashApproval: BashApprovalMode;
  readonly allowUnsandboxed: boolean;
  readonly metadata: Readonly<Record<string, string>>;
  readonly tools: readonly EmbedderTool[];
}
```

- [ ] **Step 1: Write the failing test**

Create `packages/nax-agent/test/unit/session/agent-session-options.test.ts`:

```ts
/**
 * S3-4: createAgentSession's option validation (spec 4.1, 7). zod checks the
 * shape; profile rules, reserved tool names and the model spec are checked
 * after it. The caller's objects are kept, never zod's copies, so an embedder
 * tool written as a class keeps its `this`.
 */
import { describe, expect, test } from "bun:test";
import type { EmbedderTool } from "@nathapp/nax-agent";
import { createMemoryTranscriptStore } from "#src/native/session/memory-transcript-store";
import {
  DEFAULT_APPROVAL_TIMEOUT_MS,
  DEFAULT_TURN_TIMEOUT_SECONDS,
  resolveAgentSessionOptions,
} from "#src/session/agent-session-options";
import { assertNaxError } from "#test/helpers/index";

const echo: EmbedderTool = {
  name: "echo",
  description: "echo the input",
  inputSchema: { type: "object" },
  approval: "never",
  async run(input) {
    return { content: JSON.stringify(input) };
  },
};

function base(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    backend: "native",
    model: "openai/gpt-5.4-mini",
    profile: "none",
    transcriptStore: createMemoryTranscriptStore(),
    ...extra,
  };
}

function rejects(input: unknown, code: string, fragment: string): void {
  let caught: unknown;
  try {
    resolveAgentSessionOptions(input);
  } catch (err) {
    caught = err;
  }
  assertNaxError(caught);
  expect(caught.code).toBe(code);
  expect(caught.message).toContain(fragment);
}

describe("resolveAgentSessionOptions", () => {
  test("applies the defaults and keeps the caller's objects", () => {
    const input = base({ tools: [echo] });
    const resolved = resolveAgentSessionOptions(input);
    expect(resolved.raw).toBe(input);
    expect(resolved.tools[0]).toBe(echo);
    expect(resolved.provider).toBe("openai");
    expect(resolved.approvalTimeoutMs).toBe(DEFAULT_APPROVAL_TIMEOUT_MS);
    expect(resolved.turnTimeoutSeconds).toBe(DEFAULT_TURN_TIMEOUT_SECONDS);
    expect(resolved.bashApproval).toBe("gated");
    expect(resolved.allowUnsandboxed).toBe(false);
    expect(resolved.metadata).toEqual({});
  });

  test("a class-based tool keeps `this`", async () => {
    class Counter implements EmbedderTool {
      readonly name = "count";
      readonly description = "count";
      readonly inputSchema = { type: "object" };
      readonly approval = "never" as const;
      private calls = 0;
      async run() {
        this.calls += 1;
        return { content: String(this.calls) };
      }
    }
    const tool = new Counter();
    const resolved = resolveAgentSessionOptions(base({ tools: [tool] }));
    const ctx = { sessionId: "s", toolCallId: "c", signal: new AbortController().signal };
    expect((await resolved.tools[0]?.run({}, ctx))?.content).toBe("1");
  });

  test.each([
    ["../escape"],
    ["a/b"],
    [""],
    [".hidden"],
    ["x".repeat(129)],
  ])("rejects the path-shaped or oversized sessionId %p before any store call", (sessionId) => {
    rejects(base({ sessionId }), "AGENT_SESSION_INVALID_OPTIONS", "sessionId");
  });

  test("accepts a 128-character id of letters, digits, dot, dash and underscore", () => {
    const sessionId = `a${"b._-9".repeat(25)}xy`;
    expect(sessionId).toHaveLength(128);
    expect(() => resolveAgentSessionOptions(base({ sessionId }))).not.toThrow();
  });

  test("rejects unknown keys (typos)", () => {
    rejects(base({ profle: "read" }), "AGENT_SESSION_INVALID_OPTIONS", "profle");
  });

  test("rejects the reserved mcpServers option, even when undefined", () => {
    rejects(base({ mcpServers: undefined }), "AGENT_SESSION_INVALID_OPTIONS", "mcpServers");
  });

  test("read and full need an absolute workdir", () => {
    rejects(base({ profile: "read" }), "AGENT_SESSION_INVALID_OPTIONS", "workdir");
    rejects(base({ profile: "full", workdir: "relative/dir" }), "AGENT_SESSION_INVALID_OPTIONS", "workdir");
  });

  test("bashApproval and allowUnsandboxed are full-only", () => {
    rejects(base({ bashApproval: "raw" }), "AGENT_SESSION_INVALID_OPTIONS", "bashApproval");
    rejects(base({ profile: "read", workdir: "/tmp", allowUnsandboxed: true }), "AGENT_SESSION_INVALID_OPTIONS", "allowUnsandboxed");
  });

  test("allowUnsandboxed needs bashApproval gated", () => {
    const full = { profile: "full", workdir: "/tmp", allowUnsandboxed: true };
    rejects(base({ ...full, bashApproval: "raw" }), "AGENT_SESSION_INVALID_OPTIONS", "allowUnsandboxed");
    expect(resolveAgentSessionOptions(base(full)).allowUnsandboxed).toBe(true);
  });

  test("approvalTimeoutMs and turnTimeoutSeconds are range-checked", () => {
    rejects(base({ approvalTimeoutMs: 29_999 }), "AGENT_SESSION_INVALID_OPTIONS", "approvalTimeoutMs");
    rejects(base({ approvalTimeoutMs: 3_600_001 }), "AGENT_SESSION_INVALID_OPTIONS", "approvalTimeoutMs");
    rejects(base({ turnTimeoutSeconds: 0 }), "AGENT_SESSION_INVALID_OPTIONS", "turnTimeoutSeconds");
    expect(resolveAgentSessionOptions(base({ approvalTimeoutMs: 30_000 })).approvalTimeoutMs).toBe(30_000);
  });

  test("a malformed model spec is an invalid option", () => {
    rejects(base({ model: "no-provider" }), "AGENT_SESSION_INVALID_OPTIONS", "model");
  });

  test("a transcriptStore missing markTurn is rejected", () => {
    const { markTurn: _dropped, ...partial } = createMemoryTranscriptStore();
    rejects(base({ transcriptStore: partial }), "AGENT_SESSION_INVALID_OPTIONS", "transcriptStore");
  });

  test.each([["Read"], ["Bash"], ["ScratchpadRead"], ["ask_human"]])("tool name %p is reserved", (name) => {
    rejects(base({ tools: [{ ...echo, name }] }), "AGENT_SESSION_TOOL_NAME_RESERVED", name);
  });

  test("duplicate and malformed tool names are invalid", () => {
    rejects(base({ tools: [echo, echo] }), "AGENT_SESSION_INVALID_OPTIONS", "echo");
    rejects(base({ tools: [{ ...echo, name: "has space" }] }), "AGENT_SESSION_INVALID_OPTIONS", "name");
  });

  test("a tool without run is invalid", () => {
    const { run: _dropped, ...noRun } = echo;
    rejects(base({ tools: [noRun] }), "AGENT_SESSION_INVALID_OPTIONS", "run");
  });

  test("a non-object input is invalid", () => {
    rejects(undefined, "AGENT_SESSION_INVALID_OPTIONS", "options");
  });
});
```

`assertNaxError(value, label?)` (`test/helpers/assert-nax-error.ts`) narrows `caught` to `NaxError`. Its second argument is a label, not a code, which is why the code is checked separately.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/nax-agent && bun test ./test/unit/session/agent-session-options.test.ts --timeout=60000`
Expected: FAIL with "Cannot find module '#src/session/agent-session-options'".

- [ ] **Step 3: Create the deps seam**

Create `packages/nax-agent/src/session/agent-session-deps.ts`:

```ts
/**
 * Injectable clock, timers, ids and filesystem for the agent session facade.
 * Tests replace members (paired with withDepsRestore) to fire deadlines
 * without sleeping and to lower the control-event cap. Exported on ./internal.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Undelivered control events a turn may queue before it is cancelled as stalled (spec 4.4). */
export const MAX_UNDELIVERED_CONTROL_EVENTS = 1000;

export const _agentSessionDeps = {
  now: (): number => Date.now(),
  setTimeout: (fn: () => void, ms: number): unknown => setTimeout(fn, ms),
  clearTimeout: (handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout>),
  randomUUID: (): string => randomUUID(),
  isDirectory: async (path: string): Promise<boolean> => {
    try {
      return (await stat(path)).isDirectory();
    } catch {
      return false;
    }
  },
  makeScratchRoot: (): Promise<string> => mkdtemp(join(tmpdir(), "nax-agent-session-")),
  removeScratchRoot: (dir: string): Promise<void> => rm(dir, { recursive: true, force: true }),
  controlEventCap: MAX_UNDELIVERED_CONTROL_EVENTS,
};
```

- [ ] **Step 4: Create the option resolver**

Create `packages/nax-agent/src/session/agent-session-options.ts`:

```ts
/**
 * Validates createAgentSession's options (spec 4.1, 7). zod checks the shape;
 * the result keeps the caller's own objects (zod returns copies, which would
 * detach a class-based tool's methods from `this`).
 */
import { isAbsolute } from "node:path";
import { z } from "zod";
import type { BashApprovalMode } from "#src/config/bash-approval";
import { parseNativeModel } from "#src/native/models";
import { ASK_HUMAN_TOOL_NAME } from "#src/native/session/ask-human";
import { RESERVED_TOOL_NAMES } from "#src/tools/registry";
import { AgentSessionError } from "./agent-session-errors.ts";
import type { CreateAgentSessionOptions, EmbedderTool } from "./agent-session-types.ts";

export const DEFAULT_APPROVAL_TIMEOUT_MS = 600_000;
export const DEFAULT_TURN_TIMEOUT_SECONDS = 3600;

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const STORE_METHODS = ["load", "save", "retainFailed", "delete", "markTurn"] as const;

export interface ResolvedAgentSessionOptions {
  /** The caller's object, unchanged (tool objects keep their `this`). */
  readonly raw: CreateAgentSessionOptions;
  readonly provider: string;
  readonly approvalTimeoutMs: number;
  readonly turnTimeoutSeconds: number;
  readonly bashApproval: BashApprovalMode;
  readonly allowUnsandboxed: boolean;
  readonly metadata: Readonly<Record<string, string>>;
  readonly tools: readonly EmbedderTool[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasMethods(names: readonly string[]): (value: unknown) => boolean {
  return (value) => isRecord(value) && names.every((name) => typeof value[name] === "function");
}

const isFunction = (value: unknown): boolean => typeof value === "function";

const EmbedderToolSchema = z.object({
  name: z.string().regex(TOOL_NAME, "must be a letter, then letters, digits, _ or -, at most 64 characters"),
  description: z.string().min(1),
  inputSchema: z.custom<Record<string, unknown>>(isRecord, "must be a JSON Schema object"),
  approval: z.enum(["never", "always"]),
  describe: z.custom(isFunction, "must be a function").optional(),
  run: z.custom(isFunction, "must be a function"),
});

const OptionsSchema = z.strictObject({
  backend: z.literal("native"),
  sessionId: z
    .string()
    .regex(SESSION_ID, "must be 1-128 letters, digits, '.', '_' or '-', starting with a letter or digit")
    .optional(),
  model: z.string().min(1),
  profile: z.enum(["none", "read", "full"]),
  workdir: z.string().refine((dir) => isAbsolute(dir), "must be an absolute path").optional(),
  instructions: z.string().optional(),
  tools: z.array(EmbedderToolSchema).optional(),
  transcriptStore: z.custom(hasMethods(STORE_METHODS), `must implement ${STORE_METHODS.join(", ")}`),
  approvalTimeoutMs: z.number().int().min(30_000).max(3_600_000).optional(),
  bashApproval: z.enum(["raw", "gated", "escalate"]).optional(),
  allowUnsandboxed: z.boolean().optional(),
  credentials: z
    .custom((value) => isRecord(value) && (value.kind === "memory" || value.kind === "exec"), "must be a memory or exec source")
    .optional(),
  catalogOverrides: z.array(z.custom(isRecord, "must be a catalog override object")).optional(),
  loopHandlers: z.array(z.custom(isRecord, "must be a loop handler entry")).optional(),
  hostPorts: z
    .strictObject({
      protectedPaths: z.custom(isRecord, "must be a protected-paths policy").optional(),
      commandInterceptor: z.custom(hasMethods(["intercept"]), "must implement intercept").optional(),
    })
    .optional(),
  metadata: z.record(z.string(), z.string()).optional(),
  turnTimeoutSeconds: z.number().int().min(1).max(86_400).optional(),
});

function invalid(message: string, context: Record<string, unknown> = {}): AgentSessionError {
  return new AgentSessionError(`Invalid agent session options: ${message}`, "AGENT_SESSION_INVALID_OPTIONS", context);
}

function checkShape(input: unknown): CreateAgentSessionOptions {
  if (isRecord(input) && "mcpServers" in input) {
    throw invalid("mcpServers is reserved for a later release (an MCP client for embedder tools)", { path: "mcpServers" });
  }
  const parsed = OptionsSchema.safeParse(input);
  if (parsed.success) return input as CreateAgentSessionOptions;
  const issue = parsed.error.issues[0];
  const path = issue === undefined || issue.path.length === 0 ? "options" : issue.path.join(".");
  throw invalid(`${path}: ${issue?.message ?? "invalid"}`, { path });
}

function checkProfileRules(options: CreateAgentSessionOptions): void {
  if (options.profile !== "none" && options.workdir === undefined) {
    throw invalid(`workdir is required for profile "${options.profile}"`, { path: "workdir" });
  }
  if (options.profile !== "full" && options.bashApproval !== undefined) {
    throw invalid('bashApproval applies to profile "full" only', { path: "bashApproval" });
  }
  if (options.profile !== "full" && options.allowUnsandboxed !== undefined) {
    throw invalid('allowUnsandboxed applies to profile "full" only', { path: "allowUnsandboxed" });
  }
  if (options.allowUnsandboxed === true && (options.bashApproval ?? "gated") !== "gated") {
    throw invalid('allowUnsandboxed requires bashApproval "gated"', { path: "allowUnsandboxed" });
  }
}

function checkToolNames(tools: readonly EmbedderTool[]): void {
  const reserved = new Set<string>([...RESERVED_TOOL_NAMES, ASK_HUMAN_TOOL_NAME]);
  const seen = new Set<string>();
  for (const tool of tools) {
    if (reserved.has(tool.name)) {
      throw new AgentSessionError(
        `Embedder tool name "${tool.name}" is reserved for a built-in tool`,
        "AGENT_SESSION_TOOL_NAME_RESERVED",
        { tool: tool.name },
      );
    }
    if (seen.has(tool.name)) throw invalid(`tools: duplicate tool name "${tool.name}"`, { path: "tools" });
    seen.add(tool.name);
  }
}

function providerOf(model: string): string {
  try {
    return parseNativeModel(model).provider;
  } catch {
    throw invalid(`model: "${model}" is not "provider/model[effort]"`, { path: "model" });
  }
}

export function resolveAgentSessionOptions(input: unknown): ResolvedAgentSessionOptions {
  const options = checkShape(input);
  checkProfileRules(options);
  const tools = options.tools ?? [];
  checkToolNames(tools);
  return {
    raw: options,
    provider: providerOf(options.model),
    approvalTimeoutMs: options.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS,
    turnTimeoutSeconds: options.turnTimeoutSeconds ?? DEFAULT_TURN_TIMEOUT_SECONDS,
    bashApproval: options.bashApproval ?? "gated",
    allowUnsandboxed: options.allowUnsandboxed === true,
    metadata: options.metadata ?? {},
    tools,
  };
}
```

If `bun run typecheck` rejects `input as CreateAgentSessionOptions` because the parse result is structurally unrelated, write it as `return input as unknown as CreateAgentSessionOptions;`. That is a `src/` file, so the escape-hatch test ratchet does not apply. It is the one sanctioned cast: zod has validated the shape, and the caller's object is kept on purpose.

- [ ] **Step 5: Export the seam on `./internal`**

In `packages/nax-agent/src/internal.ts`, add the line below next to the other `#src/...` re-exports. Keep the file's existing ordering, which is alphabetical by module path, so it goes among the `#src/session/` lines if any exist, otherwise after `#src/sandbox/index`:

```ts
export * from "#src/session/agent-session-deps";
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd packages/nax-agent && bun test ./test/unit/session/agent-session-options.test.ts --timeout=60000`
Expected: PASS. If a `rejects(...)` fragment assertion fails only because zod words its message differently, change the fragment, not the resolver. Every fragment above is a path or a name that the resolver puts in its message itself.

- [ ] **Step 7: Gates, API snapshot and commit**

Run: `cd packages/nax-agent && bun run typecheck && bun run lint:fix && bun run check:all`
Expected: pass.

Run: `bun run check:api`
Expected: FAIL. The `[./internal]` section is missing `MAX_UNDELIVERED_CONTROL_EVENTS` and `_agentSessionDeps`.

Run: `bun run api:update && bun run check:api`
Expected: PASS. The diff adds exactly those two names to `[./internal]`; `.` is unchanged.

```bash
git add packages/nax-agent/src/session/agent-session-deps.ts packages/nax-agent/src/session/agent-session-options.ts packages/nax-agent/src/internal.ts packages/nax-agent/api/nax-agent.api.txt packages/nax-agent/test/unit/session/agent-session-options.test.ts
git commit -m "feat(nax-agent): agent session option validation and deps seam"
```

---
### Task 5: The session event channel

**Files:**
- Create: `packages/nax-agent/src/session/session-event-channel.ts`
- Test: `packages/nax-agent/test/unit/session/session-event-channel.test.ts`

**Interfaces:**
- Consumes: `SessionEvent` (Task 3).
- Produces:

```ts
export interface SessionEventChannelOptions {
  readonly controlCap: number;
  readonly onFirstPull: () => void;
  readonly onReturn: () => void;
  readonly onStall: () => void;
}
export interface SessionEventChannel {
  push(event: SessionEvent): void;
  end(): void;
  readonly iterator: AsyncIterator<SessionEvent>;
}
export function createSessionEventChannel(options: SessionEventChannelOptions): SessionEventChannel;
```

- [ ] **Step 1: Write the failing test**

Create `packages/nax-agent/test/unit/session/session-event-channel.test.ts`:

```ts
/**
 * S3-4: the channel behind send()'s iterator (spec 4.4). The turn pushes and
 * one consumer pulls. While the consumer lags, adjacent deltas of one type and
 * round merge. Control events are never merged; past the cap the channel
 * reports a stall once. return() is the consumer leaving.
 */
import { describe, expect, test } from "bun:test";
import type { SessionEvent, SessionEventBody } from "@nathapp/nax-agent";
import { createSessionEventChannel, type SessionEventChannelOptions } from "#src/session/session-event-channel";

function ev(body: SessionEventBody): SessionEvent {
  return { sessionId: "s", turnId: "t", at: "2026-10-04T00:00:00.000Z", metadata: {}, ...body };
}

const text = (t: string, round = 1): SessionEvent => ev({ type: "text_delta", round, text: t });
const thinking = (t: string, round = 1): SessionEvent => ev({ type: "thinking_delta", round, text: t });
const result = (callId: string): SessionEvent => ev({ type: "tool_result", callId, isError: false, preview: "ok" });

function channel(extra: Partial<SessionEventChannelOptions> = {}) {
  const calls = { firstPull: 0, returned: 0, stalled: 0 };
  const ch = createSessionEventChannel({
    controlCap: 1000,
    onFirstPull: () => {
      calls.firstPull += 1;
    },
    onReturn: () => {
      calls.returned += 1;
    },
    onStall: () => {
      calls.stalled += 1;
    },
    ...extra,
  });
  return { ch, calls };
}

async function drain(ch: { iterator: AsyncIterator<SessionEvent> }): Promise<SessionEvent[]> {
  const out: SessionEvent[] = [];
  for (;;) {
    const next = await ch.iterator.next();
    if (next.done === true) return out;
    out.push(next.value);
  }
}

describe("createSessionEventChannel", () => {
  test("the first next() fires onFirstPull once, before reading", async () => {
    const { ch, calls } = channel({});
    const pending = ch.iterator.next();
    expect(calls.firstPull).toBe(1);
    ch.push(result("c1"));
    expect((await pending).value).toEqual(result("c1"));
    ch.end();
    await ch.iterator.next();
    expect(calls.firstPull).toBe(1);
  });

  test("onFirstPull may push synchronously; that event is returned first", async () => {
    const box: { ch?: ReturnType<typeof createSessionEventChannel> } = {};
    const ch = createSessionEventChannel({
      controlCap: 10,
      onFirstPull: () => box.ch?.push(ev({ type: "turn_start" })),
      onReturn: () => {},
      onStall: () => {},
    });
    box.ch = ch;
    expect((await ch.iterator.next()).value).toEqual(ev({ type: "turn_start" }));
  });

  test("buffered adjacent deltas of one type and round merge; types and rounds do not", async () => {
    const { ch } = channel();
    ch.push(text("a"));
    ch.push(text("b"));
    ch.push(thinking("x"));
    ch.push(thinking("y"));
    ch.push(text("c", 2));
    ch.push(text("d", 2));
    ch.push(text("e", 3));
    ch.end();
    expect(await drain(ch)).toEqual([text("ab"), thinking("xy"), text("cd", 2), text("e", 3)]);
  });

  test("a waiting consumer receives each delta as it is pushed", async () => {
    const { ch } = channel();
    const first = ch.iterator.next();
    ch.push(text("a"));
    expect((await first).value).toEqual(text("a"));
    ch.push(text("b"));
    ch.push(text("c"));
    ch.end();
    expect(await drain(ch)).toEqual([text("bc")]);
  });

  test("control events are never merged", async () => {
    const { ch } = channel();
    ch.push(result("c1"));
    ch.push(result("c1"));
    ch.end();
    expect(await drain(ch)).toEqual([result("c1"), result("c1")]);
  });

  test("past the cap of undelivered control events, onStall fires once; deltas do not count", async () => {
    const { ch, calls } = channel({ controlCap: 2 });
    ch.push(result("a"));
    ch.push(text("t"));
    ch.push(result("b"));
    expect(calls.stalled).toBe(0);
    ch.push(result("c"));
    expect(calls.stalled).toBe(1);
    ch.push(result("d"));
    expect(calls.stalled).toBe(1);
    ch.end();
    expect(await drain(ch)).toHaveLength(5);
  });

  test("delivered control events stop counting toward the cap", async () => {
    const { ch, calls } = channel({ controlCap: 2 });
    ch.push(result("a"));
    ch.push(result("b"));
    await ch.iterator.next();
    await ch.iterator.next();
    ch.push(result("c"));
    ch.push(result("d"));
    expect(calls.stalled).toBe(0);
  });

  test("end() completes the iterator after the buffer drains, and wakes a waiting consumer", async () => {
    const { ch } = channel();
    const waiting = ch.iterator.next();
    ch.end();
    expect((await waiting).done).toBe(true);
    ch.push(result("late"));
    expect((await ch.iterator.next()).done).toBe(true);
  });

  test("return() before end() fires onReturn once and discards later pushes", async () => {
    const { ch, calls } = channel();
    ch.push(result("a"));
    expect((await ch.iterator.return?.())?.done).toBe(true);
    expect((await ch.iterator.return?.())?.done).toBe(true);
    expect(calls.returned).toBe(1);
    ch.push(result("b"));
    expect((await ch.iterator.next()).done).toBe(true);
  });

  test("return() after end() does not fire onReturn", async () => {
    const { ch, calls } = channel();
    ch.end();
    await ch.iterator.return?.();
    expect(calls.returned).toBe(0);
  });

  test("return() wakes a waiting consumer with done", async () => {
    const { ch } = channel();
    const waiting = ch.iterator.next();
    await ch.iterator.return?.();
    expect((await waiting).done).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/nax-agent && bun test ./test/unit/session/session-event-channel.test.ts --timeout=60000`
Expected: FAIL with "Cannot find module '#src/session/session-event-channel'".

- [ ] **Step 3: Implement the channel**

Create `packages/nax-agent/src/session/session-event-channel.ts`:

```ts
/**
 * The push-to-pull channel behind send()'s iterator (spec 4.4). The turn
 * pushes; one consumer pulls. While the consumer lags, adjacent deltas of the
 * same type and round merge. Control events are never merged or dropped; past
 * `controlCap` undelivered ones the channel reports a stall, once. One
 * consumer only: concurrent next() calls are not supported (for await never
 * makes them).
 */
import type { SessionEvent } from "./agent-session-types.ts";

type DeltaEvent = Extract<SessionEvent, { readonly type: "text_delta" | "thinking_delta" }>;

export interface SessionEventChannelOptions {
  /** Undelivered control events tolerated before onStall fires. */
  readonly controlCap: number;
  /** The consumer's first next(): the turn starts here. May push synchronously. */
  readonly onFirstPull: () => void;
  /** The consumer called return() before the channel ended. */
  readonly onReturn: () => void;
  readonly onStall: () => void;
}

export interface SessionEventChannel {
  push(event: SessionEvent): void;
  /** No more events: the iterator completes once the buffer drains. */
  end(): void;
  readonly iterator: AsyncIterator<SessionEvent>;
}

const DONE: IteratorReturnResult<undefined> = { done: true, value: undefined };

function asDelta(event: SessionEvent | undefined): DeltaEvent | undefined {
  return event !== undefined && (event.type === "text_delta" || event.type === "thinking_delta") ? event : undefined;
}

function merged(last: DeltaEvent | undefined, next: DeltaEvent | undefined): DeltaEvent | undefined {
  if (last === undefined || next === undefined) return undefined;
  if (last.type !== next.type || last.round !== next.round) return undefined;
  return { ...last, text: last.text + next.text };
}

export function createSessionEventChannel(options: SessionEventChannelOptions): SessionEventChannel {
  let buffer: readonly SessionEvent[] = [];
  let waiter: ((result: IteratorResult<SessionEvent>) => void) | undefined;
  let undeliveredControl = 0;
  let ended = false;
  let consumerGone = false;
  let pulled = false;
  let stalled = false;

  function deliver(result: IteratorResult<SessionEvent>): boolean {
    if (waiter === undefined) return false;
    const resolve = waiter;
    waiter = undefined;
    resolve(result);
    return true;
  }

  function enqueue(event: SessionEvent): void {
    const combined = merged(asDelta(buffer[buffer.length - 1]), asDelta(event));
    if (combined !== undefined) {
      buffer = [...buffer.slice(0, -1), combined];
      return;
    }
    buffer = [...buffer, event];
    if (asDelta(event) !== undefined) return;
    undeliveredControl += 1;
    if (!stalled && undeliveredControl > options.controlCap) {
      stalled = true;
      options.onStall();
    }
  }

  function push(event: SessionEvent): void {
    if (ended || consumerGone) return;
    if (deliver({ value: event, done: false })) return;
    enqueue(event);
  }

  function end(): void {
    if (ended) return;
    ended = true;
    if (buffer.length === 0) deliver(DONE);
  }

  async function next(): Promise<IteratorResult<SessionEvent>> {
    if (!pulled) {
      pulled = true;
      options.onFirstPull();
    }
    if (consumerGone) return DONE;
    const [head, ...rest] = buffer;
    if (head !== undefined) {
      buffer = rest;
      if (asDelta(head) === undefined) undeliveredControl -= 1;
      return { value: head, done: false };
    }
    if (ended) return DONE;
    return new Promise((resolve) => {
      waiter = resolve;
    });
  }

  async function leave(): Promise<IteratorResult<SessionEvent>> {
    if (consumerGone) return DONE;
    consumerGone = true;
    buffer = [];
    deliver(DONE);
    if (!ended) options.onReturn();
    return DONE;
  }

  return { push, end, iterator: { next, return: leave } };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/nax-agent && bun test ./test/unit/session/session-event-channel.test.ts --timeout=60000`
Expected: PASS (11 tests).

- [ ] **Step 5: Gates and commit**

Run: `cd packages/nax-agent && bun run typecheck && bun run lint:fix && bun run check:all`
Expected: pass. No export changes in this task.

```bash
git add packages/nax-agent/src/session/session-event-channel.ts packages/nax-agent/test/unit/session/session-event-channel.test.ts
git commit -m "feat(nax-agent): agent session event channel with delta coalescing and a stall cap"
```

---

### Task 6: Pending asks and the session approval link

**Files:**
- Create: `packages/nax-agent/src/session/pending-asks.ts`
- Create: `packages/nax-agent/src/session/session-ask-link.ts`
- Test: `packages/nax-agent/test/unit/session/pending-asks.test.ts`
- Test: `packages/nax-agent/test/unit/session/session-ask-link.test.ts`

**Interfaces:**
- Consumes: `_agentSessionDeps` (Task 4), `AgentSessionError` (Task 3), `AnswerReply`, `AnswerStatus` and `SessionEventBody` (Task 3), and `chainAskLinks`, `AskLink`, `AskLinkOutcome`, `AskResolver` and `AskRequest` from `#src/permissions/index`.
- Produces:

```ts
// pending-asks.ts
export type PendingAskKind = "approval" | "question";
export type AskSettlement =
  | { readonly by: "human"; readonly reply: AnswerReply }
  | { readonly by: "timeout" }
  | { readonly by: "cancelled" };
export interface IssuedAsk { readonly requestId: string; readonly expiresAt: string; readonly settled: Promise<AskSettlement> }
export interface PendingAskTable {
  issue(kind: PendingAskKind, signal: AbortSignal | undefined): IssuedAsk;
  answer(requestId: string, reply: AnswerReply): AnswerStatus;
  cancelAll(): void;
  close(): void;
}
export function createPendingAskTable(timeoutMs: number): PendingAskTable;

// session-ask-link.ts
export interface SessionAskDeps {
  readonly table: PendingAskTable;
  readonly emit: (body: SessionEventBody) => void;
  readonly currentCallId: () => string | undefined;
}
export interface ApprovalAsk { readonly tool: string; readonly summary: string; readonly command?: string; readonly reason: string; readonly callId?: string }
export function askPerson(deps: SessionAskDeps, ask: ApprovalAsk, signal: AbortSignal | undefined): Promise<AskLinkOutcome>;
export function createSessionAskLink(deps: SessionAskDeps): AskLink;
export function createSessionAskResolver(link: AskLink): AskResolver;
```

- [ ] **Step 1: Write the failing table test**

Create `packages/nax-agent/test/unit/session/pending-asks.test.ts`:

```ts
/**
 * S3-4: the pending-ask table (spec 4.2 answer, 6.1). A request settles once:
 * by answer(), by its deadline or by its turn signal. Late or repeated
 * answers get a status; never-issued ids and kind mismatches throw; after
 * close every answer is "unknown".
 */
import { describe, expect, test } from "bun:test";
import { _agentSessionDeps } from "#src/session/agent-session-deps";
import { createPendingAskTable } from "#src/session/pending-asks";
import { assertNaxError, withDepsRestore } from "#test/helpers/index";

interface ManualTimers {
  fire(): void;
  readonly count: () => number;
}

function manualTimers(): ManualTimers {
  const pending = new Map<number, () => void>();
  let nextId = 1;
  _agentSessionDeps.setTimeout = (fn: () => void): unknown => {
    const id = nextId++;
    pending.set(id, fn);
    return id;
  };
  _agentSessionDeps.clearTimeout = (handle: unknown): void => {
    pending.delete(Number(handle));
  };
  return {
    fire() {
      for (const [id, fn] of [...pending]) {
        pending.delete(id);
        fn();
      }
    },
    count: () => pending.size,
  };
}

function expectInvalid(fn: () => unknown): void {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  assertNaxError(caught);
  expect(caught.code).toBe("AGENT_SESSION_INVALID_ANSWER");
}

describe("createPendingAskTable", () => {
  withDepsRestore(_agentSessionDeps);

  test("issue returns an id and the deadline as ISO time", () => {
    manualTimers();
    _agentSessionDeps.now = () => 0;
    _agentSessionDeps.randomUUID = () => "req-1";
    const issued = createPendingAskTable(600_000).issue("approval", undefined);
    expect(issued.requestId).toBe("req-1");
    expect(issued.expiresAt).toBe("1970-01-01T00:10:00.000Z");
  });

  test("an answer settles the request; a repeat answer is expired", async () => {
    const timers = manualTimers();
    const table = createPendingAskTable(30_000);
    const ask = table.issue("approval", undefined);
    expect(table.answer(ask.requestId, { decision: "allow" })).toBe("accepted");
    expect(await ask.settled).toEqual({ by: "human", reply: { decision: "allow" } });
    expect(timers.count()).toBe(0);
    expect(table.answer(ask.requestId, { decision: "deny" })).toBe("expired");
  });

  test("the deadline settles as timeout; a late answer is expired", async () => {
    const timers = manualTimers();
    const table = createPendingAskTable(30_000);
    const ask = table.issue("question", undefined);
    timers.fire();
    expect(await ask.settled).toEqual({ by: "timeout" });
    expect(table.answer(ask.requestId, { text: "late" })).toBe("expired");
  });

  test("the turn signal settles as cancelled; an answer then is cancelled", async () => {
    const timers = manualTimers();
    const table = createPendingAskTable(30_000);
    const controller = new AbortController();
    const ask = table.issue("approval", controller.signal);
    controller.abort();
    expect(await ask.settled).toEqual({ by: "cancelled" });
    expect(timers.count()).toBe(0);
    expect(table.answer(ask.requestId, { decision: "allow" })).toBe("cancelled");
  });

  test("an already-aborted signal settles at once", async () => {
    manualTimers();
    const controller = new AbortController();
    controller.abort();
    const ask = createPendingAskTable(30_000).issue("approval", controller.signal);
    expect(await ask.settled).toEqual({ by: "cancelled" });
  });

  test("a never-issued id, a kind mismatch and a malformed reply throw", () => {
    manualTimers();
    const table = createPendingAskTable(30_000);
    const approval = table.issue("approval", undefined);
    const question = table.issue("question", undefined);
    expectInvalid(() => table.answer("nope", { decision: "allow" }));
    expectInvalid(() => table.answer(approval.requestId, { text: "yes" }));
    expectInvalid(() => table.answer(question.requestId, { decision: "allow" }));
    const malformed: unknown = { decision: "maybe" };
    expectInvalid(() => table.answer(approval.requestId, malformed as { decision: "allow" }));
  });

  test("cancelAll settles every pending request as cancelled", async () => {
    manualTimers();
    const table = createPendingAskTable(30_000);
    const a = table.issue("approval", undefined);
    const b = table.issue("question", undefined);
    table.cancelAll();
    expect(await a.settled).toEqual({ by: "cancelled" });
    expect(await b.settled).toEqual({ by: "cancelled" });
  });

  test("after close: pending requests are cancelled and every answer is unknown", async () => {
    manualTimers();
    const table = createPendingAskTable(30_000);
    const ask = table.issue("approval", undefined);
    table.close();
    expect(await ask.settled).toEqual({ by: "cancelled" });
    expect(table.answer(ask.requestId, { decision: "allow" })).toBe("unknown");
    expect(table.answer("never-issued", { decision: "allow" })).toBe("unknown");
    expect(await table.issue("question", undefined).settled).toEqual({ by: "cancelled" });
  });
});
```

`malformed as { decision: "allow" }` starts with `{` and passes the escape-hatch regex.

- [ ] **Step 2: Write the failing link test**

Create `packages/nax-agent/test/unit/session/session-ask-link.test.ts`:

```ts
/**
 * S3-4: approvals raised to the person (spec 6.1). askPerson emits
 * approval_requested, waits on the table, emits approval_resolved. The coding
 * tools' AskLink denies unshowable requests without prompting and takes the
 * call id from the session's current-call slot.
 */
import { describe, expect, test } from "bun:test";
import type { SessionEventBody } from "@nathapp/nax-agent";
import type { AskRequest } from "#src/permissions/index";
import { _agentSessionDeps } from "#src/session/agent-session-deps";
import { createPendingAskTable } from "#src/session/pending-asks";
import { askPerson, createSessionAskLink, createSessionAskResolver, type SessionAskDeps } from "#src/session/session-ask-link";
import { withDepsRestore } from "#test/helpers/index";

function harness(callId?: string): { deps: SessionAskDeps; events: SessionEventBody[]; fire: () => void } {
  const timers: Array<() => void> = [];
  _agentSessionDeps.setTimeout = (fn: () => void): unknown => timers.push(fn);
  _agentSessionDeps.clearTimeout = () => {};
  _agentSessionDeps.now = () => 0;
  let n = 0;
  _agentSessionDeps.randomUUID = () => `req-${++n}`;
  const events: SessionEventBody[] = [];
  const deps: SessionAskDeps = {
    table: createPendingAskTable(30_000),
    emit: (body) => events.push(body),
    currentCallId: () => callId,
  };
  const fire = (): void => {
    for (const fn of timers.splice(0)) fn();
  };
  return { deps, events, fire };
}

const request: AskRequest = {
  tool: "Bash",
  stage: "session",
  rule: "Bash(*)",
  summary: "rm -rf build",
  command: "rm -rf build",
  reason: "matches an ask rule",
};

describe("askPerson", () => {
  withDepsRestore(_agentSessionDeps);

  test("emits approval_requested, then approval_resolved with the person's decision", async () => {
    const { deps, events } = harness();
    const outcome = askPerson(deps, { tool: "deploy", summary: "deploy v2", reason: "always", callId: "c9" }, undefined);
    expect(events).toEqual([
      {
        type: "approval_requested",
        requestId: "req-1",
        callId: "c9",
        tool: "deploy",
        summary: "deploy v2",
        reason: "always",
        expiresAt: "1970-01-01T00:00:30.000Z",
      },
    ]);
    expect(deps.table.answer("req-1", { decision: "allow" })).toBe("accepted");
    expect(await outcome).toEqual({ decision: "allow", decidedBy: "human" });
    expect(events[1]).toEqual({ type: "approval_resolved", requestId: "req-1", decision: "allow", decidedBy: "human" });
  });

  test("the deadline denies with decidedBy timeout", async () => {
    const { deps, events, fire } = harness();
    const outcome = askPerson(deps, { tool: "deploy", summary: "s", reason: "r" }, undefined);
    fire();
    expect(await outcome).toEqual({ decision: "deny", decidedBy: "timeout" });
    expect(events[1]).toMatchObject({ type: "approval_resolved", decision: "deny", decidedBy: "timeout" });
  });

  test("the turn signal denies with decidedBy cancelled", async () => {
    const { deps } = harness();
    const controller = new AbortController();
    const outcome = askPerson(deps, { tool: "deploy", summary: "s", reason: "r" }, controller.signal);
    controller.abort();
    expect(await outcome).toEqual({ decision: "deny", decidedBy: "cancelled" });
  });
});

describe("createSessionAskLink", () => {
  withDepsRestore(_agentSessionDeps);

  test("raises the request with the full command and the current call id", async () => {
    const { deps, events } = harness("call-7");
    const pending = createSessionAskLink(deps).resolve(request);
    expect(events[0]).toMatchObject({
      type: "approval_requested",
      callId: "call-7",
      tool: "Bash",
      command: "rm -rf build",
      reason: "matches an ask rule",
    });
    deps.table.answer("req-1", { decision: "deny" });
    expect(await pending).toEqual({ decision: "deny", decidedBy: "human" });
  });

  test("an unshowable request is denied without prompting", async () => {
    const { deps, events } = harness();
    const outcome = await createSessionAskLink(deps).resolve({ ...request, unshowable: true });
    expect(outcome).toEqual({ decision: "deny", decidedBy: "unshowable" });
    expect(events).toEqual([]);
  });

  test("without a reason, the matched rule is named", () => {
    const { deps, events } = harness();
    const { reason: _dropped, ...noReason } = request;
    void createSessionAskLink(deps).resolve(noReason);
    expect(events[0]).toMatchObject({ reason: "matched Bash(*)" });
  });
});

describe("createSessionAskResolver", () => {
  withDepsRestore(_agentSessionDeps);

  test("marks a person reachable and resolves through the link", async () => {
    const { deps } = harness();
    const resolver = createSessionAskResolver(createSessionAskLink(deps));
    expect(resolver.humanReachable).toBe(true);
    const verdict = resolver.resolve(request);
    deps.table.answer("req-1", { decision: "allow" });
    expect(await verdict).toMatchObject({ decision: "allow", decidedBy: "human" });
  });
});
```

- [ ] **Step 3: Run both tests to verify they fail**

Run: `cd packages/nax-agent && bun test ./test/unit/session/pending-asks.test.ts ./test/unit/session/session-ask-link.test.ts --timeout=60000`
Expected: FAIL with "Cannot find module '#src/session/pending-asks'" (and `session-ask-link`).

- [ ] **Step 4: Implement the table**

Create `packages/nax-agent/src/session/pending-asks.ts`:

```ts
/**
 * The session's pending approvals and questions (spec 4.2 answer, 6.1). Each
 * request settles once: by answer(), by its deadline, or by its turn signal.
 * Ids are kept for the session's lifetime, so a late click gets a status
 * rather than a throw; only a never-issued id or a kind mismatch throws.
 */
import { _agentSessionDeps } from "./agent-session-deps.ts";
import { AgentSessionError } from "./agent-session-errors.ts";
import type { AnswerReply, AnswerStatus } from "./agent-session-types.ts";

export type PendingAskKind = "approval" | "question";

export type AskSettlement =
  | { readonly by: "human"; readonly reply: AnswerReply }
  | { readonly by: "timeout" }
  | { readonly by: "cancelled" };

export interface IssuedAsk {
  readonly requestId: string;
  readonly expiresAt: string;
  readonly settled: Promise<AskSettlement>;
}

export interface PendingAskTable {
  issue(kind: PendingAskKind, signal: AbortSignal | undefined): IssuedAsk;
  answer(requestId: string, reply: AnswerReply): AnswerStatus;
  /** Settles every pending request as cancelled. */
  cancelAll(): void;
  /** cancelAll; afterwards every answer() returns "unknown" and every issue() settles cancelled. */
  close(): void;
}

interface Entry {
  readonly kind: PendingAskKind;
  readonly state: "pending" | AskSettlement["by"];
  readonly finish?: (settlement: AskSettlement) => void;
}

/** The kind a reply answers, or undefined for a malformed reply (callers may be plain JS). */
function replyKind(reply: AnswerReply): PendingAskKind | undefined {
  const value: unknown = reply;
  if (typeof value !== "object" || value === null) return undefined;
  if ("decision" in value) return value.decision === "allow" || value.decision === "deny" ? "approval" : undefined;
  return "text" in value && typeof value.text === "string" ? "question" : undefined;
}

function kindMismatch(requestId: string, kind: PendingAskKind): AgentSessionError {
  const expected = kind === "approval" ? "an approval: reply with { decision }" : "a question: reply with { text }";
  return new AgentSessionError(`Request "${requestId}" is ${expected}`, "AGENT_SESSION_INVALID_ANSWER", {
    requestId,
    kind,
  });
}

export function createPendingAskTable(timeoutMs: number): PendingAskTable {
  const entries = new Map<string, Entry>();
  let closed = false;

  function issue(kind: PendingAskKind, signal: AbortSignal | undefined): IssuedAsk {
    const requestId = _agentSessionDeps.randomUUID();
    const expiresAt = new Date(_agentSessionDeps.now() + timeoutMs).toISOString();
    const settled = new Promise<AskSettlement>((resolve) => {
      let timer: unknown;
      const onAbort = (): void => finish({ by: "cancelled" });
      function finish(settlement: AskSettlement): void {
        if (entries.get(requestId)?.state !== "pending") return;
        _agentSessionDeps.clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        entries.set(requestId, { kind, state: settlement.by });
        resolve(settlement);
      }
      entries.set(requestId, { kind, state: "pending", finish });
      timer = _agentSessionDeps.setTimeout(() => finish({ by: "timeout" }), timeoutMs);
      if (closed || signal?.aborted === true) finish({ by: "cancelled" });
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
    return { requestId, expiresAt, settled };
  }

  function answer(requestId: string, reply: AnswerReply): AnswerStatus {
    if (closed) return "unknown";
    const entry = entries.get(requestId);
    if (entry === undefined) {
      throw new AgentSessionError(`No request "${requestId}" was issued by this session`, "AGENT_SESSION_INVALID_ANSWER", {
        requestId,
      });
    }
    if (replyKind(reply) !== entry.kind) throw kindMismatch(requestId, entry.kind);
    if (entry.state === "pending") {
      entry.finish?.({ by: "human", reply });
      return "accepted";
    }
    return entry.state === "cancelled" ? "cancelled" : "expired";
  }

  function cancelAll(): void {
    for (const entry of [...entries.values()]) entry.finish?.({ by: "cancelled" });
  }

  function close(): void {
    cancelAll();
    closed = true;
  }

  return { issue, answer, cancelAll, close };
}
```

- [ ] **Step 5: Implement the link**

Create `packages/nax-agent/src/session/session-ask-link.ts`:

```ts
/**
 * Raises approvals to the person through the session's events (spec 6.1).
 * askPerson is shared by the coding tools' AskLink and by embedder tools
 * whose approval is "always". Asks are serial in practice: the tool batch
 * runs one call at a time.
 */
import { type AskLink, type AskLinkOutcome, type AskResolver, chainAskLinks } from "#src/permissions/index";
import type { SessionEventBody } from "./agent-session-types.ts";
import type { PendingAskTable } from "./pending-asks.ts";

export interface SessionAskDeps {
  readonly table: PendingAskTable;
  /** Emits on the running turn's event stream. */
  readonly emit: (body: SessionEventBody) => void;
  /** The tool call being answered right now, if any. */
  readonly currentCallId: () => string | undefined;
}

export interface ApprovalAsk {
  readonly tool: string;
  readonly summary: string;
  readonly command?: string;
  readonly reason: string;
  readonly callId?: string;
}

export async function askPerson(
  deps: SessionAskDeps,
  ask: ApprovalAsk,
  signal: AbortSignal | undefined,
): Promise<AskLinkOutcome> {
  const { requestId, expiresAt, settled } = deps.table.issue("approval", signal);
  deps.emit({
    type: "approval_requested",
    requestId,
    ...(ask.callId !== undefined ? { callId: ask.callId } : {}),
    tool: ask.tool,
    summary: ask.summary,
    ...(ask.command !== undefined ? { command: ask.command } : {}),
    reason: ask.reason,
    expiresAt,
  });
  const settlement = await settled;
  const allowed = settlement.by === "human" && "decision" in settlement.reply && settlement.reply.decision === "allow";
  const decision = allowed ? "allow" : "deny";
  deps.emit({ type: "approval_resolved", requestId, decision, decidedBy: settlement.by });
  return { decision, decidedBy: settlement.by };
}

const UNSHOWABLE: AskLinkOutcome = { decision: "deny", decidedBy: "unshowable" };

export function createSessionAskLink(deps: SessionAskDeps): AskLink {
  return {
    name: "agent-session",
    resolve(req, control) {
      // A request whose text could not be shown safely is never put in front of a person.
      if (req.unshowable === true) return Promise.resolve(UNSHOWABLE);
      const callId = deps.currentCallId();
      return askPerson(
        deps,
        {
          tool: req.tool,
          summary: req.summary,
          ...(req.command !== undefined ? { command: req.command } : {}),
          reason: req.reason ?? `matched ${req.rule}`,
          ...(callId !== undefined ? { callId } : {}),
        },
        control?.signal,
      );
    },
  };
}

export function createSessionAskResolver(link: AskLink): AskResolver {
  const chain = chainAskLinks([link]);
  return { humanReachable: true, resolve: (req, control) => chain.resolve(req, control) };
}
```

If `AskLink`, `AskLinkOutcome` or `AskRequest` is not re-exported from `#src/permissions/index`, import it from `#src/permissions/ask-chain` (where the agent report places the definitions) or `#src/permissions/types`. Do not widen any barrel.

- [ ] **Step 6: Run both tests to verify they pass**

Run: `cd packages/nax-agent && bun test ./test/unit/session/pending-asks.test.ts ./test/unit/session/session-ask-link.test.ts --timeout=60000`
Expected: PASS (8 + 7 tests).

- [ ] **Step 7: Gates and commit**

Run: `cd packages/nax-agent && bun run typecheck && bun run lint:fix && bun run check:all && bun ../repo-tooling/scripts/check-complexity.ts --package=.`
Expected: pass.

```bash
git add packages/nax-agent/src/session/pending-asks.ts packages/nax-agent/src/session/session-ask-link.ts packages/nax-agent/test/unit/session/pending-asks.test.ts packages/nax-agent/test/unit/session/session-ask-link.test.ts
git commit -m "feat(nax-agent): agent session pending asks and approval link"
```

---
### Task 7: Profiles, the default protected paths and the sandbox floor

**Files:**
- Create: `packages/nax-agent/src/session/session-tool-support.ts`
- Test: `packages/nax-agent/test/unit/session/session-tool-support.test.ts`

**Interfaces:**
- Consumes: `buildCodingToolSupport`, `resolveSessionSandbox`, `UNIVERSAL_CODING_TOOLS`, `DEFAULT_SANDBOX_CONFIG`, `credentialsConfig`, `EMPTY_OWNED_PATHS_POLICY` and `AgentSessionError` (Task 3).
- Produces:

```ts
export const SESSION_STAGE = "session";
export function declaredToolsFor(profile: AgentSessionProfile, protectedPaths: ProtectedPathsPolicy): readonly CodingToolName[];
export function grantsFor(declared: readonly CodingToolName[]): readonly ToolGrant[];
export function defaultProtectedPaths(ownCredentials: boolean): ProtectedPathsPolicy;
export interface SessionLauncherArgs {
  readonly profile: AgentSessionProfile;
  readonly root: string;
  readonly protectedPaths: ProtectedPathsPolicy;
  readonly bashApproval: BashApprovalMode;
  readonly allowUnsandboxed: boolean;
}
export function resolveSessionLauncher(args: SessionLauncherArgs): Promise<CommandLauncher | undefined>;
export interface SessionToolSupportArgs {
  readonly profile: AgentSessionProfile;
  readonly root: string;
  readonly sessionName: string;
  readonly protectedPaths: ProtectedPathsPolicy;
  readonly bashApproval: BashApprovalMode;
  readonly launcher: CommandLauncher | undefined;
  readonly askResolver: AskResolver;
  readonly interceptor: CommandInterceptor | undefined;
}
export interface SessionToolSupport { readonly support: CodingToolSupport; readonly grants: readonly ToolGrant[] }
export function buildSessionToolSupport(args: SessionToolSupportArgs): SessionToolSupport;
```

- [ ] **Step 1: Write the failing test**

Create `packages/nax-agent/test/unit/session/session-tool-support.test.ts`:

```ts
/**
 * S3-4: profiles are capability statements (spec 4.5). This pins the tools
 * each profile advertises, GitCommit only with ignore patterns, the embedder
 * default protected-paths policy (spec 6.2), the credential read-deny reaching
 * Read, and the sandbox floor for "full" (spec 6.3).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _sessionSandboxDeps } from "#src/coding-tools/coding-tool-sandbox";
import { _resetCredentialsConfig, configureCredentials, credentialsConfig } from "#src/infra/credentials-config";
import { chainAskLinks } from "#src/permissions/index";
import {
  buildSessionToolSupport,
  declaredToolsFor,
  defaultProtectedPaths,
  grantsFor,
  resolveSessionLauncher,
  type SessionToolSupportArgs,
} from "#src/session/session-tool-support";
import type { ProtectedPathsPolicy } from "#src/tools/protected-paths";
import { assertNaxError, stubSessionSandboxDeps, withDepsRestore, withSessionSandboxSeam } from "#test/helpers/index";

const EMPTY: ProtectedPathsPolicy = { gitExcludePathspecs: [], gitIgnorePatterns: [] };
const TRIO = ["ScratchpadWrite", "ScratchpadRead", "ScratchpadList"];

async function args(extra: Partial<SessionToolSupportArgs> = {}): Promise<SessionToolSupportArgs> {
  return {
    profile: "none",
    root: await mkdtemp(join(tmpdir(), "nax-session-tools-")),
    sessionName: "s1",
    protectedPaths: EMPTY,
    bashApproval: "gated",
    launcher: undefined,
    askResolver: chainAskLinks([]),
    interceptor: undefined,
    ...extra,
  };
}

function names(support: { tools: readonly { name: string }[] }): string[] {
  return support.tools.map((tool) => tool.name).sort();
}

describe("declaredToolsFor and grantsFor", () => {
  test("none is the scratchpad trio; read adds the read tools; full adds the write tools", () => {
    expect(declaredToolsFor("none", EMPTY)).toEqual(TRIO);
    expect(declaredToolsFor("read", EMPTY)).toEqual([...TRIO, "Read", "Glob", "Grep", "Git"]);
    expect(declaredToolsFor("full", EMPTY)).toEqual([...TRIO, "Read", "Glob", "Grep", "Git", "Write", "Edit", "Delete", "Bash"]);
  });

  test("full declares GitCommit only when ignore patterns are supplied", () => {
    expect(declaredToolsFor("full", { ...EMPTY, gitIgnorePatterns: ["dist/"] })).toContain("GitCommit");
    expect(declaredToolsFor("read", { ...EMPTY, gitIgnorePatterns: ["dist/"] })).not.toContain("GitCommit");
  });

  test("every declared tool gets an unconditional grant", () => {
    expect(grantsFor(["Read", "Git"])).toEqual([
      { tool: "Read", patterns: ["*"] },
      { tool: "Git", patterns: ["*"] },
    ]);
  });
});

describe("defaultProtectedPaths", () => {
  const saved = credentialsConfig();
  afterEach(() => configureCredentials(saved));

  test("uses the configured credentials directory when the session has no credentials of its own", () => {
    expect(defaultProtectedPaths(false)).toEqual({ ...EMPTY, credentialDir: saved.configDir() });
  });

  test("a session with its own credentials source gets no credential directory", () => {
    expect(defaultProtectedPaths(true)).toEqual(EMPTY);
  });

  test("without configureCredentials there is no credential directory", () => {
    _resetCredentialsConfig();
    expect(defaultProtectedPaths(false)).toEqual(EMPTY);
  });
});

describe("buildSessionToolSupport", () => {
  test("advertises the profile's tools, with grants", async () => {
    const none = buildSessionToolSupport(await args());
    expect(names(none.support)).toEqual([...TRIO].sort());
    expect(none.grants).toHaveLength(3);
    const read = buildSessionToolSupport(await args({ profile: "read" }));
    expect(names(read.support)).toEqual([...TRIO, "Read", "Glob", "Grep", "Git"].sort());
  });

  test("full without a launcher advertises Write, Edit, Delete and Bash", async () => {
    const full = buildSessionToolSupport(await args({ profile: "full" }));
    expect(names(full.support)).toEqual(expect.arrayContaining(["Write", "Edit", "Delete", "Bash"]));
    expect(names(full.support)).not.toContain("GitCommit");
    expect(names(full.support)).not.toContain("RunCommand");
  });

  test("Read refuses the credential directory", async () => {
    const base = await args({ profile: "read" });
    const credentialDir = join(base.root, "creds");
    await mkdir(credentialDir);
    await writeFile(join(credentialDir, "token.json"), "{}");
    const { support } = buildSessionToolSupport({ ...base, protectedPaths: { ...EMPTY, credentialDir } });
    const outcome = await support.runtime.callTool("Read", { path: "creds/token.json" });
    expect(outcome.kind).toBe("error");
    const plain = await support.runtime.callTool("Read", { path: "creds" });
    expect(plain.kind).not.toBe("ok");
  });
});

describe("resolveSessionLauncher", () => {
  withDepsRestore(_sessionSandboxDeps);
  withSessionSandboxSeam(_sessionSandboxDeps);

  const launcherArgs = {
    root: "/work",
    protectedPaths: EMPTY,
    bashApproval: "gated" as const,
    allowUnsandboxed: false,
  };

  test("none and read need no sandbox and never probe", async () => {
    let probed = 0;
    _sessionSandboxDeps.probe = async () => {
      probed += 1;
      return { available: true };
    };
    expect(await resolveSessionLauncher({ ...launcherArgs, profile: "none" })).toBeUndefined();
    expect(await resolveSessionLauncher({ ...launcherArgs, profile: "read" })).toBeUndefined();
    expect(probed).toBe(0);
  });

  test("full with a usable sandbox returns an available launcher", async () => {
    stubSessionSandboxDeps(_sessionSandboxDeps);
    const launcher = await resolveSessionLauncher({ ...launcherArgs, profile: "full" });
    expect(launcher?.state.kind).toBe("available");
  });

  test("full without a sandbox fails with the probe's reason", async () => {
    stubSessionSandboxDeps(_sessionSandboxDeps);
    _sessionSandboxDeps.probe = async () => ({ available: false, reason: "no sandbox backend on this host" });
    let caught: unknown;
    try {
      await resolveSessionLauncher({ ...launcherArgs, profile: "full" });
    } catch (err) {
      caught = err;
    }
    assertNaxError(caught);
    expect(caught.code).toBe("AGENT_SESSION_SANDBOX_UNAVAILABLE");
    expect(caught.message).toContain("no sandbox backend on this host");
  });

  test("gated with allowUnsandboxed runs without a launcher", async () => {
    stubSessionSandboxDeps(_sessionSandboxDeps);
    _sessionSandboxDeps.probe = async () => ({ available: false, reason: "none" });
    expect(await resolveSessionLauncher({ ...launcherArgs, profile: "full", allowUnsandboxed: true })).toBeUndefined();
  });
});
```

Notes:
- If `Read` on a directory path already returns an error for an unrelated reason, the second `plain` assertion still holds (`not "ok"`). It guards against the refusal being path-exact only.
- If `stubSessionSandboxDeps` or `withSessionSandboxSeam` is not re-exported from `#test/helpers/index`, import it from `#test/helpers/session-sandbox-deps`.
- The sandbox registry memoises its probe per process (`probeSandboxOnce`), but these tests replace `_sessionSandboxDeps.probe` itself, so the memo is not consulted.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/nax-agent && bun test ./test/unit/session/session-tool-support.test.ts --timeout=60000`
Expected: FAIL with "Cannot find module '#src/session/session-tool-support'".

- [ ] **Step 3: Implement**

Create `packages/nax-agent/src/session/session-tool-support.ts`:

```ts
/**
 * Profile -> coding tools (spec 4.5, 6.2, 6.3). A profile is a capability
 * statement; this module turns it into the declared tools and grants that
 * buildCodingToolSupport takes, picks the embedder default protected-paths
 * policy, and enforces the sandbox floor for "full".
 */
import { resolveSessionSandbox } from "#src/coding-tools/coding-tool-sandbox";
import { buildCodingToolSupport, type CodingToolSupport } from "#src/coding-tools/coding-tool-support";
import { UNIVERSAL_CODING_TOOLS } from "#src/coding-tools/universal-coding-tools";
import type { CommandInterceptor } from "#src/command-interceptor/index";
import type { BashApprovalMode } from "#src/config/bash-approval";
import { DEFAULT_SANDBOX_CONFIG } from "#src/config/schemas-sandbox";
import { credentialsConfig } from "#src/infra/credentials-config";
import type { AskResolver } from "#src/permissions/index";
import type { CommandLauncher } from "#src/sandbox/index";
import { EMPTY_OWNED_PATHS_POLICY } from "#src/tools/owned-paths";
import type { ProtectedPathsPolicy } from "#src/tools/protected-paths";
import type { CodingToolName, ToolGrant } from "#src/tools/types";
import { AgentSessionError } from "./agent-session-errors.ts";
import type { AgentSessionProfile } from "./agent-session-types.ts";

/** The pipeline stage the facade's tool calls and asks carry. */
export const SESSION_STAGE = "session";

const READ_TOOLS: readonly CodingToolName[] = ["Read", "Glob", "Grep", "Git"];
const WRITE_TOOLS: readonly CodingToolName[] = ["Write", "Edit", "Delete", "Bash"];

export function declaredToolsFor(
  profile: AgentSessionProfile,
  protectedPaths: ProtectedPathsPolicy,
): readonly CodingToolName[] {
  if (profile === "none") return [...UNIVERSAL_CODING_TOOLS];
  if (profile === "read") return [...UNIVERSAL_CODING_TOOLS, ...READ_TOOLS];
  // GitCommit refuses every path without ignore patterns, so it is offered only with them.
  const commit: readonly CodingToolName[] = protectedPaths.gitIgnorePatterns.length > 0 ? ["GitCommit"] : [];
  return [...UNIVERSAL_CODING_TOOLS, ...READ_TOOLS, ...WRITE_TOOLS, ...commit];
}

export function grantsFor(declared: readonly CodingToolName[]): readonly ToolGrant[] {
  return declared.map((tool) => ({ tool, patterns: ["*"] }));
}

/** The configured credentials directory; undefined when configureCredentials was never called. */
function configuredCredentialDir(): string | undefined {
  try {
    return credentialsConfig().configDir();
  } catch {
    return undefined;
  }
}

/**
 * The embedder default (spec 6.2). A session with its own credentials source
 * (memory or exec) has no credentials directory on disk; one that falls back
 * to the configureCredentials slot protects that slot's directory.
 */
export function defaultProtectedPaths(ownCredentials: boolean): ProtectedPathsPolicy {
  const base: ProtectedPathsPolicy = { gitExcludePathspecs: [], gitIgnorePatterns: [] };
  const credentialDir = ownCredentials ? undefined : configuredCredentialDir();
  return credentialDir === undefined ? base : { ...base, credentialDir };
}

export interface SessionLauncherArgs {
  readonly profile: AgentSessionProfile;
  readonly root: string;
  readonly protectedPaths: ProtectedPathsPolicy;
  readonly bashApproval: BashApprovalMode;
  readonly allowUnsandboxed: boolean;
}

/** The sandbox floor (spec 6.3): "full" needs a usable sandbox unless gated + allowUnsandboxed. */
export async function resolveSessionLauncher(args: SessionLauncherArgs): Promise<CommandLauncher | undefined> {
  if (args.profile !== "full") return undefined;
  const launcher = await resolveSessionSandbox({
    config: DEFAULT_SANDBOX_CONFIG,
    root: args.root,
    needsLauncher: true,
    protectedPaths: args.protectedPaths,
    ownedPaths: EMPTY_OWNED_PATHS_POLICY,
  });
  if (launcher.state.kind === "available") return launcher;
  if (args.bashApproval === "gated" && args.allowUnsandboxed) return undefined;
  const reason = launcher.state.kind === "unavailable" ? launcher.state.reason : "the sandbox is disabled";
  throw new AgentSessionError(
    `Profile "full" needs a usable sandbox (${reason}). Pass bashApproval "gated" with allowUnsandboxed: true to run without one.`,
    "AGENT_SESSION_SANDBOX_UNAVAILABLE",
    { reason },
  );
}

export interface SessionToolSupportArgs {
  readonly profile: AgentSessionProfile;
  readonly root: string;
  readonly sessionName: string;
  readonly protectedPaths: ProtectedPathsPolicy;
  readonly bashApproval: BashApprovalMode;
  readonly launcher: CommandLauncher | undefined;
  readonly askResolver: AskResolver;
  readonly interceptor: CommandInterceptor | undefined;
}

export interface SessionToolSupport {
  readonly support: CodingToolSupport;
  readonly grants: readonly ToolGrant[];
}

export function buildSessionToolSupport(args: SessionToolSupportArgs): SessionToolSupport {
  const declared = declaredToolsFor(args.profile, args.protectedPaths);
  const grants = grantsFor(declared);
  const support = buildCodingToolSupport({
    root: args.root,
    commandCwd: args.root,
    pipelineStage: SESSION_STAGE,
    sessionName: args.sessionName,
    declared,
    grants,
    bashApproval: args.bashApproval,
    protectedPaths: args.protectedPaths,
    ownedPaths: EMPTY_OWNED_PATHS_POLICY,
    askResolver: args.askResolver,
    ...(args.interceptor !== undefined ? { interceptor: args.interceptor } : {}),
    ...(args.launcher !== undefined ? { launcher: args.launcher } : {}),
  });
  // Unreachable while the scratchpad trio is always declared and granted; kept for the type.
  if (support === undefined) {
    throw new AgentSessionError("No coding tools resolved for the session", "AGENT_SESSION_INVALID_OPTIONS", {
      profile: args.profile,
    });
  }
  return { support, grants };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/nax-agent && bun test ./test/unit/session/session-tool-support.test.ts --timeout=60000`
Expected: PASS (13 tests).

- [ ] **Step 5: Gates and commit**

Run: `cd packages/nax-agent && bun run typecheck && bun run lint:fix && bun run check:all && bun ../repo-tooling/scripts/check-complexity.ts --package=.`
Expected: pass. `check-sandbox-imports` may restrict who imports `#src/sandbox/*`. If it flags `session-tool-support.ts`, import the `CommandLauncher` type from the module that `coding-tool-support.ts` uses. The function itself already comes through `#src/coding-tools/coding-tool-sandbox`.

```bash
git add packages/nax-agent/src/session/session-tool-support.ts packages/nax-agent/test/unit/session/session-tool-support.test.ts
git commit -m "feat(nax-agent): agent session profiles, protected-paths default and sandbox floor"
```

---

### Task 8: Embedder tools and the routing `InteractionHandler`

**Files:**
- Create: `packages/nax-agent/src/session/session-interaction.ts`
- Test: `packages/nax-agent/test/unit/session/session-interaction.test.ts`

**Interfaces:**
- Consumes: `askPerson` and `SessionAskDeps` (Task 6), `EmbedderTool` (Task 3), `CodingToolRuntime` and `ToolCallContext` (`#src/tools/runtime`), `askDenyReason` (`#src/tools/ask-request`), `redactSecrets` and `cutToByteCap`.
- Produces:

```ts
export const EMBEDDER_SUMMARY_BYTES = 1024;
export function embedderToolDescriptor(tool: EmbedderTool): CodingTool;
export function defaultSummary(input: unknown): string;
export interface SessionInteractionDeps {
  readonly sessionId: string;
  readonly runtime: CodingToolRuntime;
  readonly embedderTools: ReadonlyMap<string, EmbedderTool>;
  readonly asks: SessionAskDeps;
  readonly turnSignal: () => AbortSignal;
  readonly setCurrentCallId: (callId: string | undefined) => void;
}
export function createSessionInteractionHandler(deps: SessionInteractionDeps): InteractionHandler;
```

- [ ] **Step 1: Write the failing test**

Create `packages/nax-agent/test/unit/session/session-interaction.test.ts`:

```ts
/**
 * S3-4: the facade's InteractionHandler. Questions go to the pending-ask
 * table; embedder tools run in-process (after an approval when declared
 * "always"); built-in tools go to the CodingToolRuntime with the call id in
 * the current-call slot. A failed tool is reported by throwing, which the
 * tool batch records as an isError result.
 */
import { describe, expect, test } from "bun:test";
import type { EmbedderTool, EmbedderToolContext, SessionEventBody } from "@nathapp/nax-agent";
import { NaxError } from "#src/infra/nax-error";
import type { AdapterInteraction } from "#src/session/interaction-handler";
import { _agentSessionDeps } from "#src/session/agent-session-deps";
import { createPendingAskTable } from "#src/session/pending-asks";
import {
  createSessionInteractionHandler,
  defaultSummary,
  EMBEDDER_SUMMARY_BYTES,
  embedderToolDescriptor,
  type SessionInteractionDeps,
} from "#src/session/session-interaction";
import type { CodingToolOutcome, CodingToolRuntime, ToolCallContext } from "#src/tools/runtime";
import { withDepsRestore } from "#test/helpers/index";

interface Harness {
  readonly deps: SessionInteractionDeps;
  readonly events: SessionEventBody[];
  readonly runtimeCalls: Array<{ name: string; context: ToolCallContext | undefined; callIdDuring: string | undefined }>;
  readonly slot: { callId: string | undefined };
  readonly fireTimers: () => void;
}

function harness(outcome: CodingToolOutcome, tools: readonly EmbedderTool[] = []): Harness {
  const timers: Array<() => void> = [];
  _agentSessionDeps.setTimeout = (fn: () => void): unknown => timers.push(fn);
  _agentSessionDeps.clearTimeout = () => {};
  let n = 0;
  _agentSessionDeps.randomUUID = () => `req-${++n}`;
  const events: SessionEventBody[] = [];
  const slot: { callId: string | undefined } = { callId: undefined };
  const runtimeCalls: Harness["runtimeCalls"] = [];
  const runtime: CodingToolRuntime = {
    advertised: () => [],
    async callTool(name, _input, context) {
      runtimeCalls.push({ name, context, callIdDuring: slot.callId });
      return outcome;
    },
  };
  const turn = new AbortController();
  const deps: SessionInteractionDeps = {
    sessionId: "s1",
    runtime,
    embedderTools: new Map(tools.map((tool) => [tool.name, tool])),
    asks: { table: createPendingAskTable(30_000), emit: (body) => events.push(body), currentCallId: () => slot.callId },
    turnSignal: () => turn.signal,
    setCurrentCallId: (callId) => {
      slot.callId = callId;
    },
  };
  const fireTimers = (): void => {
    for (const fn of timers.splice(0)) fn();
  };
  return { deps, events, runtimeCalls, slot, fireTimers };
}

function codingTool(name: string, input: Record<string, unknown> = {}): AdapterInteraction {
  return { kind: "coding-tool", name, input, toolCallId: "call-1", turnId: "turn-1", roundTrips: 2, deferModelTruncation: true };
}

async function thrown(promise: Promise<unknown>): Promise<NaxError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof NaxError) return err;
    throw err;
  }
  throw new Error("expected a NaxError");
}

function embedder(extra: Partial<EmbedderTool> & { run?: EmbedderTool["run"] } = {}): {
  tool: EmbedderTool;
  seen: EmbedderToolContext[];
} {
  const seen: EmbedderToolContext[] = [];
  const tool: EmbedderTool = {
    name: "lookup",
    description: "look a record up",
    inputSchema: { type: "object" },
    approval: "never",
    async run(_input, ctx) {
      seen.push(ctx);
      return { content: "record 42" };
    },
    ...extra,
  };
  return { tool, seen };
}

describe("embedderToolDescriptor and defaultSummary", () => {
  test("the descriptor carries the model-facing fields and refuses to run directly", async () => {
    const { tool } = embedder();
    const descriptor = embedderToolDescriptor(tool);
    expect(descriptor).toMatchObject({ name: "lookup", description: "look a record up", inputSchema: { type: "object" } });
    expect(descriptor.scope).toEqual({ pathFields: [] });
    const direct = await descriptor.run({}, { root: "/", resolvedPaths: [], maxBytes: 1, maxFileBytes: 1 });
    expect(direct.isError).toBe(true);
  });

  test("the default summary is redacted, byte-capped JSON", () => {
    expect(defaultSummary({ id: 7, apiKey: "plainsecret" })).toBe('{"id":7,"apiKey":"[REDACTED]"}');
    expect(Buffer.byteLength(defaultSummary({ blob: "z".repeat(5000) }))).toBeLessThanOrEqual(EMBEDDER_SUMMARY_BYTES);
  });
});

describe("createSessionInteractionHandler", () => {
  withDepsRestore(_agentSessionDeps);

  test("a question is raised and answered with the person's text", async () => {
    const h = harness({ kind: "ok", content: "" });
    const answer = createSessionInteractionHandler(h.deps).onInteraction({ kind: "question", text: "Which env?" });
    expect(h.events[0]).toMatchObject({ type: "question", requestId: "req-1", text: "Which env?" });
    h.deps.asks.table.answer("req-1", { text: "staging" });
    expect(await answer).toEqual({ answer: "staging" });
  });

  test("an unanswered question returns null, the loop's no-operator answer", async () => {
    const h = harness({ kind: "ok", content: "" });
    const answer = createSessionInteractionHandler(h.deps).onInteraction({ kind: "question", text: "?" });
    h.fireTimers();
    expect(await answer).toBeNull();
  });

  test("a context-tool request is an unknown tool", async () => {
    const h = harness({ kind: "ok", content: "" });
    const err = await thrown(
      createSessionInteractionHandler(h.deps).onInteraction({ kind: "context-tool", name: "mystery" }),
    );
    expect(err.message).toContain('Unknown tool "mystery"');
  });

  test("a built-in tool runs through the runtime with its call context, inside the current-call slot", async () => {
    const h = harness({ kind: "ok", content: "file body" });
    const answer = await createSessionInteractionHandler(h.deps).onInteraction(codingTool("Read", { path: "a.ts" }));
    expect(answer).toEqual({ answer: "file body" });
    expect(h.runtimeCalls[0]).toEqual({
      name: "Read",
      context: { turnId: "turn-1", roundTrips: 2, toolCallId: "call-1", deferModelTruncation: true },
      callIdDuring: "call-1",
    });
    expect(h.slot.callId).toBeUndefined();
  });

  test("a denied built-in returns the denial; an erroring one throws its content", async () => {
    const denied = harness({ kind: "denied", reason: "outside the root", breach: false });
    expect(await createSessionInteractionHandler(denied.deps).onInteraction(codingTool("Read"))).toEqual({
      answer: "Denied: outside the root",
      denied: { reason: "outside the root", breach: false },
    });
    const failed = harness({ kind: "error", content: "ENOENT: a.ts" });
    const err = await thrown(createSessionInteractionHandler(failed.deps).onInteraction(codingTool("Read")));
    expect(err.message).toBe("ENOENT: a.ts");
    expect(failed.slot.callId).toBeUndefined();
  });

  test("an embedder tool runs with the session id, call id and turn signal", async () => {
    const { tool, seen } = embedder();
    const h = harness({ kind: "ok", content: "" }, [tool]);
    const answer = await createSessionInteractionHandler(h.deps).onInteraction(codingTool("lookup", { id: 42 }));
    expect(answer).toEqual({ answer: "record 42" });
    expect(seen[0]?.sessionId).toBe("s1");
    expect(seen[0]?.toolCallId).toBe("call-1");
    expect(seen[0]?.signal.aborted).toBe(false);
    expect(h.runtimeCalls).toHaveLength(0);
  });

  test("embedder isError and a throwing run both throw, with the content or the cause", async () => {
    const isError = embedder({ run: async () => ({ content: "no such record", isError: true }) });
    const h1 = harness({ kind: "ok", content: "" }, [isError.tool]);
    expect((await thrown(createSessionInteractionHandler(h1.deps).onInteraction(codingTool("lookup")))).message).toBe(
      "no such record",
    );
    const throwing = embedder({
      run: async () => {
        throw new Error("db down");
      },
    });
    const h2 = harness({ kind: "ok", content: "" }, [throwing.tool]);
    expect((await thrown(createSessionInteractionHandler(h2.deps).onInteraction(codingTool("lookup")))).message).toBe(
      'Tool "lookup" failed: db down',
    );
  });

  test("approval always: asks with the described summary and the call id, then runs on allow", async () => {
    const { tool, seen } = embedder({ approval: "always", describe: (input) => `look up ${JSON.stringify(input)}` });
    const h = harness({ kind: "ok", content: "" }, [tool]);
    const answer = createSessionInteractionHandler(h.deps).onInteraction(codingTool("lookup", { id: 42 }));
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.events[0]).toMatchObject({ type: "approval_requested", callId: "call-1", tool: "lookup", summary: 'look up {"id":42}' });
    expect(seen).toHaveLength(0);
    h.deps.asks.table.answer("req-1", { decision: "allow" });
    expect(await answer).toEqual({ answer: "record 42" });
    expect(seen).toHaveLength(1);
  });

  test("approval always: a denial or a timeout does not run the tool", async () => {
    const { tool, seen } = embedder({ approval: "always" });
    const h = harness({ kind: "ok", content: "" }, [tool]);
    const handler = createSessionInteractionHandler(h.deps);
    const first = handler.onInteraction(codingTool("lookup"));
    await new Promise((resolve) => setImmediate(resolve));
    h.deps.asks.table.answer("req-1", { decision: "deny" });
    expect(await first).toMatchObject({ denied: { breach: false } });
    const second = handler.onInteraction(codingTool("lookup"));
    await new Promise((resolve) => setImmediate(resolve));
    h.fireTimers();
    expect(await second).toMatchObject({ denied: { breach: false } });
    expect(seen).toHaveLength(0);
  });

  test("a throwing describe falls back to the default summary", async () => {
    const { tool } = embedder({
      approval: "always",
      describe: () => {
        throw new Error("bad describe");
      },
    });
    const h = harness({ kind: "ok", content: "" }, [tool]);
    void createSessionInteractionHandler(h.deps).onInteraction(codingTool("lookup", { id: 1 }));
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.events[0]).toMatchObject({ summary: '{"id":1}' });
  });
});
```

If the exact JSON that `redactSecrets` produces for `{ id: 7, apiKey: "plainsecret" }` differs (for example in the mask text), update the expected string to the mask that `redactSecrets` uses. Read `src/internal/redact.ts`; the mask is `"[REDACTED]"` per the S3-3 tests.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/nax-agent && bun test ./test/unit/session/session-interaction.test.ts --timeout=60000`
Expected: FAIL with "Cannot find module '#src/session/session-interaction'".

- [ ] **Step 3: Implement**

Create `packages/nax-agent/src/session/session-interaction.ts`:

```ts
/**
 * The facade's InteractionHandler (spec 5.1, 4.3, 6.1). Routes each loop
 * request:
 * - question -> the pending-ask table (null on timeout or cancel, which the
 *   loop answers with its no-operator text);
 * - an embedder tool -> its own run, after an approval when it is "always";
 * - a built-in coding tool -> the session's CodingToolRuntime, with the call
 *   id in the current-call slot so a policy ask can name it.
 * A failed tool is reported by throwing: the tool batch turns a handler throw
 * into an isError result whose content is the thrown message.
 */
import { NaxError } from "#src/infra/nax-error";
import { redactSecrets } from "#src/internal/redact";
import { askDenyReason } from "#src/tools/ask-request";
import type { CodingTool } from "#src/tools/registry";
import type { CodingToolRuntime, ToolCallContext } from "#src/tools/runtime";
import { cutToByteCap } from "#src/tools/truncate";
import type { EmbedderTool, EmbedderToolContext, EmbedderToolResult } from "./agent-session-types.ts";
import type { AdapterInteraction, AdapterInteractionResponse, InteractionHandler } from "./interaction-handler.ts";
import { askPerson, type SessionAskDeps } from "./session-ask-link.ts";

/** Byte cap on an embedder approval's default summary. */
export const EMBEDDER_SUMMARY_BYTES = 1024;

type CodingToolRequest = Extract<AdapterInteraction, { kind: "coding-tool" }>;

export interface SessionInteractionDeps {
  readonly sessionId: string;
  readonly runtime: CodingToolRuntime;
  readonly embedderTools: ReadonlyMap<string, EmbedderTool>;
  readonly asks: SessionAskDeps;
  /** The running turn's signal (a never-aborting one between turns). */
  readonly turnSignal: () => AbortSignal;
  readonly setCurrentCallId: (callId: string | undefined) => void;
}

/** What the model sees of an embedder tool. The facade's handler runs it; this run is never reached. */
export function embedderToolDescriptor(tool: EmbedderTool): CodingTool {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    scope: { pathFields: [] },
    async run() {
      return { content: `"${tool.name}" runs through the agent session, not the coding-tool runtime.`, isError: true };
    },
  };
}

export function defaultSummary(input: unknown): string {
  let json: string;
  try {
    json = JSON.stringify(redactSecrets(input)) ?? "null";
  } catch {
    return "[input not serializable]";
  }
  return cutToByteCap(json, EMBEDDER_SUMMARY_BYTES);
}

function toolError(message: string, tool: string): NaxError {
  return new NaxError(message, "AGENT_SESSION_TOOL_ERROR", { stage: "agent-session", tool });
}

function summaryFor(tool: EmbedderTool, input: unknown): string {
  if (tool.describe === undefined) return defaultSummary(input);
  try {
    return tool.describe(input);
  } catch {
    return defaultSummary(input);
  }
}

async function invoke(tool: EmbedderTool, input: unknown, ctx: EmbedderToolContext): Promise<EmbedderToolResult> {
  try {
    return await tool.run(input, ctx);
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    return { content: `Tool "${tool.name}" failed: ${cause}`, isError: true };
  }
}

async function runEmbedderTool(
  deps: SessionInteractionDeps,
  tool: EmbedderTool,
  request: CodingToolRequest,
): Promise<AdapterInteractionResponse> {
  const toolCallId = request.toolCallId ?? "";
  const signal = request.signal ?? deps.turnSignal();
  const input = request.input ?? {};
  if (tool.approval === "always") {
    const ask = { tool: tool.name, summary: summaryFor(tool, input), reason: `"${tool.name}" asks before every run`, callId: toolCallId };
    const outcome = await askPerson(deps.asks, ask, signal);
    if (outcome.decision !== "allow") {
      const reason = askDenyReason(outcome.decidedBy);
      return { answer: `Denied: ${reason}`, denied: { reason, breach: false } };
    }
  }
  const result = await invoke(tool, input, { sessionId: deps.sessionId, toolCallId, signal });
  if (result.isError === true) throw toolError(result.content, tool.name);
  return { answer: result.content };
}

function toolCallContext(request: CodingToolRequest): ToolCallContext {
  return {
    ...(request.turnId !== undefined ? { turnId: request.turnId } : {}),
    ...(request.roundTrips !== undefined ? { roundTrips: request.roundTrips } : {}),
    ...(request.toolCallId !== undefined ? { toolCallId: request.toolCallId } : {}),
    ...(request.deferModelTruncation !== undefined ? { deferModelTruncation: request.deferModelTruncation } : {}),
    ...(request.signal !== undefined ? { signal: request.signal } : {}),
    ...(request.onWaiting !== undefined ? { onWaiting: request.onWaiting } : {}),
  };
}

async function runCodingTool(deps: SessionInteractionDeps, request: CodingToolRequest): Promise<AdapterInteractionResponse> {
  deps.setCurrentCallId(request.toolCallId);
  try {
    const outcome = await deps.runtime.callTool(request.name, request.input ?? {}, toolCallContext(request));
    if (outcome.kind === "denied") {
      return { answer: `Denied: ${outcome.reason}`, denied: { reason: outcome.reason, breach: outcome.breach } };
    }
    if (outcome.kind === "error") throw toolError(outcome.content, request.name);
    return { answer: outcome.content };
  } finally {
    deps.setCurrentCallId(undefined);
  }
}

async function answerQuestion(deps: SessionInteractionDeps, text: string): Promise<AdapterInteractionResponse | null> {
  const { requestId, expiresAt, settled } = deps.asks.table.issue("question", deps.turnSignal());
  deps.asks.emit({ type: "question", requestId, text, expiresAt });
  const settlement = await settled;
  return settlement.by === "human" && "text" in settlement.reply ? { answer: settlement.reply.text } : null;
}

export function createSessionInteractionHandler(deps: SessionInteractionDeps): InteractionHandler {
  return {
    async onInteraction(request) {
      if (request.kind === "question") return answerQuestion(deps, request.text);
      if (request.kind === "context-tool") throw toolError(`Unknown tool "${request.name}"`, request.name);
      const tool = deps.embedderTools.get(request.name);
      return tool !== undefined ? runEmbedderTool(deps, tool, request) : runCodingTool(deps, request);
    },
  };
}
```

The handler returns no `finalizeAudit`: the facade passes no `auditDir`, so the audit sink is the no-op sink, and leaving a deferred row unfinished there costs nothing.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/nax-agent && bun test ./test/unit/session/session-interaction.test.ts --timeout=60000`
Expected: PASS (11 tests).

- [ ] **Step 5: Gates and commit**

Run: `cd packages/nax-agent && bun run typecheck && bun run lint:fix && bun run check:all && bun ../repo-tooling/scripts/check-complexity.ts --package=.`
Expected: pass.

```bash
git add packages/nax-agent/src/session/session-interaction.ts packages/nax-agent/test/unit/session/session-interaction.test.ts
git commit -m "feat(nax-agent): agent session interaction handler routing embedder tools, coding tools and questions"
```

---
### Task 9: The turn runner and `createAgentSession`

**Files:**
- Create: `packages/nax-agent/src/session/agent-session-turn.ts`
- Create: `packages/nax-agent/src/session/agent-session.ts`
- Modify: `packages/nax-agent/src/index.ts` (export `createAgentSession`)
- Modify: `packages/nax-agent/api/nax-agent.api.txt` (`api:update`)
- Create: `packages/nax-agent/test/helpers/agent-session.ts`
- Test: `packages/nax-agent/test/unit/session/agent-session-chat.test.ts`

**Interfaces:**
- Consumes everything from Tasks 1 and 3-8.
- Produces:
  - `createAgentSession(options: CreateAgentSessionOptions): Promise<AgentSession>` on `.`;
  - `claimTurn(ctx: TurnRunContext, message: string, hooks: ClaimTurnHooks): ClaimedTurn`;
  - `ASK_HUMAN_BUDGET = 10`.

- [ ] **Step 1: Create the shared test harness**

Create `packages/nax-agent/test/helpers/agent-session.ts`. It is imported by path (`#test/helpers/agent-session`), not through `test/helpers/index.ts`: that barrel is loaded by almost every suite and must not import facade modules.

```ts
/**
 * Shared harness for the agent session facade tests: a scripted streaming
 * provider behind _clientDeps.build, manual timers on _agentSessionDeps, and
 * readers over a send()'s events. Imported by path, not through the helpers
 * barrel, which nearly every suite loads.
 */
import type { CreateAgentSessionOptions, SessionEvent } from "@nathapp/nax-agent";
import type { Client, ClientRequest, ProtocolEvent, ResolvedModel } from "@nathapp/nax-ai";
import { _clientDeps, _resetNativeClient } from "#src/native/client";
import { createMemoryTranscriptStore } from "#src/native/session/memory-transcript-store";
import { _agentSessionDeps } from "#src/session/agent-session-deps";

export const MODEL = "openai/gpt-5.4-mini";

const RESOLVED: ResolvedModel = {
  id: "gpt-5.4-mini",
  provider: "openai",
  protocol: "openai-responses",
  pricing: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  supportsTools: true,
  thinkingLevels: [],
};

const REAL_BUILD = _clientDeps.build;

export type Round = readonly ProtocolEvent[] | ((req: ClientRequest) => AsyncIterable<ProtocolEvent>);

export interface ScriptedProvider {
  readonly requests: ClientRequest[];
  /** Replies, one per round-trip request, in order. */
  push(...rounds: Round[]): void;
}

export function textRound(text: string): ProtocolEvent[] {
  return [
    { type: "text-delta", text },
    { type: "usage", usage: { inputTokens: 5, outputTokens: 2 } },
    { type: "done", stopReason: "stop" },
  ];
}

export function toolRound(calls: ReadonlyArray<{ id: string; name: string; input: Record<string, unknown> }>): ProtocolEvent[] {
  return [
    ...calls.map((call): ProtocolEvent => ({ type: "tool-call", call })),
    { type: "usage", usage: { inputTokens: 4, outputTokens: 2 } },
    { type: "done", stopReason: "tool_use" },
  ];
}

export function installScriptedProvider(): ScriptedProvider {
  const requests: ClientRequest[] = [];
  let queue: readonly Round[] = [];
  const client: Client = {
    model: async () => RESOLVED,
    listModels: async () => [RESOLVED],
    pricing: () => RESOLVED.pricing,
    stream(_model, req) {
      requests.push(req);
      const [round, ...rest] = queue;
      queue = rest;
      if (round === undefined) throw new Error(`no scripted reply for request ${requests.length}`);
      if (typeof round === "function") return round(req);
      return (async function* replay() {
        yield* round;
      })();
    },
    complete: async () => {
      throw new Error("round trips must stream");
    },
    validate: () => {},
  };
  _resetNativeClient();
  _clientDeps.build = async () => client;
  return {
    requests,
    push: (...rounds) => {
      queue = [...queue, ...rounds];
    },
  };
}

/** Pair with afterEach: restores the preload's client builder and drops the memoised client. */
export function resetScriptedProvider(): void {
  _clientDeps.build = REAL_BUILD;
  _resetNativeClient();
}

export interface ManualTimers {
  /** Fires every pending timer armed with exactly `ms`; returns how many fired. */
  fire(ms: number): number;
  pendingDelays(): number[];
}

/** Replaces the facade's timers. Pair with withDepsRestore(_agentSessionDeps). */
export function installManualTimers(): ManualTimers {
  const pending = new Map<number, { readonly fn: () => void; readonly ms: number }>();
  let nextId = 1;
  _agentSessionDeps.setTimeout = (fn: () => void, ms: number): unknown => {
    const id = nextId++;
    pending.set(id, { fn, ms });
    return id;
  };
  _agentSessionDeps.clearTimeout = (handle: unknown): void => {
    pending.delete(Number(handle));
  };
  return {
    fire(ms) {
      let fired = 0;
      for (const [id, timer] of [...pending]) {
        if (timer.ms !== ms) continue;
        pending.delete(id);
        timer.fn();
        fired += 1;
      }
      return fired;
    },
    pendingDelays: () => [...pending.values()].map((timer) => timer.ms),
  };
}

export function sessionOptions(extra: Partial<CreateAgentSessionOptions> = {}): CreateAgentSessionOptions {
  return { backend: "native", model: MODEL, profile: "none", transcriptStore: createMemoryTranscriptStore(), ...extra };
}

export async function collect(iterable: AsyncIterable<SessionEvent>): Promise<SessionEvent[]> {
  const out: SessionEvent[] = [];
  for await (const event of iterable) out.push(event);
  return out;
}

export interface EventReader {
  /** Reads up to and including the first event of `type`. */
  until(type: SessionEvent["type"]): Promise<SessionEvent[]>;
  /** Reads everything that is left. */
  rest(): Promise<SessionEvent[]>;
}

export function reader(iterable: AsyncIterable<SessionEvent>): EventReader {
  const iterator = iterable[Symbol.asyncIterator]();
  return {
    async until(type) {
      const seen: SessionEvent[] = [];
      for (;;) {
        const next = await iterator.next();
        if (next.done === true) {
          throw new Error(`stream ended before a ${type} event; saw ${seen.map((event) => event.type).join(", ")}`);
        }
        seen.push(next.value);
        if (next.value.type === type) return seen;
      }
    },
    async rest() {
      const out: SessionEvent[] = [];
      for (;;) {
        const next = await iterator.next();
        if (next.done === true) return out;
        out.push(next.value);
      }
    },
  };
}

export function types(events: readonly SessionEvent[]): string[] {
  return events.map((event) => event.type);
}

export function eventsOf<T extends SessionEvent["type"]>(
  events: readonly SessionEvent[],
  type: T,
): Extract<SessionEvent, { type: T }>[] {
  return events.filter((event): event is Extract<SessionEvent, { type: T }> => event.type === type);
}

export function turnEndOf(events: readonly SessionEvent[]): Extract<SessionEvent, { type: "turn_end" }> {
  const [end] = eventsOf(events, "turn_end");
  if (end === undefined) throw new Error(`no turn_end in ${types(events).join(", ")}`);
  return end;
}

/** Waits (macrotask turns, no sleeping) until `lastTurn` changes from `before`. */
export async function untilSettled(session: { readonly lastTurn: unknown }, before: unknown): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (session.lastTurn !== before) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("the turn did not settle");
}
```

- [ ] **Step 2: Write the failing chat test**

Create `packages/nax-agent/test/unit/session/agent-session-chat.test.ts`:

```ts
/**
 * S3-4: createAgentSession end to end against a scripted streaming provider
 * (spec 4.1, 4.2, 4.4, 5.5). Multi-turn chat with history, the event shape,
 * the system prompt, the advertised tools per profile, the markTurn write
 * order, single-flight, close, and turn failures as turn_end.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, type EmbedderTool, type SessionEvent, type TranscriptStore } from "@nathapp/nax-agent";
import { createMemoryTranscriptStore } from "#src/native/session/memory-transcript-store";
import { _agentSessionDeps } from "#src/session/agent-session-deps";
import {
  collect,
  installScriptedProvider,
  resetScriptedProvider,
  sessionOptions,
  textRound,
  turnEndOf,
  types,
} from "#test/helpers/agent-session";
import { assertNaxError, withDepsRestore } from "#test/helpers/index";

afterEach(resetScriptedProvider);

function expectCode(fn: () => unknown, code: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  assertNaxError(caught);
  expect(caught.code).toBe(code);
}

async function rejectsWith(promise: Promise<unknown>, code: string): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  assertNaxError(caught);
  expect(caught.code).toBe(code);
}

const lookup: EmbedderTool = {
  name: "lookup",
  description: "look a record up",
  inputSchema: { type: "object" },
  approval: "never",
  async run() {
    return { content: "record" };
  },
};

function spyStore(): { store: TranscriptStore; calls: string[] } {
  const inner = createMemoryTranscriptStore();
  const calls: string[] = [];
  const store: TranscriptStore = {
    load: (id) => {
      calls.push("load");
      return inner.load(id);
    },
    save: (id, doc) => {
      calls.push("save");
      return inner.save(id, doc);
    },
    retainFailed: (id) => {
      calls.push("retainFailed");
      return inner.retainFailed(id);
    },
    delete: (id) => {
      calls.push("delete");
      return inner.delete(id);
    },
    markTurn: (id, marker) => {
      calls.push(`markTurn:${marker.state}`);
      return inner.markTurn(id, marker);
    },
  };
  return { store, calls };
}

describe("createAgentSession: chat", () => {
  test("two turns stream deltas and usage, end with turn_end, and carry history", async () => {
    const provider = installScriptedProvider();
    provider.push(textRound("Hello"), textRound("Again"));
    const session = await createAgentSession(sessionOptions({ sessionId: "chat-1", metadata: { tenant: "t1" } }));
    const first = await collect(session.send("hi"));
    expect(types(first)).toEqual(["turn_start", "text_delta", "usage", "turn_end"]);
    const end = turnEndOf(first);
    expect(end).toMatchObject({ status: "completed", output: "Hello", usage: { inputTokens: 5, outputTokens: 2 } });
    expect(end.error).toBeUndefined();
    for (const event of first) {
      expect(event.sessionId).toBe("chat-1");
      expect(event.turnId).toBe(end.turnId);
      expect(event.metadata).toEqual({ tenant: "t1" });
      expect(Number.isNaN(Date.parse(event.at))).toBe(false);
    }
    expect(session.lastTurn).toEqual({ turnId: end.turnId, status: "completed" });

    const second = await collect(session.send("again"));
    expect(turnEndOf(second).output).toBe("Again");
    expect(turnEndOf(second).turnId).not.toBe(end.turnId);
    expect(provider.requests[1]?.messages).toEqual([
      { role: "user", content: "hi" },
      expect.objectContaining({ role: "assistant", content: "Hello" }),
      { role: "user", content: "again" },
    ]);
    await session.close();
  });

  test("instructions reach the provider as the system field", async () => {
    const provider = installScriptedProvider();
    provider.push(textRound("ok"));
    const session = await createAgentSession(sessionOptions({ instructions: "Answer in one word." }));
    await collect(session.send("hi"));
    expect(provider.requests[0]?.system).toBe("Answer in one word.");
    await session.close();
  });

  test("the none profile advertises the scratchpad trio, embedder tools and ask_human; read adds the read tools", async () => {
    const provider = installScriptedProvider();
    provider.push(textRound("a"), textRound("b"));
    const none = await createAgentSession(sessionOptions({ tools: [lookup] }));
    await collect(none.send("hi"));
    expect(provider.requests[0]?.tools?.map((tool) => tool.name).sort()).toEqual(
      ["ScratchpadList", "ScratchpadRead", "ScratchpadWrite", "ask_human", "lookup"].sort(),
    );
    const workdir = await mkdtemp(join(tmpdir(), "nax-agent-session-read-"));
    const read = await createAgentSession(sessionOptions({ profile: "read", workdir }));
    await collect(read.send("hi"));
    expect(provider.requests[1]?.tools?.map((tool) => tool.name).sort()).toEqual(
      ["Git", "Glob", "Grep", "Read", "ScratchpadList", "ScratchpadRead", "ScratchpadWrite", "ask_human"].sort(),
    );
    await none.close();
    await read.close();
  });

  test("write order per turn is markTurn(running), the loop's save, markTurn(ended); close keeps the document", async () => {
    const provider = installScriptedProvider();
    provider.push(textRound("ok"));
    const { store, calls } = spyStore();
    const session = await createAgentSession(sessionOptions({ transcriptStore: store }));
    const events = await collect(session.send("hi"));
    expect(calls.filter((call) => call !== "load" && call !== "delete")).toEqual([
      "markTurn:running",
      "save",
      "markTurn:ended",
    ]);
    const before = calls.length;
    await session.close();
    expect(calls.slice(before)).toEqual([]);
    const doc = await store.load(session.id);
    expect(doc?.turn).toEqual({ turnId: turnEndOf(events).turnId, state: "ended" });
    expect(doc?.messages).toHaveLength(2);
  });

  test("a sessionId that already has a document is refused, and the document is untouched", async () => {
    const store = createMemoryTranscriptStore();
    await store.save("taken", { savedAt: "2026-10-04T00:00:00.000Z", messages: [{ role: "user", content: "old" }] });
    await rejectsWith(createAgentSession(sessionOptions({ sessionId: "taken", transcriptStore: store })), "AGENT_SESSION_EXISTS");
    expect((await store.load("taken"))?.messages).toEqual([{ role: "user", content: "old" }]);
  });

  test("a workdir that is not a directory is an invalid option", async () => {
    await rejectsWith(
      createAgentSession(sessionOptions({ profile: "read", workdir: "/nonexistent/nax-agent-session" })),
      "AGENT_SESSION_INVALID_OPTIONS",
    );
  });
});

describe("createAgentSession: single flight and close", () => {
  withDepsRestore(_agentSessionDeps);

  test("a claimed turn makes send busy; the iterable is single-use; cancel releases an unstarted claim", async () => {
    const provider = installScriptedProvider();
    provider.push(textRound("ok"));
    const session = await createAgentSession(sessionOptions());
    const claimed = session.send("never iterated");
    expectCode(() => session.send("second"), "AGENT_SESSION_BUSY");
    session.cancel();
    expect(await collect(claimed)).toEqual([]);
    expectCode(() => claimed[Symbol.asyncIterator](), "AGENT_SESSION_BUSY");
    const events = await collect(session.send("third"));
    expect(turnEndOf(events).status).toBe("completed");
    await session.close();
  });

  test("send() from inside the loop on turn_end succeeds: the slot is free before turn_end arrives", async () => {
    const provider = installScriptedProvider();
    provider.push(textRound("one"), textRound("two"));
    const session = await createAgentSession(sessionOptions());
    let second: SessionEvent[] = [];
    for await (const event of session.send("first")) {
      if (event.type === "turn_end") second = await collect(session.send("second"));
    }
    expect(turnEndOf(second).output).toBe("two");
    await session.close();
  });

  test("close is idempotent, removes the private root, and later sends and answers are refused", async () => {
    installScriptedProvider();
    const removed: string[] = [];
    const realRemove = _agentSessionDeps.removeScratchRoot;
    _agentSessionDeps.removeScratchRoot = async (dir) => {
      removed.push(dir);
      await realRemove(dir);
    };
    const session = await createAgentSession(sessionOptions());
    const a = session.close();
    const b = session.close();
    expect(a).toBe(b);
    await a;
    expect(removed).toHaveLength(1);
    expect(existsSync(removed[0] ?? "")).toBe(false);
    expectCode(() => session.send("hi"), "AGENT_SESSION_CLOSED");
    expect(session.answer("anything", { decision: "allow" })).toBe("unknown");
  });
});

describe("createAgentSession: turn failures arrive as turn_end", () => {
  test("a provider auth fault ends the turn errored with the adapter outcome", async () => {
    const provider = installScriptedProvider();
    provider.push([{ type: "error", error: { kind: "auth", message: "bad key" } }]);
    const session = await createAgentSession(sessionOptions());
    const end = turnEndOf(await collect(session.send("hi")));
    expect(end.status).toBe("errored");
    expect(end.error?.code).toBe("fail-auth");
    expect(session.lastTurn?.status).toBe("errored");
    await session.close();
  });

  test("a store whose markTurn throws fails the turn before any model call", async () => {
    const provider = installScriptedProvider();
    const inner = createMemoryTranscriptStore();
    const store: TranscriptStore = {
      load: (id) => inner.load(id),
      save: (id, doc) => inner.save(id, doc),
      retainFailed: (id) => inner.retainFailed(id),
      delete: (id) => inner.delete(id),
      markTurn: async () => {
        throw new Error("disk full");
      },
    };
    const session = await createAgentSession(sessionOptions({ transcriptStore: store }));
    const end = turnEndOf(await collect(session.send("hi")));
    expect(end).toMatchObject({ status: "errored", error: { code: "AGENT_SESSION_TURN_FAILED", message: "disk full" } });
    expect(provider.requests).toHaveLength(0);
    await session.close();
  });
});
```

`TranscriptStore` is already on `.` (S3-1). If it is not, import it from `#src/native/session/transcript-types`.

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd packages/nax-agent && bun test ./test/unit/session/agent-session-chat.test.ts --timeout=60000`
Expected: FAIL. `createAgentSession` is not exported from `@nathapp/nax-agent`, so it is undefined and every test fails with "createAgentSession is not a function".

- [ ] **Step 4: Implement the turn runner**

Create `packages/nax-agent/src/session/agent-session-turn.ts`:

```ts
/**
 * One turn of an agent session (spec 4.2, 4.4, 5.5, 6.1). claimTurn takes the
 * session's single-flight slot synchronously; the turn starts on the
 * consumer's first next(). Write order: markTurn(running), sendTurn (the loop
 * saves), markTurn(ended), then turn_end. The slot is released before
 * turn_end is emitted, so a consumer may send() again on seeing it. A turn
 * never throws to the consumer: every failure becomes turn_end.
 */
import type { TokenUsage } from "#src/cost/standard-types";
import { NaxError } from "#src/infra/nax-error";
import type { LoopHandlerContext, LoopHandlerSet } from "#src/native/session/loop-events/types";
import type { TranscriptStore } from "#src/native/session/transcript-types";
import { readNativeTurnFailureUsage } from "#src/native/session/turn-types";
import type { CodingTool } from "#src/tools/registry";
import { _agentSessionDeps } from "./agent-session-deps.ts";
import { AgentSessionError } from "./agent-session-errors.ts";
import type { SessionEvent, SessionEventBody, TurnEndStatus } from "./agent-session-types.ts";
import type { InteractionHandler } from "./interaction-handler.ts";
import { createSessionEventChannel } from "./session-event-channel.ts";
import { type AgentSessionAdapter, type SessionHandle, SessionTurnError, type TurnResult } from "./session-types.ts";

/** The ask_human budget per turn: nax's agent.maxInteractionTurns default. */
export const ASK_HUMAN_BUDGET = 10;

const ZERO_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0 };

export interface TurnRunContext {
  readonly sessionId: string;
  readonly adapter: AgentSessionAdapter;
  readonly handle: SessionHandle;
  readonly store: TranscriptStore;
  readonly codingTools: readonly CodingTool[];
  readonly interactionHandler: InteractionHandler;
  readonly loopHandlers: LoopHandlerSet | undefined;
  readonly loopHandlerContext: LoopHandlerContext;
  readonly turnTimeoutSeconds: number;
  readonly metadata: Readonly<Record<string, string>>;
}

/** The running turn, as the ask link and the interaction handler see it. */
export interface LiveTurn {
  readonly turnId: string;
  readonly signal: AbortSignal;
  emit(body: SessionEventBody): void;
}

export interface ClaimedTurn {
  readonly turnId: string;
  readonly iterable: AsyncIterable<SessionEvent>;
  /** Resolves once the turn has ended, or at once for a claim voided before it started. */
  readonly settled: Promise<void>;
  cancel(reason: string): void;
}

export interface ClaimTurnHooks {
  readonly onStart: (live: LiveTurn) => void;
  /** Runs before turn_end is emitted. `status` is undefined for a voided claim. */
  readonly onSettle: (turnId: string, status: TurnEndStatus | undefined) => void;
}

type TurnEndBody = Extract<SessionEventBody, { readonly type: "turn_end" }>;

interface TurnFlags {
  stalled: boolean;
  timedOut: boolean;
}

function abortReason(code: string, message: string): NaxError {
  return new NaxError(message, code, { stage: "agent-session" });
}

function fromResult(result: TurnResult): TurnEndBody {
  return {
    type: "turn_end",
    status: result.timedOut === true ? "timed_out" : "completed",
    output: result.output,
    usage: result.tokenUsage,
    costUsd: result.exactCostUsd ?? result.estimatedCostUsd,
  };
}

function errorOf(err: unknown): { readonly code: string; readonly message: string } {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof SessionTurnError && err.adapterFailure !== undefined) {
    return { code: err.adapterFailure.outcome, message };
  }
  if (err instanceof NaxError) return { code: err.code, message };
  return { code: "AGENT_SESSION_TURN_FAILED", message };
}

function spendOf(err: unknown): { readonly usage: TokenUsage; readonly costUsd: number } {
  const recorded = readNativeTurnFailureUsage(err);
  if (recorded !== undefined) return { usage: recorded.tokenUsage, costUsd: recorded.costUsd };
  if (err instanceof SessionTurnError) return { usage: err.tokenUsage ?? ZERO_USAGE, costUsd: err.estimatedCostUsd ?? 0 };
  return { usage: ZERO_USAGE, costUsd: 0 };
}

function fromError(err: unknown, flags: TurnFlags, signal: AbortSignal): TurnEndBody {
  const base = { type: "turn_end" as const, output: "", ...spendOf(err) };
  if (flags.stalled) {
    const message = `More than ${_agentSessionDeps.controlEventCap} control events went undelivered; the turn was cancelled.`;
    return { ...base, status: "errored", error: { code: "AGENT_SESSION_CONSUMER_STALLED", message } };
  }
  if (flags.timedOut) return { ...base, status: "timed_out" };
  if (signal.aborted) return { ...base, status: "cancelled" };
  return { ...base, status: "errored", error: errorOf(err) };
}

async function executeTurn(ctx: TurnRunContext, live: LiveTurn, message: string): Promise<TurnResult> {
  await ctx.store.markTurn(ctx.sessionId, { turnId: live.turnId, state: "running" });
  try {
    return await ctx.adapter.sendTurn(ctx.handle, message, {
      interactionHandler: ctx.interactionHandler,
      codingTools: ctx.codingTools,
      maxInteractions: ASK_HUMAN_BUDGET,
      turnId: live.turnId,
      signal: live.signal,
      onTurnEvent: (event) => live.emit(event),
      loopHandlerContext: ctx.loopHandlerContext,
      ...(ctx.loopHandlers !== undefined ? { loopHandlers: ctx.loopHandlers } : {}),
    });
  } finally {
    await ctx.store.markTurn(ctx.sessionId, { turnId: live.turnId, state: "ended" });
  }
}

async function runTurn(ctx: TurnRunContext, live: LiveTurn, message: string, flags: TurnFlags): Promise<TurnEndBody> {
  live.emit({ type: "turn_start" });
  try {
    return fromResult(await executeTurn(ctx, live, message));
  } catch (err) {
    return fromError(err, flags, live.signal);
  }
}

function singleUse(iterator: AsyncIterator<SessionEvent>, sessionId: string): AsyncIterable<SessionEvent> {
  let taken = false;
  return {
    [Symbol.asyncIterator]() {
      if (taken) {
        throw new AgentSessionError("send() returns a single-use iterable; iterate it once", "AGENT_SESSION_BUSY", {
          sessionId,
        });
      }
      taken = true;
      return iterator;
    },
  };
}

export function claimTurn(ctx: TurnRunContext, message: string, hooks: ClaimTurnHooks): ClaimedTurn {
  const turnId = _agentSessionDeps.randomUUID();
  const controller = new AbortController();
  const flags: TurnFlags = { stalled: false, timedOut: false };
  let state: "claimed" | "running" | "settled" = "claimed";
  let resolveSettled: () => void = () => {};
  const settled = new Promise<void>((resolve) => {
    resolveSettled = resolve;
  });

  const channel = createSessionEventChannel({
    controlCap: _agentSessionDeps.controlEventCap,
    onFirstPull: () => start(),
    onReturn: () => controller.abort(abortReason("AGENT_SESSION_CANCELLED", "iterator closed")),
    onStall: () => {
      flags.stalled = true;
      controller.abort(abortReason("AGENT_SESSION_CONSUMER_STALLED", "consumer stalled"));
    },
  });
  const emit = (body: SessionEventBody): void => {
    const at = new Date(_agentSessionDeps.now()).toISOString();
    channel.push({ sessionId: ctx.sessionId, turnId, at, metadata: ctx.metadata, ...body });
  };
  const live: LiveTurn = { turnId, signal: controller.signal, emit };

  function settle(end: TurnEndBody | undefined): void {
    state = "settled";
    hooks.onSettle(turnId, end?.status);
    if (end !== undefined) emit(end);
    channel.end();
    resolveSettled();
  }

  function start(): void {
    if (state !== "claimed") return;
    state = "running";
    const timer = _agentSessionDeps.setTimeout(() => {
      flags.timedOut = true;
      controller.abort(abortReason("AGENT_SESSION_TURN_TIMEOUT", "turn deadline"));
    }, ctx.turnTimeoutSeconds * 1000);
    hooks.onStart(live);
    void runTurn(ctx, live, message, flags).then((end) => {
      _agentSessionDeps.clearTimeout(timer);
      settle(end);
    });
  }

  function cancel(reason: string): void {
    if (state === "claimed") settle(undefined);
    else if (state === "running") controller.abort(abortReason("AGENT_SESSION_CANCELLED", reason));
  }

  return { turnId, iterable: singleUse(channel.iterator, ctx.sessionId), settled, cancel };
}
```

- [ ] **Step 5: Implement the facade**

Create `packages/nax-agent/src/session/agent-session.ts`:

```ts
/**
 * createAgentSession: the conversational session facade (S3 spec 4, 5.1).
 * One NativeSessionAdapter per session. The facade fills the S1
 * OpenSessionOpts itself and talks to the backend through the S1 contract
 * only (openSession, sendTurn, closeSession), so the acpx backend (S4) slots
 * in behind the same API. resumeAgentSession follows in S3-5.
 */
import { NATIVE_AGENT } from "#src/native/models";
import { NativeSessionAdapter } from "#src/native/session-adapter";
import { _agentSessionDeps } from "./agent-session-deps.ts";
import { AgentSessionError } from "./agent-session-errors.ts";
import { type ResolvedAgentSessionOptions, resolveAgentSessionOptions } from "./agent-session-options.ts";
import { type ClaimedTurn, claimTurn, type LiveTurn, type TurnRunContext } from "./agent-session-turn.ts";
import type {
  AgentSession,
  AnswerReply,
  AnswerStatus,
  CreateAgentSessionOptions,
  SessionEvent,
  TurnEndStatus,
} from "./agent-session-types.ts";
import { createPendingAskTable, type PendingAskTable } from "./pending-asks.ts";
import { createSessionAskLink, createSessionAskResolver, type SessionAskDeps } from "./session-ask-link.ts";
import { createSessionInteractionHandler, embedderToolDescriptor } from "./session-interaction.ts";
import { buildSessionToolSupport, defaultProtectedPaths, resolveSessionLauncher } from "./session-tool-support.ts";

/** The running turn and the tool call being answered: what the ask link and the handler read. */
interface LiveSlot {
  turn: LiveTurn | undefined;
  callId: string | undefined;
}

/** The handler's turn signal between turns: never aborts. */
const IDLE_SIGNAL = new AbortController().signal;

interface SessionRoot {
  readonly dir: string;
  readonly cleanup: () => Promise<void>;
}

interface SessionParts {
  readonly ctx: TurnRunContext;
  readonly table: PendingAskTable;
  readonly slot: LiveSlot;
  readonly cleanup: () => Promise<void>;
}

class NativeAgentSession implements AgentSession {
  private active: ClaimedTurn | undefined;
  private last: { readonly turnId: string; readonly status: TurnEndStatus } | undefined;
  private closing: Promise<void> | undefined;

  constructor(private readonly parts: SessionParts) {}

  get id(): string {
    return this.parts.ctx.sessionId;
  }

  get lastTurn(): { readonly turnId: string; readonly status: TurnEndStatus } | undefined {
    return this.last;
  }

  send(message: string): AsyncIterable<SessionEvent> {
    if (this.closing !== undefined) {
      throw new AgentSessionError(`Session "${this.id}" is closed`, "AGENT_SESSION_CLOSED", { sessionId: this.id });
    }
    if (this.active !== undefined) {
      throw new AgentSessionError(`Session "${this.id}" already has a turn in flight`, "AGENT_SESSION_BUSY", {
        sessionId: this.id,
      });
    }
    const turn = claimTurn(this.parts.ctx, message, {
      onStart: (live) => {
        this.parts.slot.turn = live;
      },
      onSettle: (turnId, status) => {
        this.active = undefined;
        this.parts.slot.turn = undefined;
        if (status !== undefined) this.last = { turnId, status };
      },
    });
    this.active = turn;
    return turn.iterable;
  }

  answer(requestId: string, reply: AnswerReply): AnswerStatus {
    return this.parts.table.answer(requestId, reply);
  }

  cancel(reason = "cancelled"): void {
    this.active?.cancel(reason);
  }

  close(): Promise<void> {
    this.closing ??= this.shutdown();
    return this.closing;
  }

  private async shutdown(): Promise<void> {
    const active = this.active;
    this.parts.table.close();
    active?.cancel("session closed");
    await active?.settled;
    try {
      await this.parts.ctx.adapter.closeSession(this.parts.ctx.handle);
    } finally {
      await this.parts.cleanup();
    }
  }
}

async function sessionRoot(options: ResolvedAgentSessionOptions): Promise<SessionRoot> {
  const workdir = options.raw.workdir;
  if (workdir === undefined) {
    const dir = await _agentSessionDeps.makeScratchRoot();
    return { dir, cleanup: () => _agentSessionDeps.removeScratchRoot(dir) };
  }
  if (!(await _agentSessionDeps.isDirectory(workdir))) {
    throw new AgentSessionError(
      `Invalid agent session options: workdir "${workdir}" is not a directory`,
      "AGENT_SESSION_INVALID_OPTIONS",
      { path: "workdir" },
    );
  }
  return { dir: workdir, cleanup: async () => {} };
}

function createAdapter(options: ResolvedAgentSessionOptions): NativeSessionAdapter {
  const overrides = options.raw.catalogOverrides ?? [];
  const credentials = options.raw.credentials;
  // A session with its own catalog or credentials owns its client; the rest share the process memo.
  const owns = overrides.length > 0 || credentials !== undefined;
  return new NativeSessionAdapter(overrides, {
    ...(credentials !== undefined ? { credentials } : {}),
    ...(owns ? { ownClient: true } : {}),
  });
}

async function assemble(options: ResolvedAgentSessionOptions, sessionId: string, root: SessionRoot): Promise<AgentSession> {
  const raw = options.raw;
  const protectedPaths = raw.hostPorts?.protectedPaths ?? defaultProtectedPaths(raw.credentials !== undefined);
  const launcher = await resolveSessionLauncher({
    profile: raw.profile,
    root: root.dir,
    protectedPaths,
    bashApproval: options.bashApproval,
    allowUnsandboxed: options.allowUnsandboxed,
  });
  const table = createPendingAskTable(options.approvalTimeoutMs);
  const slot: LiveSlot = { turn: undefined, callId: undefined };
  const asks: SessionAskDeps = { table, emit: (body) => slot.turn?.emit(body), currentCallId: () => slot.callId };
  const { support, grants } = buildSessionToolSupport({
    profile: raw.profile,
    root: root.dir,
    sessionName: sessionId,
    protectedPaths,
    bashApproval: options.bashApproval,
    launcher,
    askResolver: createSessionAskResolver(createSessionAskLink(asks)),
    interceptor: raw.hostPorts?.commandInterceptor,
  });
  const interactionHandler = createSessionInteractionHandler({
    sessionId,
    runtime: support.runtime,
    embedderTools: new Map(options.tools.map((tool) => [tool.name, tool])),
    asks,
    turnSignal: () => slot.turn?.signal ?? IDLE_SIGNAL,
    setCurrentCallId: (callId) => {
      slot.callId = callId;
    },
  });
  const adapter = createAdapter(options);
  const handle = await adapter.openSession(sessionId, {
    agentName: NATIVE_AGENT,
    workdir: root.dir,
    resolvedPermissions: { mode: "default", toolGrants: grants, bashApproval: options.bashApproval },
    modelDef: { provider: options.provider, model: raw.model },
    timeoutSeconds: options.turnTimeoutSeconds,
    transcriptStore: raw.transcriptStore,
    retainOnClose: true,
    ...(raw.instructions !== undefined ? { systemPrompt: raw.instructions } : {}),
  });
  const ctx: TurnRunContext = {
    sessionId,
    adapter,
    handle,
    store: raw.transcriptStore,
    codingTools: [...support.tools, ...options.tools.map(embedderToolDescriptor)],
    interactionHandler,
    loopHandlers: raw.loopHandlers,
    loopHandlerContext: { sessionName: sessionId, workdir: root.dir, model: raw.model, provider: options.provider },
    turnTimeoutSeconds: options.turnTimeoutSeconds,
    metadata: options.metadata,
  };
  return new NativeAgentSession({ ctx, table, slot, cleanup: root.cleanup });
}

export async function createAgentSession(input: CreateAgentSessionOptions): Promise<AgentSession> {
  const options = resolveAgentSessionOptions(input);
  const sessionId = options.raw.sessionId ?? _agentSessionDeps.randomUUID();
  if ((await options.raw.transcriptStore.load(sessionId)) !== null) {
    throw new AgentSessionError(
      `Session "${sessionId}" already exists in the transcript store; resume it instead`,
      "AGENT_SESSION_EXISTS",
      { sessionId },
    );
  }
  const root = await sessionRoot(options);
  try {
    return await assemble(options, sessionId, root);
  } catch (err) {
    await root.cleanup();
    throw err;
  }
}
```

- [ ] **Step 6: Export `createAgentSession`**

In `packages/nax-agent/src/index.ts`, before the `#src/session/agent-session-errors` line added in Task 3 (`agent-session` sorts before `agent-session-errors`), add:

```ts
export { createAgentSession } from "#src/session/agent-session";
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `cd packages/nax-agent && bun test ./test/unit/session/agent-session-chat.test.ts --timeout=60000`
Expected: PASS (11 tests).

If the history test fails only because the assistant message carries extra fields, the `expect.objectContaining` already allows them. If the user messages carry extra fields too, wrap them in `expect.objectContaining` as well.

If the markTurn order test shows an extra `save`, read `turn-loop.ts` to find out why before changing anything. The loop saves once per clean turn (S3-1). An extra save means the store is being written twice, and that is a finding to report, not something to assert around.

- [ ] **Step 8: Gates, API snapshot and commit**

Run: `cd packages/nax-agent && bun run typecheck && bun run lint:fix && bun run check:all && bun ../repo-tooling/scripts/check-complexity.ts --package=.`
Expected: pass.

Run: `bun run check:api`, then `bun run api:update && bun run check:api`
Expected: the first run fails and lists `createAgentSession` as missing from `[.]`; after the update it passes, and the diff adds that one name.

```bash
git add packages/nax-agent/src/session/agent-session-turn.ts packages/nax-agent/src/session/agent-session.ts packages/nax-agent/src/index.ts packages/nax-agent/api/nax-agent.api.txt packages/nax-agent/test/helpers/agent-session.ts packages/nax-agent/test/unit/session/agent-session-chat.test.ts
git commit -m "feat(nax-agent): createAgentSession facade with the per-turn runner"
```

---
### Task 10: Approvals, questions, cancellation, iterator break and stall through a live session

**Files:**
- Test: `packages/nax-agent/test/unit/session/agent-session-asks.test.ts`
- Modify only if a test exposes a defect: the Task 6-9 source files.

**Interfaces:** consumes the Task 9 harness and facade; produces no new names.

This task is test-first over code that already exists. The tests pin the spec's interactive behaviour end to end (spec 8, the "Node contract" list, run here under bun). If one fails, fix the source in the module that owns the behaviour and say which module in the commit message. Do not weaken the assertion.

- [ ] **Step 1: Write the tests**

Create `packages/nax-agent/test/unit/session/agent-session-asks.test.ts`:

```ts
/**
 * S3-4: interactive behaviour through a live session (spec 4.2, 4.3, 4.4,
 * 6.1): an embedder tool approved, denied and timed out; a question answered
 * and timed out; cancel during a tool and during an approval; breaking out of
 * the iterator; close during a turn; and the stalled-consumer cap.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createAgentSession, type EmbedderTool, type EmbedderToolContext } from "@nathapp/nax-agent";
import { createMemoryTranscriptStore } from "#src/native/session/memory-transcript-store";
import { _agentSessionDeps } from "#src/session/agent-session-deps";
import {
  collect,
  eventsOf,
  installManualTimers,
  installScriptedProvider,
  reader,
  resetScriptedProvider,
  sessionOptions,
  textRound,
  toolRound,
  turnEndOf,
  types,
  untilSettled,
} from "#test/helpers/agent-session";
import { assertNaxError, withDepsRestore } from "#test/helpers/index";

const APPROVAL_MS = 600_000;

afterEach(resetScriptedProvider);

function expectCode(fn: () => unknown, code: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  assertNaxError(caught);
  expect(caught.code).toBe(code);
}

function lookupTool(approval: "never" | "always", runs: unknown[]): EmbedderTool {
  return {
    name: "lookup",
    description: "look a record up",
    inputSchema: { type: "object", properties: { id: { type: "number" } } },
    approval,
    async run(input) {
      runs.push(input);
      return { content: "record 42" };
    },
  };
}

/** An embedder tool that resolves only when its signal aborts. */
function waitingTool(seen: EmbedderToolContext[]): EmbedderTool {
  return {
    name: "wait",
    description: "wait for something",
    inputSchema: { type: "object" },
    approval: "never",
    run(_input, ctx) {
      seen.push(ctx);
      return new Promise((resolve) => {
        ctx.signal.addEventListener("abort", () => resolve({ content: "late" }), { once: true });
      });
    },
  };
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("agent session: approvals", () => {
  withDepsRestore(_agentSessionDeps);

  test("an always-approval tool asks with its call id, runs on allow, and the turn completes", async () => {
    installManualTimers();
    const provider = installScriptedProvider();
    provider.push(toolRound([{ id: "c1", name: "lookup", input: { id: 42 } }]), textRound("found it"));
    const runs: unknown[] = [];
    const session = await createAgentSession(sessionOptions({ tools: [lookupTool("always", runs)] }));
    const events = reader(session.send("find 42"));
    const upTo = await events.until("approval_requested");
    expect(types(upTo).slice(-2)).toEqual(["tool_call", "approval_requested"]);
    const [request] = eventsOf(upTo, "approval_requested");
    expect(request).toMatchObject({ callId: "c1", tool: "lookup", summary: '{"id":42}' });
    expect(runs).toHaveLength(0);
    expectCode(() => session.answer(request?.requestId ?? "", { text: "yes" }), "AGENT_SESSION_INVALID_ANSWER");
    expect(session.answer(request?.requestId ?? "", { decision: "allow" })).toBe("accepted");
    const rest = await events.rest();
    expect(eventsOf(rest, "approval_resolved")[0]).toMatchObject({ decision: "allow", decidedBy: "human" });
    expect(eventsOf(rest, "tool_result")[0]).toMatchObject({ callId: "c1", isError: false, preview: "record 42" });
    expect(turnEndOf(rest)).toMatchObject({ status: "completed", output: "found it" });
    expect(runs).toEqual([{ id: 42 }]);
    await session.close();
  });

  test("a denial reaches the model as a refusal and the tool does not run", async () => {
    installManualTimers();
    const provider = installScriptedProvider();
    provider.push(toolRound([{ id: "c1", name: "lookup", input: { id: 1 } }]), textRound("ok"));
    const runs: unknown[] = [];
    const session = await createAgentSession(sessionOptions({ tools: [lookupTool("always", runs)] }));
    const events = reader(session.send("find 1"));
    const [request] = eventsOf(await events.until("approval_requested"), "approval_requested");
    session.answer(request?.requestId ?? "", { decision: "deny" });
    const rest = await events.rest();
    expect(eventsOf(rest, "tool_result")[0]?.preview).toContain("Denied");
    expect(runs).toHaveLength(0);
    expect(turnEndOf(rest).status).toBe("completed");
    await session.close();
  });

  test("an unanswered approval times out as a denial; a later answer is expired", async () => {
    const timers = installManualTimers();
    const provider = installScriptedProvider();
    provider.push(toolRound([{ id: "c1", name: "lookup", input: {} }]), textRound("ok"));
    const runs: unknown[] = [];
    const session = await createAgentSession(sessionOptions({ tools: [lookupTool("always", runs)] }));
    const events = reader(session.send("find"));
    const [request] = eventsOf(await events.until("approval_requested"), "approval_requested");
    expect(timers.fire(APPROVAL_MS)).toBe(1);
    const rest = await events.rest();
    expect(eventsOf(rest, "approval_resolved")[0]).toMatchObject({ decision: "deny", decidedBy: "timeout" });
    expect(session.answer(request?.requestId ?? "", { decision: "allow" })).toBe("expired");
    expect(runs).toHaveLength(0);
    await session.close();
  });
});

describe("agent session: questions", () => {
  withDepsRestore(_agentSessionDeps);

  test("ask_human raises a question; the answer is the tool result the model sees", async () => {
    installManualTimers();
    const provider = installScriptedProvider();
    provider.push(toolRound([{ id: "q1", name: "ask_human", input: { text: "Which env?" } }]), textRound("ok"));
    const session = await createAgentSession(sessionOptions());
    const events = reader(session.send("deploy"));
    const [question] = eventsOf(await events.until("question"), "question");
    expect(question?.text).toBe("Which env?");
    expect(session.answer(question?.requestId ?? "", { text: "staging" })).toBe("accepted");
    expect(turnEndOf(await events.rest()).status).toBe("completed");
    expect(provider.requests[1]?.messages).toContainEqual(
      expect.objectContaining({ role: "tool-result", toolCallId: "q1", content: "staging" }),
    );
    await session.close();
  });

  test("an unanswered question times out into the loop's no-operator answer", async () => {
    const timers = installManualTimers();
    const provider = installScriptedProvider();
    provider.push(toolRound([{ id: "q1", name: "ask_human", input: { text: "?" } }]), textRound("ok"));
    const session = await createAgentSession(sessionOptions());
    const events = reader(session.send("deploy"));
    await events.until("question");
    timers.fire(APPROVAL_MS);
    await events.rest();
    const toolResult = provider.requests[1]?.messages.find((message) => message.role === "tool-result");
    expect(toolResult).toMatchObject({ isError: true });
    expect(JSON.stringify(toolResult)).toContain("No human operator");
    await session.close();
  });
});

describe("agent session: cancellation and teardown", () => {
  withDepsRestore(_agentSessionDeps);

  test("cancel during a tool aborts its signal, ends the turn cancelled, and frees the session", async () => {
    installManualTimers();
    const provider = installScriptedProvider();
    provider.push(toolRound([{ id: "c1", name: "wait", input: {} }]));
    const seen: EmbedderToolContext[] = [];
    const session = await createAgentSession(sessionOptions({ tools: [waitingTool(seen)] }));
    const events = reader(session.send("go"));
    await events.until("tool_call");
    await tick();
    session.cancel("person pressed stop");
    expect(turnEndOf(await events.rest()).status).toBe("cancelled");
    expect(seen[0]?.signal.aborted).toBe(true);
    provider.push(textRound("next"));
    expect(turnEndOf(await collect(session.send("again"))).status).toBe("completed");
    await session.close();
  });

  test("cancel during an approval resolves it as cancelled; answering it then says cancelled", async () => {
    installManualTimers();
    const provider = installScriptedProvider();
    provider.push(toolRound([{ id: "c1", name: "lookup", input: {} }]));
    const session = await createAgentSession(sessionOptions({ tools: [lookupTool("always", [])] }));
    const events = reader(session.send("go"));
    const [request] = eventsOf(await events.until("approval_requested"), "approval_requested");
    session.cancel();
    const rest = await events.rest();
    expect(eventsOf(rest, "approval_resolved")[0]).toMatchObject({ decision: "deny", decidedBy: "cancelled" });
    expect(turnEndOf(rest).status).toBe("cancelled");
    expect(session.answer(request?.requestId ?? "", { decision: "allow" })).toBe("cancelled");
    await session.close();
  });

  test("breaking out of the iterator cancels; send is busy until the turn drains; history keeps the message", async () => {
    installManualTimers();
    const provider = installScriptedProvider();
    provider.push(toolRound([{ id: "c1", name: "wait", input: {} }]));
    const store = createMemoryTranscriptStore();
    const session = await createAgentSession(sessionOptions({ transcriptStore: store, tools: [waitingTool([])] }));
    for await (const event of session.send("first")) {
      if (event.type === "tool_call") break;
    }
    expectCode(() => session.send("too soon"), "AGENT_SESSION_BUSY");
    await untilSettled(session, undefined);
    expect(session.lastTurn?.status).toBe("cancelled");
    provider.push(textRound("ok"));
    expect(turnEndOf(await collect(session.send("second"))).status).toBe("completed");
    expect((await store.load(session.id))?.messages[0]).toEqual({ role: "user", content: "first" });
    await session.close();
  });

  test("close during a turn delivers turn_end(cancelled), keeps the document, then refuses send", async () => {
    installManualTimers();
    const provider = installScriptedProvider();
    provider.push(toolRound([{ id: "c1", name: "wait", input: {} }]));
    const store = createMemoryTranscriptStore();
    const session = await createAgentSession(sessionOptions({ transcriptStore: store, tools: [waitingTool([])] }));
    const events = reader(session.send("go"));
    await events.until("tool_call");
    const closing = session.close();
    expect(turnEndOf(await events.rest()).status).toBe("cancelled");
    await closing;
    expect(await store.load(session.id)).not.toBeNull();
    expectCode(() => session.send("again"), "AGENT_SESSION_CLOSED");
  });

  test("the turn deadline ends a turn waiting on a question as timed_out", async () => {
    const timers = installManualTimers();
    const provider = installScriptedProvider();
    provider.push(toolRound([{ id: "q1", name: "ask_human", input: { text: "?" } }]));
    const session = await createAgentSession(sessionOptions({ turnTimeoutSeconds: 120 }));
    const events = reader(session.send("deploy"));
    await events.until("question");
    expect(timers.fire(120_000)).toBe(1);
    expect(turnEndOf(await events.rest()).status).toBe("timed_out");
    await session.close();
  });

  test("a consumer that stops reading is cut off at the control-event cap", async () => {
    installManualTimers();
    _agentSessionDeps.controlEventCap = 2;
    const provider = installScriptedProvider();
    provider.push(
      toolRound([
        { id: "a", name: "lookup", input: {} },
        { id: "b", name: "lookup", input: {} },
      ]),
      textRound("done"),
    );
    const session = await createAgentSession(sessionOptions({ tools: [lookupTool("never", [])] }));
    const events = reader(session.send("go"));
    await events.until("turn_start");
    await untilSettled(session, undefined);
    const end = turnEndOf(await events.rest());
    expect(end.status).toBe("errored");
    expect(end.error?.code).toBe("AGENT_SESSION_CONSUMER_STALLED");
    await session.close();
  });
});
```

- [ ] **Step 2: Run the tests**

Run: `cd packages/nax-agent && bun test ./test/unit/session/agent-session-asks.test.ts --timeout=60000`
Expected: PASS (12 tests). Earlier tasks unit-test every piece, so a failure here is an integration defect. Diagnose it before changing anything. Likely seams:
- **The approval summary.** `'{"id":42}'` comes from `defaultSummary`. If the loop passes a rewritten input, it is the `before_tool` rewrite; check `repairInvalidCall`.
- **Timer fire counts.** `timers.fire(APPROVAL_MS)` must fire exactly the one ask timer. If it fires 0, the table armed its timer through the real `setTimeout`, so check that `pending-asks.ts` uses `_agentSessionDeps.setTimeout`.
- **The iterator break.** If `untilSettled` times out, `onReturn` did not abort. Check `claimTurn`'s channel options.
- **The stall.** If the turn completes instead, the channel's `controlCap` was read before the test lowered it. `claimTurn` reads `_agentSessionDeps.controlEventCap` per turn; keep it that way.

- [ ] **Step 3: Full package suite, coverage and gates**

Run: `cd packages/nax-agent && bun run test && bun run typecheck && bun run check:all && bun run check:api && bun run test:coverage`
Expected: all pass. Every new `src/session/*.ts` file is at 80% or more lines and functions. If a file is under 80%, add a unit test to that file's own test file, not to the facade tests. Coverage floors are never lowered.

- [ ] **Step 4: Commit**

```bash
git add packages/nax-agent/test/unit/session/agent-session-asks.test.ts
git commit -m "test(nax-agent): agent session approvals, questions, cancellation and stall end to end"
```

If Step 2 needed a source fix, add those files to the same commit and change the message to `fix(nax-agent): <what> in <module> (found by the agent session interaction tests)`.

---

### Task 11: Spec amendments and whole-branch verification

**Files:**
- Modify: `docs/superpowers/specs/2026-10-03-s3-conversational-session-api-design.md`

**Interfaces:** none.

- [ ] **Step 1: Amend the spec to match what shipped**

In `docs/superpowers/specs/2026-10-03-s3-conversational-session-api-design.md`:

1. At the end of §4.1's bullet list (after the `loopHandlers` bullet), add:

```markdown
- **As built (S3-4):** `instructions` is sent as the request's top-level `system` through a new optional
  `OpenSessionOpts.systemPrompt` (nax-ai's `ConversationMessage` has no system role). `workdir` is optional for `none`;
  the facade then uses a private temporary root, removed on `close()`. `bashApproval` and `allowUnsandboxed` are rejected
  outside `full`, and `allowUnsandboxed` requires `bashApproval: "gated"`. `hostPorts.runDeclaredCommand` is deferred
  (RunCommand needs a declared-command catalogue); `lastTurn` is `{...} | undefined` rather than optional.
```

2. Replace the first bullet of §4.3 (the one starting "The facade builds a `CodingTool` ... `extraTools`") with:

```markdown
- **As built (S3-4):** the facade appends a descriptor-only `CodingTool` per embedder tool to `SendTurnOpts.codingTools`
  and runs the embedder's `run` from its own `InteractionHandler`, which receives the `toolCallId` and the turn signal on
  the `coding-tool` request. It does not use the runtime's `extraTools`, which would let a name shadow a built-in. A
  failed embedder tool (`isError: true` or a throw) is reported by throwing from the handler; the tool batch records the
  message as an `isError` result. The model sees the tool's own `name`. (The `ProviderTool` route,
  `tools/provider-adapt.ts`, namespaces names as `<providerId>__<localName>` and is not used here.)
```

3. At the end of §5.4, add:

```markdown
**As built (S3-3).** `compaction.reason` is `"proactive" | "overflow"`. The compaction summary emits no `usage` (turn
totals come from `TurnResult`). `ask_human`, and calls the loop answers without running (spin stop, cancel, the invalid
call budget), emit no tool events. Redaction and byte caps (`tool_call.input` 8192, `tool_result.preview` 4096) are
applied in the backend at the sink, best-effort. `stream_reset` is emitted by the loop's per-attempt request wrapper.
`tool_call.input` redaction cuts each string to the scan size first (S3-4).
```

4. In §5.5's `TranscriptStore` interface, change `retainFailed(sessionId: string, doc: TranscriptDoc): Promise<void>;` to `retainFailed(sessionId: string): Promise<void>;`. Then add after the interface block: `As built (S3-1): \`retainFailed\` takes no document; it moves the stored one aside.`

5. In §7's table, add a row after `AGENT_SESSION_CONSUMER_STALLED`:

```markdown
| `AGENT_SESSION_TURN_FAILED` | `turn_end.error.code` for a turn failure with no adapter outcome or nax-agent code (S3-4); provider faults carry `AdapterFailure.outcome`, nax-agent errors their own code |
```

- [ ] **Step 2: Whole-branch verification**

Run: `cd packages/nax-agent && bun run test && bun run typecheck && bun run check:all && bun run check:api && bun run test:coverage && bun run test:node`
Run: `cd packages/nax && bun run test && bun run typecheck && bun run check:all`
Run (repo root): `bun run typecheck && bun run check:all`
Expected: all pass. `test:node` is unchanged by this PR; it must stay green. The facade's Node contract cases are S3-5.

Confirm nax's CLI is untouched. From `packages/nax`, `bun bin/nax.ts --help | md5` and `bun bin/nax.ts --version` must equal the same commands on `main`. Use a `main` worktree for the comparison, or stash.

Confirm the complexity ratchet held: `bun ../repo-tooling/scripts/check-complexity.ts --package=.` from `packages/nax-agent` reports `sendTurn` 21 and `runToolBatch` 59, unchanged.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-10-03-s3-conversational-session-api-design.md
git commit -m "docs(nax-agent): amend the S3 spec to the facade as built"
```

---

## Self-review notes (planner)

- **Spec coverage, S3-4 row:**
  - create (Task 9);
  - events and channel (Tasks 5 and 9);
  - `answer` (Tasks 6 and 10);
  - questions (Tasks 8 and 10);
  - embedder tools (Tasks 8 and 10);
  - profiles (Tasks 7 and 9);
  - host-port defaults (Task 7);
  - the security floor (Task 7, plus the read-deny already shipped in S3-2);
  - loop types promoted to `.` (Task 3).
- **Left to S3-5 by the spec's own delivery table:** `resumeAgentSession` and `interrupted`, the API snapshot review for 0.2.0, README and CHANGELOG, the Node contract cases, the packed smoke and the release.
- **Not covered by any task, deliberately:** a cross-session client cache, and RunCommand under `full`. Both are listed under Deviations.
- **Review Focus:** 1 is pinned in Task 4, 2 in Task 10, 3 in Tasks 6 and 10, 4 in Task 9, and 5 in Task 10.
