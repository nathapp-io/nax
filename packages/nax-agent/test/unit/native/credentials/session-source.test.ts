import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  _resetCredentialsConfig,
  type CredentialsConfig,
  configureCredentials,
  credentialsConfig,
} from "#src/infra/index";
import { createSessionCredentialStore } from "#src/native/credentials/session-source";
import { cleanupTempDir, makeTempDir } from "#test/helpers/index";

/**
 * The credentials slot is process-global and the preload filled it. Save what
 * was there and put it back after each test, so a test that clears the slot
 * leaves the module as it found it for the suites that rely on the preload's
 * slot (S2-3b pattern).
 */
let dir: string;
let savedCredentials: CredentialsConfig | undefined;
let credentialsWasConfigured = false;
const originalGlobalDir = process.env.NAX_GLOBAL_CONFIG_DIR;

beforeEach(() => {
  try {
    savedCredentials = credentialsConfig();
    credentialsWasConfigured = true;
  } catch {
    credentialsWasConfigured = false;
  }

  dir = makeTempDir("nax-session-source-");
  process.env.NAX_GLOBAL_CONFIG_DIR = dir;
});

afterEach(() => {
  process.env.NAX_GLOBAL_CONFIG_DIR = originalGlobalDir;
  if (credentialsWasConfigured && savedCredentials !== undefined) configureCredentials(savedCredentials);
  else _resetCredentialsConfig();
  cleanupTempDir(dir);
});

describe("createSessionCredentialStore", () => {
  test("memory source serves its credential and stamps source memory without the slot", async () => {
    _resetCredentialsConfig();
    const store = createSessionCredentialStore({
      kind: "memory",
      credentials: { anthropic: { kind: "api-key", key: "sk-test" } },
    });
    expect(await store.read("anthropic")).toEqual({ kind: "api-key", key: "sk-test" });
    const stamp = store.servedAuth("anthropic");
    expect(stamp?.source).toBe("memory");
    expect(stamp?.fingerprint).toMatch(/^[0-9a-f]{12}$/);
  });

  test("memory source declines an unknown provider", async () => {
    const store = createSessionCredentialStore({ kind: "memory", credentials: {} });
    expect(await store.read("openai")).toBeUndefined();
  });

  test("two memory stores fingerprint the same key with different salts", async () => {
    const creds = { anthropic: { kind: "api-key" as const, key: "same" } };
    const a = createSessionCredentialStore({ kind: "memory", credentials: creds });
    const b = createSessionCredentialStore({ kind: "memory", credentials: creds });
    await a.read("anthropic");
    await b.read("anthropic");
    expect(a.servedAuth("anthropic")?.fingerprint).not.toBe(b.servedAuth("anthropic")?.fingerprint);
  });

  test("exec source serves a helper credential and stamps source exec with the account label", async () => {
    const script = join(dir, "fake-helper.sh");
    const reply = JSON.stringify({
      version: 1,
      kind: "api-key",
      key: "HELPER-KEY",
      account: "koda:proj-42/anthropic-team",
    });
    writeFileSync(script, ["#!/bin/sh", "cat >/dev/null", `printf '%s' '${reply}'`, "exit 0"].join("\n") + "\n");
    chmodSync(script, 0o755);
    _resetCredentialsConfig();

    const store = createSessionCredentialStore({ kind: "exec", command: [script] });

    expect(await store.read("anthropic")).toEqual({ kind: "api-key", key: "HELPER-KEY" });
    const stamp = store.servedAuth("anthropic");
    expect(stamp?.source).toBe("exec");
    expect(stamp?.account).toBe("koda:proj-42/anthropic-team");
  });
});
