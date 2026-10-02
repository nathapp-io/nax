/**
 * RunCommand's declared-command runner port (S1 spec section 4.2, port 7): the
 * tool never imports nax's quality runner; the caller supplies one.
 */
import { describe, expect, test } from "bun:test";
import { withTempDir } from "@test/helpers";
import { createRunCommandTool, type DeclaredCommandRequest } from "@/tools/run-command";

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
