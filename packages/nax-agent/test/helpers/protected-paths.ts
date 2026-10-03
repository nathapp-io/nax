// Values copied from nax's src/agents/nax-protected-paths.ts + src/utils/nax-owned-paths.ts (S2-3c):
// the nax-owned constants themselves stay in nax; ports exercise the same engine with these entries.
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProtectedPathsPolicy } from "@nathapp/nax-agent";

/** nax's git exclude pathspecs (NAX_OWNED_GIT_EXCLUDE_PATHSPECS), verbatim. */
export const TEST_GIT_EXCLUDE_PATHSPECS: readonly string[] = [":(exclude).nax", ":(glob,exclude)**/.nax/**"];

/** The NAX_GITIGNORE_ENTRIES subset the ported tests' paths rely on (nax's list is longer; these are the entries its tests exercise). */
export const TEST_GITIGNORE_PATTERNS: readonly string[] = ["**/.nax/scratchpad/", ".nax-wt/", ".nax/metrics.json"];

/** A host policy fixture: same shape an embedder supplies. Override per test; defaults are inert paths under tmpdir(). */
export function testProtectedPaths(overrides: Partial<ProtectedPathsPolicy> = {}): ProtectedPathsPolicy {
  return {
    gitExcludePathspecs: TEST_GIT_EXCLUDE_PATHSPECS,
    gitIgnorePatterns: TEST_GITIGNORE_PATTERNS,
    projectStateDir: ".nax",
    credentialDir: join(tmpdir(), "nax-agent-test-credentials"),
    trustStoreFile: join(tmpdir(), "nax-agent-test-trust.json"),
    ...overrides,
  };
}
