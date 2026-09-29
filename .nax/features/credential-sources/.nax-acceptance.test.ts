import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createHmac } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthStamp } from "@/agents/session-types";
import { AgentManager } from "@/agents/manager";
import { buildCompleteEvent, buildDispatchErrorEvent, buildSessionTurnEvent } from "@/agents/manager-dispatch";
import { NativeAgentAdapter } from "@/agents/native/adapter";
import { _authDeps, providersWithoutCredentials } from "@/agents/native/auth";
import { _clientDeps, _resetNativeClient, buildNativeClient } from "@/agents/native/client";
import { _resetCredentialStore } from "@/agents/native/credentials";
import { parseNativeModel } from "@/agents/native/models";
import { _cliAuthDeps, authListCommand, authLoginCommand, authRmCommand } from "@/cli/auth";
import { FIELD_DESCRIPTIONS } from "@/cli/config-descriptions";
import { DEFAULT_CONFIG, loadConfig, loadConfigForWorkdir, loadPackageOverride, loadProfile, pinRootOnlyKeysRaw } from "@/config";
import { _clearRootConfigCache } from "@/config/loader";
import type { ProviderCatalogOverride } from "@/config/schema-types";
import { NaxError } from "@/errors";
import { addSink, initLogger, resetLogger, type LogEntry } from "@/logger";
import { DispatchEventBus } from "@/runtime/dispatch-events";
import { attachCostSubscriber, COST_ROW_SCHEMA_VERSION } from "@/runtime/middleware/cost";
import { makeAgentAdapter, makeAgentRegistry, makeNaxConfig } from "@test/helpers";

// ─────────────────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────────────────

const ORIGINAL_GLOBAL_DIR = process.env.NAX_GLOBAL_CONFIG_DIR;
const ORIGINAL_BUILD = _clientDeps.build;
const ORIGINAL_LOGIN = _authDeps.login;
const ORIGINAL_AMBIENT = _authDeps.ambientAuthAvailable;
const ORIGINAL_CLI_LOG = _cliAuthDeps.log;
const ORIGINAL_CLI_ISTTY = _cliAuthDeps.isTTY;

const createdDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  createdDirs.push(dir);
  return dir;
}

/** Point the global config dir at a fresh temp dir for the current test. */
function freshGlobalDir(): string {
  const dir = tempDir("nax-credsrc-global-");
  process.env.NAX_GLOBAL_CONFIG_DIR = dir;
  return dir;
}

function writeGlobalConfig(globalDir: string, config: Record<string, unknown>): void {
  mkdirSync(globalDir, { recursive: true });
  writeFileSync(join(globalDir, "config.json"), JSON.stringify(config), { mode: 0o600 });
}

/** The nax-ai file-store shape: {"version":1,"credentials":{...}} */
function writeCredentialsFile(
  globalDir: string,
  credentials: Record<string, { kind: "api-key"; key: string } | { kind: "oauth"; access: string; refresh: string; expires: number }>,
): string {
  mkdirSync(globalDir, { recursive: true });
  const path = join(globalDir, "credentials");
  writeFileSync(path, JSON.stringify({ version: 1, credentials }), { mode: 0o600 });
  return path;
}

function writeExecutableScript(dir: string, name: string, body: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, ["#!/bin/sh", body, ""].join("\n"));
  chmodSync(path, 0o755);
  return path;
}

/** Helpers append one byte per spawn; the count is the file's byte length. */
function spawnCount(counterPath: string): number {
  return existsSync(counterPath) ? readFileSync(counterPath, "utf8").length : 0;
}

async function pollUntil(condition: () => boolean, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return condition();
}

/** Reset the logger singleton, re-init it silent, and capture every entry. */
function captureLog(): LogEntry[] {
  resetLogger();
  const entries: LogEntry[] = [];
  initLogger({ level: "silent", useChalk: false });
  addSink((entry) => entries.push(entry));
  return entries;
}

function named(entries: LogEntry[], name: string): LogEntry[] {
  return entries.filter((entry) => entry.message === name);
}

function namedLike(entries: LogEntry[], pattern: RegExp): LogEntry[] {
  return entries.filter((entry) => pattern.test(entry.message));
}

async function rejectsNaxCode(promise: Promise<unknown>, code: string): Promise<NaxError> {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(NaxError);
  expect((caught as NaxError).code).toBe(code);
  return caught as NaxError;
}

/** Copy of SECRET_KEY_PATTERN from src/logger/redact.ts — keys that must never appear in log data. */
const SECRET_KEY_PATTERN =
  /(SECRET|TOKEN(?!s\b)|API_?KEY|PASSWORD|PRIVATE_?KEY|ACCESS_?KEY|WEBHOOK|AUTHORIZATION|COOKIE|CREDENTIAL|PASSWD|(?:\w+)?_URL|\w+_URI|\w+_DSN|CONNECTION\s*STRING)/i;

/** First secret-shaped key anywhere in the value's key structure, or null. */
function findSecretShapedKey(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = findSecretShapedKey(item);
      if (hit !== null) return hit;
    }
    return null;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_PATTERN.test(key)) return key;
      const hit = findSecretShapedKey(child);
      if (hit !== null) return hit;
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Global seams / state reset
// ─────────────────────────────────────────────────────────────────────────────

