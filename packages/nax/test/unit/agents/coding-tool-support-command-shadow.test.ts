/**
 * P5 threading: resolveCodingToolSupport forwards `commandShadow` into the
 * runtime's tap, mirroring the askResolver forwarding test. Its own file
 * because coding-tool-support.test.ts is at the 800-line test limit.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { CommandShadow } from "@nathapp/nax-agent";
import { _launcherDeps, _resetSandboxRegistryForTests } from "@nathapp/nax-agent/internal";
import { cleanupTempDir, makeNaxConfig, makeTempDir, withDepsRestore } from "@test/helpers";
import { resolveCodingToolSupport } from "@/agents/coding-tool-support-resolve";

// Keep the sandbox registry isolated from other dispatch tests.
afterEach(() => {
  _resetSandboxRegistryForTests();
});

describe("resolveCodingToolSupport — commandShadow (P5 threading)", () => {
  withDepsRestore(_launcherDeps);
  beforeEach(() => {
    _launcherDeps.runArgv = async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false });
  });

  // This is a dispatch/tap wiring test, not an OS sandbox availability test.
  test("forwards a commandShadow from options into the runtime's tap", async () => {
    const root = makeTempDir("nax-shadow-thread-");
    try {
      const observed: string[] = [];
      const commandShadow: CommandShadow = {
        observe: (_k, o) => void observed.push(o.command),
        settle: () => {},
        drain: async () => {},
      };
      const support = await resolveCodingToolSupport({
        declaredTools: ["Bash", "Write"],
        codingToolRoot: root,
        pipelineStage: "run",
        config: makeNaxConfig({
          execution: {
            bashApproval: "raw",
            sandbox: { enabled: false },
            permissions: { run: { allowedTools: ["Bash(echo *)"] } },
          },
        }),
        commandShadow,
      });
      expect(support).toBeDefined();
      const outcome = await support?.runtime.callTool("Bash", { command: "echo threaded" });
      expect(outcome?.kind).toBe("ok");
      expect(observed).toEqual(["echo threaded"]);
    } finally {
      cleanupTempDir(root);
    }
  });
});
