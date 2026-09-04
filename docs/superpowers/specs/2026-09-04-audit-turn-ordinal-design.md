# Prompt-audit turn identity — design

Date: 2026-09-04
Issues: [#1824](https://github.com/nathapp-io/nax/issues/1824), [#1825](https://github.com/nathapp-io/nax/issues/1825)
Branch: `feat/audit-turn-ordinal`

## Problem

Two defects in the prompt-audit artifact, found by reading an ACP record and a native
record side by side. They are separate issues but one depends on the other, so they are
designed together.

### #1824 — `Turn:` is a count, and it collides

`manager-dispatch.ts` populates the audit's `turn` from `internalRoundTrips`:

```ts
    turn: result.internalRoundTrips ?? 1,
```

`internalRoundTrips` means different things per transport. On ACP
(`acp/adapter-output.ts`) it is `turnCount`, the number of `session.prompt()` calls —
each a complete delegated agent run. On native (`native/session/turn-loop.ts`) it is the
number of LLM completions, because nax owns the conversation loop there.

`prompt-auditor.ts` renders that number as `Turn:` and as the filename suffix `-tNN`.
Neither is a turn count in the sense the word implies, and because the number is a
per-call count rather than a position, **records collide**.

Observed in one native session, three records 1.2 seconds apart — a JSON parse-retry
chain — sharing one session name:

| Timestamp | Rendered | Suffix |
|---|---|---|
| `…:51.178` | `Turn: 4` | `-t04` |
| `…:52.342` | `Turn: 1` | `-t01` |
| `…:53.658` | `Turn: 1` | `-t01` |

Two files share `-t01`. They should read `t01, t02, t03`.

The same defect exists on ACP and is worse there, because ACP's `turnCount` is almost
always 1. One observed ACP session has **four** records spanning 34 minutes, every one
of them `Turn: 1` and `-t01` — the suffix carries no information at all.

### #1825 — native records have no session id

`prompt-auditor.ts` renders `RecordId:` and `SessionId:` only when present. ACP records
carry both; native records carry neither, because `openNativeSession` returns a handle
without `protocolIds`, so `manager-dispatch.ts`'s
`handle.protocolIds?.sessionId ?? null` resolves to null.

Native nonetheless derives an id and sends it to the provider on every call:

```ts
    const sessionId = nativeSessionId(handle.id);
    // ...
          const res = await client.complete(resolved, { messages, /* … */ sessionId, signal });
```

`native/session-affinity.ts` documents that this value is destined for a vendor session
header on the wire. So nax transmits a session identifier on every native call and keeps
no record of what it sent. Confirming provider-side session behaviour currently requires
wire capture, because the value never reaches any run artifact.

The field's declaring comment in `PromptAuditEntry` calls these "ACP-specific session
correlation fields", which is the assumption that produced the gap.

## Evidence: `RecordId` is the conversation identity

Across an audit corpus of 3,383 records carrying ids, 18 have `RecordId` different from
`SessionId` — consistent with `runtime/protocol-types.ts`, which types `recordId` as the
stable logical record and `sessionId` as the volatile physical one that changes on
reconnect.

More decisively, one `RecordId` was observed spanning three records over 27 minutes and
a **stage change**:

| Time | Stage / suffix | `Turn:` |
|---|---|---|
| `02:21:19` | `run-t01` | 1 |
| `02:36:08` | `run-t02` | 2 |
| `02:48:13` | `rectification-t01` | 1 |

Same `RecordId`, same session name, three separate `sendTurn` calls. This shows two
things: ACP's `Turn:` is a per-call count (1, 2, 1) and not a position, and `RecordId`
is what actually asserts "this is one continuing conversation with the agent" — across
stages, across `sendTurn` boundaries, and independently of the display name.

## Goal

Make the audit's turn identity mean one thing on both transports, keyed on the identity
the protocol already provides, without losing the round-trip counts that the transports
legitimately differ on.

## Design

### 1. Native publishes a stable session identity (#1825)

`openNativeSession` sets `protocolIds` on the handle it returns:

```ts
  protocolIds: { recordId: nativeSessionId(name), sessionId: nativeSessionId(name) },
```

Both fields carry the same value. On ACP the two differ because a physical session can
be re-established under a stable logical record; native has no reconnect concept, so its
logical and physical identity genuinely coincide. Reporting the same value twice is the
honest encoding of that, and it lets native participate in anything keyed on either
field without a special case.

`nativeSessionId` is a pure SHA-256 hash of the session name, and its own documentation
states it is deliberately not memoised because it is already stable for a given session.
Computing it at open time therefore yields exactly the value `sendTurn` later sends —
no new state, and no possibility of the two drifting.

The `PromptAuditEntry` comment describing these as "ACP-specific" is corrected: they are
session-correlation fields, populated by any transport that has a session identity.

This alone makes `RecordId:` and `SessionId:` appear in native audit headers, closing the
"unverifiable from our own artifacts" gap on vendor session headers.

### 2. `Turn:` becomes an ordinal keyed on `RecordId` (#1824)

`Turn:` becomes the position of this turn within one logical conversation — 1, 2, 3 —
on both transports. The filename suffix `-tNN` carries the same ordinal, so the records
in a session sort and read in order and no longer collide.

The counter lives in `PromptAuditor` as a `Map<string, number>`, incremented once per
recorded `run` entry. That is the right home: the auditor already receives every audit
record, the ordinal is purely a reporting concern, and a `PromptAuditor` instance is
constructed per run, so the map's lifetime matches the numbering's scope with no
cleanup.

**The key is `recordId`, falling back to `sessionName` when it is absent.** After part 1
neither transport should reach the fallback, but an adapter that publishes no session
identity must still get sequential numbering rather than a crash or a constant.

**The ordinal deliberately does not reset per stage.** When `run` and `rectification`
share a `RecordId`, the ACP session is being reused and the agent's context still holds
the earlier turns; restarting at 1 would assert a fresh conversation that did not
happen. The scheme also self-corrects: if a fresh session *is* opened, its `RecordId`
differs, the counter keys on a new value, and numbering restarts automatically. The
number therefore restarts if and only if the conversation actually restarted — a
distinction a per-stage reset cannot express. The stage remains in the filename, so no
information is lost.

### 3. The round-trip counts move to labels that name their unit

`internalRoundTrips` is still worth reporting; it was only ever in the wrong field.
Each transport renders it under a label that states what it counts:

- native: `ModelCalls: 4`
- ACP: `AgentRuns: 1`

Distinct names make the invalid cross-transport comparison unexpressible rather than
merely discouraged: a reader cannot line up an ACP `1` against a native `8` when the
fields are not the same field.

A native record therefore reads:

```
Turn:       2
ModelCalls: 4
RecordId:   <32 hex chars>
SessionId:  <32 hex chars>
```

The label is chosen by the producer, not the renderer. `manager-dispatch.ts` already
knows the agent and already assembles this entry; having `prompt-auditor.ts` branch on
transport would push transport knowledge into a component that has none today. The
entry gains an optional field naming the round-trip unit, and the renderer prints
whatever it is given.

`manager-dispatch.ts` also gains the remark this design turns on: `internalRoundTrips`
counts a delegated agent run on ACP and a single model call on native, which is why the
transports render different labels.

## Stories

| # | Story | Depends on |
|---|---|---|
| S1 | `openNativeSession` publishes `protocolIds`; correct the "ACP-specific" comment | — |
| S2 | `PromptAuditor` assigns a per-`recordId` ordinal; `Turn:` and `-tNN` use it | S1 |
| S3 | Producer supplies the round-trip label; render `ModelCalls:` / `AgentRuns:` | S2 |

S1 first: without a native `recordId`, S2's ordinal would key every native record on the
session-name fallback, which would pass its tests while exercising the wrong path.

## Verification

Each behavioural claim needs a gate, and each gate is verified by reintroducing the
defect and confirming failure.

- **S1** — a native handle carries `protocolIds.recordId === nativeSessionId(name)`, and
  a native audit header emits `RecordId:` and `SessionId:`. Reintroduce by returning the
  bare handle; the header lines must vanish.
- **S2** — three entries sharing one `recordId` render `Turn: 1/2/3` with suffixes
  `t01/t02/t03`. Reintroduce by keying the counter on `sessionName`, then feed two
  entries that share a `recordId` but differ in `sessionName`: correct behaviour numbers
  them 1 and 2, the reintroduced defect numbers both 1. A test using a single session
  name would pass under both and prove nothing.
- **S2 (no reset)** — two entries sharing a `recordId` but differing in `stage` number
  1 and 2, not 1 and 1.
- **S2 (fallback)** — entries with no `recordId` still number sequentially by
  `sessionName`.
- **S3** — a native entry renders `ModelCalls:` and no `AgentRuns:`; an ACP entry the
  reverse.

Live check after merge: a native run's audit directory should contain no two files
sharing a suffix within one session, and native headers should carry `SessionId:`.

## Risks

1. **The filename format changes on both transports.** `-tNN` now carries an ordinal
   rather than a round-trip count. Anything grepping `-t10` to find round-trip-capped
   calls breaks — but that grep is already obsolete, since #1823 removed the cap it
   detected. No other consumer of the suffix is known.
2. **`Turn:` changes meaning on ACP**, which is the incumbent transport. The number was
   not previously an ordinal, so existing ACP records are not comparable to new ones.
   Accepted: leaving ACP alone would keep one field carrying two meanings, which is the
   defect itself, and the four-records-all-`t01` case shows the current value is
   near-useless there.
3. **The ordinal is per `PromptAuditor` instance**, so it restarts if a run is resumed
   into a new runtime. That matches the audit directory's own per-run scope and is not
   worth cross-run persistence.

## Out of scope

- Renaming `maxTurns`, which is the misnomer in the *code* that produced #1820. It is
  the same confusion, but it is an adapter-contract change rather than an artifact
  change, and mixing them would put an API rename inside an observability fix.
- The sessionless `complete()` path, which derives its own id from a per-adapter
  one-shot key and audits as `callType: "complete"`. It could surface the same fields;
  it is a distinct call shape and not required to close either issue.
- Persisting or aggregating the round-trip counts anywhere beyond the audit record.
