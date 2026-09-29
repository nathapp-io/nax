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
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StoredCredential } from "@nathapp/nax-ai";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { _authDeps } from "@/agents/native/auth";
import { _resetCredentialStore, naxCredentialStore } from "@/agents/native/credentials";
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
const originalGlobalDir = process.env.NAX_GLOBAL_CONFIG_DIR;
const realAmbient = _authDeps.ambientAuthAvailable;

beforeEach(() => {
  dir = makeTempDir("nax-auth-list-");
  process.env.NAX_GLOBAL_CONFIG_DIR = dir;
  _resetCredentialStore();
  _authDeps.ambientAuthAvailable = mock(async () => false);
});

afterEach(() => {
  _authDeps.ambientAuthAvailable = realAmbient;
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

  test("US-002 AC20: a helper exiting 1 reports an error status with CREDENTIAL_HELPER_FAILED", async () => {
    writeGlobalConfig({ source: "file" });
    await storeFileCredential("openai", { kind: "api-key", key: "sk-stored-openai" });
    useExecHelper([helperScript], { exitCode: 1 });

    const provider = providerOf(await collectAuthList([]), "openai");

    expect(provider.exec).toEqual({ status: "error", code: "CREDENTIAL_HELPER_FAILED" });
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
