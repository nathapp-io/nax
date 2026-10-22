import { describe, expect, test } from "bun:test";
import { featureIntentPaths, type PrCheckout } from "@/bot";

const prefix = ".nax/features/";
function checkout(files: string[]): PrCheckout {
  return {
    worktree: "/checkout",
    baseSha: "base",
    mergeBase: "merge",
    snapshotDir: "/snapshot",
    hasBaseNax: true,
    changedFiles: files.map((path) => prefix + path),
    dispose: async () => {},
  };
}

describe("featureIntentPaths", () => {
  test.each([
    ["AC-1 single PRD", ["a/prd.json"], { prdPath: "/checkout/.nax/features/a/prd.json" }],
    [
      "AC-2 matching spec",
      ["a/prd.json", "a/spec.md"],
      { prdPath: "/checkout/.nax/features/a/prd.json", specPath: "/checkout/.nax/features/a/spec.md" },
    ],
    ["AC-3 spec alone", ["a/spec.md"], { specPath: "/checkout/.nax/features/a/spec.md" }],
    ["AC-4 mismatched spec", ["a/prd.json", "b/spec.md"], { prdPath: "/checkout/.nax/features/a/prd.json" }],
    ["AC-5 ambiguous PRDs", ["a/prd.json", "b/prd.json", "a/spec.md"], {}],
    ["ambiguous specs", ["a/spec.md", "b/spec.md"], {}],
    ["invalid feature names and nested paths", ["../prd.json", "./spec.md", "/prd.json", "a/nested/spec.md"], {}],
    ["no intent", [], {}],
  ])("%s", (_name, files, expected) => {
    expect(featureIntentPaths(checkout(files))).toEqual(expected);
  });
});
