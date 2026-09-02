# ADR-029: Phase C — Scope and Constraints for a Native Coding Agent

**Status:** Proposed — scope only
**Date:** 2026-09-02
**Author:** William Khoo, Claude
**Builds on:** ADR-027 (adapter-protocol split), ADR-028 (native sessions and the pull-tool loop)
**Related:** #374 (scoped tool allowlists, PERM-002 Phase 2), the "Nax Native LLM Harness" feasibility analysis §9, §10, §11
**Implementation:** none, and none planned until its entry conditions are met.

---

## What this ADR is, and what it deliberately is not

This records the decisions about Phase C that **are** settled, so they are not
re-argued or accidentally violated by earlier phases. It does **not** design the
permission gate, the tool set, or the executor.

That restraint is itself the decision. From the feasibility analysis:

> Permissions cannot be designed correctly yet, and that decides it. A gate's
> shape depends on what it gates, and the thing it would gate — nax's own
> executor for Read/Write/Edit/Bash — does not exist and is Phase C, which §9
> calls severable. Designing it now means inventing an interface for a consumer
> nobody has written.

An ADR that invented that interface today would be the same mistake ADR-027 §8
avoided for nax-ai: narrowing a proven surface is sound, inventing one for a
single hypothetical consumer is not. So this ADR fixes the boundary and the entry
conditions, and leaves the design to the ADR that supersedes it.

## Context

Phases A and B put nax's one-shot and read-only agentic ops on the native
transport. What remains is the implement and rectify ops — the work that edits
files and runs commands.

The asymmetry that makes this a different kind of project: **today nax never
executes a coding tool at all.** Claude Code inside acpx does, and enforces its
own approval policy. `resolvePermissions` (`src/config/permissions.ts:80`)
decides a mode once and it becomes a spawn flag — the comment at
`spawn-client-session.ts:119` says it "decides nothing". There is no
`canUseTool`-style callback anywhere in `src/agents/`, and the stream never
pauses for approval.

Against a stateless client, nax becomes the executor of every tool call. It must
then build a gate it has never needed.

## Decisions

### 1. Scope

Read, Write, Edit, Bash, Glob and Grep, executed in-process by nax, with
permission enforcement and per-story working-directory scoping. This is where
#374's scoped allowlists (`Write(src/**)`, `Bash(bun test*)`) finally become
implementable, because there is finally something to scope.

Estimated at ~5–8k LOC including tests — several times Phases A and B combined.

### 2. Phase C is severable, and stays severed until its entry conditions are met

It does not start until **Phases A and B have proven cost and quality parity on
real ops**. Not "shipped" — *proven*, by the same per-op A/B method Phase A used
and Phase B adopts.

The reason is not caution for its own sake. Frontier-lab CLIs ship heavily-tuned
tool prompts, and a first-cut native toolset will underperform Claude Code on
implementation quality. That is acceptable **only** because the target is cheap
API-key models for implementation work, not replacing Claude. If A and B have not
demonstrated parity on easier ops, that premise is unproven and C is a bet rather
than a step.

### 3. Sandboxing bash is a security responsibility nax has never carried

Named here so it is budgeted honestly rather than discovered. The analysis is
blunt about the failure mode: do not ship `--approve-all` semantics under a new
name.

A model-requested shell command executed in-process, in the user's repository,
with the user's credentials in the environment, is a materially different risk
from anything nax does today. Whatever gate is designed must be able to say no,
and must be tested on its ability to say no.

### 4. Permission policy stays in nax

nax-ai executes nothing and holds no policy — its own scope statement excludes
permission policy, and that boundary survives Phase C. nax already holds the SSOT
at `src/config/permissions.ts` and in #374's spec; a second home for policy
invites two definitions drifting apart.

### 5. What Phase C may not assume from Phase B

Phase B's tool loop is built for read-only tools whose failures are safe: a
budget breach or a handler throw returns a `tool-result` with `isError` and the
conversation continues. **That contract does not generalise.** A rejected `Write`
or a refused `Bash` is not the same event as a pull tool running out of budget,
and reusing the same path for both would make a denied permission look like a
recoverable tool error.

Phase B's loop is therefore a starting point, not a foundation. Whether it is
extended or replaced is a Phase C decision.

## Consequences

- **#374 stays blocked** until Phase C lands. It is blocked today regardless, so
  this costs nothing new.
- **The implement and rectify ops stay on acpx indefinitely**, which is the
  correct default: those agents are good at exactly this, and that is why acpx
  exists.
- **A capability is given up on the native path.** The analysis records that MCP
  and skills belong to the ACP agents; an op moved native loses them. That trade
  is tolerable for read-only review work and is a real question for coding work.

## Open Questions

Left open deliberately — each needs the executor to exist before it can be
answered honestly.

1. What is the tool set, exactly, and does it mirror Claude Code's or nax's own
   needs?
2. What shape is the gate — a synchronous predicate per call, a policy object
   compiled once, or something that can pause a turn for human approval (which
   nothing in nax can do today)?
3. How is bash sandboxed, and what is the threat model it is sandboxed against?
4. Does the Phase B turn loop extend to coding tools, or does Phase C need its
   own? See §5.
5. Does the permission gate turn out provider-shaped rather than nax-shaped? If
   it does, that is one of ADR-028 §8's triggers for revisiting the package
   split.

## Supersession

This ADR is expected to be superseded by a full Phase C design once its entry
conditions (§2) are met. Until then it exists to keep the boundary honest: Phases
A and B may not quietly acquire a coding tool, and Phase C may not quietly start
without the parity evidence that justifies it.
