import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { isNaxConfigFile } from "@/tools/nax-owned-writes";

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
