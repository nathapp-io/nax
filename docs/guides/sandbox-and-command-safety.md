---
title: Sandbox and Command Safety
description: The OS sandbox around agent-authored commands, and the command-safety shadow classifier
---

# Sandbox and Command Safety

Two runtime layers around the commands a **native** agent writes itself — `Bash` command
strings and `RunCommand` `Exec` argv:

- **The OS sandbox** (`src/sandbox/`, `execution.sandbox`) changes *how* such a command runs:
  it is wrapped so writes and credential reads are confined. **On by default.**
- **The command-safety shadow** (`src/command-safety/`, `execution.commandSafety`) records a
  classification of every such command beside the verdict the policy actually reached. It
  decides nothing. **Off by default.**

Neither decides *whether* a command runs — that is the permission policy's job alone
([Permissions](permissions.md)). Both are recorded in
[ADR-030](../adr/ADR-030-bash-approval-modes.md) (P4, P5 and the 2026-09-25 default-on
amendment), and all four `execution` keys involved are root-only
([ADR-031](../adr/ADR-031-root-scoped-command-safety-config.md)): a package config that sets one
is warned about and ignored.

ACP agents bring their own tools and are not affected by either layer.

---

## Part 1 — The OS sandbox

### What it wraps

Exactly two spawn sites: the `Bash` tool and `RunCommand`'s argv branch (`Exec`). nax's own
declared commands — `quality.commands`, `acceptance.command`, worktree dependency installs, the
per-story gates — are never wrapped. The launcher is only handed to the two agent-authored
sites, so this holds by construction.

The sandbox is set up per session only when the operation declares `Bash` or `Exec`.

### Posture by bash approval mode

| | Sandbox available | Enabled but unavailable | Disabled (`enabled: false`) |
|:--|:--|:--|:--|
| `raw` Bash (default) | wrapped | **every call refused**, naming `gated` / `escalate` | runs unwrapped |
| `gated` / `escalate` Bash | wrapped | runs unwrapped (one warning per process) | runs unwrapped |
| `Exec` | wrapped | runs unwrapped | runs unwrapped |

So the default posture is **raw bash inside the sandbox**. On a host without a working sandbox,
raw bash is refused rather than silently unsandboxed, and the `Bash` tool description says so
before the model tries. No mode changes posture silently in either direction.

The refusal reads:

```
sandbox unavailable (<reason>): raw bash requires the sandbox when execution.sandbox.enabled is
true -- set this stage's bashApproval to gated or escalate, or disable the sandbox.
```

### What the sandbox allows

The policy is rebuilt for every call (so a `.nax/` entry created mid-run still gets its deny),
and every path in it is literal and realpath-resolved.

| | Paths |
|:--|:--|
| **Writable** | the story root (repo or worktree); the system temp dir and `/tmp`; package-manager caches under `$HOME` (`.bun/install/cache`, `.npm`, `.cache`, `.cargo/registry`, `.cargo/git`, `go/pkg/mod`, `.gradle/caches`, `.m2/repository`, `.pnpm-store`; plus `Library/Caches` and `/tmp/claude` on macOS); `filesystem.allowWrite` |
| **Write-denied inside those** | every top-level `.nax/` entry except `.nax/scratchpad/` (whole: `features/`, `rules/`, `cache/`, ...), plus the entries nax loads as input even when absent (`config.json`, `mono/`, `rules/`, `context.md`, `hooks.json`, `plugins/`, `templates/`, `prompts/`); the root queue files (`.queue.txt`, `.queue.txt.processing`), the approvals file, and the git guards below |
| **Unreadable** | `~/.ssh`, `~/.aws`, `~/.config/gcloud`, `~/.docker/config.json`, `~/.netrc`, `~/.npmrc`, `~/.pypirc`, `~/.git-credentials`, `~/.config/gh`, nax's own `credentials*` files; `filesystem.denyRead` |
| **Network** | unrestricted unless `network.allowedDomains` is set |

The file tools (Write, Edit, Delete, GitCommit) apply the same `.nax/` rule in-process, with
one addition the sandbox cannot express: a test file directly inside a feature directory (the
acceptance and suggested tests, or a custom `acceptance.testPath`) stays writable, because
acceptance generation and test-fix write them. The feature's `context.md`, spec, state files
and subdirectories (`stories/`, `sessions/`, ...) do not. A test runner that writes next to
the acceptance test from Bash, such as a first snapshot into `__snapshots__/`, is refused;
Python's `__pycache__` write fails silently and is harmless.

The agent is told all of this in the tool description, and a wrapped command whose stderr
looks like a sandbox denial (`Operation not permitted`, `Read-only file system`) gets a note
naming the writable roots.

### Git guards

A sandboxed command must not be able to make nax's next *unsandboxed* git run execute agent
code. The policy therefore write-denies:

