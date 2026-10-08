# S4b-5: delete the acpx transport, rename `acp-sdk/` to `acp/`, release: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the acpx CLI transport from `nax run` completely, so ACP agents run only through `@nathapp/nax-agent-acp`, and release nax.

**Architecture:** This slice deletes and renames. It adds no new behaviour. Tests that still reach the acpx client are moved onto the sdk transport first, while both transports still exist (Task 1). Then the `agent.acp.transport` key and the acpx folder are deleted together (Task 2), and the sdk folder takes the `agents/acp/` name (Task 3). The remaining acpx traces are smaller and are removed separately: `parseAgentError` branches and the `ACPX_` env prefix (Task 4); the acpx `sessions close` eviction in merge-conflict rectification, which is replaced by the sdk equivalent (Task 5); user-facing strings (Task 6); and docs (Task 7). Gates, review and the PR are Task 8. The release is Task 9.

**Tech Stack:** TypeScript, Bun 1.4.x, bun:test, zod config schema, `@nathapp/nax-agent-acp` 0.3.1 (`./client`), `@nathapp/nax-agent` 0.3.1.

**Spec:** `docs/superpowers/specs/2026-10-07-s4b-nax-run-acp-cutover-design.md` (§4 folder note, §5.2 last paragraph, §5.3, §9 "plumbing cases", §10 S4b-5 row, §11, B2, B7).

