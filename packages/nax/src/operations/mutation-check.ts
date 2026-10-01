/**
 * Mutation-Check Deterministic Operation
 *
 * Opt-in mutation-testing spot-check that runs after GREEN passes to verify the
 * test suite actually catches real defects. Always advisory (success: true) and
 * always restores the worktree (revertMutant runs in a `finally`).
 *
 * Combination shape:
 *  - DeterministicOperation like greenfieldGateOp (filesystem/inspection, no LLM)
 *  - Executes tests like verifyScopedOp (DI'd regression + selectScopedTests)
 *
 * DI collaborators (mirrors _verifyScopedDeps) so unit tests need no real git/test run.
 */

import { isAbsolute, join } from "node:path";
import { mutationCheckConfigSelector, qualityConfigSelector } from "../config";
import type { MutationCheckConfig } from "../config/selectors";
import { getLogger } from "../logger";
import type { UserStory } from "../prd";
import { detectLanguage } from "../project/detector";
import type { MutationOutcomeSummary } from "../runtime/mutation-summary";
import type { ResolvedTestPatterns } from "../test-runners";
import type { SelectScopedTestsInput, SelectScopedTestsResult } from "../test-runners/scoped-selection";
import { selectScopedTests } from "../test-runners/scoped-selection";
import { getGitRoot } from "../utils/git";
import { isInside, realOrRaw } from "../utils/realpath";
import { getChangedLineRanges } from "../verification/changed-line-ranges";
import {
  applyMutant,
  classifyMutant,
  clearInFlight,
  generateMutants,
  mayHaveJournal,
  recordInFlight,
  restoreInFlight,
  revertMutant,
  selectEvenlySpaced,
} from "../verification/mutation";
import type { Mutant, MutantOutcome, SurvivingMutant } from "../verification/mutation/types";
import { regression } from "../verification/runners";
import { getChangedNonTestFiles } from "../verification/smart-runner";
import type { VerificationGateOptions, VerificationResult } from "../verification/types";
import type { CallContext, DeterministicOperation } from "./types";

export interface MutationCheckInput {
  readonly story: UserStory;
  readonly workdir: string;
  readonly storyId: string;
  readonly packageDir?: string;
  readonly storyGitRef?: string;
  readonly repoRoot?: string;
  readonly packagePrefix?: string;
  readonly resolvedTestPatterns: ResolvedTestPatterns;
}

export interface MutationCheckOutput {
  readonly success: true;
  readonly survivors: readonly SurvivingMutant[];
  readonly outcomes: MutationOutcomeSummary;
  readonly candidates: number;
  readonly checked: boolean;
  /**
   * Set only when a revert could not be confirmed, meaning the worktree may
   * still hold an injected mutation. Absent on every clean path.
   */
  readonly revertFailed?: true;
}

export interface MutationCheckDeps {
  detectLanguage: typeof detectLanguage;
  getChangedNonTestFiles: typeof getChangedNonTestFiles;
  getChangedLineRanges: typeof getChangedLineRanges;
  getGitRoot: typeof getGitRoot;
  selectScopedTests: (input: SelectScopedTestsInput) => Promise<SelectScopedTestsResult>;
  regression: (opts: VerificationGateOptions) => Promise<VerificationResult>;
}

export const _mutationCheckDeps: MutationCheckDeps = {
  detectLanguage,
  getChangedNonTestFiles,
  getChangedLineRanges,
  getGitRoot,
  selectScopedTests,
  regression,
};

/**
 * Restore any mutation an earlier run applied but never confirmed reverted.
 *
 * Fail-open like the rest of the check: a sweep that throws is logged and
 * swallowed. Leftover cleanup must never be the thing that fails a run.
 */
