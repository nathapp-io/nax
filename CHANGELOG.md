# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).


## [0.51.2] — 2026-03-22

### Added  
- **features:** Remove plan.md and tasks.md from scaffold, enhancing the spec.md template  

### Fixed  
- **test:** Update .nax/packages/ to .nax/mono/ in test fixtures for consistency  
- **plan:** Add no-test and noTestJustification to plan/decompose prompts  

### Changed  
- **monorepo:** Rename .nax/packages/ to .nax/mono/ and clean up documentation


## [0.51.0] - 2026-03-21

### Added

- **`no-test` strategy** — New test strategy for stories with zero behavioral change (config, docs, CI/build files, dependency bumps, pure refactors). Requires `noTestJustification` field at every assignment point (plan prompt, LLM routing, batch routing) to prevent lazy test-skipping. `no-test` stories use an implement-only prompt (no RED/GREEN/REFACTOR), are exempt from greenfield override and test-after escalation, and batch separately from tested stories.
- **Rename `nax/` → `.nax/`** — Project-level config directory now uses hidden dot-prefix convention (like `.git/`, `.claude/`). `PROJECT_NAX_DIR = ".nax"` SSOT constant in `src/config/paths.ts`. Package configs moved from `<pkg>/nax/config.json` to `.nax/packages/<pkg>/config.json`. 93 files updated.
- **Acceptance fix story quality** — Fix stories now include acceptance test file path, truncated failure output, and "fix implementation not tests" instruction. Batched by related stories (cap 8) instead of 1-per-AC. Fix stories inherit `workdir` from related story. `>80%` AC failure triggers test regeneration instead of fix stories.
- **Acceptance staleness detection** — SHA-256 fingerprint of AC set stored in `acceptance-meta.json`. Acceptance test auto-regenerates (with `.bak` backup) when stories are added/removed/modified.

### Fixed

- **fix(acceptance):** Correct `__dirname` depth in generator prompt — test file is exactly 3 `../` levels from root, not 4.
- **fix(acceptance):** Acceptance tests always run from repo root — covers both single repo and monorepo. Test uses `__dirname`-based paths into packages.
- **fix(acceptance):** Fix stories use per-package config for review/verify stages when `story.workdir` is set.
- **fix(review):** Fallback to `quality.commands` when `review.commands` not configured — prevents routing failures in monorepo packages.
- **fix(review):** Use optional chaining for `quality?.commands` — avoids crash when config has no quality section.
- **fix(pkg):** Remove `src/` and `bin/` from npm `files` — only `dist/` published. 354 files / 4.7MB → 5 files / 3.1MB.

### Refactored

- **refactor(test):** Add `withDepsRestore` helper in `test/helpers/deps.ts` — eliminates save/restore boilerplate across 13 test files (−98 net lines).

### Migration

- Rename your project's `nax/` directory to `.nax/`
- For monorepo: move `<pkg>/nax/config.json` → `.nax/packages/<pkg>/config.json`
- Update `.gitignore` patterns: `nax/**/runs/` → `.nax/**/runs/`, etc.

---


## [0.50.3] — 2026-03-21

### Fixed
- **acceptance:** Add missing log on stub regeneration failure.
- **acceptance:** Enhance stub detection with a 3-step language-agnostic prompt.
- **acceptance:** Introduce configurable timeout and framework-agnostic prompt hints.
- **acceptance:** Use configured agent and real codebase context.

### Changed
- **acceptance:** Remove `buildWorkdirFileTree`; agent now explores the project itself.


## [0.50.2] — 2026-03-20

### Changed
- **config:** Move testing to quality.testing for per-package support.


## [0.50.1] — 2026-03-20

### Added
- **prompts:** Enforce hermetic testing via testing config.

### Fixed
- **prd:** Promote decomposed parent to passed when all sub-stories are complete.
- **regression:** Derive rectification model tier from complexity instead of unpersisted model tier.
- **decompose:** Emit `story:decomposed` event and avoid wasting iterations on decomposition.
- **prd:** Preserve analysis and contextFiles fields during plan output validation.
- **precheck:** Allow collapsed nax/ directory entries in dirty-tree check.


## [0.50.0] - 2026-03-19

### Added

- **Context chaining** — Dependent stories automatically receive parent story's changed files as context. After a story passes, `outputFiles` are captured via `git diff storyGitRef..HEAD` (scoped to `story.workdir` in monorepos) and injected into dependent stories' context via `getParentOutputFiles()`.
- **Structured plan prompt** — `nax plan` now uses a 3-step prompt (understand → analyze → generate). Analysis stored in `prd.analysis` field and injected into all story contexts. `contextFiles` populated per-story by the plan LLM. Hard ban on analysis/test-only/validation stories.
- **Reconciliation review gate** — Reconciliation no longer blindly auto-passes stories that failed at review stage. Stores `failureStage` on failed stories; re-runs built-in review checks before reconciling `review`/`autofix` failures.
- **Monorepo workdir scoping** — Decomposed sub-stories now inherit `workdir` from parent. Agent rectification runs in `story.workdir` (not repo root) and prompt includes scope constraint for out-of-package prevention.
- `prd.analysis?: string` field — planning phase analysis available to all story contexts

### Fixed

- **fix:** `COMPLEXITY_GUIDE` and `TEST_STRATEGY_GUIDE` prompt constants had inverted mappings. Corrected: `simple→tdd-simple`, `medium→three-session-tdd-lite`, `expert→three-session-tdd`. `test-after` is explicit opt-out only, never auto-assigned.


## [0.49.6] — 2026-03-19

### Fixed
- **webhook:** Replace polling loop in `receive()` with event-driven Promise.
- **test:** Eliminate global mock contamination across test files.
- Use `Bun.readableStreamToText` for stdout in `getChangedFiles` and `getPgid`.
- Adjust `docker-compose.test.yml` to avoid YAML folding issues.
- Break circular import between prompts-tdd and prompts-main.
- Restore working pattern for `getChangedFiles`.
- Read git diff stdout concurrently with process exit in `getChangedFiles`.
- Standardize agent adapter session options.
- Resolve model aliases before passing to acpx and set model at session creation.
- Reuse ACP session across rectification attempts for context continuity.

### Other
- Revert changes to model alias resolution before passing to acpx.


## [0.49.3] - 2026-03-18

### Fixed
- **Autofix `recheckReview` bug:** `reviewStage.execute()` returns `action:"continue"` for both pass AND built-in-check-failure (to hand off to autofix). Using `result.action === "continue"` always returned `true`, causing "Mechanical autofix succeeded" to log every cycle and looping until `MAX_STAGE_RETRIES` with no real fix. Fix: check `ctx.reviewResult?.success` directly after execute.
- **Autofix selective mechanical fix:** `lintFix`/`formatFix` cannot fix typecheck errors. Phase 1 now only runs when the `lint` check actually failed. Typecheck-only failures skip straight to agent rectification (Phase 2).
- **Review command logging:** `runner.ts` now logs the resolved command and workdir for every check at info level, and full output on failure at warn level — eliminates phantom failure mystery.
- **Re-decompose on second run:** Batch-mode story selector was missing `"decomposed"` in its status skip list (single-story path already excluded it). Stories with `status: "decomposed"` were being picked up again, triggering unnecessary LLM decompose calls. Added `"decomposed"` to batch filter and a guard in routing SD-004 block.
- **totalCost always 0:** `handlePipelineFailure` returned no `costDelta`; `iteration-runner` hardcoded `costDelta: 0` for failures. Agent cost for failed stories was silently dropped. Fix: extract `agentResult?.estimatedCost` in failure path same as success path.


