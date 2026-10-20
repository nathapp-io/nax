import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { makeNaxConfig } from "@test/helpers";
import { _botChecksDeps, checkCommands, DERIVED_INSTALL_TIMEOUT_SECONDS, resolveBotChecks } from "@/bot";
import { DEFAULT_CONFIG } from "@/config";
import { initLogger, resetLogger } from "@/logger";
import type { BotChecksExtractOutput } from "@/operations/bot-checks-extract";

const original = { ..._botChecksDeps };
const defaultPreRun = structuredClone(DEFAULT_CONFIG.execution.preRun);
const none = { source: "none", gates: [], preRun: [] } satisfies Awaited<ReturnType<typeof resolveBotChecks>>;
const extracted: BotChecksExtractOutput = { gates: [{ gate: "test", command: "bun run test" }] };
let files: Record<string, string>;
let input: Parameters<typeof resolveBotChecks>[0];
let warn: ReturnType<typeof spyOn<ReturnType<typeof initLogger>, "warn">>;

beforeEach(() => {
  files = {};
  input = {
    repoRoot: "/repo",
    baseSha: "base-sha",
    snapshotDir: "/snap",
    hasBaseNax: false,
    config: makeNaxConfig(),
    extract: mock(async () => extracted),
  };
  _botChecksDeps.resolveGateCommands = mock(async () => []);
  _botChecksDeps.runGit = mock(async (args) => {
    const path = args[0] === "ls-tree" ? (args[5] ?? "") : (args[1] ?? "").replace("base-sha:", "");
    return {
      exitCode: 0,
      stdout: args[0] === "ls-tree" ? (path in files ? `${path}\0` : "") : (files[path] ?? ""),
      stderr: "",
    };
  });
  warn = spyOn(initLogger({ level: "silent" }), "warn");
});
afterEach(() => {
  warn.mockRestore();
  resetLogger();
  Object.assign(_botChecksDeps, original);
  // Every fixture must leave the shared defaults unchanged for later tests.
  expect(DEFAULT_CONFIG.execution.preRun).toEqual(defaultPreRun);
});

function configGates(): void {
  input.hasBaseNax = true;
  _botChecksDeps.resolveGateCommands = mock(async () => [{ name: "lint", command: "bun run lint", cwd: "/snap" }]);
}

