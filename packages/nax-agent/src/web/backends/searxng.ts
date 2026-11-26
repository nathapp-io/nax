/**
 * The SearXNG backend: one GET to `<baseUrl>/search`, answered with
 * `results[].{title, url, content}`.
 *
 * SearXNG is self-hosted, so it has no default endpoint and no key: the base URL is the whole of
 * its configuration, and its requests carry no authorization header. A backend built without one
 * is refused here rather than pointed at an empty host -- `chat.web.search.searxngUrl` validation
 * is what keeps that from being reached, and this is the floor under it.
 *
 * The instance is asked for `format=json` and nothing else. One that answers HTML is an instance
 * whose JSON format is not enabled, which the transport reports as a body that is not a search
 * answer rather than as a search with no results.
 *
 * The query travels in the URL, so no request body exists to log. The instance answers with more
 * results than a caller asked for, so the answer is cut to the requested count before mapping.
 */

import type { SearchBackend, SearchBackendOptions } from "../search-backend.ts";
import {
  fetchSearchJson,
  malformedAnswer,
  recordOf,
  type SearchRequest,
  searchBaseUrl,
  searchFailure,
  toSearchResults,
} from "../search-request.ts";
import type { WebSearchResult } from "../types.ts";

/** The one endpoint a SearXNG search uses, appended to the configured base URL. */
const SEARCH_PATH = "/search";

/** The answer format a SearXNG instance must be configured to serve. */
const JSON_FORMAT = "json";

/** The id this adapter answers to, and the name its failures carry. */
const BACKEND = "searxng";

/** What a SearXNG backend is configured with: the instance's base URL, and nothing else. */
export type SearxngOptions = Omit<SearchBackendOptions, "id">;

/** A SearXNG search backend: the request, and the results its answer names. */
export function createSearxngBackend(opts: SearxngOptions): SearchBackend {
  const base = searxngBaseUrl(opts.baseUrl);
  return {
    id: BACKEND,
    search: async (query, searchOpts): Promise<readonly WebSearchResult[]> => {
      const body = await fetchSearchJson({
        backend: BACKEND,
        request: searxngRequest({ base, query }),
        ...(searchOpts.signal !== undefined ? { signal: searchOpts.signal } : {}),
      });
      return toSearchResults({
        backend: BACKEND,
        items: searxngResults(body, searchOpts.limit),
        read: (record) => ({ title: record.title, url: record.url, snippet: record.content }),
      });
    },
  };
}

/**
 * The instance a backend searches: the configured base URL with its trailing slashes dropped, so
 * a path can be appended, or the failure a missing one is.
 */
function searxngBaseUrl(configured: string | undefined): string {
  if (configured === undefined || configured.trim() === "") {
    throw searchFailure("searxng needs a base url to search a self-hosted instance", { backend: BACKEND });
  }
  return searchBaseUrl(configured, "");
}

/** The GET a SearXNG search makes: the query and the answer format, as parameters. */
function searxngRequest(p: { readonly base: string; readonly query: string }): SearchRequest {
  return {
    url: `${p.base}${SEARCH_PATH}?q=${encodeURIComponent(p.query)}&format=${JSON_FORMAT}`,
    init: { method: "GET", headers: { accept: "application/json" } },
  };
}

/** The `results` entries a SearXNG answer carries, cut to the count the caller asked for. */
function searxngResults(body: unknown, limit: number): readonly unknown[] {
  const answer = recordOf(body);
  if (answer === undefined) throw malformedAnswer(BACKEND, "no answer object");
  const results = answer.results;
  if (!Array.isArray(results)) throw malformedAnswer(BACKEND, "no results array");
  return results.slice(0, limit);
}
