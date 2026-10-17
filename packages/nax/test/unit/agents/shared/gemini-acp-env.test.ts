/**
 * gemini-acp-env (US-002, gemini-acp-read-only) — where a gemini model def picks
 * up its `GEMINI_CLI_HOME`, and the isolated gemini home it points at.
 *
 * Every filesystem, environment and logger touch goes through
 * `_geminiAcpEnvDeps` (see `stubGeminiAcpEnvDeps`), so this file never creates
 * the developer's real `~/.nax/acp/gemini-home` and never reads their real
 * `~/.gemini`. The tests that exercise the real default deps do so entirely
 * inside a temp dir.
 */

import { describe, expect, mock, test } from "bun:test";
import { lstatSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stubGeminiAcpEnvDeps, withDepsRestore, withTempDir } from "@test/helpers";
import {
  _geminiAcpEnvDeps,
  type GeminiAcpSettings,
  geminiAcpSettings,
  isolatedGeminiHomeDir,
  prepareIsolatedGeminiHome,
  withGeminiAcpEnv,
} from "@/agents/shared/gemini-acp-env";
import { globalConfigDir } from "@/config/paths";

// The module's real implementations are put back after every test in this file;
// the tests that need the real ones say so by not stubbing.
withDepsRestore(_geminiAcpEnvDeps);

/** A Google-login `settings.json`, with an unrelated mcpServers block beside it. */
const GOOGLE_LOGIN_SETTINGS = '{"security":{"auth":{"selectedType":"oauth-personal"}},"mcpServers":{"x":{}}}';
/** What the isolated settings file must contain: the auth type and nothing else. */
const ISOLATED_OAUTH_SETTINGS = '{"security":{"auth":{"selectedType":"oauth-personal"}}}';
const ISOLATED_API_KEY_SETTINGS = '{"security":{"auth":{"selectedType":"gemini-api-key"}}}';

/** gemini's own dir inside a home — the one thing both the source and the isolated home carry. */
const GEMINI_DIR = ".gemini";

/** The isolated home's gemini dir: what `prepareIsolatedGeminiHome()` creates. */
function isolatedGeminiDir(): string {
  return join(isolatedGeminiHomeDir(), GEMINI_DIR);
}

/** A source path under the default source home (`<homedir()>/.gemini`). */
function userPath(fileName: string): string {
  return join("/u", GEMINI_DIR, fileName);
}

/** A path inside the isolated home's gemini dir. */
function isolatedPath(fileName: string): string {
  return join(isolatedGeminiDir(), fileName);
}

/** A def shaped like the model defs `selectModel` / `complete()` hand the adapter. */
function makeDef(env?: Record<string, string>): {
  provider: string;
  model: string;
  env?: Record<string, string>;
} {
  return env === undefined ? { provider: "gemini", model: "m" } : { provider: "gemini", model: "m", env };
}

/**
 * The genuine `EEXIST` node throws when a second `symlink` races the first,
 * produced by the real filesystem (a second `symlinkSync` onto a path that now
 * exists) rather than hand-built, so the concurrency fix is checked against the
 * real error and its `code` rather than a stand-in.
 */
function realEexistError(dir: string): Error {
  const target = join(dir, "other-process-target.json");
  const path = join(dir, "raced-entry.json");
  symlinkSync(target, path);
  try {
    symlinkSync(target, path);
  } catch (err) {
    // The genuine node failure — `EEXIST`, `code` and all — not a stand-in.
    if (err instanceof Error && err.message.includes("EEXIST")) return err;
    throw err;
  }
  throw new Error("expected the second symlinkSync to fail with EEXIST");
}

/** The filesystem deps: everything `withGeminiAcpEnv` must not touch when it does nothing. */
const FILESYSTEM_DEP_NAMES = ["mkdir", "entryExists", "fileExists", "symlink", "readText", "writeText"] as const;

function expectNoFilesystemDepTouched(deps: ReturnType<typeof stubGeminiAcpEnvDeps>): void {
  for (const name of FILESYSTEM_DEP_NAMES) {
    expect(deps[name]).not.toHaveBeenCalled();
  }
}

