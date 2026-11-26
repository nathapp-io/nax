import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { SessionMeta } from "@nathapp/nax-agent";
import type { SearchBackend, WebSearchBackendId } from "@nathapp/nax-agent/internal";
import { assertDefined, type DeepPartial, firstCall, makeNaxConfig, makeSpawn } from "@test/helpers";
import { DEFAULT_WEB_EXPOSED_DOMAINS } from "@/chat/web/settings";
import {
  _chatWebDeps,
  type ChatWebResult,
  createChatWeb,
  gitRemoteHostsOf,
  searchAllowOrigins,
} from "@/chat/web/wiring";
import type { NaxConfig } from "@/config";
import { addSink, initLogger, type LogEntry, resetLogger } from "@/logger";
import { _gitDeps } from "@/utils/git";

/** The repository a session opens in; every case passes it straight through. */
const REPO_ROOT = "/repo";

/** The seam's real remote read, captured before any case stubs it. */
const DEFAULT_GIT_REMOTE_HOSTS = _chatWebDeps.gitRemoteHosts;

/** The deps as they were before a test stubbed them, restored after each case. */
let savedDeps: typeof _chatWebDeps;

/** The git and environment answers a case starts from: no ambient env, no remote hosts. */
beforeEach(() => {
  savedDeps = { ..._chatWebDeps };
  _chatWebDeps.env = () => ({});
  _chatWebDeps.gitRemoteHosts = async () => [];
});

afterEach(() => {
  Object.assign(_chatWebDeps, savedDeps);
});

/** The web tools switched on, with whatever else a case adds. */
function enabledConfig(overrides: DeepPartial<NaxConfig> = {}): NaxConfig {
  return makeNaxConfig({ chat: { web: { enabled: true } }, ...overrides });
}

/** A config whose `chat.web.search` names `backend`, and searxng's URL where the case gives one. */
function searchConfig(backend: WebSearchBackendId, searxngUrl?: string): NaxConfig {
  return enabledConfig({
    chat: {
      web: {
        enabled: true,
        search: { backend, ...(searxngUrl === undefined ? {} : { searxngUrl }) },
      },
    },
  });
}

/** A stored session meta, optionally carrying the `web` field the exposure is restored from. */
function metaOf(web?: SessionMeta["web"]): SessionMeta {
  return {
    schemaVersion: 1,
    sessionId: "chat-web-session",
    cwd: REPO_ROOT,
    mode: "full",
    model: "test-model",
    bashApproval: "raw",
    title: null,
    createdAt: "2026-11-26T00:00:00.000Z",
    updatedAt: null,
    costUsd: 0,
    ...(web === undefined ? {} : { web }),
  };
}

/** One call to the factory, with everything a case does not care about defaulted. */
function chatWeb(p: { config: NaxConfig; meta?: SessionMeta; backend?: "native" | "acp" }): Promise<ChatWebResult> {
  return createChatWeb({
    config: p.config,
    repoRoot: REPO_ROOT,
    meta: p.meta,
    backend: p.backend ?? "native",
  });
}

/** A backend stand-in: nothing is networked, and the id is what the provider is built with. */
function fakeBackend(id: WebSearchBackendId): SearchBackend {
  return { id, search: async () => [] };
}

/** Replace the backend factory with a mock, and hand the mock back so a case can read its call. */
function stubCreateSearchBackend() {
  const create = mock((p: Parameters<typeof _chatWebDeps.createSearchBackend>[0]) => fakeBackend(p.id));
  _chatWebDeps.createSearchBackend = create;
  return create;
}

/** The tools a session's provider advertises, by local name. */
async function toolNamesOf(result: ChatWebResult): Promise<readonly string[]> {
  assertDefined(result.web, "web");
  return (await result.web.provider.tools(REPO_ROOT)).map((tool) => tool.localName);
}

