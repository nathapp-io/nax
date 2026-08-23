/**
 * An `InteractionChain` the tests can assert against.
 *
 * `InteractionChain` is a class with two `private` fields, so a bare
 * `{ prompt, applyFallback }` stub can never satisfy it structurally. Three
 * test files cast their stubs into the type — 3 casts for one missing helper
 * (#1514 §3c-ii, Decision 1).
 *
 * Same shape of fix as `makeDebateRunner` / `makeMergeEngine` / `makeLogger`:
 * intersect, and keep the one cast here.
 */
import { mock } from "bun:test";
import type { InteractionChain } from "@/interaction/chain";

export type MockInteractionChain = InteractionChain & {
  prompt: ReturnType<typeof mock>;
  applyFallback: ReturnType<typeof mock>;
};

/**
 * Both methods are bun mocks, so `toHaveBeenCalledWith` works on either.
 * Pass overrides to give a method real behaviour:
 *
 * ```ts
 * const chain = makeInteractionChain({
 *   prompt: mock(async () => ({ id: "ix-1", action: "resume", createdAt: Date.now() })),
 * });
 * ```
 *
 * `MockInteractionChain` intersects the class, so the result needs no cast at
 * the call site.
 */
export function makeInteractionChain(
  overrides: Partial<Record<keyof InteractionChain, unknown>> = {},
): MockInteractionChain {
  const chain = {
    prompt: mock(async () => ({ id: "ix-1", action: "approve", createdAt: Date.now() })),
    applyFallback: mock((_response: unknown, _fallback: string) => "approve"),
    ...overrides,
  };
  return chain as unknown as MockInteractionChain;
}
