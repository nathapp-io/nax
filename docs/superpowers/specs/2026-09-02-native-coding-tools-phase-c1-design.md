# Phase C1 — Native Filesystem Tools and Scoped Permission Enforcement

**Date:** 2026-09-02
**Status:** Design, approved for planning
**Builds on:** ADR-027 (adapter-protocol split), ADR-028 (native sessions and the pull-tool loop), ADR-029 (Phase C scope)
**Related:** #374 (scoped tool allowlists, PERM-002 Phase 2), `docs/specs/scoped-permissions.md`
**Supersedes in part:** ADR-029, which is scope-only and expects to be superseded once Phase C is designed

---

## 1. What this is

The first executable slice of Phase C: nax executing filesystem tools in-process,
with permission enforcement, for ops on the native transport.

In scope: `Read`, `Glob`, `Grep`, `Write`, `Edit`, and a read-only `Git`.

Out of scope, deliberately: `Bash`. ADR-029 section 3 names sandboxing a shell as a
security responsibility nax has never carried, and nothing here takes it on. See
section 8 for why `Git` is not a way of acquiring it quietly.

## 2. Entry condition: overridden, not met

ADR-029 section 2 severs Phase C until Phases A and B have proven cost **and
quality** parity on real ops. That condition is **not met**, and this design
proceeds anyway on an explicit user ruling.

The record, so it is not later mistaken for evidence:

- **Cost parity: proven.** Phase B measured native at roughly a tenth of the acpx
  per-op cost, same verdict, no fallback warnings.
- **Quality parity: not proven.** Native reviewed the **diff only** while acpx reads
  files and runs unrestricted, and the fixture carried **no planted defect**. Two
  agents agreeing that clean code is clean is not evidence of equal review quality.

This design mitigates rather than ignores that. Read tools plus `Git` are precisely
what closes the diff-only gap, so the A/B in section 9 produces the missing evidence
as a **result of** the work instead of a gate in front of it.

## 3. Decisions

### 3.1 The root is a hard boundary that no permission profile can widen

Tools resolve against a single root: `AgentRunOptions.cwd`, the same directory the
ACP adapter passes acpx as `--cwd`. Reusing it means a native op and an acpx op see
an identical filesystem scope, which is what makes an A/B between them honest.

The root is resolved through `packageWorkdir` and **fails loudly when empty**. An
empty `packageDir` silently becoming `process.cwd()` is the defect behind the
`git diff` "bad object" bug: with `-d`, work lands in the wrong repository. That
function's own docstring warns about it.

Containment is enforced by resolving to a real path **before** pattern matching, so
`..` traversal and symlinks pointing outside are refused structurally rather than by
pattern. The macOS case where `/tmp` is a symlink to `/private/tmp` is the canonical
example of why a glob such as `Write(/tmp/**)` and real-path containment would
disagree about the same file.

The consequence is the single most important safety property here:

> `unrestricted` means "any tool, any path **within the root**" — not "any path on
> the machine". Mode selects tools and patterns. The root selects the universe.

This matters because `unrestricted` is nax's documented default
(`DEFAULT_PERMISSION_PROFILE`), chosen because nax's own pipeline runs unattended and
must edit, test and commit without a human present. It also makes the native path
**tighter than acpx is today**: acpx under `--approve-all` can write anywhere the user
can. That is an improvement, and it is a behavioural difference to name when the two
are compared.

**No scratch directory, and no `/tmp`.** Nothing in C1 needs to write outside the
root: reads do not write, and `Write`/`Edit` have no consumer op (section 3.5).
Granting `/tmp` is not a pattern change but a structural one — one root becomes a set
of roots — and `/tmp` is the wrong shape for scratch regardless, being shared with
every process on the machine and carrying no lifecycle nax controls. If scratch is
ever needed, the right grant is the session-scoped `scratchDir` nax already owns.

Multiple roots and a grantable scratch directory are a **future configurable
extension**. C1 does not build them, but does not preclude them: containment lives
behind a single `resolveWithin(root, path)` seam and `ToolPolicy.check` takes an
already-resolved absolute path, so adding roots later changes the resolver rather
than every tool.

### 3.2 The gate is a policy compiled once and checked per call

