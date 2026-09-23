# Sandbox backend for agent-authored commands — design

**Date:** 2026-09-23 · **Status:** designed, not planned, no `src/` code
**Baseline:** `main` @ `e0625f27c` (P3 PR 3 merged). Every citation below was read on this commit.
**Implements:** phase 4 of the native-coding-agent arc (goal 1's end state: `raw` bash with the
blast radius capped)
**Master plan:** `nax-native-coding-agent-master-plan.md` (workspace, not this repo) — D1, D5,
D13a, D14, and the P2 approvals-cache disclosure
**Governs:** ADR-030 (amended by this phase, §9)
**Branch:** `feat/p4-sandbox-backend` (off `main`)

---

## 1. Problem

`raw` (ADR-030) runs a model-authored shell string with no containment. Its only protection is
the advisory lexical screen for nax-owned paths (`src/tools/policy-bash-raw.ts`), which by
construction cannot see a command that uses substitution and, after a `cd` it cannot model,
screens against an estimated frame. Two gaps are disclosed-not-fixed today and both name P4 as
the closer:

1. **D13a gap 3** — an unmodellable `cd` into a protected directory
   (`cd -P .nax && echo x > config.json`) is screened against the pre-`cd` frame and passes.
2. **The P2 mixed-mode hole** — `src/permissions/approvals-link.ts:4-14`: under `raw`, the
   screen's `protectedHit` skips every path outside the root, so
   `~/.nax/<project>/approvals.json` is writable by a `raw` shell; in a run mixing `raw` and
   `escalate` stages, a `raw` stage can poison the cache an `escalate` stage trusts. P2 closed
   it by disabling the cache whenever any stage resolves to `raw`.

Threat model is unchanged (master plan D1): the sandbox limits the blast radius of the agent's
**own mistakes**. It is not a security boundary against hostile repo content (§17/D-1 stands).

## 2. Spike evidence (2026-09-23)

Throwaway spike: `@anthropic-ai/sandbox-runtime` (srt) **0.0.77** driven through nax's REAL
`runArgv` (`src/utils/argv-exec.ts`, imported unmodified from `main`). macOS arm64 / Bun
1.4.2 / `sandbox-exec`; Linux arm64 / Debian / bwrap 0.12.0 / Bun 1.4.0 in Docker.

| Check | macOS | Linux |
|---|---|---|
| `SandboxManager.initialize` under Bun (proxies + monitor) | ✅ 3-5 ms | ✅ 10 ms |
| write inside root succeeds; outside root denied | ✅ | ✅ |
| D13a gap 3 (`cd -P .nax && echo x > config.json`) blocked | ✅ | ✅ |
| `~/.nax/<proj>/approvals.json` unwritable | ✅ | ✅ |
| `mv .nax .nax-moved` then write — blocked | ✅ | ✅ |
| timeout SIGKILL of the process group kills sandboxed grandchildren | ✅ | ✅ |
| two concurrent calls with different write roots stay isolated | ✅ | ✅ |
| network allow-list: `registry.npmjs.org` allowed, `example.com` 403 | ✅ | ✅ |
| network open (no `allowedDomains`) | ✅ | — |
| `bun install` | ✅ | ✅ |
| overhead per call (wrap + spawn − bare spawn) | +12 ms | +14 ms |
| srt changes the child env | no | no |

Five findings the design must carry — each is a requirement below, not a note:

- **F1 🚨 Linux silently drops glob `denyWrite` entries.** `.nax/features/**/prd.json` was
  overwritten on Linux and blocked on macOS. srt `sandbox-manager.js:1033-1038` filters any
  `denyWrite` entry with glob characters on Linux ("bubblewrap doesn't support globs"), logged
  at debug only. Literal paths hold on both platforms, **including paths that do not exist
  yet**. → §5.3, §8.1.
