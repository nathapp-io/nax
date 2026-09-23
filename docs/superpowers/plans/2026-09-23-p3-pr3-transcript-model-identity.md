# P3 PR 3 — Transcript Model Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The native transcript store refuses history that a different model wrote. The
persisted cache anchor is likewise honoured only for the model it was measured under. The
`before_turn` payload fields that could never be populated are removed.

**Architecture:** `TranscriptFile` gains `model`, and `loadTranscript` refuses a recorded
different model. This is the nax#1877 owner-check pattern, extended with a second field; both
fields travel together as one `TranscriptIdentity`. The session anchor
(`nativeSessionLastUsage`) records its model, and a new `sessionAnchorFor` helper drops an
anchor recorded under a different model. `runNativeTurn` derives both from `handle.modelDef`.
No change to `SessionManager`, `decideReuse`, the close semantics or nax-ai.

**Tech Stack:** Bun 1.4 + TypeScript strict, `bun:test`, Biome.

**Spec:** `docs/superpowers/specs/2026-09-22-p3-loop-events-design.md` §8 (re-scoped
2026-09-23), with the testing obligations in §9 "PR 3 (re-scoped, §8.3)". Read §8.1–§8.4
before starting: they explain why the check exists although no production path triggers it
today.

**Branch:** `feat/p3-transcript-model-identity` (already exists, off `main` @ `fc4dcfcc9`).
It carries docs only: spec commits `33cc3145a` and `5062fe9af`, this plan, and its review
fixes. No `src/` change yet.

**Line numbers** are as of `fc4dcfcc9`. Tasks 1–3 all edit `turn-loop.ts`, so after Task 1 its
cited lines drift by a few. Every edit below quotes the code it replaces; locate by that
text, not by the number.

## Global Constraints

- **Model identity** is `parseModelSpec(raw).model`, the native `provider/model` id with the
  `[effort]` suffix stripped (spec §8.3(b)). Never use `parseNativeModel`, which throws.
- **Load rule** (spec §8.3(c)): if the reader declares no model, read. Same model: read.
  Recorded different model: return `[]` and debug-log. **Absent file model: read.**
- **Anchor rule** (spec §8.3(d)): the same "no claim" semantics. The entry is dropped only when
  both the entry and the turn declare a model and the two differ.
- **Nothing stops the turn.** A refused load or anchor means a new conversation or no anchor;
  it never throws (spec §8.4).
- **`src/` file limit is 600 lines; test files target 650 and hard-cap at 800**
  (`bun run check:file-sizes`). `turn-loop.ts` is 438 lines, `session.ts` about 220,
  `transcript-store.ts` 207, `session-lifecycle.test.ts` 477.
- **Test runs:** always wrap with a timeout, e.g. `timeout 30 bun test <path> --timeout=5000`.
  Never run bare `bun test`. Full suite: `bun run test`.
- **Test code must avoid:** `as any`, `as never`, `as unknown as`, postfix `!` and
  `@ts-` suppressions (all gated). Use `assertDefined()` from `@test/helpers` where you would
  reach for `!`. New test files use `makeTempDir()`/`cleanupTempDir()` from `@test/helpers`,
  not `mkdtemp` directly. An adapter double comes from `makeAgentAdapter(overrides)`, never an
  inline object literal.
- **Commits:** conventional commits (`feat(native):`, `refactor(native):`, `test(native):`),
  one concern each. The pre-commit hook runs typecheck + `check:all`; do not bypass it.

---

## File map

| File | Change | Responsibility |
|---|---|---|
| `src/agents/native/session/transcript-store.ts` | modify | `TranscriptIdentity`, `transcriptModelIdentity`, `model` on `TranscriptFile`, the load rule (`isForeignTranscript`) |
| `src/agents/native/session/session.ts` | modify | `SessionAnchor` (gains `model?`), `sessionAnchorFor` |
| `src/agents/native/session/turn-loop.ts` | modify | derive `transcriptIdentity` once; pass it to load/save; read the anchor via `sessionAnchorFor`; write `model` on the anchor; comment at `:112-118` |
| `src/agents/native/session/turn-complete-step.ts` | modify | comments only (`:58-64`, `:133-134`) |
| `src/agents/native/session/loop-events/types.ts` | modify | delete `previousModel`/`currentModel` (`:93-95`) |
| `test/unit/agents/native/transcript-store.test.ts` | modify | migrate 9 owner call sites; new model-identity tests |
| `test/unit/agents/native/session-lifecycle.test.ts` | modify | migrate 3 owner call sites; `sessionAnchorFor` unit tests; end-to-end SessionManager guard |
| `test/unit/agents/native/session/turn-loop-transcript-identity.test.ts` | **create** | `runNativeTurn`-level tests for the load rule and the anchor rule |
| `test/unit/agents/native/session/loop-events/turn-lifecycle.test.ts` | modify | comments only (`:64-73`, `:101`) |

---

### Task 1: `TranscriptIdentity` and the store's model rule

**Files:**
- Modify: `src/agents/native/session/transcript-store.ts` (the `TranscriptFile` interface at
  `:31-35`, `loadTranscript` at `:50-91`, `saveTranscript` at `:93-106`)
- Modify: `src/agents/native/session/turn-loop.ts:78-82`, `:394`, `:423` (call-site migration
  only)
- Test: `test/unit/agents/native/transcript-store.test.ts`,
  `test/unit/agents/native/session-lifecycle.test.ts` (call-site migration)

