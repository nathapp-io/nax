/**
 * US-001 — scanConfigSecrets: scans the root config and every mono config for
 * literal secrets, returning findings that never carry the flagged value.
 *
 * All fixtures are real files under a temp root; no process or network I/O.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { withTempDir } from "@test/helpers";
import { scanConfigSecrets } from "@/config";
import type { ConfigSecretFinding, ConfigSecretKind, ConfigSecretScan } from "@/config";

/** Write a raw config fixture at a repo-root-relative posix path. */
function writeConfig(root: string, rel: string, contents: string): void {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, contents);
}

/** Write a JSON config fixture at a repo-root-relative posix path. */
function writeJsonConfig(root: string, rel: string, value: unknown): void {
  writeConfig(root, rel, JSON.stringify(value));
}

/** Build an expected finding, exercising the exported finding/kind types. */
function finding(file: string, pointer: string, kind: ConfigSecretKind): ConfigSecretFinding {
  return { file, pointer, kind };
}

const ROOT_CONFIG = ".nax/config.json";

describe("scanConfigSecrets — files scanned", () => {
  test("AC1: resolves to a clean scan listing the root config when it is an empty object", async () => {
    await withTempDir(async (root) => {
      writeJsonConfig(root, ROOT_CONFIG, {});
      const expected: ConfigSecretScan = { clean: true, files: [ROOT_CONFIG], findings: [] };
      await expect(scanConfigSecrets(root)).resolves.toEqual(expected);
    });
  });

  test("AC1 boundary: an empty .nax/mono/ directory does not change the scan", async () => {
    await withTempDir(async (root) => {
      writeJsonConfig(root, ROOT_CONFIG, {});
      mkdirSync(join(root, ".nax", "mono"), { recursive: true });
      const expected: ConfigSecretScan = { clean: true, files: [ROOT_CONFIG], findings: [] };
      await expect(scanConfigSecrets(root)).resolves.toEqual(expected);
    });
  });

  test("AC2: resolves to an empty clean scan when the root has no .nax/config.json", async () => {
    await withTempDir(async (root) => {
      const expected: ConfigSecretScan = { clean: true, files: [], findings: [] };
      await expect(scanConfigSecrets(root)).resolves.toEqual(expected);
    });
  });

  test("AC2 boundary: an empty .nax directory with no config scans nothing", async () => {
    await withTempDir(async (root) => {
      mkdirSync(join(root, ".nax"), { recursive: true });
      const expected: ConfigSecretScan = { clean: true, files: [], findings: [] };
      await expect(scanConfigSecrets(root)).resolves.toEqual(expected);
    });
  });

  test("returns lexicographically sorted files, with findings grouped in that order", async () => {
    await withTempDir(async (root) => {
      writeJsonConfig(root, ROOT_CONFIG, {
        reporters: { webhook: { headers: { Authorization: "Bearer abc12345xyz" } } },
      });
      writeJsonConfig(root, ".nax/mono/apps/api/config.json", {
        quality: { commands: { test: "DATABASE_URL=postgres://u:p@localhost/db bun test" } },
      });
      writeJsonConfig(root, ".nax/mono/packages/app/config.json", {
        mcp: { servers: { x: { env: { GITHUB_TOKEN: "abc" } } } },
      });

      const scan = await scanConfigSecrets(root);

      expect(scan.files).toEqual([
        ".nax/config.json",
        ".nax/mono/apps/api/config.json",
        ".nax/mono/packages/app/config.json",
      ]);
      expect(scan.findings).toEqual([
        finding(".nax/config.json", "/reporters/webhook/headers/Authorization", "literal-header"),
        finding(".nax/mono/apps/api/config.json", "/quality/commands/test", "token-shape"),
        finding(".nax/mono/packages/app/config.json", "/mcp/servers/x/env/GITHUB_TOKEN", "secret-env"),
      ]);
    });
  });
});