`resolvePermissions(config, stage)` grows to return **grants** alongside the mode —
declarative data. Those grants are **compiled into a policy once per session** against
the root (in `src/tools/`, per section 3.4), and the turn loop asks that policy about
every call before executing. Deciding and compiling are deliberately separate: the
decision stays in the gated SSOT, while glob and filesystem semantics stay out of the
config layer.

Rejected: a `canUseTool`-style predicate injected per call. It is the only shape that
could later pause a turn for human approval, but nothing in nax can pause a turn and
the pipeline is unattended by design, so it would invent an interface for a consumer
nobody has written — the mistake ADR-029 exists to prevent.

Rejected: per-tool self-enforcement, where `Write` validates its own globs. It spreads
policy across N tools, which is the two-definitions-drifting risk ADR-029 section 4
names.

### 3.3 A denial is not an error

Four outcomes. Three reach the model. None are conflated.

| outcome | reaches the model as | rationale |
|---|---|---|
| ok | `tool-result` with content | — |
| error (ENOENT, bad args, tool threw) | `tool-result`, `isError` | recoverable; Phase B's existing contract |
| denied (policy refused) | `tool-result`, explicit `denied` marker and reason, **not** `isError` | ADR-029 section 5: a refusal is not a crash |
| containment breach (path resolves outside the root) | `denied`, **plus a warn log carrying the resolved path** | see below |

ADR-029 section 5 is explicit that reusing one path for both "would make a denied
permission look like a recoverable tool error". So the denial marker is structural,
not a string. Note the ACP text envelope `buildContextToolResult` carries
`status: "ok" | "error"`; native results are structured, so the marker is a field.

A containment breach stays **in band** as a denial rather than aborting: nax's
pipeline is unattended and one bad path guess should not kill an otherwise healthy
run. But it is logged at warn with the resolved path, because a path escaping the
root can indicate prompt injection or a model behaving alarmingly, and that should be
visible rather than silently absorbed.

### 3.4 Three homes, along the rail that already exists

`resolvePermissions` is **never called by an adapter**. The managers call it —
`AgentManager`, `manager-dispatch`, `SessionManager` — and the result travels down as
pre-resolved on `AgentRunOptions` / `SendTurnOpts`. Both docstrings say so: *"Pre-resolved
permissions — adapter reads this instead of calling resolvePermissions()."* The ACP
adapter's only use of it translates a mode into a flag, at a line commented "decides
nothing".

Nothing new is wired. The policy rides that rail.

**Decide** — `src/config/permissions.ts`. `ResolvedPermissions` goes from `{ mode }`
to `{ mode, toolGrants? }`, a grant being `{ tool, patterns }`: **declarative data, no
matchers**. The `resolveScopedPermissions` stub becomes real and **both** loader guards are
removed: `rejectUnimplementedScopedProfile` (rejects
`permissionProfile: "scoped"`) and `rejectUnimplementedPermissionsBlock` (rejects the
`execution.permissions` block outright). They are separate guards on separate keys and
an implementation that removes only the first leaves the policy block unreachable.

**Ordering constraint:** the guards come out **last**, after enforcement is wired and
proven end to end. Removing them earlier opens a window where a config can declare
`scoped` while nothing enforces it — silently weaker permissions than the operator
asked for, which is the exact failure both guards were written to prevent. `unrestricted` grants every declared tool with `*`;
`safe` grants read tools only. ACP's consumption of `mode` is untouched.

This home is not a preference. `check-permission-mode-ssot.ts` is an enforced gate:
*"Every permission decision belongs to `resolvePermissions()` in
`src/config/permissions.ts` — the project's mandatory SSOT rule."* It exists because
one open-coded mode was re-found and re-filed by three consecutive whole-repo reviews.

**Compile, enforce, execute** — `src/tools/`, new and transport-neutral. It imports no
nax-ai, so `check-nax-ai-imports.ts` (which confines that package to
`src/agents/native/`) stays satisfied.

- `policy.ts` — compiles grants against the root; `check(tool, args)` returns allow or
  deny-with-reason; `resolveWithin` does containment.
