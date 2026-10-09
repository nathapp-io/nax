# S5-3 Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** make `nax-agent` ACP sessions durable and switchable:
- `session/load` with history replay, plus `session/resume`, `session/list`, `session/close` and `session/delete`;
- `session/set_mode` and `session/set_config_option` (model and bash approval);
- a bounded shutdown.

A model switch keeps the conversation (user ruling 2026-10-09: history is carried, any model).

**Architecture:**
- **Session files.** Each ACP session gets a metadata file and a lock file beside its S3 transcript (`storage.ts`).
- **Registry.** It becomes file-backed. Opening (new, load, resume) takes the lock and reopens the S3 session: resume when a transcript exists, create when none does.
- **Switching.** Mode and config changes close the S3 session and reopen it with the new settings. `ServerSession.switchTo` does this, with a rollback if the reopen fails.
- **History across models.** Carrying a conversation across a model change needs two library changes:
  - nax-ai assistant messages record the model that wrote them, so pi-ai converts another model's thinking to text and drops its signatures;
  - nax-agent gains an opt-in, `carryHistoryAcrossModels`, that keeps history when the model changes.

**Tech Stack:**
- TypeScript ESM.
- `bun:test` for nax-agent and nax-agent-acp; vitest for nax-ai.
- `@agentclientprotocol/sdk` 1.7.0 (`session/load`, `resume`, `list`, `close`, `delete`, `set_mode`, `set_config_option`).
- `@nathapp/nax-agent` facade (`createAgentSession`, `resumeAgentSession`, `nativeBackend`, `TranscriptStore`).
- `@earendil-works/pi-ai` 1.1.0, whose `transformMessages` compares `provider`/`api`/`model` per assistant message.
- zod 4.

**Spec:** `docs/superpowers/specs/2026-10-08-s5-acp-server-design.md` §3.3, §5.1-§5.5, §7. §3.3 is amended by Task 8 for the history-carrying model switch. **Master plan:** `docs/superpowers/plans/2026-10-08-s5-acp-server-master-plan.md`. **Builds on:** S5-2, merged #2407 (`2b53acaa4`).

## Global Constraints

- Package commands run from the package directory. Never run bare `bun test` with no path; scope it as `timeout 60 bun test <path> --timeout=60000`.
  - nax-ai: `bun run typecheck`, `bun run lint`, `bun run test` (vitest).
  - nax-agent and nax-agent-acp: `bun run typecheck`, `bun run check:all`, `bun test ./test/unit/ --timeout=60000`, `bun run test:coverage`.
- Source files <= 600 lines, test files <= 800 lines. Per-file coverage >= 80% in nax-agent and nax-agent-acp.
- No `throw new Error(` in `src/`: use `NaxError` from `@nathapp/nax-agent`, or SDK `RequestError` at the protocol edge.
- No Bun APIs in `src/`.
- No `as unknown as`, no `@ts-` suppressions, and no fixed sleeps in tests. Wait with `waitForCondition` from `@nathapp/nax-test-kit/bun/timeout`.
- nax-agent-acp reaches nax-agent only through `@nathapp/nax-agent`. Inside a package, import with `#src/` and `#test/`. nax-agent `src/` relative imports name the file (`./x.ts`).
- Test files are named after their module.
- Temp dirs come from `makeTempDir`/`cleanupTempDir` (`@nathapp/nax-test-kit/bun/temp`).
- `bun run lint:fix` (nax-ai: `bun x biome check --write src/ test/`) before each commit.
- Never spy on `process.kill`: bun's `spyOn` calls through. Inject liveness instead.

Exact values from the spec:
- **Storage layout:**
  - Files: `<sessionsDir>/<id>.transcript.json` (S3), `<id>.session.json`, `<id>.lock`.
  - Metadata: `{ schemaVersion: 1, sessionId, cwd, mode, model, bashApproval, title, createdAt, updatedAt }`, written as temp file + rename.
  - `title` is the first prompt text, truncated to 80 characters, or null.
  - Lock content is `{ pid, startedAt }`, created exclusively (`wx`).
  - A lock whose pid is dead (`process.kill(pid, 0)` throws `ESRCH`) is stale and taken over. A live one gives `invalid_request` `session in use by pid N`.
- **Capabilities:** `loadSession: true` and `sessionCapabilities: { list: {}, resume: {}, close: {}, delete: {} }`. Modes `none`, `read`, `ask`, `full`. Config options `model` (select) and `bashApproval` (select: `gated`, `escalate`, `raw`).
- **`session/load`:** unknown id gives `resource_not_found`. The transcript is replayed before responding. If the last turn was `interrupted`, a warning notice `The previous turn was interrupted` ends the replay.
- **`session/resume`:** as load, without replay.
- **`session/list`:** filter by `cwd`. Sort by `updatedAt` descending (`createdAt` when null). Page size 50, cursor is an opaque base64 offset. Unreadable metadata is skipped and logged.
- **`session/close`:** cancel, close, release the lock, keep the files. Unknown id gives `resource_not_found`.
- **`session/delete`:** close if open, then remove the three files.
- **`set_mode` / `set_config_option`:** close the S3 session and reopen it with the new settings.
  - Rejected mid-turn (`invalid_request` `turn in progress`).
  - Metadata is written only after the reopen succeeds. On failure the old settings are reopened and the error is returned.
  - On success send `current_mode_update` / `config_option_update`.
  - A model id not in the option list gives `invalid_params` listing the valid ids. `bashApproval` other than `gated` with mode `ask` gives `invalid_params` (S3 requires `gated` for `ask`).
- **Load/resume settings:** restore the stored mode and model, not the defaults.
- **Shutdown:** cancel every running turn, wait up to 5 s per session, close every session, release every lock.
- **Unreadable metadata, or unknown `schemaVersion`:** `internal_error` on load. Files are never deleted or rewritten.

## Review Focus

- **A model switch in the middle of a thinking-and-tool conversation.** Sonnet must receive Haiku's thinking as plain text without Haiku's signatures, while Sonnet's own later turns keep theirs. A wrong stamp means a provider 400 on the first turn after the switch. Task 0 pins both directions at the `toPiContext` level, and Task 1 pins that the loop records the origin, including through `rewriteToolCallInput`.
- **A session reopened that was never prompted** (new, close, load). It has no transcript document, and `resumeAgentSession` would throw `AGENT_SESSION_NOT_FOUND`. It must open fresh. Task 3 tests it.
- **Two editor windows on one session**, or a crashed server's leftover lock. A live lock refuses with the pid. A dead pid's lock, or an unreadable lock, is taken over. Task 5 tests all three.
- **A switch whose reopen fails** (bad model id, sandbox error). The session must still work on its old settings, the metadata must be unchanged, and the client must get the error. Task 6 and Task 7 test it.
- **Shutdown while a turn hangs.** Every lock is released within the 5 s cap even when `close()` never resolves, so the next start can take the session. Task 7 tests it with a short cap.

## Decisions taken while planning

| # | Decision | Why |
|---|---|---|
| M-19 | Model switch carries history for any model (user ruling 2026-10-09). The pieces: nax-ai assistant `ConversationMessage.origin?: { provider; model }`, recorded by the nax-agent loop and used by `toPiMessages` to stamp the message; nax-agent `NativeBackendOptions.carryHistoryAcrossModels`, which skips `checkResumeModel`, the loop's foreign-model history drop and the instruction-scope model check. The per-model compaction anchor (`sessionAnchorFor`) is NOT relaxed. | pi-ai already makes another model's history safe when each message says who wrote it. Today `toPiMessages` stamps every message with the current model, so a switch would send foreign thinking signatures. The anchor is tokenizer-specific, so it stays per model. |
| M-20 | nax-ai's type change ships in this branch. It is released before nax-agent at S5-4 (nax-ai patch, then exact pins bumped in nax-agent and nax). | nax-agent links the workspace nax-ai (`packages/nax-agent/node_modules/@nathapp/nax-ai -> packages/nax-ai`), so the branch is self-consistent. A published nax-agent needs the published nax-ai. |
| M-21 | Reopen means resume when the transcript store has a document, and create when it does not. | `createAgentSession` writes nothing until the first turn, so a never-prompted session has no document to resume. |
| M-22 | S5-2 fixes found while planning: `bashApproval` is passed to `nativeBackend` only for modes `ask` and `full`; option resolution requires `gated` for mode `ask` (it rejected only `raw`); `workdir` is omitted for mode `none`. | nax-agent rejects `bashApproval` for `none`/`read` (`--mode read` broke every `session/new`), and rejects `escalate` with `ask`. |
| M-23 | Switching to mode `ask` coerces `bashApproval` to `gated` and reports it in a `config_option_update`. Setting `bashApproval` to non-`gated` while in `ask` is `invalid_params`. | A person choosing Ask expects it to work. The explicit bash change under Ask is the one that cannot. |
| M-24 | On load and resume the stored `cwd` wins over the request's `cwd` (a difference is logged at debug). An already-open session's load replays from the store and keeps the open session. | The metadata records where the session's tools are rooted. |
| M-25 | `config_option_update` is sent only to clients that declared `clientCapabilities.session.configOptions`. `current_mode_update` is always sent. Responses always carry `modes` and `configOptions`. | Matches the notices rule from S5-1. Response fields are harmless to clients that ignore them. |
| M-26 | After `closeAll` starts, the registry refuses new opens (`internal_error` `server is shutting down`). The S5-2 deferred minor "create in flight during closeAll" is fixed here. | No session may open after the locks are released. |
| M-27 | Mode and approval descriptions shown to users: <br>- `none` "Chat only: no workspace tools."<br>- `read` "Reads and searches the workspace; changes nothing."<br>- `ask` "Asks before every edit and command."<br>- `full` "Edits files and runs commands without asking, inside the sandbox."<br>- bash `gated` "Commands are checked against the rules; one the checks cannot judge is refused."<br>- `escalate` "Like gated, but a command the checks cannot judge asks you instead."<br>- `raw` "Commands run as written, without per-command checks (mode Full only)." | ADR-030's mode table, in user words. |

## File Structure

| File | Responsibility |
|---|---|
| `packages/nax-ai/src/protocols/types.ts`, `pi-client.ts` | `origin` on assistant messages; `toPiMessages` stamps it (Task 0). |
| `packages/nax-agent/src/native/session/turn-loop-round-trip.ts`, `handle-invalid-tool-call.ts` | Record and keep `origin` (Task 1). |
| `packages/nax-agent/src/session/native-backend-options.ts`, `native-backend.ts`, `session-types.ts`, `native/session/session.ts`, `transcript-identity.ts`, `turn-loop.ts`, `instruction-session.ts` | `carryHistoryAcrossModels` (Task 2). |
| `src/server/open-session.ts`, `options.ts`, `main.ts`, `registry.ts` | Reopen (resume or create); S5-2 fixes (Task 3). |
| `src/server/session-config.ts` | Modes, config options, change validation (Task 4). |
| `src/server/storage.ts` | Metadata, lock, list (Task 5). |
| `src/server/server-session.ts` | `switchTo`, dynamic context window, `onTurnEnd` (Task 6). |
| `src/server/registry.ts`, `client-port.ts` | File-backed registry: load, resume, list, close, delete, switch, shutdown (Task 7). |
| `src/server/connection.ts`, `capabilities.ts`, `main.ts`, spec, context docs | Handlers, capabilities, wiring, docs (Task 8). |

(`src/server/...` paths are under `packages/nax-agent-acp/`.)

---

### Task 0: nax-ai assistant messages record the model that wrote them

**Files:**
- Modify: `packages/nax-ai/src/protocols/types.ts` (the `assistant` member of `ConversationMessage`, ~line 123)
- Modify: `packages/nax-ai/src/protocols/pi-client.ts` (`toPiMessages`, ~lines 123-160)
- Test: `packages/nax-ai/test/protocols/pi-client.test.ts` (the `describe("toPiContext")` block)

**Interfaces:**
- Produces:
  - `ConversationMessage` assistant member gains `readonly origin?: { readonly provider: string; readonly model: string }`. These are the catalog provider id and model id, without an effort suffix.
  - `toPiContext(req, model)` stamps each replayed assistant message with `provider: origin?.provider ?? model.provider`, `model: origin?.model ?? model.id` and `api: model.api`.

- [ ] **Step 1: Write the failing tests.** Append inside `describe("toPiContext", ...)`:

```ts
  it("stamps an assistant message with the model that wrote it (another model's turn reads as foreign to pi-ai)", () => {
    const context = toPiContext(
      {
        ...BASE,
        messages: [
          { role: "user", content: "hi" },
          {
            role: "assistant",
            content: "hello",
            thinking: [{ text: "pondering", signature: "sig-haiku" }],
            origin: { provider: "anthropic", model: "claude-haiku-4-5" },
          },
          { role: "user", content: "again" },
        ],
      },
      MODEL,
    );
    expect(context.messages[1]).toMatchObject({
      role: "assistant",
      provider: "anthropic",
      model: "claude-haiku-4-5",
      api: "openai-completions",
    });
  });

  it("an origin naming the current model stamps exactly what no origin does (signatures stay replayable)", () => {
    const withOrigin = (origin?: { provider: string; model: string }) =>
      toPiContext(
        {
          ...BASE,
          messages: [
            { role: "user", content: "hi" },
            {
              role: "assistant",
              content: "hello",
              thinking: [{ text: "pondering", signature: "sig" }],
              ...(origin !== undefined ? { origin } : {}),
            },
          ],
        },
        MODEL,
      );
    expect(withOrigin({ provider: "deepseek", model: "deepseek-chat" })).toEqual(withOrigin());
  });
```

- [ ] **Step 2: Run to verify they fail.** Run (from `packages/nax-ai`): `bun run test -- test/protocols/pi-client.test.ts`. Expected: FAIL. TypeScript-in-vitest accepts the unknown `origin` field, but the first test sees `provider: "deepseek"`.

- [ ] **Step 3: Implement.** In `types.ts`, the assistant member becomes:

```ts
  | {
      readonly role: "assistant";
      readonly content: string;
      readonly toolCalls?: readonly ToolCall[];
      readonly thinking?: readonly ThinkingBlock[];
      /**
       * The catalog provider and model id that wrote this message, when known.
       * Replay stamps it so pi-ai can tell another model's turn from the
       * current model's: another model's thinking is sent as text without its
       * signature. Absent means the current model.
       */
      readonly origin?: { readonly provider: string; readonly model: string };
    }
```

In `pi-client.ts` `toPiMessages`, replace the three stamp lines `api: model.api, provider: model.provider, model: model.id,` with:

```ts
        // The author, not the current model: pi-ai's transformMessages compares
        // provider/api/model to decide whether thinking signatures replay.
        api: model.api,
        provider: message.origin?.provider ?? model.provider,
        model: message.origin?.model ?? model.id,
```

- [ ] **Step 4: Run tests and gates** (from `packages/nax-ai`): `bun run typecheck && bun run lint && bun run test`. Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/nax-ai/src/protocols/types.ts packages/nax-ai/src/protocols/pi-client.ts packages/nax-ai/test/protocols/pi-client.test.ts
git commit -m "feat(nax-ai): assistant messages record their origin model for safe cross-model replay"
```

---

### Task 1: nax-agent's loop records each assistant message's origin

**Files:**
- Modify: `packages/nax-agent/src/native/session/turn-loop-round-trip.ts` (the `state.messages.push({ role: "assistant", ... })` at ~line 266, inside `runModelRoundTrip`)
- Modify: `packages/nax-agent/src/native/session/handle-invalid-tool-call.ts` (`rewriteToolCallInput`, ~line 131)
- Test: `packages/nax-agent/test/unit/native/session/turn-loop-transcript-identity.test.ts`

**Interfaces:**
- Consumes: Task 0's `origin` field.
- Produces: every assistant message the native loop persists carries `origin: { provider, model }`. These come from the handle's `"provider/model[effort]"` string with the effort suffix stripped and split on the first `/`, which is the same pair `parseNativeModel` hands `client.model(provider, model)`. There is no origin when the handle has no model, or its model has no `/`.

- [ ] **Step 1: Write the failing tests.** Append a new `describe` to `turn-loop-transcript-identity.test.ts`. It reuses that file's `turn`, `onModel`, `dir` and `SESSION`:

```ts
describe("runNativeTurn — assistant origin (S5-3 M-19)", () => {
  test("the saved assistant message records the provider and model that wrote it, effort stripped", async () => {
    await turn(onModel("openai/model-a[high]"), "first");
    const file = JSON.parse(await readFile(transcriptPath(dir, SESSION), "utf8")) as { messages: unknown[] };
    expect(file.messages[1]).toMatchObject({ role: "assistant", origin: { provider: "openai", model: "model-a" } });
  });

  test("the request replays the earlier assistant message with its origin", async () => {
    await turn(onModel("openai/model-a"), "first");
    const sent = await turn(onModel("openai/model-a"), "second");
    expect(sent[0]?.[1]).toMatchObject({ role: "assistant", origin: { provider: "openai", model: "model-a" } });
  });

  test("a handle with no model records no origin", async () => {
    await turn(onModel(), "first");
    const file = JSON.parse(await readFile(transcriptPath(dir, SESSION), "utf8")) as { messages: unknown[] };
    expect(file.messages[1]).not.toHaveProperty("origin");
  });
});
```

In the test file for `handle-invalid-tool-call.ts`, add a test for `rewriteToolCallInput`. Find that file with `grep -rln "rewriteToolCallInput\|handle-invalid-tool-call" packages/nax-agent/test/unit`, or create `packages/nax-agent/test/unit/native/session/handle-invalid-tool-call.test.ts` if none exists:

```ts
import { describe, expect, test } from "bun:test";
import { rewriteToolCallInput } from "#src/native/session/handle-invalid-tool-call";

