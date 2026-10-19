# MCP Servers and Command Interception

Two independent, opt-in features that change what tools the coding agent has and what
actually runs when it calls one:

- **`mcp`** — attach external Model Context Protocol servers as extra tools.
- **`execution.commandInterceptor`** — rewrite what the native agent's commands actually
  execute through a token-reducing proxy (`rtk`). Two sites: the `Git` tool's argv and the
  `Bash` tool's model-authored command string.

They share no code and can be enabled independently.

---

## The prerequisite that governs both

**The interceptor reaches the native agent only. MCP reaches the native agent, and ACP agents that have a pre-approval channel.**

Coding tools (`Git`, `Bash`, and the rest) are consumed by the native turn loop
(`packages/nax-agent/src/native/session/turn-loop.ts`). The ACP adapter accepts a
`codingTools` argument in its `sendTurn` signature but never consumes it: an ACP agent
(`claude`, `codex`, `opencode`, `gemini`, `pi`) brings its own tool implementations, so nax's
`Git` and `Bash` tools are never invoked, and `execution.commandInterceptor` has no effect on
it.

MCP provider tools cross into ACP sessions only where the agent's registry entry declares a
pre-approval channel. Today that is `claude` (`claudeCode.allowedTools`). Those tools are
served through a loopback host as `mcp__nax__<name>` and pre-approved at open
(`packages/nax/src/agents/acp/provider-embedder.ts`). Any other ACP agent receives no provider
tools, and its session records `mcp-pre-approval-unsupported` in `toolSurface.skippedProviders`.

Before either block does anything, the project must dispatch to `native`:

```json
{
  "agent": {
    "protocol": "hybrid",
    "default": "native"
  }
}
```

A project left on `"protocol": "acp"` with a non-claude agent can carry a complete, valid `mcp` and
`commandInterceptor` config and get **zero** effect from both, with no error. Config
validity is not activation — verify with the evidence checks below rather than assuming.

> The built-in defaults are `"protocol": "hybrid"` / `"default": "native"`, so neither block is
> gated off by the protocol out of the box; they go dormant only when a config switches to an ACP
> agent without a pre-approval channel (for the interceptor, any ACP agent). The interceptor itself still ships disabled (`commandInterceptor.enabled: false`).

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
| `instructions` | *(omitted)* | Optional server instructions text. `{workdir}` is replaced with the story's workdir. |

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

#### Global lock

A server you configure the same way in every project (in `~/.nax/config.json`) can be
pinned once for all of them:

```bash
nax mcp lock --global
```

This runs the same trust gate and connects the same servers as `nax mcp lock`, but writes
`~/.nax/mcp-lock.json` (`<globalConfigDir>/mcp-lock.json`; `NAX_GLOBAL_CONFIG_DIR`
overrides the directory).

At session start nax resolves exactly one lock:

1. If `<project>/.nax/mcp-lock.json` exists, it is the lock, and the global lock is
   **not** consulted. The project lock overrides the global one wholesale; entries are
   not merged. A project lock that is malformed or unreadable resolves to no lock, so
   every MCP tool is withheld (fail closed); nax does not fall back to the global lock.
2. Otherwise `~/.nax/mcp-lock.json` is the lock, if it exists and is valid.
3. Otherwise there is no lock and every MCP tool is withheld.

A lock is keyed by server id only. A global entry for `memory` pins whatever server a
project without its own lock configures under the id `memory`, so keep ids consistent
across projects, or commit a project lock where a project's server differs.

Each `[provider] <id>__<tool> withheld` warn line, and each `withheld` entry in the MCP
rollup, carries `lockSource`: `project`, `global`, or `none` (no lock resolved). Use it
to tell which file needs re-locking.

### Choose `stages` deliberately

`stages` is narrower than it looks. With `stages: ["run"]` on a two-story feature, only
the implementer and test-writer sessions ever see the tools — the reviewer, verifier and
acceptance sessions do not, even though they do plenty of exploration. Measured on the
`native-full-run` fixture: **3 of 18 sessions** had the tools available.

Stage coverage is exact, not inherited: `run` does **not** cover `review`, `verify` or
`rectification` — a server must list every stage that should see its tools (or `["*"]`).
A stage-mismatched skip is visible in two places: a once-per-session debug line
(`mcp [provider] <id> not attached`, with the session's stage and the server's stages)
and the session's `toolSurface.skippedProviders` block in the tool-audit ledger.

