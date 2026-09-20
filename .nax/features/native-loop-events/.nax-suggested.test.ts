import { describe, expect, test } from "bun:test";
import { createLoopEventRegistry } from "@/agents/native/session/loop-events";
import { MODEL_MAX_BYTES, MODEL_MAX_LINE_CHARS, MODEL_MAX_LINES } from "@/tools/truncate";

describe("native loop events", () => {
  test("AC-1: For each migrated tool (Read, Grep, Git, Scratchpad, Bash), when a tool result's size is at or below the model cap defined in src/tools/truncate.ts, the returned result is byte-identical to the input payload and contains no truncation marker (e.g., no '[truncated]' sentinel or truncation notice string) in its output.", () => {
    // Exactly MODEL_MAX_BYTES UTF-8 bytes, while remaining within the line and
    // per-line caps. This exercises the inclusive boundary rather than merely
    // a small-result fast path.
    const lineCount = 20;
    const payload = [
      ...Array.from({ length: lineCount - 1 }, () => "x".repeat(MODEL_MAX_LINE_CHARS)),
      "x".repeat(MODEL_MAX_BYTES - (lineCount - 1) * MODEL_MAX_LINE_CHARS - (lineCount - 1)),
    ].join("\n");
    expect(Buffer.byteLength(payload, "utf8")).toBe(MODEL_MAX_BYTES);
    expect(payload.split("\n")).toHaveLength(lineCount);
    expect(lineCount).toBeLessThanOrEqual(MODEL_MAX_LINES);

    const events = createLoopEventRegistry();
    for (const toolName of ["Read", "Grep", "Git", "ScratchpadRead", "Bash"] as const) {
      const result = events.afterTool(
        { id: `${toolName}-within-cap`, name: toolName, input: {} },
        { content: payload, isError: false },
      );

      expect(Buffer.compare(Buffer.from(result.content, "utf8"), Buffer.from(payload, "utf8"))).toBe(0);
      expect(result.isError).toBe(false);
      expect(result.content).not.toContain("[truncated]");
      expect(result.content).not.toMatch(/truncated/i);
    }
  });
});