import { beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileToolPolicy, resolveWithin } from "@/tools";

/**
 * Single-frame redesign PR2, Task 13. Pre-move, the containment root was the
 * story's package dir while a workspace install wrote the repo-ROOT manifest
 * outside it, so `resolveWithin` carried an `execTouchedPaths` carve-out to
 * admit exactly those recorded paths. The root move made the containment root
 * the repo root, so the root manifest is in-root by construction and the
 * carve-out is retired. These pin the post-retirement shape.
 */
describe("compileToolPolicy — root move retires the execTouchedPaths carve-out (PR2/Task 13)", () => {
  let root: string;
  let outside: string;

  beforeAll(() => {
    const base = mkdtempSync(join(tmpdir(), "nax-policy-root-move-"));
    root = join(base, "repo");
    outside = join(base, "elsewhere");
    mkdirSync(root, { recursive: true });
    mkdirSync(outside, { recursive: true });
  });

  test("resolveWithin is the 2-arg containment seam", () => {
    // The third, optional execTouchedPaths parameter is gone. Function.length
    // is the runtime-visible arity of the declared parameter list, so this is a
    // genuine red pre-change (3) and green post-change (2).
    expect(resolveWithin.length).toBe(2);
  });

  test("a genuinely out-of-root candidate is refused by ordinary containment", () => {
    // Removing the carve-out must not widen containment: a candidate in a
    // sibling directory is still rejected by isInside.
    expect(resolveWithin(root, join(outside, "package.json"))).toBeNull();
  });

  test("a repo-root manifest is admitted by isInside alone, with no carve-out option", () => {
    // Post-move the containment root IS the repo root, so a GitCommit staging
    // the root manifest needs no execTouchedPaths allowance.
    const policy = compileToolPolicy([{ tool: "GitCommit", patterns: ["*"] }], root);
    const verdict = policy.check(
      "GitCommit",
      { pathFields: [], arrayPathFields: ["paths"] },
      { message: "chore: refresh root manifest", paths: [join(root, "package.json")] },
    );
    expect(verdict.allowed).toBe(true);
  });
});
