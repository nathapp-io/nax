/**
 * Shared shapes of the web tool family, and the one bound on what a session remembers.
 *
 * These are the names nax needs at its own layer (the config schema, the footer, the
 * session meta) without importing the machinery behind them: a backend id, one search
 * result, and the exposure snapshot a session persists. Nothing here has behaviour, so
 * this file stays importable from anywhere in the package without an import cycle.
 */

/** A search backend nax can be configured with. `searxng` is self-hosted and needs no key. */
export type WebSearchBackendId = "tavily" | "brave" | "exa" | "searxng";

/** One search result, already normalised: the URL is `normalizeWebUrl`'s output. */
export interface WebSearchResult {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
}

/**
 * What a session remembers about the web: when it was first exposed (`null` before),
 * which URLs it may fetch without asking, and how many searches succeeded. Persisted as
 * the stored session meta's `web` field, so resume and compaction keep it.
 */
export interface WebExposureSnapshot {
  readonly exposedAt: string | null;
  readonly seenUrls: readonly string[];
  readonly searches: number;
}

/**
 * How many distinct seen URLs a session keeps. Past this, adding one drops the oldest, so
 * a long session holds a bounded amount of state rather than every link a page ever named.
 */
export const WEB_SEEN_URL_CAP = 2000;
