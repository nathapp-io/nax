/**
 * The web provider's fetch tool: what it asks the page seam for, how the page it gets back is
 * fenced and recorded, and what a refused or unreadable page does to the session's exposure.
 *
 * No test here opens a socket: `_webProviderDeps.fetchWebPage` is replaced with a stand-in that
 * records the arguments it was called with and answers the page the test scripted, so the tool's
 * own contract -- validation, fencing, bookkeeping -- is the only thing under test.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NaxError } from "#src/infra/index";
import type { ProviderTool } from "#src/tools/provider-types";
import type { ToolResult, ToolRunContext } from "#src/tools/registry";
import { fenceWebContent } from "#src/web/content";
import { createWebExposure, type WebExposure } from "#src/web/exposure";
import type { WebPage } from "#src/web/fetch-page";
import { _webProviderDeps, createWebToolProvider, type WebToolProviderOptions } from "#src/web/provider";
import type { SearchBackend } from "#src/web/search-backend";
import type { WebSearchResult } from "#src/web/types";

const ROOT = "/tmp/nax-web-fetch";

/** The fixed clock every fenced block in this file is stamped with. */
const NOW = new Date("2026-11-26T10:00:00.000Z");

/** The one context a provider tool needs; the fetch reads none of it but the cancellation. */
const CTX: ToolRunContext = { root: ROOT, resolvedPaths: [], maxBytes: 40_000, maxFileBytes: 2_000_000 };

/** The exact message a fetch that names no http(s) destination reports. */
const NEEDS_HTTP_URL = "web__fetch needs an http or https URL";

/** One call the page seam received. */
interface SentFetch {
  readonly url: string;
  readonly opts: Parameters<typeof _webProviderDeps.fetchWebPage>[1];
}

/** The real page seam, restored after every test. */
const realFetchWebPage = _webProviderDeps.fetchWebPage;

let sent: SentFetch[] = [];

/**
 * Replace the page seam with one that records its arguments and answers `answer`, so a test can
 * assert both what the tool asked for and what it made of the page it got back.
 */
function stubPage(answer: () => Promise<WebPage>): void {
  _webProviderDeps.fetchWebPage = async (url, opts) => {
    sent.push({ url, opts });
    return answer();
  };
}

beforeEach(() => {
  sent = [];
});

afterEach(() => {
  _webProviderDeps.fetchWebPage = realFetchWebPage;
});

/** A readable page the seam can answer with, overridden per test. */
function page(overrides: Partial<WebPage> = {}): WebPage {
  return {
    url: "https://a.example/p",
    status: 200,
    contentType: "text/html",
    text: "hi",
    links: [],
    truncated: false,
    unsupported: false,
    ...overrides,
  };
}

/** A page the fetch seam answers with, as its promise. */
function answers(overrides: Partial<WebPage> = {}): () => Promise<WebPage> {
  return async () => page(overrides);
}

function options(overrides: Partial<WebToolProviderOptions> = {}): WebToolProviderOptions {
  return {
    exposure: createWebExposure(),
    maxResults: 5,
    fetch: { maxBytes: 1_000, timeoutMs: 1_000 },
    allowOrigins: [],
    now: () => NOW,
    ...overrides,
  };
}

/** The fetch tool the provider advertised. */
async function fetchTool(opts: WebToolProviderOptions): Promise<ProviderTool> {
  const tools = await createWebToolProvider(opts).tools(ROOT);
  const tool = tools.find((candidate) => candidate.localName === "fetch");
  if (tool === undefined) throw new Error("the provider advertised no fetch tool");
  return tool;
}

/** Run the fetch tool the provider built from `opts`. */
async function runFetch(
  opts: WebToolProviderOptions,
  input: Record<string, unknown>,
  ctx: ToolRunContext = CTX,
): Promise<ToolResult> {
  return (await fetchTool(opts)).run(input, ctx);
}

describe("the fetch tool the provider advertises", () => {
  test("AC-1: without a search backend, fetch is the only tool advertised", async () => {
    const tools = await createWebToolProvider(options()).tools(ROOT);
    expect(tools.map((tool) => tool.localName)).toEqual(["fetch"]);
  });

  test("a configured search backend advertises search alongside fetch", async () => {
    const backend: SearchBackend = { id: "tavily", search: async () => [] };
    const tools = await createWebToolProvider(options({ search: backend })).tools(ROOT);
    expect(tools.map((tool) => tool.localName)).toEqual(["search", "fetch"]);
  });
});

