/**
 * ADR-022 — `recordIteration` helper.
 *
 * Couples two operations that were previously separable: appending the
 * iteration record onto the cycle state and emitting the structured log
 * record. These were decoupled, which is why three of the four cycle
 * append sites emitted no log. See .nax/features/iteration-record-helper/spec.md.
 */

import type { Logger } from "@/logger";
import type { FixApplied, FixCycle, Iteration, IterationOutcome } from "./cycle-types";
import type { Finding } from "./types";
import { findingKey } from "./types";

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
  const iteration: Iteration<F> = {
    iterationNum,
    findingsBefore: input.findingsBefore,
    fixesApplied: input.fixesApplied,
    findingsAfter: input.findingsAfter,
    outcome: input.outcome,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
  };
  cycle.iterations.push(iteration);

  const costUsd = input.fixesApplied.reduce((sum, fa) => sum + (fa.costUsd ?? 0), 0);
  const findingKeysBefore = input.findingsBefore.map(findingKey);
  const findingKeysAfter = input.findingsAfter.map(findingKey);
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
  logger?.info("findings.cycle", "iteration completed", {
    storyId: ctx.storyId,
    packageDir: ctx.packageDir,
    cycleName: ctx.cycleName,
    iterationNum,
    strategiesRan: input.fixesApplied.map((fa) => fa.strategyName),
    outcome: input.outcome,
    findingsBefore: input.findingsBefore.length,
    findingsAfter: input.findingsAfter.length,
    findingKeysBefore,
    findingKeysAfter,
    ...(input.fixesApplied.length > 0 ? { fixTargetFiles, fixSummaries } : {}),
    ...(costUsd > 0 ? { costUsd } : {}),
  });

  return iteration;
}
