# Finish PR, Escalation and the Concrete `FinishOps` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `src/finish/` the two halves it still lacks — everything that talks to a forge (PR context, body, title, draft-open, push-and-promote, escalation delivery) and the concrete `FinishOps` object that binds those plus plan 3's three `RunOperation`s to the state machine — so that after this plan `runFinishMachine` can be driven end to end with nothing stubbed but the process boundary.

**Architecture:** The PR body stays a deterministic string join over artifacts on disk: a loader (`pr/context.ts`) assembles a `FinishPrContext` from `prd.json`, `status.json`, the audit trail, a diffstat and the repo template; a pure renderer (`pr/body.ts`) turns it into markdown merged into the repo's own PR template. Forge traffic goes through `@/forge`, which already owns detection, `openPr`, `hasOpenPr`, `viewArgv`, `extractUrl` and `findPrTemplate` — this plan adds only what `src/forge/` does not have (promote-to-ready, body edit) and moves the one shared module still living under `flows/`. `ops-impl.ts` is a factory: it closes over a `CallContext`, per-phase model selections and forge deps, and returns a `FinishOps` whose LLM methods are `callOp` calls with a per-phase `sessionOverride.role` and whose forge methods are the modules below. Nothing is wired into the runner; `flows/nax-finish/` keeps running untouched.

**Tech Stack:** TypeScript, Bun (test runner and toolchain), Biome (format/lint).

**Spec:** `docs/superpowers/specs/2026-08-18-native-nax-finish-design.md` — this plan implements the PR/escalation half of **cutover step 2**. Read sections 4.2 (module decomposition), 4.5 (operations) and 4.7 (the draft-PR lifecycle, D7) before starting.

**Predecessors:**
- `docs/superpowers/plans/2026-08-18-forge-shared-module.md` — PR #1626. `src/forge/` exists.
- `docs/superpowers/plans/2026-08-18-finish-core.md` — PR #1627. `src/finish/` core exists.
- `docs/superpowers/plans/2026-08-18-finish-review-ops.md` — PR #1628. The review layer and the three `RunOperation`s exist.

**Read before starting, in this order:** `src/finish/ops.ts` (the contract this plan fills), `src/finish/machine.ts` (its only consumer — every call site and every "must not throw" claim below is stated there), `src/forge/index.ts` (what you must not re-port), `src/finish/operations/index.ts` (what plan 3 already gives you).

## Global Constraints

Unchanged from plans 2 and 3; repeated because they are the ones a worker trips over.