Stage-granted tools are visible to **every op in that stage** — including read-only ops
whose sessions open with the `read` ACP profile. MCP filtering is stage-level by design;
there is no per-op MCP scoping.

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

### What each session was offered: `toolSurface`

Every session that resolved provider tools stamps a `toolSurface` block into its
tool-audit file (`tool-audit/<feature>/<runId>-<stamp>-<session>.json`), on both the
native and ACP transports:

```jsonc
{
  "toolSurface": {
    "stage": "review",
    "transport": "acp",          // "native" | "acp"
    "profile": "read",           // ACP only: the narrowed session profile
    "declaredTools": ["Read", "Glob", "Grep"],
    "advertised": [{ "providerId": "codegraph", "names": ["search_graph"] }],
    "withheld": [{ "providerId": "codegraph", "name": "write_graph", "reason": "not-admitted" }],
    "skippedProviders": [{ "id": "runonly", "reason": "stage-mismatch", "stages": ["run"] }],
    "failures": []
  }
}
```

- `advertised` is what the model actually saw; `withheld`/`skippedProviders`/`failures`
  explain the rest. On ACP, an `mcp-pre-approval-unsupported` skip means the agent has
  no pre-approval channel (claude only, today) and the session opened tool-less.
- On the ACP path, a tool bound by an `Mcp(...)` **deny or ask rule is withheld at
  delivery** (`reason: "denied"` / `"ask-ruled"`) — claude pre-approves what it is
  handed, so delivery is the only point that rule could be enforced.
- A session that resolves a surface but calls zero tools still writes its file: the
  never-called session is exactly the case worth seeing.

### End-of-run adoption summary

