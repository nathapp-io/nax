# PR 6 — Exec `target:"repoRoot"` must resolve inside the story's worktree (#2093)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Stop a repo-scoped `Exec` in an isolated story writing the user's real working tree.

**Architecture:** Add a `storyExecRoot` helper beside the existing `.nax-wt` prefix logic in the package registry, and point `codingToolRepoRoot` at it instead of the main checkout.

**Overview:** [`00-overview.md`](./00-overview.md) — read its Global Constraints first.

**Base:** `main` @ `71071a035`.

**Independent and unrelated to path frames.** Last by ruling, not by dependency — it can ship at any time.

---

## Global Constraints

See [`00-overview.md`](./00-overview.md#global-constraints). The ones that bite here, and they bite hard:

- **`src/operations/call.ts` is at 597/600 lines.** Three lines of headroom. The change there is a **same-line substitution** — do not add a line, not even a comment.
- **`test/unit/operations/call.test.ts` is grandfathered at 967 lines and may not grow by one line.** New tests go in new files.
- `bun run typecheck && bun run lint && bun run test` green before committing, plus `bun run test:coverage`.

---

## The defect

**This is the most damaging item in the bundle.** Under `storyIsolation: "worktree"`, an `Exec` with `target: "repoRoot"` runs in the **main checkout**, not the story's worktree. A repo-scoped `bun install` / `pnpm add` therefore writes the user's real working tree — its `package.json`, its lockfile, its `node_modules` — on their real branch, while the story's commits and the merge machinery operate on the worktree.

The story's own tree does not receive the install, so a later build in the worktree can fail for a dependency the agent believes it added.

### The chain, verified on `71071a035`

1. `src/operations/call.ts:254-255`
   ```ts
   codingToolRoot: packageWorkdir(ctx.packageView),   // worktree package dir — correct
   codingToolRepoRoot: ctx.packageView.repoRoot,      // MAIN CHECKOUT
   ```
   The adjacent comment at `:256-259` independently confirms the asymmetry: it describes `codingToolRoot` as "a package workdir inside the story's worktree". Its sibling one line up is not.

2. `src/agents/coding-tool-support.ts:389` maps `options.codingToolRepoRoot` → `args.repoRoot`.

3. `src/agents/coding-tool-support.ts:167-168`
   ```ts
   repoRoot: args.repoRoot ?? args.root,
   packageWorkdir: args.root,
   ```
   `args.root` (the worktree package dir) feeds only `packageWorkdir`; `repoRoot` takes the main-checkout value whenever supplied.

4. `src/tools/package-managers.ts:394` — and the `!entry` fallback at `:397-401`, identical ternary:
   ```ts
   return { argv, cwd: effectiveTarget === "package" ? input.packageWorkdir : input.repoRoot };
   ```

`packageView.repoRoot` is the registry's `workdir`, captured **once per run** in `createRuntime` (`src/runtime/index.ts:425`) and stamped onto every view (`src/runtime/packages.ts:64`). Nothing ever re-points it at a worktree.

Worktrees live *under* it at `<repoRoot>/.nax-wt/<storyId>/` (`src/worktree/manager.ts:122`), and `packageWorkdir()` (`src/runtime/packages.ts:43-47`) reconstructs the worktree path by joining the `.nax-wt/...`-prefixed `packageDir` back onto `repoRoot` — which is exactly why `codingToolRoot` is right and `codingToolRepoRoot` is wrong.

### Also fix while here

`package-managers.ts:366`:

```ts
const effectiveTarget: ExecTarget = packageRelPath === "" ? "repoRoot" : target;
```

A root-level package silently collapses to `repoRoot`, taking the same wrong branch even when the caller asked for `"package"`.

### Why it is silent

The worktree is a subdirectory of the main checkout, so `isInside(mainCheckout, ...)` is true and containment approves (`src/tools/policy.ts:95-103`). `resolveWithin`'s `execTouchedPaths` carve-out (declared `:120`, read `:149`, applied at `:370`, `:456`, `:482`, `:503`, `:529`) then admits the recorded main-checkout manifest and lockfile paths for a subsequent `GitCommit` **in the same hop** — so a worktree story can stage a main-checkout file. Nothing logs a path outside the story's tree.

### The inverse mistake is already guarded

`src/runtime/packages.ts:103-116` warns against shortening the package key, which "would point every file tool at the main checkout instead of the worktree" (nax#2069). **This is the same hazard reached from the other end.** Write the fix so both stay true, and put the new helper beside `toOverrideKey` so the two invariants are stated in one place.

### No existing coverage

Verified: every `target: "repoRoot"` test uses synthetic non-worktree roots — `test/unit/tools/package-managers.test.ts:41` expects `cwd: "/repo"`; `test/unit/tools/run-command-exec-touched-paths.test.ts:16-17` fixes `repoRoot: "/repo"`. No test file contains both `.nax-wt` and `target: "repoRoot"`, and the worktree-aware suites never exercise `Exec`.

---

## Files

- Modify: `src/runtime/packages.ts` — add `storyExecRoot`, export from the barrel.
- Modify: `src/tools/package-managers.ts:366` — the root-package collapse.
- Modify: `src/operations/call.ts:255` — **one-line substitution only**.
- Test: `test/unit/runtime/story-exec-root.test.ts` (new)
- Test: `test/unit/tools/package-managers-worktree.test.ts` (new)

## Interfaces

- **Produces:** `storyExecRoot(view: { repoRoot: string; packageDir?: string }): string` — the root of the tree the story is actually executing in. Returns `<repoRoot>/.nax-wt/<storyId>` when `packageDir` carries the worktree prefix, else `repoRoot`.

---

- [ ] **Step 1: Write the failing helper test**

```ts
// test/unit/runtime/story-exec-root.test.ts
import { describe, expect, test } from "bun:test";
import { storyExecRoot } from "@/runtime/packages";

describe("storyExecRoot (nax#2093)", () => {
  test("returns the worktree root for a worktree-prefixed package", () => {
    expect(storyExecRoot({ repoRoot: "/repo", packageDir: ".nax-wt/US-003/packages/api" }))
      .toBe("/repo/.nax-wt/US-003");
  });

  test("returns the worktree root for a worktree-prefixed ROOT package", () => {
    expect(storyExecRoot({ repoRoot: "/repo", packageDir: ".nax-wt/US-003" }))
      .toBe("/repo/.nax-wt/US-003");
  });

  test("returns repoRoot when the story is not isolated", () => {
    expect(storyExecRoot({ repoRoot: "/repo", packageDir: "packages/api" })).toBe("/repo");
  });

  test("returns repoRoot when there is no packageDir", () => {
    expect(storyExecRoot({ repoRoot: "/repo" })).toBe("/repo");
  });

  test("does not treat a package literally named nax-wt as a worktree", () => {
    expect(storyExecRoot({ repoRoot: "/repo", packageDir: "nax-wt/pkg" })).toBe("/repo");
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `bun test test/unit/runtime/story-exec-root.test.ts`
Expected: FAIL — `storyExecRoot` is not exported from `@/runtime/packages`.

- [ ] **Step 3: Implement `storyExecRoot`**

Add to `src/runtime/packages.ts` immediately after `toOverrideKey`, and export from the module barrel.

```ts
/**
 * The root of the tree the story is actually executing in.
 *
 * `PackageView.repoRoot` is the MAIN CHECKOUT -- captured once per run in
 * createRuntime() and stamped on every view, never re-pointed at a worktree.
 * Under storyIsolation "worktree" an Exec with target "repoRoot" resolved
 * against it wrote the user's real working tree (nax#2093).
 *
 * Counterpart to toOverrideKey above: that one strips the `.nax-wt/<storyId>`
 * prefix for the OVERRIDE LOOKUP; this one keeps it, because a repo-scoped
 * command must run inside the story's own tree. Both rest on `.nax-wt` being a
 * reserved nax worktree directory, gitignored and never a workspace package path.
 */
export function storyExecRoot(view: { readonly repoRoot: string; readonly packageDir?: string }): string {
  const { repoRoot, packageDir } = view;
  if (!packageDir) return repoRoot;
  const segments = packageDir.split("/");
  if (segments[0] !== ".nax-wt" || segments.length < 2) return repoRoot;
  return join(repoRoot, segments[0], segments[1] as string);
}
```

- [ ] **Step 4: Run and confirm pass**

Run: `bun test test/unit/runtime/story-exec-root.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Write the failing boundary test**

**Read `src/tools/package-managers.ts:360-401` first** and match the real `normalizeExec` input shape — the sketch below is the assertion that matters, not the exact signature.

```ts
// test/unit/tools/package-managers-worktree.test.ts
import { describe, expect, test } from "bun:test";
import { normalizeExec } from "@/tools";

describe("Exec target repoRoot under worktree isolation (nax#2093)", () => {
  test("resolves cwd inside the story worktree, not the main checkout", () => {
    const result = normalizeExec({
      argv: ["bun", "install"],
      target: "repoRoot",
      repoRoot: "/repo/.nax-wt/US-003",
      packageWorkdir: "/repo/.nax-wt/US-003/packages/api",
    });
    expect(result.cwd).toBe("/repo/.nax-wt/US-003");
  });

  test("a root-level package does not collapse out of the worktree", () => {
    const result = normalizeExec({
      argv: ["bun", "install"],
      target: "package",
      repoRoot: "/repo/.nax-wt/US-003",
      packageWorkdir: "/repo/.nax-wt/US-003",
    });
    expect(result.cwd).toBe("/repo/.nax-wt/US-003");
  });
});
```

The invariant, whatever the signature: **cwd must be under `.nax-wt/<storyId>`.**

- [ ] **Step 6: Run and confirm it fails**

Run: `bun test test/unit/tools/package-managers-worktree.test.ts`
Expected: FAIL — `cwd` is `/repo`, the main checkout.

- [ ] **Step 7: Change the producer — one line**

`src/operations/call.ts:255`:

```ts
// before
codingToolRepoRoot: ctx.packageView.repoRoot,
// after
codingToolRepoRoot: storyExecRoot(ctx.packageView),
```

Add `storyExecRoot` to the **existing** `@/runtime` import on that file's import line. Do not add a new import line and do not add a comment — the file has three lines of headroom and the explanation belongs in the helper's docblock.

- [ ] **Step 8: Verify the ratchet did not move**

Run: `bun run check:file-sizes`
Expected: PASS. If `src/operations/call.ts` reports 598 or more, you added a line — revert and fold the change into the existing line.

- [ ] **Step 9: Run the worktree, policy and tool suites**

Run: `bun run test`
Expected: PASS.

Watch `test/unit/tools/run-command-exec-touched-paths.test.ts`, `test/unit/tools/policy.test.ts`, `test/unit/runtime/packages.test.ts` and `test/integration/worktree/`. If any moves, the fix changed behaviour beyond its intent — read the diff before proceeding rather than updating the expectation.

- [ ] **Step 10: Full gate, then commit**

```bash
bun run typecheck && bun run lint && bun run test && bun run test:coverage
```

Paste the output. Then:

```bash
git add src/runtime/packages.ts src/tools/package-managers.ts src/operations/call.ts \
        test/unit/runtime/story-exec-root.test.ts test/unit/tools/package-managers-worktree.test.ts
git commit -m "fix(tools): resolve Exec target repoRoot inside the story worktree (#2093)"
```

---

## PR body

Include this line so the issue closes on merge:

```
Closes #2093
```

Also record in the body:

- **This is the damaging one.** Under `storyIsolation: "worktree"`, a repo-scoped `Exec` wrote the user's real working tree — manifest, lockfile, `node_modules` — on their real branch, and the story's own tree never received the install. Lead with the blast radius, not the mechanism.
- **`src/operations/call.ts` is still at 597 lines** and `test/unit/operations/call.test.ts` is untouched. Paste `bun run check:file-sizes` output.
- **Both directions of the hazard now hold together.** `src/runtime/packages.ts:103-116` already guards the inverse mistake (nax#2069: shortening the package key would point every file tool at the main checkout). `storyExecRoot` sits beside `toOverrideKey` so the two invariants are stated in one place — one strips the `.nax-wt/<storyId>` prefix for override lookup, the other keeps it because a repo-scoped command must run inside the story's tree.

---

## Done when

- A worktree story issuing `Exec` with `target: "repoRoot"` resolves its cwd inside `.nax-wt/<storyId>/`.
- A root-level package no longer collapses out of the worktree.
- `src/operations/call.ts` is still at 597 lines.
- `test/unit/operations/call.test.ts` is untouched.
- The #2069 inverse guard at `src/runtime/packages.ts:103-116` still holds — both invariants stated together.
