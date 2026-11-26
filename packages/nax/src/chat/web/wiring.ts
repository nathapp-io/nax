/**
 * The chat session's web wiring (US-017): one call turns the resolved `chat.web` settings plus
 * the repository's git remotes into the pieces a session needs — a tool provider, an exposure
 * guard, the exposure state itself, and the sandbox config the session opens with.
 *
 * Three rules this module exists to keep in one place:
 *
 *  - **The exposed allowlist is the settings' list plus the repository's own hosts.** A build
 *    that can reach the registries but not the repository's git host is not a usable exposed
 *    session, and the remotes are the only place that host is written down.
 *  - **The sandbox opens every host reachable while `chat.web.enabled` is true**, when the user
 *    configured no list. srt filters against ONE process-wide allowlist, so a later swap to the
 *    exposed list is only possible for commands that were routed through the proxy from the
 *    start; `["*"]` is srt's "every host" pattern. A configured list is used as it is.
 *  - **A missing search key costs the search, never the session.** Fetch needs no key, so the
 *    session still opens with `web__fetch` and one notice naming the variable to set.
 *
 * This is the only nax import site for the web factories: `nax run`, story, bot and subagent
 * sessions never reach them (`scripts/check-web-chat-only.ts`, US-020).
 */

import type { SessionMeta, ToolProvider } from "@nathapp/nax-agent";
import {
  createSearchBackend,
  createWebExposure,
  createWebExposureGuard,
  createWebToolProvider,
  errorMessage,
  type SearchBackend,
  type WebExposure,
  type WebExposureGuard,
} from "@nathapp/nax-agent/internal";
import { DEFAULT_SANDBOX_CONFIG, type NaxConfig, type SandboxConfig } from "@/config";
import { NaxError } from "@/errors";
import { getLogger } from "@/logger";
import { gitWithTimeout } from "@/utils/git";
import { type ChatWebSettings, resolveChatWebSettings } from "./settings";

/** The stage every line this module logs carries. */
const LOG_STAGE = "chat";

/** What an ACP-backed chat is told: the tools live in-process, and that agent is not in it. */
const ACP_NOTICE = "web tools need the native agent; they are off in this session";

/** srt's pattern for "every host": the session reaches the network, just not a restricted part of it. */
const EVERY_HOST = "*";

/** A git remote URL's scheme prefix (`https://`, `ssh://`, `git://`, `file://`). */
const REMOTE_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * An SCP-style remote: `[user@]host:path`. The colon must be followed by a path, so a bare
 * `host:` is not read as one, and the host field excludes `/` so a local path never matches.
 */
const SCP_REMOTE = /^(?:[^@/\s]+@)?([^:/\s]+):\S+$/;

/** What the wiring needs, all of it resolved by the caller before the session opens. */
export interface ChatWebOptions {
  readonly config: NaxConfig;
  /** The repository the session runs in: where its git remotes are read from. */
  readonly repoRoot: string;
  /** The stored meta of the session being (re)opened, whose `web` restores the exposure. */
  readonly meta: SessionMeta | undefined;
  /** Which transport drives the chat; only the native one is in this process. */
  readonly backend: "native" | "acp";
}

/** What one chat session owns once the web is switched on. */
export interface ChatWeb {
  readonly provider: ToolProvider;
  readonly guard: WebExposureGuard;
  readonly exposure: WebExposure;
  readonly sandbox: SandboxConfig;
}

/** What the session opens with: the web pieces, and at most one thing to tell the person. */
export interface ChatWebResult {
  readonly web?: ChatWeb;
  readonly notice?: string;
}

/**
 * Test seam: the environment, the remote hosts and the backend factory, and nothing else. Every
 * one is stubbed by the tests, so no case reads the ambient environment or runs git.
 */
export const _chatWebDeps: {
  env: () => Readonly<Record<string, string | undefined>>;
  gitRemoteHosts: (repoRoot: string) => Promise<readonly string[]>;
  createSearchBackend: typeof createSearchBackend;
} = {
  env: () => process.env,
  gitRemoteHosts: (repoRoot) => readGitRemoteHosts(repoRoot),
  createSearchBackend: (p) => createSearchBackend(p),
};

