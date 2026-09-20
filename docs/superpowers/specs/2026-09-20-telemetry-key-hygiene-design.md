# Telemetry key hygiene — design

- **Opened:** 2026-09-20
- **Base:** main `13d6bfcb1`
- **Related:** #2155 (prompt-audit viewer), #2156 (hop correlation-id drift)
- **Prior art:** `docs/superpowers/specs/2026-09-08-ledger-and-audit-field-truth-design.md`

## 1. Problem

nax writes eight telemetry sinks under `~/.nax/<project>/`. Two of them —
`cost` and `review-audit` — join cleanly on `(runId, storyId)`. The rest do not
join at all, and the reason is not the file format.

`tool-audit` records every tool call the agent makes: 19,000 of them across the
live store. It cannot be connected to the money that paid for them, because the
file it writes is:

```ts
JSON.stringify({ sessionName: opts.sessionName, calls }, null, 2)   // src/tools/tool-audit.ts:73
```

There is no `runId`, no `callId`, no schema version, and no per-call identity.
`sessionName` here is `buildLedgerSessionName` output
(`src/agents/coding-tool-support.ts:279`) — `<storyId>-<sessionRole>` — which is
a different, coarser namespace than the `formatSessionName` value every other
sink records, and which is stable across re-runs by construction.

### 1.1 This is a known class, on its fifth pass

The 2026-09-08 ledger-and-audit-field-truth spec documents four prior instances
of one defect shape: a field is produced correctly, would be consumed correctly,
and the middleware in between never copies it across. That spec records that
#1907 shipped a canary guard "intended to make a fourth pass impossible", and
that it did not catch pass four.

This spec adds passes five and six (pass 5 has since been fixed — see the note below the table):

| pass | field dropped | where | status |
|---|---|---|---|
| 5 | `callId`, `scopeId` | `src/runtime/session-run-hop.ts:131-148` — #2156 | **FIXED** by #2158, 2026-09-20 05:48Z |
| 6 | `protocolIds.turnId` | declared `src/runtime/dispatch-events.ts:99`, set nowhere | open |

> **Pass 5 closed between this spec's base and its merge.** The spec is based on
> `13d6bfcb1` (11:41); #2158 landed at 13:48 and this document merged at 13:57.
> `session-run-hop.ts` now forwards both ids. Pass 5 is retained above as
> *evidence of the class*, not as outstanding work — §2.2 already placed fixing
> #2156 out of scope, and that entry is now moot rather than deferred.
>
> This weakens the §5.5 guard argument by one instance but does not retire it:
> pass 5 reached production and was caught by a human reading artifacts, not by
> a gate. A guard that existed would have caught it at commit time.

Pass six is not a copy failure but its degenerate case: the field was declared
on the event type and no producer ever populated it. `manager-dispatch.ts:128`
builds `protocolIds` with `sessionId` and `recordId` only.

**Why did #1907's guard not catch these? Because it is not there.** Verified
2026-09-20: `grep -rn "1907" src/ test/ scripts/ --include="*.ts"` returns one
unrelated hit, every `canary` match in `src/` is a release-version string, and
none of the 28 `scripts/check-*` guards checks dispatch-field forwarding.
#1907's *fix* shipped — `modelPassed` forwarding is live at
`src/runtime/middleware/review-audit.ts:70` — but the guard the 2026-09-08 spec
describes does not exist in the tree.

So the guard is an acceptance criterion of this spec (§5.5), and building it is
work, not a one-line extension. Fixing these two fields without it leaves pass
seven exactly as likely as pass six was.

### 1.2 Measured evidence

Every artifact in the live store parsed 2026-09-19 and re-measured 2026-09-20
(the store is live and grows between passes).

Coverage, by sink:

| sink | rows/files | `runId` | `storyId` | `featureName` | `callId` |
|---|---|---|---|---|---|
| `cost/*.jsonl` | 3,031 rows | 100% | 100% | 50.1% | 79.6% |
| `review-audit/*.json` | 1,031 files | 100% | 100% | 100% | never |
| `tool-audit/*.json` | 421 files / 19k calls | **never** | per call | dir path only | **never** |
| `prompt-audit/*.jsonl` | 3,287 rows | 100% | 100% | 94.1% | never (`recordId` 79.9%) |

Join fan-out on the natural composite `(runId, storyId, stage)`: 59.9% of cost
groups hold more than one row, up to 29.

