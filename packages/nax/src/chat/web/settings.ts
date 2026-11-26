/**
 * The chat session's resolved web settings (US-016): what `chat.web` means once the config has
 * been parsed and the search key has been looked up in the environment.
 *
 * A pure selector. It reads the parsed `ChatConfig` and the environment record it is handed —
 * no backend is constructed, no network or git call is made, and nothing is read from the
 * ambient process environment, so a caller can resolve the settings for a config it is only
 * inspecting. Backend construction, the git-remote host augmentation of the allowlist and the
 * notices are the wiring layer's (US-017).
 *
 * Search keys come from the environment only. `nax auth login` resolves provider ids through
 * nax-ai's model-provider list, which holds no search provider, so there is no credential store
 * entry for a search key — `WEB_SEARCH_KEY_ENV` (nax-agent) is the one place the variable names
 * live, and a key-needing backend whose variable is absent or empty is reported as
 * `missingKeyEnv` with no `search`. An empty credential is never synthesized: a caller that saw
 * one would offer a search that cannot work.
 */

import { WEB_SEARCH_KEY_ENV, type WebSearchBackendId } from "@nathapp/nax-agent/internal";
import {
  type ChatWebConfig,
  DEFAULT_CHAT_WEB_FETCH_MAX_BYTES,
  DEFAULT_CHAT_WEB_FETCH_TIMEOUT_MS,
  DEFAULT_CHAT_WEB_MAX_RESULTS,
  type NaxConfig,
} from "@/config";

/**
 * The hosts a sandboxed command may reach once the chat session is exposed, when
 * `chat.web.exposedAllowedDomains` is not configured.
 *
 * The order is part of the contract: the guard hands this list to srt as the network allowlist,
 * and a configured list replaces it whole (an explicitly empty list included). The reading is
 * "what a build or package install needs" — the registries and content hosts of the languages
 * nax orchestrates, plus the two GitHub content hosts a clone or tarball fetch lands on.
 */
export const DEFAULT_WEB_EXPOSED_DOMAINS: readonly string[] = [
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "pypi.org",
  "files.pythonhosted.org",
  "crates.io",
  "index.crates.io",
  "static.crates.io",
  "proxy.golang.org",
  "sum.golang.org",
  "bun.sh",
  "nodejs.org",
  "github.com",
  "codeload.github.com",
  "objects.githubusercontent.com",
];

/** The environment the settings are resolved against; `undefined` means "not set". */
export type ChatWebEnv = Readonly<Record<string, string | undefined>>;

/** The resolved chat web policy. */
export interface ChatWebSettings {
  /** Whether `nax chat` may offer the web tools at all. */
  readonly enabled: boolean;
  /** The backend a search goes through; absent when no search is configured or its key is missing. */
  readonly search?: { readonly id: WebSearchBackendId; readonly apiKey?: string; readonly baseUrl?: string };
  /** The environment variable to set, when the configured backend needs a key it does not have. */
  readonly missingKeyEnv?: string;
  /** How many results one search asks for. */
  readonly maxResults: number;
  /** The limits one `web__fetch` runs under. */
  readonly fetch: { readonly maxBytes: number; readonly timeoutMs: number };
  /** Hosts a sandboxed command may reach once the session is exposed. */
  readonly exposedAllowedDomains: readonly string[];
}

/** Which names come from the key lookup: either a usable backend, or the variable that is missing. */
type SearchResolution = Pick<ChatWebSettings, "search" | "missingKeyEnv">;

/** The one backend that is self-hosted: it takes a URL of its own and no key. */
const SEARXNG_BACKEND_ID = "searxng";

/** The keyed backends' ids, as `WEB_SEARCH_KEY_ENV` keys them. */
type KeyedBackendId = keyof typeof WEB_SEARCH_KEY_ENV;

/**
 * Whether a backend needs an API key.
 *
 * A type predicate, so `WEB_SEARCH_KEY_ENV[id]` is well-typed below without a cast: the predicate
 * excludes exactly the one id the environment map does not key.
 */
function needsApiKey(id: WebSearchBackendId): id is KeyedBackendId {
  return id !== SEARXNG_BACKEND_ID;
}

/**
 * Resolve the search backend, or the variable that is missing.
 *
 * No search config means fetch-only. SearXNG resolves to its configured URL and needs no key.
 * A keyed backend takes its key from `env` alone: absent or empty is reported, never replaced
 * with an empty string, because a backend built from `""` answers 401 rather than the notice
 * the operator can act on.
 */
function resolveSearch(web: ChatWebConfig | undefined, env: ChatWebEnv): SearchResolution {
  const search = web?.search;
  if (search === undefined) return {};

  if (!needsApiKey(search.backend)) {
    // `chat.web.search` config validation rejects a searxng search with no URL, so the absent
    // arm is unreachable for a parsed config; a hand-built one gets no URL rather than a
    // guessed one.
    return search.searxngUrl === undefined
      ? { search: { id: search.backend } }
      : { search: { id: search.backend, baseUrl: search.searxngUrl } };
  }

  const keyEnv = WEB_SEARCH_KEY_ENV[search.backend];
  const apiKey = env[keyEnv];
  if (apiKey === undefined || apiKey === "") return { missingKeyEnv: keyEnv };
  return { search: { id: search.backend, apiKey } };
}

/**
 * Resolve `chat.web` for a chat session.
 *
 * `enabled` and the search settings are resolved independently: the flag says whether the web
 * tools are offered, and a session that is switched off keeps its configured backend rather
 * than reporting a key it was never going to use. The wiring layer reads `enabled` first.
 */
export function resolveChatWebSettings(config: NaxConfig, env: ChatWebEnv): ChatWebSettings {
  const web = config.chat?.web;
  const fetch = web?.fetch;
  return {
    enabled: web?.enabled ?? false,
    ...resolveSearch(web, env),
    maxResults: web?.search?.maxResults ?? DEFAULT_CHAT_WEB_MAX_RESULTS,
    fetch: {
      maxBytes: fetch?.maxBytes ?? DEFAULT_CHAT_WEB_FETCH_MAX_BYTES,
      timeoutMs: fetch?.timeoutMs ?? DEFAULT_CHAT_WEB_FETCH_TIMEOUT_MS,
    },
    // `??` distinguishes "not configured" from "configured empty": an explicit `[]` replaces
    // the default list, which is how an operator turns the network off for exposed sessions.
    exposedAllowedDomains: web?.exposedAllowedDomains ?? DEFAULT_WEB_EXPOSED_DOMAINS,
  };
}
