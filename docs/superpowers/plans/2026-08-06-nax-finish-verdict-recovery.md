# nax-finish Verdict Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the `nax-finish` flow from dying on a reviewer reply that isn't JSON — reprompt once, then escalate through the flow's existing human-needed sink.

**Architecture:** Extract verdict parsing and review routing out of `nax-finish.flow.ts` into a new `flows/nax-finish/verdict.ts`. Split the single `parseVerdict` into a strict-but-recoverable `parseReviewVerdict` (for the two review nodes, whose JSON is load-bearing) and a never-throwing `parseFixVerdict` (for the four fix nodes, whose parsed value nothing reads). An unparseable review returns `route: "reprompt"` instead of throwing; `routeReview` loops back to the review node once, then converts to `escalate`.

**Tech Stack:** Bun 1.3.7+, TypeScript strict, `bun:test`, Biome. The flow module is loaded by `acpx` in its own Node process.

## Global Constraints

- **`flows/` must never import from `src/`** — not via the `@/*` alias, not relatively. Only `flows/` is published. Use `FinishError` from `./errors`, never `NaxError`.
- **No `Bun.*` APIs anywhere under `flows/`** — enforced by `bun run check:flows-no-bun`. The flow runs in acpx's Node process.
- **600-line hard limit** for source files, **800** for test files. Enforced by `bun run check:file-sizes`, which runs as part of `bun run lint`.
- **Functions ≤30 lines, ≤3 positional params.**
- **No `any` in public APIs.** TypeScript strict.
- **Conventional commits**, one concern per commit.
- Test imports use the `@flows/...` alias (e.g. `@flows/nax-finish/verdict`), matching the existing files in `test/unit/flows/nax-finish/`.

## Baseline facts (verified on this branch, `feat/nax-finish-verdict-recovery` @ `origin/main`)

| Anchor | Location |
|:--|:--|
| `const MAX_FIX_ATTEMPTS = 3;` | `nax-finish.flow.ts:74` |
| `routeReview` docstring | `nax-finish.flow.ts:130-135` |
| `function routeReview(` | `nax-finish.flow.ts:136` |
| `function parseVerdict(` | `nax-finish.flow.ts:257` |
| flow file length | 568 lines |

`nax-finish.flow.ts` is **568 lines here** but **599 on `feat/finish-pr-body`**, which is in flight and adds 45 lines to this same file. Do not be surprised by the discrepancy; the extraction is sized so the file passes the limit either way.

## File Structure

| File | Responsibility |
|:--|:--|
| `flows/nax-finish/verdict.ts` | **new** — turning a reviewer's reply into a route: both parsers, both loop caps, `repromptCount`, `routeReview` |
| `flows/nax-finish/types.ts` | widen `ReviewVerdict.route` with `"reprompt"` |
| `flows/nax-finish/review-prompts.ts` | `retry` flag on `buildReviewPrompt` |
| `flows/nax-finish/nax-finish.flow.ts` | delete the moved code, import it back, wire the two parsers per node, add two switch cases, pass `retry` |
| `test/unit/flows/nax-finish/verdict.test.ts` | **new** — parsers, counter, routing |
| `test/unit/flows/nax-finish/flow-graph.test.ts` | extend — reprompt edges |
| `test/unit/flows/nax-finish/review-prompts.test.ts` | extend — retry prompt |

---

### Task 1: Widen `ReviewVerdict.route` and create `verdict.ts` with the two parsers

**Files:**
- Modify: `flows/nax-finish/types.ts:17-26`
- Create: `flows/nax-finish/verdict.ts`
- Test: `test/unit/flows/nax-finish/verdict.test.ts`

**Interfaces:**
- Consumes: `ReviewVerdict`, `Finding` from `./types`; `extractJsonObject` from `acpx/flows`.
- Produces: `parseReviewVerdict(text: string): ReviewVerdict`, `parseFixVerdict(text: string): ReviewVerdict`, `MAX_REPROMPT_ATTEMPTS: number`, `MAX_FIX_ATTEMPTS: number`, `RAW_TAIL_LIMIT: number`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/flows/nax-finish/verdict.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { parseFixVerdict, parseReviewVerdict } from "@flows/nax-finish/verdict";

