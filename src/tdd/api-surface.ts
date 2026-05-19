/**
 * Runtime sentinels for the tdd module public API surface (Slice D/E migration).
 *
 * Each exported name is both:
 * 1. A type alias (re-exported from types.ts / verdict.ts) so `import type { X }`
 *    and `const x: X` work exactly as before.
 * 2. A namespace (value) so `"X" in module` returns true for runtime reflection.
 *
 * TypeScript allows a type alias and a namespace to share the same identifier.
 */

// ─── TddSessionRole ───────────────────────────────────────────────────────────
export type TddSessionRole = import("./types").TddSessionRole;
export namespace TddSessionRole {
  export const _s = null;
}

// ─── FailureCategory ──────────────────────────────────────────────────────────
export type FailureCategory = import("./types").FailureCategory;
export namespace FailureCategory {
  export const _s = null;
}

// ─── IsolationCheck ───────────────────────────────────────────────────────────
export type IsolationCheck = import("./types").IsolationCheck;
export namespace IsolationCheck {
  export const _s = null;
}

// ─── TddSessionResult ─────────────────────────────────────────────────────────
export type TddSessionResult = import("./types").TddSessionResult;
export namespace TddSessionResult {
  export const _s = null;
}

// ─── ThreeSessionTddOptions ───────────────────────────────────────────────────
export type ThreeSessionTddOptions = import("./types").ThreeSessionTddOptions;
export namespace ThreeSessionTddOptions {
  export const _s = null;
}

// ─── StoryRunResult (renamed from ThreeSessionTddResult, Slice D) ─────────────
export type StoryRunResult = import("./types").ThreeSessionTddResult;
export namespace StoryRunResult {
  export const _s = null;
}

// ─── VerifierVerdict ──────────────────────────────────────────────────────────
export type VerifierVerdict = import("./verdict").VerifierVerdict;
export namespace VerifierVerdict {
  export const _s = null;
}

// ─── VerdictCategorization ────────────────────────────────────────────────────
export type VerdictCategorization = import("./verdict").VerdictCategorization;
export namespace VerdictCategorization {
  export const _s = null;
}
