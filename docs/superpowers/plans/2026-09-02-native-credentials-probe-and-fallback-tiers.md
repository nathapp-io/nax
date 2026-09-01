# Native Credential Probe and Tier-Aware Fallback Targets — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `NativeAgentAdapter.hasCredentials()` answer honestly so an uncredentialed native agent can be pruned, and let `agent.fallback.map` targets name a model tier.

**Architecture:** Two independent items. (A) The adapter's credential probe moves from "does the client construct" to "is at least one provider satisfied, by stored credential or ambient environment", failing open on timeout; `isInstalled()` stops delegating to it. (B) Fallback map values accept `{ agent, tier }` alongside plain strings; the tier is threaded through `nextCandidate` to both dispatch paths, which resolve models in different places.

**Tech Stack:** TypeScript, Bun (`bun test`), Zod for config schemas, `@nathapp/nax-ai` 0.1.4 for provider/auth primitives.

**Spec:** `docs/superpowers/specs/2026-09-02-native-credentials-probe-and-fallback-tiers-design.md`

## Global Constraints

- **Never widen the nax-ai import boundary.** Only files under `src/agents/native/` may import `@nathapp/nax-ai`. `scripts/check-nax-ai-imports.ts` enforces this and runs in `bun run lint`.
- **Do not read `config.models` from the adapter or the agent registry.** `agentManagerConfigSelector` excludes it by design under ADR-019.
- **The credential probe fails open.** Where the honest answer is unavailable, return `true`. A false negative prunes an agent that would have worked; a false positive falls through to the existing request-time `auth` -> `fail-auth` mapping.
- **Plain-string fallback maps must behave exactly as they do today**, at every step of item B.
- **Every new guard must be proven to fail without its fix.** A gate never proven to fail is not a gate; a timeout never observed to fire is not a timeout.
- **No emojis in code, comments, or documentation.**
- Commit messages use conventional commits (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`). Attribution is disabled globally — never add `Co-Authored-By` or a "generated with" trailer.
- Run `bun run test`, `bun run typecheck`, and `bun run lint` before the final commit of each task.

---

## File Structure

**Item A**
- `src/agents/native/auth.ts` — gains `anyAmbientCredential()` and a `providerIds` test seam. Already the only home for ambient-auth calls (`ambientShadows` lives here).
- `src/agents/native/index.ts` — re-exports `anyAmbientCredential`.
- `src/agents/native/adapter.ts` — `isInstalled()` and `hasCredentials()` change.
- `test/unit/agents/native/ambient-probe.test.ts` — new; the probe in isolation.
- `test/unit/agents/native/adapter.test.ts` — extended; the split and the wiring.
- `test/unit/agents/manager-credentials.test.ts` — extended; pruning end to end.

**Item B**
- `src/config/schemas-infra.ts` — `AgentFallbackConfigSchema.map` widens.
- `src/agents/swap-decision.ts` — normalisation helper; `credentialCandidates` and `availableCandidates` accept both forms.
- `src/agents/manager.ts` — `nextCandidate` return type; two swap sites.
- `src/agents/hop-budget.ts` — `StartAgentSource.nextCandidate` type; reads `.agent`.
- `src/agents/types.ts` — `modelDefFor` gains an optional tier parameter.
- `src/agents/manager-dispatch.ts` — `resolveHopCompleteOptions` passes the tier.
- `src/agents/manager-types.ts` — `HopKind`'s `swap` variant carries the tier.
- `src/operations/call.ts` — `modelDefFor` implementation honours the tier.
- `src/operations/build-hop-callback.ts` — run path uses the hop's tier.
- `test/unit/agents/fallback-tier-targets.test.ts` — new; schema, normalisation, and both dispatch paths.

---

## Task 1: Split `isInstalled()` from `hasCredentials()`

**Files:**
- Modify: `src/agents/native/adapter.ts:51-53` (`isInstalled`)
- Test: `test/unit/agents/native/adapter.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `NativeAgentAdapter.isInstalled(): Promise<boolean>` now always `true`, independent of `hasCredentials()`.

- [ ] **Step 1: Write the failing test**

Append to `test/unit/agents/native/adapter.test.ts`:

```ts
describe("isInstalled", () => {
  test("is true even when hasCredentials is false: in-process, nothing to install", async () => {
    const adapter = new NativeAgentAdapter();
    // Force the credential probe to say no. If isInstalled still delegates,
    // it returns false and this fails.
    adapter.hasCredentials = async () => false;

    expect(await adapter.isInstalled()).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/agents/native/adapter.test.ts -t "in-process, nothing to install"`
Expected: FAIL — received `false`, because `isInstalled()` delegates to `hasCredentials()`.

- [ ] **Step 3: Write minimal implementation**

In `src/agents/native/adapter.ts`, replace the `isInstalled` method and its docstring:

```ts
  /**
   * Always true: the native agent runs in-process. There is no binary, so
   * there is nothing to install, and "not installed" would be a false
   * answer to a question about presence.
   *
   * Deliberately NOT delegating to hasCredentials(). Whether a credential
   * exists is a different question, and AgentManager.validateCredentials()
   * is the place that asks it. Conflating them made checkAgentHealth()
   * report "not installed" for something that is always present.
   */
  async isInstalled(): Promise<boolean> {
    return true;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/unit/agents/native/adapter.test.ts`
Expected: PASS, all tests in the file.

- [ ] **Step 5: Commit**

```bash
git add src/agents/native/adapter.ts test/unit/agents/native/adapter.test.ts
git commit -m "refactor(native): isInstalled reports presence, not credentials"
```

---

## Task 2: The ambient credential probe

**Files:**
- Modify: `src/agents/native/auth.ts` (add import, `_authDeps.providerIds`, `anyAmbientCredential`)
- Modify: `src/agents/native/index.ts` (re-export)
- Test: `test/unit/agents/native/ambient-probe.test.ts` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `anyAmbientCredential(): Promise<boolean>` — exported from `src/agents/native/auth.ts` and re-exported from `src/agents/native/index.ts`.
  - `_authDeps.providerIds: () => Promise<string[]>` — new test seam beside the existing `_authDeps.login` and `_authDeps.ambientAuthAvailable`.
  - `AMBIENT_PROBE_TIMEOUT_MS` — module-private constant, value `2_000`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/agents/native/ambient-probe.test.ts`:

```ts
/**
 * The ambient credential probe.
 *
 * It exists to answer "can this agent authenticate to anything at all?" and
 * it must never answer "no" when it does not know. A false negative prunes an
 * agent that would have worked; a false positive costs one request-time auth
 * error that is already handled.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { anyAmbientCredential } from "@/agents/native/auth";
import { _authDeps } from "@/agents/native/auth";

const REAL_PROVIDER_IDS = _authDeps.providerIds;
const REAL_AMBIENT = _authDeps.ambientAuthAvailable;

afterEach(() => {
  _authDeps.providerIds = REAL_PROVIDER_IDS;
  _authDeps.ambientAuthAvailable = REAL_AMBIENT;
});

describe("anyAmbientCredential", () => {
  test("is true when any provider is satisfied", async () => {
    _authDeps.providerIds = async () => ["a", "b", "c"];
    _authDeps.ambientAuthAvailable = async (id: string) => id === "c";

    expect(await anyAmbientCredential()).toBe(true);
  });

  test("is false when no provider is satisfied", async () => {
    _authDeps.providerIds = async () => ["a", "b"];
    _authDeps.ambientAuthAvailable = async () => false;

    expect(await anyAmbientCredential()).toBe(false);
  });

  test("is false when the catalog is empty", async () => {
    _authDeps.providerIds = async () => [];
    _authDeps.ambientAuthAvailable = async () => true;

    expect(await anyAmbientCredential()).toBe(false);
  });

  test("short-circuits: a satisfied provider resolves without awaiting the rest", async () => {
    let settledSlow = false;
    _authDeps.providerIds = async () => ["fast-yes", "slow"];
    _authDeps.ambientAuthAvailable = async (id: string) => {
      if (id === "fast-yes") return true;
      await new Promise((r) => setTimeout(r, 5_000));
      settledSlow = true;
      return false;
    };

    expect(await anyAmbientCredential()).toBe(true);
    expect(settledSlow).toBe(false);
  });

  test("a throwing probe is not a satisfied provider, and does not propagate", async () => {
    _authDeps.providerIds = async () => ["boom", "ok"];
    _authDeps.ambientAuthAvailable = async (id: string) => {
      if (id === "boom") throw new Error("resolve exploded");
      return true;
    };

    expect(await anyAmbientCredential()).toBe(true);
  });

  test("a throwing probe alone is false, not a rejection", async () => {
    _authDeps.providerIds = async () => ["boom"];
    _authDeps.ambientAuthAvailable = async () => {
      throw new Error("resolve exploded");
    };

    expect(await anyAmbientCredential()).toBe(false);
  });

  test("a hung probe times out to TRUE, never pruning on a slow answer", async () => {
    _authDeps.providerIds = async () => ["hangs"];
    _authDeps.ambientAuthAvailable = () => new Promise<boolean>(() => {});

    // Fails without the timeout: this call would never settle and the test
    // would hit its own timeout instead of asserting.
    expect(await anyAmbientCredential()).toBe(true);
  }, 10_000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/agents/native/ambient-probe.test.ts`
Expected: FAIL at import — `anyAmbientCredential` is not exported from `@/agents/native/auth`, and `_authDeps.providerIds` does not exist.

- [ ] **Step 3: Write minimal implementation**

In `src/agents/native/auth.ts`, add `defaultProviders` to the existing nax-ai import:

```ts
import {
  ambientAuthAvailable,
  defaultProviders,
  type LoginEvent,
  type LoginInteraction,
  type LoginPrompt,
  login,
} from "@nathapp/nax-ai";
```

Extend the existing `_authDeps` seam:

```ts
/** Test seam, following the _clientDeps precedent. */
export const _authDeps = {
  login,
  ambientAuthAvailable,
  providerIds: async (): Promise<string[]> => (await defaultProviders()).map((provider) => provider.id),
};
```

Then append `anyAmbientCredential` after `ambientShadows`:

```ts
/**
 * How long the whole ambient sweep may take before it gives up and reports
 * "credentialed".
 *
 * Measured today the sweep is ~17ms: the catalog is memoised upstream after a
 * ~15ms first load, and 39 ambient probes take ~2ms because no bundled pi
 * provider defines check() and every resolve() reads environment variables and
 * credential files only. That is a snapshot, not a guarantee — pi's own
 * contract warns resolve() "may execute commands", and sweeping the catalog
 * amplifies that across every provider.
 */
const AMBIENT_PROBE_TIMEOUT_MS = 2_000;

/**
 * Is ANY provider satisfied by ambient auth alone?
 *
 * Deliberately not "is provider X satisfied": the caller
 * (NativeAgentAdapter.hasCredentials) has no provider to ask about, because
 * the model — and so the provider — is chosen per request.
 *
 * Expiry resolves TRUE, not false. Pruning an agent that would have worked
 * kills a run; reporting one that cannot authenticate costs a single
 * request-time auth error that is already mapped and handled. Where this
 * cannot answer, it must not guess "no".
 */
export async function anyAmbientCredential(): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const sweep = (async (): Promise<boolean> => {
    const ids = await _authDeps.providerIds();
    if (ids.length === 0) return false;

    // Resolve on the first success rather than awaiting every probe, so one
    // satisfied provider does not wait behind a slow one.
    return new Promise<boolean>((resolve) => {
      let outstanding = ids.length;
      const settleOne = (satisfied: boolean): void => {
        if (satisfied) resolve(true);
        else if (--outstanding === 0) resolve(false);
      };
      for (const id of ids) {
        _authDeps.ambientAuthAvailable(id).then(
          (ok) => settleOne(ok),
          // A probe that throws is not a satisfied provider. It is also not a
          // reason to fail the sweep: the other providers still count.
          () => settleOne(false),
        );
      }
    });
  })();

  const expiry = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(true), AMBIENT_PROBE_TIMEOUT_MS);
  });

  try {
    return await Promise.race([sweep, expiry]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
```

In `src/agents/native/index.ts`, add `anyAmbientCredential` to the existing `./auth` export block, keeping the list alphabetical:

```ts
export {
  ambientShadows,
  anyAmbientCredential,
  AuthCancelledError,
  authImportOutcomeLabel,
  DEFAULT_PI_AUTH_PATH,
  type ImportOutcome,
  importPiCredentials,
  listStoredProviders,
  removeStoredProvider,
  runLogin,
} from "./auth";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/unit/agents/native/ambient-probe.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Prove the timeout is real**

Temporarily change `AMBIENT_PROBE_TIMEOUT_MS` to `2_000_000`, then run:

Run: `bun test test/unit/agents/native/ambient-probe.test.ts -t "hung probe"`
Expected: FAIL by test timeout — proving the assertion is carried by the timeout and not by something else. Restore `2_000` and re-run to confirm PASS.

- [ ] **Step 6: Commit**

```bash
git add src/agents/native/auth.ts src/agents/native/index.ts test/unit/agents/native/ambient-probe.test.ts
git commit -m "feat(native): add the ambient credential sweep, failing open on timeout"
```

---

## Task 3: Wire `hasCredentials()` to stored credentials and the probe

**Files:**
- Modify: `src/agents/native/adapter.ts` (`hasCredentials`, and its imports)
- Test: `test/unit/agents/native/adapter.test.ts`
- Test: `test/unit/agents/manager-credentials.test.ts`

**Interfaces:**
- Consumes: `anyAmbientCredential()` and `listStoredProviders()` from `src/agents/native/auth.ts` (Task 2 exported the former; the latter already exists and returns `Promise<StoredEntry[]>` where `StoredEntry` is `{ providerId: string; kind: "api-key" | "oauth"; expires?: number }`).
- Produces: `NativeAgentAdapter.hasCredentials(): Promise<boolean>` that no longer constructs a client.

- [ ] **Step 1: Write the failing test**

Append to `test/unit/agents/native/adapter.test.ts`:

```ts
describe("hasCredentials", () => {
  test("is true when a credential is stored, without sweeping ambient auth", async () => {
    let swept = false;
    _adapterDeps.listStoredProviders = async () => [{ providerId: "minimax", kind: "api-key" as const }];
    _adapterDeps.anyAmbientCredential = async () => {
      swept = true;
      return false;
    };

    expect(await new NativeAgentAdapter().hasCredentials()).toBe(true);
    expect(swept).toBe(false);
  });

  test("falls back to the ambient sweep when nothing is stored", async () => {
    _adapterDeps.listStoredProviders = async () => [];
    _adapterDeps.anyAmbientCredential = async () => true;

    expect(await new NativeAgentAdapter().hasCredentials()).toBe(true);
  });

  test("is false only when nothing is stored and nothing is ambient", async () => {
    _adapterDeps.listStoredProviders = async () => [];
    _adapterDeps.anyAmbientCredential = async () => false;

    expect(await new NativeAgentAdapter().hasCredentials()).toBe(false);
  });

  test("an unreadable credential file does not prune the agent", async () => {
    _adapterDeps.listStoredProviders = async () => {
      throw new Error("EACCES");
    };
    _adapterDeps.anyAmbientCredential = async () => false;

    // Fail open: an unreadable store is "unknown", not "no credentials".
    expect(await new NativeAgentAdapter().hasCredentials()).toBe(true);
  });
});
```

Add to the file's imports and its existing `afterEach`:

```ts
import { _adapterDeps } from "@/agents/native/adapter";

const REAL_LIST = _adapterDeps.listStoredProviders;
const REAL_SWEEP = _adapterDeps.anyAmbientCredential;
```

```ts
afterEach(() => {
  _clientDeps.build = REAL_BUILD;
  _resetNativeClient();
  _adapterDeps.listStoredProviders = REAL_LIST;
  _adapterDeps.anyAmbientCredential = REAL_SWEEP;
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/agents/native/adapter.test.ts -t "hasCredentials"`
Expected: FAIL at import — `_adapterDeps` is not exported from `@/agents/native/adapter`.

- [ ] **Step 3: Write minimal implementation**

In `src/agents/native/adapter.ts`, add the imports:

```ts
import { anyAmbientCredential, listStoredProviders } from "./auth";
```

Add the seam near the top of the file, after the existing module constants:

```ts
/** Test seam, following the _clientDeps precedent. */
export const _adapterDeps = { listStoredProviders, anyAmbientCredential };
```

Replace `hasCredentials` and its docstring:

```ts
  /**
   * Can this agent authenticate to at least one provider?
   *
   * Deliberately not "is the provider this run needs satisfied": this method
   * takes no provider, and it cannot get one. The registry receives the
   * manager's config slice, and agentManagerConfigSelector excludes
   * config.models by design (ADR-019). Probing every provider for a specific
   * answer is not an alternative either — pi's resolve() may execute commands.
   *
   * So this prunes exactly one case: nothing stored anywhere and nothing
   * ambient. That is the real failure — a user who has never run
   * `nax auth login` and has no provider environment variables — and every
   * native call is going to fail anyway. A wrong-provider credential still
   * surfaces per request, through the typed mapping from ProtocolError.kind
   * "auth" to availability / fail-auth.
   *
   * Errors resolve to true. Pruning an agent that would have worked kills a
   * run; the opposite costs one request-time error that is already handled.
   */
  async hasCredentials(): Promise<boolean> {
    try {
      if ((await _adapterDeps.listStoredProviders()).length > 0) return true;
      return await _adapterDeps.anyAmbientCredential();
    } catch {
      return true;
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/unit/agents/native/adapter.test.ts`
Expected: PASS, including the Task 1 `isInstalled` test.

- [ ] **Step 5: Prove the manager actually prunes**

Append to `test/unit/agents/manager-credentials.test.ts`:

```ts
describe("native agent credential pruning (Phase A plan 3)", () => {
  test("an uncredentialed native fallback candidate is pruned", async () => {
    const config = NaxConfigSchema.parse({
      agent: { default: "claude", fallback: { enabled: true, map: { claude: ["native"] } } },
    });
    const registry = {
      getAgent: (n: string) => (n === "claude" ? stubAdapter("claude", true) : stubAdapter("native", false)),
      getInstalledAgents: async () => [],
      checkAgentHealth: async () => [],
      protocol: "acp" as const,
    };
    const manager = new AgentManager(config, { registry } as never);

    await manager.validateCredentials();

    expect(manager.resolveFallbackChain("claude", { outcome: "fail-auth" } as never)).not.toContain("native");
  });

  test("an uncredentialed native PRIMARY throws AGENT_CREDENTIALS_MISSING", async () => {
    const config = NaxConfigSchema.parse({
      agent: { default: "native", fallback: { enabled: true, map: {} } },
    });
    const registry = {
      getAgent: () => stubAdapter("native", false),
      getInstalledAgents: async () => [],
      checkAgentHealth: async () => [],
      protocol: "acp" as const,
    };
    const manager = new AgentManager(config, { registry } as never);

    await expect(manager.validateCredentials()).rejects.toMatchObject({ code: "AGENT_CREDENTIALS_MISSING" });
  });
});
```

Note: the existing file already defines `stubAdapter` and imports `AgentManager` and `NaxConfigSchema`. If the `AgentManager` constructor signature in this file differs from the shape above, copy the construction used by the tests already in the file rather than the shape written here.

Run: `bun test test/unit/agents/manager-credentials.test.ts`
Expected: PASS.

- [ ] **Step 6: Full gates and commit**

```bash
bun run typecheck && bun run lint && bun run test
git add src/agents/native/adapter.ts test/unit/agents/native/adapter.test.ts test/unit/agents/manager-credentials.test.ts
git commit -m "feat(native): hasCredentials reports stored or ambient auth"
```

---

## Task 4: Fallback map accepts `{ agent, tier }`

**Files:**
- Modify: `src/config/schemas-infra.ts:205-211` (`AgentFallbackConfigSchema`)
- Modify: `src/agents/swap-decision.ts:83-103` (`availableCandidates`, `credentialCandidates`)
- Test: `test/unit/agents/fallback-tier-targets.test.ts` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `export interface FallbackTarget { readonly agent: string; readonly tier?: string }`, exported from `src/agents/swap-decision.ts`.
  - `export type FallbackMapValue = string | { agent: string; tier: string }`.
  - `export type FallbackMap = Record<string, readonly FallbackMapValue[]>`.
  - `normaliseFallbackTarget(value: FallbackMapValue): FallbackTarget` — exported for tests.
  - `availableCandidates(map: FallbackMap | undefined, agent: string, isExcluded: (c: string) => boolean): FallbackTarget[]`
  - `credentialCandidates(map: FallbackMap | undefined, primary: string): Set<string>` — signature unchanged, accepts both forms.

- [ ] **Step 1: Write the failing test**

Create `test/unit/agents/fallback-tier-targets.test.ts`:

```ts
/**
 * Tier-aware fallback targets.
 *
 * The schema is the easy half. The reason these tests assert at the seams and
 * not only at the parse is that widening the schema alone ships an inert
 * feature: the tier would be parsed, filtered, and then dropped by a
 * nextCandidate that returns a bare string.
 */

import { describe, expect, test } from "bun:test";
import { availableCandidates, credentialCandidates, normaliseFallbackTarget } from "@/agents/swap-decision";
import { NaxConfigSchema } from "@/config/schemas";

const none = () => false;

describe("fallback map schema", () => {
  test("accepts plain strings, as today", () => {
    const config = NaxConfigSchema.parse({
      agent: { fallback: { enabled: true, map: { claude: ["codex", "gemini"] } } },
    });
    expect(config.agent?.fallback?.map.claude).toEqual(["codex", "gemini"]);
  });

  test("accepts a { agent, tier } target", () => {
    const config = NaxConfigSchema.parse({
      agent: { fallback: { enabled: true, map: { native: [{ agent: "native", tier: "cheap" }] } } },
    });
    expect(config.agent?.fallback?.map.native).toEqual([{ agent: "native", tier: "cheap" }]);
  });

  test("accepts both forms mixed in one entry", () => {
    const config = NaxConfigSchema.parse({
      agent: { fallback: { enabled: true, map: { claude: ["codex", { agent: "native", tier: "cheap" }] } } },
    });
    expect(config.agent?.fallback?.map.claude).toHaveLength(2);
  });

  test("rejects an object target missing agent", () => {
    expect(() =>
      NaxConfigSchema.parse({
        agent: { fallback: { enabled: true, map: { claude: [{ tier: "cheap" }] } } },
      }),
    ).toThrow();
  });
});

describe("normaliseFallbackTarget", () => {
  test("a string becomes an agent with no tier", () => {
    expect(normaliseFallbackTarget("codex")).toEqual({ agent: "codex" });
  });

  test("an object keeps its tier", () => {
    expect(normaliseFallbackTarget({ agent: "native", tier: "cheap" })).toEqual({ agent: "native", tier: "cheap" });
  });
});

describe("availableCandidates", () => {
  test("plain strings behave exactly as before", () => {
    expect(availableCandidates({ claude: ["codex", "gemini"] }, "claude", none)).toEqual([
      { agent: "codex" },
      { agent: "gemini" },
    ]);
  });

  test("preserves the tier on an object target", () => {
    expect(availableCandidates({ native: [{ agent: "native", tier: "cheap" }] }, "native", none)).toEqual([
      { agent: "native", tier: "cheap" },
    ]);
  });

  test("exclusion still filters by agent name", () => {
    const excluded = (c: string) => c === "codex";
    expect(availableCandidates({ claude: ["codex", { agent: "native", tier: "cheap" }] }, "claude", excluded)).toEqual([
      { agent: "native", tier: "cheap" },
    ]);
  });
});

describe("credentialCandidates", () => {
  test("yields names for both forms, so validateCredentials checks both sides", () => {
    const got = credentialCandidates({ claude: ["codex", { agent: "native", tier: "cheap" }] }, "claude");
    expect([...got].sort()).toEqual(["claude", "codex", "native"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/agents/fallback-tier-targets.test.ts`
Expected: FAIL — `normaliseFallbackTarget` is not exported, the object-target parse throws, and `availableCandidates` returns strings.

- [ ] **Step 3: Write minimal implementation**

In `src/config/schemas-infra.ts`, replace the `map` line of `AgentFallbackConfigSchema`:

```ts
const FallbackTargetSchema = z.union([
  z.string().min(1),
  z.object({ agent: z.string().min(1), tier: z.string().min(1) }),
]);

const AgentFallbackConfigSchema = z.object({
  enabled: z.boolean().default(false),
  map: z.record(z.string().min(1), z.array(FallbackTargetSchema)).default({}),
  maxHopsPerStory: z.number().int().min(1).max(10).default(2),
  onQualityFailure: z.boolean().default(false),
  rebuildContext: z.boolean().default(true),
});
```

In `src/agents/swap-decision.ts`, replace `availableCandidates` and `credentialCandidates`:

```ts
/** A fallback target, after both config spellings are reduced to one shape. */
export interface FallbackTarget {
  readonly agent: string;
  readonly tier?: string;
}

export type FallbackMapValue = string | { agent: string; tier: string };
export type FallbackMap = Record<string, readonly FallbackMapValue[]>;

/**
 * Both spellings reduce here, and nothing downstream sees the raw union.
 * A plain string is a target with no tier — which is what every existing
 * config is, so the no-tier path must stay the untouched one.
 */
export function normaliseFallbackTarget(value: FallbackMapValue): FallbackTarget {
  return typeof value === "string" ? { agent: value } : { agent: value.agent, tier: value.tier };
}

/**
 * `{ claude: ["codex", "gemini"] }` walks correctly: unavailable agents drop out and
 * the next available candidate in order is returned.
 */
export function availableCandidates(
  map: FallbackMap | undefined,
  agent: string,
  isExcluded: (candidate: string) => boolean,
): FallbackTarget[] {
  return (map?.[agent] ?? [])
    .map(normaliseFallbackTarget)
    .filter((candidate) => !isExcluded(candidate.agent));
}

/**
 * Every agent whose credentials `validateCredentials` must check: the primary, plus
 * both sides of every entry in the fallback map (a `from` key can name an agent that
 * appears in no `to` list, and vice versa).
 *
 * Names only — a tier says nothing about credentials.
 */
export function credentialCandidates(map: FallbackMap | undefined, primary: string): Set<string> {
  const candidates = new Set<string>([primary]);
  for (const [from, tos] of Object.entries(map ?? {})) {
    candidates.add(from);
    for (const to of tos) candidates.add(normaliseFallbackTarget(to).agent);
  }
  return candidates;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/unit/agents/fallback-tier-targets.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Typecheck to find every caller the return-type change breaks**

Run: `bun run typecheck`
Expected: FAIL, in `src/agents/manager.ts` and `src/agents/hop-budget.ts`, because `availableCandidates` now returns `FallbackTarget[]` where a `string[]` is expected. Those are Task 5. Do not fix them here; note the exact file:line list for Task 5.

- [ ] **Step 6: Commit**

Commit with the known typecheck break, so Task 5 has a clean starting point:

```bash
git add src/config/schemas-infra.ts src/agents/swap-decision.ts test/unit/agents/fallback-tier-targets.test.ts
git commit -m "feat(config): fallback map targets may name a tier"
```

---

## Task 5: `nextCandidate` carries the tier

**Files:**
- Modify: `src/agents/manager.ts:195-205` (`resolveFallbackChain`, `nextCandidate`), `:400-431`, `:561-588`
- Modify: `src/agents/manager-types.ts` (`resolveFallbackChain` declaration, `HopKind`)
- Modify: `src/agents/hop-budget.ts:19-21, 45` (`StartAgentSource`, `resolveStartAgent`)
- Test: `test/unit/agents/fallback-tier-targets.test.ts`

**Interfaces:**
- Consumes: `FallbackTarget`, `availableCandidates` from Task 4.
- Produces:
  - `AgentManager.nextCandidate(current: string, hopsSoFar: number): FallbackTarget | null`
  - `AgentManager.resolveFallbackChain(agent: string, failure: AdapterFailure): FallbackTarget[]`
  - `HopKind`'s swap variant becomes `{ kind: "swap"; failure: AdapterFailure; tier?: string }`
  - `StartAgentSource.nextCandidate(current: string, hopsSoFar: number): FallbackTarget | null`

- [ ] **Step 1: Write the failing test**

Append to `test/unit/agents/fallback-tier-targets.test.ts`:

```ts
import { AgentManager } from "@/agents/manager";

describe("nextCandidate", () => {
  function manager(map: Record<string, unknown[]>) {
    const config = NaxConfigSchema.parse({
      agent: { default: "claude", fallback: { enabled: true, map } },
    });
    return new AgentManager(config);
  }

  test("returns a bare agent for a plain-string target", () => {
    expect(manager({ claude: ["codex"] }).nextCandidate("claude", 0)).toEqual({ agent: "codex" });
  });

  test("returns the tier for an object target", () => {
    expect(manager({ claude: [{ agent: "native", tier: "cheap" }] }).nextCandidate("claude", 0)).toEqual({
      agent: "native",
      tier: "cheap",
    });
  });

  test("returns null when the chain is empty", () => {
    expect(manager({ claude: [] }).nextCandidate("claude", 0)).toBeNull();
  });
});
```

Note: if `AgentManager`'s constructor in this repo requires more than a config, copy the construction used in `test/unit/agents/manager-credentials.test.ts` instead.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/agents/fallback-tier-targets.test.ts -t "nextCandidate"`
Expected: FAIL — `nextCandidate` returns the string `"codex"`, not `{ agent: "codex" }`.

- [ ] **Step 3: Write minimal implementation**

In `src/agents/manager.ts`, change the two methods:

```ts
  resolveFallbackChain(agent: string, _failure: AdapterFailure): FallbackTarget[] {
    return availableCandidates(this._config.agent?.fallback?.map, agent, this._isExcluded);
  }
```

```ts
  nextCandidate(current: string, _hopsSoFar: number): FallbackTarget | null {
    return availableCandidates(this._config.agent?.fallback?.map, current, this._isExcluded)[0] ?? null;
  }
```

Import `FallbackTarget` from `./swap-decision` alongside the existing imports.

At the swap site around `manager.ts:400`, replace every use of `next` as a name with `next.agent`, and carry the tier on the hop kind:

```ts
        const next = this.nextCandidate(primaryAgent, hopsSoFar);
        if (!next) {
          this._emitter.emit("onSwapExhausted", { storyId: request.runOptions.storyId, hops: hopsSoFar });
          _finalStatus = "exhausted";
          return { result, fallbacks, finalBundle: updatedBundle, finalPrompt, finalAgent: currentAgent };
        }
        hopsSoFar = this._budget.spend(storyId, hopsSoFar);
        rateLimitRetry = 0;
        currentBundle = updatedBundle;
        // The hop kind is the per-hop channel the caller already reads, so the
        // target's tier rides there rather than in a parallel variable.
        currentHopKind = {
          kind: "swap",
          failure: adapterFailure,
          ...(next.tier !== undefined ? { tier: next.tier } : {}),
        };

        const hop = buildFallbackRecord({
          storyId: request.runOptions.storyId,
          priorAgent: currentAgent,
          newAgent: next.agent,
          hop: hopsSoFar,
          failure: adapterFailure,
          costUsd: result.estimatedCostUsd ?? 0,
        });
        fallbacks.push(hop);
        this._emitter.emit("onSwapAttempt", hop);

        logger?.info("agent-manager", "Agent swap triggered", {
          storyId: request.runOptions.storyId,
          fromAgent: currentAgent,
          toAgent: next.agent,
          hop: hopsSoFar,
        });

        _agentChain.push(next.agent);
        currentAgent = next.agent;
```

At the second swap site around `manager.ts:561`, apply the same `next.agent` substitution in `buildFallbackRecord`, the log call, `_agentChain.push`, and `currentAgent = next.agent`. That path has no `currentHopKind`; its tier is applied in Task 6.

In `src/agents/manager-types.ts`, widen the swap variant and the declaration:

```ts
export type HopKind =
  | { kind: "primary" }
  | { kind: "stale-retry"; attempt: number } // same agent, reuse existing session
  | { kind: "timeout-retry"; attempt: number } // same agent, fresh session after fail-timeout
  | { kind: "swap"; failure: AdapterFailure; tier?: string }; // new agent, fresh session
```

```ts
  resolveFallbackChain(agent: string, failure: AdapterFailure): FallbackTarget[];
```

In `src/agents/hop-budget.ts`:

```ts
/** The `AgentManager` surface `resolveStartAgent` reads. */
export interface StartAgentSource {
  isUnavailable(agent: string): boolean;
  nextCandidate(current: string, hopsSoFar: number): FallbackTarget | null;
}
```

```ts
  const candidate = source.nextCandidate(primary, 0);
  if (!candidate) return primary;
  logger?.info("agent-manager", "Primary agent already unavailable — starting on fallback", {
    storyId,
    fromAgent: primary,
    toAgent: candidate.agent,
```

and return `candidate.agent` wherever the function previously returned `candidate`.

- [ ] **Step 4: Run tests and typecheck**

Run: `bun run typecheck && bun test test/unit/agents/`
Expected: PASS. Existing tests that assert `nextCandidate` returns a string must be updated to expect `{ agent: "..." }` — that is a deliberate contract change, not a test to weaken.

- [ ] **Step 5: Commit**

```bash
bun run lint
git add src/agents/manager.ts src/agents/manager-types.ts src/agents/hop-budget.ts test/unit/agents/fallback-tier-targets.test.ts
git commit -m "feat(agents): nextCandidate carries the fallback target's tier"
```

---

## Task 6: Apply the tier on the complete path

**Files:**
- Modify: `src/agents/types.ts:253` (`modelDefFor`)
- Modify: `src/agents/manager-dispatch.ts:223-230` (`resolveHopCompleteOptions`)
- Modify: `src/agents/manager.ts:481` (the `resolveHopCompleteOptions` call), `:561-588`
- Modify: `src/operations/call.ts:89-92` (the `modelDefFor` implementation)
- Test: `test/unit/agents/fallback-tier-targets.test.ts`

**Interfaces:**
- Consumes: `FallbackTarget` (Task 4), `nextCandidate` returning it (Task 5).
- Produces: `modelDefFor?: (agentName: string, tier?: string) => ModelDef | undefined` — an absent `tier` means exactly today's behaviour.

- [ ] **Step 1: Write the failing test**

Append to `test/unit/agents/fallback-tier-targets.test.ts`:

```ts
import { resolveHopCompleteOptions } from "@/agents/manager-dispatch";
import { type ModelDef, resolveModelForAgent } from "@/config";
import type { ResolvedCompleteOptions } from "@/agents/types";

describe("resolveHopCompleteOptions", () => {
  const base = {
    modelDef: { provider: "anthropic", model: "primary-model" } as ModelDef,
    modelDefFor: (agent: string, tier?: string) =>
      ({ provider: "p", model: `${agent}:${tier ?? "default"}` }) as ModelDef,
  } as unknown as ResolvedCompleteOptions;

  test("the primary hop is untouched", () => {
    expect(resolveHopCompleteOptions(base, "claude", "claude").modelDef.model).toBe("primary-model");
  });

  test("a swapped hop with no tier resolves the agent's default, as today", () => {
    expect(resolveHopCompleteOptions(base, "codex", "claude").modelDef.model).toBe("codex:default");
  });

  test("a swapped hop passes its tier through to modelDefFor", () => {
    // The assertion that matters: the tier must REACH the dispatch. Asserting
    // only that the schema parsed would pass while the feature is inert.
    expect(resolveHopCompleteOptions(base, "native", "claude", "cheap").modelDef.model).toBe("native:cheap");
  });
});

describe("an unknown tier on a fallback target", () => {
  test("throws MODEL_NOT_FOUND rather than silently falling back to balanced", () => {
    // resolveModelForAgent throws when neither the agent nor the default agent
    // defines the tier. Swallowing that would run the hop on a model the user
    // never asked for, which is worse than failing.
    const models = { claude: { balanced: "claude-sonnet-5" }, native: { cheap: "opencode-go/glm-5" } };
    expect(() => resolveModelForAgent(models, "native", "no-such-tier", "claude")).toThrow(/MODEL_NOT_FOUND|no-such-tier/);
  });

  test("a tier the agent lacks falls back to the default agent's entry before throwing", () => {
    const models = { claude: { premium: "claude-opus-5" }, native: { cheap: "opencode-go/glm-5" } };
    expect(resolveModelForAgent(models, "native", "premium", "claude").model).toBe("claude-opus-5");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/agents/fallback-tier-targets.test.ts -t "resolveHopCompleteOptions"`
Expected: FAIL on the third test — `resolveHopCompleteOptions` takes three parameters, so the tier is ignored and the model is `native:default`.

- [ ] **Step 3: Write minimal implementation**

In `src/agents/types.ts`, widen the callback:

```ts
  /**
   * The model to dispatch for a given agent, and optionally at a given tier.
   * `tier` is supplied when a fallback target named one; absent means the
   * caller's own effective tier, which is what every pre-existing config does.
   */
  modelDefFor?: (agentName: string, tier?: string) => ModelDef | undefined;
```

In `src/agents/manager-dispatch.ts`:

```ts
export function resolveHopCompleteOptions(
  options: ResolvedCompleteOptions,
  currentAgent: string,
  primaryAgent: string,
  tier?: string,
): ResolvedCompleteOptions {
  if (currentAgent === primaryAgent) return options;
  return { ...options, modelDef: options.modelDefFor?.(currentAgent, tier) ?? options.modelDef };
}
```

In `src/agents/manager.ts` inside `completeWithFallback`, track the tier of the hop currently being dispatched and pass it. Declare it beside `currentAgent`:

```ts
    let currentAgent = primaryAgent;
    let currentTier: string | undefined;
```

At the dispatch:

```ts
        const hopOptions = resolveHopCompleteOptions(options, currentAgent, primaryAgent, currentTier);
```

At the swap site around `:588`:

```ts
        currentAgent = next.agent;
        currentTier = next.tier;
```

In `src/operations/call.ts`, honour the tier:

```ts
      modelDefFor: (agent: string, tier?: string) =>
        agent === dispatchAgent && tier === undefined
          ? resolved.modelDef
          : resolveModelForAgent(effectiveModels, agent, tier ?? effectiveTier, defaultAgent),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/unit/agents/fallback-tier-targets.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
bun run lint
git add src/agents/types.ts src/agents/manager-dispatch.ts src/agents/manager.ts src/operations/call.ts test/unit/agents/fallback-tier-targets.test.ts
git commit -m "feat(agents): apply a fallback target's tier on the complete path"
```

---

## Task 7: Apply the tier on the run path

**Files:**
- Modify: `src/operations/build-hop-callback.ts:313, 336-340`
- Test: `test/unit/operations/build-hop-callback-tier.test.ts` (create)

**Interfaces:**
- Consumes: `HopKind`'s `swap` variant carrying `tier?: string` (Task 5).
- Produces: no new exported surface. The run path resolves the hop's model at `hopKind.tier ?? effectiveTier`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/operations/build-hop-callback-tier.test.ts`:

```ts
/**
 * The run path applies a swapped hop's tier.
 *
 * Separate from the complete path because the two resolve their model in
 * different places: the complete path re-resolves inside the manager via
 * modelDefFor, while the run path resolves here, in the caller. Covering only
 * one leaves { agent, tier } working for complete ops and silently ignored for
 * run ops.
 */

import { describe, expect, test } from "bun:test";
import { hopTier } from "@/operations/build-hop-callback";

describe("hopTier", () => {
  test("a primary hop uses the caller's effective tier", () => {
    expect(hopTier({ kind: "primary" }, "balanced")).toBe("balanced");
  });

  test("a swap with no tier uses the caller's effective tier", () => {
    expect(hopTier({ kind: "swap", failure: { outcome: "fail-auth" } as never }, "balanced")).toBe("balanced");
  });

  test("a swap that named a tier uses it", () => {
    expect(hopTier({ kind: "swap", failure: { outcome: "fail-auth" } as never, tier: "cheap" }, "balanced")).toBe(
      "cheap",
    );
  });

  test("a stale-retry uses the caller's effective tier", () => {
    expect(hopTier({ kind: "stale-retry", attempt: 1 }, "balanced")).toBe("balanced");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/operations/build-hop-callback-tier.test.ts`
Expected: FAIL at import — `hopTier` is not exported from `@/operations/build-hop-callback`.

- [ ] **Step 3: Write minimal implementation**

In `src/operations/build-hop-callback.ts`, add near the top-level helpers:

```ts
/**
 * The tier a hop should resolve its model at.
 *
 * Only a swap can carry one, and only when the fallback target named it.
 * Everything else is the caller's effective tier, which is what every hop did
 * before tier-aware targets existed.
 */
export function hopTier(hopKind: HopKind, effectiveTier: string): string {
  return hopKind.kind === "swap" ? (hopKind.tier ?? effectiveTier) : effectiveTier;
}
```

Import `HopKind` from `@/agents/manager-types` if it is not already imported.

Then replace the three `effectiveTier` uses in the hop body with the resolved tier. At the stale-retry branch (around line 313):

```ts
        const modelDef = pinnedModelDef ?? resolveModelForAgent(config.models, agentName, hopTier(hopKind, effectiveTier), defaultAgent);
```

and in the same `openSession` call, the reported tier must match the one that selected the model:

```ts
          ...(pinnedModelDef !== undefined ? {} : { modelTier: hopTier(hopKind, effectiveTier) }),
```

At the else branch (around lines 336-340):

```ts
      const pinned = hopKind.kind === "primary" && pinnedModelDef !== undefined;
      const tier = hopTier(hopKind, effectiveTier);
      const modelDef =
        hopKind.kind === "primary"
          ? (pinnedModelDef ?? resolveModelForAgent(config.models, agentName, tier, defaultAgent))
          : resolveModelForAgent(config.models, agentName, tier, defaultAgent);
```

Apply the same substitution to the `modelTier:` field of that branch's `openSession` call, so the recorded tier and the dispatched model never disagree.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/unit/operations/build-hop-callback-tier.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Full gates**

```bash
bun run typecheck && bun run lint && bun run test && bun run test:coverage
```
Expected: all green; the per-file coverage ratchet stays at 0 below floor.

- [ ] **Step 6: Commit**

```bash
git add src/operations/build-hop-callback.ts test/unit/operations/build-hop-callback-tier.test.ts
git commit -m "feat(operations): apply a fallback target's tier on the run path"
```

---

## Done criteria

- `nax`'s native agent is pruned by `validateCredentials()` when nothing is stored and nothing is ambient, and is never pruned when the probe cannot answer.
- `isInstalled()` and `hasCredentials()` answer two different questions.
- `agent.fallback.map` accepts `{ agent, tier }` and a plain string, and the tier reaches the dispatch on **both** the complete and run paths.
- Every pre-existing plain-string fallback config behaves bit-for-bit as before.
- `bun run test`, `bun run typecheck`, `bun run lint` (23 gates), and `bun run test:coverage` all green.