// The real 927-byte reply that killed flow run 2026-08-05T154112386Z-nax-finish-600cf3f3
// on rs-stock/pipeline-run-chat-context. Not a synthetic "not json" string: the point is
// that a chatty reviewer emits no brace at all, which defeats every extractJsonObject tier.
const REAL_UNPARSEABLE =
  "Good, not a concern — self-contained change with a matching doc comment. " +
  "Let's check the Python test files briefly for pipeline.py resolver, and the " +
  "`apps/api/_pipeline_adapter.py` registration for unused import warnings etc." +
  "Good, that exists as expected. Now let's check the gate-blocked probing logic once " +
  "more and the `measureForNode`/`findGateBlocker` for edge cases against the AC that " +
  '"does not render the gate\'s own output payload" — seems fine. I have enough for ' +
  "findings.Reported two findings: a HIGH-confidence correctness regression (screen/" +
  "backtest chat context now emits `Strategy: undefined | Universe: undefined`).";

const FINDING = { severity: "HIGH", title: "t", problem: "p", fix: "f" };

describe("parseReviewVerdict", () => {
  test("parses a bare JSON object", () => {
    const v = parseReviewVerdict(JSON.stringify({ route: "proceed", findings: [FINDING] }));
    expect(v.route).toBe("proceed");
    expect(v.findings).toHaveLength(1);
  });

  test("rewrites proceed-with-no-findings to clean", () => {
    expect(parseReviewVerdict(JSON.stringify({ route: "proceed", findings: [] })).route).toBe("clean");
  });

  test("honours an explicit escalate route", () => {
    const v = parseReviewVerdict(JSON.stringify({ route: "escalate", findings: [], escalationReason: "r" }));
    expect(v.route).toBe("escalate");
    expect(v.escalationReason).toBe("r");
  });

  test("still parses fenced JSON", () => {
    const v = parseReviewVerdict('```json\n{"route":"proceed","findings":[]}\n```');
    expect(v.route).toBe("clean");
  });

  test("still parses JSON embedded in prose", () => {
    const v = parseReviewVerdict(`Here you go:\n{"route":"proceed","findings":[]}\nDone.`);
    expect(v.route).toBe("clean");
  });

  test("routes reprompt on the real unparseable reply, with no findings", () => {
    const v = parseReviewVerdict(REAL_UNPARSEABLE);
    expect(v.route).toBe("reprompt");
    expect(v.findings).toEqual([]);
  });

  test("carries a bounded tail of the raw reply", () => {
    const v = parseReviewVerdict("x".repeat(2000));
    expect(v.raw).toBeDefined();
    expect((v.raw as string).length).toBeLessThanOrEqual(500);
  });

  test("routes reprompt on empty output", () => {
    expect(parseReviewVerdict("").route).toBe("reprompt");
  });
});