describe("gitRemoteHostsOf", () => {
  test("AC-1: an https remote and an SCP-style remote resolve to their hosts", () => {
    expect(
      gitRemoteHostsOf(`origin\thttps://github.com/o/r.git (fetch)\nup\tgit@gitlab.example.com:o/r.git (push)\n`),
    ).toEqual(["github.com", "gitlab.example.com"]);
  });

  test("AC-2: an ssh URL keeps its host and drops its port", () => {
    expect(gitRemoteHostsOf("origin\tssh://git@host.example:2222/o/r.git (fetch)\n")).toEqual(["host.example"]);
  });

  test("the same host reached by two remotes is listed once", () => {
    expect(
      gitRemoteHostsOf(`origin\thttps://github.com/o/r.git (fetch)\norigin\thttps://github.com/o/r.git (push)\n`),
    ).toEqual(["github.com"]);
  });

  test("hosts are compared lowercased, and reported lowercased", () => {
    expect(
      gitRemoteHostsOf(`origin\thttps://GitHub.com/o/r.git (fetch)\nup\tgit@github.com:o/r2.git (push)\n`),
    ).toEqual(["github.com"]);
  });

  test("a local path or a file:// remote names no host", () => {
    expect(
      gitRemoteHostsOf(`local\t/srv/git/r.git (fetch)\nfile\tfile:///srv/git/r.git (push)\nnone\t../r.git (push)\n`),
    ).toEqual([]);
  });

  test("a URL with a port keeps the host without the port", () => {
    expect(gitRemoteHostsOf("origin\thttps://git.example:8443/o/r.git (fetch)\n")).toEqual(["git.example"]);
  });

  test("empty output lists no hosts", () => {
    expect(gitRemoteHostsOf("")).toEqual([]);
  });

  test("a line with no URL field is skipped", () => {
    expect(gitRemoteHostsOf("origin\n")).toEqual([]);
  });
});

describe("createChatWeb — the two switches", () => {
  test("AC-3: chat.web disabled resolves to no web at all", async () => {
    expect(await chatWeb({ config: makeNaxConfig() })).toEqual({});
  });

  test("a disabled config reads no git remotes", async () => {
    const hosts = _chatWebDeps.gitRemoteHosts;
    let calls = 0;
    _chatWebDeps.gitRemoteHosts = async (root) => {
      calls += 1;
      return hosts(root);
    };
    await chatWeb({ config: makeNaxConfig() });
    expect(calls).toBe(0);
  });

  test("AC-4: an ACP backend gets the notice and no web pieces", async () => {
    expect(await chatWeb({ config: enabledConfig(), backend: "acp" })).toEqual({
      notice: "web tools need the native agent; they are off in this session",
    });
  });
});

describe("createChatWeb — the restored exposure", () => {
  test("AC-10: the stored meta's web is the exposure the session opens with", async () => {
    const web = { exposedAt: "2026-11-26T10:00:00.000Z", seenUrls: ["https://a.example/"], searches: 1 };
    const result = await chatWeb({ config: enabledConfig(), meta: metaOf(web) });
    assertDefined(result.web, "web");
    expect(result.web.exposure.snapshot()).toEqual(web);
  });

  test("a meta with no web opens unexposed", async () => {
    const result = await chatWeb({ config: enabledConfig(), meta: metaOf() });
    assertDefined(result.web, "web");
    expect(result.web.exposure.isExposed()).toBe(false);
  });
});

describe("createChatWeb — the search backend and its notice", () => {
  test("AC-5: the backend is built through the seam from the settings, with its key", async () => {
    const create = stubCreateSearchBackend();
    _chatWebDeps.env = () => ({ TAVILY_API_KEY: "k" });
    await chatWeb({ config: searchConfig("tavily") });
    expect(firstCall(create)).toEqual([{ id: "tavily", apiKey: "k" }]);
  });

  test("AC-6: a keyless backend costs the search, and one notice names the variable to set", async () => {
    const result = await chatWeb({ config: searchConfig("brave") });
    expect(result.notice).toBe("web search is off: set BRAVE_SEARCH_API_KEY to use brave; web fetch is available");
  });

  test("AC-12: with the key missing the provider offers the fetch tool alone", async () => {
    expect(await toolNamesOf(await chatWeb({ config: searchConfig("brave") }))).toEqual(["fetch"]);
  });

  test("with its key the backend is offered beside fetch, and nothing is reported missing", async () => {
    _chatWebDeps.env = () => ({ TAVILY_API_KEY: "k" });
    const result = await chatWeb({ config: searchConfig("tavily") });
    expect(await toolNamesOf(result)).toEqual(["search", "fetch"]);
    expect(result.notice).toBeUndefined();
  });

  test("a searxng search is built from its URL, needs no key, and reports nothing", async () => {
    const create = stubCreateSearchBackend();
    const result = await chatWeb({ config: searchConfig("searxng", "http://search.example.lan:8080") });
    expect(firstCall(create)).toEqual([{ id: "searxng", baseUrl: "http://search.example.lan:8080" }]);
    expect(result.notice).toBeUndefined();
  });

  test("a session with no search configured offers the fetch tool alone and says nothing", async () => {
    const result = await chatWeb({ config: enabledConfig() });
    expect(await toolNamesOf(result)).toEqual(["fetch"]);
    expect(result.notice).toBeUndefined();
  });
});

