# Bash approval modes — design

**Date:** 2026-09-22 · **Status:** design approved, not implemented
**Baseline:** `main` @ `e25351557` — every citation verified at that commit
**Implements:** phase 1 of the native-coding-agent arc
**Plan:** `docs/superpowers/plans/2026-09-22-bash-approval-modes.md`

---

## 1. Problem

A native-agent operation that declares `Bash` today can only run commands a human
pre-authorised with a `Bash(...)` allow rule for that stage, and only commands the lexer can
fully parse. Command substitution, backticks, subshells, here-documents and fd duplication are
refused outright (`src/permissions/bash-lex.ts`), even under a `Bash(*)` grant, because
`checkBashCommand` lexes **before** it evaluates grants (`src/tools/policy-bash.ts:228-231`).

Two measured consequences:

- An agent that cannot pipe or filter reads whole files instead. Tool-result bytes dominate
  context growth.
- A capability the typed tools do not expose is simply unreachable. In one measured run the
  verifier issued 13 sequential `Git` calls to walk history and hit 3 hard failures trying to
  express `git log --all`, `git diff --stat` and `git show -1`.

## 2. Goal

Introduce a mode axis, `bashApproval`, with three values, behind one deterministic gate.

| mode | behaviour |
|---|---|
| `raw` | Pass-through. No lexer refusal, no per-segment grant matching, no containment. One exception: a best-effort protected-path screen (§5). |
| `gated` | Today's behaviour, byte-identical: lexer refusal → deny; deny rules; per-segment allow matching; payload guards; ask rules. |
| `escalate` | `gated`, except a **Category A** denial (§4) resolves to the **ask** tier instead of deny. |

**Default: `raw`** (ruled 2026-09-22).

The names are `raw | gated | escalate` deliberately: `unrestricted` already names a permission
*profile* (`src/config/permissions.ts:17`), and a mode value colliding with a profile name is a
config foot-gun. Profiles answer "which tools is this stage granted"; the mode answers "how is a
bash command string adjudicated".

## 3. Threat model, stated plainly

The gate protects the repo and host from **the agent's own bad commands** — destructive deletes,
out-of-repo writes, global installs. Hostile repository content is **not** in the threat model.

**`raw` therefore removes the only mechanical boundary that exists today.** There is no
namespace, seccomp or container boundary around a Bash call; ADR-029 §3 already says so for the
gated case, and `raw` additionally drops the lexer and containment checks. Until an OS-level
sandbox ships, a `raw` Bash call runs with the privileges of the nax process and may write
anywhere that process can reach. This is accepted for trusted repositories.

Two properties bound the blast radius and must not regress:

1. **Review ops and the verifier never declare `Bash`.** The tool is constructed only when the
   operation declared it (`src/agents/coding-tool-support.ts:179`,
   `allowBash = args.declared.includes(BASH_TOOL_NAME)`). The synthetic grant introduced here
   **must be a no-op for an op that did not declare `Bash`**, so those roles are unaffected by
   any mode.
2. The deny path stays deterministic and fail-closed. `src/tools/bash.ts` continues to gate
   nothing (`bash.ts:14-19`, the single-gate rule).

## 4. Two categories of denial — the basis of `escalate`

`checkBashCommand` denies for two materially different reasons.

**Category A — "the gate cannot tell."** Escalatable.
- the lexer refused the command (`policy-bash.ts:229-231`)
- no allow rule covers a segment (`policy-bash.ts:245-248`)

**Category B — "affirmatively out of bounds."** Never escalatable.
- a path resolves outside the permitted root (`breach: true`)
- `.git/` refusal
- a `DENIED_FLAGS`-class flag
- an explicit deny rule matched
- a redirect or `cd` target outside the root

`escalate` converts **Category A only**. Category B stays a hard `denied` with `breach`
preserved. Rationale: `breach` is a telemetry signal that can indicate prompt injection
(`src/tools/runtime.ts:404-410`); dissolving it into an approval prompt destroys the signal and
invites a reflexive approval of a root escape. Category A is where human judgement adds
something.

This is carried in the data, not inferred from message text: `BashCheck`'s deny arm gains an
`escalatable` flag set at exactly the two Category A sites.

## 5. `raw` — where it is implemented, and why

**`raw` is a compile-time policy input, not a post-check verdict transform.**

A post-check `deny → allow` transform would be *widening*, and could not distinguish a lexer
refusal from a genuine containment breach without string-matching `verdict.reason`. That would
silently widen path-escape denials. A `Bash(*)` grant does not help either: the lexer runs first.