## [0.49.2] - 2026-03-18

### Fixed
- **Test strategy descriptions:** `TEST_STRATEGY_GUIDE` had incorrect descriptions for `three-session-tdd` and `three-session-tdd-lite`. Both use 3 sessions. Key distinction: `three-session-tdd` (strict) — test-writer makes no src/ changes; `three-session-tdd-lite` — test-writer may add minimal src/ stubs.

## [0.49.1] - 2026-03-18

### Fixed
- **ACP zero cost:** `acpx prompt` was called without `--format json`, causing it to output plain text instead of JSON-RPC NDJSON. Cost and token usage were always 0. Fix: pass `--format json` as a global flag so the parser receives `usage_update` (exact cost in USD) and `result.usage` (token breakdown).
- **Decompose session name / model:** Decompose one-shots used an auto-generated timestamp session name and passed the tier string (`"balanced"`) as the model instead of the resolved model ID. Fix: session name is now `nax-decompose-<story-id>` and model tier is resolved via `resolveModel()` before the `complete()` call.
- **`autoCommitIfDirty` skipping monorepo subdirs:** The working-directory guard rejected any workdir that wasn't exactly the git root, silently skipping commits for monorepo package subdirs. Fix: allow subdirs (`startsWith(gitRoot + '/')`); use `git add .` for subdirs vs `git add -A` at root.
- **`complete()` missing model in `generateFromPRD()` and `plan` auto mode:** `generator.ts` ignored `options.modelDef.model`; `plan.ts` auto path didn't call `resolveModel()`. Both now pass the correct resolved model to `adapter.complete()`.


## [0.49.0] — 2026-03-18

### Added
- **config:** Introduce per-package config override functionality.

### Fixed
- **acceptance:** Strip markdown fences from `generateFromPRD` output.
- **verify:** Ensure TEST_FAILURE hands off to rectification stage without escalation.
- **tdd:** Adjust greenfield-no-tests to escalate instead of pausing.
- **autofix:** Modify review to hand off to autofix stage instead of escalating.


## [0.48.4] — 2026-03-18

### Fixed
- Skip {{package}} template when no package.json is present.
- Sync runtime file allowlist with checks-git and handle monorepo paths.
- Substitute {{package}} in testScoped and bypass smart-runner for monorepo orchestrators.


## [0.48.3] — 2026-03-18

