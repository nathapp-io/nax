# S4-3: ACP permissions and all four profiles: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `acpBackend()` serves all four profiles (`none`, `read`, `ask`, `full`) end to end. Each `session/request_permission` the agent sends is answered by the session's profile (spec §6.4). Under `ask`, the caller decides through `approval_requested` and `answer()`.

**Architecture:**
- Three new modules under `packages/nax-agent-acp/src/client/`:

  | Module | Role |
  |---|---|
  | `text.ts` | agent-text hygiene shared by errors and approvals: strip control characters, scrub secret values, byte caps |
  | `tool-display.ts` | turns the agent's untrusted `toolCall` into the `tool` / `summary` / `command` / `callId` a person sees |
  | `permissions.ts` | the §6.4 layer-2 table: one decision per request, by profile, over the options the agent offered |

- `inbound.ts` routes a permission request to `permissions.ts` only when it arrives during a turn and names the attached agent session. Everything else is rejected locally, logged and raises no event.
- Releasing a turn's binding aborts its pending decisions and waits for their answers. That way `approval_resolved` always precedes `turn_end`.
- `backend.ts` drops the S4-2 profile refusal (D-b). It wires the decider with the facade's `SessionAskPort`, plus a signal that aborts when the agent process exits.
- Layer 1, the agent mode (`plan` for `none`/`read`, `default` for `ask`/`full`), and the enforceability check already exist from S4-2 (`capabilities.ts`, `open.ts`). This plan exercises them end to end and does not change them.
- nax-agent gains one public export, `getLogger` (Task 0, D3-i). Nothing else in nax-agent changes.

**Tech Stack:**
- `@agentclientprotocol/sdk` 1.7.0 (stable v1 types `RequestPermissionRequest`, `RequestPermissionResponse`, `ToolCallUpdate`, `ToolKind`)
- `@nathapp/nax-agent` public `.`: `SessionAskPort`, `maskForPrompt`, `redactSecrets`, `TOOL_CALL_INPUT_BYTES`, and `getLogger` (on `.` from Task 0)
- bun:test (unit), vitest on Node 22/24 (contract)

**Spec:** `docs/superpowers/specs/2026-10-05-s4-acp-backend-design.md`. Sections used:
- §6.4 profiles on ACP and permissions (the whole section)
- §6.3 "Inbound requests with no active turn", and step 5 (pending asks settle `cancelled` when the process dies)
- §5.1 `SessionAskPort`, §5.5 `ApprovalDecidedBy` gains `"profile"`
- §6.10 registry (read-only mode exists only for Claude)
- §10 S4-3 row: "`permissions` (§6.4), all four profiles end to end"

## Global Constraints

- nax-agent-acp imports nax-agent only as `@nathapp/nax-agent` (public `.`), never `./internal` or a deep path, in `src/` or `test/` (§4).
- `src/` imports only `@agentclientprotocol/sdk` (root, never `/experimental` or `/v2`), `@modelcontextprotocol/sdk`, `zod` and `node:` builtins. No Bun API in `src/` (`check:no-bun-apis`).
- `src/` imports its own modules as `#src/client/<module>`.
- No `throw new Error(` in `src/` (`check-nax-error`, baseline 0).
- Only options the agent offered are chosen: `allow` → its `allow_once`, `deny` → its `reject_once`. `allow_always` and `reject_always` are never chosen (§6.4).
- The agent-supplied `toolCall` fields (`toolCall.kind`, `title`, `locations`, `rawInput`, `toolCallId`) are display data only and never decide (§6.4 "untrusted fields"). Only the permission option kinds (`allow_once`, `reject_once`) select the answer.
- Expiry: deadline → `reject_once` (`decidedBy: "timeout"`); turn abort or process death → `cancelled` (§6.4).
- Out-of-turn requests → `reject_once`, else `cancelled`; logged; no event (§6.3).
- Client capabilities at `initialize` stay `{}`: no fs, no terminal (R11), and no elicitation until S4-5.
- Embedder tools and resume stay refused before spawning (S4-2 D-b) until S4-4 and S4-6.
- Gates (from `packages/nax-agent-acp`):
  - file sizes: 600 lines per src file, 800 per test file
  - complexity: 20 per function
  - coverage: 80% overall and per src file; the per-file baseline stays empty
  - import cycles: none
  - test satellites: a test file is named `<module>.test.ts` or `<module>-<concern>.test.ts` (as `backend-process.test.ts`), never after a ticket; each new `src/client/<m>.ts` gets `test/unit/client/<m>.test.ts`
  - no `as unknown as`, `as any` or `@ts-ignore` in tests: build malformed input with `JSON.parse`, as the S4-2 tests do
- Nothing is released in S4-3: no tag, no publish (§10).
- `packages/nax/` does not change. In nax-agent only `src/index.ts`, `test/unit/infra/agent-logger.test.ts`, `api/nax-agent.api.txt` and `CHANGELOG.md` change (Task 0), plus one line in spec §5.6.
- Never run bare `bun test` (no path) and never `bun run nax`. Package commands run from the package directory.
- Code in this plan is not pre-formatted: run `bun run lint:fix` in the package before every `check:all`.
- No emojis in code, comments or docs. Edit `.nax/**/context.md` only, then regenerate. Never hand-edit `CLAUDE.md`, `AGENTS.md`, `GEMINI.md` or `codex.md`.

## Review Focus

1. **A permission request that is still pending when its turn stops must settle, not hang.** There are three ways the turn stops:
   - the caller cancels
   - the agent ends the prompt without waiting for the answer
   - the agent process dies

   In each case the answer is `cancelled`, `approval_resolved` precedes `turn_end`, and neither `send()` nor `close()` hangs. A request that arrives after the turn was cancelled, while the agent still has `cancelGraceMs` to stop, is answered `cancelled` even under `full`: a cancelled turn must not start new tools. Pinned in Task 2 (aborted signal), Task 3 (router release waits for pending decisions; turn signal reaches the decision) and Task 4 (all cases end to end).
2. **Hostile agent text reaching an approval event or stalling the process.** Agent text here means the title, the `rawInput.command` of an execute call, a location path or the `toolCallId`. Secret-named env values must appear as `[REDACTED]` and pattern secrets as `[REDACTED:<kind>]`. Control and invisible format characters (bidi overrides, zero-width) must be stripped, the one-line fields must stay one line, and the text must be capped. A `toolCallId` holding a secret is dropped. `maskForPrompt` is quadratic, so oversized raw text is withheld without being masked: one huge title must not freeze the event loop. A secret that cannot be masked safely makes the request unshowable, and under `ask` it is denied without asking. Pinned in Tasks 1, 2 and 4.
3. **Persistent options are never selected.** An agent that offers only `allow_always` or `reject_always`, or lists them first, must never get either back. Pinned in Task 2.
4. **Out-of-turn, foreign-session or flooding permission requests.** A request after the turn ended, one naming another agent session, or one beyond `MAX_PENDING_DECISIONS` concurrent decisions must be rejected locally, must not reach the decider, and must raise no event. The log line is written once per reason per session, and a throwing host logger never changes the answer. Pinned in Task 3 (router) and Task 4 (foreign session end to end).
5. **Plan mode must hold under `none` and `read`.** Claude asks permission to leave plan mode (ExitPlanMode, kind `switch_mode`), and that request must be rejected. Malformed input must also yield a defined answer: `options: null`, `toolCall: null`, a non-string `optionId`, or an unknown `kind`. Pinned in Tasks 1, 2 and 4.

## Decisions taken in this plan (for review)

- **D3-a. What a person sees.**
  - `tool` is the ACP `ToolKind` when it is one of the ten protocol values, else `"other"`.
  - `summary` is the trimmed `title`. Without a title it is `"<kind> <first location path>"`, else `"<kind> tool call"`.
  - `command` is set only for kind `execute` whose `rawInput.command` is a non-empty string.
  - `callId` is the `toolCallId` when it is a non-empty string of at most 512 characters after cleaning. This is the same id S4-5 will use for `tool_call` events.

  The pipeline for `summary` and `command`:
  1. raw text over a size limit is withheld (unshowable) without being masked: 8 KiB for `summary`, 32 KiB for `command`. `maskForPrompt` is quadratic: 8 KiB of `sk-` repeats takes 4 ms, 32 KiB 56 ms, 256 KiB 3.5 s. Truncating first would show a cut secret prefix, so oversized text is withheld instead.
  2. control characters (`\p{Cc}`) and invisible format characters (`\p{Cf}`: bidi overrides, zero-width) are stripped; `summary` also collapses newlines and tabs to one space, `command` keeps them.
  3. the session's secret values are scrubbed, then `maskForPrompt` masks pattern secrets (as nax-agent's own ask link does), then `redactSecrets` runs (as `errors.ts` does).
  4. capped: `summary` 1024 bytes, `command` `TOOL_CALL_INPUT_BYTES` (8192).

  `callId` goes through steps 2 and 3 with all whitespace removed, and is dropped when any step would change it. An id with a secret in it is not shown masked: it would no longer match the agent's id.
- **D3-b. Unshowable requests fail closed.** When `maskForPrompt` refuses (a secret spans shell syntax), the request is unshowable.
  - Under `ask` it is denied without asking: `recordAutoDecision(..., "deny")` with the reason "the request could not be shown safely". `ApprovalDecidedBy` has `"unshowable"`, but `recordAutoDecision` always records `"profile"`. That is accepted rather than widening the port in S4-3.
  - `maskForPrompt` also refuses some legitimate commands, for example `FOO_TOKEN=x; cmd`. Those are denied under `ask` too; the README says so.
  - Under the other profiles the auto-decision proceeds with a withheld summary, `"<kind> tool call (details withheld: they could not be shown safely)"`, and no command.
- **D3-c. "During a turn" means the router has a binding and the request names the bound agent session.**
  - Anything else is rejected locally (`reject_once`, else `cancelled`) and raises no event.
  - So is a request beyond `MAX_PENDING_DECISIONS` (16) concurrent decisions in one turn: a flooding agent cannot grow the pending set without bound.
  - Each rejection reason (`"no-turn"`, `"foreign-session"`, `"too-many"`) is logged once per session with `getLogger().warn("acp", ...)` and `{ reason }`. There is no agent text in the log. A throw from the host's logger is contained.
- **D3-d. One signal per turn binding decides when a decision is moot.** `router.attach(agentSessionId, collector, turnSignal)` combines, once per turn:
  - the binding's scope, aborted when `sendTurn` releases it
  - the turn signal (cancel, turn timeout, close)
  - the backend's process-gone signal, aborted when the agent process exits

  `sendTurn` passes `AbortSignal.any([turnSignal, gone.signal])` as `turnSignal`, and the router adds its scope. That is two composite signals per turn and none per request. A decision whose signal is already aborted answers `cancelled` with no event, under every profile. That closes the cancel grace window: after `cancel()` the agent has `cancelGraceMs` to stop, and a request it sends then is never allowed. The ask port also aborts on the same signal. `sendTurn` awaits the release, which waits for every pending decision, so `approval_resolved` is emitted before the adapter returns and before `turn_end`.
- **D3-e. Order of the checks:**
  1. the signal is already aborted → `cancelled`, no event (D3-d).
  2. `none`/`read` → deny. This holds even when no `allow_once` was offered.
  3. no `allow_once` offered → deny, with the reason "agent offered no allow-once option".
  4. `full` → allow.
  5. under `ask`, an unshowable request → deny (D3-b).
  6. otherwise ask the caller.

  The profile check is an exhaustive `switch` whose `default` denies, so a profile added later fails closed. The reason strings are fixed constants, exported for tests.
- **D3-f. Any throw from the ask port answers `cancelled`.** This covers the port's `no-turn`, raised when the turn ended between routing and asking, and any failure in the decider. Fail closed.
- **D3-g. `rejectLocally` moves from `inbound.ts` to `permissions.ts`, next to `offeredOptions`.** `createInboundRouter` takes a required `PermissionDecider`; there is no default, so a forgotten wiring cannot silently reject everything.
- **D3-h. The fake agent's `permission` step is extended.** It can override the tool call, address another session, or be sent `detached` (without waiting for the answer). Each answer is also recorded as `permission-answer` with its `toolCallId`. A refused request is recorded as `permission-error` instead of failing the prompt. Two steps are added:
  - `settled` waits for every detached answer of the prompt
  - `awaitCancel` waits for `session/cancel` and then carries on with the next step (`waitForCancel` stops the turn)

  The in-memory launcher gains `crash()`.
- **D3-i. nax-agent exports `getLogger` on `.`.** Spec §6.3 says an out-of-turn permission request is logged, but nax-agent-acp may import only the public entry, which has `setAgentLogger` and the `AgentLogger` type but no getter. `getLogger()` returns the host's logger or a silent no-op and never throws. This is the same kind of 0.3.0 contract addition as S4-2's `NaxError` (D-a): unreleased, one API-snapshot line, no change under `native/`, `tools/`, `permissions/`, `session/` or `internal/`, so no billed smoke. Spec §5.6 is amended in Task 0.
- **D3-j. An answer to a request on a closed connection needs no handling.** The SDK awaits the responder inside the handler, catches the failure and returns silently when the connection was aborted (`acp.js` `registerAppRequest`, `jsonrpc.js` `processIncomingMessage`). A write failure on a live connection is logged by the SDK and the connection stays up. Neither path produces an unhandled rejection, so `connection.ts` does not change. (Checked by the final review against SDK 1.7.0.)

