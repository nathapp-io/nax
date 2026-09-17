# PR 2 — Package-frame git-history chunk content; close the `historyScope: "repo"` residual

**Follow-ups 7 and 9 (P2). Findings: H9, M13, M15 (and M14 if `fix/path-frame-p0-p1` has not already absorbed it).**

## ⚠️ This is the one PR in the bundle with a hard dependency

**Base on `fix/path-frame-p0-p1` @ `faf770504`, or on `main` after that branch merges. Do NOT base on `origin/main` @ `6507cf061`.**

That branch is **complete** — all five P0/P1 fixes are committed:

```
faf770504 fix(prompts): frame batch modifiedFiles against the batch's one agent root
484c28215 fix(context): stop the canonical drop from deleting in-package contextFiles
eb7289161 fix(execution): run acceptance-test regen's git diff at repoRoot, not workdir
041128d26 fix(scripts): rewrite the story-workdir-access gate on the real TS checker
e149de1cd fix(context): thread story workdir onto ContextRequest for worktree-safe framing
```

**Every line number in this file is given against `faf770504`, not `6507cf061`** — `e149de1cd` rewrote the top of `git-history.ts` and shifted everything below it. Treat them as hints and grep for the quoted code, which is the real anchor.

Reason, and it is semantic rather than cosmetic: on `origin/main` the only package frame available inside `GitHistoryProvider` is `packageDirRelative(request.repoRoot, request.packageDir)` — the derivation that finding C1 proves is wrong under worktree isolation, and that `src/context/fragments/reframe.ts:68-74` forbids by name. This PR needs a correct package frame in order to re-spell chunk content. Building it on `origin/main` means either re-deriving the forbidden value or inventing a second source of truth for the same thing.

The P0/P1 branch replaces that derivation with `ContextRequest.storyWorkdir`, carrying the PRD-declared story workdir. It is already read at `git-history.ts:161`:

```ts
const packageWorkdir = request.storyWorkdir ?? ".";
```

**Use that value.** Do not re-derive. Read its docblock in `src/context/engine/types.ts`, and `src/context/engine/providers/feature-context.ts:383-388` for the sanctioned pattern.

**Part C (M14) is already done on that branch — verify, then skip it.** See Part C below; only a test gap remains.

**Branch:** `fix/git-history-prompt-frame`

---

## Part A — Chunk content is repo-rooted in a package-contained agent's prompt (H9)

`src/context/engine/providers/git-history.ts:105` (on `faf770504`):

```ts
return `### ${filePath}\n${trimmed}`;
```

`filePath` is repo-rooted. The `historyScope` post-filter (`:163-166`) uses `toPackageFrame(...) !== null` purely as a **predicate** and keeps the original repo-rooted `file`, which is correct for `scopePaths` (`:239`) — those are matched against a repo-framed diff — but wrong for the rendered heading.

Note `fetchFileHistory` already receives the package dir as its fourth parameter (`packageDir`, `:78`), but uses it only for logging. The value you need is already threaded in.

So a `packages/api` story's prompt now reads:

```
### packages/api/src/service.ts
```

where it previously read `### src/service.ts`. The agent's file tools are rooted at `codingToolRoot` = the package dir (`src/operations/call.ts:254`), so that spelling does not open.

This is the **#2072 / #2074 / #2090 class** — the very class PR #2101 of the reviewed arc exists to fix — and it contradicts PR #2099's own stated architecture: *"package-relative only where a path is rendered into an agent's prompt."* `code-neighbor-chunk.ts:152,166-169` got the same problem right: content stays package-relative, only `scopePaths` are re-rooted. `git-history.ts` reuses one string for both.

### The change

Split the two uses. The heading rendered into `content` must be package-framed for a package-contained consumer; `scopePaths` must stay repo-rooted. Take the frame from the `ContextRequest` field the P0/P1 branch introduced — never re-derive it.

Decide and document what happens to a file that is **not** under the package. Under `historyScope: "package"` the post-filter already removed it, so the case is unreachable there; under `"repo"` it is reachable (see Part B). `toPackageFrame` returning `null` means "cannot be spelled for this consumer" — render it repo-rooted with `UNREADABLE_MARKER`, or omit it, but do not emit a bare repo-rooted path that resolves to a real but wrong file under the package root. `src/utils/path-frame.ts:96-98` is the governing docblock.

Watch the `maxChars` truncation near `:237` — if your reframing changes rendered length, confirm the truncation contract still holds and its existing tests still pass.

### Test

No test asserts the rendered frame today. Add one: a package story, assert the `###` heading is package-relative and that `scopePaths` on the same chunk remain repo-rooted. It must fail before the change.

The suite already has a worktree-shaped case (`test/unit/context/engine/providers/git-history.test.ts:476`, *"touchedFiles resolve under storyIsolation: worktree via request.storyWorkdir"*), added by `e149de1cd`. Extend that shape rather than inventing a new fixture.

---

## Part B — `historyScope: "repo"` keeps the #2088 sharper variant (M13)

Under `"repo"` scope a **pre-canonical, package-relative** legacy path is queried at `repoRoot` and surfaces an unrelated root-level file's history under the story's label, with `scopePaths` claiming scope over it.

