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
  listProfiles,
  loadProfile,
  loadProfileEnv,
  resolveProfileName,
} from "../../../src/config/profile";
import { cleanupTempDir, makeTempDir } from "../../helpers/temp";

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
      await Bun.write(
        join(projectProfilesDir, "fast.json"),
        JSON.stringify({ tier: "fast", timeout: 60 }),
      );

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

      await Bun.write(
        join(globalProfilesDir, "fast.json"),
        JSON.stringify({ tier: "fast", timeout: 30 }),
      );

      const result = await loadProfile("fast", projectDir);

      expect((result as Record<string, unknown>).tier).toBe("fast");
      expect((result as Record<string, unknown>).timeout).toBe(30);
    });

    test("throws an error whose message contains the profile name when neither global nor project profile exists", async () => {
      await expect(loadProfile("nonexistent", projectDir)).rejects.toThrow("nonexistent");
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

      await Bun.write(
        join(globalProfilesDir, "fast.env"),
        "GLOBAL_ONLY=global_value\nSHARED_KEY=from_global\n",
      );
      await Bun.write(
        join(projectProfilesDir, "fast.env"),
        "PROJECT_ONLY=project_value\nSHARED_KEY=from_project\n",
      );

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

    test("returns empty map when no .env files exist for the profile", async () => {
      const globalProfilesDir = join(globalDir, "profiles");
      mkdirSync(globalProfilesDir, { recursive: true });
      await Bun.write(join(globalProfilesDir, "fast.json"), JSON.stringify({ tier: "fast" }));

      const result = await loadProfileEnv("fast", projectDir);

      expect(typeof result).toBe("object");
      expect(Object.keys(result).length).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // resolveProfileName
  // ---------------------------------------------------------------------------

  describe("resolveProfileName", () => {
    test('returns CLI profile when provided — CLI takes priority over NAX_PROFILE env var', async () => {
      const result = await resolveProfileName(
        { profile: "cli" },
        { NAX_PROFILE: "env" },
        projectDir,
      );
      expect(result).toBe("cli");
    });

    test('returns NAX_PROFILE env var when no CLI override is given', async () => {
      const result = await resolveProfileName({}, { NAX_PROFILE: "env" }, projectDir);
      expect(result).toBe("env");
    });

    test('returns profile from project config.json when no CLI or env override', async () => {
      const projectNaxDir = join(projectDir, ".nax");
      mkdirSync(projectNaxDir, { recursive: true });
      await Bun.write(
        join(projectNaxDir, "config.json"),
        JSON.stringify({ profile: "persisted" }),
      );

      const result = await resolveProfileName({}, {}, projectDir);
      expect(result).toBe("persisted");
    });

    test('returns "default" when no profile is set anywhere', async () => {
      const result = await resolveProfileName({}, {}, projectDir);
      expect(result).toBe("default");
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
});