---

## File structure

**Create (package `packages/nax-agent-acp/`):**

| Path | Responsibility |
|---|---|
| `src/client/text.ts` | `isRecord`, `stripControl`, `stripInvisible`, `scrubSecrets`, `capBytes` |
| `src/client/tool-display.ts` | `describeToolCall(toolCall, secrets): ToolCallDisplay` |
| `src/client/permissions.ts` | `offeredOptions`, `rejectWith`, `rejectLocally`, `decidePermission`, reason constants |
| `test/unit/client/text.test.ts` | text helpers |
| `test/unit/client/tool-display.test.ts` | display, hygiene, unshowable |
| `test/unit/client/permissions.test.ts` | the §6.4 table against a stub ask port |
| `test/unit/client/backend-permissions.test.ts` | all four profiles through the facade, in process |
| `test/helpers/session-events.ts` | `driveTurn`, `endOf`, `indexOfType` for facade-level tests |

**Modify:**

| Path | Change |
|---|---|
| `src/client/errors.ts` | `agentTextExcerpt` uses `text.ts`; local `capBytes` and `MIN_SECRET_LENGTH` removed |
| `src/client/inbound.ts` | decider routing, out-of-turn and over-cap rejection with a log, release waits for pending decisions |
| `src/client/backend.ts` | Task 3: interim reject-all decider on the new router API, `sendTurn` awaits the release. Task 4: profile refusal removed; decider and process-gone signal wired |
| `src/client/index.ts` | header comment (status) |
| `test/fixtures/fake-agent/script.ts`, `agent.ts` | `PermissionStep`, `settled`, `awaitCancel` (D3-h) |
| `test/helpers/in-memory-launch.ts` | `crash()` |
| `test/unit/client/inbound.test.ts` | router tests for the new contract |
| `test/unit/client/open.test.ts`, `connection.test.ts` | `rejectLocally` import and the router's decider argument |
| `test/unit/client/backend.test.ts` | the D-d permission test and the profile refusals removed (superseded) |
| `test/unit/client/backend-process.test.ts` | an `ask` approval round trip over real pipes |
| `test/node/acp-backend.test.ts` | the same round trip on Node |
| `README.md`, `CHANGELOG.md` | status, profiles and their guarantees |
| `.nax/mono/packages/nax-agent-acp/context.md` (repo root) | status and module map, then regenerate |
| `packages/nax-agent/src/index.ts`, `test/unit/infra/agent-logger.test.ts`, `api/nax-agent.api.txt`, `CHANGELOG.md` | `getLogger` on `.` (Task 0) |
| `docs/superpowers/specs/2026-10-05-s4-acp-backend-design.md` | §5.6 lists `getLogger` (Task 0) |

---

### Task 0: nax-agent exports `getLogger` on `.`

**Files:**
- Modify: `packages/nax-agent/src/index.ts:81`
- Modify: `packages/nax-agent/test/unit/infra/agent-logger.test.ts`
- Modify (generated): `packages/nax-agent/api/nax-agent.api.txt`
- Modify: `packages/nax-agent/CHANGELOG.md`, `docs/superpowers/specs/2026-10-05-s4-acp-backend-design.md`

**Interfaces:**
- Produces: `import { getLogger } from "@nathapp/nax-agent"`, which returns `AgentLogger`: the installed logger, or a silent no-op. It never throws. It is the same function `./internal` exports.

- [ ] **Step 1: Write the failing test**

In `packages/nax-agent/test/unit/infra/agent-logger.test.ts`, add the import `import { getLogger as publicGetLogger, setAgentLogger as publicSetAgentLogger } from "@nathapp/nax-agent";` and append inside the `describe`:

```ts
  test("getLogger is on the public entry and reads the slot setAgentLogger fills (S4-3, spec §5.6)", () => {
    expect(publicGetLogger).toBe(getLogger);
    const logger = recordingLogger();
    publicSetAgentLogger(logger);
    publicGetLogger().warn("acp", "seen");
    expect(logger.calls).toEqual(["warn:acp:seen"]);
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/nax-agent && bun test test/unit/infra/agent-logger.test.ts`
Expected: FAIL. `publicGetLogger` is `undefined`.

- [ ] **Step 3: Export it**

In `packages/nax-agent/src/index.ts`, change line 81 from

```ts
export { configureCredentials, setAgentLogger } from "#src/infra/index";
```

to

```ts
export { configureCredentials, getLogger, setAgentLogger } from "#src/infra/index";
```

- [ ] **Step 4: Run the test, regenerate the snapshot, run the gates**

Run:
```bash
cd packages/nax-agent
bun test test/unit/infra/agent-logger.test.ts
bun run api:update
git diff --stat -- api/ | cat
bun run check:api && bun run typecheck && bun run lint:fix && bun run check:all
```
Expected:
- The test passes.
- The API diff is one added line, `getLogger`, in the `[.]` section.
- All gates exit 0.

- [ ] **Step 5: Record it**

In `packages/nax-agent/CHANGELOG.md`, under `[Unreleased]` → `### Added`, append:

```markdown
- `getLogger` on `.`: the logger the host installed with `setAgentLogger`, or a silent no-op, so a backend can log through the host's logger.
```

In the spec, §5.6, after the `NaxError` bullet, add:

```markdown
- `getLogger` (added in S4-3): a backend logs through the host's logger (for example the ACP backend's out-of-turn permission rejections, §6.3).
```

- [ ] **Step 6: Commit**

```bash
git add packages/nax-agent/src/index.ts packages/nax-agent/test/unit/infra/agent-logger.test.ts packages/nax-agent/api/nax-agent.api.txt packages/nax-agent/CHANGELOG.md docs/superpowers/specs/2026-10-05-s4-acp-backend-design.md
git commit -m "feat(nax-agent): export getLogger on the public entry for session backends"
```

---

### Task 1: Agent-text hygiene and the tool-call display

**Files:**
- Create: `packages/nax-agent-acp/src/client/text.ts`
- Create: `packages/nax-agent-acp/src/client/tool-display.ts`
- Modify: `packages/nax-agent-acp/src/client/errors.ts:9-42`
- Test: `packages/nax-agent-acp/test/unit/client/text.test.ts`
- Test: `packages/nax-agent-acp/test/unit/client/tool-display.test.ts`

**Interfaces:**
- Consumes: `maskForPrompt(text): { ok: true; masked: string; count: number } | { ok: false; reason: string }`, `redactSecrets<T>(input: T): T`, `TOOL_CALL_INPUT_BYTES` (8192) from `@nathapp/nax-agent`.
- Produces:
  - `text.ts`:
    - `isRecord(value: unknown): value is Readonly<Record<string, unknown>>`
    - `stripControl(text: string): string`
    - `stripInvisible(text: string): string`
    - `scrubSecrets(text: string, secrets: readonly string[]): string`
    - `capBytes(text: string, maxBytes: number): string`
  - `tool-display.ts`:
    - `SUMMARY_MAX_BYTES = 1024`, `SUMMARY_RAW_MAX_BYTES = 8192`, `COMMAND_RAW_MAX_BYTES = 32768`
    - `interface ToolCallDisplay { callId?: string; tool: string; summary: string; command?: string; showable: boolean }`
    - `describeToolCall(toolCall: unknown, secrets: readonly string[]): ToolCallDisplay`

All work runs from `packages/nax-agent-acp` unless a step says otherwise.

- [ ] **Step 1: Write the failing text tests**

`test/unit/client/text.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { capBytes, isRecord, scrubSecrets, stripControl, stripInvisible } from "#src/client/text";

describe("text hygiene (spec §6.4 untrusted fields, §7)", () => {
  test("stripControl keeps newline and tab, drops other control characters", () => {
    expect(stripControl("a\u0000b\u001b[31mc\nd\te\u007f")).toBe("ab[31mc\nd\te");
  });

  test("stripInvisible drops format characters: bidi overrides and zero-width", () => {
    expect(stripInvisible("a\u200bb\u202ec\u2066d\ufeffe")).toBe("abcde");
  });

  test("scrubSecrets replaces values of 8+ characters only", () => {
    expect(scrubSecrets("key=abcdefgh short=abc", ["abcdefgh", "abc"])).toBe("key=[REDACTED] short=abc");
  });

  test("capBytes never splits a multi-byte character", () => {
    expect(capBytes("ab€", 4)).toBe("ab");
    expect(capBytes("short", 100)).toBe("short");
  });

  test("isRecord accepts plain objects only", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord(null)).toBe(false);
    expect(isRecord([])).toBe(false);
    expect(isRecord("x")).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun test ./test/unit/client/text.test.ts`
Expected: FAIL, cannot resolve `#src/client/text`.

- [ ] **Step 3: Implement `text.ts`**

```ts
/**
 * Agent text made safe to show (S4 spec §6.4 "untrusted fields", §7): control
 * characters stripped, the session's secret values scrubbed, byte caps that never
 * split a character. Shared by error excerpts (errors.ts) and the approval display
 * (tool-display.ts).
 */

/** Shorter secret values are not replaced verbatim: they would garble ordinary text. */
const MIN_SECRET_LENGTH = 8;

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Control characters removed, except newline and tab. */
export function stripControl(text: string): string {
  return text.replace(/\p{Cc}/gu, (c) => (c === "\n" || c === "\t" ? c : ""));
}

/** Invisible format characters removed (bidi overrides, zero-width): they can hide text from a person. */
export function stripInvisible(text: string): string {
  return text.replace(/\p{Cf}/gu, "");
}

/** Each known secret value of 8 or more characters replaced by [REDACTED]. */
export function scrubSecrets(text: string, secrets: readonly string[]): string {
  return secrets
    .filter((secret) => secret.length >= MIN_SECRET_LENGTH)
    .reduce((acc, secret) => acc.split(secret).join("[REDACTED]"), text);
}

export function capBytes(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength <= maxBytes) return text;
  // A cut inside a multi-byte character decodes to U+FFFD; drop it.
  return bytes.subarray(0, maxBytes).toString("utf8").replace(/�+$/u, "");
}
```

- [ ] **Step 4: Point `errors.ts` at it**

In `src/client/errors.ts`:
- Delete the `MIN_SECRET_LENGTH` constant and the local `capBytes` function.
- Add the import `import { capBytes, scrubSecrets, stripControl } from "#src/client/text";`.
- Replace the body of `agentTextExcerpt` with:

```ts
/** Agent text made safe for an error: control characters stripped (except \n, \t), secrets redacted, capped. */
export function agentTextExcerpt(text: string, secrets: readonly string[]): string {
  return capBytes(redactSecrets(scrubSecrets(stripControl(text), secrets)), EXCERPT_BYTES);
}
```

- [ ] **Step 5: Run the text and error tests**

Run: `bun test ./test/unit/client/text.test.ts ./test/unit/client/errors.test.ts`
Expected: PASS. `errors.test.ts` is unchanged and still green, which proves the refactor kept the behaviour.

- [ ] **Step 6: Write the failing display tests**