**Interfaces:**
- Produces:
  - `export interface TranscriptIdentity { readonly owner?: string; readonly model?: string }`
  - `export function transcriptModelIdentity(rawModel: string | undefined): string | undefined`
  - `loadTranscript(dir: string, sessionName: string, identity?: TranscriptIdentity): Promise<ConversationMessage[]>`
  - `saveTranscript(dir: string, sessionName: string, messages: readonly ConversationMessage[], identity?: TranscriptIdentity): Promise<void>`
- The positional `owner?: string` parameter of both functions is **replaced** by `identity`.

- [ ] **Step 1: Migrate the 12 existing owner-passing test call sites to the new shape**

These are exactly the sites a bracket-aware scan found on 2026-09-23. Each passes a literal
`"call-N"` owner as the last argument:
- `transcript-store.test.ts` lines 63, 64, 71, 72, 79, 85, 90, 96, 153
- `session-lifecycle.test.ts` lines 72, 78, 80

```bash
perl -pi -e 's/((?:load|save)Transcript\(.*), "(call-\d+)"\)/$1, { owner: "$2" })/' \
  test/unit/agents/native/transcript-store.test.ts \
  test/unit/agents/native/session-lifecycle.test.ts
grep -nE '(load|save)Transcript\(.*"call-[0-9]+"' \
  test/unit/agents/native/transcript-store.test.ts test/unit/agents/native/session-lifecycle.test.ts
```

Expected: every line the grep prints contains `{ owner: "call-` (12 lines). If a line still
ends `, "call-N")`, edit it by hand.

- [ ] **Step 2: Write the failing model-identity tests**

In `test/unit/agents/native/transcript-store.test.ts`:
- add `readFile` to the `node:fs/promises` import;
- add `transcriptModelIdentity` to the `@/agents/native/session/transcript-store` import;
- append at the end of the file:

```ts
describe("transcript store — model identity (nax#2150, P3 spec 8.3)", () => {
  const A = "openai/model-a";
  const B = "anthropic/model-b";

  test("a transcript loads for the model that saved it", async () => {
    await saveTranscript(dir, "sess-a", msgs, { model: A });
    expect(await loadTranscript(dir, "sess-a", { model: A })).toEqual(msgs);
  });

  test("a transcript saved by one model does not load for another", async () => {
    // The replay nax#2150 described: another model's thinking signatures are
    // meaningless (or a hard 400) to this one. Unreachable today because the
    // session layer closes on a model change; this is the store's own guard.
    await saveTranscript(dir, "sess-a", msgs, { model: A });
    expect(await loadTranscript(dir, "sess-a", { model: B })).toEqual([]);
  });

  test("a reader that declares no model still sees a transcript that records one", async () => {
    await saveTranscript(dir, "sess-a", msgs, { model: A });
    expect(await loadTranscript(dir, "sess-a")).toEqual(msgs);
  });

  test("a transcript with no recorded model loads for a reader that declares one", async () => {
    // Deliberately unlike an absent OWNER: every native production turn records
    // a model, so an absent one is a pre-upgrade file, which the owner check
    // already keeps out of new processes (spec 8.3(c)).
    await saveTranscript(dir, "sess-a", msgs);
    expect(await loadTranscript(dir, "sess-a", { model: A })).toEqual(msgs);
  });

  test("the owner is still enforced when the models agree", async () => {
    await saveTranscript(dir, "sess-a", msgs, { owner: "call-1", model: A });
    expect(await loadTranscript(dir, "sess-a", { owner: "call-2", model: A })).toEqual([]);
  });

  test("the model is enforced when the owners agree", async () => {
    await saveTranscript(dir, "sess-a", msgs, { owner: "call-1", model: A });
    expect(await loadTranscript(dir, "sess-a", { owner: "call-1", model: B })).toEqual([]);
  });

  test("save records the model when given and omits the key otherwise", async () => {
    await saveTranscript(dir, "sess-a", msgs, { model: A });
    const withModel: unknown = JSON.parse(await readFile(transcriptPath(dir, "sess-a"), "utf8"));
    expect(withModel).toMatchObject({ model: A });

    await saveTranscript(dir, "sess-b", msgs, { owner: "call-1" });
    const withoutModel: unknown = JSON.parse(await readFile(transcriptPath(dir, "sess-b"), "utf8"));
    expect(withoutModel).not.toHaveProperty("model");
  });
});

describe("transcriptModelIdentity", () => {
  test("keeps provider/model and strips the reasoning-effort suffix", () => {
    expect(transcriptModelIdentity("openai/gpt-5.4-mini[high]")).toBe("openai/gpt-5.4-mini");
    expect(transcriptModelIdentity("openai/gpt-5.4-mini")).toBe("openai/gpt-5.4-mini");
  });

  test("no model declares no identity", () => {
    expect(transcriptModelIdentity(undefined)).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run the store tests to verify they fail**

Run: `timeout 30 bun test test/unit/agents/native/transcript-store.test.ts --timeout=5000`

Expected: FAIL. The file fails to load, because `transcriptModelIdentity` is not exported
(`bun test` does not typecheck, so the missing export is the first thing to surface). Every
test in the file reports failure until Step 4.

- [ ] **Step 4: Implement the store change**

In `src/agents/native/session/transcript-store.ts`, add the import beside the existing ones:

```ts
import { parseModelSpec } from "../../model-spec";
```

Add these declarations directly after `transcriptPath`:

```ts
/**
 * Who may resume a transcript. `owner` is the op invocation (nax#1877); `model`
 * is the native model that wrote it (nax#2150, P3 spec 8.3). A field the caller
 * leaves undefined makes no claim, so non-op callers and tests read whatever is
 * there.
 */
export interface TranscriptIdentity {
  readonly owner?: string;
  readonly model?: string;
}

