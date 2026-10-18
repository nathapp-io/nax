# SPEC: Sandboxed-run marker for confined tests, and root-wins repo gates

Closes: #2601, #2603

## Summary

Two fixes to how nax checks its own work. First, every command nax's session sandbox wraps now carries `NAX_SANDBOXED=1`, and the confined-test helper `isConfinedTestRun()` (both copies, in `packages/nax-agent` and `packages/nax`) reads it, so tests that need something the sandbox withholds skip inside a native agent session instead of failing (#2601). Second, the workflow and finish repo gates stop re-running every gate per touched package: a gate key the root `quality.commands` configures runs once, at the root, and a package overlay's command for that key is ignored; an overlay still supplies a gate the root does not configure (#2603).

## Motivation

**#2601.** `isConfinedTestRun()` returns `process.env.NAX_TEST_CONFINED === "1"`, and only the confined test runner (`packages/nax-agent/scripts/lib/confined-run.ts`) exports that. When a native agent runs `bun run test` through nax's own session sandbox, the variable is absent, so tests that `skipIf(isConfinedTestRun())` because they launch a real srt backend run anyway and fail (`sandbox wrap failed: EPERM: operation not permitted, listen` on the srt-mux socket; `mkdir /tmp/nax` denied). In the workflow run for #2599 the implementer met these failures in `coding-tool-support-command-shadow.test.ts` and `coding-tool-support-session-tmp.test.ts` and rewrote them to stub the launcher (commit `8f0783d30`, reverted in `16b6691b9`). Every workflow run whose story tests execute inside the session sandbox can repeat that.

**#2603.** `resolveGateCommands` (`packages/nax/src/finish/gates/quality.ts`) schedules the root gates, then every gate a touched package's overlay (`.nax/mono/<pkg>/config.json`) names, as `<gate>@<pkg>`, dropping an overlay gate only when it repeats a scheduled run exactly. In a monorepo whose root commands fan out across the workspace (`bun run --filter '*' test`, `turbo run test`), the overlay's package-local command never matches, so the package's suite runs twice per gate round. The #2599 run scheduled 12 gate commands per round for two touched packages. `nax gates run` passes no package dirs and already runs root gates only, so the CLI and the workflow/finish gates check different sets today.

Overlays cannot simply drop their commands: the overlay is also each story's effective config (`loadConfigForWorkdir` deep-merges it), and nax's own `packages/nax` overlay carries the `bun run --cwd ../nax-ai build &&` prefix stories need. Overlay gates also exist for a reason recorded in the `quality.ts` header (F2): a repo whose gates live only in package overlays must not report "verified nothing" as green. Root-wins per gate key keeps that protection and removes the doubling.

## Design

### Integration

The baseline listings below exist only to locate the code; they are never the interface to implement. Each mutated symbol states its target.

**Read only (verified 2026-10-18, main `bd25102dd`):**

- `packages/nax-agent/src/sandbox/launcher.ts` — `runWrapped(req, backend, policy, env)` builds `command` from `req.spec` (shell command, or `quoteArgvForShell(req.spec.argv)`), prefixes `tmpEnvPrefix(env.tmpDir)` when `env.tmpDir !== undefined`, and passes it to `backend.wrap({ command, shell, policy, cwd, commandId })`. srt replaces the child environment wholesale, which is why the TMPDIR override rides the shell command rather than an env overlay. `runUnwrapped` (states `disabled` and `unavailable`) runs `logicalArgv(req)` with `withTmpEnv` as an env overlay. `LaunchResult.executed` is `logicalArgv(req)` in both paths.
- `packages/nax-agent/src/sandbox/index.ts` — barrel re-exporting `_launcherDeps`, `CommandLauncherOptions`, `createCommandLauncher`, `DISABLED_SANDBOX_STATE` from `./launcher.ts`.
- `packages/nax-agent/src/index.ts` — package root; re-exports a selected list from `#src/sandbox/index`.
- `packages/nax-agent/scripts/lib/confined-run.ts` — the confined runner; exports `CONFINED_TEST_ENV = "NAX_TEST_CONFINED"` into its wrapped command. Unchanged.
- `packages/nax/src/workflow/repo-gates.ts` — `runRepoGates(fc)` calls `_featureDeps.resolveGateCommands(fc.projectDir, [...fc.packageDirs])` then `_featureDeps.runQualityGates(fc.projectDir, commands)`. Unchanged.
- `packages/nax/src/finish/gates-loop.ts` — finish `runRepoGates(state, deps)` calls `resolveGateCommands(state.workdir, deps.context.groups.map((g) => g.packageDir))`. Unchanged.
- `packages/nax/src/cli/gates.ts:276` — `nax gates run` calls `resolveGateCommands(projectDir, [])`. Unchanged.

**Mutated:**

- `tmpEnvPrefix(tmpDir)` / the prefix logic in `runWrapped` (`launcher.ts`).
  - Baseline: prefix is `export TMPDIR='<t>' TMP='<t>' TEMP='<t>'; ` when `env.tmpDir` is defined, and nothing otherwise.
  - Target: every wrapped command is prefixed. With `env.tmpDir` defined: `export NAX_SANDBOXED=1 TMPDIR='<t>' TMP='<t>' TEMP='<t>'; `. With it undefined: `export NAX_SANDBOXED=1; `. `runUnwrapped` is unchanged and adds no marker: an unwrapped command is not sandboxed. `executed` stays `logicalArgv(req)`. The comment above the prefix in `runWrapped` (the one explaining why TMPDIR rides the shell command) is updated to say the prefix now always carries `NAX_SANDBOXED=1`.
- New constant `SANDBOXED_ENV = "NAX_SANDBOXED"`, declared in `launcher.ts`, re-exported from `src/sandbox/index.ts` and from the package root `src/index.ts` so a consumer (a test helper, or a downstream project's tests) can read the marker by name.
- `isConfinedTestRun()` in `packages/nax-agent/test/helpers/confined.ts` and its sanctioned copy in `packages/nax/test/helpers/confined.ts`.
  - Baseline: `return process.env[CONFINED_TEST_ENV] === "1";`
  - Target: true when `process.env.NAX_TEST_CONFINED === "1"` **or** `process.env.NAX_SANDBOXED === "1"`; any other value of either reads as not confined. Each copy exports `SANDBOXED_ENV` alongside `CONFINED_TEST_ENV`. The nax-agent copy imports `SANDBOXED_ENV` from `#src/sandbox/index`; the nax copy declares the literal (the sanctioned-copy pattern the file already uses for `CONFINED_TEST_ENV`).
- The overlay loop in `resolveGateCommands(repoRoot, packageDirs)` (`quality.ts`). Signature unchanged.
  - Baseline: for each package dir and each `GATE_ORDER` key the overlay configures, schedule `<gate>@<pkg>` unless the run `(cwd, command, setup)` is already scheduled.
  - Target: same loop, plus one rule evaluated first: when the root configures that gate key (`isConfigured(rootCommands[gate])`), the overlay's command for that key is skipped. "Configured" uses the existing `isConfigured` (a blank string or an array of blanks is not configured). The existing run-identity dedupe stays for the keys that do reach it. The header comment's F2 paragraph is updated to state the root-wins rule.

### Approach

Order of evaluation in `resolveGateCommands`, per overlay gate key: (1) not set in the overlay → skip; (2) root configures the key → skip; (3) run identity already scheduled → skip; (4) schedule `<gate>@<pkg>`. Root gates are scheduled first, in `GATE_ORDER`, exactly as today.

### Failure Handling

| Situation | Behaviour |
|---|---|
| `loadPackageOverride` throws for a touched package | Unchanged: the error propagates to the caller as today. |
| The marker variable is already set in the parent environment | Irrelevant to wrapped runs: srt replaces the child env and the prefix sets it. Unwrapped runs inherit the parent env unchanged, as today. |

No other new failure paths.

## Out of Scope

- Detecting a sandbox nax does not own (a Claude Code srt session, a container): `NAX_SANDBOXED` marks only commands nax's own launcher wraps.
- The failure behaviour this spec leaves unchanged needs no new test: a `loadPackageOverride` error for a touched package still propagates to the caller, and an unwrapped run still inherits the parent environment as-is.
- `NAX_SANDBOXED` is advisory, not a security boundary: any command can export it itself, and its only effect is that sandbox-dependent tests skip.
- Marking unwrapped runs: when the session sandbox is disabled or unavailable the command is not sandboxed and carries no marker.
- `nax sandbox exec` (the ACP shell-sandbox runner) and ACP agents' shell commands are not changed by this spec.
- US-002 only: the two tests named in #2601, `test/unit/agents/coding-tool-support-command-shadow.test.ts` and `test/unit/agents/coding-tool-support-session-tmp.test.ts`, are not modified; they already `skipIf(isConfinedTestRun())` and start skipping once the helper reads the marker.
- No test that calls `skipIf(isConfinedTestRun())` is rewritten, stubbed or weakened to make it pass inside a sandbox.
- A gate that only a package overlay supplies for a key the root also configures (for example a firmware `test` the root fan-out excludes) is no longer run by the repo gates; a project that wants it moves it into the root `quality.commands`. Called out in the release notes, not handled in code.
- `nax gates run` behaviour is unchanged (it already resolves root gates only).
- Story-level command resolution (`loadConfigForWorkdir`, `testScoped`, the per-story verify) is unchanged: overlays still set each story's commands.
- Docs under the repo-root `docs/guides/` (outside every story's Workdir) are updated by hand on the branch before the PR, not by a story.

## Stories

### US-001: the session sandbox marks every wrapped command

Workdir: `packages/nax-agent`. No dependencies.

The launcher's wrapped-command prefix always exports `NAX_SANDBOXED=1`, merged into the existing TMPDIR export when a session temp dir is in force. `SANDBOXED_ENV` is exported from the sandbox barrel and the package root. The nax-agent test helper `isConfinedTestRun()` reads either marker.

### US-002: nax's confined-test helper reads the sandbox marker

Workdir: `packages/nax`. Depends on US-001.

The sanctioned copy of `isConfinedTestRun()` in `packages/nax/test/helpers/confined.ts` reads `NAX_SANDBOXED` as well as `NAX_TEST_CONFINED`, and exports `SANDBOXED_ENV`, whose value matches the one `@nathapp/nax-agent` exports.

### US-003: repo gates — the root wins per gate key

Workdir: `packages/nax`. No dependencies.

`resolveGateCommands` skips a package overlay's command for any gate key the root `quality.commands` configures; an overlay still supplies a key the root leaves unconfigured. Both callers (workflow `runRepoGates`, finish gates loop) inherit the rule without change.

### Context Files

**US-001**

- `packages/nax-agent/src/sandbox/launcher.ts` — `runWrapped`, `tmpEnvPrefix`, `runUnwrapped`, `createCommandLauncher`.
- `packages/nax-agent/src/sandbox/index.ts` — the barrel to extend.
- `packages/nax-agent/src/index.ts` — package root re-exports from `#src/sandbox/index`.
- `packages/nax-agent/test/helpers/confined.ts` — `isConfinedTestRun`, `CONFINED_TEST_ENV`.
- `packages/nax-agent/test/unit/sandbox/launcher.test.ts` — the fake-backend harness (`makeFakeSandboxBackend`) to follow.

**US-002**

- `packages/nax/test/helpers/confined.ts` — the sanctioned copy.
- `packages/nax/test/unit/helpers/confined.test.ts` — existing helper tests.
- `packages/nax/test/unit/agents/coding-tool-support-session-tmp.test.ts` — a real-backend suite gated on `isConfinedTestRun()` (read only).

**US-003**

- `packages/nax/src/finish/gates/quality.ts` — `resolveGateCommands`, `GATE_ORDER`, `isConfigured`, header comment.
- `packages/nax/src/workflow/repo-gates.ts` — `runRepoGates`.
- `packages/nax/test/unit/finish/gates-quality.test.ts` — resolver unit tests and `configWithCommands` helper.
- `packages/nax/test/unit/workflow/repo-gates.test.ts` — `_featureDeps` stubbing pattern.

### Creates

**US-001**

None.

**US-002**

- `packages/nax/test/integration/confined/sandbox-marker.test.ts` — the US-002 AC 5 integration test: spawns a child `bun test` on the session-tmp suite with the marker set.

**US-003**

None.

### Modifies

**US-001**

- `packages/nax-agent/test/unit/sandbox/launcher.test.ts` — three tests pin the wrapped command, which now starts with export NAX_SANDBOXED=1;  whether or not a session temp dir is in force. (1) "available: wraps, runs the wrapper argv, records wrapped" asserts r.sandbox equals { backend: "srt", wrapped: true, argv: ["/bin/sh", "-c", "echo hi"] }; the argv becomes ["/bin/sh", "-c", "export NAX_SANDBOXED=1; echo hi"]. (2) "a likely denial appends the hint line" asserts the argv ["/bin/sh", "-c", "echo 'x: Operation not permitted' >&2; exit 1"]; it becomes ["/bin/sh", "-c", "export NAX_SANDBOXED=1; echo 'x: Operation not permitted' >&2; exit 1"]. (3) "available: an argv spec is quoted into one shell command" asserts backend.calls[0]?.command is exactly the quoted argv; the expected command gains the same leading export NAX_SANDBOXED=1; . In all three, executed, stdout and the hint line are unchanged.
- `packages/nax-agent/test/unit/sandbox/launcher-session-tmp.test.ts` — the assertion at line 106 expects the wrapped command export TMPDIR='<t>' TMP='<t>' TEMP='<t>'; echo hi; the marker joins the same export, so the expected command becomes export NAX_SANDBOXED=1 TMPDIR='<t>' TMP='<t>' TEMP='<t>'; echo hi.
- `packages/nax-agent/test/unit/tools/bash-sandbox.test.ts` — line 69 asserts audit.sandbox equals { backend: "srt", wrapped: true, argv: ["/bin/sh", "-c", "echo hi"] }; the wrapped argv now carries the marker prefix, so it becomes ["/bin/sh", "-c", "export NAX_SANDBOXED=1; echo hi"]. audit.executed (the logical argv) is unchanged.
- `packages/nax-agent/test/unit/tools/run-command-exec-sandbox.test.ts` — lines 57-63 assert audit.sandbox.argv and the spawned seen[0].argv equal ["/bin/sh", "-c", "'bun' '--version'"]; both become ["/bin/sh", "-c", "export NAX_SANDBOXED=1; 'bun' '--version'"]. The invariant (the argv the backend built is the argv spawned) is unchanged.
- `packages/nax-agent/test/unit/scripts/confined-run.test.ts` — two places read the confined marker from an environment that, inside a sandboxed session, now also carries NAX_SANDBOXED=1. (1) The isConfinedTestRun describe block saves and restores only NAX_TEST_CONFINED; it must also save, clear and restore NAX_SANDBOXED. (2) runFixture in the "confined fixtures" describe block copies process.env and deletes only NAX_TEST_CONFINED; it must also delete NAX_SANDBOXED, or the "without the confined marker" runs read as confined. Every asserted outcome is unchanged.
- `packages/nax-agent/test/fixtures/confined/writes-literal-tmp.fixture.ts` — the fixture runs only under the confined runner via skipIf(!isConfinedTestRun()), and is built to FAIL there (it writes a literal /tmp path). Once isConfinedTestRun() also reads NAX_SANDBOXED, a gate that runs this path explicitly inside a sandboxed session would run it and record the designed failure. Its guard must read the runner's marker directly (process.env.NAX_TEST_CONFINED equal to "1", via CONFINED_TEST_ENV) instead of isConfinedTestRun(); its behaviour under the runner is unchanged.
- `packages/nax-agent/test/fixtures/confined/writes-tmpdir.fixture.ts` — same guard as writes-literal-tmp.fixture.ts: skipIf(!isConfinedTestRun()) must read the runner's marker directly (CONFINED_TEST_ENV equal to "1"), so the fixture keeps meaning running under the confined runner and is not run by a sandboxed session; its behaviour under the runner is unchanged.
- `packages/nax-agent/test/helpers/confined.ts` — isConfinedTestRun() gains the NAX_SANDBOXED reading and the file exports SANDBOXED_ENV (imported from #src/sandbox/index), per the Design target.
- `packages/nax-agent/test/helpers/index.ts` — the barrel re-exports CONFINED_TEST_ENV and isConfinedTestRun from ./confined; it also re-exports SANDBOXED_ENV.
- `packages/nax-agent/api/nax-agent.api.txt` — the committed public-API snapshot gains SANDBOXED_ENV under both the . and ./internal entry points (internal.ts re-exports the sandbox barrel); regenerate it with bun run api:update so check:api passes.

**US-002**

- `packages/nax/test/unit/helpers/confined.test.ts` — the isConfinedTestRun describe block saves and restores only NAX_TEST_CONFINED, and its "returns false" tests would read true inside a sandboxed session. It must also save, clear and restore NAX_SANDBOXED; the asserted outcomes are unchanged.
- `packages/nax/test/helpers/confined.ts` — isConfinedTestRun() gains the NAX_SANDBOXED reading and the file exports SANDBOXED_ENV, per the Design target.
- `packages/nax/test/helpers/index.ts` — the barrel re-exports the confined helpers from ./confined; it also re-exports SANDBOXED_ENV.
- `packages/nax/test/integration/permissions/bash-deny-suite.test.ts` — line 641 asserts backend.calls[0]?.command is exactly the agent's command ("the backend's wrap saw the identical bytes"); the launcher now prefixes every wrapped command, so the expected value becomes export NAX_SANDBOXED=1;  followed by command. The invariant that the policy check and the shadow see the unprefixed bytes (the two assertions above it) is unchanged.

**US-003**

- `packages/nax/test/unit/finish/gates-quality.test.ts` — two tests expect an overlay gate for a key the root also configures. (1) "a package overlay that sets only one gate does not fan out the root's other gates for that package" expects ["build", "typecheck", "lint", "test", "test@apps/web"]; the root configures test, so the expected names become ["build", "typecheck", "lint", "test"]. (2) "orders root gates by GATE_ORDER, then each package's gates by GATE_ORDER, packages in order given" expects build@pkg-b and build@pkg-a; the root configures build, so the expected names become ["build", "typecheck", "test", "lint@pkg-b", "lint@pkg-a"]. The ordering invariant (root gates first, then each package in the order given) still holds.
- `packages/nax/test/unit/finish/gates-quality-e2e.test.ts` — the test "AC-6: same e2e command and cwd but different e2eSetup keeps both gates" expects both e2e and e2e@.; the root configures e2e, so the overlay's e2e is skipped and the expected result is the root e2e gate alone, with setup docker compose up -d.

### Seams

- US-001 → US-002: `SANDBOXED_ENV` exported from `@nathapp/nax-agent` is the name the nax helper copy must agree with (US-002 AC 4 pins the agreement).
- US-003: the resolver change reaches the workflow through the existing `runRepoGates` → `_featureDeps.resolveGateCommands` call (US-003 AC 9).

## Acceptance Criteria

### US-001

1. [unit] `createCommandLauncher` in the `available` state with a fake enforcing backend and no `tmpDir`, running the shell spec `echo hi`, passes `backend.wrap` the command `export NAX_SANDBOXED=1; echo hi`.
2. [unit] `createCommandLauncher` in the `available` state with `tmpDir` set to `<t>`, running the shell spec `echo hi`, passes `backend.wrap` the command `export NAX_SANDBOXED=1 TMPDIR='<t>' TMP='<t>' TEMP='<t>'; echo hi`.
3. [unit] `createCommandLauncher` in the `available` state with no `tmpDir`, running the argv spec `["echo", "a b"]`, passes `backend.wrap` the command `export NAX_SANDBOXED=1; 'echo' 'a b'` and returns stdout `a b` after trimming.
4. [unit] `createCommandLauncher` in the `available` state with a fake backend that executes the wrapped command, running the shell spec `printenv NAX_SANDBOXED`, returns stdout `1` after trimming.
5. [unit] `createCommandLauncher` in the `disabled` state, with `NAX_SANDBOXED` deleted from `process.env` for the test and restored afterwards, running the shell spec `printenv NAX_SANDBOXED`, returns empty stdout after trimming and a result whose `sandbox.wrapped` is `false`.
6. [unit] `createCommandLauncher` in the `unavailable` state, with `NAX_SANDBOXED` deleted from `process.env` for the test and restored afterwards, running the shell spec `printenv NAX_SANDBOXED`, returns empty stdout after trimming and a result whose `sandbox.wrapped` is `false`.
7. [unit] (regression pin) For the shell spec `echo hi`, the `executed` field of the `LaunchResult` from the `available` state equals the `executed` field the same request yields from the `disabled` state.
8. [unit] `SANDBOXED_ENV` imported from the nax-agent package root (`src/index.ts`) equals the string `NAX_SANDBOXED`.
9. [unit] `SANDBOXED_ENV` imported from `src/sandbox/index.ts` is the same value as the one imported from the package root.
10. [unit] The nax-agent test helper `isConfinedTestRun()` returns `true` when `NAX_SANDBOXED` is `"1"` and `NAX_TEST_CONFINED` is unset.
11. [unit] (regression pin) The nax-agent test helper `isConfinedTestRun()` returns `true` when `NAX_TEST_CONFINED` is `"1"` and `NAX_SANDBOXED` is unset.
12. [unit] (regression pin) The nax-agent test helper `isConfinedTestRun()` returns `false` when both `NAX_SANDBOXED` and `NAX_TEST_CONFINED` are unset.
13. [unit] (regression pin) The nax-agent test helper `isConfinedTestRun()` returns `false` when `NAX_SANDBOXED` is `"true"` and `NAX_TEST_CONFINED` is unset.

### US-002

1. [unit] `isConfinedTestRun()` from `@test/helpers` returns `true` when `NAX_SANDBOXED` is `"1"` and `NAX_TEST_CONFINED` is unset.
2. [unit] (regression pin) `isConfinedTestRun()` from `@test/helpers` returns `false` when both `NAX_SANDBOXED` and `NAX_TEST_CONFINED` are unset.
3. [unit] (regression pin) `isConfinedTestRun()` from `@test/helpers` returns `false` when `NAX_SANDBOXED` is `"0"` and `NAX_TEST_CONFINED` is unset.
4. [unit] `SANDBOXED_ENV` exported by `@test/helpers` equals `SANDBOXED_ENV` exported by `@nathapp/nax-agent`.
5. [integration] `test/integration/confined/sandbox-marker.test.ts` spawns `bun test test/unit/agents/coding-tool-support-session-tmp.test.ts` from `packages/nax` with `NAX_SANDBOXED=1` set and `NAX_TEST_CONFINED` removed in the child environment; the child exits `0` and its stderr (where `bun test` writes its summary) contains `1 skip`.

### US-003

1. [unit] With root `quality.commands` `{ test: "root test" }` and an `apps/web` overlay `{ test: "bun test apps/web" }`, `resolveGateCommands("/repo", ["apps/web"])` returns exactly `[{ name: "test", command: "root test", cwd: "/repo" }]`.
2. [unit] With root commands `{ build: "root build", typecheck: "root typecheck", lint: "root lint", test: "root test" }` and an `apps/web` overlay `{ test: "bun test apps/web" }`, the returned gate names are `["build", "typecheck", "lint", "test"]`.
3. [unit] With root commands `{ test: "root test" }` and a `pkg` overlay `{ build: "bun run build" }`, `resolveGateCommands("/repo", ["pkg"])` returns `[{ name: "test", command: "root test", cwd: "/repo" }, { name: "build@pkg", command: "bun run build", cwd: "/repo/pkg" }]`.
4. [unit] With no root `quality.commands` and an `apps/web` overlay `{ test: "bun test apps/web" }`, `resolveGateCommands("/repo", ["apps/web"])` returns `[{ name: "test@apps/web", command: "bun test apps/web", cwd: "/repo/apps/web" }]`.
5. [unit] With root commands `{ lint: "   " }` and a `pkg` overlay `{ lint: "biome lint" }`, `resolveGateCommands("/repo", ["pkg"])` returns `[{ name: "lint@pkg", command: "biome lint", cwd: "/repo/pkg" }]`, because a blank root command does not configure the key.
6. [unit] With root commands `{ test: "root test" }` and overlays for `pkg-b` and `pkg-a` each `{ test: "pkg test", lint: "pkg lint" }`, `resolveGateCommands("/repo", ["pkg-b", "pkg-a"])` returns gate names `["test", "lint@pkg-b", "lint@pkg-a"]`.
7. [unit] With root commands `{ e2e: "bunx playwright test", e2eSetup: "docker compose up -d" }` and a `.` overlay `{ e2e: "bunx playwright test", e2eSetup: "docker compose -f other.yml up -d" }`, `resolveGateCommands("/repo", ["."])` returns only the root `e2e` gate, with setup `docker compose up -d`.
8. [unit] With root commands `{ e2eSetup: "root setup" }` (no root `e2e`) and a `pkg` overlay `{ e2e: "journey" }`, `resolveGateCommands("/repo", ["pkg"])` returns `[{ name: "e2e@pkg", command: "journey", cwd: "/repo/pkg", setup: "root setup" }]`.
9. [unit] The workflow `runRepoGates` with `fc.packageDirs` `["packages/api"]`, the real `resolveGateCommands` over a stubbed `_qualityGateDeps.loadConfig` returning root `{ test: "root test" }` and a stubbed `_qualityGateDeps.loadPackageOverride` returning `{ test: "api test" }`, and a stubbed `_featureDeps.runQualityGates` that captures its `commands` argument, calls `runQualityGates` with commands whose names are exactly `["test"]`.
10. [unit] With root commands `{ lint: ["biome lint", "tsc --noEmit"] }` and a `pkg` overlay `{ lint: "pkg lint" }`, `resolveGateCommands("/repo", ["pkg"])` returns only the root `lint` gate, because a non-blank array configures the key.
