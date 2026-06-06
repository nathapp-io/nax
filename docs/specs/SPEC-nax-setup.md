# SPEC: `nax setup` — LLM-driven project configuration

<!-- spec-writing: completed-through-phase-6 -->

## Summary

`nax setup` is a new top-level CLI command that configures nax for any repository — **single-package or workspace monorepo** — by detecting the stack, discovering workspace packages, reading each package's real scripts, and asking the default agent to emit a `.nax/config.json` (plus per-package `.nax/mono/<pkg>/config.json` overrides for monorepos) in which **every quality-gate command maps to a script or task that actually exists**. It defaults to report-only (writes `.nax/` files, prints a gap report), with `--fill-scripts` to optionally add missing `type-check`/`lint:fix` scripts. It also finishes the existing throwing `callLLM` placeholder so `nax init --ai` shares the same LLM-call path.

## Motivation

`nax init` is heuristic-and-template only. It runs `detectStack()` and writes static templates; it does **not** discover workspace packages, does **not** generate per-package `.nax/mono/` configs, and does **not** verify that the commands it writes resolve to real scripts. Its single LLM hook, `generateContextWithLLM()` behind `--ai`, is a placeholder that throws `"callLLM not implemented"` (`src/cli/init-context.ts:44-49`).

The result is configs that reference commands the repo does not have. A real example from porting a working setup into an npm monorepo: `quality.commands.test` was set to `npm run build` (so tests never ran), and the config referenced `turbo type-check` / `turbo lint:fix` tasks that did not exist in `turbo.json` or any package. nax then fails its gates for reasons unrelated to the code under test. `nax setup` exists to produce a config whose gates are proven to run before the command exits.

## Design

`nax setup` is a partial extension: new modules under `src/cli/` plus a new prompt builder, wired into the existing CLI registration, init LLM hook, and barrels.

### Approach

Detection is **deterministic** (reuses existing detectors); command-mapping is **LLM-driven** (not regex/AST). The deterministic pass builds a `RepoAnalysis` fact object; the agent receives those facts and proposes the config. Three independent safety nets guard the LLM output:

1. **Schema validation** — the proposed root config is validated with `NaxConfigSchema.safeParse` (`src/config/schemas.ts`); failure triggers one retry, then a fail-closed error.
2. **Command cross-check** — every command string in the proposal is checked against the scripts/tasks recorded in `RepoAnalysis`; an unknown command is dropped and recorded as a gap rather than written.
3. **Real-gate verification** — after writing, one configured gate is executed; a non-zero result is surfaced as a failure.

The LLM call is a **run-kind Operation** (`setupGenerateOp`, `kind: "run"`, `session.role: "setup"`) invoked via `callOp` — run-kind is session-based and **multi-turn**, so the op can refine its proposal across turns (e.g. after a schema-validation parse failure) through `op.retry` / `ctx.sendWithParseRetry`. This is the canonical path (mirrors `plan-draft.ts`); it is **not** a direct `agentManager.completeAs` call — that Layer-3 escape hatch was migrated away from in `auto-approve.ts`. Permissions resolve once at the session opener. The op's `parse` does the schema validation + command cross-check, and throwing a `ParseValidationError` triggers a same-session retry; exhausting `MAX_SETUP_LLM_ATTEMPTS` surfaces as a `NaxError` `SETUP_PLAN_INVALID`. `init-context.ts`'s `callLLM` placeholder is rewired to invoke the same op via `callOp`.

Worked skeleton for the generation core (run-kind op; `parse` holds the validated + cross-checked logic and is the pure unit-test seam):

