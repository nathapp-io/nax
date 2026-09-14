import { beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolScope } from "@/tools";
import { compileToolPolicy, resolveWithin } from "@/tools";

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

  // Fixture for the .git-exclusion describe block below (nax#1943).
  mkdirSync(join(root, ".git"), { recursive: true });
  writeFileSync(join(root, ".git", "index"), "not a real index");
  mkdirSync(join(root, ".github", "workflows"), { recursive: true });
  writeFileSync(join(root, ".github", "workflows", "ci.yml"), "name: ci\n");
  writeFileSync(join(root, ".gitignore"), "node_modules\n");
  writeFileSync(join(root, ".gitattributes"), "* text=auto\n");
  mkdirSync(join(root, "vendor", "nested-repo", ".git"), { recursive: true });
  writeFileSync(join(root, "vendor", "nested-repo", ".git", "config"), "[core]\n");
  symlinkSync(join(root, ".git", "index"), join(root, "link-into-git"));
  // Lives OUTSIDE the root and resolves INTO .git/, which is the only shape
  // that reaches resolveWithin's execTouchedPaths branch at all.
  symlinkSync(join(root, ".git", "index"), join(outside, "touched-link"));
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

describe("compileToolPolicy — Exec argv matching", () => {
  test("Exec grant matches per argv token, not across a joined string", () => {
    const policy = compileToolPolicy([{ tool: "Exec", patterns: ["bun add*"] }], "/repo");
    const scope: ToolScope = { pathFields: [], argvField: "argv" };
    expect(policy.check("Exec", scope, { argv: ["bun", "add", "-d", "x"] }).allowed).toBe(true);
    expect(policy.check("Exec", scope, { argv: ["bun", "publish"] }).allowed).toBe(false);
    expect(policy.check("Exec", scope, { argv: ["bunx", "add"] }).allowed).toBe(false);
  });

  test("a RunCommand(*) grant does not admit an argv call checked under the Exec identity", () => {
    const policy = compileToolPolicy([{ tool: "RunCommand", patterns: ["*"] }], "/repo");
    const scope: ToolScope = { pathFields: [], verbField: "command", allowedVerbs: ["test"], argvField: "argv" };
    expect(policy.check("Exec", scope, { argv: ["bun", "install"] }).allowed).toBe(false);
  });

  test("an unconditional Exec('*') grant still runs validateArgv before matching", () => {
    const policy = compileToolPolicy([{ tool: "Exec", patterns: ["*"] }], "/repo");
    const scope: ToolScope = { pathFields: [], argvField: "argv" };
    const verdict = policy.check("Exec", scope, { argv: ["bun", "add", "x; rm -rf /"] });
    expect(verdict.allowed).toBe(false);
    expect(verdict.allowed === false && verdict.reason).toContain("metacharacter");
  });

  test("an argv denial names the forms that would have been allowed", () => {
    const policy = compileToolPolicy([{ tool: "Exec", patterns: ["bun add*", "npm install*"] }], "/repo");
    const scope: ToolScope = { pathFields: [], argvField: "argv" };
    const verdict = policy.check("Exec", scope, { argv: ["bun", "x", "tsc", "--noEmit"] });
    expect(verdict.allowed).toBe(false);
    // A bare denial is what produced the defect this branch exists to fix: the
    // model read "no" as "route around it" rather than "use a different form".
    expect(verdict.allowed === false && verdict.reason).toContain("bun x tsc --noEmit");
    expect(verdict.allowed === false && verdict.reason).toContain("bun add*");
    expect(verdict.allowed === false && verdict.reason).toContain("npm install*");
  });

  test("an argv denial under a grant with no matchable form says so rather than naming an empty list", () => {
    const policy = compileToolPolicy([{ tool: "Exec", patterns: [] }], "/repo");
    const scope: ToolScope = { pathFields: [], argvField: "argv" };
    const verdict = policy.check("Exec", scope, { argv: ["bun", "install"] });
    expect(verdict.allowed).toBe(false);
    expect(verdict.allowed === false && verdict.reason).toContain("no argv forms are granted");
  });

  test("a call with no argv field present falls through to the ordinary verbField check", () => {
    const policy = compileToolPolicy([{ tool: "RunCommand", patterns: ["test"] }], "/repo");
    const scope: ToolScope = { pathFields: [], verbField: "command", allowedVerbs: ["test"], argvField: "argv" };
    expect(policy.check("RunCommand", scope, { command: "test" }).allowed).toBe(true);
  });
});

