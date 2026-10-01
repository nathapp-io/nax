// tools/monorepo/test/preconditions.test.ts
import { describe, expect, test } from "bun:test";
import { assertPreconditions } from "../lib/preconditions";

const ok = { branch: "refactor/nax-monorepo", dirty: false, hasPackagesDir: false, hasPrepareScript: false };

describe("assertPreconditions", () => {
  test("passes on a clean, unconverted tree on the working branch", () => {
    expect(() => assertPreconditions(ok, "refactor/nax-monorepo")).not.toThrow();
  });
  test.each([
    [{ ...ok, branch: "main" }, /on branch main/],
    [{ ...ok, dirty: true }, /working tree is dirty/],
    [{ ...ok, hasPackagesDir: true }, /already converted/],
    [{ ...ok, hasPrepareScript: true }, /prepare script still present/],
  ])("refuses %#", (state, msg) => {
    expect(() => assertPreconditions(state, "refactor/nax-monorepo")).toThrow(msg);
  });
});