```ts
// src/operations/setup-generate.ts
export const setupGenerateOp: RunOperation<RepoAnalysis, SetupPlan, NaxConfig> = {
  kind: "run",
  name: "setup-generate",
  stage: "setup",
  session: { role: "setup", lifetime: "fresh" },     // new run-kind session role
  noFallback: true,
  // createSetupRetryStrategy wraps makeParseRetryStrategy(ParseRetryOpts) — mirrors
  // plan-draft's createDraftRetryStrategy; caps attempts at MAX_SETUP_LLM_ATTEMPTS.
  retry: () => createSetupRetryStrategy(MAX_SETUP_LLM_ATTEMPTS),
  build: (analysis) => new SetupPromptBuilder().build(analysis),
  parse(output, analysis) {
    const parsed = parseLLMJson<RawSetupPlan>(output);            // src/utils/llm-json.ts
    const result = NaxConfigSchema.safeParse(parsed.config);      // src/config/schemas.ts
    if (!result.success) {
      throw new ParseValidationError(result.error.message);       // → op.retry (one message arg)
    }
    const { config, gaps } = crossCheckCommands(result.data, analysis); // drop unknown cmds → gaps
    return { config, monoConfigs: buildMonoConfigs(parsed, analysis), gaps };
  },
};

// src/cli/setup-llm.ts — thin wrapper; callOp throws NaxError SETUP_PLAN_INVALID on retry exhaustion
export const generateSetupPlan = (ctx: CallContext, analysis: RepoAnalysis): Promise<SetupPlan> =>
  callOp(ctx, setupGenerateOp, analysis);
```

### Integration

