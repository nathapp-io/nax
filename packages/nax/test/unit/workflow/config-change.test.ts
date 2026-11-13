/**
 * US-002 (gate-config-route): the candidate rule, its base-commit manifest reader and the protected
 * path list the advisor is told about (#2897/#2898). No model decides whether a change is safe, so
 * every case here is the rule itself.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  _configChangeDeps,
  configChangeCandidates,
  GATE_COMMAND_KEY,
  protectedPathList,
  readBaseScripts,
  renderCommandSpec,
} from "@/workflow/config-change";

const EMPTY_POLICY = { gitExcludePathspecs: [], gitIgnorePatterns: [] };

const origGit = _configChangeDeps.git;
const gitCalls: { args: string[]; cwd: string }[] = [];
afterEach(() => {
  _configChangeDeps.git = origGit;
  gitCalls.length = 0;
});

/** Stub the one git read `readBaseScripts` makes, recording what it was asked for. */
function stubGit(result: { stdout: string; stderr?: string; exitCode: number }): void {
  _configChangeDeps.git = async (args, cwd) => {
    gitCalls.push({ args, cwd });
    return result;
  };
}

const manifest = (body: unknown): string => JSON.stringify(body);

describe("GATE_COMMAND_KEY", () => {
  test("maps every gate to the quality command key its command lives under", () => {
    expect(GATE_COMMAND_KEY).toEqual({
      lint: "lint",
      typecheck: "typecheck",
      scoped: "testScoped",
      "full-suite": "test",
    });
  });
});

describe("configChangeCandidates", () => {
  test("offers a script's value for a red scoped gate, and its {{files}} form after it", () => {
    expect(
      configChangeCandidates({
        redGates: ["scoped"],
        commands: { testScoped: "bun test {{files}}" },
        scripts: { test: "bun test --isolate" },
      }),
    ).toEqual([
      { key: "testScoped", to: "bun test --isolate", script: "test" },
      { key: "testScoped", to: "bun test --isolate {{files}}", script: "test" },
    ]);
  });

  test("offers every base-commit script for a red lint gate, the value alone", () => {
    expect(configChangeCandidates({ redGates: ["lint"], scripts: { lint: "biome check ." } })).toEqual([
      { key: "lint", to: "biome check .", script: "lint" },
    ]);
  });

  test("drops a candidate equal to the key's current command", () => {
    expect(
      configChangeCandidates({
        redGates: ["lint"],
        commands: { lint: "biome check ." },
        scripts: { lint: "biome check ." },
      }),
    ).toEqual([]);
  });

  test("offers nothing when no gate is red", () => {
    expect(configChangeCandidates({ redGates: [], scripts: { test: "bun test" } })).toEqual([]);
  });

  test("keeps one candidate for two scripts with the same value, naming the first in key order", () => {
    expect(configChangeCandidates({ redGates: ["lint"], scripts: { a: "biome check .", b: "biome check ." } })).toEqual(
      [{ key: "lint", to: "biome check .", script: "a" }],
    );
  });

  test("groups candidates in the red-gate order it was given", () => {
    expect(
      configChangeCandidates({
        redGates: ["lint", "scoped"],
        scripts: { lint: "biome check .", test: "bun test --isolate" },
      }),
    ).toEqual([
      { key: "lint", to: "biome check .", script: "lint" },
      { key: "lint", to: "bun test --isolate", script: "test" },
      { key: "testScoped", to: "biome check .", script: "lint" },
      { key: "testScoped", to: "biome check . {{files}}", script: "lint" },
      { key: "testScoped", to: "bun test --isolate", script: "test" },
      { key: "testScoped", to: "bun test --isolate {{files}}", script: "test" },
    ]);
  });

  test("keeps a candidate a list command declares, since a list is never equal to it", () => {
    expect(
      configChangeCandidates({
        redGates: ["lint"],
        commands: { lint: ["biome check ."] },
        scripts: { lint: "biome check ." },
      }),
    ).toEqual([{ key: "lint", to: "biome check .", script: "lint" }]);
  });
});

