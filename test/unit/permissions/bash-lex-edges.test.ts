/**
 * bash-lex.ts — characterisation tests for lexBashCommand branches the mirror
 * suite leaves unpinned (separator values, whitespace classes, redirect-order
 * and prefix contracts, quoted/escaped special characters), written before the
 * complexity drain refactor (docs/plans/STATUS-complexity-drain.md, batch C3).
 * Every assertion below is green against the unrefactored lexer; the lexer
 * feeds the permission decision, so each quirk is pinned as-is, not fixed.
 */

import { describe, expect, test } from "bun:test";
import { type BashSegment, type BashSegmentSeparator, lexBashCommand } from "@/permissions";

function segmentsOf(command: string): readonly BashSegment[] {
  const result = lexBashCommand(command);
  if (result.kind !== "ok") throw new Error(`expected ok, got refused: ${result.construct}`);
  return result.segments;
}

function refused(command: string): { construct: string; prefix: readonly BashSegment[] } {
  const result = lexBashCommand(command);
  if (result.kind !== "refused") throw new Error(`expected refused, got ${result.kind}`);
  return { construct: result.construct, prefix: result.prefix };
}

describe("lexBashCommand whitespace classes", () => {
  test("a tab splits words like a space", () => {
    expect(segmentsOf("bun\ttest").map((s) => s.tokens.map((t) => t.text))).toEqual([["bun", "test"]]);
  });

  test("a carriage return splits words like a space", () => {
    expect(segmentsOf("a\rb c").map((s) => s.tokens.map((t) => t.text))).toEqual([["a", "b", "c"]]);
  });
});

describe("lexBashCommand quoting", () => {
  test("a double-quoted word without $ stays analysable (not opaque)", () => {
    const [segment] = segmentsOf('echo "hello world"');
    expect(segment?.tokens).toEqual([
      { text: "echo", opaque: false },
      { text: "hello world", opaque: false },
    ]);
  });

  test("a backtick inside double quotes is refused by name", () => {
    expect(refused('echo "`whoami`"').construct).toBe("a backtick command substitution");
  });

  test("an empty quoted string yields an empty, non-opaque token", () => {
    const [segment] = segmentsOf("echo '' x");
    expect(segment?.tokens).toEqual([
      { text: "echo", opaque: false },
      { text: "", opaque: false },
      { text: "x", opaque: false },
    ]);
  });

  test("an escaped dollar is a literal, non-opaque part of the word", () => {
    const [segment] = segmentsOf("grep \\$HOME x");
    expect(segment?.tokens).toEqual([
      { text: "grep", opaque: false },
      { text: "$HOME", opaque: false },
      { text: "x", opaque: false },
    ]);
  });

  test("an escaped dollar followed by ( still refuses at the paren", () => {
    expect(refused("echo \\$(whoami)").construct).toBe("a subshell `( ... )`");
  });
});

describe("lexBashCommand refusals the mirror only pins one arm of", () => {
  test(">(...) process substitution is refused", () => {
    expect(refused("tee >(cat)").construct).toBe("a process substitution `<(...)` / `>(...)`");
  });

  test("<& file-descriptor duplication is refused", () => {
    expect(refused("cat <&2").construct).toBe("file-descriptor duplication (`2>&1`)");
  });

  test("a trailing background & refuses as an empty command segment", () => {
    expect(refused("bun test &").construct).toBe("an empty command segment");
  });

  test("an empty segment between two separators refuses, keeping the completed one", () => {
    const { construct, prefix } = refused("bun test ;;");
    expect(construct).toBe("an empty command segment");
    expect(prefix).toHaveLength(1);
    expect(prefix[0]?.tokens.map((t) => t.text)).toEqual(["bun", "test"]);
    expect(prefix[0]?.separator).toBe(";");
  });
});

describe("lexBashCommand separators and redirections", () => {
  const separatorCases: readonly (readonly [BashSegmentSeparator, string])[] = [
    [";", "a ; b"],
    ["&&", "a && b"],
    ["||", "a || b"],
    ["|", "a | b"],
    ["&", "a & b"],
    [";", "a\nb"],
  ];
  test.each(separatorCases)(
    "a %s boundary is recorded as the interrupted segment's separator",
    (separator, command) => {
      const segments = segmentsOf(`${command} c`);
      expect(segments[0]?.separator).toBe(separator);
    },
  );

  test("the final segment carries no separator", () => {
    const segments = segmentsOf("a && b");
    expect(segments).toHaveLength(2);
    expect(segments[1]?.separator).toBeUndefined();
  });

  test("a bare fd digit attaches to the >> append operator too", () => {
    const [segment] = segmentsOf("bun test 2>>err.txt");
    expect(segment?.tokens.map((t) => t.text)).toEqual(["bun", "test"]);
    expect(segment?.redirects).toEqual([{ operator: ">>", target: "err.txt", opaque: false }]);
  });

  test("multiple redirects in one segment keep their order", () => {
    const [segment] = segmentsOf("bun test > a.txt < b.txt");
    expect(segment?.redirects).toEqual([
      { operator: ">", target: "a.txt", opaque: false },
      { operator: "<", target: "b.txt", opaque: false },
    ]);
  });
});

describe("lexBashCommand refused-prefix contracts beyond US-001", () => {
  test("a refusal after a completed redirect keeps that redirect in the prefix", () => {
    const { prefix } = refused("bun test > out.txt 2>&1");
    expect(prefix).toHaveLength(1);
    expect(prefix[0]?.tokens.map((t) => t.text)).toEqual(["bun", "test"]);
    expect(prefix[0]?.redirects).toEqual([{ operator: ">", target: "out.txt", opaque: false }]);
  });

  test("a redirect operator still awaiting its target is dropped from the prefix", () => {
    const { prefix } = refused("bun test > <<EOF");
    expect(prefix).toHaveLength(1);
    expect(prefix[0]?.tokens.map((t) => t.text)).toEqual(["bun", "test"]);
    expect(prefix[0]?.redirects).toEqual([]);
  });
});
