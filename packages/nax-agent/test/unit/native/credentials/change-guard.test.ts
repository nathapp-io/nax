import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AuthStamp } from "@nathapp/nax-agent";
import { _resetFingerprintSalt, createChangeGuard, fingerprintCredential } from "@nathapp/nax-agent/internal";
import {
  type CredentialStore,
  createMemoryCredentialStore,
  type ProviderId,
  type StoredCredential,
} from "@nathapp/nax-ai";
import {
  _resetCredentialsConfig,
  type CredentialsConfig,
  configureCredentials,
  credentialsConfig,
  getSafeLogger,
  setAgentLogger,
} from "#src/infra/index";
import { assertNaxError, cleanupTempDir, type LogCall, makeLogger, makeTempDir } from "#test/helpers/index";

/**
 * Stub `CredentialStore` — the guard only needs `read`, and a mutable `set` lets a
 * test change what the inner store returns between reads without touching nax-ai.
 */
interface StubStore {
  store: CredentialStore;
  set(credential: StoredCredential | undefined): void;
}

function makeStubStore(): StubStore {
  let current: StoredCredential | undefined;
  const store: CredentialStore = {
    read: async () => current,
    modify: async (_providerId: ProviderId, fn) => {
      current = await fn(current);
      return current;
    },
    delete: async () => {
      current = undefined;
    },
  };
  return {
    store,
    set: (credential) => {
      current = credential;
    },
  };
}

const API_KEY = (key: string): StoredCredential => ({ kind: "api-key", key });
const OAUTH = (refresh: string): StoredCredential => ({ kind: "oauth", access: "ACCESS", refresh, expires: 1 });

let dir: string;
let logger: ReturnType<typeof makeLogger>;
const originalGlobalDir = process.env.NAX_GLOBAL_CONFIG_DIR;
const originalLogger = getSafeLogger();

/**
 * The credentials slot is process-global and the preload filled it. Save what
 * was there and put it back after each test, so the explicit-salt test can clear
 * the slot and leave the module as it found it for the suites that rely on the
 * preload's slot (S2-3b pattern).
 */
let savedCredentials: CredentialsConfig | undefined;
let credentialsWasConfigured = false;

beforeEach(() => {
  try {
    savedCredentials = credentialsConfig();
    credentialsWasConfigured = true;
  } catch {
    credentialsWasConfigured = false;
  }

  dir = makeTempDir("nax-change-guard-");
  process.env.NAX_GLOBAL_CONFIG_DIR = dir;
  _resetFingerprintSalt();

  logger = makeLogger();
  setAgentLogger(logger);
});

afterEach(() => {
  setAgentLogger(originalLogger);
  _resetFingerprintSalt();
  process.env.NAX_GLOBAL_CONFIG_DIR = originalGlobalDir;
  if (credentialsWasConfigured && savedCredentials !== undefined) configureCredentials(savedCredentials);
  else _resetCredentialsConfig();
  cleanupTempDir(dir);
});

/** Entries whose event name (the log message) equals `name`. */
function named(name: string): LogCall[] {
  return logger.calls.filter((entry) => entry.message === name);
}

/** Every credential-lifecycle entry captured so far. */
function credentialEvents(): LogCall[] {
  return logger.calls.filter((entry) => entry.message.startsWith("credential."));
}

