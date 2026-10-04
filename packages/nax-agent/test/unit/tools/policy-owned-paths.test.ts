/**
 * The owned-path refusals the policy applies at (and through) the containment
 * seam: `.git/` metadata (nax#1943), nax config files, nax-owned run state,
 * the plan-op PRD exemption (nax#2115) and the allowWrite opt-ins (nax#2260).
 *
 * S3-2: all of these now arrive through the injected OwnedPathsPolicy port,
 * so the port consumption itself (compileToolPolicy's `ownedPaths` option and
 * resolveWithin's third parameter) is pinned here too.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EMPTY_OWNED_PATHS_POLICY, type OwnedPathsPolicy } from "#src/tools/owned-paths";
import { compileToolPolicy, resolveWithin } from "#src/tools/policy";
import type { PolicyVerdict, ToolScope } from "#src/tools/types";
import { naxOwnedPathsPolicy } from "#test/helpers/nax-owned-paths";

const PATH_SCOPE: ToolScope = { pathFields: ["path"] };
let root: string;
let outside: string;

beforeAll(() => {
  // realpathSync: on macOS mkdtemp sits behind a /var -> /private/var symlink,
  // and the port-consumption pins compare join(root, ...) spellings against
  // resolveWithin's symlink-resolved output.
  const base = realpathSync(mkdtempSync(join(tmpdir(), "policy-owned-")));
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
  // Lives OUTSIDE the root and resolves INTO .git/, exercising the seam's
  // symlink resolution from an out-of-root spelling.
  symlinkSync(join(root, ".git", "index"), join(outside, "touched-link"));

  // Fixture for the nax-config seam describe.
  mkdirSync(join(root, ".nax"), { recursive: true });
  writeFileSync(join(root, ".nax", "config.json"), "{}");
});

const ALL = [
  { tool: "Write", patterns: ["*"] },
  { tool: "Read", patterns: ["*"] },
];

function reasonOf(verdict: PolicyVerdict): string {
  if (verdict.allowed) throw new Error("expected a denial");
  return verdict.reason;
}

describe("compileToolPolicy and resolveWithin consume the OwnedPathsPolicy port", () => {
  test("with no ownedPaths (the embedder default) nax config is an ordinary file", () => {
    const policy = compileToolPolicy(ALL, root);
    expect(policy.check("Read", PATH_SCOPE, { path: ".nax/config.json" }).allowed).toBe(true);
    expect(resolveWithin(root, ".nax/config.json", EMPTY_OWNED_PATHS_POLICY)).toBe(join(root, ".nax", "config.json"));
  });

  test("with no ownedPaths, containment and the .git refusal still hold", () => {
    const policy = compileToolPolicy(ALL, root);
    expect(policy.check("Read", PATH_SCOPE, { path: "../outside" }).allowed).toBe(false);
    expect(policy.check("Write", PATH_SCOPE, { path: ".git/config", content: "x" }).allowed).toBe(false);
    expect(resolveWithin(root, ".git/config", EMPTY_OWNED_PATHS_POLICY)).toBeNull();
  });

  test("nax's policy restores today's config refusal and reason", () => {
    const policy = compileToolPolicy(ALL, root, { ownedPaths: naxOwnedPathsPolicy });
    const verdict = policy.check("Read", PATH_SCOPE, { path: ".nax/config.json" });
    expect(reasonOf(verdict)).toBe(
      `path ".nax/config.json" ${naxOwnedPathsPolicy.configRefusal(root, join(root, ".nax", "config.json"))}`,
    );
    expect(resolveWithin(root, ".nax/config.json", naxOwnedPathsPolicy)).toBeNull();
  });

  test("any injected policy is honoured: a custom writeRefusal and configRefusal fire", () => {
    const custom: OwnedPathsPolicy = {
      ...EMPTY_OWNED_PATHS_POLICY,
      writeRefusal: (_tool, rel) => (rel === "owned.txt" ? `"${rel}" belongs to the host` : undefined),
      configRefusal: (_root, resolved) => (resolved.endsWith("host.cfg") ? "is the host's config" : undefined),
    };
    const policy = compileToolPolicy(ALL, root, { ownedPaths: custom });
    expect(reasonOf(policy.check("Write", PATH_SCOPE, { path: "owned.txt", content: "x" }))).toBe(
      'Write may not modify "owned.txt" belongs to the host',
    );
    expect(reasonOf(policy.check("Read", PATH_SCOPE, { path: "host.cfg" }))).toBe(
      'path "host.cfg" is the host\'s config',
    );
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
    expect(resolveWithin(root, ".git/index", naxOwnedPathsPolicy)).toBeNull();
    expect(resolveWithin(root, ".git", naxOwnedPathsPolicy)).toBeNull();
  });

  test("resolveWithin denies a NON-leading .git segment (nested repo / submodule)", () => {
    expect(resolveWithin(root, "vendor/nested-repo/.git/config", naxOwnedPathsPolicy)).toBeNull();
    expect(resolveWithin(root, "vendor/nested-repo/.git", naxOwnedPathsPolicy)).toBeNull();
  });

  test("resolveWithin still permits paths that merely LOOK like .git by substring", () => {
    // A naive startsWith(".git") would wrongly swallow all three of these.
    expect(resolveWithin(root, ".gitignore", naxOwnedPathsPolicy)).not.toBeNull();
    expect(resolveWithin(root, ".gitattributes", naxOwnedPathsPolicy)).not.toBeNull();
    expect(resolveWithin(root, ".github/workflows/ci.yml", naxOwnedPathsPolicy)).not.toBeNull();
  });

  test("resolveWithin denies a symlink whose target lives under .git/", () => {
    expect(resolveWithin(root, "link-into-git", naxOwnedPathsPolicy)).toBeNull();
  });

  test("a path spelled from OUTSIDE the root that resolves into .git/ is refused", () => {
    // `isInside` resolves symlinks on both sides, so this is caught by the
    // in-root branch rather than needing a `.git/` check of its own.
    // PR2/Task 13: the execTouchedPaths carve-out that used to re-admit such
    // a path from an out-of-root spelling is retired, so there is no second
    // route to assert against.
    const viaOutside = join(outside, "touched-link");
    expect(resolveWithin(root, viaOutside, naxOwnedPathsPolicy)).toBeNull();
  });

  test("check() denies a .git/ path even under an unconditional '*' grant", () => {
    const policy = compileToolPolicy([{ tool: "Write", patterns: ["*"] }], root, { ownedPaths: naxOwnedPathsPolicy });
    const verdict = policy.check("Write", PATH_SCOPE, { path: ".git/index" });
    expect(verdict.allowed).toBe(false);
  });

  test("check()'s denial message names git metadata, not a generic 'outside the root' claim", () => {
    // The path IS inside the root, so the generic message would be actively
    // misleading here -- it must get its own accurate reason (see
    // outOfRootReason in policy.ts).
    const policy = compileToolPolicy([{ tool: "Write", patterns: ["*"] }], root, { ownedPaths: naxOwnedPathsPolicy });
    const verdict = policy.check("Write", PATH_SCOPE, { path: ".git/index" });
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) {
      expect(verdict.reason).toContain("git");
      expect(verdict.reason).not.toContain("resolves outside the permitted root");
    }
  });

  test("check() still denies an actually-out-of-root path with the generic message", () => {
    const policy = compileToolPolicy([{ tool: "Write", patterns: ["*"] }], root, { ownedPaths: naxOwnedPathsPolicy });
    const verdict = policy.check("Write", PATH_SCOPE, { path: join(outside, "secret.txt") });
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.reason).toContain("resolves outside the permitted root");
  });

  test("check() denials for .git/ are still breaches, the same as any other containment denial", () => {
    const policy = compileToolPolicy([{ tool: "Write", patterns: ["*"] }], root, { ownedPaths: naxOwnedPathsPolicy });
    const verdict = policy.check("Write", PATH_SCOPE, { path: ".git/index" });
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.breach).toBe(true);
  });

  test("a scoped glob grant does not accidentally re-admit .git/ via a wildcard", () => {
    const policy = compileToolPolicy([{ tool: "Write", patterns: ["**"] }], root, { ownedPaths: naxOwnedPathsPolicy });
    expect(policy.check("Write", PATH_SCOPE, { path: ".git/index" }).allowed).toBe(false);
  });

  test("ordinary paths are unaffected", () => {
    const policy = compileToolPolicy([{ tool: "Write", patterns: ["*"] }], root, { ownedPaths: naxOwnedPathsPolicy });
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
      expect(resolveWithin(root, candidate, naxOwnedPathsPolicy)).toBeNull();
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
    expect(resolveWithin(root, candidate, naxOwnedPathsPolicy)).not.toBeNull();
  });

  test("check() denies .nax/config.json even under an unconditional '*' grant", () => {
    const policy = compileToolPolicy([{ tool: "Write", patterns: ["*"] }], root, { ownedPaths: naxOwnedPathsPolicy });
    expect(policy.check("Write", PATH_SCOPE, { path: ".nax/config.json" }).allowed).toBe(false);
  });

  test("the denial names nax config, not a generic 'outside the root' claim", () => {
    const policy = compileToolPolicy([{ tool: "Write", patterns: ["*"] }], root, { ownedPaths: naxOwnedPathsPolicy });
    const verdict = policy.check("Write", PATH_SCOPE, { path: ".nax/config.json" });
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) {
      expect(verdict.reason).toContain("nax");
      expect(verdict.reason).not.toContain("resolves outside the permitted root");
    }
  });

  test("reads are refused too -- the file names what a later run will execute", () => {
    const policy = compileToolPolicy([{ tool: "Read", patterns: ["*"] }], root, { ownedPaths: naxOwnedPathsPolicy });
    expect(policy.check("Read", PATH_SCOPE, { path: ".nax/config.json" }).allowed).toBe(false);
  });
});

describe("compileToolPolicy — nax-owned run state", () => {
  test("Write is refused for a feature PRD even under an unconditional grant", () => {
    const policy = compileToolPolicy([{ tool: "Write", patterns: ["*"] }], root, { ownedPaths: naxOwnedPathsPolicy });
    const verdict = policy.check("Write", PATH_SCOPE, { path: ".nax/features/auth/prd.json" });
    expect(verdict.allowed).toBe(false);
    expect(verdict.allowed === false && verdict.reason).toContain("acceptance criteria");
  });

  test("Read is still allowed for the same path", () => {
    const policy = compileToolPolicy([{ tool: "Read", patterns: ["*"] }], root, { ownedPaths: naxOwnedPathsPolicy });
    expect(policy.check("Read", PATH_SCOPE, { path: ".nax/features/auth/prd.json" }).allowed).toBe(true);
  });
});

describe("compileToolPolicy — plan-op PRD write exemption (nax#2115)", () => {
  const PRD_REL = ".nax/features/auth/prd.json";
  const grants = [{ tool: "Write", patterns: ["**"] }];

  test("without the exemption, the plan op's own fileOutput path is denied", () => {
    const policy = compileToolPolicy(grants, root, { ownedPaths: naxOwnedPathsPolicy });
    const verdict = policy.check("Write", PATH_SCOPE, { path: PRD_REL });
    expect(verdict.allowed).toBe(false);
    expect(verdict.allowed === false && verdict.reason).toContain("nax's own run state");
  });

  test("with the exemption, that exact path is allowed", () => {
    const policy = compileToolPolicy(grants, root, {
      ownedPaths: naxOwnedPathsPolicy,
      ownedWriteExemption: join(root, PRD_REL),
    });
    expect(policy.check("Write", PATH_SCOPE, { path: PRD_REL }).allowed).toBe(true);
  });

  test("the exemption does not open a sibling feature's PRD", () => {
    const policy = compileToolPolicy(grants, root, {
      ownedPaths: naxOwnedPathsPolicy,
      ownedWriteExemption: join(root, PRD_REL),
    });
    const verdict = policy.check("Write", PATH_SCOPE, { path: ".nax/features/billing/prd.json" });
    expect(verdict.allowed).toBe(false);
    expect(verdict.allowed === false && verdict.reason).toContain("nax's own run state");
  });

  test("an alternate spelling of the exempt path still resolves to it and is allowed", () => {
    const policy = compileToolPolicy(grants, root, {
      ownedPaths: naxOwnedPathsPolicy,
      ownedWriteExemption: join(root, PRD_REL),
    });
    expect(policy.check("Write", PATH_SCOPE, { path: "./.nax/features/auth/prd.json" }).allowed).toBe(true);
    expect(policy.check("Write", PATH_SCOPE, { path: ".nax/features/../features/auth/prd.json" }).allowed).toBe(true);
  });

  // The exempt PRD does NOT exist when the policy compiles -- `nax plan` creates
  // its feature dir but the agent writes the file afterwards. `root` here is a
  // mkdtemp path, which on macOS sits behind a /var -> /private/var symlink, so
  // this also pins that realOrRaw resolves an absent leaf via its nearest
  // existing ancestor. If it fell back to the raw path, resolvedRoot (realpathed)
  // and the exemption would disagree and the exemption would go SILENTLY inert.
  test("exempts a path that does not exist yet, behind a symlinked root", () => {
    expect(existsSync(join(root, PRD_REL))).toBe(false);
    const policy = compileToolPolicy(grants, root, {
      ownedPaths: naxOwnedPathsPolicy,
      ownedWriteExemption: join(root, PRD_REL),
    });
    expect(policy.check("Write", PATH_SCOPE, { path: PRD_REL }).allowed).toBe(true);
  });

  test("the exemption never widens the nax CONFIG refusal", () => {
    const policy = compileToolPolicy(grants, root, {
      ownedPaths: naxOwnedPathsPolicy,
      ownedWriteExemption: join(root, ".nax/config.json"),
    });
    expect(policy.check("Write", PATH_SCOPE, { path: ".nax/config.json" }).allowed).toBe(false);
  });
});

describe("compileToolPolicy — .nax/ state and the allowWrite opt-in (nax#2260)", () => {
  const grants = [{ tool: "Write", patterns: ["**"] }];

  test("a Write under .nax/rules is refused by default, the scratchpad is not", () => {
    const policy = compileToolPolicy(grants, root, { ownedPaths: naxOwnedPathsPolicy });
    const verdict = policy.check("Write", PATH_SCOPE, { path: ".nax/rules/a.md" });
    expect(verdict.allowed === false && verdict.reason).toContain("execution.sandbox.filesystem.allowWrite");
    expect(policy.check("Write", PATH_SCOPE, { path: ".nax/scratchpad/p.ts" }).allowed).toBe(true);
  });

  test("a symlink inside the scratchpad cannot reach .nax/rules", () => {
    mkdirSync(join(root, ".nax", "rules"), { recursive: true });
    mkdirSync(join(root, ".nax", "scratchpad"), { recursive: true });
    symlinkSync(join(root, ".nax", "rules"), join(root, ".nax", "scratchpad", "rules-link"));
    const verdict = compileToolPolicy(grants, root, { ownedPaths: naxOwnedPathsPolicy }).check("Write", PATH_SCOPE, {
      path: ".nax/scratchpad/rules-link/x.md",
    });
    expect(verdict.allowed).toBe(false);
  });

  test("naxAllowWrite opens the listed entry and nothing else", () => {
    const policy = compileToolPolicy(grants, root, { ownedPaths: naxOwnedPathsPolicy, naxAllowWrite: [".nax/rules"] });
    expect(policy.check("Write", PATH_SCOPE, { path: ".nax/rules/a.md" }).allowed).toBe(true);
    expect(policy.check("Write", PATH_SCOPE, { path: ".nax/context.md" }).allowed).toBe(false);
  });
});
