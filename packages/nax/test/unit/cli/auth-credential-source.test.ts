/**
 * US-007 — credential sources and helper management in the auth CLI.
 *
 * `nax auth list` reports which source pays for a provider and which account a
 * helper-served credential belongs to, `nax auth rm` refuses a provider the exec
 * helper owns, and `nax auth login` says when the helper shadows the credential
 * it just stored. No key, fingerprint or salt ever reaches stdout.
 *
 * The helper is a process boundary, so these tests drive it the way koda will: a
 * small executable script in a temp dir, spawned without a shell. The script
 * answers per provider, and `NAX_GLOBAL_CONFIG_DIR` points at a fresh temp dir in
 * every test, per the story's harness note, so nothing can reach the developer's
 * real `~/.nax`.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  _authDeps,
  _resetCredentialStore,
  fingerprintCredential,
  naxCredentialStore,
  readStoredEntries,
} from "@nathapp/nax-agent/internal";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { _cliAuthDeps, authListCommand, authLoginCommand, authRmCommand } from "@/cli/auth";

function stripAnsi(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ESC is the point — this strips ANSI colour codes
  return s.replace(/\x1B\[[0-9;]*m/g, "");
}

const DECLINE_REPLY = JSON.stringify({ version: 1, decline: true });

/** A well-formed credential reply, optionally carrying the account label. */
function credentialReply(key: string, account?: string): string {
  return JSON.stringify({ version: 1, kind: "api-key", key, ...(account !== undefined ? { account } : {}) });
}

interface HelperSpec {
  /** providerId → the reply that provider's request receives. */
  replies?: Record<string, string>;
  /** Reply for any provider not named in `replies`; a decline by default. */
  fallback?: string;
  exitCode?: number;
}

/**
 * The helper executable's path is created once for the whole file and rewritten
 * in place per test: exec'ing a path the OS has not already seen costs ~370ms on
 * macOS against ~9ms for a rewrite.
 */
let scriptsDir: string;
let helperScript: string;

beforeAll(() => {
  scriptsDir = makeTempDir("nax-cli-auth-scripts-");
  helperScript = join(scriptsDir, "fake-helper.sh");
});

afterAll(() => {
  cleanupTempDir(scriptsDir);
});

/** Write the helper script in place. It reads exactly one request line from stdin. */
function setHelper(spec: HelperSpec): void {
  const cases = Object.entries(spec.replies ?? {}).map(
    ([providerId, reply]) => `  *'"providerId":"${providerId}"'* ) printf '%s' '${reply}' ;;`,
  );
  const script = [
    "#!/bin/sh",
    "req=$(cat)",
    // Every invocation is recorded, so "the helper was consulted for provider X"
    // is an observable fact rather than an internal call count.
    `printf '%s\\n' "$req" >> '${helperRunsPath()}'`,
    'case "$req" in',
    ...cases,
    `  * ) printf '%s' '${spec.fallback ?? DECLINE_REPLY}' ;;`,
    "esac",
    `exit ${spec.exitCode ?? 0}`,
  ];
  writeFileSync(helperScript, `${script.join("\n")}\n`);
  chmodSync(helperScript, 0o755);
}

let dir: string;
let out: string[];
const originalGlobalDir = process.env.NAX_GLOBAL_CONFIG_DIR;
const realLogin = _authDeps.login;
const realAmbient = _authDeps.ambientAuthAvailable;
const realLog = _cliAuthDeps.log;
const realIsTTY = _cliAuthDeps.isTTY;

beforeEach(() => {
  out = [];
  dir = makeTempDir("nax-cli-auth-source-");
  process.env.NAX_GLOBAL_CONFIG_DIR = dir;
  _resetCredentialStore();
  _cliAuthDeps.log = (text: string) => out.push(text);
  _cliAuthDeps.isTTY = () => true;
  _authDeps.ambientAuthAvailable = mock(async () => false);
});

afterEach(() => {
  _authDeps.login = realLogin;
  _authDeps.ambientAuthAvailable = realAmbient;
  _cliAuthDeps.log = realLog;
  _cliAuthDeps.isTTY = realIsTTY;
  process.env.NAX_GLOBAL_CONFIG_DIR = originalGlobalDir;
  _resetCredentialStore();
  cleanupTempDir(dir);
});

