/**
 * Quality command specs: a string is one command, a list is run-all.
 */

import { describe, expect, test } from "bun:test";
import {
  commandSpecIncludes,
  containsShellChain,
  normalizeCommandSpec,
  renderCommandSpec,
  replaceInCommandSpec,
} from "#src/internal/command-spec/index";

describe("normalizeCommandSpec", () => {
  test("an undefined spec is no commands", () => {
    expect(normalizeCommandSpec(undefined)).toEqual([]);
  });

  test("a string is one trimmed command", () => {
    expect(normalizeCommandSpec("  bun test  ")).toEqual(["bun test"]);
  });

  test("blank entries are dropped from a list", () => {
    expect(normalizeCommandSpec(["a", "  ", "", "b"])).toEqual(["a", "b"]);
  });
});

describe("containsShellChain", () => {
  test("is true when any entry chains with &&", () => {
    expect(containsShellChain(["lint", "build && test"])).toBe(true);
  });

  test("is false for a plain command, a list without a chain, and an undefined spec", () => {
    expect(containsShellChain("bun test")).toBe(false);
    expect(containsShellChain(["a", "b"])).toBe(false);
    expect(containsShellChain(undefined)).toBe(false);
  });
});

describe("commandSpecIncludes", () => {
  test("matches a literal fragment in any entry", () => {
    expect(commandSpecIncludes(["lint", "bun test --bail"], "--bail")).toBe(true);
    expect(commandSpecIncludes("lint", "--bail")).toBe(false);
    expect(commandSpecIncludes(undefined, "--bail")).toBe(false);
  });
});

describe("replaceInCommandSpec", () => {
  test("replaces every occurrence and keeps the string shape", () => {
    expect(replaceInCommandSpec("a X b X", "X", "y")).toBe("a y b y");
  });

  test("replaces in every entry and keeps the list shape", () => {
    expect(replaceInCommandSpec(["X one", "two X"], "X", "y")).toEqual(["y one", "two y"]);
  });

  test("inserts the replacement verbatim: $-patterns in a path are not expanded", () => {
    expect(replaceInCommandSpec("bun test {{files}}", "{{files}}", "'a$$b.ts' '$&.ts' '$`x' \"$'y\"")).toBe(
      "bun test 'a$$b.ts' '$&.ts' '$`x' \"$'y\"",
    );
  });
});

describe("renderCommandSpec", () => {
  test("joins the normalized entries with ' && '", () => {
    expect(renderCommandSpec(["a", "", "b"])).toBe("a && b");
  });

  test("renders a fully blank or undefined spec as undefined", () => {
    expect(renderCommandSpec(["", " "])).toBeUndefined();
    expect(renderCommandSpec(undefined)).toBeUndefined();
  });
});
