# S3-1 — `TranscriptStore` port — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a native session keep its history in an embedder-supplied `TranscriptStore` instead of a hard-wired transcript directory, while nax's transcript files, close behaviour and identity rules stay byte-for-byte as they are today.

**Architecture:** A new port (`TranscriptStore`, `TranscriptDoc`, `TurnMarker`) sits between the native turn loop and storage. Today's file code becomes `createFileTranscriptStore(dir)`, and `OpenSessionOpts.transcriptDir` stays as the shorthand that builds it. The owner/model identity rules move out of the file reader into one loop-side function, `historyFromTranscript`, applied to whatever document a store returns. A memory store ships for tests and simple embedders. `OpenSessionOpts.retainOnClose` makes close leave the live document in place, for the facade (S3-4). nax sets none of the new fields.

**Tech Stack:** TypeScript 7.0.2, Bun 1.4 (bun:test), vitest on Node 22/24 for the Node contract suite, `@nathapp/nax-ai@0.1.16`.

**Spec:** `docs/superpowers/specs/2026-10-03-s3-conversational-session-api-design.md` (§5.5, §9 row S3-1, §8).

**Base:** `main` @ `afdad22d9` (S3-0 merged, #2342). Branch `feat/s3-1-transcript-store`. One PR.

## Global Constraints

- nax-visible behaviour unchanged: transcript file names, bytes and key order, the `.transcript.failed-<stamp>.json` rename, the prune to 50, `TRANSCRIPT_CORRUPT`, the legacy bare-array read, and the owner/model mismatch rules are identical for nax.
- nax-written documents carry no `schemaVersion` and no `turn`.
- `OpenSessionOpts.transcriptDir` stays the shorthand that builds the file store. `pruneRetainedTranscripts(dir)` stays exported on `.` (`nax/src/session/transcript-sweep.ts` uses it).
- nax-agent ships zero Bun APIs (`check:no-bun-apis`); `node:` built-ins only in `src/`.
- Imports inside nax-agent use `#src/*` aliases and `.ts` specifiers, as the surrounding code does.
- Every thrown error is a `NaxError` (`check-nax-error`).
- No `_` names on `.`; `/internal` is unstable. Run `bun run check:api` and `bun run api:update` when a surface changes.
- nax-agent coverage: 80% overall and per file, empty baseline (`bun run test:coverage`).
- Never run bare `bun test`. Run package scripts from the package directory (`cd packages/nax-agent`, `cd packages/nax`).
- No emojis in code or comments. Source files stay under 600 lines and test files under 800 (`check-file-sizes`); functions stay under the complexity gate.
- Conventional commit messages (`refactor:`, `feat:`, `test:`).

## Review Focus

1. **A session opened with both `transcriptDir` and `transcriptStore`.** A silent precedence would write history to whichever one the reader did not expect. Expected: open refuses with `NATIVE_TRANSCRIPT_SOURCE_CONFLICT`. Pinned in Task 5.
2. **A document with a `schemaVersion` this build does not know** (written by a newer nax-agent and read by an older one). Expected: the turn fails with `TRANSCRIPT_SCHEMA_UNSUPPORTED`, the same direction as `TRANSCRIPT_CORRUPT`, and does not silently start a new conversation or replay a shape it cannot read. Pinned in Task 2.
3. **`markTurn` before the session's first save.** No document exists yet, and a kill mid-turn must still leave a `running` marker for resume to find. Expected: `markTurn` creates a document with empty history and the marker. Pinned in Tasks 3 and 4.
4. **A transcript file that is valid JSON but not an object or array** (`null`, `42`, `"x"`). Today the reader crashes with a `TypeError` on `null.owner`. Expected: `TRANSCRIPT_CORRUPT`, like any other unreadable file. Pinned in Task 3.
5. **The memory store handing out its own objects.** A caller mutating a loaded document, or the array it saved, would silently rewrite stored history. Expected: `load`, `save` and `retained` copy. Pinned in Task 4.

## Deviations from the spec (decided while planning)

- **`retainFailed(sessionId)` takes no document.** The spec writes `retainFailed(sessionId, doc)`. The only caller, `closeNativeSession`, has no document in hand. Loading one just to pass it back would add a read to every failed close. It would also turn a corrupt transcript, which today's rename moves aside without complaint, into a `TRANSCRIPT_CORRUPT` thrown from close. So the store moves its own live document aside. For the file store that is today's rename followed by today's prune.
- **`markTurn` never writes `schemaVersion`.** The spec says absent means 1, so a marker document leaves it absent too. That keeps one rule, "nax-agent never writes the field in S3-1", and leaves the decision on whether facade saves stamp it to S3-4.
- **`loadTranscript` / `saveTranscript` / `retainTranscript` / `deleteTranscript` stay** as file-level helpers on `/internal`, rewritten over the file store and the identity function. About 190 test call sites across both packages use them as fixtures. Removing them is not part of a behaviour-neutral port.
- **A state seeded only with `transcriptDirs` still resolves to a file store** (`sessionTranscriptFor`). Tests in both packages seed the map directly instead of calling `openNativeSession`. `openNativeSession` always records a `transcripts` entry, so production never takes the fallback.

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `packages/nax-agent/src/native/session/transcript-types.ts` | Create | The port: `TranscriptStore`, `TranscriptDoc`, `TurnMarker`. Types only. |
| `packages/nax-agent/src/native/session/transcript-identity.ts` | Create | `TranscriptIdentity`, `transcriptModelIdentity` (moved), `historyFromTranscript`, `transcriptDocFor`. |
| `packages/nax-agent/src/native/session/transcript-store.ts` | Modify | File store: `readTranscriptDoc`, `createFileTranscriptStore`; the existing helpers rewritten over it. |
| `packages/nax-agent/src/native/session/memory-transcript-store.ts` | Create | `createMemoryTranscriptStore`. |
| `packages/nax-agent/src/session/session-types.ts` | Modify | `OpenSessionOpts.transcriptStore`, `OpenSessionOpts.retainOnClose`. |
| `packages/nax-agent/src/native/session/session.ts` | Modify | `transcripts` collection, `sessionTranscriptFor`, open validation, close honours `retainOnClose`. |
| `packages/nax-agent/src/native/session/turn-loop.ts` | Modify | Load and save through the session's store. |
| `packages/nax-agent/src/native/index.ts`, `src/index.ts` | Modify | Export the port types and both factories on `.`. |
| `packages/nax-agent/api/nax-agent.api.txt` | Regenerate | `bun run api:update`. |
| Tests | Create/Modify | `test/unit/native/session/transcript-identity.test.ts` (new), `test/unit/native/session/memory-transcript-store.test.ts` (new), `test/unit/native/transcript-store.test.ts`, `test/unit/native/session/session-state.test.ts`, `test/unit/native/session-adapter.test.ts`, `test/unit/native/session/turn-loop-transcript-store.test.ts` (new), `test/node/transcript-store.test.ts` (new). |

---

### Task 1: Pin today's transcript bytes (characterization)

These tests pass on `main` before any change. They are the byte-identity contract that every later task must keep green.

**Files:**
- Modify: `packages/nax-agent/test/unit/native/transcript-store.test.ts` (add one `describe` at the end)

**Interfaces:**
- Consumes: `saveTranscript`, `transcriptPath`, `retainTranscript` from `#src/native/session/transcript-store` (existing).
- Produces: nothing new. Later tasks must keep these green unchanged.

- [ ] **Step 1: Add the golden-bytes tests**

Append to `test/unit/native/transcript-store.test.ts` (it already imports `readFile`, `readdir`, `saveTranscript`, `transcriptPath`, `retainTranscript`, and has `dir` and `msgs`):

```ts
describe("transcript file bytes (S3-1 byte-identity contract)", () => {
  const SAVED_AT = /"savedAt": "\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z"/;

  test("an owned, model-stamped save writes owner, model, savedAt, messages in that order, 2-space JSON", async () => {
    await saveTranscript(dir, "sess-bytes", msgs, { owner: "call-1", model: "anthropic/claude-x" });
    const raw = await readFile(transcriptPath(dir, "sess-bytes"), "utf8");
    expect(raw).toMatch(SAVED_AT);
    const expected = JSON.stringify(
      { owner: "call-1", model: "anthropic/claude-x", savedAt: "<T>", messages: msgs },
      null,
      2,
    );
    expect(raw.replace(SAVED_AT, '"savedAt": "<T>"')).toBe(expected);
  });

  test("an identity-less save writes only savedAt and messages, never schemaVersion or turn", async () => {
    await saveTranscript(dir, "sess-bare", msgs);
    const raw = await readFile(transcriptPath(dir, "sess-bare"), "utf8");
    expect(raw.replace(SAVED_AT, '"savedAt": "<T>"')).toBe(JSON.stringify({ savedAt: "<T>", messages: msgs }, null, 2));
    expect(raw).not.toContain("schemaVersion");
    expect(raw).not.toContain('"turn"');
  });

  test("retain renames to <name>.transcript.failed-<stamp>.json without touching the bytes", async () => {
    await saveTranscript(dir, "sess-keep", msgs, { owner: "o" });
    const before = await readFile(transcriptPath(dir, "sess-keep"), "utf8");
    await retainTranscript(dir, "sess-keep");
    const names = await readdir(dir);
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^sess-keep\.transcript\.failed-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.json$/);
    expect(await readFile(join(dir, names[0] ?? ""), "utf8")).toBe(before);
  });
});
```

- [ ] **Step 2: Run them; they must PASS on the unchanged code**

Run: `cd packages/nax-agent && bun test ./test/unit/native/transcript-store.test.ts --timeout=60000`
Expected: PASS (all tests, including the three new ones). If one fails, the test is wrong about today's behaviour. Fix the test, not the source.

- [ ] **Step 3: Commit**

```bash
git add packages/nax-agent/test/unit/native/transcript-store.test.ts
git commit -m "test(nax-agent): pin native transcript file bytes before the S3-1 port"
```

---

### Task 2: Port types and the loop-side identity function

**Files:**
- Create: `packages/nax-agent/src/native/session/transcript-types.ts`
- Create: `packages/nax-agent/src/native/session/transcript-identity.ts`
- Test: `packages/nax-agent/test/unit/native/session/transcript-identity.test.ts` (new)

**Interfaces:**
- Consumes: `parseModelSpec` from `../models.ts`; `getLogger`, `NaxError` from `#src/infra/index`.
- Produces:
  - `interface TurnMarker { readonly turnId: string; readonly state: "running" | "ended" }`
  - `interface TranscriptDoc { readonly schemaVersion?: 1; readonly owner?: string; readonly model?: string; readonly savedAt: string; readonly messages: readonly ConversationMessage[]; readonly turn?: TurnMarker }`
  - `interface TranscriptStore { load(sessionId: string): Promise<TranscriptDoc | null>; save(sessionId: string, doc: TranscriptDoc): Promise<void>; retainFailed(sessionId: string): Promise<void>; delete(sessionId: string): Promise<void>; markTurn(sessionId: string, marker: TurnMarker): Promise<void> }`
  - `interface TranscriptIdentity { readonly owner?: string; readonly model?: string }` (moved, unchanged)
  - `transcriptModelIdentity(rawModel: string | undefined): string | undefined` (moved, unchanged)
  - `historyFromTranscript(doc: TranscriptDoc | null, identity: TranscriptIdentity, sessionName: string): readonly ConversationMessage[]`
  - `transcriptDocFor(messages: readonly ConversationMessage[], identity: TranscriptIdentity): TranscriptDoc`

- [ ] **Step 1: Write the failing tests**

Create `test/unit/native/session/transcript-identity.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { ConversationMessage } from "@nathapp/nax-ai";
import { historyFromTranscript, transcriptDocFor } from "#src/native/session/transcript-identity";
import type { TranscriptDoc } from "#src/native/session/transcript-types";
import { assertNaxError } from "#test/helpers/index";

const msgs: ConversationMessage[] = [{ role: "user", content: "hello" }];
const doc = (fields: Partial<TranscriptDoc> = {}): TranscriptDoc => ({ savedAt: "t", messages: msgs, ...fields });

describe("historyFromTranscript", () => {
  test("no document is a new conversation", () => {
    expect(historyFromTranscript(null, { owner: "o" }, "s")).toEqual([]);
  });

  test("an owner mismatch reads as empty history", () => {
    expect(historyFromTranscript(doc({ owner: "a" }), { owner: "b" }, "s")).toEqual([]);
  });

  test("an owned reader drops an owner-less document (the legacy rule)", () => {
    expect(historyFromTranscript(doc(), { owner: "b" }, "s")).toEqual([]);
  });

  test("an owner-less reader reads an owned document", () => {
    expect(historyFromTranscript(doc({ owner: "a" }), {}, "s")).toEqual(msgs);
  });

  test("a recorded different model reads as empty history", () => {
    expect(historyFromTranscript(doc({ model: "p/m1" }), { model: "p/m2" }, "s")).toEqual([]);
  });

  test("a document with no recorded model reads for any model", () => {
    expect(historyFromTranscript(doc(), { model: "p/m2" }, "s")).toEqual(msgs);
  });

  test("schemaVersion 1 and an absent schemaVersion both read", () => {
    expect(historyFromTranscript(doc({ schemaVersion: 1 }), {}, "s")).toEqual(msgs);
    expect(historyFromTranscript(doc(), {}, "s")).toEqual(msgs);
  });

  test("an unknown schemaVersion fails loudly rather than starting over", () => {
    const future = { ...doc(), schemaVersion: 2 } as unknown as TranscriptDoc;
    let caught: unknown;
    try {
      historyFromTranscript(future, {}, "s");
    } catch (err) {
      caught = err;
    }
    assertNaxError(caught);
    expect(caught.code).toBe("TRANSCRIPT_SCHEMA_UNSUPPORTED");
  });

  test("the turn marker does not affect history", () => {
    expect(historyFromTranscript(doc({ turn: { turnId: "t1", state: "running" } }), {}, "s")).toEqual(msgs);
  });
});

describe("transcriptDocFor", () => {
  test("writes owner, model, savedAt, messages in that order and copies the array", () => {
    const out = transcriptDocFor(msgs, { owner: "o", model: "p/m" });
    expect(Object.keys(out)).toEqual(["owner", "model", "savedAt", "messages"]);
    expect(out.messages).toEqual(msgs);
    expect(out.messages).not.toBe(msgs);
  });

  test("omits undefined identity fields and never writes schemaVersion or turn", () => {
    expect(Object.keys(transcriptDocFor(msgs, {}))).toEqual(["savedAt", "messages"]);
  });
});
```

`assertNaxError(value)` (`test/helpers/assert-nax-error.ts`) narrows `caught` to `NaxError`, so `.code` typechecks.

The `as unknown as` cast is counted by `check-test-as-unknown-as`. If that ratchet fails, build the document through a `JSON.parse` of a literal string instead: `JSON.parse('{"schemaVersion":2,"savedAt":"t","messages":[]}') as TranscriptDoc`.

- [ ] **Step 2: Run to verify they fail**

Run: `cd packages/nax-agent && bun test ./test/unit/native/session/transcript-identity.test.ts --timeout=60000`
Expected: FAIL, cannot resolve `#src/native/session/transcript-identity`.

- [ ] **Step 3: Create `src/native/session/transcript-types.ts`**

```ts
/**
 * The transcript port (S3 spec 5.5). The native loop loads the whole history
 * through it at turn start and saves a fresh snapshot at turn end, so a store
 * is a document store, not a log. nax uses the file store
 * (`createFileTranscriptStore`); an embedder may inject its own.
 */

import type { ConversationMessage } from "@nathapp/nax-ai";

/** Facade-owned turn bookkeeping. The loop never writes it; `markTurn` does. */
export interface TurnMarker {
  readonly turnId: string;
  readonly state: "running" | "ended";
}

export interface TranscriptDoc {
  /** Absent means 1. nax-agent does not write it in S3-1. */
  readonly schemaVersion?: 1;
  readonly owner?: string;
  readonly model?: string;
  readonly savedAt: string;
  readonly messages: readonly ConversationMessage[];
  /** Read-only to the loop; owned by `markTurn`. */
  readonly turn?: TurnMarker;
}

export interface TranscriptStore {
  /** `null` when the session has no document yet. */
  load(sessionId: string): Promise<TranscriptDoc | null>;
  /** Replace the document. The loop calls it at turn end and after a caught turn error. */
  save(sessionId: string, doc: TranscriptDoc): Promise<void>;
  /** Move the live document out of `load`'s reach, keeping it for a human. Missing is not an error. */
  retainFailed(sessionId: string): Promise<void>;
  /** Missing is not an error. */
  delete(sessionId: string): Promise<void>;
  /** Read-merge `turn` into the document, creating an empty one when none exists. */
  markTurn(sessionId: string, marker: TurnMarker): Promise<void>;
}
```

- [ ] **Step 4: Create `src/native/session/transcript-identity.ts`**

Move `TranscriptIdentity` and `transcriptModelIdentity` (with their doc comments) out of `transcript-store.ts` verbatim, and move `isForeignTranscript` with its comment. Then add:

```ts
import type { ConversationMessage } from "@nathapp/nax-ai";
import { getLogger, NaxError } from "#src/infra/index";
import { parseModelSpec } from "../models.ts";
import type { TranscriptDoc } from "./transcript-types.ts";

// ... TranscriptIdentity, transcriptModelIdentity, isForeignTranscript moved here,
// with isForeignTranscript's first parameter typed `TranscriptDoc` instead of `TranscriptFile` ...

/**
 * The history a session may resume from a loaded document (nax#1877, nax#2150).
 * Applied by the loop to whatever any store returns, so the identity rules hold
 * for every store, not only the file store. An unknown `schemaVersion` fails
 * the turn for the same reason `TRANSCRIPT_CORRUPT` does: silently starting
 * over would drop history the conversation depends on.
 */
export function historyFromTranscript(
  doc: TranscriptDoc | null,
  identity: TranscriptIdentity,
  sessionName: string,
): readonly ConversationMessage[] {
  if (doc === null) return [];
  const version: unknown = doc.schemaVersion;
  if (version !== undefined && version !== 1) {
    throw new NaxError(
      `transcript for session "${sessionName}" has unsupported schemaVersion ${String(version)}`,
      "TRANSCRIPT_SCHEMA_UNSUPPORTED",
      { stage: "native-session" },
    );
  }
  if (isForeignTranscript(doc, identity, sessionName)) return [];
  return doc.messages;
}

/**
 * The document the loop saves. Key order is owner, model, savedAt, messages:
 * the file store writes it as-is, and nax's transcript bytes depend on that order.
 */
export function transcriptDocFor(messages: readonly ConversationMessage[], identity: TranscriptIdentity): TranscriptDoc {
  return {
    ...(identity.owner !== undefined ? { owner: identity.owner } : {}),
    ...(identity.model !== undefined ? { model: identity.model } : {}),
    savedAt: new Date().toISOString(),
    messages: [...messages],
  };
}
```

In `transcript-store.ts`, delete the moved declarations and the now-unused `parseModelSpec` import. Add the re-export so existing importers (`turn-loop.ts`, tests, the `/internal` namespace) keep resolving:

```ts
export { type TranscriptIdentity, transcriptModelIdentity } from "./transcript-identity.ts";
```

Leave `loadTranscript`'s body alone in this task. It still calls `isForeignTranscript`, so import that from `./transcript-identity.ts`: export it there as `isForeignTranscript`, then make it module-private again in Task 3 once `loadTranscript` no longer needs it.

- [ ] **Step 5: Run the new and existing transcript tests**

Run: `cd packages/nax-agent && bun test ./test/unit/native/session/transcript-identity.test.ts ./test/unit/native/transcript-store.test.ts ./test/unit/native/session/turn-loop-transcript-identity.test.ts --timeout=60000`
Expected: PASS.

- [ ] **Step 6: Typecheck and commit**

Run: `cd packages/nax-agent && bun run typecheck`
Expected: no errors.

```bash
git add packages/nax-agent/src/native/session/transcript-types.ts packages/nax-agent/src/native/session/transcript-identity.ts packages/nax-agent/src/native/session/transcript-store.ts packages/nax-agent/test/unit/native/session/transcript-identity.test.ts
git commit -m "feat(nax-agent): TranscriptStore port types and loop-side identity check"
```

---

### Task 3: File store

**Files:**
- Modify: `packages/nax-agent/src/native/session/transcript-store.ts`
- Test: `packages/nax-agent/test/unit/native/transcript-store.test.ts` (add a `describe`)

**Interfaces:**
- Consumes: `TranscriptStore`, `TranscriptDoc`, `TurnMarker` (Task 2); `historyFromTranscript`, `transcriptDocFor`, `TranscriptIdentity` (Task 2).
- Produces:
  - `readTranscriptDoc(dir: string, sessionName: string): Promise<TranscriptDoc | null>`
  - `createFileTranscriptStore(dir: string): TranscriptStore`
  - `loadTranscript`, `saveTranscript`, `retainTranscript`, `deleteTranscript`, `transcriptPath`, `pruneRetainedTranscripts`, `MAX_RETAINED_TRANSCRIPTS`: signatures unchanged.

- [ ] **Step 1: Write the failing tests**

Add `createFileTranscriptStore` and `readTranscriptDoc` to the existing import from `#src/native/session/transcript-store`, then append:

```ts
describe("createFileTranscriptStore", () => {
  test("load returns null for a missing session", async () => {
    expect(await createFileTranscriptStore(dir).load("none")).toBeNull();
  });

  test("save then load round-trips the document, turn and schemaVersion included", async () => {
    const store = createFileTranscriptStore(dir);
    const doc = { schemaVersion: 1 as const, owner: "o", savedAt: "t", messages: msgs, turn: { turnId: "t1", state: "ended" as const } };
    await store.save("s", doc);
    expect(await store.load("s")).toEqual(doc);
  });

  test("save writes the same bytes saveTranscript writes for a loop document", async () => {
    const store = createFileTranscriptStore(dir);
    const doc = { owner: "o", model: "p/m", savedAt: "2026-10-04T00:00:00.000Z", messages: msgs };
    await store.save("s", doc);
    expect(await readFile(transcriptPath(dir, "s"), "utf8")).toBe(JSON.stringify(doc, null, 2));
  });

  test("a legacy bare array loads as an owner-less document", async () => {
    await writeFile(transcriptPath(dir, "legacy"), JSON.stringify(msgs));
    const doc = await readTranscriptDoc(dir, "legacy");
    expect(doc?.messages).toEqual(msgs);
    expect(doc?.owner).toBeUndefined();
  });

  test("a document with no messages field loads with empty messages", async () => {
    await writeFile(transcriptPath(dir, "nomsg"), JSON.stringify({ savedAt: "t" }));
    expect((await readTranscriptDoc(dir, "nomsg"))?.messages).toEqual([]);
  });

  test.each(["null", "42", '"x"', "true"])("valid JSON %s that is not a document is TRANSCRIPT_CORRUPT", async (body) => {
    await writeFile(transcriptPath(dir, "odd"), body);
    await expect(readTranscriptDoc(dir, "odd")).rejects.toMatchObject({ code: "TRANSCRIPT_CORRUPT" });
  });

  test("retainFailed renames the live file and prunes to the cap", async () => {
    const store = createFileTranscriptStore(dir);
    for (let i = 0; i < MAX_RETAINED_TRANSCRIPTS; i++) {
      await writeFile(join(dir, `old-${i}.transcript.failed-x.json`), "{}");
    }
    await store.save("s", { savedAt: "t", messages: msgs });
    await store.retainFailed("s");
    const names = await readdir(dir);
    expect(names).toHaveLength(MAX_RETAINED_TRANSCRIPTS);
    expect(names.some((n) => n.startsWith("s.transcript.failed-"))).toBe(true);
    expect(await store.load("s")).toBeNull();
  });

  test("retainFailed and delete are safe with nothing on disk", async () => {
    const store = createFileTranscriptStore(dir);
    await store.retainFailed("none");
    await store.delete("none");
    expect(await readdir(dir)).toEqual([]);
  });

  test("markTurn on a missing session creates an empty document with the marker", async () => {
    const store = createFileTranscriptStore(dir);
    await store.markTurn("s", { turnId: "t1", state: "running" });
    const doc = await store.load("s");
    expect(doc?.messages).toEqual([]);
    expect(doc?.turn).toEqual({ turnId: "t1", state: "running" });
    expect(doc?.schemaVersion).toBeUndefined();
  });

  test("markTurn merges into an existing document and keeps its history and identity", async () => {
    const store = createFileTranscriptStore(dir);
    await store.save("s", { owner: "o", model: "p/m", savedAt: "t", messages: msgs });
    await store.markTurn("s", { turnId: "t1", state: "ended" });
    expect(await store.load("s")).toEqual({ owner: "o", model: "p/m", savedAt: "t", messages: msgs, turn: { turnId: "t1", state: "ended" } });
  });

  test("markTurn on a corrupt file throws TRANSCRIPT_CORRUPT", async () => {
    await writeFile(transcriptPath(dir, "bad"), "{not json");
    await expect(createFileTranscriptStore(dir).markTurn("bad", { turnId: "t", state: "running" })).rejects.toMatchObject({
      code: "TRANSCRIPT_CORRUPT",
    });
  });
});
```

The `retainFailed` prune test seeds 50 retained files plus one live one. After retain there are 51 transcript files, the prune removes the oldest one, and 50 remain. If the seeded files and the renamed file share an mtime and the wrong one is pruned, set the seeded files' mtimes into the past with `utimes` (already imported in this file).

- [ ] **Step 2: Run to verify they fail**

Run: `cd packages/nax-agent && bun test ./test/unit/native/transcript-store.test.ts --timeout=60000`
Expected: FAIL, `createFileTranscriptStore` / `readTranscriptDoc` are not exported.

- [ ] **Step 3: Implement**

In `transcript-store.ts`:

1. Delete the `TranscriptFile` interface and `isLegacyTranscript`. `TranscriptDoc` replaces the first. Keep the doc comment that explains why the file wraps the messages, and move it onto `readTranscriptDoc`.
2. Add:

```ts
import type { TranscriptDoc, TranscriptStore, TurnMarker } from "./transcript-types.ts";
import { historyFromTranscript, type TranscriptIdentity, transcriptDocFor } from "./transcript-identity.ts";

/** `savedAt` for a pre-#1877 bare-array transcript, which recorded none. */
const LEGACY_SAVED_AT = new Date(0).toISOString();

function corruptTranscript(sessionName: string, reason: string): NaxError {
  return new NaxError(`transcript for session "${sessionName}" is unreadable: ${reason}`, "TRANSCRIPT_CORRUPT", {
    stage: "native-session",
  });
}

/**
 * Missing file means no document. Anything else unreadable is a real failure.
 * A bare array is a pre-#1877 transcript: it loads as an owner-less document,
 * which the identity check then drops for any reader that has an owner.
 */
export async function readTranscriptDoc(dir: string, sessionName: string): Promise<TranscriptDoc | null> {
  let raw: string;
  try {
    raw = await readFile(transcriptPath(dir, sessionName), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // Deliberately not null: silently restarting a conversation would drop the
    // history the model is mid-way through and look like a fresh session.
    throw corruptTranscript(sessionName, err instanceof Error ? err.message : String(err));
  }
  if (Array.isArray(parsed)) return { savedAt: LEGACY_SAVED_AT, messages: parsed as TranscriptDoc["messages"] };
  if (typeof parsed !== "object" || parsed === null) throw corruptTranscript(sessionName, "not a transcript document");
  const doc = parsed as TranscriptDoc;
  return { ...doc, messages: doc.messages ?? [] };
}

async function writeTranscriptDoc(dir: string, sessionName: string, doc: TranscriptDoc): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(transcriptPath(dir, sessionName), JSON.stringify(doc, null, 2), "utf8");
}

/**
 * The file store: `<dir>/<name>.transcript.json`, written as given (the loop's
 * documents carry no schemaVersion or turn, so nax's bytes are unchanged).
 * `retainFailed` is the kept-on-failure rename plus the prune to
 * `MAX_RETAINED_TRANSCRIPTS` that `closeNativeSession` used to run inline.
 */
export function createFileTranscriptStore(dir: string): TranscriptStore {
  return {
    load: (sessionId) => readTranscriptDoc(dir, sessionId),
    save: (sessionId, doc) => writeTranscriptDoc(dir, sessionId, doc),
    retainFailed: async (sessionId) => {
      await retainTranscript(dir, sessionId);
      await pruneRetainedTranscripts(dir);
    },
    delete: (sessionId) => deleteTranscript(dir, sessionId),
    markTurn: async (sessionId: string, marker: TurnMarker) => {
      const existing = await readTranscriptDoc(dir, sessionId);
      const base: TranscriptDoc = existing ?? { savedAt: new Date().toISOString(), messages: [] };
      await writeTranscriptDoc(dir, sessionId, { ...base, turn: marker });
    },
  };
}
```

3. Rewrite the two helpers over it (keep their doc comments, updated to say they are file-level conveniences over the store):

```ts
export async function loadTranscript(
  dir: string,
  sessionName: string,
  identity: TranscriptIdentity = {},
): Promise<ConversationMessage[]> {
  return [...historyFromTranscript(await readTranscriptDoc(dir, sessionName), identity, sessionName)];
}

export async function saveTranscript(
  dir: string,
  sessionName: string,
  messages: readonly ConversationMessage[],
  identity: TranscriptIdentity = {},
): Promise<void> {
  await writeTranscriptDoc(dir, sessionName, transcriptDocFor(messages, identity));
}
```

4. Make `isForeignTranscript` in `transcript-identity.ts` module-private again (drop the `export` added in Task 2).

- [ ] **Step 4: Run the transcript and loop tests**

Run: `cd packages/nax-agent && bun test ./test/unit/native/transcript-store.test.ts ./test/unit/native/session/transcript-identity.test.ts ./test/unit/native/session/turn-loop-transcript-identity.test.ts ./test/unit/native/turn-loop.test.ts --timeout=60000`
Expected: PASS, including Task 1's byte tests unchanged.

- [ ] **Step 5: Typecheck, size gate, commit**

Run: `cd packages/nax-agent && bun run typecheck && bun ../repo-tooling/scripts/check-file-sizes.ts --package=.`
Expected: clean. `transcript-store.ts` should land at about 300 lines.

```bash
git add packages/nax-agent/src/native/session/transcript-store.ts packages/nax-agent/src/native/session/transcript-identity.ts packages/nax-agent/test/unit/native/transcript-store.test.ts
git commit -m "feat(nax-agent): file TranscriptStore over today's transcript layout"
```

---

### Task 4: Memory store

**Files:**
- Create: `packages/nax-agent/src/native/session/memory-transcript-store.ts`
- Test: `packages/nax-agent/test/unit/native/session/memory-transcript-store.test.ts` (new)

**Interfaces:**
- Consumes: `TranscriptStore`, `TranscriptDoc`, `TurnMarker` (Task 2).
- Produces:
  - `interface MemoryTranscriptStore extends TranscriptStore { retained(sessionId: string): TranscriptDoc | undefined }`
  - `createMemoryTranscriptStore(): MemoryTranscriptStore`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, test } from "bun:test";
