/**
 * Profile Activation in Config Loader — Integration Tests (US-002)
 *
 * Tests that loadConfig() correctly wires profile resolution into the
 * config merge chain: defaults < global < project < profile < CLI.
 *
 * All tests are RED until the implementer wires resolveProfileName() and
 * loadProfile() into src/config/loader.ts.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../../../src/config/loader";
import { cleanupTempDir, makeTempDir } from "../../helpers/temp";

/**
 * Write a JSON file, creating parent directories as needed.
 */
function writeJson(path: string, data: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2));
}

describe("loadConfig — profile activation (US-002)", () => {
  let globalDir: string;
  let projectDir: string;
  let origGlobalConfigDir: string | undefined;
  let origNaxProfile: string | undefined;

  beforeEach(() => {
    globalDir = makeTempDir("nax-test-global-");
    projectDir = makeTempDir("nax-test-project-");

    // Create .nax directories
    mkdirSync(join(globalDir), { recursive: true });
    mkdirSync(join(projectDir, ".nax"), { recursive: true });

    // Redirect globalConfigDir() to our temp global dir
    origGlobalConfigDir = process.env.NAX_GLOBAL_CONFIG_DIR;
    process.env.NAX_GLOBAL_CONFIG_DIR = globalDir;

    // Save and clear NAX_PROFILE
    origNaxProfile = process.env.NAX_PROFILE;
    delete process.env.NAX_PROFILE;
  });

  afterEach(() => {
    cleanupTempDir(globalDir);
    cleanupTempDir(projectDir);

    // Restore env vars
    if (origGlobalConfigDir === undefined) {
      delete process.env.NAX_GLOBAL_CONFIG_DIR;
    } else {
      process.env.NAX_GLOBAL_CONFIG_DIR = origGlobalConfigDir;
    }

    if (origNaxProfile === undefined) {
      delete process.env.NAX_PROFILE;
    } else {
      process.env.NAX_PROFILE = origNaxProfile;
    }
  });

  // AC 1: loadConfig(dir, { profile: "fast" }) merges fast profile after global and project
  test("CLI profile override takes precedence over global and project config", async () => {
    // Create a fast profile in global scope with a distinctive timeout value
    writeJson(join(globalDir, "profiles", "fast.json"), {
      execution: { sessionTimeoutSeconds: 111 },
    });

    // Create global config that sets a different timeout (profile should override)
    writeJson(join(globalDir, "config.json"), {
      execution: { sessionTimeoutSeconds: 222 },
    });

    const config = await loadConfig(projectDir, { profile: "fast" });

    // Profile (111) must override global config (222)
    expect(config.execution.sessionTimeoutSeconds).toBe(111);
    // Profile was applied (not just defaults)
    expect(config.profile).toBe("fast");
  });

  // AC 2: NAX_PROFILE=fast applies fast profile when no CLI override
  test("NAX_PROFILE env var applies the named profile when no CLI profile override is present", async () => {
    writeJson(join(globalDir, "profiles", "fast.json"), {
      execution: { sessionTimeoutSeconds: 333 },
    });

    process.env.NAX_PROFILE = "fast";

    const config = await loadConfig(projectDir);

    expect(config.profile).toBe("fast");
    // Profile data was merged (value before any global override)
    expect(config.execution.sessionTimeoutSeconds).toBe(333);
  });

  // AC 3: "profile": "fast" in project config.json applies fast profile
  test('project config.json "profile" field applies fast profile when neither CLI nor env override is set', async () => {
    writeJson(join(globalDir, "profiles", "fast.json"), {
      execution: { sessionTimeoutSeconds: 444 },
    });

    writeJson(join(projectDir, ".nax", "config.json"), {
      profile: "fast",
    });

    const config = await loadConfig(projectDir);

    expect(config.profile).toBe("fast");
    expect(config.execution.sessionTimeoutSeconds).toBe(444);
  });

  // AC 4: CLI profile takes priority over NAX_PROFILE env var
  test("CLI profile override takes priority over NAX_PROFILE env var", async () => {
    writeJson(join(globalDir, "profiles", "fast.json"), {
      execution: { sessionTimeoutSeconds: 555 },
    });
    writeJson(join(globalDir, "profiles", "thorough.json"), {
      execution: { sessionTimeoutSeconds: 666 },
    });

    process.env.NAX_PROFILE = "thorough";

    const config = await loadConfig(projectDir, { profile: "fast" });

    // CLI wins over env var
    expect(config.profile).toBe("fast");
    expect(config.execution.sessionTimeoutSeconds).toBe(555);
  });

  // AC 5: no profile set anywhere returns backward-compatible config with profile="default"
  test('no profile set anywhere returns config with profile="default" (backward compatible)', async () => {
    writeJson(join(projectDir, ".nax", "config.json"), {
      execution: { sessionTimeoutSeconds: 777 },
    });

    const config = await loadConfig(projectDir);

    expect(config.profile).toBe("default");
    // Other config values still loaded normally
    expect(config.execution.sessionTimeoutSeconds).toBe(777);
  });

  // AC 6: NAX_PROFILE wins over project config.json profile; force-set ensures config.profile reflects resolved name
  test("force-set after all merges: config.profile reflects resolved name even when project config.json has different profile", async () => {
    writeJson(join(globalDir, "profiles", "fast.json"), {
      execution: { sessionTimeoutSeconds: 888 },
    });
    writeJson(join(globalDir, "profiles", "slow.json"), {
      execution: { sessionTimeoutSeconds: 999 },
    });

    // Project config tries to set profile to "slow"
    writeJson(join(projectDir, ".nax", "config.json"), {
      profile: "slow",
    });

    process.env.NAX_PROFILE = "fast";

    const config = await loadConfig(projectDir);

    // NAX_PROFILE wins; force-set ensures profile field reflects the resolved name
    expect(config.profile).toBe("fast");
    // fast profile data was merged, not slow
    expect(config.execution.sessionTimeoutSeconds).toBe(888);
  });

  // AC 7: global config.json "profile" field activates profile as lowest-priority fallback,
  // but the "profile" key itself is stripped from config layer merge so it doesn't double-apply.
  test('"profile" field from global config.json activates profile; profile overrides global non-profile settings', async () => {
    // Global config has a "profile" field — activates profile when no CLI/NAX_PROFILE/project profile set
    writeJson(join(globalDir, "config.json"), {
      profile: "thorough",
      execution: { sessionTimeoutSeconds: 101 },
    });

    // Thorough profile exists and SHOULD be activated via global config.json fallback
    writeJson(join(globalDir, "profiles", "thorough.json"), {
      execution: { sessionTimeoutSeconds: 202 },
    });

    const config = await loadConfig(projectDir);

    // Global config.json profile field is used as fallback — profile is activated
    expect(config.profile).toBe("thorough");
    // Profile data (202) is merged after global config.json (101) — profile wins
    expect(config.execution.sessionTimeoutSeconds).toBe(202);
  });

  // AC 8: "profile" field from project config.json is stripped before merging
  test('"profile" field from project config.json is stripped before merging into config object', async () => {
    writeJson(join(globalDir, "profiles", "fast.json"), {
      execution: { sessionTimeoutSeconds: 303 },
    });

    // Project config has a "profile" field
    writeJson(join(projectDir, ".nax", "config.json"), {
      profile: "fast",
      execution: { sessionTimeoutSeconds: 404 },
    });

    const config = await loadConfig(projectDir);

    // Profile is resolved to "fast" from config.json, data merged correctly
    expect(config.profile).toBe("fast");
    // The profile value (303) overrides the project config.json execution value (404)
    expect(config.execution.sessionTimeoutSeconds).toBe(303);
    // The "profile" key from project config.json is stripped (not double-applied via merge)
    // If not stripped, Zod would see "profile": "fast" twice and could behave unexpectedly
    // The reliable check: config.profile === "fast" (from force-set, not from leaked merge)
  });

  // AC 9: companion .env file values do not modify process.env after loadConfig() returns
  test("companion .env file values do not persist in process.env after loadConfig returns", async () => {
    const envKey = "NAX_TEST_PROFILE_SECRET_" + Date.now();

    // Create a fast profile with a companion .env file
    writeJson(join(globalDir, "profiles", "fast.json"), {});
    writeFileSync(
      join(globalDir, "profiles", "fast.env"),
      `${envKey}=should-not-leak\n`,
    );

    process.env.NAX_PROFILE = "fast";

    // Ensure the key is not set before the call
    expect(process.env[envKey]).toBeUndefined();

    await loadConfig(projectDir);

    // After loadConfig, the env var must NOT be set in process.env
    expect(process.env[envKey]).toBeUndefined();

    // Cleanup just in case
    delete process.env[envKey];
  });

  // AC 10: profile="default" applies no overlay — result matches defaults + global + project only
  test('loadConfig with profile="default" applies no profile overlay', async () => {
    // Create a "default" named profile file (it must NOT be loaded)
    writeJson(join(globalDir, "profiles", "default.json"), {
      execution: { sessionTimeoutSeconds: 505 },
    });

    writeJson(join(projectDir, ".nax", "config.json"), {
      execution: { sessionTimeoutSeconds: 606 },
    });

    const config = await loadConfig(projectDir, { profile: "default" });

    expect(config.profile).toBe("default");
    // The "default.json" profile file must NOT be loaded — project config value (606) wins
    expect(config.execution.sessionTimeoutSeconds).toBe(606);
  });

  // Additional: profile data is merged after global and project (merge order check)
  test("profile data is merged after global and project config in merge order", async () => {
    // Profile sets a value
    writeJson(join(globalDir, "profiles", "fast.json"), {
      execution: { sessionTimeoutSeconds: 707 },
    });

    // Global config also sets the same value — profile should win
    writeJson(join(globalDir, "config.json"), {
      execution: { sessionTimeoutSeconds: 808 },
    });

    const config = await loadConfig(projectDir, { profile: "fast" });

    // Profile (707) overrides global (808)
    expect(config.execution.sessionTimeoutSeconds).toBe(707);
    expect(config.profile).toBe("fast");
  });

  // Additional: loadConfigForWorkdir does not perform a second profile-resolution pass
  test("loadConfigForWorkdir does not double-apply profile resolution", async () => {
    writeJson(join(globalDir, "profiles", "fast.json"), {
      execution: { sessionTimeoutSeconds: 909 },
    });

    writeJson(join(projectDir, ".nax", "config.json"), {
      profile: "fast",
    });

    // Import loadConfigForWorkdir dynamically to avoid circular deps in test setup
    const { loadConfigForWorkdir } = await import("../../../src/config/loader");

    const rootConfigPath = join(projectDir, ".nax", "config.json");
    const config = await loadConfigForWorkdir(rootConfigPath);

    // Profile resolved once — config.profile must equal "fast", not "default"
    expect(config.profile).toBe("fast");
    expect(config.execution.sessionTimeoutSeconds).toBe(909);
  });

  // Additional: new profile functions are exported from src/config/index.ts barrel
  test("resolveProfileName, loadProfile, loadProfileEnv, listProfiles are exported from src/config/index.ts", async () => {
    const barrel = await import("../../../src/config/index");

    expect(typeof barrel.resolveProfileName).toBe("function");
    expect(typeof barrel.loadProfile).toBe("function");
    expect(typeof barrel.loadProfileEnv).toBe("function");
    expect(typeof barrel.listProfiles).toBe("function");
  });
});
