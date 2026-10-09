# S5-2 Session Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** make the `nax-agent` ACP server run real sessions in memory: `session/new`, `session/prompt` streaming through the S5-1 translator, `session/cancel`, permission round trips with per-session always-memory, questions through elicitation or a canned fallback, and the spec §7 error mapping.

**Architecture:** a `ServerSession` wraps one S3 `AgentSession`. A prompt is one `send()`: each event goes through the S5-1 translator to the client. Approvals and questions start client round trips in two small brokers (`permissions.ts`, `questions.ts`) without blocking the event stream. The brokers answer through `AgentSession.answer()`. A `SessionRegistry` maps ACP session ids to `ServerSession`s and opens S3 sessions through an injected `OpenSession` factory (the default factory is the native backend plus a file transcript store). `connection.ts` registers the handlers on the SDK `agent()` app. Everything that talks to the client goes through a `ClientPort`, so sessions and brokers are unit-tested without a connection.

**Tech Stack:** TypeScript ESM, `bun:test`, `@agentclientprotocol/sdk` 1.7.0 (`agent()`/`client()` builders, `AgentContext.request/notify` with `cancellationSignal`, `RequestError`), `@nathapp/nax-agent` facade (`createAgentSession`, `nativeBackend`, `createFileTranscriptStore`, `AgentSession`, `SessionEvent`, `AgentSessionError`).

**Spec:** `docs/superpowers/specs/2026-10-08-s5-acp-server-design.md` §3.1, §3.2, §4.3, §4.4, §5.3 (`session/new`, `prompt`, `cancel` rows), §7. **Master plan:** `docs/superpowers/plans/2026-10-08-s5-acp-server-master-plan.md` (Global Constraints, M-1, slice row S5-2). **Builds on:** S5-0 + S5-1, merged in #2403 (`c1319c164`).

## Global Constraints

Everything in the master plan's Global Constraints applies:
- Commands run from the package directory (`packages/nax-agent-acp`, or `packages/nax-agent` for Task 0). Never bare `bun test` with no path.
- Source files <= 600 lines, test files <= 800 lines. Per-file unit line coverage >= 80%: every new `src/` file needs unit tests.
- No `throw new Error(` in `src/`. Throw SDK `RequestError` at the protocol edge.
- No Bun APIs in `src/`.
- No `as unknown as` and no `@ts-` suppressions in tests.
- nax-agent only through `@nathapp/nax-agent`. Imports use `#src/` and `#test/`.
- Test files are named after their module (`<module>.test.ts` or `<module>-<concern>.test.ts`).
- stdout carries ACP frames only; logs go to stderr through the logger.
- `bun run lint:fix` before each commit.

Exact values from the spec:
- Permission options, in this order: `allow_once`, `allow_always`, `reject_once`, `reject_always` (spec §4.3).
- Always-memory key: the tool name, or for `execute`-kind tools the tool name plus the first word of the command (spec §4.3). Memory lives in the `ServerSession`, in memory only.
- Client permission outcome `cancelled` -> deny.
- Elicitation: one required free-text field `answer`; the question is the message. `accept` -> the answer text. `decline` or `cancel` -> `The user declined to answer.`
- No elicitation support: a warning notice carrying the question, then at once `No answer available: this client cannot answer questions. Proceed with your best judgement.`
- MCP notice: `MCP servers are not supported yet; ignored`.
- No model: `invalid_params` `no model configured: set models.native.balanced or --model`.
- Relative `cwd`: `invalid_params`.
- A prompt while a turn runs: `invalid_request` `turn in progress`.
- Unknown session id: `resource_not_found`.
- Turn end mapping: S5-1 `promptOutcome` (unchanged).
- Image and audio prompt blocks: `invalid_params`. Embedded text resources: inlined as a fenced block headed by the URI. `resource_link`: the URI only.

## Review Focus

- **A client that never answers a permission request after S3 has already resolved it** (approval timeout, or a cancel). The server must stop waiting at once and ignore the client's late reply. It must not call `answer()` for a settled request or leave a turn hanging. Task 3 tests a client that never responds plus `settled()`. Task 5 tests cancel during an open permission request.
- **A client whose `session/request_permission` or `elicitation/create` call fails** (a headless client with no handler returns method-not-found). The agent must get a deny or the no-answer text, never a 10-minute wait. Task 3 and Task 4 each test a rejecting port.
- **An embedded resource whose text contains a Markdown fence.** The inlined block must still be one block: the fence is longer than any backtick run in the text. Task 2 tests it.
- **The client connection breaking mid-turn**, so `session/update` rejects. The server must cancel the S3 turn and drain it to `turn_end`, so the session's turn slot is freed. The prompt then fails with `internal_error`; the process does not crash. Task 5 tests it.
- **Two sessions on one connection prompting at the same time.** Each streams its own updates and ends on its own. There is no global turn lock. A second prompt on the same session is rejected. Task 7 tests both over a real SDK connection.

## Decisions taken while planning

