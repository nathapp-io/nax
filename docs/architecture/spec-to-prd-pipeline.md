# Spec → PRD Pipeline: how spec-writing, nax plan, and spec-review work together

> **Audience:** anyone touching the spec-kit skills (`spec-writing`, `spec-review`)
> or the nax planner (`src/operations/plan-refine.ts`, `src/prompts/builders/plan-builder.ts`).
> **Status:** SSOT for the three-component contracts around per-story **file roles**
> (`contextFiles` vs `expectedFiles`), the **cross-story produced-file** rule, and
> the **feature-level scope** contract (`## Out of Scope` → `prd.outOfScope`).

## The four-stage workflow

```
brainstorming      → spec-writing          → spec-review         → nax plan
(intent)             (intent → SPEC.md)       (codebase audit)      (decompose → prd.json)
                                                                         │
                                                                         ▼
                                                  spec-review --prd (Phase 9: fidelity gate)
                                                                         │
                                                                         ▼
                                                            per-story execution (runner)
```

Each stage hands a structured artifact to the next:

| Stage | Owns | Produces | Lives in |
|---|---|---|---|
| **spec-writing** | authoring rules, sizing, seams | `SPEC-*.md` (`Context Files` + `Creates` per story) | `nax-spec-kit/skills/spec-writing/` |
| **nax plan** | decomposition into executable slices | `prd.json` (`contextFiles` + `expectedFiles` per story) | `nax/src/operations/plan-refine.ts`, `src/prompts/builders/plan-builder.ts` |
| **spec-review** | grounding + fidelity audit | review report / `prd-fidelity-report.md` | `nax-spec-kit/skills/spec-review/` |
| **runner** | execution | merged code | `nax/src/execution/`, `src/context/builder.ts` |

The three upstream stages must agree on one model, or information silently
leaks between them. The model is **file roles**.

## The file-role model

Every file a story touches has exactly one role per story:

| Spec term | PRD key | Meaning | Existence at **plan** time | Existence at **this story's runtime** |
|---|---|---|---|---|
| `Context Files` | `contextFiles` | files the agent **reads** before coding | normally already on disk | on disk |
| `Creates` | `expectedFiles` | files **this story authors** | absent | created by this story |

`contextFiles` entries are surfaced to the agent as **path-only read hints**
(`src/context/builder.ts` — `readContextMessage`), not inlined content. A
`contextFiles` entry that is missing at the consuming story's runtime produces a
**`logger.warn("context", "Relevant file not found")`** and the run continues —
it is **not** a hard error (`src/context/builder.ts`).

## The third role: cross-story produced files

The two-role model has a blind spot. Consider a dependency chain where US-A
**creates** a file and a later US-B **reads/modifies** it:

```
US-002  Creates:        apps/web/components/ProposalCard.tsx
US-003  Context Files:  apps/web/components/ProposalCard.tsx   (US-003 integrates into it)
        depends on:     US-002
```

From US-003's perspective `ProposalCard.tsx` is:

- **not** an "existing file to read" — it does not exist at **plan** time, and
- **not** a file "US-003 authors" — **US-002** authors it.

It is a **third category**: *a file produced by an upstream dependency and
consumed by this story.* The naïve "absent at plan time ⇒ this story creates it"
heuristic mis-classifies it.

### Why it is safe to keep it in `contextFiles`

The discriminator that matters is **runtime existence relative to dependency
order**, not plan-time existence. A file produced by an upstream dependency
**does exist** by the time the consuming story runs, in **both** execution modes:

- **Sequential mode** — stories share one workdir; the producer ran first, so
  the file is on disk.
- **Parallel mode** — `groupStoriesByDependencies` puts the consumer in a
  **later batch**; successful stories **merge back to the project root before the
  next batch starts** (`src/execution/parallel-coordinator.ts`); the consumer's
  worktree is then created with `git worktree add … -b …` **with no commit-ish**,
  which branches from the current `HEAD` — now containing the producer's file
  (`src/worktree/manager.ts`).

So a cross-story produced file listed in the consumer's `contextFiles` is found
on disk at the consumer's runtime (`src/context/builder.ts`): **no warning, a
correct read hint.** Conversely, mis-moving it to the consumer's `expectedFiles`
is wrong — the consumer does not author it, and if `expectedFiles` is ever
promoted to a hard post-run asset gate, the consumer would fail for "not
creating" a file it only modifies.

### The rule (all three components)

