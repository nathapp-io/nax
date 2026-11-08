/**
 * AC9: `PrecheckConfig` defines the keys the model-resolution check walks.
 *
 * US-1984 widened the precheck slice with `models`, `plan`, `acceptance`,
 * `autoMode`, `tdd`, and `routing`. US-001 deleted the precheck config selector
 * (nothing outside the barrel imported it), so the slice is now a
 * `Pick<NaxConfig, ...>` alias in `src/config/selectors.ts` and the contract is
 * pinned at the type level: `bun run typecheck` compiles `tsconfig.test.json`,
 * so dropping one of these keys from the alias fails the typecheck gate.
 */

import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "@/config";
import type { PrecheckConfig } from "@/config/selectors";

// Compile-time guard — the project-standard shape (see
// test/unit/config/schemas-review.test.ts): it fails to typecheck when the
// asserted property is false.
type AssertTrue<T extends true> = T;

/** The six keys US-1984 added so the model-resolution check can walk them. */
const MODEL_RESOLUTION_KEYS = ["models", "plan", "acceptance", "autoMode", "tdd", "routing"] as const;

type PrecheckConfigCoversModelResolutionKeys = AssertTrue<
  (typeof MODEL_RESOLUTION_KEYS)[number] extends keyof PrecheckConfig ? true : false
>;
const precheckConfigCoversModelResolutionKeys: PrecheckConfigCoversModelResolutionKeys = true;

describe("PrecheckConfig (US-1984 AC9)", () => {
  test("AC9: the slice type defines models, plan, acceptance, autoMode, tdd, and routing", () => {
    // Compiling the line above IS the assertion: the alias is `AssertTrue<…>`,
    // so a dropped key makes this a TS2344 typecheck failure.
    expect(precheckConfigCoversModelResolutionKeys).toBe(true);

    // The runtime half proves the pinned names are real NaxConfig sections, so
    // the pin cannot be satisfied by a typo that exists only in the alias.
    const slice: PrecheckConfig = DEFAULT_CONFIG;
    for (const key of MODEL_RESOLUTION_KEYS) {
      expect(slice[key]).toBeDefined();
    }
  });
});
