# SPEC: Deterministic nax-finish PR title and body

## Summary

The `nax-finish` flow opens or promotes its pull request with a hardcoded placeholder title (`nax-finish: <feature>`) and a one-sentence body (`Automated finish of <feature>.`), discarding every artifact the run just produced. This feature replaces both with content assembled deterministically from artifacts already on disk at the time `open_pr` runs — the PRD's story table and out-of-scope list, the status file's acceptance/regression result and run duration, the finish-audit round trail with each round's findings and fix-commit SHA, the quality gates that ran, and the branch diffstat. It also makes the flow write that title and body on **every** forge path, not just the create path, so a finish run produces an informative PR whether or not `autoPr` opened a draft first.

## Motivation

`flows/nax-finish/nax-finish.flow.ts:440-445` passes literals to `openOrPromotePr`:

```ts
const r = await openOrPromotePr(
  i.workdir,
  i.branch,
  `nax-finish: ${i.feature}`,
  `Automated finish of \`${i.feature}\`.`,
);
```

Neither forge path yields a usable body:

- **`autoPr.enabled: false`** — no draft exists, `gh pr view` exits non-zero, the create path fires and the placeholders ship verbatim. Observed on a downstream repo: 3 stories / 37 ACs green, 3 review rounds, 4 findings fixed, acceptance + regression + quality gates all passing — and a 45-character PR body that had to be hand-written afterwards. Every fact in the replacement came from artifacts nax had already written.
- **`autoPr.enabled: true`** — `openOrPromotePr` (`flows/nax-finish/steps/pr.ts:37`) only runs `gh pr ready`. It never rewrites title or body, so the PR keeps the auto-PR body, which was composed *before* the run finished and therefore carries no acceptance result, no gate result and no review findings.

Two source-side gaps make the good body unbuildable today:

1. `commitFixes()` returns `shaAfter` (`flows/nax-finish/steps/git.ts:108`); the flow destructures it, uses it only for the gate route, and drops it. `appendRound` records `committed: boolean` and no SHA, and `FinishRound` (`flows/nax-finish/types.ts:45-56`) has no field for one. "Fixed in `<sha>`" can only be reconstructed by matching round timestamps against `git log`.
2. The title `nax-finish: <feature>` does not match `auto-pr`'s `feat: <feature>` (`src/plugins/builtin/auto-pr/pr-body.ts:44`) or the conventional-commit style of the branch's own commits.

## Design

### Approach

The body is assembled by **deterministic string joins over on-disk artifacts** — no model call, no LLM-written narrative. Every section is reproducible from files that exist before `open_pr` runs.

### Integration

**The builder lives in `flows/`, not `src/` — this is a hard boundary, not a preference.**
`src/plugins/builtin/nax-finish/index.ts:13` states *"`src/` must never import from `flows/`, which is a separate, non-source-tree module"*, and the flow executes in **acpx's own Node process** (`flows/nax-finish/steps/result.ts` header, `flows/nax-finish/exec.ts` header), not in nax's Bun process. `flows/nax-finish/**` currently imports zero `src/` modules. Reusing `src/plugins/builtin/auto-pr/pr-body.ts` directly is therefore impossible; it is read as a **shape to mirror**, and the duplication is deliberate — the same precedent already applies to `FinishResult`, which the plugin re-declares locally rather than importing.

New module — `flows/nax-finish/steps/pr-body.ts`:

```ts
export interface FinishPrStory {
  id: string;
  title: string;
  acCount: number;
}

export interface FinishPrContext {
  feature: string;
  stories: FinishPrStory[];
  outOfScope: string[];
  /** `postRun.acceptance.status` from status.json; undefined when unreadable. */
  acceptance?: string;
  /** `postRun.regression.status` from status.json; undefined when unreadable. */
  regression?: string;
  /** Quality gate names that actually ran (`QualityGateOutcome.ran`). */
  gatesRan: string[];
  /** `git diff --stat <base>...HEAD` output; undefined when the diff failed. */
  diffstat?: string;
  rounds: FinishRound[];
  run: {
    durationMs?: number;
    storiesPassed?: number;
    storiesTotal?: number;
  };
}

/** Pure. No I/O. */
export function buildFinishTitle(ctx: FinishPrContext): string;
export function buildFinishBody(ctx: FinishPrContext): string;

