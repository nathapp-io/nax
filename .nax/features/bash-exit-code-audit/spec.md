# SPEC: Bash exit code on tool-audit rows (nax#2227)

## Summary

Every Bash tool-audit row gains an optional `exitCode` field: the exit code of the shell process,
recorded when the process exited on its own. The model-facing result does not change: `isError`,
the `exit N` body and the ledger `outcome` keep their current values. Only the durable audit row
gains the number, so telemetry can tell a negative answer (`grep` with no match exits 1) from a real failure.

## Motivation

Verified on `main` @ `f801016f5`. The Bash tool (`src/tools/bash.ts`) sets
`isError: launched.timedOut || launched.exitCode !== 0 || launched.aborted === true`, and
`runtime.callTool` (`src/tools/runtime.ts`) maps `isError` to the ledger outcome `"error"`. A
`grep` that finds nothing exits 1, as do `diff` when inputs differ and `test` when the condition is false.
Each one is recorded as `outcome: "error"`, exactly like a crashed command.

Measured on four canary.19 feature runs (2026-09-24): 15 of 35 Bash `error` rows (43%) were a
`grep` with no match, whose whole result was `exit 1`. The exit code is in the model-facing body
text, but `ToolCallRecord` (`src/tools/tool-audit.ts`) carries only `resultBytes`. Analysis
therefore has to guess from byte counts, and the Bash error rate is roughly doubled.

## Design

### Integration

Symbols this feature **reads** (unchanged):

- `runArgv` result (`src/utils/argv-exec.ts`): `exitCode: number`, `timedOut: boolean`, `aborted?: boolean`. An already-aborted signal resolves with `exitCode: -1` and `aborted: true`.
- `CommandLauncher.run` → `LaunchResult` (`src/sandbox/types.ts`): carries the same `exitCode` / `timedOut` / `aborted` plus `executed` and `sandbox`.
- `_bashToolDeps.runArgv` (`src/tools/bash.ts`): the test seam used when no launcher is passed.
- `createCodingToolRuntime` and `compileToolPolicy` (`src/tools`): `runtimeFor` in `test/unit/tools/runtime-sandbox-audit.test.ts` is the fixture to mirror.

Symbols this feature **changes**. The baseline exists only to locate the code; it is never the interface to implement.

- `ToolResult.audit` (`src/tools/registry.ts`)
  - Baseline: `{ executed; target?; sandbox? }`
  - Target: `{ executed; target?; sandbox?; exitCode? }`. The new field is `readonly exitCode?: number` and is set only by the Bash tool.
- `ToolCallRecord` (`src/tools/tool-audit.ts`)
  - Target: gains `readonly exitCode?: number`. Additive and optional, so `TOOL_AUDIT_SCHEMA_VERSION` stays `1`, as it did for `sandbox`.
- The runtime's internal `log(...)` audit parameter (`src/tools/runtime.ts`)
  - Target: accepts `exitCode?: number` and spreads it onto the `sink.record(...)` row only when defined. This is the same conditional-spread idiom used for `executed`, `target`, `approval` and `sandbox`.
- `createBashTool(...).run` (`src/tools/bash.ts`)
  - Target: the success return's `audit` object literal gains `exitCode: launched.exitCode` by conditional spread, the same idiom as `sandbox` in that literal. It is spread when neither `launched.timedOut` nor `launched.aborted === true`, and that includes the `orphansKilled` case. Otherwise the audit has no `exitCode` key.

`isError`, the result `content`, and the ledger `outcome` (`"ok" | "error" | "denied" | "denied:ask"`) are unchanged.

### Failure Handling

| Condition | Behavior |
|:--|:--|
| Command timed out (`timedOut: true`) | Audit has no `exitCode` key; `isError` stays `true` |
| Command aborted by the turn signal (`aborted: true`) | Audit has no `exitCode` key; `isError` stays `true` |
| Bash tool throws before a process result exists (catch path, e.g. sandbox wrap failure) | Unchanged: no `audit`, so the row has no `exitCode` |
| Call denied by policy (`denied`) | Row has no `exitCode` (the tool never ran) |
| Background processes killed after exit (`orphansKilled: true`) | Audit carries `exitCode` (the shell itself exited) |
| Any non-Bash tool | Row has no `exitCode` key |

## Out of Scope

- Changing `isError`, the model-facing result text, or the ledger `outcome` values. A negative answer stays `outcome: "error"`, and consumers read `exitCode` to tell the two apart.
- Adding a new `outcome` value such as `"no-match"` or `"nonzero"`.
- Recording exit codes for `RunCommand` or its `Exec` argv branch.
- Recording `exitCode` on command-safety shadow rows.
- Bumping `TOOL_AUDIT_SCHEMA_VERSION`.
- Any report, CLI or analytics reader of the new field.
- `denied:ask` rows are not separately tested: an ask-denied call never runs the tool, so it never carries a tool `audit`.

## Stories

**US-001 — Bash tool-audit rows record the process exit code**
Add optional `exitCode` to `ToolResult.audit` and `ToolCallRecord`. Have the Bash tool set it from
the launched process when the process exited on its own, and have the runtime copy it onto the
tool-audit row only when defined. No dependencies.

### Context Files

**US-001**

