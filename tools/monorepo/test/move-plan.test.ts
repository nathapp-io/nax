// tools/monorepo/test/move-plan.test.ts
import { describe, expect, test } from "bun:test";
import { planMoves } from "../lib/move-plan";

describe("planMoves", () => {
  test("moves everything except KEEP_AT_ROOT, sorted", () => {
    const r = planMoves(["src", ".github", "package.json", "docs", "README.md", "bun.lock", "bin"]);
    expect(r.move).toEqual(["README.md", "bin", "package.json", "src"]);
    expect(r.keep).toEqual([".github", "bun.lock", "docs"]);
  });
  test("refuses to move 'packages' (already converted)", () => {
    expect(() => planMoves(["packages", "src"])).toThrow(/already has a packages\/ entry/);
  });
});