/** I/O. Reads the artifacts below; never throws. */
export function loadFinishPrContext(
  input: FinishInput,
  args: { base: string; gatesRan: string[] },
): Promise<FinishPrContext>;
```

Existing types to extend:

- `FinishRound` (`flows/nax-finish/types.ts:45-56`) gains `sha?: string` — the fix commit's SHA, set only when `committed` is true.
- `openOrPromotePr` (`flows/nax-finish/steps/pr.ts:31`) keeps its `(repoRoot, branch, title, body)` signature and its `{ status, url }` return; the `promoted` and `already-ready` paths gain a title/body write.

Artifact sources (all verified present against `.nax/features/bounded-rules-floor/`):

| Context field | Source | Path |
|:---|:---|:---|
| `stories` | `userStories[]` → `id`, `title`, `acceptanceCriteria.length` | `input.prdPath` |
| `outOfScope` | `outOfScope[]` | `input.prdPath` |
| `acceptance`, `regression` | `postRun.acceptance.status`, `postRun.regression.status` | `status.json`, sibling of `prdPath` |
| `run.durationMs`, `run.storiesPassed/Total` | `durationMs`, `progress.passed`/`progress.total` | same `status.json` |
| `rounds` | `readRounds(input)` — already exported by `flows/nax-finish/steps/result.ts` | finish-audit `<runId>.jsonl` |
| `gatesRan` | `QualityGateOutcome.ran` — the `quality_gates` node already returns `ran` on its `green` route (`nax-finish.flow.ts:403`), the route that reaches `open_pr` | `ctx.outputs.quality_gates` |
| `diffstat` | `git diff --stat <base>...HEAD`; `base` from `detectBaseBranch`, already resolved at `load_ctx` and readable via `loadCtxOf(ctx).base` | git |

Two accessor details the implementation must handle:

- `gateOutputs` (`flows/nax-finish/flow-ctx.ts:56`) types its return as `{ failing?: string[] }` only. The `ran` field is present in `ctx.outputs.quality_gates` but not exposed — widen that accessor's return type to include `ran?: string[]`.
- `FinishInput.prdPath` is passed through verbatim from the plugin (`src/plugins/builtin/nax-finish/index.ts:300`) and is not guaranteed absolute. Resolve the sibling `status.json` against `input.workdir` when `prdPath` is relative.

Patterns to follow:

- **Injectable `_deps` object per module** — `_prBodyDeps: { readText, run }`, mirroring `_resultDeps` (`steps/result.ts`), `_qualityDeps` (`steps/quality.ts`) and `_gitDeps` (`steps/git.ts`). `mock.module()` is forbidden project-wide.
- **Node APIs only inside `flows/`** — `node:fs/promises` `readFile`, never `Bun.file`/`Bun.write`. `Bun` is undefined in acpx's process; the rule is enforced statically by `scripts/check-flows-no-bun.ts` in `bun run lint`.
- **Table-cell escaping** — mirror `escapeTableCell` in `src/plugins/builtin/auto-pr/pr-body.ts:77`; a `|` in a story title otherwise breaks the column boundary.
- **Title** — `feat: <feature>`, identical to `buildTitle` in `src/plugins/builtin/auto-pr/pr-body.ts:44`, so finish-opened and auto-PR-opened PRs read the same.

Size note: `flows/nax-finish/nax-finish.flow.ts` is currently **568 lines** against the project's 600-line source limit. The builder must be a separate module; only the `open_pr` call site and the `appendRound` argument change in the flow file.

### Body layout

The rendered PR body uses second-level section headings. The example below demotes
them one level, so that no heading token inside this fence can be mistaken for one of
this document's own parsed sections:

```markdown
### Stories
| Story | Title | ACs |
|-------|-------|-----|
| US-001 | Record the fix-commit SHA | 4 |

### Verification
- Acceptance: passed
- Regression: passed
- Quality gates: build, typecheck, lint, test
- Diffstat: <git diff --stat output>

### Review rounds
#### Round 1 — spec (attempt 1) — fixed in a1b2c3d
- **HIGH** — Finding title

### Out of scope
- <prd.outOfScope[0] verbatim>