### 1.3 Two claims from the source review that measurement refutes

The review this spec derives from proposed "pick `callId` as the one call-level
identity … that single field collapses the 60% fan-out to an exact join."

**It does not.** `callId` is minted once per `callOp` invocation
(`src/operations/call.ts:81` via `newCorrelationId`, `call-resolvers.ts:47`) and
is deliberately reused across every retry, agent-swap hop and turn of that
invocation. `CostAggregator.byCall()` (`src/runtime/cost-aggregator.ts:488-500`)
*accumulates* per callId rather than assigning, which is the design saying so.

Measured over all 3,031 rows:

| | |
|---|---|
| rows carrying `callId` | 2,412 (79.6%) |
| distinct `(runId, callId)` | 2,136 |
| groups holding >1 cost row | **214 (10.0%)** |
| max rows sharing one `callId` | 9 |

It reduces fan-out from 59.9% to 10.0%. It is a foreign key, not a primary key,
and the spec treats it as one. The largest group is one `callId` covering seven
`pi` requests followed by two `opencode` rows with `errorCode: DISPATCH_ERROR` —
a retry across an agent swap, exactly as designed.

**The 20.4% of cost rows with no `callId` are not a second defect.** The review
left this open. All 619 such rows carry `schemaVersion: None` — they are
unversioned pre-#1433 rows, the generation whose own changelog comment
(`src/runtime/middleware/cost.ts:20-45`) records that `sessionRole`,
`featureName` and `pricingSource` did not exist. Every row at `schemaVersion >= 2`
carries a `callId`. Nothing needs exempting; only history lacks it.

### 1.4 Why `sessionId` is not the answer either

`review-audit` carries `sessionId` on 100% of records, which makes it look like
the key the other sinks lack. It is not:

- On native it is `sha256(sessionName).slice(0,32)`
  (`src/agents/native/session-affinity.ts:31`), published as both `sessionId`
  and `recordId`. A pure function of the colliding label, with no run scoping —
  the same story re-run in the same workdir yields the identical value.
- On ACP it is the provider's volatile session id, re-issued on reconnect.

Measured over 1,031 review-audit records:

| | distinct | span >1 `runId` | worst |
|---|---|---|---|
| `sessionName` | 504 | 38 (7.5%) | 15 runs |
| `sessionId` | 758 | 10 (1.3%) | 2 runs |

Better, still not unique. `(runId, sessionId)` is unique; `sessionId` alone is
not. Additionally, 113 of 478 `sessionName`s map to more than one `sessionId`
(the ACP sessions), so the two are not interchangeable in either direction.

It is also unavailable where it would be needed: the session is opened *after*
the tool sink is built, in both callers — `session-run-hop.ts:63` vs `:89`, and
`build-hop-callback.ts:322` vs `:414`/`:443`. The code says so at
`session-run-hop.ts:55-60`: "at this point neither has run yet (no session has
been opened…)".

**Decision: `sessionId` is not added to `tool-audit`.** Cost rows carry it on 0%
at every schema version, so it would join to nothing in the sink this work
targets.

## 2. Scope

### 2.1 In scope

Three tiers, each independently useful, listed in ascending cost:

**Tier 1 — operation attribution.** Emit `callId` and `scopeId` on every
`tool-audit` call record. Both are already declared on `AgentRunOptions`
(`src/agents/types.ts:273` and `:275`) and are physically present
on the object at runtime; they are excluded from the tool layer by one explicit
type narrowing, the `Pick<>` at `src/agents/coding-tool-support.ts:301-316`,
whose final member is `"codingToolPackageDir"`. Widening that `Pick` by two
members and passing the values through `buildCodingToolSupport` to
`createToolAuditSink` is the entire change. No threading.

**Tier 2 — within-turn position.** Emit the model round-trip index on every tool
record. `roundTrips` is declared at `src/agents/native/session/turn-loop.ts:88`,
incremented at `:293`, and is in lexical scope at the tool dispatch
(`:415-421`). It does not reach the sink today: the path runs
`turn-loop.ts:417` → `src/agents/run-interaction-handler.ts:83` →
`src/tools/runtime.ts:217` (`sink.record({...})`), and neither
`RunInteractionOptions` nor `ToolCallRecord` carries an index.

> **Naming trap.** `turn-loop.ts:387` pushes `{ turnIndex: roundTrips, … }`. The
> field is named `turnIndex`; the value is the round-trip counter. They are not
> the same quantity. This spec uses `roundTrips` for the within-turn index and
> `turnId` for turn identity, and does not reuse the name `turnIndex`.

