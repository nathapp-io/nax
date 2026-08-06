# nax-finish PR body: "What changed" narrative and repository template

**Date:** 2026-08-06
**Status:** designed, not implemented
**Closes:** #1477, #1478
**Branch:** `feat/finish-pr-narrative-and-template` (worktree, off `main` @ `4e802d98`)

## Problem

`buildFinishBody` (`flows/nax-finish/steps/pr-body.ts:276`) assembles the finish PR body
from artifacts only — story table, verification, review rounds, out-of-scope, footer.
Every section is reproducible from files that exist before `open_pr` runs, which is what
keeps the body greppable in PR history. There is no agent call in that path, by design.

Two things are missing from it, and #1469 split them into two follow-ups:

**#1477 — nothing in the body says what actually changed.** A reader gets story titles,
AC counts, a diffstat and a list of findings. There is no prose describing the change.

**#1478 — the repository's own PR/MR template is dropped.** `gh` and `glab` suppress the
repo's default template whenever `--body` / `--description` is passed, so a finish-opened
PR silently loses a template that an auto-PR-opened PR keeps. The two differ for no
principled reason.

Both land in the same function and the same test files, so they ship together. Split
across two PRs, the second rebases onto the first's edit of the same 18-line body
composition and the same `pr-body.test.ts`.

### Why the narrative cannot just be lifted from the spec

Copying `spec.md` §Summary verbatim is deterministic and cheap, and it is what the
fallback path does. It is not sufficient as the primary source, because a spec describes
**intent, not what shipped**. #1469 recorded the failure from a real run: the spec named
one module path, the implementation landed at another, and only the spec-review round
forced them back into agreement. On a run where such a deviation is *accepted* rather
than corrected, a spec-derived narrative confidently describes code that does not exist.

The narrative is therefore written against the real branch diff, and the spec summary is
the degraded fallback — correct ordering, because a stale summary is better than no
section, and both are better than a wrong description presented as authoritative.

## Constraints

These are properties of the codebase, not preferences. Each one has already cost a
previous run on this flow.

1. **`flows/` imports nothing from `src/`.** The flow module is loaded by acpx, in acpx's
   own Node process, with the user's repo as cwd. `src/` and the `@/*` alias are not
   available. `findPrTemplate` therefore cannot be called — it must be ported. This is
   the same constraint that made #1469's proposal item 1 impossible as written.

2. **No `Bun.*` under `flows/`** — enforced by `scripts/check-flows-no-bun.ts`.

3. **`flows/nax-finish/nax-finish.flow.ts` is at 561 lines against a 600-line hard cap**
   (`.nax/rules/project-conventions.md:30`). The new node and every line of its prompt
   must live in separate modules.

4. **No acpx execution in tests.** `acpx` is a runtime dependency of the flow, not a
   test harness. The narrative node's *behaviour* cannot be exercised by running the
   flow. Anything that must be verified has to be reachable as a pure function.

5. **`tsconfig.json` excludes `test/`** (`include: ["src/**/*.ts", ..., "flows/**/*.ts"]`,
   `exclude: [..., "test", ...]`). Nothing under `test/unit/` is typechecked. Type
   guarantees that must actually be enforced belong in `test/contracts/`.

6. **The `autoFlow` schema repeats its defaults three times** — the `autoFlow` object's
   own `.default()`, the enclosing `finish` object's `.default()`, and the nested
   `timeouts` `.default()`. Adding a field without updating every literal makes the
   parsed shape diverge silently from the declared one.

## Design

### Architecture

One acp node is added to the flow graph, on the green edge out of `quality_gates`. It
writes prose and nothing else. Every deterministic fact stays where it is.

```
load_ctx --nothing-to-finish--------------------------> open_pr
quality_gates --green--> narrative --------------------> open_pr
              (narrative disabled at module load: --green--> open_pr)
```

`open_pr` reads `ctx.outputs.narrative`. When the key is missing — node skipped by
config, node failed, parse returned nothing — the body assembly takes the same single
fallback path. There is one branch for all three cases, not three.