- `registry.ts` — name to `{ inputSchema, run, scope }`, mirroring `PULL_TOOL_REGISTRY`.
- one file per tool (`read.ts`, `write.ts`, `edit.ts`, `glob.ts`, `grep.ts`, `git.ts`),
  keeping to the 200-400 line norm.
- `runtime.ts` — pairs policy with registry; the analogue of `ContextToolRuntime`. It
  carries the `nax-permission-mode-allow` marker: it **applies** a decision, it never
  makes one.

**Route** — `src/agents/`. `AdapterInteraction` gains a third member,
`{ kind: "coding-tool", name, input }`, so `Write` never travels the context engine's
pull-tool vocabulary. `AdapterInteractionResponse` grows a structured denial field:
`{ answer: string }` cannot distinguish "refused, and here is why" from "here is your
file".

`buildRunInteractionHandler` **moves** from `src/agents/acp/adapter-output.ts` to
`src/agents/run-interaction-handler.ts` and gains the coding-tool branch. It is
entirely transport-agnostic despite living in the ACP tree — the identical trap Phase B
hit with `buildContextToolPreamble`, which it fixed by relocating to
`src/agents/tool-preamble.ts`. Importing ACP into the native tree is backwards, and
would trip `check:alias-internals` besides.

**Map and loop** — `src/agents/native/session/`, extending Phase B. `tool-mapping.ts`
also maps coding-tool specs to nax-ai `ToolDefinition`s; `turn-loop.ts` dispatches the
new kind and renders the three outcomes.

### 3.5 Advertised = what the op declares, intersected with what the policy grants

`RunOperation` gains `tools?: readonly CodingToolName[]`, beside the `session` block it
already carries.

Both axes can only narrow. A review op that never declares `Write` cannot receive it
even under `unrestricted`, because "should a reviewer write files" is a **capability**
question, not a permission one. A config denying `Write` to the review stage strips it
even where declared. This mirrors `StageConfig.pullToolNames`, already filtered through
both `PULL_TOOL_REGISTRY` and a per-request allowlist.

**Absent means the default read set.** `DEFAULT_CODING_TOOLS = [Read, Glob, Grep]` for
native run-ops; `tools: []` opts out explicitly. This follows the
`DEFAULT_PERMISSION_PROFILE` idiom in the same file: a named constant for the unset
case with its rationale recorded at the definition, distinct from the invalid case
which fails closed. Reading within the root is the same risk class as the pull tools
ops already receive, and defaulting it on closes the diff-only gap for every native op
at once rather than one at a time.

`Write`, `Edit` and `Git` always require explicit declaration.

**`Write` and `Edit` ship ahead of their consumer, knowingly.** No op declares them:
every op that writes also needs to run tests, which needs `Bash`. They are built now so
#374's gate has a concrete subject, and they are exercised by tests rather than by a
pipeline stage. This is a deliberate, recorded exception to the rule that C1 otherwise
follows.

### 3.6 The registry is open, with declared scope

A third party may register a tool: `{ name, inputSchema, run, scope }`, where `scope`
declares which input fields are path-bearing so the policy gates it generically instead
of hardcoding knowledge of `Write`'s `path` argument. That decoupling is better
architecture for the six built-ins regardless of whether anyone else registers one.

The policy therefore has **two granularities**, both already in #374's vocabulary:

- **tool-level** — `Git` allowed or not, mirroring a bare `Read`
- **field-level** — patterns over declared path fields, mirroring `Write(src/**)`

A tool declaring no path fields is gated at the tool level. That is the honest
expression for something whose arguments are not paths, rather than letting it slip
past a path-only gate.

Two rules come with an open registry:

- **Built-in names are reserved.** A registered `Write` would shadow the gated
  implementation — a privilege-escalation vector. Collision fails loudly at
  registration, not at call time.
- **Registration is in-process** — another nax module or plugin, never code fetched at
  runtime. This is an extension point, not a plugin download path.

Third-party tooling in the broader sense remains an MCP-shaped question. ADR-029 already
records that the native path loses MCP and skills, which belong to the ACP agents;
re-acquiring them natively is a separate arc with its own threat model.

## 4. The Git tool, and why it is not Bash

Reviewers need `git diff`. Today the diff is pushed into the prompt, which is exactly
the diff-only limitation behind the unproven quality parity.