**Tier 3 — turn identity, and therefore price.** Mint a `turnId` per turn,
carry it onto the cost row, and emit it on the tool record.

The mint site matters and is not the obvious one. `protocolIds.turnId` is
consumed at `src/agents/manager-dispatch.ts:128`, but populating it *there*
would be too late: `runAsSession` calls `sendPrompt` and only then builds the
dispatch event, so an id created at event-build time comes into existence after
the tool calls it is meant to label. The id is therefore minted in
`runAsSession` **before** `sendPrompt`, passed down through `SendTurnOpts` so
the turn loop can attach it to each tool call, and stamped onto the event
afterwards. One value, three consumers.

This also gives tier 2 its carrier: `roundTrips` rides the same per-call turn
context, so the two tiers share one mechanism rather than inventing two.

Tier 3 is the only tier that makes a tool call priceable, because of a
granularity fact the source review did not reach: **a cost row is per turn, not
per model call.** One `runAsSession` emits exactly one `SessionTurnDispatchEvent`
(`src/agents/manager.ts:475-487`) and therefore one cost row, while
`runNativeTurn`'s internal loop runs unboundedly many model round trips inside
it — `roundTrips` is returned as `internalRoundTrips` (`turn-loop.ts:517`) and
stamped with `roundTripUnit: "model-call"`. Tiers 1 and 2 give attribution;
only tier 3 selects the cost row that holds the money.

**Transport scope.** Only `src/agents/native/session/turn-loop.ts` dispatches
`"coding-tool"` interactions; ACP does not use that path. So tier 2, and the
`turnId` on tool *records*, are native-only. The cost-row half of tier 3 is
transport-agnostic — `buildSessionTurnEvent` serves both — so an ACP turn still
gets a `turnId` on its cost row even though no tool record references it.
`roundTrips` is native-only in any case: ACP rows carry
`roundTripUnit: "agent-run"`, a different quantity.

Also in scope, independent of the tiers:

- **`schemaVersion` on `tool-audit`**, following the house convention exactly:
  an exported integer constant plus a per-version changelog comment, as
  `COST_ROW_SCHEMA_VERSION = 5` does at `src/runtime/middleware/cost.ts:87` with
  its history at `:20-45`.
- **A file header** carrying `runId`, `featureName`, `storyId`, `sessionRole`.
- **Demoting `sessionName`** to a documented human label in `tool-audit`, never
  a join key.

### 2.2 Out of scope

- **SQLite, in any form.** The store is 2,967-plus cost rows and 1,031 review
  records; the current analyzer joins it in well under a second in memory.
  SQLite buys ergonomics, not performance, and should arrive later as a derived,
  rebuildable index over the JSONL — never as the sink. JSONL append from
  parallel worktree sessions is lock-free; several run processes writing one
  SQLite file is a contention surface that does not exist today.
- **Transcript retention.** `closeNativeSession` (`src/agents/native/session/session.ts:184-196`) keeps a transcript on failure
  and deletes it on success, capped at `MAX_RETAINED_TRANSCRIPTS = 50`
  (`src/agents/native/session/transcript-store.ts:139`). There is
  no corpus to key — zero `*.transcript.json` files exist in the store. Whether
  to retain them is a separate decision with a real disk-growth question
  attached.
- **Backfilling history.** 82 of 184 runs carry no `featureName` on any cost row
  and are permanently unattributable; five schema generations will never
  reconcile. Old data stays queryable as-is and the clean series starts at this
  change.
- **Retiring the prompt-audit `.txt` generation.** Tracked as #2155. The `.txt`
  is the human-readable view, not a redundant data source, and stays until a
  viewer exists.
- **Cost-row `featureName` coverage** (50.1%). Deliberately excluded.
- **Fixing #2156.** The hop drift is real but independent; this spec cites it
  and does not carry it. **Closed by #2158 on 2026-09-20**, after this spec's
  base commit — the entry is moot, retained so the §1.1 pass table reads
  consistently.

## 3. Design

### 3.1 Record shape

