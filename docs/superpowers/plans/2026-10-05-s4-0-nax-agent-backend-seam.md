# S4-0: nax-agent 0.3.0 backend seam (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the S3 session facade into a backend-neutral host, so a second backend (the S4 ACP client in a later PR) plugs in without touching nax-agent. This PR delivers:
- a public `SessionBackend` seam with the native backend behind it (`nativeBackend()`);
- the clean 0.3.0 options break;
- a fourth profile `ask`;
- the contract additions S4 needs;
- a public "backend kit" of helpers.

**Architecture:**
- The facade (`src/session/agent-session.ts`) keeps:
  - the single-flight turn, the event channel, the pending-ask table and deadlines;
  - `markTurn` and `turn_end`.
- Everything native moves into `nativeBackend(opts)` (`src/session/native-backend.ts`):
  - the sandbox launcher, tool support and interaction handler;
  - `NativeSessionAdapter` and loop handlers;
  - the resume model check.
- The facade calls `backend.open(ctx)` with a `BackendOpenContext`. Approvals and questions reach a backend through a public `SessionAskPort` built on the existing ask table.
- Native `ask` reuses the policy engine's existing ask rules: no policy-engine change.

**Tech Stack:**
- TypeScript, Bun 1.4 (bun:test unit and integration), vitest on Node 22/24 (`test/node/`);
- zod 4 for option validation;
- `@nathapp/nax-ai@0.1.16` (pinned, unchanged).

**Spec:** `docs/superpowers/specs/2026-10-05-s4-acp-backend-design.md`:
- §5.1-§5.7 (the seam, native backend, options break, profiles, contract additions, backend kit, turn ending);
- §9 (nax-agent tests);
- §10 row S4-0 and its Done-when.

**Base:** `feat/s4-acp-backend` (branched from `main` @ `57ed87c17`; holds only the spec commits). One PR for S4-0. No release in this PR: nax-agent 0.3.0 is released together with nax-agent-acp 0.3.0 after S4-6.

## Global Constraints

- **Dependency direction** `nax-ai` → `nax-agent` → `nax`. New `src/session/` and `src/infra/` files import nax-agent modules only (`check:nax-ai-imports`). nax-agent never imports ACP or MCP packages.
- **Node built-ins only** in `src/` (`check:no-bun-apis`). `test/node/` uses vitest and `node:` only; never `bun:test` or `#test/helpers/index`.
- **Every thrown error is a `NaxError`** (`check-nax-error`). Public facade errors are `AgentSessionError`. A failure that is a turn failure but not a facade code uses `new NaxError(message, code, { stage: "agent-session", ... })`.
- **Public names on `.`** are explicit (no `export *`), never start with `_`, and `src/index.ts` is hand-ordered by byte code (keep its biome-ignore and insert new lines in byte order). After each task that changes `.`:
  1. run `bun run check:api` and read the diff;
  2. run `bun run api:update`;
  3. commit `api/nax-agent.api.txt`.
- **Coverage** 80% overall and per file, empty baseline (`bun run test:coverage`). Every new `src/` file with executable code needs a bun unit test that imports it. Type-only files are exempt.
- **Size and complexity:** source ≤ 600 lines, tests ≤ 800 lines (`check-file-sizes`); cognitive complexity ≤ 20 per function. After every task that touches `src/`, run `bun ../repo-tooling/scripts/check-complexity.ts --package=.`.
- **Commands:**
  - From `packages/nax-agent`: `bun test ./test/unit/session/<file>.test.ts --timeout=60000` for one file; `bun run test` for the package; `bun run test:node` for vitest; `bun run check:all` for lint and gates.
  - Never run bare `bun test` (no path) and never `bun run nax`.
  - Run `bun run lint:fix` before committing a task, so biome formatting never fails CI.
- **No compatibility layer** for the 0.2.0 options shape (spec R5). nax does not call `createAgentSession`/`resumeAgentSession` (verified: no hits under `packages/nax/src`).
- **No policy-engine change.** If Task 6's tests show a mutating tool cannot be forced to the ask tier through `askRules`, STOP and report to the controller. Do not edit `src/tools/policy*.ts`.
- **Commits:** conventional (`feat(nax-agent): …`, `refactor(nax-agent): …`, `test(nax-agent): …`, `docs(nax-agent): …`), one or more per task, no attribution trailer.

## Review Focus

1. **A resumed 0.2.0 document** (no `backend` field) resumed with `nativeBackend` must still work, and with a non-native backend kind must fail `AGENT_SESSION_BACKEND_MISMATCH` before any backend opens. Test in Task 5.
2. **A native-only option passed at the top level** (for example `model` or `bashApproval` next to `backend`) must fail `AGENT_SESSION_INVALID_OPTIONS` naming the key, not be silently ignored. Test in Task 5.
3. **`ask` with `bashApproval: "raw"` or `"escalate"`** must be rejected, because under `raw` the command branch returns before ask rules and Bash would run unprompted. Test in Task 6.
4. **An approval requested with no running turn** (a backend calling the port between turns) must fail fast with `AGENT_SESSION_TURN_FAILED` (detail `no-turn`), not hang until the deadline. `recordAutoDecision` and `noteQuestion` with no turn must be silent no-ops. Test in Task 3.
5. **`close()` must abort the context's `openSignal` and run `OpenedBackend.close()` exactly once,** even when `adapter.closeSession` throws (a second backend's resources must not leak). Test in Task 5.

---

## File map

| File | Change | Responsibility |
|---|---|---|
| `src/session/session-backend.ts` | create (types only) | `SessionBackend`, `BackendOpenContext`, `OpenedBackend`, `BackendInfo`, `TurnContribution`, `SessionAskPort`, `ApprovalRequest` |
| `src/session/agent-session-types.ts` | modify | profile `ask`; `decidedBy: "profile"`; `costSource`; new `CreateAgentSessionOptions`; `AgentSession.backend` |
| `src/session/agent-session-errors.ts` | modify | four new codes |
| `src/session/turn-event.ts` | modify | `costSource` on `usage` |
| `src/session/session-types.ts` | modify | `TurnResult.costSource` |
| `src/native/session/transcript-types.ts` | modify (types only) | `TranscriptDoc.backend`, `TranscriptDoc.acp` |
| `src/infra/stderr-tail.ts` | create | bounded, redacting stderr tail |
| `src/session/session-ask-port.ts` | create | `createSessionAskPort` |
| `src/session/session-ask-link.ts` | modify | the native AskLink built over the port |
| `src/session/session-interaction.ts` | modify | uses the port |
| `src/session/native-backend-options.ts` | create | native options schema and profile rules |
| `src/session/native-backend.ts` | create | `nativeBackend()` |
| `src/session/session-tool-support.ts` | modify | `ask` profile: ask rules, sandbox floor |
| `src/session/agent-session-options.ts` | modify | shared options only |
| `src/session/agent-session-resume.ts` | modify | no model check; backend-kind check |
| `src/session/agent-session-turn.ts` | modify | `TurnRunContext` carries `turnOpts()` |
| `src/session/agent-session.ts` | modify | `assemble` → `backend.open`; close order; `backend` getter |
| `src/index.ts` | modify | new public names |
| `test/helpers/agent-session.ts` | modify | `sessionOptions` splits native keys into `nativeBackend()` |
| `test/node/fixtures/packed-smoke.mjs`, `live-chat-smoke.mjs` | modify | new options shape |
| `README.md`, `CHANGELOG.md` | modify | 0.3.0 docs |
| `api/nax-agent.api.txt` | regenerate | snapshot |

---

### Task 1: Contract types (additive)

**Files:**
- Create: `packages/nax-agent/src/session/session-backend.ts`
- Modify: `src/session/agent-session-types.ts`, `src/session/agent-session-errors.ts`, `src/session/turn-event.ts`, `src/session/session-types.ts` (the `TurnResult` interface), `src/native/session/transcript-types.ts`, `src/session/agent-session-turn.ts` (`turnEndFromResult` only), `src/index.ts`
- Test: `test/unit/session/agent-session-errors.test.ts`, `test/unit/session/session-turn-error.test.ts` (or the file that unit-tests `turnEndFromResult`; it is imported in `test/unit/session/agent-session-chat.test.ts`)

**Interfaces:**
- Produces (used by every later task):

```ts
// src/session/session-backend.ts
import type { TranscriptDoc, TranscriptStore } from "#src/native/session/transcript-types";
import type { AgentSessionProfile, ApprovalDecidedBy, EmbedderTool } from "./agent-session-types.ts";
import type { AgentSessionAdapter, SendTurnOpts, SessionHandle } from "./session-types.ts";

export interface BackendInfo {
  /** "native" or "acp:<agent>"; recorded in the transcript document. */
  readonly kind: string;
  /** Read-only, JSON-safe capability summary. `{}` for native. */
  readonly capabilities: Readonly<Record<string, unknown>>;
}

export interface ApprovalRequest {
  readonly callId?: string;
  readonly tool: string;
  readonly summary: string;
  readonly command?: string;
  readonly reason: string;
  /** Extra abort source, combined with the turn signal (for example a tool-level abort). */
  readonly signal?: AbortSignal;
}

export interface SessionAskPort {
  /** Throws NaxError AGENT_SESSION_TURN_FAILED (context.detail "no-turn") when no turn is running. */
  requestApproval(req: ApprovalRequest): Promise<{ readonly decision: "allow" | "deny"; readonly decidedBy: ApprovalDecidedBy }>;
  /** Emits approval_requested then approval_resolved (decidedBy "profile"). No-op when no turn is running. */
  recordAutoDecision(req: Omit<ApprovalRequest, "command" | "signal">, decision: "allow" | "deny"): void;
  /** The person's text, or null on deadline, cancel or no running turn. */
  askQuestion(text: string): Promise<string | null>;
  /** An informational question event; answer() on its id returns "cancelled". No-op when no turn is running. */
  noteQuestion(text: string): void;
}

/** What a backend contributes to every sendTurn. */
export type TurnContribution = Pick<SendTurnOpts, "interactionHandler"> &
  Partial<Pick<SendTurnOpts, "codingTools" | "loopHandlers" | "loopHandlerContext">>;

export interface BackendOpenContext {
  readonly sessionId: string;
  /** The facade's resolved root: the workdir, or a private scratch root for profile "none". */
  readonly workdir: string;
  readonly profile: AgentSessionProfile;
  readonly instructions: string | undefined;
  readonly tools: readonly EmbedderTool[];
  readonly transcriptStore: TranscriptStore;
  /** The stored document on resume (already presence-, schema- and kind-checked by the facade). */
  readonly resume: { readonly doc: TranscriptDoc } | undefined;
  readonly asks: SessionAskPort;
  /** Re-read at use time: the running turn's signal, or a never-aborting one between turns. */
  readonly turnSignal: () => AbortSignal;
  readonly currentTurnId: () => string | undefined;
  readonly turnTimeoutSeconds: number;
  readonly metadata: Readonly<Record<string, string>>;
  /** Aborted when the session starts closing. */
  readonly openSignal: AbortSignal;
}

export interface OpenedBackend {
  readonly adapter: AgentSessionAdapter;
  readonly handle: SessionHandle;
  readonly info: BackendInfo;
  turnOpts(): TurnContribution;
  /** Releases backend resources after adapter.closeSession. Idempotent. */
  close(): Promise<void>;
}

export interface SessionBackend {
  readonly kind: string;
  open(ctx: BackendOpenContext): Promise<OpenedBackend>;
}
```

