---
title: Approvals
description: The interactive approval gate — ask rules, the resolver chain, remembered approvals and `nax approvals`
---

# Approvals

How a native-agent tool call gets in front of a human, what nax does with the answer, and how
to inspect and revoke the approvals it remembers.

The gate is the **ask tier** of the permission policy. It never widens what an operation may
hold: it only decides calls the policy sent to `ask` instead of allowing or denying them. For
the rule grammar and precedence, see [Permissions](permissions.md). The design is recorded in
[ADR-030](../adr/ADR-030-bash-approval-modes.md) (P2 and later amendments).

## What reaches the gate

Two things produce an `ask` verdict:

- **An `ask` rule** that matches the call — for any native coding tool, e.g.
  `"ask": ["Bash(rm *)", "Write(migrations/**)"]`. `ask` is evaluated after `deny` and
  `allow`, so it never grants: an ungranted call that matches an `ask` rule is still denied.
- **`bashApproval: "escalate"`** for a `Bash` command the gate could not *adjudicate* — the
  lexer refused it (substitution, here-document, `2>&1`, …) or no allow rule covered a
  segment. An affirmative refusal of a granted command (outside the root, `.git/`, a denied
  flag, an explicit deny rule) is not escalated.

Under the default `bashApproval: "raw"`, `Bash` never reaches the gate: its pattern `ask`
rules are not consulted. See [The Bash Tool](bash-tool.md).

## The resolver chain

Every ask is resolved by one chain (`src/permissions/ask-chain.ts`); the first link that does
not abstain answers:

1. **Approvals cache** — a remembered human decision for this exact stage and command.
2. *(reserved)* — the slot a future classifier would occupy. Empty today.
3. **Human** — a prompt through the run's interaction channel.
4. **Terminal deny** — appended by the chain itself, so an empty or all-abstaining chain
   denies. A link that throws abstains; it never allows.

The verdict carries `decidedBy`:

| `decidedBy` | Meaning |
|:--|:--|
| `cache` | A remembered approval matched. |
| `human` | Someone answered the prompt (allow or deny). |
| `timeout` | Nobody answered within `execution.approvalTimeout`. |
| `unavailable` | No human is reachable, or the channel failed. |
| `cancelled` | The turn was cancelled while the prompt was waiting. |
| `unshowable` | The command holds a secret whose masked form could hide shell syntax; denied without prompting. |
| `model` | Reserved for the classifier slot. |

A denied ask is recorded in the tool-audit ledger as `outcome: "denied:ask"`; an approved call
runs, and its ledger row carries `approval: { decidedBy, remembered, latencyMs }`.

## Reaching a human

The human link talks to the run's interaction chain (`interaction.plugin`: `cli` by default,
`telegram`, or `webhook`). With the `cli` plugin, a headless run or a stdin that is not a TTY
has no one to ask, and every ask resolves `unavailable`. Telegram and webhook work without a
TTY. Under `escalate`, the `Bash` tool description tells
the model a human can approve only when one is reachable; otherwise it reads exactly like
`gated`.

### The prompt

The prompt is a `choose` interaction offering **Allow once**, **Allow + remember** and
**Deny**; **Allow + remember** appears only for calls that carry a command (see below). Any
other answer denies. It shows the command verbatim (inert secret values masked,
with a footer counting them), a one-line request summary, the directory it runs in, the reason
it was sent to the gate, and the stage.

- **One prompt at a time.** Prompts are serialized per run so behaviour is the same on every
  channel; concurrent asks for the same stage and command share one prompt.
- **Timeout.** `execution.approvalTimeout`, default `600000` ms (range 30 s – 1 h). It is
  deliberately separate from `interaction.defaults.timeout`: a permission timeout *denies*.
  The key is root-only ([ADR-031](../adr/ADR-031-root-scoped-command-safety-config.md)).
- **Waiting is not idling.** While a prompt is pending, the native turn's idle watchdog is told
  the turn is legitimately waiting.
- **Cancellation.** A cancelled turn settles its waiting asks as `cancelled`; when no waiter is
  left, the on-screen prompt is withdrawn.

```json
{
  "interaction": { "plugin": "telegram" },
  "execution": {
    "bashApproval": "escalate",
    "approvalTimeout": 300000,
    "permissions": { "run": { "allow": ["Read", "Bash(bun test *, git status*)"] } }
  }
}
```

## Remembered approvals

**Allow + remember** appends an entry to `<outputDir>/approvals.json` — by default
`~/.nax/<project>/approvals.json`, outside the repository — before the call runs. A remembered
approval is a cached human decision, not a rule: it matches **byte-exact** on
`(stage, command)`, with no trimming or normalization, so `bun run test` never also admits
`bun run test --reporter=./x`. Only calls that carry a command string (`Bash`) can match, so
the prompt offers **Allow + remember** only for those; any other tool gets **Allow once** and
**Deny**.

