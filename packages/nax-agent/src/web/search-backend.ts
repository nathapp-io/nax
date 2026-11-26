/**
 * The swappable search backend: the contract a web search is made through, the environment
 * variable each keyed backend reads, and the factory that picks one.
 *
 * A backend is chosen once, from config, and then only asked to search: `id` is what the
 * session counts and the footer shows, and `search` is the one call the web tool makes. The
 * adapters behind the factory own their own request and answer shapes; nothing above this file
 * knows which service answered.
 *
 * Keys come from the environment only. `nax auth login` resolves provider ids through nax-ai's
 * model-provider list, which holds no search provider, so a search key is never written to the
 * credential store -- `WEB_SEARCH_KEY_ENV` is the one place the variable names live.
 */

import { NaxError } from "#src/infra/index";
import { createBraveBackend } from "./backends/brave.ts";
import { createTavilyBackend } from "./backends/tavily.ts";
import type { WebSearchBackendId, WebSearchResult } from "./types.ts";

// The transport's seam belongs to the transport, but a test of any backend reaches for it
// here: one import path for the machinery a search is made through.
export { _webSearchDeps } from "./search-request.ts";

/** The `stage` an unimplemented backend's error carries. */
const STAGE = "web-search";

/** The code raised for a backend id this build has no adapter for. */
const UNSUPPORTED = "WEB_SEARCH_UNSUPPORTED";

/** One search service, as the web tool sees it: an id to report and one call to make. */
export interface SearchBackend {
  readonly id: WebSearchBackendId;
  search(query: string, opts: SearchOptions): Promise<readonly WebSearchResult[]>;
}

/** What one search may ask for: how many results, and the caller's cancellation. */
export interface SearchOptions {
  readonly limit: number;
  readonly signal?: AbortSignal;
}

/** What a backend is built from: which service, its key, and any base URL that overrides it. */
export interface SearchBackendOptions {
  readonly id: WebSearchBackendId;
  readonly apiKey?: string;
  readonly baseUrl?: string;
}

/** The environment variable each keyed backend reads its key from. */
export const WEB_SEARCH_KEY_ENV: Readonly<Record<"tavily" | "brave" | "exa", string>> = {
  tavily: "TAVILY_API_KEY",
  brave: "BRAVE_SEARCH_API_KEY",
  exa: "EXA_API_KEY",
};

/**
 * The backend a configuration names. An id with no adapter yet is a configuration this build
 * cannot honour, so it fails here rather than at the first search.
 */
export function createSearchBackend(p: SearchBackendOptions): SearchBackend {
  switch (p.id) {
    case "tavily":
      return createTavilyBackend(p);
    case "brave":
      return createBraveBackend(p);
    default:
      throw new NaxError(`search backend ${p.id} is not implemented`, UNSUPPORTED, {
        stage: STAGE,
        backend: p.id,
      });
  }
}
