import { afterEach, describe, expect, test } from "bun:test";
import type { LookupFunction } from "node:net";
import { NaxError } from "#src/infra/index";
import { _webAddressDeps } from "#src/web/address";
import {
  _webFetchDeps,
  fetchWebPage,
  type WebRequestFn,
  type WebRequestHandle,
  type WebRequestOptions,
  type WebResponseHandle,
} from "#src/web/fetch-page";

/** The options every test fetches with; the story's byte cap and timeout land later. */
const OPTS: { maxBytes: number; timeoutMs: number; allowOrigins: readonly string[] } = {
  maxBytes: 1_000_000,
  timeoutMs: 5_000,
  allowOrigins: [],
};

const realHttpsRequest = _webFetchDeps.request;
const realHttpRequest = _webFetchDeps.httpRequest;
const realLookup = _webAddressDeps.lookup;

afterEach(() => {
  _webFetchDeps.request = realHttpsRequest;
  _webFetchDeps.httpRequest = realHttpRequest;
  _webAddressDeps.lookup = realLookup;
});

/** One answer the stubbed request gives, in the order the requests are made. */
type Answer =
  | { readonly kind: "page"; readonly status?: number; readonly contentType?: string; readonly body?: string }
  | { readonly kind: "redirect"; readonly location: string; readonly status?: number }
  | { readonly kind: "failure"; readonly error: Error };

/** One request the module made, as it made it. */
interface SentRequest {
  readonly url: URL;
  readonly options: WebRequestOptions;
}

/** Every request the stub answered, split by the seam it arrived on. */
interface FetchStub {
  readonly https: SentRequest[];
  readonly http: SentRequest[];
  readonly all: SentRequest[];
}

/** What an answer list with nothing left gives: a page, so an unexpected request still settles. */
const UNSCRIPTED: Answer = { kind: "page" };

/** A request handle that answers whatever the stub says and does nothing else. */
function settledHandle(): WebRequestHandle {
  return { on: () => {}, off: () => {}, destroy: () => {}, end: () => {} };
}

/** A request handle that reports a connection failure instead of a response. */
function failedHandle(error: Error): WebRequestHandle {
  return {
    on: (_event, listener) => {
      queueMicrotask(() => listener(error));
    },
    off: () => {},
    destroy: () => {},
    end: () => {},
  };
}

/** A response the module can read: its body arrives as one chunk, then the stream ends. */
function fakeResponse(p: {
  readonly status: number;
  readonly headers?: Record<string, string>;
  readonly body?: string;
}): WebResponseHandle {
  const body = new TextEncoder().encode(p.body ?? "");
  return {
    statusCode: p.status,
    headers: p.headers ?? {},
    destroy: () => {},
    body: async function* () {
      yield body;
    },
  };
}

/** The response a scripted page answer stands for. */
function pageResponse(answer: { readonly status?: number; readonly contentType?: string; readonly body?: string }) {
  const headers: Record<string, string> = {};
  if (answer.contentType !== undefined) headers["content-type"] = answer.contentType;
  return fakeResponse({ status: answer.status ?? 200, headers, body: answer.body ?? "" });
}

/** The response a scripted redirect answer stands for. */
function redirectResponse(answer: { readonly location: string; readonly status?: number }): WebResponseHandle {
  return fakeResponse({ status: answer.status ?? 302, headers: { location: answer.location } });
}

/** Answer the fetch's requests with `answers`, in order, and report what it sent. */
function stubFetch(answers: readonly Answer[]): FetchStub {
  const https: SentRequest[] = [];
  const http: SentRequest[] = [];
  const all: SentRequest[] = [];
  const record =
    (into: SentRequest[]): WebRequestFn =>
    (url, options, onResponse) => {
      const sent = { url, options };
      all.push(sent);
      into.push(sent);
      const answer = answers[all.length - 1] ?? UNSCRIPTED;
      if (answer.kind === "failure") return failedHandle(answer.error);
      onResponse(answer.kind === "redirect" ? redirectResponse(answer) : pageResponse(answer));
      return settledHandle();
    };
  _webFetchDeps.request = record(https);
  _webFetchDeps.httpRequest = record(http);
  return { https, http, all };
}

/** Answer every address lookup with one address, the way a non-`all` lookup does. */
function stubAddress(address: string, family = 4): void {
  _webAddressDeps.lookup = (_hostname, _options, callback) => {
    callback(null, address, family);
  };
}

