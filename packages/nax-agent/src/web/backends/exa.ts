/**
 * The Exa backend: one POST to `/search`, answered with `results[].{title, url, text}`.
 *
 * Exa answers with a page's extracted text rather than a description, so the request asks for no
 * more of it than a snippet holds -- `SNIPPET_MAX_CHARS`, the cap a result's snippet is cut to
 * here as well -- and the answer arrives sized for the model instead of carrying every page.
 *
 * Two parts of Exa's answer shape are its own. A result's text is under `text`, and a result Exa
 * could not name arrives with no `title` at all; that one is titled by its normalised URL, which
 * is why the mapping is told `missingTitle` rather than leaving the title empty.
 *
 * The key goes in an `x-api-key` header rather than the body, so a request logged by a proxy
 * records that a key was used without recording the key. A search made with no key configured
 * sends no header at all and lets Exa answer 401, which the transport already reports as a
 * refused key -- the search is configured by the caller, not decided here.
 */

import type { SearchBackend, SearchBackendOptions } from "../search-backend.ts";
import {
  fetchSearchJson,
  malformedAnswer,
  recordOf,
  type SearchRequest,
  SNIPPET_MAX_CHARS,
  searchBaseUrl,
  toSearchResults,
} from "../search-request.ts";
import type { WebSearchResult } from "../types.ts";

/** Where Exa's search API lives, when nothing overrides it. */
const BASE_URL = "https://api.exa.ai";

/** The one endpoint an Exa search uses. */
const SEARCH_PATH = "/search";

/** The id this adapter answers to, and the name its failures carry. */
const BACKEND = "exa";

/** What an Exa backend is configured with: its key, and an optional base URL. */
export type ExaOptions = Omit<SearchBackendOptions, "id">;

/** An Exa search backend: the request, and the results its answer names. */
export function createExaBackend(opts: ExaOptions): SearchBackend {
  const url = `${searchBaseUrl(opts.baseUrl, BASE_URL)}${SEARCH_PATH}`;
  return {
    id: BACKEND,
    search: async (query, searchOpts): Promise<readonly WebSearchResult[]> => {
      const body = await fetchSearchJson({
        backend: BACKEND,
        request: exaRequest({ url, apiKey: opts.apiKey, query, limit: searchOpts.limit }),
        ...(searchOpts.signal !== undefined ? { signal: searchOpts.signal } : {}),
      });
      return toSearchResults({
        backend: BACKEND,
        items: exaResults(body),
        read: (record) => ({ title: record.title, url: record.url, snippet: record.text }),
        missingTitle: "url",
      });
    },
  };
}

/** The POST an Exa search makes: the query, the count, and how much text each result carries. */
function exaRequest(p: {
  readonly url: string;
  readonly apiKey: string | undefined;
  readonly query: string;
  readonly limit: number;
}): SearchRequest {
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
  if (p.apiKey !== undefined) headers["x-api-key"] = p.apiKey;
  return {
    url: p.url,
    init: {
      method: "POST",
      headers,
      body: JSON.stringify({
        query: p.query,
        numResults: p.limit,
        contents: { text: { maxCharacters: SNIPPET_MAX_CHARS } },
      }),
    },
  };
}

/** The `results` array an Exa answer carries, or the failure its absence is. */
function exaResults(body: unknown): readonly unknown[] {
  const results = recordOf(body)?.results;
  if (!Array.isArray(results)) throw malformedAnswer(BACKEND, "no results array");
  return results;
}