describe("rewriteToolCallInput keeps the origin (S5-3 M-19)", () => {
  test("the rebuilt assistant message keeps origin and thinking", () => {
    const out = rewriteToolCallInput(
      [
        { role: "user", content: "go" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "c1", name: "Read", input: { path: 1 } }],
          thinking: [{ text: "t", signature: "s" }],
          origin: { provider: "anthropic", model: "claude-haiku-4-5" },
        },
      ],
      "c1",
      { path: "a.ts" },
    );
    expect(out[1]).toMatchObject({
      origin: { provider: "anthropic", model: "claude-haiku-4-5" },
      thinking: [{ text: "t", signature: "s" }],
      toolCalls: [{ id: "c1", input: { path: "a.ts" } }],
    });
  });
});
```

- [ ] **Step 2: Run to verify they fail.** From `packages/nax-agent`: `timeout 60 bun test ./test/unit/native/session/turn-loop-transcript-identity.test.ts --timeout=60000`, plus the rewrite test's file. Expected: the origin tests FAIL. "no origin" passes.

- [ ] **Step 3: Implement.**

In `turn-loop-round-trip.ts`, add `import { parseModelSpec } from "../models.ts";`. `models.ts` re-exports `parseModelSpec`; `transcript-identity.ts` imports it the same way. Then add this module-level helper:

```ts
/**
 * The catalog provider and model that answer for this handle: the
 * "provider/model[effort]" string, effort stripped, split on the first "/".
 * The same pair parseNativeModel hands client.model(); undefined, never a
 * throw, when there is no usable model.
 */
function originOf(raw: string | undefined): { readonly provider: string; readonly model: string } | undefined {
  if (raw === undefined) return undefined;
  const spec = parseModelSpec(raw).model;
  const slash = spec.indexOf("/");
  if (slash <= 0 || slash === spec.length - 1) return undefined;
  return { provider: spec.slice(0, slash), model: spec.slice(slash + 1) };
}
```

Change the push to:

```ts
  const origin = originOf(handle.modelDef?.model);
  state.messages.push({
    role: "assistant",
    content: assistantText,
    ...(assistantToolCalls !== undefined ? { toolCalls: assistantToolCalls } : {}),
    ...(assistantThinking !== undefined ? { thinking: assistantThinking } : {}),
    ...(origin !== undefined ? { origin } : {}),
  });
```

`handle` is already destructured from `params` at the top of `runModelRoundTrip`.

In `handle-invalid-tool-call.ts` `rewriteToolCallInput`, add to the rebuilt assistant object:

```ts
      ...(lastAssistant.origin !== undefined ? { origin: lastAssistant.origin } : {}),
```

- [ ] **Step 4: Run tests and gates.** From `packages/nax-agent`: `timeout 120 bun test ./test/unit/native/ --timeout=60000 && bun run typecheck && bun run check:all`. Expected: PASS. If `parseModelSpec` is not exported from `../models.ts`, import it from `#src/cost/model-spec`, where it is defined (`src/cost/model-spec.ts:33`).

- [ ] **Step 5: Commit**

```bash
git add packages/nax-agent/src/native/session/turn-loop-round-trip.ts packages/nax-agent/src/native/session/handle-invalid-tool-call.ts packages/nax-agent/test/unit/native/session/
git commit -m "feat(nax-agent): record each assistant message's origin model"
```

---

### Task 2: nax-agent opt-in `carryHistoryAcrossModels`

**Files:**
- Modify: `packages/nax-agent/src/session/native-backend-options.ts` (`NativeBackendOptions` ~line 17, `OptionsSchema` ~line 46)
- Modify: `packages/nax-agent/src/session/native-backend.ts` (`openNative`: `checkResumeModel` call ~line 55, `adapter.openSession({...})` ~lines 82-105)
- Modify: `packages/nax-agent/src/session/session-types.ts` (`OpenSessionOpts`, line 92)
- Modify: `packages/nax-agent/src/native/session/session.ts`
  - `NativeSessionState` (~line 44)
  - `createNativeSessionState` (~line 159)
  - `openNativeSession` (~line 273)
  - `clearNativeSessionState` (~line 323)
- Modify: `packages/nax-agent/src/native/session/transcript-identity.ts` (`TranscriptIdentity` ~line 18, `isForeignTranscript` ~line 45)
- Modify: `packages/nax-agent/src/native/session/turn-loop.ts` (the `transcriptIdentity` literal, ~line 86)
- Modify: `packages/nax-agent/src/native/session/instruction-session.ts` (`modelMatches`, ~line 27)
- Modify: `packages/nax-agent/api/nax-agent.api.txt` (run `bun run api:update`; the snapshot records names only, so expect no change)
- Test: `test/unit/native/session/turn-loop-transcript-identity.test.ts`, `test/unit/session/native-backend.test.ts`

**Interfaces:**
- Consumes: Task 1.
- Produces:
  - `NativeBackendOptions.carryHistoryAcrossModels?: boolean`.
  - `OpenSessionOpts.carryHistoryAcrossModels?: boolean`.
  - `NativeSessionState.carryHistoryAcrossModels: Set<string>`.
  - `TranscriptIdentity.carryAcrossModels?: boolean`.
  - With the flag:
    - a resume from another model's document is not refused;
    - the loop keeps that history;
    - instruction directories rehydrate;
    - the transcript's `model` becomes the current model at the next save (unchanged writer);
    - the per-model compaction anchor is still not reused.

- [ ] **Step 1: Write the failing tests.**

Append to `turn-loop-transcript-identity.test.ts`:

```ts
describe("runNativeTurn — carryHistoryAcrossModels (S5-3 M-19)", () => {
  test("with the flag, a turn on another model keeps the conversation", async () => {
    await turn(onModel("openai/model-a"), "first");
    sessionState.carryHistoryAcrossModels.add(SESSION);
    const sent = await turn(onModel("anthropic/model-b"), "second");
    expect(sent[0]).toHaveLength(3);
    expect(sent[0]?.[1]).toMatchObject({ role: "assistant", origin: { provider: "openai", model: "model-a" } });
    const file: unknown = JSON.parse(await readFile(transcriptPath(dir, SESSION), "utf8"));
    expect(file).toMatchObject({ model: "anthropic/model-b" });
  });

  test("with the flag, the other model's anchor is still not read", async () => {
    await turn(onModel("openai/model-a"), "first");
    sessionState.carryHistoryAcrossModels.add(SESSION);
    const seen: (number | undefined)[] = [];
    const registry = createLoopEventRegistry();
    registry.register("transform_context", (p) => {
      seen.push(p.anchorIndex);
      return {};
    });
    await turn(onModel("anthropic/model-b"), "second", registry);
    expect(seen[0]).toBeUndefined();
  });
});
```

Append to `native-backend.test.ts`, beside the existing "a resume from a document written by another model is refused" test, which stays as the control:

```ts
  test("carryHistoryAcrossModels lets a resume read another model's document", async () => {
    const backend = nativeBackend({ model: MODEL, carryHistoryAcrossModels: true });
    const doc = { savedAt: new Date(0).toISOString(), messages: [], model: "anthropic/other" };
    const opened = await backend.open(await ctx({ resume: { doc } }));
    await opened.close();
  });

  test("carryHistoryAcrossModels must be a boolean", () => {
    let caught: unknown;
    try {
      nativeBackend({ model: MODEL, carryHistoryAcrossModels: "yes" as never });
    } catch (err) {
      caught = err;
    }
    assertNaxError(caught);
    expect(caught.code).toBe("AGENT_SESSION_INVALID_OPTIONS");
  });
```

`as never` is banned by a biome plugin. Use the pattern the file already uses for a wrongly typed option: `grep -n "absentValue\|nullValue\|parseNativeBackendOptions" test/unit/session/native-backend-options.test.ts`. If the existing tests validate through `parseNativeBackendOptions(unknown)`, put the boolean test in `native-backend-options.test.ts` calling `parseNativeBackendOptions({ model: MODEL, carryHistoryAcrossModels: "yes" })`.

- [ ] **Step 2: Run to verify they fail.** From `packages/nax-agent`: `timeout 60 bun test ./test/unit/native/session/turn-loop-transcript-identity.test.ts ./test/unit/session/native-backend.test.ts --timeout=60000`. Expected: FAIL. `carryHistoryAcrossModels` is not a property of the session state, and the option is rejected by the strict schema.

- [ ] **Step 3: Implement.**

`native-backend-options.ts`:
- In `NativeBackendOptions`, add: `/** Keep a resumed or continued conversation when the model differs (ACP server model switch, S5-3). */ readonly carryHistoryAcrossModels?: boolean;`
- In `OptionsSchema`, add: `carryHistoryAcrossModels: z.boolean().optional(),`

`session-types.ts`, in `OpenSessionOpts`, add: `/** Native: keep history written by another model (S5-3). */ readonly carryHistoryAcrossModels?: boolean;`

`native-backend.ts`:
- Change the resume check to: `if (ctx.resume !== undefined && raw.carryHistoryAcrossModels !== true) checkResumeModel(ctx.resume.doc, ctx.sessionId, raw.model);`
- In the `adapter.openSession({...})` literal, add: `...(raw.carryHistoryAcrossModels === true ? { carryHistoryAcrossModels: true } : {}),`

`native/session/session.ts`:
- `NativeSessionState`: add `/** Sessions that keep history written by another model (S5-3). */ readonly carryHistoryAcrossModels: Set<string>;`
- `createNativeSessionState`: add `carryHistoryAcrossModels: new Set(),`
- `openNativeSession`, after the `transcriptOwners` lines:

```ts
  if (opts.carryHistoryAcrossModels === true) state.carryHistoryAcrossModels.add(name);
  else state.carryHistoryAcrossModels.delete(name);
```

- `clearNativeSessionState`: add `state.carryHistoryAcrossModels.delete(sessionName);`

`transcript-identity.ts`:
- `TranscriptIdentity`: add `/** Keep a document written by another model (S5-3); \`model\` still names the current one. */ readonly carryAcrossModels?: boolean;`
- In `isForeignTranscript`, change the model condition to `if (identity.carryAcrossModels !== true && model !== undefined && doc.model !== undefined && doc.model !== model) {`.

`turn-loop.ts`, in the `transcriptIdentity` literal, add:

```ts
    ...(deps.sessionState.carryHistoryAcrossModels.has(handle.id) ? { carryAcrossModels: true } : {}),
```

`instruction-session.ts`: change the model match to

```ts
  const modelMatches =
    opts.carryHistoryAcrossModels === true ||
    doc?.model === undefined ||
    doc.model === transcriptModelIdentity(opts.modelDef?.model);
```

`seedNativeSession` (`test/helpers/native-session-state.ts`) builds state from `createNativeSessionState()`, so it gets the new set automatically. If a test constructs `NativeSessionState` by hand and typecheck flags it, add `carryHistoryAcrossModels: new Set()` there.

- [ ] **Step 4: Run tests and gates.** From `packages/nax-agent`: `timeout 300 bun test ./test/unit/ --timeout=60000 && bun run typecheck && bun run check:all && bun run api:update && git diff --stat api/`. Expected: PASS, and the API diff is empty. Then `bun run test:coverage`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/nax-agent/src packages/nax-agent/test packages/nax-agent/api
git commit -m "feat(nax-agent): carryHistoryAcrossModels opt-in keeps history across a model change"
```

---

### Task 3: Reopen = resume or create; S5-2 option fixes

**Files:**
- Modify: `packages/nax-agent-acp/src/server/open-session.ts`
- Modify: `packages/nax-agent-acp/src/server/options.ts` (the `mode.value === "ask" && bash.value === "raw"` check)
- Modify: `packages/nax-agent-acp/src/server/registry.ts`. Use `.session` of the new return value; the S5-2 registry is replaced in Task 7.
- Modify: `packages/nax-agent-acp/src/server/main.ts` (`nativeOpenSession({...})` call)
- Test: `test/unit/server/open-session.test.ts`, `test/unit/server/options.test.ts`. Also update the openers in `test/unit/server/registry.test.ts`, `connection.test.ts` and `connection-sessions.test.ts` to return `{ session, doc: null }`.

**Interfaces:**
- Consumes: Task 2's `carryHistoryAcrossModels`.
- Produces (`#src/server/open-session`):
  - `interface OpenSessionRequest { readonly sessionId: string; readonly cwd: string; readonly model: string; readonly profile: AgentSessionProfile; readonly bashApproval: BashApproval }`. Unchanged.
  - `interface OpenedSession { readonly session: AgentSession; readonly doc: TranscriptDoc | null }`. `doc` is the stored document read before opening.
  - `type OpenSession = (request: OpenSessionRequest) => Promise<OpenedSession>`.
  - `interface NativeOpenDeps { readonly transcripts: TranscriptStore; readonly catalogOverrides: NativeCatalogOverrides; readonly turnTimeoutSeconds: number; readonly create?: (options: CreateAgentSessionOptions) => Promise<AgentSession>; readonly resume?: (sessionId: string, options: CreateAgentSessionOptions) => Promise<AgentSession>; readonly backend?: (options: NativeBackendOptions) => SessionBackend }`.
  - `function nativeOpenSession(deps: NativeOpenDeps): OpenSession`.
  - `catalogOverridesFrom` is unchanged.

- [ ] **Step 1: Write the failing tests.** Replace the `describe("nativeOpenSession", ...)` block in `open-session.test.ts` with:

