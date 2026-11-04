/**
 * koda-http.ts — the injectable, bounded, header-safe HTTP client for koda's
 * response envelope.
 *
 * Covers US-002 AC-1..AC-16.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NaxError } from "@/errors";
import {
  _kodaClientDeps,
  createKodaClient,
  type KodaClient,
  kodaStatusOf,
  MEMORY_KODA_REQUEST_TIMEOUT_MS,
} from "@/memory/koda-http";

interface FetchCall {
  readonly url: string;
  readonly init: RequestInit;
}

let calls: FetchCall[] = [];
let originalFetch: typeof _kodaClientDeps.fetch;

/** Replace the fetch seam with `answer`, recording every call it receives. */
function stubFetch(answer: (call: FetchCall) => Response | Promise<Response>): void {
  _kodaClientDeps.fetch = async (input, init) => {
    const call: FetchCall = { url: input, init };
    calls.push(call);
    return await answer(call);
  };
}

function makeClient(headers: Readonly<Record<string, string>> = {}, timeoutMs = 1000): KodaClient {
  return createKodaClient({ url: "https://k.example/api/", headers, timeoutMs });
}

/** A koda envelope answer with `status` and the response's own status text. */
function jsonAnswer(body: unknown, status = 200, statusText = ""): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { "content-type": "application/json" },
  });
}

/** The NaxError `promise` rejects with; fails the test when it resolves instead. */
async function rejection(promise: Promise<unknown>): Promise<NaxError> {
  const caught: unknown = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  if (!(caught instanceof NaxError)) throw new Error(`expected a NaxError, got ${String(caught)}`);
  return caught;
}

beforeEach(() => {
  originalFetch = _kodaClientDeps.fetch;
  calls = [];
});

afterEach(() => {
  _kodaClientDeps.fetch = originalFetch;
});

describe("createKodaClient — request building", () => {
  test("builds the URL from the config root without its trailing slash and skips an undefined query value (AC-1)", async () => {
    stubFetch(() => jsonAnswer({ ret: 0, data: {} }));

    await makeClient().get("projects/rs/memory/export", { since: undefined, take: 200 });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://k.example/api/projects/rs/memory/export?take=200");
  });

  test("appends query keys in insertion order with a plus for a space (AC-2)", async () => {
    stubFetch(() => jsonAnswer({ ret: 0, data: {} }));

    await makeClient().get("memory/search", { kind: "NOTE", subject: "a b" });

    const url = calls[0]?.url ?? "";
    expect(url).toBe("https://k.example/api/memory/search?kind=NOTE&subject=a+b");
    expect(url.endsWith("?kind=NOTE&subject=a+b")).toBe(true);
  });

  test("a root url with no trailing slash still yields one separator", async () => {
    stubFetch(() => jsonAnswer({ ret: 0, data: {} }));

    await createKodaClient({ url: "https://k.example/api", headers: {}, timeoutMs: 1000 }).get("projects/rs");

    expect(calls[0]?.url).toBe("https://k.example/api/projects/rs");
  });

  test("a get sends method GET, the configured headers plus accept, and no body (AC-3)", async () => {
    stubFetch(() => jsonAnswer({ ret: 0, data: {} }));

    await makeClient({ Authorization: "Bearer k", "x-team": "rs" }).get("projects/rs");

    expect(calls[0]?.init.method).toBe("GET");
    expect(calls[0]?.init.headers).toEqual({
      authorization: "Bearer k",
      "x-team": "rs",
      accept: "application/json",
    });
    expect(calls[0]?.init.body).toBeUndefined();
  });

  test("a configured Accept header is folded to the required JSON media type (F4)", async () => {
    stubFetch(() => jsonAnswer({ ret: 0, data: {} }));

    await makeClient({ Accept: "text/plain" }).get("projects/rs");

    expect(calls[0]?.init.headers).toEqual({ accept: "application/json" });
  });

  test("a configured Content-Type header cannot override the JSON one on a post (F4)", async () => {
    stubFetch(() => jsonAnswer({ ret: 0, data: {} }));

    await makeClient({ "Content-Type": "text/plain" }).post("memory", { a: 1 });

    expect(calls[0]?.init.headers).toEqual({ accept: "application/json", "content-type": "application/json" });
    expect(calls[0]?.init.body).toBe('{"a":1}');
  });

  test("a post sends method POST, content-type plus the JSON body (AC-4)", async () => {
    stubFetch(() => jsonAnswer({ ret: 0, data: { id: "n1" } }));

    await makeClient().post("memory", { a: 1 });

    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.headers).toEqual({ accept: "application/json", "content-type": "application/json" });
    expect(calls[0]?.init.body).toBe('{"a":1}');
  });

  test("a post with no query on a trailing-slash root posts to the bare path", async () => {
    stubFetch(() => jsonAnswer({ ret: 0, data: {} }));

    await makeClient().post("memory", { a: 1 });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://k.example/api/memory");
  });
});

