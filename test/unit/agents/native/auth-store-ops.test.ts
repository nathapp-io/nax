import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  _authDeps,
  ambientShadows,
  importPiCredentials,
  listStoredProviders,
  removeStoredProvider,
} from "@/agents/native/auth";
import { _resetCredentialStore, naxCredentialStore } from "@/agents/native/credentials";

let dir: string;
let piPath: string;
const realAmbient = _authDeps.ambientAuthAvailable;
const originalGlobalDir = process.env.NAX_GLOBAL_CONFIG_DIR;

const PI_FILE = {
  "opencode-go": { type: "api_key", key: "sk-opencode" },
  "openai-codex": { type: "oauth", access: "a", refresh: "r", expires: 1789038325059, accountId: "acct-1" },
  weird: { type: "smoke-signal", key: "nope" },
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nax-import-"));
  process.env.NAX_GLOBAL_CONFIG_DIR = dir;
  piPath = join(dir, "pi-auth.json");
  writeFileSync(piPath, JSON.stringify(PI_FILE));
  _resetCredentialStore();
});

afterEach(() => {
  _authDeps.ambientAuthAvailable = realAmbient;
  process.env.NAX_GLOBAL_CONFIG_DIR = originalGlobalDir;
  _resetCredentialStore();
});

describe("importPiCredentials", () => {
  test("translates type to kind and the flat file into the store", async () => {
    const outcomes = await importPiCredentials({ from: piPath });

    expect(outcomes).toEqual([
      { providerId: "openai-codex", status: "imported" },
      { providerId: "opencode-go", status: "imported" },
      { providerId: "weird", status: "unsupported" },
    ]);
    expect(await naxCredentialStore().read("opencode-go")).toEqual({ kind: "api-key", key: "sk-opencode" });
  });

  test("drops accountId, which pi derives from the token rather than storing authoritatively", async () => {
    await importPiCredentials({ from: piPath });
    expect(await naxCredentialStore().read("openai-codex")).toEqual({
      kind: "oauth",
      access: "a",
      refresh: "r",
      expires: 1789038325059,
    });
  });

  test("skips an existing credential rather than overwriting it", async () => {
    await naxCredentialStore().modify("opencode-go", async () => ({ kind: "api-key", key: "sk-fresh" }));
    const outcomes = await importPiCredentials({ from: piPath });

    expect(outcomes).toContainEqual({ providerId: "opencode-go", status: "skipped" });
    expect(await naxCredentialStore().read("opencode-go")).toEqual({ kind: "api-key", key: "sk-fresh" });
  });

  test("overwrites when forced", async () => {
    await naxCredentialStore().modify("opencode-go", async () => ({ kind: "api-key", key: "sk-fresh" }));
    await importPiCredentials({ from: piPath, force: true });
    expect(await naxCredentialStore().read("opencode-go")).toEqual({ kind: "api-key", key: "sk-opencode" });
  });

  test("reports a missing source file as AUTH_IMPORT_SOURCE_MISSING", async () => {
    await expect(importPiCredentials({ from: join(dir, "absent.json") })).rejects.toMatchObject({
      code: "AUTH_IMPORT_SOURCE_MISSING",
    });
  });
});

describe("listStoredProviders", () => {
  test("reports what the store holds", async () => {
    await importPiCredentials({ from: piPath });
    expect(await listStoredProviders()).toEqual([
      { providerId: "openai-codex", kind: "oauth", expires: 1789038325059 },
      { providerId: "opencode-go", kind: "api-key" },
    ]);
  });
});

describe("removeStoredProvider", () => {
  test("deletes the credential", async () => {
    await importPiCredentials({ from: piPath });
    await removeStoredProvider("opencode-go");
    expect(await naxCredentialStore().read("opencode-go")).toBeUndefined();
  });
});

describe("ambientShadows", () => {
  test("names only the providers whose ambient auth would also resolve", async () => {
    _authDeps.ambientAuthAvailable = mock(async (id: string) => id === "openrouter");
    expect(await ambientShadows(["openrouter", "opencode-go"])).toEqual(["openrouter"]);
  });

  test("reports nothing rather than throwing when the probe fails", async () => {
    _authDeps.ambientAuthAvailable = mock(async () => {
      throw new Error("probe exploded");
    });
    expect(await ambientShadows(["openrouter"])).toEqual([]);
  });
});
