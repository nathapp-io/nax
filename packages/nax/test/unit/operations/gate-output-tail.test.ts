import { describe, expect, test } from "bun:test";
import { GATE_OUTPUT_TAIL_LINE_CHARS, GATE_OUTPUT_TAIL_LINES, gateOutputTail } from "@/operations/gate-output-tail";

describe("gateOutputTail", () => {
  test("AC-1: retains exactly lines 21 through 60", () => {
    const lines = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`);
    expect(GATE_OUTPUT_TAIL_LINES).toBe(40);
    expect(gateOutputTail(lines.join("\n"))).toBe(lines.slice(20).join("\n"));
  });

  test("AC-2: redacts GitHub tokens before bounding", () => {
    const token = `ghp_${"a".repeat(36)}`;
    const tail = gateOutputTail(`failure: ${token}`);
    expect(tail).toContain("failure:");
    expect(tail).not.toContain(token);
    expect(tail).not.toContain("ghp_");
    expect(gateOutputTail(`${"x".repeat(490)}${token}`)).not.toContain("ghp_");
  });

  test.each(["", "  \n\n", "\t\r\n "])("AC-3: blank output %j returns empty text", (output) => {
    expect(gateOutputTail(output)).toBe("");
  });

  test("AC-4: bounds an 800-character line to 500 characters plus ellipsis", () => {
    expect(GATE_OUTPUT_TAIL_LINE_CHARS).toBe(500);
    expect(gateOutputTail("x".repeat(800))).toBe(`${"x".repeat(500)}…`);
    expect(gateOutputTail("x".repeat(500))).toBe("x".repeat(500));
  });

  test("removes trailing blank lines before selecting the tail, preserving other whitespace", () => {
    const lines = Array.from({ length: 60 }, (_, i) => `  line ${i + 1}  `);
    expect(gateOutputTail(`${lines.join("\r\n")}\r\n  \r\n\t`)).toBe(lines.slice(20).join("\n"));
  });
});
