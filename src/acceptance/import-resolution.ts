/**
 * Polyglot import resolution for acceptance fix-diagnosis.
 *
 * Best-effort source-context loader: parse the failing test's imports, map them
 * to candidate local source files, load what exists (capped). NOT a compiler —
 * every unresolvable/unreadable import degrades to a filtered-out null. Scope is
 * first-level LOCAL imports only; language-specific parsing is gated by
 * detected language per monorepo-awareness.md §B.
 */
import type { ProjectProfile } from "../config";
import { detectLanguage } from "../project";

export const MAX_SOURCE_FILES = 5;
export const MAX_FILE_LINES = 500;

export type ResolvedLanguage = "typescript" | "javascript" | "python" | "go" | "rust";

const SUPPORTED = new Set<string>(["typescript", "javascript", "python", "go", "rust"]);

const EXT_LANGUAGE = new Map<string, ProjectProfile["language"]>([
  [".ts", "typescript"],
  [".tsx", "typescript"],
  [".mts", "typescript"],
  [".cts", "typescript"],
  [".js", "javascript"],
  [".jsx", "javascript"],
  [".mjs", "javascript"],
  [".cjs", "javascript"],
  [".py", "python"],
  [".go", "go"],
  [".rs", "rust"],
]);

export function languageFromExtension(testFilePath: string | undefined): ProjectProfile["language"] | undefined {
  if (!testFilePath) return undefined;
  const dot = testFilePath.lastIndexOf(".");
  if (dot < 0) return undefined;
  return EXT_LANGUAGE.get(testFilePath.slice(dot).toLowerCase());
}

export async function resolveLanguage(opts: {
  testFilePath?: string;
  packageDir: string;
  language?: ProjectProfile["language"];
}): Promise<ResolvedLanguage> {
  const explicit = opts.language ?? languageFromExtension(opts.testFilePath);
  if (explicit && SUPPORTED.has(explicit)) return explicit as ResolvedLanguage;
  const detected = await detectLanguage(opts.packageDir);
  if (detected && SUPPORTED.has(detected)) return detected as ResolvedLanguage;
  return "typescript"; // historical default — preserves pre-polyglot behavior
}

export async function readCapped(
  relPath: string,
  packageDir: string,
): Promise<{ path: string; content: string } | null> {
  try {
    const text = await Bun.file(`${packageDir}/${relPath}`).text();
    const content = text.split("\n").slice(0, MAX_FILE_LINES).join("\n");
    return { path: relPath, content };
  } catch {
    return null;
  }
}

export interface ResolveSourceFilesOptions {
  testFileContent: string;
  packageDir: string;
  testFilePath?: string;
  language?: ProjectProfile["language"];
}

const TS_IMPORT_RE = /import\s+(?:{[^}]+}|[^;'"]+)\s+from\s+["']([^"']+)["']/g;
const TS_EXTS = [".ts", ".tsx", ".js", ".jsx"] as const;

export function parseTsImports(content: string): string[] {
  const specs: string[] = [];
  for (const m of content.matchAll(TS_IMPORT_RE)) {
    if (m[1].startsWith(".")) specs.push(m[1]);
  }
  return specs;
}

export function tsCandidates(spec: string): string[] {
  if (TS_EXTS.some((e) => spec.endsWith(e))) return [spec];
  const out: string[] = [];
  for (const e of TS_EXTS) out.push(`${spec}${e}`);
  for (const e of TS_EXTS) out.push(`${spec}/index${e}`);
  return out;
}

async function collectCandidates(lang: ResolvedLanguage, opts: ResolveSourceFilesOptions): Promise<string[]> {
  switch (lang) {
    case "typescript":
    case "javascript":
      return parseTsImports(opts.testFileContent).flatMap(tsCandidates);
    default:
      return [];
  }
}

async function readCandidates(
  candidates: string[],
  packageDir: string,
): Promise<Array<{ path: string; content: string }>> {
  const seen = new Set<string>();
  const results: Array<{ path: string; content: string }> = [];
  for (const rel of candidates) {
    if (results.length >= MAX_SOURCE_FILES) break;
    if (seen.has(rel)) continue;
    seen.add(rel);
    const file = await readCapped(rel, packageDir);
    if (file) results.push(file);
  }
  return results;
}

export async function resolveSourceFiles(
  opts: ResolveSourceFilesOptions,
): Promise<Array<{ path: string; content: string }>> {
  const lang = await resolveLanguage(opts);
  const candidates = await collectCandidates(lang, opts);
  return readCandidates(candidates, opts.packageDir);
}
