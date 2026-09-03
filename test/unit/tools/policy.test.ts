import { beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolScope } from "@/tools";
import { compileToolPolicy } from "@/tools";

const PATH_SCOPE: ToolScope = { pathFields: ["path"] };
let root: string;
let outside: string;

beforeAll(() => {
  const base = mkdtempSync(join(tmpdir(), "nax-policy-"));
  root = join(base, "repo");
  outside = join(base, "elsewhere");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "test"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "secret.txt"), "no");
  symlinkSync(outside, join(root, "escape-link"));
});

describe("compileToolPolicy — patterns", () => {
  test("allows a path matching the grant's glob", () => {
    const policy = compileToolPolicy([{ tool: "Write", patterns: ["src/**"] }], root);
    const verdict = policy.check("Write", PATH_SCOPE, { path: "src/a.ts" });
    expect(verdict.allowed).toBe(true);
  });

  test("denies a path outside the grant's glob", () => {
    const policy = compileToolPolicy([{ tool: "Write", patterns: ["src/**"] }], root);
    const verdict = policy.check("Write", PATH_SCOPE, { path: "test/a.ts" });
    expect(verdict.allowed).toBe(false);
  });

  test("denies a tool with no grant at all", () => {
    const policy = compileToolPolicy([{ tool: "Read", patterns: ["*"] }], root);
    expect(policy.check("Write", PATH_SCOPE, { path: "src/a.ts" }).allowed).toBe(false);
  });

  test("a bare '*' grant allows any path inside the root", () => {
    const policy = compileToolPolicy([{ tool: "Read", patterns: ["*"] }], root);
    expect(policy.check("Read", PATH_SCOPE, { path: "test/deep/x.ts" }).allowed).toBe(true);
  });
});

describe("compileToolPolicy — containment is the hard boundary", () => {
  // The design's central safety claim. If this block is ever deleted to make
  // something pass, unrestricted silently means the whole filesystem.
  test("unrestricted-equivalent grants STILL deny outside the root", () => {
    const policy = compileToolPolicy([{ tool: "Write", patterns: ["*"] }], root);
    const verdict = policy.check("Write", PATH_SCOPE, { path: join(outside, "secret.txt") });
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.breach).toBe(true);
  });

  test("denies '..' traversal", () => {
    const policy = compileToolPolicy([{ tool: "Read", patterns: ["*"] }], root);
    const verdict = policy.check("Read", PATH_SCOPE, { path: "../elsewhere/secret.txt" });
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.breach).toBe(true);
  });

  test("denies a symlink pointing outside the root", () => {
    const policy = compileToolPolicy([{ tool: "Read", patterns: ["*"] }], root);
    const verdict = policy.check("Read", PATH_SCOPE, { path: "escape-link/secret.txt" });
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.breach).toBe(true);
  });

  test("a breach is distinguishable from an ordinary pattern denial", () => {
    const policy = compileToolPolicy([{ tool: "Write", patterns: ["src/**"] }], root);
    const denial = policy.check("Write", PATH_SCOPE, { path: "test/a.ts" });
    expect(denial.allowed).toBe(false);
    if (!denial.allowed) expect(denial.breach).toBe(false);
  });

  test("allows a path that does not exist yet, inside the root", () => {
    const policy = compileToolPolicy([{ tool: "Write", patterns: ["src/**"] }], root);
    expect(policy.check("Write", PATH_SCOPE, { path: "src/not/created/yet.ts" }).allowed).toBe(true);
  });
});

describe("compileToolPolicy — tool-level gating", () => {
  const VERB_SCOPE: ToolScope = {
    pathFields: [],
    verbField: "subcommand",
    allowedVerbs: ["diff", "log", "show", "status", "blame"],
  };

  test("allows a granted verb", () => {
    const policy = compileToolPolicy([{ tool: "Git", patterns: ["diff", "log"] }], root);
    expect(policy.check("Git", VERB_SCOPE, { subcommand: "diff" }).allowed).toBe(true);
  });

  test("denies a verb the grant omits", () => {
    const policy = compileToolPolicy([{ tool: "Git", patterns: ["diff", "log"] }], root);
    expect(policy.check("Git", VERB_SCOPE, { subcommand: "blame" }).allowed).toBe(false);
  });

  test("denies a verb outside the tool's own allowedVerbs even when granted '*'", () => {
    const policy = compileToolPolicy([{ tool: "Git", patterns: ["*"] }], root);
    expect(policy.check("Git", VERB_SCOPE, { subcommand: "push" }).allowed).toBe(false);
  });

  test("grantedTools lists the tools carrying a grant", () => {
    const policy = compileToolPolicy(
      [
        { tool: "Read", patterns: ["*"] },
        { tool: "Git", patterns: ["diff"] },
      ],
      root,
    );
    expect([...policy.grantedTools()].sort()).toEqual(["Git", "Read"]);
  });
});

/**
 * `**` must span whole directory segments, not arbitrary characters.
 *
 * `**` compiles to `.*`, which already crosses separators, and the `/` that
 * followed it was consumed without being re-emitted — so the directory boundary
 * vanished and `src/**\/config.ts` became `^src\/.*config\.ts$`. `.*` then
 * happily matched `legacy`, and a stage granted "files named config.ts" could
 * also write `legacyconfig.ts`.
 *
 * This never crossed the root (containment runs first), so it is not an escape.
 * It is a *scoped* grant coming out wider than its author wrote, which is the
 * one thing a scoped profile exists to prevent.
 */