describe("scanConfigSecrets — literal headers", () => {
  test("AC3: flags a literal Authorization header and reports clean: false", async () => {
    await withTempDir(async (root) => {
      writeJsonConfig(root, ROOT_CONFIG, {
        reporters: { webhook: { headers: { Authorization: "Bearer abc12345xyz" } } },
      });

      const scan = await scanConfigSecrets(root);

      expect(scan.clean).toBe(false);
      expect(scan.findings).toEqual([
        finding(ROOT_CONFIG, "/reporters/webhook/headers/Authorization", "literal-header"),
      ]);
    });
  });

  test("AC4: does not flag a Bearer header that references ${OPENROUTER_KEY}", async () => {
    await withTempDir(async (root) => {
      writeJsonConfig(root, ROOT_CONFIG, {
        reporters: { webhook: { headers: { Authorization: "Bearer ${OPENROUTER_KEY}" } } },
      });

      const scan = await scanConfigSecrets(root);

      expect(scan.clean).toBe(true);
      expect(scan.findings).toEqual([]);
    });
  });

  test("AC5: does not flag a header that is a bare $OPENROUTER_KEY reference", async () => {
    await withTempDir(async (root) => {
      writeJsonConfig(root, ROOT_CONFIG, {
        reporters: { webhook: { headers: { Authorization: "$OPENROUTER_KEY" } } },
      });

      const scan = await scanConfigSecrets(root);

      expect(scan.clean).toBe(true);
      expect(scan.findings).toEqual([]);
    });
  });

  test("AC6: does not flag the exempt HTTP-Referer header holding an ordinary URL", async () => {
    await withTempDir(async (root) => {
      writeJsonConfig(root, ROOT_CONFIG, {
        reporters: { webhook: { headers: { "HTTP-Referer": "https://example.com" } } },
      });

      const scan = await scanConfigSecrets(root);

      expect(scan.clean).toBe(true);
      expect(scan.findings).toEqual([]);
    });
  });

  test("AC10: prefers literal-header over token-shape for a headers Authorization value", async () => {
    await withTempDir(async (root) => {
      writeJsonConfig(root, ROOT_CONFIG, {
        reporters: { webhook: { headers: { Authorization: "sk-abcdefghijklmnopqrstu" } } },
      });

      const scan = await scanConfigSecrets(root);

      expect(scan.findings).toHaveLength(1);
      expect(scan.findings[0]).toEqual(
        finding(ROOT_CONFIG, "/reporters/webhook/headers/Authorization", "literal-header"),
      );
    });
  });

  test("AC15: flags a literal header inside catalogOverrides at index 0", async () => {
    await withTempDir(async (root) => {
      writeJsonConfig(root, ROOT_CONFIG, {
        agent: { native: { catalogOverrides: [{ headers: { Authorization: "Bearer abc12345xyz" } }] } },
      });

      const scan = await scanConfigSecrets(root);

      expect(scan.findings).toEqual([
        finding(ROOT_CONFIG, "/agent/native/catalogOverrides/0/headers/Authorization", "literal-header"),
      ]);
    });
  });

  test("AC14: escapes / in a pointer segment per RFC 6901", async () => {
    await withTempDir(async (root) => {
      writeJsonConfig(root, ROOT_CONFIG, {
        reporters: { webhook: { headers: { "X/Token": "abc12345xyz" } } },
      });

      const scan = await scanConfigSecrets(root);

      expect(scan.findings).toEqual([finding(ROOT_CONFIG, "/reporters/webhook/headers/X~1Token", "literal-header")]);
    });
  });

  test("AC14 boundary: escapes ~ in a pointer segment per RFC 6901", async () => {
    await withTempDir(async (root) => {
      writeJsonConfig(root, ROOT_CONFIG, {
        reporters: { webhook: { headers: { "X~Y": "abc12345xyz" } } },
      });

      const scan = await scanConfigSecrets(root);

      expect(scan.findings).toEqual([finding(ROOT_CONFIG, "/reporters/webhook/headers/X~0Y", "literal-header")]);
    });
  });

  test("flags a header value mixing a reference with a literal token as token-shape", async () => {
    await withTempDir(async (root) => {
      writeJsonConfig(root, ROOT_CONFIG, {
        reporters: { webhook: { headers: { Authorization: "Bearer ${KEY} sk-abcdefghijklmnopqrstu" } } },
      });

      const scan = await scanConfigSecrets(root);

      expect(scan.findings).toEqual([
        finding(ROOT_CONFIG, "/reporters/webhook/headers/Authorization", "token-shape"),
      ]);
    });
  });
});