```ts
function recorder() {
  const backendCalls: NativeBackendOptions[] = [];
  const created: CreateAgentSessionOptions[] = [];
  const resumed: { id: string; options: CreateAgentSessionOptions }[] = [];
  const backend = (options: NativeBackendOptions): SessionBackend => {
    backendCalls.push(options);
    return unusedBackend();
  };
  const create = async (options: CreateAgentSessionOptions): Promise<AgentSession> => {
    created.push(options);
    return fakeAgentSession(options.sessionId ?? "x", []).session;
  };
  const resume = async (id: string, options: CreateAgentSessionOptions): Promise<AgentSession> => {
    resumed.push({ id, options });
    return fakeAgentSession(id, []).session;
  };
  return { backendCalls, created, resumed, backend, create, resume };
}

const REQUEST = {
  sessionId: "s-1",
  cwd: "/w",
  model: "anthropic/claude-sonnet-5-5",
  profile: "ask" as const,
  bashApproval: "gated" as const,
};

describe("nativeOpenSession (S5-3 M-21, M-22)", () => {
  test("no stored document: creates, with carryHistoryAcrossModels and the turn limit", async () => {
    const r = recorder();
    const transcripts = createMemoryTranscriptStore();
    const open = nativeOpenSession({ transcripts, catalogOverrides: [], turnTimeoutSeconds: 3600, ...r });
    const opened = await open(REQUEST);
    expect(opened.doc).toBeNull();
    expect(opened.session.id).toBe("s-1");
    expect(r.resumed).toEqual([]);
    expect(r.backendCalls).toEqual([
      { model: "anthropic/claude-sonnet-5-5", carryHistoryAcrossModels: true, bashApproval: "gated" },
    ]);
    expect(r.created[0]).toMatchObject({
      sessionId: "s-1",
      profile: "ask",
      workdir: "/w",
      transcriptStore: transcripts,
      turnTimeoutSeconds: 3600,
    });
  });

  test("a stored document: resumes that session and returns the document", async () => {
    const r = recorder();
    const transcripts = createMemoryTranscriptStore();
    await transcripts.save("s-1", { savedAt: "2026-10-09T00:00:00.000Z", messages: [{ role: "user", content: "hi" }] });
    const open = nativeOpenSession({ transcripts, catalogOverrides: [], turnTimeoutSeconds: 3600, ...r });
    const opened = await open(REQUEST);
    expect(opened.doc?.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(r.created).toEqual([]);
    expect(r.resumed[0]?.id).toBe("s-1");
  });

  test("modes none and read pass no bashApproval; none passes no workdir", async () => {
    const r = recorder();
    const open = nativeOpenSession({
      transcripts: createMemoryTranscriptStore(),
      catalogOverrides: [],
      turnTimeoutSeconds: 3600,
      ...r,
    });
    await open({ ...REQUEST, profile: "read" });
    await open({ ...REQUEST, sessionId: "s-2", profile: "none" });
    expect(r.backendCalls.map((c) => "bashApproval" in c)).toEqual([false, false]);
    expect(r.created[0]).toMatchObject({ workdir: "/w" });
    expect(r.created[1]).not.toHaveProperty("workdir");
  });

  test("catalog overrides are passed only when there are some", async () => {
    const r = recorder();
    const open = nativeOpenSession({
      transcripts: createMemoryTranscriptStore(),
      catalogOverrides: [{ provider: "minimax", models: [] }],
      turnTimeoutSeconds: 3600,
      ...r,
    });
    await open(REQUEST);
    expect(r.backendCalls[0]).toMatchObject({ catalogOverrides: [{ provider: "minimax", models: [] }] });
  });

  test("defaults to the real facade: an invalid model is rejected by nativeBackend", async () => {
    const open = nativeOpenSession({
      transcripts: createMemoryTranscriptStore(),
      catalogOverrides: [],
      turnTimeoutSeconds: 3600,
    });
    await expect(open({ ...REQUEST, model: "" })).rejects.toMatchObject({ code: "AGENT_SESSION_INVALID_OPTIONS" });
  });
});
```

In `options.test.ts`, replace the "mode ask with raw bash approval is refused up front" test with:

```ts
  test("mode ask requires gated bash approval (raw and escalate are refused up front)", () => {
    for (const bashApproval of ["raw", "escalate"]) {
      expect(
        resolveServerOptions({ flags: { mode: "ask", bashApproval }, env: {}, file: FILE, configDir: "/c" }),
      ).toEqual({ ok: false, message: `bash approval "${bashApproval}" cannot be used with mode "ask"; ask requires gated` });
    }
  });
```

- [ ] **Step 2: Run to verify they fail.** `timeout 60 bun test ./test/unit/server/open-session.test.ts ./test/unit/server/options.test.ts --timeout=60000`. Expected: FAIL (no `transcripts` dep, `opened.doc` undefined, escalate accepted).

- [ ] **Step 3: Implement.**

Replace `nativeOpenSession` and its deps in `open-session.ts`, keeping `catalogOverridesFrom`, `isCatalogOverride` and `OpenSessionRequest`:

```ts
export interface OpenedSession {
  readonly session: AgentSession;
  /** The stored document read before opening; null for a session never prompted. */
  readonly doc: TranscriptDoc | null;
}

export type OpenSession = (request: OpenSessionRequest) => Promise<OpenedSession>;

export interface NativeOpenDeps {
  readonly transcripts: TranscriptStore;
  readonly catalogOverrides: NativeCatalogOverrides;
  readonly turnTimeoutSeconds: number;
  readonly create?: (options: CreateAgentSessionOptions) => Promise<AgentSession>;
  readonly resume?: (sessionId: string, options: CreateAgentSessionOptions) => Promise<AgentSession>;
  readonly backend?: (options: NativeBackendOptions) => SessionBackend;
}

/** nax-agent accepts bashApproval only where Bash is offered (M-22). */
const TOOL_PROFILES: ReadonlySet<AgentSessionProfile> = new Set(["ask", "full"]);

/**
 * Resume when the store holds the session's document, create when it does not:
 * a session never prompted has none (M-21). History is kept across a model
 * change (M-19).
 */
export function nativeOpenSession(deps: NativeOpenDeps): OpenSession {
  const create = deps.create ?? createAgentSession;
  const resume = deps.resume ?? resumeAgentSession;
  const backend = deps.backend ?? nativeBackend;
  return async (request) => {
    const doc = await deps.transcripts.load(request.sessionId);
    const options: CreateAgentSessionOptions = {
      backend: backend({
        model: request.model,
        carryHistoryAcrossModels: true,
        ...(TOOL_PROFILES.has(request.profile) ? { bashApproval: request.bashApproval } : {}),
        ...(deps.catalogOverrides.length > 0 ? { catalogOverrides: deps.catalogOverrides } : {}),
      }),
      sessionId: request.sessionId,
      profile: request.profile,
      ...(request.profile !== "none" ? { workdir: request.cwd } : {}),
      transcriptStore: deps.transcripts,
      turnTimeoutSeconds: deps.turnTimeoutSeconds,
    };
    const session = doc === null ? await create(options) : await resume(request.sessionId, options);
    return { session, doc };
  };
}
```

Update its imports: add `resumeAgentSession` and `type TranscriptDoc`, and drop `createFileTranscriptStore`. Update the file header to mention resume.

`options.ts`: replace the check with

```ts
  if (mode.value === "ask" && bash.value !== "gated") {
    return {
      ok: false,
      message: `bash approval "${bash.value}" cannot be used with mode "ask"; ask requires gated`,
    };
  }
```

`registry.ts` (S5-2 version): `const agentSession = (await deps.openSession({...})).session;`

`main.ts`: `nativeOpenSession({ transcripts: createFileTranscriptStore(resolved.options.sessionsDir), catalogOverrides: ..., turnTimeoutSeconds: TURN_TIMEOUT_SECONDS })`, importing `createFileTranscriptStore` from `@nathapp/nax-agent`.

Tests: change every `openSession` stub in `registry.test.ts`, `connection.test.ts` and `connection-sessions.test.ts` that returns `fake.session` to return `{ session: fake.session, doc: null }`.

- [ ] **Step 4: Run tests and gates.** From `packages/nax-agent-acp`: `bun run typecheck && bun run check:all && timeout 300 bun test ./test/unit/ --timeout=60000`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/nax-agent-acp/src/server packages/nax-agent-acp/test/unit/server
git commit -m "fix(acp-server): reopen resumes or creates; bashApproval only for ask/full; ask requires gated"
```

---

### Task 4: Session modes and config options

**Files:**
- Create: `packages/nax-agent-acp/src/server/session-config.ts`
- Test: `packages/nax-agent-acp/test/unit/server/session-config.test.ts`

**Interfaces:**
- Consumes: `invalidParams` (`#src/server/errors`); `BASH_APPROVALS`, `BashApproval`, `MODES`, `TierModel` (`#src/server/nax-config`).
- Produces (`#src/server/session-config`):
  - `interface SessionSettings { readonly mode: AgentSessionProfile; readonly model: string; readonly bashApproval: BashApproval }`
  - `const MODEL_OPTION = "model"`, `const BASH_OPTION = "bashApproval"`
  - `const SESSION_MODES: readonly SessionMode[]`
  - `function modeState(settings: SessionSettings): SessionModeState`
  - `function modelChoices(settings: SessionSettings, tiers: readonly TierModel[]): readonly { value: string; name: string; description: string }[]`
  - `function configOptions(settings: SessionSettings, tiers: readonly TierModel[]): SessionConfigOption[]`
  - `function applyModeChange(settings: SessionSettings, modeId: string): SessionSettings`. It throws `invalid_params`, and coerces `ask` to `gated` (M-23).
  - `function applyConfigChange(settings: SessionSettings, configId: string, value: unknown, tiers: readonly TierModel[]): SessionSettings`. It throws `invalid_params`.
  - `function sameSettings(a: SessionSettings, b: SessionSettings): boolean`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { RequestError } from "@agentclientprotocol/sdk";
import type { TierModel } from "#src/server/nax-config";
import {
  applyConfigChange,
  applyModeChange,
  BASH_OPTION,
  configOptions,
  MODEL_OPTION,
  modeState,
  SESSION_MODES,
  type SessionSettings,
  sameSettings,
} from "#src/server/session-config";

const TIERS: readonly TierModel[] = [
  { tier: "fast", model: "anthropic/claude-haiku-4-5" },
  { tier: "balanced", model: "anthropic/claude-sonnet-5-5", contextWindow: 200_000 },
  { tier: "powerful", model: "anthropic/claude-sonnet-5-5" },
];
const BASE: SessionSettings = { mode: "full", model: "anthropic/claude-sonnet-5-5", bashApproval: "gated" };

function rejects(run: () => unknown): RequestError {
  try {
    run();
  } catch (error) {
    if (error instanceof RequestError) return error;
  }
  throw new Error("expected a RequestError");
}

describe("modes (spec §5.2, M-27)", () => {
  test("four modes, current one selected", () => {
    expect(SESSION_MODES.map((m) => m.id)).toEqual(["none", "read", "ask", "full"]);
    expect(modeState(BASE)).toEqual({ currentModeId: "full", availableModes: [...SESSION_MODES] });
  });

  test("switching to ask coerces bash approval to gated (M-23)", () => {
    expect(applyModeChange({ ...BASE, bashApproval: "raw" }, "ask")).toEqual({ ...BASE, mode: "ask", bashApproval: "gated" });
    expect(applyModeChange(BASE, "read")).toEqual({ ...BASE, mode: "read" });
  });

  test("an unknown mode is invalid_params", () => {
    expect(rejects(() => applyModeChange(BASE, "yolo")).code).toBe(-32602);
  });
});