/** The host one remote URL names, lowercased, or `null` when it names none. */
function hostOfRemoteUrl(text: string): string | null {
  const url = text.trim();
  if (REMOTE_SCHEME.test(url)) {
    try {
      return hostOrNull(new URL(url).hostname);
    } catch {
      // Text that looks like a URL but does not parse names no host we can trust.
      return null;
    }
  }
  const scp = SCP_REMOTE.exec(url);
  return scp === null ? null : hostOrNull(scp[1]);
}

/** A hostname lowercased, or `null` for the empty one a `file://` remote carries. */
function hostOrNull(hostname: string | undefined): string | null {
  const lower = (hostname ?? "").toLowerCase();
  return lower === "" ? null : lower;
}

/** The URL field of one `git remote -v` line (`<name>\t<url> (fetch|push)`), if it has one. */
function remoteUrlOf(line: string): string | undefined {
  return line.trim().split(/\s+/)[1];
}

/**
 * The hosts a repository's remotes name, from the output of `git remote -v`.
 *
 * `(fetch)` and `(push)` lines for one remote repeat its URL, so the result is deduplicated —
 * lowercased, because srt matches a hostname case-insensitively and two spellings of one host
 * would otherwise occupy two entries. Ports and paths are dropped: the allowlist holds hosts.
 */
export function gitRemoteHostsOf(remoteVerboseOutput: string): readonly string[] {
  const hosts: string[] = [];
  const seen = new Set<string>();
  for (const line of remoteVerboseOutput.split("\n")) {
    const url = remoteUrlOf(line);
    const host = url === undefined ? null : hostOfRemoteUrl(url);
    if (host === null || seen.has(host)) continue;
    seen.add(host);
    hosts.push(host);
  }
  return hosts;
}

/**
 * The hosts `git remote -v` reports in `repoRoot`.
 *
 * A git that exits non-zero (a directory that is not a repository) throws rather than answering
 * "no hosts": the caller degrades the allowlist and logs why, and a silent empty answer would
 * hide the reason. A read that fails is never fatal to the session (F10).
 */
async function readGitRemoteHosts(repoRoot: string): Promise<readonly string[]> {
  const { stdout, exitCode, stderr, timedOut } = await gitWithTimeout(["remote", "-v"], repoRoot);
  if (exitCode !== 0 || timedOut === true) {
    throw new NaxError("could not read the repository's git remotes", "GIT_REMOTE_LIST_FAILED", {
      stage: LOG_STAGE,
      repoRoot,
      exitCode,
      stderr: stderr.trim(),
    });
  }
  return gitRemoteHostsOf(stdout);
}

/** The domains the user configured for the sandbox, or undefined when they configured none. */
function configuredAllowedDomains(config: NaxConfig): readonly string[] | undefined {
  return config.execution.sandbox?.network.allowedDomains;
}

/** A URL's origin, or `null` when the text does not parse as one. */
function originOf(text: string): string | null {
  try {
    return new URL(text).origin;
  } catch {
    // Text that is not a URL has no origin, so it can exempt nothing.
    return null;
  }
}

/**
 * The origins a page fetch skips the address check for: the configured SearXNG's own origin.
 *
 * A self-hosted search is frequently on a private network by design, and it is the operator's
 * own choice of destination rather than a page's. Only that one origin is exempt — not every
 * origin on the same host, and not the hosted backends, whose search hosts are public.
 */
export function searchAllowOrigins(search: ChatWebSettings["search"]): readonly string[] {
  const baseUrl = search?.baseUrl;
  if (baseUrl === undefined) return [];
  const origin = originOf(baseUrl);
  return origin === null ? [] : [origin];
}

/**
 * The sandbox config the chat session opens with.
 *
 * srt filters network requests against ONE process-wide allowlist, and a per-command config only
 * decides whether the command is routed through its proxy at all. So an exposed session's later
 * swap to a restricted list is only possible for commands that were proxied from the start —
 * `["*"]` keeps every host reachable while putting them all behind the proxy. A list the user
 * configured is used as it is: they have already decided what the session may reach.
 */
