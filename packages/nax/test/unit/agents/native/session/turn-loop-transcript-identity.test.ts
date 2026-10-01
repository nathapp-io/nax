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
