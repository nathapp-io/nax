import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  _clientDeps,
  _resetNativeClient,
  type GuardedCredentialStore,
  getNativeClient,
  type ProviderCatalogOverride,
} from "@nathapp/nax-agent/internal";
import type { Client, ResolvedModel } from "@nathapp/nax-ai";
import { _resetCredentialsConfig, configureCredentials, credentialsConfig } from "#src/infra/credentials-config";
import { NativeSessionAdapter } from "#src/native/session-adapter";
import { withDerivedStream } from "#test/helpers/index";

const REAL_BUILD = _clientDeps.build;
const dirs: string[] = [];
let savedSlot: ReturnType<typeof credentialsConfig> | undefined;
afterEach(async () => {
  _clientDeps.build = REAL_BUILD;
  _resetNativeClient();
  if (savedSlot !== undefined) configureCredentials(savedSlot);
  savedSlot = undefined;
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const model: ResolvedModel = {
  id: "stub-model",
  provider: "stub",
  protocol: "stub",
  pricing: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  supportsTools: true,
  thinkingLevels: [],
};
function stubClient(): Client {
  return withDerivedStream({
    model: async () => model,
    listModels: async () => [model],
    pricing: () => ({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }),
    stream: async function* stream() {},
    complete: async () => ({ text: "ok", usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "stop" }),
    validate: () => {},
  });
}
async function oneTurn(adapter: NativeSessionAdapter, name: string) {
  const dir = await mkdtemp(join(tmpdir(), "adapter-client-"));
  dirs.push(dir);
  const handle = await adapter.openSession(name, {
    agentName: "native",
    workdir: dir,
    transcriptDir: dir,
    timeoutSeconds: 60,
    modelDef: { provider: "stub", model: "stub/stub-model" },
    resolvedPermissions: { mode: "approve-all", bashApproval: "raw" },
  });
  const result = await adapter.sendTurn(handle, "hi", {
    interactionHandler: { onInteraction: async () => ({ answer: "" }) },
  });
  await adapter.closeSession(handle);
  return result;
}

function providerOverride(provider: string): ProviderCatalogOverride {
  return { provider, models: [] };
}

/** Narrow the builder's opaque credential option to the guarded store the adapter passes. */
function isGuardedCredentialStore(store: unknown): store is GuardedCredentialStore {
  return typeof store === "object" && store !== null && "servedAuth" in store;
}

describe("adapter-owned client", () => {
  test("a memory-sourced adapter runs a turn with the slot unset and hands the memory store to the client builder", async () => {
    try {
      savedSlot = credentialsConfig();
    } catch {
      savedSlot = undefined;
    }
    _resetCredentialsConfig();
    const seenOptions: Array<{ credentials?: unknown }> = [];
    _clientDeps.build = async (_overrides, options) => {
      seenOptions.push(options ?? {});
      return stubClient();
    };
    const adapter = new NativeSessionAdapter([], {
      credentials: { kind: "memory", credentials: { stub: { kind: "api-key", key: "k" } } },
    });
    const result = await oneTurn(adapter, "mem");
    expect(result.output).toBe("ok");
    expect(seenOptions).toHaveLength(1);
    expect(seenOptions[0].credentials).toBeDefined();
    expect(await adapter.hasCredentials()).toBe(true);

    // The stub client reads no credential, so the turn itself produces no auth
    // stamp. Read the store the adapter handed the builder instead — the same
    // store the real protocol layer would read — to pin the memory source
    // end-to-end without reaching through the adapter's private state.
    const store = seenOptions[0].credentials;
    if (!isGuardedCredentialStore(store)) {
      throw new Error("the adapter handed the client builder a store without servedAuth");
    }
    await store.read("stub");
    expect(store.servedAuth("stub")?.source).toBe("memory");
  });

  test("two owned clients with different overrides both build; the memo still refuses a mismatch", async () => {
    let builds = 0;
    _clientDeps.build = async () => {
      builds += 1;
      return stubClient();
    };
    const p1 = [providerOverride("p1")];
    const p2 = [providerOverride("p2")];
    await oneTurn(new NativeSessionAdapter(p1, { ownClient: true }), "a");
    await oneTurn(new NativeSessionAdapter(p2, { ownClient: true }), "b");
    expect(builds).toBe(2);
    await getNativeClient(p1);
    await expect(getNativeClient(p2)).rejects.toMatchObject({ code: "NATIVE_CLIENT_OVERRIDES_MISMATCH" });
  });

  test("option-less adapters share the module memo (nax path)", async () => {
    let builds = 0;
    _clientDeps.build = async () => {
      builds += 1;
      return stubClient();
    };
    await oneTurn(new NativeSessionAdapter(), "x");
    await oneTurn(new NativeSessionAdapter(), "y");
    expect(builds).toBe(1);
  });
});