It reuses the existing seam: `gitWithTimeout(args, workdir, timeoutMs)` in
`src/utils/git.ts` spawns `["git", ...args]` with an **argv array, never a shell
string**, an explicit `cwd`, a SIGKILL timeout, and concurrent pipe draining — the last
of which matters immediately, because `git log -p` is precisely the output that fills a
64KB pipe buffer and deadlocks a naive implementation.

This is subprocess execution, which ADR-029 section 3 severed, so the distinction is
written down rather than assumed:

- **fixed binary** — `git`, never a model-supplied command
- **structured input; nax builds the argv.** The model sends `{ subcommand, refs, paths }`,
  never a raw argument string. No shell means no `;`, `|`, or `$()`
- **read-only verb allowlist** — `diff`, `log`, `show`, `status`, `blame`. Mutating verbs
  (`commit`, `push`, `checkout`, `reset`, `clean`) are not representable in the input type
- **cwd pinned to the resolved root**
- **repo-escape flags never emitted, and asserted absent** — `-C`, `--git-dir`,
  `--work-tree`, `--exec-path`, and `-c` (config injection: `-c core.pager=...` is a
  command-execution vector). Asserted rather than merely not written, because a later
  refactor could reintroduce one
- **output truncated**, reusing the per-call token bound the pull tools already carry

Scoping is subcommand-level: `Git(diff,log,show)`, the same shape as #374's
`Bash(bun test*)` and exactly the non-path scoping section 3.6 requires anyway.

`Git` is **not** in the default set.

The line this draws is **not** "in-process versus spawning". `Grep` shells out too
(section 4.1), so that basis does not survive. The durable version has two parts:

- **A tool may be built at all** only if it is a fixed binary invoked with a
  nax-constructed argv and no shell. `Git`, `Grep` and a future `Bash` differ sharply
  here: for the first two nax chooses the program *and* every argument, so the model
  supplies data, never a command. `Bash` inverts that, which is why it needs a sandbox
  and a threat model rather than an allowlist.
- **A tool may be in the default set** only if it is read-only and narrow — a single
  bounded operation over file content. `Grep` and `Read` qualify. `Git` does not: it
  exposes history, arbitrary refs and blame, which is materially more surface than
  "search the working tree", and it is the capability a reviewer should ask for
  deliberately.

`Write` and `Edit` are excluded from the default set by the first clause of the second
rule; `Bash` is excluded from C1 entirely by the first rule.

### 4.1 Grep: `rg` when present, `grep` otherwise

`Grep` prefers `rg` and falls back to `grep`, selected at runtime via the injectable
`which` wrapper in `src/utils/bun-deps.ts`. Both branches spawn, and both are governed
by the same constraints as `Git`: fixed binary, nax-constructed argv, no shell, output
truncated.

The two binaries take different flags, so the argv builder is per-binary rather than
shared, and the fallback is tested explicitly — a machine without `rg` must produce the
same matches, not a silent empty result. Selection is resolved once and reported, so a
run's behaviour is attributable to which binary was found.

## 5. What #374 gets, and what its spec loses

#374 becomes implementable, because there is finally something to scope.

But its spec is **delegation-shaped throughout**. Section 2.3 is a flag-mapping table —
`--allowedTools` to Claude Code, `--allowed-tools` to acpx — and the whole model is
"hand the allowlist to a downstream agent and let it enforce". On the native path that
premise inverts: nax is the enforcer, there is no flag and no downstream agent.

- **survives**: section 2.1 (config shape), section 2.2 (pattern syntax)
- **mostly survives**: section 2.4 (resolver lookup, inherit chain, default fallback)
- **does not survive**: section 2.3, on the native path

So Phase C1 **amends** `docs/specs/scoped-permissions.md` rather than implementing it,
and #374 stays open until enforcement covers the stages its examples describe — several
of which are `Bash`-shaped and therefore out of C1.

## 6. Error handling

Beyond the four outcomes in section 3.3:

- A **policy that fails to compile** (malformed pattern, unknown tool name) fails at
  config load, loudly. `ConfigError` at load beats a surprise at call time.