Each entry records `stage`, `command`, `root`, `origin`, `matchedRule`, `approvedAt`,
`approvedBy` and `naxCommit`. `origin` is `askRule` when an `ask` rule matched (and
`matchedRule` holds that rule verbatim) or `escalate` for an `escalate`-mode grant miss (and
`matchedRule` is `null`). `approvedBy` is the interaction plugin that answered (`telegram`,
`cli` or `webhook`). Entries written before this change carry `origin: "escalate"`,
`matchedRule: null` and `approvedBy: "telegram"` regardless. Its id is the first 8 hex characters of a SHA-256 of
`(stage, command, approvedAt)`, computed on read and never stored.

The cache link **abstains** — so the ask goes to the human — whenever it cannot trust the file:

- **A forge-capable run.** Any stage resolving to `raw` while `execution.sandbox.enabled` is
  `false`: an unsandboxed shell can write the file. With the sandbox enabled (the default), the
  approvals file is always write-denied inside it.
- **The file is inside the repository** (for example an `outputDir` under the repo root).
- **The store is tainted** (below). The file is re-read on every ask.
- **The entry's `root`** is not the project root or inside it (worktrees and package dirs are).

### Taint

`approvals.json` outlives the run, so a trusted run must not honour entries an earlier
forge-capable run could have written. nax keeps a `taint` marker in the file:

- A forge-capable run drops every entry and writes `taint` (with its run id and pid) before each
  story's agents start, and again after they finish.
- A run that trusts the cache clears the taint before building its link, **discarding** the
  entries beside it rather than promoting them — unless the tainting process may still be
  writing (the same run, or another nax process that is still alive).

The residual risk is stated in ADR-030: this defeats an agent that forges entries during its
story, not a hostile one that knows the scheme. The sandbox is the boundary.

## The approval audit

Every resolved ask — allow or deny, whichever link answered — appends one JSON line to
`<outputDir>/approval-audit/<runId>.jsonl`:

```json
{ "request": { "tool": "Bash", "stage": "run", "rule": "...", "summary": "...", "command": "..." },
  "decision": "allow", "decidedBy": "human", "latencyMs": 8421, "at": "2026-09-25T10:12:03.114Z" }
```

String values pass through secret redaction before they are written. A failed append never
turns an approval into a tool error.

## `nax approvals`

Both subcommands resolve the store the same way a run does: the project key is `name` from
`.nax/config.json` (falling back to the directory name), under `outputDir` (default
`~/.nax/<project>`).

### `nax approvals list`

```bash
nax approvals list [-d <dir>] [--json]
```

Prints the store path, a trust line, the count and one block per entry:

```
Approvals store: /home/me/.nax/my-app/approvals.json
Cache: trusted
2 remembered approvals

3f9a0c12  run  escalate  2026-09-25T10:12:03.114Z  telegram  naxCommit 1a2b3c4
          root /home/me/src/my-app
          $ bun test test/unit/foo.test.ts 2>&1 | tail -20
```

A tainted store prints `Cache: TAINTED since <time> by run <runId> (pid <pid>, alive|exited)
-- the cache is OFF; a trusted run will discard these entries.` Commands print raw — secret
values are **not** redacted here — but control characters are stripped so a forged entry
cannot inject terminal escapes. A missing or unparseable store prints
`No remembered approvals at <path>` (the latter with a warning on stderr).

`--json` prints one object: `{ path, state, taint, droppedMalformed, entries }`, where `state`
is `ok`, `missing` or `unparseable` and each entry carries its computed `id`.

### `nax approvals rm`

```bash
nax approvals rm <id...>            # one or more 8-hex-character ids
nax approvals rm --stage <stage>    # every entry for one stage
nax approvals rm --all [--yes]      # everything; confirms on a TTY unless --yes
```

Exactly one selector is required. Removal is atomic and all-or-nothing: an unknown id refuses
the whole command (`Unknown id(s): ...`) and writes nothing. Each removed entry prints
`removed <id>  <stage>  <command preview>`. `--all` without `--yes` and without a TTY aborts.
If a run is writing the store, the command exits 1 with `a nax run is writing <path>; retry`.

`rm` never clears a taint marker: only a trusted run does that.

## See also

- [Permissions](permissions.md) — `ask` rules, precedence and the bash approval modes.
- [The Bash Tool](bash-tool.md) — `raw`, `gated` and `escalate` in practice.
- [Sandbox and Command Safety](sandbox-and-command-safety.md) — why the sandbox is what makes
  the cache trustworthy under `raw`.
- [Triggers](triggers.md) — the interaction plugins the human link reuses.
- [ADR-030](../adr/ADR-030-bash-approval-modes.md) — bash approval modes, the resolver chain,
  the cache's trust boundary and taint.
