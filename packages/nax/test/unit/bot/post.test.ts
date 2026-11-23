import { describe, expect, test } from "bun:test";
import { reviewQuality } from "@/bot/post";

describe("reviewQuality", () => {
  test("AC-5 a rebased review reports not-reviewed, whatever quality its verdict states", () => {
    // The verdict's quality type is `approved | changes`, and US-004's AC names the literal `good`, so the
    // call bypasses the compile-time enum rather than widening an unrelated verdict type.
    expect(Reflect.apply(reviewQuality, undefined, ["rebased", "good"])).toBe("not-reviewed");
  });

  test("a rebased review reports not-reviewed for a verdict that approved the code", () => {
    expect(reviewQuality("rebased", "approved")).toBe("not-reviewed");
  });

  test("a conversation-only review still reports not-reviewed", () => {
    expect(reviewQuality("conversation-only", "approved")).toBe("not-reviewed");
  });

  test("a full or incremental review keeps the verdict's own quality", () => {
    expect(reviewQuality("full", "changes")).toBe("changes");
    expect(reviewQuality("incremental", "approved")).toBe("approved");
  });

  test("an unclassified review keeps the verdict's own quality", () => {
    expect(reviewQuality(undefined, "approved")).toBe("approved");
  });
});
