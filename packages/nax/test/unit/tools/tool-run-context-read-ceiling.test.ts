/**
 * US-003 — ToolRunContext default readCeiling (AC10).
 *
 * When `ctx.readCeiling` is absent, a tool bounds its reads at
 * `READ_CEILING` (2_000_000), NOT at `ctx.maxBytes` (40_000). The two
 * ceilings answer different questions — maxBytes is the model-facing cap
 * owned by `after_tool`; readCeiling is the tool-layer I/O bound that lets
 * a tool return up to a full file's worth of content before the session
 * truncates it.
 *
 * The boundary companion pins the discrimination: readCeiling is much
 * larger than maxBytes, so a body in (maxBytes, readCeiling) is bounded
 * by maxBytes at the session layer but NOT at the tool layer.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { compileToolPolicy, createCodingToolRuntime, MODEL_MAX_BYTES, READ_CEILING } from "@/tools";

let root: string;

beforeEach(() => {
  root = makeTempDir("nax-read-ceiling-");
});

afterEach(() => {
  cleanupTempDir(root);
});

/** A stub Read tool that returns whatever body the test wants. */
function stubRead(body: string, captureCtx?: { readCeiling?: number; maxBytes?: number }) {
  return {
    name: "Read",
    description: "stub",
    inputSchema: { type: "object" },
    scope: { pathFields: ["path"] },
    async run(
      _input: Record<string, unknown>,
      ctx: {
        readCeiling?: number;
        maxBytes: number;
        maxFileBytes: number;
        root: string;
        resolvedPaths: readonly string[];
      },
    ) {
      if (captureCtx !== undefined) {
        captureCtx.readCeiling = ctx.readCeiling;
        captureCtx.maxBytes = ctx.maxBytes;
      }
      return { content: body };
    },
  };
}

describe("AC10: when a ToolRunContext omits readCeiling, then a tool bounds its read at READ_CEILING rather than maxBytes", () => {
  test("a ToolRunContext without readCeiling still receives readCeiling === READ_CEILING at the tool layer", async () => {
    const captured: { readCeiling?: number; maxBytes?: number } = {};
    // Tool layer bounds at READ_CEILING: a body in (MODEL_MAX_BYTES,
    // READ_CEILING) is returned whole by the tool — the runtime's after_tool
    // handler is what enforces the smaller MODEL_MAX_BYTES cap.
    const body = "x".repeat(MODEL_MAX_BYTES + 10_000);
    const rt = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "Read", patterns: ["*"] }], root),
      maxBytes: MODEL_MAX_BYTES,
      // Deliberately NOT passing readCeiling — the test pins the default.
      extraTools: [stubRead(body, captured)],
    });
    rt.advertised(["Read"]);
    await rt.callTool("Read", { path: "anywhere" });

    // The ToolRunContext presented to the tool had readCeiling defaulting
    // to READ_CEILING. That's the seam AC10 pins.
    expect(captured.readCeiling).toBe(READ_CEILING);
  });

  test("a tool's I/O bound is readCeiling (not maxBytes) when readCeiling is absent", async () => {
    // The DISCRIMINATING assertion: readCeiling (2_000_000) is much larger
    // than maxBytes (40_000). A body of 100_000 bytes (between them) is
    // bounded by maxBytes at the model layer but the tool itself was told
    // it could return up to READ_CEILING bytes.
    const captured: { readCeiling?: number; maxBytes?: number } = {};
    const body = "x".repeat(100_000);
    const rt = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "Read", patterns: ["*"] }], root),
      maxBytes: MODEL_MAX_BYTES,
      extraTools: [stubRead(body, captured)],
    });
    rt.advertised(["Read"]);
    await rt.callTool("Read", { path: "anywhere" });

    // The two values are distinct: readCeiling is the tool's I/O bound,
    // maxBytes is the model-facing cap owned by after_tool.
    expect(captured.readCeiling).not.toBe(captured.maxBytes);
    expect(captured.readCeiling).toBe(READ_CEILING);
    expect(captured.maxBytes).toBe(MODEL_MAX_BYTES);
  });

  test("when readCeiling is supplied explicitly, the tool sees the supplied value, not the default", async () => {
    // The supplied-readCeiling companion: a caller passing readCeiling
    // through the runtime options pins the value the tool sees.
    const captured: { readCeiling?: number; maxBytes?: number } = {};
    const rt = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "Read", patterns: ["*"] }], root),
      maxBytes: MODEL_MAX_BYTES,
      readCeiling: 500_000, // explicitly less than READ_CEILING
      extraTools: [stubRead("body", captured)],
    });
    rt.advertised(["Read"]);
    await rt.callTool("Read", { path: "anywhere" });
    expect(captured.readCeiling).toBe(500_000);
  });

  test("AC4 companion: a Grep result in (MODEL_MAX_BYTES, READ_CEILING) is returned whole by the tool, then capped at MODEL_MAX_BYTES by the session", async () => {
    // The end-to-end check: a tool returning 100_000 bytes of content (well
    // under READ_CEILING = 2_000_000) is returned whole by the tool. The
    // runtime's after_tool handler is what caps it at MODEL_MAX_BYTES. The
    // assertion is on the runtime's outcome, not the tool's.
    const body = "x".repeat(100_000);
    const rt = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "Read", patterns: ["*"] }], root),
      maxBytes: MODEL_MAX_BYTES,
      extraTools: [stubRead(body)],
    });
    rt.advertised(["Read"]);
    const outcome = await rt.callTool("Read", { path: "anywhere" });
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") throw new Error("unreachable");
    // The tool returned the whole 100_000-byte body (within readCeiling).
    // The runtime's after_tool policy then shaped the result to fit
    // MODEL_MAX_BYTES.
    expect(Buffer.byteLength(outcome.content, "utf8")).toBeLessThanOrEqual(MODEL_MAX_BYTES);
    // And the tool DID see the readCeiling as the bound, not maxBytes.
    // (This is the AC10 invariant, asserted above through the captured
    // ctx; here we just check the integration — the body comes back
    // truncated to MODEL_MAX_BYTES, proving the model-facing cap and the
    // tool-facing cap are independent.)
  });
});