`test/unit/client/tool-display.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { TOOL_CALL_INPUT_BYTES } from "@nathapp/nax-agent";
import {
  COMMAND_RAW_MAX_BYTES,
  describeToolCall,
  SUMMARY_MAX_BYTES,
  SUMMARY_RAW_MAX_BYTES,
} from "#src/client/tool-display";

const SECRET = "s3cr3t-token-value-0123";
const GH_TOKEN = `ghp_${"a".repeat(36)}`;
/** maskForPrompt refuses it: an assignment secret spans shell syntax (nax-agent secret-spans.test.ts). */
const UNMASKABLE = "TOKEN=abc;rm x";

describe("describeToolCall (spec §6.4 untrusted fields, D3-a)", () => {
  test("title, kind and call id as given", () => {
    expect(describeToolCall({ toolCallId: "call-1", kind: "edit", title: "Edit `src/a.ts`" }, [])).toEqual({
      callId: "call-1",
      tool: "edit",
      summary: "Edit `src/a.ts`",
      showable: true,
    });
  });

  test("execute: rawInput.command becomes the command", () => {
    const shown = describeToolCall(
      { toolCallId: "c", kind: "execute", title: "Run tests", rawInput: { command: "bun test ./x" } },
      [],
    );
    expect(shown).toMatchObject({ tool: "execute", summary: "Run tests", command: "bun test ./x", showable: true });
  });

  test("a command is only taken from kind execute", () => {
    expect(describeToolCall({ toolCallId: "c", kind: "edit", rawInput: { command: "rm -rf /" } }, []).command).toBe(
      undefined,
    );
  });

  test("no title: kind plus the first location path, else kind alone", () => {
    expect(describeToolCall({ toolCallId: "c", kind: "read", locations: [{ path: "/w/a.ts" }] }, []).summary).toBe(
      "read /w/a.ts",
    );
    expect(describeToolCall({ toolCallId: "c", kind: "fetch", title: "   " }, []).summary).toBe("fetch tool call");
  });

  test("an unknown or missing kind is other", () => {
    expect(describeToolCall({ toolCallId: "c", kind: "__proto__" }, []).tool).toBe("other");
    expect(describeToolCall({ toolCallId: "c" }, []).tool).toBe("other");
  });

  test("malformed tool calls are described, not thrown on", () => {
    expect(describeToolCall(null, [])).toEqual({ tool: "other", summary: "other tool call", showable: true });
    const odd = JSON.parse('{"toolCallId":42,"title":["x"],"locations":"nope","rawInput":null,"kind":"execute"}');
    expect(describeToolCall(odd, [])).toEqual({ tool: "execute", summary: "execute tool call", showable: true });
  });

  test("an unusable call id is dropped", () => {
    expect(describeToolCall({ toolCallId: "" }, []).callId).toBe(undefined);
    expect(describeToolCall({ toolCallId: "x".repeat(513) }, []).callId).toBe(undefined);
    expect(describeToolCall({ toolCallId: "a\u0000b\u200b c" }, []).callId).toBe("abc");
  });

  test("a call id holding a secret is dropped, not shown masked", () => {
    expect(describeToolCall({ toolCallId: GH_TOKEN }, []).callId).toBe(undefined);
    expect(describeToolCall({ toolCallId: `id-${SECRET}` }, [SECRET]).callId).toBe(undefined);
  });

  test("summary is one line; a command keeps its newlines; invisible characters are stripped", () => {
    const shown = describeToolCall(
      {
        toolCallId: "c",
        kind: "execute",
        title: "Run\n  the\ttests\u202e",
        rawInput: { command: "cd x\nbun test" },
      },
      [],
    );
    expect(shown.summary).toBe("Run the tests");
    expect(shown.command).toBe("cd x\nbun test");
  });

  test("oversized raw text is withheld without being masked (maskForPrompt is quadratic)", () => {
    const flood = "sk-".repeat(100_000);
    const started = Date.now();
    const titled = describeToolCall({ toolCallId: "c", kind: "edit", title: flood }, []);
    const commanded = describeToolCall(
      { toolCallId: "c", kind: "execute", title: "Run", rawInput: { command: flood } },
      [],
    );
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(titled).toMatchObject({
      summary: "edit tool call (details withheld: they could not be shown safely)",
      showable: false,
    });
    expect(commanded).toMatchObject({ summary: "Run", showable: false });
    expect(commanded.command).toBe(undefined);
  });

  test("text at the raw limits is still shown", () => {
    expect(describeToolCall({ toolCallId: "c", title: "t".repeat(SUMMARY_RAW_MAX_BYTES) }, []).showable).toBe(true);
    const atLimit = { toolCallId: "c", kind: "execute", rawInput: { command: "c".repeat(COMMAND_RAW_MAX_BYTES) } };
    expect(describeToolCall(atLimit, []).showable).toBe(true);
  });

  test("control characters stripped; session secrets and pattern secrets masked", () => {
    const shown = describeToolCall(
      {
        toolCallId: "c",
        kind: "execute",
        title: `Use ${SECRET}\u001b[0m`,
        rawInput: { command: `curl -u ${GH_TOKEN} https://x?k=${SECRET}` },
      },
      [SECRET],
    );
    expect(shown.summary).toBe("Use [REDACTED][0m");
    expect(shown.command).not.toContain(SECRET);
    expect(shown.command).not.toContain(GH_TOKEN);
    expect(shown.command).toContain("[REDACTED");
    expect(shown.showable).toBe(true);
  });

  test("summary and command are capped", () => {
    const shown = describeToolCall(
      { toolCallId: "c", kind: "execute", title: "t".repeat(5_000), rawInput: { command: "c".repeat(20_000) } },
      [],
    );
    expect(Buffer.byteLength(shown.summary)).toBe(SUMMARY_MAX_BYTES);
    expect(Buffer.byteLength(shown.command ?? "")).toBe(TOOL_CALL_INPUT_BYTES);
  });

  test("a secret that cannot be masked safely makes the request unshowable (D3-b)", () => {
    const shown = describeToolCall(
      { toolCallId: "c", kind: "execute", title: "Run", rawInput: { command: UNMASKABLE } },
      [],
    );
    expect(shown.showable).toBe(false);
    expect(shown.command).toBe(undefined);
    const titled = describeToolCall({ toolCallId: "c", kind: "execute", title: UNMASKABLE }, []);
    expect(titled).toMatchObject({
      summary: "execute tool call (details withheld: they could not be shown safely)",
      showable: false,
    });
  });
});
```

`UNMASKABLE` and the masked `curl -u` command were checked against `maskForPrompt` on main `e07e07cd2` while writing this plan: the first is refused, the second masks to `curl -u [REDACTED:github] https://x?k=[REDACTED]`.

- [ ] **Step 7: Run it to make sure it fails**

Run: `bun test ./test/unit/client/tool-display.test.ts`
Expected: FAIL, cannot resolve `#src/client/tool-display`.

- [ ] **Step 8: Implement `tool-display.ts`**

```ts
/**
 * What a person sees of an agent's permission request (S4 spec §6.4 "untrusted
 * fields", D3-a). The agent's kind, title, locations and rawInput are display data
 * only: they never decide. Every string is control-stripped, scrubbed of the
 * session's secret values, masked as nax-agent's own approvals are
 * (maskForPrompt), redacted and capped. Oversized raw text and text whose secret
 * cannot be masked safely make the request unshowable: it is never put in front
 * of a person (D3-b).
 */
import type { ToolKind } from "@agentclientprotocol/sdk";
import { maskForPrompt, redactSecrets, TOOL_CALL_INPUT_BYTES } from "@nathapp/nax-agent";
import { capBytes, isRecord, scrubSecrets, stripControl, stripInvisible } from "#src/client/text";

export const SUMMARY_MAX_BYTES = 1024;
/**
 * Raw agent text above these sizes is withheld without being masked: maskForPrompt
 * is quadratic (8 KiB takes about 4 ms, 256 KiB seconds), and truncating first
 * would show a cut secret prefix.
 */
export const SUMMARY_RAW_MAX_BYTES = 8 * 1024;
export const COMMAND_RAW_MAX_BYTES = 32 * 1024;
const CALL_ID_MAX_CHARS = 512;
const WITHHELD = "(details withheld: they could not be shown safely)";

const KINDS: ReadonlySet<string> = new Set<ToolKind>([
  "read",
  "edit",
  "delete",
  "move",
  "search",
  "execute",
  "think",
  "fetch",
  "switch_mode",
  "other",
]);

export interface ToolCallDisplay {
  readonly callId?: string;
  readonly tool: string;
  readonly summary: string;
  readonly command?: string;
  /** False when agent text held a secret that could not be masked safely. */
  readonly showable: boolean;
}

type Call = Readonly<Record<string, unknown>>;
type Shown = { readonly ok: true; readonly text: string } | { readonly ok: false };

interface ShowLimits {
  readonly rawMaxBytes: number;
  readonly capBytes: number;
  /** Newlines and tabs collapse to one space. */
  readonly oneLine: boolean;
}

const SUMMARY: ShowLimits = { rawMaxBytes: SUMMARY_RAW_MAX_BYTES, capBytes: SUMMARY_MAX_BYTES, oneLine: true };
const COMMAND: ShowLimits = { rawMaxBytes: COMMAND_RAW_MAX_BYTES, capBytes: TOOL_CALL_INPUT_BYTES, oneLine: false };

/** Visible, secret-free text: strip, scrub the session's secrets, mask pattern secrets, redact. */
function clean(text: string, secrets: readonly string[]): Shown {
  const masked = maskForPrompt(scrubSecrets(stripInvisible(stripControl(text)), secrets));
  return masked.ok ? { ok: true, text: redactSecrets(masked.masked) } : { ok: false };
}

function show(raw: string, secrets: readonly string[], limits: ShowLimits): Shown {
  if (Buffer.byteLength(raw, "utf8") > limits.rawMaxBytes) return { ok: false };
  const text = limits.oneLine ? raw.replace(/[\n\t]+\s*/g, " ") : raw;
  const shown = clean(text, secrets);
  return shown.ok ? { ok: true, text: capBytes(shown.text, limits.capBytes) } : { ok: false };
}

function kindOf(call: Call): string {
  return typeof call.kind === "string" && KINDS.has(call.kind) ? call.kind : "other";
}

/** The agent's id without invisible characters or whitespace; dropped when it held a secret. */
function callIdOf(call: Call, secrets: readonly string[]): string | undefined {
  if (typeof call.toolCallId !== "string" || call.toolCallId.length > CALL_ID_MAX_CHARS) return undefined;
  const id = stripInvisible(stripControl(call.toolCallId)).replace(/\s+/g, "");
  if (id === "") return undefined;
  const shown = clean(id, secrets);
  // An id that held a secret is dropped, not shown masked: it would no longer match the agent's id.
  return shown.ok && shown.text === id ? id : undefined;
}

function firstPath(call: Call): string | undefined {
  if (!Array.isArray(call.locations)) return undefined;
  const first: unknown = call.locations[0];
  return isRecord(first) && typeof first.path === "string" && first.path !== "" ? first.path : undefined;
}

function summarySource(call: Call, kind: string): string {
  const title = typeof call.title === "string" ? call.title.trim() : "";
  if (title !== "") return title;
  const path = firstPath(call);
  return path === undefined ? `${kind} tool call` : `${kind} ${path}`;
}

function commandSource(call: Call, kind: string): string | undefined {
  if (kind !== "execute" || !isRecord(call.rawInput)) return undefined;
  const command = call.rawInput.command;
  return typeof command === "string" && command !== "" ? command : undefined;
}

export function describeToolCall(toolCall: unknown, secrets: readonly string[]): ToolCallDisplay {
  const call: Call = isRecord(toolCall) ? toolCall : {};
  const kind = kindOf(call);
  const callId = callIdOf(call, secrets);
  const summary = show(summarySource(call, kind), secrets, SUMMARY);
  const rawCommand = commandSource(call, kind);
  const command = rawCommand === undefined ? undefined : show(rawCommand, secrets, COMMAND);
  return {
    ...(callId === undefined ? {} : { callId }),
    tool: kind,
    summary: summary.ok ? summary.text : `${kind} tool call ${WITHHELD}`,
    ...(command !== undefined && command.ok ? { command: command.text } : {}),
    showable: summary.ok && (command === undefined || command.ok),
  };
}
```

- [ ] **Step 9: Run the tests, typecheck and lint**

Run:
```bash
bun test ./test/unit/client/text.test.ts ./test/unit/client/tool-display.test.ts ./test/unit/client/errors.test.ts
bun run typecheck
bun run lint:fix && bun run check:all
```
Expected: PASS, and both commands exit 0.

If the `capBytes` test with `"t".repeat(5_000)` yields fewer than `SUMMARY_MAX_BYTES` bytes, the title was trimmed or masked. In that case, check that maskForPrompt finds no span in a run of `t`; it should not.

- [ ] **Step 10: Commit**

```bash
git add src/client/text.ts src/client/tool-display.ts src/client/errors.ts test/unit/client/text.test.ts test/unit/client/tool-display.test.ts
git commit -m "feat(nax-agent-acp): S4-3 agent-text hygiene and the tool-call display"
```

---

### Task 2: The permission decision (§6.4 layer 2)

**Files:**
- Create: `packages/nax-agent-acp/src/client/permissions.ts`
- Test: `packages/nax-agent-acp/test/unit/client/permissions.test.ts`

**Interfaces:**
- Consumes:
  - `describeToolCall`, `ToolCallDisplay` (Task 1)
  - `isRecord` (Task 1)
  - `SessionAskPort`, `AgentSessionProfile`, `ApprovalRequest` (types) from `@nathapp/nax-agent`
- Produces:
  - `interface PermissionContext { profile: AgentSessionProfile; asks: SessionAskPort; secrets: readonly string[]; signal: AbortSignal }`
  - `interface OfferedOptions { allowOnce?: string; rejectOnce?: string }`
  - `offeredOptions(request: RequestPermissionRequest): OfferedOptions`
  - `rejectWith(offered: OfferedOptions): RequestPermissionResponse`
  - `rejectLocally(request: RequestPermissionRequest): RequestPermissionResponse`
  - `decidePermission(request: RequestPermissionRequest, ctx: PermissionContext): Promise<RequestPermissionResponse>`
  - the reason constants `NO_ALLOW_ONCE_REASON`, `UNSHOWABLE_REASON`, `ASK_REASON`, `FULL_REASON`, `UNKNOWN_PROFILE_REASON` and the function `readOnlyReason(profile)`

- [ ] **Step 1: Write the failing tests**

