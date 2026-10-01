/**
 * US-005 — the profile-aware `nax config --json` handler.
 *
 * `configJsonCommand` loads the config with the profile chain as a CLI
 * override, from the project's `.nax` directory when one is found and from
 * `dir` otherwise, then prints ONE JSON document carrying the resolved profile,
 * the config sources, the runtime requirements, and the masked config. Every
 * failure prints the error document instead, so an orchestrator that only reads
 * stdout still learns why the machine cannot run the chain.
 *
 * Harness: `NAX_GLOBAL_CONFIG_DIR` points at a fresh temp dir in every test and
 * `NAX_PROFILE` is unset, so `profile: []` resolves no overlay. Output is
 * captured by replacing `_configJsonDeps.log`; "the document" below always
 * means the single captured string, decoded from JSON.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { _configJsonDeps, type ConfigJsonReport, configJsonCommand } from "@/cli/config-json";
import type { ConfigRequirements } from "@/cli/config-requirements";
import type { NaxConfig } from "@/config";

/** The printed document: the success shape, or the error document on failure. */
type JsonDocument = Partial<ConfigJsonReport> & { error?: { code?: string; message?: string } };

const FIXED_REQUIREMENTS: ConfigRequirements = {
  agent: "stub-agent",
  transport: "acp",
  protocol: "hybrid",
  providers: ["stub-provider"],
  sandbox: false,
};

const originalGlobalDir = process.env.NAX_GLOBAL_CONFIG_DIR;
const originalProfile = process.env.NAX_PROFILE;
const realLog = _configJsonDeps.log;
const realBuildConfigRequirements = _configJsonDeps.buildConfigRequirements;

let globalDir: string;
let tempProject: string;
let out: string[];
const tempDirs: string[] = [];

/** A fresh temp dir, realpath-resolved so path assertions survive macOS /var symlinks. */
function freshDir(prefix: string): string {
  const dir = realpathSync(makeTempDir(prefix));
  tempDirs.push(dir);
  return dir;
}

function writeJsonFile(path: string, content: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(content), "utf8");
}

function writeGlobalConfig(content: unknown): void {
  writeJsonFile(join(globalDir, "config.json"), content);
}

function writeGlobalProfile(name: string, content: unknown): void {
  writeJsonFile(join(globalDir, "profiles", `${name}.json`), content);
}

function writeProjectProfile(name: string, content: unknown): void {
  writeJsonFile(join(tempProject, ".nax", "profiles", `${name}.json`), content);
}

/** The single captured document; an empty stand-in when nothing was printed. */
function document(): JsonDocument {
  const [first] = out;
  if (first === undefined) return {};
  return JSON.parse(first);
}

beforeEach(() => {
  globalDir = freshDir("nax-config-json-global-");
  tempProject = freshDir("nax-config-json-project-");
  process.env.NAX_GLOBAL_CONFIG_DIR = globalDir;
  delete process.env.NAX_PROFILE;
  writeJsonFile(join(tempProject, ".nax", "config.json"), {});
  out = [];
  _configJsonDeps.log = (text: string) => {
    out.push(text);
  };
});

afterEach(() => {
  _configJsonDeps.log = realLog;
  _configJsonDeps.buildConfigRequirements = realBuildConfigRequirements;
  process.env.NAX_GLOBAL_CONFIG_DIR = originalGlobalDir;
  if (originalProfile === undefined) {
    delete process.env.NAX_PROFILE;
  } else {
    process.env.NAX_PROFILE = originalProfile;
  }
  while (tempDirs.length > 0) cleanupTempDir(tempDirs.pop());
});

describe("configJsonCommand — profile chain", () => {
  test("US-005 AC1 resolves a global profile into profileChain", async () => {
    writeGlobalProfile("p", {});

    await configJsonCommand({ dir: tempProject, profile: ["p"] });

    expect(document().profileChain).toEqual(["p"]);
  });

  test("US-005 AC2 returns 0 when the profile resolves", async () => {
    writeGlobalProfile("p", {});

    const exitCode = await configJsonCommand({ dir: tempProject, profile: ["p"] });

    expect(exitCode).toBe(0);
  });

  test("US-005 AC3 joins a two-profile chain into the composite profile name", async () => {
    writeGlobalProfile("a", {});
    writeGlobalProfile("b", {});

    await configJsonCommand({ dir: tempProject, profile: ["a", "b"] });

    expect(document().profile).toBe("a+b");
  });

  test("US-005 AC4 splits the comma form of a repeated --profile flag into the chain", async () => {
    writeGlobalProfile("a", {});
    writeGlobalProfile("b", {});

    await configJsonCommand({ dir: tempProject, profile: ["a,b"] });

    expect(document().profileChain).toEqual(["a", "b"]);
  });

  test("US-005 AC5 resolves a project profile from a subdirectory workdir", async () => {
    writeProjectProfile("proj", {});
    const subdir = join(tempProject, "src");
    mkdirSync(subdir, { recursive: true });

    await configJsonCommand({ dir: subdir, profile: ["proj"] });

    expect(document().profileChain).toEqual(["proj"]);
  });
});