- Also produces:
  - `AgentSessionProfile = "none" | "read" | "ask" | "full"`
  - `ApprovalDecidedBy` gains `"profile"`
  - `CostSource = "computed" | "reported" | "unpriced"`
  - `costSource?: CostSource` on `TurnEvent` `usage`, on `SessionEventBody` `usage` and `turn_end`, and on `TurnResult`
  - error codes `AGENT_SESSION_BACKEND_UNAVAILABLE | AGENT_SESSION_AUTH_REQUIRED | AGENT_SESSION_CAPABILITY_UNSUPPORTED | AGENT_SESSION_BACKEND_MISMATCH`
  - `TranscriptDoc.backend?: string`, `TranscriptDoc.acp?: TranscriptAcpRecord`

- [ ] **Step 1: Write the failing tests**

In `test/unit/session/agent-session-errors.test.ts` add:

```ts
test("the S4 codes construct AgentSessionErrors in the agent-session stage", () => {
  for (const code of [
    "AGENT_SESSION_BACKEND_UNAVAILABLE",
    "AGENT_SESSION_AUTH_REQUIRED",
    "AGENT_SESSION_CAPABILITY_UNSUPPORTED",
    "AGENT_SESSION_BACKEND_MISMATCH",
  ] as const) {
    const err = new AgentSessionError("x", code, { capability: "tools" });
    expect(err.code).toBe(code);
    expect(err.context).toMatchObject({ stage: "agent-session", capability: "tools" });
  }
});
```

In the `turnEndFromResult` unit test file add:

```ts
test("turnEndFromResult carries costSource when the backend set it, and omits it otherwise", () => {
  const base: TurnResult = { output: "ok", tokenUsage: { inputTokens: 1, outputTokens: 1 }, estimatedCostUsd: 0 } as TurnResult;
  expect(turnEndFromResult({ ...base, costSource: "unpriced" }).costSource).toBe("unpriced");
  expect("costSource" in turnEndFromResult(base)).toBe(false);
});
```

(If `TurnResult` has further required fields, build `base` the way the existing `turnEndFromResult` tests do.)

- [ ] **Step 2: Run them and see them fail**

Run: `bun test ./test/unit/session/agent-session-errors.test.ts --timeout=60000`
Expected: a TypeScript or runtime failure on the new codes (`bun x tsc --noEmit` reports the code is not assignable).

- [ ] **Step 3: Implement**

1. `agent-session-errors.ts`: append the four codes to `AgentSessionErrorCode`.
2. `agent-session-types.ts`:
   - `export type AgentSessionProfile = "none" | "read" | "ask" | "full";` (the doc comment adds: "`ask`: every mutating action is approved through `answer()`.")
   - `ApprovalDecidedBy` gains `| "profile"`.
   - Add `export type CostSource = "computed" | "reported" | "unpriced";`
   - The `usage` body gains `readonly costSource?: CostSource;`
   - The `turn_end` body gains `readonly costSource?: CostSource;`
3. `turn-event.ts`: the `usage` variant gains `readonly costSource?: import("./agent-session-types.ts").CostSource;` with the doc line "Absent means computed from the catalog (the native backend). `unpriced` rows carry `costUsd: 0` and must not be summed as a real cost."
4. `session-types.ts`, `TurnResult`: add `/** Absent means computed. */ costSource?: import("./agent-session-types.ts").CostSource;`
5. `agent-session-turn.ts`, `turnEndFromResult`: add `...(result.costSource !== undefined ? { costSource: result.costSource } : {})` to `base`.
6. `transcript-types.ts`:

```ts
/** An ACP backend's record of the agent-side session (S4 spec 5.5). */
export interface TranscriptAcpRecord {
  readonly agentSessionId: string;
  readonly agent: string;
  readonly agentVersion?: string;
  readonly cwd: string;
}
```

   `TranscriptDoc` gains:
   - `readonly backend?: string;` with the doc "Absent means "native"."
   - `readonly acp?: TranscriptAcpRecord;`
7. Create `session-backend.ts` exactly as in **Interfaces** above, with a header doc comment citing S4 spec §5.1.
8. `src/index.ts`: export the types `SessionBackend`, `BackendOpenContext`, `OpenedBackend`, `BackendInfo`, `TurnContribution`, `SessionAskPort`, `ApprovalRequest` from `#src/session/session-backend`; `CostSource` beside the existing `agent-session-types` exports; and `TranscriptAcpRecord` beside `TranscriptDoc`.

- [ ] **Step 4: Run the tests and gates**

Run:
- `bun test ./test/unit/session/ --timeout=60000`
- `bun run typecheck`
- `bun ../repo-tooling/scripts/check-complexity.ts --package=.`

Expected: PASS.

- [ ] **Step 5: API snapshot and commit**

Run `bun run check:api`. Expected diff: only the added type names and the widened unions. Then `bun run api:update`, `bun run lint:fix`, and:

```bash
git add packages/nax-agent && git commit -m "feat(nax-agent): S4 contract types: SessionBackend seam, ask profile, costSource, new error codes"
```

---

### Task 2: Backend kit exports and `StderrTail`

**Files:**
- Create: `src/infra/stderr-tail.ts`
- Modify: `src/index.ts`
- Test: `test/unit/infra/stderr-tail.test.ts`, `test/unit/public-backend-kit.test.ts`

**Interfaces:**
- Produces:

```ts
export interface StderrTail {
  push(chunk: string | Uint8Array): void;
  /** Control characters stripped, secrets redacted, the LAST `maxBytes` bytes (default 4096). */
  excerpt(opts?: { readonly maxBytes?: number; readonly secrets?: readonly string[] }): string;
}
export function createStderrTail(capacityBytes?: number): StderrTail; // default 65536
```

- Also produces, on `.`:
  - `redactSecrets`, `capStrings` (from `#src/internal/redact`);
  - `killProcessGroup` (`#src/internal/process-kill`), `isProcessAlive` (`#src/internal/process-alive`);
  - `TOOL_CALL_INPUT_BYTES`, `TOOL_RESULT_PREVIEW_BYTES` (`#src/native/session/turn-event-emitter`);
  - `createStderrTail`, type `StderrTail`.

  The spec's illustrative cap names (`TOOL_CALL_INPUT_CAP`) are replaced by the existing constant names; record this in the PR body.

- [ ] **Step 1: Write the failing tests**

`test/unit/infra/stderr-tail.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { createStderrTail } from "#src/infra/stderr-tail";

describe("createStderrTail", () => {
  test("keeps only the last capacity bytes", () => {
    const tail = createStderrTail(10);
    tail.push("0123456789");
    tail.push("abcde");
    expect(tail.excerpt({ maxBytes: 100 })).toBe("56789abcde");
  });

  test("accepts bytes and strips control characters but keeps newlines and tabs", () => {
    const tail = createStderrTail();
    tail.push(new TextEncoder().encode("a\u0007b\tc\nd\u001b[31m"));
    expect(tail.excerpt()).toBe("ab\tc\nd[31m");
  });

  test("redacts caller secrets and known token shapes", () => {
    const tail = createStderrTail();
    tail.push("token=hunter2-secret-value and ghp_0123456789abcdefghijklmnopqrstuvwxyzAB");
    const out = tail.excerpt({ secrets: ["hunter2-secret-value"] });
    expect(out).not.toContain("hunter2-secret-value");
    expect(out).not.toContain("ghp_0123456789abcdefghijklmnopqrstuvwxyzAB");
  });

  test("excerpt returns the last maxBytes bytes", () => {
    const tail = createStderrTail();
    tail.push("x".repeat(5000) + "END");
    const out = tail.excerpt({ maxBytes: 8 });
    expect(out.endsWith("END")).toBe(true);
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(8);
  });

  test("ignores secrets shorter than 4 characters so they do not shred the text", () => {
    const tail = createStderrTail();
    tail.push("a b c");
    expect(tail.excerpt({ secrets: ["a"] })).toBe("a b c");
  });
});
```

`test/unit/public-backend-kit.test.ts`:

```ts
import { expect, test } from "bun:test";
import * as pub from "@nathapp/nax-agent";

test("the backend kit is public on the package entry", () => {
  for (const name of [
    "redactSecrets",
    "capStrings",
    "killProcessGroup",
    "isProcessAlive",
    "createStderrTail",
    "TOOL_CALL_INPUT_BYTES",
    "TOOL_RESULT_PREVIEW_BYTES",
  ]) {
    expect(name in pub).toBe(true);
  }
  expect(pub.TOOL_CALL_INPUT_BYTES).toBe(8192);
  expect(pub.TOOL_RESULT_PREVIEW_BYTES).toBe(4096);
});
```

- [ ] **Step 2: Run and see them fail**

Run: `bun test ./test/unit/infra/stderr-tail.test.ts ./test/unit/public-backend-kit.test.ts --timeout=60000`
Expected: FAIL (module not found; names missing).

- [ ] **Step 3: Implement `src/infra/stderr-tail.ts`**

```ts
/**
 * A bounded tail of a child process's stderr (S4 spec 5.6, 7). Backends keep
 * the last bytes for error excerpts; excerpt() strips control characters,
 * redacts caller-known secrets and known token shapes, and returns at most
 * maxBytes from the end, so an error never carries a raw agent log.
 */
import { redactSecrets } from "#src/internal/redact";

const DEFAULT_CAPACITY = 65_536;
const DEFAULT_EXCERPT = 4096;
const MIN_SECRET_LENGTH = 4;
// C0 controls and DEL, except tab (\u0009) and newline (\u000A).
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F]/g;

export interface StderrTail {
  push(chunk: string | Uint8Array): void;
  excerpt(opts?: { readonly maxBytes?: number; readonly secrets?: readonly string[] }): string;
}

function lastBytes(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength <= maxBytes) return text;
  // A cut inside a multi-byte character decodes to U+FFFD; drop it.
  return bytes.subarray(bytes.byteLength - maxBytes).toString("utf8").replace(/^�+/, "");
}

function scrub(text: string, secrets: readonly string[]): string {
  let out = text.replace(CONTROL, "");
  for (const secret of secrets) {
    if (secret.length >= MIN_SECRET_LENGTH) out = out.split(secret).join("[REDACTED]");
  }
  return redactSecrets(out);
}

export function createStderrTail(capacityBytes: number = DEFAULT_CAPACITY): StderrTail {
  const decoder = new TextDecoder();
  let buffer = "";
  return {
    push(chunk) {
      buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
      buffer = lastBytes(buffer, capacityBytes);
    },
    excerpt(opts = {}) {
      return lastBytes(scrub(buffer, opts.secrets ?? []), opts.maxBytes ?? DEFAULT_EXCERPT);
    },
  };
}
```

