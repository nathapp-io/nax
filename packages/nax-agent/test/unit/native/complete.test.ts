/**
 * nativeComplete: the package-side one-shot call (S1 port 2). Options are
 * package-owned: a SessionModel whose pricing is already converted.
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { Client, ClientRequest, ResolvedModel } from "@nathapp/nax-ai";
import { _adapterDeps } from "#src/native/adapter-deps";
import { _clientDeps, _resetNativeClient } from "#src/native/client";
import { nativeComplete } from "#src/native/complete";
import { nativeSessionId } from "#src/native/session-affinity";

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
function fakeClient(
  complete: Client["complete"],
  seen?: ClientRequest[],
  model: Client["model"] = async () => MODEL,
): Client {
  return {
    model,
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

/** The complete result every US-002 case settles on; typed once so a stub cannot drift. */
const OK_RESULT: Awaited<ReturnType<Client["complete"]>> = {
  text: "ok",
  usage: { inputTokens: 1_000_000, outputTokens: 0 },
  stopReason: "stop",
};

/** The package-owned one-shot model every US-002 case drives. */
const SESSION_MODEL = { provider: "openai", model: "openai/gpt-5.4-mini" };

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

/**
 * US-002: the caller's cancellation. A one-shot has two ways to end early — its
 * own timeout and its caller giving up — and the request the client is waiting
 * on must honour both. The reason a pre-aborted call rejects with is the
 * caller's own, not a synthesised one, so the run's cancellation reason
 * survives the hop.
 */
