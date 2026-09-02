# Native Sessions (Phase B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the native transport multi-turn sessions and structured pull-tool calls, so `tdd-verifier`, `review-semantic` and `review-adversarial` can run on it.

**Architecture:** nax owns the conversation because nax-ai's client is stateless. A transcript file per session lives under a directory the caller supplies; the native adapter implements `openSession`/`sendTurn`/`closeSession` around a loop that calls `complete()` with tool definitions and hands any tool call to the **existing** `InteractionHandler` seam. Nothing new executes a tool. The ACP path is untouched.

**Tech Stack:** Bun, TypeScript, `@nathapp/nax-ai@0.1.4`.

**Spec:** `docs/superpowers/specs/2026-09-02-native-sessions-phase-b-design.md`
**Decision record:** `docs/adr/ADR-028-native-sessions-and-tool-loop.md`

## Global Constraints

- **All new code lives under `src/agents/native/session/`.** `scripts/check-nax-ai-imports.ts` permits `@nathapp/nax-ai` imports only under `src/agents/native/` — outside it, importing nax-ai fails the gate.
- **Do not touch the ACP path.** `src/agents/acp/**` keeps its regex protocol and prompt preamble exactly as they are. Two protocols coexist by design.
- **Do not reach into the context engine from the adapter.** Tool calls go through `InteractionHandler.onInteraction({ kind: "context-tool", name, input })` → `{ answer: string }`, the seam `src/agents/acp/adapter.ts:484-485` already uses.
- **Do not add a second turn cap.** `SendTurnOpts.maxTurns` already exists, default 10 (`src/agents/session-types.ts:102-103`).
- **`src/agents/acp/adapter.ts` is at 590/600 lines** and `scripts/check-file-sizes.ts` refuses growth on baselined files. Nothing in this plan should need to edit it.
- **Fail loudly, never default a path.** An absent `transcriptDir` throws. Silently choosing one is #1794's empty-`packageDir` bug a layer up.
- Run `bun run typecheck && bun run lint && bun run test` before every commit; all 23 gate scripts must stay green.

---

### Task 1: Prove the nax-ai tool round-trip live

The feasibility analysis records that the live test asserts a tool-call event is *emitted* and stops there — feeding a result back and getting a coherent continuation is only unit-tested against the request builder. Every later task assumes it works.

**Files:**
- Create: `test/live/native-tool-round-trip.live.test.ts`

**Interfaces:**
- Produces: proof that `complete()` → `toolCalls` → `tool-result` message → coherent continuation works against a real provider. No exported code.

- [ ] **Step 1: Write the live test**

```ts
// RE-ARCH: keep
import { describe, expect, test } from "bun:test";
import { getNativeClient } from "@/agents/native/client";

// Live: costs money and needs a credential. Opt in with NAX_LIVE=1.
const live = process.env.NAX_LIVE === "1" ? test : test.skip;

describe("nax-ai tool round-trip (live)", () => {
  live("a tool result fed back produces a coherent continuation", async () => {
    const client = await getNativeClient();
    const model = await client.model("openrouter", "deepseek/deepseek-v4-flash");

    const tools = [
      {
        name: "get_secret_number",
        description: "Returns the secret number. Call this when asked for it.",
        inputSchema: { type: "object" as const, properties: {}, additionalProperties: false },
      },
    ];

    const first = await client.complete(model, {
      messages: [{ role: "user", content: "What is the secret number? Use the tool." }],
      tools,
    });

    expect(first.toolCalls?.length ?? 0).toBeGreaterThan(0);
    const call = first.toolCalls![0];
    expect(call.name).toBe("get_secret_number");

    const second = await client.complete(model, {
      messages: [
        { role: "user", content: "What is the secret number? Use the tool." },
        { role: "assistant", content: first.text, toolCalls: first.toolCalls },
        { role: "tool-result", toolCallId: call.id, content: "42" },
      ],
      tools,
    });

    expect(second.text).toContain("42");
  }, 60_000);
});
```

- [ ] **Step 2: Run it live**

```bash
NAX_LIVE=1 bun test test/live/native-tool-round-trip.live.test.ts
```

Expected: PASS. **If it fails, stop and report — the rest of this plan rests on it.** A failure here is a nax-ai defect, not a nax one, and is fixed in that repo before continuing.

- [ ] **Step 3: Confirm it skips without the flag**

```bash
bun test test/live/native-tool-round-trip.live.test.ts
```

Expected: 1 skipped, 0 failed. CI must not spend money.

- [ ] **Step 4: Commit**

```bash
git add test/live/native-tool-round-trip.live.test.ts
git commit -m "test(native): prove the nax-ai tool round-trip end-to-end

The analysis recorded that only tool-call emission was proven; feeding a result
back was untested. Every part of Phase B rests on the continuation."
```

---

### Task 2: The transcript store

**Files:**
- Create: `src/agents/native/session/transcript-store.ts`
- Test: `test/unit/agents/native/transcript-store.test.ts`

