# PR 5 — Consolidate the review builders' git argv: SSOT, flag order, parity, visibility

**Follow-up 11 (P3). Findings: M6, M7, M8, M9, M10, L1.**
**Base:** `origin/main` @ `6507cf061`. Independent of `fix/path-frame-p0-p1` — that branch touches `src/prompts/sections/story.ts`, not the builders.
**Branch:** `fix/review-builder-argv-consolidation`

Residue from PR #2101 (`be8c151ef`). The core fix there was correct: the reframe is git's own `--relative`, not a nax-side string rewrite, so there is no substring-mangling hazard, out-of-package files are dropped rather than corrupted, and all 11 git command sites across `src/prompts/` carry the flag. These are the loose ends around it.

---

## Part A — Four divergent copies of a constant that has an SSOT (M6)

`src/utils/nax-owned-paths.ts:37` exists for exactly this:

```ts
export const NAX_OWNED_REVIEW_EXCLUDE_PATHSPECS: readonly string[] = [":!.nax/", ":!.nax-pids"];
```

and `src/review/diff-utils.ts:19` consumes it. #2101 added four new hand-rolled literals instead, and **they disagree with each other**:

```
src/prompts/builders/review-builder.ts:333,339              [":!.nax/", ":!.nax-pids"]
src/prompts/builders/debate-builder.ts:443,448              [":!.nax/", ":!**/.nax/", ":!.nax-pids", ":!**/.nax-pids"]
src/prompts/builders/adversarial-review-builder.ts:254,257  [":!.nax/", ":!**/.nax/", ":!.nax-pids", ":!**/.nax-pids"]
```

A nested `packages/api/tools/.nax/` is excluded on the debate and adversarial arms and **visible** on the semantic arm. Adding a fifth nax-owned path updates the SSOT and misses all four copies.

### The change

Route all four through `NAX_OWNED_REVIEW_EXCLUDE_PATHSPECS`. First settle which form is correct — the two-entry or the four-entry `**/` form — and make the SSOT carry it, rather than papering over the divergence. `diff-utils.ts` is the existing consumer, so changing the SSOT's contents affects it too; check what it needs before you widen it.

Barrel imports apply: import from `@/utils` (or whichever barrel owns it), not the deep path.

**Test:** assert the three builders emit the same nax-exclusion set. That is the invariant; a snapshot of one builder is not.

---

## Part B — `--relative` placed after the revision range (M7)

`review-builder.ts:346-348`, `debate-builder.ts:457-459`, `adversarial-review-builder.ts:282,285,288,295,299`:

```ts
const productionDiffCmd = `git diff --unified=3 ${storyGitRef}..HEAD --relative -- . ${excludeArgs}`;
```

`src/tools/git.ts:202-205` — the sibling producer of the same verbs — states the opposite rule explicitly:

> *"Flags precede the refs. Git accepts them in either position, but a flag placed after a revision list reads as a pathspec to anyone (model or human) scanning the argv, and this argv is written into the tool-audit ledger that #1818 was filed from."*

And `review-builder.ts:344-345` admits why it deviates: *"deliberate: the parity prefix assertions match `..HEAD` at the end of the range."* A test's convenience drove the deviation. The correct move is to move the flag and update the three assertions.

### The change

Move `--relative` (and any other flags) before the ref in all eight sites, then update the three prefix assertions in `test/unit/prompts/review-builder.test.ts`, `test/unit/prompts/adversarial-review-builder.test.ts`, and `test/unit/debate/prompt-builder.test.ts` to match. Prefer asserting on the full command or on flag presence rather than a `..HEAD`-terminated prefix, so the next flag addition does not re-create this pressure.

---

## Part C — `git log --relative` is inert (L1)

`review-builder.ts:348`, `debate-builder.ts:459`, `adversarial-review-builder.ts:285`. Verified against real git: `git log --oneline REF..HEAD --relative` emits byte-identical output to the plain form — `--oneline` prints no paths, so the flag has no effect.

Three tests now pin it, which keeps it alive. Harmless, but it is inert argv the model must parse, and the pinning makes removal a test change.

Remove it from the three `log` commands and drop the corresponding assertions. Fold into Part B — you are editing the same lines.

---

## Part D — The adversarial full diff excludes what its docblock promises (M8)

`adversarial-review-builder.ts:254`:

```ts
const merged = [...new Set([...excludePatterns, ":!.nax/", ":!**/.nax/", ":!.nax-pids", ":!**/.nax-pids"])];
const excludeArgs = merged.map((p) => `'${p}'`).join(" ");
```

`excludeArgs` — caller patterns **plus** nax metadata — feeds the command labelled at `:282`:

```
# Full diff including tests (adversarial review sees everything except nax metadata):
```

and the docblock at `:243-245` repeats *"test files are included."* Both are false whenever `review.adversarial.excludePatterns` is configured.

Latent on defaults, and it is worth knowing exactly why, because the neighbouring config is not: `AdversarialReviewConfigSchema.excludePatterns` is `z.array(z.string()).optional()` with **no `.default()`** (`src/config/schemas-review.ts:115`, inside the schema that starts at `:91`), so it arrives `undefined` and `src/review/prepare-inputs.ts:210` turns it into `[]`. Contrast the **semantic** reviewer, whose defaults at `src/config/schemas.ts:257-266` ship a real eight-entry test-exclusion list. So this is one user config key away from being live, not structurally unreachable.

