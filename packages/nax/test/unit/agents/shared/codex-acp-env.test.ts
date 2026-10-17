/**
 * codex-acp-env (codex-acp-read-only, US-002) — where a codex model def picks up
 * its `INITIAL_AGENT_MODE` / `CODEX_HOME`, and the isolated codex home
 * `CODEX_HOME` points at.
 *
 * Every filesystem, environment and logger touch goes through
 * `_codexAcpEnvDeps` (see `stubCodexAcpEnvDeps`), so this file never creates
 * the developer's real `~/.nax/acp/codex-home` and never reads their real
 * `~/.codex`. The tests that exercise the real default deps do so entirely
 * inside a temp dir.
 */

import { describe, expect, mock, test } from "bun:test";
import { existsSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stubCodexAcpEnvDeps, withDepsRestore, withTempDir } from "@test/helpers";
import {
  _codexAcpEnvDeps,
  type CodexAcpSettings,
  codexAcpSettings,
  isolatedCodexHomeDir,
  prepareIsolatedCodexHome,
  withCodexAcpEnv,
} from "@/agents/shared/codex-acp-env";
import { globalConfigDir } from "@/config/paths";

// The module's real implementations are put back after every test in this file;
// the tests that need the real ones say so by not stubbing.
withDepsRestore(_codexAcpEnvDeps);

/** The isolated home's auth.json entry — what both the link and the check name. */
function isolatedAuthPath(): string {
  return join(isolatedCodexHomeDir(), "auth.json");
}

/** A def shaped like the model defs `selectModel` / `complete()` hand the adapter. */
function makeDef(env?: Record<string, string>): {
  provider: string;
  model: string;
  env?: Record<string, string>;
} {
  return env === undefined ? { provider: "openai", model: "gpt" } : { provider: "openai", model: "gpt", env };
}

describe("codexAcpSettings", () => {
  test("AC-5: schema defaults when the config, or any level of it, is undefined", () => {
    expect(codexAcpSettings(undefined)).toEqual({ isolateHome: false, fullMode: "workspace-write" });
    expect(codexAcpSettings({})).toEqual({ isolateHome: false, fullMode: "workspace-write" });
    expect(codexAcpSettings({ agent: {} })).toEqual({ isolateHome: false, fullMode: "workspace-write" });
    expect(codexAcpSettings({ agent: { acp: {} } })).toEqual({ isolateHome: false, fullMode: "workspace-write" });
  });

  test("AC-5: both configured values are returned verbatim", () => {
    expect(
      codexAcpSettings({ agent: { acp: { codex: { isolateHome: true, fullMode: "agent-full-access" } } } }),
    ).toEqual({ isolateHome: true, fullMode: "agent-full-access" });
  });

  test("AC-5: a partially configured codex block keeps the other value's default", () => {
    expect(codexAcpSettings({ agent: { acp: { codex: { isolateHome: true } } } })).toEqual({
      isolateHome: true,
      fullMode: "workspace-write",
    });
    expect(codexAcpSettings({ agent: { acp: { codex: { fullMode: "agent-full-access" } } } })).toEqual({
      isolateHome: false,
      fullMode: "agent-full-access",
    });
  });
});

describe("isolatedCodexHomeDir", () => {
  test("AC-6: <globalConfigDir()>/acp/codex-home", () => {
    expect(isolatedCodexHomeDir()).toBe(join(globalConfigDir(), "acp", "codex-home"));
  });
});

