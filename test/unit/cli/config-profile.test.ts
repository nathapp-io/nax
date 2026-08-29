/**
 * Unit tests for profile CLI commands (US-003).
 *
 * Covers: profileListCommand, profileShowCommand, profileUseCommand,
 * profileCurrentCommand, profileCreateCommand.
 *
 * All tests are RED until src/cli/config-profile.ts is implemented.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import {
  profileCreateCommand,
  profileCurrentCommand,
  profileListCommand,
  profileShowCommand,
  profileUseCommand,
} from "@/cli/config-profile";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _writeJson(path: string, data: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  Bun.write(path, JSON.stringify(data, null, 2));
}

async function writeJsonAsync(path: string, data: unknown): Promise<void> {
  mkdirSync(join(path, ".."), { recursive: true });
  await Bun.write(path, JSON.stringify(data, null, 2));
}

// ─── profileListCommand ────────────────────────────────────────────────────────

describe("profileListCommand", () => {
  let tempDir: string;
  let origGlobalDir: string | undefined;
  let origNaxProfile: string | undefined;

  beforeEach(() => {
    tempDir = makeTempDir("nax-profile-list-");
    origGlobalDir = process.env.NAX_GLOBAL_CONFIG_DIR;
    origNaxProfile = process.env.NAX_PROFILE;
    process.env.NAX_GLOBAL_CONFIG_DIR = join(tempDir, "global");
    delete process.env.NAX_PROFILE;
    mkdirSync(join(tempDir, "global", "profiles"), { recursive: true });
    mkdirSync(join(tempDir, ".nax", "profiles"), { recursive: true });
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
    if (origGlobalDir === undefined) {
      delete process.env.NAX_GLOBAL_CONFIG_DIR;
    } else {
      process.env.NAX_GLOBAL_CONFIG_DIR = origGlobalDir;
    }
    if (origNaxProfile === undefined) {
      delete process.env.NAX_PROFILE;
    } else {
      process.env.NAX_PROFILE = origNaxProfile;
    }
  });

  test("outputs profiles grouped by global/project scope labels, listing all profiles from both scopes", async () => {
    await Bun.write(join(tempDir, "global", "profiles", "fast.json"), "{}");
    await Bun.write(join(tempDir, "global", "profiles", "thorough.json"), "{}");
    await Bun.write(join(tempDir, ".nax", "profiles", "slow.json"), "{}");

    const output = await profileListCommand(tempDir);

    expect(output).toContain("global");
    expect(output).toContain("project");
    expect(output).toContain("fast");
    expect(output).toContain("thorough");
    expect(output).toContain("slow");
  });

  test("marks the active profile with '*'", async () => {
    await Bun.write(join(tempDir, ".nax", "profiles", "fast.json"), "{}");
    await writeJsonAsync(join(tempDir, ".nax", "config.json"), { profile: "fast" });

    const output = await profileListCommand(tempDir);

    // Active profile should have "*" adjacent to its name
    expect(output).toMatch(/\*[^*]*fast|fast[^*]*\*/);
  });

  test("shows only 'global' section when no project profiles exist", async () => {
    await Bun.write(join(tempDir, "global", "profiles", "fast.json"), "{}");

    const output = await profileListCommand(tempDir);

    expect(output).toContain("global");
    expect(output).toContain("fast");
  });
});

// ─── profileShowCommand — masking ─────────────────────────────────────────────

