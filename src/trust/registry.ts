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
import { covers, normalizeTrustPath, normalizeTrustPathSync } from "./match";
import type { TrustSurface } from "./types";

/** Roots decided trusted in this process, normalized by `normalizeTrustPath`. */
const trustedRoots = new Set<string>();

/**
 * Record `root` as trusted for the rest of this process.
 *
 * Normalized HERE, with the same definition `assertTrusted` queries by, rather
 * than trusted to the caller: a raw spelling would let `/a/b/` and `/a/b` mark
 * two different roots, and a symlinked spelling (`/var/...` on macOS) would
 * mark a root no site's normalized query ever covers. Callers that
 * pre-normalize (`ensureProjectTrusted`, the test preload) are unaffected --
 * normalization is idempotent.
 */
export function markTrusted(root: string): void {
  trustedRoots.add(normalizeTrustPathSync(root));
}

/**
 * Refuse unless a marked root covers `path`.
 *
 * `path` is the directory of the import or spawn about to happen, so a site
 * reached without its entry gate throws `PROJECT_UNTRUSTED` naming `surface`
 * instead of running repository code.
 */
export async function assertTrusted(path: string, surface: TrustSurface): Promise<void> {
  refuseUnlessTrusted(await normalizeTrustPath(path), surface);
}

/**
 * The synchronous form of {@link assertTrusted}: same normalization, same
 * coverage rule, same refusal, but with no microtask boundary between the
 * check and the code that follows it. For spawn sites whose flow depends on
 * staying synchronous — the worktree provisioner arms its kill timer inside
 * `runArgv` before its first await, and the BUG-13 test drives that timer off
 * a virtual clock swept on a fixed microtask schedule; one `await` in between
 * and the check would land after the sweep.
 */
export function assertTrustedSync(path: string, surface: TrustSurface): void {
  refuseUnlessTrusted(normalizeTrustPathSync(path), surface);
}

/** Shared refusal body of `assertTrusted` / `assertTrustedSync`. */
function refuseUnlessTrusted(normalized: string, surface: TrustSurface): void {
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