import type { ConversationMessage } from "@nathapp/nax-ai";
import { createMemoryTranscriptStore } from "#src/native/session/memory-transcript-store";

const msgs: ConversationMessage[] = [{ role: "user", content: "hello" }];

describe("createMemoryTranscriptStore", () => {
  test("load is null until a save", async () => {
    expect(await createMemoryTranscriptStore().load("s")).toBeNull();
  });

  test("save then load round-trips; sessions are separate", async () => {
    const store = createMemoryTranscriptStore();
    await store.save("a", { savedAt: "t", messages: msgs });
    expect(await store.load("a")).toEqual({ savedAt: "t", messages: msgs });
    expect(await store.load("b")).toBeNull();
  });

  test("mutating the saved array or a loaded document does not change stored history", async () => {
    const store = createMemoryTranscriptStore();
    const mine = [...msgs];
    await store.save("s", { savedAt: "t", messages: mine });
    mine.push({ role: "user", content: "later" });
    const loaded = await store.load("s");
    (loaded?.messages as ConversationMessage[]).push({ role: "user", content: "sneaky" });
    expect((await store.load("s"))?.messages).toEqual(msgs);
  });

  test("retainFailed moves the document out of load's reach and keeps a copy", async () => {
    const store = createMemoryTranscriptStore();
    await store.save("s", { savedAt: "t", messages: msgs });
    await store.retainFailed("s");
    expect(await store.load("s")).toBeNull();
    expect(store.retained("s")?.messages).toEqual(msgs);
  });

  test("retainFailed and delete are safe on a missing session", async () => {
    const store = createMemoryTranscriptStore();
    await store.retainFailed("none");
    await store.delete("none");
    expect(store.retained("none")).toBeUndefined();
  });

  test("delete removes the live document", async () => {
    const store = createMemoryTranscriptStore();
    await store.save("s", { savedAt: "t", messages: msgs });
    await store.delete("s");
    expect(await store.load("s")).toBeNull();
  });

  test("markTurn creates an empty document when none exists, then merges", async () => {
    const store = createMemoryTranscriptStore();
    await store.markTurn("s", { turnId: "t1", state: "running" });
    expect((await store.load("s"))?.turn).toEqual({ turnId: "t1", state: "running" });
    expect((await store.load("s"))?.messages).toEqual([]);
    await store.save("s", { owner: "o", savedAt: "t", messages: msgs });
    await store.markTurn("s", { turnId: "t1", state: "ended" });
    expect(await store.load("s")).toEqual({ owner: "o", savedAt: "t", messages: msgs, turn: { turnId: "t1", state: "ended" } });
  });
});
```

If `check-test-escape-hatches` rejects the `as ConversationMessage[]` cast in the mutation test, replace that line with `Reflect.apply(Array.prototype.push, loaded?.messages, [{ role: "user", content: "sneaky" }]);`.

- [ ] **Step 2: Run to verify they fail**

Run: `cd packages/nax-agent && bun test ./test/unit/native/session/memory-transcript-store.test.ts --timeout=60000`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/native/session/memory-transcript-store.ts`**

