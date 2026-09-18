import { describe, expect, test } from "bun:test";
import {
  isRootWorkdir,
  normalizeWorkdir,
  storyAbsWorkdir,
  storyPackageDir,
  storyWorkdir,
  toRepoFrame,
} from "@/utils/path-frame";

describe("normalizeWorkdir", () => {
  test.each([
    [undefined, "."],
    [null, "."],
    ["", "."],
    ["   ", "."],
    [".", "."],
    ["./", "."],
    ["packages/app", "packages/app"],
    ["packages/app/", "packages/app"],
    ["./packages/app", "packages/app"],
    ["././packages/app", "packages/app"],
    ["packages\\app", "packages/app"],
    ["  packages/app  ", "packages/app"],
  ])("normalizes %p to %p", (input, expected) => {
    expect(normalizeWorkdir(input as string | null | undefined)).toBe(expected);
  });
});

describe("isRootWorkdir", () => {
  test.each([[undefined], [null], [""], ["."], ["./"]])("treats %p as root", (input) => {
    expect(isRootWorkdir(input as string | null | undefined)).toBe(true);
  });

  test("treats a package path as not root", () => {
    expect(isRootWorkdir("packages/app")).toBe(false);
  });
});

describe("toRepoFrame", () => {
  test("is identity at root", () => {
    expect(toRepoFrame("src/index.ts", ".")).toBe("src/index.ts");
    expect(toRepoFrame("src/index.ts", undefined)).toBe("src/index.ts");
  });

  test("prefixes a package-relative path", () => {
    expect(toRepoFrame("src/index.ts", "packages/app")).toBe("packages/app/src/index.ts");
  });

  test("leaves an already repo-rooted path unchanged", () => {
    expect(toRepoFrame("packages/app/src/index.ts", "packages/app")).toBe("packages/app/src/index.ts");
  });

  test("does not treat a sibling package as already-framed", () => {
    // "packages/application" must not be read as "packages/app" + "lication".
    expect(toRepoFrame("packages/application/src/x.ts", "packages/app")).toBe(
      "packages/app/packages/application/src/x.ts",
    );
  });

  test("normalizes a leading ./ on the input path", () => {
    expect(toRepoFrame("./src/index.ts", "packages/app")).toBe("packages/app/src/index.ts");
  });

  test("is the only re-framing primitive exported by the module", async () => {
    const mod = await import("@/utils/path-frame");
    expect(Object.keys(mod)).not.toContain("toPackageFrame");
    expect(Object.keys(mod)).not.toContain("partitionPackageFrame");
    expect(Object.keys(mod)).not.toContain("UNREADABLE_MARKER");
    expect(Object.keys(mod)).not.toContain("stripUnreadableMarker");
  });
});

describe("storyWorkdir", () => {
  test("returns a package path unchanged", () => {
    expect(storyWorkdir({ workdir: "packages/app" })).toBe("packages/app");
  });

  test.each([[{}], [{ workdir: undefined }], [{ workdir: "" }], [{ workdir: "." }]])("returns '.' for %p", (story) => {
    expect(storyWorkdir(story)).toBe(".");
  });
});

describe("storyPackageDir", () => {
  test("returns the package for a monorepo story", () => {
    expect(storyPackageDir({ workdir: "packages/app" })).toBe("packages/app");
  });

  test.each([[{}], [{ workdir: "." }], [{ workdir: "" }]])("returns undefined for the root story %p", (story) => {
    // This is the contract quality/command-resolver.ts documents at :60 and
    // that "." would otherwise break, because "." is truthy.
    expect(storyPackageDir(story)).toBeUndefined();
  });
});

describe("storyAbsWorkdir", () => {
  test("joins a package onto the root", () => {
    expect(storyAbsWorkdir("/repo", { workdir: "packages/app" })).toBe("/repo/packages/app");
  });

  test.each([[{}], [{ workdir: "." }]])("returns the root unchanged for %p", (story) => {
    expect(storyAbsWorkdir("/repo", story)).toBe("/repo");
  });
});