- `src/tools/bash.ts` — `createBashTool` `run`, the success return that builds `audit`, and `_bashToolDeps`
- `src/tools/runtime.ts` — `log(...)` and the `sink.record(...)` conditional spreads, plus `runTool`'s `result.audit` pass-through
- `src/tools/tool-audit.ts` — `ToolCallRecord` and the `sandbox` docblock (the additive-field precedent)
- `src/tools/registry.ts` — `ToolResult.audit`
- `test/unit/tools/runtime-sandbox-audit.test.ts` — the `runtimeFor` recording-sink fixture to mirror

### Creates

**US-001**

- `test/unit/tools/bash-exit-code-audit.test.ts` — Bash tool `audit.exitCode` on exit, timeout, abort, orphans-killed and the catch path, via `_bashToolDeps.runArgv` and a fake launcher. Save the real `_bashToolDeps.runArgv` and restore it in `afterEach`, as `test/unit/tools/after-tool-truncation.test.ts` does
- `test/unit/tools/runtime-exit-code-audit.test.ts` — the runtime copies `audit.exitCode` onto the tool-audit row, the seam through `createBashTool()`, and the `createToolAuditSink` flush into a `makeTempDir()` directory. Restore `_bashToolDeps.runArgv` in `afterEach`

### Modifies

**US-001**

- `test/unit/tools/bash-sandbox.test.ts` — the exact-equality assertion on `r.audit` in "run: goes through the launcher and carries the sandbox record on audit" gains `exitCode: 0` for the `echo hi` call; `executed` and `sandbox` stay exactly as asserted.

`test/unit/tools/runtime.test.ts` is past the 650-line split target in `.nax/rules/test-architecture.md`, so it must not grow. New tests go in the created files.

### Seams

- `[unit]` The Bash tool's `audit.exitCode` reaches the ledger through the runtime. Build a runtime whose policy grants `Bash` with pattern `*` and whose tool list includes `createBashTool()`, stub `_bashToolDeps.runArgv` to resolve `exitCode: 1` with empty stdout and stderr, then call `callTool("Bash", { command: "rg nomatch src" })`. The recording sink's row must carry `exitCode: 1` and `outcome: "error"`.

## Acceptance Criteria

### US-001 — Bash tool-audit rows record the process exit code

- `[unit]` `createBashTool().run({ command: "rg nomatch src" }, ctx)` with `_bashToolDeps.runArgv` stubbed to resolve `exitCode: 1`, empty `stdout` and `stderr`, `timedOut: false` returns a result whose `audit.exitCode` is `1`.
- `[unit]` That same call returns `isError: true` and `content` beginning with `exit 1`, both unchanged by this feature.
- `[unit]` `createBashTool().run({ command: "echo hi" }, ctx)` with `runArgv` stubbed to resolve `exitCode: 0` returns `audit.exitCode` `0` and `isError: false`.
- `[unit]` `createBashTool().run(...)` with `runArgv` stubbed to resolve `exitCode: 2` returns `audit.exitCode` `2`.
- `[unit]` `createBashTool().run(...)` with `runArgv` stubbed to resolve `timedOut: true` and `exitCode: 143` returns an `audit` that has no `exitCode` key (checked with `in`) and `isError: true`.
- `[unit]` `createBashTool().run(...)` with `runArgv` stubbed to resolve `aborted: true` and `exitCode: -1` returns an `audit` that has no `exitCode` key (checked with `in`) and `isError: true`.
- `[unit]` `createBashTool().run(...)` with `runArgv` stubbed to resolve `exitCode: 0` and `orphansKilled: true` returns `audit.exitCode` `0`.
- `[unit]` `createBashTool({ launcher })`, where the fake launcher has `state: { kind: "disabled" }` and its `run` rejects with an `Error`, returns `isError: true` and a result with no `audit` key (checked with `in`).
- `[unit]` `createBashTool({ launcher })`, where the fake launcher has `state: { kind: "disabled" }` and its `run` resolves `exitCode: 1`, `stdout: ""`, `stderr: ""`, `timedOut: false`, `executed: ["/bin/sh", "-c", "false"]` and `sandbox: { backend: "none", wrapped: false }`, returns `audit` equal to `{ executed: ["/bin/sh", "-c", "false"], sandbox: { backend: "none", wrapped: false }, exitCode: 1 }`.
- `[unit]` `createCodingToolRuntime` with a recording sink and a tool whose `run` returns `{ content: "exit 1", isError: true, audit: { executed: ["x"], exitCode: 1 } }` records a row with `exitCode` `1`, `outcome` `"error"` and `executed` `["x"]`.
- `[unit]` That runtime, given a tool whose `run` returns `{ content: "ok", audit: { executed: ["x"], exitCode: 0 } }`, records a row with `exitCode` `0` and `outcome` `"ok"`.
- `[unit]` That runtime, given a tool whose `run` returns `{ content: "ok" }` with no `audit`, records a row that has no `exitCode` key (checked with `in`).
- `[unit]` A runtime built with `compileToolPolicy([], root)` and `extraTools: [createBashTool()]`, called with `callTool("Bash", { command: "echo hi" })`, records a `denied` row that has no `exitCode` key (checked with `in`).
- `[unit]` A runtime whose policy grants `Bash` with pattern `*`, with `createBashTool()` in its tool list and `_bashToolDeps.runArgv` stubbed to resolve `exitCode: 1` with empty output, records a row with `exitCode: 1` and `outcome: "error"` for `callTool("Bash", { command: "rg nomatch src" })`.
- `[unit]` A sink from `createToolAuditSink`, given a record with `exitCode: 1`, flushes a JSON file whose `calls[0].exitCode` is `1`.
