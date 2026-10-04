/**
 * Read-deny for the host's credential directory and trust-store file in the
 * read tools (S3 spec 6.3). Before S3-2 only the sandbox enforced these, and
 * only for Bash; Read, Glob and Grep enforced root containment alone, so a
 * workdir containing the credential directory exposed it.
 *
 * Paths are compared in canonical form: `realpathSync.native` for a path that
 * exists returns the on-disk casing on a case-insensitive filesystem, where
 * `realOrRaw` (JS `realpathSync`) keeps the caller's casing and would let
 * `.NAX/credentials.json` past a `.nax` prefix check. A path that does not
 * exist cannot be read, so its lexical form is enough.
 */

import { realpathSync } from "node:fs";
import { sep } from "node:path";
import { realOrRaw } from "#src/internal/realpath";
import type { ProtectedPathsPolicy } from "./protected-paths.ts";

function canonical(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return realOrRaw(p);
  }
}

function isWithin(base: string, target: string): boolean {
  return target === base || target.startsWith(`${base}${sep}`);
}

function credentialRoots(protectedPaths: ProtectedPathsPolicy | undefined): string[] {
  if (protectedPaths === undefined) return [];
  return [protectedPaths.credentialDir, protectedPaths.trustStoreFile]
    .filter((p): p is string => p !== undefined)
    .map(canonical);
}

const CREDENTIAL_REFUSAL =
  "is a host credential or trust-store path, which the read tools are refused regardless of grant";

/**
 * A predicate over resolved paths, with the credential roots canonicalised
 * once: Glob tests every hit, and a native realpath per root per hit is waste.
 */
export function credentialPathTest(protectedPaths: ProtectedPathsPolicy | undefined): (resolved: string) => boolean {
  const roots = credentialRoots(protectedPaths);
  if (roots.length === 0) return () => false;
  return (resolved) => {
    const target = canonical(resolved);
    return roots.some((base) => isWithin(base, target));
  };
}

/** Why `resolved` may not be read, or undefined when it may. */
export function credentialReadRefusal(
  protectedPaths: ProtectedPathsPolicy | undefined,
  resolved: string,
): string | undefined {
  return credentialPathTest(protectedPaths)(resolved) ? CREDENTIAL_REFUSAL : undefined;
}

/** True when searching `dir` would reach the credential directory or the trust store. */
export function containsCredentialPath(protectedPaths: ProtectedPathsPolicy | undefined, dir: string): boolean {
  const base = canonical(dir);
  return credentialRoots(protectedPaths).some((cred) => isWithin(base, cred));
}
