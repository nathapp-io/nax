import { describe, expect, test } from "bun:test";
import { parseTypecheckTextBlocks, typecheckTextBlockStrategy } from "@/review/typecheck-parsing/strategies/text-block";

describe("parseTypecheckTextBlocks", () => {
  test("returns null for empty or whitespace-only output", () => {
    expect(parseTypecheckTextBlocks("")).toBeNull();
    expect(parseTypecheckTextBlocks("   \n\t  ")).toBeNull();
  });

  test("returns null when no line looks like a supported source path", () => {
    const output = "some unrelated build output\nnothing to see here";

    expect(parseTypecheckTextBlocks(output)).toBeNull();
  });

  test("parses a single block with a line:column location", () => {
    const output = ["src/foo.ts:12:5", "  Type 'string' is not assignable to type 'number'."].join("\n");

    const result = parseTypecheckTextBlocks(output);

    expect(result).not.toBeNull();
    expect(result?.format).toBe("text-block");
    expect(result?.diagnostics).toHaveLength(1);
    const [diagnostic] = result?.diagnostics ?? [];
    expect(diagnostic?.file).toBe("src/foo.ts");
    expect(diagnostic?.line).toBe(12);
    expect(diagnostic?.column).toBe(5);
    expect(diagnostic?.message).toBe("src/foo.ts:12:5");
    expect(diagnostic?.raw).toContain("Type 'string' is not assignable");
  });

  test("parses a location with only a line number, no column", () => {
    const output = "src/bar.py:42\nsome error detail";

    const result = parseTypecheckTextBlocks(output);

    expect(result?.diagnostics[0]?.line).toBe(42);
    expect(result?.diagnostics[0]?.column).toBeUndefined();
  });

  test("collects multiple blocks, one per recognized source path line", () => {
    const output = ["src/foo.ts:1:1", "  first error detail", "src/bar.go:2:2", "  second error detail"].join("\n");

    const result = parseTypecheckTextBlocks(output);

    expect(result?.diagnostics).toHaveLength(2);
    expect(result?.diagnostics[0]?.file).toBe("src/foo.ts");
    expect(result?.diagnostics[1]?.file).toBe("src/bar.go");
  });

  test("strips trailing summary lines like 'Found N errors' from a block", () => {
    const output = ["src/foo.ts:1:1", "  something broke", "", "Found 1 error."].join("\n");

    const result = parseTypecheckTextBlocks(output);

    expect(result?.diagnostics).toHaveLength(1);
    expect(result?.diagnostics[0]?.raw).not.toContain("Found 1 error");
    expect(result?.diagnostics[0]?.raw).toContain("something broke");
  });

  test("strips a lone trailing summary line, keeping the path line itself", () => {
    const output = ["src/foo.ts:1:1", "Checked 3 files."].join("\n");

    const result = parseTypecheckTextBlocks(output);

    expect(result?.diagnostics).toHaveLength(1);
    expect(result?.diagnostics[0]?.raw).toBe("src/foo.ts:1:1");
  });

  test("ignores unrecognized extensions when scanning for a source path", () => {
    const output = "README.md: not a source file\nsrc/foo.ts:1:1\nreal error here";

    const result = parseTypecheckTextBlocks(output);

    expect(result?.diagnostics).toHaveLength(1);
    expect(result?.diagnostics[0]?.file).toBe("src/foo.ts");
  });

  test("the exported strategy object delegates to parseTypecheckTextBlocks", () => {
    expect(typecheckTextBlockStrategy.name).toBe("text-block");
    const output = "src/foo.ts:1:1\nerror detail";

    expect(typecheckTextBlockStrategy.parse(output)).toEqual(parseTypecheckTextBlocks(output));
  });
});
