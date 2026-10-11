/**
 * US-002 — checkConfigSecrets: surfaces the config-secret scanner as a Tier-2
 * precheck warning, naming the offending pointer and never echoing the value.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { _configSecretsCheckDeps, checkConfigSecrets } from "@/precheck";

const LITERAL_AUTHORIZATION_HEADER = {
  reporters: { webhook: { headers: { Authorization: "Bearer abc12345xyz" } } },
};

/** Write a JSON config fixture at a root-relative posix path. */
function writeConfig(root: string, rel: string, value: unknown): void {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, JSON.stringify(value));
}

describe("checkConfigSecrets", () => {
  let root: string;
  let originalScanConfigSecrets: typeof _configSecretsCheckDeps.scanConfigSecrets;

  beforeEach(() => {
    root = makeTempDir("nax-config-secrets-check-");
    originalScanConfigSecrets = _configSecretsCheckDeps.scanConfigSecrets;
  });

  afterEach(() => {
    _configSecretsCheckDeps.scanConfigSecrets = originalScanConfigSecrets;
    cleanupTempDir(root);
  });

  test("AC1: returns a passing warning check for an empty root config", async () => {
    writeConfig(root, ".nax/config.json", {});

    const result = await checkConfigSecrets(root);

    expect(result.name).toBe("config-secrets");
    expect(result.tier).toBe("warning");
    expect(result.passed).toBe(true);
    expect(typeof result.message).toBe("string");
  });

  test("AC1 boundary: passes when the root has no .nax/config.json at all", async () => {
    const result = await checkConfigSecrets(root);

    expect(result.name).toBe("config-secrets");
    expect(result.tier).toBe("warning");
    expect(result.passed).toBe(true);
  });

  test("AC2: fails naming the offending pointer when a header holds a literal value", async () => {
    writeConfig(root, ".nax/config.json", LITERAL_AUTHORIZATION_HEADER);

    const result = await checkConfigSecrets(root);

    expect(result.name).toBe("config-secrets");
    expect(result.passed).toBe(false);
    expect(result.message).toContain("/reporters/webhook/headers/Authorization");
  });

  test("AC2 boundary: passes when the header defers to an environment-variable reference", async () => {
    writeConfig(root, ".nax/config.json", {
      reporters: { webhook: { headers: { Authorization: "Bearer \u0024{OPENROUTER_KEY}" } } },
    });

    const result = await checkConfigSecrets(root);

    expect(result.passed).toBe(true);
  });

  test("AC3: the failure message omits the flagged literal value", async () => {
    writeConfig(root, ".nax/config.json", LITERAL_AUTHORIZATION_HEADER);

    const result = await checkConfigSecrets(root);

    expect(result.passed).toBe(false);
    expect(result.message).not.toContain("abc12345xyz");
    expect(JSON.stringify(result)).not.toContain("abc12345xyz");
  });

  test("AC3 boundary: the failure message omits a token-shaped command value", async () => {
    writeConfig(root, ".nax/config.json", {
      quality: { commands: { test: "DATABASE_URL=postgres://u:p@localhost/db bun test" } },
    });

    const result = await checkConfigSecrets(root);

    expect(result.passed).toBe(false);
    expect(result.message).not.toContain("postgres://u:p@localhost/db");
  });

  test("unscannable configs report that the file could not be read or parsed", async () => {
    _configSecretsCheckDeps.scanConfigSecrets = async () => ({
      clean: false,
      files: [],
      findings: [{ file: ".nax/config.json", pointer: "", kind: "unscannable" }],
    });

    const result = await checkConfigSecrets(root);

    expect(result.passed).toBe(false);
    expect(result.message).toContain("could not be read or parsed");
    expect(result.message).not.toContain("Move the value");
  });

  test("AC4: fails with a could-not-scan message when the scanner rejects", async () => {
    _configSecretsCheckDeps.scanConfigSecrets = async () => {
      throw new Error("EACCES: permission denied");
    };

    const result = await checkConfigSecrets(root);

    expect(result.name).toBe("config-secrets");
    expect(result.tier).toBe("warning");
    expect(result.passed).toBe(false);
    expect(result.message.toLowerCase()).toContain("could not scan");
  });

  test("AC4 boundary: fails closed when the scanner rejects with a non-Error type", async () => {
    _configSecretsCheckDeps.scanConfigSecrets = async () => {
      throw new TypeError("scanner exploded");
    };

    const result = await checkConfigSecrets(root);

    expect(result.name).toBe("config-secrets");
    expect(result.passed).toBe(false);
    expect(result.message.toLowerCase()).toContain("could not scan");
  });
});