The `nothing-to-finish` edge always bypasses the node: there is no diff to narrate.

### Config surface

Two orthogonal knobs under the already-opt-in `finish.autoFlow`:

| Key | Type | Default | Meaning |
|:--|:--|:--|:--|
| `finish.autoFlow.narrative` | `boolean` | `true` | Spend an agent turn writing the section at all |
| `finish.autoFlow.reviewers.narrative` | `string \| null` | `null` | acpx profile that writes it; `null` → `--default-agent` |

`narrative: false` skips the node and the body falls back to the mechanical path.
Default `true` because `finish.autoFlow.enabled` is already `false` by default — a
second opt-in behind an opt-in ships the feature inert.

**No new timeout.** Agent turns in this flow are bounded globally by
`finish.autoFlow.timeouts.stepMs`, forwarded to acpx as `--timeout` in `buildFlowArgv`
(`src/plugins/builtin/nax-finish/index.ts:227`). `acceptanceMs` and `gateMs` bound shell
subprocesses (test groups, quality commands), not agent turns — the reviewer nodes have
no dedicated timeout either, and the narrative node is an acp step exactly like them.

The boolean `narrative` sitting beside the string `reviewers.narrative` is a mild naming
tension, accepted deliberately: the alternative is a nested `narrative: { enabled,
profile }` block whose default literal would have to be repeated in all three places
named in constraint 6.

Forwarding, mirroring the existing profile plumbing at `index.ts:249`:

- `NAX_FINISH_NARRATIVE_PROFILE` — set when `reviewers.narrative` is non-null
- `NAX_FINISH_NARRATIVE` — set to `"0"` when `narrative` is `false`; left unset otherwise

The flow reads both at module load, like `NAX_FINISH_SPEC_PROFILE` already is
(`nax-finish.flow.ts:275`), because the module reloads fresh on every `acpx flow run`.

The enable rule is **disabled only on an explicit `"0"`**:
`const narrativeEnabled = process.env.NAX_FINISH_NARRATIVE !== "0"`. An unset variable
means enabled, so a flow invoked directly by `acpx flow run` — outside the plugin that
sets the env — still writes the narrative. Defaulting the other way would make the
feature inert for exactly the people testing it by hand.

### Components

| Module | Status | Responsibility |
|:--|:--|:--|
| `flows/nax-finish/narrative.ts` | new | prompt builder, `parse`, `resolveNarrative`, `readSpecSummary` |
| `flows/nax-finish/pr-template.ts` | new | ported candidate-path template lookup |
| `flows/nax-finish/steps/pr-body.ts` | edit | two new sections in `buildFinishBody`; context gains two fields |
| `flows/nax-finish/steps/pr.ts` | edit | `openOrPromotePr` accepts a forge instead of detecting one |
| `flows/nax-finish/nax-finish.flow.ts` | edit | acp node, conditional green edge, forge threading in `open_pr` |
| `src/config/schemas.ts` | edit | two Zod fields + three default literals |
| `src/config/runtime-types-finish.ts` | edit | `FinishAutoFlowConfig` gains `narrative` |
| `src/plugins/builtin/nax-finish/config.ts` | edit | read both keys with defaults |
| `src/plugins/builtin/nax-finish/index.ts` | edit | `buildFlowEnv` emits both env vars |

`runtime-types.ts` is at its file-size limit; the finish types already live in
`runtime-types-finish.ts` for that reason, and the new field goes there.

### Data flow

`FinishPrContext` gains two optional fields:

```ts
narrative?: string;   // resolved prose, or absent
template?: string;    // repository PR/MR template verbatim, or absent
```

`loadFinishPrContext(input, args)` gains `specPath`, `forge`, and `narrative` in `args`.
`specPath` is already resolved once at `load_ctx` (`nax-finish.flow.ts:253`, surfaced via
`flow-ctx.ts:35`) and feeds the review prompts; the loader reuses it rather than
resolving the feature a second time.

Inside the loader, template resolution and spec-summary reading join the existing
`Promise.all` — both are independent reads and neither should serialise behind the PRD.

Resolution order for the narrative, as one pure function:

