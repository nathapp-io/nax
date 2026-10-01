/**
 * US-006 — the adapter's credential stamp is read through the injectable
 * `_adapterDeps` seam.
 *
 * Acceptance criteria covered: AC2 and AC5, at the seam they must be read
 * through (the integration file covers them end to end against the fake
 * server, per the refined ACs).
 *
 * `authFields` calls the imported `servedAuth` directly, while the same file
 * routes every other credential seam — `listStoredProviders`,
 * `anyAmbientCredential`, `authSourceIsExec` — and both timers through
 * `_adapterDeps`. The stamp path is therefore only reachable by assembling a
 * real credential store under an isolated `~/.nax` and driving a request: a
 * unit test cannot say "the adapter stamps the identity the credential store
 * observed for this provider" without reproducing that whole store, and it
 * cannot say "and only that identity" at all, because the store is the only
 * thing that can produce one.
 *
 * These tests pin the seam instead. `SEAM_STAMP` and the store's own stamp
 * differ, so an assertion that the result carries `SEAM_STAMP` cannot pass by
 * reading the store.
 *
 * RED against the current source: `authFields` ignores
 * `_adapterDeps.servedAuth` and reads the import, so `complete()` and
 * `sendTurn()` report the real store's stamp (or nothing) rather than the
 * seam's. Source is out of scope for this fix — the implementer routes
 * `authFields` through `_adapterDeps.servedAuth`, defaulted to the imported
 * `servedAuth`, which is what makes the assertions below green.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Client, ResolvedModel } from "@nathapp/nax-ai";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { _adapterDeps } from "@/agents/native/adapter-deps";
import { _clientDeps, _resetNativeClient } from "@/agents/native/client";
import { _resetCredentialStore, naxCredentialStore, servedAuth } from "@/agents/native/credentials";
import { NativeAgentAdapter } from "@/agents/native-agent";
import { toSessionModel } from "@/agents/session-model-mapping";
import type { AuthStamp } from "@/agents/session-types";
import type { ResolvedCompleteOptions } from "@/agents/types";
import type { ResolvedPermissions } from "@/config/permissions";
import type { ModelDef } from "@/config/schema-types";

const PROVIDER = "openai";
const MODEL_DEF: ModelDef = { provider: "unknown", model: `${PROVIDER}/gpt-5.4-mini` };
const PERMS: ResolvedPermissions = { mode: "approve-all", bashApproval: "raw" };
/** Deliberately unlike anything a store read can produce: `source` is "exec". */
const SEAM_STAMP: AuthStamp = { fingerprint: "fp-from-the-seam", source: "exec", account: "team-seam" };

/**
 * The seam under test. Typed structurally because `_adapterDeps` does not carry
 * `servedAuth` yet; once it does (defaulted to the imported `servedAuth`) this
 * view is exactly the object's own type and the stub below is the same idiom
 * every sibling test uses for `_adapterDeps.listStoredProviders`.
 */
const seamDeps = _adapterDeps as typeof _adapterDeps & {
  servedAuth: (providerId: string) => AuthStamp | undefined;
};

const REAL_BUILD = _clientDeps.build;
const REAL_SERVED_AUTH = seamDeps.servedAuth;
const originalGlobalDir = process.env.NAX_GLOBAL_CONFIG_DIR;

let dir: string;

const MODEL = {
  id: "gpt-5.4-mini",
  provider: PROVIDER,
  protocol: "openai-responses",
  pricing: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  supportsTools: true,
  thinkingLevels: [],
} satisfies ResolvedModel;

/** A fake client: the stamp must come from the seam, not from a provider round trip. */
function fakeClient(): Client {
  return {
    model: async () => MODEL,
    listModels: async () => [MODEL],
    pricing: () => ({ input: 3, output: 15, cacheRead: 0, cacheWrite: 0 }),
    stream: async function* stream() {},
    complete: async () => ({ text: "ok", usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "stop" }),
    validate: () => {},
  };
}

function completeOptions(modelDef: ModelDef = MODEL_DEF): ResolvedCompleteOptions {
  return { modelDef, workdir: dir, resolvedPermissions: PERMS };
}

async function openTurnSession(name: string) {
  return new NativeAgentAdapter().openSession(name, {
    agentName: "native",
    workdir: dir,
    resolvedPermissions: PERMS,
    modelDef: toSessionModel(MODEL_DEF),
    timeoutSeconds: 60,
    transcriptDir: dir,
  });
}

/** The real store's own stamp for `PROVIDER`, so a test can prove the two differ. */
async function storeStamp(): Promise<AuthStamp> {
  await naxCredentialStore().modify(PROVIDER, async () => ({ kind: "api-key", key: "STORE-KEY" }));
  await naxCredentialStore().read(PROVIDER);
  const stamp = servedAuth(PROVIDER);
  if (stamp === undefined) throw new Error("expected the real store to report a stamp after the priming read");
  return stamp;
}

