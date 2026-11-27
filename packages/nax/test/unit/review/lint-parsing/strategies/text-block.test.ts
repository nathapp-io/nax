import { describe, expect, test } from "bun:test";
import { parseTextBlocks } from "@/review/lint-parsing/strategies/text-block";

describe("parseTextBlocks", () => {
  test.each(["src/two.ex", "src/two.ex:7", "src/two.ex:7:9: independent defect"])(
    "does not attribute %s to the previous file",
    (header) => {
      const result = parseTextBlocks(
        `src/one.go\n  first defect\n${header}\n  unrelated defect\nsrc/three.py\n  third defect`,
      );
      expect(result?.diagnostics).toHaveLength(2);
      expect(result?.diagnostics[0]?.file).toBe("src/one.go");
      expect(result?.diagnostics[0]?.message).toBe("first defect");
      expect(result?.diagnostics[0]?.raw).not.toContain("unrelated defect");
      expect(result?.diagnostics[1]?.file).toBe("src/three.py");
      expect(result?.diagnostics[1]?.message).toBe("third defect");
    },
  );
  test.each(["ts", "py", "go", "rs", "java"])("preserves the body under a %s path header", (ext) => {
    const result = parseTextBlocks(
      `/repo/src/example.${ext}\n  7:3 error: first diagnostic\n  9:1 warning: second diagnostic\n\n✖ 2 problems (1 error, 1 warning)\n`,
    );
    expect(result?.diagnostics[0]?.message).toBe("7:3 error: first diagnostic\n  9:1 warning: second diagnostic");
    expect(result?.diagnostics[0]?.raw).not.toContain("✖");
    expect(result?.diagnostics[0]?.file).toBe(`/repo/src/example.${ext}`);
    expect(result?.diagnostics[0]?.line).toBeUndefined();
  });

  test("preserves continuation details after a diagnostic header", () => {
    const output =
      "src/example.go:7:3: incompatible value\n  expected: Integer\n  found: String\n  help: convert the value";
    const result = parseTextBlocks(output);
    expect(result?.diagnostics[0]?.message).toBe(output);
    expect(result?.diagnostics[0]?.line).toBe(7);
    expect(result?.diagnostics[0]?.column).toBe(3);
  });

  test("preserves single-line diagnostics and path-only output", () => {
    for (const output of ["src/example.py:7:3: invalid value", "src/example.py"]) {
      expect(parseTextBlocks(output)?.diagnostics[0]?.message).toBe(output);
    }
  });
});
