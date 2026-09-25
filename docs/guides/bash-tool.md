# The Bash Tool

How to give an agent a shell, and what nax does to make that survivable.

`Bash` runs **one model-authored shell command string** under `quality.shell` (default
`/bin/sh`). It is the widest capability nax has, and no permission profile grants it. How a
command is adjudicated is set by the **bash approval mode**
([ADR-030](../adr/ADR-030-bash-approval-modes.md)):

| `execution.bashApproval` | In short |
|:--|:--|
| `raw` (**default**) | Pass-through inside the OS sandbox. Any op that declares `Bash` can run any command; only a best-effort screen for nax's own files applies. |
| `gated` | The mechanical gate: a human-written `Bash(...)` rule, per-segment matching, containment, refusal of what the lexer cannot read. |
| `escalate` | `gated`, but a command the gate could not adjudicate is sent to a human instead of refused. |

The mode is root-only (`execution.bashApproval`) with a per-stage override
(`permissions.<stage>.bashApproval`). This guide is the task-oriented half. For the grammar,
precedence and profile table, see [Permissions](permissions.md); for the sandbox, see
[Sandbox and Command Safety](sandbox-and-command-safety.md).

## When to reach for it

Prefer the structured tools. `Read`, `Glob`, `Grep`, `Git` and `RunCommand` return bounded,
parseable output and are cheaper to gate, cheaper to audit and cheaper in tokens. `Bash` is
for what they cannot express.

| Want | Use |
|:--|:--|
| Run a project gate (`test`, `lint`, `typecheck`) | `RunCommand` with a declared command |
| Install a dependency | `Exec` — see [Exec Allowlist](exec-allowlist.md) |
| Read, search or list files | `Read` / `Grep` / `Glob` |
| Read-only git | `Git` |
| A one-off pipeline, a script invocation, a tool with no declared command | **`Bash`** |

A denial names the alternative where one exists, so a model that reaches for `ls -la` without
a grant is told the session already holds `Glob` rather than simply refused.

## Turning it on

**1. The operation must declare it** (every mode) — a code-owned ceiling, not config. Nine declarations
across eight fix-shaped operations hold `Bash`:

```
implement.ts  write-test.ts  rectify.ts  autofix-implementer.ts  autofix-test-writer.ts
full-suite-rectify-op.ts  acceptance-fix.ts (x2)  finish-fix.ts
```

Review, planning and verification operations do **not** declare it, so no config rule can
reach them. The verifier is deliberately on that list: it declares no `Exec`, so it cannot
install packages while judging the implementer's work, and a `Bash(...)` rule covering an
install command would hand that back by another route.

**2. Under `raw` (the default), that is all.** The op receives a synthetic `Bash(*)` grant, and
every call runs inside the OS sandbox. If the sandbox is enabled but unavailable on the host
(for example Linux without a usable bubblewrap), every raw call is refused with a reason naming
`gated` / `escalate`, and the tool description tells the model so up front. Set
`execution.sandbox.enabled: false` to run raw bash unsandboxed — an explicit choice.

**3. Under `gated` / `escalate`, a human must also write an allow rule** for the stage:

```json
{
  "execution": {
    "bashApproval": "gated",
    "permissions": {
      "run": { "allow": ["Bash(bun test *, bun x tsc *)"] },
      "rectification": { "inherit": "run" }
    }
  }
}
```

With the declaration but no rule, the stage is **inert**: its grants hold no `Bash`, so the tool
is never offered and nothing can escalate. `nax run` warns once per inert stage at setup:

```
bashApproval "escalate" on stage "run" grants no Bash (no Bash(...) allow rule) -- the agent is
not offered Bash, so nothing can escalate. Add one rule: "allow": ["Bash(ls *, cat *, git status*)"]
```

With the rule but no declaration, the tool never exists for that operation, in any mode.

## Writing rules