async function sweepLeftoverMutants(repoRoot: string, storyId: string): Promise<void> {
  const logger = getLogger();
  try {
    for (const result of await restoreInFlight(repoRoot)) {
      const { entry, outcome } = result;
      if (outcome === "already-clean") continue;
      const data = {
        storyId,
        appliedByStory: entry.storyId,
        file: entry.file,
        line: entry.line,
        operatorId: entry.operatorId,
      };
      if (outcome === "restored") {
        logger.warn("mutation-check", "Restored a mutation left behind by an interrupted run", data);
      } else {
        // Nothing to undo — the line holds neither the mutant nor the
        // original, so this log is the only remaining record of it.
        logger.error("mutation-check", "Cannot restore a mutation from an interrupted run — line was rewritten", {
          ...data,
          expected: entry.after,
          actual: result.actual,
        });
      }
    }
  } catch (err) {
    logger.warn("mutation-check", "Leftover-mutation sweep failed — continuing", {
      storyId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export const mutationCheckOp: DeterministicOperation<
  MutationCheckInput,
  MutationCheckOutput,
  MutationCheckConfig,
  MutationCheckDeps
> = {
  kind: "deterministic",
  name: "mutation-check",
  stage: "verify",
  config: mutationCheckConfigSelector,
  async execute(
    input: MutationCheckInput,
    ctx: CallContext,
    deps: MutationCheckDeps = _mutationCheckDeps,
  ): Promise<MutationCheckOutput> {
    const cfg = ctx.packageView.select(mutationCheckConfigSelector);
    const emptyOutput: {
      survivors: readonly SurvivingMutant[];
      outcomes: MutationOutcomeSummary;
      candidates: number;
      checked: boolean;
    } = {
      survivors: [],
      outcomes: { killed: 0, survived: 0, errored: 0 },
      candidates: 0,
      checked: false,
    };
    const logger = getLogger();
    const record = (
      result: {
        survivors: readonly SurvivingMutant[];
        outcomes: MutationOutcomeSummary;
        candidates: number;
        checked: boolean;
        revertFailed?: true;
      },
      /**
       * Why nothing was measured, when the gate exited after the enabled check
       * but before mutating anything. Absent on a completed check. Kept off
       * `result` so it stays out of the stored `MutationStorySummary`.
       */
      skipReason?: string,
    ) => {
      if (ctx.storyId) {
        ctx.runtime?.mutationSummaries?.set(ctx.storyId, { storyId: ctx.storyId, ...result });
      }
      // `mutationSummaries` is in-memory and the run-end summary is stdout-only,
      // so without this line a run where every mutant was killed leaves no trace
      // on disk at all — survivors were the only outcome ever persisted. The
      // kill rate needs its denominator (`candidates`) recorded next to it, or
      // the soft-gate decision cannot be made from run artifacts.
      //
      // Only when the gate actually ran: the feature is default-off everywhere
      // but nax's own repo, and a row of zeroes from a disabled gate would read
      // as a real all-errored measurement.
      if (result.checked) {
        logger.info("mutation-check", "Mutation spot-check outcomes", {
          storyId: input.storyId,
          killed: result.outcomes.killed,
          survived: result.outcomes.survived,
          errored: result.outcomes.errored,
          candidates: result.candidates,
          // An all-zero row means "bailed" or "nothing to mutate" — without this
          // the two are indistinguishable, and a bail would be counted as a real
          // zero-candidate measurement.
          ...(skipReason ? { skipReason } : {}),
          // The counts describe a tree this op did not leave clean.
          ...(result.revertFailed ? { revertFailed: true } : {}),
        });
      }
    };
    // A mutation left behind by an interrupted run must still be restored if
    // the feature is turned off afterwards, so the sweep precedes the enabled
    // gate. Resolving the anchor costs a `git rev-parse` subprocess though, and
    // the feature is off by default — so when it is disabled, probe the paths
    // already in hand first and spawn nothing unless a journal might exist.
    if (!cfg?.enabled) {
      if (await mayHaveJournal([input.workdir, input.repoRoot])) {
        await sweepLeftoverMutants((await deps.getGitRoot(input.workdir)) ?? input.workdir, input.storyId);
      }
      record(emptyOutput);
      return { success: true as const, ...emptyOutput };
    }

    // Anchor the journal to the WORKING TREE, not the project root. In parallel
    // mode every story runs in its own git worktree while `repoRoot`
    // (`ctx.projectDir`) stays the shared main repo — anchoring there gives all
    // concurrent stories one journal directory, and since entries carry
    // absolute paths, one story's sweep would restore another's in-flight
    // mutation mid-check. `getGitRoot` inside a worktree returns that worktree.
    const journalRoot = (await deps.getGitRoot(input.workdir)) ?? input.workdir;
    await sweepLeftoverMutants(journalRoot, input.storyId);

    const packageDir = input.packageDir ?? input.workdir;
    const language = await deps.detectLanguage(packageDir);
    const quality = ctx.packageView.select(qualityConfigSelector);
    let baseTestCommand = quality.quality?.commands?.test;
    if (!baseTestCommand) {
      const { resolveDefaultQualityCommands } = await import("../quality/command-defaults");
      baseTestCommand = (await resolveDefaultQualityCommands(input.workdir)).test;
    }
    if (!baseTestCommand) {
      logger.warn("mutation-check", "No test command configured — skipping mutation spot-check", {
        storyId: input.storyId,
      });
      record(emptyOutput);
      return { success: true as const, ...emptyOutput };
    }
    const changedFiles = await deps.getChangedNonTestFiles(
      input.workdir,
      input.storyGitRef,
      input.packagePrefix,
      [...input.resolvedTestPatterns.regex],
      undefined,
      input.repoRoot,
    );
    // getChangedNonTestFiles only strips the git-root/repoRoot prefix mismatch
    // (issue #565) when both packagePrefix and repoRoot are set — its returned
    // paths are then repoRoot-relative. Otherwise that surgery never runs and
    // the paths stay git-root-relative (raw `git diff --name-only` output).
    // Anchor to whichever root the paths are actually relative to, matching
    // the same git-root resolution getChangedLineRanges performs internally
    // (#1485). Mirror the exact gate `getChangedNonTestFiles` uses.
    const anchor =
      input.packagePrefix && input.repoRoot
        ? input.repoRoot
        : ((await deps.getGitRoot(input.workdir)) ?? input.workdir);
    // Unfiltered git diffs from the git-root anchor can surface files outside
    // the project (e.g. when the git root is an ancestor of repoRoot) —
    // constrain candidates to the project scope so mutation testing never
    // reads/writes source outside it.
    const scopeRoot = input.repoRoot ?? input.workdir;
    // Comparisons resolve symlinks; reporting does not. `getGitRoot` answers
    // with git's realpath while `repoRoot` / `workdir` keep the caller's
    // spelling, and `getChangedLineRanges` anchors on the resolved form — so on
    // macOS (`/tmp` -> `/private/tmp`) the two never matched. Depending on which
    // branch `anchor` took, that either sent every file to `unmappedFiles` or,
    // worse, made the containment filter reject all of them and skip the
    // zero-candidate warning with it (#1485).
    //
    // `resolved` is the lookup/containment key only. `path` stays as the caller
    // spelled it and is what gets read, mutated, journalled, and reported, so a
    // survivor still names the path the operator recognises rather than an
    // unfamiliar `/private/...` twin.
    const absoluteChangedFiles = changedFiles
      .map((f) => {
        const path = isAbsolute(f) ? f : join(anchor, f);
        return { path, resolved: realOrRaw(path) };
      })
      .filter(({ resolved }) => isInside(scopeRoot, resolved));

    const rawRangeMap = await deps.getChangedLineRanges(input.workdir, input.storyGitRef);
    // Re-key through the SAME normaliser the candidate keys went through.
    // `getChangedLineRanges` anchors on `getGitRoot` (already git's realpath)
    // but falls back to a raw `workdir` when that lookup fails, so its keys are
    // only conditionally resolved — normalising here makes both sides of the
    // lookup below unconditionally comparable.
    const rangeMap =
      rawRangeMap === null ? null : new Map([...rawRangeMap].map(([path, value]) => [realOrRaw(path), value]));
    if (rangeMap === null) {
      logger.warn("mutation-check", "Failed to obtain changed-line ranges — skipping mutation spot-check", {
        storyId: input.storyId,
      });
      record({ ...emptyOutput, checked: true }, "changed-line-ranges-unavailable");
      return { success: true as const, ...emptyOutput, checked: true };
    }

    const survivors: SurvivingMutant[] = [];
    const outcomes = { killed: 0, survived: 0, errored: 0 };
    // Gather every candidate across all changed files, then select a
    // deterministic evenly-spread subset once the full list is known.
    // Per-file early-breaks would re-introduce the first-file-only bias
    // and a top-of-file bias simultaneously.
    const mutants: Mutant[] = [];
    let unmappedFiles = 0;
    for (const { path: file, resolved } of absoluteChangedFiles) {
      const lineRanges = rangeMap.get(resolved);
      if (lineRanges === undefined) {
        unmappedFiles++;
        logger.debug("mutation-check", "Changed file has no diff line ranges — skipping", {
          storyId: input.storyId,
          file,
        });
        continue;
      }
      try {
        const source = await Bun.file(file).text();
        for (const m of generateMutants({ source, language, file, lineRanges })) {
          mutants.push(m);
        }
      } catch (err) {
        // Fail-open: a source read failure never fails the story — skip this file.
        logger.warn("mutation-check", "Failed to read changed file — skipping", {
          storyId: input.storyId,
          file,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    // Every changed file missing from the range map is indistinguishable from
    // "nothing mutable" at debug level — surface it so a total path-anchoring
    // mismatch (#1485) doesn't silently produce a zero-candidate no-op.
    if (absoluteChangedFiles.length > 0 && unmappedFiles === absoluteChangedFiles.length) {
      logger.warn(
        "mutation-check",
        "No changed file matched the diff line-range map — mutation spot-check produced zero candidates, possibly due to a path-anchoring mismatch",
        { storyId: input.storyId, changedFiles: absoluteChangedFiles.length },
      );
    }
    const selected = selectEvenlySpaced(mutants, cfg.maxMutants);
    // Loop-invariant: every argument comes from `input`/`quality`, none from
    // the mutant, so the scoped selection is identical on every iteration.
    // Resolving it once turns maxMutants git-diff-plus-import-grep passes into
    // one. Kept behind the emptiness guard because "no mutants selected" must
    // still mean "no test selection performed".
    let scoped: SelectScopedTestsResult | undefined;
    if (selected.length > 0) {
      try {
        scoped = await deps.selectScopedTests({
          workdir: input.workdir,
          storyId: input.storyId,
          storyGitRef: input.storyGitRef,
          testCommand: baseTestCommand,
          testScopedTemplate: quality.quality?.commands?.testScoped,
          smartRunnerConfig: quality.execution?.smartTestRunner,
          fallbackFullSuiteCommand: baseTestCommand,
          repoRoot: input.repoRoot,
          packagePrefix: input.packagePrefix,
          resolvedTestPatterns: input.resolvedTestPatterns,
        });
      } catch (err) {
        // Same observable outcome as when this threw per-mutant inside the
        // loop — every selected mutant counts as errored — except now nothing
        // was written to the worktree to get there.
        outcomes.errored += selected.length;
        logger.warn("mutation-check", "Scoped test selection failed — skipping mutation spot-check", {
          storyId: input.storyId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    let revertFailed = false;
    // `scoped === undefined` means selection failed above; the outcome is
    // already recorded and nothing may be written to the worktree.
    if (scoped !== undefined) {
      for (const mutant of selected) {
        let outcome: MutantOutcome | undefined;
        try {
          // Journal BEFORE mutating: a crash in between must leave a record
          // that names a mutation, never a mutation with no record.
          await recordInFlight(journalRoot, { ...mutant, storyId: input.storyId });
          await applyMutant(mutant);
          try {
            const result = await deps.regression({
              workdir: input.workdir,
              command: scoped.effectiveCommand,
              timeoutSeconds: cfg.timeoutSeconds,
            });
            outcome = classifyMutant(result);
            outcomes[outcome] += 1;
            if (outcome === "survived") {
              survivors.push({ ...mutant, outcome: "survived" });
            }
          } finally {
            const reverted = await revertMutant(mutant);
            if (reverted.reverted) {
              await clearInFlight(journalRoot, input.storyId);
            } else {
              // The line no longer holds what we wrote, so restoring it would
              // overwrite content we cannot account for. Leave the file alone,
              // keep the journal for the next run, and stop mutating: whatever
              // moved the file will keep moving it.
              revertFailed = true;
              // Block auto-commit for this working tree. The check itself stays
              // advisory — the story is not failed — but the tree now holds a
              // line this op did not author, and `autoCommitIfDirty` would
              // otherwise sweep it into a commit (and, under autoPR, a push).
              //
              // Register the working-tree ROOT (`journalRoot`, already resolved
              // via `getGitRoot`), not `input.workdir`. Consumers compare roots
              // for equality: in parallel mode a story's worktree is a LINKED
              // tree at `<repo>/.nax-wt/<storyId>`, so a path-containment test
              // against the main repo would block the run-summary commit for
              // every story whose worktree was dirty.
              ctx.runtime?.dirtyWorktrees?.add(journalRoot);
              logger.error("mutation-check", "Could not confirm revert — worktree may still hold a mutation", {
                storyId: input.storyId,
                file: mutant.file,
                line: mutant.line,
                operatorId: mutant.operatorId,
                reason: reverted.reason,
                expected: mutant.after,
                actual: reverted.actual,
              });
            }
          }
        } catch (err) {
          // Fail-open: any error mutating/testing/reverting a single mutant is
          // never a gate failure — log and move on to the next mutant. A mutant
          // whose outcome was already recorded (e.g. revert failed after a
          // successful verification) is not re-counted as errored.
          if (outcome === undefined) {
            outcomes.errored += 1;
          }
          logger.warn("mutation-check", "Error processing mutant — skipping", {
            storyId: input.storyId,
            file: mutant.file,
            line: mutant.line,
            operatorId: mutant.operatorId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        // An unconfirmed revert means the worktree is in a state this op did
        // not author. Applying more mutations on top would compound it.
        if (revertFailed) break;
      }
    }

    for (const s of survivors) {
      logger.warn("mutation-check", "Test suite did not catch injected mutation", {
        storyId: input.storyId,
        file: s.file,
        line: s.line,
        operatorId: s.operatorId,
      });
    }

    const candidates = mutants.length;
    // Omitted entirely on the clean path so a summary keeps its existing shape.
    const dirty = revertFailed ? ({ revertFailed: true } as const) : {};
    record({ survivors, outcomes, candidates, checked: true, ...dirty });
    return { success: true as const, survivors, outcomes, candidates, checked: true, ...dirty };
  },
};