describe("compileToolPolicy — ** spans directory segments, not partial names", () => {
  function allows(patterns: string[], path: string): boolean {
    return compileToolPolicy([{ tool: "Write", patterns }], root).check("Write", PATH_SCOPE, { path }).allowed;
  }

  test("a mid-pattern ** matches whole segments", () => {
    expect(allows(["src/**/config.ts"], "src/a/config.ts")).toBe(true);
    expect(allows(["src/**/config.ts"], "src/a/b/config.ts")).toBe(true);
  });

  test("a mid-pattern ** also matches zero segments, as minimatch does", () => {
    expect(allows(["src/**/config.ts"], "src/config.ts")).toBe(true);
  });

  test("a mid-pattern ** does not match a partial filename", () => {
    expect(allows(["src/**/config.ts"], "src/legacyconfig.ts")).toBe(false);
    expect(allows(["src/**/config.ts"], "src/a/db_config.ts")).toBe(false);
  });

  test("a leading ** does not match a partial filename", () => {
    expect(allows(["**/README.md"], "README.md")).toBe(true);
    expect(allows(["**/README.md"], "docs/a/README.md")).toBe(true);
    expect(allows(["**/README.md"], "evilREADME.md")).toBe(false);
    expect(allows(["**/README.md"], "src/notREADME.md")).toBe(false);
  });

  test("a trailing ** still matches everything beneath it", () => {
    expect(allows(["src/**"], "src/a.ts")).toBe(true);
    expect(allows(["src/**"], "src/a/b/c.ts")).toBe(true);
    expect(allows(["src/**"], "test/a.ts")).toBe(false);
  });

  test("a single * still stops at a separator", () => {
    expect(allows(["src/*.ts"], "src/a.ts")).toBe(true);
    expect(allows(["src/*.ts"], "src/a/b.ts")).toBe(false);
  });
});

/**
 * A verb-gated tool's grant list is overloaded: it carries verb names, so path
 * globs could not be matched against it, so array- and ref-valued path fields
 * got containment ONLY. That made path scoping inexpressible for `Git` — a
 * stage granted `Git(diff)` could diff anything in the root — and left any
 * future array-path tool silently unscoped.
 *
 * `allowedVerbs` is a closed set the tool declares, so the two kinds are
 * separable without guessing: a pattern that names a permitted verb is a verb,
 * anything else is a path glob.
 */
const GIT_SCOPE: ToolScope = {
  pathFields: [],
  arrayPathFields: ["paths"],
  refPathFields: ["refs"],
  verbField: "subcommand",
  allowedVerbs: ["diff", "log", "show"],
};

describe("compileToolPolicy — path globs apply to array and ref fields too", () => {
  function check(patterns: string[], input: Record<string, unknown>) {
    return compileToolPolicy([{ tool: "Git", patterns }], root).check("Git", GIT_SCOPE, input);
  }

  test("a path glob beside the verbs restricts array paths", () => {
    expect(check(["diff", "src/**"], { subcommand: "diff", paths: ["src/a.ts"] }).allowed).toBe(true);
    expect(check(["diff", "src/**"], { subcommand: "diff", paths: ["test/a.ts"] }).allowed).toBe(false);
  });

  test("the same glob restricts the path half of a ref", () => {
    expect(check(["show", "src/**"], { subcommand: "show", refs: ["HEAD:src/a.ts"] }).allowed).toBe(true);
    expect(check(["show", "src/**"], { subcommand: "show", refs: ["HEAD:test/a.ts"] }).allowed).toBe(false);
  });

  test("a pure revision carries no path, so a glob cannot reject it", () => {
    expect(check(["show", "src/**"], { subcommand: "show", refs: ["HEAD"] }).allowed).toBe(true);
  });

  test("a verb-only grant leaves paths bounded by the root alone", () => {
    // Unchanged behaviour, now an explicit authoring choice rather than an
    // inexpressible one: declare a glob if you want the paths narrowed.
    expect(check(["diff"], { subcommand: "diff", paths: ["test/a.ts"] }).allowed).toBe(true);
  });

  test("a path glob does not accidentally become a grantable verb", () => {
    expect(check(["diff", "src/**"], { subcommand: "log", paths: [] }).allowed).toBe(false);
  });

  test("a tool with no verbs at all glob-scopes its array paths", () => {
    const scope: ToolScope = { pathFields: [], arrayPathFields: ["paths"] };
    const policy = compileToolPolicy([{ tool: "Bulk", patterns: ["src/**"] }], root);
    expect(policy.check("Bulk", scope, { paths: ["src/a.ts"] }).allowed).toBe(true);
    expect(policy.check("Bulk", scope, { paths: ["test/a.ts"] }).allowed).toBe(false);
  });

  test("containment still outranks any glob", () => {
    const verdict = check(["diff", "**"], { subcommand: "diff", paths: ["../elsewhere/secret.txt"] });
    expect(verdict.allowed).toBe(false);
    expect(verdict.allowed === false && verdict.breach).toBe(true);
  });
});
