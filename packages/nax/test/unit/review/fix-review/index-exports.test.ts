/**
 * Public API surface of `src/review/fix-review/index.ts`.
 *
 * The barrel re-exports the two working-tree helpers the reviewer-guard
 * consumer reaches for (`src/review/reviewer-guard/deps.ts`). Since US-003
 * (pipeline-review-delete) those are the ONLY two symbols left: the verdict /
 * request types, `resolveFixReviewModel` and `checkFixScope` went with the
 * fix-review operation (US-001) and the scope check it drove. The exact
 * surface — not just "these two are present" — is pinned in
 * `test/integration/review/fix-review/tree-snapshot.test.ts` (AC-2), which
 * also exercises both functions through the barrel against real git.
 *
 * Background: the alias-internals gate (`scripts/check-alias-internals.ts`)
 * forbids `src/` value imports that deep-import past a barrel. Consumers must
 * therefore reach these helpers through `@/review/fix-review`, not through
 * `@/review/fix-review/tree-snapshot`. This test pins the contract: a future
 * change that drops a re-export from the barrel will be caught here before the
 * gate flags the would-be consumer.
 *
 * Implementation: each value-level re-export goes through a per-symbol
 * dynamic `import("@/review/fix-review")` so a missing alias surfaces as its
 * own named test failure rather than an opaque module-load explosion that
 * takes the whole file down.
 */

import { describe, expect, test } from "bun:test";

/** Returned shape — every barrel export, whether present today or added later, becomes a `name → value` slot. */
type BarrelSurface = Readonly<Record<string, unknown>>;

/** Read the barrel as a record of `name → value`; missing exports stay `undefined`. */
async function barrelKeys(): Promise<BarrelSurface> {
  // The barrel is read type-erased on purpose: a static
  // `import { ... } from "@/review/fix-review"` would force the barrel
  // surface to already exist before this test could even be staged, a
  // chicken-and-egg that would block the RED phase. The dynamic import
  // resolves whatever the barrel does export today — exactly what the
  // value-level checks below assert.
  return import("@/review/fix-review");
}

describe("src/review/fix-review/index.ts — retained public API surface", () => {
  test("re-exports the working-tree snapshot helper from the barrel", async () => {
    const barrel = await barrelKeys();
    expect("snapshotWorkingTree" in barrel).toBe(true);
    expect(typeof barrel.snapshotWorkingTree).toBe("function");
  });

  test("re-exports the changed-paths diff helper from the barrel", async () => {
    const barrel = await barrelKeys();
    expect("changedPathsBetween" in barrel).toBe(true);
    expect(typeof barrel.changedPathsBetween).toBe("function");
  });
});
