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
import { loadTranscript, saveTranscript } from "@/agents/native/session/transcript-store";
import { nativeSessionId } from "@/agents/native/session-affinity";
import type { ResolvedCompleteOptions } from "@/agents/types";
import type { CodingTool } from "@/tools";

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

  // US-002 AC7: the CompleteResult returned by the native adapter's
  // sessionless complete() path must echo back the same session id it sent
  // to the nax-ai client, so downstream wiring (audit, dispatch) can stamp
  // the id on artifacts without having to reach into a private field.
  test("US-002 AC7: complete() returns a sessionId equal to the one sent to nax-ai", async () => {
    let seenSessionId: string | undefined;
    _clientDeps.build = async () =>
      fakeClient({
        complete: async (_m: ResolvedModel, callOpts: { sessionId?: string }) => {
          seenSessionId = callOpts.sessionId;
          return { text: "ok", usage: { inputTokens: 1, outputTokens: 0 }, stopReason: "stop" };
        },
      });

    const result = await new NativeAgentAdapter().complete("hi", options());

    expect(typeof seenSessionId).toBe("string");
    expect(seenSessionId?.length).toBeGreaterThan(0);
    expect(result.sessionId).toBe(seenSessionId);
  });

  // US-002 AC8: two successive complete() calls on one adapter instance share
  // the same session id — the whole point of the one-shot key is to keep the
  // provider's prompt cache warm across a run's one-shots.
  test("US-002 AC8: successive complete() calls on one adapter return the same non-empty sessionId", async () => {
    const seen: string[] = [];
    _clientDeps.build = async () =>
      fakeClient({
        complete: async (_m: ResolvedModel, callOpts: { sessionId?: string }) => {
          if (callOpts.sessionId !== undefined) seen.push(callOpts.sessionId);
          return { text: "ok", usage: { inputTokens: 1, outputTokens: 0 }, stopReason: "stop" };
        },
      });

    const adapter = new NativeAgentAdapter();
    const r1 = await adapter.complete("one", options());
    const r2 = await adapter.complete("two", options());

    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(seen[1]);
    expect(r1.sessionId).toBeDefined();
    expect(r1.sessionId).toBe(r2.sessionId);
  });

  // US-003 AC4: when modelDef has no pricing override, the cost was computed
  // from nax-ai's catalog rates, so pricingSource must say so. Operators
  // filter cost rows by this field (#1817).
  test("US-003 AC4: complete() with no modelDef.pricing stamps pricingSource=catalog-rates", async () => {
    _clientDeps.build = async () => fakeClient();
    const result = await new NativeAgentAdapter().complete("hi", options());
    expect(result.pricingSource).toBe("catalog-rates");
  });

  // US-003 AC5: when modelDef carries an explicit pricing override, that
  // override wins wholesale and pricingSource must say so. Same field, the
  // override branch — this is the discriminator the cost row records.
  test("US-003 AC5: complete() with an explicit modelDef.pricing override stamps pricingSource=config-override", async () => {
    _clientDeps.build = async () => fakeClient();
    const opts = options();
    opts.modelDef = {
      provider: "unknown",
      model: "openai/gpt-5.4-mini",
      pricing: { inputPer1M: 99, outputPer1M: 199 },
    };
    const result = await new NativeAgentAdapter().complete("hi", opts);
    expect(result.pricingSource).toBe("config-override");
  });
});

// US-003 AC6: sendTurn() stamps pricingSource on TurnResult the same way
// complete() stamps it on CompleteResult. Asserted on the result, not on
// buildRateCard — the wiring through runNativeTurn is the part that's new.
describe("NativeAgentAdapter.sendTurn pricingSource", () => {
  test("US-003 AC6: sendTurn() with no modelDef.pricing stamps pricingSource=catalog-rates on TurnResult", async () => {
    _clientDeps.build = async () => fakeClient();
    const adapter = new NativeAgentAdapter();
    const transcriptDir = await mkdtemp(join(tmpdir(), "nax-adapter-pricing-source-"));
    const handle = await adapter.openSession("sess-pricing-source", {
      agentName: "native",
      workdir: process.cwd(),
      resolvedPermissions: { mode: "approve-all" },
      modelDef: { provider: "unknown", model: "openai/gpt-5.4-mini" },
      timeoutSeconds: 60,
      transcriptDir,
    });

    const result = await adapter.sendTurn(handle, "hi", {
      interactionHandler: { onInteraction: async () => ({ answer: "" }) },
    });

    expect(result.pricingSource).toBe("catalog-rates");
  });
});

