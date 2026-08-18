# Native Finish Core (`src/finish/`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the deterministic core of `src/finish/` — state, routing, audit trail, commit rounds, context load, and the two gates — plus the state machine that drives them, with every LLM step behind an injected `FinishOps` seam that a later plan fills in. Nothing is wired into the runner and `flows/nax-finish/` keeps running untouched.

**Architecture:** The acpx graph becomes an explicit async state machine over a serializable `FinishState`. Every counter the flow derived by scanning `ctx.state.steps` becomes a named field on that state, and every LLM node becomes a method on `FinishOps` that tests stub. The gates stop shelling out — acceptance resolves through `resolveFeatureAcceptance`, quality reads layered config through `loadConfig` / `loadConfigForWorkdir`, and both run their commands through `runQualityCommand`.

**Tech Stack:** TypeScript, Bun (test runner and toolchain), Biome (format/lint).

**Spec:** `docs/superpowers/specs/2026-08-18-native-nax-finish-design.md` — this plan implements **cutover step 2** of section 6. Read sections 4.2 (module decomposition), 4.3 (control flow), 4.4 (the eight invariants) and 8 (defects F2 and F3) before starting.

**Predecessor:** `docs/superpowers/plans/2026-08-18-forge-shared-module.md` (cutover step 1) shipped in PR #1626. `src/forge/` exists and auto-PR runs on it.

## Global Constraints

- Runtime is **Bun**. `src/` is Bun-native; use `Bun.*` freely. The `flows/` directory is the sole exception, and **this plan does not touch `flows/`** — it is still the live implementation until cutover step 4.
- **Duplication with `flows/nax-finish/` is expected for the whole of this plan.** Both trees exist; only one is wired. Do not delete, edit or "deduplicate" anything under `flows/`, and do not import from it: `flows/` is loaded by a separate acpx process where the `@/*` alias does not exist, so an import in either direction breaks one of the two.
- **File size caps:** 600 lines for `src/`, 800 for `test/`. Enforced by `scripts/check-file-sizes.ts`. `machine.ts` is the file at risk; keep routing in `route.ts` and phase bodies short.
- **No emojis** in code, comments, or documentation.
- **Imports:** use the `@/` alias (`@/*` -> `./src/*`). `scripts/check-alias-internals.ts` forbids **value** imports that reach past a barrel when `src/<dir>/index.ts` exists (type-only imports are exempt). Three consequences, each of which will fail the gate if ignored:
  - **`src/cli/index.ts` exists**, so the resolvers must be imported as `import { resolveFeatureSpec } from "@/cli"` — **never** `@/cli/features-resolve`. Same for `@/quality`, `@/config`, `@/test-runners`.
  - **`src/utils/` has no barrel**, so `@/utils/git` is correct and is what the rest of `src/` already does.
  - **Inside `src/finish/`, import siblings relatively** (`./types`, `../route`), the way `src/forge/pr.ts` imports `./types`. Once `src/finish/index.ts` exists, `@/finish/types` is an alias-internal violation from anywhere, including from within the module.
