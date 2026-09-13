# Plan — nax#2007: nax-owned run state must never look like the agent's diff

**Branch:** `fix/2007-nax-owned-run-state` (worktree `.worktrees/fix-2007-nax-owned-run-state`, based on `origin/main` @ `3aaa468c4`)
**Issue:** nax#2007
**Scope:** parts **A, B, C** of the proposal. Part D (splitting `prd.json` into durable + runtime) is **out of scope** and documented at the end.
**Execution:** hand-executed by an agent session, TDD. **Do not run `nax plan` or `nax run`** — those need explicit human approval at the moment of launch.

---

## 1. The problem, in one paragraph

nax writes its own **git-tracked** run artifacts while a run is in progress. The coding agent sees
unexplained modifications in `git status`, concludes it dirtied the tree, and tries to revert them
with `git checkout -- .nax/...`. Every such attempt so far has been denied — and the denials were
load-bearing, because a success would have reverted nax's live run state (`prd.json` carries
story-pass markers; `checkpoint.jsonl` is the crash-recovery journal). Underneath that symptom,
nax has also been **committing** its own run state into feature branches for 93 features.

## 2. Measured facts this plan rests on

Re-verify anything you intend to rely on; the commands are given so you can.

| # | Fact | How it was measured |
|---|---|---|
| F1 | **407 tracked files** match nax's own `NAX_GITIGNORE_ENTRIES` on `origin/main` | `git ls-files -i -c --exclude-from=<entries>` |
| F2 | Breakdown: `progress.txt` 93, `acceptance-refined.json` 91, `.nax-acceptance.test.ts` 89, `status.json` 64, `checkpoint.jsonl` 41, `acp-sessions.json` 19, `*.bak` 10 | same |
| F3 | **54 of the 55** commits touching a `checkpoint.jsonl` are nax's own `chore(US-00X): auto-commit after <role> session`; they reached main inside merged PRs (#2015, #1996, #1986) | `git log --oneline --all [--grep] -- '.nax/features/*/checkpoint.jsonl'` |
| F4 | Across **344 sessions / 14,711 tool calls**, there are **22** git-shaped argv/verb calls, all denied. `checkout` ×4 — **4 of 4 target `.nax/` paths**. `stash`, `stash pop`, `reset`, `clean`, `restore`: **0** | local `tool-audit/*.json` corpus under `repos/nax-global/*/tool-audit/` |
| F5 | The four `checkout` attempts span **3 features** and **2 roles** (`implementer` ×3, `test-writer` ×1); one also names `progress.txt` | same |
| F6 | The corpus holds one **legitimate** revert: `RequestCapability {"capability":"git checkout -- test/unit/execution/lifecycle/acceptance-loop.test.ts","reason":"Reset to original to check format"}` | same |
| F7 | `:(exclude).nax` works on `status`, `diff`, `log`, `show`; **`blame` rejects it, exit 128** | scratch repo |

Full analysis: `projects/nax/nax-2007-proposal-2026-09-13.md` in the outer workspace.

## 3. What already exists (read before writing code)

- `src/utils/gitignore.ts:43` — `checkpoint.jsonl` **is already** in `FEATURE_RUN_ARTIFACTS` →
  `NAX_GITIGNORE_ENTRIES`. The rule is not missing. `patchIgnoreFile` is additive and runs at
  `nax init` only, so entries added later never reach an already-initialised repo — **and gitignore
  never untracks**. That is the whole cause of F1.
- `src/utils/porcelain.ts` — `parsePorcelainForNaxPaths` already restores **deleted/renamed** `.nax/`
  paths before `autoCommitIfDirty`'s `git add -A`, logging at `error` level. Its docstring names the
  gap: *"We only restore deletions and renames; modifications stay as the agent left them."*
- `src/review/diff-utils.ts:18` — `ALWAYS_EXCLUDED = [":!.nax/", ":!.nax-pids"]`, merged by the
  semantic, adversarial and debate prompt builders and shipped as the default `excludePatterns`.
  **All of those are prompt text describing a shell command.** The `Git` tool applies none of it.
- `src/tools/git.ts` `buildGitArgv` already injects nax-decided argv: `--relative` for diff/log/show,
  a `--max-count` default for an unscoped `log`, and `--` + `.` when the caller names no paths.
- `scripts/check-feature-dir-ssot.ts` — the template for Task A1, and its header documents a **prior
  instance of this same class**: a stray `features/` directory "that no `.nax`-scoped gitignore entry
  covered, and a run's auto-commit swept them into the user's repo."

## 4. Ground rules

- **TDD.** Write the failing test first, watch it fail, then implement. Each task below names its test file.
- **Gates:** `bun run typecheck`, `bun run lint` (biome + `lint:checks`), `bun run test`.
- **File-size ratchet:** 600 lines for `src/`, 800 for `test/`. Current: `src/tools/git.ts` 368,
  `src/tools/denial-redirect.ts` 211, `test/unit/tools/git.test.ts` 391,
  `test/unit/tools/denial-redirect.test.ts` 378. None is grandfathered, so none may cross its limit.
  (No tool counts lines — nax#2010 — so use `wc -l` yourself from the shell you are running in.)
- **The rtk hook rewrites `git` → `rtk git` and its guard refuses inside a worktree.** Prefix git
  commands with `RTK_DISABLED=1` if you hit that.
- **Never bare `git stash` / `git stash pop`** — the stash stack is shared with the main checkout and
  other sessions. Use a WIP commit instead.
- Another session may be active in the main checkout (`repos/nax`, branch `feat/mcp-client`).
  Work only inside this worktree.
- No emojis in code, comments or docs. Conventional commits.

## 5. Tasks

Order matters: **B → C → A1 → A2**. A1's gate cannot go green until A2 runs, so A2 immediately
follows the script that proves it is needed.

---

### Task B — make the agent's git view nax-free  *(the cause; issue's option 1)*

**File:** `src/tools/git.ts`, in `buildGitArgv`, the existing `if (paths.length === 0)` branch (~line 252).
**Test:** `test/unit/tools/git.test.ts`.

**Change.** When the caller names **no** paths, alongside the existing `.` also push the nax
exclusions — for every verb **except `blame`** (F7: blame rejects exclude pathspecs, exit 128):

```ts
argv.push(".");
if (subcommand !== "blame") argv.push(":(exclude).nax", ":(exclude)**/.nax");
```

**Design constraints — do not "simplify" these away:**

1. **Only the `paths.length === 0` branch.** If the agent explicitly names a path under `.nax/`,
   answer it. The tool is read-only; what should be nax-free is the *default view*, not the tool.
   Silently returning nothing for an explicitly-requested path is a worse failure than the one being fixed.
2. **`blame` is exempt**, and the exemption needs a comment saying why (git exits 128), or someone
   will "unify" it back in.
3. **One source of truth for the patterns.** `ALWAYS_EXCLUDED` (`src/review/diff-utils.ts:18`) is the
   existing SSOT in `:!` short form. Either export a `:(exclude)` long-form derivation from there or
   move the SSOT somewhere both can import — do **not** hand-copy the strings into `git.ts`. Prefer
   the long form in the argv: it is what lands in the tool-audit ledger, and `:(exclude)` reads.
   Watch the import direction — `src/tools/` importing from `src/review/` may trip
   `check:import-cycles`; if it does, move the constant to a neutral module rather than duplicating it.

**Tests to add (all against `buildGitArgv`, no spawning):**

- `status` with no paths → argv ends `["--", ".", ":(exclude).nax", ":(exclude)**/.nax"]`
- `diff` with no paths → same, and `--relative` still precedes the refs
- `blame` with no paths → argv ends `["--", "."]`, **no** exclusion
- `diff` with `paths: ["src/a.ts"]` → unchanged, no exclusion injected
- `diff` with `paths: [".nax/features/f/prd.json"]` → unchanged, still reaches the file
- `log` with no refs → the `--max-count` default and the exclusions coexist

**Acceptance:** a `Git {"subcommand":"status"}` call no longer reports `.nax/` paths as modified.

---

### Task C — make the refusal teach  *(backstop; issue's option 3)*

**File:** `src/tools/denial-redirect.ts`.
**Test:** `test/unit/tools/denial-redirect.test.ts`.

**Change.** When a denied command is `git checkout` or `git restore` **and any operand lies under a
`.nax/` path segment**, return an explanation instead of a tool redirect:

> ``.nax/` is nax's own run state, written by the harness during this run. It is not part of your diff and must not be reverted.``