describe("config options (spec §5.2, §5.3)", () => {
  test("model lists tiers (deduplicated by model) and bashApproval lists the three modes", () => {
    const [model, bash] = configOptions(BASE, TIERS);
    expect(model).toMatchObject({
      id: MODEL_OPTION,
      type: "select",
      category: "model",
      currentValue: "anthropic/claude-sonnet-5-5",
      options: [
        { value: "anthropic/claude-haiku-4-5", name: "fast", description: "anthropic/claude-haiku-4-5" },
        { value: "anthropic/claude-sonnet-5-5", name: "balanced", description: "anthropic/claude-sonnet-5-5" },
      ],
    });
    expect(bash).toMatchObject({ id: BASH_OPTION, type: "select", currentValue: "gated" });
    expect(bash?.type === "select" ? bash.options.map((o) => ("value" in o ? o.value : "")) : []).toEqual([
      "gated",
      "escalate",
      "raw",
    ]);
  });

  test("a current model outside the tiers is listed too (set by --model)", () => {
    const [model] = configOptions({ ...BASE, model: "openai/gpt-x" }, TIERS);
    expect(model?.type === "select" ? model.options.at(-1) : undefined).toEqual({
      value: "openai/gpt-x",
      name: "openai/gpt-x",
      description: "current model",
    });
  });

  test("a model change must name a listed model; the error lists the valid ids", () => {
    expect(applyConfigChange(BASE, MODEL_OPTION, "anthropic/claude-haiku-4-5", TIERS).model).toBe(
      "anthropic/claude-haiku-4-5",
    );
    const error = rejects(() => applyConfigChange(BASE, MODEL_OPTION, "nope/x", TIERS));
    expect(error.code).toBe(-32602);
    expect(error.message).toContain("anthropic/claude-haiku-4-5, anthropic/claude-sonnet-5-5");
  });

  test("bashApproval other than gated under ask is invalid_params; under full it applies", () => {
    expect(rejects(() => applyConfigChange({ ...BASE, mode: "ask" }, BASH_OPTION, "raw", TIERS)).code).toBe(-32602);
    expect(applyConfigChange(BASE, BASH_OPTION, "escalate", TIERS).bashApproval).toBe("escalate");
    expect(rejects(() => applyConfigChange(BASE, BASH_OPTION, "loose", TIERS)).code).toBe(-32602);
  });

  test("an unknown option or a non-string value is invalid_params", () => {
    expect(rejects(() => applyConfigChange(BASE, "temperature", "1", TIERS)).code).toBe(-32602);
    expect(rejects(() => applyConfigChange(BASE, MODEL_OPTION, true, TIERS)).code).toBe(-32602);
  });

  test("sameSettings compares all three fields", () => {
    expect(sameSettings(BASE, { ...BASE })).toBe(true);
    expect(sameSettings(BASE, { ...BASE, bashApproval: "raw" })).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails.** `timeout 30 bun test ./test/unit/server/session-config.test.ts`. Expected: FAIL (module missing).

- [ ] **Step 3: Implement `src/server/session-config.ts`**

```ts
/**
 * What an ACP session exposes about its settings (S5 spec §5.2, §5.3): the four
 * modes (S3 profiles), and two select config options, the model (the configured
 * tiers plus the current model) and the bash approval mode. Changes are
 * validated here; applying them is the registry's close-and-reopen (§3.3).
 */
import type { SessionConfigOption, SessionMode, SessionModeState } from "@agentclientprotocol/sdk";
import type { AgentSessionProfile } from "@nathapp/nax-agent";
import { invalidParams } from "#src/server/errors";
import { BASH_APPROVALS, type BashApproval, MODES, type TierModel } from "#src/server/nax-config";

export interface SessionSettings {
  readonly mode: AgentSessionProfile;
  readonly model: string;
  readonly bashApproval: BashApproval;
}

export const MODEL_OPTION = "model";
export const BASH_OPTION = "bashApproval";

export const SESSION_MODES: readonly SessionMode[] = [
  { id: "none", name: "Chat", description: "Chat only: no workspace tools." },
  { id: "read", name: "Read only", description: "Reads and searches the workspace; changes nothing." },
  { id: "ask", name: "Ask", description: "Asks before every edit and command." },
  { id: "full", name: "Full access", description: "Edits files and runs commands without asking, inside the sandbox." },
];

const BASH_CHOICES: readonly { value: BashApproval; name: string; description: string }[] = [
  { value: "gated", name: "Gated", description: "Commands are checked against the rules; one the checks cannot judge is refused." },
  { value: "escalate", name: "Escalate", description: "Like gated, but a command the checks cannot judge asks you instead." },
  { value: "raw", name: "Raw", description: "Commands run as written, without per-command checks (mode Full only)." },
];

export function sameSettings(a: SessionSettings, b: SessionSettings): boolean {
  return a.mode === b.mode && a.model === b.model && a.bashApproval === b.bashApproval;
}

export function modeState(settings: SessionSettings): SessionModeState {
  return { currentModeId: settings.mode, availableModes: [...SESSION_MODES] };
}

export function modelChoices(
  settings: SessionSettings,
  tiers: readonly TierModel[],
): readonly { value: string; name: string; description: string }[] {
  const seen = new Set<string>();
  const choices: { value: string; name: string; description: string }[] = [];
  for (const tier of tiers) {
    if (seen.has(tier.model)) continue;
    seen.add(tier.model);
    choices.push({ value: tier.model, name: tier.tier, description: tier.model });
  }
  if (!seen.has(settings.model)) {
    choices.push({ value: settings.model, name: settings.model, description: "current model" });
  }
  return choices;
}

export function configOptions(settings: SessionSettings, tiers: readonly TierModel[]): SessionConfigOption[] {
  return [
    {
      id: MODEL_OPTION,
      name: "Model",
      category: "model",
      type: "select",
      currentValue: settings.model,
      options: [...modelChoices(settings, tiers)],
    },
    {
      id: BASH_OPTION,
      name: "Bash approval",
      type: "select",
      currentValue: settings.bashApproval,
      options: [...BASH_CHOICES],
    },
  ];
}

export function applyModeChange(settings: SessionSettings, modeId: string): SessionSettings {
  const mode = MODES.find((m) => m === modeId);
  if (mode === undefined) throw invalidParams(`unknown mode "${modeId}"; expected one of ${MODES.join(", ")}`);
  // Ask runs every command past a person, which needs gated (M-23).
  return { ...settings, mode, bashApproval: mode === "ask" ? "gated" : settings.bashApproval };
}

export function applyConfigChange(
  settings: SessionSettings,
  configId: string,
  value: unknown,
  tiers: readonly TierModel[],
): SessionSettings {
  if (typeof value !== "string") throw invalidParams(`config option "${configId}" takes a string value`);
  if (configId === MODEL_OPTION) {
    const valid = modelChoices(settings, tiers).map((choice) => choice.value);
    if (!valid.includes(value)) throw invalidParams(`unknown model "${value}"; valid models: ${valid.join(", ")}`);
    return { ...settings, model: value };
  }
  if (configId === BASH_OPTION) {
    const bash = BASH_APPROVALS.find((b) => b === value);
    if (bash === undefined) throw invalidParams(`unknown bash approval "${value}"; expected one of ${BASH_APPROVALS.join(", ")}`);
    if (settings.mode === "ask" && bash !== "gated") {
      throw invalidParams('mode "ask" requires bash approval "gated"');
    }
    return { ...settings, bashApproval: bash };
  }
  throw invalidParams(`unknown config option "${configId}"`);
}
```

If the compiler rejects an `options` element shape against `SessionConfigSelectOptions`, build the arrays as `SessionConfigSelectOption[]`, imported from the SDK. Do not cast.

- [ ] **Step 4: Run it to verify it passes.** `timeout 30 bun test ./test/unit/server/session-config.test.ts && bun x tsc --noEmit`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
bun run lint:fix
git add src/server/session-config.ts test/unit/server/session-config.test.ts
git commit -m "feat(acp-server): S5-3 session modes and config options"
```

---

### Task 5: Session storage (metadata, lock, list)

**Files:**
- Create: `packages/nax-agent-acp/src/server/storage.ts`
- Test: `packages/nax-agent-acp/test/unit/server/storage.test.ts`

**Interfaces:**
- Consumes: `invalidParams`, `messageOf` (`#src/server/errors`); `MODES`, `BASH_APPROVALS` (`#src/server/nax-config`).
- Produces (`#src/server/storage`):
  - `const LIST_PAGE_SIZE = 50`
  - `type SessionMeta = Readonly<{ schemaVersion: 1; sessionId: string; cwd: string; mode: AgentSessionProfile; model: string; bashApproval: BashApproval; title: string | null; createdAt: string; updatedAt: string | null }>`
  - `function processAlive(pid: number): boolean`
  - `interface SessionStorage { readonly dir: string; readMeta(sessionId: string): Promise<SessionMeta | null>; writeMeta(meta: SessionMeta): Promise<void>; hasMeta(sessionId: string): Promise<boolean>; removeMeta(sessionId: string): Promise<void>; acquireLock(sessionId: string): Promise<() => Promise<void>>; list(query: { readonly cwd?: string | null; readonly cursor?: string | null }): Promise<ListSessionsResponse> }`
  - `interface StorageDeps { readonly dir: string; readonly pid: number; readonly now: () => Date; readonly logger: AgentLogger; readonly isAlive?: (pid: number) => boolean }`
  - `function createSessionStorage(deps: StorageDeps): SessionStorage`
  - `readMeta` throws `NaxError` code `SESSION_META_UNREADABLE` for bad JSON, a bad shape or an unknown `schemaVersion`. `acquireLock` throws `RequestError.invalidRequest` `session in use by pid N`.

- [ ] **Step 1: Write the failing test**

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RequestError } from "@agentclientprotocol/sdk";
import { cleanupTempDir, makeTempDir } from "@nathapp/nax-test-kit/bun/temp";
import { createSessionStorage, LIST_PAGE_SIZE, processAlive, type SessionMeta } from "#src/server/storage";
import { recordingLogger } from "#test/helpers/recording-logger";

let dir: string;
beforeEach(() => {
  dir = makeTempDir("acp-storage-");
});
afterEach(() => cleanupTempDir(dir));

function storage(isAlive: (pid: number) => boolean = () => false, pid = 1000) {
  const { logger, lines } = recordingLogger();
  return { store: createSessionStorage({ dir, pid, now: () => new Date("2026-10-09T00:00:00.000Z"), logger, isAlive }), lines };
}

const meta = (id: string, extra: Partial<SessionMeta> = {}): SessionMeta => ({
  schemaVersion: 1,
  sessionId: id,
  cwd: "/w",
  mode: "ask",
  model: "anthropic/claude-sonnet-5-5",
  bashApproval: "gated",
  title: null,
  createdAt: "2026-10-09T00:00:00.000Z",
  updatedAt: null,
  ...extra,
});

describe("metadata (spec §5.1)", () => {
  test("writes and reads back; a missing session reads null", async () => {
    const { store } = storage();
    await store.writeMeta(meta("a"));
    expect(await store.readMeta("a")).toEqual(meta("a"));
    expect(await store.readMeta("missing")).toBeNull();
    expect(await store.hasMeta("a")).toBe(true);
    expect(JSON.parse(await readFile(join(dir, "a.session.json"), "utf8"))).toEqual(meta("a"));
  });

  test("unreadable JSON, a bad shape and an unknown schemaVersion throw SESSION_META_UNREADABLE and leave the file", async () => {
    const { store } = storage();
    for (const [id, body] of [
      ["j", "{nope"],
      ["s", JSON.stringify({ schemaVersion: 1 })],
      ["v", JSON.stringify({ ...meta("v"), schemaVersion: 2 })],
    ] as const) {
      await writeFile(join(dir, `${id}.session.json`), body);
      await expect(store.readMeta(id)).rejects.toMatchObject({ code: "SESSION_META_UNREADABLE" });
      expect(await readFile(join(dir, `${id}.session.json`), "utf8")).toBe(body);
    }
  });

  test("removeMeta deletes; a missing file is fine", async () => {
    const { store } = storage();
    await store.writeMeta(meta("a"));
    await store.removeMeta("a");
    await store.removeMeta("a");
    expect(await store.hasMeta("a")).toBe(false);
  });
});

describe("lock (spec §5.1 lock rule)", () => {
  test("takes the lock, writes pid and startedAt; release removes it", async () => {
    const { store } = storage();
    const release = await store.acquireLock("a");
    expect(JSON.parse(await readFile(join(dir, "a.lock"), "utf8"))).toEqual({
      pid: 1000,
      startedAt: "2026-10-09T00:00:00.000Z",
    });
    await release();
    await release();
    const again = await store.acquireLock("a");
    await again();
  });

  test("a live lock held by another process refuses with its pid", async () => {
    await writeFile(join(dir, "a.lock"), JSON.stringify({ pid: 4242, startedAt: "x" }));
    const { store } = storage((pid) => pid === 4242);
    const caught = await store.acquireLock("a").catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(RequestError);
    expect(caught instanceof RequestError ? caught.message : "").toContain("session in use by pid 4242");
  });

  test("a dead pid's lock and an unreadable lock are taken over", async () => {
    await writeFile(join(dir, "a.lock"), JSON.stringify({ pid: 4242, startedAt: "x" }));
    await writeFile(join(dir, "b.lock"), "garbage");
    const { store, lines } = storage(() => false);
    await (await store.acquireLock("a"))();
    await (await store.acquireLock("b"))();
    expect(lines.filter((l) => l.message.includes("stale")).length).toBe(2);
  });

  test("processAlive: this process is alive; an impossible pid is not", () => {
    expect(processAlive(process.pid)).toBe(true);
    expect(processAlive(2 ** 30)).toBe(false);
  });
});

describe("list (spec §5.3 session/list)", () => {
  test("filters by cwd, sorts by updatedAt (createdAt when null) newest first, skips unreadable files", async () => {
    const { store, lines } = storage();
    await store.writeMeta(meta("old", { createdAt: "2026-10-01T00:00:00.000Z" }));
    await store.writeMeta(meta("new", { createdAt: "2026-10-02T00:00:00.000Z", updatedAt: "2026-10-08T00:00:00.000Z", title: "fix it" }));
    await store.writeMeta(meta("elsewhere", { cwd: "/other" }));
    await writeFile(join(dir, "bad.session.json"), "{");
    await writeFile(join(dir, "x.transcript.json"), "{}");
    const page = await store.list({ cwd: "/w" });
    expect(page.sessions).toEqual([
      { sessionId: "new", cwd: "/w", title: "fix it", updatedAt: "2026-10-08T00:00:00.000Z" },
      { sessionId: "old", cwd: "/w", title: null, updatedAt: "2026-10-01T00:00:00.000Z" },
    ]);
    expect(page.nextCursor).toBeUndefined();
    expect(lines.some((l) => l.level === "warn" && l.data?.file === "bad.session.json")).toBe(true);
    expect((await store.list({})).sessions).toHaveLength(3);
  });

  test("pages of 50 with an opaque cursor; a bad cursor is invalid_params; a missing dir lists nothing", async () => {
    const { store } = storage();
    for (let i = 0; i < LIST_PAGE_SIZE + 3; i += 1) {
      await store.writeMeta(meta(`s${String(i).padStart(3, "0")}`, { createdAt: `2026-10-09T00:00:${String(i % 60).padStart(2, "0")}.000Z` }));
    }
    const first = await store.list({});
    expect(first.sessions).toHaveLength(LIST_PAGE_SIZE);
    const second = await store.list({ cursor: first.nextCursor ?? null });
    expect(second.sessions).toHaveLength(3);
    expect(second.nextCursor).toBeUndefined();
    expect(await store.list({ cursor: "!!" }).catch((e: unknown) => (e instanceof RequestError ? e.code : 0))).toBe(-32602);
    const empty = createSessionStorage({ dir: join(dir, "nope"), pid: 1, now: () => new Date(), logger: recordingLogger().logger });
    expect(await empty.list({})).toEqual({ sessions: [] });
  });
});
```

- [ ] **Step 2: Run to verify it fails.** `timeout 30 bun test ./test/unit/server/storage.test.ts`. Expected: FAIL (module missing).

- [ ] **Step 3: Implement `src/server/storage.ts`**

```ts
/**
 * Session files beside the S3 transcript (S5 spec §5.1): `<id>.session.json`
 * metadata, written as a temp file then renamed, and `<id>.lock`, created
 * exclusively. A lock whose pid is dead, or that cannot be read, is stale and
 * taken over; a live one refuses the open. Listing scans the metadata files.
 * Files that cannot be read are never rewritten or deleted here.
 */
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type ListSessionsResponse, RequestError, type SessionInfo } from "@agentclientprotocol/sdk";
import { type AgentLogger, NaxError } from "@nathapp/nax-agent";
import { z } from "zod";
import { invalidParams, messageOf } from "#src/server/errors";
import { BASH_APPROVALS, MODES } from "#src/server/nax-config";

export const LIST_PAGE_SIZE = 50;
const META_SUFFIX = ".session.json";

const MetaSchema = z.object({
  schemaVersion: z.literal(1),
  sessionId: z.string().min(1),
  cwd: z.string().min(1),
  mode: z.enum(MODES),
  model: z.string().min(1),
  bashApproval: z.enum(BASH_APPROVALS),
  title: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string().nullable(),
});

export type SessionMeta = Readonly<z.infer<typeof MetaSchema>>;

const LockSchema = z.object({ pid: z.number().int().positive(), startedAt: z.string() });

export interface SessionStorage {
  readonly dir: string;
  readMeta(sessionId: string): Promise<SessionMeta | null>;
  writeMeta(meta: SessionMeta): Promise<void>;
  hasMeta(sessionId: string): Promise<boolean>;
  removeMeta(sessionId: string): Promise<void>;
  /** Resolves to the release function; refuses with invalid_request when another live process holds it. */
  acquireLock(sessionId: string): Promise<() => Promise<void>>;
  list(query: { readonly cwd?: string | null; readonly cursor?: string | null }): Promise<ListSessionsResponse>;
}

export interface StorageDeps {
  readonly dir: string;
  readonly pid: number;
  readonly now: () => Date;
  readonly logger: AgentLogger;
  readonly isAlive?: (pid: number) => boolean;
}

function codeOf(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

/** Signal 0 checks existence only. EPERM means the process exists under another user. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return codeOf(error) === "EPERM";
  }
}

function unreadable(sessionId: string, reason: string): NaxError {
  return new NaxError(`session metadata for "${sessionId}" is unreadable: ${reason}`, "SESSION_META_UNREADABLE", {
    stage: "agent-server",
    sessionId,
  });
}

function encodeCursor(offset: number): string {
  return Buffer.from(String(offset), "utf8").toString("base64");
}

function decodeCursor(cursor: string | null | undefined): number {
  if (cursor === undefined || cursor === null || cursor === "") return 0;
  const text = Buffer.from(cursor, "base64").toString("utf8");
  const offset = Number(text);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(offset)) throw invalidParams("invalid cursor");
  return offset;
}

const sortKey = (meta: SessionMeta): string => meta.updatedAt ?? meta.createdAt;

function infoOf(meta: SessionMeta): SessionInfo {
  return { sessionId: meta.sessionId, cwd: meta.cwd, title: meta.title, updatedAt: sortKey(meta) };
}

export function createSessionStorage(deps: StorageDeps): SessionStorage {
  const isAlive = deps.isAlive ?? processAlive;
  const metaPath = (id: string): string => join(deps.dir, `${id}${META_SUFFIX}`);
  const lockPath = (id: string): string => join(deps.dir, `${id}.lock`);

  async function readMeta(sessionId: string): Promise<SessionMeta | null> {
    let text: string;
    try {
      text = await readFile(metaPath(sessionId), "utf8");
    } catch (error) {
      if (codeOf(error) === "ENOENT") return null;
      throw unreadable(sessionId, messageOf(error));
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw unreadable(sessionId, "invalid JSON");
    }
    const version: unknown = typeof json === "object" && json !== null && "schemaVersion" in json ? json.schemaVersion : undefined;
    if (version !== 1) throw unreadable(sessionId, `schemaVersion ${String(version)}; this build reads 1`);
    const parsed = MetaSchema.safeParse(json);
    if (!parsed.success) throw unreadable(sessionId, parsed.error.issues[0]?.message ?? "bad shape");
    return parsed.data;
  }

  /** The pid holding the lock, or undefined when the lock cannot be read (stale). */
  async function lockHolder(path: string): Promise<number | undefined> {
    try {
      const parsed = LockSchema.safeParse(JSON.parse(await readFile(path, "utf8")));
      return parsed.success ? parsed.data.pid : undefined;
    } catch {
      return undefined;
    }
  }

  async function tryLock(path: string): Promise<boolean> {
    const body = JSON.stringify({ pid: deps.pid, startedAt: deps.now().toISOString() });
    try {
      await writeFile(path, body, { flag: "wx" });
      return true;
    } catch (error) {
      if (codeOf(error) === "EEXIST") return false;
      throw error;
    }
  }

  async function acquireLock(sessionId: string): Promise<() => Promise<void>> {
    await mkdir(deps.dir, { recursive: true });
    const path = lockPath(sessionId);
    const release = async (): Promise<void> => {
      await rm(path, { force: true });
    };
    if (await tryLock(path)) return release;
    const holder = await lockHolder(path);
    if (holder !== undefined && holder !== deps.pid && isAlive(holder)) {
      throw RequestError.invalidRequest(undefined, `session in use by pid ${holder}`);
    }
    deps.logger.info("session", "taking over a stale session lock", { sessionId, pid: holder });
    await rm(path, { force: true });
    if (await tryLock(path)) return release;
    throw RequestError.invalidRequest(undefined, "session in use by another process");
  }

  async function list(query: { readonly cwd?: string | null; readonly cursor?: string | null }): Promise<ListSessionsResponse> {
    const offset = decodeCursor(query.cursor);
    let names: string[];
    try {
      names = await readdir(deps.dir);
    } catch (error) {
      if (codeOf(error) === "ENOENT") return { sessions: [] };
      throw error;
    }
    const metas: SessionMeta[] = [];
    for (const name of names.filter((n) => n.endsWith(META_SUFFIX))) {
      try {
        const meta = await readMeta(name.slice(0, -META_SUFFIX.length));
        if (meta !== null) metas.push(meta);
      } catch (error) {
        deps.logger.warn("session", "skipping unreadable session metadata", { file: name, error: messageOf(error) });
      }
    }
    const matching = metas
      .filter((meta) => query.cwd === undefined || query.cwd === null || meta.cwd === query.cwd)
      .sort((a, b) => sortKey(b).localeCompare(sortKey(a)));
    const end = offset + LIST_PAGE_SIZE;
    return {
      sessions: matching.slice(offset, end).map(infoOf),
      ...(end < matching.length ? { nextCursor: encodeCursor(end) } : {}),
    };
  }

  return {
    dir: deps.dir,
    readMeta,
    async writeMeta(meta) {
      await mkdir(deps.dir, { recursive: true });
      const path = metaPath(meta.sessionId);
      const temp = `${path}.${deps.pid}.tmp`;
      await writeFile(temp, `${JSON.stringify(meta, null, 2)}\n`);
      await rename(temp, path);
    },
    async hasMeta(sessionId) {
      try {
        await stat(metaPath(sessionId));
        return true;
      } catch {
        return false;
      }
    },
    async removeMeta(sessionId) {
      await rm(metaPath(sessionId), { force: true });
    },
    acquireLock,
    list,
  };
}
```

`readMeta` checks the version before the shape, so an unknown `schemaVersion` gets its own message. If `check-complexity` flags `readMeta`, move the JSON parse and version check into a `parseMeta(sessionId, text)` helper.

- [ ] **Step 4: Run it to verify it passes.** `timeout 60 bun test ./test/unit/server/storage.test.ts && bun x tsc --noEmit && bun run check:all`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
bun run lint:fix
git add src/server/storage.ts test/unit/server/storage.test.ts
git commit -m "feat(acp-server): S5-3 session storage: metadata, lock, list"
```

---

### Task 6: ServerSession switches its S3 session and reports turns

**Files:**
- Modify: `packages/nax-agent-acp/src/server/server-session.ts`
- Modify: `packages/nax-agent-acp/test/helpers/fake-agent-session.ts`. Add a `lastTurn` option.
- Test: `packages/nax-agent-acp/test/unit/server/server-session-switch.test.ts`. This is a new file, so `server-session.test.ts` stays under 800 lines.

**Interfaces:**
- Consumes: `turnInProgress`, `messageOf`.
- Produces (additions to `#src/server/server-session`):
  - `ServerSessionDeps.onTurnEnd?: (message: string) => Promise<void>`. It is called after every prompt that reached `send()` (whatever its outcome); a rejection is logged, never thrown.
  - `interface SwitchTarget { readonly session: AgentSession; readonly contextWindow?: number }`.
  - `ServerSession.switchTo(open: () => Promise<SwitchTarget>, restore: () => Promise<SwitchTarget>): Promise<void>`:
    - It throws `turn in progress` while a turn runs.
    - It closes the current S3 session and adopts `open()`'s.
    - If `open` fails, it adopts `restore()`'s and rethrows the open error. If `restore` also fails, it logs at error and rethrows the open error; the session then fails later prompts with `internal_error`.
    - A prompt during the switch is `turn in progress`.
  - The context window and the S3 session are now mutable inside `createServerSession`. `id` is unchanged.
- `fakeAgentSession(id, scripts, options)`: `FakeAgentSessionOptions.lastTurn?: AgentSession["lastTurn"]`.

- [ ] **Step 1: Write the failing test**

`test/helpers/fake-agent-session.ts`:
- In `FakeAgentSessionOptions`, add `readonly lastTurn?: AgentSession["lastTurn"];`
- In the session literal, change `lastTurn: undefined` to `lastTurn: options.lastTurn`.

`test/unit/server/server-session-switch.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { RequestError } from "@agentclientprotocol/sdk";
import { waitForCondition } from "@nathapp/nax-test-kit/bun/timeout";
import { createServerSession, TURN_TIMEOUT_SECONDS } from "#src/server/server-session";
import type { OldText } from "#src/server/translate/diff";
import { fakeAgentSession, type Script, turnEnd } from "#test/helpers/fake-agent-session";
import { fakePort } from "#test/helpers/fake-client-port";
import { recordingLogger } from "#test/helpers/recording-logger";

const missing = async (): Promise<OldText> => ({ kind: "missing" });
const text = (t: string) => [{ type: "text" as const, text: t }];

const priced: Script = async function* () {
  yield { type: "usage", round: 1, inputTokens: 1, outputTokens: 1, costUsd: 0.5 };
  yield turnEnd("completed");
};

function setup(first: ReturnType<typeof fakeAgentSession>, onTurnEnd?: (m: string) => Promise<void>) {
  const port = fakePort();
  const { logger, lines } = recordingLogger();
  const session = createServerSession({
    session: first.session,
    port: port.port,
    cwd: "/w",
    readOldText: missing,
    logger,
    turnTimeoutSeconds: TURN_TIMEOUT_SECONDS,
    ...(onTurnEnd !== undefined ? { onTurnEnd } : {}),
  });
  return { port, lines, session };
}

describe("switchTo (spec §3.3)", () => {
  test("closes the current S3 session and runs later turns on the new one, with its context window", async () => {
    const a = fakeAgentSession("s1", [priced]);
    const b = fakeAgentSession("s1", [priced]);
    const s = setup(a);
    await s.session.prompt(text("one"));
    await s.session.switchTo(async () => ({ session: b.session, contextWindow: 1000 }), async () => ({ session: a.session }));
    expect(a.closed()).toBe(true);
    await s.session.prompt(text("two"));
    expect(b.messages).toEqual(["two"]);
    const usage = s.port.updates.filter((u) => u.sessionUpdate === "usage_update");
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ size: 1000, cost: { amount: 1 } });
  });

  test("a failed open restores the old settings' session and rethrows", async () => {
    const a = fakeAgentSession("s1", []);
    const restored = fakeAgentSession("s1", [priced]);
    const s = setup(a);
    const failure = await s.session
      .switchTo(async () => Promise.reject(new Error("bad model")), async () => ({ session: restored.session }))
      .catch((e: unknown) => e);
    expect(failure instanceof Error ? failure.message : "").toBe("bad model");
    await s.session.prompt(text("after"));
    expect(restored.messages).toEqual(["after"]);
  });

  test("a failed restore is logged and the open error is still returned", async () => {
    const a = fakeAgentSession("s1", []);
    const s = setup(a);
    const failure = await s.session
      .switchTo(async () => Promise.reject(new Error("bad model")), async () => Promise.reject(new Error("still bad")))
      .catch((e: unknown) => e);
    expect(failure instanceof Error ? failure.message : "").toBe("bad model");
    expect(s.lines.some((l) => l.level === "error" && l.data?.error === "still bad")).toBe(true);
  });

  test("rejected while a turn runs; a prompt during a switch is turn in progress", async () => {
    let releaseOpen: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseOpen = resolve;
    });
    const slow: Script = async function* ({ cancelled }) {
      yield { type: "turn_start" };
      await cancelled;
      yield turnEnd("cancelled");
    };
    const a = fakeAgentSession("s1", [slow]);
    const b = fakeAgentSession("s1", []);
    const s = setup(a);
    const running = s.session.prompt(text("long"));
    const busy = await s.session.switchTo(async () => ({ session: b.session }), async () => ({ session: a.session })).catch((e: unknown) => e);
    expect(busy instanceof RequestError ? busy.message : "").toContain("turn in progress");
    s.session.cancel();
    await running;
    const switching = s.session.switchTo(async () => {
      await gate;
      return { session: b.session };
    }, async () => ({ session: a.session }));
    await waitForCondition(() => a.closed());
    const during = await s.session.prompt(text("now")).catch((e: unknown) => e);
    expect(during instanceof RequestError ? during.message : "").toContain("turn in progress");
    releaseOpen();
    await switching;
  });
});

describe("onTurnEnd", () => {
  test("is called with the prompt text after each turn, even an errored one; its failure is only logged", async () => {
    const broken: Script = async function* () {
      yield turnEnd("errored", { error: { code: "X", message: "x" } });
    };
    const seen: string[] = [];
    const a = fakeAgentSession("s1", [priced, broken]);
    const s = setup(a, async (m) => {
      seen.push(m);
      if (seen.length === 2) throw new Error("disk full");
    });
    await s.session.prompt(text("first"));
    await s.session.prompt(text("second")).catch(() => undefined);
    expect(seen).toEqual(["first", "second"]);
    expect(s.lines.some((l) => l.level === "warn" && l.data?.error === "disk full")).toBe(true);
  });

  test("is not called for a prompt rejected before send", async () => {
    const seen: string[] = [];
    const s = setup(fakeAgentSession("s1", []), async (m) => {
      seen.push(m);
    });
    await s.session.prompt([]).catch(() => undefined);
    expect(seen).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails.** `timeout 60 bun test ./test/unit/server/server-session-switch.test.ts --timeout=60000`. Expected: FAIL (`switchTo` is not a function).

- [ ] **Step 3: Implement.** In `server-session.ts`:

1. In `ServerSessionDeps`, add:

```ts
  /** After every prompt that reached send() (S5-3: title and updatedAt). A rejection is logged, never thrown. */
  readonly onTurnEnd?: (message: string) => Promise<void>;
```

2. Export:

```ts
export interface SwitchTarget {
  readonly session: AgentSession;
  readonly contextWindow?: number;
}
```

and add to `ServerSession`:

```ts
  /** Close-and-reopen for a mode or config change (spec §3.3); `restore` reopens the old settings when `open` fails. */
  switchTo(open: () => Promise<SwitchTarget>, restore: () => Promise<SwitchTarget>): Promise<void>;
```

3. Inside `createServerSession`:
   - Add `let agent: AgentSession = deps.session;` and `let contextWindow = deps.contextWindow;`.
   - Replace every `deps.session` inside the function body with `agent`, including `createDelivery(deps)`: change `createDelivery` to take `(deps, agentOf: () => AgentSession)` and call `agentOf().cancel(...)`. Do the same for `deps.session.answer.bind(deps.session)` (use `agent.answer.bind(agent)`, read at turn start) and `send`, `cancel` and `close`.
   - The translator's context window reads the local `contextWindow`.
   - `id` stays `deps.session.id`.

4. In `prompt`, after `const message = flattenPrompt(blocks);` and the existing `running = true; cancelBeforeSend = false;`, change the `try/finally` to:

```ts
      let outcome: PromptOutcome | undefined;
      try {
        outcome = await runTurn(message);
      } finally {
        running = false;
        await reportTurnEnd(message);
      }
```

with, inside `createServerSession`:

```ts
  async function reportTurnEnd(message: string): Promise<void> {
    if (deps.onTurnEnd === undefined) return;
    try {
      await deps.onTurnEnd(message);
    } catch (error) {
      deps.logger.warn("session", "turn bookkeeping failed", { sessionId: deps.session.id, error: messageOf(error) });
    }
  }
```

5. Add `switchTo` to the returned object:

```ts
    async switchTo(open, restore) {
      if (running) throw turnInProgress();
      running = true;
      try {
        stopWaiting();
        await agent.close();
        try {
          const next = await open();
          agent = next.session;
          contextWindow = next.contextWindow;
        } catch (error) {
          try {
            const back = await restore();
            agent = back.session;
            contextWindow = back.contextWindow;
          } catch (restoreError) {
            deps.logger.error("session", "could not reopen the session after a failed switch", {
              sessionId: deps.session.id,
              error: messageOf(restoreError),
            });
          }
          throw error;
        }
      } finally {
        running = false;
      }
    },
```

If `check-complexity` flags `switchTo`, move the open-then-restore body into a module-level `async function adoptOrRestore(open, restore, logger, sessionId): Promise<SwitchTarget>` that returns the adopted target.

- [ ] **Step 4: Run tests and gates.** `timeout 120 bun test ./test/unit/server/ --timeout=60000 && bun x tsc --noEmit && bun run check:all`. Expected: PASS, including every S5-2 `server-session.test.ts` case.

- [ ] **Step 5: Commit**

```bash
bun run lint:fix
git add src/server/server-session.ts test/helpers/fake-agent-session.ts test/unit/server/server-session-switch.test.ts
git commit -m "feat(acp-server): ServerSession switches its S3 session and reports turn ends"
```

---

### Task 7: File-backed registry

**Files:**
- Rewrite: `packages/nax-agent-acp/src/server/registry.ts`
- Modify: `packages/nax-agent-acp/src/server/client-port.ts`. `ClientFeatures` gains `configOptions`.
- Modify: `packages/nax-agent-acp/test/helpers/fake-client-port.ts` (`ALL_FEATURES`), `test/unit/server/client-port.test.ts` (expected shapes)
- Rewrite: `packages/nax-agent-acp/test/unit/server/registry.test.ts`
- Create: `packages/nax-agent-acp/test/unit/server/registry-switch.test.ts` (mode and config changes, shutdown)

**Interfaces:**
- Consumes:
  - Task 3: `OpenSession`, `OpenedSession`.
  - Task 4: `SessionSettings`, `modeState`, `configOptions`, `applyModeChange`, `applyConfigChange`, `sameSettings`, `MODEL_OPTION`, `BASH_OPTION`.
  - Task 5: `SessionStorage`, `SessionMeta`.
  - Task 6: `createServerSession`, `ServerSession`, `SwitchTarget`.
  - `replayTranscript` (`#src/server/translate/replay`), `announce`.
- Produces (`#src/server/client-port`): `ClientFeatures.configOptions: boolean`, read from `clientCapabilities.session.configOptions`. `NO_CLIENT_FEATURES.configOptions = false`.
- Produces (`#src/server/registry`):
  - `NO_MODEL_MESSAGE`, `MCP_NOTICE` (unchanged), `INTERRUPTED_NOTICE = "The previous turn was interrupted"`, `SHUTDOWN_WAIT_MS = 5000`, `TITLE_MAX = 80`, `SHUTTING_DOWN = "server is shutting down"`.
  - `interface SessionState { readonly modes: SessionModeState; readonly configOptions: SessionConfigOption[] }`.
  - `interface OpenInput { readonly cwd: string; readonly mcpServers: readonly unknown[]; readonly port: (sessionId: string) => ClientPort }`.
  - `interface SessionRegistry`:
    - `create(input: OpenInput): Promise<{ readonly sessionId: string } & SessionState>`
    - `load(sessionId: string, input: OpenInput): Promise<SessionState>`
    - `resume(sessionId: string, input: OpenInput): Promise<SessionState>`
    - `list(query: { readonly cwd?: string | null; readonly cursor?: string | null }): Promise<ListSessionsResponse>`
    - `get(sessionId: string): ServerSession`
    - `find(sessionId: string): ServerSession | undefined`
    - `close(sessionId: string): Promise<void>`
    - `delete(sessionId: string): Promise<void>`
    - `setMode(sessionId: string, modeId: string): Promise<void>`
    - `setConfigOption(sessionId: string, configId: string, value: unknown): Promise<SessionConfigOption[]>`
    - `closeAll(): Promise<void>`
  - `interface RegistryDeps { readonly options: ServerOptions; readonly openSession: OpenSession; readonly storage: SessionStorage; readonly transcripts: TranscriptStore; readonly newId: () => string; readonly now: () => Date; readonly readOldText: ReadOldText; readonly logger: AgentLogger; readonly turnTimeoutSeconds: number; readonly shutdownWaitMs?: number }`.

- [ ] **Step 1: Client features.** Write the failing assertion first. In `client-port.test.ts`, extend the expected objects with `configOptions`: `false` in the empty case, and `true` for `{ session: { notices: {}, compaction: {}, configOptions: {} }, elicitation: { form: {} } }`. Then implement it in `clientFeatures` (`configOptions: present(caps?.session?.configOptions)`), in `NO_CLIENT_FEATURES` and in `ALL_FEATURES` (`configOptions: true`). Run `timeout 30 bun test ./test/unit/server/client-port.test.ts`: FAIL, then PASS after the change.

- [ ] **Step 2: Write the failing registry tests.**

`test/unit/server/registry.test.ts` (rewrite):

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RequestError } from "@agentclientprotocol/sdk";
import { createMemoryTranscriptStore, type TranscriptDoc, type TranscriptStore } from "@nathapp/nax-agent";
import { cleanupTempDir, makeTempDir } from "@nathapp/nax-test-kit/bun/temp";
import type { OpenSessionRequest } from "#src/server/open-session";
import type { ServerOptions } from "#src/server/options";
import { createSessionRegistry, INTERRUPTED_NOTICE, MCP_NOTICE, NO_MODEL_MESSAGE } from "#src/server/registry";
import { TURN_TIMEOUT_SECONDS } from "#src/server/server-session";
import { createSessionStorage } from "#src/server/storage";
import { type FakeAgentSession, fakeAgentSession, type Script, turnEnd } from "#test/helpers/fake-agent-session";
import { ALL_FEATURES, fakePort } from "#test/helpers/fake-client-port";
import { recordingLogger } from "#test/helpers/recording-logger";

const OPTIONS: ServerOptions = {
  configDir: "/cfg",
  sessionsDir: "/unused",
  defaultModel: "anthropic/claude-sonnet-5-5",
  defaultMode: "ask",
  bashApproval: "gated",
  tiers: [
    { tier: "fast", model: "anthropic/claude-haiku-4-5" },
    { tier: "balanced", model: "anthropic/claude-sonnet-5-5", contextWindow: 200_000 },
  ],
  catalogOverrides: [],
};

const said = (words: string): Script =>
  async function* () {
    yield { type: "text_delta", round: 1, text: words };
    yield turnEnd("completed");
  };

let dir: string;
beforeEach(() => {
  dir = makeTempDir("acp-registry-");
});
afterEach(() => cleanupTempDir(dir));

interface Setup {
  readonly opened: OpenSessionRequest[];
  readonly fakes: FakeAgentSession[];
}

function setup(
  options: ServerOptions = OPTIONS,
  extra: { transcripts?: TranscriptStore; isAlive?: (pid: number) => boolean; lastTurn?: FakeAgentSession["session"]["lastTurn"] } = {},
) {
  const record: Setup = { opened: [], fakes: [] };
  const transcripts = extra.transcripts ?? createMemoryTranscriptStore();
  const port = fakePort({ features: ALL_FEATURES });
  const { logger, lines } = recordingLogger();
  let next = 0;
  const storage = createSessionStorage({ dir, pid: 1000, now: () => new Date("2026-10-09T00:00:00.000Z"), logger, isAlive: extra.isAlive ?? (() => false) });
  const registry = createSessionRegistry({
    options,
    openSession: async (request) => {
      record.opened.push(request);
      const fake = fakeAgentSession(request.sessionId, [said("hi"), said("again")], {
        ...(extra.lastTurn !== undefined ? { lastTurn: extra.lastTurn } : {}),
      });
      record.fakes.push(fake);
      return { session: fake.session, doc: await transcripts.load(request.sessionId) };
    },
    storage,
    transcripts,
    newId: () => {
      next += 1;
      return `id-${next}`;
    },
    now: () => new Date("2026-10-09T01:00:00.000Z"),
    readOldText: async () => ({ kind: "missing" }),
    logger,
    turnTimeoutSeconds: TURN_TIMEOUT_SECONDS,
    shutdownWaitMs: 50,
  });
  const input = (cwd = "/w", mcpServers: readonly unknown[] = []) => ({ cwd, mcpServers, port: () => port.port });
  return { registry, input, port, lines, storage, transcripts, ...record };
}

async function failure(promise: Promise<unknown>): Promise<RequestError> {
  const caught = await promise.catch((e: unknown) => e);
  if (caught instanceof RequestError) return caught;
  throw new Error(`expected a RequestError, got ${String(caught)}`);
}

const metaOf = async (id: string) => JSON.parse(await readFile(join(dir, `${id}.session.json`), "utf8"));

describe("create (session/new)", () => {
  test("opens with the defaults, takes the lock, writes metadata, returns modes and config options", async () => {
    const s = setup();
    const created = await s.registry.create(s.input());
    expect(created.sessionId).toBe("id-1");
    expect(created.modes.currentModeId).toBe("ask");
    expect(created.configOptions.map((o) => o.id)).toEqual(["model", "bashApproval"]);
    expect(s.opened[0]).toEqual({ sessionId: "id-1", cwd: "/w", model: "anthropic/claude-sonnet-5-5", profile: "ask", bashApproval: "gated" });
    expect(await metaOf("id-1")).toMatchObject({ schemaVersion: 1, cwd: "/w", mode: "ask", title: null, updatedAt: null });
    expect(JSON.parse(await readFile(join(dir, "id-1.lock"), "utf8"))).toMatchObject({ pid: 1000 });
  });

  test("a relative cwd and no model are invalid_params; nothing is written", async () => {
    const s = setup();
    expect((await failure(s.registry.create(s.input("w")))).code).toBe(-32602);
    const { defaultModel: _unused, ...noModel } = OPTIONS;
    const n = setup(noModel);
    expect((await failure(n.registry.create(n.input()))).message).toContain(NO_MODEL_MESSAGE);
    expect(await s.storage.hasMeta("id-1")).toBe(false);
  });

  test("the first prompt sets the title (80 chars, one line) and every prompt sets updatedAt", async () => {
    const s = setup();
    const { sessionId } = await s.registry.create(s.input());
    const long = `fix the\nparser ${"x".repeat(120)}`;
    await s.registry.get(sessionId).prompt([{ type: "text", text: long }]);
    const meta = await metaOf(sessionId);
    expect(meta.title).toBe(`fix the parser ${"x".repeat(65)}`);
    expect(meta.updatedAt).toBe("2026-10-09T01:00:00.000Z");
    await s.registry.get(sessionId).prompt([{ type: "text", text: "second" }]);
    expect((await metaOf(sessionId)).title).toBe(meta.title);
  });

  test("non-empty mcpServers queue the MCP notice for the first turn", async () => {
    const s = setup();
    const { sessionId } = await s.registry.create(s.input("/w", [{ name: "fs" }]));
    await s.registry.get(sessionId).prompt([{ type: "text", text: "go" }]);
    expect(JSON.stringify(s.port.updates[0])).toContain(MCP_NOTICE);
  });

  test("a failed open releases the lock and writes no metadata", async () => {
    const s = setup();
    const broken = createSessionRegistry({
      options: OPTIONS,
      openSession: async () => Promise.reject(new Error("sandbox unavailable")),
      storage: s.storage,
      transcripts: s.transcripts,
      newId: () => "x",
      now: () => new Date(),
      readOldText: async () => ({ kind: "missing" }),
      logger: recordingLogger().logger,
      turnTimeoutSeconds: TURN_TIMEOUT_SECONDS,
    });
    await expect(broken.create(s.input())).rejects.toThrow("sandbox unavailable");
    expect(await s.storage.hasMeta("x")).toBe(false);
    await (await s.storage.acquireLock("x"))();
  });
});

describe("load and resume (spec §5.3, §5.4)", () => {
  async function stored(s: ReturnType<typeof setup>, doc?: TranscriptDoc): Promise<string> {
    const { sessionId } = await s.registry.create(s.input());
    await s.registry.setMode(sessionId, "full");
    if (doc !== undefined) await s.transcripts.save(sessionId, doc);
    await s.registry.close(sessionId);
    return sessionId;
  }

  test("load restores the stored settings and replays the transcript before responding", async () => {
    const s = setup();
    const id = await stored(s, {
      savedAt: "x",
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi there" },
      ],
    });
    s.port.updates.length = 0;
    const state = await s.registry.load(id, s.input("/elsewhere"));
    expect(state.modes.currentModeId).toBe("full");
    expect(s.opened.at(-1)).toMatchObject({ sessionId: id, cwd: "/w", profile: "full" });
    expect(s.port.updates.map((u) => u.sessionUpdate)).toEqual(["user_message_chunk", "agent_message_chunk"]);
  });

  test("an interrupted last turn ends the replay with a warning", async () => {
    const s = setup(OPTIONS, { lastTurn: { turnId: "t9", status: "interrupted" } });
    const id = await stored(s, { savedAt: "x", messages: [{ role: "user", content: "hello" }] });
    s.port.updates.length = 0;
    await s.registry.load(id, s.input());
    expect(s.port.updates.at(-1)).toMatchObject({ sessionUpdate: "notice", severity: "warning", title: INTERRUPTED_NOTICE });
  });

  test("resume reopens without replay; a never-prompted session reopens too", async () => {
    const s = setup();
    const id = await stored(s);
    s.port.updates.length = 0;
    const state = await s.registry.resume(id, s.input());
    expect(state.modes.currentModeId).toBe("full");
    expect(s.port.updates).toEqual([]);
  });

  test("an unknown id is resource_not_found; unreadable metadata is internal and the file is kept", async () => {
    const s = setup();
    expect((await failure(s.registry.load("nope", s.input()))).code).toBe(-32002);
    await writeFile(join(dir, "bad.session.json"), "{");
    await expect(s.registry.resume("bad", s.input())).rejects.toMatchObject({ code: "SESSION_META_UNREADABLE" });
    expect(await readFile(join(dir, "bad.session.json"), "utf8")).toBe("{");
  });

  test("a session held by another live process is refused with the pid", async () => {
    const s = setup(OPTIONS, { isAlive: (pid) => pid === 4242 });
    const id = await stored(s);
    await writeFile(join(dir, `${id}.lock`), JSON.stringify({ pid: 4242, startedAt: "x" }));
    expect((await failure(s.registry.load(id, s.input()))).message).toContain("session in use by pid 4242");
  });

  test("loading an already-open session replays from the store and keeps the open session", async () => {
    const s = setup();
    const { sessionId } = await s.registry.create(s.input());
    await s.transcripts.save(sessionId, { savedAt: "x", messages: [{ role: "user", content: "hello" }] });
    const before = s.registry.get(sessionId);
    s.port.updates.length = 0;
    await s.registry.load(sessionId, s.input());
    expect(s.registry.get(sessionId)).toBe(before);
    expect(s.port.updates.map((u) => u.sessionUpdate)).toEqual(["user_message_chunk"]);
  });
});

