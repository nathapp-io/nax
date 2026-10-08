# Review Fixes Bundle I — Cost and Telemetry Attribution

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Read the master plan's **Global Constraints** first: `2026-10-08-review-fixes-master-plan.md`.

**Goal:** Reported cost, cost-row model and curator observations match what actually ran.

**Architecture:** Four independent tasks. Task 1 points the curator's rectify collector at the log line the rectification loop really emits. Task 2 makes `TurnResult.output` carry the `after_response` patch the transcript already carries. Task 3 threads a literal model pin into the final-dispatch attribution. Task 4 counts the reprompt turn's cost on every reground outcome. Tasks 1, 3, 4 are in `packages/nax`; Task 2 is in `packages/nax-agent`.

**Tech Stack:** TypeScript, bun:test.

**Spec:** `docs/superpowers/reviews/2026-10-08-whole-repo-code-review.md` findings #9, #13, #23, #25.

**Branch:** `git fetch origin && git checkout -b fix/review-i-cost-telemetry origin/main`

## Global Constraints

See the master plan. **Line budgets in this bundle are tight:**

| File | Lines now | Cap | This bundle |
|---|---|---|---|
| `packages/nax/src/plugins/builtin/curator/collect.ts` | 600 | 600 | must stay line-neutral (Task 1) |
| `packages/nax/src/agents/manager.ts` | 600 | 600 | must stay line-neutral (Task 3) |
| `packages/nax/src/agents/manager-dispatch.ts` | 596 | 600 | +1 (Task 3) |
| `packages/nax/src/operations/adversarial-review.ts` | 599 | 600 | −3 (Task 4) |
| `packages/nax/src/operations/semantic-review.ts` | 579 | 600 | −3 (Task 4) |
| `packages/nax/test/unit/agents/fallback-tier-targets.test.ts` | 794 | 800 | shrinks (Task 3 moves a describe out) |
| `packages/nax/test/unit/operations/adversarial-review-reground.test.ts` | 800 | 800 | untouched (Task 4 uses a new file) |

Run `wc -l` on each after its task. Write the code exactly as shown: the line counts above assume biome's 120-column formatting of these exact lines.

## Files

- Modify: `packages/nax/src/plugins/builtin/curator/collect.ts:449-463, 571` (Task 1)
- Test: `packages/nax/test/unit/plugins/builtin/curator-collector-rectify.test.ts` (new concern split)
- Modify: `packages/nax-agent/src/native/session/turn-loop-round-trip.ts:213, 258` (Task 2)
- Test: `packages/nax-agent/test/unit/native/session/loop-events/after-response.test.ts` (new, beside its sibling event tests)
- Modify: `packages/nax/src/agents/manager-dispatch.ts:436-463` (Task 3)
- Modify: `packages/nax/src/agents/manager.ts:531` (Task 3)
- Test: move `describe("resolveFinalDispatch")` from `packages/nax/test/unit/agents/fallback-tier-targets.test.ts:472-513` into `packages/nax/test/unit/agents/manager-dispatch-final.test.ts` (new concern split)
- Modify: `packages/nax/src/operations/adversarial-review.ts:190-239` (Task 4)
- Modify: `packages/nax/src/operations/semantic-review.ts:274-321` (Task 4)
- Test: `packages/nax/test/unit/operations/adversarial-review-reground-cost.test.ts` (new concern split)
- Test: `packages/nax/test/unit/operations/semantic-review-reground.test.ts` (598 lines)

---

### Task 1: The curator's H3 collector reads the real rectification line (#9)

`collectFromRunJsonl` waits for `stage "rectify"` + `"Starting rectification loop"`, which nothing emits; the rectification loop logs ONE summary line per cycle at stage `"story-orchestrator"` (`execution/story-orchestrator/rectification.ts:527-540`): `"Rectification resolved all findings"` or `"Rectification exited: <reason>"`, with data `{ storyId, initialFindingsCount, iterationCount, finalFindingsCount, exitReason, costUsd }`. It is the only `story-orchestrator` line that carries `iterationCount`.