- `scripts/check-deep-relatives.ts` has a frozen baseline of 2845 — **new tests must import `@/finish`, never `../../../src/finish/...`**.
- **Temp directories in tests:** use `makeTempDir` / `cleanupTempDir` / `withTempDir` from `test/helpers/temp.ts`. `.nax/rules/forbidden-patterns-tests.md` forbids hand-rolled `rm -rf` cleanup.
- **Errors:** use `NaxError` from `src/errors.ts` with a `FINISH_*` code. The flow's own `FinishError` (`flows/nax-finish/errors.ts`) exists only because `flows/` cannot import `src/`; it does not move. `scripts/check-nax-error.ts` has a baseline — do not add violations.
- **Commits:** conventional commits (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`). Attribution is disabled globally; do not add co-author trailers.
- **Branch:** create `feat/finish-core` from `main` before Task 1.
- **Gates before every commit:** `bun x tsc --noEmit`, `bun run lint`, and the task's own tests. A pre-commit hook runs the full static-check suite automatically and will reject the commit if anything fails.

---

## File Structure

**Created:**

| File | Responsibility |
| --- | --- |
| `src/finish/types.ts` | `Finding`, `Touchpoint`, `FindingDisposition`, `FinishPhase`, `FinishRound`, `FinishRoundOutcome`, `FinishResult`. Pure types, ported from `flows/nax-finish/types.ts`. |
| `src/finish/state.ts` | `FinishState`, `FinishPhaseState`, `createFinishState`, `serializeFinishState`, `deserializeFinishState`. |
| `src/finish/route.ts` | The caps and the three routing functions. Pure and synchronous. |
| `src/finish/audit.ts` | `appendRound`, `readRounds`, `writeResult`, path helpers. |
| `src/finish/commit-message.ts` | `buildFixCommitMessage` — ported verbatim from `flows/nax-finish/commit-message.ts`. |
| `src/finish/commit.ts` | `commitFixes`, `commitAndPush`, `filesInCommit`, `partitionTestFiles`, `buildCommitRound`. |
| `src/finish/context.ts` | `loadFinishContext` — base branch, feature resolution, test patterns, preflight. |
| `src/finish/gates/acceptance.ts` | `runAcceptanceGate` — one group per configured command, in-process resolution. |
| `src/finish/gates/quality.ts` | `resolveGateCommands`, `runQualityGates` — layered config (fixes F2). |
| `src/finish/ops.ts` | The `FinishOps` interface and its request/response types. No implementations. |
| `src/finish/machine.ts` | `runFinishMachine` — the 22-node graph as a loop. |
| `src/finish/index.ts` | Public barrel. The only entry point `@/finish` consumers may use. |
| `test/unit/finish/state.test.ts` | State counters and round-trip serialization. |
| `test/unit/finish/route.test.ts` | Caps and routes, including the table ported from `verdict.test.ts`. |
| `test/unit/finish/audit.test.ts` | Round trail, monotonic `attempt` (F3), best-effort writes. |
| `test/unit/finish/commit.test.ts` | Commit rounds, test-file partitioning, push timeout. |
| `test/unit/finish/context.test.ts` | Resolution failures, preflight. |
| `test/unit/finish/gates-acceptance.test.ts` | I1 and I5 at the gate level. |
| `test/unit/finish/gates-quality.test.ts` | F2 (layering) and I1. |
| `test/unit/finish/machine-invariants.test.ts` | I1-I8 driven through stub ops. |
| `test/unit/finish/machine-loops.test.ts` | The four fix loops and their caps. |

**Modified:** none. This plan adds a tree and wires nothing.

**Deleted:** none.

---

## Out of scope for this plan

Named here so a reader does not mistake omission for oversight. Each is a later cutover step.

- **Anything that talks to an LLM.** `review/`, `ops/review-op.ts`, `ops/fix-op.ts`, `ops/narrative-op.ts`, prompt assembly, findings parsing, `review/references/*.md` and the codegen step are **plan 3**. This plan defines the `FinishOps` interface they implement and nothing else.
- **The PR body, the forge calls and escalation delivery.** `pr.ts` and `escalate.ts` are plan 3. The machine reaches them through `FinishOps` too.
- **Wiring.** Adding `"finish"` to `PostRunPhase`, `runFinishPhase`, `status-writer.ts`, `usePipelineBusEvents.ts`, cost snapshots, config compat shims and deleting `flows/` are **plan 4**.
- **`nax finish` CLI and resume.** Deferred by design (spec section 7). `FinishState` is serializable so both stay cheap; nothing in this plan may make it non-serializable (no class instances, no functions, no `Map` on the state).

---

## Decisions this plan locks

Read these before writing code. Each departs from a line-by-line port and each has a reason.

**D2.1 — Counters live on the state, not in step history.** Every `*Count(ctx, ...)` helper in `flows/nax-finish/flow-ctx.ts` and `verdict.ts` exists to reconstruct a number from acpx's `state.steps`, and each carries a self-inclusive-or-not comment that had to be reasoned about at every call site (`repromptCount` is self-inclusive so its comparison is `<=`; `incompleteCount` is not so its comparison is `<`). In-process the numbers are just fields. Port the *cap semantics*, not the counting mechanism.

**D2.2 — `MAX_REPROMPT_ATTEMPTS` and the `reprompt` route are deleted.** They exist because acpx `parse()` had no retry, so the flow had to model "unreadable reply" as a graph route. `callOp` uses `makeParseRetryStrategy` (`src/agents/retry`), which retries the parse tier itself. A reply that is still unreadable after those retries surfaces as a thrown error from the op, which the machine's single `try/catch` routes to escalate (I7). The `unparseable` **round outcome** stays in `FinishRoundOutcome` — old audit files carry it and are read, not just written.

**D2.3 — The audit `attempt` field is one monotonic per-phase counter (fixes F3).** Today `commit_<phase>` writes `fixAttemptCount` while `route_<phase>` writes `reviewAttemptCount`, so a real trail reads `1, 1, 3, 4`. `FinishPhaseState.rounds` is incremented exactly once per recorded round, by whichever seam records it, and is what lands in `FinishRound.attempt`. The cap counters (`fixAttempts`, `incompleteAttempts`) stay separate — conflating them is the defect. The field name on the wire stays `attempt`: readers of existing trails must keep working.

**D2.4 — The quality gate reads layered config and honours per-package overlays (fixes F2).** `loadQualityCommands` reads one file, so a repo with commands only in `.nax/mono/<pkg>/config.json` escalates with "nax-finish verified nothing" (design section 9). Replaced by: root commands from `loadConfig(workdir)` (which applies global, project and the active profile chain), plus, for each package the feature touched whose **own overlay file sets `quality.commands`**, that package's commands from `loadConfigForWorkdir`. A package that merely inherits the root commands is not fanned out — the root run already covers them.

**D2.5 — The gate order drops `format`.** The flow's `QualityCommands` is `{build, typecheck, lint, test, format}`, but nax's `QualityConfigSchema` (`src/config/schemas-execution.ts:225`) has no `format` key — it has `formatFix`, which mutates files and must never be a gate. `format` has therefore never been readable from a validated nax config; porting it would be porting a typo. `GATE_ORDER` is `["build", "typecheck", "lint", "test"]`.

**D2.6 — Subprocesses go through existing nax infrastructure.** Git through `gitWithTimeout` (`@/utils/git`), gate and acceptance commands through `runQualityCommand` (`@/quality`). Both already do concurrent pipe draining and timeout kills; `flows/nax-finish/exec.ts` exists only because `flows/` cannot reach them. Do not port `exec.ts`.

**D2.7 — Dispositions arrive pre-validated.** `validateDispositions` (`flows/nax-finish/steps/review-audit.ts:80`) checks a rejection's cited file exists. It belongs with the review code in plan 3, so in this plan the fix op's result carries dispositions and `commit.ts` records them as given. Plan 3's real fix op validates before returning. Do not add a second validation pass in `commit.ts`.

---

### Task 1: Types and state

**Files:** `src/finish/types.ts`, `src/finish/state.ts`, `test/unit/finish/state.test.ts`

**Steps:**

- [ ] Create the branch: `git checkout -b feat/finish-core`.
- [ ] Copy `flows/nax-finish/types.ts` to `src/finish/types.ts` and strip what this plan does not own: drop `RunResult`, `RunFn`, `ShellRunFn` (D2.6 — nothing spawns through a local type any more) and `AcceptanceGroup` (replaced by the resolver's own `AcceptanceGroupResult`, Task 5). Keep `Finding`, `Severity`, `Touchpoint`, `ReviewReport`, `FindingDisposition`, `ReviewVerdict`, `FinishPhase`, `FinishRoundOutcome`, `FinishRound`, `FinishResult`, `FinishTimeouts`, `FinishPrBodySettings` verbatim, doc comments included — they carry the reasons for four `fix:` commits.
- [ ] Replace the `TemplateMode` import (which points into `flows/`) with a local `export type TemplateMode = "merge" | "strict" | "ignore";`. Plan 3 moves the real `pr-template-merge.ts` and re-points it.
- [ ] Delete the `raw` and `route: "reprompt"` members of `ReviewVerdict` per D2.2. Keep `"unparseable"` in `FinishRoundOutcome` and extend its doc comment to say it is read-only history now.
- [ ] Write `test/unit/finish/state.test.ts` first, covering the four behaviours below. Run it and watch it fail.
- [ ] Implement `src/finish/state.ts`:

```ts
/**
 * The finish run's whole mutable state, as plain JSON.
 *
 * Everything the acpx flow reconstructed by scanning `ctx.state.steps` is a
 * named field here. That is not only simpler — the step-scanning helpers each
 * had to document whether they counted the current step (`repromptCount` did,
 * `incompleteCount` did not, and their comparisons differed by one character as
 * a result), and every new call site had to get that right again.
 *
 * Serializable by construction: no class instances, no functions, no Map/Set.
 * `nax finish` and resume-from-checkpoint are deferred (design section 7) but
 * are only cheap to add while that stays true.
 */
export interface FinishPhaseState {
  /** Times this phase's fix step has run. Capped by MAX_FIX_ATTEMPTS. */
  fixAttempts: number;
  /** Times this phase's reviewer has run. Zero for `acceptance` and `gate`. */
  reviewAttempts: number;
  /** Times a review of this phase was sent back for missing evidence. Capped by MAX_INCOMPLETE_ATTEMPTS. */
  incompleteAttempts: number;
  /**
   * Rounds recorded for this phase, and the value written to `FinishRound.attempt`.
   *
   * One counter, incremented once per recorded round by whichever seam records
   * it. The flow had two — `commit_<phase>` wrote its fix count and
   * `route_<phase>` wrote its review count into the same field, so a real trail
   * reads 1, 1, 3, 4 and nothing downstream can order it (design F3).
   */
  rounds: number;
}

export type FinishStatus = "running" | "opened" | "promoted" | "already-ready" | "escalated" | "nothing-to-finish";

export interface FinishState {
  /** Bumped when a field's meaning changes, so a resumed state is rejected rather than misread. */
  version: 1;
  feature: string;
  workdir: string;
  branch: string;
  runId: string;
  /** Base ref the reviewers diff against, e.g. `origin/main`. */
  base: string;
  /** Repo-relative spec path for the review prompts. */
  specPath: string;
  status: FinishStatus;
  phases: Record<FinishPhase, FinishPhaseState>;
  /** Findings the current phase's reviewer last reported; the fix step's input. */
  findings: Finding[];
  /** Set once the draft PR is open (D7), so promote is idempotent. */
  prUrl?: string;
  escalationReason?: string;
}
```

- [ ] Add the two gate result interfaces to `types.ts`, not to the gate modules. `route.ts` (Task 2) consumes both and is built before the gates, so defining them in `gates/*.ts` would make Task 2 uncompilable on its own:

```ts
export interface AcceptanceGateResult {
  /** Every group that ran exited 0. Says nothing about groups that could not run. */
  passed: boolean;
  ran: number;
  /** Packages whose acceptance test the resolver expected but which is absent on disk. */
  missing: string[];
  output: string;
}