`test/unit/client/permissions.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type {
  PermissionOptionKind,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import type { AgentSessionProfile, ApprovalDecidedBy, ApprovalRequest, SessionAskPort } from "@nathapp/nax-agent";
import {
  ASK_REASON,
  decidePermission,
  FULL_REASON,
  NO_ALLOW_ONCE_REASON,
  offeredOptions,
  readOnlyReason,
  rejectLocally,
  UNSHOWABLE_REASON,
} from "#src/client/permissions";

/** maskForPrompt refuses it: an assignment secret spans shell syntax. */
const UNMASKABLE = "TOKEN=abc;rm x";
const IDLE = new AbortController().signal;

function request(
  kinds: readonly PermissionOptionKind[],
  toolCall: RequestPermissionRequest["toolCall"] = { toolCallId: "t-1", kind: "edit", title: "Edit a.ts" },
): RequestPermissionRequest {
  return { sessionId: "s", toolCall, options: kinds.map((kind) => ({ optionId: `opt-${kind}`, name: kind, kind })) };
}

interface Recorded {
  readonly auto: { readonly req: Omit<ApprovalRequest, "command" | "signal">; readonly decision: string }[];
  readonly asked: ApprovalRequest[];
}

function asks(
  answer: () => Promise<{ decision: "allow" | "deny"; decidedBy: ApprovalDecidedBy }> = async () => ({
    decision: "allow",
    decidedBy: "human",
  }),
): { port: SessionAskPort; seen: Recorded } {
  const seen: Recorded = { auto: [], asked: [] };
  const port: SessionAskPort = {
    requestApproval: async (req) => {
      seen.asked.push(req);
      return answer();
    },
    recordAutoDecision: (req, decision) => {
      seen.auto.push({ req, decision });
    },
    askQuestion: async () => null,
    noteQuestion: () => {},
  };
  return { port, seen };
}

function ctx(profile: AgentSessionProfile, port: SessionAskPort, signal: AbortSignal = IDLE) {
  return { profile, asks: port, secrets: [], signal };
}

// Typed: bun's toEqual is typed against the actual value, and a widened `outcome: string` does not compile.
const selected = (kind: string): RequestPermissionResponse => ({
  outcome: { outcome: "selected", optionId: `opt-${kind}` },
});
const CANCELLED: RequestPermissionResponse = { outcome: { outcome: "cancelled" } };

describe("offeredOptions and rejectLocally", () => {
  test("only the *_once kinds are picked; the first of each wins", () => {
    const req = request(["allow_always", "allow_once", "reject_always", "reject_once"]);
    expect(offeredOptions(req)).toEqual({ allowOnce: "opt-allow_once", rejectOnce: "opt-reject_once" });
    expect(rejectLocally(req)).toEqual(selected("reject_once"));
  });

  test("persistent kinds alone offer nothing", () => {
    expect(offeredOptions(request(["allow_always", "reject_always"]))).toEqual({});
    expect(rejectLocally(request(["allow_always", "reject_always"]))).toEqual(CANCELLED);
  });

  test("malformed options are ignored, not thrown on", () => {
    const malformed: RequestPermissionRequest = JSON.parse(
      '{"sessionId":"s","toolCall":{"toolCallId":"t"},"options":[null,{"kind":"reject_once","optionId":7},{"kind":"allow_once","optionId":""}]}',
    );
    expect(offeredOptions(malformed)).toEqual({});
    const noList: RequestPermissionRequest = JSON.parse('{"sessionId":"s","toolCall":null,"options":null}');
    expect(rejectLocally(noList)).toEqual(CANCELLED);
  });
});

describe("decidePermission: an aborted signal (D3-d, spec §6.4 expiry)", () => {
  test.each(["none", "read", "ask", "full"] as const)("%s: cancelled, no event, nobody asked", async (profile) => {
    const { port, seen } = asks();
    const aborted = new AbortController();
    aborted.abort();
    expect(
      await decidePermission(request(["allow_once", "reject_once"]), ctx(profile, port, aborted.signal)),
    ).toEqual(CANCELLED);
    expect(seen.auto).toEqual([]);
    expect(seen.asked).toEqual([]);
  });
});

describe("decidePermission: none and read (spec §6.4)", () => {
  test.each(["none", "read"] as const)("%s rejects with a profile decision", async (profile) => {
    const { port, seen } = asks();
    expect(await decidePermission(request(["allow_once", "reject_once"]), ctx(profile, port))).toEqual(
      selected("reject_once"),
    );
    expect(seen.asked).toEqual([]);
    expect(seen.auto).toEqual([
      {
        req: { callId: "t-1", tool: "edit", summary: "Edit a.ts", reason: readOnlyReason(profile) },
        decision: "deny",
      },
    ]);
  });

  test("read rejects Claude's request to leave plan mode (switch_mode)", async () => {
    const { port } = asks();
    const exitPlan = request(["allow_always", "allow_once", "reject_once"], {
      toolCallId: "t-2",
      kind: "switch_mode",
      title: "Ready to code?",
    });
    expect(await decidePermission(exitPlan, ctx("read", port))).toEqual(selected("reject_once"));
  });

  test("without reject_once: cancelled, still recorded as a deny", async () => {
    const { port, seen } = asks();
    expect(await decidePermission(request(["allow_once"]), ctx("none", port))).toEqual(CANCELLED);
    expect(seen.auto.map((a) => a.decision)).toEqual(["deny"]);
  });
});

describe("decidePermission: full", () => {
  test("allow_once with a profile decision; allow_always never chosen", async () => {
    const { port, seen } = asks();
    expect(
      await decidePermission(request(["allow_always", "allow_once", "reject_once"]), ctx("full", port)),
    ).toEqual(selected("allow_once"));
    expect(seen.auto).toEqual([
      { req: { callId: "t-1", tool: "edit", summary: "Edit a.ts", reason: FULL_REASON }, decision: "allow" },
    ]);
  });

  test("no allow_once offered: denied with reject_once and the reason recorded", async () => {
    const { port, seen } = asks();
    expect(await decidePermission(request(["allow_always", "reject_once"]), ctx("full", port))).toEqual(
      selected("reject_once"),
    );
    expect(seen.auto[0]).toMatchObject({ req: { reason: NO_ALLOW_ONCE_REASON }, decision: "deny" });
  });
});

describe("decidePermission: ask", () => {
  test("the caller allows: allow_once; the request carries the display fields and the signal", async () => {
    const { port, seen } = asks();
    const signal = new AbortController().signal;
    const runTests = request(["allow_once", "reject_once"], {
      toolCallId: "t-3",
      kind: "execute",
      title: "Run tests",
      rawInput: { command: "bun test ./x" },
    });
    expect(await decidePermission(runTests, ctx("ask", port, signal))).toEqual(selected("allow_once"));
    expect(seen.asked).toEqual([
      {
        callId: "t-3",
        tool: "execute",
        summary: "Run tests",
        command: "bun test ./x",
        reason: ASK_REASON,
        signal,
      },
    ]);
    expect(seen.auto).toEqual([]);
  });

  test.each([
    ["human", selected("reject_once")],
    ["timeout", selected("reject_once")],
    ["cancelled", CANCELLED],
  ] as const)("a deny decided by %s answers %o", async (decidedBy, expected) => {
    const { port } = asks(async () => ({ decision: "deny", decidedBy }));
    expect(await decidePermission(request(["allow_once", "reject_once"]), ctx("ask", port))).toEqual(expected);
  });

  test("a throwing ask port (no-turn race) answers cancelled (D3-f)", async () => {
    const { port } = asks(async () => {
      throw new Error("no turn");
    });
    expect(await decidePermission(request(["allow_once", "reject_once"]), ctx("ask", port))).toEqual(CANCELLED);
  });

  test("no allow_once offered: denied without asking", async () => {
    const { port, seen } = asks();
    expect(await decidePermission(request(["reject_once"]), ctx("ask", port))).toEqual(selected("reject_once"));
    expect(seen.asked).toEqual([]);
    expect(seen.auto[0]).toMatchObject({ req: { reason: NO_ALLOW_ONCE_REASON }, decision: "deny" });
  });

  test("an unshowable request is denied without asking (D3-b)", async () => {
    const { port, seen } = asks();
    const unshowable = request(["allow_once", "reject_once"], {
      toolCallId: "t-4",
      kind: "execute",
      title: "Run",
      rawInput: { command: UNMASKABLE },
    });
    expect(await decidePermission(unshowable, ctx("ask", port))).toEqual(selected("reject_once"));
    expect(seen.asked).toEqual([]);
    expect(seen.auto[0]).toMatchObject({ req: { reason: UNSHOWABLE_REASON }, decision: "deny" });
  });
});
```

The `throw new Error` above is in a test, which `check-nax-error` does not scan (it scans `src/`). If the gate flags it, throw `new NaxError("no turn", "AGENT_SESSION_TURN_FAILED")` imported from `@nathapp/nax-agent` instead.

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun test ./test/unit/client/permissions.test.ts`
Expected: FAIL, cannot resolve `#src/client/permissions`.

- [ ] **Step 3: Implement `permissions.ts`**

```ts
/**
 * session/request_permission by profile (S4 spec §6.4 layer 2). none and read
 * reject every request; full allows it; ask puts it in front of the caller through
 * asks.requestApproval and answer(). Only options the agent offered are chosen,
 * and only the *_once kinds: allow_always would outlive the session. Auto-decisions
 * are recorded with decidedBy "profile". Fail closed: a deny or deadline answers
 * reject_once; a turn abort, process death or ask-port failure answers
 * `cancelled`. Embedder tools never get here: they are pre-approved (S4-4).
 */
import type { RequestPermissionRequest, RequestPermissionResponse } from "@agentclientprotocol/sdk";
import type { AgentSessionProfile, SessionAskPort } from "@nathapp/nax-agent";
import { isRecord } from "#src/client/text";
import { describeToolCall, type ToolCallDisplay } from "#src/client/tool-display";

export const NO_ALLOW_ONCE_REASON = "agent offered no allow-once option";
export const UNSHOWABLE_REASON = "the request could not be shown safely";
export const ASK_REASON = "the ACP agent asks permission";
export const FULL_REASON = 'profile "full" allows every permission request';
export const UNKNOWN_PROFILE_REASON = "unknown profile";

export function readOnlyReason(profile: AgentSessionProfile): string {
  return `profile "${profile}" rejects every permission request`;
}

export interface PermissionContext {
  readonly profile: AgentSessionProfile;
  readonly asks: SessionAskPort;
  readonly secrets: readonly string[];
  /** Aborts when the turn's binding is released or the agent process exits (D3-d). */
  readonly signal: AbortSignal;
}

export interface OfferedOptions {
  readonly allowOnce?: string;
  readonly rejectOnce?: string;
}

function optionIdOf(options: readonly unknown[], kind: string): string | undefined {
  const found = options.find(
    (option) => isRecord(option) && option.kind === kind && typeof option.optionId === "string" && option.optionId !== "",
  );
  return isRecord(found) && typeof found.optionId === "string" ? found.optionId : undefined;
}

export function offeredOptions(request: RequestPermissionRequest): OfferedOptions {
  const options: readonly unknown[] = Array.isArray(request.options) ? request.options : [];
  const allowOnce = optionIdOf(options, "allow_once");
  const rejectOnce = optionIdOf(options, "reject_once");
  return {
    ...(allowOnce === undefined ? {} : { allowOnce }),
    ...(rejectOnce === undefined ? {} : { rejectOnce }),
  };
}

const cancelled = (): RequestPermissionResponse => ({ outcome: { outcome: "cancelled" } });
const selected = (optionId: string): RequestPermissionResponse => ({ outcome: { outcome: "selected", optionId } });

/** A deny: the agent's reject_once, or `cancelled` when it offered none. */
export function rejectWith(offered: OfferedOptions): RequestPermissionResponse {
  return offered.rejectOnce === undefined ? cancelled() : selected(offered.rejectOnce);
}

/** The answer to a request outside the running turn (spec §6.3): a deny, never an event. */
export function rejectLocally(request: RequestPermissionRequest): RequestPermissionResponse {
  return rejectWith(offeredOptions(request));
}

type AutoDecide = (reason: string, decision: "allow" | "deny") => void;

function eventFields(display: ToolCallDisplay) {
  return {
    ...(display.callId === undefined ? {} : { callId: display.callId }),
    tool: display.tool,
    summary: display.summary,
  };
}

export async function decidePermission(
  request: RequestPermissionRequest,
  ctx: PermissionContext,
): Promise<RequestPermissionResponse> {
  // The turn was cancelled, timed out or lost its process: nothing is decided, no event (D3-d).
  if (ctx.signal.aborted) return cancelled();
  const offered = offeredOptions(request);
  const display = describeToolCall(request.toolCall, ctx.secrets);
  const auto: AutoDecide = (reason, decision) =>
    ctx.asks.recordAutoDecision({ ...eventFields(display), reason }, decision);
  switch (ctx.profile) {
    case "none":
    case "read":
      auto(readOnlyReason(ctx.profile), "deny");
      return rejectWith(offered);
    case "full":
      if (offered.allowOnce === undefined) return denyNoAllowOnce(offered, auto);
      auto(FULL_REASON, "allow");
      return selected(offered.allowOnce);
    case "ask":
      if (offered.allowOnce === undefined) return denyNoAllowOnce(offered, auto);
      if (!display.showable) {
        auto(UNSHOWABLE_REASON, "deny");
        return rejectWith(offered);
      }
      return askCaller(display, offered.allowOnce, offered, ctx);
    default:
      // A profile this build does not know: fail closed.
      auto(UNKNOWN_PROFILE_REASON, "deny");
      return rejectWith(offered);
  }
}

function denyNoAllowOnce(offered: OfferedOptions, auto: AutoDecide): RequestPermissionResponse {
  auto(NO_ALLOW_ONCE_REASON, "deny");
  return rejectWith(offered);
}

async function askCaller(
  display: ToolCallDisplay,
  allowOnce: string,
  offered: OfferedOptions,
  ctx: PermissionContext,
): Promise<RequestPermissionResponse> {
  try {
    const answer = await ctx.asks.requestApproval({
      ...eventFields(display),
      ...(display.command === undefined ? {} : { command: display.command }),
      reason: ASK_REASON,
      signal: ctx.signal,
    });
    if (answer.decision === "allow") return selected(allowOnce);
    return answer.decidedBy === "cancelled" ? cancelled() : rejectWith(offered);
  } catch {
    // The turn ended between routing and asking (the port's "no-turn"): fail closed (D3-f).
    return cancelled();
  }
}
```

- [ ] **Step 4: Run the tests, typecheck and lint**

