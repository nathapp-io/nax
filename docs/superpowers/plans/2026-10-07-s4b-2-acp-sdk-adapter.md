# S4b-2: ACP SDK Adapter Behind `agent.acp.transport` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a second ACP transport to `nax run`: `AcpSdkAgentAdapter` in `packages/nax/src/agents/acp-sdk/`, which drives agents through `acpBackend()` from `@nathapp/nax-agent-acp/client` instead of the `acpx` CLI. It is reachable only behind the new development key `agent.acp.transport: "sdk"`; the default stays `"acpx"`.

**Architecture:**
- nax depends on nax-agent-acp (bundled into `dist/nax.js`, like nax-agent) and may import only its `./client` entry.
- The registry picks the adapter per agent from `agent.acp.transport`.
- The new adapter opens one `acpBackend` session per nax session, keeps a live map from the nax handle id to it (routing only, never reuse), and runs nax's own turn loop around the backend's single-prompt `sendTurn`:
  - one deadline spanning the loop, with a timeout returning `TurnResult{ timedOut: true }`
  - the question and `<nax_tool_call>` interactions and the shared `maxInteractions` budget
  - mid-turn NO_SESSION recovery
  - spend summed across iterations, and carried on the thrown `SessionTurnError`
- A stream bridge turns the backend's turn events into the `AgentStreamEvent` sequence the idle watchdog reads today.
- `complete()`, the full failure table, `promptRetries`, the backend deadline options, tool-audit writes, effort and PID callbacks are S4b-3.

**Tech Stack:** TypeScript (ESM), Bun 1.4 (`bun:test`), Biome 2.5.10, `@nathapp/nax-agent` 0.3.1 and `@nathapp/nax-agent-acp` 0.3.1 (workspace), `@agentclientprotocol/sdk` ~1.7.0.

**Spec:** `docs/superpowers/specs/2026-10-07-s4b-nax-run-acp-cutover-design.md`, §6.1-§6.5, §6.7, §7.1-§7.3 and §10 row S4b-2. Read §1 first (the governing rule: replace the transport, not the logic). The predecessor plans are `2026-10-07-s4b-0-verification-and-package-additions.md` (its "S4b-0 findings" section) and `2026-10-07-s4b-1-shared-logic-moves.md`.

**Branch:** `feat/s4b-2-acp-sdk-adapter`, off main `ace8c35f8` (this plan is its first commit).

## Global Constraints

- Default behaviour does not change. `agent.acp.transport` defaults to `"acpx"`, and every existing test passes unchanged except where this plan names an edit.
- `packages/nax-agent/` and `packages/nax-agent-acp/` are not modified. No release, no billed run, no `nax run`, no `nax plan`.
- Run commands from `packages/nax` unless a step says otherwise. Targeted tests: `timeout 60 bun test <path> --timeout=20000` (real-subprocess tests need the longer timeout). Full suite: `bun run test`. Never bare `bun test` over the whole tree, never `bun run nax`.
- nax may import `@nathapp/nax-agent-acp/client` and nothing else from that package (`check:package-boundaries`, Task 1).
- `src/` code: value imports through `@/` only to a barrel (`check:alias-internals`); type-only imports may reach internals. Relative imports may go up one level only (`../x`); Biome rejects `../../`.
- No literal `"approve-all"` / `"approve-reads"` in `src/` without `// nax-permission-mode-allow: <reason>` on the same line (`check-permission-mode-ssot`).
- No `throw new Error(...)` in `src/` (`check:nax-error`); throw `NaxError` from `@/errors`. No empty `catch {}` without a comment. No `setInterval`; `setTimeout` only where the handle is cleared, with a comment saying so.
- One unit test file per source file, mirroring `src/` (`test/unit/agents/acp-sdk/<file>.test.ts`). Source files under 600 lines, test files under 800. Cognitive complexity per function at most 20 (`check:complexity`).
- `src/session/manager.ts` is a grandfathered oversized file (672 lines) and may not grow (Task 12 keeps it net negative).
- Every new `src/` file needs line and function coverage of at least 80% (`bun run test:coverage`, `--require-all-files`).
- No emojis in code, comments or docs. Conventional commits.

## Decisions (made while writing this plan)

| # | Decision |
|---|---|
| D2-a | **Model-alias probe (spec §6.7, S4b-0 Ruling T1-3): no mapping table.** Run 2026-10-07 while writing this plan, unbilled: `initialize` + `session/new` + three `session/set_config_option` calls against `@agentclientprotocol/claude-agent-acp@0.85.1` on the maintainer's account, no prompt. The `model` option (category `model`) offered `default, sonnet, haiku, opus, fable`, and set to `haiku`, `sonnet` and `opus` each succeeded. So nax's Claude tier defaults (`haiku`/`sonnet`/`opus`, `config/agent-defaults.ts:30`) match verbatim; `agents/model-effort.ts` is not created. The effort option is `effort` (category `thought_level`), values `default, low, medium, high, xhigh, max`; it is absent while `haiku` is selected (S4b-3 skips effort with a warning there, as acpx does). Probe script: maintainer scratchpad `probe/probe.mjs`. |
| D2-b | **A configured model id that the agent does not offer verbatim fails the open** with `AGENT_SESSION_CAPABILITY_UNSUPPORTED` (`context.capability: "model"`), because nax-agent-acp matches the value exactly (`open.ts` `applyModel`). acpx passed `--model` through and the adapter resolved it fuzzily. This is a behaviour change on the `sdk` transport; Task 13 adds it to spec §11 as item 8. |
| D2-c | **Run abort throws.** A turn aborted by the run's `opts.signal` (or by the session closing) throws `SessionTurnError{ cancelled: true, retryable: false }` with `fail-aborted`, as spec §7.1 says. acpx instead returned a zero-output `TurnResult` from that path (`adapter-send-turn.ts` `state.aborted`). S4b-3's parity tests must confirm the spec row or amend it before the flip. |
| D2-d | **S4b-2 / S4b-3 split.** S4b-2 ships the adapter's open, close, turn loop, stream bridge, ask port, profile map and pricing (spec §10). `complete()` throws `ACP_SDK_COMPLETE_UNAVAILABLE` until S4b-3. `failure-map.ts` carries only the cancel-cause rows plus a `fail-unknown` fallback; S4b-3 adds the error-code rows. Not in S4b-2: `promptRetries`, `initializeTimeoutMs` / `cancelGraceMs`, tool-audit writes, effort, and `onProcess` PID callbacks. The key is a development key, documented as incomplete. |
| D2-e | **Adapter tests use nax-agent-acp's fake ACP agent as a subprocess, reached by file path** (`test/helpers/acp-fake-agent/index.ts`), not by import. nax may import only `./client`. The fake runs through the backend's `command` override on the registered name `claude`, so the Claude registry entry (modes, auth env) still applies. |
| D2-f | `AcpSdkAgentAdapter.binary` is the agent's own CLI name (`claude`, `codex`, ...), used only for display and the bounded `--version` probe in `nax agents`. `isInstalled()` is `isAgentLaunchable()` (spec §6.8); the `npx`-only precheck warning is S4b-3. |
| D2-g | **The stream bridge emits `agent.call_ended` with `"success"` or `"error"` only, as acpx does** (a cancel is `"error"`, `spawn-client-session.ts:319`). `agent.process_update` is emitted only when a pid is known, which S4b-3's `onProcess` wiring supplies. |
| D2-h | **Stream run identifiers come from `opts.toolAudit.header`** (`runId`, `storyId`). It is the only place `OpenSessionOpts` carries them. `runId` is `""` when absent; acpx passed `undefined`. |
| D2-i | `profile-map.ts` maps the mode only. The per-agent fail-closed rule stays in the backend (`AGENT_SESSION_CAPABILITY_UNSUPPORTED` for `read` on codex/opencode/gemini/pi), so the map can never widen a profile to make an open succeed. |
| D2-j | **The crash-leftover match is delegated to the backend.** The adapter loads the session's transcript document and passes it as `resume`. The backend's `storedSessionOf` already rejects a backend, agent or cwd mismatch before anything is spawned. On `AGENT_SESSION_BACKEND_MISMATCH`, `AGENT_SESSION_INVALID_OPTIONS`, `AGENT_SESSION_NOT_FOUND` or `TRANSCRIPT_CORRUPT` the adapter deletes the document and opens fresh. This includes a native transcript under the same name (an agent swap, nax#1722). |
| D2-k | The ask port's `recordAutoDecision` logs a denial at debug only in S4b-2; S4b-3 adds the `denied` tool-audit row with the audit sink. A pending ACP question emits `agent.awaiting_human` at once and every 30 s (`AWAITING_HUMAN_BEAT_MS`); the idle timeout is 900 s. |
| D2-l | Mid-turn NO_SESSION recovery closes the old backend (bounded), deletes the transcript document and opens fresh **without** a resume. Re-reading the stale document would only fail the resume again. |
| D2-m | `src/session/manager.ts` cannot grow. `transcriptDir` derivation, `transcriptOwner` and the new `toolAudit` forwarding move into `src/session/open-session-extras.ts`, called as one spread. |
| D2-n | The config-less registry functions (`getAllAgents`, `getInstalledAgents`, `checkAgentHealth`) use `DEFAULT_ACP_TRANSPORT`. `createAgentRegistry`, `nax agents` and the bake-off preflight read the configured key. |
| D2-o | **Bake-off preflight.** `PreflightDeps.isInstalled` becomes `(agentName, transport) => boolean \| Promise<boolean>` and asks the transport's adapter. The transport is the contestant profile's `agent.acp.transport`, else the base config's (passed by the coordinator). The agent-name gate uses `ACP_SDK_AGENT_NAMES`, the same five names as `ACP_ADAPTER_NAMES`. |

## Review Focus

1. **Close or run abort during a running prompt.** Expect no orphaned agent process, `SessionTurnError{ cancelled: true }` with `fail-aborted`, and the spend so far on the error. Tested in Task 9 (scripted backend) and Task 10 (real subprocess, `closeSession` mid-turn).
2. **A native transcript under the same session name** (agent swap native -> claude). Expect the document to be discarded and a fresh ACP session opened, never a crash. Tested in Task 8 (`doc without backend field`).
3. **A configured model the agent does not offer verbatim** (for example `claude-sonnet-4-5`). Expect the open to reject with `AGENT_SESSION_CAPABILITY_UNSUPPORTED`, no session left in the adapter's live map, and the agent process gone. Tested in Task 10.
4. **A pending ACP question.** Expect the awaiting-human beat to stop when the reply settles (no timer left running) and the question to consume the shared budget. Tested in Task 6.
5. **An environment variable whose name the backend's option schema rejects** (for example `CLAUDE_X-Y`, matched by the `CLAUDE_` prefix). Expect it to be dropped from the agent env, never failing every open. Tested in Task 7.

## File Structure

| File | Responsibility | Task |
|---|---|---|
| Modify `packages/nax/package.json`, `bun.lock` | nax depends on nax-agent-acp (workspace devDependency, bundled) and `@agentclientprotocol/sdk` | 1 |
| Modify `packages/nax/scripts/lib/agent-bundling.ts`, `scripts/check-bundle-externals.ts` | bundling invariant covers nax-agent-acp | 1 |
| Modify `packages/nax/scripts/check-package-boundaries.ts` | nax may import only `@nathapp/nax-agent-acp/client` | 1 |
| Modify `.nax/context.md`, `.nax/mono/packages/nax-agent-acp/context.md` + regenerated agent files | dependency direction | 1 |
| Modify `src/config/agent-defaults.ts`, `config/index.ts`, `schemas-infra.ts`, `schemas.ts`, `runtime-types-agent.ts`, `src/cli/config-descriptions.ts` | `agent.acp.transport` | 2 |
| Create `src/agents/acp-sdk/entries.ts` | per-agent display rows and the agent-name set | 3 |
| Create `src/agents/acp-sdk/profile-map.ts` | permission mode -> ACP profile | 3 |
| Create `src/agents/acp-sdk/pricing.ts` | spend from backend results and errors, summed | 4 |
| Create `src/agents/acp-sdk/failure-map.ts` | cancel reasons, failure -> `SessionTurnError` | 4 |
| Create `src/agents/acp-sdk/stream-bridge.ts` | turn events -> `AgentStreamEvent`s per backend call | 5 |
| Create `src/agents/acp-sdk/turn-slot.ts` | the running turn, read by the backend context and the ask port | 6 |
| Create `src/agents/acp-sdk/ask-port.ts` | nax's `SessionAskPort` | 6 |
| Create `src/agents/acp-sdk/open-context.ts` | `BackendOpenContext`, backend options, agent env, transcript store | 7 |
| Create `src/agents/acp-sdk/session.ts` | one session: open with the crash-leftover policy, re-open, close; `_acpSdkDeps` | 8 |
| Create `packages/nax/test/helpers/acp-fake-agent/index.ts` | fake ACP agent subprocess and scripted backends for tests | 8 |
| Create `src/agents/acp-sdk/turn-loop.ts` | nax's turn loop over the backend | 9 |
| Create `src/agents/acp-sdk/adapter.ts`, `src/agents/acp-sdk/index.ts` | `AcpSdkAgentAdapter`, barrel | 10 |
| Modify `src/agents/registry.ts`, `src/agents/index.ts`, `src/cli/agents.ts`, `src/bakeoff/preflight.ts`, `src/bakeoff/coordinator.ts`, `scripts/check-adapter-no-config-import.sh` | routing and consumers | 11 |
| Create `src/session/open-session-extras.ts`; modify `src/session/manager.ts`, `src/session/types.ts`, `src/operations/build-hop-callback-hop.ts` | `toolAudit` reaches the adapter | 12 |
| Modify spec, `docs/` | probe result, behaviour change 8, new units | 13 |

---

### Task 1: nax depends on nax-agent-acp

**Files:**
- Modify: `packages/nax/package.json` (`dependencies`, `devDependencies`)
- Modify: `bun.lock` (by `bun install`)
- Modify: `packages/nax/scripts/lib/agent-bundling.ts`
- Modify: `packages/nax/scripts/check-bundle-externals.ts:52-54`, `:119-129`
- Modify: `packages/nax/scripts/check-package-boundaries.ts:19-22`, `:138`
- Modify: `.nax/context.md:17`, `.nax/mono/packages/nax-agent-acp/context.md:63`, then the generated `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `codex.md` (root and `packages/nax-agent-acp/`)
- Test: `packages/nax/test/unit/scripts/agent-bundling.test.ts`, `packages/nax/test/unit/scripts/check-package-boundaries.test.ts:355-368`

**Interfaces:**
- Produces: `checkBundledPackage(nax: PackageJsonShape, name: string, bundled: PackageJsonShape): string[]` and `checkAcpBundling(nax: PackageJsonShape, acp: PackageJsonShape): string[]` in `scripts/lib/agent-bundling.ts`. `checkAgentBundling` keeps its signature and messages.
- Produces: `import { ... } from "@nathapp/nax-agent-acp/client"` resolves in nax `src/` and `test/` (Tasks 7-10).

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/scripts/agent-bundling.test.ts`, inside the file after the existing `describe`:

```typescript
import { checkAcpBundling } from "@scripts/lib/agent-bundling";

describe("checkAcpBundling", () => {
  const ACP = {
    dependencies: { "@agentclientprotocol/sdk": "~1.7.0", "@modelcontextprotocol/sdk": "^1.30.0", zod: "^4.3.6" },
  };
  const NAX_WITH_ACP = {
    ...NAX,
    dependencies: { ...NAX.dependencies, "@agentclientprotocol/sdk": "~1.7.0", "@modelcontextprotocol/sdk": "^1.30.0" },
    devDependencies: { ...NAX.devDependencies, "@nathapp/nax-agent-acp": "workspace:*" },
  };

  test("the bundled layout passes", () => {
    expect(checkAcpBundling(NAX_WITH_ACP, ACP)).toEqual([]);
  });

  test("nax-agent-acp must be a workspace devDependency and stay out of --external", () => {
    const nax = {
      ...NAX_WITH_ACP,
      scripts: { build: '--external "@nathapp/nax-agent-acp"' },
      devDependencies: NAX.devDependencies,
    };
    expect(checkAcpBundling(nax, ACP)).toEqual([
      'nax must list @nathapp/nax-agent-acp as a devDependency "workspace:*" (it is bundled, not installed)',
      "the build script must bundle @nathapp/nax-agent-acp, not mark it --external",
    ]);
  });

  test("every runtime dependency of nax-agent-acp is declared by nax at the same version", () => {
    const nax = { ...NAX_WITH_ACP, dependencies: NAX.dependencies };
    expect(checkAcpBundling(nax, ACP)).toEqual([
      "nax-agent-acp depends on @agentclientprotocol/sdk@~1.7.0; nax must declare the same in dependencies (found undefined)",
      "nax-agent-acp depends on @modelcontextprotocol/sdk@^1.30.0; nax must declare the same in dependencies (found undefined)",
    ]);
  });
});
```

Move the new `import` line to the top of the file next to the existing `checkAgentBundling` import (one import statement: `import { checkAcpBundling, checkAgentBundling } from "@scripts/lib/agent-bundling";`).

In `test/unit/scripts/check-package-boundaries.test.ts`, the test at lines 355-368 writes `packages/nax/src/bad.ts` importing `@nathapp/nax-agent-acp/client` and expects `"... nax does not depend on nax-agent-acp until S4b"`. Change that one fixture line and its expectation:

```typescript
    write("packages/nax/src/bad.ts", 'import { c } from "@nathapp/nax-agent-acp/server";\n');
```

```typescript
      "packages/nax/src/bad.ts @nathapp/nax-agent-acp/server only @nathapp/nax-agent-acp/client",
```

Then add a test inside the same `describe("nax-agent-acp", ...)` block:

```typescript
  test("nax may import nax-agent-acp through ./client only (S4b-2)", () => {
    acp();
    write(
      "packages/nax/src/ok-acp.ts",
      'import { acpBackend } from "@nathapp/nax-agent-acp/client";\nimport type { AcpAgentName } from "@nathapp/nax-agent-acp/client";\n',
    );
    write("packages/nax/test/ok-acp.test.ts", 'import { acpBackend } from "@nathapp/nax-agent-acp/client";\n');
    write("packages/nax/src/bad-acp.ts", 'import { x } from "@nathapp/nax-agent-acp";\n');
    expect(whys()).toEqual(["packages/nax/src/bad-acp.ts @nathapp/nax-agent-acp only @nathapp/nax-agent-acp/client"]);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `timeout 30 bun test test/unit/scripts/agent-bundling.test.ts test/unit/scripts/check-package-boundaries.test.ts --timeout=5000`
Expected: FAIL. `checkAcpBundling` is not exported, and the boundary rule still reports "until S4b".

- [ ] **Step 3: Implement**

Replace the body of `scripts/lib/agent-bundling.ts` below the `PackageJsonShape` interface:

```typescript
const AGENT = "@nathapp/nax-agent";
const ACP = "@nathapp/nax-agent-acp";

function shortName(name: string): string {
  return name.replace("@nathapp/", "");
}

/**
 * A workspace package nax bundles into dist/nax.js: listed only as a
 * `workspace:*` devDependency, never `--external`, and every runtime
 * dependency of it declared by nax at the same spec, so consumers install it.
 */
export function checkBundledPackage(nax: PackageJsonShape, name: string, bundled: PackageJsonShape): string[] {
  const failures: string[] = [];
  if (nax.devDependencies?.[name] !== "workspace:*") {
    failures.push(`nax must list ${name} as a devDependency "workspace:*" (it is bundled, not installed)`);
  }
  if (nax.scripts?.build?.includes(`--external "${name}"`)) {
    failures.push(`the build script must bundle ${name}, not mark it --external`);
  }
  for (const [dep, spec] of Object.entries(bundled.dependencies ?? {})) {
    const declared = nax.dependencies?.[dep];
    if (declared !== spec) {
      failures.push(
        `${shortName(name)} depends on ${dep}@${spec}; nax must declare the same in dependencies (found ${declared})`,
      );
    }
  }
  return failures;
}

export function checkAgentBundling(nax: PackageJsonShape, agent: PackageJsonShape): string[] {
  const failures: string[] = [];
  for (const [name, spec] of Object.entries(nax.dependencies ?? {})) {
    if (spec.startsWith("workspace:")) failures.push(`nax dependency ${name} uses ${spec}; npm cannot install it`);
  }
  return [...failures, ...checkBundledPackage(nax, AGENT, agent)];
}

/** S4b-2: nax-agent-acp is bundled the same way (spec §8). */
export function checkAcpBundling(nax: PackageJsonShape, acp: PackageJsonShape): string[] {
  return checkBundledPackage(nax, ACP, acp);
}
```

Update the file's header comment: "nax bundles @nathapp/nax-agent and @nathapp/nax-agent-acp into dist/nax.js instead of installing them (S1 spec section 4.1, S4b spec §8) ...".

In `scripts/check-bundle-externals.ts`, extend the import to `import { checkAcpBundling, checkAgentBundling } from "./lib/agent-bundling";`, and after the `checkAgentBundling` line add:

```typescript
const acpPkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "nax-agent-acp", "package.json"), "utf8"));
failures.push(...checkAcpBundling(pkg, acpPkg));
```

Change invariant 4 in the header to "`@nathapp/nax-agent` and `@nathapp/nax-agent-acp` are bundled, never installed: nax lists each only as a `workspace:*` devDependency, and declares every runtime dependency of each itself", and the success message to `"... nax-agent and nax-agent-acp are bundled"`.

In `packages/nax/package.json`, add `"@agentclientprotocol/sdk": "~1.7.0"` to `dependencies` (alphabetical, first entry) and `"@nathapp/nax-agent-acp": "workspace:*"` to `devDependencies` after `"@nathapp/nax-agent"`. Then from the repo root:

```bash
bun install
```

Expected: `bun.lock` changes; `packages/nax/node_modules/@nathapp/nax-agent-acp` is a symlink.

In `scripts/check-package-boundaries.ts`:
- header lines 19-22: replace "No other package imports it (nax adopts it in S4b)." with "nax imports it only through `@nathapp/nax-agent-acp/client` (S4b-2); no other package imports it."
- add beside `const ACP = ...`: `const ACP_CLIENT = \`${ACP}/client\`;`
- replace line 138 with:

```typescript
  if (packageName(spec) === ACP) return spec === ACP_CLIENT ? null : `only ${ACP_CLIENT}`;
```

- [ ] **Step 4: Run the tests and gates**

