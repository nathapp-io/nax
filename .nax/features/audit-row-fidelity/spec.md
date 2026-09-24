# SPEC: Audit row fidelity — shadow and tool-audit rows record what actually ran

## Summary

Three row-fidelity gaps from the P0-P5 cross-phase review close with additive fields only; no
existing field changes meaning and no verdict, prompt or classification changes. Command-safety
shadow rows gain the call identifiers tool-audit already records, so a shadow row joins its
tool-audit row exactly (review #12). A wrapped sandbox call's tool-audit row gains the argv the
sandbox actually executed, beside the unchanged logical `executed` (review #13). An Exec shadow row
gains the normalized argv the Exec tool actually executed, beside the unchanged model argv it
classified (review #15).

## Motivation

Verified on `main` @ `866a90066`:

**Shadow rows cannot be joined to tool-audit (review #12, MEDIUM).** `CommandSafetyRow`
(`src/command-safety/types.ts`) has no call identifier. `runtime.callTool`
(`src/tools/runtime.ts`) opens the shadow tap with a throwaway `randomUUID()` key used only to pair
observe with settle, while the same call's tool-audit record (`ToolCallRecord`,
`src/tools/tool-audit.ts`) carries `callId` and `scopeId` (from the runtime options) and `turnId`,
`roundTrips` and `toolCallId` (from the `ToolCallContext`). All five are in scope where the tap is
opened. Joining the P5 corpus to tool-audit today relies on command text and timestamps.

**tool-audit never records the sandbox argv (review #13, MEDIUM).** `runWrapped`
(`src/sandbox/launcher.ts`) runs the argv `backend.wrap(...)` returns, then drops it and returns
`executed: logicalArgv(req)`. `executed` is deliberately the logical argv (`LaunchResult` docblock)
and stays so. What is missing is a record of the wrapper argv that ran.

**The Exec shadow row omits the executed argv (review #15, LOW).** `toObservation`
(`src/command-safety/tap.ts`) records the model's `argv` and classifies it joined with spaces. The
Exec tool (`src/tools/run-command-exec.ts`) runs `normalizeExec(...)`'s argv instead (workspace
scoping flags, no-scripts flag). Classification starts at observe time, before normalization runs,
and must stay on the string the policy screened (the arc's byte-identity invariant: what the policy
checks, the human approves and the shadow classifies is one string). The row should still record
what ran. `logCall` already carries it: the tool's `result.audit.executed` is `logCall`'s ninth
argument, and every settle goes through `logCall`.

## Design

### Shadow call identifiers (US-001)

`ShadowCall` (`src/command-safety/tap.ts`), `Observation` and `CommandSafetyRow`
(`src/command-safety/types.ts`) each gain the same five optional fields:

```ts
readonly callId?: string;
readonly scopeId?: string;
readonly turnId?: string;
readonly roundTrips?: number;
readonly toolCallId?: string;
```

`runtime.callTool` passes `opts.callId`, `opts.scopeId`, `context?.turnId`,
`context?.roundTrips` and `context?.toolCallId` into `openShadowTap`, each only when defined (the
same conditional-spread idiom the tool-audit record uses). `toObservation` copies each defined field
onto the `Observation`, and `toRow` (`src/command-safety/shadow.ts`) copies each defined field onto
the row. An absent source value produces a row without the key, never `undefined`. The throwaway
tap `key` is unchanged. ACP calls carry no `toolCallId`; their rows join on `callId` + `turnId`.

### Sandbox argv on tool-audit (US-002)

`SandboxRecord` (`src/sandbox/types.ts`) gains:

```ts
/** Wrapped calls only: the argv the sandbox backend returned and runArgv executed. */
readonly argv?: readonly string[];
```

`runWrapped` sets `sandbox.argv` to the `argv` returned by `backend.wrap(...)`, the same array it
passes to `runArgv`. `runUnwrapped` (disabled and unavailable states) never sets it: there
`executed` is already what ran. `executed` keeps the logical argv on both paths. The Bash and Exec
tools already pass `launched.sandbox` into `ToolResult.audit.sandbox`, and `runtime.callTool`
spreads it into the tool-audit record, so no tool or runtime change is needed.

### Exec executed argv on shadow rows (US-003)

`FinalOutcome` (`src/command-safety/types.ts`) is not changed. `CommandShadow.settle` gains an
optional third argument and `CommandSafetyRow` gains one optional field:

```ts
// CommandShadow
settle(key: string, outcome: FinalOutcome, executed?: readonly string[]): void;
// CommandSafetyRow
/** Exec only: the argv the Exec tool executed (after normalization); absent when the call did not run. */
readonly executed?: readonly string[];
```

`ShadowTap.settle` gains a third optional `executed` argument. The tap forwards it to
`shadow.settle` only when the observation's identity is `Exec`; for a `Bash` observation it passes
nothing, so Bash rows never carry `executed` (their `executed` is `[shell, "-c", command]`, which
adds nothing). The shadow stores it on the entry and `toRow` writes it when defined. In
`runtime.callTool`, `logCall` passes `args[8]?.executed` as the third argument to `tap?.settle`.
`observe`, the classifier input, the cache key (`shadowCacheKey`), `command` and `argv` do not
change.

### Integration

| Surface | Change |
|:--|:--|
| `<outputDir>/command-safety/<runId>.jsonl` | optional `callId`, `scopeId`, `turnId`, `roundTrips`, `toolCallId` (US-001); optional `executed`, Exec rows only (US-003) |
| tool-audit JSONL | optional `sandbox.argv`, wrapped calls only (US-002) |
| classifier request, cache key, policy verdict, approval prompt | unchanged |

### Failure Handling

| Condition | Behavior |
|:--|:--|
| A call identifier is undefined at the tap | The row omits that key |
| `backend.wrap` throws | Unchanged: `SANDBOX_WRAP_FAILED`; no audit `sandbox.argv` |
| Exec call denied, or denied:ask | Row has no `executed` (the tool never ran) |
| Exec tool throws after normalization | Row has no `executed` (the error path carries no audit) |
| Row settled by `drain()` as `unsettled` | Row has no `executed` |
| Shadow `settle` throws | Unchanged: the tap swallows it; the call is unaffected |

## Out of Scope

- `executed` on tool-audit rows keeps its meaning (the logical argv); no field is renamed or re-typed.
- Classifying the normalized Exec argv instead of the model's argv is not done: it would split the policy/human/shadow byte-identity.
- Redacting or truncating the sandbox argv (review #9 is a separate ruling).
- Locking or bounding the command-safety / approval-audit JSONL (review #14).
- `nax` CLI readers or reports of the new fields.
- US-002 only: the Linux bwrap path is covered by the same `runWrapped` code; no Linux-specific test is added.

## Stories

**US-001 — Shadow rows carry the call identifiers (review #12)**
Add `callId`, `scopeId`, `turnId`, `roundTrips`, `toolCallId` to `ShadowCall`, `Observation` and
`CommandSafetyRow`; pass them from `runtime.callTool`; copy them through `toObservation` and
`toRow`. No dependencies.

**US-002 — tool-audit records the sandbox argv (review #13)**
Add optional `argv` to `SandboxRecord`, set it in `runWrapped` from the backend's wrapped argv, and
leave `executed` as the logical argv. No dependencies.

**US-003 — Exec shadow rows record the executed argv (review #15)**
Give `CommandShadow.settle` and `ShadowTap.settle` an optional `executed` argument, forward it for
Exec observations only, write it to `CommandSafetyRow.executed`, and pass
`args[8]?.executed` from `logCall`. Depends on US-001 (both edit the tap, the row type and the
runtime tap call site).

### Context Files

**US-001**

- `src/command-safety/tap.ts` — `ShadowCall`, `toObservation`, `openShadowTap`
- `src/command-safety/types.ts` — `Observation`, `CommandSafetyRow`
- `src/command-safety/shadow.ts` — `toRow`
- `src/tools/runtime.ts` — the `openShadowTap` call in `callTool` and the `sink.record` spread in `log` (the idiom to mirror)
- `src/tools/tool-audit.ts` — `ToolCallRecord` identifier fields and their docblocks

**US-002**

- `src/sandbox/launcher.ts` — `runWrapped`, `runUnwrapped`
- `src/sandbox/types.ts` — `SandboxRecord`, `LaunchResult`
- `test/unit/sandbox/launcher.test.ts` — the recording `_launcherDeps.runArgv` and fake backend to follow

**US-003**

- `src/command-safety/tap.ts` — `ShadowTap.settle`
- `src/command-safety/shadow.ts` — `settle`, `Entry`, `toRow`
- `src/command-safety/types.ts` — `CommandShadow`, `CommandSafetyRow`
- `src/tools/runtime.ts` — `logCall` and its `tap?.settle` call
- `src/tools/run-command-exec.ts` — where `audit.executed` is set to the normalized argv

### Creates

**US-001**

- `test/unit/command-safety/shadow-call-ids.test.ts` — tap and row identifier propagation
- `test/unit/tools/runtime-shadow-call-ids.test.ts` — runtime passes identifiers to the tap

**US-002**

- `test/unit/sandbox/launcher-sandbox-argv.test.ts` — `sandbox.argv` on wrapped and unwrapped paths

**US-003**

- `test/unit/command-safety/shadow-executed.test.ts` — tap forwarding and row `executed`
- `test/unit/tools/runtime-shadow-executed.test.ts` — runtime settles with the Exec tool's executed argv

### Modifies

**US-001**

- `test/unit/command-safety/tap.test.ts` — fixtures without identifiers must still produce observations without the identifier keys; existing assertions are unchanged.
- `test/unit/command-safety/shadow.test.ts` — fixtures without identifiers must still produce rows without the identifier keys; existing assertions are unchanged.

**US-002**

- `test/unit/sandbox/launcher.test.ts` — an exact-equality assertion over a wrapped `LaunchResult.sandbox` may gain `argv`; the invariant kept is that `executed` equals the logical argv on every path.
- `test/unit/tools/bash-sandbox.test.ts` — an exact-equality assertion over `audit.sandbox` for a wrapped call may gain `argv`; `executed` assertions are unchanged.
- `test/unit/tools/run-command-exec-sandbox.test.ts` — an exact-equality assertion over `audit.sandbox` for a wrapped call may gain `argv`; `executed` assertions are unchanged.

**US-003**

- `test/unit/tools/runtime-command-shadow.test.ts` — Bash settle assertions (`toEqual([[key, { ledger: "ok" }]])`) stay exactly as they are; the recorder's `settle` may accept a third argument.

`test/unit/tools/runtime.test.ts` (688 lines) is already past the 650-line split target in `.nax/rules/test-architecture.md` (800 is the hard limit), so it must not grow; new tests go in the created files.

### Seams

- `[unit]` US-003 consumes US-001's tap shape: open a tap via `openShadowTap` with a recording shadow for an `Exec` call carrying `toolCallId: "tc-1"`, settle it with `("ok", undefined, ["bun", "run", "x"])`, and assert the recording shadow's `observe` got `toolCallId: "tc-1"` and its `settle` got `["bun", "run", "x"]` as the third argument.

## Acceptance Criteria

### US-001 — Shadow rows carry the call identifiers (review #12)

- `[unit]` `openShadowTap` for a `Bash` call with `callId: "c1"`, `scopeId: "s1"`, `turnId: "t1"`, `roundTrips: 2`, `toolCallId: "tc1"` calls `observe` with an `Observation` carrying those five values.
- `[unit]` `openShadowTap` for an `Exec` call with the same five identifiers calls `observe` with an `Observation` carrying those five values.
- `[unit]` `openShadowTap` for a `Bash` call with no identifiers calls `observe` with an `Observation` that has none of the keys `callId`, `scopeId`, `turnId`, `roundTrips`, `toolCallId` (checked with `in`).
- `[unit]` a shadow created by `createCommandShadow` with a resolving `classify` and a recording `write`, after `observe` with an `Observation` carrying the five identifiers and `settle(key, { ledger: "ok" })`, writes one row carrying the same five values.
- `[unit]` that shadow, given an `Observation` with no identifiers, writes a row that has none of the five keys (checked with `in`).
- `[unit]` `runtime.callTool("Bash", …)` built with `callId: "c1"` and `scopeId: "s1"` in the runtime options, a recording `commandShadow`, and a `ToolCallContext` with `turnId: "t1"`, `roundTrips: 3`, `toolCallId: "tc1"` observes an `Observation` carrying `callId: "c1"`, `scopeId: "s1"`, `turnId: "t1"`, `roundTrips: 3`, `toolCallId: "tc1"`.
- `[unit]` in that same call, the tool-audit record written to the runtime's sink carries the same `callId`, `turnId` and `toolCallId` as the observation.
- `[unit]` `runtime.callTool("Bash", …)` with no `callId`/`scopeId` options and no context observes an `Observation` that has none of the five keys (checked with `in`).

**Out of scope:** changing the tap `key`.

### US-002 — tool-audit records the sandbox argv (review #13)

- `[unit]` `createCommandLauncher` in the available state, with a fake backend whose `wrap` resolves `["sandbox-exec", "-p", "PROFILE", "/bin/sh", "-c", "echo hi"]` and a recording `_launcherDeps.runArgv`, resolves a shell request `echo hi` with `sandbox.argv` equal to that wrapped array.
- `[unit]` in that same call, the recording `runArgv` received that same wrapped array as `argv`.
- `[unit]` in that same call, `executed` is `["/bin/sh", "-c", "echo hi"]` (the logical argv, for shell `/bin/sh`), unchanged by this feature.
- `[unit]` an available-state launcher given an argv request `["bun", "test"]` resolves with `executed` `["bun", "test"]` and `sandbox.argv` equal to the fake backend's wrapped array.
- `[unit]` a `disabled`-state launcher resolves with `sandbox` equal to `{ backend: "none", wrapped: false }` exactly (no `argv` key).
- `[unit]` an `unavailable`-state launcher resolves with a `sandbox` that has no `argv` key (checked with `in`).
- `[unit]` a wrapped launcher call whose `runArgv` exits non-zero with stderr matching the sandbox-denial pattern resolves with both `denialHint: true` and `sandbox.argv` set.
- `[unit]` `runtime.callTool` for a tool whose `run` returns `audit: { executed: ["x"], sandbox: { backend: "srt", wrapped: true, argv: ["w", "x"] } }` records a tool-audit row with `sandbox.argv` equal to `["w", "x"]` and `executed` equal to `["x"]`.

**Out of scope:** redacting or truncating the wrapped argv.

### US-003 — Exec shadow rows record the executed argv (review #15)

- `[unit]` a tap opened by `openShadowTap` for an `Exec` call, settled with `("ok", undefined, ["bun", "run", "--filter", "pkg", "test"])`, calls the shadow's `settle` with that array as its third argument.
- `[unit]` a tap opened for a `Bash` call, settled with `("ok", undefined, ["/bin/sh", "-c", "echo hi"])`, calls the shadow's `settle` with exactly two arguments.
- `[unit]` a shadow created by `createCommandShadow`, after `observe` of an Exec `Observation` with `argv: ["bun", "test"]` and `settle(key, { ledger: "ok" }, ["bun", "test", "--no-scripts"])`, writes a row whose `executed` is `["bun", "test", "--no-scripts"]` and whose `argv` is `["bun", "test"]` and `command` is `bun test`.
- `[unit]` that shadow's `classify` is called with `bun test` (the model argv joined), not the executed argv.
- `[unit]` a shadow settled with no third argument writes a row with no `executed` key (checked with `in`).
- `[unit]` a shadow whose entry is settled by `drain()` as `unsettled` writes a row with no `executed` key.
- `[unit]` `runtime.callTool` for the `Exec` identity via a coding tool whose `scope.argvField` is `argv`, whose `run` returns `audit: { executed: ["bun", "test", "--no-scripts"] }`, with a recording `commandShadow`, settles with `{ ledger: "ok" }` and third argument `["bun", "test", "--no-scripts"]`.
- `[unit]` `runtime.callTool` for an `Exec` call the policy denies settles with `{ ledger: "denied" }` and no third argument (or `undefined`).
- `[unit]` `runtime.callTool("Bash", { command: "echo hi" })` in `raw` mode with a recording `commandShadow` still settles with exactly `[key, { ledger: "ok" }]` and no third argument.

**Out of scope:** classifying the normalized argv.