Run completion aggregates the run's tool-audit files per configured server into the
feature `status.json` (`mcpAdoption`): `sessionsOffered`, `sessionsCalled`,
`totalCalls`. A server with `sessionsOffered > 0` and `totalCalls == 0` also logs a
`[WARN]` (`mcp: <id> was offered to N session(s) and never called`) — that is the
zero-adoption signal, and it is a property of the session population (wrong `stages`,
wrong stage, or the model declining), not of the connection.

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
      "git": { "verbs": ["log", "diff"] },
      "bash": { "enabled": true }
    }
  }
}
```

| Key | Default | Meaning |
|:---|:---|:---|
| `provider` | `"rtk"` | Interceptor implementation. |
| `enabled` | `false` | **Off by default** — opt in per project. The master switch for both sites. |
| `git.verbs` | `["log", "diff"]` | Git subcommands eligible for rewriting. Anything else passes through untouched. |
| `bash.enabled` | `false` | Opt in to the `Bash` site: the model-authored command string is offered to the provider before it runs. Requires `enabled: true`; the config is rejected otherwise. |

Requires the `rtk` binary on `PATH` (`rtk --version`, `rtk gain` to confirm you have the
right one — a different project also ships an `rtk`).

### Scope: the Git argv and the model-authored Bash command

nax intercepts exactly two things, and neither is a string you wrote:

- the `Git` tool's **argv**, which nax builds itself from the structured fields the model
  supplied (never a shell string);
- the `Bash` tool's **command string**, which the model authored.

nax does **not** wrap user-authored command strings — `quality.commands`, `acceptance.command`
and every other config-supplied command are never intercepted. That is a standing ruling
(spec R10), not an oversight: there is no saving on the success path, and the failure path is
shape-dependent (a Bun stack trace compresses ~58%, Biome diagnostics 0%). Wrapping them
would also move trust from your project config to a third-party binary.

R10 does not cover the `Bash` tool, and that is the whole reason the site exists: the
"I can write `rtk` into the line I own" argument needs an owner, and no human owns the line
the model writes. There is nothing to write `rtk` into. So `Bash` gets a provider rewrite
instead — and because the provider's answer would otherwise be arbitrary text on its way to
`/bin/sh -c`, nax validates it first (below). The permission policy and the command-safety
guard still judge the model's **original** command: the rewrite happens inside the tool, after
`callTool` has already reached its verdict.

### The Bash site: what a provider rewrite must look like

Interception happens inside `Bash.run`, so the order is fixed: policy verdict first,
interception second. The provider (`rtk rewrite`) proposes; `validateShellRewrite` accepts a
candidate only when it is the original plus literal `rtk ` insertions at command words, byte
for byte. Everything else is declined and the original command runs.

| Rule | What it refuses |
|:---|:---|
| Byte-exact insertion | The candidate's only difference from the original is `rtk ` where the original continues. Re-spaced `&&`, re-quoted arguments and normalised whitespace are all declined. |
| At least one insertion | A candidate identical to the original is `unchanged`, not a rewrite. |
| Both lex | A command the shell lexer refuses (command substitution, `2>&1`, a subshell) is never rewritten — under the `raw` approval mode such a command can reach the tool, and it runs unrewritten. |
| Insertion sits at the command word | The insertion follows any leading `NAME=value` assignments and precedes the actual command. `uv run pytest -q` → `uv run rtk pytest -q` is declined: `rtk` is not the command word there. |
| Never a segment already prefixed with `rtk` | `rtk bun test` → `rtk rtk bun test` is declined. |
| Never inside a pipeline | A segment whose own separator is `\|` writes into a pipe, and one whose predecessor's is `\|` reads from it: compaction would change what the neighbouring program sees. |

`rtk read src/a.ts`, `rtk tsc --noEmit` and every other rewrite that changes the command word
are therefore declined — widening the validator is a separate change, not a config option.
The rewrite runs in the nax process on the host, never inside the sandbox, and the provider
gets at most `RTK_REWRITE_TIMEOUT_MS` (2000 ms, an exported constant) before the child is
killed.

### What a rewrite looks like

An eligible call has its argv (Git) or command string (Bash) prefixed — for `Bash`, `rtk ` is
inserted at the command word of each rewritten segment — and the ledger records what actually
ran:

```
tool   verb   executed
Git    diff   ['rtk','git','diff','--relative','1c008758..HEAD','--','.', ':!.nax/']
Git    log    ['rtk','git','log','--relative','--oneline','1c008758..HEAD','--','.']
Git    show   None      <- not in git.verbs, passed through
Git    status None      <- not in git.verbs, passed through
Bash   -      ['/bin/sh','-c','rtk bun test src/a.test.ts']
Bash   -      ['/bin/sh','-c','cat src/a.ts']   <- candidate declined by the validator
```

### Output hint stripping

rtk appends a trailing hint to its output, e.g.
`[full diff: rtk git diff --no-compact]`, `[full output: rtk …]`, `[+12 hidden: rtk …]`.
Those hints are instructions for a human at a shell, not something either tool can run,
so they are stripped before the output reaches the model. Stripping is hint-shaped, not a trim: output with no trailing hint is
returned byte-for-byte. A hint on a **non-rewritten** command's output is a different matter:
the interceptor is consulted only for output of a command it actually rewrote, so an
unintercepted `rtk` invocation the model wrote itself keeps its hint.

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

### Fail-open and decline behaviour

Interception never breaks a run, on either site:

| Situation | Result |
|:---|:---|
| `enabled: false` | `unchanged` — every argv and every command string passes through. |
| `bash.enabled: false` (the default) | `unchanged` for the `Bash` site; `rtk rewrite` is never spawned. |
| `rtk` not on PATH | `declined` with reason `rtk binary not found on PATH`; the plain command runs. |
| Probe throws | `declined` with the probe error; the plain command runs. |
| Verb not in `git.verbs` | `unchanged`. |
| `rtk rewrite` exits 1, or exits 0/3 with empty stdout or the command itself | `unchanged`; the original runs. |
| `rtk rewrite` exits 2 (a Claude deny rule) or any other code | `declined` with `rtk rewrite exited <code>`; the original runs. |
| `rtk rewrite` exceeds `RTK_REWRITE_TIMEOUT_MS` | the child is killed; `declined` with `rtk rewrite timed out`; the original runs. |
| `rtk rewrite` cannot be spawned | `declined` with `rtk rewrite failed: <message>`; the original runs. |
| The interceptor's `interceptShell` throws | caught at the seam; the original runs. |
| The candidate fails any validator rule above | `declined` with that rule's reason; the original runs. |
| A rewritten command runs and exits non-zero | its exit code and output are returned as-is — nax never re-runs the original. |
| `postProcess` throws on a rewritten command's stdout | the raw stdout is used. |
| No interceptor installed (an entry point that skips `setupRun`) | the original runs, unrewritten. |
| `bash.enabled: true` while `enabled: false` | config validation fails: `execution.commandInterceptor.bash.enabled requires execution.commandInterceptor.enabled`. |

The state line is emitted **once per run regardless**, so a run with interception off is
distinguishable in its artifacts from a run that simply made no git calls.

### Verifying it actually intercepted

1. **State line**, in a `--verbose` run log:

   ```
   execution rtk interceptor state  { "enabled": true, "version": "rtk 0.45.0", "verbs": ["log","diff"], "bash": true }
   ```

   `version: null` with `enabled: true` means the binary probe failed — check `declined`.
   `bash` reports the configured value, so an arm with the Bash site on is distinguishable
   after the fact.

2. **The ledger**, which is the proof. In
   `~/.nax/<project>/tool-audit/<feature>/*.json`, an intercepted call carries
   `executed` starting with `rtk`; a passed-through call has `executed: null`.
   Seeing `log`/`diff` rewritten *and* `status`/`show` untouched confirms verb filtering
   works rather than everything being blanket-wrapped. A `Bash` row reads
   `['/bin/sh','-c','rtk bun test src/a.test.ts']` when the command was rewritten, and
   `['/bin/sh','-c','bun test src/a.test.ts']` when the provider's candidate was declined —
   the command nax actually ran, never the model's original.

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
(`src/config/paths/`). Two runs of the same project append to the same tree — separate
them by `runId` or timestamp before comparing.

---

## Troubleshooting

| Symptom | Cause | Fix |
|:---|:---|:---|
| No `[provider] advertised` lines at all | Project dispatches to an ACP agent without a pre-approval channel (only `claude` has one) | Set `agent.protocol: "hybrid"`, `agent.default: "native"`, or use `claude` |
| Server connects, zero tool calls | Model chose not to use it | Expected on small repos — `Grep` is cheaper there. Not a defect. The run's `mcpAdoption` status block and the end-of-run `[WARN]` make this visible per server |
| Tools never grantable | No lockfile, or tool absent from it | Run `nax mcp lock`, commit the result (or `nax mcp lock --global` for a global server). `lockSource` on the withheld line names the lock that decided it |
| Global lock ignored in one project | That project has its own `.nax/mcp-lock.json`, which overrides the global lock wholesale | Re-run `nax mcp lock` in the project, or delete its lock to fall back to the global one |
| Provider tools silently absent | `safe` profile, or `scoped` with no `Mcp(...)` rule naming them | Set `execution.permissionProfile: "unrestricted"`, or add the stage's `Mcp(...)` rule under `scoped` |
| Server attaches to nothing | `stages: []`, or `stage:` typo | Set `stages` to real stage names or `["*"]` — and remember `run` ≠ `review`/`verify`/`rectification` |
| `rtk interceptor state` shows `version: null` | Binary not found or probe failed | `which rtk`; confirm `rtk gain` works (name collision) |
| No state line at all | Config block missing | Add `execution.commandInterceptor` |
| `executed` is always `null` | Verb not in `git.verbs` | Add the verb, or accept that only `log`/`diff` are eligible |
| `Bash` rows never show `rtk` | `bash.enabled` is false, the command is not one the validator accepts, or `rtk rewrite` declined it | Check the state line's `bash` value, then reproduce with `rtk rewrite '<command>'` — a rewrite that changes the command word (`cat` → `rtk read`) is declined by design |
| `Project name collision` on run | The name is registered to another workdir whose git remote differs (a checkout or worktree of the same remote is accepted) | Rename `name` in config, `nax migrate --reclaim <name>`, or `nax migrate --merge <name>` |

---

## See also

- [Configuration Guide](configuration.md) — full schema
- `docs/superpowers/specs/2026-09-13-nax-mcp-client-design.md` — MCP design and rationale
- `docs/superpowers/specs/2026-09-13-nax-rtk-command-interception-design.md` — interception design, R10 ruling
- `docs/superpowers/specs/2026-09-13-nax-mcp-client-results.md` — measured MCP cost