Run: `timeout 30 bun test test/unit/scripts/agent-bundling.test.ts test/unit/scripts/check-package-boundaries.test.ts --timeout=5000`
Expected: PASS.

Run: `bun run check:bundle-externals && bun run check:package-boundaries`
Expected: both print their OK line.

- [ ] **Step 5: Update the agent context**

In `.nax/context.md:17` replace "No package imports nax-agent-acp until S4b; it reaches nax-agent only through its public entry." with "nax imports nax-agent-acp only through `@nathapp/nax-agent-acp/client` and bundles it like nax-agent (S4b-2); nax-agent-acp reaches nax-agent only through its public entry." In `.nax/mono/packages/nax-agent-acp/context.md:63` replace "- No other package imports this one until S4b." with "- nax imports this package only through `./client` (S4b-2); no other package imports it."

From the repo root:

```bash
bun packages/nax/bin/nax.ts generate
bun packages/nax/bin/nax.ts generate --all-packages
git diff --stat
```

Expected: the root and `packages/nax-agent-acp/` `CLAUDE.md`, `AGENTS.md`, `GEMINI.md` and `codex.md` change in that one line each, nothing else.

- [ ] **Step 6: Commit**

```bash
git add packages/nax/package.json bun.lock packages/nax/scripts packages/nax/test/unit/scripts .nax CLAUDE.md AGENTS.md GEMINI.md codex.md packages/nax-agent-acp/CLAUDE.md packages/nax-agent-acp/AGENTS.md packages/nax-agent-acp/GEMINI.md packages/nax-agent-acp/codex.md
git commit -m "build(nax): depend on nax-agent-acp via ./client, bundled (S4b-2)"
```

---

### Task 2: `agent.acp.transport` config key

**Files:**
- Modify: `packages/nax/src/config/agent-defaults.ts` (after `DEFAULT_AGENT_NAME`)
- Modify: `packages/nax/src/config/index.ts:3`
- Modify: `packages/nax/src/config/schemas-infra.ts:322-339` (`AgentAcpConfigSchema`) and `:403-407` (the `acp` default)
- Modify: `packages/nax/src/config/schemas.ts:349` and its `agent-defaults` import
- Modify: `packages/nax/src/config/runtime-types-agent.ts:80-93` (`AgentAcpConfig`)
- Modify: `packages/nax/src/cli/config-descriptions.ts` (after `"agent.protocol"`, line 300)
- Test: `packages/nax/test/unit/config/agent-schema.test.ts`, `packages/nax/test/unit/cli/config-descriptions.test.ts`

**Interfaces:**
- Produces: `export type AcpTransport = "acpx" | "sdk"` and `export const DEFAULT_ACP_TRANSPORT: AcpTransport = "acpx"`, both re-exported from `@/config` (barrel) for Task 11.
- Produces: `config.agent.acp.transport: AcpTransport` (always present after schema parse, default `"acpx"`).

- [ ] **Step 1: Write the failing tests**

Add to `test/unit/config/agent-schema.test.ts` after the `promptRetries` tests:

```typescript
  test("agent.acp.transport defaults to acpx", () => {
    const result = NaxConfigSchema.parse({});
    expect(result.agent?.acp?.transport).toBe("acpx");
  });

  test("agent.acp.transport accepts sdk and keeps the other acp defaults", () => {
    const result = NaxConfigSchema.parse({ agent: { acp: { transport: "sdk" } } });
    expect(result.agent?.acp).toEqual({
      transport: "sdk",
      promptRetries: 0,
      trackedSpawnDeadlineMs: 10_000,
      trackedSpawnStartupDeadlineMs: 30_000,
    });
  });

  test("agent.acp.transport rejects an unknown transport", () => {
    expect(() => NaxConfigSchema.parse({ agent: { acp: { transport: "acp" } } })).toThrow();
  });
```

Add to `test/unit/cli/config-descriptions.test.ts` (import `FIELD_DESCRIPTIONS` the way the file already does):

```typescript
describe("FIELD_DESCRIPTIONS agent.acp.transport (S4b-2)", () => {
  test("names both transports and the default", () => {
    const text = FIELD_DESCRIPTIONS["agent.acp.transport"];
    expect(text).toContain("'acpx'");
    expect(text).toContain("'sdk'");
    expect(text).toContain("default");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `timeout 30 bun test test/unit/config/agent-schema.test.ts test/unit/cli/config-descriptions.test.ts --timeout=5000`
Expected: FAIL (`transport` is undefined; the description is missing).

- [ ] **Step 3: Implement**

`src/config/agent-defaults.ts`, after `DEFAULT_AGENT_NAME`:

```typescript
/**
 * How `nax run` drives ACP agents (S4b spec §5.3): through the `acpx` CLI, or
 * through `@nathapp/nax-agent-acp`. A development key while both transports
 * exist: S4b-4 flips the default and S4b-5 deletes the key with acpx.
 */
export type AcpTransport = "acpx" | "sdk";

export const DEFAULT_ACP_TRANSPORT: AcpTransport = "acpx";
```

`src/config/index.ts:3` becomes:

```typescript
export {
  type AcpTransport,
  DEFAULT_ACP_TRANSPORT,
  DEFAULT_AGENT_NAME,
  DEFAULT_AGENT_PROTOCOL,
  isBuiltInModelMap,
  NATIVE_AGENT_NAME,
} from "./agent-defaults";
```

`src/config/schemas-infra.ts`: extend the `agent-defaults` import with `DEFAULT_ACP_TRANSPORT`, add as the first field of `AgentAcpConfigSchema`:

```typescript
  /**
   * S4b development key: "acpx" (default) drives ACP agents through the acpx
   * CLI, "sdk" through @nathapp/nax-agent-acp. The sdk transport is incomplete
   * until S4b-3 (no complete(), no promptRetries).
   */
  transport: z.enum(["acpx", "sdk"]).default(DEFAULT_ACP_TRANSPORT),
```

and add `transport: DEFAULT_ACP_TRANSPORT,` as the first key of the `AgentAcpConfigSchema.default({...})` object at `:403`. In `src/config/schemas.ts:349` add `transport: DEFAULT_ACP_TRANSPORT,` as the first key of the `acp` literal, importing `DEFAULT_ACP_TRANSPORT` in the existing `agent-defaults` import.

`src/config/runtime-types-agent.ts`, inside `AgentAcpConfig` before `promptRetries`:

```typescript
  /** How ACP agents are driven: "acpx" (default) or "sdk" (S4b development key). */
  transport?: AcpTransport;
```

with `import type { AcpTransport } from "./agent-defaults";` at the top of the file (`agent-defaults.ts` has no `@/` imports, so no cycle). Also replace "via acpx --prompt-retries" in the `promptRetries` doc comment with "for transient prompt failures (default: 0, opt-in)".

`src/cli/config-descriptions.ts`, after `"agent.protocol"`:

```typescript
  "agent.acp": "ACP agent transport settings (claude, codex, opencode, gemini, pi)",
  "agent.acp.transport":
    "How ACP agents are driven: 'acpx' (default) shells out to the acpx CLI; 'sdk' uses @nathapp/nax-agent-acp in-process (S4b development key, incomplete until S4b-3)",
```

- [ ] **Step 4: Run the tests**

Run: `timeout 30 bun test test/unit/config/ test/unit/cli/config-descriptions.test.ts --timeout=10000`
Expected: PASS.

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/config src/cli/config-descriptions.ts test/unit/config/agent-schema.test.ts test/unit/cli/config-descriptions.test.ts
git commit -m "feat(config): agent.acp.transport development key, default acpx (S4b-2)"
```

---

### Task 3: `entries.ts` and `profile-map.ts`

**Files:**
- Create: `packages/nax/src/agents/acp-sdk/entries.ts`
- Create: `packages/nax/src/agents/acp-sdk/profile-map.ts`
- Test: `packages/nax/test/unit/agents/acp-sdk/entries.test.ts`, `packages/nax/test/unit/agents/acp-sdk/profile-map.test.ts`

**Interfaces:**
- Produces: `AcpSdkEntry { agent: AcpAgentName; binary: string; displayName: string; supportedTiers: readonly ModelTier[]; maxContextTokens: number }`, `acpSdkEntry(agentName: string): AcpSdkEntry | undefined`, `ACP_SDK_AGENT_NAMES: ReadonlySet<string>`, `UNSUPPORTED_ENTRY: Omit<AcpSdkEntry, "agent">`.
- Produces: `type AcpSdkProfile = "full" | "read"`, `acpProfileFor(mode: ResolvedPermissions["mode"]): AcpSdkProfile`.

- [ ] **Step 1: Write the failing tests**

```typescript
// test/unit/agents/acp-sdk/entries.test.ts
import { describe, expect, test } from "bun:test";
import { ACP_ADAPTER_NAMES } from "@/agents/acp";
import { resolveRegistryEntry } from "@/agents/acp/agent-entries";
import { ACP_SDK_AGENT_NAMES, acpSdkEntry, UNSUPPORTED_ENTRY } from "@/agents/acp-sdk/entries";

describe("acp-sdk entries", () => {
  test("covers the same agent names as the acpx adapter", () => {
    expect([...ACP_SDK_AGENT_NAMES].sort()).toEqual([...ACP_ADAPTER_NAMES].sort());
  });

  test("each entry launches the nax-agent-acp agent of its own name", () => {
    for (const name of ACP_SDK_AGENT_NAMES) expect(acpSdkEntry(name)?.agent).toBe(name);
  });

  test("display name, tiers and context match the acpx rows (parity)", () => {
    for (const name of ACP_SDK_AGENT_NAMES) {
      const acpx = resolveRegistryEntry(name);
      expect(acpSdkEntry(name)).toMatchObject({
        binary: acpx.binary,
        displayName: acpx.displayName,
        supportedTiers: acpx.supportedTiers,
        maxContextTokens: acpx.maxContextTokens,
      });
    }
  });

  test("aider and unknown names have no entry", () => {
    expect(acpSdkEntry("aider")).toBeUndefined();
    expect(acpSdkEntry("toString")).toBeUndefined();
  });

  test("the unsupported row is the acpx DEFAULT_ENTRY display", () => {
    expect(UNSUPPORTED_ENTRY.displayName).toBe("ACP Agent");
    expect(UNSUPPORTED_ENTRY.supportedTiers).toEqual(["balanced"]);
  });
});
```

```typescript
// test/unit/agents/acp-sdk/profile-map.test.ts
import { describe, expect, test } from "bun:test";
import { acpProfileFor } from "@/agents/acp-sdk/profile-map";

describe("acpProfileFor (S4b spec §6.4)", () => {
  test("approve-all maps to full", () => {
    expect(acpProfileFor("approve-all")).toBe("full");
  });

  test("approve-reads maps to read", () => {
    expect(acpProfileFor("approve-reads")).toBe("read");
  });

  test("default maps to read, never wider", () => {
    expect(acpProfileFor("default")).toBe("read");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `timeout 30 bun test test/unit/agents/acp-sdk/ --timeout=5000`
Expected: FAIL (modules not found).

- [ ] **Step 3: Implement**

```typescript
// src/agents/acp-sdk/entries.ts
/**
 * Per-agent rows for the ACP SDK transport (S4b spec §5.1): what nax shows and
 * advertises for each agent nax-agent-acp can launch. Carried over from the acpx
 * adapter's agent-entries.ts; the launch command itself is nax-agent-acp's
 * registry, so `binary` is the agent's own CLI, used only for display and the
 * `--version` probe in `nax agents` (D2-f).
 */
import type { AcpAgentName } from "@nathapp/nax-agent-acp/client";
import type { ModelTier } from "@/config/schema";

export interface AcpSdkEntry {
  /** The nax-agent-acp registry name the backend launches. */
  readonly agent: AcpAgentName;
  /** The agent's own CLI. Not what is launched. */
  readonly binary: string;
  readonly displayName: string;
  readonly supportedTiers: readonly ModelTier[];
  readonly maxContextTokens: number;
}

const ENTRIES: Readonly<Record<string, AcpSdkEntry>> = Object.freeze({
  claude: {
    agent: "claude",
    binary: "claude",
    displayName: "Claude Code (ACP)",
    supportedTiers: ["fast", "balanced", "powerful"],
    maxContextTokens: 200_000,
  },
  codex: {
    agent: "codex",
    binary: "codex",
    displayName: "OpenAI Codex (ACP)",
    supportedTiers: ["fast", "balanced"],
    maxContextTokens: 128_000,
  },
  gemini: {
    agent: "gemini",
    binary: "gemini",
    displayName: "Gemini CLI (ACP)",
    supportedTiers: ["fast", "balanced", "powerful"],
    maxContextTokens: 1_000_000,
  },
  opencode: {
    agent: "opencode",
    binary: "opencode",
    displayName: "opencode (ACP)",
    supportedTiers: ["fast", "balanced", "powerful"],
    maxContextTokens: 128_000,
  },
  pi: {
    agent: "pi",
    binary: "pi",
    displayName: "Pi Coding Agent (ACP)",
    supportedTiers: ["fast", "balanced", "powerful"],
    maxContextTokens: 128_000,
  },
});

/** The names `nax agents` lists and the bake-off accepts (the acpx `ACP_ADAPTER_NAMES` set). */
export const ACP_SDK_AGENT_NAMES: ReadonlySet<string> = new Set(Object.keys(ENTRIES));

export function acpSdkEntry(agentName: string): AcpSdkEntry | undefined {
  return Object.hasOwn(ENTRIES, agentName) ? ENTRIES[agentName] : undefined;
}

/** A known nax agent name with no ACP launcher (aider): it lists, but never opens (spec §11 item 2). */
export const UNSUPPORTED_ENTRY: Omit<AcpSdkEntry, "agent"> = Object.freeze({
  binary: "",
  displayName: "ACP Agent",
  supportedTiers: ["balanced"],
  maxContextTokens: 128_000,
});
```

```typescript
// src/agents/acp-sdk/profile-map.ts
/**
 * nax's resolved permission mode -> the nax-agent-acp session profile (S4b spec
 * §6.4). Pure. The per-agent fail-closed rule (no `read` on codex, opencode,
 * gemini or pi until #2372) lives in the backend, which rejects the open with
 * AGENT_SESSION_CAPABILITY_UNSUPPORTED; this map never widens a profile to make
 * an open succeed (D2-i). Profile `ask` is never produced.
 */
import type { ResolvedPermissions } from "@/config/permissions";

export type AcpSdkProfile = "full" | "read";

const PROFILE_BY_MODE: Readonly<Record<ResolvedPermissions["mode"], AcpSdkProfile>> = Object.freeze({
  "approve-all": "full", // nax-permission-mode-allow: consumer, maps the resolved mode to an ACP profile
  "approve-reads": "read", // nax-permission-mode-allow: consumer, maps the resolved mode to an ACP profile
  default: "read",
});

export function acpProfileFor(mode: ResolvedPermissions["mode"]): AcpSdkProfile {
  return PROFILE_BY_MODE[mode];
}
```

- [ ] **Step 4: Run the tests**

Run: `timeout 30 bun test test/unit/agents/acp-sdk/ --timeout=5000`
Expected: PASS.

Run: `bun run check:alias-internals && bun run check:permission-mode-ssot`
Expected: both pass.

- [ ] **Step 5: Commit**

```bash
git add src/agents/acp-sdk test/unit/agents/acp-sdk
git commit -m "feat(agents): acp-sdk entries and profile map (S4b-2)"
```

---

### Task 4: `pricing.ts` and `failure-map.ts`

**Files:**
- Create: `packages/nax/src/agents/acp-sdk/pricing.ts`
- Create: `packages/nax/src/agents/acp-sdk/failure-map.ts`
- Test: `packages/nax/test/unit/agents/acp-sdk/pricing.test.ts`, `packages/nax/test/unit/agents/acp-sdk/failure-map.test.ts`

**Interfaces:**
- Produces (`pricing.ts`): `Spend { tokenUsage: TokenUsage; exactCostUsd: number | undefined }`, `NO_SPEND`, `spendOfResult(result: Pick<TurnResult, "tokenUsage" | "estimatedCostUsd" | "costSource">): Spend`, `spendOfError(err: unknown): Spend`, `addSpend(a: Spend, b: Spend): Spend`, `failedSpendFields(spend: Spend, rateCard: RateCard): { tokenUsage; estimatedCostUsd; exactCostUsd; pricingSource }`.
- Produces (`failure-map.ts`): classes `WatchdogCancel`, `RunAborted`, `TurnDeadlineExpired` (each `extends Error`; every abort uses a fresh instance), `TurnFailure`, `classifyTurnFailure(err: unknown, cause: unknown): TurnFailure`, `turnFailureError(failure: TurnFailure, spend: Spend, rateCard: RateCard): SessionTurnError`.

- [ ] **Step 1: Write the failing tests**

```typescript
// test/unit/agents/acp-sdk/pricing.test.ts
import { describe, expect, test } from "bun:test";
import { attachTurnSpend } from "@nathapp/nax-agent";
import { FALLBACK_RATES } from "@/agents/cost";
import { addSpend, failedSpendFields, NO_SPEND, spendOfError, spendOfResult } from "@/agents/acp-sdk/pricing";

const CARD = { rates: FALLBACK_RATES, source: "fallback-rates" } as const;

describe("acp-sdk pricing (S4b spec §7.3)", () => {
  test("a reported cost becomes exactCostUsd", () => {
    const spend = spendOfResult({
      tokenUsage: { inputTokens: 10, outputTokens: 5 },
      estimatedCostUsd: 0.01,
      costSource: "reported",
    });
    expect(spend).toEqual({ tokenUsage: { inputTokens: 10, outputTokens: 5 }, exactCostUsd: 0.01 });
  });

  test("an unpriced turn has no exactCostUsd", () => {
    const spend = spendOfResult({
      tokenUsage: { inputTokens: 10, outputTokens: 5 },
      estimatedCostUsd: 0,
      costSource: "unpriced",
    });
    expect(spend.exactCostUsd).toBeUndefined();
  });

  test("a failed turn's attached spend is read; none attached is zero", () => {
    const err = new Error("boom");
    attachTurnSpend(err, { tokenUsage: { inputTokens: 3, outputTokens: 1 }, costUsd: 0.002, costSource: "reported" });
    expect(spendOfError(err)).toEqual({ tokenUsage: { inputTokens: 3, outputTokens: 1 }, exactCostUsd: 0.002 });
    expect(spendOfError(new Error("bare"))).toEqual(NO_SPEND);
    expect(spendOfError("not an object")).toEqual(NO_SPEND);
  });

  test("addSpend sums tokens, and exact cost only once some turn reported one", () => {
    const priced = { tokenUsage: { inputTokens: 10, outputTokens: 5 }, exactCostUsd: 0.01 };
    const unpriced = { tokenUsage: { inputTokens: 1, outputTokens: 1 }, exactCostUsd: undefined };
    expect(addSpend(NO_SPEND, unpriced).exactCostUsd).toBeUndefined();
    const total = addSpend(addSpend(NO_SPEND, priced), unpriced);
    expect(total.tokenUsage).toMatchObject({ inputTokens: 11, outputTokens: 6 });
    expect(total.exactCostUsd).toBeCloseTo(0.01);
  });

  test("failedSpendFields prices tokens from the card and keeps the reported cost (BUG-57)", () => {
    const fields = failedSpendFields({ tokenUsage: { inputTokens: 1_000_000, outputTokens: 0 }, exactCostUsd: 2 }, CARD);
    expect(fields.estimatedCostUsd).toBeCloseTo(3);
    expect(fields.exactCostUsd).toBe(2);
    expect(fields.pricingSource).toBe("fallback-rates");
    expect(failedSpendFields(NO_SPEND, CARD).estimatedCostUsd).toBe(0);
  });
});
```

```typescript
// test/unit/agents/acp-sdk/failure-map.test.ts
import { describe, expect, test } from "bun:test";
import { SessionTurnError } from "@nathapp/nax-agent";
import { FALLBACK_RATES } from "@/agents/cost";
import {
  classifyTurnFailure,
  RunAborted,
  TurnDeadlineExpired,
  turnFailureError,
  WatchdogCancel,
} from "@/agents/acp-sdk/failure-map";

const CARD = { rates: FALLBACK_RATES, source: "fallback-rates" } as const;

describe("classifyTurnFailure (S4b spec §7.1, cancel rows)", () => {
  test("a watchdog cancel is fail-stale, cancelled and retryable", () => {
    const failure = classifyTurnFailure(new WatchdogCancel(), new WatchdogCancel());
    expect(failure).toMatchObject({ cancelled: true, retryable: true });
    expect(failure.adapterFailure).toMatchObject({ outcome: "fail-stale", retriable: true, reason: "idle-watchdog" });
  });

  test("a run abort is fail-aborted, cancelled, not retryable", () => {
    const failure = classifyTurnFailure(new RunAborted("shutdown"), new RunAborted("shutdown"));
    expect(failure).toMatchObject({ cancelled: true, retryable: false });
    expect(failure.adapterFailure.outcome).toBe("fail-aborted");
  });

  test("an abort with an unknown reason fails safe as fail-aborted", () => {
    expect(classifyTurnFailure(new Error("x"), new DOMException("aborted")).adapterFailure.outcome).toBe("fail-aborted");
  });

  test("no abort: fail-unknown carrying the error's message (S4b-3 adds the code rows)", () => {
    const failure = classifyTurnFailure(new Error("agent exploded"), undefined);
    expect(failure).toMatchObject({ cancelled: false, retryable: false, message: "agent exploded" });
    expect(failure.adapterFailure).toMatchObject({ outcome: "fail-unknown", retriable: false });
  });

  test("the message is capped at 500 characters", () => {
    expect(classifyTurnFailure(new Error("x".repeat(900)), undefined).message).toHaveLength(500);
  });

  test("each reason class is a distinct Error", () => {
    expect(new TurnDeadlineExpired()).toBeInstanceOf(Error);
    expect(new WatchdogCancel()).not.toBe(new WatchdogCancel());
  });
});

