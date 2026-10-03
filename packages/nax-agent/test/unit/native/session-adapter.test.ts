/**
 * NativeSessionAdapter: the session surface (open, sendTurn, close) against a
 * stub client.
 *
 * Ported from nax's test/unit/agents/native/{adapter,adapter-complete-rates,
 * adapter-close-physical-session}.test.ts (S2-3d). Those suites drive the nax
 * shell `NativeAgentAdapter`; the session methods are the package's, so these
 * cases build `NativeSessionAdapter` directly. The `complete()`, shape, config
 * pricing and SessionManager cases stay in nax with the shell.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpenSessionOpts, SessionModel } from "@nathapp/nax-agent";
import {
  _clientDeps,
  _resetNativeClient,
  byCodePoint,
  DEFAULT_SPIN_BREAKER_SETTINGS,
  loadTranscript,
  NaxError,
  openNativeSession,
  saveTranscript,
  sessionModule as sessionState,
  transcriptStoreModule as transcriptStore,
} from "@nathapp/nax-agent/internal";
import type { Client, ClientRequest, ResolvedModel } from "@nathapp/nax-ai";
import { NativeSessionAdapter } from "#src/native/session-adapter";

const REAL_BUILD = _clientDeps.build;
const REAL_WINDOW = 128_000;

afterEach(() => {
  _clientDeps.build = REAL_BUILD;
  _resetNativeClient();
});

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

function countingClient(
  model: ResolvedModel,
  complete?: Client["complete"],
): { client: Client; completeCalls: () => number } {
  let calls = 0;
  const client: Client = {
    model: async () => model,
    listModels: async () => [model],
    pricing: () => ({ input: 3, output: 15, cacheRead: 0, cacheWrite: 0 }),
    stream: async function* stream() {},
    complete:
      complete ??
      (async (_m: ResolvedModel, _req: ClientRequest) => {
        calls += 1;
        return { text: "ok", usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "stop" };
      }),
    validate: () => {},
  };
  return { client, completeCalls: () => calls };
}

const turn = { interactionHandler: { onInteraction: async () => ({ answer: "" }) } };
const DEFAULT_MODEL: SessionModel = { provider: "unknown", model: "openai/gpt-5.4-mini" };

async function openIn(
  adapter: NativeSessionAdapter,
  name: string,
  over: Partial<OpenSessionOpts> = {},
): Promise<{ handle: Awaited<ReturnType<NativeSessionAdapter["openSession"]>>; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), `nax-session-adapter-${name}-`));
  const handle = await adapter.openSession(name, {
    agentName: "native",
    workdir: process.cwd(),
    resolvedPermissions: { mode: "approve-all", bashApproval: "raw" },
    modelDef: DEFAULT_MODEL,
    timeoutSeconds: 60,
    transcriptDir: dir,
    ...over,
  });
  return { handle, dir };
}

// US-003 AC6: sendTurn() stamps pricingSource on TurnResult the same way
// complete() stamps it on CompleteResult.
describe("NativeSessionAdapter.sendTurn pricingSource", () => {
  test("US-003 AC6: sendTurn() with no modelDef.pricing stamps pricingSource=catalog-rates on TurnResult", async () => {
    _clientDeps.build = async () => countingClient(catalogModel()).client;
    const adapter = new NativeSessionAdapter();
    const { handle } = await openIn(adapter, "sess-pricing-source");

    const result = await adapter.sendTurn(handle, "hi", turn);

    expect(result.pricingSource).toBe("catalog-rates");
  });
});

/**
 * nax#1838: the adapter interface carries no failure signal, so the native
 * adapter passed failed:false unconditionally and every close deleted the
 * transcript -- including the close after a failed turn, whose history the
 * retry needs and a human would read.
 */
describe("NativeSessionAdapter.closeSession after a failed turn", () => {
  test("keeps the transcript when the last turn failed", async () => {
    _clientDeps.build = async () =>
      countingClient(catalogModel(), async () => {
        throw new Error("upstream exploded");
      }).client;
    const adapter = new NativeSessionAdapter();
    const { handle, dir } = await openIn(adapter, "sess-keep");

    await adapter.sendTurn(handle, "hi", turn).catch(() => {});
    await adapter.closeSession(handle);

    // nax#1877: kept for a human to read, under a name the next session of
    // this name cannot load.
    const kept = (await readdir(dir)).filter((n) => n.startsWith("sess-keep.transcript.failed-"));
    expect(kept).toHaveLength(1);
    expect(await loadTranscript(dir, "sess-keep")).toEqual([]);
  });

  test("still deletes it when every turn succeeded", async () => {
    _clientDeps.build = async () => countingClient(catalogModel()).client;
    const adapter = new NativeSessionAdapter();
    const { handle, dir } = await openIn(adapter, "sess-drop");

    await adapter.sendTurn(handle, "hi", turn);
    await adapter.closeSession(handle);

    expect(await loadTranscript(dir, "sess-drop")).toEqual([]);
  });

  test("a turn that recovers clears the mark, so a finished session is still cleaned up", async () => {
    let calls = 0;
    _clientDeps.build = async () =>
      countingClient(catalogModel(), async () => {
        calls += 1;
        if (calls === 1) throw new Error("transient");
        return { text: "ok", usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "stop" };
      }).client;
    const adapter = new NativeSessionAdapter();
    const { handle, dir } = await openIn(adapter, "sess-recover");

    await adapter.sendTurn(handle, "hi", turn).catch(() => {});
    await adapter.sendTurn(handle, "again", turn);
    await adapter.closeSession(handle);

    expect(await loadTranscript(dir, "sess-recover")).toEqual([]);
  });
});