---
5/5 stories · 126m 16s
```

A section whose source is empty renders **no heading at all** — an empty "Review rounds" heading reads as a defect.

### Failure Handling

Body assembly is **fail-open throughout**: opening the PR must never block on it.

| Failure | Behaviour |
|:---|:---|
| `prd.json` missing, unreadable, or unparseable | `stories` and `outOfScope` are empty; no throw; those sections are omitted |
| `status.json` missing, unreadable, or unparseable | `acceptance`, `regression` and `run.*` stay undefined; no throw; those lines are omitted |
| `git diff --stat` exits non-zero | `diffstat` stays undefined; no throw; the line is omitted |
| Rounds file absent | `rounds` is empty (already `readRounds`' contract); no "Review rounds" heading |
| `gh pr edit` / `glab mr update` exits non-zero | `openOrPromotePr` still returns its `promoted` / `already-ready` status and url; no throw |
| `loadFinishPrContext` or a builder throws | `open_pr` falls back to the previous literal title and body and opens the PR anyway |

## Out of Scope

- A model-written "What changed" narrative section is not part of this spec; the body is assembled deterministically from artifacts, with no agent call in the `open_pr` path.
- Lifting the spec's `## Summary` heading into the PR body as a narrative substitute is not part of this spec.
- Honouring the repository's `.github/pull_request_template.md` in the finish-opened PR is not part of this spec; `findPrTemplate` in `src/plugins/builtin/auto-pr/template.ts` stays auto-PR-only.
- Sharing code with `src/plugins/builtin/auto-pr/pr-body.ts` is not part of this spec; `src/` and `flows/` are separate modules loaded by different runtimes, and the finish builder is a flow-local reimplementation.
- Changing the auto-PR plugin's own title, body or template behaviour is not part of this spec.
- The escalation draft PR opened by `flows/nax-finish/steps/escalate.ts:71` keeps its existing `nax-finish: <branch>` title and escalation-comment body; only the `open_pr` node's PR is retitled and rewritten.
- Adding new fields to `status.json` or `prd.json` is not part of this spec; the builder reads only fields that already exist.
- The run's accumulated cost (`cost.spent` in `status.json`) is deliberately not reported anywhere in the PR body; the footer reports story counts and duration only.
- Reconciling the `nax-finish` result schema with any downstream consumer other than the PR body is not part of this spec.

## Stories

1. **US-001: Record the fix-commit SHA on every finish round** — no dependencies
2. **US-002: Deterministic finish PR title and body builder** — depends on US-001
3. **US-003: Load PRD and status artifacts into the PR context** — depends on US-002
4. **US-004: Load rounds, diffstat and gate names into the PR context** — depends on US-003
5. **US-005: Write the finished title and body on every forge path** — depends on US-004

### US-001 — Context Files
- `flows/nax-finish/steps/git.ts` — `commitFixes` returns `shaAfter`; `_gitDeps` injection pattern
- `flows/nax-finish/types.ts` — `FinishRound` definition to extend
- `flows/nax-finish/nax-finish.flow.ts` — the `commit_<phase>` node that calls `appendRound`
- `flows/nax-finish/steps/result.ts` — `appendRound` / `readRounds` / `writeResult`
- `test/unit/flows/nax-finish/flow-commits.test.ts` — existing round-recording test pattern

### US-002 — Context Files
- `src/plugins/builtin/auto-pr/pr-body.ts` — pure title/body builder shape to mirror (`buildTitle`, `escapeTableCell`, story table)
- `flows/nax-finish/types.ts` — `FinishRound`, `Finding`, `Severity`

### US-002 — Creates
- `flows/nax-finish/steps/pr-body.ts` — `FinishPrContext`, `buildFinishTitle`, `buildFinishBody`

### US-003 — Context Files
- `flows/nax-finish/steps/pr-body.ts` — created by US-002, extended here with `loadFinishPrContext`
- `flows/nax-finish/steps/quality.ts` — `_qualityDeps.readText` ENOENT-as-absent pattern
- `flows/nax-finish/types.ts` — `FinishInput` (`prdPath`, `workdir`, `feature`)
- `src/execution/status-file.ts` — `NaxStatusFile` / `PostRunStatus` field names to read
- `.nax/features/bounded-rules-floor/status.json` — a real status file to shape fixtures against

