import { describe, expect, test } from "bun:test";
import { MAX_SIMILAR_FEATURES, similarFeatureNames } from "@/chat/workflow/similar-features";

describe("similarFeatureNames", () => {
  test("AC-1 keeps the near miss and drops the far name", () => {
    expect(similarFeatureNames("chat-job-flow", ["chat-job-flows", "review-and-gate-guards"])).toEqual([
      "chat-job-flows",
    ]);
  });

  test("AC-2 returns names closest first, ordering equal distances by name", () => {
    // "chat-flow" is 9 characters, so the bound is max(2, floor(9 / 4)) = 2.
    const known = ["chat-flows", "chat-fl", "chat-flo"];
    expect(similarFeatureNames("chat-flow", known)).toEqual(["chat-flo", "chat-flows", "chat-fl"]);
  });

  test("AC-3 returns at most MAX_SIMILAR_FEATURES names when more are within the bound", () => {
    const known = ["flow4", "flow2", "flow5", "flow3", "flow1"];
    const result = similarFeatureNames("flow", known);
    expect(MAX_SIMILAR_FEATURES).toBe(3);
    expect(result).toEqual(["flow1", "flow2", "flow3"]);
  });

  test("AC-4 returns none when every name is beyond the distance bound", () => {
    expect(similarFeatureNames("abc", ["xyz-long-name"])).toEqual([]);
  });

  test("includes a name at exactly the distance bound and excludes one beyond it", () => {
    // "abcd" is 4 characters, so the bound is max(2, 1) = 2.
    expect(similarFeatureNames("abcd", ["ab"])).toEqual(["ab"]);
    expect(similarFeatureNames("abcd", ["a"])).toEqual([]);
  });

  test("scales the bound with the name length", () => {
    // 20 characters, so the bound is max(2, 5) = 5.
    const name = "feature-with-20-chars";
    expect(similarFeatureNames(name, ["feature-with-20-chr"])).toEqual(["feature-with-20-chr"]);
    expect(similarFeatureNames("abcd", ["feature-with-20-chr"])).toEqual([]);
  });

  test("compares names case-sensitively and returns them as given", () => {
    expect(similarFeatureNames("chat", ["CHAT"])).toEqual([]);
    expect(similarFeatureNames("chat", ["Chat"])).toEqual(["Chat"]);
  });

  test("returns an empty list for no known names", () => {
    expect(similarFeatureNames("chat", [])).toEqual([]);
  });

  test("matches an identical name at distance zero first", () => {
    expect(similarFeatureNames("chat", ["chat-x", "chat"])).toEqual(["chat", "chat-x"]);
  });
});