beforeEach(() => {
  dir = makeTempDir("nax-us006-seam-");
  process.env.NAX_GLOBAL_CONFIG_DIR = dir;
  _resetCredentialStore();
  _resetNativeClient();
  _clientDeps.build = async () => fakeClient();
  seamDeps.servedAuth = (providerId) => (providerId === PROVIDER ? SEAM_STAMP : undefined);
});

afterEach(() => {
  seamDeps.servedAuth = REAL_SERVED_AUTH;
  _clientDeps.build = REAL_BUILD;
  _resetNativeClient();
  process.env.NAX_GLOBAL_CONFIG_DIR = originalGlobalDir;
  _resetCredentialStore();
  cleanupTempDir(dir);
});

const send = (adapter: NativeAgentAdapter, handle: Awaited<ReturnType<NativeAgentAdapter["openSession"]>>) =>
  adapter.sendTurn(handle, "hi", { interactionHandler: { onInteraction: async () => ({ answer: "" }) } });

describe("NativeAgentAdapter.complete() — auth stamp reads the seam (US-006)", () => {
  // AC2 (success): the identity the store observed for the provider reaches
  // CompleteResult.auth — here the seam stands in for the store.
  test("AC2 seam: complete() returns the stamp the servedAuth seam reports for the model id's provider", async () => {
    const result = await new NativeAgentAdapter().complete("hi", completeOptions());

    expect(result.auth).toEqual(SEAM_STAMP);
  });

  // AC2 (finding): the stamp comes from the seam, not from the global store.
  // The store is primed with a real credential first, so a source that reads
  // the import reports a different identity (or, absent a read, nothing).
  test("AC2 seam: complete() reports the seam's stamp, not one the real credential store observed", async () => {
    const fromStore = await storeStamp();
    expect(fromStore).not.toEqual(SEAM_STAMP);

    const result = await new NativeAgentAdapter().complete("hi", completeOptions());

    expect(result.auth).toEqual(SEAM_STAMP);
  });

  // AC2 (default wiring): with no stub installed the seam must still be the
  // production `servedAuth` — a dep defaulted to anything weaker than the
  // import would silently stop stamping every real call. This is the test the
  // stub above cannot make: it fails if `_adapterDeps.servedAuth` is added but
  // left undefined.
  test("AC2 default wiring: without a stub, complete() reports the real store's observed identity", async () => {
    const fromStore = await storeStamp();
    seamDeps.servedAuth = REAL_SERVED_AUTH;

    const result = await new NativeAgentAdapter().complete("hi", completeOptions());

    expect(result.auth).toEqual(fromStore);
  });

  // AC2 boundary: the provider handed to the seam is the one parsed from the
  // model id, never `modelDef.provider` — which `resolveModel()` infers and is
  // "unknown" for every non-Claude model.
  test("AC2 boundary: complete() asks the seam for the model id's provider, never options.modelDef.provider", async () => {
    const asked: string[] = [];
    seamDeps.servedAuth = (providerId) => {
      asked.push(providerId);
      return SEAM_STAMP;
    };

    const result = await new NativeAgentAdapter().complete(
      "hi",
      completeOptions({ provider: "anthropic", model: MODEL_DEF.model }),
    );

    expect(asked).toEqual([PROVIDER]);
    expect(result.auth).toEqual(SEAM_STAMP);
  });

  // AC2 boundary: "the store observed nothing" must leave the `auth` key off
  // the result entirely, not write it as `undefined`.
  test("AC2 boundary: complete() omits the auth key when the seam reports no identity", async () => {
    seamDeps.servedAuth = () => undefined;

    const result = await new NativeAgentAdapter().complete("hi", completeOptions());

    expect(Object.hasOwn(result, "auth")).toBe(false);
  });
});

describe("NativeAgentAdapter.sendTurn() — auth stamp reads the seam (US-006)", () => {
  // AC5 (success): the turn result carries the identity the store observed for
  // the provider parsed from `handle.modelDef.model`.
  test("AC5 seam: sendTurn() returns the stamp the servedAuth seam reports for handle.modelDef.model's provider", async () => {
    const adapter = new NativeAgentAdapter();
    const handle = await openTurnSession("nax-us006-seam-turn");

    const turn = await send(adapter, handle);

    expect(turn.auth).toEqual(SEAM_STAMP);
  });

  // AC5 boundary: same omission discipline as `complete()`.
  test("AC5 boundary: sendTurn() omits the auth key when the seam reports no identity", async () => {
    seamDeps.servedAuth = () => undefined;
    const adapter = new NativeAgentAdapter();
    const handle = await openTurnSession("nax-us006-seam-turn-none");

    const turn = await send(adapter, handle);

    expect(Object.hasOwn(turn, "auth")).toBe(false);
  });
});