export interface QualityGateResult {
  passed: boolean;
  /** Gate names that actually ran; empty means nothing was configured. */
  ran: string[];
  failing: string[];
  output: string;
}
```

- [ ] Add `createFinishState(init)` returning zeroed counters for all four phases and `status: "running"`.
- [ ] Add `serializeFinishState(state): string` (`JSON.stringify`, 2-space) and `deserializeFinishState(text): FinishState`, which throws `NaxError("FINISH_STATE_VERSION")` on a `version` other than `1` and `NaxError("FINISH_STATE_UNPARSEABLE")` on bad JSON.

**Verification:**

- [ ] `bun test test/unit/finish/state.test.ts` — asserts: (1) a fresh state has all four phases present with every counter 0; (2) round-trip through serialize/deserialize is deep-equal; (3) a payload with `version: 2` throws `FINISH_STATE_VERSION`; (4) `JSON.parse(serializeFinishState(s))` has no function-valued or undefined-valued keys — the guard that keeps resume cheap.
- [ ] `bun x tsc --noEmit && bun run lint`.
- [ ] Commit: `feat(finish): add finish core types and serializable run state`.

---

### Task 2: Routing and caps

**Files:** `src/finish/route.ts`, `test/unit/finish/route.test.ts`

The routing half of `flows/nax-finish/verdict.ts`, rewritten against `FinishPhaseState` instead of `ctx.state.steps`. The parsing half (`parseReviewVerdict`, `parseFixVerdict`) is plan 3.

**Steps:**

- [ ] Write `test/unit/finish/route.test.ts` first. Port the route table from `test/unit/flows/nax-finish/verdict.test.ts`, dropping every `reprompt` case (D2.2) and replacing the hand-built `ctx.state.steps` arrays with `FinishPhaseState` literals. Run it; watch it fail.
- [ ] Implement `src/finish/route.ts`:

```ts
export const MAX_FIX_ATTEMPTS = 3;
export const MAX_INCOMPLETE_ATTEMPTS = 1;

export type ReviewRoute = "clean" | "fix" | "escalate" | "incomplete";
export type GateRoute = "proceed" | "fix" | "escalate";

/** What a reviewer produced, after plan 3's op has parsed it. */
export interface ReviewOutcome {
  findings: Finding[];
  /** Reading obligations the reviewer did not discharge; empty means it did. */
  gaps: string[];
}

export interface RoutedReview {
  route: ReviewRoute;
  findings: Finding[];
  escalationReason?: string;
  gaps?: string[];
}