### US-004 — Context Files
- `flows/nax-finish/steps/pr-body.ts` — extended by US-003, extended further here
- `flows/nax-finish/steps/result.ts` — `readRounds` and its `_resultDeps` injection pattern
- `flows/nax-finish/steps/git.ts` — `_gitDeps.run` argv pattern for the diffstat call
- `flows/nax-finish/steps/context.ts` — `detectBaseBranch`, the source of `base`
- `flows/nax-finish/types.ts` — `FinishRound`, `FinishInput`

### US-005 — Context Files
- `flows/nax-finish/steps/pr.ts` — `openOrPromotePr`, `parseView`, forge argv construction
- `flows/nax-finish/nax-finish.flow.ts` — the `open_pr` node call site
- `flows/nax-finish/steps/pr-body.ts` — created by US-002 and extended by US-003/US-004, consumed here
- `test/unit/flows/nax-finish/steps/pr.test.ts` — existing `_prDeps` argv-assertion pattern
- `test/unit/flows/nax-finish/flow-commits.test.ts` — existing flow-node invocation pattern

### Seams

- **S1 (US-001 → US-004):** `readRounds` returns rounds carrying `sha`; US-004's loader passes them through to `FinishPrContext.rounds`, which US-002's builder renders.
- **S2 (US-002/US-003/US-004 → US-005):** `buildFinishTitle`, `buildFinishBody` and `loadFinishPrContext` are new exported symbols consumed by the flow's `open_pr` node. US-005 declares behavioural seam ACs that stub each builder, invoke `open_pr` (the flow node the acpx runtime calls — the outermost production entry point in this module, with no wiring guard between it and `openOrPromotePr` other than the `nothing-to-finish` early return, which US-005 pins separately), and assert the stubbed values reach `openOrPromotePr`.
- **S3 (US-003/US-004 → US-002):** every field `buildFinishBody` renders is produced by a loader AC — `stories`, `outOfScope`, `acceptance`, `regression` and `run.*` by US-003; `rounds`, `diffstat` and `gatesRan` by US-004; `feature` by US-003.

## Acceptance Criteria

### US-001: Record the fix-commit SHA on every finish round

- [unit] When a `commit_<phase>` node runs with a dirty working tree, the round appended to the audit trail carries `sha` equal to the `HEAD` sha `git rev-parse HEAD` reported after the commit.
- [unit] When a `commit_<phase>` node runs with a clean working tree, the appended round has `committed: false` and no `sha` field.
- [unit] `readRounds` returns a round with its `sha` preserved when the audit trail line contains one.
- [unit] `writeResult` writes a result whose `rounds[]` entries carry the `sha` recorded for each round.

### US-002: Deterministic finish PR title and body builder

- [unit] `buildFinishTitle` returns `feat: <feature>` for a context whose `feature` is `<feature>`.
- [unit] `buildFinishBody` renders one story-table row per `stories[]` entry in the form `| <id> | <title> | <acCount> |`.
- [unit] `buildFinishBody` renders a story whose `title` contains a `|` with that character escaped, so the row still parses as three columns.
- [unit] `buildFinishBody` renders a Verification line reporting the context's `acceptance` value.
- [unit] `buildFinishBody` renders a Verification line reporting the context's `regression` value.
- [unit] `buildFinishBody` renders a Verification line listing every gate name in `gatesRan`.
- [unit] `buildFinishBody` includes the context's `diffstat` text verbatim in the Verification section.
- [unit] `buildFinishBody` renders one round heading per `rounds[]` entry, each naming that round's `phase` and `attempt`.
- [unit] `buildFinishBody` renders each finding of a round as a bullet carrying that finding's `severity` and `title`.
- [unit] `buildFinishBody` renders the abbreviated 7-character `sha` in the heading of a round whose `committed` is true and whose `sha` is set.
- [unit] `buildFinishBody` renders no sha in the heading of a round whose `committed` is false.
- [unit] `buildFinishBody` returns a body containing no `Review rounds` heading when `rounds` is empty.
- [unit] `buildFinishBody` renders one bullet per `outOfScope[]` entry, each carrying that entry's text unchanged.
- [unit] `buildFinishBody` returns a body containing no `Out of scope` heading when `outOfScope` is empty.
- [unit] `buildFinishBody` renders a single footer line in the form `<storiesPassed>/<storiesTotal> stories · <durationMs formatted as Nm SSs>`.

