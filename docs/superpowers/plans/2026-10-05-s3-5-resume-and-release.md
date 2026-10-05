# S3-5: Resume, Node contract, docs and the 0.2.0 release (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish S3. This PR adds:
- `resumeAgentSession`, which reports a turn a dead process left running as `interrupted`;
- a default loop-level transport retry for facade sessions, so a fault mid-stream is retried and `stream_reset` can reach an embedder;
- the Node contract cases for the facade;
- a packed-tarball chat smoke;
- a billed real-provider chat smoke fixture;
- README, CHANGELOG and spec amendments.

Then, with approval at each gate, it runs S3 acceptance and publishes `@nathapp/nax-agent@0.2.0`.

**Architecture:**
- `resumeAgentSession(sessionId, options)` is the second entry into the facade in `packages/nax-agent/src/session/agent-session.ts`. It shares `createAgentSession`'s option validation and assembly.
- A new module `src/session/agent-session-resume.ts` holds the pre-open document checks. They run before any backend opens:
  - the id comes from the argument;
  - the document is present;
  - its schema is known;
  - `messages` is an array;
  - the model that wrote it matches the resuming model.
- The S1 session opens with `resume: true`, so it never deletes the document.
- A `turn.state === "running"` marker is then closed with `markTurn(ended)`, and the session starts with `lastTurn = { turnId, status: "interrupted" }`.
- Facade sessions also get nax's default `transportRetry` (`{ maxAttempts: 3, baseDelayMs: 2000 }`). The loop's retry wrapper is what emits `stream_reset`, and without a retry config a facade session can never emit one.

Everything else is tests, fixtures and documentation.

**Tech Stack:**
- TypeScript 7.0.2, Bun 1.4 (bun:test for unit tests), vitest 4.1.9 on Node 22 and 24 (the Node contract suite);
- `@nathapp/nax-ai@0.1.16` (pinned, unchanged; no nax-ai release);
- the existing release helper `packages/nax-agent/scripts/release.ts` and the GitHub Actions `release.yml` (OIDC trusted publishing).

**Spec:** `docs/superpowers/specs/2026-10-03-s3-conversational-session-api-design.md`. The relevant sections are:
- §4.2 (`resumeAgentSession`), §5.3 (`stream_reset`), §5.5 (`TranscriptStore`, `markTurn`) and §6.4 (Restart);
- §7 (errors), §8 (tests), §9 row S3-5 and §10 (acceptance).