describe("searchAllowOrigins", () => {
  test("a searxng base URL exempts its own origin, with the path dropped", () => {
    expect(searchAllowOrigins({ id: "searxng", baseUrl: "http://search.example.lan:8080/base" })).toEqual([
      "http://search.example.lan:8080",
    ]);
  });

  test("no search means nothing is exempt", () => {
    expect(searchAllowOrigins(undefined)).toEqual([]);
  });

  test("a searxng search with no URL has no origin to exempt", () => {
    expect(searchAllowOrigins({ id: "searxng" })).toEqual([]);
  });

  test("a hosted backend exempts nothing: its host is public", () => {
    expect(searchAllowOrigins({ id: "tavily", apiKey: "k" })).toEqual([]);
  });

  test("a base URL that is not a URL exempts nothing", () => {
    expect(searchAllowOrigins({ id: "searxng", baseUrl: "search.example.lan" })).toEqual([]);
  });
});

describe("createChatWeb — the sandbox config", () => {
  test("AC-7: with no configured domains the chat sandbox allows every host", async () => {
    const result = await chatWeb({ config: enabledConfig() });
    assertDefined(result.web, "web");
    expect(result.web.sandbox.network.allowedDomains).toEqual(["*"]);
  });

  test("a configured domain list is used as it is, never widened to every host", async () => {
    const config = enabledConfig({ execution: { sandbox: { network: { allowedDomains: ["registry.npmjs.org"] } } } });
    const result = await chatWeb({ config });
    assertDefined(result.web, "web");
    expect(result.web.sandbox.network.allowedDomains).toEqual(["registry.npmjs.org"]);
  });

  test("the rest of the configured sandbox policy is carried through unchanged", async () => {
    const config = enabledConfig({
      execution: { sandbox: { enabled: false, filesystem: { allowWrite: ["/srv/out"] } } },
    });
    const result = await chatWeb({ config });
    assertDefined(result.web, "web");
    expect(result.web.sandbox.enabled).toBe(false);
    expect(result.web.sandbox.filesystem.allowWrite).toEqual(["/srv/out"]);
  });
});

/** Mark a session's exposure, the way a first web result does, and read the network it leaves. */
function exposedNetworkAfterRead(result: ChatWebResult): readonly string[] | undefined {
  assertDefined(result.web, "web");
  expect(result.web.guard.exposedNetwork()).toBeUndefined();
  result.web.exposure.markExposed(new Date("2026-11-26T10:00:00.000Z"));
  return result.web.guard.exposedNetwork();
}