> A `contextFiles` entry that is absent at plan time but appears in the
> `Creates`/`expectedFiles` of an **upstream dependency** story is a **legitimate
> read**. Keep it in `contextFiles`; never move it to `expectedFiles`; never drop
> it. Only an absent entry produced by **no** story is "this story creates it."

This is distinct from the still-valid rule: **never list a file _this_ story
creates under its own `Context Files`** — that file is genuinely absent at the
story's own runtime and belongs in `Creates`/`expectedFiles`.

## Where each component enforces the rule

- **spec-writing** (`reference/spec-writing-guide.md` § Context Hints, `SKILL.md`
  Phase 4): may list an upstream-produced file under the consumer's
  `Context Files`, annotated with its producer (e.g.
  `` `ProposalCard.tsx` — created by US-002, integrated here ``). The "do not
  list a file _this story_ creates" prohibition is narrowed to self-created files.
- **nax plan** (`src/operations/plan-refine.ts` → `normalizeCreatedContextFiles`):
  before classifying an absent `contextFiles` entry as "this story creates it",
  computes the union of files produced by the story's **transitive upstream
  dependencies**. If the entry is in that set, it is **kept** in `contextFiles`.
  The plan prompt (`src/prompts/builders/plan-builder.ts`) tells the LLM the same.
- **spec-review** (`skills/spec-review/SKILL.md` Phase 9 §4): the file-role delta
  check distinguishes the two sub-cases:
  - file in **this** story's `Creates` → absence from `contextFiles` is correct,
    **not a finding**;
  - file in an **upstream dependency's** `Creates`, consumed here, dropped from
    `contextFiles` → **fidelity finding** (the spec listed it; the PRD lost the
    read hint). Remediation is upstream (planner dependency-aware classification),
    **not** "add it to `contextFiles`" of a planner that would strip it again.

## Failure mode this prevents

Before this rule was made explicit, the chain silently lost the hand-off:

1. spec-writing's guide said "Context Files must already exist" with no
   cross-story carve-out → authors had no correct bucket;
2. an author honestly listed the upstream-produced file under the consumer's
   `Context Files` (technically violating the guide);
3. nax plan dropped it (prompt: "existing files only") or **mis-moved** it to the
   consumer's `expectedFiles` (`normalizeStoryFiles`: "absent ⇒ this story
   creates it");
4. spec-review's fidelity audit was told this was "correct nax behaviour, never
   flag" — so the loss was un-auditable.

Net effect: the consuming story received **no explicit pointer** to the file it
was supposed to modify, relying only on the dependency edge (which controls
ordering, not context injection) and the code-neighbor provider.

## Known limitation (deferred)

`collectUpstreamProducedFiles` (`src/operations/plan-refine.ts`) detects an
upstream-produced file via the producer's **declared `expectedFiles`** only. If a
producer story mis-files its own output under its **`contextFiles`** (absent on
disk) instead of `expectedFiles`, the consumer will not recognize the file as
upstream-produced during the same normalization pass, and it falls back to the
old behaviour (the consumer's reference is mis-moved into the consumer's
`expectedFiles`).

This requires a **double** spec-writing violation — the producer mis-roles its
own output **and** a consumer references it — which the plan prompt and
spec-writing guide now actively steer away from (created files go to
`expectedFiles`). The canonical path is therefore solid; this is residual
defensive depth only.

**Status: deferred.** The fix is a precomputed per-story "effective produced set"
(declared `expectedFiles` ∪ uncited `contextFiles` entries absent on disk) driving
the upstream lookup, with a memoized `fileExists` so the I/O is shared with the
normalize pass (~25 lines). Over-inclusion is benign — it only ever errs toward
keeping a file as a read hint, never toward a wrong move. Not implemented because
the guarded scenario is a double violation the upstream rules already prevent;
revisit if a real PRD exhibits the producer-mis-files-own-output pattern.

## The scope contract: `## Out of Scope` → `prd.outOfScope`

File roles answer "which files does this story touch?". A second contract, added
later, answers "which work must no story do at all?" — and it binds the same three
components.