describe("geminiAcpSettings", () => {
  test("AC-4: schema defaults when the config, or any level of it, is undefined", () => {
    expect(geminiAcpSettings(undefined)).toEqual({ isolateHome: false });
    expect(geminiAcpSettings({})).toEqual({ isolateHome: false });
    expect(geminiAcpSettings({ agent: {} })).toEqual({ isolateHome: false });
    expect(geminiAcpSettings({ agent: { acp: {} } })).toEqual({ isolateHome: false });
    expect(geminiAcpSettings({ agent: { acp: { gemini: {} } } })).toEqual({ isolateHome: false });
  });

  test("AC-5: a configured isolateHome is returned verbatim", () => {
    expect(geminiAcpSettings({ agent: { acp: { gemini: { isolateHome: true } } } })).toEqual({ isolateHome: true });
  });
});

describe("isolatedGeminiHomeDir", () => {
  test("AC-6: <globalConfigDir()>/acp/gemini-home", () => {
    expect(isolatedGeminiHomeDir()).toBe(join(globalConfigDir(), "acp", "gemini-home"));
  });
});

describe("prepareIsolatedGeminiHome", () => {
  test("AC-7: creates the isolated home's .gemini dir", () => {
    const deps = stubGeminiAcpEnvDeps();

    prepareIsolatedGeminiHome();

    expect(deps.mkdir).toHaveBeenCalledTimes(1);
    expect(deps.mkdir).toHaveBeenCalledWith(isolatedGeminiDir());
  });

  test("AC-8: links the operator's oauth_creds.json into it", () => {
    const deps = stubGeminiAcpEnvDeps();

    prepareIsolatedGeminiHome();

    expect(deps.symlink).toHaveBeenCalledWith(userPath("oauth_creds.json"), isolatedPath("oauth_creds.json"));
  });

  test("AC-9: links the operator's gemini-credentials.json into it", () => {
    const deps = stubGeminiAcpEnvDeps();

    prepareIsolatedGeminiHome();

    expect(deps.symlink).toHaveBeenCalledWith(
      userPath("gemini-credentials.json"),
      isolatedPath("gemini-credentials.json"),
    );
  });

  test("AC-10: writes only security.auth.selectedType, dropping mcpServers and everything else", () => {
    const deps = stubGeminiAcpEnvDeps({
      readText: mock((_path: string): string | undefined => GOOGLE_LOGIN_SETTINGS),
    });

    prepareIsolatedGeminiHome();

    expect(deps.readText).toHaveBeenCalledWith(userPath("settings.json"));
    expect(deps.writeText).toHaveBeenCalledTimes(1);
    expect(deps.writeText).toHaveBeenCalledWith(isolatedPath("settings.json"), ISOLATED_OAUTH_SETTINGS);
  });

  test("AC-11: returns the isolated home", () => {
    stubGeminiAcpEnvDeps();

    expect(prepareIsolatedGeminiHome()).toBe(isolatedGeminiHomeDir());
  });

  test("AC-12: a non-empty GEMINI_CLI_HOME is the source home", () => {
    const deps = stubGeminiAcpEnvDeps({
      env: mock((name: string): string | undefined => (name === "GEMINI_CLI_HOME" ? "/custom" : undefined)),
    });

    prepareIsolatedGeminiHome();

    expect(deps.env).toHaveBeenCalledWith("GEMINI_CLI_HOME");
    expect(deps.symlink).toHaveBeenCalledWith("/custom/.gemini/oauth_creds.json", isolatedPath("oauth_creds.json"));
  });

  test("AC-13: an empty-string GEMINI_CLI_HOME falls back to <homedir>/.gemini", () => {
    const deps = stubGeminiAcpEnvDeps({
      env: mock((name: string): string | undefined => (name === "GEMINI_CLI_HOME" ? "" : undefined)),
      homedir: mock((): string => "/u"),
    });

    prepareIsolatedGeminiHome();

    expect(deps.homedir).toHaveBeenCalled();
    expect(deps.symlink).toHaveBeenCalledWith(userPath("oauth_creds.json"), isolatedPath("oauth_creds.json"));
  });

  test("AC-14: an existing isolated credentials entry is never replaced", () => {
    const deps = stubGeminiAcpEnvDeps({
      entryExists: mock((path: string): boolean => path === isolatedPath("oauth_creds.json")),
    });

    prepareIsolatedGeminiHome();

    expect(deps.symlink).not.toHaveBeenCalledWith(userPath("oauth_creds.json"), isolatedPath("oauth_creds.json"));
    // Only the entry that exists is skipped — the other one is still linked.
    expect(deps.symlink).toHaveBeenCalledWith(
      userPath("gemini-credentials.json"),
      isolatedPath("gemini-credentials.json"),
    );
  });

  test("AC-14: the default entryExists reads a dangling link as an entry (lstat, not stat)", async () => {
    await withTempDir(async (dir) => {
      const dangling = join(dir, "oauth_creds.json");
      symlinkSync(join(dir, "does-not-exist.json"), dangling);

      expect(_geminiAcpEnvDeps.entryExists(dangling)).toBe(true);
      expect(_geminiAcpEnvDeps.fileExists(dangling)).toBe(false);
    });
  });

  test("US-002: the default readText answers undefined for an absent file and throws for an unreadable one", async () => {
    await withTempDir(async (dir) => {
      expect(_geminiAcpEnvDeps.readText(join(dir, "settings.json"))).toBeUndefined();
      // A directory is the one unreadable path every machine can produce; the
      // throw is what `withGeminiAcpEnv` turns into its one warn (fail open).
      expect(() => _geminiAcpEnvDeps.readText(dir)).toThrow();
    });
  });

  test("AC-15: a source credentials file that is not there is not linked", () => {
    const deps = stubGeminiAcpEnvDeps({
      fileExists: mock((path: string): boolean => path !== userPath("oauth_creds.json")),
    });

    prepareIsolatedGeminiHome();

    expect(deps.symlink).not.toHaveBeenCalledWith(userPath("oauth_creds.json"), isolatedPath("oauth_creds.json"));
    expect(deps.symlink).toHaveBeenCalledWith(
      userPath("gemini-credentials.json"),
      isolatedPath("gemini-credentials.json"),
    );
  });

  test("B1: a credential link lost to a concurrent nax process (EEXIST) does not fail preparation", async () => {
    await withTempDir(async (dir) => {
      const eexist = realEexistError(dir);
      const racedEntry = isolatedPath("oauth_creds.json");
      let otherProcessWon = false;
      const deps = stubGeminiAcpEnvDeps({
        // Our absent-entry check runs before the other process's link lands;
        // the confirmation after the failed symlink runs after it.
        entryExists: mock((path: string): boolean => path === racedEntry && otherProcessWon),
        symlink: mock((_target: string, path: string): void => {
          if (path !== racedEntry) return;
          otherProcessWon = true;
          throw eexist;
        }),
      });

      expect(prepareIsolatedGeminiHome()).toBe(isolatedGeminiHomeDir());

      // The loser keeps going: the other credential is still linked and the
      // settings file is still written, so preparation is not skipped.
      expect(deps.symlink).toHaveBeenCalledTimes(2);
      expect(deps.symlink).toHaveBeenCalledWith(
        userPath("gemini-credentials.json"),
        isolatedPath("gemini-credentials.json"),
      );
      expect(deps.writeText).toHaveBeenCalledWith(isolatedPath("settings.json"), ISOLATED_OAUTH_SETTINGS);
    });
  });

  test("B1: the real deps tolerate the EEXIST a concurrent process causes", async () => {
    await withTempDir(async (dir) => {
      const sourceGeminiDir = join(dir, GEMINI_DIR);
      _geminiAcpEnvDeps.mkdir(sourceGeminiDir);
      writeFileSync(join(sourceGeminiDir, "oauth_creds.json"), "{}\n");
      writeFileSync(join(sourceGeminiDir, "settings.json"), GOOGLE_LOGIN_SETTINGS);

      // The isolated home itself is global state (shared by every nax process
      // on the machine), so this test gives itself one inside the temp dir
      // rather than leaving links behind in the run's real one.
      const globalDirBefore = process.env.NAX_GLOBAL_CONFIG_DIR;
      process.env.NAX_GLOBAL_CONFIG_DIR = join(dir, "global-nax");
      try {
        const racedEntry = isolatedPath("oauth_creds.json");
        // The other nax process's link, already in the shared isolated home.
        _geminiAcpEnvDeps.mkdir(isolatedGeminiDir());
        symlinkSync(join(sourceGeminiDir, "oauth_creds.json"), racedEntry);

        const realEntryExists = _geminiAcpEnvDeps.entryExists;
        let oauthChecks = 0;
        Object.assign(_geminiAcpEnvDeps, {
          env: (name: string): string | undefined => (name === "GEMINI_CLI_HOME" ? dir : undefined),
          // Only the absent-entry check runs before that link lands; the
          // confirmation after the real, failed `symlink` sees the real entry.
          entryExists: (path: string): boolean =>
            path === racedEntry && oauthChecks++ === 0 ? false : realEntryExists(path),
        });

        expect(prepareIsolatedGeminiHome()).toBe(isolatedGeminiHomeDir());

        // The other process's link is untouched and preparation still finished.
        expect(lstatSync(racedEntry).isSymbolicLink()).toBe(true);
        expect(readlinkSync(racedEntry)).toBe(join(sourceGeminiDir, "oauth_creds.json"));
        expect(readFileSync(isolatedPath("settings.json"), "utf8")).toBe(ISOLATED_OAUTH_SETTINGS);
      } finally {
        if (globalDirBefore === undefined) delete process.env.NAX_GLOBAL_CONFIG_DIR;
        else process.env.NAX_GLOBAL_CONFIG_DIR = globalDirBefore;
      }
    });
  });

  test("B1: an EEXIST whose destination is still absent stays a real failure", async () => {
    await withTempDir(async (dir) => {
      const eexist = realEexistError(dir);
      stubGeminiAcpEnvDeps({
        entryExists: mock((_path: string): boolean => false),
        symlink: mock((_target: string, _path: string): void => {
          throw eexist;
        }),
      });

      expect(() => prepareIsolatedGeminiHome()).toThrow("EEXIST");
    });
  });

  test("B1: a link failure that is not EEXIST still propagates", () => {
    stubGeminiAcpEnvDeps({
      symlink: mock((_target: string, _path: string): void => {
        throw new Error("EACCES: permission denied");
      }),
    });

    expect(() => prepareIsolatedGeminiHome()).toThrow("EACCES");
  });

  const NO_AUTH_TYPE_CASES: Array<[string, string | undefined]> = [
    ["no source settings file", undefined],
    ["settings with no security block", '{"mcpServers":{}}'],
    ["settings with no auth block", '{"security":{}}'],
    ["settings with no selectedType", '{"security":{"auth":{}}}'],
    ["a numeric selectedType", '{"security":{"auth":{"selectedType":123}}}'],
    ["an empty-string selectedType", '{"security":{"auth":{"selectedType":""}}}'],
    ["a JSON array", "[1,2]"],
    ["JSON null", "null"],
  ];

  test.each(NO_AUTH_TYPE_CASES)("AC-16/AC-17: %s writes no settings file and logs no warn", (_name, text) => {
    const deps = stubGeminiAcpEnvDeps({
      readText: mock((_path: string): string | undefined => text),
    });

    prepareIsolatedGeminiHome();

    expect(deps.writeText).not.toHaveBeenCalled();
    expect(deps.warn).not.toHaveBeenCalled();
  });

  test("AC-18: unparseable source settings write no settings file", () => {
    const deps = stubGeminiAcpEnvDeps({
      readText: mock((_path: string): string | undefined => "not json at all"),
    });

    prepareIsolatedGeminiHome();

    expect(deps.writeText).not.toHaveBeenCalled();
  });

  test("AC-19: unparseable source settings call warn exactly once", () => {
    const deps = stubGeminiAcpEnvDeps({
      readText: mock((_path: string): string | undefined => "not json at all"),
    });

    prepareIsolatedGeminiHome();

    expect(deps.warn).toHaveBeenCalledTimes(1);
  });

  test("AC-20: an isolated settings.json that already exists is rewritten, not skipped", () => {
    const deps = stubGeminiAcpEnvDeps({
      entryExists: mock((_path: string): boolean => true),
      readText: mock((_path: string): string | undefined =>
        JSON.stringify({ security: { auth: { selectedType: "gemini-api-key" } } }),
      ),
    });

    prepareIsolatedGeminiHome();

    expect(deps.writeText).toHaveBeenCalledWith(isolatedPath("settings.json"), ISOLATED_API_KEY_SETTINGS);
  });

  test("US-002: the real deps create the dir and link a real source file", async () => {
    await withTempDir(async (dir) => {
      const sourceGeminiDir = join(dir, GEMINI_DIR);
      _geminiAcpEnvDeps.mkdir(sourceGeminiDir);
      writeFileSync(join(sourceGeminiDir, "oauth_creds.json"), "{}\n");
      writeFileSync(join(sourceGeminiDir, "settings.json"), GOOGLE_LOGIN_SETTINGS);
      Object.assign(_geminiAcpEnvDeps, {
        env: (name: string): string | undefined => (name === "GEMINI_CLI_HOME" ? dir : undefined),
      });

      expect(prepareIsolatedGeminiHome()).toBe(isolatedGeminiHomeDir());

      expect(readlinkSync(isolatedPath("oauth_creds.json"))).toBe(join(sourceGeminiDir, "oauth_creds.json"));
      expect(readFileSync(isolatedPath("settings.json"), "utf8")).toBe(ISOLATED_OAUTH_SETTINGS);
      // Nothing else came across: the operator's mcpServers are gone.
      expect(readFileSync(isolatedPath("settings.json"), "utf8")).not.toContain("mcpServers");
    });
  });
});

