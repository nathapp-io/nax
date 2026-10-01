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
  test("the real repo passes", async () => {
    const { findRepoRoot } = await import("@scripts/lib/repo-root");
    const root = findRepoRoot(import.meta.dir);
    const nax = await Bun.file(`${root}/packages/nax/package.json`).json();
    const ai = await Bun.file(`${root}/packages/nax-ai/package.json`).json();
    expect(checkNaxAiPin(nax, ai)).toBeNull();
  });
});