// nax#1838/#1840 sendTurn failure classification and cost-accounting tests
// live in adapter-turn-classification.test.ts (split by describe block to
// stay under the 800-line test-file cap).

/**
 * nax#1838: AgentAdapter.closeSession carries no failure signal, so the native
 * adapter passed failed:false unconditionally and every close deleted the
 * transcript -- including the close that follows a failed turn, which is exactly
 * the one whose history the retry needs and whose contents a human would read.
 */
describe("NativeAgentAdapter.closeSession after a failed turn", () => {
  test("keeps the transcript when the last turn failed", async () => {
    _clientDeps.build = async () =>
      fakeClient({
        complete: async () => {
          throw new Error("upstream exploded");
        },
      });
    const adapter = new NativeAgentAdapter();
    const transcriptDir = await mkdtemp(join(tmpdir(), "nax-adapter-keep-"));
    const handle = await adapter.openSession("sess-keep", {
      agentName: "native",
      workdir: process.cwd(),
      resolvedPermissions: { mode: "approve-all" },
      modelDef: { provider: "unknown", model: "openai/gpt-5.4-mini" },
      timeoutSeconds: 60,
      transcriptDir,
    });

    await adapter
      .sendTurn(handle, "hi", { interactionHandler: { onInteraction: async () => ({ answer: "" }) } })
      .catch(() => {});
    await adapter.closeSession(handle);

    expect(await loadTranscript(transcriptDir, "sess-keep")).toHaveLength(1);
  });

  test("still deletes it when every turn succeeded", async () => {
    _clientDeps.build = async () => fakeClient();
    const adapter = new NativeAgentAdapter();
    const transcriptDir = await mkdtemp(join(tmpdir(), "nax-adapter-drop-"));
    const handle = await adapter.openSession("sess-drop", {
      agentName: "native",
      workdir: process.cwd(),
      resolvedPermissions: { mode: "approve-all" },
      modelDef: { provider: "unknown", model: "openai/gpt-5.4-mini" },
      timeoutSeconds: 60,
      transcriptDir,
    });

    await adapter.sendTurn(handle, "hi", { interactionHandler: { onInteraction: async () => ({ answer: "" }) } });
    await adapter.closeSession(handle);

    expect(await loadTranscript(transcriptDir, "sess-drop")).toEqual([]);
  });

  test("a turn that recovers clears the mark, so a finished session is still cleaned up", async () => {
    let calls = 0;
    _clientDeps.build = async () =>
      fakeClient({
        complete: async () => {
          calls += 1;
          if (calls === 1) throw new Error("transient");
          return { text: "ok", usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "stop" };
        },
      });
    const adapter = new NativeAgentAdapter();
    const transcriptDir = await mkdtemp(join(tmpdir(), "nax-adapter-recover-"));
    const handle = await adapter.openSession("sess-recover", {
      agentName: "native",
      workdir: process.cwd(),
      resolvedPermissions: { mode: "approve-all" },
      modelDef: { provider: "unknown", model: "openai/gpt-5.4-mini" },
      timeoutSeconds: 60,
      transcriptDir,
    });

    const turn = { interactionHandler: { onInteraction: async () => ({ answer: "" }) } };
    await adapter.sendTurn(handle, "hi", turn).catch(() => {});
    await adapter.sendTurn(handle, "again", turn);
    await adapter.closeSession(handle);

    expect(await loadTranscript(transcriptDir, "sess-recover")).toEqual([]);
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

  // Finding 4 (whole-branch review, 2026-09-02): maxInteractions bounds round-trip
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
      // Short, but not so short it races the turn loop's own pre-flight
      // `deadline.expired()` check (turn-deadline-arc task 2): that check runs
      // before the first round-trip starts, and a sub-millisecond budget can
      // already be spent by the time it runs, skipping complete() entirely.
      // 50ms comfortably survives that setup while still firing well inside
      // the assertion's poll window.
      timeoutSeconds: 0.05,
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
describe("NativeAgentAdapter session identity", () => {
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

  test("complete sends a session id, which nax-ai maps onto each provider's wire", async () => {
    const { client, seen } = capturingClient(OPENCODE_MODEL);
    _clientDeps.build = async () => client;

    const opts = options();
    opts.modelDef = { provider: "unknown", model: "opencode-go/deepseek-v4-flash" };
    await new NativeAgentAdapter().complete("hi", opts);

    expect(seen[0]?.sessionId).toEqual(expect.any(String));
    // The vendor header is nax-ai's job; nax must not assemble one itself.
    expect(seen[0]?.headers).toBeUndefined();
  });

  test("one-shots within one run share a key, so their cache affinity holds", async () => {
    const { client, seen } = capturingClient(OPENCODE_MODEL);
    _clientDeps.build = async () => client;
    const adapter = new NativeAgentAdapter();

    const opts = () => {
      const o = options();
      o.modelDef = { provider: "unknown", model: "opencode-go/deepseek-v4-flash" };
      return o;
    };
    await adapter.complete("one", opts());
    await adapter.complete("two", opts());

    expect(seen[0]?.headers?.["x-opencode-session"]).toBe(seen[1]?.headers?.["x-opencode-session"] as string);
  });

  test("separate runs do not share a key, since they are unrelated work", async () => {
    const { client, seen } = capturingClient(OPENCODE_MODEL);
    _clientDeps.build = async () => client;

    const opts = () => {
      const o = options();
      o.modelDef = { provider: "unknown", model: "opencode-go/deepseek-v4-flash" };
      return o;
    };
    // The registry caches one adapter per run (createAgentRegistry is called
    // from createRuntime), so a second instance stands in for a second run.
    await new NativeAgentAdapter().complete("one", opts());
    await new NativeAgentAdapter().complete("two", opts());

    expect(seen[0]?.sessionId).not.toBe(seen[1]?.sessionId as string);
  });

  test("sends the id for every provider, not just the ones with a named header", async () => {
    const { client, seen } = capturingClient(MODEL);
    _clientDeps.build = async () => client;

    await new NativeAgentAdapter().complete("hi", options());

    // openai-format providers were unreachable while nax owned the mapping:
    // their header comes from a per-model property nax-ai does not expose.
    expect(seen[0]?.sessionId).toEqual(expect.any(String));
  });

  // The one-shot complete() call site. Missing this is the likeliest defect:
  // there are two client.complete() call sites in this file (the other is
  // sendTurn's, covered below) and each must independently thread the
  // effort suffix through as nax-ai's `thinking` field.
  test("complete() forwards a valid effort suffix as thinking", async () => {
    const { client, seen } = capturingClient(MODEL);
    _clientDeps.build = async () => client;

    const opts = options();
    opts.modelDef = { provider: "unknown", model: "openai/gpt-5.4-mini[high]" };
    await new NativeAgentAdapter().complete("hi", opts);

    expect(seen[0]?.thinking).toBe("high");
  });

  test("complete() omits thinking entirely when the model carries no effort suffix", async () => {
    const { client, seen } = capturingClient(MODEL);
    _clientDeps.build = async () => client;

    await new NativeAgentAdapter().complete("hi", options());

    expect(seen[0] && "thinking" in seen[0]).toBe(false);
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

    const first = seen[0]?.sessionId;
    const second = seen[1]?.sessionId;
    expect(first).toBeDefined();
    expect(first).toBe(second as string);
    expect(first).toBe(nativeSessionId(handle.id));
  });

  // sendTurn's client.complete() call site — the second of the two in this
  // file, inside the session turn-loop's `complete` closure. A change that
  // wires effort into complete() but not here would pass every test above
  // and still ship the defect the ADR flagged.
  test("sendTurn forwards a valid effort suffix as thinking", async () => {
    const { client, seen } = capturingClient(MODEL);
    _clientDeps.build = async () => client;
    const adapter = new NativeAgentAdapter();
    const handle = await adapter.openSession("sess-thinking", {
      agentName: "native",
      workdir: process.cwd(),
      resolvedPermissions: { mode: "approve-all" },
      modelDef: { provider: "unknown", model: "openai/gpt-5.4-mini[high]" },
      timeoutSeconds: 60,
      transcriptDir: await mkdtemp(join(tmpdir(), "nax-adapter-thinking-")),
    });

    await adapter.sendTurn(handle, "hi", {
      interactionHandler: { onInteraction: async () => ({ answer: "" }) },
    });

    expect(seen[0]?.thinking).toBe("high");
  });

  test("sendTurn omits thinking entirely when the model carries no effort suffix", async () => {
    const { client, seen } = capturingClient(MODEL);
    _clientDeps.build = async () => client;
    const adapter = new NativeAgentAdapter();
    const handle = await adapter.openSession("sess-no-thinking", {
      agentName: "native",
      workdir: process.cwd(),
      resolvedPermissions: { mode: "approve-all" },
      modelDef: { provider: "unknown", model: "openai/gpt-5.4-mini" },
      timeoutSeconds: 60,
      transcriptDir: await mkdtemp(join(tmpdir(), "nax-adapter-no-thinking-")),
    });

    await adapter.sendTurn(handle, "hi", {
      interactionHandler: { onInteraction: async () => ({ answer: "" }) },
    });

    expect(seen[0] && "thinking" in seen[0]).toBe(false);
  });
});

describe("NativeAgentAdapter compaction wiring", () => {
  /** Small enough that a seeded transcript is already over the threshold. */
  const SMALL_MODEL = { ...MODEL, contextWindow: 8000 } satisfies ResolvedModel;
  const settings = { enabled: true, compactAtPercent: 90, keepRecentPercent: 30 };

  const fakeReadTool: CodingTool = {
    name: "Read",
    description: "Read a file",
    inputSchema: { type: "object", properties: { path: { type: "string" } } },
    scope: { pathFields: ["path"] },
    async run() {
      return { content: "body" };
    },
  };

  async function openWithSeededTranscript(name: string, client: Client) {
    _clientDeps.build = async () => client;
    const adapter = new NativeAgentAdapter();
    const transcriptDir = await mkdtemp(join(tmpdir(), `nax-adapter-${name}-`));
    const handle = await adapter.openSession(name, {
      agentName: "native",
      workdir: process.cwd(),
      resolvedPermissions: { mode: "approve-all" },
      modelDef: { provider: "unknown", model: "openai/gpt-5.4-mini" },
      timeoutSeconds: 60,
      transcriptDir,
      compaction: settings,
    });
    await saveTranscript(transcriptDir, name, [
      { role: "user", content: "the task" },
      { role: "assistant", content: "a".repeat(20_000) },
      { role: "user", content: "keep going" },
      { role: "assistant", content: "b".repeat(20_000) },
    ]);
    return { adapter, handle, transcriptDir };
  }

  test("passes the model's real context window through, so compaction fires on a small one", async () => {
    // Behavioural rather than a spy: the only way a summarize call happens here
    // is if SMALL_MODEL.contextWindow (8000) reached the turn loop. A hardcoded
    // constant, or a dropped wire, produces zero summarize calls.
    let completeCalls = 0;
    const client = fakeClient({
      model: async () => SMALL_MODEL,
      complete: async () => {
        completeCalls += 1;
        return { text: "ok", usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "stop" };
      },
    });
    const { adapter, handle } = await openWithSeededTranscript("sess-compact-wire", client);

    await adapter.sendTurn(handle, "hi", { interactionHandler: { onInteraction: async () => ({ answer: "" }) } });

    // One summarize plus one round trip.
    expect(completeCalls).toBe(2);
  });

  test("the summary call advertises no tools", async () => {
    const requests: ClientRequest[] = [];
    const client = fakeClient({
      model: async () => SMALL_MODEL,
      complete: async (_m: ResolvedModel, req: ClientRequest) => {
        requests.push(req);
        return { text: "ok", usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "stop" };
      },
    });
    const { adapter, handle } = await openWithSeededTranscript("sess-sum", client);

    await adapter.sendTurn(handle, "hi", {
      interactionHandler: { onInteraction: async () => ({ answer: "" }) },
      codingTools: [fakeReadTool],
    });

    // requests[0] is the summary, requests[1] the round trip. Giving the call
    // a non-empty codingTools list makes this discriminating: the round trip
    // must carry tools, and the summary must not, so a summarize closure that
    // wrongly spread tools in (matching complete()'s pattern) would fail this.
    expect(requests[0].tools).toBeUndefined();
    expect(requests[1].tools).toBeDefined();
    expect(requests[1].tools?.length).toBeGreaterThan(0);
  });

  test("never compacts when the window is large", async () => {
    let completeCalls = 0;
    const client = fakeClient({
      complete: async () => {
        completeCalls += 1;
        return { text: "ok", usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "stop" };
      },
    });
    // MODEL.contextWindow is 128_000; the same seeded transcript fits.
    const { adapter, handle } = await openWithSeededTranscript("sess-nocompact", client);

    await adapter.sendTurn(handle, "hi", { interactionHandler: { onInteraction: async () => ({ answer: "" }) } });

    expect(completeCalls).toBe(1);
  });
});
