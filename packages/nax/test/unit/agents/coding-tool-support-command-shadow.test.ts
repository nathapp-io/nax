/**
 * P5 threading: resolveCodingToolSupport forwards `commandShadow` into the
 * runtime's tap, mirroring the askResolver forwarding test. Its own file
 * because coding-tool-support.test.ts is at the 800-line test limit.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { CommandShadow } from "@nathapp/nax-agent";
import { _resetSandboxRegistryForTests } from "@nathapp/nax-agent/internal";
import { cleanupTempDir, makeNaxConfig, makeTempDir } from "@test/helpers";
import { resolveCodingToolSupport } from "@/agents/coding-tool-support-resolve";

// The sandbox is on by default, so these tests build a real backend; the registry
// caches it per process, and it would leak into later files (e.g.
// test/unit/sandbox/registry.test.ts) without a reset.
afterEach(() => {
  _resetSandboxRegistryForTests();
});

describe("resolveCodingToolSupport — commandShadow (P5 threading)", () => {
  test("forwards a commandShadow from options into the runtime's tap", async () => {
    const root = makeTempDir("nax-shadow-thread-");
    try {
      const observed: string[] = [];
      const commandShadow: CommandShadow = {
        observe: (_k, o) => void observed.push(o.command),
        settle: () => {},
        drain: async () => {},
      };
      const execution: Record<string, unknown> = {
        bashApproval: "raw",
        permissionProfile: "scoped",
        permissions: { run: { allow: ["Bash(echo *)"] } },
        sandbox: { enabled: false },
      };
      const support = await resolveCodingToolSupport({
        declaredTools: ["Bash", "Write"],
        codingToolRoot: root,
        pipelineStage: "run",
        config: makeNaxConfig({ execution }),
        commandShadow,
      });
      expect(support?.tools.some((tool) => tool.name === "Bash")).toBe(true);
      await support?.runtime.callTool("Bash", { command: "echo threaded" });
      expect(observed).toEqual(["echo threaded"]);
    } finally {
      cleanupTempDir(root);
    }
  });
});
