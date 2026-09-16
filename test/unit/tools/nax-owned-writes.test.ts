import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { isNaxConfigFile, NAX_OWNED_WRITE_TOOLS, naxOwnedWriteRefusal } from "@/tools/nax-owned-writes";

const ROOT = "/repo";

describe("isNaxConfigFile", () => {
  test("refuses the root config", () => {
    expect(isNaxConfigFile(ROOT, join(ROOT, ".nax", "config.json"))).toBe(true);
  });

  test("refuses a single-segment monorepo override", () => {
    expect(isNaxConfigFile(ROOT, join(ROOT, ".nax", "mono", "api", "config.json"))).toBe(true);
  });

  test("allows an ordinary file under .nax/mono", () => {
    expect(isNaxConfigFile(ROOT, join(ROOT, ".nax", "mono", "api", "notes.md"))).toBe(false);
  });

  test("allows a config.json that is not nax's own", () => {
    expect(isNaxConfigFile(ROOT, join(ROOT, "docs", "nax", "config.json"))).toBe(false);
  });

  test("allows a path outside the root", () => {
    expect(isNaxConfigFile(join(ROOT, "packages", "api"), join(ROOT, ".nax", "config.json"))).toBe(false);
  });

  test("refuses a nested monorepo override — the real shape loader.ts writes", () => {
    expect(isNaxConfigFile(ROOT, join(ROOT, ".nax", "mono", "packages", "api", "config.json"))).toBe(true);
  });

  test("refuses a deeply nested monorepo override", () => {
    expect(isNaxConfigFile(ROOT, join(ROOT, ".nax", "mono", "services", "edge", "api", "config.json"))).toBe(true);
  });

  test("still allows a non-config file at the same nesting", () => {
    expect(isNaxConfigFile(ROOT, join(ROOT, ".nax", "mono", "packages", "api", "notes.md"))).toBe(false);
  });

  test("does not refuse a bare .nax/mono/config.json — no such override exists", () => {
    expect(isNaxConfigFile(ROOT, join(ROOT, ".nax", "mono", "config.json"))).toBe(false);
  });
});

describe("naxOwnedWriteRefusal", () => {
  test("refuses Write to a feature PRD", () => {
    expect(naxOwnedWriteRefusal("Write", ".nax/features/auth/prd.json")).toBeDefined();
  });

  test("refuses Edit, Delete and GitCommit to the same path", () => {
    for (const tool of ["Edit", "Delete", "GitCommit"]) {
      expect(naxOwnedWriteRefusal(tool, ".nax/features/auth/prd.json")).toBeDefined();
    }
  });

  test("allows READS of a feature PRD — an agent legitimately reads its own PRD", () => {
    for (const tool of ["Read", "Grep", "Glob", "Git"]) {
      expect(naxOwnedWriteRefusal(tool, ".nax/features/auth/prd.json")).toBeUndefined();
    }
  });

  test("allows writes elsewhere under .nax/features", () => {
    expect(naxOwnedWriteRefusal("Write", ".nax/features/auth/notes.md")).toBeUndefined();
  });

  test("allows writes to an ordinary prd.json outside .nax", () => {
    expect(naxOwnedWriteRefusal("Write", "docs/prd.json")).toBeUndefined();
  });

  test("the reason names the path and says why", () => {
    const reason = naxOwnedWriteRefusal("Write", ".nax/features/auth/prd.json");
    expect(reason).toContain(".nax/features/auth/prd.json");
    expect(reason).toContain("acceptance criteria");
  });

  test("the mutating set is exactly the path-bearing tools that mutate", () => {
    expect([...NAX_OWNED_WRITE_TOOLS].sort()).toEqual(["Delete", "Edit", "GitCommit", "Write"]);
  });
});
