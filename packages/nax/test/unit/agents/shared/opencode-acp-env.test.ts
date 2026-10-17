/**
 * opencode-acp-env (US-002, opencode-acp-read-only) — where an opencode model def
 * picks up its `OPENCODE_CONFIG_DIR`, and the empty config dir it points at.
 *
 * Every filesystem and logger touch goes through `_opencodeAcpEnvDeps` (see
 * `stubOpencodeAcpEnvDeps`), so this file never creates the developer's real
 * `~/.nax/acp/opencode-config`.
 */

import { describe, expect, mock, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { stubOpencodeAcpEnvDeps, withDepsRestore, withTempDir } from "@test/helpers";
import {
  _opencodeAcpEnvDeps,
  isolatedOpencodeConfigDir,
  type OpencodeAcpSettings,
  opencodeAcpSettings,
  withOpencodeAcpEnv,
} from "@/agents/shared/opencode-acp-env";
import { globalConfigDir } from "@/config/paths";

// The module's real implementations are put back after every test in this file.
withDepsRestore(_opencodeAcpEnvDeps);

/** A def shaped like the model defs `selectModel` / `complete()` hand the adapter. */
function makeDef(env?: Record<string, string>): { provider: string; model: string; env?: Record<string, string> } {
  return env === undefined ? { provider: "opencode-go", model: "m" } : { provider: "opencode-go", model: "m", env };
}

describe("opencodeAcpSettings", () => {
  test("AC-4: undefined config yields the schema default", () => {
    expect(opencodeAcpSettings(undefined)).toEqual({ isolateConfig: false });
  });

  test("AC-5: an empty config object yields the schema default", () => {
    expect(opencodeAcpSettings({})).toEqual({ isolateConfig: false });
    expect(opencodeAcpSettings({ agent: {} })).toEqual({ isolateConfig: false });
    expect(opencodeAcpSettings({ agent: { acp: {} } })).toEqual({ isolateConfig: false });
    expect(opencodeAcpSettings({ agent: { acp: { opencode: {} } } })).toEqual({ isolateConfig: false });
  });

  test("AC-6: a configured isolateConfig is returned verbatim", () => {
    expect(opencodeAcpSettings({ agent: { acp: { opencode: { isolateConfig: true } } } })).toEqual({
      isolateConfig: true,
    });
  });
});

describe("isolatedOpencodeConfigDir", () => {
  test("AC-7: <globalConfigDir()>/acp/opencode-config", () => {
    expect(isolatedOpencodeConfigDir()).toBe(`${globalConfigDir()}/acp/opencode-config`);
  });
});

describe("withOpencodeAcpEnv", () => {
  test("AC-8/AC-9: isolateConfig false returns the same def and touches no dep", () => {
    const deps = stubOpencodeAcpEnvDeps();
    const def = makeDef({ A: "1" });

    expect(withOpencodeAcpEnv(def, "opencode", { isolateConfig: false })).toBe(def);
    expect(deps.mkdir).not.toHaveBeenCalled();
    expect(deps.warn).not.toHaveBeenCalled();
  });

  test("AC-10/AC-11/AC-12: isolateConfig true creates the dir once and returns a new def carrying it", () => {
    const deps = stubOpencodeAcpEnvDeps();
    const def = makeDef({ A: "1" });

    const out = withOpencodeAcpEnv(def, "opencode", { isolateConfig: true });

    expect(deps.mkdir).toHaveBeenCalledTimes(1);
    expect(deps.mkdir).toHaveBeenCalledWith(isolatedOpencodeConfigDir());
    expect(out).not.toBe(def);
    expect(out.env).toEqual({ A: "1", OPENCODE_CONFIG_DIR: isolatedOpencodeConfigDir() });
  });

  test("AC-13: the input def's env is never mutated", () => {
    stubOpencodeAcpEnvDeps();
    const def = makeDef({ A: "1" });

    withOpencodeAcpEnv(def, "opencode", { isolateConfig: true });

    expect(def.env).toEqual({ A: "1" });
  });

  test("AC-14/AC-15: a model env that already sets OPENCODE_CONFIG_DIR wins and creates no dir", () => {
    const deps = stubOpencodeAcpEnvDeps();
    const def = makeDef({ OPENCODE_CONFIG_DIR: "/mine" });

    const out = withOpencodeAcpEnv(def, "opencode", { isolateConfig: true });

    expect(out.env?.OPENCODE_CONFIG_DIR).toBe("/mine");
    expect(deps.mkdir).not.toHaveBeenCalled();
  });

  test("AC-16/AC-17: a dir that cannot be created warns once and leaves OPENCODE_CONFIG_DIR unset", () => {
    const warn = mock((_message: string, _data: Record<string, unknown>): void => {});
    stubOpencodeAcpEnvDeps({
      mkdir: mock((_path: string): void => {
        throw new Error("EACCES: permission denied");
      }),
      warn,
    });

    const out = withOpencodeAcpEnv(makeDef({ A: "1" }), "opencode", { isolateConfig: true });

    expect(out.env?.OPENCODE_CONFIG_DIR).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test("AC-16: the warn names the isolated dir and keeps the failure message", () => {
    const warn = mock((_message: string, _data: Record<string, unknown>): void => {});
    stubOpencodeAcpEnvDeps({
      mkdir: mock((_path: string): void => {
        throw new Error("EACCES: permission denied");
      }),
      warn,
    });

    withOpencodeAcpEnv(makeDef(), "opencode", { isolateConfig: true });

    const [, data] = warn.mock.calls[0];
    expect(data?.configDir).toBe(isolatedOpencodeConfigDir());
    expect(data?.error).toContain("EACCES");
  });

  test("AC-18/AC-19: another agent name returns the same def and touches no dep", () => {
    const deps = stubOpencodeAcpEnvDeps();
    const def = makeDef({ A: "1" });
    const settings: OpencodeAcpSettings = { isolateConfig: true };

    expect(withOpencodeAcpEnv(def, "claude", settings)).toBe(def);
    expect(deps.mkdir).not.toHaveBeenCalled();
    expect(deps.warn).not.toHaveBeenCalled();
  });

  test("AC-20/AC-21: no agent name returns the same def and touches no dep", () => {
    const deps = stubOpencodeAcpEnvDeps();
    const def = makeDef({ A: "1" });
    const settings: OpencodeAcpSettings = { isolateConfig: true };

    expect(withOpencodeAcpEnv(def, undefined, settings)).toBe(def);
    expect(deps.mkdir).not.toHaveBeenCalled();
    expect(deps.warn).not.toHaveBeenCalled();
  });

  test("AC-22: a def with no env at all gains exactly the one key", () => {
    stubOpencodeAcpEnvDeps();

    const out = withOpencodeAcpEnv(makeDef(), "opencode", { isolateConfig: true });

    expect(out.env).toEqual({ OPENCODE_CONFIG_DIR: isolatedOpencodeConfigDir() });
  });

  test("AC-23/AC-24: an empty-string OPENCODE_CONFIG_DIR is the operator's choice — kept, no mkdir", () => {
    const deps = stubOpencodeAcpEnvDeps();
    const def = makeDef({ OPENCODE_CONFIG_DIR: "" });

    const out = withOpencodeAcpEnv(def, "opencode", { isolateConfig: true });

    expect(out.env?.OPENCODE_CONFIG_DIR).toBe("");
    expect(deps.mkdir).not.toHaveBeenCalled();
  });
});

describe("_opencodeAcpEnvDeps.mkdir (the real implementation)", () => {
  test("creates the directory recursively and writes nothing into it", async () => {
    await withTempDir(async (dir) => {
      const nested = join(dir, "acp", "opencode-config");

      _opencodeAcpEnvDeps.mkdir(nested);

      expect(existsSync(nested)).toBe(true);
      expect(readdirSync(nested)).toEqual([]);
    });
  });
});