### US-003: Load PRD and status artifacts into the PR context

- [unit] `loadFinishPrContext` returns `stories` with one entry per `userStories[]` entry in the PRD at `input.prdPath`, each carrying that story's `id`, `title` and its `acceptanceCriteria` length as `acCount`.
- [unit] `loadFinishPrContext` returns `outOfScope` equal to the PRD's `outOfScope` array.
- [unit] `loadFinishPrContext` returns `feature` equal to `input.feature`.
- [unit] `loadFinishPrContext` reads the status file at `status.json` in the same directory as `input.prdPath`.
- [unit] `loadFinishPrContext` resolves that status file path against `input.workdir` when `input.prdPath` is a relative path.
- [unit] `loadFinishPrContext` returns `acceptance` equal to the status file's `postRun.acceptance.status`.
- [unit] `loadFinishPrContext` returns `regression` equal to the status file's `postRun.regression.status`.
- [unit] `loadFinishPrContext` returns `run.durationMs` equal to the status file's `durationMs`.
- [unit] `loadFinishPrContext` returns `run.storiesPassed` equal to the status file's `progress.passed`.
- [unit] `loadFinishPrContext` returns `run.storiesTotal` equal to the status file's `progress.total`.
- [unit] `loadFinishPrContext` returns empty `stories` and empty `outOfScope`, and does not throw, when the file at `input.prdPath` does not exist.
- [unit] `loadFinishPrContext` returns empty `stories` and empty `outOfScope`, and does not throw, when the file at `input.prdPath` contains text that is not valid JSON.
- [unit] `loadFinishPrContext` returns `acceptance` and `regression` undefined, and does not throw, when the status file does not exist.
- [unit] `loadFinishPrContext` returns `acceptance` and `regression` undefined, and does not throw, when the status file contains text that is not valid JSON.

### US-004: Load rounds, diffstat and gate names into the PR context

- [unit] `loadFinishPrContext` returns `rounds` equal to what `readRounds` returns for the same input, with each round's `sha` preserved.
- [unit] `loadFinishPrContext` returns `gatesRan` equal to the `gatesRan` array passed in its `args` argument.
- [unit] `loadFinishPrContext` invokes `git diff --stat <base>...HEAD` using the `base` value passed in its `args` argument.
- [unit] `loadFinishPrContext` returns the stdout of that `git diff --stat` invocation as `diffstat`.
- [unit] `loadFinishPrContext` returns `diffstat` undefined, and does not throw, when the `git diff --stat` invocation exits non-zero.
- [unit] `loadFinishPrContext` returns an empty `rounds` array, and does not throw, when the audit trail file for the run does not exist.

### US-005: Write the finished title and body on every forge path

- [unit] `openOrPromotePr` on a GitHub repo whose branch has a draft PR invokes `gh pr edit <branch> --title <title> --body <body>` with the title and body it was passed, after invoking `gh pr ready`.
- [unit] `openOrPromotePr` still returns status `promoted` for that draft-PR case.
- [unit] `openOrPromotePr` on a GitHub repo whose branch has a non-draft PR invokes `gh pr edit <branch> --title <title> --body <body>` and returns status `already-ready`.
- [unit] `openOrPromotePr` on a GitHub repo whose branch has no PR invokes `gh pr create` with the same `--title` and `--body` values it was passed and returns status `opened`.
- [unit] `openOrPromotePr` on a GitLab repo whose branch has a draft MR invokes `glab mr update <branch> --title <title> --description <body>`.
- [unit] `openOrPromotePr` returns status `promoted` with the PR url, and does not throw, when the `gh pr edit` invocation exits non-zero.
- [unit] Stubbing `buildFinishTitle` to return a known string and invoking the flow's `open_pr` node calls `openOrPromotePr` with that string as its title argument.
- [unit] Stubbing `buildFinishBody` to return a known string and invoking the flow's `open_pr` node calls `openOrPromotePr` with that string as its body argument.
- [unit] Invoking the flow's `open_pr` node when the loaded context routes to `nothing-to-finish` returns without invoking `loadFinishPrContext`.
- [unit] Invoking the flow's `open_pr` node when `loadFinishPrContext` throws still calls `openOrPromotePr`, passing the fallback title `nax-finish: <feature>`.

<!-- spec-writing: completed-through-phase-6 -->