### Fixed
- Sweep ACP sessions on SIGINT/SIGTERM for crash recovery.
- Remove spurious ~/ entry from gitignore scaffold.
- Do not gitignore prd.json as it is a tracked spec file.
- Whitelist nax/features/*/prd.json as a runtime file.
- Respect config.generate.agents for root and per-package generation.


## [0.48.2] — 2026-03-18

### Fixed
- Add --cwd to session close command to prevent process leaks.


## [0.48.1] — 2026-03-18

### Fixed
- Auto-generate per-package CLAUDE.md when nax/context.md packages are discovered.
- Warn and fallback when generate.agents is misplaced under autoMode.


## [0.48.0] — 2026-03-18

### Added
- Add config.generate.agents to restrict which agents are generated.
- Add per-package tech stack scanning to planning prompt.

### Fixed
- Discover monorepo packages from workspace manifests when nax/context.md is missing.
- Replace hardcoded /tmp paths with unique per-run paths to prevent test collisions.
- Mock interaction bridge in plan-interactive tests to avoid real stdin prompts.

### Performance
- Reduce test suite time by approximately 31 seconds through targeted fixes.

### Changed
- Remove trivial type checks and low-value assertions from tests.
- Organize loose unit test files into subdirectories.
- Replace opaque identifiers with descriptive test names in tests.


## [0.47.0] — 2026-03-17

### Added
- Scope changed-file checks to story.workdir.
- Resolve per-package test command via loadConfigForWorkdir.
- Add loadConfigForWorkdir for monorepo package config resolution.
- Add mergePackageConfig utility for per-package quality.commands.
- Inject monorepo package list and workdir hint into planning prompt.
- Workdir-scoped test execution and smart-runner package prefix fix.
- Add --package flag to scaffold per-package nax/context.md.
- Add --package and --all-packages flags for monorepo CLAUDE.md generation.
- Load package-level nax/context.md for per-story workdir.
- Resolve story.workdir for per-story working directory override.
- Add UserStory.workdir field with schema validation.

### Fixed
- Restore review.commands.test fallback for legitimate config field.
- Throw error if story.workdir does not exist on disk.
- Downgrade test/lint/typecheck command checks to warning.

### Other
- Merge remote-tracking branch for monorepo workdir phase 1.


## [0.46.3] — 2026-03-17

### Fixed
- Change 'Integration-level' to 'Real-implementation'.


## [0.46.2] - 2026-03-17

### Fixed
- **Review rectification:** When lint or typecheck fails in the review stage and mechanical autofix (`lintFix`, `formatFix`) cannot resolve it, nax now spawns an agent rectification session with the exact error output as context. The agent fixes the issues, commits, and re-runs review to verify. Reuses `quality.autofix.maxAttempts` (default: 2) for agent attempts.

### Tests
- 12 new tests in `test/unit/pipeline/stages/autofix.test.ts` covering agent rectification paths.


## [0.46.1] - 2026-03-17

### Fixed
- **fix:** `working-tree-clean` precheck now allows 12 nax runtime files to be dirty without blocking. Includes fix for `--porcelain` trim bug that corrupted leading status chars.
- **fix:** `nax init` now adds complete gitignore entries for all nax runtime files (was missing: status.json, plan/, acp-sessions.json, interactions/, progress.txt, acceptance-refined.json, .nax-pids, .nax-wt/, ~/).
- **fix:** `checkGitignoreCoversNax` warning now checks 6 critical patterns (was only 3).
- **fix:** `acceptance-refined.json` now written to featureDir instead of workdir root.
- **fix:** HOME env is now validated before passing to spawned agents — if not an absolute path (e.g. unexpanded "~"), falls back to `os.homedir()` with a warning log. Prevents literal "~/" directory creation in repo.
- **fix:** New `checkHomeEnvValid()` precheck warning fires when HOME is unset or not absolute.

### Tests
- New tests in `test/unit/precheck/checks-git.test.ts` (188 lines) for working-tree-clean allowlist.
- New tests in `test/unit/agents/claude/execution.test.ts` (79 lines) for HOME sanitization.


## [0.46.0] - 2026-03-16

### Fixed
- **ACP cost metric:** Cost was always `$0` for ACP sessions. `parseAcpxJsonOutput` now handles JSON-RPC envelope format (acpx v0.3+): extracts text from `agent_message_chunk`, captures exact USD cost from `usage_update` (`cost.amount`), and reads camelCase token breakdown (`inputTokens`, `outputTokens`, `cachedReadTokens`, `cachedWriteTokens`) from `result.usage`.
- **ACP `complete()` cost:** Now logs exact cost via `getSafeLogger()` — previously had zero cost tracking.
- **`run()` cost:** Prefers exact `cost.amount` from acpx over token-based estimation; falls back to `estimateCostFromTokenUsage` when unavailable.

### Refactored
- **`src/agents/` folder restructure:** Each adapter now lives in its own subfolder for consistency.
  - `claude/` — Claude Code adapter (adapter, execution, complete, interactive, plan, cost)
  - `acp/` — ACP protocol adapter (unchanged internals)
  - `aider/`, `codex/`, `gemini/`, `opencode/` — per-adapter subfolders
  - `shared/` — cross-adapter utilities: `decompose` (extracted from both claude + acp), `model-resolution`, `validation`, `version-detection`, `types-extended`
- **Dead code removal:** `streamJsonRpcEvents` (exported but never called), stale `estimateCostFromTokenUsage` re-export from `acp/index.ts`.

### Docs
- **ARCHITECTURE.md §1:** Updated `src/agents/` tree.
- **ARCHITECTURE.md §16:** New section — agent adapter folder conventions, `shared/` rules, ACP cost alignment.


## [0.45.0] — 2026-03-16

### Added
- **execution:** Add debug logging for batch routing story count.
- **config:** Introduce a single source of truth for test strategy, including types, resolver, and prompt fragments.

### Fixed
- **execution:** Thread `agentGetFn` through the acceptance loop and parallel pipeline contexts.

### Changed
- **prd:** Utilize `resolveTestStrategy()` in `validatePlanOutput`.
- **prompts:** Replace inline strategy, complexity, and grouping text with shared imports.

---


## [0.44.0] — 2026-03-16

### Added
- **acp:** Implement session lifecycle features, including keep-on-fail, sweep, and rectification context.

### Fixed
- **precheck:** Restore `checkPRDValid` to its original position in the tier1 sequence.
- **cli:** Perform precheck before plan execution, guard against `prd.json` overwrite, and fix `nax status`.

---


## [0.43.1] — 2026-03-16

### Fixed
- **cli:** Initialize plan logger in the `nax run --plan` flow.

---


## [0.43.0] - 2026-03-16

### Added
- `src/config/permissions.ts` — `resolvePermissions(config, stage)` as the single source of truth for all permission decisions across CLI and ACP adapters.
- **New types:** `PermissionProfile` (`"unrestricted" | "safe" | "scoped"`), `PipelineStage`, `ResolvedPermissions` interface.
- **Schema:** `execution.permissionProfile` config field — takes precedence over legacy `dangerouslySkipPermissions` boolean. `"scoped"` is a Phase 2 stub.
- **`pipelineStage?`** added to `AgentRunOptions` — each call site sets the appropriate stage (`"plan"`, `"run"`, `"rectification"`, etc.).
- **`config?`** added to `CompleteOptions` — all `complete()` call sites now thread config so permissions are resolved correctly.

### Fixed
- **Hardcoded `--dangerously-skip-permissions`** in `claude-plan.ts` — now resolved from config.
- **`?? false` fallback** in `plan.ts` — removed; replaced with `resolvePermissions()`.
- **`?? true` fallback** in `claude-execution.ts` — removed; replaced with `resolvePermissions()`.
- **`resolvePermissions(undefined, ...)` in ACP `complete()`** — now passes `_options?.config`.
- All ACP adapter permission ternaries replaced with `resolvePermissions()`.

### Changed
- `nax/config.json` — explicit `"permissionProfile": "unrestricted"` (was implicit via schema default).


## [0.42.9] — 2026-03-16

### Added
- **plan:** Initialize logger for `nax plan`, writing logs to `nax/features/<feature>/plan-<timestamp>.jsonl`.

---


## [0.42.8] — 2026-03-16

### Added
- **plan:** Add permission, model, and session logging to `nax run --plan`.

### Fixed
- **plan:** Ensure `approve-all` is always used in interactive plan sessions.

---


## [0.42.7] — 2026-03-15

### Fixed
- Address code review fixes for critical issues.


## [0.42.6] — 2026-03-15

### Fixed
- Clean up ACP session with `PidRegistry`.

---


## [0.42.5] — 2026-03-15

### Fixed
- Add `workdir` to `CompleteOptions` and fix `cwd` in all adapters.
- Revert session creation to ensure compatibility, add `featureName` to plan, and guard `agentName`.

---


## [0.42.4] — 2026-03-15

_No user-facing changes._


## [0.42.3] — 2026-03-15

### Fixed
- Resolve model by tier in `plan`, remove `--format json`, and adjust file-based PRD output.

---


## [0.42.2] — 2026-03-15

### Added
- Delegate to Turbo/NX for monorepo support and detect pnpm/bun workspaces.

### Fixed
- Add `--cwd` to sessions to ensure proper handling in `createSession` and `loadSession`.
- Resolve model from config in `plan()` instead of using 'default'.
- Pass `dangerouslySkipPermissions` and `maxInteractionTurns` to `plan()`.
- Ensure one-shot uses CLI adapter while interactive uses protocol-aware adapter.
- Load config with project directory in run command.
- Unwrap result envelope in `complete()` for one-shot sessions.
- Use protocol-aware registry and pass config to `adapter.plan()`.

### Changed
- Consolidate `AgentConfig` by adding `maxInteractionTurns` and removing obsolete fields.

### Other
- Remove patch script.

---


## [0.42.1] — 2026-03-14

### Fixed
- Ensure tests fail on crash or syntax error instead of silently passing.
- Make `nax run --plan` always interactive; add `--one-shot` flag.
- Update `tdd-lite` alias to map to `three-session-tdd-lite`.
- Fix gaps in `plan-v2` regarding stdin bridge, interactive run, and test strategy names.
- Add timeout and rate-limit retry to `complete()` in ACP.

---


## [0.42.0] — 2026-03-14

### Added
- Deprecate `nax analyze` with a migration path to `nax plan`.
- Introduce CLI flag wiring for `nax plan` and `nax run --plan`.
- Implement interactive planning mode via ACP session.
- Rewrite `planCommand` to output `prd.json` using `--auto LLM` one-shot.
- Add PRD JSON validation and schema enforcement.
- Introduce `slow-tests.ts` script to identify slow tests from Bun JUnit XML output.

### Fixed
- Use `validatePlanOutput` from `schema.ts` in `plan-v2`, fix routing complexity extraction, and update test fixtures.
- Suppress false max-turns warning in non-interactive mode for ACP.
- Inject `_sessionRunnerDeps.autoCommitIfDirty` for reliable test mocking.
- Update autoCommitIfDirty test mock to handle `rev-parse --show-toplevel` guard.
- Update ACP acceptance test for correct default protocol.
- Repair acceptance tests for the latest schema and adapter structure.
- Default `CI=1` for all test runs to prevent real agent execution.
- Implement auto-commit git guard and script import.meta.main guards.

### Performance
- Fix Precheck Integration tests using `DEFAULT_CONFIG` iterationDelay.
- Address remaining slow tests by adjusting iterationDelay and webhook backoff.
- Eliminate fixed sleeps in three additional slow test areas.
- Remove 2s iterationDelay sleep in execution runner integration tests.
- Replace real `Bun.sleep` in retry test with injectable sleep spy.
- Resolve `scanCodebase` 10s-per-test slowness by optimizing directory reading.

### Other
- Remove pull policy.
- Run test.

---


## [0.41.0] — 2026-03-14

### Added
- **acp-adapter:** implement session persistence and tests for acp-adapter
- **acp-adapter:** implement acpx session mode for plan/run continuity and multi-turn interaction
- **acp-adapter:** add structured logging for runOnce
- **agents:** log the protocol/adapter being used
- **acp:** wire interaction bridge to plan() via run()
- **acp:** add interaction bridge support via JSON-RPC streaming
- implement ACP cost tracking from token usage
- **acp-adapter:** implement plan() and decompose() on AcpAgentAdapter
- **acp-adapter:** implement AcpInteractionBridge for routing
- **acp-adapter:** implement createAgentRegistry() and logActiveProtocol()
- **acp-adapter:** implement AcpAgentAdapter with injectable dependencies
- refactor acceptance generators to use adapter.complete() instead of Bun.spawn

### Fixed
- **acp:** ensure client.close() is called alongside session.close()
- **acp:** add SpawnAcpClient as the default production createClient factory
- **acp:** wire featureName, storyId, and sessionRole through TDD and execution callers
- **acp:** refactor session lifecycle for proper naming and permissions
- **acp:** wire run, complete, plan, and decompose to createClient injectable dependency
- **acp-adapter:** resolve session mode gaps identified in spec cross-check
- **acp-adapter:** pass agentName through session helpers
- **acp-adapter:** narrow rate limit detection to avoid false positives
- **acp:** thread prdPath to acceptance loop and use safe logging in adapter
- **acp-adapter:** address parity gaps with ClaudeCodeAdapter
- **acp:** thread pidRegistry and interactionBridge through execution pipeline
- **acp-adapter:** fix stdout double-read and add PID registry
- **config:** add agent protocol field to NaxConfigSchema
- **acp:** respect dangerouslySkipPermissions option
- **acp:** add stdin pipe support and fix Bun FileSink stdin API
- remove unsupported --max-tokens flag from claude-complete.ts
- wire protocol-aware agent registry through execution pipeline
- apply hotfixes to feature branch
- add acpx dependency and set default agent.protocol to acp
- verify and adjust Plan and decompose via ACP
- verify and adjust Interaction bridge for sessionUpdate to interaction chain
- commit status.json and runtime files upon run completion
- verify and adjust ACP adapter core for run() and complete() via AcpClient
- replace decompose stub with default agent adapter fallback
- disable decompose trigger and reset ACP-002 to pending
- use file-existence checks in acceptance tests and reset ACP-002
- correct acceptance test import paths and reset ACP-002

### Changed
- **acp:** rewrite adapter to properly utilize acpx CLI

### Other
- Merge feat/acp-agent-adapter into master


## [0.40.1] — 2026-03-13

### Added
- **ui-test-strategies:** implement UI test strategies for acceptance
- **ui-test-strategies:** wire testStrategy and testFramework through acceptance-setup stage
- **ui-test-strategies:** add strategy-aware instructions to refinement prompt
- **ui-test-strategies:** implement strategy-aware acceptance test generator templates
- **ui-test-strategies:** detect UI frameworks in detectStack
- **config:** add AcceptanceTestStrategy type and schema fields
- **acceptance:** add PRD and acceptance tests for v0.40.1 UI test strategies

### Fixed
- export AcceptanceConfigSchema for UI test strategies feature
- verify and adjust test strategy types and config schema extension


## [0.40.0] — 2026-03-12

### Added
- **acceptance:** implement acceptance-setup pipeline stage with RED gate
- **acceptance:** generate acceptance tests from PRD for test generation
- **acceptance:** implement AC refinement module with LLM adapter integration
- **prompts:** migrate prompt stage to use PromptBuilder for batch prompts
- **prompts:** add batch role to PromptBuilder

### Fixed
- verify and adjust integration test for RED to GREEN acceptance cycle
- wire preRunPipeline into runner before per-story loop
- resolve lint and type issues in generator-prd test file
- **ci:** align notify_pipeline_failed rules with test job rules
- **ci:** make test dependency optional in notify_pipeline_failed
- **ci:** fix notify_mr_success and notify_pipeline_failed jobs


## [0.39.3] — 2026-03-12

### Added
- **prompts:** add session context to all TDD role prompts
- **prompts:** inject test command from config into role prompts
- **security:** enhance prompt hardening and expand environment variable stripping

### Fixed
- **analyze:** remove hardcoded API key check
- **prompts:** pass constitution and testCommand to all TDD roles

### Changed
- **routing:** clean up LLM routing prompt
- **prompts:** unify test-after and tdd-simple into a single prompt


## [0.39.2] — 2026-03-12

### Added
- **review:** implement deferred plugin review after all stories complete
- **review:** skip plugin reviewers when pluginMode is deferred
- add pluginMode config to ReviewConfig schema


## [0.39.1] — 2026-03-12

### Fixed
- **routing:** resolve agent adapter for LLM batch routing
- **review:** pass storyGitRef to review orchestrator for plugin changed-file detection


## [0.39.0] — 2026-03-12

### Added
- **init:** implement post-init checklist and unified init flow
- **init:** generate context.md for project initialization
- **init:** auto-detect project stack and pre-fill quality commands


## [0.38.2] — 2026-03-11

### Added
- **plugins:** add enabled/disabled toggle for plugins


## [0.38.1] — 2026-03-11

### Fixed
- Make timeout-handler killFn injectable to fix SIGTERM test.
- Clean up pidRegistries Map after run completion.
- Validate story IDs before git branch creation.
- Resolve PID registry race conditions and timer leaks.
- Eliminate leaked timers in executeOnce and fix runOnce test command injection.
- Update parallel-cleanup tests for Phase 3 file split.
- Add storyGitRef to ExecutionConfig and define StoryCompletedEvent type.
- Fix beforeEach scoping in lifecycle tests.
- Remove duplicate imports in cli-precheck test.
- Remove duplicate skipInCI declaration in cli-precheck test.

### Changed
- Extract errorMessage utility.
- Split lifecycle.test.ts and fix runner modules lint errors.
- Extract magic number to named constant.
- Extract shared JSON file read/write utility.
- Split types.ts into extensions module.
- Split parallel.ts into coordinator and worker modules.
- Split verdict.ts into reader module.
- Complete verdict.ts split with reader and coerce modules.
- Split crash-recovery.ts into writer, signals, and heartbeat modules.
- Split checks-blockers.ts into git, config, cli, and system modules.
- Split logs.ts into reader and formatter modules.
- Split types.ts into schema-types and runtime-types modules.
- Split parallel-executor.ts into rectify and rectification-pass modules.
- Split claude.ts into execution, complete, and interactive modules.
- Split prompts.ts into main, init, export, and tdd modules.
- Split config.ts into display, get, and diff modules.
- Wrap Bun calls in injectable dependencies.
- Remove duplicate integration and execution tests.
- Remove duplicate context tests.
- Consolidate execution lifecycle tests.
- Consolidate decompose validator tests. 

### Other
- Update gitignore.


## [0.38.0] — 2026-03-10

### Added
- Add test file size enforcement script.
- Add dead test detection script.
- Add automated test overlap analyzer script.

---


## [0.37.0] — 2026-03-10

### Added
- Wire promptsInitCommand into nax init scaffold.
- Integrate nax prompts --export CLI functionality.
- Add exportPromptCommand for nax prompts --export <role>.
- Add tdd-simple default template to promptsInitCommand.
- Add tdd-simple to PromptsConfigSchema override enum.
- Document v0.37.0 prompt template export.

### Fixed
- Guard executionConfig optional chaining in review orchestrator.
- Include auto-committed changes in plugin reviewer scan.

---


## [0.36.2] — 2026-03-10

### Added
- Implement merge conflict rectification in parallel executor.
- Classify runtime crashes separately from test failures.

### Fixed
- Skip runner integration tests in CI due to missing Claude CLI.
- Mock runParallelExecution at runner level to fix dynamic-import isolation.
- Capture _parallelExecutorDeps originals in beforeEach to prevent CI contamination.
- Update integration tests for mergeConflicts field rename and runElapsedMs.
- Update MFX-005 test mocks to use mergeConflicts field name.
- Rename ParallelBatchResult fields and update durationMs to runElapsedMs.
- Preserve story metrics across model escalation.
- Fix parallel batch metrics aggregation.

---


## [0.36.1] — 2026-03-10

### Added
- Wire verdict section into PromptBuilder for verifier.

### Fixed
- Recognize VERIFIED keyword in coerceVerdict.
- Update migration test to use renamed buildBatchRoutingPrompt.
- Wire constitution into TDD implementer sessions.
- Log plugin reviewer result and error details in orchestrator.
- Log raw content when verifier verdict JSON fails to parse.
- Normalize choose interaction responses in chain.prompt().

### Changed
- Deduplicate functions and fix imports.
- Remove dead exports.
- Remove dead standalone prompt functions.
- Deduplicate test filter warning and use template literals.

---


## [0.36.0] — 2026-03-10

### Added
- Implement nax agents CLI command.
- Update precheck for multi-agent support.
- Implement Gemini CLI context generator.
- Implement Codex context generator with AGENTS.md support.
- Document multi-agent config in nax config --explain.
- Implement OpenCodeAdapter with complete() support.
- Initial PRD for v0.36.0 (multi-agent).

### Fixed
- Resolve routing stage crash when config.execution is undefined.
- Address merge conflicts in full adapter implementations.
- Wire agent adapter into routing context for LLM routing.
- Ensure tolerant verdict coercion for free-form agent output.

### Changed
- Extract autoCommitIfDirty into src/utils/git.ts.

---


## [0.35.0] — 2026-03-09

### Added
- Implement CodexAdapter with execute and complete methods.
- Add tdd-simple strategy option and switch nax project config to auto.
- Refactor auto plugin to use adapter.complete().
- Refactor LLM routing strategy to use adapter.complete().
- Add PluginLogger for write-only, stage-prefixed logging for plugins.
- Refactor classifier to use adapter.complete() and remove @anthropic-ai/sdk.
- Remove hardcoded Claude-Sonnet-4-5 model fallbacks.
- Add checkAgentCLI to support configured agent binary.
- Export CompleteOptions and CompleteError from agents barrel.
- Implement complete() method on ClaudeCodeAdapter.

### Fixed
- Auto-commit after rectification agent sessions.
- Log verdict file content when missing required fields.
- Only skip testStrategy override for LLM-routed cache hits.
- Remove second testStrategy override in routing stage cache hit.
- Use NODE_ENV check for test environment detection instead of any-cast.
- Add missing logs in TDD session and rectification paths.
- Recompute testStrategy from complexity on LLM cache hit.
- Allow Telegram/Webhook interaction plugins in headless mode.
- Integrate checkAgentCLI into precheck orchestrator.

---


## [0.34.0] — 2026-03-09

### Added
- Remove duplicate stopHeartbeat and writeExitSummary from sequential executor.
- Implement smart-skip for deferred regression when all stories pass the full-suite gate in sequential mode.
- Track fullSuiteGatePassed per story in metrics.
- Handle deferred regression failure in run-completion.
- Add on-final-regression-fail hook.
- Move run:completed event after regression gate.
- Add on-all-stories-complete lifecycle hook.

### Fixed
- Add storyDurationMs to story.complete and progress logs.

### Other
- Update Claude.

---


## [0.33.0] — 2026-03-09

### Added
- Thread structured review findings through escalation to retry context.
- Wire pipeline integration and CLI entry point for decomposition.
- Add structured ReviewFinding type for reviewer plugins.
- Introduce config schema, PRD mutation, and story-oversized trigger for decomposition.
- Add post-decompose validators for overlap, coverage, complexity, and dependency.
- Implement DecomposeBuilder fluent API and prompt sections.

### Fixed
- Resolve duplicate exit summary and premature heartbeat stop in execution.
- Correct overlap validator thresholds in decomposition to match specifications.


## [0.32.2] — 2026-03-09

### Fixed
- Address full-suite gate silently passing on crash/OOM truncated output in tdd-simple.


## [0.32.1] — 2026-03-09

### Added
- Implement tilde expansion in hook command parser.


## [0.32.0] — 2026-03-09

### Added
- Wire tdd-simple execution path.
- Add tdd-simple prompt section and PromptBuilder support.
- Introduce tdd-simple test strategy type and routing.

### Fixed
- Use actual testStrategy in prompt stage logging.
- Correct prompt template generation to include only four templates.
- Add tdd-simple to RoutingResult type union.


## [0.31.1] — 2026-03-09

### Fixed
- Auto-commit after agent sessions to prevent review failures.


## [0.31.0] — 2026-03-08

### Added
- Auto-configure prompts.overrides during initialization.
- Wire prompts --init into the CLI.
- Add nax prompts --init to export default templates.

### Fixed
- Normalize PRD status aliases and precheck command detection.
- Use 'pending' status in tdd-simple PRD instead of 'open'.
- Inject context markdown into verifier prompt.


## [0.30.0] - 2026-03-08

### Fixed
- **Global install crash:** `bin/nax.ts`, `headless-formatter.ts`, and `cli/analyze.ts` were reading `package.json` at runtime via `import.meta.dir`-relative paths. In a global bun install, these paths resolve incorrectly, causing an ENOENT crash on launch. All three now use the static `NAX_VERSION` constant (baked in at build time).

### Refactored
- **Prompt Builder wired to sections:** `PromptBuilder` now calls `buildRoleTaskSection()`, `buildIsolationSection()`, `buildStorySection()`, and `buildConventionsSection()` from `src/prompts/sections/` instead of duplicated inline functions. Eliminates 80+ lines of dead code.
- **Sections expanded:** `role-task.ts` and `isolation.ts` now cover all 4 roles (`implementer`, `test-writer`, `verifier`, `single-session`). Previously only covered 1–2 roles each.
- **Template stubs removed:** `src/prompts/templates/` directory deleted — all 4 stub files (`implementer.ts`, `test-writer.ts`, `verifier.ts`, `single-session.ts`) were empty and unused.


## [0.29.0] - 2026-03-08

### Added
- `context.fileInjection` config flag (`"keyword" | "disabled"`, default `"disabled"`). MCP-aware agents pull context on-demand; file injection is now opt-in.
- `nax config --explain` documents `context.fileInjection` with rationale and examples.
- Unit tests covering all `fileInjection` modes (disabled, keyword, legacy compat).

### Fixed
- **Implementer prompt:** Agent sessions now include explicit `git commit` instruction — implementation changes were previously left uncommitted, blocking the review stage.
- **Review stage:** `nax/status.json`, `nax/features/*/prd.json`, and `.nax-verifier-verdict.json` are excluded from the working-tree-clean check (nax runtime files, not agent changes).
- **Version display:** Installed binary no longer shows `(dev)` — `bin` now points to pre-built `dist/nax.js` with `GIT_COMMIT` injected at publish time.


## [0.28.0] — 2026-03-08

### Added
- Add prompts config schema validation and precheck for override files.

### Fixed
- Document prompts config in nax config --explain and add precheck validation.
- Migrate all existing prompt-building call sites to PromptBuilder.
- Implement default templates and user override loader.
- Add .solo/ to gitignore and stage missing execution.ts hunk.
- Implement typed sections: isolation, role-task, story, verdict, conventions.
- Create PromptBuilder class with layered section architecture.


## [0.27.1] — 2026-03-08

### Fixed
- Skip verification when TDD full-suite gate is passed and differentiate skip reasons in the pipeline runner.


## [0.27.0] — 2026-03-08

### Added
- Assert clean working tree before running review checks.

### Fixed
- Consolidate dead quality.commands.typecheck/lint into review resolution chain.
- Fix checkOptionalCommands precheck to use the correct config resolution path.
- Guard GIT_COMMIT injection against empty strings and add safe.directory to CI release stage.
- Resolve naxCommit from git at runtime when not build-injected.
- Sort imports in optimizer/index.ts.

### Changed
- Use Bun-native APIs for runtime commit resolution in version.ts.


## [0.26.0] — 2026-03-08

### Fixed
- Add missing contentHash field to StoryRouting type.
- Adjust contentHash in StoryRouting for staleness detection.
- Adjust initialComplexity in StoryRouting and StoryMetrics for accurate reporting.
- Ensure initial routing is persisted to prd.json on first classification.


## [0.25.0] — 2026-03-07

### Added
- Wire on-resume, on-session-end, and on-error hook events.
- Wire story-ambiguity and review-gate triggers.
- Wire security-review, merge-conflict, and pre-merge triggers.
- Wire max-retries trigger in interaction subscriber.
- Wire cost-exceeded and cost-warning triggers in sequential-executor.


## [0.24.0] — 2026-03-07

### Added
- Introduce global resolution for nax logs via central registry.
- Add nax runs CLI command for managing the central run registry.
- Implement registry writer subscriber.
- Create events file writer subscriber.


## [0.23.0] — 2026-03-07

### Added
- Log nax version and git commit hash at the start of each run.
- Add required statusFile parameter to end-to-end tests.
- Align status readers to nax/status.json.
- Write feature-level status at the end of a run.

### Fixed
- Use process.kill(pid,0) for checking if a process is alive.
- Add testScoped, lintFix, and formatFix to quality.commands Zod schema.


## [0.22.4] — 2026-03-07

### Fixed
- Fix scoped test command, testScoped config, and command logging.


## [0.22.3] — 2026-03-07

### Added
- Mark the status-file-consolidation feature as complete.

### Fixed
- Add a 10-second hard deadline to async signal handlers.
- Replace Bun.sleep with a clearable setTimeout in the executor.
- Release lock when setupRun fails after acquisition.
- Narrow catch in drainWithDeadline to expected errors.
- Treat corrupt lock files as stale and delete them.
- Replace executing array with Set to prevent race conditions.
- Declare product requirements document before crash handler to avoid TDZ.
- Suppress unhandled rejection on timeoutPromise.
- Use emitAsync for human-review:requested event.
- Read stdout/stderr concurrently with proc.exited.
- Remove cancel() on locked ReadableStreams, using kill() only.


## [0.22.2] — 2026-03-07

### Added
- Automatically write project-level status to nax/status.json.

### Fixed
- Silence floating outputPromise on LLM timeout to prevent crashes.
- Add missing fields to the SFC product requirements document.
- Ensure required fields for status-file consolidation are included.
- Use the userStories field in the SFC product requirements document.


## [0.22.1] — 2026-03-07

_No user-facing changes._


## [0.22.0] — 2026-03-07

### Added
- Complete Phase 4 by deleting deprecated files and streamlining executors.
- Remove preIterationTierCheck from executor.
- Eliminate deprecated code and routing duplicates.
- Consolidate subscribers via event bus for hooks, reporters, and interactions.
- Introduce new pipeline stages: rectify, autofix, regression, and retry action.
- Split context.test.ts into focused files for better organization.
- Conduct coverage gap analysis.
- Tag tests for re-architecture impact.
- Split large test files for better manageability.
- Reorganize test folder structure for clarity.

### Fixed
- Add a 15-second timeout guard to runNaxCommand in CLI logs test.
- Address 11 code review issues, including critical and major fixes.
- Implement hard deadline and OS-level force-kill to prevent process hangs.
- Delete test files marked for removal.
- Fix biome lint issues related to import order and formatting.
- Correct broken relative paths due to folder reorganization.
- Fix broken import paths in plan-analyze-run.test.ts after moving to test/e2e/.


## [0.21.0] — 2026-03-06

### Added
- Deprecate test-after from auto routing, defaulting to three-session-tdd-lite.
- Introduce baseRef tracking for precise smart-runner diffs.

### Fixed
- Update tests for path-only context and TDD-lite default.
- Address path-only context issue for oversized files.
- Fix LLM routing stream drain on timeout.
- Cancel stdout/stderr streams before process termination on LLM timeout.
- Follow up on runOnce() SIGKILL and unregister in the finally block.
- Revert to bun run test for quality.commands.test to avoid spawn issues.
- Prevent orphan processes with simple fixes.


## [0.20.0] — 2026-03-06

### Added
- Complete the verification architecture v2 for version 0.20.0.
- Implement the new verification architecture v2.
- Remove duplicate verification in post-verify scope.
- Add product requirements document for verification architecture v2.

### Fixed
- Revert verify.ts default to deferred and fix smart-runner test context.
- Set default regressionGate mode to per-story for clarity in smart-runner tests.
- Refactor foundation tests for compatibility with v0.20.0 architecture.
- Allow scoped verification in deferred regression mode.
- Sync implementation with green unit tests for US-003.
- Make final adjustments to logic and tests for US-003 deferred regression gate.
- Refactor rectification-flow tests to align with v0.20.0 architecture.
- Verify and adjust the deferred regression gate.
- Fix regression in tests and verify stage output tailing.


## [0.19.0] — 2026-03-05

### Added
- Implement security hardening and fixes in v0.19.0.


## [0.18.6] - 2026-03-04

### Fixed
- **fix:** Infinite PTY respawn loop in `usePty` hook by destructuring object-identity dependencies.
- **MEM-1 & MEM-3:** Prevented child process hangs on full `stderr` pipes by switching to `stderr: "inherit"`.
- Added missing error handling and `.catch()` chains to process `stdout` streaming and exit handlers.


## [0.18.5] - 2026-03-04

### Changed
- Replaced `node-pty` (native C++ addon) with `Bun.spawn` piped stdio in `src/agents/claude.ts` and `src/tui/hooks/usePty.ts`. No native build required.

### Removed
- `node-pty` dependency from `package.json`

### Fixed
- CI `before_script` no longer installs `python3 make g++` (not needed without native build)
- CI `bun install` no longer needs `--ignore-scripts`
- Flaky test `execution runner > completes when all stories are done` — skipped with root cause comment (acceptance loop iteration count non-deterministic)


## [0.18.4] - 2026-03-04

### Fixed
- **fix:** Keyword classifier no longer drifts across retries — `description` excluded from complexity/strategy classification (only `title`, `acceptanceCriteria`, `tags` used). Prevents prior error context from upgrading story complexity mid-run.
- **fix:** LLM routing now retries on timeout/transient failure. New config: `routing.llm.retries` (default: 1), `routing.llm.retryDelayMs` (default: 1000ms). Default timeout raised from 15s to 30s.

### Added
- Pre-commit hook (`.githooks/pre-commit`) — runs `typecheck` + `lint` before every commit. Install with: `git config core.hooksPath .githooks`


## [0.18.3] — 2026-03-04

### Added
- Introduce execution reliability features and smart runner enhancements.
- Add configurable test file patterns and structured failure types.

### Fixed
- Implement optional chaining in regression gate config and finalize barrel imports in integration tests.

---


## [0.18.2] — 2026-03-03

### Added
- Integrate smart runner into the verify stage.
- Add `execution.smartTestRunner` flag for configuration.
- Introduce functions for scoped test runs and source-to-test file mapping.

### Fixed
- Resolve leakage issues in smart runner tests and adjust console logging options.

---


## [0.18.1] — 2026-03-03

### Fixed
- Skip CLAUDE-dependent precheck integration tests in CI.
- Add global git identity to the test stage for git commits in tests.
- Fix CI to skip environment-sensitive tests and resolve ENOENT crashes.

---


## [0.18.0] — 2026-03-03

### Added
- Integrate interaction chain into the runner loop.

### Fixed
- Log exit code and stderr on agent session failure.
- Prioritize retrying failed stories before moving to the next.
- Ensure Task classified log shows final routing state after all overrides.
- Skip hanging verify tests and disable type check in review.
- Add `storyId` to all JSONL event emitters.
- Emit `run.complete` event on SIGTERM shutdown.

---


## [0.17.1] — 2026-03-02

### Fixed
- Improve timeout messaging and skip test-writer on retry.

---


## [0.17.0] — 2026-03-02

### Added
- Introduce config management features including default view and explanation commands.
- Add `--diff` flag to the `nax config` command.
- Add configuration default view with source header.

### Fixed
- Adjust `nax config` for default view and explanation commands.
- Add `USER/LOGNAME` to the environment allowlist for macOS Keychain authentication.
- Ensure escalation routing is applied correctly in iterations.

---


## [0.16.2] — 2026-03-01

### Added
- **unlock:** Implement unlock command with unit tests.

### Fixed
- **tdd:** Skip greenfield pause when pre-existing test files exist in repo.


## [0.16.1] — 2026-03-01

### Added
- **generate:** Multi-language auto-injection for various programming languages.
- **generate:** Project context generator replaces constitution generator.

### Fixed
- **tests:** Resolve all pre-existing integration test failures.
- **execution:** Hotfix broken import and ReferenceError.


## [0.15.3] — 2026-02-28

### Added
- **constitution:** Implement constitution-to-agent-config generator.


## [0.15.1] — 2026-02-28

### Added
- **interaction:** Implement Telegram, webhook, and interactive pipeline core.

### Fixed
- **interaction:** Resolve code review findings from v0.15.0 audit.
- **tests:** Skip precheck in unit/integration tests to fix failing tests.

### Changed
- **execution:** Trim `parallel.ts` from 404 to 400 lines.
- **routing:** Split `llm.ts` into `llm.ts` and `llm-prompts.ts`.


## [0.14.1] — 2026-02-28

### Added
- Add `nax diagnose` CLI command.

### Fixed
- **diagnose:** Resolve `projectDir` to parent of `nax/` subdir.


## [0.14.0] — 2026-02-28

### Added
- **runner:** Auto-switch to test-after on greenfield with no tests.
- **execution:** Add PID registry for orphan process cleanup on crash.
- **verify:** Add full-suite regression gate after scoped tests.

### Fixed
- **runner:** Reset attempt counter on tier escalation.


## [0.13.0] — 2026-02-27

### Added
- **precheck:** Implement CLI command with `--json` flag.
- **precheck:** Add types and check implementations.
- Add `storyPoints` field and auto-default to 1.

### Fixed
- **precheck:** Fix integration test setup to commit fixtures before precheck.


## [0.12.0] — 2026-02-27

### Added
- **logging:** Implement `nax logs` command with filtering and follow mode.
- **status:** Introduce `nax status` command for active run detection.
- **logging:** Add human-friendly formatter with verbosity levels.
- **cli:** Add project resolver with CWD and `-d` flag support.
- **plugins:** Sample console reporter plugin with tests.
- **pipeline:** Integrate plugin system and reporters into runner.
- **optimizer:** Add prompt optimization stage with rule-based optimizer.
- **config:** Integrate global config layering into loaders and schema.
- Add `nax prompts` CLI command for prompt inspection.

### Fixed
- Accept 'done'/'passed' for skip and default tags to empty array.
- **tests:** Resolve remaining test failures.
- **runner:** Add state reconciliation for failed stories with commits.
- **cli:** Replace `process.exit` with thrown errors.

### Changed
- **test:** Restructure test suite into unit/integration/ui tiers.


## [0.9.2] — 2026-02-22

### Fixed
- Update verifier prompt in TDD to allow legitimate test modifications.


## [0.9.1] — 2026-02-22

### Fixed
- Respect LLM complexity, add PRD fields, and relax isolation in analysis.

---


## [0.9.0] — 2026-02-22

### Added
- Introduce configurable LLM routing mode: one-shot, per-story, hybrid.
- Split relevantFiles into contextFiles and expectedFiles.
- Wire routing mode to batch trigger and hybrid re-route.
- Implement one-shot mode to skip per-story LLM calls on cache miss.
- Replace routing.llm.batchMode with routing.llm.mode enum.
- Add nax runs commands and complete console.log migration in CLI.
- Emit structured stage lifecycle events in the logger.
- Add --verbose, --quiet, --silent flags and run directory in CLI.
- Implement structured Logger with level gating and JSONL output.
- Enhance routing with LLM support and batch capabilities.
- Add LLM routing config schema and defaults.
- Introduce configurable model tiers per TDD session.
- Add test deduplication guidance referencing coverage summary.
- Inject test coverage summary into story prompts.
- Add test file scanner for coverage summary.
- Wire ADR-003 verification and stall detection into the runner.
- Add blocked status, stall detection, and update escalation tests in PRD.
- Port ADR-003 robust orchestration feedback loop to @nathapp/nax.

### Fixed
- Resolve review HIGH/MED findings before v0.9 merge.
- Apply batchMode compatibility shim before defaults merge.
- Return no-op logger when not initialized for test safety.
- Address P1-P5 review findings for LLM routing.
- Address P1+P2 from code review regarding workdir in post-verification.
- Clean up orphaned child processes after TDD session failure.
- Detect empty test-writer sessions in TDD orchestrator.
- Prevent false positive pauses during post-TDD test verification.
- Use CLI aliases for default model config.
- Reset attempts on tier escalation with defensive checks.
- Surface ASSET_CHECK errors as mandatory instructions in prompt.
- Implement pre-iteration tier escalation and per-story failure cap.
- Re-derive modelTier from cached complexity.
- Fix syntax error in agents' plan method.
- Use Bun.file() for plan stdout redirect in agents.
- Use file descriptors instead of shell redirect for plan output in agents.
- Restore --permission-mode plan for all modes in agents.
- Read stdout/stderr before proc.exited to prevent stream loss in agents.
- Resolve P0/P1 review findings from ADR-003 code review.

### Changed
- Output contextFiles instead of relevantFiles in analysis.
- Use getExpectedFiles for asset checks in verification.
- Use getContextFiles for prompt injection in context.
- Add contextFiles and expectedFiles types and resolvers in PRD.
- Migrate console.log to structured logger in agents, pipeline, and execution.
- Deduplicate proc.kill on timeout and add unit tests for validation helpers.
- Make routing strategy chain async for LLM support.
- Resolve P2/P3 review findings.

---


## [0.6.0] — 2026-02-17

### Added
- Enhance TUI with a responsive layout and polish.
- Introduce keyboard controls and overlays in TUI.
- Embed agent PTY session in the TUI.
- Add an Ink-based TUI with a stories panel.
- Implement an event emitter for TUI integration.

### Fixed
- Polish P3-P4 review findings in TUI.
- Populate story costs and add PTY line length limits.
- Wire PTY integration to the agent panel.

---


## [0.5.0] — 2026-02-17

### Added
- Add developer-configurable token pricing per model tier.
- Implement adaptive metrics-driven routing strategy.
- Introduce a pluggable routing strategy system.
- Add per-story and per-run cost tracking.

### Changed
- Rename ngent to @nathapp/nax.

---


## [0.4.0] — 2026-02-17

### Added
- Add a self-correcting fix loop with human override for acceptance.
- Introduce acceptance validation as a pipeline stage.
- Generate acceptance tests from specification acceptance criteria.

### Fixed
- Resolve E2E timeouts and clean up acceptance tests.
- Respect existing story status and derive routing at runtime.
- Handle stale locks and reduce OOM risk in the verify stage.

---


## [0.3.0] — 2026-02-17

### Added
- Decompose spec into classified stories for analysis.
- Introduce interactive planning via agent plan mode.
- Add post-implementation review phase.
- Enhance story classification with LLM capabilities.
- Implement a constitution system with prompt injection.

### Fixed
- Implement verify stage and resolve type inconsistencies in the pipeline.

### Changed
- Standardize error handling and add comprehensive JSDoc in the pipeline.
- Extract runner.ts into composable pipeline stages.
- Add a composable pipeline framework with stage runner.

---


## [0.2.0] — 2026-02-17

### Added
- Load relevant source files into agent context.
- Add capability metadata and tier validation for agents.
- Introduce progress display and TDD dry-run mode.
- Implement story batching for simple stories.
- Establish an explicit 3-tier escalation chain.
- Add PAUSE/ABORT/SKIP commands to the queue.
- Enable story-scoped extraction from PRD.
- Integrate UserStory context fields into context builder.
- Add context builder module for story-scoped prompt optimization.
- Support model tiers with provider and environment overrides in configuration.
- Wire featureDir into CLI run command for progress logging.
- Add comprehensive config validation tests.
- Implement cost tracking and queue manager with 58 total tests.
- Introduce analyze command with progress logging and 32 tests passing.
- Create agent execution loop and three-session TDD orchestrator.
- Initial scaffold for CLI, agents, routing, hooks, TDD isolation, with 17 tests passing.

### Fixed
- Add batch-wide escalation option for execution.
- Optimize dirty-flag reload to reduce unnecessary IO.
- Include confidence scores in cost estimation.
- Improve memory limits and accuracy of cost estimation.
- Resolve queue race condition and optimize batching.
- Add path validation and agent installation checks for security.
- Prevent command injection in hook execution.
- Address remaining review findings from v0.2.
- Check queue commands before batch execution and add skipped status.
- Document batch escalation and remove duplicate validateConfig.

### Performance
- Precompute batch plan to eliminate O(n²) re-checking.

### Changed
- Standardize error handling and extract magic numbers as named constants.
- Replace manual validation with Zod schema parsing in configuration.
- Convert QueueCommand to a discriminated union.
- Extract escalation, queue-handler, and helpers from runner.
- Extract prompts and batching modules from runner.
- Apply DRY principles to context helper, fix token estimation, and remove dead config.

---

## [0.10.0] - 2026-02-23

### Added

#### Plugin System
- Extensible plugin architecture: prompt optimizers, custom routers, code reviewers, context providers, custom reporters, and agent launchers
- Plugin discovery from global (`~/.nax/plugins`) and project-local (`.nax/plugins`) directories
- Plugin validation and lifecycle management (setup/teardown hooks)
- Plugin configuration via `.nax/config.json` with per-plugin settings

#### Global Configuration Layering
- Three-tier configuration system: user-global (`~/.nax/config.json`), project (`.nax/config.json`), and CLI overrides
- Deep merge strategy with array override semantics
- Layered constitution loading with optional global opt-out

#### Prompt Optimizer
- Built-in prompt optimization with configurable token budget enforcement
- Optimization strategies: redundancy elimination, context summarization, selective detail retention
- Optimization statistics tracking (original vs. optimized token counts, reduction %)

### Changed
- Config loading refactored to support global + project layering

### Fixed
- Path security test failures on macOS (`/private` symlink prefix)
- TypeScript compilation errors across 9 files
- Import formatting across 96 files

---

### Previous releases
- See git history for changes prior to v0.10.0
