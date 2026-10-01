// packages/nax-ai/test/package-metadata.test.ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

describe("package metadata points at the monorepo (npm provenance checks repository.url)", () => {
  it("repository", () => {
    expect(pkg.repository).toEqual({
      type: "git",
      url: "git+https://github.com/nathapp-io/nax.git",
      directory: "packages/nax-ai",
    });
  });
  it("homepage and bugs", () => {
    expect(pkg.homepage).toBe("https://github.com/nathapp-io/nax/tree/main/packages/nax-ai");
    expect(pkg.bugs).toEqual({ url: "https://github.com/nathapp-io/nax/issues" });
  });
  it("builds dist on workspace install", () => {
    expect(pkg.scripts.prepare).toBe("bun run build");
  });
});
