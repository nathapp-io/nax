/**
 * A `StatusWriter` the tests can assert against.
 *
 * `StatusWriter` is a class with ~10 methods and private state, so the
 * six-method stub the completion tests need can never satisfy it structurally.
 * Eleven files each grew their own `makeStatusWriter()` and then cast it into
 * `RunCompletionOptions["statusWriter"]` / `RunnerCompletionOptions[…]` — 17
 * casts for one missing helper (#1514 phase 1b).
 *
 * Same shape of fix as `makeLogger`: intersect, and keep the one cast here.
 */
import { mock } from "bun:test";
import { StatusWriter } from "@/execution/status-writer";
import { makeNaxConfig } from "./mock-nax-config";

export type MockStatusWriter = StatusWriter & {
  setPrd: ReturnType<typeof mock>;
  setCurrentStory: ReturnType<typeof mock>;
  setRunStatus: ReturnType<typeof mock>;
  setReviewSummary: ReturnType<typeof mock>;
  setPostRunPhase: ReturnType<typeof mock>;
  resetPostRunStatus: ReturnType<typeof mock>;
  update: ReturnType<typeof mock>;
  writeFeatureStatus: ReturnType<typeof mock>;
};

/**
 * Every method is a bun mock, so `toHaveBeenCalledWith` works on all of them.
 * Pass overrides to give a method real behaviour (e.g. a `getSnapshot` that
 * returns a fixture).
 */
export function makeStatusWriter(overrides: Partial<Record<keyof StatusWriter, unknown>> = {}): MockStatusWriter {
  return Object.assign(
    new StatusWriter("/tmp/nax-test-status.json", makeNaxConfig(), {
      runId: "run-test",
      feature: "test-feature",
      startedAt: "2026-01-01T00:00:00.000Z",
      dryRun: false,
      startTimeMs: 0,
      pid: 0,
    }),
    {
      setPrd: mock(() => {}),
      setCurrentStory: mock(() => {}),
      setRunStatus: mock(() => {}),
      setReviewSummary: mock(() => {}),
      setPostRunPhase: mock((_phase: string, _update: Record<string, unknown>) => {}),
      resetPostRunStatus: mock(() => {}),
      getPostRunStatus: mock(() => ({})),
      getSnapshot: mock(() => null),
      update: mock(async () => {}),
      writeFeatureStatus: mock(async () => {}),
    },
    overrides,
  );
}
