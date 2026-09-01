import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import {
  _resetCredentialStore,
  credentialFilePath,
  naxCredentialStore,
  readStoredEntries,
} from "@/agents/native/credentials";

let dir: string;
const originalGlobalDir = process.env.NAX_GLOBAL_CONFIG_DIR;

beforeEach(() => {
  dir = makeTempDir("nax-creds-");
  process.env.NAX_GLOBAL_CONFIG_DIR = dir;
  _resetCredentialStore();
});

afterEach(() => {
  process.env.NAX_GLOBAL_CONFIG_DIR = originalGlobalDir;
  _resetCredentialStore();
  cleanupTempDir(dir);
});

describe("credentialFilePath", () => {
  test("sits under the global config dir", () => {
    expect(credentialFilePath()).toBe(join(dir, "credentials"));
  });
});

describe("naxCredentialStore", () => {
  test("returns the same instance across calls", () => {
    expect(naxCredentialStore()).toBe(naxCredentialStore());
  });

  test("round-trips a credential through the real file store", async () => {
    await naxCredentialStore().modify("openrouter", async () => ({ kind: "api-key", key: "sk-test" }));
    const read = await naxCredentialStore().read("openrouter");
    expect(read).toEqual({ kind: "api-key", key: "sk-test" });
  });
});

describe("readStoredEntries", () => {
  test("is empty when no credential file exists", async () => {
    expect(await readStoredEntries()).toEqual([]);
  });

  test("reports provider, kind and OAuth expiry, sorted by provider", async () => {
    await naxCredentialStore().modify("openrouter", async () => ({ kind: "api-key", key: "sk-test" }));
    await naxCredentialStore().modify("openai-codex", async () => ({
      kind: "oauth",
      access: "a",
      refresh: "r",
      expires: 1789038325059,
    }));

    expect(await readStoredEntries()).toEqual([
      { providerId: "openai-codex", kind: "oauth", expires: 1789038325059 },
      { providerId: "openrouter", kind: "api-key" },
    ]);
  });

  test("throws rather than reporting empty when the file is unparseable", async () => {
    writeFileSync(credentialFilePath(), "{ not json");
    await expect(readStoredEntries()).rejects.toThrow(/could not be parsed/);
  });

  test("throws the crafted message rather than a raw TypeError when credentials is null", async () => {
    writeFileSync(credentialFilePath(), JSON.stringify({ credentials: null }));
    await expect(readStoredEntries()).rejects.toThrow(/could not be parsed/);
  });
});
