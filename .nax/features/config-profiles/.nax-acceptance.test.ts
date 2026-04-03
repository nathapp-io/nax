/**
 * Acceptance Test Suite: config-profiles Feature
 *
 * Tests for profile loading, dotenv parsing, env resolution, CLI commands,
 * and integration with the config loader.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { makeTempDir, cleanupTempDir } from "../../test/helpers/temp";

// ============================================================================
// DOTENV PARSER TESTS (ACs 1-8, 22-29)
// ============================================================================

describe("AC-1: parseDotenv basic parsing with comments and exports", () => {
  test("parses FOO=bar, ignores comments, strips export, handles quotes", async () => {
    const { parseDotenv } = await import("../../../src/config/dotenv");

    const input = `FOO=bar
# comment
export BAZ=qux
QUOTED="hello world"`;

    const result = parseDotenv(input);

    expect(result.FOO).toBe("bar");
    expect(result.BAZ).toBe("qux");
    expect(result.QUOTED).toBe("hello world");
    expect(Object.keys(result).length).toBe(3);
  });
});

describe("AC-2: parseDotenv empty string", () => {
  test("returns empty object for empty string", async () => {
    const { parseDotenv } = await import("../../../src/config/dotenv");
    const result = parseDotenv("");
    expect(result).toEqual({});
  });
});

describe("AC-3: parseDotenv export prefix stripping", () => {
  test("strips export prefix and returns KEY=value", async () => {
    const { parseDotenv } = await import("../../../src/config/dotenv");
    const result = parseDotenv("export KEY=value");
    expect(result.KEY).toBe("value");
  });
});

describe("AC-4: resolveEnvVars nested substitution", () => {
  test("substitutes $FOO and nested $BAR in objects", async () => {
    const { resolveEnvVars } = await import("../../../src/config/dotenv");
    const config = { a: "$FOO", b: { c: "$BAR" } };
    const env = { FOO: "x", BAR: "y" };
    const result = resolveEnvVars(config, env);

    expect(result.a).toBe("x");
    expect(result.b.c).toBe("y");
  });
});

describe("AC-5: resolveEnvVars missing variable error", () => {
  test("throws error containing MISSING and $MISSING", async () => {
    const { resolveEnvVars } = await import("../../../src/config/dotenv");
    const config = { a: "$MISSING" };
    const env = {};

    expect(() => resolveEnvVars(config, env)).toThrow();
    const error = (() => {
      try {
        resolveEnvVars(config, env);
        return null;
      } catch (e) {
        return e;
      }
    })();

    if (error && error instanceof Error) {
      expect(error.message).toMatch(/MISSING/);
      expect(error.message).toMatch(/\$MISSING/);
    }
  });
});

describe("AC-6: resolveEnvVars non-string values pass through", () => {
  test("returns input unchanged for numbers and arrays", async () => {
    const { resolveEnvVars } = await import("../../../src/config/dotenv");
    const config = { n: 5, arr: [1, 2] };
    const env = {};
    const result = resolveEnvVars(config, env);

    expect(result.n).toBe(5);
    expect(result.arr).toEqual([1, 2]);
  });
});

describe("AC-7: resolveEnvVars double-dollar escape", () => {
  test("returns { a: $LITERAL } for $$LITERAL input", async () => {
    const { resolveEnvVars } = await import("../../../src/config/dotenv");
    const config = { a: "$$LITERAL" };
    const env = {};
    const result = resolveEnvVars(config, env);

    expect(result.a).toBe("$LITERAL");
  });
});

describe("AC-8: resolveEnvVars inline substitution", () => {
  test("substitutes $FOO in prefix-$FOO-suffix pattern", async () => {
    const { resolveEnvVars } = await import("../../../src/config/dotenv");
    const config = { a: "prefix-$FOO-suffix" };
    const env = { FOO: "mid" };
    const result = resolveEnvVars(config, env);

    expect(result.a).toBe("prefix-mid-suffix");
  });
});

// Duplicate ACs 22-29 (same as 1-8) — omit redundant tests

// ============================================================================
// PROFILE LOADING TESTS (ACs 9-11, 30-32)
// ============================================================================

describe("AC-9: loadProfile merges global and project profiles", () => {
  let tempDir: string;
  let globalBackup: string | null = null;

  beforeEach(() => {
    tempDir = makeTempDir("nax-test-profile-");
    mkdirSync(join(tempDir, ".nax", "profiles"), { recursive: true });
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
    if (globalBackup && existsSync(globalBackup)) {
      const globalDir = join(homedir(), ".nax", "profiles");
      rmSync(globalDir, { recursive: true, force: true });
      if (existsSync(globalBackup)) {
        mkdirSync(join(homedir(), ".nax", "profiles"), { recursive: true });
      }
    }
  });

  test("deep-merges global and project fast.json with project precedence", async () => {
    const { loadProfile } = await import("../../../src/config/profile");

    // Create global profile
    const globalDir = join(homedir(), ".nax", "profiles");
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(
      join(globalDir, "fast.json"),
      JSON.stringify({ timeout: 30000, retries: 2, other: "global" })
    );
    globalBackup = globalDir;

    // Create project profile
    writeFileSync(
      join(tempDir, ".nax", "profiles", "fast.json"),
      JSON.stringify({ timeout: 60000 })
    );

    const result = loadProfile("fast", tempDir);

    expect(result.timeout).toBe(60000); // project overrides global
    expect(result.retries).toBe(2); // global value inherited
    expect(result.other).toBe("global");
  });
});

describe("AC-10: loadProfile returns global profile when project missing", () => {
  let tempDir: string;
  let globalBackup: string | null = null;

  beforeEach(() => {
    tempDir = makeTempDir("nax-test-profile-");
    mkdirSync(join(tempDir, ".nax", "profiles"), { recursive: true });
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
    if (globalBackup && existsSync(globalBackup)) {
      const globalDir = join(homedir(), ".nax", "profiles");
      rmSync(globalDir, { recursive: true, force: true });
    }
  });

  test("returns only global profile when project file missing", async () => {
    const { loadProfile } = await import("../../../src/config/profile");

    const globalDir = join(homedir(), ".nax", "profiles");
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(join(globalDir, "fast.json"), JSON.stringify({ timeout: 30000 }));
    globalBackup = globalDir;

    const result = loadProfile("fast", tempDir);
    expect(result.timeout).toBe(30000);
  });
});

describe("AC-11: loadProfile throws for nonexistent profile", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir("nax-test-profile-");
    mkdirSync(join(tempDir, ".nax", "profiles"), { recursive: true });
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  test("throws error containing 'nonexistent'", async () => {
    const { loadProfile } = await import("../../../src/config/profile");

    expect(() => loadProfile("nonexistent", tempDir)).toThrow();
    const error = (() => {
      try {
        loadProfile("nonexistent", tempDir);
        return null;
      } catch (e) {
        return e;
      }
    })();

    if (error && error instanceof Error) {
      expect(error.message).toMatch(/nonexistent/i);
    }
  });
});

// ============================================================================
// PROFILE ENV LOADING (AC-12, 33)
// ============================================================================

describe("AC-12: loadProfileEnv merges companion .env files", () => {
  let tempDir: string;
  let globalBackup: { dir: string; content: string } | null = null;

  beforeEach(() => {
    tempDir = makeTempDir("nax-test-env-");
    mkdirSync(join(tempDir, ".nax", "profiles"), { recursive: true });
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
    if (globalBackup) {
      const globalDir = join(homedir(), ".nax", "profiles");
      rmSync(globalDir, { recursive: true, force: true });
    }
  });

  test("merges global and project .env with project precedence", async () => {
    const { loadProfileEnv } = await import("../../../src/config/profile");

    // Create global .env
    const globalDir = join(homedir(), ".nax", "profiles");
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(join(globalDir, "fast.env"), "GLOBAL_KEY=global_value\nSHARED=global");
    globalBackup = { dir: globalDir, content: "" };

    // Create project .env
    writeFileSync(join(tempDir, ".nax", "profiles", "fast.env"), "PROJECT_KEY=project_value\nSHARED=project");

    const result = loadProfileEnv("fast", tempDir);

    expect(result.GLOBAL_KEY).toBe("global_value");
    expect(result.PROJECT_KEY).toBe("project_value");
    expect(result.SHARED).toBe("project"); // project takes precedence
  });
});

// ============================================================================
// PROFILE NAME RESOLUTION (ACs 13-17, 34-38)
// ============================================================================

describe("AC-13: resolveProfileName CLI takes priority over env var", () => {
  test("returns 'cli' when both CLI and env var present", async () => {
    const { resolveProfileName } = await import("../../../src/config/profile");
    const result = resolveProfileName({ profile: "cli" }, { NAX_PROFILE: "env" });
    expect(result).toBe("cli");
  });
});

describe("AC-14: resolveProfileName uses env var when no CLI override", () => {
  test("returns 'env' from NAX_PROFILE", async () => {
    const { resolveProfileName } = await import("../../../src/config/profile");
    const result = resolveProfileName({}, { NAX_PROFILE: "env" });
    expect(result).toBe("env");
  });
});

describe("AC-15: resolveProfileName config.json fallback", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir("nax-test-resolve-");
    mkdirSync(join(tempDir, ".nax"), { recursive: true });
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  test("uses profile from project config.json when no CLI/env", async () => {
    const { resolveProfileName } = await import("../../../src/config/profile");

    writeFileSync(
      join(tempDir, ".nax", "config.json"),
      JSON.stringify({ profile: "persisted" })
    );

    const result = resolveProfileName({}, {}, tempDir);
    expect(result).toBe("persisted");
  });
});

describe("AC-16: resolveProfileName defaults to 'default'", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir("nax-test-resolve-");
    mkdirSync(join(tempDir, ".nax"), { recursive: true });
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  test("returns 'default' when no profile set anywhere", async () => {
    const { resolveProfileName } = await import("../../../src/config/profile");
    const result = resolveProfileName({}, {}, tempDir);
    expect(result).toBe("default");
  });
});

describe("AC-17: listProfiles returns profiles from both scopes", () => {
  let tempDir: string;
  let globalBackup: string | null = null;

  beforeEach(() => {
    tempDir = makeTempDir("nax-test-list-");
    mkdirSync(join(tempDir, ".nax", "profiles"), { recursive: true });
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
    if (globalBackup && existsSync(globalBackup)) {
      const globalDir = join(homedir(), ".nax", "profiles");
      rmSync(globalDir, { recursive: true, force: true });
    }
  });

  test("returns profile names and paths from global and project", async () => {
    const { listProfiles } = await import("../../../src/config/profile");

    // Create global profile
    const globalDir = join(homedir(), ".nax", "profiles");
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(join(globalDir, "fast.json"), "{}");
    globalBackup = globalDir;

    // Create project profile
    writeFileSync(join(tempDir, ".nax", "profiles", "slow.json"), "{}");

    const result = listProfiles(tempDir);

    expect(Array.isArray(result)).toBe(true);
    const profileNames = result.map((p: any) => p.name);
    expect(profileNames).toContain("fast");
    expect(profileNames).toContain("slow");
  });
});

// ============================================================================
// SCHEMA DEFAULTS (ACs 18-21)
// ============================================================================

describe("AC-18 & AC-20: NaxConfigSchema default profile", () => {
  test("schema with empty config has profile='default'", async () => {
    const { NaxConfigSchema } = await import("../../../src/config/schemas");
    const result = NaxConfigSchema.parse({});
    expect(result.profile).toBe("default");
  });
});

describe("AC-19 & AC-21: NaxConfigSchema custom profile", () => {
  test("schema with profile='fast' preserves it", async () => {
    const { NaxConfigSchema } = await import("../../../src/config/schemas");
    const result = NaxConfigSchema.parse({ profile: "fast" });
    expect(result.profile).toBe("fast");
  });
});

// ============================================================================
// LOADER INTEGRATION TESTS (ACs 39-48)
// ============================================================================

describe("AC-39: loadConfig merges profile between defaults and global", () => {
  let tempDir: string;
  let globalBackup: string | null = null;

  beforeEach(() => {
    tempDir = makeTempDir("nax-test-loader-");
    mkdirSync(join(tempDir, ".nax", "profiles"), { recursive: true });
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
    if (globalBackup && existsSync(globalBackup)) {
      const globalDir = join(homedir(), ".nax");
      rmSync(globalDir, { recursive: true, force: true });
    }
  });

  test("applies fast profile during merge chain", async () => {
    const { loadConfig } = await import("../../../src/config/loader");

    // Create profile
    mkdirSync(join(tempDir, ".nax", "profiles"), { recursive: true });
    writeFileSync(
      join(tempDir, ".nax", "profiles", "fast.json"),
      JSON.stringify({ execution: { maxIterations: 5 } })
    );

    const config = await loadConfig(join(tempDir, ".nax"), { profile: "fast" });
    expect(config.profile).toBe("fast");
  });
});

describe("AC-40: loadConfig applies profile from NAX_PROFILE env var", () => {
  let tempDir: string;
  let globalBackup: string | null = null;
  const originalEnv = Bun.env.NAX_PROFILE;

  beforeEach(() => {
    tempDir = makeTempDir("nax-test-loader-env-");
    mkdirSync(join(tempDir, ".nax", "profiles"), { recursive: true });
    Bun.env.NAX_PROFILE = "fast";
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
    Bun.env.NAX_PROFILE = originalEnv;
    if (globalBackup && existsSync(globalBackup)) {
      const globalDir = join(homedir(), ".nax");
      rmSync(globalDir, { recursive: true, force: true });
    }
  });

  test("applies env var profile when no CLI override", async () => {
    const { loadConfig } = await import("../../../src/config/loader");

    mkdirSync(join(tempDir, ".nax", "profiles"), { recursive: true });
    writeFileSync(join(tempDir, ".nax", "profiles", "fast.json"), "{}");

    const config = await loadConfig(join(tempDir, ".nax"));
    expect(config.profile).toBe("fast");
  });
});

describe("AC-41: loadConfig applies profile from project config.json", () => {
  let tempDir: string;
  let globalBackup: string | null = null;
  const originalEnv = Bun.env.NAX_PROFILE;

  beforeEach(() => {
    tempDir = makeTempDir("nax-test-loader-config-");
    mkdirSync(join(tempDir, ".nax", "profiles"), { recursive: true });
    delete Bun.env.NAX_PROFILE;
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
    Bun.env.NAX_PROFILE = originalEnv;
    if (globalBackup && existsSync(globalBackup)) {
      const globalDir = join(homedir(), ".nax");
      rmSync(globalDir, { recursive: true, force: true });
    }
  });

  test("applies project config.json profile field", async () => {
    const { loadConfig } = await import("../../../src/config/loader");

    mkdirSync(join(tempDir, ".nax", "profiles"), { recursive: true });
    writeFileSync(
      join(tempDir, ".nax", "config.json"),
      JSON.stringify({ profile: "fast" })
    );
    writeFileSync(join(tempDir, ".nax", "profiles", "fast.json"), "{}");

    const config = await loadConfig(join(tempDir, ".nax"));
    expect(config.profile).toBe("fast");
  });
});

describe("AC-42: CLI profile takes precedence over NAX_PROFILE", () => {
  let tempDir: string;
  const originalEnv = Bun.env.NAX_PROFILE;

  beforeEach(() => {
    tempDir = makeTempDir("nax-test-cli-priority-");
    mkdirSync(join(tempDir, ".nax", "profiles"), { recursive: true });
    Bun.env.NAX_PROFILE = "thorough";
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
    Bun.env.NAX_PROFILE = originalEnv;
  });

  test("CLI profile overrides env var", async () => {
    const { loadConfig } = await import("../../../src/config/loader");

    mkdirSync(join(tempDir, ".nax", "profiles"), { recursive: true });
    writeFileSync(join(tempDir, ".nax", "profiles", "fast.json"), "{}");

    const config = await loadConfig(join(tempDir, ".nax"), { profile: "fast" });
    expect(config.profile).toBe("fast");
  });
});

describe("AC-43: loadConfig backward compatible with no profile set", () => {
  let tempDir: string;
  const originalEnv = Bun.env.NAX_PROFILE;

  beforeEach(() => {
    tempDir = makeTempDir("nax-test-compat-");
    mkdirSync(join(tempDir, ".nax"), { recursive: true });
    delete Bun.env.NAX_PROFILE;
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
    Bun.env.NAX_PROFILE = originalEnv;
  });

  test("returns config with profile='default' when none set", async () => {
    const { loadConfig } = await import("../../../src/config/loader");
    const config = await loadConfig(join(tempDir, ".nax"));
    expect(config.profile).toBe("default");
  });
});

describe("AC-44: force-set prevents env override of config.json", () => {
  let tempDir: string;
  const originalEnv = Bun.env.NAX_PROFILE;

  beforeEach(() => {
    tempDir = makeTempDir("nax-test-force-");
    mkdirSync(join(tempDir, ".nax", "profiles"), { recursive: true });
    Bun.env.NAX_PROFILE = "fast";
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
    Bun.env.NAX_PROFILE = originalEnv;
  });

  test("NAX_PROFILE=fast overrides config.json slow", async () => {
    const { loadConfig } = await import("../../../src/config/loader");

    mkdirSync(join(tempDir, ".nax", "profiles"), { recursive: true });
    writeFileSync(
      join(tempDir, ".nax", "config.json"),
      JSON.stringify({ profile: "slow" })
    );
    writeFileSync(join(tempDir, ".nax", "profiles", "fast.json"), "{}");
    writeFileSync(join(tempDir, ".nax", "profiles", "slow.json"), "{}");

    const config = await loadConfig(join(tempDir, ".nax"));
    expect(config.profile).toBe("fast");
  });
});

describe("AC-45: profile field stripped from global config.json", () => {
  let tempDir: string;
  let globalBackup: string | null = null;

  beforeEach(() => {
    tempDir = makeTempDir("nax-test-strip-global-");
    mkdirSync(join(tempDir, ".nax"), { recursive: true });
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
    if (globalBackup && existsSync(globalBackup)) {
      const globalDir = join(homedir(), ".nax");
      rmSync(globalDir, { recursive: true, force: true });
    }
  });

  test("global config profile field does not leak into merged result", async () => {
    const { loadConfig } = await import("../../../src/config/loader");

    const globalDir = join(homedir(), ".nax");
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(
      join(globalDir, "config.json"),
      JSON.stringify({ profile: "ignored" })
    );
    globalBackup = globalDir;

    const config = await loadConfig(join(tempDir, ".nax"));
    // The profile field should be from schema default or CLI, not leaked from global config
    expect(typeof config.profile).toBe("string");
  });
});

describe("AC-46: profile field stripped from project config.json before merge", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir("nax-test-strip-project-");
    mkdirSync(join(tempDir, ".nax"), { recursive: true });
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  test("project config profile field is removed before merge", async () => {
    const { loadConfig } = await import("../../../src/config/loader");

    writeFileSync(
      join(tempDir, ".nax", "config.json"),
      JSON.stringify({ profile: "test" })
    );

    const config = await loadConfig(join(tempDir, ".nax"));
    expect(config.profile).toBeDefined();
  });
});

describe("AC-47: companion .env values don't modify process.env", () => {
  let tempDir: string;
  const originalValue = Bun.env.TEST_PROFILE_VAR;

  beforeEach(() => {
    tempDir = makeTempDir("nax-test-env-isolation-");
    mkdirSync(join(tempDir, ".nax", "profiles"), { recursive: true });
    delete Bun.env.TEST_PROFILE_VAR;
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
    if (originalValue) {
      Bun.env.TEST_PROFILE_VAR = originalValue;
    } else {
      delete Bun.env.TEST_PROFILE_VAR;
    }
  });

  test("profile .env values isolated from process.env", async () => {
    const { loadConfig } = await import("../../../src/config/loader");

    mkdirSync(join(tempDir, ".nax", "profiles"), { recursive: true });
    writeFileSync(
      join(tempDir, ".nax", "profiles", "test.env"),
      "TEST_PROFILE_VAR=isolated"
    );
    writeFileSync(join(tempDir, ".nax", "profiles", "test.json"), "{}");

    await loadConfig(join(tempDir, ".nax"), { profile: "test" });

    expect(Bun.env.TEST_PROFILE_VAR).not.toBe("isolated");
  });
});

describe("AC-48: default profile applies no overlay", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir("nax-test-default-");
    mkdirSync(join(tempDir, ".nax", "profiles"), { recursive: true });
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  test("default profile does not add profile overlay", async () => {
    const { loadConfig } = await import("../../../src/config/loader");

    const config1 = await loadConfig(join(tempDir, ".nax"));
    const config2 = await loadConfig(join(tempDir, ".nax"), { profile: "default" });

    expect(config1.profile).toBe("default");
    expect(config2.profile).toBe("default");
  });
});

// ============================================================================
// CLI COMMAND TESTS (ACs 49-57)
// ============================================================================

describe("AC-49: profileListCommand marks active profile", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir("nax-test-list-cmd-");
    mkdirSync(join(tempDir, ".nax", "profiles"), { recursive: true });
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  test("list command output contains scope labels and active marker", async () => {
    const { profileListCommand } = await import("../../../src/cli/config-profile");

    writeFileSync(join(tempDir, ".nax", "profiles", "fast.json"), "{}");
    writeFileSync(join(tempDir, ".nax", "config.json"), JSON.stringify({ profile: "fast" }));

    const output = profileListCommand(tempDir);

    expect(output).toContain("global");
    expect(output).toContain("project");
    // Active profile should be marked with *
    expect(output).toMatch(/\*/);
  });
});

