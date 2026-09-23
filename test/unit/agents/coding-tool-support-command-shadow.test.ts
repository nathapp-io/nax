/**
 * P5 threading: resolveCodingToolSupport forwards `commandShadow` into the
 * runtime's tap, mirroring the askResolver forwarding test. Its own file
 * because coding-tool-support.test.ts is at the 800-line test limit.
 */
import { describe, expect, test } from "bun:test";
import { cleanupTempDir, makeNaxConfig, makeTempDir } from "@test/helpers";
import { resolveCodingToolSupport } from "@/agents/coding-tool-support";
import type { CommandShadow } from "@/command-safety";

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
      const support = await resolveCodingToolSupport({
        declaredTools: ["Bash"],
        codingToolRoot: root,
        pipelineStage: "run",
        config: makeNaxConfig({ execution: { bashApproval: "raw" } }),
        commandShadow,
      });
      await support?.runtime.callTool("Bash", { command: "echo threaded" });
      expect(observed).toEqual(["echo threaded"]);
    } finally {
      cleanupTempDir(root);
    }
  });
});
