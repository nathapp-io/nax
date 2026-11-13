# Gate-config route: let a run fix its own command config (#2897 #2898 #2899)

Status: design, approved approach (one feature, three stories). Date: 2026-11-13.

## Intent

When a story's gate fails because nax's own command config is wrong, the run fixes the config
itself instead of spending fix rounds that cannot succeed and leaving the fix to a human.

Worked case (store-erp `warehouse-work-orders`, nax 0.92.0): `.nax/mono/apps/admin/config.json`
had `quality.commands.testScoped: "bun test {{files}}"` while the package's own `test` script is
`bun test --isolate`. The scoped gate timed out at 10 minutes every round. The implementer found the
fix (272 pass / 0 fail in 4.9s with `--isolate`) and replied `BLOCKED`, because no session may write
nax config. The advisor then ruled "edit `.nax/mono/apps/admin/config.json`" (D-1), which the
implementer could not do; a second ruling (D-2) had to reverse it. The remaining rounds re-ran the
same gate with the same config. A human fixed it by hand (store-erp `d55cafb9`), and it only took
effect on the next run, because per-package config is resolved once per run.

Why it matters: the owner's standing goal for nax is minimal human interaction; problems at the
end of a run go to an agent, never to a new human step.

## Goals

1. The advisor knows which paths no session can write, so it never rules that the implementer
   should edit one (#2897).
2. The advisor can rule a typed config change; the orchestrator applies it when a fixed rule allows
   it, commits it, records it, and the next gate runs with the new config (#2898).
3. A story whose implementer is `BLOCKED` on something it cannot obtain, with the same gate failing
   the same way, stops the fix loop at once and goes to the advisor route, instead of spending the
   remaining rounds (#2899).

## Non-goals

- No model decides whether a command is safe. No approver agent.
- No change to the session write block on nax config: sessions still cannot write it.
- No config keys beyond `quality.commands.*` in v1.
- No change to `RequestCapability` (it still grants nothing).
- Workflow mode only (pipeline mode is frozen).

## Anti-goals (a failure even if it works)

- Any path by which text a session wrote (implementer concerns, evidence) can get an arbitrary shell
  command into `quality.commands`. `quality.commands` run through a shell without the permission
  gate; the write block exists for exactly this reason.
- A new step that waits for a human.
- Tightening the harness with new orders or restrictions for agents. The advisor gets facts (which
  paths are protected, which commands the package declares), not new rules about what to say.

## Constraints and facts from the code

- Implementer `BLOCKED` / `NEEDS_CONTEXT` replies go to `advisor.answerQuestion` inside the fix round
  (`workflow/story-steps.ts` `absorbTurn`, about line 197). The `implementer-question` menu offers only
  `answer` and `hold` (`advisor/menus.ts`); the result is a free-text string or null. An answer runs
  another implementer turn in the same round, then the loop returns to `evaluateStep`, which re-runs
  the gates.
- Gate items never reach advisor rulings: `residualStep` filters `f.kind !== "gate"` and passes only
  red gate names, for which the advisor returns free-text `diagnoses`. `residualStep` is terminal:
  after it the story closes (`closeStep`), typically `complete-gate-open` with red gates. So the
  residual path is not a place a config change could be applied and re-checked.
- The fix loop already has an early exit, `LoopState.advisorRoute`, set when a fix round changes
  nothing or leaves a narrower residual; `passExit` then returns `"capped"` and the story goes to
  `residualStep` (`story-steps.ts` about lines 296, 315, 421).
- The protected-path set comes from `agents/nax-protected-paths.ts` (`naxProtectedPaths()`), shared
  with `agents/nax-owned-writes.ts` and `agents/config-read-gate.ts`.
- Per-package config is `.nax/mono/<pkg>/config.json`, resolved by `config/loader.ts`
  `loadConfigForWorkdir` and cached for the run in `config/package-config-cache.ts` (only `clear()`
  exists; cleared at run cleanup). Root config has its own `_rootConfigCache`.
- The story's resolved config is captured when the story's call context is built
  (`workflow/call-context.ts` `buildWorkflowCallContext`: `config: ctx.config`, and `packageView` from
  `ctx.runtime.packages.resolve`). Gate ops (`workflow/gates.ts` `runStoryGates`) read their command
  through that call context. Clearing the config caches alone does not change what the next gate runs.
- Advisor decisions (with their `D-<n>` ids) are logged by the advisor decision log
  (`advisor/decision-log.ts`, the feature's `decisions.jsonl`). The `decisions-<stamp>.json` sidecar
  is a different file (human-recorded rulings) and is not used here.

## Approaches considered

1. **One feature, three stories (chosen).** Advisor facts plus a `config-change` ruling; an early
   stop for unobtainable blocks; orchestrator applies the change under a fixed rule. Chosen because
   the parts depend on each other: the early stop needs a route that can resolve the block, and the
   ruling needs something to apply it.
2. Two features (#2897 + #2899 first, #2898 later). Ships the early stop sooner, but until the second
   lands every such case still ends with a human editing config. Rejected by the owner.
3. Approver agent (model) judging the proposed command. Rejected: it puts the decision the write
   block exists to keep from sessions in front of a model that session-written evidence can talk
   into approving. The fixed rule covers the observed defect class (nax's copy of a command drifted
   from the package's own script) with no model and no human.

## Design

The change is proposed and applied inside the fix round, at the point the implementer replies
`BLOCKED`. That is the only place where an applied change is followed by another gate run without
changing the loop's state machine: the answer path already continues the round, and the next
`evaluateStep` re-runs the gates.

### Story 1: the advisor gets the facts and a `config-change` ruling (#2897, half of #2898)

- When the advisor answers an implementer question, its prompt includes: the protected paths no
  session can write (same source as `naxProtectedPaths()`, rendered readably), the story's package
  dir, the story's resolved `quality.commands.*`, and the `scripts` of the package's `package.json`
  as of the story's base commit (see the rule below for why base).
- A new action `config-change { key, to, reason }` on the `implementer-question` menu. The file is
  not chosen by the advisor: it is always the story's own config file (`.nax/mono/<pkg>/config.json`
  for a monorepo package, the root `.nax/config.json` when the story's package is the repo root).
- `answerQuestion` returns `{ kind: "answer", text } | { kind: "config-change", key, to, reason,
  decisionId } | null`.
- The residual menu is unchanged (gate items do not reach it; see Constraints).

### Story 2: nax applies an allowed change and the story uses it (#2898)

The fixed rule. A `config-change` is applied only if all hold:

- `key` is one of the command keys under `quality.commands` (for example
  `quality.commands.testScoped`).
- `to` is, exactly, either a `scripts` value from the package's `package.json` **as committed at the
  story's base commit**, or that value followed by ` {{files}}`. Nothing else: no runner forms, no
  edited flags. The base-commit manifest is used, not the working tree, so a session cannot add a
  script and then have it ruled in; the base manifest was committed by a human or an earlier,
  reviewed run, which is the same trust the package's own `test` script already has.
- The target config file is tracked in git (it is in the worked case).

When allowed, nax (not a session):

1. Writes the key into the story's config file, leaving the other keys as they are.
2. Commits only that path, as `chore(nax): set <key> for <pkg> (advisor D-<n>)`, without touching the
   implementer's uncommitted edits.
3. Records the application in the advisor decision log against the same decision id: from, to, and
   which script it matched.
4. Rebuilds the story's resolved config so every later gate in this story uses the new command
   (clearing the config caches is necessary but not sufficient; the story call context holds its own
   resolved config and package view). Later stories in the run that use the same package also get the
   new config.
5. Writes a ledger line, and the round continues without another implementer turn for the config
   (the answer *was* the config change). The next `evaluateStep` re-runs the gates.

When refused: a ledger line naming the proposal and the reason; the implementer's `BLOCKED`
concern is recorded as today (`recordConcern`), with the proposed change in its text, so whoever
finishes the branch sees it. No new human step.

### Story 3: stop the fix loop when a block cannot be lifted (#2899)

- `LoopState` keeps, per round, whether the implementer ended the round `BLOCKED` and which gates
  were red with which resolved command. It is persisted with the rest of the loop state so a resume
  keeps it.
- If a round ends `BLOCKED`, no config change was applied in it, and the same gate is red with the
  same resolved command as in the previous round, set `advisorRoute`. The story goes to
  `residualStep` now instead of spending the remaining rounds; its end state is what the residual path
  gives today (usually `complete-gate-open`).
- No tool-audit read is needed: the signal is the implementer's own `BLOCKED` reply plus an unchanged
  red gate.
- Ledger line: `fix round r<n> blocked with <gate> unchanged: <ids> go to the advisor`.
- The run summary and `nax workflow status` show, per story, a config change applied or refused
  (key, from, to, why). This sits in Story 2 if the PRD keeps three stories.

## Left to the builder

- How the protected paths are rendered for the advisor (readable list vs glob).
- How the JSON write preserves formatting.
- How the story's resolved config and package view are rebuilt (new call context, or a narrower
  refresh), as long as later gates in the story and later stories see the new command.
- Whether clearing the whole package-config cache (only `clear()` exists) is enough, or a per-key
  delete is added.

## Calls made by the designer (owner to check)

- The change is applied in the `BLOCKED` answer path, not at residual time (residual is terminal and
  gate items do not reach it).
- Allowed `to`: a base-commit `scripts` value, or that value plus ` {{files}}`. No `<runner> run
  <name>` forms in v1.
- The advisor does not choose the file; it is always the story's own config file.
- Story 3 uses the `BLOCKED` reply plus an unchanged red gate, not the tool audit.
- Run summary / status reporting folds into Story 2 (three stories).
