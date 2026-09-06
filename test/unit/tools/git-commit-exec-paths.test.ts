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

describe("GitCommit denial messages (fix round 1, Task 10)", () => {
  test("a known-manifest path outside the root gets an informative denial", () => {
    const policy = compileToolPolicy([{ tool: "GitCommit", patterns: ["*"] }], "/repo/packages/foo");
    const denied = policy.check(
      "GitCommit",
      { pathFields: [], arrayPathFields: ["paths"] },
      {
        message: "chore: add bun-types",
        paths: ["/repo/package.json"],
      },
    );
    expect(denied.allowed).toBe(false);
    if (denied.allowed) throw new Error("unreachable");
    expect(denied.reason).toContain("story's package root");
    expect(denied.reason).toContain("Exec install in THIS turn");
    expect(denied.reason).toContain("completion-phase auto-commit sweep");
  });

  test("an ordinary out-of-root source path still gets the plain denial", () => {
    const policy = compileToolPolicy([{ tool: "GitCommit", patterns: ["*"] }], "/repo/packages/foo");
    const denied = policy.check(
      "GitCommit",
      { pathFields: [], arrayPathFields: ["paths"] },
      {
        message: "chore: sneak",
        paths: ["/repo/packages/bar/src/index.ts"],
      },
    );
    expect(denied.allowed).toBe(false);
    if (denied.allowed) throw new Error("unreachable");
    expect(denied.reason).toBe('"paths" entry "/repo/packages/bar/src/index.ts" resolves outside the permitted root');
  });

  test("a known-manifest path stays on the plain denial for a tool other than GitCommit", () => {
    const policy = compileToolPolicy([{ tool: "Write", patterns: ["*"] }], "/repo/packages/foo");
    const denied = policy.check(
      "Write",
      { pathFields: ["path"] },
      {
        path: "/repo/package.json",
      },
    );
    expect(denied.allowed).toBe(false);
    if (denied.allowed) throw new Error("unreachable");
    expect(denied.reason).toBe('path "/repo/package.json" resolves outside the permitted root');
  });
});