describe("createKodaClient — success answers", () => {
  test("resolves the status and the envelope's data (AC-5)", async () => {
    stubFetch(() => jsonAnswer({ ret: 0, data: { id: "p1" } }));

    expect(await makeClient().get("projects/rs")).toEqual({ status: 200, data: { id: "p1" } });
  });

  test("keeps a 202 status for an acceptance answer (AC-6)", async () => {
    stubFetch(() => jsonAnswer({ ret: 0, data: { id: "apr_1" } }, 202));

    const answer = await makeClient().post("memory", { a: 1 });

    expect(answer.status).toBe(202);
    expect(answer.data).toEqual({ id: "apr_1" });
  });

  test("resolves no data for a 2xx body that carries no data field", async () => {
    stubFetch(() => jsonAnswer({ ret: 0 }));

    expect(await makeClient().get("projects/rs")).toEqual({ status: 200, data: undefined });
  });
});

describe("createKodaClient — failure answers", () => {
  test("rejects with MEMORY_KODA_BAD_RESPONSE when a 2xx body is not JSON (AC-7)", async () => {
    stubFetch(() => new Response("not json", { status: 200, statusText: "OK" }));

    const error = await rejection(makeClient().get("projects/rs"));

    expect(error.code).toBe("MEMORY_KODA_BAD_RESPONSE");
    expect(error.context?.status).toBe(200);
  });

  test("rejects with MEMORY_KODA_HTTP quoting koda's message for a 422 (AC-8)", async () => {
    stubFetch(() => jsonAnswer({ ret: -2, message: "description is required" }, 422, "Unprocessable Entity"));

    const error = await rejection(makeClient().post("memory", { a: 1 }));

    expect(error.code).toBe("MEMORY_KODA_HTTP");
    expect(error.message).toBe("[memory] koda POST memory answered 422: description is required");
  });

  test("falls back to the response's status text when a non-2xx body is not JSON (AC-9)", async () => {
    stubFetch(() => new Response("service unavailable", { status: 503, statusText: "Service Unavailable" }));

    const error = await rejection(makeClient().get("projects/rs"));

    expect(error.code).toBe("MEMORY_KODA_HTTP");
    expect(error.context?.status).toBe(503);
    expect(error.message.endsWith("Service Unavailable")).toBe(true);
    expect(error.message).toBe("[memory] koda GET projects/rs answered 503: Service Unavailable");
  });

  test("falls back to the status text when the body's message is not a string", async () => {
    stubFetch(() => jsonAnswer({ ret: -2, message: { nested: true } }, 400, "Bad Request"));

    const error = await rejection(makeClient().get("projects/rs"));

    expect(error.message).toBe("[memory] koda GET projects/rs answered 400: Bad Request");
  });
});

describe("kodaStatusOf", () => {
  test("returns the status of a MEMORY_KODA_HTTP error (AC-10)", async () => {
    stubFetch(() => jsonAnswer({ ret: -2, message: "description is required" }, 422));

    const error = await rejection(makeClient().post("memory", {}));

    expect(kodaStatusOf(error)).toBe(422);
  });

  test("returns undefined for a MEMORY_KODA_TIMEOUT error (AC-11)", async () => {
    stubFetch(() => new Promise<Response>(() => {}));

    const error = await rejection(makeClient({}, 20).get("projects/rs"));

    expect(error.code).toBe("MEMORY_KODA_TIMEOUT");
    expect(kodaStatusOf(error)).toBeUndefined();
  });

  test("returns undefined for a non-NaxError, a plain NaxError and an error with no numeric status", () => {
    expect(kodaStatusOf(new TypeError("connection refused"))).toBeUndefined();
    expect(kodaStatusOf(new NaxError("[memory] boom", "MEMORY_KODA_UNREACHABLE", { stage: "memory" }))).toBeUndefined();
    expect(kodaStatusOf(new NaxError("[memory] boom", "MEMORY_KODA_HTTP", { status: "422" }))).toBeUndefined();
  });
});