describe("the fetch tool's page request", () => {
  test("AC-2: asks the page seam for the url under the configured bounds", async () => {
    stubPage(answers());
    await runFetch(options({ fetch: { maxBytes: 2_000, timeoutMs: 5_000 }, allowOrigins: ["http://127.0.0.1:8080"] }), {
      url: "https://a.example/p",
    });
    expect(sent).toEqual([
      {
        url: "https://a.example/p",
        opts: { maxBytes: 2_000, timeoutMs: 5_000, allowOrigins: ["http://127.0.0.1:8080"] },
      },
    ]);
  });

  test("the turn's cancellation reaches the page seam", async () => {
    stubPage(answers());
    const controller = new AbortController();
    await runFetch(options(), { url: "https://a.example/p" }, { ...CTX, signal: controller.signal });
    expect(sent[0]?.opts.signal).toBe(controller.signal);
  });

  test("the url is normalised before the seam sees it", async () => {
    stubPage(answers());
    await runFetch(options(), { url: "HTTPS://A.example:443/p#frag" });
    expect(sent[0]?.url).toBe("https://a.example/p");
  });
});

describe("a page the fetch read", () => {
  test("AC-3: the text is fenced with the final url as its source", async () => {
    stubPage(answers({ url: "https://a.example/q", text: "hi" }));
    const result = await runFetch(options(), { url: "https://a.example/p" });
    expect(result.content).toBe(fenceWebContent({ source: "https://a.example/q", fetchedAt: NOW, text: "hi" }));
    expect(result.isError).toBeUndefined();
  });

  test("AC-4: the final url is seen by the exposure", async () => {
    const exposure = createWebExposure();
    stubPage(answers({ url: "https://a.example/q" }));
    await runFetch(options({ exposure }), { url: "https://a.example/p" });
    expect(exposure.hasSeen("https://a.example/q")).toBe(true);
  });

  test("AC-5: every link the page carried is seen by the exposure", async () => {
    const exposure = createWebExposure();
    stubPage(answers({ links: ["https://a.example/one", "https://b.example/two"] }));
    await runFetch(options({ exposure }), { url: "https://a.example/p" });
    expect(exposure.hasSeen("https://a.example/one")).toBe(true);
    expect(exposure.hasSeen("https://b.example/two")).toBe(true);
  });

  test("AC-6: the session is exposed", async () => {
    const exposure = createWebExposure();
    stubPage(answers());
    await runFetch(options({ exposure }), { url: "https://a.example/p" });
    expect(exposure.isExposed()).toBe(true);
  });

  test("AC-7: a truncated page's content ends with the truncation line", async () => {
    stubPage(answers({ truncated: true }));
    const result = await runFetch(options({ fetch: { maxBytes: 200_000, timeoutMs: 1_000 } }), {
      url: "https://a.example/p",
    });
    const lines = result.content.split("\n");
    expect(lines.at(-1)).toBe("[truncated at 200000 bytes]");
    expect(
      result.content.startsWith(fenceWebContent({ source: "https://a.example/p", fetchedAt: NOW, text: "hi" })),
    ).toBe(true);
  });

  test("a page that was not truncated carries no truncation line", async () => {
    stubPage(answers());
    const result = await runFetch(options(), { url: "https://a.example/p" });
    expect(result.content).not.toContain("truncated at");
  });
});

describe("a page the fetch could not read", () => {
  test("AC-8: an unsupported page is not an error result", async () => {
    stubPage(answers({ unsupported: true, contentType: "application/pdf", text: "unsupported" }));
    const result = await runFetch(options(), { url: "https://a.example/p" });
    expect(result.isError).not.toBe(true);
  });

  test("AC-16: an unsupported page's text is fenced from the page's own url", async () => {
    const unreadable = page({
      url: "https://a.example/doc",
      unsupported: true,
      contentType: "application/pdf",
      text: "Unsupported content type application/pdf; nothing was read.",
    });
    stubPage(async () => unreadable);
    const result = await runFetch(options(), { url: "https://a.example/doc" });
    expect(result.content).toBe(fenceWebContent({ source: unreadable.url, fetchedAt: NOW, text: unreadable.text }));
  });

  test("AC-9: an unsupported page leaves the exposure exactly as it was", async () => {
    const exposure = createWebExposure();
    const before = exposure.snapshot();
    stubPage(answers({ unsupported: true, links: ["https://a.example/one"] }));
    await runFetch(options({ exposure }), { url: "https://a.example/p" });
    expect(exposure.snapshot()).toEqual(before);
  });
});