Rules shape `Bash` under `gated` and `escalate`. Under `raw` the patterns are not matched and
pattern `deny` / `ask` rules are not consulted — only a bare `"deny": ["Bash"]` still removes
the tool.

A pattern is a **token prefix** with an optional trailing `*`:

| Rule | Admits | Refuses |
|:--|:--|:--|
| `Bash(bun test *)` | `bun test`, `bun test src/a.test.ts` | `bun run build` |
| `Bash(git *)` + `deny: ["Bash(git push *)"]` | `git status`, `git log` | `git push origin main` |
| `Bash(*)` | everything the payload checks allow | — |
| `Bash()` | **nothing — a load error** | see below |

An **empty** pattern list is refused at config load for every tool. `Bash()` would otherwise
read as `Bash(*)`, which is the opposite of what anyone typing it meant. Write `Bash(*)` when
you mean it.

### One expression per tool, in an allow list

Put every pattern for a tool in **one** expression:

```json
"allow": ["Bash(bun test *, bun x tsc *)"]        // correct
"allow": ["Bash(bun test *)", "Bash(bun x tsc *)"]  // load error
```

The allow compiler is last-write-wins per tool, so the second form would grant only
`bun x tsc *` and silently drop the first. That is now a config load error naming the merged
form, rather than a grant that quietly goes missing until a command is denied mid-run.

`deny` and `ask` are the other way round — they **merge**, because a later rule must never
withdraw an earlier refusal — so duplicates there are legal and mean what they say:

```json
"deny": ["Bash(rm *)", "Bash(curl *)"]            // both apply
```

Rules are matched **per segment**: every segment of a `&&` / `||` / `;` / `|` chain must
independently satisfy an allow rule, and any segment matching a deny rule refuses the whole
call.

### A deny rule is not a containment boundary

`deny` matches the **first token of a segment**, not the process that ends up running.
`Bash(rm*)` refuses `rm -rf x`. It does not refuse `env rm -rf x`, `xargs rm`, or a script
that calls `rm` itself.

Use deny to narrow a broad allow for the cases you can name. The boundary that actually holds
is containment — the permitted root and `.git/` — and that is not expressible in config.

## What is refused, and why (`gated` / `escalate`)

Under `escalate`, the first two classes below (the lexer could not read it, or no allow rule
covered a segment) go to a human instead of being refused; see [Approvals](approvals.md). Under
`raw`, none of this applies.

**Refused by name.** A payload the gate cannot read does not get a shell:

| Construct | Example |
|:--|:--|
| command substitution | `echo $(whoami)` |
| backtick substitution | ``echo `whoami` `` |
| process substitution | `diff <(a) <(b)` |
| here-document | `cat <<EOF` |
| fd duplication / `&>` | `bun test 2>&1` |
| subshell | `( rm -rf x )` |
| `!` negation, `#` comment | `! false`, `echo hi # note` |
| option-shaped `cd` target | `cd -` |
| unbalanced quote, trailing backslash, dangling operator | `grep 'foo`, `bun test &&` |

Grouping and negation are on that list for a specific reason: they are shell *syntax*, so a
lexer that folded them into word text would hand the policy a first token of `(rm` or `!`
that no `Bash(rm*)` deny rule matches — while `/bin/sh` runs the `rm` regardless.

**Refused by containment.** Every path-like token, every redirect target and every `cd` target
must resolve inside the permitted root and outside `.git/`. Parameter (`$VAR`), tilde, glob
and brace expansions are refused because the gate cannot resolve their final paths.

**Refused by payload check.** The `DENIED_FLAGS` list from
[Exec Allowlist](exec-allowlist.md) (`--registry`, `--index-url`, `--proxy`, `--prefix`, …)
applies per segment: a prefix grant gates the verb, never the payload.

## Working directory and `cd`

The command runs in `ctx.root` — the hop's permitted root, the same root every path was
resolved against. A successful `cd` moves the containment base for later `&&` and sequential
segments; after `|`, `&` or `||` it does not, matching what the shell actually does.