describe("list, close, delete", () => {
  test("list returns stored sessions for the cwd", async () => {
    const s = setup();
    await s.registry.create(s.input());
    await s.registry.create(s.input("/other"));
    expect((await s.registry.list({ cwd: "/w" })).sessions.map((i) => i.sessionId)).toEqual(["id-1"]);
  });

  test("close cancels, closes, releases the lock and keeps the files; unknown is resource_not_found", async () => {
    const s = setup();
    const { sessionId } = await s.registry.create(s.input());
    await s.registry.close(sessionId);
    expect(s.fakes[0]?.closed()).toBe(true);
    expect(s.registry.find(sessionId)).toBeUndefined();
    expect(await s.storage.hasMeta(sessionId)).toBe(true);
    await (await s.storage.acquireLock(sessionId))();
    expect((await failure(s.registry.close(sessionId))).code).toBe(-32002);
  });

  test("delete closes an open session and removes metadata, lock and transcript", async () => {
    const s = setup();
    const { sessionId } = await s.registry.create(s.input());
    await s.transcripts.save(sessionId, { savedAt: "x", messages: [] });
    await s.registry.delete(sessionId);
    expect(await s.storage.hasMeta(sessionId)).toBe(false);
    expect(await s.transcripts.load(sessionId)).toBeNull();
    expect((await failure(s.registry.delete(sessionId))).code).toBe(-32002);
  });
});
```

`test/unit/server/registry-switch.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { RequestError } from "@agentclientprotocol/sdk";
import { type AgentSession, createMemoryTranscriptStore } from "@nathapp/nax-agent";
import { cleanupTempDir, makeTempDir } from "@nathapp/nax-test-kit/bun/temp";
import type { OpenSessionRequest } from "#src/server/open-session";
import type { ServerOptions } from "#src/server/options";
import { createSessionRegistry, SHUTTING_DOWN } from "#src/server/registry";
import { TURN_TIMEOUT_SECONDS } from "#src/server/server-session";
import { createSessionStorage } from "#src/server/storage";
import { fakeAgentSession } from "#test/helpers/fake-agent-session";
import { ALL_FEATURES, fakePort, NO_CONFIG_UPDATES } from "#test/helpers/fake-client-port";
import { recordingLogger } from "#test/helpers/recording-logger";

