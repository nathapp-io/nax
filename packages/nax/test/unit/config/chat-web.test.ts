import { describe, expect, test } from "bun:test";
import type { ChatWebConfig } from "@/config";
import * as config from "@/config";

/** Every issue path a rejected config reports, dotted — the shape the operator sees. */
function issuePaths(input: unknown): string[] {
  const parsed = config.NaxConfigSchema.safeParse(input);
  return parsed.success ? [] : parsed.error.issues.map((issue) => issue.path.join("."));
}

function expectRejectedAt(input: unknown, path: string): void {
  expect(issuePaths(input)).toContain(path);
}

/** Parse `{ chat: { web } }` and hand back the resolved web block. */
function parseWeb(web: unknown): ChatWebConfig | undefined {
  return config.NaxConfigSchema.parse({ chat: { web } }).chat?.web;
}

describe("NaxConfigSchema chat.web", () => {
  test("AC-1: a config with no chat.web parses, and chat.web stays undefined", () => {
    expect(config.NaxConfigSchema.safeParse({}).success).toBe(true);
    expect(config.NaxConfigSchema.parse({ chat: {} }).chat?.web).toBeUndefined();
  });

  test("AC-2: chat.web.enabled true is kept", () => {
    expect(parseWeb({ enabled: true })?.enabled).toBe(true);
  });

  test("AC-3: an empty chat.web resolves enabled to false", () => {
    expect(parseWeb({})?.enabled).toBe(false);
  });

  test("AC-4: chat.web.fetch defaults to 200000 bytes and 15000 ms", () => {
    expect(parseWeb({ enabled: true })?.fetch).toEqual({ maxBytes: 200_000, timeoutMs: 15_000 });
  });

  test("AC-5: a tavily search resolves maxResults to 8", () => {
    expect(parseWeb({ search: { backend: "tavily" } })?.search?.maxResults).toBe(8);
  });

  test("AC-6: a searxng search with no searxngUrl is rejected at chat.web.search.searxngUrl", () => {
    expectRejectedAt({ chat: { web: { search: { backend: "searxng" } } } }, "chat.web.search.searxngUrl");
  });

  test("AC-7: a non-http searxngUrl is rejected at chat.web.search.searxngUrl", () => {
    expectRejectedAt(
      { chat: { web: { search: { backend: "searxng", searxngUrl: "file:///x" } } } },
      "chat.web.search.searxngUrl",
    );
  });

  test("AC-8: an unknown backend is rejected at chat.web.search.backend", () => {
    expectRejectedAt({ chat: { web: { search: { backend: "google" } } } }, "chat.web.search.backend");
  });

  test("AC-9: maxResults 21 is rejected at chat.web.search.maxResults", () => {
    expectRejectedAt(
      { chat: { web: { search: { backend: "tavily", maxResults: 21 } } } },
      "chat.web.search.maxResults",
    );
  });

  test("AC-10: maxResults 0 is rejected at chat.web.search.maxResults", () => {
    expectRejectedAt({ chat: { web: { search: { backend: "tavily", maxResults: 0 } } } }, "chat.web.search.maxResults");
  });

  test("AC-11: fetch.maxBytes 999 is rejected at chat.web.fetch.maxBytes", () => {
    expectRejectedAt({ chat: { web: { fetch: { maxBytes: 999 } } } }, "chat.web.fetch.maxBytes");
  });

  test("AC-12: fetch.maxBytes 5000001 is rejected at chat.web.fetch.maxBytes", () => {
    expectRejectedAt({ chat: { web: { fetch: { maxBytes: 5_000_001 } } } }, "chat.web.fetch.maxBytes");
  });

  test("AC-13: fetch.timeoutMs 999 is rejected at chat.web.fetch.timeoutMs", () => {
    expectRejectedAt({ chat: { web: { fetch: { timeoutMs: 999 } } } }, "chat.web.fetch.timeoutMs");
  });

  test("AC-14: fetch.timeoutMs 60001 is rejected at chat.web.fetch.timeoutMs", () => {
    expectRejectedAt({ chat: { web: { fetch: { timeoutMs: 60_001 } } } }, "chat.web.fetch.timeoutMs");
  });

  test("AC-15: exposedAllowedDomains is kept as the list given", () => {
    expect(parseWeb({ exposedAllowedDomains: ["x.example"] })?.exposedAllowedDomains).toEqual(["x.example"]);
  });

  test("AC-16: parse({}) leaves chat undefined, so web defaults are not materialized everywhere", () => {
    expect(Object.hasOwn(config.NaxConfigSchema.parse({}), "chat")).toBe(false);
  });

  test("AC-17: an existing chat workflow/compaction config without web keeps its values", () => {
    const parsed = config.NaxConfigSchema.parse({
      chat: {
        workflow: { plan: { profiles: ["codex-plan"] }, specFixRounds: 3 },
        compaction: { compactAtTokens: 250_000, idleCompactAfterMinutes: 30 },
      },
    });
    expect(parsed.chat?.workflow?.plan?.profiles).toEqual(["codex-plan"]);
    expect(parsed.chat?.workflow?.specFixRounds).toBe(3);
    expect(parsed.chat?.compaction).toEqual({ compactAtTokens: 250_000, idleCompactAfterMinutes: 30 });
    expect(parsed.chat?.web).toBeUndefined();
  });

  test("the chat web defaults and ChatWebConfig are exported from the config surface", () => {
    const web: ChatWebConfig = {
      enabled: true,
      search: { backend: "searxng", searxngUrl: "http://search.example.lan:8080", maxResults: 4 },
      fetch: { maxBytes: config.DEFAULT_CHAT_WEB_FETCH_MAX_BYTES, timeoutMs: config.DEFAULT_CHAT_WEB_FETCH_TIMEOUT_MS },
      exposedAllowedDomains: ["registry.npmjs.org"],
    };
    expect(config.DEFAULT_CHAT_WEB_MAX_RESULTS).toBe(8);
    expect(config.NaxConfigSchema.parse({ chat: { web } }).chat?.web).toEqual(web);
  });

  test("an https searxngUrl that a search declares is kept", () => {
    const parsed = parseWeb({ search: { backend: "searxng", searxngUrl: "https://search.example.lan" } });
    expect(parsed?.search?.searxngUrl).toBe("https://search.example.lan");
  });

  test("a searxngUrl that is not a URL at all is rejected at chat.web.search.searxngUrl", () => {
    // Not a parsing exception: `safeParse` reports an issue at the key the operator must fix.
    expectRejectedAt(
      { chat: { web: { search: { backend: "searxng", searxngUrl: "search.example.lan" } } } },
      "chat.web.search.searxngUrl",
    );
  });
});
