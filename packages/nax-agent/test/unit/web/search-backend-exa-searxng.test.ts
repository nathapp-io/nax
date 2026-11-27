/**
 * The Exa and SearXNG backends: the request each makes, the results it reads out of the answer,
 * and the failures it reports.
 *
 * Every backend here is built through `createSearchBackend`, so each test also proves the
 * factory registration. No test reaches a search API: the answer comes from a stub on
 * `_webSearchDeps`, and a request deadline is driven from a virtual clock rather than waited out.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { _webSearchDeps, createSearchBackend } from "#src/web/search-backend";
import { assertDefined, assertNaxError, type FakeClock, makeFakeClock } from "#test/helpers/index";

/** The self-hosted instance these tests configure. */
const SEARXNG_BASE = "http://search.example.lan:8080";

/** The two backends this story adds, as a run of tests can iterate them. */
const ADDED_BACKENDS = ["exa", "searxng"] as const;

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

/** An Exa backend with a key, the way a configured session builds one. */
function exa() {
  return createSearchBackend({ id: "exa", apiKey: "k" });
}

/** A SearXNG backend pointed at `baseUrl`, the way a configured session builds one. */
function searxng(baseUrl: string = SEARXNG_BASE) {
  return createSearchBackend({ id: "searxng", baseUrl });
}

/** Every backend the factory can build, each configured the way a session configures it. */
const ALL_BACKENDS = ["tavily", "brave", "exa", "searxng"] as const;

/** The backend an id names, across the whole factory rather than this story's two. */
function everyBackend(id: (typeof ALL_BACKENDS)[number]) {
  return id === "searxng" ? searxng() : createSearchBackend({ id, apiKey: "k" });
}

/**
 * A fetch stub that answers a 3xx the way the platform does: a redirect is FOLLOWED
 * unless the request asked for `redirect: "manual"`, and handed back untouched when it
 * did. Answering 302 either way would make every test here pass without the policy
 * this story sets, which is the one thing the two ACs are about.
 */
function stubRedirectingSearch(status: number, location: string): SentSearch[] {
  const sent: SentSearch[] = [];
  _webSearchDeps.fetch = async (url, init) => {
    sent.push({ url, init });
    if (init.redirect === "manual") return new Response("", { status, headers: { location } });
    return new Response(JSON.stringify({ results: [] }), { status: 200 });
  };
  return sent;
}

/** Both backends this story adds: a test that builds them proves they register. */
function addedBackends() {
  return [exa(), searxng()];
}

/** The backend an id names, built the way a configured session builds it. */
function backendOf(id: (typeof ADDED_BACKENDS)[number]) {
  return id === "exa" ? exa() : searxng();
}

describe("the Exa backend", () => {
  test("AC-1: posts the search to Exa's search endpoint", async () => {
    const sent = stubSearch(answer(200, { results: [] }));
    await exa().search("q", { limit: 4 });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe("https://api.exa.ai/search");
  });

  test("AC-2: sends POST, the api key and the query with its result shape", async () => {
    const sent = stubSearch(answer(200, { results: [] }));
    await exa().search("q", { limit: 4 });
    expect(sent[0]?.init.method).toBe("POST");
    expect(headerOf(sent[0], "x-api-key")).toBe("k");
    expect(bodyOf(sent[0])).toEqual({
      query: "q",
      numResults: 4,
      contents: { text: { maxCharacters: 500 } },
    });
  });

  test("AC-3: reads title, url and text into one normalised result", async () => {
    stubSearch(answer(200, { results: [{ title: "T", url: "https://a.example/", text: "body" }] }));
    const results = await exa().search("q", { limit: 4 });
    expect(results).toEqual([{ title: "T", url: "https://a.example/", snippet: "body" }]);
  });

  test("AC-4: a result with no title is titled by its normalised url", async () => {
    stubSearch(answer(200, { results: [{ url: "HTTPS://A.example/x", text: "body" }] }));
    const results = await exa().search("q", { limit: 4 });
    expect(results[0]?.title).toBe("https://a.example/x");
    expect(results[0]?.url).toBe("https://a.example/x");
  });
});