- A **missing root** fails loudly at session open rather than defaulting, per section 3.1.
- A **registry collision** fails at registration, per section 3.6.

The through-line is the lesson from #1794, where a swallowed throw discarded a result
unlogged: a condition that means the configuration is wrong fails at the boundary, and
only a condition the model can act on is returned to it as data.

## 7. Testing

Organised around refusal, because ADR-029 section 3 requires it: *"Whatever gate is
designed must be able to say no, and must be tested on its ability to say no."*

**Policy units** — the bulk, needing no model, session or nax-ai. Table-driven over
`(grants, tool, path) -> allow | deny`:

- pattern matching: `Write(src/**)` allows `src/a.ts`, denies `test/a.ts`
- containment: `..` traversal, absolute paths outside the root, and symlinks pointing
  outside, each resolved through `resolveWithin` and refused. The `/tmp` to
  `/private/tmp` symlink is a fixture, being the shape that breaks naive matching
- **the hard-boundary property as an explicit test: `unrestricted` still denies outside
  the root.** If that test is ever deleted to make something pass, the design's main
  safety claim is gone with it
- tool-level gating for a registered tool declaring no path fields
- registry collision on a built-in name fails at registration
- the `Git` argv builder emits no escape flag for any input

**Tool implementations** — against a temporary fixture tree. Reads return what they
should; writes write what they should; `Edit` against a stale or absent match fails as
an **error**, not a denial.

**Turn-loop integration** — the three outcomes stay distinguishable end to end, with an
explicit assertion that a denial is **not** `isError`. That conflation is what ADR-029
section 5 exists to prevent and it would be invisible at runtime.

**Live probe** — one script in the `scripts/probe-native-tool-round-trip.ts` idiom Phase
B established: a real model, a real repository, asked to write outside the root; the run
shows the denial reaching the model and the file absent afterwards.

Phase B's lesson is the reason this last item is not optional. Compiling proves the parts
typecheck; only an end-to-end trace proves it runs. Phase B was unreachable in production
because nothing supplied `transcriptDir`, and all seven per-task reviews passed because
each task was correct in isolation.

## 8. Consequences

- **`Bash` stays severed**, and with it the implement and rectify ops, which remain on
  acpx. ADR-029 calls that the correct default: those agents are good at exactly this.
- **`tdd-verifier` is not unblocked.** Its prompt's first instruction is to run the
  story's scoped test files, and its output carries pass and fail counts. It needs
  `Bash`. An earlier note recording it as needing `Write` was wrong; both models in the
  Phase B A/B failed it by inventing bash syntax, which is the real signal.
- **`Write` and `Edit` ship without a production consumer**, knowingly (section 3.5).
- **The native path is tighter than acpx**, not equal to it (section 3.1). A comparison
  must say so.
- **ADR-029 is partially superseded.** Sections 1, 4 and 5 hold. Of its open questions:
  1 (the tool set), 2 (the gate's shape) and 4 (whether Phase B's loop extends) are
  answered **for the filesystem subset only** and stay open for `Bash`; 3 (bash
  sandboxing) is untouched; 5 asked whether the gate would turn out provider-shaped
  rather than nax-shaped, and it did **not** — enforcement is nax's, over nax's own
  tools, so ADR-028 section 8's package-split trigger is **not** fired.

## 9. Validation

The A/B Phase B could not run: same fixture **with a planted defect**, cross-file review
rather than diff-only, native with read tools and `Git` against acpx, measuring **catch
rate** rather than agreement.

That is the quality-parity evidence ADR-029 section 2 asked for. Section 2 of this
document records that it was waived as a precondition; this section records that the work
produces it anyway, which is the mitigation.

## 10. Open questions

1. ~~Does `Grep` shell out to `rg`, or stay in-process?~~ **Closed by user ruling:
   `rg` when present, `grep` otherwise.** See section 4.1. The consequence is recorded
   in section 4: the default-set rule is restated on read-only narrowness rather than
   on being in-process, because `Grep` spawns.
2. What is the per-call output bound for `Read` and `Git`, and is it shared with the
   pull tools' existing budget or separate?
3. Does `Edit` take `old_string`/`new_string`, or a line range? The former is the
   familiar contract and is self-verifying; the latter is cheaper to validate.
