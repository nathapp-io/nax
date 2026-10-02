// packages/nax/test/unit/scripts/check-nax-ai-pin.test.ts
import { describe, expect, test } from "bun:test";
import { checkNaxAiPin } from "@scripts/check-nax-ai-pin";

describe("checkNaxAiPin", () => {
  test("ok when the exact pin equals the workspace version", () => {
    expect(checkNaxAiPin({ dependencies: { "@nathapp/nax-ai": "0.1.16" } }, { version: "0.1.16" })).toBeNull();
  });
  test("fails on a mismatch", () => {
    expect(checkNaxAiPin({ dependencies: { "@nathapp/nax-ai": "0.1.15" } }, { version: "0.1.16" })).toMatch(
      /0\.1\.15.*0\.1\.16/,
    );
  });
  test.each(["workspace:*", "^0.1.16", "~0.1.16", "latest"])("fails on non-exact spec %s", (spec) => {
    expect(checkNaxAiPin({ dependencies: { "@nathapp/nax-ai": spec } }, { version: "0.1.16" })).toMatch(/exact/);
  });
  test("fails when the dependency is missing", () => {
    expect(checkNaxAiPin({ dependencies: {} }, { version: "0.1.16" })).toMatch(/missing/);
  });
  test("names the package it checks", () => {
    expect(checkNaxAiPin({ dependencies: {} }, { version: "0.1.16" }, "packages/nax-agent")).toMatch(
      /packages\/nax-agent/,
    );
  });
  test("the real repo passes, for nax and for nax-agent", async () => {
    const { findRepoRoot } = await import("@scripts/lib/repo-root");
    const root = findRepoRoot(import.meta.dir);
    const ai = await Bun.file(`${root}/packages/nax-ai/package.json`).json();
    for (const label of ["packages/nax", "packages/nax-agent"]) {
      const pkg = await Bun.file(`${root}/${label}/package.json`).json();
      expect(checkNaxAiPin(pkg, ai, label)).toBeNull();
    }
  });
});
