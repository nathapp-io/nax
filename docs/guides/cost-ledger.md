# Cost Ledger

Every agent call a run makes is recorded as one JSON line in the project's cost ledger. `nax cost` reads those ledgers back, across projects and date ranges, without an LLM call and without writing anything.

## Where the ledger lives

One file per run: `<project output dir>/cost/<runId>.jsonl`.

The project output dir is `~/.nax/<project>` by default, where `<project>` is `name` in the project's `.nax/config.json` (or the folder name when `name` is unset). `outputDir` in the config moves it. `NAX_GLOBAL_CONFIG_DIR` replaces `~/.nax`.

Each line is one call. The fields `nax cost` reads:

| Field | Meaning |
|:------|:--------|
| `ts` | Epoch ms of the call. Rows without a numeric `ts` are skipped |
| `runId`, `projectKey`, `featureName`, `storyId` | Attribution. A row without `projectKey` takes the name of the project output dir it sits in |
| `model`, `stage`, `sessionRole` | What ran, in which stage and session role |
| `tokens` | `input`, `output`, `cacheRead`, `cacheWrite`. Missing fields count as 0 |
| `costUsd` | The call's cost. Missing counts as $0 |
| `confidence` | `exact` when the agent reported the cost, `estimated` when nax priced it from a rate card |
| `kind: "error"` | A failed dispatch. Counted like any other row, and also in `errorCalls` |
| `partial: true` | A turn still in flight when the row was written. Counted like any other row |

## Querying it

```bash
nax cost --today --by stage                     # today's spend per stage, all projects
nax cost --since 2026-10-01 --by project        # this month per project
nax cost --since 2026-10-13 --until 2026-10-19 --by model,role
nax cost --here --feature oct19-bundle --by story
nax cost --run <runId> --json                   # one run, machine-readable
```

**Which ledgers are scanned.** By default, every directory under `~/.nax` that has a `cost/` dir. `--here` scans only the project at `--dir` (default: cwd), resolved from its config; use it for a project whose `outputDir` sits outside `~/.nax`. `--project <name>` filters rows by project key; it does not change which directories are scanned.

**The date window.** `--since` starts at 00:00 of that day. `--until` includes the whole day. `--today` starts at 00:00 today and cannot be combined with either. Days are local time unless `--utc` is given.

**Grouping.** `--by` takes a comma list of `model`, `stage`, `role`, `project`, `feature`, `run`, `story`. Each distinct combination becomes one line, sorted by cost, highest first. A row missing a grouped field shows `(none)`. Without `--by` you get the total only.

## Reading the output

```
stage   calls  runs     input   output  cacheRead  cacheWrite  costUsd
review     62     7   3915157   182324   19921141      512723    10.54
run        63     7   9339245  1535185  394610425           0     6.68
plan        8     4    447589   112319    9489752        3932     3.00
(none)      3     1     88414    36871   16705024           0     0.09
TOTAL     136    11  13790405  1866699  440726342      516655    20.31
exact $3.85 / estimated $16.46
```

- `calls` counts rows, failed dispatches included. `runs` counts distinct run ids in the group, so the column does not sum to `TOTAL`.
- `exact / estimated` splits the total by `confidence`. A failed-dispatch row counts as exact when it carries an exact cost. The estimated share is only as good as the rate card, so compare like with like when you track a change.
- `skipped <n> unparseable row(s)` appears only when some lines were not valid JSON, had no numeric `ts`, or had a non-numeric `costUsd`. Those rows are excluded from every figure.

`--json` prints one `CostLedgerReport` document instead: `schemaVersion`, the resolved `sinceMs` / `untilMs` (or `null`), `groups` (each with `key` plus the totals), `total`, `skippedRows` and `filesScanned`. The totals are `calls`, `errorCalls`, `runs`, `input`, `output`, `cacheRead`, `cacheWrite`, `costUsd`, `exactUsd` and `estimatedUsd`.

Exit code `0` means a report was produced, including an empty one. `1` means a usage error (a bad date, an unknown `--by` key, `--today` with `--since`) or a ledger file that could not be read. The message goes to stderr as `Error: <message>`.

## `nax cost` vs `nax status --cost`

`nax status --cost` reports the current project's run metrics (per run, last run, per model). `nax cost` reads the raw ledger, so it can span projects, cut by any date range, and group by stage, role, feature or story.

See also: [CLI reference — `nax cost`](cli-reference.md#nax-cost).
