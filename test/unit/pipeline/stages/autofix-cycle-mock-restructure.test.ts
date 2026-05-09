/**
 * Unit tests for autofix-cycle mock-restructure handoff wiring.
 *
 * Covers:
 * - buildAutofixStrategies testWriter buildInput consumes pendingMockStructureHandoffs
 * - Deduplication of files across handoffs
 * - Joining of reasonDetail paragraphs
 * - Side-channel clearing
 */

import { describe, expect, test } from "bun:test";
import { buildAutofixStrategies } from "../../../../src/pipeline/stages/autofix-cycle";
import type { PipelineContext } from "../../../../src/pipeline/types";
import { makeNaxConfig, makeStory, makeMockAgentManager } from "../../../helpers";

// biome-ignore lint/suspicious/noExplicitAny: test fixture construction
function makeCtx(overrides?: Partial<PipelineContext>): PipelineContext {
  // biome-ignore lint/suspicious/noExplicitAny: test fixture
  return {
    story: makeStory(),
    config: makeNaxConfig(),
    reviewResult: { success: false, checks: [], totalDurationMs: 0 },
    workdir: "/tmp",
    runtime: {
      packages: { repo: () => ({}) },
      outputDir: "/tmp/out",
    },
    prd: { feature: "f" },
    agentManager: makeMockAgentManager(),
    pendingMockStructureHandoffs: undefined,
    ...overrides,
  } as any;
}

