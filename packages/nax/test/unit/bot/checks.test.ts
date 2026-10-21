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
    expect(_botChecksDeps.runGit).not.toHaveBeenCalledWith(["show", "base-sha:package.json"], "/repo");
  });
  test("AC-2: config gates use configured preRun", async () => {
    configGates();
    input.config = makeNaxConfig({ execution: { preRun: [{ command: "prepare", timeoutSeconds: 23 }] } });
    const checks = await resolveBotChecks(input);
    expect(checks.preRun).toEqual([{ command: "prepare", timeoutSeconds: 23 }]);
    expect(checks.preRun).not.toBe(input.config.execution.preRun);
    expect(checks.preRun[0]).not.toBe(input.config.execution.preRun?.[0]);
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
    expect(_botChecksDeps.runGit).not.toHaveBeenCalledWith(["show", "base-sha:CLAUDE.md"], "/repo");
  });
  test("AC-10: oversized file skips extraction and does not fall back to CLAUDE", async () => {
    files = { "AGENTS.md": "x".repeat(65_537), "CLAUDE.md": "checks" };
    expect(await resolveBotChecks(input)).toEqual(none);
    expect(input.extract).not.toHaveBeenCalled();
    expect(_botChecksDeps.runGit).not.toHaveBeenCalledWith(["show", "base-sha:CLAUDE.md"], "/repo");
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
    expect(_botChecksDeps.runGit).toHaveBeenCalledTimes(2);
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
    expect(warn).toHaveBeenCalledTimes(failure === "show" ? 1 : 2);
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
    const checks = await resolveBotChecks(input);
    expect(checks.preRun).toEqual([{ command: "configured", timeoutSeconds: 17 }]);
    expect(checks.preRun).not.toBe(input.config.execution.preRun);
    expect(checks.preRun[0]).not.toBe(input.config.execution.preRun?.[0]);
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

describe("resolveBotChecks detected tier", () => {
  function manifest(scripts: Record<string, unknown> = { lint: "eslint ." }): void {
    files["package.json"] = JSON.stringify({ scripts });
  }

  test("US-003 AC-1/2: bun scripts resolve detected ordered gates", async () => {
    manifest({ test: "runner", lint: "checker" });
    files["bun.lock"] = "";
    expect(await resolveBotChecks(input)).toEqual({
      source: "detected",
      gates: [
        { name: "lint", command: "bun run lint" },
        { name: "test", command: "bun run test" },
      ],
      preRun: [{ command: "bun install --frozen-lockfile", timeoutSeconds: 600 }],
    });
    expect(_botChecksDeps.runGit).toHaveBeenCalledWith(["show", "base-sha:package.json"], "/repo");
  });
  test.each([
    ["AC-3", { typecheck: "tsc", "type-check": "other" }, [{ name: "typecheck", command: "npm run typecheck" }]],
    [
      "alias",
      { "type-check": "tsc", build: "compile" },
      [
        { name: "build", command: "npm run build" },
        { name: "typecheck", command: "npm run type-check" },
      ],
    ],
    [
      "AC-4",
      { lint: "checker", test: 'echo "Error: no test specified" && exit 1' },
      [{ name: "lint", command: "npm run lint" }],
    ],
    ["AC-5", { lint: 1, test: "runner" }, [{ name: "test", command: "npm run test" }]],
  ] as const)("US-003 %s: selects usable scripts", async (_ac, scripts, gates) => {
    manifest(scripts);
    expect((await resolveBotChecks(input)).gates).toEqual(gates);
  });
  test.each([
    ["AC-6/7", "package-lock.json", "npm run", "npm ci"],
    ["AC-8/9", "pnpm-lock.yaml", "pnpm run", "pnpm install --frozen-lockfile"],
    ["AC-10", "bun.lockb", "bun run", "bun install --frozen-lockfile"],
    ["AC-11/12", "yarn.lock", "yarn", null],
    ["AC-13/14", "", "npm run", null],
  ] as const)("US-003 %s: lockfile selects prefix and install", async (_ac, lockfile, prefix, install) => {
    manifest();
    if (lockfile) files[lockfile] = "";
    expect(await resolveBotChecks(input)).toEqual({
      source: "detected",
      gates: [{ name: "lint", command: `${prefix} lint` }],
      preRun: install ? [{ command: install, timeoutSeconds: 600 }] : [],
    });
  });
  test.each(["not json", "{}", '{"scripts":null}', '{"scripts":[]}', "null"])(
    "US-003 AC-15/19: unusable manifest %s yields none",
    async (text) => {
      files["package.json"] = text;
      files["package-lock.json"] = "";
      expect(await resolveBotChecks(input)).toEqual(none);
      expect(_botChecksDeps.runGit).toHaveBeenCalledWith(["show", "base-sha:package.json"], "/repo");
    },
  );
  test.each(["ls-tree", "show"])("US-003 AC-16/20: package %s failure warns", async (command) => {
    manifest();
    const runGit = _botChecksDeps.runGit;
    _botChecksDeps.runGit = mock(async (args: string[], cwd: string) =>
      args[0] === command && args.some((arg) => arg.endsWith("package.json"))
        ? { exitCode: 128, stdout: "", stderr: "read failed" }
        : runGit(args, cwd),
    );
    expect(await resolveBotChecks(input)).toEqual(none);
    expect(warn).toHaveBeenCalledWith(
      "bot",
      "Skipping base detected checks",
      expect.objectContaining({ baseSha: "base-sha" }),
    );
  });
  test.each([
    ["bun.lock", "bun run", "bun install --frozen-lockfile"],
    ["bun.lockb", "bun run", "bun install --frozen-lockfile"],
    ["package-lock.json", "npm run", "npm ci"],
    ["pnpm-lock.yaml", "pnpm run", "pnpm install --frozen-lockfile"],
  ])("lockfile priority starts at %s", async (first, prefix, install) => {
    manifest();
    const order = ["bun.lock", "bun.lockb", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"];
    for (const path of order.slice(order.indexOf(first))) files[path] = "";
    const result = await resolveBotChecks(input);
    expect(result.gates).toEqual([{ name: "lint", command: `${prefix} lint` }]);
    expect(result.preRun).toEqual([{ command: install, timeoutSeconds: 600 }]);
  });
  test("no usable gates discards installs, including an unused extraction install", async () => {
    manifest({ lint: 1 });
    files["AGENTS.md"] = "checks";
    files["package-lock.json"] = "";
    input.extract = mock(async () => ({ gates: [], install: "unused install" }));
    expect(await resolveBotChecks(input)).toEqual(none);
    manifest();
    expect((await resolveBotChecks(input)).preRun).toEqual([{ command: "npm ci", timeoutSeconds: 600 }]);
  });
  test("instruction gates inherit lockfile install when extraction has none", async () => {
    files["AGENTS.md"] = "checks";
    files["package-lock.json"] = "";
    expect((await resolveBotChecks(input)).preRun).toEqual([{ command: "npm ci", timeoutSeconds: 600 }]);
    input.extract = mock(async () => ({ ...extracted, install: "explicit install" }));
    expect((await resolveBotChecks(input)).preRun).toEqual([{ command: "explicit install", timeoutSeconds: 600 }]);
  });
  test.each([false, true])("lockfile inspection failure warns (config gates: %s)", async (configured) => {
    manifest();
    if (configured) configGates();
    const runGit = _botChecksDeps.runGit;
    _botChecksDeps.runGit = mock(async (args: string[], cwd: string) =>
      args[5] === "bun.lock" ? { exitCode: 128, stdout: "", stderr: "bad ref" } : runGit(args, cwd),
    );
    const result = await resolveBotChecks(input);
    expect(result.source).toBe(configured ? "config" : "none");
    expect(result.preRun).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });
  test("present lockfile read failure skips detection with a warning", async () => {
    manifest();
    files["bun.lock"] = "";
    const runGit = _botChecksDeps.runGit;
    _botChecksDeps.runGit = mock(async (args: string[], cwd: string) =>
      args[0] === "show" && args[1] === "base-sha:bun.lock"
        ? { exitCode: 128, stdout: "", stderr: "unreadable lockfile" }
        : runGit(args, cwd),
    );
    expect(await resolveBotChecks(input)).toEqual(none);
    expect(warn).toHaveBeenCalledTimes(1);
  });
  test("US-003 AC-17: lockfile install also applies to config gates", async () => {
    configGates();
    files["package-lock.json"] = "";
    expect((await resolveBotChecks(input)).preRun).toEqual([{ command: "npm ci", timeoutSeconds: 600 }]);
  });
  test("US-003 AC-18: config preRun wins with detected gates", async () => {
    manifest();
    files["package-lock.json"] = "";
    input.hasBaseNax = true;
    input.config = makeNaxConfig({ execution: { preRun: [{ command: "custom", timeoutSeconds: 42 }] } });
    const result = await resolveBotChecks(input);
    expect(result.source).toBe("detected");
    expect(result.preRun).toEqual(input.config.execution.preRun);
  });
  test.each(["throw", "null"])("US-003 AC-21: %s extraction continues to detection", async (mode) => {
    manifest();
    files["AGENTS.md"] = "checks";
    input.extract = mock(async () => {
      if (mode === "throw") throw new Error("unavailable");
      return null;
    });
    expect((await resolveBotChecks(input)).source).toBe("detected");
    expect(warn).toHaveBeenCalledTimes(1);
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

test.each([false, true])("git warnings distinguish stderr and timeout (%s)", async (timedOut) => {
  _botChecksDeps.runGit = mock(async () => ({ exitCode: 128, stdout: "", stderr: "bad revision base-sha", timedOut }));
  await resolveBotChecks(input);
  expect(warn.mock.calls[0]?.[2]).toMatchObject({
    error: expect.stringContaining(timedOut ? "git timed out" : "bad revision base-sha"),
  });
});