const OPTIONS: ServerOptions = {
  configDir: "/cfg",
  sessionsDir: "/unused",
  defaultModel: "anthropic/claude-sonnet-5-5",
  defaultMode: "full",
  bashApproval: "escalate",
  tiers: [
    { tier: "fast", model: "anthropic/claude-haiku-4-5" },
    { tier: "balanced", model: "anthropic/claude-sonnet-5-5" },
  ],
  catalogOverrides: [],
};

let dir: string;
beforeEach(() => {
  dir = makeTempDir("acp-registry-switch-");
});
afterEach(() => cleanupTempDir(dir));

function setup(open?: (request: OpenSessionRequest) => Promise<AgentSession>, features = ALL_FEATURES) {
  const opened: OpenSessionRequest[] = [];
  const port = fakePort({ features });
  const { logger, lines } = recordingLogger();
  const storage = createSessionStorage({ dir, pid: 1000, now: () => new Date(), logger });
  const registry = createSessionRegistry({
    options: OPTIONS,
    openSession: async (request) => {
      opened.push(request);
      const session = open !== undefined ? await open(request) : fakeAgentSession(request.sessionId, []).session;
      return { session, doc: null };
    },
    storage,
    transcripts: createMemoryTranscriptStore(),
    newId: () => "s1",
    now: () => new Date("2026-10-09T01:00:00.000Z"),
    readOldText: async () => ({ kind: "missing" }),
    logger,
    turnTimeoutSeconds: TURN_TIMEOUT_SECONDS,
    shutdownWaitMs: 50,
  });
  return { registry, port, opened, lines, storage, input: { cwd: "/w", mcpServers: [], port: () => port.port } };
}

const metaOf = async (id: string) => JSON.parse(await readFile(join(dir, `${id}.session.json`), "utf8"));

describe("set_mode (spec §3.3, §5.3)", () => {
  test("reopens with the new mode, writes metadata, sends current_mode_update", async () => {
    const s = setup();
    await s.registry.create(s.input);
    await s.registry.setMode("s1", "read");
    expect(s.opened.at(-1)).toMatchObject({ profile: "read" });
    expect((await metaOf("s1")).mode).toBe("read");
    expect(s.port.updates).toContainEqual({ sessionUpdate: "current_mode_update", currentModeId: "read" });
  });

  test("switching to ask coerces bash approval to gated and reports it (M-23)", async () => {
    const s = setup();
    await s.registry.create(s.input);
    await s.registry.setMode("s1", "ask");
    expect(s.opened.at(-1)).toMatchObject({ profile: "ask", bashApproval: "gated" });
    expect(s.port.updates.some((u) => u.sessionUpdate === "config_option_update")).toBe(true);
  });

  test("a failed reopen keeps the old settings and metadata and returns the error", async () => {
    let calls = 0;
    const s = setup(async (request) => {
      calls += 1;
      if (calls === 2) throw new Error("sandbox unavailable");
      return fakeAgentSession(request.sessionId, []).session;
    });
    await s.registry.create(s.input);
    await expect(s.registry.setMode("s1", "read")).rejects.toThrow("sandbox unavailable");
    expect((await metaOf("s1")).mode).toBe("full");
    expect(s.opened.at(-1)).toMatchObject({ profile: "full" });
  });

  test("an unknown session is resource_not_found; an unknown mode is invalid_params", async () => {
    const s = setup();
    expect(await s.registry.setMode("nope", "read").catch((e: unknown) => (e instanceof RequestError ? e.code : 0))).toBe(-32002);
    await s.registry.create(s.input);
    expect(await s.registry.setMode("s1", "yolo").catch((e: unknown) => (e instanceof RequestError ? e.code : 0))).toBe(-32602);
  });
});

