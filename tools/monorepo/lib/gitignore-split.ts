// tools/monorepo/lib/gitignore-split.ts
import { GITIGNORE_MOVE, MOVED_TOP_DIRS } from "./constants";

const PKG_HEADER = "# Moved from the repo root by the monorepo conversion (package-anchored)";

/** An entry is anchored when it has a slash before its last character (git rule). */
function anchoredFirstSegment(entry: string): string | undefined {
  const bare = entry.startsWith("!") ? entry.slice(1) : entry;
  const trimmed = bare.endsWith("/") ? bare.slice(0, -1) : bare;
  if (!trimmed.includes("/") || trimmed.startsWith("**/")) return undefined;
  return trimmed.replace(/^\//, "").split("/")[0];
}

export function splitGitignore(text: string): { root: string; pkg: string; moved: string[] } {
  const lines = text.replace(/\n$/, "").split("\n");
  const moved = lines.filter((l) => GITIGNORE_MOVE.includes(l.trim()));
  for (const line of lines) {
    const t = line.trim();
    if (t === "" || t.startsWith("#") || GITIGNORE_MOVE.includes(t)) continue;
    const seg = anchoredFirstSegment(t);
    if (seg !== undefined && MOVED_TOP_DIRS.has(seg)) {
      throw new Error(`splitGitignore: "${t}" is anchored under moved dir "${seg}" but not in GITIGNORE_MOVE`);
    }
  }
  const root = lines.filter((l) => !GITIGNORE_MOVE.includes(l.trim())).join("\n");
  const pkg = [PKG_HEADER, ...moved.map((l) => l.trim())].join("\n");
  return { root: `${root}\n`, pkg: `${pkg}\n`, moved: moved.map((l) => l.trim()) };
}
