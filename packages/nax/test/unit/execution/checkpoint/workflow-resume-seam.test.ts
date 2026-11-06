/**
 * execution/checkpoint — the workflow resume seam, after the orchestrator core left.
 *
 * Everything else the checkpoint barrel exported (the record types, the resume-plan
 * builder and the resume-hydrate helpers) went with the orchestrator core, and so did
 * its suites. Two properties of what remains still need a guard, because both barrels
 * now re-export one module-global that `run()` mutates for the duration of a run:
 *
 *   - AC-1: `@/execution` and `@/execution/checkpoint` must hand out the SAME object.
 *     A clone would leave `buildStoryEnv` in `@/workflow` reading a mode no `run()`
 *     ever wrote — the exact bug the seam exists to prevent.
 *   - AC-2: it defaults to `"auto"` when no run is in flight, so a `buildStoryEnv`
 *     call outside `run()` (tests, `nax workflow`) still resumes.
 *
 * The seam is module-global, so every test restores `mode` afterwards.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { _workflowResumeDeps as fromExecutionBarrel, type ResumeMode } from "@/execution";
import * as checkpointBarrel from "@/execution/checkpoint";
import { _workflowResumeDeps as fromCheckpointBarrel } from "@/execution/checkpoint";

/**
 * The mode observed when this module was evaluated, i.e. with no `run()` in flight.
 * Read at import time on purpose: `run()` mutates the same object for its duration, so
 * a value read inside a test only reflects the default when nothing else has touched it.
 */
const MODE_AT_IMPORT: ResumeMode = fromExecutionBarrel.mode;

let origMode: ResumeMode;

beforeEach(() => {
  origMode = fromCheckpointBarrel.mode;
});

afterEach(() => {
  fromExecutionBarrel.mode = origMode;
});

/**
 * Read the seam through each barrel. Wrapped in functions on purpose: a direct
 * `expect(barrel._workflowResumeDeps.mode).toBe("fresh")` narrows that property
 * access to the literal, so the second, different-literal assertion in the same
 * test would not typecheck.
 */
function readExecutionMode(): ResumeMode {
  return fromExecutionBarrel.mode;
}

function readCheckpointMode(): ResumeMode {
  return fromCheckpointBarrel.mode;
}

describe("_workflowResumeDeps — one object behind both barrels (AC-1)", () => {
  test("AC-1: @/execution and @/execution/checkpoint import the same object", () => {
    expect(fromExecutionBarrel).toBe(fromCheckpointBarrel);
    expect(checkpointBarrel._workflowResumeDeps).toBe(fromExecutionBarrel);
  });

  test("a mode written through one barrel is visible through the other", () => {
    fromExecutionBarrel.mode = "fresh";
    expect(readCheckpointMode()).toBe("fresh");

    fromCheckpointBarrel.mode = "no-resume";
    expect(readExecutionMode()).toBe("no-resume");
  });
});

describe("_workflowResumeDeps — default resume mode (AC-2)", () => {
  test("AC-2: the mode is 'auto' when no run is in flight", () => {
    expect(MODE_AT_IMPORT).toBe("auto");
    // Both barrels report the same default, since they are one object.
    expect(fromCheckpointBarrel.mode).toBe("auto");
  });
});

describe("@/execution/checkpoint — export surface", () => {
  test("the barrel exposes only the workflow resume seam", () => {
    // Everything else the barrel used to re-export (buildResumePlan, captureTreeState,
    // hydrateFromResumePlan, buildCheckpointLogData and the checkpoint record types) went
    // with the orchestrator core. `ResumeMode` is a type, so it has no runtime footprint.
    expect(Object.keys(checkpointBarrel).sort()).toEqual(["_workflowResumeDeps"]);
  });
});
