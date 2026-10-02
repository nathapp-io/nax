/**
 * Characterisation for `pathsBranch`'s unpinned branches, written green against
 * the unrefactored branch before the cognitive-complexity drain moves it
 * (STATUS-complexity-drain batch A8).
 *
 * The mirror suites (`policy.test.ts`, `policy-confine-to.test.ts`,
 * `git-interception.test.ts`) pin the allow/deny/breach flows for every field
 * kind; nothing below was asserted anywhere before this file. Each test pins
 * ONE branch's verdict shape — outcome, breach, exact reason — so a refactor
 * that scrambles a guard's order or message fails here rather than silently.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolScope } from "#src/tools/index";
import { compileToolPolicy } from "#src/tools/index";

let root: string;

beforeAll(() => {
  root = join(mkdtempSync(join(tmpdir(), "nax-policy-paths-edges-")), "repo");
  mkdirSync(join(root, "src"), { recursive: true });
});

describe("pathsBranch — input-shape guards", () => {
  test("a non-string pathFields value is denied as a type error, not a grant failure", () => {
    const policy = compileToolPolicy([{ tool: "Write", patterns: ["*"] }], root);
    const verdict = policy.check("Write", { pathFields: ["path"] }, { path: 42 });
    expect(verdict.allowed).toBe(false);
    if (verdict.allowed === false) {
      expect(verdict.outcome).toBe("denied");
      expect(verdict.breach).toBe(false);
      expect(verdict.reason).toBe('"path" must be a string path');
    }
  });

  test("a listPathFields value that is neither a string nor a string array is denied", () => {
    const policy = compileToolPolicy([{ tool: "Bulk", patterns: ["*"] }], root);
    const scope: ToolScope = { pathFields: [], listPathFields: ["files"] };
    for (const bad of [{ files: 42 }, { files: ["src/a.ts", 42] }]) {
      const verdict = policy.check("Bulk", scope, bad);
      expect(verdict.allowed).toBe(false);
      if (verdict.allowed === false) {
        expect(verdict.outcome).toBe("denied");
        expect(verdict.breach).toBe(false);
        expect(verdict.reason).toBe('"files" must be a string path or an array of string paths');
      }
    }
  });

  test("a listPathFields array of strings resolves and admits every element", () => {
    const policy = compileToolPolicy([{ tool: "Bulk", patterns: ["*"] }], root);
    const verdict = policy.check(
      "Bulk",
      { pathFields: [], listPathFields: ["files"] },
      { files: ["src/a.ts", "src/b.ts"] },
    );
    expect(verdict.allowed).toBe(true);
    if (verdict.allowed) {
      expect(verdict.resolvedPaths).toEqual([join(policy.root, "src", "a.ts"), join(policy.root, "src", "b.ts")]);
    }
  });

  test("a bare string in an arrayPathField is a type error, unlike listPathFields", () => {
    const policy = compileToolPolicy([{ tool: "Bulk", patterns: ["*"] }], root);
    const verdict = policy.check("Bulk", { pathFields: [], arrayPathFields: ["paths"] }, { paths: "src/a.ts" });
    expect(verdict.allowed).toBe(false);
    if (verdict.allowed === false) {
      expect(verdict.breach).toBe(false);
      expect(verdict.reason).toBe('"paths" must be an array of string paths');
    }
  });

  test("a non-string entry in an arrayPathField is denied before any resolution", () => {
    const policy = compileToolPolicy([{ tool: "Bulk", patterns: ["*"] }], root);
    const verdict = policy.check("Bulk", { pathFields: [], arrayPathFields: ["paths"] }, { paths: ["src/a.ts", 42] });
    expect(verdict.allowed).toBe(false);
    if (verdict.allowed === false) {
      expect(verdict.breach).toBe(false);
      expect(verdict.reason).toBe('"paths" entries must be strings');
    }
  });

  test("a bare string in a refPathField is a type error", () => {
    const policy = compileToolPolicy([{ tool: "Git", patterns: ["*"] }], root);
    const verdict = policy.check("Git", { pathFields: [], refPathFields: ["refs"] }, { refs: "HEAD:src/a.ts" });
    expect(verdict.allowed).toBe(false);
    if (verdict.allowed === false) {
      expect(verdict.breach).toBe(false);
      expect(verdict.reason).toBe('"refs" must be an array of string refs');
    }
  });

  test("a non-string entry in a refPathField is denied before any resolution", () => {
    const policy = compileToolPolicy([{ tool: "Git", patterns: ["*"] }], root);
    const verdict = policy.check("Git", { pathFields: [], refPathFields: ["refs"] }, { refs: [42] });
    expect(verdict.allowed).toBe(false);
    if (verdict.allowed === false) {
      expect(verdict.breach).toBe(false);
      expect(verdict.reason).toBe('"refs" entries must be strings');
    }
  });

  test('a ref whose path half is empty ("HEAD:") is skipped, admitting nothing and denying nothing', () => {
    // A restrictive grant makes this discriminating: if the empty path half
    // were resolved instead of skipped, it would resolve to the root itself
    // and fail the "src/**" glob.
    const policy = compileToolPolicy([{ tool: "Git", patterns: ["src/**"] }], root);
    const verdict = policy.check("Git", { pathFields: [], refPathFields: ["refs"] }, { refs: ["HEAD:"] });
    expect(verdict.allowed).toBe(true);
    if (verdict.allowed) expect(verdict.resolvedPaths).toEqual([]);
  });
});

describe("pathsBranch — confineTo that escapes the policy root", () => {
  test("the call is refused outright with the widening message, not a breach", () => {
    const policy = compileToolPolicy([{ tool: "Write", patterns: ["*"] }], root);
    const scope: ToolScope = { pathFields: ["path"], confineTo: "../outside" };
    const verdict = policy.check("Write", scope, { path: "src/a.ts" });
    expect(verdict.allowed).toBe(false);
    if (verdict.allowed === false) {
      expect(verdict.outcome).toBe("denied");
      expect(verdict.breach).toBe(false);
      expect(verdict.reason).toContain('Write declares confineTo "../outside"');
      expect(verdict.reason).toContain("resolves outside the policy root");
      expect(verdict.reason).toContain("never one that widens it");
    }
  });

  test("the refusal fires before field work and before the per-path deny rules", () => {
    // A SCOPED deny rule matching the requested path would deny inside the
    // field loops; the confineTo guard still wins because it precedes them.
    // (An UNconditional deny rule never gets here at all — check() intercepts
    // it before pathsBranch runs.)
    const policy = compileToolPolicy([{ tool: "Write", patterns: ["*"] }], root, {
      denyRules: [{ tool: "Write", patterns: ["src/**"] }],
    });
    const verdict = policy.check("Write", { pathFields: ["path"], confineTo: "../../elsewhere" }, { path: "src/a.ts" });
    expect(verdict.allowed).toBe(false);
    if (verdict.allowed === false) {
      expect(verdict.outcome).toBe("denied");
      expect(verdict.reason).toContain('declares confineTo "../../elsewhere"');
      expect(verdict.reason).not.toContain("is denied for this stage");
    }
  });
});

describe("pathsBranch — a verb-only grant (globs empty after verb filtering)", () => {
  const verbScope = (extra: Partial<ToolScope>): ToolScope => ({
    pathFields: [],
    verbField: "subcommand",
    allowedVerbs: ["diff", "log"],
    ...extra,
  });
  const policy = () => compileToolPolicy([{ tool: "Git", patterns: ["diff"] }], root);

  test("pathFields are DENIED for lack of globs — unlike arrayPathFields (mirror-pinned allowed)", () => {
    const verdict = policy().check("Git", verbScope({ pathFields: ["path"] }), {
      subcommand: "diff",
      path: "src/a.ts",
    });
    expect(verdict.allowed).toBe(false);
    if (verdict.allowed === false) {
      expect(verdict.breach).toBe(false);
      expect(verdict.reason).toBe('Git is not granted "src/a.ts" for this stage');
    }
  });

  test("listPathFields are denied under the same predicate as pathFields", () => {
    const verdict = policy().check("Git", verbScope({ listPathFields: ["files"] }), {
      subcommand: "diff",
      files: "src/a.ts src/b.ts",
    });
    expect(verdict.allowed).toBe(false);
    if (verdict.allowed === false) {
      expect(verdict.reason).toBe('Git is not granted "src/a.ts" for this stage');
    }
  });
});

describe("pathsBranch — resolvedPaths accumulation", () => {
  test("resolved paths accumulate in field-declaration order across field kinds", () => {
    const policy = compileToolPolicy([{ tool: "Bulk", patterns: ["*"] }], root);
    const scope: ToolScope = {
      pathFields: ["path"],
      listPathFields: ["files"],
      arrayPathFields: ["paths"],
    };
    const verdict = policy.check("Bulk", scope, {
      paths: ["src/c.ts", "src/d.ts"],
      files: "src/b.ts",
      path: "src/a.ts",
    });
    expect(verdict.allowed).toBe(true);
    if (verdict.allowed) {
      expect(verdict.resolvedPaths).toEqual([
        join(policy.root, "src", "a.ts"),
        join(policy.root, "src", "b.ts"),
        join(policy.root, "src", "c.ts"),
        join(policy.root, "src", "d.ts"),
      ]);
    }
  });
});