This is the exact defect #2101 diagnosed and fixed in the other two builders — leaving the third is divergence where the PR's own reasoning says they should match.

Worse, the new test at `test/unit/prompts/adversarial-review-builder.test.ts:109` feeds `excludePatterns: [":!*.test.ts"]` and asserts only `--relative` / `-- .`: it renders the broken case and looks past it. The sibling tests (`review-builder.test.ts:340-360`, `prompt-builder.test.ts:494-500`) do assert this properly — copy their shape.

### The change

The full diff takes **nax metadata only**; caller `excludePatterns` apply to the production-only diff (`productionExcludes` at `:256-258` already does this correctly). Then strengthen the test at `:109` to assert test files survive the full diff when `excludePatterns` contains a test glob.

---

## Part E — Native/ACP divergence (M9)

`review-builder.ts:367` and `debate-builder.ts:469` pass `wrapDiffAccess` a spec with `productionExclude` but **no `fullExclude`**:

```ts
wrapDiffAccess({ ref: storyGitRef, productionExclude: [".", ...merged] }, shellBody)
```

`src/prompts/sections/protocol-region.ts:69` renders native's full diff as `diffCall(spec.ref, spec.fullExclude)` — undefined, so no paths and no excludes.

Before #2101 both arms' full diffs were unscoped and unexcluded, i.e. in parity. After it, ACP's carries `-- .` plus nax excludes and native's carries neither: a single-package repo on the native arm gets `.nax/` run artifacts in its full diff while the ACP arm does not. Divergent reviewer inputs across protocols for the same story. The `fullExclude` field exists for exactly this.

#2101's body disclosed it as parked but called the spec *"correctly left untouched"*, which overstates it.

### The change

Populate `fullExclude` so both arms carry the same nax exclusions. Add a test asserting the native and ACP renderings agree on the exclusion set.

**Related, and deliberately out of scope:** #2096 (still OPEN) is that these tests assert **builder** output while the delivered prompt is assembled at dispatch (`src/agents/tool-preamble.ts:33-37`), which is how #2095 moved the ACP arm undetected. Every test you add here inherits that weakness. Do not try to fix #2096 in this PR; reference it.

---

## Part F — Cross-package changes are silently invisible (M10)

Verified: `--relative -- .` **excludes** out-of-cwd changes, it does not merely reframe them.

```
cwd=packages/api:
  git diff --name-only REF..HEAD --relative -- .   -> src/add.ts
  git diff --name-only REF..HEAD                   -> other/g.ts
                                                      packages/api/src/add.ts
```

These two full diffs were the last unscoped view; after #2101 every command and the embedded stat are package-scoped. A monorepo story satisfied by a sibling-package edit — which `modifiedFiles` may legitimately carry per Ruling 8/F — now yields a reviewer that sees **zero evidence** the edit exists, and nothing in the prompt says anything was omitted. The likely outcome is a false `unimplemented`.

The reviewer could not have *opened* the out-of-package file before either, so restoring visibility is not the goal. The goal is that the omission is **stated** rather than silent.

### The change

Cheapest adequate fix: a count of omitted out-of-scope files alongside the `## Changed Files` stat, or one sentence in the scope section. Pick one, keep it small.

### ⚠️ `agent-scope.ts` ownership

**PR 4 owns `src/prompts/sections/agent-scope.ts`. This PR does not edit it.**

Both PRs had a claim on that file and they would collide. The split is: PR 4 takes the dead `.nax-wt` strip branch and the stale docblock (its Part C), **and also takes** the misfiring instruction at `agent-scope.ts:55`:

> *"If a path you were given already starts with `<label>/`, strip that prefix before using it."*

Git output in these prompts is package-relative after #2101, so that rule has no legitimate target and can only misfire — label `api`, package-relative path `api/openapi.yaml` → stripped to `openapi.yaml` → not found.

If you need the omission notice to live in the scope section rather than beside the stat block, **coordinate with PR 4 or land after it** — do not edit the file from both branches.

---

## Gates

```
bun run typecheck && bun run lint && bun run test
bun run test:coverage
```

Paste all four. Sizes: `adversarial-review-builder.ts` 510/600, `debate-builder.ts` 474/600, `protocol-region.ts` 371/600, `review-builder.ts` 368/600 — headroom everywhere.

## Done when

- [ ] All four nax-exclusion literals route through the SSOT, and a test asserts the three builders agree.
- [ ] Flags precede refs at all eight sites; the three prefix assertions are updated and no longer constrain argv order.
- [ ] `--relative` is gone from the three `git log` commands.
- [ ] The adversarial full diff excludes nax metadata only; its test asserts test files survive a configured `excludePatterns`.
- [ ] `fullExclude` is populated; a test asserts native/ACP agree on exclusions.
- [ ] The prompt states that out-of-package changes were omitted.
- [ ] `src/prompts/sections/agent-scope.ts` is untouched by this branch (PR 4 owns it).
- [ ] All four gates pasted.

## Do not

- Do not weaken `test/unit/prompts/diff-access-acp-parity.test.ts`. Ruling 1 retired only its byte-freeze *premise*; all four assertions stay, and the review confirmed #2101 honoured that exactly.
- Do not close **#2096**. Part E touches its territory; reference it, leave it open.
- Do not remove `--relative` from the `diff` commands — that is the #2090 fix and it is correct.