/**
 * `.git/` is INSIDE the permitted root, so containment alone never bars it,
 * and an unconditional ("*") grant -- what every non-Exec tool gets under the
 * default `unrestricted` profile -- skips glob matching entirely. Without a
 * dedicated exclusion, any path-bearing tool could corrupt `.git/index` or
 * rewrite `.git/config` (nax#1943). Both `resolveWithin` directly (the seam
 * `glob.ts` and `package-managers.ts` call without going through `check()`)
 * and `check()`'s denial message are covered here.
 */
describe("compileToolPolicy — .git/ is excluded at the resolveWithin seam", () => {
  test("resolveWithin denies a top-level .git path even though it is inside root", () => {
    expect(resolveWithin(root, ".git/index")).toBeNull();
    expect(resolveWithin(root, ".git")).toBeNull();
  });

  test("resolveWithin denies a NON-leading .git segment (nested repo / submodule)", () => {
    expect(resolveWithin(root, "vendor/nested-repo/.git/config")).toBeNull();
    expect(resolveWithin(root, "vendor/nested-repo/.git")).toBeNull();
  });

  test("resolveWithin still permits paths that merely LOOK like .git by substring", () => {
    // A naive startsWith(".git") would wrongly swallow all three of these.
    expect(resolveWithin(root, ".gitignore")).not.toBeNull();
    expect(resolveWithin(root, ".gitattributes")).not.toBeNull();
    expect(resolveWithin(root, ".github/workflows/ci.yml")).not.toBeNull();
  });

  test("resolveWithin denies a symlink whose target lives under .git/", () => {
    expect(resolveWithin(root, "link-into-git")).toBeNull();
  });

  test("a path spelled from OUTSIDE the root that resolves into .git/ is refused", () => {
    // `isInside` resolves symlinks on both sides, so this is caught by the
    // in-root branch rather than falling through to the execTouchedPaths
    // carve-out -- which is precisely why that carve-out needs no .git check
    // of its own. Passing the touched path too asserts it cannot re-admit the
    // path by a route the in-root spelling would not have.
    const gitIndex = join(root, ".git", "index");
    const viaOutside = join(outside, "touched-link");
    expect(resolveWithin(root, viaOutside)).toBeNull();
    expect(resolveWithin(root, viaOutside, [gitIndex])).toBeNull();
  });

  test("check() denies a .git/ path even under an unconditional '*' grant", () => {
    const policy = compileToolPolicy([{ tool: "Write", patterns: ["*"] }], root);
    const verdict = policy.check("Write", PATH_SCOPE, { path: ".git/index" });
    expect(verdict.allowed).toBe(false);
  });

  test("check()'s denial message names git metadata, not a generic 'outside the root' claim", () => {
    // The path IS inside the root, so the generic message would be actively
    // misleading here -- it must get its own accurate reason (see
    // outOfRootReason in policy.ts).
    const policy = compileToolPolicy([{ tool: "Write", patterns: ["*"] }], root);
    const verdict = policy.check("Write", PATH_SCOPE, { path: ".git/index" });
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) {
      expect(verdict.reason).toContain("git");
      expect(verdict.reason).not.toContain("resolves outside the permitted root");
    }
  });

  test("check() still denies an actually-out-of-root path with the generic message", () => {
    const policy = compileToolPolicy([{ tool: "Write", patterns: ["*"] }], root);
    const verdict = policy.check("Write", PATH_SCOPE, { path: join(outside, "secret.txt") });
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.reason).toContain("resolves outside the permitted root");
  });

  test("check() denials for .git/ are still breaches, the same as any other containment denial", () => {
    const policy = compileToolPolicy([{ tool: "Write", patterns: ["*"] }], root);
    const verdict = policy.check("Write", PATH_SCOPE, { path: ".git/index" });
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.breach).toBe(true);
  });

  test("a scoped glob grant does not accidentally re-admit .git/ via a wildcard", () => {
    const policy = compileToolPolicy([{ tool: "Write", patterns: ["**"] }], root);
    expect(policy.check("Write", PATH_SCOPE, { path: ".git/index" }).allowed).toBe(false);
  });

  test("ordinary paths are unaffected", () => {
    const policy = compileToolPolicy([{ tool: "Write", patterns: ["*"] }], root);
    expect(policy.check("Write", PATH_SCOPE, { path: "src/a.ts" }).allowed).toBe(true);
    expect(policy.check("Write", PATH_SCOPE, { path: ".gitignore" }).allowed).toBe(true);
  });
});

