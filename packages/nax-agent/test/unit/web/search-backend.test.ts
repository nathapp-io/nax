/**
 * The search backend contract: the request each adapter makes, the results it reads out of
 * the answer, and the failures it reports.
 *
 * Every search here is answered by a stub on `_webSearchDeps`, so no test in this file reaches
 * a search API, and the request deadline is driven from a virtual clock rather than waited out.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createSearchBackend as createSearchBackendFromInternal } from "@nathapp/nax-agent/internal";
import { _webSearchDeps, createSearchBackend, WEB_SEARCH_KEY_ENV } from "#src/web/search-backend";
import { assertDefined, assertNaxError, type FakeClock, makeFakeClock } from "#test/helpers/index";

const realFetch = _webSearchDeps.fetch;
const realSetTimeout = _webSearchDeps.setTimeout;
const realClearTimeout = _webSearchDeps.clearTimeout;

afterEach(() => {
  _webSearchDeps.fetch = realFetch;
  _webSearchDeps.setTimeout = realSetTimeout;
  _webSearchDeps.clearTimeout = realClearTimeout;
});

/** One request the stub was asked to make, as it was made. */
interface SentSearch {
  readonly url: string;
  readonly init: RequestInit;
}

/** Answer every search with `respond`, and report the requests that arrived. */
function stubSearch(respond: () => Response): SentSearch[] {
  const sent: SentSearch[] = [];
  _webSearchDeps.fetch = async (url, init) => {
    sent.push({ url, init });
    return respond();
  };
  return sent;
}

/** The single answer every search of a test gets. */
function answer(status: number, body: unknown): () => Response {
  return () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
}

/** A fetch that records the request and never answers it: a server that has gone quiet. */
function stubSilentSearch(): SentSearch[] {
  const sent: SentSearch[] = [];
  _webSearchDeps.fetch = (url, init) => {
    sent.push({ url, init });
    return new Promise<Response>(() => {});
  };
  return sent;
}

/** One header of a request the stub recorded, read the way a server reads it. */
function headerOf(sent: SentSearch | undefined, name: string): string | null {
  assertDefined(sent, "a search request");
  return new Headers(sent.init.headers).get(name);
}

/** The JSON body of a request the stub recorded, as the backend wrote it. */
function bodyOf(sent: SentSearch | undefined): unknown {
  assertDefined(sent, "a search request");
  return JSON.parse(String(sent.init.body));
}

/** Arm the module's deadline on a virtual clock, and report the delays it armed. */
function useFakeTimers(clock: FakeClock): number[] {
  const armed: number[] = [];
  _webSearchDeps.setTimeout = (fn, ms) => {
    armed.push(ms);
    return clock.setTimeout(fn, ms);
  };
  // The seam's handle is opaque (`unknown`), so the clock's numeric id is narrowed here
  // rather than cast: this adapter is the only place that knows what the handle is.
  _webSearchDeps.clearTimeout = (handle) => {
    if (typeof handle === "number") clock.clearTimeout(handle);
  };
  return armed;
}

/** The error `search` rejected with, read after `act` has driven whatever it waits on. */
async function rejectionAfter(search: Promise<unknown>, act: () => Promise<void>): Promise<unknown> {
  const settled = search.then(
    () => new Error("the search resolved, but this test expected it to fail"),
    (error: unknown) => error,
  );
  await act();
  return settled;
}

describe("the Tavily backend", () => {
  test("AC-1: posts the search to Tavily's search endpoint", async () => {
    const sent = stubSearch(answer(200, { results: [] }));
    await createSearchBackend({ id: "tavily", apiKey: "k" }).search("q", { limit: 3 });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe("https://api.tavily.com/search");
  });

  test("AC-2: sends POST, the bearer key and the query in a JSON body", async () => {
    const sent = stubSearch(answer(200, { results: [] }));
    await createSearchBackend({ id: "tavily", apiKey: "k" }).search("q", { limit: 3 });
    expect(sent[0]?.init.method).toBe("POST");
    expect(headerOf(sent[0], "authorization")).toBe("Bearer k");
    expect(bodyOf(sent[0])).toEqual({ query: "q", max_results: 3 });
  });

  test("AC-3: reads title, url and content into one normalised result", async () => {
    stubSearch(answer(200, { results: [{ title: "T", url: "HTTPS://A.example/x", content: "<b>s</b>" }] }));
    const results = await createSearchBackend({ id: "tavily", apiKey: "k" }).search("q", { limit: 3 });
    expect(results).toEqual([{ title: "T", url: "https://a.example/x", snippet: "s" }]);
  });

  test("AC-4: drops a result whose url is not an http(s) URL", async () => {
    stubSearch(
      answer(200, {
        results: [
          { title: "ok", url: "https://a.example/", content: "s" },
          { title: "bad", url: "javascript:alert(1)", content: "s" },
        ],
      }),
    );
    const results = await createSearchBackend({ id: "tavily", apiKey: "k" }).search("q", { limit: 3 });
    expect(results.map((result) => result.url)).toEqual(["https://a.example/"]);
  });

  test("AC-5: cuts a snippet at 500 characters", async () => {
    stubSearch(answer(200, { results: [{ title: "T", url: "https://a.example/", content: "a".repeat(600) }] }));
    const results = await createSearchBackend({ id: "tavily", apiKey: "k" }).search("q", { limit: 3 });
    expect(results[0]?.snippet.length).toBe(500);
  });
});

