/**
 * Shared "are these two remotes the same project?" predicate.
 *
 * Used by claimProjectIdentity (src/runtime/paths.ts) and checkInitCollision
 * (src/cli/init.ts) so both ends agree on what "same project" means. The
 * predicate normalizes both sides before comparing — see normalize() below
 * for the exact rules.
 */

/**
 * Decide whether two remote strings refer to the same project.
 *
 * Returns false when either argument is null. Otherwise normalizes both
 * sides (lowercase, strip scheme, credentials, port, .git suffix, trailing
 * slash; convert scp-style host:path to host/path) and compares the
 * resulting "host/path". Host is significant — forks on different hosts
 * remain different projects.
 */
export function isSameProject(remoteA: string | null, remoteB: string | null): boolean {
  if (remoteA === null || remoteB === null) return false;
  return normalize(remoteA) === normalize(remoteB);
}

/**
 * Normalize a remote string for project-equality comparison.
 *
 *   1. lowercase
 *   2. strip scheme (e.g. https://, git://, ssh://)
 *   3. strip credentials (user:pass@, user@)
 *   4. strip any port (:1234 after host)
 *   5. convert scp-style "host:path" to "host/path"
 *   6. strip one trailing ".git"
 *   7. strip trailing slash
 *
 * The returned form is "host/path" — host is significant, forks on different
 * hosts remain different projects.
 */
function normalize(remote: string): string {
  let s = remote.toLowerCase();

  // 2. Strip scheme
  s = s.replace(/^(https?|ssh|git|file):\/\//, "");

  // 3. Strip credentials (user:pass@ or user@)
  s = s.replace(/^[^/@]+@/, "");

  // 4. Strip port (after host, before path's first slash or end-of-string)
  //    Match "host:NNNN" where host has no slash yet.
  s = s.replace(/^([^/:]+):\d+/, "$1");

  // 5. Convert scp-style "host:path" to "host/path".
  //    After steps 1–4, the only remaining top-level ":" belongs to scp-style
  //    remotes (an https-with-port remote would already have had its port
  //    stripped). Convert the first top-level ":" to "/".
  const colon = s.indexOf(":");
  if (colon !== -1) {
    s = `${s.slice(0, colon)}/${s.slice(colon + 1)}`;
  }

  // 6. Strip one trailing ".git"
  if (s.endsWith(".git")) {
    s = s.slice(0, -4);
  }

  // 7. Strip trailing slash
  if (s.endsWith("/")) {
    s = s.slice(0, -1);
  }

  return s;
}