describe("turnFailureError", () => {
  test("builds a SessionTurnError with the spend and the adapter failure", () => {
    const failure = classifyTurnFailure(new WatchdogCancel(), new WatchdogCancel());
    const err = turnFailureError(failure, { tokenUsage: { inputTokens: 10, outputTokens: 0 }, exactCostUsd: 0.5 }, CARD);
    expect(err).toBeInstanceOf(SessionTurnError);
    expect(err.cancelled).toBe(true);
    expect(err.retryable).toBe(true);
    expect(err.tokenUsage).toEqual({ inputTokens: 10, outputTokens: 0 });
    expect(err.exactCostUsd).toBe(0.5);
    expect(err.pricingSource).toBe("fallback-rates");
    expect(err.adapterFailure?.outcome).toBe("fail-stale");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `timeout 30 bun test test/unit/agents/acp-sdk/pricing.test.ts test/unit/agents/acp-sdk/failure-map.test.ts --timeout=5000`
Expected: FAIL (modules not found).

- [ ] **Step 3: Implement**

```typescript
// src/agents/acp-sdk/pricing.ts
/**
 * Spend on the ACP SDK transport (S4b spec §7.3). The backend reports each
 * prompt's tokens and, for Claude, the agent's own cost (costSource
 * "reported"); a failed prompt's spend rides on the thrown error
 * (attachTurnSpend). nax sums them across its loop: estimatedCostUsd is always
 * tokens x the session's rate card (assembleTurnResult / failedSpendFields), and
 * the reported cost passes through as exactCostUsd.
 */
import { readTurnSpend, type TurnResult } from "@nathapp/nax-agent";
import { addTokenUsage, estimateCostUsd, type RateCard, type TokenUsage } from "../cost";

export interface Spend {
  readonly tokenUsage: TokenUsage;
  /** Sum of the reported costs; undefined until some prompt reported one. */
  readonly exactCostUsd: number | undefined;
}

export const NO_SPEND: Spend = Object.freeze({
  tokenUsage: Object.freeze({ inputTokens: 0, outputTokens: 0 }),
  exactCostUsd: undefined,
});

/** One successful backend prompt. Its estimatedCostUsd is the agent's figure when costSource is "reported". */
export function spendOfResult(result: Pick<TurnResult, "tokenUsage" | "estimatedCostUsd" | "costSource">): Spend {
  return {
    tokenUsage: result.tokenUsage,
    exactCostUsd: result.costSource === "reported" ? result.estimatedCostUsd : undefined,
  };
}

/** One failed backend prompt: the spend attached to its error, or nothing. */
export function spendOfError(err: unknown): Spend {
  const spend = readTurnSpend(err);
  if (spend === undefined) return NO_SPEND;
  return { tokenUsage: spend.tokenUsage, exactCostUsd: spend.costSource === "reported" ? spend.costUsd : undefined };
}

export function addSpend(a: Spend, b: Spend): Spend {
  const exact =
    a.exactCostUsd === undefined && b.exactCostUsd === undefined
      ? undefined
      : (a.exactCostUsd ?? 0) + (b.exactCostUsd ?? 0);
  return { tokenUsage: addTokenUsage(a.tokenUsage, b.tokenUsage), exactCostUsd: exact };
}

/** The spend fields a SessionTurnError carries, so burned tokens are recorded (BUG-57). */
export function failedSpendFields(
  spend: Spend,
  rateCard: RateCard,
): {
  tokenUsage: TokenUsage;
  estimatedCostUsd: number;
  exactCostUsd: number | undefined;
  pricingSource: RateCard["source"];
} {
  const hasUsage = spend.tokenUsage.inputTokens > 0 || spend.tokenUsage.outputTokens > 0;
  return {
    tokenUsage: spend.tokenUsage,
    estimatedCostUsd: hasUsage ? estimateCostUsd(spend.tokenUsage, rateCard.rates) : 0,
    exactCostUsd: spend.exactCostUsd,
    pricingSource: rateCard.source,
  };
}
```

```typescript
// src/agents/acp-sdk/failure-map.ts
/**
 * Backend failure -> SessionTurnError (S4b spec §7.1). The cancel cause is set
 * on the abort reason by whoever aborts, and is never inferred from a stop
 * reason. Every abort uses a fresh reason object, because the backend attaches
 * the failed prompt's spend to the reason it throws (attachTurnSpend keys on it).
 *
 * S4b-2 carries the cancel rows and a fail-unknown fallback (D2-d); S4b-3 adds
 * the rows keyed by the backend's error codes. A deadline expiry is not a
 * failure: the loop returns TurnResult{ timedOut: true } (§6.2 step 2).
 */
import type { AdapterFailure } from "@nathapp/nax-agent";
import type { RateCard } from "../cost";
import { SessionTurnError } from "../types";
import { failedSpendFields, type Spend } from "./pricing";

const MAX_MESSAGE_CHARS = 500;

/** The idle watchdog's cancel (onActiveCall). */
export class WatchdogCancel extends Error {
  constructor() {
    super("The idle watchdog cancelled the turn");
    this.name = "WatchdogCancel";
  }
}

/** The run's signal, or the session closing, ended the turn. */
export class RunAborted extends Error {
  constructor(cause?: unknown) {
    super("The turn was aborted", { cause });
    this.name = "RunAborted";
  }
}

/** The loop's one deadline expired (§6.2 step 2). */
export class TurnDeadlineExpired extends Error {
  constructor() {
    super("The turn deadline expired");
    this.name = "TurnDeadlineExpired";
  }
}

export interface TurnFailure {
  readonly message: string;
  readonly cancelled: boolean;
  readonly retryable: boolean;
  readonly adapterFailure: AdapterFailure;
}

function capped(text: string): string {
  return text.slice(0, MAX_MESSAGE_CHARS);
}

function failure(
  outcome: AdapterFailure["outcome"],
  message: string,
  flags: { readonly cancelled: boolean; readonly retryable: boolean; readonly reason?: string },
): TurnFailure {
  return {
    message,
    cancelled: flags.cancelled,
    retryable: flags.retryable,
    adapterFailure: {
      category: "availability",
      outcome,
      retriable: flags.retryable,
      message,
      ...(flags.reason === undefined ? {} : { reason: flags.reason }),
    },
  };
}

/** `cause` is the iteration signal's reason when it was aborted, else undefined. */
export function classifyTurnFailure(err: unknown, cause: unknown): TurnFailure {
  if (cause instanceof WatchdogCancel) {
    return failure("fail-stale", cause.message, { cancelled: true, retryable: true, reason: "idle-watchdog" });
  }
  if (cause !== undefined) {
    // A run abort, the session closing, or an abort nax did not label: never retried (§7.1).
    return failure("fail-aborted", "The turn was aborted", { cancelled: true, retryable: false });
  }
  const message = capped(err instanceof Error ? err.message : String(err));
  return failure("fail-unknown", message, { cancelled: false, retryable: false });
}

export function turnFailureError(failed: TurnFailure, spend: Spend, rateCard: RateCard): SessionTurnError {
  const fields = failedSpendFields(spend, rateCard);
  return new SessionTurnError(
    failed.message,
    failed.cancelled,
    failed.retryable,
    fields.tokenUsage,
    fields.estimatedCostUsd,
    fields.exactCostUsd,
    fields.pricingSource,
    failed.adapterFailure,
  );
}
```

- [ ] **Step 4: Run the tests**

Run: `timeout 30 bun test test/unit/agents/acp-sdk/ --timeout=5000`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agents/acp-sdk test/unit/agents/acp-sdk
git commit -m "feat(agents): acp-sdk pricing and cancel-cause failure map (S4b-2)"
```

---

### Task 5: `stream-bridge.ts`

**Files:**
- Create: `packages/nax/src/agents/acp-sdk/stream-bridge.ts`
- Test: `packages/nax/test/unit/agents/acp-sdk/stream-bridge.test.ts`

**Interfaces:**
- Produces: `StreamContext { emit: ((e: AgentStreamEvent) => void) | undefined; agentName: string; sessionName: string; runId: string; storyId: string | undefined; model: string; timeoutSeconds: number; pid: () => number | undefined }`.
- Produces: `CallBridge { callId: string; sink: TurnEventSink; sideEffects(): boolean; awaitingHuman(): void; end(status: "success" | "error"): void }` and `startCall(ctx: StreamContext, now?: () => number): CallBridge`.

The mapping mirrors the acpx client's `onActivity` (`agents/acp/spawn-client-session.ts:216-250`): message, thinking, tool-call and usage updates, `cadence: "agent"` on usage, `call_started` first and `call_ended` exactly once.

- [ ] **Step 1: Write the failing test**

```typescript
// test/unit/agents/acp-sdk/stream-bridge.test.ts
import { describe, expect, test } from "bun:test";
import type { AgentStreamEvent } from "@nathapp/nax-agent";
import { type StreamContext, startCall } from "@/agents/acp-sdk/stream-bridge";

function context(events: AgentStreamEvent[], pid?: number): StreamContext {
  return {
    emit: (event) => events.push(event),
    agentName: "claude",
    sessionName: "nax-s",
    runId: "run-1",
    storyId: "US-001",
    model: "sonnet",
    timeoutSeconds: 600,
    pid: () => pid,
  };
}

describe("startCall (S4b spec §6.2.1)", () => {
  test("starts with call_started carrying the run identifiers", () => {
    const events: AgentStreamEvent[] = [];
    const call = startCall(context(events), () => 7);
    expect(events).toEqual([
      {
        callId: call.callId,
        runId: "run-1",
        agentName: "claude",
        sessionName: "nax-s",
        storyId: "US-001",
        kind: "agent.call_started",
        model: "sonnet",
        timeoutSeconds: 600,
        timestamp: 7,
      },
    ]);
  });

  test("emits process_update only when a pid is known", () => {
    const events: AgentStreamEvent[] = [];
    startCall(context(events, 4242));
    expect(events.map((e) => e.kind)).toEqual(["agent.call_started", "agent.process_update"]);
    expect(events[1]).toMatchObject({ status: "spawned", pid: 4242 });
  });

  test("maps text, thinking, tool and usage events; deltaBytes is UTF-8 bytes", () => {
    const events: AgentStreamEvent[] = [];
    const call = startCall(context(events));
    call.sink({ type: "text_delta", round: 1, text: "hé" });
    call.sink({ type: "thinking_delta", round: 1, text: "abc" });
    call.sink({ type: "tool_call", callId: "t1", name: "Read", input: {} });
    call.sink({ type: "tool_progress", callId: "t1" });
    call.sink({ type: "tool_result", callId: "t1", isError: false, preview: "ok" });
    call.sink({
      type: "usage",
      round: 1,
      inputTokens: 10,
      outputTokens: 5,
      cacheRead: 2,
      costUsd: 0.01,
      costSource: "reported",
    });
    call.sink({ type: "stream_reset", round: 1, attempt: 2 });
    expect(events.slice(1)).toMatchObject([
      { kind: "agent.message_update", deltaBytes: 3 },
      { kind: "agent.thinking_update", deltaBytes: 3 },
      { kind: "agent.tool_call_update", toolName: "Read" },
      { kind: "agent.tool_call_update", toolName: "Read" },
      { kind: "agent.tool_call_update", toolName: "Read" },
      {
        kind: "agent.usage_update",
        inputTokens: 10,
        outputTokens: 5,
        cacheRead: 2,
        costUsd: 0.01,
        cadence: "agent",
      },
    ]);
  });

  test("an unpriced usage event carries no costUsd", () => {
    const events: AgentStreamEvent[] = [];
    const call = startCall(context(events));
    call.sink({ type: "usage", round: 1, inputTokens: 1, outputTokens: 1, costUsd: 0, costSource: "unpriced" });
    expect(events.at(-1)).not.toHaveProperty("costUsd");
  });

  test("call_ended is emitted exactly once and silences the call", () => {
    const events: AgentStreamEvent[] = [];
    const call = startCall(context(events));
    call.end("error");
    call.end("success");
    call.sink({ type: "text_delta", round: 1, text: "late" });
    call.awaitingHuman();
    expect(events.map((e) => e.kind)).toEqual(["agent.call_started", "agent.call_ended"]);
    expect(events[1]).toMatchObject({ status: "error" });
  });

  test("tracks side effects: text or a tool call, not thinking", () => {
    const events: AgentStreamEvent[] = [];
    const thinking = startCall(context(events));
    thinking.sink({ type: "thinking_delta", round: 1, text: "hm" });
    expect(thinking.sideEffects()).toBe(false);
    const tool = startCall(context(events));
    tool.sink({ type: "tool_call", callId: "t", name: "Bash", input: {} });
    expect(tool.sideEffects()).toBe(true);
  });

  test("awaitingHuman emits agent.awaiting_human on the call", () => {
    const events: AgentStreamEvent[] = [];
    const call = startCall(context(events));
    call.awaitingHuman();
    expect(events.at(-1)).toMatchObject({ kind: "agent.awaiting_human", callId: call.callId });
  });

  test("a throwing listener never reaches the turn; no listener is fine", () => {
    const call = startCall({
      ...context([]),
      emit: () => {
        throw new Error("listener bug");
      },
    });
    expect(() => call.sink({ type: "text_delta", round: 1, text: "x" })).not.toThrow();
    expect(() => startCall({ ...context([]), emit: undefined }).end("success")).not.toThrow();
  });

  test("storyId is omitted when absent", () => {
    const events: AgentStreamEvent[] = [];
    startCall({ ...context(events), storyId: undefined });
    expect(events[0]).not.toHaveProperty("storyId");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `timeout 30 bun test test/unit/agents/acp-sdk/stream-bridge.test.ts --timeout=5000`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```typescript
// src/agents/acp-sdk/stream-bridge.ts
/**
 * One backend prompt as the runtime stream bus sees it (S4b spec §6.2.1): the
 * same AgentStreamEvent sequence the acpx client emits per prompt
 * (spawn-client-session.ts), built from the backend's turn events. The idle
 * watchdog and in-flight usage read it through onStreamActivity.
 *
 * call_ended is "success" or "error" only, as acpx (D2-g). The stream is an
 * observer: a throwing listener is logged and never reaches the turn.
 */
import { randomUUID } from "node:crypto";
import type { AgentStreamEvent, TurnEvent, TurnEventSink } from "@nathapp/nax-agent";
import { getSafeLogger } from "@/logger";

export interface StreamContext {
  readonly emit: ((event: AgentStreamEvent) => void) | undefined;
  readonly agentName: string;
  readonly sessionName: string;
  /** From OpenSessionOpts.toolAudit.header; "" when the opener supplied none (D2-h). */
  readonly runId: string;
  readonly storyId: string | undefined;
  readonly model: string;
  readonly timeoutSeconds: number;
  /** The live agent process's pid, when known (S4b-3 wires it from onProcess). */
  readonly pid: () => number | undefined;
}

export interface CallBridge {
  readonly callId: string;
  /** The backend's onTurnEvent for this prompt. */
  readonly sink: TurnEventSink;
  /** True once the prompt produced visible text or a tool call (S4b-3 promptRetries reads it). */
  sideEffects(): boolean;
  /** Tells the idle watchdog this call waits on a person (§6.2.1). */
  awaitingHuman(): void;
  /** Emits agent.call_ended once; later calls and events are ignored. */
  end(status: "success" | "error"): void;
}

type UsageEvent = Extract<TurnEvent, { type: "usage" }>;

type Activity =
  | { readonly kind: "agent.message_update"; readonly deltaBytes: number }
  | { readonly kind: "agent.thinking_update"; readonly deltaBytes: number }
  | { readonly kind: "agent.tool_call_update"; readonly toolName?: string }
  | {
      readonly kind: "agent.usage_update";
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly costUsd?: number;
      readonly cacheRead?: number;
      readonly cacheWrite?: number;
      readonly cadence: "agent";
    };

function toolUpdate(toolName: string | undefined): Activity {
  return toolName === undefined ? { kind: "agent.tool_call_update" } : { kind: "agent.tool_call_update", toolName };
}

function usageActivity(event: UsageEvent): Activity {
  return {
    kind: "agent.usage_update",
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
    // An unpriced prompt carries costUsd 0, which is not a cost (turn-event.ts).
    ...(event.costSource === "reported" ? { costUsd: event.costUsd } : {}),
    ...(event.cacheRead === undefined ? {} : { cacheRead: event.cacheRead }),
    ...(event.cacheWrite === undefined ? {} : { cacheWrite: event.cacheWrite }),
    // The delegated agent's cadence, never nax's round-trip loop (nax#2045).
    cadence: "agent",
  };
}

function activityOf(event: TurnEvent, toolNames: Map<string, string>): Activity | undefined {
  switch (event.type) {
    case "text_delta":
      return { kind: "agent.message_update", deltaBytes: Buffer.byteLength(event.text, "utf8") };
    case "thinking_delta":
      return { kind: "agent.thinking_update", deltaBytes: Buffer.byteLength(event.text, "utf8") };
    case "tool_call":
      toolNames.set(event.callId, event.name);
      return toolUpdate(event.name);
    case "tool_progress":
      // An ACP heartbeat while a tool runs: activity for the watchdog (S4b-0 finding f).
      return toolUpdate(toolNames.get(event.callId));
    case "tool_result": {
      const name = toolNames.get(event.callId);
      toolNames.delete(event.callId);
      return toolUpdate(name);
    }
    case "usage":
      return usageActivity(event);
    case "stream_reset":
    case "compaction":
      return undefined;
  }
}

function sender(ctx: StreamContext): (event: AgentStreamEvent) => void {
  return (event) => {
    if (ctx.emit === undefined) return;
    try {
      ctx.emit(event);
    } catch (err) {
      getSafeLogger()?.debug("acp-sdk", "A stream listener threw; the turn continues", {
        sessionName: ctx.sessionName,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
}

export function startCall(ctx: StreamContext, now: () => number = Date.now): CallBridge {
  const callId = randomUUID();
  const send = sender(ctx);
  const base = {
    callId,
    runId: ctx.runId,
    agentName: ctx.agentName,
    sessionName: ctx.sessionName,
    ...(ctx.storyId === undefined ? {} : { storyId: ctx.storyId }),
  };
  const toolNames = new Map<string, string>();
  let ended = false;
  let sideEffects = false;
  send({ ...base, kind: "agent.call_started", model: ctx.model, timeoutSeconds: ctx.timeoutSeconds, timestamp: now() });
  const pid = ctx.pid();
  if (pid !== undefined) send({ ...base, kind: "agent.process_update", status: "spawned", pid, timestamp: now() });
  return {
    callId,
    sink: (event) => {
      if (ended) return;
      if (event.type === "text_delta" || event.type === "tool_call") sideEffects = true;
      const activity = activityOf(event, toolNames);
      if (activity !== undefined) send({ ...base, ...activity, timestamp: now() });
    },
    sideEffects: () => sideEffects,
    awaitingHuman: () => {
      if (!ended) send({ ...base, kind: "agent.awaiting_human", timestamp: now() });
    },
    end: (status) => {
      if (ended) return;
      ended = true;
      send({ ...base, kind: "agent.call_ended", status, timestamp: now() });
    },
  };
}
```

If TypeScript does not narrow `{ ...base, ...activity, timestamp }` to `AgentStreamEvent`, give `activityOf` the return type `Activity | undefined` (already) and annotate the spread as `const event: AgentStreamEvent = { ...base, ...activity, timestamp: now() };` before `send(event)`. Do not cast.

- [ ] **Step 4: Run the test**

Run: `timeout 30 bun test test/unit/agents/acp-sdk/stream-bridge.test.ts --timeout=5000`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agents/acp-sdk/stream-bridge.ts test/unit/agents/acp-sdk/stream-bridge.test.ts
git commit -m "feat(agents): acp-sdk stream bridge to the watchdog event stream (S4b-2)"
```

---

### Task 6: `turn-slot.ts` and `ask-port.ts`

**Files:**
- Create: `packages/nax/src/agents/acp-sdk/turn-slot.ts`
- Create: `packages/nax/src/agents/acp-sdk/ask-port.ts`
- Test: `packages/nax/test/unit/agents/acp-sdk/turn-slot.test.ts`, `packages/nax/test/unit/agents/acp-sdk/ask-port.test.ts`

**Interfaces:**
- Consumes: `CallBridge` (Task 5).
- Produces (`turn-slot.ts`): `RunningTurn { signal; turnId; interactionHandler; call: CallBridge; consumeInteraction(): boolean; recordExchange(question: string, reply: string): void }`, `TurnSlot { current(); set(turn); clear(); signal(): AbortSignal; turnId(): string | undefined }`, `createTurnSlot(): TurnSlot`.
- Produces (`ask-port.ts`): `AWAITING_HUMAN_BEAT_MS = 30_000`, `createAskPort(slot: TurnSlot, beatMs?: number): SessionAskPort`.

- [ ] **Step 1: Write the failing tests**

```typescript
// test/unit/agents/acp-sdk/turn-slot.test.ts
import { describe, expect, test } from "bun:test";
import { NO_OP_INTERACTION_HANDLER } from "@nathapp/nax-agent";
import { startCall } from "@/agents/acp-sdk/stream-bridge";
import { createTurnSlot } from "@/agents/acp-sdk/turn-slot";

describe("createTurnSlot", () => {
  test("between turns: no turn, an unaborted signal, no turn id", () => {
    const slot = createTurnSlot();
    expect(slot.current()).toBeUndefined();
    expect(slot.signal().aborted).toBe(false);
    expect(slot.turnId()).toBeUndefined();
  });

  test("a running turn's signal and id are read through the slot until cleared", () => {
    const slot = createTurnSlot();
    const controller = new AbortController();
    slot.set({
      signal: controller.signal,
      turnId: "turn-1",
      interactionHandler: NO_OP_INTERACTION_HANDLER,
      call: startCall({
        emit: undefined,
        agentName: "claude",
        sessionName: "s",
        runId: "",
        storyId: undefined,
        model: "sonnet",
        timeoutSeconds: 1,
        pid: () => undefined,
      }),
      consumeInteraction: () => true,
      recordExchange: () => {},
    });
    expect(slot.signal()).toBe(controller.signal);
    expect(slot.turnId()).toBe("turn-1");
    slot.clear();
    expect(slot.current()).toBeUndefined();
    expect(slot.signal()).not.toBe(controller.signal);
  });
});
```

```typescript
// test/unit/agents/acp-sdk/ask-port.test.ts
import { describe, expect, test } from "bun:test";
import type { AdapterInteraction, InteractionHandler } from "@nathapp/nax-agent";
import { createAskPort } from "@/agents/acp-sdk/ask-port";
import type { CallBridge } from "@/agents/acp-sdk/stream-bridge";
import { createTurnSlot, type RunningTurn, type TurnSlot } from "@/agents/acp-sdk/turn-slot";

interface Harness {
  readonly slot: TurnSlot;
  readonly beats: () => number;
  readonly exchanges: Array<{ question: string; reply: string }>;
  readonly controller: AbortController;
}

function harness(handler: InteractionHandler, budget = 5): Harness {
  const slot = createTurnSlot();
  let beats = 0;
  let left = budget;
  const exchanges: Array<{ question: string; reply: string }> = [];
  const controller = new AbortController();
  const call: CallBridge = {
    callId: "c1",
    sink: () => {},
    sideEffects: () => false,
    awaitingHuman: () => {
      beats++;
    },
    end: () => {},
  };
  const turn: RunningTurn = {
    signal: controller.signal,
    turnId: "t1",
    interactionHandler: handler,
    call,
    consumeInteraction: () => {
      if (left === 0) return false;
      left--;
      return true;
    },
    recordExchange: (question, reply) => exchanges.push({ question, reply }),
  };
  slot.set(turn);
  return { slot, beats: () => beats, exchanges, controller };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("createAskPort (S4b spec §6.3)", () => {
  test("askQuestion routes to the interaction handler as a question and records the exchange", async () => {
    const asked: AdapterInteraction[] = [];
    const h = harness({
      onInteraction: async (interaction) => {
        asked.push(interaction);
        return { answer: "blue" };
      },
    });
    const reply = await createAskPort(h.slot).askQuestion("Which colour?");
    expect(reply).toBe("blue");
    expect(asked).toEqual([{ kind: "question", text: "Which colour?" }]);
    expect(h.exchanges).toEqual([{ question: "Which colour?", reply: "blue" }]);
  });

  test("no running turn, or a spent budget, answers null without asking", async () => {
    let asked = 0;
    const handler: InteractionHandler = {
      onInteraction: async () => {
        asked++;
        return { answer: "x" };
      },
    };
    expect(await createAskPort(createTurnSlot()).askQuestion("q?")).toBeNull();
    expect(await createAskPort(harness(handler, 0).slot).askQuestion("q?")).toBeNull();
    expect(asked).toBe(0);
  });

  test("a handler with no reply, or a throwing handler, answers null", async () => {
    expect(await createAskPort(harness({ onInteraction: async () => null }).slot).askQuestion("q?")).toBeNull();
    const throwing = harness({
      onInteraction: async () => {
        throw new Error("webhook down");
      },
    });
    expect(await createAskPort(throwing.slot).askQuestion("q?")).toBeNull();
  });

  test("the awaiting-human beat runs while waiting and stops when the reply settles (Review Focus 4)", async () => {
    let release: (answer: string) => void = () => {};
    const h = harness({
      onInteraction: () =>
        new Promise((resolve) => {
          release = (answer) => resolve({ answer });
        }),
    });
    const pending = createAskPort(h.slot, 10).askQuestion("q?");
    await sleep(45);
    expect(h.beats()).toBeGreaterThanOrEqual(3);
    release("done");
    expect(await pending).toBe("done");
    const settled = h.beats();
    await sleep(40);
    expect(h.beats()).toBe(settled);
  });

  test("the turn's abort, or the caller's extra signal, ends the wait with null", async () => {
    const hang: InteractionHandler = { onInteraction: () => new Promise(() => {}) };
    const byTurn = harness(hang);
    const first = createAskPort(byTurn.slot, 1_000).askQuestion("q?");
    byTurn.controller.abort();
    expect(await first).toBeNull();
    const extra = new AbortController();
    const second = createAskPort(harness(hang).slot, 1_000).askQuestion("q?", { signal: extra.signal });
    extra.abort();
    expect(await second).toBeNull();
  });

  test("requestApproval denies (ask is never mapped); the other members are inert", async () => {
    const port = createAskPort(createTurnSlot());
    expect(await port.requestApproval({ tool: "Edit", summary: "edit", reason: "r" })).toEqual({
      decision: "deny",
      decidedBy: "profile",
    });
    expect(() => port.recordAutoDecision({ tool: "Edit", summary: "edit", reason: "r" }, "deny")).not.toThrow();
    expect(() => port.noteQuestion("note")).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `timeout 30 bun test test/unit/agents/acp-sdk/turn-slot.test.ts test/unit/agents/acp-sdk/ask-port.test.ts --timeout=5000`
Expected: FAIL (modules not found).

- [ ] **Step 3: Implement**

```typescript
// src/agents/acp-sdk/turn-slot.ts
/**
 * The adapter's current-turn slot (S4b spec §6.1 step 2, §6.2 step 3.2). The
 * turn loop sets it around each backend prompt; the backend reads its signal and
 * turn id through BackendOpenContext, and the ask port reads the rest. Between
 * prompts it holds nothing and the signal never aborts.
 */
import type { InteractionHandler } from "@nathapp/nax-agent";
import type { CallBridge } from "./stream-bridge";

export interface RunningTurn {
  readonly signal: AbortSignal;
  readonly turnId: string;
  readonly interactionHandler: InteractionHandler;
  readonly call: CallBridge;
  /** Takes one unit of the loop's shared interaction budget; false when it is spent (§6.3). */
  readonly consumeInteraction: () => boolean;
  /** Records an answered question in the loop's TurnResult.interactions. */
  readonly recordExchange: (question: string, reply: string) => void;
}

export interface TurnSlot {
  current(): RunningTurn | undefined;
  set(turn: RunningTurn): void;
  clear(): void;
  /** The running prompt's signal, or a never-aborting one between prompts. */
  signal(): AbortSignal;
  turnId(): string | undefined;
}

/** Never aborted: what the backend reads between prompts. */
const IDLE_SIGNAL: AbortSignal = new AbortController().signal;

export function createTurnSlot(): TurnSlot {
  let running: RunningTurn | undefined;
  return {
    current: () => running,
    set: (turn) => {
      running = turn;
    },
    clear: () => {
      running = undefined;
    },
    signal: () => running?.signal ?? IDLE_SIGNAL,
    turnId: () => running?.turnId,
  };
}
```

```typescript
// src/agents/acp-sdk/ask-port.ts
/**
 * nax's SessionAskPort for the ACP backend (S4b spec §6.3). nax never maps a
 * session to profile `ask`, so requestApproval is a logged deny. An agent's ACP
 * question (elicitation) goes to the run's interaction handler as a question,
 * on the same budget as the loop's own interactions, with the awaiting-human
 * beat running so the idle watchdog does not cancel a turn waiting on a person.
 * recordAutoDecision only logs in S4b-2; S4b-3 writes the tool-audit row (D2-k).
 */
import type { SessionAskPort } from "@nathapp/nax-agent";
import { getSafeLogger } from "@/logger";
import { awaitInteractionReply } from "../interaction";
import type { RunningTurn, TurnSlot } from "./turn-slot";

const STAGE = "acp-sdk";

/** How often a pending ACP question tells the idle watchdog the turn waits on a person (900 s idle default). */
export const AWAITING_HUMAN_BEAT_MS = 30_000;

/**
 * Emits agent.awaiting_human now and every beatMs until stopped. setTimeout, not
 * Bun.sleep: the pending timer is cleared the moment the reply settles.
 */
function beatWhileWaiting(turn: RunningTurn, beatMs: number): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const beat = (): void => {
    turn.call.awaitingHuman();
    timer = setTimeout(beat, beatMs);
  };
  beat();
  return () => clearTimeout(timer);
}

async function askQuestion(
  slot: TurnSlot,
  text: string,
  extra: AbortSignal | undefined,
  beatMs: number,
): Promise<string | null> {
  const turn = slot.current();
  if (turn === undefined || !turn.consumeInteraction()) return null;
  const signal = extra === undefined ? turn.signal : AbortSignal.any([turn.signal, extra]);
  const stopBeats = beatWhileWaiting(turn, beatMs);
  try {
    const reply = await awaitInteractionReply(
      { interactionHandler: turn.interactionHandler, signal, stage: STAGE },
      { kind: "question", text },
      ": ",
    );
    if (reply.kind !== "answered") return null;
    turn.recordExchange(text, reply.answer);
    return reply.answer;
  } finally {
    stopBeats();
  }
}

export function createAskPort(slot: TurnSlot, beatMs: number = AWAITING_HUMAN_BEAT_MS): SessionAskPort {
  return {
    requestApproval: async (req) => {
      getSafeLogger()?.warn(STAGE, "ACP approval requested, but nax never opens a session under profile ask; denied", {
        tool: req.tool,
      });
      return { decision: "deny", decidedBy: "profile" };
    },
    recordAutoDecision: (req, decision) => {
      if (decision === "deny") {
        getSafeLogger()?.debug(STAGE, "ACP request denied by the session profile", { tool: req.tool, reason: req.reason });
      }
    },
    askQuestion: (text, opts) => askQuestion(slot, text, opts?.signal, beatMs),
    noteQuestion: (text) => {
      getSafeLogger()?.debug(STAGE, "ACP agent note", { text });
    },
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `timeout 30 bun test test/unit/agents/acp-sdk/ --timeout=5000`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agents/acp-sdk test/unit/agents/acp-sdk
git commit -m "feat(agents): acp-sdk turn slot and ask port (S4b-2)"
```

---

### Task 7: `open-context.ts`

**Files:**
- Create: `packages/nax/src/agents/acp-sdk/open-context.ts`
- Test: `packages/nax/test/unit/agents/acp-sdk/open-context.test.ts`

**Interfaces:**
- Consumes: `acpProfileFor` (Task 3), `TurnSlot` (Task 6).
- Produces: `backendEnv(modelEnv?: Readonly<Record<string, string>>): Record<string, string>`, `backendOptions(agent: AcpAgentName, opts: OpenSessionOpts): AcpBackendOptions`, `transcriptStoreFor(dir: string | undefined): TranscriptStore`, `OpenContextInput { name; opts; store; resume: TranscriptDoc | undefined; asks; slot; openSignal }`, `openContext(input: OpenContextInput): BackendOpenContext`.

- [ ] **Step 1: Write the failing test**

```typescript
// test/unit/agents/acp-sdk/open-context.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { createMemoryTranscriptStore, type OpenSessionOpts } from "@nathapp/nax-agent";
import { createAskPort } from "@/agents/acp-sdk/ask-port";
import { backendEnv, backendOptions, openContext, transcriptStoreFor } from "@/agents/acp-sdk/open-context";
import { createTurnSlot } from "@/agents/acp-sdk/turn-slot";

const OPTS: OpenSessionOpts = {
  agentName: "claude",
  workdir: "/repo",
  resolvedPermissions: { mode: "approve-all", bashApproval: "raw" },
  modelDef: { provider: "anthropic", model: "sonnet[high]", env: { ANTHROPIC_BASE_URL: "https://proxy.example" } },
  timeoutSeconds: 600,
  toolAudit: { dir: "/audit", header: { runId: "r1", featureName: "f", storyId: "US-001", sessionRole: "implementer" } },
};

const saved: Record<string, string | undefined> = {};
function setEnv(key: string, value: string): void {
  saved[key] = process.env[key];
  process.env[key] = value;
}
afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    delete saved[key];
  }
});

describe("backendEnv (spec §6.1 step 3)", () => {
  test("is nax's allowlist plus the model env, all strings", () => {
    setEnv("CLAUDE_TEST_ALLOWED", "yes");
    setEnv("UNRELATED_SECRET", "no");
    const env = backendEnv({ ANTHROPIC_BASE_URL: "https://proxy.example" });
    expect(env.CLAUDE_TEST_ALLOWED).toBe("yes");
    expect(env.ANTHROPIC_BASE_URL).toBe("https://proxy.example");
    expect(env.UNRELATED_SECRET).toBeUndefined();
    expect(Object.values(env).every((v) => typeof v === "string")).toBe(true);
  });

  test("drops a variable whose name the backend's option schema rejects (Review Focus 5)", () => {
    setEnv("CLAUDE_X-Y", "1");
    expect(backendEnv()).not.toHaveProperty("CLAUDE_X-Y");
  });
});

describe("backendOptions", () => {
  test("strips the effort suffix from the model and never inherits the whole env", () => {
    const options = backendOptions("claude", OPTS);
    expect(options).toMatchObject({ agent: "claude", allowUnsandboxed: true, model: "sonnet", inheritEnv: false });
    expect(options.env?.ANTHROPIC_BASE_URL).toBe("https://proxy.example");
  });

  test("an empty model id sets no model option", () => {
    expect(backendOptions("claude", { ...OPTS, modelDef: { provider: "anthropic", model: "" } })).not.toHaveProperty(
      "model",
    );
  });
});

describe("openContext (spec §6.1 step 2)", () => {
  test("maps the session: profile, no tools, no instructions, metadata from the audit header", () => {
    const slot = createTurnSlot();
    const store = createMemoryTranscriptStore();
    const closer = new AbortController();
    const ctx = openContext({
      name: "nax-s",
      opts: OPTS,
      store,
      resume: undefined,
      asks: createAskPort(slot),
      slot,
      openSignal: closer.signal,
    });
    expect(ctx).toMatchObject({
      sessionId: "nax-s",
      workdir: "/repo",
      profile: "full",
      instructions: undefined,
      tools: [],
      resume: undefined,
      turnTimeoutSeconds: 600,
      metadata: { feature: "f", storyId: "US-001", role: "implementer" },
    });
    expect(ctx.transcriptStore).toBe(store);
    expect(ctx.openSignal).toBe(closer.signal);
    expect(ctx.turnSignal().aborted).toBe(false);
    expect(ctx.currentTurnId()).toBeUndefined();
  });

  test("approve-reads opens read; a leftover document is passed as resume", () => {
    const slot = createTurnSlot();
    const doc = { savedAt: "2026-10-07T00:00:00Z", messages: [] };
    const ctx = openContext({
      name: "nax-s",
      opts: { ...OPTS, resolvedPermissions: { mode: "approve-reads", bashApproval: "raw" }, toolAudit: undefined },
      store: createMemoryTranscriptStore(),
      resume: doc,
      asks: createAskPort(slot),
      slot,
      openSignal: new AbortController().signal,
    });
    expect(ctx.profile).toBe("read");
    expect(ctx.resume).toEqual({ doc });
    expect(ctx.metadata).toEqual({});
  });
});

describe("transcriptStoreFor", () => {
  test("no dir: an in-memory store", async () => {
    const store = transcriptStoreFor(undefined);
    await store.save("s", { savedAt: "t", messages: [] });
    expect(await store.load("s")).toMatchObject({ savedAt: "t" });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `timeout 30 bun test test/unit/agents/acp-sdk/open-context.test.ts --timeout=5000`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```typescript
// src/agents/acp-sdk/open-context.ts
/**
 * What an ACP SDK session opens with (S4b spec §6.1 steps 2-3): the backend's
 * BackendOpenContext and its acpBackend options. nax keeps its own env
 * allowlist (agents/shared/env.ts) with inheritEnv false, puts everything in the
 * prompt (no instructions), registers no tools (B5) and enforces the turn
 * deadline itself, so turnTimeoutSeconds is informational. Model only: effort
 * is S4b-3; the probe found nax's model aliases offered verbatim (D2-a).
 */
import {
  type BackendOpenContext,
  createFileTranscriptStore,
  createMemoryTranscriptStore,
  type OpenSessionOpts,
  parseModelSpec,
  type SessionAskPort,
  type TranscriptDoc,
  type TranscriptStore,
} from "@nathapp/nax-agent";
import type { AcpAgentName, AcpBackendOptions } from "@nathapp/nax-agent-acp/client";
import { buildAllowedEnv } from "../shared/env";
import { acpProfileFor } from "./profile-map";
import type { TurnSlot } from "./turn-slot";

/** The backend's option schema accepts only these names (nax-agent-acp options.ts). */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** nax's agent env: the allowlist plus the model's env, minus anything the backend would reject. */
export function backendEnv(modelEnv?: Readonly<Record<string, string>>): Record<string, string> {
  const allowed = buildAllowedEnv(modelEnv === undefined ? undefined : { modelEnv: { ...modelEnv } });
  return Object.fromEntries(
    Object.entries(allowed).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === "string" && ENV_NAME.test(entry[0]) && !entry[1].includes("\u0000"),
    ),
  );
}

export function backendOptions(agent: AcpAgentName, opts: OpenSessionOpts): AcpBackendOptions {
  const { model } = parseModelSpec(opts.modelDef.model);
  return {
    agent,
    allowUnsandboxed: true,
    ...(model === "" ? {} : { model }),
    env: backendEnv(opts.modelDef.env),
    inheritEnv: false,
  };
}

/** SessionManager's per-feature transcript dir when it derived one; else memory (nothing to resume after a crash). */
export function transcriptStoreFor(dir: string | undefined): TranscriptStore {
  return dir === undefined ? createMemoryTranscriptStore() : createFileTranscriptStore(dir);
}

export interface OpenContextInput {
  readonly name: string;
  readonly opts: OpenSessionOpts;
  readonly store: TranscriptStore;
  /** A crash-leftover document to restore (§6.1, D2-j). */
  readonly resume: TranscriptDoc | undefined;
  readonly asks: SessionAskPort;
  readonly slot: TurnSlot;
  /** Aborted when the session starts closing. */
  readonly openSignal: AbortSignal;
}

function metadataOf(opts: OpenSessionOpts): Record<string, string> {
  const header = opts.toolAudit?.header;
  return {
    ...(header?.featureName === undefined ? {} : { feature: header.featureName }),
    ...(header?.storyId === undefined ? {} : { storyId: header.storyId }),
    ...(header?.sessionRole === undefined ? {} : { role: header.sessionRole }),
  };
}

export function openContext(input: OpenContextInput): BackendOpenContext {
  const { name, opts, slot } = input;
  return {
    sessionId: name,
    workdir: opts.workdir,
    profile: acpProfileFor(opts.resolvedPermissions.mode),
    instructions: undefined,
    tools: [],
    transcriptStore: input.store,
    resume: input.resume === undefined ? undefined : { doc: input.resume },
    asks: input.asks,
    turnSignal: () => slot.signal(),
    currentTurnId: () => slot.turnId(),
    turnTimeoutSeconds: opts.timeoutSeconds,
    metadata: metadataOf(opts),
    openSignal: input.openSignal,
  };
}
```

- [ ] **Step 4: Run the test**

Run: `timeout 30 bun test test/unit/agents/acp-sdk/open-context.test.ts --timeout=5000`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agents/acp-sdk/open-context.ts test/unit/agents/acp-sdk/open-context.test.ts
git commit -m "feat(agents): acp-sdk open context, backend options and agent env (S4b-2)"
```

---

### Task 8: `session.ts` and the fake-agent test helper

**Files:**
- Create: `packages/nax/src/agents/acp-sdk/session.ts`
- Create: `packages/nax/test/helpers/acp-fake-agent/index.ts`
- Test: `packages/nax/test/unit/agents/acp-sdk/session.test.ts`

**Interfaces:**
- Consumes: Tasks 5-7.
- Produces (`session.ts`):
  - `_acpSdkDeps: { acpBackend(options: AcpBackendOptions): SessionBackend; isAgentLaunchable(agent: AcpAgentName): boolean; resolveRateCard(modelId: string): Promise<RateCard>; cwdExists(dir: string): Promise<boolean> }`
  - `AcpSdkSession { name; agent; opts; handle: SessionHandle; store; slot; asks; closer: AbortController; rateCard; stream: StreamContext; opened: OpenedBackend (mutable); turnInFlight: boolean (mutable); unlinkRun: () => void }`
  - `createSession(name: string, agent: AcpAgentName, opts: OpenSessionOpts): Promise<AcpSdkSession>`
  - `shutdownSession(session: AcpSdkSession, waitMs: number, signal?: AbortSignal): Promise<void>`
  - `reopenFresh(session: AcpSdkSession): Promise<void>`
  - `closeDeadlineMs(opts: OpenSessionOpts): number`
- Produces (test helper, imported as `@test/helpers/acp-fake-agent`): `FAKE_ACP_AGENT_MAIN`, `fakeAcpBackend(script, recordPath)`, `readFakeRecords(path)`, `fakeMethods(path)`, `fakeStartPids(path)`, `waitUntil(predicate, timeoutMs?)`, `ScriptedTurn`, `scriptedOpened(turns)`, `replyTurn(output, spend?)`, `hangTurn(spend?)`, `failTurn(err, spend?)`.

- [ ] **Step 1: Write the test helper**

```typescript
// test/helpers/acp-fake-agent/index.ts
/**
 * Test doubles for the ACP SDK adapter (S4b-2 D2-e).
 *
 * The fake ACP agent is nax-agent-acp's own (packages/nax-agent-acp/test/fixtures/
 * fake-agent), run as a subprocess. It is reached by file path, never imported:
 * nax may import nax-agent-acp only through ./client. The script is JSON in
 * FAKE_AGENT_SCRIPT (see that package's script.ts for the shape); every request
 * the agent receives is appended to FAKE_AGENT_RECORD.
 *
 * scriptedOpened() is an in-memory OpenedBackend for the turn loop's unit tests.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type AgentSessionAdapter,
  attachTurnSpend,
  NO_OP_INTERACTION_HANDLER,
  type OpenedBackend,
  type SendTurnOpts,
  type SessionBackend,
  type TurnResult,
} from "@nathapp/nax-agent";
import { type AcpBackendOptions, acpBackend } from "@nathapp/nax-agent-acp/client";

export const FAKE_ACP_AGENT_MAIN = join(import.meta.dir, "../../../../nax-agent-acp/test/fixtures/fake-agent/main.ts");

/** Claude's config as the fake offers it (fake-agent/script.ts CLAUDE_CONFIG_OPTIONS, plus haiku and opus). */
export const FAKE_CLAUDE_CONFIG_OPTIONS = [
  {
    id: "mode",
    name: "Mode",
    category: "mode",
    type: "select",
    currentValue: "default",
    options: [
      { value: "default", name: "Default" },
      { value: "acceptEdits", name: "Accept edits" },
      { value: "plan", name: "Plan" },
    ],
  },
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "default",
    options: [
      { value: "default", name: "Default" },
      { value: "sonnet", name: "Sonnet" },
      { value: "haiku", name: "Haiku" },
      { value: "opus", name: "Opus" },
    ],
  },
];

/** acpBackend with the registered agent's launch replaced by the fake; its registry entry still applies. */
export function fakeAcpBackend(
  script: Record<string, unknown>,
  recordPath: string,
): (options: AcpBackendOptions) => SessionBackend {
  const scriptJson = JSON.stringify({ configOptions: FAKE_CLAUDE_CONFIG_OPTIONS, ...script });
  return (options) =>
    acpBackend({
      ...options,
      command: process.execPath,
      args: [FAKE_ACP_AGENT_MAIN],
      env: { ...options.env, FAKE_AGENT_SCRIPT: scriptJson, FAKE_AGENT_RECORD: recordPath },
    });
}

export interface FakeRecord {
  readonly method: string;
  readonly params: unknown;
}

export function readFakeRecords(path: string): FakeRecord[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as FakeRecord);
}

export function fakeMethods(path: string): string[] {
  return readFakeRecords(path).map((record) => record.method);
}

/** The pid of every agent process launched against this record file, in order. */
export function fakeStartPids(path: string): number[] {
  return readFakeRecords(path)
    .filter((record) => record.method === "start")
    .map((record) => {
      const params = record.params;
      return typeof params === "object" && params !== null && "pid" in params && typeof params.pid === "number"
        ? params.pid
        : -1;
    });
}

export async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitUntil: condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

export type ScriptedTurn = (prompt: string, opts: SendTurnOpts) => Promise<TurnResult>;

export interface SpendStub {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
}

const DEFAULT_SPEND: SpendStub = { inputTokens: 10, outputTokens: 5, costUsd: 0.01 };

/** A backend prompt that ends end_turn with `output` and a reported cost. */
export function replyTurn(output: string, spend: SpendStub = DEFAULT_SPEND): ScriptedTurn {
  return async () => ({
    output,
    tokenUsage: { inputTokens: spend.inputTokens, outputTokens: spend.outputTokens },
    estimatedCostUsd: spend.costUsd,
    costSource: "reported",
    internalRoundTrips: 1,
  });
}

function attach(err: object, spend: SpendStub): void {
  attachTurnSpend(err, {
    tokenUsage: { inputTokens: spend.inputTokens, outputTokens: spend.outputTokens },
    costUsd: spend.costUsd,
    costSource: "reported",
  });
}

/** Runs until the prompt's signal aborts, then throws the signal's reason with the spend attached (as the backend does). */
export function hangTurn(spend: SpendStub = DEFAULT_SPEND): ScriptedTurn {
  return (_prompt, opts) =>
    new Promise((_resolve, reject) => {
      const signal = opts.signal;
      if (signal === undefined) return;
      const fail = (): void => {
        const reason: unknown = signal.reason;
        const err = reason instanceof Error ? reason : new Error("aborted");
        attach(err, spend);
        reject(err);
      };
      if (signal.aborted) fail();
      else signal.addEventListener("abort", fail, { once: true });
    });
}

/** A backend prompt that fails with `err`, spend attached. */
export function failTurn(err: Error, spend: SpendStub = DEFAULT_SPEND): ScriptedTurn {
  return async () => {
    attach(err, spend);
    throw err;
  };
}

export interface ScriptedOpened {
  readonly opened: OpenedBackend;
  /** The prompts sent, in order. */
  readonly prompts: string[];
  /** The SendTurnOpts each prompt was sent with. */
  readonly sent: SendTurnOpts[];
  closeCount(): number;
}

/** An in-memory OpenedBackend running `turns` in order; the last one repeats. */
export function scriptedOpened(turns: readonly ScriptedTurn[]): ScriptedOpened {
  const prompts: string[] = [];
  const sent: SendTurnOpts[] = [];
  let closes = 0;
  let next = 0;
  const handle = { id: "backend-handle", agentName: "acp:claude" };
  const adapter: AgentSessionAdapter = {
    openSession: async () => handle,
    sendTurn: (_handle, prompt, opts) => {
      prompts.push(prompt);
      sent.push(opts);
      const turn = turns[Math.min(next, turns.length - 1)];
      next++;
      if (turn === undefined) return Promise.reject(new Error("scriptedOpened: no turns"));
      return turn(prompt, opts);
    },
    closeSession: async () => {},
  };
  const opened: OpenedBackend = {
    adapter,
    handle,
    info: { kind: "acp:claude", capabilities: {} },
    turnOpts: () => ({ interactionHandler: NO_OP_INTERACTION_HANDLER }),
    close: async () => {
      closes++;
    },
  };
  return { opened, prompts, sent, closeCount: () => closes };
}
```

If `check:test-escape-hatches` counts the `as FakeRecord` in `readFakeRecords`, replace it with a narrowing function that checks `typeof method === "string"`; do not raise the baseline.

- [ ] **Step 2: Write the failing test**

```typescript
// test/unit/agents/acp-sdk/session.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFileTranscriptStore, isProcessAlive, type OpenSessionOpts } from "@nathapp/nax-agent";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { fakeAcpBackend, fakeMethods, fakeStartPids, waitUntil } from "@test/helpers/acp-fake-agent";
import { _acpSdkDeps, createSession, reopenFresh, shutdownSession } from "@/agents/acp-sdk/session";
import { FALLBACK_RATES } from "@/agents/cost";

const REAL = { ..._acpSdkDeps };
let dir = "";
let record = "";
let transcripts = "";

beforeEach(() => {
  dir = makeTempDir("acp-sdk-session-");
  record = join(dir, "record.jsonl");
  transcripts = join(dir, "sessions");
  _acpSdkDeps.resolveRateCard = async () => ({ rates: FALLBACK_RATES, source: "fallback-rates" });
});

afterEach(() => {
  Object.assign(_acpSdkDeps, REAL);
  cleanupTempDir(dir);
});

function opts(overrides: Partial<OpenSessionOpts> = {}): OpenSessionOpts {
  return {
    agentName: "claude",
    workdir: dir,
    resolvedPermissions: { mode: "approve-all", bashApproval: "raw" },
    modelDef: { provider: "anthropic", model: "sonnet" },
    timeoutSeconds: 60,
    transcriptDir: transcripts,
    trackedSpawnDeadlineMs: 2_000,
    ...overrides,
  };
}

function useFake(script: Record<string, unknown> = {}): void {
  _acpSdkDeps.acpBackend = fakeAcpBackend(script, record);
}

const RESUMABLE = { capabilities: { sessionCapabilities: { resume: {} } } };

describe("createSession (spec §6.1)", () => {
  test("opens a fresh session: model set, handle carries the ACP session id, document saved", async () => {
    useFake();
    const session = await createSession("nax-s1", "claude", opts({ modelTier: "balanced" }));
    expect(session.handle).toMatchObject({
      id: "nax-s1",
      agentName: "claude",
      protocolIds: { sessionId: "fake-session-1", recordId: "fake-session-1" },
      modelTier: "balanced",
    });
    expect(fakeMethods(record)).toContain("session/new");
    expect(fakeMethods(record)).toContain("session/set_config_option");
    expect(await createFileTranscriptStore(transcripts).load("nax-s1")).toMatchObject({ backend: "acp:claude" });
    await shutdownSession(session, 2_000);
  }, 20_000);

  test("a matching crash-leftover document is resumed, not recreated", async () => {
    useFake(RESUMABLE);
    await createFileTranscriptStore(transcripts).save("nax-s2", {
      backend: "acp:claude",
      acp: { agentSessionId: "fake-session-1", agent: "claude", cwd: dir },
      savedAt: "2026-10-07T00:00:00Z",
      messages: [],
    });
    const session = await createSession("nax-s2", "claude", opts());
    expect(fakeMethods(record)).toContain("session/resume");
    expect(fakeMethods(record)).not.toContain("session/new");
    await shutdownSession(session, 2_000);
  }, 20_000);

  test("a leftover for another agent is discarded and the session opens fresh (D2-j)", async () => {
    useFake(RESUMABLE);
    await createFileTranscriptStore(transcripts).save("nax-s3", {
      backend: "acp:claude",
      acp: { agentSessionId: "fake-session-1", agent: "codex", cwd: dir },
      savedAt: "2026-10-07T00:00:00Z",
      messages: [],
    });
    const session = await createSession("nax-s3", "claude", opts());
    expect(fakeMethods(record)).toContain("session/new");
    expect(fakeMethods(record)).not.toContain("session/resume");
    await shutdownSession(session, 2_000);
  }, 20_000);

  test("a native transcript under the same name is discarded (Review Focus 2)", async () => {
    useFake(RESUMABLE);
    await createFileTranscriptStore(transcripts).save("nax-s4", { savedAt: "2026-10-07T00:00:00Z", messages: [] });
    const session = await createSession("nax-s4", "claude", opts());
    expect(fakeMethods(record)).toContain("session/new");
    expect(await createFileTranscriptStore(transcripts).load("nax-s4")).toMatchObject({ backend: "acp:claude" });
    await shutdownSession(session, 2_000);
  }, 20_000);

  test("a leftover the agent no longer knows is discarded after NOT_FOUND", async () => {
    useFake(RESUMABLE);
    await createFileTranscriptStore(transcripts).save("nax-s5", {
      backend: "acp:claude",
      acp: { agentSessionId: "gone-session", agent: "claude", cwd: dir },
      savedAt: "2026-10-07T00:00:00Z",
      messages: [],
    });
    const session = await createSession("nax-s5", "claude", opts());
    expect(fakeMethods(record)).toEqual(expect.arrayContaining(["session/resume", "session/new"]));
    expect(session.handle.protocolIds?.sessionId).toBe("fake-session-1");
    await shutdownSession(session, 2_000);
  }, 20_000);

  test("an unreadable leftover is discarded", async () => {
    useFake();
    await createFileTranscriptStore(transcripts).save("nax-s6", { savedAt: "t", messages: [] });
    writeFileSync(join(transcripts, "nax-s6.transcript.json"), "{ not json", "utf8");
    const session = await createSession("nax-s6", "claude", opts());
    expect(fakeMethods(record)).toContain("session/new");
    await shutdownSession(session, 2_000);
  }, 20_000);

  test("an open failure that is not a leftover problem propagates", async () => {
    useFake({ newSessionFailure: { code: -32603, message: "boom" } });
    await expect(createSession("nax-s7", "claude", opts())).rejects.toMatchObject({
      code: "AGENT_SESSION_BACKEND_UNAVAILABLE",
    });
  }, 20_000);
});

describe("shutdownSession and reopenFresh", () => {
  test("close ends the agent process and deletes the document", async () => {
    useFake();
    const session = await createSession("nax-c1", "claude", opts());
    const [pid] = fakeStartPids(record);
    await shutdownSession(session, 2_000);
    expect(session.closer.signal.aborted).toBe(true);
    await waitUntil(() => pid !== undefined && !isProcessAlive(pid));
    expect(await createFileTranscriptStore(transcripts).load("nax-c1")).toBeNull();
  }, 20_000);

  test("reopenFresh closes the old process and opens a new session without resume (D2-l)", async () => {
    useFake(RESUMABLE);
    const session = await createSession("nax-c2", "claude", opts());
    const before = session.opened;
    await reopenFresh(session);
    expect(session.opened).not.toBe(before);
    expect(fakeStartPids(record)).toHaveLength(2);
    expect(fakeMethods(record).filter((m) => m === "session/new")).toHaveLength(2);
    expect(fakeMethods(record)).not.toContain("session/resume");
    await shutdownSession(session, 2_000);
  }, 20_000);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `timeout 90 bun test test/unit/agents/acp-sdk/session.test.ts --timeout=20000`
Expected: FAIL (module not found).

- [ ] **Step 4: Implement**

```typescript
// src/agents/acp-sdk/session.ts
/**
 * One ACP SDK session (S4b spec §6.1): its opened backend, the state the turn
 * loop and the ask port share, and the open, re-open and close paths.
 *
 * Lifecycle parity with acpx: SessionManager owns reuse, close really closes and
 * deletes the transcript document, and a document present at open is a crash
 * leftover (an earlier process died without closing). The leftover is passed
 * to the backend as `resume`; the backend rejects a backend, agent or cwd
 * mismatch before spawning, and those rejections (or an unreadable document, or
 * an agent that no longer knows the session) discard it and open fresh (D2-j).
 */
import { stat } from "node:fs/promises";
import type {
  OpenedBackend,
  OpenSessionOpts,
  ProtocolIds,
  SessionAskPort,
  SessionBackend,
  SessionHandle,
  TranscriptDoc,
  TranscriptStore,
} from "@nathapp/nax-agent";
import {
  type AcpAgentName,
  type AcpBackendOptions,
  acpBackend,
  isAgentLaunchable,
} from "@nathapp/nax-agent-acp/client";
import { NaxError } from "@/errors";
import { getSafeLogger } from "@/logger";
import { type RateCard, resolveRateCard } from "../cost";
import { createAskPort } from "./ask-port";
import { backendOptions, openContext, transcriptStoreFor } from "./open-context";
import type { StreamContext } from "./stream-bridge";
import { createTurnSlot, type TurnSlot } from "./turn-slot";

const STAGE = "acp-sdk";

/** `agent.acp.trackedSpawnDeadlineMs`'s schema default, used only when the opener passes none. */
const DEFAULT_CLOSE_DEADLINE_MS = 10_000;

/** A leftover the backend cannot restore: deleted, then the session opens fresh (D2-j). */
const DISCARD_CODES: ReadonlySet<string> = new Set([
  "AGENT_SESSION_BACKEND_MISMATCH",
  "AGENT_SESSION_INVALID_OPTIONS",
  "AGENT_SESSION_NOT_FOUND",
  "TRANSCRIPT_CORRUPT",
]);

/** Test seam. Production always uses the package functions. */
export const _acpSdkDeps = {
  acpBackend: (options: AcpBackendOptions): SessionBackend => acpBackend(options),
  isAgentLaunchable: (agent: AcpAgentName): boolean => isAgentLaunchable(agent),
  resolveRateCard: (modelId: string): Promise<RateCard> => resolveRateCard(modelId),
  async cwdExists(dir: string): Promise<boolean> {
    try {
      return (await stat(dir)).isDirectory();
    } catch {
      // Missing or unreadable: the open fails SESSION_CWD_MISSING either way.
      return false;
    }
  },
};

export interface AcpSdkSession {
  readonly name: string;
  readonly agent: AcpAgentName;
  readonly opts: OpenSessionOpts;
  readonly handle: SessionHandle;
  readonly store: TranscriptStore;
  readonly slot: TurnSlot;
  readonly asks: SessionAskPort;
  /** Aborted when the session starts closing: the backend's openSignal, and an abort for a running prompt. */
  readonly closer: AbortController;
  readonly rateCard: RateCard;
  readonly stream: StreamContext;
  /** Replaced by mid-turn NO_SESSION recovery (§6.2 step 3.5); the nax handle never changes. */
  opened: OpenedBackend;
  turnInFlight: boolean;
  /** Detaches the run signal from `closer`. */
  readonly unlinkRun: () => void;
}

type OpenBase = Pick<AcpSdkSession, "name" | "agent" | "opts" | "store" | "slot" | "asks" | "closer">;

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isDiscardable(err: unknown): err is NaxError {
  return err instanceof NaxError && DISCARD_CODES.has(err.code);
}

async function discard(store: TranscriptStore, name: string): Promise<void> {
  await store.delete(name).catch((err: unknown) => {
    getSafeLogger()?.warn(STAGE, "Could not delete the ACP session's transcript document", {
      sessionName: name,
      error: errorText(err),
    });
  });
}

async function openBackend(base: OpenBase, resume: TranscriptDoc | undefined): Promise<OpenedBackend> {
  const backend = _acpSdkDeps.acpBackend(backendOptions(base.agent, base.opts));
  return backend.open(
    openContext({
      name: base.name,
      opts: base.opts,
      store: base.store,
      resume,
      asks: base.asks,
      slot: base.slot,
      openSignal: base.closer.signal,
    }),
  );
}

async function loadLeftover(store: TranscriptStore, name: string): Promise<TranscriptDoc | undefined> {
  try {
    return (await store.load(name)) ?? undefined;
  } catch (err) {
    getSafeLogger()?.info(STAGE, "A crash-leftover transcript is unreadable; discarding it", {
      sessionName: name,
      error: errorText(err),
    });
    await discard(store, name);
    return undefined;
  }
}

async function openWithLeftover(base: OpenBase): Promise<OpenedBackend> {
  const leftover = await loadLeftover(base.store, base.name);
  if (leftover === undefined) return openBackend(base, undefined);
  try {
    return await openBackend(base, leftover);
  } catch (err) {
    if (!isDiscardable(err)) throw err;
    getSafeLogger()?.info(STAGE, "A crash-leftover session cannot be restored; opening fresh", {
      sessionName: base.name,
      code: err.code,
    });
    await discard(base.store, base.name);
    return openBackend(base, undefined);
  }
}

/** acpx's record id has no ACP equivalent: both fields carry the ACP session id (spec §11 item 3). */
async function protocolIdsOf(store: TranscriptStore, name: string): Promise<ProtocolIds> {
  const doc = await store.load(name).catch(() => null);
  const id = doc?.acp?.agentSessionId ?? null;
  return { recordId: id, sessionId: id };
}

function linkRunSignal(signal: AbortSignal | undefined, closer: AbortController): () => void {
  if (signal === undefined) return () => {};
  const onAbort = (): void => closer.abort(signal.reason);
  if (signal.aborted) {
    onAbort();
    return () => {};
  }
  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}

function streamContextOf(name: string, opts: OpenSessionOpts): StreamContext {
  const header = opts.toolAudit?.header;
  return {
    emit: opts.onStreamActivity,
    agentName: opts.agentName,
    sessionName: name,
    runId: header?.runId ?? "",
    storyId: header?.storyId,
    model: opts.modelDef.model,
    timeoutSeconds: opts.timeoutSeconds,
    pid: () => undefined,
  };
}

export async function createSession(name: string, agent: AcpAgentName, opts: OpenSessionOpts): Promise<AcpSdkSession> {
  const slot = createTurnSlot();
  const closer = new AbortController();
  const unlinkRun = linkRunSignal(opts.signal, closer);
  const base: OpenBase = {
    name,
    agent,
    opts,
    store: transcriptStoreFor(opts.transcriptDir),
    slot,
    asks: createAskPort(slot),
    closer,
  };
  try {
    const rateCard = await _acpSdkDeps.resolveRateCard(opts.modelDef.model);
    const opened = await openWithLeftover(base);
    const protocolIds = await protocolIdsOf(base.store, name);
    const handle: SessionHandle = Object.freeze({
      id: name,
      agentName: opts.agentName,
      protocolIds,
      modelDef: opts.modelDef,
      ...(opts.modelTier === undefined ? {} : { modelTier: opts.modelTier }),
    });
    return { ...base, handle, rateCard, stream: streamContextOf(name, opts), opened, turnInFlight: false, unlinkRun };
  } catch (err) {
    unlinkRun();
    throw err;
  }
}

export function closeDeadlineMs(opts: OpenSessionOpts): number {
  return opts.trackedSpawnDeadlineMs ?? DEFAULT_CLOSE_DEADLINE_MS;
}

/**
 * Waits for `work` up to `waitMs` (or until `signal` aborts). setTimeout, not
 * Bun.sleep: the timer is cleared as soon as either settles. A close that
 * outlives the wait keeps running; the backend kills the process group itself.
 */
async function settleWithin(work: Promise<void>, waitMs: number, signal?: AbortSignal): Promise<"done" | "cut"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const cut = new Promise<"cut">((resolve) => {
    timer = setTimeout(() => resolve("cut"), waitMs);
    onAbort = () => resolve("cut");
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  const settled = work.then(
    () => "done" as const,
    (err: unknown) => {
      getSafeLogger()?.warn(STAGE, "Closing the ACP agent failed", { error: errorText(err) });
      return "done" as const;
    },
  );
  try {
    return await Promise.race([settled, cut]);
  } finally {
    clearTimeout(timer);
    if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
  }
}

/** Spec §6.1 close: abort a running prompt, close bounded by the teardown deadline, delete the document. */
export async function shutdownSession(session: AcpSdkSession, waitMs: number, signal?: AbortSignal): Promise<void> {
  session.closer.abort();
  session.unlinkRun();
  const outcome = await settleWithin(session.opened.close(), waitMs, signal);
  if (outcome === "cut") {
    getSafeLogger()?.warn(STAGE, "The ACP agent did not close within the teardown deadline", {
      sessionName: session.name,
      waitMs,
    });
  }
  // S4b-3: flush the tool-audit sink here, before the document goes.
  await discard(session.store, session.name);
}

/** Mid-turn NO_SESSION recovery (§6.2 step 3.5): a fresh session under the same name, never a resume (D2-l). */
export async function reopenFresh(session: AcpSdkSession): Promise<void> {
  await settleWithin(session.opened.close(), closeDeadlineMs(session.opts));
  await discard(session.store, session.name);
  session.opened = await openBackend(session, undefined);
}
```

- [ ] **Step 5: Run the test**

Run: `timeout 90 bun test test/unit/agents/acp-sdk/session.test.ts --timeout=20000`
Expected: PASS. If the NOT_FOUND case fails because the fake answers `session/resume` for an unknown id with a code nax-agent-acp maps differently, print the error code (`.rejects` on a direct `openBackend`) and add exactly that code to `DISCARD_CODES` only if it means "unknown session"; report it in the task summary.

- [ ] **Step 6: Commit**

```bash
git add src/agents/acp-sdk/session.ts test/helpers/acp-fake-agent test/unit/agents/acp-sdk/session.test.ts
git commit -m "feat(agents): acp-sdk session open with crash-leftover policy, re-open and close (S4b-2)"
```

---

### Task 9: `turn-loop.ts`

**Files:**
- Create: `packages/nax/src/agents/acp-sdk/turn-loop.ts`
- Test: `packages/nax/test/unit/agents/acp-sdk/turn-loop.test.ts`

**Interfaces:**
- Consumes: `AcpSdkSession`, `reopenFresh`, `_acpSdkDeps` (Task 8); `startCall` (Task 5); `classifyTurnFailure`, `turnFailureError`, `RunAborted`, `TurnDeadlineExpired`, `WatchdogCancel` (Task 4); `Spend` helpers (Task 4); `awaitInteractionReply`, `extractContextToolCall`, `extractQuestion`, `toContextToolInteraction` (`agents/interaction`, S4b-1); `assembleTurnResult`, `warnWallClockTimeout` (`agents/turn`, S4b-1).
- Produces: `runTurnLoop(session: AcpSdkSession, prompt: string, opts: SendTurnOpts): Promise<TurnResult>`.

- [ ] **Step 1: Write the failing test**

```typescript
// test/unit/agents/acp-sdk/turn-loop.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import {
  type AdapterInteraction,
  AgentSessionError,
  type AgentStreamEvent,
  createMemoryTranscriptStore,
  type InteractionHandler,
  type OpenedBackend,
  type OpenSessionOpts,
  SessionTurnError,
} from "@nathapp/nax-agent";
import { failTurn, hangTurn, replyTurn, scriptedOpened } from "@test/helpers/acp-fake-agent";
import { createAskPort } from "@/agents/acp-sdk/ask-port";
import { _acpSdkDeps, type AcpSdkSession } from "@/agents/acp-sdk/session";
import { runTurnLoop } from "@/agents/acp-sdk/turn-loop";
import { createTurnSlot } from "@/agents/acp-sdk/turn-slot";
import { FALLBACK_RATES } from "@/agents/cost";

const REAL = { ..._acpSdkDeps };
afterEach(() => {
  Object.assign(_acpSdkDeps, REAL);
});

interface Built {
  readonly session: AcpSdkSession;
  readonly events: AgentStreamEvent[];
  readonly cancels: Array<() => Promise<void>>;
}

function build(opened: OpenedBackend, overrides: Partial<OpenSessionOpts> = {}): Built {
  const events: AgentStreamEvent[] = [];
  const cancels: Array<() => Promise<void>> = [];
  const slot = createTurnSlot();
  const opts: OpenSessionOpts = {
    agentName: "claude",
    workdir: "/repo",
    resolvedPermissions: { mode: "approve-all", bashApproval: "raw" },
    modelDef: { provider: "anthropic", model: "sonnet" },
    timeoutSeconds: 60,
    onActiveCall: (_callId, cancel) => cancels.push(cancel),
    ...overrides,
  };
  const session: AcpSdkSession = {
    name: "nax-loop",
    agent: "claude",
    opts,
    handle: { id: "nax-loop", agentName: "claude" },
    store: createMemoryTranscriptStore(),
    slot,
    asks: createAskPort(slot),
    closer: new AbortController(),
    rateCard: { rates: FALLBACK_RATES, source: "fallback-rates" },
    stream: {
      emit: (e) => events.push(e),
      agentName: "claude",
      sessionName: "nax-loop",
      runId: "r",
      storyId: undefined,
      model: "sonnet",
      timeoutSeconds: 60,
      pid: () => undefined,
    },
    opened,
    turnInFlight: false,
    unlinkRun: () => {},
  };
  return { session, events, cancels };
}

function answering(...answers: string[]): InteractionHandler & { readonly asked: AdapterInteraction[] } {
  const asked: AdapterInteraction[] = [];
  return {
    asked,
    onInteraction: async (interaction) => {
      asked.push(interaction);
      const answer = answers.shift();
      return answer === undefined ? null : { answer };
    },
  };
}

const NONE = answering();

describe("runTurnLoop: success paths (spec §6.2)", () => {
  test("one prompt: output, tokens, reported cost, card-priced estimate", async () => {
    const script = scriptedOpened([replyTurn("done")]);
    const { session, events } = build(script.opened);
    const result = await runTurnLoop(session, "do it", { interactionHandler: NONE });
    expect(result).toMatchObject({
      output: "done",
      tokenUsage: { inputTokens: 10, outputTokens: 5 },
      exactCostUsd: 0.01,
      internalRoundTrips: 1,
      timedOut: false,
      pricingSource: "fallback-rates",
    });
    expect(result.estimatedCostUsd).toBeGreaterThan(0);
    expect(script.prompts).toEqual(["do it"]);
    expect(events.map((e) => e.kind)).toEqual(["agent.call_started", "agent.call_ended"]);
    expect(events[1]).toMatchObject({ status: "success" });
  });

  test("the backend gets the slot's signal, a turn id and the bridge sink", async () => {
    const script = scriptedOpened([replyTurn("ok")]);
    const { session } = build(script.opened);
    await runTurnLoop(session, "p", { interactionHandler: NONE, turnId: "turn-9" });
    expect(script.sent[0]).toMatchObject({ turnId: "turn-9" });
    expect(script.sent[0]?.signal).toBeDefined();
    expect(script.sent[0]?.onTurnEvent).toBeDefined();
    expect(session.slot.current()).toBeUndefined();
  });

  test("a <nax_tool_call> is answered through the handler and sent back; spend sums", async () => {
    const script = scriptedOpened([
      replyTurn('<nax_tool_call name="query_rag">{"q":"x"}</nax_tool_call>'),
      replyTurn("final"),
    ]);
    const handler = answering("<nax_tool_result>found</nax_tool_result>");
    const { session } = build(script.opened);
    const result = await runTurnLoop(session, "start", { interactionHandler: handler });
    expect(handler.asked).toEqual([{ kind: "context-tool", name: "query_rag", input: { q: "x" } }]);
    expect(script.prompts).toEqual(["start", "<nax_tool_result>found</nax_tool_result>"]);
    expect(result).toMatchObject({ output: "final", internalRoundTrips: 2, tokenUsage: { inputTokens: 20 } });
    expect(result.exactCostUsd).toBeCloseTo(0.02);
  });

  test("a trailing question is answered and recorded in interactions", async () => {
    const script = scriptedOpened([replyTurn("I made a plan.\n\nShould I proceed with the refactor?"), replyTurn("ok")]);
    const { session } = build(script.opened);
    const result = await runTurnLoop(session, "go", { interactionHandler: answering("yes") });
    expect(result.interactions).toEqual([
      { turnIndex: 1, question: "I made a plan.\n\nShould I proceed with the refactor?", reply: "yes" },
    ]);
    expect(script.prompts[1]).toBe("yes");
  });

  test("no reply ends the loop with the question as output", async () => {
    const script = scriptedOpened([replyTurn("Should I proceed with the refactor?")]);
    const { session } = build(script.opened);
    const result = await runTurnLoop(session, "go", { interactionHandler: NONE });
    expect(result).toMatchObject({ output: "Should I proceed with the refactor?", internalRoundTrips: 1 });
  });

  test("the shared budget bounds the loop", async () => {
    const script = scriptedOpened([replyTurn("Should I proceed with the refactor?")]);
    const { session } = build(script.opened);
    const result = await runTurnLoop(session, "go", {
      interactionHandler: answering("a", "b", "c", "d"),
      maxInteractions: 2,
    });
    expect(script.prompts).toHaveLength(2);
    expect(result.internalRoundTrips).toBe(2);
  });
});

describe("runTurnLoop: deadline, cancel and abort (spec §6.2, §7.1)", () => {
  test("the deadline returns timedOut with empty output and the spend so far", async () => {
    const script = scriptedOpened([hangTurn({ inputTokens: 7, outputTokens: 1, costUsd: 0.003 })]);
    const { session } = build(script.opened, { timeoutSeconds: 0.05 });
    const result = await runTurnLoop(session, "slow", { interactionHandler: NONE });
    expect(result).toMatchObject({ timedOut: true, output: "", tokenUsage: { inputTokens: 7 } });
    expect(result.exactCostUsd).toBeCloseTo(0.003);
  });

  test("the watchdog's cancel throws fail-stale, cancelled, retryable, with spend", async () => {
    const script = scriptedOpened([hangTurn()]);
    const built = build(script.opened);
    const pending = runTurnLoop(built.session, "p", { interactionHandler: NONE });
    while (built.cancels.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    await built.cancels[0]?.();
    const err = await pending.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SessionTurnError);
    expect(err).toMatchObject({ cancelled: true, retryable: true, tokenUsage: { inputTokens: 10 } });
    expect((err as SessionTurnError).adapterFailure?.outcome).toBe("fail-stale");
    expect(built.events.at(-1)).toMatchObject({ kind: "agent.call_ended", status: "error" });
  });

  test("a run abort mid-prompt throws fail-aborted, not retryable (D2-c)", async () => {
    const script = scriptedOpened([hangTurn()]);
    const { session } = build(script.opened);
    const run = new AbortController();
    const pending = runTurnLoop(session, "p", { interactionHandler: NONE, signal: run.signal });
    await new Promise((resolve) => setTimeout(resolve, 10));
    run.abort("shutdown");
    await expect(pending).rejects.toMatchObject({ cancelled: true, retryable: false });
  });

  test("the session closing mid-prompt aborts the prompt (Review Focus 1)", async () => {
    const script = scriptedOpened([hangTurn()]);
    const { session } = build(script.opened);
    const pending = runTurnLoop(session, "p", { interactionHandler: NONE });
    await new Promise((resolve) => setTimeout(resolve, 10));
    session.closer.abort();
    const err = await pending.catch((e: unknown) => e);
    expect((err as SessionTurnError).adapterFailure?.outcome).toBe("fail-aborted");
  });

  test("an already-aborted run signal sends nothing", async () => {
    const script = scriptedOpened([replyTurn("never")]);
    const { session } = build(script.opened);
    await expect(
      runTurnLoop(session, "p", { interactionHandler: NONE, signal: AbortSignal.abort("gone") }),
    ).rejects.toBeInstanceOf(SessionTurnError);
    expect(script.prompts).toEqual([]);
  });
});

describe("runTurnLoop: failures", () => {
  test("AGENT_SESSION_NOT_FOUND re-opens fresh once and resends; the dead attempt is not counted", async () => {
    const first = scriptedOpened([failTurn(new AgentSessionError("gone", "AGENT_SESSION_NOT_FOUND"))]);
    const second = scriptedOpened([replyTurn("recovered")]);
    _acpSdkDeps.acpBackend = () => ({ kind: "acp:claude", open: async () => second.opened });
    const { session } = build(first.opened);
    const result = await runTurnLoop(session, "p", { interactionHandler: NONE });
    expect(result).toMatchObject({ output: "recovered", internalRoundTrips: 1 });
    expect(first.closeCount()).toBe(1);
    expect(second.prompts).toEqual(["p"]);
    expect(session.opened).toBe(second.opened);
    expect(result.tokenUsage.inputTokens).toBe(20);
  });

  test("a second NOT_FOUND is not recovered again", async () => {
    const notFound = () => failTurn(new AgentSessionError("gone", "AGENT_SESSION_NOT_FOUND"));
    const first = scriptedOpened([notFound()]);
    const second = scriptedOpened([notFound()]);
    _acpSdkDeps.acpBackend = () => ({ kind: "acp:claude", open: async () => second.opened });
    const { session } = build(first.opened);
    await expect(runTurnLoop(session, "p", { interactionHandler: NONE })).rejects.toBeInstanceOf(SessionTurnError);
  });

  test("any other failure throws SessionTurnError fail-unknown with the summed spend", async () => {
    const script = scriptedOpened([
      replyTurn('<nax_tool_call name="t">{}</nax_tool_call>'),
      failTurn(new Error("agent exploded")),
    ]);
    const { session } = build(script.opened);
    const err = await runTurnLoop(session, "p", { interactionHandler: answering("r") }).catch((e: unknown) => e);
    expect(err).toMatchObject({ cancelled: false, retryable: false, message: "agent exploded" });
    expect((err as SessionTurnError).tokenUsage?.inputTokens).toBe(20);
    expect((err as SessionTurnError).adapterFailure?.outcome).toBe("fail-unknown");
  });

  test("a second concurrent turn on the session is refused", async () => {
    const script = scriptedOpened([hangTurn()]);
    const { session } = build(script.opened, { timeoutSeconds: 0.2 });
    const first = runTurnLoop(session, "a", { interactionHandler: NONE });
    await expect(runTurnLoop(session, "b", { interactionHandler: NONE })).rejects.toMatchObject({
      code: "ACP_SDK_TURN_IN_FLIGHT",
    });
    await first;
  });
});
```

The `(err as SessionTurnError)` reads are narrowing after an `instanceof` / `toMatchObject` check. If `check:test-escape-hatches` counts them, narrow with `if (!(err instanceof SessionTurnError)) throw err;` before the field read instead; do not raise the baseline.

- [ ] **Step 2: Run the test to verify it fails**

Run: `timeout 60 bun test test/unit/agents/acp-sdk/turn-loop.test.ts --timeout=10000`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```typescript
// src/agents/acp-sdk/turn-loop.ts
/**
 * nax's turn loop on the ACP SDK transport (S4b spec §6.2): the acpx loop
 * (agents/acp/adapter-send-turn.ts) with the acpx prompt swapped for the
 * backend's single-prompt sendTurn. Kept from acpx:
 * - one deadline spans the loop; expiry aborts the prompt and returns
 *   TurnResult{ timedOut: true, output: "" } with the spend so far;
 * - a <nax_tool_call> or a trailing question goes to the interaction handler
 *   (5-minute reply race) and the reply is the next prompt; the agent's own ACP
 *   questions (ask-port.ts) draw on the same maxInteractions budget;
 * - AGENT_SESSION_NOT_FOUND re-opens the session fresh once and resends, the
 *   dead attempt uncounted (acpx exit code 4);
 * - one TurnResult for the loop: last output, summed spend, round trips.
 * Any other failure throws SessionTurnError with the spend of every prompt
 * (BUG-57). promptRetries is S4b-3.
 */
import { randomUUID } from "node:crypto";
import { createTurnDeadline, type InteractionExchange, type SendTurnOpts } from "@nathapp/nax-agent";
import { NaxError } from "@/errors";
import { getSafeLogger } from "@/logger";
import {
  awaitInteractionReply,
  extractContextToolCall,
  extractQuestion,
  type InteractionReply,
  type InteractionReplyContext,
  toContextToolInteraction,
} from "../interaction";
import { assembleTurnResult, warnWallClockTimeout } from "../turn";
import type { TurnResult } from "../types";
import { classifyTurnFailure, RunAborted, TurnDeadlineExpired, turnFailureError, WatchdogCancel } from "./failure-map";
import { addSpend, NO_SPEND, type Spend, spendOfError, spendOfResult } from "./pricing";
import { type AcpSdkSession, reopenFresh } from "./session";
import { startCall } from "./stream-bridge";

const STAGE = "acp-sdk";
const DEFAULT_MAX_INTERACTIONS = 10;

type Deadline = ReturnType<typeof createTurnDeadline>;

interface LoopState {
  /** Backend prompts sent and counted: TurnResult.internalRoundTrips. */
  turnCount: number;
  /** ACP questions answered from the same budget (§6.3). */
  asked: number;
  spend: Spend;
  output: string;
  currentPrompt: string;
  recovered: boolean;
  timedOut: boolean;
  readonly interactions: InteractionExchange[];
}

interface Loop {
  readonly session: AcpSdkSession;
  readonly opts: SendTurnOpts;
  readonly max: number;
  readonly deadline: Deadline;
  readonly state: LoopState;
}

type IterationOutcome =
  | { readonly kind: "ok"; readonly output: string }
  | { readonly kind: "timed-out" }
  | { readonly kind: "reopened" };

function used(state: LoopState): number {
  return state.turnCount + state.asked;
}

function failed(loop: Loop, err: unknown, cause: unknown): Error {
  return turnFailureError(classifyTurnFailure(err, cause), loop.state.spend, loop.session.rateCard);
}

function isSessionNotFound(err: unknown): boolean {
  return err instanceof NaxError && err.code === "AGENT_SESSION_NOT_FOUND";
}

function consumeInteraction(loop: Loop): boolean {
  if (used(loop.state) >= loop.max) return false;
  loop.state.asked++;
  return true;
}

function linkAborts(controller: AbortController, signals: readonly (AbortSignal | undefined)[]): () => void {
  const unlinks = signals
    .filter((signal): signal is AbortSignal => signal !== undefined)
    .map((signal) => {
      const onAbort = (): void => controller.abort(new RunAborted(signal.reason));
      if (signal.aborted) {
        onAbort();
        return () => {};
      }
      signal.addEventListener("abort", onAbort, { once: true });
      return () => signal.removeEventListener("abort", onAbort);
    });
  return () => {
    for (const unlink of unlinks) unlink();
  };
}

/** setTimeout, not Bun.sleep: the timer is cleared when the prompt settles. */
function armDeadline(
  controller: AbortController,
  remainingMs: number | undefined,
): ReturnType<typeof setTimeout> | undefined {
  if (remainingMs === undefined) return undefined;
  return setTimeout(() => controller.abort(new TurnDeadlineExpired()), remainingMs);
}

async function afterFailure(loop: Loop, err: unknown, cause: unknown): Promise<IterationOutcome> {
  if (cause instanceof TurnDeadlineExpired) return { kind: "timed-out" };
  if (cause !== undefined || !isSessionNotFound(err) || loop.state.recovered) throw failed(loop, err, cause);
  loop.state.recovered = true;
  getSafeLogger()?.info(STAGE, "ACP session not found mid-turn; re-opening it fresh", {
    sessionName: loop.session.name,
  });
  try {
    await reopenFresh(loop.session);
  } catch (reopenErr) {
    getSafeLogger()?.warn(STAGE, "Re-opening the ACP session failed", {
      sessionName: loop.session.name,
      error: reopenErr instanceof Error ? reopenErr.message : String(reopenErr),
    });
    throw failed(loop, err, undefined);
  }
  loop.state.turnCount--;
  return { kind: "reopened" };
}

async function runIteration(loop: Loop): Promise<IterationOutcome> {
  const { session, opts, state } = loop;
  const controller = new AbortController();
  const unlink = linkAborts(controller, [opts.signal, session.closer.signal]);
  if (controller.signal.aborted) {
    unlink();
    throw failed(loop, undefined, controller.signal.reason);
  }
  const timer = armDeadline(controller, loop.deadline.remainingMs());
  const call = startCall(session.stream);
  const turnId = opts.turnId ?? randomUUID();
  session.opts.onActiveCall?.(call.callId, async () => controller.abort(new WatchdogCancel()));
  session.slot.set({
    signal: controller.signal,
    turnId,
    interactionHandler: opts.interactionHandler,
    call,
    consumeInteraction: () => consumeInteraction(loop),
    recordExchange: (question, reply) => {
      state.interactions.push({ turnIndex: state.turnCount, question, reply });
    },
  });
  try {
    const result = await session.opened.adapter.sendTurn(session.opened.handle, state.currentPrompt, {
      ...session.opened.turnOpts(),
      signal: controller.signal,
      turnId,
      onTurnEvent: call.sink,
    });
    call.end("success");
    state.spend = addSpend(state.spend, spendOfResult(result));
    return { kind: "ok", output: result.output };
  } catch (err) {
    call.end("error");
    state.spend = addSpend(state.spend, spendOfError(err));
    return await afterFailure(loop, err, controller.signal.aborted ? controller.signal.reason : undefined);
  } finally {
    clearTimeout(timer);
    unlink();
    session.slot.clear();
  }
}

function replyContext(loop: Loop): InteractionReplyContext {
  return { interactionHandler: loop.opts.interactionHandler, signal: loop.opts.signal, stage: STAGE };
}

function answerOf(loop: Loop, reply: InteractionReply): string | undefined {
  if (reply.kind === "answered") return reply.answer;
  if (reply.kind === "aborted") throw failed(loop, undefined, new RunAborted(loop.opts.signal?.reason));
  return undefined;
}

/** The next prompt: a context-tool result or a human reply; undefined ends the loop. */
async function nextPrompt(loop: Loop, output: string): Promise<string | undefined> {
  const toolCall = extractContextToolCall(output);
  if (toolCall !== null) {
    const reply = await awaitInteractionReply(replyContext(loop), toContextToolInteraction(toolCall), " for context-tool: ");
    return answerOf(loop, reply);
  }
  const question = extractQuestion(output);
  if (question === null) return undefined;
  const answer = answerOf(loop, await awaitInteractionReply(replyContext(loop), { kind: "question", text: question }, ": "));
  if (answer !== undefined) loop.state.interactions.push({ turnIndex: loop.state.turnCount, question, reply: answer });
  return answer;
}

function markTimedOut(loop: Loop): void {
  loop.state.timedOut = true;
  warnWallClockTimeout(loop.session.name, loop.session.opts.timeoutSeconds, STAGE);
}

async function runLoop(loop: Loop): Promise<TurnResult> {
  const { state } = loop;
  while (used(state) < loop.max) {
    if (loop.deadline.expired()) {
      markTimedOut(loop);
      break;
    }
    if (loop.opts.signal?.aborted) throw failed(loop, undefined, new RunAborted(loop.opts.signal.reason));
    state.turnCount++;
    const outcome = await runIteration(loop);
    if (outcome.kind === "reopened") continue;
    if (outcome.kind === "timed-out") {
      markTimedOut(loop);
      break;
    }
    state.output = outcome.output;
    const next = await nextPrompt(loop, outcome.output);
    if (next === undefined) break;
    state.currentPrompt = next;
  }
  if (used(state) >= loop.max && !state.timedOut && loop.max > 1) {
    getSafeLogger()?.warn(STAGE, "Interaction budget spent", {
      sessionName: loop.session.name,
      maxInteractions: loop.max,
    });
  }
  return assembleTurnResult({
    output: state.output,
    totalTokenUsage: state.spend.tokenUsage,
    totalExactCostUsd: state.spend.exactCostUsd,
    turnCount: state.turnCount,
    interactions: state.interactions,
    timedOut: state.timedOut,
    rateCard: loop.session.rateCard,
  });
}

export async function runTurnLoop(session: AcpSdkSession, prompt: string, opts: SendTurnOpts): Promise<TurnResult> {
  if (session.turnInFlight) {
    throw new NaxError(`ACP session "${session.name}" already has a turn in flight`, "ACP_SDK_TURN_IN_FLIGHT", {
      stage: STAGE,
      sessionName: session.name,
    });
  }
  session.turnInFlight = true;
  try {
    return await runLoop({
      session,
      opts,
      max: opts.maxInteractions ?? DEFAULT_MAX_INTERACTIONS,
      deadline: createTurnDeadline(session.opts.timeoutSeconds),
      state: {
        turnCount: 0,
        asked: 0,
        spend: NO_SPEND,
        output: "",
        currentPrompt: prompt,
        recovered: false,
        timedOut: false,
        interactions: [],
      },
    });
  } finally {
    session.turnInFlight = false;
  }
}
```

- [ ] **Step 4: Run the test**

Run: `timeout 60 bun test test/unit/agents/acp-sdk/turn-loop.test.ts --timeout=10000`
Expected: PASS.

Run: `bun run check:complexity`
Expected: pass. If `runLoop` or `runIteration` scores over 20, split the slot setup into `setRunningTurn(loop, controller, call, turnId)`; do not add a baseline entry.

- [ ] **Step 5: Commit**

```bash
git add src/agents/acp-sdk/turn-loop.ts test/unit/agents/acp-sdk/turn-loop.test.ts
git commit -m "feat(agents): acp-sdk turn loop with deadline, interactions and NO_SESSION recovery (S4b-2)"
```

---

### Task 10: `AcpSdkAgentAdapter`

**Files:**
- Create: `packages/nax/src/agents/acp-sdk/adapter.ts`
- Create: `packages/nax/src/agents/acp-sdk/index.ts`
- Test: `packages/nax/test/unit/agents/acp-sdk/adapter.test.ts`

**Interfaces:**
- Consumes: Tasks 3, 8, 9.
- Produces: `class AcpSdkAgentAdapter implements AgentAdapter` with `constructor(agentName: string)`. Barrel `src/agents/acp-sdk/index.ts` exports `AcpSdkAgentAdapter`, `ACP_SDK_AGENT_NAMES`, `acpSdkEntry`, `_acpSdkDeps`.

- [ ] **Step 1: Write the failing test**

```typescript
// test/unit/agents/acp-sdk/adapter.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  type AgentStreamEvent,
  isProcessAlive,
  NO_OP_INTERACTION_HANDLER,
  type OpenSessionOpts,
  SessionTurnError,
} from "@nathapp/nax-agent";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { fakeAcpBackend, fakeMethods, fakeStartPids, waitUntil } from "@test/helpers/acp-fake-agent";
import { _acpSdkDeps, AcpSdkAgentAdapter } from "@/agents/acp-sdk";
import { FALLBACK_RATES } from "@/agents/cost";

const REAL = { ..._acpSdkDeps };
let dir = "";
let record = "";

beforeEach(() => {
  dir = makeTempDir("acp-sdk-adapter-");
  record = join(dir, "record.jsonl");
  _acpSdkDeps.resolveRateCard = async () => ({ rates: FALLBACK_RATES, source: "fallback-rates" });
});

afterEach(() => {
  Object.assign(_acpSdkDeps, REAL);
  cleanupTempDir(dir);
});

function opts(overrides: Partial<OpenSessionOpts> = {}): OpenSessionOpts {
  return {
    agentName: "claude",
    workdir: dir,
    resolvedPermissions: { mode: "approve-all", bashApproval: "raw" },
    modelDef: { provider: "anthropic", model: "sonnet" },
    timeoutSeconds: 60,
    transcriptDir: join(dir, "sessions"),
    trackedSpawnDeadlineMs: 2_000,
    ...overrides,
  };
}

const PONG_TURN = {
  steps: [
    {
      kind: "update",
      update: { sessionUpdate: "usage_update", used: 100, size: 200_000, cost: { amount: 0.02, currency: "USD" } },
    },
    { kind: "text", text: "pong" },
  ],
  usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 },
};

describe("AcpSdkAgentAdapter over a real agent process", () => {
  test("open, one turn, close: output, spend, stream events, no process left", async () => {
    _acpSdkDeps.acpBackend = fakeAcpBackend({ turns: [PONG_TURN] }, record);
    const adapter = new AcpSdkAgentAdapter("claude");
    const events: AgentStreamEvent[] = [];
    const established: string[] = [];
    const handle = await adapter.openSession(
      "nax-a1",
      opts({
        onStreamActivity: (e) => events.push(e),
        onSessionEstablished: (ids, name) => established.push(`${name}:${ids.sessionId}`),
      }),
    );
    expect(handle).toMatchObject({ id: "nax-a1", agentName: "claude" });
    expect(established).toEqual(["nax-a1:fake-session-1"]);

    const result = await adapter.sendTurn(handle, "ping", { interactionHandler: NO_OP_INTERACTION_HANDLER });
    expect(result).toMatchObject({ output: "pong", tokenUsage: { inputTokens: 12, outputTokens: 3 } });
    expect(result.exactCostUsd).toBeCloseTo(0.02);
    expect(events.map((e) => e.kind)).toEqual(
      expect.arrayContaining(["agent.call_started", "agent.message_update", "agent.call_ended"]),
    );

    const [pid] = fakeStartPids(record);
    await adapter.closeSession(handle);
    await waitUntil(() => pid !== undefined && !isProcessAlive(pid));
    await expect(
      adapter.sendTurn(handle, "again", { interactionHandler: NO_OP_INTERACTION_HANDLER }),
    ).rejects.toMatchObject({ code: "ACP_SDK_SESSION_NOT_OPEN" });
  }, 30_000);

  test("closeSession during a running prompt ends the turn as fail-aborted (Review Focus 1)", async () => {
    _acpSdkDeps.acpBackend = fakeAcpBackend({ turns: [{ steps: [{ kind: "waitForCancel" }] }] }, record);
    const adapter = new AcpSdkAgentAdapter("claude");
    const handle = await adapter.openSession("nax-a2", opts());
    const pending = adapter.sendTurn(handle, "long", { interactionHandler: NO_OP_INTERACTION_HANDLER });
    await waitUntil(() => fakeMethods(record).includes("session/prompt"));
    await adapter.closeSession(handle);
    const err = await pending.catch((e: unknown) => e);
    if (!(err instanceof SessionTurnError)) throw err;
    expect(err.cancelled).toBe(true);
    expect(err.adapterFailure?.outcome).toBe("fail-aborted");
    const [pid] = fakeStartPids(record);
    await waitUntil(() => pid !== undefined && !isProcessAlive(pid));
  }, 30_000);

  test("a model the agent does not offer fails the open and leaves nothing (Review Focus 3)", async () => {
    _acpSdkDeps.acpBackend = fakeAcpBackend({}, record);
    const adapter = new AcpSdkAgentAdapter("claude");
    await expect(
      adapter.openSession("nax-a3", opts({ modelDef: { provider: "anthropic", model: "claude-sonnet-4-5" } })),
    ).rejects.toMatchObject({ code: "AGENT_SESSION_CAPABILITY_UNSUPPORTED" });
    await expect(
      adapter.sendTurn({ id: "nax-a3", agentName: "claude" }, "x", { interactionHandler: NO_OP_INTERACTION_HANDLER }),
    ).rejects.toMatchObject({ code: "ACP_SDK_SESSION_NOT_OPEN" });
    const [pid] = fakeStartPids(record);
    await waitUntil(() => pid !== undefined && !isProcessAlive(pid));
  }, 30_000);

  test("closePhysicalSession closes a live handle and ignores an unknown one", async () => {
    _acpSdkDeps.acpBackend = fakeAcpBackend({}, record);
    const adapter = new AcpSdkAgentAdapter("claude");
    await adapter.openSession("nax-a4", opts());
    await adapter.closePhysicalSession("not-open", dir);
    await adapter.closePhysicalSession("nax-a4", dir, { force: true });
    const [pid] = fakeStartPids(record);
    await waitUntil(() => pid !== undefined && !isProcessAlive(pid));
  }, 30_000);

  test("re-opening a live name closes the old session first", async () => {
    _acpSdkDeps.acpBackend = fakeAcpBackend({}, record);
    const adapter = new AcpSdkAgentAdapter("claude");
    await adapter.openSession("nax-a5", opts());
    const handle = await adapter.openSession("nax-a5", opts());
    const [firstPid] = fakeStartPids(record);
    await waitUntil(() => firstPid !== undefined && !isProcessAlive(firstPid));
    await adapter.closeSession(handle);
  }, 30_000);
});

describe("AcpSdkAgentAdapter without a process", () => {
  test("a missing workdir fails SESSION_CWD_MISSING before any spawn", async () => {
    _acpSdkDeps.acpBackend = fakeAcpBackend({}, record);
    await expect(
      new AcpSdkAgentAdapter("claude").openSession("nax-b1", opts({ workdir: join(dir, "missing") })),
    ).rejects.toMatchObject({ code: "SESSION_CWD_MISSING" });
    expect(fakeStartPids(record)).toEqual([]);
  });

  test("an aborted run signal fails before any spawn", async () => {
    _acpSdkDeps.acpBackend = fakeAcpBackend({}, record);
    await expect(
      new AcpSdkAgentAdapter("claude").openSession("nax-b2", opts({ signal: AbortSignal.abort("stop") })),
    ).rejects.toThrow();
    expect(fakeStartPids(record)).toEqual([]);
  });

  test("aider has no ACP launcher: it lists, never opens (spec §11 item 2)", async () => {
    const adapter = new AcpSdkAgentAdapter("aider");
    expect(adapter.displayName).toBe("ACP Agent");
    expect(await adapter.isInstalled()).toBe(false);
    await expect(adapter.openSession("nax-b3", opts({ agentName: "aider" }))).rejects.toMatchObject({
      code: "ACP_AGENT_UNSUPPORTED",
    });
  });

  test("isInstalled asks whether the agent's ACP launcher resolves", async () => {
    _acpSdkDeps.isAgentLaunchable = (agent) => agent === "claude";
    expect(await new AcpSdkAgentAdapter("claude").isInstalled()).toBe(true);
    expect(await new AcpSdkAgentAdapter("codex").isInstalled()).toBe(false);
  });

  test("identity rows match the entries; complete() waits for S4b-3", async () => {
    const adapter = new AcpSdkAgentAdapter("claude");
    expect(adapter).toMatchObject({ name: "claude", displayName: "Claude Code (ACP)", binary: "claude" });
    expect(adapter.capabilities.supportedTiers).toEqual(["fast", "balanced", "powerful"]);
    expect(adapter.buildCommand()).toEqual(["acp", "claude"]);
    expect(adapter.buildAllowedEnv().HOME).toBeDefined();
    await expect(
      adapter.complete("x", {
        modelDef: { provider: "anthropic", model: "sonnet" },
        workdir: dir,
        resolvedPermissions: { mode: "approve-all", bashApproval: "raw" },
      }),
    ).rejects.toMatchObject({ code: "ACP_SDK_COMPLETE_UNAVAILABLE" });
  });

  test("closeSession on an unknown handle is a no-op", async () => {
    await new AcpSdkAgentAdapter("claude").closeSession({ id: "never", agentName: "claude" });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `timeout 120 bun test test/unit/agents/acp-sdk/adapter.test.ts --timeout=30000`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```typescript
// src/agents/acp-sdk/adapter.ts
/**
 * AcpSdkAgentAdapter: nax's AgentAdapter over @nathapp/nax-agent-acp (S4b spec
 * §5.1), selected by agent.acp.transport = "sdk". It drives the backend's S1
 * adapter itself (D24, B6) with nax's turn loop around it. The live map routes
 * turns and closes from a nax handle id to its session; it is never used to
 * reuse a session, which SessionManager owns (§6.1).
 *
 * S4b-2 scope (D2-d): complete() lands in S4b-3, with promptRetries, the backend
 * deadline options, tool audit, effort and PID callbacks.
 */
import type { OpenSessionOpts, ProtocolIds } from "@nathapp/nax-agent";
import { NaxError } from "@/errors";
import { getSafeLogger } from "@/logger";
import { buildAllowedEnv } from "../shared/env";
import { throwIfAborted } from "../turn";
import type {
  AgentAdapter,
  AgentCapabilities,
  AgentRunOptions,
  CompleteResult,
  ResolvedCompleteOptions,
  SendTurnOpts,
  SessionHandle,
  TurnResult,
} from "../types";
import { type AcpSdkEntry, acpSdkEntry, UNSUPPORTED_ENTRY } from "./entries";
import { _acpSdkDeps, type AcpSdkSession, closeDeadlineMs, createSession, shutdownSession } from "./session";
import { runTurnLoop } from "./turn-loop";

const STAGE = "acp-sdk";

function notifyEstablished(opts: OpenSessionOpts, protocolIds: ProtocolIds | undefined, name: string): void {
  if (opts.onSessionEstablished === undefined || protocolIds === undefined) return;
  try {
    opts.onSessionEstablished(protocolIds, name);
  } catch (err) {
    getSafeLogger()?.warn(STAGE, "onSessionEstablished callback threw; continuing", {
      sessionName: name,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export class AcpSdkAgentAdapter implements AgentAdapter {
  readonly name: string;
  readonly displayName: string;
  /** The agent's own CLI, for display and `nax agents`' version probe (D2-f). */
  readonly binary: string;
  readonly capabilities: AgentCapabilities;
  private readonly entry: AcpSdkEntry | undefined;
  private readonly live = new Map<string, AcpSdkSession>();

  constructor(agentName: string) {
    this.entry = acpSdkEntry(agentName);
    const shown = this.entry ?? UNSUPPORTED_ENTRY;
    this.name = agentName;
    this.displayName = shown.displayName;
    this.binary = shown.binary;
    this.capabilities = {
      supportedTiers: shown.supportedTiers,
      maxContextTokens: shown.maxContextTokens,
      features: new Set<"tdd" | "review" | "refactor" | "batch">(["tdd", "review", "refactor"]),
    };
  }

  /** True when nax-agent-acp finds a launch candidate for the agent, the npx fallback included (spec §6.8). */
  async isInstalled(): Promise<boolean> {
    return this.entry !== undefined && _acpSdkDeps.isAgentLaunchable(this.entry.agent);
  }

  /** Display only: the backend resolves the launch command per session. */
  buildCommand(): string[] {
    return ["acp", this.name];
  }

  buildAllowedEnv(options?: AgentRunOptions): Record<string, string | undefined> {
    return buildAllowedEnv(options?.modelDef.env === undefined ? undefined : { modelEnv: options.modelDef.env });
  }

  complete(_prompt: string, _options: ResolvedCompleteOptions): Promise<CompleteResult> {
    return Promise.reject(
      new NaxError(
        `complete() on the ACP SDK transport lands in S4b-3 (agent "${this.name}"); use agent.acp.transport "acpx"`,
        "ACP_SDK_COMPLETE_UNAVAILABLE",
        { stage: STAGE, agentName: this.name },
      ),
    );
  }

  async openSession(name: string, opts: OpenSessionOpts): Promise<SessionHandle> {
    const entry = this.requireEntry(name);
    throwIfAborted(opts.signal, "Run aborted — shutdown in progress");
    await this.requireWorkdir(name, opts.workdir);
    const stale = this.live.get(name);
    if (stale !== undefined) {
      getSafeLogger()?.warn(STAGE, "An ACP session of this name was still open; closing it before opening fresh", {
        sessionName: name,
      });
      await this.closeSession(stale.handle);
    }
    getSafeLogger()?.info(STAGE, "Opening ACP session", {
      sessionName: name,
      agent: entry.agent,
      permission: opts.resolvedPermissions.mode,
    });
    const session = await createSession(name, entry.agent, opts);
    this.live.set(name, session);
    notifyEstablished(opts, session.handle.protocolIds, name);
    return session.handle;
  }

  async sendTurn(handle: SessionHandle, prompt: string, opts: SendTurnOpts): Promise<TurnResult> {
    return runTurnLoop(this.sessionFor(handle.id), prompt, opts);
  }

  async closeSession(handle: SessionHandle): Promise<void> {
    const session = this.live.get(handle.id);
    if (session === undefined) return;
    this.live.delete(handle.id);
    await shutdownSession(session, closeDeadlineMs(session.opts));
  }

  /** Closes a session this adapter opened; any other handle is a no-op (spec §11 item 6). */
  async closePhysicalSession(
    handle: string,
    _workdir: string,
    options?: { force?: boolean; signal?: AbortSignal },
  ): Promise<void> {
    const session = this.live.get(handle);
    if (session === undefined) {
      getSafeLogger()?.debug(STAGE, "No live ACP session for this handle; nothing to close", { sessionName: handle });
      return;
    }
    this.live.delete(handle);
    await shutdownSession(session, options?.force === true ? 0 : closeDeadlineMs(session.opts), options?.signal);
  }

  private requireEntry(sessionName: string): AcpSdkEntry {
    if (this.entry !== undefined) return this.entry;
    throw new NaxError(
      `Agent "${this.name}" has no ACP launcher; it cannot run on agent.acp.transport "sdk"`,
      "ACP_AGENT_UNSUPPORTED",
      { stage: STAGE, agentName: this.name, sessionName },
    );
  }

  private async requireWorkdir(sessionName: string, workdir: string): Promise<void> {
    if (await _acpSdkDeps.cwdExists(workdir)) return;
    throw new NaxError(
      `[acp-sdk] Session cwd does not exist: ${workdir} — cannot start agent "${this.name}". If this is a new package for the feature, ensure its directory is created before the run.`,
      "SESSION_CWD_MISSING",
      { stage: "open-session", agentName: this.name, cwd: workdir, sessionName },
    );
  }

  private sessionFor(id: string): AcpSdkSession {
    const session = this.live.get(id);
    if (session !== undefined) return session;
    throw new NaxError(`No open ACP session "${id}" on this adapter`, "ACP_SDK_SESSION_NOT_OPEN", {
      stage: STAGE,
      sessionName: id,
    });
  }
}
```

```typescript
// src/agents/acp-sdk/index.ts
export { AcpSdkAgentAdapter } from "./adapter";
export { ACP_SDK_AGENT_NAMES, acpSdkEntry } from "./entries";
export { _acpSdkDeps } from "./session";
```

- [ ] **Step 4: Run the tests**

Run: `timeout 120 bun test test/unit/agents/acp-sdk/ --timeout=30000`
Expected: PASS.

Run: `bun run typecheck && bun run check:import-cycles && bun run check:alias-internals`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/agents/acp-sdk test/unit/agents/acp-sdk
git commit -m "feat(agents): AcpSdkAgentAdapter open, turn and close over nax-agent-acp (S4b-2)"
```

---

### Task 11: Routing and consumers

**Files:**
- Modify: `packages/nax/src/agents/registry.ts` (imports, `adapterFor`, `createAgentRegistry`)
- Modify: `packages/nax/src/agents/index.ts:44` (registry export line)
- Modify: `packages/nax/src/cli/agents.ts:7-45`
- Modify: `packages/nax/src/bakeoff/preflight.ts:8-16`, `:36-66`, `:87-150`
- Modify: `packages/nax/src/bakeoff/coordinator.ts:34`, `:82`
- Modify: `packages/nax/scripts/check-adapter-no-config-import.sh:2`, `:11`
- Test: `packages/nax/test/unit/agents/registry-native.test.ts`, `packages/nax/test/unit/cli/agents-list.test.ts`, `packages/nax/test/unit/bakeoff/preflight.test.ts`, `packages/nax/test/unit/scripts/check-adapter-no-config-import.test.ts`

**Interfaces:**
- Consumes: `AcpSdkAgentAdapter`, `ACP_SDK_AGENT_NAMES`, `_acpSdkDeps` (Task 10); `AcpTransport`, `DEFAULT_ACP_TRANSPORT` (Task 2).
- Produces: `acpAdapterFor(name: string, transport: AcpTransport): AgentAdapter`, exported from `src/agents/registry.ts` and the `@/agents` barrel.
- Produces: `PreflightDeps.isInstalled: (agentName: string, transport: AcpTransport) => boolean | Promise<boolean>`, and `validateContestants(names, projectRoot, deps?, baseTransport?: AcpTransport)`.

- [ ] **Step 1: Write the failing tests**

Add to `test/unit/agents/registry-native.test.ts`:

```typescript
import { AcpSdkAgentAdapter } from "@/agents/acp-sdk";
import { acpAdapterFor } from "@/agents/registry";

describe("ACP transport routing (S4b spec §5.3)", () => {
  test("acpAdapterFor picks the adapter by transport", () => {
    expect(acpAdapterFor("claude", "acpx")).toBeInstanceOf(AcpAgentAdapter);
    expect(acpAdapterFor("claude", "sdk")).toBeInstanceOf(AcpSdkAgentAdapter);
  });

  test("createAgentRegistry routes ACP agents by agent.acp.transport, native unchanged", () => {
    const sdk = createAgentRegistry(makeNaxConfig({ agent: { acp: { transport: "sdk" } } }));
    expect(sdk.getAgent("claude")).toBeInstanceOf(AcpSdkAgentAdapter);
    expect(sdk.getAgent("native")).toBeInstanceOf(NativeAgentAdapter);
    expect(createAgentRegistry(makeNaxConfig({})).getAgent("claude")).toBeInstanceOf(AcpAgentAdapter);
  });

  test("the config-less listings use the default transport (D2-n)", () => {
    expect(getAllAgents().find((a) => a.name === "claude")).toBeInstanceOf(AcpAgentAdapter);
  });
});
```

(merge the two new imports into the file's existing import block). If `makeNaxConfig` does not accept a partial `agent.acp`, pass the full object: `{ agent: { acp: { transport: "sdk", promptRetries: 0, trackedSpawnDeadlineMs: 10_000, trackedSpawnStartupDeadlineMs: 30_000 } } }`.

Add to `test/unit/cli/agents-list.test.ts`, inside the existing `describe` (its `beforeEach` already captures `console.log`):

```typescript
  test("S4b-2: transport sdk lists the same agents through the SDK adapter", async () => {
    const original = _acpSdkDeps.isAgentLaunchable;
    _acpSdkDeps.isAgentLaunchable = (agent) => agent === "claude";
    try {
      const config = makeNaxConfig({ agent: { default: "claude", acp: { transport: "sdk" } } });
      await agentsListCommand(config, "/tmp/workdir");
      const flat = captured.map((entry) => entry.args.map((a) => (typeof a === "string" ? a : "")).join(" ")).join("\n");
      const claudeRow = flat.split("\n").find((line) => line.includes("Claude Code (ACP)"));
      expect(claudeRow).toContain("installed");
      const codexRow = flat.split("\n").find((line) => line.includes("OpenAI Codex (ACP)"));
      expect(codexRow).toContain("unavailable");
      expect(flat).not.toContain("ACP Agent");
    } finally {
      _acpSdkDeps.isAgentLaunchable = original;
    }
  });
```

with `import { _acpSdkDeps } from "@/agents/acp-sdk";` added to the imports.

Add to `test/unit/bakeoff/preflight.test.ts` (reuse the file's existing `projectRoot` setup and the profile fixture that resolves `cross-agent-pi` to agent `pi`):

```typescript
  test("S4b-2: isInstalled is asked with the contestant's transport", async () => {
    const seen: string[] = [];
    await validateContestants(
      ["cross-agent-pi"],
      projectRoot,
      {
        isInstalled: (agent, transport) => {
          seen.push(`${agent}:${transport}`);
          return true;
        },
      },
      "sdk",
    );
    expect(seen).toEqual(["pi:sdk"]);
  });

  test("S4b-2: an async isInstalled answer is honoured", async () => {
    const result = await validateContestants(["cross-agent-pi"], projectRoot, { isInstalled: async () => false });
    expect(result.errors).toMatchObject([{ reason: "dnf-not-installed" }]);
  });
```

Add to `test/unit/scripts/check-adapter-no-config-import.test.ts`, inside the plugins `describe`:

```typescript
  test("S4b-2: the acp-sdk adapter is scanned too", () => {
    root = tree({
      "src/agents/acp-sdk/x.ts": 'import type { NaxConfig } from "@/config";\nexport type C = NaxConfig;\n',
    });

    const { code, out } = runGate(root);

    expect(code).toBe(1);
    expect(out).toContain("acp-sdk/x.ts");
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `timeout 60 bun test test/unit/agents/registry-native.test.ts test/unit/cli/agents-list.test.ts test/unit/bakeoff/preflight.test.ts test/unit/scripts/check-adapter-no-config-import.test.ts --timeout=10000`
Expected: FAIL (`acpAdapterFor` missing; sdk transport not routed; the gate does not scan acp-sdk).

- [ ] **Step 3: Implement**

`src/agents/registry.ts`:
- imports: `import { type AcpTransport, DEFAULT_ACP_TRANSPORT, DEFAULT_AGENT_PROTOCOL } from "@/config";` and `import { AcpSdkAgentAdapter } from "./acp-sdk";`
- update the header sentence to: "every known name but `native` is an ACP adapter, over acpx or nax-agent-acp per `agent.acp.transport` (S4b), and `native` is the in-process nax-ai path (ADR-027 section 3)."
- add, above `adapterFor`:

```typescript
/** The adapter for a non-native agent on an ACP transport (S4b spec §5.3). */
export function acpAdapterFor(name: string, transport: AcpTransport): AgentAdapter {
  return transport === "sdk" ? new AcpSdkAgentAdapter(name) : new AcpAgentAdapter(name);
}
```

- `adapterFor` becomes `return name === NATIVE_AGENT ? new NativeAgentAdapter() : acpAdapterFor(name, DEFAULT_ACP_TRANSPORT);` with the comment "Config-less: the default transport (D2-n)."
- in `createAgentRegistry`, after `const protocol = ...`:

```typescript
  const transport = config.agent?.acp?.transport ?? DEFAULT_ACP_TRANSPORT;
  if (transport !== DEFAULT_ACP_TRANSPORT) {
    logger?.info("agents", `ACP transport: ${transport} (S4b development key)`, { transport });
  }
```

and in `cachedAdapter` replace `: new AcpAgentAdapter(name);` with `: acpAdapterFor(name, transport);`.

`src/agents/index.ts:44` becomes:

```typescript
export { acpAdapterFor, checkAgentHealth, getAllAgentNames, getInstalledAgents, KNOWN_AGENT_NAMES } from "./registry";
```

`src/cli/agents.ts`:
- imports: replace `import { resolveDefaultAgent } from "../agents";` and `import { ACP_ADAPTER_NAMES, AcpAgentAdapter } from "../agents/acp";` with:

```typescript
import { acpAdapterFor, resolveDefaultAgent } from "../agents";
import { ACP_SDK_AGENT_NAMES } from "../agents/acp-sdk";
```

  and `import { DEFAULT_AGENT_PROTOCOL } from "../config";` with `import { DEFAULT_ACP_TRANSPORT, DEFAULT_AGENT_PROTOCOL } from "../config";`
- in `agentsListCommand` replace the `adapters` line with:

```typescript
  const transport = config.agent?.acp?.transport ?? DEFAULT_ACP_TRANSPORT;
  const adapters = acpReachable ? Array.from(ACP_SDK_AGENT_NAMES).map((name) => acpAdapterFor(name, transport)) : [];
```

- in the doc comment, replace "driven by `ACP_ADAPTER_NAMES`" with "driven by `ACP_SDK_AGENT_NAMES` (the agents with an ACP launcher; the same set as acpx's `ACP_ADAPTER_NAMES`), on the configured `agent.acp.transport`", and "`new AcpAgentAdapter(name)` falls back to" wording to "an adapterless name would fall back to".

`src/bakeoff/preflight.ts`:
- imports: replace `import { ACP_ADAPTER_NAMES, AcpAgentAdapter } from "../agents/acp";` and `import { which as defaultWhich } from "@/utils/bun-deps";` with

```typescript
import { acpAdapterFor } from "../agents";
import { ACP_SDK_AGENT_NAMES } from "../agents/acp-sdk";
```

  and extend the config import: `import { type AcpTransport, DEFAULT_ACP_TRANSPORT, deepMergeConfig, type NaxConfig } from "../config";` (keep `NaxConfig` as a type import, matching the existing line's form).
- both `isInstalled` members in `PreflightDeps` and `PreflightCallableDeps` become:

```typescript
  /** Takes the agent *name* and the contestant's ACP transport; asks that transport's adapter (S4b-2). */
  isInstalled: (agentName: string, transport: AcpTransport) => boolean | Promise<boolean>;
```

- `_preflightDeps` (and its doc comment, which now says "asks the registry's adapter for that transport"):

```typescript
export const _preflightDeps: PreflightDeps = {
  isInstalled: (agentName: string, transport: AcpTransport) => acpAdapterFor(agentName, transport).isInstalled(),
  hasAcpAdapterEntry: (name: string) => ACP_SDK_AGENT_NAMES.has(name),
  loadProfile: (profileName: string, projectRoot: string) => loadProfile(profileName, projectRoot),
};
```

- add above `validateContestants`:

```typescript
/** A contestant's ACP transport: its profile's `agent.acp.transport`, else the run's (D2-o). */
function contestantTransport(profileData: Record<string, unknown>, base: AcpTransport): AcpTransport {
  const agent = profileData.agent as { acp?: { transport?: unknown } } | undefined;
  const transport = agent?.acp?.transport;
  return transport === "acpx" || transport === "sdk" ? transport : base;
}
```

- `validateContestants` gains a fourth parameter `baseTransport: AcpTransport = DEFAULT_ACP_TRANSPORT`, and the install check becomes:

```typescript
    if (!(await deps.isInstalled(resolvedAgent, contestantTransport(resolvedProfileData, baseTransport)))) {
```

`src/bakeoff/coordinator.ts`:
- line 34: `validateContestants: (names: string[], projectRoot: string, deps?: undefined, baseTransport?: AcpTransport) => Promise<ContestantValidationResult>;` is awkward; instead declare it as `validateContestants: typeof validateContestants;` (the import already exists).
- line 82:

```typescript
  const { validAgents, errors, profileData } = await merged.validateContestants(
    options.agents,
    options.projectRoot,
    undefined,
    options.config.agent?.acp?.transport ?? DEFAULT_ACP_TRANSPORT,
  );
```

  with `DEFAULT_ACP_TRANSPORT` imported from `../config`. If coordinator tests stub `validateContestants` with a two-parameter function, `typeof validateContestants` still accepts it.

`scripts/check-adapter-no-config-import.sh`: line 2 reads "Fail if any file under src/agents/{acp,acp-sdk,native-agent}/ ...", and line 11 becomes:

```bash
scan_dirs="src/agents/acp/ src/agents/acp-sdk/ src/agents/native-agent/"
```

- [ ] **Step 4: Run the tests and gates**

Run: `timeout 60 bun test test/unit/agents/ test/unit/cli/agents-list.test.ts test/unit/bakeoff/ test/unit/scripts/check-adapter-no-config-import.test.ts --timeout=30000`
Expected: PASS.

Run: `bash scripts/check-adapter-no-config-import.sh && bun run check:import-cycles && bun run typecheck`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/agents/registry.ts src/agents/index.ts src/cli/agents.ts src/bakeoff scripts/check-adapter-no-config-import.sh test/unit/agents/registry-native.test.ts test/unit/cli/agents-list.test.ts test/unit/bakeoff/preflight.test.ts test/unit/scripts/check-adapter-no-config-import.test.ts
git commit -m "feat(agents): route ACP agents by agent.acp.transport; nax agents and bake-off via the registry (S4b-2)"
```

---

### Task 12: `toolAudit` reaches the adapter

**Files:**
- Create: `packages/nax/src/session/open-session-extras.ts`
- Modify: `packages/nax/src/session/types.ts:175-188` (`OpenSessionRequest`)
- Modify: `packages/nax/src/session/manager.ts:26-31` (import), `:462-467` (the `transcriptDir` / `transcriptOwner` lines)
- Modify: `packages/nax/src/operations/build-hop-callback-hop.ts:384-401` (`openSessionRequest`)
- Test: `packages/nax/test/unit/session/open-session-extras.test.ts`, `packages/nax/test/unit/operations/build-hop-callback-hop.test.ts` (new; mirrors `src/operations/build-hop-callback-hop.ts`)

**Interfaces:**
- Produces: `OpenSessionRequest.toolAudit?: OpenSessionOpts["toolAudit"]`.
- Produces: `openSessionExtras(opts: Pick<OpenSessionRequest, "transcriptDir" | "transcriptOwner" | "toolAudit" | "featureName">, transcriptRoot: string | undefined): Pick<OpenSessionOpts, "transcriptDir" | "transcriptOwner" | "toolAudit">`.

- [ ] **Step 1: Write the failing test**

```typescript
// test/unit/session/open-session-extras.test.ts
import { describe, expect, test } from "bun:test";
import { openSessionExtras } from "@/session/open-session-extras";

describe("openSessionExtras", () => {
  test("derives transcriptDir from the root and feature when the caller supplied none", () => {
    expect(openSessionExtras({ featureName: "f" }, "/root")).toEqual({
      transcriptDir: "/root/features/f/sessions",
    });
  });

  test("an explicit transcriptDir wins; owner and toolAudit are forwarded when present", () => {
    const toolAudit = { dir: "/audit", header: { runId: "r", storyId: "US-001" } };
    expect(
      openSessionExtras({ featureName: "f", transcriptDir: "/explicit", transcriptOwner: "op-1", toolAudit }, "/root"),
    ).toEqual({ transcriptDir: "/explicit", transcriptOwner: "op-1", toolAudit });
  });

  test("no root and no feature: no transcriptDir key at all", () => {
    expect(openSessionExtras({}, undefined)).toEqual({ transcriptDir: undefined });
  });
});
```

The third case pins today's behaviour exactly: `manager.ts` always passes the `transcriptDir` key, possibly `undefined`.

The hop test follows the harness in `test/unit/operations/build-hop-callback-stale-retry.test.ts` (same helpers, same `_buildHopCallbackDeps` save/restore):

```typescript
// test/unit/operations/build-hop-callback-hop.test.ts
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  cleanupTempDir,
  makeContextBundle,
  makeMockAgentManager,
  makeNaxConfig,
  makeSessionManager,
  makeStory,
  makeTempDir,
} from "@test/helpers";
import { resolveDispatchAuditDir } from "@/agents/coding-tool-support-resolve";
import type { AgentRunOptions, SessionHandle, TurnResult } from "@/agents/types";
import { _buildHopCallbackDeps, buildHopCallback } from "@/operations";
import type { BuildHopCallbackContext } from "@/operations/build-hop-callback";
import type { OpenSessionRequest } from "@/session/types";

const TURN: TurnResult = {
  output: "done",
  tokenUsage: { inputTokens: 1, outputTokens: 1 },
  estimatedCostUsd: 0,
  internalRoundTrips: 1,
};

let origCreateContextToolRuntime: typeof _buildHopCallbackDeps.createContextToolRuntime;
let root = "";

beforeEach(() => {
  origCreateContextToolRuntime = _buildHopCallbackDeps.createContextToolRuntime;
  _buildHopCallbackDeps.createContextToolRuntime = () => undefined;
  root = makeTempDir("nax-hop-audit-");
});

afterEach(() => {
  _buildHopCallbackDeps.createContextToolRuntime = origCreateContextToolRuntime;
  cleanupTempDir(root);
});

async function openRequestFor(extra: Partial<AgentRunOptions>): Promise<OpenSessionRequest | undefined> {
  const requests: OpenSessionRequest[] = [];
  const config = makeNaxConfig();
  const ctx: BuildHopCallbackContext = {
    sessionManager: makeSessionManager({
      openSession: mock(async (name: string, opts: OpenSessionRequest) => {
        requests.push(opts);
        return { id: name, agentName: opts.agentName } satisfies SessionHandle;
      }),
      closeSession: mock(async () => {}),
    }),
    agentManager: makeMockAgentManager({ runAsSessionFn: mock(async () => TURN) }),
    story: makeStory({ id: "US-001" }),
    config,
    featureName: "feat",
    workdir: root,
    effectiveTier: "balanced",
    defaultAgent: "claude",
    pipelineStage: "run",
  };
  const options: AgentRunOptions = {
    prompt: "p",
    workdir: root,
    modelTier: "balanced",
    modelDef: { provider: "anthropic", model: "sonnet" },
    timeoutSeconds: 30,
    config,
    storyId: "US-001",
    sessionRole: "implementer",
    featureName: "feat",
    runId: "run-7",
    ...extra,
  };
  await buildHopCallback(ctx, undefined, options)("claude", makeContextBundle(), { kind: "primary" }, options);
  return requests[0];
}

describe("prepareHopSession: toolAudit (S4b spec §7.4)", () => {
  test("carries the ledger dir and header native resolves when a coding-tool root is set", async () => {
    const request = await openRequestFor({ codingToolRoot: root, outputDir: root });
    expect(request?.toolAudit).toEqual({
      dir: resolveDispatchAuditDir(root, root, "feat"),
      header: { runId: "run-7", featureName: "feat", storyId: "US-001", sessionRole: "implementer" },
    });
  });

  test("no coding-tool root: no toolAudit key", async () => {
    const request = await openRequestFor({});
    expect(request).toBeDefined();
    expect(request).not.toHaveProperty("toolAudit");
  });
});
```

If the hop does not reach `openSession` in this harness (for example because it needs a field `makeCtx` in the stale-retry file sets), copy that field from `makeCtx`; do not stub `prepareHopSession`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `timeout 30 bun test test/unit/session/open-session-extras.test.ts test/unit/operations/build-hop-callback-hop.test.ts --timeout=10000`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```typescript
// src/session/open-session-extras.ts
/**
 * The transcript and audit fields SessionManager forwards to adapter.openSession.
 *
 * Its own module because manager.ts is a grandfathered oversized file that may
 * not grow (as model-selection.ts). transcriptDir derivation is ADR-028 §3 (an
 * explicit caller value wins); transcriptOwner is nax#1877's ownership key; the
 * ACP SDK transport keeps its crash-leftover record in transcriptDir and reads
 * its run identifiers and tool-audit ledger from toolAudit (S4b spec §7.4).
 */
import type { OpenSessionOpts } from "@nathapp/nax-agent";
import { deriveNativeTranscriptDir } from "./manager-deps";
import type { OpenSessionRequest } from "./types";

export function openSessionExtras(
  opts: Pick<OpenSessionRequest, "transcriptDir" | "transcriptOwner" | "toolAudit" | "featureName">,
  transcriptRoot: string | undefined,
): Pick<OpenSessionOpts, "transcriptDir" | "transcriptOwner" | "toolAudit"> {
  return {
    transcriptDir: opts.transcriptDir ?? deriveNativeTranscriptDir({ featureName: opts.featureName, transcriptRoot }),
    ...(opts.transcriptOwner !== undefined ? { transcriptOwner: opts.transcriptOwner } : {}),
    ...(opts.toolAudit !== undefined ? { toolAudit: opts.toolAudit } : {}),
  };
}
```

`src/session/types.ts`, in `OpenSessionRequest` after `transcriptOwner`:

```typescript
  /**
   * The tool-audit ledger location and header for this session (S4b spec §7.4),
   * resolved by the dispatch hop the way native's coding-tool support resolves
   * it. Forwarded to the adapter's openSession; the ACP SDK transport reads its
   * stream run identifiers from the header.
   */
  toolAudit?: OpenSessionOpts["toolAudit"];
```

(import `OpenSessionOpts` as a type from `@nathapp/nax-agent` if the file does not already). Also change the `transcriptDir` and `transcriptOwner` doc comments' "ACP ignores it." to "The ACP SDK transport keeps its crash-leftover record there." and "acpx ignores it." respectively.

`src/session/manager.ts`:
- in the `./manager-deps` import, drop `deriveNativeTranscriptDir,` (no other use in the file; confirm with `grep -n deriveNativeTranscriptDir src/session/manager.ts`);
- add `import { openSessionExtras } from "./open-session-extras";` after `import { DEFAULT_ORPHAN_TTL_MS, sweepOrphansImpl } from "./manager-sweep";`;
- replace the five lines

```typescript
      // Finding 1: callers never supplied transcriptDir, so derive it here — the one place ADR-028 §3
      // documents. An explicit caller value wins. transcriptOwner is nax#1877's ownership key.
      transcriptDir:
        opts.transcriptDir ??
        deriveNativeTranscriptDir({ featureName: opts.featureName, transcriptRoot: this._transcriptRoot }),
      ...(opts.transcriptOwner !== undefined ? { transcriptOwner: opts.transcriptOwner } : {}),
```

with

```typescript
      // ADR-028 §3 transcriptDir derivation, nax#1877 owner, S4b toolAudit (open-session-extras.ts).
      ...openSessionExtras(opts, this._transcriptRoot),
```

`src/operations/build-hop-callback-hop.ts`: extend the existing `coding-tool-support-resolve` import to `import { buildLedgerHeader, resolveCodingToolSupport, resolveDispatchAuditDir } from "../agents/coding-tool-support-resolve";`. In `prepareHopSession`, before `openSessionRequest`:

```typescript
  // S4b spec §7.4: the same ledger location and header native's coding-tool support resolves.
  const auditDir = resolveDispatchAuditDir(
    resolvedRunOptions.codingToolRoot,
    resolvedRunOptions.outputDir,
    resolvedRunOptions.featureName,
  );
  const toolAudit = auditDir === undefined ? undefined : { dir: auditDir, header: buildLedgerHeader(resolvedRunOptions) };
```

and in the request literal after the `transcriptOwner` spread:

```typescript
    ...(toolAudit !== undefined ? { toolAudit } : {}),
```

If `build-hop-callback-hop.ts` exceeds a complexity or size gate after this, move the two statements into a `hopToolAudit(resolvedRunOptions)` function in the same file.

- [ ] **Step 4: Run the tests and the size gate**

Run: `timeout 60 bun test test/unit/session/ test/unit/operations/ --timeout=20000`
Expected: PASS.

Run: `bun run check:file-sizes`
Expected: pass. `manager.ts` shrank by three lines. If the gate asks for the grandfathered entry to be lowered, run `bun run check:file-sizes:update` and paste the baseline diff in the commit body.

- [ ] **Step 5: Commit**

```bash
git add src/session src/operations/build-hop-callback-hop.ts test/unit/session/open-session-extras.test.ts test/unit/operations scripts/baselines
git commit -m "feat(session): forward the tool-audit location to adapter.openSession (S4b-2)"
```

---

### Task 13: Gates, build, dist smoke, docs, review, PR

**Files:**
- Modify: `docs/superpowers/specs/2026-10-07-s4b-nax-run-acp-cutover-design.md` (§5.1, §6.7, §7.1, §11)
- Modify: any baseline a gate asks to lower (never raise)

- [ ] **Step 1: Full gates**

From `packages/nax`:

```bash
bun run typecheck
bun run check:all
bun run test
bun run test:coverage
```

Expected: all green. Every new `src/agents/acp-sdk/*.ts` and `src/session/open-session-extras.ts` file is at or above 80% line and function coverage. If one is below, add the missing case to that file's own test; do not baseline it.

From the repo root, confirm the other packages are untouched and green:

```bash
git diff --stat main -- packages/nax-agent packages/nax-agent-acp
```

Expected: empty.

- [ ] **Step 2: Build and dist smoke**

From `packages/nax`:

```bash
bun run build
grep -c "ACP_SDK_COMPLETE_UNAVAILABLE" dist/nax.js
bun dist/nax.js agents -d .
SMOKE="$(mktemp -d)"
mkdir -p "$SMOKE/.nax"
printf '{"agent":{"acp":{"transport":"sdk"}}}\n' > "$SMOKE/.nax/config.json"
bun dist/nax.js agents -d "$SMOKE"
rm -rf "$SMOKE"
```

Expected:
- the `grep` count is at least 1, so nax-agent-acp is in the bundle;
- both `agents` runs print the "Available Agents" table with the five ACP rows (`Claude Code (ACP)` ... `Pi Coding Agent (ACP)`) and no "ACP Agent" row;
- on the second run, a row is "installed" when that agent's ACP launcher or `npx` resolves (with `npx` on PATH, claude, codex and pi show installed).

`nax agents` is not trust-gated, so the scratch directory needs no trust entry. If it reports `PROJECT_UNTRUSTED`, stop and report; do not run `nax trust add`.

- [ ] **Step 3: Spec amendments**

In the S4b spec:
- §5.1 table: add rows `session.ts` (one session: open with the crash-leftover policy, re-open, close; `_acpSdkDeps`) and `turn-slot.ts` (the running turn, read by the backend context and the ask port).
- §6.7: replace "S4b-0 check (g) confirms ... If they don't, a mapping table in `model-effort.ts` is added." with the probe result from D2-a ("Probed 2026-10-07 against claude-agent-acp 0.85.1: offered `default, sonnet, haiku, opus, fable`; nax's tier defaults match verbatim; no mapping table.").
- §7.1: under the table, add "Run abort: acpx returned a zero-output TurnResult from this path; the sdk transport throws as the table says (S4b-2 D2-c). S4b-3's parity tests confirm or amend this row before the flip."
- §11: add item 8: "**A configured model id must be one the agent offers verbatim** (for Claude: `default`, `sonnet`, `haiku`, `opus`, `fable`). Any other id fails the open with `AGENT_SESSION_CAPABILITY_UNSUPPORTED`; acpx passed it through and Claude's adapter resolved it fuzzily."
- §12, row "Model string mismatch fails every open": mitigation becomes "Probed in S4b-2 (D2-a): tier defaults match; non-alias ids are behaviour change 8".

```bash
git add docs/superpowers/specs/2026-10-07-s4b-nax-run-acp-cutover-design.md
git commit -m "docs(spec): S4b-2 model probe result, run-abort note, behaviour change 8"
```

- [ ] **Step 4: Whole-branch review before push**

Dispatch one fresh reviewer (superpowers:requesting-code-review) over `git diff main...HEAD`, with this plan and the spec. Ask it to check, besides correctness:
- §1's rule: no nax logic dropped on the sdk path;
- the default `acpx` path is byte-for-byte unchanged in behaviour;
- the five Review Focus items.

Fix Critical and Important findings, at most two fix rounds. Record deferred Minor findings in the PR body.

- [ ] **Step 5: Push and open the PR**

Only after Step 4 and with the maintainer's go-ahead:

```bash
git push -u origin feat/s4b-2-acp-sdk-adapter
gh pr create --title "feat(nax): S4b-2 ACP SDK adapter behind agent.acp.transport" --body-file <body>
```

The PR body lists:
- what S4b-2 adds and the S4b-3 remainder (D2-d);
- decisions D2-a to D2-o, flagging D2-b and D2-c for the maintainer;
- the gate and dist-smoke output;
- deferred Minor findings;
- "No release, no billed run. Default transport unchanged (acpx)."

Wait for CI green; report the PR number and CI status.
