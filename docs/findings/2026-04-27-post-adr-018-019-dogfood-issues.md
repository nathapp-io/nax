# Post ADR-018 / ADR-019 nax run issues — dogfood findings

**Date:** 2026-04-27
**Reporter:** williamkhoo
**Run log:** `/home/williamkhoo/Desktop/projects/nathapp/nax-dogfood/fixtures/hello-lint/.nax/features/hello-lint/runs/2026-04-27T13-29-07.jsonl`
**Project under test:** `nax-dogfood/fixtures/hello-lint` (single-package TS fixture)

Four user-visible issues surfaced on the first dogfood run after ADR-018 (NaxRuntime) and ADR-019 (callOp / runtime-bound dispatch) landed. Issues 3 and 4 share a single root cause — a wiring gap where execution-layer `PipelineContext` literals do not include `runtime`.

---

## Issue 1 — Prompt audit appears missing despite global `enabled: true`

**Symptom:** Global config has `agent.promptAudit.enabled: true`, but the user reports "no prompt audit found".

**Reality:** Audit *is* being written — to the wrong place, in a different format than expected.

- Actual file: `.nax/audit/b76b6191-82f6-48e2-855a-1aed84759c23.jsonl` (15 entries).
- Expected location (per gitignore + legacy module): `.nax/prompt-audit/`.

**Root causes (compounding):**

