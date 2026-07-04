/**
 * Pure timeline reconstruction — composes phase inference with metrics/status
 * into a single `RunTimeline` value-object.
 *
 * No I/O; the caller loads JSONL/metrics/status.json and passes the data in.
 */

import type { ReplayInputs, RunTimeline } from "./types";

/**
 * Build a `RunTimeline` from parsed log entries + optional metrics and
 * status.json. Pure — does not touch the filesystem or read env vars.
 */
export function reconstructTimeline(inputs: ReplayInputs): RunTimeline {
  throw new Error("reconstructTimeline not implemented"); // nax-lint-allow: plain-error — stub; implementer replaces with real composition.
}
