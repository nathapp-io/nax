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
  maskProfileValues,
  profileCreateCommand,
  profileCurrentCommand,
  profileListCommand,
  profileShowCommand,
  profileUseCommand,
} from "@/cli/config-profile";
import { DEFAULT_CONFIG } from "@/config";

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

  test("leaves exempt keys visible while still masking a real secret beside them", async () => {
    await writeJsonAsync(join(tempDir, ".nax", "profiles", "fast.json"), {
      // All three match SENSITIVE_KEY_PATTERN and none carries a secret.
      maxTokens: 384000,
      fallbackToKeywords: false,
      emptyKeyword: 2,
      apiKey: "raw-api-key",
    });

    const parsed = JSON.parse(await profileShowCommand("fast", tempDir, { unmask: false }));

    expect(parsed.maxTokens).toBe(384000);
    expect(parsed.fallbackToKeywords).toBe(false);
    expect(parsed.emptyKeyword).toBe(2);
    expect(parsed.apiKey).toBe("***");
  });

  test("unmasks maxTokens nested inside catalogOverrides, the shape that reported it", async () => {
    // nax#1982's actual shape: a number two arrays deep, so this also covers
    // the BUG-36 array recursion in maskProfileValue, which the flat case
    // never reaches.
    await writeJsonAsync(join(tempDir, ".nax", "profiles", "fast.json"), {
      agent: {
        native: {
          catalogOverrides: [
            { provider: "opencode-go", models: [{ id: "deepseek-flash", maxTokens: 384000, apiKey: "nested-secret" }] },
          ],
        },
      },
    });

    const parsed = JSON.parse(await profileShowCommand("fast", tempDir, { unmask: false }));
    const model = parsed.agent.native.catalogOverrides[0].models[0];

    expect(model.maxTokens).toBe(384000);
    expect(model.id).toBe("deepseek-flash");
    expect(model.apiKey).toBe("***");
  });

  test("masks an object under a sensitive key WHOLESALE, without recursing into it", async () => {
    // The exemption list must not weaken this: a subtree under a sensitive
    // key may nest secret strings carrying no $VAR marker for
    // maskProfileValue to catch, so the whole subtree collapses to one "***".
    await writeJsonAsync(join(tempDir, ".nax", "profiles", "fast.json"), {
      credentials: { apiToken: "nested-secret", ttlSeconds: 60 },
    });

    const parsed = JSON.parse(await profileShowCommand("fast", tempDir, { unmask: false }));

    expect(parsed.credentials).toBe("***");
  });

  test("masks every header VALUE, since a header name need not look sensitive (nax#2019)", async () => {
    // nax#2019 admitted `headers` to agent.native.catalogOverrides, and a
    // headers map exists largely to carry auth. The key-name pattern does NOT
    // match the commonest credential header — "Authorization" contains none of
    // key/token/secret/password/credential — so recursing into the map printed
    // a bearer token in clear in `nax config`, which shares this masker
    // (config-display.ts, SEC-05).
    //
    // Values, not the map wholesale: a headers map is Record<string, string>,
    // so there is no deeper nesting for a secret to hide in and masking every
    // value is already complete. Keeping the NAMES readable is what makes a
    // misrouted request diagnosable — the wholesale rule that applies to an
    // arbitrary subtree under a sensitive key would throw that away.
    await writeJsonAsync(join(tempDir, ".nax", "profiles", "fast.json"), {
      agent: {
        native: {
          catalogOverrides: [
            {
              provider: "openrouter",
              baseUrl: "https://proxy.test/v1",
              headers: { Authorization: "Bearer sk-must-not-print", "X-Title": "nax" },
              models: [],
            },
          ],
        },
      },
    });

    const parsed = JSON.parse(await profileShowCommand("fast", tempDir, { unmask: false }));
    const override = parsed.agent.native.catalogOverrides[0];

    expect(override.headers).toEqual({ Authorization: "***", "X-Title": "***" });
    // baseUrl is not a secret and stays readable: masking it would hide the
    // one field that says where requests are actually going.
    expect(override.baseUrl).toBe("https://proxy.test/v1");
  });

  test.each([
    ["an array of header objects", [{ Authorization: "Bearer sk-must-not-print" }]],
    ["a bare string", "Authorization: Bearer sk-must-not-print"],
  ])("fails CLOSED when headers is not a plain map — %s (nax#2019)", async (_label, headers) => {
    // profileShowCommand reads RAW un-Zod'd JSON, so the schema's
    // Record<string, string> guarantee does not hold here. Delegating an
    // unexpected shape back to the generic masker walked into it and printed
    // "Authorization" in clear, because that name matches none of
    // key/token/secret/password/credential.
    await writeJsonAsync(join(tempDir, ".nax", "profiles", "fast.json"), { headers });

    const parsed = JSON.parse(await profileShowCommand("fast", tempDir, { unmask: false }));

    expect(JSON.stringify(parsed)).not.toContain("sk-must-not-print");
  });

  test("masks a headers map regardless of key casing (nax#2019)", async () => {
    // Raw profile JSON again: `.strict()` normalises nothing here, so a
    // profile spelling it "Headers" would otherwise bypass masking entirely.
    await writeJsonAsync(join(tempDir, ".nax", "profiles", "fast.json"), {
      Headers: { Authorization: "Bearer sk-must-not-print" },
    });

    const parsed = JSON.parse(await profileShowCommand("fast", tempDir, { unmask: false }));

    expect(parsed.Headers).toEqual({ Authorization: "***" });
  });

  test("a numeric value under a NON-exempt sensitive key still masks", async () => {
    // Deliberate: profiles are raw un-Zod'd JSON, so any key may appear, and
    // a numeric passcode must not print in the default view.
    await writeJsonAsync(join(tempDir, ".nax", "profiles", "fast.json"), {
      password: 8675309,
    });

    const parsed = JSON.parse(await profileShowCommand("fast", tempDir, { unmask: false }));

    expect(parsed.password).toBe("***");
  });

  test("SENSITIVE_KEY_EXEMPTIONS covers every non-string DEFAULT_CONFIG key that matches the pattern", () => {
    // Drift gate. A new config key like `maxOutputTokens` would silently go
    // back to printing "***"; this fails instead, naming the key to add.
    const pattern = /key|token|secret|password|credential/i;
    const defaults = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    const masked = maskProfileValues(defaults);

    const isRecord = (v: unknown): v is Record<string, unknown> =>
      typeof v === "object" && v !== null && !Array.isArray(v);

    const destroyed: string[] = [];
    const walk = (original: unknown, shown: unknown, path: string): void => {
      if (Array.isArray(original)) {
        const shownItems = Array.isArray(shown) ? shown : [];
        for (const [i, item] of original.entries()) {
          walk(item, shownItems[i], `${path}[${i}]`);
        }
        return;
      }
      if (!isRecord(original)) return;
      const shownFields = isRecord(shown) ? shown : {};
      for (const [key, value] of Object.entries(original)) {
        const here = path === "" ? key : `${path}.${key}`;
        const after = shownFields[key];
        if (pattern.test(key) && typeof value !== "string" && after === "***") {
          destroyed.push(here);
          continue;
        }
        walk(value, after, here);
      }
    };
    walk(defaults, masked, "");

    expect(destroyed).toEqual([]);
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