```ts
/**
 * An in-process `TranscriptStore` for tests and simple embedders (S3 spec 5.5).
 * Every document crossing the boundary is copied, so a caller mutating what it
 * saved or loaded cannot rewrite stored history. History is lost with the
 * process; an embedder that must resume after a restart injects a durable store.
 */

import type { TranscriptDoc, TranscriptStore, TurnMarker } from "./transcript-types.ts";

export interface MemoryTranscriptStore extends TranscriptStore {
  /** The last document `retainFailed` moved aside for `sessionId`, if any. */
  retained(sessionId: string): TranscriptDoc | undefined;
}

export function createMemoryTranscriptStore(): MemoryTranscriptStore {
  const live = new Map<string, TranscriptDoc>();
  const failed = new Map<string, TranscriptDoc>();
  const copy = (doc: TranscriptDoc | undefined): TranscriptDoc | undefined =>
    doc === undefined ? undefined : structuredClone(doc);

  return {
    load: (sessionId) => Promise.resolve(copy(live.get(sessionId)) ?? null),
    save: (sessionId, doc) => {
      live.set(sessionId, structuredClone(doc));
      return Promise.resolve();
    },
    retainFailed: (sessionId) => {
      const doc = live.get(sessionId);
      if (doc !== undefined) {
        failed.set(sessionId, doc);
        live.delete(sessionId);
      }
      return Promise.resolve();
    },
    delete: (sessionId) => {
      live.delete(sessionId);
      return Promise.resolve();
    },
    markTurn: (sessionId: string, marker: TurnMarker) => {
      const base: TranscriptDoc = live.get(sessionId) ?? { savedAt: new Date().toISOString(), messages: [] };
      live.set(sessionId, { ...base, turn: { ...marker } });
      return Promise.resolve();
    },
    retained: (sessionId) => copy(failed.get(sessionId)),
  };
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd packages/nax-agent && bun test ./test/unit/native/session/memory-transcript-store.test.ts --timeout=60000`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/nax-agent/src/native/session/memory-transcript-store.ts packages/nax-agent/test/unit/native/session/memory-transcript-store.test.ts
git commit -m "feat(nax-agent): in-memory TranscriptStore"
```

---

### Task 5: Sessions and the turn loop use the store; `retainOnClose`

**Files:**
- Modify: `packages/nax-agent/src/session/session-types.ts` (`OpenSessionOpts`, after `transcriptOwner`)
- Modify: `packages/nax-agent/src/native/session/session.ts` (state, `createNativeSessionState`, `openNativeSession`, `clearNativeSessionState`, `closeNativeSession`)
- Modify: `packages/nax-agent/src/native/session/turn-loop.ts:33-37,73-88,241,271`
- Modify: `packages/nax-agent/test/unit/native/session/session-state.test.ts` (collection list in "clear empties every collection")
- Modify: `packages/nax-agent/test/unit/native/session-adapter.test.ts:260-274` (the throwing-retain test)
- Test: `packages/nax-agent/test/unit/native/session/turn-loop-transcript-store.test.ts` (new)

**Interfaces:**
- Consumes: `TranscriptStore` (Task 2), `historyFromTranscript`, `transcriptDocFor` (Task 2), `createFileTranscriptStore` (Task 3), `createMemoryTranscriptStore` (Task 4, tests only).
- Produces:
  - `OpenSessionOpts.transcriptStore?: TranscriptStore`
  - `OpenSessionOpts.retainOnClose?: boolean`
  - `interface SessionTranscript { readonly store: TranscriptStore; readonly retainOnClose: boolean }` (exported from `session.ts`)
  - `NativeSessionState.transcripts: Map<string, SessionTranscript>`
  - `sessionTranscriptFor(state: NativeSessionState, sessionName: string): SessionTranscript | undefined`
  - New error code `NATIVE_TRANSCRIPT_SOURCE_CONFLICT`. `NATIVE_TRANSCRIPT_DIR_MISSING` is kept for "neither given".

- [ ] **Step 1: Write the failing tests**

Create `test/unit/native/session/turn-loop-transcript-store.test.ts`. Model the reply, handle and opts on `turn-loop-transcript-identity.test.ts` in the same directory. Read that file first and reuse its `reply` object and `complete` stub shape exactly.

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { createMemoryTranscriptStore } from "#src/native/session/memory-transcript-store";
import {
  closeNativeSession,
  createNativeSessionState,
  markNativeTurnOutcome,
  type NativeSessionState,
  openNativeSession,
} from "#src/native/session/session";
import { runNativeTurn } from "#src/native/session/turn-loop";
import type { OpenSessionOpts, SendTurnOpts } from "#src/session/session-types";
import { cleanupTempDir, makeTempDir } from "#test/helpers/index";

let workdir: string;
let state: NativeSessionState;
beforeEach(() => {
  workdir = makeTempDir("nax-transcript-port-");
  state = createNativeSessionState();
});
afterEach(() => cleanupTempDir(workdir));

const base = (extra: Partial<OpenSessionOpts>): OpenSessionOpts => ({
  agentName: "native",
  workdir,
  timeoutSeconds: 60,
  resume: true,
  ...extra,
});
const opts: SendTurnOpts = { interactionHandler: { onInteraction: async () => ({ answer: "" }) } };
const complete = async () => ({ text: "done", usage: { inputTokens: 1, outputTokens: 1 } });

describe("native sessions on an injected TranscriptStore", () => {
  test("two turns share history through the store and nothing is written to disk", async () => {
    const store = createMemoryTranscriptStore();
    const handle = await openNativeSession(state, "s", base({ transcriptStore: store }));
    await runNativeTurn(handle, "one", opts, { sessionState: state, complete });
    await runNativeTurn(handle, "two", opts, { sessionState: state, complete });
    const doc = await store.load("s");
    expect(doc?.messages.filter((m) => m.role === "user").map((m) => m.content)).toEqual(["one", "two"]);
    expect(await readdir(workdir)).not.toContainEqual(expect.stringContaining(".transcript."));
  });

  test("a store whose load throws fails the turn", async () => {
    const store = { ...createMemoryTranscriptStore(), load: () => Promise.reject(new Error("load boom")) };
    const handle = await openNativeSession(state, "s", base({ transcriptStore: store }));
    await expect(runNativeTurn(handle, "one", opts, { sessionState: state, complete })).rejects.toThrow("load boom");
  });

  test("open refuses both transcriptDir and transcriptStore", async () => {
    await expect(
      openNativeSession(state, "s", base({ transcriptDir: workdir, transcriptStore: createMemoryTranscriptStore() })),
    ).rejects.toMatchObject({ code: "NATIVE_TRANSCRIPT_SOURCE_CONFLICT" });
    expect(state.transcripts.has("s")).toBe(false);
  });

  test("open with neither still throws NATIVE_TRANSCRIPT_DIR_MISSING", async () => {
    await expect(openNativeSession(state, "s", base({}))).rejects.toMatchObject({ code: "NATIVE_TRANSCRIPT_DIR_MISSING" });
  });

  test("open without resume deletes the store's document", async () => {
    const store = createMemoryTranscriptStore();
    await store.save("s", { savedAt: "t", messages: [{ role: "user", content: "old" }] });
    await openNativeSession(state, "s", base({ transcriptStore: store, resume: false }));
    expect(await store.load("s")).toBeNull();
  });

  test("retainOnClose keeps the live document after a clean close", async () => {
    const store = createMemoryTranscriptStore();
    const handle = await openNativeSession(state, "s", base({ transcriptStore: store, retainOnClose: true }));
    await runNativeTurn(handle, "one", opts, { sessionState: state, complete });
    await closeNativeSession(state, handle);
    expect(await store.load("s")).not.toBeNull();
    expect(state.transcripts.has("s")).toBe(false);
  });

  test("retainOnClose keeps the live document after a failed turn, unrenamed", async () => {
    const store = createMemoryTranscriptStore();
    const handle = await openNativeSession(state, "s", base({ transcriptStore: store, retainOnClose: true }));
    await runNativeTurn(handle, "one", opts, { sessionState: state, complete });
    markNativeTurnOutcome(state, "s", true);
    await closeNativeSession(state, handle);
    expect(await store.load("s")).not.toBeNull();
    expect(store.retained("s")).toBeUndefined();
  });

  test("without retainOnClose a failed close retains and a clean close deletes", async () => {
    const failedStore = createMemoryTranscriptStore();
    const h1 = await openNativeSession(state, "f", base({ transcriptStore: failedStore }));
    await runNativeTurn(h1, "one", opts, { sessionState: state, complete });
    markNativeTurnOutcome(state, "f", true);
    await closeNativeSession(state, h1);
    expect(await failedStore.load("f")).toBeNull();
    expect(failedStore.retained("f")).not.toBeUndefined();

    const cleanStore = createMemoryTranscriptStore();
    const h2 = await openNativeSession(state, "c", base({ transcriptStore: cleanStore }));
    await runNativeTurn(h2, "one", opts, { sessionState: state, complete });
    await closeNativeSession(state, h2);
    expect(await cleanStore.load("c")).toBeNull();
    expect(cleanStore.retained("c")).toBeUndefined();
  });
});
```

