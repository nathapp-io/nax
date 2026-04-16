/**
 * Context Engine v2 — CodeNeighborProvider
 *
 * Surfaces import-graph neighbors for files this story touches:
 *   - Forward deps:  files imported by the touched file (regex parse of import statements)
 *   - Reverse deps:  files that import the touched file (Bun.Glob scan, capped at 200 files)
 *   - Sibling test:  mirrored test file at test/unit/<relpath>.test.ts
 *
 * The combined result is collapsed into a single "neighbor" kind chunk.
 * Files are capped at MAX_FILES; neighbors per file capped at MAX_NEIGHBORS_PER_FILE.
 * Chunk is capped at MAX_CHUNK_TOKENS to avoid budget overrun.
 *
 * Phase 3.
 *
 * See: docs/specs/SPEC-context-engine-v2.md §CodeNeighborProvider
 */

import { createHash } from "node:crypto";
import { join, relative, resolve } from "node:path";
import type { ContextProviderResult, ContextRequest, IContextProvider, RawChunk } from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Maximum number of files to process */
const MAX_FILES = 10;

/** Maximum number of neighbors (forward + reverse combined) per file */
const MAX_NEIGHBORS_PER_FILE = 8;

/** Maximum files scanned during reverse-dep glob */
const MAX_GLOB_FILES = 200;

/** Token ceiling for the combined neighbor chunk */
const MAX_CHUNK_TOKENS = 500;

// ─────────────────────────────────────────────────────────────────────────────
// Injectable deps
// ─────────────────────────────────────────────────────────────────────────────

export const _codeNeighborDeps = {
  fileExists: (path: string): Promise<boolean> => Bun.file(path).exists(),
  readFile: (path: string): Promise<string> => Bun.file(path).text(),
  glob: (pattern: string, cwd: string): string[] => {
    const g = new Bun.Glob(pattern);
    const results: string[] = [];
    let count = 0;
    for (const file of g.scanSync({ cwd, absolute: false })) {
      if (count >= MAX_GLOB_FILES) break;
      results.push(file);
      count++;
    }
    return results;
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function contentHash8(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 8);
}

/** Patterns that match import/require statements — used with matchAll() */
const FROM_PATTERN = /from\s+['"]([^'"]+)['"]/g;
const REQUIRE_PATTERN = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const IMPORT_SIDE_EFFECT_PATTERN = /import\s+['"]([^'"]+)['"]/g;

/**
 * Parse import specifiers from file content.
 * Returns only relative paths (starts with ".") — ignores node_modules.
 */
function parseImportSpecifiers(content: string): string[] {
  const specifiers = new Set<string>();
  for (const match of content.matchAll(FROM_PATTERN)) {
    if (match[1]?.startsWith(".")) specifiers.add(match[1]);
  }
  for (const match of content.matchAll(REQUIRE_PATTERN)) {
    if (match[1]?.startsWith(".")) specifiers.add(match[1]);
  }
  for (const match of content.matchAll(IMPORT_SIDE_EFFECT_PATTERN)) {
    if (match[1]?.startsWith(".")) specifiers.add(match[1]);
  }
  return [...specifiers];
}

/**
 * Resolve a relative import specifier to a workdir-relative path.
 * Tries common TypeScript extensions. Returns null if outside workdir.
 */
function resolveImport(specifier: string, fromFile: string, workdir: string): string | null {
  const base = resolve(workdir, fromFile, "..", specifier);
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`];
  for (const candidate of candidates) {
    const rel = relative(workdir, candidate);
    if (!rel.startsWith("..")) return rel;
  }
  return null;
}

/**
 * Derive the sibling test file path for a source file.
 * src/foo/bar.ts → test/unit/foo/bar.test.ts
 */
function siblingTestPath(filePath: string): string | null {
  const srcMatch = filePath.match(/^src\/(.+)\.(ts|tsx)$/);
  if (!srcMatch) return null;
  return `test/unit/${srcMatch[1]}.test.ts`;
}

/**
 * Collect neighbors for a single file:
 * - forward deps (imports it makes)
 * - reverse deps (files that import it)
 * - sibling test file
 */
async function collectNeighbors(filePath: string, workdir: string): Promise<string[]> {
  const neighbors = new Set<string>();

  // Forward deps
  if (await _codeNeighborDeps.fileExists(join(workdir, filePath))) {
    const content = await _codeNeighborDeps.readFile(join(workdir, filePath));
    for (const spec of parseImportSpecifiers(content)) {
      const resolved = resolveImport(spec, filePath, workdir);
      if (resolved && resolved !== filePath) neighbors.add(resolved);
    }
  }

  // Reverse deps — scan src/ for files that import this file.
  // Quick check uses the base name (without extension) — broad but avoids parsing every file.
  const fileBaseName = (filePath.split("/").pop() ?? filePath).replace(/\.(ts|tsx)$/, "");
  const fileNoExt = filePath.replace(/\.(ts|tsx)$/, "");
  const srcFiles = _codeNeighborDeps.glob("src/**/*.{ts,tsx}", workdir);
  for (const srcFile of srcFiles) {
    if (srcFile === filePath || neighbors.size >= MAX_NEIGHBORS_PER_FILE) break;
    try {
      const content = await _codeNeighborDeps.readFile(join(workdir, srcFile));
      // Quick string check using base name before full parse
      if (content.includes(fileBaseName)) {
        for (const spec of parseImportSpecifiers(content)) {
          const resolved = resolveImport(spec, srcFile, workdir);
          if (resolved === filePath || resolved === fileNoExt) {
            neighbors.add(srcFile);
            break;
          }
        }
      }
    } catch {
      // Skip unreadable files
    }
  }

  // Sibling test
  const testPath = siblingTestPath(filePath);
  if (testPath) neighbors.add(testPath);

  return [...neighbors].slice(0, MAX_NEIGHBORS_PER_FILE);
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Surfaces import-graph neighbors for files touched by the story.
 * Returns a single combined chunk with kind "neighbor".
 */
export class CodeNeighborProvider implements IContextProvider {
  readonly id = "code-neighbor";
  readonly kind = "neighbor" as const;

  async fetch(request: ContextRequest): Promise<ContextProviderResult> {
    const { touchedFiles, workdir } = request;
    if (!touchedFiles || touchedFiles.length === 0) {
      return { chunks: [], pullTools: [] };
    }

    const filesToProcess = touchedFiles.slice(0, MAX_FILES);

    const sections: string[] = [];
    for (const file of filesToProcess) {
      const neighbors = await collectNeighbors(file, workdir);
      if (neighbors.length > 0) {
        sections.push(`### ${file}\n${neighbors.map((n) => `- ${n}`).join("\n")}`);
      }
    }

    if (sections.length === 0) {
      return { chunks: [], pullTools: [] };
    }

    const header = "## Code Neighbors\n\nRelated files (imports, reverse-deps, tests):";
    const rawContent = `${header}\n\n${sections.join("\n\n")}`;

    // Cap content to avoid overrunning token budget
    const maxChars = MAX_CHUNK_TOKENS * 4;
    const content = rawContent.length > maxChars ? rawContent.slice(0, maxChars) : rawContent;
    const tokens = Math.ceil(content.length / 4);

    const chunk: RawChunk = {
      id: `code-neighbor:${contentHash8(content)}`,
      kind: "neighbor",
      scope: "story",
      role: ["implementer", "tdd"],
      content,
      tokens,
      rawScore: 0.65,
    };

    return { chunks: [chunk], pullTools: [] };
  }
}