A spec's `## Out of Scope` / `## Non-Goals` section states what the feature
deliberately defers. It is **not** the same thing as a story description's
`**Scope** — Out:` bullet, which states an *inter-story* boundary ("that file
belongs to US-003"). Before this contract existed the feature-level statement was
dropped entirely at the spec→PRD boundary: the PRD had no field for it and the
plan prompt never asked. Since the implementer only ever receives a `UserStory`,
nothing stopped a story from building a deferred arc.

| Component | Responsibility |
|---|---|
| **spec-writing** | Emits a machine-extractable section: recognised heading, one self-contained bullet per exclusion, ≤25 items, never phrased as an AC |
| **nax plan** | Extracts it into `prd.outOfScope`; backfills verbatim whatever the planner dropped; propagates onto every story |
| **spec-review** | Phase 5 Step 8b audits extractability; Phase 9 audits `prd.outOfScope` fidelity against the spec |

### Extraction is deterministic, not model-trusted

`src/prd/out-of-scope.ts` is the SSOT. The plan prompt *asks* the planner to emit
`outOfScope` (its wording is usually better, and only it can echo an item into the
relevant story's `Scope — Out:` bullet), but `applyOutOfScopeFallback` guarantees
the field regardless — `plan.verify` and `plan-refine.verify` restore any dropped
item verbatim from the spec. Refine additionally gets one same-session repair turn
before that backstop, mirroring the `[verbatim]` self-heal.

This differs from the `[verbatim]` AC gate, which can only *warn*: restoring an AC
requires knowing which story owns it, whereas a feature-level exclusion has exactly
one home. A drop is therefore repairable, not merely reportable.

### Storage: root is SSOT, stories carry a denormalized copy

`prd.outOfScope` is the on-disk source of truth. `loadPRD` denormalizes it onto
every story (`propagateOutOfScopeToStories`) because the implementer, rectifier,
and both reviewers only ever receive a `UserStory` — a root-only field would be
invisible to them. `savePRD` strips the mirrored copies again
(`stripPropagatedOutOfScope`) so `prd.json` does not repeat the same list N times.
Story-specific entries survive the strip; only exact feature-level mirrors are
removed.

### Known limitation: no story ancestry

`extractSpecOutOfScope` matches a heading or inline marker **wherever it appears**,
with no notion of which story section contains it. So a per-story
`### Out of scope` / `**Out of scope:**` block — which spec-writing recommends for
deferred risk properties — is hoisted to feature level and propagated to *every*
story. US-002's deferral then reaches US-001's implementer as a hard boundary.

Until the extractor models story boundaries, keep per-story deferrals in that
story's `**Scope** — Out:` bullet, and reserve `## Out of Scope` / inline markers
for genuinely feature-wide exclusions.

### Reviewers: visible and citable, but advisory

Both reviewers render the list **numbered**, because a scope finding cites
`scopeIndex` (1-based) into it. An exclusion is not an AC, so such a finding has no
`acQuote` to offer; it cites `scopeQuote` instead, validated by `validateScopeQuote`
against the indexed entry. That validation runs at **every** severity — scope
findings are capped at `"warning"` by the prompt, so a blocking-only gate would
never fire, yet an ungrounded one still reaches the story report and the next
tier's escalation context.

Scope findings do **not** block a story: `warning` is below the default
`review.blockingThreshold` of `"error"`. They land in the sub-threshold advisory
bucket, which `review.nonBlockingFix` seeds from — so with that opt-in enabled they
are best-effort auto-fixed without ever failing the story. Whether a grounded scope
finding should be allowed to block is deliberately unresolved and gated on
Phase-0 telemetry (`review.adversarial.scope_finding_accepted` /
`scope_quote_dropped`) — see [#1359](https://github.com/nathapp-io/nax/issues/1359).

## Quick reference

| Situation | `contextFiles`? | `expectedFiles`? | spec-review verdict |
|---|---|---|---|
| Existing file, read only | ✅ | — | drop = major (lost context) |
| File this story creates | ❌ | ✅ | in `contextFiles` = blocker |
| File an upstream dep creates, read/modified here | ✅ (annotated) | ❌ | kept = correct; dropped or mis-moved to `expectedFiles` = major |
| Absent, produced by no story | ❌ | ✅ (best-effort) | move is correct |

| Scope situation | Where it belongs | spec-review verdict |
|---|---|---|
| Feature defers an arc entirely | spec `## Out of Scope` → `prd.outOfScope` | missing from PRD = blocker (extraction failed) |
| Work belongs to a different story | story description `**Scope** — Out:` | inconsistent with the story's own ACs = major |
| Deferral stated only in Design prose | nowhere — never extracted | major (implementer never sees it) |
| Exclusion written as an acceptance criterion | wrong — it is work NOT to do | blocker |
