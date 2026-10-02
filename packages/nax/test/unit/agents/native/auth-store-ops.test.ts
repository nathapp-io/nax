import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  _authDeps,
  _resetCredentialStore,
  ambientShadows,
  credentialFilePath,
  importPiCredentials,
  listStoredProviders,
  naxCredentialStore,
  providersWithoutCredentials,
  removeStoredProvider,
} from "@nathapp/nax-agent/internal";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { addSink, initLogger, type LogEntry, resetLogger } from "@/logger";

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
  dir = makeTempDir("nax-import-");
  process.env.NAX_GLOBAL_CONFIG_DIR = dir;
  piPath = join(dir, "pi-auth.json");
  writeFileSync(piPath, JSON.stringify(PI_FILE));
  _resetCredentialStore();
});

afterEach(() => {
  _authDeps.ambientAuthAvailable = realAmbient;
  process.env.NAX_GLOBAL_CONFIG_DIR = originalGlobalDir;
  _resetCredentialStore();
  cleanupTempDir(dir);
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

describe("providersWithoutCredentials", () => {
  test("names a provider with neither a stored nor an ambient credential", async () => {
    await importPiCredentials({ from: piPath });
    _authDeps.ambientAuthAvailable = mock(async (id: string) => id === "openrouter");
    expect(await providersWithoutCredentials(["anthropic", "opencode-go", "openrouter"])).toEqual(["anthropic"]);
  });

  test("a stored credential covers its provider without probing ambient auth", async () => {
    await importPiCredentials({ from: piPath });
    const probe = mock(async () => false);
    _authDeps.ambientAuthAvailable = probe;
    expect(await providersWithoutCredentials(["opencode-go"])).toEqual([]);
    expect(probe).not.toHaveBeenCalled();
  });

  test("a probe that throws counts as credentialed: the check must not guess no", async () => {
    _authDeps.ambientAuthAvailable = mock(async () => {
      throw new Error("probe exploded");
    });
    expect(await providersWithoutCredentials(["anthropic"])).toEqual([]);
  });

  test("an unreadable credential store reports nothing missing rather than guessing no", async () => {
    writeFileSync(credentialFilePath(), "{ not json");
    _resetCredentialStore();
    _authDeps.ambientAuthAvailable = mock(async () => false);
    expect(await providersWithoutCredentials(["anthropic"])).toEqual([]);
  });

  test("de-duplicates the providers it reports", async () => {
    _authDeps.ambientAuthAvailable = mock(async () => false);
    expect(await providersWithoutCredentials(["anthropic", "anthropic"])).toEqual(["anthropic"]);
  });
});

/**
 * US-004 — the run-start probe reads through the assembled store.
 *
 * "Has a stored credential" is now decided by `naxCredentialStore().read()`
 * per provider rather than by listing the file, so the probe records each
 * provider's baseline (`credential.resolved`) and a helper or guard failure
 * refuses the run instead of being read as "nothing missing".
 */
describe("providersWithoutCredentials — reading through the store (US-004)", () => {
  function writeAuthConfig(auth: Record<string, unknown>): void {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ auth }));
  }

  /** A one-shot helper script in the test's global dir. */
  function writeHelper(body: string): string {
    const script = join(dir, "helper.sh");
    writeFileSync(script, `#!/bin/sh\ncat > /dev/null\n${body}\n`);
    chmodSync(script, 0o755);
    return script;
  }

  function execAuth(helper: string): void {
    writeAuthConfig({ source: "exec", exec: { command: [helper] } });
  }

  test("AC12: returns [] when ~/.nax/credentials holds an anthropic api-key", async () => {
    await naxCredentialStore().modify("anthropic", async () => ({ kind: "api-key", key: "sk-anthropic" }));
    _authDeps.ambientAuthAvailable = mock(async () => false);

    expect(await providersWithoutCredentials(["anthropic"])).toEqual([]);
  });

  test("AC13: logs credential.resolved for anthropic when ~/.nax/credentials holds an anthropic api-key", async () => {
    const entries: LogEntry[] = [];
    resetLogger();
    initLogger({ level: "silent" });
    const unsubscribe = addSink((entry) => entries.push(entry));
    try {
      await naxCredentialStore().modify("anthropic", async () => ({ kind: "api-key", key: "sk-anthropic" }));
      _authDeps.ambientAuthAvailable = mock(async () => false);

      await providersWithoutCredentials(["anthropic"]);

      const resolved = entries.filter((entry) => entry.message === "credential.resolved");
      expect(resolved).toHaveLength(1);
      expect(resolved[0].data).toMatchObject({ providerId: "anthropic", source: "file" });
    } finally {
      unsubscribe();
      resetLogger();
    }
  });

  test("AC14: given auth.source exec and a helper that exits 1, it rejects with CREDENTIAL_HELPER_FAILED", async () => {
    execAuth(writeHelper("exit 1"));
    _authDeps.ambientAuthAvailable = mock(async () => false);

    await expect(providersWithoutCredentials(["anthropic"])).rejects.toMatchObject({
      code: "CREDENTIAL_HELPER_FAILED",
    });
  });

  test("AC15: given auth.source exec and a helper that sleeps 2.5 seconds, it returns []", async () => {
    const reply = JSON.stringify({ version: 1, kind: "api-key", key: "HELPER-KEY" });
    execAuth(writeHelper(`sleep 2.5\nprintf '%s' '${reply}'`));
    _authDeps.ambientAuthAvailable = mock(async () => false);

    // Outside the 2000ms AMBIENT_PROBE_TIMEOUT_MS race, so a helper slower
    // than that is still asked, and its answer is still "credentialed".
    expect(await providersWithoutCredentials(["anthropic"])).toEqual([]);
  });

  test("AC16: invalid JSON in ~/.nax/credentials returns [] rather than CREDENTIAL_FILE_UNREADABLE", async () => {
    writeFileSync(credentialFilePath(), "{ not json");
    _resetCredentialStore();
    _authDeps.ambientAuthAvailable = mock(async () => false);

    await expect(providersWithoutCredentials(["anthropic"])).resolves.toEqual([]);
  });

  test("AC17: onChange refuse rejects with CREDENTIAL_CHANGED once the credential is rewritten", async () => {
    writeAuthConfig({ onChange: "refuse" });
    await naxCredentialStore().modify("anthropic", async () => ({ kind: "api-key", key: "KEY-A" }));
    _authDeps.ambientAuthAvailable = mock(async () => false);
    // First call records the guard's baseline from KEY-A.
    expect(await providersWithoutCredentials(["anthropic"])).toEqual([]);

    await naxCredentialStore().modify("anthropic", async () => ({ kind: "api-key", key: "KEY-B" }));

    await expect(providersWithoutCredentials(["anthropic"])).rejects.toMatchObject({ code: "CREDENTIAL_CHANGED" });
  });
});