```jsonc
{
  "schemaVersion": 1,
  "runId": "…",
  "featureName": "…",
  "storyId": "US-001",
  "sessionRole": "implementer",
  "sessionName": "US-001-implementer",   // label only; see 3.3
  "calls": [
    {
      "callId": "…",            // tier 1 — FK to cost rows, 1:N
      "scopeId": "…",           // tier 1 — coarser region key
      "turnId": "…",            // tier 3 — selects the cost row
      "roundTrips": 3,          // tier 2 — position within that turn
      "toolCallId": "toolu_…",  // provider tool_use id; session-scoped only
      "tool": "Read",
      "outcome": "ok",
      "resultBytes": 40000
      // … existing ToolCallRecord fields unchanged
    }
  ]
}
```

Filename becomes `<runId>-<epochMs>-<sessionName>.json`, so run identity is
recoverable from the path without parsing the file. That is the property which
gives prompt-audit's `.jsonl` its 100% `runId` coverage — it is named
`<runId>.jsonl` (`src/runtime/prompt-auditor.ts:227-230`). `epochMs` is retained
so re-runs of one story within a run do not collide.

### 3.2 `runId` plumbing

`runId` is not reachable from the sink's construction path: it appears nowhere
in `src/agents/coding-tool-support.ts`, and `AgentRunOptions` has no such field.
There is no ambient run context in this codebase — `AsyncLocalStorage` appears
nowhere in `src/` or `test/`; `runId` is hand-threaded everywhere it is used.

**Add `runId` to `AgentRunOptions` and populate it at the two production
callers.** This matches how `cost` and `review-audit` already obtain it
(closure-captured constructor parameters, `src/runtime/index.ts:421` and `:423`)
and keeps the dependency visible and typed.

- `src/operations/call-run-options.ts` already holds `ctx.runtime.runId` one
  dereference away and drops it. `CallContext` carries `readonly runtime:
  NaxRuntime` and `NaxRuntime.runId` is public.
- `src/runtime/index.ts:402` has the run-level `runId` const lexically in scope
  at `createSessionRunHop` and does not capture it.

The field is optional, so existing test call sites keep compiling.