**Files:**
- Modify: `packages/nax/src/plugins/builtin/curator/collect.ts`
- Test: `packages/nax/test/unit/plugins/builtin/curator-collector-rectify.test.ts`

- [ ] **Step 1: Write the failing test**

Create `curator-collector-rectify.test.ts`, copying the `runWithLogEntry` context builder from `curator-collector.test.ts:663-687` (the "escalation log entries (US-001)" describe) and its imports:

```ts
/**
 * The rectify-cycle observation (curator H3) is built from the rectification
 * loop's real per-cycle summary line.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeNaxConfig } from "@test/helpers";
import type { CuratorPostRunContext } from "@/plugins/builtin/curator";
import { collectObservations } from "@/plugins/builtin/curator";

async function runWithLogEntries(entries: Record<string, unknown>[]) {
  const root = await mkdtemp(join(tmpdir(), "curator-rectify-"));
  const logFilePath = join(root, "run.jsonl");
  await writeFile(logFilePath, `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`);
  const context: CuratorPostRunContext = {
    runId: "run-rectify",
    feature: "feat-rectify",
    workdir: root,
    prdPath: join(root, ".nax", "features", "feat-rectify", "prd.json"),
    branch: "main",
    totalDurationMs: 1000,
    totalCost: 0,
    storySummary: { completed: 0, failed: 0, skipped: 0, paused: 0 },
    stories: [],
    version: "0.1.0",
    pluginConfig: {},
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    config: makeNaxConfig(),
    outputDir: join(root, "out"),
    globalDir: join(root, "global"),
    projectKey: "test-project-rectify",
    curatorRollupPath: join(root, "rollup.jsonl"),
    logFilePath,
  };
  return collectObservations(context);
}

const summary = (message: string, data: Record<string, unknown>) => ({
  timestamp: "2026-10-08T00:00:00.000Z",
  level: "warn",
  stage: "story-orchestrator",
  message,
  storyId: "US-001",
  data: { storyId: "US-001", initialFindingsCount: 2, finalFindingsCount: 1, costUsd: 0.4, ...data },
});

describe("collectObservations — rectify-cycle observations", () => {
  test("each rectification cycle summary yields one rectify-cycle observation", async () => {
    const observations = await runWithLogEntries([
      summary("Rectification exited: max-attempts-per-strategy", { iterationCount: 3, exitReason: "max-attempts-per-strategy" }),
      summary("Rectification resolved all findings", { iterationCount: 1, exitReason: "resolved" }),
    ]);
    const cycles = observations.filter((o) => o.kind === "rectify-cycle");
    expect(cycles.map((o) => o.payload)).toEqual([
      { iteration: 3, status: "failed" },
      { iteration: 1, status: "passed" },
    ]);
    expect(cycles.every((o) => o.storyId === "US-001" && o.stage === "rectify")).toBe(true);
  });

  test("other story-orchestrator lines are not rectify cycles", async () => {
    const observations = await runWithLogEntries([
      {
        timestamp: "2026-10-08T00:00:00.000Z",
        level: "info",
        stage: "story-orchestrator",
        message: "Rectification strategy completed: autofix",
        data: { storyId: "US-001", phase: "autofix" },
      },
    ]);
    expect(observations.filter((o) => o.kind === "rectify-cycle")).toEqual([]);
  });
});
```

(Both imports come from the curator barrel, exactly as in `curator-collector.test.ts:10-11`. If `RectifyCycleObservation.payload` is typed so `o.payload` does not narrow on `o.kind`, filter with a type guard: `(o): o is RectifyCycleObservation => o.kind === "rectify-cycle"`.)

- [ ] **Step 2: Run it to verify it fails**

Run (from `packages/nax`): `timeout 30 bun test test/unit/plugins/builtin/curator-collector-rectify.test.ts --timeout=5000`
Expected: the first test FAILS (no `rectify-cycle` observations); the second passes.

