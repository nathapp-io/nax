/**
 * Stage-facing AC coverage check.
 *
 * The implementation lives in `src/acceptance/coverage.ts` (the acceptance
 * module owns the AC counting and the warn payload). This module is the
 * pipeline-stage entry point: the post-run acceptance stage and the
 * acceptance-setup stage reach `checkAcceptanceCoverage` through it, keeping
 * stage imports anchored under `src/pipeline/stages/` rather than reaching
 * across into the acceptance barrel for one helper.
 *
 * The check is advisory: it never throws and never changes a stage result, an
 * acceptance verdict, a story status or the RED count. It warns on the run log
 * and returns the entry the caller stamps into `acceptance-meta.json`'s
 * `coverage` field.
 */

export type { AcceptanceCoverageEntry } from "@/acceptance";
export {
  checkAcceptanceCoverage,
  findMissingAcceptanceTestPaths,
  makeAcceptanceCoverageCollector,
  warnMissingAcceptanceTests,
} from "@/acceptance";