describe("set_config_option", () => {
  test("a model change reopens with the new model and returns the options", async () => {
    const s = setup();
    await s.registry.create(s.input);
    const options = await s.registry.setConfigOption("s1", "model", "anthropic/claude-haiku-4-5");
    expect(s.opened.at(-1)).toMatchObject({ model: "anthropic/claude-haiku-4-5" });
    expect(options[0]).toMatchObject({ currentValue: "anthropic/claude-haiku-4-5" });
    expect((await metaOf("s1")).model).toBe("anthropic/claude-haiku-4-5");
  });

  test("no config_option_update for a client that did not declare configOptions (M-25)", async () => {
    const s = setup(undefined, NO_CONFIG_UPDATES);
    await s.registry.create(s.input);
    await s.registry.setConfigOption("s1", "bashApproval", "gated");
    expect(s.port.updates.some((u) => u.sessionUpdate === "config_option_update")).toBe(false);
  });

  test("an unchanged value does not reopen", async () => {
    const s = setup();
    await s.registry.create(s.input);
    await s.registry.setConfigOption("s1", "bashApproval", "escalate");
    expect(s.opened).toHaveLength(1);
  });
});

describe("closeAll (spec §5.5)", () => {
  test("releases every lock within the cap even when a close hangs, then refuses new opens (M-26)", async () => {
    const hung = fakeAgentSession("s1", [], { closeHangs: true });
    const s = setup(async () => hung.session);
    await s.registry.create(s.input);
    await s.registry.closeAll();
    await (await s.storage.acquireLock("s1"))();
    expect(s.lines.some((l) => l.level === "warn" && l.message.includes("did not close"))).toBe(true);
    const refused = await s.registry.create(s.input).catch((e: unknown) => e);
    expect(refused instanceof RequestError ? refused.message : "").toContain(SHUTTING_DOWN);
  });
});
```

In `test/helpers/fake-agent-session.ts`, add `readonly closeHangs?: boolean;` to `FakeAgentSessionOptions`. In `close()`, after `cancelTurn();`, add `if (options.closeHangs === true) await new Promise<void>(() => {});`. This is a deliberately never-settling close for the shutdown cap test.

In `test/helpers/fake-client-port.ts`, add:

```ts
export const NO_CONFIG_UPDATES: ClientFeatures = { ...ALL_FEATURES, configOptions: false };
```

- [ ] **Step 3: Run to verify they fail.** `timeout 60 bun test ./test/unit/server/registry.test.ts ./test/unit/server/registry-switch.test.ts --timeout=60000`. Expected: FAIL (`load`, `storage` dep and similar are missing).

- [ ] **Step 4: Implement `src/server/registry.ts`** (full rewrite)

```ts
/**
 * ACP session id -> open session, backed by files (S5 spec §5.1, §5.3). Opening
 * (new, load, resume) takes the session's lock, then reopens the S3 session;
 * close releases the lock and keeps the files; delete removes them. Mode and
 * config changes are a close-and-reopen (§3.3) that rolls back on failure and
 * writes metadata only on success. closeAll is the shutdown (§5.5).
 */
import { isAbsolute } from "node:path";
import {
  type ListSessionsResponse,
  RequestError,
  type SessionConfigOption,
  type SessionModeState,
} from "@agentclientprotocol/sdk";
import type { AgentLogger, TranscriptStore } from "@nathapp/nax-agent";
import { stripControl, stripInvisible } from "#src/client/text";
import type { ClientPort } from "#src/server/client-port";
import { invalidParams, messageOf, unknownSession } from "#src/server/errors";
import type { OpenSession } from "#src/server/open-session";
import type { ServerOptions } from "#src/server/options";
import { createServerSession, type ServerSession, type SwitchTarget } from "#src/server/server-session";
import {
  applyConfigChange,
  applyModeChange,
  configOptions,
  modeState,
  type SessionSettings,
  sameSettings,
} from "#src/server/session-config";
import type { SessionMeta, SessionStorage } from "#src/server/storage";
import type { ReadOldText } from "#src/server/translate/diff";
import { announce } from "#src/server/translate/notice";
import { replayTranscript } from "#src/server/translate/replay";

export const NO_MODEL_MESSAGE = "no model configured: set models.native.balanced or --model";
export const MCP_NOTICE = "MCP servers are not supported yet; ignored";
export const INTERRUPTED_NOTICE = "The previous turn was interrupted";
export const SHUTTING_DOWN = "server is shutting down";
export const SHUTDOWN_WAIT_MS = 5000;
export const TITLE_MAX = 80;

export interface SessionState {
  readonly modes: SessionModeState;
  readonly configOptions: SessionConfigOption[];
}

export interface OpenInput {
  readonly cwd: string;
  readonly mcpServers: readonly unknown[];
  readonly port: (sessionId: string) => ClientPort;
}

export interface SessionRegistry {
  create(input: OpenInput): Promise<{ readonly sessionId: string } & SessionState>;
  load(sessionId: string, input: OpenInput): Promise<SessionState>;
  resume(sessionId: string, input: OpenInput): Promise<SessionState>;
  list(query: { readonly cwd?: string | null; readonly cursor?: string | null }): Promise<ListSessionsResponse>;
  get(sessionId: string): ServerSession;
  find(sessionId: string): ServerSession | undefined;
  close(sessionId: string): Promise<void>;
  delete(sessionId: string): Promise<void>;
  setMode(sessionId: string, modeId: string): Promise<void>;
  setConfigOption(sessionId: string, configId: string, value: unknown): Promise<SessionConfigOption[]>;
  closeAll(): Promise<void>;
}

export interface RegistryDeps {
  readonly options: ServerOptions;
  readonly openSession: OpenSession;
  readonly storage: SessionStorage;
  readonly transcripts: TranscriptStore;
  readonly newId: () => string;
  readonly now: () => Date;
  readonly readOldText: ReadOldText;
  readonly logger: AgentLogger;
  readonly turnTimeoutSeconds: number;
  readonly shutdownWaitMs?: number;
}

interface Entry {
  readonly server: ServerSession;
  readonly port: ClientPort;
  readonly meta: SessionMeta;
  readonly release: () => Promise<void>;
}

const settingsOf = (meta: SessionMeta): SessionSettings => ({
  mode: meta.mode,
  model: meta.model,
  bashApproval: meta.bashApproval,
});

/** One line, no control or invisible characters, at most TITLE_MAX code points. */
export function titleOf(prompt: string): string {
  return Array.from(stripInvisible(stripControl(prompt)).replace(/\s+/g, " ").trim()).slice(0, TITLE_MAX).join("");
}

function waitAtMost(ms: number): { readonly done: Promise<"timeout">; cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const done = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms);
  });
  return { done, cancel: () => clearTimeout(timer) };
}

export function createSessionRegistry(deps: RegistryDeps): SessionRegistry {
  const entries = new Map<string, Entry>();
  const { options } = deps;
  let closing = false;

  const contextWindowFor = (model: string): number | undefined =>
    options.tiers.find((tier) => tier.model === model)?.contextWindow;

  const stateOf = (settings: SessionSettings): SessionState => ({
    modes: modeState(settings),
    configOptions: configOptions(settings, options.tiers),
  });

  function entryOf(sessionId: string): Entry {
    const entry = entries.get(sessionId);
    if (entry === undefined) throw unknownSession(sessionId);
    return entry;
  }

  async function recordTurn(sessionId: string, prompt: string): Promise<void> {
    const entry = entries.get(sessionId);
    if (entry === undefined) return;
    const meta: SessionMeta = {
      ...entry.meta,
      title: entry.meta.title ?? titleOf(prompt),
      updatedAt: deps.now().toISOString(),
    };
    entries.set(sessionId, { ...entry, meta });
    await deps.storage.writeMeta(meta);
  }

  async function target(sessionId: string, cwd: string, settings: SessionSettings): Promise<SwitchTarget> {
    const opened = await deps.openSession({
      sessionId,
      cwd,
      model: settings.model,
      profile: settings.mode,
      bashApproval: settings.bashApproval,
    });
    const contextWindow = contextWindowFor(settings.model);
    return { session: opened.session, ...(contextWindow !== undefined ? { contextWindow } : {}) };
  }

  /** Takes the lock, opens the S3 session, registers it. The lock is released if anything fails. */
  async function openEntry(meta: SessionMeta, port: ClientPort) {
    if (closing) throw RequestError.internalError(undefined, SHUTTING_DOWN);
    const release = await deps.storage.acquireLock(meta.sessionId);
    try {
      const settings = settingsOf(meta);
      const opened = await deps.openSession({
        sessionId: meta.sessionId,
        cwd: meta.cwd,
        model: settings.model,
        profile: settings.mode,
        bashApproval: settings.bashApproval,
      });
      const contextWindow = contextWindowFor(settings.model);
      const server = createServerSession({
        session: opened.session,
        port,
        cwd: meta.cwd,
        ...(contextWindow !== undefined ? { contextWindow } : {}),
        readOldText: deps.readOldText,
        logger: deps.logger,
        turnTimeoutSeconds: deps.turnTimeoutSeconds,
        onTurnEnd: (prompt) => recordTurn(meta.sessionId, prompt),
      });
      entries.set(meta.sessionId, { server, port, meta, release });
      return { server, opened };
    } catch (error) {
      await release();
      throw error;
    }
  }

  async function closeEntry(sessionId: string, entry: Entry): Promise<void> {
    entries.delete(sessionId);
    try {
      await entry.server.close();
    } finally {
      await entry.release();
    }
  }

  async function replayTo(port: ClientPort, messages: Parameters<typeof replayTranscript>[0], cwd: string) {
    for (const update of replayTranscript(messages, cwd)) await port.update(update);
  }

  async function reopen(sessionId: string, input: OpenInput, replay: boolean): Promise<SessionState> {
    const open = entries.get(sessionId);
    if (open !== undefined) {
      if (replay) await replayTo(open.port, (await deps.transcripts.load(sessionId))?.messages ?? [], open.meta.cwd);
      return stateOf(settingsOf(open.meta));
    }
    const meta = await deps.storage.readMeta(sessionId);
    if (meta === null) throw unknownSession(sessionId);
    if (input.cwd !== meta.cwd) {
      deps.logger.debug("session", "reopening in the stored cwd", { sessionId, requested: input.cwd, stored: meta.cwd });
    }
    const port = input.port(sessionId);
    const { server, opened } = await openEntry(meta, port);
    if (replay) {
      await replayTo(port, opened.doc?.messages ?? [], meta.cwd);
      if (opened.session.lastTurn?.status === "interrupted") {
        await port.update(announce(port.features.updates.notices, "warning", INTERRUPTED_NOTICE));
      }
    }
    if (input.mcpServers.length > 0) server.queueNotice(announce(port.features.updates.notices, "warning", MCP_NOTICE));
    return stateOf(settingsOf(meta));
  }

  /** Close-and-reopen with `next` (§3.3). Metadata is written only after the reopen succeeds. */
  async function switchTo(sessionId: string, entry: Entry, next: SessionSettings): Promise<void> {
    const from = settingsOf(entry.meta);
    await entry.server.switchTo(
      () => target(sessionId, entry.meta.cwd, next),
      () => target(sessionId, entry.meta.cwd, from),
    );
    const meta: SessionMeta = { ...entry.meta, mode: next.mode, model: next.model, bashApproval: next.bashApproval };
    entries.set(sessionId, { ...entry, meta });
    await deps.storage.writeMeta(meta);
  }

  async function announceConfig(entry: Entry, settings: SessionSettings): Promise<void> {
    if (!entry.port.features.configOptions) return;
    await entry.port.update({ sessionUpdate: "config_option_update", configOptions: configOptions(settings, options.tiers) });
  }

  return {
    async create(input) {
      if (!isAbsolute(input.cwd)) throw invalidParams(`cwd must be an absolute path: ${input.cwd}`);
      const model = options.defaultModel;
      if (model === undefined) throw invalidParams(NO_MODEL_MESSAGE);
      const sessionId = deps.newId();
      const meta: SessionMeta = {
        schemaVersion: 1,
        sessionId,
        cwd: input.cwd,
        mode: options.defaultMode,
        model,
        bashApproval: options.bashApproval,
        title: null,
        createdAt: deps.now().toISOString(),
        updatedAt: null,
      };
      const port = input.port(sessionId);
      const { server } = await openEntry(meta, port);
      try {
        await deps.storage.writeMeta(meta);
      } catch (error) {
        const entry = entries.get(sessionId);
        if (entry !== undefined) await closeEntry(sessionId, entry);
        throw error;
      }
      if (input.mcpServers.length > 0) server.queueNotice(announce(port.features.updates.notices, "warning", MCP_NOTICE));
      deps.logger.info("session", "session opened", { sessionId, cwd: input.cwd, model, mode: meta.mode });
      return { sessionId, ...stateOf(settingsOf(meta)) };
    },
    load: (sessionId, input) => reopen(sessionId, input, true),
    resume: (sessionId, input) => reopen(sessionId, input, false),
    list: (query) => deps.storage.list(query),
    get: (sessionId) => entryOf(sessionId).server,
    find: (sessionId) => entries.get(sessionId)?.server,
    async close(sessionId) {
      await closeEntry(sessionId, entryOf(sessionId));
    },
    async delete(sessionId) {
      const entry = entries.get(sessionId);
      if (entry !== undefined) await closeEntry(sessionId, entry);
      else if (!(await deps.storage.hasMeta(sessionId))) throw unknownSession(sessionId);
      const release = await deps.storage.acquireLock(sessionId);
      try {
        await deps.transcripts.delete(sessionId);
        await deps.storage.removeMeta(sessionId);
      } finally {
        await release();
      }
    },
    async setMode(sessionId, modeId) {
      const entry = entryOf(sessionId);
      const from = settingsOf(entry.meta);
      const next = applyModeChange(from, modeId);
      if (!sameSettings(from, next)) await switchTo(sessionId, entry, next);
      await entry.port.update({ sessionUpdate: "current_mode_update", currentModeId: next.mode });
      if (next.bashApproval !== from.bashApproval) await announceConfig(entry, next);
    },
    async setConfigOption(sessionId, configId, value) {
      const entry = entryOf(sessionId);
      const from = settingsOf(entry.meta);
      const next = applyConfigChange(from, configId, value, options.tiers);
      if (!sameSettings(from, next)) {
        await switchTo(sessionId, entry, next);
        await announceConfig(entry, next);
      }
      return configOptions(next, options.tiers);
    },
    async closeAll() {
      closing = true;
      const open = [...entries.entries()];
      entries.clear();
      const wait = deps.shutdownWaitMs ?? SHUTDOWN_WAIT_MS;
      await Promise.all(
        open.map(async ([sessionId, entry]) => {
          entry.server.cancel();
          const limit = waitAtMost(wait);
          const closed = entry.server.close().then(
            () => "closed" as const,
            (error: unknown) => {
              deps.logger.warn("session", "session close failed", { sessionId, error: messageOf(error) });
              return "closed" as const;
            },
          );
          const outcome = await Promise.race([closed, limit.done]);
          limit.cancel();
          if (outcome === "timeout") deps.logger.warn("session", "session did not close in time", { sessionId, waitMs: wait });
          await entry.release();
        }),
      );
    },
  };
}
```

Notes for the implementer:
- `setMode` reads `entry` before the switch. `entry.port` is unchanged by the switch, so the stale reference is safe for `port`. Do not read `entry.meta` after `switchTo`.
- If the file passes 600 lines or `check-complexity` flags a function, move `reopen`/`replayTo` into `src/server/registry-open.ts` as functions taking the registry's internals as parameters. Keep `registry.ts` as the public surface.
- `stripControl`/`stripInvisible` come from `#src/client/text`, as `permissions.ts` already imports them.

- [ ] **Step 5: Run tests and gates.** `timeout 120 bun test ./test/unit/server/ --timeout=60000 && bun x tsc --noEmit && bun run check:all`. Expected: PASS. `connection.ts` and `main.ts` still build against the old registry shape. They are updated in Task 8, so if typecheck fails only in those two files, make the minimal compile fix there in this task: construct storage and transcripts in `main.ts` as Task 8 Step 3 shows. In the same task, update the registry construction in `test/unit/server/connection.test.ts` and `test/unit/server/connection-sessions.test.ts` to the new `RegistryDeps`:
- `storage`: `createSessionStorage` over a `makeTempDir` directory, with `isAlive: () => false`;
- `transcripts`: `createMemoryTranscriptStore()`;
- `now`: `() => new Date()`;
- `shutdownWaitMs`: `50`.

- [ ] **Step 6: Commit**

```bash
bun run lint:fix
git add src/server test/helpers test/unit/server
git commit -m "feat(acp-server): S5-3 file-backed registry: load, resume, list, close, delete, switch, shutdown"
```

---

### Task 8: Serve the methods, advertise them, wire main, amend the spec