/** Write the global config this command reads its auth block from. */
function writeGlobalConfig(auth: unknown): void {
  writeFileSync(join(dir, "config.json"), JSON.stringify({ auth }), "utf8");
}

/** Point the global config at the fake helper, as `auth.source: "exec"` does. */
function configWithExecHelper(replies?: Record<string, string>): void {
  writeGlobalConfig({
    source: "exec",
    exec: { command: [helperScript], timeoutMs: 10_000 },
    onChange: "warn",
  });
  _resetCredentialStore();
  setHelper({ ...(replies === undefined ? {} : { replies }) });
}

/** Point the global config at the fake helper, which always fails. */
function configWithFailingHelper(): void {
  writeGlobalConfig({
    source: "exec",
    exec: { command: [helperScript], timeoutMs: 10_000 },
    onChange: "warn",
  });
  _resetCredentialStore();
  setHelper({ exitCode: 1 });
}

/** Store a credential the way `nax auth login` would. */
async function storeCredential(providerId: string, key: string): Promise<void> {
  await naxCredentialStore().modify(providerId, async () => ({ kind: "api-key", key }));
}

function lines(): string[] {
  return out.map(stripAnsi);
}

function stripped(): string {
  return lines().join("\n");
}

/** The single line naming `providerId`; fails loudly when there is no such row. */
function rowFor(providerId: string): string {
  const line = lines().find((l) => l.includes(providerId));
  if (line === undefined) throw new Error(`no row for "${providerId}" in:\n${stripped()}`);
  return line;
}

/** Where the fake helper records the requests it has read. */
function helperRunsPath(): string {
  return join(dir, "helper-runs.txt");
}

