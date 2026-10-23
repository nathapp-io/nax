import { describe, expect, test } from "bun:test";
import { BUN_CHECK_SAMPLE } from "@test/fixtures/bun-check";
import { makeNaxConfig, makeTestRuntime } from "@test/helpers";
import type { ConfigSelector } from "@/config";
import { typecheckCheckOp } from "@/operations";
import { parseTypecheckOutput } from "@/review/typecheck-parsing";

describe("typecheckCheckOp real parser seam", () => {
  test("AC-21/22 returns a located finding for a failed bun check", async () => {
    const config = makeNaxConfig({ quality: { commands: { typecheck: "bun check" } } });
    const runtime = makeTestRuntime({ config });
    try {
      const result = await typecheckCheckOp.execute(
        { workdir: "/repo", storyId: "US-005" },
        {
          runtime,
          packageDir: "/repo",
          storyId: "US-005",
          agentName: "native",
          packageView: {
            packageDir: ".",
            relativeFromRoot: ".",
            repoRoot: "/repo",
            hasOverride: false,
            config,
            select: <C>(selector: ConfigSelector<C>): C => selector.select(config),
          },
        },
        {
          parseTypecheckOutput,
          runQualityCommand: async () => ({
            commandName: "typecheck",
            command: "bun check",
            success: false,
            exitCode: 1,
            output: BUN_CHECK_SAMPLE,
            durationMs: 1,
            timedOut: false,
          }),
        },
      );
      expect(result.success).toBe(false);
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]?.file).toBe("test/unit/forge-tools/log-tool.test.ts");
      expect(result.findings[0]?.line).toBe(90);
      expect(result.findings[0]?.tool).toBe("bun check");
    } finally {
      await runtime.close();
    }
  });
});