/**
 * nax's own CONFIG files are refused to every path-bearing tool.
 *
 * `quality.commands` and `acceptance.command` are run by key through a shell
 * and never pass the permission gate (spec R8) -- they are trusted because a
 * human wrote them. That trust rests entirely on a model being unable to write
 * them: an agent that can edit `.nax/config.json` can add a quality command and
 * get an ungated shell on the next run, routing around every `Bash(...)` rule,
 * the lexer's refusals and containment itself.
 *
 * Deliberately NARROW -- the config files only, not `.nax/` wholesale. The rest
 * of `.nax/` is run state, specs and PRDs the agent legitimately reads, and
 * refusing all of it would break ordinary work to close one hole.
 */
describe("compileToolPolicy — nax config files are excluded at the resolveWithin seam", () => {
  test.each([".nax/config.json", ".nax/mono/api/config.json", ".nax/mono/web-app/config.json"])(
    "resolveWithin denies %s even though it is inside root",
    (candidate) => {
      expect(resolveWithin(root, candidate)).toBeNull();
    },
  );

  test.each([
    ".nax/features/x/prd.json",
    ".nax/features/x/spec.md",
    ".nax/rules/project-conventions.md",
    ".nax/context.md",
    ".nax/mono/api/notes.md",
    ".naxignore",
    "src/.nax-helper.ts",
    "docs/nax/config.json",
  ])("resolveWithin still permits %s", (candidate) => {
    expect(resolveWithin(root, candidate)).not.toBeNull();
  });

  test("check() denies .nax/config.json even under an unconditional '*' grant", () => {
    const policy = compileToolPolicy([{ tool: "Write", patterns: ["*"] }], root);
    expect(policy.check("Write", PATH_SCOPE, { path: ".nax/config.json" }).allowed).toBe(false);
  });

  test("the denial names nax config, not a generic 'outside the root' claim", () => {
    const policy = compileToolPolicy([{ tool: "Write", patterns: ["*"] }], root);
    const verdict = policy.check("Write", PATH_SCOPE, { path: ".nax/config.json" });
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) {
      expect(verdict.reason).toContain("nax");
      expect(verdict.reason).not.toContain("resolves outside the permitted root");
    }
  });

  test("reads are refused too -- the file names what a later run will execute", () => {
    const policy = compileToolPolicy([{ tool: "Read", patterns: ["*"] }], root);
    expect(policy.check("Read", PATH_SCOPE, { path: ".nax/config.json" }).allowed).toBe(false);
  });
});