**Structural requirement.** Do **not** add this as an `Intent` row. `render()` wraps every hit as
``"this session already has `X` -- ..."``, which is false here — there is no tool that reverts, and
the module's own header forbids naming a tool the session does not have (it already declines to map
`git restore` onto `GitCommit` for exactly that reason). Add a separate predicate checked **before**
`intentFor` in **both** `redirectForArgv` and `redirectForVerb`, returning its own sentence.

Both entry points are required: `Exec` denials arrive as argv, `RunCommand` denials arrive through
the verb slot as a mini command line (F4/F5 contain one of each).

**Verb scope is `checkout` and `restore` ONLY.** An earlier draft said
`checkout|restore|clean|reset|stash`; that was pattern-matching, and F4 refutes it:

- zero `stash` / `reset` / `clean` attempts in 14,711 calls;
- the rule keys on an **operand path**, and a bare `git stash` has no operands — so listing it is inert;
- if it ever did fire it would be **wrong**: `git stash` is about the agent's own WIP, not nax's
  state, and explaining it as "nax's run state" misexplains the intent this row exists to clarify.

`restore` is included only because it is the modern spelling of the observed `git checkout -- <path>`,
so it is reachable by respelling after a refusal. That over-covers in the safe direction, and costs
nothing because the row changes *text*, never permission.

