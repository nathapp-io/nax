// tools/monorepo/lib/lock-resolutions.ts
const PACKAGE_ENTRY = /^\s{4}"[^"]+":\s*\["([^"]+)"/gm;

/**
 * Registry-resolved `name@version` resolutions from a bun.lock (text form), sorted.
 * Excludes `@workspace:` and `@file:` resolutions: both are repo-local, and a
 * `file:` resolution's path is layout-dependent — it changes when the referenced
 * directory moves with the package (spec §3.2 guards against registry drift only).
 */
export function externalResolutions(lockText: string): string[] {
  const start = lockText.indexOf('"packages"');
  if (start === -1) throw new Error("externalResolutions: no packages section");
  const found = [...lockText.slice(start).matchAll(PACKAGE_ENTRY)].map((m) => m[1] as string);
  return found.filter((r) => !r.includes("@workspace:") && !r.includes("@file:")).sort();
}

export function diffExternalResolutions(before: string[], after: string[]): { added: string[]; removed: string[] } {
  const b = new Set(before);
  const a = new Set(after);
  return { added: after.filter((x) => !b.has(x)).sort(), removed: before.filter((x) => !a.has(x)).sort() };
}