/** The first request the fetch made; fails the test when it made none. */
function firstRequest(stub: FetchStub): SentRequest {
  const [first] = stub.all;
  if (first === undefined) throw new Error("the fetch made no request");
  return first;
}

/** Run a lookup and collect the error it called back with. */
function runLookup(lookup: LookupFunction): Promise<{ readonly error: NodeJS.ErrnoException | null }> {
  return new Promise((resolve) => {
    lookup("a.example", {}, (error) => resolve({ error }));
  });
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

/** Six responses, each redirecting to the next: one more hop than a fetch may follow. */
const SIX_REDIRECTS: readonly Answer[] = [0, 1, 2, 3, 4, 5].map((hop) => ({
  kind: "redirect",
  location: `/hop${hop}`,
}));

describe("fetchWebPage", () => {
  describe("the page it returns", () => {
    test("AC-1: converts an HTML body to the page's text", async () => {
      stubFetch([{ kind: "page", contentType: "text/html; charset=utf-8", body: "<p>hi</p>" }]);
      const page = await fetchWebPage("https://a.example/p", OPTS);
      expect(page.text).toBe("hi");
    });

    test("AC-2: reports the response's media type as the page's content type", async () => {
      stubFetch([{ kind: "page", contentType: "text/html; charset=utf-8", body: "<p>hi</p>" }]);
      const page = await fetchWebPage("https://a.example/p", OPTS);
      expect(page.contentType).toBe("text/html");
    });
  });

  describe("the request it makes", () => {
    test("AC-3: asks for the page with GET", async () => {
      const stub = stubFetch([{ kind: "page", body: "hi" }]);
      await fetchWebPage("https://a.example/p", OPTS);
      expect(firstRequest(stub).options.method).toBe("GET");
    });

    test("AC-4: identifies itself as nax-web/1", async () => {
      const stub = stubFetch([{ kind: "page", body: "hi" }]);
      await fetchWebPage("https://a.example/p", OPTS);
      expect(firstRequest(stub).options.headers["user-agent"]).toBe("nax-web/1");
    });

    test("AC-5: sends no cookie", async () => {
      const stub = stubFetch([{ kind: "page", body: "hi" }]);
      await fetchWebPage("https://a.example/p", OPTS);
      expect(firstRequest(stub).options.headers.cookie).toBeUndefined();
    });

    test("AC-6: sends no authorization header", async () => {
      const stub = stubFetch([{ kind: "page", body: "hi" }]);
      await fetchWebPage("https://a.example/p", OPTS);
      expect(firstRequest(stub).options.headers.authorization).toBeUndefined();
    });

    test("AC-7: carries a lookup that refuses an address in a private range", async () => {
      stubAddress("10.0.0.5");
      const stub = stubFetch([{ kind: "page", body: "hi" }]);
      await fetchWebPage("https://a.example/p", OPTS);
      const outcome = await runLookup(firstRequest(stub).options.lookup);
      expect(outcome.error?.code).toBe("WEB_ADDRESS_BLOCKED");
    });

    test("AC-8: fetches an http: URL through the http request", async () => {
      const stub = stubFetch([{ kind: "page", body: "hi" }]);
      await fetchWebPage("http://a.example/p", OPTS);
      expect(stub.http).toHaveLength(1);
      expect(stub.https).toHaveLength(0);
    });

    test("AC-9: fetches an https: URL through the https request", async () => {
      const stub = stubFetch([{ kind: "page", body: "hi" }]);
      await fetchWebPage("https://a.example/p", OPTS);
      expect(stub.https).toHaveLength(1);
      expect(stub.http).toHaveLength(0);
    });
  });

  describe("redirects", () => {
    test("AC-10: follows a relative Location and reports the URL it ended at", async () => {
      const stub = stubFetch([
        { kind: "redirect", location: "/next" },
        { kind: "page", body: "hi" },
      ]);
      const page = await fetchWebPage("https://a.example/p", OPTS);
      expect(page.url).toBe("https://a.example/next");
      expect(stub.all).toHaveLength(2);
    });

    test("AC-11: a sixth consecutive redirect fails the fetch", async () => {
      stubFetch(SIX_REDIRECTS);
      const error = await rejection(fetchWebPage("https://a.example/p", OPTS));
      expect(error.code).toBe("WEB_FETCH_FAILED");
    });

    test("AC-12: a sixth consecutive redirect reports too many redirects", async () => {
      stubFetch(SIX_REDIRECTS);
      const error = await rejection(fetchWebPage("https://a.example/p", OPTS));
      expect(error.message).toBe("too many redirects");
    });

    test("AC-13: a redirect to a non-http(s) URL reports an unsupported URL", async () => {
      stubFetch([{ kind: "redirect", location: "file:///etc/passwd" }]);
      const error = await rejection(fetchWebPage("https://a.example/p", OPTS));
      expect(error.message).toBe("redirect to an unsupported URL");
    });

    test("AC-20: a redirect to a non-http(s) URL fails the fetch", async () => {
      stubFetch([{ kind: "redirect", location: "file:///etc/passwd" }]);
      const error = await rejection(fetchWebPage("https://a.example/p", OPTS));
      expect(error.code).toBe("WEB_FETCH_FAILED");
    });
  });

  describe("address safety", () => {
    test("AC-14: refuses a loopback IPv4 literal", async () => {
      stubFetch([{ kind: "page", body: "hi" }]);
      const error = await rejection(fetchWebPage("https://127.0.0.1/", OPTS));
      expect(error.code).toBe("WEB_ADDRESS_BLOCKED");
    });

    test("AC-15: checks a loopback IPv4 literal before any request", async () => {
      const stub = stubFetch([{ kind: "page", body: "hi" }]);
      await rejection(fetchWebPage("https://127.0.0.1/", OPTS));
      expect(stub.all).toHaveLength(0);
    });

    test("AC-16: refuses a bracketed loopback IPv6 literal", async () => {
      stubFetch([{ kind: "page", body: "hi" }]);
      const error = await rejection(fetchWebPage("http://[::1]/", OPTS));
      expect(error.code).toBe("WEB_ADDRESS_BLOCKED");
    });

    test("AC-17: refuses a redirect to a private address", async () => {
      stubFetch([
        { kind: "redirect", location: "http://10.0.0.5/" },
        { kind: "page", body: "hi" },
      ]);
      const error = await rejection(fetchWebPage("https://a.example/p", OPTS));
      expect(error.code).toBe("WEB_ADDRESS_BLOCKED");
    });

    test("AC-18: a redirect to a private address makes no second request", async () => {
      const stub = stubFetch([
        { kind: "redirect", location: "http://10.0.0.5/" },
        { kind: "page", body: "hi" },
      ]);
      await rejection(fetchWebPage("https://a.example/p", OPTS));
      expect(stub.all).toHaveLength(1);
    });

    test("AC-19: a lookup refusal reaches the caller unchanged", async () => {
      const refusal = new NaxError(
        "refused to fetch a.example: it resolves to a private or local address",
        "WEB_ADDRESS_BLOCKED",
        {
          stage: "web-fetch",
        },
      );
      stubFetch([{ kind: "failure", error: refusal }]);
      const error = await rejection(fetchWebPage("https://a.example/p", OPTS));
      expect(error).toBe(refusal);
    });

    test("a literal address of an allowed origin is not refused", async () => {
      stubFetch([{ kind: "page", contentType: "text/html", body: "<p>hi</p>" }]);
      const page = await fetchWebPage("http://127.0.0.1:8080/x", { ...OPTS, allowOrigins: ["http://127.0.0.1:8080"] });
      expect(page.text).toBe("hi");
    });
  });

  describe("what it will not read", () => {
    test("a body of an unsupported type is reported as unread", async () => {
      const stub = stubFetch([{ kind: "page", contentType: "application/pdf", body: "%PDF" }]);
      const page = await fetchWebPage("https://a.example/p", OPTS);
      expect(page.text).toBe("Unsupported content type application/pdf; nothing was read.");
      expect(page.unsupported).toBe(true);
      expect(stub.all).toHaveLength(1);
    });

    test("a non-2xx response is a page rather than a failure", async () => {
      stubFetch([{ kind: "page", status: 404, contentType: "text/html", body: "<p>gone</p>" }]);
      const page = await fetchWebPage("https://a.example/p", OPTS);
      expect(page.status).toBe(404);
      expect(page.text).toBe("gone");
    });

    test("a URL that is not http(s) fails the fetch", async () => {
      stubFetch([{ kind: "page", body: "hi" }]);
      const error = await rejection(fetchWebPage("file:///etc/passwd", OPTS));
      expect(error.code).toBe("WEB_FETCH_FAILED");
    });
  });
});
