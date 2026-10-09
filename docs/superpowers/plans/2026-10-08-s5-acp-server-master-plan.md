# S5 ACP Server: Master Plan

> **For agentic workers:** this file is the slice map. Execute one slice plan at a time (`2026-10-08-s5-<n>-*.md`); each one says which sub-skill to use. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ship the `nax-agent` binary: an ACP server on stdio over the S3 facade, so editors (Zed) and headless clients (acpx) can drive nax-agent.

**Architecture:** a thin adapter in `packages/nax-agent-acp/src/server/` (the reserved `./server` export). Each ACP session wraps one S3 `AgentSession`. Requests become `send()` / `answer()` / `cancel()` calls, and S3 events become ACP `session/update`s through one translator. Built on `@agentclientprotocol/sdk` 1.7.0's `agent()` builder.

**Tech Stack:** TypeScript (ESM), Bun 1.4.0 for tests (`bun:test`), Node >= 22.19 for the published bin (vitest Node lane), `@agentclientprotocol/sdk ~1.7.0`, zod 4.

**Spec:** `docs/superpowers/specs/2026-10-08-s5-acp-server-design.md` (approved 2026-10-08). Executors read the spec and the slice plan together.

## Global Constraints

- Package: `packages/nax-agent-acp`. All commands run from that directory: `bun run typecheck`, `bun run check:all`, `bun test ./test/unit/ --timeout=60000` (or a single file path), `bun run test:node` (Node lane), `bun run test:coverage`. Never run bare `bun test` with no path.
- Source files <= 600 lines, test files <= 800 lines (`check-file-sizes`). Per-file unit line coverage >= 80% (`check-coverage --require-all-files`): every new `src/` file needs unit tests.
- No `throw new Error(` in `src/` (baseline 0). Throw `NaxError` from `@nathapp/nax-agent`, or SDK `RequestError` at the protocol edge.
- No Bun APIs in `src/` (`check:no-bun-apis`); the published bin runs on Node.
- No `as unknown as` and no `@ts-` suppressions in tests (gates at 0).
- nax-agent is reached only through its public entry `@nathapp/nax-agent` (`check:package-boundaries`).
- Imports inside the package use `#src/...` and `#test/...` (no relative `../`).
- Test files: one `<module>.test.ts` per source module, or `<module>-<concern>.test.ts` splits; never ticket-named (`check:test-satellites`).
- stdout of the server process carries ACP frames only; all logs go to stderr.
- Biome format and lint are part of `check:all`; run `bun run lint:fix` before each commit.
- `@nathapp/nax-agent` and `@nathapp/nax-agent-acp` share one version (lockstep), now with `@nathapp/nax-ai` and `@nathapp/nax` too. Release (S5-4): lockstep v0.84.0 (all four packages), maintainer approval at launch.
- Billed runs (live acpx smoke) and releases need explicit maintainer approval at launch.

## Review Focus

- **The server advertises a capability before its method works.** An editor calls `session/load` because `loadSession: true` was advertised in an earlier slice. Rule: each slice adds its capability flags in the same commit as the handler (S5-0 advertises only `promptCapabilities` and `agentInfo`). Each slice's capability test pins the exact `initialize` response.
- **Auto-decided approvals look like real ones.** S3 emits `approval_requested` then `approval_resolved{decidedBy:"profile"}` for profile decisions, and `noteQuestion` emits a `question` that cannot be answered. Without a marker the server would prompt the user for something already decided. S5-2 adds an optional `answerable: false` field to both events in nax-agent (decision M-1) and tests that no permission request is sent for them.
- **A misbehaving client line.** Malformed JSON, an unknown method, or a request for an unknown session must yield a JSON-RPC error frame, never a crash or non-frame stdout. S5-0's stdout-purity test sends an unknown method; S5-2 adds the unknown-session case.
- **A config file nax accepts but the server's subset reader rejects.** The server must still start, with defaults and one stderr warning. S5-0 tests an unrelated invalid section and the legacy string model form.
- **Two clients on one session.** S5-3's lock test covers a live lock and a stale-pid lock.

## Decisions taken while planning

