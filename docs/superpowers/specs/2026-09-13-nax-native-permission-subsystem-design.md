# Native-agent permission subsystem: unified grants, allow/ask/deny, and a Bash tool

Design only. Status: **design approved, not yet implemented.**

This spec consolidates every "may this call run" decision for the **native agent** into
one permission subsystem, and adds a model-authored shell tool (`Bash`) governed by it.
It supersedes the frozen half of GitHub **#374** (the scoped-allowlist mechanism is now
live on main; this spec finishes the shape it started), closes the shell half of
**#1800** (the `tdd-verifier` role is not expressible over the native tool set), and
amends **ADR-029 §3**, whose named reopen trigger — "an op that cannot be expressed
over declared commands" — has fired.

Related shipped work this builds on, and does not redo:

- Provider tools (#2031) and MCP client (#2036) — `src/tools/provider-*.ts`,
  `src/mcp/` own namespacing, grant expansion, sanitisation, and the lockfile.
- The Git flag gates for `show` (#1800's bounded half) — fixed at `src/tools/git.ts:80-88`.
- Per-element `{{files}}` quoting (#1998) and unified denial redirects (#1999).

## 1. Goal

One subsystem, one verdict. After this spec:

- Every tool call by the native agent resolves through a single policy engine to a
  three-state verdict: **allow | ask | deny**. `ask` resolves to deny in headless runs
  through a seam that a later interactive channel plugs into.
- The `execution.permissions` per-stage grammar grows `allow` / `deny` / `ask` rule
  lists (with `allowedTools` kept as an alias of `allow`), so users configure grants,
  refusals, and escalations in one place, per stage, with `inherit` unchanged.
- A `Bash` tool exists: a model-authored command string executed under the project
  shell, **deny-all by default in every profile**, granted only by explicit
  `Bash(prefix ...)` allow rules, evaluated per shell segment.
- `Mcp(server)` / `Mcp(server:tool)` becomes real grammar, and scoped profiles can
  hold MCP tools (today the provider gate is `unrestricted`-only).
- ADR-029 §3 is amended, and the gate's ability to **say no is itself a tested
  deliverable** (§6).

## 2. Current state

The decision pipeline today (all sites verified on main `44df9494f`):

```
op.tools (code)  ──┐
                   ├─> resolveCodingToolSupport ──> narrowGrants ──> compileToolPolicy
execution.permissionProfile ──> resolvePermissions ──> ToolGrant[] ──┘        │
mcp.servers.<id>.stages ∩ mcp-lock.json ∩ allowedTools ──> expandProviderGrants ──┘
                                                                              v
                       advertised = declared ∩ granted        callTool -> policy.check
```

Every layer narrows; nothing widens; nothing asks a human.

- **Profiles.** `PermissionProfile = "unrestricted" | "safe" | "scoped"`
  (`src/config/permissions.ts:16`), default `unrestricted`
  (`src/config/permissions.ts:55`). `resolvePermissions`
  (`src/config/permissions.ts:160`) is the SSOT; invalid input fails closed to
  `approve-reads` with zero grants.
- **Scoped blocks are live, not frozen.** `execution.permissions` stage blocks
  (`{mode, allowedTools, inherit}`, `src/config/schemas-execution.ts:183-196`) are
  validated at load by `validatePermissionsBlock` (`src/config/config-guards.ts:311`)
  and resolved by `resolveScopedPermissions` (`src/config/permissions.ts:203`) with
  inherit-chain → `default` block → no-tools fallback. `parseToolExpression`
  (`src/config/permissions.ts:144`) reads `Read`, `Write(src/**)`, `Git(diff,log)`.
- **Verdict is two-state.** `PolicyVerdict` (`src/tools/types.ts:109-111`) is
  `allowed | denied(breach?)`; `policy.check` (`src/tools/policy.ts:292`) is the single
  per-call decision site: argv shape → grant match → verb gate → containment → globs.
  Containment (`resolveWithin`, `.git/` refusal) precedes all pattern matching and is
  not expressible in config.
- **No shell.** The shell-adjacent surfaces are `RunCommand` declared keys
  (project-authored strings, model picks a key and fills quoted placeholders,
  `src/tools/run-command.ts:225`) and `Exec` (model-authored **argv**, no shell,
  metacharacters rejected by `METACHARACTERS` at `src/tools/exec-guard.ts:32`, 19
  `DENIED_FLAGS` at `:100`, default grants = 15 install-shaped
  `BUILT_IN_EXEC_PATTERNS`, `src/config/permissions.ts:112`). `unrestricted`
  deliberately excludes `Exec` from the blanket `["*"]` grant
  (`unconditionalGrants`, `src/config/permissions.ts:131-135`) — the precedent this
  spec reuses for `Bash`.
- **MCP is unrestricted-only.** `providersPermitted = resolved.mode === "approve-all"`
  (`src/agents/coding-tool-support.ts:274`): a scoped profile gets zero MCP tools.
  `Mcp(...)` in an `allowedTools` list **throws** `CONFIG_PERMISSIONS_UNKNOWN_TOOL`
  at load (`src/config/config-guards.ts:367`), because the known-name set is
  `RESERVED_TOOL_NAMES`.
- **No per-call hook.** `HOOK_EVENTS` (`src/hooks/types.ts:8-22`) are run/story
  lifecycle only; nothing fires per tool call and nothing can veto one. Denials are
  in-band text with affordance hints (`src/tools/denial-redirect.ts`).
- **ADR-029 §3** (`docs/adr/ADR-029-phase-c-native-coding-agent-scope.md`) deferred a
  shell with three reopen triggers, one of which — an op inexpressible over declared
  commands — is the `tdd-verifier` (#1800 constraint 3). Its standing bar: "whatever
  gate is designed must be able to say no, and must be tested on its ability to say
  no."

## 3. Rulings

- **R1 — three-state verdict, headless ask = deny.** `PolicyVerdict` gains `ask`.
  An `AskResolver` seam turns `ask` into a final allow/deny; the only v1 resolver is
  headless and returns deny with a distinct reason and a distinct ledger outcome
  (`denied:ask`). The interactive channel is a later feature behind the same seam.
  Metering first, mechanism later — the same discipline ADR-029 applied with
  `RequestCapability`.
- **R2 — Bash is a general tool; the structured tools stay and stay preferred.**
  `Read`/`Grep`/`Git`/`Exec`/`RunCommand` are not retired or wrapped; prompts keep
  steering to them for structured output. Bash exists for what they cannot express.
  The Git tool grows no further flag surface on this spec's account.
- **R3 — extend the live scoped grammar, do not replace it.** `execution.permissions`
  and the `Tool(pattern)` expression syntax are the substrate. `allowedTools` remains
  as an alias of the new `allow` key (both present = error, not merge). #374 closes
  as delivered by this spec.
- **R4 — Bash is deny-all by default in every profile.** Excluded from
  `unrestricted`'s blanket grant exactly as `Exec` is; **zero** built-in patterns; no
  auto-grant derived from `quality.commands`. Only an explicit `Bash(...)` allow rule
  grants anything. A `Bash(*)` grant is expressible but never shipped as a default.
- **R5 — op declarations stay in code; no widening seam.** `op.tools` remains the
  TS-owned ceiling (a reviewer cannot be handed `Write` by config). The subsystem
  unifies the config side only. Every layer still only narrows.
- **R6 — precedence: deny > ask > allow; unmatched falls through to the mode.**
  Deterministic and order-independent within a block. Under `scoped`, unmatched =
  deny, as today.
- **R7 — `Mcp(...)` becomes grammar; the provider gate widens to scoped.** Grammar
  accepts `Mcp(<serverId>)` and `Mcp(<serverId>:<tool>)` and expands to concrete
  `<serverId>__<tool>` grants **before** compilation (provider-tools R3: a surviving
  `{tool:"Mcp"}` matches nothing while every parser test stays green). Provider
  grants for a scoped stage become `stages ∩ lock ∩ server.allowedTools ∩ scoped
  Mcp-rules`. `safe` still grants no providers. Direction of travel is unchanged:
  `mcp.servers.<id>.stages` attaches, permission rules only narrow.
- **R8 — user-authored command strings stay untouched (standing ruling R10 of the
  rtk spec).** `quality.commands` and `acceptance.command` are trusted project
  config, executed as today, never wrapped, gated, or rewritten by this subsystem.
  They are documented on the same page as the permission surface, nothing more.
- **R9 — ADR-029 §3 is amended, and refusal is a tested deliverable.** The
  amendment records the fired trigger and the shipped gate. The deny suite (§6) is a
  first-class acceptance criterion; a green build in which the gate never
  demonstrably says no is a failed build of this feature.
- **R10 — permission blocks are consulted in every profile; the profile sets the
  unmatched fallback.** Today `execution.permissions` is read only under `scoped`.
  After this spec the per-stage rule lists are evaluated under every profile —
  `deny` and `ask` rules bind everywhere, and `allow` rules are how `Bash` (and
  additional `Exec` patterns, and `Mcp` narrowing) are granted regardless of
  profile. What the profile decides is the fallback for an *unmatched* call:
  `unrestricted` → allow for blanket-granted built-ins (as today), `safe` →
  reads only, `scoped` → deny. Without this, a default-profile project could not
  grant Bash at all without migrating wholesale to `scoped`, and a deny rule
  could not protect an `unrestricted` run.
- **R11 — per-segment evaluation; substitution is rejected in v1.** A Bash command
  is tokenized and split on shell control operators; every segment must match an
  allow rule and no segment may match a deny rule. Command/process substitution
  (`$(...)`, backticks, `<(...)`) and here-docs are refused outright in v1 —
  statically unanalysable payloads do not get a shell. Pipes, `&&`, `||`, `;` and
  simple redirections are permitted, per-segment-checked, redirect targets
  containment-checked.

## 4. Design

### US-001 — `src/permissions/` subsystem

New directory owning the whole question, with a barrel (`check:alias-internals`
applies from the first file):

```
src/permissions/
  index.ts        // barrel
  types.ts        // Verdict3, PermissionRule, RuleSet, AskResolver
  grammar.ts      // parseToolExpression moved + Mcp()/Bash() awareness
  rules.ts        // compileRules: {allow,deny,ask}[] -> RuleSet; precedence R6
  resolve.ts      // resolvePermissions / resolveScopedPermissions moved
  ask.ts          // AskResolver seam + headlessAskResolver (always deny)
  bash-rules.ts   // segment tokenizer + per-segment rule evaluation (US-005)
```

`src/config/permissions.ts` shrinks to re-exports during migration (constants like
`DEFAULT_PERMISSION_PROFILE`, `BUILT_IN_EXEC_PATTERNS` keep their import paths until
callers move). `compileToolPolicy` (`src/tools/policy.ts`) becomes a consumer: it
receives a compiled `RuleSet` instead of bare `ToolGrant[]`. The internal check order
(argv shape → rule match → verb gate → containment → globs) is unchanged; only the
grant-lookup step consults the rule set and can now answer `ask`.

`ResolvedPermissions` carries the rule set; `toolGrants` remains derivable for the
ACP adapter and audit middleware, which are not otherwise touched.

### US-002 — grammar and schema extension

`PermissionBlockSchema` (`src/config/schemas-execution.ts:183`) grows:

```jsonc
"execution": {
  "permissionProfile": "scoped",
  "permissions": {
    "run": {
      "allow": ["Read", "Glob", "Grep", "Write(src/**,test/**)",
                 "Bash(bun test *)", "Bash(bun run build)",
                 "Mcp(context7:query-docs)"],
      "deny":  ["Bash(git push *)", "Read(.env*)"],
      "ask":   ["Bash(rm *)"]
    },
    "verify": { "inherit": "run" },
    "default": { "mode": "approve-reads" }
  }
}
```

- `allow` / `deny` / `ask`: `string[]` of tool expressions. `allowedTools` stays
  accepted as an alias of `allow`; a block containing both throws
  `CONFIG_PERMISSIONS_ALLOW_ALIAS_CONFLICT` at load.
- `validatePermissionsBlock` extends to the three lists; the known-name set grows
  `Bash` and the `Mcp` pseudo-tool. `Mcp(x)` entries validate the server id shape
  (`MCP_SERVER_ID_RE`) but not existence — an unknown server is a warn at resolve
  time (a config may be shared across machines), never a load error.
- New load-time checks: a `deny`/`ask` expression whose tool is never allowable at
  any layer is a warn, not an error (dead rules are legal); malformed expressions
  keep throwing `CONFIG_PERMISSIONS_BAD_PATTERN`.
- `mode` and `inherit` are unchanged. Inheritance copies the whole resolved block
  (all three lists), as today.

### US-003 — rule engine and verdict

`compileRules` produces, per tool name, an ordered structure the policy consults:

```
check(tool, input) -> deny-rule hit? -> deny (reason names the rule)
                   -> ask-rule hit?  -> ask  (resolved via AskResolver)
                   -> allow-rule hit -> proceed to verb/containment/glob checks
                   -> no match       -> mode fallback (scoped: deny)
```

`PolicyVerdict` becomes three-state:

```ts
export type PolicyVerdict =
  | { readonly allowed: true; readonly resolvedPaths: readonly string[] }
  | { readonly allowed: false; readonly reason: string; readonly breach: boolean;
      readonly outcome: "denied" | "denied:ask" };
```

`callTool` (`src/tools/runtime.ts`) maps `denied:ask` to a distinct in-band message
("this command requires approval; this run is headless, so it is refused — prefer
<redirect>") and a distinct `ToolAuditSink` outcome so the audit can measure ask
demand before the interactive channel exists. Structural invariants preserved:
containment and tool-local `allowedVerbs` still bound whatever config grants;
`execTouchedPaths` carve-out untouched.

### US-004 — the `Bash` tool

New registered built-in (`src/tools/bash.ts`), name added to `CodingToolName` and
`RESERVED_TOOL_NAMES`.

- **Input:** `{ command: string, timeoutMs?: number, description?: string }`.
- **Execution:** `[quality.shell ?? "/bin/sh", "-c", command]` via an injectable
  spawn seam (the quality runner's discipline: `detached: true`, process-group kill
  on timeout, `stripEnvVars` applied, cwd = the hop's permitted root — the same root
  `policy.root` holds, never the runtime workdir). Default timeout 300 s (Exec's
  ceiling), output capped and byte-metered like other tools.
- **Grants:** none by default anywhere. `unconditionalGrants` treats `Bash` exactly
  as `Exec`: excluded from `unrestricted`'s blanket `["*"]`, and — unlike `Exec` —
  with an **empty** built-in pattern list. `safe` grants none. Only explicit
  `Bash(...)` rules grant.
- **Declared by (ceiling):** implementer, test-writer, rectifier, verifier,
  acceptance-fix, finish-fix, full-suite-rectify, autofix ops. Review ops
  (adversarial, semantic, debate) do **not** declare it in v1.
- **Prompting:** the tool preamble (`src/agents/tool-preamble.ts`, the dispatch-time
  branch point #1800 constraint 1 names) states: prefer structured tools; Bash is
  for what they cannot express; ungranted Bash will be refused with alternatives.

### US-005 — Bash command evaluation (`bash-rules.ts`)

1. **Tokenize** the command with a small POSIX-ish lexer: words, quoted strings
   (quotes respected for word boundaries only), operators. On any construct the
   lexer does not model — `$(`, backtick, `<(`, `>(`, here-doc `<<`, unbalanced
   quotes — the whole call is **denied** with a reason naming the construct (R11).
   `$VAR` expansion in a word is permitted but the token is treated as opaque: it
   can never satisfy a path containment check and never matches a rule token
   requiring a literal.
2. **Split into segments** on `&&`, `||`, `;`, `|`, `&`, newline.
3. **Per segment:** match against `Bash` rules token-wise with the same
   prefix-glob semantics `Exec` patterns use (`compileArgvPattern`,
   `src/tools/policy.ts:149`). `Bash(bun test *)` allows `bun test`,
   `bun test src/x.test.ts`; it does not allow `bun testx`. Deny beats ask beats
   allow **across the whole command**: one denied segment denies the call; else one
   ask segment makes the call ask; else all segments must be allowed.
4. **Payload checks per allowed segment:** `DENIED_FLAGS` applies (same list and
   normalizer as Exec, `src/tools/exec-guard.ts:100-148`); tokens that resolve to
   existing paths outside the root, or into `.git/`, deny with `breach` semantics;
   redirection targets must resolve inside the root; `cd` is allowed only to an
   in-root target.
5. The evaluation is pure (no I/O beyond path resolution against the workdir) and
   lives in `src/permissions/`, unit-testable without spawning anything.

This is deliberately safe-by-refusal, not safe-by-sandbox: anything the analyzer
cannot see through is refused, and the model is told why and what to use instead.
Sandboxing (OS-level isolation) stays out of scope and the ADR amendment says so.

### US-006 — MCP under scoped profiles

- `resolveProviderPermits` replaces the boolean at
  `src/agents/coding-tool-support.ts:274`: `approve-all` → all attached providers
  (as today); `scoped` → providers permitted, then each discovered tool's grant is
  kept only if the stage's rule set allows it (`Mcp(server)` allows all of that
  server's surviving tools; `Mcp(server:tool)` allows one; a deny/ask rule applies
  the same way); `approve-reads`/`safe` → none.
- Expansion happens where provider grants already materialize
  (`expandProviderGrants`, `src/tools/provider-grants.ts:19`), keyed by the
  post-lock, post-`allowedTools` tool list — `Mcp(...)` never survives into a
  compiled grant (provider-tools R3).
- Tool names remain `<serverId>__<tool>` (shipped ruling D1); the grammar's `Mcp`
  is surface syntax only.

### US-007 — ask seam and telemetry

```ts
export interface AskResolver {
  resolve(req: { tool: string; stage: PipelineStage; rule: string;
                 summary: string }): Promise<"allow" | "deny">;
}
```

- v1 ships `headlessAskResolver` (always `"deny"`, reason `ASK_UNAVAILABLE`).
- The resolver is injected where the policy is compiled
  (`resolveCodingToolSupport`), not read from config — choosing a resolver is a
  runtime capability, not a project setting.
- Ledger/audit rows for `denied:ask` carry the matched rule, so
  `nax`'s tool-audit can answer "how often would an interactive gate have been
  consulted, and for what" before anyone builds the channel. The reopen condition
  mirrors ADR-029's: a material rate of `denied:ask` rows justifies the
  interactive resolver; zero rows means the seam stays dormant.

### US-008 — denial affordances

`src/tools/denial-redirect.ts` learns the new surface both ways:

- A denied Bash call whose first segment head matches a structured tool's domain
  redirects to it (`grep …` → Grep, `git log …` → Git, `bun test …` →
  `RunCommand(testScoped)` when declared).
- Verb-slot and argv denials that today dead-end (`bash`, `sh` rows) redirect to
  `Bash` **only when the session's advertised set actually contains it**
  (`advertisedNames` already scopes hints).
- The `denied:ask` message names the rule and the headless limitation rather than
  implying the command is forbidden per se.

### US-009 — ADR amendment and docs

- `docs/adr/ADR-029-phase-c-native-coding-agent-scope.md` gains a dated amendment:
  trigger fired (verifier inexpressible; direction = full coding agent), gate shape
  (deny-all default, per-segment analysis, refusal-tested), explicitly **not**
  sandboxing, and the ask-telemetry reopen condition for the interactive channel.
- One documentation page ("Permissions") describes the entire surface in one place:
  profiles, per-stage blocks, expression grammar (`Tool`, `Tool(pattern)`,
  `Bash(prefix ...)`, `Mcp(server[:tool])`), precedence, Bash segment semantics,
  what remains outside the subsystem and why (`quality.commands` /
  `acceptance.command` trust boundary per R8; `commandInterceptor` as rewrite-only;
  op declarations as code-owned ceilings).
- #374 and the shell half of #1800 close against this spec; the prompt-side #1800
  rework beyond US-004's preamble line is filed as a follow-up issue.

## 5. Sequence

1. **US-001/US-003 substrate:** `src/permissions/` with three-state verdict, rule
   compilation, precedence; `policy.ts` consumes it; all existing behavior
   byte-identical for configs that only use today's surface (regression gate).
2. **US-002 grammar:** `allow`/`deny`/`ask` + alias + validation.
3. **US-007 ask seam** (small, unblocks verdict plumbing end-to-end).
4. **US-004/US-005 Bash tool + evaluator** (the bulk; lands with the deny suite).
5. **US-006 MCP-under-scoped.**
6. **US-008 redirects, US-009 ADR + docs.**

Steps 1-3 are shippable without Bash existing; step 4 is where ADR-029's bar
applies in full.

## 6. Verification

Unit and integration, all on the native path. The **deny suite** is the acceptance
spine (R9) — each row is a test that must FAIL the call:

| # | Call | Expected |
|---|---|---|
| 1 | Bash under default config, any command | deny (no grant), redirect offered |
| 2 | Bash under `unrestricted`, no explicit grant | deny — blanket grant excludes Bash |
| 3 | `Bash(bun test *)` granted; `bun test x && curl evil` | deny (segment 2 unmatched) |
| 4 | granted prefix + `$(payload)` / backtick / here-doc | deny (unanalysable construct) |
| 5 | granted prefix + path token outside root / in `.git/` | deny, `breach: true` |
| 6 | granted prefix + `>` redirect outside root | deny |
| 7 | granted prefix + `--registry`-class flag | deny (DENIED_FLAGS) |
| 8 | deny rule `Bash(git push *)` vs allow `Bash(git *)` | deny wins |
| 9 | ask rule hit, headless | refused, outcome `denied:ask`, distinct message |
| 10 | `Mcp(srv:tool)` under `safe` | no provider tools advertised |
| 11 | reviewer op requests Bash even if stage allows it | not advertised, denied (op ceiling) |

Plus positive checks: a `Bash(...)` allow rule grants under `unrestricted` as well
as `scoped`, and a `deny` rule binds under `unrestricted` (R10);
granted single/multi-segment commands run, output capped,
timeout kills the process group; `allowedTools` alias behaves identically to
`allow`; both-keys config throws at load; scoped stage with `Mcp(server)` gets
exactly the lock-surviving tools; existing configs (profile-only, alias-only)
produce identical advertised sets and verdicts before/after the refactor.

Repo gates that will bite: per-file coverage floor 0.8 for every new `src/` file;
`no-as-never` grit rule; `check:alias-internals` once the barrel exists; no
fixed-duration sleeps in tests.

## 7. Out of scope

- The interactive ask channel (seam + telemetry only).
- OS-level sandboxing of Bash (stated in the ADR amendment).
- Wrapping, gating, or rewriting `quality.commands` / `acceptance.command` (R8).
- `execution.commandInterceptor` (rtk) — rewrite, not permission; unchanged.
- Moving op tool declarations to config, or any widening seam (R5).
- Retiring `Exec` or `RunCommand` — both stay; convergence is a later question
  informed by Bash usage telemetry.
- Prompt-builder rework for #1800 beyond the tool-preamble branch (follow-up issue).
- ACP-path permissions — this subsystem is native-agent-only; the ACP adapter keeps
  consuming `ResolvedPermissions.mode` as today.