**Interfaces:**
- Produces:
  - `loadTranscript(dir: string, sessionName: string): Promise<ConversationMessage[]>` — `[]` when no file exists.
  - `saveTranscript(dir: string, sessionName: string, messages: readonly ConversationMessage[]): Promise<void>` — creates `dir` if needed; throws on write failure.
  - `deleteTranscript(dir: string, sessionName: string): Promise<void>` — succeeds when the file is already gone.
  - `transcriptPath(dir: string, sessionName: string): string`.

- [ ] **Step 1: Write the failing tests**

```ts
// RE-ARCH: keep
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConversationMessage } from "@nathapp/nax-ai";
import {
  deleteTranscript,
  loadTranscript,
  saveTranscript,
  transcriptPath,
} from "@/agents/native/session/transcript-store";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nax-transcript-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const msgs: ConversationMessage[] = [
  { role: "user", content: "hello" },
  { role: "assistant", content: "hi", thinking: [{ text: "pondering", signature: "sig-1" }] },
];

describe("transcript store", () => {
  test("a session with no transcript loads as empty", async () => {
    expect(await loadTranscript(dir, "sess-a")).toEqual([]);
  });

  test("round-trips messages, preserving thinking blocks and their signatures", async () => {
    await saveTranscript(dir, "sess-a", msgs);
    const back = await loadTranscript(dir, "sess-a");
    expect(back).toEqual(msgs);
    // The signature is what lets Anthropic thinking survive a turn.
    expect(back[1]).toMatchObject({ thinking: [{ signature: "sig-1" }] });
  });

  test("keeps sessions separate", async () => {
    await saveTranscript(dir, "sess-a", msgs);
    expect(await loadTranscript(dir, "sess-b")).toEqual([]);
  });

  test("creates the directory when it does not exist", async () => {
    const nested = join(dir, "deep", "deeper");
    await saveTranscript(nested, "sess-a", msgs);
    expect(await loadTranscript(nested, "sess-a")).toEqual(msgs);
  });

  test("delete removes the transcript and is safe to repeat", async () => {
    await saveTranscript(dir, "sess-a", msgs);
    await deleteTranscript(dir, "sess-a");
    expect(await loadTranscript(dir, "sess-a")).toEqual([]);
    await deleteTranscript(dir, "sess-a"); // must not throw
  });

  test("a corrupt transcript throws rather than silently starting over", async () => {
    await writeFile(transcriptPath(dir, "sess-a"), "{not json", "utf8");
    await expect(loadTranscript(dir, "sess-a")).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

```bash
bun test test/unit/agents/native/transcript-store.test.ts
```

Expected: FAIL — cannot resolve `@/agents/native/session/transcript-store`.

- [ ] **Step 3: Implement**

```ts
/**
 * Conversation persistence for the native transport.
 *
 * nax-ai's client is stateless — every call takes the whole message array — so
 * nax keeps the conversation. Under ACP the acpx subprocess remembered it and
 * nax stored nothing; SessionDescriptor still has no message field, and gains
 * none. See ADR-028 sections 2 and 3.
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ConversationMessage } from "@nathapp/nax-ai";
import { NaxError } from "@/errors";

export function transcriptPath(dir: string, sessionName: string): string {
  return join(dir, `${sessionName}.transcript.json`);
}

/** Missing file means a new conversation. Anything else is a real failure. */
export async function loadTranscript(dir: string, sessionName: string): Promise<ConversationMessage[]> {
  let raw: string;
  try {
    raw = await readFile(transcriptPath(dir, sessionName), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  try {
    return JSON.parse(raw) as ConversationMessage[];
  } catch (err) {
    // Deliberately not [] — silently restarting a conversation would drop the
    // history the model is mid-way through and look like a fresh session.
    throw new NaxError(
      `transcript for session "${sessionName}" is unreadable: ${err instanceof Error ? err.message : String(err)}`,
      "TRANSCRIPT_CORRUPT",
      { stage: "native-session" },
    );
  }
}

export async function saveTranscript(
  dir: string,
  sessionName: string,
  messages: readonly ConversationMessage[],
): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(transcriptPath(dir, sessionName), JSON.stringify(messages, null, 2), "utf8");
}

export async function deleteTranscript(dir: string, sessionName: string): Promise<void> {
  await rm(transcriptPath(dir, sessionName), { force: true });
}
```

- [ ] **Step 4: Run to verify they pass**

```bash
bun test test/unit/agents/native/transcript-store.test.ts
```

Expected: 6 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add src/agents/native/session/transcript-store.ts test/unit/agents/native/transcript-store.test.ts
git commit -m "feat(native): transcript store for stateless-client sessions"
```

---

### Task 3: Tool mapping

**Files:**
- Create: `src/agents/native/session/tool-mapping.ts`
- Test: `test/unit/agents/native/tool-mapping.test.ts`

**Interfaces:**
- Consumes: `ToolDescriptor` from `@/context/engine` — `{ name, description, inputSchema, maxCallsPerSession, maxTokensPerCall }`.
- Produces: `toToolDefinitions(descriptors: readonly ToolDescriptor[]): ToolDefinition[]`.

- [ ] **Step 1: Write the failing test**

```ts
// RE-ARCH: keep
import { describe, expect, test } from "bun:test";
import { toToolDefinitions } from "@/agents/native/session/tool-mapping";
import type { ToolDescriptor } from "@/context/engine";

const descriptor: ToolDescriptor = {
  name: "query_neighbor",
  description: "Fetch a neighbouring file",
  inputSchema: { type: "object", properties: { path: { type: "string" } } },
  maxCallsPerSession: 5,
  maxTokensPerCall: 2000,
};

describe("toToolDefinitions", () => {
  test("carries name, description and schema across", () => {
    expect(toToolDefinitions([descriptor])).toEqual([
      {
        name: "query_neighbor",
        description: "Fetch a neighbouring file",
        inputSchema: { type: "object", properties: { path: { type: "string" } } },
      },
    ]);
  });

  test("drops the budget fields — they are enforced nax-side, not on the wire", () => {
    const [def] = toToolDefinitions([descriptor]);
    expect(def).not.toHaveProperty("maxCallsPerSession");
    expect(def).not.toHaveProperty("maxTokensPerCall");
  });

  test("an empty descriptor list yields no definitions", () => {
    expect(toToolDefinitions([])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
bun test test/unit/agents/native/tool-mapping.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
/**
 * ToolDescriptor -> ToolDefinition.
 *
 * Nearly one-to-one. The budget fields stay behind deliberately: nax executes
 * these tools, so `maxCallsPerSession` and `maxTokensPerCall` are enforced by
 * PullToolBudget on this side and mean nothing to a provider.
 */

import type { ToolDefinition } from "@nathapp/nax-ai";
import type { ToolDescriptor } from "@/context/engine";

export function toToolDefinitions(descriptors: readonly ToolDescriptor[]): ToolDefinition[] {
  return descriptors.map((d) => ({
    name: d.name,
    description: d.description,
    inputSchema: d.inputSchema,
  }));
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
bun test test/unit/agents/native/tool-mapping.test.ts
```

Expected: 3 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add src/agents/native/session/tool-mapping.ts test/unit/agents/native/tool-mapping.test.ts
git commit -m "feat(native): map context pull-tool descriptors to nax-ai tool definitions"
```

---

### Task 4: Thread `transcriptDir` and `contextPullTools` through the session opts

The adapter cannot reach either today. `OpenSessionOpts` carries no directory, and `SendTurnOpts` carries only `interactionHandler`, `signal` and `maxTurns`.

**Files:**
- Modify: `src/agents/session-types.ts` (`OpenSessionOpts`, `SendTurnOpts`)
- Modify: `src/session/manager.ts:472` (the `adapter.openSession` call) and `:600` (the `adapter.sendTurn` call)
- Test: `test/unit/session/session-opts-threading.test.ts`

**Interfaces:**
- Produces: `OpenSessionOpts.transcriptDir?: string`; `SendTurnOpts.contextPullTools?: readonly ToolDescriptor[]`.

- [ ] **Step 1: Write the failing test**

```ts
// RE-ARCH: keep
import { describe, expect, test } from "bun:test";
import type { OpenSessionOpts, SendTurnOpts } from "@/agents/session-types";

/**
 * Type-level pins. The native adapter cannot resolve a transcript directory or
 * a tool catalogue on its own — SessionManager supplies both — and a silent
 * removal of either field would leave the native path quietly toolless.
 */
describe("session opts carry what the native adapter needs", () => {
  test("OpenSessionOpts accepts a transcriptDir", () => {
    const opts: Pick<OpenSessionOpts, "transcriptDir"> = { transcriptDir: "/tmp/x" };
    expect(opts.transcriptDir).toBe("/tmp/x");
  });

  test("SendTurnOpts accepts contextPullTools", () => {
    const opts: Pick<SendTurnOpts, "contextPullTools"> = {
      contextPullTools: [
        {
          name: "query_neighbor",
          description: "d",
          inputSchema: { type: "object" },
          maxCallsPerSession: 5,
          maxTokensPerCall: 100,
        },
      ],
    };
    expect(opts.contextPullTools?.[0]?.name).toBe("query_neighbor");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
bun x tsc --noEmit -p tsconfig.test.json
```

Expected: errors — `transcriptDir` and `contextPullTools` do not exist on those types.

- [ ] **Step 3: Add the fields**

In `src/agents/session-types.ts`, inside `OpenSessionOpts`:

```ts
  /**
   * Native: directory the session's transcript file lives in. Supplied by
   * SessionManager because the adapter cannot derive it — openSession runs
   * before the SessionDescriptor exists (manager.ts:472 vs :492), and no
   * scratch dir reaches the adapter otherwise. ACP ignores it.
   */
  transcriptDir?: string;
```

and inside `SendTurnOpts`:

```ts
  /**
   * Native: pull-tool catalogue for this turn, sent as structured tool
   * definitions. Under ACP the same catalogue is rendered into the prompt
   * instead, so that path ignores this.
   */
  contextPullTools?: readonly import("../context/engine").ToolDescriptor[];
```

- [ ] **Step 4: Pass them from SessionManager**

At `src/session/manager.ts:472`, add to the `adapter.openSession({ ... })` object:

```ts
      transcriptDir: opts.transcriptDir,
```

At `src/session/manager.ts:600`, add to the `adapter.sendTurn(handle, prompt, { ... })` object:

```ts
      contextPullTools: opts.contextPullTools,
```

Then widen the manager's own option types to carry both through from its callers. Run `bun x tsc --noEmit` and follow the errors — they name every call site that needs the field added.

- [ ] **Step 5: Verify**

```bash
bun x tsc --noEmit && bun x tsc --noEmit -p tsconfig.test.json
bun test test/unit/session/ test/unit/agents/
```

Expected: typecheck clean; all existing session and agent tests still pass. The ACP adapter ignores both fields, so nothing there should change.

- [ ] **Step 6: Commit**

```bash
git add src/agents/session-types.ts src/session/manager.ts test/unit/session/session-opts-threading.test.ts
git commit -m "feat(session): thread transcriptDir and contextPullTools to the adapter

Neither can be derived adapter-side: openSession runs before the descriptor
exists, and the pull-tool catalogue reaches the agent layer but not sendTurn."
```

---

### Task 5: `openSession` and `closeSession`

**Files:**
- Create: `src/agents/native/session/session.ts`
- Modify: `src/agents/native/adapter.ts:154-164` (replace the `openSession`/`closeSession` rejections)
- Test: `test/unit/agents/native/session-lifecycle.test.ts`

**Interfaces:**
- Consumes: `loadTranscript`, `saveTranscript`, `deleteTranscript` (Task 2); `OpenSessionOpts.transcriptDir` (Task 4).
- Produces:
  - `openNativeSession(name: string, opts: OpenSessionOpts): Promise<SessionHandle>`
  - `closeNativeSession(handle: SessionHandle, failed: boolean): Promise<void>`
  - `nativeTranscriptDirs: Map<string, string>` — session name → transcript dir, so `sendTurn` and `closeSession` can find it.

- [ ] **Step 1: Write the failing tests**

```ts
// RE-ARCH: keep
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeNativeSession, openNativeSession } from "@/agents/native/session/session";
import { loadTranscript, saveTranscript } from "@/agents/native/session/transcript-store";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nax-session-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const opts = (over: Record<string, unknown> = {}) =>
  ({
    agentName: "native",
    workdir: "/tmp",
    resolvedPermissions: { mode: "unrestricted" },
    modelDef: { provider: "unknown", model: "openrouter/deepseek/deepseek-v4-flash" },
    timeoutSeconds: 60,
    transcriptDir: dir,
    ...over,
  }) as unknown as Parameters<typeof openNativeSession>[1];

describe("native session lifecycle", () => {
  test("opening returns a handle naming the session and the native agent", async () => {
    const handle = await openNativeSession("sess-a", opts());
    expect(handle.id).toBe("sess-a");
    expect(handle.agentName).toBe("native");
  });

  test("a missing transcriptDir fails loudly rather than choosing a default", async () => {
    await expect(openNativeSession("sess-a", opts({ transcriptDir: undefined }))).rejects.toThrow(/transcriptDir/i);
  });

  test("a clean close deletes the transcript", async () => {
    const handle = await openNativeSession("sess-a", opts());
    await saveTranscript(dir, "sess-a", [{ role: "user", content: "hi" }]);
    await closeNativeSession(handle, false);
    expect(await loadTranscript(dir, "sess-a")).toEqual([]);
  });

  test("a failed close keeps the transcript for debugging", async () => {
    const handle = await openNativeSession("sess-a", opts());
    await saveTranscript(dir, "sess-a", [{ role: "user", content: "hi" }]);
    await closeNativeSession(handle, true);
    expect(await loadTranscript(dir, "sess-a")).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

```bash
bun test test/unit/agents/native/session-lifecycle.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
/**
 * Native session lifecycle.
 *
 * There is no subprocess and no backend that remembers, so opening a session
 * establishes nothing — it records where the conversation will be kept. ADR-027
 * section 10 predicted exactly this shape: "openSession and closeSession become
 * either no-ops or transcript-file handles".
 */

import type { OpenSessionOpts, SessionHandle } from "@/agents/session-types";
import { NaxError } from "@/errors";
import { NATIVE_AGENT } from "../models";
import { deleteTranscript } from "./transcript-store";

/** Session name -> transcript directory, so sendTurn and close can find it. */
export const nativeTranscriptDirs = new Map<string, string>();

export async function openNativeSession(name: string, opts: OpenSessionOpts): Promise<SessionHandle> {
  // Never defaulted. An adapter that picks its own path writes a transcript
  // somewhere nobody looks, which is #1794's empty-packageDir bug one layer up.
  if (!opts.transcriptDir) {
    throw new NaxError(
      `native session "${name}" opened without a transcriptDir`,
      "NATIVE_TRANSCRIPT_DIR_MISSING",
      { stage: "native-session" },
    );
  }
  nativeTranscriptDirs.set(name, opts.transcriptDir);
  return {
    id: name,
    agentName: NATIVE_AGENT,
    ...(opts.modelDef !== undefined ? { modelDef: opts.modelDef } : {}),
    ...(opts.modelTier !== undefined ? { modelTier: opts.modelTier } : {}),
  };
}

/**
 * Kept on failure, deleted on success. Every Phase B op is lifetime "fresh", so
 * the transcript survives exactly when it is worth reading — and nothing in the
 * repo prunes session directories, so keeping them all would grow without bound
 * (ADR-028 section 3).
 */
export async function closeNativeSession(handle: SessionHandle, failed: boolean): Promise<void> {
  const dir = nativeTranscriptDirs.get(handle.id);
  if (dir !== undefined && !failed) await deleteTranscript(dir, handle.id);
  nativeTranscriptDirs.delete(handle.id);
}
```

- [ ] **Step 4: Wire into the adapter**

In `src/agents/native/adapter.ts`, replace the `openSession` and `closeSession` rejections:

```ts
  openSession(name: string, opts: OpenSessionOpts): Promise<SessionHandle> {
    return openNativeSession(name, opts);
  }

  closeSession(handle: SessionHandle): Promise<void> {
    // The adapter interface has no failure signal, so a close through this path
    // is a clean one. sendTurn keeps the transcript itself when a turn fails.
    return closeNativeSession(handle, false);
  }
```

Leave `sendTurn` rejecting — Task 6 replaces it.

- [ ] **Step 5: Verify**

```bash
bun test test/unit/agents/native/ && bun run typecheck && bun run lint
```

Expected: all pass; `check:file-sizes` still green (`adapter.ts` grows by a few lines but is not baselined — confirm with `bun run scripts/check-file-sizes.ts`).

- [ ] **Step 6: Commit**

```bash
git add src/agents/native/session/session.ts src/agents/native/adapter.ts test/unit/agents/native/session-lifecycle.test.ts
git commit -m "feat(native): implement openSession and closeSession"
```

---

### Task 6: `sendTurn` and the tool loop

**Files:**
- Create: `src/agents/native/session/turn-loop.ts`
- Modify: `src/agents/native/adapter.ts` (replace the `sendTurn` rejection)
- Test: `test/unit/agents/native/turn-loop.test.ts`

**Interfaces:**
- Consumes: `loadTranscript`/`saveTranscript` (Task 2), `toToolDefinitions` (Task 3), `SendTurnOpts.contextPullTools` (Task 4), `nativeTranscriptDirs` (Task 5).
- Produces: `runNativeTurn(handle: SessionHandle, prompt: string, opts: SendTurnOpts, deps: TurnDeps): Promise<TurnResult>` where `TurnDeps = { complete(messages, tools): Promise<NativeTurnResponse> }` and `NativeTurnResponse = { text: string; toolCalls?: readonly ToolCall[]; thinking?: readonly ThinkingBlock[]; usage: TokenUsage; costUsd: number }`.

- [ ] **Step 1: Write the failing tests**

```ts
// RE-ARCH: keep
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeTranscriptDirs } from "@/agents/native/session/session";
import { runNativeTurn } from "@/agents/native/session/turn-loop";
import { loadTranscript } from "@/agents/native/session/transcript-store";

let dir: string;
const handle = { id: "sess-a", agentName: "native" } as const;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nax-turn-"));
  nativeTranscriptDirs.set("sess-a", dir);
});
afterEach(async () => {
  nativeTranscriptDirs.delete("sess-a");
  await rm(dir, { recursive: true, force: true });
});

const usage = { inputTokens: 1, outputTokens: 1 };
const reply = (over: Record<string, unknown> = {}) => ({ text: "done", usage, costUsd: 0, ...over });

const opts = (over: Record<string, unknown> = {}) =>
  ({
    interactionHandler: { onInteraction: async () => ({ answer: "tool said hi" }) },
    ...over,
  }) as unknown as Parameters<typeof runNativeTurn>[2];

describe("native turn loop", () => {
  test("a reply with no tool calls ends the turn in one round trip", async () => {
    const result = await runNativeTurn(handle, "hi", opts(), { complete: async () => reply() });
    expect(result.output).toBe("done");
    expect(result.internalRoundTrips).toBe(1);
  });

  test("persists the conversation, including thinking blocks", async () => {
    await runNativeTurn(handle, "hi", opts(), {
      complete: async () => reply({ thinking: [{ text: "hmm", signature: "sig-1" }] }),
    });
    const saved = await loadTranscript(dir, "sess-a");
    expect(saved[0]).toEqual({ role: "user", content: "hi" });
    expect(saved[1]).toMatchObject({ role: "assistant", thinking: [{ signature: "sig-1" }] });
  });

  test("executes a tool call through the interaction handler and continues", async () => {
    let round = 0;
    const seen: string[] = [];
    const result = await runNativeTurn(
      handle,
      "hi",
      opts({
        interactionHandler: {
          onInteraction: async (r: { name: string }) => {
            seen.push(r.name);
            return { answer: "42" };
          },
        },
      }),
      {
        complete: async () => {
          round += 1;
          return round === 1
            ? reply({ text: "", toolCalls: [{ id: "c1", name: "query_neighbor", input: {} }] })
            : reply({ text: "the answer is 42" });
        },
      },
    );

    expect(seen).toEqual(["query_neighbor"]);
    expect(result.output).toBe("the answer is 42");
    expect(result.internalRoundTrips).toBe(2);
    const saved = await loadTranscript(dir, "sess-a");
    expect(saved).toContainEqual({ role: "tool-result", toolCallId: "c1", content: "42" });
  });

  test("accumulates token usage across the whole turn, not just the last call", async () => {
    let round = 0;
    const result = await runNativeTurn(handle, "hi", opts(), {
      complete: async () => {
        round += 1;
        return round === 1
          ? reply({ toolCalls: [{ id: "c1", name: "t", input: {} }], usage: { inputTokens: 10, outputTokens: 5 } })
          : reply({ usage: { inputTokens: 3, outputTokens: 2 } });
      },
    });
    expect(result.tokenUsage.inputTokens).toBe(13);
    expect(result.tokenUsage.outputTokens).toBe(7);
  });

  test("stops at maxTurns when the model keeps calling tools", async () => {
    const result = await runNativeTurn(handle, "hi", opts({ maxTurns: 3 }), {
      complete: async () => reply({ toolCalls: [{ id: "c1", name: "t", input: {} }] }),
    });
    expect(result.internalRoundTrips).toBe(3);
  });

  test("defaults to 10 turns when maxTurns is unset", async () => {
    const result = await runNativeTurn(handle, "hi", opts(), {
      complete: async () => reply({ toolCalls: [{ id: "c1", name: "t", input: {} }] }),
    });
    expect(result.internalRoundTrips).toBe(10);
  });

  test("a tool failure comes back as an error result and the turn continues", async () => {
    let round = 0;
    const result = await runNativeTurn(
      handle,
      "hi",
      opts({
        interactionHandler: {
          onInteraction: async () => {
            throw new Error("budget exhausted");
          },
        },
      }),
      {
        complete: async () => {
          round += 1;
          return round === 1 ? reply({ toolCalls: [{ id: "c1", name: "t", input: {} }] }) : reply({ text: "ok" });
        },
      },
    );
    expect(result.output).toBe("ok");
    const saved = await loadTranscript(dir, "sess-a");
    expect(saved).toContainEqual(
      expect.objectContaining({ role: "tool-result", toolCallId: "c1", isError: true }),
    );
  });

  test("a session with no known transcript directory fails loudly", async () => {
    nativeTranscriptDirs.delete("sess-a");
    await expect(runNativeTurn(handle, "hi", opts(), { complete: async () => reply() })).rejects.toThrow(
      /transcript/i,
    );
  });
});
```

- [ ] **Step 2: Run to verify they fail**

```bash
bun test test/unit/agents/native/turn-loop.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
/**
 * The native turn loop.
 *
 * nax owns the conversation, so a turn is: append the prompt, call the model,
 * and while it asks for tools, execute them and call again. Tools are executed
 * through the InteractionHandler the ACP adapter already uses — this file never
 * touches the context engine.
 */

import type { ConversationMessage, ThinkingBlock, ToolCall } from "@nathapp/nax-ai";
import type { TokenUsage } from "@/agents/cost";
import type { SendTurnOpts, SessionHandle, TurnResult } from "@/agents/session-types";
import { NaxError } from "@/errors";
import { toToolDefinitions } from "./tool-mapping";
import { nativeTranscriptDirs } from "./session";
import { loadTranscript, saveTranscript } from "./transcript-store";

/** Matches SendTurnOpts.maxTurns' documented default. */
const DEFAULT_MAX_TURNS = 10;

export interface NativeTurnResponse {
  readonly text: string;
  readonly toolCalls?: readonly ToolCall[];
  readonly thinking?: readonly ThinkingBlock[];
  readonly usage: TokenUsage;
  readonly costUsd: number;
}

export interface TurnDeps {
  complete(
    messages: readonly ConversationMessage[],
    tools: ReturnType<typeof toToolDefinitions>,
  ): Promise<NativeTurnResponse>;
}

export async function runNativeTurn(
  handle: SessionHandle,
  prompt: string,
  opts: SendTurnOpts,
  deps: TurnDeps,
): Promise<TurnResult> {
  const dir = nativeTranscriptDirs.get(handle.id);
  if (dir === undefined) {
    throw new NaxError(`no transcript directory for session "${handle.id}"`, "NATIVE_TRANSCRIPT_DIR_MISSING", {
      stage: "native-session",
    });
  }

  const messages: ConversationMessage[] = [...(await loadTranscript(dir, handle.id))];
  messages.push({ role: "user", content: prompt });

  const tools = toToolDefinitions(opts.contextPullTools ?? []);
  const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;

  let roundTrips = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  let output = "";

  while (roundTrips < maxTurns) {
    const res = await deps.complete(messages, tools);
    roundTrips += 1;
    inputTokens += res.usage.inputTokens;
    outputTokens += res.usage.outputTokens;
    costUsd += res.costUsd;
    output = res.text;

    // Thinking blocks are appended, not merely representable: Anthropic needs
    // the exact block back to continue a thinking conversation (ADR-028 s8).
    messages.push({
      role: "assistant",
      content: res.text,
      ...(res.toolCalls !== undefined ? { toolCalls: res.toolCalls } : {}),
      ...(res.thinking !== undefined ? { thinking: res.thinking } : {}),
    });

    if (res.toolCalls === undefined || res.toolCalls.length === 0) break;

    for (const call of res.toolCalls) {
      try {
        const answer = await opts.interactionHandler.onInteraction({
          kind: "context-tool",
          name: call.name,
          input: call.input,
        });
        messages.push({ role: "tool-result", toolCallId: call.id, content: answer?.answer ?? "" });
      } catch (err) {
        // A tool failure is data, not a turn failure: the existing pull-tool
        // contract already surfaces a handler throw as status "error".
        messages.push({
          role: "tool-result",
          toolCallId: call.id,
          content: err instanceof Error ? err.message : String(err),
          isError: true,
        });
      }
    }
  }

  // Persisted before returning, and a write failure fails the turn: continuing
  // on a history that could not be stored is the silent degradation #1794
  // removed from the pipeline (ADR-028 s4).
  await saveTranscript(dir, handle.id, messages);

  return {
    output,
    tokenUsage: { inputTokens, outputTokens },
    estimatedCostUsd: costUsd,
    internalRoundTrips: roundTrips,
  };
}
```

- [ ] **Step 4: Run to verify they pass**

```bash
bun test test/unit/agents/native/turn-loop.test.ts
```

Expected: 8 pass, 0 fail.

- [ ] **Step 5: Wire into the adapter**

Replace `sendTurn`'s rejection in `src/agents/native/adapter.ts`, supplying a `complete` dep that mirrors the existing `complete()` method's model resolution and pricing (`adapter.ts:102-140`) but passes the full message array and tools:

```ts
  async sendTurn(handle: SessionHandle, prompt: string, opts: SendTurnOpts): Promise<TurnResult> {
    const { provider, model } = parseNativeModel(handle.modelDef?.model ?? "");
    const client = await getNativeClient();
    const resolved = await client.model(provider, model);
    const catalog = client.pricing(resolved);
    const rates = handle.modelDef?.pricing ?? { inputPer1M: catalog.input, outputPer1M: catalog.output };

    return runNativeTurn(handle, prompt, opts, {
      complete: async (messages, tools) => {
        const res = await client.complete(resolved, {
          messages,
          ...(tools.length > 0 ? { tools } : {}),
          ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
        });
        const usage = toNaxTokenUsage(res.usage);
        return {
          text: res.text,
          ...(res.toolCalls !== undefined ? { toolCalls: res.toolCalls } : {}),
          ...(res.thinking !== undefined ? { thinking: res.thinking } : {}),
          usage,
          costUsd: estimateCostUsd(usage, rates),
        };
      },
    });
  }
```

- [ ] **Step 6: Verify**

```bash
bun run typecheck && bun run lint && bun test test/unit/agents/
bun run scripts/check-file-sizes.ts
```

Expected: all green. If `adapter.ts` crosses 600 lines, move the `sendTurn` body into `turn-loop.ts` as a `buildTurnDeps(handle, opts)` helper rather than raising the baseline.

- [ ] **Step 7: Commit**

```bash
git add src/agents/native/session/turn-loop.ts src/agents/native/adapter.ts test/unit/agents/native/turn-loop.test.ts
git commit -m "feat(native): multi-turn sendTurn with a structured pull-tool loop"
```

---

### Task 7: Suppress the prompt preamble on the native path

The pull-tool catalogue is injected as prompt text because under ACP that is the only channel. On the native path the same tools arrive as `ToolDefinition`s, so leaving the preamble in describes them twice in two protocols — and a reply in the text form would be silently lost, since the native path never runs `extractContextToolCall`.

`buildContextToolPreamble` is **not** ACP-only despite living in `src/agents/acp/adapter-output.ts:166`. It is called from two transport-agnostic sites, both of which already have `agentName` in scope, so the native path would otherwise receive it.

**Files:**
- Create: `src/agents/native/session/preamble.ts`
- Modify: `src/runtime/session-run-hop.ts:21`
- Modify: `src/operations/build-hop-callback.ts:280`
- Test: `test/unit/agents/native/preamble.test.ts`

**Interfaces:**
- Produces: `promptWithToolPreamble(agentName: string, options: AgentRunOptions): string` — returns `options.prompt` untouched for the native agent, and `buildContextToolPreamble(options)` for every other agent.

- [ ] **Step 1: Write the failing test**

```ts
// RE-ARCH: keep
import { describe, expect, test } from "bun:test";
import { promptWithToolPreamble } from "@/agents/native/session/preamble";
import type { AgentRunOptions } from "@/agents/types";

const options = {
  prompt: "do the thing",
  contextToolRuntime: { callTool: async () => "" },
  contextPullTools: [
    {
      name: "query_neighbor",
      description: "Fetch a neighbouring file",
      inputSchema: { type: "object", properties: {} },
      maxCallsPerSession: 5,
      maxTokensPerCall: 100,
    },
  ],
} as unknown as AgentRunOptions;

describe("promptWithToolPreamble", () => {
  test("omits the catalogue for native, which receives structured tools instead", () => {
    const prompt = promptWithToolPreamble("native", options);
    expect(prompt).toBe("do the thing");
    expect(prompt).not.toContain("query_neighbor");
  });

  test("still injects the catalogue for an ACP agent", () => {
    const prompt = promptWithToolPreamble("claude", options);
    expect(prompt).toContain("query_neighbor");
  });

  test("leaves a toolless prompt alone on both paths", () => {
    const bare = { prompt: "hi" } as unknown as AgentRunOptions;
    expect(promptWithToolPreamble("native", bare)).toBe("hi");
    expect(promptWithToolPreamble("claude", bare)).toBe("hi");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
bun test test/unit/agents/native/preamble.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
/**
 * Whether a prompt carries the pull-tool catalogue as text.
 *
 * Under ACP the prompt is the only channel for tools, so the catalogue is
 * rendered into it. The native path sends the same tools as structured
 * ToolDefinitions; injecting both describes them twice in two protocols and
 * invites a reply in the text form, which the native path never parses — so the
 * call would be silently lost (ADR-028 section 7).
 *
 * One helper rather than a condition at each call site: the two sites must not
 * drift, and a third would otherwise be written without the guard.
 */

import { buildContextToolPreamble } from "@/agents/acp/adapter-output";
import type { AgentRunOptions } from "@/agents/types";
import { NATIVE_AGENT } from "../models";

export function promptWithToolPreamble(agentName: string, options: AgentRunOptions): string {
  if (agentName === NATIVE_AGENT) return options.prompt;
  return buildContextToolPreamble(options);
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
bun test test/unit/agents/native/preamble.test.ts
```

Expected: 3 pass, 0 fail.

- [ ] **Step 5: Use it at both call sites**

`src/runtime/session-run-hop.ts:21` — `agentName` is the enclosing function's first parameter:

```ts
    const prompt = promptWithToolPreamble(agentName, options);
```

`src/operations/build-hop-callback.ts:280` — `agentName` is in scope in the hop closure:

```ts
      prompt = promptWithToolPreamble(agentName, {
        ...resolvedRunOptions,
        prompt,
        contextPullTools,
        contextToolRuntime,
      });
```

- [ ] **Step 6: Verify the ACP path is byte-identical**

```bash
bun run typecheck && bun run lint
bun test test/unit/runtime/ test/unit/operations/ test/unit/agents/ test/integration/
```

Expected: every existing test passes unchanged. Any ACP prompt-shape test that moves has caught a regression — the preamble must be identical for non-native agents.

- [ ] **Step 7: Commit**

```bash
git add src/agents/native/session/preamble.ts src/runtime/session-run-hop.ts src/operations/build-hop-callback.ts test/unit/agents/native/preamble.test.ts
git commit -m "feat(native): omit the pull-tool text preamble for the native agent

buildContextToolPreamble is called from two transport-agnostic sites, so native
would otherwise receive a text catalogue for tools it already has structurally."
```

---

### Task 8: A/B the verifier, then the two reviews

The verifier is toolless and multi-turn, so it proves the transcript store in isolation. The reviews then add exactly one read-only tool and prove the loop. **Do not switch any op's default agent** — the profile mechanism selects the arm.

**Files:**
- Create: `docs/superpowers/specs/2026-09-02-phase-b-results.md`

- [ ] **Step 1: Run the verifier arm**

Use the `tdd-calc` fixture, whose acceptance stage the plan-4 work already exercised. Point only the verifier at native:

```json
"agent": { "protocol": "hybrid", "default": "opencode" },
"tdd": { "sessionTiers": { "verifier": { "agent": "native", "model": "fast" } } },
"models": { "native": { "fast": "openrouter/deepseek/deepseek-v4-flash" },
            "opencode": { "fast": "minimax/MiniMax-M2.7" } }
```

Give the fixture config a distinct `name` — `projectKey` is `config.name` (`bin/nax.ts:494`), so arms otherwise share one artifact directory.

- [ ] **Step 2: Check what the transcript proves**

```bash
RUNLOG=$(ls -t ~/.nax/<name>/features/tdd-calc/runs/*.jsonl | head -1)
grep -c '"agent":"native"' "$RUNLOG"
grep -c "NATIVE_TRANSCRIPT_DIR_MISSING\|TRANSCRIPT_CORRUPT" "$RUNLOG"
```

Expected: native present, zero transcript errors. A verifier verdict that parses on the first attempt does not exercise multi-turn — if none of the runs re-prompts, force one by asserting against a deliberately unparseable verdict in a scratch fixture rather than declaring the store proven.

- [ ] **Step 3: Run the two review arms**

Same fixture with `review.checks` restored to include `semantic` and `adversarial`, and those ops pointed at native. Confirm the tool actually round-tripped:

```bash
grep -c "query_feature_context" "$RUNLOG"
```

Expected: at least one call. Zero means the model never used the tool — which is a prompt-behaviour result, not a pass.

- [ ] **Step 4: Write the results document**

Record per arm: agent and model, round trips, tokens, whether the tool was called, and a quality comparison against the acpx arm on the same fixture. State plainly whether each op is fit to switch. Compare tokens, not dollars, wherever `minimax/MiniMax-M2.7` is involved — it has no `MODEL_PRICING` entry, so acpx bills it at the generic rate while native uses catalog pricing.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-09-02-phase-b-results.md
git commit -m "docs: Phase B A/B results for the verifier and review ops"
```
