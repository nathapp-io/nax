# Spin Breaker, Verifier Timeout and Scoped Verdict Write — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop a native agent session from spinning on a repeated tool call for 37 minutes unchecked, and give the TDD verifier a proportionate timeout plus the write tool its own prompt requires.

**Architecture:** Four independent changes. (1) The native emitter marks its per-round-trip usage events so the existing 30-minute tool-call-only idle timeout can finally expire; ACP is untouched. (2) `verifierOp` gains its own `timeoutMs` like the review ops. (3) Operations gain a typed `toolPatterns` narrowing seam, letting the verifier hold `Write` scoped to its verdict file. (4) A new transport-neutral spin breaker counts tool calls since the last not-recently-seen call, nudges the model in-band, then ends the turn with a new `fail-spin` outcome that reuses the existing timeout retry lane.

**Tech Stack:** Bun 1.4.0 (Bun-native APIs only), TypeScript strict, `bun:test`, Biome, Zod for config schemas.

**Spec:** `docs/superpowers/specs/2026-09-12-spin-breaker-design.md` — read it before Task 1. Its rulings R1–R8 are the argument for every choice below; two refinements made during planning are marked **PLAN REFINEMENT** where they supersede the design text.

## Global Constraints

- **Bun-native APIs only** — no Node.js equivalents. `Bun.file`, `Bun.hash`, `Bun.Glob`.
- **TypeScript strict** — no `any` without explicit written justification. No `as` casts to paper over a shape.
- **File size** — 400 lines typical, 800 hard max. `src/operations/call.ts` is already at its 600-line limit; do not grow it beyond the single field addition in Task 3.
- **Functions** — ≤30 lines, ≤3 positional parameters, options objects beyond that.
- **No magic numbers** — `UPPER_SNAKE_CASE` constants with `_` separators.
- **Dependency injection** — external calls (spawn, fs, fetch, clocks) go through an injectable `_deps` object. Timers in tests use the injected clock, never a real sleep.
- **Errors** — `NaxError` with a `[stage]`-prefixed message, a code, and `{ cause: err }` when wrapping.
- **Logging** — structured JSONL via `getSafeLogger()`, stage prefix as the first argument, `storyId` in the data object wherever one is in scope.
- **Adapter boundary** — `src/agents/native/` and `src/agents/acp/` must not import `NaxConfig`, `CompleteConfig`, `DEFAULT_CONFIG`, or the config loader, and must not read `options.config`. Enforced by `scripts/check-adapter-no-config-import.sh`. Config-derived settings reach them as resolved primitives only.
- **nax-ai imports** — confined to `src/agents/native/` and `src/agents/catalog/`. Enforced by `bun run check:nax-ai-imports`.
- **Permissions SSOT** — all permission decisions go through `resolvePermissions(config, stage)`. Task 3 adds narrowing only; it must never grant.
- **Commits** — conventional commits (`feat:`, `fix:`, `test:`, `docs:`), one logical concern per commit. Attribution lines are disabled globally.
- **Quality gates** — `bun run lint`, `bun run typecheck`, `bun run test` must pass before each commit. `bun run test:coverage` is a separate CI step with a per-file floor; run it by hand after any task that adds or moves tests.

---

### Task 1: Native round-trip usage flag (US-003)

Makes the existing `toolCallOnlyIdleTimeoutSeconds` able to fire on the native transport. Today every native round trip emits a `usage_update`, which resets `lastNonToolCallActivityAt`, so the one timer designed to catch a tool-call-only stall can never expire.

**Files:**
- Modify: `src/runtime/agent-stream-events.ts:38-41` (add `perRoundTrip` to `AgentUsageUpdateEvent`)
- Modify: `src/agents/native/session/turn-events.ts:44-52` (set it on the native usage event)
- Modify: `src/runtime/middleware/idle-watchdog/index.ts:322-331` (the `agent.usage_update` case)
- Modify: `test/unit/runtime/middleware/_idle-watchdog-harness.ts` (`makeUsageUpdateEvent` gains the flag)
- Test: `test/unit/runtime/middleware/idle-watchdog-tool-call.test.ts` (two new cases)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `AgentUsageUpdateEvent.perRoundTrip?: true`. No other task depends on it.

- [ ] **Step 1: Write the two failing tests**

Append to `test/unit/runtime/middleware/idle-watchdog-tool-call.test.ts`, inside the existing `describe("attachAgentIdleWatchdog — tool-call activity")` block. Both reuse that file's existing `makeWatchdogConfig`, `makeCountingRegistry` and `parseAllEntries` helpers, and the virtual clock installed by its `beforeEach`.

```ts
  test("a per-round-trip usage update does not reset the tool-call-only timer", async () => {
    const eventBus = new AgentStreamEventBus();
    const { registry, count } = makeCountingRegistry();
    const detach = attachAgentIdleWatchdog(eventBus, registry, makeWatchdogConfig());

    try {
      eventBus.emitAgentStream(makeCallStartedEvent());
      // A native spin: one tool call and one usage update per round trip, for
      // longer than toolCallOnlyIdleTimeoutSeconds (0.12s in makeWatchdogConfig).
      for (let elapsed = 0; elapsed < 220; elapsed += 25) {
        eventBus.emitAgentStream(makeToolCallUpdateEvent());
        eventBus.emitAgentStream(makeUsageUpdateEvent({ perRoundTrip: true }));
        await clock.advance(25);
      }

      expect(count()).toBe(1);
      await getLogger().flush();
      const entries = await parseAllEntries(logFile);
      expect(entries.some((entry) => entry.data?.key === "tool_call_only_idle_timeout_exceeded")).toBe(true);
    } finally {
      detach();
    }
  });

  test("a usage update without the flag still resets it — ACP parity is unchanged", async () => {
    const eventBus = new AgentStreamEventBus();
    const { registry, count } = makeCountingRegistry();
    const detach = attachAgentIdleWatchdog(eventBus, registry, makeWatchdogConfig());

    try {
      eventBus.emitAgentStream(makeCallStartedEvent());
      for (let elapsed = 0; elapsed < 220; elapsed += 25) {
        eventBus.emitAgentStream(makeToolCallUpdateEvent());
        eventBus.emitAgentStream(makeUsageUpdateEvent());
        await clock.advance(25);
      }

      expect(count()).toBe(0);
      await getLogger().flush();
      const entries = await parseAllEntries(logFile);
      expect(entries.some((entry) => entry.data?.key === "tool_call_only_idle_timeout_exceeded")).toBe(false);
    } finally {
      detach();
    }
  });
```

Add `makeUsageUpdateEvent` to that file's import from `./_idle-watchdog-harness`.

- [ ] **Step 2: Teach the harness to set the flag**

In `test/unit/runtime/middleware/_idle-watchdog-harness.ts`, replace `makeUsageUpdateEvent`:

```ts
export function makeUsageUpdateEvent(overrides: { callId?: string; perRoundTrip?: true } = {}): AgentStreamEvent {
  return {
    kind: "agent.usage_update",
    ...baseEvent(overrides.callId ?? "call-123"),
    inputTokens: 100,
    outputTokens: 200,
    costUsd: 0.01,
    ...(overrides.perRoundTrip !== undefined ? { perRoundTrip: overrides.perRoundTrip } : {}),
  } as AgentStreamEvent;
}
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bun test test/unit/runtime/middleware/idle-watchdog-tool-call.test.ts --timeout=30000`
Expected: the first new test FAILS with `expect(count()).toBe(1)` receiving `0` (the flag is not yet honoured, so the usage update still resets the timer and nothing is cancelled). The second new test PASSES already — it pins today's behaviour, which Task 1 must not change.

- [ ] **Step 4: Add the field to the event**

In `src/runtime/agent-stream-events.ts`, extend `AgentUsageUpdateEvent`:

```ts
export interface AgentUsageUpdateEvent extends AgentStreamEventBase {
  readonly kind: "agent.usage_update";
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly costUsd?: number;
  /**
   * Set when this usage report IS one round trip, which is the native
   * transport's cadence: `turn-loop.ts` emits exactly one per `complete()`.
   *
   * The idle watchdog reads it to classify the event as tool-call-tier
   * activity rather than semantic progress. Without it, a spinning native
   * session reset `lastNonToolCallActivityAt` on every iteration and
   * `toolCallOnlyIdleTimeoutSeconds` — the timer built for exactly that shape
   * — could never expire (nax#2013).
   *
   * Absent on ACP, whose loop is separately bounded by `maxInteractions` and
   * whose usage cadence is the agent's, not nax's.
   */
  readonly perRoundTrip?: true;
}
```

- [ ] **Step 5: Set it in the native emitter**

In `src/agents/native/session/turn-events.ts`, in the `case "usage":` arm, add `perRoundTrip: true`:

```ts
    case "usage":
      return {
        ...common,
        kind: "agent.usage_update",
        inputTokens: activity.inputTokens,
        outputTokens: activity.outputTokens,
        costUsd: activity.costUsd,
        // Native emits exactly one usage report per round trip, so this event
        // is a round-trip marker, not semantic progress — see the field's doc
        // comment on AgentUsageUpdateEvent (nax#2013).
        perRoundTrip: true,
      };
```

Also correct the file header's closing claim, which is now false — it asserts the watchdog "trips `toolCallOnlyIdleTimeout`" on a tool-calling loop, which was the defect:

```ts
 * Native has no token streaming — one `complete()` is a single call — so these
 * are emitted at round-trip boundaries rather than continuously. That is
 * sufficient: a HUNG call is already bounded by the per-call abort, and the
 * watchdog's unique job is the productive-looking loop that keeps calling tools
 * forever. That loop emits `tool` AND `usage` on every iteration, so the usage
 * event carries `perRoundTrip` to mark it as a round-trip boundary rather than
 * semantic progress — otherwise it reset `lastNonToolCallActivityAt` every
 * iteration and `toolCallOnlyIdleTimeout` could never fire (nax#2013).
```

- [ ] **Step 6: Honour the flag in the watchdog**

In `src/runtime/middleware/idle-watchdog/index.ts`, replace the `case "agent.usage_update":` arm:

```ts
      case "agent.usage_update": {
        const state = activeStates.get(event.callId);
        if (state && activityKinds.has("usage_update")) {
          state.usageUpdates++;
          // A per-round-trip usage report is a round-trip boundary, not
          // semantic progress: on native it arrives once per `complete()`, so
          // treating it as non-tool-call activity let a spin reset the
          // tool-call-only timer forever (nax#2013). It still counts as
          // activity for the primary idle timer.
          if (event.perRoundTrip !== true) state.lastNonToolCallActivityAt = event.timestamp;
          resetActivity(state, event.timestamp, {
            clearGrace: event.perRoundTrip !== true || state.graceReason === "idle_timeout_exceeded",
          });
        }
        break;
      }
```

The `clearGrace` condition mirrors the `tool_call_update` arm directly above it: a round-trip marker must not clear a grace period that the tool-call-only timeout opened, or the cancel never lands.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `bun test test/unit/runtime/middleware/ --timeout=30000`
Expected: PASS, all files. Both new cases green, and the three pre-existing tool-call cases still green — the third one (`"non-tool activity resets the secondary timer"`) uses `makeThinkingUpdateEvent`, which this change does not touch.

- [ ] **Step 8: Run the gates**

Run: `bun run lint && bun run typecheck && bun run test`
Expected: all pass.

- [ ] **Step 9: Commit**

```bash
git add src/runtime/agent-stream-events.ts src/agents/native/session/turn-events.ts \
  src/runtime/middleware/idle-watchdog/index.ts \
  test/unit/runtime/middleware/_idle-watchdog-harness.ts \
  test/unit/runtime/middleware/idle-watchdog-tool-call.test.ts
git commit -m "fix(watchdog): a native round-trip usage report must not reset the tool-call-only timer (#2013)"
```

---

### Task 2: Verifier timeout (US-002)

`verifierOp` declares no `timeoutMs`, so it inherits `execution.sessionTimeoutSeconds` — 7200s in this repo's config, against 1800s on every review op.

**Files:**
- Modify: `src/config/schemas-execution.ts:413-430` (`TddConfigSchema`)
- Modify: `src/config/runtime-types.ts:242-263` (`TddConfig`)
- Modify: `src/config/schemas.ts:213-223` (the `tdd` default block)
- Modify: `src/cli/config-descriptions.ts` (near the other `tdd.*` entries)
- Modify: `src/operations/verify.ts:189-210` (add the resolver)
- Test: `test/unit/operations/verify-op.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `tdd.verifierTimeoutSeconds: number` (default `1800`). No other task depends on it.

- [ ] **Step 1: Write the failing test**

Append to `test/unit/operations/verify-op.test.ts`. It reuses that file's existing `makePackageView()` helper; add `tddConfigSelector` to its imports if the local `makeParseCtx` does not already expose what you need (it does — `makeParseCtx()` returns exactly the `BuildContext<TddConfig>` shape `timeoutMs` receives).

```ts
describe("verifierOp — timeout budget", () => {
  test("resolves its own timeout from tdd.verifierTimeoutSeconds", () => {
    // makeNaxConfig deep-merges onto DEFAULT_CONFIG, so the rest of the tdd
    // block keeps its defaults and this pins the override path alone.
    const config = tddConfigSelector.select(makeNaxConfig({ tdd: { verifierTimeoutSeconds: 600 } }));
    const ctx = { packageView: makePackageView(), config };

    const timeoutMs = verifierOp.timeoutMs?.({ story: makeStory({ id: "US-001" }) }, ctx);

    expect(timeoutMs).toBe(600_000);
  });

  test("defaults to 1800s rather than inheriting the two-hour session timeout", () => {
    const timeoutMs = verifierOp.timeoutMs?.({ story: makeStory({ id: "US-001" }) }, makeParseCtx());

    expect(timeoutMs).toBe(1_800_000);
    expect(timeoutMs).not.toBe(DEFAULT_CONFIG.execution.sessionTimeoutSeconds * 1000);
  });
});
```

Add `makeNaxConfig` to the `@test/helpers` import in that file.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/unit/operations/verify-op.test.ts --timeout=30000`
Expected: FAIL — `timeoutMs` is `undefined` because `verifierOp` declares no resolver, so `expect(undefined).toBe(600000)` fails.

- [ ] **Step 3: Add the schema field**

In `src/config/schemas-execution.ts`, inside `TddConfigSchema`, after `sessionTiers`:

```ts
  /**
   * Wall-clock budget for one verifier turn, in seconds.
   *
   * Its own knob rather than `execution.sessionTimeoutSeconds` because the
   * verifier is a scoped, read-only task: it runs the story's own tests and
   * emits a verdict. Inheriting the session default gave it 7200s and a spin
   * roughly 2,000 iterations of runway before anything fired (nax#2013). The
   * review ops have had their own budget all along (`review.*.timeoutMs`).
   */
  verifierTimeoutSeconds: z.number().int().min(60).max(7200).default(1800),
```

- [ ] **Step 4: Add the runtime type and the default**

In `src/config/runtime-types.ts`, inside `interface TddConfig`, after `sessionTiers`:

```ts
  /** Wall-clock budget for one verifier turn, in seconds (default: 1800) */
  verifierTimeoutSeconds?: number;
```

In `src/config/schemas.ts`, add the key to the `tdd` default block so the hand-written default and the schema default agree:

```ts
    tdd: TddConfigSchema.default({
      maxRetries: 2,
      strategy: "auto",
      sessionTiers: {
        testWriter: "fast",
        verifier: "fast",
      },
      verifierTimeoutSeconds: 1800,
      testWriterAllowedPaths: ["src/index.ts", "src/**/index.ts"],
      rollbackOnFailure: true,
      greenfieldDetection: true,
    }),
```

In `src/cli/config-descriptions.ts`, alongside the other `tdd.*` keys:

```ts
  "tdd.verifierTimeoutSeconds":
    "Wall-clock budget for one verifier turn in seconds (default: 1800). Its own knob, not execution.sessionTimeoutSeconds",
```

- [ ] **Step 5: Add the resolver to the op**

In `src/operations/verify.ts`, in the `verifierOp` literal, directly after the `model:` line:

```ts
  // Verification is a scoped, read-only task — it must not inherit the
  // two-hour session budget. Mirrors the review ops, which have always
  // carried their own (nax#2013).
  timeoutMs: (_input, ctx) => (ctx.config.tdd?.verifierTimeoutSeconds ?? DEFAULT_VERIFIER_TIMEOUT_SECONDS) * 1000,
```

At the top of the file, next to the other module constants:

```ts
/** Fallback when config was built without zod parsing; matches the schema default. */
const DEFAULT_VERIFIER_TIMEOUT_SECONDS = 1800;
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `bun test test/unit/operations/verify-op.test.ts --timeout=30000`
Expected: PASS.

- [ ] **Step 7: Run the gates**

Run: `bun run lint && bun run typecheck && bun run test`
Expected: all pass. Config-schema changes commonly break `test/unit/config/` snapshot-style assertions on the default config — if one fails, the new key is correct and the expectation needs the key added; read the failing assertion before changing it.

- [ ] **Step 8: Commit**

```bash
git add src/config/schemas-execution.ts src/config/runtime-types.ts src/config/schemas.ts \
  src/cli/config-descriptions.ts src/operations/verify.ts test/unit/operations/verify-op.test.ts
git commit -m "feat(verify): give the verifier its own timeout budget instead of the session default (#2013)"
```

---

### Task 3: Op-level tool narrowing seam (US-004, first half)

`advertised()` intersects tool *names* only, so an op declaring `Write` under the `unrestricted` profile receives `["*"]`. This adds a typed way for an op to narrow the patterns of a grant it inherits.

**PLAN REFINEMENT** — the design doc says the narrowing is applied in `createCodingToolRuntime.callTool` after `policy.check` returns. Narrowing the *grants* before `compileToolPolicy` is strictly better: it keeps all glob matching in `policy.ts` (one matcher, already tested) instead of adding a second matching path, and it preserves the same invariant — narrowing only, never granting, because a tool the profile did not grant has no grant to narrow and `advertised()` still drops it.

The intersection rule is decidable by construction, not by comparing globs:
- profile patterns contain `"*"` (the `unrestricted` case) → replace wholesale with the op patterns. Strictly narrower.
- otherwise (a `scoped` profile) → keep only the op patterns that appear verbatim in the grant's own pattern list. An empty result drops the tool and logs, because advertising a write the policy will refuse is worse than withholding it.

**Files:**
- Create: `src/tools/narrow-grants.ts`
- Modify: `src/operations/types.ts:259` (add `toolPatterns` to `RunOperation`, directly after its `tools` field)
- Modify: `src/agents/types.ts:169-170` (add `toolPatterns` to `AgentRunOptions`)
- Modify: `src/operations/call.ts:250` (forward it in `runOptions`)
- Modify: `src/agents/coding-tool-support.ts:163-176` (add to the `Pick`, forward to the builder) and `:38-60` + `:100` (accept it, narrow the grants)
- Modify: `src/tools/index.ts` (export `narrowGrants`)
- Test: `test/unit/tools/narrow-grants.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces:
  - `export type ToolPatternNarrowing = Partial<Record<CodingToolName, readonly string[]>>` from `src/tools/narrow-grants.ts`
  - `export function narrowGrants(grants: readonly ToolGrant[], narrowing: ToolPatternNarrowing | undefined): readonly ToolGrant[]`
  - `RunOperation.toolPatterns?: ToolPatternNarrowing` — Task 4 sets it on `verifierOp`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/tools/narrow-grants.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { narrowGrants } from "@/tools";