Run:
```bash
bun test ./test/unit/client/permissions.test.ts
bun run typecheck
bun run lint:fix && bun run check:all
```
Expected: PASS, and both commands exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/client/permissions.ts test/unit/client/permissions.test.ts
git commit -m "feat(nax-agent-acp): S4-3 permission decisions by profile (spec 6.4)"
```

---

### Task 3: Inbound routing of permission requests

**Files:**
- Modify: `packages/nax-agent-acp/src/client/inbound.ts` (whole file)
- Modify: `packages/nax-agent-acp/src/client/backend.ts:23,63,114-120` (interim wiring, so this task's commit typechecks)
- Modify: `packages/nax-agent-acp/test/unit/client/inbound.test.ts` (whole file)
- Modify: `packages/nax-agent-acp/test/unit/client/open.test.ts` (import, and 4 `createInboundRouter()` call sites)
- Modify: `packages/nax-agent-acp/test/unit/client/connection.test.ts` (the `rejectLocally` import)

**Interfaces:**
- Consumes: `rejectLocally` (Task 2); `getLogger` from `@nathapp/nax-agent` (Task 0); `TurnCollector` (S4-2 `events.ts`); `InboundHandlers` (S4-2 `connection.ts`).
- Produces:
  - `type PermissionDecider = (request: RequestPermissionRequest, signal: AbortSignal) => Promise<RequestPermissionResponse>`
  - `MAX_PENDING_DECISIONS = 16`
  - `createInboundRouter(decide: PermissionDecider): InboundRouter`
  - `InboundRouter.attach(agentSessionId: string, collector: TurnCollector, turnSignal: AbortSignal): () => Promise<void>`. It gains the `turnSignal` parameter, and the release now returns a promise (it was a void function in S4-2).

- [ ] **Step 1: Rewrite the router tests (failing)**

Replace `test/unit/client/inbound.test.ts` with:

```ts
import { afterEach, describe, expect, test } from "bun:test";
import type {
  PermissionOptionKind,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import { type AgentLogger, setAgentLogger } from "@nathapp/nax-agent";
import { createTurnCollector } from "#src/client/events";
import { createInboundRouter, MAX_PENDING_DECISIONS, type PermissionDecider } from "#src/client/inbound";

const IDLE = new AbortController().signal;

function request(sessionId: string, kinds: readonly PermissionOptionKind[] = ["allow_once", "reject_once"]) {
  const req: RequestPermissionRequest = {
    sessionId,
    toolCall: { toolCallId: "t" },
    options: kinds.map((kind) => ({ optionId: `opt-${kind}`, name: kind, kind })),
  };
  return req;
}

const text = (t: string) => ({
  sessionUpdate: "agent_message_chunk" as const,
  content: { type: "text" as const, text: t },
});

const ALLOW: RequestPermissionResponse = { outcome: { outcome: "selected", optionId: "opt-allow_once" } };
const REJECT: RequestPermissionResponse = { outcome: { outcome: "selected", optionId: "opt-reject_once" } };
const CANCELLED: RequestPermissionResponse = { outcome: { outcome: "cancelled" } };

function recordingDecider(answer: (signal: AbortSignal) => Promise<RequestPermissionResponse> = async () => ALLOW) {
  const seen: AbortSignal[] = [];
  const decide: PermissionDecider = (_request, signal) => {
    seen.push(signal);
    return answer(signal);
  };
  return { decide, seen };
}

/** A decider that answers `cancelled` once its signal aborts, and never before. */
const untilAborted = (signal: AbortSignal) =>
  new Promise<RequestPermissionResponse>((resolve) => {
    signal.addEventListener("abort", () => resolve(CANCELLED));
  });

function recordingLogger(): { logger: AgentLogger; warnings: { message: string; data: unknown }[] } {
  const warnings: { message: string; data: unknown }[] = [];
  const ignore = () => {};
  return {
    warnings,
    logger: {
      error: ignore,
      info: ignore,
      debug: ignore,
      warn: (_stage, message, data) => {
        warnings.push({ message, data });
      },
    },
  };
}

afterEach(() => {
  setAgentLogger(null);
});

describe("createInboundRouter: updates", () => {
  test("routes updates for the attached session only, and only while attached", async () => {
    const router = createInboundRouter(recordingDecider().decide);
    const collector = createTurnCollector(undefined);
    router.handlers.onUpdate({ sessionId: "a", update: text("before") });
    const release = router.attach("a", collector, IDLE);
    router.handlers.onUpdate({ sessionId: "a", update: text("mine") });
    router.handlers.onUpdate({ sessionId: "b", update: text("theirs") });
    await release();
    router.handlers.onUpdate({ sessionId: "a", update: text("after") });
    expect(collector.output()).toBe("mine");
  });

  test("releasing a stale binding does not detach a newer one", async () => {
    const router = createInboundRouter(recordingDecider().decide);
    const first = createTurnCollector(undefined);
    const second = createTurnCollector(undefined);
    const releaseFirst = router.attach("a", first, IDLE);
    router.attach("a", second, IDLE);
    await releaseFirst();
    router.handlers.onUpdate({ sessionId: "a", update: text("x") });
    expect(second.output()).toBe("x");
  });
});

describe("createInboundRouter: permission requests (spec §6.3, §6.4, D3-c, D3-d)", () => {
  test("during a turn, for the attached session: the decider answers", async () => {
    const { decide, seen } = recordingDecider();
    const router = createInboundRouter(decide);
    const release = router.attach("a", createTurnCollector(undefined), IDLE);
    expect(await router.handlers.onPermission(request("a"))).toEqual(ALLOW);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.aborted).toBe(false);
    await release();
  });

  test("no turn: rejected locally, logged once per reason; the decider is not called", async () => {
    const { logger, warnings } = recordingLogger();
    setAgentLogger(logger);
    const { decide, seen } = recordingDecider();
    const router = createInboundRouter(decide);
    expect(await router.handlers.onPermission(request("a"))).toEqual(REJECT);
    expect(await router.handlers.onPermission(request("a", ["allow_once"]))).toEqual(CANCELLED);
    expect(seen).toHaveLength(0);
    expect(warnings.map((w) => w.data)).toEqual([{ reason: "no-turn" }]);
  });

  test("another agent session during a turn: rejected locally and logged", async () => {
    const { logger, warnings } = recordingLogger();
    setAgentLogger(logger);
    const { decide, seen } = recordingDecider();
    const router = createInboundRouter(decide);
    const release = router.attach("a", createTurnCollector(undefined), IDLE);
    expect(await router.handlers.onPermission(request("b"))).toEqual(REJECT);
    expect(seen).toHaveLength(0);
    expect(warnings.map((w) => w.data)).toEqual([{ reason: "foreign-session" }]);
    await release();
  });

  test("a throwing host logger does not change the answer", async () => {
    const { logger } = recordingLogger();
    setAgentLogger({
      ...logger,
      warn: () => {
        throw new Error("logger down");
      },
    });
    const router = createInboundRouter(recordingDecider().decide);
    expect(await router.handlers.onPermission(request("a"))).toEqual(REJECT);
  });

  test("the turn signal reaches the decision: an aborted turn hands the decider an aborted signal", async () => {
    const { decide, seen } = recordingDecider();
    const router = createInboundRouter(decide);
    const turn = new AbortController();
    const release = router.attach("a", createTurnCollector(undefined), turn.signal);
    turn.abort();
    await router.handlers.onPermission(request("a"));
    expect(seen[0]?.aborted).toBe(true);
    await release();
  });

  test("release aborts pending decisions and resolves only after they are answered", async () => {
    const state = { answered: false };
    const { decide, seen } = recordingDecider(
      (signal) =>
        new Promise((resolve) => {
          signal.addEventListener("abort", () =>
            setTimeout(() => {
              state.answered = true;
              resolve(CANCELLED);
            }, 20),
          );
        }),
    );
    const router = createInboundRouter(decide);
    const release = router.attach("a", createTurnCollector(undefined), IDLE);
    const response = router.handlers.onPermission(request("a"));
    await Promise.resolve();
    expect(seen[0]?.aborted).toBe(false);
    await release();
    expect(seen[0]?.aborted).toBe(true);
    expect(state.answered).toBe(true);
    expect(await response).toEqual(CANCELLED);
  });

  test("beyond MAX_PENDING_DECISIONS concurrent requests, the extra ones are rejected locally", async () => {
    const { logger, warnings } = recordingLogger();
    setAgentLogger(logger);
    const { decide, seen } = recordingDecider(untilAborted);
    const router = createInboundRouter(decide);
    const release = router.attach("a", createTurnCollector(undefined), IDLE);
    const pending = Array.from({ length: MAX_PENDING_DECISIONS }, () => router.handlers.onPermission(request("a")));
    expect(await router.handlers.onPermission(request("a"))).toEqual(REJECT);
    expect(seen).toHaveLength(MAX_PENDING_DECISIONS);
    expect(warnings.map((w) => w.data)).toEqual([{ reason: "too-many" }]);
    await release();
    expect(await Promise.all(pending)).toEqual(Array.from({ length: MAX_PENDING_DECISIONS }, () => CANCELLED));
  });

  test("a throwing decider answers cancelled", async () => {
    const router = createInboundRouter(async () => {
      throw new Error("boom");
    });
    const release = router.attach("a", createTurnCollector(undefined), IDLE);
    expect(await router.handlers.onPermission(request("a"))).toEqual(CANCELLED);
    await release();
  });
});
```

The test-file `throw new Error` lines are fine: `check-nax-error` scans `src/` only.

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun test ./test/unit/client/inbound.test.ts`
Expected: FAIL. `MAX_PENDING_DECISIONS` is not exported, the S4-2 router never calls the decider, and its `release()` returns `undefined`.

- [ ] **Step 3: Rewrite `inbound.ts`**

```ts
/**
 * Messages the agent initiates (S4 spec §6.3, §6.4). While a turn runs the router
 * holds one binding: the agent session the turn prompts, its collector and its
 * signal. session/update reaches that collector only when it names the bound
 * session; anything else is dropped. session/request_permission for the bound
 * session goes to the backend's decider with the binding's signal, which aborts
 * when the turn is cancelled, times out or loses its process, and when the binding
 * is released (D3-d). Any other request (no turn, another session, more than
 * MAX_PENDING_DECISIONS at once) is rejected locally and raises no event; each
 * reason is logged once per session (D3-c). Releasing a binding aborts its pending
 * decisions and waits for their answers, so approval_resolved always precedes
 * turn_end.
 */
import type { RequestPermissionRequest, RequestPermissionResponse } from "@agentclientprotocol/sdk";
import { getLogger } from "@nathapp/nax-agent";
import type { InboundHandlers } from "#src/client/connection";
import type { TurnCollector } from "#src/client/events";
import { rejectLocally } from "#src/client/permissions";

/** Concurrent permission decisions one turn may hold; further requests are rejected locally. */
export const MAX_PENDING_DECISIONS = 16;

export type PermissionDecider = (
  request: RequestPermissionRequest,
  signal: AbortSignal,
) => Promise<RequestPermissionResponse>;

export interface InboundRouter {
  readonly handlers: InboundHandlers;
  /**
   * Routes `agentSessionId`'s updates and permission requests to this turn.
   * `turnSignal` aborts the turn's decisions (cancel, timeout, process gone). The
   * returned function detaches the turn, aborts its pending permission decisions
   * and resolves once each has been answered.
   */
  attach(agentSessionId: string, collector: TurnCollector, turnSignal: AbortSignal): () => Promise<void>;
}

type Rejection = "no-turn" | "foreign-session" | "too-many";

interface Binding {
  readonly sessionId: string;
  readonly collector: TurnCollector;
  readonly scope: AbortController;
  /** The scope and the turn signal: what every decision of this turn is given. */
  readonly signal: AbortSignal;
  readonly pending: Set<Promise<RequestPermissionResponse>>;
}

const cancelled = (): RequestPermissionResponse => ({ outcome: { outcome: "cancelled" } });

async function decideInTurn(
  binding: Binding,
  decide: PermissionDecider,
  request: RequestPermissionRequest,
): Promise<RequestPermissionResponse> {
  const answer = decide(request, binding.signal).catch(cancelled);
  binding.pending.add(answer);
  try {
    return await answer;
  } finally {
    binding.pending.delete(answer);
  }
}

export function createInboundRouter(decide: PermissionDecider): InboundRouter {
  let active: Binding | undefined;
  const logged = new Set<Rejection>();
  const reject = (request: RequestPermissionRequest, reason: Rejection): RequestPermissionResponse => {
    if (!logged.has(reason)) {
      logged.add(reason);
      try {
        getLogger().warn("acp", "Rejected a permission request locally", { reason });
      } catch {
        // A throwing host logger must not change the answer.
      }
    }
    return rejectLocally(request);
  };
  return {
    handlers: {
      onUpdate(notification) {
        if (active !== undefined && notification.sessionId === active.sessionId) {
          active.collector.onUpdate(notification.update);
        }
      },
      onPermission: async (request) => {
        const binding = active;
        if (binding === undefined) return reject(request, "no-turn");
        if (request.sessionId !== binding.sessionId) return reject(request, "foreign-session");
        if (binding.pending.size >= MAX_PENDING_DECISIONS) return reject(request, "too-many");
        return decideInTurn(binding, decide, request);
      },
    },
    attach(sessionId, collector, turnSignal) {
      const scope = new AbortController();
      const binding: Binding = {
        sessionId,
        collector,
        scope,
        signal: AbortSignal.any([scope.signal, turnSignal]),
        pending: new Set(),
      };
      active = binding;
      return async () => {
        if (active === binding) active = undefined;
        scope.abort();
        await Promise.allSettled([...binding.pending]);
      };
    },
  };
}
```

