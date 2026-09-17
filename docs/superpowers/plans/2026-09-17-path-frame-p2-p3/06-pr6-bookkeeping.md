# PR 6 — Record the arc as merged and close the bookkeeping loop

**Follow-up 12 (P3). No code findings.**
**Base:** `main`, **after** every other PR in this bundle and `fix/path-frame-p0-p1` have merged.
**Branch:** `docs/path-frame-arc-bookkeeping`

Docs only. No code, no tests. It lands last so it can name every merged PR accurately.

This is the same class as the earlier `#2092` pass, which existed because the previous arc left the same trail stale. Two arcs in a row have needed it — see "Consider preventing this" below.

## The problem

Both governing documents still describe a world where the seam fixes are unshipped.

### 1. The spec's status line is wrong

`docs/superpowers/specs/2026-09-16-path-frame-convention-design.md:4`:

```
**Status:** Implemented and merged 2026-09-16 — PRs #2076, #2077, #2078, #2081, #2082 (main `a8bc38ef8`). Seams 5-10 are filed, not fixed; see "Out of scope".
```

Seams 5-10 **were** fixed — by #2097, #2099, #2100, #2101, #2102 (main `8cae0c3cd`), plus #2103 for the unrelated worktree escape. The seam table at `:30-41` still carries per-row statuses like *"**#2090** — live"* and *"**#2091** — live"*.

Also at `:357`: `> Status: PRs 1-4 merged. PR 5 (#2074) is the only open row.` — stale in the same way.

### 2. The plan bundle's table is wrong

`docs/superpowers/plans/2026-09-16-path-frame-seam-closure/00-overview.md` still reads:

| PR | Issues | Live? |
|---|---|---|
| 1 | #2089 | ✅ **MERGED** `d95cfee2b` (PR #2097) |
| 2 | #2088, #2091 | #2091 **LIVE** |
| 3 | #2086, #2085 | **LIVE** |
| 4 | #2090 | **LIVE** |
| 5 | #2083, #2087, #2084 | Latent |
| 6 | #2093 | **LIVE, damaging** |

Only row 1 was ever updated. All six merged:

| PR | Commit | GitHub PR |
|---|---|---|
| 1 | `d95cfee2b` | #2097 |
| 2 | `d67b56dac` | #2099 |
| 3 | `1de06d3f0` | #2100 |
| 4 | `be8c151ef` | #2101 |
| 5 | `8cae0c3cd` | #2102 |
| 6 | `6507cf061` | #2103 |

Issue state was verified correct on 2026-09-17: #2083-#2091 and #2093 all CLOSED, **#2096 correctly OPEN**, #2079 and #2080 open and deferred as intended.

## Steps

### 1. Update the spec

- Rewrite the `Status:` line at `:4` to record both waves — the original five PRs on `a8bc38ef8`, and seams 5-10 closed by #2097/#2099/#2100/#2101/#2102 plus #2093 by #2103.
- Update the per-seam statuses in the table at `:30-41` from "live" to the closing PR.
- Fix `:357`.
- Leave the **Rulings** section alone. Ruling 8/E and Ruling F are still binding and are cited by the P0/P1 branch and by PR 2 of this bundle.

### 2. Update the plan bundle overview

- Complete the merged table above.
- The "⚠️ Line numbers drift" section is now more true, not less — every file the six PRs touched has shifted, and the P0/P1 branch shifted them again. Strengthen rather than delete it.
- Add a pointer to this bundle (`docs/superpowers/plans/2026-09-17-path-frame-p2-p3/`) and to the review that produced it, so a reader arriving at the old plan learns the arc has a second wave.

### 3. Record the review's outcome

Add a short section to the spec — or a sibling note — recording that a post-merge review of the six PRs found follow-up work, and where it lives. Enough that someone reading the spec cold does not conclude the arc is finished. Name the two P0s specifically, since both re-opened hazards the arc had already written down:

- a provider re-deriving `relative(repoRoot, packageDir)`, which `src/context/fragments/reframe.ts:68-74` forbids by name;
- the enforcement gate reporting `clean` on the dominant raw-read idiom, while the issue describing that bypass (#2084) sat closed.

### 4. Sweep the stale symbol references

Left behind by #2099 and not worth their own PR:

- `docs/superpowers/specs/2026-09-16-repo-rooted-agent-analysis.md:244` still budgets `toPackageFrameFiles` as a future deletion — it was deleted in `d67b56dac`.
- `test/unit/context/engine/providers/git-history.test.ts:285` names it in a comment.

If PR 2 of this bundle already took these, skip.

### 5. Gates

Docs-only, but run them anyway — `.nax/rules/` has a drift gate and specs are linted in some paths:

```
bun run typecheck && bun run lint && bun run test
```

`bun run test:coverage` is not required if you touched no code. Say so explicitly rather than silently skipping it.

## Done when

- [ ] The spec's `Status:` line names both waves and all six PRs.
- [ ] No seam row in the spec table still says "live".
- [ ] The plan bundle's table shows all six merged with commit and PR number.
- [ ] A reader of either document can find the second wave.
- [ ] `toPackageFrameFiles` has no remaining references outside historical prose.
- [ ] Gates pasted; any skipped gate named and justified.

## Do not

- Do not edit the **Rulings** sections. They are load-bearing for in-flight work.
- Do not mark #2079 or #2080 as resolved — both are deliberately deferred. #2079 in particular needs a real billed `nax plan` run and **explicit approval at the launch moment**; nothing in this bundle authorises it.
- Do not close #2096.

## Consider preventing this

Two consecutive arcs have ended with a stale `Status:` line and an un-updated plan table, each needing a dedicated cleanup pass (#2092, then this one). If a third is likely, the durable fix is a check that fails when a plan file's table references a branch or PR that is already merged while still labelled unmerged — cheap to write against `gh pr view --json state`, and it would have caught both. Out of scope here; raise it separately if the pattern repeats.
