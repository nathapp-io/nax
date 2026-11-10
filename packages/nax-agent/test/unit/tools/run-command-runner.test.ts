/**
 * RunCommand's declared-command runner port (S1 spec section 4.2, port 7): the
 * tool never imports nax's quality runner; the caller supplies one.
 */
import { describe, expect, test } from "bun:test";
import { createRunCommandTool, type DeclaredCommandRequest } from "#src/tools/run-command";
import { withTempDir } from "#test/helpers/index";

const ctx = (root: string) => ({ root, resolvedPaths: [], maxBytes: 4096, maxFileBytes: 1024 });

describe("RunCommand — declared-command runner port", () => {
  test("hands the declared command, cwd, stripped env and origin to the supplied runner", async () => {
    await withTempDir(async (root) => {
      const seen: DeclaredCommandRequest[] = [];
      const tool = createRunCommandTool(new Map([["lint", "bun lint"]]), {
        commandCwd: root,
        stripEnvVars: ["SECRET"],
        runDeclaredCommand: async (request) => {
          seen.push(request);
          return { success: true, exitCode: 0, output: "clean" };
        },
      });
      const result = await tool.run({ command: "lint" }, ctx(root));
      expect(seen).toEqual([
        { commandName: "lint", command: "bun lint", workdir: root, stripEnvVars: ["SECRET"], origin: "agent-tool" },
      ]);
      expect(result).toEqual({ content: "exit 0\nclean", isError: false });
    });
  });

  test("answers exit 1 without spawning when no runner was configured", async () => {
    await withTempDir(async (root) => {
      const tool = createRunCommandTool(new Map([["lint", "bun lint"]]), { commandCwd: root });
      const result = await tool.run({ command: "lint" }, ctx(root));
      expect(result.isError).toBe(true);
      expect(result.content).toBe("exit 1\nno declared-command runner is configured for this session");
    });
  });
});

describe("RunCommand — input shape refusals", () => {
  const neverRun = async (): Promise<never> => {
    throw new Error("the runner must not be reached");
  };

  test("refuses a call that supplies both command and argv", async () => {
    await withTempDir(async (root) => {
      const tool = createRunCommandTool(new Map([["lint", "bun lint"]]), {
        commandCwd: root,
        runDeclaredCommand: neverRun,
      });
      const result = await tool.run({ command: "lint", argv: ["bun", "lint"] }, ctx(root));
      expect(result).toEqual({ content: "supply exactly one of command or argv, not both", isError: true });
    });
  });

  test("refuses values sent as a string, naming the type it got", async () => {
    await withTempDir(async (root) => {
      const tool = createRunCommandTool(new Map([["test", "bun test {{files}}"]]), {
        commandCwd: root,
        runDeclaredCommand: neverRun,
      });
      const result = await tool.run({ command: "test", values: "a.test.ts" }, ctx(root));
      expect(result.isError).toBe(true);
      expect(result.content).toStartWith('"values" must be an object mapping placeholder names to values');
      expect(result.content).toContain("got a string instead");
    });
  });
});