**Baseline:** main `d79057cfa` (S4b-4 merged #2383, #2384 merged, v0.83.5 released #2385). Branch `feat/s4b-5-delete-acpx`.

## Global Constraints

- S4b-5 = "Delete `agents/acp/`; rename `acp-sdk/` -> `acp/`; delete the transport key, the `ACPX_` env prefix, the acpx re-exports in `agents/index.ts` and the acpx-only `parseAgentError` branches; delete the plumbing tests; re-point `check-adapter-no-config-import.sh`; update the docs (install: the per-agent ACP launcher replaces `acpx`); release nax (approval)." (spec §10)
- Done when: "suite, `typecheck` and `check:all` green; `grep -rn acpx packages/nax/src` returns nothing outside historical comments; release published." (spec §10)
- "`parseAgentError` loses its acpx-only branches (bracketed `ACPX_*` codes, the flat acpx message) and keeps its structured JSON-field parsing." (spec §5.2)
- "`config/tracked-spawn-deadlines.ts` and the `promptRetries` resolution (`agents/manager-dispatch.ts:384`) stay as they are. Only acpx wording in the schema comments is updated." (spec §7.2)
- S4b replaces the transport, not the logic: no retry, swap, stale, cost-ledger or metrics policy changes (spec §1, B7).
- Gates every slice keeps green: `check:all`, `typecheck`, `check:test-satellites`, `check:nax-error`, `check:alias-internals`, `check:import-cycles`, `check:dispatch-field-forwarding`, the file-size gate, the complexity ratchet (spec §10).
- Never bare `bun test`, never `bun run nax`. Package commands run from `packages/nax`. A single file runs as `bun test <path> --timeout=30000` from `packages/nax`.
- Push, PR, merge, release tag: each needs maintainer approval at that moment. No billed run in this slice.
- No emojis in code, comments or docs. Conventional commits.

## Decisions

- **D5-a. Symbols lose the `Sdk` infix with the folder rename.** Once only one ACP transport exists, the `Sdk` infix carries no information, and `agents/acp/` no longer holds an `AcpAgentAdapter`, so the plain names are free. Renames: `AcpSdkAgentAdapter` -> `AcpAgentAdapter`, `_acpSdkDeps` -> `_acpDeps`, `ACP_SDK_AGENT_NAMES` -> `ACP_AGENT_NAMES`, `acpSdkEntry` -> `acpEntry`, `AcpSdkEntry` -> `AcpEntry`, `AcpSdkSession` -> `AcpSession`, `AcpSdkProfile` -> `AcpProfile`, and the log stage string `"acp-sdk"` -> `"acp"`.
- **D5-b. NaxError codes keep their names.** `ACP_SDK_SESSION_NOT_OPEN` and `ACP_SDK_TURN_IN_FLIGHT` appear in logs and in the `check:nax-error` baseline. Renaming them changes a log contract for no behaviour gain. They stay.
- **D5-c. The removed key gets a compat shim that warns, the house pattern for removed keys (`_applyRemovedWorktreeInheritShim`).** `AgentAcpConfigSchema` is not strict, so zod would strip a leftover `agent.acp.transport` silently. A user who pinned `"acpx"` would get the sdk with no signal. The shim drops the key, whatever its value, and warns once. For `"acpx"` the warning names the removal. A bake-off profile carrying the key is loaded through `loadProfile`, not the config loader shim: its key is ignored like any unknown key, and the contestant runs on the only transport. This is pinned in Task 2.
- **D5-d. Merge-conflict rectification discards the crash-leftover transcript instead of spawning `acpx sessions close`.**
  - Why it is needed: BUG-122 closes the failed run's session so the re-run opens fresh. On the sdk transport, nothing lives outside nax to close. A cleanly closed session has already deleted its transcript document. The only stale state is a crash-leftover document under the same session name, and the sdk open path resumes it (spec §6.1). That is the same "continue the failed conversation" the eviction exists to prevent.
  - What the replacement does: it deletes that document. The directory is `deriveNativeTranscriptDir({ featureName: prd.feature, transcriptRoot: runtime.outputDir })`, the same derivation `SessionManager` feeds the adapter (`run-setup-init.ts:105`, `open-session-extras.ts:38`), so it is the logic kept on the new transport (B7).
  - Contract: best-effort, never throws, a no-op when the directory cannot be derived.
  - Cleanup: `evictStaleSessions` has no caller and is deleted.
- **D5-e. `ACPX_` leaves the env allowlist.** No agent process reads `ACPX_*` once acpx is gone. This is behaviour change 15 (Task 7 adds it to spec §11).
- **D5-f. Strings.**
  - User-facing "acpx agent" becomes "ACP agent" (protocol gate, unreferenced-models warning, native-credentials precheck).
  - The `quality.testing.externalBoundaries` example drops `'acpx'` for `'gh'`.
  - The three `compat-shims.ts` messages about the removed `finish.autoFlow` keep the word: they describe a feature that was removed and are the "historical" allowance in the spec's grep rule.
  - Code comments that describe the current system are reworded. Comments that record history (an issue's root cause, "moved out of agents/acp/ in S4b-1") stay.
- **D5-g. Watchdog parity moves to the sdk before deletion.** `test/integration/agents/fail-stale-watchdog.test.ts` (acpx) has four cases the sdk twin does not: thinking activity, usage-only activity, the tool-call-only secondary cap, and the configurable timeout. Spec §6.2.1 requires the sdk to feed the watchdog "the same `AgentStreamEvent` sequence", so these four are ported to `fail-stale-watchdog-sdk.test.ts` in Task 1, while the acpx file still exists. Only then does Task 2 delete the acpx file.
- **D5-h. Release version and the B2 deviation.** B2 said no release carries both transports, but v0.83.5 (#2385, 2026-10-08) shipped the sdk default with acpx still present. S4b-5's release is the next patch, `0.83.6` (nax releases are patch). The PR body and the master-plan row record the deviation. Nothing is re-released or yanked.
- **D5-i. No billed run.**
  - Why none is needed: the S4b-4 smoke already ran the code path this slice keeps, with the key absent, so it ran through the default. Task 3 moves files and renames symbols, and its proof is the suite plus `typecheck`.
  - The one behaviour change is in Task 5, and its unit tests prove it.
  - After release, a bundle probe confirms the acpx client is gone (Task 9).

## Review Focus

1. **A config or profile still carrying `agent.acp.transport`.** `"acpx"` or `"sdk"` in `.nax/config.json` must load, warn once, and run on the ACP SDK. It must not fail validation and must not drop the key silently. Pinned in Task 2 Step 1 (shim tests) and Step 9 (a profile with the key still passes bake-off preflight).
2. **Rectification after a crashed earlier run.** A leftover transcript document under the rectified story's session name must be gone before the re-run opens. A missing directory, a missing document, or a store that throws must never fail rectification. Pinned in Task 5 Step 1.
3. **Error classification without the acpx branches.** Real provider errors must still classify on every adapter: Anthropic JSON envelopes (whole or embedded in text), `statusCode=429`, `error.data.detailCode: "RATE_LIMIT"`, and Claude's "There's an issue with the selected model" text. Only the acpx shapes may fall to `unknown`. Pinned in Task 4 Step 1.
4. **A test that silently spawns a real agent after the acpx sentinel goes.** The sdk sentinel in `test/preload.ts` must survive the rename under its new name, and `preload-sdk-sentinel.test.ts` must still prove it throws. Pinned in Task 2 Step 6 and Task 3 Step 5.
5. **`nax agents` / installed-ness on a machine without acpx.** Listing and health checks must depend only on `_acpDeps.launchCandidateKind`, never on `which("acpx")` or a real PATH. Pinned in Task 2 Step 7 (registry and listing tests stub `launchCandidateKind` only).

---

## File Structure

| Path (under `packages/nax/` unless noted) | Change | Task |
|---|---|---|
| `test/integration/agents/fail-stale-watchdog-sdk.test.ts` | +4 ported watchdog cases | 1 |
| `test/unit/agents/manager.test.ts`, `test/unit/agents/manager-dispatch-emission.test.ts` | acpx client mock -> scripted sdk backend; drop transport pin | 1 |
| `src/config/compat-shims.ts`, `test/unit/config/loader-legacy-shim.test.ts` | `_applyRemovedAcpTransportShim` | 2 |
| `src/config/{agent-defaults,schemas-infra,schemas,index,runtime-types-agent}.ts`, `src/cli/config-descriptions.ts` | delete the key, `AcpTransport`, `DEFAULT_ACP_TRANSPORT` | 2 |
| `src/agents/registry.ts`, `src/agents/index.ts`, `src/cli/agents.ts`, `src/bakeoff/{preflight,coordinator}.ts` | single transport | 2 |
| `src/agents/acp/` (24 files) | delete | 2 |
| `test/unit/agents/acp/` (22 files), `test/unit/agents/adapter-cleanup.test.ts`, `test/integration/agents/fail-stale-watchdog.test.ts` | delete | 2 |
| `test/unit/agents/registry.test.ts` | new: the transport-free cases salvaged from `test/unit/agents/acp/registry.test.ts` | 2 |
| `test/preload.ts` | delete the acpx sentinel | 2 |
| Tests pinning or comparing acpx (`agent-schema`, `registry-native`, `bakeoff/preflight`, `cli/agents-list`, `cli-core-agents{,-sdk}`, `acp-sdk/entries`, `config-descriptions`) | rewrite to sdk-only | 2 |
| `src/agents/acp-sdk/` -> `src/agents/acp/`, `test/unit/agents/acp-sdk/` -> `test/unit/agents/acp/` | `git mv` + D5-a renames | 3 |
| `scripts/check-adapter-no-config-import.sh` + test, `test/integration/cli/adapter-boundary.test.ts`, `test/unit/mcp/acp-exclusion.test.ts` | re-point | 3 |
| `src/agents/errors/parse-agent-error.ts` + test | drop acpx branches | 4 |
| `src/agents/shared/env.ts` + test | drop `ACPX_` | 4 |
| `src/execution/merge-conflict-rectify.ts` + test, `src/agents/acp/session.ts` | D5-d | 5 |
| ~20 `src/` files with acpx strings or comments | D5-f sweep | 6 |
| `packages/nax/README.md`, `docs/guides/{agents,configuration}.md`, `docs/architecture/agent-adapters.md`, `.nax/mono/packages/nax/context.md` (+ generated), `.nax/rules/retry-strategy.md` (+ export), spec §11, master plan row | docs | 7 |
| `scripts/baselines/*.json` | ratchet down deleted/renamed paths | 2, 3, 8 |

---

### Task 1: Move the remaining acpx-client tests onto the sdk transport

These tests use the acpx client only as a stand-in agent, plus four watchdog cases that exist only on acpx. They move now, while both transports exist, so Task 2 deletes nothing that still guards sdk behaviour.

**Files:**
- Modify: `packages/nax/test/integration/agents/fail-stale-watchdog-sdk.test.ts`
- Modify: `packages/nax/test/unit/agents/manager.test.ts` (imports ~lines 10, 24; block ~236-250)
- Modify: `packages/nax/test/unit/agents/manager-dispatch-emission.test.ts` (imports ~lines 17, 36; block ~270-284)

**Interfaces:**
- Consumes: `_acpSdkDeps` (`src/agents/acp-sdk/session.ts:53`; fields `acpBackend`, `resolveRateCard`, `cwdExists`, `launchCandidateKind`), `scriptedOpened`, `replyTurn`, `type ScriptedTurn` from `@test/helpers/acp-fake-agent`, `makeFakeClock` from `@test/helpers` (`setTimeout(cb, ms)`, `advance(ms)` honours timers armed during the advance, `now()`), `type TurnEvent` from `@nathapp/nax-agent`.
- Produces: no test outside `test/unit/agents/acp/`, `test/unit/agents/adapter-cleanup.test.ts` and `test/integration/agents/fail-stale-watchdog.test.ts` imports `_acpAdapterDeps` or `makeClient`/`makeSession` from `./acp/adapter.test`.

- [ ] **Step 1: Add the four ported watchdog cases**

In `fail-stale-watchdog-sdk.test.ts`, add these imports to the existing import lines:

```ts
import type { TurnEvent } from "@nathapp/nax-agent";
import { hangTurn, type ScriptedTurn, scriptedOpened } from "@test/helpers/acp-fake-agent";
```

Below `completeOptions`, add the active-turn script and a driver:

```ts
/**
 * A backend prompt that emits `event` every `intervalMs` on the fake clock and
 * resolves "done" after `durationMs`; aborts like hangTurn if cancelled first.
 */
function activeTurn(event: TurnEvent, intervalMs: number, durationMs: number): ScriptedTurn {
  return (_prompt, opts) =>
    new Promise((resolve, reject) => {
      let elapsed = 0;
      const tick = (): void => {
        if (opts.signal?.aborted) {
          const reason: unknown = opts.signal.reason;
          reject(reason instanceof Error ? reason : new Error("aborted"));
          return;
        }
        elapsed += intervalMs;
        opts.onTurnEvent?.(event);
        if (elapsed >= durationMs) {
          resolve({
            output: "done",
            tokenUsage: { inputTokens: 1, outputTokens: 1 },
            estimatedCostUsd: 0,
            costSource: "reported",
            internalRoundTrips: 1,
          });
          return;
        }
        clock.setTimeout(tick, intervalMs);
      };
      clock.setTimeout(tick, intervalMs);
    });
}

function scriptBackend(turn: ScriptedTurn): void {
  const script = scriptedOpened([turn]);
  _acpSdkDeps.acpBackend = () => ({ kind: "acp:claude", open: async () => script.opened });
}
```

Inside the existing `describe("Idle watchdog stale cancellation (sdk transport)", ...)`, after the AC7 test, add:

```ts
  test("AC10: periodic thinking activity keeps the watchdog from firing", async () => {
    const IDLE_TIMEOUT_MS = 200;
    scriptBackend(activeTurn({ type: "thinking_delta", round: 1, text: "..." }, 50, 250));
    const bus = new AgentStreamEventBus();
    const registry = new Map<string, () => Promise<void>>();
    const detach = attachAgentIdleWatchdog(bus, registry, makeWatchdogConfig(IDLE_TIMEOUT_MS));
    try {
      const pending = new AcpSdkAgentAdapter("claude").complete("p", completeOptions(registry, bus, 5_000));
      await waitForCondition(() => registry.size > 0);
      await clock.advance(0);
      await clock.advance(300);
      const result = await pending;
      expect(result.cancelled).toBeFalsy();
      expect(result.output).toBe("done");
    } finally {
      detach();
    }
  });

  test("AC11: periodic usage-only activity keeps the watchdog from firing", async () => {
    const IDLE_TIMEOUT_MS = 200;
    scriptBackend(
      activeTurn({ type: "usage", round: 1, inputTokens: 1, outputTokens: 1, costUsd: 0, costSource: "reported" }, 50, 250),
    );
    const bus = new AgentStreamEventBus();
    const registry = new Map<string, () => Promise<void>>();
    const detach = attachAgentIdleWatchdog(
      bus,
      registry,
      makeWatchdogConfig(IDLE_TIMEOUT_MS, ["message_update", "thinking_update", "usage_update"]),
    );
    try {
      const pending = new AcpSdkAgentAdapter("claude").complete("p", completeOptions(registry, bus, 5_000));
      await waitForCondition(() => registry.size > 0);
      await clock.advance(0);
      await clock.advance(300);
      const result = await pending;
      expect(result.cancelled).toBeFalsy();
      expect(result.output).toBe("done");
    } finally {
      detach();
    }
  });

  test("tool-call-only activity is not cancelled before the secondary cap", async () => {
    const IDLE_TIMEOUT_MS = 80;
    const TOOL_CALL_ONLY_TIMEOUT_MS = 220;
    // tool_call first so the bridge knows the name; tool_progress heartbeats follow.
    let first = true;
    const turn: ScriptedTurn = (prompt, opts) => {
      if (first) {
        first = false;
        opts.onTurnEvent?.({ type: "tool_call", callId: "c1", name: "Bash", input: {} });
      }
      return activeTurn({ type: "tool_progress", callId: "c1" }, 30, 170)(prompt, opts);
    };
    scriptBackend(turn);
    const bus = new AgentStreamEventBus();
    const registry = new Map<string, () => Promise<void>>();
    const detach = attachAgentIdleWatchdog(
      bus,
      registry,
      makeWatchdogConfig(
        IDLE_TIMEOUT_MS,
        ["message_update", "thinking_update", "usage_update", "tool_call_update"],
        TOOL_CALL_ONLY_TIMEOUT_MS,
      ),
    );
    try {
      const pending = new AcpSdkAgentAdapter("claude").complete("p", completeOptions(registry, bus, 5_000));
      await waitForCondition(() => registry.size > 0);
      await clock.advance(0);
      await clock.advance(200);
      const result = await pending;
      expect(result.cancelled).toBeFalsy();
      expect(result.output).toBe("done");
    } finally {
      detach();
    }
  });

  test("the idle timeout follows config.agent.idleWatchdog.idleTimeoutSeconds", async () => {
    const SHORT_IDLE_TIMEOUT_MS = 60;
    const WALL_CLOCK_TIMEOUT_MS = 2_000;
    const bus = new AgentStreamEventBus();
    const registry = new Map<string, () => Promise<void>>();
    const detach = attachAgentIdleWatchdog(bus, registry, makeWatchdogConfig(SHORT_IDLE_TIMEOUT_MS));
    const startMs = clock.now();
    try {
      const pending = new AcpSdkAgentAdapter("claude").complete(
        "p",
        completeOptions(registry, bus, WALL_CLOCK_TIMEOUT_MS),
      );
      await waitForCondition(() => registry.size > 0);
      await clock.advance(0);
      await clock.advance(SHORT_IDLE_TIMEOUT_MS * 2);
      const result = await pending;
      expect(result.cancelled).toBe(true);
      expect(clock.now() - startMs).toBeLessThan(WALL_CLOCK_TIMEOUT_MS / 2);
    } finally {
      detach();
    }
  });
```

The `beforeEach` already scripts `hangTurn()`. The last test relies on that. The three activity tests replace it with `scriptBackend`, and `afterEach` restores `REAL_SDK`.

- [ ] **Step 2: Run the sdk watchdog file**

Run: `bun test test/integration/agents/fail-stale-watchdog-sdk.test.ts --timeout=30000` (from `packages/nax`)
Expected: 6 pass.

A failure in AC10, AC11 or the tool-call case is a real parity gap in `stream-bridge.ts`, which must emit the same `AgentStreamEvent` sequence as acpx (spec §6.2.1). Stop and report it. Do not loosen the test. An acpx-side counterpart exists in `fail-stale-watchdog.test.ts` (lines 322-417) and is the reference.

- [ ] **Step 3: Re-point `manager.test.ts` "middleware envelope" onto the sdk**

In `test/unit/agents/manager.test.ts`:
- Delete `import { _acpAdapterDeps } from "@/agents/acp/adapter";` and `import { makeClient, makeSession } from "./acp/adapter.test";`.
- Add `import { replyTurn, scriptedOpened } from "@test/helpers/acp-fake-agent";`, `import { _acpSdkDeps } from "@/agents/acp-sdk";` and `import { FALLBACK_RATES } from "@/agents/cost";` (skip any that already exist).

Replace the block's setup:

```ts
describe("AgentManager — middleware envelope", () => {
  const REAL_SDK = { ..._acpSdkDeps };
  beforeEach(() => {
    _acpSdkDeps.resolveRateCard = () => Promise.resolve({ rates: FALLBACK_RATES, source: "fallback-rates" });
    _acpSdkDeps.cwdExists = async () => true;
    const script = scriptedOpened([replyTurn("ok")]);
    _acpSdkDeps.acpBackend = () => ({ kind: "acp:claude", open: async () => script.opened });
  });
  afterEach(() => {
    Object.assign(_acpSdkDeps, REAL_SDK);
    mock.restore();
  });

  function makeMiddlewareManager(mw?: AgentMiddleware): AgentManager {
    return new AgentManager(makeNaxConfig(), undefined, {
      middleware: mw ? MiddlewareChain.from([mw]) : MiddlewareChain.empty(),
      runId: "r-test",
    });
  }
```

The test bodies stay unchanged.

- [ ] **Step 4: Re-point `manager-dispatch-emission.test.ts` "completeAs — dispatch emission" the same way**

Make the same import changes as Step 3. Then make the same `REAL_SDK` / `beforeEach` / `afterEach` replacement in `describe("completeAs — dispatch emission", ...)`. In its test, replace

```ts
    // acpx transport pinned until S4b-5 deletes it: the mocked client above is acpx's.
    const config = makeNaxConfig({ agent: { acp: { transport: "acpx" } } });
```

with `const config = makeNaxConfig();`.

- [ ] **Step 5: Run both files**

Run: `bun test test/unit/agents/manager.test.ts test/unit/agents/manager-dispatch-emission.test.ts --timeout=30000`
Expected: all pass. If one fails, check that every `_acpSdkDeps` field the path reads is stubbed. The four fields above are the ones the sdk integration tests stub. Never stub the real PATH.

- [ ] **Step 6: Confirm no stray acpx-client consumer remains outside the doomed files**

Run: `grep -rlnE "_acpAdapterDeps|acp/adapter\.test" test | grep -vE "^test/unit/agents/acp/|adapter-cleanup|fail-stale-watchdog\.test" | sort`
Expected exactly: `test/integration/cli/cli-core-agents.test.ts`, `test/preload.ts`, `test/unit/cli/agents-list.test.ts`, `test/unit/agents/registry-native.test.ts`. Task 2 rewrites those four. Any other file is a new consumer: move it the same way as Step 3 before continuing.

- [ ] **Step 7: Commit**

```bash
git add packages/nax/test/integration/agents/fail-stale-watchdog-sdk.test.ts packages/nax/test/unit/agents/manager.test.ts packages/nax/test/unit/agents/manager-dispatch-emission.test.ts
git commit -m "test(nax): S4b-5 port acpx-only watchdog cases and manager tests to the sdk transport"
```

---

### Task 2: Delete the transport key and the acpx transport

**Files:**
- Modify: `packages/nax/src/config/compat-shims.ts` (new shim near line 211; chain at ~537)
- Test: `packages/nax/test/unit/config/loader-legacy-shim.test.ts`
- Modify: `packages/nax/src/config/agent-defaults.ts:19-27`, `src/config/schemas-infra.ts:9,323-346,417-422`, `src/config/schemas.ts:15,359`, `src/config/index.ts:4-5`, `src/config/runtime-types-agent.ts:8,83`, `src/cli/config-descriptions.ts:302-303`
- Modify: `packages/nax/src/agents/registry.ts`, `src/agents/index.ts:3-30`, `src/cli/agents.ts:8-12,26-43`, `src/bakeoff/preflight.ts`, `src/bakeoff/coordinator.ts:11,85`
- Delete: `packages/nax/src/agents/acp/` (whole folder)
- Delete: `packages/nax/test/unit/agents/acp/` (whole folder), `test/unit/agents/adapter-cleanup.test.ts`, `test/integration/agents/fail-stale-watchdog.test.ts`
- Create: `packages/nax/test/unit/agents/registry.test.ts`
- Modify: `packages/nax/test/preload.ts`, `test/unit/config/agent-schema.test.ts:129-155`, `test/unit/agents/registry-native.test.ts`, `test/unit/bakeoff/preflight.test.ts`, `test/unit/cli/agents-list.test.ts`, `test/integration/cli/cli-core-agents.test.ts`, `test/integration/cli/cli-core-agents-sdk.test.ts`, `test/unit/agents/acp-sdk/entries.test.ts`, `test/unit/cli/config-descriptions.test.ts:173-180`
- Modify: `packages/nax/scripts/baselines/{complexity,file-sizes,test-escape-hatches}-baseline.json` (via `:update`)

**Interfaces:**
- Consumes: `defaultConfigWarn` and the `warn` sink type `(msg: string) => void` from `compat-shims.ts`. `AcpSdkAgentAdapter`, `ACP_SDK_AGENT_NAMES` and `_acpSdkDeps` from `src/agents/acp-sdk` (renamed in Task 3).
- Produces:
  - `export function _applyRemovedAcpTransportShim(conf: Record<string, unknown>, warn?: (msg: string) => void): Record<string, unknown>` in `compat-shims.ts`.
  - `acpAdapterFor(name: string): AgentAdapter` in `registry.ts`, with the transport parameter gone.
  - `PreflightDeps.isInstalled: (agentName: string) => boolean | Promise<boolean>`.
  - `validateContestants(names, projectRoot, deps?)`, with the `baseTransport` parameter gone.
  - `AcpTransport` and `DEFAULT_ACP_TRANSPORT` no longer exist.

- [ ] **Step 1: Write the failing shim tests**

In `test/unit/config/loader-legacy-shim.test.ts`, add `_applyRemovedAcpTransportShim` to the existing import from `@/config/compat-shims`, then append:

```ts
describe("_applyRemovedAcpTransportShim — agent.acp.transport removed with acpx (S4b-5)", () => {
  test("drops transport 'acpx', keeps the other acp keys, and warns that acpx is gone", () => {
    const warnings: string[] = [];
    const conf = { agent: { acp: { transport: "acpx", promptRetries: 2 } } };
    const result = _applyRemovedAcpTransportShim(conf, (msg) => warnings.push(msg));
    expect(result).toEqual({ agent: { acp: { promptRetries: 2 } } });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("agent.acp.transport");
    expect(warnings[0]).toContain("acpx");
  });

  test("drops transport 'sdk' with a warning that the key is no longer read", () => {
    const warnings: string[] = [];
    const result = _applyRemovedAcpTransportShim({ agent: { acp: { transport: "sdk" } } }, (msg) =>
      warnings.push(msg),
    );
    expect(result).toEqual({ agent: { acp: {} } });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("agent.acp.transport");
  });

  test("returns the input unchanged and silent when the key is absent", () => {
    const warnings: string[] = [];
    const conf = { agent: { acp: { promptRetries: 1 } } };
    expect(_applyRemovedAcpTransportShim(conf, (msg) => warnings.push(msg))).toBe(conf);
    expect(warnings).toEqual([]);
  });

  test("does not mutate its input", () => {
    const conf = { agent: { acp: { transport: "acpx" } } };
    _applyRemovedAcpTransportShim(conf, () => {});
    expect(conf.agent.acp.transport).toBe("acpx");
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test test/unit/config/loader-legacy-shim.test.ts --timeout=30000`
Expected: FAIL, `_applyRemovedAcpTransportShim` is not exported.

- [ ] **Step 3: Implement the shim and wire it into the chain**

In `src/config/compat-shims.ts`, after `_applyRemovedWorktreeInheritShim`:

```ts
/**
 * @internal S4b-5: `agent.acp.transport` was removed with the acpx transport.
 * ACP agents always run through @nathapp/nax-agent-acp. The key is dropped,
 * whatever its value, so a pinned "acpx" is reported rather than silently
 * stripped by the (non-strict) acp schema.
 * Returns a new object (immutable -- does not mutate the input).
 */
export function _applyRemovedAcpTransportShim(
  conf: Record<string, unknown>,
  warn: (msg: string) => void = defaultConfigWarn,
): Record<string, unknown> {
  const agent = conf.agent as Record<string, unknown> | undefined;
  const acp = agent?.acp as Record<string, unknown> | undefined;
  if (acp === undefined || !Object.hasOwn(acp, "transport")) return conf;

  const { transport, ...rest } = acp;
  warn(
    transport === "acpx"
      ? 'agent.acp.transport "acpx" was removed: the acpx CLI transport no longer exists, and ACP agents run through ' +
          "@nathapp/nax-agent-acp (each agent's ACP launcher must be installed). Remove the key from your config."
      : "agent.acp.transport was removed and has no effect: ACP agents always run through @nathapp/nax-agent-acp. " +
          "Remove the key from your config.",
  );
  return { ...conf, agent: { ...agent, acp: rest } };
}
```

In the chain function (~line 537), add `out = _applyRemovedAcpTransportShim(out, warn);` after `_applyRemovedWorktreeInheritShim`.

- [ ] **Step 4: Run the shim tests**

Run: `bun test test/unit/config/loader-legacy-shim.test.ts --timeout=30000`
Expected: PASS.

- [ ] **Step 5: Delete the key from the config surface**

- `src/config/agent-defaults.ts`: delete the `AcpTransport` doc comment, the type and `DEFAULT_ACP_TRANSPORT` (lines 19-27). Change the protocol comment on line 14 to `/** The native agent runs by default, with the ACP agents still reachable. */`.
- `src/config/schemas-infra.ts`:
  - Drop `DEFAULT_ACP_TRANSPORT` from the import on line 9.
  - Delete the `transport` doc comment and field (lines 324-329).
  - Delete `transport: DEFAULT_ACP_TRANSPORT,` from the `acp` default (line 418).
  - Reword the two deadline doc comments without acpx:
    - `trackedSpawnDeadlineMs`: "Hard deadline (ms) for teardown: closing an ACP session and the cancel grace (capped by the backend). Keeps run teardown from hanging on a wedged agent process (PERF-1). Issue #1583: keep it tight; it must NOT be reused for startup (see trackedSpawnStartupDeadlineMs)."
    - `trackedSpawnStartupDeadlineMs`: "Hard deadline (ms) for startup: launching the agent and opening or restoring its ACP session. Issue #1583: session start measured a real-world median of 8.15s, so this needs real headroom under concurrency; do not lower it toward the teardown deadline."
- `src/config/schemas.ts`: drop `DEFAULT_ACP_TRANSPORT` from the import (line 15) and `transport: DEFAULT_ACP_TRANSPORT,` (line 359).
- `src/config/index.ts`: drop `type AcpTransport,` and `DEFAULT_ACP_TRANSPORT,` from the re-export.
- `src/config/runtime-types-agent.ts`: drop the `AcpTransport` import and the `transport?: AcpTransport;` field with its comment.
- `src/cli/config-descriptions.ts`: delete the `"agent.acp.transport"` entry (lines 302-303).
- `test/unit/cli/config-descriptions.test.ts`: replace the `describe("FIELD_DESCRIPTIONS agent.acp.transport (S4b-2)", ...)` block with:

```ts
describe("FIELD_DESCRIPTIONS agent.acp.transport (removed in S4b-5)", () => {
  test("has no entry for the removed key", () => {
    expect(Object.hasOwn(FIELD_DESCRIPTIONS, "agent.acp.transport")).toBe(false);
  });
});
```

- `test/unit/config/agent-schema.test.ts`: replace the four `agent.acp.transport ...` tests (lines ~129-155) with:

```ts
  test("agent.acp has no transport key after S4b-5", () => {
    const result = NaxConfigSchema.parse({});
    expect(result.agent?.acp).toEqual({ promptRetries: 0, trackedSpawnDeadlineMs: 10_000, trackedSpawnStartupDeadlineMs: 30_000 });
  });
```

- [ ] **Step 6: Make the registry, listing and bake-off single-transport; delete the acpx barrel and sentinel**

Write `src/agents/registry.ts` as follows. The header comment, `acpAdapterFor`, `adapterFor`, `createAgentRegistry`'s doc comment and its transport lines change. Every other function is unchanged:

```ts
/**
 * Agent Registry
 *
 * Discovers and manages available coding agents. The agent name selects the
 * transport: every known name but `native` is an ACP adapter over
 * @nathapp/nax-agent-acp, and `native` is the in-process nax-ai path
 * (ADR-027 section 3).
 */

import { NATIVE_AGENT } from "@nathapp/nax-agent";
import { DEFAULT_AGENT_PROTOCOL } from "@/config";
import type { AgentManagerConfig } from "@/config/selectors";
import { getLogger } from "../logger";
import { AcpSdkAgentAdapter } from "./acp-sdk";
import { NativeAgentAdapter } from "./native-agent";
import type { AgentAdapter } from "./types";
```

```ts
/** The adapter for a non-native agent (S4b spec §5.3). */
export function acpAdapterFor(name: string): AgentAdapter {
  return new AcpSdkAgentAdapter(name);
}

function adapterFor(name: string): AgentAdapter {
  return name === NATIVE_AGENT ? new NativeAgentAdapter() : acpAdapterFor(name);
}
```

In `createAgentRegistry`:
- Delete the `transport` const and its `if` log (old lines 122-125).
- Change `: acpAdapterFor(name, transport);` to `: acpAdapterFor(name);`.
- In its doc comment, change "every other known name gets `AcpAgentAdapter`" to "every other known name gets the ACP adapter".
- Delete the comment line "Widened from Map<string, AcpAgentAdapter>: the registry is a routing decision now, so the cache holds whichever adapter the name selects." and keep the `adapterCache` declaration.

`src/agents/index.ts`: delete the two `from "./acp"` blocks (lines 3-30: the type export and the value export, including the `@internal` comment).

`src/cli/agents.ts`:
- Drop `DEFAULT_ACP_TRANSPORT` from the config import.
- Delete the `transport` line.
- Make the adapters line `Array.from(ACP_SDK_AGENT_NAMES).map((name) => acpAdapterFor(name))`.
- In the doc comment near line 26-27, drop "; the same set as acpx's `ACP_ADAPTER_NAMES`".

`src/bakeoff/preflight.ts`:
- Import `deepMergeConfig, type NaxConfig` only from `../config`.
- Change both `isInstalled` signatures in `PreflightDeps` / `PreflightCallableDeps` to `(agentName: string) => boolean | Promise<boolean>`.
- Change `_preflightDeps.isInstalled` to `(agentName: string) => acpAdapterFor(agentName).isInstalled()`.
- Delete `contestantTransport` (lines 78-83).
- Delete the `baseTransport` parameter from `validateContestants`.
- Inside it, call `isInstalled(agentName)` where it called `isInstalled(agentName, contestantTransport(...))`.

`src/bakeoff/coordinator.ts`: drop the `DEFAULT_ACP_TRANSPORT` import and the `options.config.agent?.acp?.transport ?? DEFAULT_ACP_TRANSPORT,` argument (line 85).

`test/preload.ts`: delete `import { _acpAdapterDeps } from "../src/agents/acp/adapter";` and the whole "ACP spawn sentinel" section (the comment block and the `_acpAdapterDeps.createClient = ...` assignment). Then rename the remaining section header from "ACP sdk spawn sentinel (S4b-4)" to "ACP spawn sentinel". Its first comment line becomes "ACP agents run through nax-agent-acp."

Delete:

```bash
git rm -r -q packages/nax/src/agents/acp packages/nax/test/unit/agents/acp
git rm -q packages/nax/test/unit/agents/adapter-cleanup.test.ts packages/nax/test/integration/agents/fail-stale-watchdog.test.ts
```

- [ ] **Step 7: Rewrite the tests that pinned or compared acpx**

Create `test/unit/agents/registry.test.ts`. It holds the transport-free cases salvaged from the deleted `test/unit/agents/acp/registry.test.ts`, with installed-ness stubbed through `launchCandidateKind` only:

```ts
/**
 * Registry routing, instance reuse, health and the BUG-19 module-level
 * functions (salvaged from the acpx-era ACP-003 suite in S4b-5). Installed-ness
 * of ACP agents comes from _acpSdkDeps.launchCandidateKind; never the real PATH.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { makeNaxConfig } from "@test/helpers";
import { _acpSdkDeps, AcpSdkAgentAdapter } from "@/agents/acp-sdk";
import { _registryTestAdapters, checkAgentHealth, createAgentRegistry, getInstalledAgents } from "@/agents/registry";
import type { NaxConfig } from "@/config/schema";
import { DEFAULT_CONFIG } from "@/config/schema";
import { logActiveProtocol } from "@/execution/lifecycle/run-initialization";

const origLaunchKind = _acpSdkDeps.launchCandidateKind;

function launcherFound(found: boolean): void {
  _acpSdkDeps.launchCandidateKind = mock(() => (found ? "local" : undefined));
}

afterEach(() => {
  _acpSdkDeps.launchCandidateKind = origLaunchKind;
  mock.restore();
});

describe("createAgentRegistry — protocol selection", () => {
  test("returns the ACP adapter for 'claude', named 'claude'", () => {
    const agent = createAgentRegistry(makeNaxConfig({ agent: { protocol: "acp" } })).getAgent("claude");
    expect(agent).toBeInstanceOf(AcpSdkAgentAdapter);
    expect(agent?.name).toBe("claude");
  });

  test("returns undefined for an unknown agent name", () => {
    expect(createAgentRegistry(makeNaxConfig({ agent: { protocol: "acp" } })).getAgent("unknown-agent-xyz")).toBeUndefined();
  });

  test("resolves the protocol field from config", () => {
    expect(createAgentRegistry(makeNaxConfig({ agent: { protocol: "acp", default: "claude" } })).protocol).toBe("acp");
    expect(createAgentRegistry(makeNaxConfig({ agent: { protocol: "native" } })).protocol).toBe("native");
    expect(createAgentRegistry(makeNaxConfig({ agent: { protocol: "hybrid" } })).protocol).toBe("hybrid");
  });
});

describe("createAgentRegistry — instance reuse", () => {
  test("returns the same instance on repeated getAgent calls", () => {
    const registry = createAgentRegistry(makeNaxConfig({ agent: { protocol: "acp" } }));
    expect(registry.getAgent("claude")).toBe(registry.getAgent("claude"));
  });

  test("creates distinct instances for different names and for separate registries", () => {
    const r1 = createAgentRegistry(makeNaxConfig({ agent: { protocol: "acp" } }));
    const r2 = createAgentRegistry(makeNaxConfig({ agent: { protocol: "acp" } }));
    expect(r1.getAgent("claude")).not.toBe(r1.getAgent("codex"));
    expect(r1.getAgent("claude")).not.toBe(r2.getAgent("claude"));
  });
});

describe("Config schema — AgentConfig", () => {
  test("NaxConfig accepts agent.protocol 'acp'", () => {
    const config: NaxConfig = makeNaxConfig({ agent: { protocol: "acp" } });
    expect(config.agent?.protocol).toBe("acp");
  });

  test("DEFAULT_CONFIG has agent.protocol 'hybrid'", () => {
    expect(DEFAULT_CONFIG.agent?.protocol).toBe("hybrid");
  });
});

describe("createAgentRegistry — checkAgentHealth()", () => {
  test("every entry has name, displayName and installed", async () => {
    launcherFound(true);
    const health = await createAgentRegistry(makeNaxConfig({ agent: { protocol: "acp" } })).checkAgentHealth();
    expect(health.length).toBeGreaterThan(0);
    for (const entry of health) {
      expect(typeof entry.name).toBe("string");
      expect(typeof entry.displayName).toBe("string");
      expect(typeof entry.installed).toBe("boolean");
    }
  });

  test("claude is installed exactly when its ACP launcher is found", async () => {
    launcherFound(true);
    const found = await createAgentRegistry(makeNaxConfig({ agent: { protocol: "acp" } })).checkAgentHealth();
    expect(found.find((e) => e.name === "claude")?.installed).toBe(true);
    launcherFound(false);
    const missing = await createAgentRegistry(makeNaxConfig({ agent: { protocol: "acp" } })).checkAgentHealth();
    expect(missing.find((e) => e.name === "claude")?.installed).toBe(false);
  });
});

describe("module-level getInstalledAgents() / checkAgentHealth() (BUG-19)", () => {
  beforeEach(() => _registryTestAdapters.clear());
  afterEach(() => _registryTestAdapters.clear());

  test("getInstalledAgents returns installed adapters instead of an unconditional []", async () => {
    launcherFound(true);
    const installed = await getInstalledAgents();
    expect(installed.some((a) => a.name === "claude")).toBe(true);
  });

  test("getInstalledAgents returns no ACP agents when no launcher is available", async () => {
    launcherFound(false);
    const installed = await getInstalledAgents();
    expect(installed.filter((a) => a.name !== "native")).toEqual([]);
  });

  test("checkAgentHealth reflects real installed status", async () => {
    launcherFound(true);
    const health = await checkAgentHealth();
    expect(health.find((e) => e.name === "claude")?.installed).toBe(true);
  });
});

describe("logActiveProtocol()", () => {
  test("does not throw for protocol 'acp' or an unset agent config", () => {
    expect(() => logActiveProtocol(makeNaxConfig({ agent: { protocol: "acp" } }))).not.toThrow();
    expect(() => logActiveProtocol(makeNaxConfig())).not.toThrow();
  });
});
```

Then make these edits:
- `test/unit/agents/registry-native.test.ts`:
  - Delete the `AcpAgentAdapter` import (line 14).
  - Delete the assertion `expect(acpAdapterFor("claude", "acpx")).toBeInstanceOf(AcpAgentAdapter);`.
  - Change `acpAdapterFor("claude", "sdk")` to `acpAdapterFor("claude")`.
  - Replace the test "createAgentRegistry routes ACP agents by agent.acp.transport, native unchanged" with:

```ts
  test("createAgentRegistry routes ACP agents to the ACP adapter, native unchanged", () => {
    const registry = createAgentRegistry(makeNaxConfig({}));
    expect(registry.getAgent("claude")).toBeInstanceOf(AcpSdkAgentAdapter);
    expect(registry.getAgent("native")).toBeInstanceOf(NativeAgentAdapter);
  });
```

- `test/unit/bakeoff/preflight.test.ts`:
  - Delete the test "a profile's agent.acp.transport acpx still wins over the sdk default" (~lines 206-220).
  - Every `isInstalled` stub that takes `(name, transport)` becomes `(name)`. A stub that records `` `${name}:${transport}` `` records `name`, and its expectation drops the `:sdk` suffix.
  - Add a test for Review Focus 1. It reuses the file's existing `profileDir` / `projectRoot` setup and the `writeFileSync` + `join` helpers the deleted test used:

```ts
    it("a profile that still sets agent.acp.transport validates on the only transport", async () => {
      writeFileSync(
        join(profileDir, "legacy-transport.json"),
        JSON.stringify({ agent: { default: "pi", acp: { transport: "acpx" } } }),
      );
      const seen: string[] = [];
      const result = await validateContestants(["legacy-transport"], projectRoot, {
        isInstalled: (name: string) => {
          seen.push(name);
          return true;
        },
      });
      expect(seen).toEqual(["pi"]);
      expect(result.errors).toEqual([]);
    });
```

  If the result field the file asserts on is named differently from `errors`, use the name the neighbouring tests use (`ContestantValidationResult`, `src/bakeoff/preflight.ts`).
- `test/unit/cli/agents-list.test.ts`:
  - Delete the `_acpAdapterDeps` import and the `ACP_ADAPTER_NAMES` import from `@/agents/acp`. Import `ACP_SDK_AGENT_NAMES` from `@/agents/acp-sdk`.
  - Delete `origWhich` and both `_acpAdapterDeps.which` lines, plus the comment line mentioning the acpx probe.
  - Replace `ACP_ADAPTER_NAMES` with `ACP_SDK_AGENT_NAMES` in the describe title, comments and loops.
  - Delete the test "S4b-2: transport sdk lists the same agents through the SDK adapter". It compared transports; the remaining tests cover the listing.
  - The test that read "resolves via which()" becomes "has an ACP launcher". It is stubbed by the existing `launchCandidateKind` mock.
- `test/integration/cli/cli-core-agents.test.ts`: delete the `_acpAdapterDeps` import, `origWhich` and its two assignments. Rename the test "marks an acpx default agent, and omits native under protocol acp" to "marks an ACP default agent, and omits native under protocol acp".
- `test/integration/cli/cli-core-agents-sdk.test.ts`:
  - Delete the test "lists the same agents as the acpx transport".
  - Change the header comment to "`nax agents` on the ACP transport (S4b spec §9): install status comes from each agent's ACP launcher."
- `test/unit/agents/acp-sdk/entries.test.ts`: replace the file. It drops the parity-with-acpx comparisons and keeps the row values as literal expectations:

```ts
import { describe, expect, test } from "bun:test";
import { ACP_SDK_AGENT_NAMES, acpSdkEntry } from "@/agents/acp-sdk";

describe("ACP agent entries", () => {
  test("lists the agents that have an ACP launcher (no aider)", () => {
    expect([...ACP_SDK_AGENT_NAMES].sort()).toEqual(["claude", "codex", "gemini", "opencode", "pi"]);
  });

  test("every listed agent has a display name, tiers and a context size", () => {
    for (const name of ACP_SDK_AGENT_NAMES) {
      const entry = acpSdkEntry(name);
      expect(entry.displayName.length).toBeGreaterThan(0);
      expect(entry.supportedTiers.length).toBeGreaterThan(0);
      expect(entry.maxContextTokens).toBeGreaterThan(0);
    }
  });
});
```

  Before writing it, read `src/agents/acp-sdk/entries.ts` and match the real field names and the `acpSdkEntry` signature. If the name list differs from the five above, the source is the truth: use its sorted list.

- [ ] **Step 8: Typecheck and grep for stragglers**

Run: `bun run typecheck` (from `packages/nax`)
Expected: clean. Every error is a reference to a deleted symbol: fix the reference, never re-add the symbol.

Run: `grep -rnE "_acpAdapterDeps|AcpTransport|DEFAULT_ACP_TRANSPORT|agents/acp/(adapter|spawn|parser)|acp\?*\.transport" src test | grep -v "compat-shims\|loader-legacy-shim\|config-descriptions.test\|preflight.test"`
Expected: no output.

- [ ] **Step 9: Run the touched tests, then the suite**

Run: `bun test test/unit/agents/registry.test.ts test/unit/agents/registry-native.test.ts test/unit/bakeoff/preflight.test.ts test/unit/cli/agents-list.test.ts test/integration/cli/cli-core-agents.test.ts test/integration/cli/cli-core-agents-sdk.test.ts test/unit/agents/acp-sdk/entries.test.ts test/unit/config/agent-schema.test.ts test/unit/cli/config-descriptions.test.ts test/unit/preload-sdk-sentinel.test.ts --timeout=30000`
Expected: all pass.

Run: `bun run test` (from `packages/nax`)
Expected: all phases pass.

- [ ] **Step 10: Ratchet the baselines down**

Run: `bun run check:complexity:update && bun run check:file-sizes:update && bun run check:test-escape-hatches:update`
Expected: the entries for `src/agents/acp/*` and `test/unit/agents/acp/*` disappear. No other entry changes. Check this with `git diff scripts/baselines`. If another entry changes, revert that hunk and report it.

- [ ] **Step 11: Commit**

```bash
git add -A packages/nax/src packages/nax/test packages/nax/scripts/baselines
git commit -m "feat(nax)!: S4b-5 delete the acpx transport and agent.acp.transport

ACP agents run only through @nathapp/nax-agent-acp. A leftover
agent.acp.transport is dropped with a warning (compat shim)."
```

---

### Task 3: Rename `acp-sdk/` to `acp/` and drop the `Sdk` infix (D5-a)

**Files:**
- Move: `packages/nax/src/agents/acp-sdk/` -> `packages/nax/src/agents/acp/`
- Move: `packages/nax/test/unit/agents/acp-sdk/` -> `packages/nax/test/unit/agents/acp/`
- Move: `packages/nax/test/integration/agents/fail-stale-watchdog-sdk.test.ts` -> `fail-stale-watchdog.test.ts`; `test/integration/cli/cli-core-agents-sdk.test.ts` -> merge into `cli-core-agents.test.ts`
- Move: `packages/nax/test/unit/preload-sdk-sentinel.test.ts` -> `test/unit/preload-acp-sentinel.test.ts`
- Modify: every importer (`grep -rln "acp-sdk\|AcpSdk\|_acpSdkDeps\|ACP_SDK_AGENT_NAMES\|acpSdkEntry" src test scripts`)
- Modify: `packages/nax/scripts/check-adapter-no-config-import.sh:2,11`, `test/unit/scripts/check-adapter-no-config-import.test.ts:93-101`, `test/integration/cli/adapter-boundary.test.ts:23`, `test/unit/mcp/acp-exclusion.test.ts`

**Interfaces:**
- Consumes: Task 2's tree.
- Produces: `@/agents/acp` exports `AcpAgentAdapter`, `ACP_AGENT_NAMES`, `acpEntry`, `_acpDeps` (and `discardAcpSessionLeftover` after Task 5). `src/agents/acp/session.ts` exports `_acpDeps`, `type AcpSession`. The NaxError codes `ACP_SDK_SESSION_NOT_OPEN` and `ACP_SDK_TURN_IN_FLIGHT` are unchanged (D5-b).

- [ ] **Step 1: Move the folders with history**

```bash
cd packages/nax
git mv src/agents/acp-sdk src/agents/acp
git mv test/unit/agents/acp-sdk test/unit/agents/acp
git mv test/integration/agents/fail-stale-watchdog-sdk.test.ts test/integration/agents/fail-stale-watchdog.test.ts
git mv test/unit/preload-sdk-sentinel.test.ts test/unit/preload-acp-sentinel.test.ts
```

- [ ] **Step 2: Rewrite paths and symbols**

Run from `packages/nax`. These are word-bounded replacements, longest first, so `AcpSdkAgentAdapter` is not half-replaced by `AcpSdk`:

```bash
files=$(grep -rlE "acp-sdk|AcpSdk|_acpSdkDeps|ACP_SDK_AGENT_NAMES|acpSdkEntry" src test scripts)
perl -pi -e '
  s{agents/acp-sdk}{agents/acp}g;
  s{\./acp-sdk\b}{./acp}g;
  s/\bAcpSdkAgentAdapter\b/AcpAgentAdapter/g;
  s/\bAcpSdkSession\b/AcpSession/g;
  s/\bAcpSdkEntry\b/AcpEntry/g;
  s/\bAcpSdkProfile\b/AcpProfile/g;
  s/\b_acpSdkDeps\b/_acpDeps/g;
  s/\bACP_SDK_AGENT_NAMES\b/ACP_AGENT_NAMES/g;
  s/\bacpSdkEntry\b/acpEntry/g;
' $files
grep -rl '"acp-sdk"' src/agents/acp | xargs perl -pi -e 's/"acp-sdk"/"acp"/g'
```

`ACP_SDK_SESSION_NOT_OPEN` and `ACP_SDK_TURN_IN_FLIGHT` are untouched by these patterns (D5-b). Confirm: `grep -rn "ACP_SDK_" src | grep -v "ACP_SDK_SESSION_NOT_OPEN\|ACP_SDK_TURN_IN_FLIGHT"` returns nothing.

- [ ] **Step 3: Fold the `cli-core-agents` sdk file into the main one**

Move the single remaining test of `test/integration/cli/cli-core-agents-sdk.test.ts` ("claude shows installed through its ACP launcher; the others do not") into `cli-core-agents.test.ts`'s `describe("agentsListCommand", ...)`, reusing that file's existing `launchCandidateKind` stub (claude found, the others not). Then delete the sdk file: `git rm -q test/integration/cli/cli-core-agents-sdk.test.ts`.

In the moved `test/integration/agents/fail-stale-watchdog.test.ts`, change the describe title to `"Idle watchdog stale cancellation (ACP)"`. Change the header comment's last clause to "with the backend scripted in memory (scriptedOpened)."

- [ ] **Step 4: Re-point the guards**

- `scripts/check-adapter-no-config-import.sh`: change line 2 to `# Fail if any file under src/agents/{acp,native-agent}/ reads NaxConfig or CompleteConfig from complete() options,`. Change line 11 to `scan_dirs="src/agents/acp/ src/agents/native-agent/"`.
- `test/unit/scripts/check-adapter-no-config-import.test.ts`: delete the test "S4b-2: the acp-sdk adapter is scanned too" (lines ~93-102). Confirm that a test seeding a violation under `src/agents/acp/` still exists in the file. If none does, change the deleted test's path to `src/agents/acp/x.ts`, its title to "the ACP adapter is scanned", and its expected text to `acp/x.ts`, and keep it.
- `test/integration/cli/adapter-boundary.test.ts:23`: the step 2 replacement made it `"agents/acp/turn-loop.ts"`. Change its trailing comment to `// the ACP send-turn loop over nax-agent-acp's adapter`.
- `test/unit/mcp/acp-exclusion.test.ts`: no code change, because it already scans `src/agents/acp`. Step 5 runs it against the renamed folder.

- [ ] **Step 5: Verify**

Run: `bun run typecheck`
Expected: clean.

Run: `bun test test/unit/agents/acp test/integration/agents/fail-stale-watchdog.test.ts test/integration/cli/cli-core-agents.test.ts test/unit/preload-acp-sentinel.test.ts test/unit/mcp/acp-exclusion.test.ts test/unit/scripts/check-adapter-no-config-import.test.ts test/integration/cli/adapter-boundary.test.ts --timeout=30000`
Expected: all pass. `preload-acp-sentinel.test.ts` asserts the message `"[test-preload] _acpDeps.acpBackend called without a mock"`. Step 2 renamed it in both preload and test.

Run: `bun run check:adapter-no-config-import && bun run check:import-cycles && bun run check:alias-internals && bun run check:package-boundaries`
Expected: all OK.

Run: `grep -rn "acp-sdk\|AcpSdk\|_acpSdkDeps\|ACP_SDK_AGENT_NAMES" src test scripts`
Expected: no output. A remaining hit is a doc-comment mention. Reword it to "ACP" or the new path.

- [ ] **Step 6: Ratchet the baselines for the renamed paths**

Run: `bun run check:complexity:update && bun run check:file-sizes:update && bun run check:test-escape-hatches:update && bun run check:logger-storyid:update && bun run check:test-satellites:update`
Expected: only renames of `acp-sdk` paths to `acp` paths, with values unchanged. Check `git diff scripts/baselines`. A changed value means the move changed a file, so stop and report.

- [ ] **Step 7: Commit**

```bash
git add -A packages/nax/src packages/nax/test packages/nax/scripts
git commit -m "refactor(nax): S4b-5 rename agents/acp-sdk to agents/acp and drop the Sdk infix"
```

---

### Task 4: Drop the acpx-only branches from `parseAgentError` and the `ACPX_` env prefix

**Files:**
- Modify: `packages/nax/src/agents/errors/parse-agent-error.ts` (lines 1-25 doc, 100-150, 165-170, 293-332, 352-382, 399-427)
- Test: `packages/nax/test/unit/agents/errors/parse-agent-error.test.ts`
- Modify: `packages/nax/src/agents/shared/env.ts:6,33`
- Test: the existing `buildAllowedEnv` test. Find it with `grep -rln "buildAllowedEnv" test/unit`.

**Interfaces:**
- Consumes: none new.
- Produces: `parseAgentError(stderr: string): AgentError` with the same signature. The bracketed-code path, the `acpxCode` field and key, and the `Cannot apply --model` / `Cannot replay saved model` prefixes are gone. `buildAllowedEnv` no longer passes `ACPX_*`.

- [ ] **Step 1: Write the failing tests**

In `parse-agent-error.test.ts`:
- Delete the `test.each` "detects %s from bracketed acpx codes" (~lines 22-30).
- Delete the "acpx 0.6.1 strict --model validation" cases (~lines 105-140) whose inputs are the acpx `Cannot apply --model` / `Cannot replay saved model` strings or envelopes.
- Delete every other case whose input carries `acpxCode`. Read each remaining case that mentions acpx: if its input is a vendor JSON shape (for example the #592 embedded Anthropic envelope), keep it and reword only its comment.

Then append:

```ts
describe("S4b-5: acpx-only shapes no longer classify", () => {
  test.each([
    ["bracketed acpx code", "acpx session failed [ACPX_RATE_LIMIT/TOO_MANY_REQUESTS]"],
    ["acpx model-support prefix", 'Cannot apply --model "x": the ACP agent did not advertise that model.'],
    ["acpx replay prefix", 'Cannot replay saved model "x"'],
    ["acpxCode JSON field", '{"error":{"code":-32603,"data":{"acpxCode":"RATE_LIMIT"}}}'],
    ["acpxCode key=value", "prompt failed acpxCode=RATE_LIMIT"],
  ])("%s -> unknown", (_label, input) => {
    expect(parseAgentError(input).type).toBe("unknown");
  });
});

describe("S4b-5: structured provider signals still classify", () => {
  test.each([
    ["whole Anthropic envelope", '{"type":"error","error":{"type":"authentication_error","message":"x"}}', "auth"],
    [
      "embedded Anthropic envelope",
      'Internal error: API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"x"}}',
      "rate-limit",
    ],
    ["JSON-RPC detailCode", '{"error":{"code":-32603,"data":{"detailCode":"RATE_LIMIT"}}}', "rate-limit"],
    ["key=value status", "request failed statusCode=429", "rate-limit"],
    ["key=value errorCode", "request failed errorCode=AUTH_FAILED", "auth"],
    [
      "Claude selected-model text",
      "There's an issue with the selected model (x). Run --model to pick a different model.",
      "model-not-available",
    ],
    [
      "Claude selected-model text inside a JSON-RPC envelope",
      '{"error":{"code":-32603,"message":"There\'s an issue with the selected model (x). Run --model to pick one."}}',
      "model-not-available",
    ],
  ] as const)("%s", (_label, input, type) => {
    expect(parseAgentError(input).type).toBe(type);
  });
});
```

In the `buildAllowedEnv` test file, add:

```ts
  test("S4b-5: ACPX_* vars are no longer passed through", () => {
    const saved = process.env.ACPX_SESSION_DIR;
    process.env.ACPX_SESSION_DIR = "/tmp/x";
    try {
      expect(buildAllowedEnv()).not.toHaveProperty("ACPX_SESSION_DIR");
    } finally {
      if (saved === undefined) delete process.env.ACPX_SESSION_DIR;
      else process.env.ACPX_SESSION_DIR = saved;
    }
  });
```

Use the file's own env-isolation helper instead of the inline save and restore if it has one.

- [ ] **Step 2: Run to verify the new acpx cases fail**

Run: `bun test test/unit/agents/errors/parse-agent-error.test.ts <buildAllowedEnv test path> --timeout=30000`
Expected: the five "-> unknown" cases FAIL (they still classify) and the `ACPX_` test FAILS. The "still classify" cases PASS already. They are the guard for Step 3.

- [ ] **Step 3: Remove the acpx branches**

In `parse-agent-error.ts`:
- `parseAgentError`:
  - Delete the three bracketed lines (`const bracketed = extractBracketedCodes(stderr); ... if (fromBracketed) return fromBracketed;`).
  - Keep the key-value and flat-model lines.
  - Change comment "2." to "Vendors and agent launchers may wrap provider errors in a human-readable prefix, like:".
  - Change comment "3." to "3. Claude Code's flat-string model rejection (no machine-readable code)."
- The doc comment above `parseAgentError`: change the field list to `(type/status/statusCode/code/detailCode)`, delete the "bracketed code suffixes" bullet, and change "acpx wraps vendor errors" to "launchers wrap vendor errors".
- `classifyJsonPayload`: change the comment above `classifyJsonRpcModelError` to "Model-not-available carried in a JSON-RPC error envelope's message."
- `classifyJsonRpcModelError` doc: "Detect model-not-available from a JSON-RPC error envelope whose `error.message` carries Claude Code's model rejection text."
- `classifyModelErrorMessage`: delete the `Cannot apply --model` / `Cannot replay saved model` `if` and its comment. Change the doc comment to describe Pattern 2 only (Claude Code prompt rejection).
- `extractJsonCodeTokens`: delete `obj.acpxCode,`. In the doc comment, change "`error.data.acpxCode` (e.g. acpx RATE_LIMIT / QUOTA_EXCEEDED)" to "`error.data.detailCode` (e.g. RATE_LIMIT / QUOTA_EXCEEDED)".
- Delete `function extractBracketedCodes`.
- `extractKeyValueCodes`: change the second pattern to `/(?:detailCode|errorCode)\s*[:=]\s*([A-Z0-9_]+)/g`.
- The file header lines 1-25: change "set by the acp adapter when acpx's stop-reason-error response included" to "set by an adapter when the agent's error response included". Change the line-21 comment "Transport (acpx) already classified" to "The transport already classified".

In `src/agents/shared/env.ts`:
- Delete `"ACPX_",` from `ALLOWED_PREFIXES`.
- Change header line 6 `- SpawnAcpClient (src/agents/acp/spawn-client.ts)` to `- AcpAgentAdapter (src/agents/acp/adapter.ts) via buildAllowedEnv`.
- Before saving, check that the adapter really calls `buildAllowedEnv`: `grep -n buildAllowedEnv src/agents/acp/*.ts`. If it does not, delete that bullet instead.

- [ ] **Step 4: Run the tests**

Run: the Step 2 command.
Expected: PASS.

Run: `bun test test/unit/agents --timeout=30000`
Expected: PASS. `complete-exception-classifier` tests and failure-map tests depend on `parseAgentError`. A failure there whose input is an acpx shape gets its expectation updated to `unknown`, with the comment `// S4b-5: acpx-only shape`. A failure on any other input means a non-acpx path was removed, so stop and restore that path.

- [ ] **Step 5: Commit**

```bash
git add packages/nax/src/agents/errors/parse-agent-error.ts packages/nax/src/agents/shared/env.ts packages/nax/test/unit
git commit -m "refactor(nax): S4b-5 drop acpx-only error-classification branches and the ACPX_ env prefix"
```

---

### Task 5: Merge-conflict rectification discards the crash-leftover transcript (D5-d)

**Files:**
- Modify: `packages/nax/src/agents/acp/session.ts` (after `discard`, ~line 116), `src/agents/acp/index.ts`
- Modify: `packages/nax/src/execution/merge-conflict-rectify.ts` (lines 8-9, 21-130, 278-289)
- Test: `packages/nax/test/unit/agents/acp/session.test.ts`, `packages/nax/test/unit/execution/merge-conflict-rectify.test.ts`

**Interfaces:**
- Consumes:
  - `transcriptStoreFor(dir)` from `src/agents/acp/open-context.ts`.
  - `deriveNativeTranscriptDir({ featureName?, transcriptRoot? }): string | undefined` from `src/session/manager-deps.ts:46`.
  - `formatSessionName` from `src/session/naming.ts`.
  - `pipelineContextBase.runtime.outputDir: string` (`NaxRuntime`, `src/runtime/index.ts:155`).
- Produces:
  - `export async function discardAcpSessionLeftover(transcriptDir: string | undefined, name: string): Promise<void>` from `@/agents/acp`. It never rejects.
  - `_mergeRectifyDeps = { discardStaleSession: discardAcpSessionLeftover }`.
  - `closeStaleAcpSession` and `evictStaleSessions` are deleted.

- [ ] **Step 1: Write the failing tests**

In `test/unit/agents/acp/session.test.ts`, add (merge the imports into the existing import lines):

```ts
import { mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { discardAcpSessionLeftover } from "@/agents/acp";
import { transcriptStoreFor } from "@/agents/acp/open-context";

describe("discardAcpSessionLeftover (BUG-122 rectification, S4b-5)", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTempDir("acp-leftover-");
  });
  afterEach(() => cleanupTempDir(dir));

  test("deletes the named session's transcript document so the next open is fresh", async () => {
    const store = transcriptStoreFor(dir);
    await store.markTurn("nax-abc-feat-US-001-main", { turn: 1 } as never);
    expect(await store.load("nax-abc-feat-US-001-main")).not.toBeNull();
    await discardAcpSessionLeftover(dir, "nax-abc-feat-US-001-main");
    expect(await store.load("nax-abc-feat-US-001-main")).toBeNull();
  });

  test("leaves other sessions' documents alone", async () => {
    const store = transcriptStoreFor(dir);
    await store.markTurn("keep-me", { turn: 1 } as never);
    await discardAcpSessionLeftover(dir, "drop-me");
    expect(await store.load("keep-me")).not.toBeNull();
  });

  test("is a no-op when the directory cannot be derived or does not exist", async () => {
    await discardAcpSessionLeftover(undefined, "x");
    await discardAcpSessionLeftover(join(dir, "missing", "sessions"), "x");
    expect(existsSync(join(dir, "missing"))).toBe(false);
  });
});
```

`as never` stands in for the `TurnMarker` shape. Before writing, replace it with a real `TurnMarker` literal: read the type in `packages/nax-agent/src/native/session/transcript-types.ts`. The `check:test-as-unknown-as` / escape-hatch gates reject casts. The leftover-document fixture can also come from the existing `session.test.ts` crash-leftover tests, which already write one. Reuse their helper if present. In that case drop the unused `mkdirSync`/`writeFileSync`/`readdirSync` imports.

In `test/unit/execution/merge-conflict-rectify.test.ts`:
- Remove `closeStaleAcpSession` from the import.
- Delete the `describe("closeStaleAcpSession — bounded `acpx sessions close` (hang-path)", ...)` block and its header comment (~lines 261-315).
- In `describe("US-003 AC-7: rectification derives the worktree identity", ...)`:
  - Replace `savedTypedSpawn` / `stubAcpxSpawn` with a recorder.
  - Rewrite the second test.
  - In the other two tests, replace `stubAcpxSpawn();` with `stubDiscard();`.
  - In the header comment, change "(git, and the `acpx sessions close` eviction)" to "(git, and the stale-session discard)".

```ts
  let savedDiscard: typeof _mergeRectifyDeps.discardStaleSession;

  beforeEach(() => {
    savedGit = _worktreeManagerDeps.gitWithTimeout;
    savedDiscard = _mergeRectifyDeps.discardStaleSession;
  });

  afterEach(() => {
    _worktreeManagerDeps.gitWithTimeout = savedGit;
    _mergeRectifyDeps.discardStaleSession = savedDiscard;
  });

  /** Records each stale-session discard as [transcriptDir, sessionName]. */
  function stubDiscard(): Array<[string | undefined, string]> {
    const calls: Array<[string | undefined, string]> = [];
    _mergeRectifyDeps.discardStaleSession = async (dir, name) => {
      calls.push([dir, name]);
    };
    return calls;
  }
```

```ts
  test("AC-7: the stale-session discard names the composed worktree's session, under the run's transcript dir", async () => {
    stubGit();
    const discards = stubDiscard();
    const opts = makeOpts(FEATURE);

    await rectifyConflictedStory(opts);

    expect(discards).toHaveLength(1);
    const [dir, name] = discards[0] ?? [undefined, ""];
    const composedPath = join(WORKDIR, COMPOSED_TAIL);
    expect(name).toBe(formatSessionName({ workdir: composedPath, featureName: FEATURE, storyId: STORY_ID, role: "main" }));
    expect(name).not.toBe(
      formatSessionName({ workdir: join(WORKDIR, ".nax-wt", STORY_ID), featureName: FEATURE, storyId: STORY_ID, role: "main" }),
    );
    expect(dir).toBe(
      deriveNativeTranscriptDir({ featureName: FEATURE, transcriptRoot: opts.pipelineContextBase.runtime.outputDir }),
    );
  });

  test("a discard that throws does not fail rectification", async () => {
    stubGit();
    _mergeRectifyDeps.discardStaleSession = async () => {
      throw new Error("boom");
    };
    const result = await rectifyConflictedStory(makeOpts(FEATURE));
    // The PRD has no story, so rectification stops at the pipelineFailure exit, not at the discard.
    expect(result.pipelineFailure).toBe(true);
  });
```

Add the imports `import { formatSessionName } from "@/session/naming";` and `import { deriveNativeTranscriptDir } from "@/session/manager-deps";`. If `storyWorktreePath(WORKDIR, ...)` builds the path differently from `join(WORKDIR, COMPOSED_TAIL)`, build `composedPath` with `storyWorktreePath(WORKDIR, deriveStoryWorktreeId(FEATURE, STORY_ID))` from `@/worktree`, as production does.

- [ ] **Step 2: Run to verify they fail**

Run: `bun test test/unit/agents/acp/session.test.ts test/unit/execution/merge-conflict-rectify.test.ts --timeout=30000`
Expected: FAIL. `discardAcpSessionLeftover` is not exported, and `_mergeRectifyDeps.discardStaleSession` does not exist.

- [ ] **Step 3: Implement**

In `src/agents/acp/session.ts`, after `discard`:

```ts
/**
 * Deletes `name`'s crash-leftover transcript document under `transcriptDir`,
 * so the next open of that name starts fresh instead of resuming it (§6.1).
 * Merge-conflict rectification calls this for the rectified story's session
 * (BUG-122). Best-effort: a missing directory or document is a no-op and a
 * store error is logged, never thrown.
 */
export async function discardAcpSessionLeftover(transcriptDir: string | undefined, name: string): Promise<void> {
  if (transcriptDir === undefined) return;
  try {
    await discard(transcriptStoreFor(transcriptDir), name);
  } catch (err) {
    getSafeLogger()?.warn(STAGE, "Could not discard a stale ACP session transcript", {
      sessionName: name,
      error: errorText(err),
    });
  }
}
```

The outer `try` covers a store constructor that throws. `discard` already contains `delete` rejections.

In `src/agents/acp/index.ts`, change the session re-export to `export { _acpDeps, discardAcpSessionLeftover } from "./session";`.

In `src/execution/merge-conflict-rectify.ts`:
- Delete the `killProcessGroup` import (the `errorMessage` import stays if used elsewhere in the file) and the `typedSpawn` import.
- Delete `STALE_SESSION_CLOSE_TIMEOUT_MS`, `closeStaleAcpSession` and `evictStaleSessions` with their doc comments (lines 21-130).
- Add:

```ts
import { discardAcpSessionLeftover } from "../agents/acp";
import { deriveNativeTranscriptDir } from "../session/manager-deps";

/** Injectable deps for the stale-session discard (BUG-122). */
export const _mergeRectifyDeps = {
  discardStaleSession: discardAcpSessionLeftover,
};
```

Replace the BUG-122 block at ~lines 278-289 with:

```ts
    // @design: BUG-122: the failed run's session must not carry into the re-run.
    // The session name hashes the worktree path, so the re-run reuses it, and a
    // crash-leftover transcript under that name would be resumed at open. Discard
    // it so the session opens fresh. Best-effort: never fails the rectification.
    const { formatSessionName } = await import("../session/naming");
    const staleSessionName = formatSessionName({
      workdir: worktreePath,
      featureName: prd.feature,
      storyId,
      role: "main",
    });
    const transcriptDir = deriveNativeTranscriptDir({
      featureName: prd.feature,
      transcriptRoot: pipelineContextBase.runtime.outputDir,
    });
    await _mergeRectifyDeps.discardStaleSession(transcriptDir, staleSessionName).catch(() => {});
```

If `pipelineContextBase.runtime` is optional in the `Omit<PipelineContext, ...>` type (typecheck says so), use `pipelineContextBase.runtime?.outputDir`.

- [ ] **Step 4: Run the tests, then the cycle gate**

Run: `bun test test/unit/agents/acp/session.test.ts test/unit/execution/merge-conflict-rectify.test.ts --timeout=30000`
Expected: PASS.

Run: `bun run typecheck && bun run check:import-cycles && bun run check:package-boundaries`
Expected: clean. A new cycle through `execution -> agents/acp -> ... -> execution` means the static import must move inside the function as a dynamic `await import("../agents/acp")`, as `formatSessionName` already is. Keep `_mergeRectifyDeps.discardStaleSession` as a thin wrapper that does that import.

- [ ] **Step 5: Commit**

```bash
git add packages/nax/src/agents/acp packages/nax/src/execution/merge-conflict-rectify.ts packages/nax/test/unit/agents/acp/session.test.ts packages/nax/test/unit/execution/merge-conflict-rectify.test.ts
git commit -m "fix(nax): S4b-5 rectification discards the crash-leftover ACP transcript instead of spawning acpx"
```

---

### Task 6: User-facing strings and the acpx grep gate (D5-f)

**Files:**
- Modify: `src/config/schemas-protocol-gate.ts:67,86`, `src/config/unreferenced-agent-models.ts:83`, `src/precheck/checks-native-credentials.ts:59,74`, `src/cli/config-descriptions.ts:340`, `src/agents/acp/adapter.ts:3,148`
- Modify: the comment-only hits from `grep -rn -i acpx src` (Step 3)
- Test: `test/unit/config/agent-protocol-gate.test.ts`, `test/unit/config/unreferenced-agent-models.test.ts`, `test/unit/precheck/checks-native-credentials.test.ts`, `test/unit/prompts/sections/hermetic.test.ts`, `test/unit/agents/acp/adapter.test.ts`

**Interfaces:**
- Consumes: Tasks 2-5.
- Produces: `grep -rn -i acpx packages/nax/src` hits only `src/config/compat-shims.ts` (the three removed-feature messages), the Task 2 transport shim, and comments recording history.

- [ ] **Step 1: Update the asserting tests first**

Run: `grep -rn "acpx agent\|acpx'\|'acpx\|transport \"sdk\"\|transport \\\\\"sdk" test/unit/config test/unit/precheck test/unit/prompts test/unit/agents/acp`
Change each expectation that reads one of the strings below to its new form:

| Old | New |
|---|---|
| `Set agent.default to an acpx agent such as` | `Set agent.default to an ACP agent such as` |
| `is an acpx agent. Use "hybrid" to run both.` | `is an ACP agent. Use "hybrid" to run both.` |
| `Under agent.protocol "native" acpx agents cannot run` | `Under agent.protocol "native" ACP agents cannot run` |
| `to use an acpx agent.` | `to use an ACP agent.` |
| `it cannot run on agent.acp.transport "sdk"` | `so it cannot run as an ACP agent` |

`hermetic.test.ts` uses `"acpx"` as arbitrary sample data for `externalBoundaries`. Leave it. It is test data, not a claim about nax.

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test test/unit/config/agent-protocol-gate.test.ts test/unit/config/unreferenced-agent-models.test.ts test/unit/precheck/checks-native-credentials.test.ts test/unit/agents/acp/adapter.test.ts --timeout=30000`
Expected: FAIL on the changed strings.

- [ ] **Step 3: Change the strings, then sweep comments**

- Apply the table above in the five source sites.
- `src/agents/acp/adapter.ts:148` becomes `` `Agent "${this.name}" has no ACP launcher, so it cannot run as an ACP agent` ``. Its header line 3 becomes "§5.1). It drives the backend's S1".
- `config-descriptions.ts:340`: the example becomes `['claude', 'gh', 'redis']`.

Then run `grep -rn -i acpx src` and handle each hit:
- **Describes the current system** (for example "the acpx loop", "acpx agents", "spawns acpx", "as acpx does today"): reword it to describe the ACP transport or the behaviour itself.
- **Records history** (an issue's root cause, "moved out of agents/acp/ in S4b-1", "acpx returned a zero-output result; the sdk throws (D2-c)"): keep it, and phrase it in the past tense if it is not already.
- **`compat-shims.ts`** (the `finish.autoFlow` messages and the Task 2 shim): keep it.

The files with hits after Tasks 2-5 are expected to be: `agents/types.ts`, `agents/acp/{turn-loop,complete,stream-bridge,session,prompt-retry,entries,failure-map}.ts`, `session/{types,manager}.ts`, `precheck/checks-model-resolution.ts`, `finish/**`, `execution/{crash-signals,ensure-package-dirs,runner-execution}.ts`, `execution/lifecycle/*.ts`, `config/{schemas-execution,runtime-types,selectors}.ts`, `operations/*.ts`, `runtime/*.ts`, `review/finding-filters.ts`, `quality/runner.ts`, `agents/retry/*.ts`, `agents/manager-dispatch.ts`, `agents/interaction/turn-interactions.ts`, `agents/turn/abort.ts`, `agents/session-naming.ts`, `cli/features-resolve.ts`, `finish/review/{parse,prompt}.ts`.

- [ ] **Step 4: Run the tests and the gate**

Run: the Step 2 command.
Expected: PASS.

Run: `grep -rn -i acpx src | grep -vE "^src/config/compat-shims.ts:"`
Expected: each remaining line is a comment recording history. List them in the PR body under "acpx mentions kept (historical)". If a non-comment line remains outside `compat-shims.ts`, fix it.

Run: `bun run check:all`
Expected: green (biome may reflow edited comments; run `bun run lint:fix` then re-run).

- [ ] **Step 5: Commit**

```bash
git add -A packages/nax/src packages/nax/test
git commit -m "chore(nax): S4b-5 reword acpx in user-facing strings and comments"
```

---

### Task 7: Docs, agent context, rules and the spec

**Files:**
- Modify: `packages/nax/README.md:175,261,272,297`
- Modify: `docs/guides/agents.md:3,11,31-39,101-106`, `docs/guides/configuration.md:106,116` (lines 777-781 are the historical `finish.autoFlow` migration note: keep)
- Modify: `docs/architecture/agent-adapters.md:286,330-341,364`
- Modify: `.nax/mono/packages/nax/context.md:78,135` -> regenerate `packages/nax/{CLAUDE,AGENTS,GEMINI,codex}.md`
- Modify: `.nax/rules/retry-strategy.md:41` -> `nax rules export --agent=claude` regenerates `.claude/rules/retry-strategy.md`
- Modify: `docs/superpowers/specs/2026-10-07-s4b-nax-run-acp-cutover-design.md` (§4 folder note, §11 new items 15-17)
- Modify (outside the repo): `projects/nax/nax-agent-master-plan.md` S4b row

**Interfaces:** none (docs only).

- [ ] **Step 1: Install and transport wording**

Each spot gets the same message: every non-native agent runs over ACP through `@nathapp/nax-agent-acp`. What must be installed is that agent's ACP launcher (Claude: `@agentclientprotocol/claude-agent-acp`, on PATH or fetched with `npx` on first use, which the precheck warns about). `acpx` is no longer used. Read `packages/nax-agent-acp/src/client/registry.ts` for the exact launcher package of each agent before writing the table. Do not guess.

- `packages/nax/README.md`:
  - Line 272: the "Any ACP-compatible" row points to the ACP registry in nax-agent-acp's README instead of the acpx docs.
  - Line 297: replace the acpx credit line with "ACP support is powered by `@nathapp/nax-agent-acp` over the Agent Client Protocol (`@agentclientprotocol/sdk`)."
  - Lines 175 and 261: keep the meaning and drop acpx if it appears there.
- `docs/guides/agents.md`:
  - Front-matter description: "the native agent and ACP agents via @nathapp/nax-agent-acp".
  - Line 11: "spawned through each agent's ACP launcher by `@nathapp/nax-agent-acp` (Agent Client Protocol: JSON-RPC over stdio)".
  - Delete the "Known issue — `acpx` ≤ 0.3.1" note (line 35).
  - Line 31: point the "Any ACP-compatible agent" row to the nax-agent-acp registry.
  - Line 39: "an ACP agent".
  - Lines 101-106: the agent-internal retry row reads "ACP: the turn loop re-issues the prompt (`agent.acp.promptRetries`, only when the failed attempt produced no output)", matching spec §7.2.
  - Add a short "Upgrading from acpx" paragraph: remove `agent.acp.transport` (it now warns and is ignored), install the agent's ACP launcher, `acpx` can be uninstalled, and `ACPX_*` env vars are no longer passed to agents.
- `docs/guides/configuration.md`:
  - Line 106: `"acp"` (ACP agents via `@nathapp/nax-agent-acp`).
  - Line 116: "ACP only. Retries a prompt on a transient fault inside nax's ACP turn loop, only when the failed attempt produced no output; backoff `min(1000 * 2^n, 10000)` ms."
  - If the table has an `agent.acp.transport` row, delete it.
- `docs/architecture/agent-adapters.md`:
  - Line 286: the ACP row becomes `acp/` with the real file list. Read it from `ls src/agents/acp`.
  - Lines 330-341: describe the in-nax `promptRetries` loop from spec §7.2. Delete the "fires inside acpx" claims.
  - Delete line 364 (the acpx parser paragraph).

- [ ] **Step 2: Agent context and rules, then regenerate**

- `.nax/mono/packages/nax/context.md:78`: `` | `src/agents/acp/` | ACP adapter over `@nathapp/nax-agent-acp` (one of two transports; see ADR-027) | ``.
- Line 135: "ACP via `@nathapp/nax-agent-acp` for every named CLI" (keep the rest of the bullet).
- `.nax/rules/retry-strategy.md:41`: "- **ACP** — `agent.acp.promptRetries` re-issues the prompt inside nax's ACP turn loop, only when the failed attempt produced no output."

From the repo root:

```bash
bun packages/nax/bin/nax.ts generate
bun packages/nax/bin/nax.ts generate --all-packages
bun packages/nax/bin/nax.ts rules export --agent=claude
```

Expected: `packages/nax/{CLAUDE,AGENTS,GEMINI,codex}.md` and `.claude/rules/retry-strategy.md` change by exactly those lines. `cd packages/nax && bun run check:rules-drift` passes.

`.nax/rules/forbidden-patterns-source.md:57` and `testing-commands.md:35` mention acpx as one example of a spawned process. Reword "acpx" to "an agent process" in both, then re-run the rules export.

- [ ] **Step 3: Spec and master plan**

In the spec:
- §4: replace the folder note with "The folder was `agents/acp-sdk/` while both transports existed; S4b-5 renamed it to `agents/acp/` and dropped the `Sdk` infix from its symbols (NaxError codes `ACP_SDK_*` kept)."
- Append to §11:

```markdown
15. **`ACPX_*` environment variables are no longer passed to agent processes** (S4b-5, D5-e).
16. **`agent.acp.transport` is removed.** A config that still sets it loads with a warning and runs on the ACP SDK (S4b-5, D5-c).
17. **Merge-conflict rectification discards the rectified story's crash-leftover ACP transcript** instead of running `acpx sessions close`, so the re-run opens fresh (BUG-122 on the new transport, S4b-5, D5-d).
```

- Append to the §10 S4b-5 row: "B2 deviation: v0.83.5 shipped the sdk default with acpx present; S4b-5 releases as 0.83.6 (D5-h)."

In `projects/nax/nax-agent-master-plan.md` (outside the repo, `subrina-coder` workspace), prefix the S4b row with: "**S4b-4 MERGED #2383, v0.83.5 released (sdk default, acpx present: B2 deviation). S4b-5 PLAN `docs/superpowers/plans/2026-10-08-s4b-5-delete-acpx.md`.**" Update it again at PR and release.

- [ ] **Step 4: Commit**

```bash
git add packages/nax/README.md docs/guides docs/architecture .nax packages/nax/*.md .claude/rules docs/superpowers/specs/2026-10-07-s4b-nax-run-acp-cutover-design.md
git commit -m "docs(nax): S4b-5 ACP launcher replaces acpx in install, config and architecture docs"
```

---

### Task 8: Gates, whole-branch review, PR

**Files:** none beyond fixes the review asks for.

- [ ] **Step 1: Full local gates (from `packages/nax`)**

```bash
bun run typecheck
bun run check:all
bun run test
bun run test:coverage
cd ../.. && bun run typecheck && bun run check:all && cd packages/nax
```

Expected: all green. `test:coverage` is not part of `check:all`. It must pass on its own and must not lower the per-file baseline. Deleted files drop out of the baseline. A renamed file whose coverage moved needs `test:coverage:update` only when the value is unchanged.

- [ ] **Step 2: The spec's done-check**

Run (from the repo root): `grep -rn -i acpx packages/nax/src | grep -v "^packages/nax/src/config/compat-shims.ts:"`
Expected: only historical comments, the same list recorded in Task 6 Step 4.

Run: `grep -rn "agents/acp-sdk\|AcpSdk\|_acpSdkDeps\|agent.acp.transport" packages/nax/src packages/nax/test | grep -v "compat-shims\|loader-legacy-shim\|config-descriptions.test\|preflight.test"`
Expected: no output.

Run: `cd packages/nax && bun run build && grep -c "createSpawnAcpClient\|parseAcpxJsonLine\|sessions\", \"close" dist/nax.js`
Expected: `0`.

- [ ] **Step 3: Whole-branch review (one fresh reviewer, most capable model)**

Dispatch one read-only reviewer with: the spec, this plan, `git diff origin/main...HEAD`, and the five Review Focus items. The question to answer: did anything other than acpx plumbing change behaviour? Check especially `parseAgentError` (Task 4), the shim (Task 2) and rectification (Task 5). Fix rounds are capped at 2.

- [ ] **Step 4: Push and open the PR (approval required)**

Ask the maintainer before pushing. On approval:

```bash
git push -u origin feat/s4b-5-delete-acpx
gh pr create --title "feat(nax)!: S4b-5 delete the acpx transport, rename agents/acp-sdk to agents/acp" --body-file <body>
```

The body records:
- the D5 decisions;
- behaviour changes 15-17;
- the B2 deviation;
- the "acpx mentions kept (historical)" list;
- every deleted test file, each with its replacement or a reason it is not needed: plumbing (argv, parser, `sessions ensure`, which-probe, reasoning-effort `acpx set`) or transport comparison;
- "no billed run (D5-i)".

- [ ] **Step 5: CI and merge (approval required)**

Wait for CI on the PR: every job green. Merge only on maintainer approval. Record the merge commit.

---

### Task 9: Release nax 0.83.6 (approval at each gate)

- [ ] **Step 1: Release PR (approval required)**

From `packages/nax` on an up-to-date `main`: `bun run release patch` (bumps 0.83.5 -> 0.83.6, commits, pushes a branch, opens the release PR). Ask before running it.

- [ ] **Step 2: Tag (approval required)**

After the release PR merges: `git checkout main && git pull origin main && cd packages/nax && bun run release tag`. Watch the Release workflow to success.

- [ ] **Step 3: Verify the published package**

```bash
npm view @nathapp/nax@0.83.6 version gitHead
npm pack @nathapp/nax@0.83.6 --pack-destination "$TMPDIR/nax-0836" && tar -xzf "$TMPDIR"/nax-0836/nathapp-nax-0.83.6.tgz -C "$TMPDIR/nax-0836"
grep -c "createSpawnAcpClient\|parseAcpxJsonLine" "$TMPDIR/nax-0836/package/dist/nax.js"
```

Expected: version `0.83.6`, gitHead = the release merge commit, grep count `0`. Updating the global install is the maintainer's decision. Do not run it.

- [ ] **Step 4: Close out**

- Update the master-plan S4b row to "**S4b COMPLETE**". It should record the S4b-5 PR, the merge commit and the 0.83.6 release run.
- Update the memory notes `nax-s4b-acp-cutover-arc` and the MEMORY.md nax line.
- Delete the local branch `feat/s4b-5-delete-acpx` after confirming the content is on main.
