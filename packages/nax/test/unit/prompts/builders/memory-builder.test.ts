import { describe, expect, test } from "bun:test";
import { buildMemorySection } from "@/prompts";

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
