import { describe, expect, test } from "bun:test";
import { unreadFiles } from "@/operations";

describe("unreadFiles", () => {
  test("returns the required paths no inspected entry covers, in required order (AC-19)", () => {
    expect(unreadFiles(["src/a.ts", "src/b.ts"], ["src/a.ts"])).toEqual(["src/b.ts"]);
  });

  test("a leading ./ is stripped before matching (AC-20)", () => {
    expect(unreadFiles(["src/a.ts"], ["./src/a.ts"])).toEqual([]);
  });

  test("a repo-absolute path covers its repo-relative form (AC-21)", () => {
    expect(unreadFiles(["src/a.ts"], ["/repo/src/a.ts"])).toEqual([]);
  });

  test("a match needs a / boundary, so a sibling with a longer basename does not cover (AC-22)", () => {
    expect(unreadFiles(["a.ts"], ["src/xa.ts"])).toEqual(["a.ts"]);
  });

  test("an entry that matches no required path is ignored", () => {
    expect(unreadFiles(["src/a.ts"], ["src/a.ts", "docs/readme.md"])).toEqual([]);
  });

  test("no entries at all leaves every required path unread", () => {
    expect(unreadFiles(["src/a.ts", "src/b.ts"], [])).toEqual(["src/a.ts", "src/b.ts"]);
  });
});