export function routeReview(
  phase: "spec" | "quality",
  outcome: ReviewOutcome | undefined,
  st: FinishPhaseState,
): RoutedReview;
```

- [ ] `routeReview` must preserve, in this order:
  1. **An absent outcome escalates.** `undefined` means the op returned nothing — it never ran or died before emitting. Neither is an approval. There is no reprompt path: a step that emitted nothing has no reply to quote back.
  2. **A finding marked `judgment` escalates**, with `judgmentReason` as the reason, falling back to `Needs human judgment: <title>`.
  3. **Gaps escalate or send back.** `gaps.length > 0` routes `incomplete` while `st.incompleteAttempts < MAX_INCOMPLETE_ATTEMPTS`, then `escalate` with `` `${phase} review never discharged its reading obligations: ${gaps.join("; ")}` ``.
  4. **No findings is `clean`.** Only reachable past the gap check — a reviewer that skipped its evidence sections does not get to approve.
  5. **Findings with `st.fixAttempts >= MAX_FIX_ATTEMPTS` escalates**, reason `` `${phase} review still reporting ${n} finding(s) after ${st.fixAttempts} fix attempts.` `` Otherwise `fix`.
- [ ] Add `routeAcceptance(result: AcceptanceGateResult, st: FinishPhaseState): { route: GateRoute; reason?: string }` and `routeQualityGates(result: QualityGateResult, st: FinishPhaseState): { route: GateRoute | "green"; reason?: string }`, lifting the routing out of `flows/nax-finish/steps/gates.ts` and leaving the running to Tasks 5-6. The four escalation reasons in that file are user-visible strings and stay byte-identical.
- [ ] Add `gateCommitRoute(committed, files, testFileRegex): "changed" | "tests-only" | "unchanged"`, ported from `nax-finish.flow.ts`. Keep the two hazard branches exactly: an unresolvable post-commit SHA is `changed`, and an empty file list is `changed`. "Cannot classify" reviews; it never skips.
- [ ] Port `partitionTestFiles` from `flows/nax-finish/steps/context.ts` into `route.ts` — `gateCommitRoute` is its only caller and lives here. Keep both hazards: an unparseable regex source is skipped rather than thrown (a bad pattern in one config entry must not take a finish down mid-loop), and no patterns at all classifies everything as non-test, because "cannot classify" must mean "review it".

**Verification:**

- [ ] `bun test test/unit/finish/route.test.ts` — the ported table, plus: an `undefined` outcome escalates and does not read `findings`; a `judgment` finding escalates even with `fixAttempts: 0`; gaps at the cap escalate with the phase-named reason; a clean review with gaps routes `incomplete`, never `clean`; `partitionTestFiles` with no patterns returns everything as non-test; `gateCommitRoute` with a committed change and an empty file list returns `changed`.
- [ ] `bun x tsc --noEmit && bun run lint`.
- [ ] Commit: `feat(finish): add deterministic routing and caps over explicit state`.

---

### Task 3: The audit trail

**Files:** `src/finish/audit.ts`, `test/unit/finish/audit.test.ts`

**Steps:**

- [ ] Write `test/unit/finish/audit.test.ts` first, using `withTempDir` from `test/helpers/temp.ts` for the audit directory. Run it; watch it fail.
- [ ] Implement `src/finish/audit.ts`, porting `flows/nax-finish/steps/result.ts` with two changes: `node:fs/promises` stays (append needs `appendFile`; `Bun.write` has no append mode, and `mkdir` before append stays required because the per-project audit directory does not exist on a project's first run), and the audit directory is supplied by the caller rather than derived.

```ts
export interface AuditTarget {
  /** `<outputDir>/finish-audit/<feature>`, resolved by the caller from `runtime.outputDir`. */
  auditDir: string;
  runId: string;
}

export function roundsPath(t: AuditTarget): string;
export function resultPath(t: AuditTarget): string;

/**
 * Append one round to the trail (I6).
 *
 * Best-effort: an unwritable audit directory must not take a finish down
 * mid-loop. The round records work already done — losing the record is bad,
 * losing the run that did the work is worse.
 */
export async function appendRound(t: AuditTarget, round: FinishRound): Promise<void>;

/** Every round recorded for this run. A torn final line is skipped, not thrown. */
export async function readRounds(t: AuditTarget): Promise<FinishRound[]>;

/** The terminal result, with every recorded round embedded, on every status. */
export async function writeResult(t: AuditTarget, result: FinishResult): Promise<void>;
```

- [ ] Add the single writer, typed so the rule is enforced by the compiler rather than by convention:

```ts
/**
 * Record one round. The ONLY place `attempt` is assigned (D2.3).
 *
 * The caller cannot supply `attempt` -- the parameter type omits it -- so the
 * two-counters-into-one-field defect (F3) cannot be reintroduced by a new call
 * site. No other module may call `appendRound` directly.
 */
export async function recordRound(
  t: AuditTarget,
  state: FinishState,
  phase: FinishPhase,
  round: Omit<FinishRound, "attempt">,
): Promise<void>;
```

  It increments `state.phases[phase].rounds`, stamps `attempt` from it, and calls `appendRound`.
- [ ] `ts` is passed in by the caller, not read from `new Date()` inside — the machine tests assert ordering and must not depend on clock resolution.

**Verification:**

- [ ] `bun test test/unit/finish/audit.test.ts` — asserts: rounds append one JSON object per line; `readRounds` skips a torn final line and returns the rounds before it; `writeResult` embeds rounds on a `status: "opened"` result, not only on `escalated`; an unwritable `auditDir` makes `appendRound` resolve rather than throw; **two `recordRound` calls for the same phase from different seams (a review round then a commit round) produce `attempt: 1` then `attempt: 2`** — the F3 regression test.
- [ ] Prove the F3 test fails against the old behaviour: temporarily stamp `attempt` from `fixAttempts` instead of `rounds` and confirm the assertion goes red (it should read `attempt: 0` then `attempt: 1`). Revert.
- [ ] `bun x tsc --noEmit && bun run lint`.
- [ ] Commit: `fix(finish): give the audit trail one monotonic attempt counter per phase`.

---

### Task 4: Commit rounds

**Files:** `src/finish/commit-message.ts`, `src/finish/commit.ts`, `test/unit/finish/commit.test.ts`

**Steps:**

- [ ] Copy `flows/nax-finish/commit-message.ts` to `src/finish/commit-message.ts`. Rewrite its imports to `./types`; change nothing else. Copy `test/unit/flows/nax-finish/commit-message.test.ts` to `test/unit/finish/commit-message.test.ts` with imports retargeted and **assertions untouched** — it is the evidence the port changed nothing.
- [ ] Adapt the `MessageCtx` parameter — and adapt it to **all three** shapes it reads, not just findings. `buildFixCommitMessage` takes an acpx `ctx.outputs` map keyed by node id and reads `review_<phase>.findings`, `quality_gates.{failing,output}` **and** `acceptance.output` (`commit-message.ts:113,155,179,185`). A replacement carrying only findings silently drops the failing-gate list and the acceptance runner evidence from the commit body. Replace it with a named struct:

```ts
export interface CommitMessageCtx {
  /** Findings the phase's reviewer reported (spec/quality phases). */
  findings?: Finding[];
  /** The quality gate's red command names and runner output (gate phase). */
  gate?: { failing?: string[]; output?: string };
  /** The acceptance runner's output (acceptance phase). */
  acceptance?: { output?: string };
}
```

  `outputsFor` and `findingsFor` collapse into direct reads. Keep `findingsFor`'s `Boolean(f?.title)` filter — a malformed finding must not render an empty bullet. Update the copied test's **fixtures** to build this struct instead of an `outputs` map; the **assertions on the rendered strings stay untouched**, and that is what proves the port changed nothing.
- [ ] Write `test/unit/finish/commit.test.ts` first for the new module, stubbing `_finishGitDeps.git`. Run it; watch it fail.
- [ ] Implement `src/finish/commit.ts`, porting `flows/nax-finish/steps/git.ts` onto `gitWithTimeout` (D2.6):

**`gitWithTimeout(args, workdir, timeoutMs)` prepends `"git"` itself** (`src/utils/git.ts:73`). Every argv in `flows/nax-finish/steps/git.ts` leads with `"git"`, so a verbatim copy spawns `git git status`. Strip the leading element from all six call sites.

```ts
export const _finishGitDeps = { git: gitWithTimeout };
// correct:   _finishGitDeps.git(["status", "--porcelain"], repoRoot)
// NOT:       _finishGitDeps.git(["git", "status", "--porcelain"], repoRoot)

