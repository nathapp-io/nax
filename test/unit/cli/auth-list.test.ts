/**
 * US-002 — the credential-source auth list collector.
 *
 * `collectAuthList(providerIds)` gathers the secret-free, provider-by-provider
 * facts `nax auth list` renders: which source pays for a provider, what the file
 * store holds, the exec helper's verdict, whether an ambient source supplies a
 * credential, and whether nax can authenticate the provider at all. Nothing here
 * is display: US-003 renders this report as text or JSON.
 *
 * The helper is a real process boundary, so these tests drive it the way the
 * credential-source tests do: a small executable script in a temp dir, spawned
 * without a shell. `NAX_GLOBAL_CONFIG_DIR` points at a fresh temp dir in every
 * test, and `_authDeps.ambientAuthAvailable` is stubbed in every test and
 * restored afterwards.
 *
 * This file also holds US-003's tests: `authListCommand` reads the report
 * through `_cliAuthDeps.collectAuthList` and prints it as today's text lines or
 * as one JSON document, and prints the error document when the listing aborts.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, type Mock, mock, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StoredCredential } from "@nathapp/nax-ai";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { _authDeps } from "@/agents/native/auth";
import { _resetCredentialStore, credentialFilePath, naxCredentialStore } from "@/agents/native/credentials";
import { _cliAuthDeps, authListCommand } from "@/cli/auth";
import { type AuthListReport, collectAuthList } from "@/cli/auth-list";

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
 * in place per test, mirroring the credential-source harness.
 */
let scriptsDir: string;
let helperScript: string;

beforeAll(() => {
  scriptsDir = makeTempDir("nax-auth-list-scripts-");
  helperScript = join(scriptsDir, "fake-helper.sh");
});

afterAll(() => {
  cleanupTempDir(scriptsDir);
});

let dir: string;
let out: string[];
let logSpy: Mock<(text: string) => void>;
const originalGlobalDir = process.env.NAX_GLOBAL_CONFIG_DIR;
const realAmbient = _authDeps.ambientAuthAvailable;
const realCliLog = _cliAuthDeps.log;
const realCollectAuthList = _cliAuthDeps.collectAuthList;

beforeEach(() => {
  out = [];
  logSpy = mock((text: string) => {
    out.push(text);
  });
  _cliAuthDeps.log = logSpy;
  dir = makeTempDir("nax-auth-list-");
  process.env.NAX_GLOBAL_CONFIG_DIR = dir;
  _resetCredentialStore();
  _authDeps.ambientAuthAvailable = mock(async () => false);
});

afterEach(() => {
  _authDeps.ambientAuthAvailable = realAmbient;
  _cliAuthDeps.log = realCliLog;
  _cliAuthDeps.collectAuthList = realCollectAuthList;
  process.env.NAX_GLOBAL_CONFIG_DIR = originalGlobalDir;
  _resetCredentialStore();
  cleanupTempDir(dir);
});