- Runtime is **Bun**. `src/` is Bun-native. **This plan does not delete anything under `flows/`** — it is still the live implementation until plan 5. The single exception is Task 1, which *moves* one file that `src/` already imports.
- **Duplication with `flows/nax-finish/` is expected for the whole of this plan.** Both trees exist; only one is wired. Do not edit `flows/` (Task 1's deletion aside) and do not import from `flows/` in new code.
- **File size caps:** 600 lines for `src/`, 800 for `test/` (`scripts/check-file-sizes.ts`). `wc -l` every file before you add to it.
- **No emojis** in code, comments, or documentation.
- **Imports:** `@/` alias for other modules, **relative inside `src/finish/`** (`./types`, `../route`) and inside `src/forge/`, because both have a barrel and `scripts/check-alias-internals.ts` flags a value import reaching past one. `@/forge`, `@/config`, `@/operations`, `@/errors` — never their subpaths from outside.
- `scripts/check-deep-relatives.ts` has a frozen baseline — **new tests import `@/finish`, `@/forge` and `@test/helpers`**, never `../../../src/...` or `../../helpers`. Copy the style of `test/unit/finish/gates-quality.test.ts`. If the baseline must move, use `bun run check:deep-relatives:update` and say so in the commit.
- **Temp directories in tests:** `makeTempDir` / `cleanupTempDir` / `withTempDir` from `test/helpers/temp.ts`. `.nax/rules/forbidden-patterns-tests.md` forbids hand-rolled `rm -rf` cleanup.
- **Errors:** `NaxError` from `src/errors.ts` with a `FINISH_*` / `FORGE_*` code. `scripts/check-nax-error.ts` has a baseline — do not add violations.
- **Commits:** conventional commits. Attribution is disabled globally; no co-author trailers.
- **Branch:** `feat/finish-pr-escalate`, created from `main` (already created alongside this plan).
- **Gates before every commit:** `bun x tsc --noEmit`, `bun run lint`, and the task's own tests. A pre-commit hook runs the full static-check suite and will reject the commit if anything fails.

---

## Locked Decisions

Read these before Task 1. They were settled against the real code; do not re-derive them.

**D4.1 — `pr-template-merge.ts` moves to `src/forge/template-merge.ts`.** It is the one module under `flows/` that `src/` already imports (`src/plugins/builtin/auto-pr/pr-body.ts:16`, via the `@flows/*` tsconfig alias). Finish's native body builder needs it too, and plan 5 deletes `flows/`, so it must move now rather than acquire a second consumer of a doomed path. It lands in `src/forge/` and not `src/finish/` because auto-pr must not import `@/finish` internals, and `src/forge/` is already the shared home for the sibling concern (`findPrTemplate`). The `flows/` copy is **left in place** — `flows/` cannot import `src/` and the flow still runs — and dies with the rest of `flows/` in plan 5. The now-unused `@flows/*` alias in `tsconfig.json` also stays until then.

**D4.2 — the PR subtree is `src/finish/pr/{context,body,open,index}.ts`.** `flows/nax-finish/steps/pr-body.ts` is 462 lines doing two jobs (load artifacts, render markdown). Split at that seam: the loader is I/O and fail-open policy, the renderer is pure and is where every future body change lands. Both stay well under the 600-line cap, and the renderer being pure is what lets its tests run with no disk at all.

**D4.3 — `postEscalation` may throw; `FinishOps.escalate` may not.** The ported `postEscalation` keeps its `FinishError` throws (a comment that could not be posted and a draft that could not be opened are different failures and the message says which). The *adapter* in `ops-impl.ts` wraps it in try/catch and returns `{ deliveryError }`, which is what `src/finish/ops.ts` documents and what `machine.ts`'s `doEscalate` expects. Do not soften `postEscalation` into a non-throwing function; do not let the adapter propagate.

**D4.4 — `narrate` must swallow everything.** `machine.ts`'s `finishTerminal` calls `ops.narrate` *after* `ops.promotePr`, inside the outer try. A throw there sends an already-promoted green run to `doEscalate` and rewrites its status to `escalated`. `finishNarrativeOp` already has `recover` for an empty reply, but `detectForge`, the context load and the body edit can all still throw, so the whole `narrate` body is wrapped in try/catch and warns — the same reasoning `flows/nax-finish/steps/pr-narrative.ts` states for `amendPrBodyNode`.

**D4.5 — a draft that cannot be opened is skipped, not fatal.** `openDraftPr` returns `null` on every unhappy path: no forge detected, `hasOpenPr` throwing (`FORGE_PR_LIST_FAILED` — BUG-8 made it throw precisely so the caller decides, and the safe decision here is "do not open a second one"), or `openPr` returning `success: false`. The draft is a convenience; the terminal `promotePr` creates the PR when none exists. Failing the run at step 3 for it would throw away work that is otherwise fine.

**D4.6 — `promotePr` pushes first, and a push failure is fatal.** Faithful to `open_pr` in `flows/nax-finish/nax-finish.flow.ts`: `commitAndPush(workdir, branch, "fix(<feature>): nax-finish automated fixes")` then open-or-promote. Both throw on failure, and both *should* — a branch that will not push has no PR to promote, and `machine.ts`'s outer catch turns the throw into an escalation, which is the #1399 requirement that a dead end always reaches a human. `commitAndPush` and `PUSH_TIMEOUT_MS` already exist in `src/finish/commit.ts` and are currently called by nothing; this is their consumer.

**D4.7 — escalation pushes partial fixes best-effort.** Also faithful to the flow: the escalate path tries `commitAndPush` so a human sees the partial work, and on failure appends a `syncNote` to the comment rather than losing the escalation itself. The push is inside its own try/catch, never outside.

**D4.8 — template mode and section map are factory options, not config reads.** They live at `finish.autoFlow.prBody` today, and `autoFlow` is the plugin-shaped block plan 5 reshapes. `createFinishOps` takes `prBody?: { template?: TemplateMode; sectionMap?: Record<string, string> }` defaulting to `{ template: "merge", sectionMap: {} }`, and plan 5 supplies it from config. Same for the four model selections and `preferTelegram`. This plan reads no config for PR composition.

**D4.9 — `callOp` is injected through `_finishOpsDeps`.** `src/finish/ops-impl.ts` exports `export const _finishOpsDeps = { callOp }` and calls `_finishOpsDeps.callOp(...)`, matching `_callOpDeps` / `_autoPrDeps` / `_finishGitDeps`. Without it, every test of the factory needs a `NaxRuntime`. The seam is exported from `@/finish` so tests reach it without a deep relative.

**D4.11 — the default `ForgeDeps` implementation moves into `src/forge/`.** `ForgeDeps` is `src/forge/`'s own contract but the module ships no default implementation, so the only one in the repo is `defaultRun` / `defaultReadText` inside `src/plugins/builtin/auto-pr/index.ts`. `src/finish/` must not import from `@/plugins` — that inverts the layering, and the plugin's copy is wrapped in a test seam (`_autoPrDeps`) with its own baseline of tests. Task 1 therefore adds `src/forge/deps.ts` exporting `defaultForgeDeps: ForgeDeps`, a straight lift of those two functions including the wall-clock cap (a wedged `gh` must not hang a run's completion phase). Auto-PR keeps its own copy for now; converging it is a plan 5 opportunity, not this plan's scope.

**D4.10 — per-phase reviewer role goes through `sessionOverride.role`.** `finishReviewOp.session.role` is the static default `"finish-review-spec"`; the factory passes `{ ...ctx, sessionOverride: { role: phase === "spec" ? "finish-review-spec" : "finish-review-quality" } }`. This is settled in plan 3's header comment and matches `src/plan/critic.ts`. Do not add a resolver field to `RunOperation`.

---

## File Structure

**Created:**

| File | Responsibility |
| --- | --- |
| `src/forge/template-merge.ts` | Moved from `flows/nax-finish/pr-template-merge.ts`. `mergeTemplate`, `BodySection`, `TemplateMode`, `MergeOptions`, `DEFAULT_SECTION_ALIASES`. |
| `src/forge/deps.ts` | `defaultForgeDeps` — the default `ForgeDeps` implementation (D4.11). |
| `src/finish/pr/context.ts` | `loadFinishPrContext`, `FinishPrContext`, `FinishPrStory`, `_finishPrDeps`. Artifact reads, diffstat, template load. All fail-open. |
| `src/finish/pr/body.ts` | `buildFinishBody`, `buildFinishTitle`. Pure renderers over `FinishPrContext`. |
| `src/finish/pr/open.ts` | `openDraftFinishPr`, `openOrPromotePr`, `updatePrBody`, `parseView`. |
| `src/finish/pr/index.ts` | Barrel for the PR subtree. |
| `src/finish/escalate.ts` | `buildEscalationComment`, `postEscalation`, `EscalationOutcome`. |
| `src/finish/ops-impl.ts` | `createFinishOps`, `FinishOpsDeps`, `_finishOpsDeps`. |
| `test/unit/forge/template-merge.test.ts` | Ported from `test/unit/flows/nax-finish/pr-template-merge.test.ts`. |
| `test/unit/finish/pr-context.test.ts` | Loader: artifact parsing, fail-open paths, diffstat pathspec. |
| `test/unit/finish/pr-body.test.ts` | Renderer, ported from `test/unit/flows/nax-finish/pr-body.test.ts`. |
| `test/unit/finish/pr-open.test.ts` | Draft open, promote, body edit, `parseView`. |
| `test/unit/finish/escalate.test.ts` | Comment shape, channel selection, failure modes. |
| `test/unit/finish/ops-impl.test.ts` | The factory: role overrides, non-throwing contracts, adapter shapes. |
| `test/unit/finish/machine-end-to-end.test.ts` | `runFinishMachine` driven by a real `createFinishOps` over fake process/disk boundaries. |

**Modified:**

| File | Change |
| --- | --- |
| `src/plugins/builtin/auto-pr/pr-body.ts` | Import `mergeTemplate` from `@/forge`, not `@flows/nax-finish/pr-template-merge`. |
| `src/forge/index.ts` | Export the template-merge surface. |
| `src/finish/index.ts` | Export the PR subtree, escalation and the ops factory. |

**Deleted:**

| File | Why |
| --- | --- |
| `flows/nax-finish/pr-template-merge.ts` | Moved to `src/forge/` (D4.1). Nothing under `flows/` imports it — verify with the grep in Task 1 Step 1 before deleting. |
| `test/unit/flows/nax-finish/pr-template-merge.test.ts` | Moves with it. |

---

### Task 1: Move the template merger into `src/forge/`

**Files:**
- Create: `src/forge/template-merge.ts` (moved content)
- Modify: `src/forge/index.ts`, `src/plugins/builtin/auto-pr/pr-body.ts:16`
- Delete: `flows/nax-finish/pr-template-merge.ts`, `test/unit/flows/nax-finish/pr-template-merge.test.ts`
- Test: `test/unit/forge/template-merge.test.ts` (moved content)

**Interfaces:**
- Produces: `mergeTemplate(template: string | null | undefined, sections: BodySection[], opts?: MergeOptions): string`; `interface BodySection { key: string; heading: string; body: string }`; `type TemplateMode = "merge" | "strict" | "ignore"`; `interface MergeOptions { mode?: TemplateMode; sectionMap?: Record<string, string> }`; `DEFAULT_SECTION_ALIASES: Record<string, string>`. Tasks 3 and 6 consume these; `src/plugins/builtin/auto-pr/pr-body.ts` already does.

- [ ] **Step 1: Confirm nothing under `flows/` still imports it**

```bash
grep -rn "pr-template-merge" flows/ src/ test/ scripts/ tsconfig.json
```

Expected: exactly three importers — `flows/nax-finish/steps/pr-body.ts`, `src/plugins/builtin/auto-pr/pr-body.ts`, and the two test files. **If `flows/nax-finish/steps/pr-body.ts` imports it, the file cannot be deleted yet** (`flows/` cannot import `src/`): in that case copy it to `src/forge/template-merge.ts`, leave the `flows/` copy and its test alone, and note in the commit that the duplicate dies in plan 5. Everything else in this task is unchanged.

- [ ] **Step 2: Move the file and its test**

```bash
git mv flows/nax-finish/pr-template-merge.ts src/forge/template-merge.ts
git mv test/unit/flows/nax-finish/pr-template-merge.test.ts test/unit/forge/template-merge.test.ts
```

Then in `src/forge/template-merge.ts` replace the "Lives under `flows/` ... because `flows/` is the more constrained runtime" paragraph of the header comment with:

```
 * Lives in `src/forge/` because both consumers are here: the auto-PR plugin's
 * body builder and `src/finish/pr/body.ts`. It was under `flows/` while the
 * finish flow was the only other caller; `flows/` cannot import `src/`, so the
 * flow keeps its own copy until plan 5 deletes that tree.
```

Leave every other line of the module byte-identical — the alias table and the merge semantics are settled behaviour (nax#1504, nax#1477) and this task changes neither.

- [ ] **Step 3: Repoint the two importers**

`src/forge/index.ts`, appended to the existing exports:

```ts
export type { BodySection, MergeOptions, TemplateMode } from "./template-merge";
export { DEFAULT_SECTION_ALIASES, mergeTemplate } from "./template-merge";
```

`src/plugins/builtin/auto-pr/pr-body.ts:16`:

```ts
import { type BodySection, type MergeOptions, mergeTemplate } from "@/forge";
```

In `test/unit/forge/template-merge.test.ts`, change the import to `@/forge` (it is a new file in a directory whose sibling tests already use the alias).

- [ ] **Step 4: Add the default `ForgeDeps` implementation (D4.11)**

Create `src/forge/deps.ts`:

```ts
/**
 * The default `ForgeDeps`: subprocess execution and file reads for every
 * function in this module.
 *
 * Lifted from `defaultRun` / `defaultReadText` in
 * `src/plugins/builtin/auto-pr/index.ts`, which was the only implementation of
 * this module's own contract. `src/finish/` needs one too and must not import
 * from `@/plugins`, so it lives with the contract instead. stdout and stderr
 * are read concurrently with `proc.exited` so non-trivial output cannot
 * deadlock, under a wall-clock cap so a wedged `gh` / `glab` / `git push`
 * cannot hang a run's completion phase.
 */
```

Copy `defaultRun`, `defaultReadText` and the `DEFAULT_SUBPROCESS_TIMEOUT_MS` constant from `src/plugins/builtin/auto-pr/index.ts` verbatim — including the `exitCode === 0 ? 124 : exitCode` timeout mapping — and export:

```ts
export const defaultForgeDeps: ForgeDeps = { run: defaultRun, readText: defaultReadText };
```

Add to `src/forge/index.ts`: `export { defaultForgeDeps } from "./deps";`. Do not modify the auto-PR plugin's copy in this task.

- [ ] **Step 5: Run the moved test plus every consumer's test**

Run: `bun test test/unit/forge/ test/unit/plugins/auto-pr* test/unit/flows/nax-finish/pr-body.test.ts`
Expected: PASS, with no change to any assertion. The flow's own `pr-body.test.ts` still passes because the `flows/` copy is untouched (or, if Step 1 found the flow importing it, because the copy stayed).

- [ ] **Step 6: Static checks and commit**

```bash
bun x tsc --noEmit && bun run lint && bun test test/unit/forge/
git add -A
git commit -m "refactor(forge): move the PR template merger and default deps into src/forge"
```

---

### Task 2: The PR context loader

**Files:**
- Create: `src/finish/pr/context.ts`
- Test: `test/unit/finish/pr-context.test.ts`

**Interfaces:**
- Consumes: `readRounds` and `AuditTarget` from `../audit`; `readSpecSummary`, `resolveNarrative`, `resolveTitle` from `../operations`; `findPrTemplate` and `ForgeKind` from `@/forge`; `TemplateMode` from `@/forge`; `featureDir` from `@/config`.
- Produces:

```ts
export interface FinishPrStory { id: string; title: string; acCount: number }

export interface FinishPrContext {
  feature: string;
  stories: FinishPrStory[];
  outOfScope: string[];
  acceptance?: string;
  regression?: string;
  gatesRan: string[];
  diffstat?: string;
  artifactSummary?: string;
  template?: string;
  templateMode?: TemplateMode;
  templateSectionMap?: Record<string, string>;
  narrative?: string;
  title: string;
  rounds: FinishRound[];
  run: { durationMs?: number; storiesPassed?: number; storiesTotal?: number };
}

export interface LoadPrContextArgs {
  state: FinishState;
  audit: AuditTarget;
  gatesRan: string[];
  forge?: ForgeKind;
  narrative?: string;
  title?: string;
  prBody?: { template?: TemplateMode; sectionMap?: Record<string, string> };
}

export async function loadFinishPrContext(args: LoadPrContextArgs): Promise<FinishPrContext>;
export const _finishPrDeps: {
  run(cmd: string[], opts: { cwd: string }): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  readText(path: string): Promise<string | null>;
  warn(message: string, details: { path: string; error: unknown }): void;
};
```

Task 3 consumes `FinishPrContext`; Task 6 calls `loadFinishPrContext`.

**Port notes.** This is `loadFinishPrContext` from `flows/nax-finish/steps/pr-body.ts:217-268` plus its private helpers `readJson`, `storiesFrom`, `runGitDiff`, `runDiffstat`, `loadTemplate` and the `NAX_ARTIFACT_PATHSPEC` constant, with four substitutions:

1. Input is a `FinishState` + `AuditTarget`, not a `FinishInput`. `feature`, `workdir`, `base` and `specPath` are already fields of `FinishState`; `readRounds` takes the `AuditTarget`.
2. The PRD path is `join(featureDir(state.workdir, state.feature), "prd.json")` and status is its sibling `status.json`. The flow took a caller-supplied `prdPath` because acpx handed it one; in-process `featureDir` is the SSOT (`src/config/paths.ts:117`) and open-coding `.nax` is what shipped the stray-directory bug it warns about.
3. `findPrTemplate(workdir, forge, deps)` comes from `@/forge` and takes `ForgeKind`, not the flow's `Forge`.
4. `templateMode` / `templateSectionMap` come from `args.prBody` (D4.8), not from a config read.

Everything else is a faithful port, **including every fail-open path and the comments explaining them**: `readJson` warns and returns `undefined` on a genuine read failure but is silent on ENOENT; `runDiffstat` returns `{}` on an empty `base` and `undefined` on any non-zero exit or throw; `loadTemplate` returns `undefined` when the forge is unknown or the read throws. The `NAX_ARTIFACT_PATHSPEC = "**/.nax/**"` glob and both `:(glob...)` pathspecs are load-bearing — copy them exactly, comment included.

- [ ] **Step 1: Write the failing tests**

`test/unit/finish/pr-context.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { _finishPrDeps, createFinishState, loadFinishPrContext } from "@/finish";
import { cleanupTempDir, makeTempDir } from "@test/helpers";

const originalDeps = { ..._finishPrDeps };
let dir: string;

function stateFor(workdir: string) {
  return createFinishState({
    feature: "demo",
    workdir,
    branch: "feat/demo",
    runId: "run-1",
    base: "origin/main",
    specPath: ".nax/features/demo/spec.md",
  });
}

beforeEach(async () => {
  dir = await makeTempDir("pr-context");
});

afterEach(async () => {
  Object.assign(_finishPrDeps, originalDeps);
  await cleanupTempDir(dir);
});

describe("loadFinishPrContext", () => {
  test("reads stories and out-of-scope from the feature's prd.json", async () => {
    const featureDirPath = join(dir, ".nax", "features", "demo");
    await mkdir(featureDirPath, { recursive: true });
    await writeFile(
      join(featureDirPath, "prd.json"),
      JSON.stringify({
        userStories: [{ id: "US-001", title: "First", acceptanceCriteria: [1, 2, 3] }],
        outOfScope: ["not this"],
      }),
    );
    _finishPrDeps.run = async () => ({ exitCode: 1, stdout: "", stderr: "" });

    const ctx = await loadFinishPrContext({
      state: stateFor(dir),
      audit: { auditDir: join(dir, "audit"), runId: "run-1" },
      gatesRan: ["lint"],
    });

    expect(ctx.stories).toEqual([{ id: "US-001", title: "First", acCount: 3 }]);
    expect(ctx.outOfScope).toEqual(["not this"]);
    expect(ctx.gatesRan).toEqual(["lint"]);
  });

  test("drops a story row whose id or title is not a string", async () => {
    const featureDirPath = join(dir, ".nax", "features", "demo");
    await mkdir(featureDirPath, { recursive: true });
    await writeFile(
      join(featureDirPath, "prd.json"),
      JSON.stringify({ userStories: [{ id: 7, title: "Bad" }, { id: "US-002", title: "Good" }] }),
    );
    _finishPrDeps.run = async () => ({ exitCode: 1, stdout: "", stderr: "" });

    const ctx = await loadFinishPrContext({
      state: stateFor(dir),
      audit: { auditDir: join(dir, "audit"), runId: "run-1" },
      gatesRan: [],
    });

    expect(ctx.stories.map((s) => s.id)).toEqual(["US-002"]);
  });

  test("splits the diffstat from the nax-artifact summary using a glob pathspec", async () => {
    const calls: string[][] = [];
    _finishPrDeps.run = async (cmd) => {
      calls.push(cmd);
      return cmd.includes("--shortstat")
        ? { exitCode: 0, stdout: " 1 file changed, 5 insertions(+)\n", stderr: "" }
        : { exitCode: 0, stdout: " src/a.ts | 2 +-\n", stderr: "" };
    };

    const ctx = await loadFinishPrContext({
      state: stateFor(dir),
      audit: { auditDir: join(dir, "audit"), runId: "run-1" },
      gatesRan: [],
    });

    expect(ctx.diffstat).toContain("src/a.ts");
    expect(ctx.artifactSummary).toBe("1 file changed, 5 insertions(+)");
    const stat = calls.find((c) => c.includes("--stat"));
    expect(stat).toContain(":(glob,exclude)**/.nax/**");
    const shortstat = calls.find((c) => c.includes("--shortstat"));
    expect(shortstat).toContain(":(glob)**/.nax/**");
  });

  test("skips the diffstat entirely when base is empty", async () => {
    let ran = false;
    _finishPrDeps.run = async () => {
      ran = true;
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const state = stateFor(dir);
    state.base = "";

    const ctx = await loadFinishPrContext({
      state,
      audit: { auditDir: join(dir, "audit"), runId: "run-1" },
      gatesRan: [],
    });

    expect(ran).toBe(false);
    expect(ctx.diffstat).toBeUndefined();
  });

  test("falls back to feat: <feature> when no title was produced", async () => {
    _finishPrDeps.run = async () => ({ exitCode: 1, stdout: "", stderr: "" });

    const ctx = await loadFinishPrContext({
      state: stateFor(dir),
      audit: { auditDir: join(dir, "audit"), runId: "run-1" },
      gatesRan: [],
    });

    expect(ctx.title).toBe("feat: demo");
  });

  test("carries the caller's template mode and section map", async () => {
    _finishPrDeps.run = async () => ({ exitCode: 1, stdout: "", stderr: "" });

    const ctx = await loadFinishPrContext({
      state: stateFor(dir),
      audit: { auditDir: join(dir, "audit"), runId: "run-1" },
      gatesRan: [],
      prBody: { template: "strict", sectionMap: { notes: "narrative" } },
    });

    expect(ctx.templateMode).toBe("strict");
    expect(ctx.templateSectionMap).toEqual({ notes: "narrative" });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/unit/finish/pr-context.test.ts`
Expected: FAIL — `loadFinishPrContext` is not exported from `@/finish`.

- [ ] **Step 3: Port the loader**

Create `src/finish/pr/context.ts` following the port notes above. The shape of the module, with the parts that must be copied verbatim from `flows/nax-finish/steps/pr-body.ts` marked:

```ts
/**
 * Assembles a `FinishPrContext` from the artifacts a finish run leaves on disk.
 *
 * Ported from `flows/nax-finish/steps/pr-body.ts` (read-only reference, never
 * imported — `flows/` runs in acpx's own Node process). Every read here is
 * fail-open: the PR body is useful without any one section, and a finish that
 * reached this point has already done all of its real work. Losing the PR to a
 * permissions error on a file most repos do not have is the failure this
 * policy exists to prevent.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { featureDir } from "@/config";
import { findPrTemplate } from "@/forge";
import type { ForgeKind, TemplateMode } from "@/forge";
import type { AuditTarget } from "../audit";
import { readRounds } from "../audit";
import { readSpecSummary, resolveNarrative, resolveTitle } from "../operations";
import type { FinishState } from "../state";
import type { FinishRound } from "../types";

// ... interfaces exactly as in the Interfaces block above ...

export const _finishPrDeps = {
  // D4.11 — the shared default, so a finish and an auto-PR spawn subprocesses
  // identically. Never a second local spawner.
  run: defaultForgeDeps.run,
  readText: async (path: string) => {
    try {
      return await readFile(path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  },
  warn: (message: string, details: { path: string; error: unknown }) =>
    process.emitWarning(message, { detail: `${details.path}: ${String(details.error)}` }),
};
```

`_finishPrDeps` takes `run` from `defaultForgeDeps` (Task 1, D4.11) — do not write a second spawner — but keeps its own `readText`. The difference is deliberate: this one returns `null` for a missing file and **throws** on a genuine I/O failure, which is what lets `readJson` tell "no `status.json` yet" (routine, silent) from "the mount is broken" (warn). `defaultForgeDeps.readText` collapses both into `null`, which is right for template discovery and wrong here.

Port `readJson`, `storiesFrom`, `runGitDiff`, `runDiffstat`, `loadTemplate` and `loadFinishPrContext` with their comments. The `Promise.all` in the loader keeps all six reads parallel — do not serialize it.

- [ ] **Step 4: Export from the barrels and run the tests**

Create `src/finish/pr/index.ts` with the context exports, and add to `src/finish/index.ts`:

```ts
export { _finishPrDeps, loadFinishPrContext } from "./pr";
export type { FinishPrContext, FinishPrStory, LoadPrContextArgs } from "./pr";
```

Run: `bun test test/unit/finish/pr-context.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Static checks and commit**

```bash
bun x tsc --noEmit && bun run lint && bun test test/unit/finish/
git add src/finish/pr/ src/finish/index.ts test/unit/finish/pr-context.test.ts
git commit -m "feat(finish): load the PR body context from run artifacts"
```

---

### Task 3: The PR body and title renderers

**Files:**
- Create: `src/finish/pr/body.ts`
- Modify: `src/finish/pr/index.ts`, `src/finish/index.ts`
- Test: `test/unit/finish/pr-body.test.ts`

**Interfaces:**
- Consumes: `FinishPrContext` (Task 2); `mergeTemplate`, `BodySection` from `@/forge` (Task 1).
- Produces: `buildFinishTitle(ctx: FinishPrContext): string`, `buildFinishBody(ctx: FinishPrContext): string`. Task 6 calls both.

**Port notes.** Lines 275-462 of `flows/nax-finish/steps/pr-body.ts`, verbatim apart from the `mergeTemplate` import path: `buildFinishTitle`, `escapeTableCell`, `formatDuration`, `buildStoriesSection`, `buildVerificationSection`, `buildRoundHeading`, `EMPTY_ROUND_NOTE`, `buildRoundBlock`, `buildRoundsSection`, `renderFinding`, `renderRejected`, `buildNarrativeSection`, `buildOutOfScopeSection`, `buildFooter`, `buildBodySections`, `buildFinishBody`, and the `SECONDS_PER_MINUTE` / `MS_PER_SECOND` / `SHORT_SHA_LEN` constants. Keep every comment: `EMPTY_ROUND_NOTE`'s six-way distinction is issue #1507, the null-body filtering is #1477, and the escape order in `escapeTableCell` (backslashes first) is load-bearing.

Do not "improve" anything here. Divergence from the flow's rendering is what makes a native finish PR unrecognisable next to the ones already in history.

- [ ] **Step 1: Port the existing test suite**

```bash
cp test/unit/flows/nax-finish/pr-body.test.ts test/unit/finish/pr-body.test.ts
```

Then, in the copy: delete every test that exercises `loadFinishPrContext` (those belong to Task 2 and are already covered there), point the import at `@/finish`, and keep every rendering assertion untouched. The flow's file is 18.3K — the renderer half should land near the 800-line test cap, so check with `wc -l` and split into `pr-body.test.ts` (sections) and `pr-body-rounds.test.ts` (the rounds/dispositions table) if it exceeds it.

- [ ] **Step 2: Run to verify it fails**

Run: `bun test test/unit/finish/pr-body.test.ts`
Expected: FAIL — `buildFinishBody` is not exported from `@/finish`.

- [ ] **Step 3: Port the renderer**

Create `src/finish/pr/body.ts` with the functions listed above. Its header comment:

```ts
/**
 * The finish PR title and body: a pure deterministic builder over
 * `FinishPrContext`.
 *
 * Pure on purpose. Every fact in a finish body — gate results, story counts,
 * diffstat, review rounds — is a string join over artifacts, which is what
 * keeps a finish PR greppable in history. The only model-authored fields
 * (`narrative`, `title`) arrive already resolved, each with a deterministic
 * fallback, so the body never waits on a reviewer.
 *
 * Ported from `flows/nax-finish/steps/pr-body.ts`; the rendering is settled
 * behaviour (nax#1477, nax#1504, nax#1507) and must not drift.
 */
```

- [ ] **Step 4: Export and run**

Add to `src/finish/pr/index.ts` and `src/finish/index.ts`:

```ts
export { buildFinishBody, buildFinishTitle } from "./body";
```

Run: `bun test test/unit/finish/pr-body.test.ts`
Expected: PASS.

- [ ] **Step 5: Prove the port is faithful**

Run a one-off comparison (scratch file, not committed): build one `FinishPrContext` fixture, render it through `src/finish/pr/body.ts`'s `buildFinishBody` and through `flows/nax-finish/steps/pr-body.ts`'s, and assert the two strings are identical. Report the result in the commit message. A fixture that exercises all six sections plus one rejected disposition is enough.

- [ ] **Step 6: Static checks and commit**

```bash
bun x tsc --noEmit && bun run lint && bun test test/unit/finish/
git add src/finish/pr/ src/finish/index.ts test/unit/finish/pr-body*.test.ts
git commit -m "feat(finish): render the PR title and body natively"
```

---

### Task 4: Draft open, promote and body edit

**Files:**
- Create: `src/finish/pr/open.ts`
- Modify: `src/finish/pr/index.ts`, `src/finish/index.ts`
- Test: `test/unit/finish/pr-open.test.ts`

**Interfaces:**
- Consumes: `detectForge`, `hasOpenPr`, `openPr`, `viewArgv`, `extractUrl`, `ForgeDeps`, `ForgeKind` from `@/forge`; `commitAndPush` from `../commit`.
- Produces:

```ts
export function parseView(stdout: string, forge: ForgeKind): { isDraft: boolean; url?: string };

export async function openDraftFinishPr(
  args: { workdir: string; branch: string; title: string; body: string; forge: ForgeKind },
  deps: ForgeDeps,
): Promise<{ url: string } | null>;

export async function openOrPromotePr(
  args: { workdir: string; branch: string; title: string; body: string; forge: ForgeKind },
  deps: ForgeDeps,
): Promise<{ status: "opened" | "promoted" | "already-ready"; url?: string }>;

export async function updatePrBody(
  args: { workdir: string; branch: string; title: string; body: string; forge: ForgeKind },
  deps: ForgeDeps,
): Promise<void>;
```

Task 6 calls all three async functions.

**Port notes.** `openOrPromotePr`, `updatePrBody` and `parseView` are `flows/nax-finish/steps/pr.ts`, restructured so the forge is a required argument (the flow's `knownForge?` fallback existed because the flow had two independent detection sites; the native caller detects once) and so I/O arrives as `ForgeDeps` rather than a module-level `_prDeps`. Keep both `FinishError` throws as `NaxError` with the same codes — `FINISH_PR_CREATE_FAILED`, `FINISH_PR_PROMOTE_FAILED` — and keep `updatePrBody` non-fatal (it warns and returns; a failed metadata write must not invalidate a PR that exists).

`openDraftFinishPr` is new (D7): `hasOpenPr` first, then `openPr(forge, { title, body, branch, draft: true }, deps, workdir)`. Per D4.5 it returns `null` rather than throwing on every unhappy path — including a `hasOpenPr` throw, which it catches.

- [ ] **Step 1: Write the failing tests**

`test/unit/finish/pr-open.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { openDraftFinishPr, openOrPromotePr, parseView, updatePrBody } from "@/finish";
import type { ForgeDeps } from "@/forge";

function depsFor(handler: (cmd: string[]) => { exitCode: number; stdout?: string; stderr?: string }): {
  deps: ForgeDeps;
  calls: string[][];
} {
  const calls: string[][] = [];
  const deps: ForgeDeps = {
    run: async (cmd) => {
      calls.push(cmd);
      const r = handler(cmd);
      return { exitCode: r.exitCode, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    },
    readText: async () => null,
  };
  return { deps, calls };
}

const args = {
  workdir: "/repo",
  branch: "feat/demo",
  title: "feat: demo",
  body: "body",
  forge: "github" as const,
};

describe("parseView", () => {
  test("reads isDraft and url from GitHub JSON", () => {
    expect(parseView('{"isDraft":true,"url":"https://x/1"}', "github")).toEqual({
      isDraft: true,
      url: "https://x/1",
    });
  });

  test("treats an unparseable reply as ready, not draft", () => {
    expect(parseView("not json https://x/2", "github")).toEqual({ isDraft: false, url: "https://x/2" });
  });

  test("accepts any of GitLab's draft field spellings", () => {
    expect(parseView('{"work_in_progress":true,"web_url":"https://x/3"}', "gitlab").isDraft).toBe(true);
  });
});

describe("openDraftFinishPr", () => {
  test("opens a draft when the branch has no open PR", async () => {
    const { deps, calls } = depsFor((cmd) =>
      cmd.includes("list") ? { exitCode: 0, stdout: "[]" } : { exitCode: 0, stdout: "https://x/9" },
    );
    await expect(openDraftFinishPr(args, deps)).resolves.toEqual({ url: "https://x/9" });
    expect(calls.at(-1)).toContain("--draft");
  });

  test("returns null when a PR is already open", async () => {
    const { deps, calls } = depsFor(() => ({ exitCode: 0, stdout: '[{"number":1}]' }));
    await expect(openDraftFinishPr(args, deps)).resolves.toBeNull();
    expect(calls).toHaveLength(1);
  });

  test("returns null rather than throwing when the PR list call fails", async () => {
    const { deps } = depsFor(() => ({ exitCode: 1, stderr: "auth required" }));
    await expect(openDraftFinishPr(args, deps)).resolves.toBeNull();
  });

  test("returns null when creation fails", async () => {
    const { deps } = depsFor((cmd) =>
      cmd.includes("list") ? { exitCode: 0, stdout: "[]" } : { exitCode: 1, stderr: "rate limited" },
    );
    await expect(openDraftFinishPr(args, deps)).resolves.toBeNull();
  });
});

describe("openOrPromotePr", () => {
  test("creates the PR when view fails, and reports opened", async () => {
    const { deps, calls } = depsFor((cmd) =>
      cmd.includes("view") ? { exitCode: 1 } : { exitCode: 0, stdout: "https://x/10" },
    );
    await expect(openOrPromotePr(args, deps)).resolves.toEqual({ status: "opened", url: "https://x/10" });
    expect(calls.at(-1)).not.toContain("--draft");
  });

  test("promotes a draft and then writes the body", async () => {
    const { deps, calls } = depsFor((cmd) =>
      cmd.includes("view") ? { exitCode: 0, stdout: '{"isDraft":true,"url":"https://x/11"}' } : { exitCode: 0 },
    );
    await expect(openOrPromotePr(args, deps)).resolves.toEqual({ status: "promoted", url: "https://x/11" });
    expect(calls.map((c) => c[2])).toEqual(["view", "ready", "edit"]);
  });

  test("writes the body on an already-ready PR without promoting", async () => {
    const { deps, calls } = depsFor((cmd) =>
      cmd.includes("view") ? { exitCode: 0, stdout: '{"isDraft":false,"url":"https://x/12"}' } : { exitCode: 0 },
    );
    await expect(openOrPromotePr(args, deps)).resolves.toEqual({ status: "already-ready", url: "https://x/12" });
    expect(calls.map((c) => c[2])).toEqual(["view", "edit"]);
  });

  test("throws FINISH_PR_CREATE_FAILED when creation fails", async () => {
    const { deps } = depsFor((cmd) => (cmd.includes("view") ? { exitCode: 1 } : { exitCode: 1, stderr: "boom" }));
    await expect(openOrPromotePr(args, deps)).rejects.toThrow(/boom/);
  });

  test("throws FINISH_PR_PROMOTE_FAILED when promotion fails", async () => {
    const { deps } = depsFor((cmd) => {
      if (cmd.includes("view")) return { exitCode: 0, stdout: '{"isDraft":true}' };
      return cmd.includes("ready") ? { exitCode: 1, stderr: "denied" } : { exitCode: 0 };
    });
    await expect(openOrPromotePr(args, deps)).rejects.toThrow(/denied/);
  });
});

describe("updatePrBody", () => {
  test("never throws when the edit fails", async () => {
    const { deps } = depsFor(() => ({ exitCode: 1, stderr: "nope" }));
    await expect(updatePrBody(args, deps)).resolves.toBeUndefined();
  });

  test("never throws when the run itself rejects", async () => {
    const deps: ForgeDeps = {
      run: async () => {
        throw new Error("spawn failed");
      },
      readText: async () => null,
    };
    await expect(updatePrBody(args, deps)).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test test/unit/finish/pr-open.test.ts`
Expected: FAIL — none of the four symbols are exported.

- [ ] **Step 3: Implement**

Create `src/finish/pr/open.ts`. `parseView` and the two ported functions come from `flows/nax-finish/steps/pr.ts` with the substitutions in the port notes. `openDraftFinishPr`:

```ts
/**
 * Open the draft PR the finish run holds its work in (D7).
 *
 * Returns null on every unhappy path — no open-PR check, a create that
 * failed, a forge CLI that could not answer. The draft is a convenience: the
 * terminal promote creates the PR when none exists, so failing the run here
 * would discard work that is otherwise fine. `hasOpenPr` throws on a non-zero
 * exit by design (a `gh` auth failure must not read as "no PR"); the safe
 * decision at this call site is to skip.
 */
export async function openDraftFinishPr(
  args: { workdir: string; branch: string; title: string; body: string; forge: ForgeKind },
  deps: ForgeDeps,
): Promise<{ url: string } | null> {
  let alreadyOpen: boolean;
  try {
    alreadyOpen = await hasOpenPr(args.forge, args.branch, deps, args.workdir);
  } catch {
    return null;
  }
  if (alreadyOpen) return null;

  const result = await openPr(
    args.forge,
    { title: args.title, body: args.body, branch: args.branch, draft: true },
    deps,
    args.workdir,
  );
  return result.success && result.url ? { url: result.url } : null;
}
```

- [ ] **Step 4: Export and run**

Add `export { openDraftFinishPr, openOrPromotePr, parseView, updatePrBody } from "./open";` to `src/finish/pr/index.ts` and re-export from `src/finish/index.ts`.

Run: `bun test test/unit/finish/pr-open.test.ts`
Expected: PASS (12 tests).

- [ ] **Step 5: Static checks and commit**

```bash
bun x tsc --noEmit && bun run lint && bun test test/unit/finish/
git add src/finish/pr/ src/finish/index.ts test/unit/finish/pr-open.test.ts
git commit -m "feat(finish): open, promote and update the finish PR natively"
```

---

### Task 5: Escalation delivery

**Files:**
- Create: `src/finish/escalate.ts`
- Modify: `src/finish/index.ts`
- Test: `test/unit/finish/escalate.test.ts`

**Interfaces:**
- Consumes: `detectForge`, `viewArgv`, `extractUrl`, `ForgeDeps`, `ForgeKind` from `@/forge`; `Finding` from `./types`.
- Produces:

```ts
export function buildEscalationComment(feature: string, escalationReason: string, findings: Finding[]): string;

export interface EscalationOutcome {
  url?: string;
  channel: "telegram" | "pr-comment";
}

export async function postEscalation(
  args: { workdir: string; branch: string; comment: string; forge: ForgeKind; preferTelegram?: boolean },
  deps: ForgeDeps,
): Promise<EscalationOutcome>;
```

Task 6 calls both.

**Port notes.** `flows/nax-finish/steps/escalate.ts`, with the forge passed in rather than detected inside, `ForgeDeps` in place of `_escalateDeps`, and `NaxError` in place of `FinishError` keeping the codes `FINISH_ESCALATION_COMMENT_FAILED` and `FINISH_ESCALATION_DRAFT_FAILED`. The comment text is byte-identical to the flow's — it is what a human reads and there is no reason for the two to differ.

`preferTelegram` still short-circuits after the read-only view lookup: Telegram becomes the sole channel, no comment is posted and no draft is opened to hold one. The view is still read so the notification can carry a link.

- [ ] **Step 1: Write the failing tests**

`test/unit/finish/escalate.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { buildEscalationComment, postEscalation } from "@/finish";
import type { ForgeDeps } from "@/forge";
import type { Finding } from "@/finish";

const finding: Finding = {
  severity: "HIGH",
  title: "Missing rollback",
  problem: "The migration has no down path.",
  fix: "Add a reversible migration.",
} as Finding;

function depsFor(handler: (cmd: string[]) => { exitCode: number; stdout?: string; stderr?: string }): {
  deps: ForgeDeps;
  calls: string[][];
} {
  const calls: string[][] = [];
  return {
    calls,
    deps: {
      run: async (cmd) => {
        calls.push(cmd);
        const r = handler(cmd);
        return { exitCode: r.exitCode, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
      },
      readText: async () => null,
    },
  };
}

const args = { workdir: "/repo", branch: "feat/demo", comment: "escalation", forge: "github" as const };

describe("buildEscalationComment", () => {
  test("names the feature, the reason and every finding", () => {
    const text = buildEscalationComment("demo", "Two reviewers disagree", [finding]);
    expect(text).toContain("nax-finish escalation");
    expect(text).toContain("demo");
    expect(text).toContain("Two reviewers disagree");
    expect(text).toContain("Missing rollback");
    expect(text).toContain("Add a reversible migration.");
  });

  test("renders with no findings at all", () => {
    expect(buildEscalationComment("demo", "Context could not be resolved", [])).toContain("### Findings");
  });
});

describe("postEscalation", () => {
  test("comments on an existing PR", async () => {
    const { deps, calls } = depsFor((cmd) =>
      cmd.includes("view") ? { exitCode: 0, stdout: '{"url":"https://x/1"}' } : { exitCode: 0 },
    );
    await expect(postEscalation(args, deps)).resolves.toEqual({ url: "https://x/1", channel: "pr-comment" });
    expect(calls.at(-1)).toContain("comment");
  });

  test("opens a draft to hold the comment when no PR exists", async () => {
    const { deps, calls } = depsFor((cmd) =>
      cmd.includes("view") ? { exitCode: 1 } : { exitCode: 0, stdout: "https://x/2" },
    );
    await expect(postEscalation(args, deps)).resolves.toEqual({ url: "https://x/2", channel: "pr-comment" });
    expect(calls.at(-1)).toContain("--draft");
  });

  test("posts nothing and opens nothing when Telegram is preferred", async () => {
    const { deps, calls } = depsFor(() => ({ exitCode: 0, stdout: '{"url":"https://x/3"}' }));
    await expect(postEscalation({ ...args, preferTelegram: true }, deps)).resolves.toEqual({
      url: "https://x/3",
      channel: "telegram",
    });
    expect(calls).toHaveLength(1);
  });

  test("still reports the channel when Telegram is preferred and no PR exists", async () => {
    const { deps } = depsFor(() => ({ exitCode: 1 }));
    await expect(postEscalation({ ...args, preferTelegram: true }, deps)).resolves.toEqual({
      url: undefined,
      channel: "telegram",
    });
  });

  test("throws when the comment cannot be posted", async () => {
    const { deps } = depsFor((cmd) =>
      cmd.includes("view") ? { exitCode: 0, stdout: "{}" } : { exitCode: 1, stderr: "forbidden" },
    );
    await expect(postEscalation(args, deps)).rejects.toThrow(/forbidden/);
  });

  test("throws when the holding draft cannot be opened", async () => {
    const { deps } = depsFor((cmd) => (cmd.includes("view") ? { exitCode: 1 } : { exitCode: 1, stderr: "denied" }));
    await expect(postEscalation(args, deps)).rejects.toThrow(/denied/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test test/unit/finish/escalate.test.ts`
Expected: FAIL — neither symbol is exported.

- [ ] **Step 3: Implement, export and run**

Create `src/finish/escalate.ts` per the port notes; add `export { buildEscalationComment, postEscalation } from "./escalate";` and `export type { EscalationOutcome } from "./escalate";` to `src/finish/index.ts`.

Run: `bun test test/unit/finish/escalate.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 4: Static checks and commit**

```bash
bun x tsc --noEmit && bun run lint && bun test test/unit/finish/
git add src/finish/escalate.ts src/finish/index.ts test/unit/finish/escalate.test.ts
git commit -m "feat(finish): deliver escalations through the forge natively"
```

---

### Task 6: The concrete `FinishOps` factory

**Files:**
- Create: `src/finish/ops-impl.ts`
- Modify: `src/finish/index.ts`
- Test: `test/unit/finish/ops-impl.test.ts`

**Interfaces:**
- Consumes: everything above, plus `finishReviewOp`, `finishFixOp`, `finishNarrativeOp` from `../operations`; `callOp` and `CallContext` from `@/operations`; `commitAndPush` from `../commit`; `ConfiguredModel` from `@/config`.
- Produces:

```ts
export interface FinishOpsDeps {
  /** The call context every LLM op runs under. Its `sessionOverride` is replaced per phase. */
  callCtx: CallContext;
  /** Subprocess and file I/O for every forge call. */
  forge: ForgeDeps;
  /** Resolved once by the caller; null disables every forge interaction. */
  forgeKind: ForgeKind | null;
  audit: AuditTarget;
  /** Per-step model selection. Absent falls through to callOp's own default. */
  models?: {
    reviewSpec?: ConfiguredModel;
    reviewQuality?: ConfiguredModel;
    fix?: ConfiguredModel;
    narrative?: ConfiguredModel;
  };
  timeouts?: { reviewMs?: number; fixMs?: number; narrativeMs?: number };
  prBody?: { template?: TemplateMode; sectionMap?: Record<string, string> };
  /** Telegram is the sole escalation channel when true (D4.3 in the flow's terms). */
  preferTelegram?: boolean;
  /** Gate names the body's Verification section reports. Mutated by the caller as gates run. */
  gatesRan?: () => string[];
  /** Narrative is opt-out: when false, `narrate` is omitted from the returned object. */
  narrative?: boolean;
  warn?: (message: string, details: Record<string, unknown>) => void;
}

export const _finishOpsDeps: { callOp: typeof callOp };

export function createFinishOps(deps: FinishOpsDeps): FinishOps;
```

Plan 5 calls `createFinishOps` and hands the result to `runFinishMachine`.

**Implementation notes.**

- `review(phase, req)` calls `_finishOpsDeps.callOp({ ...deps.callCtx, sessionOverride: { role: phase === "spec" ? "finish-review-spec" : "finish-review-quality" } }, finishReviewOp, { phase, base: state.base, specPath: state.specPath, workdir: state.workdir, since: state.phases[phase].reviewSince, gaps: state.phases[phase].reviewGaps, priorFindings: state.findings, model, timeoutMs })`. It returns `{ findings, gaps }` unchanged — `FinishReviewOutput` is structurally a superset of `ReviewOutcome`, so no adapter. It does **not** catch: a review that cannot run must reach the machine's catch and escalate.
- `fix(phase, req)` calls `finishFixOp` with `{ phase, workdir: state.workdir, findings, failing, gateOutput, acceptanceOutput, model, timeoutMs }` and returns its `FixOutcome` unchanged. No catch, same reason.
- `openDraftPr(state)` returns `null` immediately when `forgeKind` is null; otherwise loads the context (`loadFinishPrContext` with `forge: forgeKind`, `gatesRan: deps.gatesRan?.() ?? []`, `prBody`), renders title and body, and calls `openDraftFinishPr`.
- `promotePr(state)` runs `commitAndPush(state.workdir, state.branch, \`fix(${state.feature}): nax-finish automated fixes\`)` **first** (D4.6), then — when `forgeKind` is non-null — loads context, renders, and calls `openOrPromotePr`. With a null forge it returns `{ status: "already-ready" }` after the push, because there is nothing to promote and the branch is still pushed. Neither call is caught.
- `narrate(state)` is present on the returned object only when `deps.narrative !== false`. Its entire body is inside one try/catch (D4.4): call `finishNarrativeOp` under `sessionOverride: { role: "finish-narrative" }` with `{ base: state.base, model, timeoutMs }`, then re-load the PR context passing the resulting `narrative` and `title`, render, and `updatePrBody`. On any throw, `warn` and return.
- `escalate(state, reason, findings)` never throws (D4.3). It: (1) tries `commitAndPush` for the partial fixes and, on failure, records a `syncNote` string (D4.7); (2) builds the comment with `buildEscalationComment(state.feature, reason, findings) + syncNote`; (3) calls `postEscalation` when `forgeKind` is non-null, returning `{ url }`; (4) catches everything and returns `{ deliveryError: errorMessage(err) }`. With a null forge it returns `{ deliveryError: "no forge detected" }` — the escalation still needs somewhere to say it went nowhere.

- [ ] **Step 1: Write the failing tests**

`test/unit/finish/ops-impl.test.ts` — the seven behaviours that matter. Use a fake `callOp` through `_finishOpsDeps` and a `ForgeDeps` whose `run` records commands. A minimal `callCtx` cast (`{} as CallContext`) is sufficient: nothing in the factory reads it except to spread it.

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { _finishOpsDeps, createFinishOps, createFinishState } from "@/finish";
import type { ForgeDeps } from "@/forge";
import type { CallContext } from "@/operations";

const original = { ..._finishOpsDeps };
afterEach(() => Object.assign(_finishOpsDeps, original));

function baseDeps(overrides: Partial<Parameters<typeof createFinishOps>[0]> = {}) {
  const calls: string[][] = [];
  const forge: ForgeDeps = {
    run: async (cmd) => {
      calls.push(cmd);
      return { exitCode: 0, stdout: "https://x/1", stderr: "" };
    },
    readText: async () => null,
  };
  return {
    calls,
    deps: {
      callCtx: {} as CallContext,
      forge,
      forgeKind: "github" as const,
      audit: { auditDir: "/tmp/audit", runId: "run-1" },
      ...overrides,
    },
  };
}

const state = createFinishState({
  feature: "demo",
  workdir: "/repo",
  branch: "feat/demo",
  runId: "run-1",
  base: "origin/main",
  specPath: "spec.md",
});

test("review runs the spec phase under the finish-review-spec role", async () => {
  let seenRole: string | undefined;
  _finishOpsDeps.callOp = (async (ctx: CallContext) => {
    seenRole = ctx.sessionOverride?.role;
    return { findings: [], gaps: [], touchpoints: [], walk: [] };
  }) as typeof _finishOpsDeps.callOp;
  const { deps } = baseDeps();
  await createFinishOps(deps).review("spec", { state });
  expect(seenRole).toBe("finish-review-spec");
});

test("review runs the quality phase under the finish-review-quality role", async () => {
  let seenRole: string | undefined;
  _finishOpsDeps.callOp = (async (ctx: CallContext) => {
    seenRole = ctx.sessionOverride?.role;
    return { findings: [], gaps: [], touchpoints: [], walk: [] };
  }) as typeof _finishOpsDeps.callOp;
  const { deps } = baseDeps();
  await createFinishOps(deps).review("quality", { state });
  expect(seenRole).toBe("finish-review-quality");
});

test("review passes the phase's re-review window and gap notice through", async () => {
  let seenInput: { since?: string; gaps?: string[] } | undefined;
  _finishOpsDeps.callOp = (async (_ctx: CallContext, _op: unknown, input: { since?: string; gaps?: string[] }) => {
    seenInput = input;
    return { findings: [], gaps: [], touchpoints: [], walk: [] };
  }) as typeof _finishOpsDeps.callOp;
  const windowed = createFinishState({ ...state });
  windowed.phases.spec.reviewSince = "abc123";
  windowed.phases.spec.reviewGaps = ["did not read src/a.ts"];
  const { deps } = baseDeps();
  await createFinishOps(deps).review("spec", { state: windowed });
  expect(seenInput?.since).toBe("abc123");
  expect(seenInput?.gaps).toEqual(["did not read src/a.ts"]);
});

test("review propagates a throw instead of swallowing it", async () => {
  _finishOpsDeps.callOp = (async () => {
    throw new Error("agent died");
  }) as typeof _finishOpsDeps.callOp;
  const { deps } = baseDeps();
  await expect(createFinishOps(deps).review("spec", { state })).rejects.toThrow("agent died");
});

test("narrate swallows a throw so a promoted run is not re-escalated", async () => {
  _finishOpsDeps.callOp = (async () => {
    throw new Error("narrator died");
  }) as typeof _finishOpsDeps.callOp;
  const { deps } = baseDeps();
  const ops = createFinishOps(deps);
  await expect(ops.narrate?.(state)).resolves.toBeUndefined();
});

test("narrate is absent when narrative is disabled", () => {
  const { deps } = baseDeps({ narrative: false });
  expect(createFinishOps(deps).narrate).toBeUndefined();
});

test("escalate reports a delivery failure rather than throwing", async () => {
  const forge: ForgeDeps = {
    run: async () => {
      throw new Error("gh missing");
    },
    readText: async () => null,
  };
  const { deps } = baseDeps({ forge });
  await expect(createFinishOps(deps).escalate(state, "needs a human", [])).resolves.toMatchObject({
    deliveryError: expect.stringContaining("gh missing"),
  });
});

test("escalate reports no forge as a delivery error", async () => {
  const { deps } = baseDeps({ forgeKind: null });
  const outcome = await createFinishOps(deps).escalate(state, "needs a human", []);
  expect(outcome.deliveryError).toBeTruthy();
});

test("promotePr pushes before it talks to the forge", async () => {
  const { deps, calls } = baseDeps();
  await createFinishOps(deps).promotePr(state);
  const pushIndex = calls.findIndex((c) => c.includes("push"));
  const forgeIndex = calls.findIndex((c) => c[0] === "gh");
  expect(pushIndex).toBeGreaterThanOrEqual(0);
  expect(pushIndex).toBeLessThan(forgeIndex);
});
```

The push assertion needs `commitAndPush`'s git seam stubbed too — `_finishGitDeps.git`, exported from `@/finish`. Stub it in that test to record its argv into the same `calls` array and return `{ exitCode: 0, stdout: "", stderr: "" }`, and restore it in `afterEach`.

- [ ] **Step 2: Run to verify failure**

Run: `bun test test/unit/finish/ops-impl.test.ts`
Expected: FAIL — `createFinishOps` is not exported.

- [ ] **Step 3: Implement the factory**

Create `src/finish/ops-impl.ts` per the implementation notes. Header comment:

```ts
/**
 * The concrete `FinishOps` the state machine runs against.
 *
 * A factory rather than a module of free functions: every method needs the
 * same closed-over `CallContext`, forge deps and model selections, and the
 * machine's contract (`./ops`) is an object. Two of the contract's clauses are
 * load-bearing and are implemented here, not in the modules below:
 *
 * - `escalate` must not throw. Its whole body is wrapped, and a delivery
 *   failure is returned as `deliveryError` — `machine.ts`'s `doEscalate` is
 *   the only caller and it has no other way to record that the human was
 *   never told.
 * - `narrate` must not throw. The machine calls it *after* `promotePr`,
 *   inside its one try, so a throw rewrites an already-promoted green run to
 *   `escalated`.
 *
 * `review` and `fix` deliberately do neither: a reviewer or fixer that cannot
 * run is exactly the case the machine's catch exists for.
 */
```

- [ ] **Step 4: Export and run**

Add to `src/finish/index.ts`:

```ts
export { _finishOpsDeps, createFinishOps } from "./ops-impl";
export type { FinishOpsDeps } from "./ops-impl";
```

Run: `bun test test/unit/finish/ops-impl.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Static checks and commit**

```bash
bun x tsc --noEmit && bun run lint && bun test test/unit/finish/
git add src/finish/ops-impl.ts src/finish/index.ts test/unit/finish/ops-impl.test.ts
git commit -m "feat(finish): assemble the concrete FinishOps object"
```

---

### Task 7: End-to-end machine test over the real ops

**Files:**
- Test: `test/unit/finish/machine-end-to-end.test.ts`

**Interfaces:**
- Consumes: `runFinishMachine`, `createFinishOps`, `createFinishState`, `_finishOpsDeps`, `_finishGitDeps`, `_finishPrDeps`, `_acceptanceGateDeps`, `_qualityGateDeps` — all from `@/finish`.

This is the task that proves the plan. Every prior test stubs one module; this one drives `runFinishMachine` with a real `createFinishOps` and fakes only the three process boundaries (git, forge subprocesses, the LLM call). If the pieces disagree about a shape, it fails here rather than in plan 5's wiring.

- [ ] **Step 1: Write the green-path test**

```ts
test("a clean run reaches promoted with a PR body built from artifacts", async () => {
  // acceptance passes, both reviewers return no findings, gates green
  // _finishOpsDeps.callOp returns { findings: [], gaps: [], ... } for review,
  //   { dispositions: [] } for fix, and a narrative for narrate
  // forge run: view -> draft, ready -> ok, edit -> ok
  // Expect: result.status === "promoted", and the `gh pr edit` argv carries a
  // body containing "## Verification" and the story table.
});
```

Assert three things and no more: the terminal status is `promoted`; `gh pr create --draft` ran exactly once (the draft is opened at step 3 and never re-opened); the body handed to `gh pr edit` contains the rendered Stories and Verification sections.

- [ ] **Step 2: Write the escalation-path test**

```ts
test("a review that throws escalates with a comment and a written result file", async () => {
  // _finishOpsDeps.callOp throws on the spec review
  // Expect: result.status === "escalated", result.escalationReason names the
  // throw, `gh pr comment` ran with the escalation comment, and the result
  // file on disk has status "escalated".
});
```

- [ ] **Step 3: Write the narrate-cannot-break-a-green-run test**

```ts
test("a narrator failure leaves the run promoted", async () => {
  // Everything green, but the narrative call throws.
  // Expect: result.status === "promoted" and no escalation comment was posted.
});
```

This is the regression test for D4.4 — the one defect that would otherwise only show up in production, on a run that had already succeeded.

- [ ] **Step 4: Run the whole finish suite**

Run: `bun test test/unit/finish/`
Expected: PASS, all files.

- [ ] **Step 5: Full gates and commit**

```bash
bun x tsc --noEmit && bun run lint && bun test
git add test/unit/finish/machine-end-to-end.test.ts
git commit -m "test(finish): drive the machine end to end over the real ops"
```

- [ ] **Step 6: Confirm the module is still unwired**

```bash
grep -rn "from \"@/finish\"\|from \"./finish\"" src/ --include="*.ts" | grep -v "^src/finish/"
```

Expected: no output. `src/finish/` is complete but wired to nothing; plan 5 wires it. If this prints anything, the plan's scope was exceeded — revert that import.

---

## Self-Review Notes

- **Spec coverage.** Design section 4.2's module list is now fully realised except `phase.ts` (plan 5). Section 4.7's draft lifecycle is Task 4 plus `openDraftPr`/`promotePr` in Task 6. Section 4.5's operations were plan 3; this plan only binds them.
- **Out of scope, deliberately.** Wiring `"finish"` into `PostRunPhase` (three sites: the type, `status-writer.ts:118-120`, `usePipelineBusEvents.ts:243`), the cost-aggregator delta, the config reshape from `finish.autoFlow`, the Telegram send itself, and deleting `flows/` — all plan 5. The `@flows/*` tsconfig alias also stays until then.
- **Known duplication after this plan.** `flows/nax-finish/steps/{pr,pr-body,pr-narrative,escalate}.ts` still exist and still run. That is expected and is not a defect to file.