- [ ] **Step 3: Implement (line-neutral)**

In `collect.ts`, replace exactly one line in `collectFromRunJsonl` (571):

```ts
      } else if (stage === "rectify" && message === "Starting rectification loop") {
```

with:

```ts
      } else if (stage === "story-orchestrator" && typeof data.iterationCount === "number") {
```

and, in `collectRectify`, replace exactly the two payload lines:

```ts
      iteration: numberValue(data.attempt ?? data.rectifyAttempt ?? data.iteration, 1),
      status: stringValue(data.status, "started") as "started" | "failed" | "passed",
```

with:

```ts
      iteration: numberValue(data.iterationCount, 1),
      status: data.exitReason === "resolved" ? "passed" : "failed",
```

Do not add comments here (the file is at its 600-line cap); the test file's header documents the contract.

- [ ] **Step 4: Run tests to verify they pass**

Run: `timeout 60 bun test test/unit/plugins/builtin/ --timeout=5000`
Expected: PASS. If an existing test fed the old `"Starting rectification loop"` line and expected an observation, it pinned the dead matcher: rewrite its entry to the summary shape above. `wc -l src/plugins/builtin/curator/collect.ts` — expect exactly 600.

- [ ] **Step 5: Commit**

```bash
git add packages/nax/src/plugins/builtin/curator/collect.ts packages/nax/test/unit/plugins/builtin/curator-collector-rectify.test.ts
git commit -m "fix(curator): build rectify-cycle observations from the real rectification summary line (review #9)"
```

---

### Task 2: `TurnResult.output` carries the `after_response` patch (#13)

`state.output = res.text` is assigned before `after_response` fires and never updated, while the pushed assistant message uses `afterResponse.text ?? res.text`. The seam's contract (`session/turn-event.ts:6-7`) names both the transcript and `TurnResult.output` as authoritative, so they must agree.

**Files:**
- Modify: `packages/nax-agent/src/native/session/turn-loop-round-trip.ts`
- Test: `packages/nax-agent/test/unit/native/session/loop-events/after-response.test.ts`

- [ ] **Step 1: Write the failing test**

Create `after-response.test.ts` from the harness of its sibling `before-request.test.ts` (same directory; lines 1-35 are the setup):

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLoopEventRegistry } from "#src/native/session/loop-events/index";
import { createNativeSessionState, type NativeSessionState } from "#src/native/session/session";
import { runNativeTurn } from "#src/native/session/turn-loop";
import type { SendTurnOpts } from "#src/session/session-types";
import { seedNativeSession } from "#test/helpers/index";

let dir: string;
let sessionState: NativeSessionState;
const handle = { id: "sess-after-response", agentName: "native" } as const;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nax-after-response-"));
  sessionState = seedNativeSession(createNativeSessionState(), "sess-after-response", { transcriptDir: dir });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const usage = { inputTokens: 1, outputTokens: 1 };
const opts = (over: Partial<SendTurnOpts> = {}): SendTurnOpts => ({
  interactionHandler: { onInteraction: async () => ({ answer: "tool said hi" }) },
  ...over,
});

