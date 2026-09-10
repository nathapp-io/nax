/**
 * The native adapter's catalog-override pass-through.
 *
 * Split out of adapter.test.ts to keep that file under the 800-line test-file
 * cap — this is a describe-block split, not a new concern; see
 * test-architecture.md.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client, ResolvedModel } from "@nathapp/nax-ai";
import { NativeAgentAdapter } from "@/agents/native/adapter";
import { _clientDeps, _resetNativeClient } from "@/agents/native/client";
import type { ProviderCatalogOverride } from "@/config/schema-types";

const REAL_BUILD = _clientDeps.build;

afterEach(() => {
  _clientDeps.build = REAL_BUILD;
  _resetNativeClient();
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

function fakeClient(over: Record<string, unknown> = {}): Client {
  return {
    model: async () => MODEL,
    listModels: async () => [MODEL],
    pricing: () => ({ input: 3, output: 15, cacheRead: 0, cacheWrite: 0 }),
    stream: async function* stream() {},
    complete: async () => ({
      text: "ok",
      usage: { inputTokens: 1_000_000, outputTokens: 0 },
      stopReason: "stop",
    }),
    validate: () => {},
    ...over,
  };
}

const OVERRIDES: ProviderCatalogOverride[] = [
  {
    provider: "opencode-go",
    models: [
      {
        id: "deepseek-flash",
        protocol: "openai-completions",
        contextWindow: 1_000_000,
        supportsTools: true,
        thinkingLevels: ["off", "high"],
        pricing: { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 },
      },
    ],
  },
];

describe("NativeAgentAdapter catalog overrides", () => {
  test("complete() passes its catalog overrides to the client build", async () => {
    let seen: readonly ProviderCatalogOverride[] | undefined;
    _clientDeps.build = async (received) => {
      seen = received;
      return fakeClient();
    };

    await new NativeAgentAdapter(undefined, OVERRIDES).complete("hi", {
      modelDef: { provider: "unknown", model: "openai/gpt-5.4-mini" },
      workdir: process.cwd(),
      resolvedPermissions: { mode: "approve-all" },
    });

    expect(seen).toEqual(OVERRIDES);
  });

  test("sendTurn passes its catalog overrides to the client build", async () => {
    let seen: readonly ProviderCatalogOverride[] | undefined;
    _clientDeps.build = async (received) => {
      seen = received;
      return fakeClient();
    };
    const adapter = new NativeAgentAdapter(undefined, OVERRIDES);
    const handle = await adapter.openSession("sess-overrides", {
      agentName: "native",
      workdir: process.cwd(),
      resolvedPermissions: { mode: "approve-all" },
      modelDef: { provider: "unknown", model: "openai/gpt-5.4-mini" },
      timeoutSeconds: 60,
      transcriptDir: await mkdtemp(join(tmpdir(), "nax-adapter-overrides-")),
    });

    await adapter.sendTurn(handle, "hi", {
      interactionHandler: { onInteraction: async () => ({ answer: "" }) },
    });

    expect(seen).toEqual(OVERRIDES);
  });
});
