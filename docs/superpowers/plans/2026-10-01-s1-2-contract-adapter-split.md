# S1-2 Contract and Adapter Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land PR S1-2: the session contract stops depending on nax types, and the native adapter splits into a package-side `NativeSessionAdapter` plus `nativeComplete()` and a thin nax-side `NativeAgentAdapter` shell. The PR is behaviour-neutral.

**Architecture:** Every change happens in place under `packages/nax/src`. New contract files go into the S1 move manifest so the boundary ratchet counts them as moving. The contract (`session-types.ts`) drops its imports of nax's config, runtime and context-engine types. Leaf types move into new move-set files and the old homes re-export them. `ModelDef` in the contract becomes a package-owned `SessionModel`, built by one nax function (`toSessionModel`) where nax opens a session or makes a one-shot call. The native `AgentAdapter` class leaves `src/agents/native/`: what stays there implements only the contract, and nax composes it into the full adapter.

**Tech Stack:** TypeScript (ESM), Bun 1.4.0, `bun:test`, Biome. Package commands run from `packages/nax`.

**Spec:** `docs/superpowers/specs/2026-10-01-s1-nax-agent-carve-out-design.md`, sections 3, 4.1, 4.2 (ports 2 and 3), 6 and 8. Read it first.

**Base:** `main` @ `0a590ad9c` (S1-0 #2317 and S1-1 #2318 merged). Branch: `feat/s1-2-contract-adapter-split`. Line numbers below refer to that commit.

## Global Constraints

- Behaviour-neutral: no change to `nax run` output, cost rows, `metrics.json`, `nax config` output, stream events or any CLI text.
- Run package commands from `packages/nax`. Never run bare `bun test` (no path); single files run as `bun test <path> --timeout=60000`. Never `bun run nax`.
- Full verification: `bun run test`, `bun run typecheck`, `bun run lint`, and `bun run check:all` from the repo root.
- No test is edited to pass unless its subject moved or its port was cut. In this PR that means port 2 (contract types, adapter split) and port 3.
- Source files stay at or under 600 lines and test files at or under 800 (`check:file-sizes`). These are at or near the limit and must not grow: `src/agents/types.ts` (600; this PR must shrink it), `src/agents/manager.ts` (600), `src/agents/manager-dispatch.ts` (599), `src/session/manager.ts` (672, grandfathered), `test/unit/agents/native/adapter.test.ts` (796). Re-check with `wc -l` after editing any of them.
- Code blocks show content, not final formatting. Before every commit, run `bun x biome check --write <files you touched>`, then `bun run lint`.
- **Import rules** (`check:alias-internals`): in `src/`, a **value** import must go through a barrel (`@/agents/cost`, not `@/agents/cost/estimate`). A **type-only** import may target a leaf (`import type { X } from "@/agents/cost/standard-types"`). Relative imports (`../session-types`) are not checked by that gate, and existing code uses them where a barrel would close a cycle.
- `check:import-cycles` must stay green. If a new import closes a runtime cycle, use a relative leaf import or a type-only import instead of the barrel.
- The ratchet (`check:agent-boundary`) may only fall. Every task that lowers it ends with `bun run check:agent-boundary:update` and commits the baseline.
- Commit locally as the steps say. **Push and open the PR only after the user approves**.
- nax is a public repo: commit messages and PR text never name private projects.
- Commits use conventional prefixes (`refactor:`, `test:`, `chore:`, `docs:`), no emojis.

## Decisions this plan takes (flag in review if you disagree)

1. **The contract field keeps its name `modelDef`**, typed `SessionModel` instead of `ModelDef`. Renaming it to `model` would touch every handle fixture in the suite for no behaviour gain. S3 can rename it when it defines the embedder API.
2. **`SessionModel` is `{ provider, model, pricing?: Pricing, contextWindow?, env? }`.** `env` is included because the ACP adapter reads `modelDef.env` and implements the same contract (S4 moves it). `provider` is required, as in `ModelDef`, because endpoint identity compares it.
3. **`toSessionModel` lives in nax at `src/agents/session-model-mapping.ts`.** It is called in exactly two places: `selectModel` (SessionManager's session open) and the shell's `complete()`.
4. **Pricing conversion moves out of `buildRateCard`.** `buildRateCard(catalog, override?: Pricing)` no longer calls `toPricing`; `toSessionModel` does. Same numbers, one conversion site per entry path.
5. **The nax shell lives at `src/agents/native-agent/index.ts`.** It has to be outside `src/agents/native/`, which is a directory entry in the manifest and has no exclusions. A nested barrel lets callers import `@/agents/native-agent` directly.
6. **`SessionHandle.role` becomes `string`.** No adapter in `src/` sets it. `AgentManager.runAsSession` narrows it with `knownSessionRole()` (unknown or absent reads as absent), so a plugin adapter returning an unknown role falls back to the caller's role instead of reaching a `SessionRole`-typed event.
7. **Out of scope:** the cost core's value imports (`priceCall`, `inputClassTokens` through the `@/agents/cost` barrel), the logger and errors (S1-3), `ProviderCatalogOverride` and `PipelineStage` (port 4, S1-4), and the activity-event mapping (port 5, S1-4). The cost barrel edges belong to no S1 PR yet. Record that in the PR body so the SSOT can assign them (likely S1-4b).

## Review Focus

1. **A config pricing override without cache rates, reaching a native session through SessionManager.** Expected: the session prices with cache rates equal to that level's input rate, exactly as before (base from base input, each tier from its own input). Pinned by Task 2 step 1 (`toSessionModel` cases `base-missing-cache` and `tier-missing-cache`) and Task 3 step 1 (`selectModel` converts).
2. **A `ModelDef` without `pricing`, `contextWindow` or `env`.** Expected: `SessionModel` omits those keys entirely (absent, not `undefined`), so the native turn still prices from the catalog (`pricingSource: "catalog-rates"`). Pinned by Task 2 step 1 (`omits absent fields`).
3. **A plugin adapter whose handle carries a role string nax does not know.** Expected: the session-turn event uses the caller's `sessionRole`, then `"main"`, never the unknown string. Pinned by Task 2 step 1 (`knownSessionRole`).
4. **A failed session turn: its error event must attribute the same model as the success event would.** `handle.modelDef` is now a `SessionModel`. Expected: `model` and `effort` on the error event are unchanged. Pinned by Task 3 step 1 (`modelAttribution` with a `SessionModel`).
5. **The shell silently dropping a session method** (the declared-but-inert class): `closePhysicalSession` and `hasCredentials` are optional on the contract, so a missing forward still compiles. Expected: every contract method reaches the session adapter with its arguments. Pinned by Task 5 step 1 (shell forwarding test).

---

## File Structure

| File | Task | Responsibility |
|---|---|---|
| `src/agents/adapter-failure.ts` | 1 | `AdapterFailure` (moved from `context/engine/types.ts`) |
| `src/agents/tool-descriptor.ts` | 1 | `JSONSchema`, `ToolDescriptor` (moved from `context/engine/types.ts`) |
| `src/agents/agent-stream-event-types.ts` | 1 | `AgentStreamEvent` and its members (moved from `runtime/agent-stream-events.ts`; `stage` widened to `string`) |
| `src/permissions/types.ts` | 1 | gains `ResolvedPermissions` (moved from `config/permissions.ts`) |
| `scripts/s1-move-manifest.json` | 1 | four new entries |
| `src/agents/session-model-mapping.ts` | 2 | nax-side `toSessionModel(ModelDef): SessionModel` |
| `src/runtime/session-role.ts` | 2 | gains `knownSessionRole()` |
| `src/agents/session-types.ts` | 2, 3, 4 | `SessionModel` (Task 2); contract made nax-free (Task 3); `AgentSessionAdapter` (Task 4) |
| `src/session/model-selection.ts`, `src/session/endpoint-identity.ts`, `src/agents/manager-dispatch.ts`, `src/agents/manager.ts`, `src/agents/acp/adapter-lifecycle.ts`, `src/agents/native/models.ts`, `src/runtime/middleware/idle-watchdog/index.ts` | 3 | follow the contract type change |
| `src/agents/types.ts` | 4 | `AgentAdapter extends AgentSessionAdapter`; shrinks |
| `src/agents/native/adapter-deps.ts` | 5 | `_adapterDeps`, `isProtocolStreamError`, `authFields` (from `adapter.ts`) |
| `src/agents/native/session-adapter.ts` | 5 | `NativeSessionAdapter` (`git mv` of `adapter.ts`, keeps `sendTurn`'s history) |
| `src/agents/native/complete.ts` | 5 | `nativeComplete()` |
| `src/agents/native-agent/index.ts` | 5 | nax's `NativeAgentAdapter` shell |
| `scripts/baselines/{agent-boundary,complexity}-baseline.json`, `scripts/check-adapter-no-config-import.sh` | 5, 6 | baselines; gate scans the shell |

---

### Task 1: Contract leaf types join the move set (ports 2 and 3, type moves)

The contract's leaf types move into files listed in the manifest. Their old homes re-export them, so no importer outside the move set changes. Move-set files that imported them from nax barrels switch to the new files.

**Files:**
- Create: `src/agents/adapter-failure.ts`, `src/agents/tool-descriptor.ts`, `src/agents/agent-stream-event-types.ts`
- Modify: `src/context/engine/types.ts:10-109`, `src/runtime/agent-stream-events.ts:1-118`, `src/runtime/middleware/idle-watchdog/index.ts:47`, `src/config/permissions.ts:31-69`, `src/permissions/types.ts`, `src/permissions/index.ts`, `src/agents/session-types.ts:10-14,113`
- Modify (retarget imports): `src/agents/native/errors.ts:13`, `src/agents/native/session/tool-mapping.ts:10`, `src/tools/provider-types.ts:14`, `src/tools/registry.ts:13`, `src/agents/native/session/turn-events.ts:18`, `src/agents/native/session/compaction.ts:12`
- Modify: `scripts/s1-move-manifest.json`, `scripts/baselines/agent-boundary-baseline.json`

**Interfaces:**
- Produces (type-only, same shapes as today):
  - `src/agents/adapter-failure.ts`: `export interface AdapterFailure`
  - `src/agents/tool-descriptor.ts`: `export type JSONSchema`, `export interface ToolDescriptor`
  - `src/agents/agent-stream-event-types.ts`: `AgentStreamEventBase` (with `readonly stage?: string`), `AgentCallStartedEvent`, `AgentMessageUpdateEvent`, `AgentThinkingUpdateEvent`, `AgentUsageUpdateEvent`, `AgentToolCallUpdateEvent`, `AgentProcessUpdateEvent`, `AgentCallEndedEvent`, `AgentAwaitingHumanEvent`, `AgentStreamEvent`
  - `@/permissions` exports `type ResolvedPermissions`

- [ ] **Step 1: Record the edges this task must remove**

Run: `bun scripts/check-agent-boundary.ts --list | tail -1`
Expected: `101 boundary edge(s)`. These lines must be present now and absent after step 7:

```
src/agents/native/errors.ts -> src/context/engine/index.ts
src/agents/native/session/compaction.ts -> src/agents/index.ts
src/agents/native/session/tool-mapping.ts -> src/context/engine/index.ts
src/agents/native/session/turn-events.ts -> src/runtime/agent-stream-events.ts
src/agents/session-types.ts -> src/config/permissions.ts
src/agents/session-types.ts -> src/context/engine/index.ts
src/agents/session-types.ts -> src/runtime/agent-stream-events.ts
src/agents/session-types.ts -> src/runtime/protocol-types.ts
src/tools/provider-types.ts -> src/context/engine/index.ts
src/tools/registry.ts -> src/context/engine/index.ts
```

This task is type-only. Its "failing test" is this list plus `typecheck`, which go green together in step 7.

- [ ] **Step 2: Move `AdapterFailure`, `JSONSchema` and `ToolDescriptor`**

Create `src/agents/adapter-failure.ts`. Its body is `src/context/engine/types.ts` lines 14-84 verbatim (the doc comment through the interface's closing `}` on line 84), with this header:

```ts
/**
 * Failure descriptor returned (or synthesized) by an agent adapter. Part of the
 * session contract (S1 spec section 4.2, port 2); `context/engine` re-exports it.
 */
```

Inside the moved interface, change the `invalidToolCall` line to point at the sibling contract file:

```ts
  invalidToolCall?: import("./session-types").InvalidToolCallDetail;
```

Create `src/agents/tool-descriptor.ts` with `src/context/engine/types.ts` lines 90-109 verbatim (`JSONSchema` and `ToolDescriptor` with their doc comments) under:

```ts
/**
 * Pull-tool descriptor shapes shared by the context engine and the agent
 * contract (S1 spec section 4.2, port 2); `context/engine` re-exports them.
 */
```

In `src/context/engine/types.ts`, delete lines 14-84 and 90-109 and put this where the `AdapterFailure` section header was (line 10). The local import is needed because the file still uses both types (e.g. at the old lines 171 and 545). Use the `@/` alias: biome's `noRestrictedImports` bans `../../` paths.

```ts
import type { AdapterFailure } from "@/agents/adapter-failure";
import type { JSONSchema, ToolDescriptor } from "@/agents/tool-descriptor";

export type { AdapterFailure, JSONSchema, ToolDescriptor };
```

Keep the two section-header comment blocks only if they still head something; delete an empty one.

- [ ] **Step 3: Move the stream event types and widen `stage`**

Create `src/agents/agent-stream-event-types.ts` from `src/runtime/agent-stream-events.ts` lines 5-118 verbatim (`AgentStreamEventBase` through the `AgentStreamEvent` union), with one change in `AgentStreamEventBase`:

```ts
  /** Pipeline stage label. A plain string: the contract does not know nax's stage union. */
  readonly stage?: string;
```

and this header:

```ts
/**
 * Agent stream events: what an adapter reports while a call runs. Part of the
 * session contract (S1 spec section 4.2, port 2). `runtime/agent-stream-events`
 * re-exports these and keeps the bus.
 */
```

In `src/runtime/agent-stream-events.ts`, delete lines 5-118 and the `PipelineStage` import (line 1), and add:

```ts
import type { AgentStreamEvent } from "../agents/agent-stream-event-types";

export type {
  AgentAwaitingHumanEvent,
  AgentCallEndedEvent,
  AgentCallStartedEvent,
  AgentMessageUpdateEvent,
  AgentProcessUpdateEvent,
  AgentStreamEvent,
  AgentStreamEventBase,
  AgentThinkingUpdateEvent,
  AgentToolCallUpdateEvent,
  AgentUsageUpdateEvent,
} from "../agents/agent-stream-event-types";
```

`AgentStreamListener`, `IAgentStreamEventBus` and `AgentStreamEventBus` stay where they are.

In `src/runtime/middleware/idle-watchdog/index.ts:47`, widen the watchdog's copy of the field, because it is assigned from `event.stage`:

```ts
  readonly stage?: string;
```

If `PipelineStage` is now unused in that file's line-1 import, drop it from the import.

- [ ] **Step 4: Move `ResolvedPermissions` into `src/permissions/`**

Append `src/config/permissions.ts` lines 31-69 (`export interface ResolvedPermissions { ... }`, all field doc comments) verbatim to `src/permissions/types.ts`. Add the type import it needs at the top of `src/permissions/types.ts`:

```ts
import type { BashApprovalMode } from "@/config/bash-approval";
```

(`config/bash-approval.ts` is in the move set, and a type-only leaf import is allowed.)

In `src/permissions/index.ts`, change the last line to:

```ts
export type { AskRequest, ResolvedPermissions } from "./types";
```

In `src/config/permissions.ts`, replace the deleted interface with:

```ts
import type { ResolvedPermissions } from "@/permissions";

export type { ResolvedPermissions };
```

Then append the allow marker to the moved `mode:` line in `src/permissions/types.ts`, because `check:permission-mode-ssot` (run by root `check:all`, not by `lint`) flags the permission-mode literals anywhere outside `src/config/permissions.ts`:

```ts
  mode: "approve-all" | "approve-reads" | "default"; // nax-permission-mode-allow: type of the resolved value, moved with ResolvedPermissions
```

Every existing `import type { ResolvedPermissions } from "../config/permissions"` keeps working. If `BashApprovalMode` is no longer used as a type in `config/permissions.ts`, drop it from the `./bash-approval` import there and keep `resolveBashApproval`.

- [ ] **Step 5: Retarget move-set imports**

| File | Old | New |
|---|---|---|
| `src/agents/native/errors.ts:13` | `import type { AdapterFailure } from "@/context/engine";` | `import type { AdapterFailure } from "@/agents/adapter-failure";` |
| `src/agents/native/session/tool-mapping.ts:10` | `import type { ToolDescriptor } from "@/context/engine";` | `import type { ToolDescriptor } from "@/agents/tool-descriptor";` |
| `src/tools/provider-types.ts:14` | `import type { JSONSchema } from "@/context/engine";` | `import type { JSONSchema } from "@/agents/tool-descriptor";` |
| `src/tools/registry.ts:13` | `import type { JSONSchema } from "@/context/engine";` | `import type { JSONSchema } from "@/agents/tool-descriptor";` |
| `src/agents/native/session/turn-events.ts:18` | `import type { AgentStreamEvent } from "@/runtime/agent-stream-events";` | `import type { AgentStreamEvent } from "@/agents/agent-stream-event-types";` |
| `src/agents/native/session/compaction.ts:12` | `import type { AdapterInteractionResponse } from "@/agents";` | `import type { AdapterInteractionResponse } from "@/agents/interaction-handler";` |

In `src/agents/session-types.ts`, replace lines 10-14 with the block below (keep line 15, `import type { TokenUsage } from "./cost";`), and change the inline import in `onStreamActivity` at line 113:

```ts
import type { ResolvedPermissions } from "@/permissions";
import type { ProtocolIds } from "../runtime/protocol-types";
import type { SessionRole } from "../runtime/session-role";
import type { ModelDef, ModelTier } from "../config/schema";
import type { AdapterFailure } from "./adapter-failure";
import type { ToolDescriptor } from "./tool-descriptor";
```

```ts
  onStreamActivity?: (event: import("./agent-stream-event-types").AgentStreamEvent) => void;
```

(`ModelDef`, `ModelTier`, `SessionRole` and `./cost` stay until Task 3.)

- [ ] **Step 6: Add the manifest entries**

In `scripts/s1-move-manifest.json`, add after the `src/agents/session-types.ts` entry:

```json
    { "from": "src/agents/adapter-failure.ts", "to": "session/adapter-failure.ts" },
    { "from": "src/agents/tool-descriptor.ts", "to": "session/tool-descriptor.ts" },
    { "from": "src/agents/agent-stream-event-types.ts", "to": "session/agent-stream-events.ts" },
    { "from": "src/runtime/protocol-types.ts", "to": "session/protocol-types.ts" },
```

`runtime/protocol-types.ts` imports nothing, so listing it in place is enough. `test/unit/scripts/agent-move-manifest.test.ts:72` checks that every `from` exists on disk, which is why the entries land with the files.

- [ ] **Step 7: Verify and lock the ratchet**

Run: `bun run typecheck`
Expected: exit 0.

Run: `bun scripts/check-agent-boundary.ts --list | tail -1`
Expected: a count below 101.

Run: `bun scripts/check-agent-boundary.ts --list | grep -cE "(native/errors|tool-mapping|provider-types|tools/registry)\.ts -> src/context/engine|compaction\.ts -> src/agents/index|turn-events\.ts -> src/runtime/agent-stream|session-types\.ts -> src/(config/permissions|context/engine|runtime/agent-stream|runtime/protocol-types)"`
Expected: `0`. A remaining `turn-events.ts -> src/config/index.ts` is expected (port 4).

Run: `bun run check:permission-mode-ssot`
Expected: exit 0.

Run: `bun test test/unit/scripts/ test/unit/context/ test/unit/runtime/ --timeout=60000`
Expected: PASS.

Run: `bun run check:agent-boundary:update && bun x biome check --write src/agents/adapter-failure.ts src/agents/tool-descriptor.ts src/agents/agent-stream-event-types.ts src/context/engine/types.ts src/runtime/agent-stream-events.ts src/runtime/middleware/idle-watchdog/index.ts src/config/permissions.ts src/permissions/types.ts src/permissions/index.ts src/agents/session-types.ts src/agents/native/errors.ts src/agents/native/session/tool-mapping.ts src/tools/provider-types.ts src/tools/registry.ts src/agents/native/session/turn-events.ts src/agents/native/session/compaction.ts scripts/s1-move-manifest.json && bun run lint`
Expected: lint exit 0.

- [ ] **Step 8: Commit**

```bash
git add -A src scripts
git commit -m "refactor: move session-contract leaf types into the nax-agent move set"
```

---

### Task 2: `SessionModel`, `toSessionModel` and `knownSessionRole`

Adds the new type and the two nax-side helpers, with tests, before anything uses them. Nothing changes behaviour yet.

**Files:**
- Modify: `src/agents/session-types.ts` (add `SessionModel`)
- Create: `src/agents/session-model-mapping.ts`
- Modify: `src/runtime/session-role.ts` (add `knownSessionRole`)
- Test: `test/unit/agents/session-model-mapping.test.ts` (new), `test/unit/runtime/session-role.test.ts` (extend)

**Interfaces:**
- Produces:
  ```ts
  // src/agents/session-types.ts
  export interface SessionModel {
    readonly provider: string;
    readonly model: string;
    readonly pricing?: Pricing;          // nax-ai's, via ./cost/standard-types
    readonly contextWindow?: number;
    readonly env?: Record<string, string>;
  }
  // src/agents/session-model-mapping.ts
  export function toSessionModel(def: ModelDef): SessionModel;
  // src/runtime/session-role.ts
  export function knownSessionRole(role: string | undefined): SessionRole | undefined;
  ```

- [ ] **Step 1: Write the failing tests**

Create `test/unit/agents/session-model-mapping.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { toSessionModel } from "@/agents/session-model-mapping";
import type { ModelDef } from "@/config/schema-types";

describe("toSessionModel", () => {
  test("copies provider and model", () => {
    expect(toSessionModel({ provider: "openai", model: "openai/gpt-5.4-mini" })).toEqual({
      provider: "openai",
      model: "openai/gpt-5.4-mini",
    });
  });

  test("omits absent fields", () => {
    const out = toSessionModel({ provider: "p", model: "m" });
    expect("pricing" in out).toBe(false);
    expect("contextWindow" in out).toBe(false);
    expect("env" in out).toBe(false);
  });

  test("carries contextWindow and env unchanged", () => {
    const def: ModelDef = { provider: "p", model: "m", contextWindow: 50_000, env: { A: "1" } };
    expect(toSessionModel(def)).toEqual({ provider: "p", model: "m", contextWindow: 50_000, env: { A: "1" } });
  });

  test("base-missing-cache: converts config pricing; absent cache rates take the base input rate", () => {
    const def: ModelDef = { provider: "p", model: "m", pricing: { inputPer1M: 3, outputPer1M: 15 } };
    expect(toSessionModel(def).pricing).toEqual({ input: 3, output: 15, cacheRead: 3, cacheWrite: 3 });
  });

  test("tier-missing-cache: each tier's absent cache rates take that tier's own input rate", () => {
    const def: ModelDef = {
      provider: "p",
      model: "m",
      pricing: {
        inputPer1M: 3,
        outputPer1M: 15,
        cacheReadPer1M: 0.3,
        cacheCreationPer1M: 3.75,
        tiers: [{ inputPer1M: 6, outputPer1M: 22.5, inputTokensAbove: 200_000 }],
      },
    };
    expect(toSessionModel(def).pricing).toEqual({
      input: 3,
      output: 15,
      cacheRead: 0.3,
      cacheWrite: 3.75,
      tiers: [{ input: 6, output: 22.5, cacheRead: 6, cacheWrite: 6, inputTokensAbove: 200_000 }],
    });
  });
});
```

Add to `test/unit/runtime/session-role.test.ts` (import `knownSessionRole` beside the existing imports from the same module):

```ts
describe("knownSessionRole", () => {
  test("returns a known role unchanged", () => {
    expect(knownSessionRole("implementer")).toBe("implementer");
  });

  test("reads an unknown role as absent", () => {
    expect(knownSessionRole("plugin-private-role")).toBeUndefined();
  });

  test("reads an absent role as absent", () => {
    expect(knownSessionRole(undefined)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test test/unit/agents/session-model-mapping.test.ts test/unit/runtime/session-role.test.ts --timeout=60000`
Expected: FAIL. The module `@/agents/session-model-mapping` is not found, and `knownSessionRole` is not exported.

- [ ] **Step 3: Implement**

In `src/agents/session-types.ts`, add this import to the top import block (after the `./cost` import), and add the type after `AuthStamp`:

```ts
import type { Pricing } from "./cost/standard-types";
```

```ts
/**
 * The model a session runs on, in the contract's own vocabulary (S1 spec section
 * 4.2, port 2). nax builds it from its config `ModelDef` with `toSessionModel`
 * (`src/agents/session-model-mapping.ts`); `pricing` is already converted to the
 * standard rate card, so the session never sees config field names.
 */
export interface SessionModel {
  readonly provider: string;
  readonly model: string;
  /** Explicit rate override; absent means "price from the catalog". */
  readonly pricing?: Pricing;
  /** Overrides the catalog context window for compaction maths only (nax#1848). */
  readonly contextWindow?: number;
  /** Extra environment for transports that spawn a process (ACP). */
  readonly env?: Record<string, string>;
}
```

Create `src/agents/session-model-mapping.ts`:

```ts
/**
 * nax's one mapping from a config `ModelDef` to the contract's `SessionModel`
 * (S1 spec section 4.2, port 2). Called where nax opens a session
 * (`session/model-selection.ts`) and where the native shell makes a one-shot
 * call (`agents/native-agent`). Config pricing is converted here and nowhere
 * else on those paths. Absent fields stay absent rather than `undefined`, so a
 * missing override still means "use the catalog".
 */

import type { ModelDef } from "../config/schema-types";
import { toPricing } from "../config/schema-types";
import type { SessionModel } from "./session-types";

export function toSessionModel(def: ModelDef): SessionModel {
  return {
    provider: def.provider,
    model: def.model,
    ...(def.pricing !== undefined ? { pricing: toPricing(def.pricing) } : {}),
    ...(def.contextWindow !== undefined ? { contextWindow: def.contextWindow } : {}),
    ...(def.env !== undefined ? { env: def.env } : {}),
  };
}
```

(If `check:alias-internals` or `check:import-cycles` rejects the `../config/schema-types` value import, import `toPricing` from `../config` instead. Both export it.)

Append to `src/runtime/session-role.ts`:

```ts
/**
 * A handle's role narrowed to a role nax knows. The session contract carries
 * the role as an opaque string (S1 spec section 4.2, port 2); an unknown or
 * absent string reads as absent, so callers fall back to their own role.
 */
export function knownSessionRole(role: string | undefined): SessionRole | undefined {
  return role !== undefined && isSessionRole(role) ? role : undefined;
}
```

- [ ] **Step 4: Run them to verify they pass**

Run: `bun test test/unit/agents/session-model-mapping.test.ts test/unit/runtime/session-role.test.ts --timeout=60000`
Expected: PASS.

Run: `bun run typecheck`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
bun x biome check --write src/agents/session-types.ts src/agents/session-model-mapping.ts src/runtime/session-role.ts test/unit/agents/session-model-mapping.test.ts test/unit/runtime/session-role.test.ts && bun run lint
git add src/agents/session-types.ts src/agents/session-model-mapping.ts src/runtime/session-role.ts test/unit/agents/session-model-mapping.test.ts test/unit/runtime/session-role.test.ts
git commit -m "feat: add SessionModel with its nax mapping and knownSessionRole"
```

---

### Task 3: Make the contract nax-free

`session-types.ts` stops importing nax's config, cost barrel and role types. A prototype on the base commit found 9 source and 8 test sites that break when the types flip. Each fix is listed below; `tsc` confirms the list is complete.

**Files:**
- Modify: `src/agents/session-types.ts`
- Modify: `src/session/model-selection.ts`, `src/session/endpoint-identity.ts:15-49`, `src/agents/manager-dispatch.ts:63,281-282,303-304`, `src/agents/manager.ts:17-18,470`, `src/agents/acp/adapter-lifecycle.ts:9,308-309,325,344-345`, `src/agents/native/models.ts:10-11,176-182`, `src/agents/native/adapter.ts:247`
- Modify (type-only retargets): `src/agents/native/session/loop-events/types.ts:16`, `src/agents/native/session/rate-provenance.ts:1`, `src/agents/native/session/turn-accumulator.ts:14`, `src/agents/native/session/turn-types.ts:18,41`
- Test: `test/unit/session/model-selection.test.ts` (new), `test/unit/agents/manager-dispatch-error-event.test.ts` (extend)
- Test (follow the type change): `test/helpers/fake-agent-manager.ts:88`, `test/integration/agents/native/adapter-auth-stamp.test.ts:144,227`, `test/unit/agents/native/adapter-auth-stamp-seam.test.ts:95`, `test/unit/agents/native/adapter-complete-rates.test.ts:416`, `test/unit/agents/native/models.test.ts:244-247`, `test/unit/session/endpoint-identity.test.ts:7-9`

**Interfaces:**
- Consumes: `SessionModel`, `toSessionModel`, `knownSessionRole` (Task 2).
- Produces:
  - `SessionHandle.role?: string`, `SessionHandle.modelDef?: SessionModel`, `SessionHandle.modelTier?: string`
  - `OpenSessionOpts.modelDef: SessionModel`, `OpenSessionOpts.modelTier?: string`
  - `selectModel(opts: ModelSelection): { modelDef: SessionModel; modelTier?: string }`
  - `buildRateCard(catalog: Pricing, override: Pricing | undefined)`
  - `sameEndpoint(a: ModelDef | SessionModel | undefined, b: ModelDef | SessionModel | undefined): boolean`
  - `modelAttribution(src: { modelDef?: { readonly model: string }; modelTier?: string })`

- [ ] **Step 1: Write the failing tests**

Create `test/unit/session/model-selection.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { selectModel } from "@/session/model-selection";

describe("selectModel", () => {
  test("hands the adapter a SessionModel with config pricing converted", () => {
    const out = selectModel({
      modelDef: { provider: "p", model: "m", pricing: { inputPer1M: 2, outputPer1M: 8 } },
      modelTier: "balanced",
    });
    expect(out).toEqual({
      modelDef: { provider: "p", model: "m", pricing: { input: 2, output: 8, cacheRead: 2, cacheWrite: 2 } },
      modelTier: "balanced",
    });
  });

  test("omits modelTier when the model came from a pin", () => {
    expect("modelTier" in selectModel({ modelDef: { provider: "p", model: "m" } })).toBe(false);
  });
});
```

Add to `test/unit/agents/manager-dispatch-error-event.test.ts`. That file imports only `buildDispatchErrorEvent` today: change that line to `import { buildDispatchErrorEvent, modelAttribution } from "@/agents/manager-dispatch";` and add `import type { SessionModel } from "@/agents/session-types";` and `import type { ModelDef } from "@/config/schema-types";`. The models are typed variables, not inline literals: once the parameter is `{ readonly model: string }`, an inline literal with `provider` or `pricing` fails TypeScript's excess-property check.

```ts
describe("modelAttribution with a session handle's SessionModel", () => {
  test("attributes the same model and effort as a config ModelDef", () => {
    const configDef: ModelDef = { provider: "openai", model: "openai/gpt-5.4-mini[high]" };
    const sessionDef: SessionModel = {
      provider: "openai",
      model: "openai/gpt-5.4-mini[high]",
      pricing: { input: 1, output: 2, cacheRead: 1, cacheWrite: 1 },
    };
    const fromConfig = modelAttribution({ modelDef: configDef });
    const fromSession = modelAttribution({ modelDef: sessionDef });
    expect(fromSession).toEqual({ model: "openai/gpt-5.4-mini", effort: "high" });
    expect(fromSession).toEqual(fromConfig);
  });
});
```

(`parseModelSpec` reads the effort from a bracket suffix, `<model>[<effort>]`.)

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test test/unit/session/model-selection.test.ts --timeout=60000`
Expected: FAIL. `selectModel` returns the `ModelDef` unconverted (`pricing` has `inputPer1M`).

Run: `bun run typecheck`
Expected: FAIL in `manager-dispatch-error-event.test.ts`, because `modelAttribution` still takes `ModelDef`, which a `SessionModel` (with `Pricing`-shaped `pricing`) does not satisfy.

- [ ] **Step 3: Flip the contract types**

In `src/agents/session-types.ts`:
- Replace the import block with:

  ```ts
  import type { ResolvedPermissions } from "@/permissions";
  import type { ProtocolIds } from "../runtime/protocol-types";
  import type { AdapterFailure } from "./adapter-failure";
  import type { Pricing, PricingRates, TokenUsage } from "./cost/standard-types";
  import type { ToolDescriptor } from "./tool-descriptor";
  ```

- `SessionHandle`: `readonly role?: string;` (doc: "Session role, opaque to the adapter. nax writes a canonical role; read it through `knownSessionRole`."), `readonly modelDef?: SessionModel;`, `readonly modelTier?: string;`.
- `OpenSessionOpts`: `modelDef: SessionModel;` (doc: "The model to open with. nax builds it with `toSessionModel`."), `modelTier?: string;`.
- `TurnResult.rates`: `rates?: PricingRates;`.

Then fix each site:

1. `src/session/model-selection.ts`: return a `SessionModel`.

   ```ts
   import { toSessionModel } from "../agents/session-model-mapping";
   import type { SessionModel } from "../agents/session-types";
   import type { ModelDef, ModelTier } from "../config/schema";

   export interface ModelSelection {
     modelDef: ModelDef;
     modelTier?: ModelTier;
   }

   export function selectModel(opts: ModelSelection): { modelDef: SessionModel; modelTier?: string } {
     return { modelDef: toSessionModel(opts.modelDef), ...(opts.modelTier ? { modelTier: opts.modelTier } : {}) };
   }
   ```

   Keep the existing doc comments. Extend the `selectModel` doc with: "The `ModelDef` becomes the contract's `SessionModel` here; this is where config pricing is converted for session opens."

2. `src/session/endpoint-identity.ts`: compare either shape. Add `import type { SessionModel } from "../agents/session-types";` and change the signature at line 33:

   ```ts
   export function sameEndpoint(a: ModelDef | SessionModel | undefined, b: ModelDef | SessionModel | undefined): boolean {
   ```

   `decideReuse` keeps `requested.modelDef: ModelDef`.

3. `src/agents/manager-dispatch.ts` (599 lines, must not grow; these are in-place type edits):
   - line 63: `export function modelAttribution(src: { modelDef?: { readonly model: string }; modelTier?: string }): {`
   - lines 281-282 and 303-304: `modelDef?: { readonly model: string };` and `modelTier?: string;`
   - Drop `ModelDef` / `ModelTier` from the line-19 import if they become unused.

4. `src/agents/manager.ts` (600 lines, must not grow):
   - Merge lines 17-18 into `import { DispatchEventBus, type IDispatchEventBus } from "../runtime/dispatch-events";`
   - Add `import { knownSessionRole } from "../runtime/session-role";` (net 0 lines)
   - line 470: `const sessionRole = knownSessionRole(handle.role) ?? opts.sessionRole ?? "main";`

5. `src/agents/acp/adapter-lifecycle.ts`: replace `import type { ModelDef, ModelTier } from "@/config/schema";` with `import type { SessionModel } from "@/agents/session-types";`. `modelDef` and `_modelDef` (lines 308, 325, 344) become `SessionModel`, and `modelTier` (309, 345) becomes `string`. The ACP adapter reads only `.model` and `.env`.

6. `src/agents/native/models.ts`: `buildRateCard` takes the converted override.

   ```ts
   export function buildRateCard(
     catalog: Pricing,
     override: Pricing | undefined,
   ): { rates: Pricing; source: "config-override" | "catalog-rates" } {
     if (override !== undefined) return { rates: override, source: "config-override" };
     return { rates: catalog, source: "catalog-rates" };
   }
   ```

   Delete `import { toPricing } from "@/config";` and drop `ConfigPricing` from the `@/config/schema-types` import. In the doc comment above `buildRateCard`, change "`toPricing` fills" to "the caller converts the config override with `toPricing` (via `toSessionModel`), which fills".

7. `src/agents/native/adapter.ts:247` (the one-shot path, still a `ModelDef` until Task 5):

   ```ts
         const { rates, source: pricingSource } = buildRateCard(catalog, toSessionModel(options.modelDef).pricing);
   ```

   and add `import { toSessionModel } from "../session-model-mapping";`. It must be relative: a value import of `@/agents/session-model-mapping` from `src/` fails `check:alias-internals`, and one `../` level is allowed by biome. This temporary nax import goes away in Task 5. `sendTurn` (line 309) already passes `handle.modelDef?.pricing`, which is now `Pricing`.

8. `src/runtime/middleware/idle-watchdog/index.ts` was widened in Task 1. If `tsc` reports anything else there, widen the receiving field to `string` the same way.

9. Type-only retargets (contract-adjacent native session files):

   | File | New import |
   |---|---|
   | `src/agents/native/session/loop-events/types.ts:16` | `import type { TokenUsage } from "@/agents/cost/standard-types";` |
   | `src/agents/native/session/rate-provenance.ts:1` | `import type { PricingRates, TokenUsage } from "@/agents/cost/standard-types";` |
   | `src/agents/native/session/turn-accumulator.ts:14` | `import type { PricingRates, TokenUsage } from "@/agents/cost/standard-types";` |
   | `src/agents/native/session/turn-types.ts:18` | `import type { PricingRates, TokenUsage } from "@/agents/cost/standard-types";` |
   | `src/agents/native/session/turn-types.ts:41` | inline `import("../../cost").PricingRates` becomes `readonly rates?: PricingRates;` (otherwise the `turn-types.ts -> src/agents/cost/index.ts` edge survives) |

   Leave `turn-loop-round-trip.ts` (`inputClassTokens` is a value import; out of scope, Decision 7).

Test sites (their subject, the contract type, changed):

| File | Fix |
|---|---|
| `test/helpers/fake-agent-manager.ts:88` | `modelDef: toSessionModel(opts.modelDef),` with `import { toSessionModel } from "@/agents/session-model-mapping";` |
| `test/integration/agents/native/adapter-auth-stamp.test.ts:144,227` | `modelDef: toSessionModel(MODEL_DEF),` (same import) |
| `test/unit/agents/native/adapter-auth-stamp-seam.test.ts:95` | `modelDef: toSessionModel(MODEL_DEF),` |
| `test/unit/agents/native/adapter-complete-rates.test.ts:416` | `modelDef: toSessionModel(modelDef),` (the helper keeps taking a config `ModelDef`, so these tests still exercise the conversion) |
| `test/unit/agents/native/models.test.ts:247` | `const { rates, source } = buildRateCard(catalog, toPricing(override));` (the expectations are unchanged) |
| `test/unit/session/endpoint-identity.test.ts:7-9` | `const model = (id: string, provider = "p") => ({ provider, model: id });` and `const handle = (agentName: string, modelDef: SessionModel): SessionHandle => ({ id: "nax-x", agentName, modelDef });` with `import type { SessionHandle, SessionModel } from "@/agents/session-types";`; drop the unused `ModelDef` import |

- [ ] **Step 4: Verify**

Run: `bun run typecheck`
Expected: exit 0. Any error not covered above is a site the prototype missed. Fix it by the same rule: a reader of `modelDef` that needs only `model`/`provider` widens its parameter type, and a producer of `OpenSessionOpts` from config calls `toSessionModel`. List it in the commit body.

Run: `bun test test/unit/session/ test/unit/agents/ test/unit/runtime/ test/integration/agents/ --timeout=60000`
Expected: PASS, including both new tests.

Run: `bun scripts/check-agent-boundary.ts --list | grep -E "session-types.ts|rate-provenance|turn-accumulator|turn-types|loop-events/types"`
Expected: no `session-types.ts` line, and none of the four retargeted files paired with `src/agents/cost/index.ts`. (`native/models.ts -> src/config/index.ts` stays: `models.ts:18` re-exports `NATIVE_AGENT_NAME` from `@/config`, port 4.)

Run: `wc -l src/agents/manager.ts src/agents/manager-dispatch.ts`
Expected: `manager.ts` 600, `manager-dispatch.ts` 598 (both must not exceed their start sizes, 600 and 599).

- [ ] **Step 5: Commit**

```bash
bun run check:agent-boundary:update
bun x biome check --write $(git diff --name-only --relative -- src test scripts) test/unit/session/model-selection.test.ts && bun run lint
git add -A src test scripts/baselines/agent-boundary-baseline.json
git commit -m "refactor: session contract carries SessionModel and opaque role and tier"
```

---

### Task 4: `AgentSessionAdapter` splits out of `AgentAdapter`

**Files:**
- Modify: `src/agents/session-types.ts` (add `AgentSessionAdapter`)
- Modify: `src/agents/types.ts:16-35,537-600`

**Interfaces:**
- Produces:
  ```ts
  export interface AgentSessionAdapter {
    hasCredentials?(): Promise<boolean>;
    openSession(name: string, opts: OpenSessionOpts): Promise<SessionHandle>;
    sendTurn(handle: SessionHandle, prompt: string, opts: SendTurnOpts): Promise<TurnResult>;
    closeSession(handle: SessionHandle): Promise<void>;
    closePhysicalSession?(handle: string, workdir: string, options?: { force?: boolean; signal?: AbortSignal }): Promise<void>;
  }
  // src/agents/types.ts
  export interface AgentAdapter extends AgentSessionAdapter { name; displayName; binary; capabilities; isInstalled(); buildCommand(); complete(); }
  ```

- [ ] **Step 1: Move the session methods**

Append to `src/agents/session-types.ts`:

```ts
/**
 * The session half of an agent adapter: the surface a session runtime needs
 * (S1 spec section 4.2, port 2). nax's `AgentAdapter` extends it with the
 * process-description members and one-shot `complete()`.
 */
export interface AgentSessionAdapter {
```

Inside it, put `src/agents/types.ts` lines 550-555 (`hasCredentials?`) and 566-599 (`openSession`, `sendTurn`, `closeSession`, `closePhysicalSession?`) verbatim, doc comments included, then close it with `}`. In the `closePhysicalSession` doc, keep the `src/execution/session-manager-runtime.ts` reference. It is a doc pointer, not an import.

In `src/agents/types.ts`:
- Add `AgentSessionAdapter` and `SessionModel` to the `./session-types` re-export block at lines 27-34, and `AgentSessionAdapter` to the type import at lines 16-23.
- Change line 537 to `export interface AgentAdapter extends AgentSessionAdapter {` and delete the moved members (lines 550-555 and 566-599). `name`, `displayName`, `binary`, `capabilities`, `isInstalled`, `buildCommand` and `complete` stay.
- Drop `OpenSessionOpts`, `SendTurnOpts`, `SessionHandle` and `TurnResult` from the lines 16-23 type import (biome `noUnusedImports` fails lint otherwise). The result is `import type { AgentSessionAdapter, AuthStamp, TrackedSpawnDeadlineOptions } from "./session-types";`. The re-exports stay.

- [ ] **Step 2: Verify**

Run: `bun run typecheck && wc -l src/agents/types.ts src/agents/session-types.ts`
Expected: typecheck exit 0; `types.ts` about 553 lines; `session-types.ts` about 434.

Run: `bun test test/unit/agents/ --timeout=60000`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
bun x biome check --write src/agents/types.ts src/agents/session-types.ts && bun run lint
git add src/agents/types.ts src/agents/session-types.ts
git commit -m "refactor: split the session subset of AgentAdapter into AgentSessionAdapter"
```

---

### Task 5: Split the native adapter

`src/agents/native/adapter.ts` becomes three move-set files: shared seams, the session adapter and the one-shot function. nax gets a thin `NativeAgentAdapter` that composes them.

**Files:**
- Create: `src/agents/native/adapter-deps.ts`, `src/agents/native/complete.ts`, `src/agents/native-agent/index.ts`
- Rename: `src/agents/native/adapter.ts` → `src/agents/native/session-adapter.ts` (`git mv`)
- Modify: `src/agents/native/client.ts` (export `NativeCatalogOverrides`), `src/agents/native/index.ts`, `src/agents/registry.ts:13`, `src/cli/agents.ts:9`, `scripts/check-adapter-no-config-import.sh:10`, `scripts/baselines/complexity-baseline.json:28`
- Test: `test/unit/agents/native/complete.test.ts` (new), `test/unit/agents/native-agent/index.test.ts` (new)
- Test (retarget; their subject moved): the 11 files in step 5

**Interfaces:**
- Consumes: `AgentSessionAdapter` (Task 4), `SessionModel`, `toSessionModel` (Task 2).
- Produces:
  ```ts
  // src/agents/native/client.ts
  export type NativeCatalogOverrides = readonly ProviderCatalogOverride[];
  // src/agents/native/adapter-deps.ts
  export const _adapterDeps: { listStoredProviders; anyAmbientCredential; authSourceIsExec; servedAuth; setTimeout; clearTimeout };
  export function isProtocolStreamError(err: unknown): err is { protocolError: { kind: string; message: string } };
  export function authFields(provider: string): { auth?: AuthStamp };
  // src/agents/native/complete.ts
  export interface NativeCompleteOptions { readonly model: SessionModel; readonly maxTokens?: number; readonly timeoutMs?: number }
  export interface NativeCompleteContext { readonly catalogOverrides: NativeCatalogOverrides; readonly sessionKey: string }
  export interface NativeCompleteResult {
    output: string; tokenUsage: TokenUsage; estimatedCostUsd: number; sessionId?: string;
    pricingSource?: "catalog-rates" | "config-override"; rates?: PricingRates; auth?: AuthStamp; adapterFailure?: AdapterFailure;
  }
  export function nativeComplete(prompt: string, options: NativeCompleteOptions, context: NativeCompleteContext): Promise<NativeCompleteResult>;
  // src/agents/native/session-adapter.ts
  export class NativeSessionAdapter implements AgentSessionAdapter { constructor(catalogOverrides?: NativeCatalogOverrides) }
  // src/agents/native-agent/index.ts
  export class NativeAgentAdapter implements AgentAdapter {
    constructor(supportedTiers?: readonly string[], catalogOverrides?: readonly ProviderCatalogOverride[], sessions?: Required<AgentSessionAdapter>)
  }
  ```

- [ ] **Step 1: Write the failing tests**

Create `test/unit/agents/native/complete.test.ts`:

```ts
/**
 * nativeComplete: the package-side one-shot call (S1 port 2). Options are
 * package-owned: a SessionModel whose pricing is already converted.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { Client, ResolvedModel } from "@nathapp/nax-ai";
import { _clientDeps, _resetNativeClient } from "@/agents/native/client";
import { nativeComplete } from "@/agents/native/complete";
import { nativeSessionId } from "@/agents/native/session-affinity";

const REAL_BUILD = _clientDeps.build;
afterEach(() => {
  _clientDeps.build = REAL_BUILD;
  _resetNativeClient();
});

const CATALOG = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
const MODEL = {
  id: "gpt-5.4-mini",
  provider: "openai",
  protocol: "openai-responses",
  pricing: CATALOG,
  contextWindow: 128_000,
  supportsTools: true,
  thinkingLevels: [],
} satisfies ResolvedModel;

function fakeClient(complete: Client["complete"]): Client {
  return {
    model: async () => MODEL,
    listModels: async () => [MODEL],
    pricing: () => CATALOG,
    stream: async function* stream() {},
    complete,
    validate: () => {},
  };
}

const CONTEXT = { catalogOverrides: [], sessionKey: "key-1" };

describe("nativeComplete", () => {
  test("prices from the catalog when the model carries no override", async () => {
    _clientDeps.build = async () =>
      fakeClient(async () => ({ text: "ok", usage: { inputTokens: 1_000_000, outputTokens: 0 }, stopReason: "stop" }));
    const out = await nativeComplete("hi", { model: { provider: "openai", model: "openai/gpt-5.4-mini" } }, CONTEXT);
    expect(out.output).toBe("ok");
    expect(out.pricingSource).toBe("catalog-rates");
    expect(out.estimatedCostUsd).toBe(3);
    expect(out.sessionId).toBe(nativeSessionId("key-1"));
  });

  test("an explicit override wins wholesale", async () => {
    _clientDeps.build = async () =>
      fakeClient(async () => ({ text: "ok", usage: { inputTokens: 1_000_000, outputTokens: 0 }, stopReason: "stop" }));
    const pricing = { input: 7, output: 9, cacheRead: 7, cacheWrite: 7 };
    const out = await nativeComplete("hi", { model: { provider: "openai", model: "openai/gpt-5.4-mini", pricing } }, CONTEXT);
    expect(out.pricingSource).toBe("config-override");
    expect(out.estimatedCostUsd).toBe(7);
  });

  test("a protocol fault is returned as an adapter failure with zero usage", async () => {
    _clientDeps.build = async () =>
      fakeClient(async () => {
        throw Object.assign(new Error("bad key"), { protocolError: { kind: "auth", message: "bad key" } });
      });
    const out = await nativeComplete("hi", { model: { provider: "openai", model: "openai/gpt-5.4-mini" } }, CONTEXT);
    expect(out.output).toBe("");
    expect(out.tokenUsage).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(out.adapterFailure?.outcome).toBe("fail-auth");
  });
});
```

(`toAdapterFailure` maps kind `"auth"` to `fail-auth`, `src/agents/native/errors.ts:23-26`.)

Create `test/unit/agents/native-agent/index.test.ts`:

```ts
/**
 * nax's NativeAgentAdapter shell (S1 port 2): process-description members
 * answered locally, session methods forwarded, complete() mapped onto
 * nativeComplete with config pricing converted on the way.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { Client, ResolvedModel } from "@nathapp/nax-ai";
import { NativeAgentAdapter } from "@/agents/native-agent";
import { _clientDeps, _resetNativeClient } from "@/agents/native/client";
import type { AgentSessionAdapter, OpenSessionOpts, SessionHandle, TurnResult } from "@/agents/session-types";
import type { ResolvedCompleteOptions } from "@/agents/types";

const REAL_BUILD = _clientDeps.build;
afterEach(() => {
  _clientDeps.build = REAL_BUILD;
  _resetNativeClient();
});

const HANDLE: SessionHandle = { id: "s", agentName: "native" };
const TURN: TurnResult = {
  output: "t",
  tokenUsage: { inputTokens: 0, outputTokens: 0 },
  estimatedCostUsd: 0,
  internalRoundTrips: 1,
};
const OPEN_OPTS: OpenSessionOpts = {
  agentName: "native",
  workdir: "/w",
  resolvedPermissions: { mode: "approve-all", bashApproval: "raw" },
  modelDef: { provider: "p", model: "p/m" },
  timeoutSeconds: 1,
};

function recordingSessions(): { calls: Array<[string, unknown[]]>; sessions: Required<AgentSessionAdapter> } {
  const calls: Array<[string, unknown[]]> = [];
  const sessions: Required<AgentSessionAdapter> = {
    hasCredentials: async (...a) => {
      calls.push(["hasCredentials", a]);
      return false;
    },
    openSession: async (...a) => {
      calls.push(["openSession", a]);
      return HANDLE;
    },
    sendTurn: async (...a) => {
      calls.push(["sendTurn", a]);
      return TURN;
    },
    closeSession: async (...a) => {
      calls.push(["closeSession", a]);
    },
    closePhysicalSession: async (...a) => {
      calls.push(["closePhysicalSession", a]);
    },
  };
  return { calls, sessions };
}

describe("NativeAgentAdapter shell", () => {
  test("forwards every session method with its arguments", async () => {
    const { calls, sessions } = recordingSessions();
    const adapter = new NativeAgentAdapter(undefined, [], sessions);
    const handle = HANDLE;
    expect(await adapter.hasCredentials()).toBe(false);
    expect(await adapter.openSession("s", OPEN_OPTS)).toBe(HANDLE);
    expect(await adapter.sendTurn(handle, "p", { interactionHandler: { onInteraction: async () => null } })).toBe(TURN);
    await adapter.closeSession(handle);
    await adapter.closePhysicalSession("s", "/w", { force: true });
    expect(calls.map(([m]) => m)).toEqual([
      "hasCredentials",
      "openSession",
      "sendTurn",
      "closeSession",
      "closePhysicalSession",
    ]);
    expect(calls[1]?.[1]).toEqual(["s", OPEN_OPTS]);
    expect(calls[4]?.[1]).toEqual(["s", "/w", { force: true }]);
  });

  test("answers the process-description members itself", async () => {
    const adapter = new NativeAgentAdapter([]);
    expect(adapter.name).toBe("native");
    expect(adapter.binary).toBe("");
    expect(adapter.buildCommand()).toEqual([]);
    expect(await adapter.isInstalled()).toBe(true);
    expect(adapter.capabilities.supportedTiers).toEqual(["fast", "balanced", "powerful"]);
  });

  test("complete() converts a config pricing override before pricing", async () => {
    const model = {
      id: "gpt-5.4-mini",
      provider: "openai",
      protocol: "openai-responses",
      pricing: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
      contextWindow: 128_000,
      supportsTools: true,
      thinkingLevels: [],
    } satisfies ResolvedModel;
    _clientDeps.build = async () =>
      ({
        model: async () => model,
        listModels: async () => [model],
        pricing: () => model.pricing,
        stream: async function* stream() {},
        complete: async () => ({ text: "ok", usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 }, stopReason: "stop" }),
        validate: () => {},
      }) satisfies Client;
    const options: ResolvedCompleteOptions = {
      modelDef: { provider: "openai", model: "openai/gpt-5.4-mini", pricing: { inputPer1M: 2, outputPer1M: 8 } },
      workdir: "/w",
      resolvedPermissions: { mode: "approve-all", bashApproval: "raw" },
    };
    const out = await new NativeAgentAdapter().complete("hi", options);
    expect(out.pricingSource).toBe("config-override");
    // cacheRead was absent in config, so it takes the input rate (2 per 1M).
    expect(out.rates?.cacheRead).toBe(2);
    expect(out.estimatedCostUsd).toBe(2);
  });
});
```

`cacheReadTokens` is nax-ai's field name (`packages/nax-ai/src/types.ts:38`). If the `"native"` name check fails, compare against `NATIVE_AGENT` from `@/agents/native` instead of the literal. Tests here use no `as` casts: `check-test-escape-hatches` counts them against a baseline.

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test test/unit/agents/native/complete.test.ts test/unit/agents/native-agent/index.test.ts --timeout=60000`
Expected: FAIL. `@/agents/native/complete` and `@/agents/native-agent` are not found.

- [ ] **Step 3: Split the file**

**Line numbers.** Every "old lines" reference in this step points at the base blob. Read it with `git show 0a590ad9c:packages/nax/src/agents/native/adapter.ts`, and copy from that output. Task 3 added one import line to the working copy, so the working-copy numbers are one higher from line 17 on.

```bash
git mv src/agents/native/adapter.ts src/agents/native/session-adapter.ts
```

(a) `src/agents/native/client.ts`: under the `ProviderCatalogOverride` import, add

```ts
/** The catalog overrides a native client is built with (`agent.native.catalogOverrides`). */
export type NativeCatalogOverrides = readonly ProviderCatalogOverride[];
```

and use it for `getNativeClient`'s parameter type.

(b) Create `src/agents/native/adapter-deps.ts` holding, verbatim from the old `adapter.ts`, lines 55-57 (`isProtocolStreamError`, now `export function`), 75-96 (`_adapterDeps`) and 113-123 (`authFields`, now `export function`), with this header and imports:

```ts
/**
 * Seams and small helpers shared by the native session adapter and
 * `nativeComplete` (S1 port 2). `_adapterDeps` is the test seam the adapter
 * tests patch; both callers read it from here, so one patch reaches both.
 */

import type { AuthStamp } from "../session-types";
import { anyAmbientCredential, listStoredProviders } from "./auth";
import { authSourceIsExec, servedAuth } from "./credentials";
```

(c) Create `src/agents/native/complete.ts`. The body of `nativeComplete` is the old `complete()` body (old lines 218-296) with these substitutions: `options.modelDef.model` → `options.model.model`; `options.modelDef.pricing` / the Task 3 `toSessionModel(...)` call → `options.model.pricing`; `this.catalogOverrides` → `context.catalogOverrides`; `this.oneShotKey` → `context.sessionKey`. Keep every comment.

```ts
/**
 * One-shot completion over nax-ai, with no session (S1 port 2). Package-owned
 * options: the caller passes a `SessionModel` whose pricing is already in the
 * standard vocabulary, and the per-adapter one-shot session key.
 */

import { priceCall } from "@/agents/cost";
import type { AdapterFailure } from "../adapter-failure";
import type { PricingRates, TokenUsage } from "../cost/standard-types";
import type { AuthStamp, SessionModel } from "../session-types";
import { _adapterDeps, authFields, isProtocolStreamError } from "./adapter-deps";
import { getNativeClient, type NativeCatalogOverrides } from "./client";
import { toAdapterFailure } from "./errors";
import { buildRateCard, parseNativeModel, toThinkingLevel } from "./models";
import { nativeSessionId } from "./session-affinity";

export interface NativeCompleteOptions {
  readonly model: SessionModel;
  readonly maxTokens?: number;
  readonly timeoutMs?: number;
}

export interface NativeCompleteContext {
  readonly catalogOverrides: NativeCatalogOverrides;
  /**
   * The caller's one-shot session key (`newSessionKey()`), held per adapter
   * instance so a run's one-shots share a backend and keep a cache warm.
   */
  readonly sessionKey: string;
}

export interface NativeCompleteResult {
  output: string;
  tokenUsage: TokenUsage;
  estimatedCostUsd: number;
  sessionId?: string;
  pricingSource?: "catalog-rates" | "config-override";
  rates?: PricingRates;
  auth?: AuthStamp;
  adapterFailure?: AdapterFailure;
}

export async function nativeComplete(
  prompt: string,
  options: NativeCompleteOptions,
  context: NativeCompleteContext,
): Promise<NativeCompleteResult> {
  // modelDef.provider is deliberately ignored ... (old lines 218-222 comment, verbatim)
  const { provider, model, effort } = parseNativeModel(options.model.model);
  const thinking = toThinkingLevel(effort);
  const client = await getNativeClient(context.catalogOverrides);
  const resolved = await client.model(provider, model);
  // ... old lines 228-296 verbatim, with the substitutions above
}
```

(d) Edit `src/agents/native/session-adapter.ts` (the renamed file):
- New header (replace old lines 1-9 entirely; old lines 5-8 start mid-sentence and the "no binary" part belongs to the shell):

  ```ts
  /**
   * The native session adapter: openSession / sendTurn / closeSession over
   * nax-ai, no subprocess. openSession/closeSession are transcript-file
   * bookkeeping, and sendTurn maps the native turn loop (session/turn-loop.ts)
   * over complete() — nax owns the conversation because nax-ai's client is
   * stateless (ADR-027 section 10, ADR-028).
   */
  ```
- Delete what moved: `CONSERVATIVE_CONTEXT_TOKENS` and `DEFAULT_TIERS` (to the shell), `isProtocolStreamError`, `_adapterDeps` and `authFields` (to `adapter-deps.ts`), `complete()` (to `complete.ts`), `isInstalled`, `buildCommand`, the constructor's capabilities block and `oneShotKey` (to the shell).
- Keep `FALLBACK_TURN_TIMEOUT_SECONDS`, `summaryPrompt`, `loopHandlerDeps`, `hasCredentials`, `openSession`, `sendTurn`, `closeSession` and `closePhysicalSession` verbatim.
- Class header:

  ```ts
  export class NativeSessionAdapter implements AgentSessionAdapter {
    constructor(private readonly catalogOverrides: NativeCatalogOverrides = []) {}
  ```

- Imports: keep `randomUUID`, `priceCall` from `@/agents/cost`, `getSafeLogger`, `createTurnDeadline`, `toAdapterFailure`, `NATIVE_AGENT`, `buildRateCard`, `parseNativeModel`, `resolveContextWindow`, `toThinkingLevel`, `nativeSessionId` and the `./session/*` imports (`closePhysicalSession` needs `NATIVE_AGENT`). Drop `@/agents/types`, `@/config/schema-types`, `../session-model-mapping`, `./auth`, `./credentials` and `newSessionKey`. Import `SessionTurnError` and the contract types from `../session-types`:

  ```ts
  import {
    type AgentSessionAdapter,
    type OpenSessionOpts,
    type SendTurnOpts,
    type SessionHandle,
    SessionTurnError,
    type TurnResult,
  } from "../session-types";
  import { _adapterDeps, authFields, isProtocolStreamError } from "./adapter-deps";
  import { getNativeClient, type NativeCatalogOverrides } from "./client";
  ```

  (`../session-types` is a relative leaf import, like the old `../types`, and stays clear of the `agents/index` cycle.)
- `closePhysicalSession` keeps its signature `(handle: string, _workdir?: string, _options?: {...})`.

(e) `src/agents/native/index.ts`: replace `export { NativeAgentAdapter } from "./adapter";` with

```ts
export { _adapterDeps } from "./adapter-deps";
export type { NativeCatalogOverrides } from "./client";
export {
  type NativeCompleteContext,
  type NativeCompleteOptions,
  type NativeCompleteResult,
  nativeComplete,
} from "./complete";
export { NativeSessionAdapter } from "./session-adapter";
export { newSessionKey } from "./session-affinity";
```

and change the header sentence "Everything outside it consumes the AgentAdapter interface" to "nax composes it into its AgentAdapter in `src/agents/native-agent/`."

(f) Create `src/agents/native-agent/index.ts`:

```ts
/**
 * nax's native AgentAdapter (S1 port 2): the full adapter surface nax's
 * registry and manager use, composed from the package-side session adapter
 * and `nativeComplete`. Lives outside `src/agents/native/` because that
 * directory moves into `@nathapp/nax-agent` and `AgentAdapter` stays in nax.
 *
 * Members that describe a process are answered honestly rather than faked:
 * there is no binary, no command and no pid.
 */

import type { ProviderCatalogOverride } from "@/config/schema-types";
import { NATIVE_AGENT, NativeSessionAdapter, nativeComplete, newSessionKey } from "../native";
import { toSessionModel } from "../session-model-mapping";
import type { AgentSessionAdapter, OpenSessionOpts, SendTurnOpts, SessionHandle, TurnResult } from "../session-types";
import type { AgentAdapter, AgentCapabilities, CompleteResult, ResolvedCompleteOptions } from "../types";

/** Conservative until capabilities become model-derived (ADR-027 Open Question 3). */
const CONSERVATIVE_CONTEXT_TOKENS = 128_000;

/** The builtin names, used when the adapter is built without config. */
const DEFAULT_TIERS: readonly string[] = ["fast", "balanced", "powerful"];

export class NativeAgentAdapter implements AgentAdapter {
  readonly name = NATIVE_AGENT;
  readonly displayName = "Native (nax-ai)";
  /** Nothing to spawn. Not a placeholder — the absence is the fact. */
  readonly binary = "";
  readonly capabilities: AgentCapabilities;
  // (old lines 141-148 doc comment for the one-shot key, verbatim)
  private readonly oneShotKey = newSessionKey();
  private readonly sessions: Required<AgentSessionAdapter>;

  // (old lines 132-140 doc comment on supportedTiers, verbatim)
  constructor(
    supportedTiers: readonly string[] = DEFAULT_TIERS,
    private readonly catalogOverrides: readonly ProviderCatalogOverride[] = [],
    /** Test seam: the session adapter to compose. Production passes nothing. */
    sessions?: Required<AgentSessionAdapter>,
  ) {
    this.sessions = sessions ?? new NativeSessionAdapter(catalogOverrides);
    this.capabilities = {
      supportedTiers: supportedTiers.length > 0 ? supportedTiers : DEFAULT_TIERS,
      maxContextTokens: CONSERVATIVE_CONTEXT_TOKENS,
      features: new Set<"tdd" | "review" | "refactor" | "batch">(["review"]),
    };
  }

  // (old lines 164-173 doc comment, verbatim)
  async isInstalled(): Promise<boolean> {
    return true;
  }

  hasCredentials(): Promise<boolean> {
    return this.sessions.hasCredentials();
  }

  /** Dry-run display shows no process, because there is none. */
  buildCommand(): string[] {
    return [];
  }

  complete(prompt: string, options: ResolvedCompleteOptions): Promise<CompleteResult> {
    return nativeComplete(
      prompt,
      {
        model: toSessionModel(options.modelDef),
        ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      },
      { catalogOverrides: this.catalogOverrides, sessionKey: this.oneShotKey },
    );
  }

  openSession(name: string, opts: OpenSessionOpts): Promise<SessionHandle> {
    return this.sessions.openSession(name, opts);
  }

  sendTurn(handle: SessionHandle, prompt: string, opts: SendTurnOpts): Promise<TurnResult> {
    return this.sessions.sendTurn(handle, prompt, opts);
  }

  closeSession(handle: SessionHandle): Promise<void> {
    return this.sessions.closeSession(handle);
  }

  closePhysicalSession(
    handle: string,
    workdir: string,
    options?: { force?: boolean; signal?: AbortSignal },
  ): Promise<void> {
    return this.sessions.closePhysicalSession(handle, workdir, options);
  }
}
```

Do not name the field `adapter` or `agent`. `test/integration/cli/adapter-boundary.test.ts` greps `adapter.openSession(` and `agent.openSession(` outside the wiring layer.

(g) Callers: `src/agents/registry.ts:13` becomes `import { NATIVE_AGENT } from "./native";` plus `import { NativeAgentAdapter } from "./native-agent";`. `src/cli/agents.ts:9` becomes `import { NATIVE_AGENT } from "../agents/native";` plus `import { NativeAgentAdapter } from "../agents/native-agent";`.

(h) `scripts/check-adapter-no-config-import.sh:10`: `scan_dirs="src/agents/acp/ src/agents/native/ src/agents/native-agent/"`. The shell must not read config either.

(i) `scripts/baselines/complexity-baseline.json:28`: re-key the entry, same score:

```json
    "src/agents/native/session-adapter.ts": { "sendTurn": 21 },
```

(sorted where biome or the script expects; run `bun run check:complexity` to confirm the order is accepted).

- [ ] **Step 4: Run the new tests**

Run: `bun test test/unit/agents/native/complete.test.ts test/unit/agents/native-agent/index.test.ts --timeout=60000`
Expected: PASS.

- [ ] **Step 5: Retarget the tests whose subject moved**

Session-only files (they never call `complete()` or the process-description members) move to `NativeSessionAdapter`. Replace the import of `NativeAgentAdapter` from `@/agents/native/adapter` with `import { NativeSessionAdapter } from "@/agents/native/session-adapter";`, `new NativeAgentAdapter()` with `new NativeSessionAdapter()`, and type references like `NativeAgentAdapter["openSession"]` the same way:
- `test/unit/agents/native/adapter-has-credentials.test.ts` (`_adapterDeps` now from `@/agents/native/adapter-deps`)
- `test/unit/agents/native/adapter-turn-signal.test.ts` (same)
- `test/unit/agents/native/adapter-loop-handlers.test.ts`

Files that call `complete()` keep the nax shell, so they stay nax wiring tests. Import `NativeAgentAdapter` from `@/agents/native-agent` and `_adapterDeps` from `@/agents/native/adapter-deps`. Constructor calls are unchanged.
- `test/unit/agents/native/adapter.test.ts` (796 lines: the import split must not take it past 800)
- `test/unit/agents/native/adapter-complete-rates.test.ts`
- `test/unit/agents/native/adapter-auth-stamp-seam.test.ts`
- `test/unit/agents/native/adapter-scope-id.test.ts`
- `test/integration/agents/native/adapter-auth-stamp.test.ts`
- `test/integration/agents/native/credential-fault-classification.test.ts`
- `test/unit/agents/registry-native.test.ts` (`import { NativeAgentAdapter } from "@/agents/native-agent";`)
- `test/integration/plugins/loop-handler-delivery.test.ts` (it hands the adapter to `new SessionManager({ getAdapter })`, which needs a full `AgentAdapter`, so it stays on the shell even though it only opens sessions)

Leave `test/unit/scripts/check-nax-ai-imports.test.ts:37` alone. Its `"./native"` string is fixture text, not an import.

Update the stale doc pointer at `src/config/schemas-protocol-gate.ts:108`: `src/agents/native/adapter.ts` becomes `src/agents/native/complete.ts`. In `test/unit/scripts/agent-move-manifest.test.ts:74`, change the sample path `"src/agents/native/adapter.ts"` to `"src/agents/native/session-adapter.ts"` (it still passes on a prefix match, but would name a file that no longer exists).

Run: `grep -rnE "agents/native/adapter(\"|\.ts|')" src test scripts`
Expected: only the two baseline JSON files, which step 7 regenerates (`agent-boundary`) or step 3(i) re-keys (`complexity`).

- [ ] **Step 6: Verify the task**

Run: `bun run typecheck && bun run check:complexity && bun run check:import-cycles && bun run check:alias-internals && bash scripts/check-adapter-no-config-import.sh`
Expected: all exit 0.

Run: `bun test test/unit/agents/ test/integration/agents/ test/integration/plugins/ test/integration/cli/adapter-boundary.test.ts test/unit/cli/ test/unit/precheck/ --timeout=60000`
Expected: PASS.

Run: `wc -l src/agents/native/session-adapter.ts src/agents/native/complete.ts src/agents/native/adapter-deps.ts src/agents/native-agent/index.ts test/unit/agents/native/adapter.test.ts`
Expected: every source file under 600 (session-adapter about 420), adapter.test.ts at most 800.

Run: `bun scripts/check-agent-boundary.ts --list | grep -E "native/(adapter|session-adapter|complete|adapter-deps)\.ts"`
Expected: no `-> src/agents/types.ts` line. `session-adapter.ts` and `complete.ts` each keep `-> src/agents/cost/index.ts` (Decision 7), and `session-adapter.ts` keeps `-> src/logger/index.ts` (S1-3). The total is below the Task 3 baseline or at most one above it. If it is above, the `priceCall` edge was duplicated across two files. That is accepted (Decision 7), but note it in the commit body.

- [ ] **Step 7: Commit**

```bash
bun run check:agent-boundary:update
bun x biome check --write src/agents/native src/agents/native-agent src/agents/registry.ts src/cli/agents.ts test/unit/agents test/integration/agents test/integration/plugins scripts && bun run lint
git add -A src test scripts
git commit -m "refactor: split the native adapter into NativeSessionAdapter, nativeComplete and a nax shell"
```

---

### Task 6: Full verification and PR (gated)

- [ ] **Step 1: Full suite and gates**

From `packages/nax`:

Run: `bun run typecheck && bun run lint && bun run test`
Expected: all green. Record the test count from the summary.

Run: `bun run test:coverage`
Expected: PASS (new files carry their own tests; `coverage-per-file-baseline.json` should need no change).

From the repo root:

Run: `bun run check:all`
Expected: exit 0.

- [ ] **Step 2: Confirm the shape**

Run: `cd packages/nax && wc -l src/agents/types.ts && bun scripts/check-agent-boundary.ts --list | tail -1 && git fetch -q origin main && git diff --stat origin/main...HEAD | tail -1`
Expected: `types.ts` below 600 and no `native/adapter.ts` left. Record the final edge count (it started at 101).

Run: `cd packages/nax && bun scripts/check-agent-boundary.ts --list | grep "src/agents/session-types.ts"`
Expected: no output. The contract file has no edge into nax.

- [ ] **Step 3: Ask the user before pushing**

Show the user: the commit list (`git log --oneline origin/main..HEAD`), the final ratchet count, the test count, and Decision 7's unassigned cost-barrel edges. **Stop and wait for approval.**

- [ ] **Step 4: Push and open the PR (only after approval)**

```bash
git push -u origin feat/s1-2-contract-adapter-split
gh pr create --title "refactor: S1-2 session contract and native adapter split" --body "$(cat <<'EOF'
## Summary
- Session contract (`session-types.ts`) no longer imports nax types: `AdapterFailure`, `ToolDescriptor`/`JSONSchema`, the agent stream events and `ResolvedPermissions` moved into the nax-agent move set (old homes re-export them); `ProtocolIds` joined the move set in place.
- `SessionModel` replaces `ModelDef` in the contract (field name `modelDef` kept); `toSessionModel` is nax's one mapping, called at session open and the native one-shot. Role and tier are opaque strings.
- `AgentSessionAdapter` split out of `AgentAdapter`.
- The native adapter split into `NativeSessionAdapter` + `nativeComplete()` (move set) and a thin nax `NativeAgentAdapter` shell at `src/agents/native-agent/`.
- Boundary ratchet: 101 -> N (fill in the count from step 2).

Behaviour-neutral. S1 spec section 4.2, ports 2 and 3.

## Not in this PR
- The `@/agents/cost` barrel value imports (`priceCall`, `inputClassTokens`) from the move set are unassigned to any S1 PR; they need a cost-core split (proposed S1-4b).
- Logger/errors (S1-3); `ProviderCatalogOverride`, `PipelineStage`, activity mapping (S1-4).

## Test plan
- [x] `bun run typecheck`, `bun run lint`, `bun run test`, `bun run test:coverage`, root `bun run check:all`
- [x] New: `toSessionModel`, `selectModel`, `knownSessionRole`, `modelAttribution` with a `SessionModel`, `nativeComplete`, shell forwarding
EOF
)"
```

- [ ] **Step 5: Record in the arc SSOT**

The SSOT lives in the maintainer's workspace, not in this repo. Add the PR number and, after merge, the merge commit to the S1 row of its status table. Then stop. S1-3 gets its own plan against the new `main`.