describe("profileShowCommand", () => {
  let tempDir: string;
  let origGlobalDir: string | undefined;

  beforeEach(() => {
    tempDir = makeTempDir("nax-profile-show-");
    origGlobalDir = process.env.NAX_GLOBAL_CONFIG_DIR;
    process.env.NAX_GLOBAL_CONFIG_DIR = join(tempDir, "global");
    mkdirSync(join(tempDir, "global", "profiles"), { recursive: true });
    mkdirSync(join(tempDir, ".nax", "profiles"), { recursive: true });
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
    if (origGlobalDir === undefined) {
      delete process.env.NAX_GLOBAL_CONFIG_DIR;
    } else {
      process.env.NAX_GLOBAL_CONFIG_DIR = origGlobalDir;
    }
  });

  test("masks values from $VAR substitution as '***' when unmask=false", async () => {
    // Use companion .env file for hermetic env var injection
    await Bun.write(join(tempDir, ".nax", "profiles", "fast.env"), "FAST_MODEL_VAR=gpt-4\n");
    await writeJsonAsync(join(tempDir, ".nax", "profiles", "fast.json"), {
      model: "$FAST_MODEL_VAR",
      timeout: 30000,
    });

    const output = await profileShowCommand("fast", tempDir, { unmask: false });

    expect(output).toContain("***");
    expect(output).not.toContain("gpt-4");
    // Non-substituted values should be visible
    expect(output).toContain("30000");
  });

  test("masks keys matching /key|token|secret|password|credential/i regardless of source when unmask=false", async () => {
    await writeJsonAsync(join(tempDir, ".nax", "profiles", "fast.json"), {
      apiKey: "raw-api-key",
      token: "raw-token",
      secretValue: "raw-secret",
      password: "raw-password",
      credentialId: "raw-cred",
      timeout: 30000,
    });

    const output = await profileShowCommand("fast", tempDir, { unmask: false });

    expect(output).not.toContain("raw-api-key");
    expect(output).not.toContain("raw-token");
    expect(output).not.toContain("raw-secret");
    expect(output).not.toContain("raw-password");
    expect(output).not.toContain("raw-cred");
    expect(output).toContain("***");
    // Non-sensitive field value should remain visible
    expect(output).toContain("30000");
  });

  test("shows raw values when unmask=true", async () => {
    await Bun.write(join(tempDir, ".nax", "profiles", "fast.env"), "FAST_SHOW_VAR=real-value\n");
    await writeJsonAsync(join(tempDir, ".nax", "profiles", "fast.json"), {
      model: "$FAST_SHOW_VAR",
      apiKey: "my-api-key",
    });

    const output = await profileShowCommand("fast", tempDir, { unmask: true });

    expect(output).toContain("real-value");
    expect(output).toContain("my-api-key");
  });

  test("includes WARNING banner when unmask=true; no WARNING banner when unmask=false", async () => {
    await writeJsonAsync(join(tempDir, ".nax", "profiles", "fast.json"), {
      timeout: 30000,
    });

    expect(await profileShowCommand("fast", tempDir, { unmask: true })).toContain("WARNING");
    expect(await profileShowCommand("fast", tempDir, { unmask: false })).not.toContain("WARNING");
  });
});

// ─── profileUseCommand ────────────────────────────────────────────────────────

