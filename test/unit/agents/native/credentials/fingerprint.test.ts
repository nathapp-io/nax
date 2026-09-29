import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { _resetFingerprintSalt, fingerprintCredential } from "@/agents/native/credentials/fingerprint";
import { addSink, initLogger, type LogEntry, resetLogger } from "@/logger";

/**
 * `NAX_GLOBAL_CONFIG_DIR` points at a fresh temp dir in every test (story harness),
 * so the salt file lives at `<dir>/auth-fingerprint-salt` and nothing escapes it.
 */
let dir: string;
let saltPath: string;
let entries: LogEntry[];
let unsubscribe: () => void;
const originalGlobalDir = process.env.NAX_GLOBAL_CONFIG_DIR;

beforeEach(() => {
  dir = makeTempDir("nax-fingerprint-");
  process.env.NAX_GLOBAL_CONFIG_DIR = dir;
  saltPath = join(dir, "auth-fingerprint-salt");
  _resetFingerprintSalt();

  entries = [];
  resetLogger();
  initLogger({ level: "silent" });
  unsubscribe = addSink((entry) => entries.push(entry));
});

afterEach(() => {
  unsubscribe();
  resetLogger();
  _resetFingerprintSalt();
  process.env.NAX_GLOBAL_CONFIG_DIR = originalGlobalDir;
  cleanupTempDir(dir);
});

/** First 12 lowercase hex characters of HMAC-SHA-256 over `secret`, keyed by `salt`. */
function expectedFingerprint(secret: string, salt: Buffer): string {
  return createHmac("sha256", salt).update(secret).digest("hex").slice(0, 12);
}

/** Entries whose event name (the log message) equals `name`. */
function named(name: string): LogEntry[] {
  return entries.filter((entry) => entry.message === name);
}

describe("fingerprintCredential", () => {
  test("AC1: api-key fingerprint is the first 12 lowercase hex chars of HMAC-SHA-256 over the key, keyed by the salt file", async () => {
    const fingerprint = await fingerprintCredential({ kind: "api-key", key: "K" });

    const salt = readFileSync(saltPath);
    expect(fingerprint).toBe(expectedFingerprint("K", salt));
    expect(fingerprint).toMatch(/^[0-9a-f]{12}$/);
  });

  test("AC2: returns the same fingerprint after _resetFingerprintSalt when the salt file already exists", async () => {
    const before = await fingerprintCredential({ kind: "api-key", key: "K" });
    expect(existsSync(saltPath)).toBe(true);

    _resetFingerprintSalt();

    const after = await fingerprintCredential({ kind: "api-key", key: "K" });
    expect(after).toBe(before);
  });

  test("AC2: reads the persisted salt back, so a different 32-byte salt yields a different fingerprint", async () => {
    await fingerprintCredential({ kind: "api-key", key: "K" });
    const replacement = Buffer.alloc(32, 7);
    writeFileSync(saltPath, replacement);

    _resetFingerprintSalt();

    expect(await fingerprintCredential({ kind: "api-key", key: "K" })).toBe(expectedFingerprint("K", replacement));
  });

  test("AC3: oauth fingerprint ignores the access token and equals the fingerprint of the same refresh token", async () => {
    const withA1 = await fingerprintCredential({ kind: "oauth", access: "A1", refresh: "R", expires: 1 });
    const withA2 = await fingerprintCredential({ kind: "oauth", access: "A2", refresh: "R", expires: 1 });

    expect(withA1).toBe(withA2);
  });

  test("AC3: oauth fingerprint changes when the refresh token changes", async () => {
    const first = await fingerprintCredential({ kind: "oauth", access: "A", refresh: "R1", expires: 1 });
    const rotated = await fingerprintCredential({ kind: "oauth", access: "A", refresh: "R2", expires: 1 });

    expect(rotated).not.toBe(first);
  });

  test("AC4: the first fingerprintCredential call creates the salt file holding exactly 32 bytes", async () => {
    expect(existsSync(saltPath)).toBe(false);

    await fingerprintCredential({ kind: "api-key", key: "K" });

    expect(existsSync(saltPath)).toBe(true);
    expect(statSync(saltPath).size).toBe(32);
  });

  test("AC4: a second call leaves the existing 32-byte salt file byte-for-byte unchanged", async () => {
    await fingerprintCredential({ kind: "api-key", key: "K1" });
    const created = readFileSync(saltPath);

    await fingerprintCredential({ kind: "api-key", key: "K2" });

    const after = readFileSync(saltPath);
    expect(after.byteLength).toBe(32);
    expect(after.toString("hex")).toBe(created.toString("hex"));
  });

  test("AC5: the salt file created by the first fingerprintCredential call has file mode 0600", async () => {
    await fingerprintCredential({ kind: "api-key", key: "K" });

    expect(statSync(saltPath).mode & 0o777).toBe(0o600);
  });

  test("AC6: a 5-byte salt file is left byte-for-byte unchanged across two calls", async () => {
    const fiveBytes = Buffer.from([1, 2, 3, 4, 5]);
    writeFileSync(saltPath, fiveBytes, { mode: 0o600 });

    await fingerprintCredential({ kind: "api-key", key: "K1" });
    await fingerprintCredential({ kind: "api-key", key: "K2" });

    expect(readFileSync(saltPath).toString("hex")).toBe(fiveBytes.toString("hex"));
  });

  test("AC7: a 5-byte salt file logs credential.salt_invalid exactly once across two calls", async () => {
    writeFileSync(saltPath, Buffer.from([1, 2, 3, 4, 5]), { mode: 0o600 });

    await fingerprintCredential({ kind: "api-key", key: "K1" });
    await fingerprintCredential({ kind: "api-key", key: "K2" });

    expect(named("credential.salt_invalid")).toHaveLength(1);
  });

  test("AC7: a valid 32-byte salt file logs no credential.salt_invalid", async () => {
    await fingerprintCredential({ kind: "api-key", key: "K1" });
    await fingerprintCredential({ kind: "api-key", key: "K2" });

    expect(named("credential.salt_invalid")).toHaveLength(0);
  });
});