describe("native turn loop — after_response event", () => {
  test("a text patch reaches TurnResult.output, not only the transcript", async () => {
    const registry = createLoopEventRegistry();
    registry.register("after_response", () => ({ text: "patched answer" }));

    const result = await runNativeTurn(handle, "hi", opts(), {
      sessionState,
      loopEvents: registry,
      complete: async () => ({ text: "raw model answer", usage, costUsd: 0 }),
    });

    expect(result.output).toBe("patched answer");
  });

  test("without a patch the output is the model's text", async () => {
    const result = await runNativeTurn(handle, "hi", opts(), {
      sessionState,
      loopEvents: createLoopEventRegistry(),
      complete: async () => ({ text: "raw model answer", usage, costUsd: 0 }),
    });

    expect(result.output).toBe("raw model answer");
  });
});
```

(If `registry.register("after_response", ...)` requires a differently-shaped return, read `loop-events/types.ts` for the `after_response` patch type: the field is `text`, per `turn-loop-round-trip.ts:258`.)

- [ ] **Step 2: Run it to verify it fails**

Run (from `packages/nax-agent`): `timeout 30 bun test test/unit/native/session/loop-events/after-response.test.ts --timeout=5000`
Expected: the first test FAILS — received `"raw model answer"`.

- [ ] **Step 3: Implement**

In `turn-loop-round-trip.ts`:

1. Delete the line `  state.output = res.text;` (~213).
2. Directly after `const assistantText = afterResponse.text ?? res.text;` (~258), add:

```ts
  // The recorded answer IS the patched one: transcript and TurnResult.output must agree (turn-event.ts).
  state.output = assistantText;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `timeout 60 bun test test/unit/native/ --timeout=5000`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/nax-agent/src/native/session/turn-loop-round-trip.ts packages/nax-agent/test/unit/native/session/loop-events/after-response.test.ts
git commit -m "fix(native): TurnResult.output carries the after_response patch (review #13)"
```

---

### Task 3: The final-dispatch cost row names a literally pinned model (#23)

`resolveHopCompleteOptions` honours a literal `{ agent, model }` pin (5th parameter), but `resolveFinalDispatch` never receives it, so after a swap onto a literal-pin rung the cost row re-derives the model through the tier map. `buildCompleteOutcome` already carries the pin as `outcome.finalTarget.model`; pass the outcome instead of its pieces.

**Files:**
- Modify: `packages/nax/src/agents/manager-dispatch.ts`
- Modify: `packages/nax/src/agents/manager.ts:531`
- Create: `packages/nax/test/unit/agents/manager-dispatch-final.test.ts`
- Modify: `packages/nax/test/unit/agents/fallback-tier-targets.test.ts` (remove the moved describe and, if now unused, `resolveFinalDispatch` from its import)

**Interfaces:**
- `resolveFinalDispatch(options: ResolvedCompleteOptions, primaryAgent: string, outcome: Pick<AgentCompleteOutcome, "fallbacks" | "finalTier" | "finalTarget">): { agentName: string; options: ResolvedCompleteOptions }`

- [ ] **Step 1: Move the existing tests and add the failing one**

Create `packages/nax/test/unit/agents/manager-dispatch-final.test.ts` with the `describe("resolveFinalDispatch", ...)` block moved from `fallback-tier-targets.test.ts:472-513`, rewritten for the new signature, plus the new pin test:

```ts
import { describe, expect, test } from "bun:test";
import { resolveFinalDispatch } from "@/agents/manager-dispatch";
import type { AgentFallbackRecord } from "@/agents/manager-types";
import type { ResolvedCompleteOptions } from "@/agents/types";