describe("profileUseCommand", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir("nax-profile-use-");
    mkdirSync(join(tempDir, ".nax"), { recursive: true });
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  test("writes 'profile' field into .nax/config.json and returns non-empty confirmation message", async () => {
    await writeJsonAsync(join(tempDir, ".nax", "profiles", "fast.json"), { model: "fast" });
    const result = await profileUseCommand("fast", tempDir);

    const config = await Bun.file(join(tempDir, ".nax", "config.json")).json();
    expect(config.profile).toBe("fast");
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  test("removes 'profile' field from .nax/config.json when using 'default' while preserving other fields", async () => {
    await writeJsonAsync(join(tempDir, ".nax", "config.json"), {
      profile: "fast",
      timeout: 5000,
      execution: { maxIterations: 3 },
    });

    await profileUseCommand("default", tempDir);

    const config = await Bun.file(join(tempDir, ".nax", "config.json")).json();
    expect(config.profile).toBeUndefined();
    expect(config.timeout).toBe(5000);
    expect(config.execution?.maxIterations).toBe(3);
  });

  test("creates config.json if it does not exist; preserves existing fields when writing profile", async () => {
    await writeJsonAsync(join(tempDir, ".nax", "profiles", "fast.json"), { model: "fast" });
    const configPath = join(tempDir, ".nax", "config.json");
    await profileUseCommand("fast", tempDir);
    expect(await Bun.file(configPath).exists()).toBe(true);
    expect((await Bun.file(configPath).json()).profile).toBe("fast");

    await writeJsonAsync(configPath, { timeout: 5000, execution: { maxIterations: 3 } });
    await profileUseCommand("fast", tempDir);
    const config = await Bun.file(configPath).json();
    expect(config.profile).toBe("fast");
    expect(config.timeout).toBe(5000);
  });

  // BUG-50: a typo'd profile name must not silently poison config.json.
  test("rejects a profile name with no matching profile file", async () => {
    await expect(profileUseCommand("does-not-exist", tempDir)).rejects.toThrow(/not found/i);
    expect(await Bun.file(join(tempDir, ".nax", "config.json")).exists()).toBe(false);
  });
});

// ─── profileCurrentCommand ────────────────────────────────────────────────────

describe("profileCurrentCommand", () => {
  let tempDir: string;
  let origGlobalDir: string | undefined;
  let origNaxProfile: string | undefined;

  beforeEach(() => {
    tempDir = makeTempDir("nax-profile-current-");
    origGlobalDir = process.env.NAX_GLOBAL_CONFIG_DIR;
    origNaxProfile = process.env.NAX_PROFILE;
    process.env.NAX_GLOBAL_CONFIG_DIR = join(tempDir, "global");
    delete process.env.NAX_PROFILE;
    mkdirSync(join(tempDir, "global"), { recursive: true });
    mkdirSync(join(tempDir, ".nax"), { recursive: true });
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
    if (origGlobalDir === undefined) {
      delete process.env.NAX_GLOBAL_CONFIG_DIR;
    } else {
      process.env.NAX_GLOBAL_CONFIG_DIR = origGlobalDir;
    }
    if (origNaxProfile === undefined) {
      delete process.env.NAX_PROFILE;
    } else {
      process.env.NAX_PROFILE = origNaxProfile;
    }
  });

  test("returns 'default' when no profile is set or config has no profile field", async () => {
    expect(await profileCurrentCommand(tempDir)).toBe("default");

    await writeJsonAsync(join(tempDir, ".nax", "config.json"), { timeout: 5000 });
    expect(await profileCurrentCommand(tempDir)).toBe("default");
  });

  test("returns profile name from config.json when set", async () => {
    await writeJsonAsync(join(tempDir, ".nax", "config.json"), { profile: "fast" });
    expect(await profileCurrentCommand(tempDir)).toBe("fast");
  });

  test("returns NAX_PROFILE env var value over config.json", async () => {
    await writeJsonAsync(join(tempDir, ".nax", "config.json"), { profile: "slow" });
    process.env.NAX_PROFILE = "fast";
    expect(await profileCurrentCommand(tempDir)).toBe("fast");
  });
});

// ─── profileCreateCommand ─────────────────────────────────────────────────────

describe("profileCreateCommand", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir("nax-profile-create-");
    mkdirSync(join(tempDir, ".nax"), { recursive: true });
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  test("creates .nax/profiles/{name}.json containing {}; returns file path; creates profiles dir if absent", async () => {
    const profilePath = join(tempDir, ".nax", "profiles", "myprofile.json");
    const result = await profileCreateCommand("myprofile", tempDir);
    expect(await Bun.file(profilePath).exists()).toBe(true);
    expect(await Bun.file(profilePath).json()).toEqual({});
    expect(result).toBe(profilePath);

    // profiles dir does not exist yet for newprofile
    await profileCreateCommand("newprofile", tempDir);
    expect(await Bun.file(join(tempDir, ".nax", "profiles", "newprofile.json")).exists()).toBe(true);
  });

  test("throws an Error when profile already exists", async () => {
    mkdirSync(join(tempDir, ".nax", "profiles"), { recursive: true });
    await Bun.write(join(tempDir, ".nax", "profiles", "myprofile.json"), "{}");

    await expect(profileCreateCommand("myprofile", tempDir)).rejects.toThrow();

    let thrownError: unknown;
    try {
      await profileCreateCommand("myprofile", tempDir);
    } catch (err) {
      thrownError = err;
    }
    expect(thrownError).toBeInstanceOf(Error);
  });

  // SEC-18: the read side (loadProfile/loadProfileEnv) validates the profile
  // name before joining it into a path; the create side previously didn't,
  // so `nax config profile create "../../evil"` could write outside
  // profilesDir. Assert both the traversal is rejected AND nothing is
  // written outside .nax/profiles/ for it.
  test("rejects a path-traversal profile name and writes nothing outside .nax/profiles/", async () => {
    await expect(profileCreateCommand("../../evil", tempDir)).rejects.toThrow();
    expect(await Bun.file(join(tempDir, "..", "evil.json")).exists()).toBe(false);
    expect(await Bun.file(join(tempDir, "evil.json")).exists()).toBe(false);
  });

  test("rejects an empty profile name", async () => {
    await expect(profileCreateCommand("", tempDir)).rejects.toThrow();
  });

  test("rejects a profile name containing a path separator", async () => {
    await expect(profileCreateCommand("sub/dir", tempDir)).rejects.toThrow();
  });
});