**The path gate is load-bearing, not decoration** — F6 is a legitimate `git checkout` of the agent's
own test file. A verb-gated message would misexplain it; a path-gated one stays silent.

**Tests to add:**

- argv `["git","checkout","--",".nax/features/f/prd.json"]` → the explanation
- argv `["git","checkout","--",".nax/"]` → the explanation
- verb `"git checkout -- .nax/features/f/checkpoint.jsonl .nax/features/f/prd.json"` → the explanation
- argv `["git","restore",".nax/features/f/prd.json"]` → the explanation
- argv `["git","checkout","--","test/unit/foo.test.ts"]` → **undefined** (F6 must not be misexplained)
- argv `["git","stash"]` → **undefined**
- verb `"git status"` → unchanged, still redirects to `Git`
- a path with a `.nax` segment deeper in a monorepo (`packages/app/.nax/features/f/prd.json`) → the explanation
- a path merely *containing* the letters (`src/nax-helpers.ts`, `docs/.naxignore`) → **undefined**
  (match on a path **segment**, the way `parsePorcelainForNaxPaths` does, not a substring)

---

### Task A1 — the drift check that would have caught this  *(missing from the issue)*

**New file:** `scripts/check-nax-artifacts-untracked.ts` (follow `scripts/check-feature-dir-ssot.ts` for shape: `main()`, `process.exit(1)` on violations, exported pure helper, `import.meta.main` guard).
**New test:** `test/unit/scripts/check-nax-artifacts-untracked.test.ts`.

**What it asserts.** No tracked file matches `NAX_GITIGNORE_ENTRIES`. Import the list from
`src/utils/gitignore.ts` — never re-spell the patterns, or the gate drifts from the generator it
exists to enforce.

```
git ls-files -i -c --exclude-from=<temp file built from NAX_GITIGNORE_ENTRIES>
```

**Why a gate and not just a cleanup.** `patchIgnoreFile` cannot see the index, so every future
addition to `FEATURE_RUN_ARTIFACTS` re-opens this on every repo initialised before it. The gate is
the only part of this plan that prevents recurrence.

**Report.** On violation, print the count, the per-basename breakdown, and the remedy
(`git rm --cached -- <paths>`), following the existing scripts' report style.

**Test with a fixture repo**, not the live one: `git init` a temp dir, add a file matching one entry,
assert the helper reports it; assert a clean fixture reports none. Do not let the test depend on the
state of the repo it runs in — that is what makes it still pass after A2.

**Wiring is not optional, and it is not deferrable to "later".** `scripts/check-gate-reachability.ts`
is a meta-gate: *"a check script that no CI entry point reaches is a check script that does not
exist."* It resolves reachability from `bun run check:all` (expanded transitively through package
scripts) and from every `run:` step in `.github/workflows/ci.yml`. So the moment the new
`scripts/check-*.ts` file exists, `lint:checks` starts failing until it is reachable.

