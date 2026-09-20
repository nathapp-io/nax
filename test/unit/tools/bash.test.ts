import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { _bashToolDeps, BASH_TIMEOUT_MS, createBashTool } from "@/tools";

const realRunArgv = _bashToolDeps.runArgv;

let root: string;
let calls: Parameters<typeof realRunArgv>[0][];

function stubRunArgv(result: Partial<Awaited<ReturnType<typeof realRunArgv>>> = {}): void {
  _bashToolDeps.runArgv = async (options) => {
    calls.push(options);
    return { exitCode: 0, stdout: "out", stderr: "", timedOut: false, ...result };
  };
}

const ctx = (maxBytes = 40_000) => ({ root, resolvedPaths: [], maxBytes, maxFileBytes: 2_000_000 });

beforeEach(() => {
  root = makeTempDir("bash-tool-");
  calls = [];
});

afterEach(() => {
  _bashToolDeps.runArgv = realRunArgv;
  cleanupTempDir(root);
});

describe("createBashTool", () => {
  test("spawns the configured shell with -c and the command verbatim", async () => {
    stubRunArgv();
    const tool = createBashTool({ shell: "/bin/bash" });
    await tool.run({ command: "bun test && echo done" }, ctx());
    expect(calls[0]?.argv).toEqual(["/bin/bash", "-c", "bun test && echo done"]);
  });

  test("defaults to /bin/sh and runs in the permitted root, not the process cwd", async () => {
    stubRunArgv();
    await createBashTool().run({ command: "bun test" }, ctx());
    expect(calls[0]?.argv[0]).toBe("/bin/sh");
    expect(calls[0]?.cwd).toBe(root);
  });

  test("forwards the project's stripEnvVars", async () => {
    stubRunArgv();
    await createBashTool({ stripEnvVars: ["NPM_TOKEN"] }).run({ command: "bun test" }, ctx());
    expect(calls[0]?.stripEnvVars).toEqual(["NPM_TOKEN"]);
  });

  test("defaults the deadline to the Exec ceiling and clamps a larger request", async () => {
    stubRunArgv();
    const tool = createBashTool();
    await tool.run({ command: "bun test" }, ctx());
    expect(calls[0]?.timeoutMs).toBe(BASH_TIMEOUT_MS);
    await tool.run({ command: "bun test", timeoutMs: BASH_TIMEOUT_MS * 10 }, ctx());
    expect(calls[1]?.timeoutMs).toBe(BASH_TIMEOUT_MS);
  });

  test("honours a smaller requested deadline", async () => {
    stubRunArgv();
    await createBashTool().run({ command: "bun test", timeoutMs: 5_000 }, ctx());
    expect(calls[0]?.timeoutMs).toBe(5_000);
  });

  test("reports exit code and output, and is not an error on exit 0", async () => {
    stubRunArgv({ stdout: "hello", stderr: "" });
    const result = await createBashTool().run({ command: "echo hello" }, ctx());
    expect(result.content).toContain("exit 0");
    expect(result.content).toContain("hello");
    expect(result.isError).toBe(false);
  });

  test("a non-zero exit is an error result, not a throw", async () => {
    stubRunArgv({ exitCode: 1, stderr: "boom" });
    const result = await createBashTool().run({ command: "false" }, ctx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("boom");
  });

  test("a timeout says so and reports the deadline", async () => {
    stubRunArgv({ timedOut: true });
    const result = await createBashTool().run({ command: "sleep 999", timeoutMs: 5_000 }, ctx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("timed out after 5000ms");
  });

  test("US-003: bash returns up to readCeiling; pre-truncation size reports the full stdout", async () => {
    // US-003 replacement invariant: the tool bounds its I/O at
    // `ctx.readCeiling` (2_000_000 by default), NOT at `ctx.maxBytes`.
    // The model-facing cap and the exit-N preservation are the
    // `after_tool` policy's job, not the tool's. The full stdout
    // length is still surfaced via `resultBytesPreTruncation` so
    // downstream code can size the spill.
    stubRunArgv({ stdout: "x".repeat(5_000) });
    const result = await createBashTool().run({ command: "cat big" }, ctx(100));
    expect(result.content.length).toBeGreaterThan(100);
    expect(result.content).toContain("x");
    expect(result.resultBytesPreTruncation).toBeGreaterThan(5_000);
  });

  test("a missing or empty command is an input error, never a spawn", async () => {
    stubRunArgv();
    for (const input of [{}, { command: "" }, { command: "   " }, { command: 7 }]) {
      const result = await createBashTool().run(input, ctx());
      expect(result.isError).toBe(true);
    }
    expect(calls).toHaveLength(0);
  });

  test("a spawn-time throw surfaces as a tool error", async () => {
    _bashToolDeps.runArgv = () => {
      throw new Error("cwd vanished");
    };
    const result = await createBashTool().run({ command: "bun test" }, ctx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("cwd vanished");
  });

  test("the description steers to the structured tools first (spec R2)", () => {
    const description = createBashTool({ patterns: ["bun test *"] }).description;
    expect(description).toContain("bun test *");
    expect(description.toLowerCase()).toContain("prefer");
  });

  test("declares the command field so the policy uses the Bash branch", () => {
    expect(createBashTool().scope.commandField).toBe("command");
  });
});
