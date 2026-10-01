/**
 * Loader for the `src/trust` barrel.
 *
 * US-001's test-writer wrote its tests while `src/trust` did not exist yet, so
 * this loader answered an empty stub (a static `import { x } from "@/trust"`
 * would have been a LINK error, failing the whole file) and `trustFn` named the
 * export that was missing instead. It promised to become "a plain re-export of
 * the barrel" once the module landed, and that is what it is now.
 *
 * The `Partial<TrustModule>` the stub needed is not: `test/unit/trust/gate.test.ts`
 * and `prompt.test.ts` call `markTrusted`, `assertTrusted`,
 * `ensureProjectTrusted`, `promptTrustChoice` and the two `_deps` objects
 * directly, and `test/` compiles at zero type errors (`bun run typecheck` is a
 * hard gate in CI (`check:all`)), so every one of those properties has to be
 * non-optional.
 */

import { expect } from "bun:test";
import { assertDefined } from "./assert-defined";

/** The public surface of `src/trust`. */
export type TrustModule = typeof import("@/trust");

/** The `src/trust` barrel. */
export async function loadTrustModule(): Promise<TrustModule> {
  return import("@/trust");
}

/**
 * Fetch an exported function from a {@link loadTrustModule} result, failing the
 * test on the spot when it is absent.
 *
 * The `expect(typeof ...)` check is what makes the pre-implementation failure an
 * assertion failure that names the missing export, instead of the `TypeError`
 * that calling `undefined(...)` would raise further down the test.
 */
export function trustFn<K extends keyof TrustModule>(mod: Partial<TrustModule>, name: K): TrustModule[K] {
  const value = mod[name];
  expect(typeof value).toBe("function");
  // Narrows the optional indexed access for the type checker; `expect` does not
  // narrow, and the cast this replaces is counted by `check:test-escape-hatches`.
  // The `expect` above still throws first for a missing export, so a failure
  // is reported the same way it was before this line existed.
  assertDefined(value, `src/trust does not export "${String(name)}"`);
  return value;
}