import type { ToolGrant } from "@/tools";

const VERDICT = ".nax-verifier-verdict.json";

describe("narrowGrants", () => {
  test("replaces an unconditional grant with the op's patterns", () => {
    const grants: ToolGrant[] = [
      { tool: "Read", patterns: ["*"] },
      { tool: "Write", patterns: ["*"] },
    ];

    const narrowed = narrowGrants(grants, { Write: [VERDICT] });

    expect(narrowed).toEqual([
      { tool: "Read", patterns: ["*"] },
      { tool: "Write", patterns: [VERDICT] },
    ]);
  });

  test("keeps only op patterns the scoped grant already names verbatim", () => {
    const grants: ToolGrant[] = [{ tool: "Write", patterns: [VERDICT, "src/**"] }];

    const narrowed = narrowGrants(grants, { Write: [VERDICT] });

    expect(narrowed).toEqual([{ tool: "Write", patterns: [VERDICT] }]);
  });

  test("drops a tool whose scoped grant does not name the op's pattern", () => {
    const grants: ToolGrant[] = [{ tool: "Write", patterns: ["src/**"] }];

    const narrowed = narrowGrants(grants, { Write: [VERDICT] });

    expect(narrowed).toEqual([]);
  });

  test("never grants a tool the profile withheld", () => {
    const grants: ToolGrant[] = [{ tool: "Read", patterns: ["*"] }];

    const narrowed = narrowGrants(grants, { Write: [VERDICT] });

    expect(narrowed.some((grant) => grant.tool === "Write")).toBe(false);
  });

  test("returns the same array when there is no narrowing", () => {
    const grants: ToolGrant[] = [{ tool: "Write", patterns: ["*"] }];

    expect(narrowGrants(grants, undefined)).toBe(grants);
    expect(narrowGrants(grants, {})).toBe(grants);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/unit/tools/narrow-grants.test.ts --timeout=30000`
Expected: FAIL at import — `narrowGrants` is not exported from `@/tools`.

- [ ] **Step 3: Write the module**

Create `src/tools/narrow-grants.ts`:

```ts
/**
 * Narrowing a grant an operation inherits.
 *
 * `CodingToolRuntime.advertised()` intersects tool NAMES against the policy's
 * grants, so an op declaring `Write` under the `unrestricted` profile received
 * that profile's `["*"]` — there was no way to say "this role may write, but
 * only this one file" (nax#2013).
 *
 * Narrowing only. `resolvePermissions` remains the single permission authority
 * (CLAUDE.md, Permission Resolution): a tool the profile did not grant has no
 * grant here to narrow, so nothing in this module can widen access.
 *
 * Glob-set intersection is undecidable in general, so the rule is structural
 * rather than semantic — see each branch below.
 */

import { getSafeLogger } from "@/logger";
import type { CodingToolName, ToolGrant } from "./types";

/** Per-tool path globs an operation asks to be held to. */
export type ToolPatternNarrowing = Partial<Record<CodingToolName, readonly string[]>>;

const UNCONDITIONAL = "*";

export function narrowGrants(
  grants: readonly ToolGrant[],
  narrowing: ToolPatternNarrowing | undefined,
): readonly ToolGrant[] {
  if (narrowing === undefined || Object.keys(narrowing).length === 0) return grants;

  // Indexed through a Map rather than `narrowing[grant.tool]`: `ToolGrant.tool`
  // is a plain string (third parties register their own names) while the
  // op-facing type is keyed on CodingToolName so a typo in an op is a compile
  // error. Object.entries bridges the two without a cast.
  const wanted = new Map<string, readonly string[]>(
    Object.entries(narrowing).filter((entry): entry is [string, readonly string[]] => entry[1] !== undefined),
  );

  const out: ToolGrant[] = [];
  for (const grant of grants) {
    const requested = wanted.get(grant.tool);
    if (requested === undefined || requested.length === 0) {
      out.push(grant);
      continue;
    }
    // An unconditional grant is wider than any concrete list, so the op's
    // patterns are unambiguously a narrowing of it.
    if (grant.patterns.includes(UNCONDITIONAL)) {
      out.push({ tool: grant.tool, patterns: [...requested] });
      continue;
    }
    // A scoped grant already names specific globs. Comparing two globs for
    // containment is undecidable, so admit only the ones the grant's author
    // wrote verbatim — which is what a scoped profile intending this writes.
    const admitted = requested.filter((pattern) => grant.patterns.includes(pattern));
    if (admitted.length === 0) {
      getSafeLogger()?.warn("tools", "[policy] op narrowing excluded by the scoped grant — tool withheld", {
        tool: grant.tool,
        requested: [...requested],
        granted: [...grant.patterns],
      });
      continue;
    }
    out.push({ tool: grant.tool, patterns: admitted });
  }
  return out;
}
```

Export it from `src/tools/index.ts` alongside the other policy exports:

```ts
export { narrowGrants, type ToolPatternNarrowing } from "./narrow-grants";
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test test/unit/tools/narrow-grants.test.ts --timeout=30000`
Expected: PASS, 5 tests.

- [ ] **Step 5: Thread `toolPatterns` from the op to the policy**

In `src/operations/types.ts`, in `interface RunOperation<I, O, C>` directly after its `tools` field (line 259), add:

```ts
  /**
   * Per-tool path globs this op is held to, narrowing — never widening — the
   * grants its permission profile resolved. `{ Write: [".nax-x.json"] }` means
   * "this role may write, but only that file". See src/tools/narrow-grants.ts.
   */
  readonly toolPatterns?: import("../tools").ToolPatternNarrowing;
```

In `src/agents/types.ts`, directly after `declaredTools`:

```ts
  /** Per-tool narrowing from the op's `toolPatterns`; applied to the resolved grants. */
  toolPatterns?: import("@/tools").ToolPatternNarrowing;
```

In `src/operations/call.ts`, in the `runOptions` literal next to `declaredTools`:

```ts
    declaredTools: resolveDeclaredTools(runOp),
    ...(runOp.toolPatterns !== undefined ? { toolPatterns: runOp.toolPatterns } : {}),
```

In `src/agents/coding-tool-support.ts`, add `"toolPatterns"` to `resolveCodingToolSupport`'s `Pick<AgentRunOptions, ...>` list, and forward it in the `buildCodingToolSupport({ ... })` call:

```ts
    ...(options.toolPatterns !== undefined ? { toolPatterns: options.toolPatterns } : {}),
```

In the same file, add the parameter to `buildCodingToolSupport`'s args object:

```ts
  /** Per-tool narrowing from the op's `toolPatterns` (nax#2013). */
  toolPatterns?: ToolPatternNarrowing;
```

and narrow before compiling, replacing the `policy:` line of the `createCodingToolRuntime` call:

```ts
    policy: compileToolPolicy(narrowGrants(grants, args.toolPatterns), args.root, { execTouchedPaths }),
```

Import `narrowGrants` and `ToolPatternNarrowing` from `../tools` in that file.

Note: `grants.length === 0` is still checked against the *unnarrowed* list at the top of `buildCodingToolSupport`, which is correct — narrowing that empties the list should fall through to the existing `tools.length === 0` guard and return `undefined`, the same as any other "nothing advertised" outcome.

- [ ] **Step 6: Run the gates**

Run: `bun run lint && bun run typecheck && bun run test`
Expected: all pass. No behaviour changes yet — no op sets `toolPatterns`, and `narrowGrants` returns its input unchanged when the field is absent.

- [ ] **Step 7: Commit**

```bash
git add src/tools/narrow-grants.ts src/tools/index.ts src/operations/types.ts src/agents/types.ts \
  src/operations/call.ts src/agents/coding-tool-support.ts test/unit/tools/narrow-grants.test.ts
git commit -m "feat(tools): let an operation narrow the tool grants it inherits (#2013)"
```

---

### Task 4: Scoped verifier write and the staleness guard (US-004, second half)

The verdict prompt says the verifier **MUST** write `.nax-verifier-verdict.json`; the op grants no `Write`, so the instruction is unsatisfiable and `verifierOp.recover`'s disk fallback is dead code.

**PLAN REFINEMENT** — the design doc guards staleness by ignoring a verdict file older than the turn's dispatch. Deleting the file immediately *before* dispatch is simpler and strictly stronger: any file present afterwards is necessarily this turn's, so no clock, no timestamp plumbing, and no new field on `VerifierInput`. The post-dispatch cleanups stay as they are.

**Files:**
- Modify: `src/operations/verify.ts:203` (declare `Write`, add `toolPatterns`)
- Modify: `src/execution/story-orchestrator/run-phase.ts:185-187` (pre-dispatch cleanup)
- Modify: `scripts/check-op-tool-capability.ts` (`REQUIRED_TOOLS_BY_ROLE.verifier`)
- Test: `test/unit/operations/verify-op.test.ts`, `test/unit/execution/story-orchestrator/` (new file)

**Interfaces:**
- Consumes: `ToolPatternNarrowing` and `RunOperation.toolPatterns` from Task 3.
- Produces: nothing other tasks depend on.

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/operations/verify-op.test.ts`:

```ts
describe("verifierOp — verdict-file write capability", () => {
  test("declares Write so the verdict-file instruction is satisfiable", () => {
    expect(verifierOp.tools).toContain("Write");
  });

  test("narrows Write to the verdict file alone", () => {
    expect(verifierOp.toolPatterns?.Write).toEqual([VERDICT_FILE]);
  });

  test("still withholds Edit, Delete and GitCommit — a verifier must not repair", () => {
    expect(verifierOp.tools).not.toContain("Edit");
    expect(verifierOp.tools).not.toContain("Delete");
    expect(verifierOp.tools).not.toContain("GitCommit");
  });

  test("the narrowing holds against an unrestricted profile", () => {
    const granted = narrowGrants(
      [
        { tool: "Write", patterns: ["*"] },
        { tool: "Read", patterns: ["*"] },
      ],
      verifierOp.toolPatterns,
    );

    expect(granted).toContainEqual({ tool: "Write", patterns: [VERDICT_FILE] });
  });
});
```

Add `VERDICT_FILE` (from `@/tdd`) and `narrowGrants` (from `@/tools`) to that file's imports.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/unit/operations/verify-op.test.ts --timeout=30000`
Expected: FAIL — the first test reports `Write` absent from `verifierOp.tools`.

- [ ] **Step 3: Grant the scoped write**

In `src/operations/verify.ts`, replace the `tools:` line and the comment above it that currently claims Write is withheld:

```ts
  // Read + run + one write. `RunCommand` because the role's first instruction
  // is "Run ONLY the story's scoped test files"; `Git` so it can independently
  // inspect test-file history per its own instruction to "check whether the
  // implementer modified test files after the test-writer phase" -- separate
  // from the deterministic `beforeRef` isolation check the orchestrator runs
  // after this turn. `Write` is narrowed to the verdict file alone by
  // `toolPatterns` below: the prompt has always instructed the verifier to
  // write it (prompts/sections/verdict.ts) and `recover` has always read it,
  // but without the grant the instruction was unsatisfiable and the fallback
  // unreachable (nax#2013). Edit/Delete/GitCommit stay withheld: a verifier
  // that can repair what it judges is not a verifier, and its isolation check
  // assumes it changed nothing but the verdict.
  tools: ["Read", "Glob", "Grep", "Git", "RunCommand", "Write"],
  // The verdict file is the ONLY path this role may write. Narrowing, never
  // widening — see src/tools/narrow-grants.ts.
  toolPatterns: { Write: [VERDICT_FILE] },
```

`VERDICT_FILE` is already importable from `../tdd/verdict`, which this file imports from; add it to that import list.

Note for isolation: `VERDICT_FILE` is already excluded from the review runner's diff (`src/review/runner/index.ts:245`), whitelisted by the git precheck (`src/precheck/checks-git.ts:53`), and gitignored (`src/utils/gitignore.ts:52`), so a written verdict file does not read as a source change anywhere. Confirm those three still hold rather than assuming.

- [ ] **Step 4: Update the capability ratchet**

In `scripts/check-op-tool-capability.ts`, `REQUIRED_TOOLS_BY_ROLE`:

```ts
  /**
   * The verifier runs the story's scoped tests AND writes one fresh output
   * file — the same `fileOutput`-style contract as the four roles below. It
   * was omitted from that group, so the prompt's mandatory verdict-file write
   * had no tool behind it and `recover`'s disk fallback was dead (nax#2013).
   */
  verifier: ["RunCommand", "Write"],
```

- [ ] **Step 5: Write the pre-dispatch cleanup test**

Create `test/unit/execution/story-orchestrator/verdict-predispatch-cleanup.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { VERDICT_FILE } from "@/tdd";
import { clearStaleVerdictBeforeDispatch } from "@/execution/story-orchestrator/run-phase";

describe("clearStaleVerdictBeforeDispatch", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir("nax-test-verdict-predispatch-");
  });

  afterEach(() => {
    cleanupTempDir(dir);
  });

  test("removes a verdict file left by an earlier story", async () => {
    const path = join(dir, VERDICT_FILE);
    await Bun.write(path, JSON.stringify({ version: 1, approved: true }));

    await clearStaleVerdictBeforeDispatch("verifier", dir);

    expect(await Bun.file(path).exists()).toBe(false);
  });

  test("is a no-op for a phase that is not the verifier", async () => {
    const path = join(dir, VERDICT_FILE);
    await Bun.write(path, JSON.stringify({ version: 1, approved: true }));

    await clearStaleVerdictBeforeDispatch("implementer", dir);

    expect(await Bun.file(path).exists()).toBe(true);
  });

  test("tolerates a missing file", async () => {
    await clearStaleVerdictBeforeDispatch("verifier", dir);

    expect(await Bun.file(join(dir, VERDICT_FILE)).exists()).toBe(false);
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `bun test test/unit/execution/story-orchestrator/verdict-predispatch-cleanup.test.ts --timeout=30000`
Expected: FAIL at import — `clearStaleVerdictBeforeDispatch` does not exist.

- [ ] **Step 7: Add the pre-dispatch cleanup**

In `src/execution/story-orchestrator/run-phase.ts`, add the exported helper near the other module-level helpers:

```ts
/**
 * Delete any verdict file before the verifier dispatches, so a file found
 * afterwards is necessarily this turn's.
 *
 * Needed once the verifier can actually write one (nax#2013): `cleanupVerdict`
 * otherwise runs only in `verifierOp.recover`'s `finally` and once at
 * post-run, so story A's verdict would survive into story B, where `recover`
 * would read it and rule on the wrong story. Deleting before dispatch is
 * stronger than comparing timestamps — there is no clock to get wrong.
 *
 * Best-effort: a failure here must not fail the phase, and the worst case is
 * the pre-existing behaviour.
 */
export async function clearStaleVerdictBeforeDispatch(opName: string, packageDir: string): Promise<void> {
  if (opName !== verifierOp.name || packageDir.trim() === "") return;
  await _storyOrchestratorDeps.cleanupVerdict(packageDir).catch(() => undefined);
}
```

Add `cleanupVerdict` to `_storyOrchestratorDeps` (importing it from `@/tdd`) so the helper is injectable like `captureGitRef`, and import `verifierOp` from `@/operations` if the file does not already.

Call it immediately before the `beforeRef` capture, which is the established pre-dispatch point:

```ts
  // Pre-phase: clear any stale verdict, capture git ref for TDD phases; emit phase-begin log.
  await clearStaleVerdictBeforeDispatch(opName, ctx.packageDir);
  const beforeRef = isTddPhase ? await _storyOrchestratorDeps.captureGitRef(ctx.packageDir) : undefined;
```

- [ ] **Step 8: Run both test files to verify they pass**

Run: `bun test test/unit/operations/verify-op.test.ts test/unit/execution/story-orchestrator/ --timeout=30000`
Expected: PASS.

- [ ] **Step 9: Run the capability ratchet and the gates**

Run: `bun run check:op-tool-capability && bun run lint && bun run typecheck && bun run test`
Expected: all pass. If the ratchet reports the verifier as a *baseline* entry that is now satisfied, remove it from the baseline file the script names — a satisfied violation must not stay grandfathered.

- [ ] **Step 10: Commit**

```bash
git add src/operations/verify.ts src/execution/story-orchestrator/run-phase.ts \
  scripts/check-op-tool-capability.ts test/unit/operations/verify-op.test.ts \
  test/unit/execution/story-orchestrator/verdict-predispatch-cleanup.test.ts
git commit -m "fix(verify): grant the verifier a verdict-file-scoped write and clear stale verdicts (#2013)"
```

---

### Task 5: The spin-breaker module (US-001, first third)

A pure, transport-neutral detector. No wiring yet — this task ends with a fully tested module nothing calls.

**Files:**
- Create: `src/runtime/spin-breaker.ts`
- Modify: `src/runtime/index.ts` (export it)
- Test: `test/unit/runtime/spin-breaker.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces, all used by Task 7:
  - `ResolvedSpinBreakerSettings = { enabled: boolean; nudgeAfterRepeats: number; maxNudges: number; stopAfterRepeats: number; recentKeyWindow: number }`
  - `SpinVerdict = { action: "allow" } | { action: "nudge"; nudgeNumber: number; repeats: number; text: string } | { action: "stop"; repeats: number }`
  - `SpinBreaker = { observe(toolName: string, input: unknown): SpinVerdict; summary(): SpinSummary }`
  - `SpinSummary = { totalCalls: number; distinctKeys: number; maxRepeatRun: number; nudges: number }`
  - `createSpinBreaker(settings: ResolvedSpinBreakerSettings): SpinBreaker`
  - `DEFAULT_SPIN_BREAKER_SETTINGS: ResolvedSpinBreakerSettings`

- [ ] **Step 1: Write the failing tests**

Create `test/unit/runtime/spin-breaker.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { createSpinBreaker, type ResolvedSpinBreakerSettings } from "@/runtime";

function settings(overrides: Partial<ResolvedSpinBreakerSettings> = {}): ResolvedSpinBreakerSettings {
  return {
    enabled: true,
    nudgeAfterRepeats: 25,
    maxNudges: 3,
    stopAfterRepeats: 50,
    recentKeyWindow: 64,
    ...overrides,
  };
}

const TEST_CMD = { command: "testScoped", values: { files: "a.test.ts" } };
const OTHER_CMD = { command: "testScoped", values: { files: "b.test.ts" } };

describe("createSpinBreaker", () => {
  test("allows a varied call sequence indefinitely", () => {
    const breaker = createSpinBreaker(settings());

    for (let i = 0; i < 600; i += 1) {
      const verdict = breaker.observe("Read", { path: `src/file-${i}.ts` });
      expect(verdict.action).toBe("allow");
    }
  });

  test("nudges at the configured repeat count", () => {
    const breaker = createSpinBreaker(settings());
    const actions: string[] = [];

    for (let i = 0; i < 26; i += 1) actions.push(breaker.observe("RunCommand", TEST_CMD).action);

    // Call 1 is a new key (progress). Calls 2..26 are 25 repeats, so the 26th
    // is the first to reach nudgeAfterRepeats.
    expect(actions.slice(0, 25).every((action) => action === "allow")).toBe(true);
    expect(actions[25]).toBe("nudge");
  });

  test("counts alternating shapes as repetition, which is what the incident did", () => {
    const breaker = createSpinBreaker(settings());
    let nudges = 0;

    for (let i = 0; i < 30; i += 1) {
      if (breaker.observe("RunCommand", i % 2 === 0 ? TEST_CMD : OTHER_CMD).action === "nudge") nudges += 1;
    }

    expect(nudges).toBeGreaterThan(0);
  });

  test("escalates through maxNudges then stops", () => {
    const breaker = createSpinBreaker(settings());
    const nudgeTexts: string[] = [];
    let stoppedAt: number | undefined;

    for (let i = 0; i < 60 && stoppedAt === undefined; i += 1) {
      const verdict = breaker.observe("RunCommand", TEST_CMD);
      if (verdict.action === "nudge") nudgeTexts.push(verdict.text);
      if (verdict.action === "stop") stoppedAt = verdict.repeats;
    }

    expect(nudgeTexts).toHaveLength(3);
    expect(new Set(nudgeTexts).size).toBe(3);
    expect(stoppedAt).toBe(50);
  });

  test("a new key resets the run, so progress buys a full budget again", () => {
    const breaker = createSpinBreaker(settings());

    for (let i = 0; i < 24; i += 1) breaker.observe("RunCommand", TEST_CMD);
    expect(breaker.observe("Read", { path: "src/new.ts" }).action).toBe("allow");
    for (let i = 0; i < 24; i += 1) {
      expect(breaker.observe("RunCommand", TEST_CMD).action).toBe("allow");
    }
  });

  test("treats key order in the input as irrelevant", () => {
    const breaker = createSpinBreaker(settings({ nudgeAfterRepeats: 2, stopAfterRepeats: 4, maxNudges: 1 }));

    breaker.observe("RunCommand", { command: "t", values: { files: "a" } });
    breaker.observe("RunCommand", { values: { files: "a" }, command: "t" });
    const verdict = breaker.observe("RunCommand", { command: "t", values: { files: "a" } });

    expect(verdict.action).toBe("nudge");
  });

  test("is inert when disabled", () => {
    const breaker = createSpinBreaker(settings({ enabled: false }));

    for (let i = 0; i < 200; i += 1) {
      expect(breaker.observe("RunCommand", TEST_CMD).action).toBe("allow");
    }
    expect(breaker.summary().nudges).toBe(0);
  });

  test("summary reports what a later decision needs", () => {
    const breaker = createSpinBreaker(settings());

    breaker.observe("Read", { path: "a.ts" });
    for (let i = 0; i < 30; i += 1) breaker.observe("RunCommand", TEST_CMD);

    const summary = breaker.summary();
    expect(summary.totalCalls).toBe(31);
    expect(summary.distinctKeys).toBe(2);
    expect(summary.maxRepeatRun).toBe(29);
    expect(summary.nudges).toBe(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/unit/runtime/spin-breaker.test.ts --timeout=30000`
Expected: FAIL at import — `createSpinBreaker` is not exported from `@/runtime`.

- [ ] **Step 3: Write the module**

Create `src/runtime/spin-breaker.ts`:

```ts
/**
 * Repetition breaker for an agent turn.
 *
 * A verifier session ran 36 minutes re-running the same PASSING scoped test
 * 622 times, emitted no verdict, and was ended by an operator (nax#2013). Every
 * call was fast and exited 0, so there was no timeout, no error rate and no
 * failing gate to trip; what distinguished it was repetition without progress
 * — 622 calls across 2 distinct argv shapes and no file writes.
 *
 * Deliberately NOT a round-trip cap. That was removed twice on purpose
 * (#1823/#1827/#1830, then #1819/#1820) and a session making 600 VARIED calls
 * is working, not spinning. This counts only calls whose normalised shape was
 * already seen.
 *
 * Transport-neutral and config-free by construction: it takes resolved
 * settings, so `src/agents/native/` can consult it without reading NaxConfig
 * (check:adapter-no-config-import).
 */

import { getSafeLogger } from "@/logger";
import { byCodePoint } from "@/utils/sort";

export interface ResolvedSpinBreakerSettings {
  readonly enabled: boolean;
  /** Repeats since the last new call before the first nudge. */
  readonly nudgeAfterRepeats: number;
  /** How many nudges to spend before the hard stop. */
  readonly maxNudges: number;
  /** Repeats since the last new call at which the turn ends. */
  readonly stopAfterRepeats: number;
  /** How many recent distinct keys count as "already seen". */
  readonly recentKeyWindow: number;
}

export const DEFAULT_SPIN_BREAKER_SETTINGS: ResolvedSpinBreakerSettings = Object.freeze({
  enabled: true,
  nudgeAfterRepeats: 25,
  maxNudges: 3,
  stopAfterRepeats: 50,
  recentKeyWindow: 64,
});

export type SpinVerdict =
  | { readonly action: "allow" }
  | { readonly action: "nudge"; readonly nudgeNumber: number; readonly repeats: number; readonly text: string }
  | { readonly action: "stop"; readonly repeats: number };

export interface SpinSummary {
  readonly totalCalls: number;
  readonly distinctKeys: number;
  readonly maxRepeatRun: number;
  readonly nudges: number;
}

export interface SpinBreaker {
  observe(toolName: string, input: unknown): SpinVerdict;
  summary(): SpinSummary;
}

/** Beyond this, the key is hashed — one large input must not grow the key set without bound. */
const MAX_KEY_BYTES = 512;

/** Deterministic regardless of property order, so a reordered input is the same call. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort((a, b) => byCodePoint(a[0], b[0]));
  return `{${entries.map(([key, val]) => `${JSON.stringify(key)}:${stableStringify(val)}`).join(",")}}`;
}

function callKey(toolName: string, input: unknown): string {
  const body = stableStringify(input);
  const clipped = body.length > MAX_KEY_BYTES ? String(Bun.hash(body)) : body;
  return `${toolName} ${clipped}`;
}

/**
 * Nudge points are derived from the three knobs rather than configured
 * separately: with 25/50/3 they fall at 25, 33 and 42, leaving the stop at 50.
 */
function nudgePoints(settings: ResolvedSpinBreakerSettings): readonly number[] {
  const span = settings.stopAfterRepeats - settings.nudgeAfterRepeats;
  return Array.from({ length: settings.maxNudges }, (_unused, index) =>
    Math.round(settings.nudgeAfterRepeats + (index * span) / settings.maxNudges),
  );
}

const NUDGE_ESCALATION: readonly string[] = [
  "You have made {repeats} tool calls without issuing a new, distinct call. You are repeating work already done and the results are not changing. Stop re-running and produce your final answer now, in the exact format your instructions require.",
  "You are still repeating the same calls ({repeats} with no new work). If you cannot conclude, say so explicitly in your final answer and stop — an explicit inability to conclude is a valid answer; repeating is not.",
  "Final warning: {repeats} repeated calls with no progress. The next repeated call ends this session with no answer recorded. Produce your final answer now.",
];

function nudgeText(nudgeNumber: number, repeats: number): string {
  const template = NUDGE_ESCALATION[Math.min(nudgeNumber, NUDGE_ESCALATION.length) - 1] ?? NUDGE_ESCALATION[0];
  return (template ?? "").replace("{repeats}", String(repeats));
}

export function createSpinBreaker(settings: ResolvedSpinBreakerSettings): SpinBreaker {
  const points = nudgePoints(settings);
  // Insertion-ordered and capped: a Map's iteration order gives the eviction
  // order for free, so the window needs no second structure.
  const recent = new Map<string, true>();
  let repeatsSinceProgress = 0;
  let totalCalls = 0;
  let distinctKeys = 0;
  let maxRepeatRun = 0;
  let nudges = 0;

  function remember(key: string): void {
    recent.set(key, true);
    distinctKeys += 1;
    if (recent.size > settings.recentKeyWindow) {
      const oldest = recent.keys().next();
      if (!oldest.done) recent.delete(oldest.value);
    }
  }

  return {
    observe(toolName, input) {
      if (!settings.enabled) return { action: "allow" };
      totalCalls += 1;
      const key = callKey(toolName, input);

      if (!recent.has(key)) {
        remember(key);
        repeatsSinceProgress = 0;
        return { action: "allow" };
      }

      repeatsSinceProgress += 1;
      if (repeatsSinceProgress > maxRepeatRun) maxRepeatRun = repeatsSinceProgress;

      if (repeatsSinceProgress >= settings.stopAfterRepeats) {
        getSafeLogger()?.error("spin-breaker", "Ending the turn — repeated calls with no progress", {
          tool: toolName,
          repeats: repeatsSinceProgress,
          distinctKeys,
          totalCalls,
          nudges,
        });
        return { action: "stop", repeats: repeatsSinceProgress };
      }

      const pointIndex = points.indexOf(repeatsSinceProgress);
      if (pointIndex !== -1 && nudges < settings.maxNudges) {
        nudges += 1;
        getSafeLogger()?.warn("spin-breaker", "Repeated calls with no progress — nudging", {
          tool: toolName,
          repeats: repeatsSinceProgress,
          nudgeNumber: nudges,
          distinctKeys,
        });
        return {
          action: "nudge",
          nudgeNumber: nudges,
          repeats: repeatsSinceProgress,
          text: nudgeText(nudges, repeatsSinceProgress),
        };
      }

      return { action: "allow" };
    },

    summary() {
      return { totalCalls, distinctKeys, maxRepeatRun, nudges };
    },
  };
}
```

Export from `src/runtime/index.ts`:

```ts
export {
  createSpinBreaker,
  DEFAULT_SPIN_BREAKER_SETTINGS,
  type ResolvedSpinBreakerSettings,
  type SpinBreaker,
  type SpinSummary,
  type SpinVerdict,
} from "./spin-breaker";
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test test/unit/runtime/spin-breaker.test.ts --timeout=30000`
Expected: PASS, 8 tests. If the "nudges at the configured repeat count" case is off by one, fix the test's arithmetic against the module's documented semantics (the first call is progress, not a repeat) — do not change the module to match a miscounted expectation.

- [ ] **Step 5: Run the gates**

Run: `bun run lint && bun run typecheck && bun run test`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/runtime/spin-breaker.ts src/runtime/index.ts test/unit/runtime/spin-breaker.test.ts
git commit -m "feat(runtime): add a repetition breaker for agent turns (#2013)"
```

---

### Task 6: The `fail-spin` outcome (US-001, second third)

Gives the spin a failure identity of its own, so a recurrence is measurable instead of hiding inside `fail-timeout`, and routes it into the existing same-agent timeout lane: a fresh session with a reduced budget, then a swap.

**Files:**
- Modify: `src/context/engine/types.ts:33-52` (the outcome union and its doc block)
- Modify: `src/agents/retry/failure-policy.ts` (a `POLICIES` row)
- Modify: `src/agents/session-types.ts:166-232` (`TurnResult.spinStopped`)
- Modify: `src/operations/call-hop-output.ts:38-55` (classify before the empty-output check)
- Test: `test/unit/agents/retry/failure-policy.test.ts` (existing), `test/unit/operations/call-hop-output.test.ts` (existing or new)

**Interfaces:**
- Consumes: nothing.
- Produces: `TurnResult.spinStopped?: true` — Task 7 sets it. `AdapterFailure["outcome"]` gains `"fail-spin"`.

- [ ] **Step 1: Write the failing tests**

Add to `test/unit/agents/retry/failure-policy.test.ts` (match the file's existing idiom for reading a row):

```ts
  test("fail-spin retries on the same agent with a fresh session, then swaps", () => {
    const policy = failurePolicyFor("fail-spin");

    expect(policy.sameAgentRetry).toBe("timeout");
    expect(policy.swap).toBe("after-retry-lane");
    expect(policy.cooldown).toBe("none");
    expect(policy.terminalBackoff).toBe(false);
  });
```

Add to `test/unit/operations/call-hop-output.test.ts` (create it if absent, following the import style of the neighbouring operations tests):

```ts
import { describe, expect, test } from "bun:test";
// Leaf import: `normalizeHopOutput` is deliberately NOT on the @/operations
// barrel (only the two classifiers are), so import it from its own module.
import { normalizeHopOutput } from "@/operations/call-hop-output";
import type { TurnResult } from "@/agents/types";

function makeTurn(overrides: Partial<TurnResult> = {}): TurnResult {
  return {
    output: "",
    tokenUsage: { inputTokens: 0, outputTokens: 0 },
    estimatedCostUsd: 0,
    internalRoundTrips: 1,
    ...overrides,
  };
}

const ctx = {
  storyId: "US-002",
  opName: "verifier",
  dispatchAgent: "native",
  fileOutputPath: undefined,
  readFileOutput: async () => null,
};

describe("normalizeHopOutput — spin-stopped turns", () => {
  test("classifies a spin-stopped turn as fail-spin even when it carries prose", async () => {
    const turn = makeTurn({
      output: "I re-ran the tests and they pass. Let me check once more.",
      spinStopped: true,
      turnIncomplete: true,
    });

    const result = await normalizeHopOutput(async () => turn, "prompt", ctx);

    expect(result.adapterFailure?.outcome).toBe("fail-spin");
    expect(result.adapterFailure?.retriable).toBe(true);
    expect(result.adapterFailure?.category).toBe("quality");
  });

  test("leaves a producer's own adapterFailure untouched", async () => {
    const turn = makeTurn({
      output: "prose",
      spinStopped: true,
      adapterFailure: { category: "availability", outcome: "fail-quota", retriable: false, message: "out of quota" },
    });

    const result = await normalizeHopOutput(async () => turn, "prompt", ctx);

    expect(result.adapterFailure?.outcome).toBe("fail-quota");
  });

  test("does not classify an ordinary completed turn", async () => {
    const result = await normalizeHopOutput(async () => makeTurn({ output: "{}" }), "prompt", ctx);

    expect(result.adapterFailure).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/unit/agents/retry/failure-policy.test.ts test/unit/operations/call-hop-output.test.ts --timeout=30000`
Expected: FAIL — `failurePolicyFor("fail-spin")` is a type error and `spinStopped` is not a `TurnResult` field.

- [ ] **Step 3: Add the outcome to the union**

In `src/context/engine/types.ts`, add `| "fail-spin"` to the `outcome` union and document it in the doc block above, next to the `fail-stale` paragraph:

```
   * `fail-spin` — the spin breaker ended the turn: the model kept issuing tool
   * calls whose shape it had already issued, with no new work between them
   * (nax#2013). Distinct from `fail-timeout` on purpose — both mean "no usable
   * answer within the budget", but only this one is measurable as a spin, and
   * #2013 exists because the failure mode was invisible. Retriable: the retry
   * opens a fresh session, so the repetition is not carried forward.
```

Also extend the `quality:` line of the machine-readable list to include it.

- [ ] **Step 4: Add the policy row**

In `src/agents/retry/failure-policy.ts`, inside `POLICIES`, after the `fail-timeout` row:

```ts
  /**
   * Reuses the `timeout` lane rather than inventing a third: that lane already
   * does exactly what a spin wants — same agent, FRESH session (so the
   * repeating transcript is dropped) at a reduced budget, then a swap once the
   * lane is spent. `trySameAgentRetry` dispatches on the lane, not the
   * outcome, so this needs no new retry machinery (nax#2013).
   */
  "fail-spin": {
    sameAgentRetry: "timeout",
    swap: "after-retry-lane",
    cooldown: "none",
    cooldownScope: "model",
    terminalBackoff: false,
  },
```

`POLICIES` is typed `Readonly<Record<AdapterFailure["outcome"], FailurePolicy>>`, so omitting this row is a compile error — which is the point.

- [ ] **Step 5: Add the transport fact**

In `src/agents/session-types.ts`, after `turnIncomplete`:

```ts
  /**
   * Transport fact: the loop returned because the spin breaker stopped it —
   * the model kept issuing calls whose shape it had already issued, with no
   * new work between them (nax#2013).
   *
   * Like `timedOut` and `turnIncomplete`, the adapter never classifies WHY; the
   * wiring layer maps it to the `fail-spin` policy outcome
   * (operations/call-hop-output.ts). A spin-stopped turn also sets
   * `turnIncomplete`, since work the model asked for was left unexecuted.
   */
  spinStopped?: true;
```

- [ ] **Step 6: Classify it in the wiring layer**

In `src/operations/call-hop-output.ts`, insert before the `if (!effective.output?.trim())` block:

```ts
  // Checked before the output branches: a spun turn almost always HAS prose
  // (the model narrating the re-runs), so an output-first check would classify
  // it as a clean success — the same defect that hid truncated turns. A
  // producer's own failure still wins, matching classifyEmptyOutputFailure.
  if (effective.spinStopped === true && effective.adapterFailure === undefined) {
    getSafeLogger()?.warn("callop", "Spin breaker ended the turn", {
      storyId: ctx.storyId,
      opName: ctx.opName,
      agentName: ctx.dispatchAgent,
    });
    return {
      ...effective,
      adapterFailure: {
        category: "quality",
        outcome: "fail-spin",
        retriable: true,
        message: "[callOp] spin breaker ended the turn: repeated tool calls with no progress",
        reason: "spin-breaker",
      },
    };
  }
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `bun test test/unit/agents/retry/ test/unit/operations/call-hop-output.test.ts --timeout=30000`
Expected: PASS.

- [ ] **Step 8: Run the gates**

Run: `bun run lint && bun run typecheck && bun run test`
Expected: all pass. Adding a union member can surface exhaustive-switch errors in `src/agents/complete-exception-classifier.ts`, `src/agents/manager-run-fallback.ts` and `src/agents/native/errors.ts` — each hit is a real decision about how that site treats a spin, so read the site rather than adding a default arm. None of them *produce* `fail-spin`; only the wiring layer does.

- [ ] **Step 9: Commit**

```bash
git add src/context/engine/types.ts src/agents/retry/failure-policy.ts src/agents/session-types.ts \
  src/operations/call-hop-output.ts test/unit/agents/retry/failure-policy.test.ts \
  test/unit/operations/call-hop-output.test.ts
git commit -m "feat(agents): add a fail-spin outcome routed through the timeout retry lane (#2013)"
```

---

### Task 7: Wire the breaker into the native turn loop (US-001, final third)

**Files:**
- Create: `src/session/spin-breaker-selection.ts`
- Modify: `src/config/schemas-infra.ts` (`AgentSpinBreakerConfigSchema`, `DEFAULT_AGENT_SPIN_BREAKER_CONFIG`, `AgentConfigSchema`)
- Modify: `src/config/runtime-types-agent.ts` (`AgentSpinBreakerConfig`, `AgentConfig.spinBreaker`)
- Modify: `src/config/schemas.ts` (the `agent` default block)
- Modify: `src/cli/config-descriptions.ts`
- Modify: `src/agents/session-types.ts` (`OpenSessionOpts.spinBreaker`)
- Modify: `src/session/manager.ts:464` (spread the new selection)
- Modify: `src/agents/native/session/session.ts` (a session map, set on open, cleared on close)
- Modify: `src/agents/native/adapter.ts:233-290` (read the map, pass into `runNativeTurn`)
- Modify: `src/agents/native/session/turn-loop.ts:60-70, 194, 388-452, 498-512` (consult it; set `spinStopped`)
- Test: `test/unit/session/spin-breaker-selection.test.ts`, `test/unit/agents/native/session/turn-loop-spin.test.ts`

**Interfaces:**
- Consumes: `createSpinBreaker`, `ResolvedSpinBreakerSettings`, `DEFAULT_SPIN_BREAKER_SETTINGS` (Task 5); `TurnResult.spinStopped` (Task 6).
- Produces: `agent.spinBreaker` config; `selectSpinBreakerSettings(config: AgentManagerConfig | undefined): ResolvedSpinBreakerSettings`.

- [ ] **Step 1: Write the failing resolver test**

Create `test/unit/session/spin-breaker-selection.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { makeNaxConfig } from "@test/helpers";
import { agentManagerConfigSelector } from "@/config";
import { selectSpinBreakerSettings } from "@/session/spin-breaker-selection";

describe("selectSpinBreakerSettings", () => {
  test("resolves concrete numbers from an empty config", () => {
    expect(selectSpinBreakerSettings(undefined)).toEqual({
      enabled: true,
      nudgeAfterRepeats: 25,
      maxNudges: 3,
      stopAfterRepeats: 50,
      recentKeyWindow: 64,
    });
  });

  test("honours overrides", () => {
    const config = agentManagerConfigSelector.select(
      makeNaxConfig({ agent: { spinBreaker: { nudgeAfterRepeats: 10, stopAfterRepeats: 20, maxNudges: 2 } } }),
    );

    const resolved = selectSpinBreakerSettings(config);

    expect(resolved.nudgeAfterRepeats).toBe(10);
    expect(resolved.stopAfterRepeats).toBe(20);
    expect(resolved.maxNudges).toBe(2);
  });
});
```

- [ ] **Step 2: Write the failing loop test**

Create `test/unit/agents/native/session/turn-loop-spin.test.ts`. Model the `TurnDeps`/`SendTurnOpts` construction on the existing native turn-loop suites under `test/unit/agents/native/session/` — reuse their transcript-dir setup helper rather than re-implementing it.

```ts
import { describe, expect, test } from "bun:test";
import { DEFAULT_SPIN_BREAKER_SETTINGS } from "@/runtime";

describe("runNativeTurn — spin breaker", () => {
  test("ends the turn with spinStopped once the breaker stops it", async () => {
    // A model that asks for the same RunCommand forever.
    const complete = async () => ({
      text: "",
      toolCalls: [{ id: "c1", name: "RunCommand", input: { command: "testScoped" } }],
      usage: { inputTokens: 1, outputTokens: 1 },
    });

    const result = await runTurnWithSpin({
      complete,
      spinBreaker: { ...DEFAULT_SPIN_BREAKER_SETTINGS, nudgeAfterRepeats: 3, stopAfterRepeats: 6, maxNudges: 1 },
    });

    expect(result.spinStopped).toBe(true);
    expect(result.turnIncomplete).toBe(true);
    expect(result.internalRoundTrips).toBeLessThan(10);
  });

  test("prepends the nudge to the real tool result instead of replacing it", async () => {
    const toolResults: string[] = [];
    const result = await runTurnWithSpin({
      complete: async () => ({
        text: "",
        toolCalls: [{ id: "c1", name: "RunCommand", input: { command: "testScoped" } }],
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
      onToolResult: (content: string) => toolResults.push(content),
      spinBreaker: { ...DEFAULT_SPIN_BREAKER_SETTINGS, nudgeAfterRepeats: 2, stopAfterRepeats: 5, maxNudges: 1 },
    });

    const nudged = toolResults.find((content) => content.includes("repeating work already done"));
    expect(nudged).toBeDefined();
    expect(nudged).toContain("29 tests passed");
    expect(result.spinStopped).toBe(true);
  });

  test("a varied sequence completes normally with no spin flag", async () => {
    let call = 0;
    const result = await runTurnWithSpin({
      complete: async () => {
        call += 1;
        if (call > 5) return { text: "done", usage: { inputTokens: 1, outputTokens: 1 } };
        return {
          text: "",
          toolCalls: [{ id: `c${call}`, name: "Read", input: { path: `src/f${call}.ts` } }],
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
      spinBreaker: { ...DEFAULT_SPIN_BREAKER_SETTINGS, nudgeAfterRepeats: 2, stopAfterRepeats: 4, maxNudges: 1 },
    });

    expect(result.spinStopped).toBeUndefined();
    expect(result.output).toBe("done");
  });
});
```

`runTurnWithSpin` is a local helper in this test file: it builds the transcript dir, a stub `interactionHandler` whose `onInteraction` returns `{ answer: "29 tests passed" }` (and forwards to `onToolResult` when supplied), and calls `runNativeTurn` with the supplied `complete` plus `spinBreaker` settings. Write it against the real signatures; do not mock `runNativeTurn` itself.

- [ ] **Step 3: Run both tests to verify they fail**

Run: `bun test test/unit/session/spin-breaker-selection.test.ts test/unit/agents/native/session/turn-loop-spin.test.ts --timeout=30000`
Expected: FAIL — `selectSpinBreakerSettings` does not exist, and `runNativeTurn` accepts no `spinBreaker`.

- [ ] **Step 4: Add the config schema**

In `src/config/schemas-infra.ts`, beside the idle-watchdog block:

```ts
export const DEFAULT_AGENT_SPIN_BREAKER_CONFIG: {
  enabled: boolean;
  nudgeAfterRepeats: number;
  maxNudges: number;
  stopAfterRepeats: number;
  recentKeyWindow: number;
} = {
  enabled: true,
  nudgeAfterRepeats: 25,
  maxNudges: 3,
  stopAfterRepeats: 50,
  recentKeyWindow: 64,
};

const AgentSpinBreakerConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    nudgeAfterRepeats: z.number().int().min(2).max(500).default(25),
    maxNudges: z.number().int().min(1).max(10).default(3),
    stopAfterRepeats: z.number().int().min(3).max(1000).default(50),
    recentKeyWindow: z.number().int().min(2).max(1024).default(64),
  })
  // A stop at or below the first nudge point would end turns with no warning
  // ever reaching the model, which is the opposite of the breaker's contract.
  .refine((cfg) => cfg.stopAfterRepeats > cfg.nudgeAfterRepeats, {
    message: "agent.spinBreaker.stopAfterRepeats must be greater than nudgeAfterRepeats",
    path: ["stopAfterRepeats"],
  });
```

Add to `AgentConfigSchema`:

```ts
  spinBreaker: AgentSpinBreakerConfigSchema.default(DEFAULT_AGENT_SPIN_BREAKER_CONFIG),
```

Export `DEFAULT_AGENT_SPIN_BREAKER_CONFIG` from `src/config/index.ts` next to `DEFAULT_AGENT_IDLE_WATCHDOG_CONFIG`.

In `src/config/runtime-types-agent.ts`:

```ts
/** Repetition breaker for an agent turn (nax#2013) */
export interface AgentSpinBreakerConfig {
  /** Master switch (default: true) */
  enabled?: boolean;
  /** Repeats since the last new call before the first nudge (default: 25) */
  nudgeAfterRepeats?: number;
  /** Nudges to spend before the hard stop (default: 3) */
  maxNudges?: number;
  /** Repeats since the last new call at which the turn ends (default: 50) */
  stopAfterRepeats?: number;
  /** How many recent distinct keys count as already seen (default: 64) */
  recentKeyWindow?: number;
}
```

and add `spinBreaker?: AgentSpinBreakerConfig;` to `AgentConfig`.

In `src/config/schemas.ts`, add to the `agent` default block:

```ts
      spinBreaker: {
        enabled: true,
        nudgeAfterRepeats: 25,
        maxNudges: 3,
        stopAfterRepeats: 50,
        recentKeyWindow: 64,
      },
```

In `src/cli/config-descriptions.ts`:

```ts
  "agent.spinBreaker": "Repetition breaker — ends a turn that repeats tool calls with no progress (nax#2013)",
  "agent.spinBreaker.enabled": "Enable the repetition breaker (default: true)",
  "agent.spinBreaker.nudgeAfterRepeats": "Repeats since the last new call before the first in-band nudge (default: 25)",
  "agent.spinBreaker.maxNudges": "Nudges to spend before the hard stop (default: 3)",
  "agent.spinBreaker.stopAfterRepeats": "Repeats since the last new call at which the turn ends (default: 50)",
  "agent.spinBreaker.recentKeyWindow": "How many recent distinct calls count as already seen (default: 64)",
```

- [ ] **Step 5: Add the resolver**

Create `src/session/spin-breaker-selection.ts`:

```ts
/**
 * Resolves `agent.spinBreaker` once, at the wiring layer.
 *
 * Its own module rather than a field on `selectNativeTurnConfig` because the
 * breaker is transport-neutral by design (src/runtime/spin-breaker.ts) — only
 * its current consumer is native. `src/agents/native/` must not read NaxConfig
 * (check:adapter-no-config-import), so the resolved primitive is what crosses
 * the boundary.
 *
 * Always returns concrete numbers, matching the schema's own defaults, so a
 * hand-built NaxConfig that skipped zod parsing still gets a sane policy.
 */

import type { AgentManagerConfig } from "../config/selectors";
import { DEFAULT_SPIN_BREAKER_SETTINGS, type ResolvedSpinBreakerSettings } from "../runtime/spin-breaker";

export function selectSpinBreakerSettings(config: AgentManagerConfig | undefined): ResolvedSpinBreakerSettings {
  const cfg = config?.agent?.spinBreaker;
  return {
    enabled: cfg?.enabled ?? DEFAULT_SPIN_BREAKER_SETTINGS.enabled,
    nudgeAfterRepeats: cfg?.nudgeAfterRepeats ?? DEFAULT_SPIN_BREAKER_SETTINGS.nudgeAfterRepeats,
    maxNudges: cfg?.maxNudges ?? DEFAULT_SPIN_BREAKER_SETTINGS.maxNudges,
    stopAfterRepeats: cfg?.stopAfterRepeats ?? DEFAULT_SPIN_BREAKER_SETTINGS.stopAfterRepeats,
    recentKeyWindow: cfg?.recentKeyWindow ?? DEFAULT_SPIN_BREAKER_SETTINGS.recentKeyWindow,
  };
}
```

Import from `../runtime/spin-breaker` directly, not the `@/runtime` barrel, to avoid widening the session → runtime import surface (`bun run check:import-cycles` is the arbiter; if it objects, follow what the existing `turn-config-selection.ts` imports do).

- [ ] **Step 6: Thread it to the adapter**

In `src/agents/session-types.ts`, add to `OpenSessionOpts` beside `transportRetry`:

```ts
  /**
   * Native: resolved repetition-breaker settings (nax#2013), threaded the same
   * way as `compaction` and `transportRetry` — a resolved primitive, never
   * NaxConfig. ACP ignores it; its loop is bounded by `maxInteractions`.
   */
  spinBreaker?: import("../runtime/spin-breaker").ResolvedSpinBreakerSettings;
```

In `src/session/manager.ts`, at the `openSession` call that already spreads `selectNativeTurnConfig(...)`:

```ts
      spinBreaker: selectSpinBreakerSettings(opts.config ?? this._config),
```

In `src/agents/native/session/session.ts`, add the map beside `nativeSessionTransportRetry`, with the same lifecycle:

```ts
/**
 * Session name -> resolved spin-breaker settings (nax#2013). Same lifecycle as
 * `nativeSessionTransportRetry`: set on open, cleared on close.
 */
export const nativeSessionSpinBreaker = new Map<string, ResolvedSpinBreakerSettings>();
```

Set it in `openNativeSession` next to the `transportRetry` line, and delete it in `closeNativeSession` next to the matching `delete`.

In `src/agents/native/adapter.ts`, inside `sendTurn`, pass it through to `runNativeTurn`:

```ts
        ...(nativeSessionSpinBreaker.get(handle.id) !== undefined
          ? { spinBreaker: nativeSessionSpinBreaker.get(handle.id) }
          : {}),
```

- [ ] **Step 7: Consult the breaker in the loop**

In `src/agents/native/session/turn-loop.ts`, import the breaker by its **leaf** path, never the `@/runtime` barrel — `turn-events.ts` imports `@/runtime/agent-stream-events` the same way, and routing a native module through the parent barrel is how a latent module-init cycle becomes a `ReferenceError`:

```ts
import { createSpinBreaker, type ResolvedSpinBreakerSettings } from "@/runtime/spin-breaker";
```

Then add to `TurnDeps`:

```ts
  /**
   * Resolved repetition-breaker settings (nax#2013). Absent disables the
   * breaker — the pre-#2013 behaviour of an unbounded call count.
   */
  spinBreaker?: ResolvedSpinBreakerSettings;
```

Before the loop, beside the other accumulators:

```ts
  const spinBreaker = deps.spinBreaker !== undefined ? createSpinBreaker(deps.spinBreaker) : undefined;
  // Set ONLY when the breaker ended the turn, so the wiring layer can classify
  // it as `fail-spin` rather than a generic incomplete turn.
  let spinStopped = false;
```

Add the consultation inside `for (const call of res.toolCalls)`, placed **after** the `ASK_HUMAN_TOOL_NAME` branch and immediately before the `const kind = codingToolNames.has(call.name) ? ... ` line. Placement matters: the ask_human branch ends in `continue`, so observing before it would compute a nudge that is then silently dropped, and human Q&A is budgeted separately by `maxInteractions` anyway — it is not the repetition this breaker is for.

```ts
          const verdict = spinBreaker?.observe(call.name, call.input) ?? { action: "allow" as const };
          if (verdict.action === "stop") {
            spinStopped = true;
            // The call is deliberately NOT executed and NOT answered: the turn
            // is over, and a tool-result for a call nobody will read only grows
            // the transcript the retry drops anyway.
            break;
          }
```

That `break` leaves the `for` over this round trip's tool calls. The `while` needs its own exit, so add one directly after the `for` loop closes, in the `while` body:

```ts
      if (spinStopped) break;
```

Two plain breaks rather than a labelled one: `src/` contains no labelled loop anywhere, and this `while` already has several plain `break` exits, so a label would be the only one in the codebase.

Update the loop's doc comment to name the third exit:

```ts
    // Deliberately unbounded by COUNT of varied calls. A coding agent working a
    // story is bounded by wall clock (deps.deadline), by the idle watchdog, and
    // — since nax#2013 — by the spin breaker, which ends a turn that keeps
    // REPEATING a call it already made. `agent.maxInteractionTurns` is NOT this
    // budget — it bounds human Q&A exchanges, which are counted separately.
```

Then carry a `nudge` into the tool result. The existing coding-tool branch ends with one `messages.push`; prepend the nudge there rather than replacing the answer:

```ts
          const answerText = answer?.answer ?? "";
          messages.push({
            role: "tool-result",
            toolCallId: call.id,
            content:
              verdict.action === "nudge" ? `[nax] ${verdict.text}\n\n---\n\n${answerText}` : answerText,
          });
```

The nudge is prepended, not substituted, and `isError` stays unset: a nudge that reads as a tool failure invites a retry, and withholding the data the model asked for invites a re-run. Apply the same treatment to the `answer?.denied` branch directly above, which has its own `messages.push`.

Finally, report the fact on the result, beside `timedOut`:

```ts
    ...(spinStopped ? { spinStopped: true as const } : {}),
```

and log the summary where the `!completedNormally` warning already fires:

```ts
  if (spinStopped) {
    getSafeLogger()?.error("native-adapter", "turn ended by the spin breaker", {
      sessionName: handle.id,
      roundTrips,
      ...spinBreaker?.summary(),
    });
  }
```

`spinStopped` implies `!completedNormally`, so `turnIncomplete` is already set by the existing spread — no change needed there.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `bun test test/unit/session/spin-breaker-selection.test.ts test/unit/agents/native/ --timeout=30000`
Expected: PASS.

- [ ] **Step 9: Run the full gates and the boundary checks**

Run: `bun run check:adapter-no-config-import && bun run check:nax-ai-imports && bun run check:import-cycles && bun run lint && bun run typecheck && bun run test`
Expected: all pass. The adapter check is the one that matters most here — it fails if the threading accidentally imports config into `src/agents/native/`.

- [ ] **Step 10: Run the coverage gate**

Run: `bun run test:coverage`
Expected: pass. Tasks 5 and 7 add new files, and `check-coverage.ts` enforces a per-file floor — new source files need their own coverage, and the gate is not part of the normal suite. If a new file is below the floor, add the missing cases; do not re-baseline (`--update-baseline` bakes in local numbers and drops files CI still grandfathers).

- [ ] **Step 11: Commit**

```bash
git add src/config/schemas-infra.ts src/config/runtime-types-agent.ts src/config/schemas.ts \
  src/config/index.ts src/cli/config-descriptions.ts src/session/spin-breaker-selection.ts \
  src/session/manager.ts src/agents/session-types.ts src/agents/native/session/session.ts \
  src/agents/native/adapter.ts src/agents/native/session/turn-loop.ts \
  test/unit/session/spin-breaker-selection.test.ts \
  test/unit/agents/native/session/turn-loop-spin.test.ts
git commit -m "feat(native): end a turn that repeats tool calls with no progress (#2013)"
```

---

## Documentation

- [ ] **Final step: reconcile the design doc with the two plan refinements**

Update `docs/superpowers/specs/2026-09-12-spin-breaker-design.md`:
- §4 US-004 — the narrowing is applied by rewriting the grants before `compileToolPolicy`, not by a second check after `policy.check`. The invariant (narrowing only) is unchanged; the mechanism is simpler and keeps one matcher.
- §4 US-004 — staleness is guarded by deleting the verdict file before dispatch, not by comparing `lastModified` against the dispatch time.
- §4 US-001 — threshold validation lives in the Zod schema's `.refine()`, not `config-guards.ts`, which is for rejecting *removed* keys with a migration hint.

```bash
git add docs/superpowers/specs/2026-09-12-spin-breaker-design.md
git commit -m "docs: reconcile the spin-breaker design with the implementation refinements (#2013)"
```