describe("nativeComplete — caller cancellation (US-002)", () => {
  /** The signal of the request the client received, or a clear failure. */
  function requestSignal(seen: ClientRequest[], index = 0): AbortSignal {
    const signal = seen[index]?.signal;
    if (signal === undefined) throw new Error(`expected request ${index} to carry an abort signal`);
    return signal;
  }

  test("US-002 AC-1: an already-aborted caller signal rejects with its own reason", async () => {
    const caller = new AbortController();
    const reason = new Error("run cancelled");
    caller.abort(reason);
    _clientDeps.build = async () => fakeClient(async () => OK_RESULT);

    await expect(nativeComplete("hi", { model: SESSION_MODEL, signal: caller.signal }, CONTEXT)).rejects.toBe(reason);
  });

  test("US-002 AC-1: an explicit null abort reason is preserved, not replaced", async () => {
    const caller = new AbortController();
    // `abort(null)` states a reason of its own. Only an ABSENT reason may be
    // substituted with an AbortError, or the caller's reason is not the one
    // that comes back.
    caller.abort(null);
    _clientDeps.build = async () => fakeClient(async () => OK_RESULT);

    await expect(nativeComplete("hi", { model: SESSION_MODEL, signal: caller.signal }, CONTEXT)).rejects.toBeNull();
  });

  test("US-002 AC-2: an already-aborted caller signal never reaches the client", async () => {
    const caller = new AbortController();
    caller.abort(new Error("run cancelled"));
    const seen: ClientRequest[] = [];
    let builds = 0;
    _clientDeps.build = async () => {
      builds += 1;
      return fakeClient(async () => OK_RESULT, seen);
    };

    await expect(nativeComplete("hi", { model: SESSION_MODEL, signal: caller.signal }, CONTEXT)).rejects.toThrow(
      "run cancelled",
    );

    expect(seen).toHaveLength(0);
    // Not even the client build: getNativeClient loads the whole catalog, which
    // a request nobody wants must not pay for.
    expect(builds).toBe(0);
  });

  test("US-002 AC-3: a caller abort during a pending complete aborts the request signal", async () => {
    const caller = new AbortController();
    const seen: ClientRequest[] = [];
    const pending = Promise.withResolvers<Awaited<ReturnType<Client["complete"]>>>();
    const inFlight = Promise.withResolvers<void>();
    _clientDeps.build = async () =>
      fakeClient(() => {
        inFlight.resolve();
        return pending.promise;
      }, seen);

    const call = nativeComplete("hi", { model: SESSION_MODEL, signal: caller.signal }, CONTEXT);
    await inFlight.promise;
    const request = requestSignal(seen);
    expect(request.aborted).toBe(false);

    caller.abort(new Error("run cancelled"));

    // The request already on the wire is cancelled — this is the only thing
    // that reaches the provider.
    expect(request.aborted).toBe(true);
    pending.resolve(OK_RESULT);
    expect((await call).output).toBe("ok");
  });

  test("US-002 AC-4: a caller abort during the pending model lookup reaches the later complete", async () => {
    const caller = new AbortController();
    const seen: ClientRequest[] = [];
    const lookup = Promise.withResolvers<ResolvedModel>();
    _clientDeps.build = async () =>
      fakeClient(
        async () => OK_RESULT,
        seen,
        () => lookup.promise,
      );

    const call = nativeComplete("hi", { model: SESSION_MODEL, signal: caller.signal }, CONTEXT);
    // Before the controller existed, this abort landed in the gap between entry
    // and the model lookup and was lost, so the request went out uncancellable.
    caller.abort(new Error("run cancelled"));
    lookup.resolve(MODEL);
    await call;

    expect(requestSignal(seen).aborted).toBe(true);
  });

  test("US-002 AC-5: a live caller signal does not stop the armed timer aborting the request", async () => {
    const timers = fakeTimers();
    const caller = new AbortController();
    const seen: ClientRequest[] = [];
    _clientDeps.build = async () => fakeClient(async () => OK_RESULT, seen);

    await nativeComplete("hi", { model: SESSION_MODEL, signal: caller.signal, timeoutMs: 5_000 }, CONTEXT);
    const request = requestSignal(seen);
    expect(timers.armedMs()).toBe(5_000);
    expect(request.aborted).toBe(false);

    timers.fire();

    expect(request.aborted).toBe(true);
    // The timeout ends THIS call's request; it is not a cancellation of the
    // caller's run, whose signal stays live for its next hop.
    expect(caller.signal.aborted).toBe(false);
  });

  test("US-002 AC-6: aborting the caller's signal after the call resolved does not throw", async () => {
    const caller = new AbortController();
    const seen: ClientRequest[] = [];
    _clientDeps.build = async () => fakeClient(async () => OK_RESULT, seen);

    const out = await nativeComplete("hi", { model: SESSION_MODEL, signal: caller.signal }, CONTEXT);
    expect(out.output).toBe("ok");

    // The listener went with the call, so the late abort has nothing to run.
    expect(() => caller.abort(new Error("late cancel"))).not.toThrow();
    expect(requestSignal(seen).aborted).toBe(false);
  });

  test("US-002 AC-7: a later call's request signal is not aborted by an earlier call's abort", async () => {
    const first = new AbortController();
    const seen: ClientRequest[] = [];
    _clientDeps.build = async () => fakeClient(async () => OK_RESULT, seen);

    await nativeComplete("hi", { model: SESSION_MODEL, signal: first.signal }, CONTEXT);
    first.abort(new Error("run cancelled"));

    const second = new AbortController();
    await nativeComplete("hi", { model: SESSION_MODEL, signal: second.signal }, CONTEXT);

    expect(seen).toHaveLength(2);
    // Per-call cancellation: one run's abort must not leak into another's request.
    expect(requestSignal(seen, 1).aborted).toBe(false);
  });

  test("US-002 AC-8: rejects with the model lookup error while the caller signal is live", async () => {
    const caller = new AbortController();
    const failure = new Error("model lookup failed");
    _clientDeps.build = async () =>
      fakeClient(
        async () => OK_RESULT,
        undefined,
        async () => {
          throw failure;
        },
      );

    await expect(nativeComplete("hi", { model: SESSION_MODEL, signal: caller.signal }, CONTEXT)).rejects.toBe(failure);
    expect(caller.signal.aborted).toBe(false);
  });

  test("US-002 AC-9: removes its abort listener when the model lookup rejects", async () => {
    const caller = new AbortController();
    const removals = spyOn(caller.signal, "removeEventListener");
    _clientDeps.build = async () =>
      fakeClient(
        async () => OK_RESULT,
        undefined,
        async () => {
          throw new Error("model lookup failed");
        },
      );

    await expect(nativeComplete("hi", { model: SESSION_MODEL, signal: caller.signal }, CONTEXT)).rejects.toThrow(
      "model lookup failed",
    );

    // A rejection before the request exists still detaches the listener, so the
    // caller's signal holds no reference to a call that already ended.
    expect(removals.mock.calls.map(([type]) => type)).toEqual(["abort"]);
    removals.mockRestore();
  });
});
