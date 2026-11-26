/**
 * fetchWebPage's body handling: the byte cap, the media types it reads, and the failures a
 * transport raises.
 *
 * Split by concern from `fetch-page.test.ts`, which covers the request a fetch makes, the
 * redirects it follows and the addresses it refuses. Every page here is answered by a stub, so
 * no test in this file reaches the network.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { NaxError } from "#src/infra/index";
import {
  _webFetchDeps,
  fetchWebPage,
  type WebRequestFn,
  type WebRequestHandle,
  type WebRequestOptions,
  type WebResponseHandle,
} from "#src/web/fetch-page";
import { assertDefined, type FakeClock, makeFakeClock } from "#test/helpers/index";

/** The options every test fetches with; a test overrides the cap and the budget it is about. */
const OPTS: { maxBytes: number; timeoutMs: number; allowOrigins: readonly string[] } = {
  maxBytes: 1_000,
  timeoutMs: 5_000,
  allowOrigins: [],
};

const realRequest = _webFetchDeps.request;
const realHttpRequest = _webFetchDeps.httpRequest;
const realSetTimeout = _webFetchDeps.setTimeout;
const realClearTimeout = _webFetchDeps.clearTimeout;

afterEach(() => {
  _webFetchDeps.request = realRequest;
  _webFetchDeps.httpRequest = realHttpRequest;
  _webFetchDeps.setTimeout = realSetTimeout;
  _webFetchDeps.clearTimeout = realClearTimeout;
});

/** The bytes of one body, as the response stream carries them. */
function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** How one stubbed request answers. */
type Answer =
  | {
      readonly kind: "page";
      readonly status?: number;
      readonly contentType?: string;
      readonly body?: string;
      /** The body never arrives: the response is open and streaming nothing. */
      readonly stalled?: boolean;
      /** Thrown by the body stream after `body` arrived: a connection lost mid-read. */
      readonly streamError?: Error;
    }
  | { readonly kind: "silent" }
  | { readonly kind: "failure"; readonly error: Error };

/** A response the module can read, and the one thing this file asks about it. */
interface FakeResponse {
  readonly handle: WebResponseHandle;
  readonly destroyed: () => boolean;
  /** Whether the body stream was ever pulled from: `false` for a page nothing read. */
  readonly streamed: () => boolean;
  /** Resolves when the body read begins, so a test can act on a stream that never ends. */
  readonly started: Promise<void>;
}

/** A request handle that does exactly what a stub needs: it records, and reports once. */
interface FakeRequest {
  readonly handle: WebRequestHandle;
  readonly destroyed: () => boolean;
  /** How many `error` listeners the module detached from this request. */
  readonly detached: () => number;
}

/** The response a page answer stands for; its body is one chunk, then optionally an error. */
function fakeResponse(answer: {
  readonly status?: number;
  readonly contentType?: string;
  readonly body?: string;
  readonly stalled?: boolean;
  readonly streamError?: Error;
}): FakeResponse {
  const headers: Record<string, string> = {};
  if (answer.contentType !== undefined) headers["content-type"] = answer.contentType;
  const streamError = answer.streamError;
  let destroyed = false;
  let streamed = false;
  let markStarted = (): void => {};
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const handle: WebResponseHandle = {
    statusCode: answer.status ?? 200,
    headers,
    resume: () => {},
    destroy: () => {
      destroyed = true;
    },
    body: async function* body() {
      streamed = true;
      markStarted();
      // A stalled body: the stream is open, and it neither yields nor ends.
      if (answer.stalled === true) await new Promise(() => {});
      yield bytes(answer.body ?? "");
      if (streamError !== undefined) throw streamError;
    },
  };
  return { handle, destroyed: () => destroyed, streamed: () => streamed, started };
}

