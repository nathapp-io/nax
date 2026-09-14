# MCP Servers and Command Interception

Two independent, opt-in features that change what tools the coding agent has and what
actually runs when it calls one:

- **`mcp`** — attach external Model Context Protocol servers as extra tools.
- **`execution.commandInterceptor`** — rewrite the `Git` tool's argv through a
  token-reducing proxy (`rtk`).

They share no code and can be enabled independently.

---

## The prerequisite that governs both

**Both features reach the native agent only.** Neither works under ACP.

Coding tools — `Git` included — are consumed by the native turn loop
(`src/agents/native/session/turn-loop.ts`). The ACP adapter accepts a `codingTools`
argument in its `sendTurn` signature but never consumes it: an ACP agent (`claude`,
`codex`, `opencode`, `gemini`) brings its own tool implementations, so nax's `Git` tool is
never invoked and no MCP-provided tool is ever advertised.

Before either block does anything, the project must dispatch to `native`:

```json
{
  "agent": {
    "protocol": "hybrid",
    "default": "native"
  }
}
```

A project left on `"protocol": "acp"` can carry a complete, valid `mcp` and
`commandInterceptor` config and get **zero** effect from both, with no error. Config
validity is not activation — verify with the evidence checks below rather than assuming.

> nax's own `.nax/config.json` is currently `"protocol": "acp"` / `"default": "claude"`.
> Both blocks are configured there and are **dormant** until a run dispatches to native.

