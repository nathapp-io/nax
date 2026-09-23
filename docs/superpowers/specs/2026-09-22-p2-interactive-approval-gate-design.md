# Interactive approval gate — design

**Date:** 2026-09-22 · **Status:** implemented (PR/merge pending)
**Baseline:** `main` @ `7b37dbf74` (PR #2184 merge) — every citation verified at that commit
**Implements:** phase 2 of the native-coding-agent arc
**Master plan:** `nax-native-coding-agent-master-plan.md` (workspace, not this repo)
**Builds on:** ADR-030 (bash approval modes), ADR-029 §3 (ask tier, safe-by-refusal)
**Plan:** `docs/superpowers/plans/2026-09-22-p2-interactive-approval-gate.md` (written; this spec is its design)

---

## 1. Problem

ADR-030 shipped `escalate`: a bash denial the gate could not *adjudicate* resolves to the
`ask` tier instead of `deny` (`src/tools/policy-command-branch.ts:61-70`). The ask tier is
wired end to end — `runtime.callTool` reaches it at `src/tools/runtime.ts:379` and calls
`askResolver.resolve(...)`.

There is no resolver. `createCodingToolRuntime` defaults to `headlessAskResolver()`
(`src/tools/runtime.ts:183`), which returns `"deny"` unconditionally
(`src/permissions/ask.ts:13-19`), and the sole production call site
(`src/agents/coding-tool-support.ts:201`) passes no resolver at all. So `escalate` is today a
relabelling of `deny`.

Separately, the interaction subsystem (`src/interaction/`) already asks humans questions
through `cli` / `telegram` / `webhook` plugins, with a priority chain, timeouts and buffered
concurrent responses. The two subsystems are unconnected: no code path links an `AskRequest`
to an `InteractionRequest`.

**This design connects them, and does so in a way that leaves nax with exactly one approval
system rather than two.**

## 2. Goal

Goal 1 of the master plan — "escalation-to-human" — plus the structural precondition for
goal 4 (a typed-decision provider that can approve by itself).

A human approves or denies an escalated command from Telegram (v1) or the terminal, and an
approval can optionally be remembered so the same command stops asking.

### 2.1 Note on the ADR-029 metering bar

ADR-029 §3 states that a material rate of `denied:ask` rows justifies building this channel
and that "zero rows means the seam stays dormant". **That bar does not gate this phase**
(user ruling, 2026-09-22). It is unsatisfiable by construction: the shipped default is
`bashApproval: raw`, and `raw` never consults the ask map — `commandBranch` returns
allow-or-deny only — while `execution.permissions.<stage>.ask` defaults to empty everywhere
(`src/config/permissions.ts:224`). Zero rows across every ledger is an artifact of the
design, not evidence of absent demand. Metering continues as telemetry (§8), never as a gate.

## 3. One approval system

The load-bearing constraint on this design. Audit of what is already approval-shaped:

| machinery | what it is | disposition |
|---|---|---|
| `src/interaction/` — chain, plugins, triggers, `interactionBridge` | the **channel**: how nax asks a human anything | reuse; add no plugin |
| ask tier + `AskResolver` | the **decision point** for permissions | this is what P2 builds |
| `bashApprovalOps` (`src/config/bash-approval.ts`) | a pure **mode selector**, ruled not-a-resolver by ADR-030 | leave pure |
| `RequestCapability` (`src/tools/request-capability.ts`) | telemetry; grants nothing, asks nobody | not a competitor |
| `src/hooks/` `validateHookCommand` | shell-out orchestration screening | out of scope; do not unify |
| `src/cli/confirm.ts` `promptForConfirmation` | a second stdin prompt implementation, reached by **no interaction path** (only `bin/nax.ts`) | **do not build on it** — see §3.2 |

> **The direction, stated so it can be checked:** `src/interaction/` decides *how to ask a
> human*. The ask-tier resolver chain decides *what an answer means for a permission*.
> Triggers and `interactionBridge` are peers of the **human link**, not peers of the chain —
> other callers of the same channel asking non-permission questions. Every adjudicator
> (cached approval, future classifier, human) is a **link in the one chain**. P2 creates the
> chain; P5 adds a link; nothing else ever gets its own decision point.

### 3.1 Reuse the channel; do NOT reuse its fallback policy

`InteractionChain.applyFallback` maps `fallback: "continue"` to **`"approve"`**
(`src/interaction/chain.ts:179-199`). A project setting `interaction.defaults.fallback:
"continue"` — reasonable for *pipeline* gates, where it means "proceed with the run" — would,
if the human link used `applyFallback`, silently auto-approve every escalated bash command on
timeout.

**The human link never calls `applyFallback`.** Timeout and unreachable-operator are
`deny`, unconditionally, ignoring `interaction.defaults.fallback`. The interaction system's
fallback vocabulary is tuned for run-progress decisions, not permission decisions. This is the
D13a fail-open shape in a new place and is pinned by a test (§7).

### 3.2 Correction to master-plan D3 — the TUI link

D3 says the TUI resolver comes "via `src/cli/confirm.ts`". **That instruction is reversed by
this design.** `src/cli/confirm.ts` is reached by no interaction path: its only
callers are two CLI entrypoint confirmations in `bin/nax.ts:302,467` ("Proceed with bake-off
run?", "Proceed with execution?"), plus a barrel re-export at `src/cli/index.ts:17`. Nothing
in `src/` calls it. It offers yes/no with no timeout, cancel or request identity, and
duplicates the `readline` prompting `CLIInteractionPlugin` already does
(`src/interaction/plugins/cli.ts:43`). It is a CLI entrypoint helper, not an interaction
mechanism — which is exactly why building the gate's TUI on it would fork the channel.

A full-screen TUI cannot be built on either file — `readline` owns stdin line-wise — so a
future rich TUI is a **new `InteractionPlugin`** regardless. Written as a plugin it serves the
ask gate *and* triggers *and* `interactionBridge`: one implementation, three consumers.
Built on `confirm.ts` it would serve the ask gate only, leaving a second one owed. **The TUI
link therefore goes through `CLIInteractionPlugin`.** `confirm.ts` is untouched and stays in use by `bin/nax.ts`.

### 3.3 Channel limits inherited knowingly

- **One plugin at a time.** `init.ts:82-83` constructs exactly one plugin and registers it;
  the chain's priority cascade is built and unused. "Telegram primary, TUI fallback" is not
  configurable today. Out of scope; fix in the channel when wanted.
- **Headless + `plugin: "cli"` yields no chain at all** (`init.ts:67`, returns `null`). The
  resolver chain then exhausts and denies. Correct, but it makes attended-TUI and
  headless-Telegram config-exclusive right now.
- **CLI is serial by construction.** `readline` supports one in-flight `question()`; the
  plugin closes and recreates the interface to discharge a stale callback after a timeout
  (`plugins/cli.ts:150-160`). Telegram is concurrent. §6.4 serializes at the resolver so the
  gate's behaviour does not depend on which channel is configured.

## 4. The resolver chain

### 4.1 Why a chain, not a resolver

The master plan's P5 classifier has two jobs at two seams. D4 names only the first:

| job | seam | direction |
|---|---|---|
| downgrade a mechanically-allowed command for a second look | post-allow in `runtime.ts` (D4) | narrowing, allow → ask |
| **adjudicate an `ask` verdict without a human** | **the `AskResolver` seam** | ask → allow/deny |

The second is goal 4's "can approve by itself", and it is the seam P2 builds. ADR-030 already
ruled this in the `bashApprovalOps` docblock: *"the human resolver is the existing
`AskResolver`, which the ask tier already reaches; a second chain would duplicate it."*

```
ask verdict
   |
   +--> approvals cache   (exact; a human authorized this earlier)   allow | abstain
   +--> model classifier  (P5 -- absent in P2)                       allow | deny | abstain
   +--> human link        (Telegram; CLI for attended runs)          allow | deny
   +--> exhausted -------------------------------------------------> deny  (fail-closed)
```

### 4.2 Contract change: `abstain`

`AskResolver.resolve` returns `Promise<"allow" | "deny">` (`src/permissions/types.ts:27-29`).
A chain needs a third outcome: the cache must say *"no opinion, try the next link"*, and P5's
classifier must say *"below threshold, escalate to the human"*. Without it the cache has to be
fused into the human resolver and P5 has nowhere clean to attach.

```ts
export type AskDecision = "allow" | "deny" | "abstain";
export interface AskResolver { resolve(req: AskRequest): Promise<AskDecision>; }
```

First non-`abstain` wins. The full contract:

```ts
export type AskDecision  = "allow" | "deny" | "abstain";
export type AskDecidedBy = "cache" | "model" | "human" | "timeout" | "unavailable";

/** One adjudicator. Always names who decided, so the ledger never guesses. */
export interface AskLinkOutcome { decision: AskDecision; decidedBy: AskDecidedBy; }
export interface AskLink { readonly name: string; resolve(req: AskRequest): Promise<AskLinkOutcome>; }

/** What the runtime consumes. Never `abstain`. */
export interface AskVerdict { decision: "allow" | "deny"; decidedBy: AskDecidedBy; latencyMs: number; }
export interface AskResolver { resolve(req: AskRequest): Promise<AskVerdict>; }

export function chainAskLinks(links: readonly AskLink[]): AskResolver;
```

**`AskResolver.resolve` changes shape, and that is deliberate rather than free.** §7.1 requires
`decidedBy` in the ledger on the ALLOW path as well as the deny path, so the value must travel
back to `runtime.ts` — a bare `"allow" | "deny"` cannot carry it. Consequences, all of which
belong to the first task:

- `src/tools/runtime.ts:380-384` declares `let decision: "allow" | "deny";` and assigns the
  resolver's result into it. It becomes an `AskVerdict`, and `if (decision === "allow")`
  becomes `if (verdict.decision === "allow")`.
- `test/unit/permissions/ask.test.ts:5-13` asserts `expect(decision).toBe("deny")` on
  `headlessAskResolver()`. It becomes `expect(verdict.decision).toBe("deny")`. **The
  behaviour is unchanged — a headless run still denies — but the assertion shape changes, and
  an earlier draft of this spec wrongly claimed the widening was observably invisible.**
- `headlessAskResolver()` is reimplemented as `chainAskLinks([])`: zero links, so the chain's
  own terminal supplies `{decision: "deny", decidedBy: "unavailable"}`. It stays TOTAL — it is
  not a bare abstaining link.

> **Invariant, enforced by construction:** abstain is only safe for a link followed by a
> stricter one. **The terminal link may never abstain.** The chain builder always appends a
> terminal `deny`, so an exhausted chain denies whether or not the last link is total.

### 4.3 Why the approvals cache is a chain link, not merged allow rules

The master plan sketched "remember" as appending a `Bash(...)` allow rule merged into
`compileToolPolicy`. This design rejects that, for three reasons.

**It would not mean what it says.** `Bash(...)` matching is a token-wise **prefix** match with
no length ceiling (`src/tools/policy-bash.ts:72-83`: `matchesTokens` slices off a trailing
`*`, rejects only `tokens.length < required.length`, then tests just those positions — extra
tokens are never examined). A rule synthesized from an approved command also grants every
longer command sharing that prefix:

```
approved:    bun run test
rule:        Bash(bun run test)
also grants: bun run test --reporter=./x      (and anything else contained)
```

Payload guards still run, so path escapes are caught — but within the root the remembered rule
is materially broader than what the operator read. That is the D13a failure mode in a new
costume: a mechanism that looks narrow and is not.

**It would widen the mechanical gate.** Merged allow rules participate in precedence
resolution, including Category-B denials that ADR-030 deliberately refuses to escalate.

**It is the wrong noun.** A remembered approval is not a rule; it is a **cached human
decision**.

As a chain link instead:

- a remembered approval can never override a breach, a denied flag or an explicit deny rule —
  structurally, because those never reach the ask tier;
- matching is **exact** on the command string (§6.6), because the link does not go through
  the glob matcher, so the entry means the string the human actually read;
- `compileToolPolicy` is untouched, so P1's 21-case deny suite remains the regression spine and
  cannot be regressed by an approvals file;
- it composes with P5 — the classifier is simply the next link.

## 5. The prompt

### 5.1 Verbatim or deny

The only carrier of the command into `AskRequest` today is `summary`, and `askSummary()` ends
with `.slice(0, MAX_ASK_SUMMARY_CHARS)` — **200 chars** (`src/tools/runtime.ts:37,118-128`).
Escalated commands are precisely the long ones. Inherited as-is, an operator would approve a
silently truncated command and the cache would key on a string they never saw.

> **Ruling: the approval prompt shows the command verbatim, or the gate denies.** Never
> truncate, ellipsize, or split a command across messages. If the full command cannot fit one
> message (`MAX_MESSAGE_CHARS` is 4000, `plugins/telegram-format.ts:13`), the resolver returns
> `deny` with a reason naming the length. An agent emitting a >3.5 KB single command is
> pathological; refusing it is the honest outcome.

### 5.2 Payload

```ts
interface AskRequest {
  tool: string; stage: string; rule: string; summary: string;
  command?: string;   // VERBATIM, never truncated
  root?: string;      // the permitted root -- see 5.3
  reason?: string;    // why it escalated, from the verdict, NOT rewritten
  storyId?: string; featureName?: string;
}
```

`reason` is load-bearing: `escalate` deliberately preserves the original denial text rather
than rewriting it as `matched ask rule "..."` (`policy-command-branch.ts:66-70`). That text is
the operator's whole basis for judging and must arrive intact.

### 5.3 `root`, not `cwd`

`createBashTool` spawns with **`cwd: ctx.root`** (`src/tools/bash.ts:165`), and its header is
explicit: *"WHERE IT RUNS: `ctx.root`, the hop's permitted root and the same root the policy
resolved every path against."* The policy models from the same value. Post single-frame
redesign, that root is the repo root.

So the shell's working directory is **constant per hop and equals the permitted root**.
Labelling it `cwd` and showing the story's package would tell the operator the command runs in
the package — it does not. That is the nax#2182 conflation (story workdir vs execution cwd)
reappearing at the prompt layer, where a human acts on it.

It is still shown, as `root`, because: under `-d` root and the runtime workdir diverge by
design (#1794); **which checkout** is the fact an operator most needs when worktrees and
parallel runs exist; and after D13a a reader of `cd packages/app && rm -rf dist` must know
where the `cd` starts. The story's workdir appears as context, explicitly not as the shell's
starting point.

### 5.4 Rendering: `choose`, not `confirm`

`buildKeyboard` hardcodes Approve/Reject/Skip/Abort for `type: "confirm"`
(`plugins/telegram-format.ts:189-201`). Adding a "remember" button there would make the shared
formatter permission-aware — the fork again. `choose` renders **one button per declared
option, request-driven** (`:203-214`, one row per `request.options` entry), and `InteractionChain.prompt()` already remaps the
response `action` to the matched option key (`chain.ts:130-137`).

```ts
options: [
  { key: "allow",          label: "Allow once" },
  { key: "allow-remember", label: "Allow + remember" },
  { key: "deny",           label: "Deny" },
]
```

**Zero changes to `telegram-format.ts` or either plugin.** `CLIInteractionPlugin.promptChoose`
reads the same keys (`plugins/cli.ts:232`). The permission gate speaks the channel's existing
vocabulary instead of extending it — which is the one-system property holding under load.

What the operator sees:

```
Permission - execution - US-002 - story workdir packages/app

Bash - approval required

  bun run test 2>&1 | tail -n 40

runs in: /Users/wk/work/myapp     <- permitted root; the shell starts HERE,
                                     not in the story's package
reason:  segment 2 (`tail`) matched no allow rule
stage:   implementer

[ Allow once ] [ Allow + remember ] [ Deny ]
10m -> deny
```

### 5.5 Fail-closed rendering details

- `choose` still appends Skip/Abort rows (`telegram-format.ts:209-212`). They are not in
  `options`, so `prompt()`'s remap leaves `action` as `"skip"`/`"abort"`. **The resolver
  ALLOWLISTS: only the exact strings `"allow"` and `"allow-remember"` permit; every other
  value — `"deny"`, `"skip"`, `"abort"`, and any unrecognised string — denies.** Written as a
  denylist of the two known extras it would admit anything a malformed or future plugin
  returned: `prompt()` only remaps when `action === "choose"` with a matching option
  (`chain.ts:130-137`) and otherwise passes the response through verbatim.
- The footer states `-> deny`, not `Fallback: {{fallback}}` (§3.1).
- **`type: "choose"` is pinned by a test.** `notify` and `webhook` both return
  `action: "approve"` with `respondedBy: "system"` and no human involved
  (`plugins/cli.ts:183-196`). A permission ask sent as `notify` auto-approves. That must be
  unreachable by construction, not by care.
- `callback_data` budget: suffix `:choose:allow-remember` is 22 of 64 bytes
  (`TELEGRAM_CALLBACK_DATA_MAX_BYTES`, `telegram-format.ts:22`), leaving 42 for the id before
  `truncateIdForCallbackData` trims. Request ids are generated here: keep them short, and
  never containing `:`, which `buildCallbackData` throws on (`:83-92`).

## 6. Construction, threading, failure

### 6.1 Module placement

Driven by master-plan D8: anything the chain touches joins the would-be `nax-coding`
extraction surface.

| module | contents | imports |
|---|---|---|
| `src/permissions/ask-chain.ts` | `AskDecision`, chain combinator, terminal deny | nothing new; stays extractable |
| `src/permissions/approvals-store.ts` | `.nax/approvals.json` read/append, exact lookup | fs + config paths |
| `src/tools/runtime.ts` (modify, `:380-384`) | widen `decision` to `AskDecision`; record `approval` in the audit object | unchanged |
| `src/interaction/ask-link.ts` | human link: `AskRequest` -> `InteractionRequest{type:"choose"}` -> `chain.prompt()` -> decision | `InteractionChain` + **type-only** import of `AskRequest`/`AskDecision` |

The human link lives in `src/interaction/`, **not** `src/permissions/`. In permissions it
would give permissions a runtime dependency on the interaction subsystem and drag it into P6's
extraction boundary. As a channel adapter with a type-only import back, the dependency is
`interaction -> permissions`, which is acyclic (permissions imports nothing from interaction)
and erases at runtime.

### 6.2 Threading

`resolveCodingToolSupport` takes an explicit `Pick<AgentRunOptions, ...>` allowlist
(`src/agents/coding-tool-support.ts:326-344`), and `interactionBridge` is **not** in it. The
resolver therefore does not arrive on the bridge's coat-tails; P2 adds `"askResolver"` to that
`Pick` as a deliberate, reviewable widening.

```
src/pipeline/stages/execution.ts:98   (D12 seam, beside buildInteractionBridge)
    buildAskResolver(ctx.interaction, { stage, storyId, featureName, root })
        |  callCtx -> AgentRunOptions.askResolver
        v
resolveCodingToolSupport(Pick<..., "askResolver">)
        v
buildCodingToolSupport -> createCodingToolRuntime({ askResolver })
                          (src/agents/coding-tool-support.ts:201, the sole call site)
```

### 6.3 Failure modes

Every path resolves to a decision; none throws.

| situation | decision | `decidedBy` |
|---|---|---|
| cache hit | allow | `cache` |
| no chain (`ctx.interaction` null: no config, or headless + `cli`) | deny | `unavailable` |
| `chain.prompt()` throws (all plugins failed) | deny | `unavailable` |
| no reply within `execution.approvalTimeout` (§6.5) | deny | `timeout` |
| operator taps Deny / Skip / Abort | deny | `human` |
| approvals file missing, unreadable or malformed | **cache link abstains**; human link still asked | (whatever answers) |

> **The resolver must never let an exception escape.** `src/tools/runtime.ts:380-393` wraps
> `askResolver.resolve` in try/catch and converts a throw into `{kind: "error"}` — a tool error
> surfaced to the model, not a denial. That loses the `denied:ask` row and hands the agent an
> error it may retry around. Every failure path catches internally and returns `"deny"`.

The last table row applies the trap the master plan recorded after D13a — *state what stops,
the signal or the screen*. A corrupt approvals file stops **the cache link**, not the chain.

### 6.4 Serialization

A mutex in the chain: one permission prompt in flight per run. Identical in-flight
`(stage, command)` requests **join** the pending promise rather than raising a second prompt;
different ones queue. The native turn-loop executes tools serially today, so this is
defensive — but it is what makes the gate behave identically on Telegram (concurrent) and CLI
(serial, §3.3).

### 6.5 Approval timeout (user, 2026-09-22)

**New config key `execution.approvalTimeout`, default 600000 ms (10 minutes)**, bounded like
its siblings (min 30 s, max 1 h). It is **independent of `interaction.defaults.timeout`** and
the human link reads only this one.

A permission prompt has a different cost profile from a pipeline gate: timing out DENIES, which
can cost a turn or fail a story, so its patience must not be coupled to a value an operator
would change for unrelated reasons (merge gates, cost warnings). Ten minutes is the schema's
own interaction default and is long enough for a phone in another room without stalling a
headless run indefinitely.

This is the same separation §3.1 makes for `fallback`, applied to the other half of the
timeout contract: **reuse the channel's transport, not its timing or fallback policy.**

### 6.5a Mutex discipline and run-end cancellation

**The mutex releases in a `finally`.** Acquire around the whole prompt-and-resolve path and
release unconditionally; a throw mid-prompt that left it held would deadlock every later ask
in the run, silently, because the next caller simply waits.

**A pending prompt must settle when the run ends.** `InteractionChain.cancel()` exists and
delegates to `plugin.cancel()`, which both the Telegram (`plugins/telegram.ts:253`) and CLI
(`plugins/cli.ts:105`) plugins implement — but **nothing in `src/` calls it.** Run cleanup
calls only `destroy()`, unconditionally, at `src/execution/lifecycle/run-cleanup.ts:286-289`.
So today a `destroy()` during an in-flight `receive()` tears the transport down underneath a
promise with nothing guaranteeing it settles — it can hang until `execution.approvalTimeout`
(up to an hour) expires, long after the run finished.

P2 therefore owns the abort path for its own prompt: the human link registers the in-flight
request id and, on run end or abort, calls `chain.cancel(requestId)` and resolves the pending
decision as `deny`. **Deny, not abstain** — this is the terminal link (§4.2), and a run that is
ending must not execute a command nobody approved.

### 6.6 The approvals file

`~/.nax/<project-name>/approvals.json`, written only by nax. **Not repo-local** — see the
storage note below.

```json
{ "entries": [
  { "stage": "implementer",
    "command": "bun run test 2>&1 | tail -n 40",
    "root": "/Users/wk/work/myapp",
    "origin": "escalate",
    "matchedRule": null,
    "approvedAt": "2026-09-22T10:31:04.000Z",
    "approvedBy": "telegram:<chatId>",
    "naxCommit": "7b37dbf74" }
] }
```

- **Key is `(stage, command)`, byte-exact.** No glob, no prefix, **no expiry** (user,
  2026-09-22 — an entry stands until removed; `origin` + `approvedAt` + `naxCommit` and a
  `nax approvals list/rm` surface are what make a standing grant auditable), and **no
  normalization** — not trimming, not whitespace collapsing, not quote folding. The stored
  string is the command string exactly as `policy.check` received it and exactly as it was
  rendered to the operator. Any normalization step is a place where the string that was
  approved and the string that runs can diverge, and the whole value of the cache is that
  they cannot. Two commands differing only in whitespace are two cache entries; that is the
  intended cost.
- `root` is recorded for audit, **not** part of the key.
- **Appends take a file lock.** Worktree-isolated parallel stories share one project-scoped
  file by design (that is why `root` is not keyed), so two "Allow + remember" taps can race a
  read-modify-write. Use the existing primitive — `src/utils/path-file-lock.ts` — rather than
  a bespoke one. A lost update or a torn file would degrade to "always ask again" per §6.3,
  which is safe but silently erodes the feature.
- `origin` distinguishes an escalated non-match from a deliberate operator `ask:` rule, so a
  later `nax approvals list` can show where a human-written rule was silenced by a button.
  That auditability is what makes "no expiry" defensible.
**Storage — why not the repo.** `root` is `storyExecRoot`: the repo **or worktree** root,
`<repo>/.nax-wt/<storyId>` under isolation (`src/agents/coding-tool-support.ts:58-64`). A
repo-local `.nax/approvals.json` would therefore be ephemeral under worktree isolation, and in
the main checkout it risks being committed — turning one operator's approvals into the whole
team's, which is a security regression, not an inconvenience.

`~/.nax/<project-name>/` is the established home for per-project durable state (`cost/`,
`features/`, `prompt-audit/`, `tool-audit/`). Construct the path with the approved helper:
`scripts/check-no-real-global-nax.ts` forbids open-coded `~/.nax` paths.

**🔴 The trust boundary, stated honestly (corrected 2026-09-22 after adversarial review).**
An earlier draft of this section claimed the location alone made the file unreachable. **That
is false for Bash**, which is the very tool this design exists to gate.

Containment (`resolveWithin`) protects the file from the TYPED path-bearing tools — Read,
Write, Edit, Delete, Grep, Glob. Bash is deliberately outside that mechanism, as
`src/tools/nax-owned-writes.ts:52-58` says in terms: *"Bash and Exec are absent because they
carry no path fields — a shell redirect into `.nax/` is gated by the human-authored
`Bash(...)` rules and the lexer, which is a different seam from this one."* And that seam does
not exist under `raw`: `screenRawBashCommand`'s `protectedHit` skips **every path outside the
root** — `policy-bash-raw.ts:84`, `if (rel.startsWith("..")) continue;` — so
`~/.nax/<project>/approvals.json` is never screened. Under the shipped default an agent can
`cat` it, or overwrite it with forged entries.

**Why that is nonetheless not a new vulnerability, and where the real risk is.** Under `raw`
the agent already holds an unrestricted shell; ADR-030 says so outright (*"a `raw` bash call
runs with the privileges of the nax process and may write anywhere that process can reach"*),
and D1 accepts it as the posture until P4's sandbox. An agent that can run any command has no
need to forge permission to run one. Forgery buys it something in exactly one configuration:
**a mixed-mode run, where a `raw` stage poisons the cache that an `escalate` stage later
trusts.** That is a genuine cross-stage privilege escalation — the ungated stage widens the
gated one — and the ledger would record `decidedBy: "cache"` with no human ever involved.

**So the cache carries two preconditions, both checked at construction, both fail-closed:**

1. **No stage in the effective config resolves to `bashApproval: "raw"`.** If any does, the
   cache link is DISABLED — it abstains unconditionally and logs one warning naming the
   offending stage — and every ask reaches the human. This costs nothing real: if every stage
   is `raw` the ask tier never fires, so there is nothing to cache; the only configuration it
   degrades is the mixed one, which is precisely the unsafe one.
2. **The resolved approvals path lies outside repoRoot.** `projectOutputDir` accepts any
   absolute `outputDir` override (`src/runtime/paths.ts:26-28`), including one inside the
   repo, which would hand the file back to the typed tools as well. If the path resolves
   inside repoRoot, the cache link is DISABLED on the same terms.

Disabling the cache means abstaining, and abstaining escalates to the human (§4.2), so both
failures cost prompts rather than safety. **P4's sandbox is what closes the underlying hole;
until then it is bounded by precondition 1 and disclosed here, not fixed.** Do not re-open it
as a defect — it is the same disclosed-not-fixed shape as D13a's third gap.

**Integrity is deliberately NOT attempted.** No signature or HMAC: any key readable by the nax
process is readable by a `raw` shell running as that process, so it would signal a guarantee
the threat model cannot deliver. `approvedBy` is provenance for humans reading an audit, not
an authentication claim.

**Why `root` is recorded but not keyed.** Keying on root would miss the cache on every
worktree-isolated run — each story gets its own `.nax-wt/<storyId>` root — i.e. it would
disable "remember" in nax's normal mode. A cached approval therefore applies across roots
within a project; the project scoping is what bounds it.

## 7. Ledger and corpus

### 7.1 `decidedBy`

`log()` already carries ten positional parameters plus an `audit?: {executed?, target?}` object
(`src/tools/runtime.ts:201-212`). `decidedBy` goes in **that object**, never an eleventh
positional, and is recorded on the **allow** path as well as `denied:ask` — otherwise a
human-approved execution is indistinguishable in the ledger from a mechanically-allowed one.

```ts
audit: { approval: { decidedBy, remembered: boolean, latencyMs } }
```

`ASK_UNAVAILABLE_REASON` (`src/permissions/ask.ts:9-10`) splits into per-case reasons: it
currently asserts "this run is headless" for cases that are not.

### 7.2 Corpus logging

Each resolved ask appends one JSONL record to the run's artifact directory: the full
`AskRequest` (verbatim command, root, stage, reason, matched rule), the decision, `decidedBy`,
and latency.

D4 states the labelled bash corpus "does not exist today" and must be grown from P5 shadow
logs. But **every human allow/deny on a real escalated command is a labelled example** — ground
truth, from the decision-maker, on the real distribution. Logging it now means P5's shadow
phase starts with a corpus instead of bootstrapping one, and calibration becomes a join on one
file rather than a reconstruction.

## 8. Test plan

Extends P1's acceptance spine; does not start a parallel one.
`test/integration/permissions/bash-deny-suite.test.ts` (21 cases) drives
`buildCodingToolSupport -> runtime.callTool`. P2 adds to that seam, through the production
entry, asserting **executed outcomes** and not verdicts alone (master-plan §5).

**Must prove:**

1. All 21 existing deny-suite cases still refuse, unchanged — the regression spine.
2. `escalate` + a resolver that allows -> the command **executes** (via `stubRunArgv`);
   `escalate` + a resolver that denies -> `denied:ask`, nothing spawned.
3. Timeout denies **even when `interaction.defaults.fallback` is `"continue"` or
   `"escalate"`** (§3.1) — `applyFallback` maps BOTH to `approve` (`chain.ts:186-193`), and
   `"escalate"` is what this author's own global config sets, so the fail-open case is live and
   not hypothetical. This test must fail against a resolver built on `applyFallback`.
3b. The human link reads `execution.approvalTimeout`, never `interaction.defaults.timeout`
   (§6.5) — assert with the two set to different values.
4. No chain -> deny with `decidedBy: "unavailable"`, distinct from timeout's reason string.
5. A throwing `chain.prompt()` yields `denied:ask`, **not** `{kind:"error"}` (§6.3).
6. Terminal link cannot abstain: a chain of all-abstaining links denies.
7. Cache hit allows without dispatching an interaction request at all (assert `send` uncalled).
8. Cache exactness: an entry for `bun run test` does **not** authorize `bun run test --x`.
   This is the direct anti-regression for the §4.3 prefix hazard.
9. A malformed `.nax/approvals.json` abstains the cache and still reaches the human link.
10. The approvals file is refused to Write, Edit, Delete, GitCommit **and Read** through
    `runtime.callTool` — by containment, since it lives outside repoRoot (§6.6) — asserting the
    file is unchanged on disk afterwards. Assert the EXECUTED outcome, not the verdict alone.
11. Any reply action outside `options` (`skip`, `abort`) maps to deny.
12. The dispatched `InteractionRequest` has `type: "choose"` and carries the command verbatim;
    a command exceeding the message budget denies rather than truncating.

13. **Cache preconditions (§6.6).** With any stage set to `bashApproval: "raw"`, the cache
    link abstains and the human is asked even for an entry that matches exactly. Same with an
    `outputDir` override placing the approvals file inside repoRoot. Both log a warning.
14. **Mutex releases on a throw.** A first ask whose `chain.prompt()` throws must not block a
    second ask; assert the second resolves rather than hanging (use a bounded timeout in the
    test, so a regression fails instead of stalling CI).
15. **Run-end cancellation.** With a prompt in flight, ending the run resolves the pending
    decision as `deny` and calls `chain.cancel(requestId)`; assert both, and assert the
    promise settles rather than waiting out `approvalTimeout`.
16. **Action allowlist.** A plugin response with an arbitrary `action` string (e.g.
    `"approve"`, `"continue"`, `"✓"`) denies. This is distinct from case 11's named
    `skip`/`abort`.
17. **The existing pin stays green**: `test/unit/permissions/ask.test.ts` must still assert
    `headlessAskResolver()` resolves `"deny"` after the `AskDecision` widening.
18. **Concurrent remember.** Two simultaneous `allow-remember` appends produce a file
    containing BOTH entries and valid JSON.

**Test-double warning (master-plan §5):** a double that cannot fail the way production fails
hides criticals. A fake `InteractionChain` must reproduce `prompt()`'s **throwing** and
**timeout** modes, not only its success mode; a fake approvals store must reproduce
unreadable-file failure, not only miss and hit.

## 9. Exit criteria (user, 2026-09-22)

**The shipped default stays `bashApproval: raw`.** P2 does not change any default, so no
existing project's behaviour moves.

**But P2 does not exit dormant.** Its exit requires the gate exercised end to end on real
traffic: set `bashApproval: escalate` AND a stage's `Bash(...)` allow rule on the P0 baseline
corpora (`p0-baseline/native-smoke`, `p0-baseline/monorepo-prompt`) and run them, with a
reachable Telegram chat. Under `gated`/`escalate` the Bash tool is offered for a stage only when
its resolved grants contain a `Bash` entry — and that entry comes solely from a human-written
`Bash(...)` allow rule, so an `escalate` config with no such rule sends no prompts at all (US-003
warns once per inert stage at run start). Example rule that un-inerts a stage:

```jsonc
"permissions": {
  "run": { "allow": ["Bash(ls *, cat *, git status*)"] }
}
```

One expression per stage; a second `Bash(...)` entry in one stage's allow list is a config load
error.

Exit is met when, from the artifacts:

1. a real escalated command reached the phone, was approved, and **executed** — with the
   ledger recording `decidedBy: "human"` on the allow path;
2. a denial and a timeout each produced a `denied:ask` row with distinct `decidedBy` values;
3. `allow-remember` wrote an entry, and a later identical command resolved from the cache with
   `decidedBy: "cache"` and no interaction request dispatched;
4. the approval-audit JSONL exists and carries the first ground-truth rows for P5.

This also yields the first real `denied:ask` measurements in the project's history — as
telemetry, not as a gate (§2.1).

**These are billed `nax run`s and need explicit approval at the launch moment** (standing
ruling). Gate on artifacts, never on exit codes — nax exits 0 on failure.

## 10. Out of scope

- **D4's post-allow seam** in `runtime.ts` — that is P5's, and P2 builds only the chain slot.
- **The model link itself** (P5).
- Multi-plugin registration / channel fallback (§3.3) — a channel change, not a gate change.
- A rich TUI plugin (§3.2) — this phase uses `CLIInteractionPlugin` for attended runs.
- Any change to `src/cli/confirm.ts` — it keeps serving `bin/nax.ts`; it is simply not the
  gate's TUI base.
- `src/hooks/` command screening — different seam, deliberately not unified.
- Capturing `callback_query.from` for per-user approval attribution (§10 item 2) — a channel
  enhancement, not a gate change.
- Promoting `RequestCapability` into an ask — a plausible future feeder into the same one
  gate, not this phase.
- Changing the `bashApproval` default away from `raw`.

## 11. Open items — resolved

All four are closed against the code; none is left to the implementer's judgement.

1. **Root divergence — RESOLVED: a cached approval applies regardless of root.** `root` is
   `storyExecRoot`, which is per-STORY under worktree isolation
   (`coding-tool-support.ts:58-64`), so keying on it would disable "remember" in nax's normal
   mode. Recorded for audit, not keyed (§6.6). Scoping is by project, via the file's location.
2. **Approval authority — RESOLVED: membership of the configured Telegram chat.** The
   ingestion filter compares `String(update.chat.id)` against the single configured `chatId`
   (`plugins/telegram.ts:435-436`), so an unauthorized chat's tap is never ingested — no
   response arrives, the prompt times out, and §3.1 makes that a deny. Fail-closed already, no
   new code.
   **Two limitations, documented not fixed:** in a GROUP chat (negative id) *any member* can
   approve, because the filter is per-chat not per-user; and `respondedBy` is the constant
   `"telegram"` (`plugins/telegram.ts:493,514`), with `callback_query.from` not captured in the
   wire types, so **per-user attribution does not exist**. `approvedBy` is therefore
   `telegram:<chatId>`. Capturing `from` is a channel enhancement benefiting every interaction
   consumer — it is deliberately NOT done here, because reaching into the channel for a
   gate-specific reason is what §3 exists to prevent. Listed in §9.
3. **Request-id scheme — RESOLVED:** `ask-<8 hex chars>`, 12 chars. No `:` (which
   `buildCallbackData` throws on), and well inside the 42-byte budget of §5.5 once the
   `:choose:allow-remember` suffix is subtracted. Uniqueness only needs to hold within a run,
   where receivers are keyed per request id.
4. **Corpus artifact path — RESOLVED:** `~/.nax/<project-name>/approval-audit/<runId>.jsonl`,
   mirroring the existing `tool-audit/` / `prompt-audit/` / `review-audit/` convention
   (`src/config/paths/index.ts:154`) so `nax-run-telemetry` finds it without new wiring.