/** A request handle: it reports `onError` once the module listens, and records what it was done. */
function fakeRequest(onError: Error | undefined): FakeRequest {
  let destroyed = false;
  let detached = 0;
  const handle: WebRequestHandle = {
    on: (_event, listener) => {
      if (onError !== undefined) queueMicrotask(() => listener(onError));
    },
    off: () => {
      detached++;
    },
    destroy: () => {
      destroyed = true;
    },
    end: () => {},
  };
  return { handle, destroyed: () => destroyed, detached: () => detached };
}

/** What the stub was asked for, and what it handed back. */
interface FetchStub {
  readonly requests: FakeRequest[];
  readonly responses: FakeResponse[];
  readonly options: WebRequestOptions[];
}

/** Answer the fetch's requests with `answers`, in order, on both request seams. */
function stubFetch(answers: readonly Answer[]): FetchStub {
  const requests: FakeRequest[] = [];
  const responses: FakeResponse[] = [];
  const options: WebRequestOptions[] = [];
  const record: WebRequestFn = (_url, sent, onResponse) => {
    const answer: Answer = answers[requests.length] ?? { kind: "page" };
    const request = fakeRequest(answer.kind === "failure" ? answer.error : undefined);
    requests.push(request);
    options.push(sent);
    if (answer.kind !== "page") return request.handle;
    const response = fakeResponse(answer);
    responses.push(response);
    // Answer on a microtask, the way a socket does: a response never arrives before the
    // request it answers for exists, and the module registers its listeners in that gap.
    queueMicrotask(() => onResponse(response.handle));
    return request.handle;
  };
  _webFetchDeps.request = record;
  _webFetchDeps.httpRequest = record;
  return { requests, responses, options };
}

/** The timer calls one fetch made, recorded on top of the virtual clock it drove them with. */
interface Timers {
  readonly armed: number[];
  readonly cleared: number[];
}

/** Drive the module's deadline off a virtual clock instead of the wall clock. */
function useFakeTimers(clock: FakeClock): Timers {
  const timers: { armed: number[]; cleared: number[] } = { armed: [], cleared: [] };
  _webFetchDeps.setTimeout = (fn, ms) => {
    timers.armed.push(ms);
    return clock.setTimeout(fn, ms);
  };
  // The seam's handle is opaque (`unknown`), so the virtual clock's numeric id is narrowed
  // here rather than cast: this adapter is the only place that knows the handle it was handed
  // is one of the clock's own ids.
  _webFetchDeps.clearTimeout = (handle) => {
    if (typeof handle !== "number") return;
    timers.cleared.push(handle);
    clock.clearTimeout(handle);
  };
  return timers;
}

/**
 * Assert the fetch ran under the story's one deadline: a single timer armed for the whole
 * budget and cleared when the fetch ended, however it ended.
 *
 * This is the half of every fetch US-006 owns. The page behaviour the ACs below read --
 * conversion, title, links, the unsupported page, the status, request-error wrapping -- landed
 * with US-005, so this is also what makes those tests fail on a tree without US-006; each one
 * asserts it alongside its AC so the pair is what the test pins.
 */
function expectOneDeadline(timers: Timers, stub: FetchStub): void {
  expect(timers.armed).toEqual([OPTS.timeoutMs]);
  expect(timers.cleared).toHaveLength(1);
  // The hop settled, so the error listener it needed is gone with it.
  expect(stub.requests[0]?.detached()).toBe(1);
}

/** The NaxError a fetch rejected with; fails the test when it resolved or threw something else. */
async function rejection(promise: Promise<unknown>): Promise<NaxError> {
  const outcome = await promise.then(
    () => null,
    (error: unknown) => error,
  );
  if (outcome instanceof NaxError) return outcome;
  throw new Error(outcome === null ? "the fetch resolved instead of rejecting" : String(outcome));
}

/** A two-byte UTF-8 character, so a test can tell a byte cap from a character cap. */
const ACCENTED = "\u00e9";

