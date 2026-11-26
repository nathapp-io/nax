import { describe, expect, test } from "bun:test";
import { DEFAULT_WEB_EXPOSED_DOMAINS, resolveChatWebSettings } from "@/chat/web/settings";
import type { NaxConfig } from "@/config";
import * as config from "@/config";

/** The environment the resolver is handed; `undefined` means "not set". */
type Env = Readonly<Record<string, string | undefined>>;

/**
 * A parsed config — the resolver reads the materialized `chat.web` block, so every case goes
 * through `NaxConfigSchema.parse`, exactly as a loaded config would.
 *
 * `NaxConfigSchema.parse` widens `version` to `number`, and a test may not cast; `DEFAULT_CONFIG`
 * is the schema-derived `NaxConfig`, so the parsed `chat` block is grafted onto it. That block
 * carries the parsed `web` value either way, which is all the resolver reads.
 */
function parseConfig(web?: unknown): NaxConfig {
  const parsed = config.NaxConfigSchema.parse(web === undefined ? {} : { chat: { web } });
  return { ...config.DEFAULT_CONFIG, ...(parsed.chat === undefined ? {} : { chat: parsed.chat }) };
}

const NO_ENV: Env = {};

describe("DEFAULT_WEB_EXPOSED_DOMAINS", () => {
  test("AC-5: is the fourteen hosts, in order", () => {
    expect(DEFAULT_WEB_EXPOSED_DOMAINS).toEqual([
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
    ]);
  });
});

describe("resolveChatWebSettings — enabled and the unconfigured config", () => {
  test("AC-1: a parsed config with no chat.web resolves enabled false", () => {
    expect(resolveChatWebSettings(parseConfig(), NO_ENV).enabled).toBe(false);
  });

  test("AC-2: chat.web: { enabled: true } resolves enabled true", () => {
    expect(resolveChatWebSettings(parseConfig({ enabled: true }), NO_ENV).enabled).toBe(true);
  });

  test("AC-3: for that config search is undefined", () => {
    expect(resolveChatWebSettings(parseConfig({ enabled: true }), NO_ENV).search).toBeUndefined();
  });

  test("AC-4: for that config exposedAllowedDomains is the default list", () => {
    expect(resolveChatWebSettings(parseConfig({ enabled: true }), NO_ENV).exposedAllowedDomains).toEqual(
      DEFAULT_WEB_EXPOSED_DOMAINS,
    );
  });

  test("an unconfigured config resolves the fetch defaults and no missing key", () => {
    const settings = resolveChatWebSettings(parseConfig(), NO_ENV);
    expect(settings.fetch).toEqual({ maxBytes: 200_000, timeoutMs: 15_000 });
    expect(settings.missingKeyEnv).toBeUndefined();
  });

  test("the parsed fetch limits are passed through", () => {
    const settings = resolveChatWebSettings(parseConfig({ fetch: { maxBytes: 50_000, timeoutMs: 5_000 } }), NO_ENV);
    expect(settings.fetch).toEqual({ maxBytes: 50_000, timeoutMs: 5_000 });
  });
});