`redactSecrets` is generic (`<T>(value: T) => T`) and string-in, string-out. If the typecheck disagrees, cast the result with `as string`, as `session-interaction.ts` does.

- [ ] **Step 4: Export on `.`**

In `src/index.ts`, insert in byte order:
- `export { capStrings, redactSecrets } from "#src/internal/redact";`
- `export { killProcessGroup } from "#src/internal/process-kill";`
- `export { isProcessAlive } from "#src/internal/process-alive";`
- `export { TOOL_CALL_INPUT_BYTES, TOOL_RESULT_PREVIEW_BYTES } from "#src/native/session/turn-event-emitter";`
- `export { createStderrTail, type StderrTail } from "#src/infra/stderr-tail";`

`./internal` keeps its `export *` lines unchanged.

- [ ] **Step 5: Run tests and gates**

Run:
- `bun test ./test/unit/infra/stderr-tail.test.ts ./test/unit/public-backend-kit.test.ts --timeout=60000`
- `bun run typecheck`
- `bun run check:all`

Expected: PASS.

- [ ] **Step 6: API snapshot and commit**

1. Run `bun run check:api`. Expected: only the seven added names (plus the type) in the `[.]` section.
2. Run `bun run api:update` and `bun run lint:fix`.
3. Commit:

```bash
git add packages/nax-agent && git commit -m "feat(nax-agent): public backend kit (redaction, caps, process-group kill, StderrTail)"
```

---

### Task 3: `SessionAskPort`

**Files:**
- Create: `src/session/session-ask-port.ts`
- Modify: `src/session/session-ask-link.ts`, `src/session/session-interaction.ts`, `src/session/agent-session.ts` (wiring only)
- Test: create `test/unit/session/session-ask-port.test.ts`; update `test/unit/session/session-ask-link.test.ts`, `test/unit/session/session-interaction.test.ts`

**Interfaces:**
- Consumes: `SessionAskPort`, `ApprovalRequest` (Task 1); `PendingAskTable` (`pending-asks.ts`); `askPerson`, `SessionAskDeps` (`session-ask-link.ts`).
- Produces:

```ts
export interface SessionAskPortDeps {
  readonly table: PendingAskTable;
  readonly emit: (body: SessionEventBody) => void;
  /** The running turn, or undefined between turns. */
  readonly turn: () => { readonly turnId: string; readonly signal: AbortSignal } | undefined;
}
export function createSessionAskPort(deps: SessionAskPortDeps): SessionAskPort;

// session-ask-link.ts (changed signature)
export function createSessionAskLink(deps: { readonly port: SessionAskPort; readonly currentCallId: () => string | undefined }): AskLink;

// session-interaction.ts: SessionInteractionDeps.asks becomes `SessionAskPort`
```

- [ ] **Step 1: Write the failing tests** (`test/unit/session/session-ask-port.test.ts`)

```ts
import { describe, expect, test } from "bun:test";
import type { SessionEventBody } from "@nathapp/nax-agent";
import { _agentSessionDeps } from "#src/session/agent-session-deps";
import { createPendingAskTable } from "#src/session/pending-asks";
import { createSessionAskPort } from "#src/session/session-ask-port";
import { assertNaxError, withDepsRestore } from "#test/helpers/index";

function setup(running = true) {
  const events: SessionEventBody[] = [];
  const table = createPendingAskTable(30_000);
  const controller = new AbortController();
  const port = createSessionAskPort({
    table,
    emit: (body) => events.push(body),
    turn: () => (running ? { turnId: "t1", signal: controller.signal } : undefined),
  });
  return { events, table, controller, port };
}

describe("createSessionAskPort", () => {
  withDepsRestore(_agentSessionDeps);

  test("requestApproval emits approval_requested and settles on answer()", async () => {
    const { events, table, port } = setup();
    const pending = port.requestApproval({ callId: "c1", tool: "Write", summary: "write a.txt", reason: "ask profile" });
    const requested = events.find((e) => e.type === "approval_requested");
    expect(requested).toMatchObject({ callId: "c1", tool: "Write", summary: "write a.txt" });
    table.answer((requested as { requestId: string }).requestId, { decision: "allow" });
    expect(await pending).toEqual({ decision: "allow", decidedBy: "human" });
    expect(events.at(-1)).toMatchObject({ type: "approval_resolved", decision: "allow", decidedBy: "human" });
  });

  test("an extra abort signal cancels the approval", async () => {
    const { port } = setup();
    const extra = new AbortController();
    const pending = port.requestApproval({ tool: "Bash", summary: "s", reason: "r", signal: extra.signal });
    extra.abort();
    expect(await pending).toEqual({ decision: "deny", decidedBy: "cancelled" });
  });

  test("requestApproval with no running turn throws at once", async () => {
    const { port } = setup(false);
    let caught: unknown;
    try {
      await port.requestApproval({ tool: "Write", summary: "s", reason: "r" });
    } catch (err) {
      caught = err;
    }
    assertNaxError(caught);
    expect(caught.code).toBe("AGENT_SESSION_TURN_FAILED");
    expect(caught.context).toMatchObject({ detail: "no-turn" });
  });

  test("recordAutoDecision emits a requested/resolved pair decided by profile", () => {
    const { events, port } = setup();
    port.recordAutoDecision({ callId: "c2", tool: "edit", summary: "edit x", reason: "profile read" }, "deny");
    expect(events.map((e) => e.type)).toEqual(["approval_requested", "approval_resolved"]);
    expect(events[1]).toMatchObject({ decision: "deny", decidedBy: "profile" });
    expect((events[0] as { requestId: string }).requestId).toBe((events[1] as { requestId: string }).requestId);
  });

  test("askQuestion resolves with the text, and null on cancel", async () => {
    const { events, table, controller, port } = setup();
    const first = port.askQuestion("Which env?");
    const q = events.find((e) => e.type === "question") as { requestId: string };
    table.answer(q.requestId, { text: "staging" });
    expect(await first).toBe("staging");
    const second = port.askQuestion("Again?");
    controller.abort();
    expect(await second).toBeNull();
  });

  test("noteQuestion emits a question whose answer is cancelled", () => {
    const { events, table, port } = setup();
    port.noteQuestion("declined: rich form");
    const q = events.find((e) => e.type === "question") as { requestId: string; text: string };
    expect(q.text).toBe("declined: rich form");
    expect(table.answer(q.requestId, { text: "x" })).toBe("cancelled");
  });

  test("recordAutoDecision, noteQuestion and askQuestion are inert with no running turn", async () => {
    const { events, port } = setup(false);
    port.recordAutoDecision({ tool: "t", summary: "s", reason: "r" }, "allow");
    port.noteQuestion("x");
    expect(await port.askQuestion("y")).toBeNull();
    expect(events).toEqual([]);
  });
});
```

- [ ] **Step 2: Run and see it fail**

Run: `bun test ./test/unit/session/session-ask-port.test.ts --timeout=60000`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/session/session-ask-port.ts`**

```ts
/**
 * The session's ask port (S4 spec 5.1): approvals and questions any backend
 * raises, on top of the pending-ask table. A request needs a running turn: its
 * events go on that turn's stream and its turn signal settles it. Profile
 * auto-decisions and informational questions are emitted, never queued.
 */
import { NaxError } from "#src/infra/nax-error";
import { _agentSessionDeps } from "./agent-session-deps.ts";
import type { SessionEventBody } from "./agent-session-types.ts";
import type { PendingAskTable } from "./pending-asks.ts";
import type { ApprovalRequest, SessionAskPort } from "./session-backend.ts";
import { askPerson } from "./session-ask-link.ts";

export interface SessionAskPortDeps {
  readonly table: PendingAskTable;
  readonly emit: (body: SessionEventBody) => void;
  readonly turn: () => { readonly turnId: string; readonly signal: AbortSignal } | undefined;
}

const ALREADY_ABORTED = AbortSignal.abort();

function noTurn(): NaxError {
  return new NaxError("No turn is running; an approval needs a running turn", "AGENT_SESSION_TURN_FAILED", {
    stage: "agent-session",
    detail: "no-turn",
  });
}

export function createSessionAskPort(deps: SessionAskPortDeps): SessionAskPort {
  const askDeps = { table: deps.table, emit: deps.emit, currentCallId: () => undefined };
  const now = (): string => new Date(_agentSessionDeps.now()).toISOString();
  return {
    async requestApproval(req: ApprovalRequest) {
      const turn = deps.turn();
      if (turn === undefined) throw noTurn();
      const signal = req.signal === undefined ? turn.signal : AbortSignal.any([turn.signal, req.signal]);
      const { signal: _ignored, ...ask } = req;
      return askPerson(askDeps, ask, signal);
    },
    recordAutoDecision(req, decision) {
      if (deps.turn() === undefined) return;
      const requestId = _agentSessionDeps.randomUUID();
      deps.emit({
        type: "approval_requested",
        requestId,
        ...(req.callId !== undefined ? { callId: req.callId } : {}),
        tool: req.tool,
        summary: req.summary,
        reason: req.reason,
        expiresAt: now(),
      });
      deps.emit({ type: "approval_resolved", requestId, decision, decidedBy: "profile" });
    },
    async askQuestion(text) {
      const turn = deps.turn();
      if (turn === undefined) return null;
      const { requestId, expiresAt, settled } = deps.table.issue("question", turn.signal);
      deps.emit({ type: "question", requestId, text, expiresAt });
      const settlement = await settled;
      return settlement.by === "human" && "text" in settlement.reply ? settlement.reply.text : null;
    },
    noteQuestion(text) {
      if (deps.turn() === undefined) return;
      const { requestId } = deps.table.issue("question", ALREADY_ABORTED);
      deps.emit({ type: "question", requestId, text, expiresAt: now() });
    },
  };
}
```

`ApprovalAsk` in `session-ask-link.ts` has the same fields as `ApprovalRequest` minus `signal`, so passing `ask` to `askPerson` typechecks. If biome flags `_ignored`, write the omission as an explicit field copy instead.

- [ ] **Step 4: Rewire the native ask link and interaction handler onto the port**

`session-ask-link.ts`: keep `askPerson` and `SessionAskDeps` exported unchanged. Replace `createSessionAskLink`:

```ts
export interface SessionAskLinkDeps {
  readonly port: SessionAskPort;
  /** The tool call being answered right now, if any. */
  readonly currentCallId: () => string | undefined;
}