function chatSandbox(config: NaxConfig): SandboxConfig {
  const sandbox = config.execution.sandbox ?? DEFAULT_SANDBOX_CONFIG;
  if (sandbox.network.allowedDomains !== undefined) return sandbox;
  return { ...sandbox, network: { ...sandbox.network, allowedDomains: [EVERY_HOST] } };
}

/**
 * The hosts an exposed session's sandbox keeps reachable: the settings' list, then the
 * repository's own remotes, so a build that may reach the registries may also reach the git host
 * this repository is pushed to. A read that fails degrades to the settings' list alone and logs
 * once (F10) — a session that cannot read its remotes still opens.
 */
async function exposedAllowedDomainsOf(settings: ChatWebSettings, repoRoot: string): Promise<readonly string[]> {
  try {
    return [...settings.exposedAllowedDomains, ...(await _chatWebDeps.gitRemoteHosts(repoRoot))];
  } catch (error) {
    getLogger().debug(LOG_STAGE, "could not read the repository's git remotes; the exposed allowlist omits them", {
      repoRoot,
      error: errorMessage(error),
    });
    return settings.exposedAllowedDomains;
  }
}

/** What the backend factory is asked: the id, and whichever of its key or URL is set. */
function backendOptions(search: NonNullable<ChatWebSettings["search"]>): Parameters<typeof createSearchBackend>[0] {
  const { id, apiKey, baseUrl } = search;
  if (apiKey !== undefined) return { id, apiKey };
  if (baseUrl !== undefined) return { id, baseUrl };
  return { id };
}

/**
 * The search backend the settings resolved, or undefined when there is no usable one.
 *
 * A key-needing backend whose key is missing has no `search` in the settings, and this is the
 * one place that absence becomes "no search tool": the provider is never handed a backend that
 * could only fail (F12).
 */
function searchBackendOf(settings: ChatWebSettings): SearchBackend | undefined {
  const search = settings.search;
  return search === undefined ? undefined : _chatWebDeps.createSearchBackend(backendOptions(search));
}

/**
 * The one line a session with a missing search key is told: which variable to set, for which
 * backend, and that the half of the web that needs no key still works.
 *
 * `missingKeyEnv` is set exactly when a keyed backend's variable was absent or empty, so the
 * backend id is read from the config — the settings carry it on a usable `search`, and there is
 * none here.
 */
function missingKeyNotice(config: NaxConfig, settings: ChatWebSettings): string | undefined {
  const keyEnv = settings.missingKeyEnv;
  const backend = config.chat?.web?.search?.backend;
  if (keyEnv === undefined || backend === undefined) return undefined;
  return `web search is off: set ${keyEnv} to use ${backend}; web fetch is available`;
}

/**
 * Build one chat session's web pieces from the resolved settings and the repository's remotes.
 *
 * A disabled config costs nothing — no git read, no backend, no provider — and an ACP-backed
 * chat is told once why it gets none: the tools run in this process, and that session's agent
 * does not (US-018 passes its notice through with the session's own).
 */
export async function createChatWeb(p: ChatWebOptions): Promise<ChatWebResult> {
  const settings = resolveChatWebSettings(p.config, _chatWebDeps.env());
  if (!settings.enabled) return {};
  if (p.backend === "acp") return { notice: ACP_NOTICE };

  const exposure = createWebExposure(p.meta?.web);
  const search = searchBackendOf(settings);
  const provider = createWebToolProvider({
    exposure,
    ...(search === undefined ? {} : { search }),
    maxResults: settings.maxResults,
    fetch: settings.fetch,
    allowOrigins: searchAllowOrigins(settings.search),
  });
  const guard = createWebExposureGuard({
    exposure,
    exposedAllowedDomains: await exposedAllowedDomainsOf(settings, p.repoRoot),
    // The user's ORIGINAL list, not the `["*"]` the chat sandbox opens with: the guard intersects
    // the exposed list with what the user actually allowed, so the startup fallback cannot widen
    // the network a session keeps after it has read the web.
    configuredAllowedDomains: configuredAllowedDomains(p.config),
  });
  const notice = missingKeyNotice(p.config, settings);
  return {
    web: { provider, guard, exposure, sandbox: chatSandbox(p.config) },
    ...(notice === undefined ? {} : { notice }),
  };
}
