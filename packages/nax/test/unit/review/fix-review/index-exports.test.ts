/**
 * US-002 — public API surface of `src/review/fix-review/index.ts`.
 *
 * The barrel re-exports every symbol the US-003/US-004/US-005 fix-review
 * consumers reach for. The scope of this test is purely the export surface —
 * the behaviour is exercised in `scope.test.ts`, `tree-snapshot.test.ts`, and
 * `config.test.ts`. The aliases here match the same names the leaf modules
 * (`./scope`, `./tree-snapshot`) declare, so a typo would surface as a
 * compile error rather than a silent runtime miss.
 *
 * Background: the alias-internals gate (`scripts/check-alias-internals.ts`)
 * forbids `src/` value imports that deep-import past a barrel. US-003/US-004
 * consumers must therefore reach these helpers through `@/review/fix-review`,
 * not through `@/review/fix-review/scope` or `@/review/fix-review/tree-snapshot`.
 * This test pins the contract: a future change that drops a re-export from
 * the barrel will be caught here before the gate flags the would-be consumer.
 *
 * Implementation: each value-level re-export goes through a per-symbol
 * dynamic `import("@/review/fix-review")` so a missing alias surfaces as its
 * own named test failure rather than an opaque module-load explosion that
 * takes the whole file down. The type-level surface (FixScopeInput,
 * FixScopeResult, FixReviewVerdict, FixReviewOpOutput, FixReviewRequest) is
 * enforced at typecheck time once the barrel adds matching `export type`
 * lines — the static import in `src/review/fix-review/index.ts`'s consumer
 * (US-003 / US-004) will fail to compile until the re-exports exist. That
 * consumer-side import isn't reproduced here because pinning it from a test
 * would force this RED test to fail typecheck before the barrel fix lands.
 */

import { describe, expect, test } from "bun:test";

/** Returned shape — every barrel export, whether present today or added later, becomes a `name → value` slot. */
type BarrelSurface = Readonly<Record<string, unknown>>;

/** Read the barrel as a record of `name → value`; missing exports stay `undefined`. */
async function barrelKeys(): Promise<BarrelSurface> {
  // The barrel is type-erased for this lookup on purpose: a static
  // `import { ... } from "@/review/fix-review"` would force the barrel
  // surface to already exist before this test could even be staged, a
  // chicken-and-egg that would block the RED phase. The dynamic import
  // resolves whatever the barrel does export today — exactly what the
  // value-level checks below assert.
  return import("@/review/fix-review");
}

describe("src/review/fix-review/index.ts — US-002 public API surface", () => {
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

  test("re-exports the unified diff helper from the barrel", async () => {
    const barrel = await barrelKeys();
    expect("diffBetween" in barrel).toBe(true);
    expect(typeof barrel.diffBetween).toBe("function");
  });

  test("re-exports the deterministic scope check from the barrel", async () => {
    const barrel = await barrelKeys();
    expect("checkFixScope" in barrel).toBe(true);
    expect(typeof barrel.checkFixScope).toBe("function");
  });

  test("keeps the US-001 model-resolution helper it already exported", async () => {
    // Pinning the existing export so a barrel rewrite that drops the US-001
    // surface cannot silently regress the older consumer's import.
    const barrel = await barrelKeys();
    expect("resolveFixReviewModel" in barrel).toBe(true);
    expect(typeof barrel.resolveFixReviewModel).toBe("function");
  });
});
