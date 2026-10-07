# S4b-3 ACP SDK transport parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the `sdk` transport (`packages/nax/src/agents/acp-sdk/`) to parity with acpx so S4b-4 can smoke and flip it: `complete()`, the full §7.1 failure table, `promptRetries`, the startup/teardown deadline options, effort, tool audit, the npx-only warning, the D2-b model refusal, and the parity and integration tests.

**Architecture:** Everything stays behind `agent.acp.transport: "sdk"`; the default stays `acpx`. `complete()` is a throwaway `AcpSdkSession` driven by the existing turn loop with one interaction and the no-op handler (B3). Failure classification keys on the backend's error codes in `failure-map.ts`. `promptRetries` is a new pure module used inside one loop iteration, on the same call bridge. Tool audit is a per-session recorder fed by the stream bridge and the ask port, flushed at close. One small change lands in `@nathapp/nax-agent-acp` (the model refusal lists the offered ids), plus an unbilled probe fixture.

**Tech Stack:** Bun 1.4 + TypeScript strict, `bun:test`, `@nathapp/nax-agent` 0.3.1, `@nathapp/nax-agent-acp` 0.3.1 (workspace), nax-agent-acp's fake ACP agent (subprocess) and `scriptedOpened` in-memory doubles.

**Spec:** `docs/superpowers/specs/2026-10-07-s4b-nax-run-acp-cutover-design.md` (slice S4b-3, §6.6, §6.7, §6.8, §7.1-§7.4, §9, §11). Predecessor plan: `docs/superpowers/plans/2026-10-07-s4b-2-acp-sdk-adapter.md` (decisions D2-a..D2-o).

## Global Constraints

- Governing rule (spec §1, user ruling 2026-10-07): **S4b replaces the acpx transport, not the logic inside nax.** No retry, swap, stale, cost-ledger or metrics policy changes.
- The default transport stays `"acpx"` (`DEFAULT_ACP_TRANSPORT`); S4b-4 flips it. No release in this slice.
- Adapters never import config (`check:adapter-no-config-import` scans `agents/acp-sdk/`): every value arrives on `OpenSessionOpts` / `CompleteOptions`.
- nax imports nax-agent-acp only through `@nathapp/nax-agent-acp/client`.
- Source files under 600 lines, test files under 800 (`check:file-sizes`); no baseline raised.
- Bun-native APIs; `setTimeout` only where the handle is cleared mid-flight (documented at the call site); no `Bun.sleep` in tests; no `mock.module()`; `_deps` seams for injection.
- Errors are `NaxError` with `stage`; logs carry no emojis.
- Gates every commit keeps green from `packages/nax`: `bun run typecheck`, `bun run check:all`, targeted tests; at the end also `bun run test` and `bun run test:coverage` (every new or changed `src/agents/acp-sdk/*.ts` file >= 80% lines and functions).
- Never run bare `bun test` (no path) and never `bun run nax`.
- Maintainer rulings 2026-10-07: **D2-b = strict + probe** (exact model match stays fail-closed; the refusal lists the offered ids; an unbilled probe of codex/opencode/pi runs before the flip). **D2-c = throw** (a run abort on `sendTurn` throws `SessionTurnError` `fail-aborted`; spec §7.1 row stands).
- S4b-0 Ruling T1-1: `promptRetries` follows acpx 0.19.4, not the spec's looser wording: retry only on JSON-RPC `-32603` / `-32700` (a rate limit is `-32603`), only when the failed attempt produced **no turn event of any kind**, backoff `min(1000 * 2^n, 10000)` ms, **no jitter**, never after output.

## Decisions (D3-a .. D3-m)

Final-reviewed 2026-10-07 by one read-only reviewer ("ready after fixes", 0 BLOCKER, 9 MAJOR, 11 MINOR); this revision is the single fix round.

