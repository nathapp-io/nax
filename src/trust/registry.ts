/**
 * The process-scoped trust registry (US-002).
 *
 * The gate decides whether repository-controlled code may run (US-002), and
 * every execution site re-checks that decision here, immediately before it
 * imports or spawns (`assertTrusted`). Keeping the decision in a module-scoped
 * registry rather than a value threaded through the runtime means a site that
 * is reached without a gate sees an *untrusted* process rather than a missing
 * argument -- the failure mode is a refusal, not a bypass (design §5.2).
 *
 * `markTrusted` is called by `ensureProjectTrusted` alone. The registry is
 * append-only for the life of the process: nothing revokes a root mid-run, so
 * a site can never observe trust appearing and disappearing around it.
 */

import { NaxError } from "@/errors";
import { covers, normalizeTrustPath } from "./match";
import type { TrustSurface } from "./types";

/** Roots decided trusted in this process, normalized by `normalizeTrustPath`. */
const trustedRoots = new Set<string>();

/**
 * Record `normalizedRoot` as trusted for the rest of this process.
 *
 * The caller normalizes (`ensureProjectTrusted` and the test preload both do);
 * storing the raw spelling would let `/a/b/` and `/a/b` mark two different
 * roots, and a symlinked spelling would mark a root no site ever asks about.
 */
export function markTrusted(normalizedRoot: string): void {
  trustedRoots.add(normalizedRoot);
}

/**
 * Refuse unless a marked root covers `path`.
 *
 * `path` is the directory of the import or spawn about to happen, so a site
 * reached without its entry gate throws `PROJECT_UNTRUSTED` naming `surface`
 * instead of running repository code.
 */
export async function assertTrusted(path: string, surface: TrustSurface): Promise<void> {
  const normalized = await normalizeTrustPath(path);
  for (const root of trustedRoots) {
    if (covers(root, normalized)) return;
  }
  throw new NaxError(`[trust] refusing to run ${surface} in an untrusted project: ${normalized}`, "PROJECT_UNTRUSTED", {
    stage: "trust",
    root: normalized,
    surface,
    hint: `run: nax trust add ${normalized}`,
  });
}

/** Forget every marked root. Test isolation only -- production never resets. */
export function resetTrustRegistry(): void {
  trustedRoots.clear();
}