1. [`src/runtime/index.ts:78`](../../src/runtime/index.ts#L78) defaults the audit dir to `.nax/audit/`:
   ```ts
   const auditDir = config.agent?.promptAudit?.dir ?? join(workdir, ".nax", "audit");
   ```
2. [`src/utils/gitignore.ts:23`](../../src/utils/gitignore.ts#L23) ignores `.nax/prompt-audit/` — so the new `.nax/audit/` files **are not gitignored** and risk being committed.
3. The legacy [`src/agents/acp/prompt-audit.ts`](../../src/agents/acp/prompt-audit.ts) (`writePromptAudit`) is exported via the ACP barrel ([`src/agents/acp/index.ts:14`](../../src/agents/acp/index.ts#L14)) but called from nowhere — dead code.
4. Format changed from one human-readable `.txt` per prompt (sortable by `ls`, browsable per-stage / per-turn) to a single JSONL line per call. Operator workflow changes silently.

**Recommended fix:**
- Change the default in `createRuntime` to `.nax/prompt-audit/` so the gitignore template and the writer agree.
- Decide on the legacy module: either delete it (and its export) or restore the per-prompt-file behaviour as an opt-in audit mode.

---

## Issue 2 — Doubled cache path for test-pattern detection

**Symptom (from log lines 52, 57):**
```
"workdir":"/home/williamkhoo/.../hello-lint/home/williamkhoo/.../hello-lint"
```
The path `/home/.../hello-lint` is concatenated with itself, so the cache file lives at:
```
/home/.../hello-lint/home/.../hello-lint/.nax/cache/test-patterns.json
```
instead of:
```
/home/.../hello-lint/.nax/cache/test-patterns.json
```

**Root cause:** [`src/context/engine/providers/test-coverage.ts:69`](../../src/context/engine/providers/test-coverage.ts#L69) calls
```ts
resolveTestFilePatterns(this.config, request.repoRoot, request.packageDir);
```
with `request.packageDir` set to an **absolute** path. Per the pipeline stage at [`src/pipeline/stages/context.ts:127`](../../src/pipeline/stages/context.ts#L127):
```ts
packageDir: ctx.workdir,   // absolute path
```

The resolver at [`src/test-runners/resolver.ts:170`](../../src/test-runners/resolver.ts#L170) then does:
```ts
const detectionWorkdir = packageDir ? join(workdir, packageDir) : workdir;
```

`path.join('/a/x', '/a/x')` returns `/a/x/a/x` — `join` does **not** strip a leading slash from the second arg. The doubled path is then handed to `cachePath()` ([`src/test-runners/detect/cache.ts:62`](../../src/test-runners/detect/cache.ts#L62)) → cache miss every time.

This violates the `packageDir` contract: per [`monorepo-awareness.md`](../../.claude/rules/monorepo-awareness.md) and the resolver doc-comment, `packageDir` is **relative** to `workdir`.

**Recommended fix:**
- In `test-coverage.ts`, pass `relative(request.repoRoot, request.packageDir)` (or `undefined` when they're equal).
- Defensive hardening in `resolveTestFilePatterns`: detect absolute `packageDir` and either strip-and-relativize against `workdir` or throw a clear `INVALID_PACKAGE_DIR` error so the contract is enforced rather than silently producing garbage.

---

## Issue 3 — Semantic + adversarial reviewers take the legacy `agentManager.run` path

**Symptom (jsonl):**
```
"adversarial":"LLM call complete (legacy)"
"semantic":"LLM call complete (legacy)"
```

**Expected:** Both reviewers route through `callOp(adversarialReviewOp, …)` / `callOp(semanticReviewOp, …)` per ADR-019 §5 — going through `runWithFallback` + `buildHopCallback` so middleware (audit, cost, cancellation, logging) fires uniformly.

**Root cause:** Both reviewers gate the ADR-019 branch on `if (runtime)`:
- [`src/review/semantic.ts:512-516`](../../src/review/semantic.ts#L512-L516)
- [`src/review/adversarial.ts:402-410`](../../src/review/adversarial.ts#L402-L410)

The orchestrator forwards `ctx.runtime` correctly ([`src/review/orchestrator.ts:541`](../../src/review/orchestrator.ts#L541)). The break is upstream: the per-story `pipelineContext` built at [`src/execution/iteration-runner.ts:160-185`](../../src/execution/iteration-runner.ts#L160-L185) **does not include `runtime`** (or `packageView`):

```ts
const pipelineContext: PipelineContext = {
  config: effectiveConfig,
  rootConfig: ctx.config,
  prd,
  story,
  // …
  agentManager: ctx.agentManager,
  pluginProviderCache: ctx.pluginProviderCache,
  // ⚠️ runtime: ctx.runtime  ← missing
  // ⚠️ packageView           ← missing
};
```

So `ctx.runtime === undefined` for every story-scope stage. Reviewers fall back, middleware doesn't fire on the review hops, per-check cost is undercounted, audit may be incomplete.

**Recommended fix:** thread `runtime: ctx.runtime` (and `packageView` once known) into the `pipelineContext` literal in `iteration-runner.ts`. Verify other story-context constructors do the same:
- [`src/execution/parallel-worker.ts:52-63`](../../src/execution/parallel-worker.ts#L52-L63) is OK *iff* its caller's `context` already contains `runtime` (uses `...context` spread).
- [`src/execution/merge-conflict-rectify.ts`](../../src/execution/merge-conflict-rectify.ts) — same pattern, needs verification.

---

## Issue 4 — `CALL_OP_NO_RUNTIME` from acceptance-setup

**Symptom (terminal):**
```
[21:41:05] ℹ acceptance-setup No acceptance meta — generating acceptance tests
NaxError: runtime required for acceptance-setup callOp
 context: { stage: "acceptance-setup" }
 code: "CALL_OP_NO_RUNTIME"
   at execute (acceptance-setup.ts)
   at regenerateAcceptanceTest (acceptance-helpers.ts)
   at runAcceptanceLoop (acceptance-loop.ts)
```

**Root cause:** Same class of bug as Issue 3. [`src/execution/lifecycle/acceptance-loop.ts:126-148`](../../src/execution/lifecycle/acceptance-loop.ts#L126-L148) builds `acceptanceContext: PipelineContext` without `runtime`:

```ts
const acceptanceContext: PipelineContext = {
  config: ctx.config,
  rootConfig: ctx.config,
  prd,
  story: firstStory,
  // …
  agentManager: ctx.agentManager,
  acceptanceTestPaths: ctx.acceptanceTestPaths,
  // ⚠️ runtime missing
};
```

The trace path:
```
runAcceptanceLoop                                  (acceptance-loop.ts)
  → regenerateAcceptanceTest(testPath, acceptanceContext)
                                                   (acceptance-helpers.ts)
  → acceptanceSetupStage.execute(ctx)              (pipeline/stages/acceptance-setup.ts)
  → _acceptanceSetupDeps.callOp(ctx, …)            ← throws CALL_OP_NO_RUNTIME
```

The `callOp` dep at [`src/pipeline/stages/acceptance-setup.ts:154`](../../src/pipeline/stages/acceptance-setup.ts#L154) explicitly throws when `pipelineCtx.runtime` is missing — fail-fast, but the upstream wiring violation prevents it from ever working in this code path.

This crash happens any time the acceptance loop has to regenerate the test (stub detection, fingerprint mismatch, missing meta) — i.e. the first run on a fresh fixture, or any run after AC edits.

**Recommended fix:** add `runtime: ctx.runtime` to the `acceptanceContext` literal. While auditing this file, the `postRunPipeline` context at [`src/execution/unified-executor.ts:551-561`](../../src/execution/unified-executor.ts#L551-L561) is also missing `runtime`, `agentManager`, `projectDir`, etc. — the `as unknown as PipelineContext` cast hides the omission, and the same crash will resurface there as soon as the postRunPipeline calls any callOp-using stage.

---

## Common pattern across issues 3 + 4 + the postRunPipeline cast

All three are the **same wiring gap**: execution-layer `PipelineContext` object literals were not updated when ADR-018 introduced `ctx.runtime` / `ctx.packageView`. Per [`pipeline/types.ts:151-157`](../../src/pipeline/types.ts#L151-L157):

```ts
runtime?: import("../runtime").NaxRuntime;
packageView?: import("../runtime").PackageView;
```

These are optional in the type, so missing them compiles fine — but every consumer downstream (`callOp`, `runSemanticReview`, `runAdversarialReview`, etc.) treats `runtime === undefined` as either a fail-open fallback (silent functional regression) or a hard error (Issue 4).

**Sweep candidates** — every place that constructs a fresh `PipelineContext` and isn't a pure test fixture should thread `runtime`:

```bash
grep -nE 'PipelineContext\s*=\s*\{|PipelineContext>?\s*=\s*\{' src/execution/ src/pipeline/ -r
```

Known offenders found in this investigation:
- [`src/execution/iteration-runner.ts:160`](../../src/execution/iteration-runner.ts#L160) — per-story (Issue 3)
- [`src/execution/lifecycle/acceptance-loop.ts:126`](../../src/execution/lifecycle/acceptance-loop.ts#L126) — acceptance (Issue 4)
- [`src/execution/unified-executor.ts:551`](../../src/execution/unified-executor.ts#L551) — postRunPipeline (latent — same crash pending)

The `as unknown as PipelineContext` cast in unified-executor.ts is also worth flagging — it bypasses type-safety on a structurally-incomplete literal. Better to declare `Pick<PipelineContext, …>` for the post-run pipeline if it really only needs a subset, or fully populate the literal.

---

## Suggested PR breakdown

One PR per concern, so each can be reviewed against the relevant ADR / contract:

1. **Audit dir consistency** — change `createRuntime` default to `.nax/prompt-audit/`; either delete the legacy `writePromptAudit` module or restore its per-file format as an opt-in. Update tests if any pinned `.nax/audit/`.
2. **Test-coverage provider packageDir** — relativise `request.packageDir` against `request.repoRoot` before passing to `resolveTestFilePatterns`; add a defensive guard (or thrown error) inside the resolver for absolute `packageDir`.
3. **Runtime threading** — add `runtime: ctx.runtime` (and `packageView`) to all execution-layer `PipelineContext` literals. Add a regression test that asserts every PipelineContext entering a stage has `runtime` defined when running under `executeUnified()`.

The runtime-threading PR is the highest-impact: it silently disables ADR-019 dispatch for review and will break any other `callOp`-using stage added on top of the current code.
