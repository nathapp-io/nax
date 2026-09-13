# rtk savings measurement — US-001 results

**Date:** 2026-09-13 · **Repo:** nax at `230f25551` · **rtk:** 0.45.0 · **Harness:** `scripts/analyze-rtk-savings.ts`
**Spec:** `docs/superpowers/specs/2026-09-13-nax-rtk-command-interception-design.md` (US-001)

US-001 is the gate on the rtk interception feature: it decides which sites are worth
wiring and which git verbs enter `git.verbs`. This is its output.

**Outcome:** the feature is cut to one site. `git.verbs` ships `["log", "diff"]`. See
**R10** in the spec for the ruling and its reasons.

## Result (run 4 — final harness, 12-commit sample)

```
verb	n	rawKB	rtkKB	saved%	delivered-saved%	median%	min%	max%	verdict
show	24	1042	257	75.4	41.9	52.9	0.0	99.6	DISQUALIFIED — exit-code divergence on 12/24
diff	14	951	286	70.0	27.9	21.6	-7.3	53.3	ok
log	3	139	9	93.2	85.0	84.6	0.0	91.7	ok
blame	1	23	23	0.0	0.0	0.0	0.0	0.0	ok
coverage	1	4	4	-0.4	-0.4	-0.4	-0.4	-0.4	ok
lint	2	1	1	0.0	0.0	0.0	0.0	0.0	ok
status	1	1	0	47.1	47.1	47.1	47.1	47.1	ok
test	1	0	0	0.0	0.0	0.0	0.0	0.0	ok
build	1	0	0	0.0	0.0	0.0	0.0	0.0	ok
typecheck	2	0	0	0.0	0.0	0.0	0.0	0.0	ok

NOT MEASURED (absent from the table above, not a measured zero):
  testScoped	placeholder template, not executable as written
  lintFix	mutating: would write to the working tree
  formatFix	mutating: would write to the working tree
```

`delivered-saved%` is the number that matters: the reduction in what the model is actually
told, after nax's 40 KB per-tool slice. `saved%` is the reduction in full output, which
flatters any verb whose raw output already exceeded the cap. `median/min/max` are
per-sample delivered savings, and they are the columns that make R8's "must survive
re-sampling" rule checkable.

Measured with a dirty working tree (this change in progress), which affects only
`diff-plain` / `diff-nameonly` — see the known limits below.

### Verb rulings

| verb | in `git.verbs` | why |
|---|---|---|
| `log` | **yes** | 85.0% delivered, median 84.6%. Stable across independent runs (93.5% / 93.2% raw). The 0.0% min is `log --oneline`, already compact |
| `diff` | **yes** | 27.9% delivered, median 21.6%. Admitted on the median, not the mean — but see the caveat below |
| `show` | no | Saves as much as `diff`, but `rtk git show <ref> --name-only` exits 128 where raw git exits 0, on all 12 sampled commits. Parity is a correctness gate: nax derives `success` from the exit code. Same shape as open issues #2011 and #1800 |
| `blame` | no | Byte-identical. rtk passes it through |
| `status` | no | 47% of ~1 KB |

**Caveat on `diff`, recorded rather than smoothed over:** its per-sample range is −7.3% to
53.3%. On at least one sampled commit rtk produced *more* output than raw git. The verb
earns its place on a 21.6% median across 14 samples, not on a uniform win, and a
`never_worse`-style guard (§2.4) is what bounds the downside in practice. If US-004's
implementation cannot rely on that guard, `diff` should be re-examined.

## The methodological finding: one sample is not a measurement

`diff-ref` and `show` measure a single commit, so they measure whatever that commit
happened to contain. Across four runs of the *same harness against the same repo*:

| run | HEAD | last-commit size | `diff` delivered |
|---|---|---|---|
| 1 | `8b65247dd` (docs) | 8.6 KB | 1.8% |
| 2 | `230f25551` (feature merge) | 76.8 KB | 37.5% (67.4% raw) |
| 3 | 12-commit sample, pre-review harness | — | 27.3% |
| 4 | 12-commit sample, final harness | — | **27.9%** (median 21.6%) |

Runs 3 and 4 differ only in the harness fixes below and in working-tree state; run 4 is
canonical and is the one quoted everywhere else in this document.

A 20× swing in the delivered figure, none of it about rtk. (Quote these consistently:
run 2's `diff` is 37.5% *delivered* and 67.4% *raw* — mixing the two metrics across runs
manufactures a contradiction that is not in the data.) Run 1's figure would have kept
`diff` out of the table; run 2's would have overstated it. Only the sampled figure is
evidence.

`log` is the control: its output does not depend on HEAD position, and it scored 93.5% and
93.2% across two independent runs. That is what a stable measurement looks like.

**Consequence:** R8 now requires a saving to survive re-sampling before a verb is admitted.
`buildGitCorpus(refs)` takes a ref list, and the harness samples 12 commits by default
(`RTK_SAMPLE_COMMITS` to override). Because a byte-weighted mean still lets one large
commit carry a row, the report also prints per-sample `median% / min% / max%` — the
re-sampling criterion is not evaluable from an aggregate alone.

## Why the shell sites were dropped

### Success path: no saving

Every *passing* user-authored quality command measures byte-identical through rtk:

| command | raw | rtk |
|---|---|---|
| `test` | 312 | 312 |
| `build` | 200 | 200 |
| `typecheck` ×2 | 0 | 0 |
| `coverage` | 4,161 | 4,324 |

`coverage` looks like a regression and is not one: its raw output is not byte-stable run to
run (measured at 4,161, 4,324 and 4,342 bytes across three runs, because it prints
timings), so the −0.4% / −3.9% / −8.4% deltas across runs are noise around zero. Every
other row is exact.

This matters more than it looks, and not because of the numbers: nax's quality commands
route through `scripts/quiet-run.ts`, which prints one `OK:` line when `AGENT=1` and the
command passes. There is nothing to compress because the repo already compressed it.

### Failure path: shape-dependent, and genuinely unresolved

A failing gate is verbose, and that is when nax re-reads it — so this is the case that
would matter. It was probed twice, and the two probes disagree:

| probe | failing command | raw | rtk | saving |
|---|---|---|---|---|
| broken module (accidental) | `test` | 8,156 | 3,419 | **58.1%** |
| broken module (accidental) | `lint` | 2,616 | 2,020 | **22.8%** |
| type error (controlled) | `lint` | 2,964 | 2,964 | **0.0%** |
| type error (controlled) | `typecheck` | 98 | 98 | 0.0% |

The difference is the *shape* of the failure output, not its size. A Bun stack trace has
the repetition rtk's filters are built for; Biome's structured diagnostics do not. Which
shape a repo's gates produce on failure is a property of the user's toolchain.

**So the honest summary is not "rtk saves nothing at these sites."** It is: nothing on the
path that always runs, and somewhere between 0% and 58% on the path that sometimes does,
unpredictably. That is why R10 does not rest on this measurement — see its reasons 2-4,
which hold whatever a red build would have shown.

The first of these probes was an accident: the harness ran while the repo was mid-edit, so
the gates failed. It is reported because it is evidence, not because it was designed. The
second was run deliberately, against a temporary file with a type error, which was removed
afterwards.

## Harness defects found and fixed

Both were found by running the harness, not by reading it — and both had already been
written into the spec as findings about rtk.

1. **Env-prefixed commands were mis-measured as rtk failures.** The wrapper emitted
   `rtk AGENT=1 bun run lint:biome`; rtk tried to exec `AGENT=1` and exited 127. Runs 1
   and 2 reported this as an exit-code DISQUALIFICATION for the whole `lint` verb. Fixed
   by `injectRtk`, which places `rtk` after leading assignments — `lint` now measures at
   parity, 0.0% saving. Kept as R10's reason 3: naive prefixing of a user's command string
   is wrong, and nax should not ship a shell parser to guess where the wrapper belongs.
2. **Mutating commands were executed.** `buildQualityCorpus` took every key from
   `quality.commands`, including `lintFix` and `formatFix` (`bun run lint:fix`), and ran
   each twice per run — four writes to the working tree, against the plan's own "never
   execute a mutating command" constraint. Fixed by `isMutatingQualityCommand`.

Two further defects were found in review and fixed: `injectRtk` silently corrupted quoted
assignment values (`FOO="a b" bun test` → `FOO="a rtk b" bun test`, which never invokes rtk
and therefore reports a clean 0% at perfect parity — a *silent* wrong answer in a table
whose conclusion is a set of measured zeros), and `recentCommits` returned `[]` on any
git failure, which silently dropped `show` from the report and every `diff` sample. Both
now refuse loudly instead.

Recorded as known limits, not fixed:

- `diff-plain` and `diff-nameonly` measure the uncommitted working tree, so on a clean
  checkout they measure 0 bytes and contribute nothing. Noise, not signal.
- `raw` always runs before `rtk`, so rtk gets the warm filesystem and cache. `rawMs`/`rtkMs`
  are not comparable and are not printed.
- No timeout: the corpus includes the full test suite twice, and a hung gate hangs the
  harness with no diagnostic.
- Merge commits are not excluded. `git show <merge>` prints no diff by default, so a
  merge sample biases `show` toward zero. Latent here (all 12 sampled commits are
  single-parent, this repo squash-merges) but not on a merge-heavy repo.

## Reproducing

```bash
bun scripts/analyze-rtk-savings.ts              # 12-commit sample
RTK_SAMPLE_COMMITS=30 bun scripts/analyze-rtk-savings.ts
```

Skips cleanly when rtk is not on PATH, and prints a `NOT MEASURED` list naming every
command it declined to run and why — a skip is never reported as a measured 0%.

The corpus does not modify **tracked** files, which is the guarantee it actually offers.
It is not inert: `build` writes `dist/`, `coverage` writes a report, and `test` writes its
own temp state — all gitignored, and each runs twice. Expect it to take as long as a test
run plus a coverage run.

## What this does not prove

Savings here are **bytes of command output, not billed tokens**. rtk ships no tokenizer —
`src/core/tracking.rs` estimates tokens as `bytes / 4` — so its ratios are reliable and its
absolute counts are not. Per spec §7, the token claim needs the same story run with
`enabled: false` and `enabled: true`, compared on cost-ledger spend and turn count. That
A/B has **not** been run. Nothing here justifies a token-savings claim on its own.
