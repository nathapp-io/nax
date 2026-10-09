import { describe, expect, test } from "bun:test";
import type { ParsedServer } from "#src/server/mcp/parse";
import { mcpSecrets, scrubber } from "#src/server/mcp/secrets";

const servers: ParsedServer[] = [
  { kind: "stdio", name: "a", command: "c", args: [], env: { GITHUB_TOKEN: "ghp-secret-value-1", MODE: "production" } },
  {
    kind: "http",
    name: "b",
    url: "https://user:url-password-2@h.example/mcp?key=query-secret-3&v=1",
    headers: { Authorization: "Bearer bearer-token-4", "X-Api-Key": "header-secret-5" },
  },
];

describe("mcpSecrets", () => {
  test("collects secret-named env values, header values, bearer tokens, url password and query values", () => {
    const secrets = mcpSecrets(servers);
    for (const s of [
      "ghp-secret-value-1",
      "url-password-2",
      "query-secret-3",
      "Bearer bearer-token-4",
      "bearer-token-4",
      "header-secret-5",
    ])
      expect(secrets).toContain(s);
    expect(secrets).not.toContain("production"); // MODE is not a secret-named key
  });

  test("a url that cannot be parsed contributes no secrets", () => {
    expect(mcpSecrets([{ kind: "http", name: "bad", url: "not a url", headers: {} }])).toEqual([]);
  });

  test("a url password with malformed percent-encoding is kept verbatim", () => {
    const secrets = mcpSecrets([{ kind: "http", name: "bad", url: "https://u:%zzzzzzzz@h/x", headers: {} }]);
    expect(secrets).toEqual(["%zzzzzzzz"]);
  });

  test("a url with no password still contributes its query values", () => {
    const secrets = mcpSecrets([{ kind: "http", name: "q", url: "https://h/x?key=query-secret-3", headers: {} }]);
    expect(secrets).toEqual(["query-secret-3"]);
  });
});

describe("scrubber", () => {
  test("replaces every collected value; ignores values shorter than 8", () => {
    const scrub = scrubber([...mcpSecrets(servers), "short"]);
    const text =
      "failed GET https://user:url-password-2@h.example/mcp?key=query-secret-3 with bearer-token-4 and header-secret-5 ghp-secret-value-1 short";
    const out = scrub(text);
    for (const s of ["url-password-2", "query-secret-3", "bearer-token-4", "header-secret-5", "ghp-secret-value-1"])
      expect(out).not.toContain(s);
    expect(out).toContain("short");
  });
});