describe("readBaseScripts", () => {
  test("reads the package manifest from the base commit, as a path relative to the repo root", async () => {
    stubGit({ stdout: manifest({ scripts: {} }), exitCode: 0 });
    await readBaseScripts("/repo", "abc123", "apps/admin");
    expect(gitCalls).toEqual([{ args: ["show", "abc123:apps/admin/package.json"], cwd: "/repo" }]);
  });

  test("returns the scripts object the base manifest declares", async () => {
    stubGit({
      stdout: manifest({ name: "admin", scripts: { build: "tsc", test: "bun test --isolate" } }),
      exitCode: 0,
    });
    expect(await readBaseScripts("/repo", "abc123", "apps/admin")).toEqual({
      build: "tsc",
      test: "bun test --isolate",
    });
  });

  test("keeps the manifest's script key order, which decides what a duplicate value names", async () => {
    stubGit({ stdout: manifest({ scripts: { zeta: "bun test", alpha: "bun run lint" } }), exitCode: 0 });
    expect(Object.keys(await readBaseScripts("/repo", "abc123", "apps/admin"))).toEqual(["zeta", "alpha"]);
  });

  test("reads the repo-root manifest when the story's package is the repo root", async () => {
    stubGit({ stdout: manifest({ scripts: { test: "bun test" } }), exitCode: 0 });
    expect(await readBaseScripts("/repo", "abc123", "")).toEqual({ test: "bun test" });
    expect(gitCalls[0]?.args).toEqual(["show", "abc123:package.json"]);
  });

  test("returns nothing when git cannot show the manifest", async () => {
    stubGit({ stdout: "", stderr: "fatal: path 'apps/admin/package.json' does not exist", exitCode: 128 });
    expect(await readBaseScripts("/repo", "abc123", "apps/admin")).toEqual({});
  });

  test("returns nothing when the git read throws", async () => {
    _configChangeDeps.git = async () => {
      throw new Error("fatal: bad object abc123");
    };
    expect(await readBaseScripts("/repo", "abc123", "apps/admin")).toEqual({});
  });

  test("returns nothing when the base manifest is not JSON", async () => {
    stubGit({ stdout: "<<<<<<< conflict", exitCode: 0 });
    expect(await readBaseScripts("/repo", "abc123", "apps/admin")).toEqual({});
  });

  test("returns nothing when the parsed manifest has no scripts object", async () => {
    stubGit({ stdout: manifest({ name: "admin", version: "1.0.0" }), exitCode: 0 });
    expect(await readBaseScripts("/repo", "abc123", "apps/admin")).toEqual({});
  });

  test("drops a script whose value is not a string, keeping the rest", async () => {
    stubGit({ stdout: manifest({ scripts: { build: "tsc", broken: 3 } }), exitCode: 0 });
    expect(await readBaseScripts("/repo", "abc123", "apps/admin")).toEqual({ build: "tsc" });
  });
});

describe("renderCommandSpec", () => {
  test("joins a multi-command list with &&, the form a reader would type", () => {
    expect(renderCommandSpec(["a", "b"])).toBe("a && b");
  });

  test("returns a single command string as is", () => {
    expect(renderCommandSpec("a")).toBe("a");
  });

  test("returns undefined for a command the config does not declare", () => {
    expect(renderCommandSpec(undefined)).toBeUndefined();
  });

  test("keeps a string's own spacing, since the exact bytes are what a change writes", () => {
    expect(renderCommandSpec("  biome check .  ")).toBe("  biome check .  ");
  });

  test("joins a list entry untouched, spacing included", () => {
    expect(renderCommandSpec([" a", "b "])).toBe(" a && b ");
  });
});

describe("protectedPathList", () => {
  test("lists the state dir and credential dir with a trailing slash, then the trust store file", () => {
    const policy = {
      ...EMPTY_POLICY,
      projectStateDir: ".nax",
      credentialDir: "/home/u/.nax",
      trustStoreFile: "/home/u/.nax/trust.json",
    };
    expect(protectedPathList(policy)).toEqual([".nax/", "/home/u/.nax/", "/home/u/.nax/trust.json"]);
  });

  test("lists nothing for a policy that carries no path", () => {
    expect(protectedPathList(EMPTY_POLICY)).toEqual([]);
  });
});