afterEach(() => {
  _resetCredentialStore();
  _clearRootConfigCache();
  _resetNativeClient();
  _authDeps.login = ORIGINAL_LOGIN;
  _authDeps.ambientAuthAvailable = ORIGINAL_AMBIENT;
  _cliAuthDeps.log = ORIGINAL_CLI_LOG;
  _cliAuthDeps.isTTY = ORIGINAL_CLI_ISTTY;
  resetLogger();
  if (ORIGINAL_GLOBAL_DIR === undefined) delete process.env.NAX_GLOBAL_CONFIG_DIR;
  else process.env.NAX_GLOBAL_CONFIG_DIR = ORIGINAL_GLOBAL_DIR;
  for (const dir of createdDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-001 — auth schema
// ─────────────────────────────────────────────────────────────────────────────

describe("credential-sources schema (AuthConfigSchema)", () => {
  test("AC-1: AuthConfigSchema.parse({}) defaults source to \"file\" when source is absent", async () => {
    const { AuthConfigSchema } = await import("@/config/schemas-auth");
    const parsed = AuthConfigSchema.parse({});
    expect(parsed.source).toBe("file");
  });

  test("AC-2: AuthConfigSchema.parse({}) defaults onChange to \"warn\" when onChange is absent", async () => {
    const { AuthConfigSchema } = await import("@/config/schemas-auth");
    const parsed = AuthConfigSchema.parse({});
    expect(parsed.onChange).toBe("warn");
  });

  test("AC-3: safeParse({source:\"exec\"}) fails with an issue whose path deep-equals [\"exec\"]", async () => {
    const { AuthConfigSchema } = await import("@/config/schemas-auth");
    const result = AuthConfigSchema.safeParse({ source: "exec" });
    expect(result.success).toBe(false);
    if (result.success) return;
    const onExecPath = result.error.issues.some((issue) => issue.path.length === 1 && issue.path[0] === "exec");
    expect(onExecPath).toBe(true);
  });

  test("AC-4: exec.timeoutMs defaults to 10000 when absent", async () => {
    const { AuthConfigSchema } = await import("@/config/schemas-auth");
    const parsed = AuthConfigSchema.parse({ source: "exec", exec: { command: ["koda-cred"] } });
    expect(parsed.exec?.timeoutMs).toBe(10000);
  });

  test("AC-5: exec.command [] is rejected (non-empty argv required)", async () => {
    const { AuthConfigSchema } = await import("@/config/schemas-auth");
    const result = AuthConfigSchema.safeParse({ source: "exec", exec: { command: [] } });
    expect(result.success).toBe(false);
  });

  test("AC-6: exec.timeoutMs 999 is rejected (inclusive minimum 1000)", async () => {
    const { AuthConfigSchema } = await import("@/config/schemas-auth");
    const result = AuthConfigSchema.safeParse({ source: "exec", exec: { command: ["x"], timeoutMs: 999 } });
    expect(result.success).toBe(false);
  });

  test("AC-7: exec.timeoutMs 60001 is rejected (inclusive maximum 60000)", async () => {
    const { AuthConfigSchema } = await import("@/config/schemas-auth");
    const result = AuthConfigSchema.safeParse({ source: "exec", exec: { command: ["x"], timeoutMs: 60001 } });
    expect(result.success).toBe(false);
  });

  test("AC-8: onChange \"ignore\" is rejected (enum is warn|refuse)", async () => {
    const { AuthConfigSchema } = await import("@/config/schemas-auth");
    const result = AuthConfigSchema.safeParse({ onChange: "ignore" });
    expect(result.success).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-001 — readGlobalAuthConfig
// ─────────────────────────────────────────────────────────────────────────────

describe("credential-sources readGlobalAuthConfig", () => {
  test("AC-9: missing config.json resolves with source \"file\" (defaults applied)", async () => {
    const { readGlobalAuthConfig } = await import("@/config/schemas-auth");
    freshGlobalDir();
    const auth = await readGlobalAuthConfig();
    expect(auth.source).toBe("file");
  });

  test("AC-10: exec.command [\"koda-cred\"] is read from config.json", async () => {
    const { readGlobalAuthConfig } = await import("@/config/schemas-auth");
    const dir = freshGlobalDir();
    writeGlobalConfig(dir, { auth: { source: "exec", exec: { command: ["koda-cred"] } } });
    const auth = await readGlobalAuthConfig();
    expect(auth.exec?.command).toStrictEqual(["koda-cred"]);
  });

  test("AC-11: auth {source:\"exec\"} without exec.command rejects NaxError AUTH_CONFIG_INVALID", async () => {
    const { readGlobalAuthConfig } = await import("@/config/schemas-auth");
    const dir = freshGlobalDir();
    writeGlobalConfig(dir, { auth: { source: "exec" } });
    await rejectsNaxCode(readGlobalAuthConfig(), "AUTH_CONFIG_INVALID");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-001 — auth is global-only across every non-global config layer
// ─────────────────────────────────────────────────────────────────────────────

describe("credential-sources global-only auth layering", () => {
  test("AC-12: loadConfig(projectDir) rejects AUTH_CONFIG_NOT_GLOBAL when project config has an auth key", async () => {
    freshGlobalDir();
    const project = tempDir("nax-credsrc-proj-");
    mkdirSync(join(project, ".nax"), { recursive: true });
    writeFileSync(join(project, ".nax", "config.json"), JSON.stringify({ auth: { source: "file" } }));
    await rejectsNaxCode(loadConfig(project), "AUTH_CONFIG_NOT_GLOBAL");
  });

  test("AC-13: the project-layer AUTH_CONFIG_NOT_GLOBAL message names \"project\"", async () => {
    freshGlobalDir();
    const project = tempDir("nax-credsrc-proj-");
    mkdirSync(join(project, ".nax"), { recursive: true });
    writeFileSync(join(project, ".nax", "config.json"), JSON.stringify({ auth: { source: "file" } }));
    const err = await rejectsNaxCode(loadConfig(project), "AUTH_CONFIG_NOT_GLOBAL");
    expect(err.message).toContain("project");
  });

  test("AC-14: loadConfig with a global profile carrying auth rejects AUTH_CONFIG_NOT_GLOBAL", async () => {
    const globalDir = freshGlobalDir();
    mkdirSync(join(globalDir, "profiles"), { recursive: true });
    writeFileSync(join(globalDir, "profiles", "p.json"), JSON.stringify({ auth: { source: "file" } }));
    const project = tempDir("nax-credsrc-proj-");
    await rejectsNaxCode(loadConfig(project, { profile: "p" }), "AUTH_CONFIG_NOT_GLOBAL");
  });

  test("AC-15: loadProfile for a profile with auth rejects AUTH_CONFIG_NOT_GLOBAL naming profile:p", async () => {
    freshGlobalDir();
    const projectRoot = tempDir("nax-credsrc-proj-");
    mkdirSync(join(projectRoot, ".nax", "profiles"), { recursive: true });
    writeFileSync(join(projectRoot, ".nax", "profiles", "p.json"), JSON.stringify({ auth: { source: "file" } }));
    const err = await rejectsNaxCode(loadProfile("p", projectRoot), "AUTH_CONFIG_NOT_GLOBAL");
    expect(err.message).toContain("profile:p");
  });

  test("AC-16: loadConfig with a project profile carrying auth rejects AUTH_CONFIG_NOT_GLOBAL", async () => {
    freshGlobalDir();
    const project = tempDir("nax-credsrc-proj-");
    mkdirSync(join(project, ".nax", "profiles"), { recursive: true });
    writeFileSync(join(project, ".nax", "profiles", "p.json"), JSON.stringify({ auth: { source: "file" } }));
    await rejectsNaxCode(loadConfig(project, { profile: "p" }), "AUTH_CONFIG_NOT_GLOBAL");
  });

  test("AC-17: loadConfigForWorkdir rejects AUTH_CONFIG_NOT_GLOBAL for a package override with auth", async () => {
    freshGlobalDir();
    const repo = tempDir("nax-credsrc-repo-");
    const naxDir = join(repo, ".nax");
    mkdirSync(join(naxDir, "mono", "packages", "a"), { recursive: true });
    writeFileSync(join(naxDir, "config.json"), JSON.stringify({}));
    writeFileSync(join(naxDir, "mono", "packages", "a", "config.json"), JSON.stringify({ auth: { source: "file" } }));
    await rejectsNaxCode(loadConfigForWorkdir(join(naxDir, "config.json"), "packages/a"), "AUTH_CONFIG_NOT_GLOBAL");
  });

  test("AC-18: loadPackageOverride rejects AUTH_CONFIG_NOT_GLOBAL for an override with auth", async () => {
    freshGlobalDir();
    const repo = tempDir("nax-credsrc-repo-");
    const naxDir = join(repo, ".nax");
    mkdirSync(join(naxDir, "mono", "packages", "a"), { recursive: true });
    writeFileSync(join(naxDir, "mono", "packages", "a", "config.json"), JSON.stringify({ auth: { source: "file" } }));
    await rejectsNaxCode(loadPackageOverride(repo, "packages/a"), "AUTH_CONFIG_NOT_GLOBAL");
  });

  test("AC-19: loadConfigForWorkdir rejects AUTH_CONFIG_NOT_GLOBAL when the package's profile has auth", async () => {
    freshGlobalDir();
    const repo = tempDir("nax-credsrc-repo-");
    const naxDir = join(repo, ".nax");
    mkdirSync(join(naxDir, "mono", "packages", "a"), { recursive: true });
    mkdirSync(join(repo, "packages", "a", ".nax", "profiles"), { recursive: true });
    writeFileSync(join(naxDir, "config.json"), JSON.stringify({}));
    writeFileSync(join(naxDir, "mono", "packages", "a", "config.json"), JSON.stringify({ profile: "pp" }));
    writeFileSync(join(repo, "packages", "a", ".nax", "profiles", "pp.json"), JSON.stringify({ auth: { source: "file" } }));
    await rejectsNaxCode(loadConfigForWorkdir(join(naxDir, "config.json"), "packages/a"), "AUTH_CONFIG_NOT_GLOBAL");
  });

  test("AC-20: loadConfig resolves auth.source \"exec\" when only the global config sets auth", async () => {
    const globalDir = freshGlobalDir();
    writeGlobalConfig(globalDir, { auth: { source: "exec", exec: { command: ["h"] } } });
    const project = tempDir("nax-credsrc-proj-");
    mkdirSync(join(project, ".nax"), { recursive: true });
    writeFileSync(join(project, ".nax", "config.json"), JSON.stringify({}));
    const config = await loadConfig(project);
    expect(config.auth.source).toBe("exec");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-001 — root-only pinning and field descriptions
// ─────────────────────────────────────────────────────────────────────────────

describe("credential-sources root-only pinning and descriptions", () => {
  test("AC-21: pinRootOnlyKeysRaw replaces the package's auth with the root's auth", () => {
    const root = {
      ...(structuredClone(DEFAULT_CONFIG) as Record<string, unknown>),
      auth: { source: "exec", exec: { command: ["h"] }, onChange: "warn" },
    };
    const raw: Record<string, unknown> = { auth: { source: "file" } };
    const warnings: string[] = [];
    const out = pinRootOnlyKeysRaw(raw, root as typeof DEFAULT_CONFIG, "packages/a", (msg) => warnings.push(msg));
    expect(out.auth).toStrictEqual(root.auth);
  });

  test("AC-22: FIELD_DESCRIPTIONS carries a non-empty entry for every auth key", () => {
    const keys = ["auth", "auth.source", "auth.exec", "auth.exec.command", "auth.exec.timeoutMs", "auth.onChange"];
    for (const key of keys) {
      expect(Object.hasOwn(FIELD_DESCRIPTIONS, key)).toBe(true);
      expect(typeof FIELD_DESCRIPTIONS[key]).toBe("string");
      expect(FIELD_DESCRIPTIONS[key].trim().length).toBeGreaterThan(0);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-002 — fingerprints
// ─────────────────────────────────────────────────────────────────────────────

describe("credential-sources fingerprintCredential", () => {
  test("AC-23: fingerprint equals the first 12 hex chars of HMAC-SHA-256(\"K\") keyed with the salt file", async () => {
    const { fingerprintCredential } = await import("@/agents/native/credentials/fingerprint");
    const dir = freshGlobalDir();
    const fingerprint = await fingerprintCredential({ kind: "api-key", key: "K" });
    const salt = readFileSync(join(dir, "auth-fingerprint-salt"));
    const expected = createHmac("sha256", salt).update("K").digest("hex").slice(0, 12);
    expect(fingerprint).toBe(expected);
    expect(fingerprint).toMatch(/^[0-9a-f]{12}$/);
  });

  test("AC-24: the fingerprint is stable across _resetFingerprintSalt() when the salt file pre-exists", async () => {
    const { fingerprintCredential, _resetFingerprintSalt } = await import("@/agents/native/credentials/fingerprint");
    const dir = freshGlobalDir();
    const fixed = Buffer.alloc(32, 7);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "auth-fingerprint-salt"), fixed);
    const v1 = await fingerprintCredential({ kind: "api-key", key: "K" });
    _resetFingerprintSalt();
    const v2 = await fingerprintCredential({ kind: "api-key", key: "K" });
    expect(v1).toBe(v2);
    expect(readFileSync(join(dir, "auth-fingerprint-salt")).equals(fixed)).toBe(true);
  });

  test("AC-25: oauth fingerprints depend only on the refresh token, not the access token", async () => {
    const { fingerprintCredential } = await import("@/agents/native/credentials/fingerprint");
    const dir = freshGlobalDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "auth-fingerprint-salt"), Buffer.alloc(32, 3));
    const withA1 = await fingerprintCredential({ kind: "oauth", access: "A1", refresh: "R", expires: 1 });
    const withA2 = await fingerprintCredential({ kind: "oauth", access: "A2", refresh: "R", expires: 1 });
    expect(withA1).toBe(withA2);
  });

  test("AC-26: the first fingerprint call creates a 32-byte salt file", async () => {
    const { fingerprintCredential } = await import("@/agents/native/credentials/fingerprint");
    const dir = freshGlobalDir();
    await fingerprintCredential({ kind: "api-key", key: "K" });
    const saltPath = join(dir, "auth-fingerprint-salt");
    statSync(saltPath);
    expect(readFileSync(saltPath).byteLength).toBe(32);
  });

  test("AC-27: the created salt file has POSIX mode 0600", async () => {
    const { fingerprintCredential } = await import("@/agents/native/credentials/fingerprint");
    const dir = freshGlobalDir();
    await fingerprintCredential({ kind: "api-key", key: "K" });
    const mode = statSync(join(dir, "auth-fingerprint-salt")).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("AC-28: a 5-byte salt file is left byte-for-byte untouched across two fingerprint calls", async () => {
    const { fingerprintCredential } = await import("@/agents/native/credentials/fingerprint");
    const dir = freshGlobalDir();
    const saltPath = join(dir, "auth-fingerprint-salt");
    mkdirSync(dir, { recursive: true });
    writeFileSync(saltPath, Buffer.from("abcde"));
    await fingerprintCredential({ kind: "api-key", key: "K1" });
    await fingerprintCredential({ kind: "api-key", key: "K2" });
    const after = readFileSync(saltPath);
    expect(after.equals(Buffer.from("abcde"))).toBe(true);
    expect(after.byteLength).toBe(5);
  });

  test("AC-29: two calls against an invalid salt log credential.salt_invalid exactly once, and both return fingerprints", async () => {
    const { fingerprintCredential } = await import("@/agents/native/credentials/fingerprint");
    const dir = freshGlobalDir();
    const saltPath = join(dir, "auth-fingerprint-salt");
    mkdirSync(dir, { recursive: true });
    writeFileSync(saltPath, Buffer.from("abcde"));
    const entries = captureLog();
    const f1 = await fingerprintCredential({ kind: "api-key", key: "K1" });
    const f2 = await fingerprintCredential({ kind: "api-key", key: "K2" });
    expect(typeof f1).toBe("string");
    expect(typeof f2).toBe("string");
    expect(named(entries, "credential.salt_invalid")).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-002 — change guard
// ─────────────────────────────────────────────────────────────────────────────

type GuardCredential =
  | { kind: "api-key"; key: string }
  | { kind: "oauth"; access: string; refresh: string; expires: number };

interface StubInnerStore {
  set(credential: GuardCredential | undefined): void;
  read(p: string): Promise<GuardCredential | undefined>;
  modify(p: string, fn: (current: GuardCredential | undefined) => Promise<GuardCredential | undefined>): Promise<GuardCredential | undefined>;
  delete(p: string): Promise<void>;
}

function stubInnerStore(initial?: GuardCredential): StubInnerStore {
  let current: GuardCredential | undefined = initial;
  return {
    set(credential) {
      current = credential;
    },
    read: mock(async (_p: string) => current),
    modify: mock(async (_p: string, fn) => fn(current)),
    delete: mock(async (_p: string) => {}),
  };
}

describe("credential-sources change guard", () => {
  test("AC-30: the first read of an api-key logs credential.resolved at info with providerId, kind, source and a 12-hex fingerprint", async () => {
    const { createChangeGuard } = await import("@/agents/native/credentials/change-guard");
    freshGlobalDir();
    const entries = captureLog();
    const guard = createChangeGuard(stubInnerStore({ kind: "api-key", key: "K" }), {
      onChange: "warn",
      describe: () => ({ source: "file" }),
    });
    const credential = await guard.read("anthropic");
    expect(credential).toEqual({ kind: "api-key", key: "K" });
    const resolved = named(entries, "credential.resolved");
    expect(resolved).toHaveLength(1);
    expect(resolved[0].level).toBe("info");
    const data = resolved[0].data as Record<string, unknown>;
    expect(data.providerId).toBe("anthropic");
    expect(data.kind).toBe("api-key");
    expect(typeof data.source).toBe("string");
    expect(["file", "exec"]).toContain(data.source);
    expect(String(data.fingerprint)).toMatch(/^[0-9a-f]{12}$/);
  });

  test("AC-31: a describe() reporting exec/team-a stamps source \"exec\" and account \"team-a\" on credential.resolved", async () => {
    const { createChangeGuard } = await import("@/agents/native/credentials/change-guard");
    freshGlobalDir();
    const entries = captureLog();
    const guard = createChangeGuard(stubInnerStore({ kind: "api-key", key: "K" }), {
      onChange: "warn",
      describe: () => ({ source: "exec", account: "team-a" }),
    });
    await guard.read("anthropic");
    const resolved = named(entries, "credential.resolved");
    expect(resolved).toHaveLength(1);
    const data = resolved[0].data as Record<string, unknown>;
    expect(data.source).toBe("exec");
    expect(data.account).toBe("team-a");
  });

  test("AC-32: a second read returning the identical credential logs zero credential.* entries", async () => {
    const { createChangeGuard } = await import("@/agents/native/credentials/change-guard");
    freshGlobalDir();
    const entries = captureLog();
    const guard = createChangeGuard(stubInnerStore({ kind: "api-key", key: "K" }), {
      onChange: "warn",
      describe: () => ({ source: "file" }),
    });
    const first = await guard.read("anthropic");
    entries.length = 0;
    const second = await guard.read("anthropic");
    expect(second).toEqual(first);
    expect(namedLike(entries, /^credential\./)).toHaveLength(0);
  });

  test("AC-33: onChange warn + a changed api-key logs credential.changed at warn with previousFingerprint", async () => {
    const { fingerprintCredential } = await import("@/agents/native/credentials/fingerprint");
    const { createChangeGuard } = await import("@/agents/native/credentials/change-guard");
    freshGlobalDir();
    const entries = captureLog();
    const inner = stubInnerStore({ kind: "api-key", key: "K1" });
    const guard = createChangeGuard(inner, { onChange: "warn", describe: () => ({ source: "file" }) });
    await guard.read("anthropic");
    const fpK1 = await fingerprintCredential({ kind: "api-key", key: "K1" });
    const fpK2 = await fingerprintCredential({ kind: "api-key", key: "K2" });
    entries.length = 0;
    inner.set({ kind: "api-key", key: "K2" });
    const second = await guard.read("anthropic");
    expect(second).toEqual({ kind: "api-key", key: "K2" });
    const changed = named(entries, "credential.changed");
    expect(changed).toHaveLength(1);
    expect(changed[0].level).toBe("warn");
    const data = changed[0].data as Record<string, unknown>;
    expect(data.previousFingerprint).toBe(fpK1);
    expect(data.fingerprint).toBe(fpK2);
    expect(data.kind).toBe("api-key");
    expect(data.onChange).toBe("warn");
  });

  test("AC-34: onChange warn + a changed api-key resolves successfully to the new credential", async () => {
    const { createChangeGuard } = await import("@/agents/native/credentials/change-guard");
    freshGlobalDir();
    captureLog();
    const inner = stubInnerStore({ kind: "api-key", key: "K1" });
    const guard = createChangeGuard(inner, { onChange: "warn", describe: () => ({ source: "file" }) });
    await guard.read("anthropic");
    inner.set({ kind: "api-key", key: "K2" });
    const second = await guard.read("anthropic");
    expect(second).toEqual({ kind: "api-key", key: "K2" });
  });

  test("AC-35: onChange refuse + a changed api-key rejects NaxError CREDENTIAL_CHANGED", async () => {
    const { createChangeGuard } = await import("@/agents/native/credentials/change-guard");
    freshGlobalDir();
    captureLog();
    const inner = stubInnerStore({ kind: "api-key", key: "K1" });
    const guard = createChangeGuard(inner, { onChange: "refuse", describe: () => ({ source: "file" }) });
    await guard.read("anthropic");
    inner.set({ kind: "api-key", key: "K2" });
    await rejectsNaxCode(guard.read("anthropic"), "CREDENTIAL_CHANGED");
  });

  test("AC-36: after one CREDENTIAL_CHANGED throw, a further read of the same new credential throws again", async () => {
    const { createChangeGuard } = await import("@/agents/native/credentials/change-guard");
    freshGlobalDir();
    captureLog();
    const inner = stubInnerStore({ kind: "api-key", key: "K1" });
    const guard = createChangeGuard(inner, { onChange: "refuse", describe: () => ({ source: "file" }) });
    await guard.read("anthropic");
    inner.set({ kind: "api-key", key: "K2" });
    await rejectsNaxCode(guard.read("anthropic"), "CREDENTIAL_CHANGED");
    await rejectsNaxCode(guard.read("anthropic"), "CREDENTIAL_CHANGED");
  });

  test("AC-37: an api-key → oauth kind change logs exactly one credential.changed at warn under onChange warn", async () => {
    const { createChangeGuard } = await import("@/agents/native/credentials/change-guard");
    freshGlobalDir();
    const entries = captureLog();
    const inner = stubInnerStore({ kind: "api-key", key: "K" });
    const guard = createChangeGuard(inner, { onChange: "warn", describe: () => ({ source: "file" }) });
    await guard.read("anthropic");
    entries.length = 0;
    inner.set({ kind: "oauth", access: "A", refresh: "R1", expires: 1 });
    await guard.read("anthropic");
    const changed = named(entries, "credential.changed");
    expect(changed).toHaveLength(1);
    expect(changed[0].level).toBe("warn");
  });

  test("AC-38: onChange refuse + an oauth refresh-token rotation resolves to the new credential", async () => {
    const { createChangeGuard } = await import("@/agents/native/credentials/change-guard");
    freshGlobalDir();
    captureLog();
    const inner = stubInnerStore({ kind: "oauth", access: "A1", refresh: "R1", expires: 1 });
    const guard = createChangeGuard(inner, { onChange: "refuse", describe: () => ({ source: "file" }) });
    await guard.read("anthropic");
    inner.set({ kind: "oauth", access: "A2", refresh: "R2", expires: 2 });
    const second = await guard.read("anthropic");
    expect(second).toEqual({ kind: "oauth", access: "A2", refresh: "R2", expires: 2 });
  });

  test("AC-39: an oauth refresh-token rotation logs credential.renewed at info with both fingerprints", async () => {
    const { fingerprintCredential } = await import("@/agents/native/credentials/fingerprint");
    const { createChangeGuard } = await import("@/agents/native/credentials/change-guard");
    freshGlobalDir();
    const entries = captureLog();
    const inner = stubInnerStore({ kind: "oauth", access: "A1", refresh: "R1", expires: 1 });
    const guard = createChangeGuard(inner, { onChange: "warn", describe: () => ({ source: "file" }) });
    await guard.read("anthropic");
    const fpR1 = await fingerprintCredential({ kind: "oauth", access: "A1", refresh: "R1", expires: 1 });
    const fpR2 = await fingerprintCredential({ kind: "oauth", access: "A2", refresh: "R2", expires: 2 });
    entries.length = 0;
    inner.set({ kind: "oauth", access: "A2", refresh: "R2", expires: 2 });
    await guard.read("anthropic");
    const renewed = named(entries, "credential.renewed");
    expect(renewed).toHaveLength(1);
    expect(renewed[0].level).toBe("info");
    const data = renewed[0].data as Record<string, unknown>;
    expect(data.previousFingerprint).toBe(fpR1);
    expect(data.fingerprint).toBe(fpR2);
    expect(data.kind).toBe("oauth");
  });

  test("AC-40: onChange refuse + same-account api-key rotation logs credential.renewed with previousAccount/account", async () => {
    const { fingerprintCredential } = await import("@/agents/native/credentials/fingerprint");
    const { createChangeGuard } = await import("@/agents/native/credentials/change-guard");
    freshGlobalDir();
    const entries = captureLog();
    const inner = stubInnerStore({ kind: "api-key", key: "K1" });
    const guard = createChangeGuard(inner, {
      onChange: "refuse",
      describe: () => ({ source: "exec", account: "team-a" }),
    });
    await guard.read("anthropic");
    const fpK1 = await fingerprintCredential({ kind: "api-key", key: "K1" });
    const fpK2 = await fingerprintCredential({ kind: "api-key", key: "K2" });
    entries.length = 0;
    inner.set({ kind: "api-key", key: "K2" });
    await guard.read("anthropic");
    const renewed = named(entries, "credential.renewed");
    expect(renewed).toHaveLength(1);
    expect(renewed[0].level).toBe("info");
    const data = renewed[0].data as Record<string, unknown>;
    expect(data.previousAccount).toBe("team-a");
    expect(data.account).toBe("team-a");
    expect(data.previousFingerprint).toBe(fpK1);
    expect(data.fingerprint).toBe(fpK2);
  });

  test("AC-41: onChange refuse + same-account api-key rotation resolves to the new credential", async () => {
    const { createChangeGuard } = await import("@/agents/native/credentials/change-guard");
    freshGlobalDir();
    captureLog();
    const inner = stubInnerStore({ kind: "api-key", key: "K1" });
    const guard = createChangeGuard(inner, {
      onChange: "refuse",
      describe: () => ({ source: "exec", account: "team-a" }),
    });
    await guard.read("anthropic");
    inner.set({ kind: "api-key", key: "K2" });
    const second = await guard.read("anthropic");
    expect(second).toEqual({ kind: "api-key", key: "K2" });
  });

  test("AC-42: onChange refuse + an account-label change on an identical credential rejects CREDENTIAL_CHANGED", async () => {
    const { createChangeGuard } = await import("@/agents/native/credentials/change-guard");
    freshGlobalDir();
    captureLog();
    let described: { source: "exec"; account: string } = { source: "exec", account: "team-a" };
    const inner = stubInnerStore({ kind: "api-key", key: "K" });
    const guard = createChangeGuard(inner, { onChange: "refuse", describe: () => described });
    await guard.read("anthropic");
    described = { source: "exec", account: "team-b" };
    await rejectsNaxCode(guard.read("anthropic"), "CREDENTIAL_CHANGED");
  });

  test("AC-43: a read returning undefined after a stored identity logs zero credential.* entries and resolves undefined", async () => {
    const { createChangeGuard } = await import("@/agents/native/credentials/change-guard");
    freshGlobalDir();
    const entries = captureLog();
    const inner = stubInnerStore({ kind: "api-key", key: "K" });
    const guard = createChangeGuard(inner, { onChange: "warn", describe: () => ({ source: "file" }) });
    await guard.read("anthropic");
    entries.length = 0;
    inner.set(undefined);
    const result = await guard.read("anthropic");
    expect(result).toBeUndefined();
    expect(namedLike(entries, /^credential\./)).toHaveLength(0);
  });

  test("AC-44: a read returning the original credential after an intervening undefined logs nothing and deep-equals it", async () => {
    const { createChangeGuard } = await import("@/agents/native/credentials/change-guard");
    freshGlobalDir();
    const entries = captureLog();
    const original: GuardCredential = { kind: "api-key", key: "K1" };
    const inner = stubInnerStore(original);
    const guard = createChangeGuard(inner, { onChange: "warn", describe: () => ({ source: "file" }) });
    await guard.read("anthropic");
    inner.set(undefined);
    await guard.read("anthropic");
    entries.length = 0;
    inner.set(original);
    const third = await guard.read("anthropic");
    expect(third).toEqual(original);
    expect(namedLike(entries, /^credential\./)).toHaveLength(0);
  });

  test("AC-45: servedAuth is undefined before any read, then tracks the last read's fingerprint/source/account", async () => {
    const { fingerprintCredential } = await import("@/agents/native/credentials/fingerprint");
    const { createChangeGuard } = await import("@/agents/native/credentials/change-guard");
    freshGlobalDir();
    captureLog();
    const inner = stubInnerStore({ kind: "api-key", key: "K" });
    const guard = createChangeGuard(inner, {
      onChange: "warn",
      describe: () => ({ source: "exec", account: "team-a" }),
    });
    expect(guard.servedAuth("anthropic")).toBeUndefined();
    await guard.read("anthropic");
    const fpK = await fingerprintCredential({ kind: "api-key", key: "K" });
    expect(guard.servedAuth("anthropic")).toEqual({ fingerprint: fpK, source: "exec", account: "team-a" });
    inner.set({ kind: "api-key", key: "K2" });
    await guard.read("anthropic");
    const fpK2 = await fingerprintCredential({ kind: "api-key", key: "K2" });
    expect(guard.servedAuth("anthropic")?.fingerprint).toBe(fpK2);
  });

  test("AC-46: no credential.* log entry carries sentinel key material or a secret-shaped data key", async () => {
    const { fingerprintCredential } = await import("@/agents/native/credentials/fingerprint");
    const { createChangeGuard } = await import("@/agents/native/credentials/change-guard");
    const dir = freshGlobalDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "auth-fingerprint-salt"), Buffer.alloc(32, 9));
    const entries = captureLog();
    const inner = stubInnerStore({
      kind: "api-key",
      key: "SENTINEL-KEY-VALUE",
    });
    const guard = createChangeGuard(inner, { onChange: "warn", describe: () => ({ source: "file" }) });
    await guard.read("anthropic");
    inner.set({ kind: "oauth", access: "SENTINEL-ACCESS-VALUE", refresh: "SENTINEL-REFRESH-VALUE", expires: 1 });
    await guard.read("anthropic");
    await fingerprintCredential({ kind: "api-key", key: "SENTINEL-KEY-VALUE" });
    const credentialEntries = namedLike(entries, /^credential\./);
    expect(credentialEntries.length).toBeGreaterThan(0);
    for (const entry of credentialEntries) {
      const serialized = JSON.stringify(entry.data ?? {});
      expect(serialized).not.toContain("SENTINEL-KEY-VALUE");
      expect(serialized).not.toContain("SENTINEL-REFRESH-VALUE");
      expect(serialized).not.toContain("SENTINEL-ACCESS-VALUE");
      expect(findSecretShapedKey(entry.data)).toBeNull();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-003 — exec helper source
// ─────────────────────────────────────────────────────────────────────────────

async function makeExecSource(options: { command: string[]; timeoutMs?: number }) {
  const { createExecCredentialSource } = await import("@/agents/native/credentials/exec-source");
  return createExecCredentialSource(options);
}

describe("credential-sources exec credential source", () => {
  test("AC-47: read spawns the helper as [helperPath, \"get\"] — argv recorded by the helper itself", async () => {
    const dir = tempDir("nax-credsrc-helper-");
    const argvSentinel = join(dir, "argv.json");
    const helper = writeExecutableScript(
      dir,
      "helper-argv.sh",
      `printf '["%s","%s"]\\n' "$0" "$1" > '${argvSentinel}'\nprintf '{"version":1,"kind":"api-key","key":"HELPER-KEY"}\\n'`,
    );
    const source = await makeExecSource({ command: [helper] });
    await source.read("anthropic");
    expect(JSON.parse(readFileSync(argvSentinel, "utf8"))).toEqual([helper, "get"]);
  });

  test("AC-48: the helper receives {\"version\":1,\"providerId\":\"anthropic\"} on stdin, and stdin is closed", async () => {
    const dir = tempDir("nax-credsrc-helper-");
    const stdinSentinel = join(dir, "stdin.txt");
    const closedSentinel = join(dir, "stdin-closed.txt");
    const helper = writeExecutableScript(
      dir,
      "helper-stdin.sh",
      `cat > '${stdinSentinel}'\nprintf 'closed\\n' > '${closedSentinel}'\nprintf '{"version":1,"kind":"api-key","key":"HELPER-KEY"}\\n'`,
    );
    const source = await makeExecSource({ command: [helper] });
    await source.read("anthropic");
    const stdin = readFileSync(stdinSentinel, "utf8");
    expect(stdin.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(stdin)).toEqual({ version: 1, providerId: "anthropic" });
    expect(existsSync(closedSentinel)).toBe(true);
  });

  test("AC-49: a credential reply resolves to exactly {kind:\"api-key\", key:\"HELPER-KEY\"}", async () => {
    const dir = tempDir("nax-credsrc-helper-");
    const helper = writeExecutableScript(
      dir,
      "helper-ok.sh",
      `printf '{"version":1,"kind":"api-key","key":"HELPER-KEY"}\\n'`,
    );
    const source = await makeExecSource({ command: [helper] });
    const credential = await source.read("anthropic");
    expect(credential).toEqual({ kind: "api-key", key: "HELPER-KEY" });
  });

  test("AC-50: a lease with no expiresAt is reused — the second read spawns the helper only once", async () => {
    const dir = tempDir("nax-credsrc-helper-");
    const counter = join(dir, "spawns");
    const doneMarker = join(dir, "first-done");
    const helper = writeExecutableScript(
      dir,
      "helper-lease.sh",
      `printf 'x' >> '${counter}'\nif [ -f '${doneMarker}' ]; then\n  printf '{"version":1,"kind":"api-key","key":"K2"}\\n'\nelse\n  touch '${doneMarker}'\n  printf '{"version":1,"kind":"api-key","key":"K"}\\n'\nfi`,
    );
    const source = await makeExecSource({ command: [helper] });
    const first = await source.read("anthropic");
    const second = await source.read("anthropic");
    expect(first).toEqual({ kind: "api-key", key: "K" });
    expect(second).toEqual({ kind: "api-key", key: "K" });
    expect(spawnCount(counter)).toBe(1);
  });

  test("AC-51: a lease 30s from expiry is not fresh — the second read spawns again and returns the new lease", async () => {
    const dir = tempDir("nax-credsrc-helper-");
    const counter = join(dir, "spawns");
    const doneMarker = join(dir, "first-done");
    const soon = String(Date.now() + 30000);
    const helper = writeExecutableScript(
      dir,
      "helper-expiring.sh",
      `printf 'x' >> '${counter}'\nif [ -f '${doneMarker}' ]; then\n  printf '{"version":1,"kind":"api-key","key":"K2"}\\n'\nelse\n  touch '${doneMarker}'\n  printf '{"version":1,"kind":"api-key","key":"K1","expiresAt":${soon}}\\n'\nfi`,
    );
    const source = await makeExecSource({ command: [helper] });
    const first = await source.read("anthropic");
    const second = await source.read("anthropic");
    // read() resolves to {kind,key} only — the lease's expiresAt stays internal to the
    // source (SPEC-credential-sources.md:78, nax-ai's StoredCredential), so the spawn
    // count is what shows the 30s lease was not fresh.
    expect(first).toEqual({ kind: "api-key", key: "K1" });
    expect(second).toEqual({ kind: "api-key", key: "K2" });
    expect(spawnCount(counter)).toBe(2);
  }, 15000);

  test("AC-52: a lease 5 minutes from expiry is fresh — the second read reuses it without spawning", async () => {
    const dir = tempDir("nax-credsrc-helper-");
    const counter = join(dir, "spawns");
    const doneMarker = join(dir, "first-done");
    const later = String(Date.now() + 300000);
    const helper = writeExecutableScript(
      dir,
      "helper-fresh.sh",
      `printf 'x' >> '${counter}'\nif [ -f '${doneMarker}' ]; then\n  printf '{"version":1,"kind":"api-key","key":"K2"}\\n'\nelse\n  touch '${doneMarker}'\n  printf '{"version":1,"kind":"api-key","key":"K1","expiresAt":${later}}\\n'\nfi`,
    );
    const source = await makeExecSource({ command: [helper] });
    const first = await source.read("anthropic");
    const second = await source.read("anthropic");
    // Same-lease reuse, asserted on the values read() actually returns; one spawn
    // is what proves the far-future lease was fresh.
    expect(first).toEqual({ kind: "api-key", key: "K1" });
    expect(second).toEqual({ kind: "api-key", key: "K1" });
    expect(spawnCount(counter)).toBe(1);
  }, 15000);

  test("AC-53: two concurrent reads with no lease spawn the helper exactly once (single-flight)", async () => {
    const dir = tempDir("nax-credsrc-helper-");
    const counter = join(dir, "spawns");
    // Delay the reply so the two reads overlap while the helper is running.
    const slowHelper = writeExecutableScript(
      dir,
      "helper-slow2.sh",
      `sleep 0.4\nprintf 'x' >> '${counter}'\nprintf '{"version":1,"kind":"api-key","key":"K1"}\\n'`,
    );
    const source = await makeExecSource({ command: [slowHelper] });
    const [a, b] = await Promise.all([source.read("anthropic"), source.read("anthropic")]);
    expect((a as { key: string }).key).toBe("K1");
    expect((b as { key: string }).key).toBe("K1");
    expect(spawnCount(counter)).toBe(1);
  }, 15000);

  test("AC-54: a decline reply makes read resolve undefined", async () => {
    const dir = tempDir("nax-credsrc-helper-");
    const counter = join(dir, "spawns");
    const helper = writeExecutableScript(
      dir,
      "helper-decline.sh",
      `printf 'x' >> '${counter}'\nprintf '{"version":1,"decline":true}\\n'`,
    );
    const source = await makeExecSource({ command: [helper] });
    const result = await source.read("anthropic");
    expect(result).toBeUndefined();
  });

  test("AC-55: a decline is remembered — the second read resolves undefined with only one spawn", async () => {
    const dir = tempDir("nax-credsrc-helper-");
    const counter = join(dir, "spawns");
    const helper = writeExecutableScript(
      dir,
      "helper-decline2.sh",
      `printf 'x' >> '${counter}'\nprintf '{"version":1,"decline":true}\\n'`,
    );
    const source = await makeExecSource({ command: [helper] });
    const first = await source.read("anthropic");
    const second = await source.read("anthropic");
    expect(first).toBeUndefined();
    expect(second).toBeUndefined();
    expect(spawnCount(counter)).toBe(1);
  }, 15000);

  test("AC-56: a helper exiting 1 with no lease rejects NaxError CREDENTIAL_HELPER_FAILED", async () => {
    const dir = tempDir("nax-credsrc-helper-");
    const helper = writeExecutableScript(dir, "helper-fail.sh", `exit 1`);
    const source = await makeExecSource({ command: [helper] });
    await rejectsNaxCode(source.read("anthropic"), "CREDENTIAL_HELPER_FAILED");
  });

  test("AC-57: a helper still running at timeoutMs rejects CREDENTIAL_HELPER_FAILED within the budget and the child is killed", async () => {
    const dir = tempDir("nax-credsrc-helper-");
    const pidFile = join(dir, "pid");
    writeExecutableScript(
      dir,
      "helper-hang.sh",
      `printf '%s\\n' "$$" > '${pidFile}'\ntrap 'rm -f '${pidFile}'; exit 143' TERM INT HUP\nsleep 30`,
    );
    const source = await makeExecSource({ command: [helper_hangPath(dir)], timeoutMs: 1200 });
    const started = Date.now();
    await rejectsNaxCode(source.read("anthropic"), "CREDENTIAL_HELPER_FAILED");
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(1050);
    expect(elapsed).toBeLessThan(15000);
    const terminated = await pollUntil(() => {
      if (!existsSync(pidFile)) return true;
      const pid = Number(readFileSync(pidFile, "utf8").trim());
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    }, 3000);
    expect(terminated).toBe(true);
  }, 20000);

  test("AC-58: a nonexistent helper binary rejects NaxError CREDENTIAL_HELPER_FAILED", async () => {
    const source = await makeExecSource({ command: ["/nonexistent/path/no-such-helper"] });
    await rejectsNaxCode(source.read("anthropic"), "CREDENTIAL_HELPER_FAILED");
  }, 15000);

  test("AC-59: a failing helper with no lease logs exactly one credential.helper_failed with servedLastGood false", async () => {
    const dir = tempDir("nax-credsrc-helper-");
    const helper = writeExecutableScript(dir, "helper-fail2.sh", `exit 1`);
    const source = await makeExecSource({ command: [helper] });
    const entries = captureLog();
    await rejectsNaxCode(source.read("anthropic"), "CREDENTIAL_HELPER_FAILED");
    const failed = named(entries, "credential.helper_failed");
    expect(failed).toHaveLength(1);
    const data = failed[0].data as Record<string, unknown>;
    expect(data.servedLastGood).toBe(false);
    expect(data.providerId).toBe("anthropic");
    expect(data.code).toBe("CREDENTIAL_HELPER_FAILED");
    expect(data.exitCode).toBe(1);
    expect(findSecretShapedKey(data)).toBeNull();
  }, 15000);

  test("AC-60: a reply with kind \"oauth\" rejects NaxError CREDENTIAL_HELPER_INVALID", async () => {
    const dir = tempDir("nax-credsrc-helper-");
    const helper = writeExecutableScript(
      dir,
      "helper-oauth.sh",
      `printf '{"version":1,"kind":"oauth","key":"K"}\\n'`,
    );
    const source = await makeExecSource({ command: [helper] });
    await rejectsNaxCode(source.read("anthropic"), "CREDENTIAL_HELPER_INVALID");
  });

  test("AC-61: a non-JSON reply rejects CREDENTIAL_HELPER_INVALID", async () => {
    const dir = tempDir("nax-credsrc-helper-");
    const helper = writeExecutableScript(dir, "helper-notjson.sh", `printf 'not json\\n'`);
    const source = await makeExecSource({ command: [helper] });
    await rejectsNaxCode(source.read("anthropic"), "CREDENTIAL_HELPER_INVALID");
  });

  test("AC-62: a reply with version 2 rejects CREDENTIAL_HELPER_INVALID", async () => {
    const dir = tempDir("nax-credsrc-helper-");
    const helper = writeExecutableScript(
      dir,
      "helper-v2.sh",
      `printf '{"version":2,"kind":"api-key","key":"K"}\\n'`,
    );
    const source = await makeExecSource({ command: [helper] });
    await rejectsNaxCode(source.read("anthropic"), "CREDENTIAL_HELPER_INVALID");
  });

  test("AC-63: a reply whose expiresAt is already past rejects CREDENTIAL_HELPER_INVALID", async () => {
    const dir = tempDir("nax-credsrc-helper-");
    const expired = String(Date.now() - 1000);
    const helper = writeExecutableScript(
      dir,
      "helper-expired.sh",
      `printf '{"version":1,"kind":"api-key","key":"K","expiresAt":${expired}}\\n'`,
    );
    const source = await makeExecSource({ command: [helper] });
    await rejectsNaxCode(source.read("anthropic"), "CREDENTIAL_HELPER_INVALID");
  });

  test("AC-64: stdout beyond AUTH_HELPER_STDOUT_MAX_BYTES rejects CREDENTIAL_HELPER_INVALID and the child is killed", async () => {
    const { AUTH_HELPER_STDOUT_MAX_BYTES } = await import("@/agents/native/credentials/exec-source");
    const dir = tempDir("nax-credsrc-helper-");
    const pidFile = join(dir, "pid");
    const lines = Math.ceil((AUTH_HELPER_STDOUT_MAX_BYTES + 6000) / 102);
    writeExecutableScript(
      dir,
      "helper-flood.sh",
      `printf '%s\\n' "$$" > '${pidFile}'\ni=0\nwhile [ "$i" -lt ${lines} ]; do\n  printf '%101s\\n' x\n  i=$(( i + 1 ))\ndone\nsleep 30`,
    );
    const source = await makeExecSource({ command: [join(dir, "helper-flood.sh")], timeoutMs: 3000 });
    await rejectsNaxCode(source.read("anthropic"), "CREDENTIAL_HELPER_INVALID");
    const terminated = await pollUntil(() => {
      if (!existsSync(pidFile)) return true;
      const pid = Number(readFileSync(pidFile, "utf8").trim());
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    }, 3000);
    expect(terminated).toBe(true);
  }, 20000);

  test("AC-65: a failing helper with a live last-good lease serves that lease (2 spawns)", async () => {
    const dir = tempDir("nax-credsrc-helper-");
    const counter = join(dir, "spawns");
    const doneMarker = join(dir, "first-done");
    const soon = String(Date.now() + 30000);
    const helper = writeExecutableScript(
      dir,
      "helper-lastgood.sh",
      `printf 'x' >> '${counter}'\nif [ -f '${doneMarker}' ]; then\n  exit 1\nelse\n  touch '${doneMarker}'\n  printf '{"version":1,"kind":"api-key","key":"GOOD","expiresAt":${soon}}\\n'\nfi`,
    );
    const source = await makeExecSource({ command: [helper] });
    const first = await source.read("anthropic");
    const second = await source.read("anthropic");
    expect(first).toEqual({ kind: "api-key", key: "GOOD" });
    expect(second).toEqual({ kind: "api-key", key: "GOOD" });
    expect(spawnCount(counter)).toBe(2);
  }, 15000);

  test("AC-66: serving the last-good lease through a failure logs one credential.helper_failed with a redacted stderr excerpt", async () => {
    const dir = tempDir("nax-credsrc-helper-");
    const counter = join(dir, "spawns");
    const doneMarker = join(dir, "first-done");
    const soon = String(Date.now() + 30000);
    const helper = writeExecutableScript(
      dir,
      "helper-lastgood2.sh",
      `printf 'x' >> '${counter}'\nif [ -f '${doneMarker}' ]; then\n  printf 'api_key=sk-secret123\\n' >&2\n  exit 1\nelse\n  touch '${doneMarker}'\n  printf '{"version":1,"kind":"api-key","key":"GOOD","expiresAt":${soon}}\\n'\nfi`,
    );
    const source = await makeExecSource({ command: [helper] });
    const entries = captureLog();
    await source.read("anthropic");
    const second = await source.read("anthropic");
    expect(second).toEqual({ kind: "api-key", key: "GOOD" });
    const failed = named(entries, "credential.helper_failed");
    expect(failed).toHaveLength(1);
    const data = failed[0].data as Record<string, unknown>;
    expect(data.servedLastGood).toBe(true);
    expect(data.providerId).toBe("anthropic");
    expect(data.code).toBe("CREDENTIAL_HELPER_FAILED");
    expect(data.exitCode).toBe(1);
    expect(data.timedOut).toBe(false);
    const stderrField = Object.keys(data).find((key) => /stderr/i.test(key));
    expect(typeof stderrField).toBe("string");
    expect(typeof data[stderrField as string]).toBe("string");
    expect(JSON.stringify(data)).not.toContain("sk-secret123");
  }, 15000);

  test("AC-67: a failing helper with an EXPIRED last-good lease rejects CREDENTIAL_HELPER_FAILED", async () => {
    const dir = tempDir("nax-credsrc-helper-");
    const counter = join(dir, "spawns");
    const doneMarker = join(dir, "first-done");
    // The lease must outlive the helper's cold exec (a few hundred ms on a path the
    // OS has not seen) and still expire inside the test: one that is already past at
    // receipt is INVALID, not a lease (AC-63).
    const shortly = String(Date.now() + 3000);
    const helper = writeExecutableScript(
      dir,
      "helper-expired2.sh",
      `printf 'x' >> '${counter}'\nif [ -f '${doneMarker}' ]; then\n  exit 1\nelse\n  touch '${doneMarker}'\n  printf '{"version":1,"kind":"api-key","key":"GOOD","expiresAt":${shortly}}\\n'\nfi`,
    );
    const source = await makeExecSource({ command: [helper] });
    const first = await source.read("anthropic");
    expect(first).toEqual({ kind: "api-key", key: "GOOD" });
    // Let the lease expire, then fail.
    await pollUntil(() => Date.now() > Number(shortly), 8000);
    await rejectsNaxCode(source.read("anthropic"), "CREDENTIAL_HELPER_FAILED");
  }, 15000);

  test("AC-68: a consecutive-failure streak on a live last-good lease serves both reads but logs helper_failed once", async () => {
    const dir = tempDir("nax-credsrc-helper-");
    const counter = join(dir, "spawns");
    const doneMarker = join(dir, "first-done");
    const soon = String(Date.now() + 30000);
    const helper = writeExecutableScript(
      dir,
      "helper-streak.sh",
      `printf 'x' >> '${counter}'\nif [ -f '${doneMarker}' ]; then\n  exit 1\nelse\n  touch '${doneMarker}'\n  printf '{"version":1,"kind":"api-key","key":"GOOD","expiresAt":${soon}}\\n'\nfi`,
    );
    const source = await makeExecSource({ command: [helper] });
    const entries = captureLog();
    const first = await source.read("anthropic");
    const second = await source.read("anthropic");
    expect(first).toEqual({ kind: "api-key", key: "GOOD" });
    expect(second).toEqual({ kind: "api-key", key: "GOOD" });
    expect(named(entries, "credential.helper_failed")).toHaveLength(1);
  }, 15000);

  test("AC-69: a decline reply while a lease is held rejects CREDENTIAL_HELPER_INVALID", async () => {
    const dir = tempDir("nax-credsrc-helper-");
    const counter = join(dir, "spawns");
    const doneMarker = join(dir, "first-done");
    // Same cold-exec margin as AC-67: the lease has to be live when the reply is
    // read and expired by the time of the second read.
    const shortly = String(Date.now() + 3000);
    const helper = writeExecutableScript(
      dir,
      "helper-decline-after-lease.sh",
      `printf 'x' >> '${counter}'\nif [ -f '${doneMarker}' ]; then\n  printf '{"version":1,"decline":true}\\n'\nelse\n  touch '${doneMarker}'\n  printf '{"version":1,"kind":"api-key","key":"GOOD","expiresAt":${shortly}}\\n'\nfi`,
    );
    const source = await makeExecSource({ command: [helper] });
    const first = await source.read("anthropic");
    expect(first).toEqual({ kind: "api-key", key: "GOOD" });
    await pollUntil(() => Date.now() > Number(shortly), 8000);
    await rejectsNaxCode(source.read("anthropic"), "CREDENTIAL_HELPER_INVALID");
  }, 15000);
});

/** The AC-57 script is written to a fixed name; helper returns its path. */
function helper_hangPath(dir: string): string {
  return join(dir, "helper-hang.sh");
}

// ─────────────────────────────────────────────────────────────────────────────
// US-004 — chained store
// ─────────────────────────────────────────────────────────────────────────────

interface SpyFileStore {
  read(p: string): Promise<GuardCredential | undefined>;
  modify(p: string, fn: (current: GuardCredential | undefined) => Promise<GuardCredential | undefined>): Promise<GuardCredential | undefined>;
  delete(p: string): Promise<void>;
}

function spyFileStore(credential?: GuardCredential, readError?: Error): SpyFileStore {
  return {
    read: mock(async () => {
      if (readError !== undefined) throw readError;
      return credential;
    }),
    modify: mock(async (_p, fn) => fn(credential)),
    delete: mock(async () => {}),
  };
}

async function makeChainedStore(options: { exec?: { command: string[]; timeoutMs?: number }; file: SpyFileStore }) {
  const { createChainedCredentialStore } = await import("@/agents/native/credentials/chained-store");
  const exec =
    options.exec !== undefined ? await makeExecSource({ command: options.exec.command, timeoutMs: options.exec.timeoutMs }) : undefined;
  return createChainedCredentialStore({ ...(exec !== undefined ? { exec } : {}), file: options.file } as never);
}

describe("credential-sources chained credential store", () => {
  test("AC-70: a declined exec read falls through to the file store's credential", async () => {
    const dir = tempDir("nax-credsrc-helper-");
    const helper = writeExecutableScript(dir, "helper-decline3.sh", `printf '{"version":1,"decline":true}\\n'`);
    const file = spyFileStore({ kind: "api-key", key: "FILE-KEY" });
    const store = await makeChainedStore({ exec: { command: [helper] }, file });
    const credential = await store.read("anthropic");
    expect(credential).toEqual({ kind: "api-key", key: "FILE-KEY" });
  });

  test("AC-71: after a declined exec read, sourceOf returns \"file\"", async () => {
    const dir = tempDir("nax-credsrc-helper-");
    const helper = writeExecutableScript(dir, "helper-decline4.sh", `printf '{"version":1,"decline":true}\\n'`);
    const file = spyFileStore({ kind: "api-key", key: "FILE-KEY" });
    const store = await makeChainedStore({ exec: { command: [helper] }, file });
    await store.read("anthropic");
    expect((store as { sourceOf(p: string): string | undefined }).sourceOf("anthropic")).toBe("file");
  });

  test("AC-72: delete on an exec-served provider throws NaxError CREDENTIAL_MANAGED_BY_HELPER", async () => {
    const dir = tempDir("nax-credsrc-helper-");
    const helper = writeExecutableScript(
      dir,
      "helper-serve1.sh",
      `printf '{"version":1,"kind":"api-key","key":"HELPER-KEY"}\\n'`,
    );
    const file = spyFileStore(undefined);
    const store = await makeChainedStore({ exec: { command: [helper] }, file });
    await store.read("anthropic");
    let caught: unknown;
    try {
      store.delete("anthropic");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NaxError);
    expect((caught as NaxError).code).toBe("CREDENTIAL_MANAGED_BY_HELPER");
  });

  test("AC-73: the file store's delete is never called for an exec-served provider", async () => {
    const dir = tempDir("nax-credsrc-helper-");
    const helper = writeExecutableScript(
      dir,
      "helper-serve2.sh",
      `printf '{"version":1,"kind":"api-key","key":"HELPER-KEY"}\\n'`,
    );
    const file = spyFileStore(undefined);
    const store = await makeChainedStore({ exec: { command: [helper] }, file });
    await store.read("anthropic");
    try {
      store.delete("anthropic");
    } catch {
      /* the refusal is AC-72's subject */
    }
    expect((file.delete as ReturnType<typeof mock>).mock.calls.length).toBe(0);
  });

  test("AC-74: modify on an exec-served provider throws CREDENTIAL_MANAGED_BY_HELPER and never reaches the file store", async () => {
    const dir = tempDir("nax-credsrc-helper-");
    const helper = writeExecutableScript(
      dir,
      "helper-serve3.sh",
      `printf '{"version":1,"kind":"api-key","key":"HELPER-KEY"}\\n'`,
    );
    const file = spyFileStore(undefined);
    const store = await makeChainedStore({ exec: { command: [helper] }, file });
    await store.read("anthropic");
    let caught: unknown;
    try {
      await store.modify("anthropic", (c) => c);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NaxError);
    expect((caught as NaxError).code).toBe("CREDENTIAL_MANAGED_BY_HELPER");
    expect((file.modify as ReturnType<typeof mock>).mock.calls.length).toBe(0);
  });

  test("AC-75: a file-store read failure is rethrown as NaxError CREDENTIAL_FILE_UNREADABLE", async () => {
    const file = spyFileStore(undefined, new Error("boom"));
    const store = await makeChainedStore({ file });
    await expect(store.read("anthropic")).rejects.toMatchObject({ code: "CREDENTIAL_FILE_UNREADABLE" });
  });

  test("AC-76: the CREDENTIAL_FILE_UNREADABLE error carries the original error as cause", async () => {
    const original = new Error("boom");
    const file = spyFileStore(undefined, original);
    const store = await makeChainedStore({ file });
    let caught: unknown;
    try {
      await store.read("anthropic");
    } catch (err) {
      caught = err;
    }
    expect((caught as NaxError).code).toBe("CREDENTIAL_FILE_UNREADABLE");
    expect((caught as { cause?: unknown }).cause).toBe(original);
  });

  test("AC-77: a failing helper's stderr secret never reaches the CREDENTIAL_HELPER_FAILED message", async () => {
    const dir = tempDir("nax-credsrc-helper-");
    const helper = writeExecutableScript(
      dir,
      "helper-leak.sh",
      `printf 'api_key=sk-secret123\\n' >&2\nexit 1`,
    );
    const source = await makeExecSource({ command: [helper] });
    let caught: unknown;
    try {
      await source.read("anthropic");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NaxError);
    expect((caught as NaxError).code).toBe("CREDENTIAL_HELPER_FAILED");
    expect((caught as Error).message).not.toContain("sk-secret123");
  });

  test("AC-78: an exec source's own delete throws CREDENTIAL_MANAGED_BY_HELPER without spawning the helper", async () => {
    const dir = tempDir("nax-credsrc-helper-");
    const counter = join(dir, "spawns");
    const helper = writeExecutableScript(
      dir,
      "helper-serve4.sh",
      `printf 'x' >> '${counter}'\nprintf '{"version":1,"kind":"api-key","key":"HELPER-KEY"}\\n'`,
    );
    const source = await makeExecSource({ command: [helper] });
    let caught: unknown;
    try {
      source.delete("anthropic");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NaxError);
    expect((caught as NaxError).code).toBe("CREDENTIAL_MANAGED_BY_HELPER");
    expect(spawnCount(counter)).toBe(0);
  });

  test("AC-79: accountOf returns the exec reply's account label after the exec source served the provider", async () => {
    const dir = tempDir("nax-credsrc-helper-");
    const helper = writeExecutableScript(
      dir,
      "helper-account.sh",
      `printf '{"version":1,"kind":"api-key","key":"HELPER-KEY","account":"team-a"}\\n'`,
    );
    const file = spyFileStore(undefined);
    const store = await makeChainedStore({ exec: { command: [helper] }, file });
    await store.read("anthropic");
    expect((store as { accountOf(p: string): string | undefined }).accountOf("anthropic")).toBe("team-a");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-004 — assembled store, provider probes, and client wiring
// ─────────────────────────────────────────────────────────────────────────────

describe("credential-sources assembled store and probes", () => {
  test("AC-80: after naxCredentialStore().read under auth.source exec, servedAuth reports exec/team-a", async () => {
    const dir = freshGlobalDir();
    const helperDir = tempDir("nax-credsrc-helper-");
    const helper = writeExecutableScript(
      helperDir,
      "helper-team.sh",
      `printf '{"version":1,"kind":"api-key","key":"HELPER-KEY","account":"team-a"}\\n'`,
    );
    writeGlobalConfig(dir, { auth: { source: "exec", exec: { command: [helper] } } });
    const credentials = await import("@/agents/native/credentials");
    credentials._resetCredentialStore();
    await credentials.naxCredentialStore().read("anthropic");
    expect(credentials.servedAuth("anthropic")).toEqual({ source: "exec", account: "team-a" });
  });

  test("AC-81: providersWithoutCredentials returns [] when the credentials file holds the provider", async () => {
    const dir = freshGlobalDir();
    writeCredentialsFile(dir, { anthropic: { kind: "api-key", key: "STORED-KEY" } });
    const missing = await providersWithoutCredentials(["anthropic"]);
    expect(missing).toEqual([]);
  });

  test("AC-82: the probe logs credential.resolved for the provider with a 12-hex fingerprint and no key material", async () => {
    const dir = freshGlobalDir();
    writeCredentialsFile(dir, { anthropic: { kind: "api-key", key: "STORED-KEY" } });
    const entries = captureLog();
    await providersWithoutCredentials(["anthropic"]);
    const resolved = entries.filter((entry) => entry.message.includes("credential.resolved"));
    expect(resolved.length).toBeGreaterThanOrEqual(1);
    const anthropic = resolved.find((entry) => (entry.data as Record<string, unknown> | undefined)?.providerId === "anthropic");
    expect(anthropic).toBeDefined();
    const data = anthropic?.data as Record<string, unknown>;
    expect(String(data.fingerprint)).toMatch(/^[0-9a-f]{12}$/);
    expect(JSON.stringify(data)).not.toContain("STORED-KEY");
  });

  test("AC-83: a failing helper makes providersWithoutCredentials reject NaxError CREDENTIAL_HELPER_FAILED", async () => {
    const dir = freshGlobalDir();
    const helperDir = tempDir("nax-credsrc-helper-");
    const helper = writeExecutableScript(helperDir, "helper-fail3.sh", `exit 1`);
    writeGlobalConfig(dir, { auth: { source: "exec", exec: { command: [helper] } } });
    _resetCredentialStore();
    await expect(providersWithoutCredentials(["anthropic"])).rejects.toMatchObject({ code: "CREDENTIAL_HELPER_FAILED" });
    await rejectsNaxCode(providersWithoutCredentials(["anthropic"]), "CREDENTIAL_HELPER_FAILED");
  }, 20000);

  test("AC-84: a slow helper is awaited past the ambient-probe timeout — the probe resolves [] after >= 3000ms", async () => {
    const dir = freshGlobalDir();
    const helperDir = tempDir("nax-credsrc-helper-");
    const helper = writeExecutableScript(
      helperDir,
      "helper-slow3.sh",
      `sleep 3\nprintf '{"version":1,"kind":"api-key","key":"SLOW-KEY"}\\n'`,
    );
    writeGlobalConfig(dir, { auth: { source: "exec", exec: { command: [helper] } } });
    _resetCredentialStore();
    const started = Date.now();
    const missing = await providersWithoutCredentials(["anthropic"]);
    const elapsed = Date.now() - started;
    expect(missing).toEqual([]);
    expect(elapsed).toBeGreaterThanOrEqual(2900);
  }, 20000);

  test("AC-85: an invalid credentials file makes the probe resolve [] rather than rejecting", async () => {
    const dir = freshGlobalDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "credentials"), "{oops");
    const missing = await providersWithoutCredentials(["anthropic"]);
    expect(missing).toEqual([]);
  });

  test("AC-86: onChange refuse + a rotated file key makes the second probe reject CREDENTIAL_CHANGED", async () => {
    const dir = freshGlobalDir();
    writeGlobalConfig(dir, { auth: { onChange: "refuse" } });
    const credentialsPath = writeCredentialsFile(dir, { anthropic: { kind: "api-key", key: "KEY-A" } });
    _resetCredentialStore();
    const first = await providersWithoutCredentials(["anthropic"]);
    expect(first).toEqual([]);
    writeFileSync(credentialsPath, JSON.stringify({ version: 1, credentials: { anthropic: { kind: "api-key", key: "KEY-B" } } }), {
      mode: 0o600,
    });
    const err = await rejectsNaxCode(providersWithoutCredentials(["anthropic"]), "CREDENTIAL_CHANGED");
    expect(err).toBeInstanceOf(NaxError);
  }, 20000);

  test("AC-87: hasCredentials is true under exec config without spawning the helper", async () => {
    const dir = freshGlobalDir();
    const helperDir = tempDir("nax-credsrc-helper-");
    const sentinel = join(helperDir, "sentinel");
    const helper = writeExecutableScript(helperDir, "helper-sentinel.sh", `printf 'x' >> '${sentinel}'`);
    writeGlobalConfig(dir, { auth: { source: "exec", exec: { command: [helper] } } });
    _resetCredentialStore();
    const adapter = new NativeAgentAdapter();
    const has = await adapter.hasCredentials();
    expect(has).toBe(true);
    expect(existsSync(sentinel)).toBe(false);
  }, 20000);
});

// ─────────────────────────────────────────────────────────────────────────────
// Fake OpenAI-compatible server (records every Authorization header)
// ─────────────────────────────────────────────────────────────────────────────

interface FakeLlmServer {
  baseUrl: string;
  authorizations: string[];
  close(): void;
}

function startFakeOpenAiServer(): FakeLlmServer {
  const authorizations: string[] = [];
  const sseChunk = (delta: object, finishReason: string | null, withUsage: boolean): string => {
    const chunk: Record<string, unknown> = {
      id: "chatcmpl-nax-acceptance",
      object: "chat.completion.chunk",
      created: 1700000000,
      model: "acceptance-model",
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    };
    if (withUsage) chunk.usage = { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 };
    return `data: ${JSON.stringify(chunk)}\n\n`;
  };
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      const auth = request.headers.get("authorization");
      if (auth !== null) authorizations.push(auth);
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode(sseChunk({ role: "assistant", content: "ok" }, null, false)));
          controller.enqueue(encoder.encode(sseChunk({}, "stop", true)));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    },
  });
  return {
    baseUrl: `http://127.0.0.1:${server.port}/v1`,
    authorizations,
    close: () => server.stop(true),
  };
}

const OVERRIDE_MODEL_ID = "acceptance-model";

function providerOverrideFor(server: FakeLlmServer): ProviderCatalogOverride {
  return {
    provider: "openai",
    baseUrl: server.baseUrl,
    models: [
      {
        id: OVERRIDE_MODEL_ID,
        protocol: "openai-completions",
        contextWindow: 128000,
        supportsTools: true,
        thinkingLevels: [],
        pricing: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  };
}

async function oneClientRequest(client: Awaited<ReturnType<typeof buildNativeClient>>): Promise<unknown> {
  const resolved = await client.model("openai", OVERRIDE_MODEL_ID);
  return client.complete(resolved, { messages: [{ role: "user", content: "hello" }] });
}

describe("credential-sources client wiring against a local OpenAI-compatible server", () => {
  let server: FakeLlmServer | undefined;

  beforeEach(() => {
    // The repo's test preload installs a throwing sentinel on _clientDeps.build;
    // these are the sanctioned opt-in tests, so restore the real builder.
    _clientDeps.build = buildNativeClient;
  });

  afterEach(() => {
    server?.close();
    server = undefined;
    _resetNativeClient();
    _clientDeps.build = ORIGINAL_BUILD;
  });

  test("AC-88: one client re-reads the credentials file between requests — request 2 sends Bearer KEY-B", async () => {
    const dir = freshGlobalDir();
    const credentialsPath = writeCredentialsFile(dir, { openai: { kind: "api-key", key: "KEY-A" } });
    server = startFakeOpenAiServer();
    _resetCredentialStore();
    const client = await buildNativeClient([providerOverrideFor(server)], { transportRetries: 0 });
    await oneClientRequest(client);
    writeFileSync(credentialsPath, JSON.stringify({ version: 1, credentials: { openai: { kind: "api-key", key: "KEY-B" } } }), {
      mode: 0o600,
    });
    await oneClientRequest(client);
    expect(server.authorizations.length).toBe(2);
    expect(server.authorizations[0]).toBe("Bearer KEY-A");
    expect(server.authorizations[1]).toBe("Bearer KEY-B");
  }, 30000);

  test("AC-89: the rotation between the two requests logs a warn credential.changed entry", async () => {
    const dir = freshGlobalDir();
    const credentialsPath = writeCredentialsFile(dir, { openai: { kind: "api-key", key: "KEY-A" } });
    server = startFakeOpenAiServer();
    _resetCredentialStore();
    const entries = captureLog();
    const client = await buildNativeClient([providerOverrideFor(server)], { transportRetries: 0 });
    await oneClientRequest(client);
    writeFileSync(credentialsPath, JSON.stringify({ version: 1, credentials: { openai: { kind: "api-key", key: "KEY-B" } } }), {
      mode: 0o600,
    });
    await oneClientRequest(client);
    const changed = entries.filter((entry) => entry.level === "warn" && entry.message.includes("credential.changed"));
    expect(changed.length).toBeGreaterThanOrEqual(1);
  }, 30000);

  test("AC-90: onChange refuse + rotation — request 2 rejects and the server never sees KEY-B", async () => {
    const dir = freshGlobalDir();
    writeGlobalConfig(dir, { auth: { onChange: "refuse" } });
    const credentialsPath = writeCredentialsFile(dir, { openai: { kind: "api-key", key: "KEY-A" } });
    server = startFakeOpenAiServer();
    _resetCredentialStore();
    const client = await buildNativeClient([providerOverrideFor(server)], { transportRetries: 0 });
    await oneClientRequest(client);
    writeFileSync(credentialsPath, JSON.stringify({ version: 1, credentials: { openai: { kind: "api-key", key: "KEY-B" } } }), {
      mode: 0o600,
    });
    await expect(oneClientRequest(client)).rejects.toThrow();
    expect(server.authorizations.length).toBeGreaterThanOrEqual(1);
    for (const authorization of server.authorizations) {
      expect(authorization).toBe("Bearer KEY-A");
    }
  }, 30000);

  test("AC-91: auth.source exec + a serving helper — the request sends Bearer HELPER-KEY", async () => {
    const dir = freshGlobalDir();
    const helperDir = tempDir("nax-credsrc-helper-");
    const helper = writeExecutableScript(
      helperDir,
      "helper-wire.sh",
      `printf '{"version":1,"kind":"api-key","key":"HELPER-KEY"}\\n'`,
    );
    writeGlobalConfig(dir, { auth: { source: "exec", exec: { command: [helper] } } });
    server = startFakeOpenAiServer();
    _resetCredentialStore();
    const client = await buildNativeClient([providerOverrideFor(server)], { transportRetries: 0 });
    await oneClientRequest(client);
    expect(server.authorizations).toEqual(["Bearer HELPER-KEY"]);
  }, 30000);

  test("AC-92: auth.source exec + a declining helper + file fallback — the request sends Bearer FILE-KEY", async () => {
    const dir = freshGlobalDir();
    const helperDir = tempDir("nax-credsrc-helper-");
    const helper = writeExecutableScript(helperDir, "helper-decline5.sh", `printf '{"version":1,"decline":true}\\n'`);
    writeGlobalConfig(dir, { auth: { source: "exec", exec: { command: [helper] } } });
    writeCredentialsFile(dir, { openai: { kind: "api-key", key: "FILE-KEY" } });
    server = startFakeOpenAiServer();
    _resetCredentialStore();
    const client = await buildNativeClient([providerOverrideFor(server)], { transportRetries: 0 });
    await oneClientRequest(client);
    expect(server.authorizations).toEqual(["Bearer FILE-KEY"]);
  }, 30000);
});

// ─────────────────────────────────────────────────────────────────────────────
// US-005 — credential fault classification
// ─────────────────────────────────────────────────────────────────────────────

describe("credential-sources fault classification", () => {
  test("AC-93: credentialFaultCode finds a CREDENTIAL_HELPER_FAILED NaxError two links down the cause chain", async () => {
    const { credentialFaultCode } = await import("@/agents/native/errors");
    const err = {
      kind: "transport",
      message: "transport",
      cause: new Error("wrapped", { cause: new NaxError("helper crashed", "CREDENTIAL_HELPER_FAILED") }),
    };
    expect(credentialFaultCode(err)).toBe("CREDENTIAL_HELPER_FAILED");
  });

  test("AC-94: a cause chain of plain Errors only yields undefined", async () => {
    const { credentialFaultCode } = await import("@/agents/native/errors");
    const err = {
      kind: "transport",
      message: "transport",
      cause: new Error("io", { cause: new Error("disk") }),
    };
    expect(credentialFaultCode(err)).toBeUndefined();
  });

  test("AC-95: a credential-fault NaxError at cause link 9 is beyond the 8-link traversal and yields undefined", async () => {
    const { credentialFaultCode } = await import("@/agents/native/errors");
    let chain: Error = new NaxError("rotated", "CREDENTIAL_CHANGED");
    for (let link = 0; link < 8; link += 1) {
      chain = new Error(`link-${link}`, { cause: chain });
    }
    const err = { kind: "transport", message: "transport", cause: chain };
    expect(credentialFaultCode(err)).toBeUndefined();
  });

  test("AC-96: a non-credential NaxError code (AGENT_NOT_FOUND) in the chain yields undefined", async () => {
    const { credentialFaultCode } = await import("@/agents/native/errors");
    const err = { kind: "transport", message: "transport", cause: new NaxError("no agent", "AGENT_NOT_FOUND") };
    expect(credentialFaultCode(err)).toBeUndefined();
  });

  test("AC-97: toAdapterFailure maps a transport fault wrapping CREDENTIAL_CHANGED to outcome fail-auth", async () => {
    const { toAdapterFailure } = await import("@/agents/native/errors");
    const failure = toAdapterFailure({
      kind: "transport",
      message: "transport",
      cause: new NaxError("rotated", "CREDENTIAL_CHANGED"),
    });
    expect(failure.outcome).toBe("fail-auth");
  });

  test("AC-98: that mapping is non-retriable", async () => {
    const { toAdapterFailure } = await import("@/agents/native/errors");
    const failure = toAdapterFailure({
      kind: "transport",
      message: "transport",
      cause: new NaxError("rotated", "CREDENTIAL_CHANGED"),
    });
    expect(failure.retriable).toBe(false);
  });

  test("AC-99: the credential-fault mapping's message names CREDENTIAL_CHANGED", async () => {
    const { toAdapterFailure } = await import("@/agents/native/errors");
    const failure = toAdapterFailure({
      kind: "transport",
      message: "transport",
      cause: new NaxError("rotated", "CREDENTIAL_CHANGED"),
    });
    expect(failure.message).toContain("CREDENTIAL_CHANGED");
  });

  test("AC-100: a kind-unknown fault wrapping CREDENTIAL_FILE_UNREADABLE still maps to fail-auth", async () => {
    const { toAdapterFailure } = await import("@/agents/native/errors");
    const failure = toAdapterFailure({
      kind: "unknown",
      message: "unknown",
      cause: new NaxError("no perms", "CREDENTIAL_FILE_UNREADABLE"),
    });
    expect(failure.outcome).toBe("fail-auth");
  });

  test("AC-101: a transport fault with no credential fault in its cause chain stays fail-service-down", async () => {
    const { toAdapterFailure } = await import("@/agents/native/errors");
    const failure = toAdapterFailure({ kind: "transport", message: "transport", cause: new Error("ECONNRESET") });
    expect(failure.outcome).toBe("fail-service-down");
  });

  test("AC-102: a transport fault wrapping CREDENTIAL_HELPER_INVALID is not a retryable transport fault", async () => {
    const { isRetryableTransportFault } = await import("@/agents/native/errors");
    const err = {
      kind: "transport",
      message: "transport",
      cause: new NaxError("bad helper", "CREDENTIAL_HELPER_INVALID"),
    };
    expect(isRetryableTransportFault(err)).toBe(false);
  });

  test("AC-103: a transport fault with a plain-Error cause chain keeps retryable transport behaviour", async () => {
    const { isRetryableTransportFault } = await import("@/agents/native/errors");
    const err = { kind: "transport", message: "transport", cause: new Error("ECONNRESET") };
    expect(isRetryableTransportFault(err)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-005 — adapter integration
// ─────────────────────────────────────────────────────────────────────────────

describe("credential-sources adapter integration (fake server + fake helper)", () => {
  let server: FakeLlmServer | undefined;

  afterEach(() => {
    server?.close();
    server = undefined;
    _resetNativeClient();
    _clientDeps.build = ORIGINAL_BUILD;
  });

  test("AC-104: a failing exec helper maps to adapterFailure fail-auth, retriable false, under default transport retries", async () => {
    const dir = freshGlobalDir();
    const helperDir = tempDir("nax-credsrc-helper-");
    const helper = writeExecutableScript(helperDir, "helper-fail4.sh", `exit 1`);
    writeGlobalConfig(dir, { auth: { source: "exec", exec: { command: [helper] } } });
    server = startFakeOpenAiServer();
    _resetCredentialStore();
    _clientDeps.build = buildNativeClient; // real builder, nax-ai's default 2 transport retries
    const adapter = new NativeAgentAdapter(["fast", "balanced", "powerful"], [providerOverrideFor(server)]);
    const result = await adapter.complete("hi", {
      modelDef: { provider: "unknown", model: `openai/${OVERRIDE_MODEL_ID}` },
      workdir: dir,
      resolvedPermissions: { mode: "approve-all", bashApproval: "raw" },
    });
    expect(result.adapterFailure?.outcome).toBe("fail-auth");
    expect(result.adapterFailure?.retriable).toBe(false);
  }, 30000);

  test("AC-105: onChange refuse + rotation — the second complete() fails auth and the server never sees KEY-B", async () => {
    const dir = freshGlobalDir();
    writeGlobalConfig(dir, { auth: { onChange: "refuse" } });
    const credentialsPath = writeCredentialsFile(dir, { openai: { kind: "api-key", key: "KEY-A" } });
    server = startFakeOpenAiServer();
    _resetCredentialStore();
    _clientDeps.build = buildNativeClient; // real builder, default transport retries
    const adapter = new NativeAgentAdapter(["fast", "balanced", "powerful"], [providerOverrideFor(server)]);
    const options = {
      modelDef: { provider: "unknown", model: `openai/${OVERRIDE_MODEL_ID}` },
      workdir: dir,
      resolvedPermissions: { mode: "approve-all", bashApproval: "raw" },
    };
    const first = await adapter.complete("hi", options);
    expect(first.adapterFailure).toBeUndefined();
    writeFileSync(credentialsPath, JSON.stringify({ version: 1, credentials: { openai: { kind: "api-key", key: "KEY-B" } } }), {
      mode: 0o600,
    });
    const second = await adapter.complete("hi", options);
    expect(second.adapterFailure?.outcome).toBe("fail-auth");
    expect(server.authorizations.length).toBeGreaterThanOrEqual(1);
    for (const authorization of server.authorizations) {
      expect(authorization).toBe("Bearer KEY-A");
    }
  }, 30000);
});

// ─────────────────────────────────────────────────────────────────────────────
// US-006 — auth stamps on results, events, cost rows
// ─────────────────────────────────────────────────────────────────────────────

describe("credential-sources auth provenance through the dispatch pipeline", () => {
  let server: FakeLlmServer | undefined;

  afterEach(() => {
    server?.close();
    server = undefined;
    _resetNativeClient();
    _clientDeps.build = ORIGINAL_BUILD;
  });

  function fileCredentialSetup(): { dir: string; credentialsPath: string } {
    const dir = freshGlobalDir();
    const credentialsPath = writeCredentialsFile(dir, { openai: { kind: "api-key", key: "KEY-A" } });
    _resetCredentialStore();
    return { dir, credentialsPath };
  }

  function zeroRetryBuild(): void {
    _clientDeps.build = (overrides) => buildNativeClient(overrides, { transportRetries: 0 });
  }

  test("AC-106: complete() stamps CompleteResult.auth with source \"file\"", async () => {
    const { dir } = fileCredentialSetup();
    server = startFakeOpenAiServer();
    zeroRetryBuild();
    const adapter = new NativeAgentAdapter(["fast", "balanced", "powerful"], [providerOverrideFor(server)]);
    const result = await adapter.complete("hi", {
      modelDef: { provider: "unknown", model: `openai/${OVERRIDE_MODEL_ID}` },
      workdir: dir,
      resolvedPermissions: { mode: "approve-all", bashApproval: "raw" },
    });
    expect(result.auth).toBeDefined();
    expect(result.auth?.source).toBe("file");
  }, 30000);

  test("AC-107: complete()'s auth fingerprint equals servedAuth(parseNativeModel(modelDef.model)) even with provider \"unknown\"", async () => {
    const { dir } = fileCredentialSetup();
    server = startFakeOpenAiServer();
    zeroRetryBuild();
    const { servedAuth } = await import("@/agents/native/credentials");
    const adapter = new NativeAgentAdapter(["fast", "balanced", "powerful"], [providerOverrideFor(server)]);
    const modelDef = { provider: "unknown", model: `openai/${OVERRIDE_MODEL_ID}` };
    const result = await adapter.complete("hi", {
      modelDef,
      workdir: dir,
      resolvedPermissions: { mode: "approve-all", bashApproval: "raw" },
    });
    const provider = parseNativeModel(modelDef.model).provider;
    expect(result.auth?.fingerprint).toEqual(servedAuth(provider)?.fingerprint);
  }, 30000);

  test("AC-108: complete() under auth.source exec stamps source \"exec\" and the helper's account", async () => {
    const dir = freshGlobalDir();
    const helperDir = tempDir("nax-credsrc-helper-");
    const helper = writeExecutableScript(
      helperDir,
      "helper-stamp.sh",
      `printf '{"version":1,"kind":"api-key","key":"HELPER-KEY","account":"team-a"}\\n'`,
    );
    writeGlobalConfig(dir, { auth: { source: "exec", exec: { command: [helper] } } });
    _resetCredentialStore();
    server = startFakeOpenAiServer();
    zeroRetryBuild();
    const adapter = new NativeAgentAdapter(["fast", "balanced", "powerful"], [providerOverrideFor(server)]);
    const result = await adapter.complete("hi", {
      modelDef: { provider: "unknown", model: `openai/${OVERRIDE_MODEL_ID}` },
      workdir: dir,
      resolvedPermissions: { mode: "approve-all", bashApproval: "raw" },
    });
    expect(result.auth?.source).toBe("exec");
    expect(result.auth?.account).toBe("team-a");
  }, 30000);

  test("AC-109: sendTurn() stamps TurnResult.auth with source \"file\"", async () => {
    const { dir } = fileCredentialSetup();
    server = startFakeOpenAiServer();
    _clientDeps.build = buildNativeClient; // default retries accepted
    const adapter = new NativeAgentAdapter(["fast", "balanced", "powerful"], [providerOverrideFor(server)]);
    const handle = await adapter.openSession(`sess-credsrc-${Date.now()}`, {
      agentName: "native",
      workdir: dir,
      resolvedPermissions: { mode: "approve-all", bashApproval: "raw" },
      modelDef: { provider: "unknown", model: `openai/${OVERRIDE_MODEL_ID}` },
      timeoutSeconds: 60,
      transcriptDir: tempDir("nax-credsrc-transcripts-"),
    });
    try {
      const result = await adapter.sendTurn(handle, "hi", {
        interactionHandler: { onInteraction: async () => ({ answer: "" }) },
      });
      expect(result.auth).toBeDefined();
      expect(result.auth?.source).toBe("file");
    } finally {
      await adapter.closeSession(handle);
    }
  }, 30000);

  test("AC-110: sendTurn()'s auth fingerprint equals servedAuth for the provider parsed from handle.modelDef.model", async () => {
    const { dir } = fileCredentialSetup();
    server = startFakeOpenAiServer();
    _clientDeps.build = buildNativeClient;
    const { servedAuth } = await import("@/agents/native/credentials");
    const adapter = new NativeAgentAdapter(["fast", "balanced", "powerful"], [providerOverrideFor(server)]);
    const modelDef = { provider: "unknown", model: `openai/${OVERRIDE_MODEL_ID}` };
    const handle = await adapter.openSession(`sess-credsrc-fp-${Date.now()}`, {
      agentName: "native",
      workdir: dir,
      resolvedPermissions: { mode: "approve-all", bashApproval: "raw" },
      modelDef,
      timeoutSeconds: 60,
      transcriptDir: tempDir("nax-credsrc-transcripts-"),
    });
    try {
      const result = await adapter.sendTurn(handle, "hi", {
        interactionHandler: { onInteraction: async () => ({ answer: "" }) },
      });
      const provider = parseNativeModel(modelDef.model).provider;
      expect(result.auth?.fingerprint).toEqual(servedAuth(provider)?.fingerprint);
    } finally {
      await adapter.closeSession(handle);
    }
  }, 30000);
});

describe("credential-sources auth stamping through events and cost rows", () => {
  const STAMP: AuthStamp = { fingerprint: "0123456789ab", source: "exec", account: "team-a" };
  const PERMISSIONS = { mode: "approve-all" as const, bashApproval: "raw" as const };

  function completeOptions() {
    return {
      modelDef: { provider: "unknown", model: "openai/acceptance-model" },
      workdir: "/tmp",
    };
  }

  function aggregatorStub() {
    const rows: Record<string, unknown>[] = [];
    const errors: Record<string, unknown>[] = [];
    return {
      rows,
      errors,
      record: (event: Record<string, unknown>) => rows.push(event),
      recordError: (event: Record<string, unknown>) => errors.push(event),
      recordOperationSummary: () => {},
    };
  }

  test("AC-111: buildCompleteEvent forwards the result's auth stamp onto the event", () => {
    const event = buildCompleteEvent({
      sessionName: "sess",
      prompt: "p",
      response: "r",
      agentName: "native",
      stage: "complete",
      options: completeOptions(),
      resolvedPermissions: PERMISSIONS,
      tokenUsage: { inputTokens: 1, outputTokens: 1 },
      estimatedCostUsd: 0,
      startedAt: Date.now(),
      auth: STAMP,
    });
    expect(event.auth).toEqual(STAMP);
  });

  test("AC-112: buildCompleteEvent without auth leaves the auth own-property absent", () => {
    const event = buildCompleteEvent({
      sessionName: "sess",
      prompt: "p",
      response: "r",
      agentName: "native",
      stage: "complete",
      options: completeOptions(),
      resolvedPermissions: PERMISSIONS,
      tokenUsage: { inputTokens: 1, outputTokens: 1 },
      estimatedCostUsd: 0,
      startedAt: Date.now(),
    });
    expect(Object.hasOwn(event, "auth")).toBe(false);
  });

  test("AC-113: buildSessionTurnEvent forwards the TurnResult's auth stamp onto the event", () => {
    const event = buildSessionTurnEvent({
      handle: { id: "sess", agentName: "native", modelDef: { provider: "unknown", model: "openai/acceptance-model" } },
      sessionRole: "implementer",
      prompt: "p",
      result: {
        output: "r",
        tokenUsage: { inputTokens: 1, outputTokens: 1 },
        estimatedCostUsd: 0,
        internalRoundTrips: 1,
        auth: STAMP,
      },
      agentName: "native",
      stage: "run",
      opts: { storyId: "US-006", featureName: "credential-sources", workdir: "/tmp", projectDir: "/tmp" },
      resolvedPermissions: PERMISSIONS,
      startedAt: Date.now(),
    });
    expect(event.auth).toEqual(STAMP);
  });

  test("AC-114: a bus cost subscriber records a CostEvent whose auth deep-equals the emitted event's auth", () => {
    const bus = new DispatchEventBus();
    const aggregator = aggregatorStub();
    attachCostSubscriber(bus, aggregator as never, "run-credsrc");
    const event = buildCompleteEvent({
      sessionName: "sess",
      prompt: "p",
      response: "r",
      agentName: "native",
      stage: "complete",
      options: completeOptions(),
      resolvedPermissions: PERMISSIONS,
      tokenUsage: { inputTokens: 3, outputTokens: 2 },
      estimatedCostUsd: 0.0001,
      startedAt: Date.now(),
      auth: STAMP,
    });
    bus.emitDispatch(event);
    expect(aggregator.rows).toHaveLength(1);
    expect(Object.hasOwn(aggregator.rows[0], "auth")).toBe(true);
    expect(aggregator.rows[0].auth).toEqual(STAMP);
  });

  test("AC-115: a session-turn dispatch without auth produces a CostEvent with no auth own-property", () => {
    const bus = new DispatchEventBus();
    const aggregator = aggregatorStub();
    attachCostSubscriber(bus, aggregator as never, "run-credsrc");
    const event = buildSessionTurnEvent({
      handle: { id: "sess", agentName: "native", modelDef: { provider: "unknown", model: "openai/acceptance-model" } },
      sessionRole: "implementer",
      prompt: "p",
      result: {
        output: "r",
        tokenUsage: { inputTokens: 1, outputTokens: 1 },
        estimatedCostUsd: 0,
        internalRoundTrips: 1,
      },
      agentName: "native",
      stage: "run",
      opts: { storyId: "US-006", featureName: "credential-sources", workdir: "/tmp", projectDir: "/tmp" },
      resolvedPermissions: PERMISSIONS,
      startedAt: Date.now(),
    });
    bus.emitDispatch(event);
    expect(aggregator.rows).toHaveLength(1);
    expect(Object.hasOwn(aggregator.rows[0], "auth")).toBe(false);
  });

  test("AC-116: completeResultProvenance returns the result's auth stamp under an auth own-property", async () => {
    const { completeResultProvenance } = await import("@/agents/manager-dispatch");
    const out = completeResultProvenance({ auth: STAMP });
    expect(Object.hasOwn(out, "auth")).toBe(true);
    expect(out.auth).toEqual(STAMP);
  });

  test("AC-117: completeResultProvenance omits all three keys when the result carries none, and carries only the present one", async () => {
    const { completeResultProvenance } = await import("@/agents/manager-dispatch");
    const empty = completeResultProvenance({});
    expect(Object.hasOwn(empty, "auth")).toBe(false);
    expect(Object.hasOwn(empty, "pricingSource")).toBe(false);
    expect(Object.hasOwn(empty, "rates")).toBe(false);
    const authOnly = completeResultProvenance({ auth: STAMP });
    expect(Object.hasOwn(authOnly, "auth")).toBe(true);
    expect(Object.hasOwn(authOnly, "pricingSource")).toBe(false);
    expect(Object.hasOwn(authOnly, "rates")).toBe(false);
    const pricingOnly = completeResultProvenance({ pricingSource: "catalog-rates" });
    expect(Object.hasOwn(pricingOnly, "pricingSource")).toBe(true);
    expect(Object.hasOwn(pricingOnly, "auth")).toBe(false);
    expect(Object.hasOwn(pricingOnly, "rates")).toBe(false);
  });

  test("AC-118: AgentManager.completeAsWithFallback emits a CompleteDispatchEvent carrying the stub's auth stamp", async () => {
    const bus = new DispatchEventBus();
    const emitted: { kind?: string; auth?: unknown }[] = [];
    bus.onDispatch((event) => emitted.push(event as { kind?: string; auth?: unknown }));
    const adapter = makeAgentAdapter({
      complete: mock(async () => ({
        output: "ok",
        tokenUsage: { inputTokens: 1, outputTokens: 1 },
        estimatedCostUsd: 0.000001,
        auth: STAMP,
      })),
    });
    const manager = new AgentManager(makeNaxConfig({}), makeAgentRegistry({ getAgent: () => adapter }), {
      dispatchEvents: bus,
    });
    await manager.completeAsWithFallback("native", "hi", {
      modelDef: { provider: "unknown", model: "openai/acceptance-model" },
      workdir: "/tmp",
      storyId: "US-006",
    });
    const completeEvents = emitted.filter((event) => event.kind === "complete");
    expect(completeEvents.length).toBeGreaterThanOrEqual(1);
    expect(completeEvents.at(-1)?.auth).toEqual(STAMP);
  });

  test("AC-119: the cost subscriber records a successful CostEvent (not an error row) with the stub's auth stamp", async () => {
    const bus = new DispatchEventBus();
    const aggregator = aggregatorStub();
    attachCostSubscriber(bus, aggregator as never, "run-credsrc");
    const adapter = makeAgentAdapter({
      complete: mock(async () => ({
        output: "ok",
        tokenUsage: { inputTokens: 1, outputTokens: 1 },
        estimatedCostUsd: 0.000001,
        auth: STAMP,
      })),
    });
    const manager = new AgentManager(makeNaxConfig({}), makeAgentRegistry({ getAgent: () => adapter }), {
      dispatchEvents: bus,
    });
    await manager.completeAsWithFallback("native", "hi", {
      modelDef: { provider: "unknown", model: "openai/acceptance-model" },
      workdir: "/tmp",
      storyId: "US-006",
    });
    expect(aggregator.errors).toHaveLength(0);
    expect(aggregator.rows.length).toBeGreaterThanOrEqual(1);
    expect(aggregator.rows.at(-1)?.auth).toEqual(STAMP);
  });

  test("AC-120: COST_ROW_SCHEMA_VERSION is 8 and the version list documents \"8 — adds auth\"", async () => {
    expect(COST_ROW_SCHEMA_VERSION).toBe(8);
    const costSourcePath = join(import.meta.dir, "..", "..", "..", "src", "runtime", "middleware", "cost.ts");
    const source = readFileSync(costSourcePath, "utf8");
    expect(source).toMatch(/8\s*[—–-]\s*adds\s+`?auth/);
  });

  test("AC-121: a CostEvent recorded from an auth-stamped dispatch has schemaVersion 8 and carries auth", () => {
    const bus = new DispatchEventBus();
    const aggregator = aggregatorStub();
    attachCostSubscriber(bus, aggregator as never, "run-credsrc");
    const event = buildCompleteEvent({
      sessionName: "sess",
      prompt: "p",
      response: "r",
      agentName: "native",
      stage: "complete",
      options: completeOptions(),
      resolvedPermissions: PERMISSIONS,
      tokenUsage: { inputTokens: 3, outputTokens: 2 },
      estimatedCostUsd: 0.0001,
      startedAt: Date.now(),
      auth: STAMP,
    });
    bus.emitDispatch(event);
    expect(aggregator.rows).toHaveLength(1);
    expect(aggregator.rows[0].schemaVersion).toBe(8);
    expect(Object.hasOwn(aggregator.rows[0], "auth")).toBe(true);
  });

  test("AC-122: a cost error row from a DispatchErrorEvent is stamped with schemaVersion 8", () => {
    const bus = new DispatchEventBus();
    const aggregator = aggregatorStub();
    attachCostSubscriber(bus, aggregator as never, "run-credsrc");
    const event = buildDispatchErrorEvent({
      origin: "completeAs",
      agentName: "native",
      stage: "complete",
      error: new Error("boom"),
      resolvedPermissions: PERMISSIONS,
      startedAt: Date.now(),
    });
    bus.emitDispatchError(event);
    expect(aggregator.errors).toHaveLength(1);
    expect(aggregator.errors[0].schemaVersion).toBe(8);
  });

  test("AC-123: a cost error row carries no auth own-property", () => {
    const bus = new DispatchEventBus();
    const aggregator = aggregatorStub();
    attachCostSubscriber(bus, aggregator as never, "run-credsrc");
    const event = buildDispatchErrorEvent({
      origin: "completeAs",
      agentName: "native",
      stage: "complete",
      error: new Error("boom"),
      resolvedPermissions: PERMISSIONS,
      startedAt: Date.now(),
    });
    bus.emitDispatchError(event);
    expect(aggregator.errors).toHaveLength(1);
    expect(Object.hasOwn(aggregator.errors[0], "auth")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-007 — auth CLI
// ─────────────────────────────────────────────────────────────────────────────

describe("credential-sources auth CLI", () => {
  let lines: string[];

  function captureCliOutput(): void {
    lines = [];
    _cliAuthDeps.log = (text: string) => {
      lines.push(text);
    };
    _cliAuthDeps.isTTY = () => true;
  }

  function output(): string {
    return lines.join("\n");
  }

  function writeExecHelper(body: string): string {
    return writeExecutableScript(tempDir("nax-credsrc-helper-"), "cli-helper.sh", body);
  }

  test("AC-124: with no auth block, authListCommand() prints 'Credential source: file' first and exits 0", async () => {
    freshGlobalDir();
    captureCliOutput();
    const exit = await authListCommand();
    expect(exit).toBe(0);
    expect(lines[0]).toBe("Credential source: file");
  });

  test("AC-125: exec command [\"koda-cred\",\"--x\"] prints 'Credential source: exec (koda-cred --x)' first", async () => {
    const dir = freshGlobalDir();
    writeGlobalConfig(dir, { auth: { source: "exec", exec: { command: ["koda-cred", "--x"] } } });
    captureCliOutput();
    const exit = await authListCommand();
    expect(exit).toBe(0);
    expect(lines[0]).toBe("Credential source: exec (koda-cred --x)");
  });

  test("AC-126: exec + a serving helper prints one anthropic row naming exec and team-a", async () => {
    const dir = freshGlobalDir();
    const helper = writeExecHelper(`printf '{"version":1,"kind":"api-key","key":"HELPER-KEY","account":"team-a"}\\n'`);
    writeGlobalConfig(dir, { auth: { source: "exec", exec: { command: [helper] } } });
    captureCliOutput();
    const exit = await authListCommand(["anthropic"]);
    expect(exit).toBe(0);
    const rows = lines.filter((line) => line.startsWith("anthropic"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("exec");
    expect(rows[0]).toContain("team-a");
  }, 20000);

  test("AC-127: exec + a declining helper prints 'file (declined)' for the stored provider", async () => {
    const dir = freshGlobalDir();
    const helper = writeExecHelper(`printf '{"version":1,"decline":true}\\n'`);
    writeGlobalConfig(dir, { auth: { source: "exec", exec: { command: [helper] } } });
    writeCredentialsFile(dir, { openai: { kind: "api-key", key: "STORED-OPENAI-KEY" } });
    captureCliOutput();
    const exit = await authListCommand();
    expect(exit).toBe(0);
    const row = lines.find((line) => line.startsWith("openai"));
    expect(row).toBeDefined();
    expect(row).toContain("file (declined)");
  }, 20000);

  test("AC-128: exec + an exiting-1 helper prints 'error: CREDENTIAL_HELPER_FAILED' in the row", async () => {
    const dir = freshGlobalDir();
    const helper = writeExecHelper(`exit 1`);
    writeGlobalConfig(dir, { auth: { source: "exec", exec: { command: [helper] } } });
    captureCliOutput();
    await authListCommand(["anthropic"]);
    const row = lines.find((line) => line.startsWith("anthropic"));
    expect(row).toBeDefined();
    expect(row).toContain("error: CREDENTIAL_HELPER_FAILED");
  }, 20000);

  test("AC-129: authListCommand(['anthropic']) still exits 0 when the helper fails", async () => {
    const dir = freshGlobalDir();
    const helper = writeExecHelper(`exit 1`);
    writeGlobalConfig(dir, { auth: { source: "exec", exec: { command: [helper] } } });
    captureCliOutput();
    const exit = await authListCommand(["anthropic"]);
    expect(exit).toBe(0);
  }, 20000);

  test("AC-130: authListCommand prints neither the helper's key, nor a stored key, nor any fingerprint", async () => {
    const dir = freshGlobalDir();
    const helperKey = "HELPER-SECRET-VALUE-9";
    const storedKey = "FILE-STORED-KEY-VALUE";
    const helper = writeExecHelper(`printf '{"version":1,"kind":"api-key","key":"${helperKey}","account":"team-a"}\\n'`);
    writeGlobalConfig(dir, { auth: { source: "exec", exec: { command: [helper] } } });
    writeCredentialsFile(dir, { anthropic: { kind: "api-key", key: storedKey } });
    const { fingerprintCredential } = await import("@/agents/native/credentials/fingerprint");
    const storedFingerprint = await fingerprintCredential({ kind: "api-key", key: storedKey });
    captureCliOutput();
    const exit = await authListCommand(["anthropic"]);
    expect(exit).toBe(0);
    expect(output()).not.toContain(helperKey);
    expect(output()).not.toContain(storedKey);
    expect(output()).not.toContain(storedFingerprint);
    for (const line of lines) {
      expect(line).not.toMatch(/[0-9a-f]{16}/i);
    }
  }, 20000);

  test("AC-131: an invalid auth block (exec without command) makes authListCommand exit 1", async () => {
    const dir = freshGlobalDir();
    writeGlobalConfig(dir, { auth: { source: "exec" } });
    captureCliOutput();
    const exit = await authListCommand();
    expect(exit).toBe(1);
  });

  test("AC-132: authRmCommand on a helper-served provider prints the exact managed-helper refusal", async () => {
    const dir = freshGlobalDir();
    const helper = writeExecHelper(`printf '{"version":1,"kind":"api-key","key":"HELPER-KEY"}\\n'`);
    writeGlobalConfig(dir, { auth: { source: "exec", exec: { command: [helper] } } });
    captureCliOutput();
    await authRmCommand("anthropic");
    expect(lines).toContain("anthropic is managed by the credential helper; nothing was removed.");
  }, 20000);

  test("AC-133: authRmCommand on a helper-served provider exits 1", async () => {
    const dir = freshGlobalDir();
    const helper = writeExecHelper(`printf '{"version":1,"kind":"api-key","key":"HELPER-KEY"}\\n'`);
    writeGlobalConfig(dir, { auth: { source: "exec", exec: { command: [helper] } } });
    captureCliOutput();
    const exit = await authRmCommand("anthropic");
    expect(exit).toBe(1);
  }, 20000);

  test("AC-134: authRmCommand on a helper-served provider leaves the stored entry untouched", async () => {
    const dir = freshGlobalDir();
    const helper = writeExecHelper(`printf '{"version":1,"kind":"api-key","key":"HELPER-KEY"}\\n'`);
    writeGlobalConfig(dir, { auth: { source: "exec", exec: { command: [helper] } } });
    const credentialsPath = writeCredentialsFile(dir, { anthropic: { kind: "api-key", key: "STORED-V" } });
    captureCliOutput();
    await authRmCommand("anthropic");
    const after = JSON.parse(readFileSync(credentialsPath, "utf8")) as {
      credentials: Record<string, { key?: string }>;
    };
    expect(after.credentials.anthropic).toBeDefined();
    expect(after.credentials.anthropic.key).toBe("STORED-V");
  }, 20000);

  test("AC-135: authRmCommand on a declined provider removes only that provider's stored entry", async () => {
    const dir = freshGlobalDir();
    const helper = writeExecHelper(`printf '{"version":1,"decline":true}\\n'`);
    writeGlobalConfig(dir, { auth: { source: "exec", exec: { command: [helper] } } });
    const credentialsPath = writeCredentialsFile(dir, {
      openai: { kind: "api-key", key: "OPENAI-STORED" },
      google: { kind: "api-key", key: "GOOGLE-CONTROL" },
    });
    captureCliOutput();
    await authRmCommand("openai");
    const after = JSON.parse(readFileSync(credentialsPath, "utf8")) as {
      credentials: Record<string, unknown>;
    };
    expect(Object.hasOwn(after.credentials, "openai")).toBe(false);
    expect(Object.hasOwn(after.credentials, "google")).toBe(true);
  }, 20000);

  test("AC-136: authRmCommand on a declined provider exits 0", async () => {
    const dir = freshGlobalDir();
    const helper = writeExecHelper(`printf '{"version":1,"decline":true}\\n'`);
    writeGlobalConfig(dir, { auth: { source: "exec", exec: { command: [helper] } } });
    writeCredentialsFile(dir, { openai: { kind: "api-key", key: "OPENAI-STORED" } });
    captureCliOutput();
    const exit = await authRmCommand("openai");
    expect(exit).toBe(0);
  }, 20000);

  test("AC-137: exec + a served provider prints the helper note immediately after the login success line", async () => {
    const dir = freshGlobalDir();
    const helper = writeExecHelper(`printf '{"version":1,"kind":"api-key","key":"HELPER-KEY"}\\n'`);
    writeGlobalConfig(dir, { auth: { source: "exec", exec: { command: [helper] } } });
    captureCliOutput();
    _authDeps.login = mock(async () => ({ providerId: "anthropic", method: "api-key", kind: "api-key" }));
    _authDeps.ambientAuthAvailable = mock(async () => false);
    const exit = await authLoginCommand("anthropic", "api-key");
    expect(exit).toBe(0);
    const successIndex = lines.findIndex((line) => line.includes("Signed in to"));
    expect(successIndex).toBeGreaterThanOrEqual(0);
    expect(lines[successIndex + 1]).toBe(
      "Note: the credential helper serves anthropic; this stored login is not used while it does.",
    );
  }, 20000);

  test("AC-138: under the file source, a successful login prints no credential-helper line", async () => {
    const dir = freshGlobalDir();
    writeCredentialsFile(dir, { anthropic: { kind: "api-key", key: "STORED-KEY" } });
    captureCliOutput();
    _authDeps.login = mock(async () => ({ providerId: "anthropic", method: "api-key", kind: "api-key" }));
    _authDeps.ambientAuthAvailable = mock(async () => false);
    const exit = await authLoginCommand("anthropic", "api-key");
    expect(exit).toBe(0);
    expect(lines.some((line) => line.includes("credential helper"))).toBe(false);
  });
});