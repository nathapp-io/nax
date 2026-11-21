import { afterEach, describe, expect, it, vi } from "vitest";

import { createClient } from "../../src/client.ts";
import { createMemoryCredentialStore } from "../../src/credentials/memory-store.ts";
import { ProtocolStreamError } from "../../src/protocols/collect.ts";
import { observeErrorResponses } from "../../src/protocols/error-response-fetch.ts";
import type { PiResponse } from "../../src/protocols/pi-client.ts";
import { defaultProtocols } from "../../src/protocols/pi-protocols.ts";
import type { ProtocolError } from "../../src/protocols/types.ts";
import { defaultProviders } from "../../src/providers/pi-catalog.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

const URL_UNDER_TEST = new URL("https://api.openai.com/v1/responses");

function recording(): { seen: PiResponse[]; onResponse: (response: PiResponse) => void } {
  const seen: PiResponse[] = [];
  return { seen, onResponse: (response) => void seen.push(response) };
}

function errorResponse(): Response {
  return new Response(JSON.stringify({ error: { message: "slow down", type: "rate_limit_error" } }), {
    status: 429,
    headers: { "content-type": "application/json", "retry-after": "41" },
  });
}

function okResponse(): Response {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("observeErrorResponses", () => {
  it("AC-1 resolves to the same error Response object the stubbed fetch returned", async () => {
    // Constructed BEFORE the stub is installed, which is what proves the
    // fetch lookup happens at call time rather than at construction.
    const wrapper = observeErrorResponses(() => {});
    const response = errorResponse();
    vi.stubGlobal("fetch", async () => response);

    const returned = await wrapper(URL_UNDER_TEST);

    expect(returned).toBe(response);
  });

  it("AC-2 reports a 429 once with its status and a plain headers record", async () => {
    const { seen, onResponse } = recording();
    const wrapper = observeErrorResponses(onResponse);
    vi.stubGlobal("fetch", async () => errorResponse());

    await wrapper(URL_UNDER_TEST);

    expect(seen).toHaveLength(1);
    const observed = seen[0];
    if (observed === undefined) throw new Error("onResponse was not called");
    expect(observed.status).toBe(429);
    // A plain record, not the Headers instance: the classifier reads
    // retry-after out of it with Object.entries.
    expect(Object.getPrototypeOf(observed.headers)).toBe(Object.prototype);
    expect(observed.headers).toMatchObject({ "retry-after": "41" });
    expect(observed.headers["retry-after"]).toBe("41");
  });

  it("AC-3 forwards exactly the URL and init it was called with to the fetch stub", async () => {
    const { seen, onResponse } = recording();
    const wrapper = observeErrorResponses(onResponse);
    const stub = vi.fn(async (_input: unknown, _init?: RequestInit) => errorResponse());
    vi.stubGlobal("fetch", stub);
    const init: RequestInit = {
      method: "POST",
      headers: { authorization: "Bearer k" },
      body: JSON.stringify({ model: "gpt-5.4" }),
    };

    await wrapper(URL_UNDER_TEST, init);

    expect(stub).toHaveBeenCalledTimes(1);
    const [input, forwardedInit] = stub.mock.calls[0] ?? [];
    expect(input).toBe(URL_UNDER_TEST);
    expect(forwardedInit).toBe(init);
    expect(seen).toHaveLength(1);
  });

  it("AC-4 resolves to the 200 Response the stub returned", async () => {
    const wrapper = observeErrorResponses(() => {});
    const response = okResponse();
    vi.stubGlobal("fetch", async () => response);

    await expect(wrapper(URL_UNDER_TEST)).resolves.toBe(response);
  });

  it("AC-5 never reports a 200 response, and does report an error one", async () => {
    // Both halves in one test: a wrapper that reports nothing at all would
    // satisfy the 200 half alone, so the error half is the positive control.
    const { seen, onResponse } = recording();
    const wrapper = observeErrorResponses(onResponse);
    vi.stubGlobal("fetch", async () => okResponse());

    await wrapper(URL_UNDER_TEST);
    expect(seen).toHaveLength(0);

    vi.stubGlobal("fetch", async () => errorResponse());
    await wrapper(URL_UNDER_TEST);
    expect(seen).toHaveLength(1);
  });

  it("AC-6 rejects with the same error the stubbed fetch rejected with", async () => {
    const wrapper = observeErrorResponses(() => {});
    const failure = new TypeError("network down");
    vi.stubGlobal("fetch", async () => {
      throw failure;
    });

    const rejected = await wrapper(URL_UNDER_TEST).then(
      () => undefined,
      (err: unknown) => err,
    );

    expect(rejected).toBe(failure);
  });

  it("AC-7 never reports a rejected fetch, and does report a resolved error", async () => {
    const { seen, onResponse } = recording();
    const wrapper = observeErrorResponses(onResponse);
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("network down");
    });

    await wrapper(URL_UNDER_TEST).catch(() => undefined);
    expect(seen).toHaveLength(0);

    vi.stubGlobal("fetch", async () => errorResponse());
    await wrapper(URL_UNDER_TEST);
    expect(seen).toHaveLength(1);
  });
});

/**
 * The real-pi half of the suite.
 *
 * Everything below goes through `createClient` and the pi-backed protocols, so
 * the assertion is about what reaches a consumer, not about the wrapper alone:
 * the wiring in `createPiDeps` is what these tests exist to pin, and a wrapper
 * that is never passed to pi-ai would leave them all blind.
 */
