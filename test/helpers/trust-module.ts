/**
 * Loader for the `src/trust` barrel (US-001).
 *
 * `src/trust` does not exist until the implementation lands, and a static
 * `import { findCoveringEntry } from "@/trust"` in a test file is a LINK error:
 * the whole file fails to load and every test in it reports a module-resolution
 * error rather than the behaviour that is missing.
 *
 * Loading the barrel lazily keeps the RED state honest. Before the module
 * exists, `loadTrustModule()` answers an empty stub, so each test fails at its
 * own first assertion -- `trustFn` names the export it could not find -- and
 * the failure says which behaviour is absent. Afterwards the loader is a plain
 * re-export of the barrel and the tests exercise the real thing.
 *
 * The existence probe is deliberate rather than a `try/catch` around the
 * import: a `src/trust` that exists but fails to load (a syntax error, a broken
 * transitive import) must surface that error, not be mistaken for "not written
 * yet" and reported as a missing function.
 */

import { expect } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

const TRUST_BARREL = join(import.meta.dir, "..", "..", "src", "trust", "index.ts");

/** The public surface of `src/trust`. */
export type TrustModule = typeof import("@/trust");

/**
 * The `src/trust` barrel, or an empty stub while it does not exist yet.
 *
 * Call once per test file and thread the result through {@link trustFn}.
 */
export async function loadTrustModule(): Promise<Partial<TrustModule>> {
  if (!existsSync(TRUST_BARREL)) return {};
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
  return value as TrustModule[K];
}