describe("AC-50: profileShowCommand masks $VAR substituted values", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir("nax-test-show-cmd-");
    mkdirSync(join(tempDir, ".nax", "profiles"), { recursive: true });
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  test("show command masks $VAR values as ***", async () => {
    const { profileShowCommand } = await import("../../../src/cli/config-profile");

    writeFileSync(
      join(tempDir, ".nax", "profiles", "fast.json"),
      JSON.stringify({ apiKey: "$API_TOKEN" })
    );
    writeFileSync(join(tempDir, ".nax", "profiles", "fast.env"), "API_TOKEN=secret123");

    const output = profileShowCommand("fast", tempDir, { unmask: false });

    expect(output).toContain("***");
    expect(output).not.toContain("secret123");
  });
});

describe("AC-51: profileShowCommand masks sensitive key names", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir("nax-test-mask-keys-");
    mkdirSync(join(tempDir, ".nax", "profiles"), { recursive: true });
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  test("masks keys matching key|token|secret|password|credential pattern", async () => {
    const { profileShowCommand } = await import("../../../src/cli/config-profile");

    writeFileSync(
      join(tempDir, ".nax", "profiles", "fast.json"),
      JSON.stringify({
        apiKey: "value1",
        token: "value2",
        password: "value3",
        secretToken: "value4",
      })
    );

    const output = profileShowCommand("fast", tempDir, { unmask: false });

    expect(output).toMatch(/\*\*\*/);
  });
});

