/**
 * Finish B §5.1: the generated acceptance tests a finding would touch. Pure except
 * `loadAcceptanceFiles`. Language-neutral: blocks are found by AC id only, never by
 * test-framework syntax. A file with no AC ids gives no blocks.
 */
import { basename, extname, join } from "node:path";
import type { Finding } from "./types";

export interface AcceptanceFile {
  path: string;
  text: string;
}
export interface AcBlock {
  acId: string;
  text: string;
}
export interface PinnedAc {
  path: string;
  acId: string;
  excerpt: string;
  score: number;
}

export const MAX_PINNED_BLOCKS = 5;
export const EXCERPT_LINES = 40;
const AC_ID = /\bAC-\d+\b/;
/** camelCase, PascalCase with an inner capital, snake_case, or dotted names: words a reviewer would quote as code. */
const CODE_WORD = /\b(?:[a-z]+[A-Z]\w*|[A-Z][a-z0-9]+[A-Z]\w*|[a-z0-9]+_[a-z0-9_]+|[A-Za-z_]\w*\.[A-Za-z_][\w.]*)\b/g;
const BACKTICK = /`([^`\n]+)`/g;
/** File base names too common to say anything about which AC a finding touches. */
const GENERIC_BASENAMES = new Set(["index", "types", "utils", "util", "main", "mod", "lib", "helpers", "constants"]);

export function splitAcBlocks(text: string): AcBlock[] {
  const lines = text.split("\n");
  const seen = new Set<string>();
  const anchors: { acId: string; at: number }[] = [];
  lines.forEach((line, at) => {
    const id = AC_ID.exec(line)?.[0];
    if (id && !seen.has(id)) {
      seen.add(id);
      anchors.push({ acId: id, at });
    }
  });
  return anchors.map((a, i) => ({
    acId: a.acId,
    text: lines.slice(a.at, anchors[i + 1]?.at ?? lines.length).join("\n"),
  }));
}

export function findingIdentifiers(f: Pick<Finding, "title" | "problem" | "file">): string[] {
  const ids = new Set<string>();
  for (const m of `${f.title}\n${f.problem}`.matchAll(BACKTICK)) if (m[1]) ids.add(m[1].trim());
  for (const m of f.title.matchAll(CODE_WORD)) ids.add(m[0]);
  if (f.file) {
    const base = basename(f.file, extname(f.file));
    if (!GENERIC_BASENAMES.has(base)) ids.add(base);
  }
  return [...ids].filter((s) => s.length >= 3);
}

export function findPinnedAcs(files: AcceptanceFile[], f: Pick<Finding, "title" | "problem" | "file">): PinnedAc[] {
  const ids = findingIdentifiers(f);
  if (ids.length === 0) return [];
  const scored = files.flatMap((file) =>
    splitAcBlocks(file.text).map((b) => ({
      path: file.path,
      acId: b.acId,
      excerpt: b.text.split("\n").slice(0, EXCERPT_LINES).join("\n"),
      score: ids.filter((id) => b.text.includes(id)).length,
    })),
  );
  return scored
    .filter((p) => p.score >= 1)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_PINNED_BLOCKS);
}

export const _acceptanceEvidenceDeps = {
  readText: (path: string): Promise<string | null> =>
    Bun.file(path)
      .text()
      .catch(() => null),
};

export async function loadAcceptanceFiles(workdir: string, paths: string[]): Promise<AcceptanceFile[]> {
  const texts = await Promise.all(paths.map((p) => _acceptanceEvidenceDeps.readText(join(workdir, p))));
  return paths.flatMap((path, i) => {
    const text = texts[i];
    return typeof text === "string" ? [{ path, text }] : [];
  });
}
