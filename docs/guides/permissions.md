# Permissions

The single page for nax's permission surface: which tools an agent may use, in which
pipeline stage, against which paths and patterns. Everything below is resolved by one
function — `resolvePermissions(config, stage)` in `src/config/permissions.ts` — and enforced
for native coding tools by `src/tools/`.

Two consumers read that one resolution:

- **The permission mode** (`approve-all` / `approve-reads`) is what a CLI agent receives over
  ACP. It is a blanket posture, not a per-call gate.
- **The declarative grants** (`allow` / `deny` / `ask` rules) are what nax's own native
  coding tools enforce per call. `Bash`, `Exec`, `Read`, `Git` and the rest are checked here.
- **The bash approval mode** (`raw` / `gated` / `escalate`, [ADR-030](../adr/ADR-030-bash-approval-modes.md))
  decides how a `Bash` command string is adjudicated. It rides on the same resolution as
  `bashApproval`; see [Bash approval modes](#bash-approval-modes).

The first two come from the same profile, so setting a profile changes both at once.

## Profiles

`execution.permissionProfile` is one of `unrestricted` (the default), `safe`, or `scoped`.
Unset resolves to `unrestricted` — nax's own pipeline runs unattended and must be able to
edit files, run tests and commit. An *invalid* value is a different case: it fails closed to
`approve-reads` and logs, because reaching that arm means config validation was bypassed; that
arm also resolves `bashApproval` to `gated`, never `raw`.

| Profile | ACP mode | Provider (MCP) tools | Native grants | An UNMATCHED call |
|:--|:--|:--|:--|:--|
| `unrestricted` | `approve-all` | all attached | `Read` `Glob` `Grep` `Write` `Edit` `Delete` `Git` `GitCommit` `RunCommand` `RequestCapability`, each at `["*"]`; `Exec` limited to the built-in install list; **`Bash` nothing at all** | an unmatched built-in is allowed by its blanket `["*"]`; `Exec` and `Bash` are denied — they are excluded from the blanket |
| `safe` | `approve-reads` | none | `Read` `Glob` `Grep` only | denied |
| `scoped` | `approve-reads` | only what the stage's `Mcp(...)` rules name | only the stage block's `allow` rules; no baseline | denied |

```json
{ "execution": { "permissionProfile": "safe" } }
```

Every rule list binds under **every** profile (spec R10): a `deny` or `ask` you write applies
whether the profile is `unrestricted`, `safe` or `scoped`, and an `allow` rule is *added* to
whatever grant set the profile already carries. That is how an `allow` rule grants `Bash`
even under `unrestricted`, which grants no `Bash` on its own.

The one exception is the default `raw` bash mode: an operation that declares `Bash` receives a
synthetic `Bash(*)` grant when no human rule names `Bash`, and pattern `deny` / `ask` rules for
`Bash` are not consulted (only a bare, unconditional `Bash` deny still applies). See
[Bash approval modes](#bash-approval-modes).

## Per-stage blocks

`execution.permissions` is a map whose keys are pipeline stages plus the reserved key
`default`. A stage is one of `plan`, `run`, `setup`, `verify`, `review`, `rectification`,
`regression`, `acceptance`, `complete`.

Lookup order is **stage block → its `inherit` chain → `default` → nothing**. A stage that has
no block of its own falls to `default`. A stage that *has* a block uses it, even if empty —
defining a block shadows `default`; `inherit` is how you opt into another block's rules.

```json
{
  "execution": {
    "permissionProfile": "scoped",
    "permissions": {
      "run": {
        "allow": ["Read", "Glob", "Grep", "Write", "Edit", "RunCommand", "GitCommit"],
        "deny": ["Bash(git push *)"],
        "ask": ["Bash(rm *)"],
        "bashApproval": "gated",
        "inherit": "default"
      },
      "verify": { "inherit": "run", "allow": ["Read", "Glob", "Grep"] },
      "default": { "allow": ["Read", "Glob", "Grep"] }
    }
  }
}
```

Notes from the loader and guards:

- `inherit` must name a real block, and the chain must be acyclic. A dangling target or a
  cycle is a `NaxError` at load (`CONFIG_PERMISSIONS_BAD_INHERIT` /
  `CONFIG_PERMISSIONS_INHERIT_CYCLE`), not a surprise mid-run.
- The block is `.strict()`: a typo'd key is a load error rather than a silent drop. Its keys
  are `allow`, `deny`, `ask`, `allowedTools`, `inherit`, `bashApproval` and a declarative
  `mode` that the resolver does not read.
- `bashApproval` in a block overrides the root `execution.bashApproval` for that stage. Unlike
  the root key (root-only, [ADR-031](../adr/ADR-031-root-scoped-command-safety-config.md)), the
  permissions map stays per-package: a package's `permissions` map replaces the root's.
- Path globs in `allow` / `deny` / `ask` (and in `execution.denyPaths`) match **repo-rooted**
  paths, including in a `.nax/mono/<pkg>/config.json`: `Write(src/**)` means the repo's `src/`,
  not the package's ([ADR-032](../adr/ADR-032-single-frame-repo-rooted-paths.md)).

## The expression grammar

In an **allow** list, each tool may appear once: the allow compiler is last-write-wins per
tool, so `["Bash(a)", "Bash(b)"]` would grant only `b`. Write `Bash(a, b)`. `deny` and `ask`
merge instead, so duplicates there are legal and additive.

An **empty** pattern list is a load error for every tool: `Bash()` would otherwise read as
`Bash(*)`. Write `Bash(*)` when that is what you mean, or a bare `Bash`.

Every rule is a string. The tool name is everything before the first `(`; the parenthesised
part is a comma-separated pattern list. Patterns match per token, not against a joined string.

| Expression | Meaning |
|:--|:--|
| `Read` | The tool, unconditional (`["*"]`). |
| `Write(src/**,test/**)` | The tool, restricted to those globs. |
| `Git(diff,log)` | A tool whose match is a list of verb/subcommand patterns. |
| `Exec(bun install, bun add*, bun x tsc*)` | `RunCommand`'s **argv** branch; patterns match per argv token. See [Exec Allowlist](exec-allowlist.md). |
| `Bash(bun test *)` | The `Bash` shell tool; a space-separated **token prefix**, optional trailing `*`. See below. |
| `Mcp(server)` / `Mcp(server:tool)` | A **pseudo-tool**: expands to the concrete provider tools named. See below. |

### `Mcp(server[:tool])`

`Mcp` is surface syntax, expanded to concrete `<server>__<tool>` grants before the policy
compiles. Patterns merge across entries rather than overwriting, so two `Mcp(...)` rules name
two servers.

| Pattern | Admits |
|:--|:--|
| `Mcp(*)` | every tool of every attached server |
| `Mcp(codebase-memory)` | every tool of `codebase-memory` |
| `Mcp(codebase-memory:search_graph)` | one tool |
| `Mcp(codebase-memory:*)` | every tool of that server, written explicitly |

`scoped` admits exactly the provider tools its `Mcp(...)` rules name; `safe` resolves no
provider tools; `unrestricted` keeps every attached provider. Provider tools also require a
native-dispatch run — see [MCP & Command Interception](mcp-and-interception.md).

## Precedence

Evaluation order is fixed and order-independent within a stage:

1. **`deny`** — any matching deny rule refuses the whole call.
2. **`allow`** — the call must match an allow rule (for per-segment tools such as `Bash`,
   *every* segment must).
3. **`ask`** — a match defers to the ask resolver chain; with no human reachable, it refuses
   (see below).

Deny beats ask beats allow. A call that matches nothing walks to the profile's grants: under
`unrestricted` a blanket-granted built-in is allowed, under `safe` and `scoped` it is denied.
`ask` is evaluated last so it can never grant — an ungranted command that also matches an
`ask` rule is a plain denial, not an approval prompt. (Under `escalate`, an ungranted `Bash`
command reaches the ask tier for a different reason — see
[Bash approval modes](#bash-approval-modes).) Under `raw`, `Bash` skips this evaluation
entirely.

## `allowedTools` and the both-keys error

`allowedTools` is the legacy alias of `allow`, kept for the shape [Scoped
Permissions](../specs/scoped-permissions.md) first shipped. A block may use **one or the
other, never both**: a merge would silently decide which list wins, so carrying both is a
`NaxError` at load (`CONFIG_PERMISSIONS_ALLOW_ALIAS_CONFLICT`).

```json
{ "execution": { "permissions": { "run": { "allowedTools": ["Read", "Glob", "Grep"] } } } }
```

## Bash approval modes

`execution.bashApproval` (default **`raw`**) is overridable per stage with
`permissions.<stage>.bashApproval`, and resolves as *stage block → root key → `raw`*.

| Mode | How a `Bash` command is adjudicated |
|:--|:--|
| `raw` | Pass-through: no lexer refusal, no per-segment matching, no containment. One advisory screen refuses a *parseable* command that names or redirects into a path nax owns (`.nax/config.json`, `.nax/mono/*/config.json`, `.nax/features/**/prd.json`, the root queue files). An op that declares `Bash` gets a synthetic `Bash(*)` grant. With the OS sandbox enabled (the default), every raw call runs inside it; if the sandbox is enabled but unavailable, every raw call is refused with a reason naming `gated` / `escalate`. |
| `gated` | The segment semantics below. `Bash` is offered only where a `Bash(...)` allow rule resolves for the stage. |
| `escalate` | `gated`, except a denial the gate could not *adjudicate* (lexer refusal, no allow rule covering a segment) goes to the ask tier instead of `deny`. Affirmative refusals — outside the root, `.git/`, a denied flag, an explicit deny rule — stay refusals for granted commands. |

A stage under `gated` / `escalate` whose Bash-declaring op has no `Bash(...)` allow rule is
**inert**: the tool is never offered and nothing can escalate. `nax run` logs one warning per
inert stage at setup, naming the rule that would fix it. See [The Bash Tool](bash-tool.md) for
the task-oriented view and [Sandbox and Command Safety](sandbox-and-command-safety.md) for the
sandbox.

## Bash segment semantics (`gated` / `escalate`)

`Bash` takes a **model-authored command string** and runs it through
`[quality.shell, "-c", command]`. The string is lexed and split on `&&`, `||`, `;`, `|`,
`&` and newline into segments. Each segment is evaluated independently:

- **Every segment must match an allow rule.** `Bash(bun test *)` does not admit
  `bun test x && curl evil` — the second segment matches nothing.
- **No segment may match a deny rule.**
- **Payload checks run per segment**, after the match: `DENIED_FLAGS` (the install-hardening
  list from [Exec Allowlist](exec-allowlist.md) — `--registry`, `--index-url`, `--proxy`,
  `--prefix`, and the rest), path containment, `.git/` refusal, redirect targets, and the
  target of a `cd`; a successful `cd` changes the containment base for later
  `&&` and sequential segments.
- **A rule pattern is a token prefix with an optional trailing `*`.** `Bash(bun test *)`
  admits bare `bun test` and `bun test src/x.test.ts`; a trailing `*` means "and any
  arguments".

**Containment is always on.** Any path-like token, any redirect target, and any `cd` target
must resolve **inside the permitted root** and outside `.git/`. Parameter, tilde, glob, and
brace expansions are refused because this gate cannot resolve their final paths. Containment is
not expressible in config and no profile widens it.

**Refused outright — by name.** A payload the gate cannot read does not get a shell. These
constructs are refused under any grant: command substitution `$(...)`, backtick substitution,
here-documents `<<`, process substitution `<( )` / `>( )`, file-descriptor duplication
(`2>&1`), the `&>` redirect form, subshells `( ... )`, a leading `!` negation, a `#` comment,
an option-shaped `cd` target (`cd -`), unbalanced quotes, a trailing backslash, an empty
segment, and a redirection with no target.

Grouping and negation are on that list for a specific reason: they are shell syntax, so a
lexer that folded them into word text would hand the policy a first token of `(rm` or `!`
that no `Bash(rm*)` **deny** rule can match — while `/bin/sh` runs the `rm` regardless.

**A deny rule matches the first token of a segment, not the process that ends up running.**
`Bash(rm*)` refuses `rm -rf x`; it does not refuse `env rm -rf x`, `xargs rm`, or a script
that calls `rm` itself. Deny rules narrow a broad allow rule for the cases you can name —
they are not a containment boundary. Containment (the root, `.git/`) is, and it is not
expressible in config.

**No profile grants `Bash`.** `Bash` is absent from the `unrestricted` blanket grant, has no
built-in pattern list of its own, and derives nothing from `quality.commands`. Under `gated` /
`escalate` a shell command runs only where a human wrote a `Bash(...)` allow rule for that
stage; under the default `raw`, the op's own `Bash` declaration is what admits it.

## `ask`, and the approval gate

An `ask` rule names a call that is not forbidden, only unapprovable without a human. It is
checked last; a match hands off to the ask resolver chain (`src/permissions/ask-chain.ts`):
the **approvals cache** (a remembered human decision, byte-exact on stage and command), then
the **human** link (a prompt through the run's interaction channel), then a terminal deny.
With no human reachable — for example the default `cli` plugin in a headless run or without a
TTY — the call is refused. A refused ask records the ledger outcome **`denied:ask`** (distinct from a
plain `denied`); an approved one runs and its ledger row carries `approval.decidedBy`.

```json
{
  "execution": {
    "bashApproval": "gated",
    "permissions": {
      "run": { "allow": ["Read", "Bash(rm *, bun test *)"], "ask": ["Bash(rm *)"] }
    }
  }
}
```

A `Bash` ask rule only applies under `gated` / `escalate`; `raw` never consults it. The chain,
the prompt, remembered approvals and `nax approvals` are covered in [Approvals](approvals.md).

## What is NOT in this subsystem, and why

- **`quality.commands` and `acceptance.command`.** These are command templates a human put
  in project config, run by key through a shell. They are trusted by construction and are
  never wrapped, matched or denied by a permission rule (spec R8). A model cannot author
  them, so there is nothing here to gate.
- **`execution.commandInterceptor`.** Interception *rewrites* a `Git` call's argv through
  `rtk` to cut tokens. It is a transformation, not a permission decision — it never grants or
  denies anything. See [MCP & Command Interception](mcp-and-interception.md).
- **Operation tool declarations.** Which tools an operation may hold is a **code-owned
  ceiling** (spec R5): review and planning ops do not declare `Bash` or `Exec`, so no config
  rule can reach them. Config can *narrow* a ceiling (deny more, allow less), never *widen*
  it.
- **Containment.** The permitted root is a hard boundary enforced in `src/tools/policy.ts`.
  It is deliberately not config-expressible: no profile, and no rule, widens it. (`raw` Bash
  is the one tool it does not bind; there the OS sandbox limits writes instead.)
- **The OS sandbox and the command-safety shadow.** The sandbox changes *how* an
  agent-authored command runs, never *whether*; the shadow classifier records every command
  and decides nothing. See [Sandbox and Command Safety](sandbox-and-command-safety.md).

## See also

- [Approvals](approvals.md) — the ask resolver chain, remembered approvals and
  `nax approvals list` / `rm`.
- [Sandbox and Command Safety](sandbox-and-command-safety.md) — the OS sandbox around
  agent-authored commands and the shadow classifier.
- [The Bash Tool](bash-tool.md) — the task-oriented half: turning `Bash` on, writing rules,
  what is refused and why.
- [Exec Allowlist](exec-allowlist.md) — the `Exec` argv branch, its built-in install list and
  install hardening.
- [MCP & Command Interception](mcp-and-interception.md) — attaching MCP servers and the `rtk`
  interceptor.
- [Scoped Permissions](../specs/scoped-permissions.md) — the original per-story allowlist
  spec.
- [Bash Approval, Sandbox and Command Safety](configuration.md#bash-approval-sandbox-and-command-safety) —
  the root-only `execution.*` keys behind these modes.
- [ADR-031](../adr/ADR-031-root-scoped-command-safety-config.md) — why those keys are
  root-scoped.
- [Configuration](configuration.md) — the rest of the config surface.