/** The request lines the fake helper was actually spawned with and read. */
function helperRequests(): string[] {
  if (!existsSync(helperRunsPath())) return [];
  return readFileSync(helperRunsPath(), "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0);
}

/** Mock a successful login so the CLI's post-login reporting can be exercised. */
function loginSucceeds(): void {
  _authDeps.login = mock(async () => ({
    providerId: "anthropic",
    method: "api-key" as const,
    kind: "api-key" as const,
  }));
}

describe("authListCommand credential source header", () => {
  test("AC1: prints 'Credential source: file' as its first line when the global config has no auth block", async () => {
    const code = await authListCommand();

    expect(code).toBe(0);
    expect(lines()[0]).toBe("Credential source: file");
  });

  test("AC2: prints 'Credential source: exec (koda-cred --x)' as its first line for a configured helper", async () => {
    writeGlobalConfig({ source: "exec", exec: { command: ["koda-cred", "--x"] } });
    _resetCredentialStore();

    const code = await authListCommand();

    expect(code).toBe(0);
    expect(lines()[0]).toBe("Credential source: exec (koda-cred --x)");
  });

  test("AC8: returns 1 when the global config holds an invalid auth block", async () => {
    writeGlobalConfig({ source: "exec" });
    _resetCredentialStore();

    const code = await authListCommand();

    expect(code).toBe(1);
  });
});

describe("authListCommand under auth.source exec", () => {
  test("AC3: an argument provider served by the helper lists exec and its account label", async () => {
    configWithExecHelper({ anthropic: credentialReply("HELPER-KEY", "team-a") });

    const code = await authListCommand(["anthropic"]);

    expect(code).toBe(0);
    const row = rowFor("anthropic");
    expect(row).toContain("exec");
    expect(row).toContain("team-a");
  });

  test("AC4: a stored provider the helper declines lists 'file (declined)'", async () => {
    configWithExecHelper();
    await storeCredential("openai", "sk-stored-openai");

    const code = await authListCommand();

    expect(code).toBe(0);
    expect(rowFor("openai")).toContain("file (declined)");
  });

  test("AC5: a helper exiting 1 lists 'error: CREDENTIAL_HELPER_FAILED' in the provider's row", async () => {
    configWithFailingHelper();

    await authListCommand(["anthropic"]);

    expect(rowFor("anthropic")).toContain("error: CREDENTIAL_HELPER_FAILED");
  });

  test("AC6: a helper exiting 1 still exits 0, with the provider still listed", async () => {
    configWithFailingHelper();

    const code = await authListCommand(["anthropic"]);

    expect(code).toBe(0);
    // The fault is reported against the provider, not turned into a non-zero
    // exit: an argument provider is listed even when the helper cannot answer.
    expect(lines().some((line) => line.includes("anthropic"))).toBe(true);
  });

  test("AC7: the output carries neither the helper's key nor any credential fingerprint", async () => {
    const helperKey = "HELPER-KEY-SECRET";
    const fileKey = "sk-stored-openai-secret";
    configWithExecHelper({ anthropic: credentialReply(helperKey, "team-a") });
    await storeCredential("openai", fileKey);
    const helperFingerprint = await fingerprintCredential({ kind: "api-key", key: helperKey });
    const fileFingerprint = await fingerprintCredential({ kind: "api-key", key: fileKey });

    await authListCommand(["anthropic"]);

    const text = stripped();
    // The row is rendered — so the secrecy assertions below are about a listing
    // that actually happened, not about an empty output.
    expect(rowFor("anthropic")).toContain("exec");
    expect(text).not.toContain(helperKey);
    expect(text).not.toContain(fileKey);
    expect(text).not.toContain(helperFingerprint);
    expect(text).not.toContain(fileFingerprint);
  });
});

describe("authRmCommand under auth.source exec", () => {
  test("AC9: refuses a provider the helper serves, saying nothing was removed", async () => {
    configWithExecHelper({ anthropic: credentialReply("HELPER-KEY", "team-a") });
    await storeCredential("anthropic", "sk-stored-anthropic");

    await authRmCommand("anthropic");

    expect(stripped()).toContain("anthropic is managed by the credential helper; nothing was removed.");
  });

  test("AC10: refusing a helper-managed provider exits 1", async () => {
    configWithExecHelper({ anthropic: credentialReply("HELPER-KEY", "team-a") });
    await storeCredential("anthropic", "sk-stored-anthropic");

    const code = await authRmCommand("anthropic");

    expect(code).toBe(1);
  });

  test("AC11: refusing a helper-managed provider leaves the stored entry in place", async () => {
    configWithExecHelper({ anthropic: credentialReply("HELPER-KEY", "team-a") });
    await storeCredential("anthropic", "sk-stored-anthropic");

    await authRmCommand("anthropic");

    const providerIds = (await readStoredEntries()).map((entry) => entry.providerId);
    expect(providerIds).toContain("anthropic");
  });

  test("AC12: removes a stored provider the helper declines, after asking the helper", async () => {
    configWithExecHelper();
    await storeCredential("openai", "sk-stored-openai");

    await authRmCommand("openai");

    // The helper is what decides this provider is not its own — the removal
    // follows a decline, not a guess made from the config alone.
    expect(helperRequests().some((request) => request.includes("openai"))).toBe(true);
    const providerIds = (await readStoredEntries()).map((entry) => entry.providerId);
    expect(providerIds).not.toContain("openai");
  });

  test("AC13: removing a stored provider the helper declines exits 0 and is not reported as managed", async () => {
    configWithExecHelper();
    await storeCredential("openai", "sk-stored-openai");

    const code = await authRmCommand("openai");

    expect(code).toBe(0);
    expect(lines().some((line) => /managed by the credential helper/i.test(line))).toBe(false);
  });
});

describe("authLoginCommand helper note", () => {
  test("AC14: a successful login under auth.source exec notes that the helper serves the provider", async () => {
    configWithExecHelper({ anthropic: credentialReply("HELPER-KEY", "team-a") });
    loginSucceeds();

    const code = await authLoginCommand("anthropic");

    expect(code).toBe(0);
    expect(stripped()).toContain(
      "Note: the credential helper serves anthropic; this stored login is not used while it does.",
    );
  });

  test("AC15: a successful login under auth.source file prints no line mentioning the credential helper", async () => {
    // `exec` is configured but the source is the file store, so the helper must
    // not be consulted at all — a login that asked it would be reading a source
    // the config did not select.
    writeGlobalConfig({ source: "file", exec: { command: [helperScript], timeoutMs: 10_000 } });
    _resetCredentialStore();
    setHelper({ replies: { anthropic: credentialReply("HELPER-KEY", "team-a") } });
    loginSucceeds();

    const code = await authLoginCommand("anthropic");

    expect(code).toBe(0);
    // The success line is printed — so the absence below is about a login that
    // reported, not about a login that failed before saying anything.
    expect(stripped()).toContain("anthropic");
    expect(lines().some((line) => /credential helper/i.test(line))).toBe(false);
    expect(helperRequests()).toEqual([]);
  });
});