describe("createChatWeb — the exposed allowlist and the git remotes", () => {
  test("AC-8: the allowlist is the settings' list followed by the repository's hosts", async () => {
    _chatWebDeps.gitRemoteHosts = async () => ["git.example.com", "gitea.example.com"];
    const network = exposedNetworkAfterRead(await chatWeb({ config: enabledConfig() }));
    expect(network).toEqual([...DEFAULT_WEB_EXPOSED_DOMAINS, "git.example.com", "gitea.example.com"]);
  });

  test("a configured exposed list replaces the default one, with the remote hosts after it", async () => {
    _chatWebDeps.gitRemoteHosts = async () => ["git.example.com"];
    const config = enabledConfig({ chat: { web: { enabled: true, exposedAllowedDomains: ["x.example"] } } });
    expect(exposedNetworkAfterRead(await chatWeb({ config }))).toEqual(["x.example", "git.example.com"]);
  });

  test("the exposed allowlist is intersected with the user's own sandbox list, not widened by [*]", async () => {
    _chatWebDeps.gitRemoteHosts = async () => ["git.example.com"];
    const config = enabledConfig({ execution: { sandbox: { network: { allowedDomains: ["registry.npmjs.org"] } } } });
    const result = await chatWeb({ config });
    assertDefined(result.web, "web");
    expect(result.web.sandbox.network.allowedDomains).toEqual(["registry.npmjs.org"]);
    expect(exposedNetworkAfterRead(result)).toEqual(["registry.npmjs.org"]);
  });

  test("the remotes are read from the repository the session opens in", async () => {
    const roots: string[] = [];
    _chatWebDeps.gitRemoteHosts = async (root) => {
      roots.push(root);
      return [];
    };
    await chatWeb({ config: enabledConfig() });
    expect(roots).toEqual([REPO_ROOT]);
  });

  test("AC-9: when the remotes cannot be read the allowlist is the settings' list alone", async () => {
    let reads = 0;
    _chatWebDeps.gitRemoteHosts = async () => {
      reads += 1;
      throw new Error("fatal: not a git repository");
    };
    const network = exposedNetworkAfterRead(await chatWeb({ config: enabledConfig() }));
    expect(reads).toBe(1);
    expect(network).toEqual(DEFAULT_WEB_EXPOSED_DOMAINS);
  });
});

describe("createChatWeb — a failed git read is logged once", () => {
  let logs: LogEntry[] = [];

  beforeEach(() => {
    resetLogger();
    logs = [];
    initLogger({ level: "silent" });
    addSink((entry) => logs.push(entry));
  });

  afterEach(() => {
    resetLogger();
  });

  test("AC-11: a rejected remote read costs one debug line, and the session still opens", async () => {
    _chatWebDeps.gitRemoteHosts = async () => {
      throw new Error("fatal: not a git repository");
    };
    const result = await chatWeb({ config: enabledConfig() });
    assertDefined(result.web, "web");
    expect(logs.filter((entry) => entry.level === "debug")).toHaveLength(1);
  });

  test("a successful read logs nothing", async () => {
    const result = await chatWeb({ config: enabledConfig() });
    assertDefined(result.web, "web");
    expect(logs).toEqual([]);
  });
});

describe("the default git remote read", () => {
  const originalSpawn = _gitDeps.spawn;

  afterEach(() => {
    _gitDeps.spawn = originalSpawn;
  });

  /** Run a session through the REAL remote read, with git itself stubbed. */
  function realGitRead(handler: Parameters<typeof makeSpawn>[0]) {
    const git = makeSpawn(handler);
    _gitDeps.spawn = git.spawn;
    // The seam's own default is what runs `git remote -v`; the beforeEach stub is undone here.
    _chatWebDeps.gitRemoteHosts = DEFAULT_GIT_REMOTE_HOSTS;
    return git;
  }

  test("git remote -v is read in the repository root, and its hosts join the allowlist", async () => {
    const git = realGitRead(() => "origin\tgit@git.example.com:o/r.git (fetch)\n");
    const network = exposedNetworkAfterRead(await chatWeb({ config: enabledConfig() }));
    expect(git.calls[0]?.opts.cwd).toBe(REPO_ROOT);
    const call = git.calls[0];
    assertDefined(call, "git spawn call");
    expect(call.cmd).toContain("remote");
    expect(call.cmd).toContain("-v");
    expect(network).toEqual([...DEFAULT_WEB_EXPOSED_DOMAINS, "git.example.com"]);
  });

  test("a git that answers non-zero degrades the allowlist instead of failing the session", async () => {
    realGitRead(() => ({ exitCode: 128, stderr: "fatal: not a git repository\n" }));
    const network = exposedNetworkAfterRead(await chatWeb({ config: enabledConfig() }));
    expect(network).toEqual(DEFAULT_WEB_EXPOSED_DOMAINS);
  });
});