`decideInTurn` adds to `pending` synchronously (before its first `await`), so the cap counts every request already being decided.

- [ ] **Step 4: Update the callers (interim wiring in `backend.ts`)**

- In `test/unit/client/connection.test.ts`, change `import { rejectLocally } from "#src/client/inbound";` to `import { rejectLocally } from "#src/client/permissions";`.
- In `test/unit/client/open.test.ts`:
  - add `import { rejectLocally } from "#src/client/permissions";`
  - replace each `createInboundRouter().handlers` (4 sites: lines 46, 90, 163, 178) with `createInboundRouter(async (r) => rejectLocally(r)).handlers`
- In `src/client/backend.ts`, keep S4-2's behaviour (every permission rejected locally) on the new router API. Task 4 replaces this decider.
  - add `import { rejectLocally } from "#src/client/permissions";`
  - change `const router = createInboundRouter();` to `const router = createInboundRouter(async (request) => rejectLocally(request));`
  - in `sendTurn`, compute the signal once and hand it to the router, and await the release:

```ts
  const collector = createTurnCollector(opts.onTurnEvent);
  const signal = opts.signal ?? ctx.turnSignal();
  const release = live.router.attach(live.acp.agentSessionId, collector, signal);
  try {
    return await runPromptTurn(live.state, { text, signal, collector });
  } finally {
    await release();
  }
```

- [ ] **Step 5: Run the router, connection, open and backend tests, typecheck and lint**

Run:
```bash
bun test ./test/unit/client/inbound.test.ts ./test/unit/client/connection.test.ts ./test/unit/client/open.test.ts ./test/unit/client/backend.test.ts
bun run typecheck
bun run lint:fix && bun run check:all
```
Expected: PASS, and both commands exit 0. `backend.test.ts` is unchanged here; its S4-2 D-d test still sees `reject_once` and no events.

- [ ] **Step 6: Commit**

```bash
git add src/client/inbound.ts src/client/backend.ts test/unit/client/inbound.test.ts test/unit/client/open.test.ts test/unit/client/connection.test.ts
git commit -m "feat(nax-agent-acp): S4-3 route permission requests by turn and session"
```

---

### Task 4: `acpBackend()` with all four profiles, end to end in process

**Files:**
- Modify: `packages/nax-agent-acp/src/client/backend.ts` (header, imports, `refuseUnbuilt`, `openBackend`, `Live`, `sendTurn`)
- Modify: `packages/nax-agent-acp/test/fixtures/fake-agent/script.ts:19-33`
- Modify: `packages/nax-agent-acp/test/fixtures/fake-agent/agent.ts:23-104`
- Modify: `packages/nax-agent-acp/test/helpers/in-memory-launch.ts`
- Create: `packages/nax-agent-acp/test/helpers/session-events.ts`
- Create: `packages/nax-agent-acp/test/unit/client/backend-permissions.test.ts`
- Modify: `packages/nax-agent-acp/test/unit/client/backend.test.ts` (remove superseded tests)

**Interfaces:**
- Consumes:
  - `createInboundRouter(decide)`, `PermissionDecider`, and `attach(agentSessionId, collector, turnSignal)` (Task 3)
  - `decidePermission`, the reason constants and `readOnlyReason` (Task 2)
- Produces:
  - `InMemoryAgent.crash(code?: number): void`
  - in the fake's script: an exported `PermissionStep` with `toolCall?`, `sessionId?` and `detached?`, plus the steps `{ kind: "settled" }` and `{ kind: "awaitCancel" }`
  - fake records `permission-answer` `{ toolCallId, outcome }` and `permission-error` `{ toolCallId, message }`
  - `test/helpers/session-events.ts`: `driveTurn(session, message, onEvent?)`, `endOf(events)`, `indexOfType(events, type)`

- [ ] **Step 1: Extend the fake agent**

In `test/fixtures/fake-agent/script.ts`:
- Add `ToolCallUpdate` to the SDK type import.
- In `FakeStep`, replace the `permission` member with `| PermissionStep`, and add two members:

```ts
  /** Waits until every detached permission request of this prompt has been answered. */
  | { readonly kind: "settled" }
  /** Waits for session/cancel, then carries on with the next step (waitForCancel stops the turn instead). */
  | { readonly kind: "awaitCancel" }
```

- Add:

```ts
/** session/request_permission with one option per kind (optionId "opt-<kind>"). */
export interface PermissionStep {
  readonly kind: "permission";
  readonly options: readonly PermissionOptionKind[];
  /** Overrides the default tool call { toolCallId: "fake-permission", title: "Edit a file", kind: "edit" }. */
  readonly toolCall?: Partial<Pick<ToolCallUpdate, "toolCallId" | "title" | "kind" | "rawInput" | "locations">>;
  /** Addresses another session (routing tests). */
  readonly sessionId?: string;
  /** Sent without waiting for the answer; the answer is still recorded. */
  readonly detached?: boolean;
}
```

In `test/fixtures/fake-agent/agent.ts`:
- Import the `PermissionStep` type from `./script.ts`.
- Give `PromptState` a list of detached answers:

```ts
interface PromptState {
  readonly cancelled: Promise<void>;
  readonly markCancelled: () => void;
  /** Detached permission requests of this prompt, settled when answered. */
  readonly detached: Promise<void>[];
}

function newPromptState(): PromptState {
  let mark: () => void = () => {};
  const cancelled = new Promise<void>((resolve) => {
    mark = resolve;
  });
  return { cancelled, markCancelled: () => mark(), detached: [] };
}
```

- In `runStep`, replace the `case "permission": { ... }` block and add the two new cases:

```ts
    case "permission":
      await requestPermission(step, sessionId, client, state, hooks);
      return undefined;
    case "settled":
      await Promise.all(state.detached);
      return undefined;
    case "awaitCancel":
      await state.cancelled;
      return undefined;
```

- Add the function:

```ts
async function requestPermission(
  step: PermissionStep,
  sessionId: string,
  client: AgentContext,
  state: PromptState,
  hooks: FakeHooks,
): Promise<void> {
  const toolCallId = step.toolCall?.toolCallId ?? "fake-permission";
  const answered = client
    .request(methods.client.session.requestPermission, {
      sessionId: step.sessionId ?? sessionId,
      toolCall: { toolCallId: "fake-permission", title: "Edit a file", kind: "edit", status: "pending", ...step.toolCall },
      options: step.options.map((kind): PermissionOption => ({ optionId: `opt-${kind}`, name: kind, kind })),
    })
    .then(
      (response) => {
        hooks.record("permission-outcome", response.outcome);
        hooks.record("permission-answer", { toolCallId, outcome: response.outcome });
      },
      (error: unknown) => {
        hooks.record("permission-error", { toolCallId, message: String(error) });
      },
    );
  if (step.detached === true) {
    state.detached.push(answered);
    return;
  }
  await answered;
}
```

In `test/helpers/in-memory-launch.ts`:
- Add `crash(code?: number): void;` to `InMemoryAgent`.
- Keep the latest launch's `end` in an outer `let endLatest: (exit: AgentExit) => void = () => {};`. Set it inside `launch` after `end` is created (`endLatest = end;`).
- Return `crash: (code = 1) => endLatest({ code, signal: null })`.

- [ ] **Step 2: Add the facade-level event helpers**

`test/helpers/session-events.ts`:

```ts
/** Driving a facade session's turn and reading its events, for backend tests. */
import type { AgentSession, SessionEvent } from "@nathapp/nax-agent";

/** Runs one turn; `onEvent` sees each event as it arrives (answer or cancel from it). */
export async function driveTurn(
  session: AgentSession,
  message: string,
  onEvent: (event: SessionEvent) => void = () => {},
): Promise<SessionEvent[]> {
  const events: SessionEvent[] = [];
  for await (const event of session.send(message)) {
    events.push(event);
    onEvent(event);
  }
  return events;
}

export function endOf(events: readonly SessionEvent[]) {
  const last = events.at(-1);
  if (last?.type !== "turn_end") throw new Error("the turn did not end");
  return last;
}

export function indexOfType(events: readonly SessionEvent[], type: SessionEvent["type"]): number {
  return events.findIndex((event) => event.type === type);
}
```

- [ ] **Step 3: Write the failing end-to-end tests**

