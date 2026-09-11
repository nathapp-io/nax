/**
 * ADR-022 — `recordIteration` helper.
 *
 * Couples two operations that were previously separable: appending the
 * iteration record onto the cycle state and emitting the structured log
 * record. These were decoupled, which is why three of the four cycle
 * append sites emitted no log. See .nax/features/iteration-record-helper/spec.md.
 *
 * The stored iteration is widened with the same identity / fix-target fields
 * the log emits so callers that hold an `Iteration<F>` reference can answer
 * "same defect or different?" without re-deriving the keys. Only the emitted
 * log record's findingsBefore/findingsAfter are reduced to counts — the
 * stored `Iteration.findingsBefore`/`findingsAfter` keep the full arrays. See
 * .nax/features/fix-cycle-iteration-telemetry/spec.md (US-002).
 */

import type { Logger } from "@/logger";
import type { FixApplied, FixCycle, Iteration, IterationOutcome } from "./cycle-types";
import type { Finding } from "./types";
import { findingKey, findingRecurrenceKey } from "./types";

export interface RecordIterationInput<F extends Finding> {
  findingsBefore: F[];
  findingsAfter: F[];
  fixesApplied: FixApplied[];
  outcome: IterationOutcome;
  startedAt: string;
  finishedAt: string;
  /**
   * US-003 — the iteration's dispatch raised `CALL_OP_NO_DISPATCH`; carried onto
   * the stored iteration (and the log record) so `withNoProgressBail` can skip
   * it. See `Iteration.noDispatch`.
   */
  noDispatch?: true;
}

export interface RecordIterationContext {
  storyId?: string;
  packageDir?: string;
  cycleName: string;
}

export function recordIteration<F extends Finding>(
  cycle: FixCycle<F>,
  input: RecordIterationInput<F>,
  ctx: RecordIterationContext,
  logger: Logger | null | undefined,
): Iteration<F> {
  const iterationNum = cycle.iterations.length + 1;
  const findingsBeforeCount = input.findingsBefore.length;
  const findingsAfterCount = input.findingsAfter.length;
  const findingKeysBefore = input.findingsBefore.map(findingKey);
  const findingKeysAfter = input.findingsAfter.map(findingKey);
  const findingRecurrenceKeysBefore = input.findingsBefore.map(findingRecurrenceKey);
  const findingRecurrenceKeysAfter = input.findingsAfter.map(findingRecurrenceKey);
  const costUsd = input.fixesApplied.reduce((sum, fa) => sum + (fa.costUsd ?? 0), 0);
  const errorCostUsd = input.fixesApplied.reduce((sum, fa) => sum + (fa.errorCostUsd ?? 0), 0);
  const seenTargetFiles = new Set<string>();
  const fixTargetFiles: string[] = [];
  for (const fa of input.fixesApplied) {
    for (const path of fa.targetFiles) {
      if (seenTargetFiles.has(path)) continue;
      seenTargetFiles.add(path);
      fixTargetFiles.push(path);
    }
  }
  const fixSummaries = input.fixesApplied.map((fa) => fa.summary);
  const hasFixes = input.fixesApplied.length > 0;
  const iteration: Iteration<F> = {
    iterationNum,
    findingsBefore: input.findingsBefore,
    fixesApplied: input.fixesApplied,
    findingsAfter: input.findingsAfter,
    outcome: input.outcome,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    findingKeysBefore,
    findingKeysAfter,
    findingRecurrenceKeysBefore,
    findingRecurrenceKeysAfter,
    ...(hasFixes ? { fixTargetFiles, fixSummaries } : {}),
    ...(costUsd > 0 ? { costUsd } : {}),
    // #1948: omitted at zero on the same reasoning as `costUsd`, so its
    // presence in a record always means a dispatch actually failed.
    ...(errorCostUsd > 0 ? { errorCostUsd } : {}),
    // US-003: omitted rather than false, so `undefined` is the only "this
    // iteration did dispatch" value a reader has to consider.
    ...(input.noDispatch ? { noDispatch: true as const } : {}),
  };
  cycle.iterations.push(iteration);

  logger?.info("findings.cycle", "iteration completed", {
    storyId: ctx.storyId,
    packageDir: ctx.packageDir,
    cycleName: ctx.cycleName,
    iterationNum,
    strategiesRan: input.fixesApplied.map((fa) => fa.strategyName),
    outcome: input.outcome,
    findingsBefore: findingsBeforeCount,
    findingsAfter: findingsAfterCount,
    findingKeysBefore,
    findingKeysAfter,
    findingRecurrenceKeysBefore,
    findingRecurrenceKeysAfter,
    ...(hasFixes ? { fixTargetFiles, fixSummaries } : {}),
    ...(costUsd > 0 ? { costUsd } : {}),
    // #1948: omitted at zero on the same reasoning as `costUsd`, so its
    // presence in a record always means a dispatch actually failed.
    ...(errorCostUsd > 0 ? { errorCostUsd } : {}),
    // US-003: the log carries the marker too, so a reader can tell a
    // zero-dispatch iteration from an ordinary completed no-edit one.
    ...(input.noDispatch ? { noDispatch: true as const } : {}),
  });

  return iteration;
}