const COMPACTION = { enabled: true, compactAtPercent: 90, keepRecentPercent: 30 };

async function seedOversizedTranscript(dir: string, sessionName: string): Promise<void> {
  await saveTranscript(dir, sessionName, [
    { role: "user", content: "the task" },
    { role: "assistant", content: "a".repeat(20_000) },
    { role: "user", content: "keep going" },
    { role: "assistant", content: "b".repeat(20_000) },
  ]);
}

async function sendOverOversized(contextWindow: number | undefined, name: string): Promise<number> {
  const { client, completeCalls } = countingClient(catalogModel());
  _clientDeps.build = async () => client;
  const adapter = new NativeSessionAdapter();
  const modelDef: SessionModel = contextWindow === undefined ? DEFAULT_MODEL : { ...DEFAULT_MODEL, contextWindow };
  const { handle, dir } = await openIn(adapter, name, { modelDef, compaction: COMPACTION });
  await seedOversizedTranscript(dir, handle.id);
  await adapter.sendTurn(handle, "next", turn);
  return completeCalls();
}

describe("NativeSessionAdapter.sendTurn contextWindow override", () => {
  test("an override below the real window reaches runNativeTurn's deps and fires compaction", async () => {
    // summarize + the real turn: compaction fired only because the override
    // (8,000) reached the turn deps -- the catalog window (128,000) would not
    // have triggered it on this transcript.
    expect(await sendOverOversized(8_000, "ctxwin-below")).toBe(2);
  });

  test("no override falls back to the catalog's resolved.contextWindow, so compaction does not fire", async () => {
    expect(await sendOverOversized(undefined, "ctxwin-fallback")).toBe(1);
  });

  test("an override above the real window is rejected, naming both numbers", async () => {
    const err = await sendOverOversized(200_000, "ctxwin-above").catch((e: unknown) => e);
    if (!(err instanceof NaxError)) throw new Error(`expected a NaxError, got ${String(err)}`);
    expect(err.message).toContain("200000");
    expect(err.message).toContain(String(REAL_WINDOW));
  });

  test("an override exactly equal to the real window is accepted", async () => {
    expect(await sendOverOversized(REAL_WINDOW, "ctxwin-equal")).toBe(1);
  });
});

describe("NativeSessionAdapter closePhysicalSession -- run teardown reaches the session maps", () => {
  let closeDir: string;
  beforeEach(async () => {
    closeDir = await mkdtemp(join(tmpdir(), "nax-native-close-"));
  });
  afterEach(async () => {
    await rm(closeDir, { recursive: true, force: true });
  });

  function exportedCollections(): string[] {
    return Object.entries(sessionState)
      .filter(([, value]) => value instanceof Map || value instanceof Set)
      .map(([exportName]) => exportName)
      .sort(byCodePoint);
  }

  function collectionsHolding(name: string): string[] {
    const holding: string[] = [];
    for (const [exportName, value] of Object.entries(sessionState)) {
      if (value instanceof Map && value.has(name)) holding.push(exportName);
      else if (value instanceof Set && value.has(name)) holding.push(exportName);
    }
    return holding.sort(byCodePoint);
  }

  const openOpts = (): OpenSessionOpts => ({
    agentName: "native",
    workdir: closeDir,
    resolvedPermissions: { mode: "approve-all", bashApproval: "raw" },
    modelDef: { provider: "unknown", model: "openrouter/deepseek/deepseek-v4-flash" },
    timeoutSeconds: 60,
    transcriptDir: closeDir,
    transcriptOwner: "call-1",
    compaction: COMPACTION,
    transportRetry: { maxAttempts: 3, baseDelayMs: 2000 },
    spinBreaker: DEFAULT_SPIN_BREAKER_SETTINGS,
  });

  test("physical close removes a successful session's transcript", async () => {
    const adapter = new NativeSessionAdapter();
    const name = "nax-teardown-us-003-success";
    await openNativeSession(name, openOpts());
    await transcriptStore.saveTranscript(closeDir, name, []);
    expect(await Bun.file(transcriptStore.transcriptPath(closeDir, name)).exists()).toBe(true);

    await adapter.closePhysicalSession(name, closeDir);

    expect(await Bun.file(transcriptStore.transcriptPath(closeDir, name)).exists()).toBe(false);
  });

  test("a throwing transcript retain still clears every native map", async () => {
    const adapter = new NativeSessionAdapter();
    const name = "nax-throw-us-002-implementer";
    const handle = await openNativeSession(name, openOpts());
    sessionState.nativeSessionFailed.add(name);
    sessionState.nativeSessionLastUsage.set(name, { promptTokens: 10, anchorIndex: 0 });
    expect(collectionsHolding(name)).toEqual(exportedCollections());
    const retainSpy = spyOn(transcriptStore, "retainTranscript").mockRejectedValue(new Error("retain boom"));
    try {
      await expect(adapter.closeSession(handle)).rejects.toThrow("retain boom");
    } finally {
      retainSpy.mockRestore();
    }
    expect(collectionsHolding(name)).toEqual([]);
  });
});
