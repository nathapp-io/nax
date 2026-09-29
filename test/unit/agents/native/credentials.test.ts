import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertNaxError, cleanupTempDir, makeTempDir } from "@test/helpers";
import {
  _resetCredentialStore,
  credentialFilePath,
  naxCredentialStore,
  readStoredEntries,
  servedAuth,
} from "@/agents/native/credentials";
import type { NaxError } from "@/errors";

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

/**
 * `run` is expected to reject with a NaxError; returns the caught error so the
 * test can assert its shape (code, context) rather than only its message.
 */
async function caughtNaxError(run: () => Promise<unknown>): Promise<NaxError> {
  try {
    await run();
  } catch (err) {
    assertNaxError(err, "readStoredEntries rejection");
    return err;
  }
  throw new Error("expected readStoredEntries to reject, but it resolved");
}

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

  test("throws CREDENTIAL_FILE_UNREADABLE rather than reporting empty when the file is unparseable", async () => {
    writeFileSync(credentialFilePath(), "{ not json");

    const err = await caughtNaxError(() => readStoredEntries());

    expect(err.message).toMatch(/could not be parsed/);
    expect(err.code).toBe("CREDENTIAL_FILE_UNREADABLE");
    // error-handling.md: every NaxError context carries a stage, so stage-based
    // triage can see this site. Same stage as the chained store's identical code.
    expect(err.context?.stage).toBe("credentials");
  });

  test("throws CREDENTIAL_FILE_UNREADABLE rather than a raw TypeError when credentials is null", async () => {
    writeFileSync(credentialFilePath(), JSON.stringify({ credentials: null }));

    const err = await caughtNaxError(() => readStoredEntries());

    expect(err.message).toMatch(/could not be parsed/);
    expect(err.code).toBe("CREDENTIAL_FILE_UNREADABLE");
    expect(err.context?.stage).toBe("credentials");
  });

  test("throws CREDENTIAL_FILE_UNREADABLE when credentials is not an object", async () => {
    writeFileSync(credentialFilePath(), JSON.stringify({ credentials: [] }));

    const err = await caughtNaxError(() => readStoredEntries());

    expect(err.message).toMatch(/could not be parsed/);
    expect(err.code).toBe("CREDENTIAL_FILE_UNREADABLE");
    expect(err.context?.stage).toBe("credentials");
  });
});

/**
 * US-004 — the assembled store and the module-level stamp.
 *
 * `naxCredentialStore()` now returns `guard(chained(exec?, file))`, and
 * `servedAuth(providerId)` delegates to that memoised store. The assembly must
 * pass a `describe` that reports `sourceOf`/`accountOf`, so a helper's account
 * label reaches the stamp the cost row reads.
 */
describe("servedAuth (US-004)", () => {
  function writeExecConfig(helper: string): void {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ auth: { source: "exec", exec: { command: [helper] } } }));
  }

  function writeHelper(reply: string): string {
    const script = join(dir, "helper.sh");
    writeFileSync(script, `#!/bin/sh\ncat > /dev/null\nprintf '%s' '${reply}'\n`);
    chmodSync(script, 0o755);
    return script;
  }

  test('AC11: after a store read served by the helper, servedAuth reports source "exec" and the account', async () => {
    const helper = writeHelper(JSON.stringify({ version: 1, kind: "api-key", key: "HELPER-KEY", account: "team-a" }));
    writeExecConfig(helper);
    _resetCredentialStore();

    await naxCredentialStore().read("anthropic");

    expect(servedAuth("anthropic")).toMatchObject({ source: "exec", account: "team-a" });
  });

  test("AC11 boundary: servedAuth is undefined for a provider the store never read", () => {
    expect(servedAuth("anthropic")).toBeUndefined();
  });

  test('AC11 boundary: a file-served provider is stamped source "file" with no account', async () => {
    await naxCredentialStore().modify("openrouter", async () => ({ kind: "api-key", key: "sk-file" }));

    await naxCredentialStore().read("openrouter");

    expect(servedAuth("openrouter")).toMatchObject({ source: "file" });
    expect(servedAuth("openrouter")?.account).toBeUndefined();
  });
});