`test/unit/client/backend-permissions.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  type AgentSession,
  type AgentSessionProfile,
  createAgentSession,
  createMemoryTranscriptStore,
  type SessionEvent,
} from "@nathapp/nax-agent";
import { cleanupTempDir, makeTempDir } from "@nathapp/nax-test-kit/bun/temp";
import { waitForCondition } from "@nathapp/nax-test-kit/bun/timeout";
import { _acpBackendDeps, acpBackend } from "#src/client/backend";
import type { AcpBackendOptions } from "#src/client/options";
import { ASK_REASON, FULL_REASON, NO_ALLOW_ONCE_REASON, readOnlyReason } from "#src/client/permissions";
import {
  CLAUDE_CONFIG_OPTIONS,
  type FakeScript,
  type FakeStep,
  type PermissionStep,
} from "#test/fixtures/fake-agent/script";
import { rejection, sessionError } from "#test/helpers/errors";
import { type InMemoryAgent, inMemoryAgent } from "#test/helpers/in-memory-launch";
import { driveTurn, endOf, indexOfType } from "#test/helpers/session-events";

const realLaunch = _acpBackendDeps.launch;
const SECRET = "s3cr3t-token-value-0123";
const sessions: AgentSession[] = [];
let workdir: string;

beforeEach(() => {
  workdir = makeTempDir("acp-perm-");
});

afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close().catch(() => undefined);
  _acpBackendDeps.launch = realLaunch;
  cleanupTempDir(workdir);
});

interface Opened {
  readonly fake: InMemoryAgent;
  readonly session: AgentSession;
}

async function open(
  profile: AgentSessionProfile,
  steps: readonly FakeStep[],
  backend: Partial<AcpBackendOptions> = {},
  script: FakeScript = {},
): Promise<Opened> {
  const fake = inMemoryAgent({
    agentInfo: { name: "claude-agent-acp", version: "0.85.1" },
    configOptions: CLAUDE_CONFIG_OPTIONS,
    turns: [{ steps }],
    ...script,
  });
  _acpBackendDeps.launch = fake.launch;
  const session = await createAgentSession({
    backend: acpBackend({ agent: "claude", allowUnsandboxed: true, command: "fake-claude", ...backend }),
    profile,
    ...(profile === "none" ? {} : { workdir }),
    transcriptStore: createMemoryTranscriptStore(),
    sessionId: "s-1",
  });
  sessions.push(session);
  return { fake, session };
}

const EDIT: PermissionStep = { kind: "permission", options: ["allow_once", "reject_once"] };
const RUN_TESTS: PermissionStep = {
  kind: "permission",
  options: ["allow_once", "reject_once"],
  toolCall: { kind: "execute", title: "Run tests", rawInput: { command: "bun test ./x" } },
};
const answers = (o: Opened) => o.fake.callsTo("permission-outcome");
const types = (events: readonly SessionEvent[]) => events.map((e) => e.type);
const find = (events: readonly SessionEvent[], type: SessionEvent["type"]) => events.find((e) => e.type === type);
const approvals = (events: readonly SessionEvent[]) => events.filter((e) => e.type.startsWith("approval_"));

describe("profiles none and read (spec §6.4)", () => {
  test("read: plan mode; every request rejected with a profile decision", async () => {
    const o = await open("read", [EDIT, { kind: "text", text: "done" }]);
    expect(o.fake.callsTo("session/set_config_option")).toEqual([
      { sessionId: "fake-session-1", configId: "mode", value: "plan" },
    ]);
    const events = await driveTurn(o.session, "edit it");
    expect(answers(o)).toEqual([{ outcome: "selected", optionId: "opt-reject_once" }]);
    expect(types(events)).toEqual(["turn_start", "approval_requested", "approval_resolved", "text_delta", "turn_end"]);
    expect(find(events, "approval_requested")).toMatchObject({
      callId: "fake-permission",
      tool: "edit",
      summary: "Edit a file",
      reason: readOnlyReason("read"),
    });
    expect(find(events, "approval_resolved")).toMatchObject({ decision: "deny", decidedBy: "profile" });
    expect(endOf(events).status).toBe("completed");
  });

  test("none, no workdir: plan mode in a scratch root; leaving plan mode (switch_mode) is rejected", async () => {
    const o = await open("none", [
      {
        kind: "permission",
        options: ["allow_always", "allow_once", "reject_once"],
        toolCall: { kind: "switch_mode", title: "Ready to code?" },
      },
    ]);
    expect(typeof o.fake.requests[0]?.cwd).toBe("string");
    expect(o.fake.callsTo("session/set_config_option")).toEqual([
      { sessionId: "fake-session-1", configId: "mode", value: "plan" },
    ]);
    await driveTurn(o.session, "plan only");
    expect(answers(o)).toEqual([{ outcome: "selected", optionId: "opt-reject_once" }]);
  });

  test.each(["read", "none"] as const)(
    "%s on an agent without a read-only mode: refused after initialize",
    async (profile) => {
      const fake = inMemoryAgent({});
      _acpBackendDeps.launch = fake.launch;
      const err = sessionError(
        await rejection(
          createAgentSession({
            backend: acpBackend({ agent: "codex", allowUnsandboxed: true, command: "fake-codex" }),
            profile,
            ...(profile === "none" ? {} : { workdir }),
            transcriptStore: createMemoryTranscriptStore(),
          }),
        ),
      );
      expect(err.code).toBe("AGENT_SESSION_CAPABILITY_UNSUPPORTED");
      expect(err.context).toMatchObject({ capability: "profile" });
      expect(fake.callsTo("initialize")).toHaveLength(1);
      expect(fake.callsTo("session/new")).toEqual([]);
      expect(fake.kills()).toBe(1);
    },
  );
});

describe("profile full", () => {
  test("default mode; allow_once with a profile decision; secrets scrubbed from the summary", async () => {
    const o = await open(
      "full",
      [
        {
          kind: "permission",
          options: ["allow_always", "allow_once", "reject_once"],
          toolCall: { title: `cat ${SECRET}` },
        },
      ],
      { env: { MY_TOKEN: SECRET } },
    );
    expect(o.fake.callsTo("session/set_config_option")).toEqual([
      { sessionId: "fake-session-1", configId: "mode", value: "default" },
    ]);
    const events = await driveTurn(o.session, "go");
    expect(answers(o)).toEqual([{ outcome: "selected", optionId: "opt-allow_once" }]);
    expect(find(events, "approval_requested")).toMatchObject({ summary: "cat [REDACTED]", reason: FULL_REASON });
    expect(JSON.stringify(events)).not.toContain(SECRET);
    expect(find(events, "approval_resolved")).toMatchObject({ decision: "allow", decidedBy: "profile" });
  });

  test("no allow_once offered: denied with the reason recorded", async () => {
    const o = await open("full", [{ kind: "permission", options: ["allow_always", "reject_once"] }]);
    const events = await driveTurn(o.session, "go");
    expect(answers(o)).toEqual([{ outcome: "selected", optionId: "opt-reject_once" }]);
    expect(find(events, "approval_requested")).toMatchObject({ reason: NO_ALLOW_ONCE_REASON });
    expect(find(events, "approval_resolved")).toMatchObject({ decision: "deny", decidedBy: "profile" });
  });

  test("a request sent after cancel(), inside the cancel grace window, is never allowed (D3-d)", async () => {
    const o = await open("full", [{ kind: "text", text: "started" }, { kind: "awaitCancel" }, EDIT]);
    const events = await driveTurn(o.session, "go", (event) => {
      if (event.type === "text_delta") o.session.cancel();
    });
    expect(endOf(events).status).toBe("cancelled");
    expect(answers(o)).toEqual([{ outcome: "cancelled" }]);
    expect(approvals(events)).toEqual([]);
    expect(o.fake.kills()).toBe(0);
  });
});

describe("profile ask: the caller decides through answer()", () => {
  test("allow: approval_requested carries the command; the agent gets allow_once", async () => {
    const o = await open("ask", [RUN_TESTS, { kind: "text", text: "ran" }]);
    expect(o.fake.callsTo("session/set_config_option")).toEqual([
      { sessionId: "fake-session-1", configId: "mode", value: "default" },
    ]);
    const statuses: string[] = [];
    const events = await driveTurn(o.session, "test it", (event) => {
      if (event.type === "approval_requested") statuses.push(o.session.answer(event.requestId, { decision: "allow" }));
    });
    expect(statuses).toEqual(["accepted"]);
    expect(find(events, "approval_requested")).toMatchObject({
      tool: "execute",
      summary: "Run tests",
      command: "bun test ./x",
      reason: ASK_REASON,
    });
    expect(find(events, "approval_resolved")).toMatchObject({ decision: "allow", decidedBy: "human" });
    expect(answers(o)).toEqual([{ outcome: "selected", optionId: "opt-allow_once" }]);
    expect(endOf(events)).toMatchObject({ status: "completed", output: "ran" });
  });

  test("deny: the agent gets reject_once", async () => {
    const o = await open("ask", [RUN_TESTS]);
    const events = await driveTurn(o.session, "test it", (event) => {
      if (event.type === "approval_requested") o.session.answer(event.requestId, { decision: "deny" });
    });
    expect(find(events, "approval_resolved")).toMatchObject({ decision: "deny", decidedBy: "human" });
    expect(answers(o)).toEqual([{ outcome: "selected", optionId: "opt-reject_once" }]);
  });

  test("two requests in one turn are answered independently", async () => {
    const o = await open("ask", [
      { ...RUN_TESTS, toolCall: { toolCallId: "a", kind: "edit", title: "Edit A" }, detached: true },
      { ...RUN_TESTS, toolCall: { toolCallId: "b", kind: "edit", title: "Edit B" }, detached: true },
      { kind: "settled" },
    ]);
    await driveTurn(o.session, "two", (event) => {
      if (event.type === "approval_requested") {
        o.session.answer(event.requestId, { decision: event.summary === "Edit A" ? "allow" : "deny" });
      }
    });
    expect(o.fake.callsTo("permission-answer")).toContainEqual({
      toolCallId: "a",
      outcome: { outcome: "selected", optionId: "opt-allow_once" },
    });
    expect(o.fake.callsTo("permission-answer")).toContainEqual({
      toolCallId: "b",
      outcome: { outcome: "selected", optionId: "opt-reject_once" },
    });
  });

  test("cancel while the approval is pending: the agent gets cancelled, the turn ends cancelled", async () => {
    const o = await open("ask", [RUN_TESTS, { kind: "waitForCancel" }]);
    const events = await driveTurn(o.session, "test it", (event) => {
      if (event.type === "approval_requested") o.session.cancel();
    });
    expect(find(events, "approval_resolved")).toMatchObject({ decision: "deny", decidedBy: "cancelled" });
    expect(answers(o)).toEqual([{ outcome: "cancelled" }]);
    expect(endOf(events).status).toBe("cancelled");
    expect(o.fake.kills()).toBe(0);
  });

  test("the agent ends its turn with a request unanswered: cancelled before turn_end (D3-d)", async () => {
    // The request is written to the stream before the prompt's response, so it is routed
    // while the turn is bound; the delay is margin only, not what the test relies on.
    const o = await open("ask", [{ ...RUN_TESTS, detached: true }, { kind: "delay", ms: 30 }]);
    const events = await driveTurn(o.session, "test it");
    expect(find(events, "approval_resolved")).toMatchObject({ decidedBy: "cancelled" });
    expect(indexOfType(events, "approval_resolved")).toBeLessThan(indexOfType(events, "turn_end"));
    expect(endOf(events).status).toBe("completed");
    await waitForCondition(() => answers(o).length === 1, 2_000);
    expect(answers(o)).toEqual([{ outcome: "cancelled" }]);
  });

  test("the agent process dies while the approval is pending: cancelled; the turn ends errored", async () => {
    const o = await open("ask", [RUN_TESTS, { kind: "hang" }]);
    const events = await driveTurn(o.session, "test it", (event) => {
      if (event.type === "approval_requested") o.fake.crash();
    });
    expect(find(events, "approval_resolved")).toMatchObject({ decidedBy: "cancelled" });
    expect(indexOfType(events, "approval_resolved")).toBeLessThan(indexOfType(events, "turn_end"));
    expect(endOf(events).status).toBe("errored");
  });

  test("a request naming another agent session is rejected locally, with no event", async () => {
    // No approval_* event at all proves the decider never ran: under `ask`, any decision emits one.
    const o = await open("ask", [{ ...RUN_TESTS, sessionId: "someone-else" }, { kind: "text", text: "after" }]);
    const events = await driveTurn(o.session, "test it");
    expect(answers(o)).toEqual([{ outcome: "selected", optionId: "opt-reject_once" }]);
    expect(types(events)).toEqual(["turn_start", "text_delta", "turn_end"]);
  });
});
```

The facade's ask port settles a cancelled approval with `decision: "deny"` (`askPerson`: `allowed` is false unless a human allowed; `packages/nax-agent/src/session/session-ask-link.ts:49-51`). The assertions on `decidedBy: "cancelled"` rely on that.

- [ ] **Step 4: Run it to make sure it fails**

