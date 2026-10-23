# SPEC: Workflow input bundle (Modifies cap, ACP report write, loopback default, gate output, coverage under sandbox, rules paths lint, package profiles)

Closes: #2634, #2638, #2644, #2662, #2663, #2617, #2651

## Summary

Seven defects make a workflow run lose or garble an input its agents or gates depend on. This spec fixes all seven:

- `nax plan` caps `### Modifies` at 40 entries per story, plus a 200-entry guard over the whole spec, and
  `nax spec lint` blocks a spec that would lose an entry, naming the story and the dropped paths (#2634).
- A story on an ACP agent can write its own `report.md`: the op's writable output reaches the ACP edit gate as a
  single-file exemption (#2638).
- When `allowedDomains` restricts the sandbox network, loopback binding defaults on for every session, not only
  for `nax bot review`. An explicit value still wins (#2644).
- The typecheck parser reads `bun check`'s `<error>` blocks, and a gate whose output no parser reads now carries the
  last 40 lines of that output into its finding (#2662).
- `test:coverage` run inside the nax sandbox (`NAX_SANDBOXED=1`) reports per-file floors without failing on them;
  the aggregate floor stays enforced (#2663).
- `nax rules lint` warns about a `paths` glob that matches no workspace package dir (#2617).
- The runtime package registry applies a package's `profile`, so a package-profile quality command is the one the
  gate runs (#2651).

## Motivation

Verified on `main` @ `798a105e1` (v0.91.4).

- **#2634.** `extractGroupedPathSection` (`src/prd/markdown-scan.ts`) stops at `MAX_MODIFIED_FILES` (25) entries in
  document order, over the whole spec. On a 69-entry cleanup feature, US-004 kept 3 of 17 entries and US-005 kept 0
  of 30, so the deletion story had no authorisation to touch the tests it had to change. `nax spec lint` only
  warns `modifies-at-cap` and names nothing.
- **#2638.** `workflow-implement` and `workflow-branch-fix` declare `writableOutput: (input) => input.reportPath`.
  `buildRunDispatchOptions` forwards it as `codingToolFileOutput`, which only the native coding tools turn into
  `ownedWriteExemption`. On ACP, `decideFull` (`nax-agent-acp/src/client/permissions.ts`) checks every edit target
  with `firstOutsidePolicy`, and `buildSandboxPolicy` denies the whole `.nax/features` entry, so Claude's `Write` of
  `report.md` is refused 5 times per story and the story review reports "TDD evidence absent".
- **#2644.** `bot/review-run.ts` `reviewConfig` defaults `allowLocalBinding` on when it is absent. Workflow sessions
  do not, so with a global `allowedDomains` list, tests that start a local server or reach a local test database fail
  inside agent sessions and come back as false cannot-verify items. `buildSandboxPolicy` and `createSrtBackend` both
  read `allowLocalBinding === true` directly.
- **#2662.** `parseTypecheckOutput` tries `tscStrategy`, then `typecheckTextBlockStrategy`; neither reads
  `<error file="…" line="…" column="…" code="…">`, so `bun check` output parses to `null`. The sentinel finding in
  `typecheckCheckOp` (and `lintCheckOp`) then names only the command to re-run and drops the output, so the fixer
  rediscovers the error.
- **#2663.** About 60 tests skip inside the agent sandbox that run in CI, so `check-coverage.ts`'s per-file floors
  fail on files a story never touched, and every such story ends `DONE_WITH_CONCERNS`. CI on the same head passes.
- **#2617.** `ruleMatchesPackage` tests each `paths` glob only against `<pkg>` and `<pkg>/`. A glob such as
  `apps/api/src/**/*` never matches, so the rule is never delivered in that package, and `nax rules lint` passes it.
- **#2651.** `createPackageRegistry().hydrate` loads overlays through `loadPackageOverride`, which strips `profile`.
  `loadConfigForWorkdir` applies the package profile, but `lintCheckOp` reads the runtime `PackageView`, so a
  package-profile lint command never runs and the gate records a pass.

User rulings 2026-10-23:
- bundle the seven issues as one feature (recorded as the one-capability confirmation for 9 stories);
- #2634: 40 per story plus 200 over the spec, and overflow blocks `nax spec lint` and `nax plan`;
- #2644: default on whenever `allowedDomains` is set, `[]` included; an explicit value wins; no probe warning;
- #2663: the rule-store wording is edited by hand in the spec commit; the run changes only the coverage script;
- #2617: a warning, plus docs; the matcher is unchanged.

## Design

### Approach

1. **Modifies caps (#2634).**
   - `MAX_MODIFIED_FILES` becomes 200 and keeps its role as the guard over the whole spec. A new
     `MAX_MODIFIED_FILES_PER_STORY` is 40.
   - `extractSpecModifiedFiles` extracts up to `MAX_MODIFIED_FILES` entries in document order, then keeps the first
     `MAX_MODIFIED_FILES_PER_STORY` entries of each story, also in document order. Stories are grouped by exact
     `storyId`, as `applyModifiedFiles` groups them; entries with `storyId: null` form one bucket of their own.
     Every extracted bullet counts toward the cap, duplicates of a path included.
   - A new export, `findModifiesOverflow(specContent)`, extracts with no cap and returns
     `{ total: number; stories: ModifiesStoryOverflow[] }`. Each `ModifiesStoryOverflow` is
     `{ storyId: string | null; count: number; dropped: string[] }`, listed only for a story whose count is over
     `MAX_MODIFIED_FILES_PER_STORY`; `dropped` holds the paths after the 40th, in document order.
   - `checkModifies` in `src/prd/spec-lint.ts` drops the `modifies-at-cap` warning; a new helper `checkModifiesCaps`
     (same file, keeping `checkModifies` under the complexity ratchet) adds two `error` findings:
     - `modifies-story-over-cap`, one per overflowing story: `<storyId> declares <count> Modifies entries; only the
       first 40 are kept. Dropped: <paths, comma separated>. Split the story.` For the `null` bucket, `<storyId>` reads
       `Unattributed entries`;
     - `modifies-over-cap`, when `total` is over 200: `<total> Modifies entries exceed the 200-entry cap for one spec;
       entries after the 200th are dropped. Split the feature.`
   - Both codes join `BLOCKING_SPEC_LINT_CODES`, so `assertSpecLintClean` (`nax plan`) throws
     `PLAN_SPEC_LINT_FAILED` instead of planning a spec that would lose entries.
2. **ACP report write (#2638).**
   - nax-agent: the `policy` arm of `SessionSandbox` gains `readonly writeExemption?: string` (absolute path).
     `sessionSandboxFrom(launcher, root, writeExemption?)` sets it, resolved against `root`, only on the `policy`
     arm and only when given.
   - nax: `resolveCodingToolSupport` passes `options.codingToolFileOutput` as the third argument of
     `sessionSandboxFrom`, so `acpSandbox.writeExemption` is the op's `fileOutput ?? writableOutput` path.
   - nax-agent-acp: `PermissionContext` gains `readonly writeExemption?: string`. `routerFor` (`backend.ts`) copies
     `ctx.sandbox.writeExemption` into it whenever it sets `sandbox`. `decideFull` passes it as a new optional 4th
     argument of `firstOutsidePolicy`.
   - `firstOutsidePolicy(targets, policy, cwd, writeExemption?)`: a target whose canonical path equals the canonical
     exemption path (exact, NFC, case-sensitive) skips the `denyWrite` check. The `..` rule and the `writeRoots`
     containment still apply to it. Every other target is checked exactly as today. The equality is on the NFC
     form; it is case-sensitive, so a differently cased spelling of the path is not exempt.
3. **Loopback default (#2644).**
   - nax-agent: a new `effectiveAllowLocalBinding(network: SandboxConfig["network"]): boolean` in
     `src/sandbox/network.ts` returns `network.allowLocalBinding` when it is a boolean, otherwise
     `network.allowedDomains !== undefined`.
   - `buildSandboxPolicy` reads the flag through it. `sandboxBackendFor(config)` (`src/sandbox/registry.ts`) passes
     `{ ...config.network, allowLocalBinding: effectiveAllowLocalBinding(config.network) }` to
     `_sandboxRegistryDeps.createBackend`, so srt's process-wide `initialize` gets the same answer.
   - `createSrtBackend` is unchanged: it still turns loopback on only for `allowLocalBinding === true`. That keeps
     `nax sandbox exec`, which builds its backend from a policy file whose network can only say `true` or nothing,
     from turning loopback on where the config said `false`. The policy type and srt's input still carry only
     `allowLocalBinding: true` or no key.
   - nax: the `execution.sandbox.network.allowLocalBinding` entry in `FIELD_DESCRIPTIONS` is reworded (Integration),
     and `docs/guides/permissions.md` says loopback defaults on under an allow-list.
4. **Gate output (#2662).**
   - A new strategy, `bunCheckStrategy` (`src/review/typecheck-parsing/strategies/bun-check.ts`, name `"bun-check"`),
     reads every `<error …>` block. The fixture below (`BUN_CHECK_SAMPLE`) is the output from #2662, verbatim; Bun
     1.4.4 prints the same shape for a one-line error (verified locally).
     - A block opens at a line starting `<error ` and ends at the next line `</error>`; with no `</error>`, it ends
       before the next `<error ` line or at the end of the output.
     - Attributes may appear in any order; `file` and `line` are required, `column` and `code` optional. A block
       missing `file` or `line` is skipped. A leading `TS` is stripped from `code` (`"TS2769"` -> `"2769"`), the
       digits-only form `tscStrategy` stores, so `genericTypecheckDiagnosticToFinding` builds the rule `TS2769`.
     - `message` = the first non-empty line after the opening tag that does not start with `<` (so `<source>`,
       `</source>`, `<related …>` and `</error>` are never the message); text on the opening tag line after `>` is
       used first when present.
     - `raw` = the block's lines from the opening tag through `</error>` (or its end).
     - Under `"auto"` the first strategy with diagnostics wins, so output mixing `<error>` blocks and tsc lines
       yields only the `bun-check` diagnostics.
     - `<source>` and `<related>` children are never parsed as diagnostics, and `<warning …>` blocks are ignored.
     It returns `null` when no diagnostic is left.

     ```text
     === bun check -p tsconfig.test.json (exit 1) ===
     <error file="test/unit/forge-tools/log-tool.test.ts" line="90" column="86" code="TS2769">
     No overload matches this call.
       ...
     <source>
     90 |     expect(result.content.split("\n").filter(...)).toEqual(expected);
     </source>
     <related file=".../bun-types/test.d.ts" line="1030" column="5">The last overload is declared here.</related>
     </error>

     Found 1 error in 1 file, checked 3,668 files [602.81ms]
     ```
   - `TypecheckParserFormat` gains `"bun-check"`. Under `"auto"` the order is `bunCheckStrategy`, `tscStrategy`,
     `typecheckTextBlockStrategy`. `toolForFormat("bun-check")` returns `"bun check"`.
   - A new module `src/operations/gate-output-tail.ts` exports `GATE_OUTPUT_TAIL_LINES` (40) and
     `gateOutputTail(output: string): string`: the last 40 lines of `redactSecrets(output)`, trailing blank lines
     removed, each line cut to `GATE_OUTPUT_TAIL_LINE_CHARS` (500) characters with `…` appended when cut; `""` for
     blank output. It is imported by relative path from the two ops and is not added to the operations barrel.
   - The sentinel finding of `typecheckCheckOp` and of `lintCheckOp` appends
     `\n\nOutput (last 40 lines):\n<tail>` to today's message when the tail is not empty.
5. **Coverage under the sandbox (#2663).**
   - A new module `packages/repo-tooling/scripts/coverage-gate-mode.ts` exports:
     - `coverageGateMode(env)`: `"sandboxed"` when `env.NAX_SANDBOXED === "1"`, else `"enforce"`;
     - `coverageExitCode({ aggregateFailures, perFileOk, allFilesOk, mode })`: `1` when `aggregateFailures` is not
       empty; otherwise `1` in `"enforce"` mode when `perFileOk` or `allFilesOk` is false; otherwise `0`;
     - `SANDBOXED_COVERAGE_NOTE` = `[coverage] sandboxed run (NAX_SANDBOXED=1): per-file floors not enforced (CI enforces them)`.
     - `finishCoverage({ aggregateFailures, perFileOk, allFilesOk, env, log, error }): 0 | 1`, the tail of today's
       `main` after `checkPerFile` and `checkUnreported` ran: it computes the mode from `env`, prints
       `SANDBOXED_COVERAGE_NOTE` through `log` in `"sandboxed"` mode, prints today's `[coverage] FAIL — …` lines
       through `error` when `aggregateFailures` is not empty, prints `[coverage] OK — at or above floor.` through
       `log` when the result is `0` and every check passed, prints
       `[coverage] OK (sandboxed) — aggregate at or above floor; per-file results above are report-only.` through
       `log` when the result is `0` in `"sandboxed"` mode with a per-file or unreported-file failure, and returns
       `coverageExitCode(...)`.
   - `check-coverage.ts` gains an exported `evaluateCoverageGate({ totals, perFile, unreported, env, log, error }):
     0 | 1`, the tail of today's `main` from `aggregateFailures` on: it runs `aggregateFailures(totals)`,
     `checkPerFile(perFile, { list: false })` and `checkUnreported(unreported)` as today, then returns
     `finishCoverage(...)`. `main` ends with `process.exit(evaluateCoverageGate({ …, env: process.env, log:
     console.log, error: console.error }))`, so only argument reading, the test run and `process.exit` stay
     untested.
   - The printed lines keep today's leading blank line: `finishCoverage` passes `log` and `error` a message that
     starts with `\n` exactly where today's `console.log` / `console.error` calls do; the ACs match on the
     message with its leading `\n` trimmed.
   - The rule store says `test:coverage` is CI-only and must not be run inside a nax session; that wording lands by
     hand in the spec commit (Out of Scope).
6. **Rules `paths` lint (#2617).**
   - `rulesLintCommand` passes the discovered workspace package list into `lintRulesForRoot`.
   - When the list is not empty, each `paths` glob of each rule is tested with `ruleMatchesPackage([glob], workdir,
     join(workdir, pkg), pkg)` for every package. A glob that matches none of them emits one warning, counted in the
     summary:
     `Canonical rule paths: glob matches no workspace package directory - paths: scopes packages; use appliesTo: for file globs`,
     with data `{ file, pattern, code: "PATHS_MATCH_NO_PACKAGE", root }`.
   - A rejecting `discoverWorkspacePackages` skips the check, as it does for `INERT_PATHS`.
   - Only rules loaded from the root equal to the lint `workdir` are checked; `lintRulesForRoot` receives the
     package list as `[]` for a nested package rule root, so nested roots are not checked.
   - `docs/guides/static-rules.md` (section "When to use `paths:` (monorepo)") states that `paths` matches package
     directories only, and shows a file glob moved into `appliesTo`.
7. **Package profiles in the registry (#2651).**
   - A new module `src/config/package-profile.ts` exports
     `loadPackageProfileLayers({ profile, repoRoot, packageDir, logger, warnDedupe })`. It returns
     `{ chain: string[]; layers: Record<string, unknown>[] }`: the profile chain (`parseProfileList`, `"default"`
     and empty names dropped) and, per name, the profile data after `loadProfile`, `resolveProfileEnvVars`,
     `applyConfigCompatShims` and `warnQualityCommandChains`. That is the loop `loadConfigForWorkdir` runs today,
     moved.
   - `resolveProfileEnvVars` is private to `loader.ts` today (it also serves the root profile layer). It moves,
     unchanged, to `src/config/profile.ts` as an export (with its `resolveEnvVars` / `UnresolvedEnvVarError`
     imports from `./dotenv`; `loadProfileEnv` is already there). `loader.ts` and `package-profile.ts` both import
     it from `./profile`, so `package-profile.ts` never imports `loader.ts` and no import cycle forms.
   - Every `loadPackageOverride` caller now sees the package profile's values. Besides `hydrate`, that is
     `resolveGateCommands` (`src/finish/gates/quality.ts`, the `nax finish` per-package gate commands) and
     `resolveGroupCommand` (`src/cli/features-acceptance.ts`, a package's `acceptance.command`). This is intended:
     for the package-mergeable keys they now agree with `loadConfigForWorkdir`. A profile key outside
     `mergePackageConfig`'s mergeable set is still dropped by `hydrate`, as an overlay key is today.
   - The profile's commands also reach `PackageView.overlay`, which `gate-cwd.ts` reads, so a profile-declared
     command runs in the package dir, as an overlay-declared one does.
   - Tests for this part isolate the global profile directory (`NAX_GLOBAL_CONFIG_DIR` set to a temp dir), because
     `loadProfile` also reads global profiles.
   - `loadConfigForWorkdir` calls it and deep-merges the layers as today, so its result is unchanged.
   - `loadPackageOverride` calls it with the stripped `profile` and returns the overlay fields deep-merged with every
     layer in chain order. The returned override never carries `profile`. `hydrate` then merges it and pins the
     root-only keys as today.

### Integration

Symbols this feature only reads:

- `buildRunDispatchOptions` (`packages/nax/src/operations/call-run-options.ts`) — sets `codingToolFileOutput` from
  `fileOutputPath ?? writableOutputPath`.
- `workflowImplementOp.writableOutput` (`packages/nax/src/operations/workflow-implement.ts`) — `(input) => input.reportPath`.
- `canonical`, `canonicalPolicyPath`, `hasDotDotSegment`, `withinRoot`, `withinDenied`
  (`packages/nax-agent-acp/src/client/edit-targets.ts`).
- `assertSpecLintClean` (`packages/nax/src/plan/spec-lint-gate.ts`) — throws on any `BLOCKING_SPEC_LINT_CODES` finding.
- `applyModifiedFiles` (`packages/nax/src/prd/modifies.ts`) — attaches `extractSpecModifiedFiles` entries to stories.
- `ruleMatchesPackage(paths, repoRoot, packageDir, storyWorkdir)`
  (`packages/nax/src/context/engine/scope-path-match/index.ts`).
- `pinRootOnlyKeys`, `mergePackageConfig`, `applyWorkflowMode` — used by `hydrate` (`packages/nax/src/runtime/packages.ts`).
- `redactSecrets` (`@/logger`).
- `resolveGateCommands(repoRoot, packageDirs)` (`packages/nax/src/finish/gates/quality.ts`) and
  `resolveGroupCommand` (`packages/nax/src/cli/features-acceptance.ts`) — other `loadPackageOverride` callers.
- `sandbox-exec.ts` `createBackend(file.policy.network)` (`packages/nax/src/cli/sandbox-exec.ts`) — unchanged by
  this feature.

Symbols this feature changes. The baseline only locates the code; implement the target.

- `MAX_MODIFIED_FILES` (`packages/nax/src/prd/modifies-extract.ts`)
  - Baseline: `25`, applied over the whole spec.
  - Target: `200`, applied over the whole spec; plus `MAX_MODIFIED_FILES_PER_STORY = 40`.
- `extractSpecModifiedFiles(specContent)`
  - Baseline: the first 25 entries in document order.
  - Target: the first 200 entries in document order, then at most 40 per story.
- `checkModifies` (`packages/nax/src/prd/spec-lint.ts`)
  - Baseline: warns `modifies-at-cap` at 25 entries.
  - Target: no `modifies-at-cap`; errors `modifies-story-over-cap` and `modifies-over-cap`, both blocking.
- `SessionSandbox` (`packages/nax-agent/src/sandbox/types.ts`)
  - Baseline: `{ kind: "policy"; policy: SandboxPolicy } | { kind: "unavailable"; reason: string }`.
  - Target: `{ kind: "policy"; policy: SandboxPolicy; writeExemption?: string } | { kind: "unavailable"; reason: string }`.
- `sessionSandboxFrom` (`packages/nax-agent/src/sandbox/session-sandbox.ts`)
  - Baseline: `(launcher, root)`.
  - Target: `(launcher, root, writeExemption?: string)`.
- `firstOutsidePolicy` (`packages/nax-agent-acp/src/client/edit-targets.ts`)
  - Baseline: `(targets, policy, cwd)`.
  - Target: `(targets, policy, cwd, writeExemption?: string)`.
- `PermissionContext` (`packages/nax-agent-acp/src/client/permissions.ts`) — Target: gains `readonly writeExemption?: string`.
- `buildSandboxPolicy` (`packages/nax-agent/src/sandbox/policy-builder.ts`)
  - Baseline: loopback on only when `allowLocalBinding === true`.
  - Target: loopback on when `effectiveAllowLocalBinding(config.network)` is true.
- `sandboxBackendFor(config)` (`packages/nax-agent/src/sandbox/registry.ts`)
  - Baseline: `createBackend(config.network)`.
  - Target: `createBackend({ ...config.network, allowLocalBinding: effectiveAllowLocalBinding(config.network) })`.
- `FIELD_DESCRIPTIONS["execution.sandbox.network.allowLocalBinding"]` (`packages/nax/src/cli/config-descriptions.ts`)
  - Target: `Allow sandboxed commands to reach loopback ports. Defaults on when allowedDomains is set; set false to keep loopback closed`.
- `TypecheckParserFormat` (`packages/nax/src/review/typecheck-parsing/types.ts`)
  - Baseline: `"tsc" | "text-block"`.
  - Target: `"tsc" | "text-block" | "bun-check"`.
- `lintRulesForRoot` (`packages/nax/src/cli/rules-lint.ts`) — Target: gains a `packages: readonly string[]` parameter.
- `loadPackageOverride(repoRoot, packageDir)` (`packages/nax/src/config/loader.ts`)
  - Baseline: returns the overlay fields with `profile` stripped and never applied.
  - Target: returns the overlay fields deep-merged with the package profile layers; `profile` never in the result.

### Failure Handling

| Condition | Behaviour |
|---|---|
| One story declares more than 40 Modifies entries | `nax spec lint` error `modifies-story-over-cap` naming the story, the count and every dropped path; `nax plan` throws `PLAN_SPEC_LINT_FAILED` |
| The spec declares more than 200 Modifies entries | error `modifies-over-cap` naming the count; `nax plan` throws `PLAN_SPEC_LINT_FAILED` |
| `nax plan --no-spec-lint` on an overflowing spec | extraction keeps the first 200, then the first 40 per story, as the caps say; no error (pinned by the `extractSpecModifiedFiles` 45-entry and 240-entry ACs) |
| An edit targets the exemption path but the exemption is outside every write root | refused with `OUTSIDE_WRITE_ROOTS_REASON`, as today |
| An edit targets any other path under a denied entry | refused with `OUTSIDE_WRITE_ROOTS_REASON`, as today |
| The session has no sandbox policy (`unavailable` or none) | no exemption; the gate behaves as today |
| `allowLocalBinding: false` with an `allowedDomains` list | loopback stays closed |
| `nax sandbox exec` with a policy file whose network has an allow-list and no `allowLocalBinding` | loopback stays closed, as today (`createSrtBackend` unchanged) |
| No typecheck strategy parses a failing command's output | the sentinel finding carries the last 40 redacted lines |
| A failing gate command produces blank output | the sentinel finding carries no output section |
| A `<error>` block has no `file` or `line` attribute | that block is skipped |
| `NAX_SANDBOXED` is unset or anything other than `"1"` | per-file floors and the unreported-file check enforce as today |
| The aggregate floor fails in a sandboxed run | exit 1, as today |
| `discoverWorkspacePackages` rejects during `nax rules lint` | no `PATHS_MATCH_NO_PACKAGE` check |
| A package's `profile` names a profile that does not exist | `loadPackageOverride` rejects with the `PROFILE_NOT_FOUND` NaxError `loadProfile` throws; `hydrate` (no catch) rejects with it, so the run fails at setup, as `loadConfigForWorkdir` already does for that package |

## Out of Scope

- The planner prompt's folding of dropped Modifies paths into `analysis` is not changed; the lint now blocks before planning instead.
- The `### Context Files` cap (`MAX_SPEC_CONTEXT_FILES`) is not changed.
- A Bash command writing the report path stays denied by the shell sandbox; only the agent's file-edit permission gate gets the exemption.
- Forwarding an implementer's inline report to the story review when `report.md` is absent is not done.
- `nax sandbox probe` gets no new warning about `allowLocalBinding`.
- `bot/review-run.ts` `reviewConfig` keeps its own `allowLocalBinding` default, which stays a superset of the new resolver (it also turns loopback on with an open network).
- No new explicit typecheck output-format value is added; `bunCheckStrategy` runs under `"auto"` only.
- `bun check` `<warning>` blocks are not turned into findings.
- The aggregate coverage floor is still enforced inside the sandbox; CI's coverage job is unchanged.
- The rule-store wording that `test:coverage` is CI-only (`.nax/rules/testing-commands.md`, `.nax/mono/packages/nax/context.md`) is edited by hand in the spec commit, not by the run.
- `check-coverage.ts` `main`'s single call into `evaluateCoverageGate` is not driven by a test (that would run the whole suite).
- `ruleMatchesPackage` is not widened to match file globs inside a package.
- The rules-setup skill text in the separate skills repository is not changed.
- `PATHS_MATCH_NO_PACKAGE` checks only rules whose repo has workspace packages; a single-package repo keeps the `INERT_PATHS` warning.
- Rules in nested package rule roots (`<pkg>/.nax/rules/`) are not checked for `PATHS_MATCH_NO_PACKAGE`.
- Root-only keys a package profile sets (`auth`, `advisor`, `workflow`, `execution.sandbox` and the other pinned keys) stay pinned to the root, as today.

## Stories

Nine stories across four packages. The user ruled to ship the seven issues as one feature: each one is an input a
workflow run loses or garbles.

### US-001: Sandbox loopback default and the session write exemption
No dependencies. Workdir: packages/nax-agent.

Adds `effectiveAllowLocalBinding` (`src/sandbox/network.ts`) and reads it in `buildSandboxPolicy` and
`sandboxBackendFor`; `createSrtBackend` is unchanged. Adds `writeExemption` to the `policy` arm of `SessionSandbox` and the optional third parameter of
`sessionSandboxFrom`.

### US-002: ACP edit gate honours the write exemption
Depends on US-001. Workdir: packages/nax-agent-acp.

Adds `writeExemption` to `PermissionContext`, copies it from the open context's sandbox in `routerFor`, and adds the
optional exemption parameter to `firstOutsidePolicy`, used by `decideFull`.

### US-003: nax passes the op's writable output to the ACP sandbox
Depends on US-001. Workdir: packages/nax.

`resolveCodingToolSupport` passes `codingToolFileOutput` to `sessionSandboxFrom`. Rewords the `allowLocalBinding`
config description and the loopback sentence in `docs/guides/permissions.md`.

### US-004: Modifies caps per story and blocking lint
No dependencies. Workdir: packages/nax.

Adds `MAX_MODIFIED_FILES_PER_STORY` and `findModifiesOverflow`, raises `MAX_MODIFIED_FILES` to 200, applies the
per-story cap in `extractSpecModifiedFiles`, and replaces `modifies-at-cap` with the two blocking lint errors.

### US-005: bun check typecheck parsing
No dependencies. Workdir: packages/nax.

Adds `bunCheckStrategy`, the `"bun-check"` format, its place first in the `"auto"` order, and `toolForFormat("bun-check")`.

### US-006: Rules lint warns about package paths that match no package
No dependencies. Workdir: packages/nax.

Passes the workspace packages into `lintRulesForRoot`, adds the `PATHS_MATCH_NO_PACKAGE` warning, and updates
`docs/guides/static-rules.md`.

### US-007: Package profiles reach the runtime package registry
No dependencies. Workdir: packages/nax.

Adds `src/config/package-profile.ts` (`loadPackageProfileLayers`), moves `resolveProfileEnvVars` to `profile.ts`,
makes `loadConfigForWorkdir` use the new module, and makes `loadPackageOverride` return the overlay merged with the
package profile layers.

### US-008: Coverage gate under the nax sandbox
No dependencies. Workdir: packages/repo-tooling.

Adds `scripts/coverage-gate-mode.ts` (`coverageGateMode`, `coverageExitCode`, `finishCoverage`,
`SANDBOXED_COVERAGE_NOTE`) and has `check-coverage.ts` `main` end with `finishCoverage`.

### US-009: Gate output tail in the typecheck and lint sentinels
No dependencies. Workdir: packages/nax.

Adds `src/operations/gate-output-tail.ts` (`GATE_OUTPUT_TAIL_LINES`, `GATE_OUTPUT_TAIL_LINE_CHARS`, `gateOutputTail`)
and appends its tail to the sentinel findings of `typecheckCheckOp` and `lintCheckOp`.

### Context Files

**US-001**
- `packages/nax-agent/src/sandbox/policy-builder.ts` — `buildSandboxPolicy` network block
- `packages/nax-agent/src/sandbox/registry.ts` — `sandboxBackendFor`, `_sandboxRegistryDeps`, `_resetSandboxRegistryForTests`
- `packages/nax-agent/src/sandbox/session-sandbox.ts` — `sessionSandboxFrom`
- `packages/nax-agent/src/sandbox/types.ts` — `SessionSandbox`, `SandboxNetworkPolicy`
- `packages/nax-agent/test/unit/sandbox/registry.test.ts` — the `createBackend` stub pattern

**US-002**
- `packages/nax-agent-acp/src/client/edit-targets.ts` — `firstOutsidePolicy`, `canonical`, `canonicalPolicyPath`
- `packages/nax-agent-acp/src/client/permissions.ts` — `PermissionContext`, `decideFull`
- `packages/nax-agent-acp/src/client/backend.ts` — `routerFor`
- `packages/nax-agent-acp/test/unit/client/backend-codex.test.ts` — `withSandbox`, `policyFor`, `EDIT` and the `claude` branch of `open()`
- `packages/nax-agent-acp/test/unit/client/edit-targets.test.ts` — temp-dir fixtures for policy paths

**US-003**
- `packages/nax/src/agents/coding-tool-support-resolve.ts` — `resolveCodingToolSupport`, the `acpSandbox` line
- `packages/nax/src/operations/call-run-options.ts` — `buildRunDispatchOptions`, `codingToolFileOutput`
- `packages/nax/src/cli/config-descriptions.ts` — `FIELD_DESCRIPTIONS`
- `packages/nax/test/unit/agents/coding-tool-support-acp-sandbox.test.ts` — fake backend and launcher setup

**US-004**
- `packages/nax/src/prd/modifies-extract.ts` — `MAX_MODIFIED_FILES`, `extractSpecModifiedFiles`
- `packages/nax/src/prd/markdown-scan.ts` — `extractGroupedPathSection`
- `packages/nax/src/prd/spec-lint.ts` — `checkModifies`, `BLOCKING_SPEC_LINT_CODES`
- `packages/nax/src/plan/spec-lint-gate.ts` — `assertSpecLintClean`
- `packages/nax/src/prd/modifies.ts` — `applyModifiedFiles`

**US-005**
- `packages/nax/src/review/typecheck-parsing/parse.ts` — `strategiesFor`, `toolForFormat`, `parseTypecheckOutput`
- `packages/nax/src/review/typecheck-parsing/strategies/tsc.ts` — strategy shape to mirror
- `packages/nax/src/operations/typecheck-check.ts` — calls `parseTypecheckOutput` (integration AC entry)
- `packages/nax/test/unit/review/typecheck-parsing/parse.test.ts` — existing parse cases

**US-006**
- `packages/nax/src/cli/rules-lint.ts` — `rulesLintCommand`, `lintRulesForRoot`
- `packages/nax/src/context/engine/scope-path-match/index.ts` — `ruleMatchesPackage`
- `packages/nax/test/unit/cli/rules-lint.test.ts` — `stubInertScopingDeps`, `makeRule` and the logger capture are file-local (the file is 783/800 lines); the new file redefines what it needs
- `docs/guides/static-rules.md` — "When to use `paths:` (monorepo)"

**US-007**
- `packages/nax/src/config/loader.ts` — `loadPackageOverride`, `loadConfigForWorkdir`
- `packages/nax/src/config/profile.ts` — `loadProfile`, `loadProfileEnv`; receives `resolveProfileEnvVars`
- `packages/nax/src/runtime/packages.ts` — `createPackageRegistry`, `hydrate`
- `packages/nax/src/operations/lint-check.ts` — `lintCheckOp` reads the `PackageView`
- `packages/nax/test/unit/config/load-package-override.test.ts` — fixture layout

**US-009**
- `packages/nax/src/operations/typecheck-check.ts` — the typecheck sentinel
- `packages/nax/src/operations/lint-check.ts` — the lint sentinel
- `packages/nax/test/unit/operations/typecheck-check.test.ts` — `makeDeps`, `ctxWithQuality`, `failedResult`
- `packages/nax/test/unit/operations/lint-check.test.ts` — the lint sentinel cases

**US-008**
- `packages/repo-tooling/scripts/check-coverage.ts` — `main`, `checkPerFile`, `checkUnreported`, `aggregateFailures`
- `packages/repo-tooling/test/unit/scripts/check-coverage.test.ts` — test layout to mirror

### Creates

**US-001**
- `packages/nax-agent/src/sandbox/network.ts`
- `packages/nax-agent/test/unit/sandbox/network.test.ts`

**US-005**
- `packages/nax/src/review/typecheck-parsing/strategies/bun-check.ts`
- `packages/nax/test/unit/review/typecheck-parsing/strategies/bun-check.test.ts`

**US-009**
- `packages/nax/src/operations/gate-output-tail.ts`
- `packages/nax/test/unit/operations/gate-output-tail.test.ts`

**US-006**
- `packages/nax/test/unit/cli/rules-lint-package-paths.test.ts`

**US-007**
- `packages/nax/src/config/package-profile.ts`
- `packages/nax/test/unit/config/package-profile.test.ts`
- `packages/nax/test/integration/runtime/package-profile-registry.test.ts`

**US-008**
- `packages/repo-tooling/scripts/coverage-gate-mode.ts`
- `packages/repo-tooling/test/unit/scripts/coverage-gate-mode.test.ts`

### Modifies

**US-001**
- `packages/nax-agent/test/unit/sandbox/registry.test.ts` — gains the `sandboxBackendFor` network cases; the existing one-backend-per-process and probe-cache cases are unchanged.
- `packages/nax-agent/test/unit/sandbox/session-sandbox.test.ts` — gains the `sessionSandboxFrom` `writeExemption` cases; the existing two-argument cases are unchanged.
- `packages/nax-agent/src/config/schemas-sandbox.ts` — the `allowLocalBinding` doc comment says "Off when absent"; it becomes "absent: on when `allowedDomains` is set (see `effectiveAllowLocalBinding`), off otherwise". Comment only.
- `packages/nax-agent/src/sandbox/types.ts` — the `SandboxNetworkPolicy.allowLocalBinding` doc comment gains that the config default is resolved by `effectiveAllowLocalBinding` before the policy is built. Comment only.
- `packages/nax-agent/test/unit/sandbox/policy-builder.test.ts` — the case asserting `buildSandboxPolicy` with `network: { allowedDomains: ["registry.npmjs.org"] }` returns network `{ allowedDomains: ["registry.npmjs.org"] }` now returns `{ allowedDomains: ["registry.npmjs.org"], allowLocalBinding: true }`. Every other policy field assertion is unchanged.

**US-002**
- `packages/nax-agent-acp/test/unit/client/edit-targets.test.ts` — gains the `firstOutsidePolicy` exemption cases; the existing three-argument cases are unchanged.
- `packages/nax-agent-acp/test/unit/client/permissions.test.ts` — gains the `decidePermission` exemption cases; existing cases are unchanged.
- `packages/nax-agent-acp/test/unit/client/backend-codex.test.ts` — gains the two `acpBackend` claude write-exemption cases beside its claude sandbox cases; existing cases are unchanged.

**US-003**
- `packages/nax/test/unit/agents/coding-tool-support-acp-sandbox.test.ts` — gains the `writeExemption` cases; the existing policy, disabled and reviewer cases are unchanged.
- `packages/nax/src/cli/config-descriptions.ts` — the `execution.sandbox.network.allowLocalBinding` description says "off when absent", which the new default makes false; it becomes the target text in Integration.
- `docs/guides/permissions.md` — the sentence "`allowLocalBinding: true` permits local binding" gains that loopback defaults on when `allowedDomains` is set and `false` keeps it closed.

**US-004**
- `packages/nax/test/unit/prd/modifies.test.ts` — "caps runaway sections at MAX_MODIFIED_FILES" puts `MAX_MODIFIED_FILES + 10` entries under one story and expects `MAX_MODIFIED_FILES`; with the per-story cap one story keeps `MAX_MODIFIED_FILES_PER_STORY`. The invariant becomes: one story keeps at most 40 entries, and the spec at most 200. The file also gains the per-story extraction, `findModifiesOverflow` and `applyModifiedFiles` cap cases.
- `packages/nax/test/unit/prd/spec-lint.test.ts` — "warns when the Modifies section hits the entry cap" expects `modifies-at-cap` for 25 entries; that code is removed. It becomes a case where one story's 41 entries yield `modifies-story-over-cap`. The file also gains the other cap cases.
- `packages/nax/test/unit/plan/spec-lint-gate.test.ts` — gains the `assertSpecLintClean` overflow case; existing cases are unchanged.
- `packages/nax/src/prd/index.ts` — the barrel gains `MAX_MODIFIED_FILES_PER_STORY`, `findModifiesOverflow` and the `ModifiesStoryOverflow` type beside the existing `extractSpecModifiedFiles, MAX_MODIFIED_FILES` export.

**US-006**
- `docs/guides/static-rules.md` — "When to use `paths:` (monorepo)" gains that `paths` matches package directories only, with a file glob shown moved into `appliesTo`.

**US-007**
- `packages/nax/src/config/profile.ts` — receives `resolveProfileEnvVars` from the loader module, exported, unchanged in behaviour.
- `packages/nax/src/config/loader.ts` — the package-profile loop in `loadConfigForWorkdir` moves to `loadPackageProfileLayers`, and `loadPackageOverride`'s doc comment ("package profiles are resolved by loadConfigForWorkdir, not by the runtime registry") is no longer true; it is rewritten to the target behaviour.

**US-008**
- `packages/repo-tooling/test/unit/scripts/check-coverage.test.ts` — gains the `evaluateCoverageGate` cases; existing cases are unchanged.

### Seams

- US-001 → US-002: `SessionSandbox.writeExemption` (US-001) is read by `routerFor` (US-002). US-002's seam AC enters at `acpBackend`.
- US-001 → US-003: `sessionSandboxFrom`'s third parameter (US-001) is passed by `resolveCodingToolSupport` (US-003). US-003's seam AC enters at `resolveCodingToolSupport` with the options `buildRunDispatchOptions` builds.
- US-004: `findModifiesOverflow` is created and consumed (by `checkModifies`) in the same story; its seam AC enters at `assertSpecLintClean`.
- US-005: `bunCheckStrategy` is created and consumed (by `parseTypecheckOutput`) in the same story; its seam AC enters at `typecheckCheckOp.execute`.
- US-009: `gateOutputTail` is created and consumed in the same story; its seam ACs enter at `typecheckCheckOp.execute` and `lintCheckOp.execute`.
- US-007: `loadPackageProfileLayers` is created and consumed in the same story; seam ACs enter at `createPackageRegistry().hydrate` and `lintCheckOp.execute`.

## Acceptance Criteria

### US-001

- [unit] `effectiveAllowLocalBinding({ allowedDomains: ["x.test"] })` returns `true`.
- [unit] `effectiveAllowLocalBinding({ allowedDomains: [] })` returns `true`.
- [unit] `effectiveAllowLocalBinding({ allowedDomains: ["x.test"], allowLocalBinding: false })` returns `false`.
- [unit] `effectiveAllowLocalBinding({})` returns `false`.
- [unit] `effectiveAllowLocalBinding({ allowLocalBinding: true })` returns `true`.
- [unit] `buildSandboxPolicy` with config network `{ allowedDomains: ["registry.npmjs.org"] }` returns a `network` equal to `{ allowedDomains: ["registry.npmjs.org"], allowLocalBinding: true }`.
- [unit] `buildSandboxPolicy` with config network `{ allowedDomains: ["x.test"], allowLocalBinding: false }` returns a `network` equal to `{ allowedDomains: ["x.test"] }`.
- [unit] `buildSandboxPolicy` with the default sandbox config returns a `network` with no `allowLocalBinding` key.
- [unit] `sandboxBackendFor` with a sandbox config whose network is `{ allowedDomains: ["x.test"] }` calls `_sandboxRegistryDeps.createBackend` with `{ allowedDomains: ["x.test"], allowLocalBinding: true }`.
- [unit] `sandboxBackendFor` with a sandbox config whose network is `{ allowedDomains: ["x.test"], allowLocalBinding: false }` calls `_sandboxRegistryDeps.createBackend` with `{ allowedDomains: ["x.test"], allowLocalBinding: false }`.
- [unit] `sandboxBackendFor` with the default sandbox config calls `_sandboxRegistryDeps.createBackend` with a network whose `allowLocalBinding` is `false`.
- [unit] `createSrtBackend({ allowedDomains: ["x.test"] })`, on its first `wrap`, calls srt's `initialize` with a network that has no `allowLocalBinding` key.
- [unit] `sessionSandboxFrom(launcher, "/repo", "/repo/.nax/features/f/workflow/r/US-001/report.md")` with an available launcher returns `{ kind: "policy", policy, writeExemption: "/repo/.nax/features/f/workflow/r/US-001/report.md" }`, where `policy` is the launcher's `policyAt("/repo")`.
- [unit] `sessionSandboxFrom(launcher, "/repo", "out/report.md")` with an available launcher returns `writeExemption` equal to `/repo/out/report.md`.
- [unit] `sessionSandboxFrom(launcher, "/repo")` with an available launcher returns an object with no `writeExemption` key.
- [unit] `sessionSandboxFrom(launcher, "/repo", "/repo/report.md")` with an unavailable launcher returns `{ kind: "unavailable", reason }` with no `writeExemption` key.

### US-002

- [unit] `firstOutsidePolicy([report], policy, root, report)`, where `policy.writeRoots` is `[root]`, `policy.denyWrite` is `[<root>/.nax/features]` and `report` is `<root>/.nax/features/f/workflow/r/US-005/report.md`, returns `undefined`.
- [unit] `firstOutsidePolicy([brief], policy, root, report)` with the same policy, where `brief` is `<root>/.nax/features/f/workflow/r/US-005/brief.md`, returns `brief`.
- [unit] `firstOutsidePolicy([other], policy, root, report)` with the same policy, where `other` is `<root>/.nax/features/f/workflow/r/US-004/report.md`, returns `other`.
- [unit] `firstOutsidePolicy([prd], policy, root, report)` with the same policy, where `prd` is `<root>/.nax/features/f/prd.json`, returns `prd`.
- [unit] `firstOutsidePolicy([report], policy, root)` with the same policy and no exemption returns `report`.
- [unit] `firstOutsidePolicy([".nax/features/f/workflow/r/US-005/report.md"], policy, root, report)` with the same policy returns `undefined`.
- [unit] `firstOutsidePolicy([outside], policy, root, outside)`, where `outside` is a file under a temp dir that is not in `policy.writeRoots`, returns `outside`.
- [unit] `firstOutsidePolicy([upper], policy, root, report)`, where `upper` is `<root>/.nax/features/f/workflow/r/US-005/REPORT.md`, returns `upper`.
- [unit] `firstOutsidePolicy([dotted], policy, root, report)`, where `dotted` is `<root>/.nax/features/f/workflow/r/US-004/../US-005/report.md`, returns `dotted`.
- [unit] `decidePermission` with profile `full`, a `sandbox` equal to that policy, `writeExemption` equal to `report` and an edit tool call targeting `report` answers with the request's allow-once option.
- [unit] `decidePermission` with profile `full`, the same `sandbox`, no `writeExemption` and an edit tool call targeting `report` answers with the reject option and records the reason `OUTSIDE_WRITE_ROOTS_REASON`.
- [unit] `decidePermission` with profile `full`, the same `sandbox`, `writeExemption` equal to `report` and an edit tool call targeting `brief` answers with the reject option.
- [integration] `acpBackend` for `claude`, opened with an open context whose `sandbox` is `{ kind: "policy", policy, writeExemption: report }` and profile `full`, answers the in-memory fake agent's `session/request_permission` for an edit of `report` with the allow-once option.
- [integration] `acpBackend` for `claude`, opened the same way with no `writeExemption`, answers the fake agent's `session/request_permission` for an edit of `report` with the reject option.

### US-003

- [unit] `resolveCodingToolSupport` with an available sandbox backend, `declaredTools` `["Read", "Bash"]`, `codingToolRoot` `<tmp>` and `codingToolFileOutput` `<tmp>/.nax/features/f/workflow/r/US-001/report.md` returns `acpSandbox` with `kind` `"policy"` and `writeExemption` equal to `<tmp>/.nax/features/f/workflow/r/US-001/report.md`.
- [unit] `resolveCodingToolSupport` with an available sandbox backend, `declaredTools` `["Read", "Bash"]` and no `codingToolFileOutput` returns `acpSandbox` with no `writeExemption` key.
- [unit] `resolveCodingToolSupport` with the sandbox disabled and `codingToolFileOutput` set returns no `acpSandbox`.
- [integration] `resolveCodingToolSupport`, with an available sandbox backend, `declaredTools` `["Read", "Bash"]`, and the `codingToolRoot` and `codingToolFileOutput` that `buildRunDispatchOptions` produces for `workflowImplementOp` with `reportPath` `<tmp>/.nax/features/f/workflow/r/US-001/report.md`, returns `acpSandbox.writeExemption` equal to that `reportPath`.
- [unit] `FIELD_DESCRIPTIONS["execution.sandbox.network.allowLocalBinding"]` equals `Allow sandboxed commands to reach loopback ports. Defaults on when allowedDomains is set; set false to keep loopback closed`.

### US-004

- [unit] `MAX_MODIFIED_FILES_PER_STORY` is importable from `@/prd` and equals `40`.
- [unit] `MAX_MODIFIED_FILES` equals `200`.
- [unit] `extractSpecModifiedFiles` for a spec whose stories US-001 to US-005 declare 8, 7, 7, 17 and 30 entries returns 69 entries.
- [unit] In that result, the entries attributed to `US-005` number 30.
- [unit] `extractSpecModifiedFiles` for a spec whose US-001 declares 45 entries returns 40 entries.
- [unit] `extractSpecModifiedFiles` for a spec whose US-001 and US-002 each declare 45 entries returns 40 entries for each story.
- [unit] `extractSpecModifiedFiles` for a spec whose six stories each declare 40 entries returns 200 entries, the first 200 in document order.
- [unit] `findModifiesOverflow` for a spec whose US-005 declares 45 entries returns `stories` equal to `[{ storyId: "US-005", count: 45, dropped: <the 41st to 45th paths> }]`.
- [unit] `findModifiesOverflow` for a spec whose five stories declare 69 entries in all, none over 40, returns `stories` equal to `[]`.
- [unit] `findModifiesOverflow` for a spec with 41 entries above any `**US-00N**` lead-in returns one entry whose `storyId` is `null` and `count` is `41`.
- [unit] `findModifiesOverflow` for a spec whose US-001 lists one path 41 times returns one entry for `US-001` with `count` `41`.
- [unit] `lintSpecContent` for a spec whose US-005 declares 45 Modifies entries returns a finding with level `error` and code `modifies-story-over-cap`.
- [unit] That finding's message names every one of the 41st to 45th paths.
- [unit] `lintSpecContent` for a spec declaring 205 Modifies entries over six stories, none over 40, returns a finding with level `error` and code `modifies-over-cap`.
- [unit] That finding's message contains `205`.
- [unit] `lintSpecContent` for a spec declaring 69 entries, none over 40 per story, returns no finding whose code starts with `modifies-` and ends with `-cap`.
- [unit] `BLOCKING_SPEC_LINT_CODES` contains `modifies-story-over-cap`.
- [unit] `BLOCKING_SPEC_LINT_CODES` contains `modifies-over-cap`.
- [integration] `assertSpecLintClean`, with a temp workdir in which all 45 declared paths exist as files, for a spec whose US-005 declares those 45 Modifies entries throws a `NaxError` with code `PLAN_SPEC_LINT_FAILED`.
- [integration] That error's message contains `modifies-story-over-cap`.
- [integration] `applyModifiedFiles` for a PRD with stories US-001 to US-005 and the 69-entry spec returns US-005 with 30 `modifiedFiles`.

### US-005

- [unit] `parseTypecheckOutput` of `BUN_CHECK_SAMPLE` (the fenced fixture in Design 4) with format `"auto"` and workdir `/repo` returns format `"bun-check"`.
- [unit] That result holds one diagnostic with file `test/unit/forge-tools/log-tool.test.ts`, line `90`, column `86` and code `2769`.
- [unit] That diagnostic's message is `No overload matches this call.`.
- [unit] That diagnostic's `raw` starts with `<error file=` and ends with `</error>`.
- [unit] `bunCheckStrategy.parse` of two `<error>` blocks returns two diagnostics in document order.
- [unit] `bunCheckStrategy.parse` of a block whose attributes appear as `code`, `column`, `line`, `file` returns the same file, line, column and code as the ordered form.
- [unit] `bunCheckStrategy.parse` of output holding only a `<warning …>…</warning>` block returns `null`.
- [unit] `bunCheckStrategy.parse` of an `<error>` block with no `file` attribute returns `null`.
- [unit] `bunCheckStrategy.parse` of an `<error>` block with no `line` attribute returns `null`.
- [unit] `bunCheckStrategy.parse` of `BUN_CHECK_SAMPLE` with its `</error>` line removed returns one diagnostic with message `No overload matches this call.`.
- [unit] `parseTypecheckOutput` of `BUN_CHECK_SAMPLE` with format `"auto"` and workdir `/repo` returns a finding whose tool is `bun check`.
- [unit] That finding's `rule` is `TS2769`.
- [unit] `bunCheckStrategy.parse` of a block whose opening tag line ends `code="TS2322">Type 'string' is not assignable to type 'number'.` returns that text as the message.
- [unit] `bunCheckStrategy.parse` of two consecutive `<error>` blocks with no `</error>` lines returns two diagnostics, the first one's `raw` ending before the second `<error ` line.
- [integration] `typecheckCheckOp.execute`, with the real `parseTypecheckOutput` and a typecheck command that fails with the `bun check` sample, returns one finding whose file names `test/unit/forge-tools/log-tool.test.ts` and whose line is `90`.

### US-006

- [unit] `rulesLintCommand`, with workspace packages `["apps/api"]` and a rule whose `paths` is `["apps/api/src/**/*"]`, logs a `rules-lint` warning whose data `code` is `PATHS_MATCH_NO_PACKAGE`.
- [unit] That warning's data `pattern` is `apps/api/src/**/*`, and its `file` names the rule file.
- [unit] That warning's message contains `appliesTo:`.
- [unit] `rulesLintCommand`, with workspace packages `["apps/api"]` and a rule whose `paths` is `["apps/api/*"]`, logs no `PATHS_MATCH_NO_PACKAGE` warning.
- [unit] `rulesLintCommand`, with workspace packages `["apps/api"]` and a rule whose `paths` is `["apps/api/**"]`, logs no `PATHS_MATCH_NO_PACKAGE` warning.
- [unit] `rulesLintCommand`, with workspace packages `["packages/core"]` and a rule whose `paths` is `["packages/core/src/x/*", "packages/core/tests/unit/x/*"]`, logs two `PATHS_MATCH_NO_PACKAGE` warnings.
- [unit] `rulesLintCommand`, with workspace packages `["apps/api"]` and a rule whose `paths` is `["apps/api/*", "apps/api/src/**/*"]`, logs one `PATHS_MATCH_NO_PACKAGE` warning, with `pattern` `apps/api/src/**/*`.
- [unit] `rulesLintCommand`, with workspace packages `[]` and a rule whose `paths` is `["apps/api/src/**/*"]`, logs no `PATHS_MATCH_NO_PACKAGE` warning.
- [unit] `rulesLintCommand`, with a rejecting `discoverWorkspacePackages` and a rule whose `paths` is `["apps/api/src/**/*"]`, logs no `PATHS_MATCH_NO_PACKAGE` warning.
- [unit] `rulesLintCommand`, with workspace packages `["apps/api"]` and one rule whose `paths` is `["apps/api/src/**/*"]` and no other warnings, prints the stdout summary `[WARN] Canonical rules lint completed with 1 warning(s)`.
- [unit] In that run, `process.exitCode` stays `undefined` or `0`.

### US-007

- [unit] `loadPackageOverride(repo, "packages/api")`, where `.nax/mono/packages/api/config.json` is `{ "profile": "package-checks" }` and `packages/api/.nax/profiles/package-checks.json` sets `quality.commands.lint` to `"false"`, returns an override whose `quality.commands.lint` is `"false"`.
- [unit] That override has no `profile` key.
- [unit] `loadPackageOverride`, where the package config is `{ "profile": "package-checks", "quality": { "commands": { "lint": "x" } } }`, returns `quality.commands.lint` equal to `"false"`.
- [unit] `loadPackageOverride`, where the package config's `profile` is `"a,b"`, profile `a` sets `quality.commands.lint` to `"a"` and profile `b` sets it to `"b"`, returns `quality.commands.lint` equal to `"b"`.
- [unit] `loadPackageOverride`, where the package config is `{ "profile": "default", "quality": { "commands": { "lint": "x" } } }`, returns `quality.commands.lint` equal to `"x"`.
- [unit] `loadPackageOverride`, where the package config's `profile` names a profile file that does not exist, rejects with a `NaxError` whose code is `PROFILE_NOT_FOUND`.
- [unit] `loadPackageProfileLayers` for profile `"a,b"` returns `chain` equal to `["a", "b"]` and two layers in that order.
- [unit] `loadPackageProfileLayers` for an absent profile returns `chain` equal to `[]` and no layers.
- [integration] `createPackageRegistry(createConfigLoader(rootConfig), repo).hydrate(["packages/api"])`, with the root config's `quality.commands.lint` `"true"` and the package profile setting it to `"false"`, makes `resolve("packages/api").config.quality.commands.lint` equal `"false"`.
- [integration] `lintCheckOp.execute`, run on that `PackageView` with the real command runner, returns `success` `false`.
- [integration] `createPackageRegistry(...).hydrate(["packages/web"])` for a package with no mono config makes `resolve("packages/web").config.quality.commands.lint` equal the root's `"true"`.
- [integration] `loadConfigForWorkdir(<repo>/.nax/config.json, "packages/api")` returns `quality.commands.lint` equal to `"false"`.
- [integration] That config's `profileChain` equals `["package-checks"]`.
- [integration] `createPackageRegistry(...).hydrate(["packages/api"])`, where the package profile names a missing profile file, rejects with a `NaxError` whose code is `PROFILE_NOT_FOUND`.
- [integration] `resolveGateCommands(repo, ["packages/api"])`, with the real `loadPackageOverride`, a root config that declares no `quality.commands.lint`, and the package profile setting `quality.commands.lint` to `"false"`, returns a gate keyed `lint@packages/api` whose command is `false`.
- [integration] `createPackageRegistry(...).hydrate(["packages/api"])`, where the package profile also sets `execution.sandbox.enabled` to the opposite of the root's value, makes `resolve("packages/api").config.execution.sandbox.enabled` equal the root's value.

### US-008

- [unit] `coverageGateMode({ NAX_SANDBOXED: "1" })` returns `"sandboxed"`.
- [unit] `coverageGateMode({})` returns `"enforce"`.
- [unit] `coverageGateMode({ NAX_SANDBOXED: "0" })` returns `"enforce"`.
- [unit] `coverageGateMode({ NAX_SANDBOXED: "true" })` returns `"enforce"`.
- [unit] `coverageExitCode({ aggregateFailures: [], perFileOk: false, allFilesOk: true, mode: "sandboxed" })` returns `0`.
- [unit] `coverageExitCode({ aggregateFailures: [], perFileOk: true, allFilesOk: false, mode: "sandboxed" })` returns `0`.
- [unit] `coverageExitCode({ aggregateFailures: ["lines 79.00% < 80.00%"], perFileOk: true, allFilesOk: true, mode: "sandboxed" })` returns `1`.
- [unit] `coverageExitCode({ aggregateFailures: [], perFileOk: false, allFilesOk: true, mode: "enforce" })` returns `1`.
- [unit] `coverageExitCode({ aggregateFailures: [], perFileOk: true, allFilesOk: false, mode: "enforce" })` returns `1`.
- [unit] `coverageExitCode({ aggregateFailures: [], perFileOk: true, allFilesOk: true, mode: "enforce" })` returns `0`.
- [unit] `SANDBOXED_COVERAGE_NOTE` equals `[coverage] sandboxed run (NAX_SANDBOXED=1): per-file floors not enforced (CI enforces them)`.
- [unit] `finishCoverage` with `env` `{ NAX_SANDBOXED: "1" }`, no aggregate failures and `perFileOk` false returns `0`.
- [unit] In that call, `log` receives `SANDBOXED_COVERAGE_NOTE` and `[coverage] OK (sandboxed) — aggregate at or above floor; per-file results above are report-only.`.
- [unit] `finishCoverage` with `env` `{}`, no aggregate failures and `perFileOk` false returns `1`.
- [unit] In that call, `log` never receives `SANDBOXED_COVERAGE_NOTE`.
- [unit] `finishCoverage` with `env` `{ NAX_SANDBOXED: "1" }` and `aggregateFailures` `["lines 79.00% < 80.00%"]` returns `1`.
- [unit] In that call, `error` receives a line starting `[coverage] FAIL — ` that contains `lines 79.00% < 80.00%`.
- [unit] `finishCoverage` with `env` `{}` and every check passing returns `0`, and `log` receives `[coverage] OK — at or above floor.`.
- [integration] `evaluateCoverageGate` with totals above both floors, a `perFile` map holding one file not in the per-file baseline at 10%, no unreported files and `env` `{ NAX_SANDBOXED: "1" }` returns `0`.
- [integration] `evaluateCoverageGate` with the same inputs and `env` `{}` returns `1`.

### US-009

- [unit] `gateOutputTail` of 60 lines `line 1` to `line 60` returns 40 lines, `line 21` to `line 60`.
- [unit] `gateOutputTail` of output containing `ghp_` followed by 36 alphanumeric characters returns text without that token.
- [unit] `gateOutputTail("  \n\n")` returns `""`.
- [unit] `gateOutputTail` of one line of 800 `x` characters returns 500 `x` characters followed by `…`.
- [unit] `typecheckCheckOp.execute`, with a declared typecheck command that fails with the 60-line output and a `parseTypecheckOutput` stub returning `null`, returns one finding whose message contains `Output (last 40 lines):` and `line 60`.
- [unit] That finding's message omits `line 20`.
- [unit] That finding's message still contains `RunCommand {"command": "typecheck"}`.
- [unit] `typecheckCheckOp.execute`, with a declared command that fails with blank output and a `parseTypecheckOutput` stub returning `null`, returns one finding whose message omits `Output (last`.
- [unit] `lintCheckOp.execute`, with a declared lint command that fails with the 60-line output and no parsed findings, returns one finding whose message contains `Output (last 40 lines):` and `line 60`.
- [unit] That finding's message omits `line 20`.
- [unit] `lintCheckOp.execute`, with a declared lint command that fails with blank output and no parsed findings, returns one finding whose message omits `Output (last`.
