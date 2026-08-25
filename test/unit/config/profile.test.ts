/**
 * profile.ts — Unit tests for profile resolution functions.
 *
 * Story US-001-C
 * Tests: loadProfile, loadProfileEnv, resolveProfileName, listProfiles
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  _profileDeps,
  listProfiles,
  loadProfile,
  loadProfileEnv,
  parseProfileList,
  profileOverrideFromConfig,
  resolveProfileName,
  resolveProfileNames,
} from "@/config/profile";
import { cleanupTempDir, makeTempDir } from "@test/helpers";

describe("config/profile", () => {
  let globalDir: string;
  let projectDir: string;
  let savedGlobalEnv: string | undefined;

  beforeEach(() => {
    globalDir = makeTempDir("nax-global-");
    projectDir = makeTempDir("nax-project-");
    savedGlobalEnv = process.env.NAX_GLOBAL_CONFIG_DIR;
    process.env.NAX_GLOBAL_CONFIG_DIR = globalDir;
  });

  afterEach(() => {
    cleanupTempDir(globalDir);
    cleanupTempDir(projectDir);
    if (savedGlobalEnv === undefined) {
      delete process.env.NAX_GLOBAL_CONFIG_DIR;
    } else {
      process.env.NAX_GLOBAL_CONFIG_DIR = savedGlobalEnv;
    }
  });

  // ---------------------------------------------------------------------------
  // loadProfile
  // ---------------------------------------------------------------------------

  describe("loadProfile", () => {
    test("returns deep-merged contents when both global and project fast.json exist, with project values taking precedence", async () => {
      const globalProfilesDir = join(globalDir, "profiles");
      const projectProfilesDir = join(projectDir, ".nax", "profiles");
      mkdirSync(globalProfilesDir, { recursive: true });
      mkdirSync(projectProfilesDir, { recursive: true });

      await Bun.write(
        join(globalProfilesDir, "fast.json"),
        JSON.stringify({ tier: "fast", timeout: 30, extra: "global-only" }),
      );
      await Bun.write(join(projectProfilesDir, "fast.json"), JSON.stringify({ tier: "fast", timeout: 60 }));

      const result = await loadProfile("fast", projectDir);

      // project timeout overrides global
      expect((result as Record<string, unknown>).timeout).toBe(60);
      // global-only key is preserved via deep merge
      expect((result as Record<string, unknown>).extra).toBe("global-only");
      // shared key reflects project value
      expect((result as Record<string, unknown>).tier).toBe("fast");
    });

    test("returns only global profile contents when no project-level fast.json exists", async () => {
      const globalProfilesDir = join(globalDir, "profiles");
      mkdirSync(globalProfilesDir, { recursive: true });

      await Bun.write(join(globalProfilesDir, "fast.json"), JSON.stringify({ tier: "fast", timeout: 30 }));

      const result = await loadProfile("fast", projectDir);

      expect((result as Record<string, unknown>).tier).toBe("fast");
      expect((result as Record<string, unknown>).timeout).toBe(30);
    });

    test("throws an error whose message contains the profile name and Available list when neither global nor project profile exists", async () => {
      // Pre-create a profile so the available list is non-empty
      const globalProfilesDir = join(globalDir, "profiles");
      mkdirSync(globalProfilesDir, { recursive: true });
      await Bun.write(join(globalProfilesDir, "fast.json"), JSON.stringify({ tier: "fast" }));

      const err = await loadProfile("nonexistent", projectDir).catch((e: Error) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as { code?: string }).code).toBe("PROFILE_NOT_FOUND");
      expect(err.message).toContain("nonexistent");
      expect(err.message).toContain("Available:");
      expect(err.message).toContain("fast");
    });
  });

  // ---------------------------------------------------------------------------
  // loadProfileEnv
  // ---------------------------------------------------------------------------

  describe("loadProfileEnv", () => {
    test("returns merged env map from global and project .env files, with project values taking precedence over global", async () => {
      const globalProfilesDir = join(globalDir, "profiles");
      const projectProfilesDir = join(projectDir, ".nax", "profiles");
      mkdirSync(globalProfilesDir, { recursive: true });
      mkdirSync(projectProfilesDir, { recursive: true });

      await Bun.write(join(globalProfilesDir, "fast.env"), "GLOBAL_ONLY=global_value\nSHARED_KEY=from_global\n");
      await Bun.write(join(projectProfilesDir, "fast.env"), "PROJECT_ONLY=project_value\nSHARED_KEY=from_project\n");

      const result = await loadProfileEnv("fast", projectDir);

      // global-only key present
      expect(result.GLOBAL_ONLY).toBe("global_value");
      // project-only key present
      expect(result.PROJECT_ONLY).toBe("project_value");
      // project overrides global for shared key
      expect(result.SHARED_KEY).toBe("from_project");
    });

    test("profile env values override process.env entries for the same key", async () => {
      const globalProfilesDir = join(globalDir, "profiles");
      const projectProfilesDir = join(projectDir, ".nax", "profiles");
      mkdirSync(globalProfilesDir, { recursive: true });
      mkdirSync(projectProfilesDir, { recursive: true });

      const envKey = "NAX_PROFILE_TEST_VAR_OVERRIDE";
      const savedValue = process.env[envKey];
      process.env[envKey] = "from_process_env";

      await Bun.write(join(globalProfilesDir, "fast.env"), "");
      await Bun.write(join(projectProfilesDir, "fast.env"), `${envKey}=from_profile\n`);

      const result = await loadProfileEnv("fast", projectDir);

      // profile value overrides process.env
      expect(result[envKey]).toBe("from_profile");

      // restore
      if (savedValue === undefined) {
        delete process.env[envKey];
      } else {
        process.env[envKey] = savedValue;
      }
    });

    // BUG-21: previously returned {} when the profile had no .env companion
    // files, even though the function's own docstring says values "override
    // process.env entries" — implying process.env is a base layer. A profile
    // referencing an ambient var like $HOME with no .env file hard-failed.
    test("BUG-21: falls back to process.env as the base layer when no .env files exist for the profile", async () => {
      const globalProfilesDir = join(globalDir, "profiles");
      mkdirSync(globalProfilesDir, { recursive: true });
      await Bun.write(join(globalProfilesDir, "fast.json"), JSON.stringify({ tier: "fast" }));

      const origEnv = _profileDeps.env;
      _profileDeps.env = { AMBIENT_VAR: "ambient_value" };
      try {
        const result = await loadProfileEnv("fast", projectDir);
        expect(result.AMBIENT_VAR).toBe("ambient_value");
      } finally {
        _profileDeps.env = origEnv;
      }
    });

    test("BUG-21: profile .env values still override process.env for the same key when no profile file at all", async () => {
      const origEnv = _profileDeps.env;
      _profileDeps.env = { SHARED: "from_process_env" };
      try {
        const result = await loadProfileEnv("nonexistent-profile-name", projectDir);
        expect(result.SHARED).toBe("from_process_env");
      } finally {
        _profileDeps.env = origEnv;
      }
    });

    // BUG-21 defense-in-depth: folding all of process.env into the $VAR
    // substitution base must not make secret-shaped ambient vars silently
    // substitutable by a project-controlled profile.json.
    test("BUG-21: secret-shaped ambient env var names are excluded from the process.env fallback", async () => {
      const origEnv = _profileDeps.env;
      _profileDeps.env = {
        AWS_SECRET_ACCESS_KEY: "super-secret",
        GITHUB_TOKEN: "gh-token-value",
        DB_PASSWORD: "hunter2",
        SOME_CREDENTIAL: "cred-value",
        SAFE_VAR: "safe-value",
      };
      try {
        const result = await loadProfileEnv("nonexistent-profile-name", projectDir);
        expect(result.AWS_SECRET_ACCESS_KEY).toBeUndefined();
        expect(result.GITHUB_TOKEN).toBeUndefined();
        expect(result.DB_PASSWORD).toBeUndefined();
        expect(result.SOME_CREDENTIAL).toBeUndefined();
        expect(result.SAFE_VAR).toBe("safe-value");
      } finally {
        _profileDeps.env = origEnv;
      }
    });

    test("BUG-21: a profile's own .env file can still explicitly set a secret-shaped key", async () => {
      const projectProfilesDir = join(projectDir, ".nax", "profiles");
      mkdirSync(projectProfilesDir, { recursive: true });
      await Bun.write(join(projectProfilesDir, "fast.env"), "GITHUB_TOKEN=explicitly-set-by-profile\n");

      const origEnv = _profileDeps.env;
      _profileDeps.env = { GITHUB_TOKEN: "ambient-should-be-excluded" };
      try {
        const result = await loadProfileEnv("fast", projectDir);
        expect(result.GITHUB_TOKEN).toBe("explicitly-set-by-profile");
      } finally {
        _profileDeps.env = origEnv;
      }
    });
  });

  // ---------------------------------------------------------------------------
  // resolveProfileName
  // ---------------------------------------------------------------------------

  describe("resolveProfileName", () => {
    test("returns CLI profile when provided — CLI takes priority over NAX_PROFILE env var", async () => {
      const result = await resolveProfileName({ profile: "cli" }, { NAX_PROFILE: "env" }, projectDir);
      expect(result).toBe("cli");
    });

    test("returns NAX_PROFILE env var when no CLI override is given", async () => {
      const result = await resolveProfileName({}, { NAX_PROFILE: "env" }, projectDir);
      expect(result).toBe("env");
    });

    test("returns profile from project config.json when no CLI or env override", async () => {
      const projectNaxDir = join(projectDir, ".nax");
      mkdirSync(projectNaxDir, { recursive: true });
      await Bun.write(join(projectNaxDir, "config.json"), JSON.stringify({ profile: "persisted" }));

      const result = await resolveProfileName({}, {}, projectDir);
      expect(result).toBe("persisted");
    });

    test("falls back to global config.json profile field when project config has none", async () => {
      const globalNaxDir = join(globalDir);
      mkdirSync(globalNaxDir, { recursive: true });
      await Bun.write(join(globalNaxDir, "config.json"), JSON.stringify({ profile: "global-profile" }));

      const result = await resolveProfileName({}, {}, projectDir);
      expect(result).toBe("global-profile");
    });

    test("project config.json profile takes precedence over global config.json profile", async () => {
      const projectNaxDir = join(projectDir, ".nax");
      mkdirSync(projectNaxDir, { recursive: true });
      await Bun.write(join(projectNaxDir, "config.json"), JSON.stringify({ profile: "project-profile" }));
      const globalNaxDir = join(globalDir);
      mkdirSync(globalNaxDir, { recursive: true });
      await Bun.write(join(globalNaxDir, "config.json"), JSON.stringify({ profile: "global-profile" }));

      const result = await resolveProfileName({}, {}, projectDir);
      expect(result).toBe("project-profile");
    });

    test('returns "default" when no profile is set anywhere', async () => {
      const result = await resolveProfileName({}, {}, projectDir);
      expect(result).toBe("default");
    });
  });

  // ---------------------------------------------------------------------------
  // parseProfileList
  // ---------------------------------------------------------------------------

  describe("parseProfileList", () => {
    test("returns empty array for undefined/null/empty", () => {
      expect(parseProfileList(undefined)).toEqual([]);
      expect(parseProfileList(null)).toEqual([]);
      expect(parseProfileList("")).toEqual([]);
      expect(parseProfileList([])).toEqual([]);
    });

    test("splits a comma-separated string into an ordered chain", () => {
      expect(parseProfileList("a,b,c")).toEqual(["a", "b", "c"]);
    });

    test("trims whitespace and drops empty segments", () => {
      expect(parseProfileList(" a , b ,, c ,")).toEqual(["a", "b", "c"]);
    });

    test("flattens an array of values, splitting each on commas (repeated-flag form)", () => {
      expect(parseProfileList(["a", "b,c"])).toEqual(["a", "b", "c"]);
    });

    test("preserves order and does not dedupe", () => {
      expect(parseProfileList("a,b,a")).toEqual(["a", "b", "a"]);
    });

    test("ignores non-string array entries", () => {
      // Round-tripped through JSON, as an untyped caller (config file) would
      // supply it — parseProfileList guards on typeof despite the string[] type.
      expect(parseProfileList(JSON.parse('["a", 42, "b"]'))).toEqual(["a", "b"]);
    });
  });

  // ---------------------------------------------------------------------------
  // profileOverrideFromConfig
  // ---------------------------------------------------------------------------

  describe("profileOverrideFromConfig", () => {
    test("returns the round-trippable chain array, not the composite string", () => {
      expect(profileOverrideFromConfig({ profile: "a+b", profileChain: ["a", "b"] })).toEqual({
        profile: ["a", "b"],
      });
    });

    test("falls back to the single profile string when no chain is present", () => {
      expect(profileOverrideFromConfig({ profile: "fast" })).toEqual({ profile: ["fast"] });
    });

    test('returns undefined for "default" / empty', () => {
      expect(profileOverrideFromConfig({ profile: "default" })).toBeUndefined();
      expect(profileOverrideFromConfig({ profile: "default", profileChain: [] })).toBeUndefined();
      expect(profileOverrideFromConfig({})).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // resolveProfileNames (chain)
  // ---------------------------------------------------------------------------

  describe("resolveProfileNames", () => {
    test("returns CLI chain (comma form) — CLI wins over env", async () => {
      const result = await resolveProfileNames({ profile: "a,b" }, { NAX_PROFILE: "env" }, projectDir);
      expect(result).toEqual(["a", "b"]);
    });

    test("returns CLI chain (array form, repeated flags)", async () => {
      const result = await resolveProfileNames({ profile: ["a", "b"] }, {}, projectDir);
      expect(result).toEqual(["a", "b"]);
    });

    test("parses NAX_PROFILE comma form when no CLI override", async () => {
      const result = await resolveProfileNames({}, { NAX_PROFILE: "x,y" }, projectDir);
      expect(result).toEqual(["x", "y"]);
    });

    test("parses project config.json profile comma form", async () => {
      const projectNaxDir = join(projectDir, ".nax");
      mkdirSync(projectNaxDir, { recursive: true });
      await Bun.write(join(projectNaxDir, "config.json"), JSON.stringify({ profile: "p,q" }));

      const result = await resolveProfileNames({}, {}, projectDir);
      expect(result).toEqual(["p", "q"]);
    });

    test("parses project config.json profile array form", async () => {
      const projectNaxDir = join(projectDir, ".nax");
      mkdirSync(projectNaxDir, { recursive: true });
      await Bun.write(join(projectNaxDir, "config.json"), JSON.stringify({ profile: ["p", "q"] }));

      const result = await resolveProfileNames({}, {}, projectDir);
      expect(result).toEqual(["p", "q"]);
    });

    test('a single "default" in project config falls through to global then "default"', async () => {
      const projectNaxDir = join(projectDir, ".nax");
      mkdirSync(projectNaxDir, { recursive: true });
      await Bun.write(join(projectNaxDir, "config.json"), JSON.stringify({ profile: "default" }));
      await Bun.write(join(globalDir, "config.json"), JSON.stringify({ profile: "g1,g2" }));

      const result = await resolveProfileNames({}, {}, projectDir);
      expect(result).toEqual(["g1", "g2"]);
    });

    test('returns ["default"] when nothing is set anywhere', async () => {
      const result = await resolveProfileNames({}, {}, projectDir);
      expect(result).toEqual(["default"]);
    });

    // BUG-40: a corrupt project config.json used to surface here as a raw,
    // unguarded SyntaxError with no NaxError context — before loadConfig's
    // own tolerant/strict layer loader even got a chance to run. This must
    // degrade to an empty chain instead, letting the strict layer loader
    // (SEC-5) be the one and only place that raises the real error.
    test("a corrupt project config.json degrades to an empty chain instead of throwing", async () => {
      const projectNaxDir = join(projectDir, ".nax");
      mkdirSync(projectNaxDir, { recursive: true });
      await Bun.write(join(projectNaxDir, "config.json"), '{ "profile": "p,q", }');

      const result = await resolveProfileNames({}, {}, projectDir);
      expect(result).toEqual(["default"]);
    });

    test("resolveProfileName (singular) returns the last meaningful name for back-compat", async () => {
      const result = await resolveProfileName({ profile: "a,b" }, {}, projectDir);
      expect(result).toBe("b");
    });
  });

  // ---------------------------------------------------------------------------
  // listProfiles
  // ---------------------------------------------------------------------------

  describe("listProfiles", () => {
    test("returns profile names and paths from both global and project scopes", async () => {
      const globalProfilesDir = join(globalDir, "profiles");
      const projectProfilesDir = join(projectDir, ".nax", "profiles");
      mkdirSync(globalProfilesDir, { recursive: true });
      mkdirSync(projectProfilesDir, { recursive: true });

      await Bun.write(join(globalProfilesDir, "fast.json"), JSON.stringify({ tier: "fast" }));
      await Bun.write(join(globalProfilesDir, "slow.json"), JSON.stringify({ tier: "slow" }));
      await Bun.write(join(projectProfilesDir, "custom.json"), JSON.stringify({ tier: "custom" }));

      const profiles = await listProfiles(projectDir);
      const names = profiles.map((p) => p.name);

      expect(names).toContain("fast");
      expect(names).toContain("slow");
      expect(names).toContain("custom");

      const fastEntry = profiles.find((p) => p.name === "fast");
      expect(fastEntry?.path).toBe(join(globalProfilesDir, "fast.json"));

      const customEntry = profiles.find((p) => p.name === "custom");
      expect(customEntry?.path).toBe(join(projectProfilesDir, "custom.json"));
    });

    test("returns empty array when no profiles exist in either location", async () => {
      const profiles = await listProfiles(projectDir);
      expect(profiles).toEqual([]);
    });

    test("includes both scope and name on each returned entry", async () => {
      const globalProfilesDir = join(globalDir, "profiles");
      mkdirSync(globalProfilesDir, { recursive: true });
      await Bun.write(join(globalProfilesDir, "fast.json"), JSON.stringify({}));

      const profiles = await listProfiles(projectDir);

      expect(profiles.length).toBeGreaterThan(0);
      expect(typeof profiles[0].name).toBe("string");
      expect(typeof profiles[0].path).toBe("string");
    });
  });

  // SEC-08: `profileName` flows into `join(profilesDir, \`${profileName}.json\`)`
  // with no validation — join silently collapses `..`, so a name like
  // "../../../etc/foo" escapes the profiles directory. `profileName` can come
  // from CLI --profile, NAX_PROFILE, or the project-controlled .nax/config.json
  // `profile` field, so a malicious repo could cause reads of arbitrary *.json
  // files under the user's home directory.
  describe("SEC-08: profile name path traversal", () => {
    test("loadProfile rejects a traversal profile name instead of reading outside profiles dir", async () => {
      // A file that a traversal could reach: <projectDir's parent>/outside.json,
      // i.e. escaping .nax/profiles/ via "../../outside".
      await Bun.write(join(projectDir, "..", "outside.json"), JSON.stringify({ pwned: true }));

      await expect(loadProfile("../../outside", projectDir)).rejects.toThrow(/must not contain path separators/);

      await Bun.file(join(projectDir, "..", "outside.json")).delete?.();
    });

    test("loadProfile rejects '..' as a profile name", async () => {
      await expect(loadProfile("..", projectDir)).rejects.toThrow(/must not be "\."/);
    });

    test("loadProfile rejects an empty profile name", async () => {
      await expect(loadProfile("", projectDir)).rejects.toThrow(/must be non-empty/);
    });

    test("loadProfile rejects a backslash traversal profile name", async () => {
      await expect(loadProfile("..\\..\\outside", projectDir)).rejects.toThrow(/must not contain path separators/);
    });

    test("loadProfileEnv rejects a traversal profile name", async () => {
      await expect(loadProfileEnv("../../outside", projectDir)).rejects.toThrow(/must not contain path separators/);
    });

    test("a legitimate single-segment profile name is unaffected", async () => {
      const globalProfilesDir = join(globalDir, "profiles");
      mkdirSync(globalProfilesDir, { recursive: true });
      await Bun.write(join(globalProfilesDir, "fast.json"), JSON.stringify({ tier: "fast" }));

      const result = await loadProfile("fast", projectDir);
      expect(result.tier).toBe("fast");
    });
  });
});