Adjust `base()` to whatever fields `OpenSessionOpts` actually requires. Copy the `openOpts` helper in `test/unit/native/session/session-state.test.ts` and drop its `transcriptDir`. If `runNativeTurn`'s deps need more than `sessionState` and `complete`, copy the deps the identity test passes.

Also add the `transcripts` collection to the list in `session-state.test.ts` "clear empties every collection for one name only" (after `state.transcriptDirs`).

Replace the spy in `session-adapter.test.ts` "a throwing transcript retain still clears every native map". The old test spied on `retainTranscript`. The store now calls `retainTranscript` from inside its own module, so a namespace spy can miss that call. Instead, spy on the store factory before opening, so the session holds a store whose `retainFailed` rejects:

```ts
  test("a throwing transcript retain still clears every native map", async () => {
    const state = createNativeSessionState();
    const name = "nax-throw-us-002-implementer";
    const throwing = { ...createMemoryTranscriptStore(), retainFailed: () => Promise.reject(new Error("retain boom")) };
    const factorySpy = spyOn(transcriptStore, "createFileTranscriptStore").mockReturnValue(throwing);
    let handle: SessionHandle;
    try {
      handle = await openNativeSession(state, name, openOpts());
    } finally {
      factorySpy.mockRestore();
    }
    state.failed.add(name);
    state.lastUsage.set(name, { promptTokens: 10, anchorIndex: 0 });
    expect(collectionsHolding(state, name)).toEqual(exportedCollections(state));
    await expect(closeNativeSession(state, handle)).rejects.toThrow("retain boom");
    expect(collectionsHolding(state, name)).toEqual([]);
  });
```