describe("createChangeGuard", () => {
  test("AC8: the first read of a provider logs credential.resolved at info with providerId, kind, source and fingerprint", async () => {
    const stub = makeStubStore();
    const credential = API_KEY("K1");
    stub.set(credential);
    const guard = createChangeGuard(stub.store, { onChange: "warn", describe: () => undefined });

    const returned = await guard.read("anthropic");

    expect(returned).toEqual(credential);
    const resolved = named("credential.resolved");
    expect(resolved).toHaveLength(1);
    expect(resolved[0].level).toBe("info");
    expect(resolved[0].data).toMatchObject({
      providerId: "anthropic",
      kind: "api-key",
      source: "file",
      fingerprint: await fingerprintCredential(credential),
    });
  });

  test("AC9: credential.resolved carries the source and account that describe reports", async () => {
    const stub = makeStubStore();
    stub.set(API_KEY("K1"));
    const guard = createChangeGuard(stub.store, {
      onChange: "warn",
      describe: () => ({ source: "exec", account: "team-a" }),
    });

    await guard.read("anthropic");

    const resolved = named("credential.resolved");
    expect(resolved).toHaveLength(1);
    expect(resolved[0].data).toMatchObject({ source: "exec", account: "team-a" });
  });

  test("AC10: a second read returning the identical credential logs no credential.* entry", async () => {
    const stub = makeStubStore();
    stub.set(API_KEY("K1"));
    const guard = createChangeGuard(stub.store, { onChange: "warn", describe: () => undefined });

    await guard.read("anthropic");
    logger.reset();

    await guard.read("anthropic");

    expect(credentialEvents()).toHaveLength(0);
  });

  test("AC11: under warn, a changed api-key fingerprint logs credential.changed at warn with previousFingerprint", async () => {
    const stub = makeStubStore();
    const first = API_KEY("K1");
    const second = API_KEY("K2");
    stub.set(first);
    const guard = createChangeGuard(stub.store, { onChange: "warn", describe: () => undefined });
    await guard.read("anthropic");
    const previousFingerprint = await fingerprintCredential(first);
    logger.reset();

    stub.set(second);
    await guard.read("anthropic");

    const changed = named("credential.changed");
    expect(changed).toHaveLength(1);
    expect(changed[0].level).toBe("warn");
    expect(changed[0].data).toMatchObject({
      providerId: "anthropic",
      kind: "api-key",
      fingerprint: await fingerprintCredential(second),
      previousFingerprint,
    });
  });

  test("AC12: under warn, a changed api-key fingerprint returns the new credential", async () => {
    const stub = makeStubStore();
    stub.set(API_KEY("K1"));
    const guard = createChangeGuard(stub.store, { onChange: "warn", describe: () => undefined });
    await guard.read("anthropic");

    const second = API_KEY("K2");
    stub.set(second);
    const result = await guard.read("anthropic");

    expect(result).toEqual(second);
  });

  test("AC13: under refuse, a changed api-key fingerprint throws NaxError code CREDENTIAL_CHANGED", async () => {
    const stub = makeStubStore();
    stub.set(API_KEY("K1"));
    const guard = createChangeGuard(stub.store, { onChange: "refuse", describe: () => undefined });
    await guard.read("anthropic");

    stub.set(API_KEY("K2"));
    const error = await guard.read("anthropic").catch((caught: unknown) => caught);

    assertNaxError(error, "guard.read rejection");
    expect(error.code).toBe("CREDENTIAL_CHANGED");
  });

  test("AC14: under refuse, a further read of the same new credential throws CREDENTIAL_CHANGED again", async () => {
    const stub = makeStubStore();
    stub.set(API_KEY("K1"));
    const guard = createChangeGuard(stub.store, { onChange: "refuse", describe: () => undefined });
    await guard.read("anthropic");
    stub.set(API_KEY("K2"));

    const first = await guard.read("anthropic").catch((caught: unknown) => caught);
    assertNaxError(first, "first refusal");
    expect(first.code).toBe("CREDENTIAL_CHANGED");

    const second = await guard.read("anthropic").catch((caught: unknown) => caught);
    assertNaxError(second, "second refusal");
    expect(second.code).toBe("CREDENTIAL_CHANGED");
  });

  test("AC15: a read whose kind changes from api-key to oauth logs credential.changed", async () => {
    const stub = makeStubStore();
    stub.set(API_KEY("K1"));
    const guard = createChangeGuard(stub.store, { onChange: "warn", describe: () => undefined });
    await guard.read("anthropic");
    logger.reset();

    stub.set(OAUTH("R"));
    await guard.read("anthropic");

    expect(named("credential.changed")).toHaveLength(1);
  });

  test("AC16: under refuse, a read of an oauth credential with a different refresh token returns the credential", async () => {
    const stub = makeStubStore();
    stub.set(OAUTH("R1"));
    const guard = createChangeGuard(stub.store, { onChange: "refuse", describe: () => undefined });
    await guard.read("anthropic");

    const rotated = OAUTH("R2");
    stub.set(rotated);
    const result = await guard.read("anthropic");

    expect(result).toEqual(rotated);
  });

  test("AC17: a read of an oauth credential with a different refresh token logs credential.renewed at info", async () => {
    const stub = makeStubStore();
    stub.set(OAUTH("R1"));
    const guard = createChangeGuard(stub.store, { onChange: "refuse", describe: () => undefined });
    await guard.read("anthropic");
    logger.reset();

    stub.set(OAUTH("R2"));
    await guard.read("anthropic");

    const renewed = named("credential.renewed");
    expect(renewed).toHaveLength(1);
    expect(renewed[0].level).toBe("info");
  });

  test("AC18: under refuse and one account label, a read of a new api-key logs credential.renewed at info", async () => {
    const stub = makeStubStore();
    stub.set(API_KEY("K1"));
    const guard = createChangeGuard(stub.store, {
      onChange: "refuse",
      describe: () => ({ source: "exec", account: "team-a" }),
    });
    await guard.read("anthropic");
    logger.reset();

    stub.set(API_KEY("K2"));
    await guard.read("anthropic");

    const renewed = named("credential.renewed");
    expect(renewed).toHaveLength(1);
    expect(renewed[0].level).toBe("info");
  });

  test("AC19: under refuse and one account label, a read of a new api-key returns the credential", async () => {
    const stub = makeStubStore();
    stub.set(API_KEY("K1"));
    const guard = createChangeGuard(stub.store, {
      onChange: "refuse",
      describe: () => ({ source: "exec", account: "team-a" }),
    });
    await guard.read("anthropic");

    const second = API_KEY("K2");
    stub.set(second);
    const result = await guard.read("anthropic");

    expect(result).toEqual(second);
  });

  test("AC20: under refuse, a read whose account label changes throws CREDENTIAL_CHANGED", async () => {
    const stub = makeStubStore();
    let account = "team-a";
    stub.set(API_KEY("K"));
    const guard = createChangeGuard(stub.store, {
      onChange: "refuse",
      describe: () => ({ source: "exec", account }),
    });
    await guard.read("anthropic");

    account = "team-b";
    const error = await guard.read("anthropic").catch((caught: unknown) => caught);

    assertNaxError(error, "guard.read rejection");
    expect(error.code).toBe("CREDENTIAL_CHANGED");
  });

  test("AC21: a read returning undefined after a stored identity logs no credential.* entry", async () => {
    const stub = makeStubStore();
    stub.set(API_KEY("K1"));
    const guard = createChangeGuard(stub.store, { onChange: "warn", describe: () => undefined });
    await guard.read("anthropic");
    logger.reset();

    stub.set(undefined);
    const result = await guard.read("anthropic");

    expect(result).toBeUndefined();
    expect(credentialEvents()).toHaveLength(0);
  });

  test("AC22: a read returning the original credential after an intervening undefined read logs no credential.* entry", async () => {
    const stub = makeStubStore();
    const original = API_KEY("K1");
    stub.set(original);
    const guard = createChangeGuard(stub.store, { onChange: "warn", describe: () => undefined });
    await guard.read("anthropic");

    stub.set(undefined);
    await guard.read("anthropic");
    logger.reset();

    stub.set(original);
    await guard.read("anthropic");

    expect(credentialEvents()).toHaveLength(0);
  });

  test("AC23: servedAuth returns the last read's fingerprint, source and account", async () => {
    const stub = makeStubStore();
    const credential = API_KEY("K1");
    stub.set(credential);
    const guard = createChangeGuard(stub.store, {
      onChange: "warn",
      describe: () => ({ source: "exec", account: "team-a" }),
    });

    await guard.read("anthropic");

    const stamp: AuthStamp | undefined = guard.servedAuth("anthropic");
    expect(stamp).toEqual({ fingerprint: await fingerprintCredential(credential), source: "exec", account: "team-a" });
  });

  test("AC23: servedAuth returns undefined for a provider that was never read", () => {
    const stub = makeStubStore();
    const guard = createChangeGuard(stub.store, { onChange: "warn", describe: () => undefined });

    expect(guard.servedAuth("anthropic")).toBeUndefined();
  });

  // The guard wraps only `read`; `modify` and `delete` pass straight through.

  test("pass-through: modify delegates to the inner store and returns its result", async () => {
    const stub = makeStubStore();
    stub.set(API_KEY("K1"));
    const guard = createChangeGuard(stub.store, { onChange: "warn", describe: () => undefined });

    const updated = API_KEY("K2");
    const returned = await guard.modify("anthropic", async () => updated);

    expect(returned).toEqual(updated);
    expect(await stub.store.read("anthropic")).toEqual(updated);
  });

  test("pass-through: delete delegates to the inner store", async () => {
    const stub = makeStubStore();
    stub.set(API_KEY("K1"));
    const guard = createChangeGuard(stub.store, { onChange: "warn", describe: () => undefined });

    await guard.delete("anthropic");

    expect(await stub.store.read("anthropic")).toBeUndefined();
  });

  test("pass-through: a write records no identity and logs no credential.* entry", async () => {
    const stub = makeStubStore();
    stub.set(API_KEY("K1"));
    const guard = createChangeGuard(stub.store, { onChange: "warn", describe: () => undefined });

    await guard.modify("anthropic", async () => API_KEY("K2"));
    await guard.delete("anthropic");

    // A write is not a change of who is being billed: it neither mints nor clears an identity.
    expect(guard.servedAuth("anthropic")).toBeUndefined();
    expect(credentialEvents()).toHaveLength(0);
  });

  test("pass-through: a write leaves the identity a read established intact", async () => {
    const stub = makeStubStore();
    stub.set(API_KEY("K1"));
    const guard = createChangeGuard(stub.store, { onChange: "refuse", describe: () => undefined });
    await guard.read("anthropic");
    const stamp = guard.servedAuth("anthropic");
    logger.reset();

    await guard.modify("anthropic", async () => API_KEY("K2"));
    await guard.delete("anthropic");

    expect(guard.servedAuth("anthropic")).toEqual(stamp);
    expect(credentialEvents()).toHaveLength(0);

    // The next read is still classified against the identity read established, not against the write.
    stub.set(API_KEY("K2"));
    const error = await guard.read("anthropic").catch((caught: unknown) => caught);
    assertNaxError(error, "guard.read rejection");
    expect(error.code).toBe("CREDENTIAL_CHANGED");
  });

  test("AC24: no credential.* log entry's data or message carries the key, access or refresh value", async () => {
    const key = "SENTINEL-KEY-VALUE";
    const access = "SENTINEL-ACCESS-VALUE";
    const refresh = "SENTINEL-REFRESH-VALUE";

    const stub = makeStubStore();
    stub.set(API_KEY(key));
    const guard = createChangeGuard(stub.store, {
      onChange: "warn",
      describe: () => ({ source: "exec", account: "team-a" }),
    });
    await guard.read("anthropic"); // resolved
    stub.set(API_KEY(`${key}-ROTATED`));
    await guard.read("anthropic"); // renewed (same account label)
    stub.set({ kind: "oauth", access, refresh, expires: 1 });
    await guard.read("anthropic"); // changed (kind changed)
    stub.set({ kind: "oauth", access, refresh: `${refresh}-ROTATED`, expires: 1 });
    await guard.read("anthropic"); // renewed

    const events = credentialEvents();
    // The guard really did classify and log — safety must not be achieved by silence.
    expect(named("credential.resolved")).toHaveLength(1);
    expect(named("credential.changed")).toHaveLength(1);
    expect(named("credential.renewed")).toHaveLength(2);

    for (const entry of events) {
      const serialized = JSON.stringify(entry);
      for (const secret of [key, `${key}-ROTATED`, access, refresh, `${refresh}-ROTATED`]) {
        expect(serialized).not.toContain(secret);
      }
    }
  });

  test("a guard with an explicit salt never reads the credentials slot", async () => {
    _resetCredentialsConfig();
    const inner = createMemoryCredentialStore({ anthropic: { kind: "api-key", key: "k" } });
    const guard = createChangeGuard(inner, {
      onChange: "warn",
      salt: Buffer.alloc(32, 1),
      describe: () => ({ source: "memory" }),
    });
    await guard.read("anthropic");
    expect(guard.servedAuth("anthropic")?.source).toBe("memory");
  });
});
