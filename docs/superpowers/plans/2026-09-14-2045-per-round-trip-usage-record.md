# Per-Round-Trip Usage Record — Implementation Plan (nax#2045)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the per-round-trip token usage that nax already emits, and already throws away, land in a durable artifact — so cost can be attributed *inside* a turn, and so a live or crashed run is analysable.

**Architecture:** `AgentUsageUpdateEvent` already fires once per `complete()` on the native transport and reaches `attachAgentStreamLogging`, which increments a counter and drops the payload (`agent-stream-logging.ts:63`). Three fields are widened (`cacheRead`, `cacheWrite`, `roundTrip`) plus an exact join key (`scopeId`), and a new `UsageAuditor` — modelled on `PromptAuditor`, including its `appendFileSync` carve-out — writes one JSONL line per event to `usage/<runId>.jsonl`. Because the sidecar appends incrementally rather than rewriting at drain, the live-run blind spot closes as a side effect.

**Tech Stack:** TypeScript, Bun (`bun:test`), Zod v4.

**Spec:** GitHub issue [nathapp-io/nax#2045](https://github.com/nathapp-io/nax/issues/2045) plus [this investigation comment](https://github.com/nathapp-io/nax/issues/2045#issuecomment-5663688047). **The comment corrects two claims in the issue body** — read it before the body, and do not implement against the body's consequence #1.

---

## What the investigation changed about this issue

**1. The join key already exists. Consequence #1 in the issue is wrong.**

`session-run-hop.ts:88` sets `transcriptOwner = options.scopeId ?? options.callId`, and the cost row carries both `callId` and `scopeId` (`cost-aggregator.ts:47-48`). Measured across every ledger and transcript on this machine:

```
distinct scopeIds: 10834   distinct callIds: 15312
transcripts with owner: 59
  match vs scopeId: 48      (81%)
  match vs callId :  2      (3%)
```

The issue's 0-of-1,940 measured `owner` against `callId`. **Do not add a join key to the transcript.** Task 2 instead propagates the same `scopeId` onto the stream event so the new sidecar joins to both the transcript and the ledger exactly.

**2. The gap is intra-*turn*, not intra-session.** The ledger row is already per-dispatch and already carries `callId`, `scopeId`, `sessionRole`, `storyId`, `stage`, `roundTrips`, `cacheRead`, `cacheWrite`. `prompt-audit` is also per-turn and already assigns a `turn` ordinal (`prompt-auditor.ts:236`). Implement / gate-fix / re-verify are separable today. What does not exist is resolution inside one turn: US-003's implementer was 337 round trips in one row. **That is the only gap this plan closes.**

**3. The cache figures are available at both emission sites — verified, and it is a type widening.**

- Native: `turn-loop.ts:388-393` already accumulates `res.usage.cacheReadInputTokens` / `cacheCreationInputTokens` in the same block that emits at `:407-412`. `NativeTurnActivity`'s `"usage"` variant (`turn-events.ts:23`) declares only three fields.
- ACP: `parser.ts:215-216` already parses `cache_read_input_tokens` / `cache_creation_input_tokens`. `AcpxLineActivity` (`parser.ts:30-36`) likewise declares only three.

**4. A trap worth knowing before Task 2.** `adapter.ts:275` sets `const callId = randomUUID()` for the stream event base. That is **not** the ledger's `callId` (`mu11sq5q-0012n8`, from the operation layer). A sidecar keyed on the stream `callId` would reproduce exactly the 0-match namespace mismatch the issue hit. Task 2 exists because of this.

---

## Global Constraints

- **Off by default, like `prompt-audit`.** `agent.promptAudit.enabled` defaults `false` (`schemas-infra.ts:363`); `agent.usageAudit` mirrors it exactly, including the optional `dir`. A run with the switch off must produce byte-identical artifacts to today.
- **Never fail a run over an audit write.** `PromptAuditor` swallows and logs; do the same. A usage record is diagnostics.
- **`appendFileSync`, deliberately.** `prompt-auditor.ts:1-24` documents the carve-out from the Bun-native rule, including the dogfood run where async `appendFile` silently dropped entries. Reuse the same `_queue` serialization and the same reasoning; cite that comment rather than restating it.
- **Do not touch `CostAggregator.drain()`.** `cost-aggregator.ts:554-575` rewrites the *entire* file on each pass — it is not append-shaped, and making it incremental is a redesign, not a cadence tweak. The sidecar makes a live run analysable without it. The issue's "flush cadence" discussion point is resolved by this plan, not deferred by it.
- **Do not change the transcript schema.** See correction 1.
- **ACP labels its cadence, never imitates nax's.** `perRoundTrip` is documented as absent on ACP because its usage cadence is the agent's. Record what ACP has with an explicit `cadence` field; never synthesize a round-trip ordinal for it.
- **Error handling:** `NaxError` per `.nax/rules/error-handling.md`.
- Commands: test `bun run test`, scoped `CI=1 AGENT=1 bun test --timeout=60000 <files>`, typecheck `bun run typecheck`, lint `bun run check:all`, sizes `bun run check:file-sizes`, coverage `bun run test:coverage` (**not** in `check:all` — this plan adds `src/` files).

---

### Task 1: Widen the usage event with cache figures and a round-trip ordinal

- [ ] **Step 1: Write the failing tests**

`test/unit/agents/native/session/turn-events.test.ts` (extend):

- `buildNativeStreamEvent` forwards `cacheRead` / `cacheWrite` when the activity carries them.
- Absent stays **absent**, never `0`. `turn-loop.ts:193-194` keeps `cacheReadInputTokens` as `number | undefined` precisely so "no cache data" and "zero cache tokens" stay distinguishable (`toNaxTokenUsage`'s contract). A test must pin that the event preserves the distinction.
- `roundTrip` is forwarded and equals the turn's `roundTrips` at emission.

`test/unit/agents/native/session/turn-loop-usage.test.ts`:

- A round trip whose `res.usage` carries cache fields emits them on the activity.
- The compaction-summary usage emission (`turn-loop.ts:372-378`) and the transport-retry zero-beat (`:349`) are **also** usage events. Decide and pin: they are **not** round-trip boundaries, so they carry no `roundTrip` and no `perRoundTrip`. Assert both.
- `roundTrip` on the real emission equals 1 on the first round trip, not 0.

- [ ] **Step 2: Run the tests to verify they fail**

- [ ] **Step 3: Implement**

Three interfaces:

```ts
// runtime/agent-stream-events.ts — AgentUsageUpdateEvent
readonly cacheRead?: number;
readonly cacheWrite?: number;
/** Native only: 1-based index of the round trip this usage covers, within the turn.
 *  Absent on a compaction-summary or retry beat, which are not round-trip boundaries. */
readonly roundTrip?: number;
/** Whose cadence this report follows. "round-trip" is nax's own loop (native);
 *  "agent" is the delegated agent's, which is not a nax turn marker (ACP). */
readonly cadence?: "round-trip" | "agent";
```

Mirror `cacheRead` / `cacheWrite` / `roundTrip` onto `NativeTurnActivity`'s `"usage"` variant (`turn-events.ts:23`), source them at the emission site `turn-loop.ts:407-412` from the same `res.usage` fields the block at `:388-393` already reads, and set `cadence: "round-trip"` alongside the existing `perRoundTrip: true`.

- [ ] **Step 4-5:** pass, `bun run typecheck && bun run check:all && bun run check:file-sizes`
- [ ] **Step 6: Commit** — `feat(runtime): carry cache figures and a round-trip ordinal on the usage event (#2045)`

---

### Task 2: Stamp the exact ledger join key on the stream event

Without this the sidecar reproduces the issue's own 0-match problem. Read trap 4 above first.

- [ ] **Step 1: Write the failing tests**

- A session opened with `transcriptOwner: "mu11sq5p-vkwysr"` produces stream events carrying `scopeId: "mu11sq5p-vkwysr"`.
- A session opened without one produces events with `scopeId` **absent** — never `""`, never the stream `callId`. An absent key must read as "unknown", not as a wrong key.
- The stream `callId` is unchanged (it is the watchdog's and `onActiveCall`'s handle — `adapter.ts:282` — and nothing may move under it).

- [ ] **Step 2: Run the tests to verify they fail**

- [ ] **Step 3: Implement**

`adapter.ts:276` builds `eventBase`. `nativeSessionTranscriptOwners` (`session.ts:120`) is already keyed on the same `handle.id` and already holds `scopeId ?? callId` from `session-run-hop.ts:88`. So:

```ts
const owner = nativeSessionTranscriptOwners.get(handle.id);
const eventBase = { callId, runId: "", agentName: handle.agentName, sessionName: handle.id,
                    ...(owner !== undefined ? { scopeId: owner } : {}) };
```

Add `readonly scopeId?: string` to `AgentStreamEventBase` with a doc comment that says plainly what it is: **the same value as `transcript.owner` and `ledger.scopeId`, and deliberately not the sibling `callId`, which is a stream-local UUID.** That comment is the thing that stops the next analyst repeating the issue's mistake — write it carefully.

Note this is native-only. ACP has no `transcriptOwner` (`session/types.ts:183` says ACP ignores it), so ACP events carry no `scopeId`. Pin that in a test rather than leaving it to be discovered.

- [ ] **Step 4-6:** pass, gates, commit — `feat(runtime): stamp the transcript/ledger scopeId on agent stream events (#2045)`

---

### Task 3: ACP parity — record what exists, label the cadence

- [ ] **Step 1: Write the failing tests**

`test/unit/agents/acp/parser.test.ts`:

- A `usage_update` line carrying `cache_read_input_tokens` / `cache_creation_input_tokens` yields an activity carrying them.
- Both `cachedReadTokens` and `cache_read_input_tokens` spellings are accepted (`parser.ts:215` already handles both — pin it).
- A line with no cache fields yields an activity with them **absent**, not `0`. Note `parser.ts:215-216` currently coerces with `?? 0` for its own token-breakdown path; the activity path must not inherit that, or every ACP row will claim a measured zero.

`spawn-client-session` test: the emitted event carries `cadence: "agent"` and **no** `perRoundTrip` and **no** `roundTrip`.

- [ ] **Step 2-4:** fail, implement (widen `AcpxLineActivity` at `parser.ts:30-36`, fill at the `usage_update` branch `:158`, emit at `spawn-client-session.ts:227`), pass.
- [ ] **Step 5:** gates.
- [ ] **Step 6: Commit** — `feat(acp): carry cache figures on usage activity and label the cadence (#2045)`

---

### Task 4: `agent.usageAudit` config

- [ ] **Step 1: Write the failing tests**

- Default is `{enabled: false}`, matching `promptAudit`.
- `dir` is optional and absolute-or-relative-to-workdir, same contract as `PromptAuditConfigSchema` (`schemas-infra.ts:195-203`).
- The `config-descriptions.ts` entries exist for both keys — `nax config` output is a covered surface.
- **Masking check:** `nax config` masks by *key name*, not value type. Confirm `usageAudit`'s keys do not collide with the mask list, and if they do, add the exemption + drift test the way the existing exemption list does.

- [ ] **Step 2-4:** fail, implement in `schemas-infra.ts` + `schemas.ts` + `config-descriptions.ts`, pass.
- [ ] **Step 5:** `bun run check:all` (the config drift tests live here).
- [ ] **Step 6: Commit** — `feat(config): add agent.usageAudit (#2045)`

---

### Task 5: `UsageAuditor` and its middleware

- [ ] **Step 1: Write the failing tests**

`test/unit/runtime/usage-auditor.test.ts`:

- One line per `agent.usage_update`, appended not rewritten: assert the file grows and earlier lines are byte-identical after a later append. This is the property that makes a live run analysable.
- The row shape:

```json
{"ts":…,"runId":…,"scopeId":…,"streamCallId":…,"sessionName":…,"sessionRole":…,
 "storyId":…,"stage":…,"agentName":…,"roundTrip":37,"cadence":"round-trip",
 "input":…,"output":…,"cacheRead":…,"cacheWrite":…,"costUsd":…}
```

  - `scopeId` is the Task-2 key. `streamCallId` is named so that nobody ever mistakes it for the ledger's `callId` — a test asserts the key is **not** called `callId`.
  - `sessionRole` is derived from `sessionName` (`US-001-implementer` -> `implementer`) against `CanonicalSessionRole` (`session-role.ts`). An unrecognised suffix leaves `sessionRole` absent — never a free-form string, which that file bans outright.
  - Absent cache figures stay absent.
- A write failure logs and does not throw.
- `createNoOpUsageAuditor()` writes nothing, mirroring `createNoOpPromptAuditor` (`prompt-auditor.ts:96`).

`test/unit/runtime/middleware/usage-audit.test.ts`: `attachUsageAuditSubscriber` records one row per event and returns a working unsubscribe.

- [ ] **Step 2: Run the tests to verify they fail**

- [ ] **Step 3: Implement**

`src/runtime/usage-auditor.ts` — `IUsageAuditor { record(entry): void; flush(): Promise<void> }`, class with `_queue: Promise<void>`, `_dirCreated`, `appendFileSync`. **Copy `PromptAuditor`'s structure deliberately** and point at its header comment for the `appendFileSync` rationale rather than duplicating the prose.

`src/runtime/middleware/usage-audit.ts` — `attachUsageAuditSubscriber(bus: IAgentStreamEventBus, auditor, runId)`, switching only on `agent.usage_update`. Export from `middleware/index.ts`.

**Do not** change `agent-stream-logging.ts`. Its counters are an activity trace and the idle watchdog's sibling; the payload belongs in the sidecar, not the run log. Say so in a comment at `:63` so the next reader does not re-file this issue.

Volume sanity: ~161 events per call at roughly 200 bytes is ~32 KB per call. Negligible as its own file, real noise in the run log — which is exactly why this is a sidecar.

- [ ] **Step 4-5:** pass, gates.
- [ ] **Step 6: Commit** — `feat(runtime): add a per-round-trip usage sidecar (#2045)`

---

### Task 6: Wire it into the runtime

- [ ] **Step 1: Write the failing tests**

- With `agent.usageAudit.enabled: true`, a run writes `usage/<runId>.jsonl` under the output dir.
- With it false (the default), **no** `usage/` directory is created at all.
- The subscriber is unsubscribed on teardown alongside the others.
- `flush()` is awaited on shutdown next to `promptAuditor.flush()`.

- [ ] **Step 2-3:** fail, then mirror `runtime/index.ts:315-324` for construction (`const usageDir = config.agent?.usageAudit?.dir ?? join(outputDir, "usage")`) and `:392` for attachment.

**Two deliberate differences from `PromptAuditor`, both of which need a pinning test:**

1. **No `featureName` gate.** `runtime/index.ts:320` reads `auditEnabled && opts?.featureName`, so prompt-audit silently does nothing for a run without a feature name — exactly the ad-hoc runs most worth measuring. The usage sidecar drops that condition.
2. **Flat layout, like `cost/`, not nested like `prompt-audit/`.** `PromptAuditor`'s constructor joins `featureName` into the path (`prompt-auditor.ts:228`), giving `prompt-audit/<feature>/<runId>.jsonl`. With no feature name to nest under, the sidecar writes `usage/<runId>.jsonl` — matching `cost/<runId>.jsonl`, which is also the artifact it will most often be joined against.

- [ ] **Step 4-5:** pass, gates.
- [ ] **Step 6: Commit** — `feat(runtime): wire the usage sidecar into the run (#2045)`

---

### Task 7: Coverage and the full gate

- [ ] `bun run test`
- [ ] `bun run typecheck`
- [ ] `bun run check:all`
- [ ] `bun run check:file-sizes`
- [ ] **`bun run test:coverage`** — this plan adds three `src/` files and it is not in `check:all`.

---

### Task 8: Prove it on a real run

- [ ] **Ask before running.** `nax run` needs explicit approval at the launch moment. Surface the command; do not launch it as part of executing this plan.
- [ ] Run any feature with `agent.usageAudit.enabled: true`.
- [ ] **Join test — the acceptance criterion.** For each session: join `usage/<runId>.jsonl` -> `cost/<runId>.jsonl` on `scopeId`, and `usage` -> `sessions/*.transcript.json` on `scopeId` = `owner`. Both must match at the rate the investigation measured (81% machine-wide, 100% on a run whose ledger has not been pruned). A lower rate means Task 2 is wrong.
- [ ] **Reconciliation test.** Sum `input`/`output`/`cacheRead`/`cacheWrite` across a session's usage rows and compare to that session's ledger row. They should agree. A systematic gap is the compaction-summary and retry beats — which Task 1 deliberately excluded from `roundTrip` but which still emit usage. Confirm which, and if the gap is real, decide whether the sidecar should tag those rows rather than leaving them unattributed.
- [ ] **Live-run test.** Read `usage/<runId>.jsonl` *while the run is still going* and confirm it has rows. That is the blind spot the issue's own first two revisions fell into (a transcript read mid-session showed 161 turns where the finished session had 217), and it is the one thing the ledger still cannot do.
- [ ] Post the join rates and the reconciliation to #2045 and close it against them.

---

## Deliberately out of scope

- **A transcript schema change.** `owner` already joins; the round-trip ordinal lives in the sidecar.
- **Making `CostAggregator.drain()` incremental.** It rewrites the whole file by design. The sidecar closes the live-run case without it.
- **Accumulating usage onto `CallTrackingState` and logging totals at `Agent call ended`.** Cheap, but it reproduces exactly what the ledger row already answers. The intra-turn resolution is the entire point of the issue.
- **Anything under `#2043` / `#2042` / `#1991`.** They are consumers of this substrate, not part of it.
