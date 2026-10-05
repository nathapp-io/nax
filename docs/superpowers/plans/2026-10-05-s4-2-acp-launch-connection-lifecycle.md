# S4-2: ACP launch, connection, lifecycle and a minimal `acpBackend()`: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `acpBackend()` drives a real ACP agent process through the nax-agent session facade for text-only `full` sessions: spawn, initialize, capability check, `session/new`, mode and model, prompt turns, cancel, crash handling and close.

**Architecture:**
- `@nathapp/nax-agent-acp/client` gains `acpBackend(opts): SessionBackend`. It is built from small modules under `packages/nax-agent-acp/src/client/`:

  | Module | Role |
  |---|---|
  | `options` and `env` | zod options and the environment allowlist |
  | `launch` | process-group spawn, ndjson stream, stderr tail |
  | `connection` | one SDK `ClientApp` per process, attached with `connect()` |
  | `capabilities` | the capability record and requirement checks |
  | `open` | §6.3 step 1 |
  | `turn` and `events` | §6.3 steps 2 and 3 |
  | `inbound` | routing of agent-initiated messages |
  | `backend` | assembly, close and the test seam |
- The facade (nax-agent 0.3.0, merged in S4-0) is unchanged.
- nax-agent gains one public export, `NaxError`. This closes the gap S4-1 carried.
- A fake ACP agent, built on the SDK's agent side, serves two kinds of test:
  - unit tests, in process: `ClientApp.connect(agentApp)`
  - subprocess tests: `bun` or `node` running `test/fixtures/fake-agent/main.ts`

**Tech Stack:**
- `@agentclientprotocol/sdk` 1.7.0 (stable v1, `client()` / `agent()` builders, `ndJsonStream`), `zod` 4
- `node:child_process`, `node:stream`
- bun:test (unit), vitest on Node 22/24 (contract)

**Spec:** `docs/superpowers/specs/2026-10-05-s4-acp-backend-design.md`. Sections used:
- §5.6 backend kit and §5.7 how a backend ends a turn
- §6.1 to §6.3 modules, options, lifecycle
- §6.4: S4-2 uses only the enforceability rule, inside `capabilities.ts`
- §6.7 (text rows only), §6.10 registry, §7 errors, §9 fake agent, §10 S4-2 row

## Global Constraints

- nax-agent-acp imports nax-agent only as `@nathapp/nax-agent` (public `.`), never `./internal` or a deep path, in `src/` or `test/` (§4).
- `src/` imports only `@agentclientprotocol/sdk` (root, never `/experimental`), `@modelcontextprotocol/sdk`, `zod` and `node:` builtins. No Bun API in `src/` (`check:no-bun-apis`).
- `src/` imports its own modules as `#src/client/<module>` (the staged manifest maps `#src/*` to `dist/`).
- No `throw new Error(` in `src/` (`check-nax-error`, baseline 0): throw `AgentSessionError` or `NaxError`.
- `allowUnsandboxed` must be exactly `true`, else `AGENT_SESSION_SANDBOX_UNAVAILABLE` (R7, §6.2).
- Defaults: `cancelGraceMs` 10_000, `initializeTimeoutMs` 60_000 (§6.2).
- Environment by default is an allowlist:
  - `PATH`, `HOME`, `USER`, `SHELL`, `TMPDIR`, `LANG`, `LC_*`, `TERM`
  - the registry entry's auth variables
  - `env`

  `inheritEnv: true` passes all of `process.env` (§6.2).
- Client capabilities at `initialize`: no fs, no terminal (R11). Elicitation is not advertised before S4-5 (D-d).
- Agent text reaching an error is redacted, control-stripped and capped at 4096 bytes (§7).
- `kind` is `"acp:<agent name>"` (§6.2). The initial document is `{ backend, acp: { agentSessionId, agent, agentVersion?, cwd }, messages: [], savedAt }` (§6.3 step 1.6).
- `ACP_STOP_MAX_TOKENS`, `ACP_STOP_MAX_TURN_REQUESTS`, `ACP_STOP_REFUSAL`, `ACP_STOP_CANCELLED` are `NaxError` codes owned by nax-agent-acp (§5.7).
- Gates (from `packages/nax-agent-acp`):
  - file sizes: 600 lines per src file, 800 per test file
  - complexity: 20 per function
  - coverage: 80% overall and per src file; the per-file baseline stays empty
  - import cycles: none
- Nothing is released in S4-2: no tag, no publish (§10). With `./client` no longer empty, S4-1's `stage-publish` empty-entry guard lifts as designed; the maintainer's S4-6 approval stays the gate.
- `packages/nax/` does not change. In nax-agent only `src/index.ts`, one test, `api/nax-agent.api.txt` and `CHANGELOG.md` change (Task 1).
- Never run bare `bun test` (no path) and never `bun run nax`. Package commands run from the package directory.
- Code in this plan is not pre-formatted: run `bun run lint:fix` in the package before every `check:all`.
- No emojis in code, comments or docs. Edit `.nax/**/context.md` only, then regenerate. Never hand-edit `CLAUDE.md`, `AGENTS.md`, `GEMINI.md` or `codex.md`.

## Review Focus

1. **A failed or aborted open leaves an agent process behind.** Each of these, after the spawn, must kill the process group before the error surfaces:
   - initialize timeout
   - auth error
   - capability refusal
   - model not offered
   - transcript save failure
   - `openSignal` abort

   Pinned in Task 7 (kill counts) and Task 9 (real pid gone).
2. **Secrets or raw agent text escaping into errors.** This covers stderr excerpts and JSON-RPC error messages. Values of secret-named env keys must appear as `[REDACTED]`, control characters must be stripped and the excerpt capped at 4 KB. Pinned in Tasks 2, 8 and 9.
3. **An agent that ignores `session/cancel`.** The turn must still end within `cancelGraceMs`, the group must be killed and later turns must end `AGENT_SESSION_CLOSED`. `close()` must not hang. Pinned in Tasks 8 and 9.
4. **A write after the agent died.** EPIPE on stdin is an `'error'` event on `child.stdin`. Unhandled, it crashes the embedder's process. Pinned in Task 5.
5. **Hostile agent values are classified, never trusted.** Each must yield a defined result, not a crash or a wrong code:
   - stop reasons `"__proto__"`, `"toString"` or unknown strings
   - `sessionCapabilities.close: true` (a boolean, not an object)
   - control characters or a huge `agentInfo`
   - an empty or non-string `sessionId`

   Pinned in Tasks 2, 4 and 7.

## Decisions taken in this plan (for review)

- **D-a. `NaxError` is exported on nax-agent's `.`.** This resolves the gap S4-1 carried. §5.7 makes the ACP stop codes and `AGENT_SESSION_TURN_FAILED` `NaxError` codes outside `AgentSessionErrorCode`, and the facade's `errorOf` maps any `NaxError` code into `turn_end.error.code`. The class is the same one `./internal` exports, so `instanceof` agrees. This is a 0.3.0 contract addition (unreleased) plus one API-snapshot line. Spec §5.6 is amended in Task 1.
- **D-b. Stages not yet built are refused before spawning.** The refusal is `AGENT_SESSION_CAPABILITY_UNSUPPORTED` with `details.capability`:
  - profiles other than `full`: `profile` (S4-3)
  - non-empty `tools`: `tools` (S4-4)
  - resume: `resume` (S4-6)

  `capabilities.ts` still implements the spec's requirement checks in full (§6.3 step 2, §6.4 enforceability), so later stages delete a refusal rather than add a check.
- **D-c. `initializeTimeoutMs` bounds every open-phase request**: `initialize`, `session/new` and each `set_config_option`, not only `initialize`. Without it a hung `session/new` would hang `createAgentSession` forever, because the facade has no open deadline.
- **D-d. Permission requests are answered locally, fail closed.** The answer is `reject_once`, or `cancelled` when the agent offered no such option. There is no event. S4-3 replaces this with the §6.4 profile table. Elicitation is not advertised until S4-5, so no handler is needed.
- **D-e. Events are text only.** `agent_message_chunk` text becomes `text_delta`, and `turn_end.output` is the joined text. Usage is zeros with `costSource: "unpriced"`. S4-5 adds the rest of §6.7.
- **D-f. Crash or kill leaves the session disconnected; no reconnect.** Later turns end `errored` with `AGENT_SESSION_CLOSED`. `send()` itself stays the facade's, so it does not throw. This is the spec's "agent without resume/load" path. S4-6 adds the one reconnect attempt.
- **D-g. The redaction set is the values of every secret-named key** (`/KEY|TOKEN|SECRET|PASSWORD/i`) in the final agent environment, not only in `env`. This also covers registry auth pass-through and `inheritEnv`, which are as secret. Values shorter than 8 characters are not replaced verbatim.
- **D-h. Custom agents are validated:**
  - the name matches `/^[a-z][a-z0-9._-]{0,63}$/` and is not a registered name. Otherwise `acp:claude` documents could be resumed by a different program.
  - a custom agent cannot also take a top-level `command`.
  - a command is a bare name or an absolute path. A relative path would resolve against the agent's `cwd`, not ours.
- **D-i. Explicit commands are spawned without a PATH lookup.** These are the `command` override and custom agents. Registry candidates are looked up on the agent environment's `PATH`, which is what `spawn` uses, and the first one found wins.
- **D-j. `session/close` and the final save live in `OpenedBackend.close()`; `adapter.closeSession` is a no-op.** The facade always calls `closeSession` and then `opened.close()`. One routine keeps the §6.3 step 4 bound (`cancelGraceMs × 2`). The final save load-merges, so the facade's `turn` marker survives.
- **D-k. `LaunchTarget` has an in-process variant `{ kind: "app", agent: AgentApp }`.** The unit suite uses it, through the `_acpBackendDeps.launch` seam, and so may S5. Production `launchAgent` always returns the stream variant.
- **D-l. Agent-supplied labels are cleaned.** Control characters are stripped from `agentInfo.name` and `version`, and each is capped at 200 characters, before they reach `BackendInfo.capabilities` and the document.

---

## File structure

**Create (package `packages/nax-agent-acp/`):**

| Path | Responsibility |
|---|---|
| `src/client/race.ts` | settle a promise against a timeout and an abort signal, never throwing |
| `src/client/errors.ts` | `ACP_STOP_CODES`, excerpts, error constructors and classification |
| `src/client/env.ts` | agent environment allowlist and the redaction set |
| `src/client/options.ts` | `AcpBackendOptions`, zod validation, `ResolvedAcpOptions` |
| `src/client/capabilities.ts` | capability record, requirement checks, config-option lookups |
| `src/client/launch.ts` | PATH lookup, `launchAgent()`, `LaunchedAgent`, `agentGoneError()` |
| `src/client/connection.ts` | `openConnection()`: the SDK client app and the outbound request API |
| `src/client/events.ts` | turn collector: `text_delta` and the turn output |
| `src/client/inbound.ts` | routing of `session/update`, local permission answers |
| `src/client/open.ts` | the open sequence (§6.3 step 1) |
| `src/client/turn.ts` | one prompt turn, its abort path |
| `src/client/backend.ts` | `acpBackend()`, the adapter, close, `_acpBackendDeps` |
| `test/fixtures/fake-agent/script.ts` | `FakeScript` types, `CLAUDE_CONFIG_OPTIONS` |
| `test/fixtures/fake-agent/agent.ts` | `buildFakeAgent()` on the SDK agent side |
| `test/fixtures/fake-agent/main.ts` | subprocess entry (Bun and Node) |
| `test/helpers/errors.ts` | `thrown`, `rejection`, `sessionError`, `naxError` |
| `test/helpers/fake-process.ts` | `FAKE_MAIN`, `fakeEnv`, `readRecords`, `startOf` |
| `test/helpers/in-memory-launch.ts` | `inMemoryAgent()`: an in-process `LaunchFn` |
| `test/helpers/open-context.ts` | `openContext()`: a full `BackendOpenContext` |
| `test/unit/client/{race,errors,env,options,capabilities,launch,connection,inbound,events,open,backend}.test.ts` | unit suites |
| `test/unit/client/backend-process.test.ts` | end to end over real subprocesses |
| `test/node/acp-backend.test.ts` | Node 22/24 contract over a real subprocess |

**Modify:**

| Path | Change |
|---|---|
| `packages/nax-agent/src/index.ts` | `export { NaxError }` |
| `packages/nax-agent/test/unit/session/agent-session-errors.test.ts` | public `NaxError` identity test |
| `packages/nax-agent/api/nax-agent.api.txt` | regenerated (+`NaxError` under `[.]`) |
| `packages/nax-agent/CHANGELOG.md` | backend-kit bullet |
| `docs/superpowers/specs/2026-10-05-s4-acp-backend-design.md` | §5.6 lists `NaxError` |
| `packages/nax-agent-acp/src/client/index.ts` | public exports |
| `packages/nax-agent-acp/api/nax-agent-acp.api.txt` | regenerated |
| `packages/nax-agent-acp/README.md`, `CHANGELOG.md` | S4-2 status and usage |
| `.nax/mono/packages/nax-agent-acp/context.md` | status and module map, then regenerate |

---

### Task 1: nax-agent exports `NaxError` on `.`

**Files:**
- Modify: `packages/nax-agent/src/index.ts:85`
- Modify: `packages/nax-agent/test/unit/session/agent-session-errors.test.ts`
- Modify (generated): `packages/nax-agent/api/nax-agent.api.txt`
- Modify: `packages/nax-agent/CHANGELOG.md`, `docs/superpowers/specs/2026-10-05-s4-acp-backend-design.md`

**Interfaces:**
- Produces: `import { NaxError } from "@nathapp/nax-agent"`. It is the class every `AgentSessionError` extends: `new NaxError(message: string, code: string, context?: Record<string, unknown>)`.

- [ ] **Step 1: Write the failing test**

In `packages/nax-agent/test/unit/session/agent-session-errors.test.ts`:
- Replace the header's last line `* (NaxError itself is not on \`.\`).` with `* (NaxError itself is on \`.\` since S4-2, for backends).`
- Change the public import to `import { AgentSessionError, NaxError as PublicNaxError } from "@nathapp/nax-agent";`
- Append inside the `describe`:

```ts
  test("NaxError is on the public entry and is the class nax-agent throws (S4-2, spec §5.6)", () => {
    expect(PublicNaxError).toBe(NaxError);
    expect(new AgentSessionError("x", "AGENT_SESSION_CLOSED")).toBeInstanceOf(PublicNaxError);
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/nax-agent && bun test test/unit/session/agent-session-errors.test.ts`
Expected: FAIL. The new test sees `PublicNaxError` as `undefined`, so `toBe` fails.

- [ ] **Step 3: Export it**

In `packages/nax-agent/src/index.ts`, after `export { capStrings, redactSecrets } from "#src/internal/redact";` add:

```ts
export { NaxError } from "#src/infra/nax-error";
```

- [ ] **Step 4: Run the test, regenerate the snapshot, run the gates**

Run:
```bash
cd packages/nax-agent
bun test test/unit/session/agent-session-errors.test.ts
bun run api:update
git diff --stat -- api/ | cat
bun run check:api && bun run typecheck && bun run lint:fix && bun run check:all
```
Expected:
- The test passes.
- The API diff is one added line, `NaxError`, in the `[.]` section.
- All gates exit 0.

- [ ] **Step 5: Record it**

In `packages/nax-agent/CHANGELOG.md`, `[Unreleased]` → `### Added`, change the backend-kit bullet's end from `` `createStderrTail` (`StderrTail`). `` to:

```markdown
`createStderrTail` (`StderrTail`), and `NaxError`, the base class of `AgentSessionError`, so a backend can throw codes outside `AgentSessionErrorCode` (S4 spec §5.7).
```

In the spec, §5.6, after the bullet `` - `AgentSessionError` and the error-code union (already public). `` add:

```markdown
- `NaxError`, the base class of `AgentSessionError` (added in S4-2): a backend throws its own codes (`ACP_STOP_*`, `AGENT_SESSION_TURN_FAILED`) with it, and the facade maps any `NaxError` code into `turn_end.error.code`.
```

- [ ] **Step 6: Commit**

```bash
git add packages/nax-agent/src/index.ts packages/nax-agent/test/unit/session/agent-session-errors.test.ts packages/nax-agent/api/nax-agent.api.txt packages/nax-agent/CHANGELOG.md docs/superpowers/specs/2026-10-05-s4-acp-backend-design.md
git commit -m "feat(nax-agent): export NaxError on the public entry for session backends"
```

---

### Task 2: `race` and `errors`

**Files:**
- Create: `packages/nax-agent-acp/src/client/race.ts`, `packages/nax-agent-acp/src/client/errors.ts`
- Test: `packages/nax-agent-acp/test/unit/client/race.test.ts`, `packages/nax-agent-acp/test/unit/client/errors.test.ts`

**Interfaces:**
- Consumes: `AgentSessionError`, `NaxError`, `redactSecrets` from `@nathapp/nax-agent`; `RequestError` from the SDK.
- Produces:
  - `race<T>(promise: Promise<T>, opts: { timeoutMs?: number; signal?: AbortSignal }): Promise<Raced<T>>`, where `Raced<T> = {kind:"ok";value:T} | {kind:"failed";error:unknown} | {kind:"timeout"} | {kind:"aborted"}`
  - `EXCERPT_BYTES = 4096`
  - `ACP_STOP_CODES`, `type AcpStopCode`
  - `agentTextExcerpt(text: string, secrets: readonly string[]): string`
  - `capabilityUnsupported(capability: string, reason: string): AgentSessionError`
  - `backendUnavailable(reason: string, details?: Readonly<Record<string, unknown>>): AgentSessionError`
  - `rpcErrorOf(err: unknown): RequestError | undefined`
  - `openRequestError(step: string, err: RequestError, secrets: readonly string[]): AgentSessionError`
  - `promptRequestError(err: RequestError, secrets: readonly string[]): NaxError`
  - `stopReasonError(stopReason: string): NaxError`
  - `closedDuringOpen(sessionId: string): AgentSessionError`

- [ ] **Step 1: Write the failing tests**

`packages/nax-agent-acp/test/unit/client/race.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { race } from "#src/client/race";

const pending = (): Promise<never> => new Promise(() => {});

describe("race: open steps, the cancel grace and the close bound", () => {
  test("a settled promise wins", async () => {
    expect(await race(Promise.resolve(7), { timeoutMs: 1_000 })).toEqual({ kind: "ok", value: 7 });
  });

  test("a rejection is reported, not thrown", async () => {
    const error = new Error("boom");
    expect(await race(Promise.reject(error), {})).toEqual({ kind: "failed", error });
  });

  test("the timeout wins over a pending promise", async () => {
    expect(await race(pending(), { timeoutMs: 5 })).toEqual({ kind: "timeout" });
  });

  test("an abort wins; an already-aborted signal wins at once", async () => {
    const controller = new AbortController();
    const raced = race(pending(), { signal: controller.signal });
    controller.abort();
    expect(await raced).toEqual({ kind: "aborted" });
    expect(await race(pending(), { signal: controller.signal })).toEqual({ kind: "aborted" });
  });

  test("a rejection after the timeout is swallowed, not unhandled", async () => {
    let reject: (error: unknown) => void = () => {};
    const late = new Promise<never>((_, r) => {
      reject = r;
    });
    expect(await race(late, { timeoutMs: 1 })).toEqual({ kind: "timeout" });
    reject(new Error("late"));
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
});
```

