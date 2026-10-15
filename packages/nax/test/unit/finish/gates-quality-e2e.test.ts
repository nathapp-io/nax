/**
 * US-008 — the host-side e2e gate (#2530).
 *
 * Chromium cannot register its `bootstrap_check_in` Mach service inside srt, so
 * an e2e journey can only run on the host. `quality.commands.e2e` joins
 * GATE_ORDER and the gate carries an optional `setup` (that layer's
 * `e2eSetup`), run before the e2e command through the same seam.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { makeFeatureContext, makeNaxConfig } from "@test/helpers";
import type { NaxConfig } from "@/config";
import { DEFAULT_CONFIG } from "@/config";
import { QualityConfigSchema } from "@/config/schemas-execution";
import { _qualityGateDeps, resolveGateCommands, runQualityGates } from "@/finish";
import { runRepoGates } from "@/workflow/repo-gates";

const original = { ..._qualityGateDeps };
afterEach(() => Object.assign(_qualityGateDeps, original));

/** A config whose root `quality.commands` are exactly `commands`. */
function rootCommands(commands: NaxConfig["quality"]["commands"]): NaxConfig {
  return makeNaxConfig({ quality: { commands } });
}

/** A package overlay carrying exactly `commands` (never backfills from the root). */
function overlayCommands(commands: NaxConfig["quality"]["commands"]): Partial<NaxConfig> {
  return { quality: { ...DEFAULT_CONFIG.quality, commands } };
}

/** A successful `_qualityGateDeps.run` result for `commandName`. */
function ok(commandName: string) {
  return {
    commandName,
    command: "cmd",
    success: true,
    exitCode: 0,
    output: "ok",
    durationMs: 1,
    timedOut: false,
  };
}

/** A failing `_qualityGateDeps.run` result for `commandName`. */
function fail(commandName: string, output: string) {
  return { ...ok(commandName), success: false, exitCode: 1, output };
}

/** The `[name] exit=N\n…` chunk `runQualityGates` emitted for `name`. */
function chunkFor(output: string, name: string): string {
  return output.split("\n\n").find((chunk) => chunk.startsWith(`[${name}] exit=`)) ?? "";
}

describe("quality.commands.e2e — schema", () => {
  test("AC-1: e2e and e2eSetup survive a parse", () => {
    const parsed = QualityConfigSchema.parse({
      commands: { e2e: "bunx playwright test", e2eSetup: "docker compose up -d" },
    });

    expect(parsed.commands.e2e).toBe("bunx playwright test");
    expect(parsed.commands.e2eSetup).toBe("docker compose up -d");
  });
});

describe("resolveGateCommands — e2e", () => {
  test("AC-2: root test+e2e resolves to the gate order [test, e2e]", async () => {
    _qualityGateDeps.loadConfig = async () => rootCommands({ test: "bun test", e2e: "bunx playwright test" });
    _qualityGateDeps.loadPackageOverride = async () => null;

    const commands = await resolveGateCommands("/repo", []);

    expect(commands.map((c) => c.name)).toEqual(["test", "e2e"]);
  });

  test("AC-3: root e2e + e2eSetup gives the e2e gate that setup command", async () => {
    _qualityGateDeps.loadConfig = async () =>
      rootCommands({ e2e: "bunx playwright test", e2eSetup: "docker compose up -d" });
    _qualityGateDeps.loadPackageOverride = async () => null;

    const commands = await resolveGateCommands("/repo", []);

    expect(commands).toEqual([
      {
        name: "e2e",
        command: "bunx playwright test",
        cwd: "/repo",
        setup: "docker compose up -d",
      },
    ]);
  });

  test("AC-4: e2eSetup without e2e produces no e2e gate", async () => {
    _qualityGateDeps.loadConfig = async () => rootCommands({ e2eSetup: "docker compose up -d" });
    _qualityGateDeps.loadPackageOverride = async () => null;

    const commands = await resolveGateCommands("/repo", []);

    expect(commands.filter((c) => c.name === "e2e" || c.name === "e2eSetup")).toEqual([]);
  });

  test("AC-5: a package overlay's e2e gate carries that overlay's setup and the package cwd", async () => {
    _qualityGateDeps.loadConfig = async () => rootCommands({});
    _qualityGateDeps.loadPackageOverride = async (_repoRoot, packageDir) => {
      expect(packageDir).toBe("apps/web");
      return overlayCommands({ e2e: "bunx playwright test", e2eSetup: "docker compose -f web.yml up -d" });
    };

    const commands = await resolveGateCommands("/repo", ["apps/web"]);

    expect(commands).toEqual([
      {
        name: "e2e@apps/web",
        command: "bunx playwright test",
        cwd: "/repo/apps/web",
        setup: "docker compose -f web.yml up -d",
      },
    ]);
  });

  test("AC-6: same e2e command and cwd but different e2eSetup keeps both gates", async () => {
    _qualityGateDeps.loadConfig = async () =>
      rootCommands({ e2e: "bunx playwright test", e2eSetup: "docker compose up -d" });
    _qualityGateDeps.loadPackageOverride = async (_repoRoot, packageDir) => {
      // "." resolves to the root's own cwd ("/repo/." === "/repo"), so the two
      // gates differ only by their setup -- the dedupe key must include it.
      expect(packageDir).toBe(".");
      return overlayCommands({ e2e: "bunx playwright test", e2eSetup: "docker compose -f other.yml up -d" });
    };

    const commands = await resolveGateCommands("/repo", ["."]);

    expect(commands.map((c) => ({ name: c.name, cwd: c.cwd, setup: c.setup }))).toEqual([
      { name: "e2e", cwd: "/repo", setup: "docker compose up -d" },
      { name: "e2e@.", cwd: "/repo", setup: "docker compose -f other.yml up -d" },
    ]);
  });
});

