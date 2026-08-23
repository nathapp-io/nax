/**
 * Narrow `OperationBase.config` to its selector form.
 *
 * `op.config` is declared `ConfigSelector<C> | readonly (keyof NaxConfig)[]`
 * (`src/operations/types.ts:102`) — a union covering both the named-selector and
 * the bare-key-array style. Every call that projects a config through it wants
 * the selector, so the union is a dead end at the call site: `view.select()`
 * takes `ConfigSelector<C>` and the array member is not assignable to it.
 *
 * Tests were closing that gap with `op.config as ConfigSelector<FooConfig>` —
 * a cast that also *restates* C, so a selector whose real slice drifts from the
 * declared one stops being a compile error. This narrows on the discriminant
 * instead: no cast, and C is inferred from the argument rather than asserted.
 *
 * Ops that genuinely use the key-array form are not supported — they have no
 * `select` to call, so there is nothing to narrow to. Throwing names that case
 * loudly rather than letting a cast pretend it cannot happen.
 *
 * @example
 * const view = runtime.packages.repo();
 * const config = view.select(opSelector(acceptanceDiagnoseOp.config));
 */

import type { ConfigSelector, NaxConfig } from "@/config";

export function opSelector<C>(config: ConfigSelector<C> | readonly (keyof NaxConfig)[]): ConfigSelector<C> {
  if (!("select" in config)) {
    throw new Error(
      "opSelector: op.config is the bare key-array form, which has no select(). " +
        "Use pickSelector(...) on the op, or project the keys directly.",
    );
  }
  return config;
}