describe("configJsonCommand — sources", () => {
  test("US-005 AC6 reports the project config path when dir is a subdirectory", async () => {
    const subdir = join(tempProject, "src");
    mkdirSync(subdir, { recursive: true });

    await configJsonCommand({ dir: subdir, profile: [] });

    expect(document().sources?.project).toBe(join(tempProject, ".nax", "config.json"));
  });

  test("US-005 AC11 reports the project config file as a project source", async () => {
    await configJsonCommand({ dir: tempProject, profile: [] });

    expect(document().sources?.project).toBe(join(tempProject, ".nax", "config.json"));
  });

  test("US-005 AC12 reports the global config file as a global source", async () => {
    writeGlobalConfig({});

    await configJsonCommand({ dir: tempProject, profile: [] });

    expect(document().sources?.global).toBe(join(globalDir, "config.json"));
  });

  test("US-005 AC13 succeeds outside a project when the global profile exists", async () => {
    writeGlobalProfile("p", {});
    const plainDir = freshDir("nax-config-json-plain-");

    const exitCode = await configJsonCommand({ dir: plainDir, profile: ["p"] });

    expect(exitCode).toBe(0);
  });

  test("US-005 AC14 reports no project source outside a project", async () => {
    writeGlobalProfile("p", {});
    const plainDir = freshDir("nax-config-json-plain-");

    await configJsonCommand({ dir: plainDir, profile: ["p"] });

    expect(document().sources?.project).toBeNull();
  });
});

describe("configJsonCommand — requirements", () => {
  test("US-005 AC7 derives providers from the profile's native model tiers", async () => {
    writeGlobalProfile("p", {
      agent: { default: "native" },
      models: { native: { fast: "openai/gpt-a", balanced: "openai/gpt-b", powerful: "deepseek/ds-c" } },
    });

    await configJsonCommand({ dir: tempProject, profile: ["p"] });

    expect(document().requirements?.providers).toEqual(["deepseek", "openai"]);
  });

  test("US-005 AC8 publishes the requirements the injected builder returns", async () => {
    writeGlobalProfile("p", {});
    _configJsonDeps.buildConfigRequirements = () => FIXED_REQUIREMENTS;

    await configJsonCommand({ dir: tempProject, profile: ["p"] });

    expect(document().requirements).toEqual(FIXED_REQUIREMENTS);
  });

  test("US-005 AC9 builds requirements once, from the resolved profile config", async () => {
    writeGlobalProfile("p", {});
    const seen: NaxConfig[] = [];
    _configJsonDeps.buildConfigRequirements = (config: NaxConfig) => {
      seen.push(config);
      return FIXED_REQUIREMENTS;
    };

    await configJsonCommand({ dir: tempProject, profile: ["p"] });

    expect(seen).toHaveLength(1);
    expect(seen[0].profile).toBe("p");
  });
});

describe("configJsonCommand — masked config", () => {
  test("US-005 AC10 never prints a profile-supplied model credential", async () => {
    writeGlobalProfile("p", {
      models: {
        native: {
          fast: { provider: "openai", model: "openai/gpt-a", env: { OPENAI_API_KEY: "sk-profile-secret" } },
        },
      },
    });

    await configJsonCommand({ dir: tempProject, profile: ["p"] });

    expect(document().profileChain).toEqual(["p"]);
    expect(out.join("\n")).not.toContain("sk-profile-secret");
  });
});

describe("configJsonCommand — error documents", () => {
  test("US-005 AC15 returns 1 when the requested profile does not exist", async () => {
    const exitCode = await configJsonCommand({ dir: tempProject, profile: ["missing"] });

    expect(exitCode).toBe(1);
  });

  test("US-005 AC16 reports PROFILE_NOT_FOUND when the profile does not exist", async () => {
    await configJsonCommand({ dir: tempProject, profile: ["missing"] });

    expect(document().error?.code).toBe("PROFILE_NOT_FOUND");
  });

  test("US-005 AC17 reports AUTH_CONFIG_NOT_GLOBAL when a profile carries an auth key", async () => {
    writeGlobalProfile("p", { auth: { source: "file" } });

    await configJsonCommand({ dir: tempProject, profile: ["p"] });

    expect(document().error?.code).toBe("AUTH_CONFIG_NOT_GLOBAL");
  });

  test("US-005 AC18 reports PATH_DIRECTORY_NOT_FOUND for a nonexistent dir", async () => {
    await configJsonCommand({ dir: join(tempProject, "does-not-exist"), profile: [] });

    expect(document().error?.code).toBe("PATH_DIRECTORY_NOT_FOUND");
  });

  test("US-005 AC19 reports CONFIG_FLAGS_CONFLICT for --explain with --json", async () => {
    await configJsonCommand({ dir: tempProject, profile: [], explain: true });

    expect(document().error?.code).toBe("CONFIG_FLAGS_CONFLICT");
  });

  test("US-005 AC20 reports CONFIG_FLAGS_CONFLICT for --diff with --json", async () => {
    await configJsonCommand({ dir: tempProject, profile: [], diff: true });

    expect(document().error?.code).toBe("CONFIG_FLAGS_CONFLICT");
  });

  test("US-005 AC21 reports CONFIG_JSON_FAILED when requirement derivation throws", async () => {
    _configJsonDeps.buildConfigRequirements = () => {
      throw new Error("boom");
    };

    await configJsonCommand({ dir: tempProject, profile: [] });

    expect(document().error?.code).toBe("CONFIG_JSON_FAILED");
  });

  test("US-005 AC22 prints exactly one document when the profile is missing", async () => {
    await configJsonCommand({ dir: tempProject, profile: ["missing"] });

    expect(out).toHaveLength(1);
  });
});