describe("a fetch that failed", () => {
  test("AC-10: a blocked address reports the error's message", async () => {
    const blocked = new NaxError(
      "refused to fetch a.example: it resolves to a private or local address",
      "WEB_ADDRESS_BLOCKED",
      {
        stage: "web-fetch",
      },
    );
    stubPage(async () => {
      throw blocked;
    });
    const result = await runFetch(options(), { url: "https://a.example/p" });
    expect(result.isError).toBe(true);
    expect(result.content).toBe(blocked.message);
  });

  test("AC-11: a rejected fetch leaves the exposure exactly as it was", async () => {
    const exposure = createWebExposure();
    const before = exposure.snapshot();
    stubPage(async () => {
      throw new NaxError("nax-web fetch failed", "WEB_FETCH_FAILED", { stage: "web-fetch" });
    });
    await runFetch(options({ exposure }), { url: "https://a.example/p" });
    expect(exposure.snapshot()).toEqual(before);
  });

  test("AC-12: a non-http url is an error result naming the requirement", async () => {
    stubPage(answers());
    const result = await runFetch(options(), { url: "ftp://a.example/" });
    expect(result.isError).toBe(true);
    expect(result.content).toBe(NEEDS_HTTP_URL);
  });

  test("AC-13: a non-http url never reaches the page seam", async () => {
    stubPage(answers());
    await runFetch(options(), { url: "ftp://a.example/" });
    expect(sent).toEqual([]);
  });

  test("a missing url is the same error and reaches no page", async () => {
    stubPage(answers());
    const result = await runFetch(options(), {});
    expect(result.content).toBe(NEEDS_HTTP_URL);
    expect(sent).toEqual([]);
  });
});

describe("the search tool beside the fetch tool", () => {
  test("AC-17: a Tavily search with no results keeps its existing result format", async () => {
    const backend: SearchBackend = { id: "tavily", search: async (): Promise<readonly WebSearchResult[]> => [] };
    const search = (await createWebToolProvider(options({ search: backend })).tools(ROOT)).find(
      (candidate) => candidate.localName === "search",
    );
    if (search === undefined) throw new Error("the provider advertised no search tool");
    const result = await search.run({ query: "q" }, CTX);
    expect(result.content).toBe(fenceWebContent({ source: "search:tavily", fetchedAt: NOW, text: "No results." }));
  });

  test("the exposure the search marks is the one the fetch reads", async () => {
    const exposure = createWebExposure();
    const backend: SearchBackend = {
      id: "tavily",
      search: async () => [{ title: "T", url: "https://b.example/", snippet: "s" }],
    };
    const tools = await createWebToolProvider(options({ exposure, search: backend })).tools(ROOT);
    const search = tools.find((candidate) => candidate.localName === "search");
    if (search === undefined) throw new Error("the provider advertised no search tool");
    stubPage(answers({ url: "https://a.example/q" }));
    await search.run({ query: "q" }, CTX);
    await runFetch(options({ exposure, search: backend }), { url: "https://a.example/p" });
    expect(exposure.snapshot().searches).toBe(1);
    expect(exposure.hasSeen("https://b.example/")).toBe(true);
    expect(exposure.hasSeen("https://a.example/q")).toBe(true);
  });
});

describe("the exposure a fetch keeps", () => {
  test("a fetched page's own links are recorded alongside its url", async () => {
    const exposure: WebExposure = createWebExposure();
    stubPage(answers({ url: "https://a.example/q", links: ["https://a.example/one"] }));
    await runFetch(options({ exposure }), { url: "https://a.example/p" });
    expect(exposure.snapshot().seenUrls).toEqual(["https://a.example/q", "https://a.example/one"]);
  });

  test("the block is stamped with the real clock when none is injected", async () => {
    stubPage(answers());
    const result = await runFetch(options({ now: undefined }), { url: "https://a.example/p" });
    expect(result.content).toMatch(/^<web-content source="https:\/\/a\.example\/p" fetched="\d{4}-\d{2}-\d{2}T/);
  });
});
