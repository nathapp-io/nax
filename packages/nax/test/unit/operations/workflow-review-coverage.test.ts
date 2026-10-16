import { describe, expect, test } from "bun:test";
import { type BranchReviewVerdict, isCompleteBranchVerdict, unreadFiles } from "@/operations";

describe("unreadFiles", () => {
  test("returns the required paths no inspected entry covers, in required order (AC-19)", () => {
    expect(unreadFiles(["src/a.ts", "src/b.ts"], ["src/a.ts"], "/repo")).toEqual(["src/b.ts"]);
  });

  test("a leading ./ is stripped before matching (AC-20)", () => {
    expect(unreadFiles(["src/a.ts"], ["./src/a.ts"], "/repo")).toEqual([]);
  });

  test("a repo-absolute path covers its repo-relative form (AC-21)", () => {
    expect(unreadFiles(["src/a.ts"], ["/repo/src/a.ts"], "/repo")).toEqual([]);
  });

  test("a match needs a / boundary, so a sibling with a longer basename does not cover (AC-22)", () => {
    expect(unreadFiles(["a.ts"], ["src/xa.ts"], "/repo")).toEqual(["a.ts"]);
  });

  test("an entry that matches no required path is ignored", () => {
    expect(unreadFiles(["src/a.ts"], ["src/a.ts", "docs/readme.md"], "/repo")).toEqual([]);
  });

  test("no entries at all leaves every required path unread", () => {
    expect(unreadFiles(["src/a.ts", "src/b.ts"], [], "/repo")).toEqual(["src/a.ts", "src/b.ts"]);
  });
});

/** A verdict differing only in the files it claims to have inspected. */
const verdict = (inspectedFiles: readonly string[]): BranchReviewVerdict => ({
  spec: "pass",
  quality: "approved",
  findings: [],
  cannotVerify: [],
  inspectedFiles,
  minorTriage: [],
});

describe("isCompleteBranchVerdict (US-003)", () => {
  test("true when inspectedFiles covers every required file (AC-6)", () => {
    expect(isCompleteBranchVerdict(verdict(["src/a.ts"]), ["src/a.ts"], "/repo")).toBe(true);
  });

  test("false when a required file is not covered (AC-7)", () => {
    expect(isCompleteBranchVerdict(verdict([]), ["src/a.ts"], "/repo")).toBe(false);
  });

  test("false when only some required files are covered", () => {
    expect(isCompleteBranchVerdict(verdict(["src/a.ts"]), ["src/a.ts", "src/b.ts"], "/repo")).toBe(false);
  });

  test("an empty required set is complete whatever the reply listed", () => {
    expect(isCompleteBranchVerdict(verdict([]), [], "/repo")).toBe(true);
    expect(isCompleteBranchVerdict(verdict(["src/a.ts"]), [], "/repo")).toBe(true);
  });
});

test("an outside absolute entry covers nothing even for an escaping required path", () => {
  expect(unreadFiles(["../package.json"], ["/package.json"], "/repo")).toEqual(["../package.json"]);
});

test.each([
  ["AC-16", "packages/x/package.json", ["package.json"]],
  ["AC-17", "/repo/packages/x/package.json", ["package.json"]],
  ["AC-18", "/repo/package.json", []],
  ["outside repo", "/other/package.json", ["package.json"]],
] as const)("%s exact coverage", (_ac, inspected, expected) => {
  expect(unreadFiles(["package.json"], [inspected], "/repo")).toEqual([...expected]);
});
