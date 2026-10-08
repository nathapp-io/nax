/**
 * Acceptance override keys (review #10).
 *
 * Each package numbers its acceptance criteria AC-1..N independently (BUG-12),
 * so a bare `AC-2` names a different criterion in every package. Keys:
 *   - `<packageRel>::AC-N` waives AC-N in that package only (`.` = repo root).
 *   - `AC-N` is honoured only where it is unambiguous: a run with one test group,
 *     or a run where exactly one package defines an AC numbered N.
 * An ambiguous bare key is ignored (never applied to every package) and reported
 * once through `onIgnoredBareKey`, so the author can rewrite it scoped.
 */
import { relative } from "node:path";

export const OVERRIDE_SCOPE_SEPARATOR = "::";

const NUMBERED_AC = /^AC-(\d+)$/;

export function scopedOverrideKey(workdir: string, packageDir: string, acId: string): string {
  return `${relative(workdir, packageDir) || "."}${OVERRIDE_SCOPE_SEPARATOR}${acId}`;
}

export interface OverrideLookup {
  /** The override reason for `acId` failing in `packageDir`, or undefined when no override applies. */
  reasonFor(packageDir: string, acId: string): string | undefined;
}

export interface OverrideLookupOptions {
  readonly overrides: Readonly<Record<string, string>> | undefined;
  readonly workdir: string;
  /** In-scope acceptance-criteria count per absolute package dir (the stage's `acsByPackageDir`). */
  readonly acCountByPackageDir: ReadonlyMap<string, number>;
  /** True when the run executes more than one acceptance test group. */
  readonly multiPackage: boolean;
  readonly onIgnoredBareKey: (acId: string) => void;
}

/** How many packages define a criterion numbered like `acId` (0 for sentinels such as AC-HOOK). */
function definingPackageCount(acId: string, counts: ReadonlyMap<string, number>): number {
  const n = Number(NUMBERED_AC.exec(acId)?.[1] ?? 0);
  if (n < 1) return 0;
  return [...counts.values()].filter((count) => count >= n).length;
}

export function createOverrideLookup(opts: OverrideLookupOptions): OverrideLookup {
  const table = opts.overrides ?? {};
  const reported = new Set<string>();
  return {
    reasonFor(packageDir, acId) {
      const scoped = table[scopedOverrideKey(opts.workdir, packageDir, acId)];
      if (scoped !== undefined) return scoped;
      const bare = table[acId];
      if (bare === undefined || !opts.multiPackage) return bare;
      if (definingPackageCount(acId, opts.acCountByPackageDir) === 1) return bare;
      if (!reported.has(acId)) {
        reported.add(acId);
        opts.onIgnoredBareKey(acId);
      }
      return undefined;
    },
  };
}