describe("verb denial names what is permitted (#1971)", () => {
  const SCOPE: ToolScope = {
    pathFields: [],
    verbField: "command",
    allowedVerbs: ["lint", "test", "testScoped", "coverage"],
  };

  test("an unknown verb is told the verbs the stage can use", () => {
    const policy = compileToolPolicy([{ tool: "RunCommand", patterns: ["*"] }], root);
    const verdict = policy.check("RunCommand", SCOPE, { command: "test:coverage" });
    expect(verdict.allowed).toBe(false);
    expect(verdict.allowed === false && verdict.reason).toContain("test:coverage");
    expect(verdict.allowed === false && verdict.reason).toContain("permitted: lint, test, testScoped, coverage");
  });

  test("a narrower grant names only what the grant allows, not every allowedVerb", () => {
    const policy = compileToolPolicy([{ tool: "RunCommand", patterns: ["lint", "test"] }], root);
    const verdict = policy.check("RunCommand", SCOPE, { command: "coverage" });
    expect(verdict.allowed).toBe(false);
    // `coverage` is an allowedVerb but NOT granted to this stage: naming it
    // would send the model straight back into the same denial.
    expect(verdict.allowed === false && verdict.reason).toContain("permitted: lint, test");
    // Naming every allowedVerb would append "testScoped"; `coverage` alone is
    // the denied verb and cannot contain it, so this only fails on the regression.
    expect(verdict.allowed === false && verdict.reason).not.toContain("testScoped");
  });

  test("a grant with no usable verb says so rather than naming an empty list", () => {
    const policy = compileToolPolicy([{ tool: "RunCommand", patterns: ["build"] }], root);
    const verdict = policy.check("RunCommand", SCOPE, { command: "lint" });
    expect(verdict.allowed).toBe(false);
    expect(verdict.allowed === false && verdict.reason).toContain("no subcommands are permitted for this stage");
  });

  // The run-2026-09-14T05-55-54-734Z audit: with an Exec escape hatch present
  // (scope.argvField set), the agent still stuffed a raw shell pipeline into
  // "command" four separate times -- "bun test foo.test.ts 2>&1 | head -200",
  // "bun scripts/check-test-escape-hatches.ts 2>&1 | head -30", and so on --
  // rather than ever trying "argv". A bare "permitted: <enum>" list does not
  // rule that reading out: it reads as "these are the good ones", not as
  // "this field can never hold a shell string, so stop trying one". RunCommand
  // is structurally shell-free regardless of what Exec's grant allows, so the
  // denial says so unconditionally once an argv escape hatch exists at all --
  // but a bare "use argv instead" would be dishonest whenever the compiled
  // Exec grant cannot actually serve the request (every one of the four real
  // denials in the audit was install-only-vs-"bun test"/"wc"), so the SAME
  // compiled grant `describeExecAllowlist` renders into the tool description
  // is named here too, letting the agent see in this one denial whether argv
  // would help before spending a second turn finding out.
  test("with an argv escape hatch present, the denial names what argv would actually accept", () => {
    const scopeWithArgv: ToolScope = { ...SCOPE, argvField: "argv" };
    const policy = compileToolPolicy(
      [
        { tool: "RunCommand", patterns: ["*"] },
        { tool: "Exec", patterns: ["bun install", "bun add*", "npm ci"] },
      ],
      root,
    );
    const verdict = policy.check("RunCommand", scopeWithArgv, {
      command: "bun test test/unit/x.test.ts 2>&1 | head -200",
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.allowed === false && verdict.reason).toContain("permitted: lint, test, testScoped, coverage");
    expect(verdict.allowed === false && verdict.reason).toContain('"command" never takes a shell string');
    // The field that accepts the listed forms must be named IN the same
    // clause as the list -- "permitted forms: bun install, ..." with no
    // named field reads as a second, unlabelled "permitted: <command
    // values>" list, which an agent can misread as more legal `command`
    // values (denying again on the enum, the very loop this exists to end).
    expect(verdict.allowed === false && verdict.reason).toContain(
      '"argv" accepts: permitted forms: bun install, bun add*, npm ci',
    );
  });

  test("with an argv escape hatch but no Exec grant at all, the denial reads as a dead end, not an invitation", () => {
    const scopeWithArgv: ToolScope = { ...SCOPE, argvField: "argv" };
    const policy = compileToolPolicy([{ tool: "RunCommand", patterns: ["*"] }], root);
    const verdict = policy.check("RunCommand", scopeWithArgv, { command: "wc -l src/x.ts" });
    expect(verdict.allowed).toBe(false);
    expect(verdict.allowed === false && verdict.reason).toContain('"command" never takes a shell string');
    expect(verdict.allowed === false && verdict.reason).toContain('"argv" accepts: no forms are currently granted');
  });

  // A discriminating pair, not two independent assertions: the with-argv
  // branch above must contain the literal "argv" and this branch must not,
  // so a regression that silently dropped the hint (leaving the structural
  // clause behind, say) fails one of the two rather than passing both.
  test("with no argv escape hatch, the denial does not mention argv at all", () => {
    const policy = compileToolPolicy([{ tool: "RunCommand", patterns: ["*"] }], root);
    const verdict = policy.check("RunCommand", SCOPE, { command: "bun test foo.test.ts | head -50" });
    expect(verdict.allowed).toBe(false);
    expect(verdict.allowed === false && verdict.reason).not.toContain("argv");
  });
});

/**
 * Spec R6: deny > ask > allow, evaluated per branch. Containment is the one
 * thing that outranks deny (a breach is not a policy decision). Nothing here
 * consults an AskResolver yet -- `check()` only MARKS ask; Task 5 resolves it.
 */
describe("compileToolPolicy — deny rules (spec R6)", () => {
  test("unconditional deny beats an unconditional allow, and de-advertises", () => {
    const policy = compileToolPolicy([{ tool: "Delete", patterns: ["*"] }], root, {
      denyRules: [{ tool: "Delete", patterns: ["*"] }],
    });
    const verdict = policy.check("Delete", PATH_SCOPE, { path: "src/x.ts" });
    expect(verdict.allowed).toBe(false);
    expect(verdict.allowed === false && verdict.outcome).toBe("denied");
    expect(policy.grantedTools()).not.toContain("Delete");
  });

  test("path-scoped deny refuses matching paths and leaves others allowed", () => {
    const policy = compileToolPolicy([{ tool: "Read", patterns: ["*"] }], root, {
      denyRules: [{ tool: "Read", patterns: [".env*"] }],
    });
    expect(policy.check("Read", PATH_SCOPE, { path: ".env.local" }).allowed).toBe(false);
    expect(policy.check("Read", PATH_SCOPE, { path: "src/index.ts" }).allowed).toBe(true);
    expect(policy.grantedTools()).toContain("Read"); // scoped deny does not de-advertise
  });

  test("verb deny refuses the verb, allows siblings", () => {
    const verbScope: ToolScope = {
      pathFields: [],
      verbField: "subcommand",
      allowedVerbs: ["diff", "log", "show"],
    };
    const policy = compileToolPolicy([{ tool: "Git", patterns: ["*"] }], root, {
      denyRules: [{ tool: "Git", patterns: ["show"] }],
    });
    expect(policy.check("Git", verbScope, { subcommand: "show" }).allowed).toBe(false);
    expect(policy.check("Git", verbScope, { subcommand: "diff" }).allowed).toBe(true);
  });
});

describe("compileToolPolicy — ask rules (spec R1/R6)", () => {
  test("an unconditional ask gates a granted tool with no policy fields", () => {
    const policy = compileToolPolicy([{ tool: "Glob", patterns: ["*"] }], root, {
      askRules: [{ tool: "Glob", patterns: ["*"] }],
    });

    const verdict = policy.check("Glob", { pathFields: [] }, { pattern: "src/**" });
    expect(verdict.allowed).toBe(false);
    expect(verdict.allowed === false && verdict.outcome).toBe("ask");
  });

  test("ask on a granted call yields outcome ask with resolvedPaths", () => {
    const policy = compileToolPolicy([{ tool: "Write", patterns: ["*"] }], root, {
      askRules: [{ tool: "Write", patterns: ["src/**"] }],
    });
    const verdict = policy.check("Write", PATH_SCOPE, { path: "src/x.ts" });
    expect(verdict.allowed).toBe(false);
    if (verdict.allowed === false) {
      expect(verdict.outcome).toBe("ask");
      expect(verdict.breach).toBe(false);
      expect(verdict.resolvedPaths?.length).toBe(1);
    }
  });

  test("deny beats ask on the same call", () => {
    const policy = compileToolPolicy([{ tool: "Write", patterns: ["*"] }], root, {
      denyRules: [{ tool: "Write", patterns: ["src/**"] }],
      askRules: [{ tool: "Write", patterns: ["src/**"] }],
    });
    const verdict = policy.check("Write", PATH_SCOPE, { path: "src/x.ts" });
    expect(verdict.allowed === false && verdict.outcome).toBe("denied");
  });

  test("ask does not grant: an ungranted tool with an ask rule stays plainly denied", () => {
    const policy = compileToolPolicy([], root, { askRules: [{ tool: "Write", patterns: ["*"] }] });
    const verdict = policy.check("Write", PATH_SCOPE, { path: "src/x.ts" });
    expect(verdict.allowed === false && verdict.outcome).toBe("denied");
  });

  test("containment breach beats ask", () => {
    const policy = compileToolPolicy([{ tool: "Write", patterns: ["*"] }], root, {
      askRules: [{ tool: "Write", patterns: ["*"] }],
    });
    const verdict = policy.check("Write", PATH_SCOPE, { path: "../outside.ts" });
    expect(verdict.allowed === false && verdict.breach).toBe(true);
    expect(verdict.allowed === false && verdict.outcome).toBe("denied");
  });

  test("ask does not grant in-branch: an ungranted PATH under a granted tool stays plainly denied", () => {
    // The tool is granted for src/** only; an ask on test/** must not widen the
    // grant, so the allow check still rejects the path.
    const policy = compileToolPolicy([{ tool: "Write", patterns: ["src/**"] }], root, {
      askRules: [{ tool: "Write", patterns: ["test/**"] }],
    });
    const verdict = policy.check("Write", PATH_SCOPE, { path: "test/x.ts" });
    expect(verdict.allowed === false && verdict.outcome).toBe("denied");
    expect(policy.check("Write", PATH_SCOPE, { path: "src/x.ts" }).allowed).toBe(true);
  });
});

/**
 * The argv branch (Exec) has its own deny/ask evaluation, separate from the
 * path branch: deny outranks ask and both match token-by-token. Untested before
 * Task 7's coverage pass.
 */
describe("compileToolPolicy — deny/ask on the Exec argv branch (spec R6)", () => {
  const ARGV_SCOPE: ToolScope = { pathFields: [], argvField: "argv" };

  test("an argv deny refuses the matching form and allows the rest", () => {
    const policy = compileToolPolicy([{ tool: "Exec", patterns: ["*"] }], root, {
      denyRules: [{ tool: "Exec", patterns: ["npm publish*"] }],
    });
    const denied = policy.check("Exec", ARGV_SCOPE, { argv: ["npm", "publish"] });
    expect(denied.allowed === false && denied.outcome).toBe("denied");
    expect(policy.check("Exec", ARGV_SCOPE, { argv: ["bun", "add", "x"] }).allowed).toBe(true);
  });

  test("an argv ask marks the call for approval with no resolved paths", () => {
    const policy = compileToolPolicy([{ tool: "Exec", patterns: ["*"] }], root, {
      askRules: [{ tool: "Exec", patterns: ["npm publish*"] }],
    });
    const verdict = policy.check("Exec", ARGV_SCOPE, { argv: ["npm", "publish"] });
    expect(verdict.allowed).toBe(false);
    if (verdict.allowed === false) {
      expect(verdict.outcome).toBe("ask");
      expect(verdict.resolvedPaths).toEqual([]);
    }
  });
});

/**
 * `compileRuleMap` MERGES rules for the same tool (patterns concatenated, any
 * `"*"` making the entry unconditional). Unlike the allow compiler, it must
 * never let a later rule silently drop an earlier one.
 */
describe("compileToolPolicy — deny/ask rules for one tool merge (spec Task 4)", () => {
  test("two deny rules for one tool both keep applying", () => {
    const policy = compileToolPolicy([{ tool: "Write", patterns: ["*"] }], root, {
      denyRules: [
        { tool: "Write", patterns: ["src/a*"] },
        { tool: "Write", patterns: ["test/**"] },
      ],
    });
    expect(policy.check("Write", PATH_SCOPE, { path: "src/a.ts" }).allowed).toBe(false);
    expect(policy.check("Write", PATH_SCOPE, { path: "test/x.ts" }).allowed).toBe(false);
    expect(policy.check("Write", PATH_SCOPE, { path: "docs/x.md" }).allowed).toBe(true);
  });

  test("a wildcard in ANY merged rule makes the entry unconditional", () => {
    // Wildcard first: a last-write-wins compiler would keep the later scoped
    // rule and leave Delete advertised. Merging must not.
    const policy = compileToolPolicy([{ tool: "Delete", patterns: ["*"] }], root, {
      denyRules: [
        { tool: "Delete", patterns: ["*"] },
        { tool: "Delete", patterns: ["src/**"] },
      ],
    });
    expect(policy.grantedTools()).not.toContain("Delete");
  });

  test("reports the configured ask expression that matched", () => {
    const policy = compileToolPolicy([{ tool: "Read", patterns: ["*"] }], root, {
      askRules: [
        { tool: "Read", patterns: ["src/**"] },
        { tool: "Read", patterns: ["test/**"] },
      ],
    });

    const verdict = policy.check("Read", { pathFields: ["path"] }, { path: "test/a.ts" });

    expect(verdict.allowed).toBe(false);
    if (verdict.allowed === false) expect(verdict.rule).toBe("Read(test/**)");
  });
});