describe("createKodaClient — deadlines and transport failures", () => {
  test("rejects with MEMORY_KODA_TIMEOUT when fetch never settles (AC-12)", async () => {
    stubFetch(() => new Promise<Response>(() => {}));
    const timeoutMs = 20;
    const startedAt = performance.now();

    const error = await rejection(makeClient({}, timeoutMs).get("projects/rs"));
    const elapsed = performance.now() - startedAt;

    expect(error.code).toBe("MEMORY_KODA_TIMEOUT");
    expect(error.context?.timeoutMs).toBe(timeoutMs);
    expect(elapsed).toBeGreaterThanOrEqual(timeoutMs - 5);
    expect(elapsed).toBeLessThan(1000);
  });

  test("aborts the signal it passed to fetch when the deadline expires (AC-13)", async () => {
    stubFetch(() => new Promise<Response>(() => {}));

    const error = await rejection(makeClient({}, 20).get("projects/rs"));

    expect(error.code).toBe("MEMORY_KODA_TIMEOUT");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.init.signal?.aborted).toBe(true);
  });

  test("the deadline also bounds reading the body, so a stalled body rejects (F1)", async () => {
    // Headers arrive at once; the body never does — only a deadline around the read can end the call.
    stubFetch(() => new Response(new ReadableStream({ start() {} }), { status: 200 }));

    const error = await rejection(makeClient({}, 20).get("projects/rs"));

    expect(error.code).toBe("MEMORY_KODA_TIMEOUT");
    expect(calls[0]?.init.signal?.aborted).toBe(true);
  });

  test("rejects with MEMORY_KODA_UNREACHABLE carrying the rejection as cause (AC-14)", async () => {
    const refused = new TypeError("connection refused");
    stubFetch(() => Promise.reject(refused));

    const error = await rejection(makeClient().get("projects/rs"));

    expect(error.code).toBe("MEMORY_KODA_UNREACHABLE");
    expect(error.context?.cause).toBe(refused);
    expect(error.message).toBe("[memory] koda GET projects/rs unreachable: connection refused");
  });
});