describe("the SearXNG backend", () => {
  test("AC-6: asks the configured instance for JSON results", async () => {
    const sent = stubSearch(answer(200, { results: [] }));
    await searxng().search("q", { limit: 2 });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe("http://search.example.lan:8080/search?q=q&format=json");
  });

  test("AC-7: sends no authorization header, because a self-hosted instance has no key", async () => {
    const sent = stubSearch(answer(200, { results: [] }));
    await searxng().search("q", { limit: 2 });
    expect(headerOf(sent[0], "authorization")).toBeNull();
    expect(headerOf(sent[0], "x-api-key")).toBeNull();
  });

  test("AC-8: a base url with or without its trailing slash sends the same request", async () => {
    const withSlash = stubSearch(answer(200, { results: [] }));
    await searxng(`${SEARXNG_BASE}/`).search("q", { limit: 2 });
    const withoutSlash = stubSearch(answer(200, { results: [] }));
    await searxng(SEARXNG_BASE).search("q", { limit: 2 });
    expect(withSlash[0]?.url).toBe("http://search.example.lan:8080/search?q=q&format=json");
    expect(withoutSlash[0]?.url).toBe(withSlash[0]?.url);
  });

  test("AC-9: keeps the first `limit` results, read from title, url and content", async () => {
    stubSearch(
      answer(200, {
        results: [
          { title: "A", url: "https://a.example/1", content: "<b>one</b>" },
          { title: "B", url: "HTTPS://B.example/2", content: "two" },
          { title: "C", url: "https://c.example/3", content: "three" },
        ],
      }),
    );
    const results = await searxng().search("q", { limit: 2 });
    expect(results).toEqual([
      { title: "A", url: "https://a.example/1", snippet: "one" },
      { title: "B", url: "https://b.example/2", snippet: "two" },
    ]);
  });

  test("a SearXNG backend with no base url is refused when it is built", () => {
    let caught: unknown;
    try {
      createSearchBackend({ id: "searxng" });
    } catch (error) {
      caught = error;
    }
    assertNaxError(caught);
    expect(caught.code).toBe("WEB_SEARCH_FAILED");
    expect(caught.message).toContain("base url");
  });
});

describe("the failures an Exa or SearXNG search reports", () => {
  test("AC-5: a 401 answer from Exa says the key was rejected", async () => {
    stubSearch(answer(401, { detail: "unauthorized" }));
    const error = await rejectionAfter(exa().search("q", { limit: 4 }), async () => {});
    assertNaxError(error);
    expect(error.code).toBe("WEB_SEARCH_FAILED");
    expect(error.message).toBe("exa rejected the search key");
  });

  test("AC-15: a 403 answer from SearXNG says the key was rejected", async () => {
    stubSearch(answer(403, { detail: "forbidden" }));
    const error = await rejectionAfter(searxng().search("q", { limit: 2 }), async () => {});
    assertNaxError(error);
    expect(error.code).toBe("WEB_SEARCH_FAILED");
    expect(error.message).toBe("searxng rejected the search key");
  });

  test("AC-10: a 403 answer carries the backend and the status in its context", async () => {
    stubSearch(answer(403, { detail: "forbidden" }));
    const error = await rejectionAfter(searxng().search("q", { limit: 2 }), async () => {});
    assertNaxError(error);
    expect(error.context).toMatchObject({ backend: "searxng", status: 403 });
  });

  test("AC-11: a 200 answer whose body is HTML is a WEB_SEARCH_FAILED", async () => {
    stubSearch(answer(200, "<html><body>not a search answer</body></html>"));
    const error = await rejectionAfter(searxng().search("q", { limit: 2 }), async () => {});
    assertNaxError(error);
    expect(error.code).toBe("WEB_SEARCH_FAILED");
  });

  test("a 429 answer says the search was rate-limited", async () => {
    stubSearch(answer(429, { detail: "slow down" }));
    const error = await rejectionAfter(exa().search("q", { limit: 4 }), async () => {});
    assertNaxError(error);
    expect(error.code).toBe("WEB_SEARCH_FAILED");
    expect(error.message).toBe("exa rate-limited the search");
  });

  for (const id of ADDED_BACKENDS) {
    test(`AC-12 (${id}): a non-2xx answer is a WEB_SEARCH_FAILED naming the status`, async () => {
      stubSearch(answer(500, { detail: "boom" }));
      const error = await rejectionAfter(backendOf(id).search("q", { limit: 2 }), async () => {});
      assertNaxError(error);
      expect(error.code).toBe("WEB_SEARCH_FAILED");
      expect(error.context).toMatchObject({ backend: id, status: 500 });
    });

    test(`AC-13 (${id}): a search that has not answered after 15000 ms is a WEB_SEARCH_FAILED`, async () => {
      const clock = makeFakeClock();
      const armed = useFakeTimers(clock);
      // A server that never answers raises nothing the fetch could notice, so the deadline is
      // the only way out; the promise stays open for the whole test.
      stubSilentSearch();
      const error = await rejectionAfter(backendOf(id).search("q", { limit: 2 }), () => clock.advance(15_000));
      assertNaxError(error);
      expect(error.code).toBe("WEB_SEARCH_FAILED");
      expect(armed).toEqual([15_000]);
      expect(clock.pending()).toBe(0);
    });

    test(`AC-14 (${id}): an answer whose results is not an array is a WEB_SEARCH_FAILED`, async () => {
      stubSearch(answer(200, { results: "nope" }));
      const error = await rejectionAfter(backendOf(id).search("q", { limit: 2 }), async () => {});
      assertNaxError(error);
      expect(error.code).toBe("WEB_SEARCH_FAILED");
    });
  }
});