Add `createMemoryTranscriptStore` to that file's imports from `#src/native/session/memory-transcript-store`. If `SessionHandle` is not already imported there, add it to the `#src/session/session-types` import.

- [ ] **Step 2: Run to verify they fail**

Run: `cd packages/nax-agent && bun test ./test/unit/native/session/turn-loop-transcript-store.test.ts ./test/unit/native/session/session-state.test.ts ./test/unit/native/session-adapter.test.ts --timeout=60000`
Expected: FAIL. Typecheck errors on `transcriptStore` / `retainOnClose` / `state.transcripts`; the conflict and store tests fail.

- [ ] **Step 3: Add the options to `OpenSessionOpts`** (`src/session/session-types.ts`, after `transcriptOwner`)

```ts
  /**
   * Native: where the session's history lives (S3 spec 5.5). Mutually exclusive
   * with `transcriptDir`, which is shorthand for the file store; exactly one of
   * the two must be set. nax sets `transcriptDir`. ACP ignores it.
   */
  transcriptStore?: import("#src/native/session/transcript-types").TranscriptStore;
  /**
   * Native: leave the live transcript in place on close (S3 spec 5.5). By
   * default a clean close deletes it and a failed close moves it aside; the
   * facade sets this so the session stays resumable. nax leaves it unset.
   */
  retainOnClose?: boolean;
```