/**
 * The model half of `TranscriptIdentity`: the native `provider/model` id with
 * the reasoning-effort suffix stripped. A thinking signature binds to the
 * model, not to the effort — pi-ai's own `isSameModel` compares
 * provider/api/model for the same reason. `parseModelSpec`, not
 * `parseNativeModel`: this must never throw.
 */
export function transcriptModelIdentity(rawModel: string | undefined): string | undefined {
  return rawModel === undefined ? undefined : parseModelSpec(rawModel).model;
}
```

Keep the `TranscriptFile` docblock as it is, but insert these lines immediately before its
closing `*/`:

```ts
 *
 * `model` (nax#2150, P3 spec 8.3) records which model wrote the messages, so a
 * different model reads the file as a new conversation rather than replaying
 * thinking blocks that are meaningless to it.
```

Then replace the interface body:

```ts
interface TranscriptFile {
  readonly owner?: string;
  readonly model?: string;
  readonly savedAt: string;
  readonly messages: ConversationMessage[];
}
```

Replace `loadTranscript`'s signature and its post-parse tail. The read and parse at the top
are unchanged. Update the docblock's owner sentence to say "a different `owner` or a different
recorded `model` than the caller (nax#1877, nax#2150)".

```ts
export async function loadTranscript(
  dir: string,
  sessionName: string,
  identity: TranscriptIdentity = {},
): Promise<ConversationMessage[]> {
  // (the existing `let raw` / readFile / JSON.parse block goes here, unchanged)

  if (isLegacyTranscript(parsed)) {
    // Unowned history is foreign history to a reader that has an identity.
    // Dropping it is the safe direction: the cost is one re-exploration, where
    // inheriting it silently bills a conversation this session never had.
    return identity.owner === undefined ? parsed : [];
  }

  const file = parsed as TranscriptFile;
  if (isForeignTranscript(file, identity, sessionName)) return [];
  return file.messages ?? [];
}

/**
 * Another invocation's history (nax#1877) or another model's (nax#2150, P3
 * spec 8.3(c)) reads as a new conversation. An ABSENT file model reads, unlike
 * an absent owner: every native production turn records one (the adapter parses
 * the model before the loop runs), so an absent field is a pre-upgrade file —
 * which the owner check already keeps out of new processes.
 */
function isForeignTranscript(file: TranscriptFile, identity: TranscriptIdentity, sessionName: string): boolean {
  const { owner, model } = identity;
  if (owner !== undefined && file.owner !== owner) {
    getLogger().debug("native-session", "Ignoring a transcript owned by another invocation", {
      sessionName,
      storedOwner: file.owner,
      owner,
    });
    return true;
  }
  if (model !== undefined && file.model !== undefined && file.model !== model) {
    getLogger().debug("native-session", "Ignoring a transcript written by another model", {
      sessionName,
      storedModel: file.model,
      model,
    });
    return true;
  }
  return false;
}
```

Replace `saveTranscript`:

```ts
export async function saveTranscript(
  dir: string,
  sessionName: string,
  messages: readonly ConversationMessage[],
  identity: TranscriptIdentity = {},
): Promise<void> {
  await mkdir(dir, { recursive: true });
  const file: TranscriptFile = {
    ...(identity.owner !== undefined ? { owner: identity.owner } : {}),
    ...(identity.model !== undefined ? { model: identity.model } : {}),
    savedAt: new Date().toISOString(),
    messages: [...messages],
  };
  await writeFile(transcriptPath(dir, sessionName), JSON.stringify(file, null, 2), "utf8");
}
```

In `src/agents/native/session/turn-loop.ts`:
- change the import to `import { loadTranscript, saveTranscript, type TranscriptIdentity } from "./transcript-store";`
- replace lines 78-82 with:

```ts
  // nax#1877: an owner mismatch reads as a new conversation, so an abandoned
  // invocation's history cannot ride along on the first request of this one.
  const transcriptIdentity: TranscriptIdentity = { owner: nativeSessionTranscriptOwners.get(handle.id) };
  let messages: NativeTranscriptMessage[] = [...(await loadTranscript(dir, handle.id, transcriptIdentity))];
```

- at `:394` and `:423`, replace the fourth argument `transcriptOwner` with
  `transcriptIdentity`. Then run `grep -n transcriptOwner src/agents/native/session/turn-loop.ts`;
  expected: no output.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `timeout 120 bun test test/unit/agents/native/ --timeout=10000` (the store and
session-lifecycle files are under that directory)

Expected: all pass.

Run: `bun run typecheck`

Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/agents/native/session/transcript-store.ts src/agents/native/session/turn-loop.ts \
  test/unit/agents/native/transcript-store.test.ts test/unit/agents/native/session-lifecycle.test.ts
git commit -m "feat(native): the transcript store refuses a recorded different model (nax#2150)

TranscriptFile records the model that wrote it, and loadTranscript reads a
recorded different model as a new conversation, beside the nax#1877 owner
check. Owner and model travel together as TranscriptIdentity, replacing the
positional owner argument. An absent file model reads: every native production
turn records one, so absence means a pre-upgrade file. Spec: P3 section 8.3(a)-(c), (e)."
```

---

### Task 2: `runNativeTurn` records and enforces the model

**Files:**
- Modify: `src/agents/native/session/turn-loop.ts` (the `transcriptIdentity` line from Task 1)
- Create: `test/unit/agents/native/session/turn-loop-transcript-identity.test.ts`

**Interfaces:**
- Consumes: `TranscriptIdentity` and `transcriptModelIdentity` from Task 1.
- Produces: `turn-loop.ts` holds `transcriptIdentity` with **both** `owner` and `model`.
  Task 3 reads `transcriptIdentity.model`.

- [ ] **Step 1: Write the failing turn-level tests**

Create `test/unit/agents/native/session/turn-loop-transcript-identity.test.ts`:

```ts
/**
 * P3 spec 8.3: runNativeTurn derives the transcript's model identity from
 * handle.modelDef, records it on save, and a turn on a DIFFERENT model reads
 * the transcript as a new conversation (nax#2150). Driven through the real
 * runNativeTurn and store (spec 9.1) — only the provider is faked.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import type { ConversationMessage } from "@nathapp/nax-ai";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { createLoopEventRegistry, type LoopEventRegistry } from "@/agents/native/session/loop-events";
import { nativeSessionLastUsage, nativeTranscriptDirs } from "@/agents/native/session/session";
import { transcriptPath } from "@/agents/native/session/transcript-store";
import { runNativeTurn } from "@/agents/native/session/turn-loop";
import type { SendTurnOpts, SessionHandle } from "@/agents/session-types";

const SESSION = "sess-transcript-identity";
let dir: string;

beforeEach(() => {
  dir = makeTempDir("nax-transcript-identity-");
  nativeTranscriptDirs.set(SESSION, dir);
});
afterEach(() => {
  nativeTranscriptDirs.delete(SESSION);
  // Module-level state keyed by session id: a stale anchor would leak into
  // the next test (turn-lifecycle.test.ts's hygiene note).
  nativeSessionLastUsage.delete(SESSION);
  cleanupTempDir(dir);
});

const onModel = (model?: string): SessionHandle => ({
  id: SESSION,
  agentName: "native",
  ...(model !== undefined ? { modelDef: { provider: "unknown", model } } : {}),
});

const opts: SendTurnOpts = { interactionHandler: { onInteraction: async () => ({ answer: "" }) } };

const reply = {
  text: "done",
  thinking: [{ text: "pondering", signature: "sig-a" }],
  usage: { inputTokens: 1, outputTokens: 1 },
  costUsd: 0,
};

/** Runs one turn and returns every message array the provider was sent. */
async function turn(
  handle: SessionHandle,
  prompt: string,
  loopEvents: LoopEventRegistry = createLoopEventRegistry(),
): Promise<ConversationMessage[][]> {
  const sent: ConversationMessage[][] = [];
  await runNativeTurn(handle, prompt, opts, {
    loopEvents,
    complete: async (messages) => {
      // Copied, not aliased: the loop pushes the reply onto the array afterwards.
      sent.push([...messages]);
      return reply;
    },
  });
  return sent;
}

describe("runNativeTurn — transcript model identity (nax#2150, P3 spec 8.3)", () => {
  test("the saved transcript records the model that wrote it, effort suffix stripped", async () => {
    await turn(onModel("openai/model-a[high]"), "first");
    const file: unknown = JSON.parse(await readFile(transcriptPath(dir, SESSION), "utf8"));
    expect(file).toMatchObject({ model: "openai/model-a" });
  });

  test("a turn on a different model starts a new conversation", async () => {
    await turn(onModel("openai/model-a"), "first");
    const historySeen: unknown[] = [];
    const registry = createLoopEventRegistry();
    registry.register("before_turn", (p) => {
      historySeen.push(p.history);
      return {};
    });
    const sent = await turn(onModel("anthropic/model-b"), "second", registry);
    expect(sent[0]).toEqual([{ role: "user", content: "second" }]);
    expect(historySeen).toEqual([[]]);
  });

  test("control: the same model keeps the conversation", async () => {
    // Without this, a store that rejected EVERY load would pass the test above.
    await turn(onModel("openai/model-a"), "first");
    const sent = await turn(onModel("openai/model-a"), "second");
    expect(sent[0]).toHaveLength(3);
    expect(sent[0]?.[1]).toMatchObject({ role: "assistant", thinking: [{ signature: "sig-a" }] });
  });

  test("an effort-only change keeps the conversation", async () => {
    await turn(onModel("openai/model-a"), "first");
    const sent = await turn(onModel("openai/model-a[high]"), "second");
    expect(sent[0]).toHaveLength(3);
  });

  test("a handle with no model makes no claim", async () => {
    await turn(onModel("openai/model-a"), "first");
    const sent = await turn(onModel(), "second");
    expect(sent[0]).toHaveLength(3);
  });
});
```

(`LoopEventRegistry` is re-exported from the barrel,
`src/agents/native/session/loop-events/index.ts`. Verified 2026-09-23.)

- [ ] **Step 2: Run the tests to verify the right ones fail**

Run: `timeout 30 bun test test/unit/agents/native/session/turn-loop-transcript-identity.test.ts --timeout=5000`

Expected:
- FAIL: "the saved transcript records the model…" (no `model` key yet).
- FAIL: "a turn on a different model starts a new conversation" (history is replayed:
  `sent[0]` has 3 messages).
- PASS: the three control tests.

- [ ] **Step 3: Implement**

In `src/agents/native/session/turn-loop.ts`:
- add `transcriptModelIdentity` to the `./transcript-store` import;
- replace the Task 1 `transcriptIdentity` block with:

```ts
  // nax#1877: an owner mismatch reads as a new conversation, so an abandoned
  // invocation's history cannot ride along on the first request of this one.
  // nax#2150 (P3 spec 8.3): so does a recorded different model — the store
  // owns that guarantee, whatever the session layer above decided.
  const transcriptIdentity: TranscriptIdentity = {
    owner: nativeSessionTranscriptOwners.get(handle.id),
    model: transcriptModelIdentity(handle.modelDef?.model),
  };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `timeout 30 bun test test/unit/agents/native/session/turn-loop-transcript-identity.test.ts --timeout=5000`

Expected: all 5 pass.

Run: `timeout 120 bun test test/unit/agents/native/ --timeout=10000`

Expected: all pass. Tests that seed a transcript with no model and then turn on a `modelDef`
handle, such as `adapter-complete-rates.test.ts:430`, keep working because an absent file
model reads.

- [ ] **Step 5: Commit**

```bash
git add src/agents/native/session/turn-loop.ts test/unit/agents/native/session/turn-loop-transcript-identity.test.ts
git commit -m "feat(native): runNativeTurn records and enforces the transcript's model

The turn derives the model identity from handle.modelDef, so every save
records it and a turn on a different model reads the transcript as a new
conversation. An effort-only change and a model-less handle keep the
conversation. Spec: P3 section 8.3(b)."
```

---

### Task 3: The persisted anchor is per model

**Files:**
- Modify: `src/agents/native/session/session.ts:110-119` (`nativeSessionLastUsage`)
- Modify: `src/agents/native/session/turn-loop.ts:108` (anchor read), `:278` (anchor write)
- Test: `test/unit/agents/native/session-lifecycle.test.ts` (helper unit tests)
- Test: `test/unit/agents/native/session/turn-loop-transcript-identity.test.ts` (wiring)

**Interfaces:**
- Consumes: `transcriptIdentity.model` in `turn-loop.ts` (Task 2).
- Produces:
  - `export interface SessionAnchor { readonly promptTokens: number; readonly anchorIndex: number; readonly model?: string }`
  - `export const nativeSessionLastUsage: Map<string, SessionAnchor>`
  - `export function sessionAnchorFor(sessionName: string, model: string | undefined): SessionAnchor | undefined`

- [ ] **Step 1: Write the failing helper tests**

In `test/unit/agents/native/session-lifecycle.test.ts`, add `sessionAnchorFor` to the
`@/agents/native/session/session` import, then append:

```ts
describe("sessionAnchorFor — the persisted anchor is per model (P3 spec 8.3(d))", () => {
  const NAME = "sess-anchor";
  afterEach(() => {
    nativeSessionLastUsage.delete(NAME);
  });

  test("an anchor measured under another model is dropped", () => {
    // Prefix stability is a property of (model, prefix) (spec 3.3): this anchor
    // indexes history the transcript store refused.
    nativeSessionLastUsage.set(NAME, { promptTokens: 10, anchorIndex: 3, model: "openai/model-a" });
    expect(sessionAnchorFor(NAME, "anthropic/model-b")).toBeUndefined();
    expect(nativeSessionLastUsage.has(NAME)).toBe(false);
  });

  test("an anchor measured under the same model is kept", () => {
    const entry = { promptTokens: 10, anchorIndex: 3, model: "openai/model-a" };
    nativeSessionLastUsage.set(NAME, entry);
    expect(sessionAnchorFor(NAME, "openai/model-a")).toEqual(entry);
    expect(nativeSessionLastUsage.has(NAME)).toBe(true);
  });

  test("an anchor with no recorded model makes no claim", () => {
    const entry = { promptTokens: 10, anchorIndex: 0 };
    nativeSessionLastUsage.set(NAME, entry);
    expect(sessionAnchorFor(NAME, "openai/model-b")).toEqual(entry);
  });

  test("a turn with no model makes no claim", () => {
    const entry = { promptTokens: 10, anchorIndex: 3, model: "openai/model-a" };
    nativeSessionLastUsage.set(NAME, entry);
    expect(sessionAnchorFor(NAME, undefined)).toEqual(entry);
  });
});
```

- [ ] **Step 2: Write the failing wiring tests**

Append to `test/unit/agents/native/session/turn-loop-transcript-identity.test.ts`. The
observable is `transform_context`'s `anchorIndex`: the dispatcher passes the turn's live anchor
into that payload (`turn-complete-step.ts:138`), so the first payload shows exactly which
anchor the first request used.

**The anchor of a one-round-trip turn is 0, not 1.** `turn-loop.ts:277` records
`anchorIndex = messages.length - 1` *before* the assistant message is pushed (the comment at
`:293` says so), so after a single `[user]` request it is 0. The assertions below depend on
that. The model-less seed uses 5, a value no real turn in these tests produces, so its
assertion cannot pass by coincidence.

```ts
describe("runNativeTurn — the persisted anchor is per model (P3 spec 8.3(d))", () => {
  /** Runs one turn and returns the anchorIndex its FIRST request was sized against. */
  async function firstAnchorSeen(handle: SessionHandle): Promise<number | undefined> {
    const seen: (number | undefined)[] = [];
    const registry = createLoopEventRegistry();
    registry.register("transform_context", (p) => {
      seen.push(p.anchorIndex);
      return {};
    });
    await turn(handle, "second", registry);
    return seen[0];
  }

  test("a turn on another model does not read the previous model's anchor", async () => {
    await turn(onModel("openai/model-a"), "first");
    // Recorded before the assistant push: [user "first"] -> index 0.
    expect(nativeSessionLastUsage.get(SESSION)).toMatchObject({ model: "openai/model-a", anchorIndex: 0 });

    expect(await firstAnchorSeen(onModel("anthropic/model-b"))).toBeUndefined();
    // The entry left behind is B's own (B's history was refused: [user "second"] -> 0).
    expect(nativeSessionLastUsage.get(SESSION)).toMatchObject({ model: "anthropic/model-b", anchorIndex: 0 });
  });

  test("control: a turn on the same model reads its anchor", async () => {
    await turn(onModel("openai/model-a"), "first");
    expect(await firstAnchorSeen(onModel("openai/model-a"))).toBe(0);
  });

  test("an anchor with no recorded model is still read (the PR 2 fixtures' state)", async () => {
    // transform-context.test.ts:50 seeds this shape: an anchor, no model, no
    // transcript. Pinned so the fixture's behaviour is intended, not accidental.
    // 5, not 0: no real turn here records 5, so this cannot pass by coincidence.
    nativeSessionLastUsage.set(SESSION, { promptTokens: 100, anchorIndex: 5 });
    expect(await firstAnchorSeen(onModel("openai/model-a"))).toBe(5);
  });
});
```

- [ ] **Step 3: Run the tests to verify the right ones fail**

Run: `timeout 60 bun test test/unit/agents/native/session-lifecycle.test.ts test/unit/agents/native/session/turn-loop-transcript-identity.test.ts --timeout=5000`

Expected:
- FAIL: `session-lifecycle.test.ts` fails to load, because `sessionAnchorFor` is not exported.
  That fails every test in the file until Step 4.
- FAIL: "a turn on another model does not read the previous model's anchor". The entry has
  no `model`, so the first `toMatchObject` fails.
- PASS: "control: a turn on the same model reads its anchor" and "an anchor with no recorded
  model is still read". Both already hold, and they must keep holding after Step 4.

- [ ] **Step 4: Implement**

In `src/agents/native/session/session.ts`, keep the `nativeSessionLastUsage` docblock as it is
but insert these lines immediately before its closing `*/`:

```ts
 *
 * `model` is the transcript model identity the anchor was measured under
 * (P3 spec 8.3(d)); read it through `sessionAnchorFor`, never directly.
```

Then replace the single line
`export const nativeSessionLastUsage = new Map<string, { promptTokens: number; anchorIndex: number }>();`
with:

```ts
export interface SessionAnchor {
  readonly promptTokens: number;
  readonly anchorIndex: number;
  readonly model?: string;
}
export const nativeSessionLastUsage = new Map<string, SessionAnchor>();

/**
 * The persisted anchor a turn on `model` may use. Prefix stability is a
 * property of (model, prefix) (P3 spec 3.3): an anchor measured under a
 * different model indexes history the transcript store refused (spec 8.3(c)),
 * so it is dropped here rather than mis-sizing the next compaction decision.
 * An entry or a turn with no model makes no claim — the store's own rule.
 */
export function sessionAnchorFor(sessionName: string, model: string | undefined): SessionAnchor | undefined {
  const entry = nativeSessionLastUsage.get(sessionName);
  if (entry?.model === undefined || model === undefined || entry.model === model) return entry;
  nativeSessionLastUsage.delete(sessionName);
  return undefined;
}
```

In `src/agents/native/session/turn-loop.ts`:
- add `sessionAnchorFor` to the `./session` import (keep `nativeSessionLastUsage`, which the
  write still uses);
- `const anchor = nativeSessionLastUsage.get(handle.id);` (originally `:108`) becomes
  `const anchor = sessionAnchorFor(handle.id, transcriptIdentity.model);`
- `nativeSessionLastUsage.set(handle.id, { promptTokens, anchorIndex });` (originally `:278`)
  becomes:

```ts
        nativeSessionLastUsage.set(handle.id, {
          promptTokens,
          anchorIndex,
          ...(transcriptIdentity.model !== undefined ? { model: transcriptIdentity.model } : {}),
        });
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `timeout 60 bun test test/unit/agents/native/session-lifecycle.test.ts test/unit/agents/native/session/turn-loop-transcript-identity.test.ts --timeout=5000`

Expected: all pass.

Run: `timeout 120 bun test test/unit/agents/native/ --timeout=10000`

Expected: all pass. In particular `session/loop-events/transform-context.test.ts`, whose
model-less anchor seed must still be honoured.

- [ ] **Step 6: Commit**

```bash
git add src/agents/native/session/session.ts src/agents/native/session/turn-loop.ts \
  test/unit/agents/native/session-lifecycle.test.ts test/unit/agents/native/session/turn-loop-transcript-identity.test.ts
git commit -m "feat(native): the persisted cache anchor is per model

nativeSessionLastUsage records the model its anchor was measured under, and
sessionAnchorFor drops an anchor from a different model: it indexes history the
transcript store refused, and would mis-size the next compaction decision. An
entry or a turn with no model makes no claim. Spec: P3 section 8.3(d)."
```

---

### Task 4: Remove the payload fields that can never be populated

**Files:**
- Modify: `src/agents/native/session/loop-events/types.ts:93-95`
- Modify: `src/agents/native/session/turn-loop.ts:112-118` (comment)
- Modify: `src/agents/native/session/turn-complete-step.ts:58-64`, `:133-134` (comments)
- Modify: `test/unit/agents/native/session/loop-events/turn-lifecycle.test.ts:64-73`, `:101` (comments)

**Interfaces:**
- Produces: `BeforeTurnPayload` without `previousModel`/`currentModel`. `boundary` stays
  (spec §8.3(f)).

- [ ] **Step 1: Delete the fields**

In `src/agents/native/session/loop-events/types.ts`, delete these three lines from
`BeforeTurnPayload`:

```ts
  /** PR 3 populates these from TranscriptFile.model; undefined until then. */
  readonly previousModel?: string;
  readonly currentModel?: string;
```

- [ ] **Step 2: Rewrite the stale comments**

`src/agents/native/session/turn-loop.ts`: replace the 7-line comment above
`const turnStart = await loopEvents.dispatch("before_turn", {` with:

```ts
  // P3 `before_turn` (spec 6.1): fires ONCE, after the transcript loads and
  // before the seed push. `boundary` is dispatcher-computed (spec 3.4) and
  // always false: the model-change boundary never arises, because the
  // transcript store refuses another model's history (spec 8.3), so the
  // history channel is honoured only at an undefined anchor (spec 3.5) — an
  // off-boundary patch is rejected + warned by applyHistoryPatch and the turn
  // proceeds on the loaded history.
```

`src/agents/native/session/turn-complete-step.ts:58-64`: replace the docblock body with:

```ts
  /**
   * True when the honoured rewrite (if any) rode the boundary exemption —
   * the post-compaction retry is the only boundary this step can produce
   * (`compacted`; spec 3.4: a handler may never assert one). Paired with
   * `honoured` rather than folded into it: the step-level contract keeps both
   * facts.
   */
```

`src/agents/native/session/turn-complete-step.ts:133-134`: replace

```ts
    // where a prefix rewrite is free. A model change is a turn-start fact and
    // is NOT consulted here (spec 8.2 — it belongs to before_turn, PR 3).
```

with

```ts
    // where a prefix rewrite is free. A model change never reaches this step:
    // the transcript store refuses another model's history (spec 8.3).
```

`test/unit/agents/native/session/loop-events/turn-lifecycle.test.ts`: in the describe
docblock (`:64-73`), replace the last three prose lines

```
 * but is CLOSED today: the boundary is dispatcher-computed and false until
 * PR 3 records the model on TranscriptFile (spec 8.3), so every off-boundary
 * history patch is rejected — the channel is pinned shut, not stubbed away.
```

with

```
 * but is closed: the boundary is dispatcher-computed and always false — the
 * transcript store refuses another model's history (spec 8.3) — so every
 * off-boundary history patch is rejected; the channel is pinned shut, not
 * stubbed away.
```

and at `:101` replace

```ts
    // previousModel/currentModel are PR 3's (spec 8.3): undefined until then.
```

with

```ts
    // previousModel/currentModel were removed (spec 8.3(f)): cross-model
    // history never reaches before_turn. These assertions pin the removal.
```

- [ ] **Step 3: Verify**

Run: `grep -rn "previousModel\|currentModel" src/agents/native test/unit/agents/native`

Expected: only the two `not.toHaveProperty("previousModel")`/`("currentModel")` assertions in
`turn-lifecycle.test.ts`.

Run: `grep -rn "PR 3" src/agents/native test/unit/agents/native`

Expected: no output.

Run: `bun run typecheck && timeout 60 bun test test/unit/agents/native/session/loop-events/ --timeout=5000`

Expected: clean typecheck; all pass.

- [ ] **Step 4: Commit**

```bash
git add src/agents/native/session/loop-events/types.ts src/agents/native/session/turn-loop.ts \
  src/agents/native/session/turn-complete-step.ts test/unit/agents/native/session/loop-events/turn-lifecycle.test.ts
git commit -m "refactor(native): drop before_turn's previousModel/currentModel

They were reserved for a nax#2150 handler that the re-scoped PR 3 does not
build: cross-model history never reaches before_turn, so the fields could never
be populated - a channel that writes nowhere (spec section 12's own rule). The
stale 'PR 3' comments go with them. Spec: P3 section 8.3(f)."
```

---

### Task 5: End-to-end guard through the real `SessionManager`

**Files:**
- Test: `test/unit/agents/native/session-lifecycle.test.ts` (append; the file already mixes
  `SessionManager` with the native session functions, and stays well under 650 lines)

**Interfaces:**
- Consumes: `SessionManager`, `openNativeSession`, `closeNativeSession`, `runNativeTurn`, and
  `makeAgentAdapter` from `@test/helpers`.

This test proves the guarantee end to end. `decideReuse` routes a model change to a close;
after that, two layers each keep the old history away from the new model:
1. the native close deletes (or renames) the transcript;
2. the store refuses a recorded different model (this PR).

The test keeps passing if **either** of those regresses alone. A `decideReuse` regression is
different: the old handle, carrying the OLD model, would be reused (#1965's bug). The history
would then replay to that same model and this test **fails**, which is also a regression worth
catching.

It has no RED phase against the current tree, because every layer already holds. Its RED
check is Step 2's deliberate sabotage.

- [ ] **Step 1: Write the test**

In `test/unit/agents/native/session-lifecycle.test.ts`:
- add `import { runNativeTurn } from "@/agents/native/session/turn-loop";`;
- add `clearNativeSessionState` to the existing `@/agents/native/session/session` import;
- then append:

```ts
describe("a model change on a session name is a new conversation, end to end (nax#2150)", () => {
  // Two layers hold this: SessionManager's decideReuse closes on an endpoint
  // change (#1965) and the native close deletes the transcript; and the store
  // refuses another model's history (P3 spec 8.3). Real SessionManager, native
  // open/close, runNativeTurn and store — only the provider is faked.
  const NAME = "nax-model-change-us-001-implementer";
  afterEach(() => {
    // A failed assertion skips the closeSession at the end of a test; do not
    // let this name's native session state leak into the next one.
    clearNativeSessionState(NAME);
  });

  const request = (model: string): OpenSessionRequest => ({
    agentName: "native",
    workdir: "/tmp",
    pipelineStage: "run",
    modelDef: { provider: "unknown", model },
    timeoutSeconds: 60,
    transcriptDir: dir,
    transcriptOwner: "call-1",
  });

  const turnOpts: SendTurnOpts = { interactionHandler: { onInteraction: async () => ({ answer: "" }) } };

  async function sendOn(handle: SessionHandle, prompt: string): Promise<unknown[][]> {
    const sent: unknown[][] = [];
    await runNativeTurn(handle, prompt, turnOpts, {
      complete: async (messages) => {
        sent.push([...messages]);
        return {
          text: "done",
          thinking: [{ text: "pondering", signature: "sig-first-model" }],
          usage: { inputTokens: 1, outputTokens: 1 },
          costUsd: 0,
        };
      },
    });
    return sent;
  }

  const nativeManager = (): SessionManager => {
    const adapter = makeAgentAdapter({
      openSession: (name: string, o: OpenSessionOpts) => openNativeSession(name, o),
      closeSession: (h: SessionHandle) => closeNativeSession(h),
    });
    return new SessionManager({ getAdapter: () => adapter });
  };

  test("the second model's first request carries only its own prompt", async () => {
    const sm = nativeManager();
    const first = await sm.openSession(NAME, request("openai/model-a"));
    await sendOn(first, "first");
    const second = await sm.openSession(NAME, request("anthropic/model-b"));
    const sent = await sendOn(second, "second");
    expect(sent[0]).toEqual([{ role: "user", content: "second" }]);
    await sm.closeSession(second);
  });

  test("control: the same model on the same name keeps the conversation", async () => {
    // Without this, a harness that never replays anything would pass the test above.
    const sm = nativeManager();
    const first = await sm.openSession(NAME, request("openai/model-a"));
    await sendOn(first, "first");
    const again = await sm.openSession(NAME, request("openai/model-a"));
    expect(again).toBe(first);
    const sent = await sendOn(again, "second");
    expect(sent[0]).toHaveLength(3);
    await sm.closeSession(again);
  });
});
```

- [ ] **Step 2: Run it, then prove it can fail**

Run: `timeout 30 bun test test/unit/agents/native/session-lifecycle.test.ts --timeout=5000`

Expected: all pass.

Sabotage check. Do **not** commit these edits:
1. In `src/agents/native/session/session.ts` `closeNativeSession`, temporarily comment out the
   `await deleteTranscript(dir, handle.id);` line in the non-failed branch. Re-run: the new
   test **still passes**, because the store layer refuses model A's transcript.
2. Additionally, in `transcript-store.ts` `isForeignTranscript`, temporarily delete the model
   branch (the second `if`). Re-run: "the second model's first request carries only its own
   prompt" **fails**, with 3 messages sent.
3. Revert both with
   `git checkout src/agents/native/session/session.ts src/agents/native/session/transcript-store.ts`.
   **Careful:** `git checkout <file>` restores from the INDEX, so commit Task 3's `session.ts`
   change before doing this (Task 3's commit step already does). Confirm
   `git status --short src/` is empty.

Do not sabotage `decideReuse` to prove the store: a reused handle keeps the OLD model, so the
store sees the same model and cannot help. That regression makes this test fail, as intended
(see above).

- [ ] **Step 3: Commit**

```bash
git add test/unit/agents/native/session-lifecycle.test.ts
git commit -m "test(native): a model change on a session name is a new conversation, end to end

Drives the real SessionManager, native open/close, runNativeTurn and transcript
store with only the provider faked. Once decideReuse routes the model change to
a close, it passes as long as either layer holds - the close removing the
transcript, or the store refusing another model's history - and fails only if
both regress. Same-model control included. Spec: P3 section 9."
```

---

### Task 6: Verification and pre-PR review

**Files:** none new.

- [ ] **Step 1: Full gates**

```bash
bun run typecheck
bun run lint
bun run test
bun run test:coverage
```

Expected: all green. `test:coverage` enforces the per-file floor. `transcript-store.ts` and
`session.ts` gained covered branches, so neither should drop. If the ratchet reports a file
**improved**, do not run `--update-baseline` unless asked.

- [ ] **Step 2: Spec coverage check**

Re-read spec §8.3(a)–(g) and §9 "PR 3 (re-scoped)", and tick each item against a commit:

| Spec item | Task |
|---|---|
| (a) `model` on `TranscriptFile` | 1 |
| (b) identity via `parseModelSpec`, from `handle.modelDef` | 1 (helper), 2 (wiring) |
| (c) load rule, absent file model reads | 1 |
| (d) per-model anchor | 3 |
| (e) `TranscriptIdentity`, 12 test sites | 1 |
| (f) dead fields + comments removed; `boundary` kept | 4 |
| (g) no change to `decideReuse`, close, nax-ai | `git diff main...HEAD --stat -- src/session/ package.json bun.lock` prints nothing |
| §9 store rows, turn level, anchor read directly, composite guard, removal pinned | 1, 2, 3, 5, 4 |

- [ ] **Step 3: Code review BEFORE push**

Run the `nax-toolkit:post-impl-review` skill with this spec, or the `code-reviewer` agent, on
`git diff main...HEAD`. Address CRITICAL/HIGH findings before pushing.

- [ ] **Step 4: Push and open the PR (only on the user's go-ahead)**

PR title: `feat(native): the transcript store refuses cross-model history (P3 PR 3)`

The PR body must include:
- **Why**: nax#2150 is unreachable on `main` (spec §8.1). The guarantee is now owned by the
  store, which moves into `nax-coding` at P6 (D8).
- **Carrying history across a swap was measured and rejected** (spec §8.2, one paragraph).
- **Latent, not filed:** nax-ai's `toPiMessages` (`dist/protocols/pi-client.js:87-91`) stamps
  every replayed assistant message with the *current* model, which defeats pi-ai's
  `transformMessages` `isSameModel` gate. It has nil blast radius while cross-model history
  never reaches the wire, which this PR now guarantees in two layers.
- **Test-site migration:** 12 call sites, `"call-N"` became `{ owner: "call-N" }`.
- `Refs nax#2150` (already closed as not reproducible, with evidence).