describe("resolveBotChecks", () => {
  test("AC-1: resolves snapshot config gates without cwd", async () => {
    configGates();
    expect(await resolveBotChecks(input)).toEqual({
      source: "config",
      gates: [{ name: "lint", command: "bun run lint" }],
      preRun: [],
    });
    expect(_botChecksDeps.resolveGateCommands).toHaveBeenCalledWith("/snap", []);
    expect(_botChecksDeps.runGit).not.toHaveBeenCalled();
  });
  test("AC-2: config gates use configured preRun", async () => {
    configGates();
    input.config = makeNaxConfig({ execution: { preRun: [{ command: "prepare", timeoutSeconds: 23 }] } });
    expect((await resolveBotChecks(input)).preRun).toEqual(input.config.execution.preRun);
  });
  test("AC-3: absent base config never resolves config gates or uses config preRun", async () => {
    files["AGENTS.md"] = "checks";
    input.config = makeNaxConfig({ execution: { preRun: [{ command: "untrusted defaults", timeoutSeconds: 1 }] } });
    expect((await resolveBotChecks(input)).preRun).toEqual([]);
    expect(_botChecksDeps.resolveGateCommands).not.toHaveBeenCalled();
  });
  test("AC-4: empty config gates fall through to extraction", async () => {
    input.hasBaseNax = true;
    files["AGENTS.md"] = "checks";
    await resolveBotChecks(input);
    expect(input.extract).toHaveBeenCalledWith({ fileName: "AGENTS.md", text: "checks" });
  });
  test("AC-5: existence and content are read at baseSha in repoRoot", async () => {
    files["AGENTS.md"] = "checks";
    await resolveBotChecks(input);
    expect(_botChecksDeps.runGit).toHaveBeenNthCalledWith(
      1,
      ["ls-tree", "--name-only", "-z", "base-sha", "--", "AGENTS.md"],
      "/repo",
    );
    expect(_botChecksDeps.runGit).toHaveBeenNthCalledWith(2, ["show", "base-sha:AGENTS.md"], "/repo");
  });
  test("AC-6: extracted AGENTS gates become named checks", async () => {
    files["AGENTS.md"] = "checks";
    expect(await resolveBotChecks(input)).toEqual({
      source: "agents-md",
      gates: [{ name: "test", command: "bun run test" }],
      preRun: [],
    });
  });
  test("AC-7: missing AGENTS selects root CLAUDE", async () => {
    files["CLAUDE.md"] = "claude checks";
    await resolveBotChecks(input);
    expect(input.extract).toHaveBeenCalledWith({ fileName: "CLAUDE.md", text: "claude checks" });
  });
  test("AC-8: CLAUDE gates have claude-md source", async () => {
    files["CLAUDE.md"] = "checks";
    expect((await resolveBotChecks(input)).source).toBe("claude-md");
  });
  test("AC-9: AGENTS wins without reading CLAUDE", async () => {
    files = { "AGENTS.md": "agents", "CLAUDE.md": "claude" };
    await resolveBotChecks(input);
    expect(input.extract).toHaveBeenCalledTimes(1);
    expect(input.extract).toHaveBeenCalledWith({ fileName: "AGENTS.md", text: "agents" });
    expect(_botChecksDeps.runGit).toHaveBeenCalledTimes(2);
  });
  test("AC-10: oversized file skips extraction and does not fall back to CLAUDE", async () => {
    files = { "AGENTS.md": "x".repeat(65_537), "CLAUDE.md": "checks" };
    expect(await resolveBotChecks(input)).toEqual(none);
    expect(input.extract).not.toHaveBeenCalled();
    expect(_botChecksDeps.runGit).toHaveBeenCalledTimes(2);
  });
  test.each(["reject", "null"] as const)("AC-11/12/19: %s extraction warns and returns none", async (mode) => {
    files["AGENTS.md"] = "checks";
    input.extract = mock(async () => {
      if (mode === "reject") throw new Error("extract unavailable");
      return null;
    });
    expect(await resolveBotChecks(input)).toEqual(none);
    expect(input.extract).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toBe("bot");
  });
  test("AC-13: failed ls-tree never invokes extraction", async () => {
    _botChecksDeps.runGit = mock(async () => ({ exitCode: 128, stdout: "AGENTS.md\0", stderr: "bad ref" }));
    expect(await resolveBotChecks(input)).toEqual(none);
    expect(input.extract).not.toHaveBeenCalled();
    expect(_botChecksDeps.runGit).toHaveBeenCalledTimes(1);
  });
  test("AC-14: extracted gates follow GATE_ORDER", async () => {
    files["AGENTS.md"] = "checks";
    input.extract = mock(
      async (): Promise<BotChecksExtractOutput> => ({
        gates: [
          { gate: "test", command: "test" },
          { gate: "lint", command: "lint" },
          { gate: "build", command: "build" },
          { gate: "typecheck", command: "typecheck" },
        ],
      }),
    );
    expect((await resolveBotChecks(input)).gates.map((gate) => gate.name)).toEqual([
      "build",
      "typecheck",
      "lint",
      "test",
    ]);
  });
  test("AC-15: instruction install becomes a timed preRun step", async () => {
    files["AGENTS.md"] = "checks";
    input.extract = mock(async () => ({ ...extracted, install: "npm ci" }));
    expect((await resolveBotChecks(input)).preRun).toEqual([
      { command: "npm ci", timeoutSeconds: DERIVED_INSTALL_TIMEOUT_SECONDS },
    ]);
  });
  test("AC-17: missing files return exact none result without warnings", async () => {
    expect(await resolveBotChecks(input)).toEqual(none);
    expect(input.extract).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
  test("AC-20: oversized bytes warn", async () => {
    files["AGENTS.md"] = "é".repeat(32_769);
    expect(await resolveBotChecks(input)).toEqual(none);
    expect(input.extract).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });
  test.each(["ls-tree", "show", "throw"] as const)("AC-21: %s git failure warns and skips tier", async (failure) => {
    _botChecksDeps.runGit = mock(async (args) => {
      if (failure === "throw") throw new Error("spawn failed");
      return args[0] === failure
        ? { exitCode: 128, stdout: "", stderr: "unavailable" }
        : { exitCode: 0, stdout: "AGENTS.md\0", stderr: "" };
    });
    expect(await resolveBotChecks(input)).toEqual(none);
    expect(input.extract).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });
  test("preserves config gate setup", async () => {
    input.hasBaseNax = true;
    _botChecksDeps.resolveGateCommands = mock(async () => [
      { name: "e2e", command: ["journey"], setup: ["start"], cwd: "/snap" },
    ]);
    expect((await resolveBotChecks(input)).gates).toEqual([{ name: "e2e", command: ["journey"], setup: ["start"] }]);
  });
  test("config preRun wins even with instruction-file gates", async () => {
    input.hasBaseNax = true;
    input.config = makeNaxConfig({ execution: { preRun: [{ command: "configured", timeoutSeconds: 17 }] } });
    files["AGENTS.md"] = "checks";
    input.extract = mock(async () => ({ ...extracted, install: "npm ci" }));
    expect((await resolveBotChecks(input)).preRun).toEqual(input.config.execution.preRun);
  });
  test("preRun alone never produces checks", async () => {
    input.hasBaseNax = true;
    input.config = makeNaxConfig({ execution: { preRun: [{ command: "configured", timeoutSeconds: 17 }] } });
    files["AGENTS.md"] = "checks";
    input.extract = mock(async () => ({ gates: [], install: "npm ci" }));
    expect(await resolveBotChecks(input)).toEqual(none);
  });
  test("exactly 65,536 bytes may be extracted", async () => {
    files["AGENTS.md"] = "x".repeat(65_536);
    expect((await resolveBotChecks(input)).source).toBe("agents-md");
    expect(input.extract).toHaveBeenCalledTimes(1);
  });
});

describe("DERIVED_INSTALL_TIMEOUT_SECONDS", () => {
  test("AC-16: derived install timeout is 600 seconds", () => {
    expect(DERIVED_INSTALL_TIMEOUT_SECONDS).toBe(600);
  });
});

describe("checkCommands", () => {
  test("AC-18: flattens list commands, not argv or setup", () => {
    expect(
      checkCommands({
        source: "config",
        gates: [
          { name: "test", command: ["bun run test:unit", "bun run test:int"], setup: "prepare" },
          { name: "lint", command: "bun run lint" },
        ],
        preRun: [],
      }),
    ).toEqual(["bun run test:unit", "bun run test:int", "bun run lint"]);
  });
});
