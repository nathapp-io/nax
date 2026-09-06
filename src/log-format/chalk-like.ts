/**
 * Minimal chalk-shaped colour interface, plus the no-op implementation used
 * when colour is disabled.
 *
 * Its own leaf module because both the per-entry formatter and the run-summary
 * formatter need it, and neither should import the other: `src/config/loader.ts`
 * depends on `src/logger`, which depends on this layer, so every module here is
 * kept dependency-free (see scripts/check-log-format-layering.ts).
 */

export interface ChalkLike {
  bold: (s: string) => string;
  dim: (s: string) => string;
  gray: (s: string) => string;
  red: (s: string) => string;
  green: (s: string) => string;
  yellow: (s: string) => string;
  blue: (s: string) => string;
  magenta: (s: string) => string;
  cyan: (s: string) => string;
}

/** Create a no-op chalk instance (returns strings unchanged). */
export function createNoopChalk(): ChalkLike {
  const noop = (s: string) => s;
  return {
    bold: noop,
    dim: noop,
    gray: noop,
    red: noop,
    green: noop,
    yellow: noop,
    blue: noop,
    magenta: noop,
    cyan: noop,
  };
}