- [ ] **Step 4: Wire `session.ts`**

1. Change the import line to `import { createFileTranscriptStore } from "./transcript-store.ts";` and add `import type { TranscriptStore } from "./transcript-types.ts";`.
2. Add, above `NativeSessionState`:

```ts
/** Where one open session's history lives, and whether close may remove it. */
export interface SessionTranscript {
  readonly store: TranscriptStore;
  readonly retainOnClose: boolean;
}
```

3. Add to `NativeSessionState`, after `transcriptDirs`:

```ts
  /**
   * Session name -> the session's transcript store and close policy (S3-1).
   * Set by every `openNativeSession`; read through `sessionTranscriptFor`. Same
   * lifecycle as the maps above: set on open, cleared on close.
   */
  readonly transcripts: Map<string, SessionTranscript>;
```

Add `transcripts: new Map(),` to `createNativeSessionState`, and `state.transcripts.delete(sessionName);` to `clearNativeSessionState`.

4. Add, after `markNativeTurnOutcome`:

```ts
/**
 * The session's transcript. A state seeded with only a transcript directory
 * (tests that drive `runNativeTurn` without opening) resolves to the file store
 * over it; `openNativeSession` always records an entry, so production does not
 * take that path.
 */
export function sessionTranscriptFor(state: NativeSessionState, sessionName: string): SessionTranscript | undefined {
  const opened = state.transcripts.get(sessionName);
  if (opened !== undefined) return opened;
  const dir = state.transcriptDirs.get(sessionName);
  return dir === undefined ? undefined : { store: createFileTranscriptStore(dir), retainOnClose: false };
}

function openTranscriptStore(name: string, opts: OpenSessionOpts): TranscriptStore {
  const hasDir = Boolean(opts.transcriptDir);
  if (hasDir && opts.transcriptStore !== undefined) {
    throw new NaxError(
      `native session "${name}" opened with both a transcriptDir and a transcriptStore`,
      "NATIVE_TRANSCRIPT_SOURCE_CONFLICT",
      { stage: "native-session" },
    );
  }
  if (opts.transcriptStore !== undefined) return opts.transcriptStore;
  // Never defaulted. An adapter that picks its own path writes a transcript
  // somewhere nobody looks, which is #1794's empty-packageDir bug one layer up.
  if (!opts.transcriptDir) {
    throw new NaxError(
      `native session "${name}" opened without a transcriptDir or transcriptStore`,
      "NATIVE_TRANSCRIPT_DIR_MISSING",
      { stage: "native-session" },
    );
  }
  return createFileTranscriptStore(opts.transcriptDir);
}
```