| # | Decision | Why |
|---|---|---|
| M-1 | (master plan, implemented in Task 0) `approval_requested` and `question` gain an optional `answerable?: false`, set by `recordAutoDecision` and `noteQuestion`. | Profile auto-decisions and informational questions would otherwise be shown to the user as real requests. |
| M-8 | Server tests fake the `AgentSession` interface (the seam the server consumes), with a scripted helper. They do not fake a `SessionBackend` (spec §8 says a fake backend). | The server is a thin adapter over the facade. A backend fake needs a full S1 adapter to emit deltas and asks. The facade's own semantics are covered by nax-agent's tests. Task 6 checks the default factory's arguments to `createAgentSession` and `nativeBackend`. |
| M-9 | S5-2 already uses `createFileTranscriptStore(<sessionsDir>)`. There are no metadata files and no locks yet, so sessions cannot be loaded until S5-3. | S5-3 then adds only metadata, lock and load, with no store switch. |
| M-10 | The `session/new` response carries `{ sessionId }` only. No `modes` and no `configOptions` until S5-3 implements `set_mode` and `set_config_option`. `initialize` is unchanged (`loadSession: false`, no `sessionCapabilities`). | Master plan Review Focus: never advertise something before it works. A mode picker that fails on use is that trap. |
| M-11 | Notices raised at `session/new` (the MCP notice) are queued on the session and delivered as the first updates of its first prompt. | A `session/new` response cannot carry updates. An update sent before the client has the session id may be dropped. |
| M-12 | An `execute`-kind approval without a command is never remembered. | A key of the bare tool name would turn one "always" into permission for every command. |
| M-13 | A failed client `request_permission` call is a deny. A failed elicitation is answered with the no-answer text. Both are logged at warn. | The agent is never left waiting on a client that cannot answer (spec §4.3 intent for headless clients). |
| M-14 | The question broker aborts its open elicitation at the question's `expiresAt`. | S3 settles an expired question silently (no event). Spec §7 invariant: no elicitation stays open after a timeout. |
| M-15 | `TURN_TIMEOUT_SECONDS = 3600` (S3's default) is passed to `createAgentSession` and to `promptOutcome`. | The timeout notice names the limit actually in force. |
| M-16 | S5-2 shutdown: after the connection closes, `registry.closeAll()` cancels and closes every session. There is no wait cap. S5-3 adds the 5 s cap and lock release (spec §5.5). | Without it, a running turn outlives its client. |
| M-17 | `agent.native.catalogOverrides` entries without a string `provider` and an array `models` are dropped, with one warning, before reaching `nativeBackend`. This uses a type guard, not a cast. | The S5-0 reader passes the entries through as records. `NativeCatalogOverrides` needs those two fields. |
| M-18 | `auth_required` mapping stays in S5-4 (spec §9). In S5-2, an `AGENT_SESSION_AUTH_REQUIRED` error is an `internal_error` carrying its message. | Slice boundary from the master plan. |

## File Structure

| File | Responsibility |
|---|---|
| `packages/nax-agent/src/session/agent-session-types.ts`, `session-ask-port.ts` | `answerable?: false` (Task 0). |
| `src/server/errors.ts` | Error constructors, `toRequestError`, `guard`. |
| `src/server/prompt.ts` | `flattenPrompt`: ACP content blocks -> one message. |
| `src/server/client-port.ts` | `ClientPort`, `ClientFeatures`, `clientFeatures`, `clientPort`, `untilAborted`. |
| `src/server/permissions.ts` | `createPermissionBroker`, `memoryKey`, `PERMISSION_OPTIONS`. |
| `src/server/questions.ts` | `createQuestionBroker`, answer texts. |
| `src/server/server-session.ts` | `createServerSession`, `TURN_TIMEOUT_SECONDS`. |
| `src/server/open-session.ts` | `OpenSession`, `nativeOpenSession`, `catalogOverridesFrom`. |
| `src/server/registry.ts` | `createSessionRegistry`. |
| `src/server/connection.ts`, `src/server/main.ts` | Handler registration; registry wiring and shutdown. |
| `test/helpers/recording-logger.ts`, `fake-client-port.ts`, `fake-agent-session.ts` | Test doubles. |

Tests mirror the files under `test/unit/server/`.

---

### Task 0: Mark unanswerable approvals and questions in nax-agent (M-1)

**Files:**
- Modify: `packages/nax-agent/src/session/agent-session-types.ts` (the `approval_requested` and `question` members of `SessionEventBody`)
- Modify: `packages/nax-agent/src/session/session-ask-port.ts` (`recordAutoDecision`, `noteQuestion`)
- Modify: `packages/nax-agent/api/nax-agent.api.txt` (via `bun run api:update`)
- Test: `packages/nax-agent/test/unit/session/session-ask-port.test.ts`

**Interfaces:**
- Produces: `SessionEventBody` members `approval_requested` and `question` each gain `readonly answerable?: false`. Absent means a person's answer is awaited. `false` means the event is informational and `answer()` on it does nothing.

- [ ] **Step 1: Write the failing tests**

Append inside the existing `describe("createSessionAskPort", ...)` block:

```ts
  test("auto-decisions and noted questions are marked unanswerable (S5-2 M-1)", () => {
    const { events, port } = setup();
    port.recordAutoDecision({ callId: "c3", tool: "Write", summary: "write b", reason: "profile full" }, "allow");
    port.noteQuestion("FYI: the agent declined a form");
    expect(events[0]).toMatchObject({ type: "approval_requested", answerable: false });
    expect(events[1]).toMatchObject({ type: "approval_resolved", decidedBy: "profile" });
    expect(events[2]).toMatchObject({ type: "question", answerable: false });
  });

  test("a real approval and a real question carry no answerable marker", async () => {
    const { events, controller, port } = setup();
    const approval = port.requestApproval({ tool: "Write", summary: "s", reason: "r" });
    const question = port.askQuestion("Which env?");
    const asks = events.filter((e) => e.type === "approval_requested" || e.type === "question");
    expect(asks).toHaveLength(2);
    expect(asks.every((e) => !("answerable" in e))).toBe(true);
    controller.abort();
    await Promise.all([approval, question]);
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run (from `packages/nax-agent`): `bun test ./test/unit/session/session-ask-port.test.ts`
Expected: FAIL. The first test fails because `answerable` is missing.

- [ ] **Step 3: Implement**

In `agent-session-types.ts`, add to the `approval_requested` member, after `expiresAt`:

```ts
      /** `false`: decided already (by the profile); informational. Absent: a person's answer is awaited. */
      readonly answerable?: false;
```

Change the `question` member to:

```ts
  | {
      readonly type: "question";
      readonly requestId: string;
      readonly text: string;
      readonly expiresAt: string;
      /** `false`: informational (`noteQuestion`); `answer()` on it does nothing. Absent: an answer is awaited. */
      readonly answerable?: false;
    }
```

In `session-ask-port.ts`, add `answerable: false,` to the `approval_requested` emit in `recordAutoDecision`, after `expiresAt: now(),`. Change the emit in `noteQuestion` to:

```ts
      deps.emit({ type: "question", requestId, text, expiresAt: now(), answerable: false });
```

- [ ] **Step 4: Run tests and gates**

From `packages/nax-agent`:
- Run: `bun test ./test/unit/session/ --timeout=60000`. Expected: PASS.
- Run: `bun run api:update`. Then check `git diff api/nax-agent.api.txt`: it should show only the two `answerable` fields.
- Run: `bun run typecheck && bun run check:all`. Expected: PASS.
- From `packages/nax-agent-acp`, run: `bun run typecheck`. Expected: PASS. The field is optional, so existing consumers compile.

- [ ] **Step 5: Commit**

```bash
git add packages/nax-agent/src/session/agent-session-types.ts packages/nax-agent/src/session/session-ask-port.ts packages/nax-agent/api/nax-agent.api.txt packages/nax-agent/test/unit/session/session-ask-port.test.ts
git commit -m "feat(nax-agent): mark profile auto-decisions and noted questions answerable:false (S5-2 M-1)"
```

---

### Task 1: Error mapping

**Files:**
- Create: `packages/nax-agent-acp/src/server/errors.ts`
- Create: `packages/nax-agent-acp/test/helpers/recording-logger.ts`
- Test: `packages/nax-agent-acp/test/unit/server/errors.test.ts`

**Interfaces:**
- Produces (`#src/server/errors`):
  - `const TURN_IN_PROGRESS = "turn in progress"`
  - `function turnInProgress(): RequestError`. Code -32600.
  - `function unknownSession(sessionId: string): RequestError`. Code -32002.
  - `function invalidParams(message: string): RequestError`. Code -32602.
  - `function toRequestError(error: unknown, logger: AgentLogger): RequestError`
  - `function guard<T>(logger: AgentLogger, work: () => Promise<T>): Promise<T>`. It rethrows any failure as `toRequestError(failure)`.
- Produces (`#test/helpers/recording-logger`):
  - `interface LogLine { level: "error" | "warn" | "info" | "debug"; stage: string; message: string; data?: Record<string, unknown> }`
  - `function recordingLogger(): { readonly logger: AgentLogger; readonly lines: LogLine[] }`

- [ ] **Step 1: Write the helper and the failing test**

`test/helpers/recording-logger.ts`:

```ts
/** An AgentLogger that records each line, for asserting what the server logs. */
import type { AgentLogger } from "@nathapp/nax-agent";

export interface LogLine {
  readonly level: "error" | "warn" | "info" | "debug";
  readonly stage: string;
  readonly message: string;
  readonly data?: Record<string, unknown>;
}

export function recordingLogger(): { readonly logger: AgentLogger; readonly lines: LogLine[] } {
  const lines: LogLine[] = [];
  const at =
    (level: LogLine["level"]) =>
    (stage: string, message: string, data?: Record<string, unknown>): void => {
      lines.push({ level, stage, message, ...(data !== undefined ? { data } : {}) });
    };
  return { logger: { error: at("error"), warn: at("warn"), info: at("info"), debug: at("debug") }, lines };
}
```

`test/unit/server/errors.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { RequestError } from "@agentclientprotocol/sdk";
import { AgentSessionError } from "@nathapp/nax-agent";
import {
  guard,
  invalidParams,
  TURN_IN_PROGRESS,
  toRequestError,
  turnInProgress,
  unknownSession,
} from "#src/server/errors";
import { recordingLogger } from "#test/helpers/recording-logger";

describe("error constructors (spec §7)", () => {
  test("turn in progress is invalid_request", () => {
    const error = turnInProgress();
    expect(error.code).toBe(-32600);
    expect(error.message).toBe(`Invalid request: ${TURN_IN_PROGRESS}`);
  });

  test("an unknown session is resource_not_found naming the id", () => {
    const error = unknownSession("s-1");
    expect(error.code).toBe(-32002);
    expect(error.data).toEqual({ uri: "s-1" });
  });

  test("invalidParams carries the message", () => {
    expect(invalidParams("cwd must be absolute").message).toBe("Invalid params: cwd must be absolute");
  });
});

describe("toRequestError", () => {
  test("passes a RequestError through unchanged", () => {
    const { logger } = recordingLogger();
    const original = RequestError.invalidParams(undefined, "x");
    expect(toRequestError(original, logger)).toBe(original);
  });

  test("maps AGENT_SESSION_INVALID_OPTIONS to invalid_params with its message", () => {
    const { logger, lines } = recordingLogger();
    const error = toRequestError(new AgentSessionError("bad model id", "AGENT_SESSION_INVALID_OPTIONS"), logger);
    expect(error.code).toBe(-32602);
    expect(error.message).toContain("bad model id");
    expect(lines).toEqual([]);
  });

  test("maps AGENT_SESSION_BUSY to turn in progress", () => {
    const { logger } = recordingLogger();
    expect(toRequestError(new AgentSessionError("busy", "AGENT_SESSION_BUSY"), logger).message).toContain(
      TURN_IN_PROGRESS,
    );
  });

  test("anything else is internal_error with the message only, logged with its stack", () => {
    const { logger, lines } = recordingLogger();
    const error = toRequestError(new Error("boom"), logger);
    expect(error.code).toBe(-32603);
    expect(error.message).toBe("Internal error: boom");
    expect(error.data).toBeUndefined();
    expect(lines[0]).toMatchObject({ level: "error", message: "request failed", data: { error: "boom" } });
    expect(String(lines[0]?.data?.stack)).toContain("boom");
  });

  test("an unmapped facade error is internal too (auth_required lands in S5-4)", () => {
    const { logger } = recordingLogger();
    const error = toRequestError(new AgentSessionError("log in", "AGENT_SESSION_AUTH_REQUIRED"), logger);
    expect(error.code).toBe(-32603);
    expect(error.message).toContain("log in");
  });

  test("a non-Error throw is stringified", () => {
    const { logger } = recordingLogger();
    expect(toRequestError("plain", logger).message).toBe("Internal error: plain");
  });
});

describe("guard", () => {
  test("returns the result and rethrows failures mapped", async () => {
    const { logger } = recordingLogger();
    expect(await guard(logger, async () => 7)).toBe(7);
    const caught = await guard(logger, async () => {
      throw new AgentSessionError("busy", "AGENT_SESSION_BUSY");
    }).catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(RequestError);
    expect(caught instanceof RequestError ? caught.code : 0).toBe(-32600);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test ./test/unit/server/errors.test.ts`
Expected: FAIL. `#src/server/errors` does not exist.

- [ ] **Step 3: Implement `src/server/errors.ts`**

```ts
/**
 * Failures as SDK RequestErrors at the protocol edge (S5 spec §7). Facade errors
 * with a protocol meaning map to it; anything else is logged with its stack and
 * reaches the client as its message only. One request's failure never stops the
 * process.
 */
import { RequestError } from "@agentclientprotocol/sdk";
import { type AgentLogger, AgentSessionError } from "@nathapp/nax-agent";

export const TURN_IN_PROGRESS = "turn in progress";

export function turnInProgress(): RequestError {
  return RequestError.invalidRequest(undefined, TURN_IN_PROGRESS);
}

export function unknownSession(sessionId: string): RequestError {
  return RequestError.resourceNotFound(sessionId);
}

export function invalidParams(message: string): RequestError {
  return RequestError.invalidParams(undefined, message);
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function toRequestError(error: unknown, logger: AgentLogger): RequestError {
  if (error instanceof RequestError) return error;
  if (error instanceof AgentSessionError) {
    if (error.code === "AGENT_SESSION_INVALID_OPTIONS") return invalidParams(error.message);
    if (error.code === "AGENT_SESSION_BUSY") return turnInProgress();
  }
  logger.error("server", "request failed", {
    error: messageOf(error),
    ...(error instanceof Error && error.stack !== undefined ? { stack: error.stack } : {}),
  });
  return RequestError.internalError(undefined, messageOf(error));
}

export async function guard<T>(logger: AgentLogger, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw toRequestError(error, logger);
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `bun test ./test/unit/server/errors.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
bun run lint:fix
git add src/server/errors.ts test/helpers/recording-logger.ts test/unit/server/errors.test.ts
git commit -m "feat(acp-server): S5-2 error mapping to RequestError"
```

---

### Task 2: Flatten prompt content

**Files:**
- Create: `packages/nax-agent-acp/src/server/prompt.ts`
- Test: `packages/nax-agent-acp/test/unit/server/prompt.test.ts`

**Interfaces:**
- Consumes: `invalidParams` (Task 1).
- Produces (`#src/server/prompt`): `function flattenPrompt(blocks: readonly ContentBlock[]): string`. It throws an `invalid_params` `RequestError` for image, audio, a binary embedded resource, or a prompt with no text.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { type ContentBlock, RequestError } from "@agentclientprotocol/sdk";
import { flattenPrompt } from "#src/server/prompt";

function rejects(blocks: readonly ContentBlock[]): RequestError {
  try {
    flattenPrompt(blocks);
  } catch (error) {
    if (error instanceof RequestError) return error;
  }
  throw new Error("expected a RequestError");
}

describe("flattenPrompt (spec §3.2)", () => {
  test("text blocks verbatim, joined by a blank line", () => {
    expect(
      flattenPrompt([
        { type: "text", text: "fix the bug" },
        { type: "text", text: "in parser.ts" },
      ]),
    ).toBe("fix the bug\n\nin parser.ts");
  });

  test("an embedded text resource is a fenced block headed by its URI", () => {
    expect(
      flattenPrompt([{ type: "resource", resource: { uri: "file:///w/a.ts", text: "const a = 1;" } }]),
    ).toBe("file:///w/a.ts\n```\nconst a = 1;\n```");
  });

  test("the fence outgrows any backtick run in the text", () => {
    const text = "see:\n```ts\nx\n```\nand ````";
    const out = flattenPrompt([{ type: "resource", resource: { uri: "file:///w/README.md", text } }]);
    expect(out.startsWith("file:///w/README.md\n`````\n")).toBe(true);
    expect(out.endsWith("\n`````")).toBe(true);
  });

  test("a resource link is its URI only", () => {
    expect(flattenPrompt([{ type: "resource_link", uri: "file:///w/b.ts", name: "b.ts" }])).toBe("file:///w/b.ts");
  });

  test("image, audio and binary resources are invalid_params", () => {
    expect(rejects([{ type: "image", data: "AA==", mimeType: "image/png" }]).code).toBe(-32602);
    expect(rejects([{ type: "audio", data: "AA==", mimeType: "audio/wav" }]).code).toBe(-32602);
    const binary = rejects([{ type: "resource", resource: { uri: "file:///w/x.bin", blob: "AA==" } }]);
    expect(binary.code).toBe(-32602);
    expect(binary.message).toContain("file:///w/x.bin");
  });

  test("a prompt with no text is invalid_params", () => {
    expect(rejects([]).code).toBe(-32602);
    expect(rejects([{ type: "text", text: "" }]).code).toBe(-32602);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test ./test/unit/server/prompt.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement `src/server/prompt.ts`**

```ts
/**
 * ACP prompt content as the one text message S3's `send()` takes (S5 spec §3.2):
 * text verbatim; an embedded text resource as a fenced block headed by its URI;
 * a resource link as its URI. Image, audio and binary content are not
 * advertised and are rejected.
 */
import type { ContentBlock } from "@agentclientprotocol/sdk";
import { invalidParams } from "#src/server/errors";

function fenceFor(text: string): string {
  const longest = Math.max(0, ...Array.from(text.matchAll(/`+/g), (run) => run[0].length));
  return "`".repeat(Math.max(3, longest + 1));
}

function blockText(block: ContentBlock): string {
  switch (block.type) {
    case "text":
      return block.text;
    case "resource_link":
      return block.uri;
    case "resource": {
      const { resource } = block;
      if (!("text" in resource)) throw invalidParams(`binary embedded resource ${resource.uri} is not supported`);
      const fence = fenceFor(resource.text);
      return `${resource.uri}\n${fence}\n${resource.text}\n${fence}`;
    }
    case "image":
    case "audio":
      throw invalidParams(`${block.type} prompt content is not supported`);
  }
}

export function flattenPrompt(blocks: readonly ContentBlock[]): string {
  const parts = blocks.map(blockText).filter((part) => part !== "");
  if (parts.length === 0) throw invalidParams("the prompt has no text");
  return parts.join("\n\n");
}
```

If the compiler reports that `blockText` lacks an ending return (an unknown future block type), add a final `default: throw invalidParams("unsupported prompt content");`. Do not cast.

- [ ] **Step 4: Run it to verify it passes**

Run: `bun test ./test/unit/server/prompt.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
bun run lint:fix
git add src/server/prompt.ts test/unit/server/prompt.test.ts
git commit -m "feat(acp-server): S5-2 prompt content flattening"
```

---

### Task 3: Client port and permission broker

**Files:**
- Create: `packages/nax-agent-acp/src/server/client-port.ts`
- Create: `packages/nax-agent-acp/src/server/permissions.ts`
- Create: `packages/nax-agent-acp/test/helpers/fake-client-port.ts`
- Test: `packages/nax-agent-acp/test/unit/server/client-port.test.ts`, `packages/nax-agent-acp/test/unit/server/permissions.test.ts`

**Interfaces:**
- Consumes: `messageOf` (Task 1); `toolKind` (`#src/server/translate/tool-kind`); `ClientUpdates` (`#src/server/translate/events`).
- Produces (`#src/server/client-port`):
  - `interface ClientFeatures { readonly updates: ClientUpdates; readonly elicitation: boolean }`
  - `const NO_CLIENT_FEATURES: ClientFeatures`
  - `function clientFeatures(caps: ClientCapabilities | undefined): ClientFeatures`
  - `interface PermissionAsk { readonly toolCall: ToolCallUpdate; readonly options: readonly PermissionOption[] }`
  - `interface ElicitationForm { readonly message: string; readonly requestedSchema: ElicitationSchema }`
  - `interface ClientPort { readonly features: ClientFeatures; update(update: SessionUpdate): Promise<void>; requestPermission(ask: PermissionAsk, signal: AbortSignal): Promise<RequestPermissionResponse>; elicit(form: ElicitationForm, signal: AbortSignal): Promise<CreateElicitationResponse> }`
  - `function clientPort(context: AgentContext, sessionId: string, features: ClientFeatures): ClientPort`
  - `function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T>`. It rejects as soon as `signal` aborts.
- Produces (`#src/server/permissions`):
  - `type Decision = "allow" | "deny"`
  - `type ApprovalEvent = Extract<SessionEvent, { type: "approval_requested" }>`
  - `type Answer = (requestId: string, reply: AnswerReply) => AnswerStatus`
  - `const PERMISSION_OPTIONS: readonly PermissionOption[]`
  - `function memoryKey(event: ApprovalEvent): string | undefined`
  - `interface PermissionBroker { request(event: ApprovalEvent, toolCall: ToolCallUpdate | undefined): void; settled(requestId: string): void; abortAll(): void; drain(): Promise<void> }`
  - `function createPermissionBroker(deps: { readonly port: ClientPort; readonly answer: Answer; readonly memory: Map<string, Decision>; readonly logger: AgentLogger }): PermissionBroker`
- Produces (`#test/helpers/fake-client-port`): `fakePort(options?)`, `select(optionId)`, `ALL_FEATURES`, `NEVER`. Exact code below.

- [ ] **Step 1: Write the helper and the failing tests**

`test/helpers/fake-client-port.ts`:

```ts
/** A scripted ClientPort: records what the server sends and answers as told. */
import type { CreateElicitationResponse, RequestPermissionResponse, SessionUpdate } from "@agentclientprotocol/sdk";
import {
  type ClientFeatures,
  type ClientPort,
  type ElicitationForm,
  NO_CLIENT_FEATURES,
  type PermissionAsk,
} from "#src/server/client-port";

export const ALL_FEATURES: ClientFeatures = { updates: { notices: true, compaction: true }, elicitation: true };

/** A client that never answers. */
export const NEVER = <T>(): Promise<T> => new Promise<T>(() => {});

export function select(optionId: string): RequestPermissionResponse {
  return { outcome: { outcome: "selected", optionId } };
}

export interface FakePortOptions {
  readonly features?: ClientFeatures;
  readonly permission?: (ask: PermissionAsk) => Promise<RequestPermissionResponse>;
  readonly elicit?: (form: ElicitationForm) => Promise<CreateElicitationResponse>;
  readonly failUpdates?: boolean;
}

export interface FakePort {
  readonly port: ClientPort;
  readonly updates: SessionUpdate[];
  readonly asks: PermissionAsk[];
  readonly forms: ElicitationForm[];
  readonly signals: AbortSignal[];
}

export function fakePort(options: FakePortOptions = {}): FakePort {
  const updates: SessionUpdate[] = [];
  const asks: PermissionAsk[] = [];
  const forms: ElicitationForm[] = [];
  const signals: AbortSignal[] = [];
  const port: ClientPort = {
    features: options.features ?? NO_CLIENT_FEATURES,
    update: async (update) => {
      if (options.failUpdates === true) throw new Error("client connection closed");
      updates.push(update);
    },
    requestPermission: (ask, signal) => {
      asks.push(ask);
      signals.push(signal);
      return (options.permission ?? (async () => select("allow_once")))(ask);
    },
    elicit: (form, signal) => {
      forms.push(form);
      signals.push(signal);
      return (options.elicit ?? (async (): Promise<CreateElicitationResponse> => ({ action: "cancel" })))(form);
    },
  };
  return { port, updates, asks, forms, signals };
}
```

`test/unit/server/client-port.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { clientFeatures, NO_CLIENT_FEATURES, untilAborted } from "#src/server/client-port";

describe("clientFeatures", () => {
  test("nothing declared means no optional updates and no elicitation", () => {
    expect(clientFeatures(undefined)).toEqual(NO_CLIENT_FEATURES);
    expect(clientFeatures({ session: null, elicitation: null })).toEqual(NO_CLIENT_FEATURES);
  });

  test("reads session.notices, session.compaction and elicitation.form", () => {
    expect(clientFeatures({ session: { notices: {}, compaction: {} }, elicitation: { form: {} } })).toEqual({
      updates: { notices: true, compaction: true },
      elicitation: true,
    });
    expect(clientFeatures({ elicitation: { url: {} } }).elicitation).toBe(false);
  });
});

describe("untilAborted", () => {
  test("settles with the work when not aborted", async () => {
    expect(await untilAborted(Promise.resolve(3), new AbortController().signal)).toBe(3);
  });

  test("rejects at once on abort even if the work never settles", async () => {
    const controller = new AbortController();
    const pending = untilAborted(new Promise<number>(() => {}), controller.signal);
    controller.abort(new Error("stop"));
    expect(await pending.catch((e: unknown) => (e instanceof Error ? e.message : ""))).toBe("stop");
  });

  test("rejects at once when already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("early"));
    expect(await untilAborted(Promise.resolve(1), controller.signal).catch(() => "rejected")).toBe("rejected");
  });
});
```

`test/unit/server/permissions.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { AnswerReply } from "@nathapp/nax-agent";
import {
  type ApprovalEvent,
  createPermissionBroker,
  type Decision,
  memoryKey,
  PERMISSION_OPTIONS,
} from "#src/server/permissions";
import { fakePort, NEVER, select } from "#test/helpers/fake-client-port";
import { recordingLogger } from "#test/helpers/recording-logger";

const BASE = { sessionId: "s1", turnId: "t1", at: "2026-10-09T00:00:00.000Z", metadata: {} };

function approval(requestId: string, tool: string, extra: Partial<ApprovalEvent> = {}): ApprovalEvent {
  return {
    ...BASE,
    type: "approval_requested",
    requestId,
    tool,
    summary: `${tool} something`,
    reason: "ask profile",
    expiresAt: "2026-10-09T00:10:00.000Z",
    ...extra,
  };
}

function setup(options: Parameters<typeof fakePort>[0] = {}) {
  const fake = fakePort(options);
  const answers: { requestId: string; reply: AnswerReply }[] = [];
  const memory = new Map<string, Decision>();
  const { logger, lines } = recordingLogger();
  const broker = createPermissionBroker({
    port: fake.port,
    answer: (requestId, reply) => {
      answers.push({ requestId, reply });
      return "accepted";
    },
    memory,
    logger,
  });
  return { ...fake, answers, memory, lines, broker };
}

describe("memoryKey (spec §4.3)", () => {
  test("the tool name for non-execute tools", () => {
    expect(memoryKey(approval("r", "Edit"))).toBe("Edit");
  });

  test("tool plus the command's first word for execute tools", () => {
    expect(memoryKey(approval("r", "Bash", { command: "  git push origin main" }))).toBe("Bash:git");
  });

  test("an execute tool with no command is never remembered (M-12)", () => {
    expect(memoryKey(approval("r", "Bash"))).toBeUndefined();
    expect(memoryKey(approval("r", "Bash", { command: "   " }))).toBeUndefined();
  });
});

describe("createPermissionBroker", () => {
  test("asks the client with the tool call and the four options, then answers", async () => {
    const s = setup();
    const toolCall = { toolCallId: "c1", title: "Edit a.ts", kind: "edit" as const, status: "pending" as const };
    s.broker.request(approval("r1", "Edit", { callId: "c1" }), toolCall);
    await s.broker.drain();
    expect(s.asks).toEqual([{ toolCall, options: PERMISSION_OPTIONS }]);
    expect(PERMISSION_OPTIONS.map((o) => o.kind)).toEqual(["allow_once", "allow_always", "reject_once", "reject_always"]);
    expect(s.answers).toEqual([{ requestId: "r1", reply: { decision: "allow" } }]);
  });

  test("reject_once and a cancelled outcome both deny", async () => {
    const s = setup({ permission: async () => select("reject_once") });
    s.broker.request(approval("r1", "Edit"), undefined);
    await s.broker.drain();
    const c = setup({ permission: async () => ({ outcome: { outcome: "cancelled" } }) });
    c.broker.request(approval("r2", "Edit"), undefined);
    await c.broker.drain();
    expect([...s.answers, ...c.answers].map((a) => a.reply)).toEqual([{ decision: "deny" }, { decision: "deny" }]);
  });

  test("allow_always is remembered: the next matching request is answered without asking", async () => {
    const s = setup({ permission: async () => select("allow_always") });
    s.broker.request(approval("r1", "Edit"), undefined);
    await s.broker.drain();
    s.broker.request(approval("r2", "Edit"), undefined);
    await s.broker.drain();
    expect(s.asks).toHaveLength(1);
    expect(s.answers.map((a) => a.reply)).toEqual([{ decision: "allow" }, { decision: "allow" }]);
    expect(s.memory.get("Edit")).toBe("allow");
  });

  test("reject_always on a bash prefix covers that prefix only", async () => {
    const s = setup({ permission: async () => select("reject_always") });
    s.broker.request(approval("r1", "Bash", { command: "git status" }), undefined);
    await s.broker.drain();
    s.broker.request(approval("r2", "Bash", { command: "git push" }), undefined);
    s.broker.request(approval("r3", "Bash", { command: "ls -la" }), undefined);
    await s.broker.drain();
    expect(s.asks).toHaveLength(2);
    expect(s.answers.find((a) => a.requestId === "r2")?.reply).toEqual({ decision: "deny" });
  });

  test("S3 settling first aborts the client request; a late reply is ignored", async () => {
    let late: (value: ReturnType<typeof select>) => void = () => {};
    const s = setup({ permission: () => new Promise((resolve) => (late = resolve)) });
    s.broker.request(approval("r1", "Edit"), undefined);
    s.broker.settled("r1");
    await s.broker.drain();
    expect(s.signals[0]?.aborted).toBe(true);
    late(select("allow_once"));
    await Promise.resolve();
    expect(s.answers).toEqual([]);
  });

  test("a client that never answers does not block drain after abortAll", async () => {
    const s = setup({ permission: NEVER });
    s.broker.request(approval("r1", "Edit"), undefined);
    s.broker.request(approval("r2", "Write"), undefined);
    s.broker.abortAll();
    await s.broker.drain();
    expect(s.signals.every((signal) => signal.aborted)).toBe(true);
    expect(s.answers).toEqual([]);
  });

  test("a failing client request is a deny, logged at warn (M-13)", async () => {
    const s = setup({ permission: async () => Promise.reject(new Error("Method not found")) });
    s.broker.request(approval("r1", "Edit"), undefined);
    await s.broker.drain();
    expect(s.answers).toEqual([{ requestId: "r1", reply: { decision: "deny" } }]);
    expect(s.lines[0]).toMatchObject({ level: "warn", data: { error: "Method not found" } });
  });

  test("without a known tool call, a fallback tool call carries the summary and command", async () => {
    const s = setup();
    s.broker.request(approval("r1", "Bash", { command: "rm -rf build" }), undefined);
    await s.broker.drain();
    expect(s.asks[0]?.toolCall).toEqual({
      toolCallId: "r1",
      title: "Bash something",
      kind: "execute",
      status: "pending",
      rawInput: { command: "rm -rf build" },
    });
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test ./test/unit/server/client-port.test.ts ./test/unit/server/permissions.test.ts`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement `src/server/client-port.ts`**

```ts
/**
 * What a server session needs from its client (S5 spec §4.3): session updates,
 * permission requests and form elicitations, plus the optional features the
 * client declared in `initialize`. Sessions and brokers depend on this port,
 * not on the SDK connection.
 */
import type {
  AgentContext,
  ClientCapabilities,
  CreateElicitationResponse,
  ElicitationSchema,
  PermissionOption,
  RequestPermissionResponse,
  SessionUpdate,
  ToolCallUpdate,
} from "@agentclientprotocol/sdk";
import type { ClientUpdates } from "#src/server/translate/events";

export interface ClientFeatures {
  readonly updates: ClientUpdates;
  /** The client declared form elicitation (`clientCapabilities.elicitation.form`). */
  readonly elicitation: boolean;
}

export const NO_CLIENT_FEATURES: ClientFeatures = {
  updates: { notices: false, compaction: false },
  elicitation: false,
};

const present = (value: unknown): boolean => value !== undefined && value !== null;

export function clientFeatures(caps: ClientCapabilities | undefined): ClientFeatures {
  return {
    updates: { notices: present(caps?.session?.notices), compaction: present(caps?.session?.compaction) },
    elicitation: present(caps?.elicitation?.form),
  };
}

export interface PermissionAsk {
  readonly toolCall: ToolCallUpdate;
  readonly options: readonly PermissionOption[];
}

export interface ElicitationForm {
  readonly message: string;
  readonly requestedSchema: ElicitationSchema;
}

export interface ClientPort {
  readonly features: ClientFeatures;
  update(update: SessionUpdate): Promise<void>;
  /** Aborting `signal` sends `$/cancel_request`; callers stop waiting with `untilAborted`. */
  requestPermission(ask: PermissionAsk, signal: AbortSignal): Promise<RequestPermissionResponse>;
  elicit(form: ElicitationForm, signal: AbortSignal): Promise<CreateElicitationResponse>;
}

export function clientPort(context: AgentContext, sessionId: string, features: ClientFeatures): ClientPort {
  return {
    features,
    update: (update) => context.notify("session/update", { sessionId, update }),
    requestPermission: (ask, signal) =>
      context.request(
        "session/request_permission",
        { sessionId, toolCall: ask.toolCall, options: [...ask.options] },
        { cancellationSignal: signal },
      ),
    elicit: (form, signal) =>
      context.request(
        "elicitation/create",
        { sessionId, mode: "form", message: form.message, requestedSchema: form.requestedSchema },
        { cancellationSignal: signal },
      ),
  };
}

/**
 * The work's result, or a rejection as soon as `signal` aborts. SDK cancellation
 * is cooperative (the request promise waits for the peer), so a client that never
 * answers would otherwise hold the turn.
 */
export function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
```

If the compiler rejects the `elicitation/create` params literal (the request type is a union of modes), annotate the literal with `const request: CreateElicitationRequest = { ... }` and pass `request`. Do not cast.

- [ ] **Step 4: Implement `src/server/permissions.ts`**

```ts
/**
 * Approval round trips (S5 spec §4.3). A human approval becomes a
 * `session/request_permission`, and the chosen option is passed to `answer()`.
 * allow_always and reject_always are remembered for the session's life (M-12:
 * execute tools per first word of the command, never without one). When S3
 * settles a request itself (timeout, cancel), the client request is aborted and a
 * late reply is ignored. A failed client request is a deny (M-13).
 */
import type { PermissionOption, RequestPermissionResponse, ToolCallUpdate } from "@agentclientprotocol/sdk";
import type { AgentLogger, AnswerReply, AnswerStatus, SessionEvent } from "@nathapp/nax-agent";
import { type ClientPort, untilAborted } from "#src/server/client-port";
import { messageOf } from "#src/server/errors";
import { toolKind } from "#src/server/translate/tool-kind";

export type Decision = "allow" | "deny";
export type ApprovalEvent = Extract<SessionEvent, { type: "approval_requested" }>;
export type Answer = (requestId: string, reply: AnswerReply) => AnswerStatus;

export const PERMISSION_OPTIONS: readonly PermissionOption[] = [
  { optionId: "allow_once", name: "Allow", kind: "allow_once" },
  { optionId: "allow_always", name: "Always allow", kind: "allow_always" },
  { optionId: "reject_once", name: "Reject", kind: "reject_once" },
  { optionId: "reject_always", name: "Always reject", kind: "reject_always" },
];

export interface PermissionBroker {
  /** Starts the round trip for one human approval; never blocks the caller. */
  request(event: ApprovalEvent, toolCall: ToolCallUpdate | undefined): void;
  /** S3 resolved the request itself: stop waiting for the client. */
  settled(requestId: string): void;
  /** Cancel or turn end: stop waiting on every open request. */
  abortAll(): void;
  /** Resolves when every round trip started so far has finished. */
  drain(): Promise<void>;
}

export interface PermissionBrokerDeps {
  readonly port: ClientPort;
  readonly answer: Answer;
  readonly memory: Map<string, Decision>;
  readonly logger: AgentLogger;
}

export function memoryKey(event: ApprovalEvent): string | undefined {
  if (toolKind(event.tool) !== "execute") return event.tool;
  const first = event.command?.trim().split(/\s+/)[0];
  return first === undefined || first === "" ? undefined : `${event.tool}:${first}`;
}

function choice(response: RequestPermissionResponse): { readonly decision: Decision; readonly remember: boolean } {
  const { outcome } = response;
  if (outcome.outcome !== "selected") return { decision: "deny", remember: false };
  switch (PERMISSION_OPTIONS.find((option) => option.optionId === outcome.optionId)?.kind) {
    case "allow_once":
      return { decision: "allow", remember: false };
    case "allow_always":
      return { decision: "allow", remember: true };
    case "reject_always":
      return { decision: "deny", remember: true };
    default:
      return { decision: "deny", remember: false };
  }
}

function fallbackToolCall(event: ApprovalEvent): ToolCallUpdate {
  return {
    toolCallId: event.callId ?? event.requestId,
    title: event.summary,
    kind: toolKind(event.tool),
    status: "pending",
    ...(event.command !== undefined ? { rawInput: { command: event.command } } : {}),
  };
}

export function createPermissionBroker(deps: PermissionBrokerDeps): PermissionBroker {
  const open = new Map<string, AbortController>();
  const running = new Set<Promise<void>>();

  async function roundTrip(event: ApprovalEvent, toolCall: ToolCallUpdate, key: string | undefined): Promise<void> {
    const controller = new AbortController();
    open.set(event.requestId, controller);
    let reply: { readonly decision: Decision; readonly remember: boolean };
    try {
      const ask = { toolCall, options: PERMISSION_OPTIONS };
      reply = choice(await untilAborted(deps.port.requestPermission(ask, controller.signal), controller.signal));
    } catch (error) {
      if (controller.signal.aborted) return;
      deps.logger.warn("permissions", "permission request failed; denying", { error: messageOf(error) });
      reply = { decision: "deny", remember: false };
    } finally {
      open.delete(event.requestId);
    }
    if (controller.signal.aborted) return;
    if (reply.remember && key !== undefined) deps.memory.set(key, reply.decision);
    deps.answer(event.requestId, { decision: reply.decision });
  }

  return {
    request(event, toolCall) {
      const key = memoryKey(event);
      const remembered = key === undefined ? undefined : deps.memory.get(key);
      if (remembered !== undefined) {
        deps.answer(event.requestId, { decision: remembered });
        return;
      }
      const trip = roundTrip(event, toolCall ?? fallbackToolCall(event), key);
      running.add(trip);
      void trip.finally(() => running.delete(trip));
    },
    settled(requestId) {
      open.get(requestId)?.abort();
    },
    abortAll() {
      for (const controller of open.values()) controller.abort();
    },
    async drain() {
      await Promise.all([...running]);
    },
  };
}
```

`roundTrip` sets `open` before its first `await`, so `settled()` straight after `request()` finds the controller.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test ./test/unit/server/client-port.test.ts ./test/unit/server/permissions.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
bun run lint:fix
git add src/server/client-port.ts src/server/permissions.ts test/helpers/fake-client-port.ts test/unit/server/client-port.test.ts test/unit/server/permissions.test.ts
git commit -m "feat(acp-server): S5-2 client port and permission broker with session memory"
```

---

### Task 4: Question broker

**Files:**
- Create: `packages/nax-agent-acp/src/server/questions.ts`
- Test: `packages/nax-agent-acp/test/unit/server/questions.test.ts`

**Interfaces:**
- Consumes: `ClientPort`, `untilAborted` (Task 3); `Answer` (Task 3); `messageOf` (Task 1); `announce` (`#src/server/translate/notice`).
- Produces (`#src/server/questions`):
  - `const ANSWER_FIELD = "answer"`
  - `const DECLINED_TEXT = "The user declined to answer."`
  - `const NO_ANSWER_TEXT = "No answer available: this client cannot answer questions. Proceed with your best judgement."`
  - `type QuestionEvent = Extract<SessionEvent, { type: "question" }>`
  - `interface QuestionBroker { ask(event: QuestionEvent): void; abortAll(): void; drain(): Promise<void> }`
  - `function createQuestionBroker(deps: { readonly port: ClientPort; readonly deliver: (update: SessionUpdate) => Promise<void>; readonly answer: Answer; readonly logger: AgentLogger; readonly now?: () => number }): QuestionBroker`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import type { AnswerReply } from "@nathapp/nax-agent";
import {
  ANSWER_FIELD,
  createQuestionBroker,
  DECLINED_TEXT,
  NO_ANSWER_TEXT,
  type QuestionEvent,
} from "#src/server/questions";
import { ALL_FEATURES, fakePort, NEVER } from "#test/helpers/fake-client-port";
import { recordingLogger } from "#test/helpers/recording-logger";

const NOW = Date.parse("2026-10-09T00:00:00.000Z");

function question(requestId: string, extra: Partial<QuestionEvent> = {}): QuestionEvent {
  return {
    sessionId: "s1",
    turnId: "t1",
    at: "2026-10-09T00:00:00.000Z",
    metadata: {},
    type: "question",
    requestId,
    text: "Which environment?",
    expiresAt: new Date(NOW + 600_000).toISOString(),
    ...extra,
  };
}

function setup(options: Parameters<typeof fakePort>[0] = {}) {
  const fake = fakePort(options);
  const answers: { requestId: string; reply: AnswerReply }[] = [];
  const { logger, lines } = recordingLogger();
  const broker = createQuestionBroker({
    port: fake.port,
    deliver: (update) => fake.port.update(update),
    answer: (requestId, reply) => {
      answers.push({ requestId, reply });
      return "accepted";
    },
    logger,
    now: () => NOW,
  });
  return { ...fake, answers, lines, broker };
}

describe("createQuestionBroker with elicitation (spec §4.3)", () => {
  test("sends a form with one required answer field and passes the accepted text on", async () => {
    const s = setup({
      features: ALL_FEATURES,
      elicit: async () => ({ action: "accept", content: { [ANSWER_FIELD]: "staging" } }),
    });
    s.broker.ask(question("q1"));
    await s.broker.drain();
    expect(s.forms[0]).toEqual({
      message: "Which environment?",
      requestedSchema: {
        type: "object",
        properties: { [ANSWER_FIELD]: { type: "string", title: "Answer" } },
        required: [ANSWER_FIELD],
      },
    });
    expect(s.answers).toEqual([{ requestId: "q1", reply: { text: "staging" } }]);
  });

  test("decline, cancel and an empty accept all answer with the declined text", async () => {
    for (const reply of [{ action: "decline" }, { action: "cancel" }, { action: "accept", content: {} }]) {
      const s = setup({ features: ALL_FEATURES, elicit: async () => reply });
      s.broker.ask(question("q1"));
      await s.broker.drain();
      expect(s.answers).toEqual([{ requestId: "q1", reply: { text: DECLINED_TEXT } }]);
    }
  });

  test("a failing elicitation answers with the no-answer text, logged at warn (M-13)", async () => {
    const s = setup({ features: ALL_FEATURES, elicit: async () => Promise.reject(new Error("Method not found")) });
    s.broker.ask(question("q1"));
    await s.broker.drain();
    expect(s.answers).toEqual([{ requestId: "q1", reply: { text: NO_ANSWER_TEXT } }]);
    expect(s.lines[0]).toMatchObject({ level: "warn" });
  });

  test("the elicitation is aborted at expiresAt, with no answer (M-14)", async () => {
    const s = setup({ features: ALL_FEATURES, elicit: NEVER });
    s.broker.ask(question("q1", { expiresAt: new Date(NOW + 20).toISOString() }));
    await s.broker.drain();
    expect(s.signals[0]?.aborted).toBe(true);
    expect(s.answers).toEqual([]);
  });

  test("abortAll stops waiting on an open elicitation", async () => {
    const s = setup({ features: ALL_FEATURES, elicit: NEVER });
    s.broker.ask(question("q1"));
    s.broker.abortAll();
    await s.broker.drain();
    expect(s.answers).toEqual([]);
  });
});

describe("createQuestionBroker without elicitation", () => {
  test("shows the question, then answers at once with the no-answer text", async () => {
    const s = setup({ features: { updates: { notices: true, compaction: false }, elicitation: false } });
    s.broker.ask(question("q1"));
    await s.broker.drain();
    expect(s.forms).toEqual([]);
    expect(s.updates).toEqual([
      { sessionUpdate: "notice", severity: "warning", title: "The agent asked a question", description: "Which environment?" },
    ]);
    expect(s.answers).toEqual([{ requestId: "q1", reply: { text: NO_ANSWER_TEXT } }]);
  });

  test("a client without notices gets the question as agent text", async () => {
    const s = setup();
    s.broker.ask(question("q1"));
    await s.broker.drain();
    expect(s.updates[0]).toMatchObject({ sessionUpdate: "agent_message_chunk" });
    expect(JSON.stringify(s.updates[0])).toContain("Which environment?");
  });
});

describe("an unanswerable question (M-1)", () => {
  test("is shown as information and never answered or elicited", async () => {
    const s = setup({ features: ALL_FEATURES });
    s.broker.ask(question("q1", { answerable: false, text: "declined: pick a file" }));
    await s.broker.drain();
    expect(s.forms).toEqual([]);
    expect(s.answers).toEqual([]);
    expect(s.updates[0]).toMatchObject({ sessionUpdate: "notice", severity: "info", description: "declined: pick a file" });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test ./test/unit/server/questions.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement `src/server/questions.ts`**

```ts
/**
 * Questions (S5 spec §4.3). With form elicitation: one required free-text field,
 * the accepted text is the answer, anything else is the declined text. Without
 * it: the question is shown and answered at once with the no-answer text, so a
 * headless client never leaves the agent waiting. The open elicitation is aborted
 * at the question's expiresAt (M-14). An unanswerable question (M-1) is shown
 * only.
 */
import type { CreateElicitationResponse, SessionUpdate } from "@agentclientprotocol/sdk";
import type { AgentLogger, SessionEvent } from "@nathapp/nax-agent";
import { type ClientPort, type ElicitationForm, untilAborted } from "#src/server/client-port";
import { messageOf } from "#src/server/errors";
import type { Answer } from "#src/server/permissions";
import { announce } from "#src/server/translate/notice";

export const ANSWER_FIELD = "answer";
export const DECLINED_TEXT = "The user declined to answer.";
export const NO_ANSWER_TEXT =
  "No answer available: this client cannot answer questions. Proceed with your best judgement.";

export type QuestionEvent = Extract<SessionEvent, { type: "question" }>;

export interface QuestionBroker {
  /** Starts handling one question; never blocks the caller. */
  ask(event: QuestionEvent): void;
  abortAll(): void;
  drain(): Promise<void>;
}

export interface QuestionBrokerDeps {
  readonly port: ClientPort;
  /** The session's delivery (it handles a broken connection). */
  readonly deliver: (update: SessionUpdate) => Promise<void>;
  readonly answer: Answer;
  readonly logger: AgentLogger;
  readonly now?: () => number;
}

function formFor(text: string): ElicitationForm {
  return {
    message: text,
    requestedSchema: {
      type: "object",
      properties: { [ANSWER_FIELD]: { type: "string", title: "Answer" } },
      required: [ANSWER_FIELD],
    },
  };
}

function answerText(response: CreateElicitationResponse): string {
  if (response.action !== "accept" || !("content" in response)) return DECLINED_TEXT;
  const value = response.content?.[ANSWER_FIELD];
  return typeof value === "string" && value.trim() !== "" ? value : DECLINED_TEXT;
}

export function createQuestionBroker(deps: QuestionBrokerDeps): QuestionBroker {
  const now = deps.now ?? Date.now;
  const open = new Set<AbortController>();
  const running = new Set<Promise<void>>();
  const notices = deps.port.features.updates.notices;

  async function elicit(event: QuestionEvent): Promise<void> {
    const controller = new AbortController();
    open.add(controller);
    const expiry = setTimeout(() => controller.abort(), Math.max(0, Date.parse(event.expiresAt) - now()));
    let text: string;
    try {
      text = answerText(await untilAborted(deps.port.elicit(formFor(event.text), controller.signal), controller.signal));
    } catch (error) {
      if (controller.signal.aborted) return;
      deps.logger.warn("questions", "elicitation failed; answering without the user", { error: messageOf(error) });
      text = NO_ANSWER_TEXT;
    } finally {
      clearTimeout(expiry);
      open.delete(controller);
    }
    deps.answer(event.requestId, { text });
  }

  async function handle(event: QuestionEvent): Promise<void> {
    if (event.answerable === false) {
      await deps.deliver(announce(notices, "info", "The agent noted a question", event.text));
      return;
    }
    if (deps.port.features.elicitation) {
      await elicit(event);
      return;
    }
    await deps.deliver(announce(notices, "warning", "The agent asked a question", event.text));
    deps.answer(event.requestId, { text: NO_ANSWER_TEXT });
  }

  return {
    ask(event) {
      const work = handle(event);
      running.add(work);
      void work.finally(() => running.delete(work));
    },
    abortAll() {
      for (const controller of open) controller.abort();
    },
    async drain() {
      await Promise.all([...running]);
    },
  };
}
```

`elicit` adds to `open` before its first `await`, so `abortAll()` straight after `ask()` finds it. When `handle` reaches `elicit`, there is no `await` before it.

- [ ] **Step 4: Run it to verify it passes**

Run: `bun test ./test/unit/server/questions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
bun run lint:fix
git add src/server/questions.ts test/unit/server/questions.test.ts
git commit -m "feat(acp-server): S5-2 question broker with elicitation and canned fallback"
```

---

### Task 5: Server session (prompt, cancel, close)

**Files:**
- Create: `packages/nax-agent-acp/src/server/server-session.ts`
- Create: `packages/nax-agent-acp/test/helpers/fake-agent-session.ts`
- Test: `packages/nax-agent-acp/test/unit/server/server-session.test.ts`

**Interfaces:**
- Consumes: `flattenPrompt` (Task 2); `turnInProgress`, `messageOf` (Task 1); `ClientPort` (Task 3); `createPermissionBroker`, `Decision` (Task 3); `createQuestionBroker` (Task 4); `createEventTranslator` (`#src/server/translate/events`); `promptOutcome`, `PromptOutcome` (`#src/server/translate/stop`); `ReadOldText` (`#src/server/translate/diff`).
- Produces (`#src/server/server-session`):
  - `const TURN_TIMEOUT_SECONDS = 3600`
  - `interface ServerSessionDeps { readonly session: AgentSession; readonly port: ClientPort; readonly cwd: string; readonly contextWindow?: number; readonly readOldText: ReadOldText; readonly logger: AgentLogger; readonly turnTimeoutSeconds: number; readonly now?: () => number }`
  - `interface ServerSession { readonly id: string; readonly running: boolean; queueNotice(update: SessionUpdate): void; prompt(blocks: readonly ContentBlock[]): Promise<PromptResponse>; cancel(): void; close(): Promise<void> }`
  - `function createServerSession(deps: ServerSessionDeps): ServerSession`
- Produces (`#test/helpers/fake-agent-session`): `fakeAgentSession(id, scripts)`, `Script`, `ScriptControl`, `turnEnd(status, extra?)`, `FAR_EXPIRY`. Exact code below. Task 6 and Task 7 reuse it.

- [ ] **Step 1: Write the helper**

`test/helpers/fake-agent-session.ts`:

```ts
/**
 * A scripted AgentSession (M-8): each send() runs the next script, which yields
 * event bodies and can wait for answer() or cancel(). Records answers, cancels
 * and close.
 */
import type { AgentSession, AnswerReply, SessionEvent, SessionEventBody } from "@nathapp/nax-agent";

export const FAR_EXPIRY = "2099-01-01T00:00:00.000Z";

export interface ScriptControl {
  readonly message: string;
  /** The reply given to answer(requestId), or "cancelled" if the turn is cancelled first. */
  reply(requestId: string): Promise<AnswerReply | "cancelled">;
  /** Resolves when the turn is cancelled (cancel() or close()). */
  readonly cancelled: Promise<void>;
}

export type Script = (control: ScriptControl) => AsyncGenerator<SessionEventBody, void, void>;

type TurnEnd = Extract<SessionEventBody, { type: "turn_end" }>;

export function turnEnd(status: TurnEnd["status"], extra: Partial<TurnEnd> = {}): TurnEnd {
  return {
    type: "turn_end",
    status,
    output: "",
    usage: { inputTokens: 10, outputTokens: 5 },
    costUsd: 0,
    ...extra,
  };
}

export interface FakeAgentSession {
  readonly session: AgentSession;
  readonly messages: string[];
  readonly answers: { readonly requestId: string; readonly reply: AnswerReply }[];
  cancels(): number;
  closed(): boolean;
}

export function fakeAgentSession(id: string, scripts: readonly Script[]): FakeAgentSession {
  const messages: string[] = [];
  const answers: { requestId: string; reply: AnswerReply }[] = [];
  const waiting = new Map<string, (reply: AnswerReply | "cancelled") => void>();
  const early = new Map<string, AnswerReply>();
  let cancelCount = 0;
  let isClosed = false;
  let turns = 0;
  let cancelTurn: () => void = () => {};

  async function* run(message: string): AsyncGenerator<SessionEvent> {
    turns += 1;
    const turnId = `t${turns}`;
    const base = { sessionId: id, turnId, at: "2026-10-09T00:00:00.000Z", metadata: {} };
    const script = scripts[turns - 1];
    if (script === undefined) {
      yield { ...base, ...turnEnd("errored", { error: { code: "FAKE_NO_SCRIPT", message: "no script" } }) };
      return;
    }
    let markCancelled: () => void = () => {};
    const cancelled = new Promise<void>((resolve) => {
      markCancelled = resolve;
    });
    cancelTurn = () => {
      markCancelled();
      for (const [requestId, settle] of waiting) {
        waiting.delete(requestId);
        settle("cancelled");
      }
    };
    const control: ScriptControl = {
      message,
      cancelled,
      reply: (requestId) => {
        const known = early.get(requestId);
        if (known !== undefined) return Promise.resolve(known);
        return new Promise((resolve) => waiting.set(requestId, resolve));
      },
    };
    for await (const body of script(control)) yield { ...base, ...body };
    cancelTurn = () => {};
  }

  const session: AgentSession = {
    id,
    backend: { kind: "fake", capabilities: {} },
    lastTurn: undefined,
    send(message) {
      messages.push(message);
      return run(message);
    },
    answer(requestId, reply) {
      answers.push({ requestId, reply });
      const settle = waiting.get(requestId);
      if (settle === undefined) {
        early.set(requestId, reply);
      } else {
        waiting.delete(requestId);
        settle(reply);
      }
      return "accepted";
    },
    cancel() {
      cancelCount += 1;
      cancelTurn();
    },
    async close() {
      isClosed = true;
      cancelTurn();
    },
  };
  return { session, messages, answers, cancels: () => cancelCount, closed: () => isClosed };
}
```

If `{ ...base, ...body }` does not type-check as `SessionEvent` (the spread of a union), write a helper `function withBase(base: SessionEventBase, body: SessionEventBody): SessionEvent` that switches on nothing and returns `{ ...base, ...body }` with the declared return type. If that still fails, ask before adding any cast: the test-escape-hatch gate forbids them.

- [ ] **Step 2: Write the failing test**

`test/unit/server/server-session.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { RequestError, type SessionUpdate } from "@agentclientprotocol/sdk";
import type { OldText } from "#src/server/translate/diff";
import { createServerSession, TURN_TIMEOUT_SECONDS } from "#src/server/server-session";
import { ALL_FEATURES, fakePort, select } from "#test/helpers/fake-client-port";
import { FAR_EXPIRY, fakeAgentSession, type Script, turnEnd } from "#test/helpers/fake-agent-session";
import { recordingLogger } from "#test/helpers/recording-logger";

const missing = async (): Promise<OldText> => ({ kind: "missing" });

function setup(scripts: readonly Script[], portOptions: Parameters<typeof fakePort>[0] = {}, contextWindow?: number) {
  const fake = fakeAgentSession("s1", scripts);
  const port = fakePort(portOptions);
  const { logger, lines } = recordingLogger();
  const session = createServerSession({
    session: fake.session,
    port: port.port,
    cwd: "/w",
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    readOldText: missing,
    logger,
    turnTimeoutSeconds: TURN_TIMEOUT_SECONDS,
  });
  return { fake, port, lines, session };
}

const text = (t: string) => [{ type: "text" as const, text: t }];
const kinds = (updates: readonly SessionUpdate[]) => updates.map((u) => u.sessionUpdate);

async function failure(promise: Promise<unknown>): Promise<RequestError> {
  const caught = await promise.catch((e: unknown) => e);
  if (caught instanceof RequestError) return caught;
  throw new Error(`expected a RequestError, got ${String(caught)}`);
}

const hello: Script = async function* () {
  yield { type: "turn_start" };
  yield { type: "text_delta", round: 1, text: "Hel" };
  yield { type: "text_delta", round: 1, text: "lo" };
  yield turnEnd("completed", { output: "Hello" });
};

describe("prompt", () => {
  test("streams text and answers end_turn with the turn usage", async () => {
    const s = setup([hello]);
    const response = await s.session.prompt(text("hi"));
    expect(s.fake.messages).toEqual(["hi"]);
    expect(kinds(s.port.updates)).toEqual(["agent_message_chunk", "agent_message_chunk"]);
    expect(response).toEqual({
      stopReason: "end_turn",
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    });
    expect(s.session.running).toBe(false);
  });

  test("a queued notice is the first update of the next turn (M-11)", async () => {
    const s = setup([hello]);
    s.session.queueNotice({ sessionUpdate: "notice", severity: "warning", title: "queued" });
    await s.session.prompt(text("hi"));
    expect(s.port.updates[0]).toMatchObject({ title: "queued" });
  });

  test("invalid content is invalid_params and nothing is sent", async () => {
    const s = setup([hello]);
    expect((await failure(s.session.prompt([]))).code).toBe(-32602);
    expect(s.fake.messages).toEqual([]);
  });

  test("a second prompt while a turn runs is turn in progress", async () => {
    const slow: Script = async function* ({ cancelled }) {
      yield { type: "turn_start" };
      await cancelled;
      yield turnEnd("cancelled");
    };
    const s = setup([slow]);
    const first = s.session.prompt(text("one"));
    expect(s.session.running).toBe(true);
    expect((await failure(s.session.prompt(text("two")))).message).toContain("turn in progress");
    s.session.cancel();
    expect((await first).stopReason).toBe("cancelled");
  });

  test("an errored turn is internal_error with the turn's code and message", async () => {
    const broken: Script = async function* () {
      yield turnEnd("errored", { error: { code: "PROVIDER_DOWN", message: "provider down" } });
    };
    const error = await failure(setup([broken]).session.prompt(text("hi")));
    expect(error.code).toBe(-32603);
    expect(error.data).toEqual({ code: "PROVIDER_DOWN", message: "provider down" });
  });

  test("a turn that ends without turn_end is internal_error", async () => {
    const cut: Script = async function* () {
      yield { type: "turn_start" };
    };
    expect((await failure(setup([cut]).session.prompt(text("hi")))).code).toBe(-32603);
  });

  test("a timed-out turn ends max_turn_requests after a notice naming the limit", async () => {
    const late: Script = async function* () {
      yield turnEnd("timed_out");
    };
    const s = setup([late], { features: ALL_FEATURES });
    expect((await s.session.prompt(text("hi"))).stopReason).toBe("max_turn_requests");
    expect(JSON.stringify(s.port.updates.at(-1))).toContain(`${TURN_TIMEOUT_SECONDS}s`);
  });

  test("usage cost accumulates across turns", async () => {
    const priced = (cost: number): Script =>
      async function* () {
        yield { type: "usage", round: 1, inputTokens: 1, outputTokens: 1, costUsd: cost };
        yield turnEnd("completed");
      };
    const s = setup([priced(0.5), priced(0.25)], {}, 200_000);
    await s.session.prompt(text("a"));
    await s.session.prompt(text("b"));
    const usage = s.port.updates.filter((u) => u.sessionUpdate === "usage_update");
    expect(usage.map((u) => (u.sessionUpdate === "usage_update" ? u.cost?.amount : undefined))).toEqual([0.5, 0.75]);
  });
});

function editApproval(requestId: string, extra: { answerable?: false } = {}): Script {
  return async function* ({ reply }) {
    yield { type: "turn_start" };
    yield { type: "tool_call", callId: "c1", name: "Edit", input: { path: "a.ts", old_string: "a", new_string: "b" } };
    yield {
      type: "approval_requested",
      requestId,
      callId: "c1",
      tool: "Edit",
      summary: "Edit a.ts",
      reason: "ask profile",
      expiresAt: FAR_EXPIRY,
      ...extra,
    };
    if (extra.answerable === false) {
      yield { type: "approval_resolved", requestId, decision: "deny", decidedBy: "profile" };
      yield turnEnd("completed");
      return;
    }
    const got = await reply(requestId);
    const allowed = got !== "cancelled" && "decision" in got && got.decision === "allow";
    yield {
      type: "approval_resolved",
      requestId,
      decision: allowed ? "allow" : "deny",
      decidedBy: got === "cancelled" ? "cancelled" : "human",
    };
    yield turnEnd(got === "cancelled" ? "cancelled" : "completed");
  };
}

describe("approvals", () => {
  test("asks the client with the translated tool call and its diff, then answers", async () => {
    const s = setup([editApproval("r1")]);
    expect((await s.session.prompt(text("edit"))).stopReason).toBe("end_turn");
    expect(s.port.asks[0]?.toolCall).toMatchObject({ toolCallId: "c1", kind: "edit", status: "pending" });
    expect(JSON.stringify(s.port.asks[0]?.toolCall.content)).toContain('"oldText":"a"');
    expect(s.fake.answers).toEqual([{ requestId: "r1", reply: { decision: "allow" } }]);
  });

  test("allow_always carries over to the next turn of the same session", async () => {
    const s = setup([editApproval("r1"), editApproval("r2")], { permission: async () => select("allow_always") });
    await s.session.prompt(text("one"));
    await s.session.prompt(text("two"));
    expect(s.port.asks).toHaveLength(1);
    expect(s.fake.answers.map((a) => a.requestId)).toEqual(["r1", "r2"]);
  });

  test("an unanswerable approval sends no permission request (M-1)", async () => {
    const s = setup([editApproval("r1", { answerable: false })]);
    await s.session.prompt(text("edit"));
    expect(s.port.asks).toEqual([]);
    expect(s.port.updates.at(-1)).toMatchObject({ sessionUpdate: "tool_call_update", status: "failed" });
  });

  test("cancel during an open permission request aborts it and ends cancelled", async () => {
    const s = setup([editApproval("r1")], { permission: () => new Promise(() => {}) });
    const pending = s.session.prompt(text("edit"));
    while (s.port.asks.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    s.session.cancel();
    expect((await pending).stopReason).toBe("cancelled");
    expect(s.port.signals[0]?.aborted).toBe(true);
    expect(s.fake.cancels()).toBe(1);
    expect(s.fake.answers).toEqual([]);
  });
});

describe("questions", () => {
  test("a question without elicitation support is answered with the fallback text", async () => {
    const asks: Script = async function* ({ reply }) {
      yield { type: "question", requestId: "q1", text: "Which env?", expiresAt: FAR_EXPIRY };
      const got = await reply("q1");
      yield { type: "text_delta", round: 1, text: got !== "cancelled" && "text" in got ? got.text : "" };
      yield turnEnd("completed");
    };
    const s = setup([asks]);
    await s.session.prompt(text("go"));
    expect(JSON.stringify(s.port.updates.at(-1))).toContain("No answer available");
  });
});

describe("a broken client connection", () => {
  test("cancels the turn, drains it and fails the prompt with internal_error", async () => {
    const chatty: Script = async function* ({ cancelled }) {
      yield { type: "text_delta", round: 1, text: "a" };
      await cancelled;
      yield turnEnd("cancelled");
    };
    const s = setup([chatty], { failUpdates: true });
    const error = await failure(s.session.prompt(text("hi")));
    expect(error.code).toBe(-32603);
    expect(error.message).toContain("client connection closed");
    expect(s.fake.cancels()).toBe(1);
    expect(s.session.running).toBe(false);
    expect(s.lines.some((l) => l.level === "warn")).toBe(true);
  });
});

describe("close", () => {
  test("closes the S3 session", async () => {
    const s = setup([]);
    await s.session.close();
    expect(s.fake.closed()).toBe(true);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `bun test ./test/unit/server/server-session.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 4: Implement `src/server/server-session.ts`**

```ts
/**
 * One ACP session over one S3 AgentSession (S5 spec §3.2, §4.3, §4.4). A prompt
 * is one send(): each event goes through the translator to the client, and
 * approvals and questions start client round trips without blocking the stream.
 * If the client stops accepting updates, the turn is cancelled and drained so
 * the S3 turn slot is freed. In memory only (S5-2); S5-3 adds metadata, locks
 * and close-and-resume.
 */
import {
  type ContentBlock,
  type PromptResponse,
  RequestError,
  type SessionUpdate,
} from "@agentclientprotocol/sdk";
import type { AgentLogger, AgentSession, SessionEvent } from "@nathapp/nax-agent";
import type { ClientPort } from "#src/server/client-port";
import { messageOf, turnInProgress } from "#src/server/errors";
import { createPermissionBroker, type Decision, type PermissionBroker } from "#src/server/permissions";
import { flattenPrompt } from "#src/server/prompt";
import { createQuestionBroker, type QuestionBroker } from "#src/server/questions";
import type { ReadOldText } from "#src/server/translate/diff";
import { createEventTranslator, type EventTranslator } from "#src/server/translate/events";
import { type PromptOutcome, promptOutcome } from "#src/server/translate/stop";

/** S3's default turn limit, passed explicitly so the timeout notice names it (M-15). */
export const TURN_TIMEOUT_SECONDS = 3600;

export interface ServerSessionDeps {
  readonly session: AgentSession;
  readonly port: ClientPort;
  readonly cwd: string;
  readonly contextWindow?: number;
  readonly readOldText: ReadOldText;
  readonly logger: AgentLogger;
  readonly turnTimeoutSeconds: number;
  readonly now?: () => number;
}

export interface ServerSession {
  readonly id: string;
  readonly running: boolean;
  /** Delivered as the first updates of the next turn (M-11). */
  queueNotice(update: SessionUpdate): void;
  prompt(blocks: readonly ContentBlock[]): Promise<PromptResponse>;
  cancel(): void;
  close(): Promise<void>;
}

interface Turn {
  readonly permissions: PermissionBroker;
  readonly questions: QuestionBroker;
}

export function createServerSession(deps: ServerSessionDeps): ServerSession {
  const memory = new Map<string, Decision>();
  let queued: readonly SessionUpdate[] = [];
  let costUsd = 0;
  let running = false;
  let turn: Turn | undefined;

  async function runTurn(message: string): Promise<PromptOutcome | undefined> {
    let broken: unknown;
    const deliver = async (update: SessionUpdate): Promise<void> => {
      if (broken !== undefined) return;
      try {
        await deps.port.update(update);
      } catch (error) {
        broken = error;
        deps.logger.warn("session", "client stopped accepting updates; cancelling the turn", {
          sessionId: deps.session.id,
          error: messageOf(error),
        });
        deps.session.cancel("client connection failed");
      }
    };
    const answer = deps.session.answer.bind(deps.session);
    const translator = createEventTranslator({
      cwd: deps.cwd,
      ...(deps.contextWindow !== undefined ? { contextWindow: deps.contextWindow } : {}),
      readOldText: deps.readOldText,
      clientUpdates: deps.port.features.updates,
      priorCostUsd: costUsd,
    });
    const current: Turn = {
      permissions: createPermissionBroker({ port: deps.port, answer, memory, logger: deps.logger }),
      questions: createQuestionBroker({
        port: deps.port,
        deliver,
        answer,
        logger: deps.logger,
        ...(deps.now !== undefined ? { now: deps.now } : {}),
      }),
    };
    turn = current;
    let outcome: PromptOutcome | undefined;
    try {
      const pending = queued;
      queued = [];
      for (const update of pending) await deliver(update);
      for await (const event of deps.session.send(message)) {
        for (const update of await translator.translate(event)) await deliver(update);
        react(event, current, translator);
        if (event.type === "turn_end") {
          outcome = promptOutcome(event, deps.turnTimeoutSeconds, deps.port.features.updates.notices);
          if (outcome.kind === "response") for (const notice of outcome.notices) await deliver(notice);
        }
      }
    } finally {
      current.permissions.abortAll();
      current.questions.abortAll();
      await Promise.all([current.permissions.drain(), current.questions.drain()]);
      costUsd = translator.costUsd();
      turn = undefined;
    }
    if (broken !== undefined) {
      throw RequestError.internalError(undefined, `could not send a session update: ${messageOf(broken)}`);
    }
    return outcome;
  }

  return {
    id: deps.session.id,
    get running() {
      return running;
    },
    queueNotice(update) {
      queued = [...queued, update];
    },
    async prompt(blocks) {
      if (running) throw turnInProgress();
      const message = flattenPrompt(blocks);
      running = true;
      let outcome: PromptOutcome | undefined;
      try {
        outcome = await runTurn(message);
      } finally {
        running = false;
      }
      if (outcome === undefined) throw RequestError.internalError(undefined, "the turn ended without a turn_end event");
      if (outcome.kind === "error") throw outcome.error;
      return outcome.response;
    },
    cancel() {
      deps.session.cancel("cancelled by the client");
      turn?.permissions.abortAll();
      turn?.questions.abortAll();
    },
    async close() {
      turn?.permissions.abortAll();
      turn?.questions.abortAll();
      await deps.session.close();
    },
  };
}

function react(event: SessionEvent, turn: Turn, translator: EventTranslator): void {
  switch (event.type) {
    case "approval_requested":
      if (event.answerable !== false) {
        turn.permissions.request(event, event.callId === undefined ? undefined : translator.toolCallFor(event.callId));
      }
      return;
    case "approval_resolved":
      turn.permissions.settled(event.requestId);
      return;
    case "question":
      turn.questions.ask(event);
      return;
    default:
      return;
  }
}
```

The `turnInProgress` check comes before any `await`, so two calls in the same tick cannot both start. `flattenPrompt` runs before `running = true`, so invalid content never claims the turn.

If the `check-complexity` gate flags `runTurn`, move the event loop body into a `forwardEvent(event, ctx)` function in the same file. Keep the behaviour unchanged.

- [ ] **Step 5: Run it to verify it passes**

Run: `bun test ./test/unit/server/server-session.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
bun run lint:fix
git add src/server/server-session.ts test/helpers/fake-agent-session.ts test/unit/server/server-session.test.ts
git commit -m "feat(acp-server): S5-2 server session over one S3 AgentSession"
```

---

### Task 6: Opening sessions and the in-memory registry

**Files:**
- Create: `packages/nax-agent-acp/src/server/open-session.ts`
- Create: `packages/nax-agent-acp/src/server/registry.ts`
- Test: `packages/nax-agent-acp/test/unit/server/open-session.test.ts`, `packages/nax-agent-acp/test/unit/server/registry.test.ts`

**Interfaces:**
- Consumes: `ServerOptions` (`#src/server/options`); `BashApproval` (`#src/server/nax-config`); `createServerSession`, `ServerSession` (Task 5); `invalidParams`, `unknownSession`, `messageOf` (Task 1); `ClientPort` (Task 3); `announce` (`#src/server/translate/notice`); `ReadOldText`.
- Produces (`#src/server/open-session`):
  - `interface OpenSessionRequest { readonly sessionId: string; readonly cwd: string; readonly model: string; readonly profile: AgentSessionProfile; readonly bashApproval: BashApproval }`
  - `type OpenSession = (request: OpenSessionRequest) => Promise<AgentSession>`
  - `function catalogOverridesFrom(raw: readonly unknown[], logger: AgentLogger): NativeCatalogOverrides`
  - `interface NativeOpenDeps { readonly sessionsDir: string; readonly catalogOverrides: NativeCatalogOverrides; readonly turnTimeoutSeconds: number; readonly create?: (options: CreateAgentSessionOptions) => Promise<AgentSession>; readonly backend?: (options: NativeBackendOptions) => SessionBackend; readonly store?: (dir: string) => TranscriptStore }`
  - `function nativeOpenSession(deps: NativeOpenDeps): OpenSession`
- Produces (`#src/server/registry`):
  - `const NO_MODEL_MESSAGE = "no model configured: set models.native.balanced or --model"`
  - `const MCP_NOTICE = "MCP servers are not supported yet; ignored"`
  - `interface NewSessionInput { readonly cwd: string; readonly mcpServers: readonly unknown[]; readonly port: (sessionId: string) => ClientPort }`
  - `interface SessionRegistry { create(input: NewSessionInput): Promise<ServerSession>; get(sessionId: string): ServerSession; find(sessionId: string): ServerSession | undefined; closeAll(): Promise<void> }`
  - `interface RegistryDeps { readonly options: ServerOptions; readonly openSession: OpenSession; readonly newId: () => string; readonly readOldText: ReadOldText; readonly logger: AgentLogger; readonly turnTimeoutSeconds: number }`
  - `function createSessionRegistry(deps: RegistryDeps): SessionRegistry`

- [ ] **Step 1: Write the failing tests**

`test/unit/server/open-session.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  type AgentSession,
  type CreateAgentSessionOptions,
  createMemoryTranscriptStore,
  type NativeBackendOptions,
  type SessionBackend,
} from "@nathapp/nax-agent";
import { catalogOverridesFrom, nativeOpenSession } from "#src/server/open-session";
import { fakeAgentSession } from "#test/helpers/fake-agent-session";
import { recordingLogger } from "#test/helpers/recording-logger";

describe("catalogOverridesFrom (M-17)", () => {
  test("keeps entries with a provider and a models array; drops the rest with one warning", () => {
    const { logger, lines } = recordingLogger();
    const kept = catalogOverridesFrom(
      [{ provider: "minimax", models: [{ id: "m" }] }, { provider: "x" }, { models: [] }, "nope"],
      logger,
    );
    expect(kept).toEqual([{ provider: "minimax", models: [{ id: "m" }] }]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: "warn", data: { dropped: 3 } });
  });

  test("no warning when every entry is usable", () => {
    const { logger, lines } = recordingLogger();
    catalogOverridesFrom([], logger);
    expect(lines).toEqual([]);
  });
});

describe("nativeOpenSession", () => {
  test("opens the native backend with the request, a file store in the sessions dir and the turn limit", async () => {
    const backendCalls: NativeBackendOptions[] = [];
    const storeDirs: string[] = [];
    const created: CreateAgentSessionOptions[] = [];
    const stubBackend: SessionBackend = { kind: "native", open: async () => Promise.reject(new Error("unused")) };
    const open = nativeOpenSession({
      sessionsDir: "/cfg/.agent-server/sessions",
      catalogOverrides: [{ provider: "minimax", models: [] }],
      turnTimeoutSeconds: 3600,
      backend: (options) => {
        backendCalls.push(options);
        return stubBackend;
      },
      store: (dir) => {
        storeDirs.push(dir);
        return createMemoryTranscriptStore();
      },
      create: async (options): Promise<AgentSession> => {
        created.push(options);
        return fakeAgentSession(options.sessionId ?? "x", []).session;
      },
    });
    const session = await open({
      sessionId: "s-1",
      cwd: "/w",
      model: "anthropic/claude-sonnet-5-5",
      profile: "ask",
      bashApproval: "gated",
    });
    expect(session.id).toBe("s-1");
    expect(backendCalls).toEqual([
      {
        model: "anthropic/claude-sonnet-5-5",
        bashApproval: "gated",
        catalogOverrides: [{ provider: "minimax", models: [] }],
      },
    ]);
    expect(storeDirs).toEqual(["/cfg/.agent-server/sessions"]);
    expect(created[0]).toMatchObject({
      backend: stubBackend,
      sessionId: "s-1",
      profile: "ask",
      workdir: "/w",
      turnTimeoutSeconds: 3600,
    });
  });

  test("omits catalogOverrides when there are none", async () => {
    const backendCalls: NativeBackendOptions[] = [];
    const open = nativeOpenSession({
      sessionsDir: "/s",
      catalogOverrides: [],
      turnTimeoutSeconds: 3600,
      backend: (options) => {
        backendCalls.push(options);
        return { kind: "native", open: async () => Promise.reject(new Error("unused")) };
      },
      store: () => createMemoryTranscriptStore(),
      create: async (options) => fakeAgentSession(options.sessionId ?? "x", []).session,
    });
    await open({ sessionId: "s", cwd: "/w", model: "m/x", profile: "read", bashApproval: "gated" });
    expect("catalogOverrides" in (backendCalls[0] ?? {})).toBe(false);
  });
});
```

If `createMemoryTranscriptStore` is not in nax-agent's public exports, build an in-test `TranscriptStore` object literal from its interface instead. Check with `grep -n createMemoryTranscriptStore ../nax-agent/src/index.ts`.

`test/unit/server/registry.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { RequestError } from "@agentclientprotocol/sdk";
import type { OpenSessionRequest } from "#src/server/open-session";
import type { ServerOptions } from "#src/server/options";
import { createSessionRegistry, MCP_NOTICE, NO_MODEL_MESSAGE } from "#src/server/registry";
import { TURN_TIMEOUT_SECONDS } from "#src/server/server-session";
import { fakeAgentSession, type Script, turnEnd } from "#test/helpers/fake-agent-session";
import { fakePort } from "#test/helpers/fake-client-port";
import { recordingLogger } from "#test/helpers/recording-logger";

const OPTIONS: ServerOptions = {
  configDir: "/cfg",
  sessionsDir: "/cfg/.agent-server/sessions",
  defaultModel: "anthropic/claude-sonnet-5-5",
  defaultMode: "ask",
  bashApproval: "gated",
  tiers: [{ tier: "balanced", model: "anthropic/claude-sonnet-5-5", contextWindow: 200_000 }],
  catalogOverrides: [],
};

const usageTurn: Script = async function* () {
  yield { type: "usage", round: 1, inputTokens: 1, outputTokens: 1, costUsd: 0.1 };
  yield turnEnd("completed");
};

function setup(options: ServerOptions = OPTIONS, opener?: (r: OpenSessionRequest) => Promise<never>) {
  const opened: OpenSessionRequest[] = [];
  const fakes: ReturnType<typeof fakeAgentSession>[] = [];
  const port = fakePort();
  const { logger, lines } = recordingLogger();
  let next = 0;
  const registry = createSessionRegistry({
    options,
    openSession:
      opener ??
      (async (request) => {
        opened.push(request);
        const fake = fakeAgentSession(request.sessionId, [usageTurn]);
        fakes.push(fake);
        return fake.session;
      }),
    newId: () => `id-${++next}`,
    readOldText: async () => ({ kind: "missing" }),
    logger,
    turnTimeoutSeconds: TURN_TIMEOUT_SECONDS,
  });
  return { registry, opened, fakes, port, lines };
}

async function failure(promise: Promise<unknown>): Promise<RequestError> {
  const caught = await promise.catch((e: unknown) => e);
  if (caught instanceof RequestError) return caught;
  throw new Error(`expected a RequestError, got ${String(caught)}`);
}

describe("createSessionRegistry.create (spec §5.3 session/new)", () => {
  test("opens with the resolved defaults and registers the session", async () => {
    const s = setup();
    const session = await s.registry.create({ cwd: "/w", mcpServers: [], port: () => s.port.port });
    expect(session.id).toBe("id-1");
    expect(s.opened).toEqual([
      { sessionId: "id-1", cwd: "/w", model: "anthropic/claude-sonnet-5-5", profile: "ask", bashApproval: "gated" },
    ]);
    expect(s.registry.get("id-1")).toBe(session);
    expect(s.registry.find("id-1")).toBe(session);
  });

  test("the context window comes from the tier entry for the model", async () => {
    const s = setup();
    const session = await s.registry.create({ cwd: "/w", mcpServers: [], port: () => s.port.port });
    await session.prompt([{ type: "text", text: "go" }]);
    expect(s.port.updates.find((u) => u.sessionUpdate === "usage_update")).toMatchObject({ size: 200_000 });
  });

  test("a relative cwd is invalid_params", async () => {
    const s = setup();
    const error = await failure(s.registry.create({ cwd: "w", mcpServers: [], port: () => s.port.port }));
    expect(error.code).toBe(-32602);
    expect(s.opened).toEqual([]);
  });

  test("no model is invalid_params with the spec message", async () => {
    const { defaultModel: _unused, ...noModel } = OPTIONS;
    const s = setup(noModel);
    const error = await failure(s.registry.create({ cwd: "/w", mcpServers: [], port: () => s.port.port }));
    expect(error.message).toContain(NO_MODEL_MESSAGE);
  });

  test("non-empty mcpServers queue one notice for the first turn", async () => {
    const s = setup();
    const session = await s.registry.create({
      cwd: "/w",
      mcpServers: [{ name: "fs", command: "mcp-fs", args: [], env: [] }],
      port: () => s.port.port,
    });
    expect(s.port.updates).toEqual([]);
    await session.prompt([{ type: "text", text: "go" }]);
    expect(JSON.stringify(s.port.updates[0])).toContain(MCP_NOTICE);
  });

  test("a failed open registers nothing and propagates", async () => {
    const s = setup(OPTIONS, async () => Promise.reject(new Error("sandbox unavailable")));
    await expect(s.registry.create({ cwd: "/w", mcpServers: [], port: () => s.port.port })).rejects.toThrow(
      "sandbox unavailable",
    );
    expect(s.registry.find("id-1")).toBeUndefined();
  });
});

describe("lookup and shutdown", () => {
  test("get on an unknown id is resource_not_found; find is undefined", async () => {
    const s = setup();
    expect(s.registry.find("nope")).toBeUndefined();
    let caught: unknown;
    try {
      s.registry.get("nope");
    } catch (error) {
      caught = error;
    }
    expect(caught instanceof RequestError ? caught.code : 0).toBe(-32002);
  });

  test("closeAll closes every session and forgets them, logging a failed close", async () => {
    const s = setup();
    await s.registry.create({ cwd: "/w", mcpServers: [], port: () => s.port.port });
    await s.registry.create({ cwd: "/w", mcpServers: [], port: () => s.port.port });
    const first = s.fakes[0];
    if (first !== undefined) first.session.close = async () => Promise.reject(new Error("close failed"));
    await s.registry.closeAll();
    expect(s.fakes[1]?.closed()).toBe(true);
    expect(s.registry.find("id-2")).toBeUndefined();
    expect(s.lines.some((l) => l.level === "warn" && l.data?.error === "close failed")).toBe(true);
  });
});
```

The `closeAll` test assigns `first.session.close`. `AgentSession` members are not `readonly` methods, but if the compiler rejects the assignment, give `fakeAgentSession` an option `{ closeFails?: boolean }` instead. Do not cast.

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test ./test/unit/server/open-session.test.ts ./test/unit/server/registry.test.ts`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement `src/server/open-session.ts`**

```ts
/**
 * Opens the S3 session behind an ACP session (S5 spec §5.3 session/new): the
 * native backend with the session's model and bash approval, and a file
 * transcript store in the sessions directory (M-9). The facade factories are
 * injectable for tests.
 */
import {
  type AgentLogger,
  type AgentSession,
  type AgentSessionProfile,
  type CreateAgentSessionOptions,
  createAgentSession,
  createFileTranscriptStore,
  type NativeBackendOptions,
  type NativeCatalogOverrides,
  nativeBackend,
  type SessionBackend,
  type TranscriptStore,
} from "@nathapp/nax-agent";
import type { BashApproval } from "#src/server/nax-config";

export interface OpenSessionRequest {
  readonly sessionId: string;
  readonly cwd: string;
  readonly model: string;
  readonly profile: AgentSessionProfile;
  readonly bashApproval: BashApproval;
}

export type OpenSession = (request: OpenSessionRequest) => Promise<AgentSession>;

type CatalogOverride = NativeCatalogOverrides[number];

function isCatalogOverride(value: unknown): value is CatalogOverride {
  return (
    typeof value === "object" &&
    value !== null &&
    "provider" in value &&
    typeof value.provider === "string" &&
    "models" in value &&
    Array.isArray(value.models)
  );
}

/** Entries nax's own schema would reject are dropped here, with one warning (M-17). */
export function catalogOverridesFrom(raw: readonly unknown[], logger: AgentLogger): NativeCatalogOverrides {
  const kept = raw.filter(isCatalogOverride);
  if (kept.length < raw.length) {
    logger.warn("config", "ignoring agent.native.catalogOverrides entries without provider and models", {
      dropped: raw.length - kept.length,
    });
  }
  return kept;
}

export interface NativeOpenDeps {
  readonly sessionsDir: string;
  readonly catalogOverrides: NativeCatalogOverrides;
  readonly turnTimeoutSeconds: number;
  readonly create?: (options: CreateAgentSessionOptions) => Promise<AgentSession>;
  readonly backend?: (options: NativeBackendOptions) => SessionBackend;
  readonly store?: (dir: string) => TranscriptStore;
}

export function nativeOpenSession(deps: NativeOpenDeps): OpenSession {
  const create = deps.create ?? createAgentSession;
  const backend = deps.backend ?? nativeBackend;
  const store = deps.store ?? createFileTranscriptStore;
  return (request) =>
    create({
      backend: backend({
        model: request.model,
        bashApproval: request.bashApproval,
        ...(deps.catalogOverrides.length > 0 ? { catalogOverrides: deps.catalogOverrides } : {}),
      }),
      sessionId: request.sessionId,
      profile: request.profile,
      workdir: request.cwd,
      transcriptStore: store(deps.sessionsDir),
      turnTimeoutSeconds: deps.turnTimeoutSeconds,
    });
}
```

`nativeBackend` validates its options synchronously, and `createAgentSession` validates the rest. Both throw `AgentSessionError`, which `guard` maps (Task 1). If `TranscriptStore` or `SessionBackend` is not exported under those names, use the exported names from `../nax-agent/src/index.ts`. Do not reach into `#src` of nax-agent.

- [ ] **Step 4: Implement `src/server/registry.ts`**

```ts
/**
 * ACP session id -> ServerSession, in memory (S5 spec §3.1; S5-3 makes it
 * persistent). `create` is session/new: an absolute cwd and a model are
 * required; the MCP notice is queued for the first turn (M-11). `closeAll` is
 * the S5-2 shutdown (M-16).
 */
import { isAbsolute } from "node:path";
import type { AgentLogger } from "@nathapp/nax-agent";
import type { ClientPort } from "#src/server/client-port";
import { invalidParams, messageOf, unknownSession } from "#src/server/errors";
import type { OpenSession } from "#src/server/open-session";
import type { ServerOptions } from "#src/server/options";
import { createServerSession, type ServerSession } from "#src/server/server-session";
import type { ReadOldText } from "#src/server/translate/diff";
import { announce } from "#src/server/translate/notice";

export const NO_MODEL_MESSAGE = "no model configured: set models.native.balanced or --model";
export const MCP_NOTICE = "MCP servers are not supported yet; ignored";

export interface NewSessionInput {
  readonly cwd: string;
  readonly mcpServers: readonly unknown[];
  readonly port: (sessionId: string) => ClientPort;
}

export interface SessionRegistry {
  create(input: NewSessionInput): Promise<ServerSession>;
  /** Throws resource_not_found for an unknown id. */
  get(sessionId: string): ServerSession;
  find(sessionId: string): ServerSession | undefined;
  closeAll(): Promise<void>;
}

export interface RegistryDeps {
  readonly options: ServerOptions;
  readonly openSession: OpenSession;
  readonly newId: () => string;
  readonly readOldText: ReadOldText;
  readonly logger: AgentLogger;
  readonly turnTimeoutSeconds: number;
}

export function createSessionRegistry(deps: RegistryDeps): SessionRegistry {
  const sessions = new Map<string, ServerSession>();
  const { options } = deps;

  return {
    async create(input) {
      if (!isAbsolute(input.cwd)) throw invalidParams(`cwd must be an absolute path: ${input.cwd}`);
      const model = options.defaultModel;
      if (model === undefined) throw invalidParams(NO_MODEL_MESSAGE);
      const sessionId = deps.newId();
      const agentSession = await deps.openSession({
        sessionId,
        cwd: input.cwd,
        model,
        profile: options.defaultMode,
        bashApproval: options.bashApproval,
      });
      const port = input.port(sessionId);
      const contextWindow = options.tiers.find((tier) => tier.model === model)?.contextWindow;
      const session = createServerSession({
        session: agentSession,
        port,
        cwd: input.cwd,
        ...(contextWindow !== undefined ? { contextWindow } : {}),
        readOldText: deps.readOldText,
        logger: deps.logger,
        turnTimeoutSeconds: deps.turnTimeoutSeconds,
      });
      if (input.mcpServers.length > 0) {
        session.queueNotice(announce(port.features.updates.notices, "warning", MCP_NOTICE));
      }
      sessions.set(sessionId, session);
      deps.logger.info("session", "session opened", { sessionId, cwd: input.cwd, model, mode: options.defaultMode });
      return session;
    },
    get(sessionId) {
      const session = sessions.get(sessionId);
      if (session === undefined) throw unknownSession(sessionId);
      return session;
    },
    find: (sessionId) => sessions.get(sessionId),
    async closeAll() {
      const open = [...sessions.entries()];
      sessions.clear();
      const results = await Promise.allSettled(open.map(([, session]) => session.close()));
      results.forEach((result, index) => {
        if (result.status === "rejected") {
          deps.logger.warn("session", "session close failed", {
            sessionId: open[index]?.[0],
            error: messageOf(result.reason),
          });
        }
      });
    },
  };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test ./test/unit/server/open-session.test.ts ./test/unit/server/registry.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
bun run lint:fix
git add src/server/open-session.ts src/server/registry.ts test/unit/server/open-session.test.ts test/unit/server/registry.test.ts
git commit -m "feat(acp-server): S5-2 native session opener and in-memory session registry"
```

---

### Task 7: Wire the handlers into the connection and main

**Files:**
- Modify: `packages/nax-agent-acp/src/server/connection.ts`
- Modify: `packages/nax-agent-acp/src/server/main.ts`
- Modify: `packages/nax-agent-acp/test/unit/server/connection.test.ts`
- Modify: `packages/nax-agent-acp/test/unit/server/stdout-purity.test.ts`
- Create: `packages/nax-agent-acp/test/unit/server/connection-sessions.test.ts`
- Modify (maintainer workspace, outside the repo): `nax-agent-master-plan.md`, S5 row

**Interfaces:**
- Consumes: everything above.
- Produces: `interface AppDeps { readonly version: string; readonly registry: SessionRegistry; readonly logger: AgentLogger }` and `buildAgentApp(deps: AppDeps): AgentApp`. `buildAgentApp` handles `initialize`, `session/new`, `session/prompt` and the `session/cancel` notification. `main` builds the registry and closes it after the connection closes. `MainDeps` and the package exports are unchanged, so the API snapshot does not change.

- [ ] **Step 1: Write the failing end-to-end tests**

`test/unit/server/connection-sessions.test.ts` drives the real SDK client against the app:

```ts
import { describe, expect, test } from "bun:test";
import {
  type ClientCapabilities,
  client,
  PROTOCOL_VERSION,
  RequestError,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import { buildAgentApp } from "#src/server/connection";
import type { ServerOptions } from "#src/server/options";
import { createSessionRegistry } from "#src/server/registry";
import { TURN_TIMEOUT_SECONDS } from "#src/server/server-session";
import { FAR_EXPIRY, fakeAgentSession, type Script, turnEnd } from "#test/helpers/fake-agent-session";
import { recordingLogger } from "#test/helpers/recording-logger";

const OPTIONS: ServerOptions = {
  configDir: "/cfg",
  sessionsDir: "/cfg/s",
  defaultModel: "anthropic/claude-sonnet-5-5",
  defaultMode: "ask",
  bashApproval: "gated",
  tiers: [],
  catalogOverrides: [],
};

function app(scriptsFor: (sessionId: string) => readonly Script[], open?: () => Promise<never>) {
  const { logger, lines } = recordingLogger();
  let next = 0;
  const registry = createSessionRegistry({
    options: OPTIONS,
    openSession: open ?? (async (request) => fakeAgentSession(request.sessionId, scriptsFor(request.sessionId)).session),
    newId: () => `s${++next}`,
    readOldText: async () => ({ kind: "missing" }),
    logger,
    turnTimeoutSeconds: TURN_TIMEOUT_SECONDS,
  });
  return { agentApp: buildAgentApp({ version: "9.9.9", registry, logger }), lines };
}

const say = (words: string): Script =>
  async function* () {
    yield { type: "text_delta", round: 1, text: words };
    yield turnEnd("completed");
  };

const waitForCancel: Script = async function* ({ cancelled }) {
  yield { type: "text_delta", round: 1, text: "working" };
  await cancelled;
  yield turnEnd("cancelled");
};

const editAsk: Script = async function* ({ reply }) {
  yield { type: "tool_call", callId: "c1", name: "Edit", input: { path: "a.ts", old_string: "a", new_string: "b" } };
  yield {
    type: "approval_requested",
    requestId: "r1",
    callId: "c1",
    tool: "Edit",
    summary: "Edit a.ts",
    reason: "ask",
    expiresAt: FAR_EXPIRY,
  };
  const got = await reply("r1");
  const allowed = got !== "cancelled" && "decision" in got && got.decision === "allow";
  yield { type: "text_delta", round: 2, text: allowed ? "applied" : "skipped" };
  yield turnEnd("completed");
};

const asksQuestion: Script = async function* ({ reply }) {
  yield { type: "question", requestId: "q1", text: "Which env?", expiresAt: FAR_EXPIRY };
  const got = await reply("q1");
  yield { type: "text_delta", round: 1, text: got !== "cancelled" && "text" in got ? got.text : "" };
  yield turnEnd("completed");
};

function texts(updates: readonly SessionNotification[], sessionId: string): string {
  return updates
    .filter((n) => n.sessionId === sessionId)
    .map((n) => (n.update.sessionUpdate === "agent_message_chunk" && n.update.content.type === "text" ? n.update.content.text : ""))
    .join("");
}

async function connect<T>(
  agentApp: ReturnType<typeof app>["agentApp"],
  work: (agent: Parameters<Parameters<ReturnType<typeof client>["connectWith"]>[1]>[0], updates: SessionNotification[]) => Promise<T>,
  capabilities: ClientCapabilities = {},
): Promise<T> {
  const updates: SessionNotification[] = [];
  return client({ name: "test" })
    .onNotification("session/update", (ctx) => {
      updates.push(ctx.params);
    })
    .onRequest("session/request_permission", async () => ({ outcome: { outcome: "selected", optionId: "allow_once" } }))
    .onRequest("elicitation/create", async () => ({ action: "accept", content: { answer: "staging" } }))
    .connectWith(agentApp, async (agent) => {
      await agent.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: capabilities });
      return work(agent, updates);
    });
}

describe("session/new + session/prompt over a real SDK connection", () => {
  test("streams the turn and ends end_turn", async () => {
    const { agentApp } = app(() => [say("hello")]);
    const result = await connect(agentApp, async (agent, updates) => {
      const { sessionId } = await agent.request("session/new", { cwd: "/w", mcpServers: [] });
      const response = await agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "hi" }] });
      return { sessionId, response, text: texts(updates, sessionId) };
    });
    expect(result.sessionId).toBe("s1");
    expect(result.response.stopReason).toBe("end_turn");
    expect(result.text).toBe("hello");
  });

  test("the session/new response carries no modes or config options yet (M-10)", async () => {
    const { agentApp } = app(() => []);
    const response = await connect(agentApp, (agent) => agent.request("session/new", { cwd: "/w", mcpServers: [] }));
    expect(response).toEqual({ sessionId: "s1" });
  });

  test("a permission round trip through the client's handler", async () => {
    const { agentApp } = app(() => [editAsk]);
    const text = await connect(agentApp, async (agent, updates) => {
      const { sessionId } = await agent.request("session/new", { cwd: "/w", mcpServers: [] });
      await agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "edit" }] });
      return texts(updates, sessionId);
    });
    expect(text).toBe("applied");
  });

  test("a question goes to elicitation when the client declares it", async () => {
    const { agentApp } = app(() => [asksQuestion]);
    const text = await connect(
      agentApp,
      async (agent, updates) => {
        const { sessionId } = await agent.request("session/new", { cwd: "/w", mcpServers: [] });
        await agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "go" }] });
        return texts(updates, sessionId);
      },
      { elicitation: { form: {} } },
    );
    expect(text).toBe("staging");
  });

  test("session/cancel arrives during a running prompt and ends it cancelled", async () => {
    const { agentApp } = app(() => [waitForCancel]);
    const stop = await connect(agentApp, async (agent, updates) => {
      const { sessionId } = await agent.request("session/new", { cwd: "/w", mcpServers: [] });
      const prompt = agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "go" }] });
      while (texts(updates, sessionId) === "") await new Promise((resolve) => setTimeout(resolve, 1));
      await agent.notify("session/cancel", { sessionId });
      return (await prompt).stopReason;
    });
    expect(stop).toBe("cancelled");
  });

  test("two sessions prompt at once; a second prompt on one session is turn in progress", async () => {
    const { agentApp } = app((id) => (id === "s1" ? [waitForCancel] : [say("two")]));
    const result = await connect(agentApp, async (agent, updates) => {
      const a = await agent.request("session/new", { cwd: "/w", mcpServers: [] });
      const b = await agent.request("session/new", { cwd: "/w", mcpServers: [] });
      const first = agent.request("session/prompt", { sessionId: a.sessionId, prompt: [{ type: "text", text: "1" }] });
      while (texts(updates, a.sessionId) === "") await new Promise((resolve) => setTimeout(resolve, 1));
      const busy = await agent
        .request("session/prompt", { sessionId: a.sessionId, prompt: [{ type: "text", text: "again" }] })
        .catch((e: unknown) => e);
      const second = await agent.request("session/prompt", { sessionId: b.sessionId, prompt: [{ type: "text", text: "2" }] });
      await agent.notify("session/cancel", { sessionId: a.sessionId });
      return { busy, second: second.stopReason, first: (await first).stopReason, bText: texts(updates, b.sessionId) };
    });
    expect(result.busy instanceof RequestError ? result.busy.code : 0).toBe(-32600);
    expect(result.second).toBe("end_turn");
    expect(result.bText).toBe("two");
    expect(result.first).toBe("cancelled");
  });
});

describe("errors over the connection (spec §7)", () => {
  test("a prompt for an unknown session is resource_not_found", async () => {
    const { agentApp } = app(() => []);
    const error = await connect(agentApp, (agent) =>
      agent.request("session/prompt", { sessionId: "nope", prompt: [{ type: "text", text: "x" }] }).catch((e: unknown) => e),
    );
    expect(error instanceof RequestError ? error.code : 0).toBe(-32002);
  });

  test("a cancel for an unknown session is ignored", async () => {
    const { agentApp } = app(() => [say("ok")]);
    const stop = await connect(agentApp, async (agent) => {
      await agent.notify("session/cancel", { sessionId: "nope" });
      const { sessionId } = await agent.request("session/new", { cwd: "/w", mcpServers: [] });
      return (await agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "x" }] })).stopReason;
    });
    expect(stop).toBe("end_turn");
  });

  test("an unexpected failure is internal_error with the message only, logged, and the connection keeps serving", async () => {
    const { agentApp, lines } = app(() => [], async () => Promise.reject(new Error("disk full")));
    const result = await connect(agentApp, async (agent) => {
      const failed = await agent.request("session/new", { cwd: "/w", mcpServers: [] }).catch((e: unknown) => e);
      const again = await agent.request("session/new", { cwd: "relative", mcpServers: [] }).catch((e: unknown) => e);
      return { failed, again };
    });
    expect(result.failed instanceof RequestError ? result.failed.message : "").toBe("Internal error: disk full");
    expect(result.again instanceof RequestError ? result.again.code : 0).toBe(-32602);
    expect(lines.some((l) => l.level === "error" && l.data?.error === "disk full")).toBe(true);
  });
});
```

If the `connect` helper's parameter type spelled through `Parameters<...>` does not resolve, import `ClientContext` from `@agentclientprotocol/sdk` and type `work` as `(agent: ClientContext, updates: SessionNotification[]) => Promise<T>`.

In `test/unit/server/connection.test.ts`:
- Pass the new deps: `buildAgentApp({ version: "9.9.9", registry: emptyRegistry(), logger: recordingLogger().logger })`. `emptyRegistry()` is `createSessionRegistry` with the `OPTIONS` above and an `openSession` that rejects.
- Rename the test to "an in-process client gets the response; session/load is not served yet".
- Change its request to `agent.request("session/load", { sessionId: "s", cwd: "/tmp", mcpServers: [] })`, still expecting -32601.
- Keep the `initializeResponse` pin unchanged (M-10: S5-2 adds no capability flags).
- `serveStdio` gets the same new deps.

In `test/unit/server/stdout-purity.test.ts`:
- Frame 2's expected error becomes -32602 (no model configured).
- Add `child.stdin.write(frame(4, "session/prompt", { sessionId: "nope", prompt: [{ type: "text", text: "x" }] }));` and `expect(frames.find((f) => f.id === 4)?.error?.code).toBe(-32002);`.

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test ./test/unit/server/connection-sessions.test.ts ./test/unit/server/connection.test.ts ./test/unit/server/stdout-purity.test.ts`
Expected: FAIL. `buildAgentApp` does not take a registry, and session methods are not found.

- [ ] **Step 3: Implement `src/server/connection.ts`**

```ts
/**
 * The ACP agent app and its stdio transport (S5 spec §3.1). Uses the SDK's
 * `agent()` builder, not the deprecated AgentSideConnection. The client's
 * optional features are read once, at `initialize`. Every request handler runs
 * under `guard` (spec §7): one failure never stops the connection.
 */
import { Readable, Writable } from "node:stream";
import { type AgentApp, type AgentConnection, agent, ndJsonStream } from "@agentclientprotocol/sdk";
import type { AgentLogger } from "@nathapp/nax-agent";
import { initializeResponse } from "#src/server/capabilities";
import { type ClientFeatures, clientFeatures, clientPort, NO_CLIENT_FEATURES } from "#src/server/client-port";
import { guard } from "#src/server/errors";
import type { SessionRegistry } from "#src/server/registry";

export interface AppDeps {
  readonly version: string;
  readonly registry: SessionRegistry;
  readonly logger: AgentLogger;
}

export function buildAgentApp(deps: AppDeps): AgentApp {
  let features: ClientFeatures = NO_CLIENT_FEATURES;
  return agent({ name: "nax-agent" })
    .onRequest("initialize", (ctx) => {
      features = clientFeatures(ctx.params.clientCapabilities);
      return initializeResponse(deps.version);
    })
    .onRequest("session/new", (ctx) =>
      guard(deps.logger, async () => {
        const session = await deps.registry.create({
          cwd: ctx.params.cwd,
          mcpServers: ctx.params.mcpServers,
          port: (sessionId) => clientPort(ctx.client, sessionId, features),
        });
        return { sessionId: session.id };
      }),
    )
    .onRequest("session/prompt", (ctx) =>
      guard(deps.logger, () => deps.registry.get(ctx.params.sessionId).prompt(ctx.params.prompt)),
    )
    .onNotification("session/cancel", (ctx) => {
      const session = deps.registry.find(ctx.params.sessionId);
      if (session === undefined) {
        deps.logger.debug("session", "cancel for an unknown session ignored", { sessionId: ctx.params.sessionId });
        return;
      }
      session.cancel();
    });
}

export function serveStdio(
  app: AgentApp,
  io: { readonly stdin: Readable; readonly stdout: Writable },
): AgentConnection {
  return app.connect(ndJsonStream(Writable.toWeb(io.stdout), Readable.toWeb(io.stdin)));
}
```

The `ctx.client` captured in `session/new` serves that session's later updates and requests. It is the connection's client context.

- [ ] **Step 4: Wire `src/server/main.ts`**

In `serveAcp`, after `configureCredentials(...)`, replace the `serveStdio(buildAgentApp({ version: packageVersion() }), deps)` line with:

```ts
  const registry = createSessionRegistry({
    options: resolved.options,
    openSession: nativeOpenSession({
      sessionsDir: resolved.options.sessionsDir,
      catalogOverrides: catalogOverridesFrom(resolved.options.catalogOverrides, logger),
      turnTimeoutSeconds: TURN_TIMEOUT_SECONDS,
    }),
    newId: randomUUID,
    readOldText: fsReadOldText(),
    logger,
    turnTimeoutSeconds: TURN_TIMEOUT_SECONDS,
  });
  const connection = serveStdio(buildAgentApp({ version: packageVersion(), registry, logger }), deps);
```

Replace the final `try` block with:

```ts
  try {
    await connection.closed;
    return 0;
  } catch (error) {
    logger.error("server", "connection failed", { error: error instanceof Error ? error.message : String(error) });
    return 1;
  } finally {
    await registry.closeAll();
  }
```

Add these imports: `randomUUID` from `node:crypto`; `catalogOverridesFrom` and `nativeOpenSession` from `#src/server/open-session`; `createSessionRegistry` from `#src/server/registry`; `TURN_TIMEOUT_SECONDS` from `#src/server/server-session`; `fsReadOldText` from `#src/server/translate/diff`. `randomUUID` is plain Node, not a Bun API.

- [ ] **Step 5: Run the server suite**

Run: `bun test ./test/unit/server/ --timeout=60000`
Expected: PASS, including the existing `main`, `process-entry` and `stdout-purity` tests.

- [ ] **Step 6: Full gates**

From `packages/nax-agent-acp`:
- Run: `bun run typecheck && bun run check:all && bun test ./test/unit/ --timeout=60000 && bun run test:coverage && bun run test:node && bun run check:api`
- Expected: all PASS. Every new file is at >= 80% line coverage. `check:api` is unchanged, because no export changed.

If a gate fails, fix the cause. Do not raise a baseline. The one exception is `check:test-satellites`: if it reports the new test files as unregistered, run `bun run check:test-satellites:update` and include the baseline change.

From `packages/nax-agent`, run: `bun run typecheck && bun run check:all && bun test ./test/unit/ --timeout=60000`. Task 0 is in this branch, so its gates are rechecked here.

- [ ] **Step 7: Commit**

```bash
bun run lint:fix
git add src/server/connection.ts src/server/main.ts test/unit/server/connection.test.ts test/unit/server/connection-sessions.test.ts test/unit/server/stdout-purity.test.ts
git commit -m "feat(acp-server): S5-2 serve session/new, session/prompt and session/cancel"
```

- [ ] **Step 8: Code review, PR, master-plan row**

- Run one code review of the branch diff against main before pushing (working agreement: review before push).
- Open one PR, `feat(acp-server): S5-2 session core`, with this plan's path and the decisions M-8..M-18 in the body.
- After merge, update the S5 row of the maintainer workspace's `nax-agent-master-plan.md` to `IN PROGRESS (S5-0, S5-1, S5-2 merged)`.
- Then write the S5-3 plan (M-6).