- `<git common dir>/hooks`, `<common>/config` and `config.worktree`;
- in a linked worktree: the worktree's `.git` pointer file and its admin dir's `gitdir`,
  `commondir` and `config.worktree`, plus the redirecting files of every other registered
  worktree;
- an existing `<common>/commondir`. When that file is absent (it cannot be denied on Linux
  without breaking git), a tripwire removes one created by a sandboxed command before nax's
  next git call, and logs an error.

From a linked worktree, only the shared `objects`, `refs`, `logs`, `reftable` and `lfs`
directories of the common dir are writable — enough for commits and fetches. A sandboxed
command there cannot rewrite `packed-refs` (deleting a packed branch or tag) or take the
`gc --auto` lock. Moving other refs remains possible; this is a limiter for the agent's
mistakes, not a boundary against hostile code (ADR-030, "Threat model unchanged").

### Configuration

```json
{
  "execution": {
    "sandbox": {
      "enabled": true,
      "backend": "srt",
      "filesystem": { "allowWrite": ["~/.cache/my-tool"], "denyRead": ["~/.kube"] },
      "network": { "allowedDomains": ["registry.npmjs.org", "github.com"] }
    }
  }
}
```

| Key | Default | Meaning |
|:--|:--|:--|
| `enabled` | `true` | Master switch. `false` restores unsandboxed raw bash explicitly. |
| `backend` | `"srt"` | [`@anthropic-ai/sandbox-runtime`](https://www.npmjs.com/package/@anthropic-ai/sandbox-runtime); the only backend today. |
| `filesystem.allowWrite` | `[]` | Extra write roots. `~` is expanded; relative paths resolve against the story root. Listing a top-level `.nax/` entry (e.g. `".nax/rules"`) also lets agents write it, through Bash and the file tools alike; `.nax/features`, `.nax/config.json` and `.nax/mono` can never be opened. |
| `filesystem.denyRead` | `[]` | Extra read denies. `~` is expanded. |
| `network.allowedDomains` | unset | Unset = unrestricted; `[]` = no network; a list = allow-list. |

Sandbox paths must be **literal**: `* ? [ ] { }` are rejected at config load, because srt on
Linux silently drops a glob deny. A repo path that itself contains a glob character makes the
sandbox report unavailable for that session.

The sandbox also makes remembered approvals trustworthy under `raw`: the approvals file is
always write-denied, so a raw stage no longer disables the approvals cache unless the sandbox is
off. See [Approvals](approvals.md).

### The probe

Availability is decided once per process by **running** a wrapped command that writes one
allowed marker and one denied marker. The sandbox counts as available only if the allowed write
lands and the denied one does not — a sandbox that runs but does not enforce is treated as
absent. The result is logged once:

```
sandbox  Sandbox probe  { "backend": "srt", "available": false, "reason": "..." }
sandbox  Sandbox unavailable: raw bash is refused; gated/escalate commands run unwrapped
```

### Platform requirements

| Platform | Needs |
|:--|:--|
| macOS | `sandbox-exec` (built in) |
| Linux | `bwrap` (bubblewrap), `socat`, `rg` |
| Linux container | the above, plus `--security-opt systempaths=unconfined` |
| Ubuntu 24.04 | the above, plus `kernel.apparmor_restrict_unprivileged_userns=0` |
| Windows | not supported — the probe reports unavailable |

### Verifying and troubleshooting

Every `Bash` / `Exec` row in the tool-audit ledger (`<outputDir>/tool-audit/<feature>/*.json`)
carries `sandbox: { backend, wrapped, reason?, denialHint?, argv? }`. `wrapped: true` is the
proof; `argv` is the wrapper argv that actually ran, beside the logical `executed`.

| Symptom | Cause | Fix |
|:--|:--|:--|
| Every Bash call refused with `sandbox unavailable (...)` | `raw` + probe failed | Install the platform requirements; or set the stage's `bashApproval` to `gated` / `escalate`; or `execution.sandbox.enabled: false` |
| Probe reason `platform ... is not supported` | Windows, or an unsupported platform | As above |
| Probe reason `sandbox could not run a command` inside Docker | bwrap present but blocked | Run the container with `--security-opt systempaths=unconfined` |
| Probe reason `did not enforce a write deny` | A sandbox that runs but does not confine | Treated as absent by design; fix the host |
| A command fails with `Operation not permitted` / `Read-only file system` | It wrote outside the writable roots | Add the path to `filesystem.allowWrite` if it is legitimate (e.g. a tool's own cache) |
| Installs or fetches fail with network errors | `network.allowedDomains` excludes the host | Add the domain, or unset the list |
| `sandbox` absent from ledger rows | ACP agent, or the op declares neither Bash nor Exec | Expected |

---

## Part 2 — The command-safety shadow

### What it does

For every agent-authored `Bash` and `Exec` command dispatched with the ask wiring (the execution
stage, the acceptance-fix loop, the deferred regression gate and `nax finish`), the shadow:

1. scores the command with a deterministic **rule scorer** (regex families; `RULE_SET_VERSION`
   2), and
2. asks a **typed-decision model** over a configured HTTP endpoint the same questions — one
   `harm` choice (`none` or a category) plus a yes/no per category: `deletes_data`,
   `discards_work`, `outside_project`, `system_change`, `network_send`, `privilege`,

then writes one row beside the mechanical verdict and the ledger outcome. Nothing in the policy
reads it. It never delays or fails a call: a hanging or failing classifier only marks the row's
model half `unavailable`, and the per-story drain is bounded by one timeout.

Results are cached per command (byte-exact, keyed on the question-set version) within one
dispatch scope; a repeat shows `model.status: "cached"`.

### Where rows go

`<outputDir>/command-safety/<runId>.jsonl` — by default `~/.nax/<project>/command-safety/`.
One JSON object per line, secrets redacted:

| Field | Meaning |
|:--|:--|
| `at`, `runId`, `storyId`, `stage` | When and where |
| `identity` | `Bash` or `Exec` |
| `command` | The command string (for `Exec`, the argv joined with spaces) |
| `argv` / `executed` | `Exec` only: requested argv, and what actually ran after normalization |
| `cwd` | Where it started: the policy root for `Bash`, the tool's run directory for `Exec` |
| `mechanical` | `{ verdict: allow \| ask \| deny, breach, rule? }` — the policy's verdict, recorded, not re-decided |
| `outcome` | `{ ledger, decidedBy? }` — the tool-audit outcome (`unsettled` if the call never settled) |
| `rules` | `{ version, hits: { <category>: boolean } }` |
| `model` | `{ status: answered \| cached \| blocked \| oversize \| unavailable, questionSetVersion, answers?, latencyMs?, error? }` |
| `callId`, `scopeId`, `turnId`, `roundTrips`, `toolCallId` | Correlation ids — join to tool-audit rows on the same values |

### Configuration

Absent `shadow` means off.

```json
{
  "execution": {
    "commandSafety": {
      "shadow": { "url": "http://127.0.0.1:8020/t/nax-command-safety/v1/systemone", "timeoutMs": 3000 }
    }
  }
}
```

| Key | Default | Meaning |
|:--|:--|:--|
| `shadow.url` | — (required) | `http`/`https`. Must be loopback (`127.0.0.1`, `[::1]`, `localhost`) unless `allowRemote`. |
| `shadow.timeoutMs` | `3000` | 200–30000. Bounds each classification and the drain. |
| `shadow.authEnv` | `"NAX_COMMAND_SAFETY_AUTH"` | The *name* of the environment variable holding a bearer token; no secret goes in config. |
| `shadow.allowRemote` | `false` | Accept a non-loopback URL. |

> **Warning:** `allowRemote: true` sends every agent command verbatim off-host. nax carries no
> model runtime; whatever serves the URL may also forward commands elsewhere.

### Evaluating the rows

`scripts/command-safety-eval.ts` turns a labelled corpus and live rows into a report. It decides
nothing, refuses an `--out` inside the repository, and refuses rows that mix question-set
versions.

```bash
bun scripts/command-safety-eval.ts \
  --corpus test/fixtures/command-safety/corpus.jsonl \
  --rows ~/.nax/<project>/command-safety/<runId>.jsonl \
  [--url http://127.0.0.1:8020/... --auth-env NAX_COMMAND_SAFETY_AUTH] \
  [--weights harm=0.5,noulMax=0.5] [--segments] \
  --out /somewhere/outside/the/repo/report.md
```

`--segments` (requires `--url`) adds a whole-vs-segments comparison for chained commands
(`a && b`, `a | b`, `a; b`): each segment, split by the policy's own lexer, is classified on
its own and scored as `max(whole, segments)`, to measure whether one dangerous segment is
diluted inside a long benign chain. A command the lexer refuses is scored whole only.

---

## See also

- [Permissions](permissions.md) — profiles, rules and the bash approval modes.
- [The Bash Tool](bash-tool.md) — `raw`, `gated` and `escalate` in practice.
- [Exec Allowlist](exec-allowlist.md) — the `Exec` argv branch.
- [Approvals](approvals.md) — the ask tier, and why the sandbox matters to the approvals cache.
- [Configuration](configuration.md#bash-approval-sandbox-and-command-safety) — the root-only keys.
- `docs/superpowers/specs/2026-09-23-p4-sandbox-backend-design.md` — sandbox design.
- `docs/superpowers/specs/2026-09-23-p5-command-safety-shadow-design.md` — shadow design.