| # | Decision | Why |
|---|---|---|
| M-1 | S5-2 adds an optional `answerable?: false` to the `approval_requested` and `question` session events in `@nathapp/nax-agent` (set by `recordAutoDecision` and `noteQuestion`), plus a test there. It is additive and optional, so existing consumers are unaffected. | Without it the server cannot tell an auto-decided approval from a human one without waiting for the next event, which deadlocks a real request (spec §4.3 gap). |
| M-2 | The published bin is a three-line hand-written `bin/nax-agent.js` outside `src/`, importing `../dist/server/index.js` and calling `runCli(process)`. All logic lives in `src/server/`. | The coverage gate cannot see a spawned process, so the bin carries no logic. tsc's `rootDir` is `src`. |
| M-3 | The `~/.nax` reader also reads the `auth` block (same schema and defaults as nax's `AuthConfigSchema`) to feed `configureCredentials({ readAuthConfig })`, re-read per call as nax does. It reads `agent.native.catalogOverrides` (passed through) for `catalogOverrides`. The tier object form contributes `model` (the id) and `contextWindow` (used for `usage_update.size`). | Spec §6.2 under-listed these: `configureCredentials` needs an auth reader, and nax keeps catalog overrides at `agent.native.catalogOverrides`, not in the tier object. |
| M-4 | `usage_update.used` = input + output + cache-read + cache-write tokens of the round. | All of these occupy the context window; input alone undercounts on cached providers. |
| M-5 | Config-dir precedence: `--config-dir` > `NAX_AGENT_CONFIG_DIR` > `NAX_GLOBAL_CONFIG_DIR` (nax's own override) > `~/.nax`. | The same credential store is found whichever way nax was pointed. |
| M-7 | S5-1 exports nax-agent's private live tool-display masking (`cappedInput` -> `displayToolInput`, `previewOf` -> `toolResultPreview`) so transcript replay masks and caps stored inputs and results exactly like live events. No behaviour change in nax-agent. | Transcripts hold raw tool inputs and full results; replaying them unmasked would show the editor more than the live turn did. |
| M-6 | Slice plans are written just in time: S5-0 and S5-1 now (independent of each other), S5-2..S5-5 after their predecessors merge. | Later slices build on code the earlier slices write; planning them now would plan against guesses. |
| M-28..M-35 | S5-4 decisions (terminal UI moved to nax-agent, stored-or-ambient credentials, open check, lenient `authenticate`, credential failure codes, login provider set, login CLI shape, release order): see `2026-10-09-s5-4-auth-release.md`. | Recorded with the slice plan. |

## Slices

| Slice | Plan | Depends on | Contents |
|---|---|---|---|
| S5-0 | `2026-10-08-s5-0-server-wiring.md` | main | CLI, `~/.nax` subset reader, option resolution, stderr logger, `initialize`, stdio serving, `runCli`, bin, staged manifest and Node pack smoke, API snapshot. |
| S5-1 | `2026-10-08-s5-1-translator.md` | main | `src/server/translate/`: tool kinds, titles, locations, diffs, the event translator, stop reasons, usage, transcript replay. Pure apart from an injected file reader. |
| S5-2 | to write after S5-0 and S5-1 merge | S5-0, S5-1 | M-1 in nax-agent; `ServerSession` and an in-memory registry; `session/new`, `prompt`, `cancel`; permissions with per-session always-memory; elicitation and the canned-answer fallback; error mapping (spec §7); MCP notice; capability flags for what lands. |
| S5-3 | after S5-2 | S5-2 | Storage (metadata, lock, list scan); `load` with replay, `resume`, `list`, `close`, `delete`, `set_mode`, `set_config_option` via close-and-resume; shutdown (spec §5.5); `loadSession` and `sessionCapabilities`. |
| S5-4 | `2026-10-09-s5-4-auth-release.md` | S5-3 | `nax-agent login <provider>`; terminal `authMethods`; `authenticate`; `auth_required` mapping; README (Zed, acpx); live acpx smoke and Zed walkthrough (approval); released as v0.84.0 (lockstep) — run https://github.com/nathapp-io/nax/actions/runs/37913888897, tag v0.84.0 at eeb09ebbe. |
| S5-5 | after S5-4, with a design addendum first | S5-4 | MCP bridge for client `mcpServers`. |

## File map (end state of S5-0..S5-4)

```
packages/nax-agent-acp/
  bin/nax-agent.js                      S5-0  #!/usr/bin/env node; runCli(process)
  scripts/lib/stage-manifest.ts         S5-0  + bin entry, + bin/nax-agent.js stage input
  scripts/stage-publish.ts              S5-0  copies bin/
  src/server/
    index.ts                            S5-0  public: main, runCli, MainDeps, ProcessLike
    cli.ts                              S5-0  parseCli (S5-4 adds `login`)
    nax-config.ts                       S5-0  loadNaxConfig (~/.nax subset)
    options.ts                          S5-0  resolveConfigDir, resolveServerOptions
    logger.ts                           S5-0  stderrLogger
    capabilities.ts                     S5-0  initializeResponse (grows per slice)
    connection.ts                       S5-0  buildAgentApp, serveStdio (handlers grow per slice)
    main.ts                             S5-0  main(deps)
    process-entry.ts                    S5-0  mainDepsFrom, runCli
    version.ts                          S5-0  packageVersion
    translate/tool-kind.ts              S5-1  toolKind, toolTitle, toolLocations
    translate/diff.ts                   S5-1  editDiff, toolDiff, fsReadOldText
    translate/notice.ts                 S5-1  notice
    translate/events.ts                 S5-1  createEventTranslator
    translate/stop.ts                   S5-1  promptOutcome, toAcpUsage
    translate/replay.ts                 S5-1  replayTranscript
    server-session.ts                   S5-2
    registry.ts                         S5-2 (in-memory) -> S5-3 (persistent)
    permissions.ts                      S5-2  always-memory, permission round trip
    questions.ts                        S5-2  elicitation and fallback
    errors.ts                           S5-2  failure -> RequestError
    storage.ts                          S5-3
    auth.ts                             S5-4
```

## Hand-off

Each slice: branch off main (`feat/s5-<n>-<topic>`), execute its plan, `bun run typecheck && bun run check:all && bun test ./test/unit/ --timeout=60000 && bun run test:coverage` green, code review before push, then one PR. Update the S5 row of `nax-agent-master-plan.md` (maintainer workspace) when a slice merges.
