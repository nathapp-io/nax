/**
 * The `.nax` first-segment exemption for the Node agent Glob (US-001).
 *
 * nax's own artifacts (briefs, reports, the ledger) live under `.nax/`, so an
 * agent can Read them but could never find them while every dot path is hidden
 * (ruling D21). These cases pin the narrow exemption: a pattern whose first
 * segment is literally `.nax` reaches `.nax/`, while every other dot segment —
 * including one below `.nax/` — stays hidden.
 *
 * The shared GLOB_CASES contract in @nathapp/nax-test-kit holds the D21 cases
 * that must keep passing; it has no `.nax` pattern, so each runtime pins the
 * exemption in its own file.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { nodeRuntime } from "#src/runtime/index";
import { withTempDir } from "#test/helpers/index";

const REPORT = ".nax/features/f/workflow/r1/US-001/report.md";
const HIDDEN_UNDER_NAX = ".nax/.hidden/x.md";

/** One root shared by every case: nax state, a sibling `.nax-wt`, `.git` and visible src. */
const FILES = [REPORT, HIDDEN_UNDER_NAX, ".nax-wt/a.ts", ".git/HEAD", "src/a.ts"] as const;

async function withGlobRoot(fn: (root: string) => Promise<void>): Promise<void> {
  await withTempDir(async (root) => {
    for (const file of FILES) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), "x");
    }
    await fn(root);
  });
}

async function hits(pattern: string, cwd: string, absolute = false): Promise<string[]> {
  const out: string[] = [];
  for await (const hit of nodeRuntime.glob(pattern, { cwd, absolute })) out.push(hit);
  return out.sort(byCodeUnit);
}

function syncHits(pattern: string, cwd: string, absolute = false): string[] {
  return [...nodeRuntime.globSync(pattern, { cwd, absolute })].sort(byCodeUnit);
}

/** Order the results so an assertion states the matched set, not the traversal order. */
function byCodeUnit(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

describe("nodeRuntime.glob lists files under a literal .nax first segment", () => {
  test("async glob reaches .nax for a .nax-prefixed pattern", async () => {
    await withGlobRoot(async (root) => {
      expect(await hits(".nax/features/**/report.md", root)).toEqual([REPORT]);
    });
  });

  test("sync glob reaches .nax for a .nax-prefixed pattern", async () => {
    await withGlobRoot(async (root) => {
      expect(syncHits(".nax/features/**/report.md", root)).toEqual([REPORT]);
    });
  });

  test("a leading ./ on the pattern is preserved in the .nax results", async () => {
    await withGlobRoot(async (root) => {
      expect(await hits("./.nax/features/**/report.md", root)).toEqual([`./${REPORT}`]);
    });
  });

  test("a dot segment below .nax stays hidden", async () => {
    await withGlobRoot(async (root) => {
      const found = await hits(".nax/**/*", root);
      expect(found).toEqual([REPORT]);
      expect(found).not.toContain(HIDDEN_UNDER_NAX);
    });
  });

  test("a wildcard first segment never reaches .nax", async () => {
    await withGlobRoot(async (root) => {
      expect(await hits("**/*", root)).toEqual(["src/a.ts"]);
    });
  });

  test("a wildcard directory segment never reaches .nax", async () => {
    await withGlobRoot(async (root) => {
      expect(await hits("**/report.md", root)).toEqual([]);
    });
  });

  test("a .nax-prefixed sibling (.nax-wt) stays hidden", async () => {
    await withGlobRoot(async (root) => {
      expect(await hits(".nax-wt/**/*", root)).toEqual([]);
    });
  });

  test("a brace alternative naming .nax is not a literal first segment", async () => {
    await withGlobRoot(async (root) => {
      expect(await hits("{.nax,src}/**/*", root)).toEqual(["src/a.ts"]);
    });
  });

  test(".git stays hidden for a .git-prefixed pattern", async () => {
    await withGlobRoot(async (root) => {
      expect(await hits(".git/*", root)).toEqual([]);
    });
  });

  test("absolute results keep the .nax exemption", async () => {
    await withGlobRoot(async (root) => {
      expect(await hits(".nax/features/**/report.md", root, true)).toEqual([resolve(root, REPORT)]);
    });
  });
});
