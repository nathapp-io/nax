# nax-finish verdict recovery

**Date:** 2026-08-06
**Status:** designed, not implemented

## Problem

A reviewer node in the `nax-finish` flow returned prose instead of JSON. `parseVerdict`
threw, the node failed, and the whole flow died with exit 1 and no result file. The
post-run plugin had nothing to read and nothing to notify from.

Observed on `rs-stock/pipeline-run-chat-context`, flow run
`2026-08-05T154112386Z-nax-finish-600cf3f3`. The run itself was clean — 4/4 stories,
$27.27, 3h47m. The flow got through `load_ctx → acceptance → review_spec → route_spec →
fix_spec → commit_spec → acceptance → review_spec → route_spec` and died at
`review_quality` after 128s and ~4.2M tokens. The reviewer's final message was a
927-byte narration ending:

> "Reported two findings: a HIGH-confidence correctness regression … and a
> lower-confidence design gap …"

No `{` anywhere in it. `extractJsonObject` is already maximally lenient — `compat` mode
tries direct parse, then a fenced block, then a balanced-brace substring scan
(`acpx/src/flows/json.ts`) — and all three tiers miss on text with no braces at all.
The prompt does state the contract (`review-prompts.ts:305`, `JSON_CONTRACT`: "Return
exactly one JSON object and nothing else"), so this is model non-compliance, not a
missing instruction.

What the crash cost: the quality review's two findings, the quality gates, and the PR.
The spec-phase fix survived because `commit_spec` had already committed it
(`08986709` on `feat/pipeline-run-chat-context`).

## Blast radius

`parseVerdict` is the `parse` hook for all six acp nodes, but only two of them read the
parsed value:

| node | parsed value used? |
|:--|:--|
| `review_spec` | yes — `findingsOf` reads it |
| `review_quality` | yes — `findingsOf` reads it |
| `fix_acceptance` | no |
| `fix_spec` | no |
| `fix_quality` | no |
| `fix_gate` | no |

`findingsOf` (`flow-ctx.ts:59-62`) only ever reads `review_spec` / `review_quality`.
The four `fix_*` nodes route unconditionally (`fix_spec → commit_spec`), and
`commitFixNode` decides from git rather than from the model's word. So four nodes can
kill a multi-hour run over output nothing reads.

## Constraints

**`parse` is the only seam.** acpx's `AcpNodeDefinition` exposes `prompt`, `parse`,
`profile`, `session`, `timeoutMs` — no retry, no `onError`. `FlowEdge` is only `{to}`
or `{switch}`, so there is no error edge to route to. A fix stays inside the parse
functions and the switch cases the flow owns, or it becomes an acpx change.

**`nax-finish.flow.ts` is near a 600-line hard limit** for source files, enforced by
`bun run check:file-sizes` as part of `bun run lint`.

The count depends on which branch you measure: **568 on `origin/main`**, but **599 on
`feat/finish-pr-body`**, whose in-flight work adds 45 lines to this file. This change
branches from `origin/main`, so the additions alone (~15) would land at ~583 and pass —
until `feat/finish-pr-body` merges, at which point the same file would be ~614 and fail.

So the headroom is not optional, it is only *deferred*. Moving `routeReview` out lands
the file at ~533 on this branch and ~564 after that merge — under the limit in both
worlds, in whichever order they land.

**The `escalate` node is already the right sink.** It writes the result file *before*
attempting delivery, pushes partial fixes, and notifies Telegram — built exactly so
"a human is needed" always gets reported (#1399). The `parse` throw is the one path
that bypasses it.

## Design

### Architecture

New module `flows/nax-finish/verdict.ts` owning everything that turns a reviewer's reply
into a route: both parsers, both loop caps, the attempt counter, and `routeReview`.

Moving `routeReview` out is what makes the line budget survive the
`feat/finish-pr-body` merge (see Constraints). Removing `parseVerdict` alone (~7 lines)
against the additions (~15) nets **+8**; taking `routeReview` and its docstring too
(~31 lines) nets roughly **-35**. It is also the cohesive split: `routeReview` consumes
exactly what the parsers produce.

`MAX_FIX_ATTEMPTS` moves with it, since `routeReview` needs it. The flow file imports it
back for its three other users — the acceptance node and the two `quality_gates` caps.
No cycle: `verdict.ts` imports nothing from the flow.

`ReviewVerdict.route` (`types.ts:23`) widens from `"proceed" | "escalate" | "clean"` to
include `"reprompt"`, documented the same way `clean` already is: not a model-produced
route, synthesised by `parse` so the graph can branch on it.

### Components

```ts
// flows/nax-finish/verdict.ts
export const MAX_FIX_ATTEMPTS = 3;      // moved from nax-finish.flow.ts
export const MAX_REPROMPT_ATTEMPTS = 1;

/** review_spec / review_quality — JSON is load-bearing; garbage routes to reprompt. */
export function parseReviewVerdict(text: string): ReviewVerdict

/** fix_* — parsed value is never read; best-effort, never throws. */
export function parseFixVerdict(text: string): ReviewVerdict

/** How many times this phase's review already came back unparseable. */
export function repromptCount(ctx: StepsCtx, phase: "spec" | "quality"): number

/** Moved verbatim from the flow file, plus the reprompt branch. */
export function routeReview(ctx: OutputsCtx & StepsCtx, phase: "spec" | "quality"): {
  route: string; escalationReason?: string; findings: Finding[]
}
```

`repromptCount` and `routeReview` take `"spec" | "quality"`, not `FinishPhase` — the
latter also admits `"acceptance"` and `"gate"`, which have no review node. This matches
`incrementalSince`'s existing signature (`flow-ctx.ts:88`).

`parseReviewVerdict` keeps the existing body — `extractJsonObject`, findings array,
`proceed`-with-zero-findings rewritten to `clean` — wrapped so a throw becomes
`{ route: "reprompt", findings: [], raw: <truncated tail> }`.

`parseFixVerdict` does the same parse but returns `{ route: "proceed", findings: [] }`
on garbage. It never throws and never routes to `reprompt`, because the `fix_*` nodes
have unconditional edges with nowhere for a reprompt to go.

`repromptCount` counts step records where `nodeId === review_<phase>` **and**
`output.route === "reprompt"`. Counting bare `review_*` entries would be wrong:
`commit_quality → review_quality` and `commit_gate → review_quality` are legitimate
re-entries in the normal fix loop. This works because acpx's `FlowStepRecord` carries
`output` (`acpx/src/flows/types.ts:216-234`); the flow's local
`state: { steps: { nodeId: string }[] }` annotation is a narrowing of a richer runtime
object, so it widens to `{ nodeId: string; output?: unknown }`.

### Data flow

```
review_quality  parse fails → { route: "reprompt", findings: [], raw: <tail> }
      │
      ▼
route_quality = routeReview(ctx, "quality")
      │
      ├─ repromptCount < 1  → { route: "reprompt" } ──→ review_quality
      │                                                  (retry: true prompt)
      └─ repromptCount >= 1 → { route: "escalate",
                                 escalationReason: "quality reviewer returned
                                 unparseable output after 2 attempts: <tail>" }
                                                    ──→ escalate
```

Two new edge cases: `reprompt: "review_spec"` on `route_spec`, and
`reprompt: "review_quality"` on `route_quality`.

The review nodes' `prompt(ctx)` passes `retry: repromptCount(ctx, phase) > 0` to
`buildReviewPrompt`, which on retry leads with a hard JSON-only reminder ahead of the
existing `JSON_CONTRACT`. Both review nodes are `session: { isolated: true }`, so each
retry runs in a fresh session and the prompt is already self-contained — there is no
conversational continuity to preserve.

### Two interactions that are correct by construction

**Returning beats throwing, and that is what makes the counter work.** Because `parse`
now returns a verdict rather than throwing, acpx records the step as *successful* with
`output.route === "reprompt"`. `repromptCount` can therefore see it. Had `parse` kept
throwing, the step would be recorded `failed` with no output, and there would be nothing
to count.

**A retry is a full re-review, not a narrowed one.** `incrementalSince` scopes a
re-review to `firstCommit.shaBefore..HEAD` by finding the first `commit_*` step after
this phase's last `review_<phase>`. On a reprompt re-entry the steps are
`[… review_quality, route_quality]` — no `commit_*` follows, so it returns `null` and the
retry re-reads the whole `base...HEAD` diff. That is the right answer: the previous
attempt produced no verdict, so there is no cleared window to skip. Worth stating
explicitly so nobody later "optimises" the retry into an incremental review.

### Error handling

`routeReview` currently reads:

```ts
if (verdict?.route === "escalate") { … }
if (findings.length === 0) return { route: "clean", findings };   // ← danger
```

A reprompt verdict has zero findings. If the reprompt check goes *after* that line, an
unparseable review is read as **clean**, and the flow proceeds to `quality_gates` and
opens a PR having reviewed nothing — a silent false green, strictly worse than today's
loud crash. **The reprompt check must be the first branch in `routeReview`**, and that
ordering gets its own test.

Invariants after this change:

- No `parse` in the flow can throw. All six acp nodes become non-fatal.
- Every unparseable path terminates at `escalate`, which writes the result file before
  delivery — so the plugin always gets a result and Telegram always fires.
- `findingsOf` returns `[]` for a reprompt verdict. No phantom findings leak into a fix
  prompt or the audit trail.
- The raw tail embedded in `escalationReason` is truncated to 500 characters, since it
  lands in a PR comment and a Telegram message.

### Testing

`test/unit/flows/nax-finish/verdict.test.ts` (new):

- `parseReviewVerdict` on valid JSON, fenced JSON, and JSON embedded in prose — all
  still parse, since `extractJsonObject`'s three tiers are unchanged
- `parseReviewVerdict` on prose with no braces → `route: "reprompt"`
- `parseFixVerdict` never throws on any of the same inputs
- The regression fixture is the **real captured output** — the 927-byte artifact from
  the rs-stock run (`sha256-926e009aa773a68da5cb0aaf126d3ea50feb81dc81fd6d6f618bcd4acea4b20d`),
  not a synthetic `"not json"` string
- `repromptCount` ignores legitimate `review_*` re-entries and counts only steps whose
  output routed `reprompt`

`test/unit/flows/nax-finish/flow-graph.test.ts` (extend):

- `route_spec` and `route_quality` each have a `reprompt` case pointing back at their
  review node
- `routeReview` returns `reprompt` below the cap and `escalate` at the cap
- **a reprompt verdict is never routed `clean`** — the ordering guard

### Files

| file | change |
|:--|:--|
| `flows/nax-finish/verdict.ts` | new — both parsers, both caps, counter, `routeReview` |
| `flows/nax-finish/nax-finish.flow.ts` | drop `parseVerdict`, `routeReview`, `MAX_FIX_ATTEMPTS`; import them back; wire parsers per node; add 2 switch cases; 568 → ~533 |
| `flows/nax-finish/types.ts` | widen `ReviewVerdict.route` with `"reprompt"` |
| `flows/nax-finish/review-prompts.ts` | `retry` param on `buildReviewPrompt` |
| `test/unit/flows/nax-finish/verdict.test.ts` | new |
| `test/unit/flows/nax-finish/flow-graph.test.ts` | extend |

## Out of scope

- Node-level retry or `onError` edges in acpx. That would benefit every flow, but it
  touches a separate package and needs an acpx release.
- Reviewer model or profile changes. The failing reviewer was
  `nax-quality-reviewer` (claude-agent-acp, sonnet); swapping models is a different
  lever and would not make the flow survive the next non-compliant reply.
- The two rs-stock findings the crash discarded. They are real and tracked separately
  against `rs-stock/pipeline-run-chat-context`.
- The `nax-finish` post-run `shouldRun` gate. It correctly declines on `main`; that it
  declines at `debug` level is a separate observability issue.