5. In `openNativeSession`, replace the `if (!opts.transcriptDir) { throw ... }` block and the `state.transcriptDirs.set(...)` line with:

```ts
  const store = openTranscriptStore(name, opts);
  if (opts.transcriptDir) state.transcriptDirs.set(name, opts.transcriptDir);
  state.transcripts.set(name, { store, retainOnClose: opts.retainOnClose === true });
```

Then replace `if (opts.resume !== true) await deleteTranscript(opts.transcriptDir, name);` with `if (opts.resume !== true) await store.delete(name);`. Keep the comment above it, changing "the owner check in loadTranscript" to "the owner check in historyFromTranscript".

6. Replace `closeNativeSession`'s body:

```ts
  const transcript = sessionTranscriptFor(state, handle.id);
  // An explicit argument wins; otherwise the last turn's own verdict decides.
  // The adapter passes nothing, because its interface has no failure signal.
  const treatAsFailed = failed ?? state.failed.has(handle.id);
  try {
    if (transcript !== undefined && !transcript.retainOnClose) {
      // Retain for a human, out of reach of the next session of this name.
      if (treatAsFailed) await transcript.store.retainFailed(handle.id);
      else await transcript.store.delete(handle.id);
    }
  } finally {
    // The deletes must run even when the transcript I/O throws: a failed
    // cleanup step is no reason to strand the session's other state.
    clearNativeSessionState(state, handle.id);
  }
```

Update its doc comment to say that the retain-and-prune is the store's `retainFailed`, and that `retainOnClose` skips both branches.

- [ ] **Step 5: Wire `turn-loop.ts`**

1. Replace the `./transcript-store.ts` import (lines 33-37) with:

```ts
import { historyFromTranscript, type TranscriptIdentity, transcriptDocFor, transcriptModelIdentity } from "./transcript-identity.ts";
```

Then extend the existing `import { sessionAnchorFor } from "./session.ts";` (`turn-loop.ts:30`) to `import { sessionAnchorFor, sessionTranscriptFor } from "./session.ts";`. Verify there is no import cycle: `bun ../repo-tooling/scripts/check-import-cycles.ts --package=.`.

2. Replace lines 73-78 (the `dir` lookup and its throw) with:

```ts
  const transcript = sessionTranscriptFor(deps.sessionState, handle.id);
  if (transcript === undefined) {
    throw new NaxError(`no transcript store for session "${handle.id}"`, "NATIVE_TRANSCRIPT_DIR_MISSING", {
      stage: "native-session",
    });
  }
  const { store } = transcript;
```

3. Line 88 becomes:

```ts
  let messages: NativeTranscriptMessage[] = [
    ...historyFromTranscript(await store.load(handle.id), transcriptIdentity, handle.id),
  ];
```

Change the comment above `transcriptIdentity` from "the store owns that guarantee" to "the loop applies that guarantee to every store's document (historyFromTranscript)".

