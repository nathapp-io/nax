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
  });

  return iteration;
}