Second gate, for MCP only: `unrestricted` resolves every attached provider; `scoped`
resolves exactly the provider tools its stage's `Mcp(...)` rules name; `safe` resolves
none. See the profile table in [Permissions](permissions.md#profiles).

---

## Part 1 — MCP servers

### Configuration

```json
{
  "mcp": {
    "servers": {
      "codebase-memory": {
        "command": "codebase-memory-mcp",
        "args": [],
        "env": {},
        "stages": ["run"],
        "allowedTools": ["search_graph", "trace_path", "get_code_snippet"],
        "timeoutMs": 60000,
        "enabled": true
      }
    }
  }
}
```

| Key | Default | Meaning |
|:---|:---|:---|
| `command` | *required* | stdio server binary. nax is a **client only**, never a server. |
| `args` | `[]` | Arguments passed to `command`. |
| `env` | `{}` | Extra environment for the child process. |
| `stages` | `[]` | Pipeline stages the server attaches to. `["*"]` = every stage. **An empty list attaches nowhere.** |
| `allowedTools` | *(omitted)* | Subset of locked tools that is grantable. Omitted means every locked tool is. |
| `timeoutMs` | `60000` | Per-call ceiling. A wedged call is bounded so it cannot consume a hop. |
| `enabled` | `true` | Kill switch. Needs no lock entry and invalidates no lock. |

The schema is `.strict()` — a typo'd key is a load error, not a silent drop. In particular
`stage:` for `stages:` would otherwise leave a server attached to nothing.

### Server ids are namespaces

The server id is the tool-name namespace: `codebase-memory` advertises
`codebase-memory__search_graph`, `codebase-memory__trace_path`, and so on. Ids must match
`^[a-z0-9][a-z0-9_-]*$` and may not contain `__` (the separator itself).

### The lockfile

Before any tool is grantable, pin the advertised surface:

```bash
nax mcp lock
```

This connects every enabled server once, records each tool's name and input-schema hash
into `.nax/mcp-lock.json`, and that file is committed like `bun.lock`. Re-run it whenever
a server is upgraded; an unchanged server rewrites the file byte-identically.

### Choose `stages` deliberately

`stages` is narrower than it looks. With `stages: ["run"]` on a two-story feature, only
the implementer and test-writer sessions ever see the tools — the reviewer, verifier and
acceptance sessions do not, even though they do plenty of exploration. Measured on the
`native-full-run` fixture: **3 of 18 sessions** had the tools available.

### `allowedTools` is a real cost lever

Every attached hop pays the full advertised schema, whether or not a tool is ever called.
Measured against `codebase-memory-mcp`:

| Advertisement | Bytes per hop |
|:---|---:|
| 3 tools (`search_graph`, `trace_path`, `get_code_snippet`) | **7,604** |
| All 15 tools (`allowedTools` omitted) | **21,650** |

Narrowing to three tools cuts the per-hop tax by ~64% (≈1,900 tokens/hop instead of
≈5,400). Grant the tools you expect to be called, not the whole surface.

### Verifying it actually attached

Three independent signals, in increasing strength:

1. **Pool connect**, in a `--verbose` run log:
   `mcp [pool] codebase-memory connected`
2. **Per-hop advertisement**, once per attached session:
   `tools [provider] advertised  { "count": 3, "schemaBytes": 7604 }`
3. **Per-run rollup**, the durable artifact:
   `~/.nax/<project>/mcp/<runId>-servers.json`

```json
{
  "servers": [
    { "serverId": "codebase-memory", "workdirs": 1, "connected": 1, "failed": 0, "toolsAdvertised": 15 }
  ],
  "withheld": [],
  "events": [ { "kind": "connected", "pid": 22254, "toolCount": 15 }, { "kind": "closed" } ]
}
```

`connected: 1` proves the server ran. It does **not** prove any tool was called — check
the tool-audit ledger for `codebase-memory__*` entries for that. The two are routinely
different: a server can connect, advertise, charge the schema tax on every hop, and never
be invoked once.

### Failure behaviour

| Situation | Result |
|:---|:---|
| `command` not on PATH / connect fails | Server degraded; run continues without its tools. Recorded in `failed` and `events`. |
| Server dies mid-hop | Call fails as data, not a throw; server marked dead, run continues. |
| Call exceeds `timeoutMs` | Bounded and failed so a wedged server cannot consume the hop. |
| Advertised tool absent from lockfile | Withheld — listed under `withheld` in the rollup. |
| `safe` profile, or `scoped` with no matching `Mcp(...)` rule | No provider tools resolve; no error. |

---

## Part 2 — rtk command interception

### Configuration

```json
{
  "execution": {
    "commandInterceptor": {
      "provider": "rtk",
      "enabled": true,
      "git": { "verbs": ["log", "diff"] }
    }
  }
}
```

| Key | Default | Meaning |
|:---|:---|:---|
| `provider` | `"rtk"` | Interceptor implementation. |
| `enabled` | `false` | **Off by default** — opt in per project. |
| `git.verbs` | `["log", "diff"]` | Git subcommands eligible for rewriting. Anything else passes through untouched. |

Requires the `rtk` binary on `PATH` (`rtk --version`, `rtk gain` to confirm you have the
right one — a different project also ships an `rtk`).

### Scope: the Git site only

Interception is deliberately confined to the `Git` tool's argv. nax does **not** wrap
user-authored command strings — `quality.commands` and `acceptance.command` are never
intercepted. That is a standing ruling (spec R10), not an oversight: there is no saving on
the success path, and the failure path is shape-dependent (a Bun stack trace compresses
~58%, Biome diagnostics 0%). Wrapping them would also move trust from your project config
to a third-party binary.

### What a rewrite looks like

An eligible call has its argv prefixed, and the ledger records what actually ran:

```
verb    executed
diff    ['rtk','git','diff','--relative','1c008758..HEAD','--','.', ':!.nax/']
log     ['rtk','git','log','--relative','--oneline','1c008758..HEAD','--','.']
show    None      <- not in git.verbs, passed through
status  None      <- not in git.verbs, passed through
```

### Output hint stripping

rtk appends a trailing hint to its output, e.g.
`[full diff: rtk git diff --no-compact]`, `[full output: rtk …]`, `[+12 hidden: rtk …]`.
A nax agent has no shell and cannot act on those, so they are stripped before the output
reaches the model. Stripping is hint-shaped, not a trim: output with no trailing hint is
returned byte-for-byte.

### Expected savings

Savings scale with output size — measured by replaying real run argv:

| Command | raw git | via rtk | saving |
|:---|---:|---:|---:|
| `git diff` (1 small file) | 1,851 B | 1,595 B | 13.8% |
| `git diff` (medium) | 24,800 B | 18,702 B | 24.6% |
| `git diff` (large) | 31,255 B | 19,797 B | 36.7% |
| `git log --oneline` (1 commit) | 116 B | 116 B | 0% |

Short logs gain nothing; large diffs gain the most. Set expectations against the size of
diffs your reviews actually produce.

### Fail-open behaviour

Interception never breaks a run:

| Situation | Result |
|:---|:---|
| `enabled: false` | `unchanged` — every argv passes through. |
| `rtk` not on PATH | `declined` with reason `rtk binary not found on PATH`; plain git runs. |
| Probe throws | `declined` with the probe error; plain git runs. |
| Verb not in `git.verbs` | `unchanged`. |

The state line is emitted **once per run regardless**, so a run with interception off is
distinguishable in its artifacts from a run that simply made no git calls.

### Verifying it actually intercepted

1. **State line**, in a `--verbose` run log:

   ```
   execution rtk interceptor state  { "enabled": true, "version": "rtk 0.45.0", "verbs": ["log","diff"] }
   ```

   `version: null` with `enabled: true` means the binary probe failed — check `declined`.

2. **The ledger**, which is the proof. In
   `~/.nax/<project>/tool-audit/<feature>/*.json`, an intercepted call carries
   `executed` starting with `rtk`; a passed-through call has `executed: null`.
   Seeing `log`/`diff` rewritten *and* `status`/`show` untouched confirms verb filtering
   works rather than everything being blanket-wrapped.

---

## Where the artifacts live

Both features write to the **run output directory**, not the repo:

```
~/.nax/<project>/
├── cost/<runId>.jsonl         # per-call cost and tokens
├── tool-audit/<feature>/*.json # per-session tool calls, incl. `executed`
├── mcp/<runId>-servers.json    # MCP per-run rollup
└── prompt-audit/<feature>/*.txt
```

The repo-local `.nax/` path is only the fallback for a run with no output directory
(`src/config/paths.ts`). Two runs of the same project append to the same tree — separate
them by `runId` or timestamp before comparing.

---

## Troubleshooting

| Symptom | Cause | Fix |
|:---|:---|:---|
| No `[provider] advertised` lines at all | Project dispatches to ACP | Set `agent.protocol: "hybrid"`, `agent.default: "native"` |
| Server connects, zero tool calls | Model chose not to use it | Expected on small repos — `Grep` is cheaper there. Not a defect |
| Tools never grantable | No lockfile, or tool absent from it | Run `nax mcp lock`, commit the result |
| Provider tools silently absent | `safe` profile, or `scoped` with no `Mcp(...)` rule naming them | Set `execution.permissionProfile: "unrestricted"`, or add the stage's `Mcp(...)` rule under `scoped` |
| Server attaches to nothing | `stages: []`, or `stage:` typo | Set `stages` to real stage names or `["*"]` |
| `rtk interceptor state` shows `version: null` | Binary not found or probe failed | `which rtk`; confirm `rtk gain` works (name collision) |
| No state line at all | Config block missing | Add `execution.commandInterceptor` |
| `executed` is always `null` | Verb not in `git.verbs` | Add the verb, or accept that only `log`/`diff` are eligible |
| `Project name collision` on run | Stale registration from a deleted directory | Rename `name` in config, or `nax migrate --reclaim <name>` |

---

## See also

- [Configuration Guide](configuration.md) — full schema
- `docs/superpowers/specs/2026-09-13-nax-mcp-client-design.md` — MCP design and rationale
- `docs/superpowers/specs/2026-09-13-nax-rtk-command-interception-design.md` — interception design, R10 ruling
- `docs/superpowers/specs/2026-09-13-nax-mcp-client-results.md` — measured MCP cost
