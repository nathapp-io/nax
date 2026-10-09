# S5-5 Task 12 — Live checks: results

Run of `docs/superpowers/plans/2026-10-09-s5-5-mcp-bridge.md` Task 12 Steps 1-4, on `main` at
`eaaa98975` (S5-5a #2418 and S5-5b #2419 merged), `2026-10-09`. Package versions are still
`0.84.0` (no bump before the release step). The billed turns ran with maintainer approval.

## Summary

| Step | What | Result |
|---|---|---|
| 1 | Build, pack and install the tarballs | Pass (pack via `stage-publish`, see below) |
| 2 | Zed: MCP tool prompt, Always allow, read-mode notice | Pass, with a finding (#2422: no mode picker) |
| 3 | Headless: stdio MCP server, `full` mode, mode switch | Pass |
| 4 | Record | This file |

Environment: `node v22.22.2`, `bun 1.4.2`, Zed 1.23.2 on macOS, `@agentclientprotocol/sdk` 1.7.0.

## Step 1 — packed tarballs

Built from a fresh clone of `origin/main` (`eaaa98975`), `bun install --frozen-lockfile`, then per
package `bun run build`.

**Pack through `stage-publish`.** The workspace manifests point `exports` at `.ts` sources (R6),
so `npm pack` in the package directory ships a manifest Node cannot load
(`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` on `@nathapp/nax-agent/mcp`) and keeps
`workspace:*` ranges. `bun pm pack` rewrites the ranges but not the exports. The release path
is the one that works:

```
GITHUB_REPOSITORY=nathapp-io/nax bun run stage-publish   # writes .publish/
cd .publish && npm pack --pack-destination "$SMOKE"
npm install ./nathapp-nax-agent-0.84.0.tgz ./nathapp-nax-agent-acp-0.84.0.tgz
```

- `nax-agent --version` → `0.84.0`
- `npm ls` → `@nathapp/nax-agent-acp@0.84.0` uses the local `@nathapp/nax-agent@0.84.0`
  (deduped), not the registry `0.84.0`, which predates `./mcp`.
- `import("@nathapp/nax-agent/mcp")` under Node exports `DEFAULT_CLOSE_GRACE_MS`,
  `McpCallError`, `McpConnectError`, `connectMcp`, `resultText`.
- `dist/server/mcp/` present; a raw `initialize` returns
  `mcpCapabilities: { http: true, sse: false }`. **Pass.**

## Step 2 — Zed (maintainer)

A second agent entry `nax-agent-s5-5` pointed at the packed `bin/nax-agent.js` (absolute nvm
`node` path, model `minimax/MiniMax-M2.7`), next to the existing global entry. One MCP server
in `context_servers`: `codebase-memory-mcp` (stdio, `"source": "custom"`).

| # | Check | Result |
|---|---|---|
| 1 | `ask` thread, a prompt that needs the MCP tool | Pass |
| 2 | Permission prompt names `codebase-memory-mcp: search_graph` | Pass |
| 3 | "Always allow", ask again: no prompt | Pass |
| 4 | Switch to `read`: MCP-off notice | Not possible in Zed (#2422); open-time notice Pass |

**Finding (#2422).** Zed shows no mode picker for nax-agent threads. Next to the model picker
it shows only the Bash approval select (Gated / Raw / Escalate). The server sends the modes
only in the session `modes` state; `configOptions` carries `model` and `bashApproval`, and Zed
appears to render `configOptions` and ignore `modes`. Proposed fix in the issue: a `mode`
select option with `category: "mode"`, applied through the same path as `session/set_mode`.
The S5-4 walkthrough did not switch modes, so it did not see this.

Workaround used for row 4: `"env": { "NAX_AGENT_MODE": "read" }` on the entry, then a new
thread. The notice "MCP tools are off in read mode" showed on open (the M-37 queued-notice
path). The mid-session switch path was checked headless in Step 3.

## Step 3 — headless (billed: 1 model turn)

A Node script on `@agentclientprotocol/sdk` 1.7.0 (`ClientSideConnection` + `ndJsonStream`)
spawned `node bin/nax-agent.js acp --mode full --sessions-dir <scratch>` with
`NAX_AGENT_MODEL=minimax/MiniMax-M2.7`, then:

1. `initialize` → `mcpCapabilities` `{"http":true,"sse":false}`.
2. `session/new` with `mcpServers: [{ name: "echo", command: <node>, args:
   ["<smoke>/mcp-echo-server.mjs"], env: [] }]` (a copy of
   `packages/nax-agent-acp/test/fixtures/mcp-echo-server.mjs`) → session open, mode `full`.
3. Prompt "Call the echo tool with text hi, then tell me exactly what it returned." →
   `tool_call` title `echo: echo`, `rawInput` `{"text":"hi"}`, `in_progress` → `completed`; no
   permission request (mode `full`); answer "The echo tool returned exactly: `hi`";
   `stopReason` `end_turn`.
4. `session/set_mode` `read` → agent message "MCP tools are off in read mode: Switch to ask or
   full to use them." then `current_mode_update` `read`.
5. `session/set_mode` `full` → `current_mode_update` `full`.

**Pass.** Not checked: a prompt after switching back to `full` (MCP tools offered again).
Nit: the notice capitalises "Switch" after the colon.

## Step 4 — Record

- Commit: `eaaa98975` (main; versions `0.84.0`, unreleased S5-5)
- Model: `minimax/MiniMax-M2.7` (Zed and headless)
- Billed turns: 1 headless; a handful of short Zed turns. Cost from the provider dashboard only.
- Zed checks: 3/3 runnable checks pass; mode switch blocked by #2422.

## Remaining

1. #2422 — expose mode as a session config option so editors that render `configOptions` get a
   mode picker.
2. Step 5 — `bun run release minor` (all four packages → `0.85.0`), with approval.
