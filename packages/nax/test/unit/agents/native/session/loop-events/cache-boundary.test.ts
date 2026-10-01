import { describe, expect, test } from "bun:test";
import { checkPrefixStable } from "@/agents/native/session/loop-events/cache-boundary";

const m = (content: string) => ({ role: "user" as const, content });

describe("prefix stability checker", () => {
  test("an unchanged prefix passes", () => {
    const a = m("1"),
      b = m("2"),
      c = m("3");
    expect(checkPrefixStable([a, b, c], [a, b, c], 1)).toBe(true);
  });

  test("appending past the anchor passes", () => {
    const a = m("1"),
      b = m("2"),
      c = m("3");
    // Elements after the anchor are new and uncached, so rewriting them is free.
    expect(checkPrefixStable([a, b], [a, b, c], 1)).toBe(true);
  });

  test("replacing an element before the anchor fails", () => {
    const a = m("1"),
      b = m("2"),
      c = m("3");
    expect(checkPrefixStable([a, b, c], [a, m("2"), c], 1)).toBe(false);
  });

  test("an EQUAL-VALUED rebuild before the anchor fails", () => {
    // Reference identity, not deep equality (spec 3.2): a rebuilt object has
    // still broken the provider's prefix-matched cache.
    const a = m("1"),
      b = m("2");
    expect(checkPrefixStable([a, b], [{ ...a }, b], 1)).toBe(false);
  });

  test("truncating below the anchor fails", () => {
    const a = m("1"),
      b = m("2"),
      c = m("3");
    expect(checkPrefixStable([a, b, c], [a], 1)).toBe(false);
  });

  test("an undefined anchor permits a full rewrite", () => {
    // spec 3.5: undefined means there IS no cached prefix — a fresh session,
    // or straight after a compaction. Positive knowledge, not ignorance.
    const a = m("1"),
      b = m("2");
    expect(checkPrefixStable([a, b], [m("z")], undefined)).toBe(true);
  });
});