describe("prepareIsolatedCodexHome", () => {
  test("AC-7: creates the isolated home and links the user's auth.json into it", () => {
    const deps = stubCodexAcpEnvDeps({
      fileExists: mock((path: string): boolean => path === join("/u", ".codex", "auth.json")),
    });

    expect(prepareIsolatedCodexHome()).toBe(isolatedCodexHomeDir());
    expect(deps.mkdir).toHaveBeenCalledWith(isolatedCodexHomeDir());
    expect(deps.symlink).toHaveBeenCalledTimes(1);
    expect(deps.symlink).toHaveBeenCalledWith(join("/u", ".codex", "auth.json"), isolatedAuthPath());
  });

  test("AC-8: a non-empty CODEX_HOME env is the source home", () => {
    const deps = stubCodexAcpEnvDeps({
      env: mock((name: string): string | undefined => (name === "CODEX_HOME" ? "/custom/codex" : undefined)),
      fileExists: mock((path: string): boolean => path === join("/custom/codex", "auth.json")),
    });

    prepareIsolatedCodexHome();
    expect(deps.env).toHaveBeenCalledWith("CODEX_HOME");
    expect(deps.symlink).toHaveBeenCalledWith(join("/custom/codex", "auth.json"), isolatedAuthPath());
  });

  test("AC-9: an empty CODEX_HOME env falls back to <homedir>/.codex", () => {
    const deps = stubCodexAcpEnvDeps({
      env: mock((name: string): string | undefined => (name === "CODEX_HOME" ? "" : undefined)),
      homedir: mock((): string => "/u"),
      fileExists: mock((path: string): boolean => path === join("/u", ".codex", "auth.json")),
    });

    prepareIsolatedCodexHome();
    expect(deps.symlink).toHaveBeenCalledWith(join("/u", ".codex", "auth.json"), isolatedAuthPath());
  });

  test("AC-10: an existing auth.json entry in the isolated home is left alone (a dangling link counts)", () => {
    const deps = stubCodexAcpEnvDeps({ entryExists: mock((_path: string): boolean => true) });

    expect(prepareIsolatedCodexHome()).toBe(isolatedCodexHomeDir());
    expect(deps.mkdir).toHaveBeenCalledWith(isolatedCodexHomeDir());
    expect(deps.symlink).not.toHaveBeenCalled();
  });

  test("AC-10: the default entryExists reads a dangling link as an entry (lstat, not stat)", async () => {
    await withTempDir(async (dir) => {
      const dangling = join(dir, "auth.json");
      symlinkSync(join(dir, "does-not-exist.json"), dangling);

      expect(_codexAcpEnvDeps.entryExists(dangling)).toBe(true);
      expect(_codexAcpEnvDeps.fileExists(dangling)).toBe(false);
    });
  });

  test("AC-11: no source auth.json means no link, but the home is still created", () => {
    const deps = stubCodexAcpEnvDeps({ fileExists: mock((_path: string): boolean => false) });

    expect(prepareIsolatedCodexHome()).toBe(isolatedCodexHomeDir());
    expect(deps.mkdir).toHaveBeenCalledWith(isolatedCodexHomeDir());
    expect(deps.symlink).not.toHaveBeenCalled();
  });

  test("AC-7: the real deps create the directory and link a real source file", async () => {
    await withTempDir(async (dir) => {
      writeFileSync(join(dir, "auth.json"), "{}\n");
      Object.assign(_codexAcpEnvDeps, { env: (name: string) => (name === "CODEX_HOME" ? dir : undefined) });

      expect(prepareIsolatedCodexHome()).toBe(isolatedCodexHomeDir());
      expect(existsSync(isolatedCodexHomeDir())).toBe(true);
      expect(readlinkSync(isolatedAuthPath())).toBe(join(dir, "auth.json"));
    });
  });
});

