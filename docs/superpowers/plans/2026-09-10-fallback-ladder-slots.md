# Fallback Ladder Slots Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a story walk its fallback ladder to the end across every operation it runs, on any transport, with warm implementer-family operations sticking to the endpoint the story swapped to.

**Architecture:** Four coupled changes. (1) `SessionManager`'s live-handle cache becomes endpoint-aware, so a re-open with a different model actually re-opens. (2) Every hop reports the endpoint it *actually dispatched*, and that endpoint — not the tier the `HopKind` happened to declare — is what cooldown marking and candidate exclusion key on. (3) A per-`(story, tier, agent, role)` ladder slot holds the target **and** its ladder index, replacing the per-story swap-event counter. (4) `agent.fallback.map` rungs are validated against the `agent.protocol` gate at config load.

**Tech Stack:** TypeScript, Bun test, Zod config schemas.

**Spec:** `docs/superpowers/specs/2026-09-10-fallback-ladder-slots-design.md`

## Global Constraints

- **File-size ratchet is hard.** `bun run check:file-sizes` must pass and `scripts/baselines/` must show **zero diff** on this branch. Limits: 600 lines for `src/**/*.ts`, 800 for `test/**/*.test.ts`. `src/session/manager.ts` is grandfathered at **679** and may not grow by a single line; `src/operations/build-hop-callback.ts` is at exactly **600**. Every task that touches those two files must be net-neutral or net-negative there.
- **Every log call carries `storyId`** (enforced by `bun run check:logger-storyid`).
- **Test casts are gated, and the gates are hard errors.** In `test/**`: `as never` is banned (`biome-plugins/no-as-never.grit`), `as unknown as` is ratcheted at **0** (`check:test-as-unknown-as`), `any` and `!` non-null assertions are biome errors, and `@ts-expect-error` is baselined at 0. Build typed fixtures instead — `makeNaxConfig`, `makeMockCallContext`, `makeMockRuntime`, `makeAgentAdapter` from `@test/helpers`, and plain typed literals for `AdapterFailure` / `AgentRunOptions` (see `test/unit/agents/manager-swap-loop.test.ts` for the house pattern). A single `as T` is counted but permitted; use it only where no typed construction exists.
- `AgentManager`'s first constructor parameter is `AgentManagerConfig`, which `makeNaxConfig()`'s `NaxConfig` satisfies structurally — no cast needed. `AgentRunRequest.bundle` is optional; omit it rather than faking a `ContextBundle`.
- **Conventional commits**, no attribution footer.
- Full gate before the branch is done: `bun run lint && bun run typecheck && bun run test`.
- Endpoint identity is `ModelDef.provider` + `ModelDef.model`. `pricing`, `contextWindow` and `env` are metadata and never part of identity.
- Ladder depth is an **index**: 0 = the configured primary, 1..n = `agent.fallback.map[<primary>]` rung positions. `maxHopsPerStory` is the maximum reachable index (default 2).

---

### Task 1: Endpoint-aware session cache

Closes #1965. `SessionManager.openSessionImpl` returns a cached handle whenever the agent name matches, discarding `opts.modelDef` — so a same-agent swap, and any op inheriting a sticky endpoint, dispatches the previous model.

**Files:**
- Create: `src/session/endpoint-identity.ts`
- Modify: `src/session/manager.ts:435-444` (net-negative), `src/agents/session-types.ts:37-42` (comment only)
- Test: `test/unit/session/endpoint-identity.test.ts`, `test/unit/session/manager-endpoint-reuse.test.ts`

**Interfaces:**
- Consumes: `SessionHandle` (`src/agents/session-types.ts`), `SessionDescriptor` (`src/session/types.ts`), `ModelDef` (`src/config/schema-types.ts`).
- Produces: `decideReuse(live, descriptor, requested): ReuseDecision` and `sameEndpoint(a, b): boolean` from `src/session/endpoint-identity.ts`. Task 8 relies on the observable behaviour: a same-name re-open with a different endpoint yields a handle carrying the new `modelDef`.

- [ ] **Step 1: Write the failing test for the pure decision**

Create `test/unit/session/endpoint-identity.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { SessionHandle } from "@/agents/session-types";
import type { ModelDef } from "@/config/schema-types";
import { decideReuse, sameEndpoint } from "@/session/endpoint-identity";
import type { SessionDescriptor } from "@/session/types";

const model = (id: string, provider = "p"): ModelDef => ({ provider, model: id });

const handle = (agentName: string, modelDef: ModelDef): SessionHandle => ({ id: "nax-x", agentName, modelDef });

const desc = (state: SessionDescriptor["state"]): SessionDescriptor => ({
  id: "sess-1",
  role: "implementer",
  state,
  agent: "native",
  workdir: "/w",
  protocolIds: { recordId: null, sessionId: null },
  completedStages: [],
  createdAt: "2026-09-10T00:00:00.000Z",
  lastActivityAt: "2026-09-10T00:00:00.000Z",
});

describe("sameEndpoint()", () => {
  test("provider and model both equal", () => {
    expect(sameEndpoint(model("m", "a"), model("m", "a"))).toBe(true);
  });

  test("different model id", () => {
    expect(sameEndpoint(model("m1"), model("m2"))).toBe(false);
  });

  test("different provider", () => {
    expect(sameEndpoint(model("m", "a"), model("m", "b"))).toBe(false);
  });

  test("metadata is not identity", () => {
    expect(sameEndpoint({ provider: "a", model: "m", contextWindow: 1 }, { provider: "a", model: "m" })).toBe(true);
  });

  test("an unrecorded endpoint never matches a recorded one", () => {
    expect(sameEndpoint(undefined, model("m"))).toBe(false);
  });
});

describe("decideReuse()", () => {
  test("no live handle -> reopen", () => {
    expect(decideReuse(undefined, undefined, { agentName: "native", modelDef: model("m") })).toBe("reopen");
  });

  test("terminal descriptor -> reopen (adapter session already closed)", () => {
    const live = handle("native", model("m"));
    expect(decideReuse(live, desc("COMPLETED"), { agentName: "native", modelDef: model("m") })).toBe("reopen");
  });

  test("same agent, same endpoint -> reuse", () => {
    const live = handle("native", model("m"));
    expect(decideReuse(live, desc("RUNNING"), { agentName: "native", modelDef: model("m") })).toBe("reuse");
  });

  test("same agent, different endpoint -> close-then-reopen", () => {
    const live = handle("native", model("minimax/MiniMax-M3"));
    const requested = { agentName: "native", modelDef: model("opencode-go/deepseek-v4-flash[high]") };
    expect(decideReuse(live, desc("RUNNING"), requested)).toBe("close-then-reopen");
  });

  test("different agent -> close-then-reopen (no orphaned acpx process)", () => {
    const live = handle("claude", model("sonnet"));
    expect(decideReuse(live, desc("RUNNING"), { agentName: "native", modelDef: model("m") })).toBe("close-then-reopen");
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `bun test test/unit/session/endpoint-identity.test.ts`
Expected: FAIL — `Cannot find module '@/session/endpoint-identity'`.

- [ ] **Step 3: Write the module**

Create `src/session/endpoint-identity.ts`:

```ts
/**
 * Should an open request reuse the live handle cached under its session name?
 *
 * Its own module because `manager.ts` is a grandfathered oversized file that may
 * not grow, and because the decision is pure over its inputs — which is what makes
 * it testable without a SessionManager, an adapter, or a descriptor store.
 *
 * nax#1965: the cache was keyed on session name + agent name only, so a same-agent
 * hop (a `{agent: native, tier: powerful}` fallback rung, or an op inheriting a
 * story's sticky endpoint) got back the handle the PREVIOUS endpoint opened and
 * dispatched that model. A cross-agent hop escaped only because the agent name
 * differed — which is why the defect looked transport-specific in the field.
 */

import type { SessionHandle } from "../agents/session-types";
import type { ModelDef } from "../config/schema-types";
import type { SessionDescriptor } from "./types";

export type ReuseDecision =
  /** Serve the cached handle — same agent, same endpoint, session still live. */
  | "reuse"
  /** Tear the live session down first: a different agent or a different endpoint. */
  | "close-then-reopen"
  /** Nothing live to tear down (or the adapter session is already gone). */
  | "reopen";

/**
 * Endpoint identity is provider + model id. `pricing`, `contextWindow` and `env`
 * are attribution/transport metadata that two dispatches to the same endpoint may
 * legitimately differ on. An absent `modelDef` never matches a present one: an
 * unrecorded endpoint is unknown, not equal.
 */
export function sameEndpoint(a: ModelDef | undefined, b: ModelDef | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  return a.provider === b.provider && a.model === b.model;
}