describe("scanConfigSecrets — env secrets", () => {
  test("AC7: flags GITHUB_TOKEN under env as secret-env", async () => {
    await withTempDir(async (root) => {
      writeJsonConfig(root, ROOT_CONFIG, { mcp: { servers: { github: { env: { GITHUB_TOKEN: "abc" } } } } });

      const scan = await scanConfigSecrets(root);

      expect(scan.findings).toEqual([finding(ROOT_CONFIG, "/mcp/servers/github/env/GITHUB_TOKEN", "secret-env")]);
    });
  });

  test("AC8: does not flag NODE_ENV holding an ordinary value", async () => {
    await withTempDir(async (root) => {
      writeJsonConfig(root, ROOT_CONFIG, { models: { native: { fast: { env: { NODE_ENV: "test" } } } } });

      const scan = await scanConfigSecrets(root);

      expect(scan.clean).toBe(true);
      expect(scan.findings).toEqual([]);
    });
  });

  test("AC9: flags a token-shaped NODE_ENV value exactly once as secret-env", async () => {
    await withTempDir(async (root) => {
      writeJsonConfig(root, ROOT_CONFIG, {
        models: { native: { fast: { env: { NODE_ENV: "sk-abcdefghijklmnopqrstu" } } } },
      });

      const scan = await scanConfigSecrets(root);

      expect(scan.findings).toHaveLength(1);
      expect(scan.findings[0]).toEqual(finding(ROOT_CONFIG, "/models/native/fast/env/NODE_ENV", "secret-env"));
    });
  });
});

describe("scanConfigSecrets — token shapes outside headers/env", () => {
  test("AC11: flags a token-shaped quality command as token-shape", async () => {
    await withTempDir(async (root) => {
      writeJsonConfig(root, ROOT_CONFIG, {
        quality: { commands: { test: "DATABASE_URL=postgres://u:p@localhost/db bun test" } },
      });

      const scan = await scanConfigSecrets(root);

      expect(scan.findings).toEqual([finding(ROOT_CONFIG, "/quality/commands/test", "token-shape")]);
    });
  });

  test("AC12: does not flag ordinary quality commands", async () => {
    await withTempDir(async (root) => {
      writeJsonConfig(root, ROOT_CONFIG, {
        quality: { commands: { test: "bun run test", testScoped: "bunx vitest run {{files}}" } },
      });

      const scan = await scanConfigSecrets(root);

      expect(scan.clean).toBe(true);
      expect(scan.findings).toEqual([]);
    });
  });

  test("AC12 boundary: does not flag an ordinary non-secret string outside headers/env", async () => {
    await withTempDir(async (root) => {
      writeJsonConfig(root, ROOT_CONFIG, { project: { name: "my-app" } });

      const scan = await scanConfigSecrets(root);

      expect(scan.clean).toBe(true);
      expect(scan.findings).toEqual([]);
    });
  });

  test("AC13: flags the token-shaped array element of mcp.servers.x.args", async () => {
    await withTempDir(async (root) => {
      writeJsonConfig(root, ROOT_CONFIG, {
        mcp: { servers: { x: { args: ["--token", "ghp_abcdefghijklmnopqrstuvwx"] } } },
      });

      const scan = await scanConfigSecrets(root);

      expect(scan.findings).toHaveLength(1);
      expect(scan.findings[0]).toEqual(finding(ROOT_CONFIG, "/mcp/servers/x/args/1", "token-shape"));
    });
  });
});

