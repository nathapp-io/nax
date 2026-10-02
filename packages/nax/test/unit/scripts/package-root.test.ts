import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gateBaselinePath, gatePackageRoot } from "@scripts/lib/package-root";

const NAX_ERROR_GATE = join(import.meta.dir, "../../../scripts/check-nax-error.ts");
const PLANTED = "src/planted-by-package-flag.ts";

function tree(root: string, files: Record<string, string>): void {
  for (const [rel, body] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, body, "utf8");
  }
}

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

/**
 * The two helpers are pure, so unit-testing them proves nothing about a gate:
 * a gate that went back to `join(import.meta.dir, "..")` would pass all four
 * tests above while scanning its own package forever. Only a spawned gate
 * proves a gate's ROOT moves.
 */
describe("a gate honours --package=", () => {
  // The gate is proven by violating it: one that never failed here is not a gate.
  // check-nax-error counts `throw new Error(`, so a planted call in the temp
  // package's src/ must breach that package's own zero baseline and be reported.
  // It reports package-relative paths by design, so containment rests on the
  // planted filename existing in no other package: if the flag were ignored the
  // gate would scan packages/nax, find its clean 0-violation src/, and print
  // nothing about a file that exists nowhere but the temp dir.
  test("check-nax-error scans the package --package names, not the one it lives in", () => {
    const root = mkdtempSync(join(tmpdir(), "nax-package-root-"));
    tree(root, {
      [PLANTED]: 'export const boom = () => {\n  throw new Error("planted");\n};\n',
      "scripts/baselines/nax-error-baseline.json":
        '{ "count": 0, "updatedAt": "1970-01-01T00:00:00.000Z", "byFile": {} }\n',
    });
    const proc = Bun.spawnSync(["bun", "run", NAX_ERROR_GATE, `--package=${root}`]);
    const out = proc.stdout.toString() + proc.stderr.toString();
    rmSync(root, { recursive: true, force: true });

    expect(proc.exitCode).not.toBe(0);
    expect(out).toContain(PLANTED);
  });
});