Rejected alternatives: passing `runId` into `buildCodingToolSupport`'s args
instead (hides the dependency and still requires both callers to supply it); an
`AsyncLocalStorage` run context (zero precedent, and an implicit dependency is
precisely the wrong shape where worktree and parallel isolation already bite —
see #2069).

### 3.3 `sessionName` is demoted, not removed

It stays in the file as a human label and its doc comment says so. Three facts
make it unusable as a key:

1. The `formatSessionName` prefix is `sha256(workdir).slice(0,8)`
   (`src/runtime/session-name.ts:12-36`) — constant within one checkout,
   discriminating only across worktrees.
2. The remainder is `feature-story-role`, stable across re-runs by construction,
   so every retry of a story reuses the label: 7.5% of review `sessionName`s
   span more than one `runId`, worst shared by 15 runs.
3. `tool-audit` uses the *other* dialect entirely
   (`buildLedgerSessionName`, no workdir hash, no `pipelineStage`), so it is
   coarser than the one every other sink writes, not merely differently
   formatted.

### 3.4 Identity caveats to record in the schema comment

- **`callId` is not unique.** 1:N over cost rows by design. Disambiguate an
  attempt within a `callId` by `ts` plus `agentName`/`kind`.
- **`toolCallId` is provider-assigned and session-scoped.** nax never mints or
  namespaces it; it is the `tool_use` block id passed through verbatim. It is
  **not stable across a retry** — a retried turn produces fresh ids. The unique
  tuple is `(runId, sessionName, toolCallId)`.
- **The three boundaries do not coincide.** The audit sink is per *hop*
  ("Resolved per hop, not per run", `src/runtime/session-run-hop.ts:41-43`),
  a cost row is per *turn*, and a `callId` spans *hops*. One tool-audit file
  therefore already spans multiple cost rows. This is why tier 3 is needed and
  why the file header alone cannot carry turn identity.
- **There are two unrelated fields named `callId`.** The op-layer one
  (`src/runtime/dispatch-events.ts:85`) is on cost rows. The stream-layer one
  (`src/runtime/agent-stream-events.ts:11`) is a per-turn random UUID used by
  the idle watchdog and stream logging; that file's own comment records that
  joining on it produced nax#2045's 0-of-1,940 match rate, and
  `src/runtime/middleware/usage-audit.ts:9` renames it `streamCallId` to keep
  them apart. **This spec means the op-layer field throughout.**

## 4. Sequencing

This work lands **after** `feat/native-loop-events` merges, for a reason that is
structural rather than administrative.

That feature's US-002 replaces seven separate tool-result append sites in
`turn-loop.ts` with a single result builder and adds typed `before_tool` /
`after_tool` registrations. That builder is the only point at which the tool
call and the enclosing turn context are simultaneously in scope, which is
exactly what tiers 2 and 3 need. Done before it, the stamping is duplicated
across seven sites and then rewritten; done after, it is one stamp.

Tier 3's other two touch points — `manager-dispatch.ts` and `cost.ts` — are
outside that feature's scope and will not collide.

**One consequence to handle explicitly.** US-003 moves truncation out of the
individual tools and into an `after_tool` policy, so tools return up to
`READ_CEILING` and the session truncates. `resultBytes` is measured *after*
truncation both before and after that merge, which means the same field name
changes denominator at the boundary. `tool-audit` has no `schemaVersion` today,
so this would land as an undeclared generation and would silently break any
carry-cost series computed as `resultBytes x remaining round trips`. The v1
changelog comment introduced by this spec must state the boundary.

Verified post-merge on `f4b3bbc7a`, the change is **threefold**, not a single
shift, and the v1 comment must name all three:

1. **Different cap owner.** Pre-merge, `result.content.length` after each tool's
   own truncation at `ctx.maxBytes`. Post-merge, `content.length` after the
   shared policy (`src/tools/runtime.ts:228`).
2. **Two additional caps.** The shared policy applies `MODEL_MAX_LINES` and
   `MODEL_MAX_LINE_CHARS` as well as the byte ceiling, so a body can now be
   shortened by a cap that did not exist before.
3. **The marker is inside the measurement.** A truncated result carries the
   spill marker within the returned content, so those bytes are counted in
   `resultBytes` — the field measures delivered content, not surviving payload.

**And the field has never measured bytes.** It is `String#length`, i.e. UTF-16
code units, under both regimes — a multi-byte result under-reports against its
own name. `resultBytesPreTruncation` (`src/tools/tool-audit.ts:52`) carries the
pre-policy size and shares the unit. Renaming is out of scope here; the v1
comment states the unit so a reader does not assume otherwise.

## 5. Verification

1. A run produces `tool-audit` files whose every call record carries `callId`,
   `scopeId`, `turnId`, `roundTrips` and `toolCallId`, and whose header carries
   `runId`, `schemaVersion`, `featureName`, `storyId` and `sessionRole`.
2. Every `turnId` in a run's `tool-audit` files matches a `turnId` on exactly
   one cost row of the same `runId` — the join that does not exist today.
3. Every `callId` in a run's `tool-audit` files appears on at least one cost row
   of the same `runId`. (At least, not exactly: `callId` is 1:N.)
4. `protocolIds.turnId` is non-null on every emitted `SessionTurnDispatchEvent`.
5. A guard covers correlation-id and `protocolIds` forwarding and fails against
   an emitter that drops either.

   Note: #1907's "canary guard" could not be found in the tree on 2026-09-20 —
   that issue's *fix* shipped (`src/runtime/middleware/review-audit.ts:70`) but
   no field-forwarding guard exists, and none of the 28 `scripts/check-*`
   guards is one. So this criterion means write the guard, not extend it, and
   wire it into `check:all`.
6. The `tool-audit` schema comment documents v1 and names the `resultBytes`
   denominator change at the `native-loop-events` boundary — all three shifts
   listed in §4, and the UTF-16-code-unit measurement.

Verification is against real run artifacts, not fixtures. The existing
`tool-audit` tests write and read their own fixtures and would pass against a
sink that never receives a `runId`.

## 6. Risk

**`tool-audit` has no production reader.** Nothing in `src/commands/`,
`src/plugins/builtin/curator/` or `scripts/` reads it back;
`scripts/analyze-rtk-savings.ts:8` notes the ledger is not retained. The only
consumers are humans reading JSON and external analysis scripts. Blast radius
inside the repo is tests only — which argues for doing this properly now rather
than minimally, since there is no migration to coordinate.

The corresponding risk is that a schema with no reader drifts unnoticed. The
`schemaVersion` constant and the canary-guard extension in §5 are what hold it.

## 7. Open

- **Which of `callId` or `recordId` survives.** `cost` uses `callId` (79.6%),
  `prompt-audit` uses `recordId` (79.9%). They are different namespaces and
  neither sink carries the other's. Either works; both surviving is what
  forces every reader to learn two. Renaming one is cheaper than that, and this
  spec does not decide which.
- ~~**Whether `turnId` should be minted or derived.**~~ **RESOLVED 2026-09-20:
  minted.** See §8.
- **Whether `session-run-hop` and `build-hop-callback` should stop being two
  implementations.** They carry three separate "the two must not drift" comments
  (`session-run-hop.ts:44`, `:100`; `build-hop-callback.ts:506`) and have
  drifted anyway (#2156). Out of scope here; worth its own decision.

## 8. Resolution — `turnId` is minted, and prompt-audit copies it

§7 asked whether `turnId` should be a random id or a derivation from
`(recordId, ordinal)`, the latter being attractive because it would also make
cost rows joinable to prompt-audit's existing `turn` ordinal.

**The derivation is not available, for three independent reasons. Measured
2026-09-20 against the live store (2,960 run-type prompt-audit rows).**

**1. `(recordId, turn)` is not unique — it is the strongest argument and it is
empirical.**

| key | distinct | collisions |
|---|---:|---|
| `recordId` | 1,927 | 37 span more than one `runId` (1.9%), worst 4 |
| `(recordId, turn)` | 2,169 | **404 occur more than once (18.6%), worst 9** |

`turnId` exists to satisfy §5 criterion 2 — every `turnId` matches **exactly
one** cost row. A key that repeats on 18.6% of the corpus does not do that. The
repeats are re-runs: `recordId` is reused and the ordinal restarts at 1, so the
pair recurs. Qualifying it as `(runId, recordId, turn)` restores uniqueness, but
at that point the id is unique only in composite while a minted id is unique on
its own — the derivation has bought nothing and costs the two problems below.

**2. On native, `recordId` is the value §1.4 already disqualified.**
`src/agents/native/session/session.ts:162` sets
`protocolIds: { recordId: nativeSessionId(name), sessionId: nativeSessionId(name) }`
— both are `sha256(sessionName).slice(0,32)`. §1.4 rejected `sessionId` as a key
precisely because it is a pure function of a label that is stable across re-runs.
Deriving `turnId` from `recordId` re-admits that defect through the other name.

**3. The ordinal is unreachable, and copying it re-creates this spec's own
defect class.** The counter is `PromptAuditor._turnOrdinals`
(`src/runtime/prompt-auditor.ts:227`, `_nextTurn` at `:236-241`) — a **private,
in-memory** `Map` on a per-run instance, keyed `recordId ?? sessionName ?? ""`,
incremented inside `record()`. `runAsSession`, where §2.1 requires the id to be
minted (before `sendPrompt`), cannot see it. Reproducing it means a second
counter that must match the first exactly, including its three-way key fallback
and its behaviour when a turn fails before it is recorded. That is a
"the two must not drift" surface — the very shape §1.1 documents six passes of,
and §7 already names three existing instances of.

### 8.1 The derivation's benefit is obtainable without the derivation

The only thing the derivation bought was a cost ↔ prompt-audit join. That is
available directly, because **both sinks are built from the same event**:
`attachCostSubscriber` and `attachAuditSubscriber`
(`src/runtime/middleware/cost.ts`, `src/runtime/middleware/audit.ts:5-30`) are
two subscribers on one `IDispatchEventBus`, and the audit entry **already**
copies `event.protocolIds.recordId` and `.sessionId` inside its
`event.kind === "session-turn" && { … }` block.

So once Task 5 stamps `protocolIds.turnId` on the event, prompt-audit copies it
in that same block:

```ts
      ...(event.kind === "session-turn" && {
        sessionId: event.protocolIds.sessionId ?? null,
        recordId: event.protocolIds.recordId ?? null,
        turnId: event.protocolIds.turnId ?? null,   // ← added
        …
      }),
```

**Decision: mint via `newCorrelationId()`, and copy the minted `turnId` onto the
prompt-audit entry.** One value, now four consumers — the cost row, the
`tool-audit` record, the dispatch event, and the prompt-audit row — joining
exactly rather than by a reconstructed ordinal. This is strictly better than the
derivation on every count: it is 1:1 rather than ordinal-matched, it does not
inherit `recordId`'s collisions, it needs no second counter, and it works on ACP,
where `recordId` is the provider's volatile session id.

The existing prompt-audit `turn` ordinal is **not** removed. It remains a useful
within-session position, and it keeps working for the pre-`turnId` history that
will never carry the new field.
