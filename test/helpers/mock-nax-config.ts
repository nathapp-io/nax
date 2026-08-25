import type { NaxConfig } from "@/config";
import { DEFAULT_CONFIG } from "@/config";
import type { StorySizeGateConfig } from "@/config/runtime-types";
import type { AdversarialReviewConfig, SemanticReviewConfig } from "@/review/types";

/**
 * `NonNullable` before the `extends object` test: for an OPTIONAL nested config
 * (`debate?: DebateConfig`), `T[K]` is `DebateConfig | undefined`, and a union
 * with `undefined` does not extend `object` — so the old form fell through to
 * `: T[K]` and demanded the FULL `DebateConfig` for a one-field override.
 * See #1514 §Patterns learned item 2.
 */
export type DeepPartial<T> = {
  [K in keyof T]?: NonNullable<T[K]> extends object ? DeepPartial<NonNullable<T[K]>> : T[K];
};

function isEmptyObject(val: unknown): boolean {
  return typeof val === "object" && val !== null && !Array.isArray(val) && Object.keys(val).length === 0;
}

/**
 * The public signature is the fully typed one; the implementation signature
 * below it is deliberately `unknown`-based. A generic body cannot narrow
 * `DeepPartial<T>` to `T` from `Array.isArray(base)` — TS does not relate a
 * generic's parameters that way — so every branch that returns the override
 * used to need an assertion. Overloading moves that boundary to the language's
 * own mechanism: callers still see `<T>(base: T, override: DeepPartial<T>): T`,
 * while the body works in `unknown` and needs no cast to return.
 */
function deepMerge<T>(base: T, override: DeepPartial<T>): T;
function deepMerge(base: unknown, override: unknown): unknown {
  if (override === undefined || override === null) return base;
  if (typeof base !== "object" || base === null) return override;
  // An array override replaces the base wholesale rather than merging elementwise.
  if (Array.isArray(base)) return override;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(override as Record<string, unknown>)) {
    const baseVal = (base as Record<string, unknown>)[k];
    out[k] =
      typeof baseVal === "object" &&
      baseVal !== null &&
      !Array.isArray(baseVal) &&
      typeof v === "object" &&
      v !== null &&
      !isEmptyObject(v)
        ? deepMerge(baseVal, v as DeepPartial<typeof baseVal>)
        : v;
  }
  return out;
}

export function makeNaxConfig(overrides: DeepPartial<NaxConfig> = {}): NaxConfig {
  return deepMerge(DEFAULT_CONFIG as NaxConfig, overrides);
}

export function makeSparseNaxConfig(partial: Partial<NaxConfig>): NaxConfig {
  return partial as NaxConfig;
}

/**
 * A single NaxConfig slice, total by construction.
 *
 * Tests that take a sliced config (`ReviewConfig`, `PlanConfig`, …) rather than
 * the whole `NaxConfig` were writing the slice out as a literal, which pins
 * every field the type requires. When a new required field lands in `src/`, the
 * literal does not fail loudly — it accumulates a typecheck error, and the test
 * keeps asserting against a shape that is no longer the type it claims. That is
 * 60+ of the errors #1514 phase 3 targets, `ReviewConfig` alone being 34.
 *
 * This layers the overrides onto `DEFAULT_CONFIG` through `makeNaxConfig`, so
 * the result is always complete and always current. Pass only the fields the
 * test actually cares about; a renamed or removed field becomes a compile error
 * at the call site instead of a silent drift.
 *
 * ```ts
 * const config = makeConfigSlice("review", { enabled: false, checks: [] });
 * // → a full ReviewConfig; pluginMode / parseRetryMaxAttempts / conflictDetection
 * //   come from DEFAULT_CONFIG rather than being missing.
 * ```
 */
export function makeConfigSlice<K extends keyof NaxConfig>(
  key: K,
  overrides: DeepPartial<NaxConfig[K]> = {},
): NaxConfig[K] {
  return deepMerge(makeNaxConfig()[key], overrides);
}

/**
 * `precheck` is optional on NaxConfig, so the generic slice helper cannot reach
 * through it without asserting. DEFAULT_CONFIG always supplies it; the throw
 * states that invariant instead of hiding it behind a non-null assertion.
 */
export function makeStorySizeGateConfig(overrides: DeepPartial<StorySizeGateConfig> = {}): StorySizeGateConfig {
  const slice = makeNaxConfig({ precheck: { storySizeGate: overrides } }).precheck?.storySizeGate;
  if (slice === undefined) throw new Error("DEFAULT_CONFIG.precheck.storySizeGate is missing");
  return slice;
}

/**
 * `review.adversarial` and `review.semantic` are optional on `ReviewConfig`
 * (both are populated unconditionally by `DEFAULT_CONFIG`, but the schema
 * leaves the field optional so a caller that disables the check entirely can
 * omit it), so the generic slice helper cannot reach through them without
 * asserting. The throw states that invariant instead of hiding it behind a
 * non-null assertion.
 */
export function makeAdversarialReviewConfig(
  overrides: DeepPartial<AdversarialReviewConfig> = {},
): AdversarialReviewConfig {
  const slice = makeNaxConfig({ review: { adversarial: overrides } }).review.adversarial;
  if (slice === undefined) throw new Error("DEFAULT_CONFIG.review.adversarial is missing");
  return slice;
}

export function makeSemanticReviewConfig(overrides: DeepPartial<SemanticReviewConfig> = {}): SemanticReviewConfig {
  const slice = makeNaxConfig({ review: { semantic: overrides } }).review.semantic;
  if (slice === undefined) throw new Error("DEFAULT_CONFIG.review.semantic is missing");
  return slice;
}