describe("fetchWebPage bodies", () => {
  describe("the byte cap", () => {
    test("AC-1: a body longer than maxBytes keeps the first maxBytes bytes", async () => {
      stubFetch([{ kind: "page", contentType: "text/plain", body: "a".repeat(2048) }]);
      const page = await fetchWebPage("https://a.example/p", OPTS);
      expect(page.text).toBe("a".repeat(1000));
    });

    test("AC-2: a body longer than maxBytes resolves truncated", async () => {
      stubFetch([{ kind: "page", contentType: "text/plain", body: "a".repeat(2048) }]);
      const page = await fetchWebPage("https://a.example/p", OPTS);
      expect(page.truncated).toBe(true);
    });

    test("AC-3: a body shorter than maxBytes is read whole and not truncated", async () => {
      stubFetch([{ kind: "page", contentType: "text/plain", body: "a".repeat(10) }]);
      const page = await fetchWebPage("https://a.example/p", OPTS);
      expect(page.text).toBe("a".repeat(10));
      expect(page.truncated).toBe(false);
      expect(page.unsupported).toBe(false);
    });

    test("the cap counts bytes, not characters", async () => {
      stubFetch([{ kind: "page", contentType: "text/plain", body: ACCENTED.repeat(10) }]);
      const page = await fetchWebPage("https://a.example/p", { ...OPTS, maxBytes: 10 });
      expect(page.text).toBe(ACCENTED.repeat(5));
      expect(page.truncated).toBe(true);
    });

    test("a body exactly at the cap is not truncated", async () => {
      stubFetch([{ kind: "page", contentType: "text/plain", body: "a".repeat(1000) }]);
      const page = await fetchWebPage("https://a.example/p", OPTS);
      expect(page.text).toBe("a".repeat(1000));
      expect(page.truncated).toBe(false);
    });

    test("terminates the response once the cap is reached", async () => {
      const stub = stubFetch([{ kind: "page", contentType: "text/plain", body: "a".repeat(2048) }]);
      await fetchWebPage("https://a.example/p", OPTS);
      const [response] = stub.responses;
      expect(response?.destroyed()).toBe(true);
    });
  });

  describe("the media types it reads", () => {
    test("AC-4: a text/plain body passes through as written", async () => {
      stubFetch([{ kind: "page", contentType: "text/plain; charset=utf-8", body: "a<b" }]);
      const page = await fetchWebPage("https://a.example/p", OPTS);
      expect(page.text).toBe("a<b");
    });

    test("AC-5: a text/markdown body passes through as written", async () => {
      stubFetch([{ kind: "page", contentType: "text/markdown", body: "# T" }]);
      const page = await fetchWebPage("https://a.example/p", OPTS);
      expect(page.text).toBe("# T");
    });

    test("AC-6: an application/json body passes through as written", async () => {
      stubFetch([{ kind: "page", contentType: "application/json", body: '{"a":1}' }]);
      const page = await fetchWebPage("https://a.example/p", OPTS);
      expect(page.text).toBe('{"a":1}');
    });

    test("AC-7: an application/xhtml+xml body is converted like HTML", async () => {
      const timers = useFakeTimers(makeFakeClock());
      const stub = stubFetch([{ kind: "page", contentType: "application/xhtml+xml", body: "<p>x</p>" }]);
      const page = await fetchWebPage("https://a.example/p", OPTS);
      expect(page.text).toBe("x");
      expect(page.contentType).toBe("application/xhtml+xml");
      expectOneDeadline(timers, stub);
    });

    test("AC-16: a text/html body is converted, charset parameter and all", async () => {
      const timers = useFakeTimers(makeFakeClock());
      const stub = stubFetch([{ kind: "page", contentType: "text/html; charset=utf-8", body: "<p>hi</p>" }]);
      const page = await fetchWebPage("https://a.example/p", OPTS);
      expect(page.text).toBe("hi");
      expect(page.contentType).toBe("text/html");
      // The request US-005 established is the one this story kept making for the same call.
      expect(stub.options[0]?.method).toBe("GET");
      expect(stub.options[0]?.headers["user-agent"]).toBe("nax-web/1");
      expectOneDeadline(timers, stub);
    });

    test("a body it reads is not reported as unsupported", async () => {
      stubFetch([{ kind: "page", contentType: "application/json", body: "{}" }]);
      const page = await fetchWebPage("https://a.example/p", OPTS);
      expect(page.unsupported).toBe(false);
      expect(page.links).toEqual([]);
    });
  });

  describe("the HTML it converts", () => {
    test("AC-8: reports the page's title", async () => {
      const timers = useFakeTimers(makeFakeClock());
      const stub = stubFetch([
        { kind: "page", contentType: "text/html", body: "<html><head><title>T</title></head><p>x</p></html>" },
      ]);
      const page = await fetchWebPage("https://a.example/p", OPTS);
      expect(page.title).toBe("T");
      expect(page.text).toBe("x");
      expectOneDeadline(timers, stub);
    });

    test("AC-9: collects an absolute link resolved against the page's URL", async () => {
      const timers = useFakeTimers(makeFakeClock());
      const stub = stubFetch([{ kind: "page", contentType: "text/html", body: '<a href="/d">D</a>' }]);
      const page = await fetchWebPage("https://a.example/", OPTS);
      expect(page.links).toEqual(["https://a.example/d"]);
      expect(page.text).toBe("D (https://a.example/d)");
      expectOneDeadline(timers, stub);
    });

    test("a truncated HTML body keeps the truncation flag through the conversion", async () => {
      stubFetch([{ kind: "page", contentType: "text/html", body: `<p>${"a".repeat(2000)}</p>` }]);
      const page = await fetchWebPage("https://a.example/p", OPTS);
      expect(page.truncated).toBe(true);
      expect(page.text.length).toBeLessThanOrEqual(1000);
    });
  });

  describe("what it will not read", () => {
    test("AC-10: an image/png response reports itself unsupported", async () => {
      const timers = useFakeTimers(makeFakeClock());
      const stub = stubFetch([{ kind: "page", contentType: "image/png", body: "png" }]);
      const page = await fetchWebPage("https://a.example/p", OPTS);
      expect(page.unsupported).toBe(true);
      // Nothing was read: the body stream was never even pulled from.
      expect(stub.responses[0]?.streamed()).toBe(false);
      expectOneDeadline(timers, stub);
    });

    test("AC-11: an image/png response says nothing was read", async () => {
      const timers = useFakeTimers(makeFakeClock());
      const stub = stubFetch([{ kind: "page", contentType: "image/png", body: "png" }]);
      const page = await fetchWebPage("https://a.example/p", OPTS);
      expect(page.text).toBe("Unsupported content type image/png; nothing was read.");
      expect(page.contentType).toBe("image/png");
      expect(page.truncated).toBe(false);
      expectOneDeadline(timers, stub);
    });

    test("an unsupported body is never streamed", async () => {
      const stub = stubFetch([{ kind: "page", contentType: "image/png", body: "png" }]);
      await fetchWebPage("https://a.example/p", OPTS);
      const [request] = stub.requests;
      expect(request?.destroyed()).toBe(false);
    });
  });

  describe("the status it reports", () => {
    test("AC-12: a 404 is a page carrying its status, not a failure", async () => {
      const timers = useFakeTimers(makeFakeClock());
      const stub = stubFetch([{ kind: "page", status: 404, contentType: "text/html", body: "<p>gone</p>" }]);
      const page = await fetchWebPage("https://a.example/p", OPTS);
      expect(page.status).toBe(404);
      // The page is still read and converted; only the status says it went wrong.
      expect(page.text).toBe("gone");
      expect(page.unsupported).toBe(false);
      expectOneDeadline(timers, stub);
    });
  });

  describe("transport failures", () => {
    test("AC-13: a request that never answers fails the fetch at its deadline", async () => {
      const clock = makeFakeClock();
      useFakeTimers(clock);
      stubFetch([{ kind: "silent" }]);
      const pending = rejection(fetchWebPage("https://a.example/p", OPTS));
      await clock.advance(OPTS.timeoutMs);
      const error = await pending;
      expect(error.code).toBe("WEB_FETCH_FAILED");
    });

    test("AC-14: a request error fails the fetch", async () => {
      const timers = useFakeTimers(makeFakeClock());
      const stub = stubFetch([{ kind: "failure", error: new Error("ECONNRESET") }]);
      const error = await rejection(fetchWebPage("https://a.example/p", OPTS));
      expect(error.code).toBe("WEB_FETCH_FAILED");
      expectOneDeadline(timers, stub);
    });

    test("AC-15: a request error's message reaches the failure", async () => {
      const timers = useFakeTimers(makeFakeClock());
      const stub = stubFetch([{ kind: "failure", error: new Error("ECONNRESET") }]);
      const error = await rejection(fetchWebPage("https://a.example/p", OPTS));
      expect(error.message).toBe("ECONNRESET");
      expectOneDeadline(timers, stub);
    });

    test("a deadline destroys the request it was waiting on", async () => {
      const clock = makeFakeClock();
      useFakeTimers(clock);
      const stub = stubFetch([{ kind: "silent" }]);
      const pending = rejection(fetchWebPage("https://a.example/p", OPTS));
      await clock.advance(OPTS.timeoutMs);
      await pending;
      const [request] = stub.requests;
      expect(request?.destroyed()).toBe(true);
    });

    test("the deadline timer is released once the page is in hand", async () => {
      const clock = makeFakeClock();
      const timers = useFakeTimers(clock);
      stubFetch([{ kind: "page", contentType: "text/plain", body: "hi" }]);
      await fetchWebPage("https://a.example/p", OPTS);
      expect(timers.armed).toEqual([OPTS.timeoutMs]);
      expect(timers.cleared).toHaveLength(1);
      expect(clock.pending()).toBe(0);
    });

    test("the deadline timer is released after a timeout", async () => {
      const clock = makeFakeClock();
      useFakeTimers(clock);
      stubFetch([{ kind: "silent" }]);
      const pending = rejection(fetchWebPage("https://a.example/p", OPTS));
      await clock.advance(OPTS.timeoutMs);
      await pending;
      expect(clock.pending()).toBe(0);
    });

    test("a body that stalls is cut off by the deadline", async () => {
      const clock = makeFakeClock();
      useFakeTimers(clock);
      const stub = stubFetch([{ kind: "page", contentType: "text/plain", stalled: true }]);
      const pending = rejection(fetchWebPage("https://a.example/p", OPTS));
      const [response] = stub.responses;
      assertDefined(response, "the stub answered the request");
      // Act only once the body read is live, so this is the body stage that the deadline cuts.
      await response.started;
      await clock.advance(OPTS.timeoutMs);
      const error = await pending;
      expect(error.code).toBe("WEB_FETCH_FAILED");
      expect(response.destroyed()).toBe(true);
    });

    test("a body lost mid-read fails the fetch, naming the cause", async () => {
      stubFetch([{ kind: "page", contentType: "text/plain", body: "half", streamError: new Error("socket closed") }]);
      const error = await rejection(fetchWebPage("https://a.example/p", OPTS));
      expect(error.code).toBe("WEB_FETCH_FAILED");
      expect(error.message).toContain("socket closed");
    });

    test("a caller signal that is already aborted fails the fetch without a request", async () => {
      const stub = stubFetch([{ kind: "page", contentType: "text/plain", body: "hi" }]);
      const error = await rejection(
        fetchWebPage("https://a.example/p", { ...OPTS, signal: AbortSignal.abort(new Error("turn over")) }),
      );
      expect(error.code).toBe("WEB_FETCH_FAILED");
      expect(stub.requests).toHaveLength(0);
    });
  });
});