`packages/nax-agent-acp/test/unit/client/errors.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { RequestError } from "@agentclientprotocol/sdk";
import { AgentSessionError, NaxError } from "@nathapp/nax-agent";
import {
  ACP_STOP_CODES,
  agentTextExcerpt,
  backendUnavailable,
  capabilityUnsupported,
  closedDuringOpen,
  EXCERPT_BYTES,
  openRequestError,
  promptRequestError,
  rpcErrorOf,
  stopReasonError,
} from "#src/client/errors";

const SECRET = "s3cr3t-token-value-0123";

describe("agentTextExcerpt (spec §7)", () => {
  test("replaces secret values, keeps newlines and tabs, strips other control characters", () => {
    const out = agentTextExcerpt(`line1\n\tvalue ${SECRET}\u0007\u001b[31m`, [SECRET]);
    expect(out).toBe("line1\n\tvalue [REDACTED][31m");
  });

  test("secrets shorter than 8 characters are not replaced verbatim", () => {
    expect(agentTextExcerpt("a short pw", ["short"])).toBe("a short pw");
  });

  test("caps at 4096 bytes without a broken trailing character", () => {
    const out = agentTextExcerpt("é".repeat(EXCERPT_BYTES), []);
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(EXCERPT_BYTES);
    expect(out.endsWith("�")).toBe(false);
  });
});

describe("stopReasonError (spec §5.7)", () => {
  test.each([
    ["max_tokens", "ACP_STOP_MAX_TOKENS"],
    ["max_turn_requests", "ACP_STOP_MAX_TURN_REQUESTS"],
    ["refusal", "ACP_STOP_REFUSAL"],
    ["cancelled", "ACP_STOP_CANCELLED"],
  ])("%s -> %s", (reason, code) => {
    const err = stopReasonError(reason);
    expect(err).toBeInstanceOf(NaxError);
    expect(err.code).toBe(code);
    expect(err.context).toMatchObject({ stage: "acp", stopReason: reason });
  });

  test.each(["pause", "__proto__", "toString", "constructor", "end_turn\u0000x"])(
    "an unknown stop reason %p is AGENT_SESSION_TURN_FAILED",
    (reason) => {
      expect(stopReasonError(reason).code).toBe("AGENT_SESSION_TURN_FAILED");
    },
  );

  test("the code table is frozen and complete", () => {
    expect(Object.isFrozen(ACP_STOP_CODES)).toBe(true);
    expect(Object.keys(ACP_STOP_CODES).sort()).toEqual(["cancelled", "max_tokens", "max_turn_requests", "refusal"]);
  });
});

describe("request errors (spec §6.3, §7)", () => {
  test("rpcErrorOf recognises only RequestError", () => {
    const rpc = new RequestError(-32603, "x");
    expect(rpcErrorOf(rpc)).toBe(rpc);
    expect(rpcErrorOf(new Error("x"))).toBeUndefined();
  });

  test("an auth error at open is AGENT_SESSION_AUTH_REQUIRED", () => {
    const err = openRequestError("session/new", RequestError.authRequired(), []);
    expect(err.code).toBe("AGENT_SESSION_AUTH_REQUIRED");
    expect(err.context).toMatchObject({ step: "session/new" });
  });

  test("any other open error is AGENT_SESSION_BACKEND_UNAVAILABLE with a redacted message", () => {
    const err = openRequestError("initialize", new RequestError(-32603, `bad ${SECRET}`), [SECRET]);
    expect(err.code).toBe("AGENT_SESSION_BACKEND_UNAVAILABLE");
    expect(err.message).toContain("[REDACTED]");
    expect(err.message).not.toContain(SECRET);
    expect(err.context).toMatchObject({ step: "initialize", rpcCode: -32603 });
  });

  test("a prompt auth error is AGENT_SESSION_AUTH_REQUIRED; any other is AGENT_SESSION_TURN_FAILED", () => {
    expect(promptRequestError(RequestError.authRequired(), []).code).toBe("AGENT_SESSION_AUTH_REQUIRED");
    const failed = promptRequestError(new RequestError(-32603, `overloaded ${SECRET}`), [SECRET]);
    expect(failed).toBeInstanceOf(NaxError);
    expect(failed.code).toBe("AGENT_SESSION_TURN_FAILED");
    expect(failed.message).not.toContain(SECRET);
  });
});

describe("session errors", () => {
  test("capabilityUnsupported names the capability", () => {
    const err = capabilityUnsupported("tools", "no HTTP MCP");
    expect(err).toBeInstanceOf(AgentSessionError);
    expect(err.code).toBe("AGENT_SESSION_CAPABILITY_UNSUPPORTED");
    expect(err.context).toMatchObject({ capability: "tools" });
  });

  test("backendUnavailable carries its details", () => {
    expect(backendUnavailable("gone", { exitCode: 3 }).context).toMatchObject({ exitCode: 3 });
  });

  test("closedDuringOpen is AGENT_SESSION_CLOSED", () => {
    expect(closedDuringOpen("s-1").code).toBe("AGENT_SESSION_CLOSED");
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd packages/nax-agent-acp && bun test ./test/unit/client/race.test.ts ./test/unit/client/errors.test.ts`
Expected: FAIL, "Cannot find module '#src/client/race'" (and errors).

- [ ] **Step 3: Implement**

`packages/nax-agent-acp/src/client/race.ts`:

```ts
/**
 * Settles a promise against an optional deadline and an optional abort signal,
 * and reports which came first instead of throwing. The ACP backend bounds every
 * open step, the cancel grace and the close with it. The raced promise's own
 * rejection is always observed, so a late failure is never unhandled.
 */
export type Raced<T> =
  | { readonly kind: "ok"; readonly value: T }
  | { readonly kind: "failed"; readonly error: unknown }
  | { readonly kind: "timeout" }
  | { readonly kind: "aborted" };

export interface RaceOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export function race<T>(promise: Promise<T>, opts: RaceOptions): Promise<Raced<T>> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = (): void => finish({ kind: "aborted" });
    function finish(result: Raced<T>): void {
      if (timer !== undefined) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve(result);
    }
    promise.then(
      (value) => finish({ kind: "ok", value }),
      (error: unknown) => finish({ kind: "failed", error }),
    );
    if (opts.signal?.aborted === true) {
      finish({ kind: "aborted" });
      return;
    }
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    if (opts.timeoutMs !== undefined) timer = setTimeout(() => finish({ kind: "timeout" }), opts.timeoutMs);
  });
}
```

`packages/nax-agent-acp/src/client/errors.ts`:

```ts
/**
 * Errors of the ACP backend (S4 spec §5.7, §7). Classification (auth or not)
 * runs on the agent's raw error here; only the classified code and a redacted,
 * control-stripped excerpt of at most 4 KB reach messages and details.
 */
import { RequestError } from "@agentclientprotocol/sdk";
import { AgentSessionError, NaxError, redactSecrets } from "@nathapp/nax-agent";

/** Byte cap of every agent-text excerpt (stderr, JSON-RPC messages). */
export const EXCERPT_BYTES = 4096;

/** Shorter secret values are not replaced verbatim: they would garble ordinary text. */
const MIN_SECRET_LENGTH = 8;

/** JSON-RPC code of `RequestError.authRequired()`. */
const AUTH_REQUIRED_CODE = -32000;

/** Stop reasons other than end_turn, as NaxError codes owned by this package (§5.7). */
export const ACP_STOP_CODES = Object.freeze({
  max_tokens: "ACP_STOP_MAX_TOKENS",
  max_turn_requests: "ACP_STOP_MAX_TURN_REQUESTS",
  refusal: "ACP_STOP_REFUSAL",
  cancelled: "ACP_STOP_CANCELLED",
} as const);

export type AcpStopCode = (typeof ACP_STOP_CODES)[keyof typeof ACP_STOP_CODES];

function capBytes(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength <= maxBytes) return text;
  // A cut inside a multi-byte character decodes to U+FFFD; drop it.
  return bytes.subarray(0, maxBytes).toString("utf8").replace(/�+$/u, "");
}

/** Agent text made safe for an error: control characters stripped (except \n, \t), secrets redacted, capped. */
export function agentTextExcerpt(text: string, secrets: readonly string[]): string {
  const visible = text.replace(/\p{Cc}/gu, (c) => (c === "\n" || c === "\t" ? c : ""));
  const scrubbed = secrets
    .filter((secret) => secret.length >= MIN_SECRET_LENGTH)
    .reduce((acc, secret) => acc.split(secret).join("[REDACTED]"), visible);
  return capBytes(redactSecrets(scrubbed), EXCERPT_BYTES);
}

export function capabilityUnsupported(capability: string, reason: string): AgentSessionError {
  return new AgentSessionError(
    `The ACP agent cannot meet the "${capability}" requirement: ${reason}`,
    "AGENT_SESSION_CAPABILITY_UNSUPPORTED",
    { capability },
  );
}

export function backendUnavailable(reason: string, details: Readonly<Record<string, unknown>> = {}): AgentSessionError {
  return new AgentSessionError(`The ACP agent is unavailable: ${reason}`, "AGENT_SESSION_BACKEND_UNAVAILABLE", {
    ...details,
  });
}

export function closedDuringOpen(sessionId: string): AgentSessionError {
  return new AgentSessionError(`Session "${sessionId}" was closed while it was opening`, "AGENT_SESSION_CLOSED", {
    sessionId,
  });
}

/** The JSON-RPC error the agent answered with; undefined for transport failures. */
export function rpcErrorOf(err: unknown): RequestError | undefined {
  return err instanceof RequestError ? err : undefined;
}

/** A rejected open-phase request: initialize, session/new or session/set_config_option. */
export function openRequestError(step: string, err: RequestError, secrets: readonly string[]): AgentSessionError {
  const excerpt = agentTextExcerpt(err.message, secrets);
  if (err.code === AUTH_REQUIRED_CODE) {
    return new AgentSessionError(
      `The ACP agent requires authentication (${step}): ${excerpt}`,
      "AGENT_SESSION_AUTH_REQUIRED",
      { step },
    );
  }
  return backendUnavailable(`${step} failed: ${excerpt}`, { step, rpcCode: err.code });
}

/** A rejected session/prompt (§7: a JSON-RPC error on prompt is AGENT_SESSION_TURN_FAILED). */
export function promptRequestError(err: RequestError, secrets: readonly string[]): NaxError {
  const excerpt = agentTextExcerpt(err.message, secrets);
  if (err.code === AUTH_REQUIRED_CODE) {
    return new AgentSessionError(`The ACP agent requires authentication: ${excerpt}`, "AGENT_SESSION_AUTH_REQUIRED", {
      step: "session/prompt",
    });
  }
  return new NaxError(`The ACP prompt failed: ${excerpt}`, "AGENT_SESSION_TURN_FAILED", {
    stage: "acp",
    rpcCode: err.code,
  });
}

/** A stop reason other than end_turn. Own keys only: "__proto__" or "toString" is unknown, not a code. */
export function stopReasonError(stopReason: string): NaxError {
  if (Object.hasOwn(ACP_STOP_CODES, stopReason)) {
    const code = ACP_STOP_CODES[stopReason as keyof typeof ACP_STOP_CODES];
    return new NaxError(`The ACP agent stopped the turn: ${stopReason}`, code, { stage: "acp", stopReason });
  }
  const shown = agentTextExcerpt(stopReason, []).slice(0, 64);
  return new NaxError(
    `The ACP agent ended the turn with an unknown stop reason "${shown}"`,
    "AGENT_SESSION_TURN_FAILED",
    { stage: "acp", stopReason: shown },
  );
}
```

- [ ] **Step 4: Run them to verify they pass**

Run: `cd packages/nax-agent-acp && bun test ./test/unit/client/race.test.ts ./test/unit/client/errors.test.ts && bun run typecheck`
Expected: PASS, typecheck exit 0.

- [ ] **Step 5: Commit**

```bash
cd packages/nax-agent-acp && bun run lint:fix && cd ../..
git add packages/nax-agent-acp/src/client/race.ts packages/nax-agent-acp/src/client/errors.ts packages/nax-agent-acp/test/unit/client/race.test.ts packages/nax-agent-acp/test/unit/client/errors.test.ts
git commit -m "feat(nax-agent-acp): race helper and ACP error classification"
```

---

### Task 3: Options and the agent environment

**Files:**
- Create: `packages/nax-agent-acp/src/client/env.ts`, `packages/nax-agent-acp/src/client/options.ts`, `packages/nax-agent-acp/test/helpers/errors.ts`
- Test: `packages/nax-agent-acp/test/unit/client/env.test.ts`, `packages/nax-agent-acp/test/unit/client/options.test.ts`

**Interfaces:**
- Consumes: `registryEntry`, `isAcpAgentName`, `AcpAgentName`, `AgentRegistryEntry`, `LaunchCandidate` from `#src/client/registry` (S4-1).
- Produces:
  - `buildAgentEnv(input: AgentEnvInput): Record<string, string>`
  - `secretValues(env: Readonly<Record<string, string>>): readonly string[]`
  - `type AcpAgentSpec`, `interface AcpBackendOptions`
  - `type AcpLaunch = { kind: "explicit"; candidate: LaunchCandidate } | { kind: "registry"; candidates: readonly LaunchCandidate[] }`
  - `interface ResolvedAcpOptions { kind; agentName; entry; launch: AcpLaunch; model; env; secrets; cancelGraceMs; initializeTimeoutMs }`
  - `resolveAcpOptions(input: unknown, source?: Readonly<Record<string, string | undefined>>): ResolvedAcpOptions`
  - test helpers `thrown`, `rejection`, `sessionError`, `naxError`

- [ ] **Step 1: Write the test helpers and the failing tests**

`packages/nax-agent-acp/test/helpers/errors.ts`:

```ts
/** Narrowing helpers for thrown values, so tests assert codes without casts. */
import { AgentSessionError, NaxError } from "@nathapp/nax-agent";

export function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected a throw");
}

export async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

export function sessionError(error: unknown): AgentSessionError {
  if (error instanceof AgentSessionError) return error;
  throw new Error(`expected an AgentSessionError, got ${String(error)}`);
}

export function naxError(error: unknown): NaxError {
  if (error instanceof NaxError) return error;
  throw new Error(`expected a NaxError, got ${String(error)}`);
}
```

`packages/nax-agent-acp/test/unit/client/env.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { buildAgentEnv, secretValues } from "#src/client/env";

const SOURCE = {
  PATH: "/usr/bin",
  HOME: "/home/u",
  USER: "u",
  SHELL: "/bin/zsh",
  TMPDIR: "/tmp",
  LANG: "en_US.UTF-8",
  LC_ALL: "C",
  LC_CTYPE: "UTF-8",
  TERM: "xterm",
  ANTHROPIC_API_KEY: "sk-ant-test-0123456789",
  AWS_SECRET_ACCESS_KEY: "aws-secret-value",
  GITHUB_TOKEN: "ghp_value",
  NODE_OPTIONS: "--inspect",
  UNSET: undefined,
};

describe("buildAgentEnv (spec §6.2)", () => {
  test("the allowlist keeps the base keys, LC_*, and the agent's auth variables only", () => {
    expect(
      buildAgentEnv({ source: SOURCE, inheritEnv: false, authEnv: ["ANTHROPIC_API_KEY"], extra: {} }),
    ).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/u",
      USER: "u",
      SHELL: "/bin/zsh",
      TMPDIR: "/tmp",
      LANG: "en_US.UTF-8",
      LC_ALL: "C",
      LC_CTYPE: "UTF-8",
      TERM: "xterm",
      ANTHROPIC_API_KEY: "sk-ant-test-0123456789",
    });
  });

  test("env is added and wins over the source", () => {
    const env = buildAgentEnv({ source: SOURCE, inheritEnv: false, authEnv: [], extra: { PATH: "/opt/bin", X: "1" } });
    expect(env.PATH).toBe("/opt/bin");
    expect(env.X).toBe("1");
  });

  test("inheritEnv passes the whole source, minus unset values, plus env", () => {
    const env = buildAgentEnv({ source: SOURCE, inheritEnv: true, authEnv: [], extra: { X: "1" } });
    expect(env.GITHUB_TOKEN).toBe("ghp_value");
    expect(env.NODE_OPTIONS).toBe("--inspect");
    expect("UNSET" in env).toBe(false);
    expect(env.X).toBe("1");
  });
});

describe("secretValues (D-g)", () => {
  test("values of KEY, TOKEN, SECRET and PASSWORD keys, any case, non-empty only", () => {
    expect(
      secretValues({
        ANTHROPIC_API_KEY: "a-value",
        my_token: "t-value",
        DbPassword: "p-value",
        CLIENT_SECRET: "",
        PATH: "/usr/bin",
      }),
    ).toEqual(["a-value", "t-value", "p-value"]);
  });
});
```

`packages/nax-agent-acp/test/unit/client/options.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { resolveAcpOptions } from "#src/client/options";
import { ACP_AGENT_NAMES, registryEntry } from "#src/client/registry";
import { sessionError, thrown } from "#test/helpers/errors";

const SOURCE = { PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-ant-test-0123456789", AWS_SECRET_ACCESS_KEY: "x" };

function invalid(input: unknown): { readonly code: string; readonly path: unknown } {
  const err = sessionError(thrown(() => resolveAcpOptions(input, SOURCE)));
  return { code: err.code, path: err.context?.path };
}

describe("resolveAcpOptions: allowUnsandboxed (R7)", () => {
  test.each([undefined, false, "true", 1])("allowUnsandboxed %p is AGENT_SESSION_SANDBOX_UNAVAILABLE", (value) => {
    expect(invalid({ agent: "claude", allowUnsandboxed: value }).code).toBe("AGENT_SESSION_SANDBOX_UNAVAILABLE");
  });

  test("checked before anything else, and for a non-object input", () => {
    expect(invalid({ agent: "nope" }).code).toBe("AGENT_SESSION_SANDBOX_UNAVAILABLE");
    expect(invalid(null).code).toBe("AGENT_SESSION_SANDBOX_UNAVAILABLE");
  });
});

describe("resolveAcpOptions: registered agents (§6.2, §6.10)", () => {
  test("claude: kind, registry entry and candidates, defaults, allowlisted env and its secrets", () => {
    const resolved = resolveAcpOptions({ agent: "claude", allowUnsandboxed: true }, SOURCE);
    expect(resolved.kind).toBe("acp:claude");
    expect(resolved.agentName).toBe("claude");
    expect(resolved.entry).toBe(registryEntry("claude"));
    expect(resolved.launch).toEqual({ kind: "registry", candidates: registryEntry("claude")?.launch ?? [] });
    expect(resolved.cancelGraceMs).toBe(10_000);
    expect(resolved.initializeTimeoutMs).toBe(60_000);
    expect(resolved.model).toBeUndefined();
    expect(resolved.env).toEqual({ PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-ant-test-0123456789" });
    expect(resolved.secrets).toEqual(["sk-ant-test-0123456789"]);
  });

  test("a command override is explicit and keeps the registry entry", () => {
    const resolved = resolveAcpOptions(
      { agent: "claude", allowUnsandboxed: true, command: "/opt/acp/claude", args: ["--x"], model: "sonnet" },
      SOURCE,
    );
    expect(resolved.launch).toEqual({ kind: "explicit", candidate: { command: "/opt/acp/claude", args: ["--x"] } });
    expect(resolved.entry).toBe(registryEntry("claude"));
    expect(resolved.model).toBe("sonnet");
  });

  test("the zod enum matches the registry", () => {
    for (const name of ACP_AGENT_NAMES) {
      expect(resolveAcpOptions({ agent: name, allowUnsandboxed: true }, SOURCE).kind).toBe(`acp:${name}`);
    }
  });
});

describe("resolveAcpOptions: custom agents (§6.2, D-h)", () => {
  test("a custom agent has no registry entry and launches its own command", () => {
    const resolved = resolveAcpOptions(
      { agent: { name: "my-agent", command: "my-agent-acp", args: ["acp"] }, allowUnsandboxed: true },
      SOURCE,
    );
    expect(resolved.kind).toBe("acp:my-agent");
    expect(resolved.entry).toBeUndefined();
    expect(resolved.launch).toEqual({ kind: "explicit", candidate: { command: "my-agent-acp", args: ["acp"] } });
    expect(resolved.env).toEqual({ PATH: "/usr/bin" });
  });

  test.each(["claude", "Bad Name", "__proto__", "", "a".repeat(65)])("custom name %p is invalid", (name) => {
    expect(invalid({ agent: { name, command: "x" }, allowUnsandboxed: true }).code).toBe(
      "AGENT_SESSION_INVALID_OPTIONS",
    );
  });

  test("a custom agent cannot also take a top-level command", () => {
    expect(
      invalid({ agent: { name: "my-agent", command: "a" }, command: "b", allowUnsandboxed: true }),
    ).toEqual({ code: "AGENT_SESSION_INVALID_OPTIONS", path: "command" });
  });
});

describe("resolveAcpOptions: invalid input is AGENT_SESSION_INVALID_OPTIONS", () => {
  test.each([
    { agent: "aider" },
    { agent: "claude", args: ["x"] },
    { agent: "claude", command: "./bin/agent" },
    { agent: "claude", command: "bad\u0000cmd" },
    { agent: "claude", env: { "A=B": "1" } },
    { agent: "claude", env: { A: "x\u0000y" } },
    { agent: "claude", cancelGraceMs: 0 },
    { agent: "claude", initializeTimeoutMs: 1.5 },
    { agent: "claude", model: "" },
    { agent: "claude", unknown: true },
  ])("%p", (input) => {
    expect(invalid({ ...input, allowUnsandboxed: true }).code).toBe("AGENT_SESSION_INVALID_OPTIONS");
  });

  test("the error names the offending option", () => {
    expect(invalid({ agent: "claude", args: ["x"], allowUnsandboxed: true }).path).toBe("args");
    expect(invalid({ agent: "claude", command: "./bin/agent", allowUnsandboxed: true }).path).toBe("command");
    expect(invalid({ agent: "claude", cancelGraceMs: 0, allowUnsandboxed: true }).path).toBe("cancelGraceMs");
  });

  test("bare and absolute commands are accepted", () => {
    expect(resolveAcpOptions({ agent: "claude", command: "agent", allowUnsandboxed: true }, SOURCE).launch.kind).toBe(
      "explicit",
    );
    expect(
      resolveAcpOptions({ agent: "claude", command: "/abs/agent", allowUnsandboxed: true }, SOURCE).launch.kind,
    ).toBe("explicit");
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd packages/nax-agent-acp && bun test ./test/unit/client/env.test.ts ./test/unit/client/options.test.ts`
Expected: FAIL, "Cannot find module '#src/client/env'".

- [ ] **Step 3: Implement**

`packages/nax-agent-acp/src/client/env.ts`:

```ts
/**
 * The agent's environment (S4 spec §6.2). By default an allowlist: the base
 * keys, LC_*, the registry entry's auth variables, then `env`. `inheritEnv`
 * passes the whole source instead (documented as handing the embedder's
 * credentials to the agent). The redaction set is every secret-named value in
 * the result (D-g).
 */
const BASE_KEYS: readonly string[] = ["PATH", "HOME", "USER", "SHELL", "TMPDIR", "LANG", "TERM"];
const SECRET_KEY = /KEY|TOKEN|SECRET|PASSWORD/i;

export interface AgentEnvInput {
  readonly source: Readonly<Record<string, string | undefined>>;
  readonly inheritEnv: boolean;
  readonly authEnv: readonly string[];
  readonly extra: Readonly<Record<string, string>>;
}

function allowed(key: string, authEnv: readonly string[]): boolean {
  return BASE_KEYS.includes(key) || key.startsWith("LC_") || authEnv.includes(key);
}

export function buildAgentEnv(input: AgentEnvInput): Record<string, string> {
  const picked = Object.entries(input.source).flatMap(([key, value]): [string, string][] =>
    value !== undefined && (input.inheritEnv || allowed(key, input.authEnv)) ? [[key, value]] : [],
  );
  return { ...Object.fromEntries(picked), ...input.extra };
}

export function secretValues(env: Readonly<Record<string, string>>): readonly string[] {
  return Object.entries(env)
    .filter(([key, value]) => SECRET_KEY.test(key) && value.length > 0)
    .map(([, value]) => value);
}
```

`packages/nax-agent-acp/src/client/options.ts`:

```ts
/**
 * acpBackend options (S4 spec §6.2), validated with zod at the factory, so a bad
 * option fails at acpBackend() and never at open. allowUnsandboxed is checked
 * first: anything but `true` is AGENT_SESSION_SANDBOX_UNAVAILABLE (R7).
 */
import { isAbsolute } from "node:path";
import { AgentSessionError } from "@nathapp/nax-agent";
import { z } from "zod";
import { buildAgentEnv, secretValues } from "#src/client/env";
import {
  type AcpAgentName,
  type AgentRegistryEntry,
  isAcpAgentName,
  type LaunchCandidate,
  registryEntry,
} from "#src/client/registry";

export const DEFAULT_CANCEL_GRACE_MS = 10_000;
export const DEFAULT_INITIALIZE_TIMEOUT_MS = 60_000;

export type AcpAgentSpec =
  | AcpAgentName
  | { readonly name: string; readonly command: string; readonly args?: readonly string[] };

export interface AcpBackendOptions {
  readonly agent: AcpAgentSpec;
  /** Required: the agent process runs on the host, unsandboxed (R7). */
  readonly allowUnsandboxed: true;
  /** Applied via session/set_config_option (category "model") before open returns. */
  readonly model?: string;
  /** Added to the agent's environment. */
  readonly env?: Readonly<Record<string, string>>;
  /** Default false: the allowlist only. true hands the whole process.env to the agent. */
  readonly inheritEnv?: boolean;
  /** Overrides the registry's launch command (a bare name or an absolute path). */
  readonly command?: string;
  readonly args?: readonly string[];
  readonly cancelGraceMs?: number;
  readonly initializeTimeoutMs?: number;
}

export type AcpLaunch =
  | { readonly kind: "explicit"; readonly candidate: LaunchCandidate }
  | { readonly kind: "registry"; readonly candidates: readonly LaunchCandidate[] };

export interface ResolvedAcpOptions {
  /** "acp:<agent name>". */
  readonly kind: string;
  readonly agentName: string;
  /** Undefined for a custom agent: no modes, no pre-approval, no auth variables. */
  readonly entry: AgentRegistryEntry | undefined;
  readonly launch: AcpLaunch;
  readonly model: string | undefined;
  readonly env: Readonly<Record<string, string>>;
  /** Values redacted from every agent excerpt (D-g). */
  readonly secrets: readonly string[];
  readonly cancelGraceMs: number;
  readonly initializeTimeoutMs: number;
}

const noNul = (value: string): boolean => !value.includes("\u0000");
const plain = z.string().refine(noNul, "must not contain NUL");
const command = z
  .string()
  .min(1)
  .refine(noNul, "must not contain NUL")
  .refine((c) => !c.includes("/") || isAbsolute(c), "a command is a bare name or an absolute path");
const customAgent = z.strictObject({
  name: z
    .string()
    .regex(/^[a-z][a-z0-9._-]{0,63}$/, "a lowercase name of at most 64 characters")
    .refine((name) => !isAcpAgentName(name), "a custom agent may not reuse a registered name"),
  command,
  args: z.array(plain).optional(),
});
const SCHEMA = z
  .strictObject({
    agent: z.union([z.enum(["claude", "codex", "gemini", "opencode", "pi"]), customAgent]),
    allowUnsandboxed: z.literal(true),
    model: z.string().min(1).optional(),
    env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), plain).optional(),
    inheritEnv: z.boolean().optional(),
    command: command.optional(),
    args: z.array(plain).optional(),
    cancelGraceMs: z.number().int().positive().max(600_000).optional(),
    initializeTimeoutMs: z.number().int().positive().max(3_600_000).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.args !== undefined && value.command === undefined) {
      ctx.addIssue({ code: "custom", path: ["args"], message: "args needs command" });
    }
    if (typeof value.agent === "object" && value.command !== undefined) {
      ctx.addIssue({ code: "custom", path: ["command"], message: "a custom agent carries its own command" });
    }
  });

type ParsedOptions = z.output<typeof SCHEMA>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function launchOf(data: ParsedOptions, entry: AgentRegistryEntry | undefined): AcpLaunch {
  if (data.command !== undefined) return { kind: "explicit", candidate: { command: data.command, args: data.args ?? [] } };
  if (typeof data.agent === "object") {
    return { kind: "explicit", candidate: { command: data.agent.command, args: data.agent.args ?? [] } };
  }
  return { kind: "registry", candidates: entry?.launch ?? [] };
}

function resolved(data: ParsedOptions, source: Readonly<Record<string, string | undefined>>): ResolvedAcpOptions {
  const agentName = typeof data.agent === "string" ? data.agent : data.agent.name;
  const entry = typeof data.agent === "string" ? registryEntry(data.agent) : undefined;
  const env = buildAgentEnv({
    source,
    inheritEnv: data.inheritEnv ?? false,
    authEnv: entry?.authEnv ?? [],
    extra: data.env ?? {},
  });
  return Object.freeze({
    kind: `acp:${agentName}`,
    agentName,
    entry,
    launch: launchOf(data, entry),
    model: data.model,
    env: Object.freeze(env),
    secrets: Object.freeze([...secretValues(env)]),
    cancelGraceMs: data.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS,
    initializeTimeoutMs: data.initializeTimeoutMs ?? DEFAULT_INITIALIZE_TIMEOUT_MS,
  });
}

export function resolveAcpOptions(
  input: unknown,
  source: Readonly<Record<string, string | undefined>> = process.env,
): ResolvedAcpOptions {
  if (!isRecord(input) || input.allowUnsandboxed !== true) {
    throw new AgentSessionError(
      "acpBackend requires allowUnsandboxed: true: the agent process runs on the host, unsandboxed",
      "AGENT_SESSION_SANDBOX_UNAVAILABLE",
      { path: "allowUnsandboxed" },
    );
  }
  const parsed = SCHEMA.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue === undefined ? "" : issue.path.map(String).join(".");
    throw new AgentSessionError(
      `Invalid acpBackend options: ${path === "" ? "(options)" : path}: ${issue?.message ?? "invalid"}`,
      "AGENT_SESSION_INVALID_OPTIONS",
      { path },
    );
  }
  return resolved(parsed.data, source);
}
```

- [ ] **Step 4: Run them to verify they pass**

Run: `cd packages/nax-agent-acp && bun test ./test/unit/client/env.test.ts ./test/unit/client/options.test.ts && bun run typecheck`
Expected: PASS, typecheck exit 0.

- [ ] **Step 5: Commit**

```bash
cd packages/nax-agent-acp && bun run lint:fix && cd ../..
git add packages/nax-agent-acp/src/client/env.ts packages/nax-agent-acp/src/client/options.ts packages/nax-agent-acp/test/helpers/errors.ts packages/nax-agent-acp/test/unit/client/env.test.ts packages/nax-agent-acp/test/unit/client/options.test.ts
git commit -m "feat(nax-agent-acp): acpBackend options and the agent env allowlist"
```

---

### Task 4: Capability record and requirement checks

**Files:**
- Create: `packages/nax-agent-acp/src/client/capabilities.ts`
- Test: `packages/nax-agent-acp/test/unit/client/capabilities.test.ts`

**Interfaces:**
- Consumes: `AgentRegistryEntry`, `ModeSetting`, `registryEntry` (S4-1); SDK types `InitializeResponse`, `SessionConfigOption`; `AgentSessionProfile` from nax-agent.
- Produces:
  - `type CapabilityRecord = { protocolVersion; agentName?; agentVersion?; loadSession; resume; close; mcpHttp; readOnlyMode; preApproval }`, JSON-safe and frozen
  - `buildCapabilityRecord(init: InitializeResponse, entry: AgentRegistryEntry | undefined): CapabilityRecord`
  - `unmetRequirement(record, req: { profile: AgentSessionProfile; toolCount: number; resume: boolean }): { capability: "profile" | "tools" | "resume"; reason: string } | undefined`
  - `selectValues(option: SessionConfigOption): readonly string[]`
  - `offersValue(options, configId, value): boolean`
  - `modelOptionId(options, model): string | undefined`
  - `modeFor(profile, entry): ModeSetting | undefined`

- [ ] **Step 1: Write the failing test**

`packages/nax-agent-acp/test/unit/client/capabilities.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { InitializeResponse, SessionConfigOption } from "@agentclientprotocol/sdk";
import {
  buildCapabilityRecord,
  type CapabilityRecord,
  modeFor,
  modelOptionId,
  offersValue,
  selectValues,
  unmetRequirement,
} from "#src/client/capabilities";
import { registryEntry } from "#src/client/registry";

const CLAUDE = registryEntry("claude");

const FULL_INIT: InitializeResponse = {
  protocolVersion: 1,
  agentInfo: { name: "claude-agent-acp", version: "0.85.1" },
  agentCapabilities: {
    loadSession: true,
    mcpCapabilities: { http: true },
    sessionCapabilities: { resume: {}, close: {} },
  },
};

describe("buildCapabilityRecord (spec §6.3 step 2)", () => {
  test("initialize plus registry data", () => {
    expect(buildCapabilityRecord(FULL_INIT, CLAUDE)).toEqual({
      protocolVersion: 1,
      agentName: "claude-agent-acp",
      agentVersion: "0.85.1",
      loadSession: true,
      resume: true,
      close: true,
      mcpHttp: true,
      readOnlyMode: true,
      preApproval: true,
    });
  });

  test("an empty initialize and a custom agent: everything false", () => {
    expect(buildCapabilityRecord({ protocolVersion: 1 }, undefined)).toEqual({
      protocolVersion: 1,
      loadSession: false,
      resume: false,
      close: false,
      mcpHttp: false,
      readOnlyMode: false,
      preApproval: false,
    });
  });

  test("a capability is an object; a boolean in its place does not count (hostile agent)", () => {
    const init = { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { close: true, resume: null } } };
    // The agent's JSON is untrusted and may not match the schema; parse it as unknown first.
    const record = buildCapabilityRecord(JSON.parse(JSON.stringify(init)), undefined);
    expect(record.close).toBe(false);
    expect(record.resume).toBe(false);
  });

  test("agent labels are control-stripped and capped at 200 characters (D-l)", () => {
    const record = buildCapabilityRecord(
      { protocolVersion: 1, agentInfo: { name: `evil\u001b[2J${"n".repeat(300)}`, version: "1\u0000.0" } },
      undefined,
    );
    expect(record.agentName).toBe(`evil[2J${"n".repeat(193)}`);
    expect(record.agentVersion).toBe("1.0");
  });

  test("the record is frozen and JSON-safe", () => {
    const record = buildCapabilityRecord(FULL_INIT, CLAUDE);
    expect(Object.isFrozen(record)).toBe(true);
    expect(JSON.parse(JSON.stringify(record))).toEqual(record);
  });
});

const claudeRecord: CapabilityRecord = buildCapabilityRecord(FULL_INIT, CLAUDE);
const customRecord: CapabilityRecord = buildCapabilityRecord({ protocolVersion: 1 }, undefined);

describe("unmetRequirement (spec §6.3 step 2, §6.4 enforceability)", () => {
  test.each([
    ["none", 0, false],
    ["read", 0, false],
    ["ask", 0, false],
    ["full", 2, true],
  ] as const)("claude meets profile %p, %p tools, resume %p", (profile, toolCount, resume) => {
    expect(unmetRequirement(claudeRecord, { profile, toolCount, resume })).toBeUndefined();
  });

  test("none/read need a read-only mode: custom agents fail closed", () => {
    expect(unmetRequirement(customRecord, { profile: "read", toolCount: 0, resume: false })?.capability).toBe(
      "profile",
    );
    expect(unmetRequirement(customRecord, { profile: "none", toolCount: 0, resume: false })?.capability).toBe(
      "profile",
    );
    expect(unmetRequirement(customRecord, { profile: "ask", toolCount: 0, resume: false })).toBeUndefined();
  });

  test("tools need HTTP MCP and pre-approval", () => {
    const httpOnly = { ...customRecord, mcpHttp: true };
    expect(unmetRequirement(httpOnly, { profile: "full", toolCount: 1, resume: false })?.capability).toBe("tools");
  });

  test("resume needs session/resume or loadSession", () => {
    expect(unmetRequirement(customRecord, { profile: "full", toolCount: 0, resume: true })?.capability).toBe("resume");
    const loads = { ...customRecord, loadSession: true };
    expect(unmetRequirement(loads, { profile: "full", toolCount: 0, resume: true })).toBeUndefined();
  });
});

const OPTIONS: SessionConfigOption[] = [
  {
    id: "mode",
    name: "Mode",
    category: "mode",
    type: "select",
    currentValue: "default",
    options: [
      { value: "default", name: "Default" },
      { value: "plan", name: "Plan" },
    ],
  },
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "sonnet",
    options: [{ group: "anthropic", name: "Anthropic", options: [{ value: "sonnet", name: "Sonnet" }] }],
  },
  { id: "verbose", name: "Verbose", type: "boolean", currentValue: false },
];

describe("config options", () => {
  test("selectValues flattens groups; a boolean option offers none", () => {
    const [mode, model, verbose] = OPTIONS;
    if (mode === undefined || model === undefined || verbose === undefined) throw new Error("fixture");
    expect(selectValues(mode)).toEqual(["default", "plan"]);
    expect(selectValues(model)).toEqual(["sonnet"]);
    expect(selectValues(verbose)).toEqual([]);
  });

  test("offersValue and modelOptionId", () => {
    expect(offersValue(OPTIONS, "mode", "plan")).toBe(true);
    expect(offersValue(OPTIONS, "mode", "yolo")).toBe(false);
    expect(offersValue(OPTIONS, "missing", "plan")).toBe(false);
    expect(modelOptionId(OPTIONS, "sonnet")).toBe("model");
    expect(modelOptionId(OPTIONS, "opus")).toBeUndefined();
  });

  test("modeFor: read-only for none/read, default for ask/full, nothing for custom agents", () => {
    expect(modeFor("read", CLAUDE)).toEqual({ configId: "mode", value: "plan" });
    expect(modeFor("none", CLAUDE)).toEqual({ configId: "mode", value: "plan" });
    expect(modeFor("full", CLAUDE)).toEqual({ configId: "mode", value: "default" });
    expect(modeFor("ask", registryEntry("codex"))).toBeUndefined();
    expect(modeFor("full", undefined)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/nax-agent-acp && bun test ./test/unit/client/capabilities.test.ts`
Expected: FAIL, "Cannot find module '#src/client/capabilities'".

- [ ] **Step 3: Implement**

`packages/nax-agent-acp/src/client/capabilities.ts`:

```ts
/**
 * What an ACP agent can do (S4 spec §6.3 step 2, §6.4, §6.10): the capability
 * record from initialize plus registry data, and the requirement checks that run
 * before any prompt. The record is authoritative at runtime and only narrows what
 * the registry allows; custom agents have no registry data and fail closed. It is
 * reported as AgentSession.backend.capabilities, so it stays JSON-safe.
 */
import type { InitializeResponse, SessionConfigOption } from "@agentclientprotocol/sdk";
import type { AgentSessionProfile } from "@nathapp/nax-agent";
import type { AgentRegistryEntry, ModeSetting } from "#src/client/registry";

const LABEL_MAX_CHARS = 200;

export type CapabilityRecord = {
  readonly protocolVersion: number;
  readonly agentName?: string;
  readonly agentVersion?: string;
  readonly loadSession: boolean;
  readonly resume: boolean;
  readonly close: boolean;
  readonly mcpHttp: boolean;
  /** The registry has a read-only mode for profiles none/read. */
  readonly readOnlyMode: boolean;
  /** The registry knows how to pre-approve embedder tools at the adapter (R12). */
  readonly preApproval: boolean;
};

export interface Requirements {
  readonly profile: AgentSessionProfile;
  readonly toolCount: number;
  readonly resume: boolean;
}

export interface UnmetRequirement {
  readonly capability: "profile" | "tools" | "resume";
  readonly reason: string;
}

function isObject(value: unknown): boolean {
  return typeof value === "object" && value !== null;
}

/** Agent-supplied labels are display data: control characters stripped, capped (D-l). */
function label(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.replace(/\p{Cc}/gu, "").slice(0, LABEL_MAX_CHARS);
  return clean === "" ? undefined : clean;
}

export function buildCapabilityRecord(
  init: InitializeResponse,
  entry: AgentRegistryEntry | undefined,
): CapabilityRecord {
  const caps = init.agentCapabilities ?? {};
  const name = label(init.agentInfo?.name);
  const version = label(init.agentInfo?.version);
  return Object.freeze({
    protocolVersion: init.protocolVersion,
    ...(name === undefined ? {} : { agentName: name }),
    ...(version === undefined ? {} : { agentVersion: version }),
    loadSession: caps.loadSession === true,
    resume: isObject(caps.sessionCapabilities?.resume),
    close: isObject(caps.sessionCapabilities?.close),
    mcpHttp: caps.mcpCapabilities?.http === true,
    readOnlyMode: entry?.readOnlyMode !== undefined,
    preApproval: entry?.preApproval !== undefined,
  });
}

/** The first requirement this agent cannot meet, or undefined. The model is checked after session/new. */
export function unmetRequirement(record: CapabilityRecord, req: Requirements): UnmetRequirement | undefined {
  if ((req.profile === "none" || req.profile === "read") && !record.readOnlyMode) {
    return { capability: "profile", reason: `profile "${req.profile}" needs a read-only agent mode; this agent has none` };
  }
  if (req.toolCount > 0 && !(record.mcpHttp && record.preApproval)) {
    return { capability: "tools", reason: "embedder tools need HTTP MCP support and adapter pre-approval" };
  }
  if (req.resume && !(record.resume || record.loadSession)) {
    return { capability: "resume", reason: "the agent supports neither session/resume nor session/load" };
  }
  return undefined;
}

/** The value ids a select option offers, groups flattened; none for a boolean option. */
export function selectValues(option: SessionConfigOption): readonly string[] {
  if (option.type !== "select") return [];
  return option.options.flatMap((entry) => ("group" in entry ? entry.options.map((o) => o.value) : [entry.value]));
}

export function offersValue(options: readonly SessionConfigOption[], configId: string, value: string): boolean {
  return options.some((option) => option.id === configId && selectValues(option).includes(value));
}

/** The id of the agent's model option (category "model") that offers `model`. */
export function modelOptionId(options: readonly SessionConfigOption[], model: string): string | undefined {
  return options.find((option) => option.category === "model" && selectValues(option).includes(model))?.id;
}

/** The mode a profile selects (§6.4 layer 1): read-only for none/read, the default mode otherwise. */
export function modeFor(profile: AgentSessionProfile, entry: AgentRegistryEntry | undefined): ModeSetting | undefined {
  return profile === "none" || profile === "read" ? entry?.readOnlyMode : entry?.defaultMode;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd packages/nax-agent-acp && bun test ./test/unit/client/capabilities.test.ts && bun run typecheck`
Expected: PASS, typecheck exit 0.

- [ ] **Step 5: Commit**

```bash
cd packages/nax-agent-acp && bun run lint:fix && cd ../..
git add packages/nax-agent-acp/src/client/capabilities.ts packages/nax-agent-acp/test/unit/client/capabilities.test.ts
git commit -m "feat(nax-agent-acp): capability record and requirement checks"
```

---

### Task 5: Launch, and the fake ACP agent

**Files:**
- Create: `packages/nax-agent-acp/src/client/launch.ts`
- Create: `packages/nax-agent-acp/test/fixtures/fake-agent/script.ts`, `agent.ts`, `main.ts`
- Create: `packages/nax-agent-acp/test/helpers/fake-process.ts`
- Test: `packages/nax-agent-acp/test/unit/client/launch.test.ts`

**Interfaces:**
- Consumes:
  - `race` (Task 2)
  - `backendUnavailable`, `agentTextExcerpt`, `EXCERPT_BYTES` (Task 2)
  - `LaunchCandidate` (S4-1)
  - `createStderrTail`, `killProcessGroup`, `StderrTail` from nax-agent
  - `ndJsonStream`, `Stream`, `AgentApp`, `AnyMessage` from the SDK
- Produces:
  - `type LaunchTarget = { kind: "stream"; stream: Stream } | { kind: "app"; agent: AgentApp }`
  - `interface AgentExit { code: number | null; signal: string | null; spawnError?: string }`
  - `interface LaunchedAgent { target; pid; stderr; exited: Promise<AgentExit>; whenGone(waitMs): Promise<AgentExit | undefined>; terminate(graceMs): Promise<void>; kill(): void }`
  - `interface LaunchRequest { command; args; cwd; env; maxMessageBytes? }`
  - `type LaunchFn = (request: LaunchRequest) => LaunchedAgent`
  - `findExecutable(command, pathVar): boolean`
  - `pickCandidate(candidates, pathVar): LaunchCandidate | undefined`
  - `launchAgent: LaunchFn`
  - `agentGoneError(during: string, launched: LaunchedAgent, secrets: readonly string[]): Promise<AgentSessionError>`
  - Fixture:
    - `buildFakeAgent(script: FakeScript, hooks: FakeHooks): AgentApp`
    - `FakeScript`, `FakeStep`, `FakeTurn`, `FakeHooks`, `FakeRecord`, `CLAUDE_CONFIG_OPTIONS`
  - Helpers:
    - `FAKE_MAIN: string`
    - `fakeEnv(script, recordPath?): Record<string, string>`
    - `readRecords(path): FakeRecord[]`
    - `startOf(path): { cwd: string; pid: number; env: Record<string, boolean> }`
    - `childPidOf(path): number | undefined`

- [ ] **Step 1: Write the fake agent fixture**

`packages/nax-agent-acp/test/fixtures/fake-agent/script.ts`:

```ts
/**
 * The fake ACP agent's script (S4 spec §9). A test describes what the agent
 * answers and does per prompt; the agent reports every request it receives
 * through FakeHooks.record. Plain data, so the subprocess entry takes it as JSON.
 */
import type {
  AgentCapabilities,
  PermissionOptionKind,
  SessionConfigOption,
  StopReason,
  Usage,
} from "@agentclientprotocol/sdk";

export interface RpcFailure {
  readonly code: number;
  readonly message: string;
}

export type FakeStep =
  /** An agent_message_chunk; `sessionId` addresses another session (routing tests). */
  | { readonly kind: "text"; readonly text: string; readonly sessionId?: string }
  | { readonly kind: "thought"; readonly text: string }
  | { readonly kind: "delay"; readonly ms: number }
  /** session/request_permission with one option per kind; the outcome is recorded as "permission-outcome". */
  | { readonly kind: "permission"; readonly options: readonly PermissionOptionKind[] }
  /** Blocks until session/cancel arrives; the turn then stops "cancelled". */
  | { readonly kind: "waitForCancel" }
  /** Never settles and ignores session/cancel. */
  | { readonly kind: "hang" }
  /** Subprocess only: writes `stderr` and exits with `code` mid-turn. */
  | { readonly kind: "exit"; readonly code: number; readonly stderr?: string }
  /** The prompt request fails with this JSON-RPC error. */
  | { readonly kind: "fail"; readonly failure: RpcFailure };

export interface FakeTurn {
  readonly steps: readonly FakeStep[];
  readonly stopReason?: StopReason;
  readonly usage?: Usage;
}

export interface FakeStartup {
  readonly stderr?: string;
  readonly exitCode?: number;
  readonly hang?: boolean;
  readonly ignoreSigterm?: boolean;
  /** Spawns `sleep 30` in the agent's process group and records its pid as "child". */
  readonly spawnChild?: boolean;
  readonly garbageLine?: boolean;
  readonly oversizedLineBytes?: number;
}

export interface FakeScript {
  /** Subprocess only: behaviour before the ACP stream starts. */
  readonly startup?: FakeStartup;
  readonly protocolVersion?: number;
  readonly agentInfo?: { readonly name: string; readonly version: string };
  readonly capabilities?: AgentCapabilities;
  readonly hangInitialize?: boolean;
  readonly initializeFailure?: RpcFailure;
  readonly newSessionFailure?: RpcFailure;
  /** Default "fake-session-1". */
  readonly sessionId?: string;
  readonly configOptions?: readonly SessionConfigOption[];
  /** Turns in order; the last repeats. Default: one turn replying "ok". */
  readonly turns?: readonly FakeTurn[];
  /** Subprocess only: variables whose presence the "start" record reports. */
  readonly recordEnv?: readonly string[];
}

export interface FakeRecord {
  readonly method: string;
  readonly params: unknown;
}

export interface FakeHooks {
  record(method: string, params: unknown): void;
  /** Ends the agent process (subprocess); in process the step fails instead. */
  exit(code: number, stderr?: string): never;
}

/** Claude's session config as the fake offers it: a `mode` select and a `model` select. */
export const CLAUDE_CONFIG_OPTIONS: readonly SessionConfigOption[] = [
  {
    id: "mode",
    name: "Mode",
    category: "mode",
    type: "select",
    currentValue: "default",
    options: [
      { value: "default", name: "Default" },
      { value: "acceptEdits", name: "Accept edits" },
      { value: "plan", name: "Plan" },
    ],
  },
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "default",
    options: [
      { value: "default", name: "Default" },
      { value: "sonnet", name: "Sonnet" },
    ],
  },
];
```

`packages/nax-agent-acp/test/fixtures/fake-agent/agent.ts`:

```ts
/**
 * The fake ACP agent (S4 spec §9) on the SDK's agent side. It answers initialize,
 * session/new, session/set_config_option, session/prompt and session/close from a
 * FakeScript and records each request through FakeHooks. It runs in process (the
 * client connects to the AgentApp directly) or as a subprocess (main.ts). Erasable
 * TypeScript only: Node runs it with type stripping.
 */
import {
  type AgentApp,
  type AgentContext,
  agent,
  methods,
  type PromptResponse,
  PROTOCOL_VERSION,
  RequestError,
  type StopReason,
} from "@agentclientprotocol/sdk";
import type { FakeHooks, FakeScript, FakeStep, FakeTurn, RpcFailure } from "./script.ts";

const DEFAULT_TURN: FakeTurn = { steps: [{ kind: "text", text: "ok" }] };

interface PromptState {
  readonly cancelled: Promise<void>;
  readonly markCancelled: () => void;
}

function newPromptState(): PromptState {
  let mark: () => void = () => {};
  const cancelled = new Promise<void>((resolve) => {
    mark = resolve;
  });
  return { cancelled, markCancelled: () => mark() };
}

function rpcError(failure: RpcFailure): RequestError {
  return new RequestError(failure.code, failure.message);
}

function never(): Promise<never> {
  return new Promise(() => {});
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runStep(
  step: FakeStep,
  sessionId: string,
  client: AgentContext,
  state: PromptState,
  hooks: FakeHooks,
): Promise<StopReason | undefined> {
  switch (step.kind) {
    case "text":
      await client.notify(methods.client.session.update, {
        sessionId: step.sessionId ?? sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: step.text } },
      });
      return undefined;
    case "thought":
      await client.notify(methods.client.session.update, {
        sessionId,
        update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: step.text } },
      });
      return undefined;
    case "delay":
      await sleep(step.ms);
      return undefined;
    case "permission": {
      const response = await client.request(methods.client.session.requestPermission, {
        sessionId,
        toolCall: { toolCallId: "fake-permission", title: "Edit a file", kind: "edit", status: "pending" },
        options: step.options.map((kind) => ({ optionId: `opt-${kind}`, name: kind, kind })),
      });
      hooks.record("permission-outcome", response.outcome);
      return undefined;
    }
    case "waitForCancel":
      await state.cancelled;
      return "cancelled";
    case "hang":
      return never();
    case "exit":
      return hooks.exit(step.code, step.stderr);
    case "fail":
      throw rpcError(step.failure);
  }
}

async function runTurn(
  turn: FakeTurn,
  sessionId: string,
  client: AgentContext,
  state: PromptState,
  hooks: FakeHooks,
): Promise<PromptResponse> {
  for (const step of turn.steps) {
    const stop = await runStep(step, sessionId, client, state, hooks);
    if (stop !== undefined) return { stopReason: stop };
  }
  return { stopReason: turn.stopReason ?? "end_turn", ...(turn.usage === undefined ? {} : { usage: turn.usage }) };
}

export function buildFakeAgent(script: FakeScript, hooks: FakeHooks): AgentApp {
  const sessionId = script.sessionId ?? "fake-session-1";
  const turns = script.turns ?? [DEFAULT_TURN];
  const configOptions = [...(script.configOptions ?? [])];
  let promptCount = 0;
  let prompt: PromptState | undefined;
  return agent({ name: "fake-agent" })
    .onRequest(methods.agent.initialize, async (ctx) => {
      hooks.record("initialize", ctx.params);
      if (script.hangInitialize === true) return never();
      if (script.initializeFailure !== undefined) throw rpcError(script.initializeFailure);
      return {
        protocolVersion: script.protocolVersion ?? PROTOCOL_VERSION,
        agentCapabilities: script.capabilities ?? {},
        ...(script.agentInfo === undefined ? {} : { agentInfo: script.agentInfo }),
      };
    })
    .onRequest(methods.agent.session.new, async (ctx) => {
      hooks.record("session/new", ctx.params);
      if (script.newSessionFailure !== undefined) throw rpcError(script.newSessionFailure);
      return { sessionId, ...(script.configOptions === undefined ? {} : { configOptions }) };
    })
    .onRequest(methods.agent.session.setConfigOption, async (ctx) => {
      hooks.record("session/set_config_option", ctx.params);
      if (!configOptions.some((option) => option.id === ctx.params.configId)) {
        throw RequestError.invalidParams(undefined, `unknown config option ${ctx.params.configId}`);
      }
      return { configOptions };
    })
    .onRequest(methods.agent.session.prompt, async (ctx) => {
      hooks.record("session/prompt", ctx.params);
      const turn = turns[Math.min(promptCount, turns.length - 1)] ?? DEFAULT_TURN;
      promptCount += 1;
      prompt = newPromptState();
      return runTurn(turn, ctx.params.sessionId, ctx.client, prompt, hooks);
    })
    .onRequest(methods.agent.session.close, async (ctx) => {
      hooks.record("session/close", ctx.params);
      return {};
    })
    .onNotification(methods.agent.session.cancel, (ctx) => {
      hooks.record("session/cancel", ctx.params);
      prompt?.markCancelled();
    });
}
```

`packages/nax-agent-acp/test/fixtures/fake-agent/main.ts`:

```ts
/**
 * Subprocess entry of the fake ACP agent. FAKE_AGENT_SCRIPT holds the JSON
 * FakeScript. FAKE_AGENT_RECORD, when set, names a file every received request
 * is appended to as one JSON line, after a "start" record with the pid, cwd and
 * which of `recordEnv` are set. Runs under Bun (unit suite) and Node 22+
 * (contract suite, type stripping), so it uses erasable TypeScript only and
 * writes stderr synchronously (pipes are asynchronous on macOS).
 */
import { spawn } from "node:child_process";
import { appendFileSync, writeSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import { ndJsonStream } from "@agentclientprotocol/sdk";
import { buildFakeAgent } from "./agent.ts";
import type { FakeScript } from "./script.ts";

const script: FakeScript = JSON.parse(process.env.FAKE_AGENT_SCRIPT ?? "{}");
const recordPath = process.env.FAKE_AGENT_RECORD;

function record(method: string, params: unknown): void {
  if (recordPath !== undefined) appendFileSync(recordPath, `${JSON.stringify({ method, params })}\n`);
}

function exit(code: number, stderr?: string): never {
  if (stderr !== undefined) writeSync(2, stderr);
  process.exit(code);
}

const startup = script.startup ?? {};
if (startup.ignoreSigterm === true) process.on("SIGTERM", () => {});
record("start", {
  pid: process.pid,
  cwd: process.cwd(),
  env: Object.fromEntries((script.recordEnv ?? []).map((key) => [key, process.env[key] !== undefined])),
});
if (startup.spawnChild === true) record("child", { pid: spawn("sleep", ["30"], { stdio: "ignore" }).pid });
if (startup.stderr !== undefined) writeSync(2, startup.stderr);
if (startup.exitCode !== undefined) exit(startup.exitCode);
if (startup.hang === true) {
  setInterval(() => {}, 60_000);
} else {
  if (startup.garbageLine === true) writeSync(1, "this line is not JSON\n");
  if (startup.oversizedLineBytes !== undefined) writeSync(1, `${"x".repeat(startup.oversizedLineBytes)}\n`);
  buildFakeAgent(script, { record, exit }).connect(
    ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)),
  );
}
```

`packages/nax-agent-acp/test/helpers/fake-process.ts`:

```ts
/** Running the fake ACP agent as a real subprocess, and reading what it recorded. */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { FakeRecord, FakeScript } from "#test/fixtures/fake-agent/script";

export const FAKE_MAIN = fileURLToPath(new URL("../fixtures/fake-agent/main.ts", import.meta.url));

/** The agent env for the fake: PATH, the script, and the record file when given. */
export function fakeEnv(script: FakeScript, recordPath?: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    FAKE_AGENT_SCRIPT: JSON.stringify(script),
    ...(recordPath === undefined ? {} : { FAKE_AGENT_RECORD: recordPath }),
  };
}

export function readRecords(path: string): FakeRecord[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

const START = z.object({ pid: z.number(), cwd: z.string(), env: z.record(z.string(), z.boolean()) });
const CHILD = z.object({ pid: z.number() });

export function startOf(path: string): z.infer<typeof START> {
  return START.parse(readRecords(path).find((r) => r.method === "start")?.params);
}

export function childPidOf(path: string): number | undefined {
  const params = readRecords(path).find((r) => r.method === "child")?.params;
  return params === undefined ? undefined : CHILD.parse(params).pid;
}
```

- [ ] **Step 2: Write the failing launch tests**

`packages/nax-agent-acp/test/unit/client/launch.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isProcessAlive } from "@nathapp/nax-agent";
import { cleanupTempDir, makeTempDir } from "@nathapp/nax-test-kit/bun/temp";
import { waitForCondition } from "@nathapp/nax-test-kit/bun/timeout";
import {
  agentGoneError,
  findExecutable,
  type LaunchedAgent,
  type LaunchRequest,
  launchAgent,
  pickCandidate,
} from "#src/client/launch";
import type { FakeScript } from "#test/fixtures/fake-agent/script";
import { childPidOf, FAKE_MAIN, fakeEnv, readRecords, startOf } from "#test/helpers/fake-process";

let dir: string;
const launched: LaunchedAgent[] = [];

beforeEach(() => {
  dir = makeTempDir("acp-launch-");
});

afterEach(() => {
  for (const agent of launched.splice(0)) agent.kill();
  cleanupTempDir(dir);
});

function fake(script: FakeScript, extra: Partial<LaunchRequest> = {}): { agent: LaunchedAgent; record: string } {
  const record = join(dir, "record.jsonl");
  const agent = launchAgent({
    command: process.execPath,
    args: [FAKE_MAIN],
    cwd: dir,
    env: fakeEnv(script, record),
    ...extra,
  });
  launched.push(agent);
  return { agent, record };
}

describe("findExecutable / pickCandidate (spec §6.10, D-i)", () => {
  test("bare names are looked up on the given PATH; files must be executable; absolute paths are checked as is", () => {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "agent-x"), "#!/bin/sh\n");
    chmodSync(join(bin, "agent-x"), 0o755);
    writeFileSync(join(bin, "not-exec"), "");
    mkdirSync(join(bin, "a-dir"));
    expect(findExecutable("agent-x", bin)).toBe(true);
    expect(findExecutable("not-exec", bin)).toBe(false);
    expect(findExecutable("a-dir", bin)).toBe(false);
    expect(findExecutable("agent-x", undefined)).toBe(false);
    expect(findExecutable(join(bin, "agent-x"), undefined)).toBe(true);
    expect(findExecutable("./bin/agent-x", bin)).toBe(false);
    expect(
      pickCandidate(
        [
          { command: "missing-1", args: [] },
          { command: "agent-x", args: ["acp"] },
        ],
        bin,
      ),
    ).toEqual({ command: "agent-x", args: ["acp"] });
    expect(pickCandidate([{ command: "missing-1", args: [] }], bin)).toBeUndefined();
  });
});

describe("launchAgent (spec §6.1 launch)", () => {
  test("spawns a process-group leader in cwd with exactly the given env", async () => {
    process.env.NAX_ACP_LAUNCH_LEAK = "1";
    try {
      const { agent, record } = fake({ startup: { hang: true }, recordEnv: ["NAX_ACP_LAUNCH_LEAK", "FAKE_AGENT_SCRIPT"] });
      await waitForCondition(() => readRecords(record).length > 0, 5_000);
      const start = startOf(record);
      expect(agent.pid).toBe(start.pid);
      expect(() => process.kill(-start.pid, 0)).not.toThrow();
      expect(realpathSync(start.cwd)).toBe(realpathSync(dir));
      expect(start.env).toEqual({ NAX_ACP_LAUNCH_LEAK: false, FAKE_AGENT_SCRIPT: true });
    } finally {
      delete process.env.NAX_ACP_LAUNCH_LEAK;
    }
  });

  test("stderr feeds the tail; exited and whenGone report the exit code", async () => {
    const { agent } = fake({ startup: { stderr: "fatal: no credentials\n", exitCode: 3 } });
    expect(await agent.exited).toEqual({ code: 3, signal: null });
    expect(await agent.whenGone(1_000)).toEqual({ code: 3, signal: null });
    expect(agent.stderr.excerpt()).toContain("fatal: no credentials");
  });

  test("a command that cannot be spawned resolves exited with spawnError, never throws", async () => {
    const agent = launchAgent({ command: join(dir, "missing-agent"), args: [], cwd: dir, env: {} });
    const exit = await agent.exited;
    expect(exit.spawnError).toContain("ENOENT");
    expect(() => agent.kill()).not.toThrow();
    await agent.terminate(50);
  });

  test("a spawn that throws synchronously (NUL in an argument) also resolves exited with spawnError", async () => {
    const agent = launchAgent({ command: process.execPath, args: ["a\u0000b"], cwd: dir, env: {} });
    expect(agent.pid).toBeUndefined();
    expect((await agent.exited).spawnError).toBeDefined();
    expect(await agent.whenGone(10)).toMatchObject({ code: null, signal: null });
    await agent.terminate(10);
  });

  test("terminate: SIGTERM first", async () => {
    const { agent, record } = fake({ startup: { hang: true } });
    await waitForCondition(() => readRecords(record).length > 0, 5_000);
    await agent.terminate(2_000);
    expect((await agent.exited).signal).toBe("SIGTERM");
  });

  test("terminate: SIGKILL after the grace when SIGTERM is ignored", async () => {
    const { agent, record } = fake({ startup: { hang: true, ignoreSigterm: true } });
    await waitForCondition(() => readRecords(record).length > 0, 5_000);
    await agent.terminate(150);
    expect((await agent.exited).signal).toBe("SIGKILL");
  });

  test("kill reaches the whole process group", async () => {
    const { agent, record } = fake({ startup: { hang: true, spawnChild: true } });
    await waitForCondition(() => childPidOf(record) !== undefined, 5_000);
    const child = childPidOf(record) ?? -1;
    expect(isProcessAlive(child)).toBe(true);
    agent.kill();
    await agent.exited;
    await waitForCondition(() => !isProcessAlive(child), 5_000);
  });

  test("writing to a dead agent does not crash the host (EPIPE is handled)", async () => {
    const { agent } = fake({ startup: { exitCode: 0 } });
    await agent.exited;
    if (agent.target.kind !== "stream") throw new Error("expected a stream target");
    const writer = agent.target.stream.writable.getWriter();
    await writer.write({ jsonrpc: "2.0", method: "ping" }).catch(() => undefined);
    await writer.write({ jsonrpc: "2.0", method: "ping" }).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
});

describe("agentGoneError (spec §6.3, §7)", () => {
  test("BACKEND_UNAVAILABLE with the exit code and a redacted stderr excerpt", async () => {
    const secret = "s3cr3t-token-value-0123";
    const { agent } = fake({ startup: { stderr: `boom ${secret}\n`, exitCode: 2 } });
    await agent.exited;
    const err = await agentGoneError("initialize", agent, [secret]);
    expect(err.code).toBe("AGENT_SESSION_BACKEND_UNAVAILABLE");
    expect(err.message).toContain("exited with code 2 during initialize");
    expect(err.message).not.toContain(secret);
    expect(err.context).toMatchObject({ during: "initialize", exitCode: 2, signal: null });
    expect(String(err.context?.stderr)).toContain("boom [REDACTED]");
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `cd packages/nax-agent-acp && bun test ./test/unit/client/launch.test.ts`
Expected: FAIL, "Cannot find module '#src/client/launch'".

- [ ] **Step 4: Implement**

`packages/nax-agent-acp/src/client/launch.ts`:

```ts
/**
 * Spawning an ACP agent (S4 spec §6.1 launch). The agent is a process-group
 * leader, so a kill reaches its children (npx, node, the adapter's own tools).
 * Its stdio becomes an ndjson ACP stream and its stderr feeds a bounded tail.
 * A spawn failure is never thrown: `exited` resolves with spawnError. Pipe
 * errors (EPIPE after the agent died) are absorbed so they cannot crash the host.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { Readable, Writable } from "node:stream";
import { type AgentApp, type AnyMessage, ndJsonStream, type Stream } from "@agentclientprotocol/sdk";
import {
  type AgentSessionError,
  createStderrTail,
  killProcessGroup,
  type StderrTail,
} from "@nathapp/nax-agent";
import { agentTextExcerpt, backendUnavailable, EXCERPT_BYTES } from "#src/client/errors";
import { race } from "#src/client/race";
import type { LaunchCandidate } from "#src/client/registry";

/** How long a transport failure waits for the exit status. */
const GONE_WAIT_MS = 1_000;
/** How long, after the exit, the last stderr may take to arrive. */
const STDERR_DRAIN_MS = 200;

export type LaunchTarget =
  | { readonly kind: "stream"; readonly stream: Stream }
  /** An in-process agent: the unit suite's fake (D-k). */
  | { readonly kind: "app"; readonly agent: AgentApp };

export interface AgentExit {
  readonly code: number | null;
  readonly signal: string | null;
  /** Set when the process never started (for example ENOENT). */
  readonly spawnError?: string;
}

export interface LaunchedAgent {
  readonly target: LaunchTarget;
  readonly pid: number | undefined;
  readonly stderr: StderrTail;
  /** Resolves once, when the process is gone. Never rejects. */
  readonly exited: Promise<AgentExit>;
  /** The exit once the process has exited (and its stderr drained), or undefined after `waitMs`. */
  whenGone(waitMs: number): Promise<AgentExit | undefined>;
  /** Closes stdin, SIGTERMs the group, SIGKILLs it after `graceMs`; resolves once exited. */
  terminate(graceMs: number): Promise<void>;
  /** SIGKILLs the group now. */
  kill(): void;
}

export interface LaunchRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  /** The SDK default when absent. */
  readonly maxMessageBytes?: number;
}

export type LaunchFn = (request: LaunchRequest) => LaunchedAgent;

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** True when `command` is an absolute executable path, or a bare name found on `pathVar`. */
export function findExecutable(command: string, pathVar: string | undefined): boolean {
  if (command.includes("/")) return isAbsolute(command) && isExecutableFile(command);
  return (pathVar ?? "").split(delimiter).some((dir) => dir !== "" && isExecutableFile(join(dir, command)));
}

/** The first candidate whose command is found (§6.10: tried in order). */
export function pickCandidate(
  candidates: readonly LaunchCandidate[],
  pathVar: string | undefined,
): LaunchCandidate | undefined {
  return candidates.find((candidate) => findExecutable(candidate.command, pathVar));
}

function ignore(): void {}

function failedLaunch(stderr: StderrTail, error: unknown): LaunchedAgent {
  const exit: AgentExit = { code: null, signal: null, spawnError: error instanceof Error ? error.message : String(error) };
  const stream: Stream = {
    readable: new ReadableStream<AnyMessage>({ start: (controller) => controller.close() }),
    writable: new WritableStream<AnyMessage>(),
  };
  return {
    target: { kind: "stream", stream },
    pid: undefined,
    stderr,
    exited: Promise.resolve(exit),
    whenGone: async () => exit,
    terminate: async () => {},
    kill: ignore,
  };
}

function trySpawn(request: LaunchRequest): ChildProcessWithoutNullStreams | { readonly error: unknown } {
  try {
    return spawn(request.command, [...request.args], {
      cwd: request.cwd,
      env: { ...request.env },
      stdio: "pipe",
      detached: true,
    });
  } catch (error) {
    return { error };
  }
}

export function launchAgent(request: LaunchRequest): LaunchedAgent {
  const stderr = createStderrTail();
  const child = trySpawn(request);
  if ("error" in child) return failedLaunch(stderr, child.error);
  return startedLaunch(child, stderr, request.maxMessageBytes);
}

function startedLaunch(
  child: ChildProcessWithoutNullStreams,
  stderr: StderrTail,
  maxMessageBytes: number | undefined,
): LaunchedAgent {
  const exited = new Promise<AgentExit>((resolve) => {
    child.once("error", (error) => resolve({ code: null, signal: null, spawnError: error.message }));
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const stderrEnded = new Promise<void>((resolve) => child.stderr.once("close", () => resolve()));
  child.stdin.on("error", ignore);
  child.stdout.on("error", ignore);
  child.stderr.on("error", ignore);
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  const stream = ndJsonStream(
    Writable.toWeb(child.stdin),
    Readable.toWeb(child.stdout),
    maxMessageBytes === undefined ? undefined : { maxMessageBytes },
  );
  const pid = child.pid;
  let gone = false;
  void exited.then(() => {
    gone = true;
  });
  const kill = (): void => {
    if (!gone && pid !== undefined) killProcessGroup(pid, "SIGKILL");
  };
  return {
    target: { kind: "stream", stream },
    pid,
    stderr,
    exited,
    kill,
    async whenGone(waitMs) {
      const exit = await race(exited, { timeoutMs: waitMs });
      if (exit.kind !== "ok") return undefined;
      await race(stderrEnded, { timeoutMs: STDERR_DRAIN_MS });
      return exit.value;
    },
    async terminate(graceMs) {
      if (!gone && pid !== undefined) {
        child.stdin.end();
        killProcessGroup(pid, "SIGTERM");
        const timer = setTimeout(kill, graceMs);
        await exited;
        clearTimeout(timer);
      }
      await exited;
    },
  };
}

function describeExit(exit: AgentExit | undefined, during: string, secrets: readonly string[]): string {
  if (exit === undefined) return `its connection closed during ${during}`;
  if (exit.spawnError !== undefined) return `it could not be started (${agentTextExcerpt(exit.spawnError, secrets)})`;
  if (exit.signal !== null) return `it was killed by ${exit.signal} during ${during}`;
  return `it exited with code ${String(exit.code)} during ${during}`;
}

/** The agent process died or its stream closed: BACKEND_UNAVAILABLE with the exit and a redacted stderr excerpt. */
export async function agentGoneError(
  during: string,
  launched: LaunchedAgent,
  secrets: readonly string[],
): Promise<AgentSessionError> {
  const exit = await launched.whenGone(GONE_WAIT_MS);
  const stderr = launched.stderr.excerpt({ maxBytes: EXCERPT_BYTES, secrets });
  const what = describeExit(exit, during, secrets);
  const exitDetails =
    exit === undefined
      ? {}
      : { exitCode: exit.code, signal: exit.signal, ...(exit.spawnError === undefined ? {} : { spawnError: true }) };
  return backendUnavailable(stderr === "" ? what : `${what}; stderr: ${stderr}`, { during, ...exitDetails, stderr });
}
```

If `bun run typecheck` rejects the `Writable.toWeb(...)` / `Readable.toWeb(...)` arguments (a `node:stream/web` vs global stream type mismatch), change only those two arguments to `Writable.toWeb(child.stdin) as WritableStream<Uint8Array>` and `Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>`. Do the same in `main.ts`. Change nothing else.

- [ ] **Step 5: Run them to verify they pass**

Run: `cd packages/nax-agent-acp && bun test ./test/unit/client/launch.test.ts && bun run typecheck`
Expected: PASS, typecheck exit 0. If the fake fails under Bun's stream interop (spec §12 risk), stop and report. Do not paper over it.

- [ ] **Step 6: Commit**

```bash
cd packages/nax-agent-acp && bun run lint:fix && cd ../..
git add packages/nax-agent-acp/src/client/launch.ts packages/nax-agent-acp/test/fixtures packages/nax-agent-acp/test/helpers/fake-process.ts packages/nax-agent-acp/test/unit/client/launch.test.ts
git commit -m "feat(nax-agent-acp): agent launch as a process-group leader, and the fake ACP agent"
```

---

### Task 6: Connection, inbound routing, text events

**Files:**
- Create: `packages/nax-agent-acp/src/client/connection.ts`, `src/client/events.ts`, `src/client/inbound.ts`
- Test: `packages/nax-agent-acp/test/unit/client/connection.test.ts`, `test/unit/client/events.test.ts`, `test/unit/client/inbound.test.ts`

**Interfaces:**
- Consumes: `LaunchTarget`, `launchAgent` (Task 5); `buildFakeAgent` (Task 5); `TurnEventSink` from nax-agent.
- Produces:
  - `interface InboundHandlers { onUpdate(n: SessionNotification): void; onPermission(r: RequestPermissionRequest): Promise<RequestPermissionResponse> }`
  - `interface AcpLink { initialize(p); newSession(p); setConfigOption(p); prompt(p); cancel(sessionId); closeSession(sessionId); closed: Promise<void>; close(reason?) }`
  - `openConnection(target: LaunchTarget, handlers: InboundHandlers): AcpLink`
  - `interface TurnCollector { onUpdate(update: SessionUpdate): void; output(): string }`
  - `createTurnCollector(emit: TurnEventSink | undefined): TurnCollector`
  - `rejectLocally(request): RequestPermissionResponse`
  - `interface InboundRouter { handlers; attach(agentSessionId: string, collector: TurnCollector): () => void }`
  - `createInboundRouter(): InboundRouter`

- [ ] **Step 1: Write the failing tests**

`packages/nax-agent-acp/test/unit/client/connection.test.ts`:

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { PROTOCOL_VERSION, RequestError, type SessionNotification } from "@agentclientprotocol/sdk";
import { cleanupTempDir, makeTempDir } from "@nathapp/nax-test-kit/bun/temp";
import { type AcpLink, type InboundHandlers, openConnection } from "#src/client/connection";
import { rejectLocally } from "#src/client/inbound";
import { type LaunchedAgent, launchAgent } from "#src/client/launch";
import { race } from "#src/client/race";
import { buildFakeAgent } from "#test/fixtures/fake-agent/agent";
import type { FakeRecord, FakeScript } from "#test/fixtures/fake-agent/script";
import { FAKE_MAIN, fakeEnv } from "#test/helpers/fake-process";

const links: AcpLink[] = [];
const agents: LaunchedAgent[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const link of links.splice(0)) link.close();
  for (const agent of agents.splice(0)) agent.kill();
  for (const dir of dirs.splice(0)) cleanupTempDir(dir);
});

function pair(script: FakeScript, handlers: Partial<InboundHandlers> = {}) {
  const calls: FakeRecord[] = [];
  const updates: SessionNotification[] = [];
  const app = buildFakeAgent(script, {
    record: (method, params) => {
      calls.push({ method, params });
    },
    exit: () => {
      throw new Error("no exit in process");
    },
  });
  const link = openConnection(
    { kind: "app", agent: app },
    { onUpdate: (n) => updates.push(n), onPermission: async (r) => rejectLocally(r), ...handlers },
  );
  links.push(link);
  const callsTo = (method: string) => calls.filter((c) => c.method === method).map((c) => c.params);
  return { link, updates, callsTo };
}

const INIT = { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} };

describe("openConnection: outbound requests (spec §6.1 connection)", () => {
  test("initialize, session/new, set_config_option and session/close reach the agent", async () => {
    const { link, callsTo } = pair({
      agentInfo: { name: "fake", version: "1.0.0" },
      configOptions: [
        { id: "mode", name: "Mode", type: "select", currentValue: "a", options: [{ value: "a", name: "A" }] },
      ],
    });
    expect(await link.initialize(INIT)).toMatchObject({ protocolVersion: 1, agentInfo: { name: "fake" } });
    expect(callsTo("initialize")).toEqual([INIT]);
    expect((await link.newSession({ cwd: "/w", mcpServers: [] })).sessionId).toBe("fake-session-1");
    const set = await link.setConfigOption({ sessionId: "fake-session-1", configId: "mode", value: "a" });
    expect(set.configOptions).toHaveLength(1);
    await link.closeSession("fake-session-1");
    expect(callsTo("session/close")).toEqual([{ sessionId: "fake-session-1" }]);
  });

  test("session/update reaches onUpdate before the prompt resolves", async () => {
    const { link, updates } = pair({
      turns: [{ steps: [{ kind: "text", text: "a" }, { kind: "text", text: "b" }] }],
    });
    await link.initialize(INIT);
    await link.newSession({ cwd: "/w", mcpServers: [] });
    const response = await link.prompt({ sessionId: "fake-session-1", prompt: [{ type: "text", text: "hi" }] });
    expect(response.stopReason).toBe("end_turn");
    expect(updates.map((u) => u.update.sessionUpdate)).toEqual(["agent_message_chunk", "agent_message_chunk"]);
  });

  test("a permission request reaches onPermission and its answer reaches the agent", async () => {
    const { link, callsTo } = pair({
      turns: [{ steps: [{ kind: "permission", options: ["allow_once", "reject_once"] }] }],
    });
    await link.initialize(INIT);
    await link.newSession({ cwd: "/w", mcpServers: [] });
    await link.prompt({ sessionId: "fake-session-1", prompt: [{ type: "text", text: "x" }] });
    expect(callsTo("permission-outcome")).toEqual([{ outcome: "selected", optionId: "opt-reject_once" }]);
  });

  test("session/cancel reaches the agent", async () => {
    const { link, callsTo } = pair({ turns: [{ steps: [{ kind: "waitForCancel" }] }] });
    await link.initialize(INIT);
    await link.newSession({ cwd: "/w", mcpServers: [] });
    const prompt = link.prompt({ sessionId: "fake-session-1", prompt: [{ type: "text", text: "x" }] });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await link.cancel("fake-session-1");
    expect((await prompt).stopReason).toBe("cancelled");
    expect(callsTo("session/cancel")).toEqual([{ sessionId: "fake-session-1" }]);
  });

  test("an agent's JSON-RPC error arrives as a RequestError with its code", async () => {
    const { link } = pair({ initializeFailure: { code: -32000, message: "login first" } });
    const raced = await race(link.initialize(INIT), { timeoutMs: 2_000 });
    if (raced.kind !== "failed") throw new Error(`expected failed, got ${raced.kind}`);
    expect(raced.error).toBeInstanceOf(RequestError);
    expect(raced.error instanceof RequestError ? raced.error.code : 0).toBe(-32000);
  });

  test("close() rejects a pending request and resolves closed", async () => {
    const { link } = pair({ hangInitialize: true });
    const pending = race(link.initialize(INIT), { timeoutMs: 2_000 });
    link.close();
    expect((await pending).kind).toBe("failed");
    expect((await race(link.closed, { timeoutMs: 2_000 })).kind).toBe("ok");
  });
});

describe("openConnection over a real subprocess", () => {
  function spawnFake(script: FakeScript, maxMessageBytes?: number): AcpLink {
    const dir = makeTempDir("acp-conn-");
    dirs.push(dir);
    const agent = launchAgent({
      command: process.execPath,
      args: [FAKE_MAIN],
      cwd: dir,
      env: fakeEnv(script, join(dir, "record.jsonl")),
      ...(maxMessageBytes === undefined ? {} : { maxMessageBytes }),
    });
    agents.push(agent);
    const link = openConnection(agent.target, { onUpdate: () => {}, onPermission: async (r) => rejectLocally(r) });
    links.push(link);
    return link;
  }

  test("a line that is not JSON is skipped", async () => {
    const link = spawnFake({ startup: { garbageLine: true } });
    expect((await race(link.initialize(INIT), { timeoutMs: 10_000 })).kind).toBe("ok");
  });

  test("a frame over maxMessageBytes ends the connection: the pending request fails", async () => {
    const link = spawnFake({ startup: { oversizedLineBytes: 4_096 } }, 1_024);
    expect((await race(link.initialize(INIT), { timeoutMs: 10_000 })).kind).toBe("failed");
  });
});
```

`packages/nax-agent-acp/test/unit/client/events.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { TurnEvent } from "@nathapp/nax-agent";
import { createTurnCollector } from "#src/client/events";

describe("createTurnCollector (spec §6.7, text rows; D-e)", () => {
  test("agent text becomes text_delta (round 0) and the turn output", () => {
    const events: TurnEvent[] = [];
    const collector = createTurnCollector((e) => events.push(e));
    collector.onUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hel" } });
    collector.onUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "lo" } });
    expect(events).toEqual([
      { type: "text_delta", round: 0, text: "Hel" },
      { type: "text_delta", round: 0, text: "lo" },
    ]);
    expect(collector.output()).toBe("Hello");
  });

  test("non-text chunks, thoughts and tool updates are dropped until S4-5", () => {
    const events: TurnEvent[] = [];
    const collector = createTurnCollector((e) => events.push(e));
    collector.onUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "image", data: "AAAA", mimeType: "image/png" },
    });
    collector.onUpdate({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hmm" } });
    collector.onUpdate({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Read" });
    expect(events).toEqual([]);
    expect(collector.output()).toBe("");
  });

  test("a throwing sink does not break collection; no sink is allowed", () => {
    const collector = createTurnCollector(() => {
      throw new Error("sink broke");
    });
    collector.onUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "x" } });
    expect(collector.output()).toBe("x");
    const silent = createTurnCollector(undefined);
    silent.onUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "y" } });
    expect(silent.output()).toBe("y");
  });
});
```

`packages/nax-agent-acp/test/unit/client/inbound.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { PermissionOptionKind, RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { createTurnCollector } from "#src/client/events";
import { createInboundRouter, rejectLocally } from "#src/client/inbound";

function request(kinds: readonly PermissionOptionKind[]): RequestPermissionRequest {
  return {
    sessionId: "s",
    toolCall: { toolCallId: "t" },
    options: kinds.map((kind) => ({ optionId: `opt-${kind}`, name: kind, kind })),
  };
}

const text = (t: string) => ({
  sessionUpdate: "agent_message_chunk" as const,
  content: { type: "text" as const, text: t },
});

describe("rejectLocally (D-d: fail closed until S4-3)", () => {
  test("picks reject_once; never an allow or reject_always option", () => {
    expect(rejectLocally(request(["allow_once", "allow_always", "reject_always", "reject_once"]))).toEqual({
      outcome: { outcome: "selected", optionId: "opt-reject_once" },
    });
  });

  test("cancelled when the agent offered no reject_once", () => {
    expect(rejectLocally(request(["allow_once", "reject_always"]))).toEqual({ outcome: { outcome: "cancelled" } });
  });

  test("a malformed options list is cancelled, not a crash", () => {
    const malformed: RequestPermissionRequest = JSON.parse('{"sessionId":"s","toolCall":{"toolCallId":"t"},"options":null}');
    expect(rejectLocally(malformed)).toEqual({ outcome: { outcome: "cancelled" } });
  });
});

describe("createInboundRouter (spec §6.3 inbound with no active turn)", () => {
  test("routes updates for the attached session only, and only while attached", async () => {
    const router = createInboundRouter();
    const collector = createTurnCollector(undefined);
    router.handlers.onUpdate({ sessionId: "a", update: text("before") });
    const release = router.attach("a", collector);
    router.handlers.onUpdate({ sessionId: "a", update: text("mine") });
    router.handlers.onUpdate({ sessionId: "b", update: text("theirs") });
    release();
    router.handlers.onUpdate({ sessionId: "a", update: text("after") });
    expect(collector.output()).toBe("mine");
    expect(await router.handlers.onPermission(request(["reject_once"]))).toEqual({
      outcome: { outcome: "selected", optionId: "opt-reject_once" },
    });
  });

  test("releasing a stale binding does not detach a newer one", () => {
    const router = createInboundRouter();
    const first = createTurnCollector(undefined);
    const second = createTurnCollector(undefined);
    const releaseFirst = router.attach("a", first);
    router.attach("a", second);
    releaseFirst();
    router.handlers.onUpdate({ sessionId: "a", update: text("x") });
    expect(second.output()).toBe("x");
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd packages/nax-agent-acp && bun test ./test/unit/client/connection.test.ts ./test/unit/client/events.test.ts ./test/unit/client/inbound.test.ts`
Expected: FAIL, "Cannot find module '#src/client/connection'" (and events, inbound).

- [ ] **Step 3: Implement**

`packages/nax-agent-acp/src/client/connection.ts`:

```ts
/**
 * The ACP client connection (S4 spec §6.1 connection). One ClientApp per agent
 * process, attached with connect() for the session's lifetime (not connectWith).
 * Outbound calls use the connection's request API directly; inbound
 * session/update and session/request_permission go to the backend's handlers.
 * Requests are not bounded here: callers race them (race.ts), because the SDK's
 * cancellation is cooperative and still waits for the agent's answer.
 */
import {
  type ClientConnection,
  client,
  type InitializeRequest,
  type InitializeResponse,
  methods,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
} from "@agentclientprotocol/sdk";
import type { LaunchTarget } from "#src/client/launch";

export interface InboundHandlers {
  onUpdate(notification: SessionNotification): void;
  onPermission(request: RequestPermissionRequest): Promise<RequestPermissionResponse>;
}

export interface AcpLink {
  initialize(params: InitializeRequest): Promise<InitializeResponse>;
  newSession(params: NewSessionRequest): Promise<NewSessionResponse>;
  setConfigOption(params: SetSessionConfigOptionRequest): Promise<SetSessionConfigOptionResponse>;
  prompt(params: PromptRequest): Promise<PromptResponse>;
  cancel(sessionId: string): Promise<void>;
  closeSession(sessionId: string): Promise<void>;
  /** Resolves when the connection closes, for any reason. */
  readonly closed: Promise<void>;
  /** Closes the connection; pending requests reject. */
  close(reason?: unknown): void;
}

export function openConnection(target: LaunchTarget, handlers: InboundHandlers): AcpLink {
  const app = client({ name: "nax-agent-acp" })
    .onNotification(methods.client.session.update, (ctx) => handlers.onUpdate(ctx.params))
    .onRequest(methods.client.session.requestPermission, (ctx) => handlers.onPermission(ctx.params));
  const connection: ClientConnection =
    target.kind === "stream" ? app.connect(target.stream) : app.connect(target.agent);
  const agent = connection.agent;
  return {
    initialize: (params) => agent.request(methods.agent.initialize, params),
    newSession: (params) => agent.request(methods.agent.session.new, params),
    setConfigOption: (params) => agent.request(methods.agent.session.setConfigOption, params),
    prompt: (params) => agent.request(methods.agent.session.prompt, params),
    cancel: (sessionId) => agent.notify(methods.agent.session.cancel, { sessionId }),
    closeSession: async (sessionId) => {
      await agent.request(methods.agent.session.close, { sessionId });
    },
    closed: connection.closed,
    close: (reason) => connection.close(reason),
  };
}
```

`packages/nax-agent-acp/src/client/events.ts`:

```ts
/**
 * session/update -> TurnEvent (S4 spec §6.7). S4-2 maps agent text only: each
 * agent_message_chunk text is a text_delta (round 0) and joins the turn's output.
 * S4-5 adds thoughts, tool calls, tool results and usage; every other update is
 * dropped until then (D-e). The sink is the facade's; a throw from it is contained.
 */
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type { TurnEvent, TurnEventSink } from "@nathapp/nax-agent";

export interface TurnCollector {
  onUpdate(update: SessionUpdate): void;
  /** The turn's concatenated agent message text (turn_end.output). */
  output(): string;
}

export function createTurnCollector(emit: TurnEventSink | undefined): TurnCollector {
  const parts: string[] = [];
  const send = (event: TurnEvent): void => {
    try {
      emit?.(event);
    } catch {
      // The sink is the facade's event channel; a broken consumer must not break the turn.
    }
  };
  return {
    onUpdate(update) {
      if (update.sessionUpdate !== "agent_message_chunk" || update.content.type !== "text") return;
      parts.push(update.content.text);
      send({ type: "text_delta", round: 0, text: update.content.text });
    },
    output: () => parts.join(""),
  };
}
```

`packages/nax-agent-acp/src/client/inbound.ts`:

```ts
/**
 * Messages the agent initiates (S4 spec §6.3 "Inbound requests with no active
 * turn"). session/update reaches the running turn's collector only when it names
 * the attached agent session; anything else is dropped. S4-2 answers every
 * session/request_permission locally with the agent's reject_once option, or
 * `cancelled` when it offered none: fail closed, no event (D-d). S4-3 routes
 * them by profile (§6.4).
 */
import type { RequestPermissionRequest, RequestPermissionResponse } from "@agentclientprotocol/sdk";
import type { InboundHandlers } from "#src/client/connection";
import type { TurnCollector } from "#src/client/events";

export interface InboundRouter {
  readonly handlers: InboundHandlers;
  /** Routes updates for `agentSessionId` to `collector`; the returned function detaches it. */
  attach(agentSessionId: string, collector: TurnCollector): () => void;
}

export function rejectLocally(request: RequestPermissionRequest): RequestPermissionResponse {
  const options = Array.isArray(request.options) ? request.options : [];
  const reject = options.find((option) => option.kind === "reject_once");
  return reject === undefined
    ? { outcome: { outcome: "cancelled" } }
    : { outcome: { outcome: "selected", optionId: reject.optionId } };
}

interface Binding {
  readonly sessionId: string;
  readonly collector: TurnCollector;
}

export function createInboundRouter(): InboundRouter {
  let active: Binding | undefined;
  return {
    handlers: {
      onUpdate(notification) {
        if (active !== undefined && notification.sessionId === active.sessionId) {
          active.collector.onUpdate(notification.update);
        }
      },
      onPermission: async (request) => rejectLocally(request),
    },
    attach(sessionId, collector) {
      const binding: Binding = { sessionId, collector };
      active = binding;
      return () => {
        if (active === binding) active = undefined;
      };
    },
  };
}
```

- [ ] **Step 4: Run them to verify they pass**

Run: `cd packages/nax-agent-acp && bun test ./test/unit/client/connection.test.ts ./test/unit/client/events.test.ts ./test/unit/client/inbound.test.ts && bun run typecheck`
Expected: PASS, typecheck exit 0.

- [ ] **Step 5: Commit**

```bash
cd packages/nax-agent-acp && bun run lint:fix && cd ../..
git add packages/nax-agent-acp/src/client/connection.ts packages/nax-agent-acp/src/client/events.ts packages/nax-agent-acp/src/client/inbound.ts packages/nax-agent-acp/test/unit/client/connection.test.ts packages/nax-agent-acp/test/unit/client/events.test.ts packages/nax-agent-acp/test/unit/client/inbound.test.ts
git commit -m "feat(nax-agent-acp): ACP client connection, inbound routing and text events"
```

---

### Task 7: The open sequence

**Files:**
- Create: `packages/nax-agent-acp/src/client/open.ts`
- Create: `packages/nax-agent-acp/test/helpers/in-memory-launch.ts`, `test/helpers/open-context.ts`
- Test: `packages/nax-agent-acp/test/unit/client/open.test.ts`

**Interfaces:**
- Consumes: Tasks 2 to 6. From nax-agent: `BackendOpenContext`, `TranscriptDoc`, `NaxError`, `createMemoryTranscriptStore`, `createStderrTail`.
- Produces:
  - `interface OpenedAcp { launched: LaunchedAgent; link: AcpLink; record: CapabilityRecord; agentSessionId: string }`
  - `openAcpSession(options: ResolvedAcpOptions, ctx: BackendOpenContext, handlers: InboundHandlers, launch: LaunchFn): Promise<OpenedAcp>`
  - Test helpers:
    - `inMemoryAgent(script?: FakeScript): InMemoryAgent`, where `InMemoryAgent` has `launch`, `requests`, `callsTo(method)`, `kills()`, `terminations()`
    - `openContext(workdir: string, overrides?: Partial<BackendOpenContext>): BackendOpenContext`

- [ ] **Step 1: Write the helpers and the failing tests**

`packages/nax-agent-acp/test/helpers/in-memory-launch.ts`:

```ts
/**
 * An in-process ACP agent for the unit suite (D-k): `launch` hands the backend
 * the fake agent's AgentApp instead of a process. kill() and terminate() end it
 * the way a real exit would (the backend then closes the connection) and are
 * counted, so tests can assert "the process group was killed".
 */
import { createStderrTail } from "@nathapp/nax-agent";
import type { AgentExit, LaunchedAgent, LaunchFn, LaunchRequest } from "#src/client/launch";
import { buildFakeAgent } from "#test/fixtures/fake-agent/agent";
import type { FakeRecord, FakeScript } from "#test/fixtures/fake-agent/script";

export interface InMemoryAgent {
  readonly launch: LaunchFn;
  readonly requests: readonly LaunchRequest[];
  callsTo(method: string): readonly unknown[];
  kills(): number;
  terminations(): number;
}

export function inMemoryAgent(script: FakeScript = {}): InMemoryAgent {
  const calls: FakeRecord[] = [];
  const requests: LaunchRequest[] = [];
  const counts = { kills: 0, terminations: 0 };
  const launch: LaunchFn = (request) => {
    requests.push(request);
    let end: (exit: AgentExit) => void = () => {};
    const exited = new Promise<AgentExit>((resolve) => {
      end = resolve;
    });
    const app = buildFakeAgent(script, {
      record: (method, params) => {
        calls.push({ method, params });
      },
      exit: () => {
        throw new Error("the exit step needs the subprocess fake (backend-process.test.ts)");
      },
    });
    const launched: LaunchedAgent = {
      target: { kind: "app", agent: app },
      pid: undefined,
      stderr: createStderrTail(),
      exited,
      whenGone: (waitMs) =>
        Promise.race([exited, new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), waitMs))]),
      terminate: async () => {
        counts.terminations += 1;
        end({ code: 0, signal: null });
      },
      kill: () => {
        counts.kills += 1;
        end({ code: null, signal: "SIGKILL" });
      },
    };
    return launched;
  };
  return {
    launch,
    requests,
    callsTo: (method) => calls.filter((call) => call.method === method).map((call) => call.params),
    kills: () => counts.kills,
    terminations: () => counts.terminations,
  };
}
```

`packages/nax-agent-acp/test/helpers/open-context.ts`:

```ts
/** A complete BackendOpenContext for calling a backend's open() directly. */
import { type BackendOpenContext, createMemoryTranscriptStore } from "@nathapp/nax-agent";

const IDLE = new AbortController().signal;

export function openContext(workdir: string, overrides: Partial<BackendOpenContext> = {}): BackendOpenContext {
  return {
    sessionId: "session-1",
    workdir,
    profile: "full",
    instructions: undefined,
    tools: [],
    transcriptStore: createMemoryTranscriptStore(),
    resume: undefined,
    asks: {
      requestApproval: async () => ({ decision: "deny", decidedBy: "profile" }),
      recordAutoDecision: () => {},
      askQuestion: async () => null,
      noteQuestion: () => {},
    },
    turnSignal: () => IDLE,
    currentTurnId: () => undefined,
    turnTimeoutSeconds: 600,
    metadata: {},
    openSignal: IDLE,
    ...overrides,
  };
}
```

`packages/nax-agent-acp/test/unit/client/open.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createMemoryTranscriptStore, type TranscriptStore } from "@nathapp/nax-agent";
import { cleanupTempDir, makeTempDir } from "@nathapp/nax-test-kit/bun/temp";
import { createInboundRouter } from "#src/client/inbound";
import { openAcpSession } from "#src/client/open";
import { type AcpBackendOptions, resolveAcpOptions } from "#src/client/options";
import { CLAUDE_CONFIG_OPTIONS, type FakeScript } from "#test/fixtures/fake-agent/script";
import { rejection, sessionError } from "#test/helpers/errors";
import { inMemoryAgent } from "#test/helpers/in-memory-launch";
import { openContext } from "#test/helpers/open-context";

const SECRET = "s3cr3t-token-value-0123";
let dir: string;

beforeEach(() => {
  dir = makeTempDir("acp-open-");
});

afterEach(() => cleanupTempDir(dir));

const CLAUDE_SCRIPT: FakeScript = {
  agentInfo: { name: "claude-agent-acp", version: "0.85.1" },
  configOptions: CLAUDE_CONFIG_OPTIONS,
};

function options(extra: Partial<AcpBackendOptions> = {}) {
  return resolveAcpOptions(
    { agent: "claude", allowUnsandboxed: true, command: "fake-claude", env: { MY_TOKEN: SECRET }, ...extra },
    { PATH: "/usr/bin" },
  );
}

async function openWith(script: FakeScript, extra: Partial<AcpBackendOptions> = {}, store?: TranscriptStore) {
  const fake = inMemoryAgent(script);
  const ctx = openContext(dir, store === undefined ? {} : { transcriptStore: store });
  const opened = openAcpSession(options(extra), ctx, createInboundRouter().handlers, fake.launch);
  return { fake, ctx, opened };
}

describe("openAcpSession: the happy path (spec §6.3 step 1)", () => {
  test("launches the explicit command in workdir with the resolved env, then initialize, session/new, mode", async () => {
    const { fake, ctx, opened } = await openWith(CLAUDE_SCRIPT);
    const acp = await opened;
    expect(fake.requests).toEqual([
      { command: "fake-claude", args: [], cwd: dir, env: { PATH: "/usr/bin", MY_TOKEN: SECRET } },
    ]);
    expect(fake.callsTo("initialize")).toEqual([{ protocolVersion: 1, clientCapabilities: {} }]);
    expect(fake.callsTo("session/new")).toEqual([{ cwd: dir, mcpServers: [] }]);
    expect(fake.callsTo("session/set_config_option")).toEqual([
      { sessionId: "fake-session-1", configId: "mode", value: "default" },
    ]);
    expect(acp.agentSessionId).toBe("fake-session-1");
    expect(acp.record).toMatchObject({ agentName: "claude-agent-acp", readOnlyMode: true });
    expect(await ctx.transcriptStore.load("session-1")).toMatchObject({
      backend: "acp:claude",
      acp: { agentSessionId: "fake-session-1", agent: "claude", agentVersion: "0.85.1", cwd: dir },
      messages: [],
    });
    expect(fake.kills()).toBe(0);
  });

  test("model: applied after the mode through the model option", async () => {
    const { fake, opened } = await openWith(CLAUDE_SCRIPT, { model: "sonnet" });
    await opened;
    expect(fake.callsTo("session/set_config_option")).toEqual([
      { sessionId: "fake-session-1", configId: "mode", value: "default" },
      { sessionId: "fake-session-1", configId: "model", value: "sonnet" },
    ]);
  });

  test("a registry agent launches the first candidate found on the agent env's PATH", async () => {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const fake = inMemoryAgent({});
    const resolved = resolveAcpOptions(
      { agent: "gemini", allowUnsandboxed: true, env: { PATH: bin } },
      { PATH: "/usr/bin" },
    );
    const err = sessionError(
      await rejection(openAcpSession(resolved, openContext(dir), createInboundRouter().handlers, fake.launch)),
    );
    expect(err.code).toBe("AGENT_SESSION_BACKEND_UNAVAILABLE");
    expect(err.message).toContain("gemini");
    expect(fake.requests).toHaveLength(0);
  });
});

describe("openAcpSession: every failure after the spawn kills the agent (Review Focus 1)", () => {
  test.each<[string, FakeScript, Partial<AcpBackendOptions>, string]>([
    ["protocol version mismatch", { ...CLAUDE_SCRIPT, protocolVersion: 2 }, {}, "AGENT_SESSION_BACKEND_UNAVAILABLE"],
    [
      "auth error at initialize",
      { initializeFailure: { code: -32000, message: "login" } },
      {},
      "AGENT_SESSION_AUTH_REQUIRED",
    ],
    [
      "auth error at session/new",
      { ...CLAUDE_SCRIPT, newSessionFailure: { code: -32000, message: "login" } },
      {},
      "AGENT_SESSION_AUTH_REQUIRED",
    ],
    [
      "other error at session/new",
      { ...CLAUDE_SCRIPT, newSessionFailure: { code: -32603, message: `boom ${SECRET}` } },
      {},
      "AGENT_SESSION_BACKEND_UNAVAILABLE",
    ],
    ["initialize timeout", { hangInitialize: true }, { initializeTimeoutMs: 30 }, "AGENT_SESSION_BACKEND_UNAVAILABLE"],
    ["no mode option (claude)", { configOptions: [] }, {}, "AGENT_SESSION_CAPABILITY_UNSUPPORTED"],
    ["model not offered", CLAUDE_SCRIPT, { model: "gpt-9" }, "AGENT_SESSION_CAPABILITY_UNSUPPORTED"],
    ["empty agent session id", { ...CLAUDE_SCRIPT, sessionId: "" }, {}, "AGENT_SESSION_BACKEND_UNAVAILABLE"],
  ])("%s -> %s", async (_name, script, extra, code) => {
    const { fake, ctx, opened } = await openWith(script, extra);
    const err = sessionError(await rejection(opened));
    expect(err.code).toBe(code);
    expect(err.message).not.toContain(SECRET);
    expect(fake.kills()).toBe(1);
    expect(await ctx.transcriptStore.load("session-1")).toBeNull();
  });

  test("capability refusals name the capability", async () => {
    const model = sessionError(await rejection((await openWith(CLAUDE_SCRIPT, { model: "gpt-9" })).opened));
    expect(model.context).toMatchObject({ capability: "model" });
    const mode = sessionError(await rejection((await openWith({ configOptions: [] })).opened));
    expect(mode.context).toMatchObject({ capability: "profile" });
  });

  test("a transcript save failure propagates and kills the agent", async () => {
    const inner = createMemoryTranscriptStore();
    const failing: TranscriptStore = {
      ...inner,
      save: async () => {
        throw new Error("disk full");
      },
    };
    const { fake, opened } = await openWith(CLAUDE_SCRIPT, {}, failing);
    expect(String(await rejection(opened))).toContain("disk full");
    expect(fake.kills()).toBe(1);
  });
});

describe("openAcpSession: openSignal (close() during open)", () => {
  test("already aborted: AGENT_SESSION_CLOSED and nothing is launched", async () => {
    const fake = inMemoryAgent(CLAUDE_SCRIPT);
    const controller = new AbortController();
    controller.abort();
    const err = sessionError(
      await rejection(
        openAcpSession(
          options(),
          openContext(dir, { openSignal: controller.signal }),
          createInboundRouter().handlers,
          fake.launch,
        ),
      ),
    );
    expect(err.code).toBe("AGENT_SESSION_CLOSED");
    expect(fake.requests).toHaveLength(0);
  });

  test("aborted during a hung initialize: AGENT_SESSION_CLOSED and the agent is killed", async () => {
    const fake = inMemoryAgent({ hangInitialize: true });
    const controller = new AbortController();
    const opened = openAcpSession(
      options(),
      openContext(dir, { openSignal: controller.signal }),
      createInboundRouter().handlers,
      fake.launch,
    );
    setTimeout(() => controller.abort(), 20);
    expect(sessionError(await rejection(opened)).code).toBe("AGENT_SESSION_CLOSED");
    expect(fake.kills()).toBe(1);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd packages/nax-agent-acp && bun test ./test/unit/client/open.test.ts`
Expected: FAIL, "Cannot find module '#src/client/open'".

- [ ] **Step 3: Implement**

`packages/nax-agent-acp/src/client/open.ts`:

```ts
/**
 * Opening an ACP session (S4 spec §6.3 step 1): spawn, initialize, capability
 * check, session/new, the profile's mode, then the model, then the initial
 * transcript document. Every failure after the spawn kills the agent's process
 * group before it propagates, so a failed open leaves no process behind. Each
 * agent request is bounded by initializeTimeoutMs (D-c) and by openSignal: close()
 * during open rejects AGENT_SESSION_CLOSED.
 */
import { PROTOCOL_VERSION, type SessionConfigOption } from "@agentclientprotocol/sdk";
import { type BackendOpenContext, NaxError, type TranscriptDoc } from "@nathapp/nax-agent";
import {
  buildCapabilityRecord,
  type CapabilityRecord,
  modeFor,
  modelOptionId,
  offersValue,
  unmetRequirement,
} from "#src/client/capabilities";
import { type AcpLink, type InboundHandlers, openConnection } from "#src/client/connection";
import {
  backendUnavailable,
  capabilityUnsupported,
  closedDuringOpen,
  EXCERPT_BYTES,
  openRequestError,
  rpcErrorOf,
} from "#src/client/errors";
import { agentGoneError, type LaunchedAgent, type LaunchFn, pickCandidate } from "#src/client/launch";
import type { ResolvedAcpOptions } from "#src/client/options";
import { race } from "#src/client/race";
import type { LaunchCandidate } from "#src/client/registry";

/** An agent session id longer than this is not trusted (Review Focus 5). */
const MAX_SESSION_ID_CHARS = 512;

export interface OpenedAcp {
  readonly launched: LaunchedAgent;
  readonly link: AcpLink;
  readonly record: CapabilityRecord;
  readonly agentSessionId: string;
}

interface Opening {
  readonly options: ResolvedAcpOptions;
  readonly ctx: BackendOpenContext;
  readonly launched: LaunchedAgent;
  readonly link: AcpLink;
}

function chooseLaunch(options: ResolvedAcpOptions): LaunchCandidate {
  if (options.launch.kind === "explicit") return options.launch.candidate;
  const found = pickCandidate(options.launch.candidates, options.env.PATH);
  if (found !== undefined) return found;
  const tried = options.launch.candidates.map((candidate) => candidate.command);
  throw backendUnavailable(`no launch command for "${options.agentName}" was found on PATH (tried ${tried.join(", ")})`, {
    tried,
  });
}

export async function openAcpSession(
  options: ResolvedAcpOptions,
  ctx: BackendOpenContext,
  handlers: InboundHandlers,
  launch: LaunchFn,
): Promise<OpenedAcp> {
  if (ctx.openSignal.aborted) throw closedDuringOpen(ctx.sessionId);
  const candidate = chooseLaunch(options);
  const launched = launch({ command: candidate.command, args: candidate.args, cwd: ctx.workdir, env: options.env });
  const link = openConnection(launched.target, handlers);
  void launched.exited.then(() =>
    link.close(new NaxError("The ACP agent process exited", "ACP_AGENT_EXITED", { stage: "acp" })),
  );
  try {
    return await establish({ options, ctx, launched, link });
  } catch (err) {
    launched.kill();
    link.close();
    throw err;
  }
}

async function step<T>(o: Opening, label: string, request: Promise<T>): Promise<T> {
  const result = await race(request, { timeoutMs: o.options.initializeTimeoutMs, signal: o.ctx.openSignal });
  switch (result.kind) {
    case "ok":
      return result.value;
    case "aborted":
      throw closedDuringOpen(o.ctx.sessionId);
    case "timeout":
      throw backendUnavailable(`${label} timed out after ${o.options.initializeTimeoutMs} ms`, {
        during: label,
        stderr: o.launched.stderr.excerpt({ maxBytes: EXCERPT_BYTES, secrets: o.options.secrets }),
      });
    case "failed": {
      const rpc = rpcErrorOf(result.error);
      if (rpc !== undefined) throw openRequestError(label, rpc, o.options.secrets);
      throw await agentGoneError(label, o.launched, o.options.secrets);
    }
  }
}

async function establish(o: Opening): Promise<OpenedAcp> {
  const init = await step(o, "initialize", o.link.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} }));
  if (init.protocolVersion !== PROTOCOL_VERSION) {
    throw backendUnavailable(
      `the agent speaks ACP protocol version ${String(init.protocolVersion)}; this client speaks ${PROTOCOL_VERSION}`,
      { protocolVersion: String(init.protocolVersion).slice(0, 32) },
    );
  }
  const record = buildCapabilityRecord(init, o.options.entry);
  const unmet = unmetRequirement(record, {
    profile: o.ctx.profile,
    toolCount: o.ctx.tools.length,
    resume: o.ctx.resume !== undefined,
  });
  if (unmet !== undefined) throw capabilityUnsupported(unmet.capability, unmet.reason);
  const created = await step(o, "session/new", o.link.newSession({ cwd: o.ctx.workdir, mcpServers: [] }));
  const agentSessionId = created.sessionId;
  if (typeof agentSessionId !== "string" || agentSessionId === "" || agentSessionId.length > MAX_SESSION_ID_CHARS) {
    throw backendUnavailable("session/new returned no usable session id");
  }
  await applyConfig(o, agentSessionId, created.configOptions ?? []);
  await o.ctx.transcriptStore.save(o.ctx.sessionId, initialDoc(o, record, agentSessionId));
  return { launched: o.launched, link: o.link, record, agentSessionId };
}

/** §6.3 step 5: the profile's mode, then the model. Only values the agent offered are set. */
async function applyConfig(o: Opening, sessionId: string, offered: readonly SessionConfigOption[]): Promise<void> {
  const mode = modeFor(o.ctx.profile, o.options.entry);
  if (mode !== undefined && !offersValue(offered, mode.configId, mode.value)) {
    throw capabilityUnsupported("profile", `the agent does not offer ${mode.configId} "${mode.value}"`);
  }
  const afterMode =
    mode === undefined
      ? offered
      : ((await step(o, "session/set_config_option", o.link.setConfigOption({ sessionId, ...mode }))).configOptions ??
        offered);
  const model = o.options.model;
  if (model === undefined) return;
  const configId = modelOptionId(afterMode, model);
  if (configId === undefined) throw capabilityUnsupported("model", `the agent offers no model option "${model}"`);
  await step(o, "session/set_config_option", o.link.setConfigOption({ sessionId, configId, value: model }));
}

function initialDoc(o: Opening, record: CapabilityRecord, agentSessionId: string): TranscriptDoc {
  return {
    backend: o.options.kind,
    acp: {
      agentSessionId,
      agent: o.options.agentName,
      ...(record.agentVersion === undefined ? {} : { agentVersion: record.agentVersion }),
      cwd: o.ctx.workdir,
    },
    messages: [],
    savedAt: new Date().toISOString(),
  };
}
```

Notes for the implementer:
- `{ sessionId, ...mode }` spreads `{ configId, value }` from the registry's `ModeSetting`.
- If tsc rejects that spread against the request union, write `{ sessionId, configId: mode.configId, value: mode.value }` instead.

- [ ] **Step 4: Run them to verify they pass**

Run: `cd packages/nax-agent-acp && bun test ./test/unit/client/open.test.ts && bun run typecheck`
Expected: PASS, typecheck exit 0.

- [ ] **Step 5: Commit**

```bash
cd packages/nax-agent-acp && bun run lint:fix && cd ../..
git add packages/nax-agent-acp/src/client/open.ts packages/nax-agent-acp/test/helpers/in-memory-launch.ts packages/nax-agent-acp/test/helpers/open-context.ts packages/nax-agent-acp/test/unit/client/open.test.ts
git commit -m "feat(nax-agent-acp): ACP session open sequence with kill-on-failure"
```

---

### Task 8: Turns, `acpBackend()` and the public entry

**Files:**
- Create: `packages/nax-agent-acp/src/client/turn.ts`, `packages/nax-agent-acp/src/client/backend.ts`
- Modify: `packages/nax-agent-acp/src/client/index.ts`
- Modify (generated): `packages/nax-agent-acp/api/nax-agent-acp.api.txt`
- Test: `packages/nax-agent-acp/test/unit/client/backend.test.ts`

**Interfaces:**
- Consumes: everything above. From nax-agent: `createAgentSession`, `resumeAgentSession`, `AgentSessionAdapter`, `OpenedBackend`, `SessionBackend`, `SessionHandle`, `TurnResult`, `NO_OP_INTERACTION_HANDLER`, `AgentSessionError`, `NaxError`.
- Produces:
  - `runPromptTurn(state: TurnState, input: TurnInput): Promise<TurnResult>`
  - `acpBackend(options: AcpBackendOptions): SessionBackend`
  - `_acpBackendDeps: { launch: LaunchFn }`
  - public `./client`: `acpBackend`, `ACP_STOP_CODES`, `type AcpAgentName`, `type AcpAgentSpec`, `type AcpBackendOptions`, `type AcpStopCode`

- [ ] **Step 1: Write the failing tests**

`packages/nax-agent-acp/test/unit/client/backend.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  type AgentSession,
  createAgentSession,
  type CreateAgentSessionOptions,
  createMemoryTranscriptStore,
  type EmbedderTool,
  resumeAgentSession,
  type SessionEvent,
  type TranscriptDoc,
  type TranscriptStore,
} from "@nathapp/nax-agent";
import { cleanupTempDir, makeTempDir } from "@nathapp/nax-test-kit/bun/temp";
import { waitForCondition } from "@nathapp/nax-test-kit/bun/timeout";
import { _acpBackendDeps, acpBackend } from "#src/client/backend";
import * as publicClient from "#src/client/index";
import type { AcpBackendOptions } from "#src/client/options";
import { CLAUDE_CONFIG_OPTIONS, type FakeScript } from "#test/fixtures/fake-agent/script";
import { rejection, sessionError } from "#test/helpers/errors";
import { type InMemoryAgent, inMemoryAgent } from "#test/helpers/in-memory-launch";

const realLaunch = _acpBackendDeps.launch;
const SECRET = "s3cr3t-token-value-0123";
let workdir: string;

beforeEach(() => {
  workdir = makeTempDir("acp-backend-");
});

afterEach(() => {
  _acpBackendDeps.launch = realLaunch;
  cleanupTempDir(workdir);
});

interface Opened {
  readonly fake: InMemoryAgent;
  readonly session: AgentSession;
  readonly saves: TranscriptDoc[];
  readonly store: TranscriptStore;
}

function recordingStore(): { store: TranscriptStore; saves: TranscriptDoc[] } {
  const inner = createMemoryTranscriptStore();
  const saves: TranscriptDoc[] = [];
  const store: TranscriptStore = {
    ...inner,
    save: async (id, doc) => {
      saves.push(doc);
      await inner.save(id, doc);
    },
  };
  return { store, saves };
}

async function open(
  script: FakeScript = {},
  backend: Partial<AcpBackendOptions> = {},
  session: Partial<CreateAgentSessionOptions> = {},
): Promise<Opened> {
  const fake = inMemoryAgent({
    agentInfo: { name: "claude-agent-acp", version: "0.85.1" },
    configOptions: CLAUDE_CONFIG_OPTIONS,
    ...script,
  });
  _acpBackendDeps.launch = fake.launch;
  const { store, saves } = recordingStore();
  const created = await createAgentSession({
    backend: acpBackend({ agent: "claude", allowUnsandboxed: true, command: "fake-claude", ...backend }),
    profile: "full",
    workdir,
    transcriptStore: store,
    sessionId: "s-1",
    ...session,
  });
  return { fake, session: created, saves, store };
}

async function drain(events: AsyncIterable<SessionEvent>): Promise<SessionEvent[]> {
  const out: SessionEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

function endOf(events: readonly SessionEvent[]) {
  const last = events.at(-1);
  if (last?.type !== "turn_end") throw new Error("the turn did not end");
  return last;
}

async function cancelMidTurn(o: Opened, message: string): Promise<SessionEvent[]> {
  const promptsBefore = o.fake.callsTo("session/prompt").length;
  const iterator = o.session.send(message)[Symbol.asyncIterator]();
  const first = await iterator.next();
  await waitForCondition(() => o.fake.callsTo("session/prompt").length > promptsBefore, 2_000);
  o.session.cancel();
  const rest: SessionEvent[] = first.done === true ? [] : [first.value];
  for (let next = await iterator.next(); next.done !== true; next = await iterator.next()) rest.push(next.value);
  return rest;
}

describe("acpBackend: a text-only full session end to end (spec §10 S4-2)", () => {
  test("text deltas, turn_end, backend info and what reached the agent", async () => {
    const o = await open({ turns: [{ steps: [{ kind: "text", text: "Hel" }, { kind: "text", text: "lo" }] }] });
    const events = await drain(o.session.send("hi"));
    expect(events.flatMap((e) => (e.type === "text_delta" ? [e.text] : []))).toEqual(["Hel", "lo"]);
    expect(endOf(events)).toMatchObject({
      status: "completed",
      output: "Hello",
      costUsd: 0,
      costSource: "unpriced",
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    expect(o.session.backend.kind).toBe("acp:claude");
    expect(o.session.backend.capabilities).toMatchObject({
      protocolVersion: 1,
      agentName: "claude-agent-acp",
      agentVersion: "0.85.1",
      readOnlyMode: true,
      preApproval: true,
    });
    expect(o.fake.callsTo("session/prompt")).toEqual([
      { sessionId: "fake-session-1", prompt: [{ type: "text", text: "hi" }] },
    ]);
    await o.session.close();
  });

  test("instructions are prepended to the first prompt only", async () => {
    const o = await open({}, {}, { instructions: "Be brief." });
    await drain(o.session.send("first"));
    await drain(o.session.send("second"));
    expect(o.fake.callsTo("session/prompt")).toEqual([
      { sessionId: "fake-session-1", prompt: [{ type: "text", text: "Be brief.\n\nfirst" }] },
      { sessionId: "fake-session-1", prompt: [{ type: "text", text: "second" }] },
    ]);
    await o.session.close();
  });

  test("the initial document records the agent session", async () => {
    const o = await open();
    expect(await o.store.load("s-1")).toMatchObject({
      backend: "acp:claude",
      acp: { agentSessionId: "fake-session-1", agent: "claude", agentVersion: "0.85.1", cwd: workdir },
      messages: [],
    });
    await o.session.close();
  });

  test("a custom agent sets no mode and reports kind acp:<name>", async () => {
    const fake = inMemoryAgent({});
    _acpBackendDeps.launch = fake.launch;
    const session = await createAgentSession({
      backend: acpBackend({ agent: { name: "my-agent", command: "my-agent-acp" }, allowUnsandboxed: true }),
      profile: "full",
      workdir,
      transcriptStore: createMemoryTranscriptStore(),
    });
    expect(session.backend.kind).toBe("acp:my-agent");
    expect(fake.callsTo("session/set_config_option")).toEqual([]);
    expect(endOf(await drain(session.send("x"))).status).toBe("completed");
    await session.close();
  });

  test("updates addressed to another session are ignored", async () => {
    const o = await open({
      turns: [
        {
          steps: [
            { kind: "text", text: "mine" },
            { kind: "text", text: "theirs", sessionId: "other" },
          ],
        },
      ],
    });
    expect(endOf(await drain(o.session.send("x"))).output).toBe("mine");
    await o.session.close();
  });
});

describe("acpBackend: turn outcomes (spec §5.7, §7)", () => {
  test.each([
    ["max_tokens", "ACP_STOP_MAX_TOKENS"],
    ["max_turn_requests", "ACP_STOP_MAX_TURN_REQUESTS"],
    ["refusal", "ACP_STOP_REFUSAL"],
    ["cancelled", "ACP_STOP_CANCELLED"],
  ] as const)("stop reason %s ends the turn errored with %s", async (stopReason, code) => {
    const o = await open({ turns: [{ steps: [{ kind: "text", text: "x" }], stopReason }] });
    expect(endOf(await drain(o.session.send("x")))).toMatchObject({ status: "errored", error: { code } });
    await o.session.close();
  });

  test("a JSON-RPC error on prompt is AGENT_SESSION_TURN_FAILED, redacted; the session stays usable", async () => {
    const o = await open(
      {
        turns: [
          { steps: [{ kind: "fail", failure: { code: -32603, message: `overloaded ${SECRET}` } }] },
          { steps: [{ kind: "text", text: "ok" }] },
        ],
      },
      { env: { MY_TOKEN: SECRET } },
    );
    const failed = endOf(await drain(o.session.send("x")));
    expect(failed).toMatchObject({ status: "errored", error: { code: "AGENT_SESSION_TURN_FAILED" } });
    expect(failed.error?.message).not.toContain(SECRET);
    expect(endOf(await drain(o.session.send("y")))).toMatchObject({ status: "completed", output: "ok" });
    await o.session.close();
  });

  test("an auth error on prompt is AGENT_SESSION_AUTH_REQUIRED", async () => {
    const o = await open({ turns: [{ steps: [{ kind: "fail", failure: { code: -32000, message: "expired" } }] }] });
    expect(endOf(await drain(o.session.send("x")))).toMatchObject({
      status: "errored",
      error: { code: "AGENT_SESSION_AUTH_REQUIRED" },
    });
    await o.session.close();
  });

  test("permission requests are answered reject_once, or cancelled without one (D-d), with no events", async () => {
    const o = await open({
      turns: [
        {
          steps: [
            { kind: "permission", options: ["allow_once", "reject_once"] },
            { kind: "permission", options: ["allow_once", "allow_always"] },
            { kind: "text", text: "done" },
          ],
        },
      ],
    });
    const events = await drain(o.session.send("x"));
    expect(o.fake.callsTo("permission-outcome")).toEqual([
      { outcome: "selected", optionId: "opt-reject_once" },
      { outcome: "cancelled" },
    ]);
    expect(events.map((e) => e.type)).toEqual(["turn_start", "text_delta", "turn_end"]);
    await o.session.close();
  });
});

describe("acpBackend: cancel (spec §6.3 step 3)", () => {
  test("an agent that honours session/cancel: cancelled, and the session stays usable", async () => {
    const o = await open({ turns: [{ steps: [{ kind: "waitForCancel" }] }, { steps: [{ kind: "text", text: "again" }] }] });
    expect(endOf(await cancelMidTurn(o, "go")).status).toBe("cancelled");
    expect(o.fake.callsTo("session/cancel")).toEqual([{ sessionId: "fake-session-1" }]);
    expect(o.fake.kills()).toBe(0);
    expect(endOf(await drain(o.session.send("next")))).toMatchObject({ status: "completed", output: "again" });
    await o.session.close();
  });

  test("an agent that ignores it: killed after cancelGraceMs; later turns end AGENT_SESSION_CLOSED (D-f)", async () => {
    const o = await open({ turns: [{ steps: [{ kind: "hang" }] }] }, { cancelGraceMs: 50 });
    expect(endOf(await cancelMidTurn(o, "go")).status).toBe("cancelled");
    expect(o.fake.kills()).toBe(1);
    expect(endOf(await drain(o.session.send("next")))).toMatchObject({
      status: "errored",
      error: { code: "AGENT_SESSION_CLOSED" },
    });
    await o.session.close();
    expect(o.fake.callsTo("session/close")).toEqual([]);
  });
});

describe("acpBackend: close (spec §6.3 step 4, D-j)", () => {
  test("session/close when advertised, terminate, a final save that keeps the turn marker; idempotent", async () => {
    const o = await open({ capabilities: { sessionCapabilities: { close: {} } } });
    await drain(o.session.send("x"));
    await o.session.close();
    await o.session.close();
    expect(o.fake.callsTo("session/close")).toEqual([{ sessionId: "fake-session-1" }]);
    expect(o.fake.terminations()).toBe(1);
    expect(o.saves).toHaveLength(2);
    expect(o.saves.at(-1)?.turn?.state).toBe("ended");
    expect(o.saves.at(-1)?.backend).toBe("acp:claude");
  });

  test("no session/close when the agent does not advertise it", async () => {
    const o = await open();
    await o.session.close();
    expect(o.fake.callsTo("session/close")).toEqual([]);
    expect(o.fake.terminations()).toBe(1);
  });
});

describe("acpBackend: stages not built yet are refused before spawning (D-b)", () => {
  const tool: EmbedderTool = {
    name: "lookup",
    description: "Look something up",
    inputSchema: { type: "object", properties: {} },
    approval: "never",
    run: async () => ({ content: "x" }),
  };

  test.each(["read", "ask"] as const)("profile %s -> CAPABILITY_UNSUPPORTED profile", async (profile) => {
    const fake = inMemoryAgent({});
    _acpBackendDeps.launch = fake.launch;
    const err = sessionError(
      await rejection(
        createAgentSession({
          backend: acpBackend({ agent: "claude", allowUnsandboxed: true }),
          profile,
          workdir,
          transcriptStore: createMemoryTranscriptStore(),
        }),
      ),
    );
    expect(err.code).toBe("AGENT_SESSION_CAPABILITY_UNSUPPORTED");
    expect(err.context).toMatchObject({ capability: "profile" });
    expect(fake.requests).toHaveLength(0);
  });

  test("profile none (no workdir) -> CAPABILITY_UNSUPPORTED profile", async () => {
    const err = sessionError(
      await rejection(
        createAgentSession({
          backend: acpBackend({ agent: "claude", allowUnsandboxed: true }),
          profile: "none",
          transcriptStore: createMemoryTranscriptStore(),
        }),
      ),
    );
    expect(err.context).toMatchObject({ capability: "profile" });
  });

  test("embedder tools -> CAPABILITY_UNSUPPORTED tools", async () => {
    const fake = inMemoryAgent({});
    _acpBackendDeps.launch = fake.launch;
    const err = sessionError(
      await rejection(
        createAgentSession({
          backend: acpBackend({ agent: "claude", allowUnsandboxed: true }),
          profile: "full",
          workdir,
          tools: [tool],
          transcriptStore: createMemoryTranscriptStore(),
        }),
      ),
    );
    expect(err.context).toMatchObject({ capability: "tools" });
    expect(fake.requests).toHaveLength(0);
  });

  test("resume -> CAPABILITY_UNSUPPORTED resume", async () => {
    const fake = inMemoryAgent({});
    _acpBackendDeps.launch = fake.launch;
    const store = createMemoryTranscriptStore();
    await store.save("s-1", {
      backend: "acp:claude",
      acp: { agentSessionId: "a-1", agent: "claude", cwd: workdir },
      messages: [],
      savedAt: new Date().toISOString(),
    });
    const err = sessionError(
      await rejection(
        resumeAgentSession("s-1", {
          backend: acpBackend({ agent: "claude", allowUnsandboxed: true }),
          profile: "full",
          workdir,
          transcriptStore: store,
        }),
      ),
    );
    expect(err.context).toMatchObject({ capability: "resume" });
    expect(fake.requests).toHaveLength(0);
  });
});

describe("the public entry", () => {
  test("./client exports acpBackend and ACP_STOP_CODES", () => {
    expect(Object.keys(publicClient).sort()).toEqual(["ACP_STOP_CODES", "acpBackend"]);
  });
});
```

`cancelMidTurn` waits for the prompt to reach the fake before cancelling, so the cancel tests exercise a cancel during a running prompt, not one queued before it.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd packages/nax-agent-acp && bun test ./test/unit/client/backend.test.ts`
Expected: FAIL, "Cannot find module '#src/client/backend'".

- [ ] **Step 3: Implement**

`packages/nax-agent-acp/src/client/turn.ts`:

```ts
/**
 * One ACP prompt turn (S4 spec §6.3 steps 2 and 3, §5.7). end_turn returns a
 * TurnResult; any other stop reason throws its ACP_STOP_* NaxError. When the turn
 * signal aborts (cancel(), the facade's turn timeout, close()), session/cancel is
 * sent and the prompt gets cancelGraceMs to settle; past that the process group
 * is killed and the session is marked disconnected. The facade reports cancelled
 * or timed_out from the signal, so after an abort this throws the signal's reason.
 */
import type { PromptResponse } from "@agentclientprotocol/sdk";
import { NaxError, type TurnResult } from "@nathapp/nax-agent";
import type { AcpLink } from "#src/client/connection";
import { promptRequestError, rpcErrorOf, stopReasonError } from "#src/client/errors";
import type { TurnCollector } from "#src/client/events";
import { agentGoneError, type LaunchedAgent } from "#src/client/launch";
import { race } from "#src/client/race";

export interface TurnState {
  readonly link: AcpLink;
  readonly launched: LaunchedAgent;
  readonly agentSessionId: string;
  readonly cancelGraceMs: number;
  readonly secrets: readonly string[];
  /** Marks the session disconnected: its process is gone or was killed (D-f). */
  disconnect(): void;
}

export interface TurnInput {
  readonly text: string;
  readonly signal: AbortSignal;
  readonly collector: TurnCollector;
}

export async function runPromptTurn(state: TurnState, input: TurnInput): Promise<TurnResult> {
  const pending = state.link.prompt({
    sessionId: state.agentSessionId,
    prompt: [{ type: "text", text: input.text }],
  });
  const outcome = await race(pending, { signal: input.signal });
  switch (outcome.kind) {
    case "ok":
      return resultOf(outcome.value, input.collector);
    case "failed":
      throw await promptFailure(state, outcome.error);
    default:
      await cancelTurn(state, pending);
      throw abortReason(input.signal);
  }
}

function resultOf(response: PromptResponse, collector: TurnCollector): TurnResult {
  if (response.stopReason !== "end_turn") throw stopReasonError(String(response.stopReason));
  // Usage and cost arrive with S4-5 (§6.7); until then a turn is unpriced zeros (D-e).
  return {
    output: collector.output(),
    tokenUsage: { inputTokens: 0, outputTokens: 0 },
    estimatedCostUsd: 0,
    costSource: "unpriced",
    internalRoundTrips: 1,
  };
}

async function promptFailure(state: TurnState, error: unknown): Promise<NaxError> {
  const rpc = rpcErrorOf(error);
  if (rpc !== undefined) return promptRequestError(rpc, state.secrets);
  state.disconnect();
  return agentGoneError("session/prompt", state.launched, state.secrets);
}

async function cancelTurn(state: TurnState, pending: Promise<PromptResponse>): Promise<void> {
  await state.link.cancel(state.agentSessionId).catch(() => undefined);
  const settled = await race(pending, { timeoutMs: state.cancelGraceMs });
  if (settled.kind === "timeout") {
    state.launched.kill();
    state.disconnect();
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new NaxError("The turn was aborted", "AGENT_SESSION_TURN_FAILED", { stage: "acp" });
}
```

`packages/nax-agent-acp/src/client/backend.ts`:

```ts
/**
 * acpBackend(): nax-agent's SessionBackend over ACP (S4 spec §6). S4-2 serves
 * text-only `full` sessions end to end. Until their stages land it refuses,
 * before spawning anything (D-b): profiles other than `full` (S4-3), embedder
 * tools (S4-4) and resume (S4-6). A crashed or killed agent leaves the session
 * disconnected; reconnect is S4-6, so until then later turns end
 * AGENT_SESSION_CLOSED (D-f).
 */
import {
  type AgentSessionAdapter,
  AgentSessionError,
  type BackendOpenContext,
  NO_OP_INTERACTION_HANDLER,
  type OpenedBackend,
  type SendTurnOpts,
  type SessionBackend,
  type SessionHandle,
  type TranscriptStore,
  type TurnResult,
} from "@nathapp/nax-agent";
import { capabilityUnsupported } from "#src/client/errors";
import { createTurnCollector } from "#src/client/events";
import { createInboundRouter, type InboundRouter } from "#src/client/inbound";
import { type LaunchFn, launchAgent } from "#src/client/launch";
import { type OpenedAcp, openAcpSession } from "#src/client/open";
import { type AcpBackendOptions, type ResolvedAcpOptions, resolveAcpOptions } from "#src/client/options";
import { race } from "#src/client/race";
import { runPromptTurn, type TurnState } from "#src/client/turn";

/** Test seam: the process launcher. Production always uses launchAgent. */
export const _acpBackendDeps: { launch: LaunchFn } = { launch: launchAgent };

interface SessionFlags {
  disconnected: boolean;
  closing: Promise<void> | undefined;
  instructionsSent: boolean;
}

interface Live {
  readonly options: ResolvedAcpOptions;
  readonly ctx: BackendOpenContext;
  readonly acp: OpenedAcp;
  readonly router: InboundRouter;
  readonly flags: SessionFlags;
  readonly state: TurnState;
}

export function acpBackend(input: AcpBackendOptions): SessionBackend {
  const options = resolveAcpOptions(input);
  return Object.freeze({ kind: options.kind, open: (ctx: BackendOpenContext) => openBackend(options, ctx) });
}

function refuseUnbuilt(ctx: BackendOpenContext): void {
  if (ctx.profile !== "full") {
    throw capabilityUnsupported("profile", `profile "${ctx.profile}" on ACP arrives in S4-3; this build serves "full"`);
  }
  if (ctx.tools.length > 0) throw capabilityUnsupported("tools", "embedder tools on ACP arrive in S4-4");
  if (ctx.resume !== undefined) throw capabilityUnsupported("resume", "resuming an ACP session arrives in S4-6");
}

async function openBackend(options: ResolvedAcpOptions, ctx: BackendOpenContext): Promise<OpenedBackend> {
  refuseUnbuilt(ctx);
  const router = createInboundRouter();
  const acp = await openAcpSession(options, ctx, router.handlers, _acpBackendDeps.launch);
  const flags: SessionFlags = { disconnected: false, closing: undefined, instructionsSent: false };
  void acp.launched.exited.then(() => {
    flags.disconnected = true;
  });
  const state: TurnState = {
    link: acp.link,
    launched: acp.launched,
    agentSessionId: acp.agentSessionId,
    cancelGraceMs: options.cancelGraceMs,
    secrets: options.secrets,
    disconnect: () => {
      flags.disconnected = true;
    },
  };
  return assemble({ options, ctx, acp, router, flags, state });
}

function assemble(live: Live): OpenedBackend {
  const handle: SessionHandle = Object.freeze({ id: live.ctx.sessionId, agentName: live.options.kind });
  const adapter: AgentSessionAdapter = {
    openSession: async () => handle,
    sendTurn: (_handle, prompt, opts) => sendTurn(live, prompt, opts),
    // The agent session closes in OpenedBackend.close(), within the §6.3 step 4 bound (D-j).
    closeSession: async () => {},
  };
  return {
    adapter,
    handle,
    info: Object.freeze({ kind: live.options.kind, capabilities: live.acp.record }),
    turnOpts: () => ({ interactionHandler: NO_OP_INTERACTION_HANDLER }),
    close: () => {
      live.flags.closing ??= shutdown(live);
      return live.flags.closing;
    },
  };
}

async function sendTurn(live: Live, prompt: string, opts: SendTurnOpts): Promise<TurnResult> {
  const { ctx, flags } = live;
  if (flags.disconnected || flags.closing !== undefined) {
    throw new AgentSessionError(
      `ACP session "${ctx.sessionId}" has lost its agent process; reconnect arrives in S4-6`,
      "AGENT_SESSION_CLOSED",
      { sessionId: ctx.sessionId },
    );
  }
  const instructions = flags.instructionsSent ? undefined : ctx.instructions;
  flags.instructionsSent = true;
  const text = instructions === undefined || instructions === "" ? prompt : `${instructions}\n\n${prompt}`;
  const collector = createTurnCollector(opts.onTurnEvent);
  const release = live.router.attach(live.acp.agentSessionId, collector);
  try {
    return await runPromptTurn(live.state, { text, signal: opts.signal ?? ctx.turnSignal(), collector });
  } finally {
    release();
  }
}

async function shutdown(live: Live): Promise<void> {
  const { acp, options, flags } = live;
  if (!flags.disconnected && acp.record.close) {
    await race(acp.link.closeSession(acp.agentSessionId), { timeoutMs: options.cancelGraceMs });
  }
  await acp.launched.terminate(options.cancelGraceMs);
  acp.link.close();
  await saveFinal(live.ctx.transcriptStore, live.ctx.sessionId);
}

/** §6.3 step 4.5: the document with its final savedAt. Load-merge keeps the facade's turn marker. */
async function saveFinal(store: TranscriptStore, sessionId: string): Promise<void> {
  const doc = await store.load(sessionId);
  if (doc !== null) await store.save(sessionId, { ...doc, savedAt: new Date().toISOString() });
}
```

Replace `packages/nax-agent-acp/src/client/index.ts` with:

```ts
/**
 * `@nathapp/nax-agent-acp/client`: the ACP backend for nax-agent sessions.
 *
 * S4-2 serves text-only `full` sessions; profiles none/read/ask (S4-3), embedder
 * tools (S4-4), tool and usage events (S4-5) and resume (S4-6) are refused with
 * AGENT_SESSION_CAPABILITY_UNSUPPORTED until their stage lands. Nothing is
 * released before S4-6.
 */
export { acpBackend } from "#src/client/backend";
export { ACP_STOP_CODES, type AcpStopCode } from "#src/client/errors";
export type { AcpAgentSpec, AcpBackendOptions } from "#src/client/options";
export type { AcpAgentName } from "#src/client/registry";
```

- [ ] **Step 4: Run the tests, regenerate the API snapshot**

Run:
```bash
cd packages/nax-agent-acp
bun test ./test/unit/client/backend.test.ts
bun run typecheck
bun run build && bun run api:update
cat api/nax-agent-acp.api.txt
```
Expected: tests PASS, typecheck exit 0. The snapshot's `[./client]` section reads, in code-point order:

```
[./client]
ACP_STOP_CODES
type AcpAgentName
type AcpAgentSpec
type AcpBackendOptions
type AcpStopCode
acpBackend

[./server]
```

- [ ] **Step 5: Run the whole unit suite and the package gates**

Run: `cd packages/nax-agent-acp && bun run lint:fix && bun run test && bun run check:api && bun run check:all`
Expected: all exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/nax-agent-acp/src/client/turn.ts packages/nax-agent-acp/src/client/backend.ts packages/nax-agent-acp/src/client/index.ts packages/nax-agent-acp/api/nax-agent-acp.api.txt packages/nax-agent-acp/test/unit/client/backend.test.ts
git commit -m "feat(nax-agent-acp): acpBackend() for text-only full sessions"
```

---

### Task 9: End to end over real processes, and the Node contract

**Files:**
- Test: `packages/nax-agent-acp/test/unit/client/backend-process.test.ts`, `packages/nax-agent-acp/test/node/acp-backend.test.ts`

**Interfaces:**
- Consumes: `acpBackend` (Task 8); `FAKE_MAIN`, `fakeEnv`, `readRecords`, `startOf` (Task 5); `isProcessAlive` from nax-agent.
- Produces: no new code. The real `launchAgent` path is covered end to end on Bun and Node.

- [ ] **Step 1: Write the subprocess suite**

`packages/nax-agent-acp/test/unit/client/backend-process.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import {
  type AgentSession,
  createAgentSession,
  createMemoryTranscriptStore,
  isProcessAlive,
  type SessionEvent,
} from "@nathapp/nax-agent";
import { cleanupTempDir, makeTempDir } from "@nathapp/nax-test-kit/bun/temp";
import { waitForCondition } from "@nathapp/nax-test-kit/bun/timeout";
import { acpBackend } from "#src/client/backend";
import type { AcpBackendOptions } from "#src/client/options";
import type { FakeScript } from "#test/fixtures/fake-agent/script";
import { rejection, sessionError } from "#test/helpers/errors";
import { FAKE_MAIN, fakeEnv, readRecords, startOf } from "#test/helpers/fake-process";

const SECRET = "s3cr3t-token-value-0123";
let workdir: string;
let record: string;
const sessions: AgentSession[] = [];

beforeEach(() => {
  workdir = makeTempDir("acp-proc-");
  record = join(workdir, "record.jsonl");
});

afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close().catch(() => undefined);
  cleanupTempDir(workdir);
});

function backend(script: FakeScript, extra: Partial<AcpBackendOptions> = {}) {
  return acpBackend({
    agent: { name: "fake", command: process.execPath, args: [FAKE_MAIN] },
    allowUnsandboxed: true,
    env: { ...fakeEnv(script, record), FAKE_TOKEN: SECRET },
    ...extra,
  });
}

async function open(script: FakeScript, extra: Partial<AcpBackendOptions> = {}): Promise<AgentSession> {
  const session = await createAgentSession({
    backend: backend(script, extra),
    profile: "full",
    workdir,
    transcriptStore: createMemoryTranscriptStore(),
  });
  sessions.push(session);
  return session;
}

async function drain(events: AsyncIterable<SessionEvent>): Promise<SessionEvent[]> {
  const out: SessionEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

function endOf(events: readonly SessionEvent[]) {
  const last = events.at(-1);
  if (last?.type !== "turn_end") throw new Error("the turn did not end");
  return last;
}

const pidGone = (pid: number) => waitForCondition(() => !isProcessAlive(pid), 5_000);

describe("acpBackend over a real agent process (spec §9 subprocess fake)", () => {
  test("a text turn over pipes; the agent runs in workdir; close() ends the process", async () => {
    const session = await open({ turns: [{ steps: [{ kind: "text", text: "pong" }] }] });
    expect(endOf(await drain(session.send("ping")))).toMatchObject({ status: "completed", output: "pong" });
    const start = startOf(record);
    expect(realpathSync(start.cwd)).toBe(realpathSync(workdir));
    await session.close();
    await pidGone(start.pid);
  });

  test("the env allowlist holds end to end", async () => {
    process.env.NAX_ACP_TEST_LEAK = "1";
    try {
      await open({ recordEnv: ["NAX_ACP_TEST_LEAK", "FAKE_TOKEN"] });
      expect(startOf(record).env).toEqual({ NAX_ACP_TEST_LEAK: false, FAKE_TOKEN: true });
    } finally {
      delete process.env.NAX_ACP_TEST_LEAK;
    }
  });

  test("a line that is not JSON before the first answer is tolerated", async () => {
    const session = await open({ startup: { garbageLine: true } });
    expect(endOf(await drain(session.send("x"))).status).toBe("completed");
  });

  test("a crash mid-turn: BACKEND_UNAVAILABLE with redacted stderr; later turns AGENT_SESSION_CLOSED", async () => {
    const session = await open({
      turns: [{ steps: [{ kind: "text", text: "partial" }, { kind: "exit", code: 7, stderr: `fatal ${SECRET}\n` }] }],
    });
    const crashed = endOf(await drain(session.send("x")));
    expect(crashed).toMatchObject({ status: "errored", error: { code: "AGENT_SESSION_BACKEND_UNAVAILABLE" } });
    expect(crashed.error?.message).toContain("exited with code 7");
    expect(crashed.error?.message).toContain("[REDACTED]");
    expect(crashed.error?.message).not.toContain(SECRET);
    expect(endOf(await drain(session.send("y")))).toMatchObject({
      status: "errored",
      error: { code: "AGENT_SESSION_CLOSED" },
    });
  });

  test("an ignored cancel: cancelled within the grace, the process killed, later turns CLOSED", async () => {
    const session = await open({ turns: [{ steps: [{ kind: "hang" }] }] }, { cancelGraceMs: 200 });
    const iterator = session.send("go")[Symbol.asyncIterator]();
    await iterator.next();
    await waitForCondition(() => readRecords(record).some((r) => r.method === "session/prompt"), 5_000);
    session.cancel();
    const rest: SessionEvent[] = [];
    for (let next = await iterator.next(); next.done !== true; next = await iterator.next()) rest.push(next.value);
    expect(endOf(rest).status).toBe("cancelled");
    await pidGone(startOf(record).pid);
    expect(endOf(await drain(session.send("next"))).error?.code).toBe("AGENT_SESSION_CLOSED");
  });
});

describe("acpBackend: failed opens leave no process (Review Focus 1)", () => {
  async function failedOpen(script: FakeScript, extra: Partial<AcpBackendOptions> = {}) {
    return sessionError(
      await rejection(
        createAgentSession({
          backend: backend(script, extra),
          profile: "full",
          workdir,
          transcriptStore: createMemoryTranscriptStore(),
        }),
      ),
    );
  }

  test("exit during initialize: BACKEND_UNAVAILABLE with the exit code and redacted stderr", async () => {
    const err = await failedOpen({ startup: { stderr: `no credentials ${SECRET}\n`, exitCode: 2 } });
    expect(err.code).toBe("AGENT_SESSION_BACKEND_UNAVAILABLE");
    expect(err.context).toMatchObject({ during: "initialize", exitCode: 2 });
    expect(String(err.context?.stderr)).toContain("no credentials [REDACTED]");
  });

  test("initialize timeout: BACKEND_UNAVAILABLE and the process is gone", async () => {
    const err = await failedOpen({ startup: { hang: true } }, { initializeTimeoutMs: 300 });
    expect(err.code).toBe("AGENT_SESSION_BACKEND_UNAVAILABLE");
    await pidGone(startOf(record).pid);
  });

  test("a model the agent does not offer: CAPABILITY_UNSUPPORTED and the process is gone", async () => {
    const err = await failedOpen({}, { model: "gpt-9" });
    expect(err.context).toMatchObject({ capability: "model" });
    await pidGone(startOf(record).pid);
  });

  test("a command that cannot be spawned: BACKEND_UNAVAILABLE", async () => {
    const err = sessionError(
      await rejection(
        createAgentSession({
          backend: acpBackend({
            agent: { name: "missing", command: join(workdir, "no-such-agent") },
            allowUnsandboxed: true,
          }),
          profile: "full",
          workdir,
          transcriptStore: createMemoryTranscriptStore(),
        }),
      ),
    );
    expect(err.code).toBe("AGENT_SESSION_BACKEND_UNAVAILABLE");
    expect(err.message).toContain("could not be started");
  });
});
```

- [ ] **Step 2: Write the Node contract test**

`packages/nax-agent-acp/test/node/acp-backend.test.ts`:

```ts
/**
 * The ACP backend on real Node (the runtime the package ships to), against the
 * fake agent as a Node subprocess (type stripping, Node 22.19+).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, createMemoryTranscriptStore, isProcessAlive, type SessionEvent } from "@nathapp/nax-agent";
import { afterEach, expect, test } from "vitest";
import { acpBackend } from "#src/client/index";
import { FAKE_MAIN, fakeEnv, startOf } from "#test/helpers/fake-process";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function until(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("a text turn and close over a Node agent process", async () => {
  expect(process.versions.bun).toBeUndefined();
  const workdir = mkdtempSync(join(tmpdir(), "acp-node-"));
  dirs.push(workdir);
  const record = join(workdir, "record.jsonl");
  const session = await createAgentSession({
    backend: acpBackend({
      agent: { name: "fake", command: process.execPath, args: [FAKE_MAIN] },
      allowUnsandboxed: true,
      env: fakeEnv({ turns: [{ steps: [{ kind: "text", text: "node-pong" }] }] }, record),
    }),
    profile: "full",
    workdir,
    transcriptStore: createMemoryTranscriptStore(),
  });
  const events: SessionEvent[] = [];
  for await (const event of session.send("ping")) events.push(event);
  expect(events.at(-1)).toMatchObject({ type: "turn_end", status: "completed", output: "node-pong" });
  const { pid } = startOf(record);
  await session.close();
  await until(() => !isProcessAlive(pid), 5_000);
});
```

- [ ] **Step 3: Run both suites**

Run:
```bash
cd packages/nax-agent-acp
bun test ./test/unit/client/backend-process.test.ts
bun run test:node
```
Expected: PASS on both. If Node fails to load the fixture (type stripping) or `@nathapp/nax-agent` source, stop and report the error. Do not switch the fixture to JavaScript or add a loader without approval.

- [ ] **Step 4: Coverage and gates**

Run: `cd packages/nax-agent-acp && bun run lint:fix && bun run test:coverage && bun run check:all`
Expected: exit 0. Every `src/client/*.ts` file is at or above 80% lines and functions, and the per-file baseline is still empty. If a file is under the floor, add the missing test to that file's suite. Do not update the baseline.

- [ ] **Step 5: Commit**

```bash
git add packages/nax-agent-acp/test/unit/client/backend-process.test.ts packages/nax-agent-acp/test/node/acp-backend.test.ts
git commit -m "test(nax-agent-acp): end to end over real agent processes on Bun and Node"
```

---

### Task 10: Docs and context

**Files:**
- Modify: `packages/nax-agent-acp/README.md`, `packages/nax-agent-acp/CHANGELOG.md`
- Modify: `.nax/mono/packages/nax-agent-acp/context.md`
- Regenerated: `packages/nax-agent-acp/{CLAUDE,AGENTS,GEMINI,codex}.md`

**Interfaces:** none (documentation).

- [ ] **Step 1: README**

Replace the README's `**Status: pre-release.**` paragraph with:

````markdown
**Status: pre-release.** The package is built in stages (S4-1 to S4-6) and is not
published yet. Today `acpBackend()` serves text-only `full` sessions. Profiles
`none`/`read`/`ask` (S4-3), embedder tools (S4-4), tool and usage events (S4-5) and
resume (S4-6) are refused with `AGENT_SESSION_CAPABILITY_UNSUPPORTED` until their
stage lands. `./server` is reserved for a later ACP server.

```ts
import { createAgentSession, createMemoryTranscriptStore } from "@nathapp/nax-agent";
import { acpBackend } from "@nathapp/nax-agent-acp/client";

const session = await createAgentSession({
  backend: acpBackend({ agent: "claude", allowUnsandboxed: true }),
  profile: "full",
  workdir: "/path/to/repo",
  transcriptStore: createMemoryTranscriptStore(),
});
for await (const event of session.send("Summarise this repository")) {
  if (event.type === "text_delta") process.stdout.write(event.text);
}
await session.close();
```

What to know:
- **The agent runs unsandboxed on the host.** That is why `allowUnsandboxed: true` is required.
- **Environment.** The agent gets an allowlist: `PATH`, `HOME`, `USER`, `SHELL`,
  `TMPDIR`, `LANG`, `LC_*`, `TERM`, the agent's auth variables, and `env`.
  `inheritEnv: true` hands it your whole environment instead, credentials included.
- **Instructions** are prepended to the first prompt only; ACP has no system prompt.
- **Stop reasons.** A turn that stops for anything but `end_turn` ends `errored` with
  an `ACP_STOP_*` code (`ACP_STOP_CODES`).
- **Usage** is reported as zeros with `costSource: "unpriced"`. Never sum
  `unpriced` rows as a cost.
- **A crashed or killed agent leaves the session disconnected.** Later turns end
  `AGENT_SESSION_CLOSED`. A cancel the agent ignores for `cancelGraceMs` kills it.
- **A crash between `session/new` and the first save** loses the agent's session
  id. The next `createAgentSession` with the same id starts fresh.
````

- [ ] **Step 2: CHANGELOG**

Under `## [Unreleased]`, after the scaffold bullet, add:

```markdown
- `acpBackend()` on `./client` (S4-2): launches the agent as a process-group leader,
  initializes over `@agentclientprotocol/sdk`, checks capabilities, opens the session,
  applies the profile's mode and the model, and runs text-only `full` turns with
  cancel, crash and close handling. Exports `ACP_STOP_CODES` and the `AcpStopCode`,
  `AcpAgentName`, `AcpAgentSpec` and `AcpBackendOptions` types.
```

- [ ] **Step 3: Context**

In `.nax/mono/packages/nax-agent-acp/context.md`, replace the `## Status` paragraph with:

```markdown
## Status

Built in stages S4-1 to S4-6. S4-2 adds `acpBackend()`: launch, connection,
capabilities, the session lifecycle and text-only `full` turns, tested against a fake
ACP agent (`test/fixtures/fake-agent/`, in process and as a subprocess). Profiles
none/read/ask (S4-3), tools (S4-4), full events and usage (S4-5) and resume (S4-6)
are refused with `AGENT_SESSION_CAPABILITY_UNSUPPORTED` until then. `./server` is
reserved for S5. Nothing is released before S4-6.

## Module map (`src/client/`)

| Module | Role |
|:-------|:-----|
| `options.ts`, `env.ts` | zod options; agent env allowlist and redaction set |
| `registry.ts` | per-agent launch, mode, pre-approval and auth data |
| `launch.ts` | process-group spawn, ndjson stream, stderr tail, `agentGoneError` |
| `connection.ts` | one SDK `ClientApp` per process; outbound requests |
| `capabilities.ts` | capability record, requirement checks, config options |
| `open.ts` | open sequence; kills the agent on any failure |
| `turn.ts`, `events.ts`, `inbound.ts` | prompt turn and abort; text events; inbound routing |
| `backend.ts` | `acpBackend()`, adapter, close; `_acpBackendDeps.launch` test seam |

Tests reach a process only through `_acpBackendDeps.launch`
(`test/helpers/in-memory-launch.ts`) or the subprocess fake (`FAKE_MAIN`). Never
start a real ACP adapter in the unit suite.
```

- [ ] **Step 4: Regenerate and verify**

Run (repo root):
```bash
bun packages/nax/bin/nax.ts generate --all-packages
git status --short
cd packages/nax && bun run check:all
```
Expected:
- Only `packages/nax-agent-acp/{CLAUDE,AGENTS,GEMINI,codex}.md` change among the generated files.
- `check:all` exits 0, including `check:rules-drift`.

- [ ] **Step 5: Commit**

```bash
git add packages/nax-agent-acp/README.md packages/nax-agent-acp/CHANGELOG.md .nax/mono/packages/nax-agent-acp/context.md packages/nax-agent-acp/CLAUDE.md packages/nax-agent-acp/AGENTS.md packages/nax-agent-acp/GEMINI.md packages/nax-agent-acp/codex.md
git commit -m "docs(nax-agent-acp): S4-2 status, usage and module map"
```

---

### Task 11: Whole-repo gates, review, PR

- [ ] **Step 1: Run the repo-wide gates**

Run (repo root):
```bash
bun run typecheck
bun run check:all
bun run build
bun run test
```
Expected: all exit 0.

Run from each package as CI does:
- `cd packages/nax-agent && bun run check:api && bun run test:coverage && bun run test:node`
- `cd packages/nax-agent-acp && bun run check:api && bun run test:coverage && bun run test:node`

Expected: all exit 0.

- [ ] **Step 2: Confirm the scope fence**

Run: `git diff --stat origin/main -- packages/nax/ | cat`
Expected: empty (spec §11.4).

Run: `git diff --stat origin/main -- packages/nax-agent/ | cat`
Expected: exactly:
- `src/index.ts`
- `test/unit/session/agent-session-errors.test.ts`
- `api/nax-agent.api.txt` (one added line)
- `CHANGELOG.md`

No `native/`, `tools/`, `permissions/`, `session/` or `internal/` file changes, so the S4-0 rule does not call for a billed `nax run` smoke.

- [ ] **Step 3: Review before push**

Dispatch one code-review subagent (sonnet) over `git diff origin/main...HEAD`. Give it:
- spec §5.6, §5.7, §6.1 to §6.3 and §7
- this plan's Decisions and Review Focus

Fix CRITICAL and HIGH findings, with at most two fix rounds.

- [ ] **Step 4: Push and open the PR (maintainer approval first)**

After approval:
```bash
git push -u origin feat/s4-2-acp-lifecycle
gh pr create --base main --title "feat(nax-agent-acp): S4-2 launch, connection, lifecycle and acpBackend() for full sessions" --body-file <body>
```

The body covers:
- the S4-2 scope (spec §10 row)
- decisions D-a to D-l
- the gap closed (`NaxError` on `.`)
- the test plan: CI jobs `nax-agent-acp`, `nax-agent-acp: node 22/24`, `nax-agent`, `nax`, `tooling`
- a statement that nothing is released

---

## Self-review notes

- **Spec coverage, §10 S4-2 row:**
  - `launch` on the S4-1 registry: Task 5 (`pickCandidate` over `entry.launch`) and Task 7 (`chooseLaunch`)
  - `connection`: Task 6
  - `capabilities`: Task 4
  - lifecycle §6.3:
    - open (step 1): Task 7
    - turn (step 2): Task 8
    - abort (step 3): Task 8, plus Task 9 for the real kill
    - close (step 4): Task 8, plus Task 9 for the process gone
    - crash (step 5): Task 9 (disconnect; reconnect deferred to S4-6 by D-f)
    - inbound with no active turn: Task 6
  - fake agent: Task 5
  - minimal `acpBackend()` end to end: Tasks 8 and 9
- **§6.2 options:** every field in Task 3. Env allowlist and `inheritEnv`: Task 3. Redaction set: Tasks 2 and 3.
- **§7 errors:**
  - launch, exit and timeout: Tasks 5, 7 and 9
  - auth: Tasks 2, 7 and 8
  - capability: Tasks 4, 7 and 8
  - sandbox: Task 3
  - crash mid-turn: Task 9
  - non-`end_turn` stop: Task 8
  - JSON-RPC error on prompt: Task 8
  - backend mismatch is the facade's (S4-0). Agent lost session and identity mismatch are resume paths (S4-6).
- **§9 fake agent scripts used here:**
  - streaming text, permission option sets, hangs, crashes, malformed and oversized frames, auth errors
  - inbound with no active turn: the router tests
  - scripts for later stages already in the fixture: thoughts, usage
  - added in their own stages: tool content (S4-5), `_meta` capture (S4-4), elicitation (S4-5), resume/load matrix and session loss (S4-6)
- **Deferred by the spec, not in this plan:** permissions by profile (S4-3), tool host (S4-4), the full event table and usage (S4-5), resume and reconnect, packed smoke, live smoke (S4-6).
- **Consistent names:**
  - `LaunchFn`, `LaunchedAgent`, `LaunchTarget` (Task 5) are used by Tasks 6, 7 and 8 and the in-memory helper.
  - `openAcpSession(options, ctx, handlers, launch)` has the same argument order in Tasks 7 and 8.
  - `TurnCollector` and `createTurnCollector` (Task 6) are used in Task 8.
  - `_acpBackendDeps.launch` is the only seam.