describe("buildAutofixStrategies — testWriter buildInput with mock-restructure", () => {
  test("consumes pendingMockStructureHandoffs when non-empty and returns mock-restructure mode", () => {
    const handoffs = [
      { files: ["test/foo.test.ts"], reasonDetail: "Dispatch shape mismatch in foo" },
    ];
    const ctx = makeCtx({ pendingMockStructureHandoffs: handoffs });

    // biome-ignore lint/suspicious/noExplicitAny: heterogeneous strategy array type
    const strategies = buildAutofixStrategies(ctx, 3);
    // biome-ignore lint/suspicious/noExplicitAny: heterogeneous strategy array type
    const testWriter = strategies.find((s: any) => s.name === "autofix-test-writer");
    expect(testWriter).toBeDefined();

    // biome-ignore lint/suspicious/noExplicitAny: test context
    const input = testWriter!.buildInput([], undefined, {} as any);

    expect(input.mode).toBe("mock-restructure");
  });

  test("sets handoffFiles to deduplicated union of all files across handoffs", () => {
    const handoffs = [
      { files: ["test/a.test.ts", "test/b.test.ts"], reasonDetail: "First handoff" },
      { files: ["test/b.test.ts", "test/c.test.ts"], reasonDetail: "Second handoff" },
    ];
    const ctx = makeCtx({ pendingMockStructureHandoffs: handoffs });

    const strategies = buildAutofixStrategies(ctx, 3);
    // biome-ignore lint/suspicious/noExplicitAny: heterogeneous strategy array type
    const testWriter = strategies.find((s: any) => s.name === "autofix-test-writer");

    // biome-ignore lint/suspicious/noExplicitAny: test context
    const input = testWriter!.buildInput([], undefined, {} as any);

    expect(input.handoffFiles).toBeDefined();
    expect(input.handoffFiles?.sort()).toEqual(["test/a.test.ts", "test/b.test.ts", "test/c.test.ts"].sort());
  });

  test("joins reasonDetail paragraphs with \\n\\n---\\n\\n separator", () => {
    const handoffs = [
      { files: ["test/foo.test.ts"], reasonDetail: "First reason paragraph" },
      { files: ["test/bar.test.ts"], reasonDetail: "Second reason paragraph" },
      { files: ["test/baz.test.ts"], reasonDetail: "Third reason paragraph" },
    ];
    const ctx = makeCtx({ pendingMockStructureHandoffs: handoffs });

    const strategies = buildAutofixStrategies(ctx, 3);
    // biome-ignore lint/suspicious/noExplicitAny: heterogeneous strategy array type
    const testWriter = strategies.find((s: any) => s.name === "autofix-test-writer");

    // biome-ignore lint/suspicious/noExplicitAny: test context
    const input = testWriter!.buildInput([], undefined, {} as any);

    expect(input.handoffReason).toBe(
      "First reason paragraph\n\n---\n\nSecond reason paragraph\n\n---\n\nThird reason paragraph",
    );
  });

  test("clears the side-channel (sets to empty array) after consuming handoffs", () => {
    const handoffs = [
      { files: ["test/demo.test.ts"], reasonDetail: "Demo reason" },
    ];
    const ctx = makeCtx({ pendingMockStructureHandoffs: [...handoffs] });

    const strategies = buildAutofixStrategies(ctx, 3);
    // biome-ignore lint/suspicious/noExplicitAny: heterogeneous strategy array type
    const testWriter = strategies.find((s: any) => s.name === "autofix-test-writer");

    // Call buildInput to consume the handoff
    // biome-ignore lint/suspicious/noExplicitAny: test context
    testWriter!.buildInput([], undefined, {} as any);

    // Side-channel must be cleared
    expect(ctx.pendingMockStructureHandoffs).toEqual([]);
  });

  test("returns existing shape when pendingMockStructureHandoffs is undefined", () => {
    const ctx = makeCtx({ pendingMockStructureHandoffs: undefined });
    ctx.reviewResult = { success: false, checks: [] };

    const strategies = buildAutofixStrategies(ctx, 3);
    // biome-ignore lint/suspicious/noExplicitAny: heterogeneous strategy array type
    const testWriter = strategies.find((s: any) => s.name === "autofix-test-writer");

    // biome-ignore lint/suspicious/noExplicitAny: test context
    const input = testWriter!.buildInput([], undefined, {} as any);

    // Should not be mock-restructure mode
    expect(input.mode).not.toBe("mock-restructure");
  });

  test("returns existing shape when pendingMockStructureHandoffs is empty array", () => {
    const ctx = makeCtx({ pendingMockStructureHandoffs: [] });
    ctx.reviewResult = { success: false, checks: [] };

    const strategies = buildAutofixStrategies(ctx, 3);
    // biome-ignore lint/suspicious/noExplicitAny: heterogeneous strategy array type
    const testWriter = strategies.find((s: any) => s.name === "autofix-test-writer");

    // biome-ignore lint/suspicious/noExplicitAny: test context
    const input = testWriter!.buildInput([], undefined, {} as any);

    // Should not be mock-restructure mode
    expect(input.mode).not.toBe("mock-restructure");
  });

  test("deduplicates files with multiple occurrences across handoffs", () => {
    const handoffs = [
      { files: ["test/x.test.ts", "test/y.test.ts", "test/x.test.ts"], reasonDetail: "First" },
      { files: ["test/y.test.ts", "test/z.test.ts"], reasonDetail: "Second" },
    ];
    const ctx = makeCtx({ pendingMockStructureHandoffs: handoffs });

    const strategies = buildAutofixStrategies(ctx, 3);
    // biome-ignore lint/suspicious/noExplicitAny: heterogeneous strategy array type
    const testWriter = strategies.find((s: any) => s.name === "autofix-test-writer");

    // biome-ignore lint/suspicious/noExplicitAny: test context
    const input = testWriter!.buildInput([], undefined, {} as any);

    // Should have exactly 3 unique files
    const files = input.handoffFiles ?? [];
    expect(new Set(files).size).toBe(3);
    expect(files.sort()).toEqual(["test/x.test.ts", "test/y.test.ts", "test/z.test.ts"].sort());
  });

  test("handles empty handoff list correctly", () => {
    const handoffs: { files: string[]; reasonDetail: string }[] = [];
    const ctx = makeCtx({ pendingMockStructureHandoffs: handoffs });

    const strategies = buildAutofixStrategies(ctx, 3);
    // biome-ignore lint/suspicious/noExplicitAny: heterogeneous strategy array type
    const testWriter = strategies.find((s: any) => s.name === "autofix-test-writer");

    // biome-ignore lint/suspicious/noExplicitAny: test context
    const input = testWriter!.buildInput([], undefined, {} as any);

    // Empty handoff list should not trigger mock-restructure mode
    expect(input.mode).not.toBe("mock-restructure");
  });

  test("single handoff with one file is properly processed", () => {
    const handoffs = [
      { files: ["test/single.test.ts"], reasonDetail: "Single file reason" },
    ];
    const ctx = makeCtx({ pendingMockStructureHandoffs: handoffs });

    const strategies = buildAutofixStrategies(ctx, 3);
    // biome-ignore lint/suspicious/noExplicitAny: heterogeneous strategy array type
    const testWriter = strategies.find((s: any) => s.name === "autofix-test-writer");

    // biome-ignore lint/suspicious/noExplicitAny: test context
    const input = testWriter!.buildInput([], undefined, {} as any);

    expect(input.mode).toBe("mock-restructure");
    expect(input.handoffFiles).toEqual(["test/single.test.ts"]);
    expect(input.handoffReason).toBe("Single file reason");
  });
});
