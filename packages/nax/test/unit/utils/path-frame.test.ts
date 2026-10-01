import { describe, expect, test } from "bun:test";
import {
  isRootWorkdir,
  isWithinPackage,
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
});

describe("isWithinPackage", () => {
  test("rejects a sibling package that shares a name prefix", () => {
    // The exact boundary defect that recurred three times: "packages/application"
    // must not be read as "packages/app" + "lication".
    expect(isWithinPackage("packages/application/src/x.ts", "packages/app")).toBe(false);
  });

  test("accepts a file beneath the package", () => {
    expect(isWithinPackage("packages/app/src/x.ts", "packages/app")).toBe(true);
  });

  test("accepts the package directory itself", () => {
    // Intentional semantic delta from the deleted package-frame translation,
    // which returned null for the package dir itself.
    expect(isWithinPackage("packages/app", "packages/app")).toBe(true);
  });

  test.each([["."], [undefined], [""]])("treats repo-root workdir %p as containing every path", (workdir) => {
    expect(isWithinPackage("src/a.ts", workdir as string | null | undefined)).toBe(true);
  });
});

describe("module export surface (single-frame redesign)", () => {
  test("exposes toRepoFrame as the only frame primitive and no marker helper", async () => {
    const keys = Object.keys(await import("@/utils/path-frame"));
    // Catch any new *Frame* primitive, not only those ending in "Frame"
    // (a reintroduced package-frame file helper must fail this pin).
    expect(keys.filter((k) => k.includes("Frame"))).toEqual(["toRepoFrame"]);
    expect(keys.filter((k) => /marker/i.test(k))).toEqual([]);
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
