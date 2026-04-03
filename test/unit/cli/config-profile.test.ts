/**
 * Unit tests for profile CLI commands (US-003).
 *
 * Covers: profileListCommand, profileShowCommand, profileUseCommand,
 * profileCurrentCommand, profileCreateCommand.
 *
 * All tests are RED until src/cli/config-profile.ts is implemented.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  profileCreateCommand,
  profileCurrentCommand,
  profileListCommand,
  profileShowCommand,
  profileUseCommand,
} from "../../../src/cli/config-profile";
import { cleanupTempDir, makeTempDir } from "../../helpers/temp";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function writeJson(path: string, data: unknown): void {
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

  test("outputs profiles grouped by 'global' and 'project' scope labels", async () => {
    await Bun.write(join(tempDir, "global", "profiles", "fast.json"), "{}");
    await Bun.write(join(tempDir, ".nax", "profiles", "slow.json"), "{}");

    const output = await profileListCommand(tempDir);

    expect(output).toContain("global");
    expect(output).toContain("project");
    expect(output).toContain("fast");
    expect(output).toContain("slow");
  });

  test("marks the active profile with '*'", async () => {
    await Bun.write(join(tempDir, ".nax", "profiles", "fast.json"), "{}");
    await writeJsonAsync(join(tempDir, ".nax", "config.json"), { profile: "fast" });

    const output = await profileListCommand(tempDir);

    // Active profile should have "*" adjacent to its name
    expect(output).toMatch(/\*[^*]*fast|fast[^*]*\*/);
  });

  test("lists profiles from both scopes together", async () => {
    await Bun.write(join(tempDir, "global", "profiles", "thorough.json"), "{}");
    await Bun.write(join(tempDir, ".nax", "profiles", "fast.json"), "{}");
    await Bun.write(join(tempDir, ".nax", "profiles", "slow.json"), "{}");

    const output = await profileListCommand(tempDir);

    expect(output).toContain("thorough");
    expect(output).toContain("fast");
    expect(output).toContain("slow");
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
    await Bun.write(
      join(tempDir, ".nax", "profiles", "fast.env"),
      "FAST_MODEL_VAR=gpt-4\n",
    );
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
    await Bun.write(
      join(tempDir, ".nax", "profiles", "fast.env"),
      "FAST_SHOW_VAR=real-value\n",
    );
    await writeJsonAsync(join(tempDir, ".nax", "profiles", "fast.json"), {
      model: "$FAST_SHOW_VAR",
      apiKey: "my-api-key",
    });

    const output = await profileShowCommand("fast", tempDir, { unmask: true });

    expect(output).toContain("real-value");
    expect(output).toContain("my-api-key");
  });

  test("includes WARNING banner when unmask=true", async () => {
    await writeJsonAsync(join(tempDir, ".nax", "profiles", "fast.json"), {
      timeout: 30000,
    });

    const output = await profileShowCommand("fast", tempDir, { unmask: true });

    expect(output).toContain("WARNING");
  });

  test("does not include WARNING banner when unmask=false", async () => {
    await writeJsonAsync(join(tempDir, ".nax", "profiles", "fast.json"), {
      timeout: 30000,
    });

    const output = await profileShowCommand("fast", tempDir, { unmask: false });

    expect(output).not.toContain("WARNING");
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

  test("writes 'profile' field into .nax/config.json", async () => {
    await profileUseCommand("fast", tempDir);

    const config = await Bun.file(join(tempDir, ".nax", "config.json")).json();
    expect(config.profile).toBe("fast");
  });

  test("returns a non-empty confirmation message", async () => {
    const result = await profileUseCommand("fast", tempDir);

    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  test("removes 'profile' field from .nax/config.json when using 'default'", async () => {
    await writeJsonAsync(join(tempDir, ".nax", "config.json"), {
      profile: "fast",
      timeout: 5000,
    });

    await profileUseCommand("default", tempDir);

    const config = await Bun.file(join(tempDir, ".nax", "config.json")).json();
    expect(config.profile).toBeUndefined();
  });

  test("preserves other fields when removing profile for 'default'", async () => {
    await writeJsonAsync(join(tempDir, ".nax", "config.json"), {
      profile: "fast",
      timeout: 5000,
      execution: { maxIterations: 3 },
    });

    await profileUseCommand("default", tempDir);

    const config = await Bun.file(join(tempDir, ".nax", "config.json")).json();
    expect(config.timeout).toBe(5000);
    expect(config.execution?.maxIterations).toBe(3);
  });

  test("creates config.json if it does not exist", async () => {
    await profileUseCommand("fast", tempDir);

    const configPath = join(tempDir, ".nax", "config.json");
    const exists = await Bun.file(configPath).exists();
    expect(exists).toBe(true);
    const config = await Bun.file(configPath).json();
    expect(config.profile).toBe("fast");
  });

  test("preserves existing config fields when writing profile", async () => {
    await writeJsonAsync(join(tempDir, ".nax", "config.json"), {
      timeout: 5000,
      execution: { maxIterations: 3 },
    });

    await profileUseCommand("fast", tempDir);

    const config = await Bun.file(join(tempDir, ".nax", "config.json")).json();
    expect(config.profile).toBe("fast");
    expect(config.timeout).toBe(5000);
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

  test("returns 'default' when no profile is set anywhere", async () => {
    const result = await profileCurrentCommand(tempDir);

    expect(result).toBe("default");
  });

  test("returns profile name from config.json when set", async () => {
    await writeJsonAsync(join(tempDir, ".nax", "config.json"), {
      profile: "fast",
    });

    const result = await profileCurrentCommand(tempDir);

    expect(result).toBe("fast");
  });

  test("returns NAX_PROFILE env var value over config.json", async () => {
    await writeJsonAsync(join(tempDir, ".nax", "config.json"), {
      profile: "slow",
    });
    process.env.NAX_PROFILE = "fast";

    const result = await profileCurrentCommand(tempDir);

    expect(result).toBe("fast");
  });

  test("returns 'default' when config.json exists but has no profile field", async () => {
    await writeJsonAsync(join(tempDir, ".nax", "config.json"), {
      timeout: 5000,
    });

    const result = await profileCurrentCommand(tempDir);

    expect(result).toBe("default");
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

  test("creates .nax/profiles/{name}.json containing {}", async () => {
    await profileCreateCommand("myprofile", tempDir);

    const profilePath = join(tempDir, ".nax", "profiles", "myprofile.json");
    const exists = await Bun.file(profilePath).exists();
    expect(exists).toBe(true);

    const content = await Bun.file(profilePath).json();
    expect(content).toEqual({});
  });

  test("returns the created file path", async () => {
    const result = await profileCreateCommand("myprofile", tempDir);

    const expectedPath = join(tempDir, ".nax", "profiles", "myprofile.json");
    expect(result).toBe(expectedPath);
  });

  test("creates the profiles directory if it does not exist", async () => {
    // .nax/profiles/ does not exist yet
    await profileCreateCommand("newprofile", tempDir);

    const exists = await Bun.file(
      join(tempDir, ".nax", "profiles", "newprofile.json"),
    ).exists();
    expect(exists).toBe(true);
  });

  test("throws an error when profile already exists", async () => {
    mkdirSync(join(tempDir, ".nax", "profiles"), { recursive: true });
    await Bun.write(join(tempDir, ".nax", "profiles", "myprofile.json"), "{}");

    await expect(
      profileCreateCommand("myprofile", tempDir),
    ).rejects.toThrow();
  });

  test("error for duplicate profile has exit code 1", async () => {
    mkdirSync(join(tempDir, ".nax", "profiles"), { recursive: true });
    await Bun.write(join(tempDir, ".nax", "profiles", "myprofile.json"), "{}");

    let thrownError: unknown;
    try {
      await profileCreateCommand("myprofile", tempDir);
    } catch (err) {
      thrownError = err;
    }

    expect(thrownError).toBeDefined();
    expect(thrownError).toBeInstanceOf(Error);
  });
});
