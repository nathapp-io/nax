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

Both come from the same profile, so setting a profile changes both at once.

## Profiles

`execution.permissionProfile` is one of `unrestricted` (the default), `safe`, or `scoped`.
Unset resolves to `unrestricted` — nax's own pipeline runs unattended and must be able to
edit files, run tests and commit. An *invalid* value is a different case: it fails closed to
`approve-reads` and logs, because reaching that arm means config validation was bypassed.

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
- The block is `.strict()`: a typo'd key is a load error rather than a silent drop.

## The expression grammar

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
3. **`ask`** — a match defers to the `AskResolver`; headless, it refuses (see below).

Deny beats ask beats allow. A call that matches nothing walks to the profile's grants: under
`unrestricted` a blanket-granted built-in is allowed, under `safe` and `scoped` it is denied.
`ask` is evaluated last so it can never grant — an ungranted command that also matches an
`ask` rule is a plain denial, not an approval prompt.

## `allowedTools` and the both-keys error

`allowedTools` is the legacy alias of `allow`, kept for the shape [Scoped
Permissions](../specs/scoped-permissions.md) first shipped. A block may use **one or the
other, never both**: a merge would silently decide which list wins, so carrying both is a
`NaxError` at load (`CONFIG_PERMISSIONS_ALLOW_ALIAS_CONFLICT`).

```json
{ "execution": { "permissions": { "run": { "allowedTools": ["Read", "Glob", "Grep"] } } } }
```

## Bash segment semantics

`Bash` takes a **model-authored command string** and runs it through
`[quality.shell, "-c", command]`. The string is lexed and split on `&&`, `||`, `;`, `|`,
`&` and newline into segments. Each segment is evaluated independently:

- **Every segment must match an allow rule.** `Bash(bun test *)` does not admit
  `bun test x && curl evil` — the second segment matches nothing.
- **No segment may match a deny rule.**
- **Payload checks run per segment**, after the match: `DENIED_FLAGS` (the install-hardening
  list from [Exec Allowlist](exec-allowlist.md) — `--registry`, `--index-url`, `--proxy`,
  `--prefix`, and the rest), path containment, `.git/` refusal, redirect targets, and the
  target of a `cd`.
- **A rule pattern is a token prefix with an optional trailing `*`.** `Bash(bun test *)`
  admits bare `bun test` and `bun test src/x.test.ts`; a trailing `*` means "and any
  arguments". A token containing `$`-expansion is *opaque*: only a bare `*` pattern can match
  it, never a literal rule token.

**Containment is always on.** Any path-like token, any redirect target, and any `cd` target
must resolve **inside the permitted root** and outside `.git/`; a target depending on `~`
expansion is refused because this gate cannot resolve it. Containment is not expressible in
config and no profile widens it.

**Refused outright — by name.** A payload the gate cannot read does not get a shell. These
constructs are refused under any grant: command substitution `$(...)`, backtick substitution,
here-documents `<<`, process substitution `<( )` / `>( )`, file-descriptor duplication
(`2>&1`), the `&>` redirect form, unbalanced quotes, a trailing backslash, an empty segment,
and a redirection with no target.

**Deny-all by default.** `Bash` is absent from the `unrestricted` blanket grant, has no
built-in pattern list of its own, and derives nothing from `quality.commands`. A shell
command runs only where a human wrote a `Bash(...)` allow rule for that stage.

## `ask`, and why it denies headless

An `ask` rule names a call that is not forbidden, only unapprovable without a human. It is
checked last; a match hands off to an `AskResolver`. v1 ships exactly one resolver, and it
denies: nax's pipeline is headless, so there is no one to ask. The refusal names the matched
rule and records the ledger outcome **`denied:ask`** (distinct from a plain `denied`).

```json
{
  "execution": {
    "permissions": {
      "run": { "allow": ["Read", "Bash(rm *)"], "ask": ["Bash(rm *)"] }
    }
  }
}
```

Metering first, mechanism later: a material rate of `denied:ask` rows is the evidence that
would justify building an interactive approval channel; zero rows means the seam stays
dormant.

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
  It is deliberately not config-expressible: no profile, and no rule, widens it.

## See also

- [Exec Allowlist](exec-allowlist.md) — the `Exec` argv branch, its built-in install list and
  install hardening.
- [MCP & Command Interception](mcp-and-interception.md) — attaching MCP servers and the `rtk`
  interceptor.
- [Scoped Permissions](../specs/scoped-permissions.md) — the original per-story allowlist
  spec.
- [Configuration](configuration.md) — the rest of the config surface.