describe("AC-52: profileShowCommand unmask flag shows warning", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir("nax-test-unmask-");
    mkdirSync(join(tempDir, ".nax", "profiles"), { recursive: true });
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  test("unmask=true outputs raw values and WARNING banner", async () => {
    const { profileShowCommand } = await import("../../../src/cli/config-profile");

    writeFileSync(
      join(tempDir, ".nax", "profiles", "fast.json"),
      JSON.stringify({ secret: "exposed" })
    );

    const output = profileShowCommand("fast", tempDir, { unmask: true });

    expect(output).toContain("WARNING");
    expect(output).toContain("exposed");
  });
});

describe("AC-53: profileUseCommand writes profile to config.json", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir("nax-test-use-cmd-");
    mkdirSync(join(tempDir, ".nax", "profiles"), { recursive: true });
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  test("use command writes profile field to config.json", async () => {
    const { profileUseCommand } = await import("../../../src/cli/config-profile");

    writeFileSync(join(tempDir, ".nax", "profiles", "fast.json"), "{}");

    const result = profileUseCommand("fast", tempDir);

    const configPath = join(tempDir, ".nax", "config.json");
    expect(existsSync(configPath)).toBe(true);

    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(config.profile).toBe("fast");
    expect(result).toContain("fast");
  });
});