describe("the Brave backend", () => {
  test("AC-6: sends the query and the count in the URL", async () => {
    const sent = stubSearch(answer(200, { web: { results: [] } }));
    await createSearchBackend({ id: "brave", apiKey: "k" }).search("a b", { limit: 5 });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe("https://api.search.brave.com/res/v1/web/search?q=a%20b&count=5");
  });

  test("AC-7: sends GET, the subscription token and an accept header", async () => {
    const sent = stubSearch(answer(200, { web: { results: [] } }));
    await createSearchBackend({ id: "brave", apiKey: "k" }).search("a b", { limit: 5 });
    expect(sent[0]?.init.method).toBe("GET");
    expect(headerOf(sent[0], "x-subscription-token")).toBe("k");
    expect(headerOf(sent[0], "accept")).toBe("application/json");
  });

  test("AC-8: reads title, url and description into one normalised result", async () => {
    stubSearch(
      answer(200, {
        web: { results: [{ title: "T", url: "https://a.example/", description: "<strong>d</strong>" }] },
      }),
    );
    const results = await createSearchBackend({ id: "brave", apiKey: "k" }).search("a b", { limit: 5 });
    expect(results).toEqual([{ title: "T", url: "https://a.example/", snippet: "d" }]);
  });

  test("AC-9: an answer with no web member is no results, not a failure", async () => {
    stubSearch(answer(200, { query: { original: "a b" } }));
    const results = await createSearchBackend({ id: "brave", apiKey: "k" }).search("a b", { limit: 5 });
    expect(results).toEqual([]);
  });

  test("a web member with no results is no results either", async () => {
    stubSearch(answer(200, { web: {} }));
    const results = await createSearchBackend({ id: "brave", apiKey: "k" }).search("a b", { limit: 5 });
    expect(results).toEqual([]);
  });

  test("a search with no key configured sends no subscription token", async () => {
    const sent = stubSearch(answer(200, { web: { results: [] } }));
    await createSearchBackend({ id: "brave" }).search("a b", { limit: 5 });
    expect(headerOf(sent[0], "x-subscription-token")).toBeNull();
  });
});

