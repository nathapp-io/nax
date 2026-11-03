import { describe, expect, test } from "bun:test";
import { buildMemoryReferenceSection, buildMemorySection, memoryReferenceSectionOf, memorySectionOf } from "@/prompts";

const INDEX = "# Memory\n- [project] a — b";

describe("buildMemorySection", () => {
  test("AC-4: starts with the ## Memory heading", () => {
    expect(buildMemorySection(INDEX)).toStartWith("## Memory");
  });

  test("AC-5: names the get and search tools", () => {
    const text = buildMemorySection(INDEX);
    expect(text).toContain("nax-memory__get");
    expect(text).toContain("nax-memory__search");
  });

  test("AC-6: ends with the index verbatim", () => {
    expect(buildMemorySection(INDEX)).toEndWith(INDEX);
  });

  test("keeps the index untouched, including its own heading", () => {
    expect(buildMemorySection(INDEX)).toBe(
      `## Memory\n\nRead a note with nax-memory__get and find more with nax-memory__search.\n\n${INDEX}`,
    );
  });
});

/**
 * US-002 — the read-only memory section: the index as background, for a workflow
 * session without the memory tools (the whole-branch reviewer). The note says so
 * in words, because a session told only "read a note with nax-memory__get" would
 * try the tool it does not have.
 */
describe("buildMemoryReferenceSection (US-002)", () => {
  test("AC-1: is the heading, the read-only note, then the index", () => {
    expect(buildMemoryReferenceSection("- [project] a — b")).toBe(
      "## Memory\n\nNotes earlier sessions saved for this project, one line each. Use them as background; you cannot read or change them in this session.\n\n- [project] a — b",
    );
  });

  test("AC-17: names no memory tool, because the session has none", () => {
    const text = buildMemoryReferenceSection("- [project] a — b");
    expect(text).not.toContain("nax-memory__");
  });

  test("keeps the index verbatim, its own heading included", () => {
    expect(buildMemoryReferenceSection(INDEX)).toEndWith(INDEX);
  });
});

describe("memoryReferenceSectionOf (US-002)", () => {
  test("AC-2: undefined (no index) has no section", () => {
    expect(memoryReferenceSectionOf(undefined)).toBeUndefined();
  });

  test("AC-3: an empty index has no section", () => {
    expect(memoryReferenceSectionOf("")).toBeUndefined();
  });

  test("an index renders the read-only section, not the tool section", () => {
    const text = memoryReferenceSectionOf("INDEX-LINE");
    expect(text).toBe(buildMemoryReferenceSection("INDEX-LINE"));
    expect(text).not.toContain("nax-memory__get");
  });
});

describe("memorySectionOf (US-002)", () => {
  test("an index renders the tool section", () => {
    expect(memorySectionOf("INDEX-LINE")).toBe(buildMemorySection("INDEX-LINE"));
    expect(memorySectionOf("INDEX-LINE")).toContain("nax-memory__get");
  });

  test("undefined and empty have no section", () => {
    expect(memorySectionOf(undefined)).toBeUndefined();
    expect(memorySectionOf("")).toBeUndefined();
  });
});

describe("the memory builders are public (US-002)", () => {
  test("AC-4: all three are importable from @/prompts and are functions", () => {
    for (const fn of [buildMemoryReferenceSection, memoryReferenceSectionOf, memorySectionOf]) {
      expect(typeof fn).toBe("function");
    }
  });
});
