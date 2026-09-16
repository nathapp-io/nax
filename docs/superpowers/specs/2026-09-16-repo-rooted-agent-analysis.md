# Repo-Rooted Coding Agent — Impact, Risk and Blast Radius

**Date:** 2026-09-16
**Status:** Analysis only. No decision taken, no code written.
**Base:** `main` @ `d9614909c`
**Relates to:** the path-frame arc (`2026-09-16-path-frame-convention-design.md`) and its
follow-ups #2083-#2091; #2066/#2069 (per-package config); #2093 (found during this analysis).

---

## What this is trying to solve

**The agent works inside a boundary it is never told about.**

Its file tools are contained at the story's package directory. Nothing in any prompt says so —
not the role prompts, not the tool preamble, not the context bundle. The agent learns the
boundary exists only by hitting it, and the refusal it gets back is forbidden from naming it.
So it cannot reason about its own scope: it cannot tell "this file is outside my reach" from
"this file does not exist", and it cannot adapt, because nothing told it there was anything to
adapt to.

Three costs follow, and all three are already paid:

1. **Wrong conclusions, not just friction.** A reviewer shown a file it cannot open concludes
   the file is missing and files a false finding (#2090). An agent refused a path takes a
   destructive shortcut instead (`policy.ts:242-249`, quoted below).
2. **Compensating machinery.** `UNREADABLE_MARKER` (#2072/#2074) exists solely to tell the
   agent "this file is real but you cannot open it" — a subsystem whose only job is to
   partially undo the invisibility.
3. **A second path frame.** Because tools resolve against the package, every internal
   repo-rooted path must be re-spelled at the agent boundary. Getting that conversion wrong is
   the entire path-frame seam class (#2083-#2091).

The proposal below — root the agent at the whole repository — is one candidate answer. This
document assesses it. Its conclusion is that the *diagnosis* is right and the obvious
*mechanism* is wrong, because the boundary the agent cannot see is the same variable that also
carries containment, execution cwd and every permission glob.

---

## The proposal

nax contains the coding agent's file tools at the story's package directory. The proposal,
motivated by the move to a native full-agentic coding agent, is to root the agent at the
**whole repository** instead and let it decide what to read.

The case for it is not primarily about path frames. It is that **the agent is bounded by a
boundary it is never told about**. Nothing in any prompt section or builder states the tool
root — verified by grepping `src/prompts/` in full. The frame is stated exactly once, in the
planner prompt (`src/prompts/builders/plan-builder.ts:58`, `:326`, `:461`), to a different
agent than the one that later hits the wall. When it does hit the wall, it gets:

```ts
// src/tools/policy.ts:300
return "resolves outside the permitted root";
```

and the docblock above that function records what a bare version of this message once cost:

> A bare "resolves outside the permitted root" taught the model nothing the last time this
> shape of denial mattered: in the run that motivated this whole feature, that message is
> what led an agent to delete a tsconfig entry instead of installing the package it needed.

The same function is then explicitly forbidden from naming the boundary: the message "must
never reveal repository structure for a path the model never touched" (`policy.ts:266-268`).
So the agent discovers containment only by failing, and the failure is uninformative by design.

This is a real cost, and it compounds. `UNREADABLE_MARKER` (#2072/#2074) exists solely to tell
the agent "this file is real but you cannot open it". #2090 is the same class: an ACP reviewer
is shown a file, cannot read it, and files a bogus `test-gap` finding. With #2047 (a failed
tool call poisons the transcript — the model imitates its own bad example), invisible
containment produces wrong *conclusions*, not merely friction.

---

## The structural finding

**`ctx.root` does four jobs at once.**

| # | Job | Where |
|---|---|---|
| 1 | Containment boundary | `resolveWithin(root, candidate)`, `src/tools/policy.ts:123-140` |
| 2 | Relative-path frame for every tool argument | `relative(resolvedRoot, resolved)`, `policy.ts:464` |
| 3 | Execution cwd | Bash `bash.ts:105`; Git `git.ts:331,334,359`; GitCommit `git-commit.ts:57,61`; RunCommand `run-command.ts:428`; Glob `glob.ts:52`; Grep `grep.ts:112`; MCP spawn `mcp/client.ts:114` |
| 4 | The frame grant / deny / ask globs are matched against | `policy.ts:464`, `:503`, `:524`, `:550` |

`ctx.root` is `realOrRaw(codingToolRoot)` (`policy.ts:176`, `:564`), and `codingToolRoot` has
exactly one producer: `src/operations/call.ts:254`.

The proposal wants to change job 2. Moving the variable changes all four. Every risk below is
a consequence of that conflation rather than of the idea itself.

### A correction worth recording

`src/tools/run-command.ts:328` tells the agent that "a declared command runs in the directory
its configuration declares". That is intent, not implementation: `:425-428` passes
`workdir: ctx.root`. Today `ctx.root` *is* the package dir, so the two coincide and the
divergence is invisible. It stops being invisible the moment the root moves.

---

## Tier 1 — blockers

### B1. Worktree escape

`ctx.packageView.repoRoot` is the **main checkout**, not the story's worktree.
`createPackageRegistry` is built once per run from the run workdir (`src/runtime/index.ts:425`)
and the value is stamped onto every view (`src/runtime/packages.ts:64`); nothing re-points it.
Worktrees live *under* it at `<repoRoot>/.nax-wt/<storyId>/` (`src/worktree/manager.ts:122`),
and `packageWorkdir()` reconstructs the worktree path by joining the `.nax-wt/`-prefixed
`packageDir` back onto it — which is precisely why `codingToolRoot` is correct today and why
`codingToolRepoRoot` is **not ready-made plumbing but a trap**.

`src/runtime/packages.ts:103-116` already documents this hazard from the other direction:

> shortening it would point every file tool at the main checkout instead of the worktree.

Setting `codingToolRoot = packageView.repoRoot` is that same shortening. It fails **silently**:
the worktree is a subdirectory of the new root, so `isInside` approves; the default
`unrestricted` profile has no glob to catch it (see B3); and the only signal is a debug log
line printing `codingToolRoot` (`coding-tool-support.ts:295-300`).

Consequences: the agent edits the user's live checkout on their real branch; `GitCommit`
commits into the wrong tree; the story's own `git diff` goes blind; `git worktree remove
--force` discards the story's intended work while the collateral damage to the main checkout
is kept.

**Already live in one narrow place — filed as #2093.** `Exec` with `target: "repoRoot"`
resolves its cwd to `input.repoRoot` (`package-managers.ts:394`) = `codingToolRepoRoot` = the
main checkout. The proposal generalises that one hole to every path-bearing tool.

### B2. Privilege escalation through `.nax/`

`isNaxConfigFile` is deliberately narrow (`policy.ts:84-86`): it admits only a 2-segment
`.nax/config.json` or a 4-segment `.nax/mono/<pkg>/config.json`. A real monorepo's override is
**5 segments** — `.nax/mono/packages/api/config.json` (`src/config/loader.ts:382`, `:441`;
`src/cli/setup-write.ts:42`).

| Path | Today (root = `<repo>/packages/api`) | After (root = `<repo>`) |
|---|---|---|
| `<repo>/.nax/config.json` | refused by containment | refused by the guard |
| `<repo>/packages/api/.nax/config.json` | refused by the guard | **not refused** |
| `<repo>/.nax/mono/packages/api/config.json` | refused by containment | **not refused** |

That file supplies `quality.commands`, which reach a real shell with **no permission gate** —
`src/tools/run-command.ts:1-14` says so outright, and `policy.ts:68-75` names this exact route
as the reason the guard exists. Writing it bypasses every `Bash(...)` rule, the lexer refusals
and containment itself, on the next run.

The guard also covers only `config.json`. Repo-rooting additionally exposes `.nax/rules/*.md`
(live agent guidance, generated into `.claude/rules/`), `.nax/features/*/prd.json` and
`status.json` (story state and acceptance criteria), and `.nax/specs/`. An agent that can
rewrite its own acceptance criteria defeats the review layer without touching a config file.

Repo-root files outside `.nax/` join the same set: `.github/workflows/*` (CI code execution on
the next push), root `package.json` `scripts`, `.envrc`, and every sibling package's source.
`.git/` is the one exception and stays refused — `entersGitMetadata` matches `.git` as any
path segment (`policy.ts:57`).

### B3. Every grant, deny and ask glob silently re-scopes

Pattern matching happens against the root-relative spelling (`policy.ts:456-485`):

```ts
const relativeTo = (resolved: string) => relative(resolvedRoot, resolved).split(sep).join("/");
...
if (!grant.unconditional && !matchesAny(globs, rel)) { return deny(...); }
```

with the identical construction repeated for `listPathFields` (`:503`), `arrayPathFields`
(`:524`) and `refPathFields` (`:550`), and the same `rel` feeding `applyPathRules`, i.e. deny
and ask rules too.

So `Write(src/**)` stops meaning the package's `src/` and starts meaning the repo's. The
direction is mixed: package-scoped globs fail **closed** (stories break loudly), while
anything written `**/`-prefixed or repo-rooted fails **open** across siblings.

The compounding fact: under the default `unrestricted` profile every non-Exec tool gets
`patterns: ["*"]` (`src/config/permissions.ts:165`) and `grant.unconditional` short-circuits
glob matching entirely (`policy.ts:465`, `:481`). **Containment is therefore the only bound**,
which is exactly why B1 and B2 have nothing downstream to catch them.

---

## Tier 2 — silent semantic changes

| Change | Evidence | Consequence |
|---|---|---|
| Declared commands and Bash run at the repo root | `run-command.ts:428`, `bash.ts:105`, `policy-bash.ts:252` seeded from `policy.ts:387` | A `packages/api` story's `test` becomes the whole-repo suite. This is #2066 arriving from the opposite direction |
| `Exec` target collapse | `packageRelPath = relative(repoRoot, packageWorkdir)` → `""` (`run-command-exec.ts:66`), so `normalizeExec` treats every call as `repoRoot` and emits no workspace flag (`package-managers.ts:362-366`) | `bun add x` in a package story writes the **root** manifest and lockfile |
| MCP pool key collision | key is `(serverId, workdir)` where workdir is the permitted root (`mcp/pool.ts:65`, `mcp/provider.ts:10-12`) | Two package stories share one connection; every server spawns with `cwd = <repo>`. `pool.ts:2-8` names this as the silent-wrong-answer the key exists to prevent |
| Verifier verdict handshake breaks | `toolPatterns: { Write: [VERDICT_FILE] }` (`verify.ts:220`) admits only the repo-root file, while `readVerdict`/`cleanupVerdict` look in `packageWorkdir(...)` (`verify.ts:195-197`, `:284`) | Write allowed in one frame, read performed in another; the #2013 fallback goes unreachable, silently |
| Git read tools stop being package-scoped | `git.ts:254-258` pushes `"."` as the default pathspec, resolved against `ctx.root` | `git show HEAD` / `git log` / `git diff` go from the package to the whole repo |
| `execution.denyPaths` changes meaning | `delete.ts:101` matches `relative(ctx.root, target)` | Existing package-relative entries stop matching; repo-relative ones start. No error either way |
| `resolvePackageName` reads the wrong manifest | `coding-tool-support.ts:318-320` | yarn/cargo member scoping names the workspace root (moot given the Exec collapse above) |
| `execTouchedPaths` carve-out becomes dead | reachable only when `isInside` is false (`policy.ts:125-132`); both Exec cwds land inside a repo root | Harmless, but `policy.ts:116-121`'s safety argument stops holding for the reason it states |

---

## Tier 3 — cost

Glob, Grep and the Git read verbs all widen from one package to the whole repo. Read and Grep
already dominate tool-output bytes, and #2056 prices the compounding: carry cost is
`resultBytes × remaining round trips`. This is the one risk that is straightforwardly
measurable from existing run artifacts rather than arguable, and it should be measured before,
not after.

---

## What was checked and cleared

These were investigated and are **not** risks. Recorded so they are not re-investigated.

- **Audit trails do not move.** `toolAuditDir`'s root-anchored branch is a fallback only
  (`src/config/paths.ts:153-154`); `call.ts:259` always supplies `outputDir`, which is
  non-optional on `NaxRuntime`. The ledger stays at `~/.nax/<projectKey>/tool-audit/<feature>/`,
  per feature, one file per session. There is no in-repo reader of that tree at all.
- **Runtime and project keys are unaffected.** `projectKey` derives from the run workdir
  (`src/config/project-key.ts:25`), session names hash `options.workdir` = `ctx.packageDir`
  (`src/runtime/session-name.ts:13`, `call.ts:238`), and the `loadOrGet` caches key on
  `ctx.projectDir ?? ctx.workdir`. None reads `codingToolRoot`.
- **Session scratch, prompt-audit, review-audit, cost, fragments and PRD state** all anchor on
  `outputDir` / `projectDir` / `featureDir`.
- **The containment test suites survive verbatim.** The ~197 cases in `test/unit/tools/`
  (`policy` 68, `run-command` 62, `git` 43, `delete` 16, `delete-wiring` 8) build a temp root
  and assert escapes are refused; none asserts *which* root production passes. A sibling
  package simply stops being a sibling.
- **`test/unit/prompts/diff-access-acp-parity.test.ts` is unaffected** — it pins the ACP
  diff-access prompt region, which carries no path-frame content.
- **The file-size ratchet forces no refactor.** `src/tools/policy.ts` is 596/600 and is not
  touched; `src/operations/call.ts` is 597/600 and takes a one-line value swap; every other
  touched file loses lines.

---

## Size

The diff is small and almost entirely **subtractive**: ~25 files, ~150 lines deleted against
~20 added, two files deleted outright.

| Site | Fate |
|---|---|
| `src/context/fragments/reframe.ts` (96 lines) | deleted — fragments already record repo-rooted paths |
| `src/utils/path-frame.ts` `toPackageFrame`, `toPackageFrameFiles`, `UNREADABLE_MARKER`, `stripUnreadableMarker` | dead (−49 lines) |
| `src/context/builder.ts:294`, `src/pipeline/stages/context.ts:131`, `src/context/engine/stage-assembler.ts:236` | three near-identical re-spells, all no-ops |
| `spellForConsumer` (`code-neighbor.ts:223-229`) | collapses to `relative(repoRoot, abs)` (−35) |
| `stripUnreadableMarker` call (`code-neighbor-chunk.ts:149`) | dead |

Survivors, because they serve the *selector* axis rather than the frame axis: `normalizeWorkdir`,
`isRootWorkdir`, `storyWorkdir`, `storyPackageDir`, `storyAbsWorkdir`, and `toRepoFrame` — which
becomes more important, not less, as the only remaining frame.
`scripts/check-story-workdir-access.ts` keeps its full remit: `story.workdir` still selects the
config overlay, rules scope, quality commands and spawn cwd, and `"."` is still truthy.

Tests: ~24-30 cases change across 8 files out of 17,682; two files delete wholesale
(`test/unit/context/fragments/reframe.test.ts`, `code-neighbor-frame.test.ts`).

**The risk is not in the diff.** Everything in Tier 1 and Tier 2 is invisible at review time.

---

## ACP vs native

The root is set **globally** — `call.ts:254` has no agent branch. The protocol seam that does
exist (`src/agents/tool-preamble.ts:67`) lives only inside prompt-region rendering.

More importantly, **ACP agents are not rooted by `codingToolRoot` at all**: they are rooted by
process cwd — `runOptions.workdir = ctx.packageDir` (`call.ts:234`) → `acpx --cwd <cwd>`
(`src/agents/acp/spawn-client.ts:153-154`). Two different mechanisms.

The conversion layer being deleted lives in the context and prompt builders, which run
identically for both arms with no `protocol` parameter threaded in. So:

- **Global** (move both `codingToolRoot` and the ACP spawn cwd) is the subtractive option.
- **Native-only** is the expensive option: it keeps every conversion site alive *and* adds
  protocol plumbing to eight of them, leaving two arms to maintain permanently.

Operationally this matters because the current default is ACP (`agent.default: "claude"`), so a
native-only change delivers nothing to the runs being done today.

---

## What this would and would not fix

Of the ten open path-frame follow-ups, the split is along one line: defects caused by the
two-frame **boundary** dissolve; defects caused by `story.workdir` acting as a **selector** do not.

| Issue | Outcome |
|---|---|
| #2089 parent outputs | dissolves |
| #2088 git-history scope | dissolves |
| #2091 scopePaths attribution | mostly dissolves (the suffix-anchored glob is separately worth fixing) |
| #2087 scoped-lint | stops being a contradiction; the edit still has to happen |
| #2090 prompt-embedded git | **inverts** — `--relative` becomes the bug, native-side |
| #2083, #2084, #2085, #2086, #2080 | unaffected — plan-time and PRD-shape defects |

Four dissolve, one inverts, five remain.

---

## Recommendation

**Do not ship this as a root move.** The honest version is not "point the root at the repo" but
**splitting the four jobs of `ctx.root`**:

1. Frame and containment at the story's **tree** root — worktree-aware, derived from the
   isolation root, never `packageView.repoRoot` (B1).
2. Execution cwd threaded separately from the containment root, so declared commands, Bash and
   Exec keep their package scope (Tier 2, rows 1-2).
3. `.nax/**` denied **explicitly** rather than by accident of containment, and the
   `isNaxConfigFile` segment-count rule replaced with something that matches real override
   paths (B2).
4. Grant, deny, ask and `toolPatterns` globs migrated to the new frame, with the
   `unrestricted` default's glob-skipping behaviour accounted for (B3).

That is a permission-model redesign. It belongs **with** the native migration, as deliberate
work — not before it, and not as a route to closing four seam issues that are worth about a
week between them.

### Do now instead — near-zero risk, most of the benefit

Both address the actual complaint (invisibility) without touching containment:

1. **State the tool root in the agent preamble.** Nothing does today. The agent should be told
   which tree it is in, which package it owns, and that the rest of the repo exists.
2. **Make the containment denial name the boundary.** `policy.ts:300` returns a bare
   "resolves outside the permitted root". The docblock's own evidence is that this message has
   already caused a destructive workaround once. Naming the root — for a path the model
   *itself* named — is a different disclosure question from revealing structure for a path it
   never touched, and worth separating.

---

## Open questions

1. Is the native migration far enough along to justify a permission-model redesign, given the
   current default is ACP?
2. Does the Tier 3 cost actually materialise? Measurable from existing run artifacts by
   comparing Glob/Grep `resultBytes` at package versus repo scope.
3. Should package scope remain enforced at all once it is no longer a containment accident, or
   become advisory and checked at review (cf. #1359)?