describe("runQualityGates — e2e setup", () => {
  test("AC-7 + AC-8: e2e:setup runs before e2e, both at the gate's cwd", async () => {
    const calls: { commandName: string; workdir: string }[] = [];
    _qualityGateDeps.run = async (opts) => {
      calls.push({ commandName: opts.commandName, workdir: opts.workdir });
      return ok(opts.commandName);
    };

    await runQualityGates("/repo", [
      { name: "e2e", command: "bunx playwright test", cwd: "/repo/e2e", setup: "docker compose up -d" },
    ]);

    expect(calls).toEqual([
      { commandName: "e2e:setup", workdir: "/repo/e2e" },
      { commandName: "e2e", workdir: "/repo/e2e" },
    ]);
  });

  test("AC-9 + AC-10: a failing setup fails the gate, skips e2e, and says so in its chunk", async () => {
    const calls: string[] = [];
    _qualityGateDeps.run = async (opts) => {
      calls.push(opts.commandName);
      return opts.commandName === "e2e:setup"
        ? fail(opts.commandName, "docker: command not found")
        : ok(opts.commandName);
    };

    const result = await runQualityGates("/repo", [
      { name: "e2e", command: "bunx playwright test", cwd: "/repo", setup: "docker compose up -d" },
    ]);

    expect(calls).toEqual(["e2e:setup"]);
    expect(result.failing).toEqual(["e2e"]);
    expect(result.passed).toBe(false);
    const chunk = chunkFor(result.output, "e2e");
    expect(chunk.startsWith("[e2e] exit=1\nsetup failed:")).toBe(true);
    expect(chunk).toContain("docker: command not found");
  });

  test("AC-11: a passing setup followed by a failing e2e command lists e2e in failing", async () => {
    const calls: string[] = [];
    _qualityGateDeps.run = async (opts) => {
      calls.push(opts.commandName);
      return opts.commandName === "e2e" ? fail(opts.commandName, "1 journey failed") : ok(opts.commandName);
    };

    const result = await runQualityGates("/repo", [
      { name: "e2e", command: "bunx playwright test", cwd: "/repo", setup: "docker compose up -d" },
    ]);

    expect(calls).toEqual(["e2e:setup", "e2e"]);
    expect(result.ran).toEqual(["e2e"]);
    expect(result.failing).toEqual(["e2e"]);
  });
});

describe("runRepoGates — e2e", () => {
  test("AC-12: a failing e2e gate surfaces as `repo gate e2e failed:`", async () => {
    _qualityGateDeps.loadConfig = async () => rootCommands({ e2e: "bunx playwright test" });
    _qualityGateDeps.loadPackageOverride = async () => null;
    _qualityGateDeps.run = async (opts) => fail(opts.commandName, "1 journey failed");

    const run = await runRepoGates(makeFeatureContext());

    expect(run.summary.failing).toEqual(["e2e"]);
    expect(run.findings[0]?.issue.startsWith("repo gate e2e failed:")).toBe(true);
    expect(run.findings[0]?.issue).toContain("1 journey failed");
  });
});