describe("the failures a search reports", () => {
  test("AC-10: a 500 answer is a WEB_SEARCH_FAILED naming the backend and the status", async () => {
    stubSearch(answer(500, { detail: "boom" }));
    const caught = rejectionAfter(
      createSearchBackend({ id: "tavily", apiKey: "k" }).search("q", { limit: 3 }),
      async () => {},
    );
    const error = await caught;
    assertNaxError(error);
    expect(error.code).toBe("WEB_SEARCH_FAILED");
    expect(error.context).toMatchObject({ backend: "tavily", status: 500 });
  });

  test("AC-11: a 401 answer says the key was rejected, and carries no key", async () => {
    stubSearch(answer(401, { detail: "unauthorized" }));
    const error = await rejectionAfter(
      createSearchBackend({ id: "tavily", apiKey: "secret-key" }).search("q", { limit: 3 }),
      async () => {},
    );
    assertNaxError(error);
    expect(error.code).toBe("WEB_SEARCH_FAILED");
    expect(error.message).toBe("tavily rejected the search key");
    expect(JSON.stringify(error.context)).not.toContain("secret-key");
  });

  test("AC-14: a 200 answer that is not JSON is a WEB_SEARCH_FAILED", async () => {
    stubSearch(answer(200, "not json at all"));
    const error = await rejectionAfter(
      createSearchBackend({ id: "tavily", apiKey: "k" }).search("q", { limit: 3 }),
      async () => {},
    );
    assertNaxError(error);
    expect(error.code).toBe("WEB_SEARCH_FAILED");
  });

  test("AC-15: a 200 answer whose results is not an array is a WEB_SEARCH_FAILED", async () => {
    stubSearch(answer(200, { results: "nope" }));
    const error = await rejectionAfter(
      createSearchBackend({ id: "tavily", apiKey: "k" }).search("q", { limit: 3 }),
      async () => {},
    );
    assertNaxError(error);
    expect(error.code).toBe("WEB_SEARCH_FAILED");
  });

  test("AC-12: a 403 answer says the key was rejected", async () => {
    stubSearch(answer(403, { detail: "forbidden" }));
    const error = await rejectionAfter(
      createSearchBackend({ id: "brave", apiKey: "k" }).search("q", { limit: 5 }),
      async () => {},
    );
    assertNaxError(error);
    expect(error.code).toBe("WEB_SEARCH_FAILED");
    expect(error.message).toBe("brave rejected the search key");
  });

  test("AC-13: a 429 answer says the search was rate-limited", async () => {
    stubSearch(answer(429, { detail: "slow down" }));
    const error = await rejectionAfter(
      createSearchBackend({ id: "brave", apiKey: "k" }).search("q", { limit: 5 }),
      async () => {},
    );
    assertNaxError(error);
    expect(error.code).toBe("WEB_SEARCH_FAILED");
    expect(error.message).toBe("brave rate-limited the search");
  });

  test("a transport failure is a WEB_SEARCH_FAILED naming its cause", async () => {
    stubSearch(() => {
      throw new Error("socket hang up");
    });
    const error = await rejectionAfter(
      createSearchBackend({ id: "tavily", apiKey: "k" }).search("q", { limit: 3 }),
      async () => {},
    );
    assertNaxError(error);
    expect(error.code).toBe("WEB_SEARCH_FAILED");
    expect(error.message).toContain("socket hang up");
  });

  test("a results array holding something that is not an object is a WEB_SEARCH_FAILED", async () => {
    stubSearch(answer(200, { web: { results: ["nope"] } }));
    const error = await rejectionAfter(
      createSearchBackend({ id: "brave", apiKey: "k" }).search("q", { limit: 5 }),
      async () => {},
    );
    assertNaxError(error);
    expect(error.code).toBe("WEB_SEARCH_FAILED");
  });

  test("AC-16: a fetch that has not answered after 15000 ms is a WEB_SEARCH_FAILED", async () => {
    const clock = makeFakeClock();
    const armed = useFakeTimers(clock);
    // A server that never answers raises nothing the fetch could notice, so the deadline is
    // the only way out; the promise stays open for the whole test.
    stubSilentSearch();
    const error = await rejectionAfter(
      createSearchBackend({ id: "tavily", apiKey: "k" }).search("q", { limit: 3 }),
      () => clock.advance(15_000),
    );
    assertNaxError(error);
    expect(error.code).toBe("WEB_SEARCH_FAILED");
    expect(armed).toEqual([15_000]);
    expect(clock.pending()).toBe(0);
  });

  test("a search that runs out of budget aborts the request it started", async () => {
    const clock = makeFakeClock();
    useFakeTimers(clock);
    const sent = stubSilentSearch();
    await rejectionAfter(createSearchBackend({ id: "tavily", apiKey: "k" }).search("q", { limit: 3 }), () =>
      clock.advance(15_000),
    );
    const request = sent[0];
    assertDefined(request, "a search request");
    expect(request.init.signal?.aborted).toBe(true);
  });

  test("a search the caller aborts is a WEB_SEARCH_FAILED", async () => {
    stubSilentSearch();
    const caller = new AbortController();
    const error = await rejectionAfter(
      createSearchBackend({ id: "tavily", apiKey: "k" }).search("q", { limit: 3, signal: caller.signal }),
      async () => {
        caller.abort(new Error("user cancelled"));
      },
    );
    assertNaxError(error);
    expect(error.code).toBe("WEB_SEARCH_FAILED");
  });

  test("a caller's cancellation aborts the request it started", async () => {
    const sent = stubSilentSearch();
    const caller = new AbortController();
    await rejectionAfter(
      createSearchBackend({ id: "tavily", apiKey: "k" }).search("q", { limit: 3, signal: caller.signal }),
      async () => {
        caller.abort(new Error("user cancelled"));
      },
    );
    const request = sent[0];
    assertDefined(request, "a search request");
    expect(request.init.signal?.aborted).toBe(true);
  });
});

describe("WEB_SEARCH_KEY_ENV", () => {
  test("AC-17: names the environment variable of every keyed backend", () => {
    expect(WEB_SEARCH_KEY_ENV).toEqual({
      tavily: "TAVILY_API_KEY",
      brave: "BRAVE_SEARCH_API_KEY",
      exa: "EXA_API_KEY",
    });
  });
});

describe("createSearchBackend", () => {
  test("AC-18: keeps the id it was given, through @nathapp/nax-agent/internal too", () => {
    expect(createSearchBackend({ id: "tavily", apiKey: "k" }).id).toBe("tavily");
    // The internal entry re-exports this module, so nax's own code reaches the same factory.
    expect(createSearchBackendFromInternal).toBe(createSearchBackend);
  });

  test("refuses an id this story has no adapter for yet", () => {
    expect(() => createSearchBackend({ id: "exa", apiKey: "k" })).toThrow(/exa/);
  });
});
