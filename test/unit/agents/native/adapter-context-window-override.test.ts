/**
 * nax#1848: ModelDef.contextWindow overrides nax-ai's
 * ResolvedModel.contextWindow, reaching runNativeTurn's deps through the real
 * adapter path (NativeAgentAdapter.sendTurn), not a hand-built deps object.
 *
 * The override is observable only through its effect on compaction
 * (turn-loop.ts reads deps.contextWindow, never returns it), so these tests
 * seed an oversized transcript and count how many times the fake client's
 * complete() is invoked: 2 calls (summarize, then the real turn) means
 * compaction fired; 1 call means it did not. Same technique as
 * turn-loop-compaction.test.ts, but driven through the adapter rather than a
 * hand-built deps object, so the wiring in adapter.ts is what is under test.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client, ClientRequest, ResolvedModel } from "@nathapp/nax-ai";
import { _adapterDeps, NativeAgentAdapter } from "@/agents/native/adapter";
import { _clientDeps, _resetNativeClient } from "@/agents/native/client";
import type { ResolvedCompaction } from "@/agents/native/session/compaction";
import { saveTranscript } from "@/agents/native/session/transcript-store";
import type { ModelDef } from "@/config/schema-types";
import { NaxError } from "@/errors";

const REAL_BUILD = _clientDeps.build;
const REAL_LIST = _adapterDeps.listStoredProviders;
const REAL_SWEEP = _adapterDeps.anyAmbientCredential;

afterEach(() => {
  _clientDeps.build = REAL_BUILD;
  _resetNativeClient();
  _adapterDeps.listStoredProviders = REAL_LIST;
  _adapterDeps.anyAmbientCredential = REAL_SWEEP;
});

/** The catalog's real window: large enough that no test in this file
 * compacts on the catalog value alone -- only an override triggers it. */
const REAL_WINDOW = 128_000;

function catalogModel(): ResolvedModel {
  return {
    id: "gpt-5.4-mini",
    provider: "openai",
    protocol: "openai-responses",
    pricing: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 },
    contextWindow: REAL_WINDOW,
    supportsTools: true,
    thinkingLevels: [],
  };
}

function countingClient(model: ResolvedModel): { client: Client; completeCalls: () => number } {
  let calls = 0;
  const client: Client = {
    model: async () => model,
    listModels: async () => [model],
    pricing: () => ({ input: 3, output: 15, cacheRead: 0, cacheWrite: 0 }),
    stream: async function* stream() {},
    complete: async (_m: ResolvedModel, _req: ClientRequest) => {
      calls += 1;
      return { text: "ok", usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "stop" };
    },
    validate: () => {},
  };
  return { client, completeCalls: () => calls };
}

const COMPACTION_CFG: ResolvedCompaction = { enabled: true, compactAtPercent: 90, keepRecentPercent: 30 };

async function openSessionWithModelDef(
  name: string,
  modelDef: ModelDef,
): Promise<{
  adapter: NativeAgentAdapter;
  handle: Awaited<ReturnType<NativeAgentAdapter["openSession"]>>;
  dir: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), `nax-ctxwin-${name}-`));
  const adapter = new NativeAgentAdapter();
  const handle = await adapter.openSession(name, {
    agentName: "native",
    workdir: process.cwd(),
    resolvedPermissions: { mode: "approve-all" },
    modelDef,
    timeoutSeconds: 60,
    transcriptDir: dir,
    compaction: COMPACTION_CFG,
  });
  return { adapter, handle, dir };
}

/** A transcript large enough to cross a small (but not the real) window. */
async function seedOversizedTranscript(dir: string, sessionName: string) {
  await saveTranscript(dir, sessionName, [
    { role: "user", content: "the task" },
    { role: "assistant", content: "a".repeat(20_000) },
    { role: "user", content: "keep going" },
    { role: "assistant", content: "b".repeat(20_000) },
  ]);
}

const send = (adapter: NativeAgentAdapter, handle: Awaited<ReturnType<NativeAgentAdapter["openSession"]>>) =>
  adapter.sendTurn(handle, "next", { interactionHandler: { onInteraction: async () => ({ answer: "" }) } });

describe("NativeAgentAdapter.sendTurn contextWindow override", () => {
  test("an override below the real window reaches runNativeTurn's deps and fires compaction", async () => {
    const model = catalogModel();
    const { client, completeCalls } = countingClient(model);
    _clientDeps.build = async () => client;

    const { adapter, handle, dir } = await openSessionWithModelDef("ctxwin-below", {
      provider: "unknown",
      model: "openai/gpt-5.4-mini",
      contextWindow: 8_000,
    });
    await seedOversizedTranscript(dir, handle.id);

    await send(adapter, handle);

    // summarize + the real turn: compaction fired only because the override
    // (8,000) reached the turn deps -- the catalog window (128,000) would not
    // have triggered it on this transcript.
    expect(completeCalls()).toBe(2);
  });

  test("no override falls back to the catalog's resolved.contextWindow, so compaction does not fire", async () => {
    const model = catalogModel();
    const { client, completeCalls } = countingClient(model);
    _clientDeps.build = async () => client;

    const { adapter, handle, dir } = await openSessionWithModelDef("ctxwin-fallback", {
      provider: "unknown",
      model: "openai/gpt-5.4-mini",
    });
    await seedOversizedTranscript(dir, handle.id);

    await send(adapter, handle);

    // Same oversized transcript as the "below" case, but no override: the
    // real window (128,000) is nowhere near crossed, so only the turn call
    // happens.
    expect(completeCalls()).toBe(1);
  });

  test("an override above the real window is rejected, naming both numbers", async () => {
    const model = catalogModel();
    const { client } = countingClient(model);
    _clientDeps.build = async () => client;

    const { adapter, handle, dir } = await openSessionWithModelDef("ctxwin-above", {
      provider: "unknown",
      model: "openai/gpt-5.4-mini",
      contextWindow: 200_000,
    });
    await seedOversizedTranscript(dir, handle.id);

    const err = await send(adapter, handle).catch((e: unknown) => e);

    if (!(err instanceof NaxError)) throw new Error(`expected a NaxError, got ${String(err)}`);
    expect(err.message).toContain("200000");
    expect(err.message).toContain(String(REAL_WINDOW));
  });

  test("an override exactly equal to the real window is accepted", async () => {
    const model = catalogModel();
    const { client, completeCalls } = countingClient(model);
    _clientDeps.build = async () => client;

    const { adapter, handle, dir } = await openSessionWithModelDef("ctxwin-equal", {
      provider: "unknown",
      model: "openai/gpt-5.4-mini",
      contextWindow: REAL_WINDOW,
    });
    await seedOversizedTranscript(dir, handle.id);

    await send(adapter, handle);

    // Equal to the real window behaves exactly like no override: the small
    // oversized transcript does not cross it.
    expect(completeCalls()).toBe(1);
  });
});