describe("scanConfigSecrets — mono configs", () => {
  test("AC16: reports a token-shape finding in a nested mono config", async () => {
    await withTempDir(async (root) => {
      writeJsonConfig(root, ".nax/mono/packages/app/config.json", {
        quality: { commands: { test: "DATABASE_URL=postgres://u:p@localhost/db bun test" } },
      });

      const scan = await scanConfigSecrets(root);

      expect(scan.clean).toBe(false);
      expect(scan.files).toEqual([".nax/mono/packages/app/config.json"]);
      expect(scan.findings).toEqual([
        finding(".nax/mono/packages/app/config.json", "/quality/commands/test", "token-shape"),
      ]);
    });
  });

  test("AC16 boundary: reports a token-shape finding in a single-segment mono config", async () => {
    await withTempDir(async (root) => {
      writeJsonConfig(root, ".nax/mono/api/config.json", {
        quality: { commands: { test: "DATABASE_URL=postgres://u:p@localhost/db bun test" } },
      });

      const scan = await scanConfigSecrets(root);

      expect(scan.findings).toEqual([finding(".nax/mono/api/config.json", "/quality/commands/test", "token-shape")]);
    });
  });

  test("AC17: ignores .nax/mono/config.json — no directory segment between mono/ and config.json", async () => {
    await withTempDir(async (root) => {
      writeJsonConfig(root, ".nax/mono/config.json", {
        quality: { commands: { test: "DATABASE_URL=postgres://u:p@localhost/db bun test" } },
      });

      const scan = await scanConfigSecrets(root);

      expect(scan.clean).toBe(true);
      expect(scan.files).toEqual([]);
      expect(scan.findings).toEqual([]);
    });
  });
});

describe("scanConfigSecrets — unscannable configs", () => {
  test("AC18: reports unscannable for a root config that is not valid JSON", async () => {
    await withTempDir(async (root) => {
      writeConfig(root, ROOT_CONFIG, "not json");

      const scan = await scanConfigSecrets(root);

      expect(scan.clean).toBe(false);
      expect(scan.files).toEqual([ROOT_CONFIG]);
      expect(scan.findings).toEqual([finding(ROOT_CONFIG, "", "unscannable")]);
    });
  });

  test("AC19: reports unscannable when the top-level JSON value is a string", async () => {
    await withTempDir(async (root) => {
      writeJsonConfig(root, ROOT_CONFIG, "sk-abcdefghijklmnopqrstu");

      const scan = await scanConfigSecrets(root);

      expect(scan.clean).toBe(false);
      expect(scan.findings).toEqual([finding(ROOT_CONFIG, "", "unscannable")]);
    });
  });

  test("AC19 boundary: reports unscannable when the top-level JSON value is an array", async () => {
    await withTempDir(async (root) => {
      writeJsonConfig(root, ROOT_CONFIG, ["sk-abcdefghijklmnopqrstu"]);

      const scan = await scanConfigSecrets(root);

      expect(scan.clean).toBe(false);
      expect(scan.findings).toEqual([finding(ROOT_CONFIG, "", "unscannable")]);
    });
  });

  test("AC20: still reports a readable mono config's finding when the root config is invalid", async () => {
    await withTempDir(async (root) => {
      writeConfig(root, ROOT_CONFIG, "not json");
      writeJsonConfig(root, ".nax/mono/apps/api/config.json", {
        quality: { commands: { test: "DATABASE_URL=postgres://u:p@localhost/db bun test" } },
      });

      const scan = await scanConfigSecrets(root);

      expect(scan.files).toEqual([ROOT_CONFIG, ".nax/mono/apps/api/config.json"]);
      expect(scan.findings).toEqual([
        finding(ROOT_CONFIG, "", "unscannable"),
        finding(".nax/mono/apps/api/config.json", "/quality/commands/test", "token-shape"),
      ]);
    });
  });
});

describe("scanConfigSecrets — never returns the secret value", () => {
  test("AC21: the JSON serialisation of the scan omits the flagged value", async () => {
    await withTempDir(async (root) => {
      writeJsonConfig(root, ROOT_CONFIG, {
        reporters: { webhook: { headers: { Authorization: "Bearer abc12345xyz" } } },
      });

      const scan = await scanConfigSecrets(root);

      expect(JSON.stringify(scan)).not.toContain("abc12345xyz");
    });
  });

  test("AC21 boundary: the serialisation of an unscannable scan omits the file's secret-shaped contents", async () => {
    await withTempDir(async (root) => {
      writeJsonConfig(root, ROOT_CONFIG, "sk-abcdefghijklmnopqrstu");

      const scan = await scanConfigSecrets(root);

      expect(JSON.stringify(scan)).not.toContain("sk-abcdefghijklmnopqrstu");
    });
  });
});
