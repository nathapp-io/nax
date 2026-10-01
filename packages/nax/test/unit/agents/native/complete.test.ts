/**
 * nativeComplete: the package-side one-shot call (S1 port 2). Options are
 * package-owned: a SessionModel whose pricing is already converted.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { Client, ClientRequest, ResolvedModel } from "@nathapp/nax-ai";
import { _adapterDeps } from "@/agents/native/adapter-deps";
import { _clientDeps, _resetNativeClient } from "@/agents/native/client";
import { nativeComplete } from "@/agents/native/complete";
import { nativeSessionId } from "@/agents/native/session-affinity";

const REAL_BUILD = _clientDeps.build;
const REAL_SET_TIMEOUT = _adapterDeps.setTimeout;
const REAL_CLEAR_TIMEOUT = _adapterDeps.clearTimeout;
afterEach(() => {
  _clientDeps.build = REAL_BUILD;
  _resetNativeClient();
  _adapterDeps.setTimeout = REAL_SET_TIMEOUT;
  _adapterDeps.clearTimeout = REAL_CLEAR_TIMEOUT;
});

const CATALOG = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
const MODEL = {
  id: "gpt-5.4-mini",
  provider: "openai",
  protocol: "openai-responses",
  pricing: CATALOG,
  contextWindow: 128_000,
  supportsTools: true,
  thinkingLevels: [],
} satisfies ResolvedModel;

/** `seen`, when given, collects every request that reaches the client. */
function fakeClient(complete: Client["complete"], seen?: ClientRequest[]): Client {
  return {
    model: async () => MODEL,
    listModels: async () => [MODEL],
    pricing: () => CATALOG,
    stream: async function* stream() {},
    complete: async (m, req) => {
      seen?.push(req);
      return complete(m, req);
    },
    validate: () => {},
  };
}

const CONTEXT = { catalogOverrides: [], sessionKey: "key-1" };

/** The timer seam, driven off a virtual clock instead of a real 5s wait. */
function fakeTimers(): { cleared: unknown[]; fire: () => void; armedMs: () => number | undefined } {
  const cleared: unknown[] = [];
  let callback: (() => void) | undefined;
  let ms: number | undefined;
  _adapterDeps.setTimeout = (fn, delay) => {
    callback = fn;
    ms = delay;
    return "timer-1";
  };
  _adapterDeps.clearTimeout = (id) => {
    cleared.push(id);
  };
  return {
    cleared,
    fire: () => {
      if (callback === undefined) throw new Error("expected the call to arm a timer");
      callback();
    },
    armedMs: () => ms,
  };
}

describe("nativeComplete", () => {
  test("prices from the catalog when the model carries no override", async () => {
    const seen: ClientRequest[] = [];
    _clientDeps.build = async () =>
      fakeClient(
        async () => ({ text: "ok", usage: { inputTokens: 1_000_000, outputTokens: 0 }, stopReason: "stop" }),
        seen,
      );
    const out = await nativeComplete(
      "hi",
      { model: { provider: "openai", model: "openai/gpt-5.4-mini" }, maxTokens: 42 },
      CONTEXT,
    );
    expect(out.output).toBe("ok");
    expect(out.pricingSource).toBe("catalog-rates");
    expect(out.estimatedCostUsd).toBe(3);
    expect(out.sessionId).toBe(nativeSessionId("key-1"));
    // maxTokens reaches the request that goes on the wire, not just the options.
    expect(seen[0]?.maxTokens).toBe(42);
  });

  test("an explicit override wins wholesale", async () => {
    _clientDeps.build = async () =>
      fakeClient(async () => ({ text: "ok", usage: { inputTokens: 1_000_000, outputTokens: 0 }, stopReason: "stop" }));
    const pricing = { input: 7, output: 9, cacheRead: 7, cacheWrite: 7 };
    const out = await nativeComplete(
      "hi",
      { model: { provider: "openai", model: "openai/gpt-5.4-mini", pricing } },
      CONTEXT,
    );
    expect(out.pricingSource).toBe("config-override");
    expect(out.estimatedCostUsd).toBe(7);
  });

  test("a protocol fault is returned as an adapter failure with zero usage", async () => {
    _clientDeps.build = async () =>
      fakeClient(async () => {
        throw Object.assign(new Error("bad key"), { protocolError: { kind: "auth", message: "bad key" } });
      });
    const out = await nativeComplete("hi", { model: { provider: "openai", model: "openai/gpt-5.4-mini" } }, CONTEXT);
    expect(out.output).toBe("");
    expect(out.tokenUsage).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(out.adapterFailure?.outcome).toBe("fail-auth");
  });

  // The timeout is only as good as its teardown: a timer left armed past the
  // call keeps the event loop alive until it fires. Both exits must clear it —
  // a `finally` narrowed to the happy path leaks on every throw.
  test("timeoutMs arms a timer that is cleared once the call returns", async () => {
    const timers = fakeTimers();
    _clientDeps.build = async () =>
      fakeClient(async () => ({ text: "ok", usage: { inputTokens: 1_000_000, outputTokens: 0 }, stopReason: "stop" }));
    await nativeComplete(
      "hi",
      { model: { provider: "openai", model: "openai/gpt-5.4-mini" }, timeoutMs: 5_000 },
      CONTEXT,
    );
    expect(timers.armedMs()).toBe(5_000);
    expect(timers.cleared).toEqual(["timer-1"]);
  });

  test("the armed timer is cleared on the throw path too", async () => {
    const timers = fakeTimers();
    // Not a protocol fault: this is the arm that rethrows, so only a `finally`
    // covering the throw clears the timer.
    _clientDeps.build = async () =>
      fakeClient(async () => {
        throw new TypeError("undefined is not a function");
      });
    await expect(
      nativeComplete("hi", { model: { provider: "openai", model: "openai/gpt-5.4-mini" }, timeoutMs: 5_000 }, CONTEXT),
    ).rejects.toThrow("undefined is not a function");
    expect(timers.cleared).toEqual(["timer-1"]);
  });

  test("firing the armed timer aborts the signal the call carried", async () => {
    const timers = fakeTimers();
    const seen: ClientRequest[] = [];
    _clientDeps.build = async () =>
      fakeClient(
        async () => ({ text: "ok", usage: { inputTokens: 1_000_000, outputTokens: 0 }, stopReason: "stop" }),
        seen,
      );
    await nativeComplete(
      "hi",
      { model: { provider: "openai", model: "openai/gpt-5.4-mini" }, timeoutMs: 5_000 },
      CONTEXT,
    );
    const signal = seen[0]?.signal;
    if (signal === undefined) throw new Error("expected the call to carry an abort signal");
    expect(signal.aborted).toBe(false);
    timers.fire();
    // The callback aborts THIS call's controller — the only thing that can
    // cancel an in-flight request is the signal the client was handed.
    expect(signal.aborted).toBe(true);
  });
});
