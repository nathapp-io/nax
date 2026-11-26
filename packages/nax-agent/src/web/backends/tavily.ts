/**
 * The Tavily backend: one POST to `/search`, answered with `results[].{title, url, content}`.
 *
 * The key goes in an `authorization: Bearer` header rather than the body, so a request logged
 * by a proxy records that a key was used without recording the key. A search made with no key
 * configured sends no header at all and lets Tavily answer 401, which the transport already
 * reports as a refused key -- the search is configured by the caller, not decided here.
 */

import type { SearchBackend, SearchBackendOptions } from "../search-backend.ts";
import {
  fetchSearchJson,
  malformedAnswer,
  recordOf,
  type SearchRequest,
  searchBaseUrl,
  toSearchResults,
} from "../search-request.ts";
import type { WebSearchResult } from "../types.ts";

/** Where Tavily's search API lives, when nothing overrides it. */
const BASE_URL = "https://api.tavily.com";

/** The one endpoint a Tavily search uses. */
const SEARCH_PATH = "/search";

/** The id this adapter answers to, and the name its failures carry. */
const BACKEND = "tavily";

/** What a Tavily backend is configured with: its key, and an optional base URL. */
export type TavilyOptions = Omit<SearchBackendOptions, "id">;

/** A Tavily search backend: the request, and the results its answer names. */
export function createTavilyBackend(opts: TavilyOptions): SearchBackend {
  const url = `${searchBaseUrl(opts.baseUrl, BASE_URL)}${SEARCH_PATH}`;
  return {
    id: BACKEND,
    search: async (query, searchOpts): Promise<readonly WebSearchResult[]> => {
      const body = await fetchSearchJson({
        backend: BACKEND,
        request: tavilyRequest({ url, apiKey: opts.apiKey, query, limit: searchOpts.limit }),
        ...(searchOpts.signal !== undefined ? { signal: searchOpts.signal } : {}),
      });
      return toSearchResults({
        backend: BACKEND,
        items: tavilyResults(body),
        read: (record) => ({ title: record.title, url: record.url, snippet: record.content }),
      });
    },
  };
}

/** The POST a Tavily search makes: the query and the count, and the key when there is one. */
function tavilyRequest(p: {
  readonly url: string;
  readonly apiKey: string | undefined;
  readonly query: string;
  readonly limit: number;
}): SearchRequest {
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
  if (p.apiKey !== undefined) headers.authorization = `Bearer ${p.apiKey}`;
  return {
    url: p.url,
    init: { method: "POST", headers, body: JSON.stringify({ query: p.query, max_results: p.limit }) },
  };
}

/** The `results` array a Tavily answer carries, or the failure its absence is. */
function tavilyResults(body: unknown): readonly unknown[] {
  const results = recordOf(body)?.results;
  if (!Array.isArray(results)) throw malformedAnswer(BACKEND, "no results array");
  return results;
}