describe("withCodexAcpEnv", () => {
  test("AC-12: adds INITIAL_AGENT_MODE to a copy, touches no filesystem dep", () => {
    const deps = stubCodexAcpEnvDeps();
    const def = makeDef({ A: "1" });

    const out = withCodexAcpEnv(def, "codex", { isolateHome: false, fullMode: "workspace-write" });

    expect(out).not.toBe(def);
    expect(out.env).toEqual({ A: "1", INITIAL_AGENT_MODE: "workspace-write" });
    expect(def.env).toEqual({ A: "1" });
    expect(deps.mkdir).not.toHaveBeenCalled();
    expect(deps.entryExists).not.toHaveBeenCalled();
    expect(deps.fileExists).not.toHaveBeenCalled();
    expect(deps.symlink).not.toHaveBeenCalled();
  });

  test("AC-13: agent-full-access is carried through into the INITIAL_AGENT_MODE value", () => {
    stubCodexAcpEnvDeps();

    const out = withCodexAcpEnv(makeDef(), "codex", { isolateHome: false, fullMode: "agent-full-access" });

    expect(out.env?.INITIAL_AGENT_MODE).toBe("agent-full-access");
  });

  test("AC-14: isolateHome sets CODEX_HOME alongside INITIAL_AGENT_MODE", () => {
    stubCodexAcpEnvDeps();

    const out = withCodexAcpEnv(makeDef(), "codex", { isolateHome: true, fullMode: "workspace-write" });

    expect(out.env?.CODEX_HOME).toBe(isolatedCodexHomeDir());
    expect(out.env?.INITIAL_AGENT_MODE).toBe("workspace-write");
  });

  test("AC-15: any other agent — or no agent name — returns the same def, untouched", () => {
    const deps = stubCodexAcpEnvDeps();
    const claude = makeDef({ A: "1" });
    const unnamed = makeDef({ A: "1" });
    const settings: CodexAcpSettings = { isolateHome: true, fullMode: "agent-full-access" };

    expect(withCodexAcpEnv(claude, "claude", settings)).toBe(claude);
    expect(withCodexAcpEnv(unnamed, undefined, settings)).toBe(unnamed);
    expect(deps.mkdir).not.toHaveBeenCalled();
    expect(deps.entryExists).not.toHaveBeenCalled();
    expect(deps.fileExists).not.toHaveBeenCalled();
    expect(deps.symlink).not.toHaveBeenCalled();
    expect(deps.env).not.toHaveBeenCalled();
    expect(deps.homedir).not.toHaveBeenCalled();
    expect(deps.warn).not.toHaveBeenCalled();
  });

  test("AC-16: a model env that already sets both keys wins over the config", () => {
    const deps = stubCodexAcpEnvDeps();
    const def = makeDef({ CODEX_HOME: "/mine", INITIAL_AGENT_MODE: "read-only" });

    const out = withCodexAcpEnv(def, "codex", { isolateHome: true, fullMode: "agent-full-access" });

    expect(out.env).toEqual({ CODEX_HOME: "/mine", INITIAL_AGENT_MODE: "read-only" });
    // An already-pinned CODEX_HOME must not send us to the filesystem at all.
    expect(deps.mkdir).not.toHaveBeenCalled();
    expect(deps.symlink).not.toHaveBeenCalled();
  });

  test("AC-16: only the pinned key is kept — the other still comes from the config", () => {
    stubCodexAcpEnvDeps();
    const def = makeDef({ INITIAL_AGENT_MODE: "read-only" });

    const out = withCodexAcpEnv(def, "codex", { isolateHome: true, fullMode: "agent-full-access" });

    expect(out.env?.INITIAL_AGENT_MODE).toBe("read-only");
    expect(out.env?.CODEX_HOME).toBe(isolatedCodexHomeDir());
  });

  test("AC-17: an isolated home that cannot be created warns once and leaves CODEX_HOME unset", () => {
    const deps = stubCodexAcpEnvDeps({
      mkdir: mock((_path: string): void => {
        throw new Error("EACCES: permission denied");
      }),
    });

    const out = withCodexAcpEnv(makeDef({ A: "1" }), "codex", { isolateHome: true, fullMode: "workspace-write" });

    expect(out.env).toEqual({ A: "1", INITIAL_AGENT_MODE: "workspace-write" });
    expect(deps.warn).toHaveBeenCalledTimes(1);
  });

  test("US-002: the warn names the isolated home and keeps the failure message", () => {
    const warn = mock((_message: string, _data: Record<string, unknown>): void => {});
    stubCodexAcpEnvDeps({
      mkdir: mock((_path: string): void => {
        throw new Error("EACCES: permission denied");
      }),
      warn,
    });

    withCodexAcpEnv(makeDef(), "codex", { isolateHome: true, fullMode: "workspace-write" });

    expect(warn).toHaveBeenCalledTimes(1);
    const [, data] = warn.mock.calls[0];
    expect(data?.codexHome).toBe(isolatedCodexHomeDir());
    expect(data?.error).toContain("EACCES");
  });
});
