import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { gateBaselinePath, gatePackageRoot } from "@scripts/lib/package-root";

describe("gatePackageRoot", () => {
  test("defaults to the package the script lives in", () => {
    expect(gatePackageRoot("/repo/packages/nax/scripts", ["bun", "check.ts"])).toBe(join("/repo/packages/nax"));
  });

  test("resolves a relative --package against the cwd", () => {
    expect(gatePackageRoot("/repo/packages/nax/scripts", ["bun", "check.ts", "--package=."])).toBe(
      resolve(process.cwd(), "."),
    );
  });

  test("takes an absolute --package as is", () => {
    expect(gatePackageRoot("/x/scripts", ["bun", "check.ts", "--package=/repo/packages/nax-agent"])).toBe(
      "/repo/packages/nax-agent",
    );
  });
});

describe("gateBaselinePath", () => {
  test("puts the baseline under the scanned package's scripts/baselines", () => {
    expect(gateBaselinePath("/repo/packages/nax-agent", "complexity-baseline.json")).toBe(
      "/repo/packages/nax-agent/scripts/baselines/complexity-baseline.json",
    );
  });
});
