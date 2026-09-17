# PR 4 — Guard `storyExecRoot`, de-vacuum its test, retire the dead scope branch

**Follow-up 10 (P3). Findings: M1, M2, L2, L3, L4.**
**Base:** `origin/main` @ `6507cf061`. Independent of `fix/path-frame-p0-p1` — no file overlap.
**Branch:** `fix/story-exec-root-residue`

All five findings are residue from PR #2103 (`6507cf061`), which fixed #2093 correctly. The core fix is sound — the review confirmed it avoids the #2069 trap in both directions and does not move any other tool's root. These are the loose ends.

---

## Part A — `storyExecRoot` omits the guard its sibling has (M1)

`src/runtime/packages.ts:211-217`:

```ts
export function storyExecRoot(view: { readonly repoRoot: string; readonly packageDir?: string }): string {
  const { repoRoot, packageDir } = view;
  if (!packageDir) return repoRoot;
  const segments = packageDir.split("/");
  if (segments[0] !== ".nax-wt" || segments.length < 2) return repoRoot;
  return join(repoRoot, segments[0], segments[1] as string);
}
```

`packageWorkdir` (`:43-48`) defends the same field explicitly:

```ts
if (!repoRoot || isAbsolute(packageDir)) return packageDir;
```

`storyExecRoot` does not. For an absolute `packageDir` such as `/repo/.nax-wt/US-003/packages/api`, `packageDir.split("/")[0]` is `""`, the guard falls through, and the function **returns `repoRoot` — the main checkout — silently re-entering #2093**, the exact bug it was written to fix.

The two helpers are consumed on adjacent lines from the same `ctx.packageView`:

```ts
// src/operations/call.ts:254-255
codingToolRoot: packageWorkdir(ctx.packageView),
codingToolRepoRoot: storyExecRoot(ctx.packageView),
```

…yet they disagree about that field's domain. The parameter is also structural rather than `PackageView`, so any future caller can hand it an absolute path.

Not reachable today: `toRelativeKey` (`:94-101`) relativizes when both paths are absolute. But its fallback at `:100` returns `packageDir` unchanged whenever `repoRoot` is not absolute, so the shape is constructible.

### The change

Either mirror `packageWorkdir`'s guard, or narrow the parameter to `Pick<PackageView, "packageDir" | "repoRoot">` and state the relative-key precondition in the docblock. Whichever you pick, the two helpers must agree about the domain of `packageDir` after this PR. Prefer the guard — a precondition a caller can violate silently is what produced this finding.

**Test:** an absolute `packageDir` must not resolve to `repoRoot`. Must fail before the change.

---

## Part B — The worktree test cannot fail (M2)

`test/unit/tools/package-managers-worktree.test.ts`.

`src/tools/package-managers.ts` is **not in the #2103 diff** — `normalizeExec` was never modified by that PR. Both tests hardcode `repoRoot: "/repo/.nax-wt/US-003"`, which is the **post-fix** value, instead of deriving it from the producer.

- **Test 1** reduces to *"`normalizeExec` returns `input.repoRoot` for `target: "repoRoot"`"* — already true at the parent commit. It passes on the broken code.
- **Test 2** is worse: it sets `packageWorkdir === repoRoot === worktreeRoot` with `packageRelPath: ""`, so both branches of the `cwd` ternary at `package-managers.ts:394` yield the same string. It cannot distinguish the collapse being present from it being removed — precisely the invariant its name claims to pin.

The plan step said *"Run and confirm it fails — Expected: FAIL, cwd is `/repo`"*. That observation was impossible as written.

Note the docblock is honest (*"This pins the normalizeExec boundary, not the producer"*), and **the damaging bug genuinely is reproduced-then-fixed** — just by a different file. `test/unit/operations/call-coding-tool-repo-root-producer.test.ts:76-88` resolves through the live registry, asserts `packageView.repoRoot === mainCheckout`, then `codingToolRepoRoot).not.toBe(mainCheckout)`. That one is real; leave it alone.

### The change

Pick one:

- **Couple it to the producer** — derive `repoRoot` in the suite from `storyExecRoot({ repoRoot: "/repo", packageDir: ".nax-wt/US-003/packages/api" })` so a producer regression breaks the boundary test too; or
- **Delete it as subsumed** by the producer test, and rename/retarget test 2 to assert what it actually checks (a root-level package with `packageRelPath: ""` keeps cwd at the worktree root — which needs `packageWorkdir !== repoRoot` to be meaningful).

Do not simply flip the expected strings. The problem is the inputs, not the expectations.

---

## Part C — `agent-scope.ts`: dead branch, false docblock, misfiring instruction (L2)

**This PR owns `src/prompts/sections/agent-scope.ts`.** PR 5 of this bundle had a competing claim on it and has been told to stay out; take all three items here.

