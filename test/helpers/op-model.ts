/**
 * Narrow `OperationBase.model` to its resolver-function form.
 *
 * `op.model` is declared `OperationModel<I, C>` — that is
 * `ConfiguredModel | ((input: I, ctx: BuildContext<C>) => ConfiguredModel | undefined)`
 * (`src/operations/types.ts:298`) — a union covering both the literal-model and
 * the computed-resolver style. Tests that exercise the resolver were writing
 * `op.model?.(input, ctx)`, which does not compile: the literal member of the
 * union is not callable, so tsc rejects the whole expression with TS2349.
 *
 * The union is a dead end at the call site in exactly the way `op.config` is
 * (see `opSelector` in ./config-selector), and the fix is the same shape:
 * narrow on the discriminant — `typeof === "function"` — rather than assert.
 * No cast, and `I`/`C` are inferred from the argument instead of restated, so a
 * resolver whose input type drifts stays a compile error.
 *
 * Ops that declare a literal model have no resolver to call, so there is
 * nothing to narrow to. Throwing names that case loudly rather than letting a
 * cast pretend it cannot happen.
 *
 * @example
 * expect(opModelResolver(groundOp)(input, makeBuildCtx())).toBe("fast");
 */

import type { ConfiguredModel } from "@/config";
import type { BuildContext, OperationModel } from "@/operations/types";

export function opModelResolver<I, C>(op: {
  readonly name?: string;
  readonly model?: OperationModel<I, C>;
}): (input: I, ctx: BuildContext<C>) => ConfiguredModel | undefined {
  const { model } = op;
  if (typeof model !== "function") {
    throw new Error(
      `opModelResolver: op ${op.name ?? "<unnamed>"} declares a literal model (or none), not a resolver function, so there is nothing to call. Assert on op.model directly.`,
    );
  }
  return model;
}
