/**
 * The native adapter.
 *
 * complete() catches nax-ai's ProtocolStreamError and returns an adapterFailure
 * rather than rethrowing: rethrowing would route through
 * classifyCompleteException -> parseAgentError, which parses ACP strings and
 * would discard the typed kind nax-ai just handed us.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client, ClientRequest, ResolvedModel } from "@nathapp/nax-ai";
import { waitForCondition } from "@test/helpers";
import { _adapterDeps, NativeAgentAdapter } from "@/agents/native/adapter";
import { _clientDeps, _resetNativeClient } from "@/agents/native/client";
import { nativeSessionId } from "@/agents/native/session-affinity";
import type { ResolvedCompleteOptions } from "@/agents/types";

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

function options(): ResolvedCompleteOptions {
  return {
    // provider is what resolveModel() infers for this string: "unknown".
    modelDef: { provider: "unknown", model: "openai/gpt-5.4-mini" },
    workdir: process.cwd(),
    resolvedPermissions: { mode: "approve-all" },
  };
}

describe("NativeAgentAdapter.complete", () => {
  test("returns the text, mapped usage and a computed cost", async () => {
    _clientDeps.build = async () => fakeClient();
    const result = await new NativeAgentAdapter().complete("hi", options());

    expect(result.output).toBe("ok");
    expect(result.tokenUsage.inputTokens).toBe(1_000_000);
    expect(result.estimatedCostUsd).toBeCloseTo(3, 6);
    expect(result.adapterFailure).toBeUndefined();
  });

  test("ignores modelDef.provider, which resolveModel only guessed", async () => {
    // resolveModel infers "unknown" for "openai/gpt-5.4-mini" and would infer
    // "anthropic" for anything starting "claude". Neither is configuration.
    let asked: [string, string] | undefined;
    _clientDeps.build = async () =>
      fakeClient({
        model: async (p: string, m: string) => {
          asked = [p, m];
          return MODEL;
        },
      });

    const opts = options();
    (opts.modelDef as { provider: string }).provider = "unknown";
    await new NativeAgentAdapter().complete("hi", opts);

    expect(asked).toEqual(["openai", "gpt-5.4-mini"]);
  });

  test("never sets exactCostUsd, because nax-ai supplies rates and not cost", async () => {
    _clientDeps.build = async () => fakeClient();
    const result = await new NativeAgentAdapter().complete("hi", options());
    expect(result.exactCostUsd).toBeUndefined();
  });

  test("turns a rate limit into a swappable availability failure", async () => {
    class ProtocolStreamError extends Error {
      constructor(readonly protocolError: { kind: string; message: string }) {
        super(protocolError.message);
        this.name = "ProtocolStreamError";
      }
    }
    _clientDeps.build = async () =>
      fakeClient({
        complete: async () => {
          throw new ProtocolStreamError({ kind: "rate-limit", message: "429" });
        },
      });

    const result = await new NativeAgentAdapter().complete("hi", options());

    expect(result.adapterFailure?.category).toBe("availability");
    expect(result.adapterFailure?.outcome).toBe("fail-rate-limit");
    expect(result.output).toBe("");
  });
});

describe("NativeAgentAdapter shape", () => {
  test("takes its tiers from config, since native's are arbitrary names", () => {
    const adapter = new NativeAgentAdapter(["cheap", "strong"]);
    expect(adapter.capabilities.supportedTiers).toEqual(["cheap", "strong"]);
  });

  test("falls back to the builtin tiers rather than none when built without config", () => {
    // [] would make the execution stage log a tier mismatch on every story:
    // it clamps to supportedTiers[0], which would be undefined.
    expect(new NativeAgentAdapter().capabilities.supportedTiers).toEqual(["fast", "balanced", "powerful"]);
    expect(new NativeAgentAdapter([]).capabilities.supportedTiers).toHaveLength(3);
  });

  test("declares no binary and builds no command", () => {
    const adapter = new NativeAgentAdapter();
    expect(adapter.binary).toBe("");
    expect(adapter.buildCommand()).toEqual([]);
  });

  test("sendTurn calls the model and returns its output", async () => {
    _clientDeps.build = async () => fakeClient();
    const adapter = new NativeAgentAdapter();
    const handle = await adapter.openSession("sess-adapter", {
      agentName: "native",
      workdir: process.cwd(),
      resolvedPermissions: { mode: "approve-all" },
      modelDef: { provider: "unknown", model: "openai/gpt-5.4-mini" },
      timeoutSeconds: 60,
      transcriptDir: await mkdtemp(join(tmpdir(), "nax-adapter-turn-")),
    });

    const result = await adapter.sendTurn(handle, "hi", {
      interactionHandler: { onInteraction: async () => ({ answer: "" }) },
    });

    expect(result.output).toBe("ok");
    expect(result.internalRoundTrips).toBe(1);
  });

  // Finding 4 (whole-branch review, 2026-09-02): maxTurns bounds round-trip
  // COUNT, not duration — a hung provider call would otherwise hang the turn
  // forever, since neither OpenSessionOpts.timeoutSeconds nor SendTurnOpts
  // carried a wall-clock bound. sendTurn now derives an AbortController with
  // a deadline from the session's timeoutSeconds for every complete() call,
  // combined with any caller-supplied opts.signal via AbortSignal.any —
  // mirroring the shape complete() already uses for its own single call.
  test("bounds each complete() call with a deadline derived from the session's timeoutSeconds", async () => {
    let capturedSignal: AbortSignal | undefined;
    let resolveComplete: (() => void) | undefined;
    _clientDeps.build = async () =>
      fakeClient({
        // Stays pending until the test resolves it, so the deadline timer has
        // a chance to fire while the call is still in flight — asserting on a
        // call that already returned would race the deadline's clearTimeout.
        complete: async (_model: ResolvedModel, callOpts: { signal?: AbortSignal }) => {
          capturedSignal = callOpts.signal;
          await new Promise<void>((resolve) => {
            resolveComplete = resolve;
          });
          return { text: "ok", usage: { inputTokens: 0, outputTokens: 0 }, stopReason: "stop" };
        },
      });
    const adapter = new NativeAgentAdapter();
    const handle = await adapter.openSession("sess-deadline", {
      agentName: "native",
      workdir: process.cwd(),
      resolvedPermissions: { mode: "approve-all" },
      modelDef: { provider: "unknown", model: "openai/gpt-5.4-mini" },
      // Effectively immediate — the assertion polls for the deadline timer to
      // fire rather than sleeping a fixed duration for it.
      timeoutSeconds: 0.001,
      transcriptDir: await mkdtemp(join(tmpdir(), "nax-adapter-deadline-")),
    });

    const sendTurnPromise = adapter.sendTurn(handle, "hi", {
      interactionHandler: { onInteraction: async () => ({ answer: "" }) },
    });

    await waitForCondition(() => capturedSignal?.aborted === true, 500);
    expect(capturedSignal?.aborted).toBe(true);
    resolveComplete?.();
    await sendTurnPromise;
  });

  test("combines a caller-supplied signal with the deadline, either can abort the call", async () => {
    let capturedSignal: AbortSignal | undefined;
    _clientDeps.build = async () =>
      fakeClient({
        complete: async (_model: ResolvedModel, callOpts: { signal?: AbortSignal }) => {
          capturedSignal = callOpts.signal;
          return { text: "ok", usage: { inputTokens: 0, outputTokens: 0 }, stopReason: "stop" };
        },
      });
    const adapter = new NativeAgentAdapter();
    const handle = await adapter.openSession("sess-caller-signal", {
      agentName: "native",
      workdir: process.cwd(),
      resolvedPermissions: { mode: "approve-all" },
      modelDef: { provider: "unknown", model: "openai/gpt-5.4-mini" },
      // Long enough that the deadline itself never fires during this test.
      timeoutSeconds: 60,
      transcriptDir: await mkdtemp(join(tmpdir(), "nax-adapter-caller-signal-")),
    });

    const callerController = new AbortController();
    callerController.abort();

    await adapter.sendTurn(handle, "hi", {
      interactionHandler: { onInteraction: async () => ({ answer: "" }) },
      signal: callerController.signal,
    });

    expect(capturedSignal?.aborted).toBe(true);
  });
});

describe("isInstalled", () => {
  test("is true even when hasCredentials is false: in-process, nothing to install", async () => {
    const adapter = new NativeAgentAdapter();
    // Force the credential probe to say no. If isInstalled still delegates,
    // it returns false and this fails.
    adapter.hasCredentials = async () => false;

    expect(await adapter.isInstalled()).toBe(true);
  });
});

describe("hasCredentials", () => {
  test("is true when a credential is stored, without sweeping ambient auth", async () => {
    let swept = false;
    _adapterDeps.listStoredProviders = async () => [{ providerId: "minimax", kind: "api-key" as const }];
    _adapterDeps.anyAmbientCredential = async () => {
      swept = true;
      return false;
    };

    expect(await new NativeAgentAdapter().hasCredentials()).toBe(true);
    expect(swept).toBe(false);
  });

  test("falls back to the ambient sweep when nothing is stored", async () => {
    _adapterDeps.listStoredProviders = async () => [];
    _adapterDeps.anyAmbientCredential = async () => true;

    expect(await new NativeAgentAdapter().hasCredentials()).toBe(true);
  });

  test("is false only when nothing is stored and nothing is ambient", async () => {
    _adapterDeps.listStoredProviders = async () => [];
    _adapterDeps.anyAmbientCredential = async () => false;

    expect(await new NativeAgentAdapter().hasCredentials()).toBe(false);
  });

  test("an unreadable credential file does not prune the agent", async () => {
    _adapterDeps.listStoredProviders = async () => {
      throw new Error("EACCES");
    };
    _adapterDeps.anyAmbientCredential = async () => false;

    // Fail open: an unreadable store is "unknown", not "no credentials".
    expect(await new NativeAgentAdapter().hasCredentials()).toBe(true);
  });
});

/**
 * Session-affinity headers reaching the wire.
 *
 * Asserted on what arrives at client.complete(), not on the helper — the helper
 * has its own tests, and a helper nothing calls is the failure mode this repo
 * keeps hitting (nax#1744, transcriptDir).
 */
