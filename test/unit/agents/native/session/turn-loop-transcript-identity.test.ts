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