/**
 * US-003 (review-f32f-fixes): the transport's redirect policy.
 *
 * The search spec requires a non-2xx status to be `WEB_SEARCH_FAILED`, and a 3xx is the one
 * status a request can turn into a 2xx on its own: the platform follows a redirect by default,
 * so a backend answering `302 location: …` used to be read as a successful search of whatever
 * the hop pointed at. The transport asks for `redirect: "manual"` so the status arrives as it
 * was sent and `assertStatus` classifies it like any other non-2xx.
 */
describe("the transport's redirect policy", () => {
  test("AC-3: a SearXNG 302 answer is a WEB_SEARCH_FAILED carrying the status", async () => {
    stubRedirectingSearch(302, "https://search.example.lan:8080/login");
    const error = await rejectionAfter(searxng().search("q", { limit: 2 }), async () => {});
    assertNaxError(error);
    expect(error.code).toBe("WEB_SEARCH_FAILED");
    expect(error.context).toMatchObject({ backend: "searxng", status: 302 });
  });

  test("AC-4: the SearXNG 302 message names the backend and the status", async () => {
    stubRedirectingSearch(302, "https://search.example.lan:8080/login");
    const error = await rejectionAfter(searxng().search("q", { limit: 2 }), async () => {});
    assertNaxError(error);
    expect(error.message).toBe("searxng search failed with status 302");
  });

  for (const id of ALL_BACKENDS) {
    test(`AC-5 (${id}): the request asks for 'manual' redirects`, async () => {
      const sent = stubSearch(answer(200, { results: [] }));
      await everyBackend(id).search("q", { limit: 2 });
      expect(sent[0]?.init.redirect).toBe("manual");
    });
  }
});

describe("the backends that were already shipped", () => {
  test("AC-16: Tavily still maps a result to a normalised url and a tag-free snippet", async () => {
    expect(addedBackends().map((backend) => backend.id)).toEqual(["exa", "searxng"]);
    const sent = stubSearch(
      answer(200, { results: [{ title: "T", url: "HTTPS://A.example/x", content: "<b>s</b>" }] }),
    );
    const results = await createSearchBackend({ id: "tavily", apiKey: "k" }).search("q", { limit: 3 });
    expect(sent[0]?.url).toBe("https://api.tavily.com/search");
    expect(results).toEqual([{ title: "T", url: "https://a.example/x", snippet: "s" }]);
  });

  test("AC-17: Brave still answers an answer with no web member with no results", async () => {
    expect(addedBackends().map((backend) => backend.id)).toEqual(["exa", "searxng"]);
    stubSearch(answer(200, { query: { original: "q" } }));
    const results = await createSearchBackend({ id: "brave", apiKey: "k" }).search("q", { limit: 5 });
    expect(results).toEqual([]);
  });
});