const OPENAI_CREDENTIALS = createMemoryCredentialStore({ openai: { kind: "api-key", key: "test-key" } });

/** The rejection reason of one `client.complete` against a stubbed fetch. */
async function completionFailure(fetchImpl: typeof globalThis.fetch): Promise<unknown> {
  vi.stubGlobal("fetch", fetchImpl);
  const client = createClient({
    providers: await defaultProviders(),
    protocols: ({ providerOverrides }) => defaultProtocols({ credentials: OPENAI_CREDENTIALS, providerOverrides }),
    transportRetries: 0,
  });
  const model = await client.model("openai", "gpt-5.4");
  return client.complete(model, { messages: [{ role: "user", content: "hello" }] }).then(
    () => undefined,
    (err: unknown) => err,
  );
}

/** The `protocolError` of a rejection that must be a `ProtocolStreamError`. */
function protocolErrorOf(err: unknown): ProtocolError {
  expect(err).toBeInstanceOf(ProtocolStreamError);
  if (!(err instanceof ProtocolStreamError)) throw new Error("expected a ProtocolStreamError");
  return err.protocolError;
}

/** An HTTP error response carrying a JSON error body, as a provider sends one. */
function jsonErrorStub(status: number, headers: Readonly<Record<string, string>>): typeof globalThis.fetch {
  return async () =>
    new Response(JSON.stringify({ error: { message: `injected ${status}`, type: "server_error" } }), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });
}

/**
 * A 200 SSE response delivering `chunks` one per macrotask — a string body is
 * consumed before the adapter has subscribed, which would turn these controls
 * into truncation tests instead.
 */
function sse200Stub(chunks: readonly string[]): typeof globalThis.fetch {
  return async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const chunk of chunks) {
          await new Promise((resolve) => setTimeout(resolve, 0));
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream", "retry-after": "41" },
    });
  };
}

/**
 * A 200 SSE response whose ONLY event is a terminal `response.failed`. Exactly
 * one chunk is emitted, so the rejection AC-11 asserts on can only have come
 * from that event.
 */
function failedStreamStub(errorCode: string): typeof globalThis.fetch {
  const payload = `{"type":"response.failed","response":{"id":"resp_1","status":"failed","error":{"code":"${errorCode}","message":"slow down"}}}`;
  return sse200Stub([`event: response.failed\ndata: ${payload}\n\n`]);
}

describe("createClient HTTP error status and Retry-After", () => {
  it("AC-8 rejects a 429 with kind rate-limit, status 429 and retryAfter 41", async () => {
    const error = protocolErrorOf(await completionFailure(jsonErrorStub(429, { "retry-after": "41" })));

    expect(error.kind).toBe("rate-limit");
    expect(error.status).toBe(429);
    expect(error.retryAfter).toBe(41);
  });

  it("AC-9 rejects a 503 with kind overloaded, status 503 and retryAfter 41", async () => {
    const error = protocolErrorOf(await completionFailure(jsonErrorStub(503, { "retry-after": "41" })));

    expect(error.kind).toBe("overloaded");
    expect(error.status).toBe(503);
    expect(error.retryAfter).toBe(41);
  });

  it("AC-10 rejects a headerless 429 with status 429 and no retryAfter, and still reads a numeric one", async () => {
    // The positive half is the control for the negative one: a classifier that
    // never reports retryAfter at all cannot satisfy both halves.
    const withoutHeader = protocolErrorOf(await completionFailure(jsonErrorStub(429, {})));
    expect(withoutHeader.status).toBe(429);
    expect(withoutHeader).not.toHaveProperty("retryAfter");

    const withHeader = protocolErrorOf(await completionFailure(jsonErrorStub(429, { "retry-after": "41" })));
    expect(withHeader.status).toBe(429);
    expect(withHeader.retryAfter).toBe(41);
  });

  it("AC-11 rejects a 200 stream that fails with rate_limit, keeping retryAfter from pi's own onResponse", async () => {
    const error = protocolErrorOf(await completionFailure(failedStreamStub("rate_limit")));

    expect(error.kind).toBe("rate-limit");
    expect(error.retryAfter).toBe(41);
    // The stream carries that ONE event and nothing else, so this message can
    // only have come from the `response.failed` payload: it is what proves the
    // rejection was produced by the event, not by the 200 alone.
    expect(error.message).toContain("rate_limit: slow down");
  });

  it("a 200 SSE stream with no events rejects as a truncation, not as rate-limit", async () => {
    // Fixture sensitivity for AC-11: the single event is load-bearing, so an
    // eventless stream must fail a different way. Without this, AC-11 would
    // pass against an adapter that classified every 200 as a rate limit.
    const error = protocolErrorOf(await completionFailure(sse200Stub([])));

    expect(error.kind).toBe("transport");
    expect(error.message).toContain("ended before a terminal response event");
  });

  it("AC-12 rejects a 429 with a non-numeric Retry-After with status 429 and no retryAfter", async () => {
    const nonNumeric = protocolErrorOf(await completionFailure(jsonErrorStub(429, { "retry-after": "soon" })));
    expect(nonNumeric.status).toBe(429);
    expect(nonNumeric).not.toHaveProperty("retryAfter");

    // Positive control, as for AC-10: the same stub with a numeric value must
    // report one, so "never reports anything" cannot pass this test.
    const numeric = protocolErrorOf(await completionFailure(jsonErrorStub(429, { "retry-after": "41" })));
    expect(numeric.retryAfter).toBe(41);
  });
});