/** Write the global config the collector reads its auth block from, and drop the memoised store. */
function writeGlobalConfig(auth: unknown): void {
  writeFileSync(join(dir, "config.json"), JSON.stringify({ auth }), "utf8");
  _resetCredentialStore();
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

/** Write the helper script in place. It reads exactly one request line from stdin. */
function setHelper(spec: HelperSpec): void {
  const cases = Object.entries(spec.replies ?? {}).map(
    ([providerId, reply]) => `  *'"providerId":"${providerId}"'* ) printf '%s' '${reply}' ;;`,
  );
  const script = [
    "#!/bin/sh",
    "req=$(cat)",
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

/** Store a credential the way `nax auth login` would, into the file store. */
async function storeFileCredential(providerId: string, credential: StoredCredential): Promise<void> {
  await naxCredentialStore().modify(providerId, async () => credential);
}

/** Point the global config at the fake helper, as `auth.source: "exec"` does. */
function useExecHelper(command: readonly string[], spec: HelperSpec = {}): void {
  writeGlobalConfig({ source: "exec", exec: { command: [...command], timeoutMs: 10_000 }, onChange: "warn" });
  setHelper(spec);
}

/** The one provider entry for `providerId`; fails loudly when it is absent. */
function providerOf(report: AuthListReport, providerId: string): AuthListReport["providers"][number] {
  const found = report.providers.find((entry) => entry.providerId === providerId);
  if (found === undefined) {
    throw new Error(`no provider "${providerId}" in [${report.providers.map((p) => p.providerId).join(", ")}]`);
  }
  return found;
}

describe("collectAuthList under auth.source file", () => {
  test("US-002 AC1: report.source is 'file' when the global config selects the file store", async () => {
    writeGlobalConfig({ source: "file" });
    await storeFileCredential("openai", { kind: "api-key", key: "sk-stored-openai" });

    const report = await collectAuthList([]);

    expect(report.source).toBe("file");
  });

  test("US-002 AC2: the report has no helper key under auth.source file", async () => {
    writeGlobalConfig({ source: "file" });
    await storeFileCredential("openai", { kind: "api-key", key: "sk-stored-openai" });

    const report = await collectAuthList([]);

    expect("helper" in report).toBe(false);
  });

  test("US-002 AC3: a stored api-key without expires reports { kind: 'api-key', expired: false }", async () => {
    writeGlobalConfig({ source: "file" });
    await storeFileCredential("openai", { kind: "api-key", key: "sk-stored-openai" });

    const report = await collectAuthList([]);

    expect(providerOf(report, "openai").stored).toEqual({ kind: "api-key", expired: false });
  });

  test("US-002 AC3: a stored api-key without expires carries no expires field at all", async () => {
    writeGlobalConfig({ source: "file" });
    await storeFileCredential("openai", { kind: "api-key", key: "sk-stored-openai" });

    const stored = providerOf(await collectAuthList([]), "openai").stored;

    expect(stored).not.toBeNull();
    expect(Object.hasOwn(stored ?? {}, "expires")).toBe(false);
  });

  test("US-002 AC4: the provider has no exec key under auth.source file", async () => {
    writeGlobalConfig({ source: "file" });
    await storeFileCredential("openai", { kind: "api-key", key: "sk-stored-openai" });

    const provider = providerOf(await collectAuthList([]), "openai");

    expect("exec" in provider).toBe(false);
  });

  test("US-002 AC4: a helper configured alongside auth.source file is never spawned", async () => {
    // The file source never consults a helper, even when `auth.exec` is present.
    writeGlobalConfig({
      source: "file",
      exec: { command: [helperScript], timeoutMs: 10_000 },
      onChange: "warn",
    });
    setHelper({ replies: { openai: credentialReply("sk-helper-secret", "team-a") } });

    const report = await collectAuthList(["openai"]);

    expect(helperRequests()).toEqual([]);
    expect("exec" in providerOf(report, "openai")).toBe(false);
  });

  test("US-002 AC5: a stored provider with no ambient credential is still available", async () => {
    writeGlobalConfig({ source: "file" });
    await storeFileCredential("openai", { kind: "api-key", key: "sk-stored-openai" });
    _authDeps.ambientAuthAvailable = mock(async () => false);

    const provider = providerOf(await collectAuthList([]), "openai");

    expect(provider.available).toBe(true);
  });

  test("US-002 AC6: a stored oauth entry with expires 1000 reports the ISO timestamp", async () => {
    writeGlobalConfig({ source: "file" });
    await storeFileCredential("openai", { kind: "oauth", access: "a", refresh: "r", expires: 1000 });

    const stored = providerOf(await collectAuthList([]), "openai").stored;

    expect(stored?.expires).toBe("1970-01-01T00:00:01.000Z");
  });

  test("US-002 AC7: a stored oauth entry whose expires has passed reports expired true", async () => {
    writeGlobalConfig({ source: "file" });
    await storeFileCredential("openai", { kind: "oauth", access: "a", refresh: "r", expires: 1000 });

    const stored = providerOf(await collectAuthList([]), "openai").stored;

    expect(stored?.expired).toBe(true);
  });

  test("US-002 AC7: a stored oauth entry whose expires is in the future reports expired false", async () => {
    writeGlobalConfig({ source: "file" });
    await storeFileCredential("openai", {
      kind: "oauth",
      access: "a",
      refresh: "r",
      expires: Date.now() + 3_600_000,
    });

    const stored = providerOf(await collectAuthList([]), "openai").stored;

    expect(stored?.expired).toBe(false);
  });

  test("US-002 AC8: an argument provider with nothing stored reports stored null", async () => {
    writeGlobalConfig({ source: "file" });

    const provider = providerOf(await collectAuthList(["mistral"]), "mistral");

    expect(provider.stored).toBeNull();
  });

  test("US-002 AC9: an argument provider with nothing stored and no ambient credential is unavailable", async () => {
    writeGlobalConfig({ source: "file" });
    _authDeps.ambientAuthAvailable = mock(async () => false);

    const provider = providerOf(await collectAuthList(["mistral"]), "mistral");

    expect(provider.available).toBe(false);
  });

  test("US-002 AC10: an ambient probe resolving true reports ambient true", async () => {
    writeGlobalConfig({ source: "file" });
    _authDeps.ambientAuthAvailable = mock(async (providerId: string) => providerId === "mistral");

    const provider = providerOf(await collectAuthList(["mistral"]), "mistral");

    expect(provider.ambient).toBe(true);
  });

  test("US-002 AC11: an argument provider with no stored entry but an ambient credential is available", async () => {
    writeGlobalConfig({ source: "file" });
    _authDeps.ambientAuthAvailable = mock(async (providerId: string) => providerId === "mistral");

    const provider = providerOf(await collectAuthList(["mistral"]), "mistral");

    expect(provider.available).toBe(true);
  });

  test("US-002 AC12: an ambient probe that throws counts as ambient false", async () => {
    writeGlobalConfig({ source: "file" });
    _authDeps.ambientAuthAvailable = mock(async () => {
      throw new Error("probe blew up");
    });

    const provider = providerOf(await collectAuthList(["mistral"]), "mistral");

    expect(provider.ambient).toBe(false);
  });

  test("US-002 AC23: stored providers are listed in providerId order", async () => {
    writeGlobalConfig({ source: "file" });
    await storeFileCredential("openai", { kind: "api-key", key: "sk-openai" });
    await storeFileCredential("anthropic", { kind: "api-key", key: "sk-anthropic" });

    const report = await collectAuthList([]);

    expect(report.providers.map((provider) => provider.providerId)).toEqual(["anthropic", "openai"]);
  });

  test("US-002 AC24: nothing stored and no arguments reports an empty providers array", async () => {
    writeGlobalConfig({ source: "file" });

    const report = await collectAuthList([]);

    expect(report.providers).toEqual([]);
  });

  test("US-002 AC24: blank and whitespace-only arguments are ignored", async () => {
    writeGlobalConfig({ source: "file" });

    const report = await collectAuthList(["", "   ", "\t"]);

    expect(report.providers).toEqual([]);
  });

  test("US-002 AC24: an argument repeated alongside a stored provider yields one entry", async () => {
    writeGlobalConfig({ source: "file" });
    await storeFileCredential("openai", { kind: "api-key", key: "sk-openai" });

    const report = await collectAuthList(["openai", "openai"]);

    expect(report.providers.map((provider) => provider.providerId)).toEqual(["openai"]);
  });
});

describe("collectAuthList under auth.source exec", () => {
  test("US-002 AC1: report.source is 'exec' when the global config selects the helper", async () => {
    useExecHelper([helperScript]);

    const report = await collectAuthList([]);

    expect(report.source).toBe("exec");
  });

  test("US-002 AC13: helper.command is the configured command verbatim", async () => {
    useExecHelper([helperScript, "--x"]);

    const report = await collectAuthList([]);

    expect(report.helper?.command).toEqual([helperScript, "--x"]);
  });

  test("US-002 AC14: a helper-served provider reports the served status and its account", async () => {
    useExecHelper([helperScript], { replies: { deepseek: credentialReply("sk-helper", "team-a") } });

    const provider = providerOf(await collectAuthList(["deepseek"]), "deepseek");

    expect(provider.exec).toEqual({ status: "served", account: "team-a" });
  });

  test("US-002 AC15: a helper-served provider with nothing stored is available", async () => {
    useExecHelper([helperScript], { replies: { deepseek: credentialReply("sk-helper") } });

    const provider = providerOf(await collectAuthList(["deepseek"]), "deepseek");

    expect(provider.available).toBe(true);
  });

  test("US-002 AC15: a served provider without an account has no account key", async () => {
    useExecHelper([helperScript], { replies: { deepseek: credentialReply("sk-helper") } });

    const provider = providerOf(await collectAuthList(["deepseek"]), "deepseek");

    expect(provider.exec).toEqual({ status: "served" });
    expect(Object.hasOwn(provider.exec ?? {}, "account")).toBe(false);
  });

  test("US-002 AC16: an account label carrying ANSI colour codes is cleaned to plain text", async () => {
    useExecHelper([helperScript], { replies: { deepseek: credentialReply("sk-helper", "\u001b[31mteam-a\u001b[0m") } });

    const provider = providerOf(await collectAuthList(["deepseek"]), "deepseek");

    expect(provider.exec?.status).toBe("served");
    expect(provider.exec?.account).toBe("team-a");
  });

  test("US-002 AC17: a helper declining a stored provider reports the declined status", async () => {
    writeGlobalConfig({ source: "file" });
    await storeFileCredential("openai", { kind: "api-key", key: "sk-stored-openai" });
    useExecHelper([helperScript]);

    const provider = providerOf(await collectAuthList([]), "openai");

    expect(provider.exec).toEqual({ status: "declined" });
  });

  test("US-002 AC18: a helper declining a stored provider still leaves it available", async () => {
    writeGlobalConfig({ source: "file" });
    await storeFileCredential("openai", { kind: "api-key", key: "sk-stored-openai" });
    useExecHelper([helperScript]);

    const provider = providerOf(await collectAuthList([]), "openai");

    expect(provider.available).toBe(true);
  });

  test("US-002 AC19: a helper declining an unstored provider with no ambient credential is unavailable", async () => {
    useExecHelper([helperScript]);
    _authDeps.ambientAuthAvailable = mock(async () => false);

    const provider = providerOf(await collectAuthList(["mistral"]), "mistral");

    expect(provider.available).toBe(false);
  });

  test("US-002: a declining helper leaves an ambient provider available", async () => {
    useExecHelper([helperScript]);
    _authDeps.ambientAuthAvailable = mock(async (providerId: string) => providerId === "mistral");

    const provider = providerOf(await collectAuthList(["mistral"]), "mistral");

    expect(provider.exec).toEqual({ status: "declined" });
    expect(provider.ambient).toBe(true);
    expect(provider.available).toBe(true);
  });

  test("US-002 AC20: a helper exiting 1 reports an error status with CREDENTIAL_HELPER_FAILED", async () => {
    writeGlobalConfig({ source: "file" });
    await storeFileCredential("openai", { kind: "api-key", key: "sk-stored-openai" });
    useExecHelper([helperScript], { exitCode: 1 });

    const provider = providerOf(await collectAuthList([]), "openai");

    expect(provider.exec).toEqual({ status: "error", code: "CREDENTIAL_HELPER_FAILED" });
  });

  test("US-002: a malformed helper reply preserves CREDENTIAL_HELPER_INVALID", async () => {
    writeGlobalConfig({ source: "file" });
    await storeFileCredential("openai", { kind: "api-key", key: "sk-stored-openai" });
    useExecHelper([helperScript], { replies: { openai: "not-json" } });

    const provider = providerOf(await collectAuthList([]), "openai");

    expect(provider.exec).toEqual({ status: "error", code: "CREDENTIAL_HELPER_INVALID" });
  });

  test("US-002 AC21: a provider whose helper failed is unavailable despite its stored entry", async () => {
    writeGlobalConfig({ source: "file" });
    await storeFileCredential("openai", { kind: "api-key", key: "sk-stored-openai" });
    useExecHelper([helperScript], { exitCode: 1 });

    const provider = providerOf(await collectAuthList([]), "openai");

    expect(provider.available).toBe(false);
  });

  test("US-002 AC21: a provider whose helper failed stays unavailable even with an ambient credential", async () => {
    // The chained store fails closed on a helper failure and never consults the
    // file or the ambient sources.
    writeGlobalConfig({ source: "file" });
    await storeFileCredential("openai", { kind: "api-key", key: "sk-stored-openai" });
    useExecHelper([helperScript], { exitCode: 1 });
    _authDeps.ambientAuthAvailable = mock(async () => true);

    const provider = providerOf(await collectAuthList([]), "openai");

    expect(provider.available).toBe(false);
  });

  test("US-002 AC22: the serialized report never carries the helper's key", async () => {
    useExecHelper([helperScript], { replies: { deepseek: credentialReply("sk-helper-secret", "team-a") } });

    const report = await collectAuthList(["deepseek"]);

    // The provider was actually served — so the secrecy assertion is about a
    // report that carries provenance, not one that came back empty.
    expect(providerOf(report, "deepseek").exec?.status).toBe("served");
    expect(JSON.stringify(report)).not.toContain("sk-helper-secret");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-003 — `nax auth list --json` and the text rendering it retains
// ─────────────────────────────────────────────────────────────────────────────

/** The document `authListCommand` prints when the listing aborts. */
interface AuthListErrorDocument {
  error: { code: string; message: string };
}

/** The report a stubbed collector resolves. */
const FIXED_REPORT: AuthListReport = {
  source: "file",
  providers: [{ providerId: "mistral", stored: { kind: "api-key", expired: false }, ambient: false, available: true }],
};

/** An exec-source report: one helper-served provider, with its account label. */
const EXEC_REPORT: AuthListReport = {
  source: "exec",
  helper: { command: ["cred", "--x"] },
  providers: [
    {
      providerId: "openai",
      stored: null,
      exec: { status: "served", account: "team-a" },
      ambient: false,
      available: true,
    },
  ],
};

/** Stub the collector `authListCommand` reads its report from. */
function stubCollector(report: AuthListReport) {
  const stub = mock(async () => report);
  _cliAuthDeps.collectAuthList = stub;
  return stub;
}

function stripAnsi(value: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ESC is the point — this strips ANSI colour codes
  return value.replace(/\x1B\[[0-9;]*m/g, "");
}

/** What the command logged, with colour codes removed. */
function lines(): string[] {
  return out.map(stripAnsi);
}

/**
 * The single line the command logged, parsed as JSON — `undefined` when that
 * line is not a JSON document at all. Every `--json` assertion goes through
 * here, so a run that logged text fails on an assertion rather than on a parse
 * error, and one that logged more than one line fails too.
 */
function parseDocument(): unknown {
  expect(out).toHaveLength(1);
  try {
    return JSON.parse(out[0] ?? "");
  } catch {
    // Not JSON: the caller's assertion reports it.
    return undefined;
  }
}

/** The document printed in `--json` mode. */
function jsonDocument<T>(): T {
  const parsed = parseDocument();
  expect(parsed).not.toBeUndefined();
  return parsed as T;
}

describe("authListCommand in --json mode", () => {
  test("US-003 AC1: calls the collector once with the provider ids it was given", async () => {
    const stub = stubCollector(FIXED_REPORT);

    await authListCommand(["mistral"], { json: true });

    expect(stub).toHaveBeenCalledTimes(1);
    expect(stub).toHaveBeenCalledWith(["mistral"]);
  });

  test("US-003 AC1: calls the collector with an empty list when no provider is named", async () => {
    const stub = stubCollector(FIXED_REPORT);

    await authListCommand([], { json: true });

    expect(stub).toHaveBeenCalledWith([]);
  });

  test("US-003 AC2: prints one document that deep-equals the collector's report", async () => {
    stubCollector(FIXED_REPORT);

    await authListCommand(["mistral"], { json: true });

    expect(jsonDocument<AuthListReport>()).toEqual(FIXED_REPORT);
  });

  test("US-003 AC3: logs exactly once", async () => {
    stubCollector(FIXED_REPORT);

    await authListCommand(["mistral"], { json: true });

    expect(logSpy).toHaveBeenCalledTimes(1);
  });

  test("US-003 AC4: returns 0", async () => {
    stubCollector(FIXED_REPORT);

    const code = await authListCommand(["mistral"], { json: true });

    expect(code).toBe(0);
  });

  test("US-003 AC5: prints only the document when the report has no providers", async () => {
    // A stored credential is what makes this document distinguishable from a
    // listing that never consulted the stub: the real store holds a provider.
    await storeFileCredential("openai", { kind: "api-key", key: "sk-stored-openai" });
    stubCollector({ source: "file", providers: [] });

    await authListCommand([], { json: true });

    expect(jsonDocument<AuthListReport>().providers).toEqual([]);
  });

  test("US-003 AC6: with the real collector, a stored file credential is listed", async () => {
    writeGlobalConfig({ source: "file" });
    await storeFileCredential("openai", { kind: "api-key", key: "sk-stored-openai" });

    await authListCommand([], { json: true });

    expect(jsonDocument<AuthListReport>().providers[0]?.providerId).toBe("openai");
  });

  test("US-003 AC6: with the real collector and nothing stored, the document lists no provider", async () => {
    writeGlobalConfig({ source: "file" });

    await authListCommand([], { json: true });

    expect(jsonDocument<AuthListReport>().providers).toEqual([]);
  });

  test("US-003 AC7: returns 0 when the helper fails for a stored provider", async () => {
    writeGlobalConfig({ source: "file" });
    await storeFileCredential("openai", { kind: "api-key", key: "sk-stored-openai" });
    useExecHelper([helperScript], { exitCode: 1 });

    const code = await authListCommand([], { json: true });

    expect(code).toBe(0);
  });

  test("US-003 AC8: returns 1 when the auth config cannot be read", async () => {
    writeGlobalConfig({ source: "exec" });

    const code = await authListCommand([], { json: true });

    expect(code).toBe(1);
  });

  test("US-003 AC9: the error document carries AUTH_CONFIG_INVALID", async () => {
    writeGlobalConfig({ source: "exec" });

    await authListCommand([], { json: true });

    expect(jsonDocument<AuthListErrorDocument>().error.code).toBe("AUTH_CONFIG_INVALID");
  });

  test("US-003 AC10: the error document carries a non-empty message", async () => {
    writeGlobalConfig({ source: "exec" });

    await authListCommand([], { json: true });

    const { message } = jsonDocument<AuthListErrorDocument>().error;

    expect(typeof message).toBe("string");
    expect(message.length).toBeGreaterThan(0);
  });

  test("US-003 AC11: an unreadable credentials file yields CREDENTIAL_FILE_UNREADABLE", async () => {
    writeGlobalConfig({ source: "file" });
    writeFileSync(credentialFilePath(), "{ not json");

    const code = await authListCommand([], { json: true });

    expect(code).toBe(1);
    expect(jsonDocument<AuthListErrorDocument>().error.code).toBe("CREDENTIAL_FILE_UNREADABLE");
  });

  test("US-003 AC12: an unexpected collector failure yields AUTH_LIST_FAILED", async () => {
    _cliAuthDeps.collectAuthList = mock(async () => {
      throw new Error("boom");
    });

    const code = await authListCommand([], { json: true });

    expect(code).toBe(1);
    expect(jsonDocument<AuthListErrorDocument>().error.code).toBe("AUTH_LIST_FAILED");
  });
});

describe("authListCommand text mode", () => {
  test("US-003 AC13: the first line names the file credential source", async () => {
    writeGlobalConfig({ source: "file" });
    await storeFileCredential("openai", { kind: "api-key", key: "sk-stored-openai" });

    await authListCommand([]);

    expect(lines()[0]).toBe("Credential source: file");
  });

  test("US-003 AC14: the provider's row starts with two spaces then its id", async () => {
    writeGlobalConfig({ source: "file" });
    await storeFileCredential("openai", { kind: "api-key", key: "sk-stored-openai" });

    await authListCommand([]);

    expect(lines()[1]).toMatch(/^ {2}openai/);
  });

  test("US-003 AC15: the first line names the exec helper command", async () => {
    stubCollector(EXEC_REPORT);

    await authListCommand([]);

    expect(lines()[0]).toBe("Credential source: exec (cred --x)");
  });

  test("US-003 AC16: the served provider's row carries the helper account", async () => {
    stubCollector(EXEC_REPORT);

    await authListCommand([]);

    const row = lines().find((line) => line.includes("openai"));
    expect(row).toBeDefined();
    expect(row ?? "").toContain("exec (team-a)");
  });

  test("US-003 AC17: with no providers the hint is the second line", async () => {
    // A stored credential proves the hint comes from the stubbed empty report,
    // not from a fresh listing of the store.
    await storeFileCredential("openai", { kind: "api-key", key: "sk-stored-openai" });
    stubCollector({ source: "file", providers: [] });

    await authListCommand([]);

    expect(lines()[1]).toBe("No credentials stored. Add one with `nax auth login <provider>`.");
  });
});