/** Push can legitimately outrun the 10s default in `@/utils/git`; a gate that times out mid-push
 *  would report a failure that already half-happened. */
const PUSH_TIMEOUT_MS = 120_000;

export async function filesInCommit(repoRoot: string, sha: string): Promise<string[]>;
export async function commitFixes(
  repoRoot: string,
  message: string,
  opts?: { skipHooks?: boolean },
): Promise<{ committed: boolean; shaBefore: string | null; shaAfter: string | null }>;
export async function commitAndPush(repoRoot: string, branch: string, message: string): Promise<{ committed: boolean; pushed: boolean }>;
```

- [ ] Keep every behaviour of the original, each of which is load-bearing: `git add -A` not `-u` (a fix routinely adds a new test file, and an untracked file is invisible to `git diff <base>...HEAD`); `--no-verify` on mid-loop checkpoints only (a repo's pre-commit hook must not kill a run over an intermediate state the gate loop is about to fix); the terminal `commitAndPush` leaves hooks on; an unconditional push (the local branch may be ahead of its remote from the run's own commits); and a **throwing** commit failure — an uncommitted fix is unreviewable, and continuing silently reproduces #1397.
- [ ] Port `buildCommitRound` and `commitRoundOutcome` from `flows/nax-finish/steps/commit-round.ts`, with one change: **drop `attempt` from `CommitRoundInput` and return `Omit<FinishRound, "attempt">`**. `recordRound` (Task 3) is the sole assigner of that field; a builder that also sets it is the second writer D2.3 exists to remove. `sha` and `failing` stay *omitted* rather than nulled: a reader distinguishes "no commit" from "record lost" by the key's absence, which only works if absence never means anything else.

**Verification:**

- [ ] `bun test test/unit/finish/commit.test.ts test/unit/finish/commit-message.test.ts` — asserts: a clean tree commits nothing and returns `shaBefore === shaAfter`; a dirty tree runs `add -A` then `commit`; `skipHooks` adds `--no-verify` and the terminal push path does not; a failing `git commit` throws `NaxError`; the push uses `PUSH_TIMEOUT_MS`, not the 10s default. (`partitionTestFiles` is covered by `route.test.ts` — Task 2.)
- [ ] `bun x tsc --noEmit && bun run lint`.
- [ ] Commit: `feat(finish): add commit rounds on nax's own git helper`.

---

### Task 5: Context load

**Files:** `src/finish/context.ts`, `test/unit/finish/context.test.ts`

Replaces `load_ctx`, which shelled `nax features resolve --json` and re-parsed its output. In-process the resolver is a direct call, so the JSON contract, the `FINISH_RESOLVE_UNPARSEABLE` error and `toAcceptanceStatus`'s degrade-to-`no-prd` narrowing all disappear — there is nothing left to narrow.

**One call, not three.** `resolveFeatureSpec` already returns `acceptance` (from `resolveFeatureAcceptance`) and `testPatterns` on an `ok` result (`src/cli/features-resolve.ts:205-212`) — it is exactly what backs the `--json` output the flow was parsing. Calling the three resolvers separately would run acceptance resolution twice and lose the "resolve once" property `load_ctx`'s header comment exists to state. Note also that `testPatterns.regex` is **already `string[]` of sources**, not `RegExp[]`; there is no `.source` mapping to do.

**Steps:**

- [ ] Write `test/unit/finish/context.test.ts` first, stubbing the injected resolvers. Run it; watch it fail.
- [ ] Implement `src/finish/context.ts`:

```ts
export const _finishContextDeps = {
  git: gitWithTimeout,         // @/utils/git
  resolveFeatureSpec,          // @/cli  -- the barrel; @/cli/features-resolve is an alias-internal violation
};

export interface FinishContext {
  base: string;
  specPath: string;
  acceptanceStatus: AcceptanceResolutionStatus;   // "ok" | "disabled" | "no-prd"
  groups: AcceptanceGroupResult[];
  /** Regex sources from the ADR-009 SSOT. Empty means "cannot classify", never "nothing is a test". */
  testFileRegex: string[];
  // `AcceptanceGroupResult` and `AcceptanceResolutionStatus` are type-only exports of `@/cli`.
  commitsAhead: number;
  route: "proceed" | "nothing-to-finish" | "escalate";
  reason?: string;
}

export async function loadFinishContext(feature: string, workdir: string): Promise<FinishContext>;
```