| # | Decision |
|---|---|
| D3-a | **`complete()` reuses `createSession` + `runTurnLoop`** with `maxInteractions: 1` and `NO_OP_INTERACTION_HANDLER`, on a memory transcript store and no tool audit, then closes with `force: true`. A `timedOut` result becomes `NaxError("complete() timed out", "AGENT_TIMEOUT", { stage: "acp", timeoutMs })` (the code `complete-exception-classifier.ts` already maps to `fail-timeout`). **Only a watchdog cancel** (`adapterFailure.outcome === "fail-stale"`) becomes `CompleteResult{ cancelled: true }` with the burned tokens priced and no `adapterFailure`, as acpx (`fail-stale-watchdog.test.ts` AC9). A run abort (`fail-aborted`) is rethrown: returning it as cancelled would make `manager.ts:262-278` synthesize a retriable `fail-stale` and retry during shutdown, against D2-c (acpx never observed `options.signal` in `complete()`). Any other `SessionTurnError` is rethrown pre-classified. A failure while opening the throwaway session is classified through the same `failure-map` and thrown as `SessionFailureError(message, adapterFailure)` (`agents/types.ts:508`), the abort cause taken from the run signal. Blank output throws `CompleteError("complete() returned empty output")`, as acpx. acpx's `{"type":"result","result":...}` unwrap is acpx envelope plumbing and is not carried. |
| D3-b | **The classifier branch takes a pre-classified failure** (spec §6.6 item 5): `classifyCompleteException` returns `err.adapterFailure` as is for a `SessionTurnError` or `SessionFailureError` that carries one. No new error class. |
| D3-c | **acpx degraded auth / rate-limit / model-not-available into a returned `CompleteResult` with `adapterFailure`; the sdk transport throws** with the same pre-classified failure (spec §6.6 "Other failures are thrown"). `dispatchCompleteHop` reads either; listed as §11 item 10. |
| D3-d | **Categories per row.** `availability`: `fail-auth`, `fail-rate-limit`, `fail-aborted`, `fail-stale`, and the session-error rows (`BACKEND_UNAVAILABLE`, `TURN_FAILED`, `CLOSED`, `NOT_FOUND` after recovery), matching the `availability/fail-adapter-error` that `session-run-hop.ts` synthesizes for acpx today. `quality`: `CAPABILITY_UNSUPPORTED` (acpx's model-not-available was `quality`), the `ACP_STOP_*` rows and `fail-unknown` (as `complete-exception-classifier.ts`). |
| D3-e | **A plain `Error` (no NaxError code) is `fail-unknown`**, per the §7.1 "anything else" row. S4b-2's fallback was `fail-adapter-error`; the existing turn-loop test that pins it is updated. A `NOT_FOUND` that recovery could not fix maps to the session-error row (`fail-adapter-error`, availability). |
| D3-f | **The mid-turn "session not found" gap (D2-d) closes on the nax side.** The backend reports a prompt-time not-found as `AGENT_SESSION_TURN_FAILED` with `context.rpcCode`. `isSessionGone(err)` is true for `AGENT_SESSION_NOT_FOUND`, or `TURN_FAILED` with `rpcCode === -32002` or a message matching `/session not found\|no conversation found/i` (the backend's own restore patterns). nax-agent-acp is not changed, so its other consumers see no new code. |
| D3-g | **`promptRetries` on sessions stays as acpx has it.** `SessionManager` never fills `OpenSessionOpts.promptRetries` (only `AgentManager.completeAs` resolves it, for `complete()`), so acpx sessions never passed `--prompt-retries`. The turn loop honours `session.opts.promptRetries` when set; in production it is unset for sessions (0) and set for `complete()`. Wiring it for sessions would be a logic change and is out of scope (listed in §11 item 11). |
| D3-h | **Retries stay inside one call.** A retried attempt reuses the iteration's controller, slot and call bridge (one `call_started` / `call_ended`, as acpx retried inside its own process), adds the failed attempt's spend, is not counted as a turn, and waits through `cancellableDelay` on the iteration signal, so an abort during the backoff classifies like any other abort. |
| D3-i | **Deadlines.** `initializeTimeoutMs = trackedSpawnStartupDeadlineMs ?? 30_000` and `cancelGraceMs = trackedSpawnDeadlineMs ?? 10_000` (the schema defaults, restated because the adapter cannot read config), each clamped to the backend's schema maxima (3_600_000 and 600_000), since nax's schema has no upper bound and an over-max value would fail the open. |
| D3-j | **Tool audit recorder** (`acp-sdk/tool-audit.ts`): pairs `tool_call` / `tool_result` by ACP call id; an ask-port deny between them marks the pending call `denied` with the request's reason, so a denied call is one row, not two. A deny with no matching pending call writes a row at once (`input: {}`). Calls still pending at flush are written with outcome `error` and `resultBytes: 0`. `toolCallId` is the ACP call id. With no `opts.toolAudit` the recorder is a no-op. |
| D3-k | **npx-only warning is raised by the run's install check, for the configured agent only** (spec §6.8). `registry.ts` and `cli/agents.ts` call `isInstalled()` on every adapter, so a warning inside `isInstalled()` would fire for unused agents on every run. Instead `AgentAdapter` gains an optional `launchNote?(): string \| undefined`; `AcpSdkAgentAdapter` returns a note when `_acpSdkDeps.launchCandidateKind` (which replaces `isAgentLaunchable`) is `"npx"`, and `checkAgentInstalled` (`execution/lifecycle/run-initialization.ts:145`) logs it as a warning after the agent is found installed. `isInstalled()` stays silent and returns `kind !== undefined`. |
| D3-l | **Open-phase failures on sessions stay unclassified, as acpx's.** `session-run-hop.ts:92` calls `sessionManager.openSession` outside its `try`, so a classified error there would change nothing today; wiring open failures into the retry and swap policy is a logic change, deferred (spec §11 item 12). `complete()` classifies its open failures (D3-a) because spec §6.6 item 5 requires a pre-classified failure. |
| D3-m | **`complete()` session-error rows are `availability`** (shared `failure-map`), where acpx's `complete()` classified a crash as `quality/fail-adapter-error`. Recorded as spec §11 item 13. |

## Review Focus

1. **A retry after any turn event.** A failed prompt that emitted only thinking, or only usage, must NOT be resent (T1-1: any update counts). Expect the error to propagate after one attempt. Test: Task 5 "a thinking-only attempt is not retried".
2. **Abort during the retry backoff.** A run abort or watchdog cancel while the loop waits between attempts must end the turn as `fail-aborted` / `fail-stale`, not start another attempt. Test: Task 5 "an abort during the backoff ends the turn, no resend".
3. **A denied tool call recorded twice.** `tool_call`, then the ask port's deny, then the refusal `tool_result` must yield one `denied` row with the reason. Tests: Task 7 "a denied call is one denied row" (recorder) and "a call the profile refuses is one denied row, end to end through the fake agent" (real wiring).
4. **`complete()` timing out with the agent still running.** Expect `AGENT_TIMEOUT`, the session force-closed and no agent process left. Test: Task 8 "a hung complete() times out and leaves no agent process". (Related, also in Task 8: a run abort during `complete()` is thrown `fail-aborted`, never returned as a cancelled result that the manager would retry as `fail-stale`.)
5. **A session-gone error that is also a retryable `-32603`.** It must be recovered by re-opening, not resent on the dead session. Test: Task 5 "a session-gone -32603 is recovered, not retried".

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `packages/nax-agent-acp/src/client/errors.ts` | modify | `capabilityUnsupported` takes optional extra context |
| `packages/nax-agent-acp/src/client/open.ts` | modify | the model refusal lists the offered ids (D2-b) |
| `packages/nax-agent-acp/test/unit/client/open.test.ts` | modify | offered-ids test |
| `packages/nax-agent-acp/CHANGELOG.md` | modify | `[Unreleased]` entry |
| `packages/nax-agent-acp/test/node/fixtures/model-probe.mjs` | create | unbilled model probe (D2-b) |
| `packages/nax/src/agents/acp-sdk/failure-map.ts` | modify | §7.1 code rows, `isSessionGone` |
| `packages/nax/src/agents/acp-sdk/prompt-retry.ts` | create | T1-1 retry predicate and backoff |
| `packages/nax/src/agents/acp-sdk/stream-bridge.ts` | modify | `anyEvent()`, audit feed |
| `packages/nax/src/agents/acp-sdk/turn-loop.ts` | modify | session-gone recovery, retries |
| `packages/nax/src/agents/acp-sdk/open-context.ts` | modify | effort, deadline options, default constants |
| `packages/nax/src/agents/acp-sdk/tool-audit.ts` | create | the audit recorder (D3-j) |
| `packages/nax/src/agents/acp-sdk/ask-port.ts` | modify | denied row |
| `packages/nax/src/agents/acp-sdk/session.ts` | modify | recorder, flush on close, `delay` + `launchCandidateKind` seams |
| `packages/nax/src/agents/acp-sdk/complete.ts` | create | one-shot `complete()` (D3-a) |
| `packages/nax/src/agents/acp-sdk/adapter.ts` | modify | `complete()`, npx warning |
| `packages/nax/src/agents/complete-exception-classifier.ts` | modify | pre-classified branch (D3-b) |
| `packages/nax/src/agents/types.ts` | modify | optional `AgentAdapter.launchNote?` (D3-k) |
| `packages/nax/src/execution/lifecycle/run-initialization.ts` | modify | warns the configured agent's launch note (D3-k) |
| `packages/nax/src/cli/config-descriptions.ts` | modify | transport description no longer says "incomplete" |
| `packages/nax/src/config/schemas-infra.ts` | modify | transport comment no longer says "incomplete" |
| `packages/nax/test/unit/agents/acp-sdk/*.test.ts` | create/modify | unit and parity tests |
| `packages/nax/test/integration/agents/fail-stale-watchdog-sdk.test.ts` | create | watchdog AC9/AC7 on `sdk` |
| `packages/nax/test/integration/cli/cli-core-agents-sdk.test.ts` | create | `nax agents` on `sdk` |
| `docs/superpowers/specs/2026-10-07-s4b-nax-run-acp-cutover-design.md` | modify | §6.7 probe result, §7.1, §7.2, §11 items 9-11 |

---

### Task 1: The model refusal lists the offered ids (nax-agent-acp, D2-b)

**Files:**
- Modify: `packages/nax-agent-acp/src/client/errors.ts:44-50`
- Modify: `packages/nax-agent-acp/src/client/open.ts:250-261`
- Modify: `packages/nax-agent-acp/test/unit/client/open.test.ts` (after the "capability refusals name the capability" test, ~line 170)
- Modify: `packages/nax-agent-acp/CHANGELOG.md`

**Interfaces:**
- Produces: `capabilityUnsupported(capability: string, reason: string, details?: Readonly<Record<string, unknown>>): AgentSessionError`. A model refusal's `context` is `{ capability: "model", offered: string[] }` and its message ends `; offered: <ids>`. Task 2's probe reads `context.offered`.

- [ ] **Step 1: Write the failing test**

Add to the `describe` that holds "capability refusals name the capability":

```ts
  test("a model refusal lists the model ids the agent offers (D2-b)", async () => {
    const err = sessionError(await rejection((await openWith(CLAUDE_SCRIPT, { model: "gpt-9" })).opened));
    expect(err.context).toMatchObject({ capability: "model", offered: ["default", "sonnet"] });
    expect(err.message).toContain('"gpt-9"');
    expect(err.message).toContain("offered: default, sonnet");
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/nax-agent-acp && bun test test/unit/client/open.test.ts --timeout=30000`
Expected: FAIL, `offered` missing from `context`.

- [ ] **Step 3: Implement**

In `errors.ts`:

```ts
export function capabilityUnsupported(
  capability: string,
  reason: string,
  details: Readonly<Record<string, unknown>> = {},
): AgentSessionError {
  return new AgentSessionError(
    `The ACP agent cannot meet the "${capability}" requirement: ${reason}`,
    "AGENT_SESSION_CAPABILITY_UNSUPPORTED",
    { ...details, capability },
  );
}
```

In `open.ts`, import `selectValues` from `#src/client/capabilities` (add it to the existing import list) and `cleanLabel` from `#src/client/text` (it strips control and invisible characters, scrubs the session's secrets and caps the length, as every other agent-text path does; a raw control-character regex would also trip biome's `noControlCharactersInRegex`). Replace `applyModel`:

```ts
/** At most this many offered ids, each cleaned and capped, go into a model refusal (agent-supplied text). */
const MAX_OFFERED_MODELS = 50;
const MAX_MODEL_ID_CHARS = 100;

function offeredModels(offered: readonly SessionConfigOption[], secrets: readonly string[]): string[] {
  return offered
    .filter((option) => option.category === "model")
    .flatMap((option) => selectValues(option))
    .slice(0, MAX_OFFERED_MODELS)
    .map((id) => cleanLabel(id, secrets, MAX_MODEL_ID_CHARS) ?? "")
    .filter((id) => id !== "");
}

async function applyModel(
  o: Opening,
  sessionId: string,
  offered: readonly SessionConfigOption[],
): Promise<readonly SessionConfigOption[]> {
  const model = o.options.model;
  if (model === undefined) return offered;
  const configId = modelOptionId(offered, model);
  if (configId === undefined) {
    const ids = offeredModels(offered, o.options.secrets);
    throw capabilityUnsupported(
      "model",
      `the agent offers no model option "${model}"; offered: ${ids.length === 0 ? "(none)" : ids.join(", ")}`,
      { offered: ids },
    );
  }
  const set = await step(o, "session/set_config_option", o.link.setConfigOption({ sessionId, configId, value: model }));
  return set.configOptions ?? offered;
}
```

Add at the top of `CHANGELOG.md`, above `## [0.3.1]`:

```md
## [Unreleased]

### Changed

- A model the agent does not offer verbatim still fails the open with `AGENT_SESSION_CAPABILITY_UNSUPPORTED`; the error now lists the model ids the agent does offer (message and `context.offered`, at most 50, cleaned like other agent text).
```

`o.options` is the `ResolvedAcpOptions` the opening carries (`options.ts:67` declares `secrets`); if `Opening` names it differently, use the field `open.ts` already passes to `agentTextExcerpt` / `openRequestError` for the same purpose.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/nax-agent-acp && bun test test/unit/client/open.test.ts --timeout=30000 && bun run check:all && bun run check:api && bun run typecheck`
Expected: PASS; `check:api` reports no snapshot change (`capabilityUnsupported` is not on `./client`). If it does report one, run `bun run api:update` and include the snapshot in the commit.

- [ ] **Step 5: Commit**

```bash
git add packages/nax-agent-acp/src/client/errors.ts packages/nax-agent-acp/src/client/open.ts packages/nax-agent-acp/test/unit/client/open.test.ts packages/nax-agent-acp/CHANGELOG.md
git commit -m "feat(nax-agent-acp): model refusal lists the offered model ids (S4b-3 D2-b)"
```

---

### Task 2: Unbilled model probe fixture (D2-b)

**Files:**
- Create: `packages/nax-agent-acp/test/node/fixtures/model-probe.mjs`

**Interfaces:**
- Consumes: Task 1's `context.offered` on a model refusal.
- Produces: a maintainer-run script. Task 12 runs it and records the result.

- [ ] **Step 1: Write the script**

It opens each named agent with a model id no agent offers, so the open fails at the model step after `initialize` and `session/new`, before any prompt. Nothing is billed.

```js
/**
 * S4b-3 D2-b: which model ids each installed ACP agent offers, compared with the
 * ids nax is configured to send. Opens a session with a model id no agent offers,
 * so the open stops at the model step (after initialize + session/new) and the
 * refusal lists the offered ids. No prompt is sent; nothing is billed.
 *
 * Usage (from packages/nax-agent-acp):
 *   bun test/node/fixtures/model-probe.mjs codex=gpt-6-luna,gpt-6-sol opencode=minimax/MiniMax-M3
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, createMemoryTranscriptStore } from "@nathapp/nax-agent";
import { acpBackend, launchCandidateKind } from "@nathapp/nax-agent-acp/client";

const AGENTS = new Set(["claude", "codex", "gemini", "opencode", "pi"]);
const PROBE_MODEL = "nax-model-probe-unknown";

async function offeredIds(agent) {
  const workdir = mkdtempSync(join(tmpdir(), `acp-model-probe-${agent}-`));
  try {
    const session = await createAgentSession({
      backend: acpBackend({ agent, allowUnsandboxed: true, initializeTimeoutMs: 120_000, model: PROBE_MODEL }),
      profile: "full",
      workdir,
      transcriptStore: createMemoryTranscriptStore(),
    });
    await session.close();
    return { error: "the probe model was accepted; the agent has no exact-match model option" };
  } catch (error) {
    if (error?.code === "AGENT_SESSION_CAPABILITY_UNSUPPORTED" && Array.isArray(error?.context?.offered)) {
      return { offered: error.context.offered };
    }
    return { error: `${error?.code ?? "error"} ${error?.message ?? String(error)}` };
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}

for (const arg of process.argv.slice(2)) {
  const [agent, list = ""] = arg.split("=");
  const wanted = list.split(",").filter((id) => id !== "");
  if (!AGENTS.has(agent)) {
    console.log(`${agent}: unknown agent`);
    continue;
  }
  // The backend's own resolution, npx fallback included (an npx-only launcher is the likely case for codex/pi).
  const kind = launchCandidateKind(agent);
  if (kind === undefined) {
    console.log(`${agent}: no launch candidate (not installed, and no npx)`);
    continue;
  }
  if (kind === "npx") console.log(`${agent}: launching through npx (first run downloads the launcher)`);
  const probe = await offeredIds(agent);
  if (probe.error !== undefined) {
    console.log(`${agent}: ${probe.error}`);
    continue;
  }
  console.log(`${agent}: offers ${JSON.stringify(probe.offered)}`);
  for (const id of wanted) console.log(`  ${probe.offered.includes(id) ? "[OK]  " : "[FAIL]"} ${id}`);
}
console.log("model probe done");
```

Note for the runner: nax strips the effort suffix before the backend sees the model (`parseModelSpec`), so pass bare ids (`gpt-6-luna`, not `gpt-6-luna[medium]`).

- [ ] **Step 2: Syntax check**

Run: `cd packages/nax-agent-acp && node --check test/node/fixtures/model-probe.mjs`
Expected: no output, exit 0. Do not run the probe here; Task 12 runs it.

- [ ] **Step 3: Commit**

```bash
git add packages/nax-agent-acp/test/node/fixtures/model-probe.mjs
git commit -m "test(nax-agent-acp): unbilled model probe fixture (S4b-3 D2-b)"
```

---

### Task 3: failure-map: the §7.1 code rows and `isSessionGone`

**Files:**
- Modify: `packages/nax/src/agents/acp-sdk/failure-map.ts`
- Modify: `packages/nax/test/unit/agents/acp-sdk/failure-map.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `classifyTurnFailure(err: unknown, cause: unknown): TurnFailure` (same signature; code rows added).
  - `isSessionGone(err: unknown): boolean` (Tasks 4, 5).
  - `codeOf(err: unknown): string | undefined`, `contextOf(err: unknown): Readonly<Record<string, unknown>>` (Task 5).
  - `TurnFailure` unchanged.

- [ ] **Step 1: Write the failing tests**

Append to `failure-map.test.ts` (imports: add `isSessionGone` from `@/agents/acp-sdk/failure-map`, `AgentSessionError` and `NaxError` from `@nathapp/nax-agent`):

```ts
describe("classifyTurnFailure: the §7.1 code rows (S4b-3)", () => {
  const rows: Array<[string, Error, string, "availability" | "quality", boolean]> = [
    ["auth", new AgentSessionError("login", "AGENT_SESSION_AUTH_REQUIRED"), "fail-auth", "availability", false],
    ["rate limit", new AgentSessionError("slow", "AGENT_SESSION_RATE_LIMITED"), "fail-rate-limit", "availability", true],
    [
      "model not offered",
      new AgentSessionError("m", "AGENT_SESSION_CAPABILITY_UNSUPPORTED", { capability: "model" }),
      "fail-adapter-error",
      "quality",
      false,
    ],
    [
      "profile on codex",
      new AgentSessionError("p", "AGENT_SESSION_CAPABILITY_UNSUPPORTED", { capability: "profile" }),
      "fail-adapter-error",
      "quality",
      false,
    ],
    ["backend gone", new AgentSessionError("x", "AGENT_SESSION_BACKEND_UNAVAILABLE"), "fail-adapter-error", "availability", false],
    ["agent cancelled", new NaxError("c", "ACP_STOP_CANCELLED"), "fail-adapter-error", "quality", false],
    ["max tokens", new NaxError("t", "ACP_STOP_MAX_TOKENS"), "fail-incomplete", "quality", false],
    ["max turn requests", new NaxError("t", "ACP_STOP_MAX_TURN_REQUESTS"), "fail-incomplete", "quality", false],
    ["refusal", new NaxError("r", "ACP_STOP_REFUSAL"), "fail-quality", "quality", false],
    ["turn failed", new NaxError("f", "AGENT_SESSION_TURN_FAILED", { rpcCode: -32603 }), "fail-adapter-error", "availability", false],
    ["closed after reconnect", new AgentSessionError("c", "AGENT_SESSION_CLOSED"), "fail-adapter-error", "availability", false],
    ["not found after recovery", new AgentSessionError("n", "AGENT_SESSION_NOT_FOUND"), "fail-adapter-error", "availability", false],
    ["unknown code", new NaxError("u", "SOMETHING_ELSE"), "fail-unknown", "quality", false],
    ["plain Error (D3-e)", new Error("boom"), "fail-unknown", "quality", false],
  ];

  test.each(rows)("%s", (_name, err, outcome, category, retryable) => {
    const failure = classifyTurnFailure(err, undefined);
    expect(failure.adapterFailure).toMatchObject({ outcome, category, retriable: retryable });
    expect(failure).toMatchObject({ cancelled: false, retryable });
  });

  test("a rate limit carries retryAfterSeconds when the backend gave one", () => {
    const err = new AgentSessionError("slow", "AGENT_SESSION_RATE_LIMITED", { retryAfterSeconds: 42 });
    expect(classifyTurnFailure(err, undefined).adapterFailure.retryAfterSeconds).toBe(42);
  });

  test("a rate limit without one has no retryAfterSeconds", () => {
    const err = new AgentSessionError("slow", "AGENT_SESSION_RATE_LIMITED");
    expect("retryAfterSeconds" in classifyTurnFailure(err, undefined).adapterFailure).toBe(false);
  });

  test("an abort cause still wins over the error's code", () => {
    const err = new AgentSessionError("login", "AGENT_SESSION_AUTH_REQUIRED");
    expect(classifyTurnFailure(err, new RunAborted()).adapterFailure.outcome).toBe("fail-aborted");
  });
});

describe("isSessionGone (D3-f)", () => {
  test.each([
    ["NOT_FOUND", new AgentSessionError("gone", "AGENT_SESSION_NOT_FOUND"), true],
    ["TURN_FAILED -32002", new NaxError("x", "AGENT_SESSION_TURN_FAILED", { rpcCode: -32002 }), true],
    ["TURN_FAILED text", new NaxError("The ACP prompt failed: Session not found", "AGENT_SESSION_TURN_FAILED", { rpcCode: -32603 }), true],
    ["TURN_FAILED no conversation", new NaxError("No conversation found with id", "AGENT_SESSION_TURN_FAILED", {}), true],
    ["TURN_FAILED other", new NaxError("The ACP prompt failed: boom", "AGENT_SESSION_TURN_FAILED", { rpcCode: -32603 }), false],
    ["CLOSED", new AgentSessionError("closed", "AGENT_SESSION_CLOSED"), false],
    ["plain Error", new Error("session not found"), false],
  ])("%s -> %p", (_name, err, gone) => {
    expect(isSessionGone(err)).toBe(gone);
  });
});
```

Change the existing test "no abort: fail-adapter-error carrying the error's message, as acpx today (S4b-3 adds the code rows)" to:

```ts
  test("no abort and no code: fail-unknown carrying the error's message (D3-e)", () => {
    const failure = classifyTurnFailure(new Error("agent exploded"), undefined);
    expect(failure).toMatchObject({ message: "agent exploded", cancelled: false, retryable: false });
    expect(failure.adapterFailure).toMatchObject({ outcome: "fail-unknown", category: "quality" });
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd packages/nax && bun test test/unit/agents/acp-sdk/failure-map.test.ts --timeout=30000`
Expected: FAIL (rows classify as `fail-adapter-error`; `isSessionGone` not exported).

- [ ] **Step 3: Implement**

Replace the header comment's S4b-2 paragraph and `failure()` / `classifyTurnFailure` in `failure-map.ts` (keep the three marker classes, `TurnFailure`, `capped`, `turnFailureError` as they are):

```ts
/**
 * Backend failure -> SessionTurnError (S4b spec §7.1). The cancel cause is set
 * on the abort reason by whoever aborts, and is never inferred from a stop
 * reason. Every abort uses a fresh reason object, because the backend attaches
 * the failed prompt's spend to the reason it throws (attachTurnSpend keys on it).
 *
 * Without an abort cause the row is keyed by the backend's error code (D3-d:
 * session errors are "availability", as session-run-hop.ts synthesizes for an
 * acpx SessionTurnError; capability, stop-reason and unknown rows are "quality").
 * A deadline expiry is not a failure: the loop returns TurnResult{ timedOut: true }.
 */
import type { AdapterFailure } from "@nathapp/nax-agent";
import { NaxError } from "@/errors";

/** The backend's restore-time not-found patterns (nax-agent-acp errors.ts), applied to a prompt (D3-f). */
const SESSION_NOT_FOUND_TEXT = /session not found|no conversation found/i;
const RESOURCE_NOT_FOUND_RPC_CODE = -32002;

interface Row {
  readonly outcome: AdapterFailure["outcome"];
  readonly category: AdapterFailure["category"];
  readonly retryable: boolean;
}

const SESSION_ERROR: Row = { outcome: "fail-adapter-error", category: "availability", retryable: false };

const ROWS: Readonly<Record<string, Row>> = {
  AGENT_SESSION_AUTH_REQUIRED: { outcome: "fail-auth", category: "availability", retryable: false },
  AGENT_SESSION_RATE_LIMITED: { outcome: "fail-rate-limit", category: "availability", retryable: true },
  AGENT_SESSION_CAPABILITY_UNSUPPORTED: { outcome: "fail-adapter-error", category: "quality", retryable: false },
  AGENT_SESSION_BACKEND_UNAVAILABLE: SESSION_ERROR,
  AGENT_SESSION_TURN_FAILED: SESSION_ERROR,
  AGENT_SESSION_CLOSED: SESSION_ERROR,
  AGENT_SESSION_NOT_FOUND: SESSION_ERROR,
  ACP_STOP_CANCELLED: { outcome: "fail-adapter-error", category: "quality", retryable: false },
  ACP_STOP_MAX_TOKENS: { outcome: "fail-incomplete", category: "quality", retryable: false },
  ACP_STOP_MAX_TURN_REQUESTS: { outcome: "fail-incomplete", category: "quality", retryable: false },
  ACP_STOP_REFUSAL: { outcome: "fail-quality", category: "quality", retryable: false },
};

const UNKNOWN: Row = { outcome: "fail-unknown", category: "quality", retryable: false };

export function codeOf(err: unknown): string | undefined {
  return err instanceof NaxError ? err.code : undefined;
}

export function contextOf(err: unknown): Readonly<Record<string, unknown>> {
  return err instanceof NaxError && err.context !== undefined ? err.context : {};
}

/** The agent no longer knows the session: recover by re-opening fresh (§6.2 step 3.5, D3-f). */
export function isSessionGone(err: unknown): boolean {
  const code = codeOf(err);
  if (code === "AGENT_SESSION_NOT_FOUND") return true;
  if (code !== "AGENT_SESSION_TURN_FAILED" || !(err instanceof Error)) return false;
  return contextOf(err).rpcCode === RESOURCE_NOT_FOUND_RPC_CODE || SESSION_NOT_FOUND_TEXT.test(err.message);
}

function failure(
  row: Row,
  message: string,
  flags: { readonly cancelled: boolean; readonly reason?: string; readonly retryAfterSeconds?: number },
): TurnFailure {
  return {
    message,
    cancelled: flags.cancelled,
    retryable: row.retryable,
    adapterFailure: {
      category: row.category,
      outcome: row.outcome,
      retriable: row.retryable,
      message,
      ...(flags.reason === undefined ? {} : { reason: flags.reason }),
      ...(flags.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: flags.retryAfterSeconds }),
    },
  };
}

function retryAfterOf(err: unknown): number | undefined {
  const value = contextOf(err).retryAfterSeconds;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** `cause` is the iteration signal's reason when it was aborted, else undefined. */
export function classifyTurnFailure(err: unknown, cause: unknown): TurnFailure {
  if (cause instanceof WatchdogCancel) {
    return failure({ outcome: "fail-stale", category: "availability", retryable: true }, cause.message, {
      cancelled: true,
      reason: "idle-watchdog",
    });
  }
  if (cause !== undefined) {
    // A run abort, the session closing, or an abort nax did not label: never retried (§7.1, D2-c).
    return failure({ outcome: "fail-aborted", category: "availability", retryable: false }, "The turn was aborted", {
      cancelled: true,
    });
  }
  const code = codeOf(err);
  const row = (code !== undefined && Object.hasOwn(ROWS, code) ? ROWS[code] : undefined) ?? UNKNOWN;
  const message = capped(err instanceof Error ? err.message : String(err));
  const retryAfterSeconds = row.outcome === "fail-rate-limit" ? retryAfterOf(err) : undefined;
  return failure(row, message, { cancelled: false, ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }) });
}
```

Keep the existing imports `RateCard`, `SessionTurnError`, `failedSpendFields`, `Spend`. The old `failure(outcome, message, flags)` helper is replaced by the one above.

- [ ] **Step 4: Update the turn-loop test that pinned the old fallback**

In `test/unit/agents/acp-sdk/turn-loop.test.ts`, test "any other failure throws SessionTurnError fail-adapter-error with the summed spend": rename to "any other failure throws SessionTurnError with the summed spend (fail-unknown for a plain Error, D3-e)" and change `expect(err.adapterFailure?.outcome).toBe("fail-adapter-error");` to `toBe("fail-unknown")`.

- [ ] **Step 5: Run the tests**

Run: `cd packages/nax && bun test test/unit/agents/acp-sdk/failure-map.test.ts test/unit/agents/acp-sdk/turn-loop.test.ts --timeout=30000 && bun run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/nax/src/agents/acp-sdk/failure-map.ts packages/nax/test/unit/agents/acp-sdk/failure-map.test.ts packages/nax/test/unit/agents/acp-sdk/turn-loop.test.ts
git commit -m "feat(nax): sdk transport classifies backend error codes per spec §7.1 (S4b-3)"
```

---

### Task 4: The turn loop recovers a prompt-time "session not found" (D3-f)

**Files:**
- Modify: `packages/nax/src/agents/acp-sdk/turn-loop.ts:74-76, 110-128`
- Modify: `packages/nax/test/unit/agents/acp-sdk/turn-loop.test.ts`

**Interfaces:**
- Consumes: `isSessionGone` (Task 3).
- Produces: nothing new for later tasks.

- [ ] **Step 1: Write the failing test**

Add to `describe("runTurnLoop: failures")` (import `NaxError` from `@nathapp/nax-agent`):

```ts
  test("a prompt-time not-found (TURN_FAILED, rpcCode -32002) re-opens fresh once (D3-f, acpx exit code 4)", async () => {
    const gone = new NaxError("The ACP prompt failed: Resource not found", "AGENT_SESSION_TURN_FAILED", {
      stage: "acp",
      rpcCode: -32002,
    });
    const first = scriptedOpened([failTurn(gone)]);
    const second = scriptedOpened([replyTurn("recovered")]);
    _acpSdkDeps.acpBackend = () => ({ kind: "acp:claude", open: async () => second.opened });
    const { session } = build(first.opened);
    const result = await runTurnLoop(session, "p", { interactionHandler: NONE });
    expect(result).toMatchObject({ output: "recovered", internalRoundTrips: 1 });
    expect(second.prompts).toEqual(["p"]);
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/nax && bun test test/unit/agents/acp-sdk/turn-loop.test.ts --timeout=30000`
Expected: FAIL, the loop throws `SessionTurnError`.

- [ ] **Step 3: Implement**

In `turn-loop.ts`: delete the local `isSessionNotFound` function; import `isSessionGone` from `./failure-map` (extend the existing failure-map import); in `afterFailure` replace `!isSessionNotFound(err)` with `!isSessionGone(err)`; change the log text to `"ACP session not found mid-turn; re-opening it fresh"` (unchanged) and update the file header bullet to read "- the agent no longer knowing the session (AGENT_SESSION_NOT_FOUND, or a prompt-time TURN_FAILED not-found, D3-f) re-opens the session fresh once and resends, the dead attempt uncounted (acpx exit code 4);". Remove `NaxError` from the `@/errors` import only if nothing else in the file uses it (it is still used by `runTurnLoop`'s in-flight error, so keep it).

- [ ] **Step 4: Run the tests**

Run: `cd packages/nax && bun test test/unit/agents/acp-sdk/turn-loop.test.ts --timeout=30000`
Expected: PASS, including the two existing NOT_FOUND tests.

- [ ] **Step 5: Commit**

```bash
git add packages/nax/src/agents/acp-sdk/turn-loop.ts packages/nax/test/unit/agents/acp-sdk/turn-loop.test.ts
git commit -m "fix(nax): sdk turn loop recovers a prompt-time session-not-found (S4b-3 D3-f)"
```

---

### Task 5: `promptRetries` (T1-1)

**Files:**
- Create: `packages/nax/src/agents/acp-sdk/prompt-retry.ts`
- Create: `packages/nax/test/unit/agents/acp-sdk/prompt-retry.test.ts`
- Modify: `packages/nax/src/agents/acp-sdk/stream-bridge.ts` (`anyEvent()`)
- Modify: `packages/nax/test/unit/agents/acp-sdk/stream-bridge.test.ts`
- Modify: `packages/nax/test/unit/agents/acp-sdk/ask-port.test.ts` (its `CallBridge` literal, ~lines 22-29, gains `anyEvent: () => false`)
- Modify: `packages/nax/src/agents/acp-sdk/session.ts` (`_acpSdkDeps.delay`)
- Modify: `packages/nax/src/agents/acp-sdk/turn-loop.ts` (`runIteration`)
- Modify: `packages/nax/test/unit/agents/acp-sdk/turn-loop.test.ts`

**Interfaces:**
- Consumes: `codeOf`, `contextOf`, `isSessionGone` (Task 3).
- Produces:
  - `isRetryablePromptError(err: unknown): boolean`
  - `promptRetryDelayMs(retryIndex: number): number`
  - `PROMPT_RETRY_BASE_MS = 1_000`, `PROMPT_RETRY_MAX_MS = 10_000`
  - `CallBridge.anyEvent(): boolean`
  - `_acpSdkDeps.delay: (ms: number, signal?: AbortSignal) => Promise<void>`

- [ ] **Step 1: Write the failing pure tests**

`test/unit/agents/acp-sdk/prompt-retry.test.ts`:

```ts
// test/unit/agents/acp-sdk/prompt-retry.test.ts
import { describe, expect, test } from "bun:test";
import { AgentSessionError, NaxError } from "@nathapp/nax-agent";
import { isRetryablePromptError, promptRetryDelayMs } from "@/agents/acp-sdk/prompt-retry";

describe("isRetryablePromptError (S4b-0 Ruling T1-1, acpx 0.19.4)", () => {
  test.each([
    ["TURN_FAILED -32603", new NaxError("x", "AGENT_SESSION_TURN_FAILED", { rpcCode: -32603 }), true],
    ["TURN_FAILED -32700", new NaxError("x", "AGENT_SESSION_TURN_FAILED", { rpcCode: -32700 }), true],
    ["rate limited (a -32603)", new AgentSessionError("slow", "AGENT_SESSION_RATE_LIMITED"), true],
    ["TURN_FAILED -32600", new NaxError("x", "AGENT_SESSION_TURN_FAILED", { rpcCode: -32600 }), false],
    ["TURN_FAILED no rpcCode", new NaxError("x", "AGENT_SESSION_TURN_FAILED", {}), false],
    ["session gone -32603", new NaxError("Session not found", "AGENT_SESSION_TURN_FAILED", { rpcCode: -32603 }), false],
    ["auth", new AgentSessionError("login", "AGENT_SESSION_AUTH_REQUIRED"), false],
    ["backend gone", new AgentSessionError("x", "AGENT_SESSION_BACKEND_UNAVAILABLE"), false],
    ["stop reason", new NaxError("t", "ACP_STOP_MAX_TOKENS"), false],
    ["plain Error", new Error("-32603"), false],
  ])("%s -> %p", (_name, err, retryable) => {
    expect(isRetryablePromptError(err)).toBe(retryable);
  });
});

describe("promptRetryDelayMs: min(1000 * 2^n, 10000), no jitter", () => {
  test.each([
    [0, 1_000],
    [1, 2_000],
    [2, 4_000],
    [3, 8_000],
    [4, 10_000],
    [9, 10_000],
  ])("retry %d waits %d ms", (index, ms) => {
    expect(promptRetryDelayMs(index)).toBe(ms);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/nax && bun test test/unit/agents/acp-sdk/prompt-retry.test.ts --timeout=30000`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `prompt-retry.ts`**

```ts
/**
 * `agent.acp.promptRetries` on the sdk transport (S4b spec §7.2, S4b-0 Ruling
 * T1-1). This is agent-internal retry, below any dispatch decision, so it is not
 * a RetryStrategy (retry-strategy.md "Scope: dispatch tiers only"): acpx ran the
 * same loop inside its own process. It follows acpx 0.19.4 exactly: only a
 * JSON-RPC internal (-32603) or parse (-32700) error, which includes a rate
 * limit, and only when the attempt produced no turn event at all (checked by
 * the caller); backoff min(1000 * 2^n, 10000) ms with no jitter. A session the
 * agent no longer knows is recovered by re-opening, never resent (D3-f).
 */
import { codeOf, contextOf, isSessionGone } from "./failure-map";

export const PROMPT_RETRY_BASE_MS = 1_000;
export const PROMPT_RETRY_MAX_MS = 10_000;

const RETRYABLE_RPC_CODES: ReadonlySet<number> = new Set([-32603, -32700]);

export function isRetryablePromptError(err: unknown): boolean {
  if (isSessionGone(err)) return false;
  const code = codeOf(err);
  if (code === "AGENT_SESSION_RATE_LIMITED") return true;
  if (code !== "AGENT_SESSION_TURN_FAILED") return false;
  const rpcCode = contextOf(err).rpcCode;
  return typeof rpcCode === "number" && RETRYABLE_RPC_CODES.has(rpcCode);
}

/** `retryIndex` 0 is the wait before the first retry. */
export function promptRetryDelayMs(retryIndex: number): number {
  return Math.min(PROMPT_RETRY_BASE_MS * 2 ** retryIndex, PROMPT_RETRY_MAX_MS);
}
```

- [ ] **Step 4: Run the pure tests**

Run: `cd packages/nax && bun test test/unit/agents/acp-sdk/prompt-retry.test.ts --timeout=30000`
Expected: PASS.

- [ ] **Step 5: Write the failing bridge test**

Add to `stream-bridge.test.ts`. The file already has `context(events: AgentStreamEvent[], pid?)` (line 5) returning a `StreamContext`; use it. `TurnEvent`'s `text_delta`, `thinking_delta` and `usage` members require `round` (`turn-event.ts:25-52`), as the file's existing literals show:

```ts
  test("anyEvent is true after any turn event, thinking and usage included (T1-1)", () => {
    for (const event of [
      { type: "thinking_delta", text: "hm", round: 1 },
      { type: "usage", round: 1, inputTokens: 1, outputTokens: 0, costUsd: 0, costSource: "unpriced" },
      { type: "tool_progress", callId: "c1" },
    ] as const) {
      const call = startCall(context([]));
      expect(call.anyEvent()).toBe(false);
      call.sink(event);
      expect(call.anyEvent()).toBe(true);
      expect(call.sideEffects()).toBe(false);
    }
  });
```

If the `usage` member's required fields differ from these, copy them from the file's existing usage literal.

In `ask-port.test.ts`, add `anyEvent: () => false,` to the `CallBridge` object literal (~lines 22-29) so it still satisfies the interface.

Run: `cd packages/nax && bun test test/unit/agents/acp-sdk/stream-bridge.test.ts --timeout=30000`
Expected: FAIL, `anyEvent` is not a function.

- [ ] **Step 6: Implement `anyEvent()`**

In `stream-bridge.ts`, add to `CallBridge`:

```ts
  /** True once the prompt produced any turn event at all (promptRetries, S4b-0 Ruling T1-1). */
  anyEvent(): boolean;
```

and change the `sideEffects` doc to "True once the prompt produced visible text or a tool call." Also fix the stale `StreamContext.pid` doc ("S4b-3 wires it from onProcess") to "kept current by the session's onProcess hooks". In `startCall`, add `let anyEvent = false;` beside `sideEffects`, set `anyEvent = true;` as the first statement after the `if (ended) return;` guard in `sink`, and return `anyEvent: () => anyEvent,`.

- [ ] **Step 7: Add the delay seam**

In `session.ts`, import `cancellableDelay` from `@/utils/bun-deps` and add to `_acpSdkDeps`:

```ts
  /** promptRetries' backoff; rejects with the signal's reason when it aborts (D3-h). */
  delay: (ms: number, signal?: AbortSignal): Promise<void> => cancellableDelay(ms, signal),
```

- [ ] **Step 8: Write the failing loop tests**

Add to `turn-loop.test.ts` a new `describe` (imports: `NaxError` from `@nathapp/nax-agent`; `ScriptedTurn` type from `@test/helpers/acp-fake-agent`):

```ts
describe("runTurnLoop: promptRetries (spec §7.2, T1-1)", () => {
  const transient = () =>
    new NaxError("The ACP prompt failed: internal", "AGENT_SESSION_TURN_FAILED", { stage: "acp", rpcCode: -32603 });

  function recordDelays(): number[] {
    const waits: number[] = [];
    _acpSdkDeps.delay = async (ms) => {
      waits.push(ms);
    };
    return waits;
  }

  /** Emits one turn event through the bridge sink, then fails like failTurn. */
  function eventThenFail(event: Parameters<NonNullable<SendTurnOpts["onTurnEvent"]>>[0], err: Error): ScriptedTurn {
    return async (prompt, opts) => {
      opts.onTurnEvent?.(event);
      return failTurn(err)(prompt, opts);
    };
  }

  test("a transient failure before any event is resent on the same call, up to promptRetries", async () => {
    const waits = recordDelays();
    const script = scriptedOpened([failTurn(transient()), failTurn(transient()), replyTurn("ok")]);
    const { session, events } = build(script.opened, { promptRetries: 2 });
    const result = await runTurnLoop(session, "p", { interactionHandler: NONE });
    expect(result).toMatchObject({ output: "ok", internalRoundTrips: 1 });
    expect(script.prompts).toEqual(["p", "p", "p"]);
    expect(waits).toEqual([1_000, 2_000]);
    expect(result.tokenUsage.inputTokens).toBe(30);
    expect(events.filter((e) => e.kind === "agent.call_started")).toHaveLength(1);
  });

  test("promptRetries 0 (the default) never resends", async () => {
    recordDelays();
    const script = scriptedOpened([failTurn(transient()), replyTurn("never")]);
    const { session } = build(script.opened);
    await expect(runTurnLoop(session, "p", { interactionHandler: NONE })).rejects.toBeInstanceOf(SessionTurnError);
    expect(script.prompts).toEqual(["p"]);
  });

  test("retries run out: the last failure is thrown with every attempt's spend", async () => {
    recordDelays();
    const script = scriptedOpened([failTurn(transient())]);
    const { session } = build(script.opened, { promptRetries: 1 });
    const err = await runTurnLoop(session, "p", { interactionHandler: NONE }).catch((e: unknown) => e);
    if (!(err instanceof SessionTurnError)) throw err;
    expect(script.prompts).toHaveLength(2);
    expect(err.tokenUsage?.inputTokens).toBe(20);
    expect(err.adapterFailure?.outcome).toBe("fail-adapter-error");
  });

  test("a thinking-only attempt is not retried (Review Focus 1)", async () => {
    recordDelays();
    const script = scriptedOpened([
      eventThenFail({ type: "thinking_delta", text: "hm", round: 1 }, transient()),
      replyTurn("x"),
    ]);
    const { session } = build(script.opened, { promptRetries: 3 });
    await expect(runTurnLoop(session, "p", { interactionHandler: NONE })).rejects.toBeInstanceOf(SessionTurnError);
    expect(script.prompts).toEqual(["p"]);
  });

  test("a non-retryable code is not retried", async () => {
    recordDelays();
    const script = scriptedOpened([failTurn(new NaxError("t", "ACP_STOP_MAX_TOKENS")), replyTurn("x")]);
    const { session } = build(script.opened, { promptRetries: 3 });
    await expect(runTurnLoop(session, "p", { interactionHandler: NONE })).rejects.toMatchObject({
      adapterFailure: { outcome: "fail-incomplete" },
    });
    expect(script.prompts).toEqual(["p"]);
  });

  test("an abort during the backoff ends the turn, no resend (Review Focus 2)", async () => {
    const run = new AbortController();
    _acpSdkDeps.delay = (_ms, signal) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        run.abort("shutdown");
      });
    const script = scriptedOpened([failTurn(transient()), replyTurn("never")]);
    const { session } = build(script.opened, { promptRetries: 3 });
    const err = await runTurnLoop(session, "p", { interactionHandler: NONE, signal: run.signal }).catch(
      (e: unknown) => e,
    );
    if (!(err instanceof SessionTurnError)) throw err;
    expect(err.adapterFailure?.outcome).toBe("fail-aborted");
    expect(script.prompts).toEqual(["p"]);
  });

  test("a session-gone -32603 is recovered, not retried (Review Focus 5)", async () => {
    const waits = recordDelays();
    const gone = new NaxError("Session not found", "AGENT_SESSION_TURN_FAILED", { stage: "acp", rpcCode: -32603 });
    const first = scriptedOpened([failTurn(gone)]);
    const second = scriptedOpened([replyTurn("recovered")]);
    _acpSdkDeps.acpBackend = () => ({ kind: "acp:claude", open: async () => second.opened });
    const { session } = build(first.opened, { promptRetries: 3 });
    const result = await runTurnLoop(session, "p", { interactionHandler: NONE });
    expect(result.output).toBe("recovered");
    expect(first.prompts).toEqual(["p"]);
    expect(waits).toEqual([]);
  });
});
```

Add `type SendTurnOpts` to the `@nathapp/nax-agent` import and `type ScriptedTurn` to the `@test/helpers/acp-fake-agent` import.

Run: `cd packages/nax && bun test test/unit/agents/acp-sdk/turn-loop.test.ts --timeout=30000`
Expected: the new retry tests FAIL (no resend happens).

- [ ] **Step 9: Implement the retry in `runIteration`**

In `turn-loop.ts`, import `isRetryablePromptError` and `promptRetryDelayMs` from `./prompt-retry`, `_acpSdkDeps` from `./session` (extend the existing import), and `type CallBridge` from `./stream-bridge`. Add above `runIteration`:

```ts
type BackendResult = Awaited<ReturnType<AcpSdkSession["opened"]["adapter"]["sendTurn"]>>;

interface Attempt {
  readonly controller: AbortController;
  readonly call: CallBridge;
  readonly turnId: string;
}

function sendOnce(session: AcpSdkSession, prompt: string, attempt: Attempt): Promise<BackendResult> {
  return session.opened.adapter.sendTurn(session.opened.handle, prompt, {
    ...session.opened.turnOpts(),
    signal: attempt.controller.signal,
    turnId: attempt.turnId,
    onTurnEvent: attempt.call.sink,
  });
}

/**
 * Sends the iteration's prompt, resending on the same call while T1-1 allows
 * (D3-h). A resent attempt is not a turn; its failed spend is kept. The backoff
 * waits on the iteration signal, so an abort there rejects with the abort reason.
 */
async function sendWithRetries(loop: Loop, attempt: Attempt): Promise<BackendResult> {
  const retries = loop.session.opts.promptRetries ?? 0;
  for (let retryIndex = 0; retryIndex < retries; retryIndex++) {
    try {
      return await sendOnce(loop.session, loop.state.currentPrompt, attempt);
    } catch (err) {
      if (attempt.controller.signal.aborted || attempt.call.anyEvent() || !isRetryablePromptError(err)) throw err;
      loop.state.spend = addSpend(loop.state.spend, spendOfError(err));
      getSafeLogger()?.info(STAGE, "ACP prompt failed before any output; resending", {
        sessionName: loop.session.name,
        retry: retryIndex + 1,
        of: retries,
      });
      await _acpSdkDeps.delay(promptRetryDelayMs(retryIndex), attempt.controller.signal);
    }
  }
  return sendOnce(loop.session, loop.state.currentPrompt, attempt);
}
```

In `runIteration`, replace the `session.opened.adapter.sendTurn(...)` call with:

```ts
    const result = await sendWithRetries(loop, { controller, call, turnId });
```

Everything else in `runIteration` stays: on a final failure its `catch` adds that attempt's spend and calls `afterFailure` with the iteration signal's reason when aborted, so an abort during the backoff classifies as `fail-aborted` / `fail-stale` (D3-h). Update the header comment: replace "promptRetries is S4b-3." with "promptRetries resends a prompt that failed before any turn event, on the same call (S4b-0 Ruling T1-1, D3-h)."

- [ ] **Step 10: Run the tests**

Run: `cd packages/nax && bun test test/unit/agents/acp-sdk/ --timeout=30000 && bun run typecheck`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add packages/nax/src/agents/acp-sdk/prompt-retry.ts packages/nax/src/agents/acp-sdk/stream-bridge.ts packages/nax/src/agents/acp-sdk/session.ts packages/nax/src/agents/acp-sdk/turn-loop.ts packages/nax/test/unit/agents/acp-sdk/prompt-retry.test.ts packages/nax/test/unit/agents/acp-sdk/stream-bridge.test.ts packages/nax/test/unit/agents/acp-sdk/turn-loop.test.ts packages/nax/test/unit/agents/acp-sdk/ask-port.test.ts
git commit -m "feat(nax): promptRetries on the sdk transport, acpx semantics (S4b-3 T1-1)"
```

---

### Task 6: Effort and the startup/teardown deadline options

**Files:**
- Modify: `packages/nax/src/agents/acp-sdk/open-context.ts` (`backendOptions`, constants)
- Modify: `packages/nax/src/agents/acp-sdk/session.ts` (use the moved constant)
- Modify: `packages/nax/test/unit/agents/acp-sdk/open-context.test.ts`
- Modify: `packages/nax/test/unit/agents/acp-sdk/session.test.ts` (startup-deadline test)

**Interfaces:**
- Produces: `DEFAULT_STARTUP_DEADLINE_MS = 30_000`, `DEFAULT_CLOSE_DEADLINE_MS = 10_000` exported from `open-context.ts`; `backendOptions` now sets `effort`, `initializeTimeoutMs`, `cancelGraceMs`.

- [ ] **Step 1: Write the failing tests**

The file's fixture is the const `OPTS: OpenSessionOpts` (line 7, whose model is an effort-suffixed `sonnet[...]`). Its existing test "strips the effort suffix from the model and never inherits the whole env" stays as is. Add, overriding `OPTS` by spread:

```ts
describe("backendOptions: effort and deadlines (spec §6.7, §7.2)", () => {
  test("the model spec's effort suffix becomes the effort option; the bare id is the model", () => {
    const options = backendOptions("claude", { ...OPTS, modelDef: { provider: "anthropic", model: "sonnet[high]" } });
    expect(options).toMatchObject({ model: "sonnet", effort: "high" });
  });

  test("no suffix, no effort", () => {
    const options = backendOptions("claude", { ...OPTS, modelDef: { provider: "anthropic", model: "sonnet" } });
    expect("effort" in options).toBe(false);
  });

  test("the configured deadlines become initializeTimeoutMs and cancelGraceMs", () => {
    const options = backendOptions("claude", {
      ...OPTS,
      trackedSpawnStartupDeadlineMs: 45_000,
      trackedSpawnDeadlineMs: 7_000,
    });
    expect(options).toMatchObject({ initializeTimeoutMs: 45_000, cancelGraceMs: 7_000 });
  });

  test("absent deadlines fall back to nax's schema defaults, not the backend's 60 s", () => {
    const { trackedSpawnDeadlineMs: _t, trackedSpawnStartupDeadlineMs: _s, ...bare } = OPTS;
    expect(backendOptions("claude", bare)).toMatchObject({
      initializeTimeoutMs: DEFAULT_STARTUP_DEADLINE_MS,
      cancelGraceMs: DEFAULT_CLOSE_DEADLINE_MS,
    });
    expect(DEFAULT_STARTUP_DEADLINE_MS).toBe(30_000);
    expect(DEFAULT_CLOSE_DEADLINE_MS).toBe(10_000);
  });

  test("over-max deadlines are clamped to what the backend accepts (D3-i)", () => {
    const options = backendOptions("claude", {
      ...OPTS,
      trackedSpawnStartupDeadlineMs: 9_000_000,
      trackedSpawnDeadlineMs: 9_000_000,
    });
    expect(options).toMatchObject({ initializeTimeoutMs: 3_600_000, cancelGraceMs: 600_000 });
  });
});
```

And one behavioural startup-deadline test in `session.test.ts` (spec §9 "startup and teardown deadlines"; teardown is already covered there), using that file's `useFake()` / `opts()` helpers:

```ts
  test("the startup deadline bounds initialize: a hung agent fails the open BACKEND_UNAVAILABLE (§7.2)", async () => {
    useFake({ hangInitialize: true });
    await expect(createSession("nax-start", "claude", opts({ trackedSpawnStartupDeadlineMs: 50 }))).rejects.toMatchObject({
      code: "AGENT_SESSION_BACKEND_UNAVAILABLE",
    });
  }, 20_000);
```

Import `DEFAULT_CLOSE_DEADLINE_MS` and `DEFAULT_STARTUP_DEADLINE_MS` from `@/agents/acp-sdk/open-context`.

Run: `cd packages/nax && bun test test/unit/agents/acp-sdk/open-context.test.ts --timeout=30000`
Expected: FAIL.

- [ ] **Step 2: Implement**

In `open-context.ts`:

```ts
/** `agent.acp.trackedSpawnStartupDeadlineMs`'s schema default; the adapter cannot read config (#1583). */
export const DEFAULT_STARTUP_DEADLINE_MS = 30_000;
/** `agent.acp.trackedSpawnDeadlineMs`'s schema default (PERF-1). */
export const DEFAULT_CLOSE_DEADLINE_MS = 10_000;
/** nax-agent-acp's option schema maxima (options.ts); nax's schema has no upper bound (D3-i). */
const BACKEND_MAX_INITIALIZE_MS = 3_600_000;
const BACKEND_MAX_CANCEL_GRACE_MS = 600_000;

export function backendOptions(
  agent: AcpAgentName,
  opts: OpenSessionOpts,
  onProcess?: AcpProcessHooks,
): AcpBackendOptions {
  const { model, effort } = parseModelSpec(opts.modelDef.model);
  return {
    agent,
    allowUnsandboxed: true,
    ...(model === "" ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
    env: backendEnv(opts.modelDef.env),
    inheritEnv: false,
    initializeTimeoutMs: Math.min(
      opts.trackedSpawnStartupDeadlineMs ?? DEFAULT_STARTUP_DEADLINE_MS,
      BACKEND_MAX_INITIALIZE_MS,
    ),
    cancelGraceMs: Math.min(opts.trackedSpawnDeadlineMs ?? DEFAULT_CLOSE_DEADLINE_MS, BACKEND_MAX_CANCEL_GRACE_MS),
    ...(onProcess === undefined ? {} : { onProcess }),
  };
}
```

Update the header comment: replace "Model only: effort is S4b-3; the probe found nax's model aliases offered verbatim (D2-a)." with "Model and effort come from the model spec (§6.7, D2-a); the startup and teardown deadlines become initializeTimeoutMs and cancelGraceMs (§7.2, D3-i)."

In `session.ts`, delete the local `DEFAULT_CLOSE_DEADLINE_MS` constant and import it from `./open-context` (extend the existing import).

- [ ] **Step 3: Run the tests**

Run: `cd packages/nax && bun test test/unit/agents/acp-sdk/ --timeout=30000 && bun run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/nax/src/agents/acp-sdk/open-context.ts packages/nax/src/agents/acp-sdk/session.ts packages/nax/test/unit/agents/acp-sdk/open-context.test.ts packages/nax/test/unit/agents/acp-sdk/session.test.ts
git commit -m "feat(nax): sdk transport passes effort and the tracked-spawn deadlines (S4b-3)"
```

---

### Task 7: Tool audit (spec §7.4, D3-j)

**Files:**
- Create: `packages/nax/src/agents/acp-sdk/tool-audit.ts`
- Create: `packages/nax/test/unit/agents/acp-sdk/tool-audit.test.ts`
- Modify: `packages/nax/src/agents/acp-sdk/stream-bridge.ts` (`StreamContext.audit`)
- Modify: `packages/nax/src/agents/acp-sdk/ask-port.ts` (denied row)
- Modify: `packages/nax/src/agents/acp-sdk/session.ts` (recorder, flush)
- Modify: `packages/nax/test/unit/agents/acp-sdk/ask-port.test.ts`, `stream-bridge.test.ts`, `session.test.ts`, `turn-loop.test.ts` (fixture field)

**Interfaces:**
- Consumes: nax-agent's `createToolAuditSink`, `createNoOpToolAuditSink`, `ToolAuditHeader`, `ToolCallRecord`, `TurnEvent`.
- Produces:

```ts
export interface AuditRecorder {
  onEvent(event: TurnEvent): void;
  denied(callId: string | undefined, tool: string, reason: string): void;
  flush(): Promise<void>;
}
export interface ToolAuditTarget { readonly dir: string; readonly header: ToolAuditHeader }
export function createAuditRecorder(
  sessionName: string,
  target: ToolAuditTarget | undefined,
  now?: () => Date,
): AuditRecorder;
```

  `StreamContext.audit?: AuditRecorder`; `createAskPort(slot, beatMs?, audit?)`; `AcpSdkSession.audit: AuditRecorder`.

- [ ] **Step 1: Write the failing recorder tests**

`test/unit/agents/acp-sdk/tool-audit.test.ts`:

```ts
// test/unit/agents/acp-sdk/tool-audit.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { createAuditRecorder } from "@/agents/acp-sdk/tool-audit";

const AT = new Date("2026-10-07T00:00:00.000Z");
let dir: string;

beforeEach(() => {
  dir = makeTempDir("acp-sdk-audit-");
});
afterEach(() => cleanupTempDir(dir));

function rows(): Array<Record<string, unknown>> {
  const files = readdirSync(dir);
  expect(files).toHaveLength(1);
  const body = JSON.parse(readFileSync(join(dir, files[0] ?? ""), "utf8")) as { calls: Array<Record<string, unknown>> };
  return body.calls;
}

function recorder() {
  return createAuditRecorder("nax-s", { dir, header: { runId: "run-1", storyId: "US-1", sessionRole: "implementer" } }, () => AT);
}

describe("createAuditRecorder (spec §7.4, D3-j)", () => {
  test("a call and its result are one row", async () => {
    const audit = recorder();
    audit.onEvent({ type: "tool_call", callId: "c1", name: "Read", input: { path: "a.ts" } });
    audit.onEvent({ type: "tool_result", callId: "c1", isError: false, preview: "abc", resultBytes: 1234 });
    await audit.flush();
    expect(rows()).toEqual([
      {
        tool: "Read",
        outcome: "ok",
        input: { path: "a.ts" },
        resultBytes: 1234,
        storyId: "US-1",
        at: AT.toISOString(),
        toolCallId: "c1",
      },
    ]);
  });

  test("an error result is outcome error; a missing resultBytes falls back to the preview's bytes", async () => {
    const audit = recorder();
    audit.onEvent({ type: "tool_call", callId: "c1", name: "Bash", input: { command: "x" } });
    audit.onEvent({ type: "tool_result", callId: "c1", isError: true, preview: "héllo" });
    await audit.flush();
    expect(rows()[0]).toMatchObject({ outcome: "error", resultBytes: 6 });
  });

  test("a denied call is one denied row (Review Focus 3)", async () => {
    const audit = recorder();
    audit.onEvent({ type: "tool_call", callId: "c1", name: "Write", input: { path: "x" } });
    audit.denied("c1", "Write", "profile read");
    audit.onEvent({ type: "tool_result", callId: "c1", isError: false, preview: "refused" });
    await audit.flush();
    expect(rows()).toEqual([expect.objectContaining({ tool: "Write", outcome: "denied", reason: "profile read" })]);
  });

  test("a deny with no pending call is written at once with empty input", async () => {
    const audit = recorder();
    audit.denied(undefined, "Edit", "profile read");
    await audit.flush();
    expect(rows()).toEqual([expect.objectContaining({ tool: "Edit", outcome: "denied", input: {}, resultBytes: 0 })]);
  });

  test("a call still pending at flush is written as error with 0 bytes", async () => {
    const audit = recorder();
    audit.onEvent({ type: "tool_call", callId: "c1", name: "Bash", input: "ls" });
    await audit.flush();
    expect(rows()).toEqual([expect.objectContaining({ outcome: "error", resultBytes: 0, input: { value: "ls" } })]);
  });

  test("non-tool events are ignored, and no target means nothing is written", async () => {
    const audit = createAuditRecorder("nax-s", undefined);
    audit.onEvent({ type: "tool_call", callId: "c1", name: "Read", input: {} });
    audit.onEvent({ type: "text_delta", text: "x", round: 1 });
    await audit.flush();
    expect(readdirSync(dir)).toEqual([]);
  });
});
```

Run: `cd packages/nax && bun test test/unit/agents/acp-sdk/tool-audit.test.ts --timeout=30000`
Expected: FAIL, module not found.

- [ ] **Step 2: Implement `tool-audit.ts`**

```ts
/**
 * Tool audit on the ACP SDK transport (S4b spec §7.4, D3-j). The backend emits
 * exactly one tool_result per tool_call, also when the turn throws; this pairs
 * them by ACP call id into one ToolCallRecord. A deny recorded by the ask port
 * between the two marks the call denied, so a refused call is one row. Input is
 * already redacted and capped by the backend; the sink redacts again at write.
 * Without OpenSessionOpts.toolAudit nothing is written.
 */
import {
  createNoOpToolAuditSink,
  createToolAuditSink,
  type ToolAuditHeader,
  type ToolAuditSink,
  type ToolCallRecord,
  type TurnEvent,
} from "@nathapp/nax-agent";

export interface ToolAuditTarget {
  readonly dir: string;
  readonly header: ToolAuditHeader;
}

export interface AuditRecorder {
  onEvent(event: TurnEvent): void;
  /** The ask port's auto-deny (recordAutoDecision). */
  denied(callId: string | undefined, tool: string, reason: string): void;
  /** Writes pending calls as errors, then flushes the sink. */
  flush(): Promise<void>;
}

interface Pending {
  readonly tool: string;
  readonly input: Record<string, unknown>;
  readonly at: string;
  deniedReason?: string;
}

function inputOf(input: unknown): Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : { value: input };
}

export function createAuditRecorder(
  sessionName: string,
  target: ToolAuditTarget | undefined,
  now: () => Date = () => new Date(),
): AuditRecorder {
  const sink: ToolAuditSink =
    target === undefined
      ? createNoOpToolAuditSink()
      : createToolAuditSink({ dir: target.dir, sessionName, header: target.header });
  const storyId = target?.header.storyId;
  const pending = new Map<string, Pending>();

  const write = (callId: string | undefined, call: Pending, outcome: ToolCallRecord["outcome"], bytes: number): void => {
    sink.record({
      tool: call.tool,
      outcome,
      input: call.input,
      resultBytes: bytes,
      ...(storyId === undefined ? {} : { storyId }),
      at: call.at,
      ...(callId === undefined ? {} : { toolCallId: callId }),
      ...(call.deniedReason === undefined ? {} : { reason: call.deniedReason }),
    });
  };

  return {
    onEvent: (event) => {
      if (event.type === "tool_call") {
        pending.set(event.callId, { tool: event.name, input: inputOf(event.input), at: now().toISOString() });
        return;
      }
      if (event.type !== "tool_result") return;
      const call = pending.get(event.callId);
      if (call === undefined) return;
      pending.delete(event.callId);
      const bytes = event.resultBytes ?? Buffer.byteLength(event.preview, "utf8");
      const outcome = call.deniedReason !== undefined ? "denied" : event.isError ? "error" : "ok";
      write(event.callId, call, outcome, bytes);
    },
    denied: (callId, tool, reason) => {
      const call = callId === undefined ? undefined : pending.get(callId);
      if (call !== undefined) {
        call.deniedReason = reason;
        return;
      }
      write(callId, { tool, input: {}, at: now().toISOString(), deniedReason: reason }, "denied", 0);
    },
    flush: async () => {
      for (const [callId, call] of pending) write(callId, call, call.deniedReason === undefined ? "error" : "denied", 0);
      pending.clear();
      await sink.flush();
    },
  };
}
```

`Pending.deniedReason` is the one mutable field: the recorder owns the map and the entry never leaves it, so the mutation is local; keep it this way rather than rebuilding the map entry.

Run: `cd packages/nax && bun test test/unit/agents/acp-sdk/tool-audit.test.ts --timeout=30000`
Expected: PASS.

- [ ] **Step 3: Write the failing wiring tests**

In `stream-bridge.test.ts`:

```ts
  test("every event reaches the audit recorder, also after call_ended", () => {
    const seen: string[] = [];
    const audit = { onEvent: (e: { type: string }) => seen.push(e.type), denied: () => {}, flush: async () => {} };
    const call = startCall({ ...context([]), audit });
    call.sink({ type: "tool_call", callId: "c1", name: "Read", input: {} });
    call.end("error");
    call.sink({ type: "tool_result", callId: "c1", isError: false, preview: "" });
    expect(seen).toEqual(["tool_call", "tool_result"]);
  });
```

In `ask-port.test.ts`:

```ts
  test("an auto-deny is written to the audit recorder (D2-k, D3-j)", () => {
    const denied: Array<[string | undefined, string, string]> = [];
    const audit = { onEvent: () => {}, denied: (c: string | undefined, t: string, r: string) => denied.push([c, t, r]), flush: async () => {} };
    const port = createAskPort(createTurnSlot(), 30_000, audit);
    port.recordAutoDecision({ callId: "c1", tool: "Write", summary: "s", reason: "profile read" }, "deny");
    port.recordAutoDecision({ callId: "c2", tool: "Read", summary: "s", reason: "full" }, "allow");
    expect(denied).toEqual([["c1", "Write", "profile read"]]);
  });
```

In `session.test.ts`, using its `useFake(script)`, `opts(overrides)`, `dir` and `createSession(name, "claude", opts(...))` helpers (lines 12-45):

```ts
  test("close flushes the tool audit before deleting the transcript (spec §7.4)", async () => {
    useFake();
    const auditDir = join(dir, "audit");
    const session = await createSession(
      "nax-audit",
      "claude",
      opts({ toolAudit: { dir: auditDir, header: { runId: "run-1", storyId: "US-1" } } }),
    );
    session.audit.onEvent({ type: "tool_call", callId: "c1", name: "Read", input: {} });
    session.audit.onEvent({ type: "tool_result", callId: "c1", isError: false, preview: "x", resultBytes: 1 });
    await shutdownSession(session, { waitMs: 2_000 });
    const files = readdirSync(auditDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toContain("run-1");
  }, 20_000);

  test("a call the profile refuses is one denied row, end to end through the fake agent (Review Focus 3)", async () => {
    useFake({
      turns: [
        {
          steps: [
            {
              kind: "permission",
              options: ["allow_once", "reject_once"],
              toolCall: { kind: "edit", title: "Write x", rawInput: { path: "x" } },
            },
            { kind: "text", text: "done" },
          ],
        },
      ],
    });
    const auditDir = join(dir, "audit-deny");
    const session = await createSession(
      "nax-deny",
      "claude",
      opts({
        resolvedPermissions: { mode: "approve-reads", bashApproval: "raw" },
        toolAudit: { dir: auditDir, header: { runId: "run-2", storyId: "US-2" } },
      }),
    );
    await runTurnLoop(session, "go", { interactionHandler: NO_OP_INTERACTION_HANDLER });
    await shutdownSession(session, { waitMs: 2_000 });
    const [file] = readdirSync(auditDir);
    const calls = (JSON.parse(readFileSync(join(auditDir, file ?? ""), "utf8")) as { calls: Array<{ outcome: string }> })
      .calls;
    expect(calls.map((c) => c.outcome)).toEqual(["denied"]);
  }, 20_000);
```

Imports if absent: `readdirSync`, `readFileSync` from `node:fs`; `join` from `node:path`; `NO_OP_INTERACTION_HANDLER` from `@nathapp/nax-agent`; `runTurnLoop` from `@/agents/acp-sdk/turn-loop`. The permission-step shape is the one `packages/nax-agent-acp/test/unit/client/backend-permissions.test.ts:79-84` uses; `approve-reads` maps to profile `read`, which auto-denies (S4b-2 profile map), and the backend announces the `tool_call` before deciding (`nax-agent-acp/src/client/inbound.ts:133`).

In `turn-loop.test.ts`'s `build()`, add the new required field to the literal: `audit: createAuditRecorder("nax-loop", undefined),` (import from `@/agents/acp-sdk/tool-audit`).

Run: `cd packages/nax && bun test test/unit/agents/acp-sdk/ --timeout=30000`
Expected: the new tests FAIL (and typecheck of `build()` until Step 4).

- [ ] **Step 4: Wire the recorder**

`stream-bridge.ts`: import `type AuditRecorder` from `./tool-audit`; add to `StreamContext`:

```ts
  /** Tool audit (§7.4); every event goes to it, also after call_ended, so no row is lost. */
  readonly audit?: AuditRecorder;
```

and make the first line of the `sink` closure `ctx.audit?.onEvent(event);` (before `if (ended) return;`).

`ask-port.ts`: import `type AuditRecorder` from `./tool-audit`; change the factory signature to `createAskPort(slot: TurnSlot, beatMs: number = AWAITING_HUMAN_BEAT_MS, audit?: AuditRecorder): SessionAskPort` and `recordAutoDecision` to:

```ts
    recordAutoDecision: (req, decision) => {
      if (decision !== "deny") return;
      getSafeLogger()?.debug(STAGE, "ACP request denied by the session profile", {
        tool: req.tool,
        reason: req.reason,
      });
      audit?.denied(req.callId, req.tool, req.reason);
    },
```

Update the header's last sentence to "recordAutoDecision writes a denied tool-audit row (D2-k, D3-j)."

`session.ts`:
- import `{ type AuditRecorder, createAuditRecorder }` from `./tool-audit` and `AWAITING_HUMAN_BEAT_MS` from `./ask-port` (extend the import);
- add `readonly audit: AuditRecorder;` to `AcpSdkSession` and `"audit"` to the `OpenBase` pick list;
- in `createSession`, before `base`: `const audit = createAuditRecorder(name, opts.toolAudit);`, put `audit` in `base`, and change `asks: createAskPort(slot)` to `asks: createAskPort(slot, AWAITING_HUMAN_BEAT_MS, audit)`;
- change `streamContextOf(name, opts, process)` to take `audit` and return `{ ...existing, audit }`; call it as `streamContextOf(name, opts, base.process, audit)`;
- in `shutdownSession`, replace the comment `// S4b-3: flush the tool-audit sink here, before the document goes.` with:

```ts
  await session.audit.flush().catch((err: unknown) => {
    getSafeLogger()?.warn(STAGE, "Could not write the ACP session's tool audit", {
      sessionName: session.name,
      error: errorText(err),
    });
  });
```

- [ ] **Step 5: Run the tests**

Run: `cd packages/nax && bun test test/unit/agents/acp-sdk/ --timeout=30000 && bun run typecheck && bun run check:all`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/nax/src/agents/acp-sdk/tool-audit.ts packages/nax/src/agents/acp-sdk/stream-bridge.ts packages/nax/src/agents/acp-sdk/ask-port.ts packages/nax/src/agents/acp-sdk/session.ts packages/nax/test/unit/agents/acp-sdk/
git commit -m "feat(nax): tool audit rows on the sdk transport (S4b-3 spec §7.4)"
```

---

### Task 8: `complete()` (spec §6.6, D3-a..c)

**Files:**
- Create: `packages/nax/src/agents/acp-sdk/complete.ts`
- Create: `packages/nax/test/unit/agents/acp-sdk/complete.test.ts`
- Modify: `packages/nax/src/agents/acp-sdk/adapter.ts` (`complete`)
- Modify: `packages/nax/src/agents/complete-exception-classifier.ts`
- Modify: `packages/nax/test/unit/agents/complete-exception-classifier.test.ts`
- Modify: `packages/nax/test/unit/agents/acp-sdk/adapter.test.ts` (drop the "complete() waits for S4b-3" assertion)

**Interfaces:**
- Consumes: `createSession`, `shutdownSession`, `closeDeadlineMs`, `type AcpSdkSession` (session.ts); `runTurnLoop`; `classifyTurnFailure`, `RunAborted` (failure-map.ts, Task 3); `SessionFailureError` (`agents/types.ts:508`, constructor `(message, adapterFailure)`); `toSessionModel` (`../session-model-mapping`); `computeAcpHandle` (`../session-naming`); `priceCall` (`../cost`).
- Produces: `runComplete(adapterName: string, agent: AcpAgentName, prompt: string, options: ResolvedCompleteOptions): Promise<CompleteResult>`; `DEFAULT_COMPLETE_TIMEOUT_MS = 120_000`.

- [ ] **Step 1: Write the failing classifier test**

Add to `test/unit/agents/complete-exception-classifier.test.ts` (import `SessionTurnError` from `@/agents`):

```ts
  test("a SessionTurnError carrying an adapterFailure is returned as is (sdk transport, spec §6.6)", () => {
    const failure = {
      category: "availability" as const,
      outcome: "fail-auth" as const,
      retriable: false,
      message: "login",
    };
    const err = new SessionTurnError("login", false, false, undefined, 0, undefined, undefined, failure);
    expect(classifyCompleteException(err)).toBe(failure);
  });

  test("a SessionFailureError's adapterFailure is returned as is (sdk complete() open failure, D3-a)", () => {
    const failure = {
      category: "quality" as const,
      outcome: "fail-adapter-error" as const,
      retriable: false,
      message: "model",
    };
    expect(classifyCompleteException(new SessionFailureError("model", failure))).toBe(failure);
  });
```

Import `SessionFailureError` from `@/agents` as well.

Run: `cd packages/nax && bun test test/unit/agents/complete-exception-classifier.test.ts --timeout=30000`
Expected: FAIL (message parsing yields `fail-unknown`).

- [ ] **Step 2: Implement the branch**

In `complete-exception-classifier.ts`, import `SessionFailureError` and `SessionTurnError` from `./types` and make the first statement of `classifyCompleteException`:

```ts
  // The sdk transport throws its failure pre-classified (S4b spec §6.6, D3-b); message parsing is for every other adapter.
  if ((err instanceof SessionTurnError || err instanceof SessionFailureError) && err.adapterFailure !== undefined) {
    return err.adapterFailure;
  }
```

Run the classifier test again: PASS. Run `bun run check:import-cycles` from `packages/nax`: PASS (if a new cycle is reported, import both classes from the `./types` leaf is already the narrowest path; report the cycle rather than routing through a barrel).

- [ ] **Step 3: Write the failing complete() tests**

`test/unit/agents/acp-sdk/complete.test.ts`:

```ts
// test/unit/agents/acp-sdk/complete.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { AgentSessionError, isProcessAlive, NaxError } from "@nathapp/nax-agent";
import { cleanupTempDir, makeTempDir, waitForCondition } from "@test/helpers";
import { failTurn, fakeAcpBackend, fakeStartPids, hangTurn, replyTurn, scriptedOpened } from "@test/helpers/acp-fake-agent";
import { _acpSdkDeps, AcpSdkAgentAdapter } from "@/agents/acp-sdk";
import { FALLBACK_RATES } from "@/agents/cost";
import { CompleteError, type ResolvedCompleteOptions, SessionFailureError, SessionTurnError } from "@/agents/types";

const REAL = { ..._acpSdkDeps };
let dir: string;

beforeEach(() => {
  dir = makeTempDir("acp-sdk-complete-");
  _acpSdkDeps.resolveRateCard = async () => ({ rates: FALLBACK_RATES, source: "fallback-rates" });
  _acpSdkDeps.cwdExists = async () => true;
});
afterEach(() => {
  Object.assign(_acpSdkDeps, REAL);
  cleanupTempDir(dir);
});

function options(overrides: Partial<ResolvedCompleteOptions> = {}): ResolvedCompleteOptions {
  return {
    modelDef: { provider: "anthropic", model: "sonnet" },
    workdir: dir,
    resolvedPermissions: { mode: "approve-all", bashApproval: "raw" },
    ...overrides,
  };
}

function scripted(...turns: Parameters<typeof scriptedOpened>[0]) {
  const script = scriptedOpened(turns);
  _acpSdkDeps.acpBackend = () => ({ kind: "acp:claude", open: async () => script.opened });
  return script;
}

describe("AcpSdkAgentAdapter.complete() (spec §6.6)", () => {
  test("returns trimmed output with tokens, card estimate, reported exact cost and rates", async () => {
    const script = scripted(replyTurn("  the answer \n"));
    const result = await new AcpSdkAgentAdapter("claude").complete("q", options());
    expect(result).toMatchObject({
      output: "the answer",
      tokenUsage: { inputTokens: 10, outputTokens: 5 },
      exactCostUsd: 0.01,
      pricingSource: "fallback-rates",
    });
    expect(result.estimatedCostUsd).toBeGreaterThan(0);
    expect(result.rates).toBeDefined();
    expect(script.prompts).toEqual(["q"]);
    expect(script.closeCount()).toBe(1);
  });

  test("one prompt only: a trailing question in the output does not start an interaction", async () => {
    const script = scripted(replyTurn("Which file should I edit?"), replyTurn("never"));
    const result = await new AcpSdkAgentAdapter("claude").complete("q", options());
    expect(result.output).toBe("Which file should I edit?");
    expect(script.prompts).toEqual(["q"]);
  });

  test("blank output throws CompleteError, as acpx", async () => {
    scripted(replyTurn("   "));
    await expect(new AcpSdkAgentAdapter("claude").complete("q", options())).rejects.toBeInstanceOf(CompleteError);
  });

  test("the timeout throws AGENT_TIMEOUT and closes the session", async () => {
    const script = scripted(hangTurn());
    const err = await new AcpSdkAgentAdapter("claude")
      .complete("q", options({ timeoutMs: 50 }))
      .catch((e: unknown) => e);
    if (!(err instanceof NaxError)) throw err;
    expect(err.code).toBe("AGENT_TIMEOUT");
    expect(script.closeCount()).toBe(1);
  });

  test("a run abort is rethrown fail-aborted, never a cancelled result (D3-a, D2-c)", async () => {
    scripted(hangTurn());
    const run = new AbortController();
    const cancels: Array<() => Promise<void>> = [];
    const pending = new AcpSdkAgentAdapter("claude").complete(
      "q",
      options({ signal: run.signal, onActiveCall: (_id, cancel) => cancels.push(cancel) }),
    );
    await waitForCondition(() => cancels.length > 0);
    run.abort("shutdown");
    const err = await pending.catch((e: unknown) => e);
    if (!(err instanceof SessionTurnError)) throw err;
    expect(err.adapterFailure?.outcome).toBe("fail-aborted");
  });

  test("an open-time failure is thrown pre-classified as SessionFailureError (D3-a)", async () => {
    _acpSdkDeps.acpBackend = () => ({
      kind: "acp:claude",
      open: async () => {
        throw new AgentSessionError("login", "AGENT_SESSION_AUTH_REQUIRED");
      },
    });
    const err = await new AcpSdkAgentAdapter("claude").complete("q", options()).catch((e: unknown) => e);
    if (!(err instanceof SessionFailureError)) throw err;
    expect(err.adapterFailure).toMatchObject({ outcome: "fail-auth", category: "availability" });
  });

  test("a model refusal at open is fail-adapter-error / quality (D2-b through complete())", async () => {
    _acpSdkDeps.acpBackend = () => ({
      kind: "acp:claude",
      open: async () => {
        throw new AgentSessionError("no model", "AGENT_SESSION_CAPABILITY_UNSUPPORTED", { capability: "model" });
      },
    });
    const err = await new AcpSdkAgentAdapter("claude").complete("q", options()).catch((e: unknown) => e);
    if (!(err instanceof SessionFailureError)) throw err;
    expect(err.adapterFailure).toMatchObject({ outcome: "fail-adapter-error", category: "quality" });
  });

  test("a watchdog cancel returns cancelled with the burned tokens priced, no adapterFailure (BUG-57)", async () => {
    scripted(hangTurn({ inputTokens: 7, outputTokens: 2, costUsd: 0.004 }));
    const cancels: Array<() => Promise<void>> = [];
    const pending = new AcpSdkAgentAdapter("claude").complete(
      "q",
      options({ onActiveCall: (_id, cancel) => cancels.push(cancel) }),
    );
    await waitForCondition(() => cancels.length > 0);
    await cancels[0]?.();
    const result = await pending;
    expect(result).toMatchObject({ cancelled: true, output: "", tokenUsage: { inputTokens: 7, outputTokens: 2 } });
    expect(result.estimatedCostUsd).toBeGreaterThan(0);
    expect(result.adapterFailure).toBeUndefined();
  });

  test("any other failure is thrown pre-classified", async () => {
    scripted(failTurn(new AgentSessionError("login", "AGENT_SESSION_AUTH_REQUIRED")));
    const err = await new AcpSdkAgentAdapter("claude").complete("q", options()).catch((e: unknown) => e);
    if (!(err instanceof SessionTurnError)) throw err;
    expect(err.adapterFailure).toMatchObject({ outcome: "fail-auth", category: "availability" });
  });

  test("promptRetries applies to complete()", async () => {
    _acpSdkDeps.delay = async () => {};
    const transient = new NaxError("x", "AGENT_SESSION_TURN_FAILED", { rpcCode: -32603 });
    const script = scripted(failTurn(transient), replyTurn("ok"));
    const result = await new AcpSdkAgentAdapter("claude").complete("q", options({ promptRetries: 1 }));
    expect(result.output).toBe("ok");
    expect(script.prompts).toEqual(["q", "q"]);
  });

  test("the session is named from sessionName, else computeAcpHandle", async () => {
    const opened: string[] = [];
    const script = scriptedOpened([replyTurn("x")]);
    _acpSdkDeps.acpBackend = () => ({
      kind: "acp:claude",
      open: async (ctx) => {
        opened.push(ctx.sessionId);
        return script.opened;
      },
    });
    const adapter = new AcpSdkAgentAdapter("claude");
    await adapter.complete("q", options({ sessionName: "nax-explicit" }));
    await adapter.complete("q", options({ featureName: "feat", storyId: "US-1" }));
    expect(opened[0]).toBe("nax-explicit");
    expect(opened[1]).toContain("feat");
  });

  test("the profile comes from resolvedPermissions, as sessions (B3)", async () => {
    const profiles: string[] = [];
    const script = scriptedOpened([replyTurn("x")]);
    _acpSdkDeps.acpBackend = () => ({
      kind: "acp:claude",
      open: async (ctx) => {
        profiles.push(ctx.profile);
        return script.opened;
      },
    });
    await new AcpSdkAgentAdapter("claude").complete(
      "q",
      options({ resolvedPermissions: { mode: "approve-reads", bashApproval: "raw" } }),
    );
    expect(profiles).toEqual(["read"]);
  });

  test(
    "a hung complete() times out and leaves no agent process (Review Focus 4)",
    async () => {
      const record = join(dir, "record.jsonl");
      _acpSdkDeps.acpBackend = fakeAcpBackend({ turns: [{ steps: [{ kind: "hang" }] }] }, record);
      // The fake's "hang" ignores session/cancel, so the close waits out cancelGraceMs: keep it short.
      const err = await new AcpSdkAgentAdapter("claude")
        .complete("q", options({ timeoutMs: 300, trackedSpawnDeadlineMs: 500 }))
        .catch((e: unknown) => e);
      if (!(err instanceof NaxError)) throw err;
      expect(err.code).toBe("AGENT_TIMEOUT");
      const pid = fakeStartPids(record)[0];
      expect(pid).toBeDefined();
      await waitForCondition(() => pid !== undefined && !isProcessAlive(pid), 5_000);
    },
    30_000,
  );
});
```

`isProcessAlive` comes from `@nathapp/nax-agent`, as in `adapter.test.ts:5`. No `as` casts in test code: the `looseCast` ratchet in `check:all` (`check-test-escape-hatches.ts`) rejects growth; narrow with `instanceof` as above.

Run: `cd packages/nax && bun test test/unit/agents/acp-sdk/complete.test.ts --timeout=30000`
Expected: FAIL, `ACP_SDK_COMPLETE_UNAVAILABLE`.

- [ ] **Step 4: Implement `complete.ts`**

```ts
/**
 * One-shot complete() on the ACP SDK transport (S4b spec §6.6, B3, D3-a). Each
 * call is a throwaway session (acpx force-closed its one-shot session too):
 * memory transcript, no tools, no tool audit, the profile from
 * resolvedPermissions, one prompt through the same turn loop (so the stream,
 * deadlines, promptRetries and spend are shared with sessions), then a forced
 * close. A timeout is NaxError AGENT_TIMEOUT; a watchdog cancel returns
 * cancelled with the burned tokens priced; a run abort and every other failure
 * are thrown pre-classified, open failures as SessionFailureError (D3-a).
 */
import { NO_OP_INTERACTION_HANDLER, type OpenSessionOpts } from "@nathapp/nax-agent";
import type { AcpAgentName } from "@nathapp/nax-agent-acp/client";
import { NaxError } from "@/errors";
import { getSafeLogger } from "@/logger";
import { priceCall, type RateCard } from "../cost";
import { toSessionModel } from "../session-model-mapping";
import { computeAcpHandle } from "../session-naming";
import {
  CompleteError,
  type CompleteResult,
  type ResolvedCompleteOptions,
  SessionFailureError,
  SessionTurnError,
  type TurnResult,
} from "../types";
import { classifyTurnFailure, RunAborted } from "./failure-map";
import { type AcpSdkSession, closeDeadlineMs, createSession, shutdownSession } from "./session";
import { runTurnLoop } from "./turn-loop";

const STAGE = "acp-sdk";
/** acpx's complete() default (adapter-complete-flow.ts). */
export const DEFAULT_COMPLETE_TIMEOUT_MS = 120_000;
const MS_PER_SECOND = 1_000;

function sessionOptsFor(adapterName: string, options: ResolvedCompleteOptions, timeoutMs: number): OpenSessionOpts {
  return {
    agentName: adapterName,
    workdir: options.workdir,
    resolvedPermissions: options.resolvedPermissions,
    modelDef: toSessionModel(options.modelDef),
    ...(options.modelTier === undefined ? {} : { modelTier: options.modelTier }),
    timeoutSeconds: timeoutMs / MS_PER_SECOND,
    ...(options.promptRetries === undefined ? {} : { promptRetries: options.promptRetries }),
    ...(options.trackedSpawnDeadlineMs === undefined ? {} : { trackedSpawnDeadlineMs: options.trackedSpawnDeadlineMs }),
    ...(options.trackedSpawnStartupDeadlineMs === undefined
      ? {}
      : { trackedSpawnStartupDeadlineMs: options.trackedSpawnStartupDeadlineMs }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.onPidSpawned === undefined ? {} : { onPidSpawned: options.onPidSpawned }),
    ...(options.onPidExited === undefined ? {} : { onPidExited: options.onPidExited }),
    ...(options.onActiveCall === undefined ? {} : { onActiveCall: options.onActiveCall }),
    ...(options.onStreamActivity === undefined ? {} : { onStreamActivity: options.onStreamActivity }),
  };
}

function successResult(result: TurnResult, sessionId: string | null | undefined): CompleteResult {
  const output = result.output.trim();
  if (output === "") throw new CompleteError("complete() returned empty output");
  return {
    output,
    tokenUsage: result.tokenUsage,
    estimatedCostUsd: result.estimatedCostUsd,
    ...(result.exactCostUsd === undefined ? {} : { exactCostUsd: result.exactCostUsd }),
    ...(sessionId === null || sessionId === undefined ? {} : { sessionId }),
    ...(result.pricingSource === undefined ? {} : { pricingSource: result.pricingSource }),
    ...(result.rates === undefined ? {} : { rates: result.rates }),
  };
}

/** acpx's cancelled path: no adapterFailure (the wiring layer names fail-stale), burned tokens priced (BUG-57). */
function cancelledResult(err: SessionTurnError, rateCard: RateCard): CompleteResult {
  const tokenUsage = err.tokenUsage ?? { inputTokens: 0, outputTokens: 0 };
  const hasUsage = tokenUsage.inputTokens > 0 || tokenUsage.outputTokens > 0;
  const priced = hasUsage ? priceCall(tokenUsage, rateCard.rates) : undefined;
  return {
    output: "",
    tokenUsage,
    estimatedCostUsd: priced?.costUsd ?? 0,
    ...(err.exactCostUsd === undefined ? {} : { exactCostUsd: err.exactCostUsd }),
    cancelled: true,
    pricingSource: rateCard.source,
    ...(priced?.resolvedRates === undefined ? {} : { rates: priced.resolvedRates }),
  };
}

export async function runComplete(
  adapterName: string,
  agent: AcpAgentName,
  prompt: string,
  options: ResolvedCompleteOptions,
): Promise<CompleteResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_COMPLETE_TIMEOUT_MS;
  const name =
    options.sessionName ??
    computeAcpHandle(options.workdir, options.featureName, options.storyId, options.sessionRole);
  if (options.maxTokens !== undefined) {
    getSafeLogger()?.debug(STAGE, "maxTokens has no ACP equivalent; ignored", { sessionName: name });
  }
  const session = await openClassified(name, agent, sessionOptsFor(adapterName, options, timeoutMs));
  try {
    const result = await runTurnLoop(session, prompt, {
      interactionHandler: NO_OP_INTERACTION_HANDLER,
      maxInteractions: 1,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (result.timedOut === true) {
      throw new NaxError("complete() timed out", "AGENT_TIMEOUT", { stage: "acp", timeoutMs });
    }
    return successResult(result, session.handle.protocolIds?.sessionId);
  } catch (err) {
    // Only the watchdog's cancel is a cancelled result; a run abort stays fail-aborted (D3-a, D2-c).
    if (err instanceof SessionTurnError && err.adapterFailure?.outcome === "fail-stale") {
      return cancelledResult(err, session.rateCard);
    }
    throw err;
  } finally {
    await shutdownSession(session, { waitMs: closeDeadlineMs(session.opts), force: true });
  }
}

/** Opens the throwaway session; an open failure is classified like a turn's (§7.1) and thrown pre-classified (D3-a). */
async function openClassified(name: string, agent: AcpAgentName, opts: OpenSessionOpts): Promise<AcpSdkSession> {
  try {
    return await createSession(name, agent, opts);
  } catch (err) {
    const cause = opts.signal?.aborted === true ? new RunAborted(opts.signal.reason) : undefined;
    const failure = classifyTurnFailure(err, cause);
    throw new SessionFailureError(failure.message, failure.adapterFailure);
  }
}
```

`SessionFailureError` (`agents/types.ts:508`) has no `cause` field; the original error's message is carried in the failure's message (capped at 500 by `classifyTurnFailure`).

If `TurnResult.pricingSource` is typed as required, drop the conditional spread and assign it directly; follow the type.

In `adapter.ts`: import `runComplete` from `./complete`; replace the stub:

```ts
  async complete(prompt: string, options: ResolvedCompleteOptions): Promise<CompleteResult> {
    const entry = this.requireEntry(options.sessionName ?? "complete");
    throwIfAborted(options.signal, "Run aborted — shutdown in progress");
    await this.requireWorkdir(options.sessionName ?? "complete", options.workdir);
    return runComplete(this.name, entry.agent, prompt, options);
  }
```

Remove `NaxError`'s `ACP_SDK_COMPLETE_UNAVAILABLE` text and update the header's "S4b-2 scope (D2-d)" paragraph to "complete() is a throwaway session (complete.ts, B3)." In `adapter.test.ts`, delete the assertion that `complete()` rejects with `ACP_SDK_COMPLETE_UNAVAILABLE` (in the identity-rows test) and its "waits for S4b-3" comment.

- [ ] **Step 5: Run the tests**

Run: `cd packages/nax && bun test test/unit/agents/acp-sdk/ test/unit/agents/complete-exception-classifier.test.ts --timeout=30000 && bun run typecheck && bun run check:all`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/nax/src/agents/acp-sdk/complete.ts packages/nax/src/agents/acp-sdk/adapter.ts packages/nax/src/agents/complete-exception-classifier.ts packages/nax/test/unit/agents/acp-sdk/complete.test.ts packages/nax/test/unit/agents/acp-sdk/adapter.test.ts packages/nax/test/unit/agents/complete-exception-classifier.test.ts
git commit -m "feat(nax): complete() on the sdk transport, throwaway session (S4b-3 spec §6.6)"
```

---

### Task 9: The npx-only launcher warning (spec §6.8, D3-k)

**Files:**
- Modify: `packages/nax/src/agents/types.ts` (`AgentAdapter.launchNote?`, near `isInstalled` at ~line 547)
- Modify: `packages/nax/src/agents/acp-sdk/session.ts` (`_acpSdkDeps.launchCandidateKind` replaces `isAgentLaunchable`)
- Modify: `packages/nax/src/agents/acp-sdk/adapter.ts` (`isInstalled`, `launchNote`)
- Modify: `packages/nax/src/execution/lifecycle/run-initialization.ts` (`checkAgentInstalled`, ~line 145)
- Modify: `packages/nax/test/unit/agents/acp-sdk/adapter.test.ts`
- Modify: `packages/nax/test/unit/cli/agents-list.test.ts` (lines 89-106 stub `isAgentLaunchable`)
- Modify: `packages/nax/test/unit/execution/lifecycle/run-initialization.test.ts` (`describe("agent preflight")`, ~line 430)

**Interfaces:**
- Produces:
  - `AgentAdapter.launchNote?(): string | undefined` (optional; only the sdk adapter implements it).
  - `_acpSdkDeps.launchCandidateKind: (agent: AcpAgentName) => LaunchCandidateKind | undefined`.

- [ ] **Step 1: Write the failing adapter tests**

Replace the existing `isInstalled` test in `adapter.test.ts` with:

```ts
describe("isInstalled and launchNote (spec §6.8, D3-k)", () => {
  test.each([
    ["local", true],
    ["npx", true],
    [undefined, false],
  ] as const)("launch candidate %p -> installed %p", async (kind, installed) => {
    _acpSdkDeps.launchCandidateKind = () => kind;
    expect(await new AcpSdkAgentAdapter("claude").isInstalled()).toBe(installed);
  });

  test("an npx-only launcher has a launch note; a local one has none", () => {
    _acpSdkDeps.launchCandidateKind = () => "npx";
    expect(new AcpSdkAgentAdapter("claude").launchNote()).toContain("npx");
    _acpSdkDeps.launchCandidateKind = () => "local";
    expect(new AcpSdkAgentAdapter("claude").launchNote()).toBeUndefined();
  });

  test("aider has no launcher and no note", async () => {
    const adapter = new AcpSdkAgentAdapter("aider");
    expect(await adapter.isInstalled()).toBe(false);
    expect(adapter.launchNote()).toBeUndefined();
  });
});
```

If the old test set `_acpSdkDeps.isAgentLaunchable`, remove that.

- [ ] **Step 2: Write the failing preflight test**

In `run-initialization.test.ts`, inside `describe("agent preflight")`, reusing its `makePrd` / `tmpDir` / `makeAgentAdapter` (lines 430-455):

```ts
  test("an installed agent's launch note is logged as a warning (spec §6.8, D3-k)", async () => {
    resetLogger();
    initLogger({ level: "silent" });
    const warnSpy = spyOn(getLogger(), "warn").mockImplementation(() => {});
    try {
      const prdPath = join(tmpDir, "prd-preflight-note.json");
      await Bun.write(prdPath, JSON.stringify(makePrd({ status: "pending", passes: false })));
      const adapter = {
        ...makeAgentAdapter({ binary: "claude", isInstalled: () => Promise.resolve(true) }),
        launchNote: () => "Only the npx fallback can launch this ACP agent",
      };
      await initializeRun({
        config: { ...DEFAULT_CONFIG, acceptance: { ...DEFAULT_CONFIG.acceptance, enabled: false } },
        prdPath,
        workdir: tmpDir,
        dryRun: false,
        agentGetFn: () => adapter,
      });
      expect(warnSpy.mock.calls.some((call) => String(call[1]).includes("npx"))).toBe(true);
    } finally {
      warnSpy.mockRestore();
      resetLogger();
    }
  });
```

Imports if absent: `spyOn` from `bun:test`; `getLogger`, `initLogger`, `resetLogger` from `@/logger` (the pattern `test/unit/agents/native/models.test.ts` uses). If `initializeRun` needs more context than the file's other preflight tests pass, copy `initWith`'s argument shape exactly.

Run: `cd packages/nax && bun test test/unit/agents/acp-sdk/adapter.test.ts test/unit/execution/lifecycle/run-initialization.test.ts --timeout=30000`
Expected: FAIL.

- [ ] **Step 3: Implement**

`agents/types.ts`, in `AgentAdapter` after `isInstalled()`:

```ts
  /**
   * A note the run's install check logs as a warning for the configured agent
   * (S4b spec §6.8: an ACP agent only the npx fallback can launch). Optional;
   * undefined means nothing to say.
   */
  launchNote?(): string | undefined;
```

`session.ts`: in the `@nathapp/nax-agent-acp/client` import, replace `isAgentLaunchable` with `launchCandidateKind` and `type LaunchCandidateKind`; in `_acpSdkDeps` replace the `isAgentLaunchable` entry with:

```ts
  launchCandidateKind: (agent: AcpAgentName): LaunchCandidateKind | undefined => launchCandidateKind(agent),
```

`adapter.ts`:

```ts
  /** True when nax-agent-acp finds a launch candidate for the agent, the npx fallback included (spec §6.8). */
  async isInstalled(): Promise<boolean> {
    return this.entry !== undefined && _acpSdkDeps.launchCandidateKind(this.entry.agent) !== undefined;
  }

  /** Spec §6.8, D3-k: the run's install check warns when only the npx fallback resolves. */
  launchNote(): string | undefined {
    if (this.entry === undefined || _acpSdkDeps.launchCandidateKind(this.entry.agent) !== "npx") return undefined;
    return `Only the npx fallback can launch ACP agent "${this.name}"; the first run downloads it inside the startup deadline`;
  }
```

`run-initialization.ts`, in `checkAgentInstalled`, after the `if (!installed) { ... }` block:

```ts
  const note = agent.launchNote?.();
  if (note !== undefined) {
    logger?.warn("execution", note, { agent: resolveDefaultAgent(config) });
  }
```

`agents-list.test.ts` (lines 89-106): replace `_acpSdkDeps.isAgentLaunchable` with `_acpSdkDeps.launchCandidateKind`, the stub `(agent) => agent === "claude"` with `(agent) => (agent === "claude" ? "local" : undefined)`, and the saved/restored `original` accordingly. Then `grep -rn "isAgentLaunchable" packages/nax/src packages/nax/test` must return nothing.

- [ ] **Step 4: Run the tests**

Run: `cd packages/nax && bun test test/unit/agents/acp-sdk/ test/unit/cli/agents-list.test.ts test/unit/execution/lifecycle/run-initialization.test.ts --timeout=30000 && bun run typecheck && bun run check:all`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/nax/src/agents/types.ts packages/nax/src/agents/acp-sdk/session.ts packages/nax/src/agents/acp-sdk/adapter.ts packages/nax/src/execution/lifecycle/run-initialization.ts packages/nax/test/unit/agents/acp-sdk/adapter.test.ts packages/nax/test/unit/cli/agents-list.test.ts packages/nax/test/unit/execution/lifecycle/run-initialization.test.ts
git commit -m "feat(nax): the run warns when only the npx fallback can launch the ACP agent (S4b-3 §6.8)"
```

---

### Task 10: Parity tests and the D2-c pin

**Files:**
- Create: `packages/nax/test/unit/agents/acp-sdk/parity-turn.test.ts`
- Create: `packages/nax/test/unit/agents/acp-sdk/parity-complete.test.ts`

**Interfaces:**
- Consumes: everything above. No source change is expected; a failing parity case is a defect to fix in the owning file (or, if acpx's behaviour was the one that was wrong, a spec §11 entry agreed with the maintainer, never a silently weakened test).

The parity map (spec §9): each acpx logic file and where its cases live on the sdk side. Plumbing files (`parser*`, `stdout-line-reader`, `session-ids`, `spawn-client`, `spawn-client-process`, `activity-emission`, `_spawn-client-test-helpers`) are deleted in S4b-5 and get no parity.

| acpx test file | sdk coverage |
|---|---|
| `adapter-phase-a.test.ts` | `turn-loop.test.ts` (interactions, budget, NOT_FOUND, abort, deadline) + `parity-turn.test.ts` (exact cost, max turns, no-op handler, BUG-57) |
| `adapter-send-turn-edges.test.ts` | `parity-turn.test.ts` (deadline between iterations, default budget 10 + warn, failed recovery, pre-aborted pricingSource) |
| `adapter-rate-card-pricing.test.ts`, `adapter-complete-rates.test.ts` | `parity-complete.test.ts` |
| `adapter.test.ts` complete() cases | `complete.test.ts` |
| `adapter-close-physical.test.ts`, `adapter-lifecycle.test.ts` (cwd guard) | `adapter.test.ts` |
| `agent-entries.test.ts` | `entries.test.ts` |
| `spawn-client-reasoning-effort.test.ts` (effort logic) | `open-context.test.ts` (Task 6) |
| `spawn-client-tracked-spawn-deadlines.test.ts` (startup vs teardown) | `open-context.test.ts` (Task 6) + `session.test.ts` teardown deadline |
| `token-mapper.test.ts` | backend owns token mapping; `pricing.test.ts` covers nax's side |
| `interaction-bridge-*.test.ts` | `AcpInteractionBridge` has no production reference (spec §5.2); deleted with the folder, no parity |
| `registry.test.ts` | stays; S4b-2 added the transport rows |

- [ ] **Step 1: Write `parity-turn.test.ts`**

Reuse the `build()` / `answering()` helpers by copying them from `turn-loop.test.ts` into this file (a test file may not import another test file), including the `audit` field from Task 7.

```ts
describe("sendTurn parity with acpx (spec §9)", () => {
  test("a run abort throws fail-aborted, which the policy never retries or swaps (D2-c pin)", async () => {
    const script = scriptedOpened([hangTurn()]);
    const { session } = build(script.opened);
    const run = new AbortController();
    const pending = runTurnLoop(session, "p", { interactionHandler: NONE, signal: run.signal });
    await waitForCondition(() => script.prompts.length === 1);
    run.abort("shutdown");
    const err = await pending.catch((e: unknown) => e);
    if (!(err instanceof SessionTurnError)) throw err;
    expect(err).toMatchObject({ cancelled: true, retryable: false });
    expect(err.adapterFailure?.outcome).toBe("fail-aborted");
    expect(failurePolicyFor("fail-aborted")).toMatchObject({ sameAgentRetry: "none", swap: "never" });
  });

  test("the default budget is 10 prompts and spending it warns (adapter-send-turn-edges)", async () => {
    resetLogger();
    initLogger({ level: "silent" });
    const warnSpy = spyOn(getLogger(), "warn").mockImplementation(() => {});
    try {
      const script = scriptedOpened([replyTurn("Shall I continue?")]);
      const { session } = build(script.opened);
      const result = await runTurnLoop(session, "p", { interactionHandler: answering(..."yyyyyyyyyyyy".split("")) });
      expect(result.internalRoundTrips).toBe(10);
      expect(warnSpy.mock.calls.some((call) => String(call[1]).includes("Interaction budget spent"))).toBe(true);
    } finally {
      warnSpy.mockRestore();
      resetLogger();
    }
  });

  test("the deadline expiring between iterations returns timedOut (adapter-send-turn-edges)", async () => {
    const script = scriptedOpened([replyTurn('<nax_tool_call name="t">{}</nax_tool_call>')]);
    const { session } = build(script.opened, { timeoutSeconds: 0.05 });
    const started = Date.now();
    // The reply is withheld until the 50 ms deadline has passed; no fixed timer in the test.
    const late: InteractionHandler = {
      onInteraction: async () => {
        await waitForCondition(() => Date.now() - started > 60);
        return { answer: "r" };
      },
    };
    const result = await runTurnLoop(session, "p", { interactionHandler: late });
    expect(result).toMatchObject({ timedOut: true, output: "" });
  });

  test("a pre-aborted turn still stamps the handle's pricingSource on the error (adapter-send-turn-edges)", async () => {
    const script = scriptedOpened([replyTurn("never")]);
    const { session } = build(script.opened);
    const err = await runTurnLoop(session, "p", { interactionHandler: NONE, signal: AbortSignal.abort("x") }).catch(
      (e: unknown) => e,
    );
    if (!(err instanceof SessionTurnError)) throw err;
    expect(err.pricingSource).toBe("fallback-rates");
    expect(err.estimatedCostUsd).toBe(0);
  });

  test("the exact cost sums every prompt's reported cost (adapter-phase-a)", async () => {
    const script = scriptedOpened([
      replyTurn('<nax_tool_call name="t">{}</nax_tool_call>', { inputTokens: 1, outputTokens: 1, costUsd: 0.25 }),
      replyTurn("done", { inputTokens: 1, outputTokens: 1, costUsd: 0.5 }),
    ]);
    const { session } = build(script.opened);
    const result = await runTurnLoop(session, "p", { interactionHandler: answering("r") });
    expect(result.exactCostUsd).toBeCloseTo(0.75);
    expect(result.internalRoundTrips).toBe(2);
  });

  test("NO_OP_INTERACTION_HANDLER ends the loop at the first question (adapter-phase-a)", async () => {
    const script = scriptedOpened([replyTurn("Which one?"), replyTurn("never")]);
    const { session } = build(script.opened);
    const result = await runTurnLoop(session, "p", { interactionHandler: NO_OP_INTERACTION_HANDLER });
    expect(result.output).toBe("Which one?");
    expect(script.prompts).toEqual(["p"]);
  });

  test("a failed NOT_FOUND re-open surfaces the dead turn's error (adapter-send-turn-edges)", async () => {
    const first = scriptedOpened([failTurn(new AgentSessionError("gone", "AGENT_SESSION_NOT_FOUND"))]);
    _acpSdkDeps.acpBackend = () => ({
      kind: "acp:claude",
      open: async () => {
        throw new Error("cannot reopen");
      },
    });
    const { session } = build(first.opened);
    const err = await runTurnLoop(session, "p", { interactionHandler: NONE }).catch((e: unknown) => e);
    if (!(err instanceof SessionTurnError)) throw err;
    expect(err.message).toBe("gone");
    expect(err.adapterFailure?.outcome).toBe("fail-adapter-error");
  });
});
```

Imports: `failurePolicyFor` from `@/agents/retry/failure-policy`; `NO_OP_INTERACTION_HANDLER`, `AgentSessionError`, `SessionTurnError`, `type InteractionHandler` from `@nathapp/nax-agent`; the `scriptedOpened` doubles from `@test/helpers/acp-fake-agent`; `waitForCondition` from `@test/helpers`; `spyOn` from `bun:test`; `getLogger`, `initLogger`, `resetLogger` from `@/logger`. The parity files mirror no single `src` module (they mirror acpx test files); say so in the PR body.

- [ ] **Step 2: Write `parity-complete.test.ts`**

Mirror the `complete.test.ts` setup (copy `options()` and `scripted()`), then:

```ts
describe("complete() pricing parity with acpx (adapter-rate-card-pricing, adapter-complete-rates)", () => {
  test("pricingSource and rates come from the resolved card", async () => {
    _acpSdkDeps.resolveRateCard = async () => ({
      rates: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
      source: "catalog-rates",
    });
    scripted(replyTurn("x", { inputTokens: 1_000_000, outputTokens: 0, costUsd: 0 }));
    const result = await new AcpSdkAgentAdapter("claude").complete("q", options());
    expect(result.pricingSource).toBe("catalog-rates");
    expect(result.estimatedCostUsd).toBeCloseTo(3);
    expect(result.rates).toMatchObject({ input: 3, output: 15 });
  });

  test("zero tokens: cost 0 and no rates (AC7 boundary)", async () => {
    scripted(replyTurn("x", { inputTokens: 0, outputTokens: 0, costUsd: 0 }));
    const result = await new AcpSdkAgentAdapter("claude").complete("q", options());
    expect(result.estimatedCostUsd).toBe(0);
    expect(result.rates).toBeUndefined();
  });

  test("the reported cost is exactCostUsd and never replaces the card estimate (AC7)", async () => {
    scripted(replyTurn("x", { inputTokens: 10, outputTokens: 10, costUsd: 9.99 }));
    const result = await new AcpSdkAgentAdapter("claude").complete("q", options());
    expect(result.exactCostUsd).toBeCloseTo(9.99);
    expect(result.estimatedCostUsd).not.toBeCloseTo(9.99);
  });

  test("a cancelled-but-billable result carries the card source (degraded results)", async () => {
    scripted(hangTurn({ inputTokens: 5, outputTokens: 5, costUsd: 0.01 }));
    const cancels: Array<() => Promise<void>> = [];
    const pending = new AcpSdkAgentAdapter("claude").complete(
      "q",
      options({ onActiveCall: (_id, cancel) => cancels.push(cancel) }),
    );
    await waitForCondition(() => cancels.length > 0);
    await cancels[0]?.();
    expect(await pending).toMatchObject({ cancelled: true, pricingSource: "fallback-rates" });
  });
});
```

If the `replyTurn` double reports `costSource: "reported"` for a `costUsd: 0` turn and that makes `exactCostUsd: 0` appear where acpx had none, keep the assertion on `estimatedCostUsd` only; the exact-cost semantics are covered by `pricing.test.ts`.

- [ ] **Step 3: PID callbacks across a reconnect (spec §9 "PID callbacks, including after a reconnect")**

Add to `test/unit/agents/acp-sdk/adapter.test.ts`, which already drives the fake agent subprocess. The script is the one `packages/nax-agent-acp/test/unit/client/backend-process.test.ts` uses for its S4-6 crash-and-reconnect case:

```ts
  test(
    "onPidSpawned/onPidExited fire for the first process and for the reconnect's process",
    async () => {
      _acpSdkDeps.acpBackend = fakeAcpBackend(
        {
          capabilities: { sessionCapabilities: { resume: {} } },
          turns: [{ steps: [{ kind: "text", text: "partial" }, { kind: "exit", code: 7 }] }],
          relaunch: { turns: [{ steps: [{ kind: "text", text: "back" }] }] },
        },
        record,
      );
      const spawned: number[] = [];
      const exited: number[] = [];
      const adapter = new AcpSdkAgentAdapter("claude");
      const handle = await adapter.openSession("nax-pids", {
        ...opts(),
        onPidSpawned: (pid) => spawned.push(pid),
        onPidExited: (pid) => exited.push(pid),
      });
      await adapter.sendTurn(handle, "x", { interactionHandler: NO_OP_INTERACTION_HANDLER }).catch(() => undefined);
      const result = await adapter.sendTurn(handle, "y", { interactionHandler: NO_OP_INTERACTION_HANDLER });
      expect(result.output).toBe("back");
      await adapter.closeSession(handle);
      expect(new Set(spawned).size).toBe(2);
      expect(spawned).toEqual(fakeStartPids(record));
      await waitForCondition(() => exited.length === 2, 5_000);
    },
    30_000,
  );
```

`opts()` is the `OpenSessionOpts` builder `adapter.test.ts` already defines and uses for its open/turn/close test; `record` is its fake-agent record path. Import `NO_OP_INTERACTION_HANDLER` from `@nathapp/nax-agent`. If the first `sendTurn` resolves instead of rejecting (the backend may report the crash as an errored turn that nax maps to a thrown `SessionTurnError`), the `.catch` keeps the test indifferent to which; the assertion is on the PIDs.

- [ ] **Step 4: Run the tests**

Run: `cd packages/nax && bun test test/unit/agents/acp-sdk/parity-turn.test.ts test/unit/agents/acp-sdk/parity-complete.test.ts test/unit/agents/acp-sdk/adapter.test.ts --timeout=30000`
Expected: PASS. A failure means a parity gap: fix it in the owning source file within this task and say so in the commit body.

- [ ] **Step 5: Commit**

```bash
git add packages/nax/test/unit/agents/acp-sdk/parity-turn.test.ts packages/nax/test/unit/agents/acp-sdk/parity-complete.test.ts packages/nax/test/unit/agents/acp-sdk/adapter.test.ts
git commit -m "test(nax): acpx parity cases on the sdk transport, D2-c pinned (S4b-3 §9)"
```

---

### Task 11: Integration tests on the `sdk` transport

**Files:**
- Create: `packages/nax/test/integration/agents/fail-stale-watchdog-sdk.test.ts`
- Create: `packages/nax/test/integration/cli/cli-core-agents-sdk.test.ts`

`stale-retry-session-reuse.test.ts` and `timeout-retry-fresh-session.test.ts` mock above the transport (SessionManager / AgentManager stubs, literal handles), so they are transport-agnostic and need no sdk variant; say so in the PR body.

- [ ] **Step 1: Write the watchdog variant**

Copy `makeWatchdogConfig` from `fail-stale-watchdog.test.ts`. The sdk bridge stamps events with `Date.now()`, so only the hang cases (AC9, AC7) run here; the activity-reset cases (AC10/AC11) are covered by `stream-bridge.test.ts` (event kinds) and the watchdog's own unit tests.

```ts
/**
 * The idle watchdog against the sdk transport's complete() (S4b spec §9):
 * AC9 and AC7 of fail-stale-watchdog.test.ts, with the backend scripted in
 * memory (scriptedOpened) instead of a mock acpx client.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeFakeClock, makeNaxConfig, waitForCondition } from "@test/helpers";
import { hangTurn, scriptedOpened } from "@test/helpers/acp-fake-agent";
import { _acpSdkDeps, AcpSdkAgentAdapter } from "@/agents/acp-sdk";
import { FALLBACK_RATES } from "@/agents/cost";
import { _idleWatchdogDeps, AgentStreamEventBus, attachAgentIdleWatchdog } from "@/runtime";

const REAL_SDK = { ..._acpSdkDeps };
const REAL_WATCHDOG = { ..._idleWatchdogDeps };
let clock: ReturnType<typeof makeFakeClock>;

beforeEach(() => {
  clock = makeFakeClock();
  _idleWatchdogDeps.setTimeout = clock.setTimeout as typeof _idleWatchdogDeps.setTimeout;
  _idleWatchdogDeps.clearTimeout = clock.clearTimeout as typeof _idleWatchdogDeps.clearTimeout;
  _idleWatchdogDeps.now = clock.now;
  _acpSdkDeps.resolveRateCard = () => Promise.resolve({ rates: FALLBACK_RATES, source: "fallback-rates" });
  _acpSdkDeps.cwdExists = async () => true;
  const script = scriptedOpened([hangTurn()]);
  _acpSdkDeps.acpBackend = () => ({ kind: "acp:claude", open: async () => script.opened });
});

afterEach(() => {
  Object.assign(_acpSdkDeps, REAL_SDK);
  Object.assign(_idleWatchdogDeps, REAL_WATCHDOG);
});

function completeOptions(registry: Map<string, () => Promise<void>>, bus: AgentStreamEventBus, timeoutMs: number) {
  return {
    resolvedPermissions: { mode: "approve-reads" as const, bashApproval: "raw" as const },
    modelDef: { provider: "anthropic" as const, model: "haiku" },
    workdir: "/tmp/test",
    timeoutMs,
    storyId: "us-test",
    onActiveCall: (callId: string, cancel: () => Promise<void>) => {
      registry.set(callId, cancel);
    },
    onStreamActivity: bus.emitAgentStream.bind(bus),
  };
}

describe("Idle watchdog stale cancellation (sdk transport)", () => {
  test("AC9: a hanging prompt surfaces cancelled:true before the wall-clock timeout", async () => {
    const IDLE_TIMEOUT_MS = 80;
    const bus = new AgentStreamEventBus();
    const registry = new Map<string, () => Promise<void>>();
    const detach = attachAgentIdleWatchdog(bus, registry, makeWatchdogConfig(IDLE_TIMEOUT_MS));
    try {
      const pending = new AcpSdkAgentAdapter("claude").complete("p", completeOptions(registry, bus, 5_000));
      // createSession does real async work before call_started; wait until the call is registered.
      await waitForCondition(() => registry.size > 0);
      await clock.advance(0);
      await clock.advance(IDLE_TIMEOUT_MS * 2);
      const result = await pending;
      expect(result.cancelled).toBe(true);
      expect(result.adapterFailure).toBeUndefined();
    } finally {
      detach();
    }
  });

  test("AC7: the watchdog cancel is not reported as a wall-clock timeout", async () => {
    const IDLE_TIMEOUT_MS = 80;
    const bus = new AgentStreamEventBus();
    const registry = new Map<string, () => Promise<void>>();
    const detach = attachAgentIdleWatchdog(bus, registry, makeWatchdogConfig(IDLE_TIMEOUT_MS));
    try {
      const pending = new AcpSdkAgentAdapter("claude").complete("p", completeOptions(registry, bus, 5_000));
      // createSession does real async work before call_started; wait until the call is registered.
      await waitForCondition(() => registry.size > 0);
      await clock.advance(0);
      await clock.advance(IDLE_TIMEOUT_MS * 2);
      const outcome = await pending.then(
        (result) => ({ kind: "result" as const, result }),
        (err: unknown) => ({ kind: "error" as const, err }),
      );
      expect(outcome.kind).toBe("result");
    } finally {
      detach();
    }
  });
});
```

Paste `makeWatchdogConfig` verbatim from the acpx file above the `describe`. `waitForCondition` polls on real time while the watchdog runs on the fake clock; `onActiveCall` registers the call right after `call_started`, so once `registry.size > 0` the watchdog is tracking the call and the clock advances fire its tick. Run `bunx biome check --write` on the new file if import ordering is reported.

- [ ] **Step 2: Write the `nax agents` variant**

```ts
/**
 * `nax agents` with agent.acp.transport "sdk" (S4b spec §9): install status comes
 * from the ACP launcher (launchCandidateKind), not from `which acpx`.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { makeTempDir } from "@test/helpers";
import { _acpSdkDeps } from "@/agents/acp-sdk";
import { _cliAgentsDeps, agentsListCommand } from "@/cli/agents";
import { DEFAULT_CONFIG, type NaxConfig } from "@/config";

const SDK_CONFIG: NaxConfig = {
  ...DEFAULT_CONFIG,
  agent: { ...DEFAULT_CONFIG.agent, acp: { ...DEFAULT_CONFIG.agent.acp, transport: "sdk" } },
};

describe("agentsListCommand on the sdk transport", () => {
  let testDir: string;
  const REAL_SDK = { ..._acpSdkDeps };
  let origGetAgentVersion: typeof _cliAgentsDeps.getAgentVersion;

  beforeAll(() => {
    testDir = makeTempDir("nax-agents-sdk-test-");
  });
  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });
  beforeEach(() => {
    origGetAgentVersion = _cliAgentsDeps.getAgentVersion;
    _cliAgentsDeps.getAgentVersion = async () => "1.0.0";
    _acpSdkDeps.launchCandidateKind = (agent) => (agent === "claude" ? "local" : undefined);
  });
  afterEach(() => {
    _cliAgentsDeps.getAgentVersion = origGetAgentVersion;
    Object.assign(_acpSdkDeps, REAL_SDK);
  });

  async function listOutput(config: NaxConfig): Promise<string> {
    const originalLog = console.log;
    let output = "";
    console.log = (message: string) => {
      output += `${message}\n`;
    };
    try {
      await agentsListCommand(config, testDir);
      return output;
    } finally {
      console.log = originalLog;
    }
  }

  test("claude shows installed through its ACP launcher; the others do not", async () => {
    const output = await listOutput(SDK_CONFIG);
    const claudeLine = output.split("\n").find((line) => /claude/i.test(line)) ?? "";
    expect(claudeLine.toLowerCase()).toContain("installed");
    const codexLine = output.split("\n").find((line) => /codex/i.test(line)) ?? "";
    expect(codexLine.toLowerCase()).not.toMatch(/\binstalled\b/);
  });

  test("lists the same agents as the acpx transport", async () => {
    const output = await listOutput(SDK_CONFIG);
    for (const name of ["claude", "codex", "opencode", "gemini", "pi"]) expect(output.toLowerCase()).toContain(name);
  });
});
```

Adjust the `installed` / "not installed" wording to the exact status strings `agentsListCommand` prints (read `src/cli/agents.ts`); if the not-installed label contains the word "installed" (e.g. "not installed"), assert on that label instead of the negative regex. If `DEFAULT_CONFIG.agent.acp` is typed readonly, build `SDK_CONFIG` with the repo's `makeNaxConfig({ agent: { acp: { transport: "sdk" } } })` helper instead.

- [ ] **Step 3: Run the integration tests**

Run: `cd packages/nax && bun test test/integration/agents/fail-stale-watchdog-sdk.test.ts test/integration/cli/cli-core-agents-sdk.test.ts test/integration/agents/fail-stale-watchdog.test.ts test/integration/cli/cli-core-agents.test.ts --timeout=30000`
Expected: PASS (both transports).

- [ ] **Step 4: Commit**

```bash
git add packages/nax/test/integration/agents/fail-stale-watchdog-sdk.test.ts packages/nax/test/integration/cli/cli-core-agents-sdk.test.ts
git commit -m "test(nax): watchdog and nax agents integration on the sdk transport (S4b-3 §9)"
```

---

### Task 12: Docs, the model probe run, and the full gates

**Files:**
- Modify: `packages/nax/src/config/schemas-infra.ts:325-328` (transport comment)
- Modify: `docs/superpowers/specs/2026-10-07-s4b-nax-run-acp-cutover-design.md` (§6.7, §7.1, §7.2, §11)

- [ ] **Step 1: Schema comment and config description**

In `schemas-infra.ts`, replace the transport comment's "incomplete until S4b-3 (no complete(), no promptRetries)" sentence with "complete on both transports since S4b-3; S4b-4 flips the default to sdk and S4b-5 deletes the key with acpx." In `packages/nax/src/cli/config-descriptions.ts:303`, replace "(S4b development key, incomplete until S4b-3)" with "(S4b development key; S4b-4 makes sdk the default)". If a test pins the description text (`grep -rn "incomplete until S4b-3" packages/nax/test`), update it in the same commit.

- [ ] **Step 2: Run the model probe (maintainer machine, unbilled, D2-b)**

Ask the maintainer before running it: it starts each installed agent's ACP launcher with the maintainer's own credentials (no prompt is sent, nothing is billed). Build the argument list from the maintainer's `~/.nax/config.json` `models` map with the effort suffix removed (`nax config` prints the resolved map), for example:

```bash
cd packages/nax-agent-acp && bun test/node/fixtures/model-probe.mjs \
  claude=haiku,sonnet,opus \
  codex=gpt-6-luna,gpt-6-sol \
  opencode=minimax/MiniMax-M2.7,minimax/MiniMax-M3 \
  pi=minimax/MiniMax-M2.7,minimax/MiniMax-M3,opencode-go/deepseek-v4-flash
```

Expected: one `offers [...]` line per installed agent and an `[OK]` / `[FAIL]` line per configured id, then `model probe done`. Paste the output into the PR body. Any `[FAIL]` id is reported to the maintainer as a config change needed before the S4b-4 flip (it does not block this slice).

- [ ] **Step 3: Spec updates**

In the spec:
- §6.7, after the Claude probe bullet: add "S4b-3 probe (D2-b, <date>): <one line per agent from Step 2: offered ids, and which configured ids failed>. A refusal now lists the offered ids (nax-agent-acp `[Unreleased]`)."
- §7.1, replace the "Run abort: acpx returned a zero-output TurnResult ..." paragraph with: "Run abort: acpx returned a zero-output TurnResult from this path; the sdk transport throws `fail-aborted` as the table says. Ruled 2026-10-07 (D2-c): the policy never retries or swaps `fail-aborted`, and the native adapter already throws; pinned by `parity-turn.test.ts`." Under the table add: "Categories (S4b-3 D3-d): session-error rows are `availability`, as `session-run-hop.ts` synthesizes for acpx; capability, stop-reason and unknown rows are `quality`. A plain `Error` is `fail-unknown` (D3-e). A prompt-time not-found (`TURN_FAILED` with `rpcCode` -32002 or the not-found text) is recovered like `AGENT_SESSION_NOT_FOUND` (D3-f)."
- §7.2, `promptRetries` row: replace "with jittered backoff. It applies **only when the failed attempt produced no visible output and no tool call**, meaning no `text_delta` and no `tool_call` (thinking alone does not count)" with "with backoff `min(1000 * 2^n, 10000)` ms and no jitter. It applies **only when the failed attempt produced no turn event of any kind** (S4b-0 Ruling T1-1, acpx parity)".
- §11, append:
  - "9. **Sessions classify auth and rate-limit failures** (`fail-auth`, `fail-rate-limit`). acpx's `sendTurn` had no such classification; only its `complete()` parsed them."
  - "10. **`complete()` throws its auth, rate-limit and model failures pre-classified** (`SessionTurnError.adapterFailure`), where acpx returned a degraded `CompleteResult` carrying `adapterFailure` (D3-c)."
  - "11. **`promptRetries` still applies only to `complete()` in practice.** `SessionManager` never fills `OpenSessionOpts.promptRetries`, so acpx sessions never passed `--prompt-retries`; the sdk loop honours the field when set (D3-g)."
  - "12. **Session open failures stay unclassified, as on acpx.** `session-run-hop.ts` opens the session outside its `try`; wiring open failures into the retry and swap policy is deferred (D3-l). `complete()` classifies its open failures (§6.6 item 5)."
  - "13. **`complete()` session errors are `availability`** (`BACKEND_UNAVAILABLE`, `TURN_FAILED`, `CLOSED`), where acpx's `complete()` classified a crash as `quality/fail-adapter-error`; this can change swap versus escalate for complete-kind ops (D3-m)."
  - "14. **A run abort during `complete()` throws `fail-aborted`.** acpx's `complete()` never observed the run signal; returning a cancelled result would be retried by the manager as `fail-stale` (D3-a)."

- [ ] **Step 4: Full gates**

Run, from `packages/nax`:

```bash
bun run typecheck && bun run check:all && bun run test && bun run test:coverage
```

and from `packages/nax-agent-acp`:

```bash
bun run typecheck && bun run check:all && bun run check:api && bun run test
```

Expected: all green; `test:coverage` passes with every new or changed `src/agents/acp-sdk/*.ts` file >= 80% lines and functions. Then `bun run build` from `packages/nax` and `bun dist/nax.js agents` with and without `agent.acp.transport: "sdk"` in a scratch project config: both list the five ACP rows.

- [ ] **Step 5: Commit**

```bash
git add packages/nax/src/config/schemas-infra.ts packages/nax/src/cli/config-descriptions.ts docs/superpowers/specs/2026-10-07-s4b-nax-run-acp-cutover-design.md
git commit -m "docs(spec): S4b-3 rulings D2-b/D2-c, T1-1 retries, behaviour changes 9-14"
```

---

## Done when (spec §10, S4b-3)

- The full §9 adapter, parity and integration suites are green on the `sdk` transport, with the acpx suites still green.
- `typecheck`, `check:all`, `bun run test` and `test:coverage` are green in `packages/nax`; nax-agent-acp's gates and `check:api` are green.
- The model probe output is in the PR body and spec §6.7.
- Default transport unchanged (`acpx`); no release; no billed run.
- PR body: decisions D3-a..D3-m, the parity map, the two transport-agnostic integration tests, the probe result, and any `[FAIL]` model ids for the maintainer.