```ts
resolveNarrative(agentText: string | undefined, specSummary: string | null): string | undefined
```

1. `agentText` non-empty after trim → use it
2. else `specSummary` non-empty → use it
3. else `undefined`

`buildNarrativeSection(narrative)` returns `null` when the input is `undefined`, so the
heading and its text are produced by the same function. That is what makes "no text, no
heading" structurally true rather than a rule a future edit has to remember — #1477
forbids an empty `## What changed` heading explicitly.

The narrative is capped at 4000 characters, truncated with a trailing `…`. A model that
ignores the prompt and pastes the diff must not be able to render the body unreadable.

### Body layout

```
## What changed        <- narrative (model or fallback), omitted entirely when absent
## Stories             <- unchanged
## Verification        <- unchanged
## Review rounds       <- unchanged
## Out of scope        <- unchanged
<footer>               <- unchanged
<repository template>  <- appended verbatim, omitted when none resolves
```

Narrative first: a reader wants orientation before the evidence table, and it is the
section most likely to be read at all. Template last: it is an appendix, and appending it
after the footer keeps every deterministic section contiguous.

### Spec summary extraction

`readSpecSummary(specPath, readText)` returns the first `## Summary` **or** `## Overview`
block, up to the next `## ` heading, or `null`.

Both headings are accepted because both occur in this repository's real specs: of the six
`.nax/features/*/spec.md` files on `main`, five use `## Summary` and the older
`plugin-001` uses `## Overview`. This is deliberately validated against real specs rather
than an invented fixture — a fixture matching one real shape is how a feature ships inert
on the dominant one.

Returns `null` on a missing file, a missing heading, or an empty body. Reuses
`_prBodyDeps.readText`, so ENOENT stays silent — the same seam as every other read in
this module.

### The narrative prompt

Built by a pure function in `narrative.ts`. It:

- names the base ref and instructs the agent to read `git diff <base>...HEAD` itself,
  matching how `review_spec` / `review_quality` already work (`review-prompts.ts:357`,
  `:375`) rather than pasting a diff that may not fit
- lists the deterministic sections by name — story table, verification results, gate
  outcomes, findings — as **already rendered and not to be restated**
- states the length budget and asks for prose, not a bulleted change log that would
  duplicate the story table by another route

Restatement is where the model-written and artifact-derived halves of the body drift
apart, so suppressing it is the prompt's main job after describing the diff.

`parse` extracts the prose and never throws. A `parse` that throws fails the node, and a
failed node is the one outcome this feature must not be able to produce — but see error
handling: the graph tolerates it either way.

### Template port

`flows/nax-finish/pr-template.ts` is a near-verbatim port of
`src/plugins/builtin/auto-pr/template.ts` (60 lines): the same four GitHub candidate
paths in the same priority order, the same single GitLab path
(`.gitlab/merge_request_templates/Default.md`), the same `firstExisting` loop. The only
change is the signature — the `AutoPrDeps` type import becomes a structural
`{ readText }` parameter.

