/**
 * nax#1835: the native path never set `cacheRetention`, so Anthropic models
 * got no prompt caching at all. Only the sendTurn turn-loop path sets it — the
 * one-shot complete() call has no successor turn to reuse a cache entry, so a
 * cache write there would cost more than it saves.
 *
 * Split out of adapter.test.ts (test-architecture.md: split by describe block
 * once the file crosses its line budget) rather than grown in place.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client, ClientRequest, ResolvedModel } from "@nathapp/nax-ai";
import { _adapterDeps, NativeAgentAdapter } from "@/agents/native/adapter";
import { _clientDeps, _resetNativeClient } from "@/agents/native/client";
import type { ResolvedCompleteOptions } from "@/agents/types";
import { SessionManager } from "@/session/manager";
import type { OpenSessionRequest } from "@/session/types";

const REAL_BUILD = _clientDeps.build;
const REAL_LIST = _adapterDeps.listStoredProviders;
const REAL_SWEEP = _adapterDeps.anyAmbientCredential;

afterEach(() => {
  _clientDeps.build = REAL_BUILD;
  _resetNativeClient();
  _adapterDeps.listStoredProviders = REAL_LIST;
  _adapterDeps.anyAmbientCredential = REAL_SWEEP;
});

const MODEL = {
  id: "gpt-5.4-mini",
  provider: "openai",
  protocol: "openai-responses",
  pricing: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  supportsTools: true,
  thinkingLevels: [],
} satisfies ResolvedModel;

function options(): ResolvedCompleteOptions {
  return {
    // provider is what resolveModel() infers for this string: "unknown".
    modelDef: { provider: "unknown", model: "openai/gpt-5.4-mini" },
    workdir: process.cwd(),
    resolvedPermissions: { mode: "approve-all" },
  };
}

function capturingClient(model: ResolvedModel): { client: Client; seen: ClientRequest[] } {
  const seen: ClientRequest[] = [];
  const client: Client = {
    model: async () => model,
    listModels: async () => [model],
    pricing: () => ({ input: 3, output: 15, cacheRead: 0, cacheWrite: 0 }),
    stream: async function* stream() {},
    complete: async (_m: ResolvedModel, req: ClientRequest) => {
      seen.push(req);
      return { text: "ok", usage: { inputTokens: 1, outputTokens: 0 }, stopReason: "stop" };
    },
    validate: () => {},
  };
  return { client, seen };
}

describe("NativeAgentAdapter cacheRetention wiring", () => {
  // Asserted on the request that actually reaches the protocol layer
  // (`seen[n]`), not on a call shape: a mock assertion could pass while the
  // field never made it to the wire.
  test("sendTurn's round-trip call carries cacheRetention: short", async () => {
    const { client, seen } = capturingClient(MODEL);
    _clientDeps.build = async () => client;
    const adapter = new NativeAgentAdapter();
    const handle = await adapter.openSession("sess-cache-retention", {
      agentName: "native",
      workdir: process.cwd(),
      resolvedPermissions: { mode: "approve-all" },
      modelDef: { provider: "unknown", model: "openai/gpt-5.4-mini" },
      timeoutSeconds: 60,
      transcriptDir: await mkdtemp(join(tmpdir(), "nax-adapter-cache-retention-")),
    });

    await adapter.sendTurn(handle, "hi", {
      interactionHandler: { onInteraction: async () => ({ answer: "" }) },
    });

    expect(seen[0]?.cacheRetention).toBe("short");
  });

  test("complete() (one-shot) never sets cacheRetention", async () => {
    const { client, seen } = capturingClient(MODEL);
    _clientDeps.build = async () => client;

    await new NativeAgentAdapter().complete("hi", options());

    expect(seen[0] && "cacheRetention" in seen[0]).toBe(false);
  });
});

// nax#1835 / #1841 (the shape the compaction bug shipped in): a config value
// wired only into a hand-constructed adapter test can pass while the real
// production entry point never reaches it. This drives openSession() and
// sendPrompt() through the actual SessionManager wiring layer -- the same
// path a real run takes -- with the real NativeAgentAdapter behind it, rather
// than a mock adapter or a call straight into NativeAgentAdapter's methods.
describe("cacheRetention through the production SessionManager path", () => {
  test("SessionManager.openSession -> sendPrompt reaches client.complete with cacheRetention: short", async () => {
    const { client, seen } = capturingClient(MODEL);
    _clientDeps.build = async () => client;

    const adapter = new NativeAgentAdapter();
    const sm = new SessionManager({ getAdapter: () => adapter });
    const transcriptDir = await mkdtemp(join(tmpdir(), "nax-session-manager-cache-retention-"));
    const req: OpenSessionRequest = {
      agentName: "native",
      workdir: process.cwd(),
      pipelineStage: "run",
      modelDef: { provider: "unknown", model: "openai/gpt-5.4-mini" },
      timeoutSeconds: 60,
      transcriptDir,
    };

    const handle = await sm.openSession("nax-cache-retention-e2e", req);
    await sm.sendPrompt(handle, "hi", {
      interactionHandler: { onInteraction: async () => ({ answer: "" }) },
    });

    expect(seen[0]?.cacheRetention).toBe("short");
  });
});