describe("withGeminiAcpEnv", () => {
  test("AC-21: isolateHome true gives a NEW def carrying GEMINI_CLI_HOME", () => {
    stubGeminiAcpEnvDeps();
    const def = makeDef({ A: "1" });

    const out = withGeminiAcpEnv(def, "gemini", { isolateHome: true });

    expect(out).not.toBe(def);
    expect(out.env).toEqual({ A: "1", GEMINI_CLI_HOME: isolatedGeminiHomeDir() });
  });

  test("AC-22: the input def's env is never mutated", () => {
    stubGeminiAcpEnvDeps();
    const def = makeDef({ A: "1" });

    withGeminiAcpEnv(def, "gemini", { isolateHome: true });

    expect(def.env).toEqual({ A: "1" });
  });

  test("AC-23/AC-24: disabled, another agent or no agent name returns the same def and touches no dep", () => {
    const deps = stubGeminiAcpEnvDeps();
    const off = makeDef({ A: "1" });
    const claude = makeDef({ A: "1" });
    const unnamed = makeDef({ A: "1" });

    expect(withGeminiAcpEnv(off, "gemini", { isolateHome: false })).toBe(off);
    expect(withGeminiAcpEnv(claude, "claude", { isolateHome: true })).toBe(claude);
    expect(withGeminiAcpEnv(unnamed, undefined, { isolateHome: true })).toBe(unnamed);

    expectNoFilesystemDepTouched(deps);
    expect(deps.env).not.toHaveBeenCalled();
    expect(deps.homedir).not.toHaveBeenCalled();
    expect(deps.warn).not.toHaveBeenCalled();
  });

  test("AC-25: a def with no env at all gains exactly the one key", () => {
    stubGeminiAcpEnvDeps();

    const out = withGeminiAcpEnv(makeDef(), "gemini", { isolateHome: true });

    expect(out.env).toEqual({ GEMINI_CLI_HOME: isolatedGeminiHomeDir() });
  });

  test("AC-26/AC-27: a model env that already sets GEMINI_CLI_HOME wins, and prepares nothing", () => {
    const deps = stubGeminiAcpEnvDeps();
    const def = makeDef({ GEMINI_CLI_HOME: "/mine" });

    const out = withGeminiAcpEnv(def, "gemini", { isolateHome: true });

    expect(out.env?.GEMINI_CLI_HOME).toBe("/mine");
    expectNoFilesystemDepTouched(deps);
    expect(deps.warn).not.toHaveBeenCalled();
  });

  test("AC-28/AC-29: an empty-string GEMINI_CLI_HOME is the operator's choice — kept, nothing prepared", () => {
    const deps = stubGeminiAcpEnvDeps();
    const def = makeDef({ GEMINI_CLI_HOME: "" });

    const out = withGeminiAcpEnv(def, "gemini", { isolateHome: true });

    expect(out.env?.GEMINI_CLI_HOME).toBe("");
    expectNoFilesystemDepTouched(deps);
    expect(deps.warn).not.toHaveBeenCalled();
  });

  test("AC-30: a home that cannot be prepared fails open — the same def, no GEMINI_CLI_HOME", () => {
    stubGeminiAcpEnvDeps({
      mkdir: mock((_path: string): void => {
        throw new Error("EACCES: permission denied");
      }),
    });
    const def = makeDef({ A: "1" });

    const out = withGeminiAcpEnv(def, "gemini", { isolateHome: true });

    expect(out).toBe(def);
    expect(out.env).toEqual({ A: "1" });
  });

  test("AC-31: that failure warns exactly once, naming the isolated home", () => {
    const warn = mock((_message: string, _data: Record<string, unknown>): void => {});
    stubGeminiAcpEnvDeps({
      mkdir: mock((_path: string): void => {
        throw new Error("EACCES: permission denied");
      }),
      warn,
    });

    withGeminiAcpEnv(makeDef(), "gemini", { isolateHome: true });

    expect(warn).toHaveBeenCalledTimes(1);
    const [, data] = warn.mock.calls[0];
    expect(data?.geminiHome).toBe(isolatedGeminiHomeDir());
    expect(data?.error).toContain("EACCES");
  });

  test("B1: the isolated home still reaches the def when a link was lost to a concurrent process", async () => {
    await withTempDir(async (dir) => {
      const eexist = realEexistError(dir);
      const racedEntry = isolatedPath("oauth_creds.json");
      let otherProcessWon = false;
      const deps = stubGeminiAcpEnvDeps({
        entryExists: mock((path: string): boolean => path === racedEntry && otherProcessWon),
        symlink: mock((_target: string, path: string): void => {
          if (path !== racedEntry) return;
          otherProcessWon = true;
          throw eexist;
        }),
      });

      const out = withGeminiAcpEnv(makeDef({ A: "1" }), "gemini", { isolateHome: true });

      expect(out.env).toEqual({ A: "1", GEMINI_CLI_HOME: isolatedGeminiHomeDir() });
      expect(deps.warn).not.toHaveBeenCalled();
    });
  });

  test("B1: a credential link that fails for another reason still fails open with one warn", () => {
    const deps = stubGeminiAcpEnvDeps({
      symlink: mock((_target: string, _path: string): void => {
        throw new Error("EACCES: permission denied");
      }),
    });
    const def = makeDef({ A: "1" });

    expect(withGeminiAcpEnv(def, "gemini", { isolateHome: true })).toBe(def);
    expect(deps.warn).toHaveBeenCalledTimes(1);
  });

  test("AC-39: unparseable source settings still isolate the home, leaving GEMINI_API_KEY auth available", () => {
    stubGeminiAcpEnvDeps({
      readText: mock((_path: string): string | undefined => "not json at all"),
    });

    const out = withGeminiAcpEnv(makeDef({ GEMINI_API_KEY: "test-key" }), "gemini", { isolateHome: true });

    expect(out.env).toEqual({ GEMINI_API_KEY: "test-key", GEMINI_CLI_HOME: isolatedGeminiHomeDir() });
  });

  test("US-002: the settings object type is the only thing the injection reads", () => {
    const settings: GeminiAcpSettings = { isolateHome: true };
    stubGeminiAcpEnvDeps();

    expect(withGeminiAcpEnv(makeDef({ A: "1" }), "gemini", settings).env?.GEMINI_CLI_HOME).toBe(
      isolatedGeminiHomeDir(),
    );
  });
});
