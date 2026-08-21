import type { NaxConfig } from "../config/schema";
import type { AutofixConfig } from "../config/selectors";
import type { TddConfig } from "../config/selectors";
import type { FixStrategy } from "../findings";
import type { Finding } from "../findings/types";
import type { UserStory } from "../prd";
import { RectifierPromptBuilder } from "../prompts";
import { captureGitRef, captureWorkingTreeChanges } from "../utils/git";
import type { DeclarationSink } from "./declaration-sink";
import type { FullSuiteRectifyInput, FullSuiteRectifyOutput } from "./full-suite-rectify-op";
import { fullSuiteRectifyOp } from "./full-suite-rectify-op";
import type { ImplementerInput, ImplementerOutput } from "./implement";
import { implementerOp } from "./implement";

/**
 * Factory for the full-suite rectify strategy. Closes over `story` so `buildInput`
 * never reads from `ctx.story` (which is optional on CallContext and would crash
 * at runtime for ad-hoc / non-pipeline invocations).
 *
 * Call site: buildPlanForStrategy + run-regression.ts — the story is always available.
 *
 * When `sink` is provided the strategy switches to `fullSuiteRectifyOp` and
 * `extractApplied` pushes parsed declarations into the shared sink for downstream
 * processing (mock_structure → mockHandoffs, others → testEdits).
 *
 * `hasTestWriterDrainer` (sink variant only) gates the mock-structure handoff
 * short-circuit. When `true`, this exclusive strategy stops claiming failing-test
 * findings while a mock_structure handoff is pending (`sink.mockHandoffs.length > 0`),
 * so `selectExecutionGroup` falls through to the co-run `autofix-test-writer` that
 * drains the handoff — instead of re-invoking the implementer up to its per-strategy
 * cap to re-declare the identical handoff (#1352). The suppression is self-limiting:
 * the test-writer drains `sink.mockHandoffs` in one iteration, after which this
 * strategy reclaims normally. Pass `true` ONLY where an `autofix-test-writer` is
 * registered on the same sink; otherwise suppressing here orphans the finding
 * (`exitReason: "no-strategy"` — #1330/#1327).
 */
export function makeFullSuiteRectifyStrategy(
  story: UserStory,
  config: NaxConfig,
  sink: DeclarationSink,
  hasTestWriterDrainer?: boolean,
): FixStrategy<Finding, FullSuiteRectifyInput, FullSuiteRectifyOutput, AutofixConfig>;
export function makeFullSuiteRectifyStrategy(
  story: UserStory,
  config: NaxConfig,
): FixStrategy<Finding, ImplementerInput, ImplementerOutput, TddConfig>;
export function makeFullSuiteRectifyStrategy(
  story: UserStory,
  config: NaxConfig,
  sink?: DeclarationSink,
  hasTestWriterDrainer?: boolean,
):
  | FixStrategy<Finding, FullSuiteRectifyInput, FullSuiteRectifyOutput, AutofixConfig>
  | FixStrategy<Finding, ImplementerInput, ImplementerOutput, TddConfig> {
  const claimsFailingTest = (finding: Finding): boolean =>
    finding.source === "test-runner" && (finding.category === "failed-test" || finding.category === "execution-failed");

  if (sink) {
    // While a mock_structure handoff is pending AND a test-writer is registered to
    // drain it, stop claiming — hand selection to the co-run `autofix-test-writer`
    // this iteration instead of re-running the implementer (#1352).
    const appliesTo = (finding: Finding): boolean =>
      claimsFailingTest(finding) && !(hasTestWriterDrainer === true && sink.mockHandoffs.length > 0);

    return {
      name: "full-suite-rectify",
      appliesTo,
      fixOp: fullSuiteRectifyOp,
      buildInput: (findings) => ({ story, findings }),
      extractApplied: (output: FullSuiteRectifyOutput) => {
        for (const d of output.testEditDeclarations) {
          if (d.reason === "mock_structure" && d.files && d.files.length > 0) {
            sink.mockHandoffs.push({ files: d.files, reasonDetail: d.reasonDetail ?? "" });
          } else if (d.reason !== "mock_structure") {
            sink.testEdits.push(d);
          }
        }
        // Only propagate `unresolved` (triggering agent-gave-up exit) when there
        // are no testEditDeclarations. If the agent emitted UNRESOLVED alongside an
        // Exception 4(b) declaration, the declaration takes priority so postValidate
        // can still invoke the test-writer handoff to fix the broken test.
        const hasDeclarations = output.testEditDeclarations.length > 0;
        const unresolved = output.unresolvedReason && !hasDeclarations ? output.unresolvedReason : undefined;
        return {
          targetFiles: [],
          // Mirror `unresolved`: when a declaration suppresses the give-up, the iteration
          // is a handoff, not a give-up — don't label the summary with the UNRESOLVED text.
          summary: unresolved ?? "Fixed failing tests",
          ...(unresolved ? { unresolved } : {}),
        };
      },
      maxAttempts: config.execution.rectification.maxAttemptsPerStrategy,
      coRun: "exclusive",
    };
  }

  return {
    name: "full-suite-rectify",
    appliesTo: claimsFailingTest,
    fixOp: implementerOp,
    buildInput: (findings) => ({
      story,
      contextMarkdown: RectifierPromptBuilder.failingTestContext(findings),
    }),
    extractApplied: () => ({ targetFiles: [], summary: "Fixed failing tests" }),
    maxAttempts: config.execution.rectification.maxAttemptsPerStrategy,
    coRun: "exclusive",
  };
}

