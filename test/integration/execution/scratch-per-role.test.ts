import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  cleanupTempDir,
  DEFAULT_TEST_ROUTING,
  makeNaxConfig,
  makeTempDir,
  makeTestContext,
  makeTestStory,
} from "@test/helpers";
import { applyPostRunInspection } from "@/execution/post-run";
import { testWriterOp, verifierOp } from "@/operations";

describe("applyPostRunInspection — per-role scratch entries", () => {
  test("writes tdd-session entries for test-writer and verifier roles", async () => {
    const scratchDir = makeTempDir("scratch-per-role-");
    try {
      const ctx = makeTestContext({
        workdir: scratchDir,
        projectDir: scratchDir,
        story: makeTestStory({ id: "S1", title: "t" }),
        config: makeNaxConfig({ context: { v2: { enabled: true } } }),
        sessionScratchDir: scratchDir,
        routing: { ...DEFAULT_TEST_ROUTING, testStrategy: "three-session-tdd" },
      });

      const planResult = {
        success: true,
        phaseOutputs: {
          [testWriterOp.name]: { success: true, filesChanged: [], output: "test-writer output" },
          [verifierOp.name]: { success: true, filesChanged: [], output: "verifier output" },
        },
        phaseCosts: {},
        totalCostUsd: 0,
        durationMs: 0,
      };

      await applyPostRunInspection(ctx, planResult, {
        capturedResponse: "",
        capturedCostUsd: 0,
        tddMode: { isLite: false, rollbackEnabled: false },
        initialRef: null,
        untrackedBefore: null,
      });

      const scratchPath = join(scratchDir, "scratch.jsonl");
      const content = await Bun.file(scratchPath).text();
      const entries = content
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));

      const roles = entries.map((e: { role?: string }) => e.role);
      expect(roles).toContain("test-writer");
      expect(roles).toContain("verifier");

      const testWriterEntry = entries.find((e: { role?: string }) => e.role === "test-writer");
      expect(testWriterEntry?.kind).toBe("tdd-session");
      expect(testWriterEntry?.success).toBe(true);

      const verifierEntry = entries.find((e: { role?: string }) => e.role === "verifier");
      expect(verifierEntry?.kind).toBe("tdd-session");
      expect(verifierEntry?.success).toBe(true);
    } finally {
      cleanupTempDir(scratchDir);
    }
  });
});
