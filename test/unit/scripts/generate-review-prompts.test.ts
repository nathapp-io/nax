import { describe, expect, test } from "bun:test";
import { firstDifferingLine } from "@scripts/check-review-prompts-generated";
import {
  escapeForTemplateLiteral,
  extractFirstFencedBlock,
  generatePromptsFileContent,
  splitWorkerProtocol,
} from "@scripts/generate-review-prompts";

/** Unescapes exactly what `escapeForTemplateLiteral` escapes, for round-trip assertions. */
function unescapeTemplateLiteral(text: string): string {
  return text.replace(/\\(\\|`|\$\{)/g, (_match, group) => group);
}

describe("escapeForTemplateLiteral", () => {
  test("escapes a single backslash, backtick, and interpolation marker", () => {
    expect(escapeForTemplateLiteral("\\")).toBe("\\\\");
    expect(escapeForTemplateLiteral("`")).toBe("\\`");
    expect(escapeForTemplateLiteral("${x}")).toBe("\\${x}");
  });

  test("round-trips consecutive backslashes without double-escaping", () => {
    const source = "a\\\\b\\c";
    const escaped = escapeForTemplateLiteral(source);
    expect(unescapeTemplateLiteral(escaped)).toBe(source);
  });

  test("round-trips a backtick immediately followed by an interpolation marker", () => {
    const source = "inline `${code}` block";
    const escaped = escapeForTemplateLiteral(source);
    expect(unescapeTemplateLiteral(escaped)).toBe(source);
    // Confirms the single left-to-right pass doesn't let the backtick's own
    // escape re-trigger on the `${` it produces, or vice versa.
    expect(escaped).toBe("inline \\`\\${code}\\` block");
  });

  test("round-trips a backslash immediately preceding a backtick", () => {
    const source = "path\\`name`";
    const escaped = escapeForTemplateLiteral(source);
    expect(unescapeTemplateLiteral(escaped)).toBe(source);
  });

  test("leaves plain text with no special characters untouched", () => {
    expect(escapeForTemplateLiteral("plain text, no specials.")).toBe("plain text, no specials.");
  });
});

describe("splitWorkerProtocol", () => {
  test("splits mechanics from the output-format section at the heading", () => {
    const text = "mechanics prose\nmore mechanics\n## Output format\nformat prose\n";
    const { mechanics, outputFormatSection } = splitWorkerProtocol(text);
    expect(mechanics).toBe("mechanics prose\nmore mechanics\n");
    expect(outputFormatSection).toBe("## Output format\nformat prose\n");
  });

  test("throws when the Output format heading is missing", () => {
    expect(() => splitWorkerProtocol("just mechanics, no heading\n")).toThrow(/missing the "## Output format" heading/);
  });
});

describe("extractFirstFencedBlock", () => {
  test("extracts the first fenced block including its fences", () => {
    const text = "prose before\n```\nfenced content\n```\nprose after\n```\nsecond block\n```\n";
    expect(extractFirstFencedBlock(text)).toBe("```\nfenced content\n```");
  });

  test("throws when no fenced block is present", () => {
    expect(() => extractFirstFencedBlock("no fences here\n")).toThrow(/No fenced block found/);
  });
});

describe("firstDifferingLine", () => {
  test("returns null when the two strings are identical", () => {
    expect(firstDifferingLine("a\nb\nc", "a\nb\nc")).toBeNull();
  });

  test("reports the 1-indexed line and both sides when they diverge", () => {
    const result = firstDifferingLine("a\nb\nc", "a\nX\nc");
    expect(result).toEqual({ line: 2, expected: "b", actual: "X" });
  });

  test("reports <EOF> when actual is shorter than expected", () => {
    const result = firstDifferingLine("a\nb\nc", "a\nb");
    expect(result).toEqual({ line: 3, expected: "c", actual: "<EOF>" });
  });

  test("reports <EOF> when actual has extra trailing lines", () => {
    const result = firstDifferingLine("a\nb", "a\nb\nc");
    expect(result).toEqual({ line: 3, expected: "<EOF>", actual: "c" });
  });
});

describe("generatePromptsFileContent", () => {
  test("regenerates content matching the committed prompts.gen.ts", async () => {
    const generated = await generatePromptsFileContent();
    const committed = await Bun.file(new URL("../../../src/finish/review/prompts.gen.ts", import.meta.url)).text();
    expect(generated).toBe(committed);
  });
});