- [ ] `detectBaseBranch`: `git remote show origin`, match `/HEAD branch:\s*(\S+)/`, else verify `origin/main`, else `origin/master`. Port verbatim — the unverified last resort is exactly why preflight below must not trust a zero.
- [ ] Feature resolution: **one** `resolveFeatureSpec(feature, workdir)` call, read for all three fields.
  - A result whose `specSource` is null (`status` `missing` or `feature-not-found`) is **not** a proceed — return `route: "escalate"` with a reason naming the feature and its `checked` paths. The flow threw `FINISH_SPEC_NOT_FOUND` here; escalating is the same decision routed instead of thrown (I7).
  - **Wrap the call in a `try/catch`.** Unlike `resolveFeatureAcceptance`, which is documented never to throw, `resolveFeatureSpec` has no internal catch and `validateFeatureName` throws on an invalid feature name (`features-resolve.ts:200`). Context load runs before the machine, so its outer catch is not in play yet — a throw here must become `route: "escalate"`, not an unhandled rejection in the post-run phase.
  - Take `acceptance.status` and `acceptance.groups` as given; the resolver degrades to `no-prd` itself, so the flow's `toAcceptanceStatus` narrowing is dead weight in-process — do not port it. Absent `acceptance` (only possible on a non-`ok` status, which already escalated) is `no-prd` with no groups.
  - `testPatterns?.regex ?? []` is the classification input. `[]` means "cannot classify" downstream (Task 4), never "nothing is a test file".
- [ ] Preflight: `git rev-list --count <base>..HEAD`. **A failed count must never be reported as zero.** Both a non-zero exit and an unreadable stdout return `route: "escalate"` with the ported reason text; only a parsed finite count may return `nothing-to-finish`. This is the defect that made a finish report "nothing to finish" having verified, reviewed and pushed nothing.

**Verification:**

- [ ] `bun test test/unit/finish/context.test.ts` — asserts: a null `specSource` escalates and does not proceed with an empty `specPath`; `git rev-list` exiting non-zero escalates rather than returning 0; `rev-list` exiting 0 with empty stdout escalates; a count of 0 returns `nothing-to-finish`; `resolveTestFilePatterns` throwing yields `testFileRegex: []` and does not fail the load; `acceptanceStatus: "disabled"` is passed through untouched.
- [ ] `bun x tsc --noEmit && bun run lint`.
- [ ] Commit: `feat(finish): resolve finish context in-process instead of shelling the CLI`.

---

### Task 6: The acceptance gate

**Files:** `src/finish/gates/acceptance.ts`, `test/unit/finish/gates-acceptance.test.ts`

**Steps:**

- [ ] Write `test/unit/finish/gates-acceptance.test.ts` first, stubbing `_acceptanceGateDeps.run`. Run it; watch it fail.
- [ ] Implement `src/finish/gates/acceptance.ts`:

```ts
export const _acceptanceGateDeps = { run: runQualityCommand };   // @/quality

// AcceptanceGateResult comes from ./types (Task 1) -- do not redeclare it here.

export async function runAcceptanceGate(
  repoRoot: string,
  groups: AcceptanceGroupResult[],
  opts?: { timeoutMs?: number },
): Promise<AcceptanceGateResult>;
```

- [ ] Build each group's command by substituting `{{FILE}}` / `{{file}}` / `{{files}}` with the **absolute, shell-quoted** test path, spawned with `cwd` = `repoRoot/packageDir`. Note in a comment that `AcceptanceGroupResult`'s own doc prescribes a cwd-relative path: absolute is what the flow ships today and works from any cwd, so the port keeps it, and the group's `cwd` field is still honoured for the spawn. Keep `shellQuote` (single quotes, `'` escaped) — a repo path with a space must not split the command.
- [ ] Default the command to the language runner (`uv run pytest` / `go test` / `bun test`) when the group has none, as today.
- [ ] Stop at the first non-zero exit and return `passed: false` — the fix loop only needs the first failure.
- [ ] Keep `missing` and `ran` reporting exactly: a group with `exists: false` is counted `missing` and not run, and `ran === 0` is reported as such in the output. **The caller decides what those mean** — `routeAcceptance` (Task 2) escalates on both. That is I1, and splitting the running from the routing is what makes it testable at both levels.

**Verification:**

- [ ] `bun test test/unit/finish/gates-acceptance.test.ts` — asserts: `{{FILE}}` is replaced with an absolute path and the spawn cwd is the package dir; a repo path containing a space produces a quoted, unsplit command; a non-zero exit short-circuits the remaining groups; `exists: false` lands in `missing` and does not spawn; an empty `groups` array yields `ran: 0, passed: true` **and** `routeAcceptance` turns that into `escalate` (I1); `routeAcceptance` on a pass with a non-empty `missing` escalates.
- [ ] `bun x tsc --noEmit && bun run lint`.
- [ ] Commit: `feat(finish): add the acceptance gate over resolved groups`.

---

### Task 7: The quality gate (fixes F2)

**Files:** `src/finish/gates/quality.ts`, `test/unit/finish/gates-quality.test.ts`

**Steps:**

- [ ] Write `test/unit/finish/gates-quality.test.ts` first. Run it; watch it fail.
- [ ] Implement `src/finish/gates/quality.ts`:

```ts
export const _qualityGateDeps = {
  run: runQualityCommand,                 // @/quality
  loadConfig,                             // @/config
  loadConfigForWorkdir,                   // @/config
  loadPackageOverride,                    // @/config
};

/** build -> typecheck -> lint -> test. No `format`: nax's quality.commands has no such key (D2.5). */
const GATE_ORDER = ["build", "typecheck", "lint", "test"] as const;

export interface GateCommand {
  /** `<gate>` at the root, `<gate>@<packageDir>` for a package overlay. */
  name: string;
  command: string;
  /** Absolute directory the command is spawned from. */
  cwd: string;
}

/**
 * Every gate command this repo actually configures, layered (fixes F2).
 *
 * Root commands come from `loadConfig(workdir)`, which applies the global
 * layer, the project file and the active profile chain — the flow read one
 * file and saw none of them. Package commands are added only for packages
 * whose own `.nax/mono/<pkg>/config.json` sets `quality.commands`: a package
 * that merely inherits the root commands is already covered by the root run,
 * and fanning it out would run the repo's whole test suite once per package.
 */
export async function resolveGateCommands(
  repoRoot: string,
  packageDirs: string[],
): Promise<GateCommand[]>;

