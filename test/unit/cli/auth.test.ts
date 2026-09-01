import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _authDeps } from "@/agents/native/auth";
import { _resetCredentialStore, naxCredentialStore } from "@/agents/native/credentials";
import { _cliAuthDeps, authListCommand, authLoginCommand, authRmCommand } from "@/cli/auth";

let out: string[];
const realLogin = _authDeps.login;
const realAmbient = _authDeps.ambientAuthAvailable;
const originalGlobalDir = process.env.NAX_GLOBAL_CONFIG_DIR;

beforeEach(() => {
  out = [];
  process.env.NAX_GLOBAL_CONFIG_DIR = mkdtempSync(join(tmpdir(), "nax-cli-auth-"));
  _resetCredentialStore();
  _cliAuthDeps.log = (text: string) => out.push(text);
  _cliAuthDeps.isTTY = () => true;
  _authDeps.ambientAuthAvailable = mock(async () => false);
});

afterEach(() => {
  _authDeps.login = realLogin;
  _authDeps.ambientAuthAvailable = realAmbient;
  process.env.NAX_GLOBAL_CONFIG_DIR = originalGlobalDir;
  _resetCredentialStore();
});

describe("authLoginCommand", () => {
  test("refuses without a TTY and names the environment variable path", async () => {
    _cliAuthDeps.isTTY = () => false;
    const code = await authLoginCommand("openrouter");
    expect(code).toBe(1);
    expect(out.join("\n")).toMatch(/environment variable/i);
  });

  test("reports the result as returned, without deriving kind from method", async () => {
    _authDeps.login = mock(async () => ({
      providerId: "openrouter",
      method: "oauth" as const,
      kind: "oauth" as const,
    }));
    const code = await authLoginCommand("openrouter");
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("openrouter");
    expect(out.join("\n")).toContain("oauth");
  });

  test("exits 130 with no error output when cancelled", async () => {
    class LoginCancelledError extends Error {
      constructor() {
        super("cancelled");
        this.name = "LoginCancelledError";
      }
    }
    _authDeps.login = mock(async () => {
      throw new LoginCancelledError();
    });
    const code = await authLoginCommand("openrouter");
    expect(code).toBe(130);
    expect(out.join("\n")).not.toMatch(/error|failed/i);
  });

  test("warns, without failing, when the new credential shadows a working env var", async () => {
    _authDeps.login = mock(async () => ({
      providerId: "openrouter",
      method: "api-key" as const,
      kind: "api-key" as const,
    }));
    _authDeps.ambientAuthAvailable = mock(async () => true);
    const code = await authLoginCommand("openrouter");
    expect(code).toBe(0);
    expect(out.join("\n")).toMatch(/takes precedence/i);
  });
});

describe("authListCommand", () => {
  test("says so when the store is empty", async () => {
    expect(await authListCommand()).toBe(0);
    expect(out.join("\n")).toMatch(/no credentials/i);
  });

  test("prints provider and kind but never the key", async () => {
    await naxCredentialStore().modify("openrouter", async () => ({ kind: "api-key", key: "sk-secret-value" }));
    await authListCommand();
    const text = out.join("\n");
    expect(text).toContain("openrouter");
    expect(text).toContain("api-key");
    expect(text).not.toContain("sk-secret-value");
    expect(text).not.toContain("sk-");
  });

  test("marks a shadowed credential", async () => {
    await naxCredentialStore().modify("openrouter", async () => ({ kind: "api-key", key: "sk-secret-value" }));
    _authDeps.ambientAuthAvailable = mock(async () => true);
    await authListCommand();
    expect(out.join("\n")).toMatch(/shadow/i);
  });

  test("marks an expired OAuth credential", async () => {
    await naxCredentialStore().modify("openai-codex", async () => ({
      kind: "oauth",
      access: "a",
      refresh: "r",
      expires: 1,
    }));
    await authListCommand();
    expect(out.join("\n")).toMatch(/expired/i);
  });
});

describe("authRmCommand", () => {
  test("removes the credential and never claims the user is logged out", async () => {
    await naxCredentialStore().modify("openrouter", async () => ({ kind: "api-key", key: "sk-secret-value" }));
    const code = await authRmCommand("openrouter");

    expect(code).toBe(0);
    expect(await naxCredentialStore().read("openrouter")).toBeUndefined();
    const text = out.join("\n").toLowerCase();
    expect(text).not.toContain("logged out");
    expect(text).not.toContain("log out");
    expect(text).toContain("removed locally");
  });

  test("reports a provider that has no stored credential", async () => {
    expect(await authRmCommand("absent")).toBe(1);
    expect(out.join("\n")).toMatch(/no stored credential/i);
  });
});
