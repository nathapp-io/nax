import { describe, expect, test } from "bun:test";
import { compileToolPolicy } from "@/tools/policy";

describe("GitCommit after a repoRoot install", () => {
  test("cannot stage the root lockfile without the Exec allowance", () => {
    const policy = compileToolPolicy([{ tool: "GitCommit", patterns: ["*"] }], "/repo/packages/foo");
    const verdict = policy.check(
      "GitCommit",
      { pathFields: [], arrayPathFields: ["paths"] },
      {
        message: "chore: add bun-types",
        paths: ["/repo/bun.lockb"],
      },
    );
    expect(verdict.allowed).toBe(false);
  });

  test("can stage exactly the paths a prior allowed Exec touched", () => {
    const policy = compileToolPolicy([{ tool: "GitCommit", patterns: ["*"] }], "/repo/packages/foo", {
      execTouchedPaths: ["/repo/bun.lockb", "/repo/package.json"],
    });
    const allowed = policy.check(
      "GitCommit",
      { pathFields: [], arrayPathFields: ["paths"] },
      {
        message: "chore: add bun-types",
        paths: ["/repo/bun.lockb"],
      },
    );
    expect(allowed.allowed).toBe(true);

    // The allowance is exactly those paths, not the repo root.
    const denied = policy.check(
      "GitCommit",
      { pathFields: [], arrayPathFields: ["paths"] },
      {
        message: "chore: sneak",
        paths: ["/repo/packages/bar/src/index.ts"],
      },
    );
    expect(denied.allowed).toBe(false);
  });
});