describe("parseFixVerdict", () => {
  test("parses JSON like the review parser", () => {
    expect(parseFixVerdict(JSON.stringify({ route: "proceed", findings: [FINDING] })).findings).toHaveLength(1);
  });

  test("never throws and never routes reprompt on garbage", () => {
    const v = parseFixVerdict(REAL_UNPARSEABLE);
    expect(v.route).toBe("proceed");
    expect(v.findings).toEqual([]);
  });

  test("never throws on empty output", () => {
    expect(parseFixVerdict("").route).toBe("proceed");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/flows/nax-finish/verdict.test.ts --timeout=30000`
Expected: FAIL — cannot resolve module `@flows/nax-finish/verdict`.

- [ ] **Step 3: Widen the route union in `types.ts`**

In `flows/nax-finish/types.ts`, replace the `ReviewVerdict` interface (currently lines 17-26):

```ts
export interface ReviewVerdict {
  /**
   * Neither `clean` nor `reprompt` is a model-produced route.
   *
   * `clean` — `parse` rewrites `proceed` with zero findings, so the graph can
   * skip the fix node instead of prompting an agent to "apply fixes" for nothing.
   *
   * `reprompt` — `parse` could not read JSON out of the reply at all. Returning
   * this rather than throwing is deliberate: a throw fails the acp node and kills
   * the whole flow with no result file, bypassing the `escalate` sink that exists
   * to report exactly this kind of dead end.
   */
  route: "proceed" | "escalate" | "clean" | "reprompt";
  findings: Finding[];
  escalationReason?: string;
  /** Bounded tail of an unparseable reply; set only when `route` is `reprompt`. */
  raw?: string;
}
```

- [ ] **Step 4: Write `verdict.ts`**

Create `flows/nax-finish/verdict.ts`:

```ts
/**
 * Turning a reviewer's reply into a deterministic route.
 *
 * Lives outside `nax-finish.flow.ts` for two reasons: the flow file sits within
 * a few lines of the 600-line hard limit, and this is a cohesive unit —
 * `routeReview` consumes exactly what the parsers produce.
 *
 * The central invariant: **no parser here ever throws.** acpx has no node-level
 * retry and no error edge (`AcpNodeDefinition` offers only `prompt`/`parse`;
 * `FlowEdge` is only `to` or `switch`), so a throw inside `parse` fails the node
 * and fails the run — exit 1, no result file, no notification, bypassing the
 * `escalate` node that exists to report precisely this.
 */
import { extractJsonObject } from "acpx/flows";
import type { Finding, ReviewVerdict } from "./types";

/** Fix rounds allowed per loop before escalating. Moved here with `routeReview`. */
export const MAX_FIX_ATTEMPTS = 3;

/**
 * Unparseable reviews tolerated per phase before escalating.
 *
 * One. A reviewer that ignores the JSON contract twice in a row is not going to
 * comply on a third ask, and each review is the most expensive node in the flow
 * (128s and ~4.2M tokens on the run that motivated this).
 */
export const MAX_REPROMPT_ATTEMPTS = 1;

/** How much of an unparseable reply to carry forward — it lands in a PR comment and a Telegram message. */
export const RAW_TAIL_LIMIT = 500;

function tail(text: string): string {
  const t = text.trim();
  return t.length <= RAW_TAIL_LIMIT ? t : `…${t.slice(-RAW_TAIL_LIMIT)}`;
}

/** Shared happy path: read the object, normalise findings, rewrite empty `proceed` to `clean`. */
function parseVerdictJson(text: string): ReviewVerdict {
  const raw = extractJsonObject(text) as Partial<ReviewVerdict>;
  const findings: Finding[] = Array.isArray(raw.findings) ? raw.findings : [];
  const route = raw.route === "escalate" ? "escalate" : findings.length === 0 ? "clean" : "proceed";
  return { route, findings, escalationReason: raw.escalationReason };
}

/**
 * Parser for `review_spec` / `review_quality`, whose JSON is load-bearing —
 * `findingsOf` reads it and the fix loop is driven by it. An unreadable reply
 * routes to `reprompt` so `routeReview` can ask once more before escalating.
 */
export function parseReviewVerdict(text: string): ReviewVerdict {
  try {
    return parseVerdictJson(text);
  } catch {
    return { route: "reprompt", findings: [], raw: tail(text) };
  }
}

/**
 * Parser for the four `fix_*` nodes, whose parsed value nothing reads —
 * `findingsOf` only ever looks at `review_spec`/`review_quality`, and
 * `commitFixNode` decides from git rather than from the model's word.
 *
 * Never routes `reprompt`: the fix nodes have unconditional edges
 * (`fix_spec → commit_spec`), so a reprompt route would have nowhere to go.
 */
export function parseFixVerdict(text: string): ReviewVerdict {
  try {
    return parseVerdictJson(text);
  } catch {
    return { route: "proceed", findings: [] };
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test test/unit/flows/nax-finish/verdict.test.ts --timeout=30000`
Expected: PASS, 11 tests.

- [ ] **Step 6: Commit**

```bash
git add flows/nax-finish/verdict.ts flows/nax-finish/types.ts test/unit/flows/nax-finish/verdict.test.ts
git commit -m "feat(nax-finish): split verdict parsing into review and fix parsers

An unparseable reviewer reply routes to reprompt instead of throwing. A
throw inside parse fails the acp node and kills the run with no result
file, bypassing the escalate sink built to report exactly this."
```

---

### Task 2: Add `repromptCount` and move `routeReview` into `verdict.ts`

**Files:**
- Modify: `flows/nax-finish/verdict.ts`
- Test: `test/unit/flows/nax-finish/verdict.test.ts`

**Interfaces:**
- Consumes: `parseReviewVerdict`, `MAX_FIX_ATTEMPTS`, `MAX_REPROMPT_ATTEMPTS` from Task 1; `fixAttemptCount`, `StepsCtx`, `OutputsCtx` from `./flow-ctx`.
- Produces: `repromptCount(ctx: StepsCtx, phase: "spec" | "quality"): number`, and `routeReview(ctx: OutputsCtx & StepsCtx, phase: "spec" | "quality"): { route: string; escalationReason?: string; findings: Finding[] }`.

**Why `repromptCount` cannot just count `review_*` steps:** `commit_quality → review_quality` and `commit_gate → review_quality` are legitimate re-entries in the normal fix loop. The counter must look at each step's recorded *output*. It can, because acpx's `FlowStepRecord` carries `output` — and `StepsCtx` (`flow-ctx.ts:23-25`) already declares `steps: { nodeId: string; output?: unknown }[]`.

- [ ] **Step 1: Write the failing test**

Append to `test/unit/flows/nax-finish/verdict.test.ts`:

```ts
import { MAX_FIX_ATTEMPTS, MAX_REPROMPT_ATTEMPTS, repromptCount, routeReview } from "@flows/nax-finish/verdict";

const stepsCtx = (steps: { nodeId: string; output?: unknown }[]) => ({ state: { steps }, outputs: {} });
const routeCtx = (verdict: unknown, steps: { nodeId: string; output?: unknown }[] = []) => ({
  outputs: { review_quality: verdict },
  state: { steps },
});
const REPROMPT_STEP = { nodeId: "review_quality", output: { route: "reprompt", findings: [] } };
const CLEAN_STEP = { nodeId: "review_quality", output: { route: "clean", findings: [] } };

describe("repromptCount", () => {
  test("is zero with no steps", () => {
    expect(repromptCount(stepsCtx([]), "quality")).toBe(0);
  });

  test("ignores legitimate review re-entries that produced a real verdict", () => {
    expect(repromptCount(stepsCtx([CLEAN_STEP, { nodeId: "commit_quality" }, CLEAN_STEP]), "quality")).toBe(0);
  });

  test("counts only steps whose output routed reprompt", () => {
    expect(repromptCount(stepsCtx([CLEAN_STEP, REPROMPT_STEP]), "quality")).toBe(1);
  });

  test("does not count the other phase's reprompts", () => {
    expect(repromptCount(stepsCtx([REPROMPT_STEP]), "spec")).toBe(0);
  });
});

describe("routeReview", () => {
  test("a reprompt verdict is NEVER routed clean", () => {
    // Regression guard. A reprompt verdict has zero findings, so an ordering
    // slip that checks `findings.length === 0` first would call an unread
    // review "clean" and open a PR having verified nothing — a silent false
    // green, strictly worse than the crash this change removes.
    const r = routeReview(routeCtx({ route: "reprompt", findings: [], raw: "prose" }), "quality");
    expect(r.route).not.toBe("clean");
    expect(r.route).toBe("reprompt");
  });

  test("escalates once the reprompt cap is reached, naming the raw tail", () => {
    const steps = Array.from({ length: MAX_REPROMPT_ATTEMPTS }, () => REPROMPT_STEP);
    const r = routeReview(routeCtx({ route: "reprompt", findings: [], raw: "some prose" }, steps), "quality");
    expect(r.route).toBe("escalate");
    expect(r.escalationReason).toContain("unparseable");
    expect(r.escalationReason).toContain("some prose");
  });

  test("still routes clean when there are no findings", () => {
    expect(routeReview(routeCtx({ route: "clean", findings: [] }), "quality").route).toBe("clean");
  });

  test("still routes fix when there are findings under the cap", () => {
    expect(routeReview(routeCtx({ route: "proceed", findings: [FINDING] }), "quality").route).toBe("fix");
  });

  test("still escalates an explicit escalate verdict", () => {
    const r = routeReview(routeCtx({ route: "escalate", findings: [], escalationReason: "judgment" }), "quality");
    expect(r.route).toBe("escalate");
    expect(r.escalationReason).toBe("judgment");
  });

  test("still escalates when findings persist past the fix cap", () => {
    const steps = Array.from({ length: MAX_FIX_ATTEMPTS }, () => ({ nodeId: "fix_quality" }));
    const r = routeReview(routeCtx({ route: "proceed", findings: [FINDING] }, steps), "quality");
    expect(r.route).toBe("escalate");
    expect(r.escalationReason).toContain("fix attempts");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/flows/nax-finish/verdict.test.ts --timeout=30000`
Expected: FAIL — `repromptCount` and `routeReview` are not exported.

- [ ] **Step 3: Append `repromptCount` and `routeReview` to `verdict.ts`**

First extend the import block at the top of the file — these three names are unused until
now, so adding them in Task 1 would have tripped Biome's unused-import rule:

```ts
import { fixAttemptCount, type OutputsCtx, type StepsCtx } from "./flow-ctx";
```

Then append:

```ts
/**
 * How many times this phase's review already came back unparseable.
 *
 * Counts step *outputs*, not step ids: `commit_quality → review_quality` and
 * `commit_gate → review_quality` are legitimate re-entries in the normal fix
 * loop, so counting bare `review_<phase>` steps would escalate a healthy run.
 *
 * This is observable only because `parseReviewVerdict` returns rather than
 * throws — a returned verdict makes acpx record the step as successful with
 * this output. A throw would record it `failed`, with nothing to count.
 */
export function repromptCount(ctx: StepsCtx, phase: "spec" | "quality"): number {
  return (ctx.state.steps ?? []).filter(
    (s) => s.nodeId === `review_${phase}` && (s.output as ReviewVerdict | undefined)?.route === "reprompt",
  ).length;
}

/**
 * Turn a reviewer verdict into a deterministic route.
 *
 * `clean` (no findings) skips the fix node entirely — prompting an agent to
 * "apply the recommended fixes" for an empty finding list burns a turn and
 * invites unrequested edits.
 *
 * The `reprompt` branch MUST come first. A reprompt verdict carries zero
 * findings, so checking `findings.length === 0` ahead of it would route an
 * unreadable review to `clean`, and the flow would open a PR having reviewed
 * nothing. That silent false green is worse than the crash this replaces.
 */
export function routeReview(
  ctx: OutputsCtx & StepsCtx,
  phase: "spec" | "quality",
): { route: string; escalationReason?: string; findings: Finding[] } {
  const verdict = (ctx.outputs as Record<string, ReviewVerdict | undefined>)[`review_${phase}`];
  const findings = verdict?.findings ?? [];
  if (verdict?.route === "reprompt") {
    const attempts = repromptCount(ctx, phase);
    if (attempts < MAX_REPROMPT_ATTEMPTS) return { route: "reprompt", findings };
    return {
      route: "escalate",
      escalationReason:
        `${phase} reviewer returned unparseable output after ${attempts + 1} attempts. ` +
        `Last reply: ${verdict.raw ?? "(empty)"}`,
      findings,
    };
  }
  if (verdict?.route === "escalate") {
    return {
      route: "escalate",
      escalationReason: verdict.escalationReason ?? `${phase} review raised a finding needing human judgment`,
      findings,
    };
  }
  if (findings.length === 0) return { route: "clean", findings };
  const attempts = fixAttemptCount(ctx, `fix_${phase}`);
  if (attempts >= MAX_FIX_ATTEMPTS) {
    return {
      route: "escalate",
      escalationReason: `${phase} review still reporting ${findings.length} finding(s) after ${attempts} fix attempts.`,
      findings,
    };
  }
  return { route: "fix", findings };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/unit/flows/nax-finish/verdict.test.ts --timeout=30000`
Expected: PASS, 21 tests.

- [ ] **Step 5: Commit**

```bash
git add flows/nax-finish/verdict.ts test/unit/flows/nax-finish/verdict.test.ts
git commit -m "feat(nax-finish): route unparseable reviews to a capped reprompt

The reprompt branch is checked before the findings-empty branch: a
reprompt verdict has zero findings, so the reverse order would call an
unread review clean and ship a PR having verified nothing."
```

---

### Task 3: Add the retry variant to `buildReviewPrompt`

**Files:**
- Modify: `flows/nax-finish/review-prompts.ts:330-333` (signature) and both return branches
- Test: `test/unit/flows/nax-finish/review-prompts.test.ts`

**Interfaces:**
- Consumes: nothing from Tasks 1-2.
- Produces: `buildReviewPrompt(phase, args)` gains an optional `retry?: boolean` on `args`. Task 4 passes it.

`buildReviewPrompt` has two return branches — a full review (no `args.since`) and an incremental one (with `since`). Both end with `JSON_CONTRACT`. The retry notice goes at the **front** of both, where a lead instruction is hardest to lose, while `JSON_CONTRACT` stays last.

- [ ] **Step 1: Write the failing test**

Append to `test/unit/flows/nax-finish/review-prompts.test.ts`:

```ts
describe("buildReviewPrompt retry variant", () => {
  const base = { base: "origin/main", specPath: "spec.md" };

  test("omits the retry notice by default", () => {
    expect(buildReviewPrompt("quality", base)).not.toContain("previous reply could not be parsed");
  });

  test("leads a full review with the retry notice when retrying", () => {
    const p = buildReviewPrompt("quality", { ...base, retry: true });
    expect(p).toContain("previous reply could not be parsed");
    expect(p.indexOf("previous reply could not be parsed")).toBeLessThan(p.indexOf("You are the QUALITY reviewer"));
  });

  test("leads an incremental review with the retry notice too", () => {
    const p = buildReviewPrompt("spec", { ...base, since: "abc123", priorFindings: [], retry: true });
    expect(p).toContain("previous reply could not be parsed");
    expect(p).toContain("abc123");
  });

  test("keeps the JSON contract last on a retry", () => {
    const p = buildReviewPrompt("quality", { ...base, retry: true });
    expect(p.trimEnd().endsWith("}")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/flows/nax-finish/review-prompts.test.ts --timeout=30000`
Expected: FAIL — the retry notice is absent, and `retry` is not on the args type.

- [ ] **Step 3: Implement**

In `flows/nax-finish/review-prompts.ts`, add above `buildReviewPrompt`:

```ts
/**
 * Prepended when a previous attempt at this review returned something that was
 * not JSON. Lead position, not appended: the failure mode is a model that
 * narrates its findings and forgets the contract at the end of a long turn.
 */
const RETRY_NOTICE = [
  "IMPORTANT — your previous reply could not be parsed as JSON, so it was discarded entirely.",
  "Do not narrate your findings in prose. Do not describe what you reported.",
  "Your entire reply must be the JSON object described at the end of this prompt: first char `{`, last char `}`.",
].join("\n");
```

Change the signature to accept `retry`:

```ts
export function buildReviewPrompt(
  phase: "spec" | "quality",
  args: { base: string; specPath: string; since?: string | null; priorFindings?: Finding[]; retry?: boolean },
): string {
  const dims = phase === "spec" ? SPEC_REVIEW_DIMENSIONS : QUALITY_REVIEW_DIMENSIONS;
  const lead = args.retry ? [RETRY_NOTICE] : [];
```

Then spread `lead` into the front of both existing return arrays. The full-review branch becomes:

```ts
  if (!args.since) {
    return [
      ...lead,
      `You are the ${phase.toUpperCase()} reviewer for a completed feature.`,
      `The spec/requirements source is: ${args.specPath}. Read it in full.`,
      `Fetch and review the diff: \`git diff ${args.base}...HEAD\` (also \`--name-only\` for the file list).`,
      WORKER_PROTOCOL,
      dims,
      CLASSIFIER,
      JSON_CONTRACT,
    ].join("\n\n");
  }
```

And the incremental branch keeps every one of its existing entries in order, with `...lead,` inserted as the first element:

```ts
  return [
    ...lead,
    `You are the ${phase.toUpperCase()} reviewer for a completed feature, continuing a review you already started.`,
    // ...every existing entry unchanged, through JSON_CONTRACT
  ].join("\n\n");
```

Change nothing else about either array.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/unit/flows/nax-finish/review-prompts.test.ts --timeout=30000`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add flows/nax-finish/review-prompts.ts test/unit/flows/nax-finish/review-prompts.test.ts
git commit -m "feat(nax-finish): lead a retried review with a JSON-only notice"
```

---

### Task 4: Wire the flow — delete the moved code, add the reprompt edges

**Files:**
- Modify: `flows/nax-finish/nax-finish.flow.ts` — delete lines 74 (`MAX_FIX_ATTEMPTS`), 130-135 + 136-158 (`routeReview` + docstring), 255-262 (`parseVerdict` + docstring); update imports; wire parsers; add switch cases; pass `retry`
- Test: `test/unit/flows/nax-finish/flow-graph.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1-3.
- Produces: the finished graph. Nothing downstream depends on new names.

Verify the exact line numbers with `grep -n "^const MAX_FIX_ATTEMPTS\|^function routeReview\|^function parseVerdict" flows/nax-finish/nax-finish.flow.ts` before deleting — a preceding task may have shifted them.

- [ ] **Step 1: Write the failing test**

Append to `test/unit/flows/nax-finish/flow-graph.test.ts`:

```ts
describe("reprompt edges", () => {
  test("route_spec routes reprompt back to review_spec", () => {
    expect(switchOf("route_spec").cases.reprompt).toBe("review_spec");
  });

  test("route_quality routes reprompt back to review_quality", () => {
    expect(switchOf("route_quality").cases.reprompt).toBe("review_quality");
  });

  test("the existing routes are untouched", () => {
    expect(switchOf("route_quality").cases.clean).toBe("quality_gates");
    expect(switchOf("route_quality").cases.fix).toBe("fix_quality");
    expect(switchOf("route_quality").cases.escalate).toBe("escalate");
  });

  test("route_quality yields reprompt for an unparseable verdict", async () => {
    const out = await nodeRun<{ route: string }>("route_quality").run(
      ctxOf({ outputs: { review_quality: { route: "reprompt", findings: [], raw: "prose" } } }),
    );
    expect(out.route).toBe("reprompt");
  });

  test("review_quality leads with the retry notice after a reprompt", () => {
    const node = flow.nodes.review_quality as unknown as { prompt: (c: FlowNodeContext) => string };
    const prompt = node.prompt(
      ctxOf({
        outputs: { load_ctx: { base: "origin/main", specPath: "spec.md" } },
        steps: [{ nodeId: "review_quality", output: { route: "reprompt", findings: [] } }] as never,
      }),
    );
    expect(prompt).toContain("previous reply could not be parsed");
  });

  test("a retried review is a FULL review, not an incremental one", () => {
    // incrementalSince scopes a re-review to firstCommit.shaBefore..HEAD by finding
    // the first commit_* step after the last review_<phase>. On a reprompt re-entry
    // no commit_* follows, so it returns null and the whole base...HEAD diff is
    // re-read. That is right — the previous attempt produced no verdict, so there is
    // no cleared window to skip. Pinned so nobody "optimises" it into an incremental.
    const node = flow.nodes.review_quality as unknown as { prompt: (c: FlowNodeContext) => string };
    const prompt = node.prompt(
      ctxOf({
        outputs: { load_ctx: { base: "origin/main", specPath: "spec.md" } },
        steps: [{ nodeId: "review_quality", output: { route: "reprompt", findings: [] } }] as never,
      }),
    );
    expect(prompt).toContain("git diff origin/main...HEAD");
    expect(prompt).not.toContain("continuing a review you already started");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/flows/nax-finish/flow-graph.test.ts --timeout=30000`
Expected: FAIL — `cases.reprompt` is `undefined`.

- [ ] **Step 3: Implement**

1. Delete `const MAX_FIX_ATTEMPTS = 3;`, the whole `routeReview` function with its docstring, and the whole `parseVerdict` function with its docstring.

2. Update the imports at the top:

```ts
import { defineFlow } from "acpx/flows";   // extractJsonObject no longer used here
```

and add:

```ts
import { MAX_FIX_ATTEMPTS, parseFixVerdict, parseReviewVerdict, repromptCount, routeReview } from "./verdict";
```

3. Point each acp node at the right parser:

| node | `parse:` |
|:--|:--|
| `review_spec` | `parseReviewVerdict` |
| `review_quality` | `parseReviewVerdict` |
| `fix_acceptance` | `parseFixVerdict` |
| `fix_spec` | `parseFixVerdict` |
| `fix_quality` | `parseFixVerdict` |
| `fix_gate` | `parseFixVerdict` |

4. Pass `retry` from both review nodes' `prompt(ctx)`. For `review_quality`:

```ts
      prompt(ctx) {
        const outs = loadCtxOf(ctx);
        return buildReviewPrompt("quality", {
          base: outs.base ?? "origin/main",
          specPath: outs.specPath ?? "",
          since: incrementalSince(ctx, "quality"),
          priorFindings: findingsOf(ctx, "quality"),
          retry: repromptCount(ctx, "quality") > 0,
        });
      },
```

Make the identical change in `review_spec` with `"spec"` in all four places.

5. Add the `reprompt` case to both review switch edges:

```ts
    {
      from: "route_spec",
      switch: {
        on: "$.route",
        cases: { clean: "review_quality", fix: "fix_spec", escalate: "escalate", reprompt: "review_spec" },
      },
    },
```

```ts
    {
      from: "route_quality",
      switch: {
        on: "$.route",
        cases: { clean: "quality_gates", fix: "fix_quality", escalate: "escalate", reprompt: "review_quality" },
      },
    },
```

- [ ] **Step 4: Run the flow tests**

Run: `bun test test/unit/flows/nax-finish/ --timeout=60000`
Expected: PASS, including the pre-existing `flow-graph.test.ts` and `flow-commits.test.ts` suites.

- [ ] **Step 5: Verify the line budget and the full gate**

```bash
wc -l flows/nax-finish/nax-finish.flow.ts   # expect ~533, must be < 600
bun run lint
bun run typecheck
```

Expected: `wc -l` under 600, and both commands clean. `bun run lint` includes `check:file-sizes` and `check:flows-no-bun`.

- [ ] **Step 6: Commit**

```bash
git add flows/nax-finish/nax-finish.flow.ts test/unit/flows/nax-finish/flow-graph.test.ts
git commit -m "feat(nax-finish): wire the reprompt route into the review loops

Moves routeReview and MAX_FIX_ATTEMPTS to verdict.ts. The flow file sits
within a few lines of the 600-line limit on main and is 45 lines longer
on feat/finish-pr-body, so the extraction is what keeps it passing
check:file-sizes after that branch merges."
```

---

### Task 5: Full suite and PR

**Files:** none — verification only.

- [ ] **Step 1: Run the whole suite**

Run: `bun run test`
Expected: PASS. If anything unrelated to `flows/nax-finish/` fails, check whether it also fails on `origin/main` before treating it as a regression from this work.

- [ ] **Step 2: Confirm no `src/` import leaked into `flows/`**

Run: `grep -rn "from \"@/\|from \"\.\./\.\./src" flows/nax-finish/`
Expected: no output.

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin feat/nax-finish-verdict-recovery
gh pr create --base main --title "fix(nax-finish): survive an unparseable reviewer reply" --body "$(cat <<'EOF'
## Problem

A reviewer returning prose instead of JSON threw inside `parseVerdict`, failing the
acp node and killing the whole flow — exit 1, no result file, no notification.

Observed on `rs-stock/pipeline-run-chat-context` (flow run
`2026-08-05T154112386Z-nax-finish-600cf3f3`): the run itself was clean, 4/4 stories,
but the flow died at `review_quality` after 128s and ~4.2M tokens, losing the quality
review, the quality gates and the PR.

`parseVerdict` was the `parse` for all six acp nodes, and four of them
(`fix_acceptance`, `fix_spec`, `fix_quality`, `fix_gate`) never read the parsed value —
so four nodes could kill a multi-hour run over output nothing consumes.

## Change

- `flows/nax-finish/verdict.ts` (new) owns verdict parsing and review routing
- `parseReviewVerdict` routes an unreadable reply to `reprompt` instead of throwing;
  `routeReview` retries the review once, then escalates
- `parseFixVerdict` never throws, for the four nodes whose verdict is unread
- `routeReview` and `MAX_FIX_ATTEMPTS` move out of the flow file, which was within a
  few lines of the 600-line limit
- Escalation now reaches the existing `escalate` sink, which writes the result file
  before delivery — so the plugin always gets a result and Telegram always fires

## Notes

The `reprompt` branch is checked before the findings-empty branch. A reprompt verdict
carries zero findings, so the reverse order would route an unread review to `clean` and
open a PR having verified nothing — a silent false green, worse than the crash.

The regression fixture is the real 927-byte reply from the run above, not a synthetic
string: the point is that a chatty reviewer emits no brace at all, defeating every
`extractJsonObject` tier.

## Test plan

- [x] `bun test test/unit/flows/nax-finish/`
- [x] `bun run lint` (includes `check:file-sizes`, `check:flows-no-bun`)
- [x] `bun run typecheck`
- [x] `bun run test`
EOF
)"
```

---

## Merge note

`feat/finish-pr-body` is in flight against the same flow. It adds 45 lines to
`nax-finish.flow.ts`, and it moved `flows/nax-finish/pr-body.ts` to
`flows/nax-finish/steps/pr-body.ts`. Neither collides with the regions this plan edits
(`routeReview`, `parseVerdict`, the node `parse:` fields, the review switch edges), and
its `types.ts` change is to `FinishRound` while this one is to `ReviewVerdict`. Expect a
small textual conflict in the flow file's import block at worst.

## Out of scope

- Node-level retry or `onError` edges in acpx
- Reviewer model or profile changes
- The two rs-stock findings the crash discarded
- The `nax-finish` post-run `shouldRun` gate, which correctly declines on `main`