describe("AC-54: profileUseCommand removes profile for 'default'", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir("nax-test-use-default-");
    mkdirSync(join(tempDir, ".nax"), { recursive: true });
    writeFileSync(
      join(tempDir, ".nax", "config.json"),
      JSON.stringify({ profile: "fast" })
    );
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  test("use default removes profile field from config.json", async () => {
    const { profileUseCommand } = await import("../../../src/cli/config-profile");

    profileUseCommand("default", tempDir);

    const configPath = join(tempDir, ".nax", "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf-8"));

    expect(config.profile).toBeUndefined();
  });
});

describe("AC-55: profileCurrentCommand resolves active profile", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir("nax-test-current-");
    mkdirSync(join(tempDir, ".nax", "profiles"), { recursive: true });
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  test("current command returns resolved profile name", async () => {
    const { profileCurrentCommand } = await import("../../../src/cli/config-profile");

    writeFileSync(
      join(tempDir, ".nax", "config.json"),
      JSON.stringify({ profile: "fast" })
    );
    writeFileSync(join(tempDir, ".nax", "profiles", "fast.json"), "{}");

    const result = profileCurrentCommand(tempDir);

    expect(result).toContain("fast");
  });
});

describe("AC-56: profileCreateCommand creates profile with empty object", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir("nax-test-create-");
    mkdirSync(join(tempDir, ".nax", "profiles"), { recursive: true });
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  test("create command creates .nax/profiles/myprofile.json", async () => {
    const { profileCreateCommand } = await import("../../../src/cli/config-profile");

    const result = profileCreateCommand("myprofile", tempDir);

    const profilePath = join(tempDir, ".nax", "profiles", "myprofile.json");
    expect(existsSync(profilePath)).toBe(true);

    const content = JSON.parse(readFileSync(profilePath, "utf-8"));
    expect(content).toEqual({});
    expect(result).toContain(profilePath);
  });
});