describe("resolveFinalDispatch", () => {
  const base: ResolvedCompleteOptions = {
    modelDef: { provider: "anthropic", model: "primary-model" },
    modelDefFor: (agent: string, tier?: string) => ({ provider: "p", model: `${agent}:${tier ?? "default"}` }),
    modelTier: "balanced",
    workdir: "/tmp",
    resolvedPermissions: { mode: "approve-all", bashApproval: "raw" },
  };
  const swapped: AgentFallbackRecord[] = [
    {
      priorAgent: "claude",
      newAgent: "native",
      hop: 1,
      outcome: "fail-quota",
      category: "availability",
      timestamp: "2026-09-02T00:00:00.000Z",
      costUsd: 0,
    },
  ];

  test("the cost row records the model the swapped hop actually ran", () => {
    // Without threading finalTier this is "native:default" — a model that never ran, billed against the run.
    const out = resolveFinalDispatch(base, "claude", { fallbacks: swapped, finalTier: "cheap" });
    expect(out.options.modelDef.model).toBe("native:cheap");
  });

  test("a tier-carrying swap also records that tier, so model and modelTier agree", () => {
    const out = resolveFinalDispatch(base, "claude", { fallbacks: swapped, finalTier: "cheap" }).options;
    expect(out.modelDef.model).toBe("native:cheap");
    expect(out.modelTier).toBe("cheap");
  });

  test("no tier means today's behaviour", () => {
    expect(resolveFinalDispatch(base, "claude", { fallbacks: swapped }).options.modelDef.model).toBe("native:default");
  });

  test("no tier leaves modelTier as the base had it", () => {
    expect(resolveFinalDispatch(base, "claude", { fallbacks: swapped }).options.modelTier).toBe("balanced");
  });

  test("a literal model pin on the final target is the model the cost row records", () => {
    const out = resolveFinalDispatch(base, "claude", {
      fallbacks: swapped,
      finalTarget: { agent: "native", model: "pinned-literal-model" },
    });
    expect(out.agentName).toBe("native");
    expect(out.options.modelDef.model).toBe("pinned-literal-model");
  });
});
```

Delete the old `describe("resolveFinalDispatch", ...)` block from `fallback-tier-targets.test.ts`, and drop `resolveFinalDispatch` from its `@/agents/manager-dispatch` import if nothing else there uses it.

- [ ] **Step 2: Run it to verify it fails**

Run (from `packages/nax`): `timeout 30 bun test test/unit/agents/manager-dispatch-final.test.ts --timeout=5000`
Expected: FAIL — typecheck-level mismatch at runtime: the third argument is an object, so `fallbacks.at` is undefined (TypeError) — every test in the file fails until the signature changes.

- [ ] **Step 3: Implement**

In `manager-dispatch.ts`, replace `resolveFinalDispatch`:

```ts
export function resolveFinalDispatch(
  options: ResolvedCompleteOptions,
  primaryAgent: string,
  outcome: Pick<AgentCompleteOutcome, "fallbacks" | "finalTier" | "finalTarget">,
): { agentName: string; options: ResolvedCompleteOptions } {
  const { fallbacks, finalTier, finalTarget } = outcome;
  const agentName = fallbacks.at(-1)?.newAgent ?? primaryAgent;
  const hopOptions = resolveHopCompleteOptions(options, agentName, primaryAgent, finalTier, finalTarget?.model);
  return { agentName, options: finalTier !== undefined ? { ...hopOptions, modelTier: finalTier } : hopOptions };
}
```

Append ONE sentence to its doc comment: ` * A literal \`{ agent, model }\` pin on \`finalTarget\` is passed through too, or the row names a model that never ran (#23).`