So the mode reaches `compileToolPolicy` as an option and the Bash branch dispatches on it. One
gate, deterministic, fully covered by the deny suite.

### The D13 protected-path screen

In `raw` the lexer still runs, advisorily:

- lexer **refuses** the command → **allow** (this inversion is what makes `raw` raw)
- lexer **parses** it → deny if any segment's argument or redirect target resolves to a
  nax-owned path; otherwise allow

Protected paths are the existing set in `src/tools/nax-owned-writes.ts`: `.nax/config.json`,
`.nax/mono/*/config.json`, `.nax/features/**/prd.json`, and the root queue-control files.

The screen is **advisory by construction** and must be documented as such wherever it appears:
a command using substitution bypasses it completely. It catches naive mistakes — the whole of
the §3 threat model — at near-zero cost. It is not a boundary, and it must never grow into a
general gate (single-gate rule).

## 6. `escalate` — where it is implemented

Also in the policy layer, for the same single-gate reason. When the mode is `escalate` and the
Bash branch produces an escalatable deny, the branch returns an **ask** verdict instead.

Everything downstream already exists:

```ts
if (!verdict.allowed && verdict.outcome === "ask") {        // runtime.ts:378
  decision = await askResolver.resolve({ tool, stage, rule, summary });
  if (decision === "allow") return runTool(...);            // :394
  log(policyIdentity, "denied:ask", ...);                   // :397
}
```

`askResolver` defaults to `headlessAskResolver()` (`runtime.ts:183`), which always denies. So
`escalate` is safe to ship before any interactive channel exists, and it immediately begins
emitting the `denied:ask` ledger rows that justify building one.

## 7. Config surface

Two layers, mirroring the existing `permissionProfile` (global) + `permissions.<stage>.mode`
(per-stage) shape:

| layer | key | site |
|---|---|---|
| global default | `execution.bashApproval` | `ExecutionConfigSchema`, `src/config/schemas-execution.ts` |
| per-stage override | `execution.permissions.<stage>.bashApproval` | `PermissionBlockSchema`, same file |

Per-stage wins over global. **Per-role override is out of scope**: `resolvePermissions(config,
_stage)` has no role parameter (`src/config/permissions.ts:233`), and the verifier exclusion is
already enforced by op-level tool declaration (§3.1), so no role axis is needed.

Two traps this must not fall into:

1. **BUG-20.** Zod does not re-parse a `.default()` value, so a key omitted from the
   hand-written `execution` default literal in `src/config/schemas.ts` disappears whenever a
   user supplies a partial `execution` object. The default must be **derived** from the field's
   own schema, following `DEFAULT_VERIFICATION_TIMEOUT_SECONDS`
   (`schemas-execution.ts:300-301`).
2. **Declared-but-never-read.** `execution.permissions.<stage>.mode` already exists in the
   schema and is never read — `stageRules` reads `allow`/`allowedTools`/`deny`/`ask`/`inherit`
   only, and its own comment says it "decides nothing". A per-stage `bashApproval` that is not
   wired into `stageRules`/`withRules` reproduces that defect. **Declaration and read land in
   the same commit.**

`PermissionBlockSchema` is `.strict()`, so the field must be declared there or a config carrying
it is rejected.

## 8. `bashApprovalOps`

The exported surface of mode resolution: a pure function from (mechanical verdict, mode) to
final verdict, plus the `BashApprovalMode` type. It is the seam P2 (human resolver) and P5
(typed-decision model) compose against.

**Deliberate narrowing versus the original sketch:** the human resolver is `AskResolver`, which
already exists and is already reached by the ask tier — a second async provider chain in
`runtime.callTool` would duplicate it. P5's classifier attaches at the **post-allow** seam in
`runtime.ts` (narrowing allow → ask), which is a different insertion point and is not built
here. P1 therefore exports the mode-resolution surface and does not add a resolver chain.

## 9. Out of scope

- OS-level sandboxing (a later phase; it makes `raw` safe and becomes its precondition).
- Any interactive approval channel. `escalate` resolves through the existing deny-always
  headless resolver.
- Any typed-decision / model-based auto-approval.
- Per-role permission overrides.
- Extending the typed `Git` tool surface. It is a real finding, but it is bounded to roles that
  never receive `Bash`, and is deferred pending measurement after this ships.
- Changing what the lexer refuses. `raw` changes how a refusal is *treated*; the 19 refusal
  behaviours pinned by `test/unit/permissions/bash-lex.test.ts:94-113` stay exactly as they are.