**Files:**
- Modify: `packages/nax-agent-acp/src/server/connection.ts`, `capabilities.ts`, `main.ts`
- Modify: `test/unit/server/connection.test.ts` (capability pin), `test/unit/server/stdout-purity.test.ts`
- Create: `test/unit/server/connection-persistence.test.ts`
- Modify: `docs/superpowers/specs/2026-10-08-s5-acp-server-design.md` (§3.3, §5.2)
- Modify: `.nax/mono/packages/nax-agent-acp/context.md`, then run `nax generate` for the root and all packages

**Interfaces:**
- Consumes: Task 7's `SessionRegistry`.
- Produces:
  - `initializeResponse(version)` advertises `loadSession: true` and `sessionCapabilities: { list: {}, resume: {}, close: {}, delete: {} }`.
  - `buildAgentApp` serves `session/load`, `session/resume`, `session/list`, `session/close`, `session/delete`, `session/set_mode` and `session/set_config_option`.
  - `session/new` returns `{ sessionId, modes, configOptions }`.

- [ ] **Step 1: Write the failing tests.**

In `connection.test.ts`, update the capability pin to

```ts
    expect(initializeResponse("1.2.3")).toEqual({
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: false, audio: false, embeddedContext: true },
        sessionCapabilities: { list: {}, resume: {}, close: {}, delete: {} },
      },
      authMethods: [],
      agentInfo: { name: "nax-agent", title: "nax-agent", version: "1.2.3" },
    });
```

In `connection-sessions.test.ts`, the S5-2 test "the session/new response carries no modes or config options yet (M-10)" no longer holds. Rename it to "the session/new response carries modes and config options (S5-3)" and assert `expect(response).toMatchObject({ sessionId: "s1", modes: { currentModeId: "ask" } })` and `expect(response.configOptions?.map((o) => o.id)).toEqual(["model", "bashApproval"])`.

In `connection.test.ts`, change the "not served yet" request to `agent.request("session/fork", { sessionId: "s", cwd: "/tmp", mcpServers: [] })`, which is still `-32601`. Update its `appDeps()` to the Task 7 `RegistryDeps`: `storage: createSessionStorage({ dir: "/nonexistent-acp-test", pid: 1, now: () => new Date(), logger })` and `transcripts: createMemoryTranscriptStore()`.

`test/unit/server/connection-persistence.test.ts` drives the real SDK client:

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  type AgentApp,
  type ClientCapabilities,
  type ClientContext,
  client,
  PROTOCOL_VERSION,
  type PromptRequest,
  RequestError,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import { createMemoryTranscriptStore, type TranscriptStore } from "@nathapp/nax-agent";
import { cleanupTempDir, makeTempDir } from "@nathapp/nax-test-kit/bun/temp";
import { waitForCondition } from "@nathapp/nax-test-kit/bun/timeout";
import { buildAgentApp } from "#src/server/connection";
import type { ServerOptions } from "#src/server/options";
import { createSessionRegistry } from "#src/server/registry";
import { TURN_TIMEOUT_SECONDS } from "#src/server/server-session";
import { createSessionStorage } from "#src/server/storage";
import { fakeAgentSession, type Script, turnEnd } from "#test/helpers/fake-agent-session";
import { recordingLogger } from "#test/helpers/recording-logger";

const OPTIONS: ServerOptions = {
  configDir: "/cfg",
  sessionsDir: "/unused",
  defaultModel: "anthropic/claude-sonnet-5-5",
  defaultMode: "ask",
  bashApproval: "gated",
  tiers: [
    { tier: "fast", model: "anthropic/claude-haiku-4-5" },
    { tier: "balanced", model: "anthropic/claude-sonnet-5-5" },
  ],
  catalogOverrides: [],
};

let dir: string;
beforeEach(() => {
  dir = makeTempDir("acp-connection-persistence-");
});
afterEach(() => cleanupTempDir(dir));

function app(scriptsFor: (transcripts: TranscriptStore, sessionId: string) => readonly Script[]): AgentApp {
  const transcripts = createMemoryTranscriptStore();
  const { logger } = recordingLogger();
  const registry = createSessionRegistry({
    options: OPTIONS,
    openSession: async (request) => ({
      session: fakeAgentSession(request.sessionId, scriptsFor(transcripts, request.sessionId)).session,
      doc: await transcripts.load(request.sessionId),
    }),
    storage: createSessionStorage({ dir, pid: 1000, now: () => new Date(), logger, isAlive: () => false }),
    transcripts,
    newId: () => "s1",
    now: () => new Date("2026-10-09T01:00:00.000Z"),
    readOldText: async () => ({ kind: "missing" }),
    logger,
    turnTimeoutSeconds: TURN_TIMEOUT_SECONDS,
    shutdownWaitMs: 50,
  });
  return buildAgentApp({ version: "9.9.9", registry, logger });
}

/** A turn that leaves a stored transcript behind, as the real loop would. */
const remembers =
  (transcripts: TranscriptStore, sessionId: string): Script =>
  async function* () {
    await transcripts.save(sessionId, {
      savedAt: "x",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ],
    });
    yield { type: "text_delta", round: 1, text: "hello" };
    yield turnEnd("completed");
  };

const waitForCancel: Script = async function* ({ cancelled }) {
  yield { type: "text_delta", round: 1, text: "working" };
  await cancelled;
  yield turnEnd("cancelled");
};

const prompt = (sessionId: string, text: string): PromptRequest => ({ sessionId, prompt: [{ type: "text", text }] });

async function connect<T>(
  agentApp: AgentApp,
  work: (agent: ClientContext, updates: SessionNotification[]) => Promise<T>,
  capabilities: ClientCapabilities = {},
): Promise<T> {
  const updates: SessionNotification[] = [];
  return client({ name: "test" })
    .onNotification("session/update", (ctx) => {
      updates.push(ctx.params);
    })
    .onRequest("session/request_permission", async () => ({ outcome: { outcome: "selected", optionId: "allow_once" } }))
    .connectWith(agentApp, async (agent) => {
      await agent.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: capabilities });
      return work(agent, updates);
    });
}

const codeOf = (error: unknown): number => (error instanceof RequestError ? error.code : 0);

describe("persistence methods over a real SDK connection (S5-3)", () => {
  test("new -> prompt -> close -> list -> load replays the stored transcript", async () => {
    const result = await connect(
      app((transcripts, id) => [remembers(transcripts, id)]),
      async (agent, updates) => {
        const created = await agent.request("session/new", { cwd: "/w", mcpServers: [] });
        await agent.request("session/prompt", prompt(created.sessionId, "hi"));
        await agent.request("session/close", { sessionId: created.sessionId });
        const listed = await agent.request("session/list", { cwd: "/w" });
        updates.length = 0;
        const loaded = await agent.request("session/load", { sessionId: created.sessionId, cwd: "/w", mcpServers: [] });
        return { created, listed, loaded, kinds: updates.map((n) => n.update.sessionUpdate) };
      },
    );
    expect(result.created).toMatchObject({ sessionId: "s1", modes: { currentModeId: "ask" } });
    expect(result.listed.sessions).toEqual([{ sessionId: "s1", cwd: "/w", title: "hi", updatedAt: "2026-10-09T01:00:00.000Z" }]);
    expect(result.loaded).toMatchObject({ modes: { currentModeId: "ask" } });
    expect(result.kinds).toEqual(["user_message_chunk", "agent_message_chunk"]);
  });

  test("set_mode and set_config_option answer and send their updates", async () => {
    const result = await connect(
      app(() => []),
      async (agent, updates) => {
        const { sessionId } = await agent.request("session/new", { cwd: "/w", mcpServers: [] });
        await agent.request("session/set_mode", { sessionId, modeId: "read" });
        const changed = await agent.request("session/set_config_option", {
          sessionId,
          configId: "model",
          value: "anthropic/claude-haiku-4-5",
        });
        return { changed, kinds: updates.map((n) => n.update.sessionUpdate) };
      },
      { session: { configOptions: {} } },
    );
    expect(result.kinds).toContain("current_mode_update");
    expect(result.kinds).toContain("config_option_update");
    expect(result.changed).toMatchObject({ configOptions: [{ currentValue: "anthropic/claude-haiku-4-5" }] });
  });

  test("set_mode mid-turn is -32600; resume of an open session answers; delete then load is -32002", async () => {
    const result = await connect(
      app(() => [waitForCancel]),
      async (agent, updates) => {
        const { sessionId } = await agent.request("session/new", { cwd: "/w", mcpServers: [] });
        const running = agent.request("session/prompt", prompt(sessionId, "go"));
        await waitForCondition(() => updates.length > 0);
        const busy = await agent.request("session/set_mode", { sessionId, modeId: "read" }).catch((e: unknown) => e);
        await agent.notify("session/cancel", { sessionId });
        const stop = (await running).stopReason;
        const resumed = await agent.request("session/resume", { sessionId, cwd: "/w" });
        await agent.request("session/delete", { sessionId });
        const missing = await agent
          .request("session/load", { sessionId, cwd: "/w", mcpServers: [] })
          .catch((e: unknown) => e);
        return { busy: codeOf(busy), stop, resumed, missing: codeOf(missing) };
      },
    );
    expect(result.busy).toBe(-32600);
    expect(result.stop).toBe("cancelled");
    expect(result.resumed).toMatchObject({ modes: { currentModeId: "ask" } });
    expect(result.missing).toBe(-32002);
  });
});
```

In `stdout-purity.test.ts`, add `child.stdin.write(frame(5, "session/list", {}));` and `expect(frames.find((f) => f.id === 5)?.result).toEqual({ sessions: [] });`. The config dir is empty, so the sessions dir does not exist.

- [ ] **Step 2: Run to verify they fail.** `timeout 120 bun test ./test/unit/server/connection.test.ts ./test/unit/server/connection-persistence.test.ts ./test/unit/server/stdout-purity.test.ts --timeout=60000`. Expected: FAIL (capability pin, unknown methods).

- [ ] **Step 3: Implement.**

`capabilities.ts`: set `loadSession: true` and add `sessionCapabilities: { list: {}, resume: {}, close: {}, delete: {} }`. Update the header comment: S5-3 advertises load, list, resume, close and delete.

`connection.ts`: add these handlers next to the existing ones, each under `guard`:

```ts
    .onRequest("session/new", (ctx) =>
      guard(deps.logger, () =>
        deps.registry.create({
          cwd: ctx.params.cwd,
          mcpServers: ctx.params.mcpServers,
          port: (sessionId) => clientPort(ctx.client, sessionId, features),
        }),
      ),
    )
    .onRequest("session/load", (ctx) =>
      guard(deps.logger, () =>
        deps.registry.load(ctx.params.sessionId, {
          cwd: ctx.params.cwd,
          mcpServers: ctx.params.mcpServers,
          port: (sessionId) => clientPort(ctx.client, sessionId, features),
        }),
      ),
    )
    .onRequest("session/resume", (ctx) =>
      guard(deps.logger, () =>
        deps.registry.resume(ctx.params.sessionId, {
          cwd: ctx.params.cwd,
          mcpServers: ctx.params.mcpServers ?? [],
          port: (sessionId) => clientPort(ctx.client, sessionId, features),
        }),
      ),
    )
    .onRequest("session/list", (ctx) => guard(deps.logger, () => deps.registry.list(ctx.params)))
    .onRequest("session/close", (ctx) => guard(deps.logger, () => deps.registry.close(ctx.params.sessionId)))
    .onRequest("session/delete", (ctx) => guard(deps.logger, () => deps.registry.delete(ctx.params.sessionId)))
    .onRequest("session/set_mode", (ctx) =>
      guard(deps.logger, () => deps.registry.setMode(ctx.params.sessionId, ctx.params.modeId)),
    )
    .onRequest("session/set_config_option", (ctx) =>
      guard(deps.logger, async () => ({
        configOptions: await deps.registry.setConfigOption(ctx.params.sessionId, ctx.params.configId, ctx.params.value),
      })),
    )
```

The `session/new` handler replaces the S5-2 one; `create` now returns the whole response. Where a handler's response type is `X | void`, returning `undefined` from `close`/`delete`/`set_mode` is accepted. If the compiler wants an object, return `{}`.

`main.ts`, replacing the S5-2 registry construction:

```ts
  const transcripts = createFileTranscriptStore(resolved.options.sessionsDir);
  const registry = createSessionRegistry({
    options: resolved.options,
    openSession: nativeOpenSession({
      transcripts,
      catalogOverrides: catalogOverridesFrom(resolved.options.catalogOverrides, logger),
      turnTimeoutSeconds: TURN_TIMEOUT_SECONDS,
    }),
    storage: createSessionStorage({ dir: resolved.options.sessionsDir, pid: process.pid, now: () => new Date(), logger }),
    transcripts,
    newId: randomUUID,
    now: () => new Date(),
    readOldText: fsReadOldText(),
    logger,
    turnTimeoutSeconds: TURN_TIMEOUT_SECONDS,
  });
```

Import `createSessionStorage` from `#src/server/storage` and `createFileTranscriptStore` from `@nathapp/nax-agent`. `process.pid` is Node, not a Bun API. The existing `finally { await registry.closeAll(); }` now carries the 5 s cap.

Spec amendments (`docs/superpowers/specs/2026-10-08-s5-acp-server-design.md`):
- §3.3: replace the paragraph with

> S3 fixes the profile, model and `bashApproval` at session creation. A change between turns closes the `AgentSession` and reopens the same transcript with the new options: resume when the store holds a document, create when the session was never prompted. A model change keeps the conversation (amended 2026-10-09, S5-3, user ruling). nax-ai assistant messages record the model that wrote them, so pi-ai sends another model's thinking as text without its signature. nax-agent's `carryHistoryAcrossModels` lets the resume and the loop keep history written by another model; the per-model compaction anchor is not reused. A change while a turn is running is rejected (`invalid_request`, "turn in progress"). The metadata file is updated only after the reopen succeeds; on failure the old session is reopened with the old options and the error is returned.

- §5.2: append to the capabilities list: "Mode `ask` requires `bashApproval: gated`. Switching to `ask` sets it, and a non-`gated` value under `ask` is refused (S5-3 M-23)."

Context: in `.nax/mono/packages/nax-agent-acp/context.md`, append to the S5 status sentence after the S5-2 clause:

> S5-3 makes sessions durable: `storage.ts` (`<id>.session.json` metadata, `<id>.lock`, list), `session-config.ts` (modes and the model/bashApproval options), and a file-backed `registry.ts` (load with replay, resume, list, close, delete, mode/config switch by close-and-reopen keeping history across models, bounded shutdown).

Then from the repo root run `bun packages/nax/bin/nax.ts generate && bun packages/nax/bin/nax.ts generate --all-packages`.

- [ ] **Step 4: Full gates.**
- From `packages/nax-agent-acp`: `bun run typecheck && bun run check:all && timeout 300 bun test ./test/unit/ --timeout=60000 && bun run test:coverage && bun run test:node && bun run check:api`.
- From `packages/nax-agent`: `bun run typecheck && bun run check:all && timeout 300 bun test ./test/unit/ --timeout=60000 && bun run test:coverage`.
- From `packages/nax-ai`: `bun run typecheck && bun run lint && bun run test`.
- From `packages/nax`: `bun run check:package-boundaries`.

Expected: all PASS. `check:api` is unchanged because no export of `./server` changed.

- [ ] **Step 5: Commit**

```bash
git add packages/nax-agent-acp docs/superpowers/specs/2026-10-08-s5-acp-server-design.md .nax/mono/packages/nax-agent-acp/context.md packages/nax-agent-acp/AGENTS.md packages/nax-agent-acp/CLAUDE.md packages/nax-agent-acp/GEMINI.md packages/nax-agent-acp/codex.md
git commit -m "feat(acp-server): S5-3 serve load/resume/list/close/delete/set_mode/set_config_option"
```

- [ ] **Step 6: Review, PR, follow-ups**
- One whole-branch code review before pushing.
- One PR, "feat(acp-server): S5-3 persistence and settings switch (history kept across models)", whose body lists M-19..M-27 and notes that nax-ai must be released before nax-agent at S5-4 (M-20).
- After merge, update the master-plan S5 row, then write the S5-4 plan (auth, README, live checks, release of nax-ai + nax-agent + nax-agent-acp).
