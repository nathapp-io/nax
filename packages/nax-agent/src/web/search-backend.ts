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

import { createBraveBackend } from "./backends/brave.ts";
import { createExaBackend } from "./backends/exa.ts";
import { createSearxngBackend } from "./backends/searxng.ts";
import { createTavilyBackend } from "./backends/tavily.ts";
import type { WebSearchBackendId, WebSearchResult } from "./types.ts";

// The transport's seam belongs to the transport, but a test of any backend reaches for it
// here: one import path for the machinery a search is made through.
export { _webSearchDeps } from "./search-request.ts";

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
 * The backend a configuration names.
 *
 * The switch is exhaustive over `WebSearchBackendId` on purpose: a fifth backend added to the
 * union without an adapter is a compile error here, not a search that resolves to `undefined`.
 * The id is validated against that same union by `chat.web.search` config validation before this
 * factory is reached, so an id with no adapter is not a state a running session can be in.
 */
export function createSearchBackend(p: SearchBackendOptions): SearchBackend {
  switch (p.id) {
    case "tavily":
      return createTavilyBackend(p);
    case "brave":
      return createBraveBackend(p);
    case "exa":
      return createExaBackend(p);
    case "searxng":
      return createSearxngBackend(p);
  }
}