Sequence it deliberately: land A1's script **and** its `package.json` wiring in the same commit as
A2's untracking, or land A1 first and accept one red commit that A2 turns green. Do not try to keep
the script unwired — the meta-gate will not let you.

---

### Task A2 — untrack the 407 files

1. Reconcile this repo's own `.gitignore` against `NAX_GITIGNORE_ENTRIES`. The reconciler already
   exists (`patchIgnoreFile`); running `nax init`'s ignore step, or appending the missing entries by
   hand in the same additive style, are both acceptable. Verify afterwards that the file's active
   lines are a superset of the generated list.
2. `git rm --cached` the 407 files, in **one commit**, separate from any code change:
   ```
   git ls-files -z -i -c --exclude-from=<entries> | xargs -0 git rm --cached --quiet --
   ```
   NUL-delimited (`-z` / `-0`) on purpose: some paths contain characters git quotes, and a
   newline-split pipeline would mangle them. **Verify the count is 407 before and 0 after.**
3. **Keep tracked:** `prd.json`, `spec.md`, `acceptance-meta.json`, `prd-fidelity-report.md`. They are
   the feature's source of truth, they belong in review, and `assertPrdCommitted`
   (`src/prd/validate.ts`, bake-off `--compare`) requires `prd.json` tracked. None of them is in the
   407 — confirm that before committing.
4. Wire the gate: add `check:nax-artifacts-untracked` to `package.json` scripts and into the
   `lint:checks` chain, so `check:all` reaches it and `check-gate-reachability` is satisfied. It must
   go green. Check whether `.github/workflows/ci.yml` needs a matching entry — the meta-gate accepts
   either route, but follow whichever convention the sibling gates use.

**Note for the commit message:** this removes files from the index only; history is untouched and
the working copies stay on disk.

---

## 6. Verification before opening the PR

```
bun run typecheck
bun run lint            # biome + lint:checks, including the new gate
bun run test
git ls-files -i -c --exclude-from=<entries> | wc -l     # must be 0
```

Then re-prove the behaviour end to end, not just by unit test:

- Dirty a `.nax/features/*/prd.json` in a scratch clone and confirm `buildGitArgv("status")`'s argv,
  run through real git, omits it while still reporting a dirtied `src/` file.
- Confirm the denial text renders for both an `Exec`-shaped and a `RunCommand`-verb-shaped call.

**Code review before the PR, never after** — run the repo's review skill on the diff, address
CRITICAL/HIGH, then open the PR.

## 7. Out of scope — record, do not build

- **Part D — split `prd.json` into durable + a gitignored runtime sidecar** at the
  `loadPRD`/`savePRD` seam (the same transform the pair already performs for `outOfScope`). This is
  the durable fix for the class and needs an ADR: back-compat for every existing `prd.json`, an audit
  that nothing parses the file outside `loadPRD`, and resume tolerating a missing sidecar. It also
  makes `assertPrdCommitted` meaningful instead of a race against nax's own writer.
- **Filtering `.nax/` out of `autoCommitIfDirty`'s `git add -A`.** Tempting given F3, but it changes
  what lands in feature branches and interacts with the mutation-journal and finish-audit reasoning
  already written into `NAX_GITIGNORE_ENTRIES`. Once A2 lands, the files are untracked and
  `git add -A` stops picking them up anyway — so measure before adding a filter.
- **Extending `parsePorcelainForNaxPaths` to restore modifications.** It would fight nax's own
  writer — the one party legitimately modifying those files mid-run — and silently revert live state,
  which is the failure #2007 exists to prevent.
- **Gitignoring `prd.json`.** See A2 step 3.
- **`stash` / `reset` / `clean` in Task C.** See the F4 argument.

## 8. Suggested commits

1. `test(tools): Git tool excludes nax-owned paths from an unscoped call` + `fix(tools): …` (Task B)
2. `test(tools): name nax-owned run state in a denied git checkout` + `fix(tools): …` (Task C)
3. `test(scripts): gate tracked nax run artifacts` + `feat(scripts): …` (Task A1)
4. `chore: untrack nax run artifacts already covered by NAX_GITIGNORE_ENTRIES` (Task A2, the 407)
5. `chore(lint): run the nax-artifacts-untracked gate in lint:checks` (Task A2 step 4)

PR body should carry F1, F3 and F4 — the numbers are what make the untracking commit legible to a
reviewer who sees 407 deletions.