Run: `bun test ./test/unit/client/backend-permissions.test.ts`
Expected: FAIL. `read`, `none` and `ask` are still refused with `CAPABILITY_UNSUPPORTED` (D-b), and `full` answers `reject_once` with no events (Task 3's interim decider).

- [ ] **Step 5: Wire permissions into `backend.ts`**

1. Replace the header comment with:

```ts
/**
 * acpBackend(): nax-agent's SessionBackend over ACP (S4 spec §6). It serves all
 * four profiles: the agent's mode is set at open (§6.4 layer 1), and each
 * session/request_permission is decided by profile (layer 2, permissions.ts),
 * through the caller under `ask`. A turn's decisions are cancelled when the turn
 * is cancelled, times out, ends or loses its process (D3-d). Until their stages
 * land it refuses, before spawning anything: embedder tools (S4-4) and resume
 * (S4-6). A crashed or killed agent leaves the session disconnected; reconnect is
 * S4-6, so until then later turns end AGENT_SESSION_CLOSED (D-f).
 */
```

2. Imports: replace Task 3's `import { rejectLocally } from "#src/client/permissions";` with `import { decidePermission } from "#src/client/permissions";`.

3. Replace `refuseUnbuilt`:

```ts
function refuseUnbuilt(ctx: BackendOpenContext): void {
  if (ctx.tools.length > 0) throw capabilityUnsupported("tools", "embedder tools on ACP arrive in S4-4");
  if (ctx.resume !== undefined) throw capabilityUnsupported("resume", "resuming an ACP session arrives in S4-6");
}
```

4. Add `readonly gone: AbortController;` to `interface Live`, with the doc comment `/** Aborted when the agent process exits: the running turn's permission decisions settle cancelled (§6.3 step 5). */`.

5. In `openBackend`, replace Task 3's interim router, extend the exit hook, and pass `gone` to `assemble`:

```ts
async function openBackend(options: ResolvedAcpOptions, ctx: BackendOpenContext): Promise<OpenedBackend> {
  refuseUnbuilt(ctx);
  const gone = new AbortController();
  const router = createInboundRouter((request, signal) =>
    decidePermission(request, { profile: ctx.profile, asks: ctx.asks, secrets: options.secrets, signal }),
  );
  const acp = await openAcpSession(options, ctx, router.handlers, _acpBackendDeps.launch);
  const flags: SessionFlags = { disconnected: false, closing: undefined, instructionsSent: false };
  void acp.launched.exited.then(() => {
    flags.disconnected = true;
    gone.abort();
  });
  // ... the TurnState construction stays as it is
  return assemble({ options, ctx, acp, router, flags, state, gone });
}
```

6. In `sendTurn`, combine the turn signal with `gone` once per turn (D3-d) when attaching:

```ts
  const release = live.router.attach(live.acp.agentSessionId, collector, AbortSignal.any([signal, live.gone.signal]));
```

`options.secrets` already exists on `ResolvedAcpOptions` (S4-2 D-g).

- [ ] **Step 6: Remove the superseded S4-2 tests**

In `test/unit/client/backend.test.ts`:
- Delete the test `"permission requests are answered reject_once, or cancelled without one (D-d), with no events"`. The `full` and `ask` tests in `backend-permissions.test.ts` supersede it.
- In the describe `"acpBackend: stages not built yet are refused before spawning (D-b)"`, delete `test.each(["read", "ask"] ...)` and `"profile none (no workdir) -> CAPABILITY_UNSUPPORTED profile"`. Keep the tools and resume tests.
- Remove any import the deletions leave unused (`bun run lint:biome` reports it).

- [ ] **Step 7: Run the package suite, typecheck and lint**

Run:
```bash
bun test ./test/unit/client/backend-permissions.test.ts ./test/unit/client/backend.test.ts ./test/unit/client/connection.test.ts
bun run typecheck
bun run test
bun run lint:fix && bun run check:all
```
Expected: all PASS, and every command exits 0.

Answering a permission request after the connection closed (the crash test) needs no handling in `connection.ts` (D3-j).

- [ ] **Step 8: Commit**

```bash
git add src/client/backend.ts test/fixtures/fake-agent/script.ts test/fixtures/fake-agent/agent.ts test/helpers/in-memory-launch.ts test/helpers/session-events.ts test/unit/client/backend-permissions.test.ts test/unit/client/backend.test.ts
git commit -m "feat(nax-agent-acp): S4-3 all four profiles end to end; permissions decided by profile"
```

---

### Task 5: `ask` over real processes, on Bun and on Node

**Files:**
- Modify: `packages/nax-agent-acp/test/unit/client/backend-process.test.ts`
- Modify: `packages/nax-agent-acp/test/node/acp-backend.test.ts`

**Interfaces:**
- Consumes: the subprocess fake (`FAKE_MAIN`, `fakeEnv`, `readRecords`); `PermissionStep` (Task 4); the facade's `answer()`.
- Produces: no new symbols.

This task pins one thing the in-process suite cannot. An inbound request is answered while `session/prompt` is still outstanding on the same ndjson pipe, on both runtimes.

- [ ] **Step 1: Bun subprocess test**

In `backend-process.test.ts`:
- Give `open` a third parameter, `profile: AgentSessionProfile = "full"`, and pass it to `createAgentSession`. Add `type AgentSessionProfile` to the nax-agent import.
- Add `import { driveTurn } from "#test/helpers/session-events";`.
- Add the test:

```ts
describe("profile ask over a real agent process (spec §6.4)", () => {
  test("approval_requested answered allow reaches the agent as allow_once; reject_once on deny", async () => {
    const session = await open(
      {
        turns: [
          { steps: [{ kind: "permission", options: ["allow_once", "reject_once"] }, { kind: "text", text: "one" }] },
          { steps: [{ kind: "permission", options: ["allow_once", "reject_once"] }, { kind: "text", text: "two" }] },
        ],
      },
      {},
      "ask",
    );
    let decision: "allow" | "deny" = "allow";
    const answer = (event: SessionEvent) => {
      if (event.type === "approval_requested") session.answer(event.requestId, { decision });
    };
    expect(endOf(await driveTurn(session, "first", answer)).status).toBe("completed");
    decision = "deny";
    expect(endOf(await driveTurn(session, "second", answer)).status).toBe("completed");
    const outcomes = () => readRecords(record).filter((r) => r.method === "permission-outcome");
    await waitForCondition(() => outcomes().length === 2, 5_000);
    expect(outcomes().map((r) => r.params)).toEqual([
      { outcome: "selected", optionId: "opt-allow_once" },
      { outcome: "selected", optionId: "opt-reject_once" },
    ]);
  });
});
```

The fake runs as a custom agent (`{ name: "fake", ... }`), which has no registry modes. That is fine: `ask` needs only the permission gate (§6.4 enforceability), and no mode is set.

Run: `bun test ./test/unit/client/backend-process.test.ts`
Expected: PASS.

- [ ] **Step 2: Node contract test**

Append to `test/node/acp-backend.test.ts`:

```ts
test("an ask approval round trip over a Node agent process", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "acp-node-ask-"));
  dirs.push(workdir);
  const record = join(workdir, "record.jsonl");
  const session = await createAgentSession({
    backend: acpBackend({
      agent: { name: "fake", command: process.execPath, args: [FAKE_MAIN] },
      allowUnsandboxed: true,
      env: fakeEnv(
        { turns: [{ steps: [{ kind: "permission", options: ["allow_once", "reject_once"] }, { kind: "text", text: "ok" }] }] },
        record,
      ),
    }),
    profile: "ask",
    workdir,
    transcriptStore: createMemoryTranscriptStore(),
  });
  const events: SessionEvent[] = [];
  for await (const event of session.send("go")) {
    events.push(event);
    if (event.type === "approval_requested") session.answer(event.requestId, { decision: "allow" });
  }
  expect(events.at(-1)).toMatchObject({ type: "turn_end", status: "completed" });
  await until(() => readRecords(record).some((r) => r.method === "permission-outcome"), 5_000);
  expect(readRecords(record).find((r) => r.method === "permission-outcome")?.params).toEqual({
    outcome: "selected",
    optionId: "opt-allow_once",
  });
  await session.close();
});
```

Add `readRecords` to the `#test/helpers/fake-process` import.

Run: `bun run test:node`
Expected: PASS on the local Node (22.19+ for type stripping). CI covers 22 and 24.

- [ ] **Step 3: Commit**

```bash
bun run lint:fix && bun run check:all
git add test/unit/client/backend-process.test.ts test/node/acp-backend.test.ts
git commit -m "test(nax-agent-acp): S4-3 ask approval round trip over real processes, Bun and Node"
```

---

### Task 6: Docs and context

**Files:**
- Modify: `packages/nax-agent-acp/src/client/index.ts:1-8`
- Modify: `packages/nax-agent-acp/README.md`
- Modify: `packages/nax-agent-acp/CHANGELOG.md`
- Modify: `.nax/mono/packages/nax-agent-acp/context.md` (repo root)
- Regenerated: `packages/nax-agent-acp/CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `codex.md`

**Interfaces:** none.

- [ ] **Step 1: `index.ts` header**

```ts
/**
 * `@nathapp/nax-agent-acp/client`: the ACP backend for nax-agent sessions.
 *
 * S4-3 serves text sessions under all four profiles, with permission requests
 * decided by profile (approved through answer() under `ask`). Embedder tools
 * (S4-4), tool and usage events (S4-5) and resume (S4-6) are refused with
 * AGENT_SESSION_CAPABILITY_UNSUPPORTED until their stage lands. Nothing is
 * released before S4-6.
 */
```

- [ ] **Step 2: README**

Replace the status paragraph with:

```md
**Status: pre-release.** The package is built in stages (S4-1 to S4-6) and is not
published yet. Today `acpBackend()` serves text sessions under all four profiles.
Embedder tools (S4-4), tool and usage events (S4-5) and resume (S4-6) are refused
with `AGENT_SESSION_CAPABILITY_UNSUPPORTED` until their stage lands. `./server` is
reserved for a later ACP server.
```

After the "What to know" list, add a section:

```md
## Profiles on ACP

ACP enforces a profile in two layers: the agent's own mode, and this client's
answer to each permission request the agent sends.

| Profile | Agent mode (Claude) | Permission requests |
|---|---|---|
| `none` | `plan` | rejected, recorded as `decidedBy: "profile"` |
| `read` | `plan` | rejected, recorded as `decidedBy: "profile"` |
| `ask` | `default` | `approval_requested`; you decide with `answer()` |
| `full` | `default` | allowed, recorded as `decidedBy: "profile"` |

- **Only Claude supports `none` and `read`.** Other agents have no read-only mode,
  so those profiles fail with `AGENT_SESSION_CAPABILITY_UNSUPPORTED` before any prompt.
- **The guarantees are narrower than the native backend's.** Only actions the agent
  routes through a permission request are decided here.
  - Under `none` and `read`, Claude may still run tools it does not ask about, such
    as reads and search. `none` means no permitted side effects, not no reads.
  - Under `ask`, actions Claude's `default` mode allows without asking (reads and
    other non-mutating tools) are not shown to you.
- **Only one-time options are chosen.** "Always allow" is never chosen, because it
  would outlive the session. An agent that offers no allow-once option is denied.
- **Expiry and failure deny.** An unanswered approval expires to a deny after
  `approvalTimeoutMs`. A cancelled turn or a dead agent process answers `cancelled`.
- **What you see is display data.** The request's title, command and paths come from
  the agent. They are redacted and capped, and they never decide anything.
- **Some requests are denied without being shown under `ask`.** This happens when a
  secret cannot be masked safely next to shell syntax, or the agent's text is too large
  to check. Some legitimate commands are caught too, for example `FOO_TOKEN=x; cmd`.
- **A cancelled turn starts nothing new.** A permission request that arrives after
  `cancel()`, while the agent is still stopping, is answered `cancelled` under every
  profile, `full` included.
- **The agent process is unsandboxed** under every profile.
```

- [ ] **Step 3: CHANGELOG**

Under `[Unreleased]`, append:

```md
- Profiles `none`, `read`, `ask` and `full` on `acpBackend()` (S4-3). The agent's
  mode is set by profile, and each `session/request_permission` is decided by profile:
  rejected under `none`/`read`, put to the caller through `approval_requested` and
  `answer()` under `ask`, allowed under `full`. Only one-time options are chosen.
  Auto-decisions are recorded with `decidedBy: "profile"`. Agent text in approval
  events is stripped, redacted and capped; oversized or unmaskable text is withheld.
  Pending approvals settle `cancelled` when the turn is cancelled, ends or loses its
  agent process, and a request after `cancel()` is never allowed. Out-of-turn,
  foreign-session and over-cap (16 concurrent) requests are rejected locally.
```

- [ ] **Step 4: context.md**

In `.nax/mono/packages/nax-agent-acp/context.md`:

Replace the Status paragraph with:

```md
Built in stages S4-1 to S4-6. S4-2 added `acpBackend()`: launch, connection,
capabilities, the session lifecycle and text turns. S4-3 adds all four profiles:
mode by profile and permission requests decided by profile (`permissions.ts`), with
`ask` going to the caller through the facade's ask port. Tested against a fake ACP
agent (`test/fixtures/fake-agent/`, in process and as a subprocess). Tools (S4-4),
full events and usage (S4-5) and resume (S4-6) are refused with
`AGENT_SESSION_CAPABILITY_UNSUPPORTED` until then. `./server` is reserved for S5.
Nothing is released before S4-6.
```

In the module map:
- change the `turn.ts, events.ts, inbound.ts` row's role to `prompt turn and abort; text events; inbound routing by turn and session`
- add these rows:

```md
| `permissions.ts` | §6.4 decision per permission request, by profile; only `*_once` options |
| `tool-display.ts`, `text.ts` | what a person sees of a tool call; control-strip, secret scrub, caps |
```

- [ ] **Step 5: Regenerate and check**

Run (repo root):
```bash
bun packages/nax/bin/nax.ts generate --all-packages
git status --short
```
Expected: only `packages/nax-agent-acp/{CLAUDE,AGENTS,GEMINI,codex}.md` change among generated files. If other packages' generated files change, the generator picked up unrelated drift. Revert those and note it in the PR body.

Run (from `packages/nax-agent-acp`): `bun run check:api`
Expected: PASS with no snapshot change. S4-3 adds no export to `./client`.

- [ ] **Step 6: Commit**

```bash
git add packages/nax-agent-acp/src/client/index.ts packages/nax-agent-acp/README.md packages/nax-agent-acp/CHANGELOG.md .nax/mono/packages/nax-agent-acp/context.md packages/nax-agent-acp/CLAUDE.md packages/nax-agent-acp/AGENTS.md packages/nax-agent-acp/GEMINI.md packages/nax-agent-acp/codex.md
git commit -m "docs(nax-agent-acp): S4-3 profiles, permission guarantees and module map"
```

---

### Task 7: Whole-repo gates, review, PR

- [ ] **Step 1: Run the repo-wide gates**

Run (repo root):
```bash
bun run typecheck
bun run check:all
bun run build
bun run test
```
Expected: all exit 0.

Run from `packages/nax-agent-acp` as CI does:
```bash
bun run check:api && bun run test:coverage && bun run test:node
```
Expected: all exit 0. Each new src file (`text.ts`, `tool-display.ts`, `permissions.ts`) is at or above 80%, and the per-file coverage baseline stays empty.

- [ ] **Step 2: Confirm the scope fence**

Run:
```bash
git diff --stat origin/main...HEAD -- packages/nax/ | cat
git diff --stat origin/main...HEAD -- packages/nax-agent/ | cat
```
Expected:
- `packages/nax/`: empty (spec §11.4).
- `packages/nax-agent/`: exactly `src/index.ts`, `test/unit/infra/agent-logger.test.ts`, `api/nax-agent.api.txt` (one added line) and `CHANGELOG.md`.

No `native/`, `tools/`, `permissions/`, `session/` or `internal/` file changes, so the S4-0 rule does not call for a billed `nax run` smoke.

- [ ] **Step 3: Review before push**

Dispatch one code-review subagent (sonnet) over `git diff origin/main...HEAD`. Give it:
- spec §6.3 (inbound with no active turn, step 5) and §6.4
- this plan's Decisions and Review Focus

Fix CRITICAL and HIGH findings, with at most two fix rounds.

- [ ] **Step 4: Push and open the PR (maintainer approval first)**

After approval:
```bash
git push -u origin feat/s4-3-acp-permissions
gh pr create --base main --title "feat(nax-agent-acp): S4-3 permissions and all four profiles" --body-file <body>
```

The body covers:
- the S4-3 scope (spec §10 row)
- decisions D3-a to D3-j
- the guarantees as documented in the README
- the test plan: CI jobs `nax-agent-acp`, `nax-agent-acp: node 22/24`, `nax-agent`, `nax`, `tooling`
- the one nax-agent addition (`getLogger` on `.`, D3-i)
- a statement that nothing is released and that nax is untouched

---

## Self-review notes

- **Spec coverage, §6.4:**
  - layer 1 (mode by profile): S4-2 code, exercised end to end in Task 4 (`plan` for none/read, `default` for ask/full)
  - layer 2, all four columns: Task 2 (unit) and Task 4 (end to end)
  - enforceability (codex `none`/`read` → `CAPABILITY_UNSUPPORTED`): Task 4
  - options rule (`allow_once`/`reject_once` only; no `allow_once` → deny with the reason; no `reject_once` → `cancelled`): Task 2
  - auto-decisions with `decidedBy: "profile"`: Tasks 2 and 4
  - untrusted fields: Tasks 1 and 4
  - expiry: deadline (Task 2, stub `timeout`), turn abort (Task 4, cancel while pending and a request inside the cancel grace window), process death (Task 4, crash)
  - guarantees documented: Task 6
- **§6.3 inbound with no active turn:** permission rejected, logged (`getLogger` from Task 0), no event: Task 3. Elicitation and MCP `tools/call` stay S4-5 and S4-4.
- **§6.3 step 5, pending asks settle `cancelled` on a crash:** Task 4. Questions do not exist before S4-5.
- **§10 S4-3 row, "all four profiles end to end":** Task 4 in process, Task 5 over real processes (`ask`; `full` was covered by S4-2).
- **Not covered by design:** the approval deadline end to end. The facade's minimum `approvalTimeoutMs` is 30 s, so it is pinned at the decision level (Task 2, `decidedBy: "timeout"` → `reject_once`). The facade's own deadline is covered by nax-agent's tests.
- **Type consistency:**
  - `PermissionDecider`'s `(request, signal)` matches Tasks 3 and 4
  - `release` is `() => Promise<void>` and `attach` takes `(agentSessionId, collector, turnSignal)` in Tasks 3 and 4
  - `ToolCallDisplay` field names match Tasks 1 and 2
  - the reason constants are imported by name in Tasks 2 and 4