describe("resolveChatWebSettings — keyed search backends", () => {
  test("AC-6: tavily with TAVILY_API_KEY resolves search { id, apiKey }", () => {
    const settings = resolveChatWebSettings(parseConfig({ search: { backend: "tavily" } }), { TAVILY_API_KEY: "k" });
    expect(settings.search).toEqual({ id: "tavily", apiKey: "k" });
  });

  test("AC-7: for that config and env missingKeyEnv is undefined", () => {
    const settings = resolveChatWebSettings(parseConfig({ search: { backend: "tavily" } }), { TAVILY_API_KEY: "k" });
    expect(settings.missingKeyEnv).toBeUndefined();
  });

  test("AC-8: brave with no env resolves search undefined", () => {
    expect(resolveChatWebSettings(parseConfig({ search: { backend: "brave" } }), NO_ENV).search).toBeUndefined();
  });

  test("AC-9: for that config and env missingKeyEnv is BRAVE_SEARCH_API_KEY", () => {
    expect(resolveChatWebSettings(parseConfig({ search: { backend: "brave" } }), NO_ENV).missingKeyEnv).toBe(
      "BRAVE_SEARCH_API_KEY",
    );
  });

  test("AC-10: exa with an empty EXA_API_KEY resolves missingKeyEnv EXA_API_KEY", () => {
    expect(resolveChatWebSettings(parseConfig({ search: { backend: "exa" } }), { EXA_API_KEY: "" }).missingKeyEnv).toBe(
      "EXA_API_KEY",
    );
  });

  test("an empty EXA_API_KEY is not synthesized into an empty credential", () => {
    expect(
      resolveChatWebSettings(parseConfig({ search: { backend: "exa" } }), { EXA_API_KEY: "" }).search,
    ).toBeUndefined();
  });

  test("a key set for a different backend does not satisfy this one", () => {
    const settings = resolveChatWebSettings(parseConfig({ search: { backend: "tavily" } }), {
      BRAVE_SEARCH_API_KEY: "k",
    });
    expect(settings.search).toBeUndefined();
    expect(settings.missingKeyEnv).toBe("TAVILY_API_KEY");
  });

  test("the key is read from the env argument, never from the ambient environment", () => {
    const saved = process.env.TAVILY_API_KEY;
    process.env.TAVILY_API_KEY = "ambient";
    try {
      const settings = resolveChatWebSettings(parseConfig({ search: { backend: "tavily" } }), NO_ENV);
      expect(settings.search).toBeUndefined();
      expect(settings.missingKeyEnv).toBe("TAVILY_API_KEY");
    } finally {
      if (saved === undefined) delete process.env.TAVILY_API_KEY;
      else process.env.TAVILY_API_KEY = saved;
    }
  });
});

describe("resolveChatWebSettings — searxng", () => {
  test("AC-11: a searxng search resolves search { id, baseUrl }", () => {
    const settings = resolveChatWebSettings(
      parseConfig({ search: { backend: "searxng", searxngUrl: "http://search.example.lan:8080" } }),
      NO_ENV,
    );
    expect(settings.search).toEqual({ id: "searxng", baseUrl: "http://search.example.lan:8080" });
  });

  test("searxng needs no key, so no missingKeyEnv is reported", () => {
    const settings = resolveChatWebSettings(
      parseConfig({ search: { backend: "searxng", searxngUrl: "http://search.example.lan:8080" } }),
      NO_ENV,
    );
    expect(settings.missingKeyEnv).toBeUndefined();
  });
});

describe("resolveChatWebSettings — exposed allowlist and maxResults", () => {
  test("AC-12: a configured exposedAllowedDomains replaces the default list", () => {
    expect(
      resolveChatWebSettings(parseConfig({ exposedAllowedDomains: ["x.example"] }), NO_ENV).exposedAllowedDomains,
    ).toEqual(["x.example"]);
  });

  test("an explicitly empty exposedAllowedDomains stays empty rather than falling back", () => {
    expect(resolveChatWebSettings(parseConfig({ exposedAllowedDomains: [] }), NO_ENV).exposedAllowedDomains).toEqual(
      [],
    );
  });

  test("AC-13: maxResults is the parsed chat.web.search.maxResults", () => {
    expect(
      resolveChatWebSettings(parseConfig({ search: { backend: "tavily", maxResults: 3 } }), { TAVILY_API_KEY: "k" })
        .maxResults,
    ).toBe(3);
  });

  test("no search config resolves maxResults to the schema default", () => {
    expect(resolveChatWebSettings(parseConfig({ enabled: true }), NO_ENV).maxResults).toBe(
      config.DEFAULT_CHAT_WEB_MAX_RESULTS,
    );
  });
});
