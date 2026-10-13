/**
 * A scope inside which quality commands log their `Running <name>` / `<name> completed` records at
 * debug instead of info (nax#2491 P7). The workflow runs its gates inside it and says what happened in
 * ONE gates line, so the 2-per-gate pairs (30% of a workflow run log) stop drowning the narrative.
 *
 * AsyncLocalStorage, not a flag on every op: the gates reach `runQualityCommand` through several ops
 * (lint, typecheck, scoped tests, the full suite) and the finish quality gates, none of which should
 * have to know who is watching. The JSONL still gets the records (the file sink writes every level).
 */
import { AsyncLocalStorage } from "node:async_hooks";

const quiet = new AsyncLocalStorage<true>();

/** Runs `fn` with quality-command start/finish records demoted to debug. */
export function runQualityQuietly<T>(fn: () => Promise<T>): Promise<T> {
  return quiet.run(true, fn);
}

/** True inside {@link runQualityQuietly}. */
export function qualityLogsAreQuiet(): boolean {
  return quiet.getStore() === true;
}
