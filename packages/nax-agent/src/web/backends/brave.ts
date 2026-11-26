/**
 * The Brave backend: one GET to `/res/v1/web/search`, answered with
 * `web.results[].{title, url, description}`.
 *
 * The query travels in the URL and the key in a header, so no request body exists to log. Two
 * parts of Brave's answer shape are unlike the other backends, and both are honoured here: the
 * results are nested under `web`, and an answer with no `web` member at all is a search that
 * found nothing rather than a broken response -- Brave omits the member instead of sending an
 * empty list. That case returns no results; a `web` that is present and the wrong shape is
 * still malformed.
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

/** Where Brave's search API lives, when nothing overrides it. */
const BASE_URL = "https://api.search.brave.com";

/** The one endpoint a Brave search uses. */
const SEARCH_PATH = "/res/v1/web/search";

/** The id this adapter answers to, and the name its failures carry. */
const BACKEND = "brave";

/** What a Brave backend is configured with: its key, and an optional base URL. */
export type BraveOptions = Omit<SearchBackendOptions, "id">;

/** A Brave search backend: the request, and the results its answer names. */
export function createBraveBackend(opts: BraveOptions): SearchBackend {
  const base = `${searchBaseUrl(opts.baseUrl, BASE_URL)}${SEARCH_PATH}`;
  return {
    id: BACKEND,
    search: async (query, searchOpts): Promise<readonly WebSearchResult[]> => {
      const body = await fetchSearchJson({
        backend: BACKEND,
        request: braveRequest({ base, apiKey: opts.apiKey, query, limit: searchOpts.limit }),
        ...(searchOpts.signal !== undefined ? { signal: searchOpts.signal } : {}),
      });
      return toSearchResults({
        backend: BACKEND,
        items: braveResults(body),
        read: (record) => ({ title: record.title, url: record.url, snippet: record.description }),
      });
    },
  };
}

/** The GET a Brave search makes: the query and the count as parameters, the key as a header. */
function braveRequest(p: {
  readonly base: string;
  readonly apiKey: string | undefined;
  readonly query: string;
  readonly limit: number;
}): SearchRequest {
  const headers: Record<string, string> = { accept: "application/json" };
  if (p.apiKey !== undefined) headers["x-subscription-token"] = p.apiKey;
  return {
    url: `${p.base}?q=${encodeURIComponent(p.query)}&count=${p.limit}`,
    init: { method: "GET", headers },
  };
}

/** The `web.results` entries a Brave answer carries; no `web` member at all means none. */
function braveResults(body: unknown): readonly unknown[] {
  const answer = recordOf(body);
  if (answer === undefined) throw malformedAnswer(BACKEND, "no answer object");
  const web = answer.web;
  if (web === undefined || web === null) return [];
  const section = recordOf(web);
  if (section === undefined) throw malformedAnswer(BACKEND, "a web member that is not an object");
  const results = section.results;
  if (results === undefined) return [];
  if (!Array.isArray(results)) throw malformedAnswer(BACKEND, "a web member with no results array");
  return results;
}