The PR body of #2099 conceded this and called it pre-existing. That is not quite right: before the frame flip, `"repo"` scope never resolved the root file *successfully*; making the provider run at `repoRoot` is what lets the legacy spelling land there. `Closes #2088` therefore overstates what shipped.

The existing suite covers the sharper variant only for `"package"` scope (`git-history.test.ts`, *"sharper variant: a root-level src/client.ts is NOT returned"*).

### The change

Give `"repo"` scope the same protection. The cleanest lever is the one PR 4 of the reviewed arc used at plan time and that `src/debate/verifiers/checks.ts` uses: when a path misses `toPackageFrame`, disambiguate rather than assume. If a package-relative legacy spelling also resolves at the repo root, that is a collision, and attributing the root file's history to this story is wrong — drop it or mark it, and log the drop.

If you conclude the correct fix is larger than this PR should carry, **say so explicitly and narrow the scope to a failing test plus a documented residual** rather than shipping a half-fix with an overstated claim. That is what went wrong the first time.

### Test

A `historyScope: "repo"` case mirroring the existing `"package"` sharper-variant test.

---

## Part C — The A5 warn (M14) — ALREADY FIXED, do not redo

Verified on `faf770504`. `e149de1cd` closed both halves:

- The `historyScope` post-filter now logs its drops (`git-history.ts:167-178`) with `storyId`, `packageDir`, a count and a 5-file sample, citing this review. That was the dominant silent-drop path and the substance of M14.
- The empty-stdout A5 warn (`:92-102`) now logs `storyId`, `filePath`, `pathspec` and `packageDir` — no longer `cwd` — so `.nax/rules/monorepo-awareness.md` §9 is satisfied.

**Confirm both are present, then move on.** Re-implementing will conflict line-for-line.

### The one residual worth taking

`_gitHistoryDeps.getLogger` is injectable but **still never injected by any test** — verified on `faf770504`, `grep -n getLogger test/unit/context/engine/providers/git-history.test.ts` returns nothing. Neither warn has a fire or a no-fire assertion, so either could be silenced by a refactor with the suite green.

Add one test per warn: it fires once with the expected fields, and does not fire on the clean path. Small, and it protects the diagnostics the whole C1 fix depends on being visible.

Optional judgement call, not required: the empty-stdout warn fires at `warn` level for any legitimately new file with no history yet — up to `MAX_FILES = 10` per fetch, per assembling stage, per story. If you find that noisy in practice, `debug`, or one aggregated warn with a count, is defensible. Do not change it speculatively.

---

## Part D — Documentation states the retired contract (M15)

`src/config/schemas-context.ts` was a **comment-only** change in #2099 — the enum and default are byte-identical, so there is no user-facing schema change and no back-compat risk. But the *semantics* of `historyScope` changed, and three sources still describe the old anchor:

| File | What it still says |
|---|---|
| **`.nax/rules/monorepo-awareness.md:139`** | lists `GitHistoryProvider` under `package-scoped` / anchor `packageDir` |
| `docs/specs/SPEC-context-engine-v2-compilation.md:305` | GitHistory anchor `packageDir` |
| `docs/specs/SPEC-context-engine-v2-amendments.md:349` | *"Scoped to `packageDir`. `git log -- <packageDir>` instead of `git log`."* |

The first one matters most: **that rule file is loaded into agent prompts**, so it is actively teaching agents a false model of the provider.

`.nax/rules/` is the canonical store and `.claude/rules/` is a generated mirror. After editing the rule you **must** regenerate:

```
nax rules export --agent=claude
```

`check:rules-drift` is part of `bun run lint` and will fail the commit otherwise. Describe the provider as it now behaves: git runs at the repo root against repo-rooted paths, and `historyScope` is a **post-filter**, not a workdir switch.

Also drop the two stale references left by #2099: `docs/superpowers/specs/2026-09-16-repo-rooted-agent-analysis.md:244` still budgets `toPackageFrameFiles` as a future deletion (it is already gone), and `test/unit/context/engine/providers/git-history.test.ts:286` names it in a comment.

---

## Gates

```
bun run typecheck && bun run lint && bun run test
bun run test:coverage
```

`bun run lint` includes `check:rules-drift` — that is your regeneration check. Paste all four outputs.

## Done when

- [ ] Git-history chunk headings are package-framed; `scopePaths` remain repo-rooted; a test pins both on the same chunk.
- [ ] The frame comes from `request.storyWorkdir`, not a re-derivation. `grep -n packageDirRelative src/context/engine/providers/git-history.ts` returns nothing outside comments.
- [ ] `historyScope: "repo"` either no longer mis-attributes a root file's history, or has a failing-test-plus-documented-residual and an honest PR body.
- [ ] Part C confirmed already-done and NOT re-implemented; both warns now have fire / no-fire tests injecting `_gitHistoryDeps.getLogger`.
- [ ] `.nax/rules/monorepo-awareness.md` describes the current behaviour and `.claude/rules/` is regenerated.
- [ ] All four gates pasted.

## Do not

- Do not reopen **#2088**. It is closed. If the M13 residual needs tracking, file a fresh issue.
- Do not touch `code-neighbor-chunk.ts`'s content/scopePaths split — it is the reference implementation here, and the review confirmed it correct, including that `end` offsets still measure the rendered length so the truncation contract holds.
- Do not edit `.claude/rules/` by hand.