describe("createKodaClient — header safety", () => {
  test("a 401 error names neither the message nor the serialised context of the key (AC-15)", async () => {
    stubFetch(() => jsonAnswer({ ret: -1, message: "unauthorized" }, 401, "Unauthorized"));

    const error = await rejection(makeClient({ Authorization: "Bearer s3cr3t-key" }).get("projects/rs"));

    expect(error.code).toBe("MEMORY_KODA_HTTP");
    expect(error.message).toContain("answered 401");
    expect(error.message).not.toContain("s3cr3t-key");
    expect(JSON.stringify(error.context)).not.toContain("s3cr3t-key");
  });

  test("redacts a configured header value a failing fetch reports back", async () => {
    stubFetch(() => Promise.reject(new TypeError("bad header Authorization: Bearer s3cr3t-key")));

    const error = await rejection(makeClient({ Authorization: "Bearer s3cr3t-key" }).get("projects/rs"));

    expect(error.code).toBe("MEMORY_KODA_UNREACHABLE");
    expect(error.message).not.toContain("s3cr3t-key");
    expect(JSON.stringify(error.context)).not.toContain("s3cr3t-key");
  });

  test("redacts a configured header value a non-2xx body echoes", async () => {
    stubFetch(() => jsonAnswer({ ret: -1, message: "bad key Bearer s3cr3t-key" }, 401, "Unauthorized"));

    const error = await rejection(makeClient({ Authorization: "Bearer s3cr3t-key" }).get("projects/rs"));

    expect(error.message).toBe("[memory] koda GET projects/rs answered 401: bad key [redacted]");
  });

  test("redacts the token of a bearer credential a non-2xx body echoes without its scheme (F2)", async () => {
    stubFetch(() => jsonAnswer({ ret: -1, message: "invalid key s3cr3t-key" }, 401, "Unauthorized"));

    const error = await rejection(makeClient({ Authorization: "Bearer s3cr3t-key" }).get("projects/rs"));

    expect(error.message).toBe("[memory] koda GET projects/rs answered 401: invalid key [redacted]");
  });

  test("redacts a short bearer token too, since the scheme names where the secret starts (F2)", async () => {
    stubFetch(() => jsonAnswer({ ret: -1, message: "invalid key q7z" }, 401, "Unauthorized"));

    const error = await rejection(makeClient({ Authorization: "Bearer q7z" }).get("projects/rs"));

    expect(error.message).toBe("[memory] koda GET projects/rs answered 401: invalid key [redacted]");
  });

  test("a string rejection carrying the header value is not exposed in context (F3)", async () => {
    stubFetch(() => Promise.reject("Bearer s3cr3t-key rejected"));

    const error = await rejection(makeClient({ Authorization: "Bearer s3cr3t-key" }).get("projects/rs"));

    expect(error.code).toBe("MEMORY_KODA_UNREACHABLE");
    expect(error.message).not.toContain("s3cr3t-key");
    expect(JSON.stringify(error.context)).not.toContain("s3cr3t-key");
  });

  test("a structured-object rejection carrying the header value is not exposed in context (F3)", async () => {
    stubFetch(() => Promise.reject({ headers: { Authorization: "Bearer s3cr3t-key" } }));

    const error = await rejection(makeClient({ Authorization: "Bearer s3cr3t-key" }).get("projects/rs"));

    expect(error.code).toBe("MEMORY_KODA_UNREACHABLE");
    expect(JSON.stringify(error.context)).not.toContain("s3cr3t-key");
  });

  test("an Error rejection carrying the header value in a custom property is not exposed in context (F3)", async () => {
    const leaky = Object.assign(new TypeError("socket closed"), { request: { authorization: "Bearer s3cr3t-key" } });
    stubFetch(() => Promise.reject(leaky));

    const error = await rejection(makeClient({ Authorization: "Bearer s3cr3t-key" }).get("projects/rs"));

    expect(error.code).toBe("MEMORY_KODA_UNREACHABLE");
    expect(JSON.stringify(error.context)).not.toContain("s3cr3t-key");
  });

  test("an Error rejection naming only the token is not exposed in context (F3)", async () => {
    stubFetch(() => Promise.reject(new TypeError("unauthorized: s3cr3t-key")));

    const error = await rejection(makeClient({ Authorization: "Bearer s3cr3t-key" }).get("projects/rs"));

    expect(JSON.stringify(error.context)).not.toContain("s3cr3t-key");
  });

  test("an Error whose name carries the credential does not leak it through the redacted type (F3)", async () => {
    const leakyName = new TypeError("socket closed");
    leakyName.name = "Bearer s3cr3t-key";
    stubFetch(() => Promise.reject(leakyName));

    const error = await rejection(makeClient({ Authorization: "Bearer s3cr3t-key" }).get("projects/rs"));

    expect(error.code).toBe("MEMORY_KODA_UNREACHABLE");
    expect(error.message).not.toContain("s3cr3t-key");
    expect(JSON.stringify(error.context)).not.toContain("s3cr3t-key");
    expect(error.context?.cause).toMatchObject({ redacted: true, type: "[redacted]" });
    expect(JSON.stringify(error.context?.cause)).toContain("socket closed");
  });

  test("an Error whose name carries only the bare token does not leak it through the redacted type (F3)", async () => {
    const leakyName = new TypeError("socket closed");
    leakyName.name = "s3cr3t-key";
    stubFetch(() => Promise.reject(leakyName));

    const error = await rejection(makeClient({ Authorization: "Bearer s3cr3t-key" }).get("projects/rs"));

    expect(JSON.stringify(error.context)).not.toContain("s3cr3t-key");
  });
});

describe("MEMORY_KODA_REQUEST_TIMEOUT_MS", () => {
  test("is 4000, under sync's 10s per-operation race (AC-16)", () => {
    expect(MEMORY_KODA_REQUEST_TIMEOUT_MS).toBe(4000);
  });
});
