/**
 * Tool-declared path confinement (`ToolScope.confineTo`).
 *
 * Containment is the load-bearing decision and lives in ONE seam
 * (`resolveWithin` in `src/tools/policy.ts`). `confineTo` shifts the root
 * passed to that seam from `<root>` to `<root>/<confineTo>` so the same code
 * path enforces both the policy root and the tool's narrower declared
 * subtree, while grant matching keeps the repo-root-relative spelling so
 * deny rules and `naxOwnedWriteRefusal` still see the canonical path.
 *
 * Each AC below pins one observable behaviour of that shift. The fixture is
 * the canonical scratchpad shape: `.nax/scratchpad/` inside a repository root,
 * one symlink that escapes the root, and an out-of-root sibling dir for
 * absolute-path tests.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolScope } from "@/tools";
import { compileToolPolicy } from "@/tools";

let root: string;
let outside: string;

beforeAll(() => {
  const base = mkdtempSync(join(tmpdir(), "nax-policy-confine-to-"));
  root = join(base, "repo");
  const scratchpad = join(root, ".nax", "scratchpad");
  outside = join(base, "elsewhere");
  mkdirSync(root, { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(scratchpad, { recursive: true });
  mkdirSync(outside, { recursive: true });

  // AC1 / AC6 / AC8: a non-secret note in the confined directory.
  writeFileSync(join(scratchpad, "notes.md"), "# notes\n");

  // AC2: a path the policy root contains but the confined directory does not.
  writeFileSync(join(root, "src", "index.ts"), "export {};\n");

  // AC7: a path the confined directory contains that the deny rule matches.
  writeFileSync(join(scratchpad, "secret.txt"), "shh\n");

  // AC4: a symlink INSIDE the confined directory that targets outside the root.
  symlinkSync(outside, join(scratchpad, "escape-link"));
});

// `confineTo` is the new field this story adds; the type's definition lives in
// `src/tools/types.ts` and is updated by the implementer. Until then, the
// intersection type below keeps the test file compiling under the strict
// `tsconfig.test.json` gate without falling back to the ratchet-forbidden
// double-cast form -- the property is just absent on the public type, not
// private, and once added it is narrower than `ToolScope & { confineTo }`
// (which still type-checks).
type ToolScopeWithConfineTo = ToolScope & { confineTo: string };

function confinedScope(): ToolScopeWithConfineTo {
  return { pathFields: ["path"], confineTo: ".nax/scratchpad" };
}

// AC1: the allowed verdict for a path inside the confined directory resolves
// to the absolute path `<root>/<confineTo>/<value>`, and that is the single
// entry in `resolvedPaths` -- NOT a sibling listing or the root spelling.
describe("AC1: unconditional grant + confineTo resolves a confined path", () => {
  test("the allowed verdict has exactly <root>/.nax/scratchpad/notes.md as the single resolved path", () => {
    const policy = compileToolPolicy([{ tool: "ScratchpadWrite", patterns: ["*"] }], root);
    const verdict = policy.check("ScratchpadWrite", confinedScope(), { path: "notes.md" });
    expect(verdict.allowed).toBe(true);
    if (!verdict.allowed) throw new Error("unreachable");
    // The resolved path is the policy's OWN realpathed root joined with the
    // confined directory, not the test's raw mkdtemp path -- macOS symlinks
    // /tmp to /private/tmp and `resolveWithin` runs everything through
    // `realOrRaw`, so the test must compare like with like.
    expect(verdict.resolvedPaths).toEqual([join(policy.root, ".nax", "scratchpad", "notes.md")]);
    expect(verdict.resolvedPaths.length).toBe(1);
  });
});

// AC2: a relative `..` traversal that escapes the confined directory is a
// containment breach.
describe("AC2: confineTo refuses '..' traversal out of the confined directory", () => {
  test("the refused verdict has breach: true and a reason naming the requested path", () => {
    const policy = compileToolPolicy([{ tool: "ScratchpadWrite", patterns: ["*"] }], root);
    const verdict = policy.check("ScratchpadWrite", confinedScope(), { path: "../../src/index.ts" });
    expect(verdict.allowed).toBe(false);
    if (verdict.allowed) throw new Error("unreachable");
    expect(verdict.breach).toBe(true);
    // The reason must name the path the model just passed in, so an agent can
    // see what it asked for and adapt. The reason text is otherwise free-form;
    // we pin the requested path and the breach signal.
    expect(verdict.reason).toContain("../../src/index.ts");
  });

  // Discriminating companion: the AC2 literal path also escapes the policy
  // root (a `..` always does from `<root>`), so its outcome -- refused,
  // breach, requested path named -- would pass even without confineTo. The
  // reason text names the resolved root, and THAT differs: pre-feature it
  // is the policy root, post-feature it is the confined directory. Pinning
  // the confined root in the reason is what proves the confineTo shift is
  // actually doing the confining.
  test("the refusal reason names the confined directory, not the policy root", () => {
    const policy = compileToolPolicy([{ tool: "ScratchpadWrite", patterns: ["*"] }], root);
    const verdict = policy.check("ScratchpadWrite", confinedScope(), { path: "../../src/index.ts" });
    expect(verdict.allowed).toBe(false);
    if (verdict.allowed) throw new Error("unreachable");
    // The confined directory under the policy's realpathed root, so the test
    // works regardless of the /tmp -> /private/tmp symlink macOS introduces.
    const confinedRoot = join(policy.root, ".nax", "scratchpad");
    expect(verdict.reason).toContain(confinedRoot);
  });
});

// AC3: an absolute path outside the confined directory is a containment
// breach. The whole-machine escape is the same shape as the `..` traversal
// once `resolveWithin` reaches `isInside` with the confined root.
describe("AC3: confineTo refuses an absolute path outside the confined directory", () => {
  test("an absolute path under the policy root but outside the confined directory is a breach", () => {
    // Inside the repo root, but above the confined directory -- containment
    // is the SHIFTED root, not the policy root. This is the discriminating
    // case: the path resolves INSIDE the policy root (allowed pre-feature) but
    // OUTSIDE the confined directory (breach post-feature), so it pins the
    // confineTo shift rather than the policy-root containment that already
    // existed.
    const policy = compileToolPolicy([{ tool: "ScratchpadWrite", patterns: ["*"] }], root);
    const verdict = policy.check("ScratchpadWrite", confinedScope(), { path: join(root, "src", "index.ts") });
    expect(verdict.allowed).toBe(false);
    if (verdict.allowed) throw new Error("unreachable");
    expect(verdict.breach).toBe(true);
  });
});

// AC4: a symlink INSIDE the confined directory whose target sits outside the
// repository root is refused. `resolveWithin` symlink-resolves through
// `realOrRaw`, so this case is the same seam once the path is spelled from
// inside the confined directory.
describe("AC4: confineTo refuses a symlink inside the confined directory targeting outside the root", () => {
  test("the symlink escape from inside .nax/scratchpad/ is refused", () => {
    const policy = compileToolPolicy([{ tool: "ScratchpadWrite", patterns: ["*"] }], root);
    const verdict = policy.check("ScratchpadWrite", confinedScope(), { path: "escape-link/secret.txt" });
    expect(verdict.allowed).toBe(false);
  });
});

// AC5: a scope omitting `confineTo` resolves against the POLICY root. The
// `confineTo` field is opt-in; existing path-bearing tools must keep working
// with the original behaviour. This is the regression guard for the no-op
// case.
describe("AC5: a scope without confineTo resolves against the policy root", () => {
  test("a path inside the repo resolves to <root>/<value>", () => {
    const policy = compileToolPolicy([{ tool: "Write", patterns: ["*"] }], root);
    const verdict = policy.check("Write", { pathFields: ["path"] }, { path: "src/index.ts" });
    expect(verdict.allowed).toBe(true);
    if (!verdict.allowed) throw new Error("unreachable");
    expect(verdict.resolvedPaths).toEqual([join(policy.root, "src", "index.ts")]);
  });
});

// AC6: grant matching still uses the REPO-ROOT-RELATIVE spelling, not the
// confined root. The grant `[".nax/scratchpad/**"]` matches a confined
// `notes.md` because the path is `relative(resolvedRoot, ...)`, NOT
// `relative(<root>/<confineTo>, ...)`. This is what lets existing grant globs,
// deny rules and `naxOwnedWriteRefusal` keep working unchanged.
describe("AC6: a confined path is grant-matched against repo-root-relative globs", () => {
  test("grant ['.nax/scratchpad/**'] matches confined notes.md", () => {
    const policy = compileToolPolicy([{ tool: "ScratchpadWrite", patterns: [".nax/scratchpad/**"] }], root);
    const verdict = policy.check("ScratchpadWrite", confinedScope(), { path: "notes.md" });
    expect(verdict.allowed).toBe(true);
  });

  test("the grant spelling stays repo-root-relative (no leading 'scratchpad/' or duplication of confineTo)", () => {
    // If the relative-path shift leaked confineTo into grant matching, the
    // canonical grant `.nax/scratchpad/**` would NOT match and this would
    // resolve as an ungranted denial. We assert the path is allowed under
    // the canonical grant spelling -- which is what authors will write.
    const policy = compileToolPolicy([{ tool: "ScratchpadWrite", patterns: [".nax/scratchpad/**"] }], root);
    const verdict = policy.check("ScratchpadWrite", confinedScope(), { path: "notes.md" });
    expect(verdict.allowed).toBe(true);
  });
});

// AC7 / AC8: deny rules run against the same repo-root-relative path, so a
// deny rule for `.nax/scratchpad/secret*` refuses confined `secret.txt`
// (AC7) and a non-matching confined path is still allowed under a permissive
// grant (AC8). These pin that the confined-vs-policy-root shift does not
// ripple into deny/ask evaluation -- the load-bearing promise of the design.
describe("AC7: a deny rule for .nax/scratchpad/secret* refuses confined secret.txt", () => {
  test("confined secret.txt is refused under an unconditional grant with a deny rule", () => {
    const policy = compileToolPolicy([{ tool: "ScratchpadWrite", patterns: ["*"] }], root, {
      denyRules: [{ tool: "ScratchpadWrite", patterns: [".nax/scratchpad/secret*"] }],
    });
    const verdict = policy.check("ScratchpadWrite", confinedScope(), { path: "secret.txt" });
    expect(verdict.allowed).toBe(false);
  });

  test("the refusal is a deny (breach: false), not a containment breach", () => {
    // secret.txt IS inside the confined directory; the refusal is the deny
    // rule, not containment. A breach would mis-attribute the cause and would
    // log at warn for what is actually a configured rule.
    const policy = compileToolPolicy([{ tool: "ScratchpadWrite", patterns: ["*"] }], root, {
      denyRules: [{ tool: "ScratchpadWrite", patterns: [".nax/scratchpad/secret*"] }],
    });
    const verdict = policy.check("ScratchpadWrite", confinedScope(), { path: "secret.txt" });
    expect(verdict.allowed).toBe(false);
    if (verdict.allowed) throw new Error("unreachable");
    expect(verdict.breach).toBe(false);
  });
});

describe("AC8: the same deny rule allows a confined non-secret path", () => {
  test("confined notes.md is allowed when the deny rule only matches secret*", () => {
    const policy = compileToolPolicy([{ tool: "ScratchpadWrite", patterns: ["*"] }], root, {
      denyRules: [{ tool: "ScratchpadWrite", patterns: [".nax/scratchpad/secret*"] }],
    });
    const verdict = policy.check("ScratchpadWrite", confinedScope(), { path: "notes.md" });
    expect(verdict.allowed).toBe(true);
  });
});