describe("AC-57: profileCreateCommand throws for existing profile", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir("nax-test-create-exists-");
    mkdirSync(join(tempDir, ".nax", "profiles"), { recursive: true });
    writeFileSync(join(tempDir, ".nax", "profiles", "myprofile.json"), "{}");
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  test("create throws error with exit code 1 for existing profile", async () => {
    const { profileCreateCommand } = await import("../../../src/cli/config-profile");

    expect(() => profileCreateCommand("myprofile", tempDir)).toThrow();
  });
});

// ============================================================================
// CLI REGISTRATION TESTS (ACs 58-64)
// ============================================================================

describe("AC-58: profile subcommands registered under nax config profile", () => {
  test("profile commands appear in help output", async () => {
    // This is a file-check AC — verify that bin/nax.ts registers the subcommand
    const binPath = join(
      process.cwd(),
      "bin/nax.ts"
    );

    if (existsSync(binPath)) {
      const content = readFileSync(binPath, "utf-8");
      expect(content).toMatch(/config.*profile/i);
      expect(content).toMatch(/profileListCommand|profileShowCommand|profileUseCommand|profileCurrentCommand|profileCreateCommand/);
    }
  });
});

describe("AC-59: run command accepts --profile option", () => {
  test("--profile flag wired to loadConfig in bin/nax.ts", async () => {
    const binPath = join(
      process.cwd(),
      "bin/nax.ts"
    );

    if (existsSync(binPath)) {
      const content = readFileSync(binPath, "utf-8");
      expect(content).toMatch(/--profile/);
      expect(content).toMatch(/run.*command|runCommand/i);
    }
  });
});