describe("NativeAgentAdapter session affinity", () => {
  const OPENCODE_MODEL = { ...MODEL, id: "deepseek-v4-flash", provider: "opencode-go" } satisfies ResolvedModel;

  function capturingClient(model: ResolvedModel): { client: Client; seen: ClientRequest[] } {
    const seen: ClientRequest[] = [];
    const client = fakeClient({
      model: async () => model,
      complete: async (_m: ResolvedModel, req: ClientRequest) => {
        seen.push(req);
        return { text: "ok", usage: { inputTokens: 1, outputTokens: 0 }, stopReason: "stop" };
      },
    });
    return { client, seen };
  }

  test("complete sends x-opencode-session to an opencode provider", async () => {
    const { client, seen } = capturingClient(OPENCODE_MODEL);
    _clientDeps.build = async () => client;

    const opts = options();
    opts.modelDef = { provider: "unknown", model: "opencode-go/deepseek-v4-flash" };
    await new NativeAgentAdapter().complete("hi", opts);

    expect(seen[0]?.headers).toMatchObject({ "x-opencode-session": expect.any(String) });
  });

  test("complete sends no affinity header to a provider that has none", async () => {
    const { client, seen } = capturingClient(MODEL);
    _clientDeps.build = async () => client;

    await new NativeAgentAdapter().complete("hi", options());

    expect(seen[0]?.headers).toBeUndefined();
  });

  test("sendTurn derives the header from the session, so it is stable across turns", async () => {
    const { client, seen } = capturingClient(OPENCODE_MODEL);
    _clientDeps.build = async () => client;
    const adapter = new NativeAgentAdapter();
    const handle = await adapter.openSession("sess-affinity", {
      agentName: "native",
      workdir: process.cwd(),
      resolvedPermissions: { mode: "approve-all" },
      modelDef: { provider: "unknown", model: "opencode-go/deepseek-v4-flash" },
      timeoutSeconds: 60,
      transcriptDir: await mkdtemp(join(tmpdir(), "nax-adapter-affinity-")),
    });

    const turn = { interactionHandler: { onInteraction: async () => ({ answer: "" }) } };
    await adapter.sendTurn(handle, "one", turn);
    await adapter.sendTurn(handle, "two", turn);

    const first = seen[0]?.headers?.["x-opencode-session"];
    const second = seen[1]?.headers?.["x-opencode-session"];
    expect(first).toBeDefined();
    expect(first).toBe(second);
    expect(first).toBe(nativeSessionId(handle.id));
  });
});