/**
 * Injectable git seam for repo-scoped change attribution (#1658).
 *
 * The files a repo-scoped dispatch changed come from git, not from the agent's
 * own report: `fullSuiteRectifyOp` emits free-form prose with declaration
 * markers rather than a `filesChanged` envelope, and a self-report is precisely
 * what goes stale when the agent is wrong about what it did.
 */
export const _repoScopedFixDeps = {
  captureGitRef,
  captureWorkingTreeChanges,
};

/**
 * Factory for the repo-scoped test-fix strategy (#1654).
 *
 * Registered alongside `makeFullSuiteRectifyStrategy` as the fallthrough
 * claimant for failing tests it declined. Both claim the same findings, but
 * retirement and attempt caps are keyed on the strategy NAME, so the
 * story-scoped give-up retires only that strategy and `runFixCycle` dispatches
 * this one instead of exiting `agent-gave-up`.
 *
 * Three deliberate differences from the story-scoped strategy:
 *   - `buildInput` sets `scope: "repo"`, which swaps the mandate for one that
 *     permits editing files outside the story (the test-integrity rules and the
 *     declaration protocol are unchanged — see `repoScopedRectification`).
 *   - `sessionRole: "repo-scoped-test-fix"` gives the dispatch a session of its own.
 *     Session resume is keyed on the role, so this does not continue the
 *     implementer conversation that just answered UNRESOLVED — the agent is not
 *     asked to reverse a refusal still sitting in its own context, and the
 *     story-scoped framing that is now wrong does not carry over.
 *   - `maxAttempts: 1`. This is the last claimant, not another escalation rung:
 *     if it also gives up, the cycle exits `agent-gave-up` as before.
 *
 * Declarations go to the same `sink` as the story-scoped strategy — a test edit
 * made here is subject to the same downstream handling as any other.
 */
export function makeRepoScopedTestFixStrategy(
  story: UserStory,
  sink: DeclarationSink,
): FixStrategy<Finding, FullSuiteRectifyInput, FullSuiteRectifyOutput, AutofixConfig> {
  // Attribution state for #1658, captured in `buildInput` and read back in
  // `extractApplied`. `runFixCycle` calls those two around a single awaited
  // dispatch, sequentially, and this strategy is `coRun: "exclusive"` with
  // `maxAttempts: 1` — so there is exactly one dispatch in flight and the pair
  // cannot interleave. Kept in the closure rather than threaded through the
  // input so the shared `FullSuiteRectifyInput` stays a description of the
  // request rather than a carrier for bookkeeping.
  let pendingBaseRef: Promise<string | undefined> | undefined;
  let dispatchWorkdir: string | undefined;

  /** Files this dispatch changed. Reporting only — never fails the dispatch. */
  const changedFiles = async (): Promise<string[]> => {
    try {
      const baseRef = await pendingBaseRef;
      if (!baseRef || !dispatchWorkdir) return [];
      return await _repoScopedFixDeps.captureWorkingTreeChanges(dispatchWorkdir, baseRef);
    } catch {
      return [];
    }
  };

  return {
    name: "repo-scoped-test-fix",
    appliesTo: (finding: Finding): boolean =>
      finding.source === "test-runner" &&
      (finding.category === "failed-test" || finding.category === "execution-failed"),
    fixOp: fullSuiteRectifyOp,
    sessionRole: "repo-scoped-test-fix",
    buildInput: (findings, _priorIterations, ctx) => {
      // Fired (not awaited) immediately before the dispatch; it resolves while
      // the agent works, so attribution costs no extra wall-clock.
      dispatchWorkdir = ctx.packageDir;
      pendingBaseRef = _repoScopedFixDeps.captureGitRef(ctx.packageDir).catch(() => undefined);
      return { story, findings, scope: "repo" as const };
    },
    extractApplied: async (output: FullSuiteRectifyOutput) => {
      for (const d of output.testEditDeclarations) {
        if (d.reason !== "mock_structure") sink.testEdits.push(d);
      }
      // No mock-structure handoff is offered at repo scope (the story's
      // test-writer does not own tests outside the story), so unlike the
      // story-scoped strategy there is no declaration that can suppress the
      // give-up: UNRESOLVED here means the cycle is genuinely done.
      const unresolved = output.unresolvedReason;
      return {
        targetFiles: await changedFiles(),
        summary: unresolved ?? "Fixed failing tests (repo scope)",
        ...(unresolved ? { unresolved } : {}),
      };
    },
    maxAttempts: 1,
    coRun: "exclusive",
  };
}