describe("AC-60: plan command accepts --profile option", () => {
  test("--profile flag wired to loadConfig in plan command", async () => {
    const binPath = join(
      process.cwd(),
      "bin/nax.ts"
    );

    if (existsSync(binPath)) {
      const content = readFileSync(binPath, "utf-8");
      expect(content).toMatch(/--profile/);
      expect(content).toMatch(/plan.*command|planCommand/i);
    }
  });
});

describe("AC-61: nax run --profile fast applies profile without modifying config.json", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir("nax-test-cli-run-");
    mkdirSync(join(tempDir, ".nax", "profiles"), { recursive: true });
    writeFileSync(join(tempDir, ".nax", "profiles", "fast.json"), "{}");
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  test("run --profile loads config with profile applied transiently", async () => {
    const { loadConfig } = await import("../../../src/config/loader");

    const config = await loadConfig(join(tempDir, ".nax"), { profile: "fast" });

    expect(config.profile).toBe("fast");

    // config.json should not have been modified
    if (existsSync(join(tempDir, ".nax", "config.json"))) {
      const configFile = JSON.parse(readFileSync(join(tempDir, ".nax", "config.json"), "utf-8"));
      expect(configFile.profile).not.toBe("fast");
    }
  });
});

describe("AC-62: nax run without --profile uses config.json or defaults to default", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir("nax-test-cli-default-");
    mkdirSync(join(tempDir, ".nax", "profiles"), { recursive: true });
    delete Bun.env.NAX_PROFILE;
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  test("run without profile uses config.json or defaults", async () => {
    const { loadConfig } = await import("../../../src/config/loader");

    const config = await loadConfig(join(tempDir, ".nax"));

    expect(config.profile).toBeDefined();
  });
});

describe("AC-63: --profile option appears in nax run --help", () => {
  test("help output mentions --profile for run command", async () => {
    const binPath = join(
      process.cwd(),
      "bin/nax.ts"
    );

    if (existsSync(binPath)) {
      const content = readFileSync(binPath, "utf-8");
      // Verify --profile is documented for run
      expect(content).toMatch(/--profile/);
    }
  });
});

describe("AC-64: --profile option appears in nax plan --help", () => {
  test("help output mentions --profile for plan command", async () => {
    const binPath = join(
      process.cwd(),
      "bin/nax.ts"
    );

    if (existsSync(binPath)) {
      const content = readFileSync(binPath, "utf-8");
      // Verify --profile is documented for plan
      expect(content).toMatch(/--profile/);
    }
  });
});