`AgentCompleteOutcome` is already imported in this file (it is `buildCompleteOutcome`'s return type); if not, add it to the existing `./manager-types` type import.

In `manager.ts:531`, change:

```ts
        ...resolveFinalDispatch(augmented, agentName, outcome.fallbacks, outcome.finalTier),
```

to:

```ts
        ...resolveFinalDispatch(augmented, agentName, outcome),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `timeout 60 bun test test/unit/agents/ --timeout=5000`
Expected: PASS. `wc -l src/agents/manager.ts src/agents/manager-dispatch.ts` — expect 600 and ≤ 600.

- [ ] **Step 5: Commit**

```bash
git add packages/nax/src/agents/manager-dispatch.ts packages/nax/src/agents/manager.ts packages/nax/test/unit/agents/manager-dispatch-final.test.ts packages/nax/test/unit/agents/fallback-tier-targets.test.ts
git commit -m "fix(agents): attribute a literal model pin on the final dispatch's cost row (review #23)"
```

---

### Task 4: Every reground outcome reports the reprompt's cost (#25)

In both `performAdversarialReground` and `performSemanticReground`, the `parse-failed` and `still-dropped` branches return `{ ...turn, output: withRepromptMarker(...) }` without `estimatedCostUsd: costUsd`, so the op's reported cost omits the second turn while the ledger rows include it. A small local helper returns the preserved first turn WITH the combined cost; it also makes both files 3 lines shorter.

**Files:**
- Modify: `packages/nax/src/operations/adversarial-review.ts`
- Modify: `packages/nax/src/operations/semantic-review.ts`
- Test: `packages/nax/test/unit/operations/adversarial-review-reground-cost.test.ts` (new)
- Test: `packages/nax/test/unit/operations/semantic-review-reground.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `adversarial-review-reground-cost.test.ts`:

```ts
/**
 * The reprompt turn of an adversarial AC-reground is billed into the returned
 * TurnResult on EVERY outcome, including the two that keep the first turn's output.
 */
import { describe, expect, mock, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertDefined, makeTurnResult, withTempDir } from "@test/helpers";
import { type AdversarialReviewInput, adversarialReviewOp } from "@/operations/adversarial-review";
import type { HopBodyContext } from "@/operations/types";

assertDefined(adversarialReviewOp.hopBody, "adversarialReviewOp.hopBody");
const runHopBody = adversarialReviewOp.hopBody.bind(adversarialReviewOp);

const CONFIG = {
  model: "balanced" as const,
  diffMode: "ref" as const,
  rules: [] as string[],
  timeoutMs: 600_000,
  parallel: false,
  maxConcurrentSessions: 2,
  acRegroundOnDrop: true,
  substantiation: { requote: false, maxRequotes: 0 },
};

const STORY = {
  id: "STORY-COST",
  title: "reground cost",
  description: "reground cost",
  acceptanceCriteria: ["auth login must not allow SQL injection attacks"],
};

// No acQuote/acIndex: filterByAcQuote drops it, which triggers the reground.
const DROPPED = {
  severity: "error",
  category: "security",
  file: "src/auth.ts",
  line: 1,
  issue: "SQL injection via rawQuery",
  suggestion: "Use parameterized queries",
};

async function regroundCost(secondOutput: string): Promise<number | undefined> {
  return withTempDir(async (workdir) => {
    mkdirSync(join(workdir, "src"), { recursive: true });
    writeFileSync(join(workdir, "src", "auth.ts"), "function login(u, p) { return db.rawQuery(u + p); }\n");
    const first = JSON.stringify({ passed: false, findings: [DROPPED] });
    const result = await runHopBody("initial prompt", {
      sendWithParseRetry: mock(async () => makeTurnResult({ output: first, estimatedCostUsd: 0.1 })),
      send: mock(async () => makeTurnResult({ output: secondOutput, estimatedCostUsd: 0.2 })),
      input: { workdir, story: STORY, adversarialConfig: { ...CONFIG }, mode: "ref" },
    } satisfies HopBodyContext<AdversarialReviewInput>);
    return result.estimatedCostUsd;
  });
}

describe("adversarialReviewOp.hopBody — reground cost on first-turn-preserving outcomes", () => {
  test("parse-failed: both turns are billed", async () => {
    expect(await regroundCost("not json at all")).toBeCloseTo(0.3, 10);
  });

  test("still-dropped: both turns are billed", async () => {
    expect(await regroundCost(JSON.stringify({ passed: false, findings: [DROPPED] }))).toBeCloseTo(0.3, 10);
  });
});
```

(If `withTempDir` does not return the callback's value, assign the cost to an outer `let` inside the callback and return it after.)

In `semantic-review-reground.test.ts`, append the same two cases as a new describe, adapted to the semantic op (reuse that file's `STORY_WITH_AC`, `SEMANTIC_CONFIG_DEFAULT`, `makeDroppedFinding`, `runHopBody`):

```ts
describe("semanticReviewOp.hopBody — reground cost on first-turn-preserving outcomes", () => {
  async function regroundCost(secondOutput: string): Promise<number | undefined> {
    let cost: number | undefined;
    await withTempDir(async (workdir) => {
      mkdirSync(join(workdir, "src"), { recursive: true });
      writeFileSync(join(workdir, "src", "auth.ts"), "function login(u, p) { return db.rawQuery(u + p); }\n");
      const first = JSON.stringify({ passed: false, findings: [makeDroppedFinding("error")] });
      const result = await runHopBody("initial", {
        sendWithParseRetry: mock(async () => makeTurnResult({ output: first, estimatedCostUsd: 0.1 })),
        send: mock(async () => makeTurnResult({ output: secondOutput, estimatedCostUsd: 0.2 })),
        input: { workdir, story: STORY_WITH_AC, semanticConfig: { ...SEMANTIC_CONFIG_DEFAULT }, mode: "ref" },
      } satisfies HopBodyContext<SemanticReviewInput>);
      cost = result.estimatedCostUsd;
    });
    return cost;
  }

  test("parse-failed: both turns are billed", async () => {
    expect(await regroundCost("not json at all")).toBeCloseTo(0.3, 10);
  });

  test("still-dropped: both turns are billed", async () => {
    expect(
      await regroundCost(JSON.stringify({ passed: false, findings: [makeDroppedFinding("error")] })),
    ).toBeCloseTo(0.3, 10);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `timeout 60 bun test test/unit/operations/adversarial-review-reground-cost.test.ts test/unit/operations/semantic-review-reground.test.ts --timeout=5000`
Expected: the four new tests FAIL — received `0.1`.

- [ ] **Step 3: Implement**

In `adversarial-review.ts`, inside `performAdversarialReground`, right after the two lines

```ts
  const costUsd = (turn.estimatedCostUsd ?? 0) + (secondTurn.estimatedCostUsd ?? 0);
  const dropCount = drops.length;
```

add:

```ts
  // Outcomes that keep the first turn's output still paid for the second turn (#25).
  const keepFirstTurn = (outcome: "parse-failed" | "still-dropped"): TurnResult => ({
    ...turn,
    output: withRepromptMarker(turn.output, { dropCount, outcome, costUsd }),
    estimatedCostUsd: costUsd,
  });
```

Replace the parse-failed branch:

```ts
  if (!secondParsed) {
    return {
      ...turn,
      output: withRepromptMarker(turn.output, { dropCount, outcome: "parse-failed", costUsd }),
    };
  }
```

with:

```ts
  if (!secondParsed) return keepFirstTurn("parse-failed");
```

and the final still-dropped return:

```ts
  return {
    ...turn,
    output: withRepromptMarker(turn.output, { dropCount, outcome: "still-dropped", costUsd }),
  };
```

with:

```ts
  return keepFirstTurn("still-dropped");
```

Make the identical three edits in `semantic-review.ts`'s `performSemanticReground` (its `withRepromptMarker` is the file-local one at line 77; the call shape is the same).

If TypeScript narrows `secondParsed` incorrectly after the one-line `if`, keep the braces: `if (!secondParsed) { return keepFirstTurn("parse-failed"); }` costs two lines and still nets −1 per file.

- [ ] **Step 4: Run tests to verify they pass**

Run: `timeout 60 bun test test/unit/operations/ --timeout=5000`
Expected: PASS, including the existing AC5 "first-turn preserved" tests (they assert `output`, which is unchanged). `wc -l src/operations/adversarial-review.ts src/operations/semantic-review.ts` — expect ≤ 597 and ≤ 577.

- [ ] **Step 5: Commit**

```bash
git add packages/nax/src/operations/adversarial-review.ts packages/nax/src/operations/semantic-review.ts packages/nax/test/unit/operations/adversarial-review-reground-cost.test.ts packages/nax/test/unit/operations/semantic-review-reground.test.ts
git commit -m "fix(review): bill the reprompt turn on parse-failed and still-dropped reground outcomes (review #25)"
```

---

## Bundle wrap-up

Run the master plan's **Per-bundle PR checklist** with scope `curator,native,agents,review`, running the gates for both nax and nax-agent.