4. The error-path save (line 241) becomes `await store.save(handle.id, transcriptDocFor(state.messages, transcriptIdentity)).catch(...)` with the same `.catch` body. The clean-exit save (line 271) becomes `await store.save(handle.id, transcriptDocFor(state.messages, transcriptIdentity));`. Keep both comments.

5. Update the three comments that name `saveTranscript` in `turn-loop.ts:130`, `turn-loop-round-trip.ts:307,349`, `loop-events/types.ts:176`, `turn-result.ts:5` and `turn-complete-step.ts:12,129` to say "the turn-end transcript save". These are comment-only edits.

- [ ] **Step 6: Run the focused tests**

Run: `cd packages/nax-agent && bun test ./test/unit/native/ --timeout=60000`
Expected: PASS, including Task 1's byte tests and `turn-loop.test.ts` "a session with no known transcript directory fails loudly" (it matches `/transcript/i`).

- [ ] **Step 7: Run both packages' suites (nax tests seed `transcriptDirs` directly and use the helpers)**

Run: `cd packages/nax-agent && bun run test` then `cd ../nax && bun run test`
Expected: PASS in both. A nax failure here means nax-visible behaviour changed. Fix the source, not the test.

- [ ] **Step 8: Typecheck, lint, commit**

Run: `cd packages/nax-agent && bun run typecheck && bun run lint`
Expected: clean.

```bash
git add packages/nax-agent/src packages/nax-agent/test
git commit -m "feat(nax-agent): native sessions load and save through a TranscriptStore; retainOnClose"
```

---

### Task 6: Public surface, Node contract case, full gates

**Files:**
- Modify: `packages/nax-agent/src/native/index.ts:54-55`
- Modify: `packages/nax-agent/src/index.ts` (the `#src/native/index` export block, about line 106)
- Regenerate: `packages/nax-agent/api/nax-agent.api.txt`
- Test: `packages/nax-agent/test/node/transcript-store.test.ts` (new)

**Interfaces:**
- Consumes: everything above.
- Produces on `.`: `createFileTranscriptStore`, `createMemoryTranscriptStore`, `type MemoryTranscriptStore`, `type TranscriptDoc`, `type TranscriptStore`, `type TurnMarker`. `/internal` picks up the new modules through its existing `export *` of `transcript-store`. Add explicit `export *` lines in `src/internal.ts` for `transcript-identity`, `transcript-types` and `memory-transcript-store`, next to the existing transcript-store lines (`internal.ts:67-68`).

- [ ] **Step 1: Write the Node contract case** (`test/node/transcript-store.test.ts`)

```ts
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createFileTranscriptStore, createMemoryTranscriptStore } from "#src/index";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nax-agent-node-transcript-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("transcript stores on Node", () => {
  test("file store round-trips a document and a turn marker", async () => {
    const store = createFileTranscriptStore(dir);
    await store.save("s", { owner: "o", savedAt: "t", messages: [{ role: "user", content: "hi" }] });
    await store.markTurn("s", { turnId: "t1", state: "ended" });
    expect(await store.load("s")).toEqual({
      owner: "o",
      savedAt: "t",
      messages: [{ role: "user", content: "hi" }],
      turn: { turnId: "t1", state: "ended" },
    });
    expect(await readFile(join(dir, "s.transcript.json"), "utf8")).toContain('"turn"');
  });

  test("memory store copies documents (structuredClone on Node)", async () => {
    const store = createMemoryTranscriptStore();
    const doc = { savedAt: "t", messages: [{ role: "user" as const, content: "hi" }] };
    await store.save("s", doc);
    expect(await store.load("s")).toEqual(doc);
    expect(await store.load("s")).not.toBe(doc);
  });
});
```

Check how `test/node/session-credentials.test.ts` imports. It uses a deep `#src/...` path. If importing `#src/index` under vitest pulls in something Node cannot load, switch to `#src/native/session/transcript-store` and `#src/native/session/memory-transcript-store`.

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/nax-agent && bun run test:node`
Expected: FAIL, the factories are not exported from `#src/index`.

- [ ] **Step 3: Export**

In `src/native/index.ts`, extend the `./session/transcript-store.ts` export and add the new modules:

```ts
export { createFileTranscriptStore, pruneRetainedTranscripts } from "./session/transcript-store.ts";
export { createMemoryTranscriptStore, type MemoryTranscriptStore } from "./session/memory-transcript-store.ts";
export type { TranscriptDoc, TranscriptStore, TurnMarker } from "./session/transcript-types.ts";
```

Keep whatever else the existing export at lines 54-55 lists. In `src/index.ts`, add `createFileTranscriptStore`, `createMemoryTranscriptStore`, `type MemoryTranscriptStore`, `type TranscriptDoc`, `type TranscriptStore` and `type TurnMarker` to the `#src/native/index` block, keeping it sorted the way the block is sorted.

- [ ] **Step 4: Run the Node suite and the API snapshot**

Run: `cd packages/nax-agent && bun run test:node && bun run check:api`
Expected: `test:node` PASS; `check:api` FAIL listing exactly the six new `.` names (plus the new `/internal` names).

Run: `bun run api:update && git diff --stat api/`
Expected: only additions in `api/nax-agent.api.txt`. No line removed from `[.]`.

- [ ] **Step 5: Full gates for both packages**

Run, from `packages/nax-agent`: `bun run typecheck && bun run lint && bun run test && bun run test:node && bun run test:coverage && bun run check:api`
Then from the repo root: `bun run typecheck && bun run check:all`
Then from `packages/nax`: `bun run test`
Expected: all green. The coverage gate holds 80% per file for the three new source files.

Pin the nax CLI surface the way S3-0 did:

Run: `bun packages/nax/bin/nax.ts --help | md5` and `bun packages/nax/bin/nax.ts --version`, and compare against the same commands on `main` (`git stash` is not needed; use a scratch worktree or compare against the values recorded in #2342's description).
Expected: identical.

- [ ] **Step 6: Commit**

```bash
git add packages/nax-agent/src/index.ts packages/nax-agent/src/native/index.ts packages/nax-agent/src/internal.ts packages/nax-agent/api/nax-agent.api.txt packages/nax-agent/test/node/transcript-store.test.ts
git commit -m "feat(nax-agent): export TranscriptStore port and stores on the public entry"
```

- [ ] **Step 7: Review before push, then PR (approval)**

Run a code review of the whole branch against this plan and spec §5.5 before pushing (working agreement: review before push). Push and open the PR only on the user's go-ahead. The PR description follows #2342's shape: What / Why / How / Testing / Notes with the five Review Focus items and the test that pins each.

---

## Self-review notes

- **Spec coverage (§5.5, §9 S3-1):** the port with `markTurn` (Task 2), the byte-identical file store (Tasks 1 and 3), the memory store (Task 4), the loop-side identity check (Tasks 2 and 5), `retainOnClose` (Task 5), `transcriptDir` kept as shorthand (Task 5), `pruneRetainedTranscripts` still exported (Task 6). Snapshot semantics (load whole, save at turn end, best-effort on error) are kept by Task 5 Step 5. §8 Node contract: one file-store and one memory-store case (Task 6). The full facade Node cases belong to S3-4 and S3-5.
- **Not in S3-1, by the spec's delivery table:** the facade's write order (`markTurn(running)` -> `sendTurn` -> `markTurn(ended)`), `resumeAgentSession`, `interrupted` and `AGENT_SESSION_SCHEMA_UNSUPPORTED` (S3-4/S3-5). S3-1 only provides `markTurn` on both stores.