export function decideReuse(
  live: SessionHandle | undefined,
  descriptor: SessionDescriptor | undefined,
  requested: { readonly agentName: string; readonly modelDef: ModelDef },
): ReuseDecision {
  if (!live) return "reopen";
  // Terminal descriptor: `keepOpen` left the handle cached but closeSession already
  // ran, so the adapter session is gone. Drop the handle, do NOT close it again.
  if (descriptor && (descriptor.state === "COMPLETED" || descriptor.state === "FAILED")) return "reopen";
  if (live.agentName !== requested.agentName) return "close-then-reopen";
  return sameEndpoint(live.modelDef, requested.modelDef) ? "reuse" : "close-then-reopen";
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `bun test test/unit/session/endpoint-identity.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Write the failing SessionManager test**

Create `test/unit/session/manager-endpoint-reuse.test.ts`:

```ts
import { describe, expect, mock, test } from "bun:test";
import { makeAgentAdapter } from "@test/helpers";
import type { OpenSessionOpts, SessionHandle } from "@/agents/types";
import { SessionManager } from "@/session/manager";
import type { OpenSessionRequest } from "@/session/types";

const WORKDIR = "/tmp/nax-endpoint-reuse";
const NAME = "nax-endpoint-reuse-implementer";

function request(modelId: string, agentName = "native"): OpenSessionRequest {
  return {
    agentName,
    role: "implementer",
    workdir: WORKDIR,
    pipelineStage: "run",
    modelDef: { provider: modelId.split("/")[0] ?? "unknown", model: modelId },
    timeoutSeconds: 30,
  };
}

/** Adapter that echoes the endpoint it was opened with, and counts closes. */
function tracked() {
  const opened: OpenSessionOpts[] = [];
  const closed: SessionHandle[] = [];
  const adapter = makeAgentAdapter({
    openSession: mock(async (name: string, opts: OpenSessionOpts): Promise<SessionHandle> => {
      opened.push(opts);
      return { id: name, agentName: opts.agentName, modelDef: opts.modelDef };
    }),
    closeSession: mock(async (handle: SessionHandle) => {
      closed.push(handle);
    }),
  });
  return { adapter, opened, closed };
}

describe("SessionManager endpoint-aware reuse (nax#1965)", () => {
  test("a same-agent re-open with a different model dispatches the new model", async () => {
    const { adapter, opened } = tracked();
    const sm = new SessionManager({ getAdapter: () => adapter });

    await sm.openSession(NAME, request("minimax/MiniMax-M3"));
    const hop1 = await sm.openSession(NAME, request("opencode-go/deepseek-v4-flash[high]"));

    expect(hop1.modelDef?.model).toBe("opencode-go/deepseek-v4-flash[high]");
    expect(opened).toHaveLength(2);
  });

  test("it closes the previous physical session rather than orphaning it", async () => {
    const { adapter, closed } = tracked();
    const sm = new SessionManager({ getAdapter: () => adapter });

    await sm.openSession(NAME, request("minimax/MiniMax-M3"));
    await sm.openSession(NAME, request("opencode-go/deepseek-v4-flash[high]"));

    expect(closed).toHaveLength(1);
    expect(closed[0]?.modelDef?.model).toBe("minimax/MiniMax-M3");
  });

  test("a cross-agent re-open closes the prior handle (acp -> native leak)", async () => {
    const { adapter, closed } = tracked();
    const sm = new SessionManager({ getAdapter: () => adapter });

    await sm.openSession(NAME, request("sonnet[medium]", "claude"));
    const hop1 = await sm.openSession(NAME, request("minimax/MiniMax-M3", "native"));

    expect(hop1.agentName).toBe("native");
    expect(closed).toHaveLength(1);
    expect(closed[0]?.agentName).toBe("claude");
  });

  test("an unchanged endpoint still reuses the live handle", async () => {
    const { adapter, opened, closed } = tracked();
    const sm = new SessionManager({ getAdapter: () => adapter });

    const first = await sm.openSession(NAME, request("minimax/MiniMax-M3"));
    const second = await sm.openSession(NAME, request("minimax/MiniMax-M3"));

    expect(second).toBe(first);
    expect(opened).toHaveLength(1);
    expect(closed).toHaveLength(0);
  });

  test("the single-flight guard survives a close-then-reopen", async () => {
    const { adapter } = tracked();
    const sm = new SessionManager({ getAdapter: () => adapter });

    await sm.openSession(NAME, request("minimax/MiniMax-M3"));
    await sm.openSession(NAME, request("opencode-go/deepseek-v4-flash[high]"));

    // A third open must still be permitted: the busy marker was re-armed and then
    // released, not left set by the intermediate closeSession.
    await expect(sm.openSession(NAME, request("openrouter/z-ai/glm-5.3-flash[high]"))).resolves.toBeDefined();
  });
});
```

- [ ] **Step 6: Run it and confirm it fails on the real defect**

Run: `bun test test/unit/session/manager-endpoint-reuse.test.ts`
Expected: FAIL — first test reports `Expected: "opencode-go/deepseek-v4-flash[high]" / Received: "minimax/MiniMax-M3"`. The fourth test ("unchanged endpoint") passes already; that is the control.

- [ ] **Step 7: Wire the decision into SessionManager**

In `src/session/manager.ts`, add the import beside the existing `selectModel` import:

```ts
import { decideReuse } from "./endpoint-identity";
```

Replace the cache block at the top of `openSessionImpl` (currently lines 436-444) with:

```ts
    const liveHandle = this._liveHandles.get(name);
    const reuse = decideReuse(liveHandle, this._findByName(name), opts);
    if (liveHandle && reuse === "reuse") return liveHandle;
    if (liveHandle && reuse === "close-then-reopen") {
      // closeSession clears _busySessions for this name; openSession set that marker
      // as its single-flight guard and still needs it for the rest of this open.
      await this.closeSession(liveHandle);
      this._busySessions.add(name);
    } else if (liveHandle) this._liveHandles.delete(name);
```

- [ ] **Step 8: Amend the stale `modelDef` doc comment**

In `src/agents/session-types.ts`, the `SessionHandle.modelDef` comment ends "Attribution only; never branch on it." Replace that sentence with:

```
   * Attribution, and the session's endpoint identity: `decideReuse`
   * (session/endpoint-identity.ts) compares it to decide whether a re-open under
   * the same session name may serve this handle, and the native adapter's
   * `sendTurn` dispatches from it. Do not branch on it for anything else.
```

- [ ] **Step 9: Run both test files and the size gate**

Run: `bun test test/unit/session/ && bun run check:file-sizes`
Expected: all PASS; the size gate reports no growth — `src/session/manager.ts` is 678 or fewer lines (verify with `wc -l src/session/manager.ts`, it must not exceed 679).

- [ ] **Step 10: Commit**

```bash
git add src/session/endpoint-identity.ts src/session/manager.ts src/agents/session-types.ts test/unit/session/endpoint-identity.test.ts test/unit/session/manager-endpoint-reuse.test.ts
git commit -m "fix(session): re-open a session when its endpoint changes (#1965)"
```

---

### Task 2: Extract hop model resolution

Pure refactor with no behaviour change. It pays the line budget `build-hop-callback.ts` needs in Task 3, and creates the seam that reports the dispatched endpoint.

**Files:**
- Create: `src/operations/hop-endpoint.ts`
- Modify: `src/operations/build-hop-callback.ts:398-432` and `:439-463` (net-negative)
- Test: `test/unit/operations/hop-endpoint.test.ts`

**Interfaces:**
- Consumes: `HopKind` (`src/agents/manager-types.ts`), `ModelDef`, `ModelsConfig`.
- Produces: `resolveHopEndpoint(args): HopEndpoint` where `interface HopEndpoint { readonly modelDef: ModelDef; readonly modelTier?: string }`, plus `hopTier` and `hopModelId`, **moved** here from `build-hop-callback.ts`. Task 3 returns `HopEndpoint` from the hop callback.

**Import-cycle constraint:** `hop-endpoint.ts` must NOT import from `build-hop-callback.ts` — that file imports `resolveHopEndpoint`, so the pair would form a two-module cycle and `bun run check:import-cycles` compares against a baseline of 135 modules that #1970 brought down to 132. `hopTier` and `hopModelId` therefore *move* into `hop-endpoint.ts`, and `build-hop-callback.ts` re-exports them so the existing import in `test/unit/operations/build-hop-callback-tier.test.ts` keeps working.

- [ ] **Step 1: Write the failing test**

Create `test/unit/operations/hop-endpoint.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { ModelsConfig } from "@/config/schema-types";
import type { AdapterFailure } from "@/context/engine";
import { resolveHopEndpoint } from "@/operations/hop-endpoint";

const MODELS: ModelsConfig = {
  native: { balanced: "minimax/MiniMax-M3", powerful: "opencode-go/deepseek-v4-flash[high]" },
};

const FAILURE: AdapterFailure = {
  category: "availability",
  outcome: "fail-rate-limit",
  retriable: true,
  message: "429",
};

const base = {
  models: MODELS,
  agentName: "native",
  effectiveTier: "balanced",
  defaultAgent: "native",
};

describe("resolveHopEndpoint()", () => {
  test("a caller-pinned primary keeps the pin and reports no tier", () => {
    const pin = { provider: "minimax", model: "minimax/MiniMax-M3" };
    const out = resolveHopEndpoint({ ...base, hopKind: { kind: "primary" }, pinnedModelDef: pin });
    expect(out.modelDef).toBe(pin);
    expect(out.modelTier).toBeUndefined();
  });

  test("a swap hop ignores the caller's pin and resolves its own tier", () => {
    const pin = { provider: "minimax", model: "minimax/MiniMax-M3" };
    const out = resolveHopEndpoint({
      ...base,
      hopKind: { kind: "swap", failure: FAILURE, tier: "powerful" },
      pinnedModelDef: pin,
    });
    expect(out.modelDef.model).toBe("opencode-go/deepseek-v4-flash[high]");
    expect(out.modelTier).toBe("powerful");
  });

  test("a swap hop with a literal pin resolves that id and reports no tier", () => {
    const out = resolveHopEndpoint({
      ...base,
      hopKind: { kind: "swap", failure: FAILURE, model: "openrouter/z-ai/glm-5.3-flash[high]" },
      pinnedModelDef: undefined,
    });
    expect(out.modelDef.model).toBe("openrouter/z-ai/glm-5.3-flash[high]");
    expect(out.modelTier).toBeUndefined();
  });

  test("a stale-retry keeps the caller's pin — it is the same session's model", () => {
    const pin = { provider: "minimax", model: "minimax/MiniMax-M3" };
    const out = resolveHopEndpoint({
      ...base,
      hopKind: { kind: "stale-retry", attempt: 1 },
      pinnedModelDef: pin,
    });
    expect(out.modelDef).toBe(pin);
  });

  test("an unpinned primary resolves the effective tier and reports it", () => {
    const out = resolveHopEndpoint({ ...base, hopKind: { kind: "primary" }, pinnedModelDef: undefined });
    expect(out.modelDef.model).toBe("minimax/MiniMax-M3");
    expect(out.modelTier).toBe("balanced");
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `bun test test/unit/operations/hop-endpoint.test.ts`
Expected: FAIL — `Cannot find module '@/operations/hop-endpoint'`.

- [ ] **Step 3: Write the module**

Create `src/operations/hop-endpoint.ts`:

```ts
/**
 * The endpoint one hop dispatches to, and the tier (if any) that selected it.
 *
 * Extracted from build-hop-callback.ts, which is at the 600-line hard limit. It is
 * also the seam nax#1965 needed: the value returned here is what the hop REPORTS
 * back, so cooldown marking and candidate exclusion key on the endpoint that
 * actually dispatched rather than on whatever tier the HopKind happened to declare
 * (a config-default primary declares none).
 */

import { resolveModel, resolveModelForAgent } from "@/config";
import type { ModelDef, ModelsConfig } from "@/config/schema-types";
import type { HopKind } from "../agents/manager-types";

/** The tier a hop dispatches at: the one it named, else the caller's effective tier. */
export function hopTier(hopKind: HopKind, effectiveTier: string): string {
  return "tier" in hopKind ? (hopKind.tier ?? effectiveTier) : effectiveTier;
}

/** A hop's LITERAL model pin, when it carries one. Mutually exclusive with `tier`. */
export function hopModelId(hopKind: HopKind): string | undefined {
  return "model" in hopKind ? hopKind.model : undefined;
}

export interface HopEndpoint {
  readonly modelDef: ModelDef;
  /** Only when a tier selected the model. A pin of either kind reports none (#1433). */
  readonly modelTier?: string;
}

export interface HopEndpointArgs {
  readonly hopKind: HopKind;
  /** The caller's pinned model, already narrowed to this agent (nax#1722). */
  readonly pinnedModelDef: ModelDef | undefined;
  readonly models: ModelsConfig | undefined;
  readonly agentName: string;
  readonly effectiveTier: string;
  readonly defaultAgent: string;
}

/**
 * A caller pin wins on a `primary` hop (it is what the caller asked for) and on a
 * `stale-retry` (same session, same model — the retry must not change endpoints).
 * A `swap` or `timeout-retry` has chosen its own target, so the pin is dropped.
 */
function pinWins(kind: HopKind["kind"]): boolean {
  return kind === "primary" || kind === "stale-retry";
}

export function resolveHopEndpoint(args: HopEndpointArgs): HopEndpoint {
  const { hopKind, pinnedModelDef, models, agentName, effectiveTier, defaultAgent } = args;
  if (pinnedModelDef !== undefined && pinWins(hopKind.kind)) return { modelDef: pinnedModelDef };

  const pin = hopModelId(hopKind);
  if (pin) return { modelDef: resolveModel(pin) };

  const tier = hopTier(hopKind, effectiveTier);
  return { modelDef: resolveModelForAgent(models, agentName, tier, defaultAgent), modelTier: tier };
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `bun test test/unit/operations/hop-endpoint.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Use it from both branches of build-hop-callback**

In `src/operations/build-hop-callback.ts`: delete the `hopTier` and `hopModelId` function bodies (lines 125-141, comments included), and replace them with a re-export so existing importers are unaffected:

```ts
import { hopModelId, hopTier, resolveHopEndpoint } from "./hop-endpoint";

// Re-exported from their new home so existing importers (and
// test/unit/operations/build-hop-callback-tier.test.ts) are unaffected.
export { hopModelId, hopTier };
```

In the **stale-retry cache-miss branch** replace the `hopPin`/`modelDef` resolution and the `modelTier` spread (currently lines 411-416 and 428) with:

```ts
        const endpoint = resolveHopEndpoint({
          hopKind,
          pinnedModelDef,
          models: config.models,
          agentName,
          effectiveTier,
          defaultAgent,
        });
```

and pass `modelDef: endpoint.modelDef,` plus `...(endpoint.modelTier ? { modelTier: endpoint.modelTier } : {}),`.

In the **primary/swap branch** replace `pinned`, `tier`, `hopPin`, `resolveForHop` and `modelDef` (currently lines 440-451) and the `modelTier` spread (line 462) with the same two lines, using the same `endpoint` variable name.

- [ ] **Step 6: Prove the refactor changed nothing**

Run: `bun test test/unit/operations/ test/unit/agents/ && bun run check:import-cycles && wc -l src/operations/build-hop-callback.ts`
Expected: all PASS; `check:import-cycles` reports no growth against its baseline; `build-hop-callback.ts` is at most 575 lines (it was 600 — roughly 25 lines from the two resolution blocks plus ~13 from the moved helpers, less the re-export).

- [ ] **Step 7: Commit**

```bash
git add src/operations/hop-endpoint.ts src/operations/build-hop-callback.ts test/unit/operations/hop-endpoint.test.ts
git commit -m "refactor(operations): extract hop endpoint resolution"
```

---

### Task 3: Report and mark the dispatched endpoint

A hop currently marks its cooldown with the tier/model its `HopKind` declared, which is `undefined` for a config-default primary — so the mark lands on the bare-agent key with no endpoint identity, and `CooldownStore._live` then refuses to let it match any narrower lookup.

**Files:**
- Modify: `src/agents/manager-types.ts:109-114` (`executeHop` return type), `src/operations/build-hop-callback.ts` (return the endpoint), `src/agents/manager-run-fallback.ts:190-192, 269-284`
- Test: `test/unit/agents/hop-endpoint-marking.test.ts`

**Interfaces:**
- Consumes: `HopEndpoint` from Task 2.
- Produces: `executeHop` resolves `{ result, bundle, prompt?, endpoint? }`; `runWithFallback` marks and excludes with `endpoint.modelDef.model`. Task 6 relies on the same value reaching `nextCandidate`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/agents/hop-endpoint-marking.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { makeNaxConfig } from "@test/helpers";
import type { AgentRunOptions } from "@/agents";
import { AgentManager } from "@/agents";
import { DEFAULT_CONFIG } from "@/config";
import { agentManagerConfigSelector } from "@/config/selectors";
import type { AdapterFailure } from "@/context/engine";

const RATE_LIMIT: AdapterFailure = {
  category: "availability",
  outcome: "fail-rate-limit",
  retriable: true,
  message: "429",
};

function ladderConfig() {
  return makeNaxConfig({
    agent: {
      default: "native",
      protocol: "hybrid",
      fallback: {
        enabled: true,
        map: { native: [{ agent: "native", model: "powerful" }, "claude"] },
        maxHopsPerStory: 2,
        onQualityFailure: false,
        rebuildContext: false,
      },
    },
    models: { native: { balanced: "minimax/MiniMax-M3", powerful: "opencode-go/deepseek-v4-flash[high]" } },
  });
}

function runOptions(): AgentRunOptions {
  return {
    prompt: "p",
    workdir: "/tmp",
    modelTier: "balanced",
    modelDef: { provider: "unknown", model: "minimax/MiniMax-M3" },
    timeoutSeconds: 60,
    storyId: "US-1",
    config: agentManagerConfigSelector.select(DEFAULT_CONFIG),
  };
}

describe("a failed hop marks the endpoint it dispatched", () => {
  test("a tier-less primary that dispatched balanced cools balanced, not the whole agent", async () => {
    const config = ladderConfig();
    const mgr = new AgentManager(config, undefined, { models: config.models });
    const chain: string[] = [];

    await mgr.runWithFallback({
      runOptions: runOptions(),
      executeHop: async (agent, bundle, kind) => {
        chain.push(`${agent}:${kind.kind}`);
        const model = chain.length === 1 ? "minimax/MiniMax-M3" : "opencode-go/deepseek-v4-flash[high]";
        return {
          result: {
            success: false,
            exitCode: 1,
            output: "429",
            rateLimited: true,
            durationMs: 1,
            estimatedCostUsd: 0,
            adapterFailure: RATE_LIMIT,
          },
          bundle,
          endpoint: { modelDef: { provider: "unknown", model } },
        };
      },
    });

    // The primary's own endpoint is cooling, keyed on the model it dispatched...
    expect(mgr.isUnavailable("native", "balanced")).toBe(true);
    // ...as is the rung it swapped to — a DIFFERENT identity, not the same bare key.
    expect(mgr.isUnavailable("native", "powerful")).toBe(true);
    // And the ladder was still walked: the bare-agent key did not blanket it.
    expect(chain).toEqual(["native:primary", "native:swap", "claude:swap"]);
  });
});
```

The two `isUnavailable` assertions rely on tier lookups and literal-pin marks resolving to the same identity string. Verified: `resolveModelForAgent(models, "native", "balanced", "native")` and `resolveModel("minimax/MiniMax-M3")` both yield `unknown/minimax/MiniMax-M3`.

- [ ] **Step 2: Run it and confirm it fails**

Run: `bun test test/unit/agents/hop-endpoint-marking.test.ts`
Expected: FAIL — the hop chain is `["native:\"primary\"", "native:\"swap\"", "claude:\"swap\""]` only once marking is endpoint-truthful; before the change the second entry is present but `isUnavailable("native", "balanced")` is `false`, because the primary's mark carried no endpoint identity.

- [ ] **Step 3: Widen the executeHop contract**

In `src/agents/manager-types.ts`, change the `executeHop` return type to:

```ts
  executeHop?: (
    agentName: string,
    bundle: ContextBundle | undefined,
    hopKind: HopKind,
    resolvedRunOptions: AgentRunOptions,
  ) => Promise<{
    result: AgentResult;
    bundle: ContextBundle | undefined;
    prompt?: string;
    /**
     * The endpoint this hop actually dispatched. Cooldown marking and candidate
     * exclusion key on THIS, not on the tier/model the HopKind declared — a
     * config-default primary declares neither (nax#1965).
     */
    endpoint?: { readonly modelDef: import("../config/schema-types").ModelDef; readonly modelTier?: string };
  }>;
```

- [ ] **Step 4: Return the endpoint from the hop callback**

In `src/operations/build-hop-callback.ts`, the callback's return object gains `endpoint` alongside `result`/`bundle`/`prompt`. The `endpoint` value is the one Task 2's `resolveHopEndpoint` produced in the primary/swap branch; hoist that `const endpoint` so it is in scope at the return, and add `endpoint,` to the returned object.

- [ ] **Step 5: Thread it through executeHop and marking**

In `src/agents/manager-run-fallback.ts`, `executeHop` already spreads the hop object, so `endpoint` flows through unchanged. Immediately after the `const { result } = hop;` destructure, add:

```ts
      // The endpoint this hop dispatched — the identity a failure must be recorded
      // against. `currentHopKind.model` is a DECLARED literal pin and stays
      // authoritative when present; otherwise the dispatched model id is the truth.
      const dispatchedModel = currentHopKind.model ?? hop.endpoint?.modelDef.model;
```

Then change the mark/select pair (currently lines 191-192) to:

```ts
      const currentTier = currentHopKind.tier;
      input.markUnavailable(currentAgent, failure, currentTier, dispatchedModel);
      const next = input.nextCandidate(primaryAgent, hopsSoFar, currentAgent, currentTier, dispatchedModel);
```

- [ ] **Step 6: Run the tests**

Run: `bun test test/unit/agents/ test/unit/operations/`
Expected: PASS, including the new file.

- [ ] **Step 7: Commit**

```bash
git add src/agents/manager-types.ts src/agents/manager-run-fallback.ts src/operations/build-hop-callback.ts test/unit/agents/hop-endpoint-marking.test.ts
git commit -m "fix(agents): key cooldowns on the endpoint a hop dispatched"
```

---

### Task 4: The ladder slot

Pure logic, no wiring. A slot is the target a `(story, tier, agent, role)` landed on plus its ladder index.

**Files:**
- Create: `src/agents/ladder-slot.ts`
- Test: `test/unit/agents/ladder-slot.test.ts`

**Interfaces:**
- Consumes: `FallbackTarget` (`src/agents/swap-decision.ts`).
- Produces: `interface LadderSlot { readonly target: FallbackTarget; readonly depth: number }`, `ladderSlotKey(storyId, tier, agent, role): string`, `ladderDepthOf(rungs, target, same): number`. Tasks 5-7 consume all three.

- [ ] **Step 1: Write the failing test**

Create `test/unit/agents/ladder-slot.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { ladderDepthOf, ladderSlotKey } from "@/agents/ladder-slot";
import type { FallbackTarget } from "@/agents/swap-decision";

const RUNGS: FallbackTarget[] = [
  { agent: "native", tier: "powerful" },
  { agent: "native", model: "openrouter/z-ai/glm-5.3-flash[high]" },
  { agent: "claude" },
];

/** Exact-shape comparator; the manager injects a model-identity-aware one. */
const same = (a: FallbackTarget, b: FallbackTarget) =>
  a.agent === b.agent && a.tier === b.tier && a.model === b.model;

describe("ladderSlotKey()", () => {
  test("distinguishes roles", () => {
    expect(ladderSlotKey("US-1", "balanced", "native", "implementer")).not.toBe(
      ladderSlotKey("US-1", "balanced", "native", "reviewer-semantic"),
    );
  });

  test("distinguishes tiers, so an escalation starts a fresh ladder", () => {
    expect(ladderSlotKey("US-1", "balanced", "native", "implementer")).not.toBe(
      ladderSlotKey("US-1", "powerful", "native", "implementer"),
    );
  });

  test("is stable for the same inputs", () => {
    expect(ladderSlotKey("US-1", "balanced", "native", "implementer")).toBe(
      ladderSlotKey("US-1", "balanced", "native", "implementer"),
    );
  });

  test("absent tier and role are still distinct from present ones", () => {
    expect(ladderSlotKey("US-1", undefined, "native", undefined)).not.toBe(
      ladderSlotKey("US-1", "balanced", "native", "implementer"),
    );
  });
});

describe("ladderDepthOf()", () => {
  test("the configured primary is depth 0", () => {
    expect(ladderDepthOf(RUNGS, { agent: "native" }, same)).toBe(0);
  });

  test("the first rung is depth 1", () => {
    expect(ladderDepthOf(RUNGS, { agent: "native", tier: "powerful" }, same)).toBe(1);
  });

  test("the second rung is depth 2", () => {
    expect(ladderDepthOf(RUNGS, { agent: "native", model: "openrouter/z-ai/glm-5.3-flash[high]" }, same)).toBe(2);
  });

  test("a cross-agent rung counts like any other", () => {
    expect(ladderDepthOf(RUNGS, { agent: "claude" }, same)).toBe(3);
  });

  test("a target that is on no rung is depth 0", () => {
    expect(ladderDepthOf(RUNGS, { agent: "codex" }, same)).toBe(0);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `bun test test/unit/agents/ladder-slot.test.ts`
Expected: FAIL — `Cannot find module '@/agents/ladder-slot'`.

- [ ] **Step 3: Write the module**

Create `src/agents/ladder-slot.ts`:

```ts
/**
 * Where one (story, tier, agent, role) sits on its fallback ladder.
 *
 * `depth` is a ladder INDEX, not a count of swap events: 0 is the configured
 * primary and 1..n are `agent.fallback.map[<primary>]` positions. A slot that
 * starts at rung 2 because rungs 0-1 are cooling IS at depth 2 and does not get a
 * fresh budget from there, which is what lets `maxHopsPerStory` bound how far down
 * the ladder a story travels rather than how many swaps each operation may make.
 *
 * Role is part of the key because slots remember "where I landed" per role, while
 * the CooldownStore propagates "what is dead" across all of them: an implementer's
 * rate-limit protects a reviewer without overriding the reviewer's own model pin.
 */

import type { FallbackTarget } from "./swap-decision";

export interface LadderSlot {
  /** The endpoint this slot dispatches to: agent plus tier or literal pin. */
  readonly target: FallbackTarget;
  /** Ladder index of `target`. 0 = configured primary. */
  readonly depth: number;
}

export function ladderSlotKey(
  storyId: string,
  tier: string | undefined,
  agent: string,
  role: string | undefined,
): string {
  return `${storyId}::${tier ?? "default"}::${agent}::${role ?? "default"}`;
}

/**
 * The 1-based position of `target` in `rungs`, or 0 when it is on no rung — which
 * is the configured primary (or an unknown target, which is treated the same: a
 * target we cannot place must not silently consume ladder depth).
 */
export function ladderDepthOf(
  rungs: readonly FallbackTarget[],
  target: FallbackTarget,
  same: (a: FallbackTarget, b: FallbackTarget) => boolean,
): number {
  const index = rungs.findIndex((rung) => same(rung, target));
  return index === -1 ? 0 : index + 1;
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `bun test test/unit/agents/ladder-slot.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/agents/ladder-slot.ts test/unit/agents/ladder-slot.test.ts
git commit -m "feat(agents): add the ladder slot record and depth index"
```

---

### Task 5: Store slots, keyed by role

Replaces `runtime.storyAgentTargets` (keyed `storyId+tier+agent`, holding a bare target) with `runtime.ladderSlots` (keyed `storyId+tier+agent+role`, holding target and depth).

**Files:**
- Modify: `src/runtime/index.ts` (three sites: the interface field, the `new Map(...)` initialiser, and the object literal that assembles the runtime), `src/operations/call-resolvers.ts:177-252`, `src/operations/call.ts:92-99, 209, 469`
- Modify (existing tests that read the old store): `test/unit/operations/call-fallback-recording.test.ts`, `test/unit/operations/call-sticky-target.test.ts`
- Test: `test/unit/operations/ladder-slot-stickiness.test.ts`

**Interfaces:**
- Consumes: `LadderSlot`, `ladderSlotKey` (Task 4).
- Produces: `recordLadderSlot(ctx, target, depth, swapped, tier, role)`, `ladderSlotFor(ctx, tier, role): LadderSlot | undefined`, and `resolveDispatchTarget(ctx, resolved, effectiveModels, effectiveTier, defaultAgent, role): DispatchTarget & { startDepth: number }`. Task 7 consumes `startDepth`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/operations/ladder-slot-stickiness.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { makeMockCallContext } from "@test/helpers";
import type { ModelsConfig, ResolvedConfiguredModel } from "@/config/schema-types";
import { ladderSlotFor, recordLadderSlot, resolveDispatchTarget } from "@/operations/call-resolvers";
import type { CallContext } from "@/operations/types";

const MODELS: ModelsConfig = {
  native: { balanced: "minimax/MiniMax-M3", powerful: "opencode-go/deepseek-v4-flash[high]" },
};

function ctx(): CallContext {
  return makeMockCallContext({ agentName: "native", storyId: "US-1" });
}

const resolved: ResolvedConfiguredModel = {
  agent: "native",
  modelDef: { provider: "unknown", model: "minimax/MiniMax-M3" },
  modelTier: "balanced",
};

describe("ladder slot stickiness", () => {
  test("a swap is recorded and read back at the same role", () => {
    const c = ctx();
    recordLadderSlot(c, { agent: "native", tier: "powerful" }, 1, true, "balanced", "implementer");
    expect(ladderSlotFor(c, "balanced", "implementer")).toEqual({ target: { agent: "native", tier: "powerful" }, depth: 1 });
  });

  test("another role does not see it", () => {
    const c = ctx();
    recordLadderSlot(c, { agent: "native", tier: "powerful" }, 1, true, "balanced", "implementer");
    expect(ladderSlotFor(c, "balanced", "reviewer-semantic")).toBeUndefined();
  });

  test("a different tier does not see it (escalation resets the ladder)", () => {
    const c = ctx();
    recordLadderSlot(c, { agent: "native", tier: "powerful" }, 1, true, "balanced", "implementer");
    expect(ladderSlotFor(c, "powerful", "implementer")).toBeUndefined();
  });

  test("nothing is recorded when no swap happened", () => {
    const c = ctx();
    recordLadderSlot(c, { agent: "native", tier: "powerful" }, 1, false, "balanced", "implementer");
    expect(ladderSlotFor(c, "balanced", "implementer")).toBeUndefined();
  });

  test("a later op of the same role dispatches the sticky endpoint and its depth", () => {
    const c = ctx();
    recordLadderSlot(c, { agent: "native", tier: "powerful" }, 1, true, "balanced", "implementer");
    const out = resolveDispatchTarget(c, resolved, MODELS, "balanced", "native", "implementer");
    expect(out.agent).toBe("native");
    expect(out.modelDef.model).toBe("opencode-go/deepseek-v4-flash[high]");
    expect(out.startDepth).toBe(1);
  });

  test("with no slot, the op's own resolution wins at depth 0", () => {
    const out = resolveDispatchTarget(ctx(), resolved, MODELS, "balanced", "native", "implementer");
    expect(out.modelDef.model).toBe("minimax/MiniMax-M3");
    expect(out.startDepth).toBe(0);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `bun test test/unit/operations/ladder-slot-stickiness.test.ts`
Expected: FAIL — `ladderSlotFor` and `recordLadderSlot` are not exported from `call-resolvers`.

- [ ] **Step 3: Replace the runtime store**

In `src/runtime/index.ts`, replace the `storyAgentTargets` field and its doc block with:

```ts
  /**
   * Where each (story, tier, agent, role) sits on its fallback ladder, keyed by
   * `ladderSlotKey`. Holds the endpoint the slot landed on AND its ladder index,
   * because the two must always agree — splitting them across two maps written
   * from two layers is what let nax#1964's `finalAgent` be returned and never
   * consumed. Written by callOp only when a swap actually occurred; read by callOp
   * before it resolves a dispatch target.
   */
  readonly ladderSlots: Map<string, import("../agents/ladder-slot").LadderSlot>;
```

Update its initialiser in the same file (where `storyAgentTargets: new Map()` is constructed) to `ladderSlots: new Map()`.

- [ ] **Step 4: Rewrite the resolvers**

In `src/operations/call-resolvers.ts`, replace the `storyFixKey` import with `import { ladderSlotKey, type LadderSlot } from "../agents/ladder-slot";`, and replace `recordStoryAgentTarget`, `stickyAgentTarget` and the body of `resolveDispatchTarget` with:

```ts
/**
 * Record the rung a story's slot landed on, so its later ops start there.
 *
 * Only a real swap is recorded: pinning a slot to its primary would add nothing and
 * would freeze a choice nothing had to make.
 */
export function recordLadderSlot(
  ctx: CallContext,
  target: FallbackTarget | undefined,
  depth: number,
  swapped: boolean,
  tier: string | undefined,
  role: string | undefined,
): void {
  if (!swapped || !target || !ctx.storyId) return;
  ctx.runtime.ladderSlots.set(ladderSlotKey(ctx.storyId, tier, ctx.agentName, role), { target, depth });
}

/** The slot this story's role already landed on at this rung, if any. */
export function ladderSlotFor(ctx: CallContext, tier: string | undefined, role: string | undefined): LadderSlot | undefined {
  if (!ctx.storyId) return undefined;
  return ctx.runtime.ladderSlots.get(ladderSlotKey(ctx.storyId, tier, ctx.agentName, role));
}

export interface DispatchTarget {
  readonly agent: string;
  readonly modelDef: ModelDef;
  /** Ladder index this dispatch starts from — 0 unless a slot moved it. */
  readonly startDepth: number;
}

export function resolveDispatchTarget(
  ctx: CallContext,
  resolved: ResolvedConfiguredModel,
  effectiveModels: ModelsConfig,
  effectiveTier: string,
  defaultAgent: string,
  role: string | undefined,
): DispatchTarget {
  const slot = ladderSlotFor(ctx, resolved.modelTier, role);
  if (!slot) return { agent: resolved.agent, modelDef: resolved.modelDef, startDepth: 0 };
  const { target } = slot;
  const modelDef =
    target.model !== undefined
      ? resolveModel(target.model)
      : resolveModelForAgent(effectiveModels, target.agent, target.tier ?? effectiveTier, defaultAgent);
  return { agent: target.agent, modelDef, startDepth: slot.depth };
}
```

Update `recordDispatchOutcome` to forward depth and role:

```ts
export function recordDispatchOutcome(
  ctx: CallContext,
  outcome: FallbackDispatchOutcome,
  tier: string | undefined,
  role: string | undefined,
): void {
  recordAgentFallbacks(ctx, outcome.fallbacks);
  recordLadderSlot(ctx, outcome.finalTarget, outcome.finalDepth ?? 0, outcome.didSwap === true, tier, role);
}
```

and add `readonly finalDepth?: number;` to the `FallbackDispatchOutcome` interface in the same file.

- [ ] **Step 5: Update callOp's two call sites**

In `src/operations/call.ts`, the `run` branch already computes `const sessionRole = ctx.sessionOverride?.role ?? runOp.session.role;` at line 209 — move that line above the `resolveDispatchTarget` call at line 93 so both branches can pass it, then:

```ts
  const { agent: dispatchAgent, modelDef: dispatchModelDef, startDepth } = resolveDispatchTarget(
    ctx,
    resolved,
    effectiveModels,
    effectiveTier,
    defaultAgent,
    sessionRole,
  );
```

Update both `recordDispatchOutcome(ctx, outcome, resolved.modelTier)` calls (lines 146 and 469) to pass `sessionRole` as the fourth argument.

- [ ] **Step 6: Migrate the two existing tests that read the old store**

`test/unit/operations/call-fallback-recording.test.ts` and `test/unit/operations/call-sticky-target.test.ts` assert against `runtime.storyAgentTargets` keyed by `storyFixKey(storyId, tier, agent)`. Update both to read `runtime.ladderSlots` keyed by `ladderSlotKey(storyId, tier, agent, role)`, and to expect the slot shape rather than a bare target — e.g.

```ts
expect(runtime.ladderSlots.get(ladderSlotKey("US-001", "balanced", "claude", "implementer"))).toEqual({
  target: { agent: "codex" },
  depth: 1,
});
```

The `role` argument must match the `session.role` of the op each test drives; read it from that op's definition rather than guessing. Do not weaken an assertion to make it pass — if a slot is missing, the wiring in Step 5 is wrong.

- [ ] **Step 7: Run the tests**

Run: `bun test test/unit/operations/ && bun run typecheck`
Expected: PASS. Any remaining reference to `storyAgentTargets` is a typecheck error — fix each by switching to `ladderSlots`.

- [ ] **Step 8: Commit**

```bash
git add src/runtime/index.ts src/operations/call-resolvers.ts src/operations/call.ts test/unit/operations/
git commit -m "feat(operations): key sticky fallback targets by role and depth"
```

---

### Task 6: Endpoint-aware start check

`resolveStartAgent` asks `isUnavailable(primary)` tier-less, which reads the bare-agent cooldown key unconditionally — so one role's rate-limit diverts every other role off its own configured endpoint.

**Files:**
- Modify: `src/agents/hop-budget.ts:20-58`, `src/agents/manager-run-fallback.ts:49`, `src/agents/manager.ts:206`
- Test: `test/unit/agents/start-agent-endpoint.test.ts`

**Interfaces:**
- Consumes: `AgentManager.isUnavailable(agent, tier?, model?)` (already this shape).
- Produces: `resolveStartAgent(source, primary, fallbackEnabled, storyId, logger, startEndpoint?)` where `startEndpoint` is `{ tier?: string; model?: string }`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/agents/start-agent-endpoint.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { resolveStartAgent } from "@/agents/hop-budget";
import type { FallbackTarget } from "@/agents/swap-decision";

function source(cooling: ReadonlySet<string>, candidate: FallbackTarget | null) {
  return {
    isUnavailable: (agent: string, tier?: string, model?: string) =>
      cooling.has(`${agent}::${tier ?? ""}::${model ?? ""}`),
    nextCandidate: () => candidate,
  };
}

describe("resolveStartAgent() with an endpoint", () => {
  test("starts on the primary when this endpoint is healthy, even if another is cooling", () => {
    const cooling = new Set(["native::balanced::"]);
    const start = resolveStartAgent(source(cooling, { agent: "claude" }), "native", true, "US-1", null, {
      tier: "codex-mini",
    });
    expect(start).toEqual({ agent: "native" });
  });

  test("skips to the first live candidate when THIS endpoint is cooling", () => {
    const cooling = new Set(["native::balanced::"]);
    const start = resolveStartAgent(
      source(cooling, { agent: "native", tier: "powerful" }),
      "native",
      true,
      "US-1",
      null,
      { tier: "balanced" },
    );
    expect(start).toEqual({ agent: "native", tier: "powerful" });
  });

  test("with no endpoint given it reads the bare-agent key, as before", () => {
    const cooling = new Set(["native::::"]);
    const start = resolveStartAgent(source(cooling, { agent: "claude" }), "native", true, "US-1", null);
    expect(start).toEqual({ agent: "claude" });
  });

  test("fallback disabled always returns the primary", () => {
    const cooling = new Set(["native::balanced::"]);
    const start = resolveStartAgent(source(cooling, { agent: "claude" }), "native", false, "US-1", null, {
      tier: "balanced",
    });
    expect(start).toEqual({ agent: "native" });
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `bun test test/unit/agents/start-agent-endpoint.test.ts`
Expected: FAIL — the first test returns `{ agent: "claude" }` because the current signature ignores the endpoint and the source's `isUnavailable` is called with one argument.

- [ ] **Step 3: Widen the source interface and the function**

In `src/agents/hop-budget.ts`:

```ts
export interface StartAgentSource {
  isUnavailable(agent: string, tier?: string, model?: string): boolean;
  nextCandidate(current: string, hopsSoFar: number): FallbackTarget | null;
}

/** The endpoint an operation would dispatch to if it started on its primary. */
export interface StartEndpoint {
  readonly tier?: string;
  readonly model?: string;
}

export function resolveStartAgent(
  source: StartAgentSource,
  primary: string,
  fallbackEnabled: boolean | undefined,
  storyId: string | undefined,
  logger: HopBudgetLogger | null | undefined,
  endpoint?: StartEndpoint,
): FallbackTarget {
  // Ask about the endpoint this operation would actually dispatch to, not the bare
  // agent name: on the native transport one agent fronts several providers, so
  // "native is unavailable" is only true for agent-scoped faults (bad credentials,
  // missing binary) — which CooldownStore still answers from the bare key.
  if (!fallbackEnabled || !source.isUnavailable(primary, endpoint?.tier, endpoint?.model)) return { agent: primary };
  const candidate = source.nextCandidate(primary, 0);
  if (!candidate) return { agent: primary };
  logger?.info("agent-manager", "Primary agent already unavailable — starting on fallback", {
    storyId,
    fromAgent: primary,
    toAgent: candidate.agent,
  });
  return candidate;
}
```

- [ ] **Step 4: Pass the operation's endpoint at the call site**

In `src/agents/manager-run-fallback.ts`, replace the `resolveStartAgent` call (line 49) with:

```ts
  const start = resolveStartAgent(input, primaryAgent, config.agent?.fallback?.enabled, storyId, logger, {
    tier: request.runOptions.modelTier,
    model: request.runOptions.modelDef?.model,
  });
```

In `src/agents/manager.ts`, widen the `isUnavailable` forwarder passed to `runWithFallback` (line 206) to `(agent, tier, model) => this.isUnavailable(agent, tier, model)`.

- [ ] **Step 5: Run the tests**

Run: `bun test test/unit/agents/`
Expected: PASS, including the pre-existing dead-primary-skip regression test from #1970.

- [ ] **Step 6: Commit**

```bash
git add src/agents/hop-budget.ts src/agents/manager-run-fallback.ts src/agents/manager.ts test/unit/agents/start-agent-endpoint.test.ts
git commit -m "fix(agents): scope the dead-primary skip to the dispatched endpoint"
```

---

### Task 7: Depth replaces the swap-event budget

`hopsSoFar` currently comes from `StoryHopBudget.spent(storyId)` — a cumulative count of swap events shared by every operation of the story, which strands later operations once it is spent.

**Files:**
- Modify: `src/agents/manager-run-fallback.ts:44-57, 220-247`, `src/agents/manager-types.ts` (`AgentRunRequest`, `AgentRunOutcome`), `src/agents/manager.ts:190-193` (expose rungs for depth), `src/operations/call.ts:450-460` (pass `startDepth`)
- Test: `test/unit/agents/ladder-depth-cap.test.ts`

**Interfaces:**
- Consumes: `ladderDepthOf` (Task 4), `startDepth` (Task 5).
- Produces: `AgentRunRequest.startDepth?: number`; `AgentRunOutcome.finalDepth?: number`; `RunFallbackInput.depthOf(target): number`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/agents/ladder-depth-cap.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { makeNaxConfig } from "@test/helpers";
import type { AgentRunOptions } from "@/agents";
import { AgentManager } from "@/agents";
import { DEFAULT_CONFIG } from "@/config";
import { agentManagerConfigSelector } from "@/config/selectors";
import type { AdapterFailure, ContextBundle } from "@/context/engine";

const RATE_LIMIT: AdapterFailure = {
  category: "availability",
  outcome: "fail-rate-limit",
  retriable: true,
  message: "429",
};

function manager() {
  const config = makeNaxConfig({
    agent: {
      default: "native",
      protocol: "hybrid",
      fallback: {
        enabled: true,
        map: {
          native: [
            { agent: "native", model: "powerful" },
            { agent: "native", model: "openrouter/z-ai/glm-5.3-flash[high]" },
            "claude",
          ],
        },
        maxHopsPerStory: 2,
        onQualityFailure: false,
        rebuildContext: false,
      },
    },
    models: { native: { balanced: "minimax/MiniMax-M3", powerful: "opencode-go/deepseek-v4-flash[high]" } },
  });
  return new AgentManager(config, undefined, { models: config.models });
}

function runOptions(storyId: string): AgentRunOptions {
  return {
    prompt: "p",
    workdir: "/tmp",
    modelTier: "balanced",
    modelDef: { provider: "unknown", model: "minimax/MiniMax-M3" },
    timeoutSeconds: 60,
    storyId,
    config: agentManagerConfigSelector.select(DEFAULT_CONFIG),
  };
}

/** Every hop fails with a rate limit, so the ladder is walked to its cap. */
function failingHop(seen: string[]) {
  return async (agent: string, bundle: ContextBundle | undefined) => {
    seen.push(agent);
    return {
      result: {
        success: false,
        exitCode: 1,
        output: "429",
        rateLimited: true,
        durationMs: 1,
        estimatedCostUsd: 0,
        adapterFailure: RATE_LIMIT,
      },
      bundle,
      endpoint: { modelDef: { provider: "unknown", model: `m${seen.length}` } },
    };
  };
}

describe("ladder depth cap", () => {
  test("an op starting at depth 1 may descend to 2 and no further", async () => {
    const seen: string[] = [];
    const outcome = await manager().runWithFallback({
      runOptions: runOptions("US-1"),
      startDepth: 1,
      executeHop: failingHop(seen),
    });

    // Started on rung 1, descended to rung 2, then the cap refused rung 3.
    expect(seen).toHaveLength(2);
    expect(outcome.finalDepth).toBe(2);
  });

  test("an op starting at depth 0 descends twice", async () => {
    const seen: string[] = [];
    const outcome = await manager().runWithFallback({
      runOptions: runOptions("US-2"),
      startDepth: 0,
      executeHop: failingHop(seen),
    });

    expect(seen).toHaveLength(3);
    expect(outcome.finalDepth).toBe(2);
  });

  test("depth is per story, not accumulated from another story's swaps", async () => {
    const mgr = manager();
    const first: string[] = [];
    await mgr.runWithFallback({ runOptions: runOptions("US-A"), startDepth: 0, executeHop: failingHop(first) });

    const second: string[] = [];
    await mgr.runWithFallback({ runOptions: runOptions("US-B"), startDepth: 0, executeHop: failingHop(second) });

    expect(second).toHaveLength(3);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `bun test test/unit/agents/ladder-depth-cap.test.ts`
Expected: FAIL — `startDepth` is not a recognised request field and `finalDepth` is undefined, so the first test dispatches three hops instead of two.

- [ ] **Step 3: Add the request/outcome fields**

In `src/agents/manager-types.ts`, add to `AgentRunRequest`:

```ts
  /**
   * Ladder index this operation starts from — the slot's depth (nax#1965). 0 when
   * the operation starts on its configured primary. Replaces reading a per-story
   * swap-event counter: `maxHopsPerStory` bounds how far down the ladder a story
   * travels, not how many swaps each of its operations may make.
   */
  readonly startDepth?: number;
```

and to `AgentRunOutcome`:

```ts
  /** Ladder index of `finalTarget`, for the caller's slot record. */
  finalDepth?: number;
```

- [ ] **Step 4: Use depth in the loop**

In `src/agents/manager-run-fallback.ts`:

Add `readonly depthOf: (target: FallbackTarget) => number;` to `RunFallbackInput`.

Replace `let hopsSoFar = budget.spent(storyId);` with:

```ts
  // Ladder index, not a swap counter: an op that starts on rung k IS at depth k.
  let hopsSoFar = request.startDepth ?? budget.spent(storyId);
```

Replace `hopsSoFar = budget.spend(storyId, hopsSoFar);` in the swap branch with:

```ts
      // The new position IS the rung's index — not "one more than before". A hop
      // may skip cooling rungs, so incrementing would under-count the descent.
      hopsSoFar = input.depthOf(next);
      budget.record(storyId, hopsSoFar);
```

`StoryHopBudget.spend(storyId, hopsSoFar)` stores `hopsSoFar + 1`, which is wrong for an index. Add a sibling to `src/agents/hop-budget.ts` and leave `spend` in place for the callers that still count events (`completeWithFallback`):

```ts
  /** Record an absolute ladder position — the depth-index counterpart to `spend`. */
  record(storyId: string | undefined, depth: number): void {
    if (storyId) this._byStory.set(storyId, depth);
  }
```

Add `finalDepth: hopsSoFar,` to every `return { result, fallbacks, didSwap, ... }` object in the function (there are six).

- [ ] **Step 5: Supply `depthOf` from the manager**

`src/agents/manager.ts` is at **596** of a 600-line hard limit, so the body of this cannot live there. Add to `src/agents/ladder-slot.ts`:

```ts
/**
 * The configured ladder for `primary`, resolved to dispatchable shape.
 *
 * Deliberately unfiltered: depth is a position in the CONFIGURED ladder, so it
 * must not shift with which rungs happen to be cooling at this instant.
 */
export function ladderRungs(
  map: FallbackMap | undefined,
  primary: string,
  resolve: (target: FallbackTarget) => FallbackTarget,
): FallbackTarget[] {
  return availableCandidates(map, primary, () => false, resolve);
}
```

with `import { availableCandidates, type FallbackMap, type FallbackTarget } from "./swap-decision";`.

Then in `src/agents/manager.ts` add exactly two lines — one private arrow beside the existing `_isExcluded` / `_sameHop` / `_resolveTarget` properties, and one entry in the `runWithFallback` input object:

```ts
  private readonly _depthOf = (t: FallbackTarget): number =>
    ladderDepthOf(ladderRungs(this._config.agent?.fallback?.map, this.getDefault(), this._resolveTarget), t, (a, b) =>
      this._sameHop(a.agent, b.agent, a.tier, a.model, b.tier, b.model),
    );
```

```ts
      depthOf: this._depthOf,
```

with `import { ladderDepthOf, ladderRungs } from "./ladder-slot";`.

- [ ] **Step 6: Pass startDepth from callOp**

In `src/operations/call.ts`, add `startDepth,` to the `runWithFallback` request object (alongside `runOptions`, `signal`, `executeHop`, `noFallback`, `bundle`).

- [ ] **Step 7: Run the tests and the size gate**

Run: `bun test test/unit/agents/ test/unit/operations/ && bun run typecheck && bun run check:file-sizes && wc -l src/agents/manager.ts src/operations/call.ts`
Expected: PASS, and both files at most 600 lines. Tasks 6 and 7 both add to `src/agents/manager.ts` (596 at the start of this branch) — if the total pushes it past 600, extract `_depthOf` and `_sameHop` into `ladder-slot.ts` as free functions taking `(models, defaultAgent, map)` rather than trimming a test.

- [ ] **Step 8: Commit**

```bash
git add src/agents/manager-types.ts src/agents/manager-run-fallback.ts src/agents/manager.ts src/agents/ladder-slot.ts src/agents/hop-budget.ts src/operations/call.ts test/unit/agents/ladder-depth-cap.test.ts
git commit -m "feat(agents): bound fallback by ladder depth per slot"
```

---

### Task 8: The composite acceptance test

The executable form of the goal, and the level at which #1965 would have been caught: a real `SessionManager`, a real `AgentManager`, real cooldowns and a real ladder, with only adapter dispatch stubbed.

**Files:**
- Create: `test/unit/agents/ladder-across-ops.test.ts`
- Test: itself

**Interfaces:**
- Consumes: everything from Tasks 1-7.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Write the test**

Create `test/unit/agents/ladder-across-ops.test.ts`:

```ts
/**
 * Three operations of one story walk the ladder together (nax#1965).
 *
 * The stub is the ADAPTER, nothing above it: SessionManager's live-handle cache,
 * AgentManager's candidate selection, the CooldownStore and the configured ladder
 * are all real. That is deliberate — every pre-existing fallback test stubbed the
 * session layer, which is exactly where the endpoint was being dropped.
 */

import { describe, expect, mock, test } from "bun:test";
import { makeAgentAdapter, makeNaxConfig } from "@test/helpers";
import type { OpenSessionOpts, SessionHandle } from "@/agents/types";
import { SessionManager } from "@/session/manager";

const SESSION = "nax-ladder-us1-implementer";

const MODELS = {
  native: { balanced: "minimax/MiniMax-M3", powerful: "opencode-go/deepseek-v4-flash[high]" },
  claude: { balanced: "sonnet[medium]", powerful: "sonnet[medium]" },
} as const;

function ladderConfig() {
  return makeNaxConfig({
    agent: {
      default: "native",
      protocol: "hybrid",
      fallback: {
        enabled: true,
        map: {
          native: [
            { agent: "native", model: "powerful" },
            { agent: "native", model: "openrouter/z-ai/glm-5.3-flash[high]" },
            "claude",
          ],
        },
        maxHopsPerStory: 3,
      },
    },
    models: MODELS,
  });
}

/** Records every endpoint the adapter was actually asked to dispatch. */
function recordingAdapter() {
  const dispatched: Array<{ agent: string; model: string }> = [];
  const closed: SessionHandle[] = [];
  const adapter = makeAgentAdapter({
    openSession: mock(async (name: string, opts: OpenSessionOpts): Promise<SessionHandle> => {
      dispatched.push({ agent: opts.agentName, model: opts.modelDef.model });
      return { id: name, agentName: opts.agentName, modelDef: opts.modelDef };
    }),
    closeSession: mock(async (handle: SessionHandle) => {
      closed.push(handle);
    }),
  });
  return { adapter, dispatched, closed };
}

describe("a story's ladder across three operations", () => {
  test("op 2 dispatches the endpoint op 1 swapped to, with THAT model on the handle", async () => {
    const { adapter, dispatched } = recordingAdapter();
    const sm = new SessionManager({ getAdapter: () => adapter, config: ladderConfig() });

    // Op 1 opens on the primary (balanced), then swaps to rung 1 (powerful).
    await sm.openSession(SESSION, {
      agentName: "native",
      role: "implementer",
      workdir: "/w",
      pipelineStage: "run",
      modelDef: { provider: "unknown", model: MODELS.native.balanced },
      timeoutSeconds: 30,
      storyId: "US-1",
    });
    await sm.openSession(SESSION, {
      agentName: "native",
      role: "implementer",
      workdir: "/w",
      pipelineStage: "run",
      modelDef: { provider: "unknown", model: MODELS.native.powerful },
      timeoutSeconds: 30,
      storyId: "US-1",
    });

    // Op 2 (autofix-implementer — same warm session name and role) inherits rung 1.
    const hop = await sm.openSession(SESSION, {
      agentName: "native",
      role: "implementer",
      workdir: "/w",
      pipelineStage: "rectification",
      modelDef: { provider: "unknown", model: MODELS.native.powerful },
      timeoutSeconds: 30,
      storyId: "US-1",
    });

    expect(hop.modelDef?.model).toBe(MODELS.native.powerful);
    expect(dispatched.map((d) => d.model)).toEqual([MODELS.native.balanced, MODELS.native.powerful]);
  });

  test("native -> claude closes the native handle and dispatches sonnet", async () => {
    const { adapter, dispatched, closed } = recordingAdapter();
    const sm = new SessionManager({ getAdapter: () => adapter, config: ladderConfig() });

    await sm.openSession(SESSION, {
      agentName: "native",
      role: "implementer",
      workdir: "/w",
      pipelineStage: "run",
      modelDef: { provider: "unknown", model: MODELS.native.balanced },
      timeoutSeconds: 30,
      storyId: "US-1",
    });
    const hop = await sm.openSession(SESSION, {
      agentName: "claude",
      role: "implementer",
      workdir: "/w",
      pipelineStage: "run",
      modelDef: { provider: "anthropic", model: "sonnet[medium]" },
      timeoutSeconds: 30,
      storyId: "US-1",
    });

    expect(hop.agentName).toBe("claude");
    expect(dispatched.at(-1)).toEqual({ agent: "claude", model: "sonnet[medium]" });
    expect(closed.map((h) => h.agentName)).toEqual(["native"]);
  });

  test("claude -> native closes the acp handle rather than orphaning it", async () => {
    const { adapter, dispatched, closed } = recordingAdapter();
    const sm = new SessionManager({ getAdapter: () => adapter, config: ladderConfig() });

    await sm.openSession(SESSION, {
      agentName: "claude",
      role: "implementer",
      workdir: "/w",
      pipelineStage: "run",
      modelDef: { provider: "anthropic", model: "sonnet[medium]" },
      timeoutSeconds: 30,
      storyId: "US-1",
    });
    const hop = await sm.openSession(SESSION, {
      agentName: "native",
      role: "implementer",
      workdir: "/w",
      pipelineStage: "run",
      modelDef: { provider: "unknown", model: MODELS.native.balanced },
      timeoutSeconds: 30,
      storyId: "US-1",
    });

    expect(hop.agentName).toBe("native");
    expect(dispatched.at(-1)).toEqual({ agent: "native", model: MODELS.native.balanced });
    expect(closed.map((h) => h.agentName)).toEqual(["claude"]);
  });
});
```

- [ ] **Step 2: Run it**

Run: `bun test test/unit/agents/ladder-across-ops.test.ts`
Expected: PASS. If the first test fails with the *balanced* model on `hop.modelDef`, Task 1 did not land correctly — fix Task 1 rather than this test.

- [ ] **Step 3: Confirm it fails without the fix**

Run: `git stash && bun test test/unit/agents/ladder-across-ops.test.ts; git stash pop`
Expected: FAIL on the first and third tests — this is the proof the test has teeth.

- [ ] **Step 4: Commit**

```bash
git add test/unit/agents/ladder-across-ops.test.ts
git commit -m "test(agents): ladder continuity across a story's operations"
```

---

### Task 9: Protocol-gate validation of ladder rungs

A rung naming `native` under `protocol: "acp"` (or an acpx agent under `protocol: "native"`) currently fails only at dispatch time, mid-story, as `AGENT_NOT_FOUND` after the hop has already been spent.

**Files:**
- Modify: `src/config/schemas-protocol-gate.ts:23-37, 39-70`
- Test: `test/unit/config/agent-protocol-gate.test.ts` (append)

**Interfaces:**
- Consumes: `ProtocolGateInput` (extended with `agent.fallback.map`).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/config/agent-protocol-gate.test.ts`:

```ts
describe("agent.protocol gate — fallback ladder rungs", () => {
  test("rejects a native rung under protocol acp", () => {
    const result = NaxConfigSchema.safeParse(
      config({
        agent: { protocol: "acp", default: "claude", fallback: { enabled: true, map: { claude: ["native"] } } },
        models: { claude: { fast: "haiku" } },
      }),
    );
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("fallback");
  });

  test("rejects an acpx rung under protocol native", () => {
    const result = NaxConfigSchema.safeParse(
      config({
        agent: {
          protocol: "native",
          default: "native",
          fallback: { enabled: true, map: { native: [{ agent: "claude" }] } },
        },
        models: { native: { fast: "openai/gpt-5.4-mini" } },
      }),
    );
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("fallback");
  });

  test("accepts a mixed ladder under protocol hybrid", () => {
    const result = NaxConfigSchema.safeParse(
      config({
        agent: {
          protocol: "hybrid",
          default: "native",
          fallback: { enabled: true, map: { native: [{ agent: "native", model: "powerful" }, "claude"] } },
        },
        models: { native: { fast: "openai/gpt-5.4-mini", powerful: "openai/gpt-5.4" }, claude: { fast: "haiku" } },
      }),
    );
    expect(result.success).toBe(true);
  });

  test("a ladder key is checked as well as its rungs", () => {
    const result = NaxConfigSchema.safeParse(
      config({
        agent: { protocol: "acp", default: "claude", fallback: { enabled: true, map: { native: ["claude"] } } },
        models: { claude: { fast: "haiku" } },
      }),
    );
    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `bun test test/unit/config/agent-protocol-gate.test.ts`
Expected: FAIL — the three rejection cases parse successfully today.

- [ ] **Step 3: Extend the gate**

In `src/config/schemas-protocol-gate.ts`, widen the input type:

```ts
interface ProtocolGateInput {
  readonly agent?: {
    readonly protocol?: string;
    readonly default?: string;
    readonly fallback?: { readonly map?: Record<string, readonly unknown[] | undefined> };
  };
  readonly models?: Record<string, Record<string, unknown> | undefined>;
}
```

Add the validator and call it from `validateProtocolGate` (after `validateNativeModelIds`):

```ts
/** The agent a fallback map value names, across all three config spellings. */
function rungAgent(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null) {
    const agent = (value as { agent?: unknown }).agent;
    if (typeof agent === "string") return agent;
  }
  return undefined;
}

/**
 * Every agent named in `agent.fallback.map` — as a key or a rung — must be
 * reachable under the declared protocol. Without this the mismatch surfaces only
 * at dispatch, mid-story, as AGENT_NOT_FOUND, after the hop has been spent.
 */
function validateFallbackLadderAgents(data: ProtocolGateInput, ctx: z.RefinementCtx): void {
  const protocol = data.agent?.protocol ?? DEFAULT_PROTOCOL;
  if (protocol === "hybrid") return;
  const map = data.agent?.fallback?.map ?? {};

  const reject = (agent: string, path: (string | number)[]): void => {
    const permitted = protocol === NATIVE ? `only "${NATIVE}"` : `no native agent`;
    ctx.addIssue({
      code: "custom",
      path,
      message: `agent.protocol "${protocol}" permits ${permitted} in agent.fallback.map; "${agent}" is not reachable. Use "hybrid" to run both transports.`,
    });
  };

  for (const [from, rungs] of Object.entries(map)) {
    const offending = (agent: string) => (protocol === NATIVE ? agent !== NATIVE : agent === NATIVE);
    if (offending(from)) reject(from, ["agent", "fallback", "map", from]);
    (rungs ?? []).forEach((rung, index) => {
      const agent = rungAgent(rung);
      if (agent !== undefined && offending(agent)) reject(agent, ["agent", "fallback", "map", from, index]);
    });
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test test/unit/config/`
Expected: PASS, including the pre-existing gate tests.

- [ ] **Step 5: Commit**

```bash
git add src/config/schemas-protocol-gate.ts test/unit/config/agent-protocol-gate.test.ts
git commit -m "feat(config): validate fallback ladder agents against the protocol gate"
```

---

### Task 10: Full gate and issue close-out

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Run the whole gate**

Run: `bun run lint && bun run typecheck && bun run test`
Expected: all green; note the unit/integration/ui counts for the PR body.

- [ ] **Step 2: Confirm the baselines did not move**

Run: `git diff --stat scripts/baselines/ && wc -l src/session/manager.ts src/operations/build-hop-callback.ts src/agents/manager.ts src/operations/call.ts`
Expected: no diff under `scripts/baselines/`; `manager.ts` at most 679, `build-hop-callback.ts` at most 600, `agents/manager.ts` and `call.ts` at most 600.

- [ ] **Step 3: Add the changelog entry**

Add under the unreleased heading in `CHANGELOG.md`:

```markdown
- **Fixed** — a same-agent fallback hop dispatched the previous model, because
  `SessionManager` reused a live session whenever the agent name matched and
  discarded the requested endpoint. Same-agent ladder rungs and sticky endpoints
  inherited by warm rectification ops were both inert (#1965).
- **Changed** — `agent.fallback.maxHopsPerStory` now bounds ladder DEPTH per
  (story, tier, agent, role) rather than counting swap events per story, so a
  story keeps descending its ladder across its operations instead of stranding
  later ops on a dead endpoint.
- **Added** — `agent.fallback.map` agents are validated against `agent.protocol`
  at config load instead of failing mid-story at dispatch.
```

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: changelog for the fallback ladder slot work"
```

- [ ] **Step 5: Request the live probe run**

The suite cannot prove transport behaviour. Ask the user to approve a live fallback-probe run before opening the PR: build the branch, run with the `native` profile, force the primary to fail on its first hop (an exhausted key, or point `models.native.balanced` at a bogus provider), and read the `model` field on the `Agent call started` line immediately after each `Agent swap triggered`. Expected: hop 1 reports `opencode-go/deepseek-v4-flash[high]`, not `minimax/MiniMax-M3`.

**Do not launch `nax run` without explicit approval at that moment.**

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
| --- | --- |
| D1 — reused session discards endpoint | 1 |
| D2 — start rung has no identity | 3 (endpoint-truthful marking), 6 (endpoint-aware start check) |
| D3 — depth cap counts swap events | 4, 7 |
| D4 — sticky key has no role | 5 |
| Slot record (target + depth, key) | 4, 5 |
| Dispatch flow 1 (start on the slot) | 5 (startDepth), 7 |
| Dispatch flow 2 (endpoint-truthful marking) | 3 |
| Dispatch flow 3 (endpoint-aware start check) | 6 |
| Session lifecycle (`decideReuse`, acp leak) | 1 |
| Cross-transport | 8 |
| Protocol-gate validation | 9 |
| Verification L1-L4 | 1, 2, 4, 5, 8 |
| Verification L5 (live probe) | 10 |
| Extraction plan / size ratchet | 1, 2, 10 |

Two spec items are deliberately not tasks: ladder exhaustion behaviour and per-role ladders are both listed under the spec's "Out of scope".

**Placeholder scan:** no TBD/TODO; every code step carries the actual code; no "similar to Task N" references.

**Type consistency:** `HopEndpoint` (Task 2) is the shape returned by `executeHop.endpoint` (Task 3) and consumed as `hop.endpoint?.modelDef.model`. `LadderSlot` (Task 4) is the value stored in `runtime.ladderSlots` (Task 5) and read back by `ladderSlotFor`. `startDepth` is produced by `resolveDispatchTarget` (Task 5), passed as `AgentRunRequest.startDepth` (Task 7), and returned as `AgentRunOutcome.finalDepth` (Task 7) into `recordDispatchOutcome`'s `finalDepth` (Task 5). `ladderDepthOf`'s `same` parameter is supplied by the manager's `_sameHop` (Task 7).
