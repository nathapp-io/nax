/**
 * The native adapter's sendTurn failure classification and cost accounting.
 *
 * Split out of adapter.test.ts (nax#1840) to keep that file under the
 * 800-line test-file cap — this is a describe-block split, not a new
 * concern; see test-architecture.md.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client, ResolvedModel } from "@nathapp/nax-ai";
import { _adapterDeps, NativeAgentAdapter } from "@/agents/native/adapter";
import { _clientDeps, _resetNativeClient } from "@/agents/native/client";
import { SessionFailureError, SessionTurnError } from "@/agents/types";
import type { AdapterFailure } from "@/context/engine";

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

/**
 * nax#1838: sendTurn rethrew nax-ai's error untouched, so the run path lost the
 * typed kind and build-hop-callback reclassified every native failure as a
 * generic fail-adapter-error -- rate limits lost their backoff, auth failures
 * stopped sticking to the unavailable mark, and an overflow was indistinguishable
 * from a crash. complete() had carried the typed failure all along; this is the
 * same treatment on the session path, using the carrier build-hop-callback
 * already reads.
 *
 * nax#1840: the carrier changed from SessionFailureError to SessionTurnError.
 * Classification and cost are read off two different error classes and a
 * throw can only be one; SessionTurnError is the class the cost fields already
 * live on, so it grew an optional adapterFailure field and now carries both.
 * The classification behaviour these tests pin (rate-limit/auth/overflow
 * mapping, message passthrough, non-protocol errors left untouched) is
 * unchanged — only the class name at the throw site is.
 */
describe("NativeAgentAdapter.sendTurn failure classification", () => {
  class ProtocolStreamError extends Error {
    constructor(readonly protocolError: { kind: string; message: string }) {
      super(protocolError.message);
      this.name = "ProtocolStreamError";
    }
  }

  async function openTurnSession(name: string) {
    const adapter = new NativeAgentAdapter();
    const handle = await adapter.openSession(name, {
      agentName: "native",
      workdir: process.cwd(),
      resolvedPermissions: { mode: "approve-all" },
      modelDef: { provider: "unknown", model: "openai/gpt-5.4-mini" },
      timeoutSeconds: 60,
      transcriptDir: await mkdtemp(join(tmpdir(), `nax-adapter-${name}-`)),
    });
    return { adapter, handle };
  }

  const send = (adapter: NativeAgentAdapter, handle: Awaited<ReturnType<NativeAgentAdapter["openSession"]>>) =>
    adapter.sendTurn(handle, "hi", { interactionHandler: { onInteraction: async () => ({ answer: "" }) } });

  /** Type-predicate narrowing helper — no cast needed at any call site. */
  function hasAdapterFailure(err: SessionTurnError): err is SessionTurnError & { adapterFailure: AdapterFailure } {
    return err.adapterFailure !== undefined;
  }

  /** Narrows by throwing, so the assertions below need no cast. */
  async function failureFrom(turn: Promise<unknown>): Promise<SessionTurnError & { adapterFailure: AdapterFailure }> {
    const err = await turn.catch((e: unknown) => e);
    if (!(err instanceof SessionTurnError)) {
      throw new Error(`expected a SessionTurnError, got ${err instanceof Error ? err.name : String(err)}`);
    }
    if (!hasAdapterFailure(err)) {
      throw new Error("expected the SessionTurnError to carry adapterFailure");
    }
    return err;
  }

  test("carries a rate limit up as a typed failure, so the backoff written for it can fire", async () => {
    _clientDeps.build = async () =>
      fakeClient({
        complete: async () => {
          throw new ProtocolStreamError({ kind: "rate-limit", message: "429 slow down" });
        },
      });
    const { adapter, handle } = await openTurnSession("sess-ratelimit");

    const err = await failureFrom(send(adapter, handle));

    expect(err.adapterFailure.outcome).toBe("fail-rate-limit");
    expect(err.adapterFailure.category).toBe("availability");
  });

  test("keeps the upstream message, which is the only description of what happened", async () => {
    _clientDeps.build = async () =>
      fakeClient({
        complete: async () => {
          throw new ProtocolStreamError({ kind: "auth", message: "401 invalid key" });
        },
      });
    const { adapter, handle } = await openTurnSession("sess-auth");

    const err = await failureFrom(send(adapter, handle));

    expect(err.adapterFailure.outcome).toBe("fail-auth");
    expect(err.message).toContain("401 invalid key");
  });

  test("classifies a context overflow as swappable rather than as a crash", async () => {
    _clientDeps.build = async () =>
      fakeClient({
        complete: async () => {
          throw new ProtocolStreamError({ kind: "context-overflow", message: "prompt is too long" });
        },
      });
    const { adapter, handle } = await openTurnSession("sess-overflow");

    const err = await failureFrom(send(adapter, handle));

    expect(err.adapterFailure.category).toBe("availability");
    expect(err.adapterFailure.message).toContain("context window");
  });

  test("leaves an error that is not a protocol fault exactly as thrown", async () => {
    // The other side of the classification: wrapping everything would make a
    // programming error look like a vendor failure and hide its stack.
    _clientDeps.build = async () =>
      fakeClient({
        complete: async () => {
          throw new TypeError("undefined is not a function");
        },
      });
    const { adapter, handle } = await openTurnSession("sess-bug");

    const err = await send(adapter, handle).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(TypeError);
    expect(err).not.toBeInstanceOf(SessionFailureError);
    expect(err).not.toBeInstanceOf(SessionTurnError);
  });

  // nax#1840: the critical assertion. Two round trips burn real tokens before
  // the third round trip hits a rate limit — the RECORDED cost on the thrown
  // error must be the sum of the first two, not the pre-#1840 default of 0.
  // Drives the real production path: turn-loop's accumulator ->
  // runNativeTurn's catch -> adapter.ts's catch -> the SessionTurnError a hop
  // callback actually reads. Asserting only the carrier's shape (that a
  // SessionTurnError was thrown, or that tokenUsage is defined) would pass
  // while the number stayed 0 — this asserts the number.
  test("carries the cost burned on earlier round trips into the thrown failure", async () => {
    let calls = 0;
    _clientDeps.build = async () =>
      fakeClient({
        complete: async () => {
          calls += 1;
          if (calls <= 2) {
            return {
              text: "still working",
              toolCalls: [{ id: `c${calls}`, name: "query_neighbor", input: {} }],
              usage: { inputTokens: 500_000, outputTokens: 200_000 },
              stopReason: "tool_use" as const,
            };
          }
          throw new ProtocolStreamError({ kind: "rate-limit", message: "429 slow down" });
        },
      });
    const { adapter, handle } = await openTurnSession("sess-cost");

    const err = await failureFrom(send(adapter, handle));

    // MODEL pricing: input $3/1M, output $15/1M. Two round trips of
    // 500k in / 200k out each -> 2 * (1.5 + 3.0) = 9.
    expect(err.tokenUsage?.inputTokens).toBe(1_000_000);
    expect(err.tokenUsage?.outputTokens).toBe(400_000);
    expect(err.estimatedCostUsd).toBeCloseTo(9, 6);
    expect(err.adapterFailure.outcome).toBe("fail-rate-limit");
  });
});
