/**
 * A `ContextOrchestrator` the tests can assert against.
 *
 * `ContextOrchestrator` is a class with a `private readonly providers` parameter
 * property, so a bare `{ assemble }` stub can never satisfy it structurally.
 * Five stage test files therefore cast their stubs into the dep slot — 7 casts
 * for one missing helper (#1514 §3c-ii, Decision 1).
 *
 * Same shape of fix as `makeDebateRunner` / `makeMergeEngine` / `makeLogger`:
 * intersect, and keep the one cast here.
 */
import { mock } from "bun:test";
import { ContextOrchestrator } from "@/context/engine/orchestrator";
import { makeContextBundle } from "./context-bundle";

export type MockContextOrchestrator = ContextOrchestrator & {
  assemble: ReturnType<typeof mock>;
  rebuildForAgent: ReturnType<typeof mock>;
};

/**
 * Both methods are bun mocks, so `toHaveBeenCalledWith` works on either.
 * Pass overrides to give a method real behaviour:
 *
 * ```ts
 * _contextStageDeps.createOrchestrator = mock(() =>
 *   makeContextOrchestrator({
 *     assemble: async (req) => { captured = req; return makeBundle(); },
 *   }),
 * );
 * ```
 *
 * The dep slot is `(story, config, ...) => ContextOrchestrator`; a zero-arg
 * `mock()` is assignable to it under function contravariance, so wrapping like
 * the example above needs no cast at the call site and keeps the factory itself
 * assertable.
 */
export function makeContextOrchestrator(
  overrides: Partial<Record<keyof ContextOrchestrator, unknown>> = {},
): MockContextOrchestrator {
  return Object.assign(
    new ContextOrchestrator([]),
    {
      assemble: mock(async () => makeContextBundle()),
      rebuildForAgent: mock(() => makeContextBundle()),
    },
    overrides,
  );
}