## Runtime

| | |
|:--|:--|
| Shell | `quality.shell`, default `/bin/sh` |
| Deadline | `timeoutMs` input, floor 1s, default and ceiling 300s |
| Secrets | `quality.stripEnvVars` names are removed before the spawn |
| Sandbox | wrapped by `execution.sandbox` when available, in every mode; when it is unavailable, `raw` refuses and `gated` / `escalate` run unwrapped after one warning per process |
| Audit | every call is ledgered — `executed` records what ran, `sandbox` records `{ backend, wrapped, reason? }`, and `exitCode` the shell's exit code (absent on timeout or abort) |

## Debugging a denial

Refusals are written to the tool-audit ledger
(`<outputDir>/tool-audit/<feature>/*.json`) with `outcome: "denied"` and the full reason, so
the first move is to read the ledger rather than re-run the story. A call that reached the ask
tier and was not approved is recorded as `denied:ask` — distinct on purpose, because the
command is not forbidden, only unapproved (no channel, a timeout, or a human said no). Every
resolved ask also lands in `<outputDir>/approval-audit/<runId>.jsonl` with `decidedBy`.

| Refusal starts with | Cause |
|:--|:--|
| `sandbox unavailable (...): raw bash requires the sandbox` | `raw` with the sandbox enabled but the probe failing. Fix the host, or switch the stage to `gated` / `escalate`, or disable the sandbox. |
| `Bash command names "..."` / `redirects into "..."`, which nax owns | The `raw` screen caught a write to `.nax/config.json`, a PRD or a queue file. |
| `tool "Bash" is not permitted for this stage` | The op does not declare `Bash`, or a bare `Bash` deny removed it. |

## What this is not

**The gate is not the sandbox.** `gated` is safe-by-refusal: a construct the gate cannot analyse
is refused rather than executed under confinement, and containment binds only the paths the
gate can *see* in the command string, not what a granted binary then chooses to do. `raw` has no
gate at all. The OS sandbox is what bounds writes and credential reads at runtime — and it is a
blast-radius limiter for the agent's own mistakes, not a boundary against hostile repository
content (network is open by default). Without it (disabled, or unavailable under
`gated` / `escalate`), a granted command runs with the privileges of the nax process.

Under `gated`, grant accordingly: name the command forms you want, rather than writing
`Bash(*)` and relying on deny rules to claw scope back.

**Not the only way a command runs.** `quality.commands` and `acceptance.command` are run by key
through a shell and never pass this gate at all (spec R8) — they are trusted because a human
wrote them in config. So a `Bash(...)` deny rule does not constrain them, and a construct this
gate refuses by name still runs there.

That trust is enforced, not assumed: `.nax/config.json` and `.nax/mono/<package>/config.json`
are refused to every path-bearing tool, reads included, so an agent cannot add a quality command
and collect an ungated shell on the next run. The rest of `.nax/` stays readable. For `Bash`,
`gated` containment refuses those paths; under `raw` the advisory screen catches a parseable
write to them, and the sandbox write-denies them outright.

## See also

- [Permissions](permissions.md) — profiles, per-stage blocks, the grammar, precedence, `ask`.
- [Approvals](approvals.md) — what `escalate` and `ask` rules send to a human, and
  `nax approvals`.
- [Sandbox and Command Safety](sandbox-and-command-safety.md) — the OS sandbox and the shadow
  classifier.
- [ADR-030](../adr/ADR-030-bash-approval-modes.md) — bash approval modes.
- [Exec Allowlist](exec-allowlist.md) — the `Exec` argv branch and install hardening.
- `test/integration/permissions/bash-deny-suite.test.ts` — the feature's acceptance spine.
- `test/integration/permissions/bash-live-shell.test.ts` — the same refusals asserted as
  side effects against a real shell.