export function createSessionAskLink(deps: SessionAskLinkDeps): AskLink {
  return {
    name: "agent-session",
    resolve(req, control) {
      if (req.unshowable === true) return Promise.resolve(UNSHOWABLE);
      const masked = req.command === undefined ? undefined : maskForPrompt(req.command);
      if (masked !== undefined && !masked.ok) return Promise.resolve(UNSHOWABLE);
      const callId = deps.currentCallId();
      return deps.port.requestApproval({
        tool: req.tool,
        summary: req.summary,
        ...(masked !== undefined ? { command: masked.masked } : {}),
        reason: req.reason ?? `matched ${req.rule}`,
        ...(callId !== undefined ? { callId } : {}),
        ...(control?.signal !== undefined ? { signal: control.signal } : {}),
      });
    },
  };
}
```

`session-interaction.ts`: `SessionInteractionDeps.asks` becomes `SessionAskPort` (import from `./session-backend.ts`).
- In `runEmbedderTool`, replace `await askPerson(deps.asks, ask, signal)` with `await deps.asks.requestApproval({ ...ask, signal })`.
- Replace `answerQuestion` with:

```ts
async function answerQuestion(deps: SessionInteractionDeps, text: string): Promise<AdapterInteractionResponse | null> {
  const answer = await deps.asks.askQuestion(text);
  return answer === null ? null : { answer };
}
```

  Remove the now-unused `askPerson` import.

`agent-session.ts`, `assemble` (wiring only; Task 5 moves it):
- build `const port = createSessionAskPort({ table, emit: (body) => slot.turn?.emit(body), turn: () => slot.turn });`
- pass `createSessionAskLink({ port, currentCallId: () => slot.callId })`
- pass `asks: port` to `createSessionInteractionHandler`

`LiveTurn` already has `turnId` and `signal`, so `turn: () => slot.turn` typechecks.

- [ ] **Step 5: Update the existing unit tests**

- `session-ask-link.test.ts`: build the link with `createSessionAskLink({ port: createSessionAskPort({ table, emit, turn: () => ({ turnId: "t", signal }) }), currentCallId })`. Assertions are unchanged.
- `session-interaction.test.ts`: where tests build `asks: { table, emit, currentCallId }`, build `asks: createSessionAskPort({ table, emit, turn: () => ({ turnId: "t", signal: <the test's turn signal> }) })` instead. Assertions are unchanged.

- [ ] **Step 6: Run the session suite and gates**

Run:
- `bun test ./test/unit/session/ --timeout=60000`
- `bun run typecheck`
- `bun ../repo-tooling/scripts/check-complexity.ts --package=.`

Expected: PASS, with every pre-existing session test green.

- [ ] **Step 7: Commit** (no `.` change in this task)

```bash
bun run lint:fix && git add packages/nax-agent && git commit -m "refactor(nax-agent): SessionAskPort over the pending-ask table; native ask link and handler use it"
```

---

### Task 4: `nativeBackend()`

**Files:**
- Create: `src/session/native-backend-options.ts`, `src/session/native-backend.ts`
- Modify: `src/index.ts`
- Test: create `test/unit/session/native-backend-options.test.ts`, `test/unit/session/native-backend.test.ts`

**Interfaces:**
- Consumes: Task 1 types; `createSessionAskPort` (Task 3); `createSessionAskLink`, `createSessionAskResolver`, `createSessionInteractionHandler`, `embedderToolDescriptor`, `buildSessionToolSupport`, `defaultProtectedPaths`, `resolveSessionLauncher` (existing).
- Produces:

```ts
// native-backend-options.ts
export interface NativeBackendOptions {
  readonly model: string;
  readonly credentials?: CredentialSource;
  readonly catalogOverrides?: NativeCatalogOverrides;
  readonly loopHandlers?: LoopHandlerSet;
  readonly hostPorts?: AgentSessionHostPorts;
  readonly bashApproval?: BashApprovalMode;
  readonly allowUnsandboxed?: boolean;
}
export interface ResolvedNativeOptions {
  readonly raw: NativeBackendOptions;
  readonly provider: string;
}
export function parseNativeBackendOptions(input: unknown): ResolvedNativeOptions; // shape only
export function nativeProfileRules(profile: AgentSessionProfile, raw: NativeBackendOptions):
  { readonly bashApproval: BashApprovalMode; readonly allowUnsandboxed: boolean };

// native-backend.ts
export const NATIVE_BACKEND_KIND = "native";
export function nativeBackend(options: NativeBackendOptions): SessionBackend;
```

- [ ] **Step 1: Write the failing options tests** (`test/unit/session/native-backend-options.test.ts`)

Move the native-option cases out of `test/unit/session/agent-session-options.test.ts` into this file, rewritten against the new functions. Read that file first and carry over every case that names `model`, `credentials`, `catalogOverrides`, `loopHandlers`, `hostPorts`, `bashApproval` or `allowUnsandboxed`. At minimum:

```ts
import { describe, expect, test } from "bun:test";
import { nativeProfileRules, parseNativeBackendOptions } from "#src/session/native-backend-options";
import { assertNaxError } from "#test/helpers/index";

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    assertNaxError(err);
    return err.code;
  }
  return undefined;
}

describe("parseNativeBackendOptions", () => {
  test("accepts a provider/model and derives the provider", () => {
    expect(parseNativeBackendOptions({ model: "openai/gpt-5.4-mini" }).provider).toBe("openai");
  });
  test("rejects a model without a provider", () => {
    expect(code(() => parseNativeBackendOptions({ model: "gpt" }))).toBe("AGENT_SESSION_INVALID_OPTIONS");
  });
  test("rejects unknown keys (strict)", () => {
    expect(code(() => parseNativeBackendOptions({ model: "openai/x", profile: "full" }))).toBe(
      "AGENT_SESSION_INVALID_OPTIONS",
    );
  });
  test("rejects hostPorts.runDeclaredCommand as deferred", () => {
    expect(code(() => parseNativeBackendOptions({ model: "openai/x", hostPorts: { runDeclaredCommand: () => 0 } }))).toBe(
      "AGENT_SESSION_INVALID_OPTIONS",
    );
  });
});

describe("nativeProfileRules", () => {
  const raw = { model: "openai/x" };
  test("full defaults to gated and sandboxed", () => {
    expect(nativeProfileRules("full", raw)).toEqual({ bashApproval: "gated", allowUnsandboxed: false });
  });
  test("bashApproval and allowUnsandboxed are refused for none and read", () => {
    for (const profile of ["none", "read"] as const) {
      expect(code(() => nativeProfileRules(profile, { ...raw, bashApproval: "gated" }))).toBe("AGENT_SESSION_INVALID_OPTIONS");
      expect(code(() => nativeProfileRules(profile, { ...raw, allowUnsandboxed: true }))).toBe("AGENT_SESSION_INVALID_OPTIONS");
    }
  });
  test("allowUnsandboxed requires gated", () => {
    expect(code(() => nativeProfileRules("full", { ...raw, bashApproval: "raw", allowUnsandboxed: true }))).toBe(
      "AGENT_SESSION_INVALID_OPTIONS",
    );
  });
});
```

(`ask` cases are added in Task 6.)

- [ ] **Step 2: Implement `native-backend-options.ts`**

Move from `agent-session-options.ts` into this file:
- the zod pieces for `model`, `credentials`, `catalogOverrides`, `loopHandlers`, `hostPorts`, `bashApproval` and `allowUnsandboxed`;
- the `runDeclaredCommand` pre-check;
- `providerOf`.

Use `z.strictObject` with exactly these keys. Errors use the same `invalid(...)` message prefix (`Invalid agent session options: `) and `AGENT_SESSION_INVALID_OPTIONS`, with `path` naming the key under `backend.` (for example `{ path: "backend.model" }`).

```ts
export function nativeProfileRules(
  profile: AgentSessionProfile,
  raw: NativeBackendOptions,
): { readonly bashApproval: BashApprovalMode; readonly allowUnsandboxed: boolean } {
  const tools = profile === "full" || profile === "ask";
  if (!tools && raw.bashApproval !== undefined) {
    throw invalid('bashApproval applies to profiles "ask" and "full" only', { path: "backend.bashApproval" });
  }
  if (!tools && raw.allowUnsandboxed !== undefined) {
    throw invalid('allowUnsandboxed applies to profiles "ask" and "full" only', { path: "backend.allowUnsandboxed" });
  }
  const bashApproval = raw.bashApproval ?? "gated";
  if (raw.allowUnsandboxed === true && bashApproval !== "gated") {
    throw invalid('allowUnsandboxed requires bashApproval "gated"', { path: "backend.allowUnsandboxed" });
  }
  return { bashApproval, allowUnsandboxed: raw.allowUnsandboxed === true };
}
```

(`ask` gets its own `bashApproval` rule in Task 6. Until Task 6 the facade schema does not accept `ask`, so this branch is unreachable through the facade.)

- [ ] **Step 3: Write the failing backend tests** (`test/unit/session/native-backend.test.ts`)

```ts
import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BackendOpenContext } from "@nathapp/nax-agent";
import { createMemoryTranscriptStore } from "#src/native/session/memory-transcript-store";
import { createPendingAskTable } from "#src/session/pending-asks";
import { NATIVE_BACKEND_KIND, nativeBackend } from "#src/session/native-backend";
import { createSessionAskPort } from "#src/session/session-ask-port";
import { MODEL } from "#test/helpers/agent-session";
import { assertNaxError } from "#test/helpers/index";

const IDLE = new AbortController().signal;

async function ctx(extra: Partial<BackendOpenContext> = {}): Promise<BackendOpenContext> {
  const workdir = await mkdtemp(join(tmpdir(), "nax-native-backend-"));
  const table = createPendingAskTable(30_000);
  return {
    sessionId: "s1",
    workdir,
    profile: "read",
    instructions: undefined,
    tools: [],
    transcriptStore: createMemoryTranscriptStore(),
    resume: undefined,
    asks: createSessionAskPort({ table, emit: () => {}, turn: () => undefined }),
    turnSignal: () => IDLE,
    currentTurnId: () => undefined,
    turnTimeoutSeconds: 60,
    metadata: {},
    openSignal: IDLE,
    ...extra,
  };
}

describe("nativeBackend", () => {
  test("has kind native and opens with the read tool set", async () => {
    const backend = nativeBackend({ model: MODEL });
    expect(backend.kind).toBe(NATIVE_BACKEND_KIND);
    const opened = await backend.open(await ctx());
    expect(opened.info).toEqual({ kind: "native", capabilities: {} });
    const names = (opened.turnOpts().codingTools ?? []).map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(["Read", "Glob", "Grep", "Git"]));
    expect(names).not.toContain("Write");
    await opened.adapter.closeSession(opened.handle);
    await opened.close();
    await opened.close(); // idempotent
  });

  test("validates its options at construction", () => {
    let caught: unknown;
    try {
      nativeBackend({ model: "no-provider" });
    } catch (err) {
      caught = err;
    }
    assertNaxError(caught);
    expect(caught.code).toBe("AGENT_SESSION_INVALID_OPTIONS");
  });

  test("a resume from a document written by another model is refused", async () => {
    const backend = nativeBackend({ model: MODEL });
    const doc = { savedAt: new Date(0).toISOString(), messages: [], model: "anthropic/other" };
    let caught: unknown;
    try {
      await backend.open(await ctx({ resume: { doc } }));
    } catch (err) {
      caught = err;
    }
    assertNaxError(caught);
    expect(caught.code).toBe("AGENT_SESSION_MODEL_MISMATCH");
  });

  test("embedder tools are advertised after the built-ins", async () => {
    const tool = {
      name: "lookup",
      description: "d",
      inputSchema: { type: "object" },
      approval: "never" as const,
      run: async () => ({ content: "x" }),
    };
    const opened = await nativeBackend({ model: MODEL }).open(await ctx({ profile: "none", tools: [tool] }));
    const names = (opened.turnOpts().codingTools ?? []).map((t) => t.name);
    expect(names.at(-1)).toBe("lookup");
    await opened.adapter.closeSession(opened.handle);
  });
});
```

- [ ] **Step 4: Implement `native-backend.ts`**

Move `createAdapter`, `SESSION_TRANSPORT_RETRY` and the native half of `assemble` from `agent-session.ts` here. `agent-session.ts` keeps its current `assemble` until Task 5, so for this task the two coexist. Task 5 deletes the facade copy.

```ts
/**
 * The native backend (S4 spec 5.2): the S3 facade's native half behind the
 * SessionBackend seam. Sandbox floor, profile tools, the interaction handler
 * with built-in and embedder tools, the NativeSessionAdapter, loop handlers
 * and the resume model check.
 */
import { DEFAULT_SPIN_BREAKER_SETTINGS } from "#src/infra/spin-breaker/index";
import { NATIVE_AGENT } from "#src/native/models";
import { transcriptModelIdentity } from "#src/native/session/transcript-identity";
import type { TranscriptDoc } from "#src/native/session/transcript-types";
import type { TurnRetryConfig } from "#src/native/session/turn-retry";
import { NativeSessionAdapter } from "#src/native/session-adapter";
import { AgentSessionError } from "./agent-session-errors.ts";
import {
  type NativeBackendOptions,
  nativeProfileRules,
  parseNativeBackendOptions,
  type ResolvedNativeOptions,
} from "./native-backend-options.ts";
import type { BackendOpenContext, OpenedBackend, SessionBackend } from "./session-backend.ts";
import { createSessionAskLink, createSessionAskResolver } from "./session-ask-link.ts";
import { createSessionInteractionHandler, embedderToolDescriptor } from "./session-interaction.ts";
import { buildSessionToolSupport, defaultProtectedPaths, resolveSessionLauncher } from "./session-tool-support.ts";

export const NATIVE_BACKEND_KIND = "native";

/** nax's agent.native.transportRetry default (S3 spec 5.3). */
const SESSION_TRANSPORT_RETRY: TurnRetryConfig = { maxAttempts: 3, baseDelayMs: 2000 };

function createAdapter(raw: NativeBackendOptions): NativeSessionAdapter {
  const overrides = raw.catalogOverrides ?? [];
  const owns = overrides.length > 0 || raw.credentials !== undefined;
  return new NativeSessionAdapter(overrides, {
    ...(raw.credentials !== undefined ? { credentials: raw.credentials } : {}),
    ...(owns ? { ownClient: true } : {}),
  });
}

function checkResumeModel(doc: TranscriptDoc, sessionId: string, model: string): void {
  const resuming = transcriptModelIdentity(model);
  if (doc.model !== undefined && doc.model !== resuming) {
    throw new AgentSessionError(
      `Session "${sessionId}" was written by model "${doc.model}"; resume it with that model, not "${resuming}"`,
      "AGENT_SESSION_MODEL_MISMATCH",
      { sessionId },
    );
  }
}

async function openNative(resolved: ResolvedNativeOptions, ctx: BackendOpenContext): Promise<OpenedBackend> {
  const raw = resolved.raw;
  if (ctx.resume !== undefined) checkResumeModel(ctx.resume.doc, ctx.sessionId, raw.model);
  const { bashApproval, allowUnsandboxed } = nativeProfileRules(ctx.profile, raw);
  const protectedPaths = { ...defaultProtectedPaths(raw.credentials !== undefined), ...raw.hostPorts?.protectedPaths };
  const launcher = await resolveSessionLauncher({
    profile: ctx.profile,
    root: ctx.workdir,
    protectedPaths,
    bashApproval,
    allowUnsandboxed,
  });
  let callId: string | undefined;
  const { support, grants } = buildSessionToolSupport({
    profile: ctx.profile,
    root: ctx.workdir,
    sessionName: ctx.sessionId,
    protectedPaths,
    bashApproval,
    launcher,
    askResolver: createSessionAskResolver(createSessionAskLink({ port: ctx.asks, currentCallId: () => callId })),
    interceptor: raw.hostPorts?.commandInterceptor,
  });
  const interactionHandler = createSessionInteractionHandler({
    sessionId: ctx.sessionId,
    runtime: support.runtime,
    embedderTools: new Map(ctx.tools.map((tool) => [tool.name, tool])),
    asks: ctx.asks,
    turnSignal: ctx.turnSignal,
    setCurrentCallId: (id) => {
      callId = id;
    },
  });
  const adapter = createAdapter(raw);
  const handle = await adapter.openSession(ctx.sessionId, {
    agentName: NATIVE_AGENT,
    workdir: ctx.workdir,
    resolvedPermissions: { mode: "default", toolGrants: grants, bashApproval },
    modelDef: { provider: resolved.provider, model: raw.model },
    timeoutSeconds: ctx.turnTimeoutSeconds,
    transcriptStore: ctx.transcriptStore,
    retainOnClose: true,
    resume: ctx.resume !== undefined,
    spinBreaker: DEFAULT_SPIN_BREAKER_SETTINGS,
    transportRetry: SESSION_TRANSPORT_RETRY,
    ...(ctx.instructions !== undefined && ctx.instructions !== "" ? { systemPrompt: ctx.instructions } : {}),
  });
  const codingTools = [...support.tools, ...ctx.tools.map(embedderToolDescriptor)];
  const loopHandlerContext = {
    sessionName: ctx.sessionId,
    workdir: ctx.workdir,
    model: raw.model,
    provider: resolved.provider,
  };
  return {
    adapter,
    handle,
    info: { kind: NATIVE_BACKEND_KIND, capabilities: {} },
    turnOpts: () => ({
      interactionHandler,
      codingTools,
      loopHandlerContext,
      ...(raw.loopHandlers !== undefined ? { loopHandlers: raw.loopHandlers } : {}),
    }),
    close: async () => {},
  };
}

export function nativeBackend(options: NativeBackendOptions): SessionBackend {
  const resolved = parseNativeBackendOptions(options);
  return { kind: NATIVE_BACKEND_KIND, open: (ctx) => openNative(resolved, ctx) };
}
```

- If `openNative` exceeds complexity 20, extract `toolSetup(...)` returning `{ support, grants, interactionHandler, setCallId }`.
- `parseNativeBackendOptions` must return the caller's object as `raw` (not zod's copy), as the facade does today.

- [ ] **Step 5: Export and run**

Export `nativeBackend` and the type `NativeBackendOptions` on `.` (byte order). Then run:
- `bun test ./test/unit/session/native-backend-options.test.ts ./test/unit/session/native-backend.test.ts --timeout=60000`
- `bun run typecheck`
- `bun ../repo-tooling/scripts/check-complexity.ts --package=.`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
bun run check:api; bun run api:update; bun run lint:fix
git add packages/nax-agent && git commit -m "feat(nax-agent): nativeBackend() behind the SessionBackend seam"
```

---

### Task 5: Facade on the seam (the 0.3.0 options break)

**Files:**
- Modify: `src/session/agent-session-options.ts`, `src/session/agent-session-types.ts`, `src/session/agent-session-resume.ts`, `src/session/agent-session-turn.ts`, `src/session/agent-session.ts`
- Modify tests and fixtures: `test/helpers/agent-session.ts`, `test/unit/session/agent-session-options.test.ts`, `test/unit/session/agent-session-resume.test.ts`, `test/node/fixtures/packed-smoke.mjs`, `test/node/fixtures/live-chat-smoke.mjs`, and any test that builds `CreateAgentSessionOptions` without the helper (run `grep -rn "backend: \"native\"" test/` and fix each hit)
- Test: create `test/unit/session/agent-session-backend.test.ts`

**Interfaces:**
- Consumes: Tasks 1-4.
- Produces:

```ts
export interface CreateAgentSessionOptions {
  readonly backend: SessionBackend;
  readonly sessionId?: string;
  readonly profile: AgentSessionProfile;
  readonly workdir?: string;
  readonly instructions?: string;
  readonly tools?: readonly EmbedderTool[];
  readonly transcriptStore: TranscriptStore;
  readonly approvalTimeoutMs?: number;
  readonly turnTimeoutSeconds?: number;
  readonly metadata?: Readonly<Record<string, string>>;
}
// AgentSession gains:
readonly backend: BackendInfo;
// agent-session-resume.ts
export function loadResumable(store: TranscriptStore, sessionId: string): Promise<TranscriptDoc>; // model param removed
export function checkBackendKind(doc: TranscriptDoc, sessionId: string, kind: string): void;
// agent-session-turn.ts
export interface TurnRunContext {
  readonly sessionId: string;
  readonly adapter: AgentSessionAdapter;
  readonly handle: SessionHandle;
  readonly store: TranscriptStore;
  readonly turnOpts: () => TurnContribution;
  readonly turnTimeoutSeconds: number;
  readonly metadata: Readonly<Record<string, string>>;
}
// test/helpers/agent-session.ts
export type SessionTestOptions = Partial<Omit<CreateAgentSessionOptions, "backend">> &
  Partial<NativeBackendOptions> & { readonly backend?: SessionBackend };
export function sessionOptions(extra?: SessionTestOptions): CreateAgentSessionOptions;
```

- [ ] **Step 1: Write the failing facade tests** (`test/unit/session/agent-session-backend.test.ts`)

These use a stub backend over a stub adapter, so they run without a provider.

```ts
import { afterEach, describe, expect, test } from "bun:test";
import {
  type BackendOpenContext,
  createAgentSession,
  nativeBackend,
  type OpenedBackend,
  resumeAgentSession,
  type SessionBackend,
} from "@nathapp/nax-agent";
import { createMemoryTranscriptStore } from "#src/native/session/memory-transcript-store";
import { collect, MODEL, resetScriptedProvider, turnEndOf } from "#test/helpers/agent-session";
import { assertNaxError } from "#test/helpers/index";

afterEach(resetScriptedProvider);

interface StubState {
  opened: BackendOpenContext[];
  closes: number;
  adapterCloseThrows: boolean;
}

function stubBackend(kind: string, state: StubState): SessionBackend {
  return {
    kind,
    async open(ctx) {
      state.opened.push(ctx);
      const opened: OpenedBackend = {
        adapter: {
          openSession: async () => ({ id: "h" }) as never,
          sendTurn: async () =>
            ({ output: "pong", tokenUsage: { inputTokens: 1, outputTokens: 1 }, estimatedCostUsd: 0, costSource: "unpriced" }) as never,
          closeSession: async () => {
            if (state.adapterCloseThrows) throw new Error("adapter close failed");
          },
        } as never,
        handle: { id: "h" } as never,
        info: { kind, capabilities: { resume: true } },
        turnOpts: () => ({ interactionHandler: { onInteraction: async () => null } }),
        close: async () => {
          state.closes += 1;
        },
      };
      return opened;
    },
  };
}

function fresh(): StubState {
  return { opened: [], closes: 0, adapterCloseThrows: false };
}

async function rejectsWith(promise: Promise<unknown>, code: string): Promise<unknown> {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  assertNaxError(caught);
  expect(caught.code).toBe(code);
  return caught;
}

describe("agent session: backend seam", () => {
  test("a stub backend drives a turn; backend info is public; turn_end carries costSource", async () => {
    const state = fresh();
    const session = await createAgentSession({
      backend: stubBackend("acp:fake", state),
      profile: "none",
      transcriptStore: createMemoryTranscriptStore(),
    });
    expect(session.backend).toEqual({ kind: "acp:fake", capabilities: { resume: true } });
    const end = turnEndOf(await collect(session.send("ping")));
    expect(end).toMatchObject({ status: "completed", output: "pong", costSource: "unpriced" });
    expect(state.opened[0]?.workdir).toBeString();
    await session.close();
  });

  test("close aborts openSignal and closes the backend once, even when the adapter close throws", async () => {
    const state = fresh();
    state.adapterCloseThrows = true;
    const session = await createAgentSession({
      backend: stubBackend("acp:fake", state),
      profile: "none",
      transcriptStore: createMemoryTranscriptStore(),
    });
    await session.close().catch(() => undefined);
    await session.close().catch(() => undefined);
    expect(state.opened[0]?.openSignal.aborted).toBe(true);
    expect(state.closes).toBe(1);
  });

  test("a native-only option at the top level is refused by name", async () => {
    await rejectsWith(
      createAgentSession({
        backend: nativeBackend({ model: MODEL }),
        profile: "none",
        transcriptStore: createMemoryTranscriptStore(),
        model: MODEL,
      } as never),
      "AGENT_SESSION_INVALID_OPTIONS",
    );
  });

  test("backend must be a SessionBackend", async () => {
    await rejectsWith(
      createAgentSession({ backend: "native", profile: "none", transcriptStore: createMemoryTranscriptStore() } as never),
      "AGENT_SESSION_INVALID_OPTIONS",
    );
  });

  test("a 0.2.0 document (no backend) resumes with the native backend kind only", async () => {
    const store = createMemoryTranscriptStore();
    await store.save("old", { savedAt: new Date(0).toISOString(), messages: [] });
    const err = await rejectsWith(
      resumeAgentSession("old", { backend: stubBackend("acp:fake", fresh()), profile: "none", transcriptStore: store }),
      "AGENT_SESSION_BACKEND_MISMATCH",
    );
    expect(err).toBeDefined();
    const state = fresh();
    const session = await resumeAgentSession("old", {
      backend: stubBackend("native", state),
      profile: "none",
      transcriptStore: store,
    });
    expect(state.opened[0]?.resume?.doc.messages).toEqual([]);
    await session.close();
  });

  test("a document written by one backend kind is refused by another before open", async () => {
    const store = createMemoryTranscriptStore();
    await store.save("s", { savedAt: new Date(0).toISOString(), messages: [], backend: "acp:claude" });
    const state = fresh();
    await rejectsWith(
      resumeAgentSession("s", { backend: stubBackend("native", state), profile: "none", transcriptStore: store }),
      "AGENT_SESSION_BACKEND_MISMATCH",
    );
    expect(state.opened).toEqual([]);
  });
});
```

The `as never` casts on stub adapters are test-only and allowed by `check-test-as-unknown-as`, because it forbids `as unknown as` and not `as never`. If that gate objects, build the stubs with the real types instead.

- [ ] **Step 2: Run and see them fail**

Run: `bun test ./test/unit/session/agent-session-backend.test.ts --timeout=60000`
Expected: FAIL (the `backend` shape is rejected and `session.backend` is undefined).

- [ ] **Step 3: Implement the shared options**

`agent-session-options.ts`:
- The schema keeps `sessionId`, `profile` (still `z.enum(["none", "read", "full"])`; `ask` arrives in Task 6), `workdir`, `instructions`, `tools`, `transcriptStore`, `approvalTimeoutMs`, `metadata` and `turnTimeoutSeconds`, plus:

```ts
backend: z.custom<SessionBackend>(
  (value) => isRecord(value) && typeof value.kind === "string" && typeof value.open === "function",
  "must be a SessionBackend (for example nativeBackend({ model }))",
),
```

  Because the schema stays `z.strictObject`, a native key at the top level fails with the unrecognized key as its path.
- Keep the `mcpServers` pre-check.
- Move the `hostPorts.runDeclaredCommand` pre-check to `native-backend-options.ts` if Task 4 has not already.
- `checkProfileRules` keeps only the workdir rule.
- `ResolvedAgentSessionOptions` drops `provider`, `bashApproval` and `allowUnsandboxed`.
- `checkToolNames` stays.

`agent-session-types.ts`: replace `CreateAgentSessionOptions` with the **Interfaces** shape, and add `readonly backend: BackendInfo;` to `AgentSession`. Native-only fields now live on `NativeBackendOptions` (Task 4); remove them and their imports here.

- [ ] **Step 4: Implement resume and turn changes**

`agent-session-resume.ts`:
- `loadResumable(store, sessionId)` keeps the presence, schema and messages-array checks, and loses the model parameter and check (now in `nativeBackend`).
- Remove the `transcriptModelIdentity` import.
- Add:

```ts
/** The stored document's backend (absent means native) must be the resuming backend's (S4 spec 5.5). */
export function checkBackendKind(doc: TranscriptDoc, sessionId: string, kind: string): void {
  const stored = doc.backend ?? "native";
  if (stored !== kind) {
    throw new AgentSessionError(
      `Session "${sessionId}" was written by backend "${stored}"; it cannot be resumed with "${kind}"`,
      "AGENT_SESSION_BACKEND_MISMATCH",
      { sessionId, stored, kind },
    );
  }
}
```

`agent-session-turn.ts`: `TurnRunContext` becomes the **Interfaces** shape. `sendTurn` becomes:

```ts
function sendTurn(ctx: TurnRunContext, live: LiveTurn, message: string): Promise<TurnResult> {
  return ctx.adapter.sendTurn(ctx.handle, message, {
    ...ctx.turnOpts(),
    maxInteractions: ASK_HUMAN_BUDGET,
    turnId: live.turnId,
    signal: live.signal,
    onTurnEvent: (event) => live.emit(event),
  });
}
```

- [ ] **Step 5: Implement the facade** (`agent-session.ts`)

- Delete the facade's `createAdapter`, `SESSION_TRANSPORT_RETRY` and its native `assemble` body. The removed imports are `DEFAULT_SPIN_BREAKER_SETTINGS`, `NATIVE_AGENT`, `NativeSessionAdapter`, the session-tool-support helpers, `createSessionAskLink`/`createSessionAskResolver`, `createSessionInteractionHandler` and `embedderToolDescriptor`.
- `SessionParts` gains `readonly opened: OpenedBackend` and `readonly closeController: AbortController`.
- `Opening` becomes `{ readonly doc: TranscriptDoc | undefined; readonly lastTurn: LastTurn | undefined }`.

New `assemble`:

```ts
async function assemble(
  options: ResolvedAgentSessionOptions,
  sessionId: string,
  root: SessionRoot,
  opening: Opening,
): Promise<NativeAgentSession> {
  const raw = options.raw;
  const table = createPendingAskTable(options.approvalTimeoutMs);
  const slot: LiveSlot = { turn: undefined };
  const closeController = new AbortController();
  const asks = createSessionAskPort({ table, emit: (body) => slot.turn?.emit(body), turn: () => slot.turn });
  const opened = await raw.backend.open({
    sessionId,
    workdir: root.dir,
    profile: raw.profile,
    instructions: raw.instructions,
    tools: options.tools,
    transcriptStore: raw.transcriptStore,
    resume: opening.doc === undefined ? undefined : { doc: opening.doc },
    asks,
    turnSignal: () => slot.turn?.signal ?? IDLE_SIGNAL,
    currentTurnId: () => slot.turn?.turnId,
    turnTimeoutSeconds: options.turnTimeoutSeconds,
    metadata: options.metadata,
    openSignal: closeController.signal,
  });
  const ctx: TurnRunContext = {
    sessionId,
    adapter: opened.adapter,
    handle: opened.handle,
    store: raw.transcriptStore,
    turnOpts: () => opened.turnOpts(),
    turnTimeoutSeconds: options.turnTimeoutSeconds,
    metadata: options.metadata,
  };
  return new NativeAgentSession({ ctx, table, slot, opened, closeController, cleanup: root.cleanup }, opening.lastTurn);
}
```

`LiveSlot` loses `callId`; the native backend owns its own call-id slot (Task 4).

Rename `NativeAgentSession` to `FacadeAgentSession`. Add `get backend(): BackendInfo { return this.parts.opened.info; }`. `shutdown` becomes:

```ts
private async shutdown(): Promise<void> {
  const active = this.active;
  this.parts.closeController.abort();
  this.parts.table.close();
  active?.cancel("session closed");
  await active?.settled;
  try {
    await this.parts.ctx.adapter.closeSession(this.parts.ctx.handle);
  } finally {
    try {
      await this.parts.opened.close();
    } finally {
      await this.parts.cleanup();
    }
  }
}
```

`open` still removes the root when `backend.open` throws.

`createAgentSession` calls `open(options, sessionId, { doc: undefined, lastTurn: undefined })`.

`resumeAgentSession`:

```ts
const doc = await loadResumable(store, sessionId);
checkBackendKind(doc, sessionId, options.raw.backend.kind);
const interrupted = interruptedTurnOf(doc);
const session = await open(options, sessionId, {
  doc,
  lastTurn: interrupted === undefined ? undefined : { turnId: interrupted, status: "interrupted" },
});
```

Update the file header comment: the facade drives any `SessionBackend`, and the native backend lives in `native-backend.ts`.

- [ ] **Step 6: Update the test helper, existing tests and fixtures**

`test/helpers/agent-session.ts`:

```ts
const NATIVE_KEYS = [
  "model",
  "credentials",
  "catalogOverrides",
  "loopHandlers",
  "hostPorts",
  "bashApproval",
  "allowUnsandboxed",
] as const;

export type SessionTestOptions = Partial<Omit<CreateAgentSessionOptions, "backend">> &
  Partial<NativeBackendOptions> & { readonly backend?: SessionBackend };

/** Shared options, with native-only keys routed into nativeBackend() (S4: the 0.3.0 options shape). */
export function sessionOptions(extra: SessionTestOptions = {}): CreateAgentSessionOptions {
  const native: Record<string, unknown> = { model: MODEL };
  const shared: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(extra)) {
    if (key === "backend") continue;
    if ((NATIVE_KEYS as readonly string[]).includes(key)) native[key] = value;
    else shared[key] = value;
  }
  return {
    backend: extra.backend ?? nativeBackend(native as unknown as NativeBackendOptions),
    profile: "none",
    transcriptStore: createMemoryTranscriptStore(),
    ...shared,
  } as CreateAgentSessionOptions;
}
```

- The single `as unknown as` cast is in a helper, not a test. If `check-test-as-unknown-as` scans helpers too, build `native` typed as `NativeBackendOptions` with an explicit spread per key instead.
- Existing test bodies that call `sessionOptions({ profile: "full", workdir, allowUnsandboxed: true })` stay unchanged.

`test/unit/session/agent-session-options.test.ts`: keep the shared-option cases (sessionId, profile, workdir, tools and names, transcriptStore, approvalTimeoutMs, metadata, turnTimeoutSeconds, mcpServers). The native-option cases moved to Task 4's file. Cases that expected a native-option rejection from `createAgentSession` now pass the option through `nativeBackend(...)`:
- a shape error throws synchronously from `nativeBackend`;
- a profile-rule error rejects from `createAgentSession` (raised in `open`).

`test/unit/session/agent-session-resume.test.ts`: model-mismatch cases still pass through the helper, because `nativeBackend` performs the check at open. Update any direct `loadResumable(store, id, model)` call to the two-argument form, and move the model-mismatch assertion to a facade-level resume (the code stays `AGENT_SESSION_MODEL_MISMATCH`).

`test/node/fixtures/packed-smoke.mjs` and `live-chat-smoke.mjs`: replace `backend: "native", model: X` with `backend: nativeBackend({ model: X, ...nativeOnlyFields })`, importing `nativeBackend` from `@nathapp/nax-agent`. Fix any other `grep -rn "backend: \"native\"" test/` hit the same way.

- [ ] **Step 7: Run everything**

Run:
- `bun run test`
- `bun run test:node`
- `bun run typecheck`
- `bun run check:all`
- `bun ../repo-tooling/scripts/check-complexity.ts --package=.`

Expected: all PASS. Every S3 session test passes with unchanged assertions; only the option construction changed.

- [ ] **Step 8: API snapshot and commit**

1. Run `bun run check:api`. Expected:
   - `CreateAgentSessionOptions` changes;
   - `AgentSession.backend` is added;
   - no other `[.]` changes beyond Tasks 1-4.
2. Run `bun run api:update` and `bun run lint:fix`.
3. Commit:

```bash
git add packages/nax-agent && git commit -m "feat(nax-agent)!: createAgentSession takes a SessionBackend; native options move to nativeBackend()"
```

---

### Task 6: The `ask` profile on the native backend

**Files:**
- Modify: `src/session/session-tool-support.ts`, `src/session/native-backend-options.ts`, `src/session/agent-session-options.ts` (profile enum)
- Test: `test/unit/session/session-tool-support.test.ts`, `test/unit/session/native-backend-options.test.ts`, create `test/unit/session/agent-session-ask-profile.test.ts`

**Interfaces:**
- Consumes: Tasks 4-5.
- Produces:
  - `askRulesFor(declared, bashApproval, profile)`: the third parameter is new;
  - `resolveSessionLauncher`'s floor applies to `ask` and `full`;
  - `nativeProfileRules("ask", …)` forces `gated`.

- [ ] **Step 1: Write the failing unit tests**

`session-tool-support.test.ts`:

```ts
test("ask declares the full tool set and asks for every mutating tool", () => {
  const policy = { gitExcludePathspecs: [], gitIgnorePatterns: [".nax/"] };
  const declared = declaredToolsFor("ask", policy);
  expect(declared).toEqual(declaredToolsFor("full", policy));
  const asked = askRulesFor(declared, "gated", "ask").map((rule) => rule.tool).sort();
  expect(asked).toEqual(["Bash", "Delete", "Edit", "GitCommit", "Write"]);
  expect(askRulesFor(declared, "gated", "ask").every((rule) => rule.patterns.join() === "*")).toBe(true);
});

test("full keeps the 0.2.0 ask rules (Bash under gated only)", () => {
  const declared = declaredToolsFor("full", { gitExcludePathspecs: [], gitIgnorePatterns: [] });
  expect(askRulesFor(declared, "gated", "full").map((rule) => rule.tool)).toEqual(["Bash"]);
  expect(askRulesFor(declared, "raw", "full")).toEqual([]);
});
```

`native-backend-options.test.ts`:

```ts
test("ask forces gated: raw and escalate are refused, the default is gated", () => {
  expect(nativeProfileRules("ask", { model: "openai/x" })).toEqual({ bashApproval: "gated", allowUnsandboxed: false });
  for (const mode of ["raw", "escalate"] as const) {
    expect(code(() => nativeProfileRules("ask", { model: "openai/x", bashApproval: mode }))).toBe(
      "AGENT_SESSION_INVALID_OPTIONS",
    );
  }
});
```

- [ ] **Step 2: Write the failing facade tests** (`test/unit/session/agent-session-ask-profile.test.ts`)

Copy the Bash test's setup from `test/unit/session/agent-session-asks.test.ts:138-160`: `installManualTimers()`, `stubSessionSandboxDeps(_sessionSandboxDeps)`, a probe returning unavailable, and `allowUnsandboxed: true`.

```ts
describe("agent session: the ask profile", () => {
  withDepsRestore(_agentSessionDeps);

  async function askSession(workdir: string) {
    return createAgentSession(sessionOptions({ profile: "ask", workdir, allowUnsandboxed: true }));
  }

  test("a Write is put to the person and lands on disk only after allow", async () => {
    installManualTimers();
    stubSessionSandboxDeps(_sessionSandboxDeps);
    _sessionSandboxDeps.probe = async () => ({ available: false, reason: "no sandbox in unit tests" });
    const provider = installScriptedProvider();
    provider.push(toolRound([{ id: "w1", name: "Write", input: { path: "a.txt", content: "hi" } }]), textRound("done"));
    const workdir = await mkdtemp(join(tmpdir(), "nax-agent-ask-"));
    const session = await askSession(workdir);
    const events = reader(session.send("write a.txt"));
    const [request] = eventsOf(await events.until("approval_requested"), "approval_requested");
    expect(request).toMatchObject({ callId: "w1", tool: "Write" });
    expect(existsSync(join(workdir, "a.txt"))).toBe(false);
    session.answer(request?.requestId ?? "", { decision: "allow" });
    const rest = await events.rest();
    expect(turnEndOf(rest).status).toBe("completed");
    expect(readFileSync(join(workdir, "a.txt"), "utf8")).toBe("hi");
    await session.close();
  });

  function noSandbox(): void {
    installManualTimers();
    stubSessionSandboxDeps(_sessionSandboxDeps);
    _sessionSandboxDeps.probe = async () => ({ available: false, reason: "no sandbox in unit tests" });
  }

  test("a denied Edit does not change the file", async () => {
    noSandbox();
    const workdir = await mkdtemp(join(tmpdir(), "nax-agent-ask-"));
    writeFileSync(join(workdir, "b.txt"), "old");
    const provider = installScriptedProvider();
    provider.push(
      toolRound([{ id: "e1", name: "Edit", input: { path: "b.txt", old_string: "old", new_string: "new" } }]),
      textRound("done"),
    );
    const session = await askSession(workdir);
    const events = reader(session.send("edit b.txt"));
    const [request] = eventsOf(await events.until("approval_requested"), "approval_requested");
    expect(request).toMatchObject({ callId: "e1", tool: "Edit" });
    session.answer(request?.requestId ?? "", { decision: "deny" });
    const rest = await events.rest();
    expect(eventsOf(rest, "tool_result")[0]?.preview).toContain("Denied");
    expect(readFileSync(join(workdir, "b.txt"), "utf8")).toBe("old");
    await session.close();
  });

  test("a Delete asks and a denied Delete keeps the file", async () => {
    noSandbox();
    const workdir = await mkdtemp(join(tmpdir(), "nax-agent-ask-"));
    writeFileSync(join(workdir, "c.txt"), "keep");
    const provider = installScriptedProvider();
    provider.push(toolRound([{ id: "d1", name: "Delete", input: { path: "c.txt" } }]), textRound("done"));
    const session = await askSession(workdir);
    const events = reader(session.send("delete c.txt"));
    const [request] = eventsOf(await events.until("approval_requested"), "approval_requested");
    expect(request).toMatchObject({ callId: "d1", tool: "Delete" });
    session.answer(request?.requestId ?? "", { decision: "deny" });
    await events.rest();
    expect(existsSync(join(workdir, "c.txt"))).toBe(true);
    await session.close();
  });

  test("a Bash command asks before any tool result", async () => {
    noSandbox();
    const workdir = await mkdtemp(join(tmpdir(), "nax-agent-ask-"));
    const provider = installScriptedProvider();
    provider.push(toolRound([{ id: "b1", name: "Bash", input: { command: "echo hi" } }]), textRound("done"));
    const session = await askSession(workdir);
    const events = reader(session.send("say hi"));
    const seen = await events.until("approval_requested");
    expect(eventsOf(seen, "tool_result")).toEqual([]);
    const [request] = eventsOf(seen, "approval_requested");
    expect(request).toMatchObject({ callId: "b1", tool: "Bash" });
    session.answer(request?.requestId ?? "", { decision: "deny" });
    expect(turnEndOf(await events.rest()).status).toBe("completed");
    await session.close();
  });

  test("full does not ask for a Write", async () => {
    noSandbox();
    const workdir = await mkdtemp(join(tmpdir(), "nax-agent-ask-"));
    const provider = installScriptedProvider();
    provider.push(toolRound([{ id: "w2", name: "Write", input: { path: "f.txt", content: "x" } }]), textRound("done"));
    const session = await createAgentSession(sessionOptions({ profile: "full", workdir, allowUnsandboxed: true }));
    const all = await collect(session.send("write f.txt"));
    expect(eventsOf(all, "approval_requested")).toEqual([]);
    expect(readFileSync(join(workdir, "f.txt"), "utf8")).toBe("x");
    await session.close();
  });
});
```

Imports for this file:
- `bun:test` (`describe`, `expect`, `test`)
- `node:fs` (`existsSync`, `readFileSync`, `writeFileSync`)
- `node:fs/promises` (`mkdtemp`), `node:os` (`tmpdir`), `node:path` (`join`)
- `createAgentSession` from `@nathapp/nax-agent`
- `_agentSessionDeps` from `#src/session/agent-session-deps`
- from `#test/helpers/agent-session`: `collect`, `eventsOf`, `installManualTimers`, `installScriptedProvider`, `reader`, `sessionOptions`, `textRound`, `toolRound`, `turnEndOf`
- `withDepsRestore` from `#test/helpers/index`
- `stubSessionSandboxDeps` and `_sessionSandboxDeps` from the same modules `agent-session-asks.test.ts` imports them from (copy its import lines)

The first test (Write) can call `noSandbox()` in place of its three setup lines. GitCommit's ask is covered by the `askRulesFor` unit test; an end-to-end GitCommit needs a git repo fixture and is left to the whole-branch review's judgment.

- [ ] **Step 3: Run and see them fail**

Run: `bun test ./test/unit/session/session-tool-support.test.ts ./test/unit/session/native-backend-options.test.ts ./test/unit/session/agent-session-ask-profile.test.ts --timeout=60000`
Expected: FAIL (profile "ask" is refused by the facade; `askRulesFor` has two parameters).

- [ ] **Step 4: Implement**

`session-tool-support.ts`:

```ts
const ASK_PROFILE_TOOLS: readonly CodingToolName[] = ["Write", "Edit", "Delete", "GitCommit"];

export function declaredToolsFor(profile: AgentSessionProfile, protectedPaths: ProtectedPathsPolicy): readonly CodingToolName[] {
  if (profile === "none") return [...UNIVERSAL_CODING_TOOLS];
  if (profile === "read") return [...UNIVERSAL_CODING_TOOLS, ...READ_TOOLS];
  // "ask" and "full" declare the same tools; "ask" differs only in its ask rules.
  const commit: readonly CodingToolName[] = protectedPaths.gitIgnorePatterns.length > 0 ? ["GitCommit"] : [];
  return [...UNIVERSAL_CODING_TOOLS, ...READ_TOOLS, ...WRITE_TOOLS, ...commit];
}

/**
 * Ask rules evaluate after grants. Under "gated" every Bash command is put to
 * the person. Under the "ask" profile every mutating path tool is too, and the
 * profile forces "gated", so Bash always asks there.
 */
export function askRulesFor(
  declared: readonly CodingToolName[],
  bashApproval: BashApprovalMode,
  profile: AgentSessionProfile,
): readonly ToolGrant[] {
  const bash = bashApproval === "gated" && declared.includes("Bash") ? ["Bash" as const] : [];
  const mutating = profile === "ask" ? ASK_PROFILE_TOOLS.filter((tool) => declared.includes(tool)) : [];
  return [...mutating, ...bash].map((tool) => ({ tool, patterns: ["*"] }));
}
```

- Update `buildSessionToolSupport` to pass `args.profile`.
- `resolveSessionLauncher`: `if (args.profile !== "full" && args.profile !== "ask") return undefined;`, and the error message says `Profile "${args.profile}" needs a usable sandbox …`.
- `native-backend-options.ts`, `nativeProfileRules`: after computing `bashApproval`, add:

```ts
if (profile === "ask" && bashApproval !== "gated") {
  throw invalid('profile "ask" requires bashApproval "gated" (other modes run Bash without asking)', {
    path: "backend.bashApproval",
  });
}
```

- `agent-session-options.ts`: `profile: z.enum(["none", "read", "ask", "full"])`.

If a Write, Edit, Delete or GitCommit test shows no `approval_requested`, do not touch the policy engine. STOP and report the failing tool to the controller (Global Constraints).

- [ ] **Step 5: Run everything**

Run:
- `bun run test`
- `bun run test:node`
- `bun run typecheck`
- `bun run check:all`
- `bun ../repo-tooling/scripts/check-complexity.ts --package=.`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
bun run check:api; bun run api:update; bun run lint:fix
git add packages/nax-agent && git commit -m "feat(nax-agent): the ask profile: every mutating tool asks; Bash forced gated; sandbox floor applies"
```

---

### Task 7: README, CHANGELOG and the Node contract for `ask`

**Files:**
- Modify: `packages/nax-agent/README.md` ("Conversational sessions" and "Status and roadmap"), `packages/nax-agent/CHANGELOG.md`, `test/node/agent-session.test.ts`

- [ ] **Step 1: Node contract case**

In `test/node/agent-session.test.ts`, add one case mirroring Task 6's first test (a Write under `ask`, allowed, lands on disk), using the vitest imports and helpers already used in that file. Run: `bun run test:node`. Expected: PASS.

- [ ] **Step 2: README**

In "Conversational sessions":
- Replace the options example with:

```ts
import { createAgentSession, createFileTranscriptStore, nativeBackend } from "@nathapp/nax-agent";

const session = await createAgentSession({
  backend: nativeBackend({ model: "anthropic/claude-sonnet-5-5" }),
  profile: "ask",
  workdir: "/abs/project",
  transcriptStore: createFileTranscriptStore("/abs/state/sessions"),
});
```

- Add a profile table:
  - `none`: no side effects;
  - `read`: read-only;
  - `ask`: every Write, Edit, Delete, GitCommit and Bash is put to `answer()`;
  - `full`: no prompts; `bashApproval` and the sandbox floor apply.
- Add a "Backends" paragraph: `createAgentSession` takes a `SessionBackend`. `nativeBackend(opts)` takes `model`, `credentials`, `catalogOverrides`, `loopHandlers`, `hostPorts`, `bashApproval` and `allowUnsandboxed`. The ACP backend ships in `@nathapp/nax-agent-acp`.
- Add a "Cost" note: `usage.costSource` is `computed` (native), `reported` or `unpriced`; never sum `unpriced` rows as cost.

In "Status and roadmap", replace the "An ACP backend … is planned" sentence with "`@nathapp/nax-agent-acp` provides an ACP backend for the same API (0.3.0)."

- [ ] **Step 3: CHANGELOG**

Under a single `## [Unreleased]` heading (the release helper throws on more than one), add:

```markdown
## [Unreleased]

The backend seam for S4. Breaking: `createAgentSession` takes a `SessionBackend`. nax behaviour unchanged.

### Changed

- **Breaking:** `CreateAgentSessionOptions.backend` is a `SessionBackend` (was `"native"`). `model`, `credentials`, `catalogOverrides`, `loopHandlers`, `hostPorts`, `bashApproval` and `allowUnsandboxed` move into `nativeBackend({ ... })`. A native-only key at the top level is `AGENT_SESSION_INVALID_OPTIONS`.
- `resumeAgentSession` refuses a document written by another backend kind (`AGENT_SESSION_BACKEND_MISMATCH`); documents without a `backend` field are native.

### Added

- `SessionBackend`, `BackendOpenContext`, `OpenedBackend`, `BackendInfo`, `TurnContribution`, `SessionAskPort`, `ApprovalRequest`, and `nativeBackend` with `NativeBackendOptions`. `AgentSession.backend` reports the backend's kind and capabilities.
- The `ask` profile: every Write, Edit, Delete, GitCommit and Bash is approved through `answer()`; it requires `bashApproval: "gated"` and the sandbox floor of `full`.
- `ApprovalDecidedBy` gains `"profile"`; `usage` and `turn_end` gain `costSource` (`computed` | `reported` | `unpriced`; `CostSource`); `TurnResult` gains `costSource`.
- Error codes `AGENT_SESSION_BACKEND_UNAVAILABLE`, `AGENT_SESSION_AUTH_REQUIRED`, `AGENT_SESSION_CAPABILITY_UNSUPPORTED`, `AGENT_SESSION_BACKEND_MISMATCH`.
- `TranscriptDoc.backend` and `TranscriptDoc.acp` (`TranscriptAcpRecord`), optional and additive (schemaVersion stays 1).
- Backend kit on `.`: `redactSecrets`, `capStrings`, `killProcessGroup`, `isProcessAlive`, `TOOL_CALL_INPUT_BYTES`, `TOOL_RESULT_PREVIEW_BYTES`, `createStderrTail` (`StderrTail`).
```

- [ ] **Step 4: Commit**

```bash
bun run lint:fix && git add packages/nax-agent && git commit -m "docs(nax-agent): 0.3.0 backend seam README and CHANGELOG; Node contract for ask"
```

---

### Task 8: Verification, nax Done-when, review and PR (controller)

**Files:** none new.

- [ ] **Step 1: Repo-root gates.** From the repo root, run each command; all must PASS:
  - `rtk bun run typecheck`
  - `rtk bun run check:all`
  - `rtk bun run test` (the nax suite runs here)
  - `rtk bun run build`
- [ ] **Step 2: Package gates.** From `packages/nax-agent`, run each command; all must PASS. Record the counts and coverage for the PR body.
  - `bun run check:api`
  - `bun run test:coverage`
  - `bun run test:node`
  - `bun ../repo-tooling/scripts/check-complexity.ts --package=.`
- [ ] **Step 3: nax source unchanged.** `git diff --exit-code origin/main -- packages/nax/` exits 0.
- [ ] **Step 4: Billed nax smoke (spec §10 S4-0 Done-when; approval at launch).** This PR changes `src/session/` and `src/infra/` (it does not touch `src/native/` behaviour beyond the type-only `transcript-types.ts`), so the Done-when requires the billed `nax run` S1-recipe smoke.
  - Ask the maintainer for approval at launch, then run it exactly as the S3 acceptance did (master plan, S3 row, T9 §10.3):
    - a fresh clone of the branch head;
    - an independent frozen install;
    - the original S1 clamp-helper PRD with statuses reset;
    - native MiniMax-M2.7;
    - `nax run -f s1-smoke -a native --headless --max-cost 2`;
    - a unique project name;
    - leave the fixture seed uncommitted so `naxCommit` equals the head.
  - Compare with `/private/tmp/nax-s3-acceptance-compare.py`, adapted for paths, project and commit.
  - Record the result in the PR body.
- [ ] **Step 5: Whole-branch review.** Dispatch one fresh reviewer over `git diff origin/main...HEAD`, with this plan's Review Focus and spec §5 as the checklist. Fix Critical and Important findings in at most 2 fix rounds, then run a scoped re-review.
- [ ] **Step 6: Push and open the PR.** Before pushing, run the code review. Push `feat/s4-acp-backend` and open the PR `feat(nax-agent)!: S4-0 backend seam, nativeBackend(), ask profile (0.3.0 contract)`. The body covers:
  - spec rows R5, R6 and §5;
  - the breaking change;
  - the verification counts;
  - "nax source unchanged" and the billed smoke result;
  - the deviations: existing cap constant names; `noteQuestion` answers `cancelled`; `ApprovalRequest.signal`; `costSource` also on `turn_end`.

  Merging is the maintainer's call, after CI is green.
