import { describe, expect, test } from "bun:test";
import { compileToolPolicy } from "@/tools/policy";

const GIT_SCOPE = { pathFields: [], arrayPathFields: ["paths"] };

describe("GitCommit containment after the root move (PR2/Task 13)", () => {
  test("a path outside the containment root cannot be staged", () => {
    // Pre-move the root was the package dir and a repo-root lockfile sat
    // outside it, where the execTouchedPaths carve-out admitted it. Post-move
    // the containment root IS the repo root, so this package-root shape is
    // simply out of root and the carve-out is retired.
    const policy = compileToolPolicy([{ tool: "GitCommit", patterns: ["*"] }], "/repo/packages/foo");
    const verdict = policy.check("GitCommit", GIT_SCOPE, {
      message: "chore: add bun-types",
      paths: ["/repo/bun.lockb"],
    });
    expect(verdict.allowed).toBe(false);
  });

  test("a repo-root manifest is admitted by ordinary containment, with no Exec-touched allowance", () => {
    // The root move (PR2/Task 13) retired the execTouchedPaths carve-out: a
    // GitCommit staging the repo-root manifest is admitted by isInside alone.
    const policy = compileToolPolicy([{ tool: "GitCommit", patterns: ["*"] }], "/repo");
    const allowed = policy.check("GitCommit", GIT_SCOPE, {
      message: "chore: refresh root manifest",
      paths: ["/repo/package.json"],
    });
    expect(allowed.allowed).toBe(true);

    // Ordinary containment still refuses a genuinely out-of-root path.
    const denied = policy.check("GitCommit", GIT_SCOPE, {
      message: "chore: sneak",
      paths: ["/elsewhere/src/index.ts"],
    });
    expect(denied.allowed).toBe(false);
  });
});

describe("GitCommit denial messages", () => {
  test("a manifest-shaped path outside the root gets the plain denial (PR2/Task 13)", () => {
    // The GitCommit-specific manifest message existed only to explain the
    // execTouchedPaths carve-out; with that retired, a manifest-shaped path is
    // just another out-of-root path and gets the plain message.
    const policy = compileToolPolicy([{ tool: "GitCommit", patterns: ["*"] }], "/repo/packages/foo");
    const denied = policy.check("GitCommit", GIT_SCOPE, {
      message: "chore: add bun-types",
      paths: ["/repo/package.json"],
    });
    expect(denied.allowed).toBe(false);
    if (denied.allowed) throw new Error("unreachable");
    expect(denied.reason).toBe(
      '"paths" entry "/repo/package.json" resolves outside the permitted root (/repo/packages/foo), which is the only directory this tool can reach',
    );
  });

  test("an ordinary out-of-root source path gets the plain denial", () => {
    const policy = compileToolPolicy([{ tool: "GitCommit", patterns: ["*"] }], "/repo/packages/foo");
    const denied = policy.check("GitCommit", GIT_SCOPE, {
      message: "chore: sneak",
      paths: ["/repo/packages/bar/src/index.ts"],
    });
    expect(denied.allowed).toBe(false);
    if (denied.allowed) throw new Error("unreachable");
    expect(denied.reason).toBe(
      '"paths" entry "/repo/packages/bar/src/index.ts" resolves outside the permitted root (/repo/packages/foo), which is the only directory this tool can reach',
    );
  });

  test("a manifest-shaped path gets the plain denial for a non-GitCommit tool too", () => {
    const policy = compileToolPolicy([{ tool: "Write", patterns: ["*"] }], "/repo/packages/foo");
    const denied = policy.check("Write", { pathFields: ["path"] }, { path: "/repo/package.json" });
    expect(denied.allowed).toBe(false);
    if (denied.allowed) throw new Error("unreachable");
    expect(denied.reason).toBe(
      'path "/repo/package.json" resolves outside the permitted root (/repo/packages/foo), which is the only directory this tool can reach',
    );
  });
});