- **Register the command** in `bin/nax.ts` after the `init` block (`bin/nax.ts:136`), using the lazy-import action pattern (`const { setupCommand } = await import("../src/cli/setup")`).
- **Export** `setupCommand` from the `src/cli` barrel (mirror `init`'s export in `src/cli/init.ts`).
- **Rewire** the `callLLM` placeholder at `src/cli/init-context.ts:44-49` to invoke `callOp(ctx, setupGenerateOp, …)` instead of throwing.
- **Reuse detectors (do not duplicate):** `detectStack()` (`src/cli/init-detect.ts`), `discoverWorkspacePackages()` (`src/test-runners/detect/workspace.ts:184`), `detectProjectProfile()` (`src/project/detector.ts:158` — returns `ProjectProfile` with `language` and `testFramework`; `detectTestFramework` is private and must **not** be imported), `detectLanguage()` (`src/project/detector.ts:125`, optional standalone use).
- **Reuse `nax detect`'s test detection (Q2):** `detectTestFilePatternsForWorkspace(workdir, packageDirs)` (`src/test-runners/detect/index.ts:199`) — the exact four-tier detector `nax detect` (`src/commands/detect.ts`) runs — produces the per-package `testFilePatterns` for `PackageFacts`. Do not call `resolveTestFilePatterns` directly or hand-roll detection. `nax detect --apply` (which writes detected patterns into `.nax/config.json` / `.nax/mono/<dir>/config.json`) is the writeback precedent for `setup-write`.
- **Reuse infra:** `resolveDefaultAgent()` (`src/agents/utils.ts:5`), `parseLLMJson()` (`src/utils/llm-json.ts:111`), `NaxConfigSchema` (`src/config/schemas.ts`), `NaxError` (`src/errors`), `callOp` + `RunOperation` (`src/operations`), `makeParseRetryStrategy` / `ParseValidationError` (`src/agents/retry`), collision check pattern `checkInitCollision()` (`src/cli/init.ts:64`).
- **Register the `setup` session role:** add `"setup"` to the `CanonicalSessionRole` union (`src/runtime/session-role.ts:9` — the role-type SSOT consumed by `SessionManager.nameFor`) and to the run-kind role table in `.claude/rules/adapter-wiring.md`. Required because `setupGenerateOp.session.role` is `"setup"`.
- **Prompt builder:** new `SetupPromptBuilder` in `src/prompts/builders/setup-builder.ts`, exported from `src/prompts` barrel (per Prompt Builder Convention — no orphan prompts).
- **Monorepo-awareness:** all package-scoped work uses `packageDir`/`repoRoot`; `process.cwd()` only at the CLI boundary as the `--dir` default; globs pass explicit `cwd`.

### CLI Behavior

- **Flags:** `--dir <path>` (default: cwd), `--fill-scripts`, `--agent <name>`, `--dry-run`, `--force`.
- **Exit 0:** files written and verification gate passed; or `--dry-run` printed the plan; or report-only completed with only gap warnings.
- **Exit 1:** fatal — agent plan invalid after retry (`SETUP_PLAN_INVALID`); `.nax/config.json` already exists and `--force` not passed; verification gate returned non-zero.
- **stdout:** human-readable summary of the written (or, under `--dry-run`, planned) `.nax/config.json` and mono configs.
- **stderr:** gap warnings (missing scripts), downgraded-command warnings, and fatal errors.

### File Format

The agent returns one `SetupPlan` JSON object (internal contract, not a persisted format):

```json
{
  "config": { "name": "myrepo", "version": 1, "quality": { "commands": { "test": "npm run test" } } },
  "monoConfigs": [
    { "relativeDir": "packages/foo", "config": { "quality": { "commands": { "test": "npm run test" } } } }
  ],
  "gaps": [
    { "package": "packages/foo", "missing": "type-check", "suggestion": "tsc --noEmit -p tsconfig.json" }
  ]
}
```

- `config` — the root `.nax/config.json`, a full `NaxConfig`.
- `monoConfigs` — empty for `shape === "single"`; one entry per member package for `shape === "mono"`. `relativeDir` is the package path relative to repo root.
- `gaps` — missing scripts the report surfaces (and `--fill-scripts` can add).

### Failure Handling

- Agent returns invalid JSON or schema-invalid config → `setupGenerateOp.parse` throws `ParseValidationError`, driving the op's same-session parse-retry (`createSetupRetryStrategy(MAX_SETUP_LLM_ATTEMPTS)`, which wraps `makeParseRetryStrategy`; `MAX_SETUP_LLM_ATTEMPTS = 2`); on exhaustion `callOp` surfaces a `NaxError` `SETUP_PLAN_INVALID`, write nothing, exit 1 (**fail-closed** — never persist a broken config).
- A proposed command references a script absent from `RepoAnalysis` → drop that command and record a gap (**fail-open per-command** — does not abort the run).
- Verification gate returns non-zero → report the failing gate and exit 1.
- `.nax/config.json` exists and `--force` not passed → refuse, exit 1.

## Stories

1. **US-001: Repo analysis & types** — no dependencies. Deterministic detection → `RepoAnalysis`.
2. **US-002: LLM plan generation & shared call helper** — depends on US-001. Builds the prompt, calls the agent, validates + cross-checks, rewires the `init-context` placeholder.
3. **US-003: Command wiring, write, report & verify** — depends on US-002. Orchestrator `setupCommand`, file writing, gap report, verification gate, `nax setup` registration.
4. **US-004: `--fill-scripts` gap filling** — depends on US-003. Adds missing scripts (and orchestrator tasks for monorepos).

### Context Files (per story)

**US-001**
- `src/cli/init-detect.ts` — `detectStack()` detection to reuse
- `src/test-runners/detect/workspace.ts` — `discoverWorkspacePackages()` (monorepo-aware)
- `src/project/detector.ts` — `detectProjectProfile()` (language + testFramework; `detectTestFramework` is private)
- `src/test-runners/detect/index.ts` — `detectTestFilePatternsForWorkspace()`, the detector `nax detect` runs (reuse it)
- `src/commands/detect.ts` — `nax detect` detection + `--apply` writeback pattern to mirror

**US-002**
- `src/cli/init-context.ts` — `callLLM` placeholder to rewire (to `callOp(setupGenerateOp)`)
- `src/operations/plan-draft.ts` — run-kind op pattern to mirror (`build`/`parse`/`retry`, `session.role`)
- `src/utils/llm-json.ts` — `parseLLMJson` usage; `src/config/schemas.ts` — `NaxConfigSchema`
- `src/agents/retry.ts` — `makeParseRetryStrategy` / `ParseValidationError`
- `src/cli/setup-analyze.ts` — created by US-001, consumed here

**US-003**
- `src/cli/init.ts` — `initCommand`, `_initDeps`, `checkInitCollision()` collision pattern
- `bin/nax.ts` — command-registration pattern at `:136`
- `src/cli/setup-analyze.ts` — created by US-001, integrated here
- `src/cli/setup-llm.ts` — created by US-002, integrated here
- `src/errors` — `NaxError` base class

**US-004**
- `src/cli/init.ts` — immutable JSON-edit pattern via `_deps`
- `src/cli/setup-analyze.ts` — created by US-001, re-run here to confirm gaps cleared
- `src/cli/setup.ts` — created by US-003, integrated here

### Creates (per story)

- **US-001:** `src/cli/setup-analyze.ts`, `src/cli/setup-types.ts`
- **US-002:** `src/operations/setup-generate.ts` (run-kind op), `src/cli/setup-llm.ts` (`generateSetupPlan` wrapper + `crossCheckCommands`/`buildMonoConfigs`), `src/prompts/builders/setup-builder.ts`
- **US-003:** `src/cli/setup.ts`, `src/cli/setup-write.ts`, `src/cli/setup-verify.ts`
- **US-004:** `src/cli/setup-fill.ts`

### Seams

- **US-002 → US-003:** `setupCommand` invokes `analyzeRepo` then `generateSetupPlan` — declared as integration seam ACs in US-003.
- **US-002 internal:** `init-context.ts` `callLLM` invokes `callOp(setupGenerateOp)` instead of throwing — declared as a seam AC in US-002.
- **US-003 → `bin/nax.ts`:** the `nax setup` command dispatches to `setupCommand` — explicit `[cli]` AC in US-003 ("running `nax setup` from the CLI dispatches to `setupCommand`").
- **US-004 → US-003:** `setupCommand` invokes `fillScripts` only when `--fill-scripts` is passed — declared as a seam AC in US-004.

## Acceptance Criteria

### US-001: Repo analysis & types

- [unit] `analyzeRepo` on a fixture with only a root `package.json` and a lockfile returns a `RepoAnalysis` whose `shape` equals `"single"` and whose `packages` array has length 1.
- [unit] `analyzeRepo` on a fixture declaring `workspaces` with N member packages returns `shape` equal to `"mono"` and a `packages` array of length N.
- [unit] `analyzeRepo` on a fixture containing `bun.lock` returns `pmRunPrefix` equal to `"bun run"` and `pmDlx` equal to `"bunx"`; on a fixture containing `package-lock.json` it returns `pmRunPrefix` equal to `"npm run"` and `pmDlx` equal to `"npx"`.
- [unit] for a package whose `package.json` scripts omit `type-check` and `lint:fix`, the matching `PackageFacts.missingScripts` array includes both `"type-check"` and `"lint:fix"`.
- [unit] `analyzeRepo` returns `orchestrator` equal to `"turbo"` when a root `turbo.json` is present, and `orchestrator` equal to `"none"` for a single-package fixture with no `turbo.json` or `nx.json`.
- [unit] each `PackageFacts` entry exposes a `testFramework` obtained from `detectProjectProfile` (equal to `"jest"` for a fixture using a jest config) and a `testFilePatterns` array obtained from `detectTestFilePatternsForWorkspace`.
- [unit] each `PackageFacts.relativeDir` is the package directory relative to repo root (equal to `"packages/foo"` for a member at that path) and is never an absolute path.

### US-002: LLM plan generation & shared call helper

- [unit] `setupGenerateOp.parse` given a fenced ```json output and a `RepoAnalysis` input returns a `SetupPlan` whose `config` is accepted by `NaxConfigSchema.safeParse`.
- [unit] `setupGenerateOp.parse` given a plan whose `quality.commands.test` names a script absent from the `RepoAnalysis` input returns a `SetupPlan` whose `config.quality.commands` excludes that command and whose `gaps` array records it.
- [unit] `setupGenerateOp.parse` on a schema-invalid `config` throws a `ParseValidationError`, which drives the op's same-session retry; `setupGenerateOp.parse` on output that is not valid JSON (all `parseLLMJson` extraction tiers exhausted) also throws a `ParseValidationError` so the failure is retryable via the same path.
- [unit] `setupGenerateOp.parse` for a `RepoAnalysis` with `shape` equal to `"single"` returns a `SetupPlan` whose `monoConfigs` array is empty; for `shape` equal to `"mono"` with N packages it returns N `monoConfigs` entries.
- [unit] `setupGenerateOp.build(analysis)` returns the string produced by `new SetupPromptBuilder().build(analysis)`.
- [integration] invoking `callOp` with `setupGenerateOp` against an injected session that returns a schema-invalid config on every turn rejects with a `NaxError` whose `code` equals `"SETUP_PLAN_INVALID"` after `MAX_SETUP_LLM_ATTEMPTS` attempts.
- [integration] stub `callOp`; invoke the rewired `callLLM` in `init-context.ts`; assert `callOp` is invoked with `setupGenerateOp` and `callLLM` resolves to its result rather than throwing.

### US-003: Command wiring, write, report & verify

- [cli] running `nax setup --dir <fixture>` with an injected agent exits 0 and produces a `.nax/config.json` whose parsed content is accepted by `NaxConfigSchema.safeParse`.
- [cli] running `nax setup` from the CLI dispatches to `setupCommand` (registered in `bin/nax.ts` after the `init` block via the lazy-import action pattern).
- [integration] when `generateSetupPlan` rejects with a `NaxError` whose `code` equals `"SETUP_PLAN_INVALID"`, `nax setup` exits 1 and writes no `.nax/config.json` (fail-closed — never persist a broken config).
- [cli] running `nax setup` on a monorepo fixture produces one `.nax/mono/<relativeDir>/config.json` per member package; running it on a single-package fixture produces no `.nax/mono` directory.
- [cli] running `nax setup --dry-run` exits 0, creates no files under `.nax`, and prints the planned root config summary to stdout.
- [integration] `setupCommand` on a fixture that already has a `.nax/config.json` and no `--force` resolves without overwriting the existing file and exits non-zero; with `--force` it replaces the file's content with the generated config.
- [integration] when the `SetupPlan` carries `gaps`, `setupCommand` emits each gap as a warning on stderr and still exits 0 in report-only mode.
- [integration] `setupCommand` invokes the configured verification gate once for a leaf package (stub the gate runner; assert it is called) and exits non-zero when the gate runner reports a non-zero result.
- [integration] stub `analyzeRepo`; run `setupCommand`; assert `analyzeRepo` is invoked once with the resolved workdir, and that `generateSetupPlan` is invoked with the `RepoAnalysis` that `analyzeRepo` returned.

### US-004: `--fill-scripts` gap filling

- [unit] `fillScripts` on a `PackageFacts` missing `type-check` writes a `type-check` script equal to `"tsc --noEmit -p tsconfig.json"` into that package's `package.json` and leaves its existing scripts present and unchanged.
- [unit] invoking `fillScripts` twice on the same package yields a `package.json` whose `scripts` map has a single `type-check` key — the second run adds no duplicate entry.
- [unit] `fillScripts` for `shape` equal to `"mono"` with a turbo orchestrator adds a `type-check` task to `turbo.json` and a `type-check` passthrough script to the root `package.json`; for `shape` equal to `"single"` it adds the `type-check` script to the root `package.json` only and writes no orchestrator task.
- [integration] after `fillScripts` runs for the filled gates, a subsequent `analyzeRepo` over the same fixture returns `PackageFacts` whose `missingScripts` no longer lists those gates.
- [integration] running `setupCommand` with `--fill-scripts` invokes `fillScripts` before the write step (stub `fillScripts`; assert invoked); running `setupCommand` without the flag does not invoke `fillScripts`.