`buildAgentScopeSection(options.codingToolRoot, options.codingToolRepoRoot)` (`src/agents/tool-preamble.ts:35`) is the only other consumer of the field #2103 changed.

Rendered output is **identical** before and after — verified, no user-visible regression. But `relative(repoRoot, root)` can no longer begin with `.nax-wt` from the sole producer, because `repoRoot` is now the worktree root rather than the main checkout. So:

1. **The strip branch at `:32-33` is unreachable.** (`:31` is the guard `if (segments[0] !== WORKTREE_DIR) return segments.join("/")` that now always takes the early return.)
2. **The docblock at `:22-25`** — *"the naive relative path leaks the scratch directory and the story id into the prompt"* — describes a state that no longer occurs.
3. Its only test, `test/unit/prompts/agent-scope.test.ts:24`, pins `("/repo/.nax-wt/US-001/packages/api", "/repo")` — a pair production cannot emit.
4. **The instruction at `:55` can now only misfire** (carried over from PR 5's Part F):

   ```
   If a path you were given already starts with `<label>/`, strip that prefix before using it.
   ```

   After #2101 the git output in these prompts is package-relative, so no path handed to the agent legitimately starts with the label. The rule can only subtract: label `api`, package-relative path `api/openapi.yaml` → stripped to `openapi.yaml` → not found.

### The change

For items 1-3, decide explicitly: keep the branch as defence-in-depth with a docblock saying *why* it is retained and that it is unreachable from the current producer, **or** remove it and its test. Either is fine; leaving a false docblock is not. If you keep it, retarget the test so it is labelled as a defensive case rather than a production shape.

For item 4, narrow the instruction to the case that can still occur, or drop it. Note the neighbouring line `:56` (*"If it names a different package, your tools cannot open it — say so rather than guessing"*) is still correct and useful — keep it. It is also the natural place to put PR 5's "changes outside your scope were omitted" notice if that PR asks you to host it.

---

## Part D — Consumer docblocks still teach the retired model (L3)

#2103 carefully rewrote the producer docblock at `src/agents/types.ts:184-196` (*"execution root … NOT the main checkout (nax#2093)"*) but left the receiving end stale:

| File | Still says |
|---|---|
| `src/agents/coding-tool-support.ts:51-55` | *"Repo root for Exec's `target: "repoRoot"` form. Falls back to `root` when absent (single-package repos, where the two coincide)."* |
| `src/runtime/packages.ts:13` (`PackageView.repoRoot`) | *"Use as cwd when running root-config commands"* — the whole point of #2093 is that you must not |

Fix both to match the producer.

---

## Part E — Barrel export (L4)

The #2103 plan said to export `storyExecRoot` from the runtime barrel. `src/runtime/index.ts` exports `PackageView`, `PackageRegistry`, `createPackageRegistry` but not `storyExecRoot`; `src/operations/call.ts:10` deep-imports from `../runtime/packages`.

This matches the existing treatment of `packageWorkdir` and no gate catches it, so it is defensible — but the repo's "barrel imports only in `src/`" constraint makes it worth settling. Either export both helpers from the barrel and switch `call.ts` to it, or leave as-is and note in the PR body that the deep import is deliberate and consistent with `packageWorkdir`. Do not leave it undecided a second time.

`src/operations/call.ts` is at **597/600** — if you switch the import, confirm the line count does not grow. `check:file-sizes` is the authority.

---

## Gates

```
bun run typecheck && bun run lint && bun run test
bun run test:coverage
```

Paste all four. `src/runtime/packages.ts` is 217/600 and `agent-scope.ts` 58/600 — no size pressure except `call.ts` above.

## Done when

- [ ] `storyExecRoot` and `packageWorkdir` agree about `packageDir`'s domain; a test pins the absolute case.
- [ ] `package-managers-worktree.test.ts` either couples to the producer or is gone, with test 2 renamed to what it asserts.
- [ ] `agent-scope.ts`'s strip branch is either removed or documented as deliberately unreachable, and its test matches that decision.
- [ ] The `:55` strip-the-prefix instruction is narrowed or removed; `:56` is kept.
- [ ] Both consumer docblocks describe the post-#2093 model.
- [ ] The barrel question is settled either way and stated in the PR body.
- [ ] All four gates pasted.

## Do not

- Do not touch `toOverrideKey` (`packages.ts:117-121`). It deliberately keeps the `.nax-wt/<storyId>` prefix out of the override lookup while `storyExecRoot` keeps it in; that asymmetry is the #2069/#2093 split and is correct. Its docblock explains it.
- Do not weaken `call-coding-tool-repo-root-producer.test.ts` — it is the only genuine regression test for #2093.
- Do not change `codingToolRoot`. File tools' containment root is out of scope here and the review confirmed #2103 left it correctly untouched.