**Base:** `main` @ `4787e8a03` (S3-4 merged, #2349). Branch `feat/s3-5-resume`, already created from `origin/main`. One feature PR, then one release-preparation PR opened by the release helper.

## Global Constraints

- **nax behaviour is unchanged.**
  - nax never calls `createAgentSession` or `resumeAgentSession`.
  - Task 2 changes only the `OpenSessionOpts` the facade builds; nax builds its own and keeps its configured `transportRetry`.
  - nax's `TurnResult`, stream-bus events, transcript bytes, cost rows and tool-audit records must stay identical to `main`.
- **Dependency direction** is `nax-ai` → `nax-agent` → `nax`.
  - `@nathapp/nax-ai` is importable in nax-agent `src/` only from `src/native/` and `src/cost/standard-types.ts` (`check:nax-ai-imports`).
  - New `src/session/` files import nax-agent modules only. Tests may import nax-ai types (the existing `test/helpers/agent-session.ts` does).
- **Node built-ins only.** nax-agent ships zero Bun APIs (`check:no-bun-apis`). `src/` and every `test/node/` file use `node:` built-ins and vitest only; never import `bun:test` or `#test/helpers/index` (it re-exports Bun-only helpers) from `test/node/`.
- **Every thrown error is a `NaxError`** (`check-nax-error`). The facade's public errors are `AgentSessionError`. An unreadable stored document is a plain `NaxError` with code `TRANSCRIPT_CORRUPT`, the code the file store already throws for an unparseable file.
- **Public names (`.`).**
  - Names on `.` are explicitly named, and none starts with `_`.
  - After Task 1, run `bun run check:api`, then `bun run api:update`, and commit `api/nax-agent.api.txt`. The only change is the added line `resumeAgentSession` in the `[.]` section.
- **Coverage:** 80% overall and 80% per file, with an empty baseline (`bun run test:coverage`). The new `src/session/agent-session-resume.ts` needs a bun unit test that imports it (`--require-all-files`). Note that `test:coverage` runs the bun suites only; vitest Node tests do not count.
- **Size and complexity.**
  - Source files must be at most 600 lines and test files at most 800 (`check-file-sizes`).
  - Cognitive complexity must be at most 20 per function (`check-complexity`). After any task that touches `src/`, run `bun ../repo-tooling/scripts/check-complexity.ts --package=.`.
  - `assemble` in `agent-session.ts` gains properties, not branches.
- **Commands.**
  - Never run bare `bun test` or `bun run nax`.
  - Run package scripts from `packages/nax-agent`. Run one bun file with `bun test ./test/unit/<path>.test.ts --timeout=60000`. Run one Node file with `bun x vitest --run test/node/<file>.test.ts`.
- **Test rules.**
  - Escape-hatch ratchet: the regex `\bas\s+[A-Z]\w*` counts test text, test names included, as a loose cast. Use typed declarations, and keep test names clear of "as <Capitalised>". `as const` is fine.
  - Tests do not sleep: timers go through `_agentSessionDeps` (manual timers from `test/helpers/agent-session.ts`). Transport-fault rounds use `retryAfter: 0`, so the loop's backoff is zero.
  - Do not name test files after stories or tickets (`check:test-satellites`).
- **Billed runs.** Every real-provider run (Task 9) and every publish step (Task 10) needs the maintainer's explicit approval **at launch**. Subagents never run them; the controller does, after asking.
- **Release discipline.**
  - Publishing happens only through the release helper and the tag workflow (`RELEASING.md`, "Subsequent releases").
  - Never `npm publish` by hand, never re-publish an existing version, never bump to a different version to retry.
  - Release order is nax-ai → nax-agent → nax. nax-ai is unchanged, and nax is not released in this plan.
- **Formatting.** The code blocks in this plan are not biome-formatted (line wraps, import order). After writing code in any task, run `bun run lint:fix` from `packages/nax-agent`, then `bun run lint`. Formatting changes are expected; a lint error that `lint:fix` cannot fix is a finding.
- **Style.** No emojis. Conventional commits (`feat:`, `test:`, `docs:`, `chore:`).
- **macOS shell:** use `sed -i ''`, and a `for` loop over `grep -rl` output instead of piping into `xargs`.

## Review Focus

1. **The resumed id is the argument, and a path-shaped one is refused before the store is touched.** Calls to check:
   - `resumeAgentSession("../escape", options)`;
   - a call whose `options.sessionId` differs from the argument.

   Expected: `AGENT_SESSION_INVALID_OPTIONS`, with zero calls on the store. A file store never reads `<dir>/../escape.transcript.json`. Pinned in Task 1.
2. **A different reasoning-effort suffix is not a different model.** A document written under `openai/gpt-5.4-mini`, resumed with `openai/gpt-5.4-mini[high]`, opens and carries history. A different model id is `AGENT_SESSION_MODEL_MISMATCH`. This matches the loop's own identity rule (`transcriptModelIdentity`). Pinned in Task 1.
3. **A marker-only document, left when a session's first turn failed before the loop saved, is resumable.** It opens with empty history and `lastTurn` undefined; it is neither `NOT_FOUND` nor corrupt. S3-4 shipped this limitation and promised S3-5 would fix it. Pinned in Task 1.
4. **A store that fails while ending the interrupted turn fails the resume without leaking.** `resumeAgentSession` rejects with the store's error, the opened backend session is closed, and the private `none` root is removed. Pinned in Task 1.
5. **A transient transport fault after text has streamed.** Expected: the turn is retried, the consumer gets `stream_reset` for the voided deltas, and the turn completes, instead of ending `errored` as it does on `main`. A fault on every attempt ends `errored` after three attempts. Pinned in Task 2 (bun) and Task 3 (Node).

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `packages/nax-agent/src/session/agent-session-resume.ts` | Create | Resume input (id from the argument), stored-document checks, interrupted-marker read |
| `packages/nax-agent/src/session/agent-session.ts` | Modify | `resumeAgentSession`; shared `open`; initial `lastTurn`; `resume` flag; default `transportRetry` |
| `packages/nax-agent/src/session/agent-session-types.ts` | Modify | Doc comments on `lastTurn` and `transcriptStore` |
| `packages/nax-agent/src/index.ts` | Modify | Export `resumeAgentSession` |
| `packages/nax-agent/api/nax-agent.api.txt` | Regenerate | `+resumeAgentSession` |
| `packages/nax-agent/test/unit/session/agent-session-resume.test.ts` | Create | bun unit tests for resume |
| `packages/nax-agent/test/unit/session/agent-session-chat.test.ts` | Modify | Transport-retry tests |
| `packages/nax-agent/test/helpers/agent-session.ts` | Modify | `faultRound` helper |
| `packages/nax-agent/test/node/agent-session.test.ts` | Create | Node contract: chat, streaming, approvals, questions, teardown, profiles |
| `packages/nax-agent/test/node/agent-session-resume.test.ts` | Create | Node contract: resume, model mismatch, two sessions with no `configureCredentials` |
| `packages/nax-agent/test/node/fixtures/packed-smoke.mjs` | Modify | Section 4: the §1 chat round-trip from the packed entry |
| `packages/nax-agent/test/node/pack-smoke.test.ts` | Modify | Consumer typecheck imports the facade |
| `packages/nax-agent/test/node/fixtures/live-chat-smoke.mjs` | Create | Billed §10.2 smoke (run only in Task 9) |
| `packages/nax-agent/RELEASING.md` | Modify | "S3 acceptance" procedure |
| `packages/nax-agent/README.md` | Modify | Sessions section; published status |
| `packages/nax-agent/CHANGELOG.md` | Modify | `[Unreleased]` covering S3-0 to S3-5 |
| `docs/superpowers/specs/2026-10-03-s3-conversational-session-api-design.md` | Modify | "As built (S3-5)" amendments |

---

### Task 1: `resumeAgentSession` and `interrupted`

**Files:**
- Create: `packages/nax-agent/src/session/agent-session-resume.ts`
- Modify: `packages/nax-agent/src/session/agent-session.ts`
- Modify: `packages/nax-agent/src/session/agent-session-types.ts:65-71,157-158` (doc comments only)
- Modify: `packages/nax-agent/src/index.ts:268`
- Regenerate: `packages/nax-agent/api/nax-agent.api.txt`
- Test: `packages/nax-agent/test/unit/session/agent-session-resume.test.ts`

**Interfaces:**
- Consumes:
  - `resolveAgentSessionOptions(input: unknown): ResolvedAgentSessionOptions` (`agent-session-options.ts`);
  - `transcriptModelIdentity(raw: string | undefined): string | undefined` (`#src/native/session/transcript-identity`);
  - `TranscriptStore`, `TranscriptDoc` (`#src/native/session/transcript-types`);
  - `AgentSessionError`, `NaxError`.
- Produces:
  - `export function resumeAgentSession(sessionId: string, options: CreateAgentSessionOptions): Promise<AgentSession>`, from `agent-session.ts` and on `.`;
  - in `agent-session-resume.ts`: `resumeInput(sessionId: string, options: CreateAgentSessionOptions): unknown`, `loadResumable(store: TranscriptStore, sessionId: string, model: string): Promise<TranscriptDoc>` and `interruptedTurnOf(doc: TranscriptDoc): string | undefined`.

- [ ] **Step 1: Write the failing tests**

Create `packages/nax-agent/test/unit/session/agent-session-resume.test.ts`:

```ts
/**
 * S3-5: resumeAgentSession (spec 4.2, 5.5, 6.4). History carries over a
 * resume; a running marker left by a dead process is ended and reported as
 * interrupted; the stored document is checked before any backend opens; the
 * resumed id is the argument; a resume never deletes the document.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createAgentSession, resumeAgentSession, type TranscriptDoc, type TranscriptStore } from "@nathapp/nax-agent";
import { NaxError } from "#src/infra/nax-error";
import { createMemoryTranscriptStore } from "#src/native/session/memory-transcript-store";
import { _agentSessionDeps } from "#src/session/agent-session-deps";
import { interruptedTurnOf } from "#src/session/agent-session-resume";
import {
  collect,
  installScriptedProvider,
  MODEL,
  resetScriptedProvider,
  sessionOptions,
  textRound,
  turnEndOf,
} from "#test/helpers/agent-session";
import { assertNaxError, withDepsRestore } from "#test/helpers/index";

afterEach(resetScriptedProvider);

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

/** A store that records every call by name and delegates to `inner`. */
function spyStore(inner: TranscriptStore = createMemoryTranscriptStore()): { store: TranscriptStore; calls: string[] } {
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

/** A store whose load returns `raw` parsed: shapes TranscriptDoc's type cannot express. */
function rawStore(raw: string): TranscriptStore {
  const inner = createMemoryTranscriptStore();
  return { ...inner, load: async () => JSON.parse(raw) };
}

const SAVED_AT = "2026-10-05T00:00:00.000Z";

function priorDoc(model: string | undefined): TranscriptDoc {
  return {
    ...(model !== undefined ? { model } : {}),
    savedAt: SAVED_AT,
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ],
  };
}

describe("resumeAgentSession: history and restart", () => {
  test("a session resumed from its store carries its history into the next turn and never deletes it", async () => {
    const provider = installScriptedProvider();
    provider.push(textRound("one"), textRound("two"));
    const { store, calls } = spyStore();
    const first = await createAgentSession(sessionOptions({ sessionId: "r-1", transcriptStore: store }));
    await collect(first.send("first"));
    await first.close();
    calls.length = 0;

    const resumed = await resumeAgentSession("r-1", sessionOptions({ transcriptStore: store }));
    expect(resumed.id).toBe("r-1");
    expect(resumed.lastTurn).toBeUndefined();
    const events = await collect(resumed.send("second"));
    expect(turnEndOf(events).output).toBe("two");
    expect(provider.requests[1]?.messages).toEqual([
      { role: "user", content: "first" },
      expect.objectContaining({ role: "assistant", content: "one" }),
      { role: "user", content: "second" },
    ]);
    expect(calls).not.toContain("delete");
    await resumed.close();
  });

  test("a running marker left by a dead process is ended and reported as interrupted", async () => {
    const provider = installScriptedProvider();
    provider.push(textRound("back"));
    const store = createMemoryTranscriptStore();
    await store.save("r-2", priorDoc(MODEL));
    await store.markTurn("r-2", { turnId: "t-dead", state: "running" });

    const session = await resumeAgentSession("r-2", sessionOptions({ transcriptStore: store }));
    expect(session.lastTurn).toEqual({ turnId: "t-dead", status: "interrupted" });
    expect((await store.load("r-2"))?.turn).toEqual({ turnId: "t-dead", state: "ended" });

    const end = turnEndOf(await collect(session.send("are you there")));
    expect(end.status).toBe("completed");
    expect(session.lastTurn).toEqual({ turnId: end.turnId, status: "completed" });
    expect(provider.requests[0]?.messages[0]).toEqual({ role: "user", content: "hi" });
    await session.close();
  });

  test("a marker-only document (a first turn that failed before the loop saved) resumes with empty history", async () => {
    const provider = installScriptedProvider();
    provider.push(textRound("fresh"));
    const store = createMemoryTranscriptStore();
    await store.markTurn("r-3", { turnId: "t0", state: "ended" });

    const session = await resumeAgentSession("r-3", sessionOptions({ transcriptStore: store }));
    expect(session.lastTurn).toBeUndefined();
    await collect(session.send("hi"));
    expect(provider.requests[0]?.messages).toEqual([{ role: "user", content: "hi" }]);
    await session.close();
  });

  test("an effort suffix is not a different model: the document resumes and its history carries", async () => {
    const provider = installScriptedProvider();
    provider.push(textRound("ok"));
    const store = createMemoryTranscriptStore();
    await store.save("r-4", priorDoc(MODEL));

    const session = await resumeAgentSession("r-4", sessionOptions({ transcriptStore: store, model: `${MODEL}[high]` }));
    await collect(session.send("next"));
    expect(provider.requests[0]?.messages).toHaveLength(3);
    await session.close();
  });
});

describe("resumeAgentSession: refusals", () => {
  test("a missing document is NOT_FOUND after a single load", async () => {
    const { store, calls } = spyStore();
    await rejectsWith(resumeAgentSession("absent", sessionOptions({ transcriptStore: store })), "AGENT_SESSION_NOT_FOUND");
    expect(calls).toEqual(["load"]);
  });

  test("an unknown schemaVersion is SCHEMA_UNSUPPORTED", async () => {
    const store = rawStore('{"schemaVersion":2,"savedAt":"t","messages":[]}');
    await rejectsWith(
      resumeAgentSession("r-5", sessionOptions({ transcriptStore: store })),
      "AGENT_SESSION_SCHEMA_UNSUPPORTED",
    );
  });

  test("a document whose messages is not an array is TRANSCRIPT_CORRUPT", async () => {
    const store = rawStore('{"savedAt":"t","messages":{}}');
    await rejectsWith(resumeAgentSession("r-6", sessionOptions({ transcriptStore: store })), "TRANSCRIPT_CORRUPT");
  });

  test("a document written by another model is MODEL_MISMATCH; one with no recorded model resumes", async () => {
    const store = createMemoryTranscriptStore();
    await store.save("r-7", priorDoc("openai/gpt-5.4"));
    await rejectsWith(
      resumeAgentSession("r-7", sessionOptions({ transcriptStore: store })),
      "AGENT_SESSION_MODEL_MISMATCH",
    );
    await store.save("r-8", priorDoc(undefined));
    const session = await resumeAgentSession("r-8", sessionOptions({ transcriptStore: store }));
    await session.close();
  });

  test("the resumed id is the argument: a path-shaped id or a different options.sessionId is refused before the store is read", async () => {
    const { store, calls } = spyStore();
    await rejectsWith(
      resumeAgentSession("../escape", sessionOptions({ transcriptStore: store })),
      "AGENT_SESSION_INVALID_OPTIONS",
    );
    await rejectsWith(
      resumeAgentSession("a", sessionOptions({ transcriptStore: store, sessionId: "b" })),
      "AGENT_SESSION_INVALID_OPTIONS",
    );
    expect(calls).toEqual([]);
    await store.save("a", priorDoc(MODEL));
    const session = await resumeAgentSession("a", sessionOptions({ transcriptStore: store, sessionId: "a" }));
    expect(session.id).toBe("a");
    await session.close();
  });
});

describe("resumeAgentSession: a store that fails while ending the interrupted turn", () => {
  withDepsRestore(_agentSessionDeps);

  test("fails the resume with the store's error, closes the session and removes its private root", async () => {
    const removed: string[] = [];
    const remove = _agentSessionDeps.removeScratchRoot;
    _agentSessionDeps.removeScratchRoot = async (dir) => {
      removed.push(dir);
      await remove(dir);
    };
    const inner = createMemoryTranscriptStore();
    await inner.save("r-9", priorDoc(MODEL));
    await inner.markTurn("r-9", { turnId: "t-dead", state: "running" });
    const store: TranscriptStore = {
      ...inner,
      markTurn: async () => {
        throw new NaxError("store is down", "STORE_DOWN", { stage: "test" });
      },
    };
    await rejectsWith(resumeAgentSession("r-9", sessionOptions({ transcriptStore: store })), "STORE_DOWN");
    expect(removed).toHaveLength(1);
  });
});

describe("interruptedTurnOf", () => {
  test("names the turn of a running marker only", () => {
    expect(interruptedTurnOf({ savedAt: SAVED_AT, messages: [], turn: { turnId: "t", state: "running" } })).toBe("t");
    expect(interruptedTurnOf({ savedAt: SAVED_AT, messages: [], turn: { turnId: "t", state: "ended" } })).toBeUndefined();
    expect(interruptedTurnOf({ savedAt: SAVED_AT, messages: [] })).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run, from `packages/nax-agent`: `bun test ./test/unit/session/agent-session-resume.test.ts --timeout=60000`
Expected: FAIL. The imports `resumeAgentSession` (from `@nathapp/nax-agent`) and `#src/session/agent-session-resume` do not resolve.

- [ ] **Step 3: Create `src/session/agent-session-resume.ts`**

```ts
/**
 * resumeAgentSession's checks on the stored document (S3 spec 4.2, 6.4). They
 * run before any backend opens: the id comes from the argument, the document
 * exists, this build reads its schema, its messages are an array, and the
 * model that wrote it is the one resuming. The model rule is the loop's own
 * (transcriptModelIdentity): an effort suffix is not a different model.
 */
import { NaxError } from "#src/infra/nax-error";
import { transcriptModelIdentity } from "#src/native/session/transcript-identity";
import type { TranscriptDoc, TranscriptStore } from "#src/native/session/transcript-types";
import { AgentSessionError } from "./agent-session-errors.ts";
import type { CreateAgentSessionOptions } from "./agent-session-types.ts";

/**
 * The options to validate for a resume: the argument is the session id. A
 * different `options.sessionId` is a caller bug, refused before the store is
 * read. Non-object options pass through for the option validator to reject.
 */
export function resumeInput(sessionId: string, options: CreateAgentSessionOptions): unknown {
  if (typeof options !== "object" || options === null) return options;
  if (options.sessionId !== undefined && options.sessionId !== sessionId) {
    throw new AgentSessionError(
      `Invalid agent session options: sessionId "${options.sessionId}" is not the session being resumed ("${sessionId}")`,
      "AGENT_SESSION_INVALID_OPTIONS",
      { path: "sessionId" },
    );
  }
  return { ...options, sessionId };
}

/** The stored document a resume starts from. Throws when there is none or this session may not read it. */
export async function loadResumable(store: TranscriptStore, sessionId: string, model: string): Promise<TranscriptDoc> {
  const doc = await store.load(sessionId);
  if (doc === null) {
    throw new AgentSessionError(
      `Session "${sessionId}" has no document in the transcript store`,
      "AGENT_SESSION_NOT_FOUND",
      { sessionId },
    );
  }
  const version: unknown = doc.schemaVersion;
  if (version !== undefined && version !== 1) {
    throw new AgentSessionError(
      `Session "${sessionId}" has transcript schemaVersion ${String(version)}; this build reads 1`,
      "AGENT_SESSION_SCHEMA_UNSUPPORTED",
      { sessionId },
    );
  }
  if (!Array.isArray(doc.messages)) {
    throw new NaxError(
      `transcript for session "${sessionId}" is unreadable: messages is not an array`,
      "TRANSCRIPT_CORRUPT",
      { stage: "agent-session", sessionId },
    );
  }
  const resuming = transcriptModelIdentity(model);
  if (doc.model !== undefined && doc.model !== resuming) {
    throw new AgentSessionError(
      `Session "${sessionId}" was written by model "${doc.model}"; resume it with that model, not "${resuming}"`,
      "AGENT_SESSION_MODEL_MISMATCH",
      { sessionId },
    );
  }
  return doc;
}

/** The turn a dead process left running (spec 6.4), or undefined. */
export function interruptedTurnOf(doc: TranscriptDoc): string | undefined {
  const turn = doc.turn;
  return turn?.state === "running" && typeof turn.turnId === "string" ? turn.turnId : undefined;
}
```

- [ ] **Step 4: Wire `resumeAgentSession` into `src/session/agent-session.ts`**

4a. Update the file header comment (lines 1-7) so its last sentence reads:

```ts
 * in behind the same API. resumeAgentSession reopens a stored session
 * (spec 4.2, 6.4).
```

4b. Add the imports below the existing `./agent-session-options.ts` import line:

```ts
import { interruptedTurnOf, loadResumable, resumeInput } from "./agent-session-resume.ts";
```

Add `TranscriptStore` to the type imports. It is not imported yet, so add a new line:

```ts
import type { TranscriptStore } from "#src/native/session/transcript-types";
```

4c. Below `interface LiveSlot`, add:

```ts
type LastTurn = { readonly turnId: string; readonly status: TurnEndStatus };

/** How the backend session is opened, and the lastTurn a resume reports. */
interface Opening {
  readonly resume: boolean;
  readonly lastTurn: LastTurn | undefined;
}
```

4d. In `class NativeAgentSession`:
- replace `private last: { readonly turnId: string; readonly status: TurnEndStatus } | undefined;` with `private last: LastTurn | undefined;`;
- replace the constructor with:

```ts
  constructor(
    private readonly parts: SessionParts,
    last: LastTurn | undefined,
  ) {
    this.last = last;
  }
```

- change the `lastTurn` getter's return type to `LastTurn | undefined`.

4e. Change `assemble`:
- its signature becomes `async function assemble(options: ResolvedAgentSessionOptions, sessionId: string, root: SessionRoot, opening: Opening): Promise<NativeAgentSession>`;
- inside `adapter.openSession(sessionId, { ... })`, add `resume: opening.resume,` directly after `retainOnClose: true,`;
- its last line becomes `return new NativeAgentSession({ ctx, table, slot, cleanup: root.cleanup }, opening.lastTurn);`.

4f. Replace `createAgentSession` (from `export async function createAgentSession` to the end of the file) with:

```ts
/** Opens the backend session under a fresh root; a failure removes the root. */
async function open(options: ResolvedAgentSessionOptions, sessionId: string, opening: Opening): Promise<NativeAgentSession> {
  const root = await sessionRoot(options);
  try {
    return await assemble(options, sessionId, root, opening);
  } catch (err) {
    await root.cleanup();
    throw err;
  }
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
  return open(options, sessionId, { resume: false, lastTurn: undefined });
}

/**
 * Spec 6.4: the turn a dead process left running is marked ended, so the next
 * send starts clean. A failure closes the session and rethrows the store's
 * error; a close failure would only mask it.
 */
async function endInterruptedTurn(
  session: NativeAgentSession,
  store: TranscriptStore,
  sessionId: string,
  turnId: string,
): Promise<void> {
  try {
    await store.markTurn(sessionId, { turnId, state: "ended" });
  } catch (err) {
    await session.close().catch(() => undefined);
    throw err;
  }
}

/**
 * Reopens a stored session (spec 4.2). `options` are a create's options; the
 * session id is the argument. Instructions, tools and profile are not stored:
 * pass them again.
 */
export async function resumeAgentSession(sessionId: string, input: CreateAgentSessionOptions): Promise<AgentSession> {
  const options = resolveAgentSessionOptions(resumeInput(sessionId, input));
  const store = options.raw.transcriptStore;
  const interrupted = interruptedTurnOf(await loadResumable(store, sessionId, options.raw.model));
  const session = await open(options, sessionId, {
    resume: true,
    lastTurn: interrupted === undefined ? undefined : { turnId: interrupted, status: "interrupted" },
  });
  if (interrupted !== undefined) await endInterruptedTurn(session, store, sessionId, interrupted);
  return session;
}
```

4g. In `src/session/agent-session-types.ts`, update two doc comments only:
- on `AgentSession.lastTurn`: `/** Set after each \`turn_end\`; on resume, \`interrupted\` when a dead process left a turn running. Undefined otherwise. */`;
- on `CreateAgentSessionOptions.transcriptStore`, change the first sentence to: `Where the conversation lives. The session keeps its document on close, so \`resumeAgentSession\` can reopen it.` Keep the rest of the comment.

4h. In `src/index.ts`, change line 268 to:

```ts
export { createAgentSession, resumeAgentSession } from "#src/session/agent-session";
```

- [ ] **Step 5: Run the tests to verify they pass**

Run, from `packages/nax-agent`:
- `bun test ./test/unit/session/agent-session-resume.test.ts --timeout=60000`
- `bun test ./test/unit/session/ --timeout=60000`

Expected: all PASS. The second command shows that the S3-4 suites are unchanged.

If only the `[high]` effort case fails, and it fails at `sendTurn` because the scripted model lists no `thinkingLevels`, stop and report it: whether an effort suffix may resume is a design question, not a test to drop.

- [ ] **Step 6: Update the API snapshot and run the gates**

Run, from `packages/nax-agent`:
- `bun run check:api`. Expected: FAIL, naming `resumeAgentSession`.
- `bun run api:update`.
- `git diff api/nax-agent.api.txt`. Expected: exactly one added line, `resumeAgentSession`, in `[.]`.
- `bun ../repo-tooling/scripts/check-complexity.ts --package=.`, `bun run lint` and `bun x tsc --noEmit`. Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add src/session/agent-session-resume.ts src/session/agent-session.ts src/session/agent-session-types.ts src/index.ts api/nax-agent.api.txt test/unit/session/agent-session-resume.test.ts
git commit -m "feat(nax-agent): resumeAgentSession and the interrupted turn status"
```

---

### Task 2: Default transport retry for facade sessions (`stream_reset` reachable)

**Files:**
- Modify: `packages/nax-agent/src/session/agent-session.ts` (`assemble`'s `openSession` options)
- Modify: `packages/nax-agent/test/helpers/agent-session.ts`
- Test: `packages/nax-agent/test/unit/session/agent-session-chat.test.ts`

**Interfaces:**
- Consumes: `OpenSessionOpts.transportRetry?: TurnRetryConfig` (`{ maxAttempts: number; baseDelayMs: number }`, `#src/native/session/turn-retry`).
- Produces:
  - a module-private `const SESSION_TRANSPORT_RETRY: TurnRetryConfig` in `agent-session.ts`, not exported;
  - the test helper `faultRound(text: string, kind?: "transport" | "overloaded"): Round` in `test/helpers/agent-session.ts`, used by Task 3.

- [ ] **Step 1: Add the `faultRound` helper**

In `packages/nax-agent/test/helpers/agent-session.ts`, add directly after `toolRound`:

```ts
/**
 * A round that streams `text`, then fails with a retryable `kind` fault. It
 * sets `retryAfter: 0`, so the loop's retry waits zero ms and tests never sleep.
 */
export function faultRound(text: string, kind: "transport" | "overloaded" = "transport"): Round {
  return async function* fault(): AsyncGenerator<ProtocolEvent> {
    yield { type: "text-delta", text };
    yield { type: "error", error: { kind, message: `scripted ${kind} fault`, retryAfter: 0 } };
  };
}
```

- [ ] **Step 2: Write the failing tests**

In `packages/nax-agent/test/unit/session/agent-session-chat.test.ts`:
- add `eventsOf` and `faultRound` to the `#test/helpers/agent-session` import list;
- append this describe block at the end of the file:

```ts
describe("createAgentSession: transport retry", () => {
  test("a transport fault after streamed text is retried: stream_reset voids the deltas and the turn completes", async () => {
    const provider = installScriptedProvider();
    provider.push(faultRound("stale"), textRound("fresh"));
    const session = await createAgentSession(sessionOptions());
    const events = await collect(session.send("hi"));
    expect(types(events)).toEqual(["turn_start", "text_delta", "stream_reset", "text_delta", "usage", "turn_end"]);
    expect(eventsOf(events, "stream_reset")[0]).toMatchObject({ round: 1, attempt: 2 });
    expect(turnEndOf(events)).toMatchObject({ status: "completed", output: "fresh" });
    expect(provider.requests).toHaveLength(2);
    await session.close();
  });

  test("a fault on every attempt ends the turn errored after three attempts", async () => {
    const provider = installScriptedProvider();
    provider.push(faultRound("a"), faultRound("b"), faultRound("c"));
    const session = await createAgentSession(sessionOptions());
    const end = turnEndOf(await collect(session.send("hi")));
    expect(end.status).toBe("errored");
    expect(provider.requests).toHaveLength(3);
    await session.close();
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bun test ./test/unit/session/agent-session-chat.test.ts --timeout=60000`
Expected: the first new test FAILS. It sees `turn_end` with status `errored` after one request, and no `stream_reset`. The second also FAILS (`requests` has length 1).

- [ ] **Step 4: Implement**

In `packages/nax-agent/src/session/agent-session.ts`:

Add an import:

```ts
import type { TurnRetryConfig } from "#src/native/session/turn-retry";
```

Add this below `IDLE_SIGNAL`:

```ts
/**
 * nax's `agent.native.transportRetry` default. The loop retries a transport,
 * overloaded or rate-limit fault that arrives after events have streamed, and
 * emits `stream_reset` so the consumer voids that round's deltas (spec 5.3).
 */
const SESSION_TRANSPORT_RETRY: TurnRetryConfig = { maxAttempts: 3, baseDelayMs: 2000 };
```

In `assemble`'s `adapter.openSession(sessionId, { ... })`, add `transportRetry: SESSION_TRANSPORT_RETRY,` directly after `spinBreaker: DEFAULT_SPIN_BREAKER_SETTINGS,`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test ./test/unit/session/ --timeout=60000`
Expected: all PASS.

Then run `bun ../repo-tooling/scripts/check-complexity.ts --package=.` and `bun run lint`. Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/session/agent-session.ts test/helpers/agent-session.ts test/unit/session/agent-session-chat.test.ts
git commit -m "feat(nax-agent): retry transport faults in facade sessions with stream_reset"
```

---

### Task 3: Node contract cases: chat, streaming, approvals, questions, teardown, profiles

**Files:**
- Create: `packages/nax-agent/test/node/agent-session.test.ts`

**Interfaces:**
- Consumes:
  - `createAgentSession`, `CreateAgentSessionOptions`, `CredentialSource`, `EmbedderTool`, `EmbedderToolContext` from `#src/index`;
  - `_agentSessionDeps` from `#src/session/agent-session-deps`;
  - from `#test/helpers/agent-session`: `collect`, `eventsOf`, `faultRound` (Task 2), `installManualTimers`, `installScriptedProvider`, `reader`, `resetScriptedProvider`, `sessionOptions`, `textRound`, `toolRound`, `turnEndOf`, `types`, `untilSettled`.
- Produces: nothing for later tasks.

These cases run the facade on real Node: real `AbortSignal.any`, async iterators, `structuredClone` and timers semantics, under vitest on Node 22 and 24 in CI. No file in `test/node/` calls `configureCredentials`; every session passes a memory credentials source.

- [ ] **Step 1: Write the tests**

Create `packages/nax-agent/test/node/agent-session.test.ts`:

```ts
/**
 * The agent session facade on real Node (S3 spec 8): multi-turn chat, deltas,
 * coalescing and stream_reset, an always-approval embedder tool allowed,
 * denied and timed out, an answer at the deadline, questions, cancel during a
 * tool, iterator break, close during a turn, and the none/read tool sets.
 * Every session brings a memory credentials source; nothing here calls
 * configureCredentials.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  type CreateAgentSessionOptions,
  type CredentialSource,
  createAgentSession,
  type EmbedderTool,
  type EmbedderToolContext,
} from "#src/index";
import { _agentSessionDeps } from "#src/session/agent-session-deps";
import {
  collect,
  eventsOf,
  faultRound,
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

const APPROVAL_MS = 30_000;
const CREDENTIALS: CredentialSource = { kind: "memory", credentials: { openai: { kind: "api-key", key: "sk-node" } } };
const SAVED_DEPS = { ..._agentSessionDeps };

afterEach(() => {
  Object.assign(_agentSessionDeps, SAVED_DEPS);
  resetScriptedProvider();
});

function nodeOptions(extra: Partial<CreateAgentSessionOptions> = {}): CreateAgentSessionOptions {
  return sessionOptions({ credentials: CREDENTIALS, approvalTimeoutMs: APPROVAL_MS, ...extra });
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

/** Ignores its signal and never settles: the facade must abandon it. */
function stuckTool(seen: EmbedderToolContext[]): EmbedderTool {
  return {
    name: "wait",
    description: "wait for something",
    inputSchema: { type: "object" },
    approval: "never",
    run(_input, ctx) {
      seen.push(ctx);
      return new Promise(() => {});
    },
  };
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("agent session on Node: chat and streaming", () => {
  test("two turns stream deltas and usage and carry history", async () => {
    const provider = installScriptedProvider();
    provider.push(textRound("Hello"), textRound("Again"));
    const session = await createAgentSession(nodeOptions({ sessionId: "node-chat" }));
    const first = await collect(session.send("hi"));
    expect(types(first)).toEqual(["turn_start", "text_delta", "usage", "turn_end"]);
    expect(turnEndOf(first)).toMatchObject({ status: "completed", output: "Hello" });
    const second = await collect(session.send("again"));
    expect(turnEndOf(second).output).toBe("Again");
    expect(provider.requests[1]?.messages).toEqual([
      { role: "user", content: "hi" },
      expect.objectContaining({ role: "assistant", content: "Hello" }),
      { role: "user", content: "again" },
    ]);
    await session.close();
  });

  test("a lagging consumer gets the adjacent deltas of one round coalesced", async () => {
    const provider = installScriptedProvider();
    provider.push([
      { type: "text-delta", text: "a" },
      { type: "text-delta", text: "b" },
      { type: "text-delta", text: "c" },
      { type: "usage", usage: { inputTokens: 1, outputTokens: 3 } },
      { type: "done", stopReason: "stop" },
    ]);
    const session = await createAgentSession(nodeOptions());
    const events = reader(session.send("spell it"));
    await events.until("turn_start");
    await untilSettled(session, undefined);
    const rest = await events.rest();
    expect(eventsOf(rest, "text_delta").map((event) => event.text)).toEqual(["abc"]);
    expect(turnEndOf(rest).output).toBe("abc");
    await session.close();
  });

  test("a transport fault after streamed text is retried with stream_reset", async () => {
    const provider = installScriptedProvider();
    provider.push(faultRound("stale"), textRound("fresh"));
    const session = await createAgentSession(nodeOptions());
    const events = await collect(session.send("hi"));
    expect(types(events)).toEqual(["turn_start", "text_delta", "stream_reset", "text_delta", "usage", "turn_end"]);
    expect(turnEndOf(events)).toMatchObject({ status: "completed", output: "fresh" });
    await session.close();
  });
});

describe("agent session on Node: approvals and questions", () => {
  test("an always-approval tool: allowed runs, denied does not, unanswered times out, a late answer is expired", async () => {
    const timers = installManualTimers();
    const provider = installScriptedProvider();
    provider.push(
      toolRound([{ id: "c1", name: "lookup", input: { id: 1 } }]),
      textRound("allowed"),
      toolRound([{ id: "c2", name: "lookup", input: { id: 2 } }]),
      textRound("denied"),
      toolRound([{ id: "c3", name: "lookup", input: { id: 3 } }]),
      textRound("timed out"),
    );
    const runs: unknown[] = [];
    const session = await createAgentSession(nodeOptions({ tools: [lookupTool("always", runs)] }));

    const allow = reader(session.send("one"));
    const [first] = eventsOf(await allow.until("approval_requested"), "approval_requested");
    expect(first).toMatchObject({ callId: "c1", tool: "lookup" });
    expect(session.answer(first?.requestId ?? "", { decision: "allow" })).toBe("accepted");
    const allowRest = await allow.rest();
    expect(eventsOf(allowRest, "approval_resolved")[0]).toMatchObject({ decision: "allow", decidedBy: "human" });
    expect(turnEndOf(allowRest).status).toBe("completed");

    const deny = reader(session.send("two"));
    const [second] = eventsOf(await deny.until("approval_requested"), "approval_requested");
    session.answer(second?.requestId ?? "", { decision: "deny" });
    // A denial is a refusal the model reads, not an error result (as the bun denial test pins).
    expect(eventsOf(await deny.rest(), "tool_result")[0]?.preview).toContain("Denied");

    const timeout = reader(session.send("three"));
    const [third] = eventsOf(await timeout.until("approval_requested"), "approval_requested");
    expect(timers.fire(APPROVAL_MS)).toBe(1);
    const timeoutRest = await timeout.rest();
    expect(eventsOf(timeoutRest, "approval_resolved")[0]).toMatchObject({ decision: "deny", decidedBy: "timeout" });
    expect(session.answer(third?.requestId ?? "", { decision: "allow" })).toBe("expired");

    expect(runs).toEqual([{ id: 1 }]);
    await session.close();
  });

  test("a question answered reaches the model; an unanswered one times out into the no-operator answer", async () => {
    const timers = installManualTimers();
    const provider = installScriptedProvider();
    provider.push(
      toolRound([{ id: "q1", name: "ask_human", input: { text: "Which env?" } }]),
      textRound("ok"),
      toolRound([{ id: "q2", name: "ask_human", input: { text: "Sure?" } }]),
      textRound("ok"),
    );
    const session = await createAgentSession(nodeOptions());

    const answered = reader(session.send("deploy"));
    const [question] = eventsOf(await answered.until("question"), "question");
    expect(session.answer(question?.requestId ?? "", { text: "staging" })).toBe("accepted");
    await answered.rest();
    expect(provider.requests[1]?.messages).toContainEqual(
      expect.objectContaining({ role: "tool-result", toolCallId: "q1", content: "staging" }),
    );

    const unanswered = reader(session.send("again"));
    await unanswered.until("question");
    timers.fire(APPROVAL_MS);
    await unanswered.rest();
    const last = provider.requests[3]?.messages.findLast((message) => message.role === "tool-result");
    expect(last).toMatchObject({ isError: true });
    expect(JSON.stringify(last)).toContain("No human operator");
    await session.close();
  });
});

describe("agent session on Node: cancellation and teardown", () => {
  test("cancel during a tool ends the turn cancelled and aborts the tool's signal", async () => {
    installManualTimers();
    const provider = installScriptedProvider();
    provider.push(toolRound([{ id: "c1", name: "wait", input: {} }]));
    const seen: EmbedderToolContext[] = [];
    const session = await createAgentSession(nodeOptions({ tools: [stuckTool(seen)] }));
    const events = reader(session.send("go"));
    await events.until("tool_call");
    await tick();
    session.cancel("person pressed stop");
    expect(turnEndOf(await events.rest()).status).toBe("cancelled");
    expect(seen[0]?.signal.aborted).toBe(true);
    await session.close();
  });

  test("breaking out of the iterator cancels the turn and frees the session", async () => {
    installManualTimers();
    const provider = installScriptedProvider();
    provider.push(toolRound([{ id: "c1", name: "wait", input: {} }]));
    const session = await createAgentSession(nodeOptions({ tools: [stuckTool([])] }));
    for await (const event of session.send("first")) {
      if (event.type === "tool_call") break;
    }
    await untilSettled(session, undefined);
    expect(session.lastTurn?.status).toBe("cancelled");
    provider.push(textRound("ok"));
    expect(turnEndOf(await collect(session.send("second"))).status).toBe("completed");
    await session.close();
  });

  test("close during a turn delivers turn_end(cancelled) and keeps the document", async () => {
    installManualTimers();
    const provider = installScriptedProvider();
    provider.push(toolRound([{ id: "c1", name: "wait", input: {} }]));
    const options = nodeOptions({ tools: [stuckTool([])] });
    const session = await createAgentSession(options);
    const events = reader(session.send("go"));
    await events.until("tool_call");
    const closing = session.close();
    expect(turnEndOf(await events.rest()).status).toBe("cancelled");
    await closing;
    expect(await options.transcriptStore.load(session.id)).not.toBeNull();
  });
});

describe("agent session on Node: profiles", () => {
  test("none advertises the scratchpad trio, embedder tools and ask_human; read adds the read tools", async () => {
    const provider = installScriptedProvider();
    provider.push(textRound("a"), textRound("b"));
    const none = await createAgentSession(nodeOptions({ tools: [lookupTool("never", [])] }));
    await collect(none.send("hi"));
    expect(provider.requests[0]?.tools?.map((tool) => tool.name).sort()).toEqual(
      ["ScratchpadList", "ScratchpadRead", "ScratchpadWrite", "ask_human", "lookup"].sort(),
    );
    const workdir = await mkdtemp(join(tmpdir(), "nax-agent-node-read-"));
    try {
      const read = await createAgentSession(nodeOptions({ profile: "read", workdir }));
      await collect(read.send("hi"));
      expect(provider.requests[1]?.tools?.map((tool) => tool.name).sort()).toEqual(
        ["Git", "Glob", "Grep", "Read", "ScratchpadList", "ScratchpadRead", "ScratchpadWrite", "ask_human"].sort(),
      );
      await read.close();
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
    await none.close();
  });
});
```

- [ ] **Step 2: Run on Node**

Run, from `packages/nax-agent`: `bun x vitest --run test/node/agent-session.test.ts`
Expected: all PASS.

`findLast` needs Node >= 18; the package floor is 22.19.0. If a case fails only on Node, that is a real finding: report it with the output, and do not weaken the assertion. The bun suites already pass the same scenarios, so a Node-only failure is a runtime difference to diagnose (for example timer or iterator semantics), not a test to relax.

- [ ] **Step 3: Run the whole Node suite and lint**

Run: `bun run test:node`, then `bun run lint`.
Expected: PASS. The pack smoke is part of `test:node`; it builds, packs and installs, which takes about two minutes.

- [ ] **Step 4: Commit**

```bash
git add test/node/agent-session.test.ts
git commit -m "test(nax-agent): Node contract cases for the agent session facade"
```

---

### Task 4: Node contract cases: resume and two sessions in one process

**Files:**
- Create: `packages/nax-agent/test/node/agent-session-resume.test.ts`

**Interfaces:**
- Consumes:
  - `createAgentSession`, `resumeAgentSession` (Task 1), `createFileTranscriptStore`, `CredentialSource`, `CreateAgentSessionOptions` from `#src/index`;
  - `_clientDeps` and the type `NativeCatalogOverrides` from `#src/native/client`;
  - the helpers from Task 3's list.
- Produces: nothing for later tasks.

- [ ] **Step 1: Write the tests**

Create `packages/nax-agent/test/node/agent-session-resume.test.ts`:

```ts
/**
 * The facade's resume and per-session clients on real Node (S3 spec 8):
 * resume after a simulated restart reports the interrupted turn and carries
 * history from a file store; a different model is refused; two sessions with
 * different catalog overrides and memory credentials run in one process. This
 * file never calls configureCredentials, and vitest isolates each test file's
 * modules, so the process-wide credentials slot stays unset throughout.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  type CreateAgentSessionOptions,
  type CredentialSource,
  createAgentSession,
  createFileTranscriptStore,
  resumeAgentSession,
} from "#src/index";
import { _clientDeps, type NativeCatalogOverrides } from "#src/native/client";
import {
  collect,
  installScriptedProvider,
  resetScriptedProvider,
  sessionOptions,
  textRound,
  turnEndOf,
} from "#test/helpers/agent-session";

const CREDENTIALS: CredentialSource = { kind: "memory", credentials: { openai: { kind: "api-key", key: "sk-node" } } };

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nax-agent-node-resume-"));
});
afterEach(async () => {
  resetScriptedProvider();
  await rm(dir, { recursive: true, force: true });
});

function nodeOptions(extra: Partial<CreateAgentSessionOptions> = {}): CreateAgentSessionOptions {
  return sessionOptions({ credentials: CREDENTIALS, transcriptStore: createFileTranscriptStore(dir), ...extra });
}

describe("agent session on Node: resume", () => {
  test("resume after a simulated restart reports the interrupted turn and carries history", async () => {
    const provider = installScriptedProvider();
    provider.push(textRound("one"), textRound("two"));
    const first = await createAgentSession(nodeOptions({ sessionId: "node-resume" }));
    await collect(first.send("first"));
    await first.close();
    // The process dies after markTurn(running): the marker stays on disk.
    await createFileTranscriptStore(dir).markTurn("node-resume", { turnId: "t-dead", state: "running" });

    const resumed = await resumeAgentSession("node-resume", nodeOptions());
    expect(resumed.lastTurn).toEqual({ turnId: "t-dead", status: "interrupted" });
    expect((await createFileTranscriptStore(dir).load("node-resume"))?.turn).toEqual({
      turnId: "t-dead",
      state: "ended",
    });
    expect(turnEndOf(await collect(resumed.send("second"))).output).toBe("two");
    expect(provider.requests[1]?.messages).toEqual([
      { role: "user", content: "first" },
      expect.objectContaining({ role: "assistant", content: "one" }),
      { role: "user", content: "second" },
    ]);
    await resumed.close();
  });

  test("resume with a different model is refused", async () => {
    const provider = installScriptedProvider();
    provider.push(textRound("one"));
    const first = await createAgentSession(nodeOptions({ sessionId: "node-model" }));
    await collect(first.send("first"));
    await first.close();
    await expect(resumeAgentSession("node-model", nodeOptions({ model: "openai/gpt-5.4" }))).rejects.toMatchObject({
      code: "AGENT_SESSION_MODEL_MISMATCH",
    });
  });
});

describe("agent session on Node: many sessions in one process", () => {
  test("two sessions with different catalog overrides and memory credentials each build their own client", async () => {
    const provider = installScriptedProvider();
    provider.push(textRound("a"), textRound("b"));
    const scripted = _clientDeps.build;
    const builds: unknown[] = [];
    _clientDeps.build = async (overrides, options) => {
      builds.push(overrides);
      return scripted(overrides, options);
    };
    const proxyA: NativeCatalogOverrides = [{ provider: "proxy-a", models: [] }];
    const proxyB: NativeCatalogOverrides = [{ provider: "proxy-b", models: [] }];
    const a = await createAgentSession(nodeOptions({ catalogOverrides: proxyA }));
    const b = await createAgentSession(nodeOptions({ catalogOverrides: proxyB }));
    expect(turnEndOf(await collect(a.send("hi"))).status).toBe("completed");
    expect(turnEndOf(await collect(b.send("hi"))).status).toBe("completed");
    expect(builds).toEqual([proxyA, proxyB]);
    await a.close();
    await b.close();
  });
});
```

`NativeSessionAdapter` passes its catalog overrides to `_clientDeps.build` unchanged (`native/session-adapter.ts:122`), so `builds` holds the two arrays as given. `models: []` is the smallest valid `ProviderCatalogOverride` (`config/catalog-overrides.ts:89`); the scripted builder never reads it.

- [ ] **Step 2: Run on Node**

Run: `bun x vitest --run test/node/agent-session-resume.test.ts`
Expected: all PASS.

- [ ] **Step 3: Typecheck and lint**

Run: `bun x tsc --noEmit` and `bun run lint`.
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add test/node/agent-session-resume.test.ts
git commit -m "test(nax-agent): Node contract cases for resume and per-session clients"
```

---

### Task 5: The packed-tarball chat smoke (spec §1, §10.1)

**Files:**
- Modify: `packages/nax-agent/test/node/fixtures/packed-smoke.mjs` (insert a new section 4 before `console.log("packed smoke ok")`)
- Modify: `packages/nax-agent/test/node/pack-smoke.test.ts` (consumer typecheck imports)

**Interfaces:**
- Consumes: from the packed `@nathapp/nax-agent`: `createAgentSession`, `resumeAgentSession`, `createMemoryTranscriptStore`. From `@nathapp/nax-agent/internal`: `_clientDeps`, `_agentSessionDeps`.
- Produces: the fixture that RELEASING's post-publish check runs against the registry package (Task 10).

- [ ] **Step 1: Extend the fixture**

1a. In `packed-smoke.mjs`, extend the two import statements to:

```js
import {
  configureCredentials,
  createAgentSession,
  createMemoryTranscriptStore,
  EMPTY_OWNED_PATHS_POLICY,
  globTool,
  NativeSessionAdapter,
  resetSandboxBackend,
  resumeAgentSession,
} from "@nathapp/nax-agent";
import {
  _agentSessionDeps,
  _clientDeps,
  DEFAULT_SANDBOX_CONFIG,
  resolveSessionSandbox,
} from "@nathapp/nax-agent/internal";
```

1b. Insert this section directly before the final `console.log("packed smoke ok");` line, after the Linux sandbox block:

```js
// 4. The S3 chat round-trip (S3 spec §1): a multi-turn session with streamed
//    deltas, one embedder tool approved through answer(), one approval denied
//    by timeout, one cancel, and one resume from the store after a simulated
//    restart. Scripted provider; manual approval timers; memory credentials.
const requests = [];
let rounds = [];
const chatModel = { ...model, id: "chat-stub" };
_clientDeps.build = async () => ({
  model: async () => chatModel,
  listModels: async () => [chatModel],
  pricing: () => chatModel.pricing,
  stream(_model, req) {
    requests.push(req);
    const round = rounds.shift();
    if (round === undefined) throw new Error(`no scripted reply for request ${requests.length}`);
    return (async function* replay() {
      yield* round;
    })();
  },
  complete: async () => {
    throw new Error("round trips must stream");
  },
  validate: () => {},
});
const text = (value) => [
  { type: "text-delta", text: value },
  { type: "usage", usage: { inputTokens: 2, outputTokens: 1 } },
  { type: "done", stopReason: "stop" },
];
const call = (id) => [
  { type: "tool-call", call: { id, name: "lookup", input: { id } } },
  { type: "usage", usage: { inputTokens: 2, outputTokens: 1 } },
  { type: "done", stopReason: "tool_use" },
];

const timers = new Map();
let timerId = 0;
_agentSessionDeps.setTimeout = (fn, ms) => {
  timerId += 1;
  timers.set(timerId, { fn, ms });
  return timerId;
};
_agentSessionDeps.clearTimeout = (id) => {
  timers.delete(id);
};
const fireApprovalTimers = () => {
  for (const [id, timer] of [...timers]) {
    if (timer.ms !== 30_000) continue;
    timers.delete(id);
    timer.fn();
  }
};

const ran = [];
const chatOptions = {
  backend: "native",
  sessionId: "packed-chat",
  model: "stub/chat-stub",
  profile: "none",
  transcriptStore: createMemoryTranscriptStore(),
  credentials: { kind: "memory", credentials: { stub: { kind: "api-key", key: "sk-packed" } } },
  approvalTimeoutMs: 30_000,
  tools: [
    {
      name: "lookup",
      description: "look a record up",
      inputSchema: { type: "object" },
      approval: "always",
      async run(input) {
        ran.push(input);
        return { content: "record" };
      },
    },
  ],
};
const chat = await createAgentSession(chatOptions);

async function turnOf(session, message, onApproval) {
  const events = [];
  for await (const event of session.send(message)) {
    events.push(event);
    if (event.type === "approval_requested") onApproval(session, event);
  }
  return events;
}
const endOf = (events) => events.at(-1);

// Turn 1: approved through answer().
rounds = [call("c1"), text("found it")];
const approved = await turnOf(chat, "find c1", (session, event) => {
  assert.equal(session.answer(event.requestId, { decision: "allow" }), "accepted");
});
assert.ok(approved.some((event) => event.type === "text_delta"), "no streamed delta");
assert.equal(endOf(approved).status, "completed", JSON.stringify(endOf(approved)));
assert.deepEqual(ran, [{ id: "c1" }]);

// Turn 2: the approval is denied by its timeout.
rounds = [call("c2"), text("never mind")];
const timedOut = await turnOf(chat, "find c2", () => fireApprovalTimers());
assert.ok(
  timedOut.some((event) => event.type === "approval_resolved" && event.decidedBy === "timeout"),
  `no timeout: ${JSON.stringify(timedOut.map((event) => event.type))}`,
);
assert.deepEqual(ran, [{ id: "c1" }], "a timed-out approval ran the tool");

// Turn 3: cancelled while the approval waits.
rounds = [call("c3")];
const cancelled = await turnOf(chat, "find c3", (session) => session.cancel("stop"));
assert.equal(endOf(cancelled).status, "cancelled");
await chat.close();

// A restart: the process died after markTurn(running) of a later turn.
await chatOptions.transcriptStore.markTurn("packed-chat", { turnId: "t-dead", state: "running" });
const resumed = await resumeAgentSession("packed-chat", chatOptions);
assert.deepEqual(resumed.lastTurn, { turnId: "t-dead", status: "interrupted" });
rounds = [text("resumed")];
const after = await turnOf(resumed, "still there?", () => {});
assert.equal(endOf(after).output, "resumed");
const history = requests.at(-1).messages;
assert.deepEqual(history[0], { role: "user", content: "find c1" }, "resume lost the history");
await resumed.close();
```

`model` refers to the stub catalog model already defined in section 2 of the same file.

- [ ] **Step 2: Typecheck the facade in the packed consumer**

In `packages/nax-agent/test/node/pack-smoke.test.ts`, in the second test, replace the three `writeFileSync` lines of `index.ts` content with:

```ts
        'import { NativeSessionAdapter, createAgentSession, getAgentRuntime, globTool, nodeRuntime, resumeAgentSession, setAgentRuntime, type SessionEvent } from "@nathapp/nax-agent";',
        'import { _clientDeps } from "@nathapp/nax-agent/internal";',
        "export type Event = SessionEvent;",
        "export const names = [typeof NativeSessionAdapter, typeof createAgentSession, typeof getAgentRuntime, typeof globTool, typeof nodeRuntime, typeof resumeAgentSession, typeof setAgentRuntime, typeof _clientDeps];",
```

Change the first test's name to `"runs one tool round-trip, one native turn, the S3 chat round-trip and (on Linux) one sandboxed command"`.

- [ ] **Step 3: Run the pack smoke**

Run, from `packages/nax-agent`: `bun x vitest --run test/node/pack-smoke.test.ts`
Expected: both tests PASS. The fixture prints `packed smoke ok`.

If the chat section fails, the error names the turn. If it fails because the stub model id or provider is rejected (for example the catalog requires the model to be listed), keep `chatModel` and the `model` string consistent (`stub/chat-stub` against `id: "chat-stub", provider: "stub"`). Do not drop an assertion.

- [ ] **Step 4: Commit**

```bash
git add test/node/fixtures/packed-smoke.mjs test/node/pack-smoke.test.ts
git commit -m "test(nax-agent): packed-tarball S3 chat round-trip smoke"
```

---

### Task 6: The billed live chat smoke fixture and its procedure

**Files:**
- Create: `packages/nax-agent/test/node/fixtures/live-chat-smoke.mjs`
- Modify: `packages/nax-agent/RELEASING.md` (new section before "## Subsequent releases")

**Interfaces:**
- Consumes: from the packed `@nathapp/nax-agent`: `configureCredentials`, `createAgentSession`, `createMemoryTranscriptStore`.
- Produces: the script the controller runs in Task 9. **Do not run it in this task; it is billed.**

- [ ] **Step 1: Write the fixture**

Create `packages/nax-agent/test/node/fixtures/live-chat-smoke.mjs`:

```js
/**
 * S3 acceptance 10.2: a real-provider chat on Node. Two turns and one embedder
 * tool with an approval. BILLED: run only with the maintainer's approval at
 * launch (RELEASING.md, "S3 acceptance"). Runs inside a temporary consumer that
 * installed the packed tarball. Credentials come from nax's global config
 * directory, read the way nax's CLI reads them.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { configureCredentials, createAgentSession, createMemoryTranscriptStore } from "@nathapp/nax-agent";

assert.equal(process.versions.bun, undefined, "the live chat smoke must run on native Node");

const model = process.env.NAX_AGENT_LIVE_MODEL ?? "minimax/MiniMax-M2.7";
const configDir = process.env.NAX_GLOBAL_CONFIG_DIR ?? join(homedir(), ".nax");
// nax's global auth section with its schema defaults, as test/preload.ts reads it.
async function readAuthConfig() {
  const file = join(configDir, "config.json");
  const auth = (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).auth : undefined) ?? {};
  const exec = auth.exec === undefined ? undefined : { ...auth.exec, timeoutMs: auth.exec.timeoutMs ?? 10_000 };
  return { source: auth.source ?? "file", onChange: auth.onChange ?? "warn", ...(exec === undefined ? {} : { exec }) };
}
configureCredentials({ configDir: () => configDir, readAuthConfig });

const runs = [];
const lookupOrder = {
  name: "lookup_order",
  description: "Look up an order by its numeric id. Returns the order's status and carrier.",
  inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
  approval: "always",
  async run(input) {
    runs.push(input);
    return { content: JSON.stringify({ id: input?.id, status: "shipped", carrier: "DHL" }) };
  },
};

const session = await createAgentSession({
  backend: "native",
  model,
  profile: "none",
  transcriptStore: createMemoryTranscriptStore(),
  tools: [lookupOrder],
  instructions: "You are a support assistant. Use the tools you are given when asked. Keep replies short.",
  turnTimeoutSeconds: 300,
});

async function turn(message) {
  const events = [];
  for await (const event of session.send(message)) {
    events.push(event);
    if (event.type === "approval_requested") {
      console.log(`approval_requested: ${event.tool} ${event.summary}`);
      assert.equal(session.answer(event.requestId, { decision: "allow" }), "accepted");
    }
  }
  const end = events.at(-1);
  console.log(`turn_end ${end.status} $${end.costUsd.toFixed(4)} ${JSON.stringify(end.output).slice(0, 200)}`);
  return events;
}

const first = await turn("Please look up order 42 with the lookup_order tool and tell me its status.");
const firstEnd = first.at(-1);
assert.equal(firstEnd.type, "turn_end");
assert.equal(firstEnd.status, "completed", JSON.stringify(firstEnd.error));
assert.ok(
  first.some((event) => event.type === "text_delta"),
  "no streamed text_delta",
);
assert.ok(
  first.some((event) => event.type === "approval_resolved" && event.decision === "allow" && event.decidedBy === "human"),
  "the approval was not answered by a human",
);
assert.ok(runs.length >= 1, "the embedder tool never ran");
assert.ok(
  first.some((event) => event.type === "tool_result" && !event.isError),
  "no successful tool_result",
);

const second = await turn("Which carrier is shipping it? Answer from what you already found.");
const secondEnd = second.at(-1);
assert.equal(secondEnd.status, "completed", JSON.stringify(secondEnd.error));
assert.match(secondEnd.output, /dhl/i, "the second turn did not recall the tool result");

await session.close();
const total = firstEnd.costUsd + secondEnd.costUsd;
console.log(`live chat smoke ok (model ${model}, $${total.toFixed(4)})`);
```

- [ ] **Step 2: Syntax-check it without running it**

Run: `node --check test/node/fixtures/live-chat-smoke.mjs`, then `bun run lint:fix` and `bun run lint`.
Expected: no output from `node --check`, and lint PASS. `node --check` only parses the file; it does not execute it, so it makes no provider call.

- [ ] **Step 3: Document the procedure**

In `packages/nax-agent/RELEASING.md`, insert this section directly before `## Subsequent releases`:

````markdown
## S3 acceptance (0.2.0)

S3 is complete when the three checks of the S3 spec §10 pass on the release
candidate, the feature PR's merged `main` commit. Both real-provider runs are
billed and need explicit approval **at launch**.

1. **Packed chat smoke, stub provider.** CI's Node 22/24 contract job runs
   `test/node/pack-smoke.test.ts`, which now includes the S3 chat round-trip.
   Green CI on the release candidate is the evidence.
2. **Real-provider chat smoke on Node.** From `packages/nax-agent`:

   ```sh
   rtk bun run build && rtk bun run stage-publish
   PACK=$(mktemp -d) && CONSUMER=$(mktemp -d)
   rtk npm pack ./.publish/ --pack-destination "$PACK"
   cd "$CONSUMER" && npm init -y >/dev/null
   npm install --no-audit --no-fund "$PACK"/nathapp-nax-agent-*.tgz
   cp <repo>/packages/nax-agent/test/node/fixtures/live-chat-smoke.mjs .
   node live-chat-smoke.mjs
   ```

   The script reads provider credentials from `~/.nax` (override with
   `NAX_GLOBAL_CONFIG_DIR`). Its model defaults to `minimax/MiniMax-M2.7`;
   override it with `NAX_AGENT_LIVE_MODEL`. It must print `live chat smoke ok`.
   Record the model, the cost line and the commit.
3. **`nax run` unchanged.** The billed S1-recipe smoke (see "Prepare the first
   release" above) on a fresh fixture copy at the release candidate: same story
   outcome, tool-audit keys and per-tool record shapes, cost-row schema, and a
   `run.start` `naxCommit` equal to the candidate.
````

- [ ] **Step 4: Commit**

```bash
git add test/node/fixtures/live-chat-smoke.mjs RELEASING.md
git commit -m "test(nax-agent): billed live chat smoke fixture and S3 acceptance procedure"
```

---

### Task 7: README, CHANGELOG and spec amendments

**Files:**
- Modify: `packages/nax-agent/README.md`
- Modify: `packages/nax-agent/CHANGELOG.md`
- Modify: `docs/superpowers/specs/2026-10-03-s3-conversational-session-api-design.md`

**Interfaces:**
- Consumes: Tasks 1-6 as built.
- Produces: documentation only.

- [ ] **Step 1: README**

In `packages/nax-agent/README.md`:

1a. Replace the line starting `> **Pre-1.0, not yet published.**` with:

```markdown
> **Pre-1.0.** Until `1.0` the API of `.` may change in any minor release. Pin an exact version.
```

1b. Insert this section directly before `## Status and roadmap`:

````markdown
## Conversational sessions

`createAgentSession` gives an embedder (for example a long-running Node service) a multi-turn chat with a person in the loop. Events stream, tools come from the embedder, history lives in a store the embedder supplies, and a turn can be cancelled or answered with an approval.

```ts
import { createAgentSession, createFileTranscriptStore, type EmbedderTool } from "@nathapp/nax-agent";

const lookupOrder: EmbedderTool = {
  name: "lookup_order",
  description: "Look up an order by id.",
  inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
  approval: "always", // ask the person before every run
  async run(input, { signal }) {
    return { content: JSON.stringify(await orders.get(input, { signal })) };
  },
};

const session = await createAgentSession({
  backend: "native",
  sessionId: "ticket-1234",
  model: "anthropic/claude-sonnet-5-5",
  profile: "none", // "none" | "read" | "full"
  instructions: "You are a support assistant.",
  tools: [lookupOrder],
  transcriptStore: createFileTranscriptStore("/var/lib/my-app/sessions"),
  credentials: { kind: "memory", credentials: { anthropic: { kind: "api-key", key: process.env.ANTHROPIC_API_KEY! } } },
});

for await (const event of session.send("Where is order 42?")) {
  if (event.type === "text_delta") process.stdout.write(event.text);
  if (event.type === "approval_requested") showApproval(event); // later: session.answer(event.requestId, { decision: "allow" })
  if (event.type === "turn_end") console.log(event.status, event.costUsd);
}
await session.close();
```

- **One turn at a time.** `send()` claims the session's turn slot at once. A second `send()` while a turn runs throws `AGENT_SESSION_BUSY`. The returned iterable is single-use, and the turn starts on its first `next()`. Breaking out of the loop cancels the turn.
- **Events.** `turn_start`, `text_delta`, `thinking_delta`, `stream_reset`, `tool_call`, `tool_result`, `approval_requested`, `approval_resolved`, `question`, `usage`, `compaction` and `turn_end`. In 0.2.0 sessions do not compact, so `compaction` is not emitted and a conversation that outgrows the model's context window ends `errored`. Each carries `sessionId`, `turnId`, `at` and your `metadata`. `turn_end` is always last, and a failed turn arrives as `turn_end`, never as a throw.
- **Deltas are provisional.** `stream_reset` means the deltas of that round so far are void: the provider call was retried after a transient fault (up to 3 attempts; a rate-limit retry waits the provider's `retryAfter` silently, and `cancel()` ends the wait). `turn_end.output` and the stored transcript are authoritative. While your consumer lags, adjacent deltas are merged; control events are never merged or dropped.
- **Approvals and questions.** Answer them with `session.answer(requestId, { decision: "allow" | "deny" })` or `{ text }`. An unanswered one is denied after `approvalTimeoutMs` (default 600000, range 30000..3600000). `answer` returns `"accepted"`, `"expired"`, `"cancelled"` or `"unknown"`.
- **Profiles.** `none` gives your tools, a private scratchpad and `ask_human`. `read` adds Read, Glob, Grep and read-only Git over `workdir`. `full` adds writes and Bash, under the OS sandbox and `bashApproval` (default `"gated"`: every command is put to the person).
- **Credentials.** A session's `credentials` (`memory` or `exec`) and `catalogOverrides` give it its own client. Without them it uses the process-wide `configureCredentials` slot.
- **History and restarts.** The store holds one document per session, saved at the end of every turn. `close()` keeps it. After a restart, `resumeAgentSession(sessionId, options)` reopens it with the same options you created it with; pass `instructions` and `tools` again, since they are not stored. If the process died mid-turn, `session.lastTurn` is `{ turnId, status: "interrupted" }`, and that turn's message is not in history. A resume with a different model throws `AGENT_SESSION_MODEL_MISMATCH`; a different reasoning effort (`[high]`) is the same model. Do not open one session id twice at once: the store has no lock.
- **Errors.** Every error is an `AgentSessionError` with a code `AGENT_SESSION_*`: `INVALID_OPTIONS`, `EXISTS`, `BUSY`, `CLOSED`, `INVALID_ANSWER`, `NOT_FOUND`, `SCHEMA_UNSUPPORTED`, `MODEL_MISMATCH`, `SANDBOX_UNAVAILABLE` or `TOOL_NAME_RESERVED`. A stored document that cannot be read is a `NaxError` with `TRANSCRIPT_CORRUPT`.
````

1c. Replace the `## Status and roadmap` paragraph (the one sentence under the heading) with:

```markdown
`0.x` may reshape `.` with a minor bump. An ACP backend for the same session API is planned. See [`CHANGELOG.md`](CHANGELOG.md).
```

- [ ] **Step 2: CHANGELOG**

In `packages/nax-agent/CHANGELOG.md`, replace from the `## [Unreleased]` heading line itself up to, but not including, the `## [0.1.0] - 2026-10-03` line, with the block below. The block starts with its own `## [Unreleased]` heading; the file must end up with exactly one.

```markdown
## [Unreleased]

The conversational session API for embedders. nax behaviour unchanged.

### Added

- `createAgentSession` and `resumeAgentSession`: a multi-turn session with streamed `SessionEvent`s, embedder tools (`EmbedderTool`, approval `"never" | "always"`), approvals and questions answered with `session.answer()`, `cancel()`, `close()`, and the `none` / `read` / `full` tool profiles. Types: `AgentSession`, `CreateAgentSessionOptions`, `AgentSessionHostPorts`, `AgentSessionProfile`, `EmbedderToolContext`, `EmbedderToolResult`, `SessionEvent`, `SessionEventBase`, `SessionEventBody`, `TurnEndStatus`, `ApprovalDecidedBy`, `AnswerReply`, `AnswerStatus`. Errors: `AgentSessionError` with `AgentSessionErrorCode` (`AGENT_SESSION_*`).
- `resumeAgentSession` reopens a stored session after a restart; a turn the dead process left running is reported as `lastTurn.status: "interrupted"`.
- Facade sessions retry a transient provider fault after text has streamed (3 attempts) and emit `stream_reset` for the voided deltas.
- The `TranscriptStore` port: `TranscriptDoc`, `TurnMarker`, `createFileTranscriptStore`, `createMemoryTranscriptStore` (`MemoryTranscriptStore`). `OpenSessionOpts` gains `transcriptStore`, `retainOnClose` and `systemPrompt`.
- Native model calls stream. `SendTurnOpts.onTurnEvent` receives `TurnEvent`s (`TurnEventSink`): text and thinking deltas, `stream_reset`, `tool_call`, `tool_result`, per-call `usage` and `compaction`. Payloads are redacted and byte-capped.
- Per-session credential sources (`CredentialSource`: `memory`, `exec`) and adapter-owned clients (`NativeSessionAdapterOptions`); `AuthStamp.source` may be `memory`.
- The loop-handler and loop-event types are public on `.`: `LoopHandlerSet`, `LoopHandlerEntry`, `LoopHandlerContext`, `LoopEvent`, `LoopEventMap`, `PayloadOf`, `PatchOf`, `ExternalHandlerOf`, `CompleteCallOptions` and the `Before*` / `After*` / `TransformContext*` payload, patch and outcome types. So are the command-interceptor types `CommandInterceptor`, `InterceptRequest`, `InterceptResult`, `ShellInterceptRequest` and `ShellInterceptResult`.
- The `OwnedPathsPolicy` host port with `EMPTY_OWNED_PATHS_POLICY` and `OwnedBashCandidate`: which paths the host owns the writes to, and how its refusals read. nax supplies its own policy; an embedder that injects nothing gets the empty policy.

### Changed

- `resolveWithin` gains a required third parameter (`ownedPaths`). `SandboxPolicyInput` gains `ownedPaths` (required) and `projectStateDir` (optional), and `buildSandboxPolicy` follows.
- Three `ProtectedPathsPolicy` fields (`projectStateDir`, `credentialDir`, `trustStoreFile`) become optional; the sandbox skips the absent ones.
- `Read`, `Glob` and `Grep` refuse a symlink-resolved host credential directory or trust-store file when the workdir contains it, regardless of grant.
- `./internal` (outside semver): the module-scope native session maps are replaced by a per-adapter `NativeSessionState`.
```

Then verify the result. Run these from `packages/nax-agent`. The first check guards the release helper, which throws "Ambiguous changelog notes" on a second `[Unreleased]`. The second compares only the `[.]` sections of the 0.1.0 and current API snapshots, so `./internal` names never enter the changelog:

```sh
grep -c '^## \[Unreleased\]' CHANGELOG.md   # must print 1
sect() { git show "$1":packages/nax-agent/api/nax-agent.api.txt | awk '/^\[\.\/internal\]/{exit} /^\[\.\]/{on=1;next} on&&NF{sub(/^type /,"");print}' | sort; }
for name in $(comm -13 <(sect nax-agent-v0.1.0) <(sect HEAD)); do
  grep -q "$name" CHANGELOG.md || echo "missing from CHANGELOG: $name"
done
```

Run the second check after Task 1's snapshot commit, so `HEAD` includes `resumeAgentSession`. Expected output: only `Before*`, `After*` and `TransformContext*` names, which the wildcard sentence covers. For any other name it prints, add it to the matching bullet.

- [ ] **Step 3: Spec amendments**

In `docs/superpowers/specs/2026-10-03-s3-conversational-session-api-design.md`:

3a. Directly after the `**resumeAgentSession:**` bullet list in §4.2 (the bullet ending `Opens the S1 session with \`resume: true\`.`), add:

```markdown
- **As built (S3-5):** the session id is the argument. `options.sessionId`, if set, must equal it, or the call
  throws `AGENT_SESSION_INVALID_OPTIONS` before the store is read. Every check runs before any backend opens.
  The model comparison uses the loop's identity rule (`transcriptModelIdentity`), so a different `[effort]` suffix
  is the same model. A document with no recorded model (a marker-only document from a first turn that failed
  before the loop saved) resumes. A document whose `messages` is not an array throws `TRANSCRIPT_CORRUPT`. On
  resume, `lastTurn` is set only for an interrupted turn; an `ended` marker records no status, so `lastTurn` stays
  undefined. Instructions, tools and profile are not stored; the caller passes them again. The store has no lock:
  resuming an id that another live session (in this or another process) holds mid-turn ends that turn's
  `running` marker and reports a false `interrupted`. The embedder must not open one session id twice at once.
```

3b. At the end of §5.3, add:

```markdown
**As built (S3-5).** Facade sessions set `transportRetry` to nax's default (`maxAttempts: 3`, `baseDelayMs: 2000`).
Without it a facade session never retried a fault after the first event, and `stream_reset` was unreachable.
A `rate-limit` retry waits the provider's `retryAfter` with no event, up to the turn's remaining budget; `cancel()`
ends the wait. Facade sessions enable no compaction in 0.2.0 (`assemble` passes no `compaction`), so the
`compaction` event is not emitted and a conversation that outgrows the context window ends `errored`.
```

3c. At the end of §6.4, add:

```markdown
**As built (S3-5).** The session is opened first and the marker ended second. If `markTurn(ended)` throws, the
opened session is closed (its private root removed) and the store's error is rethrown.
```

- [ ] **Step 4: Check and commit**

Run, from `packages/nax-agent`: `bun run lint`.
Expected: PASS. Biome does not lint Markdown; this checks that nothing else changed.

```bash
git add README.md CHANGELOG.md ../../docs/superpowers/specs/2026-10-03-s3-conversational-session-api-design.md
git commit -m "docs(nax-agent): session API README, 0.2.0 changelog, S3-5 spec amendments"
```

---

### Task 8: Verification, whole-branch review and PR (controller)

**Files:** none new.

- [ ] **Step 1: Repo-root gates**

From the repo root, run each command below. Expected: all PASS.
- `rtk bun run typecheck`
- `rtk bun run check:all`
- `rtk bun run test`
- `rtk bun run build`

- [ ] **Step 2: Package gates**

From `packages/nax-agent`, run each command below. Expected: all PASS.
- `bun run check:api`
- `bun run test:coverage` (80% overall and per file, with an empty baseline)
- `bun run test:node`
- `bun ../repo-tooling/scripts/check-complexity.ts --package=.`

Record the unit, integration and Node counts and the coverage numbers for the PR body.

- [ ] **Step 3: nax unchanged**

From the repo root:
- `git diff --exit-code origin/main -- packages/nax/`. Expected: exit 0, no output.
- `git diff --name-only origin/main...HEAD -- packages/nax-agent/src`. Expected: exactly `src/index.ts`, `src/session/agent-session.ts`, `src/session/agent-session-resume.ts` and `src/session/agent-session-types.ts`, with nothing under `src/native/`.

- [ ] **Step 4: Whole-branch review**

Dispatch one fresh reviewer over `git diff origin/main...HEAD`. Give it this plan's Review Focus as the checklist, plus the spec sections listed in the header. Fix Critical and Important findings, with at most 2 fix rounds, then a scoped re-review.

- [ ] **Step 5: Push and open the PR (controller)**

Push `feat/s3-5-resume` and open a PR titled `feat(nax-agent): S3-5 resumeAgentSession, Node contract, packed chat smoke, 0.2.0 docs`. The body covers:
- spec row S3-5;
- what is left for after merge (Tasks 9-10, approval-gated);
- the verification counts;
- "nax behaviour unchanged".

Merge only after CI is green, including the Node 22/24 contract job and the packed smoke. Merging is the maintainer's call.

---

### Task 9: S3 acceptance (controller, billed, approval at launch)

Run on the merged `main` commit (the release candidate), following `RELEASING.md`, "S3 acceptance".

- [ ] **Step 1: §10.1.** Confirm the CI run for the merge commit is green, including Node 22 and 24 contract and packed smoke. Record the run URL.
- [ ] **Step 2: §10.2, billed.** Ask the maintainer for approval, naming the model (default `minimax/MiniMax-M2.7`) and the expected cost (a few cents; the script has no cost cap, but each turn is bounded by `turnTimeoutSeconds: 300` and the spin breaker, and a missing credential fails before any billed call). On approval, run the live chat smoke exactly as `RELEASING.md` describes. Record the model, cost and output. A failed assertion is a finding: report it with the output, and do not re-run with a loosened script.
- [ ] **Step 3: §10.3, billed.** Ask the maintainer for approval. S3-5 changes no nax code path, and S3-3's smoke passed at `ef9e80e81`, but S3-4's backend changes (`systemPrompt`, bounded redaction) had no billed smoke, so this run covers them. The maintainer may waive it explicitly. On approval, run the S1-recipe smoke on a fresh fixture copy as in the S3-3 acceptance (trust the copy with `nax trust add <dir> --yes`, reuse the S1 clamp-helper PRD with statuses reset, no `nax plan`, `nax run -f s1-smoke -a native --headless --max-cost 2` using the local build at the candidate). Compare the tool-audit and cost-row shapes against S3-3's recorded evidence.

---

### Task 10: Release 0.2.0 (maintainer-run, approval at each gate)

The release helper asks for confirmation on a TTY, and an agent shell has none: `confirm()` resolves false on EOF, so the helper aborts. **The maintainer runs `release minor` and `release tag` in their own terminal** (or with the `!` prefix in the Claude Code prompt). Nobody pipes an answer (`yes |`) into it; that would defeat the approval gate. The controller prepares, checks and verifies around those two commands.

- [ ] **Step 1: Prepare.** After Task 9 passes, ask the maintainer for approval of the concrete `0.2.0` release. On clean, up-to-date `main`, from `packages/nax-agent`, the maintainer runs:

```sh
bun run release --dry-run minor
bun run release minor
```

Expected:
- The dry run prints version `0.2.0`, tag `nax-agent-v0.2.0`, the branch and dist-tag `latest`. It does not touch the changelog; the date appears only in the release PR.
- The real run dates the `[Unreleased]` section and opens the release-preparation PR. If it throws "Ambiguous changelog notes", Task 7's single-heading check was skipped: fix `CHANGELOG.md` on `main` first.

Review the PR (version bump, dated changelog, lockfile) and merge it on green CI.

- [ ] **Step 2: Tag.** Ask the maintainer for separate approval of the tag push. First confirm the tag will land on the merged release commit:

```sh
git checkout main && git pull --ff-only origin main
git log -1 --oneline                                # the release PR's merge
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" && echo head-ok
(cd packages/nax-agent && node -p "require('./package.json').version")   # must print 0.2.0
git status --short                                  # must be empty
```

Then, from `packages/nax-agent`, the maintainer runs:

```sh
bun run release --dry-run tag
bun run release tag
```

This pushes `nax-agent-v0.2.0`. The `release.yml` workflow reruns the gates, publishes `.publish/` with OIDC and provenance, and creates the GitHub prerelease. Watch the run to completion.

**If the workflow fails after the npm upload** (for example while extracting notes or creating the GitHub release), do not re-run it: a re-run tries to publish `0.2.0` again, and only `0.1.0` tolerates an existing version. Check `npm view @nathapp/nax-agent@0.2.0 version` first. If the version is live, create the GitHub prerelease by hand (`gh release create nax-agent-v0.2.0 --prerelease --notes-file <the 0.2.0 changelog section>`) and record the failure.

- [ ] **Step 3: Verify the publish.**
- `rtk npm view @nathapp/nax-agent@0.2.0 version dist.integrity` and `rtk npm view @nathapp/nax-agent dist-tags --json`. Expected: `latest` is `0.2.0`.
- `rtk npm view @nathapp/nax-agent@0.2.0 dist.attestations --json`. Expected: a provenance attestation (`predicateType` `https://slsa.dev/provenance/v1`). This is the first OIDC publish (RELEASING, "Subsequent releases").
- Install `@nathapp/nax-agent@0.2.0` into a fresh temporary Node project and run `npm audit signatures`. Expected: it reports verified registry signatures and verified attestations, including for `@nathapp/nax-agent`.
- Copy `test/node/fixtures/packed-smoke.mjs` into that project and run it on Node 22 and on Node 24: `npx -y -p node@22 node packed-smoke.mjs` and `npx -y -p node@24 node packed-smoke.mjs`. Expected: `packed smoke ok` on both. The installed package contains dist and documentation only.

- [ ] **Step 4: Record.** In the maintainer's workspace master plan (`projects/nax/nax-agent-master-plan.md`, row S3), record:
- the release URL, tagged commit, registry integrity and provenance result;
- the three acceptance results.

Mark S3 complete there and in memory. S4 (acpx backend) is next.