This matches the existing convention in this flow, which already carries its own
`errors.ts`, `exec.ts`, `types.ts`, re-declares `FinishResult`, and (as of #1475)
re-implements the PR body builder. A shared `src`/`flows` core would be a new
architectural concept introduced for forty lines; if that extraction is wanted it should
be its own work covering all five existing duplications.

Duplication risk is low: the candidate paths are an external convention set by GitHub and
GitLab, not internal logic that drifts.

### Forge threading

`detectForge` currently runs **inside** `openOrPromotePr` (`steps/pr.ts:47`), which is
after `buildFinishBody` has already been called (`nax-finish.flow.ts:425`). The template
lookup needs the forge kind before the body exists.

`open_pr` therefore detects the forge once, up front, and passes it into both
`loadFinishPrContext` and `openOrPromotePr`; the latter stops detecting it itself.
Detecting twice would be cheap, but it would let the body and the create-command disagree
about the forge — a real, if unlikely, bug rather than merely wasted work.

### Error handling

Every failure mode degrades to a shorter body. None can fail the PR.

| Failure | Outcome |
|:--|:--|
| `narrative: false` | node not in the graph; fallback path |
| Node fails or times out | `ctx.outputs.narrative` absent; fallback path |
| `parse` yields empty/whitespace | treated as absent; fallback path |
| Spec file missing / no `## Summary` or `## Overview` | section omitted entirely |
| Narrative over 4000 chars | truncated with `…` |
| No repository template | nothing appended, nothing warned — the common case |
| Template read fails | nothing appended, nothing warned |
| `detectForge` throws | existing `open_pr` try/catch already falls back to the default title/body |

Absent template is a normal outcome, not a warning: most repositories have none.

## Testing

Driven by constraints 4 and 5 — the narrative node's behaviour is unreachable in tests,
so every guarantee is placed on a pure function or on the graph's shape.

**Pure functions, tested directly** (`test/unit/flows/nax-finish/`):
`resolveNarrative` across all three branches · `readSpecSummary` against both real
heading shapes, a missing heading, a missing file, an empty body · `buildNarrativeSection`
returning `null` for absent input · `buildFinishBody` section ordering, and that an absent
narrative emits no `## What changed` heading anywhere · the ported `findPrTemplate` over
its candidate-path priority order for both forges · the narrative prompt builder.

**Graph shape** (`flow-graph.test.ts`): reload the flow module with `NAX_FINISH_NARRATIVE`
set and unset, assert the `quality_gates` green edge targets `narrative` vs `open_pr`, and
assert the `nothing-to-finish` edge targets `open_pr` in both cases. This tests the enable
flag for real without running acpx.

**Wiring, both sides of the handoff** (`flow-graph-open-pr-metadata.test.ts`): assert that
the key `open_pr` reads is the key the narrative node writes, in one test. Stories 3 and 4
are exactly the shape where ACs go green while nothing is wired — a string-keyed handoff
asserted from only one side is the recorded failure mode.

**Prompt content**: assert the prompt names the deterministic sections as off-limits.
This is #1477's "no restatement" criterion tested where it is enforceable — a runtime
assertion on a builder's return value, not a grep against source.

**Config** (`test/unit/config/`, `test/unit/plugins/nax-finish/`): both new keys parse
with defaults and with explicit values; `buildFlowEnv` emits `NAX_FINISH_NARRATIVE_PROFILE`
only when the profile is non-null and `NAX_FINISH_NARRATIVE=0` only when disabled.

**File cap**: an assertion that `nax-finish.flow.ts` stays under 600 lines.

**Type guarantees** in `test/contracts/` — the only test directory the typecheck gate
covers.

## Stories

| # | Story | Scope |
|:--|:--|:--|
| 1 | Config surface: `narrative` flag and `reviewers.narrative` profile through schema → runtime type → `config.ts` → `buildFlowEnv` | `src/` only |
| 2 | Template port and forge threading, appended to the body | `flows/` only |
| 3 | Narrative module: prompt builder, `parse`, `resolveNarrative`, `readSpecSummary`, body section | `flows/` only |
| 4 | Graph wiring: acp node, conditional green edge, `open_pr` forge + narrative threading | `nax-finish.flow.ts` |

Story 1 is independent and may land first. Story 4 consumes story 3's exports and is
ordered after it. Story 2 is independent of 3 and 4 apart from both editing
`buildFinishBody` — a sequencing note for the run, not a dependency.

## Out of scope

- Extracting a shared `src`/`flows` core for the five existing duplications. That is its
  own deliberate piece of work, not a side effect of this ticket.
- A dedicated `narrativeMs` timeout. `stepMs` already bounds every agent turn in this flow.
- Multi-template directories (`.github/PULL_REQUEST_TEMPLATE/`). The auto-PR plugin skips
  them as ambiguous unattended; the port keeps that behaviour rather than diverging.
- Filling in the repository template's checkboxes or sections. It is appended verbatim.
- Renaming `finish.autoFlow.reviewers` to `profiles`. Cleaner end state, but it renames a
  shipped config key and needs back-compat plus a migration note.
- Any change to the deterministic sections' content or ordering relative to each other.
