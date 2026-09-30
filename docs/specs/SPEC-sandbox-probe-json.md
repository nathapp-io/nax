# SPEC: `nax sandbox probe [--json]`

## Summary

Add a `nax sandbox probe` command that reports whether this machine can enforce the OS sandbox nax wraps agent-authored commands in. It creates a fresh srt backend with the default (open) network setting, runs the existing `probeSandbox()` once, resets the backend, and prints the verdict: one human line by default, or one JSON document with `--json`. It exits 0 when the sandbox is available and 1 when it is not. It reads no project or profile config: the answer is a property of the machine, not of a config.

## Motivation

An external orchestrator that dispatches `nax run --profile <chain>` onto several machines must know, before it dispatches, whether a machine can run a chain that needs the sandbox. `nax config --profile <chain> --json` (#2296) already answers whether a chain needs it (`requirements.sandbox`). Nothing answers whether the machine can provide it.

- The only probe is `probeSandbox(backend)` (`src/sandbox/probe.ts:27`), reached at run time through `probeSandboxOnce` in the sandbox registry. It is not exposed on any CLI command.
- A caller outside nax would have to re-implement it, and would get it wrong in the way the probe exists to avoid: in stock Docker `bwrap` is installed and every wrapped command fails, and a sandbox that runs a command but does not enforce a write deny must count as absent. Only running one wrapped command and checking both markers tells the two apart.

## Design

### Approach

A new handler `sandboxProbeCommand(options)` in `src/cli/sandbox-probe.ts`, following the `auth list` pattern: the handler returns an exit code, and `bin/nax.ts` passes it to `process.exit`.

1. `backend = _sandboxProbeCmdDeps.createBackend(DEFAULT_SANDBOX_CONFIG.network)`.
2. `result = await _sandboxProbeCmdDeps.probe(backend)`. A rejection becomes `{ available: false, reason: "sandbox probe failed: <message>" }`, the same wording the registry uses today.
3. `await backend.reset()` in a `finally`. A rejection from `reset()` is ignored: the probe verdict is already decided and the process exits next.
4. Build a `SandboxProbeReport` and print it through `_sandboxProbeCmdDeps.log`, as one JSON string or one text line.
5. Return `0` when `available` is `true`, `1` otherwise.

The handler deliberately does not use the registry (`probeSandboxOnce` / `sandboxBackendFor` / `resetSandboxBackend`). The registry caches one probe per process and writes to the run logger, and neither applies to a one-shot command.

### CLI behaviour

`nax sandbox probe [--json]`

- `bin/nax.ts` registers a `sandbox` command group (`program.command("sandbox").description("Inspect the OS sandbox for agent commands")`) with one subcommand, `probe`, carrying `.option("--json", "Emit machine-readable JSON to stdout", false)`, and calls `process.exit(await sandboxProbeCommand({ json: options.json }))`.
- It takes no `-d` and no `--profile`, and loads no config file.
- stdout carries exactly one `log` call: the JSON document in `--json` mode, the text line otherwise.
- Exit code: `0` when available, `1` when unavailable (JSON or text is printed in both cases).
- Text line, available: `Sandbox (srt, darwin): available`.
- Text line, unavailable: `Sandbox (srt, linux): unavailable: <reason>`.
- The probe's 30-second timeout (`PROBE_TIMEOUT_MS` in `src/sandbox/probe.ts`) bounds only the wrapped command. srt's platform check, `initialize()` and `reset()` have no timeout of their own, and the command adds none.

### Output format: `SandboxProbeReport`

```json
{
  "backend": "srt",
  "platform": "linux",
  "available": false,
  "reason": "sandbox could not run a command: bwrap: No permissions to create new namespace"
}
```

- `backend` — the probed backend's `name` (`"srt"`, the only `SandboxBackendName`).
- `platform` — `_sandboxProbeCmdDeps.platform()`, which is `process.platform` in production.
- `available` — `ProbeResult.available`.
- `reason` — present only when `available` is `false`; `ProbeResult.reason` verbatim.
- No timestamp: the consumer stamps its own probe time.
- The document is `JSON.stringify(report, null, 2)` with no ANSI codes.

```ts
// src/cli/sandbox-probe.ts
export interface SandboxProbeReport {
  backend: SandboxBackendName;
  platform: string;
  available: boolean;
  reason?: string;
}

export interface SandboxProbeOptions {
  json?: boolean;
}

export const _sandboxProbeCmdDeps: {
  log: (text: string) => void;
  platform: () => string;
  createBackend: (network: SandboxConfig["network"]) => SandboxBackend;
  probe: (backend: SandboxBackend) => Promise<ProbeResult>;
};

export async function sandboxProbeCommand(options?: SandboxProbeOptions): Promise<number>;
```

Production values: `log: (text) => console.log(text)` (the same CLI-output seam `_cliAuthDeps.log` uses), `platform: () => process.platform`, `createBackend: createSrtBackend`, `probe: probeSandbox`.

### Integration

Symbols this feature reads but does not change:

- `probeSandbox(backend: SandboxBackend): Promise<ProbeResult>` — `src/sandbox/probe.ts:27`, exported from `@/sandbox`.
- `createSrtBackend(network: SandboxConfig["network"]): SandboxBackend` — `src/sandbox/srt-backend.ts:51`, exported from `@/sandbox`. It loads srt lazily, so construction does not throw.
- `SandboxBackend` (`name`, `reset(): Promise<void>`), `SandboxBackendName`, `ProbeResult` — `src/sandbox/types.ts`, exported as types from `@/sandbox`.
- `DEFAULT_SANDBOX_CONFIG` and `SandboxConfig` — `src/config/schemas-sandbox.ts`, exported from `@/config`; `DEFAULT_SANDBOX_CONFIG.network` has no `allowedDomains` (open network).
- The registry's probe-failure wording, `sandbox probe failed: <message>` — `src/sandbox/registry.ts:38`.

Symbols this feature changes. The baseline exists only to locate the code; it is never the interface to implement.

**`src/cli/index.ts`** (the CLI barrel `bin/nax.ts` imports from)
- Target: also exports `sandboxProbeCommand`, `SandboxProbeReport` and `SandboxProbeOptions` from `./sandbox-probe`.

**`bin/nax.ts`** — command registration, next to the `auth` group (`bin/nax.ts:885-921`)
- Target: registers `nax sandbox probe [--json]` as described under CLI behaviour.

**`docs/guides/cli-reference.md`**
- Target: a `### \`nax sandbox probe\`` section after `### \`nax auth\``, giving the JSON shape, both text lines and the 0/1 exit codes.

### Failure Handling

| Failure | Behaviour |
|---|---|
| The platform is not one srt supports | `probeSandbox` returns `available: false` with its platform reason; report carries it; exit 1 |
| srt runs no command, or runs one but does not enforce the write deny | `probeSandbox` returns `available: false` with its reason; report carries it; exit 1 |
| `probe` rejects (for example srt fails to load) | report `available: false`, `reason` `sandbox probe failed: <message>`; exit 1 |
| `probe` rejects with a non-`Error` value | `reason` is `sandbox probe failed: ` followed by `String(value)`; exit 1 |
| `backend.reset()` rejects | ignored; the report and exit code are those of the probe result |

## Out of Scope

- A `--profile`, `-d` or config-driven probe: the command never reads `execution.sandbox` (including `enabled` and `network.allowedDomains`) from any config file, and always probes the default open-network srt backend.
- Probing whether srt's network proxy starts under a restricted `network.allowedDomains` list.
- Caching the probe result on disk or across invocations; every invocation probes afresh.
- A timeout around srt's platform check, `initialize()` or `reset()`; only the wrapped probe command is bounded, by `PROBE_TIMEOUT_MS`.
- Any change to `probeSandbox`, `probeSandboxOnce`, the sandbox registry or `createSrtBackend`.
- A timestamp field in the report; the consumer records when it probed.
- Any other `nax sandbox` subcommand.

## Stories

1. **US-001: `nax sandbox probe [--json]`** — no dependencies. `sandboxProbeCommand`, `SandboxProbeReport`, `SandboxProbeOptions` and `_sandboxProbeCmdDeps` in `src/cli/sandbox-probe.ts`, exported from `src/cli/index.ts`; the `sandbox probe` registration in `bin/nax.ts`; the `nax sandbox probe` section in `docs/guides/cli-reference.md`; one live case in `test/integration/sandbox/sandbox-live.test.ts` that spawns the real command.

### Context Files

**US-001**
- `src/sandbox/probe.ts` — `probeSandbox` and its `ProbeResult` reasons
- `src/sandbox/srt-backend.ts` — `createSrtBackend`, `reset()`
- `src/sandbox/registry.ts` — the `sandbox probe failed:` wording to match
- `src/cli/auth.ts` — `_cliAuthDeps.log` output seam and exit-code handler pattern to mirror
- `test/integration/sandbox/sandbox-live.test.ts` — live-suite gating (`describe.skipIf(!probe.available)`) the new live case joins

### Creates

**US-001**
- `src/cli/sandbox-probe.ts`
- `test/unit/cli/sandbox-probe.test.ts`

### Modifies

**US-001**
- `test/integration/sandbox/sandbox-live.test.ts` — gains the two live `nax sandbox probe` cases inside its existing `describe.skipIf(!probe.available)` block; no existing case or assertion in the file changes.

No existing assertion pins the CLI barrel's export list (`test/unit/cli/auth.test.ts` checks `typeof` per export, not set equality) or `bin/nax.ts`'s command set, so `src/cli/index.ts` and `bin/nax.ts` gain exports and a registration without breaking a test.

### Seams

- US-001 internal: `sandboxProbeCommand` is consumed by `bin/nax.ts`. The live AC enters at the real CLI entry point (`bun bin/nax.ts sandbox probe --json` in a subprocess), which proves the registration; the unit ACs enter at `sandboxProbeCommand` with `_sandboxProbeCmdDeps` stubbed.

## Acceptance Criteria

In every unit test `_sandboxProbeCmdDeps.log`, `platform`, `createBackend` and `probe` are replaced and restored after. The stub backend has `name` `"srt"` and a `reset` spy that resolves. Unit tests never load srt. "The document" means the single captured `log` string parsed as JSON.

### US-001: `nax sandbox probe [--json]`

- [unit] With `probe` stubbed to resolve `{ available: true }` and `platform` stubbed to return `"darwin"`, the document printed by `sandboxProbeCommand({ json: true })` deep-equals `{ backend: "srt", platform: "darwin", available: true }`.
- [unit] With `probe` stubbed to resolve `{ available: true }`, `sandboxProbeCommand({ json: true })` returns `0`.
- [unit] With `probe` stubbed to resolve `{ available: false, reason: "sandbox ran a command but did not enforce a write deny" }` and `platform` stubbed to return `"linux"`, the document printed by `sandboxProbeCommand({ json: true })` deep-equals `{ backend: "srt", platform: "linux", available: false, reason: "sandbox ran a command but did not enforce a write deny" }`.
- [unit] With `probe` stubbed to resolve `{ available: false, reason: "x" }`, `sandboxProbeCommand({ json: true })` returns `1`.
- [unit] With `probe` stubbed to reject with `new Error("module not found")`, the document printed by `sandboxProbeCommand({ json: true })` has `available` `false` and `reason` `"sandbox probe failed: module not found"`.
- [unit] With `probe` stubbed to reject with `new Error("module not found")`, `sandboxProbeCommand({ json: true })` returns `1`.
- [unit] With `probe` stubbed to reject with the string `"boom"`, the document printed by `sandboxProbeCommand({ json: true })` has `reason` `"sandbox probe failed: boom"`.
- [unit] `sandboxProbeCommand({ json: true })` calls `_sandboxProbeCmdDeps.createBackend` exactly once, with an argument deep-equal to `DEFAULT_SANDBOX_CONFIG.network`.
- [unit] `sandboxProbeCommand({ json: true })` calls `_sandboxProbeCmdDeps.probe` exactly once, with the backend object `createBackend` returned.
- [unit] With `probe` stubbed to resolve `{ available: true }`, `sandboxProbeCommand({ json: true })` calls the backend's `reset` exactly once.
- [unit] With `probe` stubbed to reject, `sandboxProbeCommand({ json: true })` calls the backend's `reset` exactly once.
- [unit] With `probe` stubbed to resolve `{ available: true }` and the backend's `reset` rejecting with `new Error("reset failed")`, `sandboxProbeCommand({ json: true })` returns `0`.
- [unit] With `probe` stubbed to resolve `{ available: true }` and the backend's `reset` rejecting with `new Error("reset failed")`, the document printed by `sandboxProbeCommand({ json: true })` has `available` `true`.
- [unit] With `probe` stubbed to resolve `{ available: false, reason: "x" }`, `sandboxProbeCommand({ json: true })` calls `_sandboxProbeCmdDeps.log` exactly once.
- [unit] With `probe` stubbed to resolve `{ available: false, reason: "x" }`, the string `sandboxProbeCommand({ json: true })` logs contains no ESC (`\u001b`) character.
- [unit] With `probe` stubbed to resolve `{ available: true }` and `platform` stubbed to return `"darwin"`, `sandboxProbeCommand({})` logs exactly `Sandbox (srt, darwin): available`.
- [unit] With `probe` stubbed to resolve `{ available: false, reason: "no bwrap" }` and `platform` stubbed to return `"linux"`, `sandboxProbeCommand({})` logs exactly `Sandbox (srt, linux): unavailable: no bwrap`.
- [unit] With `probe` stubbed to resolve `{ available: false, reason: "no bwrap" }`, `sandboxProbeCommand({})` returns `1`.
- [unit] With `probe` stubbed to resolve `{ available: false, reason: "no bwrap" }`, `sandboxProbeCommand({})` calls `_sandboxProbeCmdDeps.log` exactly once.
- [unit] `sandboxProbeCommand` is importable from `@/cli` and, with `probe` stubbed to resolve `{ available: true }`, called with no argument returns `0`.
- [integration] In the live sandbox suite, where the suite's own probe reports the sandbox available, spawning `bun bin/nax.ts sandbox probe --json` from the repository root exits with code `0`.
- [integration] In the live sandbox suite, where the suite's own probe reports the sandbox available, the stdout of `bun bin/nax.ts sandbox probe --json` parses as JSON with `available` `true` and `backend` `"srt"`.

Both live cases sit inside the existing `describe.skipIf(!probe.available)` block, may share one spawn of the command, and each passes an explicit test timeout of 60_000 ms (a cold `bun` start plus the srt probe exceeds the 5-second default).

Verification note: the `nax sandbox probe` section in `docs/guides/cli-reference.md` is documentation with no test. The live cases run in a subprocess because srt's `SandboxManager` is one per process and `bun test` shares one process across files; an in-process call would reset the live suite's backend.