- **F2 🚨 Worktree commits need the git common dir writable, which strips srt's hook guard.**
  From `.nax-wt/<id>`, `git commit` fails on `<repo>/.git/worktrees/<id>/index.lock` unless
  `<repo>/.git` is a write root. With it, srt's built-in `.git/hooks` / `.git/config` guard
  (scoped to the cwd's `.git`) does not cover it: the spike wrote
  `<repo>/.git/hooks/pre-commit`, and git in the MAIN checkout then found that hook. Explicit
  literal denies of `<common>/hooks` and `<common>/config` block it on both platforms and
  commits still succeed. → §5.3.
- **F3 `$TMPDIR` is not `/tmp` on macOS.** It is `/var/folders/.../T/`; without it `bun install`
  fails `EPERM` ("unable to write files to tempdir"). → §5.3.
- **F4 🚨 "Dependencies installed" ≠ "sandbox works".** In a default Docker container bwrap is
  present and every command fails `bwrap: Can't mount proc on /proc: Operation not permitted`;
  `--security-opt systempaths=unconfined` fixes it. Availability must be decided by a real
  probe, never by `checkDependencies()`. → §5.4.
- **F5 macOS denies creating the ancestors of a denied nonexistent path.** With a literal deny
  on `.nax/features/f2/prd.json`, `mkdir .nax/features/f2` is refused on macOS (Linux: the
  `mkdir` succeeds, the file write is refused). Harmless — nax's own writes are not sandboxed —
  but the agent's Bash cannot create a feature directory. → §5.3.

Also verified: bwrap's `/dev/null` mount placeholders leave no artifacts on the host.

## 3. Decisions (user, 2026-09-23)

| # | Decision |
|---|---|
| S1 | **Opt-in first.** `execution.sandbox.enabled` defaults to `false`. The flip to default-on is a separate, later PR gated on the P4 exit runs (§10). Nothing changes at merge. |
| S2 | **Network open by default.** `network.allowedDomains` absent/`null` = unrestricted; an array = allow-list; `[]` = no network. |
| S3 | **Write roots = fixed roots + a built-in cache list + config `allowWrite`.** |
| S4 | **Read denies = a built-in credential-store list + config `denyRead`.** |
| S5 | **All modes are wrapped.** Unavailable: `raw` REFUSES with a reason; `gated`/`escalate` run unwrapped with one warn. **The agent is always told** whether it is sandboxed, what it may write, and — on a likely sandbox denial — that the sandbox caused it. |
| S6 | **Approach A**: a `CommandLauncher` passed into the two agent-authored spawn sites. |

Rejected: wrapping inside `runArgv` (D14 would rest on every caller setting a flag;
`runArgv` also runs nax's own worktree dependency installs) and wrapping in `runtime.callTool`
(the runtime does not own how a tool spawns; single-gate rule).

## 4. Scope

**In:** `src/sandbox/` module (backend interface, srt backend, policy builder, probe, launcher);
wiring into `Bash` and `RunCommand` `Exec`; `raw` refusal in the policy; description and result
annotation; config schema; approvals-cache precondition relaxation; telemetry fields; import
boundary + bundle-externals checks; ADR-030 amendment.

**Out:** Windows (probe reports unavailable); a container backend (the interface admits it);
wrapping user-authored `quality.commands` / `acceptance.command` (D14); per-stage sandbox
config; flipping the default (S1); the P4 exit runs themselves (billed, §10).

## 5. Design

### 5.1 Components — all under `src/sandbox/`

`src/sandbox/` is part of the would-be `nax-coding` surface (master plan D8): it imports nothing
from the orchestrator (`src/pipeline`, `src/execution`, `src/prd`, …).

| File | Responsibility |
|---|---|
| `types.ts` | `SandboxPolicy { writeRoots; denyWrite; denyRead; network: { allowedDomains?: readonly string[] } }` — every path absolute and literal. `SandboxBackend { name; probe(): Promise<ProbeResult>; wrap(command, shell, policy, cwd, commandId): Promise<{ argv; env }>; annotate(commandId, stderr): string; reset(): Promise<void> }`. `ProbeResult { available: boolean; reason?: string }`. |
| `srt-backend.ts` | The ONLY importer of `@anthropic-ai/sandbox-runtime` (§8.4). Lazy `SandboxManager.initialize` on first `probe`/`wrap`, with `network` built from config (open ⇒ `{ deniedDomains: [] }` with no `allowedDomains` — `initialize` dereferences `runtimeConfig.network`, so the object must exist). `wrap` → `wrapWithSandboxArgv(command, shell, customConfig, undefined, cwd, { commandId })`. |
| `policy-builder.ts` | Pure `buildSandboxPolicy(input) → SandboxPolicy` (§5.3). Rebuilt PER CALL — cheap (~1 ms), and a feature directory created mid-run gets its `prd.json` deny. |
| `probe.ts` | Real probe (§5.4); result cached per process per backend. |
| `launcher.ts` | `createCommandLauncher({ backend?, policyFor, logger })` → `run({ command | argv, cwd, timeoutMs, stripEnvVars, env, commandId })` returning `ArgvExecResult & { sandbox: SandboxRecord }`. Disabled ⇒ byte-identical pass-through to `runArgv`. Enabled ⇒ wrap, then `runArgv` (keeps MEM-4 group kill, BUG-13 deadline, concurrent drain). |
| `argv-quote.ts` | POSIX single-quote quoting for the Exec path (§5.2). |
| `defaults.ts` | The built-in cache list and credential read-deny list, as one auditable constant each. |

### 5.2 Wiring

- New `src/agents/coding-tool-sandbox.ts` constructs the launcher (and awaits the probe) for a
  session. `src/agents/coding-tool-support.ts` is at **594/600** lines: it gets one call and
  passes the result through; nothing else.
- `createBashTool` takes the launcher in `BashToolOptions`; `bash.ts:164`
  (`_bashToolDeps.runArgv`) becomes `launcher.run({ command, … })`. Default when no launcher is
  given: a disabled launcher — every existing `createBashTool` test caller compiles and behaves
  unchanged.
- `RunCommandToolOptions.exec` gains the launcher; `run-command-exec.ts:79` becomes
  `launcher.run({ argv: normalized.argv, … })`.
- **Nothing else receives a launcher.** D14 holds by construction: the declared-command branch
  of `RunCommand`, `quality.commands`, `acceptance.command`, the worktree dependency install and
  every nax-internal `runArgv` caller cannot be sandboxed, because they never see one.
- **Single-gate rule preserved**: the launcher changes HOW a command runs, never WHETHER.
  `bash.ts` still decides nothing; the `raw` refusal lives in the policy (§5.5).

**Exec and the no-shell guarantee.** srt wraps a command STRING that runs under `sh -c` inside
the sandbox. A sandboxed Exec therefore runs `sh -c '<argv, each element single-quoted>'`.
- Quoting: each element is wrapped in `'…'`, an embedded `'` becomes `'\''`. This is injective
  and has no metacharacter interpretation inside single quotes.
- It lives in `src/sandbox/argv-quote.ts`, so the whole-file guard on `run-command-exec.ts`
  (which forbids importing the declared branch's shell-argument quoting helper) holds as
  written. `validateArgv` and `deniedFlag` still run on the RAW argv first (unchanged order).
- Disabled launcher ⇒ Exec spawns the argv directly, exactly as today.

### 5.3 Policy contents — every entry a literal absolute path (F1)

| Kind | Entries |
|---|---|
| Write roots — fixed | the story root `ctx.root` (repo or `.nax-wt/<storyId>`; the session scratchpad `<root>/.nax/scratchpad`, `src/tools/scratchpad.ts:25`, is inside it and needs no entry); `os.tmpdir()` and `/tmp` (F3); for a worktree root, the git common dir (`git rev-parse --git-common-dir`, resolved once per session) (F2) |
| Write roots — built-in caches (`defaults.ts`) | `~/.bun/install/cache`, `~/.npm`, `~/.cache`, `~/.cargo/registry`, `~/.cargo/git`, `~/go/pkg/mod`, `~/.gradle/caches`, `~/.m2/repository`, `~/.pnpm-store`, `~/Library/Caches` (macOS only) |
| Write roots — config | `execution.sandbox.filesystem.allowWrite`, `~` expanded, relative paths resolved against the repo root |
| Write denies | `<root>/.nax/config.json`; `<root>/.nax/mono` (the whole directory — a deliberate superset of `nax-owned-writes.ts`'s `.nax/mono/*/config.json`; agent-authored Bash has no business there); `<root>/.nax/features/<f>/prd.json` for each `<f>` present on disk at call time; each root queue-control file from `QUEUE_CONTROL_FILES` (`nax-owned-writes.ts:67`, **exported** for this, not copied); for a worktree root, `<common>/hooks` and `<common>/config` (F2) |
| Read denies — built-in (`defaults.ts`) | `~/.nax/credentials*` expanded to literals at build time, `~/.ssh`, `~/.aws`, `~/.config/gcloud`, `~/.docker/config.json`, `~/.netrc`, `~/.npmrc`, `~/.pypirc`, `~/.git-credentials`, `~/.config/gh` |
| Read denies — config | `execution.sandbox.filesystem.denyRead`, `~` expanded |
| Network | from config (S2) |

Consequences, stated so nobody "fixes" them:
- `~/.nax/<project>/approvals.json` needs no entry — it is outside every write root, and srt
  writes are allow-only. This is what closes the P2 hole (§5.6).
- `~/.npmrc` / `~/.config/gh` being unreadable means a sandboxed `npm publish` or `gh` call
  cannot authenticate. Intended under D1; the description says credential files are unreadable.
- F5: on macOS the agent's Bash cannot create a new `.nax/features/<f>/` directory.
- The builder must never emit a glob character in `denyWrite` (§8.1 pins it).

### 5.4 Probe (F4)

One wrapped command, built from the real policy shape against a private temp directory:
write `allowed/marker` (in a write root) and attempt `denied/marker` (listed in `denyWrite`).

| Outcome | Result |
|---|---|
| allowed written, denied absent | `available` |
| wrap throws / `isSupportedPlatform()` false | unavailable — reason names the platform or the thrown message |
| allowed NOT written | unavailable — the sandbox cannot run commands (the Docker `/proc` case) — reason carries the stderr's first line |
| denied written | unavailable — **a sandbox that runs but does not enforce** is treated as absent, never as present |

Cached per process. Run once, when the first session that could spawn a sandboxed command
builds its tools (so tool descriptions reflect it, §5.5), and never on a run that declares no
Bash/Exec. The probe result is logged once on the run's start line (§5.7).

### 5.5 What the agent sees

| Sandbox state | `raw` stage | `gated` / `escalate` stage |
|---|---|---|
| disabled | today's behaviour and description, byte-identical | unchanged |
| enabled + available | wrapped. `rawDescription` DROPS "paths are NOT contained … read or write anywhere the nax process itself can reach" and instead states: runs inside an OS sandbox; writes allowed only under the repository root, temp and package caches (listed); credential files unreadable; network open / limited to `<domains>`; a write elsewhere fails with "Operation not permitted" or "Read-only file system". The protected-path screen sentence stays. | wrapped; the same sandbox sentence is appended to `gatedDescription` |
| enabled + unavailable | REFUSED. The policy's raw branch (`src/tools/policy-command-branch.ts:37`) denies every Bash call before screening: *"sandbox unavailable (`<probe reason>`): raw bash requires the sandbox when execution.sandbox.enabled is true — set this stage's bashApproval to gated or escalate, or disable the sandbox."* The description says the same, so the model does not spend a turn discovering it. | runs UNWRAPPED; one `warn` per run naming the reason; the description says "not sandboxed: `<reason>`" |

`RunCommand` `Exec` follows the gated column in every mode — it is always mechanically
allow-listed.

The refusal is a POLICY verdict (`deny`, ledger outcome as any deny), carried into
`compileToolPolicy` as a compile-time option alongside `bashApproval` — the same route `raw`
itself takes (ADR-030, "`raw` must reach `compileToolPolicy` as a compile-time option").

**Result annotation.** When a wrapped command exits non-zero AND its stderr contains
`Operation not permitted` or `Read-only file system`, the tool result gets one deterministic
line: *"note: this command ran in the nax sandbox; that failure may be a sandbox denial —
writable roots: `<list>`."* srt's own `<sandbox_violations>` text (`annotate`, keyed by the tool
call id) is appended best-effort when present. In the spike it added nothing within 300 ms (the
macOS log monitor is off unless `initialize`'s third argument enables it) — the plan's first
task measures whether enabling it makes srt's annotation reliable; nax's line is the guarantee
either way.

### 5.6 Interaction with P1 and P2

- **The D13 screen stays** under `raw`, sandboxed or not. It is near-free and names a specific
  reason BEFORE execution; the sandbox is the guarantee. ADR-030's gap 3 becomes "closed when
  sandboxed, disclosed when not".
- **Approvals-cache precondition relaxes** (`approvals-link.ts:37-39`). Today: disabled if any
  stage resolves to `raw`. New: disabled if any stage resolves to `raw` **and**
  `execution.sandbox.enabled` is false. Config-only — no dependency on the probe: with the
  sandbox enabled, a `raw` stage is either wrapped (cannot write under `~/.nax`) or refused
  outright (§5.5), so neither can forge the file. The in-repo precondition is unchanged.

### 5.7 Telemetry

- `ToolCallRecord` and the tool-audit row gain `sandbox: { backend: "srt" | "none"; wrapped:
  boolean; reason?: string }` on every Bash / Exec row.
- The run's start log line carries the probe result.
- A per-run count of annotated likely-denials goes to the ledger.

These are the fields the exit runs gate on (§10) — never exit codes.

### 5.8 Lifecycle

`SandboxManager` is a process-wide singleton. The backend initializes lazily (first probe) and
`reset()` is called from `cleanupRun` beside `interactionChain.destroy()`
(`src/execution/lifecycle/run-cleanup.ts:288`). Per-call `customConfig` carries each story's
roots, so parallel worktree stories share one initialized manager safely (spike: concurrent
roots isolated). One nax process = one project, so one network config per process holds.

## 6. Config

```jsonc
"execution": {
  "sandbox": {
    "enabled": false,                       // S1
    "backend": "srt",                       // enum, one value today
    "filesystem": {
      "allowWrite": [],                     // S3, added to the built-ins
      "denyRead":  []                       // S4, added to the built-ins
    },
    "network": { "allowedDomains": null }   // S2: null = open; [] = none; array = allow-list
  }
}
```

Global only. Defaults derived from the schema and referenced from the `execution` default
literal in `schemas.ts` (the BUG-20 rule, as `DEFAULT_BASH_APPROVAL_MODE` is).

## 7. Dependency and platform

- `@anthropic-ai/sandbox-runtime` pinned EXACTLY `0.0.77` (APIs "beta research preview",
  explicitly unstable; ~77 releases so far). A bump is its own PR that re-runs §8.3.
- **External in the bundle** — srt ships vendored binaries (Linux seccomp filters,
  `srt-win.exe`) resolved relative to its own files. `scripts/check-bundle-externals.ts`
  updated.
- Linux host requirements: `bwrap`, `socat`, `rg`. In a container:
  `--security-opt systempaths=unconfined` (F4), or the probe reports unavailable.
- Windows, and anything `isSupportedPlatform()` rejects: unavailable.

## 8. Testing

### 8.1 Unit
- `policy-builder`: for a fixture root, **no `denyWrite` entry contains a glob character**
  (F1's silent failure pinned); literal prd paths for a feature directory created after the
  session started; worktree `hooks`/`config` denies present iff the root is a worktree; `~`
  expansion; credential read denies; queue files sourced from the exported constant.
- `argv-quote`: round-trip corpus — `'`, `"`, `$()`, backticks, `;`, `&&`, `|`, newlines, globs,
  `-` leading args, empty string, unicode — `sh -c` of the quoted form reproduces the argv
  exactly.
- `probe`: all four outcomes of §5.4, including **denied-write-leaked ⇒ unavailable**.
- `launcher`: disabled ⇒ the `runArgv` call arguments are byte-identical to today's.

### 8.2 Fake backend — must fail the way production fails
Master plan §5 trap: a double that cannot refuse hides a critical. The fake's `wrap` can throw,
its `probe` can report unavailable (each reason class), and its policy can deny a path.

### 8.3 Policy, description, precondition
- `raw` + enabled + unavailable ⇒ deny with the exact reason; `gated`/`escalate` + unavailable
  ⇒ allow, unwrapped, one warn per run.
- Every description variant in §5.5 pinned.
- Approvals-link precondition: table test over (`raw` stage present) × (`sandbox.enabled`).
- The 21-case deny suite (`test/integration/permissions/bash-deny-suite.test.ts`) stays green
  unchanged with the sandbox disabled.

### 8.4 Integration — production entry, real srt, EXECUTED outcome
Through `resolveCodingToolSupport` → `runtime.callTool` against a real temp root, asserting the
file system afterwards, not the verdict (master plan §5):
- `cd -P .nax && echo x > config.json` — the composite case (unmodellable `cd` followed by the
  protected write): **file unchanged**.
- a `prd.json` in a feature directory created after session start; `approvals.json` under a
  temp `~/.nax`; `<common>/hooks/pre-commit` from a worktree; a write outside the root — each
  **unchanged/absent**.
- `git commit` inside a worktree succeeds; a timeout kills grandchildren.
- Runs when the probe reports available; otherwise each test is **skipped with the probe reason
  printed**, never silently passed. Runs locally on macOS.
- **Linux CI**: GitHub's Ubuntu 24.04 runners restrict unprivileged user namespaces through
  AppArmor, so bwrap is expected to fail as in Docker. The plan's first task verifies this on a
  real runner; if confirmed, the CI job adds `sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`
  and `apt-get install bubblewrap socat ripgrep`, so the suite runs for real on Linux.

### 8.5 Gates
New import-boundary check: `@anthropic-ai/sandbox-runtime` imported only from
`src/sandbox/srt-backend.ts` (modelled on `scripts/check-nax-ai-imports.ts`); `src/sandbox/`
imports no orchestrator module. `check-bundle-externals`. The 600-line file gate.
`bun run test`, `bun run typecheck` (NOT in `check:all` — run it explicitly), lint.

## 9. Governance

**ADR-030 amendment** (D9: amend, do not add a sibling ADR):
- the sandbox backend interface, srt as the first backend, the container backend as a future
  implementation of the same interface;
- opt-in until the flip (S1); when enabled, `raw` requires the sandbox and refuses without it;
  `gated`/`escalate` run unwrapped with a warning (S5);
- network open by default as a consequence of D1 (S2);
- the literal-path rule and WHY (F1: Linux silently drops glob denies);
- worktree git-common-dir handling (F2);
- D13a gap 3 and the P2 approvals hole: closed when sandboxed; the approvals-cache precondition
  relaxed accordingly.

**Master plan** (workspace): D5 amended (literal paths, probe, open network, opt-in); D14
unchanged but restated as enforced by construction; §6 P4 row; changelog entry with §2's
evidence.

## 10. Exit, and the flip (NOT this PR)

P4's exit and the flip to default-on are a separate, later PR. The exit is billed runs on the
P0 corpora with `sandbox.enabled: true` and `bashApproval: raw` — approval required at the
launch moment. Gate on artifacts, never exit codes (nax exits 0 on failure):
- every Bash / Exec row carries `sandbox.wrapped: true`;
- zero writes to protected paths or outside the write roots;
- stories pass;
- billed input tokens compared against the P0 baseline (no wire-exact pricing — compare tokens,
  not USD).

## 11. Risks

- **srt API churn** — exact pin; the backend interface confines the blast radius to one file.
- **Linux CI/containers** — probe reports unavailable; with the sandbox opt-in (S1) nothing
  breaks until someone enables it, and then `raw` refuses with a reason naming the fix.
- **Annotation reliability** — nax's own deterministic line is the guarantee; srt's is extra.
- **Cache list gaps** — a package manager writing elsewhere fails `EPERM` with the annotation
  line naming the writable roots; `filesystem.allowWrite` is the escape hatch.
