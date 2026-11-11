import { afterAll, describe, expect, test } from "bun:test";
import type { ToolCallRecord } from "#src/tools/index";
import { compileToolPolicy, createCodingToolRuntime } from "#src/tools/index";
import { cleanupTempDir, makeTempDir } from "#test/helpers/index";

/** Spill target for a cut result, so the policy does not try to write outside the sandbox. */
const ROOT = makeTempDir("nax-audit-elision-");

afterAll(() => cleanupTempDir(ROOT));

function runtimeWith(result: { content: string; resultBytesPreTruncation?: number }, root = ROOT) {
  const calls: ToolCallRecord[] = [];
  const runtime = createCodingToolRuntime({
    policy: compileToolPolicy([{ tool: "probe__t", patterns: ["*"] }], root),
    sink: { record: (entry) => calls.push(entry), flush: async () => {} },
    providerIdByTool: new Map([["probe__t", "probe"]]),
    extraTools: [
      {
        name: "probe__t",
        description: "d",
        inputSchema: { type: "object" },
        scope: { pathFields: [] },
        run: async () => result,
      },
    ],
  });
  return { runtime, calls };
}

/** A body the line-count cap cuts but the byte cap does not: 1 200 short lines, ~11 KB. */
const MANY_SHORT_LINES = Array.from({ length: 1_200 }, (_, i) => `line ${i}`).join("\n");

describe("ToolCallRecord.resultBytesPreTruncation", () => {
  test("is recorded when the tool reports it", async () => {
    const { runtime, calls } = runtimeWith({ content: "short", resultBytesPreTruncation: 2_000_000 });
    runtime.advertised(["probe__t"]);
    await runtime.callTool("probe__t", {});
    expect(calls[0]?.resultBytesPreTruncation).toBe(2_000_000);
    expect(calls[0]?.resultBytes).toBe(5);
    expect(calls[0]?.provider).toBe("probe");
  });

  test("is absent when the tool does not report it", async () => {
    const { runtime, calls } = runtimeWith({ content: "short" });
    runtime.advertised(["probe__t"]);
    await runtime.callTool("probe__t", {});
    expect(calls[0]).not.toHaveProperty("resultBytesPreTruncation");
  });
});

describe("ToolCallRecord.truncated", () => {
  test("is recorded when the line-count cap cut the result, though its size is under the byte cap", async () => {
    const { runtime, calls } = runtimeWith({ content: MANY_SHORT_LINES });
    runtime.advertised(["probe__t"]);
    await runtime.callTool("probe__t", {});
    // The size alone cannot say the model saw half the body: the delivered
    // result is well under MODEL_MAX_BYTES.
    expect(calls[0]?.resultBytes).toBeLessThan(40_000);
    expect(calls[0]?.truncated).toBe(true);
  });

  test("records false when the policy left the result whole — the row states completeness, it does not imply it", async () => {
    const { runtime, calls } = runtimeWith({ content: "short" });
    runtime.advertised(["probe__t"]);
    await runtime.callTool("probe__t", {});
    expect(calls[0]?.truncated).toBe(false);
  });

  test("is recorded on the deferred path, where the caller shapes the result", async () => {
    const { runtime, calls } = runtimeWith({ content: "short" });
    runtime.advertised(["probe__t"]);
    const outcome = await runtime.callTool("probe__t", {}, { deferModelTruncation: true });
    expect(calls).toHaveLength(0);
    if (outcome.kind === "denied") throw new Error("unexpected denial");
    // What the native `after_tool` handler does: shape, then settle the audit.
    outcome.finalizeAudit?.(`${"short"}\n... [truncated]`);
    expect(calls[0]?.truncated).toBe(true);
  });

  test("records false on the deferred path when the delivered content is the tool's own", async () => {
    const { runtime, calls } = runtimeWith({ content: "short" });
    runtime.advertised(["probe__t"]);
    const outcome = await runtime.callTool("probe__t", {}, { deferModelTruncation: true });
    if (outcome.kind === "denied") throw new Error("unexpected denial");
    outcome.finalizeAudit?.("short");
    expect(calls[0]?.truncated).toBe(false);
  });
});
