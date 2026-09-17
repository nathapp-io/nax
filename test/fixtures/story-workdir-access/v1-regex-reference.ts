/**
 * Frozen copy of the token-regex `findViolations` from
 * `scripts/check-story-workdir-access.ts` at `8cae0c3cd^` (the version before
 * nax#2084's rewrite). Test-only: the differential corpus in
 * `test/unit/scripts/check-story-workdir-access.test.ts` runs both this and
 * the current checker-based gate over the same fixture set and asserts the
 * current gate's catch-set is a SUPERSET of this one's -- the property that
 * would have caught the v2 -> v3 regression the review found (destructuring
 * assignment) and is meant to catch any future one.
 *
 * Trimmed to the pure-function surface (`findViolations`, `isStoryReceiver`):
 * the CLI-scanning half (`main`, `walk`, `ALLOWED`, `EXEMPT`) is not needed
 * for a differential comparison and would only be dead weight here.
 */

const READ = /([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\.workdir\b/g;

/** True when the receiver names a story rather than a context or an options bag. */
export function isStoryReceiver(receiver: string): boolean {
  const last = receiver.split(".").at(-1) ?? receiver;
  return last === "s" || /story$/i.test(last);
}

export interface V1Violation {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

/** Scan one file's source for raw reads, exactly as the frozen v1 gate did. */
export function findViolationsV1(file: string, source: string): V1Violation[] {
  const found: V1Violation[] = [];
  source.split("\n").forEach((text, index) => {
    const stripped = text.trim();
    if (stripped.startsWith("//") || stripped.startsWith("*") || stripped.startsWith("/*")) return;
    for (const match of stripped.matchAll(READ)) {
      const receiver = match[1] ?? "";
      if (isStoryReceiver(receiver)) found.push({ file, line: index + 1, text: stripped });
    }
  });
  return found;
}