// QualityGateResult comes from ./types (Task 1) -- do not redeclare it here.

export async function runQualityGates(
  repoRoot: string,
  commands: GateCommand[],
  opts?: { timeoutMs?: number },
): Promise<QualityGateResult>;
```

- [ ] `resolveGateCommands` orders root gates by `GATE_ORDER` first, then each package's gates by `GATE_ORDER`, packages in the order given. Dedupe on `(cwd, command)` — an overlay that repeats the root command verbatim from the same directory is one gate, not two.
- [ ] `runQualityGates` runs every command (it does **not** stop at the first failure — the fix step wants the full list of red gates), collects `failing`, and returns `passed: ran.length > 0 && failing.length === 0`. **Nothing ran is not a pass** (I1): with an empty command list it returns `passed: false, ran: []` and the ported output line, and `routeQualityGates` escalates on it, because an LLM fix step cannot invent the repo's build commands.
- [ ] `packageDirs` comes from the acceptance groups the feature touched (Task 8 passes them). Filter out `""` — the root package is the root run.

**Verification:**

- [ ] `bun test test/unit/finish/gates-quality.test.ts` — asserts: **a repo with no root `quality.commands` but a package overlay that sets `test` resolves that package's command and runs it** (the F2 regression, and the design's section 9 verification case); a profile-layered root command is picked up (stub `loadConfig` to return the layered value and assert it is used, proving the single-file read is gone); a package overlay identical to the root command from the same cwd is deduped; no commands anywhere yields `ran: []` and `routeQualityGates` escalates (I1); all four gates run even after the first one fails, and `failing` lists both.
- [ ] Prove the F2 test fails against the old behaviour: point `resolveGateCommands` at a single-file read of `<repoRoot>/.nax/config.json` and confirm the overlay case goes red. Revert.
- [ ] `bun x tsc --noEmit && bun run lint`.
- [ ] Commit: `fix(finish): resolve quality gate commands through layered config`.

---

### Task 8: The state machine

**Files:** `src/finish/ops.ts`, `src/finish/machine.ts`, `src/finish/index.ts`, `test/unit/finish/machine-invariants.test.ts`, `test/unit/finish/machine-loops.test.ts`

This is the task that buys the coverage the flow never had. `test/unit/flows/nax-finish/flow-graph.test.ts` (31KB) pokes `flow.nodes.*` with hand-stubbed contexts; nothing has ever executed acpx's engine, so the `edges` / `switch` / `cases` wiring — where all five silent-green bugs lived — is untested today. A machine with injected ops is directly drivable.

**Steps:**

- [ ] Write `src/finish/ops.ts` — the interface only, no implementations:

```ts
/**
 * Every step of a finish that talks to an LLM or a forge.
 *
 * Defined here and implemented in the next plan so the machine is drivable —
 * and therefore testable — before a single prompt exists. The machine must
 * treat every method as able to throw: its one try/catch is what makes
 * escalate reachable from every failure path (I7).
 */
export interface FinishOps {
  /** Run a reviewer. Returns undefined only if the op produced no output at all. */
  review(phase: "spec" | "quality", req: ReviewRequest): Promise<ReviewOutcome | undefined>;
  /** Apply fixes for one phase's findings. Dispositions arrive already validated (D2.7). */
  fix(phase: FinishPhase, req: FixRequest): Promise<FixOutcome>;
  /** Open a draft PR after the acceptance gate first passes (D7). Idempotent via `hasOpenPr`. */
  openDraftPr(state: FinishState): Promise<{ url: string } | null>;
  /** Push, then promote the draft to ready. Returns the terminal status. */
  promotePr(state: FinishState): Promise<{ status: "opened" | "promoted" | "already-ready"; url?: string }>;
  /** Improve the PR body prose. Optional; a run with narrative disabled omits it. */
  narrate?(state: FinishState): Promise<void>;
  /** Deliver an escalation to a human. Must not throw; delivery failure is reported, not raised. */
  escalate(state: FinishState, reason: string, findings: Finding[]): Promise<{ url?: string; deliveryError?: string }>;
}
```

- [ ] Write both test files first, driving `runFinishMachine` with stub ops. Run them; watch them fail.
- [ ] Implement `src/finish/machine.ts`:

```ts
export interface FinishMachineDeps {
  context: FinishContext;
  ops: FinishOps;
  audit: AuditTarget;
  signal?: AbortSignal;
  now: () => string;          // injected: the machine tests assert round ordering
  timeouts?: FinishTimeouts;
}

