# Exec Allowlist

How to configure what an agent may execute through `RunCommand`'s argv branch (`Exec`).

`Exec` is the only path on which nax runs a command the **model** wrote. Everything else it
runs comes from a template a human put in config. That difference is why this capability is
allowlisted by default and why widening it is a deliberate act.

## The two branches of `RunCommand`

`RunCommand` accepts exactly one of two inputs, and they never share a resolution path:

| | Declared branch | Argv branch (`Exec`) |
|:--|:--|:--|
| Input | `{"command": "typecheck"}` | `{"argv": ["bun","add","-d","zod"]}` |
| Comes from | `quality.commands` in config | the model |
| Shell | yes | **no** |
| Author | a human | the model |

The declared branch resolves a **key** from `quality.commands` and runs the configured value
through a shell, because a declared command like `CI=1 bun test {{files}}` has no argv form.
The argv branch takes a literal argument vector, spawns without a shell, and is checked
against an allowlist.

Both are the same tool because that is where the model already reaches. The gap this closed:
an agent that needed a missing package had no legal way to install it, so it deleted the
requirement from `tsconfig.json` instead and the story passed.

## Two gates, both required

An `Exec` call runs only when **both** hold:

1. **The operation declares it.** `Exec` is a capability marker in an op's `tools` list.
   The ops that declare it are the ones that write code: `implement`, `write-test`,
   `rectify`, `autofix-implementer`, `full-suite-rectify`, `finish-fix`. A review or
   planning op cannot install anything, whatever config says.
2. **The policy grants it.** Either the built-in list below, or an `Exec(...)` expression
   you write.

## Default: install forms only

`execution.permissionProfile` defaults to `unrestricted`, which means "any tool, any path
within the root". `Exec` is deliberately **excluded** from that blanket grant — letting
`unrestricted` also mean "any command" would ship a general exec to every run, which
[ADR-029](../adr/ADR-029-phase-c-native-coding-agent-scope.md) section 3 forbids.

Instead it gets `BUILT_IN_EXEC_PATTERNS` (`src/config/permissions.ts`):

```
bun install      npm ci            pnpm install*    yarn install*
bun add*         npm install*      pnpm add*        yarn add*
pip install*     uv sync*          uv add*
go mod download  go get*           cargo fetch      cargo add*
```

Nothing else. `bun x tsc --noEmit` is not an install form and is denied under the default
profile — deliberately, since the declared branch already covers running project checks.

A denial names what would have been allowed:

```
Exec is not granted for argv "bun x tsc --noEmit" -- granted forms: bun install,
bun add*, npm ci, npm install*, pnpm install*, ...
```

## Granting more

Write an `Exec(...)` expression in a scoped permissions block:

```json
{
  "execution": {
    "permissionProfile": "scoped",
    "permissions": {
      "run": {
        "allowedTools": [
          "Read", "Write", "Edit", "RunCommand", "GitCommit",
          "Exec(bun install, bun add*, bun x tsc*)"
        ]
      },
      "default": { "allowedTools": ["Read", "Glob", "Grep"] }
    }
  }
}
```

Patterns are comma-separated inside the parentheses and matched **per argv token**, not
against a joined string — `bun add*` matches `["bun","add","-d","zod"]` but not
`["bunx","add"]`.

> **Your expression REPLACES the built-in list; it does not extend it.**
> A project that writes `Exec(bun x tsc*)` and still wants installs must name those too.

Blocks are looked up as *stage → `inherit` target → `default` → no grants*. Note that
`scoped` resolves the permission mode to `approve-reads`, not `approve-all`.

`Exec(*)` grants any command that survives validation and the guard rails below. It is a
general exec; treat it as such.

## What is refused regardless of grant

These run **before** any pattern match, so a malformed token can never be admitted by a `*`:

- Non-array argv, empty argv, a non-string or empty element.
- Any shell metacharacter in any element.
- A leading `~` (it would depend on shell expansion this path never performs).
- A binary containing `/` or `\` — `argv[0]` must resolve through `PATH`. A path would let
  a model point execution at a file it just wrote.

And after the match:

- **Package runners** `npx`, `bunx`, `pnpx`, and the `dlx` verb — always denied. They
  execute an arbitrary model-named package, outside the hardening model entirely.
- **Flags that change where code comes from, or whether an untrusted source is accepted**
  (`DENIED_FLAGS` in `src/tools/exec-guard.ts`): `--registry`, `--index-url`,
  `--extra-index-url`, `--index`, `-i`, `--trusted-host`, `--cert`, `--strict-ssl`,
  `--cafile`, `--ca`, `--proxy`, `--https-proxy`, `--noproxy`, `--config`, `--userconfig`,
  `--global`, `-g`, `--prefix`, `--unsafe-perm`.

  These are enumerated rather than pattern-matched, precisely because no verb pattern can
  be trusted to imply their absence. This check runs *after* the grant match, because a
  prefix grant gates the verb, not the payload.

## Install hardening

Classification fails closed:

- A known manager **plus an install verb in the verb position** is *install-shaped* and gets
  hardened.
- A known manager with an install verb **anywhere else** in the argv is **denied**, not
  passed through as generic.
- Anything else is *generic* — reachable only through a hand-written grant.

For an install-shaped call, nax appends the manager's no-scripts mechanism and normalizes
for workspaces. **nax builds the final argv, so the model cannot remove it:**

| Manager | Mechanism |
|:--|:--|
| bun, npm, pnpm | `--ignore-scripts` |
| yarn 1 | `--ignore-scripts` |
| yarn 2+ | `YARN_ENABLE_SCRIPTS=false` (Berry has no `--ignore-scripts`; passing it is a hard error) |
| go, cargo | no lifecycle-script mechanism needed |
| **pip, uv** | **none — see below** |

The ledger records both what was asked and what ran:

```json
{ "tool": "Exec", "outcome": "ok",
  "input":    { "argv": ["bun","add","-d","bun-types"], "target": "package" },
  "executed": ["bun","add","-d","bun-types","--ignore-scripts"],
  "target":   "package" }
```

> ⚠️ **pip and uv carry no no-scripts mechanism.** None could be confirmed from their
> documentation, so both are recorded as having none. They still ship in the default list;
> for those two the allowlist plus positional-path containment carry the property, not a
> flag. If that is not good enough for your threat model, write a scoped grant that omits
> `pip install*` and `uv add*`.

### Opting out of hardening

```json
{ "install": { "allowScripts": true } }
```

Defaults to `false`. This is config a human writes; the model cannot reach it.

## Working directory

`target` selects the cwd: `"package"` (default) or `"repoRoot"`.

`Exec` may run **outside** the otherwise-hard containment root, because workspace managers
write the root manifest and lockfile by design — for this tool the root is a cwd choice,
not a sandbox. The paired carve-out is that `GitCommit` may stage the exact paths a
same-hop install touched. That set is built fresh per dispatch hop, matched exactly (never
as a prefix), and never persisted across stories or sessions.

Positional path arguments **are** containment-checked. Without that, `pip install
/somewhere/outside` would execute a `setup.py` from outside the root.

## Verifying it works

Check the tool-audit ledger for the run
(`<global>/<project>/tool-audit/<feature>/*.json`) and look for `tool: "Exec"`. A working
install shows `outcome: "ok"`, an `executed` argv carrying the hardening mechanism, and a
`target`. A refusal shows `outcome: "denied"` with a `reason` naming the granted forms.

## Troubleshooting

| Symptom | Cause |
|:--|:--|
| `Exec is not granted for argv "..."` | The form is not in the grant. The message lists what is. Under the default profile only install forms are granted. |
| `tool "Exec" is not permitted for this stage` | The operation does not declare `Exec` — a review or planning op cannot install. |
| `the command must resolve through PATH, not a path` | `argv[0]` contains `/` or `\`. |
| `argv element contains a shell metacharacter` | The argv branch never uses a shell; split the command into real argv elements. |
| Agent edits config to remove a dependency instead of installing it | The behaviour this feature exists to prevent. Check the ledger for a denied `Exec` and widen the grant, or confirm the op declares `Exec`. |

## See also

- [ADR-029](../adr/ADR-029-phase-c-native-coding-agent-scope.md) section 3 — the recorded
  override permitting model-authored execution, its carve-outs, and its evidence limits.
- [Configuration](configuration.md) — the rest of the config surface.
