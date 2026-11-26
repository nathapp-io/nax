/**
 * The web tool family's surface, for the one consumer: `nax`, which reaches it through
 * `@nathapp/nax-agent/internal`.
 *
 * This barrel is deliberately narrow. It re-exports only the names nax itself calls, so
 * an internal helper stays reachable from its own module and its tests without becoming
 * part of anything a caller can depend on -- `fenceWebContent` is the clearest case: the
 * web tools fence their results, nax never does, and re-exporting it here would make the
 * fence a cross-package contract. Each story adds its own names as nax starts using them.
 */
export { extractWebUrls, normalizeWebUrl } from "./content.ts";
export { createWebExposure, type WebExposure } from "./exposure.ts";
export { createSearchBackend, type SearchBackend, WEB_SEARCH_KEY_ENV } from "./search-backend.ts";
export {
  WEB_SEEN_URL_CAP,
  type WebExposureSnapshot,
  type WebSearchBackendId,
  type WebSearchResult,
} from "./types.ts";