export async function runFinishMachine(state: FinishState, deps: FinishMachineDeps): Promise<FinishResult>;
```

- [ ] Structure the body as one `try` around a sequence of small phase functions, with a single `catch` that routes anything at all to `escalate` (I7). Keep each phase function under ~40 lines so the file stays well inside 600.
- [ ] Order and edges, mirroring `nax-finish.flow.ts` exactly:
  1. `context.route === "escalate"` -> escalate. `nothing-to-finish` -> terminal result, no PR, no review.
  2. **Acceptance loop.** Run the gate; `routeAcceptance`. On `fix`: `ops.fix("acceptance")`, `commitFixes(skipHooks: true)`, `recordRound`, increment `fixAttempts`, loop. On `escalate`: escalate.
  3. **First pass of acceptance opens the draft PR** (D7) via `ops.openDraftPr`, once, guarded by `state.prUrl`. A null return (forge unavailable) is not fatal — the run continues without a draft.
  4. **Spec loop.** `ops.review("spec")` -> increment `reviewAttempts` -> `routeReview`. `clean` -> quality. `incomplete` -> increment `incompleteAttempts`, re-review. `fix` -> fix, commit, record, **then re-run the acceptance gate before re-reviewing** (I8) — a spec fix can break the contract acceptance proved. `escalate` -> escalate.
  5. **Quality loop.** Same shape; `fix` -> fix, commit, record, re-review (no acceptance re-run here; the gates below cover it).
  6. **Quality gates.** First re-run acceptance as gate zero (I5), skipped only when `acceptanceStatus === "disabled"` — the same resolver field the acceptance step honours. A failure short-circuits to the gate fix loop with `failing: ["acceptance"]` and does **not** fall through to the "nothing configured" branch, which would misreport configured-but-skipped commands as absent. Then `resolveGateCommands` + `runQualityGates` + `routeQualityGates`.
  7. **Gate fix loop.** `ops.fix("gate")`, commit, `gateCommitRoute`, record the round *after* routing (the round's `route` field is part of the record). `changed` and `tests-only` both re-enter the **quality review** (I4); `unchanged` re-runs the gates.
  8. **Terminal.** `ops.promotePr`, then `ops.narrate?.()`, then `writeResult`.
- [ ] Every recorded round goes through `recordRound` (Task 3). Rounds that fix go in after the commit; rounds that do not (`passed`, `escalated`, `incomplete`) go in at the routing point. Never both for one round — double-recording double-counts every fixed round in the PR body.
- [ ] Check `deps.signal?.aborted` at the top of every loop iteration and before each op, throwing a `NaxError("FINISH_ABORTED")` that the outer catch turns into an escalation. This is what replaces `proc.kill()` — and it is strictly better: killing the acpx subprocess left the working tree wherever the fix step had reached, with no round recorded.
- [ ] Write `src/finish/index.ts` exporting only what a consumer needs: `runFinishMachine`, `loadFinishContext`, `createFinishState`, the `FinishOps` interface, and the types. Do not re-export `_*Deps` seams; tests reach them through `@/finish` only if they are exported, so export the ones the tests need and no others.

**Verification:**

- [ ] `bun test test/unit/finish/machine-invariants.test.ts` — one named test per invariant:
  - **I1** — empty acceptance groups escalate; and separately, no gate commands anywhere escalates. Two assertions, because they were two different bugs.
  - **I2** — every `ops.fix` call is followed by a commit before the next `ops.review`. Assert on call order recorded by the stubs, not on internals.
  - **I3** — a stub reviewer that returns findings forever escalates after exactly `MAX_FIX_ATTEMPTS` fixes, and a stub that self-reports a "clean" route while returning findings does not shorten the loop. Caps come from the loop, never the model.
  - **I4** — a gate fix that commits production code re-enters `ops.review("quality")`; one that commits only test files does too (#1510 closed the skip).
  - **I5** — acceptance runs again inside the quality-gate step, before any repo command.
  - **I6** — a machine aborted mid-loop (signal fired after the first commit) still leaves that round in the trail.
  - **I7** — a throw from each of `review`, `fix`, `openDraftPr`, `promotePr` and the gates individually reaches `ops.escalate`. Parameterise over the op names so a future op cannot silently opt out.
  - **I8** — a spec fix re-runs the acceptance gate before the spec re-review.
- [ ] `bun test test/unit/finish/machine-loops.test.ts` — the happy path opens a draft after acceptance and promotes at the end; `nothing-to-finish` never calls a reviewer; a `disabled` acceptance status skips both acceptance runs but still runs the repo gates; `incomplete` re-reviews exactly once then escalates.
- [ ] `bun test test/unit/finish/` — the whole suite.
- [ ] `bun x tsc --noEmit && bun run lint && bun run test` — the full repo suite. `flows/` tests must still pass untouched; if any of them changed, something imported across the boundary.
- [ ] `bun scripts/check-file-sizes.ts` — confirm `machine.ts` is under 600.
- [ ] Commit: `feat(finish): add the finish state machine with injected LLM seams`.

---

## Self-Review

Before opening the PR, verify each of these by running the command, not by reading the code.

- [ ] **Nothing is wired.** `grep -rn "@/finish" src --include='*.ts' | grep -v "^src/finish/"` returns nothing. This plan adds a tree; plan 4 wires it.
- [ ] **No boundary crossing.** `grep -rn "flows/" src/finish/` and `grep -rn "@/" flows/` both return nothing.
- [ ] **The old path still works.** `bun test test/unit/flows/` is green and `git diff --stat main -- flows/` is empty.
- [ ] **One round writer.** `grep -rn "appendRound" src/finish/` shows calls only in `audit.ts`.
- [ ] **The state stays serializable.** `grep -rnE "new (Map|Set)\(|=> " src/finish/state.ts` shows nothing in the interface or the constructors.
- [ ] **The two regression tests were proven against the old behaviour**, not merely passing against the new — Task 3 and Task 7 each have an explicit revert step. If you skipped either, do it now: a fix that was never seen to fail is indistinguishable from a coincidence.
- [ ] **Baselines unchanged.** `bun scripts/check-deep-relatives.ts` and `bun scripts/check-nax-error.ts` pass without `--update-baseline`.
- [ ] **Barrels respected.** `bun scripts/check-alias-internals.ts` passes. The likely violation is `@/cli/features-resolve` or `@/finish/types`; both must be `@/cli` and `./types`.
- [ ] **No import cycle from the CLI barrel.** `@/cli` is a heavy barrel (it re-exports `planCommand` and the plan pipeline). It does not import `@/execution` at runtime today — only a single type-only import in `status-features.ts` — so `src/finish` -> `@/cli` is acyclic, but plan 4 wires `src/finish` into `src/execution/runner-completion.ts`. Confirm `bun x tsc --noEmit` is clean and that `bun test test/unit/finish/` does not warn about a partially-initialized module before handing over.

## Follow-on plans

Write each only once its predecessor's real API surface exists — that is why they are not written yet.

- **Plan 3 — review, ops and PR.** `review/references/*.md` as canonical prose plus the committed `prompts.gen.ts` and its drift check; `review/prompt.ts`, `review/parse.ts` (with `GLUED_HEADING` deleted), `review/audit-gaps.ts` including `validateDispositions`; the three `RunOperation`s behind `callOp`, with four new entries in `KNOWN_SESSION_ROLES`; `pr.ts` and `escalate.ts`. Implements `FinishOps` against the interface this plan froze.
- **Plan 4 — wiring and deletion.** `"finish"` into `PostRunPhase` and its three non-obvious sites; `runFinishPhase` in `runner-completion.ts` before `runtime.close()`; the cost snapshot delta; `finish.autoFlow.*` flattened to `finish.*` with compat shims; then delete `flows/`, `src/plugins/builtin/nax-finish/`, `scripts/check-flows-no-bun.ts` and `"flows/"` from `package.json` `files`.
